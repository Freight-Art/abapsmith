/**
 * `abap_test`'s opt-in coverage report (issue #75).
 *
 * The transport is the house fake used by `test/atc.test.ts` and
 * `test/dumps.test.ts`: a plain object cast through `unknown`, dispatching by
 * URL. `resolveObject` is stubbed the same way `test/run-enhancement-kind-
 * check.test.ts` stubs it, so these tests never depend on the real search
 * round trip.
 *
 * Fixtures are the live-captured bytes from `test/fixtures/live-captured/`:
 *
 *   852 — a plain (no coverage) all-pass run result
 *   853 — the same run, but with `<external><coverage uri="…"/></external>`
 *   854 — the `coveredobjects` roster the run touched (16 objects)
 *   855 — a `cov:query` for ZCL_I75_PROBE: per-class/per-method numbers
 *   856 — a `cov:query` for an object the run never touched: 200, zero
 *         `<summary>`, no `<nodes>` — this is the shape that must never be
 *         reported as "0%".
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import { SafetyGate } from "../src/safety.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const read = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

const ALLPASS_XML = read("852-i75-ut-testrun-allpass.xml");
const COVERAGE_RUN_XML = read("853-i75-ut-testrun-coverage.xml");
const COVERED_OBJECTS_XML = read("854-i75-cov-coveredobjects.xml");
const PROBE_QUERY_XML = read("855-i75-cov-query-zcl-i75-probe.xml");
const UNTOUCHED_QUERY_XML = read("856-i75-cov-query-untouched.xml");

const MEASUREMENT_URI = "/sap/bc/adt/runtime/traces/coverage/measurements/466F46C806601FE1ABD81597C42FC069";

// ---------------------------------------------------------------------------
// `resolveObject` stub — same pattern as test/run-enhancement-kind-check.test.ts
// ---------------------------------------------------------------------------

const stub = { object: {} as ResolvedObject };

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => stub.object,
}));

const { abapTest } = await import("../src/tools/test.js");

function resolved(over: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "CLAS/OC",
    kind: "CLAS",
    label: "Class",
    name: "ZCL_I75_PROBE",
    uri: "/sap/bc/adt/oo/classes/zcl_i75_probe",
    packageName: "$TMP",
    mode: "source",
    activation: "unknown",
    spec: {},
    ...over,
  } as unknown as ResolvedObject;
}

// ---------------------------------------------------------------------------
// Fake transport — dispatches by URL, same idiom as test/atc.test.ts
// ---------------------------------------------------------------------------

interface Call {
  url: string;
  headers: Record<string, string>;
  body?: string;
}

type Reply = { body: string; status?: number } | { throws: unknown };
type Handler = (url: string, body: string | undefined) => Reply;

function fakeConn(handler: Handler): { conn: AbapConnection; calls: Call[] } {
  const calls: Call[] = [];
  const post = async (
    url: string,
    opts: { headers?: Record<string, string>; body?: string } = {},
  ) => {
    calls.push({
      url,
      headers: opts.headers ?? {},
      ...(opts.body === undefined ? {} : { body: opts.body }),
    });
    const reply = handler(url, opts.body);
    if ("throws" in reply) throw reply.throws;
    return { body: reply.body, status: reply.status ?? 200, headers: {} };
  };
  const conn = {
    cfg: { sid: "A4H" },
    post,
  } as unknown as AbapConnection;
  return { conn, calls };
}

/** Handler for the default happy path: run → coveredobjects → probe query. */
function coverageHandler(opts: {
  runXml?: string;
  coveredObjectsXml?: string;
  queryXml?: string;
  queryThrows?: unknown;
} = {}): Handler {
  const runXml = opts.runXml ?? COVERAGE_RUN_XML;
  const coveredObjectsXml = opts.coveredObjectsXml ?? COVERED_OBJECTS_XML;
  return (url) => {
    if (url === "/sap/bc/adt/abapunit/testruns") return { body: runXml };
    if (url === `${MEASUREMENT_URI}/coveredobjects`) return { body: coveredObjectsXml };
    if (url === MEASUREMENT_URI) {
      if (opts.queryThrows !== undefined) return { throws: opts.queryThrows };
      return { body: opts.queryXml ?? PROBE_QUERY_XML };
    }
    throw new Error(`unscripted request: ${url}`);
  };
}

function gate(): SafetyGate {
  return new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
}

// ------------------------------------------------------------------- tests ---

describe("abap_test coverage", () => {
  it("runs without coverage by default and sends coverage active=false", async () => {
    const { conn, calls } = fakeConn(() => ({ body: ALLPASS_XML }));
    stub.object = resolved();
    const res = await abapTest(conn, { object: "ZCL_I75_PROBE" }, 50_000, gate());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toContain('<coverage active="false"/>');
    expect(res.text).toContain("outcome: PASSED");
    expect(res.text).not.toContain("COVERAGE");
  });

  it("asks for coverage and reports per-class and per-method percentages from live-captured bytes", async () => {
    const { conn, calls } = fakeConn(coverageHandler());
    stub.object = resolved();
    const res = await abapTest(
      conn,
      { object: "ZCL_I75_PROBE", coverage: true },
      50_000,
      gate(),
    );
    expect(calls[0]?.body).toContain('<coverage active="true"/>');
    expect(res.text).toContain("COVERAGE");
    expect(res.text).toContain("ZCL_I75_PROBE");
    expect(res.text).toContain("statement 5/8 (63%)");
    expect(res.text).toMatch(/DOUBLE.*statement 2\/2 \(100%\)/);
  });

  it("names a method whose statements never ran", async () => {
    const { conn } = fakeConn(coverageHandler());
    stub.object = resolved();
    const res = await abapTest(
      conn,
      { object: "ZCL_I75_PROBE", coverage: true },
      50_000,
      gate(),
    );
    expect(res.text).toContain("UNCOVERED METHODS");
    expect(res.text).toContain("ZCL_I75_PROBE->NEVER_CALLED");
    expect(res.text).toContain("(0/2 statements)");
  });

  it("leaves the run outcome and counts untouched when coverage is on", async () => {
    const { conn: plainConn } = fakeConn(() => ({ body: ALLPASS_XML }));
    stub.object = resolved();
    const plain = await abapTest(plainConn, { object: "ZCL_I75_PROBE" }, 50_000, gate());

    const { conn: covConn } = fakeConn(coverageHandler());
    stub.object = resolved();
    const withCoverage = await abapTest(
      covConn,
      { object: "ZCL_I75_PROBE", coverage: true },
      50_000,
      gate(),
    );

    for (const res of [plain, withCoverage]) {
      expect(res.text).toContain("outcome: PASSED");
      expect(res.text).toContain("tests: 2");
      expect(res.text).toContain("passed: 2");
      expect(res.text).toContain("failed: 0");
    }
  });

  it("reports an unmeasured object as not measured, never as zero percent", async () => {
    const { conn } = fakeConn(coverageHandler({ queryXml: UNTOUCHED_QUERY_XML }));
    stub.object = resolved();
    const res = await abapTest(
      conn,
      { object: "ZCL_I75_PROBE", coverage: true },
      50_000,
      gate(),
    );
    expect(res.text).toContain("not measured by this run");
    expect(res.text).not.toContain("0%");
  });

  it("keeps the test result when the coverage query fails", async () => {
    const { conn } = fakeConn(
      coverageHandler({ queryThrows: new Error("connection reset mid-query") }),
    );
    stub.object = resolved();
    const res = await abapTest(
      conn,
      { object: "ZCL_I75_PROBE", coverage: true },
      50_000,
      gate(),
    );
    expect(res.text).toContain("outcome: PASSED");
    expect(res.text).toContain("passed: 2");
    expect(res.text).toContain("failed: 0");
    expect(res.text).toMatch(/NOTE:.*could not be retrieved.*connection reset mid-query/s);
  });

  it("reports a run that produced no measurement reference", async () => {
    const { conn } = fakeConn(() => ({ body: ALLPASS_XML }));
    stub.object = resolved();
    const res = await abapTest(
      conn,
      { object: "ZCL_I75_PROBE", coverage: true },
      50_000,
      gate(),
    );
    expect(res.text).toContain("outcome: PASSED");
    expect(res.text).not.toContain("COVERAGE\n");
    expect(res.text).toMatch(/NOTE:.*no measurement reference/);
  });

  it("refuses coverage_for without coverage", async () => {
    const { conn, calls } = fakeConn(() => {
      throw new Error("no request should have been made");
    });
    stub.object = resolved();
    const err = await abapTest(
      conn,
      { object: "ZCL_I75_PROBE", coverage_for: ["ZCL_I75_PROBE"] },
      50_000,
      gate(),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isAbapError(err)).toBe(true);
    const e = err as AbapError;
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toMatch(/coverage_for/);
    expect(e.message).toMatch(/coverage/);
    expect(calls).toHaveLength(0);
  });

  it("reports a coverage_for object the run never touched as untouched", async () => {
    const { conn } = fakeConn(coverageHandler());
    stub.object = resolved();
    const res = await abapTest(
      conn,
      { object: "ZCL_I75_PROBE", coverage: true, coverage_for: ["ZCL_NEVER_EXISTED"] },
      50_000,
      gate(),
    );
    expect(res.text).toContain("ZCL_NEVER_EXISTED  not touched by this run");
  });

  it("marks a capped-out object as not queried, never as not measured", async () => {
    // The roster (854) has 16 objects; naming 11 of them in `coverage_for`
    // pushes the 11th past COVERAGE_FOCUS_CAP (10). That 11th object was
    // never sent to ADT at all — abapsmith has no information about it,
    // which is a different and weaker claim than "queried and found
    // nothing" (the `not measured by this run` case covered above).
    const focus = [
      "CL_ABAP_BEHV_CONTRACTS",
      "CL_ABAP_INTFDESCR",
      "CL_ABAP_OBJECTDESCR",
      "CL_ABAP_SOFT_REFERENCE",
      "CL_ABAP_SWITCH",
      "CL_ABAP_TYPEDESCR",
      "CL_ABAP_UNIT_ASSERT",
      "CL_AUCV_TASK",
      "CL_AUNIT_CORE_RT_FACTORY",
      "CL_AUNIT_PROG_BYTE_CODE_SVC",
      "CL_AUNIT_TEST_CLASS",
    ];
    const { conn } = fakeConn(coverageHandler());
    stub.object = resolved();
    const res = await abapTest(
      conn,
      { object: "ZCL_I75_PROBE", coverage: true, coverage_for: focus },
      50_000,
      gate(),
    );
    expect(res.text).toContain(
      "CL_AUNIT_TEST_CLASS  not queried (coverage focus capped at 10 objects)",
    );
    expect(res.text).not.toMatch(/CL_AUNIT_TEST_CLASS\s+not measured by this run/);
  });

  it("marks a roster match with no object URI as not queried, and skips the query rather than throwing", async () => {
    // SYNTHETIC fixture, hand-built like the discriminator tests in
    // test/aunit.test.ts: no live capture has ever shown a `coveredObject`
    // whose `objectReference` omits `adtcore:uri`, but the parser accepts it
    // (uri is simply absent from the result), so abapsmith must handle it
    // without treating "no URI to query with" as "queried and unmeasured".
    const NO_URI_ROSTER_XML =
      '<?xml version="1.0" encoding="utf-8"?><cov:scope xmlns:cov="http://www.sap.com/adt/cov">' +
      "<cov:coveredObjects><cov:coveredObject isSelected=\"false\" isDefault=\"false\">" +
      '<adtcore:objectReference adtcore:type="CLAS/OC" adtcore:name="ZCL_NO_URI" ' +
      'adtcore:packageName="$TMP" xmlns:adtcore="http://www.sap.com/adt/core"/>' +
      "</cov:coveredObject></cov:coveredObjects></cov:scope>";

    const { conn, calls } = fakeConn(
      coverageHandler({ coveredObjectsXml: NO_URI_ROSTER_XML }),
    );
    stub.object = resolved();
    const res = await abapTest(
      conn,
      { object: "ZCL_I75_PROBE", coverage: true, coverage_for: ["ZCL_NO_URI"] },
      50_000,
      gate(),
    );
    expect(res.text).toContain(
      "ZCL_NO_URI  not queried (no object URI on the covered-objects roster)",
    );
    expect(res.text).not.toMatch(/ZCL_NO_URI\s+not measured by this run/);
    expect(res.text).toMatch(/NOTE:.*ZCL_NO_URI.*no URI/s);
    expect(calls.some((c) => c.url === MEASUREMENT_URI)).toBe(false);
  });

  it("lists the other objects the run touched and marks the truncation", async () => {
    // The roster (854) has 16 objects and the "ALSO TOUCHED" cap is 15, but
    // with only ZCL_I75_PROBE in focus (the default path) there are exactly
    // 15 others left — not enough to force truncation. Naming a
    // `coverage_for` object the roster never touched keeps the focus set
    // empty of roster matches, so all 16 objects fall into "also touched"
    // and the 15-cap must truncate.
    const { conn } = fakeConn(coverageHandler());
    stub.object = resolved();
    const res = await abapTest(
      conn,
      { object: "ZCL_I75_PROBE", coverage: true, coverage_for: ["ZCL_NEVER_EXISTED"] },
      50_000,
      gate(),
    );
    expect(res.text).toContain("ALSO TOUCHED");
    expect(res.text).toContain("truncated");
  });
});
