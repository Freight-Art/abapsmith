/**
 * SQL builders and response mapping for the IMG (SPRO customizing) catalog
 * reads, sent as plain-text `SELECT`s to `POST /sap/bc/adt/datapreview/freestyle`.
 * Pure — no `AbapConnection`, no HTTP. `dataPreviewFreestyle` (a separate
 * connection.ts change) and a later orchestration layer own the actual call
 * and the paging/stitching across queries; this module only builds statement
 * text and maps a parsed response back into records.
 *
 * Endpoint constraints (live-proven, do not re-litigate):
 *   - the server appends its own `INTO TABLE @DATA(...) UP TO <rowNumber> ROWS .`,
 *     so an in-text `UP TO` is rejected and there is no `OFFSET` — paging here
 *     is keyset-only (see `afterPredicate`);
 *   - the request body is wrapped at 255 characters and a string literal
 *     that straddles that wrap fails with "text literal ... longer than 255
 *     characters" — every builder therefore emits multi-line SQL (newline
 *     between SELECT/FROM/WHERE/ORDER BY, and a long `IN (...)` list broken
 *     across lines too) and no builder may emit a line anywhere near that
 *     limit; `test/img-query.test.ts` asserts a 200-char line cap;
 *   - JOINs demonstrably work on this endpoint (`~`-qualified aliases, not
 *     `.`; no subselects) — the catalog-lookup builders below avoid them
 *     anyway, on purpose: one SELECT per catalog table keeps each query
 *     independently testable against `IMG_CATALOG` and keeps a joined
 *     result's column naming out of the picture for tables where it was
 *     never exercised. Do not "optimise" those back into a JOIN. The tree
 *     walk builders (`buildTreeChildrenQuery`, `buildTreeNodeQuery`) are the
 *     deliberate exception — TNODEIMG has no title column, so attaching one
 *     from TNODEIMGT genuinely needs a join, and that shape was proven live;
 *     `test/img-query.test.ts` scopes its no-JOIN sweep to the builders that
 *     don't need one rather than pretending these two don't have one;
 *   - an explicit column list has, on at least one table, failed with a
 *     grammar error ("AN" is invalid here) where `SELECT *` on the same
 *     table succeeded, for a reason not yet understood. Column lists stay
 *     the rule here regardless — `SELECT *` can't be matched against
 *     `IMG_CATALOG` field names — but if a builder in this file ever throws
 *     that same grammar error against a live system, `SELECT *` is the
 *     known fallback to try, not a new mystery.
 *
 * Every table/field name below is read from `IMG_CATALOG` — see `tbl`/`fld`.
 * The tree-walk builders additionally use two fixed, hardcoded join aliases
 * ("n", "t") — never derived from caller input — plus `IMG_ACTIVITY_REF_TYPE`
 * and `IMG_TREE_TEXT_PROBE`, both catalog constants, not caller values.
 */
import { AbapError } from "./errors.js";
import { IMG_ACTIVITY_REF_TYPE, IMG_CATALOG, IMG_TREE_TEXT_PROBE, type ImgCatalogKey } from "./img-catalog.js";
import { abapLiteral, assertAbapText } from "./enhancement-templates.js";
import { parsePreviewBody, isValidDdicEntityName, type PreviewMessage } from "./datapreview.js";
import { ECHO_LINE_MAX, truncateForDisplay } from "../truncate.js";

// --------------------------------------------------------------- literals ---

/**
 * SQL string literal: quotes single quotes the same way an ABAP literal does
 * (doubled). Open SQL and ABAP source share that escaping convention, so
 * this is `enhancement-templates.ts`'s `abapLiteral` under the name this
 * module's callers expect, not a reimplementation.
 */
export function sqlLiteral(value: string): string {
  return abapLiteral(value);
}

/**
 * Generic gate before any value is embedded in generated SQL: rejects a
 * non-string, anything over `maxLen`, and control characters (a raw newline
 * in a caller value could not just corrupt structure but, now that clauses
 * are joined with real newlines, would be indistinguishable from one).
 * Reused from `enhancement-templates.ts`'s `assertAbapText` — same
 * requirement, same fix.
 */
export function assertSqlValue(value: string, what: string, maxLen = 60): string {
  return assertAbapText(value, what, maxLen);
}

// -------------------------------------------------------- catalog lookups ---

function tbl<K extends ImgCatalogKey>(key: K): string {
  return IMG_CATALOG[key].table;
}

function fld<K extends ImgCatalogKey, F extends keyof (typeof IMG_CATALOG)[K]["fields"]>(key: K, field: F): string {
  // Cast only works around TS2536 (a generic key can't double-index the catalog type
  // directly) — `field`'s type is still tied to this specific K, so a typo stays a
  // compile error.
  const fields = IMG_CATALOG[key].fields as Record<F, string>;
  return fields[field];
}

// -------------------------------------------------------- value validators ---

/**
 * CUS_IMGACH.ACTIVITY is up to 20 characters, mixed-case and frequently
 * namespace-prefixed (e.g. "/IWBEP/BATCH_CONFIG") — measured against a live
 * system. Never upper-cased: unlike a DDIC object name, case here is part of
 * the key's identity, not a display convention.
 */
const ID_CHARSET_RE = /^[A-Za-z0-9_./-]+$/;

function assertActivityId(value: string, what = "activity"): string {
  const v = assertSqlValue(value, what, 20);
  if (v.trim() === "" || !ID_CHARSET_RE.test(v)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} "${value}" must be 1-20 characters of letters, digits, "_", ".", "/" or "-".`,
      { what, value },
    );
  }
  return v;
}

/** CUS_ACTH/CUS_ACTOBJ.ACT_ID — same charset as an activity id, a longer domain. */
function assertActId(value: string, what = "actId"): string {
  const v = assertSqlValue(value, what, 30);
  if (v.trim() === "" || !ID_CHARSET_RE.test(v)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} "${value}" must be 1-30 characters of letters, digits, "_", ".", "/" or "-".`,
      { what, value },
    );
  }
  return v;
}

/**
 * A DDIC-catalogued name (table, view, view cluster or OBJH/OBJS/CUS_ACTOBJ
 * object name) — reuses `datapreview.ts`'s already-tested `isValidDdicEntityName`,
 * which (unlike an activity id) expects and enforces an upper-cased name.
 */
function assertEntityName(value: string, what = "name"): string {
  const raw = assertSqlValue(value, what, 30);
  const v = raw.trim().toUpperCase();
  if (!isValidDdicEntityName(v)) {
    throw new AbapError("BAD_INPUT", `${what} "${value}" is not a valid DDIC table/view/object name.`, { what, value });
  }
  return v;
}

function assertLanguage(value: string): string {
  const v = assertSqlValue(value, "language", 2).trim();
  if (!/^[A-Za-z]{1,2}$/.test(v)) {
    throw new AbapError("BAD_INPUT", `language "${value}" must be exactly 1 or 2 letters.`, { value });
  }
  return v.toUpperCase();
}

/** TCODE is not a DDIC entity name (no PLAIN_NAME_RE/NAMESPACED_NAME_RE shape guarantee) but is stored upper-case. */
function assertTransactionCode(value: string, what = "tcode"): string {
  const v = assertSqlValue(value, what, 20).trim().toUpperCase();
  if (v === "" || !ID_CHARSET_RE.test(v)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} "${value}" must be 1-20 characters of letters, digits, "_", ".", "/" or "-".`,
      { what, value },
    );
  }
  return v;
}

/**
 * TNODEIMG/TNODEIMGT/TNODEIMGR/TTREE key values (TREE_ID, NODE_ID,
 * PARENT_ID, ...) are a DDIC CHAR 32 domain, not a GUID type — on the
 * system this was measured against they happen to render as 32-character
 * uppercase hex, but that is an instance property of that system, not a
 * contract, so this deliberately does NOT add a hex-shaped charset check
 * the way assertActivityId/assertEntityName add one for their domains.
 * Length (the field's DDIC length) plus the shared control-character/
 * newline gate is all that's enforced.
 */
function assertTreeKeyValue(value: string, what: string): string {
  return assertSqlValue(value, what, 32);
}

/**
 * '#' is both a legal input character and the LIKE escape character, so a
 * caller's literal '#' must be doubled before '_' gets escaped with it —
 * otherwise a raw '#' in the query would be read as the start of an escape
 * sequence by the database.
 *
 * This used to be duplicated, on purpose, with a same-named function in the
 * now-deleted `img-bridge.ts` (importing it would have pulled `run.ts`'s
 * deploy/execute machinery into this module, which must stay free of I/O).
 * This is now the sole implementation; nothing else needs to stay in
 * lockstep with it any more.
 */
export function imgLikePattern(raw: string): { literal: string; escapeChar: string } {
  const trimmed = raw.trim();
  if (trimmed === "" || !/^[A-Za-z0-9_/*.\-# ]{1,40}$/.test(trimmed)) {
    throw new AbapError(
      "BAD_INPUT",
      `text "${raw}" may only contain letters, digits, underscore, "/", "*" (wildcard), ".", "-", "#" or space, 1-40 chars.`,
      { value: raw },
    );
  }
  const escapeChar = "#";
  const hasWildcard = trimmed.includes("*");
  const escaped = trimmed.replace(/#/g, "##").replace(/_/g, "#_").replace(/\*/g, "%");
  // A bare term (no '*') is a title-word search, not an exact id — wrap it so it matches as a substring.
  const literal = hasWildcard ? escaped : `%${escaped}%`;
  return { literal: literal.replace(/'/g, "''"), escapeChar };
}

// ----------------------------------------------------------------- IN (…) ---

/** Cap on values per `IN (…)`; exported so a caller with more values chunks into multiple statements. */
export const MAX_IN_LIST = 50;

export function assertInList<T>(values: readonly T[], what: string): readonly T[] {
  if (values.length === 0) {
    throw new AbapError("BAD_INPUT", `${what} must not be empty — "IN ()" is not valid SQL.`, { what });
  }
  if (values.length > MAX_IN_LIST) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} has ${values.length} values, over the ${MAX_IN_LIST}-value cap per statement — chunk the caller's list into multiple queries.`,
      { what, count: values.length, cap: MAX_IN_LIST },
    );
  }
  return values;
}

// Every id this file puts in an IN (…) is capped at 32 characters (the widest
// current cap — assertTreeKeyValue's CHAR 32 domain), so even at the 50-value
// list cap, 5 quoted literals per line is 5 x (32 + 2 quotes + 2 separator) +
// 2 indent = 182 chars — comfortably under the real 255-char request-body
// wrap (see file header), not the 200-char margin this test suite happens to
// assert. That arithmetic is a reason to expect this stays safe today, not a
// guarantee: it silently assumed every value validator stays this short, and
// nothing here enforced that assumption. The actual guarantee is the line
// check in `buildSelect` below, which throws before any line over the real
// wrap limit leaves this module — this constant is only how comfortably
// clear of that check normal output stays, not what holds the line.
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

function inClause(
  column: string,
  values: readonly string[],
  what: string,
  assertValue: (v: string, what: string) => string,
): string {
  const checked = assertInList(values, what);
  const literals = checked.map((v) => sqlLiteral(assertValue(v, what)));
  return inPredicate(column, literals);
}

// ------------------------------------------------------------------ paging ---

/**
 * The freestyle endpoint has no `OFFSET` (see file header) — every paged
 * builder here takes an optional `after` keyset value instead of a page
 * number, emitting `<keyfield> > '<after>'` plus `ORDER BY <keyfield>`.
 */
function afterPredicate(column: string, after: string | undefined, assertValue: (v: string, what: string) => string): string | undefined {
  if (after === undefined) return undefined;
  return `${column} > ${sqlLiteral(assertValue(after, "after"))}`;
}

// ------------------------------------------------------------------ assembly ---

// The freestyle endpoint wraps (and mis-parses) any request-body line over
// this many characters (see file header) — a real, live failure mode, not a
// theoretical one.
export const IMG_SQL_LINE_MAX = 255;

/**
 * Assembles a SELECT statement and enforces the one invariant every builder
 * in this file depends on: no emitted line may exceed the freestyle
 * endpoint's request-body wrap limit. Every builder returns through this
 * function, so this is the single place that check needs to live — no
 * builder-local reasoning about id lengths or list sizes can substitute for
 * it, because that reasoning can go stale the moment a new builder or a
 * looser validator is added.
 *
 * Exported (like `buildSelect`'s counterpart in `ddicBridgeSource`) so a
 * test can drive this guard directly with a synthetic input, since no
 * current public builder's own validators allow constructing a line long
 * enough to trip it.
 */
export function buildSelect(select: string, from: string, whereParts: readonly string[], orderBy?: string): string {
  const lines = [`SELECT ${select}`, `FROM ${from}`];
  whereParts.forEach((part, i) => {
    lines.push(`${i === 0 ? "WHERE" : "  AND"} ${part}`);
  });
  if (orderBy !== undefined) lines.push(`ORDER BY ${orderBy}`);
  const statement = lines.join("\n");
  statement.split("\n").forEach((line, i) => {
    if (line.length > IMG_SQL_LINE_MAX) {
      const excerpt = truncateForDisplay(line, ECHO_LINE_MAX);
      throw new AbapError(
        "CHECK_FAILED",
        `Generated IMG query line ${i + 1} is ${line.length} chars, over the freestyle ` +
          `endpoint's ${IMG_SQL_LINE_MAX}-char request-body line limit: ${excerpt}`,
        { line: i + 1, length: line.length, excerpt },
      );
    }
  });
  return statement;
}

// ------------------------------------------------------------------ builders ---

/** Activities whose id matches `pattern` (CUS_IMGACH), keyset-paged on ACTIVITY. */
export function buildActivityIdSearchQuery(pattern: string, after?: string): string {
  const activity = fld("imgActivity", "activity");
  const { literal, escapeChar } = imgLikePattern(pattern);
  const where = [`${activity} LIKE '${literal}' ESCAPE '${escapeChar}'`];
  const afterPred = afterPredicate(activity, after, assertActivityId);
  if (afterPred !== undefined) where.push(afterPred);
  return buildSelect(activity, tbl("imgActivity"), where, activity);
}

/** Activities whose title matches `pattern` (CUS_IMGACT), filtered by language, keyset-paged on ACTIVITY. */
export function buildActivityTitleSearchQuery(pattern: string, language: string, after?: string): string {
  const activity = fld("imgActivityText", "activity");
  const lang = fld("imgActivityText", "language");
  const text = fld("imgActivityText", "text");
  const { literal, escapeChar } = imgLikePattern(pattern);
  const where = [`${lang} = ${sqlLiteral(assertLanguage(language))}`, `${text} LIKE '${literal}' ESCAPE '${escapeChar}'`];
  const afterPred = afterPredicate(activity, after, assertActivityId);
  if (afterPred !== undefined) where.push(afterPred);
  return buildSelect(`${activity}, ${text}`, tbl("imgActivityText"), where, activity);
}

/** One activity's header row (CUS_IMGACH by ACTIVITY). */
export function buildActivityHeaderQuery(activity: string): string {
  const a = assertActivityId(activity, "activity");
  const cols = (["activity", "cActivity", "docId", "attributes"] as const).map((c) => fld("imgActivity", c));
  return buildSelect(cols.join(", "), tbl("imgActivity"), [`${fld("imgActivity", "activity")} = ${sqlLiteral(a)}`]);
}

/** Activity titles for a set of activity ids (CUS_IMGACT by SPRAS and ACTIVITY IN (…)). */
export function buildActivityTitlesQuery(activities: readonly string[], language: string): string {
  const activity = fld("imgActivityText", "activity");
  const lang = fld("imgActivityText", "language");
  const text = fld("imgActivityText", "text");
  const where = [
    `${lang} = ${sqlLiteral(assertLanguage(language))}`,
    inClause(activity, activities, "activities", assertActivityId),
  ];
  return buildSelect(`${activity}, ${text}`, tbl("imgActivityText"), where);
}

/**
 * CUS_ACTH rows for a set of ACT_IDs. The catalog records only ACT_ID for
 * this table (see `img-catalog.ts`), so this is an existence check on the
 * activity->object chain's middle link, not a data fetch.
 */
export function buildActivityHeadersByIdQuery(actIds: readonly string[]): string {
  const actId = fld("cusActivityHeader", "actId");
  return buildSelect(actId, tbl("cusActivityHeader"), [inClause(actId, actIds, "actIds", assertActId)]);
}

/** CUS_ACTOBJ rows for a set of ACT_IDs. */
export function buildActivityObjectsQuery(actIds: readonly string[]): string {
  const actId = fld("imgActivityObject", "actId");
  const cols = (["actId", "objectType", "object", "tcode", "subObjName"] as const).map((c) => fld("imgActivityObject", c));
  return buildSelect(cols.join(", "), tbl("imgActivityObject"), [inClause(actId, actIds, "actIds", assertActId)]);
}

/** OBJH rows for a set of OBJECTNAMEs. */
export function buildObjectHeadersQuery(objectNames: readonly string[]): string {
  const object = fld("cusObjectHeader", "object");
  const objectType = fld("cusObjectHeader", "objectType");
  return buildSelect(`${object}, ${objectType}`, tbl("cusObjectHeader"), [
    inClause(object, objectNames, "objectNames", assertEntityName),
  ]);
}

/** OBJS rows for a set of OBJECTNAMEs. */
export function buildObjectTablesQuery(objectNames: readonly string[]): string {
  const object = fld("cusObjectTable", "object");
  const objectType = fld("cusObjectTable", "objectType");
  const table = fld("cusObjectTable", "table");
  return buildSelect(`${object}, ${objectType}, ${table}`, tbl("cusObjectTable"), [
    inClause(object, objectNames, "objectNames", assertEntityName),
  ]);
}

/** OBJT texts for a set of OBJECTNAMEs in a language. */
export function buildObjectTextsQuery(objectNames: readonly string[], language: string): string {
  const object = fld("cusObjectText", "object");
  const objectType = fld("cusObjectText", "objectType");
  const lang = fld("cusObjectText", "language");
  const text = fld("cusObjectText", "text");
  const where = [
    `${lang} = ${sqlLiteral(assertLanguage(language))}`,
    inClause(object, objectNames, "objectNames", assertEntityName),
  ];
  return buildSelect(`${object}, ${objectType}, ${text}`, tbl("cusObjectText"), where);
}

/** DD02L delivery class / client dependence for a set of TABNAMEs, active versions only. */
export function buildTableDeliveryClassQuery(tableNames: readonly string[]): string {
  const table = fld("ddicTable", "table");
  const deliveryClass = fld("ddicTable", "deliveryClass");
  const clientDependent = fld("ddicTable", "clientDependent");
  const activeState = fld("ddicTable", "activeState");
  const where = [`${activeState} = ${sqlLiteral("A")}`, inClause(table, tableNames, "tableNames", assertEntityName)];
  return buildSelect(`${table}, ${deliveryClass}, ${clientDependent}`, tbl("ddicTable"), where);
}

/** TVDIR rows for a set of view names. */
export function buildViewDirectoryQuery(viewNames: readonly string[]): string {
  const view = fld("viewDirectory", "view");
  const cols = (["view", "area", "type", "baseTable", "generated"] as const).map((c) => fld("viewDirectory", c));
  return buildSelect(cols.join(", "), tbl("viewDirectory"), [inClause(view, viewNames, "viewNames", assertEntityName)]);
}

/** VCLDIR rows for a set of view cluster names. */
export function buildViewClusterQuery(clusterNames: readonly string[]): string {
  const cluster = fld("viewCluster", "cluster");
  return buildSelect(cluster, tbl("viewCluster"), [inClause(cluster, clusterNames, "clusterNames", assertEntityName)]);
}

/** VCLDIRT texts for a set of view cluster names in a language. */
export function buildViewClusterTextQuery(clusterNames: readonly string[], language: string): string {
  const cluster = fld("viewClusterText", "cluster");
  const lang = fld("viewClusterText", "language");
  const text = fld("viewClusterText", "text");
  const where = [
    `${lang} = ${sqlLiteral(assertLanguage(language))}`,
    inClause(cluster, clusterNames, "clusterNames", assertEntityName),
  ];
  return buildSelect(`${cluster}, ${text}`, tbl("viewClusterText"), where);
}

/** VCLSTRUC members for a set of view cluster names, ordered for display. */
export function buildViewClusterMembersQuery(clusterNames: readonly string[]): string {
  const cluster = fld("viewClusterMember", "cluster");
  const object = fld("viewClusterMember", "object");
  const objPos = fld("viewClusterMember", "objPos");
  const objLevel = fld("viewClusterMember", "objLevel");
  const where = [inClause(cluster, clusterNames, "clusterNames", assertEntityName)];
  return buildSelect(`${cluster}, ${object}, ${objPos}, ${objLevel}`, tbl("viewClusterMember"), where, `${cluster}, ${objPos}`);
}

/**
 * DD03L fields for a set of tables, active version only, one row per field.
 * A wide table can return many rows — that's a row-count concern for the
 * caller/endpoint (`rowNumber`), not something this builder controls; the
 * 50-item cap below is on the table name list, not on the row count.
 */
export function buildTableFieldsQuery(tableNames: readonly string[]): string {
  const table = fld("ddicField", "table");
  const activeState = fld("ddicField", "activeState");
  const cols = (["table", "field", "position", "keyFlag", "dataType", "length", "dataElement"] as const).map((c) =>
    fld("ddicField", c),
  );
  const where = [`${activeState} = ${sqlLiteral("A")}`, inClause(table, tableNames, "tableNames", assertEntityName)];
  return buildSelect(cols.join(", "), tbl("ddicField"), where, `${table}, ${fld("ddicField", "position")}`);
}

/** DD02T table descriptions for a set of tables, active version only, in one language. */
export function buildTableTextsQuery(tableNames: readonly string[], language: string): string {
  const table = fld("ddicTableText", "table");
  const activeState = fld("ddicTableText", "activeState");
  const lang = fld("ddicTableText", "language");
  const text = fld("ddicTableText", "text");
  const where = [
    `${activeState} = ${sqlLiteral("A")}`,
    `${lang} = ${sqlLiteral(assertLanguage(language))}`,
    inClause(table, tableNames, "tableNames", assertEntityName),
  ];
  return buildSelect(`${table}, ${text}`, tbl("ddicTableText"), where);
}

/** DD25L view headers for a set of views, active version only. */
export function buildViewHeaderQuery(viewNames: readonly string[]): string {
  const view = fld("viewHeader", "view");
  const activeState = fld("viewHeader", "activeState");
  const cols = (["view", "aggregateType", "rootTable"] as const).map((c) => fld("viewHeader", c));
  const where = [`${activeState} = ${sqlLiteral("A")}`, inClause(view, viewNames, "viewNames", assertEntityName)];
  return buildSelect(cols.join(", "), tbl("viewHeader"), where);
}

/** DD25T view descriptions for a set of views, active version only, in one language. */
export function buildViewTextQuery(viewNames: readonly string[], language: string): string {
  const view = fld("viewText", "view");
  const activeState = fld("viewText", "activeState");
  const lang = fld("viewText", "language");
  const text = fld("viewText", "text");
  const where = [
    `${activeState} = ${sqlLiteral("A")}`,
    `${lang} = ${sqlLiteral(assertLanguage(language))}`,
    inClause(view, viewNames, "viewNames", assertEntityName),
  ];
  return buildSelect(`${view}, ${text}`, tbl("viewText"), where);
}

/** DD26S base tables for a set of views, active version only, ordered for display. */
export function buildViewBaseTablesQuery(viewNames: readonly string[]): string {
  const view = fld("viewBaseTable", "view");
  const activeState = fld("viewBaseTable", "activeState");
  const table = fld("viewBaseTable", "table");
  const position = fld("viewBaseTable", "position");
  const where = [`${activeState} = ${sqlLiteral("A")}`, inClause(view, viewNames, "viewNames", assertEntityName)];
  return buildSelect(`${view}, ${table}, ${position}`, tbl("viewBaseTable"), where, `${view}, ${position}`);
}

/** DD27S field list for a set of views, active version only, ordered for display. */
export function buildViewFieldsQuery(viewNames: readonly string[]): string {
  const view = fld("viewField", "view");
  const activeState = fld("viewField", "activeState");
  const cols = (["view", "viewField", "table", "field", "position"] as const).map((c) => fld("viewField", c));
  const where = [`${activeState} = ${sqlLiteral("A")}`, inClause(view, viewNames, "viewNames", assertEntityName)];
  return buildSelect(cols.join(", "), tbl("viewField"), where, `${view}, ${fld("viewField", "position")}`);
}

/** TSTC rows for a set of transaction codes. */
export function buildTransactionsQuery(tcodes: readonly string[]): string {
  const tcode = fld("transaction", "transaction");
  const cols = (["transaction", "program", "dynpro"] as const).map((c) => fld("transaction", c));
  return buildSelect(cols.join(", "), tbl("transaction"), [inClause(tcode, tcodes, "tcodes", assertTransactionCode)]);
}

/** TSTCT texts for a set of transaction codes, in one language. */
export function buildTransactionTextsQuery(tcodes: readonly string[], language: string): string {
  const tcode = fld("transactionText", "transaction");
  const lang = fld("transactionText", "language");
  const text = fld("transactionText", "text");
  const where = [
    `${lang} = ${sqlLiteral(assertLanguage(language))}`,
    inClause(tcode, tcodes, "tcodes", assertTransactionCode),
  ];
  return buildSelect(`${tcode}, ${text}`, tbl("transactionText"), where);
}

// -------------------------------------------------------------- tree walk ---

/**
 * Finds the reference IMG tree by title, since it has no mnemonic id — a
 * probe of common candidate ids (SIMG, SIMG_ALL, IMG, CUST) against TTREE.ID
 * returned 0 rows on a live system, and the GUID otherwise differs per
 * system. `IMG_TREE_TEXT_PROBE` is English text ("SAP Customizing
 * Implementation..."); `language` only selects which TNODEIMGT row is
 * returned once a tree is found by that English prefix, so this probe
 * degrades — finds nothing — on a system with no English IMG texts. That is
 * a real, known limitation, not an oversight.
 */
export function buildTreeRootProbeQuery(language: string): string {
  const treeId = fld("imgTreeNodeText", "treeId");
  const nodeId = fld("imgTreeNodeText", "nodeId");
  const lang = fld("imgTreeNodeText", "language");
  const text = fld("imgTreeNodeText", "text");
  const { literal, escapeChar } = imgLikePattern(`${IMG_TREE_TEXT_PROBE}*`);
  const where = [`${lang} = ${sqlLiteral(assertLanguage(language))}`, `${text} LIKE '${literal}' ESCAPE '${escapeChar}'`];
  return buildSelect(`${treeId}, ${nodeId}, ${lang}, ${text}`, tbl("imgTreeNodeText"), where);
}

/**
 * One level of TNODEIMG children with their TNODEIMGT title (LEFT OUTER —
 * an activity leaf frequently has no text row, and a missing title must not
 * drop the node). `ORDER BY n~NODE_ID` is GUID order, chosen only to make
 * keyset paging possible — it is NOT display order.
 *
 * Display order is the BROTHER_ID linked list, but the direction is easy to
 * get backwards: BROTHER_ID names the PREVIOUS sibling, not the next one.
 * The child whose BROTHER_ID is blank is the FIRST child; each following
 * sibling is the node whose BROTHER_ID names the one already placed. That
 * chain is not guaranteed to be a clean list either — some parents have
 * several children sharing one BROTHER_ID value, and a BROTHER_ID that
 * points outside the sibling set — so a walker must start at the blank
 * node, stop on a revisit, and append whatever it never reached rather than
 * assume a perfect list. Walking the chain is the caller's job, not this
 * builder's.
 *
 * REFTREE_ID/REFNODE_ID identify where a REF node's own children actually
 * live (a mounted tree + entry node, not this tree). REFNODE_ID can come
 * back blank even when REFTREE_ID is set; the fallback then is
 * `buildTreeDirectoryQuery` to find that tree's root, not the normal path.
 */
export function buildTreeChildrenQuery(treeId: string, parentId: string, language: string, after?: string): string {
  const node = tbl("imgTreeNode");
  const nodeText = tbl("imgTreeNodeText");
  const treeIdF = fld("imgTreeNode", "treeId");
  const nodeIdF = fld("imgTreeNode", "nodeId");
  const parentIdF = fld("imgTreeNode", "parentId");
  const nodeTypeF = fld("imgTreeNode", "nodeType");
  const brotherIdF = fld("imgTreeNode", "brotherId");
  const refTreeIdF = fld("imgTreeNode", "refTreeId");
  const refNodeIdF = fld("imgTreeNode", "refNodeId");
  const textLangF = fld("imgTreeNodeText", "language");
  const textNodeIdF = fld("imgTreeNodeText", "nodeId");
  const textTreeIdF = fld("imgTreeNodeText", "treeId");
  const textF = fld("imgTreeNodeText", "text");
  const select = [
    `n~${nodeIdF}`,
    `n~${nodeTypeF}`,
    `n~${parentIdF}`,
    `n~${brotherIdF}`,
    `n~${refTreeIdF}`,
    `n~${refNodeIdF}`,
    `t~${textF}`,
  ].join(", ");
  const from =
    `${node} AS n\n` +
    `LEFT OUTER JOIN ${nodeText} AS t ON t~${textTreeIdF} = n~${treeIdF}\n` +
    `  AND t~${textNodeIdF} = n~${nodeIdF} AND t~${textLangF} = ${sqlLiteral(assertLanguage(language))}`;
  const where = [
    `n~${treeIdF} = ${sqlLiteral(assertTreeKeyValue(treeId, "treeId"))}`,
    `n~${parentIdF} = ${sqlLiteral(assertTreeKeyValue(parentId, "parentId"))}`,
  ];
  const afterPred = afterPredicate(`n~${nodeIdF}`, after, assertTreeKeyValue);
  if (afterPred !== undefined) where.push(afterPred);
  return buildSelect(select, from, where, `n~${nodeIdF}`);
}

/** A single TNODEIMG node with the same column set as `buildTreeChildrenQuery`, so a REF mount can be followed. */
export function buildTreeNodeQuery(treeId: string, nodeId: string, language: string): string {
  const node = tbl("imgTreeNode");
  const nodeText = tbl("imgTreeNodeText");
  const treeIdF = fld("imgTreeNode", "treeId");
  const nodeIdF = fld("imgTreeNode", "nodeId");
  const parentIdF = fld("imgTreeNode", "parentId");
  const nodeTypeF = fld("imgTreeNode", "nodeType");
  const brotherIdF = fld("imgTreeNode", "brotherId");
  const refTreeIdF = fld("imgTreeNode", "refTreeId");
  const refNodeIdF = fld("imgTreeNode", "refNodeId");
  const textLangF = fld("imgTreeNodeText", "language");
  const textNodeIdF = fld("imgTreeNodeText", "nodeId");
  const textTreeIdF = fld("imgTreeNodeText", "treeId");
  const textF = fld("imgTreeNodeText", "text");
  const select = [
    `n~${nodeIdF}`,
    `n~${nodeTypeF}`,
    `n~${parentIdF}`,
    `n~${brotherIdF}`,
    `n~${refTreeIdF}`,
    `n~${refNodeIdF}`,
    `t~${textF}`,
  ].join(", ");
  const from =
    `${node} AS n\n` +
    `LEFT OUTER JOIN ${nodeText} AS t ON t~${textTreeIdF} = n~${treeIdF}\n` +
    `  AND t~${textNodeIdF} = n~${nodeIdF} AND t~${textLangF} = ${sqlLiteral(assertLanguage(language))}`;
  const where = [
    `n~${treeIdF} = ${sqlLiteral(assertTreeKeyValue(treeId, "treeId"))}`,
    `n~${nodeIdF} = ${sqlLiteral(assertTreeKeyValue(nodeId, "nodeId"))}`,
  ];
  return buildSelect(select, from, where);
}

/** TNODEIMGR rows for a batch of node ids, restricted to the COBJ (customizing-object) reference type. */
export function buildNodeRefsQuery(nodeIds: readonly string[]): string {
  const nodeIdF = fld("imgTreeNodeRef", "nodeId");
  const extKeyF = fld("imgTreeNodeRef", "extKey");
  const refTypeF = fld("imgTreeNodeRef", "refType");
  const refObjectF = fld("imgTreeNodeRef", "refObject");
  const where = [
    `${refTypeF} = ${sqlLiteral(IMG_ACTIVITY_REF_TYPE)}`,
    inClause(nodeIdF, nodeIds, "nodeIds", assertTreeKeyValue),
  ];
  return buildSelect(`${nodeIdF}, ${extKeyF}, ${refTypeF}, ${refObjectF}`, tbl("imgTreeNodeRef"), where);
}

/**
 * Inverse of `buildNodeRefsQuery`: given a customizing-activity id and a
 * TNODEIMGR.REF_TYPE (normally `IMG_ACTIVITY_REF_TYPE`), finds the node
 * id(s) that mount it. `refObject` is validated as an activity id
 * (CUS_IMGACH.ACTIVITY / CUS_ACTOBJ.ACT_ID shape) since that is the only
 * REF_OBJECT domain this module's callers ever look up by; `refType` is a
 * short catalogued literal (`assertSqlValue`, not a charset-specific
 * validator — there is no fixed enum of REF_TYPE values documented here).
 *
 * TNODEIMGR has no TREE_ID column (see `IMG_CATALOG.imgTreeNodeRef`'s own
 * note), so this alone cannot tell a caller which tree a returned NODE_ID
 * lives in — pair it with `buildTreeNodeByIdQuery` to learn that.
 */
export function buildNodesByRefObjectQuery(refObject: string, refType: string): string {
  const nodeIdF = fld("imgTreeNodeRef", "nodeId");
  const refTypeF = fld("imgTreeNodeRef", "refType");
  const refObjectF = fld("imgTreeNodeRef", "refObject");
  const where = [
    `${refObjectF} = ${sqlLiteral(assertActivityId(refObject, "refObject"))}`,
    `${refTypeF} = ${sqlLiteral(assertSqlValue(refType, "refType", 10))}`,
  ];
  return buildSelect(`${nodeIdF}, ${refTypeF}, ${refObjectF}`, tbl("imgTreeNodeRef"), where, nodeIdF);
}

/**
 * Not part of the teammate's literal ask, but required to act on its
 * result: `buildNodesByRefObjectQuery` above returns a bare NODE_ID with no
 * TREE_ID (TNODEIMGR has none), while `buildTreeNodeQuery` — the builder
 * named for the ancestor walk — requires a `treeId` argument to run at
 * all. This is the same TNODEIMG/TNODEIMGT LEFT JOIN as
 * `buildTreeNodeQuery`, scoped by NODE_ID alone (no TREE_ID predicate) and
 * with TREE_ID added to the SELECT list, so a caller can bootstrap: run
 * this once for the REF-mounted node id to learn its tree, then use
 * `buildTreeNodeQuery` (which already knows the tree) for every step after
 * that.
 *
 * TNODEIMG's own documented key is TREE_ID+EXTENSION+NODE_ID+EXT_KEY, not
 * NODE_ID alone, so a NODE_ID-only WHERE can legitimately return more than
 * one row (a real cross-tree id collision, or an EXTENSION/EXT_KEY variant
 * — both already ignored the same way by `buildTreeNodeQuery`, which never
 * filters on either). The caller is responsible for treating more than one
 * returned row as a fact to report, not to pick from silently.
 */
export function buildTreeNodeByIdQuery(nodeId: string, language: string): string {
  const node = tbl("imgTreeNode");
  const nodeText = tbl("imgTreeNodeText");
  const treeIdF = fld("imgTreeNode", "treeId");
  const nodeIdF = fld("imgTreeNode", "nodeId");
  const parentIdF = fld("imgTreeNode", "parentId");
  const nodeTypeF = fld("imgTreeNode", "nodeType");
  const brotherIdF = fld("imgTreeNode", "brotherId");
  const refTreeIdF = fld("imgTreeNode", "refTreeId");
  const refNodeIdF = fld("imgTreeNode", "refNodeId");
  const textLangF = fld("imgTreeNodeText", "language");
  const textNodeIdF = fld("imgTreeNodeText", "nodeId");
  const textTreeIdF = fld("imgTreeNodeText", "treeId");
  const textF = fld("imgTreeNodeText", "text");
  const select = [
    `n~${treeIdF}`,
    `n~${nodeIdF}`,
    `n~${nodeTypeF}`,
    `n~${parentIdF}`,
    `n~${brotherIdF}`,
    `n~${refTreeIdF}`,
    `n~${refNodeIdF}`,
    `t~${textF}`,
  ].join(", ");
  const from =
    `${node} AS n\n` +
    `LEFT OUTER JOIN ${nodeText} AS t ON t~${textTreeIdF} = n~${treeIdF}\n` +
    `  AND t~${textNodeIdF} = n~${nodeIdF} AND t~${textLangF} = ${sqlLiteral(assertLanguage(language))}`;
  const where = [`n~${nodeIdF} = ${sqlLiteral(assertTreeKeyValue(nodeId, "nodeId"))}`];
  return buildSelect(select, from, where, `n~${treeIdF}`);
}

/** TTREE rows for a batch of tree ids, so a REF mount's target tree can be resolved to its root node. */
export function buildTreeDirectoryQuery(treeIds: readonly string[]): string {
  const idF = fld("treeDirectory", "id");
  const typeF = fld("treeDirectory", "treeType");
  const rootNodeIdF = fld("treeDirectory", "rootNodeId");
  const where = [inClause(idF, treeIds, "treeIds", assertTreeKeyValue)];
  return buildSelect(`${idF}, ${typeF}, ${rootNodeIdF}`, tbl("treeDirectory"), where);
}

// ------------------------------------------------------------------- mapper ---

/** One preview row, keyed by uppercase column name. */
export type PreviewRecord = Readonly<Record<string, string>>;

export interface PreviewRecordSet {
  /** Column names, in wire order. Empty only for a genuinely columnless response (see `toRecordSet`). */
  columns: readonly string[];
  records: readonly PreviewRecord[];
  /** In-band messages, wire order — see `parsePreviewBody`; a non-empty list here means `records` may not be the whole story. */
  messages: readonly PreviewMessage[];
}

/**
 * `parsePreviewBody`'s column-major/row-major shape, reduced to
 * name-keyed records. `columns` is kept alongside `records` (rather than
 * just leaving an empty `records` array) specifically so a zero-row,
 * zero-column response — a message-only reply — stays distinguishable from
 * a zero-row response that still names its columns.
 */
export function toRecordSet(body: string): PreviewRecordSet {
  const { columns, rows, messages } = parsePreviewBody(body);
  const names = columns.map((c) => c.name);
  const records = rows.map((row) => {
    const rec: Record<string, string> = {};
    names.forEach((name, i) => {
      rec[name] = row[i] ?? "";
    });
    return rec;
  });
  return { columns: names, records, messages };
}

/**
 * Reads one field, throwing rather than returning `undefined` for a missing
 * column — with `noUncheckedIndexedAccess` on, a silent `undefined` here is
 * exactly the failure mode that made the withdrawn ABAP bridge return empty
 * results with no explanation.
 */
export function requireColumn(record: PreviewRecord, column: string): string {
  const v = record[column];
  if (v === undefined) {
    const present = Object.keys(record);
    throw new AbapError(
      "ADT_ERROR",
      `expected column "${column}" is missing from the preview response (columns present: ${present.length > 0 ? present.join(", ") : "none"}).`,
      { column, present },
    );
  }
  return v;
}
