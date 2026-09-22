/**
 * Issue #148 item 3: `abap_search mode=source` groups hits per object —
 * object header once, `line: text` rows under it, a per-object hit cap
 * with the remainder as a count, and the NOTE block once at the top rather
 * than anything repeated per hit. Pure rendering tests over hand-built
 * `SourceScanResult`s (no network).
 */
import { describe, expect, it } from "vitest";
import {
  buildSourceResponse,
  groupSourceHits,
  renderGroupedHits,
  SOURCE_PER_OBJECT_HIT_CAP,
} from "../src/tools/search.js";
import { SOURCE_SCAN_OBJECT_CEILING, type SourceScanHit, type SourceScanQuery, type SourceScanResult } from "../src/adt/source-scan.js";

function query(overrides: Partial<SourceScanQuery> = {}): SourceScanQuery {
  return {
    query: "lv_foo",
    regex: false,
    caseSensitive: false,
    includeComments: false,
    packages: ["ZTEST"],
    includeSubpackages: false,
    objects: undefined,
    types: [],
    maxHits: 100,
    maxObjects: SOURCE_SCAN_OBJECT_CEILING,
    ...overrides,
  };
}

function result(hits: SourceScanHit[], truncated: "" | "hits" | "objects" = ""): SourceScanResult {
  return {
    sid: "TST",
    hits,
    summary: { objectsTotal: 3, objectsScanned: 3, includesScanned: 5, includesSkipped: 0, hits: hits.length, truncated },
    ms: 5,
    truncated: truncated !== "",
  };
}

const hit = (objType: string, objName: string, include: string, line: number, text: string): SourceScanHit => ({
  objType,
  objName,
  include,
  line,
  text,
});

describe("groupSourceHits", () => {
  it("groups by object in first-seen order, keeping every hit", () => {
    const groups = groupSourceHits([
      hit("PROG", "ZB", "ZB", 5, "b1"),
      hit("PROG", "ZA", "ZA", 1, "a1"),
      hit("PROG", "ZB", "ZB", 9, "b2"),
    ]);
    expect(groups.map((g) => g.objName)).toEqual(["ZB", "ZA"]);
    expect(groups[0]!.hits.map((h) => h.line)).toEqual([5, 9]);
  });
});

describe("renderGroupedHits", () => {
  it("prints the object header once and `line: text` rows under it", () => {
    const text = renderGroupedHits(groupSourceHits([hit("PROG", "ZFOO", "ZFOO", 12, "DATA: lv_foo TYPE string."), hit("PROG", "ZFOO", "ZFOO", 40, "lv_foo = 1.")]));
    expect(text.split("\n")).toEqual(["PROG ZFOO  (2 hits)", "  12: DATA: lv_foo TYPE string.", "  40: lv_foo = 1."]);
    expect(text.match(/ZFOO/g)).toHaveLength(1);
  });

  it("names the include as a sub-header only when hits live in includes other than the object's own", () => {
    const text = renderGroupedHits(
      groupSourceHits([
        hit("CLAS", "ZCL_FOO", "ZCL_FOO===========CM001", 3, "lv_foo = 1."),
        hit("CLAS", "ZCL_FOO", "ZCL_FOO===========CM001", 8, "lv_foo = 2."),
        hit("CLAS", "ZCL_FOO", "ZCL_FOO===========CCIMP", 2, "DATA lv_foo."),
      ]),
    );
    expect(text.split("\n")).toEqual([
      "CLAS ZCL_FOO  (3 hits)",
      "  include ZCL_FOO===========CM001",
      "    3: lv_foo = 1.",
      "    8: lv_foo = 2.",
      "  include ZCL_FOO===========CCIMP",
      "    2: DATA lv_foo.",
    ]);
  });

  it("caps hits per object and states the remainder as a count", () => {
    const many = Array.from({ length: SOURCE_PER_OBJECT_HIT_CAP + 15 }, (_, i) => hit("PROG", "ZNOISY", "ZNOISY", i + 1, `lv_foo ${i}`));
    const text = renderGroupedHits(groupSourceHits([...many, hit("PROG", "ZQUIET", "ZQUIET", 7, "lv_foo")]));
    expect(text).toContain(`PROG ZNOISY  (${SOURCE_PER_OBJECT_HIT_CAP + 15} hits, ${SOURCE_PER_OBJECT_HIT_CAP} shown)`);
    expect(text).toContain(`  ${SOURCE_PER_OBJECT_HIT_CAP}: lv_foo ${SOURCE_PER_OBJECT_HIT_CAP - 1}`);
    expect(text).not.toContain(`  ${SOURCE_PER_OBJECT_HIT_CAP + 1}: lv_foo`);
    expect(text).toContain(`... 15 more hit(s) in ZNOISY not shown (per-object cap ${SOURCE_PER_OBJECT_HIT_CAP}`);
    expect(text).toContain('objects="ZNOISY"');
    // The quiet object still gets its row — the noisy one no longer crowds it out.
    expect(text).toContain("PROG ZQUIET  (1 hit)\n  7: lv_foo");
  });
});

describe("buildSourceResponse (mode=source) with grouped hits", () => {
  it("emits every NOTE once at the top, independent of the hit count", () => {
    const one = buildSourceResponse(query(), result([hit("PROG", "ZFOO", "ZFOO", 1, "lv_foo")]), 47_100).text;
    const many = buildSourceResponse(
      query(),
      result(Array.from({ length: 30 }, (_, i) => hit("PROG", `Z${i}`, `Z${i}`, i + 1, "lv_foo"))),
      47_100,
    ).text;
    const notes = (t: string) => t.split("\n").filter((l) => l.startsWith("NOTE: ")).length;
    expect(notes(one)).toBeGreaterThan(0);
    expect(notes(many)).toBe(notes(one));
    // Notes precede the body.
    expect(many.indexOf("NOTE: ")).toBeLessThan(many.indexOf("--- MATCHES ---"));
    expect(many).toMatch(/^objectsWithHits: 30$/m);
  });

  it("keeps the TRUNCATED disclosure after the grouped rows", () => {
    const r = buildSourceResponse(query({ maxHits: 1 }), result([hit("PROG", "ZFOO", "ZFOO", 1, "lv_foo")], "hits"), 47_100);
    expect(r.text).toContain("PROG ZFOO  (1 hit)\n  1: lv_foo\n--- TRUNCATED --- the hit cap (max=1)");
  });

  it("states its own size", () => {
    const r = buildSourceResponse(query(), result([hit("PROG", "ZFOO", "ZFOO", 1, "lv_foo")]), 47_100);
    expect(r.text).toMatch(/^size: \d+ chars, \d+ lines, truncated=false$/m);
    expect(r.size).toEqual({ chars: r.text.length, lines: r.text.split("\n").length, truncated: false });
  });
});
