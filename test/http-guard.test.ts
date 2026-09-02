/**
 * The session mutex inside `GuardedHttpClient`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `GuardedHttpClient` is the single funnel for every outbound ADT request: it
 * implements `HttpClient` and is handed to `new ADTClient(guard, …)`, so it sits
 * UNDERNEATH `AdtHTTP`. Both `client.*` and `client.httpClient.request(…)` pass
 * through `request()` below, which is what makes "one request at a time per ADT
 * session" enforceable at all.
 *
 * The protocol law it enforces: a second request on the same ADT stateful
 * session is HEAD-OF-LINE BLOCKED behind an outstanding long-poll for the
 * remainder of that poll's timeout (the listener itself is never killed by
 * this; it survives to its own natural
 * timeout every time). A different TCP connection is NOT a different SAP
 * session — anything else that talks on that session stalls for minutes behind
 * the debugger's listener rather than dying with it. Hence `GuardOptions.acquire`,
 * an optional hook that hands back a release function.
 *
 * THE TRAP THIS FILE PINS DOWN
 * ----------------------------
 * `acquire` introduces an `await` into `request()`, and there is exactly one
 * place it must not go. `request()` reads `breaker.state` and then calls
 * `breaker.allowRequest()`; Node is single-threaded, so those two adjacent
 * statements are what give the breaker its "exactly ONE half-open probe under a
 * concurrent burst" property — the first caller flips `probing` before anyone
 * else can look. Slip an `await` between them and a burst of N requests all read
 * `half-open`, then drain through the mutex ONE AT A TIME, each re-checking a
 * breaker the previous one has already closed. Every one of them is admitted,
 * and every one of them believes it is the probe. Seven dialog work processes
 * meet N "recovery" requests.
 *
 * That defect is invisible to a test that fires requests one at a time, or that
 * uses an `acquire` resolving synchronously. `single-probe survives a deferred
 * acquire` below is written specifically to go red against it: it uses a REAL
 * serialising mutex whose first grant lands on a later tick, and an inner client
 * that answers 200 so the probe closes the breaker while the others are queued.
 * Verified red by temporarily moving the `await` above `allowRequest()`.
 *
 * Everything here is offline. The guard takes an injected `inner: HttpClient`
 * and the breaker takes an injected clock; no test in this file can emit a
 * packet.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AuthCircuitBreaker, type BreakerOptions } from "../src/adt/circuit-breaker.js";
import { GuardedHttpClient, type Release } from "../src/adt/http-guard.js";
import type { AbapError } from "../src/adt/errors.js";

// ---------------------------------------------------------------- fixtures ---

let fakeNow = 1_700_000_000_000;

/** Records the ORDER of dispatches into the shared event log, not just a count. */
class ScriptedClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(
    private readonly respond: (
      o: HttpClientOptions,
      n: number,
    ) => Promise<HttpClientResponse> | HttpClientResponse,
    private readonly events?: string[],
  ) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    this.events?.push("dispatch");
    return await this.respond(o, this.calls.length);
  }
}

const resp = (status: number, body = "ok", ctype = "text/plain"): HttpClientResponse =>
  ({
    status,
    statusText: String(status),
    body,
    headers: { "content-type": ctype },
  }) as unknown as HttpClientResponse;

/** Axios shape: throws on >= 400 and carries the response on the exception. */
const httpError = (status: number, body = "err", ctype = "text/plain"): Error =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: resp(status, body, ctype),
  });

/**
 * HTTP 200 carrying the ICF logon-failure page.
 *
 * SYNTHETIC. It used to be the bare prose `<h1>Logon failed</h1>`, which the
 * tiered markers (D4) deliberately no longer trip on: prose alone is not
 * evidence, since an ABAP object description or a source listing can contain
 * those two words. It now carries the structural evidence a real logon form
 * carries. This file is about the guard's LEASE, not about classification —
 * all it needs is a page the breaker latches on; see test/circuit-breaker.test.ts
 * for the marker tiers themselves.
 */
const ICF_PAGE =
  '<html><body><form action="/sap/bc/adt"><input name="sap-user">' +
  '<input name="sap-password"></form></body></html>';

const REQ = { url: "/sap/bc/adt/discovery", method: "GET" } as unknown as HttpClientOptions;

const makeBreaker = (over: BreakerOptions = {}): AuthCircuitBreaker =>
  new AuthCircuitBreaker({ cooldownMs: 30_000, failureThreshold: 3, now: () => fakeNow, ...over });

const codeOf = (e: unknown): AbapError["code"] => (e as AbapError).code;

/**
 * A REAL serialising mutex, exactly the shape `AbapConnection` would supply:
 * one lease at a time, FIFO, and the grant always lands on a LATER TICK. The
 * deferral is the point — an `acquire` that resolves synchronously would hide
 * every ordering bug this file exists to catch.
 *
 * The returned release throws if called twice, so a double-release anywhere in
 * the guard surfaces as a test failure rather than as silent lease corruption.
 */
function makeMutex(events: string[]) {
  let tail: Promise<void> = Promise.resolve();
  let acquires = 0;
  let releases = 0;
  const acquire = (url: string): Promise<Release> => {
    acquires++;
    const prev = tail;
    let handOff!: () => void;
    tail = new Promise<void>((res) => {
      handOff = res;
    });
    return prev.then(async () => {
      await Promise.resolve(); // never grant synchronously
      events.push("acquire");
      let spent = false;
      return () => {
        if (spent) throw new Error("release() called twice for one acquire()");
        spent = true;
        releases++;
        events.push("release");
        handOff();
      };
    });
  };
  return { acquire, counts: () => ({ acquires, releases }) };
}

beforeEach(() => {
  fakeNow = 1_700_000_000_000;
});

// ------------------------------------------------- the hook stays optional ---

describe("GuardOptions.acquire is optional", () => {
  it("dispatches normally, and reaches the network, when no acquire is supplied", async () => {
    const inner = new ScriptedClient(() => resp(200, "payload"));
    const guard = new GuardedHttpClient({ baseURL: "http://x", inner }, makeBreaker());

    const r = await guard.request(REQ);

    expect(r.status).toBe(200);
    expect(r.body).toBe("payload");
    expect(inner.calls.length).toBe(1);
    expect(guard.requestCount).toBe(1);
    expect(guard.blockedCount).toBe(0);
  });

  it("still surfaces errors and still feeds the breaker when no acquire is supplied", async () => {
    const breaker = makeBreaker();
    const inner = new ScriptedClient(() => {
      throw httpError(500);
    });
    const guard = new GuardedHttpClient({ baseURL: "http://x", inner }, breaker);

    for (let i = 0; i < 3; i++) await expect(guard.request(REQ)).rejects.toThrow();
    expect(breaker.state).toBe("open");
  });
});

// --------------------------------------------------------------- ordering ---

describe("acquire / dispatch / release ordering", () => {
  it("acquires BEFORE the inner request and releases AFTER it", async () => {
    const events: string[] = [];
    const mutex = makeMutex(events);
    const inner = new ScriptedClient(() => resp(200), events);
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, acquire: mutex.acquire },
      makeBreaker(),
    );

    await guard.request(REQ);

    // Order, not counts: a guard that released before dispatching would still
    // score 1/1/1 on counters.
    expect(events).toEqual(["acquire", "dispatch", "release"]);
    expect(mutex.counts()).toEqual({ acquires: 1, releases: 1 });
  });

  it("serialises concurrent callers — no dispatch overlaps another's lease", async () => {
    const events: string[] = [];
    const mutex = makeMutex(events);
    let inFlight = 0;
    let maxInFlight = 0;
    const inner = new ScriptedClient(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 0));
      inFlight--;
      return resp(200);
    }, events);
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, acquire: mutex.acquire },
      makeBreaker(),
    );

    await Promise.all([guard.request(REQ), guard.request(REQ), guard.request(REQ)]);

    expect(maxInFlight).toBe(1);
    expect(events).toEqual([
      "acquire",
      "dispatch",
      "release",
      "acquire",
      "dispatch",
      "release",
      "acquire",
      "dispatch",
      "release",
    ]);
  });

  it("passes the request url to acquire", async () => {
    const seen: string[] = [];
    const guard = new GuardedHttpClient(
      {
        baseURL: "http://x",
        inner: new ScriptedClient(() => resp(200)),
        acquire: async (url: string) => {
          seen.push(url);
          return () => {};
        },
      },
      makeBreaker(),
    );

    await guard.request(REQ);
    expect(seen).toEqual(["/sap/bc/adt/discovery"]);
  });
});

// ------------------------------------------------- release on EVERY path ---

describe("the lease is released on every exit path", () => {
  it("releases when the inner request throws a network error", async () => {
    const events: string[] = [];
    const mutex = makeMutex(events);
    const inner = new ScriptedClient(() => {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    }, events);
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, acquire: mutex.acquire },
      makeBreaker(),
    );

    await expect(guard.request(REQ)).rejects.toThrow(/socket hang up/);

    expect(events).toEqual(["acquire", "dispatch", "release"]);
    expect(mutex.counts()).toEqual({ acquires: 1, releases: 1 });
  });

  it("releases when the inner request throws a carried HTTP error", async () => {
    const events: string[] = [];
    const mutex = makeMutex(events);
    const inner = new ScriptedClient(() => {
      throw httpError(500);
    }, events);
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, acquire: mutex.acquire },
      makeBreaker(),
    );

    await expect(guard.request(REQ)).rejects.toThrow();
    expect(events).toEqual(["acquire", "dispatch", "release"]);
  });

  it("releases when inspect() latches the breaker and the SUCCESS path throws", async () => {
    // HTTP 200 carrying the ICF logon page: `inner.request` RESOLVES, then
    // `inspect()` trips the auth latch and the guard throws after the dispatch.
    // The `finally` is the only thing that can release the lease here.
    const events: string[] = [];
    const mutex = makeMutex(events);
    const breaker = makeBreaker();
    const inner = new ScriptedClient(() => resp(200, ICF_PAGE, "text/html"), events);
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, acquire: mutex.acquire },
      breaker,
    );

    await expect(guard.request(REQ)).rejects.toMatchObject({ code: "AUTH_CIRCUIT_OPEN" });

    expect(breaker.isTripped).toBe(true);
    expect(events).toEqual(["acquire", "dispatch", "release"]);
    expect(mutex.counts()).toEqual({ acquires: 1, releases: 1 });
  });

  it("releases when inspect() latches the breaker on the THROW path (401)", async () => {
    const events: string[] = [];
    const mutex = makeMutex(events);
    const breaker = makeBreaker();
    const inner = new ScriptedClient(() => {
      throw httpError(401);
    }, events);
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, acquire: mutex.acquire },
      breaker,
    );

    await expect(guard.request(REQ)).rejects.toMatchObject({ code: "AUTH_CIRCUIT_OPEN" });
    expect(events).toEqual(["acquire", "dispatch", "release"]);
  });

  it("releases exactly once per acquire across a mixed run of successes and failures", async () => {
    const events: string[] = [];
    const mutex = makeMutex(events);
    const inner = new ScriptedClient((_o, n) => {
      if (n % 2 === 0) throw httpError(404);
      return resp(200);
    }, events);
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, acquire: mutex.acquire },
      makeBreaker(),
    );

    await Promise.allSettled(Array.from({ length: 6 }, () => guard.request(REQ)));

    const { acquires, releases } = mutex.counts();
    expect(acquires).toBe(6);
    expect(releases).toBe(6);
    expect(events.filter((e) => e === "release").length).toBe(6);
    // A double release would have thrown inside the mutex's release closure.
  });

  it("never dispatches and never releases when acquire itself rejects", async () => {
    let releases = 0;
    const inner = new ScriptedClient(() => resp(200));
    // The guard must not invent a release for a lease it never got: calling a
    // release that was never handed out would free somebody else's lease.
    const acquire = (): Promise<Release> => {
      const release: Release = () => {
        releases++;
      };
      void release; // deliberately never handed to the guard
      return Promise.reject(new Error("lease refused"));
    };
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, acquire },
      makeBreaker(),
    );

    await expect(guard.request(REQ)).rejects.toThrow(/lease refused/);

    expect(inner.calls.length).toBe(0);
    expect(guard.requestCount).toBe(0);
    expect(releases).toBe(0);
  });
});

// ------------------------------------------------------- the probe slot ----

/** Drive a breaker to `open` through a guard, then step the clock to half-open. */
async function driveToHalfOpen(breaker: AuthCircuitBreaker): Promise<void> {
  const opener = new GuardedHttpClient(
    { baseURL: "http://x", inner: new ScriptedClient(() => resp(500)) },
    breaker,
  );
  for (let i = 0; i < 3; i++) await opener.request(REQ);
  expect(breaker.state).toBe("open");
  fakeNow += 30_001;
  expect(breaker.state).toBe("half-open");
}

describe("the half-open single-probe invariant survives the session mutex", () => {
  it("admits EXACTLY ONE probe from a concurrent burst when acquire defers", async () => {
    // ------------------------------------------------------------------
    // THE regression test for the await-placement trap. It is red if the
    // `await this.opts.acquire(...)` is moved above `allowRequest()`:
    //
    //   correct  — the six calls run steps 1/1b synchronously, so caller #1
    //              takes the probe slot and #2..#6 are shed before anyone
    //              touches the mutex.        -> 1 dispatch, 5 shed
    //   broken   — all six read `half-open`, then queue on the mutex and drain
    //              one at a time; #1's 200 CLOSES the breaker, so #2..#6 sail
    //              through `allowRequest()` and are dispatched, each of them
    //              still believing it is the probe.
    //                                        -> 6 dispatches, 0 shed
    // ------------------------------------------------------------------
    const breaker = makeBreaker();
    await driveToHalfOpen(breaker);

    const events: string[] = [];
    const mutex = makeMutex(events);
    const inner = new ScriptedClient(() => resp(200), events);
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, acquire: mutex.acquire },
      breaker,
    );

    // All six enter `request()` in the same synchronous turn.
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => guard.request(REQ)),
    );

    const ok = settled.filter((s) => s.status === "fulfilled");
    const shed = settled.filter(
      (s) => s.status === "rejected" && codeOf(s.reason) === "CIRCUIT_OPEN_TRANSIENT",
    );

    expect(inner.calls.length).toBe(1); // <- the whole point
    expect(ok.length).toBe(1);
    expect(shed.length).toBe(5);
    expect(guard.blockedCount).toBe(5);
    expect(guard.requestCount).toBe(1);
    // The five shed callers never queued for the lease: a shed request must not
    // wait behind anything.
    expect(mutex.counts()).toEqual({ acquires: 1, releases: 1 });
    expect(events).toEqual(["acquire", "dispatch", "release"]);
    // The single probe answered 200, so the breaker fully recovered.
    expect(breaker.state).toBe("closed");
  });

  it("admits exactly one probe even when the probe FAILS mid-burst", async () => {
    const breaker = makeBreaker();
    await driveToHalfOpen(breaker);

    const events: string[] = [];
    const mutex = makeMutex(events);
    const inner = new ScriptedClient(() => {
      throw httpError(503);
    }, events);
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, acquire: mutex.acquire },
      breaker,
    );

    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => guard.request(REQ)),
    );

    expect(inner.calls.length).toBe(1);
    expect(settled.filter((s) => s.status === "fulfilled").length).toBe(0);
    expect(mutex.counts()).toEqual({ acquires: 1, releases: 1 });
    // Failed probe -> re-open with a DOUBLED cooldown, never wedged half-open.
    expect(breaker.state).toBe("open");
    expect(breaker.status().probeInFlight).toBe(false);
    expect(breaker.status().cooldownMs).toBe(60_000);
  });

  it("hands the probe slot back when acquire rejects, instead of wedging half-open", async () => {
    // The probe slot is taken by `allowRequest()` BEFORE the mutex is asked for
    // a lease, and only `dispatch()` resolves it. If `acquire` rejects and the
    // guard just rethrows, `probeInFlight` stays set forever: `allowRequest()`
    // refuses while probing and `syncPhase()` only moves open -> half-open, so
    // the breaker sheds every later request for the life of the process.
    const breaker = makeBreaker();
    await driveToHalfOpen(breaker);

    const inner = new ScriptedClient(() => resp(200));
    const guard = new GuardedHttpClient(
      {
        baseURL: "http://x",
        inner,
        acquire: async () => {
          throw new Error("connection is shutting down");
        },
      },
      breaker,
    );

    await expect(guard.request(REQ)).rejects.toThrow(/shutting down/);
    expect(inner.calls.length).toBe(0);

    // Not wedged: the probe slot is free and the breaker is cooling down again.
    expect(breaker.status().probeInFlight).toBe(false);
    expect(breaker.state).toBe("open");

    // And it genuinely recovers — the next probe after the cooldown is admitted.
    fakeNow += 60_001;
    expect(breaker.state).toBe("half-open");
    const healthy = new GuardedHttpClient(
      { baseURL: "http://x", inner: new ScriptedClient(() => resp(200)) },
      breaker,
    );
    await healthy.request(REQ);
    expect(breaker.state).toBe("closed");
  });

  it("hands the probe slot back when the onRequest hook throws", async () => {
    // The probe slot is taken by `allowRequest()` in `request()`, but ONLY
    // `dispatch()` resolves it — and `dispatch()`'s try/catch does not open
    // until `inner.request()`. `onRequest` fires OUTSIDE it, and in production
    // that hook is `AbapConnection.noteWireRequest`, which throws BY DESIGN on
    // two paths (the RequestBudget logon overspend and the
    // `logon-ceiling-exceeded` refusal). Without a catch in `request()` the
    // throw sails out through the `finally { release() }` — which frees the
    // session mutex and NOTHING else — leaving `probeInFlight` set forever.
    // `allowRequest()` then refuses every later call and `syncPhase()` only
    // ever moves open -> half-open, so the breaker sheds for the life of the
    // connection.
    const breaker = makeBreaker();
    await driveToHalfOpen(breaker);

    const events: string[] = [];
    const mutex = makeMutex(events);
    const inner = new ScriptedClient(() => resp(200), events);
    const guard = new GuardedHttpClient(
      {
        baseURL: "http://x",
        inner,
        acquire: mutex.acquire,
        onRequest: () => {
          throw new Error("Refused logon-endpoint request #6");
        },
      },
      breaker,
    );

    await expect(guard.request(REQ)).rejects.toThrow(/Refused logon-endpoint request/);

    // Nothing left the process, and the lease was still handed back.
    expect(inner.calls.length).toBe(0);
    expect(guard.requestCount).toBe(0);
    expect(mutex.counts()).toEqual({ acquires: 1, releases: 1 });

    // Not wedged: the probe slot is free and the breaker is cooling down again.
    expect(breaker.status().probeInFlight).toBe(false);
    expect(breaker.state).toBe("open");

    // And it genuinely recovers rather than shedding forever.
    fakeNow += 60_001;
    expect(breaker.state).toBe("half-open");
    const healthy = new GuardedHttpClient(
      { baseURL: "http://x", inner: new ScriptedClient(() => resp(200)) },
      breaker,
    );
    await healthy.request(REQ);
    expect(breaker.state).toBe("closed");
  });

  it("hands the probe slot back when the onResponse hook throws", async () => {
    // Same leak, the other side of `inner.request()`: `onResponse` fires after
    // the catch block has closed and BEFORE the probe is resolved, so a throw
    // there skips the resolution just as completely. The response DID come
    // back, but it was never inspected, so a transient failure — not a success
    // — is the only honest report.
    const breaker = makeBreaker();
    await driveToHalfOpen(breaker);

    const events: string[] = [];
    const mutex = makeMutex(events);
    const inner = new ScriptedClient(() => resp(200), events);
    const guard = new GuardedHttpClient(
      {
        baseURL: "http://x",
        inner,
        acquire: mutex.acquire,
        onResponse: () => {
          throw new Error("observer blew up");
        },
      },
      breaker,
    );

    await expect(guard.request(REQ)).rejects.toThrow(/observer blew up/);

    expect(inner.calls.length).toBe(1);
    expect(mutex.counts()).toEqual({ acquires: 1, releases: 1 });
    expect(events).toEqual(["acquire", "dispatch", "release"]);

    expect(breaker.status().probeInFlight).toBe(false);
    expect(breaker.state).toBe("open");

    fakeNow += 60_001;
    expect(breaker.state).toBe("half-open");
    const healthy = new GuardedHttpClient(
      { baseURL: "http://x", inner: new ScriptedClient(() => resp(200)) },
      breaker,
    );
    await healthy.request(REQ);
    expect(breaker.state).toBe("closed");
  });
});

// ----------------------------------------------- interaction with the gates --

describe("the mutex sits behind both breaker gates", () => {
  it("a latched auth breaker sheds without ever asking for a lease", async () => {
    const breaker = makeBreaker();
    breaker.trip("http-401", "rejected");
    const events: string[] = [];
    const mutex = makeMutex(events);
    const inner = new ScriptedClient(() => resp(200), events);
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, acquire: mutex.acquire },
      breaker,
    );

    await expect(guard.request(REQ)).rejects.toMatchObject({ code: "AUTH_CIRCUIT_OPEN" });

    expect(mutex.counts()).toEqual({ acquires: 0, releases: 0 });
    expect(inner.calls.length).toBe(0);
    expect(guard.blockedCount).toBe(1);
    expect(events).toEqual([]);
  });

  it("a transiently open breaker sheds without ever asking for a lease", async () => {
    const breaker = makeBreaker();
    const opener = new GuardedHttpClient(
      { baseURL: "http://x", inner: new ScriptedClient(() => resp(500)) },
      breaker,
    );
    for (let i = 0; i < 3; i++) await opener.request(REQ);
    expect(breaker.state).toBe("open");

    const events: string[] = [];
    const mutex = makeMutex(events);
    const inner = new ScriptedClient(() => resp(200), events);
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, acquire: mutex.acquire },
      breaker,
    );

    await expect(guard.request(REQ)).rejects.toMatchObject({
      code: "CIRCUIT_OPEN_TRANSIENT",
    });
    expect(mutex.counts()).toEqual({ acquires: 0, releases: 0 });
    expect(events).toEqual([]);
  });

  it("still strips sap-client while holding the lease", async () => {
    const events: string[] = [];
    const mutex = makeMutex(events);
    const inner = new ScriptedClient(() => resp(200), events);
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, acquire: mutex.acquire },
      makeBreaker(),
    );

    await guard.request({ ...REQ, qs: { "sap-client": "001", other: "1" } } as HttpClientOptions);

    expect(inner.calls[0]?.qs).toEqual({ other: "1" });
    expect(events).toEqual(["acquire", "dispatch", "release"]);
  });

  it("passes the request url to acquire unmodified, sap-client and all", async () => {
    // The lease label is derived from THIS string by the caller
    // (`AbapConnection`'s `opOf`), so any rewriting the guard did here would
    // change what a `SESSION_BUSY` reports as the holder. Stripping happens in
    // `dispatch()`, strictly after the lease is taken.
    const seen: string[] = [];
    const inner = new ScriptedClient(() => resp(200));
    const guard = new GuardedHttpClient(
      {
        baseURL: "http://x",
        inner,
        acquire: (url: string) => {
          seen.push(url);
          return Promise.resolve(() => {});
        },
      },
      makeBreaker(),
    );

    await guard.request({
      ...REQ,
      url: "/sap/bc/adt/programs/programs/zfoo",
      qs: { "sap-client": "001" },
    } as HttpClientOptions);

    expect(seen).toEqual(["/sap/bc/adt/programs/programs/zfoo"]);
  });
});

// ---------------------------------------------------------------------------
// B1b — the session-type re-stamp
// ---------------------------------------------------------------------------

describe("GuardedHttpClient — sessionType re-stamp", () => {
  const SESSION_HEADER = "X-sap-adt-sessiontype";

  it("leaves the header untouched when no sessionType hook is supplied", async () => {
    const inner = new ScriptedClient(() => resp(200));
    const guard = new GuardedHttpClient({ baseURL: "http://x", inner }, makeBreaker());

    await guard.request({ ...REQ, headers: { [SESSION_HEADER]: "stateful" } } as HttpClientOptions);

    expect(inner.calls[0]?.headers?.[SESSION_HEADER]).toBe("stateful");
  });

  it("leaves the header untouched when the hook returns undefined", async () => {
    const inner = new ScriptedClient(() => resp(200));
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, sessionType: () => undefined },
      makeBreaker(),
    );

    await guard.request({ ...REQ, headers: { [SESSION_HEADER]: "stateful" } } as HttpClientOptions);

    expect(inner.calls[0]?.headers?.[SESSION_HEADER]).toBe("stateful");
  });

  it("re-reads the flag AFTER the lease is granted, correcting a stale stamp", async () => {
    // The whole point. `AdtHTTP._request()` stamps this header before the guard
    // is entered, so a request that was built while a stateful window was open
    // and then parked in `acquire` would otherwise go out `stateful` after that
    // window had already closed and released its enqueues.
    let live = "stateful";
    const inner = new ScriptedClient(() => resp(200));
    const guard = new GuardedHttpClient(
      {
        baseURL: "http://x",
        inner,
        // The window closes exactly while this call is parked.
        acquire: async () => {
          await Promise.resolve();
          live = "stateless";
          return () => {};
        },
        sessionType: () => live,
      },
      makeBreaker(),
    );

    await guard.request({ ...REQ, headers: { [SESSION_HEADER]: "stateful" } } as HttpClientOptions);

    expect(inner.calls[0]?.headers?.[SESSION_HEADER]).toBe("stateless");
  });

  it("stamps the header onto a request that carried none", async () => {
    const inner = new ScriptedClient(() => resp(200));
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, sessionType: () => "stateless" },
      makeBreaker(),
    );

    await guard.request({ ...REQ } as HttpClientOptions);

    expect(inner.calls[0]?.headers?.[SESSION_HEADER]).toBe("stateless");
  });

  it("copies the header map instead of writing through the caller's object", async () => {
    // `dispatch()` shallow-clones the options, so the `headers` reference is
    // shared with whatever built the request. `AdtHTTP` rebuilds that map per
    // dispatch, but writing through it would still be a side effect on somebody
    // else's object — and on a retry it would silently pin the FIRST reading.
    const original = { [SESSION_HEADER]: "stateful", "x-keep": "me" };
    const inner = new ScriptedClient(() => resp(200));
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, sessionType: () => "stateless" },
      makeBreaker(),
    );

    await guard.request({ ...REQ, headers: original } as HttpClientOptions);

    expect(original[SESSION_HEADER]).toBe("stateful");
    expect(inner.calls[0]?.headers?.[SESSION_HEADER]).toBe("stateless");
    expect(inner.calls[0]?.headers?.["x-keep"]).toBe("me");
  });

  it("is not consulted when the breaker sheds the request", async () => {
    let asked = 0;
    const breaker = makeBreaker();
    breaker.trip("logon-failed", "401", { status: 401, url: "/x" });
    const inner = new ScriptedClient(() => resp(200));
    const guard = new GuardedHttpClient(
      {
        baseURL: "http://x",
        inner,
        sessionType: () => {
          asked += 1;
          return "stateless";
        },
      },
      breaker,
    );

    await expect(guard.request(REQ)).rejects.toMatchObject({ code: "AUTH_CIRCUIT_OPEN" });
    expect(asked).toBe(0);
    expect(inner.calls.length).toBe(0);
  });
});
