/**
 * Pins `buildStructuredDdicDescriptor` — the `ddic` structured
 * alternative to hand-composed `source` for the three XML-only DDIC writes
 * (`DOMA/DD`, `DTEL/DE`, `TTYP/DA`). Every element it emits is lifted
 * verbatim from `domaXml`/`dtelXml`/`ttypXml` in a manual write harness (not
 * shipped in this release) — those PUT bodies
 * were sent live and accepted (see `src/adt/capabilities.ts`'s `create`
 * comments for these three types).
 *
 * RE-GROUNDED 2026-09-16 (#144): the bench DTEL body, sent through this
 * builder to A4H (NetWeaver 7.54, client 001) as `ZAS_DTEL_TEST` in `$TMP`,
 * was ACCEPTED but came back with all four `<dtel:*FieldLabel>` elements
 * empty (CHECK_FAILED / VALUE_DISCARDED, object inactive). The byte-identical
 * body with `adtcore:masterLanguage="EN"` on the root activated and read back
 * with every label intact. The three constants below therefore carry
 * `adtcore:masterLanguage="EN" adtcore:language="EN"` on the root — the only
 * change from the harness bodies, and the same pair every live GET and the
 * static skeletons in src/adt/ddic-payload.ts carry. The builder's own
 * output has since been sent live for DTEL/DE and DOMA/DD (see
 * test/integration-ddic-structured.test.ts). The DOMA body's
 * `<doma:outputInformation>` child order was re-grounded the same day — see
 * the comment on BENCH_DOMA_XML.
 */
import { describe, expect, it } from "vitest";
import {
  assertDdicDescriptorShape,
  assertDdicTypeKind,
  buildStructuredDdicDescriptor,
  defaultDomaOutputLength,
} from "../src/adt/ddic-payload.js";
import { isAbapError } from "../src/adt/errors.js";

const NAME = "Z154C_TEST";
const DESCR = "abapsmith create-verification bench";
const PKG = "$TMP";

// Copied verbatim from a manual write harness's (not shipped in this release)
// domaXml/dtelXml/ttypXml, with `${name}`/`${descr}`/`${PACKAGE}`/`${rowType}`
// substituted for NAME/DESCR/PKG/"SYST" above, plus the root language
// attributes the 2026-09-16 live run proved necessary (file header) — this is
// the grounding this builder must match. If a `.toBe()` below fails, fix the
// builder (or report that the shape can't be grounded) — never edit these
// three constants to make the assertion pass; they were re-derived from that
// harness's accepted bodies once, and from a live write once more.
const ROOT_LANGUAGE = ` adtcore:masterLanguage="EN" adtcore:language="EN"`;

const BENCH_DOMA_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" xmlns:adtcore="http://www.sap.com/adt/core"` +
  ` adtcore:name="${NAME}" adtcore:type="DOMA/DD" adtcore:description="${DESCR}"${ROOT_LANGUAGE}>` +
  `<adtcore:packageRef adtcore:name="${PKG}"/>` +
  `<doma:content>` +
  `<doma:typeInformation><doma:datatype>CHAR</doma:datatype><doma:length>10</doma:length><doma:decimals>0</doma:decimals></doma:typeInformation>` +
  // signExists before lowercase: the harness body had them the other way
  // round, and both false. Live, 2026-09-16 (#145), a DEC 13,3 body in the
  // harness order with signExists=true activated with signExists stored FALSE;
  // the same body with signExists first kept it (CHAR lowercase=true survived
  // in both orders). The live GET order, which the static skeleton in
  // src/adt/ddic-payload.ts also carries, is signExists then lowercase.
  `<doma:outputInformation><doma:length>10</doma:length><doma:signExists>false</doma:signExists><doma:lowercase>false</doma:lowercase></doma:outputInformation>` +
  `</doma:content></doma:domain>`;

const BENCH_DTEL_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<blue:wbobj xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" xmlns:adtcore="http://www.sap.com/adt/core"` +
  ` adtcore:name="${NAME}" adtcore:type="DTEL/DE" adtcore:description="${DESCR}"${ROOT_LANGUAGE}>` +
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
  ` adtcore:name="${NAME}" adtcore:type="TTYP/DA" adtcore:description="${DESCR}"${ROOT_LANGUAGE}>` +
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

  it("DTEL/DE: *FieldMaxLength stays fixed (10/20/40/55) regardless of the caller's *Length override, and *FieldLength is two-digit padded", () => {
    // Width 2 is the live shape: MANDT reads back `<dtel:headingFieldLength>03</dtel:headingFieldLength>`
    // (raw GET, A4H, 2026-09-16) and the static skeleton carries `05`/`07`.
    const xml = buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, {
      shortLength: 5,
      mediumLength: 6,
      longLength: 7,
      headingLength: 8,
    });
    expect(xml).toContain("<dtel:shortFieldLength>05</dtel:shortFieldLength><dtel:shortFieldMaxLength>10</dtel:shortFieldMaxLength>");
    expect(xml).toContain("<dtel:mediumFieldLength>06</dtel:mediumFieldLength><dtel:mediumFieldMaxLength>20</dtel:mediumFieldMaxLength>");
    expect(xml).toContain("<dtel:longFieldLength>07</dtel:longFieldLength><dtel:longFieldMaxLength>40</dtel:longFieldMaxLength>");
    expect(xml).toContain("<dtel:headingFieldLength>08</dtel:headingFieldLength><dtel:headingFieldMaxLength>55</dtel:headingFieldMaxLength>");
  });
});

describe("buildStructuredDdicDescriptor — root language attributes (#144)", () => {
  // Live, 2026-09-16, A4H: the DTEL body without adtcore:masterLanguage was
  // accepted and every field label came back empty; the same body with the
  // attribute activated and kept them. Every builder emits the pair.
  it.each(["DOMA/DD", "DTEL/DE", "TTYP/DA"] as const)("%s root carries adtcore:masterLanguage and adtcore:language", (type) => {
    const xml = buildStructuredDdicDescriptor(type, NAME, DESCR, PKG, {});
    const root = /<[a-z]+:\w+\b[^>]*>/.exec(xml.replace(/<\?xml[^>]*\?>/, ""))?.[0] ?? "";
    expect(root).toContain(`adtcore:masterLanguage="EN"`);
    expect(root).toContain(`adtcore:language="EN"`);
  });
});

describe("buildStructuredDdicDescriptor — DTEL/DE field labels (#144)", () => {
  it("renders caller labels with the slot maximum as display width when no *Length is given", () => {
    const xml = buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, {
      shortLabel: "Status",
      mediumLabel: "Order status",
      longLabel: "Status of the order",
      headingLabel: "St.",
    });
    expect(xml).toContain("<dtel:shortFieldLabel>Status</dtel:shortFieldLabel><dtel:shortFieldLength>10</dtel:shortFieldLength>");
    expect(xml).toContain("<dtel:mediumFieldLabel>Order status</dtel:mediumFieldLabel><dtel:mediumFieldLength>20</dtel:mediumFieldLength>");
    expect(xml).toContain("<dtel:longFieldLabel>Status of the order</dtel:longFieldLabel><dtel:longFieldLength>40</dtel:longFieldLength>");
    expect(xml).toContain("<dtel:headingFieldLabel>St.</dtel:headingFieldLabel><dtel:headingFieldLength>55</dtel:headingFieldLength>");
  });

  it("escapes label text", () => {
    const xml = buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, { shortLabel: "A&B<C>" });
    expect(xml).toContain("<dtel:shortFieldLabel>A&amp;B&lt;C&gt;</dtel:shortFieldLabel>");
  });

  it.each([
    ["shortLabel", 10, "Twelve chars"],
    ["mediumLabel", 20, "Twenty-one characters"],
    ["longLabel", 40, "Forty-one characters is one too many here"],
    ["headingLabel", 55, "Fifty-six characters of heading text is one more than fits"],
  ] as const)("refuses ddic.%s longer than %d with BAD_INPUT carrying the full value — never truncates", (field, max, label) => {
    expect(label.length).toBeGreaterThan(max);
    let thrown: unknown;
    try {
      buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, { [field]: label });
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown) && thrown.code).toBe("BAD_INPUT");
    const details = isAbapError(thrown) ? thrown.details : {};
    expect(details.field).toBe(field);
    expect(details.value).toBe(label);
    expect(details.length).toBe(label.length);
    expect(details.maxLength).toBe(max);
  });

  it("refuses a *Length shorter than its label, above the slot maximum, or non-integer", () => {
    for (const fields of [
      { shortLabel: "Status", shortLength: 5 },
      { mediumLength: 21 },
      { longLength: 0 },
      { headingLength: 7.5 },
    ]) {
      let thrown: unknown;
      try {
        buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, fields);
      } catch (e) {
        thrown = e;
      }
      expect(isAbapError(thrown) && thrown.code, JSON.stringify(fields)).toBe("BAD_INPUT");
      expect(isAbapError(thrown) ? thrown.message : "").toMatch(/Length/);
    }
  });

  it("accepts a *Length equal to the label's own length (MANDT's heading: 'Mdt' / 03)", () => {
    const xml = buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, { headingLabel: "Mdt", headingLength: 3 });
    expect(xml).toContain("<dtel:headingFieldLabel>Mdt</dtel:headingFieldLabel><dtel:headingFieldLength>03</dtel:headingFieldLength>");
  });
});

describe("buildStructuredDdicDescriptor — DOMA/DD fixed values and value table (#145)", () => {
  // Shape lifted from live GETs of XFELD and AS4LOCAL (A4H, 2026-09-16):
  // <doma:valueInformation><doma:valueTableRef/><doma:appendExists>false</doma:appendExists>
  // <doma:fixValues><doma:fixValue><doma:position>0001</doma:position><doma:low>X</doma:low>
  // <doma:high/><doma:text>Ja</doma:text></doma:fixValue>…</doma:fixValues></doma:valueInformation>.
  // The builder leaves <doma:position> to the server.
  it("renders fixedValues as the live fixValues block, in order, with low/high/text children and no position", () => {
    const xml = buildStructuredDdicDescriptor("DOMA/DD", NAME, DESCR, PKG, {
      length: 1,
      fixedValues: [
        { low: "N", text: "New" },
        { low: "P", text: "In progress" },
        { low: "D", text: "Done" },
      ],
    });
    expect(xml).toContain(
      "</doma:outputInformation>" +
        "<doma:valueInformation><doma:valueTableRef/><doma:appendExists>false</doma:appendExists><doma:fixValues>" +
        "<doma:fixValue><doma:low>N</doma:low><doma:high/><doma:text>New</doma:text></doma:fixValue>" +
        "<doma:fixValue><doma:low>P</doma:low><doma:high/><doma:text>In progress</doma:text></doma:fixValue>" +
        "<doma:fixValue><doma:low>D</doma:low><doma:high/><doma:text>Done</doma:text></doma:fixValue>" +
        "</doma:fixValues></doma:valueInformation></doma:content>",
    );
    expect(xml).not.toContain("doma:position");
    expect(() => assertDdicDescriptorShape("DOMA/DD", NAME, xml)).not.toThrow();
  });

  it("renders an interval row with its high bound, an empty low (XFELD's 'Nein' row), and escapes text", () => {
    const xml = buildStructuredDdicDescriptor("DOMA/DD", NAME, DESCR, PKG, {
      dataType: "NUMC",
      length: 3,
      fixedValues: [
        { low: "100", high: "199", text: "1xx <range>" },
        { low: "", text: "Nein" },
      ],
    });
    expect(xml).toContain("<doma:fixValue><doma:low>100</doma:low><doma:high>199</doma:high><doma:text>1xx &lt;range&gt;</doma:text></doma:fixValue>");
    expect(xml).toContain("<doma:fixValue><doma:low/><doma:high/><doma:text>Nein</doma:text></doma:fixValue>");
  });

  it("an empty fixedValues array emits the skeleton's empty <doma:fixValues/>; no fixedValues/valueTable emits no valueInformation at all", () => {
    const empty = buildStructuredDdicDescriptor("DOMA/DD", NAME, DESCR, PKG, { fixedValues: [] });
    expect(empty).toContain("<doma:valueInformation><doma:valueTableRef/><doma:appendExists>false</doma:appendExists><doma:fixValues/></doma:valueInformation>");
    expect(buildStructuredDdicDescriptor("DOMA/DD", NAME, DESCR, PKG, {})).not.toContain("valueInformation");
  });

  it("renders valueTable as the uri/type/name triple capture 845 shows for S_CARR_ID -> SCARR, uppercased", () => {
    const xml = buildStructuredDdicDescriptor("DOMA/DD", NAME, DESCR, PKG, { length: 3, valueTable: "scarr" });
    expect(xml).toContain(
      '<doma:valueInformation><doma:valueTableRef adtcore:uri="/sap/bc/adt/ddic/tables/scarr" adtcore:type="TABL/DT" adtcore:name="SCARR"/>' +
        "<doma:appendExists>false</doma:appendExists><doma:fixValues/></doma:valueInformation>",
    );
  });

  it("refuses a valueTable that is not a table name", () => {
    for (const valueTable of ["", "  ", "bad name", "a".repeat(31)]) {
      let thrown: unknown;
      try {
        buildStructuredDdicDescriptor("DOMA/DD", NAME, DESCR, PKG, { valueTable });
      } catch (e) {
        thrown = e;
      }
      expect(isAbapError(thrown) && thrown.code, JSON.stringify(valueTable)).toBe("BAD_INPUT");
      expect(isAbapError(thrown) ? thrown.details.field : "").toBe("valueTable");
    }
  });

  it("refuses low/high longer than the domain length, or than DD07L-DOMVALUE_L's 10 characters, naming the row", () => {
    let thrown: unknown;
    try {
      buildStructuredDdicDescriptor("DOMA/DD", NAME, DESCR, PKG, { length: 2, fixedValues: [{ low: "A", text: "a" }, { low: "TOO", text: "b" }] });
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown) && thrown.code).toBe("BAD_INPUT");
    expect(isAbapError(thrown) ? thrown.details : {}).toMatchObject({ field: "fixedValues[1].low", value: "TOO", length: 3, maxLength: 2 });

    thrown = undefined;
    try {
      buildStructuredDdicDescriptor("DOMA/DD", NAME, DESCR, PKG, { length: 20, fixedValues: [{ low: "A", high: "ELEVEN_CHRS", text: "a" }] });
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown) && thrown.code).toBe("BAD_INPUT");
    expect(isAbapError(thrown) ? thrown.details : {}).toMatchObject({ field: "fixedValues[0].high", length: 11, maxLength: 10 });
    expect(isAbapError(thrown) ? thrown.message : "").toContain("DOMVALUE_H");
  });

  it("refuses a text longer than 60 characters (DD07T-DDTEXT) with the full value in details", () => {
    const text = "x".repeat(61);
    let thrown: unknown;
    try {
      buildStructuredDdicDescriptor("DOMA/DD", NAME, DESCR, PKG, { fixedValues: [{ low: "A", text }] });
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown) && thrown.code).toBe("BAD_INPUT");
    expect(isAbapError(thrown) ? thrown.details : {}).toMatchObject({ field: "fixedValues[0].text", value: text, length: 61, maxLength: 60 });
    expect(buildStructuredDdicDescriptor("DOMA/DD", NAME, DESCR, PKG, { fixedValues: [{ low: "A", text: "y".repeat(60) }] })).toContain("y".repeat(60));
  });

  it("refuses fixedValues/valueTable on DTEL/DE and TTYP/DA as stray fields", () => {
    for (const type of ["DTEL/DE", "TTYP/DA"]) {
      let thrown: unknown;
      try {
        buildStructuredDdicDescriptor(type, NAME, DESCR, PKG, { fixedValues: [{ low: "A", text: "a" }] });
      } catch (e) {
        thrown = e;
      }
      expect(isAbapError(thrown) && thrown.code, type).toBe("BAD_INPUT");
      expect(isAbapError(thrown) ? thrown.message : "").toContain("fixedValues");
    }
  });
});

describe("buildStructuredDdicDescriptor — DOMA/DD output length (#145)", () => {
  it("defaultDomaOutputLength follows the Dictionary's proposal per data type", () => {
    expect(defaultDomaOutputLength("DEC", 13, 3, false)).toBe(14);
    expect(defaultDomaOutputLength("DEC", 13, 3, true)).toBe(15);
    expect(defaultDomaOutputLength("DEC", 13, 0, false)).toBe(13);
    expect(defaultDomaOutputLength("CURR", 15, 2, true)).toBe(17);
    expect(defaultDomaOutputLength("QUAN", 13, 3, false)).toBe(14);
    expect(defaultDomaOutputLength("DATS", 8, 0, false)).toBe(10);
    expect(defaultDomaOutputLength("TIMS", 6, 0, false)).toBe(8);
    expect(defaultDomaOutputLength("NUMC", 4, 0, false)).toBe(4);
    expect(defaultDomaOutputLength("CHAR", 30, 0, false)).toBe(30);
    expect(defaultDomaOutputLength("char", 7, 0, false)).toBe(7);
  });

  it("the computed value lands in <doma:outputInformation><doma:length>, unpadded", () => {
    const amt = buildStructuredDdicDescriptor("DOMA/DD", NAME, DESCR, PKG, { dataType: "DEC", length: 13, decimals: 3, signExists: true });
    expect(amt).toContain("<doma:typeInformation><doma:datatype>DEC</doma:datatype><doma:length>13</doma:length><doma:decimals>3</doma:decimals></doma:typeInformation>");
    expect(amt).toContain("<doma:outputInformation><doma:length>15</doma:length>");
    const dats = buildStructuredDdicDescriptor("DOMA/DD", NAME, DESCR, PKG, { dataType: "DATS", length: 8 });
    expect(dats).toContain("<doma:outputInformation><doma:length>10</doma:length>");
  });

  it("a caller's outputLength wins over the computed one", () => {
    const xml = buildStructuredDdicDescriptor("DOMA/DD", NAME, DESCR, PKG, { dataType: "DEC", length: 13, decimals: 3, outputLength: 20 });
    expect(xml).toContain("<doma:outputInformation><doma:length>20</doma:length>");
  });
});

describe("buildStructuredDdicDescriptor — search help attachment (DTEL/DE)", () => {
  // Live evidence (read-only): `abap_read PBUNAM DTEL/DE format=raw` on A4H
  // (NetWeaver 7.54, client 001), 2026-09-15, returned
  // `<dtel:searchHelp>USER_ADDR</dtel:searchHelp><dtel:searchHelpParameter>BNAME</dtel:searchHelpParameter>`,
  // matching that data element's DD04L row (SHLPNAME=USER_ADDR,
  // SHLPFIELD=BNAME); MANDT has both elements empty. That was a READ
  // capture only — no DTEL/DE write carrying these fields has ever been
  // sent to a live system, and the tests below use structural stand-in
  // names, not USER_ADDR/BNAME, to keep that distinction visible.

  it("both dtel:searchHelp and dtel:searchHelpParameter are always emitted, non-empty and in order when both are given", () => {
    const xml = buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, {
      searchHelp: "z154c_search_help_standin",
      searchHelpParameter: "standin_field",
    });
    expect(xml).toContain(
      "<dtel:searchHelp>Z154C_SEARCH_HELP_STANDIN</dtel:searchHelp>" +
        "<dtel:searchHelpParameter>STANDIN_FIELD</dtel:searchHelpParameter>",
    );
  });

  it("searchHelp given alone (no parameter) does not throw, and searchHelpParameter still renders empty", () => {
    const xml = buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, {
      searchHelp: "z154c_search_help_standin",
    });
    expect(xml).toContain("<dtel:searchHelp>Z154C_SEARCH_HELP_STANDIN</dtel:searchHelp>");
    expect(xml).toContain("<dtel:searchHelpParameter/>");
  });

  it("normalizeShlpIdentifier trims surrounding whitespace and upper-cases both fields", () => {
    const xml = buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, {
      searchHelp: "  z154c_search_help_standin  ",
      searchHelpParameter: "  standin_field  ",
    });
    expect(xml).toContain("<dtel:searchHelp>Z154C_SEARCH_HELP_STANDIN</dtel:searchHelp>");
    expect(xml).toContain("<dtel:searchHelpParameter>STANDIN_FIELD</dtel:searchHelpParameter>");
  });

  it("normalizeShlpIdentifier refuses a searchHelp over 30 characters with BAD_INPUT naming the field — it never silently truncates", () => {
    const tooLong = "Z154C_STANDIN_NAME_OVER_THIRTY_CHARS";
    expect(tooLong.length).toBeGreaterThan(30);
    let thrown: unknown;
    try {
      buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, { searchHelp: tooLong });
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown) && thrown.code).toBe("BAD_INPUT");
    const message = isAbapError(thrown) ? thrown.message : "";
    expect(message).toContain("searchHelp");
    expect(message).toContain(String(tooLong.length));
    // The failure mode this guard exists to prevent: the error carries the
    // FULL original value and its FULL length, never a value or length
    // clipped to the 30-character ceiling — proof nothing was truncated
    // and silently accepted.
    const details = isAbapError(thrown) ? thrown.details : {};
    expect(details.value).toBe(tooLong);
    expect(details.length).toBe(tooLong.length);
    expect(details.maxLength).toBe(30);
    expect(details.field).toBe("searchHelp");
  });

  it("normalizeShlpIdentifier refuses a searchHelpParameter over 30 characters the same way, naming that field instead", () => {
    const tooLong = "STANDIN_PARAMETER_NAME_OVER_THIRTY_CHARS_LONG";
    expect(tooLong.length).toBeGreaterThan(30);
    let thrown: unknown;
    try {
      buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, {
        searchHelp: "z154c_search_help_standin",
        searchHelpParameter: tooLong,
      });
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown) && thrown.code).toBe("BAD_INPUT");
    const details = isAbapError(thrown) ? thrown.details : {};
    expect(details.field).toBe("searchHelpParameter");
    expect(details.value).toBe(tooLong);
    expect(details.length).toBe(tooLong.length);
  });
});

describe("buildStructuredDdicDescriptor — refuses what isn't grounded", () => {
  it("refuses ddic.searchHelpParameter given without ddic.searchHelp for DTEL/DE — a parameter with nothing to attach to", () => {
    let thrown: unknown;
    try {
      buildStructuredDdicDescriptor("DTEL/DE", NAME, DESCR, PKG, { searchHelpParameter: "standin_field" });
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown) && thrown.code).toBe("BAD_INPUT");
    const message = isAbapError(thrown) ? thrown.message : "";
    expect(message).toContain("searchHelpParameter");
    expect(message).toContain("searchHelp");
  });


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
