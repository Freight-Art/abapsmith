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
 * No free-form SQL parameter exists here or beneath this file.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AbapError } from "../adt/errors.js";
import { previewDdicEntity, type PreviewResult } from "../adt/datapreview.js";
import { buildResponse, textTable, type BuiltResponse } from "../compact.js";
import { truncateForDisplay } from "../truncate.js";
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import type { SafetyGate } from "../safety.js";

/** Per-cell display width; `truncateForDisplay` marks cuts with `…` (`src/truncate.ts`). */
const CELL_DISPLAY_WIDTH = 60;

// ------------------------------------------------------------------ schema ---

/**
 * `object` is a bare alias for `table` (handler picks whichever is set,
 * `table` wins). No third field — this tool has nowhere to put a WHERE.
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
    notes.push(
      `INCOMPLETE: ${result.table} holds more rows than the ${result.rowsRequested} shown. This is ` +
        "the first N rows in the table's own order, NOT a sample and NOT the whole table — do not " +
        "conclude anything about rows you have not seen. There is no paging parameter and no WHERE " +
        "clause on this tool; raise max_rows (up to the ceiling) or narrow the question another way.",
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
      result.messages.length === 0
        ? `EMPTY: ${result.table} exists and was read successfully, but returned no rows. That is a ` +
            "genuinely empty result, not a failure and not a truncation."
        : // Replaces a bug where a parameterised CDS view's 200/0-col/0-row/"I" response was misread as a genuine empty table.
          `NOT READ: ${result.table} returned no rows, but that is NOT evidence it is empty. The ` +
            "server refused or curtailed the read in-band and said so in the message above. Do NOT " +
            `conclude anything about the contents of ${result.table} from this response.`,
    );
  }

  return buildResponse({
    header: {
      table: result.table,
      columns: result.columns.length,
      rows_shown: result.rows.length,
      rows_requested: result.rowsRequested,
      more_rows_exist: result.moreRowsExist,
    },
    sections: result.columns.length ? [{ title: "COLUMNS (* = key)", content: columnSummary(result) }] : [],
    body: rows.length ? textTable(rows, keys) : "(no rows)",
    bodyLabel: "ROWS",
    notes,
    maxChars,
  });
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
        "CDS view — not every DDIC entity kind qualifies. No WHERE/JOIN/aggregate; a name, not " +
        `a statement. Rows clamped to the ceiling (currently ${ceiling}). Deny-listed tables ` +
        "and non-provably-nonproductive systems are refused.",
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

        const result = await deps.pool.withRead("abap_data_preview", (conn) =>
          previewDdicEntity(conn, { table, maxRows: effective }),
        );

        const res = renderPreview(result, requested, deps.cfg.maxResponseChars);

        // Audit which table/how many rows — never the row values.
        audit(
          `[abapsmith] audit: abap_data_preview table=${result.table} rows=${result.rows.length} ` +
            `requested=${requested} effective=${effective} more_rows_exist=${result.moreRowsExist}`,
        );

        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
