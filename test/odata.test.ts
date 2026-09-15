/**
 * OData `$metadata` introspection — parser, resolution chain, tool surface.
 *
 * ## Provenance of everything asserted here
 *
 * Two kinds of fixture back this suite. Six are LIVE CAPTURES — byte-exact
 * bytes taken from a real A4H appliance (SAP_BASIS 754) on 2026-09-15,
 * driving the full binding → catalogue → `$metadata` chain for one OData V2
 * service (`/DMO/UI_TRAVEL_U_V2`) and one OData V4 service
 * (`/DMO/UI_TRAVEL_O4_CD`): `test/fixtures/live-captured/965-i82-service-binding-v2.xml`
 * through `970-i82-metadata-v4.xml` (see that directory's `INDEX.md` for the
 * capture log and each file's `.meta.json` sidecar for the exact request).
 * The rest, under `test/fixtures/odata/` and still labelled `SYNTHETIC`
 * inside each file, are hand-written on purpose: they exercise edge cases
 * the six live services above do not happen to exhibit — a dangling
 * navigation `Relationship` with no association, an external
 * `Annotations Target=…` block resolved through a schema alias, and an
 * absolute `serviceUrl` through a `sap.invalid` host (see
 * `test/fixtures/odata/README.md`).
 *
 * An earlier version of this header claimed every fixture here was
 * synthetic, that no live capture existed because "the appliance went
 * down," and that A4H "has no OData V4 binding type at all." All three were
 * wrong — the appliance answered every request in the chain above, on both
 * versions, which is what the six captures and the
 * "parseEdmx — live-captured documents" / "readServiceContract —
 * live-captured chains" blocks below now prove directly.
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
const liveFixture = (name: string): string =>
  readFileSync(join(here, "fixtures", "live-captured", name), "utf8");

const V2 = fixture("SYNTHETIC-v2-metadata.xml");
const V4 = fixture("SYNTHETIC-v4-metadata.xml");
const BINDING = fixture("SYNTHETIC-service-binding.xml");
const BINDING_UNPUBLISHED = fixture("SYNTHETIC-service-binding-unpublished.xml");
const CATALOGUE = fixture("SYNTHETIC-service-catalogue.xml");

// Live captures, A4H (SAP_BASIS 754), 2026-09-15 — see
// test/fixtures/live-captured/INDEX.md ("965-970") and each file's
// .meta.json sidecar for the exact request that produced it.
const LIVE_V2_BINDING = liveFixture("965-i82-service-binding-v2.xml");
const LIVE_V2_CATALOGUE = liveFixture("966-i82-service-catalogue-v2.xml");
const LIVE_V2_METADATA = liveFixture("967-i82-metadata-v2.xml");
const LIVE_V4_BINDING = liveFixture("968-i82-service-binding-v4.xml");
const LIVE_V4_CATALOGUE = liveFixture("969-i82-service-catalogue-v4.xml");
const LIVE_V4_METADATA = liveFixture("970-i82-metadata-v4.xml");

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
// A hand-written document built to the CSDL specification, dense in edge
// cases (a non-obvious annotation alias, a bound action with no import) a
// real service may not happen to combine in one place. That the V4 branch
// also parses genuine SAP bytes is proven separately, below, by
// "parseEdmx — live-captured documents" against
// test/fixtures/live-captured/970-i82-metadata-v4.xml — not by this block.

describe("parseEdmx — OData V4 (SYNTHETIC document)", () => {
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

// ================================== EDMX: live-captured documents ===
//
// These are the tests whose whole point is that the parser has now met real
// SAP bytes, not an approximation of them. 967/970 are the exact EDMX
// responses A4H returned on 2026-09-15 for /DMO/UI_TRAVEL_U_V2 (V2, 27
// entity sets) and /DMO/UI_TRAVEL_O4_CD (V4, 4 entity sets, 6 actions) — see
// test/fixtures/live-captured/INDEX.md.

describe("parseEdmx — live-captured documents", () => {
  const v2 = parseEdmx(LIVE_V2_METADATA);
  const v4 = parseEdmx(LIVE_V4_METADATA);

  it("parses the real V2 $metadata: 27 entity sets, self-described as V2", () => {
    expect(v2.version).toBe("V2");
    expect(v2.versionEvidence).toBe("edmx-version-attribute");
    expect(v2.namespace).toBe("cds_xdmoxtravel_u");
    expect(v2.entitySets).toHaveLength(27);
    // Named sets that actually appear in the response — not the full 27
    // (fourteen of them are the SAP__* framework sets: value help,
    // hierarchy, PDF rendering — not part of the business contract).
    expect(v2.entitySets.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        "Travel",
        "Booking",
        "BookingSupplement",
        "TravelAgency",
        "Airport",
        "Airline",
        "FlightConnection",
        "Passenger",
        "Flight",
        "SupplementCategory",
        "Supplement",
        "TravelStatus",
        "Country",
        "Currency",
      ]),
    );
  });

  it("resolves a real entity set through findEntitySet/findEntityType and reads a real key", () => {
    const travelSet = findEntitySet(v2, "Travel");
    expect(travelSet?.entityType).toBe("cds_xdmoxtravel_u.TravelType");
    const travelType = findEntityType(v2, travelSet?.entityType ?? "");
    // Not "TravelUUID", which is what SYNTHETIC-v2-metadata.xml uses — the
    // real service's key is spelled differently. A hand-written fixture
    // cannot catch that kind of drift; only bytes from the wire can.
    expect(travelType?.keys).toEqual(["TravelID"]);
    expect(travelType?.properties).toHaveLength(18);
  });

  it("parses the real V4 $metadata: 4 entity sets, 6 bound actions, self-described as V4", () => {
    expect(v4.version).toBe("V4");
    expect(v4.versionEvidence).toBe("edmx-version-attribute");
    expect(v4.entitySets.map((s) => s.name).sort()).toEqual([
      "Booking",
      "I_DraftAdministrativeData",
      "I_DraftAdministrativeUser",
      "Travel",
    ]);
    expect(v4.operations).toHaveLength(6);
    expect(v4.operations.every((o) => o.kind === "action")).toBe(true);
    expect(v4.operations.map((o) => o.name).sort()).toEqual([
      "Activate",
      "Discard",
      "Edit",
      "Prepare",
      "Resume",
      "Share",
    ]);
  });

  it("carries real draft navigation — only a genuine RAP draft-enabled service has this shape", () => {
    const travelSet = findEntitySet(v4, "Travel");
    const travelType = findEntityType(v4, travelSet?.entityType ?? "");
    // TravelUuid + IsActiveEntity is a RAP draft key, not something any
    // SYNTHETIC fixture in this repo invents.
    expect(travelType?.keys).toEqual(["TravelUuid", "IsActiveEntity"]);
    const nav = travelType?.navigation ?? [];
    const toDraft = nav.find((n) => n.name === "DraftAdministrativeData");
    expect(toDraft).toMatchObject({ multiplicity: "0..1" });
    expect(toDraft?.unresolved).toBeUndefined();
    expect(nav.find((n) => n.name === "SiblingEntity")).toMatchObject({ multiplicity: "0..1" });
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
  headers?: Record<string, string>;
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
    async get(
      url: string,
      o: { qs?: Record<string, string>; headers?: Record<string, string> } = {},
    ) {
      calls.push({
        url,
        ...(o.qs === undefined ? {} : { qs: o.qs }),
        ...(o.headers === undefined ? {} : { headers: o.headers }),
      });
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
    // The instruction, not just the diagnosis: it names the exact `abap_service`
    // call (op="publish" with confirm echoing the binding name back) rather than
    // just saying "not published".
    expect(thrown?.hint).toMatch(/Publish the service binding/);
    expect(thrown?.hint).toMatch(/"op":"publish"/);
    expect(thrown?.hint).toMatch(/"confirm":"<NAME>"/);
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

// ============================ readServiceContract: live-captured chains ===
//
// End to end against the real bytes: binding (965/968) -> catalogue
// (966/969) -> $metadata (967/970), for the V2 and V4 services captured on
// 2026-09-15. Request shapes (URLs, query strings) are asserted against
// what each .meta.json sidecar recorded as the actual request.

describe("readServiceContract — live-captured chains (965–970)", () => {
  it("resolves the real V2 chain: /DMO/UI_TRAVEL_U_V2 binding -> catalogue -> $metadata", async () => {
    const calls: FakeCall[] = [];
    const sc = await readServiceContract(
      fakeConn({
        binding: LIVE_V2_BINDING,
        catalogue: LIVE_V2_CATALOGUE,
        metadata: LIVE_V2_METADATA,
        calls,
      }),
      "/DMO/UI_TRAVEL_U_V2",
    );

    // 967's own requestUrl (its .meta.json): /sap/opu/odata/DMO/UI_TRAVEL_U_V2/$metadata.
    expect(sc.metadataPath).toBe("/sap/opu/odata/DMO/UI_TRAVEL_U_V2/$metadata");
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe("/sap/bc/adt/businessservices/bindings/%2Fdmo%2Fui_travel_u_v2");
    // 966's requestUrl path, minus the query string (the fake receives qs separately).
    expect(calls[1]?.url).toBe("/sap/bc/adt/businessservices/odatav2/%2FDMO%2FUI_TRAVEL_U_V2");
    expect(calls[1]?.qs).toEqual({
      servicename: "/DMO/UI_TRAVEL_U_V2",
      serviceversion: "0001",
      srvdname: "/DMO/TRAVEL_U",
    });
    expect(calls[2]?.url).toBe(sc.metadataPath);

    expect(sc.version).toMatchObject({ version: "V2", fromBinding: "V2", fromDocument: "V2" });
    expect(sc.version.disagreement).toBeUndefined();
    expect(sc.contract.entitySets).toHaveLength(27);
  });

  it("resolves the real V4 chain: /DMO/UI_TRAVEL_O4_CD binding -> catalogue -> $metadata", async () => {
    const calls: FakeCall[] = [];
    const sc = await readServiceContract(
      fakeConn({
        binding: LIVE_V4_BINDING,
        catalogue: LIVE_V4_CATALOGUE,
        metadata: LIVE_V4_METADATA,
        calls,
      }),
      "/DMO/UI_TRAVEL_O4_CD",
    );

    // 970's own requestUrl.
    expect(sc.metadataPath).toBe(
      "/sap/opu/odata4/dmo/ui_travel_o4_cd/srvd/dmo/ui_travel_o4_cd/0001/$metadata",
    );
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe("/sap/bc/adt/businessservices/bindings/%2Fdmo%2Fui_travel_o4_cd");
    expect(calls[1]?.url).toBe("/sap/bc/adt/businessservices/odatav4/%2FDMO%2FUI_TRAVEL_O4_CD");
    expect(calls[1]?.qs).toEqual({
      servicename: "/DMO/UI_TRAVEL_O4_CD",
      serviceversion: "0001",
      srvdname: "/DMO/UI_TRAVEL_O4_CD",
    });
    expect(calls[2]?.url).toBe(sc.metadataPath);

    expect(sc.version).toMatchObject({ version: "V4", fromBinding: "V4", fromDocument: "V4" });
    expect(sc.version.disagreement).toBeUndefined();
    expect(sc.contract.entitySets).toHaveLength(4);
    expect(sc.contract.operations).toHaveLength(6);
  });

  /**
   * REGRESSION: before readServiceRuntimeInfo learned to fall back to
   * odatav4:serviceGroup, `child(doc, "serviceList")` found nothing in 969
   * (its root is serviceGroup, not serviceList) — so `list(container,
   * "services")` was empty and this call threw SERVICE_NOT_PUBLISHED for a
   * service that genuinely was published. Pinned here against the real
   * catalogue bytes so a future refactor that drops the serviceGroup
   * branch fails this test, not just a live run nobody else can reproduce.
   */
  it("REGRESSION: resolves a service from the V4 catalogue's serviceGroup root, not only serviceList", async () => {
    const sc = await readServiceContract(
      fakeConn({
        binding: LIVE_V4_BINDING,
        catalogue: LIVE_V4_CATALOGUE,
        metadata: LIVE_V4_METADATA,
      }),
      "/DMO/UI_TRAVEL_O4_CD",
    );
    expect(sc.runtime.published).toBe(true);
    expect(sc.runtime.servicePath).toBe(
      "/sap/opu/odata4/dmo/ui_travel_o4_cd/srvd/dmo/ui_travel_o4_cd/0001/",
    );
  });

  // v1 alone answers 406 ExceptionResourceNotAcceptable on this A4H release
  // (verified live 2026-09-15, captures 965/968) — the two-part Accept list
  // is not defensive padding, it is the only thing that works.
  it("pins the v2 Accept header on the binding GET", async () => {
    const calls: FakeCall[] = [];
    await readServiceContract(
      fakeConn({
        binding: LIVE_V2_BINDING,
        catalogue: LIVE_V2_CATALOGUE,
        metadata: LIVE_V2_METADATA,
        calls,
      }),
      "/DMO/UI_TRAVEL_U_V2",
    );
    expect(calls[0]?.headers?.Accept).toContain(
      "application/vnd.sap.adt.businessservices.servicebinding.v2+xml",
    );
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

  it("advertises the WORST-case hints — op=\"publish\" is destructive, not the default read path", async () => {
    const tool = (await listTools("read")).find((t) => t.name === "abap_service");
    // MCP tool annotations are one fixed set per tool, not per call — there
    // is no way to say "read-only, except when op=\"publish\"". So the
    // honest annotation is the most dangerous thing this tool can now do
    // (op="publish" can register an ICF node), not its default op="read"
    // path, which still touches nothing.
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("tells a caller on the tool surface that it cannot read rows", async () => {
    const tool = (await listTools("read")).find((t) => t.name === "abap_service");
    expect(tool?.description).toMatch(/cannot read entity data/i);
    expect(tool?.description).toMatch(/unpublished/i);
  });

  it("takes exactly five parameters: binding, entity, mode, op and confirm", () => {
    expect(Object.keys(ServiceInput.shape).sort()).toEqual([
      "binding",
      "confirm",
      "entity",
      "mode",
      "op",
    ]);
    expect(Object.keys(serviceInputSchema)).toHaveLength(5);
  });

  // Kept as its own assertion, separate from the count above: the count can
  // stay five while a future parameter quietly turns into a row selector
  // (a $filter- or $top-shaped field). This is the property that actually
  // matters — no parameter name that a caller could use to ask for entity
  // rows rather than the contract shape.
  it("none of the five parameters can request entity rows", () => {
    const dataSelectingNames = ["filter", "select", "top", "skip", "expand", "orderby", "search", "count"];
    const keys = Object.keys(ServiceInput.shape).map((k) => k.toLowerCase());
    for (const forbidden of dataSelectingNames) {
      expect(keys).not.toContain(forbidden);
    }
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
