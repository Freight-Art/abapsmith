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
 * `RPY_TRANSACTION_DELETE`'s signature is not pasted from a capture — it is
 * inferred from `RPY_TRANSACTION_INSERT`'s `transaction` parameter name
 * (`./tran-create.ts`) on the assumption the pair shares a function group's
 * naming convention. That is an inference, not a verification: every
 * ASSUMPTION below is flagged at its use site and none has run live.
 * `abap-tran.ts`'s `delete_transaction` method calls it with `EXCEPTIONS
 * OTHERS = 1` only, deliberately: naming a specific exception not present in
 * the FM's real (unverified) signature is itself a hard syntax error,
 * whereas `OTHERS` always exists.
 *
 * `./package-delete.ts`'s TDEVC re-read (step 5) is the reason step 4 here
 * re-reads TSTC rather than trusting a clean `sy-subrc`: a function module
 * reporting success is not proof a row is gone. TSTC alone is what makes the
 * transaction exist; whether `RPY_TRANSACTION_DELETE` also cleans up
 * TSTCT/TSTCC is unverified and out of scope for that proof step.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import { assertBridgeMutation } from "./bridge-mutation.js";
import type { DdicTranscript } from "./ddic-transcript.js";
import { runClassicAction } from "./classic-call.js";
import { assertEnhIdentifier } from "./enhancement-templates.js";
import { assertTransactionCode } from "./tran-create.js";
import { assertServerPackage, type ServerPackage } from "./resolved-package.js";

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
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * Delete a `TRAN/T` transaction code via the fluid `classic` tool's
 * `delete_transaction` action. Mirrors `./package-delete.ts`'s
 * `deletePackageViaBridge`: gates with `op: "delete"` (not the default
 * write) before dispatching anything. No transport handling —
 * `RPY_TRANSACTION_INSERT` calls `RS_CORR_INSERT` internally
 * (`./tran-create.ts`); whether the delete FM does the same, and whether
 * that risks the same headless-dynpro failure in a transportable
 * package, is unverified and left to a live run.
 *
 * Throws `SAFETY_DENIED`/`PACKAGE_UNKNOWN` for an unbranded `packageName`,
 * `BAD_INPUT` for a refused tcode or package identifier, whatever the gate
 * throws for a refused mutation (all three before any network call), and
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

  // 2 — the second gate, on the domain object, zero-network, before
  // dispatching anything. `op: "delete"` matters: a delete must be gated and
  // audited as a delete, not a write. `local`: the ABAP passes no request and
  // issues no RS_CORR_INSERT — nothing registers in CTS to judge, and this
  // FM's CTS behaviour is inferred like the rest of the module, not measured.
  assertBridgeMutation(
    gate,
    { type: "TRAN/T", name: tcode, packageName },
    { activate: false, op: "delete", corr: { kind: "local" } },
  );

  // `beforeAssert` turns the "transaction does not exist" transcript into a
  // named error, rather than the generic missing-tag CHECK_FAILED the
  // transcript assertion would otherwise give.
  const beforeAssert = (transcript: DdicTranscript): void => {
    if (transcript.errorLine?.includes("does not exist")) {
      throw new AbapError(
        "CHECK_FAILED",
        `Transaction ${tcode} does not exist and was NOT deleted. Raw ABAP-side detail: ${transcript.errorLine}`,
        { tcode, raw: transcript.raw },
      );
    }
  };

  return runClassicAction(conn, gate, {
    action: "delete_transaction",
    args: {
      tcode,
      package_name: packageName,
      ...(params.confirmInRoleMenu !== undefined ? { confirm_in_role_menu: params.confirmInRoleMenu } : {}),
    },
    what: `Deleting transaction ${tcode}`,
    expectTags: ["TRAN-DELETED", "TRAN-GONE"],
    beforeAssert,
  });
}
