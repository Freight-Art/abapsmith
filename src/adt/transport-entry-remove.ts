/**
 * Remove one E071 entry (and its CTS lock) from an unreleased transport
 * request/task.
 *
 * ADT exposes a per-entry `removeobject` link on a transport's object list,
 * but its verb and body are UNKNOWN and are NOT guessed here. Instead this
 * reaches CTS's own backend the way `./tran-delete.ts` / `./view-delete.ts`
 * reach theirs: the fluid `classic` tool's `remove_transport_entry` action
 * (body class `ZCL_ZMCP_FLUID_CLASSIC`), calling `TRINT_READ_REQUEST` to find
 * the row and `TR_DELETE_COMM_OBJECT_KEYS` to remove it. This route clears an
 * entry whose request holds exactly one E071 row for it. A live run on
 * 2026-09-05 found that CTS refuses the removal when the request's object
 * list holds two or more E071 rows for the same PGMID+OBJECT+OBJ_NAME
 * (E071's key is TRKORR+AS4POS, not object identity, so duplicates are
 * legal); the bridge now detects that up front.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import type { DdicTranscript } from "./ddic-transcript.js";
import { runClassicAction } from "./classic-call.js";
import { assertEnhIdentifier } from "./enhancement-templates.js";
import { assertTrkorr, type TransportCeilingProof } from "./transports.js";

export interface TransportEntryRemoveParams {
  /** The request or task believed to hold the entry; the ABAP falls back to its tasks. */
  trkorr: string;
  /** Object name of the entry, e.g. ZTMD_I26_P1. Every E071 row with this OBJ_NAME is removed. */
  objectName: string;
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
 * Remove one E071 entry via the fluid `classic` tool.
 *
 * No `assertBridgeMutation` call: this removes a CTS bookkeeping row, not an
 * ABAP object, and there is no object/package left to authorize against —
 * the object named is typically already deleted. `proof` is the tool layer's
 * admin-only transport-delete ceiling check, and is this operation's only
 * gate (declared `targets` are deliberately absent — see `S3-REROUTE.md`).
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

  // Mirrors tran-delete.ts's beforeAssert: turn the known "no entry for" line into a
  // named refusal rather than the generic missing-tag CHECK_FAILED.
  const beforeAssert = (transcript: DdicTranscript): void => {
    if (transcript.errorLine?.startsWith("duplicate E071 entries for")) {
      const m =
        /^duplicate E071 entries for (\S+) (\S+) (\S+) on (\S+): (\d+) rows at AS4POS (\S+)$/.exec(
          transcript.errorLine,
        );
      if (!m) {
        throw new AbapError(
          "CTS_DUPLICATE_ENTRY",
          `CTS refused to remove ${objectName} from ${trkorr}: duplicate E071 entries — nothing was removed. ` +
            `Raw ABAP-side detail: ${transcript.errorLine}`,
          { trkorr, objectName, raw: transcript.raw },
        );
      }
      const pgmid = m[1]!;
      const object = m[2]!;
      const objName = m[3]!;
      const holder = m[4]!;
      const count = Number(m[5]);
      const positions = m[6]!.split(",");
      throw new AbapError(
        "CTS_DUPLICATE_ENTRY",
        `CTS refused to remove ${objName} from ${holder}: ${count} E071 rows share ` +
          `${pgmid} ${object} ${objName} (AS4POS ${positions.join(", ")}) — nothing was removed. ` +
          `Raw ABAP-side detail: ${transcript.errorLine}`,
        { trkorr, objectName, holder, pgmid, object, count, positions, raw: transcript.raw },
        "TRINT_DELETE_COMM_OBJECT_KEYS counts the request's E071 rows matching PGMID+OBJECT+OBJ_NAME " +
          "and raises w_duplicate_entry (message TR 292) at two or more; TR_DELETE_COMM_OBJECT_KEYS has " +
          "no parameter naming which AS4POS to drop, and the guard has no bypass. E071's key is " +
          "TRKORR+AS4POS, so the duplicate rows are legal — abapsmith cannot say what produced " +
          "them here. SE03's \"Unlock Objects (Expert Tool)\" does " +
          "NOT fix this on its own — the refusal counts E071 rows, not locks. The remedy is outside " +
          "abapsmith: edit the request's object list in SE09/SE10 so at most one row remains for the " +
          "object, then retry removeObject; or release the request, which is irreversible.",
      );
    }
    if (transcript.errorLine?.startsWith("no entry for")) {
      throw new AbapError(
        "NOT_FOUND",
        `No entry for ${objectName} on ${trkorr} or its tasks — nothing was removed. ` +
          `Raw ABAP-side detail: ${transcript.errorLine}`,
        { trkorr, objectName, raw: transcript.raw },
      );
    }
  };

  const { run, transcript } = await runClassicAction(conn, gate, {
    action: "remove_transport_entry",
    args: { trkorr, object_name: objectName },
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
