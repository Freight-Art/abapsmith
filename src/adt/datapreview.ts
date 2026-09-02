/**
 * DDIC data preview: reads rows from exactly one DDIC table or view over
 * `POST /sap/bc/adt/datapreview/ddic`. No free-form SQL surface, and no way
 * to add one — the endpoint takes a name, not a statement. The `freestyle`
 * sibling (takes an Open-SQL string; server-side guard was only a
 * leading-keyword test) stays private to `probeT000()` and is not wired up.
 *
 * Wire behavior captured on A4H 2026-08-11 — see
 * the git history:
 *   - `ddicEntityName` is concatenated into SQL server-side, so name
 *     validation is a correctness requirement, not defence in depth;
 *   - `rowNumber=N` returns **N+1** rows, so the count asked for is never
 *     the count to trust;
 *   - `rowNumber=0` means UNLIMITED, so `0` must be refused, not forwarded.
 */
import { XMLParser } from "fast-xml-parser";
import { type AbapConnection, isAbapTrue } from "./connection.js";
import { AbapError } from "./errors.js";
import { type ErrorContext, translateAdtError } from "./session.js";

// ------------------------------------------------------------------ names ---

/**
 * Plain DDIC name. 30 characters is the DDIC ceiling; the first character is a
 * letter because a table cannot start with a digit or an underscore.
 */
const PLAIN_NAME_RE = /^[A-Z][A-Z0-9_]{0,29}$/;
/**
 * Customer/partner namespace, e.g. `/ACME/TAB`. Second segment capped at 30,
 * not 20 — a 20-cap refused the real SAP-shipped `/BOFU/CV_BPRELSHPCONTACTPERSON`
 * client-side (see archive). This is only the per-segment bound;
 * `MAX_ENTITY_NAME_LENGTH` below holds the actual DDIC ceiling, since
 * `/AAAAAAAAAA/` + 30 would otherwise be 42 characters.
 */
const NAMESPACED_NAME_RE = /^\/[A-Z0-9_]{1,10}\/[A-Z0-9_]{1,30}$/;

/**
 * DDIC name ceiling on this release. Applied to the whole string, namespace
 * included, so widening a segment cannot widen the name.
 */
const MAX_ENTITY_NAME_LENGTH = 30;

/**
 * Accepted table/view name. Anchored; rejects spaces, quotes, `=`, `;` and
 * anything else that could reach the server-side SQL — an allow-list of two
 * shapes, not a deny-list, because a captured injection (see archive) needed
 * nothing more exotic than a space, and anchoring is what stops an unanchored
 * pattern matching just the valid prefix of such a string.
 *
 * Expects an already-normalised (upper-case, trimmed) name; an untrimmed
 * trailing space is rejected on purpose.
 *
 * Length is checked FIRST, against the whole string, independent of either
 * pattern's own repetition count — that separation is what let the
 * namespaced segment widen from 20 to 30 without also admitting a
 * 42-character name.
 */
export function isValidDdicEntityName(name: string): boolean {
  if (name.length > MAX_ENTITY_NAME_LENGTH) return false;
  return PLAIN_NAME_RE.test(name) || NAMESPACED_NAME_RE.test(name);
}

/**
 * `toUpperCase`, never `toLocaleUpperCase`: under a Turkish locale the latter
 * maps `i` to `İ`, which matches neither pattern above and would make the tool
 * fail on lower-case names for some operators and not others.
 */
function normaliseEntityName(name: unknown): string {
  return String(name ?? "")
    .trim()
    .toUpperCase();
}

// ----------------------------------------------------------------- shapes ---

export interface PreviewColumn {
  name: string;
  /** ABAP type kind as the server reports it, e.g. "C", "N", "D", "T". */
  type: string;
  length?: number;
  description?: string;
  key: boolean;
}

/**
 * One `<dataPreview:message>` element: the endpoint's in-band channel for
 * saying "I did not do what you asked" while still answering HTTP 200.
 */
export interface PreviewMessage {
  /** The server's own wording, passed through unedited. */
  text: string;
  /**
   * As reported, unmapped. Only `"I"` has been CAPTURED from this endpoint;
   * any other value (including `""`) is carried through rather than being
   * interpreted, because no other value has been observed to interpret.
   */
  severity: string;
}

export interface PreviewResult {
  /** Normalised (upper case) — the name actually sent, not the one passed in. */
  table: string;
  columns: PreviewColumn[];
  /** Row-major, aligned to `columns`, never sparse: empty cells are `""`. */
  rows: string[][];
  rowsRequested: number;
  /** True when the server returned more rows than we asked for. */
  moreRowsExist: boolean;
  /**
   * In-band messages, in wire order. Empty for an ordinary read. A non-empty
   * list means `rows` cannot be read as "what the entity contains" — see
   * `parsePreviewBody`.
   */
  messages: PreviewMessage[];
}

// ----------------------------------------------------------------- parsing ---

/**
 * Option set proven correct against captured bytes (see archive):
 *   - `parseTagValue: false` — else MANDT `["000","001"]` becomes `[0,1]`,
 *     silently corrupting every CHAR/NUMC key with leading zeros.
 *   - `isArray` — `fast-xml-parser` collapses one-element arrays, so a
 *     one-column result would make `columns` an object and a one-row result
 *     would make `dataSet.data` a bare string; both are ordinary results.
 *   - `trimValues: true` turns a self-closing empty `<dataPreview:data/>`
 *     into `""` rather than dropping it, keeping column arrays aligned for
 *     assembly-by-index.
 */
const previewXml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (_name, jpath) =>
    jpath === "tableData.columns" ||
    jpath === "tableData.columns.dataSet.data" ||
    jpath === "tableData.message",
});

/** One `<dataPreview:columns>` element after namespace stripping. */
interface RawColumn {
  metadata?: Record<string, unknown>;
  /** A fully empty `<dataSet/>` parses to the string `""`, so `.data` is gone. */
  dataSet?: { data?: unknown[] } | string;
}

const attrString = (meta: Record<string, unknown> | undefined, key: string): string | undefined => {
  const v = meta?.[`@_${key}`];
  return typeof v === "string" && v !== "" ? v : undefined;
};

/**
 * Column-major → row-major, plus any in-band `<dataPreview:message>`.
 *
 * The payload carries one `<dataPreview:columns>` per column, each holding
 * its whole column of values in row order. Assembly is by index only — there
 * is no row identifier on the wire to join on.
 *
 * The message channel is not decoration: a CDS view with parameters replies
 * HTTP 200, zero rows, zero columns, and an in-band "not supported" message —
 * structurally indistinguishable from a genuinely empty table (see archive).
 * Parsing the message is the only way to tell the two apart, so callers are
 * required to state it.
 */
export function parsePreviewBody(body: string): {
  columns: PreviewColumn[];
  rows: string[][];
  messages: PreviewMessage[];
} {
  const doc = previewXml.parse(body) as Record<string, unknown>;
  const table = (doc.tableData ?? {}) as Record<string, unknown>;
  const raw: RawColumn[] = Array.isArray(table.columns) ? (table.columns as RawColumn[]) : [];

  // `removeNSPrefix` maps wire `dataPreview:text` to `@_text`. Every message
  // is kept in wire order; one with neither attribute carries nothing and is
  // dropped.
  const messages: PreviewMessage[] = [];
  for (const m of Array.isArray(table.message) ? table.message : []) {
    const meta = m as Record<string, unknown> | undefined;
    const text = attrString(meta, "text");
    const severity = attrString(meta, "severity");
    if (text === undefined && severity === undefined) continue;
    messages.push({ text: text ?? "", severity: severity ?? "" });
  }

  const columns: PreviewColumn[] = [];
  const values: string[][] = [];

  for (const col of raw) {
    const meta = col.metadata as Record<string, unknown> | undefined;
    const name = attrString(meta, "name") ?? "";
    const length = attrString(meta, "length");
    const description = attrString(meta, "description");
    const parsedLength = length === undefined ? Number.NaN : Number.parseInt(length, 10);
    columns.push({
      name,
      type: attrString(meta, "type") ?? "",
      ...(Number.isFinite(parsedLength) ? { length: parsedLength } : {}),
      ...(description === undefined ? {} : { description }),
      key: isAbapTrue(attrString(meta, "keyAttribute")),
    });
    const ds = col.dataSet;
    const cells = typeof ds === "object" && ds !== null && Array.isArray(ds.data) ? ds.data : [];
    values.push(cells.map((c) => (c === undefined || c === null ? "" : String(c))));
  }

  // Columns of a well-formed response are all the same length; taking the max
  // rather than the first means a short column pads with "" instead of
  // truncating every other column's data to match it.
  const rowCount = values.reduce((n, v) => Math.max(n, v.length), 0);
  const rows: string[][] = [];
  for (let r = 0; r < rowCount; r++) {
    rows.push(values.map((v) => v[r] ?? ""));
  }
  return { columns, rows, messages };
}

// ---------------------------------------------------------------- failures ---

/**
 * Follows `classifySourceFailure` (`source.ts:52`) / `classifyDdicFailure`
 * (`ddic.ts:459`): delegates to `translateAdtError`, then refines only what
 * it funnels into generic `ADT_ERROR`.
 *   - 401/403 → `AUTH_FAILED` (missing `S_TABU_DIS`/`S_TABU_NAM`; retrying
 *     with a different name is wrong).
 *   - 400 naming an unknown entity → `NOT_FOUND`, since this endpoint answers
 *     a missing table with 400 + `<exc:exception>`, not 404.
 * A 400 *not* about a missing table keeps `ADT_ERROR` on purpose — see
 * archive for the captured "Boolean expression" case this must not mask.
 */
export function classifyPreviewFailure(e: unknown, ctx: ErrorContext): AbapError {
  const err = translateAdtError(e, ctx);
  if (err.code !== "ADT_ERROR") return err;

  const status = typeof err.details.status === "number" ? err.details.status : undefined;
  const target = ctx.name ?? ctx.uri ?? "the entity";

  if (status === 401 || status === 403) {
    return new AbapError(
      "AUTH_FAILED",
      `Not authorised (HTTP ${status}) to read data from ${target}. ` +
        `The logon succeeded; the user lacks table-display authorisation for it.`,
      { ...err.details, status },
      "The user is authenticated but not authorised (typically S_TABU_DIS / S_TABU_NAM). " +
        "The name is not in question — do not retry with a different name.",
    );
  }
  if (status === 400 && /not found|does not exist|unknown|not exist/i.test(err.message)) {
    return new AbapError(
      "NOT_FOUND",
      `No DDIC table or view named ${target} exists on this system.`,
      { ...err.details, status },
      "Check the spelling, or look the object up first — this endpoint reports a " +
        "missing entity as HTTP 400, not 404.",
    );
  }
  return err;
}

// ----------------------------------------------------------------- preview ---

/**
 * Preview up to `maxRows` rows of one DDIC table or view.
 *
 * Validation happens before any request is issued — an invalid name must cost
 * zero HTTP calls, because the name is the injection surface and a
 * rejected one has nothing safe to send.
 */
export async function previewDdicEntity(
  conn: AbapConnection,
  input: { table: string; maxRows: number },
): Promise<PreviewResult> {
  const table = normaliseEntityName(input.table);
  if (!isValidDdicEntityName(table)) {
    throw new AbapError(
      "BAD_INPUT",
      `'${String(input.table)}' is not a valid DDIC table or view name.`,
      { table: String(input.table) },
      "Pass a bare name such as T000, DD02L or /ACME/TAB. This tool previews one " +
        "named entity — it has no WHERE clause and accepts no SQL.",
    );
  }

  const { maxRows } = input;
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    // Not a re-default (P-32): 0 is refused, never quietly turned into 100.
    // On this endpoint 0 means UNLIMITED, so re-defaulting and forwarding are
    // both wrong, in opposite directions.
    throw new AbapError(
      "BAD_INPUT",
      `max_rows must be a positive integer, got ${String(maxRows)}.`,
      { maxRows },
      "Ask for at least one row. 0 is not 'no rows' on this endpoint — it means " +
        "unlimited, and is refused rather than sent.",
    );
  }

  const ctx: ErrorContext = { operation: "read", name: table, type: "TABL/DT" };
  let body: string;
  try {
    // Sends `rowNumber = maxRows`; the server answers with up to maxRows + 1.
    const resp = await conn.dataPreviewDdic(table, maxRows);
    body = resp.body;
  } catch (e) {
    throw classifyPreviewFailure(e, ctx);
  }

  const { columns, rows, messages } = parsePreviewBody(body);
  // N+1 rows back means "more exist" — the server's own signal (see file
  // header). Operates on parsed rows; no request parameter can defeat it.
  const moreRowsExist = rows.length > maxRows;

  // In-band messages are REPORTED, never THROWN — even at severity "E": the
  // HTTP-200 response may carry real rows alongside the message, only "I" has
  // ever been captured (don't invent semantics for "E"), and passing the
  // server's own text through is what fixes the false "genuinely empty
  // result" claim — no exception is needed for that. See archive.
  return {
    table,
    columns,
    rows: moreRowsExist ? rows.slice(0, maxRows) : rows,
    rowsRequested: maxRows,
    moreRowsExist,
    messages,
  };
}
