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
import { AbapError, isAbapError } from "../adt/errors.js";
import {
  authTraceOf,
  renderFailedAuthChecks,
  switchOffErrorOf,
  withAuthTrace,
  type AuthTraceOutcome,
} from "../adt/authtrace.js";
import {
  selectImpacted,
  PER_OBJECT_CONSUMER_CAP,
  SELECTED_CARRIER_CAP,
  type CarrierProbe,
  type ChangedObject,
  type ConsumerRef,
  type ImpactedDeps,
  type SelectedCarrier,
} from "../adt/impacted.js";
import type { SessionPool } from "../adt/pool.js";
import { resolveObject, type ResolvedObject } from "../adt/resolve.js";
import { readSource } from "../adt/source.js";
import type { Config } from "../config.js";
import { buildResponse, type BuiltResponse } from "../compact.js";
import { Journal, systemKey, type JournalEntry } from "../journal.js";
import type { SafetyGate } from "../safety.js";
import { preflight } from "./preflight.js";

export const testInputSchema = {
  object: z.string().optional().describe("Class, program or package to test. Required unless scope is \"impacted\"."),
  type: z.string().optional().describe("ADT type, e.g. CLAS/OC."),
  scope: z
    .enum(["object", "impacted"])
    .optional()
    .describe(
      '"object" (default) runs one named object\'s tests. "impacted" selects the test classes ' +
        "the changed objects put at risk (where-used) and runs those.",
    ),
  changed: z
    .array(z.string())
    .optional()
    .describe(
      "Explicit changed-object names for scope=\"impacted\" — skips the journal. Ignored for scope=\"object\".",
    ),
  since: z
    .string()
    .optional()
    .describe(
      "ISO timestamp: for scope=\"impacted\", use journal writes since this time instead of the " +
        "current session. Ignored for scope=\"object\".",
    ),
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
  auth_trace: z
    .boolean()
    .optional()
    .describe(
      "Switch on the SAP authorization trace for the connected user, run the test, then read " +
        "back and switch it back off. scope=\"object\" only. Refused on a read-only server. " +
        "Default false.",
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

/**
 * Header value for `auth_trace`, shared shape with `abap_run`/`abap_bopf_test`
 * (issue #112 wiring): "no failed checks" / "N failed check(s)" on a run the
 * trace could complete, or the outcome's own "unavailable: <reason>" string
 * (never re-prefixed) when it could not.
 */
function authTraceHeaderValue(outcome: AuthTraceOutcome): string {
  if (!outcome.ok) return outcome.reason;
  return outcome.checks.length > 0 ? `${outcome.checks.length} failed check(s)` : "no failed checks";
}

/**
 * `renderFailedAuthChecks` already puts its own "FAILED AUTH CHECKS" line at
 * the top of its output; `buildResponse`'s `sections` also renders the title
 * from `{ title }` (`--- FAILED AUTH CHECKS ---`), so that first line is
 * dropped here to avoid printing the title twice. Returns undefined when
 * there is nothing to show.
 */
function authTraceSection(outcome: AuthTraceOutcome): { title: string; content: string } | undefined {
  if (!outcome.ok || outcome.checks.length === 0) return undefined;
  const rendered = renderFailedAuthChecks(outcome.checks);
  const [, ...rest] = rendered.split("\n");
  return { title: "FAILED AUTH CHECKS", content: rest.join("\n") };
}

/** Attaches what `withAuthTrace` learned to a propagating error's `details`, without ever converting the throw into a normal response. Only mutates `e` when `authTraceOf(e)` actually found something to attach. */
function attachAuthTraceToError(e: unknown): void {
  const outcome = authTraceOf(e);
  if (outcome === undefined || !isAbapError(e)) return;
  e.details["failedAuthChecks"] = outcome.ok
    ? outcome.checks.length > 0
      ? renderFailedAuthChecks(outcome.checks)
      : "no failed checks"
    : outcome.reason;
  const switchOffError = switchOffErrorOf(e);
  if (switchOffError !== undefined) {
    e.details["authTraceSwitchOffError"] = switchOffError;
  }
}

/**
 * `scope: "object"` path — unchanged since before scope existed. Only ever
 * reached once `abapTest` has confirmed `input.object` is set, hence the
 * assertion below rather than widening every line to handle `undefined`.
 */
async function abapTestObject(
  conn: AbapConnection,
  input: TestInput,
  maxChars: number,
  gate: SafetyGate,
): Promise<BuiltResponse> {
  const authTraceRequested = input.auth_trace === true;
  // System-level action (switches on the SAP authorization trace for the
  // connected user) — refused on a read-only server before any request is
  // made, same convention as every other zero-network refusal in this file.
  if (authTraceRequested && gate.config.readOnly === true) {
    throw new AbapError(
      "SAFETY_DENIED",
      "auth_trace switches the SAP authorization trace on for the connected user, a system-level " +
        "action, so it is refused on a read-only server.",
      { auth_trace: true },
      "Ask the operator to enable writes (ABAP_ALLOW_WRITE), or omit auth_trace to run without it.",
    );
  }

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

  // `abapTest` (below) refuses scope="object" with no `object` before this
  // function is ever called.
  const obj = await resolveObject(conn, input.object!, { type: input.type });

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

  const executeTestRun = async (): Promise<AunitRunResult> => {
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

    return parseRunResult(resp.body);
  };

  let res: AunitRunResult;
  let authTraceOutcome: AuthTraceOutcome | undefined;
  let authTraceSwitchOffError: string | undefined;
  if (authTraceRequested) {
    try {
      const wrapped = await withAuthTrace({ conn, gate }, conn.cfg.user, executeTestRun);
      res = wrapped.value;
      authTraceOutcome = wrapped.authTrace;
      authTraceSwitchOffError = wrapped.switchOffError;
    } catch (e) {
      attachAuthTraceToError(e);
      throw e;
    }
  } else {
    res = await executeTestRun();
  }

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

  if (authTraceRequested) {
    notes.push(
      "auth_trace reads the SAP authorization trace (falling back to the SU53 buffer) for this " +
        "run only; it changes no authorisation, role or profile.",
    );
    if (authTraceOutcome?.ok && authTraceOutcome.usedFallback) {
      notes.push(
        "The kernel authorization trace returned nothing, so this came from the SU53 buffer, " +
          "which shows only what that buffer retained — it is not a complete record of this run.",
      );
    }
    if (authTraceSwitchOffError !== undefined) {
      notes.push(
        `The authorization trace may have been left switched ON: switching it back off failed ` +
          `(${authTraceSwitchOffError}).`,
      );
    }
  }

  const body =
    coverageBody !== undefined ? `${renderBody(res)}\n\nCOVERAGE\n${coverageBody}` : renderBody(res);

  const authTraceSectionValue = authTraceOutcome ? authTraceSection(authTraceOutcome) : undefined;
  const sections: Array<{ title: string; content: string }> = [];
  if (authTraceSectionValue) sections.push(authTraceSectionValue);

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
      auth_trace: authTraceOutcome ? authTraceHeaderValue(authTraceOutcome) : undefined,
    },
    sections: sections.length > 0 ? sections : undefined,
    body,
    bodyLabel: "RESULTS",
    notes,
    hints,
    maxChars,
  });
}

// ---------------------------------------------------------------------------
// scope: "impacted" — select at-risk test carriers via where-used, then run
// each one through the exact same POST/parse/render path as scope="object".
// ---------------------------------------------------------------------------

/** How many unexamined-consumer names are named per line before collapsing into "… and N more". */
const TRUNCATION_NAME_CAP = 10;

/** Render up to {@link TRUNCATION_NAME_CAP} names, then an "… and N more" tail — keeps a 500-consumer fan-in from blowing the response budget. */
function formatTruncatedNames(names: readonly string[]): string {
  if (names.length <= TRUNCATION_NAME_CAP) return names.join(", ");
  const shown = names.slice(0, TRUNCATION_NAME_CAP);
  return `${shown.join(", ")}, … and ${names.length - TRUNCATION_NAME_CAP} more`;
}

/** `deps.whereUsed`/`deps.probeCarrier` wired against a real connection. */
function buildImpactedDeps(conn: AbapConnection): ImpactedDeps {
  return {
    async whereUsed(obj: ChangedObject): Promise<readonly ConsumerRef[]> {
      const resolved = await resolveObject(conn, obj.name, obj.type ? { type: obj.type } : {});
      const refs = await conn.adt.usageReferences(resolved.uri);
      const out: ConsumerRef[] = [];
      for (const r of refs) {
        const name = r["adtcore:name"];
        if (typeof name !== "string" || !name) continue; // grouping node, not a real reference
        const type = r["adtcore:type"];
        out.push({ name, type: typeof type === "string" ? type : "" });
      }
      return out;
    },
    async probeCarrier(obj: ConsumerRef): Promise<CarrierProbe> {
      const resolved = await resolveObject(conn, obj.name, obj.type ? { type: obj.type } : {});
      if (resolved.kind === "CLAS") {
        try {
          await readSource(conn, resolved, "testclasses");
          return "has-tests";
        } catch (e) {
          // `readSource` throws AbapError("NOT_FOUND", ..., { requested: "testclasses" })
          // specifically when the *include* is absent — a class with no test
          // class has no testclasses include (src/adt/source.ts). Match only
          // that exact signal: any other AbapError (auth, transport, lock,
          // a genuinely missing class) is a real failure and must not be
          // relabelled as "no tests" — that would silently drop a real test
          // carrier from the selection.
          if (isAbapError(e) && e.code === "NOT_FOUND" && e.details.requested === "testclasses") {
            return "no-tests";
          }
          throw e;
        }
      }
      // PROG/FUGR have no cheap "does it have tests" probe — the run's own
      // NO TESTS RAN outcome answers that question instead.
      if (resolved.kind === "PROG" || resolved.kind === "FUGR") return "unknown";
      return "no-tests";
    },
  };
}

/** Provenance of the changed set a run was selected from, for the notes. */
interface ChangedSetResult {
  changed: ChangedObject[];
  provenanceNote: string;
  /** Objects dropped because their newest journal entry was a successful delete. */
  droppedDeleted: number;
}

async function buildChangedSet(conn: AbapConnection, input: TestInput, journal: Journal): Promise<ChangedSetResult> {
  if (input.changed !== undefined) {
    const seen = new Set<string>();
    const changed: ChangedObject[] = [];
    for (const raw of input.changed) {
      const name = raw.trim().toUpperCase();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      changed.push({ name });
    }
    return {
      changed,
      provenanceNote: `Changed set: explicit \`changed\` list (${changed.length} object(s)), the journal was not consulted.`,
      droppedDeleted: 0,
    };
  }

  const key = systemKey(conn.cfg);
  let entries: JournalEntry[];
  let provenanceNote: string;
  if (input.since !== undefined) {
    entries = await journal.list({ systemKey: key, since: input.since });
    provenanceNote = `Changed set: journal writes to this system since ${input.since}.`;
  } else {
    // Mirrors `session="current"` in src/tools/journal.ts: resolve before
    // filtering, and fail loudly if there is nothing to resolve to yet
    // rather than silently falling back to "no session filter".
    if (!journal.sessionId) {
      throw new AbapError(
        "BAD_INPUT",
        'scope="impacted" with no `changed` and no `since` reads this server process\'s current ' +
          "session from the journal, but this process has no session id yet.",
        {},
        "This can only happen before the MCP initialize handshake has completed. Retry once " +
          "the client is connected, or pass `changed` or `since` explicitly.",
      );
    }
    entries = await journal.list({ systemKey: key, sessionId: journal.sessionId });
    provenanceNote = `Changed set: journal writes to this system in the current session (${journal.sessionId}).`;
  }

  // A failed write never took effect, so it never changed anything.
  const successful = entries.filter((e) => e.outcome !== "failed");
  // `entries` is newest-first (Journal.list()'s contract), so the first
  // occurrence per name IS the newest entry for that object.
  const newestByName = new Map<string, JournalEntry>();
  for (const e of successful) {
    const name = e.object?.name;
    if (!name) continue;
    const upper = name.toUpperCase();
    if (!newestByName.has(upper)) newestByName.set(upper, e);
  }

  let droppedDeleted = 0;
  const changed: ChangedObject[] = [];
  for (const e of newestByName.values()) {
    if (e.operation === "delete" && e.outcome === "succeeded") {
      // Created and deleted again within the same window: not a changed
      // object any more, there is nothing left on the system to test. A
      // delete that never confirmed success is left in the changed set —
      // whatever it left behind may still need testing.
      droppedDeleted++;
      continue;
    }
    changed.push({ name: e.object.name, type: e.object.type });
  }
  return { changed, provenanceNote, droppedDeleted };
}

/**
 * Header caps disclosure (issue #111): states the caps in force and whether
 * either one actually bit, so a caller reading only the header — not the
 * SELECTION section — can tell a complete selection from a truncated one.
 * `bit` should be true when the carrier cap was hit or any consumer went
 * unexamined because of the per-object cap.
 */
function formatCaps(bit: boolean): string {
  const base = `per-object ${PER_OBJECT_CONSUMER_CAP}, carriers ${SELECTED_CARRIER_CAP}`;
  return bit
    ? `${base} — TRUNCATED: an unexamined consumer may carry a test that did not run`
    : base;
}

function carrierOutcomeLabel(res: AunitRunResult): string {
  return res.outcome === "passed"
    ? "PASSED"
    : res.outcome === "failed"
      ? "FAILED"
      : res.outcome === "no-tests"
        ? "NO TESTS RAN (not a pass)"
        : "UNKNOWN (not a pass)";
}

/** One selected carrier's ABAP Unit run, or the error that stopped it. */
interface CarrierRun {
  carrier: SelectedCarrier;
  result?: AunitRunResult;
  error?: string;
}

/**
 * Run one selected carrier through the same resolve → authorize → POST →
 * parse path as `abapTestObject`. Never throws for an ADT-side failure — a
 * failed carrier must not lose the other carriers' verdicts (see
 * `abapTestImpacted`), so any failure is captured into `CarrierRun.error`
 * instead.
 */
async function runCarrier(
  conn: AbapConnection,
  carrier: SelectedCarrier,
  risk: RiskLevel,
  gate: SafetyGate,
): Promise<CarrierRun> {
  try {
    const obj = await resolveObject(conn, carrier.name, carrier.type ? { type: carrier.type } : {});
    gate.authorize("execute", { name: obj.name, packageName: obj.packageName, type: obj.type });
    const resp = await conn.post(AUNIT_TESTRUNS_URL, {
      headers: { "Content-Type": "application/*", Accept: "application/*" },
      body: buildRunConfiguration(obj.uri, risk),
    });
    if (resp.status !== 200) {
      return { carrier, error: `ABAP Unit test run answered HTTP ${resp.status}.` };
    }
    return { carrier, result: parseRunResult(resp.body) };
  } catch (e) {
    return { carrier, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * `scope: "impacted"`: select the test carriers a changed set puts at risk
 * (see `src/adt/impacted.ts`) and run each one. `abapTest` has already
 * refused every malformed combination of `object`/`changed`/`since`/
 * `coverage` before this runs.
 */
export async function abapTestImpacted(
  conn: AbapConnection,
  input: TestInput,
  maxChars: number,
  gate: SafetyGate,
  journal: Journal,
): Promise<BuiltResponse> {
  const risk: RiskLevel = input.risk_level ?? "harmless";
  const { changed, provenanceNote, droppedDeleted } = await buildChangedSet(conn, input, journal);

  const notes: string[] = [provenanceNote];
  if (droppedDeleted > 0) {
    notes.push(
      `${droppedDeleted} object(s) were created and then deleted again within the same window ` +
        "and were dropped from the changed set — there is nothing left on the system to test.",
    );
  }

  if (changed.length === 0) {
    const body = input.changed !== undefined
      ? "No changed objects were given — nothing was run."
      : `The journal held no writes for this system ${
          input.since !== undefined ? `since ${input.since}` : "in this session"
        } — nothing was run.`;
    notes.push("NO CHANGED OBJECTS is not a pass: nothing was tested.");
    return buildResponse({
      header: {
        system: conn.cfg.sid,
        scope: "impacted",
        changed: 0,
        consumersExamined: 0,
        selected: 0,
        outcome: "NO CHANGED OBJECTS (not a pass)",
        riskLevel: risk,
      },
      body,
      bodyLabel: "RESULTS",
      notes,
      maxChars,
    });
  }

  notes.push(
    "Where-used is static. Dynamic calls (CALL FUNCTION lv_name, PERFORM (lv_form), " +
      "SUBMIT (lv_prog)) do not appear here, so a test class reached only through a dynamic " +
      "call is not part of this selection.",
  );
  if (risk !== "critical") {
    notes.push(
      `Only tests up to risk level "${risk}" ran. Higher-risk tests, if any exist, were not ` +
        "executed and their absence is not a pass.",
    );
  }

  const selection = await selectImpacted(changed, buildImpactedDeps(conn));

  // Shared by both the empty-selection early return below and the populated
  // SELECTION section further down: whether either cap actually bit, and (if
  // so) which consumers were never examined because of it. Computed once so
  // "0 selected" cannot read as "nothing left to look at" when consumers were
  // in fact left unexamined.
  const totalNotExamined = selection.perObjectCapped.reduce((sum, c) => sum + c.notExamined.length, 0);
  const capsBit = selection.carrierCapHit || totalNotExamined > 0;
  const truncationLines = (): string[] => {
    const lines: string[] = [
      `--- TRUNCATED --- ${totalNotExamined} consumer(s) not examined (capped by ` +
        `the per-object limit of ${PER_OBJECT_CONSUMER_CAP} and/or the carrier limit of ` +
        `${SELECTED_CARRIER_CAP}${selection.carrierCapHit ? ", carrier limit reached" : ""}). An ` +
        "unexamined consumer may carry a test this run did not run.",
    ];
    for (const c of selection.perObjectCapped) {
      lines.push(
        `  ${c.object}: ${c.notExamined.length} consumer(s) not examined — ${formatTruncatedNames(c.notExamined)}`,
      );
    }
    for (const name of selection.neverExamined) {
      lines.push(`  ${name}: consumers not examined at all (carrier limit reached first)`);
    }
    return lines;
  };

  if (selection.selected.length === 0) {
    notes.push("Nothing was run; this is not a pass.");
    const bodyLines = [
      `NO IMPACTED TESTS FOUND — ${selection.changed.length} changed object(s), ` +
        `${selection.consumersExamined} consumer(s) examined, none carries a test class`,
    ];
    // capsBit here means "some consumer was never even looked at" — without
    // this, a truncated selection reads identically to a genuinely exhaustive
    // one that just found nothing, which is the overclaim issue #111 guards
    // against.
    if (capsBit) bodyLines.push(...truncationLines());
    return buildResponse({
      header: {
        system: conn.cfg.sid,
        scope: "impacted",
        changed: selection.changed.length,
        consumersExamined: selection.consumersExamined,
        selected: 0,
        caps: formatCaps(capsBit),
        outcome: "NO IMPACTED TESTS FOUND (not a pass)",
        riskLevel: risk,
      },
      body: bodyLines.join("\n"),
      bodyLabel: "RESULTS",
      notes,
      maxChars,
    });
  }

  const selectionLines = selection.selected.map((c) => `${c.name} (${c.type || "?"}) — ${c.reason}`);
  if (capsBit) selectionLines.push(...truncationLines());

  const runs: CarrierRun[] = [];
  for (const carrier of selection.selected) {
    runs.push(await runCarrier(conn, carrier, risk, gate));
  }

  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalUnknown = 0;
  let anyFailed = false;
  let anyUnknown = false;
  let anyPassed = false;
  let successfulRuns = 0;
  const bodyParts: string[] = [];

  for (const run of runs) {
    if (run.result) {
      successfulRuns++;
      const res = run.result;
      totalTests += res.total;
      totalPassed += res.passed;
      totalFailed += res.failed;
      totalUnknown += res.unknown;
      if (res.outcome === "failed") anyFailed = true;
      else if (res.outcome === "unknown") anyUnknown = true;
      else if (res.outcome === "passed") anyPassed = true;
      bodyParts.push(`=== ${run.carrier.name} (${run.carrier.type || "?"}): ${carrierOutcomeLabel(res)} ===\n${renderBody(res)}`);
    } else {
      notes.push(`Carrier ${run.carrier.name}: run failed — ${run.error}. The other carriers' verdicts are unaffected.`);
      bodyParts.push(`=== ${run.carrier.name} (${run.carrier.type || "?"}): ERROR (not a pass) ===\nERROR: ${run.error}`);
    }
  }

  const outcomeLabel =
    successfulRuns === 0
      ? "UNKNOWN (not a pass)"
      : anyFailed
        ? "FAILED"
        : anyUnknown
          ? "UNKNOWN (not a pass)"
          : anyPassed
            ? "PASSED"
            : "NO TESTS RAN (not a pass)";

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      scope: "impacted",
      changed: selection.changed.length,
      consumersExamined: selection.consumersExamined,
      selected: selection.selected.length,
      caps: formatCaps(capsBit),
      outcome: outcomeLabel,
      riskLevel: risk,
      tests: totalTests,
      passed: totalPassed,
      failed: totalFailed,
      unknown: totalUnknown > 0 ? totalUnknown : undefined,
    },
    sections: [{ title: "SELECTION", content: selectionLines.join("\n") }],
    body: bodyParts.join("\n\n"),
    bodyLabel: "RESULTS",
    notes,
    maxChars,
  });
}

/**
 * `abap_test` entry point: dispatches on `scope`. Every refusal below is
 * raised before any request — same convention as `coverage_for` above:
 * a silently ignored parameter is a mistake, not an oversight.
 */
export async function abapTest(
  conn: AbapConnection,
  input: TestInput,
  maxChars: number,
  gate: SafetyGate,
  journal?: Journal,
): Promise<BuiltResponse> {
  const scope = input.scope ?? "object";

  if (scope === "object") {
    if (input.changed !== undefined || input.since !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        "`changed`/`since` only apply to scope=\"impacted\". scope is \"object\" (the default) " +
          "here, so they would be silently ignored.",
        { scope, changed: input.changed, since: input.since },
        'Set scope: "impacted" to use `changed`/`since`, or drop them to run scope="object".',
      );
    }
    if (input.object === undefined) {
      throw new AbapError(
        "BAD_INPUT",
        'scope="object" (the default) needs `object`.',
        { scope },
        'Pass `object`, or set scope: "impacted" to select test carriers from changed objects instead.',
      );
    }
    return abapTestObject(conn, input, maxChars, gate);
  }

  // scope === "impacted"
  if (input.object !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      '`object` was given with scope="impacted". Impacted selection runs the test carriers a ' +
        "changed set puts at risk, not one named object.",
      { scope, object: input.object },
      'Drop `object`, or use scope="object" to test one named object directly.',
    );
  }
  if (input.changed !== undefined && input.since !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      "`changed` and `since` were both given. `since` selects the changed set from the journal " +
        "and would be silently ignored once `changed` is given explicitly.",
      { changed: input.changed, since: input.since },
      "Pass only one: `changed` for an explicit list, or `since` to read the journal.",
    );
  }
  if (input.coverage !== undefined || input.coverage_for !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      'Coverage is not supported for scope="impacted": `coverage`/`coverage_for` would be ' +
        "silently ignored across multiple carriers.",
      { scope, coverage: input.coverage, coverage_for: input.coverage_for },
      'Run scope="object" per carrier with coverage: true instead.',
    );
  }
  if (input.auth_trace === true) {
    throw new AbapError(
      "BAD_INPUT",
      'auth_trace is not supported for scope="impacted": it would switch the trace on and off ' +
        "once per carrier and would be silently ignored otherwise.",
      { scope, auth_trace: input.auth_trace },
      'Run scope="object" per carrier with auth_trace: true instead.',
    );
  }
  if (input.since !== undefined && Number.isNaN(Date.parse(input.since))) {
    throw new AbapError(
      "BAD_INPUT",
      `\`since\` "${input.since}" is not a timestamp \`Date.parse\` can read.`,
      { since: input.since },
      "Pass an ISO-8601 timestamp.",
    );
  }
  if (!journal) {
    throw new AbapError(
      "BAD_INPUT",
      'scope="impacted" needs the write journal, which this call site did not provide.',
      { scope },
    );
  }

  return abapTestImpacted(conn, input, maxChars, gate, journal);
}

export interface TestToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars">;
  readonly journal: Journal;
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
        'with coverage_for. scope="impacted" selects and runs the test carriers a changed ' +
        "set (explicit `changed` or the journal) puts at risk, instead of one named object.",
      inputSchema: testInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      try {
        const input = args as TestInput;
        // preflight() resolves `object`, which only exists for scope="object"
        // (the default). scope="impacted" has no single object to gate here —
        // each selected carrier is gated individually inside `runCarrier`, at
        // the point it is actually about to run.
        if ((input.scope ?? "object") === "object" && input.object !== undefined) {
          deps.safety.assert("execute", preflight(args as { object: string; type?: string }), {
            phase: "preflight",
          });
        }
        await deps.ensureConnected();
        // ABAP Unit executes customer code, so a dead-slot replay must be gated;
        // no object gate is taken since the run holds no enqueue.
        const res = await deps.pool.withWrite("abap_test", undefined, (conn) =>
          abapTest(conn, input, deps.cfg.maxResponseChars, deps.safety, deps.journal),
        );
        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
