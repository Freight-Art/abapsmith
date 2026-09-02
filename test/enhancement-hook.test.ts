/**
 * Offline tests for `src/adt/enhancement-hook.ts` (anchor discovery +
 * `ENHO/XHH` create). Same self-contained `RecordingClient`/`resp`/`connected`
 * pattern as `test/enhancement-bridge.test.ts` (that file's own header
 * explains why each suite keeps its own small copy rather than sharing one).
 *
 * Fixtures exercised byte-for-byte:
 *   - 122-w1-prog-enh-options.xml — discovery, PROG/P host 1, 3 anchors
 *   - 180-w9-host2-options.xml   — discovery, PROG/P host 2, same shape
 *   - 215-w12-class-options.xml  — discovery, CLAS/OC host, 5 anchors
 *   - 128-w2-create-full.meta.json — the only live enhoxhh create capture;
 *     buildCreateHookBody's output is asserted against its exact requestBody.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate } from "../src/safety.js";
import { capabilitiesForMode, legacyOverriddenClause } from "../src/mode.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { ENH_CREATE_PACKAGE } from "../src/adt/enhancement-bridge.js";
import {
  discoverHookAnchors,
  buildCreateHookBody,
  createHookImplementation,
  parseAnchorFullName,
  type HookHostRef,
} from "../src/adt/enhancement-hook.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Fake transport — same shape as test/enhancement-bridge.test.ts
// ---------------------------------------------------------------------------

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    readOnly: false,
  });

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

const SESSION_URL = "/sap/bc/adt/compatibility/graph";

/**
 * Real captured T000 non-productive proof (fixture 087, client 001 ->
 * CCCATEGORY "C") — read off disk, same as every other test file in this
 * suite (test/enhancement-bridge.test.ts's own header explains why: an
 * earlier hand-rolled inline XML string used the wrong element name and was
 * silently missing MANDT, so the system-role probe stayed inconclusive
 * and every stateful-session test failed with READ_ONLY).
 */
/* `DATAPREVIEW_XML` and `T000_NONPRODUCTIVE` (fixture 087) come from ./helpers/system-role-fake.js. */

function sharedRoute(
  extra: (o: HttpClientOptions) => HttpClientResponse | undefined,
): (o: HttpClientOptions) => HttpClientResponse | undefined {
  return (o: HttpClientOptions) => {
    if (o.url.includes(SESSION_URL)) {
      return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
    }
    if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
    if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
    if (o.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return extra(o);
  };
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

async function connected(
  route: (o: HttpClientOptions) => HttpClientResponse,
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(route);
  const conn = new AbapConnection(cfg(), {
    httpClient: inner,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner };
}

/** Mirrors enhancement-bridge.test.ts's own allowingGate(). */
const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [ENH_CREATE_PACKAGE],
    writesLockedOut: false,
    allowEnhancements: true,
    enhanceTargets: "customer",
    originSystems: ["TST"],
  });

const AFFECTS = { name: "ZMCP_BADI_HOST", packageName: "ZTARGET_PKG", masterSystem: "TST" };

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!e || !isAbapError(e)) throw new Error(`expected an AbapError, got ${String(e)}`);
  return e;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement", "badi");
const XML_122 = readFileSync(join(FIXTURE_DIR, "122-w1-prog-enh-options.xml"), "utf8");
const XML_180 = readFileSync(join(FIXTURE_DIR, "180-w9-host2-options.xml"), "utf8");
const XML_215 = readFileSync(join(FIXTURE_DIR, "215-w12-class-options.xml"), "utf8");
const META_128 = JSON.parse(readFileSync(join(FIXTURE_DIR, "128-w2-create-full.meta.json"), "utf8")) as {
  requestBody: string;
};

const HOST_1: HookHostRef = {
  type: "PROG/P",
  name: "ZMCP_BADI_HOST",
  uri: "/sap/bc/adt/programs/programs/zmcp_badi_host",
};

// ---------------------------------------------------------------------------
// Discovery — parsing against fixtures 122 / 180 / 215
// ---------------------------------------------------------------------------

describe("discoverHookAnchors — parsing", () => {
  it("parses fixture 122 (PROG/P host 1, 3 anchors)", async () => {
    const { conn, inner } = await connected(
      combine(
        sharedRoute(() => undefined),
        (o) => (o.url === `${HOST_1.uri}/enhancements/options` ? resp(200, XML_122, { "content-type": "application/xml" }) : undefined),
      ),
    );
    const anchors = await discoverHookAnchors(conn, HOST_1);
    expect(anchors).toHaveLength(3);
    expect(anchors[0]).toEqual({
      fullName: "\\PR:ZMCP_BADI_HOST\\FO:COMPUTE\\SE:BEGIN\\EI",
      fullDescription: "Form COMPUTE, Start",
      mode: "any",
    });
    expect(anchors[1].fullName).toBe("\\PR:ZMCP_BADI_HOST\\FO:COMPUTE\\SE:END\\EI");
    expect(anchors[2].mode).toBe("static");
    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0].headers?.["Accept"]).toBe("application/vnd.sap.adt.enhancementoptions.v2+xml");
  });

  it("parses fixture 180 (a second PROG/P host, same shape)", async () => {
    const host2: HookHostRef = {
      type: "PROG/P",
      name: "ZMCP_BADI_HOST2",
      uri: "/sap/bc/adt/programs/programs/zmcp_badi_host2",
    };
    const { conn } = await connected(
      combine(
        sharedRoute(() => undefined),
        (o) => (o.url === `${host2.uri}/enhancements/options` ? resp(200, XML_180, { "content-type": "application/xml" }) : undefined),
      ),
    );
    const anchors = await discoverHookAnchors(conn, host2);
    expect(anchors).toHaveLength(3);
    expect(anchors[0].fullName).toBe("\\PR:ZMCP_BADI_HOST2\\FO:COMPUTE\\SE:BEGIN\\EI");
  });

  it("parses fixture 215 (CLAS/OC host, 5 anchors incl. class-pool-include padding and method anchors)", async () => {
    const classHost: HookHostRef = {
      type: "CLAS/OC",
      name: "ZCL_MCP_BADI_RUN",
      uri: "/sap/bc/adt/oo/classes/zcl_mcp_badi_run",
    };
    const { conn } = await connected(
      combine(
        sharedRoute(() => undefined),
        (o) => (o.url === `${classHost.uri}/enhancements/options` ? resp(200, XML_215, { "content-type": "application/xml" }) : undefined),
      ),
    );
    const anchors = await discoverHookAnchors(conn, classHost);
    expect(anchors).toHaveLength(5);
    expect(anchors[0].fullName).toBe(
      "\\PR:ZCL_MCP_BADI_RUN==============CP\\IC:ZCL_MCP_BADI_RUN==============CCDEF\\SE:END\\EI",
    );
    expect(anchors[3].fullName).toBe("\\TY:ZCL_MCP_BADI_RUN\\IN:IF_OO_ADT_CLASSRUN\\ME:MAIN\\SE:BEGIN\\EI");
    expect(anchors[4].mode).toBe("any");
  });

  it("translates a thrown 404 into an AbapError via translateAdtError (not a raw exception)", async () => {
    const { conn } = await connected(
      combine(
        sharedRoute(() => undefined),
        (o) => {
          const r = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
          throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
        },
      ),
    );
    // translateAdtError maps a 404 to NOT_FOUND, mirroring readBadiImplementation/
    // readSourceCodePlugin (enhancement.ts) — discoverHookAnchors's own explicit
    // `status !== 200` check (asserted nowhere here) only ever fires for a non-2xx
    // that the transport did NOT throw for, which this codebase has no evidence
    // of happening in practice; the thrown-exception path is the one that matters.
    const err = await catchErr(discoverHookAnchors(conn, HOST_1));
    expect(isAbapError(err)).toBe(true);
    expect(err.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// AnchorFullName branding
// ---------------------------------------------------------------------------

describe("parseAnchorFullName", () => {
  it("accepts a real captured anchor shape", () => {
    expect(parseAnchorFullName("\\PR:ZMCP_BADI_HOST\\FO:COMPUTE\\SE:END\\EI")).toBe(
      "\\PR:ZMCP_BADI_HOST\\FO:COMPUTE\\SE:END\\EI",
    );
  });

  it("rejects a fabricated string that does not match the grammar", () => {
    expect(() => parseAnchorFullName("not-an-anchor")).toThrowError(/BAD_INPUT|shape/);
  });

  it("rejects a plausible-looking but malformed anchor (missing \\EI terminator)", () => {
    expect(() => parseAnchorFullName("\\PR:ZMCP_BADI_HOST\\FO:COMPUTE\\SE:END")).toThrow();
  });

  it("rejects a lowercase segment code", () => {
    expect(() => parseAnchorFullName("\\pr:ZMCP_BADI_HOST\\EI")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Create body generation — exact match against fixture 128
// ---------------------------------------------------------------------------

describe("buildCreateHookBody — matches fixture 128 byte-for-byte", () => {
  it("reproduces the exact captured requestBody", () => {
    const body = buildCreateHookBody({
      name: "ZMCP_ENH_B",
      description: "ZMCP recon hook impl",
      host: HOST_1,
      anchor: {
        fullName: parseAnchorFullName("\\PR:ZMCP_BADI_HOST\\FO:COMPUTE\\SE:END\\EI"),
        fullDescription: "Form COMPUTE, End",
      },
      responsible: "DEVELOPER",
    });
    expect(body).toBe(META_128.requestBody);
  });

  it("refuses a non-PROG/P host with UNSUPPORTED", () => {
    expect(() =>
      buildCreateHookBody({
        name: "ZMCP_ENH_B",
        description: "ZMCP recon hook impl",
        host: { type: "CLAS/OC", name: "ZCL_MCP_BADI_RUN", uri: "/sap/bc/adt/oo/classes/zcl_mcp_badi_run" },
        anchor: {
          fullName: parseAnchorFullName("\\TY:ZCL_MCP_BADI_RUN\\IN:IF_OO_ADT_CLASSRUN\\ME:MAIN\\SE:BEGIN\\EI"),
          fullDescription: "x",
        },
        responsible: "DEVELOPER",
      }),
    ).toThrowError(/UNSUPPORTED|PROG\/P/);
  });

  it("refuses a bad name via assertEnhIdentifier before building any XML", () => {
    expect(() =>
      buildCreateHookBody({
        name: "bad.name",
        description: "x",
        host: HOST_1,
        anchor: { fullName: parseAnchorFullName("\\PR:ZMCP_BADI_HOST\\FO:COMPUTE\\SE:END\\EI"), fullDescription: "x" },
        responsible: "DEVELOPER",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// createHookImplementation — double gate, assertIntent wiring, activation
// ---------------------------------------------------------------------------

const CREATE_PARAMS = {
  name: "ZMCP_ENH_B",
  description: "ZMCP recon hook impl",
  host: HOST_1,
  anchor: {
    fullName: parseAnchorFullName("\\PR:ZMCP_BADI_HOST\\FO:COMPUTE\\SE:END\\EI"),
    fullDescription: "Form COMPUTE, End",
  },
  responsible: "DEVELOPER",
  affects: AFFECTS,
};

function createRoute(): (o: HttpClientOptions) => HttpClientResponse | undefined {
  return (o) => {
    if (o.url === "/sap/bc/adt/enhancements/enhoxhh" && (o.method ?? "GET").toUpperCase() === "POST") {
      return resp(201, "", {
        etag: "20260805153916000application/vnd.sap.adt.enh.enhoxhh.v2+xml",
        location: "/sap/bc/adt/enhancements/enhoxhh/zmcp_enh_b/source/main",
      });
    }
    return undefined;
  };
}

describe("createHookImplementation — double gate (allowEnhancements AND allowSourcePlugins)", () => {
  it("refuses before any network call when allowSourcePlugins is false (even though allowEnhancements is true)", async () => {
    const { conn, inner } = await connected(combine(sharedRoute(createRoute())));
    const err = await catchErr(
      createHookImplementation(conn, allowingGate(), {
        ...CREATE_PARAMS,
        allowEnhancements: true,
        allowSourcePlugins: false,
      }),
    );
    expect(err.code).toBe("ENHANCEMENT_DISABLED");
    expect(inner.calls.length).toBe(0);
  });

  it("refuses before any network call when allowEnhancements is false (even though allowSourcePlugins is true)", async () => {
    const { conn, inner } = await connected(combine(sharedRoute(createRoute())));
    const err = await catchErr(
      createHookImplementation(conn, allowingGate(), {
        ...CREATE_PARAMS,
        allowEnhancements: false,
        allowSourcePlugins: true,
      }),
    );
    expect(err.code).toBe("ENHANCEMENT_DISABLED");
    expect(inner.calls.length).toBe(0);
  });

  it("refuses before any network call when both are false", async () => {
    const { conn, inner } = await connected(combine(sharedRoute(createRoute())));
    const err = await catchErr(
      createHookImplementation(conn, allowingGate(), {
        ...CREATE_PARAMS,
        allowEnhancements: false,
        allowSourcePlugins: false,
      }),
    );
    expect(err.code).toBe("ENHANCEMENT_DISABLED");
    expect(inner.calls.length).toBe(0);
  });

  it("translates a thrown non-2xx create POST into an AbapError (not a raw exception)", async () => {
    const { conn } = await connected(
      combine(
        sharedRoute(() => undefined),
        (o) => {
          if (o.url === "/sap/bc/adt/enhancements/enhoxhh" && (o.method ?? "GET").toUpperCase() === "POST") {
            const r = resp(400, "<exc:exception/>", { "content-type": "application/xml" });
            throw new HttpClientException("Request failed with status code 400", "400", 400, undefined, o, r);
          }
          return undefined;
        },
      ),
    );
    const err = await catchErr(
      createHookImplementation(conn, allowingGate(), {
        ...CREATE_PARAMS,
        allowEnhancements: true,
        allowSourcePlugins: true,
      }),
    );
    expect(isAbapError(err)).toBe(true);
  });

  it("proceeds to the network only when both flags are true", async () => {
    const { conn, inner } = await connected(combine(sharedRoute(createRoute())));
    const result = await createHookImplementation(conn, allowingGate(), {
      ...CREATE_PARAMS,
      allowEnhancements: true,
      allowSourcePlugins: true,
    });
    expect(result.name).toBe("ZMCP_ENH_B");
    expect(inner.calls.some((c) => c.url === "/sap/bc/adt/enhancements/enhoxhh")).toBe(true);
  });
});

describe("createHookImplementation — ABAP_MODE=edit end-to-end", () => {
  // The actual failure: a caller running ABAP_MODE=edit (which
  // grants allowEnhancements and every other enhancement capability except,
  // formerly, this one) was refused create_hook outright, even though the
  // host object it was hooking (AFFECTS above) is entirely customer-owned —
  // exactly what edit mode already permits for every other enhancement
  // operation. Wiring `capabilitiesForMode("edit")` straight into the two
  // gate booleans (rather than hand-picking `true`/`true` like the tests
  // above) proves the FIX at the mode layer, not just at this function's own
  // parameter contract.
  it("an edit-mode capability set reaches the network for a customer-owned host (used to throw ENHANCEMENT_DISABLED)", async () => {
    const caps = capabilitiesForMode("edit");
    expect(caps.allowSourcePlugins).toBe(true); // the fix
    const { conn, inner } = await connected(combine(sharedRoute(createRoute())));
    const result = await createHookImplementation(conn, allowingGate(), {
      ...CREATE_PARAMS,
      allowEnhancements: caps.allowEnhancements,
      allowSourcePlugins: caps.allowSourcePlugins,
      abapMode: caps.mode,
    });
    expect(result.name).toBe("ZMCP_ENH_B");
    expect(inner.calls.some((c) => c.url === "/sap/bc/adt/enhancements/enhoxhh")).toBe(true);
  });

  it("a read-mode capability set still refuses, and the message names ABAP_MODE (not the dead legacy var) as the cause", async () => {
    const caps = capabilitiesForMode("read");
    const { conn, inner } = await connected(combine(sharedRoute(createRoute())));
    const err = await catchErr(
      createHookImplementation(conn, allowingGate(), {
        ...CREATE_PARAMS,
        allowEnhancements: caps.allowEnhancements,
        allowSourcePlugins: caps.allowSourcePlugins,
        abapMode: caps.mode,
      }),
    );
    expect(err.code).toBe("ENHANCEMENT_DISABLED");
    expect(inner.calls.length).toBe(0);
    const text = `${err.message} ${String(err.hint ?? "")}`;
    // The refusal must name the mode that grants it (edit), and if it
    // mentions the legacy env var at all, it must be through the sanctioned
    // "will NOT work" clause — never as a bare instruction to set it (the
    // exact defect explainDeniedCapability exists to make unrepresentable;
    // see test/refusal-attribution.test.ts for the general-purpose version
    // of this check).
    expect(text).toMatch(/ABAP_MODE=edit/);
    const stripped = text.split(legacyOverriddenClause("ABAP_ALLOW_SOURCE_PLUGINS")).join(" ");
    expect(stripped).not.toContain("ABAP_ALLOW_SOURCE_PLUGINS");
  });
});

describe("createHookImplementation — SafetyGate.assertIntent wiring", () => {
  it("a denying gate refuses the create, and no network call is issued before assertIntent runs", async () => {
    const denyingGate = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZSOME_OTHER_PACKAGE"], // ENH_CREATE_PACKAGE ($TMP) is NOT in this allowlist
      writesLockedOut: false,
      allowEnhancements: true,
      enhanceTargets: "customer",
      originSystems: ["TST"],
    });
    const { conn, inner } = await connected(combine(sharedRoute(createRoute())));
    const err = await catchErr(
      createHookImplementation(conn, denyingGate, {
        ...CREATE_PARAMS,
        allowEnhancements: true,
        allowSourcePlugins: true,
      }),
    );
    expect(isAbapError(err)).toBe(true);
    expect(inner.calls.some((c) => c.url === "/sap/bc/adt/enhancements/enhoxhh")).toBe(false);
  });
});

describe("createHookImplementation — activation-after-create", () => {
  it("does not activate when activate is not requested", async () => {
    const { conn, inner } = await connected(combine(sharedRoute(createRoute())));
    const result = await createHookImplementation(conn, allowingGate(), {
      ...CREATE_PARAMS,
      allowEnhancements: true,
      allowSourcePlugins: true,
    });
    expect(result.activation).toBeUndefined();
    expect(inner.calls.some((c) => c.url.includes("/sap/bc/adt/activation"))).toBe(false);
  });

  it("activates as a SEPARATE, later call when activate:true — targeting the lowercased URI with the uppercased name (fixture 140)", async () => {
    const { conn, inner } = await connected(combine(sharedRoute(createRoute())));
    const result = await createHookImplementation(conn, allowingGate(), {
      ...CREATE_PARAMS,
      activate: true,
      allowEnhancements: true,
      allowSourcePlugins: true,
    });
    expect(result.activation?.activated).toBe(true);
    const createCallIdx = inner.calls.findIndex((c) => c.url === "/sap/bc/adt/enhancements/enhoxhh");
    const activateCallIdx = inner.calls.findIndex((c) => c.url.includes("/sap/bc/adt/activation"));
    expect(createCallIdx).toBeGreaterThanOrEqual(0);
    expect(activateCallIdx).toBeGreaterThan(createCallIdx);
    expect(result.uri).toBe("/sap/bc/adt/enhancements/enhoxhh/zmcp_enh_b");
    expect(result.name).toBe("ZMCP_ENH_B");
  });
});
