/**
 * DDIC data preview: reads rows from exactly one DDIC table or view over
 * `POST /sap/bc/adt/datapreview/ddic`. The `ddic` endpoint itself still only
 * takes a name, not a statement — there is nowhere to smuggle a WHERE/JOIN
 * into that request. What changed for issue #73 is the tool built on top of
 * it: `previewDdicEntity` now accepts a STRUCTURED filter
 * (`where`/`columns`/`order_by`/`distinct`, see `./datapreview-filter.js`'s
 * `PreviewFilter`), and when one is given, compiles it HERE into an Open SQL
 * `SELECT` sent to the `freestyle` sibling
 * (`AbapConnection.dataPreviewFreestyle()`, `connection.ts`) — never a raw
 * SQL string from a caller. Every identifier in that SELECT comes from the
 * server's own column metadata (a preceding metadata probe against the same
 * `ddic` endpoint); every value is rendered as a typed, quoted literal by
 * `./datapreview-filter.js`. `img-query.ts` is the other module-assembled
 * caller of `dataPreviewFreestyle()`; `probeT000()` (`system-role.ts`) keeps
 * its own separate, no-retry route to the same URL.
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
import { isEmptyFilter, assertFilterShape, renderPreviewSelect, type PreviewFilter } from "./datapreview-filter.js";

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
  /**
   * The Open SQL `SELECT` abapsmith rendered and sent to the `freestyle`
   * endpoint (`./datapreview-filter.js`'s `renderPreviewSelect`). Present
   * only on a filtered read — an unfiltered read goes through the plain
   * `ddic` endpoint, which takes a name, not a statement, so there is
   * nothing to report here.
   */
  statement?: string;
  /**
   * `<dataPreview:executedQueryString>` — the server's own echo of what it
   * actually compiled, when the response carried one. This is independent
   * confirmation of `statement`, not a copy of it: a mismatch would mean the
   * server rewrote or reinterpreted the sent SQL. See `parsePreviewBody`.
   */
  executedQueryString?: string;
  /**
   * True row count matching the filter, from `<dataPreview:totalRows>`.
   * Meaningful only on the filtered (`freestyle`) path — on the plain
   * `ddic` path this is always 0 even when rows come back (see
   * `parsePreviewBody`'s own JSDoc), so it is only ever set here when the
   * read went through the filtered path.
   */
  totalRows?: number;
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
  /**
   * `<dataPreview:totalRows>`, parsed as a plain integer. On the `ddic`
   * endpoint this is always 0 even when rows come back (pinned by the
   * `ddic-t000-rows3` cassette's own capture notes) — it must never be read
   * as a row count there. On `freestyle` it is the true total matching the
   * statement's WHERE, independent of the `rowNumber` cap, which is what
   * `img-read.ts` uses it for. Absent or not parseable as an integer stays
   * `undefined` — never defaulted to `0`, which would be indistinguishable
   * from a genuine "zero rows match" answer.
   */
  totalRows?: number;
  /**
   * `<dataPreview:executedQueryString>`, the server's own echo of the
   * compiled statement (namespace prefix already stripped by the parser),
   * e.g. captured in `test/cassettes/datapreview/datapreview-select-success.cassette.json`
   * as `SELECT MANDT, CCCATEGORY, CCCORACTIV FROM T000   INTO     TABLE
   * @DATA(LT_RESULT)   UP TO 20  ROWS   .`. Absent or empty stays
   * `undefined`, never `""` — same "don't default a missing signal" rule as
   * `totalRows` above.
   */
  executedQueryString?: string;
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

  // `<dataPreview:totalRows>` is a direct child of `tableData`, sibling to
  // `columns`/`message`, and is not in the `isArray` predicate, so it parses
  // to a plain string (not an array) when present. A missing element or one
  // that fails to parse as an integer must stay `undefined`; a genuinely
  // parsed `0` (e.g. from the `ddic` endpoint, which always reports 0) is
  // still reported as `0`.
  let totalRows: number | undefined;
  const totalRowsRaw = table.totalRows;
  if (typeof totalRowsRaw === "string" && totalRowsRaw.trim() !== "") {
    const parsed = Number.parseInt(totalRowsRaw, 10);
    if (Number.isFinite(parsed)) totalRows = parsed;
  }

  // Same shape as `totalRows` above: a direct child of `tableData`, a plain
  // string when present, and never defaulted to `""` — an absent element is
  // a different fact from an empty one, even though both would render the
  // same in `""`'s place.
  const executedQueryStringRaw = table.executedQueryString;
  const executedQueryString =
    typeof executedQueryStringRaw === "string" && executedQueryStringRaw.trim() !== ""
      ? executedQueryStringRaw
      : undefined;

  return {
    columns,
    rows,
    messages,
    ...(totalRows === undefined ? {} : { totalRows }),
    ...(executedQueryString === undefined ? {} : { executedQueryString }),
  };
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

/**
 * Refines a `classifyPreviewFailure` result for the FILTERED (freestyle)
 * path only — runs AFTER it, and only ever narrows an `ADT_ERROR` into
 * `BAD_INPUT` for these three server messages, each measured live on A4H
 * 2026-09-12 by compiling the rendered statements. Anything else keeps
 * whatever `classifyPreviewFailure` already returned — this must not become
 * a general-purpose 400 reinterpreter. `sql` is attached to `details` on
 * every branch (including the pass-through) so the caller can see what was
 * actually sent.
 */
export function classifyFilteredPreviewFailure(e: unknown, ctx: ErrorContext, sql: string): AbapError {
  const err = classifyPreviewFailure(e, ctx);
  if (err.code !== "ADT_ERROR") {
    return new AbapError(err.code, err.message, { ...err.details, sql }, err.hint, { retryable: err.retryable }); // re-wrap: preserves the classified error's own retryability verbatim, only `sql` is added
  }

  const message = err.message;
  if (/client field .* cannot be specified in the where condition/i.test(message)) {
    return new AbapError(
      "BAD_INPUT",
      message,
      { ...err.details, sql },
      "The read is already scoped to the logon client — drop the where condition on the client field.",
    );
  }
  if (/like condition can only be used with character-like fields/i.test(message)) {
    return new AbapError(
      "BAD_INPUT",
      message,
      { ...err.details, sql },
      "Use eq/ne/lt/le/gt/ge on a numeric field instead of like.",
    );
  }
  if (/from the order by clause is missing in the select list/i.test(message)) {
    return new AbapError(
      "BAD_INPUT",
      message,
      { ...err.details, sql },
      "With distinct, every order_by field must also appear in columns.",
    );
  }
  return new AbapError(err.code, err.message, { ...err.details, sql }, err.hint, { retryable: err.retryable }); // re-wrap: preserves the classified error's own retryability verbatim, only `sql` is added
}

// ----------------------------------------------------------------- preview ---

/**
 * Preview up to `maxRows` rows of one DDIC table or view, optionally
 * narrowed by a structured `filter` (issue #73) — `where`/`columns`/
 * `order_by`/`distinct`, never raw SQL text from a caller.
 *
 * Validation happens before any request is issued — an invalid name must cost
 * zero HTTP calls, because the name is the injection surface and a
 * rejected one has nothing safe to send. Same rule extends to `filter`:
 * `assertFilterShape` runs before any wire call, so a bad operator or an
 * over-long list costs zero requests too.
 */
export async function previewDdicEntity(
  conn: AbapConnection,
  input: { table: string; maxRows: number; filter?: PreviewFilter },
): Promise<PreviewResult> {
  const table = normaliseEntityName(input.table);
  if (!isValidDdicEntityName(table)) {
    throw new AbapError(
      "BAD_INPUT",
      `'${String(input.table)}' is not a valid DDIC table or view name.`,
      { table: String(input.table) },
      "Pass a bare name such as T000, DD02L or /ACME/TAB. This tool previews one " +
        "named entity; narrow it with the structured where/columns/order_by parameters, " +
        "never with SQL text.",
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

  // Unfiltered path — UNCHANGED from before issue #73. Existing tests pin
  // this exact call sequence (one `dataPreviewDdic` call, the N+1 slice,
  // `moreRowsExist` from `rows.length > maxRows`), so nothing here may move.
  if (isEmptyFilter(input.filter)) {
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

  // Filtered path (issue #73).
  const filter = input.filter as PreviewFilter;
  // Zero wire cost for a bad operator/shape — checked before the metadata
  // probe below ever fires.
  assertFilterShape(filter);

  // Metadata probe: a REAL extra request, capped at 1 row (the server
  // actually returns up to 2, which are discarded — same N+1 fact as the
  // unfiltered path above). Its column list is the only flattened, wire-true
  // set available for this entity: a DDIC source read via ddic.ts misses
  // include-flattened fields (live on A4H, TB003's source names 6 fields
  // plus `include si_tb003aba` while the preview returns 7 columns including
  // BPVIEW), and a DDIC source read covers no DDIC/CDS view at all, while
  // this probe hits the same endpoint the real read will use.
  let probeBody: string;
  try {
    const probeResp = await conn.dataPreviewDdic(table, 1);
    probeBody = probeResp.body;
  } catch (e) {
    throw classifyPreviewFailure(e, ctx);
  }
  const probe = parsePreviewBody(probeBody);
  if (probe.columns.length === 0) {
    const firstMessage = probe.messages[0];
    if (firstMessage) {
      // The entity answered but refused — e.g. a CDS view with parameters,
      // the same in-band-message case `previewDdicEntity`'s unfiltered path
      // reports rather than throws. Here there is no row data to report
      // instead, so the server's own message is the whole answer.
      throw new AbapError(
        "ADT_ERROR",
        `${table} answered with no columns: "${firstMessage.text}" (severity ${firstMessage.severity || "unstated"}).`,
        { table, messages: probe.messages },
        "This entity does not support a filtered preview the way a plain table does — see the " +
          "server's own message above.",
      );
    }
    throw new AbapError(
      "NOT_FOUND",
      `No DDIC table or view named ${table} exists on this system, or it has no columns to filter.`,
      { table },
      "Check the spelling, or look the object up first.",
    );
  }

  const sql = renderPreviewSelect(table, filter, probe.columns);

  let body: string;
  try {
    const resp = await conn.dataPreviewFreestyle(sql, maxRows);
    body = resp.body;
  } catch (e) {
    throw classifyFilteredPreviewFailure(e, ctx, sql);
  }

  const { columns, rows, messages, totalRows, executedQueryString } = parsePreviewBody(body);
  // The freestyle row cap (`rowNumber`) is honoured exactly — no N+1 here,
  // unlike the ddic path above — so `rows.length > maxRows` cannot signal
  // "more exist" the way it does there. `totalRows` (the true match count,
  // independent of the cap) is the right signal when the server sent one;
  // only fall back to the N+1-style comparison when it didn't.
  const moreRowsExist = totalRows !== undefined ? totalRows > rows.length : rows.length > maxRows;

  return {
    table,
    columns,
    rows,
    rowsRequested: maxRows,
    moreRowsExist,
    messages,
    statement: sql,
    ...(executedQueryString === undefined ? {} : { executedQueryString }),
    ...(totalRows === undefined ? {} : { totalRows }),
  };
}
