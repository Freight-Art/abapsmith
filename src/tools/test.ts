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
  buildCoverageQuery,
  buildCoveredObjectsScope,
  buildRunConfiguration,
  coveredObjectsUrl,
  findCoverageNode,
  parseCoverageResult,
  parseCoveredObjects,
  parseRunResult,
  type AunitAlert,
  type AunitMethod,
  type AunitRunResult,
  type CoverageNode,
  type CoverageRatio,
  type CoverageResult,
  type CoveredObject,
  type RiskLevel,
} from "../adt/aunit.js";
import type { AbapConnection } from "../adt/connection.js";
import { AbapError } from "../adt/errors.js";
import type { SessionPool } from "../adt/pool.js";
import { resolveObject, type ResolvedObject } from "../adt/resolve.js";
import type { Config } from "../config.js";
import { buildResponse, type BuiltResponse } from "../compact.js";
import type { SafetyGate } from "../safety.js";
import { preflight } from "./preflight.js";
import { DEFAULT_LOG_WINDOW_SECONDS } from "../adt/bal-log.js";
import { LOG_TOOL_ID, LOG_ACTION } from "../adt/fluid/builtin/log.js";

export const testInputSchema = {
  object: z.string().describe("Class, program or package to test."),
  type: z.string().optional().describe("ADT type, e.g. CLAS/OC."),
  risk_level: z
    .enum(["harmless", "dangerous", "critical"])
    .optional()
    .describe("Highest risk to run, cumulative from harmless. Default harmless."),
  coverage: z
    .boolean()
    .optional()
    .describe("Also measure statement/branch/procedure coverage and report it per class and per method."),
  coverage_for: z
    .array(z.string())
    .optional()
    .describe(
      "Objects to report coverage for. Default: the objects under test. Use this to report an " +
        "object the tests exercise indirectly. Ignored unless coverage is true.",
    ),
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

// ---------------------------------------------------------------------------
// Coverage (opt-in, additive) — see the module doc comment for the wire
// protocol and the honesty rule this section exists to enforce: absence of
// measurement is reported as such, never folded into 0%.
// ---------------------------------------------------------------------------

/** A query over the full ~35-object roster timed out live against A4H (60s HTTP timeout). */
const COVERAGE_FOCUS_CAP = 10;

/** At most this many roster entries are listed under "ALSO TOUCHED". */
const ALSO_TOUCHED_SHOWN = 15;

function formatRatio(label: string, r: CoverageRatio | undefined): string {
  if (!r) return `${label} not reported`;
  if (r.total === 0) return `${label} n/a`;
  return `${label} ${r.executed}/${r.total} (${Math.round((r.executed / r.total) * 100)}%)`;
}

function renderCoverageRatios(node: {
  statement?: CoverageRatio;
  branch?: CoverageRatio;
  procedure?: CoverageRatio;
}): string {
  return [
    formatRatio("statement", node.statement),
    formatRatio("branch", node.branch),
    formatRatio("procedure", node.procedure),
  ].join("  ");
}

function renderCoverageNodeLine(node: CoverageNode, indent: string): string {
  const unrecognised = node.unrecognised.length
    ? `  [unrecognised coverage types: ${node.unrecognised.join(", ")}]`
    : "";
  return `${indent}${node.name}  ${renderCoverageRatios(node)}${unrecognised}`;
}

/** Running sum of one ratio type across every focus node found, for the header field. */
interface RatioSum {
  total: number;
  executed: number;
  seen: boolean;
}

function addRatio(sum: RatioSum, r: CoverageRatio | undefined): void {
  if (!r) return;
  sum.total += r.total;
  sum.executed += r.executed;
  sum.seen = true;
}

function formatRatioSum(label: string, s: RatioSum): string {
  if (!s.seen) return `${label} not reported`;
  if (s.total === 0) return `${label} n/a`;
  return `${label} ${s.executed}/${s.total} (${Math.round((s.executed / s.total) * 100)}%)`;
}

/** One requested coverage-scope name, resolved against the covered-objects roster. */
interface FocusEntry {
  requestedName: string;
  object: CoveredObject;
}

/**
 * Retrieve and render the coverage section. Called only when `input.coverage`
 * is true, and only ever from inside the try/catch in `abapTest` — any throw
 * here is a coverage failure, not a test failure, and must never surface as
 * one.
 *
 * Returns `undefined` when there is nothing to render (no measurement
 * reference on the run result); the caller has already added the
 * corresponding NOTE by then.
 */
async function buildCoverageSection(
  conn: AbapConnection,
  res: AunitRunResult,
  obj: ResolvedObject,
  input: TestInput,
  notes: string[],
  hints: string[],
): Promise<{ body: string; header?: string } | undefined> {
  if (res.coverageUri === undefined) {
    notes.push(
      "Coverage was requested but the run result carried no measurement reference, so no " +
        "coverage is reported. The PASSED/FAILED verdicts above are unaffected.",
    );
    return undefined;
  }

  const coveredResp = await conn.post(coveredObjectsUrl(res.coverageUri), {
    headers: { "Content-Type": "application/*", Accept: "application/*" },
    body: buildCoveredObjectsScope(),
  });
  if (coveredResp.status !== 200) {
    throw new AbapError(
      "ADT_ERROR",
      `Coverage covered-objects query for ${obj.name} answered HTTP ${coveredResp.status}.`,
      { object: obj.name, status: coveredResp.status, url: coveredObjectsUrl(res.coverageUri) },
    );
  }
  const roster = parseCoveredObjects(coveredResp.body);

  const coverageForList = input.coverage_for ?? [];
  const explicitScope = coverageForList.length > 0;
  const requestedNames: string[] = explicitScope ? coverageForList : res.programs.map((p) => p.name);

  let matches: FocusEntry[] = [];
  let notTouched: string[] = [];
  for (const name of requestedNames) {
    const entry = roster.find((o) => o.name.toLowerCase() === name.toLowerCase());
    if (entry) matches.push({ requestedName: name, object: entry });
    else notTouched.push(name);
  }

  // Objects-under-test default: if none of them matched the roster by name,
  // fall back to the resolved object itself (by roster name, else its own uri
  // so it can still be queried even though the roster never named it).
  if (!explicitScope && matches.length === 0) {
    const entry = roster.find((o) => o.name.toLowerCase() === obj.name.toLowerCase());
    matches = [{ requestedName: obj.name, object: entry ?? { name: obj.name, uri: obj.uri } }];
    notTouched = [];
  }

  const toQuery = matches.slice(0, COVERAGE_FOCUS_CAP);
  const skipped = matches.slice(COVERAGE_FOCUS_CAP);
  if (skipped.length > 0) {
    notes.push(
      `Coverage focus was capped at ${COVERAGE_FOCUS_CAP} objects — querying the whole covered-` +
        `objects roster timed out live against a real system. Not queried: ` +
        `${skipped.map((m) => m.requestedName).join(", ")}.`,
    );
  }

  // A match with no `uri` on its roster entry can't be named in a
  // `cov:query` at all — this is distinct from "capped out" (never sent
  // because of the 10-object limit) and from "queried and unmeasured"
  // (sent, and the trace has nothing for it). Conflating any of these three
  // into one label states a fact abapsmith did not establish.
  const queryable = toQuery.filter((m) => m.object.uri !== undefined);
  const noUri = toQuery.filter((m) => m.object.uri === undefined);

  let coverage: CoverageResult | undefined;
  if (queryable.length > 0) {
    const focusUris = queryable.map((m) => m.object.uri).filter((u): u is string => u !== undefined);
    const queryResp = await conn.post(res.coverageUri, {
      headers: { "Content-Type": "application/*", Accept: "application/*" },
      body: buildCoverageQuery(focusUris),
    });
    if (queryResp.status !== 200) {
      throw new AbapError(
        "ADT_ERROR",
        `Coverage measurement query for ${obj.name} answered HTTP ${queryResp.status}.`,
        { object: obj.name, status: queryResp.status, url: res.coverageUri },
      );
    }
    coverage = parseCoverageResult(queryResp.body);
  } else if (toQuery.length > 0) {
    // Every matched-and-in-cap object lacks a URI: querying would mean
    // calling `buildCoverageQuery([])`, which throws BAD_INPUT — that would
    // land in the outer catch as "coverage could not be retrieved", which
    // reads like a transport failure rather than "none of these objects
    // could be named in a query". Say the real reason instead and move on.
    notes.push(
      `Coverage could not be queried for ${toQuery.map((m) => m.requestedName).join(", ")}: the ` +
        "covered-objects roster carried no URI for them.",
    );
  }

  const lines: string[] = [];
  const uncovered: string[] = [];
  const notReported: string[] = [];
  let anyAbsent = false;
  const sums = {
    statement: { total: 0, executed: 0, seen: false } as RatioSum,
    branch: { total: 0, executed: 0, seen: false } as RatioSum,
    procedure: { total: 0, executed: 0, seen: false } as RatioSum,
  };

  for (const m of matches) {
    if (skipped.includes(m)) {
      // Never sent to ADT because of the focus cap — abapsmith has no
      // information about it at all, not even "unmeasured".
      lines.push(`${m.requestedName}  not queried (coverage focus capped at ${COVERAGE_FOCUS_CAP} objects)`);
      continue;
    }
    if (noUri.includes(m)) {
      // Never sent to ADT because there was nothing to name it with.
      lines.push(`${m.requestedName}  not queried (no object URI on the covered-objects roster)`);
      continue;
    }
    const node = coverage ? findCoverageNode(coverage, m.requestedName) : undefined;
    if (coverage?.measured && node) {
      lines.push(renderCoverageNodeLine(node, ""));
      for (const child of node.children) {
        lines.push(renderCoverageNodeLine(child, "  "));
        if (child.statement) {
          if (child.statement.total > 0 && child.statement.executed === 0) {
            uncovered.push(
              `${node.name}->${child.name}  (${child.statement.executed}/${child.statement.total} statements)`,
            );
          }
        } else {
          notReported.push(`${node.name}->${child.name}`);
        }
      }
      addRatio(sums.statement, node.statement);
      addRatio(sums.branch, node.branch);
      addRatio(sums.procedure, node.procedure);
    } else {
      // Actually sent to ADT and came back with nothing — genuinely
      // "queried and unmeasured", unlike the two cases above.
      lines.push(`${m.requestedName}  not measured by this run`);
      anyAbsent = true;
    }
  }

  for (const name of notTouched) {
    lines.push(`${name}  not touched by this run`);
    anyAbsent = true;
  }

  if (anyAbsent) {
    notes.push(
      'Absence of measurement is not zero coverage: an object or method reported "not measured ' +
        'by this run" or "not touched by this run" was never observed by the coverage trace, ' +
        "which is different from having been observed and found uncovered.",
    );
  }

  if (uncovered.length > 0) {
    lines.push("", "UNCOVERED METHODS (0 of their statements ran):");
    for (const u of uncovered) lines.push(`  ${u}`);
    hints.push(
      "An uncovered method ran zero of its statements. Read it with `abap_read method=…` and " +
        "add a test for it — the abapsmith-write-abap-unit-tests skill covers writing ABAP Unit tests.",
    );
  }
  if (notReported.length > 0) {
    lines.push("", "COVERAGE NOT REPORTED FOR:");
    for (const n of notReported) lines.push(`  ${n}`);
  }

  const focusNames = new Set([...matches.map((m) => m.requestedName.toLowerCase()), ...notTouched.map((n) => n.toLowerCase())]);
  const others = roster.filter((o) => !focusNames.has(o.name.toLowerCase()));
  if (others.length > 0) {
    lines.push("", "ALSO TOUCHED (not reported on — name one in coverage_for to measure it):");
    for (const o of others.slice(0, ALSO_TOUCHED_SHOWN)) {
      lines.push(`  ${o.name} (${o.type ?? "?"}, ${o.packageName ?? "?"})`);
    }
    if (others.length > ALSO_TOUCHED_SHOWN) {
      lines.push(`  … and ${others.length - ALSO_TOUCHED_SHOWN} more (truncated)`);
    }
  }

  const header =
    sums.statement.seen || sums.branch.seen || sums.procedure.seen
      ? [
          formatRatioSum("statement", sums.statement),
          formatRatioSum("branch", sums.branch),
          formatRatioSum("procedure", sums.procedure),
        ].join(", ")
      : undefined;

  return { body: lines.join("\n"), ...(header !== undefined ? { header } : {}) };
}

export async function abapTest(
  conn: AbapConnection,
  input: TestInput,
  maxChars: number,
  gate: SafetyGate,
): Promise<BuiltResponse> {
  // Raised before any request: a caller who asked for a coverage scope
  // (`coverage_for`) and silently got no coverage (because `coverage` was
  // left unset) has been misled, not merely under-served.
  if (input.coverage_for !== undefined && !input.coverage) {
    throw new AbapError(
      "BAD_INPUT",
      "`coverage_for` was given without `coverage: true`. Coverage is only measured and " +
        "reported when `coverage` is true; naming objects in `coverage_for` on their own would " +
        "silently run with no coverage measured at all.",
      { coverage: input.coverage ?? false, coverage_for: input.coverage_for },
      "Set `coverage: true` alongside `coverage_for`.",
    );
  }

  const obj = await resolveObject(conn, input.object, { type: input.type });

  // Gated "execute", not "read"/"analyze": a test run compiles and executes
  // arbitrary customer code, same as `abap_run`. `gate` was once optional
  // (`gate?.assert`) and silently skipped this check — a live authorization
  // gap; see the git history. `authorize` is now
  // required and throws, making the POST below unreachable without it.
  gate.authorize("execute", { name: obj.name, packageName: obj.packageName, type: obj.type });

  const risk: RiskLevel = input.risk_level ?? "harmless";
  const requestBody = buildRunConfiguration(
    obj.uri,
    risk,
    input.coverage ? { coverage: true } : {},
  );

  const resp = await conn.post(AUNIT_TESTRUNS_URL, {
    headers: { "Content-Type": "application/*", Accept: "application/*" },
    body: requestBody,
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

  const hints: string[] =
    res.outcome === "failed"
      ? [
          "Line numbers are positions in the named INCLUDE (usually testclasses), not in the " +
            "class main source. Read that include with abap_read.",
        ]
      : [];

  // No duration is measured for an ABAP Unit run here (unlike run.ts/bopf-test.ts/ui.ts,
  // there is nothing in `res` to round up), so this note must not pretend to a measured
  // window — it names the fluid log tool's own default instead and says so plainly.
  // `notes`, not `hints`: hints only render inside a TRUNCATED/WINDOW notice, so this
  // line must go to `notes` to reach the caller on the normal, non-truncated path.
  notes.push(
    `Application log (BAL) entries this run may have written: abap_fluid ` +
      `{"tool":"${LOG_TOOL_ID}","action":"${LOG_ACTION}","args":{"last_seconds":${DEFAULT_LOG_WINDOW_SECONDS},"detail":"messages"}} ` +
      `— a default one-hour window; this tool does not measure its own run time, so narrow it ` +
      "yourself if the system is busy.",
  );

  // Coverage is strictly additive: this run's PASSED/FAILED/NO TESTS/UNKNOWN
  // outcome and every count above are decided already, from `res` alone.
  // Anything below only appends a section and notes/hints; a coverage
  // failure must never become a test failure, hence the try/catch around
  // the whole retrieval.
  let coverageBody: string | undefined;
  let coverageHeader: string | undefined;
  if (input.coverage) {
    notes.push(
      "Coverage was requested: this instruments the whole ABAP Unit session and runs slower " +
        "than a plain test run.",
    );
    try {
      const section = await buildCoverageSection(conn, res, obj, input, notes, hints);
      if (section) {
        coverageBody = section.body;
        coverageHeader = section.header;
      }
    } catch (e) {
      notes.push(
        `Coverage could not be retrieved: ${e instanceof Error ? e.message : String(e)}. The ` +
          "test result above is unaffected and still reflects the full run.",
      );
    }
  }

  const body =
    coverageBody !== undefined ? `${renderBody(res)}\n\nCOVERAGE\n${coverageBody}` : renderBody(res);

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
      coverage: coverageHeader,
    },
    body,
    bodyLabel: "RESULTS",
    notes,
    hints,
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
        "Defaults to harmless-risk tests. Opt-in coverage: coverage=true, optionally scoped " +
        "with coverage_for.",
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
