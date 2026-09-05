/**
 * `VIEW/DV` (classic DDIC view) delete — over the DDIC classrun bridge
 * (`IF_OO_ADT_CLASSRUN` in `$TMP`; ADT REST is GET-only for `VIEW/DV`), the
 * route `./package-delete.ts` uses for `CL_PACKAGE_FACTORY`.
 *
 * Live-measured on A4H, 2026-09-04, superseding an unverified route:
 * `DDIF_VIEW_DELETE` does NOT exist here (CHECK_FAILED, function not
 * found). What works: `DD_OBJ_DEL(object_type='VIEW', del_state='A')`
 * clears the active version (sy-subrc=0, MC691 residue); a second call
 * with `del_state='N'` clears any inactive one — `'L'`, matching the
 * table's own state column, fails where `'N'` succeeds, and no inactive
 * version is normal, so that call is deliberately NOT subrc-checked.
 * `RS_DD_DELETE_OBJ`, the obvious alternative, MUST NOT be used: it opens
 * a CTS dialog and short-dumps headless.
 *
 * `DD_OBJ_DEL` never touches TADIR; `TR_TADIR_INTERFACE` does, but only
 * with `wi_test_modus = space` — it defaults to `'X'` and silently no-ops
 * if omitted. Under an open transport-request lock, that TADIR delete
 * fails `sy-subrc=1` / `TR022`; clearing the lock
 * (`TRINT_READ_REQUEST`/`TR_DELETE_COMM_OBJECT_KEYS`/`COMMIT WORK`) is a
 * transport mechanism, deliberately NOT implemented here. NO TRANSPORT
 * HANDLING either way: `abapDeleteViaBridge` (`src/tools/write.ts`)
 * refuses any `corr_nr` outright, so a locked view can't be fully removed
 * by this path. {@link viewDeleteFragment}'s last step names the TR022
 * case instead of claiming nothing happened.
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
  "lv_tadir_count TYPE i.",
];

/**
 * The closed ABAP fragment that deletes one classic database view. Exported
 * for the generator/parser drift test — every `out->write( 'TAG' )` it emits
 * must be a tag `parseDdicTranscript` recognises.
 *
 * Six steps, labelled inline below: exists check, active-version delete
 * (subrc-guarded), inactive-version delete (deliberately not guarded — see
 * module header), TADIR removal, commit, then re-read BOTH DD25L and TADIR
 * before the `VIEW-GONE` tag — a clean FM return is never trusted alone.
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

  // Step 2: delete the active version. DD_OBJ_DEL, not DDIF_VIEW_DELETE —
  // the latter does not exist on A4H (measured). RS_DD_DELETE_OBJ, the
  // obvious alternative, must NOT be used: it pops a CTS dialog and
  // short-dumps headless.
  const step2 = [
    '" Step 2: delete the active version.',
    "CALL FUNCTION 'DD_OBJ_DEL'",
    "  EXPORTING",
    `    object_name = ${view}`,
    "    object_type = 'VIEW'",
    "    del_state   = 'A'",
    "    prid        = -1",
    "  EXCEPTIONS",
    "    OTHERS      = 1.",
    ...subrcCheckFragment("DD_OBJ_DEL", "VIEW-DELETED"),
  ];

  // Step 3: delete any inactive version. Deliberately NOT subrc-checked —
  // no inactive version is the normal case, and (measured) 'L' fails here
  // where 'N' succeeds on the same rows.
  const step3 = [
    '" Step 3: delete any inactive version (no inactive row is normal).',
    "CALL FUNCTION 'DD_OBJ_DEL'",
    "  EXPORTING",
    `    object_name = ${view}`,
    "    object_type = 'VIEW'",
    "    del_state   = 'N'",
    "    prid        = -1",
    "  EXCEPTIONS",
    "    OTHERS      = 1.",
  ];

  // Step 4: remove the TADIR row. wi_test_modus defaults to 'X' (test
  // mode) — omitting it is a silent no-op that still reports success, so
  // it is passed explicitly. Not subrc-checked here; step 6 proves the
  // outcome by re-reading TADIR instead.
  const step4 = [
    '" Step 4: remove the TADIR row (wi_test_modus = space, or this no-ops).',
    "CALL FUNCTION 'TR_TADIR_INTERFACE'",
    "  EXPORTING",
    "    wi_test_modus         = space",
    "    wi_tadir_pgmid        = 'R3TR'",
    "    wi_tadir_object       = 'VIEW'",
    `    wi_tadir_obj_name     = ${view}`,
    "    wi_delete_tadir_entry = 'X'",
    "  EXCEPTIONS",
    "    OTHERS                = 1.",
  ];

  // No implicit commit on classrun return — ./view-create.ts records a live
  // false-success incident caused by exactly this omission.
  const step5 = ['" Step 5: commit.', "COMMIT WORK."];

  // Step 6: re-read both DD25L and TADIR — neither call above is trusted
  // alone. A surviving TADIR row with DD25L already clear is reported by
  // name (most likely cause: an object lock from an open transport
  // request, TR022) rather than as "nothing was deleted".
  const step6 = [
    '" Step 6: re-read DD25L, then TADIR, before declaring the view gone.',
    `SELECT COUNT( * ) FROM dd25l INTO @lv_dd25l_count WHERE viewname = ${view}.`,
    "IF lv_dd25l_count <> 0.",
    `  out->write( |ZMCP-DDIC-ERR> delete of ${viewName} reported no error but DD25L still has a row| ).`,
    "  RETURN.",
    "ENDIF.",
    "SELECT COUNT( * ) FROM tadir INTO @lv_tadir_count " +
      `WHERE pgmid = 'R3TR' AND object = 'VIEW' AND obj_name = ${view}.`,
    "IF lv_tadir_count <> 0.",
    `  out->write( |ZMCP-DDIC-ERR> ${viewName}'s DD25L rows are gone but its TADIR row remains; ` +
      "the DD25L delete worked; likely cause is an object lock from an open transport request " +
      "(TR022)| ).",
    "  RETURN.",
    "ENDIF.",
    "out->write( 'VIEW-GONE' ).",
  ];

  return [...step1, "", ...step2, "", ...step3, "", ...step4, "", ...step5, "", ...step6];
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
  // `local`: the fragment calls DD_OBJ_DEL and TR_TADIR_INTERFACE, neither
  // given a request, and issues no RS_CORR_INSERT — so this delete
  // registers nothing in CTS for the allowlist to judge.
  assertBridgeMutation(
    gate,
    { type: "VIEW/DV", name: viewName, packageName },
    { activate: false, op: "delete", corr: { kind: "local" } },
  );

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
