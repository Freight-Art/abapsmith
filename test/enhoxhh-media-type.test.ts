/**
 * `enhoxhhMediaType()` (src/adt/enhancement.ts) and its wiring into
 * `postHookImplementation` (src/adt/enhancement-hook.ts) — issue #178's
 * versioned enhoxhh media-type negotiation.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { Discovery, type CollectionInfo } from "../src/adt/discovery.js";
import { enhoxhhMediaType, ENHOXHH_ACCEPT, ENHOXHH_COLLECTION } from "../src/adt/enhancement.js";
import { ENH_CREATE_PACKAGE } from "../src/adt/enhancement-bridge.js";
import {
  createHookImplementation,
  parseAnchorFullName,
  type HookHostRef,
} from "../src/adt/enhancement-hook.js";
import { clearSharedDiscoveryCacheForTests } from "../src/adt/discovery-cache.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement");
const fixture = (name: string): string => readFileSync(join(FIXTURE_DIR, name), "utf8");

const V2_ONLY = fixture("discovery-enhancements.xml");
const A4H_V3 = fixture("discovery-enhancements-a4h-v3.xml");
const NO_ENHANCEMENTS = fixture("discovery-no-enhancements.xml");
const REAL_415_XML = fixture("enhoxhh-post-v2-415.xml");
// The A4H document with its enhoxhh accept entry downgraded to v1: an older server
// that has never advertised v2.
const V1_ONLY = A4H_V3.replace(
  "application/vnd.sap.adt.enh.enhoxhh.v3+xml",
  "application/vnd.sap.adt.enh.enhoxhh.v1+xml",
);

// ---------------------------------------------------------------------------
// Pure enhoxhhMediaType() unit tests — no I/O, discovery built directly.
// ---------------------------------------------------------------------------

describe("enhoxhhMediaType — pure, no I/O", () => {
  it("never-loaded discovery fails open to ENHOXHH_ACCEPT", () => {
    const d = new Discovery({} as never);
    expect(d.loadState).toBe("never");
    expect(enhoxhhMediaType(d)).toBe(ENHOXHH_ACCEPT);
  });

  it("empty discovery (loaded document, zero collections) also fails open to ENHOXHH_ACCEPT", () => {
    const d = new Discovery({} as never);
    d.loadParsed([]);
    expect(d.loadState).toBe("empty");
    expect(enhoxhhMediaType(d)).toBe(ENHOXHH_ACCEPT);
  });

  it("loaded, only v2 advertised (discovery-enhancements.xml) returns v2 verbatim", () => {
    const d = new Discovery({} as never);
    d.ingestDocument(V2_ONLY);
    expect(d.loadState).toBe("loaded");
    expect(enhoxhhMediaType(d)).toBe("application/vnd.sap.adt.enh.enhoxhh.v2+xml");
  });

  it("loaded, only v1 advertised (A4H document downgraded to v1) falls back to v1 instead of v2", () => {
    expect(V1_ONLY).not.toBe(A4H_V3);
    const d = new Discovery({} as never);
    d.ingestDocument(V1_ONLY);
    expect(d.loadState).toBe("loaded");
    expect(enhoxhhMediaType(d)).toBe("application/vnd.sap.adt.enh.enhoxhh.v1+xml");
  });

  it("loaded, v3 + text/html advertised (discovery-enhancements-a4h-v3.xml) returns v3, not text/html", () => {
    const d = new Discovery({} as never);
    d.ingestDocument(A4H_V3);
    expect(d.loadState).toBe("loaded");
    expect(enhoxhhMediaType(d)).toBe("application/vnd.sap.adt.enh.enhoxhh.v3+xml");
  });

  it("loaded, no enhoxhh collection at all (discovery-no-enhancements.xml) throws UNSUPPORTED naming the v2 type", () => {
    const d = new Discovery({} as never);
    d.ingestDocument(NO_ENHANCEMENTS);
    expect(d.loadState).toBe("loaded");
    let caught: unknown;
    try {
      enhoxhhMediaType(d);
    } catch (e) {
      caught = e;
    }
    expect(isAbapError(caught)).toBe(true);
    const err = caught as AbapError;
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).toContain(ENHOXHH_ACCEPT);
  });

  it("loaded, matching collection present but no versioned entry (hand-built: accept advertises only text/html) throws UNSUPPORTED", () => {
    const d = new Discovery({} as never);
    const collections: CollectionInfo[] = [
      {
        href: "/sap/bc/adt/enhancements/enhoxhh",
        workspace: "Enhancements",
        templates: [],
        accept: ["text/html"],
      },
    ];
    d.loadParsed(collections);
    expect(d.loadState).toBe("loaded");
    let caught: unknown;
    try {
      enhoxhhMediaType(d);
    } catch (e) {
      caught = e;
    }
    expect(isAbapError(caught)).toBe(true);
    const err = caught as AbapError;
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).toContain("text/html");
  });
});

// ---------------------------------------------------------------------------
// Integration — postHookImplementation over a real AbapConnection, routed
// discovery documents, and the real captured 415 fixture.
// ---------------------------------------------------------------------------

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
  statusText = String(status),
): HttpClientResponse => ({ status, statusText, body, headers }) as unknown as HttpClientResponse;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

function combine(
  ...routes: Array<(o: HttpClientOptions) => HttpClientResponse | undefined>
): (o: HttpClientOptions) => HttpClientResponse {
  return (o: HttpClientOptions) => {
    for (const r of routes) {
      const hit = r(o);
      if (hit) return hit;
    }
    throw new Error(`unrouted request: ${(o.method ?? "GET").toUpperCase()} ${o.url}`);
  };
}

function sharedRoute(
  discoveryXml: string,
): (o: HttpClientOptions) => HttpClientResponse | undefined {
  return (o) => {
    if (o.url.includes("/compatibility/graph")) {
      return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
    }
    if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
    if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
    if (o.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    if (o.url.endsWith("/discovery")) return resp(200, discoveryXml, { "content-type": "application/atomsvc+xml" });
    return undefined;
  };
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "ENHOXHH_MEDIA_TYPE_TEST",
    password: "secret",
    sid: "TST",
    client: "001",
    readOnly: false,
  });

async function connected(
  discoveryXml: string,
  extra: (o: HttpClientOptions) => HttpClientResponse | undefined,
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(combine(sharedRoute(discoveryXml), extra));
  const conn = new AbapConnection(cfg(), {
    httpClient: inner,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner };
}

const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [ENH_CREATE_PACKAGE],
    writesLockedOut: false,
    allowEnhancements: true,
    enhanceTargets: "customer",
    originSystems: ["TST"],
  });

const HOST_1: HookHostRef = {
  type: "PROG/P",
  name: "ZMCP_BADI_HOST",
  uri: "/sap/bc/adt/programs/programs/zmcp_badi_host",
};

const AFFECTS = { name: "ZMCP_BADI_HOST", packageName: "ZTARGET_PKG", masterSystem: "TST" };

const CREATE_PARAMS = {
  name: "ZMCP_ENH_C",
  description: "ZMCP recon hook impl",
  host: HOST_1,
  anchor: {
    fullName: parseAnchorFullName("\\PR:ZMCP_BADI_HOST\\FO:COMPUTE\\SE:END\\EI"),
    fullDescription: "Form COMPUTE, End",
  },
  responsible: "DEVELOPER",
  affects: AFFECTS,
  allowEnhancements: true,
  allowSourcePlugins: true,
};

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!e || !isAbapError(e)) throw new Error(`expected an AbapError, got ${String(e)}`);
  return e;
};

beforeEach(() => {
  clearSharedDiscoveryCacheForTests();
});

describe("postHookImplementation — negotiated media type over a real AbapConnection", () => {
  it("sends Content-Type/Accept = the highest version discovery advertises (v3 + text/html fixture)", async () => {
    const { conn, inner } = await connected(A4H_V3, (o) => {
      if (o.url === ENHOXHH_COLLECTION && (o.method ?? "GET").toUpperCase() === "POST") {
        return resp(201, "", {
          etag: "e1",
          location: "/sap/bc/adt/enhancements/enhoxhh/zmcp_enh_c/source/main",
        });
      }
      return undefined;
    });
    await createHookImplementation(conn, allowingGate(), CREATE_PARAMS);
    const postCall = inner.calls.find((c) => c.url === ENHOXHH_COLLECTION);
    expect(postCall).toBeDefined();
    expect(postCall?.headers?.["Content-Type"]).toBe("application/vnd.sap.adt.enh.enhoxhh.v3+xml");
    expect(postCall?.headers?.["Accept"]).toBe("application/vnd.sap.adt.enh.enhoxhh.v3+xml");
  });

  it("sends v2 when discovery advertises only v2 (discovery-enhancements.xml fixture)", async () => {
    const { conn, inner } = await connected(V2_ONLY, (o) => {
      if (o.url === ENHOXHH_COLLECTION && (o.method ?? "GET").toUpperCase() === "POST") {
        return resp(201, "", { etag: "e1", location: "/sap/bc/adt/enhancements/enhoxhh/zmcp_enh_c/source/main" });
      }
      return undefined;
    });
    await createHookImplementation(conn, allowingGate(), CREATE_PARAMS);
    const postCall = inner.calls.find((c) => c.url === ENHOXHH_COLLECTION);
    expect(postCall?.headers?.["Content-Type"]).toBe("application/vnd.sap.adt.enh.enhoxhh.v2+xml");
  });

  it("sends v1 when discovery advertises only v1 (server without enhoxhh v2)", async () => {
    const { conn, inner } = await connected(V1_ONLY, (o) => {
      if (o.url === ENHOXHH_COLLECTION && (o.method ?? "GET").toUpperCase() === "POST") {
        return resp(201, "", { etag: "e1", location: "/sap/bc/adt/enhancements/enhoxhh/zmcp_enh_c/source/main" });
      }
      return undefined;
    });
    await createHookImplementation(conn, allowingGate(), CREATE_PARAMS);
    const postCall = inner.calls.find((c) => c.url === ENHOXHH_COLLECTION);
    expect(postCall?.headers?.["Content-Type"]).toBe("application/vnd.sap.adt.enh.enhoxhh.v1+xml");
    expect(postCall?.headers?.["Accept"]).toBe("application/vnd.sap.adt.enh.enhoxhh.v1+xml");
  });

  it("a discovery document with no enhoxhh collection refuses UNSUPPORTED before any POST", async () => {
    const { conn, inner } = await connected(NO_ENHANCEMENTS, (o) => {
      if (o.url === ENHOXHH_COLLECTION && (o.method ?? "GET").toUpperCase() === "POST") {
        return resp(201, "", { etag: "e1", location: "x" });
      }
      return undefined;
    });
    const err = await catchErr(createHookImplementation(conn, allowingGate(), CREATE_PARAMS));
    expect(err.code).toBe("UNSUPPORTED");
    expect(inner.calls.some((c) => c.url === ENHOXHH_COLLECTION)).toBe(false);
  });

  it("a real captured 415 (SADT_RESOURCE/039, enhoxhh-post-v2-415.xml) thrown by the actual POST is translated to a classified AbapError, not a raw exception", async () => {
    const { conn } = await connected(V2_ONLY, (o) => {
      if (o.url === ENHOXHH_COLLECTION && (o.method ?? "GET").toUpperCase() === "POST") {
        const r = resp(415, REAL_415_XML, { "content-type": "application/xml" }, "Unsupported Media Type");
        throw new HttpClientException("Request failed with status code 415", "415", 415, undefined, o, r);
      }
      return undefined;
    });
    const err = await catchErr(createHookImplementation(conn, allowingGate(), CREATE_PARAMS));
    expect(err.code).toBe("ADT_ERROR");
    expect(err.details.classifiedBy).toBe("unsupported-media-type");
    expect(err.hint).toMatch(/application\/vnd\.sap\.adt\.enh\.enhoxhh\.v2\+xml/);
  });
});
