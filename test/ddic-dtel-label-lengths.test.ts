/**
 * Pins DataElementView.labelLengths and its rendering in the FIELD LABELS
 * section — see src/adt/ddic.ts parseDataElementXml/renderDataElement.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDdic } from "../src/adt/ddic.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE_FIXTURES = join(HERE, "fixtures", "live-captured");
const DTEL_XML_LIVE = readFileSync(join(LIVE_FIXTURES, "844-live-dtel-s-carr-id.xml"), "utf8");
const DOMA_XML_LIVE = readFileSync(join(LIVE_FIXTURES, "845-live-doma-s-carr-id.xml"), "utf8");

interface Call {
  uri: string;
}

/** Local copy of test/ddic.test.ts's stubConn — that file exports nothing to import. */
function stubConn(handlers: {
  dataElement?: (uri: string) => Promise<{ body: string }>;
  domain?: (uri: string) => Promise<{ body: string }>;
  calls?: Call[];
}): AbapConnection {
  const record = (uri: string) => handlers.calls?.push({ uri });
  return {
    cfg: { sid: "A4H" },
    get: async (uri: string) => {
      record(uri);
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

/**
 * SYNTHETIC — the `<blue:wbobj>` envelope, its two namespace URIs, and where
 * each is declared are confirmed by the real GET response captured at
 * test/fixtures/live-captured/844-live-dtel-s-carr-id.xml. The shape
 * was originally copied from `abap-adt-api` 8.4.1's `setDataElementProperties`
 * (node_modules/abap-adt-api/build/api/objectcontents.js), which builds this
 * document as a PUT request body — that vendor source is now corroborated by
 * the live capture, not the sole basis for it.
 */
function dtelXml(bodyXml: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><blue:wbobj xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" ' +
    'xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZDT" adtcore:type="DTEL/DE" ' +
    'adtcore:description="A data element"><adtcore:packageRef adtcore:name="ZPKG"/>' +
    '<dtel:dataElement xmlns:dtel="http://www.sap.com/adt/dictionary/dataelements">' +
    bodyXml +
    "</dtel:dataElement></blue:wbobj>"
  );
}

/**
 * SYNTHETIC, same provenance as dtelXml above. The `<dtel:dataElement>`
 * child ordering matches `abap-adt-api` 8.4.1's `setDataElementProperties`
 * (node_modules/abap-adt-api/build/api/objectcontents.js) and is now
 * corroborated by the real GET response at
 * 844-live-dtel-s-carr-id.xml, which emits the same Label/Length/
 * MaxLength sequence for all four label kinds. The values themselves remain
 * constructed, not captured: `*FieldLength` (8/15/25/30) and
 * `*FieldMaxLength` (10/20/40/55) are all pairwise distinct so an assertion
 * on one set can't pass by reading the other — the real S_CARR_ID values
 * can't do this, since medium and long both come back as length 16.
 * `mediumFieldLength` is zero-padded ("000015") the way DDIC numerics arrive
 * on the wire, to pin that it goes through `xmlNum` and not a raw string
 * read (this is exactly the class of bug a raw-string read would let through).
 */
const DTEL_XML_FULL = dtelXml(
  "<dtel:typeKind>domain</dtel:typeKind><dtel:typeName>ZDOM</dtel:typeName>" +
    "<dtel:dataType>CHAR</dtel:dataType><dtel:dataTypeLength>10</dtel:dataTypeLength>" +
    "<dtel:dataTypeDecimals>0</dtel:dataTypeDecimals>" +
    "<dtel:shortFieldLabel>Short</dtel:shortFieldLabel>" +
    "<dtel:shortFieldLength>8</dtel:shortFieldLength>" +
    "<dtel:shortFieldMaxLength>10</dtel:shortFieldMaxLength>" +
    "<dtel:mediumFieldLabel>Medium</dtel:mediumFieldLabel>" +
    "<dtel:mediumFieldLength>000015</dtel:mediumFieldLength>" +
    "<dtel:mediumFieldMaxLength>20</dtel:mediumFieldMaxLength>" +
    "<dtel:longFieldLabel>Long</dtel:longFieldLabel>" +
    "<dtel:longFieldLength>25</dtel:longFieldLength>" +
    "<dtel:longFieldMaxLength>40</dtel:longFieldMaxLength>" +
    "<dtel:headingFieldLabel>Heading</dtel:headingFieldLabel>" +
    "<dtel:headingFieldLength>30</dtel:headingFieldLength>" +
    "<dtel:headingFieldMaxLength>55</dtel:headingFieldMaxLength>" +
    "<dtel:searchHelp></dtel:searchHelp><dtel:searchHelpParameter></dtel:searchHelpParameter>" +
    "<dtel:setGetParameter></dtel:setGetParameter><dtel:defaultComponentName></dtel:defaultComponentName>" +
    "<dtel:deactivateInputHistory>false</dtel:deactivateInputHistory>" +
    "<dtel:changeDocument>false</dtel:changeDocument>" +
    "<dtel:leftToRightDirection>false</dtel:leftToRightDirection>" +
    "<dtel:deactivateBIDIFiltering>false</dtel:deactivateBIDIFiltering>",
);

/** All four *FieldLabel elements present, no *FieldLength element at all. */
const DTEL_XML_NO_LENGTHS = dtelXml(
  "<dtel:typeKind>domain</dtel:typeKind><dtel:typeName>ZDOM</dtel:typeName>" +
    "<dtel:dataType>CHAR</dtel:dataType><dtel:dataTypeLength>10</dtel:dataTypeLength>" +
    "<dtel:dataTypeDecimals>0</dtel:dataTypeDecimals>" +
    "<dtel:shortFieldLabel>Short</dtel:shortFieldLabel>" +
    "<dtel:mediumFieldLabel>Medium</dtel:mediumFieldLabel>" +
    "<dtel:longFieldLabel>Long</dtel:longFieldLabel>" +
    "<dtel:headingFieldLabel>Heading</dtel:headingFieldLabel>",
);

/** Only shortFieldLength present; the other three labels carry no *FieldLength. */
const DTEL_XML_PARTIAL_LENGTHS = dtelXml(
  "<dtel:typeKind>domain</dtel:typeKind><dtel:typeName>ZDOM</dtel:typeName>" +
    "<dtel:dataType>CHAR</dtel:dataType><dtel:dataTypeLength>10</dtel:dataTypeLength>" +
    "<dtel:dataTypeDecimals>0</dtel:dataTypeDecimals>" +
    "<dtel:shortFieldLabel>Short</dtel:shortFieldLabel>" +
    "<dtel:shortFieldLength>8</dtel:shortFieldLength>" +
    "<dtel:mediumFieldLabel>Medium</dtel:mediumFieldLabel>" +
    "<dtel:longFieldLabel>Long</dtel:longFieldLabel>" +
    "<dtel:headingFieldLabel>Heading</dtel:headingFieldLabel>",
);

/**
 * SYNTHETIC — the `<doma:domain>` envelope and namespace are now
 * capture-confirmed by 845-live-doma-s-carr-id.xml (the real GET
 * response). This constant stays deliberately minimal rather than copying
 * that capture: shape matches `abap-adt-api` 8.4.1's `getDomainProperties`
 * (same objectcontents.js), trimmed to just enough for readDdic to complete
 * the second round trip readDataElement makes for the domain named ZDOM.
 */
const DOMA_XML =
  '<?xml version="1.0" encoding="UTF-8"?><doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" ' +
  'xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZDOM" adtcore:type="DOMA/DD" ' +
  'adtcore:description="A domain"><adtcore:packageRef adtcore:name="ZPKG"/>' +
  "<doma:content><doma:typeInformation><doma:datatype>CHAR</doma:datatype>" +
  "<doma:length>10</doma:length><doma:decimals>0</doma:decimals></doma:typeInformation>" +
  "<doma:outputInformation><doma:length>10</doma:length><doma:lowercase>false</doma:lowercase>" +
  "<doma:signExists>false</doma:signExists></doma:outputInformation></doma:content></doma:domain>";

function fieldLabelsSection(r: { sections: Array<{ title: string; content: string }> }): string {
  return r.sections.find((s) => s.title === "FIELD LABELS")?.content ?? "";
}

describe("renderDataElement FIELD LABELS: label lengths", () => {
  it("reads *FieldLength, not *FieldMaxLength, for every label kind", async () => {
    const conn = stubConn({
      dataElement: async () => ({ body: DTEL_XML_FULL }),
      domain: async () => ({ body: DOMA_XML }),
    });
    const r = await readDdic(conn, obj("DTEL", "ZDT", "/sap/bc/adt/ddic/dataelements/zdt"));
    const content = fieldLabelsSection(r);
    expect(content).toContain("short    Short (length 8)");
    expect(content).toContain("medium   Medium (length 15)");
    expect(content).toContain("long     Long (length 25)");
    expect(content).toContain("heading  Heading (length 30)");
    expect(content).not.toMatch(/\(length 20\)/);
    expect(content).not.toMatch(/\(length 40\)/);
    expect(content).not.toMatch(/\(length 55\)/);
    expect(content).not.toContain("000015");
    expect(content).not.toContain("NaN");
  });

  // The obvious implementation, xmlNum(...) ?? 0, would render "(length 0)"
  // here — a claim about the data element the descriptor never made. Absence
  // of an element is not a length of zero, and this stays green both before
  // and after labelLengths was added: it pins the null case, not the feature.
  it("renders a bare label, with no length claim, when no *FieldLength element was sent", async () => {
    const conn = stubConn({
      dataElement: async () => ({ body: DTEL_XML_NO_LENGTHS }),
      domain: async () => ({ body: DOMA_XML }),
    });
    const r = await readDdic(conn, obj("DTEL", "ZDT", "/sap/bc/adt/ddic/dataelements/zdt"));
    const content = fieldLabelsSection(r);
    expect(content).toContain("short    Short");
    expect(content).not.toContain("(length");
  });

  it("keeps a known length and an absent one separate within the same document", async () => {
    const conn = stubConn({
      dataElement: async () => ({ body: DTEL_XML_PARTIAL_LENGTHS }),
      domain: async () => ({ body: DOMA_XML }),
    });
    const r = await readDdic(conn, obj("DTEL", "ZDT", "/sap/bc/adt/ddic/dataelements/zdt"));
    const content = fieldLabelsSection(r);
    expect(content).toContain("short    Short (length 8)");
    const rest = content
      .split("\n")
      .filter((line) => !line.startsWith("short"))
      .join("\n");
    expect(rest).not.toContain("(length");
  });

  // Real captured bytes end to end — the strongest form of this file's claim,
  // because it discriminates *FieldLength from *FieldMaxLength on bytes SAP
  // actually sent, not a hand-built approximation of them. It's a weaker
  // short/medium/long/heading discriminator than DTEL_XML_FULL above, though:
  // S_CARR_ID's real mediumFieldLength and longFieldLength are both 16, so
  // this alone can't catch label-length wiring crossed between those two.
  it("renders the real captured S_CARR_ID lengths, not its MaxLength values", async () => {
    const conn = stubConn({
      dataElement: async () => ({ body: DTEL_XML_LIVE }),
      domain: async () => ({ body: DOMA_XML_LIVE }),
    });
    const r = await readDdic(
      conn,
      obj("DTEL", "S_CARR_ID", "/sap/bc/adt/ddic/dataelements/s_carr_id"),
    );
    const content = fieldLabelsSection(r);
    expect(content).toContain("short    Carrier (length 7)");
    expect(content).toContain("medium   Fluggesellschaft (length 16)");
    expect(content).toContain("long     Fluggesellschaft (length 16)");
    expect(content).toContain("heading  ID (length 2)");
    // *FieldMaxLength, observed here on one captured data element only — not
    // established as system-wide constants, just S_CARR_ID's own values —
    // must not leak in as rendered lengths.
    expect(content).not.toMatch(/\(length 10\)/);
    expect(content).not.toMatch(/\(length 20\)/);
    expect(content).not.toMatch(/\(length 40\)/);
    expect(content).not.toMatch(/\(length 55\)/);
    expect(content).not.toContain("NaN");
    // Zero-padded wire forms must not leak through as literal strings.
    expect(content).not.toContain("07");
    expect(content).not.toContain("02");
    expect(content).not.toContain("000003");
  });
});

// The SYNTHETIC labels above (and in test/ddic.test.ts) now say their
// envelope is capture-confirmed by specific files under
// test/fixtures/live-captured/. This pins that those files are actually
// there and actually target the endpoints those comments name — if either
// capture is deleted or renamed, the doc comments go stale silently unless
// this goes red too.
describe("DTEL and DOMA descriptor captures exist", () => {
  it("finds a fixture whose captured request targets ddic/dataelements, and one targeting ddic/domains", () => {
    const fixturesDir = join(HERE, "fixtures");

    function walk(dir: string, out: string[] = []): string[] {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (p.endsWith(".meta.json")) out.push(p);
      }
      return out;
    }

    let hasDtelCapture = false;
    let hasDomaCapture = false;
    for (const f of walk(fixturesDir)) {
      const meta = JSON.parse(readFileSync(f, "utf8")) as {
        requestUrl?: string;
        requestPath?: string;
      };
      const target = `${meta.requestUrl ?? ""} ${meta.requestPath ?? ""}`;
      if (target.includes("/sap/bc/adt/ddic/dataelements/")) hasDtelCapture = true;
      if (target.includes("/sap/bc/adt/ddic/domains/")) hasDomaCapture = true;
    }
    expect(hasDtelCapture).toBe(true);
    expect(hasDomaCapture).toBe(true);
  });
});
