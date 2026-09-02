/**
 * The process-lifetime shared discovery-inventory cache
 * (`src/adt/discovery-cache.ts`) — hit and miss regression tests.
 *
 * Background (see `doc/CONCURRENCY/session-pool-and-cost.md`, "What a session costs to establish"):
 * `GET /sap/bc/adt/discovery` + parse costs ~245ms of a fresh `connect()`
 * (34%), and the pool re-pays it on every slot because `Discovery` lives on
 * the connection object while the pool always mints a new one. The document
 * is a property of the SYSTEM — same ADT release, same client, same user —
 * not of the session, so `connectUnderLock()` now keys a shared, process-wide
 * cache on `(url, RESOLVED logon client, user)` and skips the fetch on a hit.
 *
 * What is pinned here:
 *  1. HIT — a second `connect()` against the identical `(url, resolved
 *     client, user)` identity does not put a second request on the wire, and
 *     still ends up with the same parsed inventory.
 *  2. MISS matters more than HIT per the task this file was written for:
 *     a different RESOLVED client (via a different `sap-usercontext` cookie,
 *     not `cfg.client` — see discovery-cache.ts's own doc for why those are
 *     not the same key), a different user, and a different url each
 *     independently force their own fetch and must NOT reuse another
 *     identity's inventory.
 *  3. A failed or empty probe is never written to the cache: a second
 *     connection against the same identity still attempts its own fetch, and
 *     a later successful probe is still eligible to populate the cache for
 *     anyone connecting after it.
 *  4. An UNRESOLVABLE client — no `sap-usercontext` cookie at all, so
 *     `logonClientFromCookies()` returns null — never touches the cache in
 *     either direction. There is no fallback to `cfg.client`: two sessions
 *     that both fail to resolve a client are not provably the same system,
 *     so `connectUnderLock()` skips the fast path entirely rather than risk
 *     conflating them under one key.
 *
 * All offline: a fake `HttpClient` is injected via `ConnectionOptions.httpClient`,
 * the same pattern as test/connection-discovery.test.ts. The system-role probe
 * is routed with `routeSystemRoleProbe` (test/helpers/system-role-fake.ts) so
 * this suite states its system explicitly, per test/system-role-probe-guard.test.ts.
 *
 * Test isolation: the shared cache is module-scope and would otherwise leak
 * across `it()` blocks within this file; `test/setup-discovery-cache.ts`
 * (wired into `vitest.config.ts`'s `setupFiles`) clears it in a `beforeEach`,
 * so every test here starts from a genuinely empty cache.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { discoveryCacheKey } from "../src/adt/discovery-cache.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement");
const fixture = (name: string): string => readFileSync(join(FIXTURES_DIR, name), "utf8");

/**
 * A real, non-empty discovery document (Enhancements workspace only,
 * excerpted from a real A4H capture — see
 * test/enhancement-discovery-gate.test.ts for provenance). Any non-empty,
 * well-formed document works for this suite's purposes: only "did the wire
 * get hit" and "does the parsed shape survive the cache round trip" matter
 * here, not which collections it lists.
 */
const DISCOVERY_XML = fixture("discovery-enhancements.xml");

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const OK_XML = { "content-type": "application/xml" };

type DiscoveryMode = "loaded" | "empty" | "reject";

/**
 * Logs on (optionally setting `sap-usercontext` so `logonClientFromCookies()`
 * resolves a specific client — the cache key ingredient that must NOT be
 * confused with `cfg.client`), counts `/discovery` requests, and answers them
 * per `discoveryMode`. Everything else answers 200 so `connect()` runs to
 * completion.
 */
class FakeAdt implements HttpClient {
  discoveryHits = 0;
  constructor(
    private readonly discoveryMode: DiscoveryMode,
    private readonly resolvedClient?: string,
  ) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const url = o.url;
    if (url.includes("/compatibility/graph")) {
      const headers: Record<string, unknown> = { ...LOGIN_HEADERS };
      if (this.resolvedClient !== undefined) {
        headers["set-cookie"] = [`sap-usercontext=sap-client=${this.resolvedClient}; path=/`];
      }
      return resp(200, "<graph/>", headers);
    }
    if (url.endsWith("/discovery")) {
      this.discoveryHits++;
      if (this.discoveryMode === "reject") throw new Error("discovery probe rejected (test, synthetic)");
      if (this.discoveryMode === "empty") return resp(200, "<service/>", OK_XML);
      return resp(200, DISCOVERY_XML, OK_XML);
    }
    return resp(200, "<settings/>", OK_XML);
  }
}

const cfg = (overrides: Partial<Config> = {}): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    ...overrides,
  });

const live: AbapConnection[] = [];

async function connect(opts: {
  discoveryMode: DiscoveryMode;
  resolvedClient?: string;
  cfgOverrides?: Partial<Config>;
}) {
  const fake = new FakeAdt(opts.discoveryMode, opts.resolvedClient);
  const routed = routeSystemRoleProbe(fake, { answer: "nonproductive" });
  const conn = new AbapConnection(cfg(opts.cfgOverrides), {
    httpClient: routed,
    log: () => {},
    exit: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  live.push(conn);
  const info = await conn.connect();
  return { conn, info, fake };
}

afterEach(() => {
  while (live.length) live.pop()!.dispose();
});

describe("discoveryCacheKey", () => {
  it("is identical for identical identities", () => {
    const a = discoveryCacheKey({ url: "http://sap.invalid:50000", client: "001", user: "DEVELOPER" });
    const b = discoveryCacheKey({ url: "http://sap.invalid:50000", client: "001", user: "DEVELOPER" });
    expect(a).toBe(b);
  });

  it("differs on url, resolved client, or user alone", () => {
    const base = { url: "http://sap.invalid:50000", client: "001", user: "DEVELOPER" };
    const key = discoveryCacheKey(base);
    expect(discoveryCacheKey({ ...base, url: "http://other.invalid:50000" })).not.toBe(key);
    expect(discoveryCacheKey({ ...base, client: "002" })).not.toBe(key);
    expect(discoveryCacheKey({ ...base, user: "OTHERUSER" })).not.toBe(key);
  });

  it("is case-insensitive on user only, not on client or url", () => {
    const base = { url: "http://sap.invalid:50000", client: "001", user: "DEVELOPER" };
    expect(discoveryCacheKey({ ...base, user: "developer" })).toBe(discoveryCacheKey(base));
  });
});

describe("shared discovery inventory cache — HIT", () => {
  it("a second connect() to the identical (url, resolved client, user) skips the /discovery fetch", async () => {
    const first = await connect({ discoveryMode: "loaded", resolvedClient: "001" });
    expect(first.fake.discoveryHits).toBe(1);
    expect(first.info.discoveryState).toBe("loaded");
    const firstCount = first.info.discoveryCollections;
    expect(firstCount).toBeGreaterThan(0);

    const second = await connect({ discoveryMode: "loaded", resolvedClient: "001" });
    // The whole point: no second request went on the wire for this identity.
    expect(second.fake.discoveryHits).toBe(0);
    // ...yet the connection ends up with the same parsed inventory, adopted
    // via Discovery.loadParsed() rather than fetched.
    expect(second.info.discoveryState).toBe("loaded");
    expect(second.info.discoveryCollections).toBe(firstCount);
    expect(second.conn.discovery.capability("enhancements")).toBe(
      first.conn.discovery.capability("enhancements"),
    );
  });
});

describe("shared discovery inventory cache — MISS", () => {
  it("a different RESOLVED client (not cfg.client) forces its own fetch — the miss that matters most", async () => {
    // Same cfg.client ("001" from the default cfg()) on both sides; only the
    // cookie-resolved client differs. If the cache were keyed on cfg.client
    // instead of the resolved client, this would wrongly HIT.
    const first = await connect({ discoveryMode: "loaded", resolvedClient: "001" });
    expect(first.fake.discoveryHits).toBe(1);

    const second = await connect({ discoveryMode: "loaded", resolvedClient: "002" });
    expect(second.fake.discoveryHits).toBe(1);
    expect(second.info.discoveryState).toBe("loaded");
  });

  it("a different user forces its own fetch", async () => {
    const first = await connect({
      discoveryMode: "loaded",
      resolvedClient: "001",
      cfgOverrides: { user: "DEVELOPER" },
    });
    expect(first.fake.discoveryHits).toBe(1);

    const second = await connect({
      discoveryMode: "loaded",
      resolvedClient: "001",
      cfgOverrides: { user: "OTHERUSER" },
    });
    expect(second.fake.discoveryHits).toBe(1);
    expect(second.info.discoveryState).toBe("loaded");
  });

  it("a different url forces its own fetch", async () => {
    const first = await connect({
      discoveryMode: "loaded",
      resolvedClient: "001",
      cfgOverrides: { url: "http://sap.invalid:50000" },
    });
    expect(first.fake.discoveryHits).toBe(1);

    const second = await connect({
      discoveryMode: "loaded",
      resolvedClient: "001",
      cfgOverrides: { url: "http://sap-other.invalid:50000" },
    });
    expect(second.fake.discoveryHits).toBe(1);
    expect(second.info.discoveryState).toBe("loaded");
  });

  it("a failed probe is never cached — a later connection to the same identity still fetches", async () => {
    const first = await connect({ discoveryMode: "reject", resolvedClient: "001" });
    expect(first.fake.discoveryHits).toBe(1);
    expect(first.info.discoveryState).toBe("failed");

    // Same identity as `first`. A failed probe must not have poisoned the
    // cache with a phantom "loaded" entry, and must not itself be replayed
    // from a cache — the next connection genuinely re-fetches.
    const second = await connect({ discoveryMode: "loaded", resolvedClient: "001" });
    expect(second.fake.discoveryHits).toBe(1);
    expect(second.info.discoveryState).toBe("loaded");

    // ...and now that a real inventory exists for this identity, a third
    // connection DOES hit the cache.
    const third = await connect({ discoveryMode: "loaded", resolvedClient: "001" });
    expect(third.fake.discoveryHits).toBe(0);
    expect(third.info.discoveryState).toBe("loaded");
  });

  it("an empty probe is never cached — a later connection to the same identity still fetches", async () => {
    const first = await connect({ discoveryMode: "empty", resolvedClient: "001" });
    expect(first.fake.discoveryHits).toBe(1);
    expect(first.info.discoveryState).toBe("empty");

    const second = await connect({ discoveryMode: "loaded", resolvedClient: "001" });
    expect(second.fake.discoveryHits).toBe(1);
    expect(second.info.discoveryState).toBe("loaded");
  });

  it("an unresolvable client (no sap-usercontext cookie) is never read from or written to the cache", async () => {
    // `resolvedClient` deliberately omitted: the fake login response carries
    // no `sap-usercontext` cookie at all, so `logonClientFromCookies()`
    // returns null. Falling back to `cfg.client` here would let two sessions
    // that land in genuinely different (but equally unresolvable) clients
    // share one cache entry — the exact conflation the resolved-client rule
    // exists to prevent. So this identity must never touch the cache: not as
    // a reader, not as a writer.
    const first = await connect({ discoveryMode: "loaded" });
    expect(first.fake.discoveryHits).toBe(1);
    expect(first.info.discoveryState).toBe("loaded");

    // Identical cfg (same url/client/user) and still no cookie. If the first
    // connect had written under some fallback key, this would wrongly hit —
    // it must fetch fresh instead, proving both "no write" on the first call
    // and "no read" on this one.
    const second = await connect({ discoveryMode: "loaded" });
    expect(second.fake.discoveryHits).toBe(1);
    expect(second.info.discoveryState).toBe("loaded");
  });
});
