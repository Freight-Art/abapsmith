/**
 * Remove one E071 entry (and its CTS lock) from an unreleased transport
 * request/task.
 *
 * ADT exposes a per-entry `removeobject` link on a transport's object list,
 * but its verb and body are UNKNOWN and are NOT guessed here. Instead this
 * reaches CTS's own backend the way `./tran-delete.ts` / `./view-delete.ts`
 * reach theirs: the fluid `classic` tool's `remove_transport_entry` action
 * (body class `ZCL_ZMCP_FLUID_CLASSIC`), calling `TRINT_READ_REQUEST` to find
 * the row and `TR_DELETE_COMM_OBJECT_KEYS` to remove it. A request can hold
 * two or more E071 rows for the same PGMID+OBJECT+OBJ_NAME (E071's key is
 * TRKORR+AS4POS, not object identity, so this is legal — SAP's own DDIC
 * delete recording can append such a row). The bridge collapses these to one
 * row (keeping the lowest AS4POS) before calling `TR_DELETE_COMM_OBJECT_KEYS`,
 * so removal succeeds instead of hitting its `w_duplicate_entry` guard.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import type { DdicTranscript } from "./ddic-transcript.js";
import { runClassicAction } from "./classic-call.js";
import { assertEnhIdentifier } from "./enhancement-templates.js";
import { assertTrkorr, type TransportCeilingProof } from "./transports.js";

/** One E071 row the ABAP reports having ALREADY deleted — see `transportPart` (src/adt/fluid/builtin/classic/abap-transport.ts) step 5. */
const TREN_ROW_RE = /^ZMCP-TREN-ROW (\S+) (\S+) (\S+)/;

/** One group of duplicate E071 rows the ABAP collapsed to one — see `transportPart` step 4. */
const TREN_DEDUP_RE = /^ZMCP-TREN-DEDUP (\S+) (\S+) (\S+) (\d+) AS4POS (\S+)$/;

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
  /** Duplicate-E071-row groups the ABAP collapsed to one row before removing the entry. */
  collapsed: { pgmid: string; object: string; name: string; rows: number; positions: string[] }[];
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

  // Mirrors tran-delete.ts's beforeAssert: turn known error lines into named refusals
  // rather than the generic missing-tag CHECK_FAILED.
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
        "The bridge now collapses duplicate E071 rows before removing the entry, so it should " +
          "no longer emit this line — seeing it means an older bridge body is still deployed. " +
          "Redeploy the fluid classic tool and retry.",
      );
    }
    if (
      transcript.errorLine?.startsWith("TR_DELETE_COMM_OBJECT_KEYS failed") &&
      transcript.errorLine.includes(" TR 292")
    ) {
      throw new AbapError(
        "CTS_DUPLICATE_ENTRY",
        `CTS refused to remove ${objectName} from ${trkorr}: TR_DELETE_COMM_OBJECT_KEYS still raised ` +
          `TR 292 after the bridge's collapse — nothing further was removed. ` +
          `Raw ABAP-side detail: ${transcript.errorLine}`,
        { trkorr, objectName, raw: transcript.raw },
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
  const collapsed: TransportEntryRemoveResult["collapsed"] = [];
  for (const line of transcript.raw.split("\n")) {
    const trimmed = line.trim();
    const holderMatch = trimmed.match(/^ZMCP-TREN-HOLDER (\S+)/);
    if (holderMatch) {
      holder = holderMatch[1]!;
      continue;
    }
    const rowMatch = trimmed.match(TREN_ROW_RE);
    if (rowMatch) {
      removed.push({ pgmid: rowMatch[1]!, object: rowMatch[2]!, name: rowMatch[3]! });
      continue;
    }
    const dedupMatch = trimmed.match(TREN_DEDUP_RE);
    if (dedupMatch) {
      collapsed.push({
        pgmid: dedupMatch[1]!,
        object: dedupMatch[2]!,
        name: dedupMatch[3]!,
        rows: Number(dedupMatch[4]),
        positions: dedupMatch[5]!.split(","),
      });
    }
  }

  return { run, transcript, holder, removed, collapsed };
}

/**
 * Does `e` carry POSITIVE evidence that CTS removed nothing at all?
 *
 * This decides whether a caller may record a DEFINITE `failed` journal
 * verdict for a clean refusal, instead of leaving the entry `pending` (which
 * `abap_journal mode=list` then flags STRANDED — telling the operator nobody
 * knows whether the write landed, which is false when nothing did). Getting
 * this wrong in the "nothing happened" direction is the worse mistake, so it
 * is shaped to require proof, not to default to it:
 *
 *  - Not an `AbapError`, or its `details.raw` is missing/not a string: no
 *    transcript to read at all. This is exactly the shape of a dropped
 *    connection — the ABAP may have run and answered into thin air. "No
 *    evidence" must never be read as "nothing happened".
 *  - `raw` names at least one removed row (`TREN_ROW_RE` matches a line) or
 *    at least one collapsed duplicate-row group (`TREN_DEDUP_RE` matches a
 *    line, meaning surplus E071 rows were already deleted): CTS WAS touched
 *    even though the operation then failed later in the loop — also
 *    unproven, not a clean refusal.
 *  - Otherwise — an `AbapError` with a transcript that names no removed
 *    row and no collapsed group — is the one case that is actually proven
 *    clean: CTS refused before removing anything (e.g. `CTS_DUPLICATE_ENTRY`,
 *    `NOT_FOUND`).
 */
export function removalTouchedNothing(e: unknown): boolean {
  if (!(e instanceof AbapError)) return false;
  const raw = e.details.raw;
  if (typeof raw !== "string") return false;
  return !raw
    .split("\n")
    .some((line) => TREN_ROW_RE.test(line.trim()) || TREN_DEDUP_RE.test(line.trim()));
}
