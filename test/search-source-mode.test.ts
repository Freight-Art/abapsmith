/**
 * Pure unit tests for `src/tools/search.ts`'s mode="source" query/response
 * builders: `buildSourceScanQuery` (input validation and mapping onto a
 * `SourceScanQuery`), `scanDispatchArgs` (the wire args `dispatch()` sees),
 * and `buildSourceResponse` (rendering a `SourceScanResult` into response
 * text). No network, no AbapConnection, no fluid runtime — every
 * `SourceScanResult` here is constructed by hand. Dispatch-level (fluid
 * refusal / end-to-end) tests live in test/search-source-dispatch.test.ts.
 */
import { describe, expect, it } from "vitest";
import { buildSourceScanQuery, buildSourceResponse, searchInputSchema, type SearchInput } from "../src/tools/search.js";
import {
  scanDispatchArgs,
  SOURCE_SCAN_OBJECT_CEILING,
  type SourceScanQuery,
  type SourceScanResult,
} from "../src/adt/source-scan.js";
import { AbapError } from "../src/adt/errors.js";

function input(overrides: Partial<SearchInput> = {}): SearchInput {
  return { query: "FOO", mode: "source", ...overrides } as SearchInput;
}

function expectBadInput(fn: () => unknown): AbapError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AbapError);
    const err = e as AbapError;
    expect(err.code).toBe("BAD_INPUT");
    return err;
  }
  throw new Error("expected buildSourceScanQuery to throw, but it did not");
}

describe("buildSourceScanQuery: rejects BAD_INPUT", () => {
  it("throws when `type` is supplied together with mode=source", () => {
    expectBadInput(() => buildSourceScanQuery(input({ type: "CLAS", packages: ["ZTEST"] })));
  });

  it("throws on an empty `query`", () => {
    expectBadInput(() => buildSourceScanQuery(input({ query: "", packages: ["ZTEST"] })));
  });

  it("throws on a whitespace-only `query`", () => {
    expectBadInput(() => buildSourceScanQuery(input({ query: "   ", packages: ["ZTEST"] })));
  });

  it("throws when `query` exceeds the 255-character maximum", () => {
    expectBadInput(() => buildSourceScanQuery(input({ query: "A".repeat(256), packages: ["ZTEST"] })));
  });

  it("accepts a `query` at exactly the 255-character maximum", () => {
    const q = buildSourceScanQuery(input({ query: "A".repeat(255), packages: ["ZTEST"] }));
    expect(q.query.length).toBe(255);
  });

  it("throws on an invalid `packages` entry (disallowed characters)", () => {
    expectBadInput(() => buildSourceScanQuery(input({ packages: ["Z TEST!"] })));
  });

  it("throws on an invalid `objects` pattern (disallowed characters)", () => {
    expectBadInput(() => buildSourceScanQuery(input({ objects: "ZCL FOO?" })));
  });

  it("throws when no scope is given: packages absent and objects absent", () => {
    expectBadInput(() => buildSourceScanQuery(input({})));
  });

  it("throws when no scope is given: packages is an empty array and objects absent", () => {
    expectBadInput(() => buildSourceScanQuery(input({ packages: [] })));
  });

  it('throws when no scope is given: packages absent and objects is blank ("   ")', () => {
    expectBadInput(() => buildSourceScanQuery(input({ objects: "   " })));
  });

  it('throws when no scope is given: packages absent and objects is exactly "*"', () => {
    expectBadInput(() => buildSourceScanQuery(input({ objects: "*" })));
  });

  it("throws on an unknown `types` entry not in SOURCE_SCAN_TYPES", () => {
    expectBadInput(() => buildSourceScanQuery(input({ packages: ["ZTEST"], types: ["BOGUS"] })));
  });
});

describe("buildSourceScanQuery: accepts and maps valid input", () => {
  it("maps camelCase-facing SearchInput fields onto the snake_case-sourced SourceScanQuery", () => {
    const q = buildSourceScanQuery(
      input({
        query: "lv_foo",
        packages: ["ZTEST"],
        include_subpackages: true,
        objects: "ZCL_*",
        types: ["clas", "prog"],
        regex: true,
        case_sensitive: true,
        include_comments: true,
      }),
    );

    expect(q).toEqual<SourceScanQuery>({
      query: "lv_foo",
      regex: true,
      caseSensitive: true,
      includeComments: true,
      packages: ["ZTEST"],
      includeSubpackages: true,
      objects: "ZCL_*",
      types: ["CLAS", "PROG"],
      maxHits: 100,
      maxObjects: SOURCE_SCAN_OBJECT_CEILING,
    });
  });

  it("defaults maxHits to 100 when `max` is absent", () => {
    const q = buildSourceScanQuery(input({ packages: ["ZTEST"] }));
    expect(q.maxHits).toBe(100);
  });

  it(`defaults maxObjects to SOURCE_SCAN_OBJECT_CEILING (${SOURCE_SCAN_OBJECT_CEILING})`, () => {
    const q = buildSourceScanQuery(input({ packages: ["ZTEST"] }));
    expect(q.maxObjects).toBe(200);
    expect(q.maxObjects).toBe(SOURCE_SCAN_OBJECT_CEILING);
  });

  it("honours `max` when supplied", () => {
    const q = buildSourceScanQuery(input({ packages: ["ZTEST"], max: 17 }));
    expect(q.maxHits).toBe(17);
  });

  it("defaults regex/case_sensitive/include_comments/include_subpackages to false when omitted", () => {
    const q = buildSourceScanQuery(input({ packages: ["ZTEST"] }));
    expect(q.regex).toBe(false);
    expect(q.caseSensitive).toBe(false);
    expect(q.includeComments).toBe(false);
    expect(q.includeSubpackages).toBe(false);
  });
});

describe("scanDispatchArgs", () => {
  const base: SourceScanQuery = {
    query: "lv_foo",
    regex: false,
    caseSensitive: false,
    includeComments: false,
    packages: [],
    includeSubpackages: false,
    objects: undefined,
    types: [],
    maxHits: 100,
    maxObjects: 200,
  };

  it("emits snake_case wire keys for every always-present field", () => {
    const args = scanDispatchArgs(base);
    expect(args).toMatchObject({
      query: "lv_foo",
      regex: false,
      case_sensitive: false,
      include_comments: false,
      include_subpackages: false,
      max_hits: 100,
      max_objects: 200,
    });
  });

  it("omits `packages` entirely when empty", () => {
    const args = scanDispatchArgs(base);
    expect(Object.prototype.hasOwnProperty.call(args, "packages")).toBe(false);
  });

  it("omits `objects` entirely when undefined", () => {
    const args = scanDispatchArgs(base);
    expect(Object.prototype.hasOwnProperty.call(args, "objects")).toBe(false);
  });

  it("omits `types` entirely when empty", () => {
    const args = scanDispatchArgs(base);
    expect(Object.prototype.hasOwnProperty.call(args, "types")).toBe(false);
  });

  it("includes `packages`/`objects`/`types` when set", () => {
    const args = scanDispatchArgs({
      ...base,
      packages: ["ZTEST", "ZFOO"],
      objects: "ZCL_*",
      types: ["CLAS"],
    });
    expect(args).toMatchObject({ packages: ["ZTEST", "ZFOO"], objects: "ZCL_*", types: ["CLAS"] });
  });
});

// ---------------------------------------------------------------------------
// buildSourceResponse
// ---------------------------------------------------------------------------

function baseQuery(overrides: Partial<SourceScanQuery> = {}): SourceScanQuery {
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

function baseResult(overrides: Partial<SourceScanResult> = {}): SourceScanResult {
  return {
    sid: "TST",
    hits: [],
    summary: {
      objectsTotal: 1,
      objectsScanned: 1,
      includesScanned: 1,
      includesSkipped: 0,
      hits: 0,
      truncated: "",
    },
    ms: 5,
    truncated: false,
    ...overrides,
  };
}

describe("buildSourceResponse: hit rendering", () => {
  it("renders hits as a table with type/name/include/line/text columns", () => {
    const result = baseResult({
      hits: [{ objType: "PROG", objName: "ZFOO", include: "ZFOO", line: 12, text: "DATA: lv_foo TYPE string." }],
      summary: {
        objectsTotal: 1,
        objectsScanned: 1,
        includesScanned: 1,
        includesSkipped: 0,
        hits: 1,
        truncated: "",
      },
    });
    const { text } = buildSourceResponse(baseQuery(), result, 30_000);

    expect(text).toContain("PROG");
    expect(text).toContain("ZFOO");
    expect(text).toContain("12");
    expect(text).toContain("DATA: lv_foo TYPE string.");
  });

  it("clips text over 120 characters for display", () => {
    const longText = "X".repeat(200);
    const result = baseResult({
      hits: [{ objType: "PROG", objName: "ZFOO", include: "ZFOO", line: 1, text: longText }],
      summary: { objectsTotal: 1, objectsScanned: 1, includesScanned: 1, includesSkipped: 0, hits: 1, truncated: "" },
    });
    const { text } = buildSourceResponse(baseQuery(), result, 30_000);

    expect(text).not.toContain(longText);
    expect(text).toContain("X".repeat(120));
  });
});

describe("buildSourceResponse: truncation disclosure", () => {
  it('summary.truncated === "hits" renders a --- TRUNCATED --- marker', () => {
    const result = baseResult({
      hits: [{ objType: "PROG", objName: "ZFOO", include: "ZFOO", line: 1, text: "x" }],
      summary: {
        objectsTotal: 1,
        objectsScanned: 1,
        includesScanned: 1,
        includesSkipped: 0,
        hits: 1,
        truncated: "hits",
      },
    });
    const { text } = buildSourceResponse(baseQuery(), result, 30_000);
    expect(text).toContain("--- TRUNCATED ---");
  });

  it('summary.truncated === "objects" names how many objects of the total were skipped and the maxObjects ceiling', () => {
    const result = baseResult({
      summary: {
        objectsTotal: 250,
        objectsScanned: 200,
        includesScanned: 400,
        includesSkipped: 0,
        hits: 0,
        truncated: "objects",
      },
    });
    const { text } = buildSourceResponse(baseQuery({ maxObjects: 200 }), result, 30_000);

    expect(text).toContain("--- TRUNCATED ---");
    expect(text).toContain("50");
    expect(text).toContain("250");
    expect(text).toContain("200");
  });

  it(
    "shows the TRUNCATED marker even with ZERO hits when the object ceiling was reached — " +
      "regression test: an object-ceiling cut used to be silently reported as a plain (no matches)",
    () => {
      const result = baseResult({
        hits: [],
        summary: {
          objectsTotal: 300,
          objectsScanned: 200,
          includesScanned: 400,
          includesSkipped: 0,
          hits: 0,
          truncated: "objects",
        },
      });
      const { text } = buildSourceResponse(baseQuery({ maxObjects: 200 }), result, 30_000);

      expect(text).toContain("--- TRUNCATED ---");
      expect(text).not.toBe("(no matches)");
    },
  );
});

describe("buildSourceResponse: abap_read follow-up", () => {
  it("appears in the response (as a note) for a complete, non-truncated response with hits", () => {
    const result = baseResult({
      hits: [{ objType: "PROG", objName: "ZFOO", include: "ZFOO", line: 50, text: "x" }],
      summary: { objectsTotal: 1, objectsScanned: 1, includesScanned: 1, includesSkipped: 0, hits: 1, truncated: "" },
    });
    const { text } = buildSourceResponse(baseQuery(), result, 30_000);

    expect(text).toContain("abap_read");
  });

  it("carries offset=max(1, line-10) and limit=40 for a PROG hit", () => {
    const result = baseResult({
      hits: [{ objType: "PROG", objName: "ZFOO", include: "ZFOO", line: 50, text: "x" }],
      summary: { objectsTotal: 1, objectsScanned: 1, includesScanned: 1, includesSkipped: 0, hits: 1, truncated: "" },
    });
    const { text } = buildSourceResponse(baseQuery(), result, 30_000);

    expect(text).toContain('abap_read object="ZFOO" offset=40 limit=40');
  });

  it("clamps offset to 1 (not negative) for a PROG hit near the top of the include", () => {
    const result = baseResult({
      hits: [{ objType: "PROG", objName: "ZFOO", include: "ZFOO", line: 3, text: "x" }],
      summary: { objectsTotal: 1, objectsScanned: 1, includesScanned: 1, includesSkipped: 0, hits: 1, truncated: "" },
    });
    const { text } = buildSourceResponse(baseQuery(), result, 30_000);

    expect(text).toContain('abap_read object="ZFOO" offset=1 limit=40');
  });

  it('maps a CLAS hit in a CC* include (CCIMP) onto include="implementations" with an offset', () => {
    const result = baseResult({
      hits: [
        {
          objType: "CLAS",
          objName: "ZCL_FOO",
          include: "ZCL_FOO===========CCIMP",
          line: 50,
          text: "x",
        },
      ],
      summary: { objectsTotal: 1, objectsScanned: 1, includesScanned: 1, includesSkipped: 0, hits: 1, truncated: "" },
    });
    const { text } = buildSourceResponse(baseQuery(), result, 30_000);

    expect(text).toContain('abap_read object="ZCL_FOO" include="implementations" offset=40 limit=40');
  });

  it(
    "does NOT claim an offset for a CLAS hit in a non-CC* include (e.g. a method include) " +
      "because the line number is include-local, not class-wide",
    () => {
      const result = baseResult({
        hits: [
          {
            objType: "CLAS",
            objName: "ZCL_FOO",
            include: "ZCL_FOO=========CM001",
            line: 50,
            text: "x",
          },
        ],
        summary: { objectsTotal: 1, objectsScanned: 1, includesScanned: 1, includesSkipped: 0, hits: 1, truncated: "" },
      });
      const { text } = buildSourceResponse(baseQuery(), result, 30_000);

      expect(text).toContain('abap_read object="ZCL_FOO"');
      expect(text).not.toMatch(/abap_read object="ZCL_FOO" .*offset=/);
      expect(text).toContain("include-local");
    },
  );
});

describe("buildSourceResponse: falsy header suppression", () => {
  it("does not render regex/case_sensitive/include_comments header lines when all are false", () => {
    const { text } = buildSourceResponse(
      baseQuery({ regex: false, caseSensitive: false, includeComments: false }),
      baseResult(),
      30_000,
    );

    expect(text).not.toMatch(/^regex:/m);
    expect(text).not.toMatch(/^case_sensitive:/m);
    expect(text).not.toMatch(/^include_comments:/m);
  });

  it("renders regex/case_sensitive/include_comments header lines when all are true", () => {
    const { text } = buildSourceResponse(
      baseQuery({ regex: true, caseSensitive: true, includeComments: true }),
      baseResult(),
      30_000,
    );

    expect(text).toMatch(/^regex: true$/m);
    expect(text).toMatch(/^case_sensitive: true$/m);
    expect(text).toMatch(/^include_comments: true$/m);
  });
});

describe("searchInputSchema: mode guidance", () => {
  it("the mode description tells the model to prefer where_used over source for real static references", () => {
    const text = searchInputSchema.mode.description ?? "";
    expect(text).toContain("where_used");
    expect(text).toMatch(/static references/);
    expect(text).toMatch(/fluid API/);
  });
});
