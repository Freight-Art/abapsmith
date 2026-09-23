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
   * "parameter" — `/*<TCODE> ...` or `/N<TCODE>...`, a parameter
   * transaction. "variant" — `@<TCODE> <VARIANT>` / `@@<TCODE> <VARIANT>`, a
   * transaction+screen-variant pair. "oo" — either TSTCP shape for an OO
   * transaction: `/*OS_APPLICATION CLASS=...;METHOD=...;` (with transaction
   * model, {@link transactionModel} `true`) or `\[PROGRAM=...\]CLASS=...
   * \METHOD=...` (without, `transactionModel` `false`). "report-variant" —
   * a bare variant name with no target transaction (a report started with a
   * fixed variant). "other" — anything else.
   */
  kind: "parameter" | "variant" | "oo" | "report-variant" | "other";
  /** The transaction ultimately started — parameter, variant, oo ("OS_APPLICATION" for the transaction-model form). Undefined otherwise. */
  target?: string;
  /** Whether the target transaction's first screen is skipped (`/*` rather than `/N`) — parameter only. */
  skipFirstScreen?: boolean;
  /** Screen-field assignments (`NAME=VALUE;` pairs) — parameter only; `[]` otherwise. */
  assignments: Array<{ name: string; value: string }>;
  /** The screen variant name — variant, report-variant. */
  variant?: string;
  /** Whether the variant is cross-client (`@@`) rather than client-specific (`@`) — variant only. */
  crossClient?: boolean;
  /** The class implementing the transaction model — oo only. */
  className?: string;
  /** The method implementing the transaction model — oo only. */
  methodName?: string;
  /** OS_APPLICATION's UPDATE_MODE — oo, transaction-model form only. */
  updateMode?: string;
  /** `true` for the OS_APPLICATION (transaction-model) oo form, `false` for the `\CLASS=...\METHOD=...` form — oo only. */
  transactionModel?: boolean;
  /** The local program a `\PROGRAM=...\CLASS=...\METHOD=...` oo transaction's class lives in — oo, non-transaction-model form only, when present. */
  localProgram?: string;
}

function extractParamAssignments(rest: string): Array<{ name: string; value: string }> {
  const assignments: Array<{ name: string; value: string }> = [];
  const re = /([^\s=;]+)=([^;]*);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    assignments.push({ name: m[1]!, value: m[2]! });
  }
  return assignments;
}

/**
 * Decodes TSTCP-PARAM per the shapes `CL_TRAN_WBI_TSTCP_CODEC` (SAP's own
 * TSTCP encoder/decoder) uses, live-confirmed on A4H against
 * `/*<TCODE> NAME=VALUE;...` and `/N<TCODE>` on 2026-09-12:
 *   - `/*OS_APPLICATION CLASS=...;METHOD=...;[UPDATE_MODE=...;]` — an OO
 *     transaction WITH a transaction model -> kind "oo", `transactionModel`
 *     `true`, `target` "OS_APPLICATION".
 *   - `/*<TCODE> NAME=VALUE;...` (skip first screen) or `/N<TCODE>
 *     NAME=VALUE;...` (don't) — a parameter transaction -> kind
 *     "parameter", `skipFirstScreen` set accordingly, `assignments` the
 *     `NAME=VALUE` pairs (possibly none, e.g. bare `/N<TCODE>`).
 *   - `\[PROGRAM=...\]CLASS=...\METHOD=...` — an OO transaction with NO
 *     transaction model (no SAP API writes this shape; read-only here too)
 *     -> kind "oo", `transactionModel` false, `localProgram` set when a
 *     local class's owning program is present.
 *   - `@<TCODE> <VARIANT>` (client-specific) or `@@<TCODE> <VARIANT>`
 *     (cross-client) -> kind "variant".
 *   - a bare token with no whitespace and no target transaction -> kind
 *     "report-variant", `variant` set (a report started with a fixed
 *     variant).
 *   - anything else -> kind "other".
 * Never throws: an unparseable PARAM is a fact to report as "other", not a
 * caller-facing failure — TSTCP's format is not itself the object being
 * validated here.
 */
export function parseTransactionParameters(param: string): ParsedTransactionParameter {
  const trimmed = param.trim();

  if (/^\/\*OS_APPLICATION\s+CLASS=/.test(trimmed)) {
    const restMatch = /^\/\*OS_APPLICATION\s+(.*)$/.exec(trimmed);
    const rest = restMatch ? restMatch[1]! : "";
    const pairs = extractParamAssignments(rest);
    const byName = new Map(pairs.map((a) => [a.name, a.value]));
    return {
      kind: "oo",
      target: "OS_APPLICATION",
      transactionModel: true,
      className: byName.get("CLASS"),
      methodName: byName.get("METHOD"),
      updateMode: byName.get("UPDATE_MODE"),
      assignments: [],
    };
  }

  const parameterMatch = /^\/([*Nn])([^\s=;]+)\s*(.*)$/.exec(trimmed);
  if (parameterMatch) {
    const skipFirstScreen = parameterMatch[1] === "*";
    const target = parameterMatch[2]!.toUpperCase();
    const rest = parameterMatch[3]!;
    return { kind: "parameter", target, skipFirstScreen, assignments: extractParamAssignments(rest) };
  }

  const ooMatch = /^\\(?:PROGRAM=([^\\]+)\\)?CLASS=([^\\]+)\\METHOD=(.+)$/.exec(trimmed);
  if (ooMatch) {
    return {
      kind: "oo",
      transactionModel: false,
      className: ooMatch[2],
      methodName: ooMatch[3],
      ...(ooMatch[1] !== undefined ? { localProgram: ooMatch[1] } : {}),
      assignments: [],
    };
  }

  const variantMatch = /^@(@?)([^\s=;]+)\s+([^\s=;]+)$/.exec(trimmed);
  if (variantMatch) {
    return {
      kind: "variant",
      crossClient: variantMatch[1] === "@",
      target: variantMatch[2],
      variant: variantMatch[3],
      assignments: [],
    };
  }

  if (/^[^\s;]+$/.test(trimmed)) {
    return { kind: "report-variant", variant: trimmed, assignments: [] };
  }

  return { kind: "other", assignments: [] };
}
