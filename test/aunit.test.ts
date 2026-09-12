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

const ALLPASS_XML = read("852-i75-ut-testrun-allpass.xml");
const ALLPASS_META = JSON.parse(read("852-i75-ut-testrun-allpass.meta.json")) as {
  requestBody: string;
};
const COVERAGE_XML = read("853-i75-ut-testrun-coverage.xml");
const COVERAGE_META = JSON.parse(read("853-i75-ut-testrun-coverage.meta.json")) as {
  requestBody: string;
};
const RISK_EXCEEDED_XML = read("857-i75-ut-testrun-risk-exceeded.xml");

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

describe("coverage flag on the run configuration", () => {
  it("keeps the captured coverage-off body byte for byte", () => {
    const built = buildRunConfiguration("/sap/bc/adt/oo/classes/zcl_i75_probe", "harmless");
    expect(built).toBe(ALLPASS_META.requestBody);
  });

  it("flips only the coverage attribute when coverage is asked for", () => {
    const built = buildRunConfiguration("/sap/bc/adt/oo/classes/zcl_i75_probe", "harmless", {
      coverage: true,
    });
    expect(built).toBe(COVERAGE_META.requestBody);

    // The two captured bodies differ in exactly one place.
    expect(ALLPASS_META.requestBody.replace('active="false"', 'active="true"')).toBe(
      COVERAGE_META.requestBody,
    );
  });
});

describe("all-passed run, live-captured", () => {
  // The FIRST all-passed ABAP Unit result ever captured from a real system —
  // until #75, the passing outcome was only ever exercised by editing a
  // captured FAILURE (stripping `<alerts>` out of capture 382). This fixture
  // is the genuine wire shape ADT sends when nothing failed.
  const res = parseRunResult(ALLPASS_XML);

  it("reports outcome passed with both methods graded from real bytes", () => {
    expect(res.outcome).toBe("passed");
    expect(res.total).toBe(2);
    expect(res.passed).toBe(2);
    expect(res.failed).toBe(0);
    expect(res.unknown).toBe(0);
    expect(res.reason).toBeUndefined();

    const methods = res.programs[0].classes[0].methods;
    expect(methods.map((m) => m.name)).toEqual(["DOUBLES_A_POSITIVE", "TRIPLES_A_POSITIVE"]);
    expect(methods.every((m) => m.verdict === "passed")).toBe(true);
    expect(res.programs[0].classes[0].name).toBe("LTCL_PROBE");
    expect(res.programs[0].classes[0].riskLevel).toBe("harmless");
  });

  it("carries no coverage URI when the run did not ask for one", () => {
    expect(res.coverageUri).toBeUndefined();
  });
});

describe("coverage measurement reference", () => {
  it("extracts the measurement URI from <external><coverage>", () => {
    const res = parseRunResult(COVERAGE_XML);
    expect(res.coverageUri).toBe(
      "/sap/bc/adt/runtime/traces/coverage/measurements/466F46C806601FE1ABD81597C42FC069",
    );
  });

  it("leaves the verdicts and counts exactly as the coverage-off run", () => {
    const off = parseRunResult(ALLPASS_XML);
    const on = parseRunResult(COVERAGE_XML);
    const pick = (r: typeof off) => ({
      outcome: r.outcome,
      total: r.total,
      passed: r.passed,
      failed: r.failed,
      unknown: r.unknown,
    });
    expect(pick(on)).toEqual(pick(off));
  });

  it("ignores a coverage URI that is not a measurement resource", () => {
    const xml =
      '<?xml version="1.0"?><aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit">' +
      '<external><coverage adtcore:uri="/sap/bc/adt/somewhere/else" xmlns:adtcore="http://www.sap.com/adt/core"/></external>' +
      "</aunit:runResult>";
    const res = parseRunResult(xml);
    expect(res.coverageUri).toBeUndefined();
  });
});

describe("risk level exceeded — live-captured", () => {
  // Class source captured: `CLASS ltcl_norisk DEFINITION FOR TESTING.` — no
  // RISK LEVEL, no DURATION. It activates fine, but a test class with no
  // declared risk level defaults to a risk that exceeds this run's
  // `harmless` ceiling, so ADT runs none of its methods and reports a
  // run-level `tolerable` warning instead of a `<testMethods>` list.
  // Captured against ZCL_I75_PROBE in $TMP on A4H, 2026-09-12
  // (857-i75-ut-testrun-risk-exceeded.xml / .meta.json).
  //
  // This is the first LIVE evidence for `parseRunResult`'s "no test methods
  // and no noTestClasses alert" branch of the `unknown` outcome — previously
  // exercised only by hand-edited hypothetical XML (see
  // "reports unknown when a run result has neither methods nor a
  // noTestClasses alert" above). It says nothing about the OTHER `unknown`
  // path — test methods that are present but whose XML the parser cannot
  // grade (`unknown > 0`, covered by "counts ungraded methods separately and
  // refuses to call the run passed" above) — which remains hand-written and
  // still hypothetical.
  const res = parseRunResult(RISK_EXCEEDED_XML);

  it("reports unknown — neither passed nor no-tests", () => {
    // A class whose tests were skipped for exceeding the risk limit is not
    // the same answer as a class that has no test classes at all.
    expect(res.outcome).toBe("unknown");
    expect(res.outcome).not.toBe("passed");
    expect(res.outcome).not.toBe("no-tests");
  });

  it("tallies zero on every count", () => {
    expect(res.total).toBe(0);
    expect(res.passed).toBe(0);
    expect(res.failed).toBe(0);
    expect(res.unknown).toBe(0);
  });

  it("names this as not a passing run", () => {
    expect(res.reason).toBe(
      "The run result contained no test methods and no noTestClasses alert, so it is not " +
        "known whether anything ran. This is NOT a passing run.",
    );
  });

  it("keeps the tolerable alert, attributed to the test class scope", () => {
    // `<alerts>` sits directly under `<testClass>`, not under a method or the
    // run, so `parseRunResult` attributes it with scope
    // `test class LTCL_NORISK` — read from the actual attribution code, not
    // assumed.
    expect(res.otherAlerts).toHaveLength(1);
    const alert = res.otherAlerts[0];
    expect(alert.kind).toBe("warning");
    expect(alert.severity).toBe("tolerable");
    expect(alert.title).toBe("No execution, risk level of test class exceeds upper limit");
    expect(alert.scope).toBe("test class LTCL_NORISK");
  });

  it("carries no coverage URI", () => {
    expect(res.coverageUri).toBeUndefined();
  });
});
