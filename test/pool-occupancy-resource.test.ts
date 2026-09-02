/**
 * `abap://<sid>/system`'s `sessions` key — the operator-facing answer to
 * "how many ADT sessions does this process hold right now?"
 *
 * ## Why this file exists
 *
 * A read-only `abap_search` stopped being answered against a
 * shared appliance, and nobody could tell from outside the process whether
 * abapsmith was holding every session slot at the time. `AdtSessionPool.stats()`
 * (src/adt/pool.ts) already computes exactly that live occupancy and had ZERO
 * consumers in `src/` — this file pins the fix that puts it on the resource
 * `test/connection-generation-race.test.ts:643-649` calls "the server's single
 * rendered diagnostic surface".
 *
 * ## What would pass without the fix
 *
 * A hardcoded or merely-present `sessions` key would satisfy a shallow
 * "the field exists" assertion while telling an operator nothing. §1 and §2
 * below are written against LIVE occupancy specifically: leases are pinned
 * open with unresolved promises, the resource is read while they are open,
 * and the numbers must move when — and only when — the pool's real state
 * moves. §3 is the weaker, structural claim that the configured denominators
 * ride along, using non-default numbers so a hardcoded 5/2/2 cannot coincide.
 *
 * ## Harness
 *
 * Same shape as `test/server-session-revival.test.ts`: real `createServer()`
 * over `FakeAdtServer`, `systemRoleRoute` answering the non-productive probe
 * so `connect()` never trips the fail-closed write lockout. `createServer()`
 * returns the live `pool`, so leases are pinned directly with
 * `pool.withRead(op, fn)` — no tool call needed, and the resource handler
 * itself never takes a lease (that is the property §2 exercises: reading the
 * resource must RETURN, not queue, while the pool is saturated).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { createServer, type AbapsmithServer } from "../src/server.js";
import { Journal } from "../src/journal.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { FakeAdtServer, __resetFakeAdtCounters, type FakeRoute } from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";

// ------------------------------------------------------------------ fixtures ---

/** Answers the non-productive probe every `connect()` issues, so new pool slots log on cleanly. */
const systemRoleRoute: FakeRoute = (r) =>
  r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined;

const scaffold = (): FakeAdtServer =>
  new FakeAdtServer({
    routes: [systemRoleRoute],
    objects: {},
    objectMetadata: {},
  });

const cfg = (over: Partial<Config> = {}): Config => ({
  ...ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "hunter2",
    sid: "TST",
    client: "001",
  }),
  ...over,
});

const SYSTEM_RESOURCE_URI = `abap://${cfg().sid}/system`;

interface Harness {
  readonly srv: AbapsmithServer;
  readonly client: Client;
}

let openHarnesses: Harness[] = [];
let journalDir = "";

async function harness(config: Config, server: FakeAdtServer): Promise<Harness> {
  const srv = createServer(config, {
    breaker: new AuthCircuitBreaker(),
    httpClient: server.client(),
    log: () => {},
    journal: new Journal({ dir: journalDir, enabled: true, maxEntries: 100, maxAgeDays: 30 }, config.sid),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pool-occupancy-resource", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);
  const h: Harness = { srv, client };
  openHarnesses.push(h);
  return h;
}

interface SessionsBlock {
  total: number;
  busy: number;
  idle: number;
  waiting: number;
  dead: number;
  limits: { maxSessions: number; readConcurrency: number; writeConcurrency: number };
}

/** Reads the resource and returns its parsed `sessions` block. */
async function readSessions(h: Harness): Promise<SessionsBlock> {
  const res = (await h.client.readResource({ uri: SYSTEM_RESOURCE_URI })) as unknown as {
    contents: Array<{ text: string }>;
  };
  const body = JSON.parse(res.contents[0]!.text) as { sessions?: SessionsBlock };
  if (body.sessions === undefined) {
    throw new Error("resource has no `sessions` key — this is the base-state red proof");
  }
  return body.sessions;
}

/** A promise this test controls the settlement of, for pinning a pool lease open. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Lets queued microtasks (pool checkout/waiter bookkeeping) settle before asserting. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r));
};

beforeEach(() => {
  __resetFakeAdtCounters();
  openHarnesses = [];
  journalDir = mkdtempSync(join(tmpdir(), "abapsmith-pool-occupancy-"));
});

afterEach(async () => {
  for (const h of openHarnesses) {
    await h.client.close().catch(() => {});
    await h.srv.stop().catch(() => {});
  }
  openHarnesses = [];
  rmSync(journalDir, { recursive: true, force: true });
});

// ===========================================================================

describe("abap://<sid>/system exposes live pool occupancy under `sessions`", () => {
  /**
   * §1 — LOAD-BEARING. Pins `readConcurrency` (2) concurrent read leases open
   * with unresolved promises, reads the resource WHILE they are held, and
   * requires `sessions.busy` to equal exactly the number of open leases — not
   * merely be present, non-zero, or equal to some other field. A hardcoded or
   * stubbed `sessions: { busy: 0, ... }` fails the first assertion below; a
   * `sessions` block that reports the CONFIGURED concurrency rather than the
   * LIVE lease count fails it identically. Releasing and re-reading proves the
   * number is genuinely live rather than latched at its first-ever value.
   */
  it("busy tracks leases actually held open, and drops back to zero on release — LOAD-BEARING", async () => {
    const server = scaffold();
    const config = cfg({ maxSessions: 4, readConcurrency: 2, writeConcurrency: 2 });
    const h = await harness(config, server);

    const holdA = deferred<void>();
    const holdB = deferred<void>();
    const leaseA = h.srv.pool.withRead("a", async () => holdA.promise);
    await settle();
    const leaseB = h.srv.pool.withRead("b", async () => holdB.promise);
    await settle();

    const whileBusy = await readSessions(h);
    expect(whileBusy.busy, "two open leases must read back as busy: 2, not 0 or a stub").toBe(2);
    expect(whileBusy.idle, "no slot is free while both are held").toBe(0);
    expect(whileBusy.total, "exactly two slots were needed to hold two concurrent leases").toBe(2);
    expect(whileBusy.waiting).toBe(0);
    expect(whileBusy.dead).toBe(0);

    holdA.resolve();
    holdB.resolve();
    await Promise.all([leaseA, leaseB]);
    await settle();

    const afterRelease = await readSessions(h);
    expect(afterRelease.busy, "released leases must read back as busy: 0").toBe(0);
    expect(afterRelease.idle, "the two slots are now idle, not gone").toBe(2);
  });

  /**
   * §2 — LOAD-BEARING. Drives a 2-slot pool to its cap with a third caller
   * parked in the FIFO queue, then reads the resource WHILE saturated. Two
   * properties, both required for the resource to be usable mid-incident:
   * (a) `sessions.busy` reads the cap and `sessions.waiting >= 1` — saturation
   * is legible, not silently absorbed; (b) the read RETURNS at all, proving
   * the resource handler holds no pool lease of its own (it would deadlock
   * behind the parked caller otherwise, since `maxSessions: 2` leaves nothing
   * spare).
   */
  it("saturation (cap reached, caller queued) is legible and the read never blocks — LOAD-BEARING", async () => {
    const server = scaffold();
    const config = cfg({ maxSessions: 2, readConcurrency: 2, writeConcurrency: 2 });
    const h = await harness(config, server);

    const holdA = deferred<void>();
    const holdB = deferred<void>();
    const leaseA = h.srv.pool.withRead("a", async () => holdA.promise);
    await settle();
    const leaseB = h.srv.pool.withRead("b", async () => holdB.promise);
    await settle();
    // Third caller cannot get a slot (cap is 2) and parks in the FIFO queue.
    const parked = h.srv.pool.withRead("c", async () => undefined).catch(() => undefined);
    await settle();
    expect(h.srv.pool.stats().waiting, "sanity: the pool itself must see the parked caller").toBe(1);

    const saturated = await readSessions(h);
    expect(saturated.busy, "busy must read the cap while saturated").toBe(2);
    expect(saturated.waiting, "the parked caller must be visible as waiting").toBeGreaterThanOrEqual(1);
    expect(saturated.total).toBe(2);

    holdA.resolve();
    holdB.resolve();
    await Promise.all([leaseA, leaseB, parked]);
  });

  /**
   * §3. `limits` carries the configured denominators — otherwise reachable
   * only from `redactConfigSecrets`, printed once to stderr at startup and
   * unqueryable from a running process. Non-default numbers, so this cannot
   * pass by coincidentally matching a hardcoded `{5, 2, 2}`.
   */
  it("sessions.limits mirrors the configured maxSessions/readConcurrency/writeConcurrency", async () => {
    const server = scaffold();
    const config = cfg({ maxSessions: 7, readConcurrency: 3, writeConcurrency: 1 });
    const h = await harness(config, server);

    const sessions = await readSessions(h);
    expect(sessions.limits).toEqual({ maxSessions: 7, readConcurrency: 3, writeConcurrency: 1 });
  });

  /**
   * S4 — the resource read end-to-end (`client.readResource()`, not the
   * connection info bypassed directly), answering with no extra arguments,
   * names the connection's identity rather than refusing for lack of them.
   * Scoped to fields `ConnectionInfo` (`src/adt/connection.ts`) actually has
   * — no build/version field, no help pointer exist there.
   */
  it("a no-argument read answers with the connection's identity: connected, system, user, role", async () => {
    const server = scaffold();
    const config = cfg();
    const h = await harness(config, server);

    const res = (await h.client.readResource({ uri: SYSTEM_RESOURCE_URI })) as unknown as {
      contents: Array<{ text: string }>;
    };
    const body = JSON.parse(res.contents[0]!.text) as {
      connection?: { connected: boolean; sid: string; user: string; systemRole: string };
    };

    expect(body.connection, "resource has no `connection` key").toBeDefined();
    expect(body.connection!.connected).toBe(true);
    expect(body.connection!.sid).toBe(config.sid);
    expect(body.connection!.user).toBe(config.user);
    // systemRoleRoute answers the probe "nonproductive", which
    // `toLegacySystemRole` (src/adt/connection.ts) renders as "development".
    expect(body.connection!.systemRole).toBe("development");
  });
});
