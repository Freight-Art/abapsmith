/**
 * SQL builder for read-only freestyle-preview `SELECT`s against fixed SAP
 * catalog tables (repository/authorization-concept metadata such as
 * `TOBJ`/`TOBJT`/`AUTHX` — never a business-data table), assembled from a
 * frozen name list (a per-caller `Object.freeze`d catalog, `img-catalog.ts`
 * style) plus validated literal values. Pure — no `AbapConnection` beyond
 * the one call `runCatalogSelect` makes; no retries, no caching.
 *
 * Consumers: `src/adt/index-read.ts` (issue #86) and `src/adt/suso-read.ts`
 * (issue #87). Both need the same small set of guarantees this module
 * gives — a line-capped multi-line `SELECT`, a validated literal, a
 * validated `IN (…)` list — so this module exists to hold that logic once
 * rather than twice.
 *
 * Why this duplicates `img-query.ts`'s builder instead of sharing it:
 * `img-query.ts`'s `assertSqlValue`/`buildSelect` raise errors that name the
 * IMG reader specifically (its own module doc, its own "IMG query" wording),
 * and `img-query.ts` is a file under concurrent development by another
 * change — extracting a shared module out of it right now would be a
 * cross-cutting refactor of code someone else is actively editing. The
 * duplication here is deliberate and small (a literal escaper, a validator,
 * a line-capped assembler); if a THIRD caller ever needs this, that is the
 * time to unify the two, not before.
 *
 * Live-proven endpoint constraints this module defends against (all
 * `AbapConnection.dataPreviewFreestyle`, see its own doc comment in
 * `connection.ts`):
 *   - the server appends its own `INTO TABLE @DATA(...) UP TO <rowNumber>
 *     ROWS .` to whatever statement is sent, so an in-text `UP TO` collides
 *     with it — `dataPreviewFreestyle` itself rejects that client-side
 *     before the request goes out; this module never emits one;
 *   - the request body wraps at 255 characters, and a statement that
 *     straddles that wrap fails to parse — every builder here therefore
 *     emits multi-line SQL (one clause per line) and `buildCatalogSelect`
 *     refuses to return any line over `CATALOG_SQL_LINE_MAX` (200, a margin
 *     below the real 255-char wrap, mirroring `img-query.ts`'s own margin);
 *   - **a literal wider than the target column's declared width is a hard
 *     HTTP 400, not an empty result.** Observed on A4H 2026-09-12:
 *     `SELECT * FROM tobj WHERE objct = 'Z_I87_NO_SUCH_OBJ'` answered
 *     `400 'Z_I87_NO_SUCH_OBJ' is not a valid value for C(10,0)` — SAP
 *     checks the literal's length against the column's DDIC width before it
 *     ever gets to asking whether a row matches. An over-length name is
 *     therefore not "no such object", it is a request the server refuses to
 *     even evaluate. That is why `assertCatalogValue` takes the target
 *     column's declared maximum length and enforces it client-side: refusing
 *     the value here, with a message that says what would otherwise happen,
 *     is strictly more informative than letting the server 400 on it.
 */
import { AbapError } from "./errors.js";
import { parsePreviewBody } from "./datapreview.js";
import type { AbapConnection } from "./connection.js";

// --------------------------------------------------------------- literals ---

/** Same doubling convention Open SQL and ABAP source share: a single quote is escaped by doubling it. */
export function catalogLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Matches every C0 control code (0x00-0x1F, including LF/CR/TAB) plus DEL (0x7F).
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/**
 * Gate before a caller-supplied value becomes a literal in generated SQL.
 * Refuses (in this order): non-string, blank/whitespace-only, a single
 * quote (would need escaping — refused rather than silently escaped, since
 * a quote in a table/object/field name is never legitimate here), a
 * semicolon (this module builds exactly one statement; a semicolon in a
 * value is not a shape any of these catalog columns actually take), a
 * newline or other control character (would be indistinguishable from the
 * real line breaks `buildCatalogSelect` uses to stay under the request-body
 * wrap), and anything over `maxLen` — the target column's declared DDIC
 * width, enforced here because the server answers an over-wide literal with
 * a hard HTTP 400 rather than an empty result (see module header).
 */
export function assertCatalogValue(value: string, what: string, maxLen: number): string {
  if (typeof value !== "string") {
    throw new AbapError("BAD_INPUT", `${what} must be a string.`, { what });
  }
  if (value.trim() === "") {
    throw new AbapError("BAD_INPUT", `${what} must not be empty or blank.`, { what });
  }
  if (value.includes("'")) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} "${value}" contains a single quote — refused, not escaped. A quote is never a valid character in this value.`,
      { what, value },
    );
  }
  if (value.includes(";")) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} "${value}" contains a semicolon — refused. Only one statement is ever built from this value.`,
      { what, value },
    );
  }
  if (CONTROL_CHAR_RE.test(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} "${value}" contains a newline or other control character — refused, not stripped.`,
      { what, value },
    );
  }
  if (value.length > maxLen) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} "${value}" is ${value.length} characters, over the ${maxLen}-character declared width of the ` +
        `target column. The endpoint answers an over-wide literal with HTTP 400 ("... is not a valid value for ` +
        `C(${maxLen},0)"), not an empty result (observed on A4H 2026-09-12) — this value is refused here instead ` +
        `of being sent. Shorten it or check the name.`,
      { what, value, length: value.length, maxLen },
    );
  }
  return value;
}

// ------------------------------------------------------------------ IN (…) ---

/** Cap on values per `IN (…)`; a caller with more values chunks into multiple statements. */
export const CATALOG_MAX_IN_LIST = 50;

/** `IN ( 'A', 'B' )` from validated values; refuses an empty list or one longer than `CATALOG_MAX_IN_LIST`. */
export function catalogInList(values: readonly string[], what: string, maxLen: number): string {
  if (values.length === 0) {
    throw new AbapError("BAD_INPUT", `${what} must not be empty — "IN ()" is not valid SQL.`, { what });
  }
  if (values.length > CATALOG_MAX_IN_LIST) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} has ${values.length} values, over the ${CATALOG_MAX_IN_LIST}-value cap per statement — chunk the caller's list into multiple queries.`,
      { what, count: values.length, cap: CATALOG_MAX_IN_LIST },
    );
  }
  const literals = values.map((v) => catalogLiteral(assertCatalogValue(v, what, maxLen)));
  return `IN ( ${literals.join(", ")} )`;
}

// ------------------------------------------------------------------ assembly ---

/**
 * The freestyle endpoint wraps (and mis-parses) any request-body line over
 * roughly 255 characters (see module header) — this is a margin below that,
 * the same margin `img-query.ts` uses for its own line cap.
 */
export const CATALOG_SQL_LINE_MAX = 200;

/** Builds a multi-line SELECT, one clause per line, and refuses any line over `CATALOG_SQL_LINE_MAX`. */
export function buildCatalogSelect(select: string, from: string, whereParts: readonly string[], orderBy?: string): string {
  const lines = [`SELECT ${select}`, `FROM ${from}`];
  whereParts.forEach((part, i) => {
    lines.push(`${i === 0 ? "WHERE" : "  AND"} ${part}`);
  });
  if (orderBy !== undefined) lines.push(`ORDER BY ${orderBy}`);
  const statement = lines.join("\n");
  statement.split("\n").forEach((line, i) => {
    if (line.length > CATALOG_SQL_LINE_MAX) {
      throw new AbapError(
        "CHECK_FAILED",
        `Generated catalog query line ${i + 1} is ${line.length} chars, over the ${CATALOG_SQL_LINE_MAX}-char line cap: ${line}`,
        { line: i + 1, length: line.length },
      );
    }
  });
  return statement;
}

// -------------------------------------------------------------------- rows ---

/** One parsed row, column name (upper case) -> cell text. */
export type CatalogRow = Readonly<Record<string, string>>;

export interface CatalogResult {
  readonly columns: readonly string[];
  readonly rows: readonly CatalogRow[];
  /** The endpoint's own total, independent of the requested row count, when it reported one. */
  readonly totalRows?: number;
  /** Server-attached in-band messages, verbatim. */
  readonly messages: readonly { severity: string; text: string }[];
}

/**
 * Runs one SELECT through `conn.dataPreviewFreestyle` and parses it.
 * `rowNumber` must be a positive integer — `dataPreviewFreestyle` itself
 * enforces that (0/non-numeric mean UNLIMITED on this endpoint, not "none").
 *
 * Deliberately does NOT call `safety.assertDataPreview`: that gate exists
 * for `abap_data_preview` (`src/tools/data-preview.ts`), which hands a
 * caller-named table's first N rows straight through with no filter at all
 * and denies a built-in list of tables carrying credentials, payroll and
 * financial-document business data (`DEFAULT_PREVIEW_DENY_TABLES`,
 * `src/safety.ts`). Every table this module's callers read is repository or
 * authorization-CONCEPT metadata (e.g. `TOBJ`, `AUTHX`, DDIC catalog
 * tables) read with a validated, targeted `WHERE`, not a caller-named table
 * dumped wholesale — the same distinction `src/adt/img-read.ts` already
 * draws for the IMG catalog (see `src/tools/img.ts`'s `runImgReadTool`,
 * which calls only `safety.assert("read")`, never `assertDataPreview`, for
 * exactly this reason). This mirrors that decision rather than inventing a
 * new one.
 */
export async function runCatalogSelect(conn: AbapConnection, sql: string, rowNumber: number): Promise<CatalogResult> {
  const resp = await conn.dataPreviewFreestyle(sql, rowNumber);
  const { columns, rows, messages, totalRows } = parsePreviewBody(resp.body);
  const names = columns.map((c) => c.name.toUpperCase());
  const mappedRows: CatalogRow[] = rows.map((row) => {
    const rec: Record<string, string> = {};
    names.forEach((name, i) => {
      rec[name] = row[i] ?? "";
    });
    return rec;
  });
  return { columns: names, rows: mappedRows, totalRows, messages };
}

/** Reads a column from a row, throwing a clear AbapError when the endpoint did not return it. */
export function requireCatalogColumn(result: CatalogResult, column: string): void {
  const upper = column.toUpperCase();
  if (!result.columns.includes(upper)) {
    throw new AbapError(
      "ADT_ERROR",
      `expected column "${column}" is missing from the catalog preview response (columns present: ` +
        `${result.columns.length > 0 ? result.columns.join(", ") : "none"}).`,
      { column, present: result.columns },
    );
  }
}
