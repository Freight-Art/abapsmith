/**
 * `src/adt/traces-query.ts` — ABAP-trace (SAT) request building: pure
 * functions, no socket, no XML parser. Modelled on `test/atc-query.test.ts`
 * and `test/dumps-query.test.ts`.
 *
 * ## What backs these assertions, and what does not
 *
 * `traces-query.ts`'s own header claims every wire fact in it was verified
 * live against an A4H appliance on 2026-09-15. This test file has no SAP
 * access of its own and no committed fixture of the exact bytes a server
 * accepted for `<trc:parameters>` or `POST …/requests` (the fixtures under
 * `test/fixtures/traces/` are captured RESPONSE bodies for the read-back
 * side of this tool, not the request bodies this module builds) — so this
 * suite cannot independently confirm SAP accepted any of it. It can only:
 *
 *   - pin the code's own behaviour, so a future change shows up as a diff
 *     against a stated expectation rather than silently; and
 *   - cross-check `buildTraceParametersXml`'s element order against
 *     `abap-adt-api`'s own `tracesSetParameters` template (read from
 *     `node_modules` at test time, not re-typed), which is the strongest
 *     offline corroboration available. That proves agreement with a widely
 *     used ADT client. It does NOT prove SAP accepted this exact byte
 *     sequence — that remains a claim only the source file's doc comments
 *     make, on the strength of a capture this suite did not perform.
 *
 * Anywhere a claim below is "matches a copied template" rather than "was
 * observed on the wire", that distinction is called out at the point it's
 * used, the same convention `atc-query.test.ts` follows for its own
 * library-template comparisons.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AbapError, isAbapError } from "../src/adt/errors.js";
import { CLASSRUN_PATH } from "../src/adt/run.js";
import {
  ABAPTRACES_BASE,
  ABAPTRACES_REQUESTS_BASE,
  SQLTRACES_BASE,
  TRACE_DEFAULT_EXECUTIONS,
  TRACE_DEFAULT_MAX_SECONDS,
  TRACE_DEFAULT_MAX_SIZE_KB,
  TRACE_DEFAULT_OPTIONS,
  TRACE_DEFAULT_TOP,
  TRACE_DEFAULT_TREE_DEPTH,
  TRACE_LIST_KINDS,
  TRACE_MAX_EXECUTIONS,
  TRACE_MAX_SECONDS,
  TRACE_MAX_SIZE_KB,
  TRACE_MAX_TOP,
  TRACE_MAX_TREE_DEPTH,
  TRACE_OPS,
  TRACE_VIEWS,
  assertTreeViewAllowed,
  buildCreateRequestQuery,
  buildTraceParametersXml,
  classrunScopeUri,
  normaliseTraceRequestId,
  normaliseTraceRunId,
  resolveTop,
  resolveTraceOptions,
  resolveTreeDepth,
  type TraceOptions,
} from "../src/adt/traces-query.js";

/** Runs `fn`, returns the thrown `AbapError`, or fails the test if nothing (or something else) throws. */
const caught = (fn: () => unknown): AbapError => {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected an AbapError, none was thrown");
};

/** A description guaranteed to pass `assertDescription` (well under the 60-char cap). */
const OK_DESCRIPTION = "abapsmith trace test";

const fullOptions = (overrides: Partial<TraceOptions> = {}): TraceOptions => ({
  ...TRACE_DEFAULT_OPTIONS,
  description: OK_DESCRIPTION,
  ...overrides,
});

// ===========================================================================

describe("buildTraceParametersXml", () => {
  it("emits the XML declaration, the trc:parameters root with its namespace, and closes it", () => {
    const xml = buildTraceParametersXml(fullOptions());
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(xml).toContain(
      '<trc:parameters xmlns:trc="http://www.sap.com/adt/runtime/traces/abaptraces">',
    );
    expect(xml.trimEnd().endsWith("</trc:parameters>")).toBe(true);
  });

  it("emits exactly the 13 documented child elements, in the documented order", () => {
    // Order is load-bearing per the doc comment on buildTraceParametersXml:
    // this reproduces a captured working request and reordering is not known
    // to be safe. Extracted by regex rather than eyeballed, so a reorder in
    // the source shows up here.
    const xml = buildTraceParametersXml(fullOptions());
    const names = [...xml.matchAll(/<trc:(\w+) value=/g)].map((m) => m[1]);
    expect(names).toEqual([
      "allMiscAbapStatements",
      "allProceduralUnits",
      "allInternalTableEvents",
      "allDynproEvents",
      "description",
      "aggregate",
      "explicitOnOff",
      "withRfcTracing",
      "allSystemKernelEvents",
      "sqlTrace",
      "allDbEvents",
      "maxSizeForTraceFile",
      "maxTimeForTracing",
    ]);
  });

  it("emits the same 13 elements, in the same order, as abap-adt-api's own tracesSetParameters template", () => {
    // Cross-checked against the vendored client rather than a re-typed copy of
    // the list above: if abap-adt-api ever reorders its own template, this
    // fails loudly instead of silently agreeing with a stale expectation.
    // This proves agreement with a widely-used ADT client, NOT that SAP
    // accepted this exact byte sequence — that is the separate, live-only
    // claim the source file's doc comment makes, which this test does not
    // and cannot check.
    const vendorPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "node_modules",
      "abap-adt-api",
      "build",
      "api",
      "traces.js",
    );
    const vendorSource = readFileSync(vendorPath, "utf8");
    expect(vendorSource).toContain("tracesSetParameters");
    const vendorNames = [...vendorSource.matchAll(/<trc:(\w+) value=/g)].map((m) => m[1]);
    expect(vendorNames).toHaveLength(13);

    const xml = buildTraceParametersXml(fullOptions());
    const ourNames = [...xml.matchAll(/<trc:(\w+) value=/g)].map((m) => m[1]);
    expect(ourNames).toEqual(vendorNames);
  });

  it("renders booleans as bare true/false, never 1/0", () => {
    const xml = buildTraceParametersXml(
      fullOptions({ aggregate: true, sqlTrace: false, allInternalTableEvents: true }),
    );
    expect(xml).toContain('<trc:aggregate value="true">');
    expect(xml).toContain('<trc:sqlTrace value="false">');
    expect(xml).toContain('<trc:allInternalTableEvents value="true">');
    expect(xml).not.toContain('value="1"');
    expect(xml).not.toContain('value="0"');
  });

  it("renders numbers bare, with no unit suffix", () => {
    const xml = buildTraceParametersXml(fullOptions({ maxSizeForTraceFile: 30_720 }));
    expect(xml).toContain("<trc:maxSizeForTraceFile value=\"30720\">");
  });

  it("XML-attribute-escapes the description, the one caller-controlled attribute", () => {
    // description is the only field here that carries caller text; everything
    // else is a boolean or a number this module produced itself, which is why
    // only description goes through escapeAttr.
    const xml = buildTraceParametersXml(fullOptions({ description: 'a & b "c" <d>' }));
    expect(xml).toContain('<trc:description value="a &amp; b &quot;c&quot; &lt;d&gt;">');
    expect(xml.match(/<trc:description /g)).toHaveLength(1);
  });

  it("rejects an empty description", () => {
    expect(() => buildTraceParametersXml(fullOptions({ description: "" }))).toThrow(AbapError);
    expect(caught(() => buildTraceParametersXml(fullOptions({ description: "" }))).code).toBe(
      "BAD_INPUT",
    );
  });

  it("rejects a whitespace-only description", () => {
    expect(caught(() => buildTraceParametersXml(fullOptions({ description: "   " }))).code).toBe(
      "BAD_INPUT",
    );
  });

  it("rejects a description containing a control character", () => {
    const err = caught(() => buildTraceParametersXml(fullOptions({ description: "abcd" })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("control characters");
  });

  it("rejects a description of 61 characters", () => {
    const description = "a".repeat(61);
    const err = caught(() => buildTraceParametersXml(fullOptions({ description })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("60");
  });

  it("accepts a description of exactly 60 characters", () => {
    const description = "a".repeat(60);
    expect(() => buildTraceParametersXml(fullOptions({ description }))).not.toThrow();
    const xml = buildTraceParametersXml(fullOptions({ description }));
    expect(xml).toContain(`<trc:description value="${description}">`);
  });
});

// ===========================================================================

describe("classrunScopeUri", () => {
  it("upper-cases the class name onto CLASSRUN_PATH", () => {
    // Derived from CLASSRUN_PATH (run.ts) rather than re-spelling the prefix
    // here, so the two paths cannot silently drift apart.
    expect(classrunScopeUri("zcl_i77_probe")).toBe(`${CLASSRUN_PATH}ZCL_I77_PROBE`);
  });

  it("rejects an injection-shaped class name, via assertPlainName's own guard", () => {
    // assertPlainName (run.ts) allows only /^[A-Za-z0-9_/]{1,40}$/ and throws
    // BAD_INPUT otherwise — confirmed by reading run.ts, not assumed. A `/`
    // alone is legal (ABAP namespaces use it), so the injection-shaped cases
    // here need a `?` or a space to fall outside that pattern.
    for (const bad of ["zcl_foo/bar?x=1", "zcl foo", "zcl foo bar", "a?b"]) {
      const err = caught(() => classrunScopeUri(bad));
      expect(err.code).toBe("BAD_INPUT");
    }
  });
});

// ===========================================================================

describe("normaliseTraceRunId", () => {
  const id = "0123456789abcdef0123456789ABCDEF";
  const bareId = id.slice(0, 32);

  it("expands a bare 32-hex id to the full path", () => {
    expect(normaliseTraceRunId(bareId)).toBe(`${ABAPTRACES_BASE}/${bareId}`);
  });

  it("returns an already-full path unchanged", () => {
    const full = `${ABAPTRACES_BASE}/${bareId}`;
    expect(normaliseTraceRunId(full)).toBe(full);
  });

  it("accepts lower-case hex", () => {
    const lower = "abcdef0123456789abcdef0123456789";
    expect(normaliseTraceRunId(lower)).toBe(`${ABAPTRACES_BASE}/${lower}`);
  });

  it("accepts upper-case hex", () => {
    const upper = "ABCDEF0123456789ABCDEF0123456789";
    expect(normaliseTraceRunId(upper)).toBe(`${ABAPTRACES_BASE}/${upper}`);
  });

  it("trims surrounding whitespace", () => {
    expect(normaliseTraceRunId(`  ${bareId}  `)).toBe(`${ABAPTRACES_BASE}/${bareId}`);
  });

  it("rejects a 31-hex id", () => {
    expect(caught(() => normaliseTraceRunId(bareId.slice(0, 31))).code).toBe("BAD_INPUT");
  });

  it("rejects a 33-hex id", () => {
    expect(caught(() => normaliseTraceRunId(bareId + "0")).code).toBe("BAD_INPUT");
  });

  it("rejects a non-hex string", () => {
    expect(caught(() => normaliseTraceRunId("not-a-hex-id-at-all-zzzzzzzzzzzz")).code).toBe(
      "BAD_INPUT",
    );
  });

  it("rejects the empty string", () => {
    expect(caught(() => normaliseTraceRunId("")).code).toBe("BAD_INPUT");
  });

  it("rejects a path with the right prefix but a bad id", () => {
    expect(caught(() => normaliseTraceRunId(`${ABAPTRACES_BASE}/not-hex`)).code).toBe("BAD_INPUT");
  });
});

// ===========================================================================

describe("normaliseTraceRequestId", () => {
  it("expands a percent-encoded-comma id to the full requests path", () => {
    expect(normaliseTraceRequestId("4%2c20260915023824")).toBe(
      `${ABAPTRACES_REQUESTS_BASE}/4%2c20260915023824`,
    );
  });

  it("accepts the literal-comma form too — both forms have been seen echoed back by the server", () => {
    expect(normaliseTraceRequestId("4,20260915023824")).toBe(
      `${ABAPTRACES_REQUESTS_BASE}/4,20260915023824`,
    );
  });

  it("accepts an upper-case %2C", () => {
    expect(normaliseTraceRequestId("4%2C20260915023824")).toBe(
      `${ABAPTRACES_REQUESTS_BASE}/4%2C20260915023824`,
    );
  });

  it("returns an already-full path unchanged", () => {
    const full = `${ABAPTRACES_REQUESTS_BASE}/4%2c20260915023824`;
    expect(normaliseTraceRequestId(full)).toBe(full);
  });

  it("rejects a 13-digit timestamp", () => {
    expect(caught(() => normaliseTraceRequestId("4%2c2026091502382")).code).toBe("BAD_INPUT");
  });

  it("rejects a missing separator", () => {
    expect(caught(() => normaliseTraceRequestId("420260915023824")).code).toBe("BAD_INPUT");
  });

  it("rejects the empty string", () => {
    expect(caught(() => normaliseTraceRequestId("")).code).toBe("BAD_INPUT");
  });
});

// ===========================================================================

describe("buildCreateRequestQuery", () => {
  const baseInput = {
    description: OK_DESCRIPTION,
    traceUser: "developer",
    traceClient: "001",
    objectName: `${CLASSRUN_PATH}ZCL_I77_PROBE`,
    parametersId: `${ABAPTRACES_BASE}/parameters/abc123`,
    maximalExecutions: 1,
    expires: new Date("2026-09-15T02:38:24.000Z"),
  };

  it("returns every value as a string", () => {
    const query = buildCreateRequestQuery(baseInput);
    expect(Object.values(query).every((v) => typeof v === "string")).toBe(true);
  });

  it("fixes server to the wildcard, and points processType/objectType at the http/url pair", () => {
    const query = buildCreateRequestQuery(baseInput);
    expect(query.server).toBe("*");
    expect(query.processType?.endsWith("/processtypes/http")).toBe(true);
    expect(query.objectType?.endsWith("/objecttypes/url")).toBe(true);
  });

  it("upper-cases traceUser", () => {
    expect(buildCreateRequestQuery(baseInput).traceUser).toBe("DEVELOPER");
  });

  it("renders expires as an ISO-8601 string", () => {
    const query = buildCreateRequestQuery(baseInput);
    expect(query.expires).toBe("2026-09-15T02:38:24.000Z");
  });

  it("stringifies maximalExecutions", () => {
    expect(buildCreateRequestQuery({ ...baseInput, maximalExecutions: 5 }).maximalExecutions).toBe(
      "5",
    );
  });

  it("keeps objectName: without it the trace request is unscoped", () => {
    // Finding recorded in the source's doc comment: an unscoped request
    // captures the client's own ADT traffic instead of the traced object's,
    // burning every allowed execution on noise. This test only checks the
    // field is passed through verbatim, which is what makes that avoidable.
    const query = buildCreateRequestQuery(baseInput);
    expect(query.objectName).toBe(baseInput.objectName);
  });
});

// ===========================================================================

describe("resolveTop", () => {
  it("defaults to TRACE_DEFAULT_TOP when omitted", () => {
    expect(resolveTop(undefined)).toBe(TRACE_DEFAULT_TOP);
    expect(TRACE_DEFAULT_TOP).toBe(20);
  });

  it("accepts 1 and the cap exactly", () => {
    expect(resolveTop(1)).toBe(1);
    expect(resolveTop(TRACE_MAX_TOP)).toBe(TRACE_MAX_TOP);
    expect(TRACE_MAX_TOP).toBe(100);
  });

  it.each([TRACE_MAX_TOP + 1, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "20", null])(
    "rejects %s",
    (bad) => {
      expect(() => resolveTop(bad)).toThrow(AbapError);
      expect(caught(() => resolveTop(bad)).code).toBe("BAD_INPUT");
    },
  );
});

describe("resolveTreeDepth", () => {
  it("defaults to TRACE_DEFAULT_TREE_DEPTH when omitted", () => {
    expect(resolveTreeDepth(undefined)).toBe(TRACE_DEFAULT_TREE_DEPTH);
    expect(TRACE_DEFAULT_TREE_DEPTH).toBe(4);
  });

  it("accepts 1 and the cap exactly", () => {
    expect(resolveTreeDepth(1)).toBe(1);
    expect(resolveTreeDepth(TRACE_MAX_TREE_DEPTH)).toBe(TRACE_MAX_TREE_DEPTH);
    expect(TRACE_MAX_TREE_DEPTH).toBe(12);
  });

  it.each([
    TRACE_MAX_TREE_DEPTH + 1,
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "20",
    null,
  ])("rejects %s", (bad) => {
    expect(() => resolveTreeDepth(bad)).toThrow(AbapError);
    expect(caught(() => resolveTreeDepth(bad)).code).toBe("BAD_INPUT");
  });
});

// ===========================================================================

describe("resolveTraceOptions", () => {
  it("with {} and a default description, matches TRACE_DEFAULT_OPTIONS's shape", () => {
    const opts = resolveTraceOptions({}, "default desc");
    expect(opts.aggregate).toBe(true);
    expect(opts.sqlTrace).toBe(true);
    expect(opts.allDbEvents).toBe(true);
    expect(opts.allProceduralUnits).toBe(true);
    expect(opts.allInternalTableEvents).toBe(false);
    expect(opts.allMiscAbapStatements).toBe(false);
    expect(opts.allDynproEvents).toBe(false);
    expect(opts.allSystemKernelEvents).toBe(false);
    expect(opts.withRfcTracing).toBe(false);
    expect(opts.explicitOnOff).toBe(false);
  });

  it("keeps the five non-settable flags false even when args try every spelling to reach them", () => {
    // Each of these five multiplies trace size (dynpro/kernel/misc-statement
    // events) or changes trace semantics (RFC tracing, explicit on/off) in a
    // way that doesn't answer "where does this call spend time / hit the
    // database" — so resolveTraceOptions deliberately reads no argument for
    // them, camelCase or snake_case. This proves that guess is actually
    // unreachable, not just undocumented.
    const opts = resolveTraceOptions(
      {
        all_misc_abap_statements: true,
        allMiscAbapStatements: true,
        dynpro_events: true,
        allDynproEvents: true,
        kernel_events: true,
        allSystemKernelEvents: true,
        rfc_tracing: true,
        withRfcTracing: true,
        explicit_on_off: true,
        explicitOnOff: true,
      },
      "default desc",
    );
    expect(opts.allMiscAbapStatements).toBe(false);
    expect(opts.allDynproEvents).toBe(false);
    expect(opts.allSystemKernelEvents).toBe(false);
    expect(opts.withRfcTracing).toBe(false);
    expect(opts.explicitOnOff).toBe(false);
  });

  it("maps snake_case args to the camelCase fields", () => {
    const opts = resolveTraceOptions(
      {
        sql_trace: false,
        db_events: false,
        procedural_units: false,
        internal_tables: true,
        aggregate: false,
      },
      "default desc",
    );
    expect(opts.sqlTrace).toBe(false);
    expect(opts.allDbEvents).toBe(false);
    expect(opts.allProceduralUnits).toBe(false);
    expect(opts.allInternalTableEvents).toBe(true);
    expect(opts.aggregate).toBe(false);
  });

  it.each(["aggregate", "sql_trace", "db_events", "procedural_units", "internal_tables"])(
    "rejects a non-boolean for '%s', naming that exact snake_case parameter",
    (name) => {
      const err = caught(() => resolveTraceOptions({ [name]: "yes" }, "default desc"));
      expect(err.code).toBe("BAD_INPUT");
      // The caller typed this name; telling them about the camelCase field
      // instead would send them looking at the wrong key.
      expect(err.message).toContain(`'${name}'`);
    },
  );

  it("falls back to the default description when absent, empty, or whitespace-only", () => {
    expect(resolveTraceOptions({}, "default desc").description).toBe("default desc");
    expect(resolveTraceOptions({ description: "" }, "default desc").description).toBe(
      "default desc",
    );
    expect(resolveTraceOptions({ description: "   " }, "default desc").description).toBe(
      "default desc",
    );
  });

  it("a real description wins over the default", () => {
    expect(resolveTraceOptions({ description: "my run" }, "default desc").description).toBe(
      "my run",
    );
  });

  describe("max_size_kb", () => {
    it("defaults when absent", () => {
      expect(resolveTraceOptions({}, "d").maxSizeForTraceFile).toBe(TRACE_DEFAULT_MAX_SIZE_KB);
    });

    it("accepts 1 and the cap", () => {
      expect(resolveTraceOptions({ max_size_kb: 1 }, "d").maxSizeForTraceFile).toBe(1);
      expect(resolveTraceOptions({ max_size_kb: TRACE_MAX_SIZE_KB }, "d").maxSizeForTraceFile).toBe(
        TRACE_MAX_SIZE_KB,
      );
      expect(TRACE_MAX_SIZE_KB).toBe(102_400);
    });

    it.each([0, TRACE_MAX_SIZE_KB + 1, 1.5, "30720"])("rejects %s", (bad) => {
      const err = caught(() => resolveTraceOptions({ max_size_kb: bad }, "d"));
      expect(err.code).toBe("BAD_INPUT");
    });
  });

  describe("max_seconds", () => {
    it("defaults when absent", () => {
      expect(resolveTraceOptions({}, "d").maxTimeForTracing).toBe(TRACE_DEFAULT_MAX_SECONDS);
    });

    it("accepts 1 and the cap", () => {
      expect(resolveTraceOptions({ max_seconds: 1 }, "d").maxTimeForTracing).toBe(1);
      expect(resolveTraceOptions({ max_seconds: TRACE_MAX_SECONDS }, "d").maxTimeForTracing).toBe(
        TRACE_MAX_SECONDS,
      );
      expect(TRACE_MAX_SECONDS).toBe(1_800);
    });

    it.each([0, TRACE_MAX_SECONDS + 1, 1.5, "600"])("rejects %s", (bad) => {
      const err = caught(() => resolveTraceOptions({ max_seconds: bad }, "d"));
      expect(err.code).toBe("BAD_INPUT");
    });
  });
});

// ===========================================================================

describe("assertTreeViewAllowed", () => {
  it("returns without throwing when the trace is not aggregated", () => {
    expect(() => assertTreeViewAllowed(false, "some-trace-id")).not.toThrow();
  });

  it("throws BAD_INPUT naming the trace id and pointing at aggregate=false when it is aggregated", () => {
    // Observed live (per the source's doc comment): GET {id}/statements on an
    // aggregated trace answers HTTP 400 with subType
    // invalidRequestForAggregatedTraces. Refusing here turns a guaranteed
    // server round-trip into an immediate, explainable error instead.
    const err = caught(() => assertTreeViewAllowed(true, "abc"));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("abc");
    expect(err.hint).toContain("aggregate=false");
  });
});

// ===========================================================================

describe("constants", () => {
  it("pins the tool's documented op/view/list-kind surface", () => {
    expect(TRACE_OPS).toEqual(["start", "run", "list", "read", "delete"]);
    expect(TRACE_VIEWS).toEqual(["hitlist", "db", "tree"]);
    expect(TRACE_LIST_KINDS).toEqual(["runs", "requests"]);
  });

  it("every default is within its own cap", () => {
    expect(TRACE_DEFAULT_TOP).toBeLessThanOrEqual(TRACE_MAX_TOP);
    expect(TRACE_DEFAULT_TREE_DEPTH).toBeLessThanOrEqual(TRACE_MAX_TREE_DEPTH);
    expect(TRACE_DEFAULT_MAX_SIZE_KB).toBeLessThanOrEqual(TRACE_MAX_SIZE_KB);
    expect(TRACE_DEFAULT_MAX_SECONDS).toBeLessThanOrEqual(TRACE_MAX_SECONDS);
    expect(TRACE_DEFAULT_EXECUTIONS).toBeLessThanOrEqual(TRACE_MAX_EXECUTIONS);
  });

  it("pins SQLTRACES_BASE as UNVERIFIED — not a claim this constant works", () => {
    // Per the source's own doc comment: GET .../sqltraces on A4H answered
    // "Resource ... does not exist." and discovery does not advertise
    // traces.sqltraces at all. This only pins the string; it asserts nothing
    // about the resource actually existing on any release.
    expect(SQLTRACES_BASE).toBe("/sap/bc/adt/runtime/traces/sqltraces");
  });
});
