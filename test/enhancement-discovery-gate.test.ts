/**
 * Wiring `src/adt/discovery.ts`'s tri-state capability
 * model into two real call sites that were previously unguarded:
 *
 *  1. `writeEnhancementDescription` (`src/adt/enhancement-write.ts`) now opens
 *     with `conn.discovery.assertEnhancementCapable(spec.bareCollection, "PUT")`
 *     — a purpose-built gate that existed with zero callers before this fix.
 *     It is deliberately fail-CLOSED: a genuinely-unsupported collection, a
 *     collection missing from the live inventory, AND a never-loaded/failed
 *     probe all refuse, because a wrong PUT verb has previously dumped the
 *     server session on this release (see discovery.ts's own doc comment).
 *     There is no live "unsupported" static verdict for the PUT verb today
 *     (only POST has one, on `enhoxh`/`enhsxs` — see
 *     `ENHANCEMENT_VERB_CAPABILITIES`), so the two refusal cases exercised
 *     below are both routed through `enhancementCapability`'s "unknown"
 *     branch (missing collection, and failed probe) — both of which
 *     `assertEnhancementCapable` still refuses, which is exactly its
 *     documented fail-closed contract.
 *
 *  2. `readBadiImplementation` / `readSourceCodePlugin` / `readEnhancementSpot`
 *     (`src/adt/enhancement.ts`) now open with
 *     `conn.discovery.assertSupported("enhancements", "<label>")` — the plain
 *     `Feature` gate. Unlike the write gate, this is fail-OPEN on "unknown":
 *     a never-loaded/failed probe does not block a read (the GET itself is
 *     the authoritative answer), only a probe that genuinely loaded and
 *     confirmed the `/enhancements` family absent refuses.
 *
 * All three tri-states (supported / unsupported / unknown) are exercised for
 * both call sites below. Offline only — a fake `HttpClient` is injected
 * through `ConnectionOptions.httpClient`, following the same `FakeAdt`/
 * `resp`/`cfg`/`connected`/`catchErr` idiom as test/enhancement-write.test.ts
 * and test/write-toctou.test.ts (copied in verbatim per this codebase's
 * one-small-copy-per-test-file convention, not imported).
 *
 * Fixtures:
 *  - test/fixtures/enhancement/discovery-enhancements.xml — the Enhancements
 *    workspace only, excerpted verbatim from a real A4H capture.
 *    "loaded" + enhoxh/enhoxhh/enhsxs all present -> capability("enhancements")
 *    === "supported".
 *  - test/fixtures/enhancement/discovery-no-enhancements.xml — the BOPF
 *    workspace only, from the same real capture. "loaded" but no
 *    /enhancements marker anywhere -> capability("enhancements") ===
 *    "unsupported", and enhancementCapability("enhoxh", "PUT") === "unknown"
 *    (collection absent from the live inventory).
 *  - test/fixtures/enhancement/354-enhoxh-no-filter.xml — a real ENHO/XH GET
 *    response body (name=ZMCP_ENH_BADI), reused from
 *    test/enhancement-write.test.ts, for the read-path "supported"/"unknown"
 *    (fail-open) cases that need a real decodable document.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import { writeEnhancementDescription } from "../src/adt/enhancement-write.js";
import { readBadiImplementation } from "../src/adt/enhancement.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Copied from test/enhancement-write.test.ts — see that file for the full
// rationale on each piece.
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement");
const fixture = (name: string): string => readFileSync(join(FIXTURES_DIR, name), "utf8");

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
  headers?: Record<string, unknown>;
}

type Route = (r: Recorded) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body, headers: o.headers as Record<string, unknown> | undefined };
    this.calls.push(rec);
    const res = this.route(rec);
    if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
    return res;
  }
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

const DISCOVERY_ENHANCEMENTS_XML = fixture("discovery-enhancements.xml");
const DISCOVERY_NO_ENHANCEMENTS_XML = fixture("discovery-no-enhancements.xml");

type DiscoveryMode = "supported" | "unsupported" | "unknown";

/** Builds the `/discovery` route for each of the three tri-states this file
 *  tests: "supported" (real Enhancements workspace present), "unsupported"
 *  (a real, different workspace present, Enhancements absent) and "unknown"
 *  (the probe itself fails — a 500 — which `AbapConnection.connect()`
 *  swallows non-fatally, per src/adt/connection.ts, leaving discovery in
 *  state "failed"). */
function discoveryRouteFor(mode: DiscoveryMode): Route {
  return (r: Recorded) => {
    if (!r.url.endsWith("/discovery")) return undefined;
    if (mode === "supported") return resp(200, DISCOVERY_ENHANCEMENTS_XML, OK_XML);
    if (mode === "unsupported") return resp(200, DISCOVERY_NO_ENHANCEMENTS_XML, OK_XML);
    return resp(500, "<error/>", OK_XML);
  };
}

function baseRoute(mode: DiscoveryMode): Route {
  const discoveryRoute = discoveryRouteFor(mode);
  return (r: Recorded) => {
    const d = discoveryRoute(r);
    if (d) return d;
    if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
    if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
    return undefined;
  };
}

async function connected(mode: DiscoveryMode, extra: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const base = baseRoute(mode);
  const adt = new FakeAdt((r) => base(r) ?? extra(r));
  const conn = new AbapConnection(cfg(), {
    // client "001" is the captured non-productive customising client
    // (see test/helpers/system-role-fake.ts), so the probe answer and the
    // logon client agree and connect() can attribute a T000 row to it.
    httpClient: routeSystemRoleProbe(adt, { answer: "nonproductive" }),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

// ---------------------------------------------------------------------------
// Candidate 1 — writeEnhancementDescription's discovery gate
// (assertEnhancementCapable), fail-CLOSED.
// ---------------------------------------------------------------------------

const ENHOXH_URI = "/sap/bc/adt/enhancements/enhoxh/ZMCP_ENH_BADI";
const ENHOXH_XML = fixture("354-enhoxh-no-filter.xml");

describe("writeEnhancementDescription gates on discovery (fail-closed)", () => {
  it("supported: the collection is present and 'declared PUT-capable', so the gate no-ops and the write reaches the wire", async () => {
    // No GET route configured beyond discovery -> the request is recorded
    // (proving the gate let it through) and then fails as unrouted, wrapped
    // by translateAdtError. What matters is it is NOT the discovery refusal.
    const { conn, adt } = await connected("supported", () => undefined);
    const gate = new SafetyGate({ readOnly: false });
    const e = await catchErr(
      writeEnhancementDescription(
        conn,
        gate,
        { type: "ENHO/XH", name: "ZMCP_ENH_BADI", description: "new description" },
        {},
      ),
    );
    expect(e.code).not.toBe("UNSUPPORTED");
    expect(String(e.message)).not.toMatch(/is not available/);
    expect(adt.calls.some((c) => c.method === "GET" && c.url === ENHOXH_URI)).toBe(true);
  });

  it("unknown (collection missing from a loaded inventory): refuses before any wire call, never reads or writes", async () => {
    const { conn, adt } = await connected("unsupported", () => undefined);
    const gate = new SafetyGate({ readOnly: false });
    const e = await catchErr(
      writeEnhancementDescription(
        conn,
        gate,
        { type: "ENHO/XH", name: "ZMCP_ENH_BADI", description: "new description" },
        {},
      ),
    );
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/PUT on enhancement collection "enhoxh" is not available/);
    expect(String(e.message)).toMatch(/not present in this system's discovery inventory/);
    expect(adt.calls.length).toBe(0);
  });

  it("unknown (discovery probe failed / never loaded): also refuses, fail-closed by design", async () => {
    const { conn, adt } = await connected("unknown", () => undefined);
    expect(conn.discovery.loadState).toBe("failed");
    const gate = new SafetyGate({ readOnly: false });
    const e = await catchErr(
      writeEnhancementDescription(
        conn,
        gate,
        { type: "ENHO/XH", name: "ZMCP_ENH_BADI", description: "new description" },
        {},
      ),
    );
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/Cannot say: the ADT discovery probe/);
    expect(adt.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Candidate 2 — the enhancement readers' discovery gate (plain Feature
// model, assertSupported), fail-OPEN on "unknown".
// ---------------------------------------------------------------------------

describe("readBadiImplementation gates on discovery (plain Feature model, fail-open)", () => {
  it("supported: the /enhancements family is present, so the read proceeds normally", async () => {
    const { conn } = await connected("supported", (r) =>
      r.url === ENHOXH_URI ? resp(200, ENHOXH_XML, OK_XML) : undefined,
    );
    const doc = await readBadiImplementation(conn, "ZMCP_ENH_BADI");
    expect(doc.data.name).toBe("ZMCP_ENH_BADI");
  });

  it("unsupported: discovery loaded but the /enhancements family is genuinely absent -> clear UNSUPPORTED, no GET attempted", async () => {
    const { conn, adt } = await connected("unsupported", (r) =>
      r.url === ENHOXH_URI ? resp(200, ENHOXH_XML, OK_XML) : undefined,
    );
    const e = await catchErr(readBadiImplementation(conn, "ZMCP_ENH_BADI"));
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/does not expose BAdI implementations \(ENHO\/XH\)/);
    expect(adt.calls.length).toBe(0);
  });

  it("unknown: a never-loaded/failed probe does NOT block the read (fail-open) -- the GET itself is authoritative", async () => {
    const { conn, adt } = await connected("unknown", (r) =>
      r.url === ENHOXH_URI ? resp(200, ENHOXH_XML, OK_XML) : undefined,
    );
    expect(conn.discovery.loadState).toBe("failed");
    const doc = await readBadiImplementation(conn, "ZMCP_ENH_BADI");
    expect(doc.data.name).toBe("ZMCP_ENH_BADI");
    expect(adt.calls.some((c) => c.method === "GET" && c.url === ENHOXH_URI)).toBe(true);
  });
});
