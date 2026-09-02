/**
 * `abap_bopf_test` — exercise a BOPF business object at runtime.
 *
 * BOBT (SAP GUI's BOPF test tool) is a dynpro-only module pool with no ADT
 * surface. This module builds and runs a generated `IF_OO_ADT_CLASSRUN`
 * bridge (`src/adt/bopf-runtime.ts`) that drives
 * `/BOBF/IF_TRA_SERVICE_MANAGER` directly — the same layer BOBT sits on,
 * minus the dynpros. Structurally the BOPF analog of `src/tools/run.ts`.
 *
 * Two hazards this module exists to never launder:
 *   - `ev_rejected = 'X'` from `save()` is a FAILED test even though the
 *     classrun call returns 200 and ABAP raises nothing. Always rendered
 *     plainly as `rejected: true`.
 *   - This tool WRITES REAL ROWS BY DEFAULT — determinations/validations
 *     bound to save never fire without a real save. `generate_only` is the
 *     only dry-run mode (it just doesn't execute); `cleanup: true`
 *     deletes-and-saves the created rows in the same run.
 *
 * Applies `abap_run`'s "(no output)" discipline (`src/tools/run.ts:166-204`)
 * to the BOPF transcript fields: never render diagnostics, dropped lines, or
 * unconfirmed completeness as a clean silent run.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AbapConnection } from "../adt/connection.js";
import { AbapError } from "../adt/errors.js";
import type { SessionPool } from "../adt/pool.js";
import {
  bopfBridgeClassName,
  formatNodeLabel,
  runBopfTest as runBopfTestBridge,
  type BoModel,
  type BopfTestResult,
  type BopfTestScenario,
  type BopfTranscriptDataRow,
  type BopfTranscriptKey,
  type BopfTranscriptMessage,
} from "../adt/bopf-runtime.js";
import { buildResponse } from "../compact.js";
import type { Config } from "../config.js";
import type { SafetyGate } from "../safety.js";
import {
  BOPF_TYPE,
  readModel as bopfReadModel,
  checkReferences as bopfCheckReferences,
  collectRefSites,
} from "../adt/bopf.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const bopfTestInputSchema = {
  bo: z.string().describe("BOPF business object name. Must already be active."),
  scenario: z
    .object({
      nodes: z
        .array(
          z
            .object({
              node: z.string().describe("Node name, e.g. ROOT or ITEM."),
              parentNode: z.string().optional().describe("An earlier entry's node name. Omit for the root row."),
              fields: z.record(z.string(), z.string()).describe("Field name -> value (strings)."),
            })
            // Kept permissive here (not `.strict()`) so an unrecognised key survives
            // into `runBopfTest` instead of being stripped before the handler ever
            // sees it — the refusal there names the key and lists what's accepted.
            .passthrough(),
        )
        .min(1),
      cleanup: z.boolean().optional().describe("Delete-and-save the created rows again. Default false."),
    })
    .passthrough()
    .describe("Rows to create. nodes[0] is the root node (no parentNode); others need parentNode set."),
  generate_only: z
    .boolean()
    .optional()
    .describe("Writes/activates the test bridge without running it; writes no data."),
};

export const BopfTestInput = z.object(bopfTestInputSchema);
export type BopfTestInput = z.infer<typeof BopfTestInput>;

export const BOPF_TEST_TOOL_DESCRIPTION =
  "Runs a BOPF business object end to end: creates rows, saves, reports results. Writes real rows by " +
  "default. cleanup: true deletes-and-saves in the same run. generate_only: true writes/activates the " +
  "bridge without running it.";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface BopfTestDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars">;
  /**
   * Maps the raw BOPF model read onto the minimal `BoModel` shape this tool
   * needs. Injectable so the tool is testable without a live connection.
   */
  readonly readModel: (conn: AbapConnection, bo: string) => Promise<BoModel>;
  /**
   * Optional; absent by default. When absent, the tool reports `refsChecked:
   * false` — it must never silently claim a clean check it didn't perform.
   */
  readonly checkRefs?: (
    conn: AbapConnection,
    bo: string,
  ) => Promise<{ unchecked: number; findings: unknown[]; skipped?: number }>;
}

/**
 * Wires `readModel`/`checkRefs` to `src/adt/bopf.ts`. Both are pass-throughs
 * of an already-open `conn` (obtained via `pool.withWrite` in
 * `registerBopfTestTool`), so unlike `createLiveDebugToolDeps` this factory
 * needs no `{cfg, breaker, log, pool}` of its own.
 */
export function createBopfTestDeps(): Pick<BopfTestDeps, "readModel" | "checkRefs"> {
  return {
    async readModel(conn, bo) {
      const { model } = await bopfReadModel(conn, bo);
      return model;
    },
    async checkRefs(conn, bo) {
      const { model } = await bopfReadModel(conn, bo);
      const findings = await bopfCheckReferences(conn, model);
      const unchecked = findings.filter((f) => f.verdict === "unchecked").length;
      // Sites past DEFAULT_CHECK_REFS_MAX_SITES were never probed — must not read as a clean check.
      const skipped = Math.max(0, collectRefSites(model).length - findings.length);
      return { unchecked, findings: findings as unknown[], skipped };
    },
  };
}

// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------

type CheckRefsResult = { unchecked: number; findings: unknown[]; skipped?: number } | undefined;

function formatMessages(messages: BopfTranscriptMessage[]): string {
  return messages
    .map((m) => `${m.stage} SEV=${m.severity ?? "?"} ${m.text ?? ""}`.trimEnd())
    .join("\n");
}

function formatData(rows: BopfTranscriptDataRow[]): string {
  return rows
    .map((r) => {
      const label = formatNodeLabel(r);
      const fields = Object.entries(r.fields)
        .map(([k, v]) => `${k}={${v}}`)
        .join(" ");
      return fields ? `${label} ${fields}` : label;
    })
    .join("\n");
}

function formatKeys(keys: BopfTranscriptKey[]): string {
  return keys.map((k) => `${formatNodeLabel(k)} ${k.key}`).join("\n");
}

/** `checkReferences` caps its site list; the sites past the cap were never probed. */
export function formatSkippedRefsNote(checked: number, skipped: number): string {
  return (
    `check_refs stopped after ${checked} reference site(s); ${skipped} more were never probed. ` +
    "A dangling reference among those is not ruled out by this run."
  );
}

function buildBody(result: BopfTestResult, notes: string[]): { body?: string; bodyLabel?: string } {
  if (result.generateOnly) {
    // No transcript when nothing ran; caller's generate_only note covers it.
    return {};
  }
  const t = result.transcript;
  const diagnosticsCount = t?.diagnostics.length ?? 0;
  const hasDiagnostics = diagnosticsCount > 0;
  const droppedLines = t?.droppedLines ?? 0;
  const outputComplete = result.outputComplete;

  if (hasDiagnostics) {
    notes.push(
      `The BOPF bridge driver reported ${diagnosticsCount} diagnostic line(s) — see the ` +
        "DIAGNOSTICS section below. This usually means a step in the bridge itself failed " +
        "(e.g. an unexpected exception was caught), NOT merely that the run produced no messages.",
    );
  }
  if (droppedLines > 0) {
    notes.push(`${droppedLines} line(s) of the captured transcript were dropped and are not shown below.`);
  }
  if (outputComplete === false) {
    notes.push(
      "ABAP-side width truncation was detected on the transcript: one or more lines may have been " +
        "cut short before this tool ever saw them. The transcript below is not guaranteed complete.",
    );
  }

  const lineCount = t?.transcript.length ?? 0;
  const genuinelyEmpty = lineCount === 0 && droppedLines === 0 && !hasDiagnostics;
  const body =
    lineCount > 0
      ? t!.transcript.join("\n")
      : genuinelyEmpty
        ? "(no output)"
        : "(nothing shown here — but this run is NOT confirmed empty: see the NOTE(s) above about " +
          "diagnostics, dropped lines, and/or incomplete output. Do not read this as a clean, " +
          "silent, successful run.)";

  return { body, bodyLabel: "TRANSCRIPT" };
}

function buildTestResponse(
  result: BopfTestResult,
  refs: CheckRefsResult,
  maxChars: number,
  requestedBo: string,
): string {
  const refsChecked = refs !== undefined;
  const notes: string[] = [];

  if (!result.generateOnly && result.rejected === true) {
    notes.push(
      "The save was REJECTED by the BO (ev_rejected = 'X'). NOTHING WAS PERSISTED, even though " +
        "the classrun call itself returned 200 and raised no ABAP exception. Check the MESSAGES " +
        "section below for why.",
    );
  }

  if (result.generateOnly) {
    notes.push(
      `generate_only: true — bridge class ${result.bridgeClass} was written and activated but ` +
        "NOT executed. No business data was written. Trigger it via abap_debug's trigger " +
        `connection (object: "${result.bridgeClass}", mode: "class") after setting a breakpoint ` +
        "in a BO implementation class.",
    );
  }

  if (!refsChecked) {
    notes.push(
      "refsChecked: false — the referential-integrity check (dangling class references on " +
        "determinations/validations) was not available this run and could not be performed. A " +
        "determination or validation bound to a deleted/renamed class silently never fires and " +
        "reports nothing; that possibility cannot be ruled out here. If this scenario ran clean " +
        "with no messages, that is not by itself proof the BO's logic executed.",
    );
  } else if (refs.unchecked > 0 || refs.findings.length > 0) {
    notes.push(
      `check_refs reported ${refs.findings.length} finding(s) and ${refs.unchecked} unchecked ` +
        "reference(s) on this BO — a dangling reference among them would never fire and would " +
        "report nothing on its own.",
    );
  }
  if (refsChecked && refs.skipped) {
    notes.push(formatSkippedRefsNote(refs.findings.length, refs.skipped));
  }

  const { body, bodyLabel } = buildBody(result, notes);

  const t = result.transcript;
  const sections: Array<{ title: string; content: string }> = [];
  if (t) {
    if (t.messages.length) sections.push({ title: "MESSAGES", content: formatMessages(t.messages) });
    if (t.data.length) sections.push({ title: "DATA", content: formatData(t.data) });
    if (t.keys.length) sections.push({ title: "KEYS", content: formatKeys(t.keys) });
    if (t.diagnostics.length) sections.push({ title: "DIAGNOSTICS", content: t.diagnostics.join("\n") });
  }

  return buildResponse({
    header: {
      bo: result.bo || requestedBo,
      version: result.version,
      bridgeClass: result.bridgeClass,
      bridgeRefreshed: result.bridgeRefreshed,
      constantsInterface: result.constantsInterface,
      durationMs: result.durationMs,
      generateOnly: result.generateOnly,
      rejected: result.generateOnly ? "n/a (generate_only)" : (result.rejected ?? false),
      errors: result.generateOnly ? undefined : result.errors,
      warnings: result.generateOnly ? undefined : result.warnings,
      rowsWritten: result.generateOnly ? undefined : result.rowsWritten,
      refsChecked,
    },
    sections,
    body,
    bodyLabel,
    notes,
    maxChars,
  }).text;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

const SCENARIO_KEYS = ["nodes", "cleanup"] as const;
const SCENARIO_NODE_KEYS = ["node", "parentNode", "fields"] as const;

/**
 * `scenario`/`scenario.nodes[i]` are `.passthrough()` at the zod layer (see the
 * schema above), so an unrecognised key survives into `input` instead of being
 * silently stripped — that silent strip against a plain `z.object` was the
 * bug behind `scenario.actions` disappearing with no warning. Checked here instead,
 * naming the offending key and the accepted set — the SDK's own schema-parse
 * failure path (thrown before this handler runs) can't be made to say that.
 */
function assertKnownKeys(obj: object, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(obj).filter((k) => !(allowed as readonly string[]).includes(k));
  if (unknown.length === 0) return;
  const actionsNote = unknown.includes("actions")
    ? " The generated bridge only calls /BOBF/IF_TRA_SERVICE_MANAGER's modify/retrieve and " +
      "/BOBF/IF_TRA_TRANSACTION_MANAGER's save (src/adt/bopf-runtime.ts) — it never invokes a " +
      "BOPF action, so there is no way to run one through abap_bopf_test, under this key or any other."
    : "";
  throw new AbapError(
    "BAD_INPUT",
    `${where} has unrecognised key(s): ${unknown.map((k) => `"${k}"`).join(", ")}. ` +
      `Allowed: ${allowed.map((k) => `"${k}"`).join(", ")}.${actionsNote}`,
    { where, unknown, allowed },
  );
}

/**
 * Refuses any key on `scenario` or on a `scenario.nodes[i]` entry that isn't
 * part of the accepted shape. Zero-network — safe to call before
 * `ensureConnected`/`pool.withWrite`, and does. Exported for tests.
 */
export function validateBopfTestScenario(scenario: BopfTestInput["scenario"]): void {
  assertKnownKeys(scenario, SCENARIO_KEYS, "scenario");
  scenario.nodes.forEach((n, i) => assertKnownKeys(n, SCENARIO_NODE_KEYS, `scenario.nodes[${i}]`));
}

export async function runBopfTest(deps: BopfTestDeps, args: unknown): Promise<CallToolResult> {
  const input = args as BopfTestInput;

  validateBopfTestScenario(input.scenario);

  // Zero-network preflight: bopfBridgeClassName also validates `bo` (throws on
  // an injection attempt — it's embedded verbatim in generated ABAP) and gives
  // a deterministic gate key, so a refused write costs no network call.
  const bridgeClass = bopfBridgeClassName(input.bo);
  deps.safety.assert(
    "write",
    { name: bridgeClass, packageName: "$TMP", type: "CLAS/OC" },
    { phase: "preflight" },
  );
  if (!input.generate_only) {
    // Runs arbitrary customer code (determinations/validations/actions) — gated like abap_run.
    deps.safety.assert("execute", { name: input.bo, type: BOPF_TYPE }, { phase: "preflight" });
  }

  await deps.ensureConnected();

  const { result, refs } = await deps.pool.withWrite(
    "abap_bopf_test",
    bridgeClass,
    async (conn) => {
      const model = await deps.readModel(conn, input.bo);

      // An inactive BO produces a confusing constants-interface syntax error rather than a clear refusal.
      if (model.version !== undefined && model.version !== "active") {
        throw new AbapError(
          "CHECK_FAILED",
          `${input.bo} is not active (version: ${model.version}) — activate it before testing.`,
          { bo: input.bo, version: model.version },
        );
      }

      const refs = deps.checkRefs ? await deps.checkRefs(conn, input.bo) : undefined;

      const scenario: BopfTestScenario = {
        nodes: input.scenario.nodes,
        cleanup: input.scenario.cleanup,
      };
      const result = await runBopfTestBridge(conn, model, scenario, deps.safety, {
        generateOnly: input.generate_only,
      });
      return { result, refs };
    },
  );

  return ok(buildTestResponse(result, refs, deps.cfg.maxResponseChars, input.bo));
}

/** Registers `abap_bopf_test` on the MCP server. */
export function registerBopfTestTool(mcp: McpServer, deps: BopfTestDeps): void {
  mcp.registerTool(
    "abap_bopf_test",
    {
      description: BOPF_TEST_TOOL_DESCRIPTION,
      inputSchema: bopfTestInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      try {
        return await runBopfTest(deps, args);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
