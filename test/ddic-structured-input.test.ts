/**
 * Pins `buildStructuredDdicDescriptor` — the `ddic` structured
 * alternative to hand-composed `source` for the three XML-only DDIC writes
 * (`DOMA/DD`, `DTEL/DE`, `TTYP/DA`). Every element it emits is lifted
 * verbatim from `domaXml`/`dtelXml`/`ttypXml` in a manual write harness (not
 * shipped in this release) — those PUT bodies
 * were sent live and accepted (see `src/adt/capabilities.ts`'s `create`
 * comments for these three types); this builder itself has never been sent
 * to a live system and is not claimed to be.
 */
import { describe, expect, it } from "vitest";
import { assertDdicDescriptorShape, assertDdicTypeKind, buildStructuredDdicDescriptor } from "../src/adt/ddic-payload.js";
import { isAbapError } from "../src/adt/errors.js";

const NAME = "Z154C_TEST";
const DESCR = "abapsmith create-verification bench";
const PKG = "$TMP";

// Copied verbatim from a manual write harness's (not shipped in this release)
// domaXml/dtelXml/ttypXml, with `${name}`/`${descr}`/`${PACKAGE}`/`${rowType}`
// substituted for NAME/DESCR/PKG/"SYST" above — this is the grounding this
// builder must match. If a `.toBe()` below fails, fix the builder (or report
// that the shape can't be grounded) — never edit these three constants to
// make the assertion pass; they were re-derived from that harness's accepted
// bodies once already.
const BENCH_DOMA_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" xmlns:adtcore="http://www.sap.com/adt/core"` +
  ` adtcore:name="${NAME}" adtcore:type="DOMA/DD" adtcore:description="${DESCR}">` +
  `<adtcore:packageRef adtcore:name="${PKG}"/>` +
  `<doma:content>` +
  `<doma:typeInformation><doma:datatype>CHAR</doma:datatype><doma:length>10</doma:length><doma:decimals>0</doma:decimals></doma:typeInformation>` +
  `<doma:outputInformation><doma:length>10</doma:length><doma:lowercase>false</doma:lowercase><doma:signExists>false</doma:signExists></doma:outputInformation>` +
  `</doma:content></doma:domain>`;

const BENCH_DTEL_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<blue:wbobj xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" xmlns:adtcore="http://www.sap.com/adt/core"` +
  ` adtcore:name="${NAME}" adtcore:type="DTEL/DE" adtcore:description="${DESCR}">` +
  `<adtcore:packageRef adtcore:name="${PKG}"/>` +
  `<dtel:dataElement xmlns:dtel="http://www.sap.com/adt/dictionary/dataelements">` +
  `<dtel:typeKind>predefinedAbapType</dtel:typeKind><dtel:typeName/>` +
  `<dtel:dataType>CHAR</dtel:dataType><dtel:dataTypeLength>000010</dtel:dataTypeLength>` +
  `<dtel:dataTypeDecimals>000000</dtel:dataTypeDecimals>` +
  `<dtel:shortFieldLabel>Bench</dtel:shortFieldLabel>` +
  `<dtel:shortFieldLength>10</dtel:shortFieldLength><dtel:shortFieldMaxLength>10</dtel:shortFieldMaxLength>` +
  `<dtel:mediumFieldLabel>Bench</dtel:mediumFieldLabel>` +
  `<dtel:mediumFieldLength>20</dtel:mediumFieldLength><dtel:mediumFieldMaxLength>20</dtel:mediumFieldMaxLength>` +
  `<dtel:longFieldLabel>Bench</dtel:longFieldLabel>` +
  `<dtel:longFieldLength>40</dtel:longFieldLength><dtel:longFieldMaxLength>40</dtel:longFieldMaxLength>` +
  `<dtel:headingFieldLabel>Bench</dtel:headingFieldLabel>` +
  `<dtel:headingFieldLength>55</dtel:headingFieldLength><dtel:headingFieldMaxLength>55</dtel:headingFieldMaxLength>` +
  `<dtel:searchHelp/><dtel:searchHelpParameter/><dtel:setGetParameter/><dtel:defaultComponentName/>` +
  `<dtel:deactivateInputHistory>false</dtel:deactivateInputHistory>` +
  `<dtel:changeDocument>false</dtel:changeDocument>` +
  `<dtel:leftToRightDirection>false</dtel:leftToRightDirection>` +
  `<dtel:deactivateBIDIFiltering>false</dtel:deactivateBIDIFiltering>` +
  `</dtel:dataElement></blue:wbobj>`;

const BENCH_TTYP_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<ttyp:tableType xmlns:ttyp="http://www.sap.com/dictionary/tabletype" xmlns:adtcore="http://www.sap.com/adt/core"` +
  ` adtcore:name="${NAME}" adtcore:type="TTYP/DA" adtcore:description="${DESCR}">` +
  `<adtcore:packageRef adtcore:name="${PKG}"/>` +
  `<ttyp:rowType>` +
  `<ttyp:typeKind>dictionaryType</ttyp:typeKind><ttyp:typeName>SYST</ttyp:typeName>` +
  `<ttyp:builtInType><ttyp:dataType>STRU</ttyp:dataType><ttyp:length>000000</ttyp:length><ttyp:decimals>000000</ttyp:decimals></ttyp:builtInType>` +
  `<ttyp:rangeType/>` +
  `</ttyp:rowType></ttyp:tableType>`;

describe("buildStructuredDdicDescriptor — element-for-element identical to the bench-accepted body", () => {
  it("DOMA/DD: ddic:{} reproduces the bench body byte-for-byte", () => {
    expect(buildStructuredDdicDescriptor("DOMA/DD", NAME, DESCR, PKG, {})).toBe(BENCH_DOMA_XML);
  });

  it("DTEL/DE: ddic:{} reproduces the bench body byte-for-byte", () => {
    expect(buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, {})).toBe(BENCH_DTEL_XML);
  });

  it("TTYP/DA: ddic:{} reproduces the bench body byte-for-byte", () => {
    expect(buildStructuredDdicDescriptor("TTYP/DA", NAME, DESCR, PKG, {})).toBe(BENCH_TTYP_XML);
  });
});

describe("buildStructuredDdicDescriptor — generated XML passes assertDdicDescriptorShape", () => {
  it("DOMA/DD", () => {
    const xml = buildStructuredDdicDescriptor("DOMA/DD", NAME, DESCR, PKG, { length: 20 });
    expect(() => assertDdicDescriptorShape("DOMA/DD", NAME, xml)).not.toThrow();
  });

  it("DTEL/DE", () => {
    const xml = buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, { typeKind: "domain", typeName: "ZDOM_X" });
    expect(() => assertDdicDescriptorShape("DTEL/DE", NAME, xml)).not.toThrow();
  });

  it("TTYP/DA", () => {
    const xml = buildStructuredDdicDescriptor("TTYP/DA", NAME, DESCR, PKG, { typeName: "ZS_X" });
    expect(() => assertDdicDescriptorShape("TTYP/DA", NAME, xml)).not.toThrow();
  });
});

describe("buildStructuredDdicDescriptor — value substitution keeps the same element set", () => {
  it("DOMA/DD: overriding every field still lands in the same slots", () => {
    const xml = buildStructuredDdicDescriptor("DOMA/DD", NAME, DESCR, PKG, {
      dataType: "NUMC",
      length: 8,
      decimals: 2,
      outputLength: 12,
      lowercase: true,
      signExists: true,
    });
    expect(xml).toContain("<doma:datatype>NUMC</doma:datatype>");
    expect(xml).toContain("<doma:length>8</doma:length>");
    expect(xml).toContain("<doma:decimals>2</doma:decimals>");
    expect(xml).toContain("<doma:length>12</doma:length>");
    expect(xml).toContain("<doma:lowercase>true</doma:lowercase>");
    expect(xml).toContain("<doma:signExists>true</doma:signExists>");
    // No elements beyond the grounded set: no fixValues/valueTableRef/style/etc.
    expect(xml).not.toContain("fixValues");
    expect(xml).not.toContain("valueTableRef");
    expect(xml).not.toContain("conversionExit");
    expect(xml).not.toContain("ampmFormat");
    expect(xml).not.toContain("<doma:style>");
    expect(xml).not.toContain("appendExists");
  });

  it("TTYP/DA: rangeType is always emitted empty, never a supplied value", () => {
    const xml = buildStructuredDdicDescriptor("TTYP/DA", NAME, DESCR, PKG, {});
    expect(xml).toContain("<ttyp:rangeType/>");
    expect(xml).not.toContain("initialRowCount");
    expect(xml).not.toContain("accessType");
    expect(xml).not.toContain("primaryKey");
    expect(xml).not.toContain("components");
    expect(xml).not.toContain("<ttyp:alias");
  });

  it("DTEL/DE: searchHelp/searchHelpParameter/setGetParameter/defaultComponentName stay empty", () => {
    const xml = buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, {});
    expect(xml).toContain("<dtel:searchHelp/>");
    expect(xml).toContain("<dtel:searchHelpParameter/>");
    expect(xml).toContain("<dtel:setGetParameter/>");
    expect(xml).toContain("<dtel:defaultComponentName/>");
  });

  it("DTEL/DE: dataTypeLength/dataTypeDecimals stay zero-padded to width 6 under override; DOMA's equivalent slots stay unpadded", () => {
    const dtel = buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, { length: 3, decimals: 0 });
    expect(dtel).toContain("<dtel:dataTypeLength>000003</dtel:dataTypeLength>");
    expect(dtel).toContain("<dtel:dataTypeDecimals>000000</dtel:dataTypeDecimals>");

    const ttyp = buildStructuredDdicDescriptor("TTYP/DA", NAME, DESCR, PKG, { length: 7 });
    expect(ttyp).toContain("<ttyp:length>000007</ttyp:length>");

    const doma = buildStructuredDdicDescriptor("DOMA/DD", NAME, DESCR, PKG, { length: 7 });
    expect(doma).toContain("<doma:length>7</doma:length>");
    expect(doma).not.toContain("000007");
  });

  it("DTEL/DE: *FieldMaxLength stays fixed (10/20/40/55) regardless of the caller's *Length override", () => {
    const xml = buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, {
      shortLength: 5,
      mediumLength: 6,
      longLength: 7,
      headingLength: 8,
    });
    expect(xml).toContain("<dtel:shortFieldLength>5</dtel:shortFieldLength><dtel:shortFieldMaxLength>10</dtel:shortFieldMaxLength>");
    expect(xml).toContain("<dtel:mediumFieldLength>6</dtel:mediumFieldLength><dtel:mediumFieldMaxLength>20</dtel:mediumFieldMaxLength>");
    expect(xml).toContain("<dtel:longFieldLength>7</dtel:longFieldLength><dtel:longFieldMaxLength>40</dtel:longFieldMaxLength>");
    expect(xml).toContain("<dtel:headingFieldLength>8</dtel:headingFieldLength><dtel:headingFieldMaxLength>55</dtel:headingFieldMaxLength>");
  });
});

describe("buildStructuredDdicDescriptor — refuses what isn't grounded", () => {
  it("refuses a type outside the three XML-only DDIC types", () => {
    let thrown: unknown;
    try {
      buildStructuredDdicDescriptor("CLAS/OC", NAME, DESCR, PKG, {});
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown) && thrown.code).toBe("BAD_INPUT");
  });

  it("refuses a DOMA field on a DTEL/DE call (cross-type stray field)", () => {
    let thrown: unknown;
    try {
      buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, { lowercase: true } as never);
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown) && thrown.code).toBe("BAD_INPUT");
    expect(isAbapError(thrown) ? thrown.message : "").toContain("lowercase");
  });

  it("refuses typeKind: rangeTypeOnDataelement for TTYP/DA — rejected at activation on the live system", () => {
    let thrown: unknown;
    try {
      buildStructuredDdicDescriptor("TTYP/DA", NAME, DESCR, PKG, { typeKind: "rangeTypeOnDataelement" } as never);
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown) && thrown.code).toBe("BAD_INPUT");
  });

  it("refuses typeKind: dictionaryType for DTEL/DE (only domain/predefinedAbapType are grounded there)", () => {
    let thrown: unknown;
    try {
      buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, { typeKind: "dictionaryType" } as never);
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown) && thrown.code).toBe("BAD_INPUT");
  });
});

describe("assertDdicTypeKind — v2 narrowing (schemas.ts keeps typeKind a bare string, Rule 1)", () => {
  it("accepts the three legal values", () => {
    expect(assertDdicTypeKind("domain")).toBe("domain");
    expect(assertDdicTypeKind("predefinedAbapType")).toBe("predefinedAbapType");
    expect(assertDdicTypeKind("dictionaryType")).toBe("dictionaryType");
  });

  it("refuses anything else, naming the field and the legal values", () => {
    let thrown: unknown;
    try {
      assertDdicTypeKind("bogus");
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown) && thrown.code).toBe("BAD_INPUT");
    const message = isAbapError(thrown) ? thrown.message : "";
    expect(message).toContain("typeKind");
    expect(message).toContain("bogus");
    expect(isAbapError(thrown) ? thrown.hint : "").toContain("domain");
    expect(isAbapError(thrown) ? thrown.hint : "").toContain("predefinedAbapType");
    expect(isAbapError(thrown) ? thrown.hint : "").toContain("dictionaryType");
  });
});
