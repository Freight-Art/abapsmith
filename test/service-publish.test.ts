/**
 * `abap_service` `op="publish"`/`op="unpublish"` — the ADT business-services
 * publish job that registers or deregisters a service binding's OData
 * service as an ICF node (`src/tools/service.ts#abapServicePublish`,
 * `src/adt/odata.ts#runPublishJob`).
 *
 * ## What this suite does NOT prove
 *
 * Every test here runs against a fake `AbapConnection` — no network, no live
 * appliance. The publish/unpublish POST itself (`/sap/bc/adt/businessservices/
 * odatav{2,4}/(un)publishjobs`) has NEVER been executed against a live SAP
 * system for this issue. Its request shape (path, query string, headers,
 * `adtcore:objectReferences` body, the V4-only `adtcore:type="SCGR"`) is
 * derived from `src/adt/odata.ts`'s own construction of it, which in turn was
 * built from the ADT client library's own implementation
 * (`node_modules/abap-adt-api/build/api/cds.js` for V2,
 * `node_modules/abap-adt-api/build/api/rapgenerator.js` for V4) and the
 * documented endpoint shape — not from a captured wire response. Nothing
 * below should be read as "verified" for the publish path; it is "matches
 * what the source builds", which is a materially weaker claim.
 *
 * The binding/catalogue/`$metadata` XML shapes reused in the "response
 * shape" tests below are hand-written, modelled on
 * `test/fixtures/odata/SYNTHETIC-service-binding.xml` and
 * `SYNTHETIC-service-catalogue.xml` (themselves synthetic, per that
 * directory's own header) — not copies of a fixture file, since this file
 * may only touch itself.
 */
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AbapConnection } from "../src/adt/connection.js";
import { planUndo } from "../src/adt/undo.js";
import { Journal, systemKey, type JournalConfig, type JournalEntry } from "../src/journal.js";
import { SafetyGate } from "../src/safety.js";
import { abapServicePublish, type ServiceInput, type ServiceJournalDeps } from "../src/tools/service.js";

const MAX_CHARS = 60_000;

// ------------------------------------------------------------------ gates ---

/** Writes and the publish ceiling are both open, under `ABAP_MODE=admin`. */
function openPublishGate(): SafetyGate {
  return new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowServicePublish: true,
    abapMode: "admin",
  });
}

/** Fully closed: read-only, no packages, no legacy flags — refuses BOTH the write and publish ceilings. */
function closedGate(): SafetyGate {
  return new SafetyGate({ readOnly: true, allowPackages: [] });
}

/** `ABAP_MODE=edit`: ordinary writes are on, but `allowServicePublish` is not implied by it. */
function editModeGate(): SafetyGate {
  return new SafetyGate({ readOnly: false, allowPackages: ["*"], abapMode: "edit" });
}

/** Admin mode with the publish ceiling open — the SAP-namespace rule is the only thing left to refuse a namespaced binding. */
function adminGate(): SafetyGate {
  return new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowServicePublish: true,
    abapMode: "admin",
  });
}

// -------------------------------------------------------------- fixtures ---

const FAKE_CFG = { sid: "A4H", url: "http://a4h.example:50000", client: "001" };

/**
 * A published OData V2 binding. Element/attribute names follow
 * `SYNTHETIC-service-binding.xml`'s shape (itself modelled on
 * abap-adt-api's `parseServiceBinding`).
 */
const BINDING_V2 = `<?xml version="1.0" encoding="UTF-8"?>
<srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings"
                     xmlns:adtcore="http://www.sap.com/adt/core"
                     xmlns:atom="http://www.w3.org/2005/Atom"
                     srvb:published="true"
                     adtcore:name="ZTRAVEL_SVB" adtcore:type="SRVB/SVB"
                     adtcore:description="Travel service binding">
 <atom:link href="/sap/bc/adt/businessservices/odatav2" rel="http://www.sap.com/categories/odatav2" type="application/xml" title="OData V2 service catalogue"/>
 <adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/ztravel_pkg" adtcore:type="DEVC/K" adtcore:name="ZTRAVEL_PKG"/>
 <srvb:services srvb:name="ZTRAVEL_SRV">
  <srvb:content srvb:version="0001" srvb:releaseState="notReleased">
   <srvb:serviceDefinition adtcore:uri="/sap/bc/adt/ddic/srvd/sources/ztravel_srvd" adtcore:type="SRVD/SRV" adtcore:name="ZTRAVEL_SRVD"/>
  </srvb:content>
 </srvb:services>
 <srvb:binding srvb:type="ODATA" srvb:version="V2" srvb:category="0" srvb:allowedAction="UNPUBLISH">
  <srvb:implementation adtcore:name=""/>
 </srvb:binding>
</srvb:serviceBinding>`;

/** Same binding, never published: no catalogue link at all, `published="false"`. */
const BINDING_V2_UNPUBLISHED = `<?xml version="1.0" encoding="UTF-8"?>
<srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings"
                     xmlns:adtcore="http://www.sap.com/adt/core"
                     xmlns:atom="http://www.w3.org/2005/Atom"
                     srvb:published="false"
                     adtcore:name="ZTRAVEL_SVB" adtcore:type="SRVB/SVB"
                     adtcore:description="Not yet published">
 <atom:link href="/sap/bc/adt/vit/wb/object_type/srvbsvb/object_name/ZTRAVEL_SVB" rel="self" type="application/vnd.sap.sapgui" title="Representation in SAP Gui"/>
 <adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/ztravel_pkg" adtcore:type="DEVC/K" adtcore:name="ZTRAVEL_PKG"/>
 <srvb:services srvb:name="ZTRAVEL_SRV">
  <srvb:content srvb:version="0001" srvb:releaseState="notReleased">
   <srvb:serviceDefinition adtcore:uri="/sap/bc/adt/ddic/srvd/sources/ztravel_srvd" adtcore:type="SRVD/SRV" adtcore:name="ZTRAVEL_SRVD"/>
  </srvb:content>
 </srvb:services>
 <srvb:binding srvb:type="ODATA" srvb:version="V2" srvb:category="0" srvb:allowedAction="PUBLISH">
  <srvb:implementation adtcore:name=""/>
 </srvb:binding>
</srvb:serviceBinding>`;

/** A published OData V4 binding — different catalogue link relation, `srvb:version="V4"`. */
const BINDING_V4 = `<?xml version="1.0" encoding="UTF-8"?>
<srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings"
                     xmlns:adtcore="http://www.sap.com/adt/core"
                     xmlns:atom="http://www.w3.org/2005/Atom"
                     srvb:published="true"
                     adtcore:name="ZTRAVEL_O4" adtcore:type="SRVB/SVB"
                     adtcore:description="Travel V4 service binding">
 <atom:link href="/sap/bc/adt/businessservices/odatav4" rel="http://www.sap.com/categories/odatav4" type="application/xml" title="OData V4 service catalogue"/>
 <adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/ztravel_pkg" adtcore:type="DEVC/K" adtcore:name="ZTRAVEL_PKG"/>
 <srvb:services srvb:name="ZTRAVEL_O4_SRV">
  <srvb:content srvb:version="0001" srvb:releaseState="notReleased">
   <srvb:serviceDefinition adtcore:uri="/sap/bc/adt/ddic/srvd/sources/ztravel_o4_srvd" adtcore:type="SRVD/SRV" adtcore:name="ZTRAVEL_O4_SRVD"/>
  </srvb:content>
 </srvb:services>
 <srvb:binding srvb:type="ODATA" srvb:version="V4" srvb:category="0" srvb:allowedAction="UNPUBLISH">
  <srvb:implementation adtcore:name=""/>
 </srvb:binding>
</srvb:serviceBinding>`;

/** A binding in a reserved SAP namespace (leading `/`) — `isSapNamespace` fires on this regardless of the publish ceiling. */
const BINDING_SAP_NAMESPACE = `<?xml version="1.0" encoding="UTF-8"?>
<srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings"
                     xmlns:adtcore="http://www.sap.com/adt/core"
                     xmlns:atom="http://www.w3.org/2005/Atom"
                     srvb:published="true"
                     adtcore:name="/DMO/UI_TRAVEL_U_V2" adtcore:type="SRVB/SVB"
                     adtcore:description="DMO travel service binding">
 <atom:link href="/sap/bc/adt/businessservices/odatav2" rel="http://www.sap.com/categories/odatav2" type="application/xml" title="OData V2 service catalogue"/>
 <srvb:services srvb:name="/DMO/UI_TRAVEL_U_V2">
  <srvb:content srvb:version="0001" srvb:releaseState="notReleased">
   <srvb:serviceDefinition adtcore:uri="/sap/bc/adt/ddic/srvd/sources/dmo_travel_srvd" adtcore:type="SRVD/SRV" adtcore:name="/DMO/UI_TRAVEL_U_V2"/>
  </srvb:content>
 </srvb:services>
 <srvb:binding srvb:type="ODATA" srvb:version="V2" srvb:category="0" srvb:allowedAction="UNPUBLISH">
  <srvb:implementation adtcore:name=""/>
 </srvb:binding>
</srvb:serviceBinding>`;

/** Same as {@link BINDING_V2} but the service name (`srvb:services/@name`) contains a space — outside `SERVICE_NAME_CHARS`. */
const BINDING_BAD_SERVICE_NAME = `<?xml version="1.0" encoding="UTF-8"?>
<srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings"
                     xmlns:adtcore="http://www.sap.com/adt/core"
                     xmlns:atom="http://www.w3.org/2005/Atom"
                     srvb:published="true"
                     adtcore:name="ZBAD_SVB" adtcore:type="SRVB/SVB"
                     adtcore:description="Bad service name">
 <atom:link href="/sap/bc/adt/businessservices/odatav2" rel="http://www.sap.com/categories/odatav2" type="application/xml" title="OData V2 service catalogue"/>
 <srvb:services srvb:name="Z BAD SRV">
  <srvb:content srvb:version="0001" srvb:releaseState="notReleased">
   <srvb:serviceDefinition adtcore:uri="/sap/bc/adt/ddic/srvd/sources/zbad_srvd" adtcore:type="SRVD/SRV" adtcore:name="ZBAD_SRVD"/>
  </srvb:content>
 </srvb:services>
 <srvb:binding srvb:type="ODATA" srvb:version="V2" srvb:category="0" srvb:allowedAction="UNPUBLISH">
  <srvb:implementation adtcore:name=""/>
 </srvb:binding>
</srvb:serviceBinding>`;

/** Catalogue answer for the V2 binding above — used only by the best-effort runtime pre-read and the post-publish reread. */
const CATALOGUE_V2 = `<?xml version="1.0" encoding="UTF-8"?>
<adtcore:serviceList xmlns:adtcore="http://www.sap.com/adt/core">
 <adtcore:services repositoryId="SRVD" serviceId="ZTRAVEL_SRV" serviceVersion="0001"
                   serviceUrl="/sap/opu/odata/sap/ZTRAVEL_SRV"
                   published="true" created="true">
  <adtcore:serviceInformation name="ZTRAVEL_SRV" version="0001" url="/sap/opu/odata/sap/ZTRAVEL_SRV">
   <adtcore:collection name="Travel"/>
  </adtcore:serviceInformation>
 </adtcore:services>
</adtcore:serviceList>`;

/** Minimal V2 EDMX — one entity type/set, enough for `parseEdmx` and `renderServiceResult` to succeed. */
const MINIMAL_EDMX_V2 = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" xmlns:sap="http://www.sap.com/Protocols/SAPData">
 <edmx:DataServices m:DataServiceVersion="2.0">
  <Schema Namespace="ZTRAVEL_SRV" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
   <EntityType Name="TravelType">
    <Key><PropertyRef Name="TravelUUID"/></Key>
    <Property Name="TravelUUID" Type="Edm.Guid" Nullable="false"/>
   </EntityType>
   <EntityContainer Name="ZTRAVEL_SRV_Entities" m:IsDefaultEntityContainer="true">
    <EntitySet Name="Travel" EntityType="ZTRAVEL_SRV.TravelType"/>
   </EntityContainer>
  </Schema>
 </edmx:DataServices>
</edmx:Edmx>`;

/** `SEVERITY`/`SHORT_TEXT` envelope shape `runPublishJob`'s `findStatusNode` walks — modelled on the module comment's description of the (live-captured) V2 answer. */
function publishJobResponse(severity: string, shortText: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml">
 <asx:values>
  <DATA>
   <SEVERITY>${severity}</SEVERITY>
   <SHORT_TEXT>${shortText}</SHORT_TEXT>
  </DATA>
 </asx:values>
</asx:abap>`;
}

const OK_RESPONSE = publishJobResponse("OK", "Service published successfully");
const WARNING_RESPONSE = publishJobResponse("Warning", "Service was already active; re-published");
const ERROR_RESPONSE = publishJobResponse("Error", "Service name already registered by another binding");

// ------------------------------------------------------------- fake conn ---

interface FakeCall {
  method: "GET" | "POST";
  url: string;
  qs?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
}

interface FakeConnOpts {
  binding?: string;
  bindingError?: unknown;
  catalogue?: string;
  catalogueError?: unknown;
  metadata?: string;
  metadataError?: unknown;
  postResponse?: string;
  postError?: unknown;
  calls?: FakeCall[];
}

/**
 * A connection that answers the binding/catalogue/`$metadata`/publish-job
 * requests `abapServicePublish` can issue, and records everything it was
 * asked. Cast rather than subclassed, same idiom as `test/odata.test.ts`'s
 * `fakeConn` — offering only the methods the code under test actually calls
 * is what makes an unexpected call fail loudly instead of silently no-op-ing.
 */
function fakeConn(opts: FakeConnOpts = {}): AbapConnection {
  const calls = opts.calls ?? [];
  return {
    cfg: FAKE_CFG,
    discovery: { assertSupported: (): void => {} },
    async get(
      url: string,
      o: { qs?: Record<string, string>; headers?: Record<string, string> } = {},
    ) {
      calls.push({
        method: "GET",
        url,
        ...(o.qs === undefined ? {} : { qs: o.qs }),
        ...(o.headers === undefined ? {} : { headers: o.headers }),
      });
      if (url.includes("/businessservices/bindings/")) {
        if (opts.bindingError !== undefined) throw opts.bindingError;
        return { body: opts.binding ?? BINDING_V2, status: 200, headers: {} };
      }
      // Catalogue lookup.
      if (opts.catalogueError !== undefined) throw opts.catalogueError;
      return { body: opts.catalogue ?? CATALOGUE_V2, status: 200, headers: {} };
    },
    async post(
      url: string,
      o: { qs?: Record<string, string>; headers?: Record<string, string>; body?: string } = {},
    ) {
      calls.push({
        method: "POST",
        url,
        ...(o.qs === undefined ? {} : { qs: o.qs }),
        ...(o.headers === undefined ? {} : { headers: o.headers }),
        ...(o.body === undefined ? {} : { body: o.body }),
      });
      if (opts.postError !== undefined) throw opts.postError;
      return { body: opts.postResponse ?? OK_RESPONSE, status: 200, headers: {} };
    },
    async serviceRuntimeGet(pathArg: string) {
      calls.push({ method: "GET", url: pathArg });
      if (opts.metadataError !== undefined) throw opts.metadataError;
      return {
        body: opts.metadata ?? MINIMAL_EDMX_V2,
        status: 200,
        headers: {},
        cookieJarChanged: false,
      };
    },
  } as unknown as AbapConnection;
}

/** Minimal `ServiceInput`; only `binding`/`confirm` ever vary here. */
function input(binding: string, confirm?: string): ServiceInput {
  return { binding, mode: undefined, entity: undefined, op: undefined, confirm };
}

// ---------------------------------------------------------------- journal --

const jcfg = (dir: string, over: Partial<JournalConfig> = {}): JournalConfig => ({
  dir,
  enabled: true,
  maxEntries: 200,
  maxAgeDays: 30,
  ...over,
});

describe("abap_service publish/unpublish", () => {
  let tmp: string;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "abapsmith-service-publish-"));
    warn = vi.fn();
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  const deps = (journal?: Journal): ServiceJournalDeps => ({
    journal: journal ?? new Journal(jcfg(tmp), "A4H"),
    cfg: FAKE_CFG,
    warn: warn as unknown as (msg: string) => void,
  });

  const written = async (): Promise<JournalEntry[]> => await new Journal(jcfg(tmp), "A4H").list();

  const only = async (what: string): Promise<JournalEntry> => {
    const all = await written();
    const summary = all.map((e) => `${e.operation} ${e.object.name} ${e.outcome}`);
    expect(summary, `exactly one journal entry on disk: ${what}`).toHaveLength(1);
    return all[0]!;
  };

  const warnings = (): string[] => warn.mock.calls.map((c) => String(c[0]));

  // -------------------------------------------------------------- dry run --

  describe("dry run (no confirm)", () => {
    it("mutates nothing, and names both the armed call and the gate verdict", async () => {
      const calls: FakeCall[] = [];
      const res = await abapServicePublish(
        fakeConn({ calls }),
        input("ZTRAVEL_SVB"),
        "publish",
        MAX_CHARS,
        openPublishGate(),
        deps(),
      );

      expect(calls.some((c) => c.method === "POST")).toBe(false);
      expect(await written()).toEqual([]);
      // The armed call `publishDryRun` builds is exactly this JSON shape.
      expect(res.text).toContain(JSON.stringify({ binding: "ZTRAVEL_SVB", op: "publish", confirm: "ZTRAVEL_SVB" }));
      expect(res.text).toContain("gate: allowed");
      expect(res.text).toMatch(/DRY RUN — nothing was published or unpublished/);
    });

    it("still answers when the ceiling refuses — a dry run must explain a refusal, not just fail", async () => {
      const calls: FakeCall[] = [];
      const res = await abapServicePublish(
        fakeConn({ calls }),
        input("ZTRAVEL_SVB"),
        "publish",
        MAX_CHARS,
        closedGate(),
        deps(),
      );

      expect(calls.some((c) => c.method === "POST")).toBe(false);
      expect(await written()).toEqual([]);
      expect(res.text).toContain("gate: refused");
      expect(res.text).toMatch(/The safety gate refuses this publish/);
    });
  });

  // ---------------------------------------------------------- confirm echo --

  describe("confirm echo", () => {
    it("a mismatched confirm is refused as BAD_INPUT before any request beyond the binding read", async () => {
      const calls: FakeCall[] = [];
      await expect(
        abapServicePublish(
          fakeConn({ calls }),
          input("ZTRAVEL_SVB", "SOME_OTHER_NAME"),
          "publish",
          MAX_CHARS,
          openPublishGate(),
          deps(),
        ),
      ).rejects.toMatchObject({ code: "BAD_INPUT" });

      expect(calls.some((c) => c.method === "POST")).toBe(false);
      expect(await written()).toEqual([]);
    });

    it("a confirm differing only by case and surrounding whitespace is accepted — assertConfirm compares trim().toUpperCase()", async () => {
      const calls: FakeCall[] = [];
      const res = await abapServicePublish(
        fakeConn({ calls }),
        input("ZTRAVEL_SVB", "  ztravel_svb  "),
        "publish",
        MAX_CHARS,
        openPublishGate(),
        deps(),
      );

      expect(calls.some((c) => c.method === "POST" && /publishjobs$/.test(c.url))).toBe(true);
      expect(res.text).not.toContain("BAD_INPUT");
    });
  });

  // -------------------------------------------------------------- ceilings --

  describe("ceilings", () => {
    it("a read-only server refuses BEFORE any mutating request, naming both the write and the publish ceiling", async () => {
      const calls: FakeCall[] = [];
      await expect(
        abapServicePublish(
          fakeConn({ calls }),
          input("ZTRAVEL_SVB", "ZTRAVEL_SVB"),
          "publish",
          MAX_CHARS,
          closedGate(),
          deps(),
        ),
      ).rejects.toMatchObject({
        code: "READ_ONLY",
        message: expect.stringContaining("Publishing needs both of them"),
        details: expect.objectContaining({
          rule: "read-only default (publishing also needs the service-publish ceiling)",
        }),
      });

      // Legacy config (no ABAP_MODE set here): the cause names both env vars directly.
      await expect(
        abapServicePublish(
          fakeConn({ calls }),
          input("ZTRAVEL_SVB", "ZTRAVEL_SVB"),
          "publish",
          MAX_CHARS,
          closedGate(),
          deps(),
        ),
      ).rejects.toMatchObject({
        message: expect.stringMatching(/ABAP_ALLOW_WRITE/),
      });
      await expect(
        abapServicePublish(
          fakeConn({ calls }),
          input("ZTRAVEL_SVB", "ZTRAVEL_SVB"),
          "publish",
          MAX_CHARS,
          closedGate(),
          deps(),
        ),
      ).rejects.toMatchObject({
        message: expect.stringMatching(/ABAP_ALLOW_SERVICE_PUBLISH/),
      });

      expect(calls.some((c) => c.method === "POST")).toBe(false);
      expect(await written()).toEqual([]);
    });

    it("ABAP_MODE=edit refuses with the service-publish-specific ceiling, not the ordinary write one, and its hint names the lever that opens it", async () => {
      const calls: FakeCall[] = [];
      await expect(
        abapServicePublish(
          fakeConn({ calls }),
          input("ZTRAVEL_SVB", "ZTRAVEL_SVB"),
          "publish",
          MAX_CHARS,
          editModeGate(),
          deps(),
        ),
      ).rejects.toMatchObject({
        code: "READ_ONLY",
        message: expect.stringContaining("publishing a service binding is a separate ceiling"),
        details: expect.objectContaining({ rule: "service publish ceiling" }),
        hint: expect.stringContaining("ABAP_MODE=admin"),
      });

      expect(calls.some((c) => c.method === "POST")).toBe(false);
      expect(await written()).toEqual([]);
    });

    it("ABAP_MODE=admin with the publish ceiling open still refuses an SAP-namespace binding — SAFETY_DENIED, before any mutating request", async () => {
      const calls: FakeCall[] = [];
      await expect(
        abapServicePublish(
          fakeConn({ calls, binding: BINDING_SAP_NAMESPACE }),
          input("/DMO/UI_TRAVEL_U_V2", "/DMO/UI_TRAVEL_U_V2"),
          "publish",
          MAX_CHARS,
          adminGate(),
          deps(),
        ),
      ).rejects.toMatchObject({
        code: "SAFETY_DENIED",
        message: expect.stringContaining("reserved SAP namespace"),
        details: expect.objectContaining({ rule: "SAP namespace denied" }),
      });

      expect(calls.some((c) => c.method === "POST")).toBe(false);
      expect(await written()).toEqual([]);
    });
  });

  // ------------------------------------------------------- the job request --

  describe("the job request itself", () => {
    it("V2 publish POSTs to the V2 publishjobs path with servicename/serviceversion query params and the documented Accept", async () => {
      const calls: FakeCall[] = [];
      await abapServicePublish(
        fakeConn({ calls, catalogueError: { status: 404 } }),
        input("ZTRAVEL_SVB", "ZTRAVEL_SVB"),
        "publish",
        MAX_CHARS,
        openPublishGate(),
        deps(),
      );

      const post = calls.find((c) => c.method === "POST");
      expect(post?.url).toBe("/sap/bc/adt/businessservices/odatav2/publishjobs");
      expect(post?.qs).toEqual({ servicename: "ZTRAVEL_SRV", serviceversion: "0001" });
      expect(post?.headers).toEqual({ Accept: "application/*", "Content-Type": "application/xml" });
      expect(post?.body).toContain('<adtcore:objectReference adtcore:name="ZTRAVEL_SRV"/>');
      expect(post?.body).not.toContain("SCGR");
    });

    it("V2 unpublish POSTs to the V2 unpublishjobs path", async () => {
      const calls: FakeCall[] = [];
      await abapServicePublish(
        fakeConn({ calls, catalogueError: { status: 404 } }),
        input("ZTRAVEL_SVB", "ZTRAVEL_SVB"),
        "unpublish",
        MAX_CHARS,
        openPublishGate(),
        deps(),
      );

      const post = calls.find((c) => c.method === "POST");
      expect(post?.url).toBe("/sap/bc/adt/businessservices/odatav2/unpublishjobs");
    });

    it("V4 publish POSTs to the V4 publishjobs path with no query string, the V4 Accept, and adtcore:type=\"SCGR\" on the object reference", async () => {
      const calls: FakeCall[] = [];
      await abapServicePublish(
        fakeConn({ calls, binding: BINDING_V4, catalogueError: { status: 404 } }),
        input("ZTRAVEL_O4", "ZTRAVEL_O4"),
        "publish",
        MAX_CHARS,
        openPublishGate(),
        deps(),
      );

      const post = calls.find((c) => c.method === "POST");
      expect(post?.url).toBe("/sap/bc/adt/businessservices/odatav4/publishjobs");
      expect(post?.qs).toBeUndefined();
      expect(post?.headers).toEqual({
        Accept: "application/xml, application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.StatusMessage",
        "Content-Type": "application/xml",
      });
      expect(post?.body).toContain('<adtcore:objectReference adtcore:name="ZTRAVEL_O4_SRV" adtcore:type="SCGR"/>');
    });

    it("a binding whose service name falls outside SERVICE_NAME_CHARS is refused BAD_INPUT before any POST", async () => {
      const calls: FakeCall[] = [];
      await expect(
        abapServicePublish(
          fakeConn({ calls, binding: BINDING_BAD_SERVICE_NAME, catalogueError: { status: 404 } }),
          input("ZBAD_SVB", "ZBAD_SVB"),
          "publish",
          MAX_CHARS,
          openPublishGate(),
          deps(),
        ),
      ).rejects.toMatchObject({ code: "BAD_INPUT" });

      expect(calls.some((c) => c.method === "POST")).toBe(false);
    });
  });

  // ---------------------------------------------------------- server fails --

  describe("failures from the server", () => {
    it("HTTP 403 from the publish job is SERVICE_PUBLISH_FAILED", async () => {
      await expect(
        abapServicePublish(
          fakeConn({ postError: { status: 403 }, catalogueError: { status: 404 } }),
          input("ZTRAVEL_SVB", "ZTRAVEL_SVB"),
          "publish",
          MAX_CHARS,
          openPublishGate(),
          deps(),
        ),
      ).rejects.toMatchObject({ code: "SERVICE_PUBLISH_FAILED" });
    });

    it("a 200 response with SEVERITY starting \"error\" is SERVICE_PUBLISH_FAILED, carrying the server's SHORT_TEXT", async () => {
      await expect(
        abapServicePublish(
          fakeConn({ postResponse: ERROR_RESPONSE, catalogueError: { status: 404 } }),
          input("ZTRAVEL_SVB", "ZTRAVEL_SVB"),
          "publish",
          MAX_CHARS,
          openPublishGate(),
          deps(),
        ),
      ).rejects.toMatchObject({
        code: "SERVICE_PUBLISH_FAILED",
        message: expect.stringContaining("Service name already registered by another binding"),
      });
    });

    it("a non-403 HTTP failure from the publish job is ADT_ERROR", async () => {
      await expect(
        abapServicePublish(
          fakeConn({ postError: { status: 500 }, catalogueError: { status: 404 } }),
          input("ZTRAVEL_SVB", "ZTRAVEL_SVB"),
          "publish",
          MAX_CHARS,
          openPublishGate(),
          deps(),
        ),
      ).rejects.toMatchObject({ code: "ADT_ERROR" });
    });

    it("a \"warning\" severity is a success, and its text is surfaced to the caller", async () => {
      const res = await abapServicePublish(
        fakeConn({ postResponse: WARNING_RESPONSE, catalogueError: { status: 404 } }),
        input("ZTRAVEL_SVB", "ZTRAVEL_SVB"),
        "publish",
        MAX_CHARS,
        openPublishGate(),
        deps(),
      );

      expect(res.text).toMatch(/severity=warning/);
      expect(res.text).toContain("Service was already active; re-published");
    });
  });

  // --------------------------------------------------------------- journal --

  describe("journal", () => {
    it("a successful publish writes exactly one irreversible entry, with no trSource — there is no transport request behind a publish", async () => {
      const calls: FakeCall[] = [];
      await abapServicePublish(
        fakeConn({ calls, catalogueError: { status: 404 } }),
        input("ZTRAVEL_SVB", "ZTRAVEL_SVB"),
        "publish",
        MAX_CHARS,
        openPublishGate(),
        deps(),
      );

      const e = await only("the service-publish entry");
      expect(e.operation).toBe("service-publish");
      expect(e.irreversible).toBe(true);
      expect(e.existedBefore).toBe(true);
      expect(e.tool).toBe("abap_service");
      expect(e.trSource).toBeUndefined();
      expect(e.outcome).toBe("succeeded");
    });

    it("a successful unpublish writes exactly one irreversible entry, operation service-unpublish", async () => {
      await abapServicePublish(
        fakeConn({ catalogueError: { status: 404 } }),
        input("ZTRAVEL_SVB", "ZTRAVEL_SVB"),
        "unpublish",
        MAX_CHARS,
        openPublishGate(),
        deps(),
      );

      const e = await only("the service-unpublish entry");
      expect(e.operation).toBe("service-unpublish");
      expect(e.irreversible).toBe(true);
      expect(e.trSource).toBeUndefined();
    });

    it("beforeCapture is \"captured\" when the runtime pre-read succeeds, and \"failed\" when it does not", async () => {
      const okConn = fakeConn({});
      await abapServicePublish(okConn, input("ZTRAVEL_SVB", "ZTRAVEL_SVB"), "publish", MAX_CHARS, openPublishGate(), deps());
      const captured = await only("the entry from a working pre-read");
      expect(captured.beforeCapture).toBe("captured");

      await fsp.rm(tmp, { recursive: true, force: true });
      await fsp.mkdir(tmp, { recursive: true });

      const failConn = fakeConn({ catalogueError: { status: 404 } });
      await abapServicePublish(failConn, input("ZTRAVEL_SVB", "ZTRAVEL_SVB"), "publish", MAX_CHARS, openPublishGate(), deps());
      const failed = await only("the entry from a failing pre-read");
      expect(failed.beforeCapture).toBe("failed");
    });

    it("the journal entry is written BEFORE the POST — a journal that cannot be written refuses the call and never POSTs", async () => {
      const blocked = path.join(tmp, "blocked");
      await fsp.writeFile(blocked, "not a directory");
      const blockedJournal = new Journal(jcfg(path.join(blocked, "A4H")), "A4H");

      const calls: FakeCall[] = [];
      await expect(
        abapServicePublish(
          fakeConn({ calls, catalogueError: { status: 404 } }),
          input("ZTRAVEL_SVB", "ZTRAVEL_SVB"),
          "publish",
          MAX_CHARS,
          openPublishGate(),
          deps(blockedJournal),
        ),
      ).rejects.toMatchObject({ code: "JOURNAL_IO" });

      expect(calls.some((c) => c.method === "POST")).toBe(false);
    });

    it("a POST that throws leaves the journal entry pending, with a warning naming the binding — a failed call is not proof the job never reached the system", async () => {
      await expect(
        abapServicePublish(
          fakeConn({ postError: { status: 500 }, catalogueError: { status: 404 } }),
          input("ZTRAVEL_SVB", "ZTRAVEL_SVB"),
          "publish",
          MAX_CHARS,
          openPublishGate(),
          deps(),
        ),
      ).rejects.toMatchObject({ code: "ADT_ERROR" });

      const e = await only("the entry left behind by the failed POST");
      expect(e.outcome).toBe("pending");
      const w = warnings().join("\n");
      expect(w).toMatch(/^\[abapsmith\] WARNING:/m);
      expect(w).toContain("ZTRAVEL_SVB");
      expect(w).toMatch(/stays `pending`/);
    });

    it("undo of a service-publish entry is refused, naming op=\"unpublish\" as the deliberate remedy", async () => {
      const journal = new Journal(jcfg(tmp), "A4H");
      const conn = fakeConn({});
      const before = 0;

      const entry = await journal.begin({
        operation: "service-publish",
        object: { name: "ZTRAVEL_SVB", type: "SRVB/SVB", uri: "/sap/bc/adt/businessservices/bindings/ztravel_svb", package: "ZTRAVEL_PKG" },
        existedBefore: true,
        beforeCapture: "captured",
        irreversible: true,
        systemKey: systemKey(FAKE_CFG),
        tool: "abap_service",
      });
      await journal.finish(entry!.id, { outcome: "succeeded" });
      const readBack = (await journal.get(entry!.id)) as JournalEntry;

      const plan = await planUndo(conn, journal, readBack);
      expect(plan.undoable).toBe(false);
      expect(plan.blocker).toBe(
        "publishing a service binding changes the system's runtime surface (an ICF node under " +
          "/sap/opu/odata*), not the object's source, so there is no before-image to write back; " +
          'call abap_service op="unpublish" confirm=<binding> instead — a deliberate, separately ' +
          "confirmed act, not an automatic undo",
      );
      expect(plan.blockerForceable).toBeFalsy();

      // Zero network calls: the refusal is decided locally, never routed to the wire.
      const calls: FakeCall[] = [];
      const connWithCalls = fakeConn({ calls });
      await planUndo(connWithCalls, journal, readBack);
      expect(calls.length).toBe(before);
    });

    it("undo of a service-unpublish entry is refused, naming op=\"publish\" as the deliberate remedy", async () => {
      const journal = new Journal(jcfg(tmp), "A4H");
      const conn = fakeConn({});

      const entry = await journal.begin({
        operation: "service-unpublish",
        object: { name: "ZTRAVEL_SVB", type: "SRVB/SVB", uri: "/sap/bc/adt/businessservices/bindings/ztravel_svb", package: "ZTRAVEL_PKG" },
        existedBefore: true,
        beforeCapture: "captured",
        irreversible: true,
        systemKey: systemKey(FAKE_CFG),
        tool: "abap_service",
      });
      await journal.finish(entry!.id, { outcome: "succeeded" });
      const readBack = (await journal.get(entry!.id)) as JournalEntry;

      const plan = await planUndo(conn, journal, readBack);
      expect(plan.undoable).toBe(false);
      expect(plan.blocker).toBe(
        "unpublishing a service binding changes the system's runtime surface, not the object's " +
          "source, so there is no before-image to restore; " +
          'call abap_service op="publish" confirm=<binding> instead — a deliberate, separately ' +
          "confirmed act, not an automatic undo",
      );
      expect(plan.blockerForceable).toBeFalsy();
    });
  });

  // ---------------------------------------------------------- response shape --

  describe("response shape", () => {
    it("a successful publish reports what became reachable: the binding, the service, and the $metadata path — the actual renderServiceResult header, not an invented field", async () => {
      const res = await abapServicePublish(
        fakeConn({}),
        input("ZTRAVEL_SVB", "ZTRAVEL_SVB"),
        "publish",
        MAX_CHARS,
        openPublishGate(),
        deps(),
      );

      expect(res.text).toContain("binding: ZTRAVEL_SVB");
      expect(res.text).toContain("service: ZTRAVEL_SRV");
      expect(res.text).toContain("path: /sap/opu/odata/sap/ZTRAVEL_SRV/$metadata");
      expect(res.text).toMatch(/was just published to the OData V2 service runtime/);
    });

    it("a successful unpublish reports the outcome directly — there is no contract left to re-read", async () => {
      const res = await abapServicePublish(
        fakeConn({ catalogueError: { status: 404 } }),
        input("ZTRAVEL_SVB", "ZTRAVEL_SVB"),
        "unpublish",
        MAX_CHARS,
        openPublishGate(),
        deps(),
      );

      expect(res.text).toMatch(/was unpublished from the OData service runtime/);
    });

    it("when the post-publish contract reread fails, the publish is still reported as succeeded, with the reread failure noted separately", async () => {
      const res = await abapServicePublish(
        fakeConn({ catalogueError: { status: 404 } }),
        input("ZTRAVEL_SVB", "ZTRAVEL_SVB"),
        "publish",
        MAX_CHARS,
        openPublishGate(),
        deps(),
      );

      expect(res.text).toMatch(/was published to the OData service runtime/);
      expect(res.text).toMatch(/Reading the updated contract back failed/);
    });
  });
});
