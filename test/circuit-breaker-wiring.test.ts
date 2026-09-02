/**
 * Circuit-breaker WIRING — the seam between `AuthCircuitBreaker` (pure state
 * machine, covered by test/circuit-breaker.test.ts) and the two places that
 * actually obey it: `GuardedHttpClient.request()` and `server.ts`'s cached
 * `connectPromise`.
 *
 * The four defects pinned down here:
 *
 *  1. Shedding a transient open used to go through `circuitOpenError()`, which
 *     read `breaker.info!` — `undefined` during a transient open, because the
 *     auth latch is untouched. Wrong error code at best, `TypeError` at worst.
 *  2. A concurrent burst arriving the instant the cooldown elapses must produce
 *     exactly ONE probe (the sandbox has seven dialog work processes).
 *  3. A probe that ends in a network error, or is answered with a plain 404,
 *     resolves through neither `recordSuccess()` nor `recordTransientFailure()`
 *     inside `inspect()`, and used to leave `probeInFlight` set forever —
 *     wedging the breaker in half-open with no probe ever admitted again.
 *  4. server.ts caches the connect promise. Keeping a *rejected* one forever is
 *     right for the permanent auth latch (retrying burns logon attempts) and
 *     catastrophic for a transient blip (a 30s sandbox hiccup would disable the
 *     server for the lifetime of the process). The predicate must be
 *     `state === "latched"`, never `isTripped`-widened-to-anything-else.
 *
 * Everything is offline: every test injects a hand-rolled `HttpClient`, so no
 * test can emit a real request, and time is an injected clock — there is no
 * `setTimeout` in the breaker and no wall-clock sleep here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuthCircuitBreaker, type BreakerOptions } from "../src/adt/circuit-breaker.js";
import { GuardedHttpClient } from "../src/adt/http-guard.js";
import type { AbapError } from "../src/adt/errors.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { createServer, type AbapsmithServer } from "../src/server.js";

// ---------------------------------------------------------------- fixtures ---

/** An injected clock beats fake timers here: the breaker never uses a timer. */
let fakeNow = 1_700_000_000_000;

class ScriptedClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  respond: (o: HttpClientOptions, n: number) => Promise<HttpClientResponse> | HttpClientResponse;
  constructor(respond: (o: HttpClientOptions, n: number) => Promise<HttpClientResponse> | HttpClientResponse) {
    this.respond = respond;
  }
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return await this.respond(o, this.calls.length);
  }
}

const resp = (status: number, body = "ok"): HttpClientResponse =>
  ({
    status,
    statusText: String(status),
    body,
    headers: { "content-type": "text/plain", "x-csrf-token": "TOKEN" },
  }) as unknown as HttpClientResponse;

/** Axios shape: it throws on >= 400 and carries the response on the exception. */
const httpError = (status: number): Error =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: resp(status),
  });

const REQ = { url: "/sap/bc/adt/discovery", method: "GET" } as unknown as HttpClientOptions;

const makeBreaker = (over: BreakerOptions = {}): AuthCircuitBreaker =>
  new AuthCircuitBreaker({
    cooldownMs: 30_000,
    failureThreshold: 3,
    now: () => fakeNow,
    ...over,
  });

const makeGuard = (inner: ScriptedClient, breaker: AuthCircuitBreaker): GuardedHttpClient =>
  new GuardedHttpClient({ baseURL: "http://sap.invalid:50000", inner }, breaker);

const codeOf = (e: unknown): AbapError["code"] => (e as AbapError).code;

/** Three 5xx answers = `failureThreshold`, so the transient machine opens. */
async function driveToOpen(guard: GuardedHttpClient, breaker: AuthCircuitBreaker): Promise<void> {
  for (let i = 0; i < 3; i++) await guard.request(REQ);
  expect(breaker.state).toBe("open");
  expect(breaker.isTripped).toBe(false);
}

beforeEach(() => {
  fakeNow = 1_700_000_000_000;
});

// ------------------------------------------------------- the guard's gate ---

describe("GuardedHttpClient sheds while the transient breaker is open", () => {
  it("refuses the request locally, never touches the network, and counts it as blocked", async () => {
    const breaker = makeBreaker();
    const inner = new ScriptedClient(() => resp(500));
    const guard = makeGuard(inner, breaker);

    await driveToOpen(guard, breaker);
    expect(inner.calls.length).toBe(3);
    expect(guard.blockedCount).toBe(0);

    await expect(guard.request(REQ)).rejects.toThrow(/shed/i);
    expect(inner.calls.length).toBe(3);
    expect(guard.blockedCount).toBe(1);
  });

  it("throws CIRCUIT_OPEN_TRANSIENT, not AUTH_CIRCUIT_OPEN", async () => {
    const breaker = makeBreaker();
    const guard = makeGuard(new ScriptedClient(() => resp(503)), breaker);
    await driveToOpen(guard, breaker);

    const err = await guard.request(REQ).catch((e: unknown) => e);
    expect(codeOf(err)).toBe("CIRCUIT_OPEN_TRANSIENT");
    expect(codeOf(err)).not.toBe("AUTH_CIRCUIT_OPEN");
  });

  it("does not crash on `info!` — a transient open has no TripInfo at all", async () => {
    const breaker = makeBreaker();
    const guard = makeGuard(new ScriptedClient(() => resp(500)), breaker);
    await driveToOpen(guard, breaker);

    // The precondition that made the old non-null assertion a live grenade.
    expect(breaker.info).toBeUndefined();
    expect(breaker.isTripped).toBe(false);

    const err = await guard.request(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).not.toMatch(/undefined|cannot read/i);
    expect(codeOf(err)).toBe("CIRCUIT_OPEN_TRANSIENT");
    // Built purely from status(): the wait hint must still be populated.
    expect((err as AbapError).details.state).toBe("open");
  });
});

// ------------------------------------------------------------- half-open ----

describe("half-open admits exactly one probe", () => {
  it("lets ONE request out of a concurrent burst through and sheds the rest", async () => {
    const breaker = makeBreaker();
    const inner = new ScriptedClient(() => resp(500));
    const guard = makeGuard(inner, breaker);
    await driveToOpen(guard, breaker);

    fakeNow += 30_000;
    expect(breaker.state).toBe("half-open");

    let release!: (r: HttpClientResponse) => void;
    const held = new Promise<HttpClientResponse>((r) => {
      release = r;
    });
    inner.respond = () => held;

    // Handlers are attached synchronously so the shed rejections are never
    // momentarily unhandled.
    const burst = Promise.allSettled([1, 2, 3, 4, 5].map(() => guard.request(REQ)));

    // The gate is synchronous: exactly one caller saw half-open + allowRequest().
    expect(inner.calls.length).toBe(4);

    // Shedding continues for as long as the probe is outstanding.
    await expect(guard.request(REQ)).rejects.toThrow();
    expect(inner.calls.length).toBe(4);

    release(resp(500));
    const settled = await burst;
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const shed = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    expect(shed).toHaveLength(4);
    for (const s of shed) expect(codeOf(s.reason)).toBe("CIRCUIT_OPEN_TRANSIENT");

    // The probe failed, so shedding resumes.
    expect(breaker.state).toBe("open");
    await expect(guard.request(REQ)).rejects.toThrow();
    expect(inner.calls.length).toBe(4);
  });

  it("closes on a successful probe and lets traffic flow again", async () => {
    const breaker = makeBreaker();
    const inner = new ScriptedClient(() => resp(500));
    const guard = makeGuard(inner, breaker);
    await driveToOpen(guard, breaker);

    fakeNow += 30_000;
    inner.respond = () => resp(200);

    await expect(guard.request(REQ)).resolves.toMatchObject({ status: 200 });
    expect(breaker.state).toBe("closed");
    expect(breaker.status().probeInFlight).toBe(false);
    expect(breaker.status().consecutiveFailures).toBe(0);

    await guard.request(REQ);
    await guard.request(REQ);
    expect(inner.calls.length).toBe(6);
    expect(guard.blockedCount).toBe(0);
  });

  it("reopens with a doubled cooldown when the probe fails, and sheds again", async () => {
    const breaker = makeBreaker();
    const inner = new ScriptedClient(() => resp(500));
    const guard = makeGuard(inner, breaker);
    await driveToOpen(guard, breaker);
    expect(breaker.status().cooldownMs).toBe(30_000);

    fakeNow += 30_000;
    inner.respond = () => {
      throw httpError(500);
    };
    await expect(guard.request(REQ)).rejects.toThrow(/status code 500/);

    expect(breaker.state).toBe("open");
    expect(breaker.status().cooldownMs).toBe(60_000);
    expect(inner.calls.length).toBe(4);

    // Still shedding at the *old* cooldown boundary...
    fakeNow += 30_000;
    await expect(guard.request(REQ)).rejects.toThrow(/shed/i);
    expect(inner.calls.length).toBe(4);

    // ...and only probing again after the doubled one.
    fakeNow += 30_000;
    expect(breaker.state).toBe("half-open");
    inner.respond = () => resp(200);
    await guard.request(REQ);
    expect(breaker.state).toBe("closed");
  });
});

// --------------------------------------------------------- probe wedging ----

describe("a probe always resolves — the breaker can never wedge in half-open", () => {
  it("clears probeInFlight when the probe dies with a network error", async () => {
    const breaker = makeBreaker();
    const inner = new ScriptedClient(() => resp(500));
    const guard = makeGuard(inner, breaker);
    await driveToOpen(guard, breaker);

    fakeNow += 30_000;
    inner.respond = () => {
      // No `.response` — nothing for `inspect()` to look at.
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    };
    await expect(guard.request(REQ)).rejects.toThrow(/socket hang up/);

    expect(breaker.status().probeInFlight).toBe(false);
    expect(breaker.state).toBe("open");

    // Proof it is not wedged: the next cooldown really does admit a probe.
    fakeNow += 60_000;
    expect(breaker.state).toBe("half-open");
    inner.respond = () => resp(200);
    await guard.request(REQ);
    expect(breaker.state).toBe("closed");
  });

  it("clears probeInFlight when the probe is answered with a plain 404", async () => {
    for (const deliver of ["thrown", "returned"] as const) {
      const breaker = makeBreaker();
      const inner = new ScriptedClient(() => resp(500));
      const guard = makeGuard(inner, breaker);
      await driveToOpen(guard, breaker);

      fakeNow += 30_000;
      inner.respond =
        deliver === "thrown"
          ? () => {
              throw httpError(404);
            }
          : () => resp(404);

      // A 404 moves neither counter inside `inspect()` — but it is still proof
      // the remote answered, which is exactly what a probe asks.
      if (deliver === "thrown") {
        await expect(guard.request(REQ)).rejects.toThrow(/status code 404/);
      } else {
        await expect(guard.request(REQ)).resolves.toMatchObject({ status: 404 });
      }

      expect(breaker.status().probeInFlight).toBe(false);
      expect(breaker.state).toBe("closed");

      // Not wedged: traffic flows.
      inner.respond = () => resp(200);
      await guard.request(REQ);
      expect(inner.calls.length).toBe(5);
      fakeNow += 1_000;
    }
  });
});

// ------------------------------------------------------------ auth latch ----

describe("the auth latch is permanent and is never probed", () => {
  it("keeps refusing with AUTH_CIRCUIT_OPEN and never sends another request", async () => {
    const breaker = makeBreaker();
    const inner = new ScriptedClient(() => resp(401));
    const guard = makeGuard(inner, breaker);

    const first = await guard.request(REQ).catch((e: unknown) => e);
    expect(codeOf(first)).toBe("AUTH_CIRCUIT_OPEN");
    expect(breaker.state).toBe("latched");
    expect(breaker.isTripped).toBe(true);
    expect(inner.calls.length).toBe(1);

    // Ten minutes — twice the maximum transient cooldown. No probe, ever.
    fakeNow += 600_000;
    expect(breaker.allowRequest()).toBe(false);
    expect(breaker.state).toBe("latched");
    expect(breaker.status().probeInFlight).toBe(false);

    for (let i = 0; i < 3; i++) {
      const e = await guard.request(REQ).catch((x: unknown) => x);
      expect(codeOf(e)).toBe("AUTH_CIRCUIT_OPEN");
      fakeNow += 600_000;
    }
    expect(inner.calls.length).toBe(1);
    expect(guard.blockedCount).toBe(3);
  });
});

// -------------------------------------------- server connect-cache poison ----

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
  });

interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

const servers: AbapsmithServer[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.connection.dispose();
});

async function harness(
  http: HttpClient,
  breaker: AuthCircuitBreaker,
): Promise<{ srv: AbapsmithServer; call: () => Promise<ToolCallResult> }> {
  const srv = createServer(cfg(), { httpClient: http, breaker, log: () => {} });
  servers.push(srv);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);
  const call = async (): Promise<ToolCallResult> =>
    (await client.callTool({
      name: "abap_read",
      arguments: { object: "ZMCP_DEMO" },
    })) as unknown as ToolCallResult;
  return { srv, call };
}

const payloadOf = (res: ToolCallResult): Record<string, unknown> =>
  JSON.parse(res.content[0]!.text) as Record<string, unknown>;

describe("server.ts connect-cache poisoning", () => {
  it("keeps the rejected connect promise forever after an auth latch", async () => {
    const breaker = makeBreaker();
    const inner = new ScriptedClient(() => resp(401));
    const { srv, call } = await harness(inner, breaker);

    const first = await call();
    expect(first.isError).toBe(true);
    // The 401 that latched the breaker was this very connect's own logon, so the
    // caller is told the thing it can act on — credentials rejected — rather than
    // abapsmith's internal latch state. The latch is still set and is
    // asserted directly on the next line; what changed is only which of the two
    // facts is reported as the error.
    expect(payloadOf(first).error).toBe("AUTH_FAILED");
    expect(srv.connection.breaker.state).toBe("latched");
    const afterFirst = inner.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // Second attempt: the cached rejection is reused verbatim. Not one more
    // logon attempt reaches the wire — that is what protects the SAP user from
    // `login/fails_to_user_lock`.
    fakeNow += 600_000;
    const second = await call();
    expect(second.isError).toBe(true);
    // "Reused verbatim" is the assertion: the same cached rejection, so the same
    // code as the first call — not a fresh classification.
    expect(payloadOf(second).error).toBe("AUTH_FAILED");
    expect(inner.calls.length).toBe(afterFirst);
    expect(srv.connection.isConnected).toBe(false);
  });

  it("clears the cache after a transient failure so the next attempt can succeed", async () => {
    // Threshold 1 so a single 5xx opens the transient machine — the state that
    // must NOT be mistaken for a latch.
    const breaker = makeBreaker({ failureThreshold: 1, cooldownMs: 1_000 });
    let mode: "fail" | "ok" = "fail";
    const inner = new ScriptedClient(() => {
      if (mode === "fail") throw httpError(503);
      return resp(200);
    });
    const { srv, call } = await harness(inner, breaker);

    const first = await call();
    expect(first.isError).toBe(true);
    expect(srv.connection.breaker.state).toBe("open");
    expect(srv.connection.breaker.isTripped).toBe(false);
    const afterFirst = inner.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // Cooldown elapses, the system recovers, and the server must try again.
    fakeNow += 2_000;
    mode = "ok";
    await call();

    // The observable proof the cached rejection was discarded: new traffic.
    expect(inner.calls.length).toBeGreaterThan(afterFirst);
    expect(srv.connection.isConnected).toBe(true);
    expect(srv.connection.breaker.state).toBe("closed");
  });
});
