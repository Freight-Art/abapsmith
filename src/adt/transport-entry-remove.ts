/**
 * Remove one E071 entry (and its CTS lock) from an unreleased transport
 * request/task.
 *
 * ADT exposes a per-entry `removeobject` link on a transport's object list,
 * but its verb and body are UNKNOWN and are NOT guessed here. Instead this
 * reaches CTS's own backend the way `./tran-delete.ts` / `./view-delete.ts`
 * reach theirs: a generated `IF_OO_ADT_CLASSRUN` class deployed to `$TMP`,
 * calling `TRINT_READ_REQUEST` to find the row and `TR_DELETE_COMM_OBJECT_KEYS`
 * to remove it. This route clears a `R3TR CLAS` deletion entry. A live run on
 * a live A4H appliance on 2026-09-05 found that for a `R3TR TABL` deletion
 * entry, `TR_DELETE_COMM_OBJECT_KEYS` returns a non-zero `sy-subrc`, leaving
 * the entry and its lock in place.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import { DDIC_BRIDGE_CLASS, ddicBridgeSource, runDdicBridge, type DdicTranscript } from "./ddic-bridge.js";
import { abapLiteral, assertEnhIdentifier } from "./enhancement-templates.js";
import { assertTrkorr, type TransportCeilingProof } from "./transports.js";

export interface TransportEntryRemoveParams {
  /** The request or task believed to hold the entry; the ABAP falls back to its tasks. */
  trkorr: string;
  /** Object name of the entry, e.g. ZTMD_I26_P1. Every E071 row with this OBJ_NAME is removed. */
  objectName: string;
}

/**
 * Bare `DATA` declarations for `ddicBridgeSource` (no leading `DATA` keyword).
 */
export const TRANSPORT_ENTRY_REMOVE_DATA_LINES: readonly string[] = [
  "ls_req TYPE trwbo_request.",
  "ls_e071 TYPE e071.",
  "lt_rows TYPE STANDARD TABLE OF e071 WITH EMPTY KEY.",
  "lt_candidates TYPE STANDARD TABLE OF trkorr WITH EMPTY KEY.",
  "lt_tasks TYPE STANDARD TABLE OF trkorr WITH EMPTY KEY.",
  "lv_trkorr TYPE trkorr.",
  "lv_holder TYPE trkorr.",
  "lv_check TYPE trkorr.",
  "lv_subrc TYPE sy-subrc.",
  "ls_msg TYPE symsg.",
  "lv_msgtext TYPE string.",
  "lv_readerr TYPE string.",
];

/**
 * The closed ABAP fragment. Exported for the generator/parser drift test —
 * re-validates both params since it is callable standalone.
 *
 * Seven steps: resolve the holder (trying the passed trkorr, then its
 * tasks), refuse honestly if none carries the entry, name the resolved
 * holder, remove every matching row, tag success once for the whole batch,
 * commit, then prove E071 absence.
 */
export function transportEntryRemoveFragment(p: TransportEntryRemoveParams): string[] {
  const trkorr = assertTrkorr(p.trkorr, "transportEntryRemove");
  const objectName = assertEnhIdentifier(p.objectName, "object", {
    maxLength: 40,
    allowNamespace: true,
  }).toUpperCase();
  const trkorrLit = abapLiteral(trkorr);
  const nameLit = abapLiteral(objectName);

  // Step 1: candidates are the passed number, then its tasks (entries usually live on a
  // task, not the request the caller names) — first candidate whose own object list
  // carries the entry wins.
  const step1 = [
    '" Step 1: resolve which of trkorr or its tasks holds the entry.',
    `lv_trkorr = ${trkorrLit}.`,
    "APPEND lv_trkorr TO lt_candidates.",
    `SELECT trkorr FROM e070 INTO TABLE lt_tasks WHERE strkorr = ${trkorrLit}.`,
    "APPEND LINES OF lt_tasks TO lt_candidates.",
    "CLEAR lv_holder.",
    "LOOP AT lt_candidates INTO lv_trkorr.",
    "  CLEAR ls_req.",
    "  ls_req-h-trkorr = lv_trkorr.",
    "  CALL FUNCTION 'TRINT_READ_REQUEST'",
    "    EXPORTING iv_read_e070 = 'X' iv_read_e07t = 'X' iv_read_e070c = 'X' iv_read_e070m = 'X'",
    "              iv_read_objs_keys = 'X' iv_read_attributes = 'X'",
    "    CHANGING  cs_request = ls_req",
    "    EXCEPTIONS OTHERS = 1.",
    "  lv_subrc = sy-subrc.",
    "  MOVE-CORRESPONDING sy TO ls_msg.",
    "  IF lv_subrc <> 0.",
    "    lv_readerr = |{ lv_trkorr } sy-subrc={ lv_subrc } msg={ ls_msg-msgty }{ ls_msg-msgid }{ ls_msg-msgno } " +
      "v1={ ls_msg-msgv1 } v2={ ls_msg-msgv2 } v3={ ls_msg-msgv3 } v4={ ls_msg-msgv4 }|.",
    "    CONTINUE.",
    "  ENDIF.",
    "  CLEAR lt_rows.",
    `  LOOP AT ls_req-objects INTO ls_e071 WHERE obj_name = ${nameLit}.`,
    "    APPEND ls_e071 TO lt_rows.",
    "  ENDLOOP.",
    "  IF lines( lt_rows ) > 0.",
    "    lv_holder = lv_trkorr.",
    "    EXIT.",
    "  ENDIF.",
    "ENDLOOP.",
  ];

  // Step 2: a refusal with nothing removed, not a silent success.
  const step2 = [
    '" Step 2: refuse if no candidate carried the entry.',
    "IF lv_holder IS INITIAL.",
    "  IF lv_readerr IS INITIAL.",
    `    out->write( |ZMCP-DDIC-ERR> no entry for ${objectName} on ${trkorr} or its tasks| ).`,
    "  ELSE.",
    `    out->write( |ZMCP-DDIC-ERR> no entry for ${objectName} on ${trkorr} or its tasks; ` +
      "last TRINT_READ_REQUEST failure: { lv_readerr }| ).",
    "  ENDIF.",
    "  RETURN.",
    "ENDIF.",
  ];

  // Step 3: the resolved holder may be a task of the number the caller passed.
  const step3 = ['" Step 3: name the resolved holder.', "out->write( |ZMCP-TREN-HOLDER { lv_holder }| )."];

  // Step 4: is_e071_delete and cs_request are both mandatory — passing is_e071_delete alone
  // short-dumps on the missing CS_REQUEST. Tag is emitted once after the loop, not per row,
  // so subrcCheckFragment isn't used here.
  const step4 = [
    '" Step 4: remove every collected row.',
    "LOOP AT lt_rows INTO ls_e071.",
    "  CALL FUNCTION 'TR_DELETE_COMM_OBJECT_KEYS'",
    "    EXPORTING iv_dialog_flag = space is_e071_delete = ls_e071",
    "    CHANGING cs_request = ls_req",
    "    EXCEPTIONS OTHERS = 1.",
    "  lv_subrc = sy-subrc.",
    "  MOVE-CORRESPONDING sy TO ls_msg.",
    "  IF lv_subrc <> 0.",
    // Classic EXCEPTIONS, not cx_root: OTHERS is used because the real signature can't be
    // verified offline. sy-msg* is best-effort — a bare RAISE leaves it blank, so a blank
    // msg= here proves nothing either way.
    "    lv_msgtext = |{ ls_msg-msgty }{ ls_msg-msgid }{ ls_msg-msgno } v1={ ls_msg-msgv1 } " +
      "v2={ ls_msg-msgv2 } v3={ ls_msg-msgv3 } v4={ ls_msg-msgv4 }|.",
    "    out->write( |ZMCP-DDIC-ERR> TR_DELETE_COMM_OBJECT_KEYS failed for { ls_e071-pgmid } " +
      "{ ls_e071-object } { ls_e071-obj_name }, sy-subrc={ lv_subrc }, msg={ lv_msgtext }| ).",
    "    RETURN.",
    "  ENDIF.",
    "  out->write( |ZMCP-TREN-ROW { ls_e071-pgmid } { ls_e071-object } { ls_e071-obj_name }| ).",
    "ENDLOOP.",
  ];

  const step5 = ['" Step 5: one success tag for the whole batch.', "out->write( 'TREN-REMOVED' )."];

  // Step 6: a classrun return does not commit, and step 7 must read committed state.
  const step6 = ['" Step 6: commit.', "COMMIT WORK AND WAIT."];

  // Step 7: proves only that the E071 row is gone.
  const step7 = [
    '" Step 7: prove absence.',
    `SELECT SINGLE trkorr FROM e071 INTO @lv_check WHERE trkorr = @lv_holder AND obj_name = ${nameLit}.`,
    "IF sy-subrc = 0.",
    `  out->write( |ZMCP-DDIC-ERR> removal of ${objectName} reported no error but a row is still there| ).`,
    "  RETURN.",
    "ENDIF.",
    "out->write( 'TREN-GONE' ).",
  ];

  return [...step1, "", ...step2, "", ...step3, "", ...step4, "", ...step5, "", ...step6, "", ...step7];
}

export interface TransportEntryRemoveResult {
  run: RunResult;
  transcript: DdicTranscript;
  /** The request/task the ABAP actually found the rows on (may be a task of `params.trkorr`). */
  holder: string;
  /** The rows the ABAP reported removing. */
  removed: { pgmid: string; object: string; name: string }[];
}

/**
 * Remove one E071 entry via the DDIC classrun bridge.
 *
 * No `assertBridgeMutation` call: this removes a CTS bookkeeping row, not an
 * ABAP object, and there is no object/package left to authorize against —
 * the object named is typically already deleted. `deployBridge`/`executeBridge`
 * inside `runDdicBridge` still gate the `$TMP` bridge class itself; `proof`
 * is the tool layer's admin-only transport-delete ceiling check.
 */
export async function removeTransportEntryViaBridge(
  conn: AbapConnection,
  gate: SafetyGate,
  params: TransportEntryRemoveParams,
  proof: TransportCeilingProof,
): Promise<TransportEntryRemoveResult> {
  void proof;

  const trkorr = assertTrkorr(params.trkorr, "removeTransportEntry");
  const objectName = assertEnhIdentifier(params.objectName, "object", {
    maxLength: 40,
    allowNamespace: true,
  }).toUpperCase();

  const source = ddicBridgeSource(
    DDIC_BRIDGE_CLASS.removeTransportEntry,
    TRANSPORT_ENTRY_REMOVE_DATA_LINES,
    transportEntryRemoveFragment({ trkorr, objectName }),
  );

  // Mirrors tran-delete.ts's beforeAssert: turn the known "no entry for" line into a
  // named refusal rather than the generic missing-tag CHECK_FAILED.
  const beforeAssert = (transcript: DdicTranscript): void => {
    if (transcript.errorLine?.startsWith("no entry for")) {
      throw new AbapError(
        "NOT_FOUND",
        `No entry for ${objectName} on ${trkorr} or its tasks — nothing was removed. ` +
          `Raw ABAP-side detail: ${transcript.errorLine}`,
        { trkorr, objectName, raw: transcript.raw },
      );
    }
  };

  const { run, transcript } = await runDdicBridge(conn, gate, {
    className: DDIC_BRIDGE_CLASS.removeTransportEntry,
    source,
    description: `abapsmith remove-transport-entry bridge (${objectName})`,
    what: `Removing ${objectName} from ${trkorr}`,
    expectTags: ["TREN-REMOVED", "TREN-GONE"],
    beforeAssert,
  });

  let holder = trkorr;
  const removed: { pgmid: string; object: string; name: string }[] = [];
  for (const line of transcript.raw.split("\n")) {
    const trimmed = line.trim();
    const holderMatch = trimmed.match(/^ZMCP-TREN-HOLDER (\S+)/);
    if (holderMatch) {
      holder = holderMatch[1]!;
      continue;
    }
    const rowMatch = trimmed.match(/^ZMCP-TREN-ROW (\S+) (\S+) (\S+)/);
    if (rowMatch) removed.push({ pgmid: rowMatch[1]!, object: rowMatch[2]!, name: rowMatch[3]! });
  }

  return { run, transcript, holder, removed };
}
