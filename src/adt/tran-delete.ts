/**
 * `TRAN/T` delete — `RPY_TRANSACTION_DELETE`, over the fluid `classic`
 * tool's `delete_transaction` action.
 *
 * ADT has no writable collection for `TRAN/T` (405 on every mutating verb —
 * see `./capabilities.ts`), so this reaches SE93's own backend the same way
 * `./tran-create.ts` reaches `RPY_TRANSACTION_INSERT`: dispatched to
 * `ZCL_ZMCP_FLUID_CLASSIC` via `./classic-call.ts`, whose ABAP now lives in
 * `src/adt/fluid/builtin/classic/abap-tran.ts`.
 *
 * `RPY_TRANSACTION_DELETE`'s signature was captured live on A4H (NetWeaver
 * 7.54, client 001) 2026-09-12 (see `./tran-update.ts`'s header, which
 * records the same capture): `transaction` (required), `transport_number`
 * OPTIONAL, `suppress_authority_check`, `suppress_corr_insert`,
 * `suppress_corr_check`; exceptions `not_excecuted` (SAP's own misspelling)
 * and `object_not_found`. Delete is now transport-aware (issue #202): a
 * transaction in a transportable (non-`$`) package registers via
 * `RS_CORR_INSERT` before the delete FM runs, the same way
 * `./tran-update.ts`'s retarget does, rather than letting
 * `RPY_TRANSACTION_DELETE`'s own headless SAPLSTRD 0300 transport-request
 * dialog fail the call. A local (`$`-prefixed) package still deletes with no
 * transport at all.
 *
 * `./package-delete.ts`'s TDEVC re-read is the reason `abap-tran.ts`'s
 * `delete_transaction` re-reads TSTC after the delete FM rather than
 * trusting a clean `sy-subrc`: a function module reporting success is not
 * proof a row is gone.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyCorr, SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import { assertBridgeMutation } from "./bridge-mutation.js";
import type { DdicTranscript } from "./ddic-transcript.js";
import { runClassicAction } from "./classic-call.js";
import { assertEnhIdentifier } from "./enhancement-templates.js";
import { assertTransactionCode, assertTransactionCorrNr } from "./tran-create.js";
import { isLocalPackageName } from "./transports.js";
import { assertServerPackage, type ServerPackage } from "./resolved-package.js";
import { lookupTransaction } from "./ui-tstc.js";
import { verifyObjectDeleted, vitBridgeUri, VIT_STUB_ACCEPT, type VerifyOutcome } from "./write-verify.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Package names may be local (`$TMP`); `DEVCLASS` is CHAR30 — same limit `./tran-create.ts` validates against. */
const PACKAGE_MAX_LENGTH = 30;

export interface TransactionDeleteParams {
  /** The transaction code to delete, e.g. ZTM_CARRIERS. */
  tcode: string;
}

/** {@link deleteTransactionViaBridge}'s params — {@link TransactionDeleteParams} plus the gate input `packageName`. */
export interface TransactionDeleteBridgeParams extends TransactionDeleteParams {
  /** Branded by `./resolved-package.ts` because this module is zero-network and cannot verify it itself. */
  packageName: ServerPackage;
  /**
   * Forwarded to the fluid `delete_transaction` action's `confirm_in_role_menu` input
   * (`src/adt/fluid/builtin/classic.ts`). The ABAP (`abap-tran.ts`) reads AGR_TCODES
   * and refuses the delete when the tcode sits in a role menu, unless this is `true`;
   * omitted or `false` reads as `false` there, same as the guard's default.
   */
  confirmInRoleMenu?: boolean;
  /**
   * An ALREADY gate-judged TRKORR. Required for a transportable
   * (non-`$`-prefixed) package — `abap-tran.ts`'s `delete_transaction`
   * registers the tcode via `RS_CORR_INSERT` before deleting it, the same
   * way `./tran-update.ts`'s retarget does — and refused for a local,
   * `$`-prefixed package, which deletes with no transport at all.
   */
  corrNr?: string;
  /** How `corrNr` was chosen — see `./tran-create.ts`'s `TransactionParams.corrSource`. */
  corrSource?: "named" | "auto";
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * Delete a `TRAN/T` transaction code via the fluid `classic` tool's
 * `delete_transaction` action. Mirrors `./package-delete.ts`'s
 * `deletePackageViaBridge`: gates with `op: "delete"` (not the default
 * write) before dispatching anything.
 *
 * Transport-aware (issue #202): a transportable package requires `corrNr`,
 * validated the same way `./tran-create.ts`'s `assertTransactionCorrNr`
 * does; a local package refuses one, same rule as create/update.
 *
 * Throws `SAFETY_DENIED`/`PACKAGE_UNKNOWN` for an unbranded `packageName`,
 * `BAD_INPUT` for a refused tcode, package identifier or corr_nr,
 * `TRANSPORT_ERROR` for a transportable package given no corr_nr, whatever
 * the gate throws for a refused mutation (all before any network call), and
 * `CHECK_FAILED` when the transcript comes back without both `TRAN-DELETED`
 * and `TRAN-GONE` — including empty output, which is a failure, not a
 * success with nothing to say.
 */
export async function deleteTransactionViaBridge(
  conn: AbapConnection,
  gate: SafetyGate,
  params: TransactionDeleteBridgeParams,
): Promise<{ run: RunResult; transcript: DdicTranscript }> {
  // 0 — runtime half of the ServerPackage brand (src/adt/resolved-package.ts),
  // for the callers TypeScript can't reach: plain JS, or an `as any`/`as
  // unknown as ServerPackage` cast. TypeScript already refuses a bare string
  // or a hand-built object literal at the call site.
  assertServerPackage(params.packageName, `transaction ${params.tcode}`);

  // 1
  const tcode = assertTransactionCode(params.tcode);
  const packageName = assertEnhIdentifier(params.packageName.name, "packageName", {
    maxLength: PACKAGE_MAX_LENGTH,
    allowLocal: true,
  });
  const local = isLocalPackageName(packageName);
  if (local && params.corrNr !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `corr_nr ${JSON.stringify(params.corrNr)} was supplied for local package ${JSON.stringify(packageName)}, ` +
        "but a local ($-prefixed) transaction is deleted with no transport request, so there is nothing " +
        "here for one to attach to.",
      { packageName, corrNr: params.corrNr },
    );
  }
  if (!local && params.corrNr === undefined) {
    throw new AbapError(
      "TRANSPORT_ERROR",
      `packageName ${JSON.stringify(packageName)} is not local ($-prefixed), so deleting transaction ` +
        `${tcode} must be registered in CTS via RS_CORR_INSERT first, which requires a transport ` +
        "request — and none was resolved for this call.",
      { packageName, tcode },
      "Through abap_write no corr_nr is needed: omitted, the request is resolved under " +
        "ABAP_ALLOW_TRANSPORTS before this module runs. A direct caller of this module hands it a " +
        "TRKORR the safety gate has already judged.",
    );
  }
  const corrNr = local ? undefined : params.corrNr;
  if (corrNr !== undefined) assertTransactionCorrNr(corrNr);

  const corr: SafetyCorr | undefined = local
    ? undefined
    : { kind: "transport", corrNr: corrNr as string, source: params.corrSource ?? "named" };

  // 2 — the second gate, on the domain object, zero-network, before
  // dispatching anything. `op: "delete"` matters: a delete must be gated and
  // audited as a delete, not a write.
  assertBridgeMutation(
    gate,
    { type: "TRAN/T", name: tcode, packageName },
    { activate: false, op: "delete", ...(corr !== undefined ? { corr } : { corr: { kind: "local" } }) },
  );

  // `beforeAssert` turns two known transcript shapes into named errors,
  // rather than the generic missing-tag CHECK_FAILED the transcript
  // assertion would otherwise give.
  const beforeAssert = (transcript: DdicTranscript): void => {
    const errorLine = transcript.errorLine;
    if (!errorLine) return;
    if (errorLine.includes("does not exist")) {
      throw new AbapError(
        "CHECK_FAILED",
        `Transaction ${tcode} does not exist and was NOT deleted. Raw ABAP-side detail: ${errorLine}`,
        { tcode, raw: transcript.raw },
      );
    }
    if (errorLine.includes("SAPLSTRD") || errorLine.includes("no transport request")) {
      throw new AbapError(
        "TRANSPORT_ERROR",
        `Deleting transaction ${tcode} needs a transport request and none was registered. Raw ` +
          `ABAP-side detail: ${errorLine}`,
        { tcode, raw: transcript.raw },
        "Pass corr_nr (an ALREADY gate-judged TRKORR), or set ABAP_ALLOW_TRANSPORTS so abap_write " +
          "resolves one before this module runs.",
      );
    }
  };

  return runClassicAction(conn, gate, {
    action: "delete_transaction",
    args: {
      tcode,
      package_name: packageName,
      corr_nr: corrNr ?? "",
      ...(params.confirmInRoleMenu !== undefined ? { confirm_in_role_menu: params.confirmInRoleMenu } : {}),
    },
    what: `Deleting transaction ${tcode}`,
    ...(corr !== undefined ? { corrSource: corr.source } : {}),
    expectTags: ["TRAN-DELETED", "TRAN-GONE"],
    beforeAssert,
  });
}

/**
 * `TRAN/T` delete verification with the create path's TSTC cross-check
 * (issue #201): a VIT-bridge 200 is not proof the delete failed, since the
 * bridge answers 200 even for a TCODE that never existed. Only queries TSTC
 * when {@link verifyObjectDeleted} did not already settle absence.
 */
export async function verifyTransactionDeleted(conn: AbapConnection, tcode: string): Promise<VerifyOutcome> {
  const uri = vitBridgeUri("trant", tcode);
  const outcome = await verifyObjectDeleted(conn, {
    uri,
    accept: VIT_STUB_ACCEPT,
    objectName: tcode,
    expectType: "TRAN/T",
  });
  if (outcome.status === "confirmed-absent") return outcome;
  let tstc: Awaited<ReturnType<typeof lookupTransaction>>;
  try {
    tstc = await lookupTransaction(conn, tcode);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (outcome.status === "indeterminate") {
      return { ...outcome, reason: `${outcome.reason} The TSTC cross-check also failed: ${msg}` };
    }
    return outcome;
  }
  if (tstc === undefined) return { status: "confirmed-absent", uri, via: "tstc" };
  return { status: "confirmed", uri, via: "tstc" };
}
