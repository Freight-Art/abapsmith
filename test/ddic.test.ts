/**
 * Pseudo-DDL rendering.
 * "Never hand raw ADT XML to the model; render pseudo-DDL."
 *
 * SFLIGHT_DDL, STRUCTURE_DDL, TTYP_XML are excerpts of what A4H returned
 * on 2026-07-31; no saved capture exists here, so bytes are unaudited.
 * Corroborated instead: test/integration.test.ts reads SFLIGHT and
 * ZOTH_T_NOTE_K; both ZOTH_S_NOTE_K and ZOTH_T_NOTE_K appear in
 * test/fixtures/cts/transports-by-config.xml, ZOTH_S_NOTE_K only there.
 * DTEL_XML and DOMA_XML are different: genuine captures taken 2026-08-28
 * from test/fixtures/live-captured/, read at test time; see their own
 * comments below.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DDIC_SOURCE_BASED,
  DDIC_XML_ONLY,
  classifyDdicFailure,
  ddicStrategy,
  parseDdl,
  readDdic,
  renderDataElement,
  renderDdlDigest,
  renderDomain,
  renderTableType,
  renderTableXmlFallback,
} from "../src/adt/ddic.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const read = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/** Live response from GET /sap/bc/adt/ddic/tables/sflight/source/main */
const SFLIGHT_DDL = `@EndUserText.label : 'Flug'
@AbapCatalog.enhancementCategory : #EXTENSIBLE_CHARACTER_NUMERIC
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #ALLOWED
define table sflight {
  @AbapCatalog.foreignKey.keyType : #KEY
  @AbapCatalog.foreignKey.screenCheck : true
  key mandt  : s_mandt not null
    with foreign key [0..*,1] t000
      where mandt = sflight.mandt;
  @AbapCatalog.foreignKey.screenCheck : true
  key carrid : s_carr_id not null
    with foreign key scarr
      where mandt = sflight.mandt
        and carrid = sflight.carrid;
  key connid : s_conn_id not null
    with foreign key [0..*,1] spfli
      where mandt = sflight.mandt
        and connid = sflight.connid;
  key fldate : s_date not null;
  @Semantics.amount.currencyCode : 'sflight.currency'
  price      : s_price not null;
  currency   : s_currcode not null
    with foreign key [1..*,1] scurx
      where currkey = sflight.currency;
  seatsmax   : s_seatsmax not null;

}`;

/** Live response from GET /sap/bc/adt/ddic/structures/zoth_s_note_k/source/main */
const STRUCTURE_DDL = `@EndUserText.label : '#GENERATED#'
@AbapCatalog.enhancementCategory : #EXTENSIBLE_CHARACTER_NUMERIC
define structure zoth_s_note_k {
  include /bobf/s_frw_key_incl;
  node_data : include zoth_s_note;

}`;

/** Live response from GET /sap/bc/adt/ddic/tabletypes/zoth_t_note_k (truncated boilerplate). */
const TTYP_XML = `<?xml version="1.0" encoding="utf-8"?><ttyp:tableType adtcore:name="ZOTH_T_NOTE_K" adtcore:type="TTYP/DA" adtcore:description="Note keys" xmlns:ttyp="http://www.sap.com/dictionary/tabletype" xmlns:adtcore="http://www.sap.com/adt/core"><ttyp:rowType><ttyp:typeKind>dictionaryType</ttyp:typeKind><ttyp:typeName>ZOTH_S_NOTE_K</ttyp:typeName><ttyp:builtInType><ttyp:dataType>STRU</ttyp:dataType><ttyp:length>000000</ttyp:length><ttyp:decimals>000000</ttyp:decimals></ttyp:builtInType><ttyp:rangeType/></ttyp:rowType><ttyp:initialRowCount>00000</ttyp:initialRowCount><ttyp:accessType>standard</ttyp:accessType><ttyp:primaryKey ttyp:isVisible="true"><ttyp:definition>keyComponents</ttyp:definition><ttyp:kind>nonUnique</ttyp:kind><ttyp:components ttyp:isVisible="true"><ttyp:component ttyp:name="KEY"/></ttyp:components><ttyp:alias/></ttyp:primaryKey><ttyp:valueHelps><ttyp:typeKindValues><ttyp:valueHelp ttyp:key="dictionaryType" ttyp:value="Dictionary Type" ttyp:description=""/><ttyp:valueHelp ttyp:key="predefinedAbapType" ttyp:value="Predefined Type" ttyp:description=""/></ttyp:typeKindValues></ttyp:valueHelps></ttyp:tableType>`;

describe("parseDdl (source-based TABL/STRU)", () => {
  const parsed = parseDdl(SFLIGHT_DDL);

  it("finds the entity name", () => {
    expect(parsed.entity).toBe("sflight");
  });

  it("extracts every field with its key flag", () => {
    expect(parsed.fields.map((f) => f.name)).toEqual([
      "MANDT",
      "CARRID",
      "CONNID",
      "FLDATE",
      "PRICE",
      "CURRENCY",
      "SEATSMAX",
    ]);
    expect(parsed.fields.filter((f) => f.key).map((f) => f.name)).toEqual([
      "MANDT",
      "CARRID",
      "CONNID",
      "FLDATE",
    ]);
  });

  it("keeps the data-element type of each field", () => {
    expect(parsed.fields.find((f) => f.name === "PRICE")?.type).toBe("s_price");
    expect(parsed.fields.find((f) => f.name === "MANDT")?.type).toBe("s_mandt");
  });

  it("extracts foreign keys, cardinality prefix and all", () => {
    const fks = Object.fromEntries(
      parsed.fields.filter((f) => f.foreignKey).map((f) => [f.name, f.foreignKey]),
    );
    expect(fks).toEqual({
      MANDT: "T000",
      CARRID: "SCARR",
      CONNID: "SPFLI",
      CURRENCY: "SCURX",
    });
  });

  it("renders a digest naming keys and foreign keys", () => {
    const d = renderDdlDigest(parsed);
    expect(d.meta.fields).toBe(7);
    expect(d.meta.keyFields).toBe("MANDT, CARRID, CONNID, FLDATE");
    expect(d.meta.foreignKeys).toContain("CARRID→SCARR");
    expect(d.sections[0]!.content).toContain("KEY");
    expect(d.sections[0]!.content).toContain("SCARR");
  });

  it("handles includes in structures", () => {
    const s = parseDdl(STRUCTURE_DDL);
    expect(s.entity).toBe("zoth_s_note_k");
    expect(s.includes).toEqual(["/BOBF/S_FRW_KEY_INCL"]);
    expect(s.fields.find((f) => f.name === "NODE_DATA")?.type).toBe("INCLUDE ZOTH_S_NOTE");
  });
});

describe("renderTableType (XML-only on A4H)", () => {
  const r = renderTableType(TTYP_XML, "ZOTH_T_NOTE_K");

  it("emits pseudo-DDL, not XML", () => {
    expect(r.ddl).not.toContain("<");
    expect(r.ddl).toContain("define table type zoth_t_note_k");
    expect(r.ddl).toContain("row type   : ZOTH_S_NOTE_K");
    expect(r.ddl).toContain("table kind : standard");
    expect(r.ddl).toContain("nonUnique key (KEY)");
  });

  it("throws away the value-help boilerplate that dominates the XML", () => {
    expect(r.ddl).not.toContain("Predefined Type");
    expect(r.ddl.length).toBeLessThan(TTYP_XML.length / 3);
  });
});

describe("renderDomain", () => {
  it("renders type, value table and fixed values", () => {
    const r = renderDomain({
      name: "XFELD",
      description: "Ja/Nein - Feld",
      dataType: "CHAR",
      length: 1,
      outputLength: 1,
      valueTable: "",
      fixedValues: [
        { low: "X", text: "ja" },
        { low: "", text: "nein" },
      ],
    });
    expect(r.ddl).toContain("define domain xfeld");
    expect(r.ddl).toContain("type        : CHAR length 1");
    expect(r.ddl).toContain("fixed values: 2");
    expect(r.sections[0]!.title).toBe("FIXED VALUES");
    expect(r.sections[0]!.content).toContain("''"); // blank value made visible
    expect(r.sections[0]!.content).toContain("nein");
  });

  it("names the value table", () => {
    const r = renderDomain({ name: "S_CARR_ID", dataType: "CHAR", length: 3, valueTable: "SCARR" });
    expect(r.ddl).toContain("value table : SCARR");
    expect(r.notes).toHaveLength(0);
  });

  it("says so explicitly when a domain constrains nothing", () => {
    const r = renderDomain({ name: "ZCHAR_20", dataType: "CHAR", length: 20 });
    expect(r.notes[0]).toMatch(/no value table and no fixed values/i);
  });

  // Live regression: a domain whose fixed values are `1`/`2` — an entirely
  // ordinary numeric status domain — crashed the whole read with
  // `TypeError: c.padEnd is not a function`, surfaced to the caller as a
  // bogus ADT_ERROR that had nothing to do with ADT.
  //
  // The XMLParser in src/adt/ddic.ts is configured
  // `parseTagValue: false`, so the wire no longer hands `low`/`high` over as
  // JS numbers — see test/ddic-value-fidelity.test.ts for the tests that pin
  // that wire-level behaviour (including the zero-padding fix itself
  // and the boolean/number side effects of that parser flag). This test
  // stays as-is: it now pins renderFixedValues's defence-in-depth against a
  // *caller-built* DomainView still carrying numbers — renderFixedValues is
  // exported, and both renderDomain/renderDataElement accept a caller-built
  // view, so a non-wire caller can still hand it a number directly. The
  // renderer must not trust the declared type here regardless of source.
  it("renders numeric fixed values, which a caller can still hand over as numbers", () => {
    const r = renderDomain({
      name: "ZMODE",
      dataType: "NUMC",
      length: 1,
      // Deliberately lying to the compiler the way the wire lies at runtime.
      fixedValues: [
        { low: 1 as unknown as string, text: "Truck" },
        { low: 2 as unknown as string, high: 3 as unknown as string, text: "Rail" },
      ],
    });
    expect(r.sections[0]!.content).toContain("Truck");
    expect(r.sections[0]!.content).toMatch(/^1\s/m);
    expect(r.sections[0]!.content).toContain("3");
  });
});

describe("renderDataElement", () => {
  it("names the domain and its value table", () => {
    const r = renderDataElement(
      {
        name: "S_CARR_ID",
        description: "Kurzbezeichnung der Fluggesellschaft",
        typeName: "S_CARR_ID",
        dataType: "CHAR",
        length: 3,
        labels: { short: "Carrier", medium: "Fluggesellschaft", long: "", heading: "ID" },
        searchHelp: "S_CARRIER_ID",
        searchHelpParameter: "CARRID",
      },
      { name: "S_CARR_ID", dataType: "CHAR", length: 3, valueTable: "SCARR" },
    );
    expect(r.ddl).toContain("domain     : S_CARR_ID");
    expect(r.ddl).toContain("value table: SCARR");
    expect(r.ddl).toContain("search help: S_CARRIER_ID (CARRID)");
    expect(r.sections.some((s) => s.title === "FIELD LABELS")).toBe(true);
  });

  it("surfaces the domain's fixed values through the data element", () => {
    const r = renderDataElement(
      { name: "ZFLAG", typeName: "XFELD", dataType: "CHAR", length: 1, labels: {} },
      {
        name: "XFELD",
        dataType: "CHAR",
        length: 1,
        fixedValues: [
          { low: "X", text: "yes" },
          { low: "", text: "no" },
        ],
      },
    );
    expect(r.sections.some((s) => s.title.startsWith("FIXED VALUES"))).toBe(true);
  });

  it("flags a directly-typed data element", () => {
    const r = renderDataElement({
      name: "ZRAW",
      typeName: "",
      dataType: "STRG",
      length: 0,
      labels: {},
    });
    expect(r.notes.join(" ")).toMatch(/typed directly/i);
  });
});

describe("renderTableXmlFallback (older, XML-only releases)", () => {
  const XML = `<?xml version="1.0"?><tbl:table xmlns:tbl="x"><tbl:columns>
    <tbl:column name="MANDT" isKey="true" dataElement="MANDT" length="3"/>
    <tbl:column name="CARRID" isKey="true" dataElement="S_CARR_ID" length="3"/>
    <tbl:column name="PRICE" isKey="false" dataElement="S_PRICE" length="15"/>
  </tbl:columns></tbl:table>`;

  it("reconstructs DDL and never returns XML", () => {
    const r = renderTableXmlFallback(XML, "SFLIGHT");
    expect(r.ddl).not.toContain("<");
    expect(r.ddl).toContain("key mandt : MANDT");
    expect(r.ddl).toContain("price : S_PRICE");
    expect(r.notes[0]).toMatch(/reconstructed/i);
  });

  it("degrades honestly when it can extract nothing", () => {
    const r = renderTableXmlFallback(`<?xml version="1.0"?><a:b xmlns:a="x"/>`, "ZFOO");
    expect(r.ddl).toContain("no field information");
    expect(r.ddl).not.toContain("<");
  });
});

// ---------------------------------------------------------------------------
// Which endpoint is used for which kind, and what happens when that
// endpoint refuses. All offline: the connection is a stub that records what
// was asked for.
// ---------------------------------------------------------------------------

interface Call {
  uri: string;
}

/**
 * Perf fix: `readDataElement`/`readDomain` no
 * longer call `abap-adt-api`'s `getDataElementProperties`/`getDomainProperties`
 * — they fetch the raw XML descriptor via `conn.get` (same as every other
 * DDIC read) and parse it themselves, so there is exactly one HTTP call per
 * object instead of two. `dataElement`/`domain` below stand in for that same
 * single `conn.get`, keyed by URI shape, returning `{ body: <raw XML> }`.
 */
function stubConn(handlers: {
  get?: (uri: string) => Promise<{ body: string }>;
  nodeContents?: (parentType: string, name?: string) => Promise<unknown>;
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
      if (!handlers.get) throw new Error(`unexpected GET ${uri}`);
      return handlers.get(uri);
    },
    adt: {
      nodeContents: async (parentType: string, name?: string) => {
        record(`nodeContents:${parentType}:${name ?? ""}`);
        if (!handlers.nodeContents) throw new Error("unexpected nodeContents");
        return handlers.nodeContents(parentType, name);
      },
    },
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
 * Live capture — verbatim response bytes from the A4H appliance, captured
 * 2026-08-28, read from
 * test/fixtures/live-captured/844-live-dtel-s-carr-id.xml. This
 * document is complete: it is not truncated after `<dtel:shortFieldLabel>`
 * the way the old reconstructed constant was. The body is byte-exact; the
 * sidecar's `responseStatus` is inferred rather than observed because the
 * capture went through the `abap_read` tool, not an HTTP-layer harness —
 * see the .meta.json for the full explanation.
 */
const DTEL_XML = read("844-live-dtel-s-carr-id.xml");

/**
 * Live capture — verbatim response bytes from the A4H appliance, captured
 * 2026-08-28, read from
 * test/fixtures/live-captured/845-live-doma-s-carr-id.xml. The body
 * is byte-exact; the sidecar's `responseStatus` is inferred rather than
 * observed because the capture went through the `abap_read` tool, not an
 * HTTP-layer harness — see the .meta.json for the full explanation.
 */
const DOMA_XML = read("845-live-doma-s-carr-id.xml");

/** HTTP failure in the shape `abap-adt-api` throws (`.err` carries the status). */
function httpError(status: number, message: string): unknown {
  return Object.assign(new Error(message), { err: status, type: "ExceptionHttp", message });
}

describe("ddicStrategy (two live groups, not one)", () => {
  it("treats TABL/STRU as source-based and DTEL/DOMA/TTYP as XML-only", () => {
    expect(DDIC_SOURCE_BASED.map(ddicStrategy)).toEqual(["source", "source"]);
    expect(DDIC_XML_ONLY.map(ddicStrategy)).toEqual(["xml", "xml", "xml"]);
    // The five DDIC types are not all fetched the same way; the live capture
    // put DTEL/DOMA/TTYP in a separate, XML-only group.
    expect(DDIC_SOURCE_BASED).not.toContain("DTEL");
    expect(DDIC_SOURCE_BASED).not.toContain("DOMA");
    expect(DDIC_SOURCE_BASED).not.toContain("TTYP");
  });

  it("knows DEVC is a package and anything else is unsupported", () => {
    expect(ddicStrategy("DEVC")).toBe("package");
    expect(ddicStrategy("devc")).toBe("package");
    expect(ddicStrategy("CLAS")).toBe("unsupported");
  });

  it("never asks an XML-only type for /source/main", async () => {
    const calls: Call[] = [];
    const conn = stubConn({
      calls,
      dataElement: async () => ({ body: DTEL_XML }),
      domain: async () => ({ body: DOMA_XML }),
    });
    await readDdic(conn, obj("DTEL", "ZDT", "/sap/bc/adt/ddic/dataelements/zdt"));
    expect(calls.some((c) => c.uri.includes("/source/main"))).toBe(false);
  });
});

describe("readDdic on a package (DEVC/K was advertised but unreadable)", () => {
  it("lists the package contents instead of throwing UNSUPPORTED", async () => {
    const calls: Call[] = [];
    const conn = stubConn({
      calls,
      nodeContents: async () => ({
        nodes: [
          { OBJECT_TYPE: "CLAS/OC", OBJECT_NAME: "ZCL_A", DESCRIPTION: "Class A" },
          { OBJECT_TYPE: "CLAS/OC", OBJECT_NAME: "ZCL_B", DESCRIPTION: "Class B" },
          { OBJECT_TYPE: "DEVC/K", OBJECT_NAME: "ZSUB", DESCRIPTION: "Sub package" },
          { OBJECT_TYPE: "TABL/DT", OBJECT_NAME: "", DESCRIPTION: "grouping node" },
        ],
      }),
    });
    const r = await readDdic(conn, obj("DEVC", "ZPKG", "/sap/bc/adt/packages/zpkg"));
    expect(calls[0]!.uri).toBe("nodeContents:DEVC/K:ZPKG");
    expect(r.ddl).toContain("ZCL_A");
    expect(r.ddl).toContain("ZSUB");
    expect(r.ddl).not.toContain("<");
    expect(r.meta.objects).toBe(3);
    // The sub-package is listed but NOT expanded — say so rather than let the
    // agent read the listing as the package's full contents.
    expect(r.notes.join(" ")).toMatch(/sub-package\(s\) are listed but NOT expanded/);
  });

  it("says the server returned nothing rather than rendering an empty table", async () => {
    const conn = stubConn({ nodeContents: async () => ({ nodes: [] }) });
    const r = await readDdic(conn, obj("DEVC", "ZEMPTY", "/sap/bc/adt/packages/zempty"));
    expect(r.ddl).toMatch(/returned no objects/);
    expect(r.ddl).toMatch(/not a rendering failure/);
  });
});

describe("a refused read is an error, never a degraded rendering", () => {
  it("surfaces a 403 on /source/main as AUTH_FAILED and does NOT fall back to XML", async () => {
    const calls: Call[] = [];
    const conn = stubConn({
      calls,
      get: async (uri) => {
        if (uri.endsWith("/source/main")) throw httpError(403, "No authorisation for object");
        return { body: `<?xml version="1.0"?><tbl:table xmlns:tbl="x"/>` };
      },
    });
    await expect(
      readDdic(conn, obj("TABL", "SFLIGHT", "/sap/bc/adt/ddic/tables/sflight")),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    // The XML fallback must not have been attempted: it would have produced a
    // "reconstructed" table and blamed the release for an authorisation error.
    expect(calls).toHaveLength(1);
  });

  it("still falls back to XML on a genuine 404, and says why", async () => {
    const conn = stubConn({
      get: async (uri) => {
        if (uri.endsWith("/source/main")) throw httpError(404, "Resource not found");
        return {
          body: `<?xml version="1.0"?><tbl:table xmlns:tbl="x"><tbl:columns>
            <tbl:column name="MANDT" isKey="true" dataElement="MANDT" length="3"/>
          </tbl:columns></tbl:table>`,
        };
      },
    });
    const r = await readDdic(conn, obj("TABL", "SFLIGHT", "/sap/bc/adt/ddic/tables/sflight"));
    expect(r.notes.join(" ")).toMatch(/404/);
    expect(r.notes.join(" ")).toMatch(/reconstructed/i);
  });

  it("never probes the XML fallback when /source/main already succeeded", async () => {
    const calls: Call[] = [];
    const conn = stubConn({
      calls,
      get: async (uri) => {
        if (uri.endsWith("/source/main")) return { body: "@EndUserText.label: 'x'\ndefine table sflight {}" };
        throw httpError(404, "Resource not found");
      },
    });
    const r = await readDdic(conn, obj("TABL", "SFLIGHT", "/sap/bc/adt/ddic/tables/sflight"));
    expect(r.ddl).toContain("define table sflight");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.uri).toBe("/sap/bc/adt/ddic/tables/sflight/source/main");
  });

  it("surfaces a 403 on a package read too", async () => {
    const conn = stubConn({
      nodeContents: async () => {
        throw httpError(403, "No authorisation");
      },
    });
    await expect(
      readDdic(conn, obj("DEVC", "ZPKG", "/sap/bc/adt/packages/zpkg")),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("never turns a refused DOMAIN lookup into 'typed directly, no domain'", async () => {
    const conn = stubConn({
      dataElement: async () => ({ body: DTEL_XML }),
      domain: async () => {
        throw httpError(403, "No authorisation for domain S_CARR_ID");
      },
    });
    const r = await readDdic(conn, obj("DTEL", "ZDT", "/sap/bc/adt/ddic/dataelements/zdt"));
    const notes = r.notes.join(" ");
    // The old bare `catch {}` made this data element look domain-less.
    expect(notes).not.toMatch(/typed directly/i);
    expect(notes).toMatch(/Domain S_CARR_ID could NOT be read/);
    expect(notes).toMatch(/AUTH_FAILED/);
    expect(notes).toMatch(/UNKNOWN here/);
    expect(r.ddl).toContain("domain     : S_CARR_ID");
  });

  it("reports a refused data-element read as AUTH_FAILED, not NOT_FOUND", async () => {
    const conn = stubConn({
      dataElement: async () => {
        throw httpError(403, "No authorisation");
      },
    });
    await expect(
      readDdic(conn, obj("DTEL", "ZDT", "/sap/bc/adt/ddic/dataelements/zdt")),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("reports a refused domain read as AUTH_FAILED, not NOT_FOUND", async () => {
    const conn = stubConn({
      domain: async () => {
        throw httpError(403, "No authorisation");
      },
    });
    await expect(
      readDdic(conn, obj("DOMA", "ZDOM", "/sap/bc/adt/ddic/domains/zdom")),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("classifyDdicFailure explains that a 403 is not evidence of emptiness", () => {
    const err = classifyDdicFailure(httpError(403, "nope"), {
      operation: "read DDIC object",
      name: "SFLIGHT",
      type: "TABL/DT",
    });
    expect(err.code).toBe("AUTH_FAILED");
    expect(err.hint ?? "").toMatch(/NOT evidence that the object is empty/);
  });
});
