/**
 * Secondary DDIC index (`TABL/DI`) create/delete, over the fluid `classic`
 * tool (`create_index`/`delete_index`, body class `ZCL_ZMCP_FLUID_CLASSIC`).
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
 * the row is already gone from DD12V/DD17S; the ACTFAILED-tolerant
 * read-back added to close that was worse than unverified — round 3 found
 * it had never once executed, because the rendered delete-bridge class
 * source carried a line over 255 chars (SEDI_ADT15/TooLongLine at the
 * class-source PUT), so DD_INDEX_INTERFACE was never called and the bridge
 * class was never refreshed. That line-length defect is fixed in the ABAP
 * (now `src/adt/fluid/builtin/classic/abap-index.ts`); the read-back's live
 * behavior itself remains unexercised. The transportable-package path,
 * either direction, remains unexercised.
 *
 * Two independent gates: the fluid `classic` tool's own gate over its body
 * class, and — {@link assertBridgeMutation} — the domain object this call
 * will create, which the tool never sees. Same shape as `./view-create.ts`
 * and `./view-delete.ts`, which this file otherwise mirrors structurally.
 *
 * Issue #86: the in-transcript read-back described above (the bridge's own
 * post-`COMMIT WORK` `SELECT COUNT( * )` on DD12V/DD17S, still inside the
 * same classrun execution) was never a SECOND opinion — it is the same
 * execution asking itself whether it succeeded, which is exactly why
 * `ACTFAILED` and the transcript tags it drove were never a reliable
 * signal on their own. `./index-read.ts` now gives an actually independent
 * one: `createSecondaryIndex`/`deleteSecondaryIndexViaBridge` re-read
 * DD12V/DD17S in a FRESH request after the bridge returns and carry the
 * resulting `verdict: IndexVerdict` out to the caller. That verdict reports;
 * it does not overrule the bridge's own outcome — except for the one
 * narrow case {@link createSecondaryIndex} documents, where the two
 * disagree about a create that the bridge itself already claimed succeeded.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { AbapIdentifierOptions, SafetyCorr, SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import { assertBridgeMutation } from "./bridge-mutation.js";
import type { DdicTag, DdicTranscript } from "./ddic-transcript.js";
import { runClassicAction } from "./classic-call.js";
import { assertAbapText, assertEnhIdentifier } from "./enhancement-templates.js";
import { verifySecondaryIndex, type IndexVerdict } from "./index-read.js";
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

/**
 * Code-controlled step-name text, matching the `fail(...)` prefix
 * `src/adt/fluid/builtin/classic/abap-index.ts`'s `create_index`/`delete_index`
 * methods emit on failure — never caller input.
 */
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
 * exactly the `corr_nr` value the `create_index`/`delete_index` actions need
 * to decide `NO_TRANSP_REQUEST` vs `TRANSPORT_NUMBER` on the ABAP side,
 * without a second `isLocalPackage` call at the point of use.
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
 * `TABL/DI` addressing for `abap_write`: until now only a bare index name
 * plus a separate `base_table` worked. `abap_read` also accepts the parented
 * slash form `"<TABLE>/<INDEX>"` (see `src/tools/read.ts`'s
 * `readCatalogObject`) — TABL/DI has no ADT resource of its own, so no
 * `TypeSpec` in `src/adt/types.ts` carries a `parentPath` for it (see this
 * file's header), and the shared parser (`src/adt/resolve.ts`'s
 * `parseObjectRef`) never gets a chance to split a slash-containing TABL/DI
 * name on that basis. Passing the read form's object string to `abap_write`
 * used to fall straight through to that parser's generic "Could not extract
 * an ABAP object name" refusal — a FUGR/FF-flavored hint that means nothing
 * for an index. This runs BEFORE that parser (from `src/tools/write.ts`'s
 * `abapWrite`, ahead of `targetFromInput`) and resolves either accepted form
 * into the bare-name + base_table shape {@link validate}/{@link
 * validateDelete} above already expect. The bare-form-plus-`base_table`
 * path — today's only working one — is untouched, purely additive:
 *
 * - slash form alone → split, done.
 * - slash form + agreeing `base_table` → accept.
 * - slash form + disagreeing `base_table` → refuse; never silently pick one.
 * - bare form + `base_table` → unchanged.
 * - bare form, no `base_table` → refuse, naming both accepted forms.
 */
export function resolveIndexObjectInput(
  object: string,
  baseTable: string | undefined,
): { object: string; baseTable: string | undefined } {
  const parts = object.split("/");
  if (parts.length === 1) {
    if (!baseTable?.trim()) {
      throw new AbapError(
        "BAD_INPUT",
        `"${object}" does not by itself name a table secondary index (TABL/DI): pass either ` +
          `"<TABLE>/<INDEX>" (e.g. "ZTAB/Z01", the same form abap_read accepts) or the bare index ` +
          `name plus base_table (e.g. object: "${object}", base_table: "ZTAB").`,
        { object, type: "TABL/DI" },
        'Add base_table, or address it as "<TABLE>/<INDEX>".',
      );
    }
    return { object, baseTable };
  }
  if (parts.length !== 2 || parts[0]!.trim() === "" || parts[1]!.trim() === "") {
    throw new AbapError(
      "BAD_INPUT",
      `"${object}" is not a valid TABL/DI name: expected "<TABLE>/<INDEX>", e.g. "ZTAB/Z01".`,
      { object, type: "TABL/DI" },
      'Name it as "<TABLE>/<INDEX>", e.g. "ZTAB/Z01", or pass the bare index name with base_table.',
    );
  }
  const [table, indexName] = parts as [string, string];
  if (baseTable?.trim() && baseTable.trim().toUpperCase() !== table.trim().toUpperCase()) {
    throw new AbapError(
      "BAD_INPUT",
      `object ${JSON.stringify(object)} names base table ${JSON.stringify(table)}, but base_table ` +
        `${JSON.stringify(baseTable)} was also given and disagrees — abapsmith will not silently ` +
        "pick one.",
      { object, base_table: baseTable, type: "TABL/DI" },
      `Drop base_table to use ${JSON.stringify(table)} from object, or change object to ` +
        `"${baseTable.trim()}/${indexName}" to match base_table.`,
    );
  }
  return { object: indexName, baseTable: baseTable?.trim() || table };
}

/**
 * Every caller string validated once, so the classic action's args can never
 * carry a raw one. `packageName` stays branded on the way out; only the
 * plain-string form derived from it (`.name`) is used below, for
 * {@link assertSecondaryIndexTarget} and the gate.
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
// DD_INDEX_INTERFACE's EXCEPTIONS, shared by ABAP and parser
// ---------------------------------------------------------------------------

/**
 * `DD_INDEX_INTERFACE`'s `EXCEPTIONS` clause, mirrored by hand in
 * `src/adt/fluid/builtin/classic/abap-index.ts`'s two `CALL FUNCTION` sites
 * (same subrc numbers) — {@link indexBridgeErrorHook} maps a caught
 * `sy-subrc` back through this table, so keep the two in sync.
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

// ---------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------

/**
 * `completed`/`hint` for {@link runClassicAction}'s partial-success reporting.
 * Both `INDEX-CREATED` and `INDEX-ACTIVE` can fire before a LATER failure
 * (the DD17S field-count check, `INDEX-FIELDS`, is the last tag) — only
 * those two belong here.
 *
 * Also reused by {@link assertCreateVerdictAgrees} below for a DIFFERENT
 * partial-success shape: not a later step failing inside the same
 * classrun, but the independent DD12V/DD17S re-read run right after a
 * transcript that claimed full success coming back with a different
 * answer. Both are "something already committed server-side, but the end
 * state is not what the caller asked for" — the same wording fits both.
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
 * The one place a post-hoc `IndexVerdict` is allowed to turn a bridge run
 * that already reported full success (`INDEX-CREATED`/`INDEX-ACTIVE`/
 * `INDEX-FIELDS` all fired, no `errorLine`) into an error instead: the
 * FRESH DD12V/DD17S re-read {@link createSecondaryIndex} runs right after
 * disagrees with what the bridge's OWN in-transcript read-back claimed.
 * That is not this function second-guessing a normal result — it is two
 * independent reads of the same catalog disagreeing, which is itself the
 * finding. `verified: false` (the re-read could not run at all) is NOT
 * this case: an unreadable catalog says nothing about whether the create
 * worked, so it is left alone here and reported as-is by the caller
 * (`src/tools/write.ts`) instead.
 */
function assertCreateVerdictAgrees(indexName: string, baseTable: string, verdict: IndexVerdict): void {
  if (!verdict.verified || (verdict.present && verdict.active)) return;
  const { completed, hint } = indexCreatePartialSuccess(indexName, baseTable);
  const done = Object.values(completed).filter((v): v is string => v !== undefined);
  throw new AbapError(
    "CHECK_FAILED",
    `DD_INDEX_INTERFACE's own transcript reported ${indexName} on ${baseTable} created and active, ` +
      `but the independent DD12V/DD17S re-read run right after it disagrees: ${verdict.statement}. ` +
      `PARTIAL SUCCESS, NOT A NO-OP: ${done.join("; ")}.`,
    { indexName, baseTable, verdict },
    hint,
  );
}

/**
 * Turns three known transcript shapes into a specific `AbapError` instead of
 * the generic missing-tag `CHECK_FAILED` the plain assertion would give:
 * a "does not exist" line (delete only), an "omits the client field" line
 * (create, unique only), and a `sy-subrc=<n>` line for the matching
 * `*_FM_WHAT` constant, mapped through {@link DD_INDEX_EXCEPTIONS}.
 * Anything else returns, leaving `assertDdicTranscript` to handle it.
 */
export function indexBridgeErrorHook(
  what: "insert" | "delete",
  indexName: string,
  baseTable: string,
): (t: DdicTranscript) => void {
  const fmWhat = what === "insert" ? CREATE_FM_WHAT : DELETE_FM_WHAT;
  // fmWhat is one of the two fixed, code-controlled constants above (letters/digits/underscore/space
  // only), so no regex-metacharacter escaping is needed here.
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
 * see {@link indexGateName}), then run the fluid `classic` tool's `create_index`
 * action and assert the transcript. `validate()` (via {@link assertSecondaryIndexTarget})
 * runs first — `BAD_INPUT`/`TRANSPORT_ERROR` before anything else — then
 * {@link assertBridgeMutation}, zero-network, only then the action runs.
 *
 * Issue #86: once the bridge itself reports success, this runs one more,
 * genuinely independent read — {@link verifySecondaryIndex} — and carries
 * the result out as `verdict`. That read is report-only EXCEPT for the one
 * case {@link assertCreateVerdictAgrees} covers: the bridge's own transcript
 * and this fresh catalog read disagreeing about whether the index actually
 * ended up present and active.
 */
export async function createSecondaryIndex(
  conn: AbapConnection,
  gate: SafetyGate,
  params: SecondaryIndexParams,
): Promise<{ run: RunResult; transcript: DdicTranscript; verdict: IndexVerdict }> {
  assertServerPackage(params.packageName, `secondary index ${params.indexName} on ${params.baseTable}`);
  const validated = validate(params);
  const { indexName, baseTable, fields, description, packageName, corrNr, unique } = validated;

  const corr: SafetyCorr | undefined =
    corrNr === undefined ? undefined : { kind: "transport", corrNr, source: "named" };

  // Gate on the domain object itself — the fluid tool's own gate only judges its body class, never this index.
  // activate: true because DD_INDEX_INTERFACE is called with ACTIVATE = 'X' in the same execution.
  assertBridgeMutation(
    gate,
    { type: "TABL/DI", name: indexGateName(baseTable, indexName), packageName: packageName.name },
    { activate: true, ...(corr !== undefined ? { corr } : {}) },
  );

  const partial = indexCreatePartialSuccess(indexName, baseTable);
  const result = await runClassicAction(conn, gate, {
    action: "create_index",
    args: {
      index_name: indexName,
      base_table: baseTable,
      fields,
      description,
      package_name: packageName.name,
      corr_nr: corrNr ?? "",
      ...(params.unique !== undefined ? { unique } : {}),
    },
    what: `Creating secondary index ${indexName} on ${baseTable}`,
    expectTags: ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"],
    beforeAssert: indexBridgeErrorHook("insert", indexName, baseTable),
    completed: partial.completed,
    partialHint: partial.hint,
  });

  // A fresh request, not a re-read of anything the classrun above already
  // touched — this is what makes it an independent second opinion rather
  // than the same execution grading its own homework (see this file's
  // header comment).
  const verdict = await verifySecondaryIndex(conn, baseTable, indexName, "present");
  assertCreateVerdictAgrees(indexName, baseTable, verdict);
  return { ...result, verdict };
}

/**
 * `transcript.tags`, minus any tag naming `ACTFAILED` (today just
 * `INDEX-DELETED-ACTFAILED` — see `DDIC_TAGS`). `ACTFAILED` on its own was
 * already established (this file's header, and {@link
 * deleteSecondaryIndexViaBridge}'s doc comment below) to mean nothing
 * reliable by itself — the FM can report it even when the index ends up
 * gone as intended, which is exactly the live-observed case that produced
 * it. Live-observed defect (issue #86 follow-up): `abap_write`'s response
 * used to join `transcript.tags` verbatim into its caller-visible `markers`
 * field, so a caller saw the literal string `INDEX-DELETED-ACTFAILED` with
 * no way to tell, from that string alone, that the index was in fact
 * deleted — `verified`/`index_present`/`index_active` (from {@link
 * IndexVerdict}, the independent DD12V/DD17S re-read) already carry the
 * fact a caller should act on, so the raw tag added confusion, not
 * information. This filters `markers` only; `transcript.tags` and
 * `transcript.raw` themselves are untouched and still carry the tag as
 * evidence for anyone inspecting the transcript directly.
 */
export function callerVisibleIndexTags(tags: readonly DdicTag[]): DdicTag[] {
  return tags.filter((t) => !t.includes("ACTFAILED"));
}

/**
 * Delete one secondary index over the fluid `classic` tool's `delete_index`
 * action. Gated as `op: "delete"` on the index itself; `activate: true` even
 * though this is a delete — `DD_INDEX_INTERFACE` is called with
 * `ACTIVATE = 'X'` for `action = 'D'` too.
 *
 * Issue #86: `INDEX-DELETED-ACTFAILED` (see `DDIC_TAGS`) can still appear in
 * `transcript.tags` — that stays as raw evidence of what the ABAP side saw.
 * It is deliberately NOT inspected here to decide anything: the ABAP-side
 * `delete_index` fragment (`src/adt/fluid/builtin/classic/abap-index.ts`)
 * already found `ACTFAILED` unreliable on its own and reads DD12V/DD17S
 * back itself before reporting success at all. This function's OWN
 * `verifySecondaryIndex` call below is a second, independent instance of
 * that same discipline — a fresh request against a live connection, not a
 * re-read of anything already inspected inside the classrun. Unlike
 * `createSecondaryIndex`, a disagreement here never becomes an error: it is
 * carried out as `verdict` and left for the caller to report — see this
 * module's header comment for why create is the one narrow exception.
 * {@link callerVisibleIndexTags} is what keeps the raw `ACTFAILED` tag this
 * can carry out of the caller-visible response built in `src/tools/write.ts`.
 */
export async function deleteSecondaryIndexViaBridge(
  conn: AbapConnection,
  gate: SafetyGate,
  params: IndexDeleteParams,
): Promise<{ run: RunResult; transcript: DdicTranscript; verdict: IndexVerdict }> {
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

  const result = await runClassicAction(conn, gate, {
    action: "delete_index",
    args: {
      index_name: indexName,
      base_table: baseTable,
      package_name: packageName.name,
      corr_nr: corrNr ?? "",
    },
    what: `Deleting secondary index ${indexName} on ${baseTable}`,
    expectTags: ["INDEX-DELETED", "INDEX-GONE"],
    beforeAssert: indexBridgeErrorHook("delete", indexName, baseTable),
  });

  const verdict = await verifySecondaryIndex(conn, baseTable, indexName, "absent");
  return { ...result, verdict };
}
