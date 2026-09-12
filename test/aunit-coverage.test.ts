/**
 * ABAP Unit coverage measurement — pinned against live-captured bytes.
 *
 * Every assertion about the REAL wire shape reads
 * `854-i75-cov-coveredobjects.xml`, `855-i75-cov-query-zcl-i75-probe.xml`
 * and `856-i75-cov-query-untouched.xml` (or their `.meta.json` request
 * bodies). Hand-written XML appears only for shapes nobody has captured, and
 * only to pin what this module does when it meets something new — the
 * answer must never be a guessed number.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCoverageQuery,
  buildCoveredObjectsScope,
  findCoverageNode,
  parseCoveredObjects,
  parseCoverageResult,
} from "../src/adt/aunit.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const read = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

const COVEREDOBJECTS_XML = read("854-i75-cov-coveredobjects.xml");
const COVEREDOBJECTS_META = JSON.parse(read("854-i75-cov-coveredobjects.meta.json")) as {
  requestBody: string;
};
const QUERY_XML = read("855-i75-cov-query-zcl-i75-probe.xml");
const QUERY_META = JSON.parse(read("855-i75-cov-query-zcl-i75-probe.meta.json")) as {
  requestBody: string;
};
const UNTOUCHED_XML = read("856-i75-cov-query-untouched.xml");

describe("buildCoveredObjectsScope / buildCoverageQuery", () => {
  it("reproduces the live-captured coveredobjects request byte for byte", () => {
    expect(buildCoveredObjectsScope()).toBe(COVEREDOBJECTS_META.requestBody);
  });

  it("reproduces the live-captured cov:query request byte for byte", () => {
    expect(buildCoverageQuery(["/sap/bc/adt/oo/classes/zcl_i75_probe"])).toBe(
      QUERY_META.requestBody,
    );
  });

  it("repeats one objectReference line per URI", () => {
    const built = buildCoverageQuery([
      "/sap/bc/adt/oo/classes/zcl_a",
      "/sap/bc/adt/oo/classes/zcl_b",
    ]);
    const lines = built
      .split("\n")
      .filter((l) => l.includes("<adtcore:objectReference "));
    expect(lines).toEqual([
      '        <adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_a"/>',
      '        <adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_b"/>',
    ]);
  });

  it("refuses an empty object list", () => {
    expect(() => buildCoverageQuery([])).toThrow(/at least one object URI/);
    try {
      buildCoverageQuery([]);
      throw new Error("expected buildCoverageQuery to throw");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("BAD_INPUT");
    }
  });

  it("escapes XML metacharacters in a URI", () => {
    const built = buildCoverageQuery(['/sap/bc/adt/x?a=1&b="<2>"']);
    expect(built).toContain(
      'adtcore:uri="/sap/bc/adt/x?a=1&amp;b=&quot;&lt;2&gt;&quot;"',
    );
  });
});

describe("parseCoveredObjects", () => {
  it("lists every object the live run touched", () => {
    const objects = parseCoveredObjects(COVEREDOBJECTS_XML);
    expect(objects).toHaveLength(16);
    expect(objects).toContainEqual({
      name: "ZCL_I75_PROBE",
      type: "CLAS/OC",
      uri: "/sap/bc/adt/oo/classes/zcl_i75_probe",
      packageName: "$TMP",
    });
    expect(objects.some((o) => o.name === "CL_ABAP_UNIT_ASSERT")).toBe(true);
  });

  it("reads an empty scope as an empty list, not an error", () => {
    expect(
      parseCoveredObjects('<?xml version="1.0"?><cov:scope xmlns:cov="http://www.sap.com/adt/cov"/>'),
    ).toEqual([]);
  });

  it("refuses a body that is not a cov:scope", () => {
    expect(() =>
      parseCoveredObjects('<?xml version="1.0"?><exc:exception xmlns:exc="x"/>'),
    ).toThrow(/no <cov:scope>/);
    expect(() => parseCoveredObjects("")).toThrow(/cov:scope/);
  });
});

describe("parseCoverageResult", () => {
  it("reads per-class and per-method statement, branch and procedure coverage", () => {
    const result = parseCoverageResult(QUERY_XML);
    expect(result.measured).toBe(true);

    const classNode = findCoverageNode(result, "ZCL_I75_PROBE");
    expect(classNode?.statement).toEqual({ total: 8, executed: 5 });
    expect(classNode?.branch).toEqual({ total: 5, executed: 3 });
    expect(classNode?.procedure).toEqual({ total: 3, executed: 2 });

    const double = findCoverageNode(result, "DOUBLE");
    expect(double?.statement).toEqual({ total: 2, executed: 2 });

    const triple = findCoverageNode(result, "TRIPLE");
    expect(triple?.statement).toEqual({ total: 4, executed: 3 });
    expect(triple?.branch).toEqual({ total: 3, executed: 2 });

    const neverCalled = findCoverageNode(result, "NEVER_CALLED");
    expect(neverCalled?.statement).toEqual({ total: 2, executed: 0 });
    expect(neverCalled?.procedure).toEqual({ total: 1, executed: 0 });
  });

  it("keeps the Class-Pool wrapper and the class node apart", () => {
    const result = parseCoverageResult(QUERY_XML);
    expect(result.nodes).toHaveLength(1);
    const wrapper = result.nodes[0];
    expect(wrapper.name).toBe("ZCL_I75_PROBE (Class-Pool)");
    expect(wrapper.children).toHaveLength(1);

    const classNode = wrapper.children[0];
    expect(classNode.name).toBe("ZCL_I75_PROBE");
    expect(classNode.children).toHaveLength(3);
    expect(classNode.children.map((c) => c.name).sort()).toEqual([
      "DOUBLE",
      "NEVER_CALLED",
      "TRIPLE",
    ]);
  });

  it("reports an unmeasured object as unmeasured, not as zero coverage", () => {
    // The trap a renderer must not fall into: this 200 response has a
    // zero <summary> and NO <nodes> element at all — it is silence about the
    // object, not proof it has 0% coverage.
    const result = parseCoverageResult(UNTOUCHED_XML);
    expect(result.measured).toBe(false);
    expect(result.nodes).toEqual([]);
  });

  it("names an unknown coverage type instead of dropping it", () => {
    const xml =
      '<?xml version="1.0"?><cov:result name="ADT_ROOT_NODE" xmlns:cov="http://www.sap.com/adt/cov">' +
      '<nodes><node>' +
      '<adtcore:objectReference adtcore:uri="/x" adtcore:type="CLAS/OC" adtcore:name="X" xmlns:adtcore="http://www.sap.com/adt/core"/>' +
      '<coverages><coverage type="condition" total="4" executed="1"/></coverages>' +
      "</node></nodes></cov:result>";
    const result = parseCoverageResult(xml);
    const node = result.nodes[0];
    expect(node.unrecognised).toContain("condition");
    expect(node.statement).toBeUndefined();
    expect(node.branch).toBeUndefined();
    expect(node.procedure).toBeUndefined();
  });

  it("refuses to coerce an unparseable count to zero", () => {
    const xml =
      '<?xml version="1.0"?><cov:result name="ADT_ROOT_NODE" xmlns:cov="http://www.sap.com/adt/cov">' +
      '<nodes><node>' +
      '<adtcore:objectReference adtcore:uri="/x" adtcore:type="CLAS/OC" adtcore:name="X" xmlns:adtcore="http://www.sap.com/adt/core"/>' +
      '<coverages><coverage type="statement" total="abc" executed="1"/></coverages>' +
      "</node></nodes></cov:result>";
    const result = parseCoverageResult(xml);
    const node = result.nodes[0];
    expect(node.statement).toBeUndefined();
    expect(node.unrecognised.some((u) => u.includes("statement") && u.includes("total"))).toBe(
      true,
    );
  });

  it("refuses a body that is not a cov:result", () => {
    expect(() =>
      parseCoverageResult('<?xml version="1.0"?><exc:exception xmlns:exc="x"/>'),
    ).toThrow(/no <cov:result>/);
    expect(() => parseCoverageResult("")).toThrow(/cov:result/);
  });
});

describe("findCoverageNode", () => {
  const result = parseCoverageResult(QUERY_XML);

  it("finds ZCL_I75_PROBE, preferring the class node over the Class-Pool wrapper", () => {
    const node = findCoverageNode(result, "ZCL_I75_PROBE");
    expect(node?.name).toBe("ZCL_I75_PROBE");
    expect(node?.children).toHaveLength(3);
  });

  it("finds NEVER_CALLED nested two levels down", () => {
    const node = findCoverageNode(result, "NEVER_CALLED");
    expect(node?.name).toBe("NEVER_CALLED");
    expect(node?.statement).toEqual({ total: 2, executed: 0 });
  });

  it("returns undefined for a name that is not there", () => {
    expect(findCoverageNode(result, "NOPE_NOT_HERE")).toBeUndefined();
  });
});
