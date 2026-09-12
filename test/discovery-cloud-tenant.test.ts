/**
 * A cloud tenant's reduced ADT discovery set (issue #80/#79) does not throw
 * or misreport `Discovery`.
 *
 * The discovery document below is HAND-BUILT and UNVERIFIED: no SAP BTP ABAP
 * environment tenant was available to capture a real reduced discovery
 * document from. Its purpose is to prove the reduced-set path — fewer
 * collections than an on-premise A4H-style document, no classic dynpro
 * collections, no `$TMP`-style local-package semantics, a restricted ABAP
 * language version — is handled by `Discovery` as designed (every absent
 * collection reports `"unsupported"`, never a throw or `"unknown"` on a
 * loaded inventory). It is NOT an assertion about SAP's actual cloud
 * collection list, which this project has never observed live.
 */
import type { AdtDiscoveryResult } from "abap-adt-api";
import { describe, expect, it } from "vitest";
import { Discovery } from "../src/adt/discovery.js";

/** Minimal shape of the Atom service document the probe parses (matches test/discovery.test.ts's helper). */
function doc(hrefs: string[]): AdtDiscoveryResult[] {
  return [
    {
      title: "ABAP Repository",
      collection: hrefs.map((href) => ({ href, title: href, templateLinks: [] })),
    },
  ] as unknown as AdtDiscoveryResult[];
}

const clientReturning = (raw: AdtDiscoveryResult[]) => ({ adtDiscovery: async () => raw }) as never;

/**
 * Cloud-plausible collections only: no `/sap/bc/adt/programs/*` (classic
 * dynpro), no local-package-only markers, and only the RAP/CDS/ATC/unit-test
 * surface a steampunk tenant is expected to expose.
 */
const CLOUD_HREFS = [
  "/sap/bc/adt/oo/classes",
  "/sap/bc/adt/ddic/ddl/sources",
  "/sap/bc/adt/bo/behaviordefinitions",
  "/sap/bc/adt/businessservices/servicedefinitions",
  "/sap/bc/adt/businessservices/bindings",
  "/sap/bc/adt/repository/informationsystem/search",
  "/sap/bc/adt/abapunit/",
  "/sap/bc/adt/atc/",
];

async function loadedCloud(): Promise<Discovery> {
  const d = new Discovery(clientReturning(doc(CLOUD_HREFS)));
  await d.load();
  return d;
}

describe("Discovery — a reduced cloud-tenant-shaped document", () => {
  it("ingests as loaded, not empty or failed", async () => {
    const d = await loadedCloud();
    expect(d.loadState).toBe("loaded");
    expect(d.isLoaded).toBe(true);
    expect(d.collectionCount).toBe(CLOUD_HREFS.length);
  });

  it("collections present on a cloud tenant report supported", async () => {
    const d = await loadedCloud();
    expect(d.capability("classcomponents")).toBe("supported");
    expect(d.capability("cds.ddls")).toBe("supported");
    expect(d.capability("rap.bdef")).toBe("supported");
    expect(d.capability("rap.srvd")).toBe("supported");
    expect(d.capability("rap.srvb")).toBe("supported");
    expect(d.capability("repository.search")).toBe("supported");
    expect(d.capability("unittest")).toBe("supported");
    expect(d.capability("atc")).toBe("supported");
  });

  it("collections absent from the reduced set report unsupported, not unknown and not a throw", async () => {
    let threw: unknown;
    let d: Discovery;
    try {
      d = await loadedCloud();
      // Full ingest + query sequence a caller would actually run — nothing
      // above this line should be able to throw either.
      expect(d.capability("debugger")).toBe("unsupported");
      expect(d.capability("traces.abaptraces")).toBe("unsupported");
      expect(d.capability("ddic.domains")).toBe("unsupported");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeUndefined();
  });

  it("an empty document is still 'empty', not 'loaded' — a reduced set and a failure are different answers", async () => {
    const d = new Discovery(clientReturning(doc([])));
    await d.load();
    expect(d.loadState).toBe("empty");
    expect(d.loadState).not.toBe("loaded");
    // Unlike the reduced-but-real cloud document above, an empty one must
    // still answer "unknown" (probe not credible), not "unsupported".
    expect(d.capability("atc")).toBe("unknown");
  });
});
