/**
 * Self-tests for `test/helpers/fake-adt.ts` — the shared fake ADT HTTP
 * backend.
 *
 * WHY THIS FILE EXISTS
 * ---------------------
 * "A fake that lies is worse than no fake." `fake-adt.ts` makes two load
 * bearing claims that every future test in this suite will build on without
 * re-checking:
 *
 *   1. the interleaving primitive (`hold`/`Gate`) genuinely interleaves — a
 *      later request can complete before an earlier, still-held one, and the
 *      helper's own `events` log records the true order this happened in;
 *   2. the lock table genuinely conflicts on (object, session) and genuinely
 *      does NOT conflict across different objects or different sessions of
 *      the same user.
 *
 * This file exists to prove both claims, plus every other documented
 * behaviour of the fake (per-session isolation, the stateful single-flight
 * invariant, head-of-line blocking of a request issued behind an outstanding
 * long poll, the error-shape bookkeeping, determinism, and the real
 * `HttpClient` contract the production guard consumes). Nothing here is
 * allowed to be flaky: only `flushMicrotasks`, `settledOrPending`/`PENDING`
 * and `Gate.arrived` are used to observe async state — no `setTimeout`, no
 * wall-clock sleep, no fake timers.
 */
import { describe, expect, it } from "vitest";
import {
  CSRF_REQUIRED_403,
  FakeAdtProtocolError,
  FakeAdtServer,
  FakeAdtViolation,
  invalidLockHandle423,
  listenerConflict409,
  missingLockHandle400,
  sessionTimedOut400,
  UNCONFIRMED_HEADER,
  UNCONFIRMED_SHAPES,
  flushMicrotasks,
  lockConflict403,
  lockConflictXml,
  lockConflictXmlReconstructed,
  newLockHandle,
  PENDING,
  settledOrPending,
} from "./fake-adt.js";
import { GuardedHttpClient } from "../../src/adt/http-guard.js";
import { AuthCircuitBreaker } from "../../src/adt/circuit-breaker.js";

/**
 * Many interleaving/invariant tests below care only about ORDERING and do not
 * exercise a specific SAP endpoint shape, so they route arbitrary paths
 * through a trivial 200 catch-all rather than the builtin discovery/LOCK/etc.
 * routes (which only answer specific paths and would otherwise make an
 * unrelated test path an "unrouted request").
 */
function okCatchAll() {
  return { status: 200, statusText: "OK", body: "ok", headers: {} };
}

// =============================================================================
// A. Interleaving primitive
// =============================================================================

describe("FakeAdtServer — interleaving primitive genuinely interleaves", () => {
  it("lets a later, ungated request resolve while an earlier, gated request is still pending, then releases the earlier one", async () => {
    const server = new FakeAdtServer({ catchAll: okCatchAll });
    const client = server.client();
    const gate = server.hold("/aaa");

    const aPromise = client.request({ url: "/sap/bc/adt/aaa" });
    const bPromise = client.request({ url: "/sap/bc/adt/bbb" });

    // A is parked behind the gate; B has no gate in its way.
    const parkedA = await gate.arrived;
    // `seq` is a global counter across every FakeAdtServer in the process (by
    // design, see the FakeRequest JSDoc), so its absolute value depends on
    // how many requests earlier tests in this file already dispatched.
    // Deriving the two seq numbers from the actual parked request keeps this
    // assertion exact without depending on being the first test to run.
    const aSeq = parkedA.seq;
    const bSeq = aSeq + 1;
    expect(await settledOrPending(aPromise)).toBe(PENDING);
    await expect(bPromise).resolves.toMatchObject({ status: 200 });

    // A is STILL pending after B has fully resolved.
    expect(await settledOrPending(aPromise)).toBe(PENDING);

    gate.release();
    await expect(aPromise).resolves.toMatchObject({ status: 200 });

    // Pin the EXACT interleave, not just counts: A dispatches and parks
    // first, but B's whole dispatch-through-respond cycle completes before
    // A is released and responds.
    expect(server.events).toEqual([
      `dispatch:${aSeq}`,
      `park:${aSeq}`,
      `dispatch:${bSeq}`,
      `respond:${bSeq}:200`,
      `release:${aSeq}`,
      `respond:${aSeq}:200`,
    ]);
  });

  it("resolves a gate's `arrived` promise with the parked FakeRequest, and `server.calls` already contains it while it is still held", async () => {
    const server = new FakeAdtServer({ catchAll: okCatchAll });
    const client = server.client();
    const gate = server.hold("/parkme");

    const p = client.request({ url: "/sap/bc/adt/parkme", method: "GET" });

    const parked = await gate.arrived;
    expect(parked.method).toBe("GET");
    expect(parked.path).toBe("/sap/bc/adt/parkme");
    // Recording happens BEFORE parking: the request is already in `calls`
    // while it is still held (the promise has not resolved).
    expect(server.calls).toContain(parked);
    expect(await settledOrPending(p)).toBe(PENDING);

    gate.release();
    await p;
  });

  it("releaseWith(res) answers with the supplied response and the normal route never runs", async () => {
    const routeHits: string[] = [];
    const server = new FakeAdtServer({
      routes: [
        (r) => {
          if (r.path === "/custom") {
            routeHits.push(r.label);
            return { status: 200, statusText: "OK", body: "from-normal-route", headers: {} };
          }
          return undefined;
        },
      ],
    });
    const client = server.client();
    const gate = server.hold("/custom");

    const p = client.request({ url: "/sap/bc/adt/custom" });
    await gate.arrived;
    gate.releaseWith({ status: 200, statusText: "OK", body: "from-gate", headers: { "x-from": "gate" } });

    const res = await p;
    expect(res.body).toBe("from-gate");
    expect(res.headers["x-from"]).toBe("gate");
    // The custom route that would have answered this request never ran.
    expect(routeHits).toEqual([]);
  });

  it("releaseError(e) makes the held request reject with that error", async () => {
    const server = new FakeAdtServer();
    const client = server.client();
    const gate = server.hold("/boom");
    const failure = new Error("synthetic gate failure");

    const p = client.request({ url: "/sap/bc/adt/boom" });
    await gate.arrived;
    gate.releaseError(failure);

    await expect(p).rejects.toBe(failure);
  });

  it("arms gates in order, each capturing at most one matching request: two gates on the same matcher park requests 1 and 2, request 3 flows straight through", async () => {
    const server = new FakeAdtServer({ catchAll: okCatchAll });
    const client = server.client();
    const gate1 = server.hold("/repeat");
    const gate2 = server.hold("/repeat");

    const p1 = client.request({ url: "/sap/bc/adt/repeat" });
    const p2 = client.request({ url: "/sap/bc/adt/repeat" });
    const p3 = client.request({ url: "/sap/bc/adt/repeat" });

    const held1 = await gate1.arrived;
    const held2 = await gate2.arrived;
    // `seq` is a global, process-wide counter (see the FakeRequest JSDoc), so
    // only the requests' order relative to EACH OTHER is asserted here: gate1
    // parked the FIRST-dispatched matching request, gate2 the very next one.
    expect(held2.seq).toBe(held1.seq + 1);

    // Request 3 has no third gate to park behind, so it completes normally
    // while 1 and 2 are still held.
    await expect(p3).resolves.toMatchObject({ status: 200 });
    expect(await settledOrPending(p1)).toBe(PENDING);
    expect(await settledOrPending(p2)).toBe(PENDING);

    gate1.release();
    gate2.release();
    await expect(p1).resolves.toMatchObject({ status: 200 });
    await expect(p2).resolves.toMatchObject({ status: 200 });
  });

  it("releasing a gate BEFORE the request arrives applies the outcome instead of deadlocking", async () => {
    // A no-op early release used to leave the later `park()` waiting on a
    // deferred nobody resolved — a permanent hang with no diagnostic. The
    // outcome is now recorded and consumed on arrival.
    const server = new FakeAdtServer({ catchAll: okCatchAll });
    const client = server.client();

    const gate = server.hold("/early-release");
    gate.release(); // fired before any matching request exists

    await expect(client.request({ url: "/sap/bc/adt/early-release" })).resolves.toMatchObject({ status: 200 });
  });

  it("an early releaseWith(res) answers the request that arrives later", async () => {
    const server = new FakeAdtServer({ catchAll: okCatchAll });
    const client = server.client();

    const gate = server.hold("/early-respond");
    gate.releaseWith({ status: 418, statusText: "I'm a teapot", body: "brewed", headers: {} });

    const res = await client.request({ url: "/sap/bc/adt/early-respond" });
    expect(res.status).toBe(418);
    expect(res.body).toBe("brewed");
  });

  it("releasing a gate twice throws rather than silently doing nothing", async () => {
    const server = new FakeAdtServer({ catchAll: okCatchAll });
    const client = server.client();

    const gate = server.hold("/double-release");
    const p = client.request({ url: "/sap/bc/adt/double-release" });
    await gate.arrived;
    gate.release();
    await p;

    expect(() => gate.release()).toThrow(/already released/);
  });

  it("a matcher that never matches leaves `arrived` pending forever and does not stall unrelated traffic", async () => {
    const server = new FakeAdtServer({ catchAll: okCatchAll });
    const client = server.client();
    const gate = server.hold("/never-hit-this-path");

    const p = client.request({ url: "/sap/bc/adt/totally-unrelated" });
    await expect(p).resolves.toMatchObject({ status: 200 });

    expect(await settledOrPending(gate.arrived)).toBe(PENDING);
  });

  it("NEGATIVE CONTROL: without a gate B never overtakes A; with the gate on A, B (issued second) resolves first", async () => {
    // Same code path both times: two same-tick requests, A issued first then
    // B. The only difference between the two servers below is whether A is
    // held by a gate. `seq` is a global, process-wide counter (see the
    // FakeRequest JSDoc), so the expected event strings are built from the
    // actual observed seq numbers rather than hardcoded — the claim under
    // test is the ORDERING, not any particular absolute seq value.

    // --- WITHOUT a gate: nothing can invert A ahead of B ---
    const plainServer = new FakeAdtServer({ catchAll: okCatchAll });
    const plainClient = plainServer.client();
    const plainA = plainClient.request({ url: "/sap/bc/adt/plain-a" });
    const plainB = plainClient.request({ url: "/sap/bc/adt/plain-b" });
    await Promise.all([plainA, plainB]);
    const plainCalls = plainServer.calls;
    const plainSeqA = plainCalls[plainCalls.length - 2]?.seq;
    const plainSeqB = plainCalls[plainCalls.length - 1]?.seq;
    expect(plainServer.events).toEqual([
      `dispatch:${plainSeqA}`,
      `dispatch:${plainSeqB}`,
      `respond:${plainSeqA}:200`,
      `respond:${plainSeqB}:200`,
    ]);

    // --- WITH a gate on A: B (issued second) resolves first ---
    const gatedServer = new FakeAdtServer({ catchAll: okCatchAll });
    const gatedClient = gatedServer.client();
    const gate = gatedServer.hold("/gated-a");
    const gatedA = gatedClient.request({ url: "/sap/bc/adt/gated-a" });
    const gatedB = gatedClient.request({ url: "/sap/bc/adt/gated-b" });
    const parkedA = await gate.arrived;
    const gatedSeqA = parkedA.seq;
    const gatedSeqB = gatedSeqA + 1;
    await gatedB; // B, issued SECOND, completes while A is still held.
    expect(await settledOrPending(gatedA)).toBe(PENDING);
    gate.release();
    await gatedA;

    expect(gatedServer.events).toEqual([
      `dispatch:${gatedSeqA}`,
      `park:${gatedSeqA}`,
      `dispatch:${gatedSeqB}`,
      `respond:${gatedSeqB}:200`,
      `release:${gatedSeqA}`,
      `respond:${gatedSeqA}:200`,
    ]);

    // The two orderings are explicitly different, not just in seq numbers:
    // without a gate, A (issued FIRST) also RESPONDS first — plain FIFO.
    // With the gate holding A open, B (issued SECOND) responds first — the
    // order inverts. Same two-request script, one bit flipped (the gate).
    const plainRespondBIndex = plainServer.events.indexOf(`respond:${plainSeqB}:200`);
    const plainRespondAIndex = plainServer.events.indexOf(`respond:${plainSeqA}:200`);
    const gatedRespondBIndex = gatedServer.events.indexOf(`respond:${gatedSeqB}:200`);
    const gatedRespondAIndex = gatedServer.events.indexOf(`respond:${gatedSeqA}:200`);
    // Without the gate, A (issued first) still responds before B.
    expect(plainRespondAIndex).toBeLessThan(plainRespondBIndex);
    // With the gate, B (issued second) responds before A — the order inverts.
    expect(gatedRespondBIndex).toBeLessThan(gatedRespondAIndex);
  });
});

// =============================================================================
// B. Lock table — SAP semantics
// =============================================================================

describe("FakeAdtServer — lock table SAP semantics", () => {
  // Real LOCK/UNLOCK/PUT requests target the object's own URI (its last path
  // segment IS the object name) — unlike a GET of its source, which is
  // suffixed `/source/main`. `lastPathSegmentUpper` in the fake keys off this
  // same last segment, so the URL shape here must match real traffic.
  function lockUrl(obj: string): string {
    return `/sap/bc/adt/oo/classes/${obj}`;
  }

  it("two sessions of the SAME user locking the SAME object: first gets 200 with a 40-hex LOCK_HANDLE, second gets a 403 conflict with the verified shape", async () => {
    const server = new FakeAdtServer(); // default user DEVELOPER for both sessions
    const s1 = server.client();
    const s2 = server.client();
    expect(s1.session.user).toBe("DEVELOPER");
    expect(s2.session.user).toBe("DEVELOPER");

    const res1 = await s1.request({ url: lockUrl("ZCL_FOO"), method: "POST", qs: { _action: "LOCK" } });
    expect(res1.status).toBe(200);
    const handleMatch = /<LOCK_HANDLE>([0-9A-F]{40})<\/LOCK_HANDLE>/.exec(String(res1.body));
    expect(handleMatch).not.toBeNull();
    expect(handleMatch?.[1]).toMatch(/^[0-9A-F]{40}$/);

    const res2 = await s2.request({ url: lockUrl("ZCL_FOO"), method: "POST", qs: { _action: "LOCK" } });
    expect(res2.status).toBe(403);
    const body2 = String(res2.body);
    expect(body2).toContain('<type id="ExceptionResourceNoAccess"/>');
    expect(body2).toContain('<entry key="T100KEY-ID">EU</entry>');
    expect(body2).toContain('<entry key="T100KEY-NO">510</entry>');
    expect(body2).toContain("User DEVELOPER is currently editing ZCL_FOO");
  });

  it("six concurrent write cycles on six DIFFERENT objects all succeed with distinct handles and no violations", async () => {
    const server = new FakeAdtServer();
    const client = server.client();
    const objects = ["A", "B", "C", "D", "E", "F"].map((n) => `ZCL_${n}`);

    const responses = await Promise.all(
      objects.map((obj) => client.request({ url: lockUrl(obj), method: "POST", qs: { _action: "LOCK" } })),
    );

    for (const res of responses) expect(res.status).toBe(200);
    const handles = responses.map((res) => /<LOCK_HANDLE>([0-9A-F]{40})<\/LOCK_HANDLE>/.exec(String(res.body))?.[1]);
    for (const h of handles) expect(h).toMatch(/^[0-9A-F]{40}$/);
    expect(new Set(handles).size).toBe(6);
    expect(server.violations).toEqual([]);
  });

  it("same object, same session, sequential LOCK -> UNLOCK -> LOCK by a second session succeeds; UNLOCK is 200 with a zero-byte body and no content-type", async () => {
    const server = new FakeAdtServer();
    const s1 = server.client();
    const s2 = server.client();
    const url = lockUrl("ZCL_SEQ");

    const lockRes = await s1.request({ url, method: "POST", qs: { _action: "LOCK" } });
    const handle = /<LOCK_HANDLE>([0-9A-F]{40})<\/LOCK_HANDLE>/.exec(String(lockRes.body))?.[1] ?? "";

    const unlockRes = await s1.request({ url, method: "POST", qs: { _action: "UNLOCK", lockHandle: handle } });
    expect(unlockRes.status).toBe(200);
    expect(unlockRes.body).toBe("");
    expect(unlockRes.body.length).toBe(0);
    expect(unlockRes.headers["content-type"]).toBeUndefined();

    const secondLockRes = await s2.request({ url, method: "POST", qs: { _action: "LOCK" } });
    expect(secondLockRes.status).toBe(200);
  });

  it("a lock handle minted in session 1 is rejected on PUT from session 2 (423), while UNLOCK from session 2 silently 200s without releasing", async () => {
    const server = new FakeAdtServer();
    const s1 = server.client();
    const s2 = server.client();
    const url = lockUrl("ZCL_XSESS");

    const lockRes = await s1.request({ url, method: "POST", qs: { _action: "LOCK" } });
    const handle = /<LOCK_HANDLE>([0-9A-F]{40})<\/LOCK_HANDLE>/.exec(String(lockRes.body))?.[1] ?? "";

    // UNLOCK is the asymmetric one: live-confirmed, it returns 200 even for a
    // handle it does not recognise. The lock is NOT released.
    const badUnlock = await s2.request({ url, method: "POST", qs: { _action: "UNLOCK", lockHandle: handle } });
    expect(badUnlock.status).toBe(200);
    expect(badUnlock.body).toBe("");
    expect(server.lockHolder(url)).toBe(s1.session.id);

    const badPut = await s2.request({ url, method: "PUT", qs: { lockHandle: handle }, body: "* new source" });
    expect(badPut.status).toBe(423);

    // The PUT is a genuine cross-session rejection; the UNLOCK is not
    // rejected at all, so it lands in the garbage-handle channel instead.
    const crossSession = server.violations.filter((v) => v.kind === "cross-session-lock-handle");
    expect(crossSession.length).toBe(1);
    expect(crossSession[0]?.sessionId).toBe(s2.session.id);
    expect(server.violations.filter((v) => v.kind === "unlock-garbage-handle-accepted").length).toBe(1);
  });

  /**
   * SAME-SESSION RE-LOCK. Expected: idempotent, or at worst a re-issued
   * handle. Captured live: a 403, with the IDENTICAL envelope as a genuine
   * cross-session conflict — same status, same type, same message, same
   * T100KEY EU 510.
   *
   * A pool therefore cannot ask "do I hold this?" by locking and reading the
   * status. It must track its own held locks.
   */
  it("re-LOCKing an object the SAME session already holds is a 403 (captured); full envelope identity and handle survival are ASSUMED", async () => {
    const server = new FakeAdtServer();
    const s1 = server.client();
    const url = lockUrl("ZCL_RELOCK");

    const first = await s1.request({ url, method: "POST", qs: { _action: "LOCK" } });
    expect(first.status).toBe(200);

    const again = await s1.request({ url, method: "POST", qs: { _action: "LOCK" } });
    expect(again.status).toBe(403);
    expect(again.body).toContain('<type id="ExceptionResourceNoAccess"/>');
    expect(again.body).toContain("User DEVELOPER is currently editing ZCL_RELOCK");

    // Everything above is CAPTURED (from a live probe table): status,
    // type and message text for the same-session re-LOCK.
    //
    // Everything below is UNCONFIRMED_ — it encodes an ASSUMPTION the fake
    // makes, not an observation. The probe table records status/type/message
    // for this case; the verbatim envelope including the <properties>/T100KEY
    // block is quoted only for the CROSS-session conflict case. We assume the
    // two envelopes are the same object. If that turns out false, this
    // assertion is the one that should change, and the fake with it.
    const s2 = server.client();
    const foreign = await s2.request({ url, method: "POST", qs: { _action: "LOCK" } });
    expect(foreign.status).toBe(again.status);
    expect(foreign.body).toBe(again.body);

    // UNCONFIRMED_: the probe table does not cover handle validity after a refused re-lock.
    // The fake keeps the first handle alive; SAP might instead invalidate it,
    // in which case a retrying pool would hold a dead handle and take a 423 on
    // its next PUT. Nothing downstream should rely on this line.
    const handle = /<LOCK_HANDLE>([0-9A-F]{40})<\/LOCK_HANDLE>/.exec(String(first.body))?.[1] ?? "";
    expect(server.lockHandleOwner(handle)).toBe(s1.session.id);
  });

  it("lock keys are normalised: a trailing slash, a case difference and a /source/main suffix all hit the SAME lock", async () => {
    // Keying on the raw pathname silently splits these into independent
    // locks, so a genuine conflict quietly does not conflict and the test
    // goes green. This is the single most dangerous failure this fake can
    // have, so it is asserted directly.
    const server = new FakeAdtServer();
    const s1 = server.client();
    const s2 = server.client();
    const url = lockUrl("ZCL_NORM");

    await s1.request({ url, method: "POST", qs: { _action: "LOCK" } });

    for (const variant of [`${url}/`, url.toUpperCase(), `${url}/source/main`]) {
      const res = await s2.request({ url: variant, method: "POST", qs: { _action: "LOCK" } });
      expect(res.status).toBe(403);
      // And the object name is the OBJECT, never "MAIN".
      expect(res.body).toContain("editing ZCL_NORM");
    }
  });

  it("a PUT without a lockHandle is 400 ExceptionParameterNotFound, distinct from the bad-handle 423", async () => {
    const server = new FakeAdtServer();
    const s1 = server.client();
    const url = lockUrl("ZCL_NOHANDLE");

    await s1.request({ url, method: "POST", qs: { _action: "LOCK" } });

    const noHandle = await s1.request({ url: `${url}/source/main`, method: "PUT", body: "* src" });
    expect(noHandle.status).toBe(400);
    expect(noHandle.body).toContain('<type id="ExceptionParameterNotFound"/>');

    const badHandle = await s1.request({
      url: `${url}/source/main`,
      method: "PUT",
      qs: { lockHandle: "DEADBEEF".repeat(5) },
      body: "* src",
    });
    expect(badHandle.status).toBe(423);
    expect(badHandle.body).toContain('<type id="ExceptionResourceInvalidLockHandle"/>');
  });

  it("UNLOCK with a garbage handle is a silent 200 — safe in a finally, but no evidence of release", async () => {
    const server = new FakeAdtServer();
    const s1 = server.client();
    const url = lockUrl("ZCL_GARBAGE");

    await s1.request({ url, method: "POST", qs: { _action: "LOCK" } });
    const res = await s1.request({ url, method: "POST", qs: { _action: "UNLOCK", lockHandle: "NOT_A_HANDLE" } });

    expect(res.status).toBe(200);
    expect(res.body).toBe("");
    // The 200 told you nothing: the lock is still held.
    expect(server.lockHolder(url)).toBe(s1.session.id);
    expect(server.violations.filter((v) => v.kind === "unlock-garbage-handle-accepted").length).toBe(1);
  });

  it("a session's own handle cannot PUT a DIFFERENT object", async () => {
    const server = new FakeAdtServer();
    const s1 = server.client();
    const lockRes = await s1.request({ url: lockUrl("ZCL_X"), method: "POST", qs: { _action: "LOCK" } });
    const handle = /<LOCK_HANDLE>([0-9A-F]{40})<\/LOCK_HANDLE>/.exec(String(lockRes.body))?.[1] ?? "";

    const res = await s1.request({
      url: `${lockUrl("ZCL_Y")}/source/main`,
      method: "PUT",
      qs: { lockHandle: handle },
      body: "* wrong object",
    });
    expect(res.status).toBe(423);
    expect(server.violations.filter((v) => v.kind === "unknown-lock-handle").length).toBe(1);
  });

  it("expire() releases the session's locks and makes its next request a 400 ICMENOSESSION", async () => {
    const server = new FakeAdtServer();
    const s1 = server.client();
    const s2 = server.client();
    const url = lockUrl("ZCL_EXPIRED");

    await s1.request({ url, method: "POST", qs: { _action: "LOCK" } });
    server.expire(s1.session.id);

    // The enqueue really is gone — a fresh session re-locks immediately.
    const relock = await s2.request({ url, method: "POST", qs: { _action: "LOCK" } });
    expect(relock.status).toBe(200);

    // The expired session gets the ICM page, not an exception, and NOT a throw.
    const res = await s1.request({ url: "/sap/bc/adt/discovery" });
    expect(res.status).toBe(400);
    expect(res.headers["x-sap-icm-err-id"]).toBe("ICMENOSESSION");
    expect(res.body).not.toContain("exc:exception");
    expect(server.violations.filter((v) => v.kind === "expired-session-request").length).toBe(1);
  });

  it("dropping a session releases its locks immediately: session 2's very next LOCK succeeds with no flush in between", async () => {
    const server = new FakeAdtServer();
    const s1 = server.client();
    const s2 = server.client();
    const url = lockUrl("ZCL_DROP");

    await s1.request({ url, method: "POST", qs: { _action: "LOCK" } });
    server.drop(s1.session.id);

    const res = await s2.request({ url, method: "POST", qs: { _action: "LOCK" } });
    expect(res.status).toBe(200);
  });

  it("requests on a dropped session reject with FakeAdtProtocolError and are still RECORDED", async () => {
    const server = new FakeAdtServer();
    const s1 = server.client();
    server.drop(s1.session.id);

    await expect(s1.request({ url: "/sap/bc/adt/discovery" })).rejects.toBeInstanceOf(FakeAdtProtocolError);

    // Recorded, not invisible: a test asserting "nothing was sent after drop"
    // must not pass vacuously, and `seq` must have no unexplained gap.
    expect(server.calls.length).toBe(1);
    expect(server.violations.filter((v) => v.kind === "dropped-session-request").length).toBe(1);
  });
});

// =============================================================================
// C. Per-session state isolation
// =============================================================================

describe("FakeAdtServer — per-session state isolation", () => {
  it("two sessions have distinct id, contextId and csrfToken", () => {
    const server = new FakeAdtServer();
    const s1 = server.client();
    const s2 = server.client();

    expect(s1.session.id).not.toBe(s2.session.id);
    expect(s1.session.contextId).not.toBe(s2.session.contextId);
    expect(s1.session.csrfToken).not.toBe(s2.session.csrfToken);
  });

  it("a CSRF fetch on session 1 returns session 1's token, and on session 2 returns session 2's token, without bleed", async () => {
    const server = new FakeAdtServer();
    const s1 = server.client();
    const s2 = server.client();

    const res1 = await s1.request({ url: "/sap/bc/adt/discovery", headers: { "x-csrf-token": "fetch" } });
    const res2 = await s2.request({ url: "/sap/bc/adt/discovery", headers: { "x-csrf-token": "fetch" } });

    expect(res1.headers["x-csrf-token"]).toBe(s1.session.csrfToken);
    expect(res2.headers["x-csrf-token"]).toBe(s2.session.csrfToken);
    expect(res1.headers["x-csrf-token"]).not.toBe(res2.headers["x-csrf-token"]);
  });

  it("the stateful flag is per session: setting it on session 1 leaves session 2's flag false", async () => {
    const server = new FakeAdtServer();
    const s1 = server.client();
    const s2 = server.client();

    await s1.request({ url: "/sap/bc/adt/discovery", headers: { "x-sap-adt-sessiontype": "stateful" } });

    expect(s1.session.stateful).toBe(true);
    expect(s2.session.stateful).toBe(false);
  });

  it("response set-cookie headers carry the session's own id and contextid", async () => {
    const server = new FakeAdtServer();
    const s1 = server.client();
    const s2 = server.client();

    const res1 = await s1.request({ url: "/sap/bc/adt/discovery" });
    const res2 = await s2.request({ url: "/sap/bc/adt/discovery" });

    const cookies1 = res1.headers["set-cookie"];
    const cookies2 = res2.headers["set-cookie"];
    expect(String(cookies1)).toContain(`${s1.session.id}-FAKE`);
    expect(String(cookies1)).toContain(s1.session.contextId);
    expect(String(cookies2)).toContain(`${s2.session.id}-FAKE`);
    expect(String(cookies2)).toContain(s2.session.contextId);
    expect(res1.headers["sap-contextid"]).toBe(s1.session.contextId);
    expect(res2.headers["sap-contextid"]).toBe(s2.session.contextId);
  });
});

// =============================================================================
// D. Stateful single-flight invariant
// =============================================================================

describe("FakeAdtServer — stateful single-flight invariant", () => {
  it('by DEFAULT ("record"), an overlap on one stateful session BLOCKS the second request, records a violation naming the conflicting seq, and assertNoViolations() throws', async () => {
    const server = new FakeAdtServer({ catchAll: okCatchAll });
    const client = server.client();
    await client.request({ url: "/sap/bc/adt/discovery", headers: { "x-sap-adt-sessiontype": "stateful" } });

    const gate = server.hold("/held");
    const first = client.request({ url: "/sap/bc/adt/held" });
    const parkedFirst = await gate.arrived; // first is now in flight, held open.

    const second = client.request({ url: "/sap/bc/adt/other" });
    await flushMicrotasks();

    // The default used to THROW here, on the model that SAP rejects a
    // concurrent request on a stateful session. Live refuted that: it does
    // not reject, it stalls. So the second request neither resolves nor
    // rejects while the first is held.
    expect(await settledOrPending(second)).toBe(PENDING);

    const overlapViolations = server.violations.filter((v) => v.kind === "concurrent-stateful-request");
    expect(overlapViolations.length).toBe(1);
    expect(overlapViolations[0]?.conflictingSeq).toBe(parkedFirst.seq); // seq of `first`
    expect(() => server.assertNoViolations()).toThrow(FakeAdtViolation);

    gate.release();
    await first;
    // Only once the first completes does the blocked one go through — intact.
    await expect(second).resolves.toMatchObject({ status: 200 });
  });

  it('with onStatefulOverlap "throw", the second overlapping request rejects immediately with a FakeAdtViolation', async () => {
    const server = new FakeAdtServer({ onStatefulOverlap: "throw", catchAll: okCatchAll });
    const client = server.client();
    await client.request({ url: "/sap/bc/adt/discovery", headers: { "x-sap-adt-sessiontype": "stateful" } });

    const gate = server.hold("/held");
    const first = client.request({ url: "/sap/bc/adt/held" });
    await gate.arrived;

    const second = client.request({ url: "/sap/bc/adt/other" });
    await expect(second).rejects.toBeInstanceOf(FakeAdtViolation);

    gate.release();
    await first;
  });

  it("two overlapping requests on TWO DIFFERENT stateful sessions produce no violation", async () => {
    const server = new FakeAdtServer({ catchAll: okCatchAll });
    const s1 = server.client();
    const s2 = server.client();
    await s1.request({ url: "/sap/bc/adt/discovery", headers: { "x-sap-adt-sessiontype": "stateful" } });
    await s2.request({ url: "/sap/bc/adt/discovery", headers: { "x-sap-adt-sessiontype": "stateful" } });

    const gate = server.hold("/held");
    const first = s1.request({ url: "/sap/bc/adt/held" });
    await gate.arrived;

    const second = s2.request({ url: "/sap/bc/adt/other" });
    await expect(second).resolves.toMatchObject({ status: 200 });

    gate.release();
    await first;

    expect(server.violations.filter((v) => v.kind === "concurrent-stateful-request")).toEqual([]);
  });

  it("a non-stateful session does not trip the single-flight invariant", async () => {
    const server = new FakeAdtServer({ catchAll: okCatchAll });
    const client = server.client(); // never sent the stateful header

    const gate = server.hold("/held");
    const first = client.request({ url: "/sap/bc/adt/held" });
    await gate.arrived;

    const second = client.request({ url: "/sap/bc/adt/other" });
    await expect(second).resolves.toMatchObject({ status: 200 });

    gate.release();
    await first;

    expect(server.violations.filter((v) => v.kind === "concurrent-stateful-request")).toEqual([]);
  });
});

// =============================================================================
// E. Long-poll modelling
// =============================================================================

describe("FakeAdtServer — long-poll modelling", () => {
  const pollUrl = "/sap/bc/adt/debugger/listeners/foo";

  it("a poll parks unsettled and shows up in server.pendingPolls", async () => {
    const server = new FakeAdtServer();
    const client = server.client();

    const p = client.request({ url: pollUrl, method: "POST" });
    await flushMicrotasks();

    expect(server.pendingPolls.length).toBe(1);
    expect(await settledOrPending(p)).toBe(PENDING);

    server.pendingPolls[0]?.timeout();
    await p;
  });

  /**
   * THE assertion that distinguishes the two models, and the reason this file
   * exists.
   *
   * Under the OLD (refuted) model, a same-session request killed the
   * outstanding poll: the poll settled with an empty 200 and the second
   * request then completed. Under the CORRECT model the poll is untouched —
   * it stays parked, and it is the SECOND request that cannot complete.
   *
   * The discriminator is the two `settledOrPending` checks below. Old model:
   * the poll would be settled and `other` resolved. New model: the poll is
   * still pending and `other` is PENDING. They cannot both hold, so this test
   * fails against a `killEmpty`-on-dispatch implementation.
   *
   * Both outcomes eventually return a 0-byte 200, which is exactly why the
   * wrong model survived — asserting only on the response shape cannot tell
   * them apart. Only the ORDERING can.
   */
  it("a same-session request does NOT kill a pending poll — it is head-of-line blocked until the poll settles", async () => {
    const server = new FakeAdtServer({ onStatefulOverlap: "record" });
    const client = server.client();

    // Make the session stateful, as a real debugger session is.
    await client.request({ url: "/sap/bc/adt/discovery", headers: { "x-sap-adt-sessiontype": "stateful" } });

    const pollPromise = client.request({ url: pollUrl, method: "POST" });
    await flushMicrotasks();
    expect(server.pendingPolls.length).toBe(1);

    const otherPromise = client.request({ url: "/sap/bc/adt/discovery" });
    await flushMicrotasks();

    // DISCRIMINATOR 1: the poll is STILL on the wire. The old model would
    // have settled it the moment `otherPromise` was dispatched.
    expect(server.pendingPolls.length).toBe(1);
    expect(await settledOrPending(pollPromise)).toBe(PENDING);

    // DISCRIMINATOR 2: the second request is the one that cannot finish. The
    // old model would have resolved it immediately.
    expect(await settledOrPending(otherPromise)).toBe(PENDING);

    // The poll now reaches its natural timeout and, as live measured, returns
    // FIRST — with the silent 0-byte shape that fooled everyone.
    server.pendingPolls[0]?.timeout();
    const pollRes = await pollPromise;
    expect(pollRes.status).toBe(200);
    expect(pollRes.body).toBe("");
    expect("content-type" in pollRes.headers).toBe(false);

    // And only THEN does the blocked request complete — with its correct
    // payload. Nothing was lost.
    const otherRes = await otherPromise;
    expect(otherRes.status).toBe(200);
    expect(otherRes.body).toBe("<service/>");

    // The blocking is a severe pool bug (seconds to minutes live), so it is
    // reported — but as a violation, never as an error on the wire.
    const overlaps = server.violations.filter((v) => v.kind === "concurrent-stateful-request");
    expect(overlaps.length).toBe(1);
    expect(overlaps[0]?.sessionId).toBe(client.session.id);
    expect(server.violations.some((v) => v.kind === "long-poll-preempted" as never)).toBe(false);
  });

  it("the poll returns before the request it blocked — the ordering, not just the outcome", async () => {
    const server = new FakeAdtServer();
    const client = server.client();
    await client.request({ url: "/sap/bc/adt/discovery", headers: { "x-sap-adt-sessiontype": "stateful" } });

    const order: string[] = [];
    const pollPromise = client.request({ url: pollUrl, method: "POST" }).then((r) => {
      order.push("poll");
      return r;
    });
    await flushMicrotasks();
    const otherPromise = client.request({ url: "/sap/bc/adt/discovery" }).then((r) => {
      order.push("other");
      return r;
    });
    await flushMicrotasks();

    server.pendingPolls[0]?.timeout();
    await Promise.all([pollPromise, otherPromise]);

    // Live, 3/3 trials: the listener returned first, at its own timeout, and
    // the blocked request a fraction of a second later.
    expect(order).toEqual(["poll", "other"]);
  });

  it("a different-session request leaves another session's pending poll untouched AND is not blocked by it", async () => {
    const server = new FakeAdtServer();
    const s1 = server.client();
    const s2 = server.client();

    const pollPromise = s1.request({ url: pollUrl, method: "POST" });
    await flushMicrotasks();
    expect(server.pendingPolls.length).toBe(1);

    // Live: 329 ms round trip on a different session while a poll was parked
    // — "no interference whatsoever". This must resolve, not block.
    await expect(s2.request({ url: "/sap/bc/adt/discovery" })).resolves.toMatchObject({ status: 200 });

    expect(await settledOrPending(pollPromise)).toBe(PENDING);
    expect(server.violations.filter((v) => v.kind === "concurrent-stateful-request")).toEqual([]);

    server.pendingPolls[0]?.timeout();
    await pollPromise;
  });

  it("DELETE on the listener path ends the poll with the same silent 0-byte shape", async () => {
    const server = new FakeAdtServer();
    const client = server.client();

    const pollPromise = client.request({ url: pollUrl, method: "POST" });
    await flushMicrotasks();
    expect(server.pendingPolls.length).toBe(1);

    await client.request({ url: pollUrl, method: "DELETE" });

    const res = await pollPromise;
    expect(res.status).toBe(200);
    expect(res.body).toBe("");
    expect(server.pendingPolls.length).toBe(0);
  });

  it("settling a poll twice throws rather than silently dropping a listener hit", async () => {
    const server = new FakeAdtServer();
    const client = server.client();

    const pollPromise = client.request({ url: pollUrl, method: "POST" });
    await flushMicrotasks();
    const poll = server.allPolls[0];
    poll?.timeout();
    await pollPromise;

    expect(() => poll?.timeout()).toThrow(/already settled/);
  });

  it("pendingPolls prunes settled polls; allPolls keeps the history", async () => {
    const server = new FakeAdtServer();
    const client = server.client();

    const pollPromise = client.request({ url: pollUrl, method: "POST" });
    await flushMicrotasks();
    expect(server.pendingPolls.length).toBe(1);

    server.pendingPolls[0]?.timeout();
    await pollPromise;

    expect(server.pendingPolls.length).toBe(0);
    expect(server.pollsFor(client.session.id).length).toBe(0);
    expect(server.allPolls.length).toBe(1);
  });

  it("a second global-scope listener for the same user is rejected with the 409 AdiFailed conflict", async () => {
    const server = new FakeAdtServer();
    const s1 = server.client();
    const s2 = server.client(); // same user, different session

    const pollPromise = s1.request({ url: pollUrl, method: "POST", qs: { debuggingMode: "user" } });
    await flushMicrotasks();
    expect(server.armedListeners.length).toBe(1);

    // A fresh terminalId does NOT evade it — the scope is the user.
    const res = await s2.request({
      url: pollUrl,
      method: "POST",
      qs: { debuggingMode: "user", terminalId: "BRAND_NEW_TERMINAL" },
    });
    expect(res.status).toBe(409);
    expect(res.body).toContain('<type id="AdiFailed"/>');
    expect(res.body).toContain("conflictDetected");
    expect(res.body).toContain("<entry key=\"T100KEY-NO\">530</entry>");
    expect(res.body).toContain("Another session already exists with global debugging scope for user DEVELOPER");

    server.pendingPolls[0]?.timeout();
    await pollPromise;

    // Once the first listener is gone, a second may arm.
    expect(server.armedListeners.length).toBe(0);
  });

  it("a different USER may arm a listener while another user's is armed", async () => {
    const server = new FakeAdtServer();
    const s1 = server.client("DEVELOPER");
    const s2 = server.client("TESTER");

    const p1 = s1.request({ url: pollUrl, method: "POST", qs: { debuggingMode: "user" } });
    await flushMicrotasks();
    const p2 = s2.request({ url: pollUrl, method: "POST", qs: { debuggingMode: "user" } });
    await flushMicrotasks();

    expect(server.pendingPolls.length).toBe(2);
    expect(server.armedListeners.map((a) => a.user).sort()).toEqual(["DEVELOPER", "TESTER"]);

    for (const poll of [...server.pendingPolls]) poll.timeout();
    await Promise.all([p1, p2]);
  });

  it("poll.resolve(res) delivers a real listener hit", async () => {
    const server = new FakeAdtServer();
    const client = server.client();

    const pollPromise = client.request({ url: pollUrl, method: "POST" });
    await flushMicrotasks();
    const poll = server.pendingPolls[0];
    expect(poll).toBeDefined();

    poll?.resolve({ status: 200, statusText: "OK", body: "<listenerHit/>", headers: { "content-type": "application/xml" } });

    const res = await pollPromise;
    expect(res.body).toBe("<listenerHit/>");
    expect(res.headers["content-type"]).toBe("application/xml");
  });

  it("server.drop() ends that session's polls with the same silent 0-byte shape", async () => {
    const server = new FakeAdtServer();
    const client = server.client();

    const pollPromise = client.request({ url: pollUrl, method: "POST" });
    await flushMicrotasks();

    server.drop(client.session.id);

    const res = await pollPromise;
    expect(res.status).toBe(200);
    expect(res.body).toBe("");
    expect(res.body.length).toBe(0);
    expect("content-type" in res.headers).toBe(false);
  });
});

// =============================================================================
// F. Error-shape fixtures
// =============================================================================

describe("FakeAdtServer — error-shape fixtures", () => {
  it("lockConflictXml / lockConflict403 produce the LIVE-captured shape — no localizedMessage, no LONGTEXT", () => {
    const res = lockConflict403({ user: "DEVELOPER", objectName: "ZCL_FOO" });
    expect(res.status).toBe(403);
    const body = lockConflictXml({ user: "DEVELOPER", objectName: "ZCL_FOO" });
    expect(res.body).toBe(body);
    expect(body).toContain('<type id="ExceptionResourceNoAccess"/>');
    expect(body).toContain('<entry key="T100KEY-ID">EU</entry>');
    expect(body).toContain('<entry key="T100KEY-NO">510</entry>');
    expect(body).toContain('<entry key="T100KEY-V1">DEVELOPER</entry>');
    expect(body).toContain('<entry key="T100KEY-V2">ZCL_FOO</entry>');
    expect(body).toContain("User DEVELOPER is currently editing ZCL_FOO");

    // The live capture has NEITHER of these. Earlier reconstructions assumed
    // both; asserting their absence is what keeps the fixture honest.
    expect(body).not.toContain("localizedMessage");
    expect(body).not.toContain("LONGTEXT");
  });

  it("lockConflictXmlReconstructed keeps the LONGTEXT variant, clearly separate from the live one", () => {
    const reconstructed = lockConflictXmlReconstructed({ user: "DEVELOPER", objectName: "ZCL_FOO" });
    expect(reconstructed).toContain('<entry key="LONGTEXT">');
    expect(reconstructed).toContain("localizedMessage");
    expect(reconstructed).not.toBe(lockConflictXml({ user: "DEVELOPER", objectName: "ZCL_FOO" }));
  });

  it("invalidLockHandle423 carries the live message text and is flagged as envelope-inferred", () => {
    const handle = "DEADBEEF".repeat(5);
    const res = invalidLockHandle423({ objectName: "ZMCPX_P1", handle });
    expect(res.status).toBe(423);
    expect(res.body).toContain('<type id="ExceptionResourceInvalidLockHandle"/>');
    expect(res.body).toContain(`Resource INCLUDE ZMCPX_P1 is not locked (invalid lock handle: ${handle})`);
    // Status/type/message are captured; the <properties> list is not.
    expect(res.headers[UNCONFIRMED_HEADER]).toBe("423-envelope-properties");
  });

  it("missingLockHandle400 is a DIFFERENT status and type from the bad-handle 423", () => {
    const res = missingLockHandle400();
    expect(res.status).toBe(400);
    expect(res.body).toContain('<type id="ExceptionParameterNotFound"/>');
    expect(res.body).toContain("Parameter lockHandle could not be found.");
    expect(res.status).not.toBe(invalidLockHandle423({ objectName: "X", handle: "Y" }).status);
  });

  it("listenerConflict409 is the AdiFailed / conflictDetected / SY 530 shape, not a lock conflict", () => {
    const res = listenerConflict409({ user: "DEVELOPER" });
    expect(res.status).toBe(409);
    expect(res.body).toContain('<type id="AdiFailed"/>');
    expect(res.body).toContain('<message lang="EN">An exception was raised</message>');
    expect(res.body).toContain('<entry key="com.sap.adt.communicationFramework.subType">conflictDetected</entry>');
    expect(res.body).toContain('<entry key="T100KEY-ID">SY</entry>');
    expect(res.body).toContain('<entry key="T100KEY-NO">530</entry>');
    expect(res.body).toContain('<entry key="ideUser">DEVELOPER</entry>');
    // Explicitly NOT a lock conflict — this was the old misfiling.
    expect(res.body).not.toContain("ExceptionResourceNoAccess");
    expect(res.body).not.toContain("T100KEY-ID\">EU");
  });

  it("sessionTimedOut400 is an ICM text/html page, not an exc:exception", () => {
    const res = sessionTimedOut400();
    expect(res.status).toBe(400);
    expect(res.statusText).toBe("Session timed out");
    expect(res.headers["x-sap-icm-err-id"]).toBe("ICMENOSESSION");
    expect(res.headers["sap-err-id"]).toBe("ICMENOSESSION");
    expect(res.headers["connection"]).toBe("close");
    expect(res.headers["content-type"]).toBe("text/html");
    // A classifier that only parses exc:exception XML cannot see this at all.
    expect(res.body).not.toContain("exc:exception");
    const cookies = res.headers["set-cookie"] as string[];
    expect(cookies.length).toBe(4);
    for (const c of cookies) expect(c).toContain("sap-contextid=0; expires=Thu, 01-Jan-1970");
  });

  it("CSRF_REQUIRED_403() is 403, text/plain, with the exact body and header", () => {
    const res = CSRF_REQUIRED_403();
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.headers["x-csrf-token"]).toBe("Required");
    expect(res.body).toBe("CSRF token validation failed");
  });

  it("UNCONFIRMED_SHAPES still names what is guessed, and no longer claims the 409 or the 423 are unknown", () => {
    // This registry only proves the BOOKKEEPING is in place — that each
    // remaining inference is named and has a rationale. It is not evidence
    // that any shape is correct; only a capture is.
    expect(UNCONFIRMED_SHAPES.length).toBeGreaterThan(0);
    for (const shape of UNCONFIRMED_SHAPES) {
      expect(shape.why.length).toBeGreaterThan(0);
      expect(shape.response().status).toBeGreaterThan(0);
    }

    // The live run resolved both entries that used to dominate this list: the
    // 409 turned out to be a debug-listener conflict rather than a lock
    // conflict, and the 423 that was assumed possibly-absent exists. What is
    // left is envelope detail, not whole responses.
    const names = UNCONFIRMED_SHAPES.map((s) => s.name).join(" ");
    expect(names).not.toContain("lockConflict409");
    expect(names).toContain("<properties>");
  });
});

// =============================================================================
// G. Determinism
// =============================================================================

describe("FakeAdtServer — determinism", () => {
  it("newLockHandle(seed) is stable for the same seed and differs across seeds", () => {
    expect(newLockHandle(42)).toBe(newLockHandle(42));
    expect(newLockHandle(1)).not.toBe(newLockHandle(2));
    expect(newLockHandle(42)).toMatch(/^[0-9A-F]{40}$/);
  });

  it("two freshly-constructed servers produce identical (seq-normalized) events logs for an identical script of requests — the anti-flake proof", async () => {
    async function runScript(): Promise<readonly string[]> {
      const server = new FakeAdtServer({ catchAll: okCatchAll });
      const client = server.client();
      const gate = server.hold("/scripted-hold");

      const p1 = client.request({ url: "/sap/bc/adt/scripted-hold" });
      const p2 = client.request({ url: "/sap/bc/adt/scripted-other" });
      await gate.arrived;
      await p2;
      gate.release();
      await p1;
      return server.events;
    }

    // `seq` is a GLOBAL, process-wide monotonic counter shared across every
    // FakeAdtServer instance (documented on FakeRequest.seq) — so a fresh
    // server does NOT restart it at 1, and two runScript() calls in the same
    // process legitimately get two different, non-overlapping seq ranges.
    // That is intentional design, not nondeterminism: the claim under test
    // here is that the SHAPE of the ordering log — which event kinds happen
    // in which order relative to the (however-numbered) requests — is
    // exactly reproducible. Normalizing each run's seq numbers to their
    // first-seen rank (1, 2, 3, ...) isolates that claim from the shared
    // counter.
    function normalizeSeq(events: readonly string[]): string[] {
      const rank = new Map<string, number>();
      let next = 1;
      return events.map((event) => {
        const [kind, seqStr, ...rest] = event.split(":");
        if (seqStr === undefined) return event;
        let n = rank.get(seqStr);
        if (n === undefined) {
          n = next++;
          rank.set(seqStr, n);
        }
        return [kind, String(n), ...rest].join(":");
      });
    }

    const eventsA = await runScript();
    const eventsB = await runScript();
    // Raw logs differ (different absolute seq ranges) — proving they truly
    // came from two independent runs, not a cached/memoized result.
    expect(eventsA).not.toEqual(eventsB);
    // But their NORMALIZED shape is identical, run after run.
    expect(normalizeSeq(eventsA)).toEqual(normalizeSeq(eventsB));
    expect(normalizeSeq(eventsA)).toEqual([
      "dispatch:1",
      "park:1",
      "dispatch:2",
      "respond:2:200",
      "release:1",
      "respond:1:200",
    ]);
  });
});

// =============================================================================
// H. Contract compatibility
// =============================================================================

describe("FakeAdtServer — satisfies the real HttpClient contract the production guard consumes", () => {
  it("drives one successful GET /sap/bc/adt/discovery through GuardedHttpClient and gets the fake's response back intact", async () => {
    const server = new FakeAdtServer();
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner: server.client() },
      new AuthCircuitBreaker(),
    );

    const res = await guard.request({ url: "/sap/bc/adt/discovery", method: "GET" });

    expect(res.status).toBe(200);
    expect(res.body).toBe("<service/>");
    expect(res.headers["content-type"]).toBe("application/xml");
  });
});
