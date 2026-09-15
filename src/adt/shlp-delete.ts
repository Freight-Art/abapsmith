/**
 * `SHLP/DH` (search help) delete — over the fluid `classic` tool's
 * `delete_search_help` action, the same route `view-delete.ts` uses for
 * `VIEW/DV`. ADT REST 404s on every verb for the search-help collection on
 * this release — see `capabilities.ts`'s `SHLP/DH` entry.
 *
 * Proven live on A4H (NetWeaver 7.54, client 001) 2026-09-12, in `$TMP`
 * only: `DD_OBJ_DEL` with `object_type = 'SHLP'` and `del_state = 'A'`
 * returned `sy-subrc = 0` with message DH051, clearing the active version;
 * a second call with `del_state = 'N'` clears any inactive one (not
 * `sy-subrc`-checked — no inactive version is normal, same discipline as
 * `view-delete.ts`). `TR_TADIR_INTERFACE` then removes the TADIR row, same
 * shape and same `wi_test_modus = space` requirement as the view delete —
 * see that module's header for what an open transport-request lock does to
 * this step (TR022), which this module does not handle either.
 *
 * The where-used guard (`confirm_in_use`) is new for this issue: a search
 * help can be attached to a data element (DD04L), to an individual
 * table/view field (DD35L), or included by a collective search help
 * (DD31S) — all three checked live on A4H 2026-09-12 (see `abap-shlp.ts`'s
 * `delete_search_help` method).
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

export interface SearchHelpDeleteParams {
  /** The search help to delete, e.g. ZTM_SH_CARRIER. */
  shlpName: string;
  /** Server-resolved (`./resolved-package.ts`) — this module is zero-network and cannot verify it itself. */
  packageName: ServerPackage;
  /**
   * Required (true) when the search help is still attached to a data
   * element, a table/view field, or included by a collective search help —
   * see `abap-shlp.ts`'s where-used guard.
   */
  confirmInUse?: boolean;
}

/** `DD30L-SHLPNAME` is CHAR30 — same ceiling `./shlp-create.ts` uses. */
const SHLP_NAME_MAX = 30;

/** The search help name validated once, so the fragment can never see a raw one. */
function validate(p: SearchHelpDeleteParams): { shlpName: string } {
  const shlpName = assertEnhIdentifier(p.shlpName, "shlpName", { maxLength: SHLP_NAME_MAX });
  return { shlpName };
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * Delete one search help via the fluid `classic` tool's `delete_search_help`
 * action: validate, gate the SHLP, dispatch, assert the transcript —
 * validate first, then {@link assertBridgeMutation} zero-network, only then
 * {@link runClassicAction}. Gated as `op: "delete"`, not the default
 * `write` — a delete must be audited as a delete.
 */
export async function deleteSearchHelpViaBridge(
  conn: AbapConnection,
  gate: SafetyGate,
  params: SearchHelpDeleteParams,
): Promise<{ run: RunResult; transcript: DdicTranscript }> {
  assertServerPackage(params.packageName, `search help ${params.shlpName}`);
  const { shlpName } = validate(params);
  const packageName = params.packageName.name;

  // Gate on the domain object itself, zero-network, before dispatching the
  // fluid action. `local`: DD_OBJ_DEL and TR_TADIR_INTERFACE are given no
  // request and RS_CORR_INSERT is never called — this delete registers
  // nothing in CTS for the allowlist to judge.
  assertBridgeMutation(
    gate,
    { type: "SHLP/DH", name: shlpName, packageName },
    { activate: false, op: "delete", corr: { kind: "local" } },
  );

  // beforeAssert turns the "search help does not exist" transcript into a
  // clear named error instead of the generic missing-tag CHECK_FAILED the
  // plain assertion would otherwise give — same shape as
  // view-delete.ts's beforeAssert.
  const beforeAssert = (transcript: DdicTranscript): void => {
    if (transcript.errorLine?.includes(`${shlpName} does not exist`)) {
      throw new AbapError(
        "CHECK_FAILED",
        `Search help ${shlpName} does not exist, so there is nothing to delete. Raw ABAP-side detail: ` +
          `${transcript.errorLine}`,
        { shlpName, raw: transcript.raw },
      );
    }
  };

  return runClassicAction(conn, gate, {
    action: "delete_search_help",
    args: {
      shlp_name: shlpName,
      package_name: packageName,
      ...(params.confirmInUse !== undefined ? { confirm_in_use: params.confirmInUse } : {}),
    },
    what: `Deleting search help ${shlpName}`,
    expectTags: ["SHLP-DELETED", "SHLP-GONE"],
    beforeAssert,
  });
}
