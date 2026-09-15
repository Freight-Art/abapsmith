/**
 * Turns an already-fetched `PreviewResult` (`src/adt/datapreview.ts`) into a
 * paste-ready ABAP fixture — issue #115. Pure and synchronous: no network, no
 * file I/O, nothing beyond the rows the caller already read past the deny
 * list, the `ABAP_ALLOW_DATA_PREVIEW` flag and the row ceiling. Masking a
 * field name (`maskedFields`) happens HERE, at render time, on rows already
 * in memory — it is a display transform, never a way to read more or less
 * than a plain preview would.
 */
import type { PreviewColumn, PreviewResult } from "../adt/datapreview.js";

/** How a caller wants the previewed rows rendered. Mirrors the tool's `format` input. */
export type PreviewFormat = "table" | "abap_value" | "test_double";

/** Input to both fixture renderers below. */
export interface FixtureRenderInput {
  /** The already-fetched, already-authorised preview to render. */
  readonly result: PreviewResult;
  /** Already-normalised (upper-case) field names to blank in the output. */
  readonly maskedFields: readonly string[];
  /** The caller's `columns` argument, when given — controls field order. */
  readonly columnOrder?: readonly string[] | undefined;
}

/** The rendered fixture, plus what a caller needs to know about how it was built. */
export interface FixtureRender {
  /** The literal / snippet itself. */
  readonly text: string;
  /** Disclosures to append to the response notes — never silent about what was cut, wrapped or masked. */
  readonly notes: readonly string[];
  /** Which shape `text` is: a bare `VALUE` literal, or one wrapped in a `cl_osql_test_environment` double. */
  readonly fixtureKind: "osql_test_environment" | "literal_only";
}

/** ABAP source line limit. Rows WRAP across several lines at this width — nothing is dropped, so this is not a truncation cap (see `renderRowGroup`). */
export const ABAP_LINE_MAX = 255;

/** Literal substituted for a masked character-like field. */
export const MASK_TEXT = "MASKED";

const SHARED_NOTE =
  "A fixture is a copy of production rows. The same deny-list, the same ABAP_ALLOW_DATA_PREVIEW " +
  "flag and the same row ceiling that govern a plain preview governed this read — format is " +
  "applied to rows already fetched, never as a separate path around the check.";

const TEST_DOUBLE_NOTE =
  "cl_osql_test_environment doubles an Open SQL entity (transparent table, database view, CDS " +
  "view) — which is the only kind abap_data_preview can read. For a structure or a table type " +
  "there is nothing to double: use the VALUE literal alone. cl_abap_testdouble doubles a class or " +
  "an interface, not a table.";

// ------------------------------------------------------------- literal shapes ---

type ColumnGroup = "char" | "date" | "time" | "int" | "dec" | "hex";

/** NUMC (`N`) is deliberately grouped with character types: leading zeros are significant, so it must never render as a bare number. */
const CHAR_TYPES = new Set(["C", "N", "STRING", "CLNT", "LANG", "UNIT", "CUKY"]);
const INT_TYPES = new Set(["I", "INT1", "INT2", "INT4", "INT8", "B", "S"]);
const DEC_TYPES = new Set(["P", "DEC", "CURR", "QUAN", "F", "FLTP"]);
const HEX_TYPES = new Set(["X", "RAW", "RAWSTRING"]);

/** Classifies a DDIC type (already upper-cased) into a literal-rendering family. Unrecognised types fall back to "char" — always quoted, never emitted bare. */
function columnGroup(type: string): ColumnGroup {
  if (type === "D") return "date";
  if (type === "T") return "time";
  if (INT_TYPES.has(type)) return "int";
  if (DEC_TYPES.has(type)) return "dec";
  if (HEX_TYPES.has(type)) return "hex";
  // CHAR_TYPES and anything unrecognised: quoted strings, the safe default.
  return "char";
}

function escapeAbapLiteral(cell: string): string {
  return cell.replace(/'/g, "''");
}

function quoted(cell: string): string {
  return `'${escapeAbapLiteral(cell)}'`;
}

/**
 * Moves a trailing sign to the front: `"0.94000-"` -> `"-0.94000"`.
 * ADT renders a negative numeric with a TRAILING minus (live: TCURR-UKURS =
 * "0.94000-"); ABAP needs it leading. A cell with no trailing `-` is returned
 * unchanged.
 */
function normaliseTrailingSign(trimmed: string): string {
  const m = /^(\d+(?:\.\d+)?)-$/.exec(trimmed);
  return m ? `-${m[1] ?? ""}` : trimmed;
}

/**
 * Renders one cell as an ABAP literal for `column`'s DDIC type. Exported for
 * unit tests. Never returns a bare `''` for a value it could not classify —
 * the unrecognised-type and malformed-digits paths both fall back to a
 * quoted copy of the raw cell rather than guessing.
 */
export function abapLiteralFor(column: PreviewColumn, cell: string): string {
  // Live SEOCLASSDF returned the integer-family type code LOWER-CASE ("b" for
  // INT1); upper-casing before the `columnGroup` lookup is required for that
  // capture to classify at all, not a cosmetic normalisation to "simplify" away.
  const type = (column.type || "").toUpperCase();
  const group = columnGroup(type);
  const trimmed = cell.trim();

  switch (group) {
    case "date": {
      const digits = cell.replace(/\D/g, "");
      return digits.length === 8 ? `'${digits}'` : quoted(cell);
    }
    case "time": {
      const digits = cell.replace(/\D/g, "");
      return digits.length === 6 ? `'${digits}'` : quoted(cell);
    }
    case "int": {
      const signed = normaliseTrailingSign(trimmed);
      return /^-?\d+$/.test(signed) ? signed : quoted(cell);
    }
    case "dec": {
      const signed = normaliseTrailingSign(trimmed);
      // Packed/currency/quantity/float literals are written QUOTED in ABAP source (`'12.50'`), never bare — that is deliberate, not a missed unquote.
      return /^-?\d+(\.\d+)?$/.test(signed) ? `'${signed}'` : quoted(cell);
    }
    case "hex":
      return quoted(cell);
    case "char":
    default:
      return quoted(cell);
  }
}

/** The initial-value literal for a MASKED non-character field — always emitted, since masking overrides the empty-cell omission rule below. Never `'0'` — bare `0` for numerics, matching ABAP's own initial value. */
function maskedInitialLiteral(group: ColumnGroup): string {
  switch (group) {
    case "int":
    case "dec":
      return "0";
    case "date":
      return "'00000000'";
    case "time":
      return "'000000'";
    case "hex":
    default:
      return "''";
  }
}

// ------------------------------------------------------------- column order ---

interface EffectiveColumn {
  readonly column: PreviewColumn;
  /** Index into `result.columns` / each row's cell array — the DDIC (wire) position, independent of display order. */
  readonly index: number;
}

/**
 * Effective field order: `columnOrder` (the caller's `columns` argument) when
 * given, else DDIC order. Compared case-insensitively; a name in
 * `columnOrder` that is not a real column is silently dropped — the preview
 * itself already refused unknown fields before any row was fetched, so this
 * is not the place to re-litigate that.
 */
function resolveColumns(
  result: PreviewResult,
  columnOrder: readonly string[] | undefined,
): EffectiveColumn[] {
  if (columnOrder === undefined || columnOrder.length === 0) {
    return result.columns.map((column, index) => ({ column, index }));
  }
  const byUpperName = new Map<string, EffectiveColumn>();
  result.columns.forEach((column, index) => {
    byUpperName.set(column.name.toUpperCase(), { column, index });
  });
  const out: EffectiveColumn[] = [];
  for (const name of columnOrder) {
    const hit = byUpperName.get(name.toUpperCase());
    if (hit) out.push(hit);
  }
  return out;
}

// ------------------------------------------------------------------- rows ---

interface FieldPair {
  readonly name: string;
  readonly literal: string;
}

/**
 * One row's `field = literal` pairs, in `columns` order.
 *
 * A masked field always wins over the cell it would otherwise render, and is
 * always emitted — never omitted: character-like columns become `'MASKED'`;
 * every other type becomes its initial value. This is deliberate, not the
 * same "omit an empty, non-key cell" rule applied below: see the comment at
 * the mask check for why.
 */
function buildRowFields(
  columns: readonly EffectiveColumn[],
  cells: readonly string[],
  maskedUpper: ReadonlySet<string>,
): { fields: FieldPair[]; omitted: boolean } {
  const fields: FieldPair[] = [];
  let omitted = false;

  for (const { column, index } of columns) {
    const name = column.name.toLowerCase();
    // Same live observation as abapLiteralFor: the wire type code arrives
    // lower-cased for the integer family, so this upper-case is load-bearing.
    const group = columnGroup((column.type || "").toUpperCase());

    // Masking is decided BEFORE the empty-cell check and always wins over
    // it. Omission below is a statement about the source cell being empty;
    // a masked field's source value is thrown away on purpose, so the
    // renderer has no honest basis for calling it "empty" — it must always
    // emit the mask literal instead, key or not.
    if (maskedUpper.has(column.name.toUpperCase())) {
      const literal = group === "char" ? `'${MASK_TEXT}'` : maskedInitialLiteral(group);
      fields.push({ name, literal });
      continue;
    }

    const cell = cells[index] ?? "";
    if (cell.trim() === "" && !column.key) {
      omitted = true;
      continue;
    }
    fields.push({ name, literal: abapLiteralFor(column, cell) });
  }

  return { fields, omitted };
}

/**
 * Renders one `( field = literal ... )` row group at `indent`, wrapping
 * across several lines when the single-line form would exceed
 * `ABAP_LINE_MAX`. This is a WRAP, not a cut: every field that goes in still
 * comes out, just on a later line — the row group simply continues below.
 * `longFieldNoted` dedupes the "too long on its own" note per field name so
 * one oversized column across many rows produces one note, not one per row.
 */
function renderRowGroup(
  fields: readonly FieldPair[],
  indent: string,
  longFieldNotes: string[],
  longFieldNoted: Set<string>,
): string {
  const pairs = fields.map((f) => ({ name: f.name, text: `${f.name} = ${f.literal}` }));
  const singleLine = `${indent}( ${pairs.map((p) => p.text).join(" ")} )`;
  if (singleLine.length <= ABAP_LINE_MAX) return singleLine;

  const contIndent = `${indent}  `;
  const lines: string[] = [`${indent}(`];
  let current: string[] = [];
  let currentLen = 0;

  const flush = (): void => {
    if (current.length) {
      lines.push(`${contIndent}${current.join(" ")}`);
      current = [];
      currentLen = 0;
    }
  };

  for (const p of pairs) {
    const soloLen = contIndent.length + p.text.length;
    if (soloLen > ABAP_LINE_MAX) {
      flush();
      lines.push(`${contIndent}${p.text}`);
      if (!longFieldNoted.has(p.name)) {
        longFieldNoted.add(p.name);
        longFieldNotes.push(
          `Field ${p.name} produces an ABAP literal longer than 255 characters on its own; the ` +
            "emitted line exceeds ABAP's source line limit and must be shortened by hand.",
        );
      }
      continue;
    }
    const addedLen = current.length ? currentLen + 1 + p.text.length : p.text.length;
    if (contIndent.length + addedLen > ABAP_LINE_MAX) {
      flush();
      current = [p.text];
      currentLen = p.text.length;
    } else {
      current.push(p.text);
      currentLen = addedLen;
    }
  }
  flush();
  lines.push(`${indent})`);
  return lines.join("\n");
}

/**
 * Builds the `TYPES ty_rows ... / DATA(lt_rows) = VALUE ty_rows( ... ).`
 * block shared by both renderers, at `indent` (row groups nest two spaces
 * further in). Returns `anyOmitted` so the caller can decide whether to
 * append the "empty cells are omitted" note.
 */
function buildValueLiteralLines(
  entity: string,
  columns: readonly EffectiveColumn[],
  rows: readonly string[][],
  maskedUpper: ReadonlySet<string>,
  indent: string,
  longFieldNotes: string[],
  longFieldNoted: Set<string>,
): { lines: string[]; anyOmitted: boolean } {
  const typeLine = `${indent}TYPES ty_rows TYPE STANDARD TABLE OF ${entity} WITH EMPTY KEY.`;
  if (rows.length === 0) {
    return {
      lines: [typeLine, `${indent}DATA(lt_rows) = VALUE ty_rows( ).`],
      anyOmitted: false,
    };
  }

  let anyOmitted = false;
  const groupIndent = `${indent}  `;
  const groupLines: string[] = [];
  for (const cells of rows) {
    const { fields, omitted } = buildRowFields(columns, cells, maskedUpper);
    if (omitted) anyOmitted = true;
    groupLines.push(renderRowGroup(fields, groupIndent, longFieldNotes, longFieldNoted));
  }

  return {
    lines: [typeLine, `${indent}DATA(lt_rows) = VALUE ty_rows(`, ...groupLines, `${indent}).`],
    anyOmitted,
  };
}

const EMPTY_CELLS_OMITTED_NOTE =
  "Empty cells are omitted from the VALUE literal (ABAP fills them with the type's initial " +
  "value); key fields are always emitted.";

/**
 * Live A4H captures (DD02L, TCURR, SEOCLASSDF — issue #115 follow-up) all
 * reported `keyAttribute="false"` for every column, including genuine
 * primary-key fields such as DD02L-TABNAME and TCURR-MANDT. The "omitted
 * unless key" rule above is still correct when the metadata is honest, but
 * against a real response it almost never treats anything as a key — so this
 * note is pushed right after it whenever at least one cell was omitted.
 */
const KEY_METADATA_UNRELIABLE_NOTE =
  "The ADT data preview reports no key attribute for most entities, so few or no fields qualify " +
  "as keys here: an omitted cell is an initial value in the fixture, which is not always the " +
  "same as the row's real state.";

function normaliseMaskUpper(maskedFields: readonly string[]): ReadonlySet<string> {
  return new Set(maskedFields.map((f) => f.toUpperCase()));
}

// -------------------------------------------------------------- renderers ---

/**
 * Renders the previewed rows as one typed `VALUE #( ... )` literal for the
 * entity's line type — nothing but the literal, no test scaffolding around
 * it (see `renderTestDouble` for that).
 */
export function renderAbapValue(input: FixtureRenderInput): FixtureRender {
  const { result, maskedFields, columnOrder } = input;
  const notes: string[] = [SHARED_NOTE];
  const maskedUpper = normaliseMaskUpper(maskedFields);
  const columns = resolveColumns(result, columnOrder);
  const entity = result.table.toLowerCase();

  if (result.rows.length === 0) {
    notes.push("The preview returned no rows, so the VALUE literal below is empty.");
    return {
      text: [
        `TYPES ty_rows TYPE STANDARD TABLE OF ${entity} WITH EMPTY KEY.`,
        "DATA(lt_rows) = VALUE ty_rows( ).",
      ].join("\n"),
      notes,
      fixtureKind: "literal_only",
    };
  }

  const longFieldNotes: string[] = [];
  const longFieldNoted = new Set<string>();
  const { lines, anyOmitted } = buildValueLiteralLines(
    entity,
    columns,
    result.rows,
    maskedUpper,
    "",
    longFieldNotes,
    longFieldNoted,
  );
  if (anyOmitted) notes.push(EMPTY_CELLS_OMITTED_NOTE, KEY_METADATA_UNRELIABLE_NOTE);
  notes.push(...longFieldNotes);

  return { text: lines.join("\n"), notes, fixtureKind: "literal_only" };
}

/**
 * Wraps the same `VALUE #( ... )` literal in a ready-to-paste
 * `cl_osql_test_environment` fixture (`class_setup`/`class_teardown`).
 * `abap_data_preview` only ever reads a transparent table, a database/
 * projection view or a parameterless CDS view — the only entity kinds the
 * endpoint accepts — so this shape is always correct; there is no other
 * entity-kind signal on `PreviewResult` to branch on, and none is needed.
 */
export function renderTestDouble(input: FixtureRenderInput): FixtureRender {
  const { result, maskedFields, columnOrder } = input;
  const notes: string[] = [SHARED_NOTE, TEST_DOUBLE_NOTE];
  const maskedUpper = normaliseMaskUpper(maskedFields);
  const columns = resolveColumns(result, columnOrder);
  const entity = result.table.toLowerCase();
  const entityUpper = result.table.toUpperCase();

  let literalLines: string[];
  let anyOmitted = false;
  const longFieldNotes: string[] = [];
  const longFieldNoted = new Set<string>();

  if (result.rows.length === 0) {
    literalLines = [
      `  TYPES ty_rows TYPE STANDARD TABLE OF ${entity} WITH EMPTY KEY.`,
      "  DATA(lt_rows) = VALUE ty_rows( ).",
    ];
    notes.push("The preview returned no rows, so the VALUE literal inside the fixture is empty.");
  } else {
    const built = buildValueLiteralLines(
      entity,
      columns,
      result.rows,
      maskedUpper,
      "  ",
      longFieldNotes,
      longFieldNoted,
    );
    literalLines = built.lines;
    anyOmitted = built.anyOmitted;
  }
  if (anyOmitted) notes.push(EMPTY_CELLS_OMITTED_NOTE, KEY_METADATA_UNRELIABLE_NOTE);
  notes.push(...longFieldNotes);

  const text = [
    '" Paste into your test class. Requires CLASS ... FOR TESTING RISK LEVEL HARMLESS.',
    "CLASS-DATA go_osql TYPE REF TO if_osql_test_environment.",
    "",
    "METHOD class_setup.",
    `  go_osql = cl_osql_test_environment=>create( VALUE #( ( '${entityUpper}' ) ) ).`,
    ...literalLines,
    "  go_osql->insert_test_data( lt_rows ).",
    "ENDMETHOD.",
    "",
    "METHOD class_teardown.",
    "  go_osql->destroy( ).",
    "ENDMETHOD.",
  ].join("\n");

  return { text, notes, fixtureKind: "osql_test_environment" };
}
