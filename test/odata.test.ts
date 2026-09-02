/**
 * OData `$metadata` introspection — parser, resolution chain, tool surface.
 *
 * ## Provenance of everything asserted here
 *
 * Every fixture this suite reads is **SYNTHETIC** (see
 * `test/fixtures/odata/README.md`). No live capture exists: the appliance went
 * down before any OData work reached it, and the V4 half could never have been
 * captured from it anyway — SAP_BASIS 754 has no V4 binding type. So this
 * suite proves that the parser and the resolution chain behave as designed on
 * documents of the documented shape. It does NOT prove that a real SAP system
 * emits that shape. That distinction is already on record, along with the
 * live probe that would close the gap.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { findEntitySet, findEntityType, parseEdmx } from "../src/adt/edmx.js";
import { AbapError } from "../src/adt/errors.js";
import type { AbapConnection } from "../src/adt/connection.js";
import {
  assertServiceRuntimePath,
  normaliseBindingName,
  readServiceContract,
} from "../src/adt/odata.js";
import {
  compressionRatio,
  renderServiceResult,
  ServiceInput,
  serviceInputSchema,
} from "../src/tools/service.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import type { AbapMode } from "../src/mode.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(join(here, "fixtures", "odata", name), "utf8");

const V2 = fixture("SYNTHETIC-v2-metadata.xml");
const V4 = fixture("SYNTHETIC-v4-metadata.xml");
const BINDING = fixture("SYNTHETIC-service-binding.xml");
const BINDING_UNPUBLISHED = fixture("SYNTHETIC-service-binding-unpublished.xml");
const CATALOGUE = fixture("SYNTHETIC-service-catalogue.xml");

// =========================================================== EDMX: OData V2 ===

describe("parseEdmx — OData V2", () => {
  const c = parseEdmx(V2);

  it("detects V2 from the document itself, and says on what evidence", () => {
    expect(c.version).toBe("V2");
    expect(c.versionEvidence).toBe("edmx-version-attribute");
  });

  it("reads the container, namespace and both entity sets", () => {
    expect(c.namespace).toBe("ZTRAVEL_SRV");
    expect(c.entityContainer).toBe("ZTRAVEL_SRV_Entities");
    expect(c.entitySets.map((s) => s.name)).toEqual(["Travel", "Booking"]);
  });

  it("reads composite keys, not just the first PropertyRef", () => {
    expect(findEntityType(c, "TravelType")?.keys).toEqual(["TravelUUID"]);
    expect(findEntityType(c, "ZTRAVEL_SRV.BookingType")?.keys).toEqual([
      "TravelUUID",
      "BookingUUID",
    ]);
  });

  it("keeps sap: capability attributes tri-state — unstated is not false", () => {
    const travel = findEntitySet(c, "Travel");
    expect(travel?.capabilities).toMatchObject({
      creatable: true,
      updatable: true,
      deletable: true,
      pageable: true,
      searchable: true,
    });
    // Travel states nothing about addressability. That must not become `false`.
    expect(travel?.capabilities.addressable).toBeUndefined();

    const booking = findEntitySet(c, "Booking");
    expect(booking?.capabilities).toMatchObject({
      creatable: true,
      updatable: true,
      deletable: false,
      searchable: false,
      addressable: false,
    });
  });

  it("resolves navigation through the Association/End indirection", () => {
    const nav = findEntityType(c, "TravelType")?.navigation ?? [];
    const toBooking = nav.find((n) => n.name === "to_Booking");
    expect(toBooking).toMatchObject({
      target: "ZTRAVEL_SRV.BookingType",
      multiplicity: "*",
    });
    expect(toBooking?.unresolved).toBeUndefined();

    // The reverse direction resolves against the OTHER End of the same
    // association — the role names are swapped, not the association.
    const back = findEntityType(c, "BookingType")?.navigation.find((n) => n.name === "to_Travel");
    expect(back).toMatchObject({ target: "ZTRAVEL_SRV.TravelType", multiplicity: "1" });
  });

  it("marks a dangling navigation unresolved rather than dropping or inventing it", () => {
    const nav = findEntityType(c, "TravelType")?.navigation ?? [];
    const toAgency = nav.find((n) => n.name === "to_Agency");
    expect(toAgency?.unresolved).toBe(true);
    expect(toAgency?.target).toContain("assoc_Missing");
  });

  it("keeps type facets as written, including Precision/Scale and MaxLength", () => {
    const props = findEntityType(c, "TravelType")?.properties ?? [];
    expect(props.find((p) => p.name === "TravelID")).toMatchObject({
      type: "Edm.String",
      maxLength: "8",
    });
    expect(props.find((p) => p.name === "TotalPrice")).toMatchObject({
      type: "Edm.Decimal",
      precision: "16",
      scale: "3",
      unit: "CurrencyCode",
    });
    expect(props.find((p) => p.name === "TravelUUID")?.nullable).toBe(false);
  });

  it("reads per-property sap: flags including required-in-filter and text", () => {
    const props = findEntityType(c, "TravelType")?.properties ?? [];
    expect(props.find((p) => p.name === "AgencyID")).toMatchObject({
      requiredInFilter: true,
      text: "AgencyName",
      label: "Agency",
    });
    expect(props.find((p) => p.name === "Description")?.filterable).toBe(false);
  });

  it("classifies a POST function import as an action and a GET one as a function", () => {
    const accept = c.operations.find((o) => o.name === "acceptTravel");
    expect(accept).toMatchObject({ kind: "action", httpMethod: "POST" });
    expect(accept?.parameters.map((p) => p.name)).toEqual(["TravelUUID"]);
    expect(c.operations.find((o) => o.name === "getTravelPrice")?.kind).toBe("function");
  });

  it("reports the byte size of what it parsed", () => {
    expect(c.rawBytes).toBe(Buffer.byteLength(V2, "utf8"));
  });
});

// =========================================================== EDMX: OData V4 ===
//
// INFERENCE, not verification: see the suite header. These assertions pin the
// behaviour of the V4 branch against the CSDL specification, and nothing more.

describe("parseEdmx — OData V4 (INFERENCE: unverifiable on SAP_BASIS 754)", () => {
  const c = parseEdmx(V4);

  it("detects V4 from the document itself", () => {
    expect(c.version).toBe("V4");
    expect(c.versionEvidence).toBe("edmx-version-attribute");
    expect(c.entitySets.map((s) => s.name)).toEqual(["Travel", "Booking"]);
  });

  it("reads inline Capabilities annotations under a non-obvious alias", () => {
    const travel = findEntitySet(c, "Travel");
    expect(travel?.label).toBe("Travel");
    expect(travel?.capabilities).toMatchObject({ searchable: true, deletable: false });
    // Nothing was said about insert/update on Travel.
    expect(travel?.capabilities.creatable).toBeUndefined();
    expect(travel?.capabilities.updatable).toBeUndefined();
  });

  it("reads capabilities from an EXTERNAL <Annotations Target=…> block too", () => {
    const booking = findEntitySet(c, "Booking");
    expect(booking?.label).toBe("Booking");
    expect(booking?.capabilities).toMatchObject({
      creatable: true,
      updatable: false,
      // TopSupported="false" is V4's spelling of sap:pageable="false".
      pageable: false,
    });
  });

  it("finds an external Annotations block targeted through the schema ALIAS", () => {
    // Both spellings of the target are legal for the same document. Matching
    // only the namespace-qualified form silently loses every capability on a
    // service whose generator chose the alias.
    const aliased = V4.replace(
      '<Schema Namespace="com.sap.gateway.srvd.ztravel.v0001"',
      '<Schema Alias="Self" Namespace="com.sap.gateway.srvd.ztravel.v0001"',
    ).replace(
      'Target="com.sap.gateway.srvd.ztravel.v0001.EntityContainer/Booking"',
      'Target="Self.EntityContainer/Booking"',
    );
    const booking = findEntitySet(parseEdmx(aliased), "Booking");
    expect(booking?.label).toBe("Booking");
    expect(booking?.capabilities).toMatchObject({ creatable: true, updatable: false });
  });

  it("normalises Collection(...) navigation onto the V2 multiplicity vocabulary", () => {
    const nav = findEntityType(c, "TravelType")?.navigation ?? [];
    expect(nav.find((n) => n.name === "_Booking")).toMatchObject({
      target: "com.sap.gateway.srvd.ztravel.v0001.BookingType",
      multiplicity: "*",
    });
    expect(
      findEntityType(c, "BookingType")?.navigation.find((n) => n.name === "_Travel")?.multiplicity,
    ).toBe("1");
  });

  it("keeps MaxLength=\"Max\" as written rather than coercing it to a number", () => {
    const desc = findEntityType(c, "TravelType")?.properties.find((p) => p.name === "Description");
    expect(desc?.maxLength).toBe("Max");
  });

  it("joins container imports to their schema-level definitions for parameters", () => {
    const rebuild = c.operations.find((o) => o.name === "rebuildIndex");
    expect(rebuild).toMatchObject({ kind: "action" });
    expect(rebuild?.parameters.map((p) => p.name)).toEqual(["Force"]);
    const price = c.operations.find((o) => o.name === "travelPrice");
    expect(price).toMatchObject({ kind: "function", returnType: "Edm.Decimal" });
  });

  it("reports a BOUND action that has no import at all", () => {
    const bound = c.operations.find((o) => o.name === "acceptTravel");
    expect(bound?.kind).toBe("action");
    // The binding parameter is kept: "bound to what" is the point of a bound action.
    expect(bound?.parameters[0]?.name).toBe("_it");
  });
});

// ================================================= EDMX: version detection ===

describe("parseEdmx — version is detected, never guessed", () => {
  it("falls back to m:DataServiceVersion when the edmx Version attribute is gone", () => {
    const stripped = V2.replace('<edmx:Edmx Version="1.0"', "<edmx:Edmx");
    const c = parseEdmx(stripped);
    expect(c.version).toBe("V2");
    expect(c.versionEvidence).toBe("dataservice-version-attribute");
  });

  it("falls back to the presence of an <Association> element", () => {
    const stripped = V2.replace('<edmx:Edmx Version="1.0"', "<edmx:Edmx").replace(
      'm:DataServiceVersion="2.0"',
      "",
    );
    const c = parseEdmx(stripped);
    expect(c.version).toBe("V2");
    expect(c.versionEvidence).toBe("structural-association-element");
  });

  it("falls back to a typed <NavigationProperty> for V4", () => {
    const stripped = V4.replace('<edmx:Edmx Version="4.0"', "<edmx:Edmx");
    const c = parseEdmx(stripped);
    expect(c.version).toBe("V4");
    expect(c.versionEvidence).toBe("structural-navigation-type");
  });

  it("refuses a document that identifies itself as neither, rather than assuming one", () => {
    const anonymous =
      '<?xml version="1.0"?><edmx:Edmx xmlns:edmx="x"><edmx:DataServices>' +
      '<Schema Namespace="Z"><EntityType Name="T"><Key><PropertyRef Name="K"/></Key>' +
      '<Property Name="K" Type="Edm.String"/></EntityType></Schema>' +
      "</edmx:DataServices></edmx:Edmx>";
    expect(() => parseEdmx(anonymous)).toThrowError(
      expect.objectContaining({ code: "SERVICE_METADATA_UNPARSEABLE" }),
    );
  });
});

describe("parseEdmx — non-EDMX bodies get a distinguishable error with a sample", () => {
  it("an HTML logon page is SERVICE_METADATA_UNPARSEABLE, not ADT_ERROR", () => {
    let thrown: AbapError | undefined;
    try {
      parseEdmx("<html><body><form name='sapLogonForm'>Log On</form></body></html>");
    } catch (e) {
      thrown = e as AbapError;
    }
    expect(thrown?.code).toBe("SERVICE_METADATA_UNPARSEABLE");
    // The hint must carry a sample of what actually arrived and
    // must close off the retry that cannot help.
    expect(String(thrown?.details.excerpt)).toContain("sapLogonForm");
    expect(thrown?.hint).toMatch(/retry/i);
  });

  it("malformed XML is refused rather than half-parsed", () => {
    expect(() => parseEdmx("<edmx:Edmx><unclosed>")).toThrowError(
      expect.objectContaining({ code: "SERVICE_METADATA_UNPARSEABLE" }),
    );
  });
});

// ====================================================== the $metadata guard ===

describe("assertServiceRuntimePath — the structural half of the P-40 boundary", () => {
  it("accepts a V2 and a V4 $metadata path", () => {
    expect(() => assertServiceRuntimePath("/sap/opu/odata/sap/ZTRAVEL_SRV/$metadata")).not.toThrow();
    expect(() =>
      assertServiceRuntimePath("/sap/opu/odata4/sap/ztravel_svb/srvd/sap/ztravel/0001/$metadata"),
    ).not.toThrow();
  });

  it.each([
    ["an entity set read", "/sap/opu/odata/sap/ZTRAVEL_SRV/Travel"],
    ["a filtered read", "/sap/opu/odata/sap/ZTRAVEL_SRV/Travel?$filter=AgencyID eq '1'"],
    ["a batch", "/sap/opu/odata/sap/ZTRAVEL_SRV/$batch"],
    ["a count", "/sap/opu/odata/sap/ZTRAVEL_SRV/Travel/$count"],
    ["a smuggled query string", "/sap/opu/odata/sap/ZTRAVEL_SRV/$metadata?$expand=Travel"],
    ["a traversal out of the runtime", "/sap/opu/odata/sap/../../bc/adt/$metadata"],
    ["an ADT path", "/sap/bc/adt/oo/classes/zcl_x/source/main/$metadata"],
    ["a metadata segment that is not last", "/sap/opu/odata/sap/Z/$metadata/Travel"],
  ])("refuses %s", (_label, path) => {
    let thrown: AbapError | undefined;
    try {
      assertServiceRuntimePath(path);
    } catch (e) {
      thrown = e as AbapError;
    }
    expect(thrown?.code).toBe("BAD_INPUT");
    expect(thrown?.hint).toMatch(/P-40|contract/i);
  });
});

describe("normaliseBindingName", () => {
  it("upper-cases and accepts namespaced names", () => {
    expect(normaliseBindingName("ztravel_svb")).toBe("ZTRAVEL_SVB");
    expect(normaliseBindingName("/ns/zsvb")).toBe("/NS/ZSVB");
  });

  it("refuses anything that is not an object name", () => {
    for (const bad of ["", "http://x/y", "ZSVB Travel", "ZSVB;DROP"]) {
      expect(() => normaliseBindingName(bad)).toThrowError(
        expect.objectContaining({ code: "BAD_INPUT" }),
      );
    }
  });
});

// ================================================== the resolution chain ===

interface FakeCall {
  url: string;
  qs?: Record<string, string>;
}

/**
 * A connection that answers the three reads from fixtures and records what was
 * asked. Cast rather than subclassed: `readServiceContract` uses exactly
 * `discovery.assertSupported`, `get` and `serviceRuntimeGet`, and a fake that
 * offers only those is a fake that cannot accidentally exercise anything else.
 */
function fakeConn(opts: {
  binding?: string;
  catalogue?: string;
  metadata?: string;
  metadataError?: unknown;
  catalogueError?: unknown;
  cookieJarChanged?: boolean;
  calls?: FakeCall[];
}): AbapConnection {
  const calls = opts.calls ?? [];
  return {
    discovery: { assertSupported: (): void => {} },
    async get(url: string, o: { qs?: Record<string, string> } = {}) {
      calls.push({ url, ...(o.qs === undefined ? {} : { qs: o.qs }) });
      if (url.includes("/businessservices/bindings/")) {
        return { body: opts.binding ?? BINDING, status: 200, headers: {} };
      }
      if (opts.catalogueError !== undefined) throw opts.catalogueError;
      return { body: opts.catalogue ?? CATALOGUE, status: 200, headers: {} };
    },
    async serviceRuntimeGet(path: string) {
      calls.push({ url: path });
      if (opts.metadataError !== undefined) throw opts.metadataError;
      return {
        body: opts.metadata ?? V2,
        status: 200,
        headers: {},
        cookieJarChanged: opts.cookieJarChanged ?? false,
      };
    },
  } as unknown as AbapConnection;
}

describe("readServiceContract — binding → catalogue → $metadata", () => {
  it("resolves the runtime path from the catalogue, not from the binding name", async () => {
    const calls: FakeCall[] = [];
    const sc = await readServiceContract(fakeConn({ calls }), "ztravel_svb");

    expect(sc.metadataPath).toBe("/sap/opu/odata/sap/ZTRAVEL_SRV/$metadata");
    expect(calls[0]?.url).toBe("/sap/bc/adt/businessservices/bindings/ztravel_svb");
    // The catalogue is asked with the ingredients the binding carried — the
    // binding NAME (ZTRAVEL_SVB) is not the service name (ZTRAVEL_SRV), which
    // is the whole reason the catalogue call exists.
    expect(calls[1]?.url).toBe("/sap/bc/adt/businessservices/odatav2");
    expect(calls[1]?.qs).toEqual({
      servicename: "ZTRAVEL_SRV",
      serviceversion: "0001",
      srvdname: "ZTRAVEL_SRVD",
    });
    expect(calls[2]?.url).toBe("/sap/opu/odata/sap/ZTRAVEL_SRV/$metadata");
    expect(calls).toHaveLength(3);
  });

  it("strips the host from the catalogue's absolute serviceUrl", async () => {
    const sc = await readServiceContract(fakeConn({}), "ZTRAVEL_SVB");
    const serialised = JSON.stringify({
      path: sc.metadataPath,
      runtime: sc.runtime,
      binding: sc.binding,
    });
    expect(serialised).not.toContain("sap.invalid");
    expect(serialised).not.toContain("https://");
    expect(sc.runtime.servicePath).toBe("/sap/opu/odata/sap/ZTRAVEL_SRV");
  });

  it("carries the binding facts and the catalogue collections through", async () => {
    const sc = await readServiceContract(fakeConn({}), "ZTRAVEL_SVB");
    expect(sc.binding).toMatchObject({
      name: "ZTRAVEL_SVB",
      bindingType: "ODATA",
      bindingVersion: "V2",
      published: true,
      serviceName: "ZTRAVEL_SRV",
      srvdName: "ZTRAVEL_SRVD",
      packageName: "ZTRAVEL_PKG",
    });
    expect(sc.runtime.collections).toEqual(["Travel", "Booking"]);
  });

  it("agrees on the version across all three signals and reports no disagreement", async () => {
    const sc = await readServiceContract(fakeConn({}), "ZTRAVEL_SVB");
    expect(sc.version).toMatchObject({
      version: "V2",
      fromBinding: "V2",
      fromLinkRel: "http://www.sap.com/categories/odatav2",
      fromDocument: "V2",
    });
    expect(sc.version.disagreement).toBeUndefined();
  });

  it("reports a version disagreement instead of resolving it away", async () => {
    // The binding claims V2, the runtime answered a V4 document. The document
    // wins (it is the bytes being parsed) and the mismatch is surfaced.
    const sc = await readServiceContract(fakeConn({ metadata: V4 }), "ZTRAVEL_SVB");
    expect(sc.version.version).toBe("V4");
    expect(sc.version.disagreement).toMatch(/binding declares V2/);
    expect(sc.version.disagreement).toMatch(/document.*wins/i);
  });

  it("only carries the raw EDMX when the caller asked for it", async () => {
    expect((await readServiceContract(fakeConn({}), "ZTRAVEL_SVB")).raw).toBeUndefined();
    expect(
      (await readServiceContract(fakeConn({}), "ZTRAVEL_SVB", { includeRaw: true })).raw,
    ).toContain("<edmx:Edmx");
  });
});

describe("readServiceContract — every failure is distinguishable", () => {
  it("an unpublished binding is SERVICE_NOT_PUBLISHED, and costs no further request", async () => {
    const calls: FakeCall[] = [];
    let thrown: AbapError | undefined;
    try {
      await readServiceContract(fakeConn({ binding: BINDING_UNPUBLISHED, calls }), "ZUNPUB_SVB");
    } catch (e) {
      thrown = e as AbapError;
    }
    expect(thrown?.code).toBe("SERVICE_NOT_PUBLISHED");
    // The instruction, not just the diagnosis.
    expect(thrown?.hint).toMatch(/Publish the service binding/);
    expect(thrown?.hint).toMatch(/will NOT publish it/);
    expect(thrown?.hint).toMatch(/identical error/);
    // It stopped at the binding read — no catalogue call, no runtime call.
    expect(calls).toHaveLength(1);
  });

  it("an empty catalogue answer is SERVICE_NOT_PUBLISHED too", async () => {
    const empty = '<?xml version="1.0"?><adtcore:serviceList xmlns:adtcore="x"/>';
    await expect(
      readServiceContract(fakeConn({ catalogue: empty }), "ZTRAVEL_SVB"),
    ).rejects.toMatchObject({ code: "SERVICE_NOT_PUBLISHED" });
  });

  it("a 404 from the catalogue is SERVICE_NOT_PUBLISHED, not NOT_FOUND", async () => {
    await expect(
      readServiceContract(fakeConn({ catalogueError: { err: 404, message: "Not Found" } }), "ZX_SVB"),
    ).rejects.toMatchObject({ code: "SERVICE_NOT_PUBLISHED" });
  });

  it("403 on $metadata is SERVICE_METADATA_DENIED and names both causes", async () => {
    let thrown: AbapError | undefined;
    try {
      await readServiceContract(
        fakeConn({ metadataError: { err: 403, message: "Forbidden" } }),
        "ZTRAVEL_SVB",
      );
    } catch (e) {
      thrown = e as AbapError;
    }
    expect(thrown?.code).toBe("SERVICE_METADATA_DENIED");
    expect(thrown?.hint).toMatch(/S_SERVICE/);
    expect(thrown?.hint).toMatch(/SICF/);
    expect(thrown?.hint).toMatch(/Do NOT retry/);
  });

  it("404 on $metadata is SERVICE_METADATA_NOT_FOUND and says it is not a typo", async () => {
    let thrown: AbapError | undefined;
    try {
      await readServiceContract(
        fakeConn({ metadataError: { err: 404, message: "Not Found" } }),
        "ZTRAVEL_SVB",
      );
    } catch (e) {
      thrown = e as AbapError;
    }
    expect(thrown?.code).toBe("SERVICE_METADATA_NOT_FOUND");
    expect(thrown?.hint).toMatch(/NOT a spelling problem/);
  });

  it("a missing binding is NOT_FOUND and points at the SRVD/SRVB confusion", async () => {
    const conn = {
      discovery: { assertSupported: (): void => {} },
      async get(): Promise<never> {
        throw { err: 404, message: "Not Found" };
      },
    } as unknown as AbapConnection;
    let thrown: AbapError | undefined;
    try {
      await readServiceContract(conn, "ZNOPE_SVB");
    } catch (e) {
      thrown = e as AbapError;
    }
    expect(thrown?.code).toBe("NOT_FOUND");
    expect(thrown?.hint).toMatch(/SRVD/);
  });

  it("a non-OData binding is UNSUPPORTED, naming the type it actually is", async () => {
    const sql = BINDING.replace('srvb:type="ODATA"', 'srvb:type="SQL"');
    let thrown: AbapError | undefined;
    try {
      await readServiceContract(fakeConn({ binding: sql }), "ZSQL_SVB");
    } catch (e) {
      thrown = e as AbapError;
    }
    expect(thrown?.code).toBe("UNSUPPORTED");
    expect(thrown?.message).toContain("SQL");
  });
});

// ============================================================== rendering ===

describe("renderServiceResult", () => {
  const load = async (metadata: string, includeRaw = false) =>
    readServiceContract(fakeConn({ metadata }), "ZTRAVEL_SVB", { includeRaw });

  it("contract mode lists every set with keys, counts and capabilities", async () => {
    const sc = await load(V2);
    const out = renderServiceResult(sc, {}, 50_000);
    expect(out.text).toContain("binding: ZTRAVEL_SVB");
    expect(out.text).toContain("odata: V2");
    expect(out.text).toContain("ENTITY SETS");
    expect(out.text).toMatch(/Travel\s+TravelUUID/);
    expect(out.text).toMatch(/Booking\s+TravelUUID,BookingUUID/);
    // Explicit "no" renders as -D; an unstated flag renders as nothing.
    expect(out.text).toMatch(/-D/);
    expect(out.text).toContain("OPERATIONS");
    expect(out.text).toContain("acceptTravel");
  });

  it("states the P-40 boundary in every response, not only in the docs", async () => {
    const sc = await load(V2);
    for (const mode of ["contract", "entity"]) {
      const out = renderServiceResult(sc, { mode, entity: "Travel" }, 50_000);
      expect(out.text).toMatch(/never rows|contract, not its data/i);
      expect(out.text).toContain("P-40");
    }
  });

  it("entity mode expands one set into fields and navigation", async () => {
    const sc = await load(V2);
    const out = renderServiceResult(sc, { mode: "entity", entity: "Travel" }, 50_000);
    expect(out.text).toContain("FIELDS");
    expect(out.text).toContain("NAVIGATION");
    expect(out.text).toMatch(/TravelUUID\s+Guid\s+K/);
    expect(out.text).toMatch(/TotalPrice\s+Decimal\(16,3\)/);
    expect(out.text).toMatch(/to_Booking\s+BookingType\s+\*/);
  });

  it("entity mode accepts the entity TYPE name as well as the SET name", async () => {
    const sc = await load(V2);
    const byType = renderServiceResult(sc, { mode: "entity", entity: "TravelType" }, 50_000);
    expect(byType.text).toContain("TravelUUID");
  });

  it("an unknown entity lists the ones that do exist", async () => {
    const sc = await load(V2);
    let thrown: AbapError | undefined;
    try {
      renderServiceResult(sc, { mode: "entity", entity: "Flights" }, 50_000);
    } catch (e) {
      thrown = e as AbapError;
    }
    expect(thrown?.code).toBe("NOT_FOUND");
    expect(thrown?.hint).toContain("Travel");
    expect(thrown?.hint).toContain("Booking");
  });

  it("entity mode without an entity says which sets it could have been given", async () => {
    const sc = await load(V2);
    let thrown: AbapError | undefined;
    try {
      renderServiceResult(sc, { mode: "entity" }, 50_000);
    } catch (e) {
      thrown = e as AbapError;
    }
    expect(thrown?.code).toBe("BAD_INPUT");
    expect(thrown?.hint).toContain("Travel");
  });

  it("raw mode returns the EDMX and says how much bigger it is", async () => {
    const sc = await load(V2, true);
    const out = renderServiceResult(sc, { mode: "raw" }, 50_000);
    expect(out.text).toContain("<edmx:Edmx");
    expect(out.text).toMatch(/Raw EDMX is \d+ bytes/);
  });

  it("surfaces a discarded runtime cookie as an observed fact", async () => {
    const sc = await readServiceContract(fakeConn({ cookieJarChanged: true }), "ZTRAVEL_SVB");
    expect(renderServiceResult(sc, {}, 50_000).text).toMatch(/discarded it/);
  });

  it("renders a V4 contract through the same renderer", async () => {
    const sc = await load(V4);
    const out = renderServiceResult(sc, {}, 50_000);
    expect(out.text).toContain("odata: V4");
    expect(out.text).toContain("Travel");
    expect(out.text).toContain("Booking");
  });

  /**
   * The compression figure the PR quotes. Printed rather than pinned to a
   * number: the ratio is a property of the service being described, and an
   * assertion on an exact value here would be pinning the fixture, not the
   * behaviour. The floor is asserted because "compressed" has to mean
   * something.
   */
  it("compresses the contract well below the raw EDMX", async () => {
    for (const [label, doc] of [
      ["v2", V2],
      ["v4", V4],
    ] as const) {
      const sc = await load(doc);
      const out = renderServiceResult(sc, {}, 50_000);
      const ratio = compressionRatio(sc, out);
      process.stderr.write(
        `[odata-compression:${label}] ${sc.contract.rawBytes} bytes EDMX -> ` +
          `${out.chars ?? out.text.length} chars rendered (${ratio.toFixed(2)}x)\n`,
      );
      expect(ratio).toBeGreaterThan(1.5);
    }
  });
});

// ========================================================== tool surface ===

function cfg(abapMode: AbapMode): Config {
  return {
    ...ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "TESTUSER",
      password: "secret",
      sid: "TST",
      client: "001",
      toolSurface: "v1",
    }),
    abapMode,
  };
}

/**
 * Listing tools must not open a socket. Registration is pure — the pool
 * connects lazily inside a handler, and no handler is called here — so any
 * request other than the §10.4 system-role probe reaching this client is
 * itself the bug. The probe is answered "nonproductive" via the shared
 * wrapper so this suite makes a visible choice for
 * `test/system-role-probe-guard.test.ts`'s intent sweep.
 */
class ForbiddenClient implements HttpClient {
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    throw new Error(`NETWORK CALL LEAKED: ${String(o.url)}`);
  }
}

async function listTools(abapMode: AbapMode) {
  const srv = createServer(cfg(abapMode), {
    httpClient: routeSystemRoleProbe(new ForbiddenClient(), { answer: "nonproductive" }),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-odata", version: "0.0.0" });
  await Promise.all([client.connect(ct), srv.mcp.connect(st)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe("abap_service — tool surface", () => {
  it("is registered in read-only mode: three GETs, no lock, nothing created", async () => {
    const names = (await listTools("read")).map((t) => t.name);
    expect(names).toContain("abap_service");
  });

  it("is registered in edit and admin too", async () => {
    for (const mode of ["edit", "admin"] as const) {
      expect((await listTools(mode)).map((t) => t.name)).toContain("abap_service");
    }
  });

  it("advertises itself as a read that changes nothing", async () => {
    const tool = (await listTools("read")).find((t) => t.name === "abap_service");
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  it("tells a caller on the tool surface that it cannot read rows", async () => {
    const tool = (await listTools("read")).find((t) => t.name === "abap_service");
    expect(tool?.description).toMatch(/cannot read entity data/i);
    expect(tool?.description).toMatch(/unpublished/i);
  });

  it("takes exactly three parameters, none of which selects data", () => {
    expect(Object.keys(ServiceInput.shape).sort()).toEqual(["binding", "entity", "mode"]);
    expect(Object.keys(serviceInputSchema)).toHaveLength(3);
  });

  /**
   * Measurement, not a ceiling. This repo removed its pinned schema-byte
   * totals on purpose (see `test/tools-v2-budget.test.ts`) — the number is
   * printed so it can be watched, and the loose bound only catches a runaway.
   */
  it("costs a stated number of schema bytes", async () => {
    const tool = (await listTools("read")).find((t) => t.name === "abap_service");
    const bytes = JSON.stringify(tool).length;
    process.stderr.write(`[schema] abap_service ${bytes} bytes\n`);
    expect(bytes).toBeLessThan(3000);
  });
});
