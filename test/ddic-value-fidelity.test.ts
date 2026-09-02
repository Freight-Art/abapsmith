/**
 * End-to-end value fidelity: the exact characters DDIC stored must
 * reach the model unchanged.
 *
 * Root cause: the `XMLParser` in src/adt/ddic.ts lacked `parseTagValue:
 * false`, so fast-xml-parser number-coerced element text. A CHAR(2) domain
 * storing `01`-`04` rendered as `1`-`4`: an agent read `1`, wrote
 * `IF ls_order-trans_mode = '1'`, and that comparison never matched and
 * never errored — the reported bug. The fix sets `parseTagValue: false`.
 *
 * That fix has a dangerous side effect this file exists to pin permanently:
 * with `parseTagValue: false`, EVERY tag value arrives as a string, always.
 * `<doma:lowercase>true</doma:lowercase>` is now the string `"true"`, not
 * the boolean `true`. Code that used to read it correctly by accident
 * (`oi.lowercase === true`) is now permanently `false` — a regression that
 * renders identically to a domain that genuinely has the flag off, so
 * nothing downstream would notice. `parseDomainXml` now routes booleans
 * through `xmlBool` and numbers through `xmlNum` instead of raw reads.
 * Both halves — zero-padding preserved AND booleans/numbers still correct
 * — must be pinned together, or fixing one regresses the other silently.
 */
import { describe, expect, it } from "vitest";
import { readDdic, renderDataElement, renderDomain, renderTableType } from "../src/adt/ddic.js";
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

/** Routes GET by URI shape, same convention as test/ddic.test.ts's stubConn. Offline only. */
function stubConn(handlers: {
  domain?: (uri: string) => Promise<{ body: string }>;
  dataElement?: (uri: string) => Promise<{ body: string }>;
}): AbapConnection {
  return {
    cfg: { sid: "A4H" },
    get: async (uri: string) => {
      if (uri.includes("/ddic/dataelements/")) {
        if (!handlers.dataElement) throw new Error(`unexpected GET ${uri}`);
        return handlers.dataElement(uri);
      }
      if (uri.includes("/ddic/domains/")) {
        if (!handlers.domain) throw new Error(`unexpected GET ${uri}`);
        return handlers.domain(uri);
      }
      throw new Error(`unexpected GET ${uri}`);
    },
    adt: { nodeContents: async () => ({ nodes: [] }) },
  } as unknown as AbapConnection;
}

/**
 * Domain descriptor shape verified against parseDomainXml's doma:content
 * schema (same shape as DOMA_XML in test/ddic.test.ts and
 * domainXmlWithFixValues in test/ddic-write-guard.test.ts). `fixValues[].low`
 * is emitted verbatim — callers control the exact wire text under test,
 * including leading zeros, non-numeric-looking strings, and padding spaces.
 */
function domainXml(opts: {
  name?: string;
  length?: string;
  outputLength?: string;
  lowercase?: string;
  signExists?: string;
  fixValues: Array<{ low: string; text?: string }>;
}): string {
  const name = opts.name ?? "ZDOM";
  const length = opts.length ?? "1";
  const outputLength = opts.outputLength ?? length;
  const lowercase = opts.lowercase ?? "false";
  const signExists = opts.signExists ?? "false";
  const fixValuesXml = opts.fixValues
    .map(
      (f) =>
        `<doma:fixValue><doma:low>${f.low}</doma:low>${
          f.text !== undefined ? `<doma:text>${f.text}</doma:text>` : ""
        }</doma:fixValue>`,
    )
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?><doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" ' +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" adtcore:type="DOMA/DD" ` +
    `adtcore:description="A domain"><adtcore:packageRef adtcore:name="ZPKG"/>` +
    "<doma:content><doma:typeInformation><doma:datatype>CHAR</doma:datatype>" +
    `<doma:length>${length}</doma:length><doma:decimals>0</doma:decimals></doma:typeInformation>` +
    `<doma:outputInformation><doma:length>${outputLength}</doma:length><doma:lowercase>${lowercase}</doma:lowercase>` +
    `<doma:signExists>${signExists}</doma:signExists></doma:outputInformation>` +
    `<doma:valueInformation><doma:fixValues>${fixValuesXml}</doma:fixValues></doma:valueInformation>` +
    "</doma:content></doma:domain>"
  );
}

// ---------------------------------------------------------------------------
// 1. The reported case: ZTMC_D_TMODE, CHAR(2), fixed values 01/02/03/04.
// ---------------------------------------------------------------------------

describe("reported case — ZTMC_D_TMODE, CHAR(2) domain with zero-padded fixed values", () => {
  it("renders 01, 02, 03, 04 as the leftmost column values, never the zero-stripped form", async () => {
    const xml = domainXml({
      name: "ZTMC_D_TMODE",
      length: "2",
      outputLength: "2",
      fixValues: [
        { low: "01", text: "Road" },
        { low: "02", text: "Rail" },
        { low: "03", text: "Sea" },
        { low: "04", text: "Air" },
      ],
    });
    const conn = stubConn({ domain: async () => ({ body: xml }) });
    const r = await readDdic(
      conn,
      obj("DOMA", "ZTMC_D_TMODE", "/sap/bc/adt/ddic/domains/ztmc_d_tmode"),
    );
    const section = r.sections.find((s) => s.title === "FIXED VALUES");
    expect(section).toBeDefined();
    const content = section!.content;

    // Anchored per-line regexes, not toContain: a loose toContain("01")
    // cannot distinguish "01" from "1" and is exactly the assertion shape
    // that let this bug ship in the first place.
    expect(content).toMatch(/^01\s+.*Road/m);
    expect(content).toMatch(/^02\s+.*Rail/m);
    expect(content).toMatch(/^03\s+.*Sea/m);
    expect(content).toMatch(/^04\s+.*Air/m);

    // Explicit negative: no row may start with the zero-stripped form.
    expect(content).not.toMatch(/^1\s/m);
    expect(content).not.toMatch(/^2\s/m);
    expect(content).not.toMatch(/^3\s/m);
    expect(content).not.toMatch(/^4\s/m);
  });
});

// ---------------------------------------------------------------------------
// 2. The boolean/number trap. `parseTagValue: false` makes every tag value
// a string, always. `<doma:lowercase>true</doma:lowercase>` is now the
// string "true", not the boolean true — a raw `=== true` read is now
// permanently false, and that failure mode is silent: it renders exactly
// like a domain that genuinely has the flag off. `xmlBool`/`xmlNum` are the
// guard; this block pins that they actually work, for both spellings ADT
// uses ("true"/"false" and "X") and alongside the numeric fields in the
// same descriptor (type length, output length) that the same parser change
// could equally have broken.
// ---------------------------------------------------------------------------

describe("the boolean/number trap (a side effect of parseTagValue: false)", () => {
  it("lowercase=true and signExists=true render their DDL lines, and lengths stay numeric", async () => {
    const xml = domainXml({
      name: "ZDOM",
      length: "2",
      outputLength: "2",
      lowercase: "true",
      signExists: "true",
      fixValues: [],
    });
    const conn = stubConn({ domain: async () => ({ body: xml }) });
    const r = await readDdic(conn, obj("DOMA", "ZDOM", "/sap/bc/adt/ddic/domains/zdom"));
    expect(r.ddl).toContain("lowercase   : true;");
    expect(r.ddl).toContain("sign        : true;");
    // Numbers survive too: not `length "2"`, not `length NaN`, not missing.
    expect(r.ddl).toContain("type        : CHAR length 2");
    expect(r.ddl).toContain("output len  : 2;");
  });

  it("lowercase=false and signExists=false render NEITHER line", async () => {
    const xml = domainXml({
      name: "ZDOM",
      length: "2",
      outputLength: "2",
      lowercase: "false",
      signExists: "false",
      fixValues: [],
    });
    const conn = stubConn({ domain: async () => ({ body: xml }) });
    const r = await readDdic(conn, obj("DOMA", "ZDOM", "/sap/bc/adt/ddic/domains/zdom"));
    expect(r.ddl).not.toContain("lowercase   : true;");
    expect(r.ddl).not.toContain("sign        : true;");
  });

  it("ADT's 'X' spelling for a DDIC boolean flag also reads as true", async () => {
    const xml = domainXml({
      name: "ZDOM",
      length: "2",
      outputLength: "2",
      lowercase: "X",
      signExists: "false",
      fixValues: [],
    });
    const conn = stubConn({ domain: async () => ({ body: xml }) });
    const r = await readDdic(conn, obj("DOMA", "ZDOM", "/sap/bc/adt/ddic/domains/zdom"));
    expect(r.ddl).toContain("lowercase   : true;");
    expect(r.ddl).not.toContain("sign        : true;");
  });
});

// ---------------------------------------------------------------------------
// 3. Synthetic parser pins. NOT live-captured — these fixed values do not
// mirror any real SAP response; they exist purely to pin fast-xml-parser's
// number-coercion table directly, one entry per corruption class. Under the
// default parser (parseTagValue left on) these became 1.1, 31 and 100000
// respectively — the same corruption class as the leading-zero bug, and
// much harder to notice in a rendered table than 01 turning into 1.
// ---------------------------------------------------------------------------

describe("synthetic parser pins — not live-captured, pin fast-xml-parser's coercion table", () => {
  it("preserves 1.10, 0x1F and 1e5 verbatim; trims but does not otherwise alter ' 7 '", async () => {
    const xml = domainXml({
      name: "ZDOM",
      length: "10",
      outputLength: "10",
      fixValues: [
        { low: "1.10", text: "decimal-looking" },
        { low: "0x1F", text: "hex-looking" },
        { low: "1e5", text: "exponent-looking" },
        { low: " 7 ", text: "space-padded" },
      ],
    });
    const conn = stubConn({ domain: async () => ({ body: xml }) });
    const r = await readDdic(conn, obj("DOMA", "ZDOM", "/sap/bc/adt/ddic/domains/zdom"));
    const content = r.sections.find((s) => s.title === "FIXED VALUES")!.content;

    expect(content).toMatch(/^1\.10\s+.*decimal-looking/m);
    expect(content).toMatch(/^0x1F\s+.*hex-looking/m);
    expect(content).toMatch(/^1e5\s+.*exponent-looking/m);
    // trimValues: true is intentional and unrelated to the coercion bug — verified
    // directly against the XMLParser config in src/adt/ddic.ts: a leaf
    // text node's surrounding whitespace is stripped at parse time, so
    // " 7 " arrives already trimmed to "7", not corrupted, not untouched.
    expect(content).toMatch(/^7\s+.*space-padded/m);
  });
});

// ---------------------------------------------------------------------------
// 4. Through a data element. The reporter's field is DTEL-typed, not
// DOMA-typed directly — readDataElement round-trips through DTEL then DOMA,
// and dataTypeLength arrives zero-padded on the wire ("000002"). Both the
// domain's fixed values and the data element's own numeric field must
// survive that second hop.
// ---------------------------------------------------------------------------

describe("through a data element: DTEL -> DOMA preserves zero-padding and numeric lengths", () => {
  it("surfaces FIXED VALUES 01-04 via the domain, and a numeric built-in length from a zero-padded wire value", async () => {
    const domXml = domainXml({
      name: "ZTMC_D_TMODE",
      length: "2",
      outputLength: "2",
      fixValues: [
        { low: "01", text: "Road" },
        { low: "02", text: "Rail" },
        { low: "03", text: "Sea" },
        { low: "04", text: "Air" },
      ],
    });
    const dtelXml =
      '<?xml version="1.0" encoding="UTF-8"?><blue:wbobj xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" ' +
      'xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZMC_TMODE" adtcore:type="DTEL/DE" ' +
      'adtcore:description="Transport mode"><adtcore:packageRef adtcore:name="ZPKG"/>' +
      '<dtel:dataElement xmlns:dtel="http://www.sap.com/adt/dictionary/dataelements">' +
      "<dtel:typeKind>domain</dtel:typeKind><dtel:typeName>ZTMC_D_TMODE</dtel:typeName>" +
      "<dtel:dataType>CHAR</dtel:dataType><dtel:dataTypeLength>000002</dtel:dataTypeLength>" +
      "<dtel:dataTypeDecimals>0</dtel:dataTypeDecimals><dtel:shortFieldLabel>Mode</dtel:shortFieldLabel>" +
      "</dtel:dataElement></blue:wbobj>";
    const conn = stubConn({
      dataElement: async () => ({ body: dtelXml }),
      domain: async () => ({ body: domXml }),
    });
    const r = await readDdic(
      conn,
      obj("DTEL", "ZMC_TMODE", "/sap/bc/adt/ddic/dataelements/zmc_tmode"),
    );
    const section = r.sections.find((s) => s.title === "FIXED VALUES (domain ZTMC_D_TMODE)");
    expect(section).toBeDefined();
    expect(section!.content).toMatch(/^01\s+.*Road/m);
    expect(section!.content).toMatch(/^02\s+.*Rail/m);
    expect(section!.content).toMatch(/^03\s+.*Sea/m);
    expect(section!.content).toMatch(/^04\s+.*Air/m);

    // 000002 -> 2, not "000002", not NaN, not a missing line.
    expect(r.ddl).toContain("built-in   : CHAR length 2");
    expect(r.ddl).not.toContain("000002");
    expect(r.ddl).not.toContain("NaN");
  });
});

// ---------------------------------------------------------------------------
// 5. Table type numerics. renderTableType is called directly (no
// AbapConnection involved) with a zero-padded <ttyp:length>, in the shape
// of TTYP_XML in test/ddic.test.ts.
// ---------------------------------------------------------------------------

describe("renderTableType — zero-padded length still parses to a number", () => {
  it("renders abap.char(10) from <ttyp:length>000010</ttyp:length>", () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><ttyp:tableType adtcore:name="ZOTH_T_X" adtcore:type="TTYP/DA" ' +
      'adtcore:description="x" xmlns:ttyp="http://www.sap.com/dictionary/tabletype" xmlns:adtcore="http://www.sap.com/adt/core">' +
      "<ttyp:rowType><ttyp:typeKind>predefinedAbapType</ttyp:typeKind><ttyp:typeName/>" +
      "<ttyp:builtInType><ttyp:dataType>CHAR</ttyp:dataType><ttyp:length>000010</ttyp:length>" +
      "<ttyp:decimals>000000</ttyp:decimals></ttyp:builtInType><ttyp:rangeType/></ttyp:rowType>" +
      "<ttyp:initialRowCount>00000</ttyp:initialRowCount><ttyp:accessType>standard</ttyp:accessType>" +
      '<ttyp:primaryKey ttyp:isVisible="true"><ttyp:definition>standard</ttyp:definition>' +
      "<ttyp:kind>nonUnique</ttyp:kind></ttyp:primaryKey></ttyp:tableType>";
    const r = renderTableType(xml, "ZOTH_T_X");
    expect(r.ddl).toContain("row type   : abap.char(10)");
  });
});

// ---------------------------------------------------------------------------
// 6. The character-literal note. The rendered table deliberately does not
// quote its values — quoting unconditionally would render `'5'` for an
// INT4/DEC-typed domain, which is wrong ABAP and the same class of harm as
// the coercion bug — so renderDomain and renderDataElement carry the character-ness in a
// note instead. Two wordings, and the distinction is the point: a genuinely
// zero-padded `01` makes BOTH `IF x = 1` and `IF x = '1'` miss, while an
// unpadded `1` is still a character literal but `IF x = '1'` is correct for
// it. Asserted by stable substring, not by whole sentence, so rewording the
// prose does not break the pin.
// ---------------------------------------------------------------------------

describe("the character-literal note", () => {
  it("fires for the 01-04 domain and names '01'", () => {
    const r = renderDomain({
      name: "ZTMC_D_TMODE",
      dataType: "CHAR",
      length: 2,
      fixedValues: [
        { low: "01", text: "Road" },
        { low: "02", text: "Rail" },
        { low: "03", text: "Sea" },
        { low: "04", text: "Air" },
      ],
    });
    const joined = r.notes.join(" ");
    expect(joined).toMatch(/character literals, not numbers/i);
    expect(joined).toMatch(/IF x = 1 and IF x = '1' both silently never match/);
    expect(joined).toContain("'01'");
  });

  // The note must not overclaim. For an unpadded `1`, `IF x = '1'` IS
  // correct ABAP; a note saying otherwise would tell the agent that correct
  // code is wrong — the same failure mode as the coercion bug, pointed the other way.
  it("uses the weaker wording for a digit-leading but unpadded value", () => {
    const r = renderDomain({
      name: "ZSTATUS",
      dataType: "CHAR",
      length: 1,
      fixedValues: [
        { low: "1", text: "open" },
        { low: "2", text: "closed" },
      ],
    });
    const joined = r.notes.join(" ");
    expect(joined).toMatch(/character literals, not numbers/i);
    expect(joined).toContain("IF x = '1'");
    expect(joined).not.toMatch(/never match/i);
  });

  // Same table, same trap, reached through the data element instead.
  it("also fires through renderDataElement, which surfaces the same table", () => {
    const r = renderDataElement(
      { name: "ZMC_TMODE", typeName: "ZTMC_D_TMODE", dataType: "CHAR", length: 2, labels: {} },
      {
        name: "ZTMC_D_TMODE",
        dataType: "CHAR",
        length: 2,
        fixedValues: [
          { low: "01", text: "Road" },
          { low: "02", text: "Rail" },
        ],
      },
    );
    const joined = r.notes.join(" ");
    expect(joined).toMatch(/character literals, not numbers/i);
    expect(joined).toContain("'01'");
  });

  it("is absent for an XFELD-shaped domain (X / '' fixed values)", () => {
    const r = renderDomain({
      name: "XFELD",
      dataType: "CHAR",
      length: 1,
      fixedValues: [
        { low: "X", text: "ja" },
        { low: "", text: "nein" },
      ],
    });
    expect(r.notes.join(" ")).not.toMatch(/character literals, not numbers/i);
  });

  it("is absent for a non-character domain (INT4-typed)", () => {
    const r = renderDomain({
      name: "ZCOUNT",
      dataType: "INT4",
      length: 4,
      fixedValues: [
        { low: "1", text: "one" },
        { low: "2", text: "two" },
      ],
    });
    expect(r.notes.join(" ")).not.toMatch(/character literals, not numbers/i);
  });
});
