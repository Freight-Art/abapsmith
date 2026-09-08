/**
 * Thin adapter from the nine classic-bridge operations (view/transaction/
 * index/package create+delete, transport-entry-remove) onto the fluid
 * `classic` tool, so each operation's caller keeps calling a function with
 * the same name, signature and return type it always has, while the ABAP
 * runs through `dispatch()` and the static `ZCL_ZMCP_FLUID_CLASSIC` body
 * class instead of a generated per-operation `IF_OO_ADT_CLASSRUN` class.
 *
 * `dispatch()`'s own `targets` gate runs first, over the action's OWN
 * declared pointers — additional to, never a replacement for, the caller's
 * `assertBridgeMutation`/`assertServerPackage` checks, which still run
 * before this is called.
 */
import type { AbapConnection } from "./connection.js";
import type { SafetyGate } from "../safety.js";
import { AbapError } from "./errors.js";
import { dispatch } from "./fluid/dispatch.js";
import { CLASSIC_TOOL_ID, CLASSIC_BODY_CLASS, classicTool } from "./fluid/builtin/classic.js";
import {
  assertDdicTranscript,
  parseDdicTranscript,
  type DdicTag,
  type DdicTranscript,
} from "./ddic-transcript.js";
import type { RunResult } from "./run.js";

export interface ClassicCallOptions {
  /** Fluid action name, e.g. "delete_view". */
  readonly action: string;
  /** Arguments by the contract's names. Omit a key entirely — never pass `undefined`. */
  readonly args: Record<string, unknown>;
  /** The old `runDdicBridge` `what` wording, unchanged. */
  readonly what: string;
  readonly expectTags: readonly DdicTag[];
  readonly beforeAssert?: (transcript: DdicTranscript) => void;
  readonly completed?: Readonly<Partial<Record<DdicTag, string>>>;
  readonly partialHint?: string;
}

/**
 * Runs one classic action through `dispatch()` and re-plays the UNCHANGED
 * `assertDdicTranscript` assertions against the reconstructed transcript, so
 * every caller keeps the exact CHECK_FAILED wording and `completed`/
 * `partialHint` behaviour it had over the old per-operation bridge. No
 * `confirm` is needed: the confirm/plugin-mutate gates in `dispatch` apply
 * only to `origin: "plugin"`, and `classicTool.origin` is `"builtin"`.
 */
export async function runClassicAction(
  conn: AbapConnection,
  gate: SafetyGate,
  opts: ClassicCallOptions,
): Promise<{ run: RunResult; transcript: DdicTranscript }> {
  const fr = await dispatch(
    { conn, cfg: conn.cfg, gate, tools: new Map([[CLASSIC_TOOL_ID, classicTool]]) },
    { tool: CLASSIC_TOOL_ID, action: opts.action, args: opts.args },
  );

  if (!Array.isArray(fr.result) || !fr.result.every((v) => typeof v === "string")) {
    throw new AbapError(
      "FLUID_PROTOCOL_ERROR",
      `classic.${opts.action}: expected an array of output lines, got ${typeof fr.result}.`,
      { tool: CLASSIC_TOOL_ID, action: opts.action, result: fr.result },
    );
  }
  const lines = fr.result as readonly string[];
  const raw = lines.join("\n");
  const transcript = parseDdicTranscript(raw);
  if (opts.beforeAssert) opts.beforeAssert(transcript);
  assertDdicTranscript(transcript, opts.expectTags, opts.what, {
    completed: opts.completed,
    partialHint: opts.partialHint,
  });

  const run: RunResult = {
    mode: "class",
    object: CLASSIC_BODY_CLASS,
    output: raw,
    lines: raw === "" ? 0 : raw.split("\n").length,
    durationMs: fr.ms,
    droppedLines: 0,
    bodyBytes: raw.length,
    outputComplete: !fr.truncated,
  };
  return { run, transcript };
}
