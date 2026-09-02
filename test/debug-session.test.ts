/**
 * Offline unit tests for `src/debug/session.ts`. Zero live SAP calls —
 * every test runs against hand-rolled fakes for the layer directly beneath
 * `DebugSession`: a `FakeTransport` (implements `DebugRequestIssuer`) and a
 * `FakeListener` (implements `DebugListenIssuer`), exactly as
 * `test/debug-client.test.ts` fakes the layer beneath `DebugClient`.
 * `DebugSession` itself is always constructed with a REAL `DebugClient` built
 * from these fakes — never a fake `DebugClient`.
 *
 * Timer-driven behaviour (the idle timer, `armListener()`'s registration-poll
 * loop) uses `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` throughout
 * — never a real wait.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import type { DebugArmLock } from "../src/debug/arm-lock.js";
import { DebugClient, type DebugListenIssuer, type DebugRequestIssuer } from "../src/debug/client.js";
import {
  computeStateId,
  createDebugClientForConnection,
  DebugSession,
  listActiveDebugSessions,
  shutdownAllDebugSessions,
  type DebugSessionOptions,
} from "../src/debug/session.js";
import { ACQUIRE_NO_SESSION_LEASE, LONGPOLL_TIMEOUT_MARGIN_MS } from "../src/debug/transport.js";
import type { DebugRequestOptions, DebugSessionLease, LongPollHandle } from "../src/debug/transport.js";
import type { Breakpoint, DebugContext, DebugSettings, RawResponse } from "../src/debug/types.js";
import { SafetyGate } from "../src/safety.js";
import { LIVE_CAPTURED_DIR } from "./helpers/system-role-fake.js";

// `CreateDebugClientOptions.safety` is REQUIRED — every
// `createDebugClientForConnection` call below needs a gate even
// where the test itself has nothing to do with authorization (cookie
// rotation, long-poll defaults, etc.). This one permissive instance is reused
// everywhere none of those tests exercises gate behaviour directly.
const TEST_GATE = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

// ---------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------

const TERMINAL = "A".repeat(32);
const IDE = "B".repeat(32);
const CONTEXT: DebugContext = { debuggingMode: "user", terminalId: TERMINAL, ideId: IDE, requestUser: "DEV" };

// ---------------------------------------------------------------------------
// Fixture builders — adapted from test/debug-client.test.ts's fixtures and
// test/fixtures/debugger/{attach,step,stack,debuggee}.xml.
// ---------------------------------------------------------------------------

function attachXml(overrides: { debugSessionId?: string } = {}): string {
  const debugSessionId = overrides.debugSessionId ?? "session123";
  return `<?xml version="1.0" encoding="utf-8"?>
<dbg:attach xmlns:dbg="http://www.sap.com/adt/debugger"
  isRfc="false" isSameSystem="true" serverName="A4HSANDBOX_A4H_01"
  debugSessionId="${debugSessionId}" processId="42" isPostMortem="false"
  isUserAuthorizedForChanges="true" debuggeeSessionId="debuggee456" abapTraceState="OFF"
  canAdvancedTableFeatures="true" isNonExclusive="false" isNonExclusiveToggled="false"
  guiEditorGuid="" sessionTitle="TESTUSER"
  isSteppingPossible="true" isTerminationPossible="true">
  <dbg:actions/>
  <dbg:reachedBreakpoints/>
</dbg:attach>`;
}

function stepXml(
  overrides: { debugSessionId?: string; isSteppingPossible?: boolean; isTerminationPossible?: boolean } = {},
): string {
  const debugSessionId = overrides.debugSessionId ?? "session123";
  const isSteppingPossible = overrides.isSteppingPossible ?? true;
  const isTerminationPossible = overrides.isTerminationPossible ?? true;
  return `<?xml version="1.0" encoding="utf-8"?>
<dbg:step xmlns:dbg="http://www.sap.com/adt/debugger"
  isRfc="false" isSameSystem="true" serverName="A4HSANDBOX_A4H_01"
  debugSessionId="${debugSessionId}" processId="42" isDebuggeeChanged="false"
  isSteppingPossible="${isSteppingPossible}" isTerminationPossible="${isTerminationPossible}">
  <dbg:settings systemDebugging="false" createExceptionObject="false" backgroundRFC="false"
    sharedObjectDebugging="false" showDataAging="false" updateDebugging="false"/>
  <dbg:actions/>
  <dbg:reachedBreakpoints/>
</dbg:step>`;
}

function stackXml(overrides: { programName?: string; line?: number; stackPosition?: number } = {}): string {
  const programName = overrides.programName ?? "ZTEST_MCP_CRUD";
  const line = overrides.line ?? 15;
  const stackPosition = overrides.stackPosition ?? 1;
  return `<?xml version="1.0" encoding="utf-8"?>
<dbg:stack xmlns:dbg="http://www.sap.com/adt/debugger" isRfc="false" isSameSystem="true"
  serverName="A4HSANDBOX_A4H_01" debugCursorStackIndex="1">
  <dbg:stackEntry stackPosition="${stackPosition}" stackType="ABAP"
    stackUri="/sap/bc/adt/debugger/stack/type/ABAP/position/${stackPosition}"
    programName="${programName}" includeName="${programName}" line="${line}" eventType="REPORT"
    eventName="${programName}" sourceType="ABAP" systemProgram="false" isVit="false"
    uri="/sap/bc/adt/programs/programs/${programName}/source/main#start=${line}"/>
</dbg:stack>`;
}

function debuggeeXml(id = "ABC123"): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>
<STPDA_DEBUGGEE><CLIENT>001</CLIENT><DEBUGGEE_ID>${id}</DEBUGGEE_ID><TERMINAL_ID>${TERMINAL}</TERMINAL_ID>
<IDE_ID>${IDE}</IDE_ID><DEBUGGEE_USER>TESTUSER</DEBUGGEE_USER><PRG_CURR>ZTEST_MCP_CRUD</PRG_CURR>
<INCL_CURR>ZTEST_MCP_CRUD</INCL_CURR><LINE_CURR>15</LINE_CURR><RFCDEST></RFCDEST>
<APPLSERVER>A4HSANDBOX</APPLSERVER><SYSID>A4H</SYSID><SYSNR>0</SYSNR><TSTMP>20251205123456</TSTMP>
<DBGEE_KIND>DEBUGGEE</DBGEE_KIND><IS_ATTACH_IMPOSSIBLE></IS_ATTACH_IMPOSSIBLE><IS_SAME_SERVER>X</IS_SAME_SERVER>
<INSTANCE_NAME>A4H_01</INSTANCE_NAME></STPDA_DEBUGGEE></DATA></asx:values></asx:abap>`;
}

const VARIABLES_XML = `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>
<STPDA_ADT_VARIABLE><ID>SY-SUBRC</ID><NAME>SY-SUBRC</NAME><META_TYPE>simple</META_TYPE><VALUE>0</VALUE></STPDA_ADT_VARIABLE>
</DATA></asx:values></asx:abap>`;

/** Non-empty on purpose — a self-closing `<dbg:breakpoints/>` root parses to `""`, not an object, and would throw in `parseBreakpointsResponse`. */
const BREAKPOINTS_XML =
  `<?xml version="1.0"?><dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger">` +
  `<dbg:breakpoint kind="line" id="BP1"/></dbg:breakpoints>`;

const okResponse = (body = ""): RawResponse => ({ status: 200, headers: {}, body });

// ---------------------------------------------------------------------------
// FakeTransport — routes calls by "operation kind" (method + dispatcher
// `?method=` value, or a fixed path) to a scripted queue of thunks, mirroring
// debug-client.test.ts's FakeTransport (a `calls` log array; a responder that
// may throw an already-translated AbapError, exactly like that file's
// terminateDebuggee tests do). The LAST queued thunk for a kind repeats for
// any further call of that kind — handy for "always succeeds" scripts.
// ---------------------------------------------------------------------------

type OpKind =
  | "getListener"
  | "stopListener"
  | "setBreakpoints"
  | "attach"
  | "getStack"
  | "getVariables"
  | "getChildVariables"
  | "terminateDebuggee"
  | "step"
  | "other";

const STEP_KINDS = new Set([
  "stepInto",
  "stepOver",
  "stepReturn",
  "stepContinue",
  "stepRunToLine",
  "stepJumpToLine",
]);

function classify(opts: DebugRequestOptions): OpKind {
  const { method, path } = opts;
  if (path.includes("/debugger/listeners")) return method === "DELETE" ? "stopListener" : "getListener";
  if (path.includes("/debugger/breakpoints")) return "setBreakpoints";
  if (path.includes("/debugger/stack")) return "getStack";
  const methodParam = /[?&]method=([^&]+)/.exec(path)?.[1];
  if (methodParam === "attach") return "attach";
  if (methodParam === "terminateDebuggee") return "terminateDebuggee";
  if (methodParam === "getVariables") return "getVariables";
  if (methodParam === "getChildVariables") return "getChildVariables";
  if (methodParam && STEP_KINDS.has(decodeURIComponent(methodParam))) return "step";
  return "other";
}

type Thunk = () => RawResponse;

class FakeTransport implements DebugRequestIssuer {
  public readonly calls: DebugRequestOptions[] = [];
  private readonly counts = new Map<OpKind, number>();

  constructor(private readonly scripts: Partial<Record<OpKind, Thunk[]>>) {}

  async request(opts: DebugRequestOptions): Promise<RawResponse> {
    this.calls.push(opts);
    const kind = classify(opts);
    const n = this.counts.get(kind) ?? 0;
    this.counts.set(kind, n + 1);
    const list = this.scripts[kind];
    if (!list || list.length === 0) {
      throw new Error(`FakeTransport: no script configured for "${kind}" (${opts.method} ${opts.path}), call #${n}`);
    }
    const thunk = list[Math.min(n, list.length - 1)]!;
    return thunk();
  }

  callsOf(kind: OpKind): DebugRequestOptions[] {
    return this.calls.filter((c) => classify(c) === kind);
  }
}

const LISTENER_ABSENT: Thunk = () => {
  throw new AbapError("NOT_FOUND", "no listener registered");
};
const LISTENER_EXISTS: Thunk = () => okResponse("");
const OK: Thunk = () => okResponse("");
const BREAKPOINTS_OK: Thunk = () => okResponse(BREAKPOINTS_XML);
const TERMINATE_OK: Thunk = () => okResponse("");
/** The 500-is-success shape — see debug-client.test.ts's terminateDebuggee tests. */
const TERMINATE_500_SUCCESS: Thunk = () => {
  throw new AbapError("ADT_ERROR", "boom", { status: 500, subtype: "terminateDebuggee" });
};
const attachOk =
  (debugSessionId = "S1"): Thunk =>
  () =>
    okResponse(attachXml({ debugSessionId }));
const stepOk =
  (overrides: { debugSessionId?: string; isSteppingPossible?: boolean; isTerminationPossible?: boolean } = {}): Thunk =>
  () =>
    okResponse(stepXml(overrides));
const stackOk =
  (overrides: { programName?: string; line?: number; stackPosition?: number } = {}): Thunk =>
  () =>
    okResponse(stackXml(overrides));
const variablesOk: Thunk = () => okResponse(VARIABLES_XML);

// ---------------------------------------------------------------------------
// FakeListener — implements DebugListenIssuer. `result` is a controllable
// deferred promise so a test can resolve it whenever it likes (a caught
// debuggee, a conflict, a timeout) — mirrors debug-client.test.ts's
// FakeListener, but with a settable result instead of a fixed one.
// ---------------------------------------------------------------------------

class FakeListener implements DebugListenIssuer {
  public lastPath?: string;
  public abortCount = 0;
  private resolveFn!: (r: RawResponse) => void;
  private readonly deferred: Promise<RawResponse>;

  constructor() {
    this.deferred = new Promise<RawResponse>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  listen(path: string): LongPollHandle {
    this.lastPath = path;
    return {
      armed: Promise.resolve(),
      result: this.deferred,
      abort: () => {
        this.abortCount++;
      },
      aborted: false,
    };
  }

  resolveWith(r: RawResponse): void {
    this.resolveFn(r);
  }
}

// ---------------------------------------------------------------------------
// Session factory
// ---------------------------------------------------------------------------

function makeSession(opts: {
  transport: FakeTransport;
  listener?: FakeListener;
  sessionOpts?: Partial<Omit<DebugSessionOptions, "client" | "context">>;
}): DebugSession {
  const listener = opts.listener ?? new FakeListener();
  const client = new DebugClient({ transport: opts.transport, longPoll: listener });
  return new DebugSession({
    client,
    context: CONTEXT,
    registrationPollIntervalMs: 50,
    registrationPollTimeoutMs: 500,
    idleTimeoutMs: 100_000,
    ...opts.sessionOpts,
  });
}

/** Drains any microtask chains left dangling by a fire-and-forget `void this.terminate(...)` call (the idle timer's callback). */
async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. Happy-path lifecycle
// ---------------------------------------------------------------------------

describe("happy-path lifecycle", () => {
  it("idle -> listening -> caught -> suspended -> dead, with the terminate cleanup calls actually issued", async () => {
    const transport = new FakeTransport({
      getListener: [LISTENER_ABSENT, LISTENER_EXISTS],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
      attach: [attachOk("S1")],
      getStack: [stackOk(), stackOk(), stackOk()],
      getVariables: [variablesOk],
      step: [stepOk({ debugSessionId: "S1" })],
      terminateDebuggee: [TERMINATE_OK],
    });
    const listener = new FakeListener();
    const session = makeSession({ transport, listener });

    expect(session.snapshot.status).toBe("idle");

    await session.prepareBreakpoints([{ kind: "statement", statement: "WRITE" }]);

    await session.armListener();
    expect(session.snapshot.status).toBe("listening");
    // REGRESSION GUARD (live-proven): armListener must NOT probe the listener endpoint. A second request on
    // the SAME ADT stateful session is head-of-line blocked behind the
    // outstanding long-poll for the remainder of its timeout, never cancels it.
    expect(transport.callsOf("getListener")).toHaveLength(0);

    listener.resolveWith(okResponse(debuggeeXml("D1")));
    const listenResult = await session.waitForDebuggee();
    expect(listenResult.kind).toBe("debuggee");
    expect(session.snapshot.status).toBe("caught");
    expect(session.snapshot.debuggeeId).toBe("D1");

    const attachResult = await session.attach("D1");
    expect(session.snapshot.status).toBe("suspended");
    const stateId1 = attachResult.stateId;
    expect(stateId1).toBeTruthy();

    await session.getStack(stateId1);
    await session.getVariables(stateId1, ["SY-SUBRC"]);

    const stepResult = await session.step(stateId1, "stepOver");
    expect(stepResult.stateId).not.toBe(stateId1);
    expect(session.snapshot.status).toBe("suspended");

    await session.terminate();
    expect(session.snapshot.status).toBe("dead");
    expect(session.snapshot.deathReason).toBe("terminated_by_caller");
    // 5.7: nothing timed out during this clean terminate, so there is nothing
    // to report — the field stays absent rather than an empty array.
    expect(session.snapshot.abandonedCleanupSteps).toBeUndefined();

    expect(transport.callsOf("stopListener")).toHaveLength(1);
    expect(transport.callsOf("stopListener")[0]!.method).toBe("DELETE");
    // Shutdown removes this session's own breakpoint with a TARGETED DELETE,
    // never the unscoped `syncScope mode="full"` + empty list POST
    // that used to live here — that one deletes every external breakpoint the
    // SAP user owns. See the dedicated describe block below.
    const clearCall = transport.callsOf("setBreakpoints").at(-1)!;
    expect(clearCall.method).toBe("DELETE");
    expect(clearCall.path).toContain("/debugger/breakpoints/BP1");
  });
});

// ---------------------------------------------------------------------------
// 2. Registration-confirmation blocks the "trigger"
// ---------------------------------------------------------------------------

describe("armListener() must not probe the listener it just armed", () => {
  /*
   * These replace two tests that pinned a `getListener()` confirmation loop.
   * That loop was the reason the listener NEVER worked, live-proven on A4H
   * with two probes:
   *
   *   - confirm GET on the SAME  session -> head-of-line blocked for 55 402 ms
   *     (the whole remaining timeout of the listener it was confirming), which
   *     itself survived, untouched, to its own natural timeout — HTTP 200,
   *     0-byte body (a 2026-07-31 capture
   *     had misread this same stall as the listener dying at ~6.9s)
   *   - confirm GET on a FRESH   session -> unaffected, ~171-329 ms
   *
   * A second request on the same ADT stateful session is head-of-line blocked
   * behind the outstanding long-poll for the remainder of its timeout — the
   * loop never killed the listener it was confirming, it just never got a
   * timely answer — and `parseListenResult` mapped the eventual empty body to
   * `{kind:"timeout"}` either way, so the multi-minute stall it caused was
   * silent. The old tests passed happily while the feature was broken, because
   * the fake transport has no notion of session-scoped blocking.
   */

  it("resolves on dispatch without issuing a single getListener call", async () => {
    const transport = new FakeTransport({
      // Deliberately stocked: if arming ever probes again, it finds a canned
      // 'exists' and the ONLY thing that fails is the call-count assertion below.
      getListener: [LISTENER_EXISTS, LISTENER_EXISTS, LISTENER_EXISTS],
    });
    const listener = new FakeListener();
    const session = makeSession({ transport, listener });

    // No timer advancing: arming must not depend on any poll/sleep cycle.
    await session.armListener();

    expect(session.snapshot.status).toBe("listening");
    expect(transport.callsOf("getListener")).toHaveLength(0);
  });

  it("leaves the armed listener intact — no abort, no DELETE", async () => {
    const transport = new FakeTransport({
      getListener: [LISTENER_ABSENT], // repeats forever; must never be consulted
      stopListener: [OK],
    });
    const listener = new FakeListener();
    const session = makeSession({ transport, listener });

    await session.armListener();

    // The old code aborted the handle and DELETEd the listener whenever the
    // confirmation loop timed out. With a live SAP session that path fired on a
    // perfectly healthy listener, tearing down the thing that was about to catch
    // the debuggee.
    expect(listener.abortCount).toBe(0);
    expect(transport.callsOf("stopListener")).toHaveLength(0);
    expect(transport.callsOf("getListener")).toHaveLength(0);
    expect(session.snapshot.status).toBe("listening");
  });
});

// ---------------------------------------------------------------------------
// 3. Idle timeout actually fires and actually cleans up
// ---------------------------------------------------------------------------

describe("idle timeout", () => {
  it("fires on its own (no call, no keepalive) and runs the full guaranteed-cleanup sequence", async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk()],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const session = makeSession({ transport, sessionOpts: { idleTimeoutMs: 50 } });

    await session.attach("D1");
    expect(session.snapshot.status).toBe("suspended");

    await vi.advanceTimersByTimeAsync(60);
    await flushMicrotasks();

    expect(session.snapshot.status).toBe("dead");
    expect(session.snapshot.deathReason).toBe("idle_timeout");
    expect(transport.callsOf("terminateDebuggee")).toHaveLength(1);
    expect(transport.callsOf("stopListener")).toHaveLength(1);
    // This session never armed a breakpoint, so it owns none and touches none.
    // "Nothing of ours to clean up" must never widen into "clean up everyone's".
    expect(transport.callsOf("setBreakpoints")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. keepalive() extends the deadline
// ---------------------------------------------------------------------------

describe("keepalive()", () => {
  it("resets the idle deadline so the session survives past the original timeout", async () => {
    const transport = new FakeTransport({ attach: [attachOk()], getStack: [stackOk()] });
    const session = makeSession({ transport, sessionOpts: { idleTimeoutMs: 100 } });

    await session.attach("D1");
    await vi.advanceTimersByTimeAsync(80); // just short of 100
    expect(session.snapshot.status).toBe("suspended");

    session.keepalive();
    await vi.advanceTimersByTimeAsync(80); // would be 160 since attach() if NOT reset — still alive
    expect(session.snapshot.status).toBe("suspended");
    expect(session.snapshot.deathReason).toBeUndefined();
  });

  it("throws BAD_INPUT when called while status is 'idle'", () => {
    const transport = new FakeTransport({});
    const session = makeSession({ transport });
    expect(session.snapshot.status).toBe("idle");
    expect(() => session.keepalive()).toThrow(AbapError);
    try {
      session.keepalive();
      expect.unreachable("keepalive() should have thrown");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("BAD_INPUT");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Every ordinary call also resets the idle timer ("touch")
// ---------------------------------------------------------------------------

describe("idle timer 'touch' on ordinary calls", () => {
  it("getStack() resets the idle deadline just like keepalive() would", async () => {
    const transport = new FakeTransport({ attach: [attachOk()], getStack: [stackOk(), stackOk()] });
    const session = makeSession({ transport, sessionOpts: { idleTimeoutMs: 100 } });

    const { stateId } = await session.attach("D1");
    await vi.advanceTimersByTimeAsync(80);
    await session.getStack(stateId);
    await vi.advanceTimersByTimeAsync(80);

    expect(session.snapshot.status).toBe("suspended");
  });
});

// ---------------------------------------------------------------------------
// 6. Stale stateId is rejected, never silently answered
// ---------------------------------------------------------------------------

describe("stale stateId rejection", () => {
  it("getStack() with a stale stateId throws BAD_INPUT naming the CURRENT stateId", async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk({ line: 15 }), stackOk({ line: 16 })],
      step: [stepOk()],
    });
    const session = makeSession({ transport });

    const { stateId: stateId1 } = await session.attach("D1");
    const { stateId: stateId2 } = await session.step(stateId1, "stepOver");
    expect(stateId2).not.toBe(stateId1);

    await expect(session.getStack(stateId1)).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e) || e.code !== "BAD_INPUT") return false;
      expect(e.message).toContain(stateId2);
      expect(e.details["currentStateId"]).toBe(stateId2);
      expect(e.details["providedStateId"]).toBe(stateId1);
      return true;
    });
  });

  it("getVariables() with a stale stateId also throws BAD_INPUT naming the CURRENT stateId", async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk({ line: 15 }), stackOk({ line: 16 })],
      step: [stepOk()],
    });
    const session = makeSession({ transport });

    const { stateId: stateId1 } = await session.attach("D1");
    const { stateId: stateId2 } = await session.step(stateId1, "stepOver");

    await expect(session.getVariables(stateId1, ["SY-SUBRC"])).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e) || e.code !== "BAD_INPUT") return false;
      expect(e.message).toContain(stateId2);
      expect(e.details["currentStateId"]).toBe(stateId2);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Death detection, signal A (error path)
// ---------------------------------------------------------------------------

describe("death detection — signal A (thrown SESSION_DEAD/NOT_CONNECTED)", () => {
  it("marks the session dead (debuggee_finished) and rethrows the ORIGINAL error", async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [
        stackOk(),
        () => {
          throw new AbapError("SESSION_DEAD", "Session Timed Out");
        },
      ],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const session = makeSession({ transport });

    const { stateId } = await session.attach("D1");
    await expect(session.getStack(stateId)).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "SESSION_DEAD" && e.message === "Session Timed Out",
    );

    expect(session.snapshot.status).toBe("dead");
    expect(session.snapshot.deathReason).toBe("debuggee_finished");
  });

  it("also applies to NOT_CONNECTED thrown from step()", async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk()],
      step: [
        () => {
          throw new AbapError("NOT_CONNECTED", "no session attached");
        },
      ],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const session = makeSession({ transport });

    const { stateId } = await session.attach("D1");
    await expect(session.step(stateId, "stepOver")).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "NOT_CONNECTED",
    );

    expect(session.snapshot.status).toBe("dead");
    expect(session.snapshot.deathReason).toBe("debuggee_finished");
  });
});

// ---------------------------------------------------------------------------
// 8. Death detection, signal B (success path, no error at all)
// ---------------------------------------------------------------------------

describe("death detection — signal B (isSteppingPossible/isTerminationPossible false on a 200)", () => {
  it("step() returns NORMALLY but session.snapshot.deathReason is 'debuggee_finished' afterward", async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk(), stackOk()],
      step: [stepOk({ isSteppingPossible: false, isTerminationPossible: false })],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const session = makeSession({ transport });

    const { stateId } = await session.attach("D1");
    const result = await session.step(stateId, "stepOver"); // must NOT throw

    expect(result.step.isSteppingPossible).toBe(false);
    expect(session.snapshot.status).toBe("dead");
    expect(session.snapshot.deathReason).toBe("debuggee_finished");
  });
});

// ---------------------------------------------------------------------------
// Defect 3 (2026-08, live testing): a crashing statement (a failing ASSERT) was
// observed producing a step response that looks like an ordinary clean suspended
// stop — signals A and B both clean — with the death only surfacing on the CALLER'S
// NEXT step. `step()` now issues one extra, best-effort `getStack()` read (through
// the same signal-A path) before returning, specifically to close that one-response
// lag. See session.ts's `step()` doc comment and the "Defect 3 mitigation" block
// inside it for the full reasoning, including the honestly-flagged fact that whether
// this closes the REAL live lag has not been confirmed against SAP.
// ---------------------------------------------------------------------------

describe("Defect 3 — post-step verification catches a lagging death signal within THIS step's response", () => {
  it("a step whose own getStack looks clean, but an immediate extra getStack throws SESSION_DEAD, is reported dead by the SAME step() call — not the next one", async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      // #0 attach's stack, #1 step's own post-step read (clean), #2 the Defect-3
      // verification read (this is where the lag reveals itself).
      getStack: [
        stackOk(),
        stackOk({ line: 90 }),
        () => {
          throw new AbapError("SESSION_DEAD", "Session Timed Out");
        },
      ],
      step: [stepOk()], // isSteppingPossible/isTerminationPossible both true — Signal B does NOT fire
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const session = makeSession({ transport });

    const { stateId } = await session.attach("D1");
    const result = await session.step(stateId, "stepOver"); // must NOT throw

    // The step's own flags genuinely looked clean — this is exactly the confusing
    // shape the defect report described.
    expect(result.step.isSteppingPossible).toBe(true);
    // But by the time THIS call returns, the extra read has already caught the death.
    expect(session.snapshot.status).toBe("dead");
    expect(session.snapshot.deathReason).toBe("debuggee_finished");
    expect(transport.callsOf("getStack")).toHaveLength(3);
  });

  it("does not issue the extra read when Signal B already marked the session dead", async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk(), stackOk()],
      step: [stepOk({ isSteppingPossible: false, isTerminationPossible: false })],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const session = makeSession({ transport });

    const { stateId } = await session.attach("D1");
    await session.step(stateId, "stepOver");

    // Exactly the attach read plus step's own read — no third, Defect-3 read, because
    // Signal B already established the session was dead before that point ran.
    expect(transport.callsOf("getStack")).toHaveLength(2);
  });

  it("a non-death failure of the extra read is logged, not thrown — the already-successful step is still returned", async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [
        stackOk(),
        stackOk({ line: 90 }),
        () => {
          throw new AbapError("ADT_ERROR", "transient network blip", { status: 500 });
        },
      ],
      step: [stepOk()],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const session = makeSession({ transport });

    const { stateId } = await session.attach("D1");
    const result = await session.step(stateId, "stepOver"); // must NOT throw

    expect(result.stack.frames[0]!.line).toBe(90); // the real (first) post-step read, untouched
    expect(session.snapshot.status).toBe("suspended"); // NOT marked dead — this wasn't a death signal
    expect(transport.callsOf("getStack")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Defect 4 (2026-08): `DebugTerminationResult` replaces prose-only `deathDetail`
// with one structured variant per death, chosen only from evidence this module
// actually has (see session.ts's `DebugTerminationResult` doc comment).
// ---------------------------------------------------------------------------

describe("Defect 4 — DebugTerminationResult, one structured variant per death", () => {
  it('Signal B (clean, nothing thrown) yields kind "finished" — the only variant entitled to claim it', async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk(), stackOk()],
      step: [stepOk({ isSteppingPossible: false, isTerminationPossible: false })],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const session = makeSession({ transport });
    const { stateId } = await session.attach("D1");
    await session.step(stateId, "stepOver");

    expect(session.snapshot.terminationResult).toEqual({
      kind: "finished",
      detail: "isSteppingPossible/isTerminationPossible reported false after step (signal B).",
    });
  });

  it('Signal A carrying exceptionClassNames yields kind "exception", with the class names and bodyExcerpt preserved verbatim', async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [
        stackOk(),
        () => {
          throw new AbapError(
            "SESSION_DEAD",
            "The ABAP debug session no longer exists.",
            {
              exceptionClassNames: ["CX_TPDA_SYS_COMM_DBGSESSIONEND"],
              bodyExcerpt: "<exception>CX_TPDA_SYS_COMM_DBGSESSIONEND</exception>",
            },
          );
        },
      ],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const session = makeSession({ transport });
    const { stateId } = await session.attach("D1");
    await expect(session.getStack(stateId)).rejects.toThrow();

    expect(session.snapshot.terminationResult).toEqual({
      kind: "exception",
      exceptionClassNames: ["CX_TPDA_SYS_COMM_DBGSESSIONEND"],
      bodyExcerpt: "<exception>CX_TPDA_SYS_COMM_DBGSESSIONEND</exception>",
      detail: "The ABAP debug session no longer exists.",
    });
  });

  it('Signal A with NO exceptionClassNames yields kind "session_ended" — the undocumented "fourth shape", never mislabelled "finished"', async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [
        stackOk(),
        () => {
          throw new AbapError("SESSION_DEAD", "Session Timed Out");
        },
      ],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const session = makeSession({ transport });
    const { stateId } = await session.attach("D1");
    await expect(session.getStack(stateId)).rejects.toThrow();

    expect(session.snapshot.terminationResult).toEqual({
      kind: "session_ended",
      bodyExcerpt: undefined,
      detail: "Session Timed Out",
    });
  });

  it('idle_timeout yields kind "idle_timeout" with thresholdMs equal to the CONFIGURED budget, never an inferred/parsed number', async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk()],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const session = makeSession({ transport, sessionOpts: { idleTimeoutMs: 50 } });
    await session.attach("D1");

    await vi.advanceTimersByTimeAsync(60);
    await flushMicrotasks();

    expect(session.snapshot.terminationResult).toEqual({
      kind: "idle_timeout",
      thresholdMs: 50,
      detail: "No debugger activity for 50ms.",
    });
  });

  it('an explicit terminate() call yields kind "terminated_by_caller"', async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk()],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const session = makeSession({ transport });
    await session.attach("D1");
    await session.terminate("terminated_by_caller", "user-requested stop");

    expect(session.snapshot.terminationResult).toEqual({
      kind: "terminated_by_caller",
      detail: "user-requested stop",
    });
  });
});

// ---------------------------------------------------------------------------
// 9. terminateDebuggee's 500-is-success shape does not break session.terminate()
// ---------------------------------------------------------------------------

describe("terminateDebuggee 500-is-success unwrap at the session level", () => {
  it("terminate() completes cleanly and reports terminated_by_caller, not a session-level error", async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk()],
      terminateDebuggee: [TERMINATE_500_SUCCESS],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const session = makeSession({ transport });

    await session.attach("D1");
    await expect(session.terminate()).resolves.toBeUndefined();

    expect(session.snapshot.status).toBe("dead");
    expect(session.snapshot.deathReason).toBe("terminated_by_caller");
  });
});

// ---------------------------------------------------------------------------
// 10. Cleanup-on-failure — caught but never properly attached
// ---------------------------------------------------------------------------

describe("cleanup on failure — caught but never attached", () => {
  it("terminate() still runs the full best-effort cleanup and best-effort re-attaches first", async () => {
    const transport = new FakeTransport({
      getListener: [LISTENER_EXISTS],
      attach: [
        () => {
          throw new AbapError("ADT_ERROR", "attach failed for a real (non-invalidDebuggee) reason", { status: 500 });
        },
        () => {
          throw new AbapError("ADT_ERROR", "best-effort re-attach during terminate also failed", { status: 500 });
        },
      ],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const listener = new FakeListener();
    const session = makeSession({ transport, listener });

    await session.armListener();
    listener.resolveWith(okResponse(debuggeeXml("D1")));
    const listenResult = await session.waitForDebuggee();
    expect(listenResult.kind).toBe("debuggee");
    expect(session.snapshot.status).toBe("caught");

    await expect(session.attach("D1")).rejects.toSatisfy((e: unknown) => isAbapError(e) && e.code === "ADT_ERROR");
    expect(session.snapshot.status).toBe("caught"); // never reached "suspended"

    await session.terminate();

    expect(session.snapshot.status).toBe("dead");
    expect(session.snapshot.deathReason).toBe("terminated_by_caller");
    // The explicit failed attach() PLUS doTerminate()'s best-effort internal retry.
    expect(transport.callsOf("attach")).toHaveLength(2);
    expect(transport.callsOf("stopListener")).toHaveLength(1);
    // No breakpoint was ever armed by this session, so cleanup issues no
    // breakpoint call at all — not even a "harmless" clear.
    expect(transport.callsOf("setBreakpoints")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 10b. Double-attach ("Debuggee already attached") recovery — REGRESSION GUARD
//
// Live-proven 2026-07-31: the recovery keys off `details.subtype ===
// "invalidDebuggee"` and nothing else, so it must fire no matter which
// `translateDebugError` branch classified the error. It used to work only for
// the fallback ADT_ERROR branch, because SESSION_DEAD/401/NOT_FOUND dropped
// `subtype` from `details` on the way through. The errors thrown below are the
// exact objects `translateDebugError` now produces for those branches.
// ---------------------------------------------------------------------------

/** What translateDebugError's SESSION_DEAD branch now yields for a double attach. */
const ATTACH_ALREADY_SESSION_DEAD: Thunk = () => {
  throw new AbapError("SESSION_DEAD", "Debuggee already attached", {
    status: 500,
    subtype: "invalidDebuggee",
    path: "/sap/bc/adt/debugger",
  });
};

describe("double-attach recovery is branch-independent", () => {
  it("attach() recovers via getStack() when the error arrives as SESSION_DEAD carrying subtype invalidDebuggee", async () => {
    const transport = new FakeTransport({
      attach: [ATTACH_ALREADY_SESSION_DEAD],
      getStack: [stackOk({ programName: "ZTEST_MCP_CRUD", line: 15 })],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const session = makeSession({ transport });

    const { stack, stateId } = await session.attach("D1");

    expect(stack.frames[0]?.programName).toBe("ZTEST_MCP_CRUD");
    expect(stateId).toBeTruthy();
    expect(session.snapshot.status).toBe("suspended");
    expect(transport.callsOf("getStack")).toHaveLength(1);
  });

  it("the shutdown attach-before-terminate treats it as benign, not a cleanup failure", async () => {
    const logs: string[] = [];
    const transport = new FakeTransport({
      getListener: [LISTENER_EXISTS],
      attach: [
        () => {
          throw new AbapError("ADT_ERROR", "attach failed for a real (non-invalidDebuggee) reason", { status: 500 });
        },
        ATTACH_ALREADY_SESSION_DEAD, // the best-effort re-attach during terminate
      ],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const listener = new FakeListener();
    const session = makeSession({ transport, listener, sessionOpts: { log: (m) => logs.push(m) } });

    await session.armListener();
    listener.resolveWith(okResponse(debuggeeXml("D1")));
    await session.waitForDebuggee();
    await expect(session.attach("D1")).rejects.toSatisfy((e: unknown) => isAbapError(e) && e.code === "ADT_ERROR");

    await session.terminate();

    expect(session.snapshot.deathReason).toBe("terminated_by_caller");
    // Already attached is exactly what this step wanted — no scary cleanup log...
    expect(logs.filter((m) => m.includes("attach-before-terminate") && m.includes("failed"))).toEqual([]);
    // ...and the terminateDebuggee it exists to enable still ran.
    expect(transport.callsOf("terminateDebuggee")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 11. computeStateId — pure function
// ---------------------------------------------------------------------------

describe("computeStateId", () => {
  const base = { debugSessionId: "S1", stackPosition: 1, program: "ZFOO", line: 10, stepCounter: 0 };

  it("is deterministic — same input twice produces the same hash", () => {
    expect(computeStateId(base)).toBe(computeStateId({ ...base }));
  });

  it("changing debugSessionId changes the output", () => {
    expect(computeStateId({ ...base, debugSessionId: "S2" })).not.toBe(computeStateId(base));
  });

  it("changing stackPosition changes the output", () => {
    expect(computeStateId({ ...base, stackPosition: 2 })).not.toBe(computeStateId(base));
  });

  it("changing program changes the output", () => {
    expect(computeStateId({ ...base, program: "ZBAR" })).not.toBe(computeStateId(base));
  });

  it("changing line changes the output", () => {
    expect(computeStateId({ ...base, line: 11 })).not.toBe(computeStateId(base));
  });

  it("changing stepCounter changes the output", () => {
    expect(computeStateId({ ...base, stepCounter: 1 })).not.toBe(computeStateId(base));
  });
});

// ---------------------------------------------------------------------------
// Extra: step() rejects "terminateDebuggee" as a step kind; armListener()
// rejects a second call while already "listening".
// ---------------------------------------------------------------------------

describe("additional load-bearing behaviour", () => {
  it("step() rejects kind:'terminateDebuggee' with BAD_INPUT — terminate() is the only sanctioned path", async () => {
    const transport = new FakeTransport({ attach: [attachOk()], getStack: [stackOk()] });
    const session = makeSession({ transport });
    const { stateId } = await session.attach("D1");

    await expect(session.step(stateId, "terminateDebuggee")).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "BAD_INPUT",
    );
    // Never even reached the transport — no step call attempted.
    expect(transport.callsOf("step")).toHaveLength(0);
  });

  it("armListener() rejects a second call while already 'listening'", async () => {
    const transport = new FakeTransport({ getListener: [LISTENER_EXISTS] });
    const session = makeSession({ transport });

    await session.armListener();
    expect(session.snapshot.status).toBe("listening");

    await expect(session.armListener()).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "BAD_INPUT",
    );
  });
});

// ---------------------------------------------------------------------------
// Optional: listActiveDebugSessions / shutdownAllDebugSessions, offline —
// built with the same fakes, no live wiring.
// ---------------------------------------------------------------------------

describe("listActiveDebugSessions / shutdownAllDebugSessions (offline)", () => {
  it("registers every constructed session and shutdownAllDebugSessions() cleans all of them up", async () => {
    const transport1 = new FakeTransport({ stopListener: [OK], setBreakpoints: [BREAKPOINTS_OK] });
    const transport2 = new FakeTransport({ stopListener: [OK], setBreakpoints: [BREAKPOINTS_OK] });
    const s1 = makeSession({ transport: transport1 });
    const s2 = makeSession({ transport: transport2 });

    expect(listActiveDebugSessions()).toContain(s1);
    expect(listActiveDebugSessions()).toContain(s2);

    await shutdownAllDebugSessions();

    expect(s1.snapshot.status).toBe("dead");
    expect(s2.snapshot.status).toBe("dead");
    expect(listActiveDebugSessions()).not.toContain(s1);
    expect(listActiveDebugSessions()).not.toContain(s2);
  });
});

// ---------------------------------------------------------------------------
// 12. Blocked-vs-timeout: an empty long-poll body is AMBIGUOUS on the wire.
//
// `client.ts` never says "timeout" any more — it reports `{kind:"empty"}` and
// leaves the interpretation to `DebugSession`, which is the only layer holding
// the local knowledge needed to tell "the server hold expired" (normal,
// retryable) from "another request on the same stateful ADT session did not
// complete until this poll settled" (a bug — that other request paid for a
// stall it never needed to). Conflating the two is exactly what hid the
// listener bug for a whole phase: a stalled-but-otherwise-normal listener
// looked like an ordinary timeout, so the code re-armed forever. (Live
// capture only establishes that the second request's response is withheld
// until the first settles; it does not establish which side is holding it.)
// ---------------------------------------------------------------------------

/** Settings payload for the cheapest pre-empting stateful call (`POST /debugger?method=setDebuggerSettings` -> OpKind "other"). */
const SETTINGS: DebugSettings = {
  systemDebugging: false,
  createExceptionObject: false,
  backgroundRFC: false,
  sharedObjectDebugging: false,
  showDataAging: false,
  updateDebugging: false,
};

describe("a blocked poll is never silently treated as a timeout", () => {
  it("empty body + an intervening stateful request -> 'blocked' (NOT 'timeout'), with sessionBlockedBy set", async () => {
    const transport = new FakeTransport({ setBreakpoints: [BREAKPOINTS_OK], stopListener: [OK] });
    const listener = new FakeListener();
    const session = makeSession({ transport, listener });

    await session.armListener();
    expect(session.snapshot.status).toBe("listening");

    // The collision itself: a second request on the SAME stateful ADT session
    // while the long-poll is still outstanding. Live-proven: that second
    // request's own response does not arrive until the poll settles — it pays
    // for the poll's remaining timeout. The poll itself is unaffected.
    //
    // `prepareBreakpoints` is the colliding call here rather than
    // `setDebuggerSettings`: the latter is now REFUSED outright while a listener
    // is outstanding (see "setDebuggerSettings is refused..." below), so it can no
    // longer reach the wire and cannot demonstrate a real collision.
    // `prepareBreakpoints` is deliberately unguarded — production runs it before
    // arming, but nothing stops a caller running it after, so it is a genuinely
    // reachable colliding call and exactly the case this detection exists for.
    await session.prepareBreakpoints([{ kind: "statement", statement: "WRITE" }]);
    // Both passes (validationOnly + the real arm) actually went out on the wire.
    expect(transport.callsOf("setBreakpoints")).toHaveLength(2);

    // What the wire shows afterwards: HTTP 200, 0-byte body — byte-for-byte
    // identical to an ordinary server-hold expiry. The listener genuinely timed
    // out on its own schedule; nothing killed it.
    listener.resolveWith(okResponse(""));

    const result = await session.waitForDebuggee();
    expect(result.kind).toBe("blocked");
    expect(result.kind).not.toBe("timeout"); // the whole point of this test
    expect(result.kind === "blocked" && result.detail).toContain("prepareBreakpoints");
    // Only the FIRST colliding call is kept — it is the one that paid the stall.
    expect(session.snapshot.sessionBlockedBy).toBe("prepareBreakpoints (validation pass)");
  });

  it("control case — the same empty body with NO intervening request stays a plain 'timeout'", async () => {
    const transport = new FakeTransport({ stopListener: [OK] });
    const listener = new FakeListener();
    const session = makeSession({ transport, listener });

    await session.armListener();
    listener.resolveWith(okResponse(""));

    const result = await session.waitForDebuggee();
    expect(result.kind).toBe("timeout");
    expect(session.snapshot.sessionBlockedBy).toBeUndefined();
    expect(session.snapshot.status).toBe("idle"); // a timeout is a normal, retryable outcome
  });

  it("armListener() refuses to re-arm until acknowledgeSessionBlock() is called", async () => {
    const transport = new FakeTransport({ setBreakpoints: [BREAKPOINTS_OK], stopListener: [OK] });
    const listener = new FakeListener();
    const session = makeSession({ transport, listener });

    await session.armListener();
    // Same legitimately-reachable colliding call as above: unguarded, and it
    // really reaches the wire while the poll is outstanding.
    await session.prepareBreakpoints([{ kind: "statement", statement: "WRITE" }]);
    listener.resolveWith(okResponse(""));
    expect((await session.waitForDebuggee()).kind).toBe("blocked");
    expect(session.snapshot.status).toBe("idle"); // idle, yet still must NOT re-arm

    await expect(session.armListener()).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e) || e.code !== "BAD_INPUT") return false;
      expect(e.message).toContain("prepareBreakpoints"); // names the colliding op
      return true;
    });

    session.acknowledgeSessionBlock();
    expect(session.snapshot.sessionBlockedBy).toBeUndefined();

    await session.armListener();
    expect(session.snapshot.status).toBe("listening");
  });

  it("the teardown stopListener that runs AFTER the poll settles does not cause a false 'blocked'", async () => {
    const transport = new FakeTransport({ stopListener: [OK] });
    const listener = new FakeListener();
    const session = makeSession({ transport, listener });

    await session.armListener();
    listener.resolveWith(okResponse(""));

    const result = await session.waitForDebuggee();

    // waitForDebuggee() itself issues a stateful request (the DELETE) on the
    // non-debuggee path. It must never be mistaken for the colliding call, since
    // by definition it runs after the poll already settled.
    expect(transport.callsOf("stopListener")).toHaveLength(1);
    expect(result.kind).toBe("timeout");
    expect(session.snapshot.sessionBlockedBy).toBeUndefined();
    // ...and therefore re-arming is not blocked.
    await session.armListener();
    expect(session.snapshot.status).toBe("listening");
  });
});

// ---------------------------------------------------------------------------
// 13. Bounded terminate()/cleanup(). A hung SAP call must never leave the
// session pending forever: finalisation (idle timer, status "dead",
// activeSessions removal) happens in a `finally`, guarded by a 1_500ms
// per-step deadline and a 4_000ms total deadline. Both numbers are module
// constants in session.ts (not exported) — mirrored as literals here.
// ---------------------------------------------------------------------------

/** A transport call that NEVER settles. `FakeTransport.request` is async, so returning a promise here hangs the awaiting caller forever. */
const HANGS: Thunk = () => new Promise<never>(() => {}) as unknown as RawResponse;

describe("bounded terminate/cleanup", () => {
  it("a hung cleanup cannot block a subsequent start", async () => {
    // Every single network step hangs: attach-before-terminate, terminateDebuggee,
    // stopListener and clearing breakpoints. 4 x 1_500ms of step deadlines would
    // be 6_000ms, so the 4_000ms TOTAL deadline is what actually finalises here.
    const transport = new FakeTransport({
      attach: [HANGS],
      terminateDebuggee: [HANGS],
      stopListener: [HANGS],
      setBreakpoints: [HANGS],
    });
    const listener = new FakeListener();
    const session = makeSession({ transport, listener });

    await session.armListener();
    listener.resolveWith(okResponse(debuggeeXml("D1")));
    expect((await session.waitForDebuggee()).kind).toBe("debuggee");
    expect(session.snapshot.debuggeeId).toBe("D1");

    let settled = false;
    const pending = session.cleanup().then(() => {
      settled = true;
    });
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(4_100); // past TERMINATE_TOTAL_DEADLINE_MS
    await flushMicrotasks();

    expect(settled).toBe(true);
    await expect(pending).resolves.toBeUndefined(); // settles, never rejects
    expect(session.snapshot.status).toBe("dead");
    expect(listActiveDebugSessions()).not.toContain(session);

    // A second cleanup() returns immediately — no timers, no network.
    await expect(session.cleanup()).resolves.toBeUndefined();

    // And a subsequent start is not blocked by the abandoned one.
    const transport2 = new FakeTransport({ stopListener: [OK], setBreakpoints: [BREAKPOINTS_OK] });
    const session2 = makeSession({ transport: transport2 });
    await session2.armListener();
    expect(session2.snapshot.status).toBe("listening");
    await session2.terminate();
  });

  it("a caught-but-never-attached debuggee is still terminated (the stranded work-process guard)", async () => {
    const transport = new FakeTransport({
      attach: [
        () => {
          throw new AbapError("ADT_ERROR", "best-effort attach-before-terminate failed", { status: 500 });
        },
      ],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const listener = new FakeListener();
    const session = makeSession({ transport, listener });

    await session.armListener();
    listener.resolveWith(okResponse(debuggeeXml("D1")));
    await session.waitForDebuggee();
    expect(session.snapshot.status).toBe("caught"); // holds a live debuggee, never attached
    expect(session.snapshot.debuggeeId).toBe("D1");

    await session.terminate();

    // The load-bearing assertion: the debuggee was actually terminated rather
    // than skipped by a `wasAttached`-style gate — one of only 7 dialog work
    // processes would otherwise stay wedged.
    expect(transport.callsOf("terminateDebuggee")).toHaveLength(1);
    expect(session.snapshot.status).toBe("dead");
    expect(session.snapshot.deathReason).toBe("terminated_by_caller");
  });

  it("a single hung step does not prevent the later steps or the finalisation", async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk()],
      terminateDebuggee: [HANGS], // hangs; abandoned after the per-step deadline
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const session = makeSession({ transport });

    await session.attach("D1");
    expect(session.snapshot.status).toBe("suspended");

    let settled = false;
    const pending = session.terminate().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_600); // past TERMINATE_STEP_DEADLINE_MS
    await flushMicrotasks();

    expect(settled).toBe(true);
    await pending;
    // The steps AFTER the hung one still ran...
    expect(transport.callsOf("stopListener")).toHaveLength(1);
    // ...and the breakpoint step is a no-op here because this session armed none.
    expect(transport.callsOf("setBreakpoints")).toHaveLength(0);
    // ...and finalisation happened regardless.
    expect(session.snapshot.status).toBe("dead");
    expect(session.snapshot.deathReason).toBe("terminated_by_caller");
    expect(listActiveDebugSessions()).not.toContain(session);
    // 5.7: the timeout used to be stderr-only (`this.log(...)`), invisible to
    // the calling agent. Same fact now also lands on `snapshot`.
    expect(session.snapshot.abandonedCleanupSteps).toEqual(["terminateDebuggee"]);
  });
});

// ---------------------------------------------------------------------------
// 5.7 — abandoned cleanup steps reach the caller, not just stderr.
// ARCH-09 §5.7: the 1500ms-per-step abandonment itself is pre-existing,
// tolerated behaviour — NOT what these tests are about. What they cover is the
// previously-missing signal: the abandoned op name now survives on
// `session.snapshot.abandonedCleanupSteps` for `src/tools/debug.ts`'s
// `handleStop` to fold into the `stop` response via
// `formatAbandonedCleanupNote`, instead of only ever reaching `this.log`
// (stderr).
// ---------------------------------------------------------------------------
describe("5.7 — abandoned cleanup steps reach the caller, not just stderr", () => {
  it("a hung breakpoint delete is recorded by name, in addition to the stderr log line", async () => {
    const log: string[] = [];
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk()],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      // prepareBreakpoints() issues two calls (validation pass, then arming
      // pass) that both succeed; the breakpoint DELETE issued during
      // terminate() is the third setBreakpoints-kind call, and that's the one
      // that hangs.
      setBreakpoints: [BREAKPOINTS_OK, BREAKPOINTS_OK, HANGS],
    });
    const session = makeSession({ transport, sessionOpts: { log: (msg) => log.push(msg) } });

    await session.prepareBreakpoints([{ kind: "statement", statement: "WRITE" }]);
    await session.attach("D1");

    let settled = false;
    const pending = session.terminate().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_600); // past TERMINATE_STEP_DEADLINE_MS
    await flushMicrotasks();

    expect(settled).toBe(true);
    await pending;
    expect(session.snapshot.status).toBe("dead");

    // stderr still gets its line (unchanged behaviour) ...
    expect(log.some((l) => /did not return within 1500ms during cleanup/.test(l))).toBe(true);
    // ...and now `snapshot` carries the same fact, naming the breakpoint op.
    expect(session.snapshot.abandonedCleanupSteps).toHaveLength(1);
    expect(session.snapshot.abandonedCleanupSteps?.[0]).toMatch(/breakpoint/i);
  });

  it("formatAbandonedCleanupNote turns the recorded step(s) into the exact 'stop' response line", async () => {
    const { formatAbandonedCleanupNote } = await import("../src/tools/debug.js");
    const note = formatAbandonedCleanupNote(["deleting this session's breakpoint BP1"]);
    expect(note).toBe(
      "Cleanup timed out on: deleting this session's breakpoint BP1 — may still be armed on the " +
        "server (e.g. a breakpoint); a later session could hit it.",
    );
  });

  it("a clean terminate leaves abandonedCleanupSteps unset — the 'stop' response note must not appear", async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk()],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK, BREAKPOINTS_OK],
    });
    const session = makeSession({ transport });

    await session.prepareBreakpoints([{ kind: "statement", statement: "WRITE" }]);
    await session.attach("D1");
    await session.terminate();

    expect(session.snapshot.status).toBe("dead");
    // Nothing to report: `handleStop` in src/tools/debug.ts only pushes a note
    // when this is non-empty, so an ordinary stop stays byte-identical.
    expect(session.snapshot.abandonedCleanupSteps).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 14. Self-collision guard: setDebuggerSettings is the one stateful call that
// takes no stateId and is therefore reachable while a listener long-poll is
// outstanding. Issuing it then would not complete until the outstanding poll
// settles (live capture — the caller
// stalls for the remainder of the poll's timeout; the poll itself is never
// killed), so it is refused rather than merely recorded. The guard must not
// over-fire: a consumed/settled poll is not an outstanding one.
// ---------------------------------------------------------------------------

describe("setDebuggerSettings self-collision guard", () => {
  it("is refused with BAD_INPUT while a listener poll is outstanding, and never reaches the wire", async () => {
    const transport = new FakeTransport({ other: [OK], stopListener: [OK] });
    const listener = new FakeListener();
    const session = makeSession({ transport, listener });

    await session.armListener();
    expect(session.snapshot.status).toBe("listening");

    await expect(session.setDebuggerSettings(SETTINGS)).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e) || e.code !== "BAD_INPUT") return false;
      expect(e.message).toContain("listener"); // says WHY, not just "no"
      expect(e.message).toContain("setDebuggerSettings");
      return true;
    });

    // The whole point: refusing means the request is not issued at all, so the
    // caller never pays the stall and the outstanding poll is never touched...
    expect(transport.callsOf("other")).toHaveLength(0);
    // ...and the session is untouched — still listening, no block recorded.
    expect(session.snapshot.status).toBe("listening");
    expect(session.snapshot.sessionBlockedBy).toBeUndefined();

    // Proof the poll really did survive: it still delivers its debuggee.
    listener.resolveWith(okResponse(debuggeeXml("D1")));
    expect((await session.waitForDebuggee()).kind).toBe("debuggee");
  });

  it("still SUCCEEDS when no listener has ever been armed", async () => {
    const transport = new FakeTransport({ other: [OK] });
    const session = makeSession({ transport });

    expect(session.snapshot.status).toBe("idle");
    // Resolves with the server's applied-settings echo; `OK` carries an empty body, so the
    // client falls back to the requested settings (and warns) rather than failing the call.
    await expect(session.setDebuggerSettings(SETTINGS)).resolves.toEqual(SETTINGS);
    expect(transport.callsOf("other")).toHaveLength(1);
  });

  it("still SUCCEEDS after the poll has settled and been consumed (the guard must not over-fire)", async () => {
    // Two distinct 'settled' shapes, because they leave DIFFERENT internal state:
    //   - timeout  -> listenHandle cleared, listenConsumed true, status "idle"
    //   - debuggee -> listenHandle STILL SET, listenConsumed true, status "caught"
    // A guard written as `listenHandle !== undefined` alone would wrongly refuse
    // the second one, which is exactly the documented "or after the debuggee has
    // been caught" case.
    const transport = new FakeTransport({ other: [OK], stopListener: [OK] });
    const listener = new FakeListener();
    const session = makeSession({ transport, listener });

    await session.armListener();
    listener.resolveWith(okResponse(""));
    expect((await session.waitForDebuggee()).kind).toBe("timeout");
    // Resolves with the server's applied-settings echo; `OK` carries an empty body, so the
    // client falls back to the requested settings (and warns) rather than failing the call.
    await expect(session.setDebuggerSettings(SETTINGS)).resolves.toEqual(SETTINGS);
    expect(transport.callsOf("other")).toHaveLength(1);

    const transport2 = new FakeTransport({ other: [OK], stopListener: [OK] });
    const listener2 = new FakeListener();
    const session2 = makeSession({ transport: transport2, listener: listener2 });

    await session2.armListener();
    listener2.resolveWith(okResponse(debuggeeXml("D1")));
    expect((await session2.waitForDebuggee()).kind).toBe("debuggee");
    expect(session2.snapshot.status).toBe("caught");
    await expect(session2.setDebuggerSettings(SETTINGS)).resolves.toEqual(SETTINGS);
    expect(transport2.callsOf("other")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 15. Cookie rotation must OUTLIVE a single run(). `AbapConnection` delegates
// its jar to abap-adt-api's private HttpClient and exposes no setter, so a
// SAP_SESSIONID rotated by the long-poll's CSRF-refresh HEAD is kept in an
// overlay inside `createDebugClientForConnection` and re-applied on every read.
// Without the overlay the rotation lived only for the current run(), producing
// old-cookie + new-token and a permanent 403 on the very next call.
// ---------------------------------------------------------------------------

/** Only `cfg.url`, `breaker`, `cookies()` and `csrfToken()` are dereferenced by `createDebugClientForConnection`. */
function makeFakeConnection(initialCookies: string): { conn: AbapConnection; setCookies: (c: string) => void } {
  const state = { cookies: initialCookies };
  const fake = {
    cfg: { url: "https://a4h.example.invalid:44300" },
    breaker: {},
    cookies: () => state.cookies,
    csrfToken: () => "CSRF-TOKEN",
  };
  return {
    conn: fake as unknown as AbapConnection,
    setCookies: (c: string) => {
      state.cookies = c;
    },
  };
}

interface AuthShape {
  cookieHeader: () => string;
  csrfToken: () => string;
  updateCookies?: (setCookieHeader: string | string[]) => void;
}

/** Reaches the live auth object the long-poll client actually reads on every request — no module mocking. */
function authOf(client: DebugClient): AuthShape {
  const longPoll = (client as unknown as { longPoll: unknown }).longPoll;
  return (longPoll as { auth: AuthShape }).auth;
}

const countOccurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("cookie rotation overlay (createDebugClientForConnection)", () => {
  const SESSION_COOKIE = "SAP_SESSIONID_A4H_001";

  it("a rotated cookie survives indefinitely, replaces rather than duplicates, and never masks the connection's other cookies", () => {
    const { conn, setCookies } = makeFakeConnection(`${SESSION_COOKIE}=OLD; sap-usercontext=sap-client=001`);
    const client = createDebugClientForConnection(conn, { safety: TEST_GATE });
    const auth = authOf(client);
    expect(typeof auth.updateCookies).toBe("function");

    // 1. Before any rotation the overlay is inert — byte-for-byte the connection's own header.
    expect(auth.cookieHeader()).toBe(conn.cookies());

    // 2. The rotation, exactly as the CSRF-refresh HEAD delivers it (attributes and all).
    auth.updateCookies!(`${SESSION_COOKIE}=NEWVALUE; path=/; HttpOnly`);

    // 3. New value wins; the untouched cookie is preserved, not clobbered.
    expect(auth.cookieHeader()).toContain(`${SESSION_COOKIE}=NEWVALUE`);
    expect(auth.cookieHeader()).toContain("sap-usercontext=sap-client=001");
    expect(auth.cookieHeader()).not.toContain(`${SESSION_COOKIE}=OLD`);

    // 4. THE REGRESSION: the connection itself never learned about the rotation
    // (it still hands out OLD), yet every later, independent read — i.e. any
    // subsequent run() — still carries NEWVALUE. Pre-fix this read returned OLD.
    expect(conn.cookies()).toContain(`${SESSION_COOKIE}=OLD`);
    for (let i = 0; i < 3; i++) expect(auth.cookieHeader()).toContain(`${SESSION_COOKIE}=NEWVALUE`);

    // 5. Rotating the SAME name again REPLACES — the overlay is bounded, not append-only.
    auth.updateCookies!(`${SESSION_COOKIE}=NEWER; path=/; HttpOnly; SameSite=None`);
    const rotated = auth.cookieHeader();
    expect(rotated).toContain(`${SESSION_COOKIE}=NEWER`);
    expect(rotated).not.toContain("NEWVALUE");
    expect(countOccurrences(rotated, `${SESSION_COOKIE}=`)).toBe(1);

    // 6. A cookie the connection changes later, which was never rotated, still
    // tracks the connection — the overlay shadows only what it actually holds.
    setCookies(`${SESSION_COOKIE}=OLD; sap-usercontext=sap-client=002; extra=E1`);
    const afterConnChange = auth.cookieHeader();
    expect(afterConnChange).toContain("sap-usercontext=sap-client=002");
    expect(afterConnChange).toContain("extra=E1");
    expect(afterConnChange).toContain(`${SESSION_COOKIE}=NEWER`); // rotation still wins
  });

  it("accepts the array form of set-cookie and rotates every entry", () => {
    const { conn } = makeFakeConnection(`${SESSION_COOKIE}=OLD; other=O1`);
    const auth = authOf(createDebugClientForConnection(conn, { safety: TEST_GATE }));

    auth.updateCookies!([`${SESSION_COOKIE}=ROT1; path=/`, "other=ROT2; HttpOnly", "malformed-no-equals"]);

    const header = auth.cookieHeader();
    expect(header).toContain(`${SESSION_COOKIE}=ROT1`);
    expect(header).toContain("other=ROT2");
    expect(header).not.toContain("malformed-no-equals");
  });

  // The overlay is sticky, but it must not be immortal. When the underlying
  // AbapConnection re-logs on, its jar gets a FRESH SAP_SESSIONID; a stale
  // rotated value winning that merge is exactly the old-cookie + new-token 403
  // the overlay exists to prevent. An entry self-expires once the connection's
  // value for that same name no longer matches what it was when we rotated.
  it("a rotated cookie EXPIRES once the connection re-logs on with a fresh value for that same name", () => {
    const { conn, setCookies } = makeFakeConnection(`${SESSION_COOKIE}=OLD; sap-usercontext=sap-client=001`);
    const auth = authOf(createDebugClientForConnection(conn, { safety: TEST_GATE }));

    auth.updateCookies!(`${SESSION_COOKIE}=ROTATED; path=/; HttpOnly`);
    expect(auth.cookieHeader()).toContain(`${SESSION_COOKIE}=ROTATED`);

    // Re-logon: the connection's own jar now holds a third, fresher value.
    setCookies(`${SESSION_COOKIE}=FRESH_AFTER_RELOGON; sap-usercontext=sap-client=001`);

    const header = auth.cookieHeader();
    expect(header).toContain(`${SESSION_COOKIE}=FRESH_AFTER_RELOGON`);
    expect(header).not.toContain("ROTATED");
    expect(countOccurrences(header, `${SESSION_COOKIE}=`)).toBe(1);
    // And it stays expired — the drop is permanent, not a one-read blip.
    for (let i = 0; i < 3; i++) expect(auth.cookieHeader()).not.toContain("ROTATED");
    // A later rotation on top of the connection's fresh value works again.
    auth.updateCookies!(`${SESSION_COOKIE}=ROTATED2; path=/`);
    expect(auth.cookieHeader()).toContain(`${SESSION_COOKIE}=ROTATED2`);
  });

  it("expiry does not over-fire: an unrelated connection cookie changing leaves the rotation intact", () => {
    const { conn, setCookies } = makeFakeConnection(`${SESSION_COOKIE}=OLD; other=O1`);
    const auth = authOf(createDebugClientForConnection(conn, { safety: TEST_GATE }));

    auth.updateCookies!(`${SESSION_COOKIE}=ROTATED; path=/`);
    setCookies(`${SESSION_COOKIE}=OLD; other=CHANGED; extra=E1`);

    const header = auth.cookieHeader();
    expect(header).toContain(`${SESSION_COOKIE}=ROTATED`); // per-name, not wholesale
    expect(header).toContain("other=CHANGED");
    expect(header).toContain("extra=E1");
  });

  it("rotates a cookie the connection does not have at all, and keeps it across reads", () => {
    const { conn, setCookies } = makeFakeConnection("sap-usercontext=sap-client=001");
    const auth = authOf(createDebugClientForConnection(conn, { safety: TEST_GATE }));

    auth.updateCookies!(`${SESSION_COOKIE}=BRANDNEW; path=/; HttpOnly`);
    expect(auth.cookieHeader()).toContain(`${SESSION_COOKIE}=BRANDNEW`);
    // Unrelated connection churn must not disturb an entry whose base is absent.
    setCookies("sap-usercontext=sap-client=002");
    for (let i = 0; i < 3; i++) expect(auth.cookieHeader()).toContain(`${SESSION_COOKIE}=BRANDNEW`);
    expect(auth.cookieHeader()).toContain("sap-usercontext=sap-client=002");

    // ...but once the connection DOES acquire that name, the connection wins.
    setCookies(`sap-usercontext=sap-client=002; ${SESSION_COOKIE}=FROM_CONN`);
    const header = auth.cookieHeader();
    expect(header).toContain(`${SESSION_COOKIE}=FROM_CONN`);
    expect(header).not.toContain("BRANDNEW");
  });
});

// ---------------------------------------------------------------------------
// 16. Server-hold vs. client-abort drift. These are two independently-defaulting
// knobs: `DebugSession.listenerTimeoutSeconds` (what SAP is TOLD to hold the
// poll for, on the wire) and `DebugLongPollClient.clientAbortTimeoutMs` (when
// the client gives up). If the client aborts first, every healthy listen looks
// like a transport failure — a known earlier failure mode.
//
// Asserting today's constants would not catch that; these tests assert the
// RELATIONSHIP, and that the guarded number is the SAME number that goes on the
// wire.
// ---------------------------------------------------------------------------

interface RecordedLaunch {
  timeout?: number;
}

/** Minimal DebugClient stand-in: records launch params, reports a chosen abort deadline, and its handle NEVER hangs `armListener()` (armed is already resolved). */
class RecordingDebugClient {
  readonly launches: RecordedLaunch[] = [];
  constructor(private readonly abortMs: number | undefined) {}
  longPollAbortTimeoutMs(): number | undefined {
    return this.abortMs;
  }
  launchListener(params: RecordedLaunch): unknown {
    this.launches.push(params);
    return {
      armed: Promise.resolve(),
      result: new Promise(() => {}), // never settles; never awaited by armListener()
      abort: () => {},
      aborted: false,
    };
  }
  async stopListener(): Promise<void> {}
}

function makeDriftSession(listenerTimeoutSeconds: number, abortMs: number | undefined) {
  const client = new RecordingDebugClient(abortMs);
  const session = new DebugSession({
    client: client as unknown as DebugClient,
    context: CONTEXT,
    listenerTimeoutSeconds,
    idleTimeoutMs: 100_000,
  });
  return { client, session };
}

const isSafe = (serverHoldSeconds: number, clientAbortMs: number): boolean =>
  serverHoldSeconds * 1000 + LONGPOLL_TIMEOUT_MARGIN_MS < clientAbortMs;

describe("listener server-hold vs. client-abort drift", () => {
  it("the number sent on the wire IS the number the guard checks (boundary-probed, not read from internals)", async () => {
    const SECONDS = 90;
    const { client, session } = makeDriftSession(SECONDS, SECONDS * 1000 + LONGPOLL_TIMEOUT_MARGIN_MS + 1);
    await session.armListener();

    // What actually goes out as the ADT `timeout` query parameter.
    expect(client.launches).toHaveLength(1);
    const sentTimeout = client.launches[0]!.timeout;
    expect(sentTimeout).toBe(SECONDS);

    // Now pin the guard to THAT number without touching a private field: the
    // rejection boundary must sit exactly at `sentTimeout*1000 + margin`. If a
    // refactor ever starts guarding a different knob than the one it sends (e.g.
    // the client-side-only `listenTimeoutMs`), the boundary moves and this fails.
    const boundary = sentTimeout! * 1000 + LONGPOLL_TIMEOUT_MARGIN_MS;
    const atBoundary = makeDriftSession(SECONDS, boundary);
    await expect(atBoundary.session.armListener()).rejects.toThrow(/drifted/);
    expect(atBoundary.client.launches).toHaveLength(0); // guard runs BEFORE dispatch

    const justOver = makeDriftSession(SECONDS, boundary + 1);
    await expect(justOver.session.armListener()).resolves.toBeUndefined();
    expect(justOver.client.launches[0]!.timeout).toBe(sentTimeout);
  });

  it("the `timeout` param really reaches the wire URL (real DebugClient, fake listener)", async () => {
    const transport = new FakeTransport({ stopListener: [OK] });
    const listener = new FakeListener();
    const session = makeSession({ transport, listener, sessionOpts: { listenerTimeoutSeconds: 123 } });

    await session.armListener();

    // The real DebugClient builds the launch URL; the seconds value the session
    // guards is the one that ends up as the ADT `timeout` query parameter.
    expect(listener.lastPath).toContain("timeout=123");
  });

  it("drifted knobs are REJECTED and the error names both of them", async () => {
    // 240s server hold against a 180s client abort: the client would give up 60s
    // before the server was even due to answer.
    const { client, session } = makeDriftSession(240, 180_000);

    await expect(session.armListener()).rejects.toSatisfy((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain("listenerTimeoutSeconds"); // the server-hold knob
      expect(msg).toContain("clientTimeoutMs"); // the client-abort knob
      expect(msg).toContain("240"); // ...with their actual drifted values
      expect(msg).toContain("240000");
      expect(msg).toContain("180000");
      return true;
    });

    // Nothing was dispatched, so no `armed` promise can be stranded, and the
    // session is still cleanly re-armable rather than wedged in "listening".
    expect(client.launches).toHaveLength(0);
    expect(session.snapshot.status).toBe("idle");
  });

  it.each([
    [1, 61_000],
    [1, 61_001],
    [60, 120_000],
    [60, 120_001],
    [60, 180_000],
    [120, 180_000],
    [120, 180_001],
    [180, 240_000],
    [240, 300_000],
    [240, 300_001],
    [240, 180_000],
  ])(
    "serverHold=%is against clientAbort=%ims is accepted iff serverHold*1000 + margin < clientAbort",
    async (serverHoldSeconds, clientAbortMs) => {
      const expectedSafe = isSafe(serverHoldSeconds, clientAbortMs); // derived, never a hardcoded verdict
      const { client, session } = makeDriftSession(serverHoldSeconds, clientAbortMs);

      if (expectedSafe) {
        await expect(session.armListener()).resolves.toBeUndefined();
        expect(session.snapshot.status).toBe("listening");
        expect(client.launches).toHaveLength(1);
      } else {
        await expect(session.armListener()).rejects.toThrow(/drifted/);
        expect(session.snapshot.status).toBe("idle");
        expect(client.launches).toHaveLength(0);
      }
    },
  );

  it("a client that does not report an abort deadline (partial fake) is not blocked by the guard", async () => {
    const { client, session } = makeDriftSession(240, undefined);
    await expect(session.armListener()).resolves.toBeUndefined();
    expect(client.launches).toHaveLength(1);
  });

  it("PRODUCTION defaults are safe — computed from both defaults, never hardcoded", async () => {
    // Built exactly the way production builds it: no `listenTimeoutSeconds`/
    // `target` opts, so both knobs come from their own independent defaults
    // (`safety` is REQUIRED — so that alone is supplied).
    const { conn } = makeFakeConnection("SAP_SESSIONID_A4H_001=X");
    const client = createDebugClientForConnection(conn, { safety: TEST_GATE });
    const clientAbortMs = client.longPollAbortTimeoutMs();
    expect(typeof clientAbortMs).toBe("number");

    // Intercept the dispatch only — `longPollAbortTimeoutMs` stays the REAL one,
    // so no HTTP is ever attempted while both real defaults are still in play.
    const launches: RecordedLaunch[] = [];
    (client as unknown as { launchListener: (p: RecordedLaunch) => unknown }).launchListener = (p) => {
      launches.push(p);
      return { armed: Promise.resolve(), result: new Promise(() => {}), abort: () => {}, aborted: false };
    };

    const session = new DebugSession({ client, context: CONTEXT, idleTimeoutMs: 100_000 });
    await expect(session.armListener()).resolves.toBeUndefined();

    // Read the effective server hold back off the wire rather than assuming it.
    expect(launches).toHaveLength(1);
    const serverHoldSeconds = launches[0]!.timeout!;
    expect(typeof serverHoldSeconds).toBe("number");

    // The inequality itself is the assertion. Change EITHER default in a way that
    // breaks the pairing and this fails — no `toBe(60)` to update in lockstep.
    expect(isSafe(serverHoldSeconds, clientAbortMs!)).toBe(true);
  });
});

// ===========================================================================
// 15. REGRESSION: `stop` must never delete a breakpoint this session did not
//     create (D1).
//
// External breakpoints belong to the SAP *user*, not to an ADT session. The
// shutdown step used to POST `syncScope {mode:"full"}` with an EMPTY breakpoint
// list and NO `objectUri`, which SAP reads as "the complete set of external
// breakpoints for this user is now empty" — so it deletes the lot, including
// the ones a human set in Eclipse minutes earlier. `endpoints.ts`'s
// `SYNC_SCOPE_MODE` doc comment forbids exactly that call, and
// `test/fixtures/live-captured/044-bp-clear-all.meta.json` is the captured
// request body of the bug: `<syncScope mode="full"></syncScope>` and nothing
// else in the envelope.
//
// The fake below models the one thing that matters: a per-USER registry of
// external breakpoints that an unscoped full sync wipes and a targeted DELETE
// does not. The breakpoint ids this session gets back are the real
// server-assigned ids from `013-bp-set-accepted.xml`.
// ===========================================================================

const LIVE_BP_ACCEPTED_XML = readFileSync(join(LIVE_CAPTURED_DIR, "013-bp-set-accepted.xml"), "utf8");

/** Real server-assigned ids, straight out of `013-bp-set-accepted.xml`. */
const OURS_BP_84 = "KIND=0.SOURCETYPE=ABAP.MAIN_PROGRAM=ZMCP_DBG_DEMO.INCLUDE=ZMCP_DBG_DEMO.LINE_NR=84";
const OURS_BP_93 = "KIND=0.SOURCETYPE=ABAP.MAIN_PROGRAM=ZMCP_DBG_DEMO.INCLUDE=ZMCP_DBG_DEMO.LINE_NR=93";
/** Set by a human in Eclipse, minutes before this debug session existed. Same SAP user. */
const HUMANS_BP = "KIND=0.SOURCETYPE=ABAP.MAIN_PROGRAM=ZHUMAN_WIP.INCLUDE=ZHUMAN_WIP.LINE_NR=42";

/**
 * A `FakeTransport` that additionally models SAP's per-user external-breakpoint
 * registry, so "did this delete someone else's breakpoint?" is an observable
 * fact rather than a string assertion about a request body.
 */
class BreakpointRegistryTransport extends FakeTransport {
  /** Every external breakpoint this SAP user currently owns, session-agnostic — exactly how SAP scopes them. */
  public readonly userBreakpoints = new Set<string>([HUMANS_BP]);
  public unscopedFullSyncs = 0;

  override async request(opts: DebugRequestOptions): Promise<RawResponse> {
    if (opts.path.includes("/debugger/breakpoints")) {
      if (opts.method === "DELETE") {
        const id = decodeURIComponent(opts.path.split("?")[0]!.split("/debugger/breakpoints/")[1] ?? "");
        this.userBreakpoints.delete(id);
      } else if (opts.method === "POST") {
        const body = opts.body ?? "";
        const isFullSync = /<syncScope[^>]*mode="full"/.test(body);
        const hasObjectUri = /<syncScope[^>]*objectUri=/.test(body);
        if (isFullSync && !hasObjectUri) {
          // This is the destructive call. SAP obeys it literally: the listed
          // breakpoints become the user's COMPLETE external set.
          this.unscopedFullSyncs++;
          this.userBreakpoints.clear();
        }
        if (!/validationOnly="true"/.test(body)) {
          for (const id of body.includes("start=84") ? [OURS_BP_84, OURS_BP_93] : []) {
            this.userBreakpoints.add(id);
          }
        }
      }
    }
    return super.request(opts);
  }
}

describe("D1 — stop() must not delete breakpoints this session never created", () => {
  const OURS: Breakpoint[] = [
    { kind: "line", clientId: "bp84", uri: "/sap/bc/adt/programs/programs/zmcp_dbg_demo/source/main#start=84" },
    { kind: "line", clientId: "bp93", uri: "/sap/bc/adt/programs/programs/zmcp_dbg_demo/source/main#start=93" },
  ];

  function makeRegistrySession(): { transport: BreakpointRegistryTransport; session: DebugSession } {
    const transport = new BreakpointRegistryTransport({
      setBreakpoints: [() => okResponse(LIVE_BP_ACCEPTED_XML)],
      attach: [attachOk()],
      getStack: [stackOk()],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
    });
    return { transport, session: makeSession({ transport }) };
  }

  it("a human's Eclipse breakpoint survives terminate(); only this session's two are deleted", async () => {
    const { transport, session } = makeRegistrySession();

    await session.prepareBreakpoints(OURS);
    await session.attach("D1");
    expect(transport.userBreakpoints.has(HUMANS_BP)).toBe(true);

    await session.terminate();
    expect(session.snapshot.status).toBe("dead");

    // THE INVARIANT: a breakpoint this session never created still exists.
    expect([...transport.userBreakpoints]).toEqual([HUMANS_BP]);
    // ...and ours really were removed, so this is not passing by doing nothing.
    expect(transport.userBreakpoints.has(OURS_BP_84)).toBe(false);
    expect(transport.userBreakpoints.has(OURS_BP_93)).toBe(false);
  });

  it("never issues an unscoped full sync, and deletes by id — one targeted DELETE per owned breakpoint", async () => {
    const { transport, session } = makeRegistrySession();

    await session.prepareBreakpoints(OURS);
    await session.terminate();

    expect(transport.unscopedFullSyncs).toBe(0);

    const deletes = transport.calls.filter(
      (c) => c.method === "DELETE" && c.path.includes("/debugger/breakpoints"),
    );
    expect(deletes).toHaveLength(2);
    const deletedIds = deletes.map((c) => decodeURIComponent(c.path.split("?")[0]!.split("/breakpoints/")[1]!));
    expect(deletedIds.sort()).toEqual([OURS_BP_84, OURS_BP_93].sort());
    // The id must be URL-ENCODED in the path — it contains `=` and `.` and is a
    // single path segment.
    expect(deletes[0]!.path).toContain(encodeURIComponent(OURS_BP_84));

    // The only breakpoint POSTs in the whole run are prepareBreakpoints'
    // validation + arming passes. Shutdown adds none.
    const posts = transport.calls.filter((c) => c.method === "POST" && c.path.includes("/debugger/breakpoints"));
    expect(posts).toHaveLength(2);
  });

  it("a session that armed nothing issues no breakpoint call at all on terminate()", async () => {
    const { transport, session } = makeRegistrySession();

    await session.attach("D1");
    await session.terminate();

    expect(transport.callsOf("setBreakpoints")).toHaveLength(0);
    expect(transport.unscopedFullSyncs).toBe(0);
    expect([...transport.userBreakpoints]).toEqual([HUMANS_BP]);
  });
});

// ===========================================================================
// 16. REGRESSION: a step that reached the wire must never be physically
//     repeated by a retry (D2).
//
// `client.step()` returning is the point of no return. If the follow-up
// `getStack()` then fails, the old code left the still-valid `stateId`
// installed: the caller saw a plain failure, retried with the SAME `stateId`,
// it validated, and the debuggee stepped a SECOND time — one requested step,
// two lines of movement.
// ===========================================================================

describe("D2 — a failed getStack() after a successful step must not allow a double physical step", () => {
  /** Not SESSION_DEAD / NOT_CONNECTED: this is a live session whose stack read merely failed. */
  const STACK_READ_FAILS: Thunk = () => {
    throw new AbapError("ADT_ERROR", "stack read blew up", { status: 500 });
  };

  function makeStepSession(): { transport: FakeTransport; session: DebugSession } {
    const transport = new FakeTransport({
      attach: [attachOk("S1")],
      // #0 attach's stack, #1 the one that fails after the step, #2 the recovery read.
      getStack: [stackOk({ line: 84 }), STACK_READ_FAILS, stackOk({ line: 93 })],
      // Deliberately stocked with a SECOND success: if the retry is ever let
      // through, it succeeds on the wire and `callsOf("step")` is what catches it.
      step: [stepOk({ debugSessionId: "S1" }), stepOk({ debugSessionId: "S1" })],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
    });
    return { transport, session: makeSession({ transport }) };
  }

  it("retrying with the same stateId is refused — the debuggee is stepped exactly ONCE", async () => {
    const { transport, session } = makeStepSession();
    const { stateId: stateId1 } = await session.attach("D1");

    await expect(session.step(stateId1, "stepOver")).rejects.toThrow();
    expect(transport.callsOf("step")).toHaveLength(1); // the one physical step

    // The retry a client makes when it sees a failure. It MUST NOT reach the wire.
    await expect(session.step(stateId1, "stepOver")).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "BAD_INPUT" && /stale stateid/i.test(e.message),
    );

    // THE INVARIANT: still one. Without the fix this is 2 and the program is two
    // lines further on than the user asked for.
    expect(transport.callsOf("step")).toHaveLength(1);
    expect(session.snapshot.status).toBe("suspended"); // still alive, just resynchronising
  });

  it("the error says the step DID happen and hands back a stateId to re-read the stack with", async () => {
    const { transport, session } = makeStepSession();
    const { stateId: stateId1 } = await session.attach("D1");

    let recoveryStateId: string | undefined;
    await expect(session.step(stateId1, "stepOver")).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e)) return false;
      // "your step DID happen, refresh" — NOT "your step failed, retry".
      expect(e.details["stepExecuted"]).toBe(true);
      expect(e.message).toContain("DID execute");
      expect(e.message).toMatch(/do not retry the step/i);
      expect(e.retryable).toBe(false); // retrying would double-step the live debuggee
      // The original failure is preserved rather than swallowed.
      expect(e.details["causeCode"]).toBe("ADT_ERROR");
      // The retired id and the one to use next are both named.
      expect(e.details["providedStateId"]).toBe(stateId1);
      expect(e.details["currentStateId"]).not.toBe(stateId1);
      recoveryStateId = e.details["currentStateId"] as string;
      return true;
    });

    // And the advertised recovery actually works: re-read the stack, don't re-step.
    expect(recoveryStateId).toBeTruthy();
    const stack = await session.getStack(recoveryStateId!);
    expect(stack.frames[0]!.line).toBe(93);
    expect(transport.callsOf("step")).toHaveLength(1);
  });

  it("an error from step() ITSELF is still a plain retryable failure (no stepExecuted flag)", async () => {
    // The control case that keeps the two situations distinguishable.
    const transport = new FakeTransport({
      attach: [attachOk("S1")],
      getStack: [stackOk({ line: 84 })],
      step: [
        () => {
          throw new AbapError("ADT_ERROR", "step never reached the debuggee", { status: 500 });
        },
      ],
    });
    const session = makeSession({ transport });
    const { stateId } = await session.attach("D1");

    await expect(session.step(stateId, "stepOver")).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e)) return false;
      expect(e.code).toBe("ADT_ERROR"); // the ORIGINAL error, unchanged
      expect(e.details["stepExecuted"]).toBeUndefined();
      return true;
    });
    // Nothing moved, so the caller's stateId is still the live one.
    expect(session.snapshot.stateId).toBe(stateId);
  });
});

// ===========================================================================
// 17. REGRESSION: the listener long-poll is aborted locally on teardown.
//
// `stopListener()`'s DELETE releases the SERVER-side registration but leaves
// this process's long-poll HTTP request hanging until the ~360 s server
// timeout. The only legal fix is a client-side `AbortController` firing —
// adding a second *request* on the same session would not free the socket any
// sooner, it would just queue behind the very poll it was trying to tidy up
// and stall for the remainder of its timeout (see `armListener()`'s doc
// comment; live-proven on A4H).
// ===========================================================================

describe("teardown aborts the outstanding listener long-poll locally, with no extra round-trip", () => {
  it("terminate() after a caught debuggee aborts the handle exactly once and issues no new call kind", async () => {
    const transport = new FakeTransport({
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
    });
    const listener = new FakeListener();
    const session = makeSession({ transport, listener });

    await session.armListener();
    listener.resolveWith(okResponse(debuggeeXml("D1")));
    expect((await session.waitForDebuggee()).kind).toBe("debuggee");
    // The debuggee path deliberately leaves the listener registered — this is the
    // state in which the leak used to run to 360s.
    expect(listener.abortCount).toBe(0);

    await session.terminate();

    // THE INVARIANT: the poll was aborted client-side. Without the wiring this is 0.
    expect(listener.abortCount).toBe(1);
    // THE LAW: no confirmation round-trip was added to achieve it. Exactly the one
    // pre-existing DELETE, and never a getListener().
    expect(transport.callsOf("stopListener")).toHaveLength(1);
    expect(transport.callsOf("getListener")).toHaveLength(0);
  });

  it("the abort is local, so it still happens when every cleanup call hangs", async () => {
    // If the abort lived inside the deadlined network sequence it would be
    // abandoned along with it, and the socket would leak exactly when it matters
    // most — a SAP box that has stopped answering.
    const transport = new FakeTransport({
      attach: [HANGS],
      terminateDebuggee: [HANGS],
      stopListener: [HANGS],
      setBreakpoints: [HANGS],
    });
    const listener = new FakeListener();
    const session = makeSession({ transport, listener });

    await session.armListener();
    listener.resolveWith(okResponse(debuggeeXml("D1")));
    await session.waitForDebuggee();

    void session.cleanup();
    await flushMicrotasks();

    // No timers advanced: the abort is synchronous and does not wait on the wire.
    expect(listener.abortCount).toBe(1);
    expect(session.snapshot.status).not.toBe("dead"); // cleanup is still hanging
  });

  it("waitForDebuggee() aborts the handle on the timeout path too, before the DELETE", async () => {
    const transport = new FakeTransport({ stopListener: [OK] });
    const listener = new FakeListener();
    const session = makeSession({ transport, listener });

    await session.armListener();
    listener.resolveWith(okResponse("")); // server hold expired
    expect((await session.waitForDebuggee()).kind).toBe("timeout");

    expect(listener.abortCount).toBe(1);
    expect(transport.callsOf("stopListener")).toHaveLength(1); // still exactly one round-trip
  });
});

// ===========================================================================
// 18. sessionLease — the pool lease held for a `DebugSession`'s ENTIRE life
// (armed listener, attach, every step and every variable read), released
// exactly once, as the LAST statement of `doTerminate`'s `finally` — after
// `status` is already `"dead"` and after the session has already been removed
// from `activeSessions`. Optional: a session built without one behaves
// exactly as before, which is why every OTHER test in this file (all built
// before `sessionLease` existed) keeps passing unchanged.
// ===========================================================================

function makeCountingLease(): { lease: DebugSessionLease; releaseCount: () => number } {
  let count = 0;
  return { lease: { release: () => { count++; } }, releaseCount: () => count };
}

describe("M12 — sessionLease is released exactly once, from DebugSession's point of view", () => {
  it("terminate() releases the lease once; a second terminate()/cleanup() afterward does not release it again", async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk()],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const { lease, releaseCount } = makeCountingLease();
    const session = makeSession({ transport, sessionOpts: { sessionLease: lease } });

    await session.attach("D1");
    await session.terminate();
    expect(session.snapshot.status).toBe("dead");
    expect(releaseCount()).toBe(1);

    // Once status is "dead", terminate()/cleanup() short-circuit before doTerminate
    // (and therefore before sessionLease.release()) is ever entered again — the real
    // PoolSlot.release() is itself idempotent, but DebugSession must not be the thing
    // that double-releases by calling it a second time regardless.
    await session.terminate();
    await session.cleanup();
    expect(releaseCount()).toBe(1);
  });

  it("a throwing release() is swallowed by the guarded catch — terminate() still resolves and the session still ends up 'dead'", async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk()],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const throwingLease: DebugSessionLease = {
      release: () => {
        throw new Error("pool slot release blew up");
      },
    };
    const session = makeSession({ transport, sessionOpts: { sessionLease: throwingLease } });

    await session.attach("D1");
    // The guarded try/catch around sessionLease.release() inside doTerminate's
    // finally is load-bearing: that finally is the ONLY thing that clears the idle
    // timer, drops the debuggee handle and de-registers the session from
    // activeSessions. A throwing lease must not turn a finished teardown into a
    // hang or a rejection.
    await expect(session.terminate()).resolves.toBeUndefined();
    expect(session.snapshot.status).toBe("dead");
    expect(listActiveDebugSessions()).not.toContain(session);
  });
});

describe("sessionLease is released even when teardown blows its deadline", () => {
  it("terminate() still releases the lease and reaches 'dead' when every network step hangs past TERMINATE_TOTAL_DEADLINE_MS (4_000ms)", async () => {
    // Every network step hangs, mirroring the existing "bounded terminate/cleanup"
    // suite's HANGS-everywhere scenario. The 4_000ms TOTAL deadline (not any single
    // 1_500ms step deadline) is what finalises the sequence here.
    const transport = new FakeTransport({
      attach: [HANGS],
      terminateDebuggee: [HANGS],
      stopListener: [HANGS],
      setBreakpoints: [HANGS],
    });
    const listener = new FakeListener();
    const { lease, releaseCount } = makeCountingLease();
    const session = makeSession({ transport, listener, sessionOpts: { sessionLease: lease } });

    await session.armListener();
    listener.resolveWith(okResponse(debuggeeXml("D1")));
    expect((await session.waitForDebuggee()).kind).toBe("debuggee");

    let settled = false;
    const pending = session.terminate().then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    expect(releaseCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(4_100); // past TERMINATE_TOTAL_DEADLINE_MS
    await flushMicrotasks();

    expect(settled).toBe(true);
    await expect(pending).resolves.toBeUndefined(); // settles, never rejects
    expect(session.snapshot.status).toBe("dead");
    expect(releaseCount()).toBe(1);
  });
});

describe("sessionLease is released AFTER the session is dead and de-registered", () => {
  it("at the moment release() runs, listActiveDebugSessions() no longer contains the session and its status is already 'dead'", async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk()],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    let statusAtRelease: string | undefined;
    let stillActiveAtRelease: boolean | undefined;
    const lease: DebugSessionLease = {
      release: () => {
        // Captured INSIDE the callback, not after terminate() resolves — this is
        // the only way to prove ORDERING rather than just the end result. The
        // slot must only go back to the pool once nothing can still issue a
        // request on it, i.e. after status is "dead" and the session is already
        // out of activeSessions.
        statusAtRelease = session.snapshot.status;
        stillActiveAtRelease = listActiveDebugSessions().includes(session);
      },
    };
    const session = makeSession({ transport, sessionOpts: { sessionLease: lease } });

    await session.attach("D1");
    await session.terminate();

    expect(statusAtRelease).toBe("dead");
    expect(stillActiveAtRelease).toBe(false);
  });
});

describe("sessionLease is optional — a session built without one behaves exactly as before", () => {
  it("terminate() completes normally, nothing throws, with no sessionLease supplied", async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk()],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const session = makeSession({ transport }); // no sessionLease in sessionOpts, like every other test in this file

    await session.attach("D1");
    await expect(session.terminate()).resolves.toBeUndefined();
    expect(session.snapshot.status).toBe("dead");
    expect(session.snapshot.deathReason).toBe("terminated_by_caller");
  });
});

// ===========================================================================
// M15 — the easiest way to get this wrong: "fixing" `acquireSession` by
// wiring it to a SECOND pool.reserveDebug(...).
//
// reserveDebug is NOT re-entrant and DEBUG_CONCURRENCY = 1, so wiring
// acquireSession to a second pool.reserveDebug(...) would make the debug
// session refuse ITSELF with "lease-held" at arm time, inside run() — i.e.
// only on a REAL listen, which offline tests never exercise. The outer
// session-scope lease (DebugSessionOptions.sessionLease) strictly dominates
// that window: it is acquired before the client is built and released only at
// terminate, already covering the arm, the poll, the attach and every step. A
// future poll-scoped handle must be `acquireSession: async () =>
// outerLeaseHandle` returning a NO-OP release, never a second `reserveDebug`.
//
// `DebugLongPollAuth.acquireSession` is now REQUIRED (src/debug/transport.ts),
// so the literal below can no longer simply omit the field the way it used
// to — it must supply the explicit opt-out, `ACQUIRE_NO_SESSION_LEASE`, and
// these two tests now assert THAT identity instead of the field's absence.
// ===========================================================================

describe("M15 — createDebugClientForConnection's auth: literal wires the explicit ACQUIRE_NO_SESSION_LEASE opt-out, not a second pool.reserveDebug", () => {
  it("the live auth object it builds uses ACQUIRE_NO_SESSION_LEASE, not a pool-derived hook (reachable via the same authOf() the cookie-rotation tests use)", () => {
    const { conn } = makeFakeConnection("SAP_SESSIONID_A4H_001=X");
    const client = createDebugClientForConnection(conn, { safety: TEST_GATE });
    const auth = authOf(client) as AuthShape & { acquireSession: unknown };

    expect(auth.acquireSession).toBe(ACQUIRE_NO_SESSION_LEASE);
  });

  it("structural: src/debug/session.ts's auth: literal text assigns acquireSession: ACQUIRE_NO_SESSION_LEASE, not a pool.reserveDebug call (precedent: test/pool.test.ts's 'structural invariants of src/adt/pool.ts')", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/debug/session.ts", import.meta.url)), "utf8");
    const authStart = src.indexOf("auth: {");
    expect(authStart).toBeGreaterThan(-1);
    // The literal's closing brace, immediately followed by the next sibling key
    // in the same DebugLongPollOptions object — anchoring on that sibling avoids
    // matching a stray "}," inside the literal's own nested arrow functions.
    const authEnd = src.indexOf("\n    },\n    listenTimeoutMs:", authStart);
    expect(authEnd).toBeGreaterThan(authStart);
    const authLiteral = src.slice(authStart, authEnd);

    expect(authLiteral).toMatch(/acquireSession:\s*ACQUIRE_NO_SESSION_LEASE\b/);
    expect(authLiteral).not.toMatch(/reserveDebug/);
  });
});

// ===========================================================================
// 19. armLock — cross-PROCESS exclusion on the one debugger slot a
// system/client/user has (src/debug/arm-lock.ts).
//
// The real implementation is exercised against a real filesystem in
// test/debug-arm-lock.test.ts. What is under test HERE is the other half, and
// the half that actually decides whether the guard holds: WHERE `DebugSession`
// acquires and releases it. A lock taken after `launchListener` guards
// nothing; a lock not released on some exit path bricks debugging for every
// process sharing the state dir until the hard-stale valve fires an hour
// later. Both are ordering facts about THIS file, so they are tested with a
// recording double and no filesystem at all.
// ===========================================================================

/** Records the ORDER of acquire/release against the listener calls. */
function makeRecordingArmLock(events: string[], opts: { refuse?: unknown; throwOnRelease?: boolean } = {}) {
  let acquires = 0;
  let releases = 0;
  const lock: DebugArmLock = {
    async acquire() {
      acquires++;
      events.push("acquire");
      if (opts.refuse !== undefined) throw opts.refuse;
    },
    release() {
      releases++;
      events.push("release");
      if (opts.throwOnRelease) throw new Error("release blew up");
    },
  };
  return { lock, acquires: () => acquires, releases: () => releases };
}

/** `listen()` throws synchronously — the one arm failure that never produces a handle. */
class ThrowingListener implements DebugListenIssuer {
  listen(): LongPollHandle {
    throw new AbapError("AUTH_CIRCUIT_OPEN", "circuit open before dispatch");
  }
}

/**
 * A listener whose `result` can be rejected on demand. `armed` decides WHICH
 * of the two failure paths the rejection lands on, because
 * `armListener()` races `armed` against `result`:
 *
 *   - `"resolved"` — `armed` wins the race, so `armListener()` SUCCEEDS and the
 *     rejection surfaces later, out of `waitForDebuggee()`.
 *   - `"pending"`  — `armed` never settles, so `result`'s rejection wins and
 *     `armListener()` itself throws (a listen that failed on dispatch).
 */
class RejectingResultListener implements DebugListenIssuer {
  public abortCount = 0;
  private rejectFn!: (e: unknown) => void;
  private readonly deferred: Promise<RawResponse>;
  constructor(private readonly armedMode: "resolved" | "pending" = "resolved") {
    this.deferred = new Promise<RawResponse>((_res, rej) => {
      this.rejectFn = rej;
    });
    // Nothing awaits `deferred` until the session does; park a no-op handler
    // so a rejection that lands earlier is never an unhandled rejection.
    void this.deferred.catch(() => undefined);
  }
  listen(): LongPollHandle {
    return {
      armed: this.armedMode === "resolved" ? Promise.resolve() : new Promise<void>(() => undefined),
      result: this.deferred,
      abort: () => {
        this.abortCount++;
      },
      aborted: false,
    };
  }
  rejectWith(e: unknown): void {
    this.rejectFn(e);
  }
}

describe("armLock — acquisition happens before the listener is launched", () => {
  it("acquires BEFORE launchListener, so no window exists where two processes are both armed", async () => {
    const transport = new FakeTransport({ stopListener: [OK] });
    const events: string[] = [];
    const listener = new FakeListener();
    const orig = listener.listen.bind(listener);
    listener.listen = (path: string) => {
      events.push("launchListener");
      return orig(path);
    };
    const { lock } = makeRecordingArmLock(events);
    const session = makeSession({ transport, listener, sessionOpts: { armLock: lock } });

    await session.armListener();
    // Ordering, not merely presence: acquiring AFTER dispatch would leave a
    // window in which this process is already visible to SAP as a listener
    // while another process still believes the slot is free — exactly the race
    // this lock exists to close.
    expect(events).toEqual(["acquire", "launchListener"]);
    expect(session.snapshot.status).toBe("listening");
  });

  it("a refused lock rejects armListener() without launching anything, leaving the session idle", async () => {
    const transport = new FakeTransport({});
    const listener = new FakeListener();
    const events: string[] = [];
    const refusal = new AbapError("DEBUG_SESSION_LOCKED_CROSS_PROCESS", "another process holds the slot");
    const { lock, releases } = makeRecordingArmLock(events, { refuse: refusal });
    const session = makeSession({ transport, listener, sessionOpts: { armLock: lock } });

    await expect(session.armListener()).rejects.toBe(refusal);
    expect(listener.lastPath).toBeUndefined(); // nothing was ever dispatched
    expect(session.snapshot.status).toBe("idle");
    // Nothing was acquired, so nothing may be released — a release here would
    // unlink the OTHER process's lock file the instant it refused us.
    expect(releases()).toBe(0);
  });

  it("does not take the lock for a refusal this process can decide on its own", async () => {
    const transport = new FakeTransport({});
    const events: string[] = [];
    const { lock, acquires } = makeRecordingArmLock(events);
    const session = makeSession({ transport, listener: new FakeListener(), sessionOpts: { armLock: lock } });

    await session.armListener();
    events.length = 0;
    // Already "listening": the status guard rejects before the lock is
    // touched. Creating and unlinking a lock file for a locally-refused arm
    // would make every such call a brief outage for whoever is legitimately
    // debugging.
    await expect(session.armListener()).rejects.toSatisfy((e: unknown) => isAbapError(e) && e.code === "BAD_INPUT");
    expect(events).toEqual([]);
    expect(acquires()).toBe(1);
  });
});

describe("armLock — released on every path that stops listening", () => {
  it("releases when launchListener throws synchronously", async () => {
    const transport = new FakeTransport({});
    const events: string[] = [];
    const { lock, releases } = makeRecordingArmLock(events);
    const session = makeSession({
      transport,
      listener: new ThrowingListener() as unknown as FakeListener,
      sessionOpts: { armLock: lock },
    });

    await expect(session.armListener()).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "AUTH_CIRCUIT_OPEN",
    );
    // No handle was ever created, so none of the handle-teardown paths would
    // otherwise run — without an explicit release the slot stays held by a
    // session that never armed and will never terminate.
    expect(releases()).toBe(1);
    expect(session.snapshot.status).toBe("idle");
  });

  it("releases when the arm itself fails, so the caller can legitimately re-arm", async () => {
    const transport = new FakeTransport({});
    const events: string[] = [];
    const { lock, acquires, releases } = makeRecordingArmLock(events);
    // `armed` stays pending, so the rejected `result` wins the race inside
    // armListener() — this is the "the listen failed on dispatch" shape.
    const listener = new RejectingResultListener("pending");
    const session = makeSession({
      transport,
      listener: listener as unknown as FakeListener,
      sessionOpts: { armLock: lock },
    });

    listener.rejectWith(new AbapError("AUTH_CIRCUIT_OPEN", "boom"));
    await expect(session.armListener()).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "AUTH_CIRCUIT_OPEN",
    );
    expect(session.snapshot.status).toBe("idle");
    expect(events).toEqual(["acquire", "release"]);
    expect(acquires()).toBe(1);
    expect(releases()).toBe(1);
  });

  it("releases on a listener timeout, which returns the session to idle without a terminate()", async () => {
    const transport = new FakeTransport({ stopListener: [OK] });
    const events: string[] = [];
    const { lock, releases } = makeRecordingArmLock(events);
    const listener = new FakeListener();
    const session = makeSession({ transport, listener, sessionOpts: { armLock: lock } });

    await session.armListener();
    expect(releases()).toBe(0);
    listener.resolveWith(okResponse("")); // empty body = the server hold expired
    expect((await session.waitForDebuggee()).kind).toBe("timeout");

    // `waitForDebuggee` already DELETEd the server-side registration and went
    // back to "idle"; a caller that gives up here may never call terminate(),
    // so this is the path that must hand the slot back.
    expect(session.snapshot.status).toBe("idle");
    expect(releases()).toBe(1);
  });

  it("does NOT release when the poll rejects — the session is still 'listening' server-side", async () => {
    const transport = new FakeTransport({ stopListener: [OK], setBreakpoints: [BREAKPOINTS_OK] });
    const events: string[] = [];
    const { lock, releases } = makeRecordingArmLock(events);
    const listener = new RejectingResultListener();
    const session = makeSession({
      transport,
      listener: listener as unknown as FakeListener,
      sessionOpts: { armLock: lock },
    });

    await session.armListener();
    listener.rejectWith(new AbapError("HTTP_ERROR", "socket died"));
    await expect(session.waitForDebuggee()).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "HTTP_ERROR",
    );

    // Deliberate: the status stays "listening" and the server-side
    // registration may well have survived a purely local failure, so this
    // process is still the one SAP would hand a debuggee to. Releasing here
    // would let a second process arm against a live listener. terminate() is
    // what ends this state, and it releases.
    expect(session.snapshot.status).toBe("listening");
    expect(releases()).toBe(0);

    await session.terminate();
    expect(releases()).toBe(1);
  });

  it("holds the lock across catch and attach, and releases exactly once at terminate", async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk()],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const events: string[] = [];
    const { lock, acquires, releases } = makeRecordingArmLock(events);
    const listener = new FakeListener();
    const session = makeSession({ transport, listener, sessionOpts: { armLock: lock } });

    await session.armListener();
    listener.resolveWith(okResponse(debuggeeXml("D1")));
    expect((await session.waitForDebuggee()).kind).toBe("debuggee");
    await session.attach("D1");
    // The whole point of holding it this long: a second process must not be
    // able to arm while this one has a suspended debuggee.
    expect(releases()).toBe(0);

    await session.terminate();
    expect(session.snapshot.status).toBe("dead");
    expect(acquires()).toBe(1);
    expect(releases()).toBe(1);

    // Once "dead", terminate()/cleanup() short-circuit before doTerminate, so
    // the lock cannot be double-released out from under a later holder that
    // shares this instance (the `releaseOrphanDebuggee` probe does).
    await session.terminate();
    await session.cleanup();
    expect(releases()).toBe(1);
  });

  it("releases even when every teardown step hangs past the total deadline", async () => {
    const transport = new FakeTransport({
      attach: [HANGS],
      terminateDebuggee: [HANGS],
      stopListener: [HANGS],
      setBreakpoints: [HANGS],
    });
    const events: string[] = [];
    const { lock, releases } = makeRecordingArmLock(events);
    const listener = new FakeListener();
    const session = makeSession({ transport, listener, sessionOpts: { armLock: lock } });

    await session.armListener();
    listener.resolveWith(okResponse(debuggeeXml("D1")));
    expect((await session.waitForDebuggee()).kind).toBe("debuggee");

    const pending = session.terminate();
    await vi.advanceTimersByTimeAsync(4_100); // past TERMINATE_TOTAL_DEADLINE_MS
    await flushMicrotasks();
    await expect(pending).resolves.toBeUndefined();

    // An abandoned SAP-side cleanup is not a reason to keep a filesystem lock:
    // the session is "dead" and can no longer issue anything, so the slot goes
    // back regardless of what the network did.
    expect(session.snapshot.status).toBe("dead");
    expect(releases()).toBe(1);
  });

  it("a throwing release() cannot break the teardown that must always complete", async () => {
    const transport = new FakeTransport({
      attach: [attachOk()],
      getStack: [stackOk()],
      terminateDebuggee: [TERMINATE_OK],
      stopListener: [OK],
      setBreakpoints: [BREAKPOINTS_OK],
    });
    const events: string[] = [];
    const { lock } = makeRecordingArmLock(events, { throwOnRelease: true });
    const listener = new FakeListener();
    const session = makeSession({ transport, listener, sessionOpts: { armLock: lock } });

    await session.armListener();
    listener.resolveWith(okResponse(debuggeeXml("D1")));
    await session.waitForDebuggee();
    await expect(session.terminate()).resolves.toBeUndefined();
    expect(session.snapshot.status).toBe("dead");
    expect(listActiveDebugSessions()).not.toContain(session);
  });
});
