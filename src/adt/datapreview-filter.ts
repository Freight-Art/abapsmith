/**
 * Structured-filter compiler for DDIC data preview (issue #73).
 *
 * `previewDdicEntity` (`datapreview.ts`) sends a filtered read as an Open SQL
 * `SELECT` to `POST /sap/bc/adt/datapreview/freestyle` (`AbapConnection.dataPreviewFreestyle`,
 * `connection.ts`). This module renders that SELECT from a structured filter
 * — `where`/`columns`/`order_by`/`distinct` — and nothing else: every
 * identifier in the rendered statement comes from the server's own preview
 * column metadata (`PreviewColumn[]`, passed in by the caller), and every
 * value is rendered as a quoted or typed literal. No caller text is ever
 * concatenated into the statement unescaped.
 *
 * Pure — no `AbapConnection`, no HTTP. Deliberately does NOT import
 * `./img-query.js`: that module already imports `./datapreview.js` (for
 * `parsePreviewBody`/`isValidDdicEntityName`), and `./datapreview.js` is
 * about to import THIS module — an import here of `img-query.js` would close
 * that into a cycle (datapreview -> datapreview-filter -> img-query ->
 * datapreview). The two modules independently duplicate a little shape
 * (literal quoting, a line-length guard) rather than share it through that
 * cycle; see `img-query.ts`'s own file header for its half of this.
 *
 * The rules below were measured live on A4H on 2026-09-12: every claim is
 * either a syntax-check result or the outcome of actually running a $TMP
 * report (`Z_I73_PROBE`) built from exactly the Open SQL statements this
 * module renders — not read off documentation.
 */
import { AbapError } from "./errors.js";
import { abapLiteral, assertAbapText } from "./enhancement-templates.js";
import { FREESTYLE_BANNED_KEYWORDS } from "./connection.js";
import type { PreviewColumn } from "./datapreview.js";

// ------------------------------------------------------------------ shapes ---

export const PREVIEW_OPS = ["eq", "ne", "lt", "le", "gt", "ge", "like", "in", "is_null"] as const;
export type PreviewOp = (typeof PREVIEW_OPS)[number];
export type PreviewValue = string | number;

export interface PreviewCondition {
  field: string;
  op: PreviewOp;
  value?: PreviewValue | PreviewValue[];
}

export interface PreviewOrder {
  field: string;
  direction?: "asc" | "desc";
}

export interface PreviewFilter {
  where?: PreviewCondition[];
  columns?: string[];
  orderBy?: PreviewOrder[];
  distinct?: boolean;
}

// ------------------------------------------------------------------ limits ---

export const MAX_WHERE_CONDITIONS = 20;
export const MAX_ORDER_BY = 10;
export const MAX_COLUMNS = 100;
export const MAX_IN_VALUES = 50;
export const MAX_VALUE_LENGTH = 255;
/** The freestyle request body wraps at this many characters per line (measured — see `img-query.ts`'s `IMG_SQL_LINE_MAX`, the same fact, independently enforced here). */
export const PREVIEW_SQL_LINE_MAX = 255;

const PREVIEW_OPS_LIST = PREVIEW_OPS.join(", ");
const FREESTYLE_BANNED_WORD_RE = new RegExp(`\\b(?:${FREESTYLE_BANNED_KEYWORDS.join("|")})\\b`, "i");

// -------------------------------------------------------------- emptiness ---

/**
 * True when `filter` asks for nothing beyond the plain unfiltered read —
 * the case that must stay byte-identical to the pre-#73 code path (same
 * `conn.dataPreviewDdic` call, same N+1 slice). `distinct: false` counts as
 * empty; `distinct: true` does not, even with no `where`/`columns`/`orderBy`,
 * because `SELECT DISTINCT *` is a different statement from the plain ddic
 * read.
 */
export function isEmptyFilter(filter: PreviewFilter | undefined): boolean {
  if (filter === undefined) return true;
  const noWhere = filter.where === undefined || filter.where.length === 0;
  const noColumns = filter.columns === undefined || filter.columns.length === 0;
  const noOrderBy = filter.orderBy === undefined || filter.orderBy.length === 0;
  return noWhere && noColumns && noOrderBy && filter.distinct !== true;
}

// -------------------------------------------------------------- shape-only ---

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isPreviewValue(v: unknown): v is PreviewValue {
  return typeof v === "string" || isFiniteNumber(v);
}

/**
 * Refuses a value that would trip the freestyle endpoint's own
 * word-boundary banned-keyword guard (`connection.ts`'s `FREESTYLE_BANNED_RE`,
 * built from `FREESTYLE_BANNED_KEYWORDS`) once quoted into this statement.
 * The literal itself would be safely quoted — `dataPreviewFreestyle` does not
 * parse quoting, it just scans the whole statement text for a banned word —
 * so a value like "UPDATE" refused HERE with a clear "which field, which
 * word" message is better than the same statement reaching the wire and
 * being refused whole by the guard with no idea which value caused it.
 */
function assertNoBannedWord(value: string, what: string): void {
  const hit = FREESTYLE_BANNED_WORD_RE.exec(value);
  if (hit) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} contains the word "${hit[0]}", which the freestyle endpoint's own banned-keyword ` +
        `guard refuses anywhere in the statement, even inside a quoted literal. Refusing here with a ` +
        `clearer message than that guard's.`,
      { what, value, word: hit[0] },
    );
  }
}

function assertCondition(cond: PreviewCondition, index: number): void {
  const label = `where[${index}]`;
  if (typeof cond.field !== "string" || cond.field.trim() === "") {
    throw new AbapError("BAD_INPUT", `${label}.field must be a non-empty string.`, { what: `${label}.field`, value: cond.field });
  }
  if (!(PREVIEW_OPS as readonly string[]).includes(cond.op)) {
    throw new AbapError(
      "BAD_INPUT",
      `${label}.op "${String(cond.op)}" is not a recognised operator — accepted values are: ${PREVIEW_OPS_LIST}.`,
      { what: `${label}.op`, value: cond.op },
    );
  }

  if (cond.op === "is_null") {
    if (cond.value !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `${label} has op "is_null" but also supplies a "value" — is_null takes no value; refusing rather than silently ignoring it.`,
        { what: `${label}.value`, value: cond.value },
      );
    }
    return;
  }

  if (cond.op === "in") {
    if (!Array.isArray(cond.value) || cond.value.length === 0) {
      throw new AbapError(
        "BAD_INPUT",
        `${label} has op "in" but "value" is not a non-empty array.`,
        { what: `${label}.value`, value: cond.value },
      );
    }
    if (cond.value.length > MAX_IN_VALUES) {
      throw new AbapError(
        "BAD_INPUT",
        `${label} has ${cond.value.length} values in its "in" list, over the ${MAX_IN_VALUES}-value cap per condition.`,
        { what: `${label}.value`, count: cond.value.length, cap: MAX_IN_VALUES },
      );
    }
    cond.value.forEach((v) => assertScalarValue(v, cond.field));
    return;
  }

  // Every remaining op (eq/ne/lt/le/gt/ge/like) requires exactly one scalar value.
  if (cond.value === undefined) {
    throw new AbapError("BAD_INPUT", `${label} (op "${cond.op}") requires a "value".`, { what: `${label}.value`, op: cond.op });
  }
  if (Array.isArray(cond.value)) {
    throw new AbapError(
      "BAD_INPUT",
      `${label} (op "${cond.op}") must not supply an array "value" — only "in" takes a list.`,
      { what: `${label}.value`, op: cond.op },
    );
  }
  assertScalarValue(cond.value, cond.field);
}

/**
 * Checks one where-condition value against the field it applies to. Wording
 * matches the house convention: the string-length/control-character check
 * is delegated to `enhancement-templates.ts`'s `assertAbapText` with the
 * literal `what` text `"where value for ${field}"`, so a caller sees the
 * same phrasing this codebase already uses everywhere else for that failure.
 */
function assertScalarValue(v: unknown, field: string): void {
  const what = `where value for ${field}`;
  if (!isPreviewValue(v)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} must be a string or a finite number, got ${JSON.stringify(v)}.`,
      { field, value: v },
    );
  }
  if (typeof v === "string") {
    const checked = assertAbapText(v, what, MAX_VALUE_LENGTH);
    assertNoBannedWord(checked, what);
  }
}

function assertOrder(order: PreviewOrder, index: number): void {
  const label = `order_by[${index}]`;
  if (typeof order.field !== "string" || order.field.trim() === "") {
    throw new AbapError("BAD_INPUT", `${label}.field must be a non-empty string.`, { what: `${label}.field`, value: order.field });
  }
  if (order.direction !== undefined && order.direction !== "asc" && order.direction !== "desc") {
    throw new AbapError(
      "BAD_INPUT",
      `${label}.direction "${String(order.direction)}" must be "asc" or "desc" (or omitted).`,
      { what: `${label}.direction`, value: order.direction },
    );
  }
}

/**
 * Everything checkable WITHOUT server metadata — an invalid operator, an
 * over-long list, a malformed value — costs zero wire requests. Idempotent:
 * `renderPreviewSelect` calls this again itself, so a caller may call it
 * ahead of a metadata probe without doing the work twice in an observable way.
 */
export function assertFilterShape(filter: PreviewFilter): void {
  const where = filter.where ?? [];
  if (where.length > MAX_WHERE_CONDITIONS) {
    throw new AbapError(
      "BAD_INPUT",
      `"where" has ${where.length} conditions, over the ${MAX_WHERE_CONDITIONS}-condition cap.`,
      { count: where.length, cap: MAX_WHERE_CONDITIONS },
    );
  }
  where.forEach((cond, i) => assertCondition(cond, i));

  const columns = filter.columns ?? [];
  if (columns.length > MAX_COLUMNS) {
    throw new AbapError(
      "BAD_INPUT",
      `"columns" has ${columns.length} entries, over the ${MAX_COLUMNS}-column cap.`,
      { count: columns.length, cap: MAX_COLUMNS },
    );
  }
  columns.forEach((c, i) => {
    if (typeof c !== "string" || c.trim() === "") {
      throw new AbapError("BAD_INPUT", `columns[${i}] must be a non-empty string.`, { what: `columns[${i}]`, value: c });
    }
  });
  const seenColumns = new Set<string>();
  for (const c of columns) {
    const key = c.toUpperCase();
    if (seenColumns.has(key)) {
      throw new AbapError(
        "BAD_INPUT",
        `"columns" names "${c}" more than once (case-insensitive) — a projection lists each column at most once.`,
        { what: "columns", value: c },
      );
    }
    seenColumns.add(key);
  }

  const orderBy = filter.orderBy ?? [];
  if (orderBy.length > MAX_ORDER_BY) {
    throw new AbapError(
      "BAD_INPUT",
      `"order_by" has ${orderBy.length} entries, over the ${MAX_ORDER_BY}-entry cap.`,
      { count: orderBy.length, cap: MAX_ORDER_BY },
    );
  }
  orderBy.forEach((o, i) => assertOrder(o, i));
}

// ---------------------------------------------------------------- literals ---

/**
 * Wire type codes NUMC/CHAR ("N"/"C") are the measured-good half of a LIKE
 * predicate; INT4/CURR ("I"/"P") are measured-bad ("A LIKE condition can only
 * be used with character-like fields."). This is a measured DENY-list of
 * numeric-ish type codes, not a guessed allow-list of character-ish ones —
 * types outside this set are let through untested rather than refused on a
 * guess.
 */
const NUMERIC_TYPE_CODES = new Set(["P", "I", "b", "s", "8", "F", "a", "e"]);

/** Wire type codes rendered UNQUOTED (integer domains) — live-proven: `WHERE CARRID_ID > 300` compiles. */
const INTEGER_TYPE_CODES = new Set(["I", "b", "s", "8"]);
/** Wire type codes rendered QUOTED despite being numeric (decimal/float domains) — live-proven: unquoted is a syntax error, quoted (`>= '422.94'`) compiles. */
const DECIMAL_TYPE_CODES = new Set(["P", "F", "a", "e"]);

const INTEGER_SHAPE_RE = /^-?\d+$/;
const DECIMAL_SHAPE_RE = /^-?\d+(\.\d+)?$/;
const DATE_SHAPE_RE = /^(\d{4})-?(\d{2})-?(\d{2})$/;
const TIME_SHAPE_RE = /^(\d{2}):?(\d{2}):?(\d{2})$/;

/**
 * Renders one value as an Open SQL literal for `column`'s wire type code.
 * NOTE: `column.length` is an OUTPUT/display length (live: FLDATE reports
 * D(10) for an 8-character YYYYMMDD value) — never used here as a
 * value-length check, only the type-specific shape regexes are.
 */
function renderLiteral(value: PreviewValue, column: PreviewColumn, what: string): string {
  const type = column.type;
  const asString = String(value);

  if (INTEGER_TYPE_CODES.has(type)) {
    if (!INTEGER_SHAPE_RE.test(asString)) {
      throw new AbapError(
        "BAD_INPUT",
        `${what}: "${asString}" is not a valid value for ${column.name} (type "${type}") — expected an integer, e.g. "300".`,
        { what, value, field: column.name, type },
      );
    }
    return asString;
  }

  if (DECIMAL_TYPE_CODES.has(type)) {
    if (!DECIMAL_SHAPE_RE.test(asString)) {
      throw new AbapError(
        "BAD_INPUT",
        `${what}: "${asString}" is not a valid value for ${column.name} (type "${type}") — expected a decimal, e.g. "422.94". ` +
          `Rendered as a quoted literal — an unquoted decimal is a syntax error on this endpoint.`,
        { what, value, field: column.name, type },
      );
    }
    return abapLiteral(asString);
  }

  if (type === "D") {
    const m = DATE_SHAPE_RE.exec(asString);
    if (!m) {
      throw new AbapError(
        "BAD_INPUT",
        `${what}: "${asString}" is not a valid value for ${column.name} (type "D") — expected YYYYMMDD or YYYY-MM-DD.`,
        { what, value, field: column.name, type },
      );
    }
    return abapLiteral(`${m[1]}${m[2]}${m[3]}`);
  }

  if (type === "T") {
    const m = TIME_SHAPE_RE.exec(asString);
    if (!m) {
      throw new AbapError(
        "BAD_INPUT",
        `${what}: "${asString}" is not a valid value for ${column.name} (type "T") — expected HHMMSS or HH:MM:SS.`,
        { what, value, field: column.name, type },
      );
    }
    return abapLiteral(`${m[1]}${m[2]}${m[3]}`);
  }

  // Everything else: plain text through abapLiteral, which doubles embedded
  // single quotes — live-proven no-injection case: `= 'Walldorf''s'`
  // compiles and returns 0 rows.
  return abapLiteral(asString);
}

// ---------------------------------------------------------------- assembly ---

const OP_SYMBOL: Record<Exclude<PreviewOp, "like" | "in" | "is_null">, string> = {
  eq: "=",
  ne: "<>",
  lt: "<",
  le: "<=",
  gt: ">",
  ge: ">=",
};

interface ResolvedField {
  /** The server's own spelling, used in the rendered SQL — never the caller's. */
  name: string;
  column: PreviewColumn;
}

function resolveField(field: string, byUpper: Map<string, PreviewColumn>, what: string): ResolvedField {
  const col = byUpper.get(field.toUpperCase());
  if (!col) {
    const known = [...byUpper.values()].map((c) => c.name).join(", ");
    throw new AbapError(
      "BAD_INPUT",
      `${what} "${field}" is not a column of this entity. Known columns: ${known}.`,
      { what, value: field, known: [...byUpper.values()].map((c) => c.name) },
    );
  }
  return { name: col.name, column: col };
}

function renderCondition(cond: PreviewCondition, byUpper: Map<string, PreviewColumn>, index: number, clientFieldName: string | undefined): string {
  const label = `where[${index}]`;
  const { name, column } = resolveField(cond.field, byUpper, `${label}.field`);

  if (clientFieldName !== undefined && name.toUpperCase() === clientFieldName.toUpperCase()) {
    throw new AbapError(
      "BAD_INPUT",
      `where[${index}] refers to the client field "${name}" — the compiler refuses that: ` +
        `'The client field "${name}" cannot be specified in the WHERE condition. Client handling ` +
        `is performed by the compiler.'`,
      { what: `${label}.field`, field: name },
      "The read is already scoped to the logon client — drop this condition.",
    );
  }

  if (cond.op === "is_null") {
    return `${name} IS NULL`;
  }

  if (cond.op === "like") {
    if (NUMERIC_TYPE_CODES.has(column.type)) {
      throw new AbapError(
        "BAD_INPUT",
        `where[${index}] uses "like" on ${name}, a numeric field (type "${column.type}") — ` +
          `'A LIKE condition can only be used with character-like fields.'`,
        { what: `${label}.op`, field: name, type: column.type },
        "Use eq/ne/lt/le/gt/ge on a numeric field instead of like.",
      );
    }
    const pattern = assertAbapText(String(cond.value), `${label}.value`, MAX_VALUE_LENGTH);
    // Passed through verbatim apart from ABAP quote doubling — this tool's
    // contract is the SQL LIKE grammar (% = any run, _ = one char, # = escape
    // char), NOT img-query.ts's own `*`-to-`%` translation, which belongs to
    // that module's frozen catalog UX, not to a general SQL filter.
    const escaped = pattern.replace(/'/g, "''");
    return `${name} LIKE '${escaped}' ESCAPE '#'`;
  }

  if (cond.op === "in") {
    const values = cond.value as PreviewValue[];
    const literals = values.map((v, i) => renderLiteral(v, column, `${label}.value[${i}]`));
    return inPredicate(name, literals);
  }

  const literal = renderLiteral(cond.value as PreviewValue, column, `${label}.value`);
  return `${name} ${OP_SYMBOL[cond.op]} ${literal}`;
}

/** Items per `IN (…)` line — mirrors `img-query.ts`'s own per-line packing; kept small so a long list still fits `PREVIEW_SQL_LINE_MAX` after quoting. */
const IN_LIST_ITEMS_PER_LINE = 5;

function inPredicate(column: string, literals: readonly string[]): string {
  if (literals.length <= IN_LIST_ITEMS_PER_LINE) {
    return `${column} IN (${literals.join(", ")})`;
  }
  const lines: string[] = [`${column} IN (`];
  for (let i = 0; i < literals.length; i += IN_LIST_ITEMS_PER_LINE) {
    const chunk = literals.slice(i, i + IN_LIST_ITEMS_PER_LINE).join(", ");
    const isLast = i + IN_LIST_ITEMS_PER_LINE >= literals.length;
    lines.push(`  ${chunk}${isLast ? "" : ","}`);
  }
  lines.push(")");
  return lines.join("\n");
}

/**
 * Compiles a structured filter into an Open SQL `SELECT` against `table`,
 * resolving every field through `columns` — the server's own preview column
 * metadata for this entity, obtained by a prior probe read
 * (`previewDdicEntity`, `datapreview.ts`). `columns` is authoritative: an
 * unknown field name is refused, and the SERVER's own spelling of a resolved
 * name is what appears in the rendered SQL, never the caller's.
 */
export function renderPreviewSelect(table: string, filter: PreviewFilter, columns: readonly PreviewColumn[]): string {
  // Idempotent — safe even though `previewDdicEntity` may have already
  // called this once before the metadata probe, to spend zero wire cost on
  // an invalid operator/shape.
  assertFilterShape(filter);

  const byUpper = new Map<string, PreviewColumn>();
  for (const c of columns) byUpper.set(c.name.toUpperCase(), c);

  // Client field: refused only in WHERE, only when it is the FIRST column,
  // named MANDT or CLIENT, and typed "C" (CHAR) — live-measured refusal text
  // is quoted at the point of use in renderCondition. Projection/ordering
  // are unaffected (live-proven fine).
  //
  // Deliberately NOT gated on `column.key`: measured live on A4H
  // 2026-09-12, `keyAttribute` comes back `"false"` for EVERY column on this
  // endpoint, even on TB003 whose real key is CLIENT+ROLE (also visible in
  // `test/cassettes/datapreview/ddic-t000-rows3.cassette.json`) — the preview
  // endpoint simply does not report key-ness, so `PreviewColumn.key` cannot
  // be trusted to identify the client field. Name + type is what's left, and
  // `length` (typically 3 for MANDT/CLIENT) is deliberately not required to
  // be present either — the freestyle endpoint's own metadata probe omits it
  // entirely.
  const first = columns[0];
  const clientFieldName =
    first && first.type === "C" && (first.name.toUpperCase() === "MANDT" || first.name.toUpperCase() === "CLIENT")
      ? first.name
      : undefined;

  const where = filter.where ?? [];
  const whereParts = where.map((cond, i) => renderCondition(cond, byUpper, i, clientFieldName));

  const rawColumns = filter.columns ?? [];
  const resolvedColumns = rawColumns.map((c, i) => resolveField(c, byUpper, `columns[${i}]`));
  const projected = resolvedColumns.map((r) => r.name);

  const orderBy = filter.orderBy ?? [];
  const resolvedOrder = orderBy.map((o, i) => ({
    ...resolveField(o.field, byUpper, `order_by[${i}].field`),
    direction: o.direction ?? "asc",
  }));

  // DISTINCT + explicit projection + ORDER BY: every order_by field must be
  // projected — live: "The field "ROLE" from the ORDER BY clause is missing
  // in the SELECT list." Without DISTINCT this is fine (live-proven), so the
  // check is scoped to the DISTINCT case only.
  if (filter.distinct === true && projected.length > 0 && resolvedOrder.length > 0) {
    const projectedUpper = new Set(projected.map((p) => p.toUpperCase()));
    resolvedOrder.forEach((o, i) => {
      if (!projectedUpper.has(o.name.toUpperCase())) {
        throw new AbapError(
          "BAD_INPUT",
          `order_by[${i}] names "${o.name}", which is not in "columns" — with distinct: true, ` +
            `'The field "${o.name}" from the ORDER BY clause is missing in the SELECT list.'`,
          { what: `order_by[${i}].field`, field: o.name },
          "With distinct, every order_by field must also appear in columns.",
        );
      }
    });
  }

  const selectKeyword = filter.distinct === true ? "SELECT DISTINCT" : "SELECT";
  const selectLines: string[] =
    projected.length === 0
      ? [`${selectKeyword} *`]
      : [selectKeyword, ...projected.map((name, i) => `  ${name}${i === projected.length - 1 ? "" : ","}`)];

  const lines: string[] = [...selectLines, `FROM ${table}`];
  whereParts.forEach((part, i) => {
    // A multi-line IN(...) predicate already carries its own internal
    // newlines/indentation; prefix only its first physical line.
    const partLines = part.split("\n");
    partLines.forEach((pl, j) => {
      if (j === 0) lines.push(`${i === 0 ? "WHERE" : "  AND"} ${pl}`);
      else lines.push(pl);
    });
  });
  if (resolvedOrder.length > 0) {
    const orderByClause = resolvedOrder.map((o) => `${o.name} ${o.direction === "desc" ? "DESCENDING" : "ASCENDING"}`).join(", ");
    lines.push(`ORDER BY ${orderByClause}`);
  }

  const statement = lines.join("\n");
  statement.split("\n").forEach((line, i) => {
    if (line.length > PREVIEW_SQL_LINE_MAX) {
      throw new AbapError(
        "CHECK_FAILED",
        `Generated preview query line ${i + 1} is ${line.length} chars, over the freestyle ` +
          `endpoint's ${PREVIEW_SQL_LINE_MAX}-char request-body line limit — the request body wraps ` +
          `at that width, so a longer line would be corrupted on the wire.`,
        { line: i + 1, length: line.length },
      );
    }
  });
  return statement;
}
