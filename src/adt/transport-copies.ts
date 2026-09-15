/**
 * Create a transport of copies (`TRFUNCTION 'T'`) via `TR_INSERT_REQUEST_WITH_TASKS`.
 *
 * ADT's own `/sap/bc/adt/cts/transports` write silently ignores a posted
 * `<TRFUNCTION>` other than the workbench default and reads back `tm:type`
 * as if nothing were said (see `./customizing-request.ts`'s module doc
 * comment for the type-K case); posting to `/sap/bc/adt/cts/transportrequests`
 * with `tm:type="W"` throws `Check of condition failed` outright. Neither ADT
 * endpoint can create a transport of copies, so this reaches the classic
 * RFC-enabled function module instead, through the same fluid `classic` tool
 * bridge (body class `ZCL_ZMCP_FLUID_CLASSIC`) `./transport-entry-remove.ts`
 * uses — see `create_transport_of_copies` in
 * `./fluid/builtin/classic/abap-transport.ts` for the ABAP.
 *
 * Critical fact, live-verified on A4H client 001, 2026-09-15: `IT_USERS` and
 * `ET_TASK_HEADERS` are ORDINARY parameters on `TR_INSERT_REQUEST_WITH_TASKS`,
 * NOT `TABLES` parameters — calling them with a `TABLES` clause short-dumps
 * "Type conflict during a function module call". A live create came back
 * `TRFUNCTION='T'`, `TRSTATUS='D'`, `TARSYSTEM='A4H'`, with ZERO task
 * headers — a transport of copies has no tasks, so `tasks: 0` is the normal
 * answer, not a sign anything went wrong.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import type { DdicTranscript } from "./ddic-transcript.js";
import { runClassicAction } from "./classic-call.js";
import type { AuthorizedTarget } from "../safety.js";

/** `ZMCP-TRTC-CREATED {trkorr} {trfunction} {trstatus} {tarsystem} {as4user} {taskCount}` — step 5 of `create_transport_of_copies`. */
const TRTC_CREATED_RE = /^ZMCP-TRTC-CREATED (\S+) (\S+) (\S+) (\S+) (\S+) (\d+)/;

export interface TransportOfCopiesResult {
  run: RunResult;
  transcript: DdicTranscript;
  trkorr: string;
  trFunction: string;
  trStatus: string;
  target: string;
  owner: string;
  /** Live on A4H 2026-09-15: always 0 — a transport of copies has no tasks. */
  tasks: number;
}

export interface TransportOfCopiesParams {
  description: string;
  target: string;
  devClass: string;
}

/** Turns a "-" placeholder (emitted by the ABAP for an initial space-free field) back into "". */
function unplaceholder(value: string): string {
  return value === "-" ? "" : value;
}

/**
 * Create a transport of copies via the fluid `classic` tool.
 *
 * `authorized` must be minted by `SafetyGate.authorize("transport", { name:
 * params.devClass, packageName: params.devClass }, ...)` — mirroring
 * `trCreate` (`./transports.ts`), which this create shares its safety
 * op/shape with. A runtime backstop below refuses fail-closed if the minted
 * target's name doesn't match `params.devClass`, the same defense-in-depth
 * `trCreate` applies, since the type system only guarantees SOME
 * `AuthorizedTarget` was minted, not that it matches THIS call's devClass.
 */
export async function createTransportOfCopiesViaBridge(
  conn: AbapConnection,
  gate: SafetyGate,
  params: TransportOfCopiesParams,
  authorized: AuthorizedTarget<"transport", { name: string; packageName?: string }>,
): Promise<TransportOfCopiesResult> {
  const authName = authorized.target.name.trim().toUpperCase();
  const actualName = params.devClass.trim().toUpperCase();
  if (authName !== actualName) {
    throw new AbapError(
      "SAFETY_DENIED",
      `Internal wiring error in createTransportOfCopiesViaBridge: the AuthorizedTarget names ` +
        `"${authorized.target.name}", but the transport of copies is about to be created for package ` +
        `"${params.devClass}". An AuthorizedTarget minted for one package must never be threaded into ` +
        "a call that creates a request for a different one.",
      { authorizedName: authorized.target.name, actualName: params.devClass },
      "This indicates a bug in the caller — mint a fresh AuthorizedTarget for the actual devClass.",
    );
  }

  const description = (params.description ?? "").trim();
  if (description === "") {
    throw new AbapError("BAD_INPUT", "description is required", { params });
  }
  const target = (params.target ?? "").trim().toUpperCase();
  if (target === "") {
    throw new AbapError(
      "BAD_INPUT",
      "target is required — a transport of copies with no target system can never be imported",
      { params },
    );
  }
  const devClass = (params.devClass ?? "").trim().toUpperCase();
  if (devClass === "") {
    throw new AbapError("BAD_INPUT", "devClass is required", { params });
  }

  const beforeAssert = (transcript: DdicTranscript): void => {
    if (transcript.errorLine?.startsWith("CTS reported success but allocated no request number")) {
      throw new AbapError(
        "CHECK_FAILED",
        `TR_INSERT_REQUEST_WITH_TASKS reported success creating a transport of copies for ${devClass} ` +
          `→ ${target} but allocated no request number. Raw ABAP-side detail: ${transcript.errorLine}`,
        { devClass, target, description, raw: transcript.raw },
      );
    }
    if (transcript.errorLine?.includes("but E070 has no row for it")) {
      throw new AbapError(
        "CHECK_FAILED",
        `TR_INSERT_REQUEST_WITH_TASKS allocated a request for ${devClass} → ${target} but a re-read of ` +
          `E070 found no row for it. Raw ABAP-side detail: ${transcript.errorLine}`,
        { devClass, target, description, raw: transcript.raw },
      );
    }
  };

  const { run, transcript } = await runClassicAction(conn, gate, {
    action: "create_transport_of_copies",
    args: { description, target, devclass: devClass },
    what: `Creating a transport of copies for ${devClass} targeting ${target}`,
    expectTags: ["TRTC-CREATED"],
    beforeAssert,
  });

  let created: TransportOfCopiesResult | undefined;
  for (const line of transcript.raw.split("\n")) {
    const trimmed = line.trim();
    const match = TRTC_CREATED_RE.exec(trimmed);
    if (match) {
      created = {
        run,
        transcript,
        trkorr: match[1]!,
        trFunction: match[2]!,
        trStatus: match[3]!,
        target: unplaceholder(match[4]!),
        owner: match[5]!,
        tasks: Number(match[6]),
      };
      break;
    }
  }

  if (!created) {
    throw new AbapError(
      "CHECK_FAILED",
      `createTransportOfCopies reported success for ${devClass} → ${target} but the transcript carried ` +
        `no ZMCP-TRTC-CREATED line — the ABAP-side and TS-side parsers have drifted apart.`,
      { devClass, target, description, raw: transcript.raw },
    );
  }

  return created;
}
