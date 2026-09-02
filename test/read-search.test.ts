/**
 * Regression tests for the honesty defects in `abap_read` and `abap_search`:
 *
 *   - method paging used two different line frames, so the advertised next
 *     offset never advanced — an agent could page forever.
 *   - where_used capped its result list silently.
 *   - `max` is applied by the SERVER, the type filter runs locally, so the
 *     row count under-reports without a word about it.
 *   - outline=true answered "(no components)" for types that have no
 *     outline at all.
 *
 * Everything here is offline: `resolveObject` and the source readers are
 * stubbed, so no ADT endpoint is contacted.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import type { AbapError } from "../src/adt/errors.js";
import type {
  BadiImplementationDocument,
  EnhancementSpotDocument,
  SourceCodePluginDocument,
} from "../src/adt/enhancement.js";
import {
  parseBadiImplementation,
  parseEnhancementSpot,
  parseSourceCodePlugin,
} from "../src/adt/enhancement-xml.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import type { ClassMember, MethodSource } from "../src/adt/source.js";

// Real captures, same convention as enhancement-xml.test.ts: fixture bytes
// copied unmodified from a live A4H capture, decoded via the real parser —
// never hand-typed data — so adjustmentStatus assertions below are exercised
// against genuine SAP XML shapes, not an invented stub.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement");
const readFixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

// --- stub state, set per test -----------------------------------------------
const stub = {
  object: {} as ResolvedObject,
  source: "",
  method: undefined as MethodSource | undefined,
  members: [] as ClassMember[],
  badiImplementation: undefined as BadiImplementationDocument | undefined,
  sourceCodePlugin: undefined as SourceCodePluginDocument | undefined,
  enhancementSpot: undefined as EnhancementSpotDocument | undefined,
};

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => stub.object,
}));

vi.mock("../src/adt/source.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/source.js")>()),
  readSource: async () => ({ source: stub.source, serverEtag: '"W/etag"' }),
  classMembers: async () => stub.members,
  readMethod: async () => stub.method!,
}));

vi.mock("../src/adt/enhancement.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/enhancement.js")>()),
  readBadiImplementation: async () => stub.badiImplementation!,
  readSourceCodePlugin: async () => stub.sourceCodePlugin!,
  readEnhancementSpot: async () => stub.enhancementSpot!,
}));

const { abapRead } = await import("../src/tools/read.js");
const { abapSearch } = await import("../src/tools/search.js");

function resolved(over: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "CLAS/OC",
    kind: "CLAS",
    label: "class",
    name: "ZCL_BIG",
    uri: "/sap/bc/adt/oo/classes/zcl_big",
    mode: "source",
    activation: "unknown",
    spec: {},
    ...over,
  } as unknown as ResolvedObject;
}

const conn = { cfg: { sid: "A4H" } } as unknown as AbapConnection;

beforeEach(() => {
  stub.object = resolved();
  stub.source = "";
  stub.method = undefined;
  stub.members = [];
  stub.badiImplementation = undefined;
  stub.sourceCodePlugin = undefined;
  stub.enhancementSpot = undefined;
});

// ---------------------------------------------------------------------------
// Paging a method to completion.
// ---------------------------------------------------------------------------

describe("abap_read method paging terminates and covers every line once", () => {
  /** 400-line method body, each line individually identifiable. */
  const BODY = Array.from({ length: 400 }, (_, i) => `  line ${String(i + 1).padStart(4, "0")}`);

  beforeEach(() => {
    stub.source = ["CLASS zcl_big DEFINITION.", ...BODY, "ENDCLASS."].join("\n");
    stub.method = {
      member: { name: "CALCULATE", type: "CLAS/OM", visibility: "public" },
      declaration: "  METHODS calculate.",
      implementation: BODY.join("\n"),
      // Deliberately ABSOLUTE, and deliberately far from 1: this is exactly the
      // number that used to be handed to the compactor as `bodyOffset` while
      // the total stayed relative to the method block.
      implementationRange: { startLine: 2, endLine: 401 },
    };
  });

  it("pages to the end without repeating or skipping a line", async () => {
    const seen: string[] = [];
    let offset = 1;
    let pages = 0;
    for (;;) {
      pages += 1;
      expect(pages, "paging did not terminate").toBeLessThan(50);
      const r = await abapRead(conn, { object: "ZCL_BIG", method: "CALCULATE", offset }, 1200);
      const block = r.text.split("--- METHOD SOURCE ---\n")[1]!.split("\n\n---")[0]!;
      seen.push(...block.split("\n"));
      if (!r.hasMore) {
        // Termination must be stated in the payload, not only in a flag.
        expect(r.text).toContain("This is the last chunk.");
        expect(r.text).not.toMatch(/offset=\d+ \(/);
        break;
      }
      const next = Number(/offset=(\d+)/.exec(r.text)![1]);
      expect(next, "offset must advance").toBeGreaterThan(offset);
      offset = next;
    }
    expect(pages).toBeGreaterThan(1);
    // Declaration + blank separator + the 400 body lines, each exactly once.
    expect(seen).toEqual(["  METHODS calculate.", "", ...BODY]);
  });

  it("reports the returned range in the SAME frame as the offset it asks for", async () => {
    const r = await abapRead(conn, { object: "ZCL_BIG", method: "CALCULATE" }, 1200);
    const m = /Returned lines (\d+)\.\.(\d+) of (\d+)/.exec(r.text)!;
    const [from, to, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
    expect(from).toBe(1);
    // The pre-fix bug: from/to were absolute (250..289) while total was the
    // method-block length (402) — "lines 250..289 of 402" of nothing.
    expect(to).toBeLessThanOrEqual(total);
    expect(total).toBe(402);
    // The absolute position is still reported, but as orientation only.
    expect(r.text).toContain("sourceLines: 2-401");
  });

  it("honours offset on the method path at all", async () => {
    const r = await abapRead(conn, { object: "ZCL_BIG", method: "CALCULATE", offset: 100 }, 4000);
    const block = r.text.split("--- METHOD SOURCE ---\n")[1]!.split("\n\n---")[0]!;
    // Block line 100 is body line 98 (decl, blank, then the body).
    expect(block.split("\n")[0]).toBe("  line 0098");
  });
});

// ---------------------------------------------------------------------------
// Outline on something that has no outline.
// ---------------------------------------------------------------------------

describe("abap_read outline says what is actually true", () => {
  it("does not claim a report has no components", async () => {
    stub.object = resolved({ type: "PROG/P", kind: "PROG", name: "ZREPORT" });
    stub.source = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const r = await abapRead(conn, { object: "ZREPORT", outline: true }, 20_000);
    expect(r.text).not.toContain("(no components)");
    expect(r.text).toMatch(/outline is NOT SUPPORTED for PROG\/P/);
    expect(r.text).toMatch(/NOT a statement that ZREPORT has no components/);
  });

  it("still says 'really has no components' when a class genuinely has none", async () => {
    stub.object = resolved({ name: "ZCL_EMPTY" });
    stub.source = "CLASS zcl_empty DEFINITION.\nENDCLASS.";
    stub.members = [];
    const r = await abapRead(conn, { object: "ZCL_EMPTY", outline: true }, 20_000);
    expect(r.text).toMatch(/really has no methods, attributes or events/);
  });
});

// ---------------------------------------------------------------------------
// abap_search.
// ---------------------------------------------------------------------------

function searchConn(handlers: {
  searchObject?: (q: string, group?: string, max?: number) => Promise<unknown[]>;
  usageReferences?: () => Promise<unknown[]>;
}): AbapConnection {
  return {
    cfg: { sid: "A4H" },
    adt: {
      searchObject: handlers.searchObject ?? (async () => []),
      usageReferences: handlers.usageReferences ?? (async () => []),
    },
  } as unknown as AbapConnection;
}

describe("abap_search discloses how many rows its local type filter dropped", () => {
  /** 50 hits, only 3 of them classes: the filter removes 47 of 50. */
  const HITS = [
    ...Array.from({ length: 3 }, (_, i) => ({
      "adtcore:type": "CLAS/OC",
      "adtcore:name": `ZCL_HIT_${i}`,
      "adtcore:packageName": "ZPKG",
      "adtcore:description": "a class",
    })),
    ...Array.from({ length: 47 }, (_, i) => ({
      "adtcore:type": "PROG/P",
      "adtcore:name": `ZPROG_${i}`,
      "adtcore:packageName": "ZPKG",
      "adtcore:description": "a report",
    })),
  ];

  it("says how many the server sent and how many were dropped locally", async () => {
    const r = await abapSearch(
      searchConn({ searchObject: async () => HITS }),
      { query: "Z*", type: "CLAS/OC", max: 50 },
      20_000,
    );
    expect(r.text).toMatch(/UNDER-REPORTED/);
    expect(r.text).toContain("The server returned 50 hit(s)");
    expect(r.text).toContain("47 were dropped here");
    expect(r.text).toContain("serverHits: 50");
    expect(r.text).toContain("droppedByTypeFilter: 47");
    // "matches: 3" must never stand alone as the answer.
    expect(r.text).toContain("matches: 3");
  });

  it("does not claim zero matches means zero objects when the fetch window was not full", async () => {
    // type given, max=47 -> fetchMax = min(1000, 47*10) = 470; 47 rows back is well under that.
    const r = await abapSearch(
      searchConn({ searchObject: async () => HITS.slice(3) }),
      { query: "Z*", type: "CLAS/OC", max: 47 },
      20_000,
    );
    expect(r.text).not.toBe("(no matches)");
    expect(r.text).toMatch(/window \(max=470\) was not full/);
    expect(r.text).toMatch(/every object of any type matching this pattern/);
    expect(r.text).not.toMatch(/NOT proof that none exist/);
  });

  it("still warns a zero-row result is not proof none exist when the fetch window came back full", async () => {
    // type given, max=2 -> fetchMax = min(1000, 2*10) = 20; return exactly 20 non-matching rows.
    const FULL_WINDOW = Array.from({ length: 20 }, (_, i) => ({
      "adtcore:type": "PROG/P",
      "adtcore:name": `ZFULL_${i}`,
      "adtcore:packageName": "ZPKG",
      "adtcore:description": "a report",
    }));
    const r = await abapSearch(
      searchConn({ searchObject: async () => FULL_WINDOW }),
      { query: "Z*", type: "CLAS/OC", max: 2 },
      20_000,
    );
    expect(r.text).toMatch(/NOT proof that none exist/);
    expect(r.text).not.toBe("(no matches)");
  });

  it("stays quiet when nothing was filtered out", async () => {
    const r = await abapSearch(
      searchConn({ searchObject: async () => HITS.slice(0, 3) }),
      { query: "Z*", type: "CLAS/OC", max: 50 },
      20_000,
    );
    expect(r.text).not.toMatch(/UNDER-REPORTED/);
  });

  it("never advertises an offset parameter abap_search does not have", async () => {
    const r = await abapSearch(
      searchConn({ searchObject: async () => HITS }),
      { query: "Z*", max: 50 },
      20_000,
    );
    expect(r.text).not.toMatch(/offset=\d+/);
  });
});

describe("abap_search where_used discloses its display cap", () => {
  const REFS = Array.from({ length: 120 }, (_, i) => ({
    "adtcore:type": "CLAS/OC",
    "adtcore:name": `ZCL_USER_${i}`,
    "adtcore:description": "uses it",
    packageRef: { "adtcore:name": "ZPKG" },
  }));

  it("reports the true total and the number withheld", async () => {
    const r = await abapSearch(
      searchConn({ usageReferences: async () => REFS }),
      { query: "class ZCL_BIG", mode: "where_used", max: 50 },
      20_000,
    );
    expect(r.text).toContain("referencesShown: 50");
    expect(r.text).toContain("referencesTotal: 120");
    expect(r.text).toMatch(/CAPPED: ADT returned 120 reference\(s\)/);
    expect(r.text).toContain("70 reference(s) are NOT listed");
    // The cut is marked where the rows stop, not only in the notes.
    expect(r.text).toMatch(/--- TRUNCATED --- 70 of 120 reference\(s\) not shown/);
    expect(r.text.match(/ZCL_USER_\d+/g)!.length).toBe(50);
  });

  // Wire-verified on A4H that ADT's usageReferences endpoint honours no
  // server-side limit parameter — the fetch is unavoidably unbounded, so the
  // cap is disclosed as a display cap applied after the full fetch, not
  // silently presented as the whole story.
  it("discloses that the cap is applied after an unbounded fetch, not during it", async () => {
    const r = await abapSearch(
      searchConn({ usageReferences: async () => REFS }),
      { query: "class ZCL_BIG", mode: "where_used", max: 50 },
      20_000,
    );
    expect(r.text).toMatch(/applied AFTER the full fetch/);
    expect(r.text).toContain("all 120 reference(s) were already retrieved");
  });

  it("does not cry cap when everything fits", async () => {
    const r = await abapSearch(
      searchConn({ usageReferences: async () => REFS.slice(0, 10) }),
      { query: "class ZCL_BIG", mode: "where_used", max: 50 },
      20_000,
    );
    expect(r.text).not.toMatch(/CAPPED/);
    expect(r.text).toContain("referencesShown: 10");
    expect(r.text).toContain("referencesTotal: 10");
  });

  it("counts grouping nodes out of the total instead of into it", async () => {
    const withGroups = [{ "adtcore:type": "DEVC/K", packageRef: {} }, ...REFS.slice(0, 5)];
    const r = await abapSearch(
      searchConn({ usageReferences: async () => withGroups }),
      { query: "class ZCL_BIG", mode: "where_used", max: 50 },
      20_000,
    );
    expect(r.text).toContain("referencesTotal: 5");
  });
});

/**
 * `version` used to be an untyped extra property silently stripped by
 * zod (`z.core.$strip`) — a bogus value fell through to whatever ADT reports
 * as current, with no signal that anything was ignored. The bogus-value
 * rejection itself now happens at the MCP SDK's schema boundary (see
 * test/tools.test.ts, which calls through the real server and can observe
 * "zero requests reached the wire"); this file calls `abapRead` directly, so
 * what is left to prove here is the in-handler half — which now splits in
 * two. `version="active"` on a DDIC object is accepted as the no-op it
 * already is: a DDIC read always renders the current definition, which is
 * exactly what "active" names, so nothing is rewritten — the acceptance is
 * only disclosed in a response note. `version="inactive"` is still refused:
 * it asserts a state the pseudo-DDL renderer has no concept of at all.
 */
describe("abap_read version parameter", () => {
  it('accepts version="active" on a DDIC object as a no-op and discloses it in a note', async () => {
    stub.object = resolved({
      mode: "ddic",
      type: "TABL/DT",
      kind: "TABL",
      name: "ZMCP_TABLE",
      uri: "/sap/bc/adt/ddic/tables/zmcp_table",
    } as unknown as Partial<ResolvedObject>);
    const ddicConn = {
      cfg: { sid: "A4H" },
      get: async () => ({
        body: "define table zmcp_table {\n  key mandt : mandt not null;\n}",
      }),
    } as unknown as AbapConnection;
    const r = await abapRead(
      ddicConn,
      { object: "ZMCP_TABLE", version: "active" } as never,
      20_000,
    );
    expect(r.text).toContain('version="active" had no effect here');
  });

  it('refuses version="inactive" on a DDIC object instead of silently ignoring it', async () => {
    stub.object = resolved({
      mode: "ddic",
      type: "TABL/DT",
      kind: "TABL",
      name: "ZMCP_TABLE",
    } as unknown as Partial<ResolvedObject>);
    await expect(
      abapRead(conn, { object: "ZMCP_TABLE", version: "inactive" } as never, 20_000),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("inactive"),
    });
  });

  it("still reads normally when version is omitted (no regression on the default path)", async () => {
    stub.object = resolved();
    stub.source = "REPORT zcl_big.";
    const r = await abapRead(conn, { object: "ZCL_BIG" } as never, 20_000);
    expect(r.text).toContain("REPORT zcl_big.");
  });
});

// ---------------------------------------------------------------------------
// abap_read gains `enhancements`.
// ---------------------------------------------------------------------------

describe("abap_read enhancements=true", () => {
  it("refuses enhancements=true on an object that isn't ENHO/ENHS", async () => {
    stub.object = resolved(); // CLAS/OC
    await expect(
      abapRead(conn, { object: "ZCL_BIG", enhancements: true } as never, 20_000),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("decodes an ENHO/XH BAdI implementation and prints the implementing class pasteably", async () => {
    stub.object = resolved({
      type: "ENHO/XH",
      kind: "ENHO/XH",
      name: "ZIMPL_ONE",
      mode: "ddic",
    } as unknown as Partial<ResolvedObject>);
    stub.badiImplementation = {
      xml: "<enho:objectData/>",
      data: {
        name: "ZIMPL_ONE",
        type: "ENHO/XH",
        toolType: "BADI_IMPL",
        activationStatus: "active",
        implementations: [
          {
            name: "ZIMPL_ONE",
            shortText: "Test implementation",
            isActive: true,
            isDefault: false,
            isCustomizingSupported: false,
            enhancementSpot: { type: "ENHS/XS", name: "ZSPOT" },
            badiDefinition: { type: "ENHS", name: "ZBADI_DEF" },
            implementingClass: { type: "CLAS/OC", name: "ZCL_MY_IMPL" },
          },
        ],
      },
    } as BadiImplementationDocument;

    const r = await abapRead(conn, { object: "ZIMPL_ONE", enhancements: true } as never, 20_000);
    expect(r.text).toContain("implementing class: ZCL_MY_IMPL");
    expect(r.text).toContain('paste into abap_debug as object: "class ZCL_MY_IMPL"');
    expect(r.text).toContain("IMPLEMENTATION: ZIMPL_ONE");
  });

  // Regression for the L17/ZTM_HW011B_IMPL field report: a caller read this
  // exact combination live (activationStatus:'inactive' at the document
  // level, isActive:'true' on the implementation entry) and had to reason it
  // out unaided — abap_read printed both fields but never said they
  // disagreed. This is the "catch the eighth instance" half of the fix: the
  // isActive-vs-adtcore:version split should be loud on READ regardless of
  // which create/write path left an object in this state.
  it("flags a loud warning when the document's adtcore:version is inactive but an implementation's own isActive reads true", async () => {
    stub.object = resolved({
      type: "ENHO/XH",
      kind: "ENHO/XH",
      name: "ZTM_HW011B_IMPL",
      mode: "ddic",
    } as unknown as Partial<ResolvedObject>);
    stub.badiImplementation = {
      xml: "<enho:objectData/>",
      data: {
        name: "ZTM_HW011B_IMPL",
        type: "ENHO/XH",
        toolType: "BADI_IMPL",
        activationStatus: "inactive",
        implementations: [
          {
            name: "ZTM_HW011B_IMPL",
            isActive: true,
            isDefault: false,
            isCustomizingSupported: false,
            implementingClass: { type: "CLAS/OC", name: "ZTM_CL_HW011B_IMPL" },
          },
        ],
      },
    } as BadiImplementationDocument;

    const r = await abapRead(conn, { object: "ZTM_HW011B_IMPL", enhancements: true } as never, 20_000);
    expect(r.text).toMatch(/INACTIVE/);
    expect(r.text).toContain("isActive");
    expect(r.text).toContain("adtcore:version");
  });

  it("does NOT warn when activationStatus and isActive agree (both active)", async () => {
    stub.object = resolved({
      type: "ENHO/XH",
      kind: "ENHO/XH",
      name: "ZIMPL_OK",
      mode: "ddic",
    } as unknown as Partial<ResolvedObject>);
    stub.badiImplementation = {
      xml: "<enho:objectData/>",
      data: {
        name: "ZIMPL_OK",
        type: "ENHO/XH",
        toolType: "BADI_IMPL",
        activationStatus: "active",
        implementations: [
          { name: "ZIMPL_OK", isActive: true, isDefault: false, isCustomizingSupported: false },
        ],
      },
    } as BadiImplementationDocument;

    const r = await abapRead(conn, { object: "ZIMPL_OK", enhancements: true } as never, 20_000);
    expect(r.text).not.toMatch(/INACTIVE/);
  });

  it("renders a filter tree and flags its ordering as unverified", async () => {
    stub.object = resolved({
      type: "ENHO/XH",
      kind: "ENHO/XH",
      name: "ZIMPL_FILTERED",
      mode: "ddic",
    } as unknown as Partial<ResolvedObject>);
    stub.badiImplementation = {
      xml: "<enho:objectData/>",
      data: {
        name: "ZIMPL_FILTERED",
        type: "ENHO/XH",
        implementations: [
          {
            name: "ZIMPL_FILTERED",
            filterTree: {
              kind: "and",
              children: [
                { kind: "filter", condition: { filterName: "CARRID", comparator1: "=", value1: "LH" } },
              ],
            },
          },
        ],
      },
    } as BadiImplementationDocument;

    const r = await abapRead(
      conn,
      { object: "ZIMPL_FILTERED", enhancements: true } as never,
      20_000,
    );
    expect(r.text).toContain("CARRID = LH");
    expect(r.text).toMatch(/UNVERIFIED/);
  });

  it("decodes an ENHO/XHH source-code plug-in's hook metadata", async () => {
    stub.object = resolved({
      type: "ENHO/XHH",
      kind: "ENHO/XHH",
      name: "ZHOOK_ONE",
      mode: "source",
    } as unknown as Partial<ResolvedObject>);
    stub.sourceCodePlugin = {
      xml: "<enho:enhancement/>",
      data: {
        name: "ZHOOK_ONE",
        type: "ENHO/XHH",
        toolType: "HOOK_IMPL",
        usages: [],
        hookImplementations: [
          {
            id: "1",
            spotName: "SEU_TEST_CLASS_SPOT",
            programName: "CL_SPOT_ENH_TEMPLATE_001",
            method: "CP",
            fullName: "\\PR:CL_SPOT_ENH_TEMPLATE_001======CP\\EX:SEU_TEST_CLASS_SPOT_0000001\\EI",
          },
        ],
      },
    } as SourceCodePluginDocument;

    const r = await abapRead(conn, { object: "ZHOOK_ONE", enhancements: true } as never, 20_000);
    expect(r.text).toContain("HOOK: 1");
    expect(r.text).toContain("spot: SEU_TEST_CLASS_SPOT");
    expect(r.text).toContain("anchor:");
  });

  it("decodes an ENHS enhancement spot and its BAdI definitions", async () => {
    stub.object = resolved({
      type: "ENHS/XS",
      kind: "ENHS",
      name: "ZSPOT_ONE",
      mode: "ddic",
    } as unknown as Partial<ResolvedObject>);
    stub.enhancementSpot = {
      xml: "<enhs:objectData/>",
      data: {
        name: "ZSPOT_ONE",
        type: "ENHS/XS",
        toolType: "BADI_DEF",
        badiDefinitions: [
          {
            name: "ZBADI_DEF",
            shorttext: "Test BAdI",
            singleUse: true,
            filters: [{ filterName: "CARRID", filterType: "S", shorttext: "Carrier" }],
          },
        ],
      },
    } as EnhancementSpotDocument;

    const r = await abapRead(conn, { object: "ZSPOT_ONE", enhancements: true } as never, 20_000);
    expect(r.text).toContain("BADI DEFINITION: ZBADI_DEF");
    expect(r.text).toContain("CARRID");
  });

  it("flags an empty enhsxs document as possibly hook-flavoured and unverified", async () => {
    stub.object = resolved({
      type: "ENHS/XS",
      kind: "ENHS",
      name: "ZSPOT_EMPTY",
      mode: "ddic",
    } as unknown as Partial<ResolvedObject>);
    stub.enhancementSpot = {
      xml: "<enhs:objectData/>",
      data: { name: "ZSPOT_EMPTY", type: "ENHS/XS", badiDefinitions: [] },
    } as EnhancementSpotDocument;

    const r = await abapRead(conn, { object: "ZSPOT_EMPTY", enhancements: true } as never, 20_000);
    expect(r.text).toMatch(/hook-flavoured/);
    expect(r.text).toMatch(/UNVERIFIED/);
  });

  // -------------------------------------------------------------------------
  // Gap 1 — `adjustmentStatus` was parsed by enhancement-xml.ts but never
  // surfaced by abap_read: the only place a caller could ever see it was a
  // post-hoc hint attached to a FAILED write. Both fixtures below are real
  // A4H captures,
  // decoded through the real parser (not hand-typed data), matching the
  // task's own naming of these exact two files as the canonical adjustment-
  // status states.
  // -------------------------------------------------------------------------

  it("surfaces a non-empty adjustmentStatus for an ENHO/XH BAdI implementation (fixture 470)", async () => {
    const xml = readFixture("470-enhoxh-with-filter.xml");
    stub.object = resolved({
      type: "ENHO/XH",
      kind: "ENHO/XH",
      name: "ZMCP_BADI_I1",
      mode: "ddic",
    } as unknown as Partial<ResolvedObject>);
    stub.badiImplementation = { xml, data: parseBadiImplementation(xml) };

    const r = await abapRead(conn, { object: "ZMCP_BADI_I1", enhancements: true } as never, 20_000);
    expect(r.text).toContain("adjustmentStatus: adjusted");
  });

  it("surfaces an empty adjustmentStatus visibly, not silently dropped, for an ENHO/XH BAdI implementation (fixture 354)", async () => {
    const xml = readFixture("354-enhoxh-no-filter.xml");
    stub.object = resolved({
      type: "ENHO/XH",
      kind: "ENHO/XH",
      name: "ZMCP_BADI_I1",
      mode: "ddic",
    } as unknown as Partial<ResolvedObject>);
    stub.badiImplementation = { xml, data: parseBadiImplementation(xml) };

    // Sanity check on the fixture itself: this must be the empty-status capture.
    expect(stub.badiImplementation.data.adjustmentStatus).toBe("");

    const r = await abapRead(conn, { object: "ZMCP_BADI_I1", enhancements: true } as never, 20_000);
    // `renderHeader` drops "" like undefined for every other field — this one
    // field is deliberately rewritten to a visible placeholder first, since
    // "" is the actionable, non-nominal state the write-path hint cares about.
    expect(r.text).toContain("adjustmentStatus: (empty)");
  });

  it("surfaces adjustmentStatus for an ENHO/XHH source-code plug-in (fixture 021)", async () => {
    const xml = readFixture("021-enhoxhh-fm-hook-with-switch.xml");
    stub.object = resolved({
      type: "ENHO/XHH",
      kind: "ENHO/XHH",
      name: "ZMCP_ENH_T6",
      mode: "source",
    } as unknown as Partial<ResolvedObject>);
    stub.sourceCodePlugin = { xml, data: parseSourceCodePlugin(xml) };

    const r = await abapRead(conn, { object: "ZMCP_ENH_T6", enhancements: true } as never, 20_000);
    expect(r.text).toContain("adjustmentStatus: adjusted");
  });

  // -------------------------------------------------------------------------
  // Eighth instance of this project's "two structures that must agree about
  // one fact, nothing ties them together" defect class: `baseHeader.description`
  // (`obj.description`, from the ADT search index) and the enhancement
  // document's OWN root `adtcore:description` (the field
  // ENHANCEMENT_DESCRIPTION_REQUIRED actually gates on) are read from two
  // independent places and used to disagree silently. Fixtures 019/021 (real
  // ENHO/XHH captures) are the only enhancement fixtures with a non-empty
  // root description; fixtures 354/343 (real ENHO/XH and ENHS/XS captures)
  // both genuinely lack one — same convention as the adjustmentStatus tests
  // above: real captured bytes through the real parser, never hand-typed.
  // -------------------------------------------------------------------------

  it("makes the document's own description authoritative in the header, overriding the search-index value, and surfaces the index value under a distinct key with a note (ENHO/XHH, fixture 019)", async () => {
    const xml = readFixture("019-enhoxhh-class-hook.xml");
    stub.object = resolved({
      type: "ENHO/XHH",
      kind: "ENHO/XHH",
      name: "SEU_TEST_CLS_ENH_IMPL_TEMPLATE",
      mode: "source",
      // The search index reports a DIFFERENT description than the document's
      // own root adtcore:description ("unit test template for enhancement
      // implementation", verified below) — this is the disagreement shape
      // itself, not merely "one side is empty".
      description: "stale index description",
    } as unknown as Partial<ResolvedObject>);
    const data = parseSourceCodePlugin(xml);
    expect(data.description).toBe("unit test template for enhancement implementation");
    stub.sourceCodePlugin = { xml, data };

    const r = await abapRead(
      conn,
      { object: "SEU_TEST_CLS_ENH_IMPL_TEMPLATE", enhancements: true } as never,
      20_000,
    );
    // The document's own description wins under the `description` key...
    expect(r.text).toContain("description: unit test template for enhancement implementation");
    expect(r.text).not.toContain("description: stale index description");
    // ...but the index value is not silently discarded — it's shown under a
    // distinct key...
    expect(r.text).toContain("searchIndexDescription: stale index description");
    // ...with a note saying which one governs writes. (The note legitimately
    // names ENHANCEMENT_DESCRIPTION_REQUIRED as the mechanism that cares
    // which value governs — that is not the loud "your next write will
    // refuse" note, which only fires when the document description itself
    // is empty; assert that one's specific trigger phrase is absent instead.)
    expect(r.text).toMatch(/document's own value governs writes/);
    expect(r.text).not.toMatch(/next write or abap_activate call on this object will refuse/);
  });

  it("renders an absent document description as (empty) rather than dropping it, and emits a loud ENHANCEMENT_DESCRIPTION_REQUIRED note naming the exact remedy (ENHO/XH, fixture 354)", async () => {
    const xml = readFixture("354-enhoxh-no-filter.xml");
    const data = parseBadiImplementation(xml);
    // Sanity check on the fixture: this is the genuinely-empty-description capture.
    expect(data.description).toBeUndefined();
    stub.object = resolved({
      type: "ENHO/XH",
      kind: "ENHO/XH",
      name: "ZMCP_ENH_BADI",
      mode: "ddic",
      // A search index CAN carry a value while the document root has none —
      // exercise that combination too, not just "both empty".
      description: "ZMCP recon BAdI implementation",
    } as unknown as Partial<ResolvedObject>);
    stub.badiImplementation = { xml, data };

    const r = await abapRead(conn, { object: "ZMCP_ENH_BADI", enhancements: true } as never, 20_000);
    // renderHeader drops "" and undefined for every other field — this one is
    // deliberately rewritten to a visible placeholder, same reasoning as
    // adjustmentStatus, because blank is the actionable state.
    expect(r.text).toContain("description: (empty)");
    expect(r.text).toContain("searchIndexDescription: ZMCP recon BAdI implementation");
    // The loud note: names the error code, names set_impl_active by name as
    // an example of an UNRELATED write that still refuses, and names the
    // exact remedy operation.
    expect(r.text).toContain("ENHANCEMENT_DESCRIPTION_REQUIRED");
    expect(r.text).toMatch(/set_impl_active/);
    expect(r.text).toContain('operation:"write_description"');
  });

  it("emits the same ENHANCEMENT_DESCRIPTION_REQUIRED note for an enhancement-spot (ENHS) document with no root description (fixture 343)", async () => {
    const xml = readFixture("343-enhsxs-no-filters.xml");
    const data = parseEnhancementSpot(xml);
    expect(data.description).toBeUndefined();
    stub.object = resolved({
      type: "ENHS/XS",
      kind: "ENHS",
      name: "ZMCP_SPOT",
      mode: "ddic",
    } as unknown as Partial<ResolvedObject>);
    stub.enhancementSpot = { xml, data };

    const r = await abapRead(conn, { object: "ZMCP_SPOT", enhancements: true } as never, 20_000);
    expect(r.text).toContain("description: (empty)");
    expect(r.text).toContain("ENHANCEMENT_DESCRIPTION_REQUIRED");
    expect(r.text).toContain('operation:"write_description"');
  });

  it("does NOT warn or surface a second key when the document's own description is non-empty and the search index agrees (or is absent)", async () => {
    const xml = readFixture("021-enhoxhh-fm-hook-with-switch.xml");
    const data = parseSourceCodePlugin(xml);
    expect(data.description).toBe("Enhancement to get value of IBASE ILM switch");
    stub.object = resolved({
      type: "ENHO/XHH",
      kind: "ENHO/XHH",
      name: "IBASE_SWITCH_CHECK_IM",
      mode: "source",
      // No search-index description at all in this test.
    } as unknown as Partial<ResolvedObject>);
    stub.sourceCodePlugin = { xml, data };

    const r = await abapRead(conn, { object: "IBASE_SWITCH_CHECK_IM", enhancements: true } as never, 20_000);
    expect(r.text).toContain("description: Enhancement to get value of IBASE ILM switch");
    expect(r.text).not.toContain("searchIndexDescription");
    expect(r.text).not.toContain("ENHANCEMENT_DESCRIPTION_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// format="raw" — the gap this session closes: DOMA/DTEL/TTYP/MSAG/ENQU write
// a full XML descriptor PUT to their own URI (capabilities.ts write.shape
// "properties"), so "read one to see the shape" needs the wire document
// itself, not the lossy pseudo-DDL rendering. Gated off the registry
// (capabilitiesFor), not a type list.
// ---------------------------------------------------------------------------
describe('abap_read format="raw"', () => {
  it("returns the object's own XML descriptor, unmodified, for a properties-shape type", async () => {
    const xml = '<doma:domain xmlns:doma="x" adtcore:name="ZDOM" adtcore:type="DOMA/DD"/>';
    const rawConn = {
      cfg: { sid: "A4H" },
      get: async (uri: string, opts?: { headers?: Record<string, string> }) => {
        expect(uri).toBe("/sap/bc/adt/ddic/domains/zdom");
        expect(opts?.headers?.Accept).toBe("application/*");
        return { body: xml, status: 200, headers: {} };
      },
    } as unknown as AbapConnection;
    stub.object = resolved({
      type: "DOMA/DD",
      kind: "DOMA",
      name: "ZDOM",
      uri: "/sap/bc/adt/ddic/domains/zdom",
      mode: "ddic",
    } as unknown as Partial<ResolvedObject>);

    const r = await abapRead(rawConn, { object: "ZDOM", format: "raw" } as never, 20_000);
    expect(r.text).toContain(xml);
    // Never the pseudo-DDL renderer's own labelling.
    expect(r.text).not.toContain("PSEUDO-DDL");
  });

  it("works for a type readDdic cannot render at all today (MSAG/N)", async () => {
    const xml = '<mc:messageClass xmlns:mc="x" adtcore:name="ZMSG" adtcore:type="MSAG/N"/>';
    const rawConn = {
      cfg: { sid: "A4H" },
      get: async () => ({ body: xml, status: 200, headers: {} }),
    } as unknown as AbapConnection;
    stub.object = resolved({
      type: "MSAG/N",
      kind: "MSAG",
      name: "ZMSG",
      uri: "/sap/bc/adt/messageclass/zmsg",
      mode: "ddic",
    } as unknown as Partial<ResolvedObject>);

    const r = await abapRead(rawConn, { object: "ZMSG", format: "raw" } as never, 20_000);
    expect(r.text).toContain(xml);
  });

  it('rejects format="raw" for a source-shape type, naming the fix', async () => {
    stub.object = resolved({ type: "CLAS/OC", kind: "CLAS", name: "ZCL_BIG" });
    await expect(
      abapRead(conn, { object: "ZCL_BIG", format: "raw" } as never, 20_000),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it('rejects format="raw" for a source-based DDIC type (TABL/DT)', async () => {
    stub.object = resolved({
      type: "TABL/DT",
      kind: "TABL",
      name: "ZTAB",
      mode: "ddic",
    } as unknown as Partial<ResolvedObject>);
    await expect(
      abapRead(conn, { object: "ZTAB", format: "raw" } as never, 20_000),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it('rejects format="raw" combined with version, rather than silently ignoring one', async () => {
    stub.object = resolved({
      type: "DOMA/DD",
      kind: "DOMA",
      name: "ZDOM",
      mode: "ddic",
    } as unknown as Partial<ResolvedObject>);
    await expect(
      abapRead(conn, { object: "ZDOM", format: "raw", version: "active" } as never, 20_000),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  // Observed failure: denied a read of MSAG/N with a
  // message that only listed what WAS renderable, an agent guessed the write
  // XML's attribute names wrong (`mc:number`/`mc:text` instead of
  // `mc:msgno`/`mc:msgtext`) and failed 8 consecutive abap_write calls. The
  // default (non-raw) read still can't render MSAG/N as pseudo-DDL — nothing
  // changed there — but the refusal must now name the working alternative.
  it('points a default-mode read of a properties-shape type readDdic cannot render at format="raw"', async () => {
    stub.object = resolved({
      type: "MSAG/N",
      kind: "MSAG",
      name: "ZMSG",
      uri: "/sap/bc/adt/messageclass/zmsg",
      mode: "ddic",
    } as unknown as Partial<ResolvedObject>);
    await expect(abapRead(conn, { object: "ZMSG" } as never, 20_000)).rejects.toMatchObject({
      code: "UNSUPPORTED",
      hint: expect.stringContaining('format: "raw"'),
    });
  });

  it('does not add the format:"raw" hint for a type that has no raw path either (ENHS/XS)', async () => {
    stub.object = resolved({
      type: "ENHS/XS",
      kind: "ENHS",
      name: "ZSPOT",
      mode: "ddic",
    } as unknown as Partial<ResolvedObject>);
    const err = await abapRead(conn, { object: "ZSPOT" } as never, 20_000).catch((e) => e as AbapError);
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.hint ?? "").not.toContain('format: "raw"');
  });

  // Live-discovered defect (MSAG/N "SY", 321,475 real characters, zero
  // newlines): compact.ts's stock sliceLines/keepLines windowing is strictly
  // newline-based, so a single unbroken line longer than the character budget
  // was dropped ENTIRELY ("0 of 1 line(s)") with no offset able to ever reach
  // it. format="raw" windows the body itself, by CHARACTER, before handing it
  // to buildResponse, so a large single-line document is still readable in
  // successive chunks. This fixture (well over the default window) pins that
  // behavior without a live call.
  it('windows a large single-line document by character, and pages to the end', async () => {
    const prefix = '<mc:messageClass xmlns:mc="x" adtcore:name="ZBIG" adtcore:type="MSAG/N">';
    const filler = "A".repeat(100_000); // one unbroken line, no newlines at all
    const suffix = "</mc:messageClass>";
    const xml = prefix + filler + suffix;
    const rawConn = {
      cfg: { sid: "A4H" },
      get: async () => ({ body: xml, status: 200, headers: {} }),
    } as unknown as AbapConnection;
    stub.object = resolved({
      type: "MSAG/N",
      kind: "MSAG",
      name: "ZBIG",
      uri: "/sap/bc/adt/messageclass/zbig",
      mode: "ddic",
    } as unknown as Partial<ResolvedObject>);

    // maxChars=20_000 forces defaultWindowChars = max(1000, 20_000-6000) = 14_000,
    // well under xml.length, so the first call must window rather than return everything.
    const first = await abapRead(rawConn, { object: "ZBIG", format: "raw" } as never, 20_000);
    expect(first.text).toContain(prefix);
    expect(first.text).not.toContain(suffix); // truncated before the closing tag
    expect(first.text).toMatch(/showing 1-\d+ of \d+/);
    const m = first.text.match(/offset=(\d+)/);
    expect(m).not.toBeNull();
    const nextOffset = Number(m![1]);
    expect(nextOffset).toBeGreaterThan(1);

    // Walk the whole document via reported offsets and confirm it reassembles
    // exactly, with no gap or overlap at each seam.
    let offset = 1;
    let reassembled = "";
    for (let guard = 0; guard < 50; guard++) {
      const r = await abapRead(rawConn, { object: "ZBIG", format: "raw", offset } as never, 20_000);
      const body = r.text.slice(r.text.indexOf("--- XML DESCRIPTOR ---\n") + "--- XML DESCRIPTOR ---\n".length);
      reassembled += body;
      const nm = r.text.match(/offset=(\d+)/);
      if (!nm) break; // last chunk: no "fetch the rest" notice
      offset = Number(nm[1]);
    }
    expect(reassembled).toBe(xml);
  });
});
