/**
 * `VIEW/DV` (classic DDIC view) delete — `DDIF_VIEW_DELETE`, over the DDIC
 * classrun bridge.
 *
 * ADT REST is GET-only for `VIEW/DV` (`./view-create.ts`'s header), so this
 * reaches the delete FM the same way `./package-delete.ts` reaches
 * `CL_PACKAGE_FACTORY`: a generated `IF_OO_ADT_CLASSRUN` class deployed to
 * `$TMP`.
 *
 * `DDIF_VIEW_DELETE`'s parameter set and failure behaviour have not been
 * verified against a live system — both are marked `ASSUMPTION:` at their
 * point of use in {@link viewDeleteFragment}, mirroring `./view-create.ts`'s
 * own unverified-signature discipline for `DDIF_VIEW_PUT`/`DDIF_VIEW_ACTIVATE`.
 *
 * NO TRANSPORT HANDLING: no `corrNr` is accepted and no `RS_CORR_INSERT` is
 * generated. Whether deleting a transportable view needs its own CTS
 * registration, and whether `DDIF_VIEW_DELETE` performs one internally and so
 * risks the same headless-dynpro failure `./view-create.ts`'s `RS_CORR_INSERT`
 * hit live (see `./ddic-bridge.ts`'s `isHeadlessDynproFailure`),
 * is UNKNOWN and NOT modelled here. This code has not been exercised live at
 * all, for any package: `./view-create.ts`'s create never produces a
 * `packageRef`'d view — a `$TMP` create is orphaned, a
 * non-`$TMP` create is refused outright — and the safety gate
 * refuses a delete on a `packageRef`-less object before it ever reaches this
 * bridge.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import {
  DDIC_BRIDGE_CLASS,
  assertBridgeMutation,
  ddicBridgeSource,
  runDdicBridge,
  subrcCheckFragment,
  type DdicTranscript,
} from "./ddic-bridge.js";
import { abapLiteral, assertEnhIdentifier } from "./enhancement-templates.js";
import { assertServerPackage, type ServerPackage } from "./resolved-package.js";

// ---------------------------------------------------------------------------
// Parameters and limits
// ---------------------------------------------------------------------------

export interface ViewDeleteParams {
  /** The view to delete, e.g. ZTM_V_CARRIER. */
  viewName: string;
  /** Server-resolved (`./resolved-package.ts`) — this module is zero-network and cannot verify it itself. */
  packageName: ServerPackage;
}

/** `DDOBJNAME`/`VIEWNAME` are CHAR30 — same ceiling `./view-create.ts` uses. */
const VIEW_NAME_MAX = 30;

/** The view name validated once, so the fragment can never see a raw one. */
function validate(p: ViewDeleteParams): { viewName: string } {
  const viewName = assertEnhIdentifier(p.viewName, "viewName", { maxLength: VIEW_NAME_MAX });
  return { viewName };
}

// ---------------------------------------------------------------------------
// The generated ABAP
// ---------------------------------------------------------------------------

/**
 * Bare `DATA` declarations for `ddicBridgeSource` (no leading `DATA`
 * keyword) — analogue of `./package-delete.ts`'s `PACKAGE_DELETE_DATA_LINES`.
 */
export const VIEW_DELETE_DATA_LINES: readonly string[] = [
  "ls_dd25l TYPE dd25l.",
  "lv_dd25l_count TYPE i.",
];

/**
 * The closed ABAP fragment that deletes one classic database view. Exported
 * for the generator/parser drift test — every `out->write( 'TAG' )` it emits
 * must be a tag `parseDdicTranscript` recognises.
 *
 * Four steps, labelled inline below, mirroring `./package-delete.ts`'s
 * discipline of never trusting a clean `sy-subrc` as proof of the mutation —
 * step 4 re-reads `DD25L` rather than returning on `DDIF_VIEW_DELETE`'s own
 * report alone.
 */
export function viewDeleteFragment(p: ViewDeleteParams): string[] {
  const { viewName } = validate(p);
  const view = abapLiteral(viewName);

  // Step 1: a delete of a name that never existed is a refusal, not a no-op.
  const step1 = [
    '" Step 1: confirm the view exists.',
    `SELECT SINGLE * FROM dd25l INTO @ls_dd25l WHERE viewname = ${view}.`,
    "IF sy-subrc <> 0.",
    `  out->write( |ZMCP-DDIC-ERR> view ${viewName} does not exist| ).`,
    "  RETURN.",
    "ENDIF.",
  ];

  // ASSUMPTION: only NAME is passed — DDIF_VIEW_DELETE's full parameter set
  // is transcribed from the FM family, not live-verified, and an unverified
  // extra parameter risks a syntax error at bridge activation. In particular
  // no STATE is passed — its default is exactly what step 4 needs to observe.
  // ASSUMPTION: EXCEPTIONS OTHERS only, same discipline as
  // ./package-delete.ts / ./ddic-bridge.ts's subrcGuardFragment doc comment —
  // naming an exception not in the FM's real signature is a hard syntax
  // error caught at bridge activation; OTHERS always exists.
  const step2 = [
    '" Step 2: delete the view.',
    "CALL FUNCTION 'DDIF_VIEW_DELETE'",
    `  EXPORTING name = ${view}`,
    "  EXCEPTIONS OTHERS = 1.",
    ...subrcCheckFragment("DDIF_VIEW_DELETE", "VIEW-DELETED"),
  ];

  // No implicit commit on classrun return — ./view-create.ts records a live
  // false-success incident caused by exactly this omission.
  const step3 = ['" Step 3: commit.', "COMMIT WORK."];

  // Re-read for ANY remaining row, no AS4LOCAL/version filter: a default
  // STATE that deletes only the inactive version is the realistic
  // partial-delete failure this step catches.
  const step4 = [
    '" Step 4: re-read DD25L for any remaining row.',
    `SELECT COUNT( * ) FROM dd25l INTO @lv_dd25l_count WHERE viewname = ${view}.`,
    "IF lv_dd25l_count <> 0.",
    `  out->write( |ZMCP-DDIC-ERR> delete of ${viewName} reported no error but DD25L still has a row| ).`,
    "  RETURN.",
    "ENDIF.",
    "out->write( 'VIEW-GONE' ).",
  ];

  return [...step1, "", ...step2, "", ...step3, "", ...step4];
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * Delete one classic database view via the DDIC classrun bridge: validate,
 * gate the VIEW, generate, deploy, run, assert the transcript — the order
 * `./ddic-bridge.ts`'s header requires (validate first, then
 * {@link assertBridgeMutation} zero-network, only then generate ABAP).
 *
 * Gated as `op: "delete"` on the VIEW itself, not the default `write` — the
 * same `./package-delete.ts` precedent this module's header points to:
 * a delete must be audited as a delete.
 */
export async function deleteClassicViewViaBridge(
  conn: AbapConnection,
  gate: SafetyGate,
  params: ViewDeleteParams,
): Promise<{ run: RunResult; transcript: DdicTranscript }> {
  assertServerPackage(params.packageName, `view ${params.viewName}`);
  const { viewName } = validate(params);
  const packageName = params.packageName.name;

  // Gate on the domain object itself, zero-network — deployBridge's own gate
  // only judges the bridge class in $TMP, never this view.
  assertBridgeMutation(gate, { type: "VIEW/DV", name: viewName, packageName }, { activate: false, op: "delete" });

  const source = ddicBridgeSource(
    DDIC_BRIDGE_CLASS.deleteView,
    VIEW_DELETE_DATA_LINES,
    viewDeleteFragment({ viewName, packageName: params.packageName }),
  );

  // beforeAssert turns the "view does not exist" transcript into a clear
  // named error instead of the generic missing-tag CHECK_FAILED the plain
  // assertion would otherwise give — same shape as
  // ./package-delete.ts's beforeAssert.
  const beforeAssert = (transcript: DdicTranscript): void => {
    if (transcript.errorLine?.includes(`${viewName} does not exist`)) {
      throw new AbapError(
        "CHECK_FAILED",
        `View ${viewName} does not exist, so there is nothing to delete. Raw ABAP-side detail: ` +
          `${transcript.errorLine}`,
        { viewName, raw: transcript.raw },
      );
    }
  };

  return runDdicBridge(conn, gate, {
    className: DDIC_BRIDGE_CLASS.deleteView,
    source,
    description: `abapsmith delete-classic-view bridge (${viewName})`,
    what: `Deleting classic view ${viewName}`,
    expectTags: ["VIEW-DELETED", "VIEW-GONE"],
    beforeAssert,
  });
}
