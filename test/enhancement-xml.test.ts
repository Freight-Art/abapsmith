/**
 * `src/adt/enhancement-xml.ts` — decode of the three enhancement/BAdI ADT
 * collections (`enhoxh`, `enhoxhh`, `enhsxs`).
 *
 * The binding acceptance criterion:
 * the decoders must turn the captured 354, 470, 343, 403 documents (plus the
 * two enhoxhh captures at ledger rows 19/21) byte-in, structure-out — every
 * fixture below is copied unmodified from a real live capture against A4H,
 * not a synthetic string.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isAbapError } from "../src/adt/errors.js";
import {
  parseBadiImplementation,
  parseSourceCodePlugin,
  parseEnhancementSpot,
  patchBadiImplementationActive,
} from "../src/adt/enhancement-xml.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement");
const read = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

describe("parseBadiImplementation (enhoxh)", () => {
  it("decodes capture #354 — no filter tree set", () => {
    const xml = read("354-enhoxh-no-filter.xml");
    const doc = parseBadiImplementation(xml);

    expect(doc.name).toBe("ZMCP_ENH_BADI");
    expect(doc.type).toBe("ENHO/XH");
    expect(doc.activationStatus).toBe("active");
    expect(doc.packageRef?.name).toBe("$TMP");
    expect(doc.toolType).toBe("BADI_IMPL");
    expect(doc.implementations).toHaveLength(1);

    const impl = doc.implementations[0]!;
    expect(impl.name).toBe("ZMCP_BADI_I1");
    expect(impl.isActive).toBe(true);
    expect(impl.isDefault).toBe(false);
    expect(impl.enhancementSpot).toEqual({
      uri: "/sap/bc/adt/enhancements/enhsxs/zmcp_spot",
      type: "ENHS/XS",
      name: "ZMCP_SPOT",
    });
    expect(impl.badiDefinition?.name).toBe("ZMCP_BADI_D1");
    expect(impl.implementingClass?.name).toBe("ZCL_MCP_BADI_IMPL");
    // No filter values set on this object at capture time — the field is
    // ABSENT, not an empty tree.
    expect(impl.filterTree).toBeUndefined();
  });

  it("decodes capture #470 — nested filter tree (or > and > or > filter)", () => {
    const xml = read("470-enhoxh-with-filter.xml");
    const doc = parseBadiImplementation(xml);

    const impl = doc.implementations[0]!;
    expect(impl.filterTree).toBeDefined();
    expect(impl.filterTree?.kind).toBe("or");
    if (impl.filterTree?.kind !== "or") throw new Error("expected or node");
    const and = impl.filterTree.children[0];
    expect(and?.kind).toBe("and");
    if (and?.kind !== "and") throw new Error("expected and node");
    const innerOr = and.children[0];
    expect(innerOr?.kind).toBe("or");
    if (innerOr?.kind !== "or") throw new Error("expected inner or node");
    const leaf = innerOr.children[0];
    expect(leaf?.kind).toBe("filter");
    if (leaf?.kind !== "filter") throw new Error("expected filter leaf");
    expect(leaf.condition).toEqual({
      filterName: "FLT",
      filterType: "C",
      comparator1: "=",
      value1: "ALPHA",
      comparator2: undefined,
      value2: undefined,
    });
  });

  it("throws BAD_INPUT on a document that is not an enhoxh objectData root", () => {
    let threw: unknown;
    try {
      parseBadiImplementation("<foo/>");
    } catch (e) {
      threw = e;
    }
    expect(isAbapError(threw)).toBe(true);
    expect((threw as { code?: string }).code).toBe("BAD_INPUT");
  });
});

describe("parseEnhancementSpot (enhsxs)", () => {
  it("decodes capture #343 — BAdI definition with no filter declarations", () => {
    const xml = read("343-enhsxs-no-filters.xml");
    const doc = parseEnhancementSpot(xml);

    expect(doc.name).toBe("ZMCP_SPOT");
    expect(doc.type).toBe("ENHS/XS");
    expect(doc.toolType).toBe("BADI_DEF");
    expect(doc.internal).toBe(false);
    expect(doc.badiDefinitions).toHaveLength(1);

    const def = doc.badiDefinitions[0]!;
    expect(def.name).toBe("ZMCP_BADI_D1");
    expect(def.singleUse).toBe(true);
    expect(def.interfaceRef).toEqual({
      uri: "/sap/bc/adt/oo/interfaces/zif_mcp_badi",
      type: "INTF/OI",
      name: "ZIF_MCP_BADI",
    });
    expect(def.filters).toEqual([]);
  });

  it("decodes capture #403 — same spot after a filter declaration was added", () => {
    const xml = read("403-enhsxs-with-filters.xml");
    const doc = parseEnhancementSpot(xml);

    const def = doc.badiDefinitions[0]!;
    expect(def.filters).toHaveLength(1);
    expect(def.filters[0]).toEqual({
      filterName: "FLT",
      filterType: "C",
      shorttext: "ZMCP recon filter",
      onlyConstantFilterValues: false,
    });
  });
});

describe("parseSourceCodePlugin (enhoxhh)", () => {
  it("decodes a class-hook plugin (ledger row 19)", () => {
    const xml = read("019-enhoxhh-class-hook.xml");
    const doc = parseSourceCodePlugin(xml);

    expect(doc.name).toBe("SEU_TEST_CLS_ENH_IMPL_TEMPLATE");
    expect(doc.type).toBe("ENHO/XHH");
    expect(doc.toolType).toBe("HOOK_IMPL");
    expect(doc.sourceUri).toBe("./seu_test_cls_enh_impl_template/source/main");
    expect(doc.usages).toHaveLength(2);
    expect(doc.usages[0]).toEqual({
      programId: "R3TR",
      elementUsage: "REDO",
      upgrade: false,
      automaticTransport: false,
      parent: undefined,
      objectReference: {
        uri: "/sap/bc/adt/oo/classes/cl_spot_enh_template_001",
        type: "CLAS/OC",
        name: "CL_SPOT_ENH_TEMPLATE_001",
      },
      mainObjectReference: {
        uri: "/sap/bc/adt/oo/classes/cl_spot_enh_template_001",
        type: "CLAS/OC",
        name: "CL_SPOT_ENH_TEMPLATE_001",
      },
    });
    expect(doc.enhancedObject?.name).toBe("CL_SPOT_ENH_TEMPLATE_001");
    expect(doc.hookImplementations).toHaveLength(1);

    const hook = doc.hookImplementations[0]!;
    expect(hook.spotName).toBe("SEU_TEST_CLASS_SPOT_0000001");
    expect(hook.programName).toBe("CL_SPOT_ENH_TEMPLATE_001======CP");
    expect(hook.fullName).toBe(
      "\\PR:CL_SPOT_ENH_TEMPLATE_001======CP\\EX:SEU_TEST_CLASS_SPOT_0000001\\EI",
    );
    expect(hook.enclosureUri).toBe("/sap/bc/adt/oo/classes/cl_spot_enh_template_001#start=4,80");
    expect(doc.switchState).toBeUndefined();
  });

  it("decodes a function-module hook plugin with a switch gate and a parent-linked usage (ledger row 21)", () => {
    const xml = read("021-enhoxhh-fm-hook-with-switch.xml");
    const doc = parseSourceCodePlugin(xml);

    expect(doc.name).toBe("IBASE_SWITCH_CHECK_IM");
    expect(doc.switchState).toBe("off");
    expect(doc.switchReference).toEqual({
      uri: "/sap/bc/adt/vit/wb/object_type/sfsw6s/object_name/IBASE_ILM_SWITCH",
      type: "SFSW/6S",
      name: "IBASE_ILM_SWITCH",
    });
    expect(doc.usages).toHaveLength(2);
    // Second usage row carries a #///-fragment parent pointer back at the first.
    expect(doc.usages[1]?.parent).toBe("#///contentCommon/usages/1");
    expect(doc.usages[1]?.programId).toBe("LIMU");

    const hook = doc.hookImplementations[0]!;
    expect(hook.fullName).toBe("\\FU:IB_CHECK_IBASE_SWITCH\\SE:END\\EI");
  });

  it("throws BAD_INPUT on a document that is not an enho:enhancement root", () => {
    let threw: unknown;
    try {
      parseSourceCodePlugin("<foo/>");
    } catch (e) {
      threw = e;
    }
    expect(isAbapError(threw)).toBe(true);
    expect((threw as { code?: string }).code).toBe("BAD_INPUT");
  });
});

// ===========================================================================
// patchBadiImplementationActive — byte-preserving regex patch of a single
// <enho:badiImplementation>'s own isActive attribute (set_impl_active).
// Same discipline as patchEnhancementRootAttribute: never parse->rebuild->
// serialise, so every assertion below is against the WHOLE returned document
// (or an explicitly-constructed expected whole document), never a substring
// containment check on its own — a substring check would pass even if the
// function silently mangled unrelated bytes elsewhere.
// ===========================================================================

describe("patchBadiImplementationActive", () => {
  const XML_354 = read("354-enhoxh-no-filter.xml");

  it('real capture #354: flips enho:isActive="true" -> "false", every other byte identical', () => {
    // #354 has exactly one <enho:badiImplementation enho:name="ZMCP_BADI_I1" ... enho:isActive="true" ...>.
    // Building the expected document via a single literal .replace() on the
    // ORIGINAL (unmodified) fixture is safe here specifically because
    // 'enho:isActive="true"' occurs exactly once in that document — so this
    // is a whole-document equality assertion, not a substring one.
    expect(XML_354.match(/enho:isActive="true"/g)).toHaveLength(1);
    const expected = XML_354.replace('enho:isActive="true"', 'enho:isActive="false"');

    const result = patchBadiImplementationActive(XML_354, "ZMCP_BADI_I1", false);

    expect(result).toBe(expected);
    expect(result).not.toBe(XML_354);
  });

  it("inserts enho:isActive when the entry has no such attribute at all", () => {
    const doc =
      `<enho:objectData xmlns:enho="ns"><enho:badiImplementations>` +
      `<enho:badiImplementation enho:name="ZIMPL1" enho:shortText="x"></enho:badiImplementation>` +
      `</enho:badiImplementations></enho:objectData>`;

    const result = patchBadiImplementationActive(doc, "ZIMPL1", false);

    expect(result).toBe(
      `<enho:objectData xmlns:enho="ns"><enho:badiImplementations>` +
        `<enho:badiImplementation enho:name="ZIMPL1" enho:shortText="x" enho:isActive="false"></enho:badiImplementation>` +
        `</enho:badiImplementations></enho:objectData>`,
    );
  });

  it("handles the unprefixed isActive= spelling, preserving the unprefixed style on replace", () => {
    const doc = `<enho:badiImplementation enho:name="ZIMPL1" isActive="true"></enho:badiImplementation>`;

    const result = patchBadiImplementationActive(doc, "ZIMPL1", false);

    // The unprefixed spelling is preserved as unprefixed — the function must
    // not silently rewrite it to enho:isActive on replace.
    expect(result).toBe(
      `<enho:badiImplementation enho:name="ZIMPL1" isActive="false"></enho:badiImplementation>`,
    );
  });

  it("multiple <enho:badiImplementation> entries: patches only the matching one, the other is byte-identical", () => {
    const doc =
      `<enho:objectData xmlns:enho="ns"><enho:badiImplementations>` +
      `<enho:badiImplementation enho:name="ZMCP_BADI_A" enho:isActive="true"><enho:enhancementSpot adtcore:name="A"/></enho:badiImplementation>` +
      `<enho:badiImplementation enho:name="ZMCP_BADI_B" enho:isActive="false"><enho:enhancementSpot adtcore:name="B"/></enho:badiImplementation>` +
      `</enho:badiImplementations></enho:objectData>`;

    // The B fragment is unambiguous (occurs once) in the source document, so
    // building the expected whole document with a single literal .replace()
    // is a safe way to state ground truth for a whole-document equality check.
    const expected = doc.replace(
      'enho:name="ZMCP_BADI_B" enho:isActive="false"',
      'enho:name="ZMCP_BADI_B" enho:isActive="true"',
    );

    const result = patchBadiImplementationActive(doc, "ZMCP_BADI_B", true);

    expect(result).toBe(expected);
    // Explicit belt-and-suspenders: entry A's own tag is untouched, char for char.
    expect(result).toContain(
      '<enho:badiImplementation enho:name="ZMCP_BADI_A" enho:isActive="true"><enho:enhancementSpot adtcore:name="A"/></enho:badiImplementation>',
    );
  });

  it("does not touch a same-named attribute inside a CHILD element (enhancementSpot/badiDefinition/implementingClass/filterTree)", () => {
    // A deliberately hostile fixture: a child element (filterTree, a real
    // child of badiImplementation per capture #470) carries an attribute
    // that is ALSO literally named "isActive" — if the patch function ever
    // scanned past the opening tag's own '>' this would get corrupted too.
    const doc =
      `<enho:badiImplementation enho:name="ZMCP_BADI_C" enho:isActive="true">` +
      `<enho:enhancementSpot adtcore:name="ZMCP_SPOT"/>` +
      `<enho:badiDefinition adtcore:name="ZMCP_BADI_D1"/>` +
      `<enho:implementingClass adtcore:name="ZCL_X"/>` +
      `<enho:filterTree isActive="rogue-should-not-be-touched"><enho:or/></enho:filterTree>` +
      `</enho:badiImplementation>`;

    const result = patchBadiImplementationActive(doc, "ZMCP_BADI_C", false);

    expect(result).toBe(
      `<enho:badiImplementation enho:name="ZMCP_BADI_C" enho:isActive="false">` +
        `<enho:enhancementSpot adtcore:name="ZMCP_SPOT"/>` +
        `<enho:badiDefinition adtcore:name="ZMCP_BADI_D1"/>` +
        `<enho:implementingClass adtcore:name="ZCL_X"/>` +
        `<enho:filterTree isActive="rogue-should-not-be-touched"><enho:or/></enho:filterTree>` +
        `</enho:badiImplementation>`,
    );
    // Redundant, explicit check that the rogue child attribute survived verbatim.
    expect(result).toContain('isActive="rogue-should-not-be-touched"');
  });

  it("throws BAD_INPUT when no <enho:badiImplementation> entry with that name exists", () => {
    let threw: unknown;
    try {
      patchBadiImplementationActive(XML_354, "NO_SUCH_ENTRY", false);
    } catch (e) {
      threw = e;
    }
    expect(isAbapError(threw)).toBe(true);
    expect((threw as { code?: string }).code).toBe("BAD_INPUT");
  });

  it("a name containing regex metacharacters (. + ( ) $) matches ONLY literally — proves escapeRegExp is actually applied", () => {
    // Without escaping, the pattern built from "ZMCP.BADI" would treat '.' as
    // a wildcard, so it would ALSO match the decoy entry "ZMCPXBADI" (any
    // single char in place of the literal '.') — and since the decoy is
    // listed FIRST, an unescaped implementation would select and patch the
    // WRONG entry, leaving the real target untouched.
    const doc =
      `<enho:objectData xmlns:enho="ns"><enho:badiImplementations>` +
      `<enho:badiImplementation enho:name="ZMCPXBADI" enho:isActive="true"></enho:badiImplementation>` +
      `<enho:badiImplementation enho:name="ZMCP.BADI+X(1)$" enho:isActive="true"></enho:badiImplementation>` +
      `</enho:badiImplementations></enho:objectData>`;

    const result = patchBadiImplementationActive(doc, "ZMCP.BADI+X(1)$", false);

    // Decoy untouched, byte for byte.
    expect(result).toContain('<enho:badiImplementation enho:name="ZMCPXBADI" enho:isActive="true"></enho:badiImplementation>');
    // The real, metacharacter-laden target was the one actually patched.
    expect(result).toContain('<enho:badiImplementation enho:name="ZMCP.BADI+X(1)$" enho:isActive="false"></enho:badiImplementation>');
  });

  it("an implementation name that requires XML-attribute escaping round-trips correctly", () => {
    // escapeXmlAttr(implName) must match how the name is actually SERIALISED
    // in the document's own enho:name attribute — here "A&B" is written as
    // the XML-escaped "A&amp;B", and the function is called with the RAW,
    // unescaped name, exactly as a caller would supply it.
    const doc = `<enho:badiImplementation enho:name="A&amp;B" enho:isActive="true"></enho:badiImplementation>`;

    const result = patchBadiImplementationActive(doc, "A&B", false);

    expect(result).toBe(
      `<enho:badiImplementation enho:name="A&amp;B" enho:isActive="false"></enho:badiImplementation>`,
    );
  });
});
