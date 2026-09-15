/**
 * Read a TMS system's import queue (buffer) — `TMS_MGR_READ_TRANSPORT_QUEUE`,
 * the function module behind STMS's "Import Queue" screen.
 *
 * ADT has no documented read for this. The classic RFC-enabled function
 * module is reached through the same fluid `classic` tool bridge (body class
 * `ZCL_ZMCP_FLUID_CLASSIC`) `./transport-entry-remove.ts` uses — see
 * `read_import_queue` in `./fluid/builtin/classic/abap-transport.ts` for the
 * ABAP.
 *
 * `TMS_MGR_READ_TRANSPORT_QUEUE`'s own signature defaults several
 * import parameters to `'X'` — `IV_COLLECT_DATA`, `IV_READ_LOCKS`,
 * `IV_CLEAR_LOCKS`, `IV_UPDATE_CACHE`, `IV_MONITOR`, `IV_VERBOSE` — and at
 * least three of those (`IV_CLEAR_LOCKS`, `IV_UPDATE_CACHE`, `IV_MONITOR`)
 * are side-effecting: they clear TMS locks or rewrite the TMS cache. An
 * operation this module documents as read-only must not do either, so the
 * ABAP forces all six to SPACE explicitly.
 *
 * Live-verified on A4H client 001, 2026-09-15: `IV_SYSTEM='DEV'` (a system
 * not configured in this box's TMS domain) came back `sy-subrc 1
 * READ_CONFIG_FAILED` with an EMPTY `ES_EXCEPTION` — so the failure message
 * built here does not assume `ES_EXCEPTION` carries anything. `IV_SYSTEM='A4H'`,
 * `IV_DOMAIN='DOMAIN_A4H'` came back `sy-subrc 0` with zero buffer rows.
 * `STMSCALERT`'s message fields are `MSGID`/`MSGNO`/`MSGV1`..`MSGV4` — NOT
 * `ERRMSGID`.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import type { DdicTranscript } from "./ddic-transcript.js";
import { runClassicAction } from "./classic-call.js";

/** `ZMCP-TRQU-HEAD {system} {domain} {date} {time} {flag} {rowCount}` — step 4 of `read_import_queue`. */
const TRQU_HEAD_RE = /^ZMCP-TRQU-HEAD (\S+) (\S+) (\S+) (\S+) (\S+) (\d+)/;
/** `ZMCP-TRQU-ROW {bufpos} {trkorr} {impflg} {maxrc} {trfunc} {owner} {tarcli}` — "-" stands in for an initial field. */
const TRQU_ROW_RE = /^ZMCP-TRQU-ROW (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+)/;
/** `ZMCP-TRQU-TEXT {bufpos} {text...}` — free text, paired with the preceding TRQU-ROW by bufpos. */
const TRQU_TEXT_RE = /^ZMCP-TRQU-TEXT (\S+) ?(.*)$/;

export interface TrQueueEntry {
  position: string;
  trkorr: string;
  importFlag: string;
  maxRc: string;
  trFunction: string;
  owner: string;
  targetClient: string;
  description: string;
}

export interface TransportQueueResult {
  run: RunResult;
  transcript: DdicTranscript;
  system: string;
  domain: string;
  collectedDate: string;
  collectedTime: string;
  collectFlag: string;
  entries: TrQueueEntry[];
}

export interface TransportQueueParams {
  system: string;
  domain?: string;
}

/** Turns a "-" placeholder (emitted by the ABAP for an initial space-free field) back into "". */
function unplaceholder(value: string): string {
  return value === "-" ? "" : value;
}

/**
 * Read a TMS system's import queue via the fluid `classic` tool.
 *
 * Read-only: no `assertBridgeMutation`/`AuthorizedTarget` call — there is no
 * object or package to authorize a read against, and the TMS system id
 * named by `params.system` is not an ABAP object at all.
 */
export async function readImportQueueViaBridge(
  conn: AbapConnection,
  gate: SafetyGate,
  params: TransportQueueParams,
): Promise<TransportQueueResult> {
  const system = (params.system ?? "").trim().toUpperCase();
  if (system === "") {
    throw new AbapError("BAD_INPUT", "system is required", { params });
  }
  const domain = (params.domain ?? "").trim().toUpperCase();

  const beforeAssert = (transcript: DdicTranscript): void => {
    if (transcript.errorLine?.startsWith("cannot read the import queue of")) {
      throw new AbapError(
        "NOT_FOUND",
        `Cannot read the import queue of ${system}: it is not a system this TMS domain knows about, ` +
          `or the domain controller could not be reached. Raw ABAP-side detail: ${transcript.errorLine}`,
        { system, domain, raw: transcript.raw },
        "TMS_MGR_READ_TRANSPORT_QUEUE raised READ_CONFIG_FAILED — check the system id (and domain, " +
          "if the box's TMS domain names more than one) against STMS's system overview (TMSCSYS/TCESYST).",
      );
    }
  };

  const { run, transcript } = await runClassicAction(conn, gate, {
    action: "read_import_queue",
    args: { system, domain },
    what: `Reading the import queue of ${system}`,
    expectTags: ["TRQU-READ"],
    beforeAssert,
  });

  let head: { system: string; domain: string; date: string; time: string; flag: string } | undefined;
  const entries: TrQueueEntry[] = [];
  let pendingRow: TrQueueEntry | undefined;

  for (const line of transcript.raw.split("\n")) {
    const trimmed = line.trim();

    const headMatch = TRQU_HEAD_RE.exec(trimmed);
    if (headMatch) {
      head = {
        system: headMatch[1]!,
        domain: unplaceholder(headMatch[2]!),
        date: headMatch[3]!,
        time: headMatch[4]!,
        flag: unplaceholder(headMatch[5]!),
      };
      continue;
    }

    const rowMatch = TRQU_ROW_RE.exec(trimmed);
    if (rowMatch) {
      if (pendingRow) entries.push(pendingRow);
      pendingRow = {
        position: unplaceholder(rowMatch[1]!),
        trkorr: unplaceholder(rowMatch[2]!),
        importFlag: unplaceholder(rowMatch[3]!),
        maxRc: unplaceholder(rowMatch[4]!),
        trFunction: unplaceholder(rowMatch[5]!),
        owner: unplaceholder(rowMatch[6]!),
        targetClient: unplaceholder(rowMatch[7]!),
        description: "",
      };
      continue;
    }

    const textMatch = TRQU_TEXT_RE.exec(trimmed);
    if (textMatch && pendingRow) {
      pendingRow.description = textMatch[2] ?? "";
      entries.push(pendingRow);
      pendingRow = undefined;
      continue;
    }
  }
  if (pendingRow) entries.push(pendingRow);

  if (!head) {
    throw new AbapError(
      "CHECK_FAILED",
      `readImportQueue reported success for ${system} but the transcript carried no ZMCP-TRQU-HEAD line — ` +
        `the ABAP-side and TS-side parsers have drifted apart.`,
      { system, domain, raw: transcript.raw },
    );
  }

  return {
    run,
    transcript,
    system: head.system,
    domain: head.domain,
    collectedDate: head.date,
    collectedTime: head.time,
    collectFlag: head.flag,
    entries,
  };
}
