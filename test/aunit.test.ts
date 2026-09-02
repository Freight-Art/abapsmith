/**
 * ABAP Unit runner — pinned against live-captured bytes.
 *
 * Capture 382 = a run with one passing and one failing method.
 * Capture 361 = a run against a class with no test classes.
 *
 * Every assertion about the REAL wire shape reads those files; none of it is
 * hand-written "what ADT probably sends". Hand-written XML appears only in the
 * discriminator tests below, and only for HYPOTHETICAL shapes that nobody has
 * captured — which is the point of those tests: they pin what this module does
 * when it meets something it has never seen, and the answer must never be
 * "call it a pass".
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildRunConfiguration,
  includeNameFromUri,
  parseRunResult,
  SEVERITY_FAILS,
  SEVERITY_PASSES,
  verdictForMethodNode,
} from "../src/adt/aunit.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const read = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

const FAILURE_XML = read("382-ut-testrun.xml");
const NO_TESTS_XML = read("361-ut-testrun.xml");
const FAILURE_META = JSON.parse(read("382-ut-testrun.meta.json")) as {
  requestBody: string;
  responseStatus: number;
};

describe("buildRunConfiguration", () => {
  it("reproduces the live-captured request body byte for byte", () => {
    // The capture ran with all three risk levels enabled, i.e. `critical`.
    const built = buildRunConfiguration(
      "/sap/bc/adt/oo/classes/zcl_zmcp_ut_probe",
      "critical",
    );
    expect(built).toBe(FAILURE_META.requestBody);
  });

  it("narrows only the risk-level attributes, and only downwards", () => {
    const uri = "/sap/bc/adt/oo/classes/zcl_zmcp_ut_probe";
    const harmless = buildRunConfiguration(uri, "harmless");
    expect(harmless).toContain(
      '<testRiskLevels harmless="true" dangerous="false" critical="false"/>',
    );
    expect(buildRunConfiguration(uri, "dangerous")).toContain(
      '<testRiskLevels harmless="true" dangerous="true" critical="false"/>',
    );
    // Duration is about how long a test runs, not what it touches: it must stay
    // exactly as captured rather than being narrowed on a guess.
    expect(harmless).toContain('<testDurations short="true" medium="true" long="true"/>');
    // Everything except the risk line is identical to the capture.
    const strip = (s: string): string => s.replace(/ *<testRiskLevels[^>]*\/>\n/, "");
    expect(strip(harmless)).toBe(strip(FAILURE_META.requestBody));
  });

  it("defaults to harmless", () => {
    const uri = "/sap/bc/adt/oo/classes/zcl_x";
    expect(buildRunConfiguration(uri)).toBe(buildRunConfiguration(uri, "harmless"));
  });

  it("escapes the object URI into the attribute", () => {
    expect(buildRunConfiguration("/sap/bc/adt/x?a=1&b=2")).toContain(
      'adtcore:uri="/sap/bc/adt/x?a=1&amp;b=2"',
    );
  });
});

describe("parseRunResult — capture 382 (one pass, one failure)", () => {
  const res = parseRunResult(FAILURE_XML);

  it("grades the run as failed with an exact per-method tally", () => {
    expect(res.outcome).toBe("failed");
    expect(res.total).toBe(2);
    expect(res.passed).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.unknown).toBe(0);
  });

  it("identifies which method passed and which failed", () => {
    const methods = res.programs[0].classes[0].methods;
    expect(methods.map((m) => [m.name, m.verdict])).toEqual([
      ["TEST_FAILS", "failed"],
      ["TEST_PASSES", "passed"],
    ]);
    expect(res.programs[0].name).toBe("ZCL_ZMCP_UT_PROBE");
    expect(res.programs[0].classes[0].name).toBe("LTCL_PROBE");
    expect(res.programs[0].classes[0].riskLevel).toBe("harmless");
  });

  it("surfaces the assertion detail including the expected/actual pair", () => {
    const alert = res.programs[0].classes[0].methods[0].alerts[0];
    expect(alert.kind).toBe("failedAssertion");
    expect(alert.severity).toBe("critical");
    expect(alert.title).toContain("deliberate failure to capture the failure envelope");
    // Nested <details> are flattened depth-first and indented by depth.
    expect(alert.details).toContain("Different Values:");
    expect(alert.details).toContain("  Expected [43] Actual [42]");
  });

  it("reports the failure line as a real 1-based number, not a URI", () => {
    const entry = res.programs[0].classes[0].methods[0].alerts[0].stack[0];
    expect(entry.line).toBe(17);
    expect(entry.col).toBe(0);
  });

  it("names the include the line belongs to, because it is NOT the main source", () => {
    // `#start=17,0` indexes the testclasses include. Reporting a bare "line 17"
    // would send the reader to line 17 of the class, a different file.
    const entry = res.programs[0].classes[0].methods[0].alerts[0].stack[0];
    expect(entry.includeName).toBe("testclasses");
    expect(entry.uri).toContain("/includes/testclasses");
  });
});

describe("parseRunResult — capture 361 (no test classes)", () => {
  const res = parseRunResult(NO_TESTS_XML);

  it("reports no-tests, which is NOT a pass", () => {
    expect(res.outcome).toBe("no-tests");
    expect(res.outcome).not.toBe("passed");
    expect(res.total).toBe(0);
    expect(res.passed).toBe(0);
    expect(res.failed).toBe(0);
  });

  it("carries the server's own explanation", () => {
    expect(res.otherAlerts[0].kind).toBe("noTestClasses");
    expect(res.otherAlerts[0].severity).toBe("tolerable");
    expect(res.reason).toBe("The task definition does not refer to any test");
  });

  it("has no <program> element at all — the alert sits directly under runResult", () => {
    // Structural fact from the capture: a no-tests run does not merely have an
    // empty program list, it has no program element whatsoever.
    expect(res.programs).toEqual([]);
    expect(NO_TESTS_XML).not.toContain("<program");
  });

  it("is distinguishable from a genuinely all-passing run", () => {
    // The two must never collapse into one answer. A run where everything
    // passed reports `passed` with a non-zero total; a run where nothing ran
    // reports `no-tests` with a zero total.
    const passing = parseRunResult(
      FAILURE_XML.replace(/<alerts>.*?<\/alerts>/s, ""),
    );
    expect(passing.outcome).toBe("passed");
    expect(passing.total).toBe(2);
    expect(passing.passed).toBe(2);

    expect(res.outcome).toBe("no-tests");
    expect(res.total).toBe(0);
    // Same failure count, completely different meaning.
    expect(passing.failed).toBe(res.failed);
    expect(passing.outcome).not.toBe(res.outcome);
  });

  it("does not report no-tests as passed even though zero tests failed", () => {
    expect(res.failed).toBe(0);
    expect(res.outcome).not.toBe("passed");
    expect(res.reason).toBeTruthy();
  });
});

/**
 * The verdict rule itself. `SEVERITY_PASSES` is empty by design — no severity
 * has ever been observed coexisting with a passing method — so anything graded
 * with a severity this module has not seen must land on `unknown`, never on
 * `passed`.
 */
describe("verdictForMethodNode — severity is the axis, absence is not", () => {
  // Shapes as fast-xml-parser produces them, `@_` prefix for attributes.
  const bare = { "@_name": "T", "@_type": "CLAS/OLI", "@_executionTime": "0", "@_unit": "s" };
  const withAlert = (severity?: string, kind = "failedAssertion"): unknown => ({
    ...bare,
    alerts: {
      alert: {
        ...(severity !== undefined ? { "@_severity": severity } : {}),
        "@_kind": kind,
        title: "x",
      },
    },
  });

  it("declares critical a failure and treats no severity as trusted-passing", () => {
    expect(SEVERITY_FAILS.has("critical")).toBe(true);
    // If this ever becomes non-empty, a capture must justify each member.
    expect([...SEVERITY_PASSES]).toEqual([]);
  });

  it("passes a bare test method", () => {
    expect(verdictForMethodNode(bare).verdict).toBe("passed");
  });

  it("fails a method carrying a critical alert", () => {
    expect(verdictForMethodNode(withAlert("critical")).verdict).toBe("failed");
  });

  it("does NOT pass a method whose alert severity has never been observed", () => {
    // The exact hole an absence-based rule would leave open: an
    // exception-raising or warning-severity method must not read as green.
    for (const severity of ["tolerable", "warning", "fatal", ""]) {
      const v = verdictForMethodNode(withAlert(severity, "exception"));
      expect(v.verdict).toBe("unknown");
      expect(v.verdict).not.toBe("passed");
    }
  });

  it("does NOT pass an alert with no severity attribute at all", () => {
    const v = verdictForMethodNode(withAlert(undefined));
    expect(v.verdict).toBe("unknown");
    expect(v.unrecognised).toContain("alert with no @severity");
  });

  it("fails as soon as ANY alert is critical, whatever the others say", () => {
    const mixed = {
      ...bare,
      alerts: {
        alert: [
          { "@_severity": "tolerable", "@_kind": "warning", title: "a" },
          { "@_severity": "critical", "@_kind": "failedAssertion", title: "b" },
        ],
      },
    };
    expect(verdictForMethodNode(mixed).verdict).toBe("failed");
  });

  it("does NOT pass a method carrying an unrecognised child element", () => {
    const v = verdictForMethodNode({ ...bare, verdictSummary: { "@_state": "ok" } });
    expect(v.verdict).toBe("unknown");
    expect(v.unrecognised).toContain("<verdictSummary>");
  });

  it("does NOT pass a method carrying an unrecognised attribute", () => {
    // The shape shift that would defeat a children-only guard: the verdict
    // moves into an attribute and the element stays childless.
    const v = verdictForMethodNode({ ...bare, "@_failed": "X" });
    expect(v.verdict).toBe("unknown");
    expect(v.unrecognised).toContain("@failed");
  });

  it("does NOT pass a method with stray text content", () => {
    const v = verdictForMethodNode({ ...bare, "#text": "something" });
    expect(v.verdict).toBe("unknown");
    expect(v.unrecognised).toContain("text content");
  });

  it("counts ungraded methods separately and refuses to call the run passed", () => {
    // An unrecognised attribute on the PASSING method of the real capture.
    const mutated = FAILURE_XML.replace('adtcore:name="TEST_PASSES"', 'adtcore:name="TEST_PASSES" verdict="green"');
    const res = parseRunResult(mutated);
    expect(res.unknown).toBe(1);
    expect(res.passed).toBe(0);
    // A failure still dominates, but the ungraded method is not hidden.
    expect(res.outcome).toBe("failed");
    expect(res.total).toBe(2);
  });

  it("reports a run as unknown when nothing failed but something was ungraded", () => {
    const noFailure = FAILURE_XML.replace(/<alerts>.*?<\/alerts>/s, "").replace(
      'adtcore:name="TEST_PASSES"',
      'adtcore:name="TEST_PASSES" verdict="green"',
    );
    const res = parseRunResult(noFailure);
    expect(res.failed).toBe(0);
    expect(res.unknown).toBe(1);
    expect(res.outcome).toBe("unknown");
    expect(res.outcome).not.toBe("passed");
    expect(res.reason).toMatch(/UNVERIFIED|not as passing/i);
  });
});

describe("includeNameFromUri", () => {
  it("extracts the include from a stack-entry URI", () => {
    expect(
      includeNameFromUri("/sap/bc/adt/oo/classes/zcl_x/includes/testclasses#start=17,0"),
    ).toBe("testclasses");
    expect(includeNameFromUri("/sap/bc/adt/oo/classes/zcl_x/includes/definitions")).toBe(
      "definitions",
    );
  });

  it("returns undefined when the URI names no include", () => {
    expect(includeNameFromUri("/sap/bc/adt/oo/classes/zcl_x#start=3,0")).toBeUndefined();
    expect(includeNameFromUri(undefined)).toBeUndefined();
  });
});

describe("parseRunResult — malformed bodies are never silently a pass", () => {
  it("throws when the body carries no runResult element", () => {
    expect(() => parseRunResult('<?xml version="1.0"?><exc:exception xmlns:exc="x"/>')).toThrow(
      /no <aunit:runResult>/,
    );
  });

  it("throws on an empty body rather than reporting zero failures", () => {
    expect(() => parseRunResult("")).toThrow(/runResult/);
  });

  it("reports unknown when a run result has neither methods nor a noTestClasses alert", () => {
    const res = parseRunResult(
      '<?xml version="1.0"?><aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit"/>',
    );
    expect(res.outcome).toBe("unknown");
    expect(res.outcome).not.toBe("passed");
    expect(res.reason).toMatch(/NOT a passing run/);
  });
});
