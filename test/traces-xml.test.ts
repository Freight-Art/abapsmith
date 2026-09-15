/**
 * ABAP-trace (SAT) response parsing — `src/adt/traces-xml.ts`.
 *
 * Every assertion below is driven by the bytes A4H actually sent on
 * 2026-09-15, read from `test/fixtures/traces/` — see that directory's
 * `README.md` for what each file proves and which two hostnames were
 * substituted. Nothing here is asserted against XML written in this file.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseTraceDbAccesses,
  parseTraceHitList,
  parseTraceRequests,
  parseTraceRuns,
  parseTraceStatements,
} from "../src/adt/traces-xml.js";
import { isAbapError } from "../src/adt/errors.js";

// ----------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "traces");

/** The captured bytes of `name`, exactly as the appliance sent them. */
function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

// -------------------------------------------------------------- run list ---

describe("parseTraceRuns", () => {
  it("reads both runs of a two-run feed", () => {
    const runs = parseTraceRuns(fixture("results-feed-two-runs.xml"));
    expect(runs).toHaveLength(2);
  });

  it("marks the aggregated run with its aggregationKind, and the non-aggregated run with NO aggregationKind key at all", () => {
    const [aggregated, plain] = parseTraceRuns(fixture("results-feed-two-runs.xml"));
    expect(aggregated.isAggregated).toBe(true);
    expect(aggregated.aggregationKind).toBe("byCallPosition");
    expect(plain.isAggregated).toBe(false);
    // Not `toBeUndefined()` — the module's contract is that it never emits
    // undefined-valued keys, so the key itself must be absent.
    expect(plain).not.toHaveProperty("aggregationKind");
  });

  it("keeps client as a zero-padded string, not a number", () => {
    const [run] = parseTraceRuns(fixture("results-feed-two-runs.xml"));
    expect(typeof run.client).toBe("string");
    expect(run.client).toBe("001");
  });

  it("keeps published as the verbatim ISO string, not a Date", () => {
    const [run] = parseTraceRuns(fixture("results-feed-two-runs.xml"));
    expect(run.published).toBe("2026-09-15T02:36:20Z");
    expect(run.published).not.toBeInstanceOf(Date);
  });

  it("parses size/runtime/runtimeAbap/runtimeSystem/runtimeDatabase as numbers", () => {
    const [run] = parseTraceRuns(fixture("results-feed-two-runs.xml"));
    expect(run.size).toBe(38);
    expect(run.runtime).toBe(153699);
    expect(run.runtimeAbap).toBe(29344);
    expect(run.runtimeSystem).toBe(0);
    expect(run.runtimeDatabase).toBe(124355);
    for (const field of ["size", "runtime", "runtimeAbap", "runtimeSystem", "runtimeDatabase"] as const) {
      expect(typeof run[field]).toBe("number");
    }
  });

  it("accepts a bare atom:entry document, not only a feed — the same parser reads a single-run GET", () => {
    const runs = parseTraceRuns(fixture("results-entry-one-run.xml"));
    expect(runs).toHaveLength(1);
    expect(runs[0].id).not.toBe("");
  });

  it("throws AbapError(ADT_ERROR) on malformed input rather than returning a half-parsed object", () => {
    try {
      parseTraceRuns("<nonsense/>");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("ADT_ERROR");
    }
  });
});

// -------------------------------------------------------------- requests ---

describe("parseTraceRequests", () => {
  it("reads one request from a one-entry feed, with a fully consumed executions count still listed", () => {
    const [request] = parseTraceRequests(fixture("requests-feed-one.xml"));
    expect(request).toBeDefined();
    expect(request.maximalExecutions).toBe(1);
    expect(request.completedExecutions).toBe(1);
  });

  it("takes traceUser from the atom:author whose trc:role is trace, not the admin author", () => {
    const [request] = parseTraceRequests(fixture("requests-feed-one.xml"));
    // Both `atom:author` elements in this capture happen to carry the same
    // `atom:name` ("DEVELOPER") — the fixture doesn't let a value mismatch
    // expose a wrong-author bug on its own. What's pinned here is the real
    // value the trace-role author carries; `src/adt/traces-xml.ts`'s
    // `authorByRole(entry["atom:author"], "trace")` is what makes the
    // selection, keyed on `trc:role`, not position.
    expect(request.traceUser).toBe("DEVELOPER");
  });

  it("reduces objectType and processType to their last path segment, not the full URI", () => {
    const [request] = parseTraceRequests(fixture("requests-feed-one.xml"));
    expect(request.objectType).toBe("url");
    expect(request.processType).toBe("http");
  });

  it("returns [] for a feed with zero entries", () => {
    expect(parseTraceRequests(fixture("requests-feed-empty.xml"))).toEqual([]);
  });

  it("reads one request from the feed a create POST answers with, not a bare id", () => {
    const requests = parseTraceRequests(fixture("requests-feed-created.xml"));
    expect(requests).toHaveLength(1);
  });

  it("throws AbapError(ADT_ERROR) on malformed input rather than returning a half-parsed object", () => {
    try {
      parseTraceRequests("<nonsense/>");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("ADT_ERROR");
    }
  });
});

// -------------------------------------------------------------- hit list ---

describe("parseTraceHitList", () => {
  it("reads all 12 rows of the top-12 fixture", () => {
    const { entries } = parseTraceHitList(fixture("hitlist-top12.xml"));
    expect(entries).toHaveLength(12);
  });

  it("arrives already sorted by net time descending — rank 1..12 in order, netTime.time non-increasing", () => {
    const { entries } = parseTraceHitList(fixture("hitlist-top12.xml"));
    expect(entries.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].netTime.time).toBeLessThanOrEqual(entries[i - 1].netTime.time);
    }
  });

  it("keeps netTime.percentage's fractional part, e.g. 24.1768 — not rounded off by m:count handling", () => {
    const { entries } = parseTraceHitList(fixture("hitlist-top12.xml"));
    expect(entries[0].netTime.percentage).toBe(24.1768);
    expect(Number.isInteger(entries[0].netTime.percentage)).toBe(false);
  });

  it("carries callingProgram with name/type/uri for a real ADT object, and WITHOUT them for SAP framework code with only objectReferenceQuery", () => {
    const { entries } = parseTraceHitList(fixture("hitlist-top12.xml"));
    const withAdtObject = entries[0];
    expect(withAdtObject.callingProgram).toBeDefined();
    expect(withAdtObject.callingProgram?.name).toBe("CL_ABAP_DOCU_CLASS_POOL");
    expect(withAdtObject.callingProgram?.type).toBe("CLAS/OC");
    expect(withAdtObject.callingProgram?.uri).toBeDefined();

    const frameworkOnly = entries[1];
    expect(frameworkOnly.callingProgram).toBeDefined();
    expect(frameworkOnly.callingProgram?.context).toBe("ZCL_I77_PROBE=================CP");
    expect(frameworkOnly.callingProgram).not.toHaveProperty("name");
    expect(frameworkOnly.callingProgram).not.toHaveProperty("type");
    expect(frameworkOnly.callingProgram).not.toHaveProperty("uri");
  });

  it("throws AbapError(ADT_ERROR) on malformed input rather than returning a half-parsed object", () => {
    try {
      parseTraceHitList("<nonsense/>");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("ADT_ERROR");
    }
  });
});

// ---------------------------------------------------------- db accesses ---

describe("parseTraceDbAccesses", () => {
  it("reads 15 accesses and 5 tables from the trimmed fixture", () => {
    const { accesses, tables } = parseTraceDbAccesses(fixture("dbaccesses-trimmed.xml"));
    expect(accesses).toHaveLength(15);
    expect(tables).toHaveLength(5);
  });

  it("decodes the kernel pseudo-row's tableName from its XML-escaped form", () => {
    const { accesses } = parseTraceDbAccesses(fixture("dbaccesses-trimmed.xml"));
    const kernelRow = accesses.find((a) => a.index === 1);
    expect(kernelRow?.tableName).toBe("<DB Access from Kernel>");
  });

  it("REGRESSION: TADIR's tableClass reads the un-prefixed type attribute (TRANSP), not adtcore:type (TABL/DT) — removeNSPrefix would collapse the two", () => {
    const { tables } = parseTraceDbAccesses(fixture("dbaccesses-trimmed.xml"));
    const tadir = tables.find((t) => t.name === "TADIR");
    expect(tadir).toBeDefined();
    // With `removeNSPrefix: true`, `type="TRANSP"` and `adtcore:type="TABL/DT"`
    // both collapse to the same `@_type` key and the DDIC table class is
    // silently overwritten by the ADT type string — which is why this module
    // keeps namespace prefixes (see the comment at the top of
    // `src/adt/traces-xml.ts`). Pin both sides of that failure mode.
    expect(tadir?.tableClass).toBe("TRANSP");
    expect(tadir?.tableClass).not.toBe("TABL/DT");
  });

  it("carries a statement kind and numeric totalCount/databaseTime per access", () => {
    const { accesses } = parseTraceDbAccesses(fixture("dbaccesses-trimmed.xml"));
    const kinds = new Set(accesses.map((a) => a.statement));
    expect(kinds).toContain("select");
    expect(kinds).toContain("select single");
    expect(kinds).toContain("select count(*)");
    for (const access of accesses) {
      expect(typeof access.totalCount).toBe("number");
      expect(typeof access.databaseTime).toBe("number");
    }
    const kernelRow = accesses.find((a) => a.index === 1);
    expect(kernelRow?.totalCount).toBe(161);
    expect(kernelRow?.databaseTime).toBe(155314);
  });

  it("throws AbapError(ADT_ERROR) on malformed input rather than returning a half-parsed object", () => {
    try {
      parseTraceDbAccesses("<nonsense/>");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("ADT_ERROR");
    }
  });
});

// ---------------------------------------------------------- call tree ---

describe("parseTraceStatements", () => {
  it("REGRESSION: reads 20 trimmed rows but count is 660 — m:count is scientific notation (6.6E+2), which Number.parseInt would truncate to 6", () => {
    const { statements, count } = parseTraceStatements(fixture("statements-calltree-top20.xml"));
    expect(statements).toHaveLength(20);
    expect(count).toBe(660);
  });

  it("parses callLevel and callerId as numbers, with the root row at callLevel 0", () => {
    const { statements } = parseTraceStatements(fixture("statements-calltree-top20.xml"));
    const root = statements[0];
    expect(root.id).toBe(1);
    expect(root.callLevel).toBe(0);
    expect(typeof root.callLevel).toBe("number");
    expect(typeof root.callerId).toBe("number");
  });

  it("throws AbapError(ADT_ERROR) on malformed input rather than returning a half-parsed object", () => {
    try {
      parseTraceStatements("<nonsense/>");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("ADT_ERROR");
    }
  });
});
