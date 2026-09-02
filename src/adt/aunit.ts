/**
 * ABAP Unit runner — `POST /sap/bc/adt/abapunit/testruns`.
 *
 * The call is SYNCHRONOUS: 200 with the complete run result in the body, no
 * polling handle (live-measured 610ms against A4H). This module therefore
 * does not use the debugger's stateful-session machinery
 * (`src/debug/transport.ts`) — and the stateless path it actually sends is
 * itself live-verified, not just assumed to match a stateful capture. See
 * the git history for the capture evidence.
 *
 * Passing-method discriminator is keyed on alert SEVERITY, not on absence of
 * `<alerts>`: only one pass and one fail sample have ever been captured, so
 * an unseen severity is reported `unknown`, never guessed as `passed`. See
 * {@link SEVERITY_FAILS} / {@link SEVERITY_PASSES} and
 * {@link verdictForMethodNode}; full rationale archived alongside.
 *
 * Stack line numbers are relative to the INCLUDE named in the stack entry
 * (e.g. `testclasses`), never the class main source — always render with
 * {@link AunitStackEntry.includeName}.
 *
 * "No tests ran" (`kind="noTestClasses"`, no `<program>` element) gets its
 * own {@link AunitOutcome} value `"no-tests"`, decided before any pass/fail
 * arithmetic — 0 failures of 0 tests verifies nothing.
 */
import { XMLParser } from "fast-xml-parser";
import { AbapError } from "./errors.js";
import { parseStartFragment } from "./activate.js";
import { ECHO_LINE_MAX, MESSAGE_EXCERPT_MAX, truncateText } from "../truncate.js";

/** The run endpoint. Live-captured; takes `Content-Type: application/*`. */
export const AUNIT_TESTRUNS_URL = "/sap/bc/adt/abapunit/testruns";

/**
 * SAP's own risk taxonomy for a test method (`RISK LEVEL` in the test class):
 *
 *   harmless   changes neither persistent data nor system settings
 *   dangerous  may change persistent DATA
 *   critical   may change SYSTEM SETTINGS
 *
 * Cumulative, lowest-first: asking for `dangerous` also runs `harmless`.
 * The default everywhere in this server is `harmless` — see
 * {@link buildRunConfiguration}.
 */
export type RiskLevel = "harmless" | "dangerous" | "critical";

export const RISK_LEVELS: readonly RiskLevel[] = ["harmless", "dangerous", "critical"];

export type MethodVerdict = "passed" | "failed" | "unknown";

export type AunitOutcome = "passed" | "failed" | "no-tests" | "unknown";

export interface AunitStackEntry {
  uri?: string;
  /**
   * 1-based source line from the URI fragment `#start=<line>,<col>`.
   *
   * ⚠️ Relative to {@link includeName}, not to the class main source. Never
   * render this number without saying which include it indexes.
   */
  line?: number;
  col?: number;
  /**
   * The include the line belongs to — the segment after `/includes/` in the
   * stack entry URI, e.g. `testclasses`. Undefined when the URI names no
   * include, in which case the position refers to the object's own source.
   */
  includeName?: string;
  type?: string;
  name?: string;
  description?: string;
}

export interface AunitAlert {
  kind?: string;
  severity?: string;
  title?: string;
  /** `<detail text="…">` texts flattened depth-first, indented by nesting depth. */
  details: string[];
  stack: AunitStackEntry[];
}

export interface AunitMethod {
  name: string;
  className: string;
  verdict: MethodVerdict;
  executionTime?: string;
  unit?: string;
  alerts: AunitAlert[];
  /**
   * Populated only for `verdict: "unknown"`: the exact attribute/child tokens
   * that were not recognised, so the fix is a one-line allowlist edit rather
   * than an investigation.
   */
  unrecognised: string[];
}

export interface AunitClass {
  name: string;
  riskLevel?: string;
  durationCategory?: string;
  methods: AunitMethod[];
}

export interface AunitProgram {
  name: string;
  type?: string;
  classes: AunitClass[];
}

/** An alert that is NOT attached to a test method (run, program or class level). */
export interface AunitScopedAlert extends AunitAlert {
  scope: string;
}

export interface AunitRunResult {
  outcome: AunitOutcome;
  programs: AunitProgram[];
  otherAlerts: AunitScopedAlert[];
  total: number;
  passed: number;
  failed: number;
  unknown: number;
  /** Always set for `no-tests` and `unknown`; the sentence a human should read. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Build the `aunit:runConfiguration` document.
 *
 * Byte-identical to the live capture (`382-ut-testrun.meta.json.requestBody`)
 * for `risk: "critical"`, pinned in `test/aunit.test.ts` against the capture
 * itself. `<testRiskLevels>` narrows with `risk`; `<testDurations>` always
 * keeps all three true — duration says nothing about what a test touches.
 *
 * Live-verified 2026-08-01: a narrowed body is accepted and filtered
 * server-side, not rejected. If a future SAP release did reject it, the
 * failure surfaces as `noTestClasses` (reported `"no-tests"`), never a
 * silent pass. Full capture evidence archived.
 */
export function buildRunConfiguration(objectUri: string, risk: RiskLevel = "harmless"): string {
  const on = (level: RiskLevel): string =>
    RISK_LEVELS.indexOf(level) <= RISK_LEVELS.indexOf(risk) ? "true" : "false";
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit">\n' +
    "  <external>\n" +
    '    <coverage active="false"/>\n' +
    "  </external>\n" +
    "  <options>\n" +
    '    <uriType value="semantic"/>\n' +
    '    <testDeterminationStrategy sameProgram="true" assignedTests="false"/>\n' +
    `    <testRiskLevels harmless="${on("harmless")}" dangerous="${on("dangerous")}" critical="${on("critical")}"/>\n` +
    '    <testDurations short="true" medium="true" long="true"/>\n' +
    '    <withNavigationUri enabled="true"/>\n' +
    "  </options>\n" +
    '  <adtcore:objectSets xmlns:adtcore="http://www.sap.com/adt/core">\n' +
    '    <objectSet kind="inclusive">\n' +
    "      <adtcore:objectReferences>\n" +
    `        <adtcore:objectReference adtcore:uri="${escapeXmlAttribute(objectUri)}"/>\n` +
    "      </adtcore:objectReferences>\n" +
    "    </objectSet>\n" +
    "  </adtcore:objectSets>\n" +
    "</aunit:runConfiguration>"
  );
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * `attributeNamePrefix: "@_"` is load-bearing: the verdict guard must
 * distinguish an ATTRIBUTE from a CHILD ELEMENT (a verdict smuggled into a
 * future `<testMethod failed="X"/>` attribute), which a flattened key space
 * (cf. `src/debug/xml-response.ts`) can't represent.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

type Node = Record<string, unknown>;

function isNode(v: unknown): v is Node {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** fast-xml-parser: one child → object, 2+ → array, 0 → absent. Normalise. */
function many(v: unknown): Node[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.filter(isNode);
  return isNode(v) ? [v] : [];
}

function attr(node: Node, name: string): string | undefined {
  const v = node[`@_${name}`];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

/** Child-element names on `node`, i.e. every key that is not an attribute. */
function childNames(node: unknown): string[] {
  if (!isNode(node)) return [];
  return Object.keys(node).filter((k) => !k.startsWith("@_"));
}

/** Attribute names on `node`, without the `@_` prefix. */
function attributeNames(node: unknown): string[] {
  if (!isNode(node)) return [];
  return Object.keys(node)
    .filter((k) => k.startsWith("@_"))
    .map((k) => k.slice(2));
}

// -- The discriminator ------------------------------------------------------

/**
 * Every child element a `<testMethod>` is known to carry. A passing method
 * carries none of them; a failing method carries `alerts`.
 */
export const KNOWN_TEST_METHOD_CHILDREN: ReadonlySet<string> = new Set(["alerts"]);

/**
 * Every attribute a `<testMethod>` is known to carry (from `382-ut-testrun.xml`;
 * namespace prefixes stripped, so `adtcore:name` is `name`). Extend when SAP
 * adds a field — until then, new attributes report `unknown` by name rather
 * than silently passing.
 */
export const KNOWN_TEST_METHOD_ATTRIBUTES: ReadonlySet<string> = new Set([
  "uri",
  "type",
  "name",
  "executionTime",
  "uriType",
  "navigationUri",
  "unit",
]);

/**
 * Alert severities that fail a test method. `critical` is live-observed
 * (`382-ut-testrun.xml`); unlisted severities become `unknown`, not a pass —
 * see {@link verdictForMethodNode}.
 */
export const SEVERITY_FAILS: ReadonlySet<string> = new Set(["critical"]);

/**
 * Alert severities a test method may carry while still PASSING.
 *
 * Empty on purpose: `tolerable` has been observed only on the run-level
 * `noTestClasses` notice, never on a passing method. Extend only when a
 * capture proves a severity coexists with a pass — until then such methods
 * report `unknown`, not a guessed pass.
 */
export const SEVERITY_PASSES: ReadonlySet<string> = new Set<string>();

/**
 * Verdict decision, isolated so it can be tested directly. Ordering is
 * load-bearing (checked in this order, fail-closed):
 *
 *  1. anything unrecognised (child/attribute/text) → `unknown`, before alerts
 *     can out-vote it.
 *  2. no `<alerts>` child → `passed` (the one shape observed on a pass).
 *  3. severity in {@link SEVERITY_FAILS} → `failed`.
 *  4. every severity in {@link SEVERITY_PASSES} → `passed`.
 *  5. otherwise (unobserved severity, or no `@severity`) → `unknown`.
 */
export function verdictForMethodNode(node: unknown): {
  verdict: MethodVerdict;
  unrecognised: string[];
} {
  const unrecognised: string[] = [];
  for (const child of childNames(node)) {
    // `#text` survives the parser only when non-whitespace — real stray content.
    if (child === "#text") unrecognised.push("text content");
    else if (!KNOWN_TEST_METHOD_CHILDREN.has(child)) unrecognised.push(`<${child}>`);
  }
  for (const a of attributeNames(node)) {
    if (!KNOWN_TEST_METHOD_ATTRIBUTES.has(a)) unrecognised.push(`@${a}`);
  }
  if (unrecognised.length > 0) return { verdict: "unknown", unrecognised };

  if (!childNames(node).includes("alerts")) return { verdict: "passed", unrecognised: [] };

  const severities = many((node as Node).alerts)
    .flatMap((container) => many(container.alert))
    .map((a) => attr(a, "severity"));

  if (severities.some((s) => s !== undefined && SEVERITY_FAILS.has(s))) {
    return { verdict: "failed", unrecognised: [] };
  }
  const ungraded = severities.filter((s) => s === undefined || !SEVERITY_PASSES.has(s));
  if (ungraded.length === 0) return { verdict: "passed", unrecognised: [] };
  return {
    verdict: "unknown",
    unrecognised: ungraded.map((s) => (s === undefined ? "alert with no @severity" : `severity="${s}"`)),
  };
}

// -- Alerts -----------------------------------------------------------------

/** Flatten `<details><detail text="…"><details>…` depth-first, indenting by depth. */
function flattenDetails(node: unknown, depth: number, out: string[]): void {
  if (!isNode(node)) return;
  for (const detail of many(node.detail)) {
    const text = attr(detail, "text");
    if (text) out.push("  ".repeat(depth) + truncateText(text, ECHO_LINE_MAX));
    flattenDetails(detail.details, depth + 1, out);
  }
}

/**
 * Pull the include name out of a stack-entry URI, e.g.
 * `.../includes/testclasses#start=17,0` → `testclasses`. Needed because the
 * line number indexes the include, not the class main source.
 */
export function includeNameFromUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const path = String(uri).split("#")[0] ?? "";
  const m = /\/includes\/([^/?#]+)\/?$/.exec(path);
  return m ? m[1] : undefined;
}

function parseStack(node: unknown): AunitStackEntry[] {
  if (!isNode(node)) return [];
  return many(node.stackEntry).map((e) => {
    const uri = attr(e, "uri");
    const at = parseStartFragment(uri);
    const includeName = includeNameFromUri(uri);
    return {
      ...(uri ? { uri } : {}),
      ...(at ? { line: at.line, col: at.col } : {}),
      ...(includeName ? { includeName } : {}),
      ...(attr(e, "type") ? { type: attr(e, "type") } : {}),
      ...(attr(e, "name") ? { name: attr(e, "name") } : {}),
      ...(attr(e, "description")
        ? { description: truncateText(attr(e, "description")!, ECHO_LINE_MAX) }
        : {}),
    };
  });
}

function parseAlerts(container: unknown): AunitAlert[] {
  if (!isNode(container)) return [];
  return many(container.alert).map((a) => {
    const details: string[] = [];
    flattenDetails(a.details, 0, details);
    const title = typeof a.title === "string" ? a.title.trim() : undefined;
    return {
      ...(attr(a, "kind") ? { kind: attr(a, "kind") } : {}),
      ...(attr(a, "severity") ? { severity: attr(a, "severity") } : {}),
      ...(title ? { title: truncateText(title, MESSAGE_EXCERPT_MAX) } : {}),
      details,
      stack: parseStack(a.stack),
    };
  });
}

/** `kind` of the run-level alert that means "the object has no test classes". */
export const NO_TEST_CLASSES_KIND = "noTestClasses";

/**
 * Parse an `aunit:runResult` document.
 *
 * Throws `ADT_ERROR` when the body is not a run result at all — an empty body
 * or an `exc:exception` must never be silently reduced to "0 tests, all fine".
 */
export function parseRunResult(xml: string): AunitRunResult {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch (e) {
    throw new AbapError(
      "ADT_ERROR",
      `ABAP Unit run result is not parseable XML: ${(e as Error).message}`,
      { excerpt: truncateText(xml, MESSAGE_EXCERPT_MAX) },
    );
  }
  // Empty `<aunit:runResult/>` parses to `""`, not absent — falls through to
  // `unknown` below. Only a body with NO `runResult` element at all (an
  // `exc:exception` envelope, a proxy error page) throws here.
  const docNode = isNode(doc) ? doc : undefined;
  const hasRunResult = docNode !== undefined && "runResult" in docNode;
  const root: Node = hasRunResult && isNode(docNode.runResult) ? docNode.runResult : {};
  if (!hasRunResult) {
    throw new AbapError(
      "ADT_ERROR",
      "ABAP Unit answered 200 but the body carries no <aunit:runResult> element.",
      { excerpt: truncateText(xml, MESSAGE_EXCERPT_MAX) },
      "This is a wire-shape change, not a test failure. Do not read it as a passing run.",
    );
  }

  const otherAlerts: AunitScopedAlert[] = [];
  for (const a of parseAlerts(root.alerts)) otherAlerts.push({ ...a, scope: "run" });

  const programs: AunitProgram[] = [];
  let total = 0;
  let passed = 0;
  let failed = 0;
  let unknown = 0;

  for (const prog of many(root.program)) {
    const programName = attr(prog, "name") ?? "(unnamed program)";
    for (const a of parseAlerts(prog.alerts)) {
      otherAlerts.push({ ...a, scope: `program ${programName}` });
    }
    const classes: AunitClass[] = [];
    for (const tcContainer of many(prog.testClasses)) {
      for (const tc of many(tcContainer.testClass)) {
        const className = attr(tc, "name") ?? "(unnamed test class)";
        for (const a of parseAlerts(tc.alerts)) {
          otherAlerts.push({ ...a, scope: `test class ${className}` });
        }
        const methods: AunitMethod[] = [];
        for (const tmContainer of many(tc.testMethods)) {
          for (const tm of many(tmContainer.testMethod)) {
            const { verdict, unrecognised } = verdictForMethodNode(tm);
            total++;
            if (verdict === "passed") passed++;
            else if (verdict === "failed") failed++;
            else unknown++;
            methods.push({
              name: attr(tm, "name") ?? "(unnamed method)",
              className,
              verdict,
              ...(attr(tm, "executionTime") ? { executionTime: attr(tm, "executionTime") } : {}),
              ...(attr(tm, "unit") ? { unit: attr(tm, "unit") } : {}),
              alerts: parseAlerts(tm.alerts),
              unrecognised,
            });
          }
        }
        classes.push({
          name: className,
          ...(attr(tc, "riskLevel") ? { riskLevel: attr(tc, "riskLevel") } : {}),
          ...(attr(tc, "durationCategory")
            ? { durationCategory: attr(tc, "durationCategory") }
            : {}),
          methods,
        });
      }
    }
    programs.push({
      name: programName,
      ...(attr(prog, "type") ? { type: attr(prog, "type") } : {}),
      classes,
    });
  }

  // Outcome: "nothing ran" is settled before pass/fail arithmetic, so 0-of-0
  // can't fall through into `failed === 0 → passed`.
  if (total === 0) {
    const noTests = otherAlerts.find((a) => a.kind === NO_TEST_CLASSES_KIND);
    if (noTests) {
      return {
        outcome: "no-tests",
        programs,
        otherAlerts,
        total,
        passed,
        failed,
        unknown,
        reason:
          noTests.title ??
          "ADT reported kind=\"noTestClasses\": the object has no ABAP Unit test classes.",
      };
    }
    return {
      outcome: "unknown",
      programs,
      otherAlerts,
      total,
      passed,
      failed,
      unknown,
      reason:
        "The run result contained no test methods and no noTestClasses alert, so it is not " +
        "known whether anything ran. This is NOT a passing run.",
    };
  }

  if (failed > 0) {
    return { outcome: "failed", programs, otherAlerts, total, passed, failed, unknown };
  }
  if (unknown > 0) {
    return {
      outcome: "unknown",
      programs,
      otherAlerts,
      total,
      passed,
      failed,
      unknown,
      reason:
        `${unknown} of ${total} test method(s) carried XML this server does not recognise, so ` +
        "their verdict is unknown. Treat the run as UNVERIFIED, not as passing.",
    };
  }
  return { outcome: "passed", programs, otherAlerts, total, passed, failed, unknown };
}
