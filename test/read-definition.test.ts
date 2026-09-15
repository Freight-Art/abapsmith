/**
 * `abap_read` view="definition" (issue #91) — position-driven "what is this
 * identifier / where is it declared / who implements it" lookup built on
 * `../src/adt/element-info.ts`'s three ADT endpoints (elementinfo,
 * navigation/target, usageReferences).
 *
 * Section A pins every refusal `assertViewCompatible` (in `src/tools/read.ts`)
 * raises for this axis — format=raw, enhancements=true, version=inactive,
 * outline=true, method=, from/to/context, a missing line, line/column on
 * history/diff or with no view at all, and a non-source (ddic-mode) object —
 * plus the one combination that must NOT be refused (version="active"). Every
 * refusal test uses a connection whose `post`/`adt.usageReferences` throw
 * immediately, naming the URL, if ever called — `assertViewCompatible` runs
 * synchronously before any request is issued, so these tests double as a
 * "no network" pin.
 *
 * Section B drives the real rendering path through a fake `AbapConnection`
 * whose `post` answers ONLY the exact `#start=line,column` (elementinfo),
 * `#start=L,C;end=L,C2&filter=definition` (navigation-target), and
 * `#start=L,C` / bare uri (usageReferences) fragments a synthetic 40-line
 * class source actually produces, using the live-captured A4H bytes in
 * `test/fixtures/live-captured/` (891-897, 899, 900 — the `i91-*` captures;
 * there is no 898). `findImplementations` (`src/adt/element-info.ts`) posts
 * `USAGE_REFERENCES_URL` itself and parses the answer with its own
 * `parseUsageReferences`, rather than going through `abap-adt-api`'s own
 * `conn.adt.usageReferences()` (`build/api/syntax.js`): that vendor function
 * hardcodes the fixed path `"usageReferences:referencedObject"` (capital R),
 * while fixture 900's actual wire bytes declare and use the all-lowercase
 * prefix `usagereferences` throughout — feeding fixture 900 through the
 * vendor function returns an EMPTY array, not the two real implementers.
 * This sidesteps that vendor defect in PRODUCTION, not just in this test;
 * the fake connection below answers `USAGE_REFERENCES_URL` with fixture
 * 900's raw bytes verbatim, the same as it does for elementinfo/navigation.
 *
 * The three `NavigationLookup.noTargetReason` wording tests (declaration
 * site / undecidable / unnamed) and the interface-own-declaration
 * implementer-listing test drive `findDefinitionTarget`
 * (`src/adt/element-info.ts`) through a thin override on top of the real
 * function — `stub.definitionLookupOverride`, reset every test — rather than
 * fabricating the underlying HTTP 400/ED263 wire bytes that would produce
 * each reason: that classification (error message → reason) lives in
 * `element-info.ts`, not `read.ts`, and is out of this file's remit.
 *
 * FINDING (reported, not fixed — this task's remit is a new test file only,
 * never `src/tools/read.ts`): `readDefinition`'s SIGNATURE/COMPONENTS choice
 * is dead code for the COMPONENTS branch. `SIGNATURE_COLUMNS` is a strict
 * superset of `COMPONENT_COLUMNS` (`["name","abapType"]` ⊂
 * `["name","paramType","abapType","optional","byValue","paramDefaultValue",
 * "shortText"]`), and `renderChildrenTable`'s "present" test only requires
 * ONE candidate column to appear on ONE child. So whenever a components-only
 * child set (name+abapType, fixture 893: a structure's fields) would make
 * `COMPONENT_COLUMNS` non-empty, `SIGNATURE_COLUMNS` — checked FIRST — is
 * *already* non-empty for the exact same reason, and
 * `const components = signature ? "" : …` never gets to run. The actual,
 * observed behaviour for a TYPE (893) is a section titled "SIGNATURE" (not
 * "COMPONENTS") containing the component table; "COMPONENTS" cannot appear
 * in ANY response this handler produces. The type-rendering tests below
 * assert the real, current behaviour, not the titling the issue brief
 * assumed.
 *
 * NO NETWORK ANYWHERE: `resolveObject` and `readSource` are mocked, and
 * `findDefinitionTarget` is wrapped (see above); every `AbapConnection` used
 * here is a fake whose `post` only answers an exact, pre-registered request
 * and throws — naming the URL — on anything else.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AbapConnection, RawRequestOptions, RawResponse } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import { ELEMENT_INFO_URL, NAVIGATION_TARGET_URL, USAGE_REFERENCES_URL } from "../src/adt/element-info.js";
import { abapReadInputSchema } from "../src/tools/v2/schemas.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/** The three reasons `findDefinitionTarget` can decline to name a target — mirrors `NavigationLookup`/`NoTargetReason` in `src/adt/element-info.ts` (not imported: this file must still compile/run against the pre-CHANGE-1 contract while that module lands). */
type FakeNavigationLookup = {
  readonly target?: { readonly uri: string; readonly line?: number; readonly column?: number };
  readonly noTargetReason?: "declaration-itself" | "undecidable" | "unnamed";
};

// --- stub state, set per test -----------------------------------------------
const stub = {
  object: {} as ResolvedObject,
  source: "",
  sourceUri: "",
  /** Set by the `noTargetReason`/interface-own-declaration tests to bypass the real `findDefinitionTarget` wire entirely; `undefined` (the default) runs the real function against the fake connection's `navTarget` routes, as every other test does. */
  definitionLookupOverride: undefined as FakeNavigationLookup | undefined,
};

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => stub.object,
}));

vi.mock("../src/adt/source.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/source.js")>()),
  readSource: async () => ({ source: stub.source, sourceUri: stub.sourceUri }),
}));

vi.mock("../src/adt/element-info.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/adt/element-info.js")>();
  return {
    ...actual,
    findDefinitionTarget: async (...args: Parameters<typeof actual.findDefinitionTarget>) =>
      stub.definitionLookupOverride ?? actual.findDefinitionTarget(...args),
  };
});

const { abapRead } = await import("../src/tools/read.js");

function resolved(over: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "CLAS/OC",
    kind: "CLAS",
    label: "class",
    name: "ZCL_I91_PROBE",
    uri: "/sap/bc/adt/oo/classes/zcl_i91_probe",
    sourceUri: "/sap/bc/adt/oo/classes/zcl_i91_probe/source/main",
    mode: "source",
    activation: "unknown",
    spec: {},
    ...over,
  } as unknown as ResolvedObject;
}

// --------------------------------------------------- synthetic class source --

/**
 * One 40-line synthetic "current source" shared by every Section A/B test.
 * Five lines are overwritten to carry a real identifier at the exact
 * line/column each live-captured fixture's own request names (verified
 * character-by-character against each fixture's `.meta.json`/request URL);
 * every other line is inert filler, which is what makes `line: 41` (one past
 * the end) an unambiguous BAD_INPUT case naming "40 line(s)".
 */
const CLASS_SOURCE_LINES: string[] = Array.from({ length: 40 }, (_, i) => `* filler line ${i + 1}`);
CLASS_SOURCE_LINES[17] = "    METHODS run"; // line 18: "run" spans columns 12..15 (895)
CLASS_SOURCE_LINES[24] = "    DATA ls_row TYPE ty_row."; // line 25: "ty_row" spans 21..27 (893)
CLASS_SOURCE_LINES[34] = "    mv_count = lo_probe->process( iv_input = 'x' )."; // line 35 (892/894/891)
CLASS_SOURCE_LINES[36] = "    CALL FUNCTION 'RFC_PING'."; // line 37: "RFC_PING" spans 19..27 (896)
CLASS_SOURCE_LINES[38] = "    ENDMETHOD."; // line 39: no element resolves here (899)
const CLASS_SOURCE = CLASS_SOURCE_LINES.join("\n");

const CLASS_SOURCE_URI = "/sap/bc/adt/oo/classes/zcl_i91_probe/source/main";

/** Positions, matching each fixture's own captured `#start=line,column` request exactly. */
const POS = {
  ownMethod: { line: 18, column: 12 }, // "run" — 895
  type: { line: 25, column: 21 }, // "ty_row" — 893
  attribute: { line: 35, column: 4 }, // "mv_count" — 892
  localVariable: { line: 35, column: 15 }, // "lo_probe" — 894
  interfaceMethod: { line: 35, column: 25 }, // "process" — 891, matches 897's end=35,32
  functionModule: { line: 37, column: 19 }, // "RFC_PING" — 896
  none: { line: 39, column: 4 }, // ENDMETHOD — 899, no element resolves
} as const;

/** Identifier token spans, matching `identifierAt`'s own scan over the lines above. */
const SPAN = {
  ownMethod: { start: 12, end: 15 },
  type: { start: 21, end: 27 },
  attribute: { start: 4, end: 12 },
  localVariable: { start: 15, end: 23 },
  interfaceMethod: { start: 25, end: 32 },
  functionModule: { start: 19, end: 27 },
} as const;

const elementInfoFrag = (pos: { line: number; column: number }): string => `${CLASS_SOURCE_URI}#start=${pos.line},${pos.column}`;
const navTargetKey = (pos: { line: number }, span: { start: number; end: number }): string =>
  `${CLASS_SOURCE_URI}#start=${pos.line},${span.start};end=${pos.line},${span.end}|definition`;

/** `<adtcore:objectReference/>` with no `uri` attribute — ADT naming no navigation target, the same shape `parseNavigationTarget` documents as "resolved, but nothing to declare a target for". Used for every position below that has no captured 897-style fixture of its own. */
const NO_TARGET_XML =
  '<?xml version="1.0" encoding="utf-8"?><adtcore:objectReference xmlns:adtcore="http://www.sap.com/adt/core"/>';

const ELEMENT_INFO_ROUTES: Record<string, string> = {
  [elementInfoFrag(POS.interfaceMethod)]: fixture("891-i91-elementinfo-interface-method.xml"),
  [elementInfoFrag(POS.attribute)]: fixture("892-i91-elementinfo-attribute.xml"),
  [elementInfoFrag(POS.type)]: fixture("893-i91-elementinfo-type.xml"),
  [elementInfoFrag(POS.localVariable)]: fixture("894-i91-elementinfo-local-variable.xml"),
  [elementInfoFrag(POS.ownMethod)]: fixture("895-i91-elementinfo-method-own.xml"),
  [elementInfoFrag(POS.functionModule)]: fixture("896-i91-elementinfo-function-module.xml"),
  [elementInfoFrag(POS.none)]: fixture("899-i91-elementinfo-no-element.xml"),
};

const NAV_TARGET_ROUTES: Record<string, string> = {
  [navTargetKey(POS.interfaceMethod, SPAN.interfaceMethod)]: fixture("897-i91-navigation-target-definition.xml"),
  [navTargetKey(POS.attribute, SPAN.attribute)]: NO_TARGET_XML,
  [navTargetKey(POS.type, SPAN.type)]: NO_TARGET_XML,
  [navTargetKey(POS.localVariable, SPAN.localVariable)]: NO_TARGET_XML,
  [navTargetKey(POS.ownMethod, SPAN.ownMethod)]: NO_TARGET_XML,
  [navTargetKey(POS.functionModule, SPAN.functionModule)]: NO_TARGET_XML,
  // POS.none has no route: readDefinition returns before ever calling
  // findDefinitionTarget once `isUnresolved(info)` is true.
};

/**
 * Synthesizes a `usageReferences` wire document naming `count` implementers
 * of `ZIF_I91_PROBE~PROCESS`, in the same shape fixture 900
 * (`900-i91-usage-references-interface-method.xml`) actually carries: a
 * `usagereferences:referencedObject` row for the class itself, plus one for
 * its `ZIF_I91_PROBE~PROCESS` implementer, all lowercase-`usagereferences:`-
 * prefixed as A4H really sends (see this file's module doc comment). More
 * rows than `IMPLEMENTATIONS_DISPLAY_MAX` (50) will ever show — the point of
 * the one test that uses this.
 */
function syntheticUsageReferencesXml(count: number): string {
  const rows: string[] = [];
  for (let i = 0; i < count; i++) {
    const classUri = `/sap/bc/adt/oo/classes/zcl_synth_${i}`;
    rows.push(
      `<usagereferences:referencedObject uri="${classUri}" parentUri="/sap/bc/adt/packages/%24tmp" isResult="false" canHaveChildren="false"><usagereferences:adtObject adtcore:name="ZCL_SYNTH_${i}" adtcore:type="CLAS/OC" xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/%24tmp" adtcore:type="DEVC/K" adtcore:name="$TMP"/></usagereferences:adtObject></usagereferences:referencedObject>`,
    );
    rows.push(
      `<usagereferences:referencedObject uri="${classUri}/source/main#type=CLAS%2FOM;name=ZIF_I91_PROBE%7ePROCESS" parentUri="${classUri}" isResult="false" canHaveChildren="true" usageInformation="gradeDirect,includeProductive"><usagereferences:adtObject adtcore:name="ZIF_I91_PROBE~PROCESS" xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/%24tmp" adtcore:type="DEVC/K" adtcore:name="$TMP"/></usagereferences:adtObject></usagereferences:referencedObject>`,
    );
  }
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<usagereferences:usageReferenceResult numberOfResults="${count}" xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences">` +
    `<usagereferences:referencedObjects>${rows.join("")}</usagereferences:referencedObjects>` +
    `</usagereferences:usageReferenceResult>`
  );
}

/** `#start=L,C` (or the bare uri with no position) — the exact `qs.uri` shape `findImplementations` (`src/adt/element-info.ts`) now posts to `USAGE_REFERENCES_URL`. */
const usageReferencesKey = (uri: string, pos?: { readonly line: number; readonly column: number }): string =>
  pos !== undefined ? `${uri}#start=${pos.line},${pos.column}` : uri;

/** `ZIF_I91_PROBE`'s own source URI and fixture 897's declaration position (line 8, column 10) — the where-used call `IMPLEMENTED BY` drives once a navigation target actually resolves into the interface. */
const INTERFACE_SOURCE_URI = "/sap/bc/adt/oo/interfaces/zif_i91_probe/source/main";
const INTERFACE_DECL_POS = { line: 8, column: 10 } as const;

/** A minimal, hand-written (not live-captured) `elementInfo` document for an interface method with no parameters — no fixture carries this shape, every captured interface-method fixture (891) has two. */
function intfMethodElementInfoXml(name: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?><abapsource:elementInfo adtcore:type="INTF/IO" adtcore:name="' +
    name +
    '" xmlns:abapsource="http://www.sap.com/adt/abapsource" xmlns:adtcore="http://www.sap.com/adt/core">' +
    '<abapsource:properties><abapsource:entry abapsource:key="level">instance</abapsource:entry>' +
    '<abapsource:entry abapsource:key="visibility">public</abapsource:entry></abapsource:properties>' +
    "</abapsource:elementInfo>"
  );
}

// ------------------------------------------------------------- fake connection --

interface ConnOpts {
  elementInfo?: Record<string, string>;
  navTarget?: Record<string, string>;
  /** Keyed by the exact `qs.uri` (see {@link usageReferencesKey}) `findImplementations` posts to `USAGE_REFERENCES_URL`; value is the raw XML `parseUsageReferences` parses. */
  usageReferences?: Record<string, string>;
}

/**
 * A connection whose `post` answers ONLY an exact, pre-registered
 * `qs.uri` (elementinfo), `qs.uri`+`qs.filter` (navigation-target), or
 * `qs.uri` (usageReferences) request — anything else throws, naming the URL,
 * so a stray/unexpected request fails the test loudly instead of silently
 * returning nothing.
 */
function fakeConn(opts: ConnOpts = {}): AbapConnection {
  const elementInfo = opts.elementInfo ?? {};
  const navTarget = opts.navTarget ?? {};
  const usageReferences = opts.usageReferences ?? {};

  const post = async (url: string, reqOpts: RawRequestOptions & { body?: string } = {}): Promise<RawResponse> => {
    const uri = reqOpts.qs?.uri;
    if (url === ELEMENT_INFO_URL) {
      const body = uri !== undefined ? elementInfo[uri] : undefined;
      if (body === undefined) {
        throw new Error(`UNEXPECTED elementinfo REQUEST — no fake route for: ${url}?uri=${String(uri)}`);
      }
      return { body, status: 200, headers: {} };
    }
    if (url === NAVIGATION_TARGET_URL) {
      const key = `${String(uri)}|${String(reqOpts.qs?.filter)}`;
      const body = navTarget[key];
      if (body === undefined) {
        throw new Error(
          `UNEXPECTED navigation-target REQUEST — no fake route for: ${url}?uri=${String(uri)}&filter=${String(reqOpts.qs?.filter)}`,
        );
      }
      return { body, status: 200, headers: {} };
    }
    if (url === USAGE_REFERENCES_URL) {
      const body = uri !== undefined ? usageReferences[uri] : undefined;
      if (body === undefined) {
        throw new Error(`UNEXPECTED usageReferences REQUEST — no fake route for: ${url}?uri=${String(uri)}`);
      }
      return { body, status: 200, headers: {} };
    }
    throw new Error(`UNEXPECTED REQUEST — no fake route for URL: ${url}`);
  };

  return { cfg: { sid: "A4H" }, post } as unknown as AbapConnection;
}

/** A connection that throws, naming the URL, on ANY `post` call — used by every Section A refusal test to double as a "no network" pin. */
const noNetworkConn = fakeConn();

/** Every Section B fixture route, wired once. */
function fullConn(): AbapConnection {
  return fakeConn({
    elementInfo: ELEMENT_INFO_ROUTES,
    navTarget: NAV_TARGET_ROUTES,
    usageReferences: {
      [usageReferencesKey(INTERFACE_SOURCE_URI, INTERFACE_DECL_POS)]: fixture(
        "900-i91-usage-references-interface-method.xml",
      ),
    },
  });
}

beforeEach(() => {
  stub.object = resolved();
  stub.source = CLASS_SOURCE;
  stub.sourceUri = CLASS_SOURCE_URI;
  stub.definitionLookupOverride = undefined;
});

// ============================================================== Section A ==

describe("view=\"definition\" refusals — every combination assertViewCompatible rejects, no network", () => {
  it('refuses format="raw" combined with view="definition"', async () => {
    await expect(
      abapRead(noNetworkConn, { object: "ZCL_I91_PROBE", view: "definition", line: 1, format: "raw" }, 20_000),
    ).rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining('format="raw"') });
  });

  it('refuses enhancements=true combined with view="definition"', async () => {
    await expect(
      abapRead(noNetworkConn, { object: "ZCL_I91_PROBE", view: "definition", line: 1, enhancements: true }, 20_000),
    ).rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("enhancements=true") });
  });

  it('refuses version="inactive" combined with view="definition"', async () => {
    await expect(
      abapRead(noNetworkConn, { object: "ZCL_I91_PROBE", view: "definition", line: 1, version: "inactive" }, 20_000),
    ).rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining('version="inactive"') });
  });

  it('allows version="active" combined with view="definition" — this is a no-op, not a refusal, and the full pipeline runs to completion', async () => {
    const r = await abapRead(
      fullConn(),
      { object: "ZCL_I91_PROBE", view: "definition", line: POS.none.line, column: POS.none.column, version: "active" },
      20_000,
    );
    // Not thrown, and it is a genuine, complete answer (fixture 899's
    // resolved-to-nothing position) — not merely "didn't crash".
    expect(r.etag).toBe("");
    expect(r.text).toContain("No resolvable element");
  });

  it('refuses outline=true combined with view="definition"', async () => {
    await expect(
      abapRead(noNetworkConn, { object: "ZCL_I91_PROBE", view: "definition", line: 1, outline: true }, 20_000),
    ).rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("outline=true") });
  });

  it('refuses method= combined with view="definition"', async () => {
    await expect(
      abapRead(noNetworkConn, { object: "ZCL_I91_PROBE", view: "definition", line: 1, method: "RUN" }, 20_000),
    ).rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining('method="RUN"') });
  });

  it.each(["from", "to", "context"] as const)(
    'refuses %s combined with view="definition" — that parameter belongs to view="diff", not a position lookup',
    async (param) => {
      const value = param === "context" ? 5 : "active";
      await expect(
        abapRead(noNetworkConn, { object: "ZCL_I91_PROBE", view: "definition", line: 1, [param]: value }, 20_000),
      ).rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining(param) });
    },
  );

  it('refuses view="definition" without line — BAD_INPUT, not UNSUPPORTED: this is a missing required parameter, not an incompatible combination', async () => {
    await expect(abapRead(noNetworkConn, { object: "ZCL_I91_PROBE", view: "definition" }, 20_000)).rejects.toMatchObject({
      code: "BAD_INPUT",
      message: expect.stringContaining('view="definition" requires line'),
    });
  });

  it.each(["history", "diff"] as const)('refuses line/column combined with view="%s"', async (view) => {
    await expect(
      abapRead(noNetworkConn, { object: "ZCL_I91_PROBE", view, line: 5, column: 3 }, 20_000),
    ).rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("position") });
  });

  it("refuses line/column with no view at all — BAD_INPUT naming the parameter that would otherwise be silently discarded", async () => {
    await expect(abapRead(noNetworkConn, { object: "ZCL_I91_PROBE", line: 5, column: 3 }, 20_000)).rejects.toMatchObject({
      code: "BAD_INPUT",
      message: expect.stringContaining('only meaningful with view="definition"'),
    });
  });

  it('refuses view="definition" against a non-source (ddic-mode) object, even with line supplied — the "missing line" check runs first in assertViewCompatible, so line must be present to reach this refusal at all', async () => {
    stub.object = resolved({
      type: "TABL/DS",
      kind: "TABL",
      label: "table",
      name: "ZI91_TABLE",
      uri: "/sap/bc/adt/ddic/tables/zi91_table",
      sourceUri: undefined,
      mode: "ddic",
    });
    await expect(
      abapRead(noNetworkConn, { object: "ZI91_TABLE", view: "definition", line: 1 }, 20_000),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("no ABAP source to resolve a position in"),
    });
  });

  it("refuses a line past the end of the source, naming the actual line count — and never issues a request to do so", async () => {
    await expect(
      abapRead(noNetworkConn, { object: "ZCL_I91_PROBE", view: "definition", line: 41 }, 20_000),
    ).rejects.toMatchObject({
      code: "BAD_INPUT",
      message: expect.stringContaining("line=41 is past the end of"),
    });
    await expect(
      abapRead(noNetworkConn, { object: "ZCL_I91_PROBE", view: "definition", line: 41 }, 20_000),
    ).rejects.toMatchObject({ message: expect.stringContaining("40 line(s)") });
  });
});

// ============================================================== Section B ==

/** The content of one `--- TITLE ---` section, or undefined if that title never appears. */
function section(text: string, title: string): string | undefined {
  const re = new RegExp(`--- ${title} ---\\n([\\s\\S]*?)(?:\\n\\n---|$)`);
  return re.exec(text)?.[1];
}

describe('view="definition" rendering, driven by live-captured A4H fixtures through a fake connection', () => {
  it("891+897+900: an interface method resolves to a DEFINITION section (source line + copy-pasteable abap_read call), a SIGNATURE table, a DOC section, and an IMPLEMENTED BY section naming the implementing classes (not the RUN caller row)", async () => {
    const r = await abapRead(
      fullConn(),
      { object: "ZCL_I91_PROBE", view: "definition", line: POS.interfaceMethod.line, column: POS.interfaceMethod.column },
      20_000,
    );

    expect(r.etag).toBe("");
    expect(r.text).toContain("INTF/IO PROCESS");

    // DEFINITION: the source line itself, the declaration site, and a
    // literal, copy-pasteable abap_read call to open it.
    const definition = section(r.text, "DEFINITION");
    expect(definition).toBeDefined();
    expect(definition).toContain(`35: ${CLASS_SOURCE_LINES[34]}`);
    expect(definition).toContain("declared at: /sap/bc/adt/oo/interfaces/zif_i91_probe/source/main (line 8, column 10)");
    expect(definition).toContain('abap_read {"object":"ZIF_I91_PROBE","type":"INTF/OI"}');

    // SIGNATURE: both parameters, with the columns fixture 891 actually
    // carries (paramDefaultValue is absent on both, so it must not appear).
    const signature = section(r.text, "SIGNATURE");
    expect(signature).toBeDefined();
    expect(signature).toContain("IV_INPUT");
    expect(signature).toContain("importing");
    expect(signature).toContain("TYPE STRING");
    expect(signature).toContain("Raw input line");
    expect(signature).toContain("RV_RESULT");
    expect(signature).toContain("returning");
    expect(signature).toContain("TYPE I");
    expect(signature).toContain("Number of characters");
    expect(r.text).not.toContain("--- COMPONENTS ---");

    // DOC: short text and HTML-stripped ABAP Doc.
    const doc = section(r.text, "DOC");
    expect(doc).toBeDefined();
    expect(doc).toContain("short text: Process one input line");
    expect(doc).toContain("ABAP Doc: Process one input line");
    expect(doc).not.toContain("<p");

    // IMPLEMENTED BY: both real implementers, never the RUN caller row.
    const implementedBy = section(r.text, "IMPLEMENTED BY");
    expect(implementedBy).toBeDefined();
    expect(implementedBy).toContain("ZCL_I91_PROBE");
    expect(implementedBy).toContain("ZCL_I91_PROBE2");
    expect(implementedBy).toMatch(/ZIF_I91_PROBE~PROCESS/);
    expect(implementedBy!.split(/\s+/)).not.toContain("RUN");

    // The static-analysis caveat is always present alongside IMPLEMENTED BY.
    expect(r.text).toContain(
      "Where-used is static. Dynamic calls (CALL FUNCTION lv_name, PERFORM (lv_form), " +
        "SUBMIT (lv_prog)) do not appear here",
    );
  });

  it("892: an attribute's visibility/level/abapType reach the header, and there is no SIGNATURE section (a leaf has no children to tabulate)", async () => {
    const r = await abapRead(
      fullConn(),
      { object: "ZCL_I91_PROBE", view: "definition", line: POS.attribute.line, column: POS.attribute.column },
      20_000,
    );
    expect(r.etag).toBe("");
    expect(r.text).toContain("CLAS/OA MV_COUNT");
    expect(r.text).toContain("visibility: private");
    expect(r.text).toContain("level: instance");
    expect(r.text).toContain("abapType: TYPE I");
    expect(r.text).not.toContain("--- SIGNATURE ---");
    expect(r.text).not.toContain("--- COMPONENTS ---");
    const doc = section(r.text, "DOC");
    expect(doc).toBeDefined();
    expect(doc).toContain("Characters counted so far");
  });

  it('893: a structure type lists its components — but the CURRENT CODE titles that table "SIGNATURE", not "COMPONENTS" (see this file\'s module doc comment: COMPONENT_COLUMNS ⊂ SIGNATURE_COLUMNS makes the COMPONENTS branch unreachable)', async () => {
    const r = await abapRead(
      fullConn(),
      { object: "ZCL_I91_PROBE", view: "definition", line: POS.type.line, column: POS.type.column },
      20_000,
    );
    expect(r.etag).toBe("");
    expect(r.text).toContain("CLAS/OT TY_ROW");
    // The actual, current behaviour: a SIGNATURE section carries the
    // component rows. No COMPONENTS section is ever produced by this code.
    expect(r.text).not.toContain("--- COMPONENTS ---");
    const signature = section(r.text, "SIGNATURE");
    expect(signature).toBeDefined();
    expect(signature).toContain("ID");
    expect(signature).toContain("TYPE I");
    expect(signature).toContain("NAME");
    expect(signature).toContain("TYPE STRING");
  });

  it("894: a local variable resolves (type, no navigation target) with no DOC section — fixture 894 carries no documentation at all", async () => {
    const r = await abapRead(
      fullConn(),
      { object: "ZCL_I91_PROBE", view: "definition", line: POS.localVariable.line, column: POS.localVariable.column },
      20_000,
    );
    expect(r.etag).toBe("");
    expect(r.text).toContain("CLAS/OOV LO_PROBE");
    expect(r.text).toContain("TYPE REF TO ZIF_I91_PROBE");
    expect(r.text).not.toContain("--- DOC ---");
  });

  it("895: the class's own method shows its default value in the SIGNATURE table", async () => {
    const r = await abapRead(
      fullConn(),
      { object: "ZCL_I91_PROBE", view: "definition", line: POS.ownMethod.line, column: POS.ownMethod.column },
      20_000,
    );
    expect(r.etag).toBe("");
    expect(r.text).toContain("CLAS/OM RUN");
    const signature = section(r.text, "SIGNATURE");
    expect(signature).toBeDefined();
    expect(signature).toContain("IV_TIMES");
    expect(signature).toContain("Repeat count");
    // The default value column ("1"), present on IV_TIMES only.
    expect(signature).toMatch(/IV_TIMES.*\b1\b/s);
    expect(signature).toContain("RV_TOTAL");
    expect(signature).toContain("Total characters seen");
  });

  it("896: a function module's empty signature is stated as an ADT limitation for FUGR/FF, not reported as a missing parameter", async () => {
    const r = await abapRead(
      fullConn(),
      { object: "ZCL_I91_PROBE", view: "definition", line: POS.functionModule.line, column: POS.functionModule.column },
      20_000,
    );
    expect(r.etag).toBe("");
    expect(r.text).toContain("FUGR/FF RFC_PING");
    // CHANGE 3: FUGR/FF is a CALLABLE_ELEMENT_TYPES member, so the empty
    // SIGNATURE section is now rendered explicitly as "(none)" rather than
    // omitted — the FUGR/FF note below refers to "the empty SIGNATURE
    // section above", which requires the section to actually exist.
    expect(section(r.text, "SIGNATURE")).toBe("(none)");
    expect(r.text).toContain(
      "ADT's element info returns no visibility, no signature and no documentation for FUGR/FF",
    );
    expect(r.text).toContain("not a rendering gap");
  });

  it("899: no resolvable element at that position is a SUCCESSFUL response echoing the source line, not a thrown error", async () => {
    const r = await abapRead(
      fullConn(),
      { object: "ZCL_I91_PROBE", view: "definition", line: POS.none.line, column: POS.none.column },
      20_000,
    );
    expect(r.etag).toBe("");
    const definition = section(r.text, "DEFINITION");
    expect(definition).toBeDefined();
    expect(definition).toContain(`No resolvable element at line ${POS.none.line}, column ${POS.none.column}`);
    expect(definition).toContain(`${POS.none.line}: ${CLASS_SOURCE_LINES[POS.none.line - 1]}`);
    expect(r.text).toContain("this is a fact about the position, not a lookup failure");
  });

  it('every view="definition" response carries the NO_ETAG sentinel, never a real content hash', async () => {
    const positions = [POS.interfaceMethod, POS.attribute, POS.type, POS.localVariable, POS.ownMethod, POS.functionModule, POS.none];
    for (const pos of positions) {
      const r = await abapRead(fullConn(), { object: "ZCL_I91_PROBE", view: "definition", line: pos.line, column: pos.column }, 20_000);
      expect(r.etag).toBe("");
    }
  });

  it("assert the exact elementinfo POST URL and query: the #start=line,column fragment is 1-based line, 0-based column, posted to the codecompletion/elementinfo endpoint", async () => {
    const seen: Array<{ url: string; qs?: Record<string, string> }> = [];
    const conn = fakeConn({
      elementInfo: { [elementInfoFrag(POS.attribute)]: fixture("892-i91-elementinfo-attribute.xml") },
      navTarget: { [navTargetKey(POS.attribute, SPAN.attribute)]: NO_TARGET_XML },
    });
    const originalPost = (conn as unknown as { post: (url: string, opts: RawRequestOptions & { body?: string }) => Promise<RawResponse> })
      .post;
    (conn as unknown as { post: typeof originalPost }).post = async (url, opts) => {
      seen.push({ url, qs: opts.qs });
      return originalPost(url, opts);
    };

    await abapRead(conn, { object: "ZCL_I91_PROBE", view: "definition", line: POS.attribute.line, column: POS.attribute.column }, 20_000);

    const elementInfoRequest = seen.find((s) => s.url === ELEMENT_INFO_URL);
    expect(elementInfoRequest).toBeDefined();
    expect(elementInfoRequest!.url).toBe("/sap/bc/adt/abapsource/codecompletion/elementinfo");
    // Line 35 (1-based, matches the CLASS_SOURCE_LINES index), column 4
    // (0-based) — exactly the position convention this feature documents.
    expect(elementInfoRequest!.qs?.uri).toBe(`${CLASS_SOURCE_URI}#start=35,4`);
  });

  it("IMPLEMENTED BY truncates past IMPLEMENTATIONS_DISPLAY_MAX (50), naming the omitted count — driven by a synthetic 60-implementer usageReferences answer", async () => {
    const conn = fakeConn({
      elementInfo: { [elementInfoFrag(POS.interfaceMethod)]: fixture("891-i91-elementinfo-interface-method.xml") },
      navTarget: { [navTargetKey(POS.interfaceMethod, SPAN.interfaceMethod)]: fixture("897-i91-navigation-target-definition.xml") },
      usageReferences: { [usageReferencesKey(INTERFACE_SOURCE_URI, INTERFACE_DECL_POS)]: syntheticUsageReferencesXml(60) },
    });

    const r = await abapRead(
      conn,
      { object: "ZCL_I91_PROBE", view: "definition", line: POS.interfaceMethod.line, column: POS.interfaceMethod.column },
      20_000,
    );

    expect(r.etag).toBe("");
    const implementedBy = section(r.text, "IMPLEMENTED BY");
    expect(implementedBy).toBeDefined();
    expect(implementedBy).toContain("ZCL_SYNTH_0");
    expect(implementedBy).toContain("ZCL_SYNTH_49");
    expect(implementedBy).not.toContain("ZCL_SYNTH_50");
    expect(r.text).toContain("--- TRUNCATED --- 10 of 60 implementer(s) not shown (display cap 50).");
  });

  // ------------------------------------------------------- CHANGE 1/2/3 --

  it("a position on the variable's own declaration renders the declaration-itself wording instead of throwing", async () => {
    stub.definitionLookupOverride = { noTargetReason: "declaration-itself" };
    const conn = fakeConn({ elementInfo: { [elementInfoFrag(POS.attribute)]: fixture("892-i91-elementinfo-attribute.xml") } });

    const r = await abapRead(
      conn,
      { object: "ZCL_I91_PROBE", view: "definition", line: POS.attribute.line, column: POS.attribute.column },
      20_000,
    );

    expect(r.etag).toBe("");
    const definition = section(r.text, "DEFINITION");
    expect(definition).toBeDefined();
    expect(definition).toContain("This position is the declaration itself");
    expect(definition).toContain("ED263");
  });

  it("an undecidable navigation target renders the more-than-one-implementation wording", async () => {
    stub.definitionLookupOverride = { noTargetReason: "undecidable" };
    const conn = fakeConn({ elementInfo: { [elementInfoFrag(POS.attribute)]: fixture("892-i91-elementinfo-attribute.xml") } });

    const r = await abapRead(
      conn,
      { object: "ZCL_I91_PROBE", view: "definition", line: POS.attribute.line, column: POS.attribute.column },
      20_000,
    );

    expect(r.etag).toBe("");
    const definition = section(r.text, "DEFINITION");
    expect(definition).toBeDefined();
    expect(definition).toContain("more than one implementation exists");
    expect(definition).toContain("undecidable");
  });

  it("a navigation target the server leaves unnamed keeps the existing no-target wording", async () => {
    stub.definitionLookupOverride = { noTargetReason: "unnamed" };
    const conn = fakeConn({ elementInfo: { [elementInfoFrag(POS.attribute)]: fixture("892-i91-elementinfo-attribute.xml") } });

    const r = await abapRead(
      conn,
      { object: "ZCL_I91_PROBE", view: "definition", line: POS.attribute.line, column: POS.attribute.column },
      20_000,
    );

    expect(r.etag).toBe("");
    const definition = section(r.text, "DEFINITION");
    expect(definition).toBeDefined();
    expect(definition).toContain("ADT named no navigation target for this identifier.");
    expect(definition).not.toContain("declaration itself");
    expect(definition).not.toContain("undecidable");
  });

  it("reading an interface's own method declaration lists implementers without a navigation target", async () => {
    const intfSource = ["INTERFACE zif_i91_probe PUBLIC.", "  METHODS process", "    IMPORTING iv_input TYPE string.", "ENDINTERFACE."].join(
      "\n",
    );
    const declPos = { line: 2, column: 10 }; // "process" starts at column 10 on line 2

    stub.object = resolved({
      type: "INTF/OI",
      kind: "INTF",
      label: "interface",
      name: "ZIF_I91_PROBE",
      uri: "/sap/bc/adt/oo/interfaces/zif_i91_probe",
      sourceUri: INTERFACE_SOURCE_URI,
      mode: "source",
    });
    stub.source = intfSource;
    stub.sourceUri = INTERFACE_SOURCE_URI;
    // No navigation target — this position IS the declaration (ED263).
    stub.definitionLookupOverride = { noTargetReason: "declaration-itself" };

    const conn = fakeConn({
      elementInfo: { [`${INTERFACE_SOURCE_URI}#start=${declPos.line},${declPos.column}`]: intfMethodElementInfoXml("PROCESS") },
      usageReferences: {
        [usageReferencesKey(INTERFACE_SOURCE_URI, declPos)]: fixture("900-i91-usage-references-interface-method.xml"),
      },
    });
    const usageReferencesSeen: Array<string | undefined> = [];
    const originalPost = (conn as unknown as { post: (url: string, opts: RawRequestOptions & { body?: string }) => Promise<RawResponse> })
      .post;
    (conn as unknown as { post: typeof originalPost }).post = async (url, opts) => {
      if (url === USAGE_REFERENCES_URL) usageReferencesSeen.push(opts.qs?.uri);
      return originalPost(url, opts);
    };

    const r = await abapRead(
      conn,
      { object: "ZIF_I91_PROBE", type: "INTF/OI", view: "definition", line: declPos.line, column: declPos.column },
      20_000,
    );

    expect(r.etag).toBe("");
    const implementedBy = section(r.text, "IMPLEMENTED BY");
    expect(implementedBy).toBeDefined();
    expect(implementedBy).toContain("ZCL_I91_PROBE");
    expect(implementedBy).toContain("ZCL_I91_PROBE2");

    // The where-used lookup was called with the interface's OWN source URI
    // and the READ position — not a target-derived one, since there is none.
    expect(usageReferencesSeen).toEqual([usageReferencesKey(INTERFACE_SOURCE_URI, declPos)]);
  });

  it("a class method use site still lists implementers via the navigation target", async () => {
    const r = await abapRead(
      fullConn(),
      { object: "ZCL_I91_PROBE", view: "definition", line: POS.interfaceMethod.line, column: POS.interfaceMethod.column },
      20_000,
    );

    expect(r.etag).toBe("");
    const implementedBy = section(r.text, "IMPLEMENTED BY");
    expect(implementedBy).toBeDefined();
    expect(implementedBy).toContain("ZCL_I91_PROBE");
    expect(implementedBy).toContain("ZCL_I91_PROBE2");
  });

  it("an interface method with no parameters renders SIGNATURE (none)", async () => {
    const conn = fakeConn({
      elementInfo: { [elementInfoFrag(POS.interfaceMethod)]: intfMethodElementInfoXml("RUN") },
      navTarget: { [navTargetKey(POS.interfaceMethod, SPAN.interfaceMethod)]: NO_TARGET_XML },
    });

    const r = await abapRead(
      conn,
      { object: "ZCL_I91_PROBE", view: "definition", line: POS.interfaceMethod.line, column: POS.interfaceMethod.column },
      20_000,
    );

    expect(r.etag).toBe("");
    expect(section(r.text, "SIGNATURE")).toBe("(none)");
    expect(r.text).not.toContain("--- COMPONENTS ---");
  });

  it("a function module renders SIGNATURE (none) and the note explaining ADT returns no signature", async () => {
    const r = await abapRead(
      fullConn(),
      { object: "ZCL_I91_PROBE", view: "definition", line: POS.functionModule.line, column: POS.functionModule.column },
      20_000,
    );

    expect(r.etag).toBe("");
    expect(section(r.text, "SIGNATURE")).toBe("(none)");
    expect(r.text).toContain(
      "ADT's element info returns no visibility, no signature and no documentation for FUGR/FF",
    );
    expect(r.text).toContain("The empty SIGNATURE section above is that fact, not a rendering gap.");
  });

  it("a structured type still renders COMPONENTS, not an empty SIGNATURE", async () => {
    const r = await abapRead(
      fullConn(),
      { object: "ZCL_I91_PROBE", view: "definition", line: POS.type.line, column: POS.type.column },
      20_000,
    );

    expect(r.etag).toBe("");
    // CLAS/OT is not a CALLABLE_ELEMENT_TYPES member, and this element HAS
    // children (ID, NAME), so CHANGE 3's "(none)" placeholder must not fire
    // here. The component table itself is still titled "SIGNATURE", not
    // "COMPONENTS" — the pre-existing dead code this file's module doc
    // comment documents; CHANGE 3 does not touch that.
    const signature = section(r.text, "SIGNATURE");
    expect(signature).toBeDefined();
    expect(signature).not.toBe("(none)");
    expect(signature).toContain("ID");
    expect(signature).toContain("NAME");
    expect(r.text).not.toContain("--- COMPONENTS ---");
  });

  it("an element with no children and no callable type renders neither SIGNATURE nor COMPONENTS", async () => {
    const r = await abapRead(
      fullConn(),
      { object: "ZCL_I91_PROBE", view: "definition", line: POS.localVariable.line, column: POS.localVariable.column },
      20_000,
    );

    expect(r.etag).toBe("");
    expect(r.text).not.toContain("--- SIGNATURE ---");
    expect(r.text).not.toContain("--- COMPONENTS ---");
  });
});

// ============================================================== Section C ==

describe("v2 abap_read schema surface is frozen: no line, no column, view is not a closed enum", () => {
  it("abapReadInputSchema exposes no line/column fields at all", () => {
    expect(Object.keys(abapReadInputSchema)).not.toContain("line");
    expect(Object.keys(abapReadInputSchema)).not.toContain("column");
  });

  it('abapReadInputSchema.view is an open z.string(), not a closed enum — "definition" (or any other arbitrary value) must not be rejected', () => {
    expect(abapReadInputSchema.view.safeParse("definition").success).toBe(true);
    expect(abapReadInputSchema.view.safeParse("some-arbitrary-view-xyz").success).toBe(true);
    // The v1 (`readInputSchema`) enum equivalent explicitly rejects a
    // non-member string — v2's field must not share that behaviour.
    expect(abapReadInputSchema.view.description).not.toContain("definition");
  });
});
