/**
 * `abap_data_preview` — DDIC table/view row preview, over `previewDdicEntity`
 * (`src/adt/datapreview.ts`). Three controls gate access; only the middle one
 * lives here: (1) off by default — absent from `tools/list` unless
 * `toolCapabilities.canPreviewData` (`src/server.ts`); (2) the row ceiling
 * below, plus the parsed-row slice in `previewDdicEntity`; (3)
 * `safety.assertDataPreview`, called before the read so a denied table name
 * never reaches the appliance — verified live; see
 * the git history.
 *
 * No free-form SQL parameter exists in the tool's arguments — a caller can
 * only name fields, operators and typed values. A structured filter
 * (`where`/`columns`/`order_by`/`distinct`) IS compiled into a SELECT
 * beneath this file, by `src/adt/datapreview-filter.ts`; that module, not
 * this one, is what has to keep the compiled SQL server-side-safe.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AbapError } from "../adt/errors.js";
import { previewDdicEntity, type PreviewColumn, type PreviewResult } from "../adt/datapreview.js";
import { PREVIEW_OPS, isEmptyFilter, type PreviewFilter } from "../adt/datapreview-filter.js";
import { buildResponse, textTable, type BuiltResponse } from "../compact.js";
import { truncateForDisplay } from "../truncate.js";
import {
  renderAbapValue,
  renderTestDouble,
  type FixtureRenderInput,
  type PreviewFormat,
} from "./preview-fixture.js";
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import type { SafetyGate } from "../safety.js";

/** Per-cell display width; `truncateForDisplay` marks cuts with `…` (`src/truncate.ts`). */
const CELL_DISPLAY_WIDTH = 60;

// ------------------------------------------------------------------ schema ---

/**
 * `object` is a bare alias for `table` (handler picks whichever is set,
 * `table` wins). There is still no free-SQL field: `where`/`columns`/
 * `order_by`/`distinct` are a STRUCTURED filter, checked and compiled into a
 * SELECT server-side-safe by `src/adt/datapreview-filter.ts` — a caller
 * never supplies or influences raw SQL text.
 *
 * `max_rows` is `.int()` but deliberately not `.positive()`: refusing `0` has
 * to be handler code (see P-32 below), not an unreachable zod branch — `0`
 * means UNLIMITED on this endpoint, not "malformed call."
 */
export const dataPreviewInputSchema = {
  table: z
    .string()
    .optional()
    .describe(
      'DDIC entity name, e.g. "T000" or "/ACME/TAB". One of table/object is required; ' +
        "a bare identifier only, not a query.",
    ),
  object: z.string().optional().describe("Alias for table; table wins if both are given."),
  max_rows: z
    .number()
    .int()
    .optional()
    .describe(
      "Rows to return, clamped to the server's ceiling (clamp reported in the response). " +
        'At least 1 — 0 is refused, never read as "default".',
    ),
  where: z
    .array(
      z.object({
        field: z
          .string()
          .describe("DDIC field name, checked against the entity's own column list before anything is sent."),
        op: z
          .enum(PREVIEW_OPS)
          .describe(
            "Comparison operator: eq/ne/lt/le/gt/ge compare one typed value; like matches an SQL " +
              "pattern (% = any run, _ = one character, # = escape character); in matches any of an " +
              "array of values; is_null takes no value at all.",
          ),
        value: z
          .union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))])
          .optional()
          .describe(
            "Required for every op except is_null (which must omit it); an array only for op=in. " +
              "Always rendered as a typed literal for the field's DDIC type — never concatenated as text.",
          ),
      }),
    )
    .optional()
    .describe(
      "Structured filter conditions, ANDed together (no OR, no free text). This does not widen what " +
        "the technical user may read — the same S_TABU_* authorisations still apply to every row.",
    ),
  columns: z
    .array(z.string())
    .optional()
    .describe("Project only these DDIC fields, in this order, instead of every column on the entity."),
  order_by: z
    .array(
      z.object({
        field: z.string().describe("DDIC field name to sort by."),
        direction: z
          .enum(["asc", "desc"])
          .optional()
          .describe('Sort direction; defaults to "asc" when omitted.'),
      }),
    )
    .optional()
    .describe(
      "Sort order, applied in array order (first field is the primary sort key). Required for " +
        "keyset paging: order on a key and add a `gt`/`lt` where-condition on the last value seen.",
    ),
  distinct: z
    .boolean()
    .optional()
    .describe(
      "Suppress duplicate rows. Requires every order_by field to also appear in columns — " +
        "otherwise the sort key would not be part of what distinctness is computed over.",
    ),
  format: z
    .enum(["table", "abap_value", "test_double"])
    .optional()
    .describe(
      "How to render the rows. table (default): the usual text table. abap_value: the rows as one " +
        "typed VALUE #( ... ) literal for the entity's line type. test_double: that literal wrapped " +
        "in a ready-to-paste cl_osql_test_environment fixture. Same deny-list, same flag, same row " +
        "ceiling in every case — the format is applied after the read, never around the check.",
    ),
  mask: z
    .array(z.string())
    .optional()
    .describe(
      "Field names to blank in the OUTPUT only, applied at render time after the read. " +
        "Character-like fields become 'MASKED'; other types become their initial value. The " +
        "response lists which fields were masked.",
    ),
};

export const DataPreviewInput = z.object(dataPreviewInputSchema);
export type DataPreviewInput = z.infer<typeof DataPreviewInput>;

export interface DataPreviewToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars" | "dataPreviewMaxRows">;
  /** Audit sink. Defaults to stderr, matching `deps.warn` in `tools/transport.ts`. */
  readonly log?: (message: string) => void;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

// ----------------------------------------------------------------- rendering ---

/** Dedupes column names for `textTable` (keyed by name) so same-named or unnamed columns don't collapse and drop data. */
function uniqueColumnKeys(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw, i) => {
    const base = raw === "" ? `col${i + 1}` : raw;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n + 1}`;
  });
}

/** One compact line of DDIC metadata: `MANDT:C(3)* NAME:C(30)` — `*` marks a key. */
function columnSummary(result: PreviewResult): string {
  return result.columns
    .map(
      (c) =>
        `${c.name || "?"}:${c.type || "?"}` +
        (c.length === undefined ? "" : `(${c.length})`) +
        (c.key ? "*" : ""),
    )
    .join(" ");
}

/**
 * Every disclosure `renderPreview` (and, since issue #115, the fixture
 * formats) attach to a read: clamp, "more rows exist", in-band server
 * messages, and what an empty `rows` array does and doesn't mean. Extracted
 * out of `renderPreview` so `format: abap_value`/`test_double` can reuse the
 * exact same notes instead of re-deriving a copy that could drift.
 */
function previewNotes(result: PreviewResult, requested: number): string[] {
  const filtered = result.statement !== undefined;
  const notes: string[] = [];
  if (result.rowsRequested < requested) {
    notes.push(
      `CLAMPED: max_rows:${requested} exceeds this server's ${result.rowsRequested}-row ceiling ` +
        `(ABAP_DATA_PREVIEW_MAX_ROWS), so only ${result.rowsRequested} row(s) were requested from ` +
        `${result.table}. The rows beyond that were NOT fetched and are NOT shown. The ceiling is ` +
        "an operator setting — no argument raises it.",
    );
  }
  if (result.moreRowsExist) {
    const trueCount =
      result.totalRows !== undefined && result.totalRows > result.rows.length
        ? ` The server reports ${result.totalRows} row(s) actually match — a firmer count than ` +
          '"more exist."'
        : "";
    notes.push(
      `INCOMPLETE: ${result.table} holds more rows than the ${result.rowsRequested} shown.${trueCount} ` +
        "This is the first N rows in the table's own order, NOT a sample and NOT the whole table — " +
        "do not conclude anything about rows you have not seen. There is no offset/paging parameter, " +
        "but you can narrow with `where`, project with `columns`, raise max_rows (up to the ceiling), " +
        "or page by ordering on a key with `order_by` and adding a `gt` `where` condition on the last " +
        "value you saw.",
    );
  }
  // Server's own words go first — the row count below is what a message can invalidate.
  for (const m of result.messages) {
    const label =
      m.severity === "E" ? "SERVER ERROR" : m.severity === "W" ? "SERVER WARNING" : "SERVER NOTICE";
    // Does not assert the read failed (a message can arrive alongside real rows) — states what the server said, nothing more.
    notes.push(
      `${label}: the endpoint answered HTTP 200 and attached a message to this read of ` +
        `${result.table}. Verbatim: "${m.text}" (severity ${m.severity || "unstated"}). That is the ` +
        "server's own account of what it did, and it governs how anything below is to be read.",
    );
  }

  if (result.rows.length === 0) {
    notes.push(
      result.messages.length !== 0
        ? // Replaces a bug where a parameterised CDS view's 200/0-col/0-row/"I" response was misread as a genuine empty table.
          `NOT READ: ${result.table} returned no rows, but that is NOT evidence it is empty. The ` +
            "server refused or curtailed the read in-band and said so in the message above. Do NOT " +
            `conclude anything about the contents of ${result.table} from this response.`
        : filtered
          ? `EMPTY: no row in ${result.table} matched the where filter. That is NOT evidence ` +
            `${result.table} itself is empty — only that nothing satisfied the condition(s). The ` +
            "rendered statement is in STATEMENT above."
          : `EMPTY: ${result.table} exists and was read successfully, but returned no rows. That is a ` +
            "genuinely empty result, not a failure and not a truncation.",
    );
  }
  return notes;
}

/** COLUMNS/STATEMENT prologue sections, shared by every `format`. */
function previewSections(result: PreviewResult): Array<{ title: string; content: string }> {
  const sections: Array<{ title: string; content: string }> = [];
  if (result.columns.length) {
    sections.push({ title: "COLUMNS (* = key)", content: columnSummary(result) });
  }
  if (result.statement !== undefined) {
    const statementLines = [`sent: ${result.statement}`];
    if (result.executedQueryString !== undefined) {
      statementLines.push(`server compiled: ${result.executedQueryString}`);
    }
    sections.push({ title: "STATEMENT", content: statementLines.join("\n") });
  }
  return sections;
}

/**
 * Renders a preview; every omission (clamp, "more rows exist", char-budget
 * cuts) is stated in the output. Never add a `.slice` here —
 * `test/no-silent-truncation.test.ts` fails hand-rolled caps by design.
 */
export function renderPreview(
  result: PreviewResult,
  requested: number,
  maxChars: number,
): BuiltResponse {
  const keys = uniqueColumnKeys(result.columns.map((c) => c.name));
  const rows = result.rows.map((cells) => {
    const rec: Record<string, string> = {};
    keys.forEach((k, i) => {
      rec[k] = truncateForDisplay(cells[i] ?? "", CELL_DISPLAY_WIDTH);
    });
    return rec;
  });

  const filtered = result.statement !== undefined;

  return buildResponse({
    header: {
      table: result.table,
      columns: result.columns.length,
      rows_shown: result.rows.length,
      rows_requested: result.rowsRequested,
      more_rows_exist: result.moreRowsExist,
      filtered,
      total_rows: result.totalRows,
    },
    sections: previewSections(result),
    body: rows.length ? textTable(rows, keys) : "(no rows)",
    bodyLabel: "ROWS",
    notes: previewNotes(result, requested),
    maxChars,
  });
}

/**
 * Renders a preview as an ABAP fixture (`format: abap_value`/`test_double`,
 * issue #115) instead of a text table. Reuses `previewNotes`/
 * `previewSections` so the disclosures a caller gets about clamping,
 * incompleteness and in-band server messages are IDENTICAL to `format:
 * table` — only the body and its own fixture-specific notes differ.
 */
function renderFixture(
  result: PreviewResult,
  requested: number,
  maxChars: number,
  format: Exclude<PreviewFormat, "table">,
  maskedUpper: readonly string[],
  columnOrder: readonly string[] | undefined,
): BuiltResponse {
  const fixtureInput: FixtureRenderInput = {
    result,
    maskedFields: maskedUpper,
    columnOrder,
  };
  const render =
    format === "abap_value" ? renderAbapValue(fixtureInput) : renderTestDouble(fixtureInput);

  return buildResponse({
    header: {
      table: result.table,
      columns: result.columns.length,
      rows_shown: result.rows.length,
      rows_requested: result.rowsRequested,
      more_rows_exist: result.moreRowsExist,
      filtered: result.statement !== undefined,
      total_rows: result.totalRows,
      format,
      masked: maskedUpper.length ? maskedUpper.join(",") : undefined,
    },
    sections: previewSections(result),
    body: render.text,
    bodyLabel: format === "abap_value" ? "ABAP_VALUE" : "TEST_DOUBLE",
    notes: [...previewNotes(result, requested), ...render.notes],
    maxChars,
  });
}

/** Normalises a `mask` argument: trim, upper-case, drop empties, dedupe. Order of first occurrence is kept — it only ever feeds a header list and a lookup set, not the rendered field order. */
function normaliseMask(mask: readonly string[] | undefined): string[] {
  if (mask === undefined) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of mask) {
    const name = raw.trim().toUpperCase();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// -------------------------------------------------------------- registration ---

/** Registers `abap_data_preview`. The caller decides whether this runs at all — see module header. */
export function registerDataPreviewTools(mcp: McpServer, deps: DataPreviewToolDeps): void {
  const audit = deps.log ?? ((m: string) => void process.stderr.write(m + "\n"));
  const ceiling = deps.cfg.dataPreviewMaxRows;

  mcp.registerTool(
    "abap_data_preview",
    {
      title: "Preview DDIC table data",
      description:
        "Read rows from ONE DDIC entity: a table, database/projection view, or parameterless " +
        "CDS view — not every DDIC entity kind qualifies. A name plus an optional structured " +
        "filter (where/columns/order_by/distinct) — still no JOIN, no aggregate, and no SQL " +
        `text. Rows clamped to the ceiling (currently ${ceiling}). Deny-listed tables ` +
        "and non-provably-nonproductive systems are refused. format: abap_value / test_double " +
        "turn the rows into a paste-ready ABAP fixture under the same policy.",
      inputSchema: dataPreviewInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const a = args as DataPreviewInput;
        // `table` wins when both are given.
        const table = (a.table ?? a.object ?? "").trim();
        if (table === "") {
          throw new AbapError(
            "BAD_INPUT",
            "table (or object) is required.",
            {},
            'Pass the DDIC entity name, e.g. { "table": "T000" } or { "object": "T000" }.',
          );
        }

        // 1. Connect first: the T000 role-probe verdict is only on the safety
        //    gate after `ensureConnected` runs (`safety.ts`, `server.ts`).
        await deps.ensureConnected();

        // 2. Gate BEFORE the read — a denied table costs zero READ requests.
        deps.safety.assertDataPreview(table);

        // 3. P-32: never `??`/`||` a default onto max_rows — 0 means UNLIMITED
        //    on this endpoint (not "use the default"), so it must be refused
        //    explicitly rather than silently re-defaulted or forwarded. See
        //    the git history.
        const requested = a.max_rows === undefined ? ceiling : a.max_rows;
        if (!Number.isInteger(requested) || requested < 1) {
          throw new AbapError(
            "BAD_INPUT",
            `max_rows must be a whole number of at least 1, got ${String(a.max_rows)}.`,
            { table, max_rows: a.max_rows },
            `Ask for 1..${ceiling} rows, or omit max_rows for ${ceiling}. 0 is not "no rows" on ` +
              "this endpoint — it means unlimited, so it is refused rather than sent.",
          );
        }
        const effective = Math.min(requested, ceiling);

        const filter: PreviewFilter = {
          ...(a.where === undefined ? {} : { where: a.where }),
          ...(a.columns === undefined ? {} : { columns: a.columns }),
          ...(a.order_by === undefined ? {} : { orderBy: a.order_by }),
          ...(a.distinct === undefined ? {} : { distinct: a.distinct }),
        };

        // Pass `filter` only when it is non-empty: with no filter parameters
        // at all, this call must stay byte-identical to the pre-#73 shape
        // (`{ table, maxRows }`, no `filter` key), so the unfiltered path is
        // unchanged at the call site too, not just inside `previewDdicEntity`.
        const result = await deps.pool.withRead("abap_data_preview", (conn) =>
          previewDdicEntity(conn, {
            table,
            maxRows: effective,
            ...(isEmptyFilter(filter) ? {} : { filter }),
          }),
        );

        // 5. Render. `format` is applied HERE, after step 2's deny-list check
        //    and step 4's read — never a separate path around either. Every
        //    format renders the SAME fetched rows; it only changes how they
        //    are displayed (issue #115).
        const requestedFormat: PreviewFormat = a.format ?? "table";
        let res: BuiltResponse;
        let maskedUpper: readonly string[] = [];
        if (requestedFormat === "table") {
          res = renderPreview(result, requested, deps.cfg.maxResponseChars);
        } else {
          maskedUpper = normaliseMask(a.mask);
          // A mask naming a field that isn't actually on the entity would be
          // silently ignored — that reads as "this field is hidden" when it
          // never appeared at all, which is a data-exposure risk, not a
          // convenience to shrug off.
          const knownColumns: PreviewColumn[] = result.columns;
          const knownUpper = new Set(knownColumns.map((c) => c.name.toUpperCase()));
          const unknown = maskedUpper.filter((name) => !knownUpper.has(name));
          if (unknown.length) {
            throw new AbapError(
              "BAD_INPUT",
              `mask names field(s) not present on ${result.table}: ${unknown.join(", ")}.`,
              { table: result.table, mask: unknown, columns: knownColumns.map((c) => c.name) },
              `Known columns: ${knownColumns.map((c) => c.name).join(", ") || "(none)"}. A mask ` +
                "field must match a real column, or it would be silently ignored.",
            );
          }
          res = renderFixture(
            result,
            requested,
            deps.cfg.maxResponseChars,
            requestedFormat,
            maskedUpper,
            a.columns,
          );
        }

        // Audit which table/how many rows, whether a filter was applied, the
        // chosen format and how many fields were masked — never the field
        // names, operators or values inside the filter, never a masked
        // field's name, and never row contents.
        audit(
          `[abapsmith] audit: abap_data_preview table=${result.table} rows=${result.rows.length} ` +
            `requested=${requested} effective=${effective} more_rows_exist=${result.moreRowsExist} ` +
            `filtered=${result.statement !== undefined}` +
            (result.totalRows === undefined ? "" : ` total_rows=${result.totalRows}`) +
            ` format=${requestedFormat} masked=${maskedUpper.length}`,
        );

        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
