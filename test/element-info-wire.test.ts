/**
 * Wire-fidelity pin for `src/adt/element-info.ts`: replays the real A4H
 * captures 952-958, 960, 961 in `test/fixtures/live-captured/` (`i91-*`)
 * through the module's exported PURE functions, so the parser stays pinned
 * to what the server actually sent rather than to what was assumed when the
 * module was written. There is no capture 898 — that request errored with
 * no body, so it is not referenced anywhere below.
 *
 * NO network anywhere in this file. `fetchElementInfo`, `findDefinitionTarget`
 * and `findImplementations` — the three functions in the module that take an
 * `AbapConnection` and actually call the wire — are never imported or
 * exercised here; only `parseElementInfo`, `isUnresolved`,
 * `parseNavigationTarget`, `splitFragmentUri`, `elementInfoFragmentUri`,
 * `identifierAt`, `implementationsFrom`, `parseUsageReferences` and
 * `noTargetReasonFor` are.
 *
 * `parseUsageReferences` USED TO be re-derived test-locally here (a helper
 * called `loadUsageReferenceRows`), because production got its where-used
 * rows from `conn.adt.usageReferences()` — `abap-adt-api`'s own wire client
 * — and that vendor function is broken for this endpoint: it looks up the
 * document by the hardcoded path `"usageReferences:referencedObject"`
 * (capital `R`), but fixture 961's actual wire bytes declare and use the
 * namespace prefix `usagereferences` (all lowercase) throughout —
 * `xmlns:usagereferences=` and every `<usagereferences:…>` tag — so feeding
 * fixture 961 through the vendor function returns an EMPTY array, not the
 * two implementers this fixture carries. That is no longer a live concern
 * for this repo: `element-info.ts` now parses where-used itself
 * (`parseUsageReferences`, prefix-agnostic via `removeNSPrefix: true`) and
 * no longer calls the vendor function at all, so this file exercises the
 * real production parser directly instead of a test-local stand-in for it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  elementInfoFragmentUri,
  identifierAt,
  implementationsFrom,
  isUnresolved,
  noTargetReasonFor,
  parseElementInfo,
  parseNavigationTarget,
  parseUsageReferences,
  splitFragmentUri,
} from "../src/adt/element-info.js";
import { type ErrorContext, translateAdtError } from "../src/adt/session.js";
import { type AbapError, isAbapError } from "../src/adt/errors.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const read = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");
const ctx = (operation: string): ErrorContext => ({ operation });

/** Run `fn`, require an `AbapError`, hand it back for field-level assertions — same convention as `activate.test.ts`'s `catchAbap`. */
function catchAbap(fn: () => unknown): AbapError {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected an AbapError, but the call returned normally");
}

// --------------------------------------------------------- 952-957, 960 --

describe("parseElementInfo replays the captured elementinfo documents", () => {
  it("952: interface method PROCESS resolves to INTF/IO with two INTF/IOP parameter children", () => {
    const info = parseElementInfo(read("952-i91-elementinfo-interface-method.xml"), ctx("element info"));
    expect(info.type).toBe("INTF/IO");
    expect(info.name).toBe("PROCESS");
    expect(info.properties).toEqual({ level: "instance", visibility: "public" });
    expect(info.shortText).toBe("Process one input line");
    // abapdoc is entity-decoded exactly once: the wire byte is the escaped
    // `&lt;p ...&gt;…&lt;/p&gt;`, and `abapDoc` carries the unescaped tag text,
    // not a still-escaped string — this is XML parsing's normal entity
    // decoding of element text, not a second pass over it.
    expect(info.abapDoc).toBe('<p class="shorttext synchronized">Process one input line</p>');
    expect(info.children).toHaveLength(2);

    const [ivInput, rvResult] = info.children;
    expect(ivInput?.type).toBe("INTF/IOP");
    expect(ivInput?.name).toBe("IV_INPUT");
    expect(ivInput?.properties).toEqual({
      paramType: "importing",
      optional: "false",
      byValue: "false",
      preferred: "false",
      abapType: "TYPE STRING",
    });
    expect(ivInput?.shortText).toBe("Raw input line");

    expect(rvResult?.type).toBe("INTF/IOP");
    expect(rvResult?.name).toBe("RV_RESULT");
    expect(rvResult?.properties).toEqual({
      paramType: "returning",
      optional: "true",
      byValue: "true",
      preferred: "false",
      abapType: "TYPE I",
    });
    expect(rvResult?.shortText).toBe("Number of characters");
  });

  it("953: private instance attribute MV_COUNT resolves to CLAS/OA with visibility, level and abapType", () => {
    const info = parseElementInfo(read("953-i91-elementinfo-attribute.xml"), ctx("element info"));
    expect(info.type).toBe("CLAS/OA");
    expect(info.name).toBe("MV_COUNT");
    expect(info.properties).toEqual({ visibility: "private", level: "instance", abapType: "TYPE I" });
    expect(info.shortText).toBe("Characters counted so far");
    expect(info.abapDoc).toContain("Characters counted so far");
    expect(info.children).toEqual([]);
  });

  it("954: structured type TY_ROW has an empty abapType and untyped component children", () => {
    const info = parseElementInfo(read("954-i91-elementinfo-type.xml"), ctx("element info"));
    expect(info.type).toBe("CLAS/OT");
    expect(info.name).toBe("TY_ROW");
    // The wire byte for this entry is the self-closing `<abapsource:entry
    // abapsource:key="abapType"/>` — no text node at all. element-info.ts's
    // `elementText` maps that shape to the empty string (not `undefined`,
    // not omitted), and `parseProperties` folds that into the record as
    // `abapType: ""` — the same "present key, absent value" case its own doc
    // comment calls out for this exact fixture. Asserting `""` here pins that
    // real, if slightly odd, behaviour rather than guessing at it.
    expect(info.properties).toEqual({ visibility: "public", kind: "value", abapType: "" });
    expect(info.shortText).toBeUndefined();
    expect(info.abapDoc).toBeUndefined();
    expect(info.children).toHaveLength(2);

    const [id, name] = info.children;
    // Component children carry no `adtcore:type` at all on the wire (only
    // `adtcore:name`), so `type` must be `undefined`, not an empty string or
    // an inherited value.
    expect(id?.type).toBeUndefined();
    expect(id?.name).toBe("ID");
    expect(id?.properties).toEqual({ abapType: "TYPE I" });
    expect(name?.type).toBeUndefined();
    expect(name?.name).toBe("NAME");
    expect(name?.properties).toEqual({ abapType: "TYPE STRING" });
  });

  it("955: local data reference LO_PROBE resolves to CLAS/OOV, visibility=local, no documentation", () => {
    const info = parseElementInfo(read("955-i91-elementinfo-local-variable.xml"), ctx("element info"));
    expect(info.type).toBe("CLAS/OOV");
    expect(info.name).toBe("LO_PROBE");
    expect(info.properties).toEqual({ visibility: "local", abapType: "TYPE REF TO ZIF_I91_PROBE" });
    expect(info.shortText).toBeUndefined();
    expect(info.abapDoc).toBeUndefined();
    expect(info.children).toEqual([]);
  });

  it("956: own method RUN carries paramDefaultValue on the optional IV_TIMES parameter only", () => {
    const info = parseElementInfo(read("956-i91-elementinfo-method-own.xml"), ctx("element info"));
    expect(info.type).toBe("CLAS/OM");
    expect(info.name).toBe("RUN");
    expect(info.children).toHaveLength(2);

    const [ivTimes, rvTotal] = info.children;
    expect(ivTimes?.name).toBe("IV_TIMES");
    expect(ivTimes?.properties).toEqual({
      paramType: "importing",
      optional: "true",
      byValue: "false",
      preferred: "false",
      abapType: "TYPE I",
      paramDefaultValue: "1",
    });
    // The returning parameter has no default value on the wire — its
    // properties record must not carry a `paramDefaultValue` key at all.
    expect(rvTotal?.name).toBe("RV_TOTAL");
    expect(rvTotal?.properties).toEqual({
      paramType: "returning",
      optional: "true",
      byValue: "true",
      preferred: "false",
      abapType: "TYPE I",
    });
    expect(rvTotal?.properties.paramDefaultValue).toBeUndefined();
  });

  it("957: function module RFC_PING is thin — empty properties, no doc, no children (ADT limitation for FUGR/FF, not a parser gap)", () => {
    // The wire body for this one is deliberately minimal:
    //   <abapsource:elementInfo adtcore:type="FUGR/FF" adtcore:name="RFC_PING" …>
    //     <abapsource:properties/>
    //   </abapsource:elementInfo>
    // ADT itself never sends visibility, a signature or documentation for a
    // function-module name literal here — this is what A4H actually answered
    // (see the fixture's own `.meta.json` "expect"), not something
    // `parseElementInfo` failed to extract.
    const info = parseElementInfo(read("957-i91-elementinfo-function-module.xml"), ctx("element info"));
    expect(info.type).toBe("FUGR/FF");
    expect(info.name).toBe("RFC_PING");
    expect(info.properties).toEqual({});
    expect(info.properties.visibility).toBeUndefined();
    expect(info.shortText).toBeUndefined();
    expect(info.abapDoc).toBeUndefined();
    expect(info.children).toEqual([]);
  });

  it("960: a position with nothing resolvable answers 200 with an elementInfo that has no adtcore:name", () => {
    const info = parseElementInfo(read("960-i91-elementinfo-no-element.xml"), ctx("element info"));
    expect(info.name).toBeUndefined();
    expect(info.type).toBeUndefined();
    // This is a successful, well-formed answer, not an error — isUnresolved
    // is how callers are meant to distinguish "resolved to nothing" from a
    // wire/parse failure, which would have thrown instead of returning here.
    // (Note for the report: this IS the "960: a nameless elementInfo document
    // is still unresolved" assertion — kept under its original name rather
    // than duplicated under a new one.)
    expect(isUnresolved(info)).toBe(true);
  });

  it("parseElementInfo treats a zero-byte 200 body as no resolvable element", () => {
    // Live-confirmed 2026-09-15 against A4H: a blank line answers HTTP 200
    // with a ZERO-BYTE body. Captured at
    // `/sap/bc/adt/oo/classes/cl_abap_typedescr/source/main#start=6,0`;
    // status 200, byteLength 0, sha256 the empty-string hash
    // (e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855). No
    // fixture file exists for this — there are no bytes to pin — same reason
    // the repo already has no capture 898. Before the fix this threw
    // ADT_ERROR ("no <abapsource:elementInfo> element"); it must now answer
    // the same unresolved shape fixture 960 does.
    const info = parseElementInfo("", ctx("element info"));
    expect(isUnresolved(info)).toBe(true);
    expect(info.children).toEqual([]);
  });

  it("parseElementInfo treats a declaration-only body as no resolvable element", () => {
    // A variant of the zero-byte case: the XML declaration with no element
    // after it at all. Not itself a live capture, but the same "nothing was
    // sent" shape `hasNoElementAtAll` is written to recognise.
    const info = parseElementInfo('<?xml version="1.0" encoding="utf-8"?>', ctx("element info"));
    expect(isUnresolved(info)).toBe(true);
    expect(info.children).toEqual([]);
  });

  it("parseElementInfo still throws ADT_ERROR for a document with a different root element", () => {
    // The guard that defect 2's fix was not widened into swallowing real
    // errors: an envelope with SOME other root (not `elementInfo`, not just
    // an XML declaration) must still be treated as a parse failure.
    const xml = '<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="x"><exc:message>boom</exc:message></exc:exception>';
    const err = catchAbap(() => parseElementInfo(xml, ctx("element info")));
    expect(err.code).toBe("ADT_ERROR");
    expect(err.message).toContain("<abapsource:elementInfo>");
  });
});

// -------------------------------------------------------------- 958 --

describe("parseNavigationTarget / splitFragmentUri replay the definition-target document", () => {
  it("958: go-to-definition answers an objectReference whose uri fragment splits into line 8, column 10", () => {
    const target = parseNavigationTarget(read("958-i91-navigation-target-definition.xml"), ctx("navigation target"));
    expect(target).toBeDefined();
    expect(target?.uri).toBe("/sap/bc/adt/oo/interfaces/zif_i91_probe/source/main");
    // Line is 1-based, column is 0-based — the module's own header convention;
    // the captured fragment is literally `#start=8,10`.
    expect(target?.line).toBe(8);
    expect(target?.column).toBe(10);
  });

  it("splitFragmentUri strips the #start=L,C fragment and parses it as 1-based line, 0-based column", () => {
    expect(splitFragmentUri("/x/y#start=1,0")).toEqual({ uri: "/x/y", line: 1, column: 0 });
    expect(splitFragmentUri("/x/y")).toEqual({ uri: "/x/y" });
  });

  it("splitFragmentUri also accepts the end-exclusive ;end=L,C form, discarding the end part", () => {
    // findDefinitionTarget's own request fragment carries `;end=L,C2`
    // (end-exclusive column range) but the FRAGMENT_RE only ever reports the
    // start position — this is round-tripping elementInfoFragmentUri's own
    // fragment shape, not the two-ended one, so the end fields are simply not
    // part of DefinitionTarget at all.
    expect(splitFragmentUri("/x/y#start=35,25;end=35,32")).toEqual({ uri: "/x/y", line: 35, column: 25 });
  });

  it("elementInfoFragmentUri builds the #start=line,column fragment elementinfo requests use", () => {
    expect(elementInfoFragmentUri("/sap/bc/adt/oo/classes/zcl_i91_probe/source/main", { line: 35, column: 25 })).toBe(
      "/sap/bc/adt/oo/classes/zcl_i91_probe/source/main#start=35,25",
    );
  });
});

// --------------------------------------------------------- identifierAt --

describe("identifierAt finds the ABAP identifier token covering a position", () => {
  it("returns the whole token for a position inside it", () => {
    const line = "  lo_probe->run( ).";
    const column = line.indexOf("run");
    const found = identifierAt(line, { line: 1, column });
    expect(found).toEqual({ text: "run", startColumn: column, endColumn: column + 3 });
  });

  it("returns the whole token for a position on its first character", () => {
    const line = "  lo_probe->run( ).";
    const column = line.indexOf("lo_probe");
    const found = identifierAt(line, { line: 1, column });
    expect(found).toEqual({ text: "lo_probe", startColumn: column, endColumn: column + 8 });
  });

  it("returns undefined for the position one past an identifier's last character", () => {
    const line = "  lo_probe->run( ).";
    const runStart = line.indexOf("run");
    const runEnd = runStart + "run".length; // lands on "(", not on "run" itself
    expect(line[runEnd]).toBe("(");
    expect(identifierAt(line, { line: 1, column: runEnd })).toBeUndefined();
  });

  it("returns undefined for a position on whitespace or punctuation", () => {
    const line = "  lo_probe->run( ).";
    expect(identifierAt(line, { line: 1, column: 0 })).toBeUndefined(); // leading space
    expect(identifierAt(line, { line: 1, column: line.indexOf("->") })).toBeUndefined(); // "-"
    expect(identifierAt(line, { line: 1, column: line.indexOf(".") })).toBeUndefined(); // "."
  });

  it("spans an identifier containing both ~ and / (interface component selector, namespace delimiter)", () => {
    const line = "    /nsp/zif_i91_probe~process( ).";
    const token = "/nsp/zif_i91_probe~process";
    const start = line.indexOf(token);
    // Point at a column in the middle of the token, well past both the "/"
    // and the "~" it contains, and confirm the scan still walks all the way
    // out to both ends rather than stopping at either delimiter.
    const column = start + token.indexOf("process");
    const found = identifierAt(line, { line: 1, column });
    expect(found).toEqual({ text: token, startColumn: start, endColumn: start + token.length });
  });
});

// --------------------------------------------------- parseUsageReferences --

describe("parseUsageReferences reads a where-used result regardless of the namespace prefix on the wire", () => {
  it("961: parseUsageReferences reads the lowercase usagereferences: prefix A4H actually sends", () => {
    const rows = parseUsageReferences(read("961-i91-usage-references-interface-method.xml"), ctx("usage references"));
    // Sanity on the fixture itself before trusting assertions built on top of
    // it: 5 referencedObject rows (2 classes, 2 implementer methods, 1 caller
    // method) plus the $TMP package row — 6 total, matching what was dumped
    // from the raw XML while building this test.
    expect(rows).toHaveLength(6);

    const implementerRows = rows.filter((r) => r["adtcore:name"] === "ZIF_I91_PROBE~PROCESS");
    expect(implementerRows).toHaveLength(2);
    for (const row of implementerRows) {
      expect(typeof row.uri).toBe("string");
      expect(typeof row.parentUri).toBe("string");
      expect(row["adtcore:name"]).toBe("ZIF_I91_PROBE~PROCESS");
      const packageRef = row.packageRef as Record<string, unknown>;
      expect(packageRef["adtcore:name"]).toBe("$TMP");
    }

    const classRow = rows.find((r) => r["adtcore:name"] === "ZCL_I91_PROBE");
    expect(classRow).toBeDefined();
    expect(classRow?.uri).toBe("/sap/bc/adt/oo/classes/zcl_i91_probe");
    const classPackageRef = classRow?.packageRef as Record<string, unknown>;
    expect(classPackageRef["adtcore:name"]).toBe("$TMP");

    const packageRow = rows.find((r) => r["adtcore:name"] === "$TMP");
    expect(packageRow).toBeDefined();
  });

  it("961: parseUsageReferences reads the capitalised usageReferences: prefix the vendor library expects", () => {
    // SYNTHETIC variant, not a live capture: no system has been observed
    // sending the capitalised `usageReferences:` prefix — it is only the
    // shape `abap-adt-api@8.4.1`'s own (broken) reader hardcodes. The point
    // of this test is that `parseUsageReferences` is prefix-agnostic either
    // way, via `usageReferencesXml`'s `removeNSPrefix: true` — not that any
    // real system sends this spelling.
    const original = read("961-i91-usage-references-interface-method.xml");
    const recapitalised = original
      .replace(/xmlns:usagereferences=/g, "xmlns:usageReferences=")
      .replace(/usagereferences:/g, "usageReferences:");
    expect(recapitalised).not.toBe(original);

    const rowsLower = parseUsageReferences(original, ctx("usage references"));
    const rowsUpper = parseUsageReferences(recapitalised, ctx("usage references"));
    expect(rowsUpper).toEqual(rowsLower);
  });

  it("parseUsageReferences returns no rows for a result document with no referencedObjects", () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<usagereferences:usageReferenceResult numberOfResults="0" ' +
      'xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences">' +
      "<usagereferences:scope/>" +
      "</usagereferences:usageReferenceResult>";
    expect(parseUsageReferences(xml, ctx("usage references"))).toEqual([]);
  });

  it("parseUsageReferences throws ADT_ERROR when the root element is missing", () => {
    const xml = '<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="x"><exc:message>nope</exc:message></exc:exception>';
    const err = catchAbap(() => parseUsageReferences(xml, ctx("usage references")));
    expect(err.code).toBe("ADT_ERROR");
  });
});

// ------------------------------------------------------- implementationsFrom --

describe("implementationsFrom picks the implementer rows out of a where-used result", () => {
  it("961: finds both ZCL_I91_PROBE and ZCL_I91_PROBE2 as implementers, each real-cased via its parentUri sibling, and excludes the RUN caller row", () => {
    const rows = parseUsageReferences(read("961-i91-usage-references-interface-method.xml"), ctx("usage references"));
    // Sanity on the fixture itself before trusting assertions built on top of
    // it: 5 referencedObject rows (2 classes, 2 implementer methods, 1 caller
    // method) plus the $TMP package row — 6 total, matching what was dumped
    // from the raw XML while building this test.
    expect(rows).toHaveLength(6);

    const implementations = implementationsFrom(rows, "ZIF_I91_PROBE", "PROCESS");
    expect(implementations).toHaveLength(2);

    const byClass = new Map(implementations.map((i) => [i.className, i]));
    const probe1 = byClass.get("ZCL_I91_PROBE");
    const probe2 = byClass.get("ZCL_I91_PROBE2");
    expect(probe1).toBeDefined();
    expect(probe2).toBeDefined();
    expect(probe1?.methodName).toBe("ZIF_I91_PROBE~PROCESS");
    expect(probe2?.methodName).toBe("ZIF_I91_PROBE~PROCESS");
    // The class row's own `packageRef` names $TMP — carried through onto the
    // implementer, not fabricated.
    expect(probe1?.packageName).toBe("$TMP");

    // The caller row (own adtcore:name is plainly "RUN", not
    // "ZIF_I91_PROBE~PROCESS") must never be reported as an implementer.
    expect(implementations.some((i) => i.methodName === "RUN")).toBe(false);
    expect(implementations).toHaveLength(2);
  });

  it("961: the caller row alone (without the interface-method rows) yields no implementers", () => {
    const rows = parseUsageReferences(read("961-i91-usage-references-interface-method.xml"), ctx("usage references"));
    const runRowOnly = rows.filter((r) => r["adtcore:name"] === "RUN");
    expect(runRowOnly).toHaveLength(1);
    expect(implementationsFrom(runRowOnly, "ZIF_I91_PROBE", "PROCESS")).toEqual([]);
  });

  it("961: implementationsFrom over parseUsageReferences finds both implementing classes", () => {
    const rows = parseUsageReferences(read("961-i91-usage-references-interface-method.xml"), ctx("usage references"));
    const implementations = implementationsFrom(rows, "ZIF_I91_PROBE", "PROCESS");
    const names = implementations.map((i) => i.className).sort();
    expect(names).toEqual(["ZCL_I91_PROBE", "ZCL_I91_PROBE2"]);
    for (const impl of implementations) {
      expect(impl.methodName).toBe("ZIF_I91_PROBE~PROCESS");
      expect(impl.packageName).toBe("$TMP");
    }
    expect(implementations.map((i) => i.className).includes("ZCL_I91_PROBE2")).toBe(true);
  });
});

// -------------------------------------------------------- noTargetReasonFor --

/**
 * `noTargetReasonFor` is pure over a plain thrown-exception shape plus the
 * `AbapError` `translateAdtError` already turned it into — it takes no
 * connection, so it is covered directly here rather than through
 * `findDefinitionTarget` (which this file does not import or call; see the
 * module header). `translateAdtError` itself is pure over a plain object
 * too, so building the "thrown exception" as a literal below and running it
 * through both is a faithful, no-network replay of what
 * `findDefinitionTarget`'s catch block actually does.
 */
describe("noTargetReasonFor classifies why ADT declined to name a navigation target", () => {
  it("ED263 NavigationFailure classifies as declaration-itself", () => {
    // Live-captured 2026-09-15 against A4H at
    // `/sap/bc/adt/oo/classes/cl_abap_typedescr/source/main#start=21,7;end=21,20`
    // (`  data ABSOLUTE_NAME type ABAP_ABSTYPENAME read-only .` — a
    // variable's own declaration), reproduced identically at lines 23 and 27.
    // The thrown object's shape, dumped in full: constructor
    // `AdtErrorException`, `err: 400`, `type: "NavigationFailure"`,
    // `namespace: "com.sap.adt"`, `properties: {"T100KEY-ID": "ED",
    // "T100KEY-NO": "263"}`, `message`/`localizedMessage`: "Definition
    // location found; where-used list may be possible", no response body.
    const e = {
      err: 400,
      type: "NavigationFailure",
      namespace: "com.sap.adt",
      properties: { "T100KEY-ID": "ED", "T100KEY-NO": "263" },
      message: "Definition location found; where-used list may be possible",
      localizedMessage: "Definition location found; where-used list may be possible",
    };
    const translated = translateAdtError(e, ctx("navigation target"));
    expect(noTargetReasonFor(e, translated)).toBe("declaration-itself");
  });

  it("SEDI_ADT 2 ExceptionMultipleNavigationTargets classifies as undecidable", () => {
    // Live-captured 2026-09-15 against A4H: `abap_read view=definition` on an
    // interface's own `METHODS run` declaration with two implementing classes
    // (`ZCL_V91_PROBE`, `ZCL_V91_PROBE2`, both since deleted) threw
    // `AdtErrorException` with `err: 422`,
    // `type: "ExceptionMultipleNavigationTargets"`, `namespace: "com.sap.adt"`,
    // `properties: {"T100KEY-ID": "SEDI_ADT", "T100KEY-NO": "2"}`, message
    // "Navigation target undecidable: More than one implementation exists".
    const e = {
      err: 422,
      type: "ExceptionMultipleNavigationTargets",
      namespace: "com.sap.adt",
      properties: { "T100KEY-ID": "SEDI_ADT", "T100KEY-NO": "2" },
      message: "Navigation target undecidable: More than one implementation exists",
      localizedMessage: "Navigation target undecidable: More than one implementation exists",
    };
    const translated = translateAdtError(e, ctx("navigation target"));
    expect(noTargetReasonFor(e, translated)).toBe("undecidable");
  });

  it("ExceptionMultipleNavigationTargets without a T100 key still classifies as undecidable", () => {
    const e = { err: 422, type: "ExceptionMultipleNavigationTargets", message: "More than one implementation exists" };
    const translated = translateAdtError(e, ctx("navigation target"));
    expect(noTargetReasonFor(e, translated)).toBe("undecidable");
  });

  it("a navigation-target error saying the target is undecidable classifies as undecidable", () => {
    // The other live-observed "no target" shape (see NAVIGATION_UNDECIDABLE_RE's
    // doc comment in element-info.ts): never captured with its properties, so
    // unlike ED263 above it has no T100 key — the message is the only
    // evidence, matched via `noTargetReasonFor`'s tier 3 (no type available).
    const e = {
      err: 400,
      message: "Navigation target undecidable: More than one implementation exists",
    };
    const translated = translateAdtError(e, ctx("navigation target"));
    expect(noTargetReasonFor(e, translated)).toBe("undecidable");
  });

  it("an unrelated ADT error is not classified as a missing navigation target", () => {
    // A 403 ExceptionResourceNoAccess (the "someone else holds the lock"
    // shape used elsewhere in this codebase) has nothing to do with
    // navigation targets at all — must not be misread as either "no target"
    // reason.
    const e = {
      err: 403,
      type: "ExceptionResourceNoAccess",
      properties: {},
      message: "Cannot access object, it is locked",
    };
    const translated = translateAdtError(e, ctx("navigation target"));
    expect(noTargetReasonFor(e, translated)).toBeUndefined();
  });
});
