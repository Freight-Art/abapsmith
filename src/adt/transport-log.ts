/**
 * Read a transport request's import log — the per-target-system overview
 * (`TRINT_GET_LOG_OVERVIEW`) plus each target's log file lines
 * (`TRINT_GET_LOG_FILE`).
 *
 * ADT has no documented read for this. The classic RFC-enabled function
 * modules behind SE01/SE09/SE10's log viewer are reached instead, through
 * the same fluid `classic` tool bridge (body class `ZCL_ZMCP_FLUID_CLASSIC`)
 * `./transport-entry-remove.ts` uses — see `read_transport_log` in
 * `./fluid/builtin/classic/abap-transport.ts` for the ABAP.
 *
 * Critical fact, live-verified on A4H client 001, 2026-09-15:
 * `TRINT_GET_LOG_OVERVIEW` answers with `sy-subrc = 0` even for a request
 * number that does NOT exist at all — tried live with `A4HK999999`, which
 * came back with the SAME "not yet imported" row a real, un-imported
 * request gets. A caller trusting that FM's own return code alone would
 * silently accept a typo'd request number and report a confident but
 * meaningless answer. The ABAP therefore checks `E070` for the request
 * FIRST and refuses (`NOT_FOUND`) before calling the FM at all.
 *
 * Also live-verified: `TRINT_GET_LOG_FILE` returned `sy-subrc = 0` and ZERO
 * rows for every request tried on this box — `tp` never wrote a log file
 * here. An empty `lines` array per system is therefore the normal answer
 * for a request that hasn't been exported yet, not a bug.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import type { DdicTranscript } from "./ddic-transcript.js";
import { runClassicAction } from "./classic-call.js";
import { assertTrkorr } from "./transports.js";

/** `ZMCP-TRLG-REQ {trkorr} {trfunction} {trstatus}` — step 2 of `read_transport_log`. */
const TRLG_REQ_RE = /^ZMCP-TRLG-REQ (\S+) (\S+) (\S+)/;
/** `ZMCP-TRLG-SYS {idx} {sysnam} {rc} {moddate} {modtime} {sortidx}` — step 3. */
const TRLG_SYS_RE = /^ZMCP-TRLG-SYS (\d+) (\S+) (\S+) (\S+) (\S+) (\S+)/;
/** `ZMCP-TRLG-SYSTXT {idx} {text...}` — free text, so only the leading index is captured strictly. */
const TRLG_SYSTXT_RE = /^ZMCP-TRLG-SYSTXT (\d+) ?(.*)$/;
/** `ZMCP-TRLG-RCTXT {idx} {text...}` */
const TRLG_RCTXT_RE = /^ZMCP-TRLG-RCTXT (\d+) ?(.*)$/;
/** `ZMCP-TRLG-LINE {idx} {severity} {class} {number} {text...}` — "-" stands in for an initial SEVERITY/CLASS/NUMBER. */
const TRLG_LINE_RE = /^ZMCP-TRLG-LINE (\d+) (\S+) (\S+) (\S+) ?(.*)$/;

export interface TrLogLine {
  severity: string;
  msgClass: string;
  msgNumber: string;
  text: string;
}

export interface TrLogSystem {
  system: string;
  systemText: string;
  rc: string;
  rcText: string;
  date: string;
  time: string;
  sortIndex: number;
  lines: TrLogLine[];
}

export interface TransportLogResult {
  run: RunResult;
  transcript: DdicTranscript;
  trkorr: string;
  trFunction: string;
  trStatus: string;
  systems: TrLogSystem[];
}

export interface TransportLogParams {
  trkorr: string;
}

/** Turns a "-" placeholder (emitted by the ABAP for an initial space-free field) back into "". */
function unplaceholder(value: string): string {
  return value === "-" ? "" : value;
}

/**
 * Read a transport request's import log via the fluid `classic` tool.
 *
 * Read-only: no `assertBridgeMutation`/`AuthorizedTarget` call — there is no
 * object or package to authorize a read against.
 */
export async function readTransportLogViaBridge(
  conn: AbapConnection,
  gate: SafetyGate,
  params: TransportLogParams,
): Promise<TransportLogResult> {
  const trkorr = assertTrkorr(params.trkorr, "readTransportLog");

  const beforeAssert = (transcript: DdicTranscript): void => {
    if (transcript.errorLine?.startsWith("no such request")) {
      throw new AbapError(
        "NOT_FOUND",
        `No such transport request ${trkorr}. Raw ABAP-side detail: ${transcript.errorLine}`,
        { trkorr, raw: transcript.raw },
        "TRINT_GET_LOG_OVERVIEW answers with sy-subrc 0 even for a request number that does not " +
          "exist at all, so abapsmith checks E070 first and refuses here rather than reporting a " +
          "plausible-looking but meaningless log.",
      );
    }
  };

  const { run, transcript } = await runClassicAction(conn, gate, {
    action: "read_transport_log",
    args: { trkorr },
    what: `Reading the import log of ${trkorr}`,
    expectTags: ["TRLG-READ"],
    beforeAssert,
  });

  let trFunction = "";
  let trStatus = "";
  let reqFound = false;
  const systemsByIndex = new Map<string, TrLogSystem>();
  const order: string[] = [];

  for (const line of transcript.raw.split("\n")) {
    const trimmed = line.trim();

    const reqMatch = TRLG_REQ_RE.exec(trimmed);
    if (reqMatch) {
      reqFound = true;
      trFunction = reqMatch[2]!;
      trStatus = reqMatch[3]!;
      continue;
    }

    const sysMatch = TRLG_SYS_RE.exec(trimmed);
    if (sysMatch) {
      const idx = sysMatch[1]!;
      const sys: TrLogSystem = {
        system: sysMatch[2]!,
        systemText: "",
        rc: unplaceholder(sysMatch[3]!),
        rcText: "",
        date: sysMatch[4]!,
        time: sysMatch[5]!,
        sortIndex: Number(sysMatch[6]),
        lines: [],
      };
      systemsByIndex.set(idx, sys);
      order.push(idx);
      continue;
    }

    const systxtMatch = TRLG_SYSTXT_RE.exec(trimmed);
    if (systxtMatch) {
      const sys = systemsByIndex.get(systxtMatch[1]!);
      if (sys) sys.systemText = systxtMatch[2] ?? "";
      continue;
    }

    const rctxtMatch = TRLG_RCTXT_RE.exec(trimmed);
    if (rctxtMatch) {
      const sys = systemsByIndex.get(rctxtMatch[1]!);
      if (sys) sys.rcText = rctxtMatch[2] ?? "";
      continue;
    }

    const lineMatch = TRLG_LINE_RE.exec(trimmed);
    if (lineMatch) {
      const sys = systemsByIndex.get(lineMatch[1]!);
      if (sys) {
        sys.lines.push({
          severity: unplaceholder(lineMatch[2]!),
          msgClass: unplaceholder(lineMatch[3]!),
          msgNumber: unplaceholder(lineMatch[4]!),
          text: lineMatch[5] ?? "",
        });
      }
      continue;
    }
  }

  if (!reqFound) {
    throw new AbapError(
      "CHECK_FAILED",
      `readTransportLog reported success for ${trkorr} but the transcript carried no ZMCP-TRLG-REQ line — ` +
        `the ABAP-side and TS-side parsers have drifted apart.`,
      { trkorr, raw: transcript.raw },
    );
  }

  const systems = order.map((idx) => systemsByIndex.get(idx)!);

  return { run, transcript, trkorr, trFunction, trStatus, systems };
}
