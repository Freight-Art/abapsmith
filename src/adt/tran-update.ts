/**
 * # `TRAN/T` update (retarget) — `RPY_TRANSACTION_DELETE` +
 * `RPY_TRANSACTION_INSERT`, over the fluid `classic` tool's
 * `update_transaction` action
 *
 * ADT has no writable collection for `TRAN/T` (405 on every mutating verb —
 * see `./capabilities.ts`), so this reaches SE93's own backend the same way
 * `./tran-create.ts` and `./tran-delete.ts` do: dispatched to
 * `ZCL_ZMCP_FLUID_CLASSIC` via `./classic-call.ts`, whose ABAP now lives in
 * `src/adt/fluid/builtin/classic/abap-tran.ts`'s `update_transaction`
 * method.
 *
 * `RPY_TRANSACTION_DELETE`'s signature was captured live on A4H
 * (NetWeaver 7.54, client 001) 2026-09-12 — unlike `./tran-delete.ts`'s
 * header, which still calls it inferred: `IN TRANSACTION TSTC-TCODE`
 * (required), `TRANSPORT_NUMBER RGLIF-TRKORR`,
 * `SUPPRESS_AUTHORITY_CHECK CHAR1`, `SUPPRESS_CORR_INSERT CHAR1`,
 * `SUPPRESS_CORR_CHECK CHAR1`; exceptions `NOT_EXCECUTED` (SAP's own
 * misspelling, not a typo introduced here) and `OBJECT_NOT_FOUND`.
 * `abap-tran.ts`'s `update_transaction` method registers the change once via
 * `RS_CORR_INSERT`, then calls `RPY_TRANSACTION_DELETE` with
 * `suppress_corr_insert`/`suppress_corr_check` both `'X'` (the registration
 * above already covers CTS), then re-`RPY_TRANSACTION_INSERT`s against the
 * new program, then re-reads TSTC to prove `PGMNA` actually changed before
 * emitting `TRAN-RETARGETED`.
 *
 * Proven live on A4H 2026-09-12, in `$TMP` only: the delete step returned
 * message EU075, and the read-back showed the new program. The
 * transportable (non-`$TMP`) path runs the identical FM sequence with a
 * real `korrnum` but has NOT itself been run against a live system.
 *
 * `packageName` here is a {@link ServerPackage} — server-resolved, not a
 * caller-supplied string — same as `./tran-delete.ts`'s delete: this
 * module is zero-network and mutates an EXISTING transaction, so it cannot
 * verify a bare string package itself.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyCorr, SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import { assertBridgeMutation } from "./bridge-mutation.js";
import type { DdicTag, DdicTranscript } from "./ddic-transcript.js";
import { runClassicAction } from "./classic-call.js";
import { assertAbapText, assertEnhIdentifier } from "./enhancement-templates.js";
import { isLocalPackageName, isTrkorr } from "./transports.js";
import { assertTransactionCode } from "./tran-create.js";
import { assertServerPackage, type ServerPackage } from "./resolved-package.js";

// ---------------------------------------------------------------------------
// Parameters and limits
// ---------------------------------------------------------------------------

/** `TSTCT-TTEXT` is CHAR80 on the system, but this bridge enforces a 36-character limit (issue #209) — same ceiling `./tran-create.ts` validates against. */
const TTEXT_MAX_LENGTH = 36;

/** `PROGNAME`/`TSTC-PGMNA` is CHAR40 — same ceiling `./tran-create.ts` validates against. */
const PROGRAM_MAX_LENGTH = 40;

/** `DEVCLASS` is CHAR30 — same ceiling `./tran-create.ts` validates against. */
const PACKAGE_MAX_LENGTH = 30;

export interface TransactionUpdateParams {
  /** The EXISTING transaction code to retarget, e.g. ZTM_CARRIERS. */
  tcode: string;
  /** The new report program it starts. */
  program: string;
  /** TSTCT-TTEXT. */
  description: string;
  /** Server-resolved (`./resolved-package.ts`) — this module is zero-network and cannot verify it itself. */
  packageName: ServerPackage;
  /**
   * An ALREADY gate-judged TRKORR. Required for a transportable
   * (non-`$`-prefixed) package, refused for a local one — same rule
   * `./tran-create.ts`'s `assertTransactionCreateTarget` documents.
   */
  corrNr?: string;
  /** Whether `corrNr` was named by a human or picked by the server — see `SafetyCorr` (`../safety.js`). */
  corrSource?: "named" | "auto";
  /**
   * Required (true) when the tcode is already assigned to one or more
   * roles' menus (AGR_TCODES) — retargeting it changes what those menu
   * entries launch. An SM01 transaction lock is NOT checked either way —
   * see `abap-tran.ts`'s `update_transaction` method's own honesty note.
   */
  confirmInRoleMenu?: boolean;
}

/**
 * `corrNr`, validated as an ALREADY gate-judged TRKORR — same grammar as
 * `./tran-create.ts`'s own copy of this check.
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
 * No-network check: does this package/corr_nr pairing make sense for a
 * transaction retarget? Same rule as `./tran-create.ts`'s
 * `assertTransactionCreateTarget`: a local (`$`-prefixed) package refuses a
 * `corrNr`; a transportable package requires one.
 */
export function assertTransactionUpdateTarget(packageName: string, corrNr: string | undefined): string {
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
      `packageName ${JSON.stringify(validated)} is not local ($-prefixed), so this retarget must be ` +
        "registered in CTS via RS_CORR_INSERT, which requires a transport request — pass corr_nr " +
        "(an ALREADY gate-judged TRKORR, e.g. A4HK900121).",
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
 * Retarget an EXISTING transaction code to a different report program.
 *
 * Order matches `./tran-create.ts`'s `createTransaction`: (1) validate every
 * caller string, including the package/corr_nr pairing via
 * {@link assertTransactionUpdateTarget}; (2) {@link assertBridgeMutation} on
 * the domain object, zero-network, before dispatching anything
 * (`activate: false` — a transaction has no activation step); (3) dispatch
 * `update_transaction` and assert the transcript.
 *
 * `expectTags` is `TRAN-REGISTERED`, `TRAN-RETARGETED` — read off
 * `abap-tran.ts`'s `update_transaction` method's own `line(...)` calls.
 * `TRAN-REGISTERED` fires before `RPY_TRANSACTION_DELETE`/
 * `RPY_TRANSACTION_INSERT` run, so a later failure can leave the CTS
 * registration in place with the old program still bound — see
 * `updatePartialSuccess` below.
 */
export async function updateTransaction(
  conn: AbapConnection,
  gate: SafetyGate,
  params: TransactionUpdateParams,
): Promise<{ run: RunResult; transcript: DdicTranscript }> {
  assertServerPackage(params.packageName, `transaction ${params.tcode}`);

  const tcode = assertTransactionCode(params.tcode);
  const program = assertEnhIdentifier(params.program, "program", { maxLength: PROGRAM_MAX_LENGTH });
  const description = assertAbapText(params.description, "description", TTEXT_MAX_LENGTH);
  const packageName = assertTransactionUpdateTarget(params.packageName.name, params.corrNr);
  const local = isLocalPackageName(packageName);
  const corrNr = local ? undefined : params.corrNr;

  const corr: SafetyCorr | undefined = local
    ? undefined
    : { kind: "transport", corrNr: corrNr as string, source: params.corrSource ?? "named" };

  assertBridgeMutation(
    gate,
    { type: "TRAN/T", name: tcode, packageName },
    { activate: false, ...(corr !== undefined ? { corr } : {}) },
  );

  // beforeAssert turns the "transaction does not exist" transcript into a named
  // error, rather than the generic missing-tag CHECK_FAILED the transcript
  // assertion would otherwise give — same shape as ./tran-delete.ts's beforeAssert.
  const beforeAssert = (transcript: DdicTranscript): void => {
    if (transcript.errorLine?.includes("does not exist")) {
      throw new AbapError(
        "CHECK_FAILED",
        `Transaction ${tcode} does not exist, so there is nothing to retarget. Raw ABAP-side detail: ` +
          `${transcript.errorLine}`,
        { tcode, raw: transcript.raw },
      );
    }
  };

  const expectTags: DdicTag[] = ["TRAN-REGISTERED", "TRAN-RETARGETED"];

  return runClassicAction(conn, gate, {
    action: "update_transaction",
    args: {
      tcode,
      program,
      description,
      package_name: packageName,
      corr_nr: corrNr ?? "",
      ...(params.confirmInRoleMenu !== undefined ? { confirm_in_role_menu: params.confirmInRoleMenu } : {}),
    },
    what: `Retargeting transaction ${tcode}`,
    expectTags,
    beforeAssert,
  });
}
