/**
 * # `TRAN/T` create — SE93's own backend, over the DDIC classrun bridge
 *
 * ADT has no writable collection for `TRAN/T` (405 on every mutating verb via
 * the VIT bridge — see `./capabilities.ts`). SE93 itself calls
 * `RPY_TRANSACTION_INSERT` (function group `SEUA`), so this module generates a
 * throwaway `IF_OO_ADT_CLASSRUN` class that calls that FM and reads the
 * outcome back off a tagged transcript, per `./ddic-bridge.ts`'s two-gate
 * discipline (read that module's header first).
 *
 * ## Scope
 *
 * {@link createTransaction} binds a tcode to an EXISTING report program the
 * caller names — it does not generate, wrap or derive the program, and does
 * not check the program exists (that check now lives one layer up, in
 * `src/tools/write.ts`'s `abapCreateViaBridge`, before this module is ever
 * called — see `src/adt/write-verify.ts`'s module doc for why).
 *
 * Deliberate limitations, all budget decisions (see archive): report
 * transactions only (`transaction_type = 'R'`, dynpro fixed at `1000`),
 * create only — no change/delete.
 *
 * ## Evidence status
 *
 * The capture proves `RPY_TRANSACTION_INSERT` exists and quotes its `tstc`/
 * `tstct`/`tstcc` insert block verbatim. On 2026-09-05 four signature lines —
 * `development_class`, `transport_number`, `genflag`, `suppress_corr_insert`
 * — and the `RS_CORR_INSERT` block that forwards `transport_number` as
 * `korrnum` were read from the live source on A4H. Every other parameter
 * name, and the EXCEPTIONS list AND ITS ORDER, is still only a prose
 * paraphrase and remains an ASSUMPTION flagged at its use site. No create
 * has yet been run live with `transport_number` passed. Full detail: the
 * git history.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyCorr, SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import {
  assertBridgeMutation,
  DDIC_BRIDGE_CLASS,
  ddicBridgeSource,
  runDdicBridge,
  subrcCheckFragment,
  type DdicTranscript,
} from "./ddic-bridge.js";
import { abapLiteral, assertAbapText, assertEnhIdentifier } from "./enhancement-templates.js";
import { isLocalPackageName, isTrkorr } from "./transports.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** `TSTC-TCODE` is CHAR20. */
const TCODE_MAX_LENGTH = 20;

/** `TSTCT-TTEXT` is CHAR37. Longer text is REFUSED, never truncated — see {@link TransactionParams.description}. */
const TTEXT_MAX_LENGTH = 37;

/** `PROGNAME`/`TSTC-PGMNA` is CHAR40. */
const PROGRAM_MAX_LENGTH = 40;

/** Package names may be local (`$TMP`), so `allowLocal` is on. `DEVCLASS` is CHAR30. */
const PACKAGE_MAX_LENGTH = 30;

/**
 * ASSUMPTION — `transaction_type = 'R'` (report transaction); the capture never
 * gives `ststc_c_type_report`'s VALUE, only its name, and the FM's documented
 * default is `'D'` (dialog). A wrong literal fails loudly (`illegal_type`,
 * surfaced by {@link subrcCheckFragment} as `CHECK_FAILED`), which is why this
 * is a plain literal, not the type-pool constant. FALLBACK if a live run
 * reports `illegal_type`: switch to `transaction_type = 'D'` with
 * `dynpro = '1000'`. Full reasoning: the git history.
 */
const TRANSACTION_TYPE_REPORT = "R";

/**
 * ASSUMPTION — `dynpro = '1000'`. The capture's verbatim insert block shows
 * the FM setting `tstc-dypno = 1000` itself, so this may be redundant, but the
 * paraphrased signature records no `DEFAULT` for `dynpro`. Detail:
 * the git history.
 */
const REPORT_DYNPRO = "1000";

// ---------------------------------------------------------------------------
// Validation, applied to every caller string
// ---------------------------------------------------------------------------

/**
 * A transaction code, validated for verbatim substitution into generated ABAP.
 *
 * Its own grammar, not {@link assertEnhIdentifier}'s: a letter, then
 * letters/digits/underscores, max {@link TCODE_MAX_LENGTH}. Deliberately
 * NARROWER than SAP's own rule — no `/` or `-` — because nothing in this
 * codebase has validated that punctuation is safe once substituted into
 * activated ABAP source. Not trimmed or upper-cased, so validation and
 * emission see the same string. Full argument: the git history.
 */
export function assertTransactionCode(value: string, what = "tcode"): string {
  if (typeof value !== "string" || !new RegExp(`^[A-Za-z][A-Za-z0-9_]{0,${TCODE_MAX_LENGTH - 1}}$`).test(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} ${JSON.stringify(value)} is not a valid transaction code for this bridge (a letter, then ` +
        `letters, digits and underscores only, max ${TCODE_MAX_LENGTH} characters).`,
      { what, value, maxLength: TCODE_MAX_LENGTH },
      "This value is substituted verbatim into generated ABAP source that is then activated and " +
        "executed — a quote, a period or a newline is refused outright, not escaped or stripped. " +
        "SAP itself allows '/' and '-' in customer transaction codes; this bridge does not, because " +
        "no run in this codebase has established that they are safe in that position.",
    );
  }
  return value;
}

/**
 * Quotes an ALREADY-VALIDATED identifier as an ABAP string literal — the
 * validators above already reject anything unsafe, so nothing is escaped
 * here. Never call this on an unvalidated string.
 */
function quoted(validatedIdentifier: string): string {
  return `'${validatedIdentifier}'`;
}

// ---------------------------------------------------------------------------
// The closed fragment
// ---------------------------------------------------------------------------

export interface TransactionParams {
  /** The transaction code to create, e.g. ZTM_CARRIERS. */
  tcode: string;
  /** The EXISTING report program it starts. */
  program: string;
  /** TSTCT-TTEXT. */
  description: string;
  /** DEVCLASS. */
  packageName: string;
  /**
   * An ALREADY gate-judged TRKORR. Required for a transportable
   * (non-`$`-prefixed) package — `RPY_TRANSACTION_INSERT`'s own
   * `RS_CORR_INSERT` call needs one to register the transaction in CTS — and
   * refused for a local, `$`-prefixed package, which registers with
   * `korrnum = space` instead (see {@link assertTransactionCreateTarget}).
   */
  corrNr?: string;
}

/**
 * `corrNr`, validated as an ALREADY gate-judged TRKORR — same grammar as
 * `view-create.ts`'s and `package-create.ts`'s own copies of this check;
 * each module keeps its own rather than sharing one across files.
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
  return value;
}

/**
 * No-network check: does this package/corr_nr pair make sense for a
 * transaction create? A local (`$`-prefixed) package refuses a `corrNr` — it
 * registers with `korrnum = space`, not a transport request, so there is
 * nothing for one to attach to. A transportable package requires a `corrNr`
 * in TRKORR format ({@link isTrkorr}), because `RPY_TRANSACTION_INSERT`'s own
 * `RS_CORR_INSERT` call needs one to register the transaction in CTS.
 */
export function assertTransactionCreateTarget(
  packageName: string,
  corrNr: string | undefined,
): string {
  const validated = assertEnhIdentifier(packageName, "packageName", {
    maxLength: PACKAGE_MAX_LENGTH,
    allowLocal: true,
  });
  const local = isLocalPackageName(validated);
  if (local && corrNr !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `corr_nr ${JSON.stringify(corrNr)} was supplied for local package ${JSON.stringify(validated)}, ` +
        "but a local ($-prefixed) transaction is registered with korrnum = space rather than on a " +
        "transport request, so there is nothing here for one to attach to.",
      { packageName: validated, corrNr },
    );
  }
  if (!local && corrNr === undefined) {
    throw new AbapError(
      "TRANSPORT_ERROR",
      `packageName ${JSON.stringify(validated)} is not local ($-prefixed), so this transaction must ` +
        "be registered in CTS via RPY_TRANSACTION_INSERT's own RS_CORR_INSERT call, which requires a " +
        "transport request — pass corr_nr (an ALREADY gate-judged TRKORR, e.g. A4HK900121).",
      { packageName: validated },
      "Via abap_write, pass corr_nr with the TRKORR the safety gate already judged for this write " +
        "(see the abapsmith-put-work-on-a-transport skill).",
    );
  }
  if (corrNr !== undefined) assertCorrNr(corrNr);
  return validated;
}

/**
 * The `DATA` declarations {@link transactionFragment} assumes exist — bare,
 * no leading `DATA` keyword (`ddicBridgeSource` prepends it). Empty: the
 * fragment needs no locals. Exported so the shape matches every other
 * operation on this bridge.
 */
export const TRAN_DATA_LINES: readonly string[] = [];

/**
 * `CALL FUNCTION 'RPY_TRANSACTION_INSERT'` — SE93's own backend, followed by
 * the mandatory `sy-subrc` check. Exported for the generator/parser drift
 * test in `test/tran-create.test.ts`. Built from validated values only:
 * identifiers via {@link quoted}, free text via {@link abapLiteral}.
 *
 * ASSUMPTION — the IMPORTING parameter names and the EXCEPTIONS list AND ITS
 * ORDER are read off a prose paraphrase, not a pasted signature. The names
 * are trustworthy (a misspelt one would fail bridge-class activation), but
 * the ORDER — which is what pins each `sy-subrc` value's meaning — is not. A
 * live run must confirm it: a deliberate collision with an existing
 * transaction should report `sy-subrc = 2`.
 *
 * `suppress_corr_insert` stays UNPASSED, for both a transportable and a local
 * package — verbatim-read live on A4H 2026-09-05: it `default`s to `space`,
 * and only when it is initial does the FM run `RS_CORR_INSERT` itself,
 * forwarding this call's `transport_number` straight through as `korrnum`.
 * Passing it would skip that registration.
 *
 * `transport_number` (also read verbatim 2026-09-05) is what carries
 * {@link TransactionParams.corrNr} through to `korrnum` — a quoted TRKORR for
 * a transportable package, `space` (ABAP's SPACE constant, not a quoted
 * literal) for a local one; see {@link assertTransactionCreateTarget}.
 *
 * `language = sy-langu`: the short text is written in the bridge session's
 * logon language; there is no parameter for choosing another one.
 *
 * Ends with an explicit `COMMIT WORK` as a safety net matching `VIEW/DV`'s —
 * not because `TRAN/T` was ever seen to fail, but because this bridge class
 * gives the running method no implicit commit, and whether the FM commits
 * internally (vs. something else making it stick) was never independently
 * confirmed. Harmless no-op either way; `src/adt/write-verify.ts`'s read-back
 * is still what decides `verified`. Full incident: the git history.
 */
export function transactionFragment(p: TransactionParams): string[] {
  const tcode = assertTransactionCode(p.tcode);
  const program = assertEnhIdentifier(p.program, "program", { maxLength: PROGRAM_MAX_LENGTH });
  const description = assertAbapText(p.description, "description", TTEXT_MAX_LENGTH);
  const packageName = assertTransactionCreateTarget(p.packageName, p.corrNr);
  const local = isLocalPackageName(packageName);
  const corrNr = local ? undefined : p.corrNr;

  return [
    "CALL FUNCTION 'RPY_TRANSACTION_INSERT'",
    `  EXPORTING transaction       = ${quoted(tcode)}`,
    `            program           = ${quoted(program)}`,
    `            dynpro            = ${quoted(REPORT_DYNPRO)}`,
    "            language          = sy-langu",
    `            development_class = ${quoted(packageName)}`,
    // A local ($-prefixed) package has no transport request to name; space is ABAP's SPACE constant, not a quoted literal.
    local ? "            transport_number  = space" : `            transport_number  = ${quoted(corrNr as string)}`,
    `            transaction_type  = ${quoted(TRANSACTION_TYPE_REPORT)}`,
    `            shorttext         = ${abapLiteral(description)}`,
    "  EXCEPTIONS cancelled = 1 already_exist = 2 permission_error = 3",
    "             name_not_allowed = 4 name_conflict = 5 illegal_type = 6",
    "             object_inconsistent = 7 db_access_error = 8 OTHERS = 9.",
    // Mandatory: RPY_TRANSACTION_INSERT reports failure via sy-subrc, not an
    // exception a CATCH would see. Skipping this would report success for a
    // no-op call — `already_exist` is the likely real-world case.
    ...subrcCheckFragment("RPY_TRANSACTION_INSERT", "TRAN-CREATED"),
    "",
    // Safety-net commit — see transactionFragment's doc comment above.
    "COMMIT WORK.",
  ];
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * Create a transaction code bound to an existing report program.
 *
 * Order matters: (1) validate every caller string first, including the
 * package/corr_nr pairing via {@link assertTransactionCreateTarget} — each
 * string is substituted verbatim into ABAP that gets activated and executed;
 * (2) {@link assertBridgeMutation} on the DOMAIN object (`TRAN/T` `tcode` in
 * `packageName`, with `corr` set for a transportable package), zero-network,
 * before any ABAP is generated — `deployBridge`'s own gate checks
 * `ZCL_ZMCP_DDIC_CTRAN` in `$TMP`, a different object entirely, so skipping
 * this step would let a scratch-class gate silently approve a transaction in
 * a customer package (`activate: false` because a transaction has no
 * activation step); (3) build the closed source; (4) deploy + execute +
 * assert the transcript.
 *
 * Throws `BAD_INPUT` for any refused string (including a bad corr_nr, or one
 * supplied for a local package), `TRANSPORT_ERROR` for a transportable
 * package given no corr_nr, whatever the gate throws for a refused mutation
 * (all before any network call), and `CHECK_FAILED` when the classrun comes
 * back without the `TRAN-CREATED` tag — including empty output, which is a
 * failure, not a success with nothing to say.
 */
export async function createTransaction(
  conn: AbapConnection,
  gate: SafetyGate,
  params: TransactionParams,
): Promise<{ run: RunResult; transcript: DdicTranscript }> {
  // 1 — re-validated inside transactionFragment too (exported, must be safe standalone).
  const tcode = assertTransactionCode(params.tcode);
  const program = assertEnhIdentifier(params.program, "program", { maxLength: PROGRAM_MAX_LENGTH });
  const description = assertAbapText(params.description, "description", TTEXT_MAX_LENGTH);
  const packageName = assertTransactionCreateTarget(params.packageName, params.corrNr);
  const local = isLocalPackageName(packageName);
  const corrNr = local ? undefined : params.corrNr;

  // 2 — the second gate, on the domain object, zero-network.
  const corr: SafetyCorr | undefined = local
    ? undefined
    : { kind: "transport", corrNr: corrNr as string, source: "named" };
  assertBridgeMutation(
    gate,
    { type: "TRAN/T", name: tcode, packageName },
    { activate: false, ...(corr !== undefined ? { corr } : {}) },
  );

  // 3
  const source = ddicBridgeSource(
    DDIC_BRIDGE_CLASS.createTransaction,
    TRAN_DATA_LINES,
    transactionFragment({ tcode, program, description, packageName, corrNr }),
  );

  // 4
  return runDdicBridge(conn, gate, {
    className: DDIC_BRIDGE_CLASS.createTransaction,
    source,
    description: `abapsmith create-transaction bridge (${tcode})`,
    what: `Creating transaction ${tcode}`,
    expectTags: ["TRAN-CREATED"],
  });
}
