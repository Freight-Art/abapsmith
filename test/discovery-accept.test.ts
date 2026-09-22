/**
 * `CollectionInfo.accept` / `Discovery.ingestDocument()` /
 * `Discovery.acceptedMediaTypes()` — issue #178's discovery-side plumbing
 * for versioned media-type negotiation (e.g. enhoxhh v2 vs v3).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdtDiscoveryResult } from "abap-adt-api";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { Discovery } from "../src/adt/discovery.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { clearSharedDiscoveryCacheForTests } from "../src/adt/discovery-cache.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement");
const fixture = (name: string): string => readFileSync(join(FIXTURE_DIR, name), "utf8");

const V2_ONLY = fixture("discovery-enhancements.xml");
const A4H_V3 = fixture("discovery-enhancements-a4h-v3.xml");
const NO_ENHANCEMENTS = fixture("discovery-no-enhancements.xml");

beforeEach(() => {
  clearSharedDiscoveryCacheForTests();
});

describe("Discovery.ingestDocument() — accept media types", () => {
  it("captures a single accept media type per collection (v2-only fixture)", () => {
    const d = new Discovery({} as never);
    d.ingestDocument(V2_ONLY);

    expect(d.loadState).toBe("loaded");
    expect(d.acceptedMediaTypes("/enhancements/enhoxhh")).toEqual([
      "application/vnd.sap.adt.enh.enhoxhh.v2+xml",
    ]);
  });

  it("captures multiple accept entries in document order (v3 + text/html fixture)", () => {
    const d = new Discovery({} as never);
    d.ingestDocument(A4H_V3);

    expect(d.acceptedMediaTypes("/enhancements/enhoxhh")).toEqual([
      "application/vnd.sap.adt.enh.enhoxhh.v3+xml",
      "text/html",
    ]);
  });

  it("returns undefined for a collection absent from the loaded inventory", () => {
    const d = new Discovery({} as never);
    d.ingestDocument(NO_ENHANCEMENTS);

    expect(d.loadState).toBe("loaded");
    expect(d.acceptedMediaTypes("/enhancements/enhoxhh")).toBeUndefined();
  });

  it("matches by href suffix, case-insensitively", () => {
    const d = new Discovery({} as never);
    d.ingestDocument(V2_ONLY);

    expect(d.acceptedMediaTypes("/ENHANCEMENTS/ENHOXHH")).toEqual([
      "application/vnd.sap.adt.enh.enhoxhh.v2+xml",
    ]);
  });

  it("populates CollectionInfo.accept alongside href/title/workspace/templates", () => {
    const d = new Discovery({} as never);
    d.ingestDocument(V2_ONLY);

    const hit = d.parsedCollections.find((c) => c.href.endsWith("/enhancements/enhoxhh"));
    expect(hit).toBeDefined();
    expect(hit?.title).toBe("Source Code Plugin");
    expect(hit?.workspace).toBe("Enhancements");
    expect(hit?.accept).toEqual(["application/vnd.sap.adt.enh.enhoxhh.v2+xml"]);
    expect(hit?.templates.length).toBeGreaterThan(0);
  });

  it("a collection with no <app:accept> at all gets an empty accept array, not undefined", () => {
    const d = new Discovery({} as never);
    d.ingestDocument(NO_ENHANCEMENTS);

    const hit = d.parsedCollections.find((c) => c.href.endsWith("/bopf/businessobjects/$validation"));
    expect(hit).toBeDefined();
    expect(hit?.accept).toEqual([]);
  });
});

describe("Discovery.ingest() — vendor-shape path never has accept data", () => {
  const doc = (hrefs: string[]): AdtDiscoveryResult[] =>
    [
      { title: "Enhancements", collection: hrefs.map((href) => ({ href, title: href, templateLinks: [] })) },
    ] as unknown as AdtDiscoveryResult[];

  it("always yields accept: [] since the vendor parser drops <app:accept>", () => {
    const d = new Discovery({} as never);
    d.ingest(doc(["/sap/bc/adt/enhancements/enhoxhh"]));

    expect(d.loadState).toBe("loaded");
    expect(d.acceptedMediaTypes("/enhancements/enhoxhh")).toEqual([]);
    expect(d.parsedCollections[0]?.accept).toEqual([]);
  });
});

describe("Discovery.load() — prefers the raw document over adtDiscovery() when httpClient.request exists", () => {
  it("calls httpClient.request(\"/sap/bc/adt/discovery\", ...) and parses accept via ingestDocument", async () => {
    let requestedUrl: string | undefined;
    let requestedConfig: unknown;
    const fakeClient = {
      httpClient: {
        request: async (url: string, config?: unknown) => {
          requestedUrl = url;
          requestedConfig = config;
          return { body: A4H_V3 };
        },
      },
      adtDiscovery: async () => {
        throw new Error("adtDiscovery() must not be called when httpClient.request exists");
      },
    };
    const d = new Discovery(fakeClient as never);
    await d.load();

    expect(requestedUrl).toBe("/sap/bc/adt/discovery");
    expect((requestedConfig as { method?: string } | undefined)?.method).toBe("GET");
    expect(d.loadState).toBe("loaded");
    expect(d.acceptedMediaTypes("/enhancements/enhoxhh")).toEqual([
      "application/vnd.sap.adt.enh.enhoxhh.v3+xml",
      "text/html",
    ]);
  });

  it("falls back to adtDiscovery()+ingest() (accept: []) when httpClient.request is absent", async () => {
    const fakeClient = {
      adtDiscovery: async () =>
        [
          {
            title: "Enhancements",
            collection: [{ href: "/sap/bc/adt/enhancements/enhoxhh", title: "Source Code Plugin", templateLinks: [] }],
          },
        ] as unknown as AdtDiscoveryResult[],
    };
    const d = new Discovery(fakeClient as never);
    await d.load();

    expect(d.loadState).toBe("loaded");
    expect(d.acceptedMediaTypes("/enhancements/enhoxhh")).toEqual([]);
  });
});

describe("Discovery over a real AbapConnection — /sap/bc/adt/discovery routed to the A4H v3 fixture", () => {
  const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
    ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

  const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
  const OK_XML = { "content-type": "application/xml" };

  class FakeAdt implements HttpClient {
    async request(o: HttpClientOptions): Promise<HttpClientResponse> {
      const url = o.url;
      if (url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
      if (url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
      if (url.endsWith("/discovery")) return resp(200, A4H_V3, OK_XML);
      return resp(200, "<settings/>", OK_XML);
    }
  }

  const cfg = (): Config =>
    ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "DISCOVERY_ACCEPT_TEST",
      password: "secret",
      sid: "A4H",
      client: "001",
    });

  const live: AbapConnection[] = [];

  afterEach(() => {
    while (live.length) live.pop()!.dispose();
  });

  it("conn.discovery.acceptedMediaTypes reflects the routed document after connect()", async () => {
    const conn = new AbapConnection(cfg(), {
      httpClient: new FakeAdt(),
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    live.push(conn);
    await conn.connect();

    expect(conn.discovery.loadState).toBe("loaded");
    expect(conn.discovery.acceptedMediaTypes("/enhancements/enhoxhh")).toEqual([
      "application/vnd.sap.adt.enh.enhoxhh.v3+xml",
      "text/html",
    ]);
  });
});
