/**
 * Read-only re-read of a table's secondary DDIC indexes (`TABL/DI`), over
 * `DD12V` (index header) and `DD17S` (index field) — the same two catalog
 * tables SE11's Indexes tab itself reads. **No ABAP is deployed and nothing
 * is written**: every fact here comes from a plain-text `SELECT` through
 * `AbapConnection.dataPreviewFreestyle` via `catalog-select.ts`, exactly
 * like `src/adt/suso-read.ts` (issue #87) and `src/adt/img-read.ts`.
 *
 * Why this module exists (issue #86): ADT REST has no working resource for
 * a table's secondary indexes (`src/adt/index-create.ts`'s header — 404 on
 * `GET .../ddic/tables/t000/indexes`), so the create/delete bridge in that
 * file goes through `DD_INDEX_INTERFACE` and could previously only report
 * `verified: false`, passing an `ACTFAILED` flag through as unexplained
 * noise. This module gives that bridge (and `abap_read`) a definitive
 * answer instead: re-read DD12V/DD17S and say what is actually there.
 *
 * Live facts this module encodes, all measured on A4H 2026-09-12 (see
 * `test/fixtures/live-captured/858`, `859`, `860`):
 *   - capture 858 (`SELECT * FROM dd12v WHERE sqltab = 'BDSLORE10'`, 200,
 *     `totalRows` 4): DD12V is LANGUAGE-DEPENDENT — it carries `DDLANGUAGE`,
 *     so one index yields one row per maintained language. A reader that
 *     does not dedupe by `INDEXNAME` reports the same index several times;
 *     `readTableIndexes` dedupes, preferring the row whose `DDLANGUAGE`
 *     matches the requested language, and notes when it had to.
 *   - capture 859 (`SELECT * FROM dd17s WHERE sqltab = 'BDSLORE10'`, 200,
 *     `totalRows` 2): DD17S is NOT language-dependent. `POSITION` gives
 *     field order inside the index and arrives as a zero-padded numeric
 *     string ("0001") — parsed with `Number(...)`, never string-sorted.
 *   - capture 860 (`SELECT * FROM dd12v WHERE sqltab = 'TADIR'`, 200,
 *     `totalRows` 0): the negative control. An absent index is an empty,
 *     well-formed result (HTTP 200, zero rows) — NOT an error — which is
 *     exactly what makes a definitive "index absent" verdict possible.
 *   - `AS4LOCAL` is the activation status: `'A'` active, `'N'` inactive/new
 *     revision, observed blank in a "does not exist" row shape. `UNIQUEFLAG`
 *     non-blank means unique. `DBSTATE` is the index's database status.
 *     `DDTEXT` is the index's short text.
 *   - the freestyle endpoint answers HTTP 400 (not an empty result) for a
 *     literal wider than the target column's declared DDIC width — see
 *     `catalog-select.ts`'s own header — so `DD12V-SQLTAB` (`C(30)`) and
 *     `DD12V-INDEXNAME` (`C(3)`) are length-checked client-side before any
 *     SQL is built (`INDEX_TABLE_NAME_MAX`, `INDEX_ID_MAX`).
 *
 * `readTableIndexes`/`readSecondaryIndex` never throw for "no such index" —
 * an empty `indexes` array (or an `undefined` single index) is a real,
 * reported state. `verifySecondaryIndex` goes one step further: it never
 * throws at all, not even on a failed re-read — see its own doc comment.
 */
import type { AbapConnection } from "./connection.js";
import type { DdicRender } from "./ddic.js";
import { textTable } from "../compact.js";
import type { CatalogResult, CatalogRow } from "./catalog-select.js";
import { AbapError } from "./errors.js";

// -------------------------------------------------------------- catalog ---

/**
 * `./catalog-select.js`'s value exports (`buildCatalogSelect`, `catalogLiteral`,
 * `requireCatalogColumn`, `runCatalogSelect`) are loaded with a dynamic
 * `import()` here instead of a static top-level import, and cached after the
 * first call — deliberately, not for laziness's own sake. `catalog-select.ts`
 * imports `./datapreview.js`, which imports `./connection.js` for real (not
 * just types), which imports `../config.js`, which imports `../safety.js`,
 * which imports `./capabilities.js` — and `capabilities.ts` runs an eager
 * module-top-level self-check that calls back into `./ddic.ts`. `ddic.ts`
 * imports this file, so a static import here would close that chain into a
 * real cycle back to `ddic.ts`; when `ddic.ts` is the first module Node
 * loads, the cycle re-enters `capabilities.ts` before `ddic.ts`'s own
 * `DDIC_SOURCE_BASED` export has initialized, throwing `ReferenceError:
 * Cannot access 'DDIC_SOURCE_BASED' before initialization` at import time. A
 * dynamic `import()` defers loading `catalog-select.ts` (and that whole
 * chain) until `readTableIndexes` actually runs, well after `ddic.ts` has
 * finished initializing — so it never observes the cycle. Keep this
 * dynamic; turning it back into a static import reintroduces the crash.
 */
let catalogSelectModule: Promise<typeof import("./catalog-select.js")> | undefined;
function loadCatalogSelect(): Promise<typeof import("./catalog-select.js")> {
  return (catalogSelectModule ??= import("./catalog-select.js"));
}

export type IndexCatalogConfidence = "high" | "low";

export interface IndexCatalogTable {
  readonly table: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly confidence: IndexCatalogConfidence;
  readonly note: string;
}

/**
 * The two catalog tables this module reads, in the same frozen shape
 * `img-catalog.ts`/`suso-read.ts`'s `SUSO_CATALOG` use. Both entries are
 * `confidence: "high"` — read live on A4H 2026-09-12, captures cited below.
 */
export const INDEX_CATALOG = Object.freeze({
  indexHeader: Object.freeze({
    table: "DD12V",
    fields: Object.freeze({
      table: "SQLTAB",
      index: "INDEXNAME",
      language: "DDLANGUAGE",
      unique: "UNIQUEFLAG",
      activation: "AS4LOCAL",
      dbState: "DBSTATE",
      description: "DDTEXT",
    }),
    confidence: "high",
    note:
      "capture 858: language-dependent (DDLANGUAGE) — one row per maintained language per index, " +
      "must be deduped by INDEXNAME. capture 860: a table with no secondary index answers 200 with " +
      "totalRows 0, a definitive absence, not an error.",
  }),
  indexField: Object.freeze({
    table: "DD17S",
    fields: Object.freeze({
      table: "SQLTAB",
      index: "INDEXNAME",
      position: "POSITION",
      field: "FIELDNAME",
    }),
    confidence: "high",
    note:
      "capture 859: not language-dependent. POSITION is a zero-padded numeric string (e.g. \"0001\") " +
      "— parse with Number(), never string-sort it.",
  }),
} satisfies Record<string, IndexCatalogTable>);

type IndexCatalogKey = keyof typeof INDEX_CATALOG;

function tbl<K extends IndexCatalogKey>(key: K): string {
  return INDEX_CATALOG[key].table;
}

function fld<K extends IndexCatalogKey, F extends keyof (typeof INDEX_CATALOG)[K]["fields"]>(key: K, field: F): string {
  const fields = INDEX_CATALOG[key].fields as Record<F, string>;
  return fields[field];
}

// -------------------------------------------------------------- tuning ---

/** `DD12V-SQLTAB` is `C(30)` — a literal over this gets HTTP 400 from the endpoint, not an empty result. */
export const INDEX_TABLE_NAME_MAX = 30;

/** `DD12V-INDEXNAME` is `C(3)` — same reason. Matches `index-create.ts`'s `INDEX_NAME_MAX`. */
export const INDEX_ID_MAX = 3;

/**
 * Row ceiling for each catalog query this module issues. Not a caller-facing
 * page size — one table's own secondary indexes and their fields are small
 * and bounded in practice; this exists only so an unexpectedly large result
 * is still a single bounded statement, and any cut is disclosed via `notes`
 * rather than silently sliced (`test/no-silent-truncation.test.ts`).
 */
export const INDEX_ROW_CAP = 200;

/** DD12V-DDLANGUAGE default when a caller does not name one — same default `img-query.ts`/`suso-read.ts` use. */
const DEFAULT_LANGUAGE = "E";

/**
 * `table`/`indexId` are validated as ABAP/DDIC identifiers (a letter, then
 * letters/digits/underscores, length-capped) — the same rule and the same
 * shape `index-create.ts` already applies to `baseTable`/`indexName` on the
 * create/delete path (there via `assertEnhIdentifier`), so a name accepted
 * there is accepted here too, and vice versa. This is strictly narrower than
 * `catalog-select.ts`'s generic `assertCatalogValue` (arbitrary non-quote,
 * non-control text up to a length), so it is used here instead of that
 * generic gate; `catalogLiteral` still quotes the resulting value exactly
 * as every other `catalog-select.ts` caller does.
 *
 * This is a LOCAL copy of `../safety.ts`'s `isValidAbapIdentifier`/
 * `./enhancement-templates.ts`'s `assertEnhIdentifier`, not an import of
 * either: `enhancement-templates.ts` imports `../safety.ts`, which imports
 * `./capabilities.ts` — and `capabilities.ts` runs an eager module-top-level
 * self-check that calls back into `./ddic.ts`. `ddic.ts` imports this file,
 * so that edge would close a cycle back through `capabilities.ts` into
 * `ddic.ts`; when `ddic.ts` loads first, the re-entrant call reaches
 * `capabilities.ts` before `ddic.ts`'s own `DDIC_SOURCE_BASED` export has
 * initialized, and Node throws `ReferenceError: Cannot access
 * 'DDIC_SOURCE_BASED' before initialization`. Keep this local; importing
 * `assertEnhIdentifier` here instead would reintroduce that crash.
 */
function isValidIndexIdentifier(name: string, maxLength: number): boolean {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > maxLength) return false;
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

function assertIndexIdentifier(value: string, what: string, maxLength: number): string {
  if (typeof value !== "string" || !isValidIndexIdentifier(value, maxLength)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} ${JSON.stringify(value)} is not a valid ABAP object name (a letter, then letters, ` +
        `digits and underscores only, max ${maxLength} characters).`,
      { what, value },
      "This value is substituted into a catalog SELECT's WHERE literal — an over-long or malformed " +
        "name is refused client-side, before any SQL literal is built, rather than sent to the " +
        "freestyle endpoint, which answers HTTP 400 (not an empty result) for a literal wider than " +
        "the target column's declared DDIC width.",
    );
  }
  return value;
}

function assertIndexTableName(value: string): string {
  return assertIndexIdentifier(value, "table", INDEX_TABLE_NAME_MAX);
}

function assertIndexIdValue(value: string): string {
  return assertIndexIdentifier(value, "indexId", INDEX_ID_MAX);
}

function serverNotes(result: CatalogResult): string[] {
  return result.messages.map((m) => `[server] ${m.text}${m.severity ? ` (${m.severity})` : ""}`);
}

function noteIfCut(result: CatalogResult, cap: number, what: string, notes: string[]): void {
  if (result.totalRows !== undefined && result.totalRows > result.rows.length) {
    notes.push(
      `${what} reports ${result.totalRows} total rows but only ${result.rows.length} were fetched ` +
        `(row cap ${cap}) — the remainder was cut, not silently dropped.`,
    );
  }
}

function activationLabel(activation: string): string {
  switch (activation) {
    case "A":
      return "active";
    case "N":
      return "inactive (revised, not activated)";
    case "":
      return "unknown (blank AS4LOCAL)";
    default:
      return `unrecognized (AS4LOCAL = ${JSON.stringify(activation)})`;
  }
}

// ---------------------------------------------------------------- shapes ---

export interface SecondaryIndexInfo {
  /** The 3-character index id, e.g. "Z01". */
  readonly id: string;
  /** The table it belongs to. */
  readonly table: string;
  readonly description: string;
  readonly unique: boolean;
  /** Raw DD12V-AS4LOCAL, e.g. "A". */
  readonly activation: string;
  /** Plain-language reading of `activation`, e.g. "active" / "inactive (revised, not activated)". */
  readonly activationLabel: string;
  /** Raw DD12V-DBSTATE. */
  readonly dbState: string;
  /** Field names in DD17S-POSITION order. */
  readonly fields: readonly string[];
}

// ----------------------------------------------------------------- read ---

/**
 * Every secondary index of `table`, in index-id order, with fields in
 * position order. An empty array means the table genuinely has no secondary
 * index (DD12V answered 200 with zero rows — see capture 860) — not that
 * the read failed or was skipped.
 *
 * Runs exactly two SELECTs: DD12V filtered by SQLTAB, then DD17S filtered
 * by SQLTAB. DD12V rows are grouped/deduped by INDEXNAME (one row per
 * maintained language on the wire — see `INDEX_CATALOG.indexHeader`'s
 * note), preferring the row whose DDLANGUAGE matches `opts.language ??
 * "E"`, else the first row seen; a note is added whenever dedup actually
 * dropped a row, so that behaviour is visible rather than silent. DD17S
 * rows are grouped by INDEXNAME and sorted by POSITION, parsed with
 * `Number(...)` (POSITION is a zero-padded numeric string on the wire, see
 * capture 859) — never string-sorted.
 */
export async function readTableIndexes(
  conn: AbapConnection,
  table: string,
  opts?: { language?: string },
): Promise<{ indexes: readonly SecondaryIndexInfo[]; notes: readonly string[] }> {
  const { buildCatalogSelect, catalogLiteral, requireCatalogColumn, runCatalogSelect } =
    await loadCatalogSelect();
  const notes: string[] = [];
  const t = assertIndexTableName(table.trim().toUpperCase());
  const language = (opts?.language ?? DEFAULT_LANGUAGE).trim().toUpperCase() || DEFAULT_LANGUAGE;

  // ---- 1. DD12V (index headers) ----
  const TABLE_F = fld("indexHeader", "table");
  const INDEX_F = fld("indexHeader", "index");
  const headerSql = buildCatalogSelect(
    [TABLE_F, INDEX_F, fld("indexHeader", "language"), fld("indexHeader", "unique"), fld("indexHeader", "activation"), fld("indexHeader", "dbState"), fld("indexHeader", "description")].join(", "),
    tbl("indexHeader"),
    [`${TABLE_F} = ${catalogLiteral(t)}`],
    INDEX_F,
  );
  const headerResult = await runCatalogSelect(conn, headerSql, INDEX_ROW_CAP);
  notes.push(...serverNotes(headerResult));
  noteIfCut(headerResult, INDEX_ROW_CAP, `${tbl("indexHeader")} lookup for "${t}"`, notes);
  if (headerResult.rows.length > 0) requireCatalogColumn(headerResult, INDEX_F);

  // Dedupe by INDEXNAME: prefer the row in the requested language, else the first row seen.
  const byIndex = new Map<string, CatalogRow>();
  let dedupedAny = false;
  for (const row of headerResult.rows) {
    const id = row[INDEX_F] ?? "";
    if (id === "") continue;
    const existing = byIndex.get(id);
    if (existing === undefined) {
      byIndex.set(id, row);
      continue;
    }
    dedupedAny = true;
    const rowLanguage = (row[fld("indexHeader", "language")] ?? "").trim().toUpperCase();
    if (rowLanguage === language) byIndex.set(id, row);
  }
  if (dedupedAny) {
    notes.push(
      `${tbl("indexHeader")} carried more than one row per index (language-dependent — see ` +
        `INDEX_CATALOG note): reduced to one row per index, preferring DDLANGUAGE = "${language}".`,
    );
  }

  // ---- 2. DD17S (index fields) ----
  const FTABLE_F = fld("indexField", "table");
  const FINDEX_F = fld("indexField", "index");
  const fieldSql = buildCatalogSelect(
    [FTABLE_F, FINDEX_F, fld("indexField", "position"), fld("indexField", "field")].join(", "),
    tbl("indexField"),
    [`${FTABLE_F} = ${catalogLiteral(t)}`],
    FINDEX_F,
  );
  const fieldResult = await runCatalogSelect(conn, fieldSql, INDEX_ROW_CAP);
  notes.push(...serverNotes(fieldResult));
  noteIfCut(fieldResult, INDEX_ROW_CAP, `${tbl("indexField")} lookup for "${t}"`, notes);
  if (fieldResult.rows.length > 0) requireCatalogColumn(fieldResult, FINDEX_F);

  const fieldsByIndex = new Map<string, Array<{ position: number; field: string }>>();
  for (const row of fieldResult.rows) {
    const id = row[FINDEX_F] ?? "";
    if (id === "") continue;
    // POSITION is a zero-padded numeric string ("0001") on the wire — Number() parses it correctly;
    // a plain string sort would put "0010" before "0002".
    const position = Number(row[fld("indexField", "position")] ?? "0");
    const field = row[fld("indexField", "field")] ?? "";
    const list = fieldsByIndex.get(id);
    const entry = { position: Number.isNaN(position) ? 0 : position, field };
    if (list) list.push(entry);
    else fieldsByIndex.set(id, [entry]);
  }
  for (const list of fieldsByIndex.values()) list.sort((a, b) => a.position - b.position);

  const indexes: SecondaryIndexInfo[] = [...byIndex.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, row]) => {
      const activation = row[fld("indexHeader", "activation")] ?? "";
      return {
        id,
        table: t,
        description: row[fld("indexHeader", "description")] ?? "",
        unique: (row[fld("indexHeader", "unique")] ?? "").trim() !== "",
        activation,
        activationLabel: activationLabel(activation),
        dbState: row[fld("indexHeader", "dbState")] ?? "",
        fields: (fieldsByIndex.get(id) ?? []).map((f) => f.field),
      };
    });

  return { indexes, notes };
}

/**
 * One index. `index: undefined` means it is definitively absent (DD12V has
 * no row for this id on this table), not that the read failed. `indexes` is
 * every secondary index of the table (as `readTableIndexes` returned it), so
 * a caller can name the indexes that DO exist when `index` is undefined.
 *
 * Reuses `readTableIndexes` and filters, rather than running its own
 * narrower `WHERE ... AND INDEXNAME = ...` queries: a table's full index
 * set is already a small, bounded, two-statement read, so a narrower query
 * would only ever save bytes on a table with an unusually large number of
 * indexes, at the cost of re-deriving the dedup/grouping logic above a
 * second time. If that trade-off ever changes, narrowing the SQL here
 * rather than filtering after the fact is the place to do it.
 */
export async function readSecondaryIndex(
  conn: AbapConnection,
  table: string,
  indexId: string,
  opts?: { language?: string },
): Promise<{ index?: SecondaryIndexInfo; indexes: readonly SecondaryIndexInfo[]; notes: readonly string[] }> {
  const id = assertIndexIdValue(indexId.trim().toUpperCase());
  const { indexes, notes } = await readTableIndexes(conn, table, opts);
  const index = indexes.find((i) => i.id === id);
  return { index, indexes, notes };
}

// -------------------------------------------------------------- verdict ---

/**
 * The verification verdict used by the create and delete bridges
 * (`src/adt/index-create.ts`). Never throws for an absent index — absence
 * IS a verdict, not a failure.
 */
export interface IndexVerdict {
  readonly verified: boolean;
  readonly present: boolean;
  readonly active: boolean;
  /** One sentence stating the verdict in the words the response should carry. */
  readonly statement: string;
  /** Populated when `verified` is false: why the catalog re-read could not settle it. */
  readonly reason?: string;
  readonly index?: SecondaryIndexInfo;
}

/**
 * Re-reads DD12V/DD17S and returns a verdict — never throws. A bad
 * `table`/`indexId` (BAD_INPUT from `assertIndexIdentifier`) and a genuine
 * connection/read failure both land as `verified: false` with `reason` set,
 * exactly like a settled "present"/"absent" verdict lands as
 * `verified: true`. This is deliberate: a caller (the create/delete bridge)
 * that only checked `verified` before would otherwise have to wrap this
 * call in its own try/catch to get the same guarantee.
 */
export async function verifySecondaryIndex(
  conn: AbapConnection,
  table: string,
  indexId: string,
  expect: "present" | "absent",
): Promise<IndexVerdict> {
  try {
    const id = assertIndexIdValue(indexId.trim().toUpperCase());
    const t = assertIndexTableName(table.trim().toUpperCase());
    const { index } = await readSecondaryIndex(conn, t, id);

    if (index === undefined) {
      const mismatch = expect === "present" ? " — expected present, but the catalog shows no such row." : "";
      return {
        verified: true,
        present: false,
        active: false,
        statement: `index ${id} on ${t} is absent from DD12V${mismatch}`,
      };
    }

    const active = index.activation === "A";
    const fieldsClause = index.fields.length > 0 ? `, with fields ${index.fields.join(", ")}` : ", with no fields on record";
    const mismatch = expect === "absent" ? " — expected absent, but the catalog still shows it." : "";
    const statement =
      `index ${id} on ${t} is present and ${active ? "active" : `inactive (${index.activationLabel})`} ` +
      `(DD12V-AS4LOCAL = '${index.activation}')${fieldsClause}${mismatch}`;

    return { verified: true, present: true, active, statement, index };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      verified: false,
      present: false,
      active: false,
      statement: `could not verify index ${indexId} on ${table}: the DD12V/DD17S re-read itself failed (${reason}).`,
      reason,
    };
  }
}

// --------------------------------------------------------------- render ---

/** Renders the `indexes` section that the `TABL/DT` DDIC read appends after the field list. */
export function renderIndexSection(indexes: readonly SecondaryIndexInfo[]): { title: string; content: string } {
  const title = "SECONDARY INDEXES";
  if (indexes.length === 0) {
    return {
      title,
      content:
        "This table has no secondary index — a DD12V read for this table returned zero rows " +
        "(a definitive empty result, see capture 860), not an unread or failed check.",
    };
  }
  const content = textTable(
    indexes.map((i) => ({
      index: i.id,
      unique: i.unique ? "UNIQUE" : "",
      status: i.activationLabel,
      "db status": i.dbState,
      fields: i.fields.join(", "),
      description: i.description,
    })),
    ["index", "unique", "status", "db status", "fields", "description"],
  );
  return { title, content };
}

/** The `define index ... on ... { ... }` DDL block for one index. */
function indexDdl(index: SecondaryIndexInfo): string {
  return [
    `define index ${index.id.toLowerCase()} on ${index.table.toLowerCase()} {`,
    ...index.fields.map((f) => `  ${f.toLowerCase()};`),
    `}`,
  ].join("\n");
}

// Hashed as a composite of every attribute this render reflects (not just the DDL, which only
// carries the field list): a change to e.g. DBSTATE or activation with the same field list
// would otherwise leave the etag unchanged.
function indexHashInput(index: SecondaryIndexInfo): string {
  return [
    index.table,
    index.id,
    index.description,
    index.unique ? "UNIQUE" : "",
    index.activation,
    index.dbState,
    ...index.fields,
  ].join("|");
}

/** Renders a single `TABL/DI` read as a `DdicRender` for `abap_read`. */
export function renderSecondaryIndex(index: SecondaryIndexInfo): DdicRender {
  const sections: Array<{ title: string; content: string }> = [
    {
      title: "INDEX HEADER",
      content: textTable(
        [
          {
            table: index.table,
            index: index.id,
            unique: index.unique ? "UNIQUE" : "",
            status: index.activationLabel,
            "db status": index.dbState,
            description: index.description,
          },
        ],
        ["table", "index", "unique", "status", "db status", "description"],
      ),
    },
  ];

  return {
    ddl: indexDdl(index),
    sections,
    meta: {
      table: index.table,
      index: index.id,
      unique: index.unique ? "true" : "false",
      activation: index.activation,
      db_status: index.dbState,
      fields: index.fields.length,
    },
    notes: [],
    hashInput: indexHashInput(index),
  };
}

/**
 * Renders the bare-`<TABLE>` `TABL/DI` listing (every secondary index of the
 * table) as a `DdicRender` for `abap_read`. An empty `indexes` array is a
 * definitive "no secondary index" answer, not an error — see `renderIndexSection`.
 */
export function renderSecondaryIndexList(table: string, indexes: readonly SecondaryIndexInfo[]): DdicRender {
  const t = table.toUpperCase();
  const ddl = indexes.length > 0 ? indexes.map((i) => indexDdl(i)).join("\n\n") : `// ${t} has no secondary index`;

  return {
    ddl,
    sections: [renderIndexSection(indexes)],
    meta: {
      table: t,
      indexes: indexes.length,
    },
    notes: [],
    hashInput: [t, ...indexes.map((i) => indexHashInput(i))].join("\n"),
  };
}
