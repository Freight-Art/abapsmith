/**
 * Silent-loss guard for the DOMA/DD fixed-value-text bug.
 *
 * The cause is now known. A `DOMA/DD` write whose root element
 * omits `adtcore:masterLanguage` silently drops every
 * `<doma:fixedValue><doma:text>` description while the fixed-value codes
 * survive; adding the attribute and re-writing repairs an already-damaged
 * domain in place. `assertDomaMasterLanguage` in src/adt/write.ts now
 * refuses such a payload before it is sent.
 *
 * The seven-trial live A4H verification this file used to cite
 * (`ZFIXD_DOM1,2,5,6,7,8,9`) tested a *different* hypothesis: whether the
 * `language` attribute on the `<doma:text>` CHILD element mattered. It
 * didn't — a payload sending `language="EN"` (`ZFIXD_DOM9`) lost its text
 * exactly like one that omitted it (`ZFIXD_DOM1`/`ZFIXD_DOM8`), correctly
 * falsifying that hypothesis. None of those trials varied
 * `adtcore:masterLanguage` on the root, so the loss looked unconditional
 * from that data alone — it wasn't; the trials simply never isolated the
 * real variable. This file's own docblock was one of the three sources that
 * repeated the "dropped unconditionally, mechanism unknown" conclusion after
 * it had already been narrowed.
 *
 * This module has no code-level XML *emitter* for DOMA writes (see the
 * "the write guard" section in src/adt/ddic.ts) — the calling LLM composes
 * the PUT body by hand, per skills/ddic/SKILL.md's read-then-imitate
 * workflow. The pre-send lint that used to live here
 * (`lintDdicWritePayload`, checking `language` on the child `<doma:text>`)
 * was deleted rather than reworded, since that attribute was shown to make
 * no difference — see the "the write guard" comment in src/adt/ddic.ts for
 * the full rationale; that finding stands and is unrelated to
 * `adtcore:masterLanguage`. `renderDomain`'s read-back notes (tested below)
 * now name the real cause and remedy, and mainly matter for domains written
 * before `assertDomaMasterLanguage` shipped.
 *
 * Plus the parser fix itself, kept as defensive/harmless even though live
 * testing found real SAP responses (XFELD, BOOLE, and everything written
 * during the verification round) never actually carry the `language`
 * attribute on `<doma:text>` on that system: `parseDomainXml` must keep
 * reading `text` as a string in case SAP ever does echo back
 * `<doma:text language="EN">…</doma:text>` — fast-xml-parser turns an
 * attributed leaf into `{ "@_language": ..., "#text": ... }`, and a raw
 * `f.text` read would silently start rendering "[object Object]".
 */
import { describe, expect, it } from "vitest";
import { readDdic, renderDomain } from "../src/adt/ddic.js";
import { assertDomaMasterLanguage, injectEmptyFixValues, type ResolvedTarget } from "../src/adt/write.js";
import { isAbapError } from "../src/adt/errors.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";

function obj(kind: string, name: string, uri: string): ResolvedObject {
  return {
    system: "A4H",
    type: `${kind}/X`,
    kind,
    label: kind,
    name,
    uri,
    mode: "ddic",
    activation: "unknown",
    spec: { type: `${kind}/X`, kind, label: kind, uriPath: "x", mode: "ddic" },
  } as unknown as ResolvedObject;
}

function stubDomainConn(body: string): AbapConnection {
  return {
    cfg: { sid: "A4H" },
    get: async (uri: string) => {
      if (uri.includes("/ddic/domains/")) return { body };
      throw new Error(`unexpected GET ${uri}`);
    },
    adt: { nodeContents: async () => ({ nodes: [] }) },
  } as unknown as AbapConnection;
}

/** Domain descriptor shape verified against parseDomainXml's doma:content schema. */
function domainXmlWithFixValues(fixValuesXml: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" ' +
    'xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZDOM" adtcore:type="DOMA/DD" ' +
    'adtcore:description="A domain"><adtcore:packageRef adtcore:name="ZPKG"/>' +
    "<doma:content><doma:typeInformation><doma:datatype>CHAR</doma:datatype>" +
    "<doma:length>1</doma:length><doma:decimals>0</doma:decimals></doma:typeInformation>" +
    "<doma:outputInformation><doma:length>1</doma:length><doma:lowercase>false</doma:lowercase>" +
    "<doma:signExists>false</doma:signExists></doma:outputInformation>" +
    `<doma:valueInformation><doma:fixValues>${fixValuesXml}</doma:fixValues></doma:valueInformation>` +
    "</doma:content></doma:domain>"
  );
}

describe("parseDomainXml (via readDdic) — reading fixed-value text through xmlText", () => {
  it("reads text with no language attribute the same as before this fix (plain string)", async () => {
    const xml = domainXmlWithFixValues(
      "<doma:fixValue><doma:low>1</doma:low><doma:text>Truck</doma:text></doma:fixValue>",
    );
    const r = await readDdic(stubDomainConn(xml), obj("DOMA", "ZDOM", "/sap/bc/adt/ddic/domains/zdom"));
    const fixedValuesSection = r.sections.find((s) => s.title === "FIXED VALUES");
    expect(fixedValuesSection?.content).toContain("Truck");
    expect(fixedValuesSection?.content).not.toContain("[object Object]");
  });

  it("reads text WITH a language attribute as a string, not [object Object]", async () => {
    const xml = domainXmlWithFixValues(
      '<doma:fixValue><doma:low>1</doma:low><doma:text language="EN">Truck</doma:text></doma:fixValue>',
    );
    const r = await readDdic(stubDomainConn(xml), obj("DOMA", "ZDOM", "/sap/bc/adt/ddic/domains/zdom"));
    const fixedValuesSection = r.sections.find((s) => s.title === "FIXED VALUES");
    // This is the exact regression this fix guards against: before routing
    // `text` through `xmlText()`, fast-xml-parser's `{ "@_language": "EN",
    // "#text": "Truck" }` shape would have been read as a raw string and
    // rendered via `String(...)` as "[object Object]".
    expect(fixedValuesSection?.content).toContain("Truck");
    expect(fixedValuesSection?.content).not.toContain("[object Object]");
    expect(fixedValuesSection?.content).not.toContain("object");
  });

  it("low/high stay correct whether or not other fixed values carry attributes", async () => {
    const xml = domainXmlWithFixValues(
      '<doma:fixValue><doma:low>1</doma:low><doma:high>5</doma:high><doma:text language="EN">Range</doma:text></doma:fixValue>',
    );
    const r = await readDdic(stubDomainConn(xml), obj("DOMA", "ZDOM", "/sap/bc/adt/ddic/domains/zdom"));
    const fixedValuesSection = r.sections.find((s) => s.title === "FIXED VALUES");
    expect(fixedValuesSection?.content).toContain("1");
    expect(fixedValuesSection?.content).toContain("5");
    expect(fixedValuesSection?.content).toContain("Range");
  });
});

describe("renderDomain — read-back guard notes for missing fixed-value text", () => {
  it("flags when ALL fixed values have no text at all", () => {
    const r = renderDomain({
      name: "ZDOM",
      dataType: "CHAR",
      length: 1,
      fixedValues: [
        { low: "1" },
        { low: "2" },
      ],
    });
    expect(r.notes.join(" ")).toMatch(/All 2 fixed value\(s\) have no text/);
    expect(r.notes.join(" ")).toMatch(/independent of whether/);
  });

  it("flags only the affected subset when some fixed values have text and some don't", () => {
    const r = renderDomain({
      name: "ZDOM",
      dataType: "CHAR",
      length: 1,
      fixedValues: [
        { low: "1", text: "Truck", textLanguage: "EN" },
        { low: "2" },
      ],
    });
    const joined = r.notes.join(" ");
    expect(joined).toMatch(/1 of 2 fixed value\(s\) have no text/);
    expect(joined).toMatch(/\(2\)/); // the offending low value is named
  });

  it("does not fire the missing-text note when every fixed value has text", () => {
    const r = renderDomain({
      name: "ZDOM",
      dataType: "CHAR",
      length: 1,
      fixedValues: [
        { low: "1", text: "Truck", textLanguage: "EN" },
        { low: "2", text: "Car", textLanguage: "EN" },
      ],
    });
    expect(r.notes.join(" ")).not.toMatch(/have no text/);
  });

  it("flags text present without an observed language attribute as worth a live check", () => {
    const r = renderDomain({
      name: "ZDOM",
      dataType: "CHAR",
      length: 1,
      fixedValues: [{ low: "1", text: "Truck" /* no textLanguage */ }],
    });
    expect(r.notes.join(" ")).toMatch(/no language attribute observed/);
  });

  it("does not fire either fixed-value guard note when there are no fixed values", () => {
    const r = renderDomain({ name: "ZDOM", dataType: "CHAR", length: 1, valueTable: "ZVT" });
    expect(r.notes.join(" ")).not.toMatch(/fixed value/i);
  });
});

// ---------------------------------------------------------------------------
// assertDomaMasterLanguage — the write-time guard.
//
// Refuses a DOMA/DD write BEFORE it is sent when the payload carries
// fixed-value <doma:text> content but the root element has no
// adtcore:masterLanguage attribute — the exact condition that reproduced
// 7/7 on live A4H (see the header comment in src/adt/write.ts
// above `assertDomaMasterLanguage`). These are pure XML-string fixtures —
// no network, no AbapConnection — proving the guard fires when and only
// when that condition holds.
// ---------------------------------------------------------------------------

function target(type: string, name = "ZDOM"): ResolvedTarget {
  return {
    spec: { type, kind: type.split("/")[0], label: type.split("/")[0], uriPath: "x", mode: "ddic" },
    type,
    name,
    uri: `/sap/bc/adt/ddic/domains/${name.toLowerCase()}`,
    sourceUri: `/sap/bc/adt/ddic/domains/${name.toLowerCase()}`,
    packageName: "ZPKG",
    description: "",
    exists: true,
    packageSource: "server",
  } as unknown as ResolvedTarget;
}

function domaXml(rootAttrs: string, fixValueXml: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZDOM" adtcore:type="DOMA/DD"${
      rootAttrs ? ` ${rootAttrs}` : ""
    }><adtcore:packageRef adtcore:name="ZPKG"/>` +
    `<doma:content><doma:valueInformation><doma:fixValues>${fixValueXml}</doma:fixValues>` +
    `</doma:valueInformation></doma:content></doma:domain>`
  );
}

describe("assertDomaMasterLanguage — the write-time guard", () => {
  it("throws BAD_INPUT when doma:text has content and the root carries no adtcore:masterLanguage", () => {
    const xml = domaXml("", "<doma:fixValue><doma:low>1</doma:low><doma:text>Truck</doma:text></doma:fixValue>");
    expect(() => assertDomaMasterLanguage(target("DOMA/DD"), xml)).toThrowError(
      /adtcore:masterLanguage/,
    );
    try {
      assertDomaMasterLanguage(target("DOMA/DD"), xml);
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("BAD_INPUT");
      expect(isAbapError(e) ? e.hint : undefined).toMatch(/masterLanguage="EN"/);
    }
  });

  it("does NOT fire when adtcore:masterLanguage is present on the root", () => {
    const xml = domaXml(
      'adtcore:masterLanguage="EN"',
      "<doma:fixValue><doma:low>1</doma:low><doma:text>Truck</doma:text></doma:fixValue>",
    );
    expect(() => assertDomaMasterLanguage(target("DOMA/DD"), xml)).not.toThrow();
  });

  it("does NOT fire when doma:text is absent", () => {
    const xml = domaXml("", "<doma:fixValue><doma:low>1</doma:low></doma:fixValue>");
    expect(() => assertDomaMasterLanguage(target("DOMA/DD"), xml)).not.toThrow();
  });

  it("does NOT fire when doma:text is present but empty", () => {
    const xml = domaXml(
      "",
      "<doma:fixValue><doma:low>1</doma:low><doma:text></doma:text></doma:fixValue>" +
        "<doma:fixValue><doma:low>2</doma:low><doma:text>   </doma:text></doma:fixValue>",
    );
    expect(() => assertDomaMasterLanguage(target("DOMA/DD"), xml)).not.toThrow();
  });

  it("does NOT fire for a DTEL payload even with text-shaped content and no masterLanguage", () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><dtel:dataElement xmlns:dtel="http://www.sap.com/dictionary/dataelement" ' +
      'xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZDTEL" adtcore:type="DTEL/DE">' +
      "<doma:text>Truck</doma:text></dtel:dataElement>";
    expect(() => assertDomaMasterLanguage(target("DTEL/DE"), xml)).not.toThrow();
  });

  it("does NOT fire for a CLAS payload", () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><class:abapClass xmlns:class="http://www.sap.com/adt/oo/classes" ' +
      'xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZCL_FOO" adtcore:type="CLAS/OC">' +
      "<doma:text>Truck</doma:text></class:abapClass>";
    expect(() => assertDomaMasterLanguage(target("CLAS/OC"), xml)).not.toThrow();
  });

  it("ignores doma:text content hidden inside an XML comment", () => {
    const xml = domaXml(
      "",
      "<!-- <doma:fixValue><doma:low>1</doma:low><doma:text>Truck</doma:text></doma:fixValue> -->",
    );
    expect(() => assertDomaMasterLanguage(target("DOMA/DD"), xml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// injectEmptyFixValues — the write-path normaliser for the
// mandatory-but-empty <doma:fixValues/> tag.
//
// A DOMA/DD write whose <doma:valueInformation> omits <doma:fixValues>
// entirely is REJECTED by the server for a domain with no fixed values — an
// empty self-closing <doma:fixValues/> child is mandatory even then
// (live-confirmed across 11 of 12 domains in one A4H session). Unlike
// assertDomaMasterLanguage, which refuses a bad
// payload, this is a silent repair applied to the outgoing XML in the
// DOMA/DD write path before it goes on the wire — callers who follow
// skills/ddic/SKILL.md's read-then-imitate workflow and simply omit
// <doma:fixValues/> for a value-table-only or plain domain should not have
// to know this quirk exists. These are pure XML-string fixtures — no
// network, no AbapConnection — checked against the contract in the
// write.ts docblock above injectEmptyFixValues, independently of its
// implementation.
// ---------------------------------------------------------------------------

/**
 * Builds a full doma:domain document around an arbitrary <doma:content>
 * payload, mirroring domaXml's shape above but leaving valueInformation
 * entirely to the caller (self-closing, multiple, missing, non-doma-prefixed,
 * etc. — cases domaXml's fixed <doma:fixValues> wrapper can't express).
 */
function vDoc(contentXml: string, rootType = "DOMA/DD"): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZDOM" adtcore:type="${rootType}">` +
    `<adtcore:packageRef adtcore:name="ZPKG"/><doma:content>${contentXml}</doma:content></doma:domain>`
  );
}

describe("injectEmptyFixValues — the write-path normaliser", () => {
  it("leaves a payload with no valueInformation at all untouched", () => {
    const xml = vDoc(
      "<doma:typeInformation><doma:datatype>CHAR</doma:datatype><doma:length>1</doma:length></doma:typeInformation>",
    );
    expect(injectEmptyFixValues(target("DOMA/DD"), xml)).toBe(xml);
  });

  it("appends <doma:fixValues/> as the last child when valueInformation has other children but no fixValues", () => {
    const xml = vDoc(
      '<doma:valueInformation><doma:valueTableRef adtcore:name="ZVT"/>' +
        "<doma:appendExists>false</doma:appendExists></doma:valueInformation>",
    );
    const result = injectEmptyFixValues(target("DOMA/DD"), xml);
    expect(result).toContain(
      "<doma:appendExists>false</doma:appendExists><doma:fixValues/></doma:valueInformation>",
    );
    // Pre-existing children keep their order and content...
    expect(result.indexOf('<doma:valueTableRef adtcore:name="ZVT"/>')).toBeLessThan(
      result.indexOf("<doma:appendExists>false</doma:appendExists>"),
    );
    // ...and deleting exactly the injected substring reconstructs the
    // original byte-for-byte, proving nothing else in the document moved.
    expect(result.replace("<doma:fixValues/>", "")).toBe(xml);
  });

  it("does not touch a valueInformation that already carries populated fixValues", () => {
    const xml = vDoc(
      "<doma:valueInformation><doma:fixValues>" +
        "<doma:fixValue><doma:low>1</doma:low><doma:text>Truck</doma:text></doma:fixValue>" +
        "<doma:fixValue><doma:low>2</doma:low><doma:text>Car</doma:text></doma:fixValue>" +
        "</doma:fixValues></doma:valueInformation>",
    );
    const result = injectEmptyFixValues(target("DOMA/DD"), xml);
    expect(result).toBe(xml);
    expect(result).toContain("<doma:low>1</doma:low><doma:text>Truck</doma:text>");
    expect(result).toContain("<doma:low>2</doma:low><doma:text>Car</doma:text>");
  });

  it("does not touch a valueInformation whose fixValues is already the empty self-closing tag", () => {
    const xml = vDoc("<doma:valueInformation><doma:fixValues/></doma:valueInformation>");
    expect(injectEmptyFixValues(target("DOMA/DD"), xml)).toBe(xml);
  });

  it("is idempotent: applying it twice equals applying it once", () => {
    const xml = vDoc(
      "<doma:valueInformation><doma:appendExists>false</doma:appendExists></doma:valueInformation>",
    );
    const once = injectEmptyFixValues(target("DOMA/DD"), xml);
    const twice = injectEmptyFixValues(target("DOMA/DD"), once);
    expect(twice).toBe(once);
  });

  // The singular <doma:fixValue> (one entry) must not be mistaken for the
  // plural wrapper <doma:fixValues> — a naive substring/prefix check on
  // "fixValue" would wrongly treat this as already-present and skip
  // injection, leaving the mandatory empty tag missing.
  it("does not mistake a singular <doma:fixValue> child for the plural fixValues wrapper", () => {
    const xml = vDoc(
      "<doma:valueInformation><doma:fixValue><doma:low>1</doma:low></doma:fixValue></doma:valueInformation>",
    );
    const result = injectEmptyFixValues(target("DOMA/DD"), xml);
    expect(result).toContain(
      "<doma:fixValue><doma:low>1</doma:low></doma:fixValue><doma:fixValues/></doma:valueInformation>",
    );
  });

  it("leaves non-DOMA targets untouched even when the payload has a fixValues-less valueInformation", () => {
    const xml = vDoc(
      '<doma:valueInformation><doma:valueTableRef adtcore:name="ZVT"/></doma:valueInformation>',
    );
    expect(injectEmptyFixValues(target("DTEL/DE"), xml)).toBe(xml);
    expect(injectEmptyFixValues(target("CLAS/OC"), xml)).toBe(xml);
  });

  it("injects using whatever namespace prefix the document actually used (dom2:)", () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><dom2:domain xmlns:dom2="http://www.sap.com/dictionary/domain" ' +
      'xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZDOM" adtcore:type="DOMA/DD">' +
      "<adtcore:packageRef adtcore:name=\"ZPKG\"/><dom2:content><dom2:valueInformation>" +
      "<dom2:appendExists>false</dom2:appendExists></dom2:valueInformation></dom2:content></dom2:domain>";
    const result = injectEmptyFixValues(target("DOMA/DD"), xml);
    expect(result).toContain(
      "<dom2:appendExists>false</dom2:appendExists><dom2:fixValues/></dom2:valueInformation>",
    );
  });

  it("injects with no prefix when valueInformation is unprefixed (default namespace)", () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><domain xmlns="http://www.sap.com/dictionary/domain" ' +
      'xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZDOM" adtcore:type="DOMA/DD">' +
      '<adtcore:packageRef adtcore:name="ZPKG"/><content><valueInformation>' +
      "<appendExists>false</appendExists></valueInformation></content></domain>";
    const result = injectEmptyFixValues(target("DOMA/DD"), xml);
    expect(result).toContain("<appendExists>false</appendExists><fixValues/></valueInformation>");
  });

  // A <doma:fixValues/> mentioned only inside a comment (e.g. a hand-edited
  // payload with a stale note) must not satisfy the "already present" check
  // — same fail-safe posture as assertDomaMasterLanguage's comment-stripping
  // above. The comment itself is inert markup and must survive untouched.
  it("does not count a commented-out fixValues as present, and preserves the comment verbatim", () => {
    const xml = vDoc(
      "<doma:valueInformation><!-- <doma:fixValues/> -->" +
        "<doma:appendExists>false</doma:appendExists></doma:valueInformation>",
    );
    const result = injectEmptyFixValues(target("DOMA/DD"), xml);
    expect(result).toContain("<!-- <doma:fixValues/> -->");
    expect(result).toContain(
      "<doma:appendExists>false</doma:appendExists><doma:fixValues/></doma:valueInformation>",
    );
  });

  it("expands a self-closing valueInformation into an open/close pair with the empty child", () => {
    const xml = vDoc("<doma:valueInformation/>");
    const result = injectEmptyFixValues(target("DOMA/DD"), xml);
    expect(result).toContain("<doma:valueInformation><doma:fixValues/></doma:valueInformation>");
  });

  it("expands a self-closing valueInformation with attributes, preserving them", () => {
    const xml = vDoc('<doma:valueInformation foo="bar"/>');
    const result = injectEmptyFixValues(target("DOMA/DD"), xml);
    expect(result).toContain(
      '<doma:valueInformation foo="bar"><doma:fixValues/></doma:valueInformation>',
    );
  });

  // Fails open rather than guessing which element to patch — the server's
  // own error on a malformed/ambiguous document is more trustworthy than a
  // regex picking one of several candidates.
  it("leaves a document with two valueInformation elements unchanged (fails open)", () => {
    const xml = vDoc(
      "<doma:valueInformation><doma:appendExists>false</doma:appendExists></doma:valueInformation>" +
        "<doma:valueInformation><doma:appendExists>true</doma:appendExists></doma:valueInformation>",
    );
    expect(injectEmptyFixValues(target("DOMA/DD"), xml)).toBe(xml);
  });

  it("leaves a document with an unclosed valueInformation unchanged (fails open)", () => {
    const xml = vDoc(
      "<doma:valueInformation><doma:appendExists>false</doma:appendExists>",
    );
    expect(injectEmptyFixValues(target("DOMA/DD"), xml)).toBe(xml);
  });
});
