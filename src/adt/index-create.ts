/**
 * Secondary DDIC index (`TABL/DI`) create/delete, through the classrun bridge.
 *
 * ADT REST has no working route for a table's secondary indexes: live-probed
 * 2026-09-05, `GET /sap/bc/adt/ddic/tables/t000/indexes` and
 * `PUT .../indexes/z01` both 404, and a table's own XML carries only a GUI
 * handoff link (`#view=INDX`) for its Indexes tab — no REST resource at all.
 * `DD_INDEX_INTERFACE` (function group SDBT) is what SE11's Indexes tab
 * itself calls; `DD_INDEXES_CREATE` (a mass-activation helper taking
 * DD12V/DD17V work tables) was considered and rejected — it exists to
 * (re)activate index metadata already staged elsewhere, not to build it from
 * a field list.
 *
 * `DD_INDEX_INTERFACE`'s signature below is read from the system, not
 * guessed. Live evidence as of 2026-09-05, against A4H: this module's OWN
 * generated create bridge ran and created a non-unique, single-field index
 * in `$TMP`, all three read-back markers firing. The unique path failed
 * activation (ACTFAILED) there; round 2 confirmed live that the cause is
 * the client field the guard below checks for — a unique create that
 * included it produced all three markers, one that omitted it was refused
 * by the guard before the FM was ever called. The delete bridge's missing
 * `TABLES` parameter (round 1) is fixed and confirmed deployed live
 * (round 2). Round 2 also found ACTFAILED = 'X' on delete can fire after
 * the row is already gone from DD12V/DD17S — the ACTFAILED-tolerant
 * read-back added to close that has NOT itself been run live yet. The
 * transportable-package path, either direction, remains unexercised.
 *
 * Two independent gates, one closed template — same shape as `./view-create.ts`
 * and `./view-delete.ts`, which this file otherwise mirrors structurally.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { AbapIdentifierOptions, SafetyCorr, SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import {
  DDIC_BRIDGE_CLASS,
  DDIC_NOTE_PREFIX,
  assertBridgeMutation,
  ddicBridgeSource,
  runDdicBridge,
  subrcGuardFragment,
  type DdicTag,
  type DdicTranscript,
} from "./ddic-bridge.js";
import { abapLiteral, assertAbapText, assertEnhIdentifier } from "./enhancement-templates.js";
import { assertServerPackage, serverPackage, type ServerPackage } from "./resolved-package.js";
import { isNotFoundError } from "./session.js";
import { isLocalPackageName, isTrkorr } from "./transports.js";
import { buildUri, specForType } from "./types.js";
import { packageRefName } from "./write-verify.js";

// ---------------------------------------------------------------------------
// Parameters and limits
// ---------------------------------------------------------------------------

export interface SecondaryIndexParams {
  /** The index to create, e.g. Z01. */
  indexName: string;
  baseTable: string;
  /** Base-table fields, in order. Must be non-empty. */
  fields: string[];
  /** DD12V-DDTEXT. */
  description: string;
  /**
   * An index is not free to live wherever a caller says — it is DDIC content
   * of its base table, and belongs to the base table's package. Server-resolved
   * only, via {@link resolveIndexOwner} (`./resolved-package.ts`); this module
   * is zero-network and cannot verify it itself.
   */
  packageName: ServerPackage;
  /** An ALREADY gate-judged TRKORR, required for a non-local package, refused for a local one. */
  corrNr?: string;
  /** DD12V-UNIQUEFLAG. Omitted/false emits no `unique` line at all (not `unique = ''`). */
  unique?: boolean;
}

export interface IndexDeleteParams {
  indexName: string;
  baseTable: string;
  /** Server-resolved only — see {@link SecondaryIndexParams.packageName}'s doc for why. */
  packageName: ServerPackage;
  corrNr?: string;
}

/** `DD12V-INDEXNAME` is CHAR3. */
export const INDEX_NAME_MAX = 3;

/** `DD12V-DDTEXT` is CHAR60. */
export const INDEX_TEXT_MAX = 60;

/** Cap on generated `APPEND`s — classic dictionary's own limit is NOT re-verified here. */
export const MAX_INDEX_FIELDS = 16;

/** `DDFLDNAM` is CHAR30. */
export const INDEX_FIELD_NAME_MAX = 30;

/** `DD12V-SQLTAB`/`TABNAME` is CHAR30 — same ceiling `./view-create.ts` uses for `baseTable`. */
const BASE_TABLE_MAX = 30;

/** `DEVCLASS` is CHAR30 — same ceiling `./view-create.ts`'s `PACKAGE_RULES` uses. */
const PACKAGE_MAX = 30;
const PACKAGE_RULES: AbapIdentifierOptions = { maxLength: PACKAGE_MAX, allowLocal: true };

/** Code-controlled step names for {@link subrcGuardFragment} — never caller input. */
const CREATE_FM_WHAT = "DD_INDEX_INTERFACE insert";
const DELETE_FM_WHAT = "DD_INDEX_INTERFACE delete";

// ---------------------------------------------------------------------------
// Package resolution
// ---------------------------------------------------------------------------

/**
 * A secondary index inherits its base table's package — it has none of its
 * own to be asked for. This is the ONLY constructor of a {@link ServerPackage}
 * on the index create/delete path: one `GET` of `TABL/DT`'s own ADT resource
 * (a real REST route, unlike the index itself), never a caller-supplied or
 * guessed value.
 */
export async function resolveIndexOwner(
  conn: AbapConnection,
  baseTable: string,
): Promise<{ packageName: ServerPackage; uri: string }> {
  // TABL/DT is a fixed entry in the type registry (src/adt/types.ts), so this can't miss.
  const uri = buildUri(specForType("TABL/DT")!, baseTable);
  let body: string;
  try {
    const resp = await conn.get(uri, { headers: { Accept: "application/*" } });
    body = resp.body ?? "";
  } catch (e) {
    if (isNotFoundError(e)) {
      throw new AbapError(
        "NOT_FOUND",
        `Base table ${baseTable} does not exist, so there is nothing to index.`,
        { baseTable, uri },
      );
    }
    throw e;
  }
  const resolved = serverPackage({
    status: "confirmed",
    uri,
    via: "read-back",
    packageName: packageRefName(body),
  });
  if (!resolved) {
    throw new AbapError(
      "SAFETY_DENIED",
      `abapsmith could not determine which package base table ${baseTable} — and therefore any ` +
        "index on it — belongs to: the table's ADT XML answered but carried no " +
        "<adtcore:packageRef adtcore:name> element.",
      { reason: "PACKAGE_UNKNOWN", baseTable, uri },
      "Every write, delete and activation is judged against the object's real package. Rather " +
        "than trust a caller-supplied or guessed value, abapsmith stops here. Confirm the table " +
        "is registered with a real packageRef, then retry.",
      { retryable: true }, // a failure to determine the package, not a policy verdict
    );
  }
  return { packageName: resolved, uri };
}

/**
 * Local (`$`-prefixed) package: {@link isLocalPackageName}'s rule, compared
 * case-insensitively — same delegation `./view-create.ts`'s `isLocalPackage` uses.
 */
function isLocalPackage(packageName: string): boolean {
  return isLocalPackageName(packageName);
}

/** A validated identifier, as an ABAP string literal — re-asserts at the point of embedding. */
function quotedIdentifier(value: string, what: string, opts: AbapIdentifierOptions): string {
  return abapLiteral(assertEnhIdentifier(value, what, opts));
}

/**
 * `corrNr`, validated as an ALREADY gate-judged TRKORR and normalised
 * (trim + uppercase) — `./view-create.ts`'s analogue returns the value
 * unchanged; this one normalises since {@link assertSecondaryIndexTarget}'s
 * return value (not just a pass/fail) is what callers embed downstream.
 */
function assertCorrNr(value: string): string {
  if (!isTrkorr(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `corr_nr ${JSON.stringify(value)} is not a transport request/task number this system would ` +
        "issue (e.g. A4HK900121). This module never acquires a request on its own — the caller " +
        "must hand it one that has already been judged by the safety gate.",
      { what: "corrNr", value },
    );
  }
  return value.trim().toUpperCase();
}

/**
 * No-network check: does this package/corr_nr pair make sense for a
 * secondary-index create or delete? A local (`$`-prefixed) package refuses a
 * `corrNr` — it is created with `NO_TRANSP_REQUEST = 'X'`, so there is
 * nothing for one to attach to. A transportable package requires a `corrNr`
 * in TRKORR format, passed as `TRANSPORT_NUMBER`.
 *
 * Return contract (deliberately NOT `./view-create.ts`'s
 * `assertClassicViewCreateTarget`, which returns the validated package
 * name): returns `""` for the local case, the normalised TRKORR otherwise —
 * exactly the value {@link secondaryIndexFragment}/{@link indexDeleteFragment}
 * need to decide `NO_TRANSP_REQUEST` vs `TRANSPORT_NUMBER`, without a second
 * `isLocalPackage` call at the point of use.
 */
export function assertSecondaryIndexTarget(packageName: string, corrNr: string | undefined): string {
  const validated = assertEnhIdentifier(packageName, "packageName", PACKAGE_RULES);
  const local = isLocalPackage(validated);
  if (local && corrNr !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `corr_nr ${JSON.stringify(corrNr)} was supplied for local package ${JSON.stringify(validated)}, ` +
        "but a local ($-prefixed) index is created with NO_TRANSP_REQUEST = 'X' rather than on a " +
        "transport request, so there is nothing here for one to attach to.",
      { packageName: validated, corrNr },
    );
  }
  if (!local && corrNr === undefined) {
    throw new AbapError(
      "TRANSPORT_ERROR",
      `packageName ${JSON.stringify(validated)} is not local ($-prefixed), so this index must be ` +
        "created with TRANSPORT_NUMBER set, which requires a transport request — pass corr_nr " +
        "(an ALREADY gate-judged TRKORR, e.g. A4HK900121).",
      { packageName: validated },
      "Via abap_write, pass corr_nr with the TRKORR the safety gate already judged for this write " +
        "(see the abapsmith-put-work-on-a-transport skill).",
    );
  }
  return local ? "" : assertCorrNr(corrNr as string);
}

/**
 * Gate/mutation-target name for an index: `${baseTable}-${indexName}`, never
 * the bare index id. `safety.ts`'s namespace allowlist judges a name via
 * `name.startsWith(prefix)` (default `["Z","Y"]`) — a bare 1-3 char index id
 * like `Z01` carries no owner-namespace signal of its own; the base table
 * (which does) must be embedded in the gated name.
 */
export function indexGateName(baseTable: string, indexName: string): string {
  return `${baseTable}-${indexName}`;
}

/**
 * Every caller string validated once, so the fragment can never see a raw
 * one. `packageName` stays branded on the way out — {@link secondaryIndexFragment}
 * takes a full `SecondaryIndexParams` and would otherwise reject this return
 * value; only the plain-string form derived from it (`.name`) is used below,
 * for {@link assertSecondaryIndexTarget} and the gate.
 */
function validate(p: SecondaryIndexParams): {
  indexName: string;
  baseTable: string;
  fields: string[];
  description: string;
  packageName: ServerPackage;
  corrNr?: string;
  unique: boolean;
} {
  const indexName = assertEnhIdentifier(p.indexName, "indexName", { maxLength: INDEX_NAME_MAX });
  const baseTable = assertEnhIdentifier(p.baseTable, "baseTable", { maxLength: BASE_TABLE_MAX });
  if (!Array.isArray(p.fields) || p.fields.length === 0) {
    throw new AbapError(
      "BAD_INPUT",
      "fields must be a non-empty list of base-table field names — a secondary index with no " +
        "field at all is not one DD_INDEX_INTERFACE would accept.",
      { indexName, baseTable },
    );
  }
  if (p.fields.length > MAX_INDEX_FIELDS) {
    throw new AbapError(
      "BAD_INPUT",
      `fields has ${p.fields.length} entries, more than the ${MAX_INDEX_FIELDS} this bridge generates.`,
      { indexName, count: p.fields.length, max: MAX_INDEX_FIELDS },
    );
  }
  const fields = p.fields.map((f, i) =>
    assertEnhIdentifier(f, `fields[${i}]`, { maxLength: INDEX_FIELD_NAME_MAX }),
  );
  const description = assertAbapText(p.description, "description", INDEX_TEXT_MAX);
  const packageNameStr = assertEnhIdentifier(p.packageName.name, "packageName", PACKAGE_RULES);
  const trkorr = assertSecondaryIndexTarget(packageNameStr, p.corrNr);
  const corrNr = trkorr === "" ? undefined : trkorr;
  const unique = p.unique === true;
  return { indexName, baseTable, fields, description, packageName: p.packageName, corrNr, unique };
}

/** Same rationale as {@link validate}: `packageName` stays branded on the way out. */
function validateDelete(p: IndexDeleteParams): {
  indexName: string;
  baseTable: string;
  packageName: ServerPackage;
  corrNr?: string;
} {
  const indexName = assertEnhIdentifier(p.indexName, "indexName", { maxLength: INDEX_NAME_MAX });
  const baseTable = assertEnhIdentifier(p.baseTable, "baseTable", { maxLength: BASE_TABLE_MAX });
  const packageNameStr = assertEnhIdentifier(p.packageName.name, "packageName", PACKAGE_RULES);
  const trkorr = assertSecondaryIndexTarget(packageNameStr, p.corrNr);
  const corrNr = trkorr === "" ? undefined : trkorr;
  return { indexName, baseTable, packageName: p.packageName, corrNr };
}

// ---------------------------------------------------------------------------
// DD_INDEX_INTERFACE's EXCEPTIONS, shared by generator and parser
// ---------------------------------------------------------------------------

/**
 * One source of truth for `DD_INDEX_INTERFACE`'s `EXCEPTIONS` clause: both
 * CALL FUNCTION sites render it from this table via
 * {@link ddIndexExceptionsClause}, and {@link indexBridgeErrorHook} maps a
 * caught `sy-subrc` back through the same table — so the numbers can never
 * drift between generator and parser.
 *
 * No `ALREADY_EXISTS` code exists in this codebase; `already_exist` maps to
 * `CHECK_FAILED`. `AUTH_FAILED` is FORBIDDEN here (it trips the circuit
 * breaker) — `permission_error` is SAP's OWN authority check inside the
 * function module (`MAKE_CORR_ENTRY`), not abapsmith's safety gate, so it
 * maps to `SAFETY_DENIED` instead.
 */
export const DD_INDEX_EXCEPTIONS = [
  {
    subrc: 1,
    name: "cancelled",
    code: "CHECK_FAILED",
    message:
      "DD_INDEX_INTERFACE was cancelled (CANCELLED) — typically a popup a headless bridge " +
      "execution cannot answer.",
    hint: "Retry once; a cancelled dialog is not evidence anything about the request itself was wrong.",
  },
  {
    subrc: 2,
    name: "already_exist",
    code: "CHECK_FAILED",
    message: "DD_INDEX_INTERFACE reports this index already exists on the base table (ALREADY_EXIST).",
    hint:
      'Use mode: "delete" to remove the existing index first if a different definition is wanted, ' +
      "then create again.",
  },
  {
    subrc: 3,
    name: "permission_error",
    code: "SAFETY_DENIED",
    message:
      "DD_INDEX_INTERFACE refused its own authority check (PERMISSION_ERROR) — this is SAP's OWN " +
      "MAKE_CORR_ENTRY authorization check inside the function module, not abapsmith's safety gate.",
    hint: "The service user this bridge runs as lacks authority for this object; a different corr_nr will not change that.",
  },
  {
    subrc: 4,
    name: "name_not_allowed",
    code: "BAD_INPUT",
    message:
      "DD_INDEX_INTERFACE refused this index name (NAME_NOT_ALLOWED) — commonly outside the " +
      "customer namespace or already used elsewhere.",
    hint: "Pick a different index name.",
  },
  {
    subrc: 5,
    name: "db_access_error",
    code: "CHECK_FAILED",
    message: "DD_INDEX_INTERFACE hit a database access error (DB_ACCESS_ERROR) while writing the dictionary tables.",
    hint: "Not a request-shape problem; check the base table for an inconsistent or locked dictionary state.",
  },
  {
    subrc: 6,
    name: "basetab_error",
    code: "NOT_FOUND",
    message:
      "DD_INDEX_INTERFACE reports a problem with the base table (BASETAB_ERROR) — commonly that " +
      "it does not exist or is inactive.",
    hint: "Confirm the base table exists and is active before creating an index on it.",
  },
  {
    subrc: 7,
    name: "not_exist",
    code: "NOT_FOUND",
    message: "DD_INDEX_INTERFACE reports this index does not exist (NOT_EXIST).",
    hint: "Confirm the index name and base table; deleting a name that was never created returns this.",
  },
  {
    subrc: 8,
    name: "others",
    code: "CHECK_FAILED",
    message: "DD_INDEX_INTERFACE failed with an unclassified exception (OTHERS).",
    hint: undefined,
  },
] as const;

/**
 * Renders `DD_INDEX_EXCEPTIONS` as an `EXCEPTIONS` clause body (the
 * `EXCEPTIONS` keyword itself is NOT included — callers prepend it). The
 * `others` entry renders as the ABAP keyword `OTHERS`, not a named exception.
 */
function ddIndexExceptionsClause(): string[] {
  return DD_INDEX_EXCEPTIONS.map((e, i) => {
    const kw = e.name === "others" ? "OTHERS" : e.name;
    const end = i === DD_INDEX_EXCEPTIONS.length - 1 ? "." : "";
    return `    ${kw} = ${e.subrc}${end}`;
  });
}

/** Exactly one of `NO_TRANSP_REQUEST`/`TRANSPORT_NUMBER`, per {@link assertSecondaryIndexTarget}'s result. */
function transportParamLine(local: boolean, corrNr: string | undefined): string {
  return local ? "    no_transp_request   = 'X'" : `    transport_number    = ${abapLiteral(corrNr as string)}`;
}

// ---------------------------------------------------------------------------
// The generated ABAP
// ---------------------------------------------------------------------------

/** Bare `DATA` declarations (no leading `DATA` keyword) for the create bridge. */
export const INDEX_DATA_LINES: readonly string[] = [
  "lt_fields TYPE STANDARD TABLE OF ddfldnam WITH DEFAULT KEY.",
  "lv_actfailed TYPE ddrefstruc-flag.",
  "lv_dd12v_count TYPE i.",
  "lv_dd12v_any TYPE i.",
  "lv_dd17s_count TYPE i.",
  "lv_client_field TYPE dd03l-fieldname.",
];

/** Bare `DATA` declarations (no leading `DATA` keyword) for the delete bridge. */
export const INDEX_DELETE_DATA_LINES: readonly string[] = [
  "lt_fields TYPE STANDARD TABLE OF ddfldnam WITH DEFAULT KEY.",
  "lv_actfailed TYPE ddrefstruc-flag.",
  "lv_dd12v_count TYPE i.",
  "lv_dd12v_active TYPE i.",
  "lv_dd17s_count TYPE i.",
];

/**
 * The closed ABAP fragment that creates, activates and field-verifies one
 * secondary index. Exported for the generator/parser drift test — every
 * `out->write( 'TAG' )` it emits must be a tag `parseDdicTranscript` recognises.
 *
 * The field read-back selects `DD17S` — the field table the live probe
 * actually read. `DD17V`/`DD17L` were never probed, so this generated ABAP
 * does not select them.
 */
export function secondaryIndexFragment(p: SecondaryIndexParams): string[] {
  const v = validate(p);
  const { indexName, baseTable, fields, description, corrNr, unique } = v;
  const index = quotedIdentifier(indexName, "indexName", { maxLength: INDEX_NAME_MAX });
  const table = quotedIdentifier(baseTable, "baseTable", { maxLength: BASE_TABLE_MAX });
  const local = corrNr === undefined;

  const lines: string[] = [];

  // Step 1: the index field list. DDFLDNAM's single component is NAME, not
  // FIELDNAME — read from the system's interface definition, not guessed.
  fields.forEach((f, i) => {
    const quoted = quotedIdentifier(f, `fields[${i}]`, { maxLength: INDEX_FIELD_NAME_MAX });
    lines.push(`APPEND VALUE #( name = ${quoted} ) TO lt_fields.`);
  });
  lines.push("");

  // A unique secondary index on a client-dependent table must carry the client field, or
  // activation fails; confirmed live 2026-09-05 (round 2) as the cause of the ACTFAILED seen in
  // round 1 on a unique index over a client-dependent table.
  if (unique) {
    lines.push(
      `SELECT SINGLE fieldname FROM dd03l INTO @lv_client_field WHERE tabname = ${table} AND as4local = 'A' AND datatype = 'CLNT'.`,
      "IF sy-subrc = 0 AND lv_client_field IS NOT INITIAL.",
      "  READ TABLE lt_fields TRANSPORTING NO FIELDS WITH KEY name = lv_client_field.",
      "  IF sy-subrc <> 0.",
      `    out->write( |ZMCP-DDIC-ERR> unique index ${indexName} on ${baseTable} omits the client field { lv_client_field }| ).`,
      "    RETURN.",
      "  ENDIF.",
      "ENDIF.",
      "",
    );
  }

  // Step 2: create + activate in one call.
  lines.push(
    "CALL FUNCTION 'DD_INDEX_INTERFACE'",
    "  EXPORTING",
    `    table_name          = ${table}`,
    `    index_name          = ${index}`,
    "    action              = 'I'",
    `    shorttext           = ${abapLiteral(description)}`,
    "    activate            = 'X'",
    ...(unique ? ["    unique              = 'X'"] : []),
    transportParamLine(local, corrNr),
    "  IMPORTING",
    "    actfailed = lv_actfailed",
    "  TABLES",
    "    index_fields = lt_fields",
    "  EXCEPTIONS",
    ...ddIndexExceptionsClause(),
    ...subrcGuardFragment(CREATE_FM_WHAT),
    "IF lv_actfailed = 'X'.",
    // DD_INDEX_INTERFACE exports no activation log; the cheapest evidence of what a failed
    // activation left behind is a DD12V row count with no AS4LOCAL filter at all.
    `  SELECT COUNT( * ) FROM dd12v INTO @lv_dd12v_any WHERE sqltab = ${table} AND indexname = ${index}.`,
    `  out->write( |ZMCP-DDIC-ERR> ${CREATE_FM_WHAT} reported ACTFAILED = 'X' for ${indexName} on ${baseTable}; DD12V rows for this pair after the failure, any AS4LOCAL: { lv_dd12v_any }| ).`,
    "  RETURN.",
    "ENDIF.",
    "out->write( 'INDEX-CREATED' ).",
    "",
  );

  // Step 3: commit — classrun return does NOT implicitly commit (./view-create.ts
  // records a live false-success incident from omitting this).
  lines.push("COMMIT WORK.", "");

  // Step 4: re-read DD12V. Compared to 0, not <> 1 — DD12V carries DDLANGUAGE, so more than one row is possible.
  lines.push(
    `SELECT COUNT( * ) FROM dd12v INTO @lv_dd12v_count WHERE sqltab = ${table} AND indexname = ${index} AND as4local = 'A'.`,
    "IF lv_dd12v_count = 0.",
    `  out->write( |ZMCP-DDIC-ERR> ${indexName} on ${baseTable} not found active (AS4LOCAL = 'A') in DD12V after commit| ).`,
    "  RETURN.",
    "ENDIF.",
    "out->write( 'INDEX-ACTIVE' ).",
    "",
  );

  // Step 5: count DD17S field rows. Compared with <, not <> — a floor, not an
  // exact match, since this module has not established that DD17S holds
  // exactly one row per index field.
  lines.push(
    `SELECT COUNT( * ) FROM dd17s INTO @lv_dd17s_count WHERE sqltab = ${table} AND indexname = ${index}.`,
    `IF lv_dd17s_count < ${fields.length}.`,
    `  out->write( |ZMCP-DDIC-ERR> expected at least ${fields.length} DD17S field row(s) for ${indexName} on ${baseTable}, got { lv_dd17s_count }| ).`,
    "  RETURN.",
    "ENDIF.",
    "out->write( 'INDEX-FIELDS' ).",
  );

  return lines;
}

/**
 * The closed ABAP fragment that deletes one secondary index. Exported for
 * the generator/parser drift test.
 */
export function indexDeleteFragment(p: IndexDeleteParams): string[] {
  const v = validateDelete(p);
  const { indexName, baseTable, corrNr } = v;
  const index = quotedIdentifier(indexName, "indexName", { maxLength: INDEX_NAME_MAX });
  const table = quotedIdentifier(baseTable, "baseTable", { maxLength: BASE_TABLE_MAX });
  const local = corrNr === undefined;

  const lines: string[] = [];

  // Step 1: a delete of a pair that never existed is a refusal, not a no-op.
  // DD12V carries DDLANGUAGE, so an index with no short text in the executing
  // language could read as absent here — refusing instead of deleting.
  lines.push(
    `SELECT COUNT( * ) FROM dd12v INTO @lv_dd12v_count WHERE sqltab = ${table} AND indexname = ${index}.`,
    "IF lv_dd12v_count = 0.",
    `  out->write( |ZMCP-DDIC-ERR> index ${indexName} on ${baseTable} does not exist| ).`,
    "  RETURN.",
    "ENDIF.",
    "",
  );

  // Step 2: delete + activate. Same EXCEPTIONS clause and transport pairing as the create side.
  lines.push(
    "CALL FUNCTION 'DD_INDEX_INTERFACE'",
    "  EXPORTING",
    `    table_name          = ${table}`,
    `    index_name          = ${index}`,
    "    action              = 'D'",
    "    activate            = 'X'",
    transportParamLine(local, corrNr),
    "  IMPORTING",
    "    actfailed = lv_actfailed",
    // DD_INDEX_INTERFACE requires INDEX_FIELDS for every ACTION, content or not; omitting it
    // failed live on 2026-09-05 with "the mandatory parameter INDEX_FIELDS was not filled".
    "  TABLES",
    "    index_fields = lt_fields",
    "  EXCEPTIONS",
    ...ddIndexExceptionsClause(),
    ...subrcGuardFragment(DELETE_FM_WHAT),
    "",
  );

  // Step 3: commit — unconditional even when ACTFAILED = 'X'. Live 2026-09-05: on both a
  // non-unique and a unique index, ACTFAILED = 'X' fired while the DD12V row was already gone,
  // meaning the catalog change had already taken effect before this classrun's own commit point.
  // ACTFAILED alone no longer decides anything below; it only flags the read-back as worth a note.
  lines.push("COMMIT WORK.", "");

  // Step 4: read back all three signals before deciding — same discipline as the create side,
  // now applied to ACTFAILED too instead of trusting it as fatal.
  lines.push(
    `SELECT COUNT( * ) FROM dd12v INTO @lv_dd12v_count WHERE sqltab = ${table} AND indexname = ${index}.`,
    `SELECT COUNT( * ) FROM dd12v INTO @lv_dd12v_active WHERE sqltab = ${table} AND indexname = ${index} AND as4local = 'A'.`,
    `SELECT COUNT( * ) FROM dd17s INTO @lv_dd17s_count WHERE sqltab = ${table} AND indexname = ${index}.`,
    "",
  );

  // Step 5: the read-back decides, not ACTFAILED. All-zero is success even when ACTFAILED = 'X'
  // fired (live 2026-09-05: the FM's own failure report lagged behind a catalog change that had
  // already committed); any row surviving is still a real failure either way.
  lines.push(
    "IF lv_dd12v_count <> 0 OR lv_dd12v_active <> 0 OR lv_dd17s_count <> 0.",
    `  out->write( |ZMCP-DDIC-ERR> delete of ${indexName} on ${baseTable} left rows behind after commit ` +
      `(DD12V any: { lv_dd12v_count }, DD12V active: { lv_dd12v_active }, DD17S: { lv_dd17s_count }); ` +
      `${DELETE_FM_WHAT} ACTFAILED = '{ lv_actfailed }'| ).`,
    "  RETURN.",
    "ENDIF.",
    "IF lv_actfailed = 'X'.",
    `  out->write( |${DDIC_NOTE_PREFIX} ${DELETE_FM_WHAT} reported ACTFAILED = 'X' for ${indexName} on ${baseTable}, ` +
      `but the post-commit read-back found it gone (DD12V any: { lv_dd12v_count }, DD12V active: ` +
      `{ lv_dd12v_active }, DD17S: { lv_dd17s_count }) — treating as deleted| ).`,
    "  out->write( 'INDEX-DELETED-ACTFAILED' ).",
    "ENDIF.",
    "out->write( 'INDEX-DELETED' ).",
    "out->write( 'INDEX-GONE' ).",
  );

  return lines;
}

// ---------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------

/**
 * `completed`/`hint` for {@link runDdicBridge}'s partial-success reporting.
 * Both `INDEX-CREATED` and `INDEX-ACTIVE` can fire before a LATER failure
 * (the DD17S field-count check, `INDEX-FIELDS`, is the last tag) — only
 * those two belong here.
 */
export function indexCreatePartialSuccess(
  indexName: string,
  baseTable: string,
): {
  completed: Readonly<Partial<Record<DdicTag, string>>>;
  hint: string;
} {
  return {
    completed: {
      "INDEX-CREATED": `DD_INDEX_INTERFACE (action='I') created ${indexName} on ${baseTable}, and the COMMIT WORK that follows it committed it.`,
      "INDEX-ACTIVE": `${indexName} was found active (AS4LOCAL = 'A') in DD12V on re-read after the commit.`,
    },
    hint:
      `If INDEX-CREATED fired, ${indexName} exists on ${baseTable} — abap_write mode="delete" ` +
      'type="TABL/DI" can remove it rather than retrying the create, which would collide with it.',
  };
}

/**
 * Turns three known transcript shapes into a specific `AbapError` instead of
 * the generic missing-tag `CHECK_FAILED` the plain assertion would give:
 * a "does not exist" line (delete only), an "omits the client field" line
 * (create, unique only), and a `sy-subrc=<n>` line from {@link subrcGuardFragment}
 * for the matching `*_FM_WHAT` constant, mapped through {@link DD_INDEX_EXCEPTIONS}.
 * Anything else returns, leaving `assertDdicTranscript` to handle it.
 */
export function indexBridgeErrorHook(
  what: "insert" | "delete",
  indexName: string,
  baseTable: string,
): (t: DdicTranscript) => void {
  const fmWhat = what === "insert" ? CREATE_FM_WHAT : DELETE_FM_WHAT;
  // fmWhat is one of the two fixed, code-controlled constants above (letters/digits/underscore/space
  // only, per subrcGuardFragment's own check), so no regex-metacharacter escaping is needed here.
  const subrcRe = new RegExp(`^${fmWhat} failed, sy-subrc=(\\d+),`);
  return (transcript: DdicTranscript): void => {
    const line = transcript.errorLine;
    if (!line) return;
    if (line.includes(`${indexName} on ${baseTable} does not exist`)) {
      // NOT_FOUND, not CHECK_FAILED (./view-delete.ts's analogue): a different index/table pairing
      // could exist — errors.ts's RETRYABILITY note for NOT_FOUND fits this case.
      throw new AbapError(
        "NOT_FOUND",
        `Index ${indexName} on ${baseTable} does not exist, so there is nothing to delete. Raw ` +
          `ABAP-side detail: ${line}`,
        { indexName, baseTable, raw: transcript.raw },
      );
    }
    if (line.includes(`unique index ${indexName} on ${baseTable} omits the client field`)) {
      throw new AbapError(
        "BAD_INPUT",
        `Index ${indexName} was not created: a unique secondary index on client-dependent base ` +
          `table ${baseTable} must include that table's client field. Raw ABAP-side detail: ${line}`,
        { indexName, baseTable, raw: transcript.raw },
        `Add ${baseTable}'s client field to index_fields, or create ${indexName} without index_unique.`,
      );
    }
    const m = subrcRe.exec(line);
    if (!m) return;
    const subrc = Number(m[1]);
    const entry = DD_INDEX_EXCEPTIONS.find((e) => e.subrc === subrc);
    if (!entry) return;
    throw new AbapError(entry.code, entry.message, { indexName, baseTable, subrc, raw: transcript.raw }, entry.hint);
  };
}

/**
 * Create one secondary index: validate, gate the index (as `${baseTable}-${indexName}`,
 * see {@link indexGateName}), generate, deploy, run, assert the transcript.
 * `validate()` (via {@link assertSecondaryIndexTarget}) runs first —
 * `BAD_INPUT`/`TRANSPORT_ERROR` before anything else — then
 * {@link assertBridgeMutation}, zero-network, only then ABAP is generated.
 */
export async function createSecondaryIndex(
  conn: AbapConnection,
  gate: SafetyGate,
  params: SecondaryIndexParams,
): Promise<{ run: RunResult; transcript: DdicTranscript }> {
  assertServerPackage(params.packageName, `secondary index ${params.indexName} on ${params.baseTable}`);
  const validated = validate(params);
  const { indexName, baseTable, packageName, corrNr } = validated;

  const corr: SafetyCorr | undefined =
    corrNr === undefined ? undefined : { kind: "transport", corrNr, source: "named" };

  // Gate on the domain object itself — deployBridge only judges the bridge class, never this index.
  // activate: true because DD_INDEX_INTERFACE is called with ACTIVATE = 'X' in the same execution.
  assertBridgeMutation(
    gate,
    { type: "TABL/DI", name: indexGateName(baseTable, indexName), packageName: packageName.name },
    { activate: true, ...(corr !== undefined ? { corr } : {}) },
  );

  const source = ddicBridgeSource(DDIC_BRIDGE_CLASS.createIndex, INDEX_DATA_LINES, secondaryIndexFragment(validated));

  const partial = indexCreatePartialSuccess(indexName, baseTable);
  return runDdicBridge(conn, gate, {
    className: DDIC_BRIDGE_CLASS.createIndex,
    source,
    description: `abapsmith create-secondary-index bridge (${indexName} on ${baseTable})`,
    what: `Creating secondary index ${indexName} on ${baseTable}`,
    expectTags: ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"],
    beforeAssert: indexBridgeErrorHook("insert", indexName, baseTable),
    completed: partial.completed,
    partialHint: partial.hint,
  });
}

/**
 * Delete one secondary index via the DDIC classrun bridge. Gated as
 * `op: "delete"` on the index itself; `activate: true` even though this is a
 * delete — `DD_INDEX_INTERFACE` is called with `ACTIVATE = 'X'` for
 * `action = 'D'` too.
 */
export async function deleteSecondaryIndexViaBridge(
  conn: AbapConnection,
  gate: SafetyGate,
  params: IndexDeleteParams,
): Promise<{ run: RunResult; transcript: DdicTranscript }> {
  assertServerPackage(params.packageName, `secondary index ${params.indexName} on ${params.baseTable}`);
  const validated = validateDelete(params);
  const { indexName, baseTable, packageName, corrNr } = validated;

  const corr: SafetyCorr | undefined =
    corrNr === undefined ? undefined : { kind: "transport", corrNr, source: "named" };

  assertBridgeMutation(
    gate,
    { type: "TABL/DI", name: indexGateName(baseTable, indexName), packageName: packageName.name },
    { activate: true, op: "delete", ...(corr !== undefined ? { corr } : {}) },
  );

  const source = ddicBridgeSource(
    DDIC_BRIDGE_CLASS.deleteIndex,
    INDEX_DELETE_DATA_LINES,
    indexDeleteFragment(validated),
  );

  return runDdicBridge(conn, gate, {
    className: DDIC_BRIDGE_CLASS.deleteIndex,
    source,
    description: `abapsmith delete-secondary-index bridge (${indexName} on ${baseTable})`,
    what: `Deleting secondary index ${indexName} on ${baseTable}`,
    expectTags: ["INDEX-DELETED", "INDEX-GONE"],
    beforeAssert: indexBridgeErrorHook("delete", indexName, baseTable),
  });
}
