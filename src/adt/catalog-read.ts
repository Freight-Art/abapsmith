/**
 * Reads for the three DDIC catalog types that have no source-based route and
 * no XML descriptor either: search helps (SHLP/DH), classic views (VIEW/DV)
 * and transactions (TRAN/T). Each is rendered as pseudo-DDL, the same
 * contract `ddic.ts` uses for TABL/STRU/DTEL/DOMA/TTYP.
 *
 * The obvious alternative — DDIF_SHLP_GET, DDIF_VIEW_GET, RPY_TRANSACTION_READ
 * — needs the generated-ABAP "fluid" bridge (deploy a classrun, call it,
 * clean it up). Fluid is unconditionally disabled when `ABAP_MODE=read` (see
 * `fluidDisabledReason` in `src/adt/fluid/enabled.ts`), which is exactly the
 * mode a read-only tool call is expected to work in, so that route is closed
 * here on principle, not just on this measurement. The catalog-SELECT route
 * this module takes instead works in every `ABAP_MODE`, needs no deploy step,
 * and — for TRAN/T in particular — surfaces more than RPY_TRANSACTION_READ
 * does (TSTCP call parameters, TSTCA authorisation checks, AGR_TCODES role
 * membership), none of which that function module returns.
 *
 * This module does the I/O; `catalog-query.ts` only builds the SQL. It
 * mirrors `img-read.ts`'s shape (`issue`, `serverNotes`, a small per-call
 * context) rather than inventing a second convention for the same freestyle
 * endpoint.
 *
 * Every `fld(key, field)` call below uses a literal field name at the call
 * site on purpose: `fld`'s generic ties `field` to `key`'s own field map, so
 * a typo'd logical name is a compile error, not a runtime `undefined`. A
 * `(c: string) => fld(key, c as never)` wrapper would throw that checking
 * away — the cast makes any string compile, typo included — so none is used
 * here even though it would have made the field lookups shorter.
 */
import { classifyPreviewFailure } from "./datapreview.js";
import { AbapError } from "./errors.js";
import type { ErrorContext } from "./session.js";
import type { DdicRender } from "./ddic.js";
import {
  buildSearchHelpAssignmentsQuery,
  buildSearchHelpHeaderQuery,
  buildSearchHelpIncludesQuery,
  buildSearchHelpParamsQuery,
  buildSearchHelpParentsQuery,
  buildSearchHelpTextQuery,
  buildSearchHelpUsingDataElementsQuery,
  buildTransactionAuthQuery,
  buildTransactionDetailQuery,
  buildTransactionParamQuery,
  buildTransactionRolesQuery,
  buildTransactionTextDetailQuery,
  buildViewBaseTablesDetailQuery,
  buildViewDirectoryDetailQuery,
  buildViewFieldsDetailQuery,
  buildViewHeaderDetailQuery,
  buildViewTextDetailQuery,
  parseTransactionParameters,
} from "./catalog-query.js";
import { IMG_DEFAULT_LANGUAGE, fld, toRecordSet, type PreviewRecord, type PreviewRecordSet } from "./img-query.js";

/** What `readSearchHelp`/`readClassicView`/`readTransaction` need from a live connection — exactly `ImgReadConnection`'s shape, kept as its own name so this module doesn't import `img-read.ts` for a one-line interface. */
export interface CatalogReadConnection {
  dataPreviewFreestyle(sql: string, rowNumber: number): Promise<{ body: string }>;
}

// ----------------------------------------------------------------- caps ---

/** Header/detail rows: exactly one row is ever meaningful. */
const CAP_ONE = 1;
/** Description texts: one row per language, capped generously above that. */
const CAP_TEXT = 50;
/** Multi-row detail lists (DD32S/DD27S/DD26S/DD31S/DD33S/TSTCA/AGR_TCODES/DD04L). */
const CAP_LIST = 200;

interface Issued {
  rs: PreviewRecordSet;
}

async function issue(conn: CatalogReadConnection, sql: string, rowNumber: number): Promise<Issued> {
  const resp = await conn.dataPreviewFreestyle(sql, rowNumber);
  return { rs: toRecordSet(resp.body) };
}

function serverNotes(rs: PreviewRecordSet): string[] {
  return rs.messages.map((m) => `[server] ${m.text}${m.severity ? ` (${m.severity})` : ""}`);
}

function truncationNote(what: string, cap: number, rs: PreviewRecordSet): string[] {
  return rs.records.length >= cap
    ? [`${what} is capped at ${cap} row(s) and may be truncated — this is not necessarily the full list.`]
    : [];
}

function nonEmpty(v: string | undefined): string | undefined {
  const t = (v ?? "").trim();
  return t === "" ? undefined : t;
}

function flag(v: string | undefined): boolean {
  const t = (v ?? "").trim().toUpperCase();
  return t === "X" || t === "A" || t === "1";
}

function line(label: string, value: string | number | boolean | undefined): string {
  if (value === undefined || value === "") return "";
  return `  ${label}: ${String(value)}`;
}

function block(title: string, rows: string[]): string {
  const body = rows.filter((r) => r !== "");
  if (body.length === 0) return "";
  return `\n  ${title}\n${body.map((r) => `    ${r}`).join("\n")}`;
}

// ------------------------------------------------------- code decodes ---

/**
 * Single-character DDIC code -> label maps used to decode the pseudo-DDL
 * render. Each is kept as one named `const` so the whole mapping for a
 * column is visible in one place. "Live-verified" below means the code was
 * actually observed in a live column value on A4H during this work, not
 * merely documented by SAP; an unverified code in the same table is still
 * printed decoded (SAP's own documented value set), but the doc comment says
 * so. `decodeCode` always prints the raw code alongside the label, and falls
 * back to the raw code alone for anything not in the table — never a guess.
 */
type CodeTable = Readonly<Record<string, string>>;

/**
 * DD30L-SELMTYPE (search help selection method type). `T` was observed live
 * on A4H, transaction/table H_T000; `V` and `M` are SAP's documented value
 * set, not independently observed here.
 */
const SELMTYPE_DECODE: CodeTable = {
  T: "table",
  V: "view",
  M: "method/exit",
};

/**
 * DD30L-DIALOGTYPE (search help dialog behaviour). `D` was observed live on
 * A4H, H_T000; `A` and `C` are SAP's documented value set, not independently
 * observed here.
 */
const DIALOGTYPE_DECODE: CodeTable = {
  A: "dialog depends on set of values",
  C: "dialog with value restriction",
  D: "display values immediately",
};

/**
 * DD25L-AGGTYPE (view aggregate type). `V` was observed live on A4H, V_T006I;
 * `S` and `P` are SAP's documented value set, not independently observed
 * here.
 */
const AGGTYPE_DECODE: CodeTable = {
  V: "database view",
  S: "structure view",
  P: "projection view",
};

/**
 * DD25L-VIEWCLASS. `C` was observed live on A4H, V_T006I; `D`, `P`, `M`, `E`
 * are SAP's documented value set, not independently observed here.
 */
const VIEWCLASS_DECODE: CodeTable = {
  D: "database view",
  C: "help view",
  P: "projection view",
  M: "maintenance view",
  E: "entity view",
};

/**
 * DD25L-VIEWGRANT (maintenance status). The column itself was observed live
 * on A4H, V_T006I; the four-value mapping is SAP's documented value set —
 * which specific letter that row held was not cross-checked against SAP's
 * documentation as part of this work, so treat the labels below as
 * documented, not independently confirmed letter-by-letter.
 */
const VIEWGRANT_DECODE: CodeTable = {
  R: "read-only",
  U: "read and change",
  D: "read, change and delete",
  X: "no restriction",
};

/** `"<label> (<code>)"` for a known code, the bare code for an unknown one, `undefined` for a blank column — callers then omit the line entirely, per the maintenance-status rule this is written to satisfy generally. */
function decodeCode(table: CodeTable, raw: string | undefined): string | undefined {
  const code = nonEmpty(raw);
  if (code === undefined) return undefined;
  const label = table[code];
  return label ? `${label} (${code})` : code;
}

// ============================================================ search help ===

async function readSearchHelpImpl(
  conn: CatalogReadConnection,
  name: string,
  language: string,
): Promise<DdicRender> {
  const ctx: ErrorContext = { operation: "read search help", name, type: "SHLP/DH" };
  const notes: string[] = [];
  let header: Issued;
  try {
    header = await issue(conn, buildSearchHelpHeaderQuery(name), CAP_ONE);
  } catch (e) {
    throw classifyPreviewFailure(e, ctx);
  }
  notes.push(...serverNotes(header.rs));
  const headerRow = header.rs.records[0];
  if (!headerRow) {
    throw new AbapError(
      "NOT_FOUND",
      `No active search help named ${name} was found (DD30L returned no row).`,
      { name, type: "SHLP/DH" },
    );
  }

  let text: Issued;
  let includes: Issued;
  let params: Issued;
  let assigns: Issued;
  let usedBy: Issued;
  let parents: Issued;
  try {
    text = await issue(conn, buildSearchHelpTextQuery(name, language), CAP_TEXT);
    includes = await issue(conn, buildSearchHelpIncludesQuery(name), CAP_LIST);
    params = await issue(conn, buildSearchHelpParamsQuery(name), CAP_LIST);
    assigns = await issue(conn, buildSearchHelpAssignmentsQuery(name), CAP_LIST);
    usedBy = await issue(conn, buildSearchHelpUsingDataElementsQuery(name), CAP_LIST);
    parents = await issue(conn, buildSearchHelpParentsQuery(name), CAP_LIST);
  } catch (e) {
    throw classifyPreviewFailure(e, ctx);
  }
  for (const rs of [text.rs, includes.rs, params.rs, assigns.rs, usedBy.rs, parents.rs]) {
    notes.push(...serverNotes(rs));
  }

  // DD31S carries a row pointing an elementary search help at its own interface
  // (SUBSHLP = SHLPNAME, SHPOSITION 0001) even when the caller wrote no includes at
  // all — measured live on A4H 2026-09-15 on a freshly created ELEMENTARY search
  // help ZSH_I83_EL (two interface fields, no includes, no assignments), and
  // confirmed as DDIC's general representation, not a write-path defect, by an
  // abap_data_preview of DD31S for five standard SAP elementary search helps
  // (/UI2/GROUPS_SH, /AIF/MESSAGE_CLID_SHLP, /UI5/PURPOSE, /BA1/F4_FX_RATETYPE,
  // /AIF/FILEDIALOG), each with exactly one row, SUBSHLP = SHLPNAME, at
  // SHPOSITION 0001. That row is not an include relationship, so it is filtered
  // out of INCLUDES, INCLUDED BY and includeCount below — the DD33S ASSIGNMENTS
  // rows are left untouched, since this evidence says nothing about what a
  // self-referencing DD33S row would mean.
  // Both the includes query (WHERE SHLPNAME = name) and the parents query
  // (WHERE SUBSHLP = name) select the same DD31S columns, so a self-row is
  // identified the same way in either result set: SHLPNAME and SUBSHLP both
  // equal this search help's own name, not just the one column each query's
  // WHERE clause already pins.
  const normalizedName = name.trim().toUpperCase();
  const norm = (v: string | undefined): string => (v ?? "").trim().toUpperCase();
  const isSelfShlpRow = (r: PreviewRecord): boolean =>
    norm(r[fld("searchHelpInclude", "searchHelp")]) === normalizedName &&
    norm(r[fld("searchHelpInclude", "includedHelp")]) === normalizedName;
  const includeSelfFound = includes.rs.records.some(isSelfShlpRow);
  const parentSelfFound = parents.rs.records.some(isSelfShlpRow);
  const includesRs = { ...includes.rs, records: includes.rs.records.filter((r) => !isSelfShlpRow(r)) };
  const parentsRs = { ...parents.rs, records: parents.rs.records.filter((r) => !isSelfShlpRow(r)) };

  notes.push(...truncationNote("PARAMETERS", CAP_LIST, params.rs));
  notes.push(...truncationNote("INCLUDES", CAP_LIST, includesRs));
  notes.push(...truncationNote("ASSIGNMENTS", CAP_LIST, assigns.rs));
  notes.push(...truncationNote("USED BY DATA ELEMENTS", CAP_LIST, usedBy.rs));
  notes.push(...truncationNote("INCLUDED BY", CAP_LIST, parentsRs));
  if (includeSelfFound || parentSelfFound) {
    notes.push(
      "A DD31S row with SUBSHLP = SHLPNAME (this search help pointing at its own interface) was " +
        "found and left out of INCLUDES, INCLUDED BY and includeCount — DDIC records an elementary " +
        "search help's own interface that way, it is not an include relationship. Measured live on " +
        "A4H 2026-09-15 (ZSH_I83_EL) and confirmed as DDIC's general pattern via DD31S for five " +
        "standard SAP elementary search helps (/UI2/GROUPS_SH, /AIF/MESSAGE_CLID_SHLP, /UI5/PURPOSE, " +
        "/BA1/F4_FX_RATETYPE, /AIF/FILEDIALOG).",
    );
  }
  if (assigns.rs.records.length > 0) {
    notes.push(
      "DD33S-VALUEDIREC is not decoded here — the column exists (measured 2026-09-12) but its " +
        "value set was not independently verified on this system, so the raw code is printed as-is.",
    );
  }

  const elementary = flag(headerRow[fld("searchHelpHeader", "elementary")]);
  const description = nonEmpty(text.rs.records[0]?.[fld("searchHelpText", "text")]);

  const paramLines = params.rs.records.map((r) => {
    const imp = flag(r[fld("searchHelpParam", "importFlag")]) ? "IMPORT" : "";
    const exp = flag(r[fld("searchHelpParam", "exportFlag")]) ? "EXPORT" : "";
    const dir = [imp, exp].filter(Boolean).join("/") || "-";
    return (
      `${r[fld("searchHelpParam", "field")] ?? ""} : ${r[fld("searchHelpParam", "dataElement")] ?? ""} ` +
      `(${dir}) POS ${r[fld("searchHelpParam", "position")] ?? ""}`
    );
  });
  const includeLines = includesRs.records.map((r) => {
    const hidden = flag(r[fld("searchHelpInclude", "hidden")]) ? " HIDDEN" : "";
    return `${r[fld("searchHelpInclude", "includedHelp")] ?? ""} POS ${r[fld("searchHelpInclude", "position")] ?? ""}${hidden}`;
  });
  const assignLines = assigns.rs.records.map((r) => {
    const valueDirection = nonEmpty(r[fld("searchHelpAssign", "valueDirection")]);
    return (
      `${r[fld("searchHelpAssign", "field")] ?? ""} = ${r[fld("searchHelpAssign", "includedHelp")] ?? ""}.` +
      `${r[fld("searchHelpAssign", "includedField")] ?? ""}${valueDirection ? ` DIR ${valueDirection}` : ""}`
    );
  });
  const usedByLines = usedBy.rs.records.map((r) => {
    return `${r[fld("dataElementHeader", "dataElement")] ?? ""} FIELD ${r[fld("dataElementHeader", "searchHelpField")] ?? ""}`;
  });
  const parentLines = parentsRs.records.map((r) => {
    return `${r[fld("searchHelpInclude", "searchHelp")] ?? ""}`;
  });

  const ddl =
    `SEARCH HELP ${name}.\n` +
    (description ? `  "${description}"\n` : "") +
    `\n` +
    `  KIND: ${elementary ? "ELEMENTARY" : "COLLECTIVE"}\n` +
    [
      line("SELECTION METHOD", nonEmpty(headerRow[fld("searchHelpHeader", "selectionMethod")])),
      line(
        "SELECTION METHOD TYPE",
        decodeCode(SELMTYPE_DECODE, headerRow[fld("searchHelpHeader", "selectionMethodType")]),
      ),
      line("TEXT TABLE", nonEmpty(headerRow[fld("searchHelpHeader", "textTable")])),
      line("SELECTION EXIT", nonEmpty(headerRow[fld("searchHelpHeader", "selectionExit")])),
      line("HOT KEY", nonEmpty(headerRow[fld("searchHelpHeader", "hotKey")])),
      line("DIALOG TYPE", decodeCode(DIALOGTYPE_DECODE, headerRow[fld("searchHelpHeader", "dialogType")])),
    ]
      .filter(Boolean)
      .join("\n") +
    block("PARAMETERS", paramLines) +
    block("INCLUDES", includeLines) +
    block("ASSIGNMENTS", assignLines) +
    block("USED BY DATA ELEMENTS", usedByLines) +
    block("INCLUDED BY", parentLines);

  return {
    ddl,
    sections: [
      { title: "PARAMETERS", content: paramLines.join("\n") },
      { title: "INCLUDES", content: includeLines.join("\n") },
      { title: "ASSIGNMENTS", content: assignLines.join("\n") },
    ].filter((s) => s.content !== ""),
    meta: {
      searchHelp: name,
      elementary: elementary ? "true" : "false",
      selectionMethod: nonEmpty(headerRow[fld("searchHelpHeader", "selectionMethod")]),
      textTable: nonEmpty(headerRow[fld("searchHelpHeader", "textTable")]),
      parameterCount: params.rs.records.length,
      includeCount: includesRs.records.length,
    },
    notes,
    hashInput: ddl,
  };
}

export async function readSearchHelp(
  conn: CatalogReadConnection,
  name: string,
  language: string = IMG_DEFAULT_LANGUAGE,
): Promise<DdicRender> {
  return readSearchHelpImpl(conn, name, language);
}

// ============================================================ classic view ===

async function readClassicViewImpl(
  conn: CatalogReadConnection,
  name: string,
  language: string,
): Promise<DdicRender> {
  const ctx: ErrorContext = { operation: "read classic view", name, type: "VIEW/DV" };
  const notes: string[] = [];
  let header: Issued;
  try {
    header = await issue(conn, buildViewHeaderDetailQuery(name), CAP_ONE);
  } catch (e) {
    throw classifyPreviewFailure(e, ctx);
  }
  notes.push(...serverNotes(header.rs));
  const headerRow = header.rs.records[0];
  if (!headerRow) {
    throw new AbapError(
      "NOT_FOUND",
      `No active classic view named ${name} was found (DD25L returned no row).`,
      { name, type: "VIEW/DV" },
    );
  }

  let text: Issued;
  let baseTables: Issued;
  let fields: Issued;
  let directory: Issued;
  try {
    text = await issue(conn, buildViewTextDetailQuery(name, language), CAP_TEXT);
    baseTables = await issue(conn, buildViewBaseTablesDetailQuery(name), CAP_LIST);
    fields = await issue(conn, buildViewFieldsDetailQuery(name), CAP_LIST);
    directory = await issue(conn, buildViewDirectoryDetailQuery(name), CAP_ONE);
  } catch (e) {
    throw classifyPreviewFailure(e, ctx);
  }
  for (const rs of [text.rs, baseTables.rs, fields.rs, directory.rs]) notes.push(...serverNotes(rs));
  notes.push(...truncationNote("BASE TABLES", CAP_LIST, baseTables.rs));
  notes.push(...truncationNote("FIELDS", CAP_LIST, fields.rs));

  const description = nonEmpty(text.rs.records[0]?.[fld("viewText", "text")]);
  const dirRow = directory.rs.records[0];

  const baseTableLines = baseTables.rs.records.map((r) => {
    const fk = nonEmpty(r[fld("viewBaseTable", "foreignTable")]);
    const fkText = fk
      ? ` (FK -> ${fk}.${r[fld("viewBaseTable", "foreignField")] ?? ""} ${r[fld("viewBaseTable", "foreignDirection")] ?? ""})`
      : "";
    return `${r[fld("viewBaseTable", "table")] ?? ""}${fkText}`;
  });
  const fieldLines = fields.rs.records.map((r) => {
    const key = flag(r[fld("viewField", "keyFlag")]) ? " KEY" : "";
    const ro = flag(r[fld("viewField", "readOnly")]) ? " READONLY" : "";
    return (
      `${r[fld("viewField", "viewField")] ?? ""} : ${r[fld("viewField", "dataElement")] ?? ""} ` +
      `(${r[fld("viewField", "table")] ?? ""}.${r[fld("viewField", "field")] ?? ""})${key}${ro}`
    );
  });

  const ddl =
    `VIEW ${name}.\n` +
    (description ? `  "${description}"\n` : "") +
    `\n` +
    [
      line("ROOT TABLE", nonEmpty(headerRow[fld("viewHeader", "rootTable")])),
      line("AGGREGATE TYPE", decodeCode(AGGTYPE_DECODE, headerRow[fld("viewHeader", "aggregateType")])),
      line("VIEW CLASS", decodeCode(VIEWCLASS_DECODE, headerRow[fld("viewHeader", "viewClass")])),
      line("READ ONLY", flag(headerRow[fld("viewHeader", "readOnly")])),
      line("VIEW GRANT", decodeCode(VIEWGRANT_DECODE, headerRow[fld("viewHeader", "viewGrant")])),
      line("APPLICATION CLASS", nonEmpty(headerRow[fld("viewHeader", "applicationClass")])),
      line("MASTER LANGUAGE", nonEmpty(headerRow[fld("viewHeader", "masterLanguage")])),
      dirRow ? line("PACKAGE", nonEmpty(dirRow[fld("viewDirectory", "package")])) : "",
      dirRow ? line("SCREEN", nonEmpty(dirRow[fld("viewDirectory", "screen")])) : "",
    ]
      .filter(Boolean)
      .join("\n") +
    block("BASE TABLES", baseTableLines) +
    block("FIELDS", fieldLines);

  return {
    ddl,
    sections: [
      { title: "BASE TABLES", content: baseTableLines.join("\n") },
      { title: "FIELDS", content: fieldLines.join("\n") },
    ].filter((s) => s.content !== ""),
    meta: {
      view: name,
      rootTable: nonEmpty(headerRow[fld("viewHeader", "rootTable")]),
      viewClass: nonEmpty(headerRow[fld("viewHeader", "viewClass")]),
      package: dirRow ? nonEmpty(dirRow[fld("viewDirectory", "package")]) : undefined,
      baseTableCount: baseTables.rs.records.length,
      fieldCount: fields.rs.records.length,
    },
    notes,
    hashInput: ddl,
  };
}

export async function readClassicView(
  conn: CatalogReadConnection,
  name: string,
  language: string = IMG_DEFAULT_LANGUAGE,
): Promise<DdicRender> {
  return readClassicViewImpl(conn, name, language);
}

// ============================================================= transaction ===

async function readTransactionImpl(
  conn: CatalogReadConnection,
  tcode: string,
  language: string,
): Promise<DdicRender> {
  const ctx: ErrorContext = { operation: "read transaction", name: tcode, type: "TRAN/T" };
  const notes: string[] = [];
  let header: Issued;
  try {
    header = await issue(conn, buildTransactionDetailQuery(tcode), CAP_ONE);
  } catch (e) {
    throw classifyPreviewFailure(e, ctx);
  }
  notes.push(...serverNotes(header.rs));
  const headerRow = header.rs.records[0];
  if (!headerRow) {
    throw new AbapError(
      "NOT_FOUND",
      `No transaction named ${tcode} was found (TSTC returned no row).`,
      { name: tcode, type: "TRAN/T" },
    );
  }

  let text: Issued;
  let param: Issued;
  let auth: Issued;
  let roles: Issued;
  try {
    text = await issue(conn, buildTransactionTextDetailQuery(tcode, language), CAP_TEXT);
    param = await issue(conn, buildTransactionParamQuery(tcode), CAP_ONE);
    auth = await issue(conn, buildTransactionAuthQuery(tcode), CAP_LIST);
    roles = await issue(conn, buildTransactionRolesQuery(tcode), CAP_LIST);
  } catch (e) {
    throw classifyPreviewFailure(e, ctx);
  }
  for (const rs of [text.rs, param.rs, auth.rs, roles.rs]) notes.push(...serverNotes(rs));
  notes.push(...truncationNote("AUTHORIZATION", CAP_LIST, auth.rs));
  notes.push(...truncationNote("ASSIGNED TO ROLES", CAP_LIST, roles.rs));

  const description = nonEmpty(text.rs.records[0]?.[fld("transactionText", "text")]);
  const rawParam = nonEmpty(param.rs.records[0]?.[fld("transactionParam", "parameters")]);
  const parsed = rawParam !== undefined ? parseTransactionParameters(rawParam) : undefined;

  const authLines = auth.rs.records.map((r) => {
    return (
      `${r[fld("transactionAuth", "authObject")] ?? ""} ${r[fld("transactionAuth", "authField")] ?? ""} = ` +
      `${r[fld("transactionAuth", "authValue")] ?? ""}`
    );
  });
  const roleLines = roles.rs.records.map((r) => {
    return `${r[fld("roleTransaction", "role")] ?? ""}`;
  });
  const paramLines: string[] = [];
  if (rawParam !== undefined && parsed) {
    paramLines.push(`RAW: ${rawParam}`);
    if (parsed.kind === "parameter") {
      paramLines.push(`STARTS: ${parsed.target ?? "(unknown)"}`);
      for (const a of parsed.assignments) paramLines.push(`  ${a.name} = ${a.value}`);
    } else if (parsed.target) {
      paramLines.push(`SWITCHES TO: ${parsed.target}`);
    }
  }

  const ddl =
    `TRANSACTION ${tcode}.\n` +
    (description ? `  "${description}"\n` : "") +
    `\n` +
    [
      line("PROGRAM", nonEmpty(headerRow[fld("transaction", "program")])),
      line("SCREEN", nonEmpty(headerRow[fld("transaction", "dynpro")])),
      line("CLASS INFO", nonEmpty(headerRow[fld("transaction", "classInfo")])),
      line("MESSAGE AREA", nonEmpty(headerRow[fld("transaction", "messageArea")])),
    ]
      .filter(Boolean)
      .join("\n") +
    block("PARAMETERS", paramLines) +
    block("AUTHORIZATION", authLines) +
    block("ASSIGNED TO ROLES", roleLines);

  return {
    ddl,
    sections: [
      { title: "AUTHORIZATION", content: authLines.join("\n") },
      { title: "ASSIGNED TO ROLES", content: roleLines.join("\n") },
    ].filter((s) => s.content !== ""),
    meta: {
      transaction: tcode,
      program: nonEmpty(headerRow[fld("transaction", "program")]),
      screen: nonEmpty(headerRow[fld("transaction", "dynpro")]),
      parameterKind: parsed?.kind,
      parameterTarget: parsed?.target,
      authCheckCount: auth.rs.records.length,
      roleCount: roles.rs.records.length,
    },
    notes,
    hashInput: ddl,
  };
}

export async function readTransaction(
  conn: CatalogReadConnection,
  tcode: string,
  language: string = IMG_DEFAULT_LANGUAGE,
): Promise<DdicRender> {
  return readTransactionImpl(conn, tcode, language);
}

// ==================================================================== hub ===

/**
 * Dispatches on `obj.kind` (`SHLP`, `VIEW`, `TRAN`) to the matching reader —
 * the same shape `ddic.ts`'s `readDdic` uses to dispatch on strategy. Throws
 * `UNSUPPORTED` for anything else so a caller wiring this in wrong fails
 * loudly rather than silently returning the wrong object's rendering.
 */
export async function readCatalogObject(
  conn: CatalogReadConnection,
  obj: { kind: string; type: string; name: string },
): Promise<DdicRender> {
  switch (obj.kind.toUpperCase()) {
    case "SHLP":
      return readSearchHelp(conn, obj.name);
    case "VIEW":
      return readClassicView(conn, obj.name);
    case "TRAN":
      return readTransaction(conn, obj.name);
    default:
      throw new AbapError(
        "UNSUPPORTED",
        `${obj.type} is not a catalog-based DDIC type readCatalogObject can render.`,
        { type: obj.type, renderable: ["SHLP/DH", "VIEW/DV", "TRAN/T"] },
      );
  }
}
