/**
 * `VIEW/DV` (classic DDIC view) delete — over the fluid `classic` tool's
 * `delete_view` action, the route `./package-delete.ts` uses (via its own
 * action) for `CL_PACKAGE_FACTORY`. ADT REST is GET-only for `VIEW/DV`.
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
 * by this path. `abap-view.ts`'s `delete_view` method's last step names
 * the TR022 case instead of claiming nothing happened.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import { assertBridgeMutation } from "./bridge-mutation.js";
import type { DdicTranscript } from "./ddic-transcript.js";
import { runClassicAction } from "./classic-call.js";
import { assertEnhIdentifier } from "./enhancement-templates.js";
import { assertServerPackage, type ServerPackage } from "./resolved-package.js";

// ---------------------------------------------------------------------------
// Parameters and limits
// ---------------------------------------------------------------------------

export interface ViewDeleteParams {
  /** The view to delete, e.g. ZTM_V_CARRIER. */
  viewName: string;
  /** Server-resolved (`./resolved-package.ts`) — this module is zero-network and cannot verify it itself. */
  packageName: ServerPackage;
  /**
   * Forwarded to the fluid `delete_view` action's `confirm_maintenance_dialog` input
   * (`src/adt/fluid/builtin/classic.ts`). The ABAP (`abap-view.ts`) reads TVDIR and
   * refuses the delete when the view has a generated maintenance dialog, unless this
   * is `true`; omitted or `false` reads as `false` there, same as the guard's default.
   */
  confirmMaintenanceDialog?: boolean;
}

/** `DDOBJNAME`/`VIEWNAME` are CHAR30 — same ceiling `./view-create.ts` uses. */
const VIEW_NAME_MAX = 30;

/** The view name validated once, so the fragment can never see a raw one. */
function validate(p: ViewDeleteParams): { viewName: string } {
  const viewName = assertEnhIdentifier(p.viewName, "viewName", { maxLength: VIEW_NAME_MAX });
  return { viewName };
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * Delete one classic database view via the fluid `classic` tool's
 * `delete_view` action: validate, gate the VIEW, dispatch, assert the
 * transcript — validate first, then {@link assertBridgeMutation}
 * zero-network, only then {@link runClassicAction}.
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

  // Gate on the domain object itself, zero-network, before dispatching the
  // fluid action. `local`: the ABAP calls DD_OBJ_DEL and TR_TADIR_INTERFACE,
  // neither given a request, and issues no RS_CORR_INSERT — so this delete
  // registers nothing in CTS for the allowlist to judge.
  assertBridgeMutation(
    gate,
    { type: "VIEW/DV", name: viewName, packageName },
    { activate: false, op: "delete", corr: { kind: "local" } },
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

  return runClassicAction(conn, gate, {
    action: "delete_view",
    args: {
      view_name: viewName,
      package_name: packageName,
      ...(params.confirmMaintenanceDialog !== undefined
        ? { confirm_maintenance_dialog: params.confirmMaintenanceDialog }
        : {}),
    },
    what: `Deleting classic view ${viewName}`,
    expectTags: ["VIEW-DELETED", "VIEW-GONE"],
    beforeAssert,
  });
}
