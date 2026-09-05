/**
 * `TRAN/T` delete — `RPY_TRANSACTION_DELETE`, over the DDIC classrun bridge.
 *
 * ADT has no writable collection for `TRAN/T` (405 on every mutating verb —
 * see `./capabilities.ts`), so this reaches SE93's own backend the same way
 * `./tran-create.ts` reaches `RPY_TRANSACTION_INSERT`: a
 * generated `IF_OO_ADT_CLASSRUN` class deployed to `$TMP`.
 *
 * `RPY_TRANSACTION_DELETE`'s signature is not pasted from a capture — it is
 * inferred from `RPY_TRANSACTION_INSERT`'s `transaction` parameter name
 * (`./tran-create.ts`) on the assumption the pair shares a function group's
 * naming convention. That is an inference, not a verification: every
 * ASSUMPTION below is flagged at its use site and none has run live.
 *
 * `./package-delete.ts`'s TDEVC re-read (step 5) is the reason step 4 here
 * re-reads TSTC rather than trusting a clean `sy-subrc`: a function module
 * reporting success is not proof a row is gone.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import {
  assertBridgeMutation,
  DDIC_BRIDGE_CLASS,
  ddicBridgeSource,
  runDdicBridge,
  subrcCheckFragment,
  type DdicTranscript,
} from "./ddic-bridge.js";
import { assertEnhIdentifier } from "./enhancement-templates.js";
import { assertTransactionCode } from "./tran-create.js";
import { assertServerPackage, type ServerPackage } from "./resolved-package.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Package names may be local (`$TMP`); `DEVCLASS` is CHAR30 — same limit `./tran-create.ts` validates against. */
const PACKAGE_MAX_LENGTH = 30;

// ---------------------------------------------------------------------------
// The closed fragment
// ---------------------------------------------------------------------------

export interface TransactionDeleteParams {
  /** The transaction code to delete, e.g. ZTM_CARRIERS. */
  tcode: string;
}

/** {@link deleteTransactionViaBridge}'s params — {@link TransactionDeleteParams} plus the gate input `packageName`. */
export interface TransactionDeleteBridgeParams extends TransactionDeleteParams {
  /** Branded by `./resolved-package.ts` because this module is zero-network and cannot verify it itself. */
  packageName: ServerPackage;
}

/**
 * Bare `DATA` declarations for `ddicBridgeSource` (no leading `DATA`
 * keyword) — analogue of `./tran-create.ts`'s `TRAN_DATA_LINES`, non-empty
 * here because step 1/4 need a target for the `TSTC` read.
 */
export const TRAN_DELETE_DATA_LINES: readonly string[] = ["ls_tstc TYPE tstc."];

/**
 * Quotes an already-validated identifier as an ABAP string literal; mirrors
 * `./tran-create.ts`'s helper. Never call this on unvalidated input.
 */
function quoted(validatedIdentifier: string): string {
  return `'${validatedIdentifier}'`;
}

/**
 * `CALL FUNCTION 'RPY_TRANSACTION_DELETE'` — SE93's own backend, closed by a
 * `TSTC` re-read. Exported for the generator/parser drift test in
 * `test/tran-delete.test.ts`. Four steps, labelled inline below.
 */
export function transactionDeleteFragment(p: TransactionDeleteParams): string[] {
  const tcode = assertTransactionCode(p.tcode);
  const tc = quoted(tcode);

  // Step 1: refuse honestly if the tcode never existed, rather than
  // treating a delete of a never-existed code as a no-op.
  const step1 = [
    '" Step 1: confirm the transaction exists.',
    `SELECT SINGLE * FROM tstc INTO @ls_tstc WHERE tcode = ${tc}.`,
    "IF sy-subrc <> 0.",
    `  out->write( |ZMCP-DDIC-ERR> transaction ${tcode} does not exist| ).`,
    "  RETURN.",
    "ENDIF.",
    "",
  ];

  // Step 2 — ASSUMPTION: `transaction` is inferred from
  // RPY_TRANSACTION_INSERT's own parameter of that name (./tran-create.ts),
  // a sibling-FM naming convention, not a verified signature; a wrong name
  // fails bridge-class activation (a syntax error), never a silent wrong
  // delete. `EXCEPTIONS OTHERS = 1` only, deliberately: naming a specific
  // exception not present in the FM's real (unverified) signature is itself
  // a hard syntax error, whereas `OTHERS` always exists.
  const step2 = [
    '" Step 2: delete via RPY_TRANSACTION_DELETE.',
    "CALL FUNCTION 'RPY_TRANSACTION_DELETE'",
    `  EXPORTING transaction = ${tc}`,
    "  EXCEPTIONS OTHERS = 1.",
    ...subrcCheckFragment("RPY_TRANSACTION_DELETE", "TRAN-DELETED"),
    "",
  ];

  // Step 3: no implicit commit on classrun return.
  const step3 = ['" Step 3: commit.', "COMMIT WORK.", ""];

  // Step 4: a clean sy-subrc from step 2 is not trusted as proof (mirrors
  // ./package-delete.ts's TDEVC re-read) — only a TSTC re-read earns
  // TRAN-GONE. TSTC alone is what makes the transaction exist; whether
  // RPY_TRANSACTION_DELETE also cleans up TSTCT/TSTCC is unverified and
  // out of scope for this proof step.
  const step4 = [
    '" Step 4: prove absence.',
    `SELECT SINGLE * FROM tstc INTO @ls_tstc WHERE tcode = ${tc}.`,
    "IF sy-subrc = 0.",
    `  out->write( |ZMCP-DDIC-ERR> delete of ${tcode} reported no error but the TSTC row still exists| ).`,
    "  RETURN.",
    "ENDIF.",
    "out->write( 'TRAN-GONE' ).",
  ];

  return [...step1, ...step2, ...step3, ...step4];
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * Delete a `TRAN/T` transaction code via the DDIC classrun bridge. Mirrors
 * `./package-delete.ts`'s `deletePackageViaBridge`: gates with `op: "delete"`
 * (not the default write) before any ABAP is generated. No transport
 * handling — `RPY_TRANSACTION_INSERT` calls `RS_CORR_INSERT` internally
 * (`./tran-create.ts`); whether the delete FM does the same, and whether
 * that risks the same headless-dynpro failure in a transportable
 * package, is unverified and left to a live run.
 *
 * Throws `SAFETY_DENIED`/`PACKAGE_UNKNOWN` for an unbranded `packageName`,
 * `BAD_INPUT` for a refused tcode or package identifier, whatever the gate
 * throws for a refused mutation (all three before any network call), and
 * `CHECK_FAILED` when the classrun comes back without both `TRAN-DELETED`
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

  // 1 — re-validated inside transactionDeleteFragment too (exported, must be safe standalone).
  const tcode = assertTransactionCode(params.tcode);
  const packageName = assertEnhIdentifier(params.packageName.name, "packageName", {
    maxLength: PACKAGE_MAX_LENGTH,
    allowLocal: true,
  });

  // 2 — the second gate, on the domain object, zero-network, before any ABAP
  // is generated. `op: "delete"` matters: a delete must be gated and audited
  // as a delete, not a write. `local`: the fragment passes no request and
  // issues no RS_CORR_INSERT — nothing registers in CTS to judge, and this
  // FM's CTS behaviour is inferred like the rest of the module, not measured.
  assertBridgeMutation(
    gate,
    { type: "TRAN/T", name: tcode, packageName },
    { activate: false, op: "delete", corr: { kind: "local" } },
  );

  // 3
  const source = ddicBridgeSource(
    DDIC_BRIDGE_CLASS.deleteTransaction,
    TRAN_DELETE_DATA_LINES,
    transactionDeleteFragment({ tcode }),
  );

  // 4 — `beforeAssert` turns the "transaction does not exist" transcript into
  // a named error, rather than the generic missing-tag CHECK_FAILED the
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

  return runDdicBridge(conn, gate, {
    className: DDIC_BRIDGE_CLASS.deleteTransaction,
    source,
    description: `abapsmith delete-transaction bridge (${tcode})`,
    what: `Deleting transaction ${tcode}`,
    expectTags: ["TRAN-DELETED", "TRAN-GONE"],
    beforeAssert,
  });
}
