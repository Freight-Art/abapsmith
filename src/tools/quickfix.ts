/**
 * `abap_quick_fix` — ADT's own quick fixes, at one source position.
 * `mode="list"` evaluates what ADT offers there; `mode="apply"` applies one
 * proposal, by id, through the same journalled `abap_write` pipeline every
 * other mutation uses (undoable via `abap_journal mode=undo`).
 *
 * v1 applies deterministic proposals only. A parameterized proposal (one
 * that needs a value ADT would otherwise collect via a dialog) is refused,
 * not guessed at — see the `parameterized` branch below.
 *
 * Gated as a write in BOTH submodes, deliberately: `list` looks read-only
 * but its evaluation call POSTs the object's entire current source to the
 * server (`evaluateQuickFixes`, src/adt/quickfix.ts) — the same
 * blast-radius argument that gates `abap_atc` inside `canWrite`.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AbapConnection } from "../adt/connection.js";
import { AbapError, isAbapError } from "../adt/errors.js";
import type { SessionPool } from "../adt/pool.js";
import { resolveObject, type ResolvedObject } from "../adt/resolve.js";
import { readSource, sourceUriFor } from "../adt/source.js";
import { canonicalEtag } from "../adt/write.js";
import { applyRangeEdits, type ApplyResult } from "../adt/range-edit.js";
import {
  evaluateQuickFixes,
  fetchQuickFixDelta,
  type QuickFixProposal,
} from "../adt/quickfix.js";
import { CLASS_INCLUDES } from "../adt/types.js";
import type { Config, VerifyWritesMode } from "../config.js";
import type { SessionTransport } from "../adt/session-transport.js";
import type { Journal } from "../journal.js";
import { buildResponse, textTable, type BuiltResponse } from "../compact.js";
import type { SafetyGate } from "../safety.js";
import { preflight, writeGateKey } from "./preflight.js";
import { abapWrite } from "./write.js";

// ------------------------------------------------------------------ schema ---

export const quickFixInputSchema = {
  mode: z.enum(["list", "apply"]).describe('"list": proposals at a position. "apply": apply one by id.'),
  object: z.string().describe("Class/program/function group/interface."),
  type: z.string().optional().describe("ADT type, e.g. CLAS/OC, when ambiguous."),
  include: z
    .enum(CLASS_INCLUDES)
    .optional()
    .describe('CLAS/OC only; only "main" is accepted — quick fixes never target a sub-include.'),
  line: z.number().int().min(1).describe("1-based source line."),
  column: z.number().int().min(0).default(0).describe("0-based column. Default 0."),
  proposal: z.string().optional().describe('Proposal id from mode="list". Required for mode="apply".'),
  expect_etag: z.string().optional().describe("Etag from abap_read; fails if source changed since."),
  dry_run: z
    .boolean()
    .optional()
    .describe("mode=\"apply\" only: preview the write, no PUT/lock/activation/journal entry."),
  activate: z.boolean().optional().describe('mode="apply" only: activate after applying. Default true.'),
};

/** Full schema, for type inference and for the unknown-argument check. */
export const QuickFixInput = z.object(quickFixInputSchema);
export type QuickFixInput = z.infer<typeof QuickFixInput>;

const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(QuickFixInput.shape));

/**
 * Refuse arguments this tool does not have — same rationale as `atc.ts`'s
 * copy: the SDK boundary doesn't strip unknown keys silently, so this turns
 * "I passed a typo and nothing happened" into a named error.
 */
function rejectUnknownArgs(args: Record<string, unknown>): void {
  const unknown = Object.keys(args).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length === 0) return;
  throw new AbapError(
    "BAD_INPUT",
    `abap_quick_fix does not take ${unknown.map((k) => `\`${k}\``).join(", ")}.`,
    { unknown, known: [...KNOWN_KEYS] },
    `Parameters are: ${[...KNOWN_KEYS].join(", ")}.`,
  );
}

/**
 * A quick fix's position and edits are computed against one include's text.
 * Retargeting them at another include would apply someone else's
 * coordinates, so a write to a secondary include is refused here rather
 * than half-applied. Shared by the pre-resolve and post-resolve checks so
 * the wording exists once.
 */
function refuseNonMainInclude(objectLabel: string, include: string): AbapError {
  return new AbapError(
    "BAD_INPUT",
    `abap_quick_fix only targets a class's main include; ${objectLabel} named include "${include}".`,
    { include },
    'Only `include: "main"` (or omitting `include`) is accepted. To edit another include ' +
      "directly, use abap_write.",
  );
}

// --------------------------------------------------------------- rendering ---

function renderProposals(proposals: readonly QuickFixProposal[]): string {
  if (proposals.length === 0) return "";
  const rows = proposals.map((p) => ({
    ID: p.id,
    TITLE: p.title,
    KIND: p.parameterized ? `parameterized${p.parameter ? ` (${p.parameter})` : ""}` : "deterministic",
    DESCRIPTION: p.description,
  }));
  return textTable(rows, ["ID", "TITLE", "KIND", "DESCRIPTION"]);
}

function renderQuickFixList(
  obj: ResolvedObject,
  pos: { line: number; column: number },
  proposals: readonly QuickFixProposal[],
  maxChars: number,
): BuiltResponse {
  const notes: string[] = [];
  if (proposals.length === 0) {
    notes.push(
      `ADT offers no quick fix for ${obj.type} ${obj.name} at line ${pos.line}, column ${pos.column} ` +
        "(1-based line, 0-based column). This is a successful empty result, not an error.",
    );
  }
  return buildResponse({
    header: { object: `${obj.type} ${obj.name}`, line: pos.line, column: pos.column, proposals: proposals.length },
    body: renderProposals(proposals),
    bodyLabel: "PROPOSALS",
    notes,
    hints: [
      'Apply one with mode="apply", proposal:"<id>". v1 applies deterministic proposals only — a ' +
        "parameterized one needs interactive input this tool does not collect.",
    ],
    maxChars,
  });
}

/** One line naming the offending range, per failure kind — see `range-edit.ts`. */
function describeApplyFailure(f: Extract<ApplyResult, { ok: false }>): string {
  switch (f.kind) {
    case "out-of-bounds-line":
      return `${f.endpoint} line ${f.line} (document has ${f.lineCount} lines)`;
    case "out-of-bounds-column":
      return `${f.endpoint} line ${f.line}, column ${f.column} (line is ${f.lineLength} chars long)`;
    case "inverted-range":
      return `range ${JSON.stringify(f.range.start)}..${JSON.stringify(f.range.end)} ends before it starts`;
    case "overlapping-edits":
      return `edits ${f.firstIndex} and ${f.secondIndex} overlap`;
  }
}

// -------------------------------------------------------------------- core ---

/**
 * Resolve, gate, evaluate, and — for `mode="apply"` — apply one proposal
 * through `abapWrite`. `gate` mints the write authorization both submodes
 * need (see the module header for why `list` is gated too).
 */
export async function abapQuickFix(
  conn: AbapConnection,
  input: QuickFixInput,
  maxChars: number,
  gate: SafetyGate,
  journal?: Journal,
  transport?: SessionTransport,
  verifyWrites: VerifyWritesMode = "speculative",
): Promise<BuiltResponse> {
  // ---- zero-network refusals, before any HTTP call at all -----------------
  if (input.include !== undefined && input.include !== "main") {
    throw refuseNonMainInclude(input.object, input.include);
  }
  if (input.mode === "apply" && input.proposal === undefined) {
    throw new AbapError(
      "BAD_INPUT",
      'mode="apply" requires `proposal` — the id of one fix returned by mode="list".',
      {},
      'Run mode="list" at the same line/column first to see the available proposal ids.',
    );
  }
  if (input.mode === "list" && input.proposal !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      '`proposal` is ignored for mode="list" — it would be silently dropped, since list always ' +
        "returns every proposal at the position.",
      { proposal: input.proposal },
      'Drop `proposal`, or switch to mode="apply" to apply it.',
    );
  }

  const obj = await resolveObject(conn, input.object, { type: input.type });
  if (obj.include !== undefined && obj.include !== "main") {
    throw refuseNonMainInclude(`${obj.type} ${obj.name}`, obj.include);
  }
  if (obj.mode !== "source") {
    throw new AbapError(
      "NOT_FOUND",
      `${obj.type} ${obj.name} is a dictionary object with no editable source — quick fixes only ` +
        "apply to source-based objects (classes, programs, includes).",
      { type: obj.type, name: obj.name },
      "Nothing was read or evaluated.",
    );
  }

  // The write-allow gate — deliberately taken for `mode="list"` too; see the
  // module header. No bypass for list.
  gate.authorize(
    "write",
    {
      name: obj.name,
      ...(obj.packageName === undefined ? {} : { packageName: obj.packageName }),
      type: obj.type,
    },
    { corr: { kind: "unresolved" } },
  );

  const sourceUri = sourceUriFor(obj);
  const { source } = await readSource(conn, obj);
  const pos = { line: input.line, column: input.column };
  const proposals = await evaluateQuickFixes(conn, sourceUri, source, pos);

  if (input.mode === "list") {
    return renderQuickFixList(obj, pos, proposals, maxChars);
  }

  // ---- mode="apply" ---------------------------------------------------
  const chosen = proposals.find((p) => p.id === input.proposal);
  if (!chosen) {
    throw new AbapError(
      "BAD_INPUT",
      `No proposal with id "${input.proposal}" was offered for ${obj.type} ${obj.name} at line ` +
        `${pos.line}, column ${pos.column}.`,
      { proposal: input.proposal, offered: proposals.map((p) => p.id) },
      proposals.length
        ? `Available ids at this position: ${proposals.map((p) => p.id).join(", ")}.`
        : 'No proposals at all were offered at this position — run mode="list" to confirm.',
    );
  }

  if (chosen.parameterized) {
    throw new AbapError(
      "BAD_INPUT",
      `Proposal "${chosen.id}" (${chosen.title}) is parameterized` +
        (chosen.parameter ? ` — it needs a value for "${chosen.parameter}"` : " and needs interactive input") +
        ". This version applies deterministic proposals only. No network write has happened.",
      { proposal: chosen.id, ...(chosen.parameter !== undefined ? { parameter: chosen.parameter } : {}) },
      'Choose a non-parameterized proposal from mode="list", or apply this fix interactively in ADT.',
    );
  }

  const edits = await fetchQuickFixDelta(conn, chosen, { sourceUri, source, position: pos });

  if (edits.length === 0) {
    return buildResponse({
      header: { object: `${obj.type} ${obj.name}`, proposal: chosen.id },
      notes: [
        `Proposal "${chosen.id}" (${chosen.title}) produced no edits. Nothing was written, locked, ` +
          "or journalled.",
      ],
      maxChars,
    });
  }

  const applied = applyRangeEdits(source, edits);
  if (!applied.ok) {
    throw new AbapError(
      "UNSUPPORTED",
      `Proposal "${chosen.id}" (${chosen.title}) returned an edit abapsmith cannot apply ` +
        `(${applied.kind}): ${describeApplyFailure(applied)}. Nothing was written.`,
      { proposal: chosen.id, failure: applied },
      "Apply this fix interactively in ADT instead.",
    );
  }

  // abapWrite's own response text is re-wrapped as this response's BODY
  // below, and buildResponse trims a body's TAIL to fit (compact.ts's
  // keepLines) — exactly where the journal id and the
  // `abap_journal mode=undo entry=<id>` line live. Reserve room for this
  // call's own header so the outer wrap never has to re-truncate an
  // already-fitted inner response.
  const OUTER_HEADER_RESERVE = 300;
  const written = await abapWrite(
    conn,
    {
      object: input.object,
      type: input.type,
      source: applied.result,
      // Lost-update guard: hash the source AS READ for evaluation, so the
      // write refuses if the object changed between that read and this PUT
      // — same reasoning as `resolveWriteSource`'s `edit` branch (write.ts).
      expect_etag: input.expect_etag ?? canonicalEtag(source),
      activate: input.activate,
      dry_run: input.dry_run,
    },
    Math.max(1000, maxChars - OUTER_HEADER_RESERVE),
    gate,
    journal,
    transport,
    verifyWrites,
    "abap_quick_fix",
  );

  return buildResponse({
    header: {
      object: `${obj.type} ${obj.name}`,
      proposal: chosen.id,
      title: chosen.title,
      edits: edits.length,
    },
    body: written.text,
    bodyLabel: "WRITE",
    maxChars,
  });
}

// ---------------------------------------------------------------- register ---

export interface QuickFixToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars" | "verifyWrites">;
  readonly journal: Journal;
  readonly transport: SessionTransport;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/**
 * `mode="list"` looks read-only but POSTs the whole object source to ADT
 * for evaluation, so both submodes are gated as a write. Only READ_ONLY
 * (a capability switch is off) gets one sentence appended saying why;
 * SAFETY_DENIED (an allowlist didn't match the target — safety.ts, the
 * comment above the transport/release branch of `SafetyGate.assert`) has
 * nothing to do with read-only mode, so it and every other code pass
 * through unchanged.
 */
async function explainReadOnlyRefusal<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isAbapError(e) && e.code === "READ_ONLY") {
      throw new AbapError(
        e.code,
        `${e.message} Quick fixes are unavailable in read-only mode: even mode="list" POSTs the ` +
          "whole object source to ADT for evaluation, so both modes are gated as a write.",
        e.details,
        e.hint,
      );
    }
    throw e;
  }
}

/**
 * Registers `abap_quick_fix`. Preflight-gated as `write` (zero-HTTP-cost
 * refusal) for BOTH submodes, then dispatched to a write or read pool slot
 * depending on `mode` — the gate decision and the pool slot are separate
 * questions, see below.
 */
export function registerQuickFixTools(mcp: McpServer, deps: QuickFixToolDeps): void {
  mcp.registerTool(
    "abap_quick_fix",
    {
      description:
        'ADT quick fixes at one source position. mode="list" enumerates proposals; mode="apply" ' +
        "applies one by id through the journalled abap_write pipeline (undoable via abap_journal " +
        "mode=undo). v1 applies deterministic proposals only — a parameterized one is refused, not " +
        'guessed at. Gated as a write in BOTH modes: list POSTs the whole object source for ' +
        "evaluation, so it is unavailable on a read-only server.",
      inputSchema: quickFixInputSchema,
      annotations: {
        readOnlyHint: false,
        // Not read-only: apply overwrites source.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const a = (args ?? {}) as Record<string, unknown>;
        rejectUnknownArgs(a);
        await explainReadOnlyRefusal(() =>
          deps.safety.assert("write", preflight(a as { object: string; type?: string }), {
            phase: "preflight",
            corr: { kind: "unresolved" },
          }),
        );
        await deps.ensureConnected();
        const object = a.object as string;
        const type = a.type as string | undefined;
        const run = (conn: AbapConnection) =>
          abapQuickFix(
            conn,
            a as QuickFixInput,
            deps.cfg.maxResponseChars,
            deps.safety,
            deps.journal,
            deps.transport,
            deps.cfg.verifyWrites,
          );
        const res = await explainReadOnlyRefusal(() =>
          a.mode === "apply"
            ? deps.pool.withWrite("abap_quick_fix", writeGateKey(object, type), run)
            : // A READ slot: evaluation is a POST but takes no ABAP enqueue (pool.ts,
              // ROLE SEMANTICS) — holding the single write slot for an enumeration
              // would be wrong. It is still gated as `write` above and again inside.
              deps.pool.withRead("abap_quick_fix", run),
        );
        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
