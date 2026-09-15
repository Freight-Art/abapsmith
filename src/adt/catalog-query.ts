/**
 * SQL builders for the three DDIC catalog reads that have no source-based or
 * XML-descriptor route: search helps (SHLP/DH), classic views (VIEW/DV) and
 * transactions (TRAN/T). Pure — no `AbapConnection`, no HTTP — exactly like
 * `img-query.ts`, which this module reuses (`tbl`, `fld`, `inClause`,
 * `buildSelect`, `sqlLiteral`, `assertEntityName`, `assertTransactionCode`,
 * `assertImgLanguage`) rather than re-implementing any of it.
 *
 * Same freestyle-endpoint constraints as `img-query.ts` apply here (see that
 * file's header for the full list, proven live, not re-litigated per module):
 * the server appends its own `INTO TABLE ... UP TO <rowNumber> ROWS`, so there
 * is no `OFFSET`; the request body is wrapped at 255 characters, so every
 * statement here is emitted multi-line by `buildSelect`; and there are no
 * JOINs on purpose — one SELECT per catalog table, so each is independently
 * checkable against `IMG_CATALOG` and a caller can tell exactly which table
 * answered (or didn't).
 *
 * Every builder here takes exactly ONE name (search help / view / tcode) and
 * still routes it through `inClause` with a one-element array, purely so the
 * escaping/validation path is identical to every other IN-list builder in
 * `img-query.ts` — not because more than one value is ever accepted.
 */
import {
  assertEntityName,
  assertImgLanguage,
  assertTransactionCode,
  buildSelect,
  fld,
  inClause,
  sqlLiteral as literal,
  tbl,
} from "./img-query.js";

// ------------------------------------------------------------ search help ---

/**
 * DD30L header row for one search help. Defaults to the active version
 * (`state = "A"`); pass `state = "N"` to read the inactive version instead —
 * `readSearchHelp`'s `includeInactive` fallback uses that to reach a search
 * help left behind by a create that put but failed to activate.
 */
export function buildSearchHelpHeaderQuery(name: string, state: "A" | "N" = "A"): string {
  const searchHelp = fld("searchHelpHeader", "searchHelp");
  const activeState = fld("searchHelpHeader", "activeState");
  const cols = (
    [
      "searchHelp",
      "activeState",
      "elementary",
      "includesExist",
      "attachmentsExist",
      "selectionMethod",
      "selectionMethodType",
      "textTable",
      "selectionExit",
      "hotKey",
      "dialogType",
    ] as const
  ).map((c) => fld("searchHelpHeader", c));
  const where = [inClause(searchHelp, [name], "name", assertEntityName), `${activeState} = ${literal(state)}`];
  return buildSelect(cols.join(", "), tbl("searchHelpHeader"), where);
}

/**
 * DD30T description of one search help, in one language. Defaults to the
 * active version (`state = "A"`); pass `state = "N"` to read the inactive
 * version instead (see `buildSearchHelpHeaderQuery`).
 */
export function buildSearchHelpTextQuery(name: string, language: string, state: "A" | "N" = "A"): string {
  const searchHelp = fld("searchHelpText", "searchHelp");
  const lang = fld("searchHelpText", "language");
  const activeState = fld("searchHelpText", "activeState");
  const text = fld("searchHelpText", "text");
  const where = [
    inClause(searchHelp, [name], "name", assertEntityName),
    `${lang} = ${literal(assertImgLanguage(language))}`,
    `${activeState} = ${literal(state)}`,
  ];
  return buildSelect(`${searchHelp}, ${text}`, tbl("searchHelpText"), where);
}

/**
 * DD31S included search helps of one search help, ordered by position.
 * Defaults to the active version (`state = "A"`); pass `state = "N"` to read
 * the inactive version instead (see `buildSearchHelpHeaderQuery`).
 */
export function buildSearchHelpIncludesQuery(name: string, state: "A" | "N" = "A"): string {
  const searchHelp = fld("searchHelpInclude", "searchHelp");
  const activeState = fld("searchHelpInclude", "activeState");
  const position = fld("searchHelpInclude", "position");
  const cols = (["searchHelp", "includedHelp", "position", "viaHelp", "hidden"] as const).map((c) =>
    fld("searchHelpInclude", c),
  );
  const where = [inClause(searchHelp, [name], "name", assertEntityName), `${activeState} = ${literal(state)}`];
  return buildSelect(cols.join(", "), tbl("searchHelpInclude"), where, position);
}

/**
 * DD32S parameters of one search help, ordered by position. Defaults to the
 * active version (`state = "A"`); pass `state = "N"` to read the inactive
 * version instead (see `buildSearchHelpHeaderQuery`).
 */
export function buildSearchHelpParamsQuery(name: string, state: "A" | "N" = "A"): string {
  const searchHelp = fld("searchHelpParam", "searchHelp");
  const activeState = fld("searchHelpParam", "activeState");
  const position = fld("searchHelpParam", "position");
  const cols = (
    [
      "searchHelp",
      "field",
      "position",
      "dataElement",
      "importFlag",
      "exportFlag",
      "selectionPosition",
      "listPosition",
      "defaultValue",
      "defaultType",
      "dataType",
      "length",
    ] as const
  ).map((c) => fld("searchHelpParam", c));
  const where = [inClause(searchHelp, [name], "name", assertEntityName), `${activeState} = ${literal(state)}`];
  return buildSelect(cols.join(", "), tbl("searchHelpParam"), where, position);
}

/**
 * DD33S parameter assignments of one search help, ordered by field. Defaults
 * to the active version (`state = "A"`); pass `state = "N"` to read the
 * inactive version instead (see `buildSearchHelpHeaderQuery`).
 */
export function buildSearchHelpAssignmentsQuery(name: string, state: "A" | "N" = "A"): string {
  const searchHelp = fld("searchHelpAssign", "searchHelp");
  const activeState = fld("searchHelpAssign", "activeState");
  const field = fld("searchHelpAssign", "field");
  const cols = (
    ["searchHelp", "field", "includedHelp", "includedField", "defaultValue", "defaultType", "valueDirection"] as const
  ).map((c) => fld("searchHelpAssign", c));
  const where = [inClause(searchHelp, [name], "name", assertEntityName), `${activeState} = ${literal(state)}`];
  return buildSelect(cols.join(", "), tbl("searchHelpAssign"), where, field);
}

/** DD04L data elements attaching this search help, active version only. */
export function buildSearchHelpUsingDataElementsQuery(name: string): string {
  const searchHelp = fld("dataElementHeader", "searchHelp");
  const activeState = fld("dataElementHeader", "activeState");
  const dataElement = fld("dataElementHeader", "dataElement");
  const cols = (["dataElement", "searchHelp", "searchHelpField"] as const).map((c) => fld("dataElementHeader", c));
  const where = [inClause(searchHelp, [name], "name", assertEntityName), `${activeState} = ${literal("A")}`];
  return buildSelect(cols.join(", "), tbl("dataElementHeader"), where, dataElement);
}

/** DD31S rows where this search help is INCLUDED by another (collective) search help, active version only. */
export function buildSearchHelpParentsQuery(name: string): string {
  const includedHelp = fld("searchHelpInclude", "includedHelp");
  const activeState = fld("searchHelpInclude", "activeState");
  const searchHelp = fld("searchHelpInclude", "searchHelp");
  const cols = (["searchHelp", "includedHelp", "position", "viaHelp", "hidden"] as const).map((c) =>
    fld("searchHelpInclude", c),
  );
  const where = [inClause(includedHelp, [name], "name", assertEntityName), `${activeState} = ${literal("A")}`];
  return buildSelect(cols.join(", "), tbl("searchHelpInclude"), where, searchHelp);
}

// ------------------------------------------------------------ classic view ---

/** DD25L header row for one classic view, active version only. */
export function buildViewHeaderDetailQuery(name: string): string {
  const view = fld("viewHeader", "view");
  const activeState = fld("viewHeader", "activeState");
  const cols = (
    [
      "view",
      "aggregateType",
      "rootTable",
      "viewClass",
      "readOnly",
      "viewGrant",
      "globalFlag",
      "applicationClass",
      "masterLanguage",
    ] as const
  ).map((c) => fld("viewHeader", c));
  const where = [inClause(view, [name], "name", assertEntityName), `${activeState} = ${literal("A")}`];
  return buildSelect(cols.join(", "), tbl("viewHeader"), where);
}

/** DD25T description of one view, active version only, in one language. */
export function buildViewTextDetailQuery(name: string, language: string): string {
  const view = fld("viewText", "view");
  const lang = fld("viewText", "language");
  const activeState = fld("viewText", "activeState");
  const text = fld("viewText", "text");
  const where = [
    inClause(view, [name], "name", assertEntityName),
    `${lang} = ${literal(assertImgLanguage(language))}`,
    `${activeState} = ${literal("A")}`,
  ];
  return buildSelect(`${view}, ${text}`, tbl("viewText"), where);
}

/** DD26S base tables of one view, active version only, ordered by position. */
export function buildViewBaseTablesDetailQuery(name: string): string {
  const view = fld("viewBaseTable", "view");
  const activeState = fld("viewBaseTable", "activeState");
  const position = fld("viewBaseTable", "position");
  const cols = (["view", "table", "position", "foreignTable", "foreignField", "foreignDirection"] as const).map((c) =>
    fld("viewBaseTable", c),
  );
  const where = [inClause(view, [name], "name", assertEntityName), `${activeState} = ${literal("A")}`];
  return buildSelect(cols.join(", "), tbl("viewBaseTable"), where, position);
}

/** DD27S field list of one view, active version only, ordered by position. */
export function buildViewFieldsDetailQuery(name: string): string {
  const view = fld("viewField", "view");
  const activeState = fld("viewField", "activeState");
  const position = fld("viewField", "position");
  const cols = (
    ["view", "viewField", "table", "field", "position", "keyFlag", "dataElement", "readOnly", "enqueueMode"] as const
  ).map((c) => fld("viewField", c));
  const where = [inClause(view, [name], "name", assertEntityName), `${activeState} = ${literal("A")}`];
  return buildSelect(cols.join(", "), tbl("viewField"), where, position);
}

/** TVDIR row for one view — no AS4LOCAL predicate: TVDIR has no active-version column. */
export function buildViewDirectoryDetailQuery(name: string): string {
  const view = fld("viewDirectory", "view");
  const cols = (["view", "area", "type", "baseTable", "generated", "package", "screen"] as const).map((c) =>
    fld("viewDirectory", c),
  );
  const where = [inClause(view, [name], "name", assertEntityName)];
  return buildSelect(cols.join(", "), tbl("viewDirectory"), where);
}

// ------------------------------------------------------------- transaction ---

/** TSTC row for one transaction code. */
export function buildTransactionDetailQuery(tcode: string): string {
  const transaction = fld("transaction", "transaction");
  const cols = (["transaction", "program", "dynpro", "classInfo", "messageArea"] as const).map((c) =>
    fld("transaction", c),
  );
  const where = [inClause(transaction, [tcode], "tcode", assertTransactionCode)];
  return buildSelect(cols.join(", "), tbl("transaction"), where);
}

/** TSTCT description of one transaction, in one language. */
export function buildTransactionTextDetailQuery(tcode: string, language: string): string {
  const transaction = fld("transactionText", "transaction");
  const lang = fld("transactionText", "language");
  const text = fld("transactionText", "text");
  const where = [
    inClause(transaction, [tcode], "tcode", assertTransactionCode),
    `${lang} = ${literal(assertImgLanguage(language))}`,
  ];
  return buildSelect(`${transaction}, ${text}`, tbl("transactionText"), where);
}

/** TSTCP call parameters of one transaction. */
export function buildTransactionParamQuery(tcode: string): string {
  const transaction = fld("transactionParam", "transaction");
  const cols = (["transaction", "parameters"] as const).map((c) => fld("transactionParam", c));
  const where = [inClause(transaction, [tcode], "tcode", assertTransactionCode)];
  return buildSelect(cols.join(", "), tbl("transactionParam"), where);
}

/** TSTCA authorisation-object checks of one transaction, ordered by authObject then authField. */
export function buildTransactionAuthQuery(tcode: string): string {
  const transaction = fld("transactionAuth", "transaction");
  const authObject = fld("transactionAuth", "authObject");
  const authField = fld("transactionAuth", "authField");
  const cols = (["transaction", "authObject", "authField", "authValue"] as const).map((c) =>
    fld("transactionAuth", c),
  );
  const where = [inClause(transaction, [tcode], "tcode", assertTransactionCode)];
  return buildSelect(cols.join(", "), tbl("transactionAuth"), where, `${authObject}, ${authField}`);
}

/** AGR_TCODES role menus containing one transaction, ordered by role. */
export function buildTransactionRolesQuery(tcode: string): string {
  const transaction = fld("roleTransaction", "transaction");
  const role = fld("roleTransaction", "role");
  const cols = (["role", "transaction"] as const).map((c) => fld("roleTransaction", c));
  const where = [inClause(transaction, [tcode], "tcode", assertTransactionCode)];
  return buildSelect(cols.join(", "), tbl("roleTransaction"), where, role);
}

// ------------------------------------------------------ TSTCP.PARAM parsing ---

export interface ParsedTransactionParameter {
  /**
   * "parameter" is the only kind these live-observed encodings ever produce.
   * "variant" is kept in the union for a TSTCP shape not yet observed here
   * (a transaction started with a fixed screen variant rather than field
   * assignments) — declared, not implemented; nothing below ever returns it.
   */
  kind: "variant" | "parameter" | "other";
  /** The transaction a "parameter transaction" ultimately starts, e.g. "SM30" out of "/*SM30 VIEWNAME=...", or the target of a "/N<TCODE>" switch. Undefined when no target could be identified. */
  target?: string;
  assignments: Array<{ name: string; value: string }>;
}

/**
 * Parses TSTCP-PARAM's live-observed encodings on A4H (measured 2026-09-12) —
 * does not invent shapes beyond these:
 *   - `/*<TCODE> NAME=VALUE;NAME=VALUE;...` — a parameter transaction that
 *     starts `<TCODE>` with a set of screen-field assignments, e.g.
 *     `/*SM30 VIEWNAME=/AIF/BDC_V_CONF;UPDATE=X;` or, with a dash in a name,
 *     `/*SM34 VCLDIR-VCLNAME=/AIF/ACTIONS;UPDATE=X;` -> kind "parameter".
 *   - `/N<TCODE>` (a bare "switch to another transaction, dropping the GUI
 *     stack" marker) -> kind "other", `target` set to the named tcode, no
 *     assignments — this is a redirect, not a set of screen-field values.
 *   - anything else -> kind "other", `target` undefined, `assignments: []`.
 * Never throws: an unparseable PARAM is a fact to report as "other", not a
 * caller-facing failure — TSTCP's format is not itself the object being
 * validated here.
 */
export function parseTransactionParameters(param: string): ParsedTransactionParameter {
  const trimmed = param.trim();

  const parameterMatch = /^\/\*(\S+)\s+(.*)$/.exec(trimmed);
  if (parameterMatch) {
    const target = parameterMatch[1]!;
    const rest = parameterMatch[2]!;
    const assignments: Array<{ name: string; value: string }> = [];
    for (const part of rest.split(";")) {
      const piece = part.trim();
      if (piece === "") continue;
      const eq = piece.indexOf("=");
      if (eq === -1) continue;
      const name = piece.slice(0, eq).trim();
      const value = piece.slice(eq + 1).trim();
      if (name === "") continue;
      assignments.push({ name, value });
    }
    return { kind: "parameter", target, assignments };
  }

  const switchMatch = /^\/N(\S+)$/i.exec(trimmed);
  if (switchMatch) {
    return { kind: "other", target: switchMatch[1]!.toUpperCase(), assignments: [] };
  }

  return { kind: "other", assignments: [] };
}
