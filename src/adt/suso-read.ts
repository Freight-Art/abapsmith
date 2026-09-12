/**
 * Read-only render of one SAP authorization object (`SUSO/B`), assembled
 * from catalog tables only. **No ABAP is deployed and nothing is written.**
 *
 * This renders the DEFINITION of an authorization object — its class, its
 * text, its fields and the activities the object permits. It is metadata
 * about the authorization *concept*. It is NOT a view of who holds which
 * authorizations: this module never reads `AGR_*` (role) or `UST*` (user
 * authorization) tables, and no argument makes it do so. Write support for
 * `SUSO/B` does not exist and is not planned — `SU21` is the only way to
 * EDIT an authorization object.
 *
 * Where the metadata actually lives, with live corrections observed on A4H
 * 2026-09-12 (see `test/fixtures/live-captured/861-*`, `862-*`, `873-*` and
 * neighbouring captures for the raw responses these facts were read from):
 *   - `TOBJ` — the object itself. Key column `OBJCT` (NOT `OBJECT` — that
 *     name belongs to `TOBJT`'s key below). Field slots are `FIEL1`..`FIEL9`
 *     then **`FIEL0`** — there is no `FIEL10`. Also carries `OCLSS` (object
 *     class), `BNAME`, `FBLOCK`, `CONVERSION`. `OBJCT` is `C(10)`, so an
 *     object name over 10 characters is refused client-side before it ever
 *     reaches the server (capture 861: `SELECT * FROM tobj WHERE objct =
 *     'Z_I87_NO_SUCH_OBJ'` answered HTTP 400 "... is not a valid value for
 *     C(10,0)", not an empty result — see `catalog-select.ts`'s own header).
 *   - `TOBJT` — the object's text. Key column **`OBJECT`** (not `OBJCT` —
 *     the two tables name their own key column differently), plus `LANGU`,
 *     `TTEXT`. Language-dependent: filter by language.
 *   - `TOBCT` — the object CLASS text: `LANGU`, `OCLSS`, `CTEXT`.
 *   - `TACTZ` — the activities the object permits: `BROBJ`, `ACTVT`. No
 *     texts of its own.
 *   - `TACTT` — the activity texts: `SPRAS`, `ACTVT`, `LTEXT`. Issue #87
 *     names the table `TACT`; the texts actually live in `TACTT` (capture
 *     862).
 *   - `AUTHX` — per-FIELD metadata: `FIELDNAME`, `ROLLNAME`, `CHECKTABLE`,
 *     `EXIT_FB`, `ACTVT_FLAG`. A field's data element and check table come
 *     from here, not from `TOBJ` (`TOBJ` only names the field, it does not
 *     type it).
 *   - `DD04L` — data element to domain: `ROLLNAME`, `DOMNAME`, `DATATYPE`,
 *     `LENG`. A name in `AUTHX.ROLLNAME` is not guaranteed to have a
 *     `DD04L` row (capture 873 shows a field with a `ROLLNAME` that has no
 *     matching `DD04L` row) — tolerate a missing one, do not treat it as an
 *     error.
 *   - `DD07V` — a domain's fixed values: `DOMNAME`, `VALPOS`, `DDLANGUAGE`,
 *     `DOMVALUE_L`, `DOMVALUE_H`, `DDTEXT`. **`DD07V` has no `AS4LOCAL`
 *     column** — adding that predicate (the way most of `img-catalog.ts`'s
 *     tables need one) is an HTTP 400 here, not a filter. Rows come back
 *     unordered on the wire; this module sorts them by `VALPOS` itself.
 *
 * Zero rows from `TOBJ` for a given name is a definitive, well-formed empty
 * result (capture 873: HTTP 200, 0 rows, for an object absent on the
 * system) — treated as `NOT_FOUND`, not a refused or ambiguous read.
 */
import { AbapError } from "./errors.js";
import type { AbapConnection } from "./connection.js";
import type { DdicRender } from "./ddic.js";
import { textTable } from "../compact.js";
import {
  assertCatalogValue,
  buildCatalogSelect,
  catalogInList,
  catalogLiteral,
  requireCatalogColumn,
  runCatalogSelect,
  type CatalogResult,
  type CatalogRow,
} from "./catalog-select.js";

// -------------------------------------------------------------- catalog ---

export type SusoCatalogConfidence = "high" | "low";

export interface SusoCatalogTable {
  readonly table: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly confidence: SusoCatalogConfidence;
  readonly note: string;
}

/**
 * Every table this module reads, in the same frozen shape `img-catalog.ts`
 * uses for the IMG catalog. Every entry is `confidence: "high"` — all of it
 * was read live on A4H 2026-09-12 (captures cited per entry).
 */
export const SUSO_CATALOG = Object.freeze({
  object: Object.freeze({
    table: "TOBJ",
    fields: Object.freeze({
      object: "OBJCT",
      objectClass: "OCLSS",
      bname: "BNAME",
      fblock: "FBLOCK",
      conversion: "CONVERSION",
      field1: "FIEL1",
      field2: "FIEL2",
      field3: "FIEL3",
      field4: "FIEL4",
      field5: "FIEL5",
      field6: "FIEL6",
      field7: "FIEL7",
      field8: "FIEL8",
      field9: "FIEL9",
      field0: "FIEL0",
    }),
    confidence: "high",
    note:
      "capture 861 (A4H 2026-09-12): key column is OBJCT, not OBJECT. Field slots are FIEL1..FIEL9 " +
      "then FIEL0 — there is no FIEL10. OBJCT is C(10): a literal over 10 chars gets HTTP 400, not " +
      "an empty result.",
  }),
  objectText: Object.freeze({
    table: "TOBJT",
    fields: Object.freeze({
      object: "OBJECT",
      language: "LANGU",
      text: "TTEXT",
    }),
    confidence: "high",
    note: "capture 861: key column here is OBJECT (unlike TOBJ's OBJCT). Language-dependent.",
  }),
  objectClassText: Object.freeze({
    table: "TOBCT",
    fields: Object.freeze({
      language: "LANGU",
      objectClass: "OCLSS",
      text: "CTEXT",
    }),
    confidence: "high",
    note: "capture 861.",
  }),
  activity: Object.freeze({
    table: "TACTZ",
    fields: Object.freeze({
      object: "BROBJ",
      activity: "ACTVT",
    }),
    confidence: "high",
    note: "capture 862: no text column here — see TACTT.",
  }),
  activityText: Object.freeze({
    table: "TACTT",
    fields: Object.freeze({
      language: "SPRAS",
      activity: "ACTVT",
      text: "LTEXT",
    }),
    confidence: "high",
    note: "capture 862: issue #87 names this table TACT; the activity texts actually live in TACTT.",
  }),
  fieldMeta: Object.freeze({
    table: "AUTHX",
    fields: Object.freeze({
      fieldName: "FIELDNAME",
      rollname: "ROLLNAME",
      checkTable: "CHECKTABLE",
      exitFb: "EXIT_FB",
      actvtFlag: "ACTVT_FLAG",
    }),
    confidence: "high",
    note: "capture 862: a field's data element and check table come from here, not from TOBJ.",
  }),
  dataElement: Object.freeze({
    table: "DD04L",
    fields: Object.freeze({
      rollname: "ROLLNAME",
      domname: "DOMNAME",
      datatype: "DATATYPE",
      leng: "LENG",
    }),
    confidence: "high",
    note: "capture 873: a ROLLNAME from AUTHX is not guaranteed to have a DD04L row — a missing one is tolerated, not an error.",
  }),
  domainValue: Object.freeze({
    table: "DD07V",
    fields: Object.freeze({
      domname: "DOMNAME",
      valpos: "VALPOS",
      ddlanguage: "DDLANGUAGE",
      valueLow: "DOMVALUE_L",
      valueHigh: "DOMVALUE_H",
      text: "DDTEXT",
    }),
    confidence: "high",
    note:
      "capture 873: DD07V has NO AS4LOCAL column — adding that predicate is HTTP 400, not a filter. " +
      "Rows come back unordered; sort by VALPOS client-side.",
  }),
} satisfies Record<string, SusoCatalogTable>);

type SusoCatalogKey = keyof typeof SUSO_CATALOG;

function tbl<K extends SusoCatalogKey>(key: K): string {
  return SUSO_CATALOG[key].table;
}

function fld<K extends SusoCatalogKey, F extends keyof (typeof SUSO_CATALOG)[K]["fields"]>(key: K, field: F): string {
  const fields = SUSO_CATALOG[key].fields as Record<F, string>;
  return fields[field];
}

// -------------------------------------------------------------- tuning ---

/** TOBJ.OBJCT's declared DDIC width — a name over this is refused client-side (see module header). */
export const SUSO_OBJECT_NAME_MAX = 10;

/**
 * Row ceiling for each individual catalog query this module issues. Not a
 * caller-facing page size — one authorization object's own field/activity/
 * fixed-value sets are all small and bounded in practice; this exists only
 * so an unexpectedly large result is still a single bounded statement, and
 * a cut is always disclosed via `notes` (never a silent `.slice`).
 */
export const SUSO_ROW_CAP = 200;

const DEFAULT_LANGUAGE = "E";

// One sentence for callers to surface: no source-text search exists yet.
export const SUSO_WHERE_USED_NOTE =
  "Finding the ABAP that runs AUTHORITY-CHECK OBJECT for this authorization object needs a source-text " +
  "search, which abapsmith does not have yet — that is the subject of a separate open issue, not a search this call performed.";

function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
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

// ---------------------------------------------------------------- shapes ---

export interface SusoField {
  readonly name: string;
  readonly dataElement?: string;
  readonly checkTable?: string;
  readonly isActivityField: boolean;
  readonly domain?: string;
  readonly fixedValues: readonly { value: string; text: string }[];
}

export interface SusoActivity {
  readonly code: string;
  readonly text: string;
}

export interface SusoObject {
  readonly name: string;
  readonly objectClass: string;
  readonly objectClassText: string;
  readonly description: string;
  readonly fields: readonly SusoField[];
  readonly activities: readonly SusoActivity[];
  readonly notes: readonly string[];
}

// ----------------------------------------------------------------- read ---

/** Reads one authorization object. Throws `NOT_FOUND` when `TOBJ` has no row for it. */
export async function readAuthorizationObject(
  conn: AbapConnection,
  name: string,
  opts?: { language?: string },
): Promise<SusoObject> {
  const notes: string[] = [];
  const language = opts?.language ?? DEFAULT_LANGUAGE;
  const objectName = assertCatalogValue(name.trim().toUpperCase(), "authorization object name", SUSO_OBJECT_NAME_MAX);

  // ---- 1. TOBJ ----
  const OBJCT = fld("object", "object");
  const objSql = buildCatalogSelect("*", tbl("object"), [`${OBJCT} = ${catalogLiteral(objectName)}`]);
  const objResult = await runCatalogSelect(conn, objSql, 1);
  notes.push(...serverNotes(objResult));
  const objRow = objResult.rows[0];
  if (objRow === undefined) {
    throw new AbapError(
      "NOT_FOUND",
      `Authorization object "${objectName}" has no ${tbl("object")} row on this system — this is a ` +
        `definitive empty result (HTTP 200, 0 rows), not a refused read.`,
      { name: objectName },
    );
  }

  const objectClass = objRow[fld("object", "objectClass")] ?? "";

  const fieldSlots = (
    ["field1", "field2", "field3", "field4", "field5", "field6", "field7", "field8", "field9", "field0"] as const
  ).map((slot) => fld("object", slot));
  const fieldNames = fieldSlots.map((col) => objRow[col] ?? "").filter((v) => v.trim() !== "");

  // ---- 2. TOBJT (object text) ----
  const objTextSql = buildCatalogSelect(
    "*",
    tbl("objectText"),
    [
      `${fld("objectText", "object")} = ${catalogLiteral(objectName)}`,
      `${fld("objectText", "language")} = ${catalogLiteral(assertCatalogValue(language, "language", 1))}`,
    ],
  );
  const objTextResult = await runCatalogSelect(conn, objTextSql, 1);
  notes.push(...serverNotes(objTextResult));
  const description = objTextResult.rows[0]?.[fld("objectText", "text")] ?? "";
  if (objTextResult.rows.length === 0) {
    notes.push(`No ${tbl("objectText")} text for "${objectName}" in language "${language}".`);
  }

  // ---- 3. TOBCT (class text) ----
  let objectClassText = "";
  if (objectClass.trim() !== "") {
    const classTextSql = buildCatalogSelect(
      "*",
      tbl("objectClassText"),
      [
        `${fld("objectClassText", "objectClass")} = ${catalogLiteral(objectClass)}`,
        `${fld("objectClassText", "language")} = ${catalogLiteral(language)}`,
      ],
    );
    const classTextResult = await runCatalogSelect(conn, classTextSql, 1);
    notes.push(...serverNotes(classTextResult));
    objectClassText = classTextResult.rows[0]?.[fld("objectClassText", "text")] ?? "";
    if (classTextResult.rows.length === 0) {
      notes.push(`No ${tbl("objectClassText")} text for object class "${objectClass}" in language "${language}".`);
    }
  } else {
    notes.push(`Object "${objectName}" has no ${fld("object", "objectClass")} value — object class is unknown.`);
  }

  // ---- 4. AUTHX (per-field metadata) ----
  const authxByField = new Map<string, CatalogRow>();
  if (fieldNames.length > 0) {
    for (const group of chunk(fieldNames, 50)) {
      const authxSql = buildCatalogSelect("*", tbl("fieldMeta"), [
        `${fld("fieldMeta", "fieldName")} ${catalogInList(group, "field names", 30)}`,
      ]);
      const authxResult = await runCatalogSelect(conn, authxSql, SUSO_ROW_CAP);
      notes.push(...serverNotes(authxResult));
      noteIfCut(authxResult, SUSO_ROW_CAP, `${tbl("fieldMeta")} lookup for "${objectName}"`, notes);
      for (const row of authxResult.rows) {
        requireCatalogColumn(authxResult, fld("fieldMeta", "fieldName"));
        authxByField.set(row[fld("fieldMeta", "fieldName")] ?? "", row);
      }
    }
    for (const f of fieldNames) {
      if (!authxByField.has(f)) {
        notes.push(`No ${tbl("fieldMeta")} row for field "${f}" of object "${objectName}" — no data element or check table known.`);
      }
    }
  }

  // ---- 5. DD04L (data element -> domain) ----
  const rollnames = [...new Set([...authxByField.values()].map((r) => r[fld("fieldMeta", "rollname")] ?? "").filter((v) => v.trim() !== ""))];
  const dd04lByRollname = new Map<string, CatalogRow>();
  if (rollnames.length > 0) {
    for (const group of chunk(rollnames, 50)) {
      const dd04lSql = buildCatalogSelect("*", tbl("dataElement"), [
        `${fld("dataElement", "rollname")} ${catalogInList(group, "data elements", 30)}`,
      ]);
      const dd04lResult = await runCatalogSelect(conn, dd04lSql, SUSO_ROW_CAP);
      notes.push(...serverNotes(dd04lResult));
      noteIfCut(dd04lResult, SUSO_ROW_CAP, `${tbl("dataElement")} lookup for "${objectName}"`, notes);
      for (const row of dd04lResult.rows) {
        dd04lByRollname.set(row[fld("dataElement", "rollname")] ?? "", row);
      }
    }
    for (const rn of rollnames) {
      if (!dd04lByRollname.has(rn)) {
        notes.push(`No ${tbl("dataElement")} row for data element "${rn}" — not an error, just tolerated as missing.`);
      }
    }
  }

  // ---- 6. DD07V (domain fixed values) ----
  const domains = [...new Set([...dd04lByRollname.values()].map((r) => r[fld("dataElement", "domname")] ?? "").filter((v) => v.trim() !== ""))];
  const fixedValuesByDomain = new Map<string, { value: string; text: string; valpos: number }[]>();
  if (domains.length > 0) {
    for (const group of chunk(domains, 50)) {
      const dd07vSql = buildCatalogSelect(
        "*",
        tbl("domainValue"),
        [
          `${fld("domainValue", "domname")} ${catalogInList(group, "domains", 30)}`,
          `${fld("domainValue", "ddlanguage")} = ${catalogLiteral(language)}`,
        ],
      );
      const dd07vResult = await runCatalogSelect(conn, dd07vSql, SUSO_ROW_CAP);
      notes.push(...serverNotes(dd07vResult));
      noteIfCut(dd07vResult, SUSO_ROW_CAP, `${tbl("domainValue")} lookup for "${objectName}"`, notes);
      for (const row of dd07vResult.rows) {
        const domname = row[fld("domainValue", "domname")] ?? "";
        const valueLow = row[fld("domainValue", "valueLow")] ?? "";
        const valueHigh = row[fld("domainValue", "valueHigh")] ?? "";
        const text = row[fld("domainValue", "text")] ?? "";
        const valpos = Number.parseInt(row[fld("domainValue", "valpos")] ?? "", 10);
        const value = valueHigh.trim() === "" ? valueLow : `${valueLow}..${valueHigh}`;
        const list = fixedValuesByDomain.get(domname);
        const entry = { value, text, valpos: Number.isNaN(valpos) ? 0 : valpos };
        if (list) list.push(entry);
        else fixedValuesByDomain.set(domname, [entry]);
      }
    }
    for (const [, list] of fixedValuesByDomain) {
      list.sort((a, b) => a.valpos - b.valpos);
    }
  }

  // ---- 7. TACTZ + TACTT (activities) ----
  const tactzSql = buildCatalogSelect("*", tbl("activity"), [`${fld("activity", "object")} = ${catalogLiteral(objectName)}`]);
  const tactzResult = await runCatalogSelect(conn, tactzSql, SUSO_ROW_CAP);
  notes.push(...serverNotes(tactzResult));
  noteIfCut(tactzResult, SUSO_ROW_CAP, `${tbl("activity")} lookup for "${objectName}"`, notes);
  const activityCodes = [...new Set(tactzResult.rows.map((r) => r[fld("activity", "activity")] ?? "").filter((v) => v.trim() !== ""))];

  const activityTextByCode = new Map<string, string>();
  if (activityCodes.length > 0) {
    for (const group of chunk(activityCodes, 50)) {
      const tacttSql = buildCatalogSelect(
        "*",
        tbl("activityText"),
        [
          `${fld("activityText", "activity")} ${catalogInList(group, "activity codes", 2)}`,
          `${fld("activityText", "language")} = ${catalogLiteral(language)}`,
        ],
      );
      const tacttResult = await runCatalogSelect(conn, tacttSql, SUSO_ROW_CAP);
      notes.push(...serverNotes(tacttResult));
      for (const row of tacttResult.rows) {
        activityTextByCode.set(row[fld("activityText", "activity")] ?? "", row[fld("activityText", "text")] ?? "");
      }
    }
  }

  const activities: SusoActivity[] = activityCodes.map((code) => {
    const text = activityTextByCode.get(code);
    if (text === undefined) {
      notes.push(`No ${tbl("activityText")} text for activity "${code}" of object "${objectName}" in language "${language}" — listed with an empty text.`);
    }
    return { code, text: text ?? "" };
  });

  // ---- assemble fields, preserving TOBJ slot order ----
  const fields: SusoField[] = fieldNames.map((f) => {
    const authx = authxByField.get(f);
    const rollname = authx?.[fld("fieldMeta", "rollname")]?.trim() || undefined;
    const dd04l = rollname ? dd04lByRollname.get(rollname) : undefined;
    const domain = dd04l?.[fld("dataElement", "domname")]?.trim() || undefined;
    const fixedValues = (domain ? fixedValuesByDomain.get(domain) : undefined) ?? [];
    return {
      name: f,
      dataElement: rollname,
      checkTable: authx?.[fld("fieldMeta", "checkTable")]?.trim() || undefined,
      isActivityField: (authx?.[fld("fieldMeta", "actvtFlag")] ?? "").trim() !== "",
      domain,
      fixedValues: fixedValues.map(({ value, text }) => ({ value, text })),
    };
  });

  return {
    name: objectName,
    objectClass,
    objectClassText,
    description,
    fields,
    activities,
    notes,
  };
}

// --------------------------------------------------------------- render ---

/** Renders it in the shape `abap_read`'s DDIC branch already knows how to build a response from. */
export function renderAuthorizationObject(obj: SusoObject): DdicRender {
  const ddl = textTable(
    obj.fields.map((f) => ({
      field: f.name,
      "data element": f.dataElement ?? "",
      "check table": f.checkTable ?? "",
      activity: f.isActivityField ? "X" : "",
    })),
    ["field", "data element", "check table", "activity"],
  );

  const sections: Array<{ title: string; content: string }> = [];
  sections.push({
    title: "ACTIVITIES",
    content: textTable(
      obj.activities.map((a) => ({ code: a.code, text: a.text })),
      ["code", "text"],
    ),
  });
  for (const f of obj.fields) {
    if (f.fixedValues.length === 0) continue;
    sections.push({
      title: `FIXED VALUES — ${f.name}`,
      content: textTable(
        f.fixedValues.map((v) => ({ value: v.value, text: v.text })),
        ["value", "text"],
      ),
    });
  }

  const boundaryNote =
    "This is the DEFINITION of the authorization object — its class, text, fields and permitted " +
    "activities. It is not a list of who holds it: no AGR_* (role) or UST* (user authorization) " +
    "table was read. SUSO/B cannot be written by abapsmith; SU21 is the only way to edit one.";

  const notes = [...obj.notes, boundaryNote];

  return {
    ddl,
    sections,
    meta: {
      object_class: obj.objectClass,
      object_class_text: obj.objectClassText,
      fields: obj.fields.length,
      activities: obj.activities.length,
    },
    notes,
    // `ddic.ts`'s own assembled (non-raw-XML) renders — renderDataElement,
    // renderDomain — hash just `ddl`, not the extra sections; this follows
    // that same convention rather than inventing a wider one.
    hashInput: ddl,
  };
}
