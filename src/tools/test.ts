/**
 * `abap_test` — run ABAP Unit tests for an object and report the verdicts.
 *
 * One synchronous, stateless POST to `AUNIT_TESTRUNS_URL`, no polling. Wire
 * shapes and verdict rules live in `src/adt/aunit.ts`; this file is
 * presentation and safety. Stateless-path verification evidence archived in
 * the git history.
 *
 * A test runner that collapses "nothing ran" into "everything passed" is
 * worse than none, because it manufactures confidence. This tool always
 * reports one of PASSED, FAILED, NO TESTS (nothing ran — not a pass), or
 * UNKNOWN (ran but ungraded by `verdictForMethodNode` — not a pass either).
 * The two not-a-pass outcomes also raise a NOTE spelling that out.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  AUNIT_TESTRUNS_URL,
  buildRunConfiguration,
  parseRunResult,
  type AunitAlert,
  type AunitMethod,
  type AunitRunResult,
  type RiskLevel,
} from "../adt/aunit.js";
import type { AbapConnection } from "../adt/connection.js";
import { AbapError } from "../adt/errors.js";
import type { SessionPool } from "../adt/pool.js";
import { resolveObject } from "../adt/resolve.js";
import type { Config } from "../config.js";
import { buildResponse, type BuiltResponse } from "../compact.js";
import type { SafetyGate } from "../safety.js";
import { preflight } from "./preflight.js";

export const testInputSchema = {
  object: z.string().describe("Class, program or package to test."),
  type: z.string().optional().describe("ADT type, e.g. CLAS/OC."),
  risk_level: z
    .enum(["harmless", "dangerous", "critical"])
    .optional()
    .describe("Highest risk to run, cumulative from harmless. Default harmless."),
};

export const TestInput = z.object(testInputSchema);
export type TestInput = z.infer<typeof TestInput>;

/** One line per stack entry, always naming the include the line belongs to. */
function renderStack(alert: AunitAlert): string[] {
  return alert.stack.map((e) => {
    // Line indexes the INCLUDE, not the class main source.
    const where =
      e.line !== undefined
        ? e.includeName
          ? `include ${e.includeName} line ${e.line}`
          : `line ${e.line} (source unnamed — see URI)`
        : e.includeName
          ? `include ${e.includeName}`
          : "location not reported";
    const extra = e.description ? ` — ${e.description}` : e.uri ? ` — ${e.uri}` : "";
    return `    at ${where}${extra}`;
  });
}

function renderMethod(m: AunitMethod): string[] {
  const label = m.verdict === "failed" ? "FAILED " : "UNKNOWN";
  const timing = m.executionTime !== undefined ? ` (${m.executionTime}${m.unit ?? ""})` : "";
  const out: string[] = [`${label} ${m.className}->${m.name}${timing}`];

  if (m.verdict === "unknown") {
    out.push(
      `    NOT GRADED: this server does not recognise ${m.unrecognised.join(", ")} on this ` +
        "test method, so its result is unknown. Do not read it as a pass.",
    );
  }
  for (const a of m.alerts) {
    const kind = [a.severity, a.kind].filter(Boolean).join(" ");
    out.push(`    ${kind || "alert"}: ${a.title ?? "(no title)"}`);
    for (const d of a.details) out.push(`      ${d}`);
    out.push(...renderStack(a));
  }
  return out;
}

function renderBody(res: AunitRunResult): string {
  const lines: string[] = [];
  const bad = res.programs
    .flatMap((p) => p.classes)
    .flatMap((c) => c.methods)
    .filter((m) => m.verdict !== "passed");

  for (const m of bad) {
    lines.push(...renderMethod(m));
    lines.push("");
  }

  for (const p of res.programs) {
    for (const c of p.classes) {
      const passed = c.methods.filter((m) => m.verdict === "passed").map((m) => m.name);
      if (passed.length === 0) continue;
      const risk = c.riskLevel ? ` [risk ${c.riskLevel}]` : "";
      lines.push(`PASSED  ${c.name}${risk}: ${passed.join(", ")}`);
    }
  }

  for (const a of res.otherAlerts) {
    const kind = [a.severity, a.kind].filter(Boolean).join(" ");
    lines.push(`ALERT   (${a.scope}) ${kind || "alert"}: ${a.title ?? "(no title)"}`);
    for (const d of a.details) lines.push(`      ${d}`);
  }

  return lines.join("\n").trim() || "(the run result contained no test methods and no alerts)";
}

export async function abapTest(
  conn: AbapConnection,
  input: TestInput,
  maxChars: number,
  gate: SafetyGate,
): Promise<BuiltResponse> {
  const obj = await resolveObject(conn, input.object, { type: input.type });

  // Gated "execute", not "read"/"analyze": a test run compiles and executes
  // arbitrary customer code, same as `abap_run`. `gate` was once optional
  // (`gate?.assert`) and silently skipped this check — a live authorization
  // gap; see the git history. `authorize` is now
  // required and throws, making the POST below unreachable without it.
  gate.authorize("execute", { name: obj.name, packageName: obj.packageName, type: obj.type });

  const risk: RiskLevel = input.risk_level ?? "harmless";
  const body = buildRunConfiguration(obj.uri, risk);

  const resp = await conn.post(AUNIT_TESTRUNS_URL, {
    headers: { "Content-Type": "application/*", Accept: "application/*" },
    body,
  });

  if (resp.status !== 200) {
    throw new AbapError(
      "ADT_ERROR",
      `ABAP Unit test run for ${obj.name} answered HTTP ${resp.status}.`,
      { object: obj.name, status: resp.status, url: AUNIT_TESTRUNS_URL },
      "The run did not complete. This is not a test failure and not a pass.",
    );
  }

  const res = parseRunResult(resp.body);

  const notes: string[] = [];
  if (res.outcome === "no-tests") {
    notes.push(
      `NO TESTS RAN. ${res.reason ?? ""} This is NOT a pass — nothing about ${obj.name} was ` +
        `verified. Tests above risk level "${risk}" were excluded from this run; if the tests ` +
        "exist but are declared DANGEROUS or CRITICAL, re-run with a higher risk_level.",
    );
  } else if (res.outcome === "unknown") {
    notes.push(
      `RESULT NOT GRADED. ${res.reason ?? ""} Treat this run as unverified, not as passing.`,
    );
  }
  if (res.outcome !== "no-tests" && res.unknown > 0 && res.failed > 0) {
    notes.push(
      `${res.unknown} further method(s) could not be graded and are shown as UNKNOWN; the ` +
        "failure count below does not include them.",
    );
  }
  if (risk !== "critical") {
    notes.push(
      `Only tests up to risk level "${risk}" ran. Higher-risk tests, if any exist, were not ` +
        "executed and their absence is not a pass.",
    );
  }
  for (const a of res.otherAlerts) {
    if (res.outcome === "no-tests") continue; // already stated, in stronger words
    notes.push(`Run-level alert (${a.scope}): ${a.title ?? a.kind ?? "unnamed alert"}.`);
  }

  const outcomeLabel =
    res.outcome === "passed"
      ? "PASSED"
      : res.outcome === "failed"
        ? "FAILED"
        : res.outcome === "no-tests"
          ? "NO TESTS RAN (not a pass)"
          : "UNKNOWN (not a pass)";

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      object: `${obj.type} ${obj.name}`,
      outcome: outcomeLabel,
      riskLevel: risk,
      tests: res.total,
      passed: res.passed,
      failed: res.failed,
      // Surfaced only when non-zero — an ungraded method must never be missed.
      unknown: res.unknown > 0 ? res.unknown : undefined,
    },
    body: renderBody(res),
    bodyLabel: "RESULTS",
    notes,
    hints:
      res.outcome === "failed"
        ? [
            "Line numbers are positions in the named INCLUDE (usually testclasses), not in the " +
              "class main source. Read that include with abap_read.",
          ]
        : [],
    maxChars,
  });
}

export interface TestToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars">;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/** Registers `abap_test`: preflight-gated `execute`, runs in a WRITE pool slot. */
export function registerTestTools(mcp: McpServer, deps: TestToolDeps): void {
  mcp.registerTool(
    "abap_test",
    {
      description:
        "Run ABAP Unit tests; reports each method's verdict. PASSED/FAILED/NO TESTS " +
        "RAN/UNKNOWN — only PASSED is a pass. Needs write access, allowlisted package. " +
        "Defaults to harmless-risk tests.",
      inputSchema: testInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      try {
        deps.safety.assert("execute", preflight(args as { object: string; type?: string }), {
          phase: "preflight",
        });
        await deps.ensureConnected();
        // ABAP Unit executes customer code, so a dead-slot replay must be gated;
        // no object gate is taken since the run holds no enqueue.
        const res = await deps.pool.withWrite("abap_test", undefined, (conn) =>
          abapTest(conn, args as TestInput, deps.cfg.maxResponseChars, deps.safety),
        );
        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
