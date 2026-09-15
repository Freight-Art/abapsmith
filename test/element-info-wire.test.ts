/**
 * Wire-fidelity pin for `src/adt/element-info.ts`: replays the real A4H
 * captures 891-897, 899, 900 in `test/fixtures/live-captured/` (`i91-*`)
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
 * `identifierAt` and `implementationsFrom` are.
 *
 * `implementationsFrom` itself takes already-parsed where-used rows, not raw
 * XML — production gets those rows from `conn.adt.usageReferences()`,
 * `abap-adt-api`'s own wire client, not from anything in this repo. To drive
 * it from fixture 900's raw bytes, `loadUsageReferenceRows` below re-derives
 * the same flat row shape `implementationsFrom`'s own doc comment specifies
 * (`uri`, `parentUri`, `"adtcore:name"`, `"adtcore:type"`, `packageRef:
 * {"adtcore:name": …}`) directly off the wire XML, the same way
 * `read-description-pairing.test.ts` builds `loadObjectReferences` for its
 * own fixture rather than depending on a vendor parser. This is deliberate,
 * not an oversight: the installed `abap-adt-api@8.4.1`'s own `usageReferences`
 * (`node_modules/abap-adt-api/build/api/syntax.js`) looks up the document by
 * the hardcoded path `"usageReferences:referencedObject"` (capital `R`), but
 * fixture 900's actual wire bytes declare and use the namespace prefix
 * `usagereferences` (all lowercase) throughout — `xmlns:usagereferences=` and
 * every `<usagereferences:…>` tag. Feeding fixture 900 through that vendor
 * function directly (confirmed with a throwaway script against the installed
 * package) returns an EMPTY array, not the two implementers this fixture
 * carries — a vendor-library defect distinct from anything in
 * `element-info.ts`, and out of scope to fix here. `loadUsageReferenceRows`
 * therefore matches the fixture's real lowercase prefix, which is also what
 * `implementationsFrom`'s doc comment describes the row shape as.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import {
  elementInfoFragmentUri,
  identifierAt,
  implementationsFrom,
  isUnresolved,
  parseElementInfo,
  parseNavigationTarget,
  splitFragmentUri,
} from "../src/adt/element-info.js";
import type { ErrorContext } from "../src/adt/session.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const read = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");
const ctx = (operation: string): ErrorContext => ({ operation });

// --------------------------------------------------------- 891-896, 899 --

describe("parseElementInfo replays the captured elementinfo documents", () => {
  it("891: interface method PROCESS resolves to INTF/IO with two INTF/IOP parameter children", () => {
    const info = parseElementInfo(read("891-i91-elementinfo-interface-method.xml"), ctx("element info"));
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

  it("892: private instance attribute MV_COUNT resolves to CLAS/OA with visibility, level and abapType", () => {
    const info = parseElementInfo(read("892-i91-elementinfo-attribute.xml"), ctx("element info"));
    expect(info.type).toBe("CLAS/OA");
    expect(info.name).toBe("MV_COUNT");
    expect(info.properties).toEqual({ visibility: "private", level: "instance", abapType: "TYPE I" });
    expect(info.shortText).toBe("Characters counted so far");
    expect(info.abapDoc).toContain("Characters counted so far");
    expect(info.children).toEqual([]);
  });

  it("893: structured type TY_ROW has an empty abapType and untyped component children", () => {
    const info = parseElementInfo(read("893-i91-elementinfo-type.xml"), ctx("element info"));
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

  it("894: local data reference LO_PROBE resolves to CLAS/OOV, visibility=local, no documentation", () => {
    const info = parseElementInfo(read("894-i91-elementinfo-local-variable.xml"), ctx("element info"));
    expect(info.type).toBe("CLAS/OOV");
    expect(info.name).toBe("LO_PROBE");
    expect(info.properties).toEqual({ visibility: "local", abapType: "TYPE REF TO ZIF_I91_PROBE" });
    expect(info.shortText).toBeUndefined();
    expect(info.abapDoc).toBeUndefined();
    expect(info.children).toEqual([]);
  });

  it("895: own method RUN carries paramDefaultValue on the optional IV_TIMES parameter only", () => {
    const info = parseElementInfo(read("895-i91-elementinfo-method-own.xml"), ctx("element info"));
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

  it("896: function module RFC_PING is thin — empty properties, no doc, no children (ADT limitation for FUGR/FF, not a parser gap)", () => {
    // The wire body for this one is deliberately minimal:
    //   <abapsource:elementInfo adtcore:type="FUGR/FF" adtcore:name="RFC_PING" …>
    //     <abapsource:properties/>
    //   </abapsource:elementInfo>
    // ADT itself never sends visibility, a signature or documentation for a
    // function-module name literal here — this is what A4H actually answered
    // (see the fixture's own `.meta.json` "expect"), not something
    // `parseElementInfo` failed to extract.
    const info = parseElementInfo(read("896-i91-elementinfo-function-module.xml"), ctx("element info"));
    expect(info.type).toBe("FUGR/FF");
    expect(info.name).toBe("RFC_PING");
    expect(info.properties).toEqual({});
    expect(info.properties.visibility).toBeUndefined();
    expect(info.shortText).toBeUndefined();
    expect(info.abapDoc).toBeUndefined();
    expect(info.children).toEqual([]);
  });

  it("899: a position with nothing resolvable answers 200 with an elementInfo that has no adtcore:name", () => {
    const info = parseElementInfo(read("899-i91-elementinfo-no-element.xml"), ctx("element info"));
    expect(info.name).toBeUndefined();
    expect(info.type).toBeUndefined();
    // This is a successful, well-formed answer, not an error — isUnresolved
    // is how callers are meant to distinguish "resolved to nothing" from a
    // wire/parse failure, which would have thrown instead of returning here.
    expect(isUnresolved(info)).toBe(true);
  });
});

// -------------------------------------------------------------- 897 --

describe("parseNavigationTarget / splitFragmentUri replay the definition-target document", () => {
  it("897: go-to-definition answers an objectReference whose uri fragment splits into line 8, column 10", () => {
    const target = parseNavigationTarget(read("897-i91-navigation-target-definition.xml"), ctx("navigation target"));
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

// ------------------------------------------------------- implementationsFrom --

/**
 * Flat where-used row, re-derived off fixture 900's raw XML the same way
 * `implementationsFrom`'s own doc comment describes `abap-adt-api`'s
 * `usageReferences` as shaping it: the `referencedObject`'s own `uri` /
 * `parentUri` attributes, spread with its nested `adtObject`'s attributes
 * (`adtcore:name`, `adtcore:type` when present), plus `packageRef` lifted
 * from `adtObject`'s own nested `packageRef` element. See the module
 * doc comment at the top of this file for why this is NOT simply a call to
 * the vendor's own `usageReferences` function against this fixture.
 */
function loadUsageReferenceRows(file: string): Record<string, unknown>[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseAttributeValue: true,
    isArray: (_name, jpath) => jpath === "usagereferences:usageReferenceResult.usagereferences:referencedObjects.usagereferences:referencedObject",
  });
  const doc = parser.parse(read(file)) as Record<string, unknown>;
  const result = doc["usagereferences:usageReferenceResult"] as Record<string, unknown>;
  const objects = result["usagereferences:referencedObjects"] as Record<string, unknown>;
  const rows = objects["usagereferences:referencedObject"] as Record<string, unknown>[];

  const attrsOf = (node: unknown): Record<string, unknown> => {
    const rec = (node !== null && typeof node === "object" ? (node as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rec)) {
      if (key.startsWith("@_") && key !== "@_xmlns" && !key.startsWith("@_xmlns:")) out[key.slice(2)] = value;
    }
    return out;
  };

  return rows.map((row) => {
    const adtObject = (row["usagereferences:adtObject"] ?? {}) as Record<string, unknown>;
    const packageRefNode = adtObject["adtcore:packageRef"];
    return {
      ...attrsOf(row),
      ...attrsOf(adtObject),
      packageRef: attrsOf(packageRefNode),
      objectIdentifier: typeof row["objectIdentifier"] === "string" ? row["objectIdentifier"] : "",
    };
  });
}

describe("implementationsFrom picks the implementer rows out of a where-used result", () => {
  it("900: finds both ZCL_I91_PROBE and ZCL_I91_PROBE2 as implementers, each real-cased via its parentUri sibling, and excludes the RUN caller row", () => {
    const rows = loadUsageReferenceRows("900-i91-usage-references-interface-method.xml");
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

  it("900: the caller row alone (without the interface-method rows) yields no implementers", () => {
    const rows = loadUsageReferenceRows("900-i91-usage-references-interface-method.xml");
    const runRowOnly = rows.filter((r) => r["adtcore:name"] === "RUN");
    expect(runRowOnly).toHaveLength(1);
    expect(implementationsFrom(runRowOnly, "ZIF_I91_PROBE", "PROCESS")).toEqual([]);
  });
});
