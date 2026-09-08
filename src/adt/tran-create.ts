/**
 * # `TRAN/T` create — SE93's own backend, over the fluid `classic` tool
 *
 * ADT has no writable collection for `TRAN/T` (405 on every mutating verb via
 * the VIT bridge — see `./capabilities.ts`). SE93 itself calls
 * `RPY_TRANSACTION_INSERT` (function group `SEUA`), so this module validates
 * and gates the request, then dispatches it as the `create_transaction`
 * action of the fluid `classic` tool (`./classic-call.ts`), which calls that
 * FM from `ZCL_ZMCP_FLUID_CLASSIC` and reads the outcome back off a tagged
 * transcript. The ABAP itself now lives in
 * `src/adt/fluid/builtin/classic/abap-tran.ts`.
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
import { assertBridgeMutation } from "./bridge-mutation.js";
import type { DdicTranscript } from "./ddic-transcript.js";
import { runClassicAction } from "./classic-call.js";
import { assertAbapText, assertEnhIdentifier } from "./enhancement-templates.js";
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

// ---------------------------------------------------------------------------
// Validation, applied to every caller string
// ---------------------------------------------------------------------------

/**
 * A transaction code, validated before it is handed to the fluid `classic`
 * tool as the `tcode` argument.
 *
 * Its own grammar, not {@link assertEnhIdentifier}'s: a letter, then
 * letters/digits/underscores, max {@link TCODE_MAX_LENGTH}. Deliberately
 * NARROWER than SAP's own rule — no `/` or `-` — because nothing in this
 * codebase has validated that punctuation is safe once it reaches
 * `abap-tran.ts`'s `s( 'tcode' )` read and the `CALL FUNCTION` it feeds. Not
 * trimmed or upper-cased, so validation and dispatch see the same string.
 * Full argument: the git history.
 */
export function assertTransactionCode(value: string, what = "tcode"): string {
  if (typeof value !== "string" || !new RegExp(`^[A-Za-z][A-Za-z0-9_]{0,${TCODE_MAX_LENGTH - 1}}$`).test(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} ${JSON.stringify(value)} is not a valid transaction code for this bridge (a letter, then ` +
        `letters, digits and underscores only, max ${TCODE_MAX_LENGTH} characters).`,
      { what, value, maxLength: TCODE_MAX_LENGTH },
      "A quote, a period or a newline is refused outright, not escaped or stripped. SAP itself allows " +
        "'/' and '-' in customer transaction codes; this bridge does not, because no run in this " +
        "codebase has established that they are safe in that position.",
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Target validation
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

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * Create a transaction code bound to an existing report program.
 *
 * Order matters: (1) validate every caller string first, including the
 * package/corr_nr pairing via {@link assertTransactionCreateTarget}; (2)
 * {@link assertBridgeMutation} on the DOMAIN object (`TRAN/T` `tcode` in
 * `packageName`, with `corr` set for a transportable package), zero-network,
 * before dispatching anything — the fluid tool's own gate only judges the
 * invoker class deployment, a different object entirely, so skipping this
 * step would let that gate silently approve a transaction in a customer
 * package (`activate: false` because a transaction has no activation step);
 * (3) dispatch the `create_transaction` action and assert the transcript.
 *
 * `abap-tran.ts`'s `create_transaction` method calls
 * `RPY_TRANSACTION_INSERT` with `suppress_corr_insert` left UNPASSED for
 * both a transportable and a local package — verbatim-read live on A4H
 * 2026-09-05: it `default`s to `space`, and only when it is initial does the
 * FM run `RS_CORR_INSERT` itself, forwarding `transport_number` straight
 * through as `korrnum`. `transport_number` (also read verbatim 2026-09-05)
 * carries `corr_nr` through to `korrnum` — the TRKORR for a transportable
 * package, `space` (ABAP's SPACE constant) for a local one. `language =
 * sy-langu`: the short text is written in the session's logon language;
 * there is no parameter for choosing another one. The IMPORTING parameter
 * names and the EXCEPTIONS list AND ITS ORDER are read off a prose
 * paraphrase, not a pasted signature — the names are trustworthy (a
 * misspelt one fails invoker-class activation), but the ORDER, which pins
 * each `sy-subrc` value's meaning, is not; a live run must confirm it: a
 * deliberate collision with an existing transaction should report
 * `sy-subrc = 2`.
 *
 * Throws `BAD_INPUT` for any refused string (including a bad corr_nr, or one
 * supplied for a local package), `TRANSPORT_ERROR` for a transportable
 * package given no corr_nr, whatever the gate throws for a refused mutation
 * (all before any network call), and `CHECK_FAILED` when the transcript
 * comes back without the `TRAN-CREATED` tag — including empty output, which
 * is a failure, not a success with nothing to say.
 */
export async function createTransaction(
  conn: AbapConnection,
  gate: SafetyGate,
  params: TransactionParams,
): Promise<{ run: RunResult; transcript: DdicTranscript }> {
  const tcode = assertTransactionCode(params.tcode);
  const program = assertEnhIdentifier(params.program, "program", { maxLength: PROGRAM_MAX_LENGTH });
  const description = assertAbapText(params.description, "description", TTEXT_MAX_LENGTH);
  const packageName = assertTransactionCreateTarget(params.packageName, params.corrNr);
  const local = isLocalPackageName(packageName);
  const corrNr = local ? undefined : params.corrNr;

  const corr: SafetyCorr | undefined = local
    ? undefined
    : { kind: "transport", corrNr: corrNr as string, source: "named" };
  assertBridgeMutation(
    gate,
    { type: "TRAN/T", name: tcode, packageName },
    { activate: false, ...(corr !== undefined ? { corr } : {}) },
  );

  return runClassicAction(conn, gate, {
    action: "create_transaction",
    args: {
      tcode,
      program,
      description,
      package_name: packageName,
      corr_nr: corrNr ?? "",
    },
    what: `Creating transaction ${tcode}`,
    expectTags: ["TRAN-CREATED"],
  });
}
