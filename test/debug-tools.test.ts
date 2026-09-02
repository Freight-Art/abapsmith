/**
 * Offline unit tests for the MCP tool surface in `src/tools/debug.ts`
 * (`abap_debug` / `abap_debug_vars` / `abap_debug_value`). Zero live SAP
 * calls — every test runs against a hand-rolled `DebugToolDeps` whose
 * `createSession` wires a REAL `DebugSession` (`src/debug/session.js`) to a
 * REAL `DebugClient` (`src/debug/client.js`) sitting on top of fake
 * `DebugRequestIssuer`/`DebugListenIssuer` implementations, exactly the
 * pattern `test/debug-client.test.ts` and `test/debug-session.test.ts` use
 * one layer down. `createTriggerConnection`/`resolveObject`/`triggerRun` are
 * plain fakes — never a real `AbapConnection`.
 *
 * Two pieces of module-level state are shared across every test in this file,
 * IN TEST-EXECUTION ORDER:
 *   - `src/tools/debug.ts`'s own `currentRun` (the "current debug session"),
 *     cleared by calling `abapDebug({action:"stop"})`.
 *   - `src/debug/session.ts`'s `activeSessions` registry, which every
 *     `DebugSession` constructor adds itself to and only removes itself from
 *     once it reaches status `"dead"`.
 * The `afterEach` below unconditionally calls `abapDebug({action:"stop"})`,
 * swallowing any error, so a session that only got as far as "listening" (an
 * armed-but-never-attached session, e.g. after the second-start-refused
 * test) is still driven to `"dead"` before the next test's `start` runs.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { AbapConnection, type ConnectionOptions } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { AdtSessionPool } from "../src/adt/pool.js";
import { SessionBusyError } from "../src/adt/session-lock.js";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import { specForType } from "../src/adt/types.js";
import type { BuiltResponse } from "../src/compact.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { DebugClient, type DebugListenIssuer, type DebugRequestIssuer } from "../src/debug/client.js";
import {
  DebugSession,
  forceDropDebugSession,
  listActiveDebugSessions,
  shutdownAllDebugSessions,
} from "../src/debug/session.js";
import type { DebugRequestOptions, LongPollHandle } from "../src/debug/transport.js";
import type { RawResponse } from "../src/debug/types.js";
import {
  abapDebug,
  abapDebugValue,
  abapDebugVars,
  createLiveDebugToolDeps,
  DebugInput,
  DebugValueInput,
  DebugVarsInput,
  MAX_TABLE_ROWS,
  shutdownDebugTools,
  type DebugToolDeps,
} from "../src/tools/debug.js";

// ---------------------------------------------------------------------------
// Fixture builders — minimal XML matching what src/debug/xml-response.ts
// parses, adapted from test/debug-session.test.ts's fixture builders.
// ---------------------------------------------------------------------------

const TERMINAL = "A".repeat(32);
const IDE = "B".repeat(32);

function buildAttachXml(debugSessionId: string): string {
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

function buildStepXml(overrides: {
  debugSessionId?: string;
  isSteppingPossible?: boolean;
  isTerminationPossible?: boolean;
} = {}): string {
  const debugSessionId = overrides.debugSessionId ?? "SESS1";
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

function buildStackXml(programName: string, line: number): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<dbg:stack xmlns:dbg="http://www.sap.com/adt/debugger" isRfc="false" isSameSystem="true"
  serverName="A4HSANDBOX_A4H_01" debugCursorStackIndex="1">
  <dbg:stackEntry stackPosition="1" stackType="ABAP"
    stackUri="/sap/bc/adt/debugger/stack/type/ABAP/position/1"
    programName="${programName}" includeName="${programName}" line="${line}" eventType="REPORT"
    eventName="${programName}" sourceType="ABAP" systemProgram="false" isVit="false"
    uri="/sap/bc/adt/programs/programs/${programName}/source/main#start=${line}"/>
</dbg:stack>`;
}

/** Two frames, for the `action:"frame"` tests — a `stackPosition=1` top frame and a `stackPosition=2` caller frame. */
function buildTwoFrameStackXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<dbg:stack xmlns:dbg="http://www.sap.com/adt/debugger" isRfc="false" isSameSystem="true"
  serverName="A4HSANDBOX_A4H_01" debugCursorStackIndex="0">
  <dbg:stackEntry stackPosition="1" stackType="ABAP"
    stackUri="/sap/bc/adt/debugger/stack/type/ABAP/position/1"
    programName="ZTEST_MCP_CRUD" includeName="ZTEST_MCP_CRUD" line="15" eventType="METHOD"
    eventName="LINE_VALUE" sourceType="ABAP" systemProgram="false" isVit="false"
    uri="/sap/bc/adt/programs/programs/ztest_mcp_crud/source/main#start=15"/>
  <dbg:stackEntry stackPosition="2" stackType="ABAP"
    stackUri="/sap/bc/adt/debugger/stack/type/ABAP/position/2"
    programName="ZTEST_MCP_CRUD" includeName="ZTEST_MCP_CRUD" line="9" eventType="REPORT"
    eventName="ZTEST_MCP_CRUD" sourceType="ABAP" systemProgram="false" isVit="false"
    uri="/sap/bc/adt/programs/programs/ztest_mcp_crud/source/main#start=9"/>
</dbg:stack>`;
}

function buildDebuggeeXml(id: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>
<STPDA_DEBUGGEE><CLIENT>001</CLIENT><DEBUGGEE_ID>${id}</DEBUGGEE_ID><TERMINAL_ID>${TERMINAL}</TERMINAL_ID>
<IDE_ID>${IDE}</IDE_ID><DEBUGGEE_USER>TESTUSER</DEBUGGEE_USER><PRG_CURR>ZTEST_MCP_CRUD</PRG_CURR>
<INCL_CURR>ZTEST_MCP_CRUD</INCL_CURR><LINE_CURR>15</LINE_CURR><RFCDEST></RFCDEST>
<APPLSERVER>A4HSANDBOX</APPLSERVER><SYSID>A4H</SYSID><SYSNR>0</SYSNR><TSTMP>20260731120000</TSTMP>
<DBGEE_KIND>DEBUGGEE</DBGEE_KIND><IS_ATTACH_IMPOSSIBLE></IS_ATTACH_IMPOSSIBLE><IS_SAME_SERVER>X</IS_SAME_SERVER>
<INSTANCE_NAME>A4H_01</INSTANCE_NAME></STPDA_DEBUGGEE></DATA></asx:values></asx:abap>`;
}

/** Non-empty on purpose — a self-closing root parses to `""`, not an object. */
const BREAKPOINTS_XML =
  `<?xml version="1.0"?><dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger">` +
  `<dbg:breakpoint kind="line" id="BP1"/></dbg:breakpoints>`;

/** `getChildVariables(["@ROOT"])` response — Trap C: zero variables, one scope hierarchy row. */
const SCOPE_XML = `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><HIERARCHIES>
<STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>@ROOT</PARENT_ID><CHILD_ID>@GLOBALS</CHILD_ID><CHILD_NAME>Globals</CHILD_NAME></STPDA_ADT_VARIABLE_HIERARCHY>
</HIERARCHIES><VARIABLES/></DATA></asx:values></asx:abap>`;

/** `getChildVariables(["@GLOBALS"])` response — the real variables: one scalar, one table. */
const LOCALS_XML = `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><HIERARCHIES/><VARIABLES>
<STPDA_ADT_VARIABLE><ID>LV_COUNTER</ID><NAME>LV_COUNTER</NAME><META_TYPE>simple</META_TYPE><VALUE>42</VALUE></STPDA_ADT_VARIABLE>
<STPDA_ADT_VARIABLE><ID>LT_ITEMS</ID><NAME>LT_ITEMS</NAME><META_TYPE>table</META_TYPE><VALUE></VALUE><TABLE_LINES>3</TABLE_LINES></STPDA_ADT_VARIABLE>
</VARIABLES></DATA></asx:values></asx:abap>`;

/** `tableLines: "omit"` drops the `<TABLE_LINES>` tag entirely — the wire shape `optNum()` (xml-response.ts) parses to `undefined`, i.e. "row count unavailable". */
function buildVariablesXml(rows: Array<{ id: string; name: string; metaType: string; value?: string; tableLines?: number | "omit" }>): string {
  const body = rows
    .map(
      (r) =>
        `<STPDA_ADT_VARIABLE><ID>${r.id}</ID><NAME>${r.name}</NAME><META_TYPE>${r.metaType}</META_TYPE>` +
        `<VALUE>${r.value ?? ""}</VALUE>${r.tableLines === "omit" ? "" : `<TABLE_LINES>${r.tableLines ?? 0}</TABLE_LINES>`}</STPDA_ADT_VARIABLE>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>${body}</DATA></asx:values></asx:abap>`;
}

const okResponse = (body = ""): RawResponse => ({ status: 200, headers: {}, body });

/**
 * The 2026-07 appliance captures, read STRAIGHT from `test/fixtures/live-captured/`
 * — never copied inline. These bytes are the evidence for D19 (`getVariables`
 * answering a 4-id batch with 2 rows at HTTP 200); a transcription of them would
 * be a second source of truth that can drift from what the server actually sent.
 * `test/fixtures/debugger/` is deliberately NOT used for the D19 assertions: several
 * files there are hand-authored and are known to contradict the wire.
 */
const LIVE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const live = (name: string): string => readFileSync(join(LIVE_DIR, name), "utf8");

// ---------------------------------------------------------------------------
// Wire-level fakes — classify every transport.request() call by "op kind"
// and push that kind onto a SHARED log array (the ordering evidence), then
// dispatch to a per-test responder table (kind -> RawResponse | fn).
// ---------------------------------------------------------------------------

function classify(opts: DebugRequestOptions): string {
  const { method, path, body } = opts;
  if (path.includes("/debugger/listeners")) return method === "DELETE" ? "stopListener" : "getListener";
  if (/[?&]method=setStackPosition(&|$)/.test(path)) return "setStackPosition";
  if (path.includes("/debugger/breakpoints")) {
    return body?.includes('validationOnly="true"') ? "setBreakpoints:validate" : "setBreakpoints:real";
  }
  if (path.includes("/debugger/stack")) return "getStack";
  const methodParam = /[?&]method=([^&]+)/.exec(path)?.[1];
  if (methodParam === "attach") return "attach";
  if (methodParam === "terminateDebuggee") return "terminateDebuggee";
  if (methodParam === "getVariables") return "getVariables";
  if (methodParam === "getChildVariables") return body?.includes("@ROOT") ? "getChildVariables:root" : "getChildVariables:scopes";
  const stepKinds = new Set(["stepInto", "stepOver", "stepReturn", "stepContinue", "stepRunToLine", "stepJumpToLine"]);
  if (methodParam && stepKinds.has(decodeURIComponent(methodParam))) return "step";
  return "other";
}

type ResponderEntry = RawResponse | ((opts: DebugRequestOptions) => RawResponse);
type ResponderTable = Partial<Record<string, ResponderEntry>>;

class FakeTransport implements DebugRequestIssuer {
  public readonly calls: DebugRequestOptions[] = [];
  constructor(
    private readonly log: string[],
    private readonly table: ResponderTable,
  ) {}
  async request(opts: DebugRequestOptions): Promise<RawResponse> {
    this.calls.push(opts);
    const kind = classify(opts);
    this.log.push(kind);
    const entry = this.table[kind];
    if (!entry) {
      throw new Error(`FakeTransport: no responder configured for kind="${kind}" (${opts.method} ${opts.path})`);
    }
    return typeof entry === "function" ? entry(opts) : entry;
  }
}

interface FakeListenerOpts {
  /**
   * `listen()` throws this synchronously. Since `DebugSession.armListener()` no
   * longer polls `getListener()` for confirmation (that poll ran on the SAME SAP
   * session as the outstanding listener and was head-of-line blocked behind it
   * for the remainder of its timeout — live capture showed the listener itself
   * was never killed by this, so it was removed as dead weight rather than a
   * fix for a real kill), a failing `launchListener` is the ONLY remaining way
   * to fail `armListener()`.
   */
  throwOnListen?: Error;
  /**
   * `armed` stays pending until `releaseArmed()` is called, and logs
   * `"listener:armed"` when it resolves. This is what lets a test pin
   * "the trigger fires only after arming COMPLETED" (GAP 4) rather than merely
   * "after the listener POST was dispatched".
   */
  manualArm?: boolean;
}

/** Controllable deferred long-poll result — a test resolves it whenever it likes. */
class FakeListener implements DebugListenIssuer {
  public abortCount = 0;
  private resolveFn!: (r: RawResponse) => void;
  private readonly deferred: Promise<RawResponse>;
  private readonly armedPromise: Promise<void>;
  private releaseArmedFn: () => void = () => {};
  constructor(
    private readonly log: string[],
    private readonly opts: FakeListenerOpts = {},
  ) {
    this.deferred = new Promise<RawResponse>((resolve) => {
      this.resolveFn = resolve;
    });
    this.armedPromise = opts.manualArm
      ? new Promise<void>((resolve) => {
          this.releaseArmedFn = (): void => {
            this.log.push("listener:armed");
            resolve();
          };
        })
      : Promise.resolve();
  }
  listen(): LongPollHandle {
    this.log.push("listener:launch");
    if (this.opts.throwOnListen) throw this.opts.throwOnListen;
    return {
      armed: this.armedPromise,
      result: this.deferred,
      abort: () => {
        this.abortCount++;
      },
      aborted: false,
    };
  }
  /** Completes `armed` — only meaningful with `manualArm`. */
  releaseArmed(): void {
    this.releaseArmedFn();
  }
  resolveWith(r: RawResponse): void {
    this.resolveFn(r);
  }
}

/** Drains dangling microtask chains. Real timers are needed only where a test says so: `armListener()` awaits `handle.armed`, which this fake resolves immediately unless `manualArm` is set. */
async function flushMicrotasks(times = 50): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function extractStateId(text: string): string | undefined {
  return /^stateId: (\S+)$/m.exec(text)?.[1];
}

// ---------------------------------------------------------------------------
// DebugToolDeps fake
// ---------------------------------------------------------------------------

/** Records every `triggerConn.shutdown()` call — findings 2 and 6 assert on the COUNT, not on a log string. */
interface ShutdownSpy {
  count: number;
  reasons: unknown[];
}

const newShutdownSpy = (): ShutdownSpy => ({ count: 0, reasons: [] });

interface MakeDepsOpts {
  log: string[];
  transport: FakeTransport;
  listener: FakeListener;
  /** Default: resolves immediately with a generic captured-output string. */
  triggerImpl?: (...args: unknown[]) => Promise<BuiltResponse>;
  /** Counts `triggerConn.shutdown()` invocations and captures its argument. */
  shutdownSpy?: ShutdownSpy;
  /**
   * Replaces the default resolving `triggerConn.shutdown`. Deliberately NOT `async`
   * so an impl that throws synchronously really does throw synchronously (finding 6).
   */
  triggerConnShutdownImpl?: (reason?: unknown) => Promise<void>;
  /** Collects whatever the tool writes to the optional `DebugToolDeps.log` sink (finding 6). */
  depsLog?: string[];
  /**
   * GAP 1: shortens `armListener()`'s registration budget so the "registration is
   * never confirmed" failure point can be exercised in tens of milliseconds
   * instead of the 2 s default. Only that one test needs it.
   */
  registrationPollTimeoutMs?: number;
  /** Captures `triggerConn.dispose()` calls (finding: leaked process listeners) — pass a `vi.fn()` to assert on it directly. */
  disposeSpy?: ReturnType<typeof vi.fn>;
}

function makeDeps(opts: MakeDepsOpts): DebugToolDeps {
  const triggerImpl =
    opts.triggerImpl ?? (async () => ({ text: "DEFAULT PROGRAM OUTPUT", truncated: false, estimatedTokens: 4 }));
  return {
    log: (msg: string) => {
      opts.depsLog?.push(msg);
    },
    createSession(_conn, _safety, sessionOpts) {
      const client = new DebugClient({ transport: opts.transport, longPoll: opts.listener });
      return new DebugSession({
        client,
        context: { debuggingMode: "user", terminalId: TERMINAL, ideId: IDE, requestUser: "DEV" },
        registrationPollIntervalMs: 5,
        registrationPollTimeoutMs: opts.registrationPollTimeoutMs ?? 2_000,
        idleTimeoutMs: 300_000,
        log: sessionOpts?.log,
        // Forwarded so the M11/M13 tests below (search "sessionLease") can prove
        // `DebugSession` releases a REAL pool lease at terminate and not before.
        // Every existing test leaves `sessionOpts.sessionLease` undefined, so
        // this line changes nothing for them.
        sessionLease: sessionOpts?.sessionLease,
      });
    },
    async createTriggerConnection() {
      opts.log.push("createTriggerConnection");
      const disposeFn = opts.disposeSpy ?? vi.fn();
      return {
        shutdown: (reason?: unknown): Promise<void> => {
          opts.log.push("triggerConn.shutdown");
          if (opts.shutdownSpy) {
            opts.shutdownSpy.count++;
            opts.shutdownSpy.reasons.push(reason);
          }
          if (opts.triggerConnShutdownImpl) return opts.triggerConnShutdownImpl(reason);
          return Promise.resolve();
        },
        dispose: (...args: unknown[]) => {
          opts.log.push("triggerConn.dispose");
          return disposeFn(...args);
        },
      } as unknown as AbapConnection;
    },
    async resolveObject(_conn, ref) {
      opts.log.push(`resolveObject:${ref}`);
      const spec = specForType("PROG/P")!;
      const resolved: ResolvedObject = {
        system: "A4H",
        type: "PROG/P",
        kind: "PROG",
        label: ref,
        name: ref.toUpperCase(),
        uri: `/sap/bc/adt/programs/programs/${ref.toLowerCase()}`,
        sourceUri: `/sap/bc/adt/programs/programs/${ref.toLowerCase()}/source/main`,
        packageName: "$TMP",
        mode: "source",
        spec,
      };
      return resolved;
    },
    triggerRun(...args: unknown[]) {
      opts.log.push("triggerRun:fired");
      return triggerImpl(...args);
    },
  } as DebugToolDeps;
}

const DUMMY_CONN = {} as unknown as AbapConnection;

/** A `DebugToolDeps` whose methods should never actually be invoked (the `stop`/`status` paths never call `deps`). */
const UNUSED_DEPS: DebugToolDeps = {
  createSession: () => {
    throw new Error("createSession should not be called by a stop-only afterEach");
  },
  createTriggerConnection: async () => {
    throw new Error("createTriggerConnection should not be called by a stop-only afterEach");
  },
  resolveObject: async () => {
    throw new Error("resolveObject should not be called by a stop-only afterEach");
  },
  triggerRun: async () => {
    throw new Error("triggerRun should not be called by a stop-only afterEach");
  },
};

const HAPPY_TABLE = (overrides: Partial<ResponderTable> = {}): ResponderTable => ({
  "setBreakpoints:validate": okResponse(BREAKPOINTS_XML),
  "setBreakpoints:real": okResponse(BREAKPOINTS_XML),
  getListener: okResponse(""),
  stopListener: okResponse(""),
  attach: okResponse(buildAttachXml("SESS1")),
  getStack: okResponse(buildStackXml("ZTEST_MCP_CRUD", 15)),
  "getChildVariables:root": okResponse(SCOPE_XML),
  "getChildVariables:scopes": okResponse(LOCALS_XML),
  terminateDebuggee: okResponse(""),
  ...overrides,
});

const START_INPUT = {
  action: "start",
  breakpoints: [{ kind: "line", object: "ZTEST_MCP_CRUD", line: 15 }],
  run: { object: "ZTEST_MCP_CRUD", mode: "report" },
} as DebugInput;

// `abapDebug`'s `gate` parameter is REQUIRED (see D4 below and
// src/tools/debug.ts) — every call in this file must pass one, matching
// production (src/server.ts constructs exactly one process-wide `SafetyGate`
// and `debug-register.ts` always threads it through). Defined here, ahead of
// first use, rather than down by the D4 block that motivates them, because
// nearly every test in the file now needs one and not just D4's.
/** The shipping default: `ABAP_ALLOW_WRITE` unset. */
const readOnlyGate = (): SafetyGate => new SafetyGate({ readOnly: true, allowPackages: ["$TMP"] });

/** Writes enabled the way an operator would enable them for this fixture object. */
const writableGate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], allowNamePrefixes: ["Z"] });

// ---------------------------------------------------------------------------
// Global cleanup — every test that starts a session MUST end with the
// module-level `currentRun` cleared and every constructed `DebugSession`
// driven to "dead" (removed from `activeSessions`), or later tests spuriously
// see "a session is already live".
// ---------------------------------------------------------------------------

/**
 * GAP 6: teardown used to be `...stop...).catch(() => {})`, which swallowed a
 * genuine `stop` failure and let it cascade — the NEXT test then failed with
 * "a session is already live" and the blame landed on the wrong test.
 *
 * Two outcomes are legitimate here and must stay tolerated:
 *   - `stop` succeeds (there was a session, it is gone now), and
 *   - `stop` refuses because there is no active session at all (the common
 *     case: a test that never started one, or a start that failed).
 * Anything else is a real teardown failure and is rethrown FROM THIS
 * `afterEach`, so vitest attributes it to the test that actually caused it.
 *
 * Note `handleStop` returns a normal response (never throws) when nothing is
 * active, so the "no active session" branch below is a belt-and-braces guard
 * against that contract changing, not the routine path.
 */
function isNoActiveSessionRefusal(e: unknown): boolean {
  return isAbapError(e) && e.code === "BAD_INPUT" && /no active debug session/i.test(e.message);
}

afterEach(async () => {
  let stopError: unknown;
  try {
    await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
  } catch (e) {
    stopError = e;
  }
  if (stopError !== undefined && !isNoActiveSessionRefusal(stopError)) {
    throw new Error(
      "teardown: abap_debug({action:\"stop\"}) failed after this test — the failure belongs to THIS " +
        `test, not to the next one: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 1. Full start choreography ordering
// ---------------------------------------------------------------------------

describe("abap_debug start — full choreography", () => {
  it("prepares breakpoints, arms the listener, fires the trigger, waits, then attaches — in that exact order", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const deps = makeDeps({ log, transport, listener });

    const promise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());

    await flushMicrotasks();
    // The trigger must have fired already, but attach must NOT have happened
    // yet — proves waitForDebuggee() is genuinely blocking on the long-poll,
    // not racing ahead of it.
    expect(log).toContain("triggerRun:fired");
    expect(log).not.toContain("attach");

    listener.resolveWith(okResponse(buildDebuggeeXml("D1")));
    const result = await promise;

    const idx = (tag: string): number => log.indexOf(tag);
    expect(idx("resolveObject:ZTEST_MCP_CRUD")).toBeGreaterThanOrEqual(0);
    expect(idx("setBreakpoints:validate")).toBeLessThan(idx("setBreakpoints:real"));
    // COARSE ON PURPOSE — this keys on the listener POST being DISPATCHED, which
    // is all this test ever pinned (it used to key on the first `getListener`
    // registration poll, an op `DebugSession.armListener()` no longer performs).
    // It cannot tell "the trigger fired after arming COMPLETED" from "the trigger
    // fired while arming was still in flight"; the GAP 4 test below does that,
    // and this one is deliberately left as the control that proves the difference.
    expect(idx("setBreakpoints:real")).toBeLessThan(idx("listener:launch"));
    expect(idx("listener:launch")).toBeLessThan(idx("createTriggerConnection"));
    expect(idx("createTriggerConnection")).toBeLessThan(idx("triggerRun:fired"));
    expect(idx("triggerRun:fired")).toBeLessThan(idx("attach"));
    expect(idx("attach")).toBeLessThan(idx("getStack"));
    expect(idx("getStack")).toBeLessThan(idx("getChildVariables:root"));
    expect(idx("getChildVariables:root")).toBeLessThan(idx("getChildVariables:scopes"));

    // Recognizable stack/variable content from the fixtures.
    expect(result.text).toContain("ZTEST_MCP_CRUD");
    expect(result.text).toContain("LV_COUNTER");
    expect(result.text).not.toMatch(/\.\.\./);
    expect(extractStateId(result.text)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2. Trigger rejection never escapes as an unhandled rejection
// ---------------------------------------------------------------------------

describe("abap_debug start — trigger rejection", () => {
  it("a rejected triggerRun never surfaces as an unhandled rejection, and start still succeeds", async () => {
    let unhandled: unknown;
    const onUnhandled = (reason: unknown): void => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const log: string[] = [];
      const listener = new FakeListener(log);
      const transport = new FakeTransport(log, HAPPY_TABLE());
      const deps = makeDeps({
        log,
        transport,
        listener,
        triggerImpl: async () => {
          throw new Error("classrun failed");
        },
      });

      const promise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
      await flushMicrotasks();
      listener.resolveWith(okResponse(buildDebuggeeXml("D2")));
      const result = await promise;

      expect(result.text).toContain("ZTEST_MCP_CRUD");
      expect(result.text).not.toMatch(/\.\.\./);

      // GAP 2: this used to be `flushMicrotasks()`, which made the check VACUOUS —
      // Node only emits `unhandledRejection` after the microtask queue has drained
      // AND the event loop has turned, so a microtask-only flush can never observe
      // one. Proven by planting a dangling `void deps.triggerRun(...)` in
      // handleStart: the microtask version stayed green, this one goes red.
      await flushMacrotasks();
      expect(unhandled).toBeUndefined();

      // Bonus: the eventually-surfaced program output correctly reports the
      // trigger's failure rather than fabricating success.
      const stopResult = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
      expect(stopResult.text).toContain("classrun failed");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Second start while a session is live is refused
// ---------------------------------------------------------------------------

describe("abap_debug start — refuses a second concurrent session", () => {
  it("names the current live status in the refusal", async () => {
    const log1: string[] = [];
    const listener1 = new FakeListener(log1);
    const transport1 = new FakeTransport(log1, HAPPY_TABLE());
    const deps1 = makeDeps({ log: log1, transport: transport1, listener: listener1 });

    const promise1 = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps1, writableGate());
    await flushMicrotasks();
    listener1.resolveWith(okResponse(buildDebuggeeXml("D3")));
    await promise1; // now "suspended"

    const log2: string[] = [];
    const listener2 = new FakeListener(log2);
    const transport2 = new FakeTransport(log2, {});
    const deps2 = makeDeps({ log: log2, transport: transport2, listener: listener2 });

    await expect(
      abapDebug(
        DUMMY_CONN,
        {
          action: "start",
          breakpoints: [{ kind: "line", object: "ZOTHER", line: 1 }],
          run: { object: "ZOTHER" },
        } as DebugInput,
        60_000,
        deps2,
        writableGate(),
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e) || e.code !== "UNSUPPORTED") return false;
      expect(e.message).toContain("suspended");
      return true;
    });

    // Explicit cleanup on top of the global afterEach — deps1's session must
    // not leak into the next test's activeSessions check.
    await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate()).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// 4. Stale stateId is refused, not auto-recovered
// ---------------------------------------------------------------------------

describe("stale stateId — refused across step/abap_debug_vars/abap_debug_value", () => {
  it("names the current stateId and never silently re-targets", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const deps = makeDeps({ log, transport, listener });

    const promise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
    await flushMicrotasks();
    listener.resolveWith(okResponse(buildDebuggeeXml("D4")));
    const startResult = await promise;
    const stateId1 = extractStateId(startResult.text);
    expect(stateId1).toBeTruthy();

    const stale = "deadbeef".repeat(8);

    await expect(
      abapDebug(DUMMY_CONN, { action: "step", step: "over", stateId: stale } as DebugInput, 60_000, deps, writableGate()),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e) || e.code !== "BAD_INPUT") return false;
      expect(e.message).toContain("Stale");
      expect(e.message).toContain(stateId1!);
      return true;
    });

    await expect(abapDebugVars({ stateId: stale }, 60_000)).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e)) return false;
      expect(e.message).toContain(stateId1!);
      return true;
    });

    await expect(abapDebugValue({ stateId: stale, path: "SY-SUBRC" }, 60_000)).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e)) return false;
      expect(e.message).toContain(stateId1!);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// 4b. a MISSING stateId (undefined — an untyped/JS caller bypassing the zod
// schema) is refused with its own distinct BAD_INPUT message, never routed
// through the "Stale stateId" path above (which would name a stateId the
// caller never sent and falsely imply a stale-but-real one was provided).
// ---------------------------------------------------------------------------

describe("missing stateId — refused distinctly from a stale one, across abap_debug_vars/abap_debug_value", () => {
  it("abap_debug_vars rejects an undefined stateId with its own BAD_INPUT message", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const deps = makeDeps({ log, transport, listener });

    const promise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
    await flushMicrotasks();
    listener.resolveWith(okResponse(buildDebuggeeXml("D4b")));
    await promise;

    await expect(
      abapDebugVars({ stateId: undefined } as unknown as DebugVarsInput, 60_000),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e) || e.code !== "BAD_INPUT") return false;
      expect(e.message).toContain('requires "stateId"');
      expect(e.message).not.toContain("Stale");
      return true;
    });
  });

  it("abap_debug_value rejects an undefined stateId with its own BAD_INPUT message", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const deps = makeDeps({ log, transport, listener });

    const promise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
    await flushMicrotasks();
    listener.resolveWith(okResponse(buildDebuggeeXml("D4c")));
    await promise;

    await expect(
      abapDebugValue({ stateId: undefined, path: "SY-SUBRC" } as unknown as DebugValueInput, 60_000),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e) || e.code !== "BAD_INPUT") return false;
      expect(e.message).toContain('requires "stateId"');
      expect(e.message).not.toContain("Stale");
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// 5. stop terminates and surfaces captured program output
// ---------------------------------------------------------------------------

describe("abap_debug stop — surfaces captured output", () => {
  it("terminates the session and the response text contains the trigger's captured output", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const deps = makeDeps({
      log,
      transport,
      listener,
      triggerImpl: async () => ({ text: "SOME DISTINCTIVE OUTPUT STRING", truncated: false, estimatedTokens: 6 }),
    });

    const promise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
    await flushMicrotasks();
    listener.resolveWith(okResponse(buildDebuggeeXml("D5")));
    await promise;

    const stopResult = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
    expect(stopResult.text).toContain("SOME DISTINCTIVE OUTPUT STRING");
    expect(stopResult.text).not.toMatch(/\.\.\./);
  });
});

// ---------------------------------------------------------------------------
// 6. abap_debug_value rejects a malformed path, naming the offending segment
// ---------------------------------------------------------------------------

describe("abap_debug_value — malformed path", () => {
  it("names the offending segment rather than a generic failure", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const deps = makeDeps({ log, transport, listener });

    const promise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
    await flushMicrotasks();
    listener.resolveWith(okResponse(buildDebuggeeXml("D6")));
    const startResult = await promise;
    const stateId1 = extractStateId(startResult.text)!;

    await expect(abapDebugValue({ stateId: stateId1, path: "LT_ITEMS[abc]" }, 60_000)).rejects.toSatisfy(
      (e: unknown) => {
        if (!isAbapError(e) || e.code !== "BAD_INPUT") return false;
        // The original two assertions, UNCHANGED — the offending segment must be
        // named, in the message and in `details.segment`.
        expect(e.message).toContain("[abc]");
        expect(e.details["segment"]).toBe("[abc]");
        // Tightened, not loosened: while this file was being written a sibling
        // agent reworked the path parser, briefly reporting the segment as the
        // bare token `"["`. It now reports BOTH the offending segment and where
        // it went wrong, so the extra precision is pinned here too — a future
        // revert to either the bare-token form or a generic message fails.
        expect(e.message).toMatch(/at position 8/);
        expect(e.message).toMatch(/expected "\[<positive integer>\]"/);
        expect(e.message).toMatch(/found "a" after "\["/);
        expect(e.details["path"]).toBe("LT_ITEMS[abc]");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Happy-path sweep across start/stack/vars/value/status/stop — also the
//    dedicated "no bare ellipsis anywhere" check.
// ---------------------------------------------------------------------------

describe("happy-path sweep — start, stack, abap_debug_vars, abap_debug_value (scalar + table), status, stop", () => {
  it("never emits a bare three-period ellipsis in any successful response", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(
      log,
      HAPPY_TABLE({
        getVariables: (opts) => {
          if (opts.body?.includes("LT_ITEMS[1]")) {
            return okResponse(
              buildVariablesXml([
                { id: "LT_ITEMS[1]", name: "LT_ITEMS[1]", metaType: "simple", value: "ROW1" },
                { id: "LT_ITEMS[2]", name: "LT_ITEMS[2]", metaType: "simple", value: "ROW2" },
                { id: "LT_ITEMS[3]", name: "LT_ITEMS[3]", metaType: "simple", value: "ROW3" },
              ]),
            );
          }
          if (opts.body?.includes("SY-SUBRC")) {
            return okResponse(buildVariablesXml([{ id: "SY-SUBRC", name: "SY-SUBRC", metaType: "simple", value: "0" }]));
          }
          if (opts.body?.includes("LT_ITEMS")) {
            return okResponse(buildVariablesXml([{ id: "LT_ITEMS", name: "LT_ITEMS", metaType: "table", tableLines: 3 }]));
          }
          throw new Error(`unexpected getVariables body: ${opts.body}`);
        },
      }),
    );
    const deps = makeDeps({ log, transport, listener });

    const startPromise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
    await flushMicrotasks();
    listener.resolveWith(okResponse(buildDebuggeeXml("D7")));
    const startResult = await startPromise;
    const stateId = extractStateId(startResult.text)!;
    expect(stateId).toBeTruthy();
    expect(startResult.text).not.toMatch(/\.\.\./);

    const stackResult = await abapDebug(DUMMY_CONN, { action: "stack", stateId } as DebugInput, 60_000, deps, writableGate());
    expect(stackResult.text).toContain("ZTEST_MCP_CRUD");
    expect(stackResult.text).not.toMatch(/\.\.\./);

    const varsResult = await abapDebugVars({ stateId, scope: "all" }, 60_000);
    expect(varsResult.text).toContain("LV_COUNTER");
    expect(varsResult.text).toContain("LT_ITEMS");
    expect(varsResult.text).not.toMatch(/\.\.\./);

    const scalarValue = await abapDebugValue({ stateId, path: "SY-SUBRC" }, 60_000);
    expect(scalarValue.text).toContain("SY-SUBRC");
    expect(scalarValue.text).not.toMatch(/\.\.\./);

    const tableValue = await abapDebugValue({ stateId, path: "LT_ITEMS" }, 60_000);
    expect(tableValue.text).toContain("LT_ITEMS");
    expect(tableValue.text).not.toMatch(/\.\.\./);

    const statusResult = await abapDebug(DUMMY_CONN, { action: "status" } as DebugInput, 60_000, deps, writableGate());
    expect(statusResult.text).toContain("suspended");
    expect(statusResult.text).not.toMatch(/\.\.\./);

    const stopResult = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
    expect(stopResult.text).not.toMatch(/\.\.\./);

    const idleStatus = await abapDebug(DUMMY_CONN, { action: "status" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
    expect(idleStatus.text).toContain("idle");
  });
});

// ---------------------------------------------------------------------------
// 8. Bonus: a natural session death mid-step (signal B) is a SUCCESSFUL
//    response with the captured program output, not a thrown error.
// ---------------------------------------------------------------------------

describe("abap_debug step — natural death mid-step (signal B)", () => {
  it("isSteppingPossible/isTerminationPossible both false yields success with captured output, no throw", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(
      log,
      HAPPY_TABLE({
        step: () => okResponse(buildStepXml({ debugSessionId: "SESS1", isSteppingPossible: false, isTerminationPossible: false })),
      }),
    );
    const deps = makeDeps({
      log,
      transport,
      listener,
      triggerImpl: async () => ({ text: "FINAL PROGRAM OUTPUT XYZ", truncated: false, estimatedTokens: 5 }),
    });

    const startPromise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
    await flushMicrotasks();
    listener.resolveWith(okResponse(buildDebuggeeXml("D8")));
    const startResult = await startPromise;
    const stateId1 = extractStateId(startResult.text)!;

    const stepResult = await abapDebug(
      DUMMY_CONN,
      { action: "step", step: "continue", stateId: stateId1 } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );
    expect(stepResult.text).toContain("FINAL PROGRAM OUTPUT XYZ");
    expect(stepResult.text).not.toMatch(/\.\.\./);
    // Defect 4: the structured `terminationResult` (session.ts) surfaces all the way
    // out to the tool response — a Signal-B death is unambiguously the "finished"
    // variant, distinct from "exception"/"session_ended", both in the header and in a
    // plain-English evidence note (composeDeathOutput's `renderTerminationEvidence`).
    expect(stepResult.text).toContain("terminationKind: finished");
    expect(stepResult.text).toContain("Termination evidence: the debuggee itself reported stepping/termination");

    // The session already reached "dead" naturally — a follow-up stop must
    // be a harmless no-op (currentRun was already cleared by handleStep).
    const stopResult = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
    expect(stopResult.text).toContain("idle");
  });
});

// ---------------------------------------------------------------------------
// 8b. Round 3 (`reports-fix/FIX-DEBUG-R2.md`, live 2026-08-14): three distinct
// real debuggee deaths (clean finish, failing ASSERT, uncaught
// CX_SY_ZERODIVIDE) all surfaced the SAME content-free "An exception was
// raised" boilerplate, printed twice, and the only discriminator anywhere
// was free text buried in PROGRAM OUTPUT. These tests cover the fix:
// `isGenericFallbackEvidence` suppresses the useless duplicate (structurally,
// by comparing `bodyExcerpt` to `detail`) without ever dropping a genuinely
// informative excerpt, and `triggerOutcome` surfaces a structured header
// discriminator read off the trigger bridge.
// ---------------------------------------------------------------------------

describe("abap_debug step — round 3: generic-fallback termination evidence is suppressed", () => {
  it("a Signal-A death whose bodyExcerpt is identical to its message/detail is never printed as evidence, in either historical location", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    let getStackCalls = 0;
    const transport = new FakeTransport(
      log,
      HAPPY_TABLE({
        // First getStack() is attach()'s own post-attach read — must succeed.
        // Second is the follow-up read after `step()`, on the SAME connection,
        // where Signal A fires. Mirrors the live mechanism exactly: on the
        // `AdtErrorException` landing (`src/debug/transport.ts`,
        // `adtErrorFromException` GROUND TRUTH comment), `.response` is absent,
        // so `bodyExcerpt` is built as `truncateDiagnosticBody(rawBody || message)`
        // — literally the same string as `message`.
        getStack: () => {
          getStackCalls++;
          if (getStackCalls === 1) return okResponse(buildStackXml("ZTEST_MCP_CRUD", 15));
          throw new AbapError("SESSION_DEAD", "An exception was raised", {
            bodyExcerpt: "An exception was raised",
          });
        },
        // The physical step itself succeeds (still-alive response) — Signal A
        // fires on the FOLLOW-UP getStack() above, not here.
        step: okResponse(buildStepXml({})),
      }),
    );
    const deps = makeDeps({
      log,
      transport,
      listener,
      triggerImpl: async () => ({
        text: "ZCL_ZMCP_RUN_ZFIXH_ITEM_C short-dumped: Division by zero",
        truncated: false,
        estimatedTokens: 8,
      }),
    });

    const stateId1 = await startSuspended(deps, listener, "D20");
    const stepResult = await abapDebug(
      DUMMY_CONN,
      { action: "step", step: "continue", stateId: stateId1 } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );

    expect(stepResult.text).toContain("terminationKind: session_ended");
    // Zero occurrences of the content-free generic string — not as a bare
    // NOTE (the old `deathDetail` location), not as "Raw evidence:" (the old
    // `renderTerminationEvidence` location). Both are the SAME defect.
    expect(stepResult.text).not.toContain("An exception was raised");
    expect(stepResult.text).not.toContain("Raw evidence:");
    // Suppressing the useless duplicate must not suppress the honest framing
    // sentence that says what IS and is NOT known.
    expect(stepResult.text).toContain(
      "the debug session ended (SAP reported the session/debuggee is gone), but the " +
        "response carried no exception class name",
    );

    const stopResult = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
    expect(stopResult.text).toContain("idle");
  });

  it("a Signal-A death whose bodyExcerpt genuinely differs from its message/detail still surfaces the excerpt as evidence", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    let getStackCalls = 0;
    const informativeExcerpt =
      "<exc:exception><message>Session Timed Out</message><localizedMessage>The session was closed by the " +
      "kernel after a hard timeout; diagnostic ID XYZ-789 — this text is NOT present in the message field." +
      "</localizedMessage></exc:exception>";
    const transport = new FakeTransport(
      log,
      HAPPY_TABLE({
        getStack: () => {
          getStackCalls++;
          if (getStackCalls === 1) return okResponse(buildStackXml("ZTEST_MCP_CRUD", 15));
          throw new AbapError("SESSION_DEAD", "Session Timed Out", { bodyExcerpt: informativeExcerpt });
        },
        step: okResponse(buildStepXml({})),
      }),
    );
    const deps = makeDeps({ log, transport, listener });

    const stateId1 = await startSuspended(deps, listener, "D21");
    const stepResult = await abapDebug(
      DUMMY_CONN,
      { action: "step", step: "continue", stateId: stateId1 } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );

    expect(stepResult.text).toContain("terminationKind: session_ended");
    // `detail` (the message) IS shown this time — it is no longer
    // indistinguishable from a generic fallback, since `bodyExcerpt` differs.
    expect(stepResult.text).toContain("Session Timed Out");
    // ...and the genuinely-different bodyExcerpt is NOT silently dropped — this
    // is the "never drop a genuinely informative excerpt" half of the fix.
    expect(stepResult.text).toContain("Raw evidence:");
    expect(stepResult.text).toContain("diagnostic ID XYZ-789");

    const stopResult = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
    expect(stopResult.text).toContain("idle");
  });
});

describe("abap_debug step — round 3: triggerOutcome header discriminator", () => {
  const deadStepResponder = (): RawResponse =>
    okResponse(buildStepXml({ debugSessionId: "SESS1", isSteppingPossible: false, isTerminationPossible: false }));

  it('"ran_to_completion" when the trigger run resolves normally', async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ step: deadStepResponder }));
    const deps = makeDeps({
      log,
      transport,
      listener,
      triggerImpl: async () => ({ text: "OK", truncated: false, estimatedTokens: 2 }),
    });

    const stateId1 = await startSuspended(deps, listener, "D22");
    const stepResult = await abapDebug(
      DUMMY_CONN,
      { action: "step", step: "continue", stateId: stateId1 } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );
    expect(stepResult.text).toContain("triggerOutcome: ran_to_completion");

    await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
  });

  it('"short_dumped" when the trigger rejects with a RUNTIME_DUMP AbapError, not the generic "trigger_failed"', async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ step: deadStepResponder }));
    const deps = makeDeps({
      log,
      transport,
      listener,
      triggerImpl: async () => {
        throw new AbapError("RUNTIME_DUMP", "ZCL_ZMCP_RUN_ZFIXH_ITEM_C short-dumped: Division by zero", {
          class: "CX_SY_ZERODIVIDE",
        });
      },
    });

    const stateId1 = await startSuspended(deps, listener, "D23");
    const stepResult = await abapDebug(
      DUMMY_CONN,
      { action: "step", step: "continue", stateId: stateId1 } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );
    expect(stepResult.text).toContain("triggerOutcome: short_dumped");
    expect(stepResult.text).not.toContain("trigger_failed");
    // Names its own, independent source rather than implying it's debug-protocol evidence.
    expect(stepResult.text).toContain("comes from the trigger run used to reach the breakpoint, not from");

    await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
  });

  it('"trigger_failed" when the trigger rejects with a plain, non-RUNTIME_DUMP error', async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ step: deadStepResponder }));
    const deps = makeDeps({
      log,
      transport,
      listener,
      triggerImpl: async () => {
        throw new Error("classrun failed");
      },
    });

    const stateId1 = await startSuspended(deps, listener, "D24");
    const stepResult = await abapDebug(
      DUMMY_CONN,
      { action: "step", step: "continue", stateId: stateId1 } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );
    expect(stepResult.text).toContain("triggerOutcome: trigger_failed");

    await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
  });

  it(
    '"trigger_not_returned" when the trigger run has not settled within the death-response wait budget',
    async () => {
      const log: string[] = [];
      const listener = new FakeListener(log);
      const transport = new FakeTransport(log, HAPPY_TABLE({ step: deadStepResponder }));
      const deps = makeDeps({ log, transport, listener, triggerImpl: NEVER_SETTLES });

      const stateId1 = await startSuspended(deps, listener, "D25");
      const started = Date.now();
      const stepResult = await abapDebug(
        DUMMY_CONN,
        { action: "step", step: "continue", stateId: stateId1 } as DebugInput,
        60_000,
        deps,
        writableGate(),
      );
      const elapsed = Date.now() - started;
      expect(stepResult.text).toContain("triggerOutcome: trigger_not_returned");
      // Bounded — matches the STOP_WAIT_MS=5000 budget in composeDeathOutput,
      // not the 60s tool-level maxWaitMs.
      expect(elapsed).toBeLessThan(20_000);

      await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// Shared helpers for findings 2/4/5/6 and the internal-table row range tests.
// ---------------------------------------------------------------------------

/**
 * Yields REAL macrotask ticks. `flushMicrotasks` only loops `await Promise.resolve()`,
 * which can never observe an `unhandledRejection` — Node only emits that after the
 * microtask queue has drained and the event loop has turned. Finding 6's tests are
 * vacuous without this.
 */
async function flushMacrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** A trigger run that never settles — the whole point of findings 2, 4 and 5. */
const NEVER_SETTLES = (): Promise<BuiltResponse> => new Promise<BuiltResponse>(() => {});

/** Drives a start to a live "suspended" session and returns its stateId. */
async function startSuspended(deps: DebugToolDeps, listener: FakeListener, debuggeeId: string): Promise<string> {
  const promise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
  await flushMicrotasks();
  listener.resolveWith(okResponse(buildDebuggeeXml(debuggeeId)));
  const result = await promise;
  return extractStateId(result.text)!;
}

/** `attach` blows up — the cheapest way to fail a start AFTER the trigger connection exists. */
const ATTACH_EXPLODES = (): RawResponse => {
  throw new Error("attach exploded on purpose");
};

// ---------------------------------------------------------------------------
// 9. Finding 2 — the trigger connection is released on the START-FAILURE path,
//    even though `triggerSettled` never settles, and exactly once.
// ---------------------------------------------------------------------------

describe("abap_debug start failure — finding 2: trigger connection is always released", () => {
  it(
    "shuts the trigger connection down after a failed start even though the trigger run never settles",
    async () => {
      const log: string[] = [];
      const listener = new FakeListener(log);
      const transport = new FakeTransport(log, HAPPY_TABLE({ attach: ATTACH_EXPLODES }));
      const shutdownSpy = newShutdownSpy();
      const deps = makeDeps({ log, transport, listener, shutdownSpy, triggerImpl: NEVER_SETTLES });

      const promise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
      await flushMicrotasks();
      listener.resolveWith(okResponse(buildDebuggeeXml("D9")));

      await expect(promise).rejects.toThrow();

      // `triggerSettled.finally(closeTriggerConn)` can NEVER have fired here, so a
      // non-zero count can only come from the catch-path closer.
      expect(shutdownSpy.count).toBe(1);
      expect(log).toContain("triggerConn.shutdown");
    },
    20_000,
  );

  it(
    "shuts the trigger connection down EXACTLY once when both the failure path and the settle handler fire",
    async () => {
      const log: string[] = [];
      const listener = new FakeListener(log);
      const transport = new FakeTransport(log, HAPPY_TABLE({ attach: ATTACH_EXPLODES }));
      const shutdownSpy = newShutdownSpy();
      // Default triggerImpl settles immediately => the `.finally(closeTriggerConn)`
      // handler runs too. Idempotence is the only thing keeping the count at 1.
      const deps = makeDeps({ log, transport, listener, shutdownSpy });

      const promise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
      await flushMicrotasks();
      listener.resolveWith(okResponse(buildDebuggeeXml("D10")));

      await expect(promise).rejects.toThrow();
      await flushMacrotasks();

      expect(shutdownSpy.count).toBe(1);
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// 10. Finding 4 — a failed start explains itself with the trigger's outcome.
// ---------------------------------------------------------------------------

describe("abap_debug start failure — finding 4: the trigger outcome is appended to the error", () => {
  it("appends the trigger run's program output to the thrown error's message", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ attach: ATTACH_EXPLODES }));
    const deps = makeDeps({
      log,
      transport,
      listener,
      triggerImpl: async () => ({ text: "TRIGGER SAYS BOOM 12345", truncated: false, estimatedTokens: 5 }),
    });

    const promise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
    await flushMicrotasks();
    listener.resolveWith(okResponse(buildDebuggeeXml("D11")));

    await expect(promise).rejects.toSatisfy((e: unknown) => {
      const msg = (e as Error).message;
      expect(msg).toContain("TRIGGER SAYS BOOM 12345");
      // The original failure must survive too — the append must not replace it.
      expect(msg).toMatch(/attach/i);
      return true;
    });
  }, 20_000);

  it(
    "says the trigger run had NOT returned, within a bounded wait, when it never settles",
    async () => {
      const log: string[] = [];
      const listener = new FakeListener(log);
      const transport = new FakeTransport(log, HAPPY_TABLE({ attach: ATTACH_EXPLODES }));
      const deps = makeDeps({ log, transport, listener, triggerImpl: NEVER_SETTLES });

      const started = Date.now();
      const promise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
      await flushMicrotasks();
      listener.resolveWith(okResponse(buildDebuggeeXml("D12")));

      await expect(promise).rejects.toSatisfy((e: unknown) => {
        expect((e as Error).message).toMatch(/had NOT returned/i);
        return true;
      });

      const elapsed = Date.now() - started;
      // It genuinely WAITED (so the message is not a lucky shortcut) ...
      expect(elapsed).toBeGreaterThanOrEqual(1_500);
      // ... but it was BOUNDED — an unbounded await would hang until the 60 s cap.
      expect(elapsed).toBeLessThan(15_000);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// 11. Finding 5 — stop is bounded and always clears module state.
// ---------------------------------------------------------------------------

describe("abap_debug stop — finding 5: bounded, and state is cleared no matter what", () => {
  it(
    "returns within the bound when the trigger never settles, and clears currentRun so a fresh start succeeds",
    async () => {
      const log: string[] = [];
      const listener = new FakeListener(log);
      const transport = new FakeTransport(log, HAPPY_TABLE());
      const deps = makeDeps({ log, transport, listener, triggerImpl: NEVER_SETTLES });
      await startSuspended(deps, listener, "D13");

      const started = Date.now();
      const stopResult = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
      const elapsed = Date.now() - started;

      expect(stopResult.text).toMatch(/had not returned/i);
      expect(elapsed).toBeLessThan(20_000);

      // PROOF that currentRun / activeSessions were cleared: a brand-new start
      // would be refused with UNSUPPORTED if either were still populated.
      const log2: string[] = [];
      const listener2 = new FakeListener(log2);
      const transport2 = new FakeTransport(log2, HAPPY_TABLE());
      const deps2 = makeDeps({ log: log2, transport: transport2, listener: listener2 });
      const stateId2 = await startSuspended(deps2, listener2, "D14");
      expect(stateId2).toBeTruthy();
    },
    40_000,
  );

  it("still clears state when terminate() itself throws", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(
      log,
      HAPPY_TABLE({
        terminateDebuggee: () => {
          throw new Error("terminate exploded on purpose");
        },
      }),
    );
    const deps = makeDeps({ log, transport, listener });
    await startSuspended(deps, listener, "D15");

    const stopResult = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
    expect(stopResult.text).toMatch(/terminate/i);

    const idleStatus = await abapDebug(DUMMY_CONN, { action: "status" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
    expect(idleStatus.text).toContain("idle");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 12. Finding 6 — a hostile triggerConn.shutdown cannot escape the closer.
// ---------------------------------------------------------------------------

describe("abap_debug — finding 6: triggerConn.shutdown failures are contained and logged", () => {
  it("contains a SYNCHRONOUS throw from triggerConn.shutdown", async () => {
    let unhandled: unknown;
    const onUnhandled = (reason: unknown): void => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const log: string[] = [];
      const depsLog: string[] = [];
      const listener = new FakeListener(log);
      const transport = new FakeTransport(log, HAPPY_TABLE());
      const deps = makeDeps({
        log,
        transport,
        listener,
        depsLog,
        triggerConnShutdownImpl: () => {
          throw new Error("shutdown blew up synchronously");
        },
      });
      await startSuspended(deps, listener, "D16");

      // The operation must still complete normally.
      const stopResult = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
      expect(stopResult.text).toContain("stop");

      await flushMacrotasks();
      expect(unhandled).toBeUndefined();
      expect(depsLog.join("\n")).toContain("shutdown blew up synchronously");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 20_000);

  it("contains a REJECTED promise from triggerConn.shutdown without an unhandled rejection", async () => {
    let unhandled: unknown;
    const onUnhandled = (reason: unknown): void => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const log: string[] = [];
      const depsLog: string[] = [];
      const listener = new FakeListener(log);
      const transport = new FakeTransport(log, HAPPY_TABLE());
      const deps = makeDeps({
        log,
        transport,
        listener,
        depsLog,
        triggerConnShutdownImpl: () => Promise.reject(new Error("shutdown rejected asynchronously")),
      });
      await startSuspended(deps, listener, "D17");

      const stopResult = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
      expect(stopResult.text).toContain("stop");

      // Macrotask ticks are MANDATORY here: Node emits `unhandledRejection` only
      // after the event loop turns, so a microtask-only flush proves nothing.
      await flushMacrotasks();
      expect(unhandled).toBeUndefined();
      expect(depsLog.join("\n")).toContain("shutdown rejected asynchronously");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Internal-table row range handling in abap_debug_value.
// ---------------------------------------------------------------------------

/** `getVariables` responder for a table `name` with `tableLines` rows (or `"omit"` for an unavailable row count); `rowBody` overrides the row batch. */
function tableResponder(
  name: string,
  tableLines: number | "omit",
  rowBody?: (opts: DebugRequestOptions) => RawResponse,
): ResponderEntry {
  return (opts: DebugRequestOptions): RawResponse => {
    if (opts.body?.includes(`${name}[`)) {
      if (rowBody) return rowBody(opts);
      const ids = [...(opts.body.matchAll(/<ID>([^<]+)<\/ID>/g))].map((m) => m[1]!);
      return okResponse(ids.map((id) => ({ id, name: id, metaType: "simple", value: `ROW-${id}` })).length
        ? buildVariablesXml(ids.map((id) => ({ id, name: id, metaType: "simple", value: `ROW-${id}` })))
        : buildVariablesXml([]));
    }
    if (opts.body?.includes(name)) {
      return okResponse(buildVariablesXml([{ id: name, name, metaType: "table", tableLines }]));
    }
    throw new Error(`unexpected getVariables body: ${opts.body}`);
  };
}

describe("abap_debug_value — T5a: out-of-range \"from\" is refused, not silently clamped", () => {
  it("throws BAD_INPUT naming the actual row count instead of returning the last row", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ getVariables: tableResponder("LT_ITEMS", 3) }));
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "D18");

    await expect(abapDebugValue({ stateId, path: "LT_ITEMS", from: 4 }, 60_000)).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e) || e.code !== "BAD_INPUT") return false;
      expect(e.message).toContain("3 row(s)");
      expect(e.message).toContain("4");
      return true;
    });

    // ... and it must NOT have silently fetched row 3 (the old clamp behaviour).
    expect(transport.calls.some((c) => c.body?.includes("LT_ITEMS[3]"))).toBe(false);
  }, 20_000);

  it("still serves from === total (the last valid row) — no off-by-one was introduced", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ getVariables: tableResponder("LT_ITEMS", 3) }));
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "D19");

    const result = await abapDebugValue({ stateId, path: "LT_ITEMS", from: 3, count: 5 }, 60_000);
    expect(result.text).toMatch(/showing 3-3/);
    expect(transport.calls.some((c) => c.body?.includes("LT_ITEMS[3]"))).toBe(true);
  }, 20_000);
});

describe("abap_debug_value — T5b: tableLines: 0 (genuinely empty) and tableLines: undefined (unavailable) render DISTINCTLY", () => {
  it("a genuinely empty table (tableLines: 0) gets a plain empty note and NO row fetch is attempted", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ getVariables: tableResponder("LT_EMPTY", 0) }));
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "D20");

    const result = await abapDebugValue({ stateId, path: "LT_EMPTY" }, 60_000);
    expect(result.text).toMatch(/LT_EMPTY is empty: 0 rows\./);
    expect(result.text).not.toMatch(/unavailable/i);
    // No row window was requested — an empty table has nothing to fetch.
    expect(transport.calls.some((c) => c.body?.includes("LT_EMPTY[1]"))).toBe(false);
  }, 20_000);

  it("an unavailable row count (tableLines: undefined) gets the unavailable note, never claims emptiness, and STILL attempts the row fetch", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ getVariables: tableResponder("LT_UNKNOWN", "omit") }));
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "D20b");

    const result = await abapDebugValue({ stateId, path: "LT_UNKNOWN" }, 60_000);
    expect(result.text).toMatch(/Row count is unavailable/);
    expect(result.text).toMatch(/NOT the same as an empty table/);
    expect(result.text).toContain('LT_UNKNOWN[1]');
    expect(result.text).not.toMatch(/is empty: 0 rows/);
    // Unlike the genuine-zero case, an unknown count must never silently
    // render as empty — the requested (unclamped) window is still fetched.
    expect(transport.calls.some((c) => c.body?.includes("LT_UNKNOWN[1]"))).toBe(true);
    expect(transport.calls.some((c) => c.body?.includes("LT_UNKNOWN[20]"))).toBe(true);
  }, 20_000);
});

describe("abap_debug_value — T5c: a 0-byte row-fetch body hits the empty-body trap", () => {
  it("renders the empty-body trap instead of crashing with a raw parse error", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(
      log,
      HAPPY_TABLE({ getVariables: tableResponder("LT_ITEMS", 3, () => okResponse("")) }),
    );
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "D21");

    const result = await abapDebugValue({ stateId, path: "LT_ITEMS" }, 60_000);
    expect(result.text).toContain("0 bytes");
    expect(result.text).toContain("TABLE_LINES=3");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 16. GAP 1 — CLEANUP ON EVERY `start` FAILURE POINT.
//
// Asserting `rejects.toThrow()` proves only that something failed; it says
// NOTHING about whether the half-built session was torn down. A start that
// throws while leaving the listener registered and the breakpoints armed
// strands a real SAP work process. So every case below asserts the OBSERVABLE
// cleanup traffic instead: `session.cleanup()` (=> `terminate()`) always issues
//   - a `stopListener` (DELETE .../debugger/listeners), and
//   - a breakpoint DELETE **scoped to what this session actually armed**
//     (`deleteOwnedBreakpoints()`, a POST that `classify()` reports as
//     "setBreakpoints:real"). A failure BEFORE the real arm therefore produces
//     no such POST at all: the unscoped `syncScope {mode:"full"}` clear that
//     used to fire unconditionally deleted every external breakpoint the SAP
//     user owned, human-set Eclipse breakpoints included, so its absence on
//     cases 1-3 is the fix, not a missing teardown,
// plus `terminateDebuggee` when the session already reached "caught"/"suspended".
// `terminate()` also aborts the outstanding long-poll LOCALLY
// (`listener.abortCount` — client-side only, no request, so no round-trip is
// added), which is why every case that got as far as owning a listen handle
// shows exactly one abort; `waitForDebuggee()` releases the listener itself on a
// timeout/conflict — hence the per-case counts.
// ---------------------------------------------------------------------------

const countOf = (log: string[], tag: string): number => log.filter((l) => l === tag).length;

/** Exception envelope shape `parseListenResult` classifies as `kind:"conflict"`. */
const CONFLICT_XML = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceConflict"/>
  <message lang="EN">A debugger listener is already registered</message>
  <localizedMessage lang="EN">A debugger listener is already registered</message>
  <properties>
    <entry key="conflictText">OTHERUSER is already listening</entry>
    <entry key="ideUser">OTHERUSER</entry>
  </properties>
</exc:exception>`;

interface StartFailurePoint {
  name: string;
  /** Responder-table overrides layered on HAPPY_TABLE. */
  table?: Partial<ResponderTable>;
  /** Replace individual `DebugToolDeps` members (resolveObject / createTriggerConnection / triggerRun). */
  depsOverride?: (base: DebugToolDeps) => DebugToolDeps;
  /** Fake-listener behaviour — used by the armListener failure point. */
  listenerOpts?: FakeListenerOpts;
  /** Settle the long poll, for the failure points that occur at or after `waitForDebuggee()`. */
  drive?: (listener: FakeListener) => void;
  /** Substring the thrown error must contain — proves the intended failure point was hit, not a neighbouring one. */
  errorContains: RegExp;
  expected: {
    /** DELETE .../listeners calls (cleanup always issues one; some paths issue an earlier one too). */
    stopListener: number;
    /** POST .../breakpoints WITHOUT validationOnly — prepareBreakpoints' real arm (if it got that far) plus cleanup's clear. */
    setBreakpointsReal: number;
    terminateDebuggee: number;
    /** `handle.abort()` — only `armListener()`'s failed-confirmation path does this. */
    listenerAborts: number;
  };
}

const NO_SOURCE_URI_RESOLVED = (ref: string): ResolvedObject => ({
  system: "A4H",
  type: "PROG/P",
  kind: "PROG",
  label: ref,
  name: ref.toUpperCase(),
  uri: "",
  sourceUri: undefined,
  packageName: "$TMP",
  mode: "source",
  spec: specForType("PROG/P")!,
});

const START_FAILURE_POINTS: StartFailurePoint[] = [
  {
    name: "1. breakpoint resolution — resolveObject throws",
    depsOverride: (base) => ({
      ...base,
      resolveObject: async () => {
        throw new AbapError("NOT_FOUND", "ZTEST_MCP_CRUD could not be resolved", {});
      },
    }),
    errorContains: /could not be resolved/i,
    // NOTHING was armed, so `deleteOwnedBreakpoints()` has nothing to delete and
    // issues no POST at all (see the section header) — 0, not 1.
    expected: { stopListener: 1, setBreakpointsReal: 0, terminateDebuggee: 0, listenerAborts: 0 },
  },
  {
    name: "2. breakpoint resolution — the resolved object has no source URI",
    depsOverride: (base) => ({
      ...base,
      resolveObject: async (_conn, ref) => NO_SOURCE_URI_RESOLVED(ref),
    }),
    errorContains: /no source URI/i,
    expected: { stopListener: 1, setBreakpointsReal: 0, terminateDebuggee: 0, listenerAborts: 0 },
  },
  {
    // `resolveObject` has no `TYPES`
    // entry for `adtcore:type="BOBF"` (a BOPF business object has no source
    // at all), so the ONLY signal debug.ts ever sees is the generic
    // `UNSUPPORTED` "type is not readable" resolveObject throws for any
    // unrecognised type — see `src/adt/resolve.ts`'s `usable.length === 0`
    // branch, `details: { name, types }`. This case reproduces exactly that
    // shape and asserts the tool replaces it with the targeted BOPF message
    // instead of letting the generic one through.
    name: "1b. breakpoint resolution — resolveObject throws the generic 'type not readable' shape for a BOBF object",
    depsOverride: (base) => ({
      ...base,
      // `bp.object` in START_INPUT is "ZTEST_MCP_CRUD" — the fake just needs
      // to reproduce resolveObject's generic UNSUPPORTED/BOBF shape; the tool
      // rebuilds its message from `bp.object`, not from the thrown error's name.
      resolveObject: async () => {
        throw new AbapError(
          "UNSUPPORTED",
          "ZTEST_MCP_CRUD exists but its type (BOBF) is not a readable source object.",
          { name: "ZTEST_MCP_CRUD", types: ["BOBF"] },
        );
      },
    }),
    errorContains: /ZTEST_MCP_CRUD is a BOPF business object, which has no source\. Set the breakpoint in its implementation class instead\./,
    expected: { stopListener: 1, setBreakpointsReal: 0, terminateDebuggee: 0, listenerAborts: 0 },
  },
  {
    name: "3. prepareBreakpoints — the validation call fails",
    table: {
      "setBreakpoints:validate": () => {
        throw new Error("breakpoint validation exploded on purpose");
      },
    },
    errorContains: /validation exploded/i,
    // The validation arm ran and failed; the REAL arm never did, so again there
    // is no armed breakpoint to delete.
    expected: { stopListener: 1, setBreakpointsReal: 0, terminateDebuggee: 0, listenerAborts: 0 },
  },
  {
    // NOTE: the "registration is never CONFIRMED" variant of this failure point
    // no longer exists — `armListener()`'s `getListener` confirmation loop was
    // deleted (it polled on the same SAP session as the outstanding listener
    // and was head-of-line blocked behind it for the remainder of its timeout,
    // never getting the confirmation it needed). A failing `launchListener` is
    // the only reachable armListener failure now, so that is what this case
    // exercises.
    name: "4. armListener — launching the listener fails",
    listenerOpts: { throwOnListen: new Error("listener launch refused by the server") },
    errorContains: /listener launch refused/i,
    // No handle was ever produced, so there is nothing to abort; cleanup still
    // has to release the listener server-side and clear the armed breakpoints.
    expected: { stopListener: 1, setBreakpointsReal: 2, terminateDebuggee: 0, listenerAborts: 0 },
  },
  {
    name: "5. createTriggerConnection — the second connection cannot be opened",
    depsOverride: (base) => ({
      ...base,
      createTriggerConnection: async () => {
        throw new AbapError("ADT_ERROR", "second connection refused by the server", {});
      },
    }),
    errorContains: /second connection refused/i,
    // A listen handle EXISTS from here on, and `terminate()` now aborts the
    // outstanding long-poll locally (client-side only, no request) before the
    // network teardown — hence exactly one abort on every case below.
    expected: { stopListener: 1, setBreakpointsReal: 2, terminateDebuggee: 0, listenerAborts: 1 },
  },
  {
    name: "6. triggerRun — throws synchronously instead of returning a promise",
    depsOverride: (base) => ({
      ...base,
      triggerRun: () => {
        throw new Error("trigger blew up synchronously");
      },
    }),
    errorContains: /blew up synchronously/i,
    expected: { stopListener: 1, setBreakpointsReal: 2, terminateDebuggee: 0, listenerAborts: 1 },
  },
  {
    name: "7. waitForDebuggee — the long poll times out with no debuggee",
    drive: (listener) => listener.resolveWith(okResponse("")),
    errorContains: /timed out waiting for the debuggee/i,
    // waitForDebuggee releases the listener on a non-debuggee outcome, then cleanup does too.
    // The local abort is idempotent (`abortListener()` returns early once the
    // handle is aborted), so waitForDebuggee's abort + terminate's abort = 1.
    expected: { stopListener: 2, setBreakpointsReal: 2, terminateDebuggee: 0, listenerAborts: 1 },
  },
  {
    name: "8. waitForDebuggee — another listener already holds the session (conflict)",
    drive: (listener) => listener.resolveWith(okResponse(CONFLICT_XML)),
    errorContains: /another listener already holds this session/i,
    expected: { stopListener: 2, setBreakpointsReal: 2, terminateDebuggee: 0, listenerAborts: 1 },
  },
  {
    name: "9. attach — the attach call itself explodes",
    table: { attach: ATTACH_EXPLODES },
    drive: (listener) => listener.resolveWith(okResponse(buildDebuggeeXml("DF9"))),
    errorContains: /attach exploded/i,
    // Status is "caught" by now, so cleanup must ALSO terminate the debuggee —
    // skipping that leaves a suspended work process pinned server-side.
    expected: { stopListener: 1, setBreakpointsReal: 2, terminateDebuggee: 1, listenerAborts: 1 },
  },
];

describe("abap_debug start — GAP 1: every failure point actually cleans the session up", () => {
  it.each(START_FAILURE_POINTS.map((fp) => [fp.name, fp] as const))(
    "%s",
    async (_name, fp) => {
      const log: string[] = [];
      const listener = new FakeListener(log, fp.listenerOpts);
      const transport = new FakeTransport(log, HAPPY_TABLE(fp.table ?? {}));
      const base = makeDeps({ log, transport, listener });
      const deps = fp.depsOverride ? fp.depsOverride(base) : base;

      const promise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
      await flushMicrotasks();
      fp.drive?.(listener);

      // Not the assertion — just the funnel. Everything below is the assertion.
      await expect(promise).rejects.toSatisfy((e: unknown) => {
        expect((e as Error).message).toMatch(fp.errorContains);
        return true;
      });

      expect(countOf(log, "stopListener")).toBe(fp.expected.stopListener);
      expect(countOf(log, "setBreakpoints:real")).toBe(fp.expected.setBreakpointsReal);
      expect(countOf(log, "terminateDebuggee")).toBe(fp.expected.terminateDebuggee);
      expect(listener.abortCount).toBe(fp.expected.listenerAborts);

      // The registry must be clean: a failed start that leaves its session in
      // `activeSessions` makes the NEXT start fail with UNSUPPORTED. Proven by
      // actually starting a fresh session rather than by inspecting internals.
      const log2: string[] = [];
      const listener2 = new FakeListener(log2);
      const transport2 = new FakeTransport(log2, HAPPY_TABLE());
      const deps2 = makeDeps({ log: log2, transport: transport2, listener: listener2 });
      expect(await startSuspended(deps2, listener2, "DFOK")).toBeTruthy();
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// Two-sources-of-truth defect fix: `handleStart`'s one-session-per-process
// guard refuses based on `listActiveDebugSessions()` (`activeSessions`, a
// module-level Set in src/debug/session.ts, populated at `DebugSession`
// CONSTRUCTION and cleared only when a session reaches "dead"), while
// `handleStop`/`handleStatus` used to dispatch on `currentRun` alone (a
// SEPARATE module-level binding in src/tools/debug.ts, assigned only on a
// FULLY successful `start` — see its assignment at the very end of
// `handleStart`, deliberately outside the try/catch). A `start` that
// constructs a `DebugSession` and then fails before reaching that assignment
// leaves the session registered in `activeSessions` with no `currentRun`:
// every subsequent `start` was refused forever ("one session per process"),
// while `stop`/`status` reported "nothing to stop" / "idle" — a permanent,
// process-lifetime deadlock with no working recovery action, live-observed
// (12 consecutive refused starts).
//
// These tests construct that exact invariant-violating state directly
// (`deps.createSession(...)`, bypassing `handleStart` the same way a start
// that fails AFTER construction but BEFORE the `currentRun` assignment
// would) rather than trying to force a specific timing race through
// `DebugSession`'s internals — every documented failure mode ("cleanup
// exceeds 5s", "cleanup throws", "cleanup never reaches doTerminate's
// finally") manifests as exactly this one observable state: a session
// present in `activeSessions` with no matching `currentRun`. Testing at that
// level is what makes these tests independent of the exact live timing
// mechanism, per the fix's own invariant: "for every state `start` refuses
// on, `stop` must be able to reach and clear it."
// ---------------------------------------------------------------------------

describe("abap_debug — leaked session recovery (two-sources-of-truth invariant)", () => {
  // Belt-and-braces local teardown, on top of the file's global `afterEach`
  // (which only knows about `currentRun`, not about sessions planted directly
  // via `plantLeakedSession`): if an assertion in one of these tests throws
  // before that test's own explicit cleanup runs, a leaked `DebugSession` —
  // possibly one whose `terminate()` was mocked to hang forever (see the
  // `force:true` test below) — would otherwise survive in the module-level
  // `activeSessions` registry and contaminate every later test in this file.
  // `vi.restoreAllMocks()` first undoes any such mock so the real `terminate()`
  // runs; `forceDropDebugSession` is the unconditional fallback so a stuck
  // mock or a genuinely slow terminate() can never block this from finishing.
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const session of listActiveDebugSessions()) {
      try {
        await session.terminate("terminated_by_caller");
      } catch {
        // best effort — force-drop below guarantees the registry is clean
        // for the next test regardless.
      }
      forceDropDebugSession(session);
    }
  });

  /** Plants a `DebugSession` directly into `activeSessions` with no matching `currentRun` — the exact state a start that fails after construction but before full success leaves behind. */
  function plantLeakedSession(): DebugSession {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const deps = makeDeps({ log, transport, listener });
    return deps.createSession(DUMMY_CONN, writableGate(), {});
  }

  it("start refuses on a leaked session, naming it as untracked rather than as a normal live session", async () => {
    const leaked = plantLeakedSession();
    expect(listActiveDebugSessions()).toContain(leaked);

    await expect(abapDebug(DUMMY_CONN, START_INPUT, 60_000, UNUSED_DEPS, writableGate())).rejects.toSatisfy(
      (e: unknown) => {
        expect(isAbapError(e)).toBe(true);
        expect((e as AbapError).code).toBe("UNSUPPORTED");
        // Requirement: a prescribed recovery action must actually work from
        // the state being reported. The message must name `stop` (which, per
        // the tests below, DOES clear this state) — not silently pretend this
        // is an ordinary live session.
        expect((e as Error).message).toMatch(/stop/i);
        // transient occupancy, not an unimplemented capability — a stop clears it
        expect((e as AbapError).retryable).toBe(true);
        return true;
      },
    );

    // Clean up directly (this test is about the guard's message, not recovery).
    await leaked.terminate("terminated_by_caller");
  });

  it("status reports the real state of a leaked session instead of \"idle\"", async () => {
    const leaked = plantLeakedSession();
    try {
      const result = await abapDebug(DUMMY_CONN, { action: "status" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
      expect(result.text).not.toMatch(/no active debug session/i);
      expect(result.text).toMatch(new RegExp(leaked.snapshot.status, "i"));
    } finally {
      await leaked.terminate("terminated_by_caller");
    }
  });

  it("stop clears a leaked session (reports having cleared something, not \"nothing to stop\"), and unblocks the next start", async () => {
    const leaked = plantLeakedSession();
    expect(listActiveDebugSessions()).toContain(leaked);

    // The guard refuses — this is the observable defect symptom.
    await expect(abapDebug(DUMMY_CONN, START_INPUT, 60_000, UNUSED_DEPS, writableGate())).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && (e as AbapError).code === "UNSUPPORTED",
    );

    // stop must be a TOTAL recovery operation: it must reach and clear
    // whatever the guard above refused on, and say so (not "nothing to stop").
    const stopResult = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
    expect(stopResult.text).not.toMatch(/nothing to stop/i);
    expect(listActiveDebugSessions()).not.toContain(leaked);
    expect(listActiveDebugSessions()).toHaveLength(0);

    // And a subsequent start must be ACCEPTED — no permanent deadlock.
    const log2: string[] = [];
    const listener2 = new FakeListener(log2);
    const transport2 = new FakeTransport(log2, HAPPY_TABLE());
    const deps2 = makeDeps({ log: log2, transport: transport2, listener: listener2 });
    expect(await startSuspended(deps2, listener2, "LEAK1")).toBeTruthy();
  });

  it("stop({force:true}) force-drops a leaked session whose terminate() never returns, unblocking the next start", async () => {
    const leaked = plantLeakedSession();
    // Simulate the one failure mode a bounded `stop` alone cannot recover
    // from: `terminate()` never reaches `doTerminate`'s `finally` at all (the
    // scenario `forceDropDebugSession`'s doc comment names — only ever
    // expected if a future change breaks the deadline-ordering invariant
    // documented next to `TERMINATE_TOTAL_DEADLINE_MS` in session.ts).
    vi.spyOn(leaked, "terminate").mockReturnValue(new Promise<void>(() => {}));

    await expect(abapDebug(DUMMY_CONN, START_INPUT, 60_000, UNUSED_DEPS, writableGate())).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && (e as AbapError).code === "UNSUPPORTED",
    );

    // A plain stop cannot make the stuck terminate() resolve — it reports
    // that honestly and leaves the session tracked (same contract as every
    // other bounded wait in this file).
    const plainStop = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
    expect(plainStop.text).toMatch(/had not finished terminate/i);
    expect(listActiveDebugSessions()).toContain(leaked);

    // force:true is the named escape hatch, and it must actually work.
    const forcedStop = await abapDebug(
      DUMMY_CONN,
      { action: "stop", force: true } as DebugInput,
      60_000,
      UNUSED_DEPS,
      writableGate(),
    );
    expect(forcedStop.text).toMatch(/force-dropped/i);
    expect(listActiveDebugSessions()).not.toContain(leaked);
    expect(listActiveDebugSessions()).toHaveLength(0);

    const log2: string[] = [];
    const listener2 = new FakeListener(log2);
    const transport2 = new FakeTransport(log2, HAPPY_TABLE());
    const deps2 = makeDeps({ log: log2, transport: transport2, listener: listener2 });
    expect(await startSuspended(deps2, listener2, "LEAK2")).toBeTruthy();
  }, 20_000);

  it("shutdownAllDebugSessions still reaches a leaked (currentRun-less) session", async () => {
    const leaked = plantLeakedSession();
    expect(listActiveDebugSessions()).toContain(leaked);
    await shutdownAllDebugSessions();
    expect(leaked.snapshot.status).toBe("dead");
    expect(listActiveDebugSessions()).not.toContain(leaked);
  });

  it("invariant: for every case in START_FAILURE_POINTS, if the failed start's own cleanup somehow left the session behind, stop still reaches it (property-style over the shared failure-point table)", async () => {
    for (const fp of START_FAILURE_POINTS) {
      const log: string[] = [];
      const listener = new FakeListener(log, fp.listenerOpts);
      const transport = new FakeTransport(log, HAPPY_TABLE(fp.table ?? {}));
      const base = makeDeps({ log, transport, listener });
      const deps = fp.depsOverride ? fp.depsOverride(base) : base;

      const promise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
      await flushMicrotasks();
      fp.drive?.(listener);
      await expect(promise).rejects.toBeTruthy();

      // Whether or not this failure point's own cleanup already cleared the
      // registry (GAP 1 above proves most do), the invariant this fix adds is
      // strictly stronger than "this particular failure point happens to
      // clean up in time": ANYTHING left in `listActiveDebugSessions()` after
      // a failed start — for ANY reason, present or future — must still be
      // reachable and clearable by `stop`.
      const stopResult = await abapDebug(
        DUMMY_CONN,
        { action: "stop" } as DebugInput,
        60_000,
        UNUSED_DEPS,
        writableGate(),
      );
      expect(listActiveDebugSessions()).toHaveLength(0);
      void stopResult;
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// abap_debug refuses ENHO/XH, ENHO/XHH, ENHS/XS debug targets, naming
// the implementing class (or base object / BAdI definitions) to debug
// instead of a generic "unsupported type" failure. abap_debug cannot itself
// attach a breakpoint to BAdI dispatch.
//
// Fixtures are the SAME live-captured XML `test/enhancement-xml.test.ts`
// decodes (`test/fixtures/enhancement/`) — never a hand-authored stand-in —
// so a real implementing-class / enhanced-object / BAdI-definition name
// actually flows through `readBadiImplementation`/`readSourceCodePlugin`/
// `readEnhancementSpot` into the refusal message.
// ---------------------------------------------------------------------------

const ENH_FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement");
const readEnhFixture = (name: string): string => readFileSync(join(ENH_FIXTURES_DIR, name), "utf8");

/** A `ResolvedObject` shaped like `resolveObject` would return for the given enhancement type. */
function enhancementResolved(type: "ENHO/XH" | "ENHO/XHH" | "ENHS/XS", name: string): ResolvedObject {
  const spec = specForType(type)!;
  const basePath = spec.path.replace("{name}", name.toLowerCase());
  return {
    system: "A4H",
    type,
    kind: spec.kind,
    label: name,
    name,
    uri: basePath,
    sourceUri: spec.supportsSource ? `${basePath}/source/main` : undefined,
    packageName: "$TMP",
    mode: spec.mode,
    activation: "unknown",
    spec,
  };
}

/** `readBadiImplementation`/`readSourceCodePlugin`/`readEnhancementSpot` now open
 *  with `conn.discovery.assertSupported("enhancements", ...)`. These fakes are unrelated to
 *  discovery gating — they exist to test the ENHO/ENHS debug refusal message — so `discovery`
 *  here is a permissive no-op stub, matching a system (like A4H) that supports enhancements. */
const PERMISSIVE_DISCOVERY = { assertSupported: () => undefined } as unknown as AbapConnection["discovery"];

/** A minimal fake `AbapConnection` whose `.get()` always answers with `xml` — enough for
 *  `readBadiImplementation`/`readSourceCodePlugin`/`readEnhancementSpot` to decode. */
function fakeConnServing(xml: string): AbapConnection {
  return {
    get: async () => ({ status: 200, headers: {}, body: xml }),
    discovery: PERMISSIVE_DISCOVERY,
  } as unknown as AbapConnection;
}

/** A fake `AbapConnection` whose `.get()` always throws — exercises the best-effort fallback
 *  when the enrichment read itself fails. */
function fakeConnThatFailsToRead(): AbapConnection {
  return {
    get: async () => {
      throw new Error("simulated enrichment read failure");
    },
    discovery: PERMISSIVE_DISCOVERY,
  } as unknown as AbapConnection;
}

function enhStartInput(object: string, line = 1): DebugInput {
  return {
    action: "start",
    breakpoints: [{ kind: "line", object, line }],
    run: { object: "ZTEST_MCP_CRUD", mode: "report" },
  } as DebugInput;
}

describe("abap_debug refuses ENHO/ENHS debug targets, naming the implementing class instead", () => {
  it("ENHO/XH (BAdI implementation) — names the implementing class from readBadiImplementation", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const base = makeDeps({ log, transport, listener });
    const deps: DebugToolDeps = {
      ...base,
      resolveObject: async () => enhancementResolved("ENHO/XH", "ZMCP_ENH_BADI"),
    };
    const conn = fakeConnServing(readEnhFixture("354-enhoxh-no-filter.xml"));

    await expect(abapDebug(conn, enhStartInput("ZMCP_ENH_BADI", 10), 60_000, deps, writableGate())).rejects.toSatisfy(
      (e: unknown) => {
        expect(isAbapError(e)).toBe(true);
        expect((e as Error).message).toMatch(/ZMCP_ENH_BADI is BAdI implementation \(ENHO\/XH\)/);
        expect((e as Error).message).toMatch(
          /Set the breakpoint in its implementing class instead: ZCL_MCP_BADI_IMPL\./,
        );
        return true;
      },
    );
    // Nothing was armed: the refusal fires before prepareBreakpoints.
    expect(countOf(log, "setBreakpoints:real")).toBe(0);
  });

  it("ENHO/XHH (source-code enhancement plug-in) — names the enhanced object from readSourceCodePlugin, even though its TypeSpec supports source", async () => {
    // Regression guard for the exact trap the src/tools/debug.ts header comment
    // calls out: the ENHO/XHH row has supportsSource:true, so without the
    // explicit check the loop would fall through to baseUri and silently
    // attach a REAL (misleading) breakpoint to the plug-in's own tiny
    // enhancement include, instead of refusing.
    const resolved = enhancementResolved("ENHO/XHH", "SEU_TEST_CLS_ENH_IMPL_TEMPLATE");
    expect(resolved.sourceUri).toBeDefined();

    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const base = makeDeps({ log, transport, listener });
    const deps: DebugToolDeps = { ...base, resolveObject: async () => resolved };
    const conn = fakeConnServing(readEnhFixture("019-enhoxhh-class-hook.xml"));

    await expect(
      abapDebug(conn, enhStartInput("SEU_TEST_CLS_ENH_IMPL_TEMPLATE", 4), 60_000, deps, writableGate()),
    ).rejects.toSatisfy((e: unknown) => {
      expect(isAbapError(e)).toBe(true);
      expect((e as Error).message).toMatch(/is Enhancement source plug-in \(ENHO\/XHH\)/);
      expect((e as Error).message).toMatch(
        /Set the breakpoint in the object it enhances instead: CL_SPOT_ENH_TEMPLATE_001\./,
      );
      return true;
    });
    expect(countOf(log, "setBreakpoints:real")).toBe(0);
  });

  it("ENHS/XS (enhancement spot) — names its BAdI definitions from readEnhancementSpot", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const base = makeDeps({ log, transport, listener });
    const deps: DebugToolDeps = {
      ...base,
      resolveObject: async () => enhancementResolved("ENHS/XS", "ZMCP_SPOT"),
    };
    const conn = fakeConnServing(readEnhFixture("343-enhsxs-no-filters.xml"));

    await expect(abapDebug(conn, enhStartInput("ZMCP_SPOT"), 60_000, deps, writableGate())).rejects.toSatisfy((e: unknown) => {
      expect(isAbapError(e)).toBe(true);
      expect((e as Error).message).toMatch(/is Enhancement spot \(ENHS\/XS\)/);
      expect((e as Error).message).toMatch(
        /Set the breakpoint in an implementation of one of its BAdI definitions instead: ZMCP_BADI_D1\./,
      );
      return true;
    });
    expect(countOf(log, "setBreakpoints:real")).toBe(0);
  });

  it("graceful fallback — the enrichment read itself fails, but the refusal still fires with generic advice", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const base = makeDeps({ log, transport, listener });
    const deps: DebugToolDeps = {
      ...base,
      resolveObject: async () => enhancementResolved("ENHO/XH", "ZMCP_ENH_BADI"),
    };
    const conn = fakeConnThatFailsToRead();

    await expect(abapDebug(conn, enhStartInput("ZMCP_ENH_BADI", 10), 60_000, deps, writableGate())).rejects.toSatisfy(
      (e: unknown) => {
        expect(isAbapError(e)).toBe(true);
        expect((e as Error).message).toMatch(/is BAdI implementation \(ENHO\/XH\)/);
        expect((e as Error).message).toMatch(
          /read this BAdI implementation with abap_read to find the class name\./,
        );
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 17. GAP 2 — the trigger's rejection must not escape, INCLUDING when the start
//     itself is failing at the same time (the failure path and the rejection
//     racing each other is the combination nothing covered).
// ---------------------------------------------------------------------------

/** Registers an `unhandledRejection` probe and always deregisters it. */
async function withUnhandledRejectionProbe(body: (read: () => unknown) => Promise<void>): Promise<void> {
  let unhandled: unknown;
  const onUnhandled = (reason: unknown): void => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await body(() => unhandled);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

describe("abap_debug start — GAP 2: a rejecting trigger racing a FAILING start", () => {
  it(
    "attach blows up while the trigger run is rejecting — the error is reported and nothing escapes unhandled",
    async () => {
      await withUnhandledRejectionProbe(async (unhandled) => {
        const log: string[] = [];
        const listener = new FakeListener(log);
        const transport = new FakeTransport(log, HAPPY_TABLE({ attach: ATTACH_EXPLODES }));
        const shutdownSpy = newShutdownSpy();
        const deps = makeDeps({
          log,
          transport,
          listener,
          shutdownSpy,
          triggerImpl: async () => {
            throw new Error("trigger rejected while the start was already failing");
          },
        });

        const promise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
        await flushMicrotasks();
        listener.resolveWith(okResponse(buildDebuggeeXml("DG2")));

        await expect(promise).rejects.toSatisfy((e: unknown) => {
          const msg = (e as Error).message;
          // BOTH causes survive: the attach failure AND the trigger's own failure.
          expect(msg).toMatch(/attach exploded/i);
          expect(msg).toMatch(/trigger rejected while the start was already failing/i);
          return true;
        });

        // Real event-loop turns — the only way an unhandled rejection is observable.
        await flushMacrotasks();
        expect(unhandled()).toBeUndefined();
        // The failure path still released the second connection (GAP 3, failure side).
        expect(shutdownSpy.count).toBe(1);
      });
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// 18. GAP 3 — `triggerConn.shutdown` on the HAPPY path (start -> stop) was
//     logged but never asserted: exactly once, with the expected reason.
// ---------------------------------------------------------------------------

describe("abap_debug — GAP 3: the trigger connection is released exactly once on the happy path", () => {
  it("start then stop shuts the trigger connection down once, with reason \"debug-trigger-done\"", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const shutdownSpy = newShutdownSpy();
    const deps = makeDeps({ log, transport, listener, shutdownSpy });

    await startSuspended(deps, listener, "DG3");
    // The default trigger settles immediately, so the happy-path
    // `.finally(closeTriggerConn)` has already fired by now.
    await flushMacrotasks();
    expect(shutdownSpy.count).toBe(1);
    expect(shutdownSpy.reasons[0]).toBe("debug-trigger-done");

    await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
    await flushMacrotasks();
    // `handleStop`'s finally calls the closer again — idempotence keeps it at one.
    expect(shutdownSpy.count).toBe(1);
    expect(countOf(log, "triggerConn.shutdown")).toBe(1);
  }, 20_000);

  it("a trigger that never settles is still released exactly once, by stop", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const shutdownSpy = newShutdownSpy();
    const deps = makeDeps({ log, transport, listener, shutdownSpy, triggerImpl: NEVER_SETTLES });

    await startSuspended(deps, listener, "DG4");
    await flushMacrotasks();
    // Nothing has settled, so the happy-path release cannot have run yet.
    expect(shutdownSpy.count).toBe(0);

    await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
    expect(shutdownSpy.count).toBe(1);
    expect(shutdownSpy.reasons[0]).toBe("debug-trigger-done");
    // Measured ~5.0s (real STOP_WAIT_MS wait, unlike siblings' mocked timers); hang guard, not a signal.
  }, 120_000);
});

describe("abap_debug — the trigger connection is disposed after its shutdown settles (finding: leaked process listeners)", () => {
  it("start then stop calls triggerConn.dispose() exactly once, after shutdown", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const disposeSpy = vi.fn();
    const deps = makeDeps({ log, transport, listener, disposeSpy });

    await startSuspended(deps, listener, "DG5");
    await flushMacrotasks();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(log.indexOf("triggerConn.shutdown")).toBeLessThan(log.indexOf("triggerConn.dispose"));

    await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
    await flushMacrotasks();
    // Idempotent closer — stop's finally does not dispose a second time.
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 19. GAP 4 — the ordering test that matters: the trigger fires only AFTER
//     `armListener()` has RESOLVED.
//
// The pre-existing choreography test (test 1 above) keyed on the first
// registration poll (`idx("getListener") < idx("createTriggerConnection")`).
// That poll NO LONGER EXISTS: `armListener()`'s confirmation loop was deleted
// because a second request on the SAME ADT stateful session is head-of-line
// blocked behind an outstanding long-poll for the remainder of its timeout
// (the listener itself was never killed by the loop; it just never got a
// timely confirmation, and
// `parseListenResult` mapped the eventual 0-byte body to `{kind:"timeout"}`
// either way, so the multi-minute stall it caused was silent). Arming now
// completes when the listen POST is dispatched, so the ordering is re-keyed
// onto arming COMPLETING (`listener:armed`) rather than onto any poll.
// `manualArm` holds `armed` pending, which is what separates "fired after
// arming" from "fired after merely dispatching". Verified by defect
// injection — calling `armListener()` without awaiting it leaves test 1
// green and turns this red.
// ---------------------------------------------------------------------------

describe("abap_debug start — GAP 4: the trigger fires only after armListener() has RESOLVED", () => {
  it("touches nothing on the trigger side while the listener is still arming", async () => {
    const log: string[] = [];
    // `armed` stays pending until this test says otherwise — that is the whole
    // instrument. With the default fake it resolves immediately, which is why
    // the old ordering assertion could not tell the two orderings apart.
    const listener = new FakeListener(log, { manualArm: true });
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const deps = makeDeps({ log, transport, listener });

    const promise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
    // Real event-loop turns, so "it just hasn't got there yet" is excluded.
    await flushMacrotasks();

    // The listener POST is dispatched but arming has NOT completed ...
    expect(log).toContain("listener:launch");
    expect(log).not.toContain("listener:armed");
    // ... and THIS is the assertion the old test could not make: the second
    // connection must not even be OPENED, let alone used, until arming is done.
    // Firing the trigger here is the intermittent, live-only race the whole
    // two-connection choreography exists to prevent.
    expect(log).not.toContain("createTriggerConnection");
    expect(log).not.toContain("triggerRun:fired");

    listener.releaseArmed();
    await flushMacrotasks();
    expect(log).toContain("triggerRun:fired");

    listener.resolveWith(okResponse(buildDebuggeeXml("DG5")));
    await promise;

    // Re-keyed ordering: keyed on arming COMPLETING, not on the POST going out.
    expect(log.indexOf("listener:armed")).toBeLessThan(log.indexOf("createTriggerConnection"));
    expect(log.indexOf("createTriggerConnection")).toBeLessThan(log.indexOf("triggerRun:fired"));
    expect(log.indexOf("triggerRun:fired")).toBeLessThan(log.indexOf("attach"));
  }, 20_000);

  // REGRESSION GUARD. Arming must never probe the listener it just armed.
  // A confirmation GET travels on the SAME ADT stateful session as the
  // outstanding long-poll and is head-of-line blocked behind it: a live A4H
  // re-capture on 2026-08-02 found the
  // confirm-GET blocked for 55 402 ms — the whole remaining timeout of the
  // listener it was confirming — while that listener itself survived,
  // untouched, to its own natural timeout with HTTP 200 and a 0-byte body.
  // The original (2026-07-31) capture that this test used to cite a ~6.9 s
  // "death" for was a misread of that same stall, not a real early kill. The
  // 0-byte body parses as `{kind:"timeout"}` either way, so a confirmation
  // loop here silently turns every arm into a minutes-long hang instead of
  // the fast dispatch-and-return this test pins down. That is the single
  // defect that kept this feature from ever working, so restoring the poll
  // must break the build here.
  // Mirrors "armListener() must not probe the listener it just armed" in
  // test/debug-session.test.ts, asserted at the TOOL layer.
  it("never issues a getListener probe anywhere in a successful start", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const deps = makeDeps({ log, transport, listener });

    await startSuspended(deps, listener, "DG5B");

    // `classify` maps any non-DELETE request to /debugger/listeners to
    // "getListener", so this covers a probe from anywhere in the start path.
    expect(countOf(log, "getListener")).toBe(0);
    // Guard the guard: the arming request itself must still have gone out, so
    // a start that silently did nothing cannot pass this test vacuously.
    expect(log).toContain("listener:launch");
    expect(log).toContain("attach");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 20. GAP 5 — `action:"stack"` was only ever exercised with a FRESH stateId.
//     A stale one must get the same refusal the other three actions get.
// ---------------------------------------------------------------------------

describe("abap_debug stack — GAP 5: a stale stateId is refused, exactly like step/vars/value", () => {
  it("names the current stateId and never re-targets the fetch at a different stop", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "DG6");

    const stackCallsAfterStart = countOf(log, "getStack");
    const stale = "deadbeef".repeat(8);

    await expect(
      abapDebug(DUMMY_CONN, { action: "stack", stateId: stale } as DebugInput, 60_000, deps, writableGate()),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e) || e.code !== "BAD_INPUT") return false;
      expect(e.message).toContain("Stale");
      expect(e.message).toContain(stateId);
      return true;
    });

    // Refused BEFORE the wire — a stale read must never reach SAP at all.
    expect(countOf(log, "getStack")).toBe(stackCallsAfterStart);

    // The session is untouched: the CURRENT stateId still works.
    const fresh = await abapDebug(DUMMY_CONN, { action: "stack", stateId } as DebugInput, 60_000, deps, writableGate());
    expect(fresh.text).toContain("ZTEST_MCP_CRUD");
    expect(countOf(log, "getStack")).toBe(stackCallsAfterStart + 1);
  }, 20_000);
});

// ===========================================================================
// D4-D11 REGRESSION TESTS.
//
// One block per fix in `src/tools/debug.ts`. Every block below was confirmed
// RED against the unfixed handler (the fix reverted in place, this file
// unchanged) before being kept.
// ===========================================================================

// ---------------------------------------------------------------------------
// D4 — the debugger's WRITES go through the one existing safety gate
//      (`src/safety.ts`), and its READS deliberately do not.
// (`readOnlyGate`/`writableGate` are declared up near `START_INPUT` — nearly
// every test in the file needs one now that `gate` is required, not just
// this block.)
// ---------------------------------------------------------------------------

describe("D4 — breakpoints, steps, keepalive and stop are gated; reads are not", () => {
  it("refuses `start` on a read-only server BEFORE any SAP traffic at all", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const deps = makeDeps({ log, transport, listener });

    await expect(
      abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, readOnlyGate()),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e) || e.code !== "READ_ONLY") return false;
      expect(e.message).toContain("ABAP_ALLOW_WRITE");
      return true;
    });

    // Nothing was resolved, no breakpoint was armed, no listener was launched
    // and no second connection was opened: the refusal is pre-flight, not a
    // rollback of work already done on the appliance.
    expect(log).toEqual([]);
  }, 20_000);

  it("still starts normally once writes are enabled — the gate is not a blanket denial", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const deps = makeDeps({ log, transport, listener });

    const promise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
    await flushMicrotasks();
    listener.resolveWith(okResponse(buildDebuggeeXml("DG4")));
    const result = await promise;
    expect(extractStateId(result.text)).toBeTruthy();
    expect(countOf(log, "setBreakpoints:real")).toBe(1);
  }, 20_000);

  it("applies the PACKAGE allowlist to the breakpoint's own resolved package, not just to the run target", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const deps = makeDeps({ log, transport, listener });
    // Writes are on, the name prefix matches — only the package is wrong, and
    // the fixture object resolves to $TMP.
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["ZPKG_NOT_TMP"], allowNamePrefixes: ["Z"] });

    await expect(abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, gate)).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e) || e.code !== "SAFETY_DENIED") return false;
      expect(e.message).toContain("$TMP");
      expect(e.message).toContain("ZPKG_NOT_TMP");
      return true;
    });

    // The breakpoint was refused after resolution but before it was armed.
    expect(countOf(log, "setBreakpoints:real")).toBe(0);
    expect(countOf(log, "setBreakpoints:validate")).toBe(0);
  }, 20_000);

  it("refuses `step` on a live session when the gate has since gone read-only, without touching the wire", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ step: okResponse(buildStepXml({})) }));
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "DG4b");

    await expect(
      abapDebug(DUMMY_CONN, { action: "step", step: "over", stateId } as DebugInput, 60_000, deps, readOnlyGate()),
    ).rejects.toSatisfy((e: unknown) => isAbapError(e) && e.code === "READ_ONLY");
    expect(countOf(log, "step")).toBe(0);
  }, 20_000);

  it("refuses `keepalive` — it pins a suspended dialog work process for another idle period", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const deps = makeDeps({ log, transport, listener });
    await startSuspended(deps, listener, "DG4c");

    await expect(
      abapDebug(DUMMY_CONN, { action: "keepalive" } as DebugInput, 60_000, deps, readOnlyGate()),
    ).rejects.toSatisfy((e: unknown) => isAbapError(e) && e.code === "READ_ONLY");
  }, 20_000);

  it("refuses `stop` — terminating a debuggee is a write — while leaving the session intact for a permitted caller", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const deps = makeDeps({ log, transport, listener });
    await startSuspended(deps, listener, "DG4d");

    await expect(
      abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, deps, readOnlyGate()),
    ).rejects.toSatisfy((e: unknown) => isAbapError(e) && e.code === "READ_ONLY");
    expect(countOf(log, "terminateDebuggee")).toBe(0);

    // Still live, and a gate that permits writes can still tear it down (the
    // afterEach teardown, which passes no gate at all, would otherwise mask this).
    const stopped = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
    expect(stopped.text).toBeTruthy();
    expect(countOf(log, "terminateDebuggee")).toBe(1);
  }, 20_000);

  it("does NOT gate the reads: stack, abap_debug_vars and abap_debug_value all work under a read-only gate", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(
      log,
      HAPPY_TABLE({
        getVariables: (opts) =>
          okResponse(buildVariablesXml([{ id: "LV_COUNTER", name: "LV_COUNTER", metaType: "simple", value: "42" }])),
      }),
    );
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "DG4e");

    const stack = await abapDebug(DUMMY_CONN, { action: "stack", stateId } as DebugInput, 60_000, deps, readOnlyGate());
    expect(stack.text).toContain("ZTEST_MCP_CRUD");
    const status = await abapDebug(DUMMY_CONN, { action: "status" } as DebugInput, 60_000, deps, readOnlyGate());
    expect(status.text).toContain("suspended");
    // These two take no gate by design — observing an existing stop is a read.
    expect((await abapDebugVars({ stateId, scope: "all" }, 60_000)).text).toContain("LV_COUNTER");
    expect((await abapDebugValue({ stateId, path: "LV_COUNTER" }, 60_000)).text).toContain("42");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// D15 — the gate the TOOL layer holds must actually reach `DebugTransport`.
//
// `DebugTransport` gained an optional `{ safety, target }` (src/debug/transport.ts),
// but the only production construction site — `createDebugClientForConnection`
// (src/debug/session.ts), reached through `createLiveDebugToolDeps` — passed the
// connection and nothing else. Everything still compiled and every offline test
// stayed green, yet the package / name-prefix / productive half of the gate was
// dead code for debugger traffic in production: only the coarse
// `connection.readOnly` clause ran.
//
// This walks the whole chain in one go: `handleStart` -> `deps.createSession`
// -> `createLiveDebugToolDeps` -> `createDebugClientForConnection` ->
// `new DebugTransport(conn, { safety, target })` -> a refused POST.
// ---------------------------------------------------------------------------

/** Everything `createDebugClientForConnection` and `DebugTransport` dereference. Opens no socket. */
function makeGatedFakeConnection(): { conn: AbapConnection; writes: string[]; reads: string[] } {
  const writes: string[] = [];
  const reads: string[] = [];
  const respond = async (): Promise<{ status: number; headers: Record<string, string>; body: string }> => ({
    status: 200,
    headers: {},
    body: "<ok/>",
  });
  const fake = {
    cfg: { url: "http://offline.invalid:50000" },
    breaker: { isTripped: false },
    adt: { stateful: "stateless" },
    readOnly: false,
    readOnlyReason: "",
    cookies: () => "SAP_SESSIONID_A4H_001=X",
    csrfToken: () => "CSRF-TOKEN",
    get: (path: string) => {
      reads.push(path);
      return respond();
    },
    post: (path: string) => {
      writes.push(path);
      return respond();
    },
    put: (path: string) => {
      writes.push(path);
      return respond();
    },
    del: (path: string) => {
      writes.push(path);
      return respond();
    },
  };
  return { conn: fake as unknown as AbapConnection, writes, reads };
}

/** The live `DebugTransport` buried inside a real `DebugSession` — no module mocking, same idiom as `authOf` in test/debug-session.test.ts. */
function transportOf(session: DebugSession): { request: (o: DebugRequestOptions) => Promise<RawResponse> } {
  const client = (session as unknown as { client: unknown }).client;
  return (client as { transport: { request: (o: DebugRequestOptions) => Promise<RawResponse> } }).transport;
}

describe("D15 — the tool layer's SafetyGate reaches DebugTransport", () => {
  it("passes the live gate instance and the resolved target down to the transport, which then refuses a mutation outside ABAP_ALLOW_PACKAGES before any request", async () => {
    const gate = writableGate();

    // --- hop 1: handleStart -> deps.createSession(conn, safety, { target }) ---
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const base = makeDeps({ log, transport, listener });
    // Definite-assignment assertion: assigned inside the `createSession`
    // callback, which `await promise` below guarantees has run by the time
    // this is read. `safety` is now required, so unlike
    // `capturedOpts` its type no longer includes `undefined`, and control-flow
    // analysis alone can't see across the callback boundary.
    let capturedSafety!: Parameters<DebugToolDeps["createSession"]>[1];
    let capturedOpts: Parameters<DebugToolDeps["createSession"]>[2];
    const deps: DebugToolDeps = {
      ...base,
      createSession(conn, safety, opts) {
        capturedSafety = safety;
        capturedOpts = opts;
        return base.createSession(conn, safety, opts);
      },
    };
    const promise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, gate);
    await flushMicrotasks();
    listener.resolveWith(okResponse(buildDebuggeeXml("DG15")));
    await promise;

    // The SAME object, not a copy and not a second gate built from the same env.
    expect(capturedSafety).toBe(gate);
    // ...and the target was narrowed IN PLACE to the RESOLVED breakpoint object,
    // so the transport judges the package the tool layer actually judged rather
    // than the package-less parsed run name it started from.
    expect(capturedOpts?.target).toEqual({ name: "ZTEST_MCP_CRUD", packageName: "$TMP", type: "PROG/P" });

    // --- hops 2+3: createLiveDebugToolDeps -> createDebugClientForConnection -> DebugTransport ---
    const { conn: fakeConn, writes, reads } = makeGatedFakeConnection();
    const { pool } = makeTestPool();
    const liveDeps = createLiveDebugToolDeps({ cfg: OFFLINE_CFG, log: () => {}, pool, gate });
    const liveSession = liveDeps.createSession(fakeConn, capturedSafety!, capturedOpts);
    const liveTransport = transportOf(liveSession);
    try {
      // Reads stay ungated at this layer, exactly as `MUTATING_OPS` says.
      await liveTransport.request({ method: "GET", path: "/sap/bc/adt/debugger/stack" });
      expect(reads).toHaveLength(1);

      // The operator's allowlist stops covering this session's package. Because
      // the transport holds the gate INSTANCE (not a snapshot of its verdict),
      // it sees that immediately — which is precisely what proves the wiring.
      gate.update({ allowPackages: ["ZPKG_NOT_TMP"] });
      await expect(
        liveTransport.request({ method: "POST", path: "/sap/bc/adt/debugger?method=attach", body: "<x/>" }),
      ).rejects.toSatisfy((e: unknown) => {
        if (!isAbapError(e) || e.code !== "SAFETY_DENIED") return false;
        expect(e.message).toContain("$TMP");
        expect(e.message).toContain("ZPKG_NOT_TMP");
        return true;
      });
      // Refused locally: zero requests reached the connection.
      expect(writes).toHaveLength(0);
    } finally {
      gate.update({ allowPackages: ["$TMP"] });
      await liveSession.cleanup();
    }
    // The extra session must not outlive this test — a live one in
    // `activeSessions` makes the NEXT test's start fail with "already live".
    expect(liveSession.snapshot.status).toBe("dead");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// D5 — `condition` / `skipCount` reach the wire instead of being stripped by
//      the zod schema (zod drops unknown keys silently, so the caller believed
//      it had a conditional breakpoint and got an unconditional one).
// ---------------------------------------------------------------------------

describe("D5 — breakpoint condition and skipCount survive the schema and reach the wire", () => {
  it("keeps both keys through `DebugInput` parsing instead of stripping them", () => {
    const parsed = DebugInput.parse({
      action: "start",
      breakpoints: [{ kind: "line", object: "ZTEST_MCP_CRUD", line: 15, condition: "lv_counter > 5", skipCount: 9 }],
      run: { object: "ZTEST_MCP_CRUD", mode: "report" },
    });
    const bp = parsed.breakpoints![0]!;
    expect(bp.condition).toBe("lv_counter > 5");
    expect(bp.skipCount).toBe(9);
  });

  it("emits condition= and skipCount= on BOTH the validation and the real breakpoint POST, XML-escaped", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const deps = makeDeps({ log, transport, listener });

    // Parsed through the schema on purpose — that is where the two keys used to
    // be dropped, and a test that hand-builds the object would sail straight
    // past the actual defect.
    const input = DebugInput.parse({
      action: "start",
      breakpoints: [{ kind: "line", object: "ZTEST_MCP_CRUD", line: 15, condition: "lv_counter > 5", skipCount: 9 }],
      run: { object: "ZTEST_MCP_CRUD", mode: "report" },
    });

    const promise = abapDebug(DUMMY_CONN, input, 60_000, deps, writableGate());
    await flushMicrotasks();
    listener.resolveWith(okResponse(buildDebuggeeXml("DG5")));
    await promise;

    const bpPosts = transport.calls.filter((c) => c.path.includes("/debugger/breakpoints") && c.method === "POST");
    expect(bpPosts.length).toBeGreaterThanOrEqual(2);
    for (const post of bpPosts.slice(0, 2)) {
      expect(post.body).toContain('skipCount="9"');
      // `>` must be escaped — an unescaped condition produces malformed XML.
      expect(post.body).toContain('condition="lv_counter &gt; 5"');
    }
  }, 20_000);

  it("keeps skipCount:0 — 'break on every hit' is a real value, not an absent one", () => {
    const parsed = DebugInput.parse({
      action: "start",
      breakpoints: [{ kind: "line", object: "ZTEST_MCP_CRUD", line: 15, skipCount: 0 }],
      run: { object: "ZTEST_MCP_CRUD", mode: "report" },
    });
    expect(parsed.breakpoints![0]!.skipCount).toBe(0);
  });

  // Live A4H capture proved skipCount>0 is accepted and echoed by
  // the ADT breakpoint POST but never actually enforced — the debuggee
  // suspends on every hit regardless. The wire encoding itself is correct
  // (proven by the two tests above), so the fix is disclosure, not a
  // client-side re-implementation of "Nth hit" semantics that would
  // contradict this codebase's documented "skipCount is wire-real" model.
  it("start's response warns when a non-zero skipCount is armed but not enforced", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const deps = makeDeps({ log, transport, listener });

    const input = DebugInput.parse({
      action: "start",
      breakpoints: [{ kind: "line", object: "ZTEST_MCP_CRUD", line: 15, skipCount: 9 }],
      run: { object: "ZTEST_MCP_CRUD", mode: "report" },
    });

    const promise = abapDebug(DUMMY_CONN, input, 60_000, deps, writableGate());
    await flushMicrotasks();
    listener.resolveWith(okResponse(buildDebuggeeXml("DG5b")));
    const started = await promise;

    expect(started.text).toContain("NOTE:");
    expect(started.text).toContain("skipCount:9");
    expect(started.text).toContain("NOT enforced");
    expect(started.text).toContain("not just the Nth");
  }, 20_000);

  it("says nothing about skipCount when none is armed, or when it is explicitly 0", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const deps = makeDeps({ log, transport, listener });

    const input = DebugInput.parse({
      action: "start",
      breakpoints: [{ kind: "line", object: "ZTEST_MCP_CRUD", line: 15, skipCount: 0 }],
      run: { object: "ZTEST_MCP_CRUD", mode: "report" },
    });

    const promise = abapDebug(DUMMY_CONN, input, 60_000, deps, writableGate());
    await flushMicrotasks();
    listener.resolveWith(okResponse(buildDebuggeeXml("DG5c")));
    const started = await promise;

    expect(started.text).not.toContain("NOT enforced");
    expect(started.text).not.toContain("skipCount:0");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// D6 — the retrieval hints carry the caller's REAL stateId. Emitting the
//      literal `<stateId>` placeholder makes every suggested follow-up call
//      fail with a stale-stateId refusal.
// ---------------------------------------------------------------------------

describe("D6 — retrieval hints carry the real stateId, never the literal placeholder", () => {
  it("abap_debug_vars, abap_debug_value and the start survey all interpolate the live stateId", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ getVariables: tableResponder("LT_ITEMS", 3) }));
    const deps = makeDeps({ log, transport, listener });

    const startPromise = abapDebug(DUMMY_CONN, START_INPUT, 60_000, deps, writableGate());
    await flushMicrotasks();
    listener.resolveWith(okResponse(buildDebuggeeXml("DG6b")));
    const started = await startPromise;
    const stateId = extractStateId(started.text)!;

    // The start survey itself already suggests Tier-2 calls.
    expect(started.text).toContain(`stateId: "${stateId}"`);
    expect(started.text).not.toContain("<stateId>");

    const vars = await abapDebugVars({ stateId, scope: "all" }, 60_000);
    expect(vars.text).toContain(`stateId: "${stateId}"`);
    expect(vars.text).not.toContain("<stateId>");

    const table = await abapDebugValue({ stateId, path: "LT_ITEMS" }, 60_000);
    expect(table.text).not.toContain("<stateId>");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// D7 — an unbounded `count` allocated one <ID> element per requested row and
//      OOMed the process. It is now capped, and the cap is DISCLOSED.
// ---------------------------------------------------------------------------

describe("D7 — the row count is clamped, refused at the schema, and the clamp is disclosed", () => {
  it("refuses an absurd count at the MCP boundary rather than allocating for it", () => {
    expect(DebugValueInput.safeParse({ stateId: "x".repeat(8), path: "LT_ITEMS", count: 100_000 }).success).toBe(false);
    expect(DebugValueInput.safeParse({ stateId: "x".repeat(8), path: "LT_ITEMS", count: MAX_TABLE_ROWS }).success).toBe(true);
  });

  it("clamps a direct (schema-bypassing) call to MAX_TABLE_ROWS and never requests row MAX+1", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ getVariables: tableResponder("LT_BIG", 5_000) }));
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "DG7");

    const result = await abapDebugValue({ stateId, path: "LT_BIG", count: 5_000 }, 60_000);

    const rowFetch = transport.calls.find((c) => c.body?.includes("LT_BIG["));
    expect(rowFetch).toBeTruthy();
    const ids = [...rowFetch!.body!.matchAll(/<ID>LT_BIG\[(\d+)\]<\/ID>/g)].map((m) => Number(m[1]));
    expect(ids.length).toBe(MAX_TABLE_ROWS);
    expect(Math.max(...ids)).toBe(MAX_TABLE_ROWS);
    expect(rowFetch!.body).not.toContain(`LT_BIG[${MAX_TABLE_ROWS + 1}]`);

    // Silent clamping is the thing this repo forbids: say so, and say how to
    // get the rest.
    expect(result.text).toContain("TRUNCATED:");
    expect(result.text).toContain("5000");
    expect(result.text).toContain(String(MAX_TABLE_ROWS));
    expect(result.text).toContain(`from:${MAX_TABLE_ROWS + 1}`);
  }, 20_000);

  it("says nothing about truncation when the requested window is within the cap", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ getVariables: tableResponder("LT_BIG", 5_000) }));
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "DG7b");

    const result = await abapDebugValue({ stateId, path: "LT_BIG", count: 5 }, 60_000);
    expect(result.text).not.toContain("TRUNCATED:");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// D8 — the trigger connection must not install a SECOND set of process-level
//      SIGINT/SIGTERM handlers. Two racing handlers mean whichever reaches
//      `process.exit(0)` first wins, and the trigger connection's has no
//      shutdown work to do — so it kills the process while the server
//      connection is still terminating the debuggee.
// ---------------------------------------------------------------------------

/** A syntactically valid, never-contacted config. Nothing here opens a socket. */
const OFFLINE_CFG = ConfigSchema.parse({
  url: "http://offline.invalid:50000",
  user: "TESTUSER",
  password: "never-used",
});

describe("D8 — the trigger connection leaves no rival signal handlers behind", () => {
  it("createTriggerConnection() disposes the process hooks connect() installed", async () => {
    // `connect()` is stubbed to do exactly ONE thing: what it really does to the
    // process — install the shutdown hooks. No network, no login.
    const connectSpy = vi
      .spyOn(AbapConnection.prototype, "connect")
      .mockImplementation(async function (this: AbapConnection): Promise<void> {
        (this as unknown as { installShutdownHooks: () => void }).installShutdownHooks();
      });
    const before = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
      beforeExit: process.listenerCount("beforeExit"),
    };
    let conn: AbapConnection | undefined;
    try {
      const { pool } = makeTriggerPool();
      const deps = createLiveDebugToolDeps({ cfg: OFFLINE_CFG, log: () => {}, pool });
      conn = await deps.createTriggerConnection();
      expect(connectSpy).toHaveBeenCalledTimes(1);

      expect(process.listenerCount("SIGINT")).toBe(before.sigint);
      expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
      expect(process.listenerCount("beforeExit")).toBe(before.beforeExit);
    } finally {
      conn?.dispose();
      connectSpy.mockRestore();
    }
  }, 20_000);

  it("shutdownDebugTools() releases the trigger connection and clears the current run", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const shutdownSpy = newShutdownSpy();
    const deps = makeDeps({ log, transport, listener, shutdownSpy });
    await startSuspended(deps, listener, "DG8");

    // Exactly the pair `src/index.ts` runs on the server connection's shutdown
    // chain, in that order. `shutdownDebugTools()` owns THIS module's state (the
    // trigger connection + the current-run slot); `shutdownAllDebugSessions()`
    // owns the debuggee. Neither substitutes for the other.
    shutdownDebugTools();
    expect(shutdownSpy.count).toBe(1);
    // Two-sources-of-truth fix (see the "leaked session recovery" describe
    // block above): `shutdownDebugTools()` deliberately only clears THIS
    // module's `currentRun` slot — the comment above says so — it does NOT
    // terminate the underlying `DebugSession`, which is still registered in
    // `activeSessions` and still genuinely "suspended" until
    // `shutdownAllDebugSessions()` runs below. `status` used to report a
    // blanket "idle" here purely because it trusted `currentRun` alone — a
    // real instance of the exact bug class this fix closes: the debuggee was
    // still live, and "idle" is not a truthful answer about it. `status` now
    // consults `listActiveDebugSessions()` and reports what is actually
    // there.
    const status = await abapDebug(DUMMY_CONN, { action: "status" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
    expect(status.text).toContain("suspended");
    expect(status.text).not.toContain("no active debug session");

    await shutdownAllDebugSessions();
    expect(countOf(log, "terminateDebuggee")).toBe(1);
    expect(listActiveDebugSessions()).toHaveLength(0);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// D8b — `createTriggerConnection()` mints its connection from the POOL
// (`params.pool.createUnpooledConnection("debug-trigger")`, `src/tools/
// debug.ts`), not from a caller-supplied `breaker` — that parameter is gone
// from `createLiveDebugToolDeps` entirely. This locks in two things:
//   - REGRESSION (red before this fix, would have caught the original bug —
//     `createTriggerConnection()` used to build its own `AbapConnection` off
//     a rogue `breaker` param that need not be the pool's shared instance):
//     the connection `createTriggerConnection()` returns carries the SAME
//     breaker object as `pool.primary()`.
//   - BEHAVIOUR-LOCK (green both before and after this fix; its teeth were
//     proven separately, by deleting `breaker: params.breaker` from the OLD
//     pre-fix `createTriggerConnection()`, which turned it red with
//     `expected 'AUTH_FAILED' to be 'AUTH_CIRCUIT_OPEN'`): a pool breaker
//     tripped before the call refuses the trigger connection outright, before
//     any request reaches the wire.
// ---------------------------------------------------------------------------

/**
 * A REAL `AdtSessionPool` over REAL `AbapConnection`s with a recording fake
 * `HttpClient` injected — unlike `makeTestPool()` above, whose stub conns carry
 * only `.breaker` and have no `connect()`/`dispose()`. Needed because these
 * tests drive `createTriggerConnection()`, which really calls `connect()` and
 * `dispose()`. Nothing ever reaches a socket: every request is answered by the
 * fake, and its `calls` array is the zero-logon observable.
 */
function makeTriggerPool(): {
  pool: AdtSessionPool;
  calls: Array<{ url: string; method: string }>;
} {
  const calls: Array<{ url: string; method: string }> = [];
  const fake: HttpClient = {
    async request(o: HttpClientOptions): Promise<HttpClientResponse> {
      calls.push({ url: String(o.url ?? ""), method: String(o.method ?? "GET") });
      return {
        body: "",
        status: 200,
        statusText: "OK",
        headers: {},
      } as unknown as HttpClientResponse;
    },
  };
  // The first slot's breaker is seeded here, NOT left to
  // `AbapConnection.buildBreaker(cfg)`. That matters: `buildBreaker` tags the
  // breaker with a `credentialFingerprint`, and tripping a fingerprinted
  // breaker writes into circuit-breaker.ts's PROCESS-WIDE
  // `TRIPPED_FINGERPRINTS` map. Any later `new AbapConnection(sameCfg, …)`
  // would then inherit the latch for free — which both leaks state into the
  // rest of this file and would make the BEHAVIOUR-LOCK below pass even when
  // the trigger connection does NOT get the pool's breaker. An anonymous
  // breaker (no fingerprint) never persists, so the only way a trigger
  // connection can be tripped is by genuinely holding THIS instance.
  const pool = new AdtSessionPool({
    cfg: debugCfg(),
    breaker: new AuthCircuitBreaker(),
    createConnection: (c: Config, o: ConnectionOptions) =>
      new AbapConnection(c, {
        ...o,
        httpClient: fake,
        breaker: o.breaker,
        log: () => {},
      }),
  });
  return { pool, calls };
}

describe("D8b — the trigger connection is minted by the pool, so it cannot miss the shared breaker", () => {
  it("REGRESSION: createTriggerConnection() returns a connection carrying the POOL's breaker instance", async () => {
    const { pool } = makeTriggerPool();
    const primary = pool.primary();
    const connectSpy = vi
      .spyOn(AbapConnection.prototype, "connect")
      .mockResolvedValue(undefined as never);
    try {
      const deps = createLiveDebugToolDeps({
        cfg: debugCfg(),
        log: () => {},
        pool,
      });
      const trigger = await deps.createTriggerConnection();
      expect(trigger.breaker).toBe(primary.breaker);
    } finally {
      connectSpy.mockRestore();
    }
  });

  it("BEHAVIOUR-LOCK: a tripped pool breaker refuses the trigger connection before any request leaves", async () => {
    const { pool, calls } = makeTriggerPool();
    const primary = pool.primary();
    primary.breaker.trip("http-401", "bad credentials");
    const deps = createLiveDebugToolDeps({
      cfg: debugCfg(),
      log: () => {},
      pool,
    });
    const before = calls.length;
    const err = await deps.createTriggerConnection().then(
      () => null,
      (e: unknown) => e,
    );
    expect(isAbapError(err) ? err.code : `not-an-AbapError: ${String(err)}`).toBe("AUTH_CIRCUIT_OPEN");
    expect(calls.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// createLiveDebugToolDeps threads cfg.ideId into resolveTerminalId exactly
// like the existing cfg.terminalId wiring (ABAP_IDE_ID). Without this, two
// MCP server processes for the same
// SID+user derive the identical terminalId AND ideId with no override,
// making them indistinguishable to SAP's debugger.
// ---------------------------------------------------------------------------

/** Read the private `context` a `DebugSession` was constructed with — same idiom as `transportOf` above. */
function contextOf(session: DebugSession): { terminalId: string; ideId: string } {
  return (session as unknown as { context: { terminalId: string; ideId: string } }).context;
}

const OVERRIDE_IDE_ID = "C".repeat(32);
const OTHER_OVERRIDE_IDE_ID = "E".repeat(32);
const OVERRIDE_TERMINAL_ID = "D".repeat(32);

describe("createLiveDebugToolDeps wires cfg.ideId alongside cfg.terminalId", () => {
  it("with neither override set, terminalId and ideId are both 32 uppercase hex and differ from each other", async () => {
    const { pool } = makeTestPool();
    const liveDeps = createLiveDebugToolDeps({ cfg: OFFLINE_CFG, log: () => {}, pool });
    const { conn: fakeConn } = makeGatedFakeConnection();
    const session = liveDeps.createSession(fakeConn, writableGate());
    try {
      const { terminalId, ideId } = contextOf(session);
      expect(terminalId).toMatch(/^[0-9A-F]{32}$/);
      expect(ideId).toMatch(/^[0-9A-F]{32}$/);
      // Different seeds (":terminalId" vs ":ideId") must derive different ids —
      // otherwise two unrelated processes with no override would collide, and
      // an operator who sets ABAP_IDE_ID equal to ABAP_TERMINAL_ID by hand
      // would just be reproducing what "unset" already did.
      expect(ideId).not.toBe(terminalId);
    } finally {
      await session.cleanup();
    }
  });

  it("cfg.ideId overrides only ideId; terminalId stays derived", async () => {
    const cfg = ConfigSchema.parse({
      url: "http://offline.invalid:50000",
      user: "TESTUSER",
      password: "never-used",
      ideId: OVERRIDE_IDE_ID,
    });
    const { pool } = makeTestPool();
    const liveDeps = createLiveDebugToolDeps({ cfg, log: () => {}, pool });
    const { conn: fakeConn } = makeGatedFakeConnection();
    const session = liveDeps.createSession(fakeConn, writableGate());
    try {
      const { terminalId, ideId } = contextOf(session);
      expect(ideId).toBe(OVERRIDE_IDE_ID);
      expect(terminalId).toMatch(/^[0-9A-F]{32}$/);
      expect(terminalId).not.toBe(OVERRIDE_IDE_ID);
    } finally {
      await session.cleanup();
    }
  });

  it("cfg.terminalId overrides only terminalId; ideId stays derived", async () => {
    const cfg = ConfigSchema.parse({
      url: "http://offline.invalid:50000",
      user: "TESTUSER",
      password: "never-used",
      terminalId: OVERRIDE_TERMINAL_ID,
    });
    const { pool } = makeTestPool();
    const liveDeps = createLiveDebugToolDeps({ cfg, log: () => {}, pool });
    const { conn: fakeConn } = makeGatedFakeConnection();
    const session = liveDeps.createSession(fakeConn, writableGate());
    try {
      const { terminalId, ideId } = contextOf(session);
      expect(terminalId).toBe(OVERRIDE_TERMINAL_ID);
      expect(ideId).toMatch(/^[0-9A-F]{32}$/);
      expect(ideId).not.toBe(OVERRIDE_TERMINAL_ID);
    } finally {
      await session.cleanup();
    }
  });

  it("two configs differing only in ideId produce sessions with different context.ideId — the whole point: two MCP processes for the same SID+user are otherwise indistinguishable to SAP", async () => {
    const cfgA = ConfigSchema.parse({
      url: "http://offline.invalid:50000",
      user: "TESTUSER",
      password: "never-used",
      ideId: OVERRIDE_IDE_ID,
    });
    const cfgB = ConfigSchema.parse({
      url: "http://offline.invalid:50000",
      user: "TESTUSER",
      password: "never-used",
      ideId: OTHER_OVERRIDE_IDE_ID,
    });
    const { pool: poolA } = makeTestPool();
    const { pool: poolB } = makeTestPool();
    const depsA = createLiveDebugToolDeps({ cfg: cfgA, log: () => {}, pool: poolA });
    const depsB = createLiveDebugToolDeps({ cfg: cfgB, log: () => {}, pool: poolB });
    const { conn: fakeConnA } = makeGatedFakeConnection();
    const { conn: fakeConnB } = makeGatedFakeConnection();
    const sessionA = depsA.createSession(fakeConnA, writableGate());
    const sessionB = depsB.createSession(fakeConnB, writableGate());
    try {
      expect(contextOf(sessionA).ideId).toBe(OVERRIDE_IDE_ID);
      expect(contextOf(sessionB).ideId).toBe(OTHER_OVERRIDE_IDE_ID);
      expect(contextOf(sessionA).ideId).not.toBe(contextOf(sessionB).ideId);
    } finally {
      await sessionA.cleanup();
      await sessionB.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// `createLiveDebugToolDeps({ pool })` — `pool` is REQUIRED, and
// `reserveDebugSession` is unconditional.
//
// `pool` used to be optional and `src/tools/debug.ts`'s
// `createLiveDebugToolDeps` only spread in `reserveDebugSession` when
// `params.pool` was supplied. That optionality is GONE, on purpose: an
// optional pool just moved the shared-breaker hole (see D8b above) into the
// `undefined` branch — a caller that forgot to pass `pool` silently kept
// minting its trigger connection off whatever it had lying around instead of
// the pool's breaker. Making `pool` required closes that branch entirely;
// there is no longer an unpooled mode for the LIVE factory to fall back to.
//
// The only place optionality survives is the hand-built `DebugToolDeps`
// INTERFACE field itself (`reserveDebugSession?(...)`) — kept so a
// hand-rolled deps object like this file's own `makeDeps()` (which never
// sets it) may still omit it. That seam is what the first test below pins.
// ---------------------------------------------------------------------------

describe("createLiveDebugToolDeps — the pool is REQUIRED and reserveDebugSession is unconditional", () => {
  it("createLiveDebugToolDeps always exposes reserveDebugSession as a function; the optional field lives only on the hand-built DebugToolDeps interface", async () => {
    const { pool } = makeTestPool();
    const liveDeps = createLiveDebugToolDeps({ cfg: OFFLINE_CFG, log: () => {}, pool });
    expect(liveDeps.reserveDebugSession).toBeTypeOf("function");

    const { conn: fakeConn } = makeGatedFakeConnection();
    const session = liveDeps.createSession(fakeConn, writableGate());
    try {
      const { terminalId, ideId } = contextOf(session);
      expect(terminalId).toMatch(/^[0-9A-F]{32}$/);
      expect(ideId).toMatch(/^[0-9A-F]{32}$/);
    } finally {
      await session.cleanup();
    }

    // The interface field stays optional so a hand-built `DebugToolDeps` (this
    // file's own `makeDeps()`, which never sets it) may still omit it.
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    expect(makeDeps({ log, transport, listener }).reserveDebugSession).toBeUndefined();
  });

  it("with a `pool` argument, reserveDebugSession IS exposed and taking it draws a real lease from that pool", async () => {
    const { pool } = makeTestPool();
    const liveDeps = createLiveDebugToolDeps({
      cfg: OFFLINE_CFG,
      log: () => {},
      pool,
    });
    expect(liveDeps.reserveDebugSession).toBeTypeOf("function");

    expect(pool.stats().busy).toBe(0);
    const slot = await liveDeps.reserveDebugSession!("debugger/listeners");
    try {
      // A REAL lease from THIS pool, not a stand-in — the pool now shows one
      // busy slot, and a second debug reservation is refused `lease-held`.
      expect(pool.stats().busy).toBe(1);
      const refused = await pool
        .reserveDebug("second")
        .then(() => null)
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(SessionBusyError);
      expect((refused as SessionBusyError).reason).toBe("lease-held");
    } finally {
      slot.release();
    }
    expect(pool.stats().busy).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D11 — `stepRunToLine` / `stepJumpToLine` were unreachable: the step enum had
//       no value that mapped onto them, so the kinds existed in `endpoints.ts`
//       and in `classify()` and nothing could ever ask for one.
//
// NOTE: the URL SHAPE below (`?method=stepRunToLine&uri=<source uri>#start=<n>`)
// is assembled entirely by read-only code (`stepUrl` + `withStartFragment`) and
// the `#start=<line>` fragment convention is live-proven for breakpoints — but
// no live capture of a stepRunToLine dispatch exists, so this test pins the
// wiring, not the appliance's acceptance of it.
// ---------------------------------------------------------------------------

describe("D11 — line-targeted steps are reachable and carry a #start fragment", () => {
  it("accepts runToLine/jumpToLine with a toLine through the schema", () => {
    expect(DebugInput.safeParse({ action: "step", step: "runToLine", toLine: 42, stateId: "x".repeat(8) }).success).toBe(true);
    expect(DebugInput.safeParse({ action: "step", step: "jumpToLine", toLine: 42, stateId: "x".repeat(8) }).success).toBe(true);
    expect(DebugInput.safeParse({ action: "step", step: "runToLine", toLine: 0, stateId: "x".repeat(8) }).success).toBe(false);
  });

  it("dispatches method=stepRunToLine with the CURRENT frame's source URI and the requested line", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ step: okResponse(buildStepXml({})) }));
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "DG11");

    await abapDebug(
      DUMMY_CONN,
      { action: "step", step: "runToLine", toLine: 42, stateId } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );

    const stepCall = transport.calls.find((c) => c.path.includes("method=stepRunToLine"));
    expect(stepCall).toBeTruthy();
    const decoded = decodeURIComponent(stepCall!.path);
    expect(decoded).toContain("/sap/bc/adt/programs/programs/ZTEST_MCP_CRUD/source/main#start=42");
    // The stack frame's own URI already carries `#start=15` (live-captured
    // shape). Appending blindly would produce two fragments.
    expect(decoded).not.toContain("#start=15");
    expect(decoded.match(/#start=/g)?.length).toBe(1);
  }, 20_000);

  it("refuses a line-targeted step with no toLine, before the wire", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ step: okResponse(buildStepXml({})) }));
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "DG11b");

    // jumpToLine carries its own server-level
    // ceiling + per-call confirm, checked BEFORE the toLine-presence check
    // (a disabled/unconfirmed dangerous step should refuse immediately,
    // without leaking anything about what other parameters it would have
    // needed). This test predates that gate and targets the toLine-missing
    // path specifically, so it must satisfy the gate first — allowJumpToLine
    // + confirm — to actually reach the check it's exercising. The gate's
    // own refusal behavior (ceiling off / confirm missing or mismatched) is
    // covered separately below in "jumpToLine is gated separately from the
    // general write gate".
    deps.allowJumpToLine = true;

    await expect(
      abapDebug(
        DUMMY_CONN,
        { action: "step", step: "jumpToLine", stateId, confirm: "jumpToLine" } as DebugInput,
        60_000,
        deps,
        writableGate(),
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e) || e.code !== "BAD_INPUT") return false;
      expect(e.message).toContain("toLine");
      return true;
    });
    expect(countOf(log, "step")).toBe(0);
  }, 20_000);

  it("refuses a line-targeted runToLine step with no toLine, before the wire (unaffected by the jumpToLine gate)", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ step: okResponse(buildStepXml({})) }));
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "DG11c");

    await expect(
      abapDebug(DUMMY_CONN, { action: "step", step: "runToLine", stateId } as DebugInput, 60_000, deps, writableGate()),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e) || e.code !== "BAD_INPUT") return false;
      expect(e.message).toContain("toLine");
      return true;
    });
    expect(countOf(log, "step")).toBe(0);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Defect 2 — a revisited (program, stack level, line) position is disclosed
// as an advisory note on the step response, per `DebugSession.recordVisit`
// (src/debug/session.ts). This is deliberately NOT a claim about how many
// loop iterations ran — see that method's doc comment for why a true
// per-iteration count is not something this codebase can prove
// from the wire protocol as understood. `HAPPY_TABLE`'s `getStack` responder
// is a single static fixture (`ZTEST_MCP_CRUD` line 15) reused for every
// `getStack` call in a test, so two consecutive steps naturally land on the
// exact same reported (program, stackPosition, line) — exactly the condition
// this advisory exists to disclose, with no need for a special multi-response
// queue.
// ---------------------------------------------------------------------------

describe("Defect 2 — revisited-position advisory on step responses", () => {
  it("adds no revisit note on the first step to a position", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ step: okResponse(buildStepXml({})) }));
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "DR1");

    const result = await abapDebug(
      DUMMY_CONN,
      { action: "step", step: "into", stateId } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );
    expect(result.text).not.toContain("Position revisited");
  }, 20_000);

  it('adds a "Position revisited" advisory, recommending breakpoint + step:"continue", the second time stepping lands on the exact same program/stack-level/line', async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ step: okResponse(buildStepXml({})) }));
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "DR2");

    const first = await abapDebug(
      DUMMY_CONN,
      { action: "step", step: "into", stateId } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );
    expect(first.text).not.toContain("Position revisited");
    const stateId2 = extractStateId(first.text)!;

    const second = await abapDebug(
      DUMMY_CONN,
      { action: "step", step: "into", stateId: stateId2 } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );
    expect(second.text).toContain("Position revisited");
    expect(second.text).toContain("2 times");
    expect(second.text).toContain('step:"continue"');
    // This is explicitly NOT a loop-iteration count — the advisory text must
    // say so, not just imply it, so an agent reading this response can't
    // mistake "revisited N times" for "the loop ran N times".
    expect(second.text).toContain("not how");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// `step:"jumpToLine"` is gated SEPARATELY from the
// general `execute` write gate `assertSessionWrite` already checks: a
// server-level ceiling (`DebugToolDeps.allowJumpToLine`, sourced from
// `Config.allowDebugJumpToLine`/`ABAP_ALLOW_DEBUG_JUMP_TO_LINE` in production)
// that a per-call argument can only narrow, never widen, PLUS a per-call
// `confirm:"jumpToLine"` echo. Both are required; neither alone is enough.
// `runToLine` (also line-targeted) must stay completely unaffected by either
// check — it is the regression control.
// ---------------------------------------------------------------------------

describe("jumpToLine is gated separately from the general write gate", () => {
  it("refuses jumpToLine with DEBUG_JUMP_DISABLED when the server ceiling is off, even with confirm supplied", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ step: okResponse(buildStepXml({})) }));
    const deps = makeDeps({ log, transport, listener }); // allowJumpToLine left undefined -> false
    const stateId = await startSuspended(deps, listener, "DJ1");

    await expect(
      abapDebug(
        DUMMY_CONN,
        { action: "step", step: "jumpToLine", toLine: 42, stateId, confirm: "jumpToLine" } as DebugInput,
        60_000,
        deps,
        writableGate(),
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e)) return false;
      expect(e.code).toBe("DEBUG_JUMP_DISABLED");
      expect(e.message).toContain("ABAP_ALLOW_DEBUG_JUMP_TO_LINE");
      return true;
    });
    expect(countOf(log, "step")).toBe(0);
  }, 20_000);

  it("refuses jumpToLine with BAD_INPUT when the ceiling is on but confirm is missing", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ step: okResponse(buildStepXml({})) }));
    const deps = makeDeps({ log, transport, listener });
    deps.allowJumpToLine = true;
    const stateId = await startSuspended(deps, listener, "DJ2");

    await expect(
      abapDebug(
        DUMMY_CONN,
        { action: "step", step: "jumpToLine", toLine: 42, stateId } as DebugInput,
        60_000,
        deps,
        writableGate(),
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e) || e.code !== "BAD_INPUT") return false;
      expect(e.message).toContain('confirm:"jumpToLine"');
      return true;
    });
    expect(countOf(log, "step")).toBe(0);
  }, 20_000);

  it("refuses jumpToLine with BAD_INPUT when the ceiling is on but confirm does not match the required echo", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ step: okResponse(buildStepXml({})) }));
    const deps = makeDeps({ log, transport, listener });
    deps.allowJumpToLine = true;
    const stateId = await startSuspended(deps, listener, "DJ3");

    await expect(
      abapDebug(
        DUMMY_CONN,
        { action: "step", step: "jumpToLine", toLine: 42, stateId, confirm: "yes please" } as DebugInput,
        60_000,
        deps,
        writableGate(),
      ),
    ).rejects.toSatisfy((e: unknown) => isAbapError(e) && e.code === "BAD_INPUT");
    expect(countOf(log, "step")).toBe(0);
  }, 20_000);

  it("dispatches stepJumpToLine once BOTH the ceiling is on AND confirm matches", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ step: okResponse(buildStepXml({})) }));
    const deps = makeDeps({ log, transport, listener });
    deps.allowJumpToLine = true;
    const stateId = await startSuspended(deps, listener, "DJ4");

    await abapDebug(
      DUMMY_CONN,
      { action: "step", step: "jumpToLine", toLine: 42, stateId, confirm: "jumpToLine" } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );

    const stepCall = transport.calls.find((c) => c.path.includes("method=stepJumpToLine"));
    expect(stepCall).toBeTruthy();
    expect(countOf(log, "step")).toBe(1);
  }, 20_000);

  it("regression control: runToLine needs neither the ceiling nor confirm", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ step: okResponse(buildStepXml({})) }));
    const deps = makeDeps({ log, transport, listener }); // allowJumpToLine left undefined
    const stateId = await startSuspended(deps, listener, "DJ5");

    await abapDebug(
      DUMMY_CONN,
      { action: "step", step: "runToLine", toLine: 42, stateId } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );

    expect(transport.calls.some((c) => c.path.includes("method=stepRunToLine"))).toBe(true);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// `action:"frame"` exposes `setStackPosition`, read-only.
// It must move the read cursor (dispatch `method=setStackPosition`), re-survey
// variables from the NEW frame, and require an active session/stateId/frame —
// same input-validation shape as `step`/`stack`. It must never accept a value
// to write (that stays `setVariableValue`, permanently unexposed).
// ---------------------------------------------------------------------------

describe('action:"frame" exposes setStackPosition read-only', () => {
  it('refuses with BAD_INPUT when there is no active session', async () => {
    await expect(
      abapDebug(DUMMY_CONN, { action: "frame", stateId: "x".repeat(8), frame: 1 } as DebugInput, 60_000, UNUSED_DEPS, writableGate()),
    ).rejects.toSatisfy((e: unknown) => isAbapError(e) && e.code === "BAD_INPUT" && /no active debug session/i.test(e.message));
  });

  it('refuses with BAD_INPUT when "stateId" is missing', async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ getStack: okResponse(buildTwoFrameStackXml()) }));
    const deps = makeDeps({ log, transport, listener });
    await startSuspended(deps, listener, "DF1");

    await expect(
      abapDebug(DUMMY_CONN, { action: "frame", frame: 1 } as DebugInput, 60_000, deps, writableGate()),
    ).rejects.toSatisfy((e: unknown) => isAbapError(e) && e.code === "BAD_INPUT" && e.message.includes("stateId"));
  });

  it('refuses with BAD_INPUT when "frame" is missing', async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ getStack: okResponse(buildTwoFrameStackXml()) }));
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "DF2");

    await expect(
      abapDebug(DUMMY_CONN, { action: "frame", stateId } as DebugInput, 60_000, deps, writableGate()),
    ).rejects.toSatisfy((e: unknown) => isAbapError(e) && e.code === "BAD_INPUT" && e.message.includes('"frame"'));
  });

  it('refuses with BAD_INPUT when "frame" does not match any known stackPosition', async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE({ getStack: okResponse(buildTwoFrameStackXml()) }));
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "DF3");

    await expect(
      abapDebug(DUMMY_CONN, { action: "frame", stateId, frame: 99 } as DebugInput, 60_000, deps, writableGate()),
    ).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "BAD_INPUT" && e.message.includes("does not match any frame"),
    );
    // Never reached the wire for a target that was never resolved.
    expect(transport.calls.some((c) => /method=setStackPosition/.test(c.path))).toBe(false);
  });

  it("switches the read cursor to the requested frame and re-surveys its variables", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(
      log,
      HAPPY_TABLE({
        getStack: okResponse(buildTwoFrameStackXml()),
        setStackPosition: okResponse(""),
      }),
    );
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "DF4");

    const result = await abapDebug(
      DUMMY_CONN,
      { action: "frame", stateId, frame: 2 } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );

    const setCall = transport.calls.find((c) => c.path.includes("method=setStackPosition"));
    expect(setCall).toBeTruthy();
    expect(decodeURIComponent(setCall!.path)).toContain("position=2");
    // The response describes frame #2 (the caller, line 9) — not frame #1.
    expect(result.text).toContain("frame: 2");
    expect(result.text).toContain("line: 9");
    expect(result.text).toContain("LV_COUNTER"); // re-surveyed via getChildVariables, same fixture data
    // Read-only by construction: nothing resembling a value-write parameter exists on this input.
    expect((abapDebug as unknown as (c: unknown, i: object, m: number, d: DebugToolDeps, g: SafetyGate) => unknown)).toBeTypeOf("function");
  }, 20_000);

  it('accepts action:"frame" with frame/confirm through the DebugInput schema', () => {
    expect(DebugInput.safeParse({ action: "frame", stateId: "x".repeat(8), frame: 2 }).success).toBe(true);
    expect(DebugInput.safeParse({ action: "frame", stateId: "x".repeat(8), frame: 0 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Every debugger call is refused when no debug session is held — the guard on
// module-level `currentRun` fires before the session is ever touched. Mirrors
// the `action:"frame"` no-session test above for the other four operations.
// ---------------------------------------------------------------------------

describe("no active session refuses every debugger call, not just frame", () => {
  it('action:"step" refuses with BAD_INPUT when there is no active session', async () => {
    await expect(
      abapDebug(DUMMY_CONN, { action: "step", step: "over", stateId: "x".repeat(8) } as DebugInput, 60_000, UNUSED_DEPS, writableGate()),
    ).rejects.toSatisfy(isNoActiveSessionRefusal);
  });

  it('action:"stack" refuses with BAD_INPUT when there is no active session', async () => {
    await expect(
      abapDebug(DUMMY_CONN, { action: "stack", stateId: "x".repeat(8) } as DebugInput, 60_000, UNUSED_DEPS, writableGate()),
    ).rejects.toSatisfy(isNoActiveSessionRefusal);
  });

  it("abapDebugVars refuses with BAD_INPUT when there is no active session", async () => {
    await expect(abapDebugVars({ stateId: "x".repeat(8) }, 60_000)).rejects.toSatisfy(isNoActiveSessionRefusal);
  });

  it("abapDebugValue refuses with BAD_INPUT when there is no active session", async () => {
    await expect(abapDebugValue({ stateId: "x".repeat(8), path: "SY-SUBRC" }, 60_000)).rejects.toSatisfy(
      isNoActiveSessionRefusal,
    );
  });
});

// ---------------------------------------------------------------------------
// `abap_debug({action:"stop"})`'s "no active
// session" branch now ALSO best-effort releases a listener orphaned by an
// earlier process instance, via `DebugToolDeps.releaseOrphanListener`
// (optional — omitting it, as every OTHER test in this file's `makeDeps` does,
// must keep the idle-stop response exactly as it always was). Live-verified
// against A4H: this suite only
// pins the dispatch/note-rendering logic around a fake, not the wire.
// ---------------------------------------------------------------------------

describe("stop releases an orphaned listener via deps.releaseOrphanListener", () => {
  it("idle stop with no releaseOrphanListener configured behaves exactly as before (no extra note)", async () => {
    const result = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, UNUSED_DEPS, writableGate());
    expect(result.text).toContain("No active debug session (nothing to stop).");
    expect(result.text).not.toMatch(/orphan/i);
  });

  it('reports "absent" as a quiet no-op — no extra note when nothing was found', async () => {
    const deps: DebugToolDeps = { ...UNUSED_DEPS, releaseOrphanListener: async () => ({ kind: "absent" }) };
    const result = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, deps, writableGate());
    expect(result.text).toContain("No active debug session (nothing to stop).");
    expect(result.text).not.toMatch(/orphan|released/i);
  });

  it('surfaces a "released" outcome in the stop response notes', async () => {
    const deps: DebugToolDeps = { ...UNUSED_DEPS, releaseOrphanListener: async () => ({ kind: "released" }) };
    const result = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, deps, writableGate());
    expect(result.text).toContain("Released a debug listener");
  });

  it('surfaces a "conflict" outcome with its detail text, without claiming release happened', async () => {
    const deps: DebugToolDeps = {
      ...UNUSED_DEPS,
      releaseOrphanListener: async () => ({ kind: "conflict", detail: "another IDE user is listening" }),
    };
    const result = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, deps, writableGate());
    expect(result.text).toContain("another IDE user is listening");
    expect(result.text).not.toContain("Released a debug listener");
  });

  it("a releaseOrphanListener that throws is reported, not left as an unhandled rejection", async () => {
    const deps: DebugToolDeps = {
      ...UNUSED_DEPS,
      releaseOrphanListener: async () => {
        throw new Error("network exploded");
      },
    };
    const result = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, deps, writableGate());
    expect(result.text).toContain("Orphaned-listener check failed");
    expect(result.text).toContain("network exploded");
  });

  it("a releaseOrphanListener that never settles is bounded by the stop timeout, not left hanging", async () => {
    const deps: DebugToolDeps = {
      ...UNUSED_DEPS,
      releaseOrphanListener: () => new Promise(() => {}), // never resolves
    };
    const result = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, deps, writableGate());
    expect(result.text).toContain("had not returned in time");
  }, 10_000);
});

describe("stop force:true — force-clears an orphaned ATTACHED debuggee via deps.releaseOrphanDebuggee (primary-defect regression)", () => {
  // Root cause under test: a crashed/killed process instance can leave SAP holding a debuggee
  // attachment with no in-process owner anywhere. `releaseOrphanListener` above only ever finds an
  // ARMED-BUT-UNCAUGHT listener — never a genuinely attached debuggee — so before
  // `releaseOrphanDebuggee` existed, that attachment had no discoverable recovery path at all:
  // every subsequent `abap_debug({action:"start"})` at the same identity failed with
  // "Debuggee already attached" forever. `force:true` is the deliberate, explicit-only escape
  // hatch: it must never run on a plain `stop` (an idle stop touches no other system — see the
  // comment above it in debug.ts), and it must surface a definitive outcome, not silently swallow
  // one, whichever of {absent, released, unknown, timeout, throw} `releaseOrphanDebuggee` reports.

  it("plain stop (no force) never invokes releaseOrphanDebuggee, even if configured", async () => {
    let called = false;
    const deps: DebugToolDeps = {
      ...UNUSED_DEPS,
      releaseOrphanDebuggee: async () => {
        called = true;
        return { kind: "released" };
      },
    };
    const result = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, deps, writableGate());
    expect(called).toBe(false);
    expect(result.text).not.toMatch(/debuggee/i);
  });

  it('force:true with no releaseOrphanDebuggee configured behaves exactly as a plain stop (no throw, no note)', async () => {
    const result = await abapDebug(
      DUMMY_CONN,
      { action: "stop", force: true } as DebugInput,
      60_000,
      UNUSED_DEPS,
      writableGate(),
    );
    expect(result.text).toContain("No active debug session (nothing to stop).");
    expect(result.text).not.toMatch(/debuggee/i);
  });

  it('force:true reports "absent" as a quiet no-op — no extra note when nothing was orphaned', async () => {
    const deps: DebugToolDeps = { ...UNUSED_DEPS, releaseOrphanDebuggee: async () => ({ kind: "absent" }) };
    const result = await abapDebug(
      DUMMY_CONN,
      { action: "stop", force: true } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );
    expect(result.text).not.toMatch(/force-terminated|force-clear/i);
  });

  it('force:true surfaces a "released" outcome in the stop response notes', async () => {
    const deps: DebugToolDeps = { ...UNUSED_DEPS, releaseOrphanDebuggee: async () => ({ kind: "released" }) };
    const result = await abapDebug(
      DUMMY_CONN,
      { action: "stop", force: true } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );
    expect(result.text).toContain("Force-terminated a debuggee attached at this server's identity");
  });

  it('force:true surfaces an "unknown" outcome with its detail text, without claiming release happened', async () => {
    const deps: DebugToolDeps = {
      ...UNUSED_DEPS,
      releaseOrphanDebuggee: async () => ({ kind: "unknown", detail: "getStack answered 503" }),
    };
    const result = await abapDebug(
      DUMMY_CONN,
      { action: "stop", force: true } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );
    expect(result.text).toContain("getStack answered 503");
    expect(result.text).not.toContain("Force-terminated a debuggee");
  });

  it("force:true with a releaseOrphanDebuggee that throws is reported, not left as an unhandled rejection", async () => {
    const deps: DebugToolDeps = {
      ...UNUSED_DEPS,
      releaseOrphanDebuggee: async () => {
        throw new Error("network exploded");
      },
    };
    const result = await abapDebug(
      DUMMY_CONN,
      { action: "stop", force: true } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );
    expect(result.text).toContain("Force-clear of an orphaned debuggee failed");
    expect(result.text).toContain("network exploded");
  });

  it("force:true with a releaseOrphanDebuggee that never settles is bounded, not left hanging forever", async () => {
    const deps: DebugToolDeps = {
      ...UNUSED_DEPS,
      releaseOrphanDebuggee: () => new Promise(() => {}), // never resolves
    };
    const result = await abapDebug(
      DUMMY_CONN,
      { action: "stop", force: true } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );
    expect(result.text).toContain("had not returned in time");
  }, 20_000);

  it("a releaseOrphanListener orphan-note and a releaseOrphanDebuggee force-clear note can BOTH appear together", async () => {
    const deps: DebugToolDeps = {
      ...UNUSED_DEPS,
      releaseOrphanListener: async () => ({ kind: "released" }),
      releaseOrphanDebuggee: async () => ({ kind: "released" }),
    };
    const result = await abapDebug(
      DUMMY_CONN,
      { action: "stop", force: true } as DebugInput,
      60_000,
      deps,
      writableGate(),
    );
    expect(result.text).toContain("Released a debug listener");
    expect(result.text).toContain("Force-terminated a debuggee attached at this server's identity");
  });
});

// ---------------------------------------------------------------------------
// D19 — `getVariables` OMITS requested ids, at HTTP 200, with nothing marking
//       the gap. THE evidence: `102-np-vars-negative` sent four <ID> elements
//       (LV_ZMCP_NEG, LV_ZMCP_NEGI, LV_GRAND_TOTAL, LT_ITEMS[1]-UNIT_PRICE) and
//       got TWO STPDA_ADT_VARIABLE rows back — no error, no per-id status. Its
//       twin `223-np-vars-negative` sent the SAME four ids and got all four, so
//       the pair isolates the omission from every other variable.
//
// Two failures follow from that, and both are asserted below against the real
// bytes rather than against a hand-written response:
//   1. the ids that came back with no row were DROPPED SILENTLY, and
//   2. `rows[0]` — position, not id — decided which row got rendered under the
//      caller's path, so asking for LT_ITEMS[1]-UNIT_PRICE rendered
//      LV_GRAND_TOTAL's 0.00 as if it were the answer.
//
// The row-window batch (`abap_debug_value` on a table) is the same shape one
// layer down: N ids out, fewer rows back.
// ---------------------------------------------------------------------------

/** Replays a captured `getVariables` response for the ROW-BATCH request against `name`, while the root read still resolves `name` as a table of `tableLines` rows. */
function liveRowsResponder(name: string, tableLines: number, capturedXml: string): ResponderEntry {
  return (opts: DebugRequestOptions): RawResponse => {
    if (opts.body?.includes(`${name}[`)) return okResponse(capturedXml);
    if (opts.body?.includes(name)) {
      return okResponse(buildVariablesXml([{ id: name, name, metaType: "table", tableLines }]));
    }
    throw new Error(`unexpected getVariables body: ${opts.body}`);
  };
}

describe("D19 — a requested variable id that comes back with no row is DISCLOSED, never dropped", () => {
  it("names the omitted id instead of quietly rendering some other row's value (102, real bytes)", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(
      log,
      HAPPY_TABLE({ getVariables: okResponse(live("102-np-vars-negative.xml")) }),
    );
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "D19a");

    const result = await abapDebugValue({ stateId, path: "LV_ZMCP_NEG" }, 60_000);

    // The omission is stated, and the id that went unanswered is named.
    expect(result.text).toContain("OMITTED:");
    expect(result.text).toContain("LV_ZMCP_NEG");
    expect(result.text).toContain("0 of the 1 variable id(s)");
    // ... and NOT one byte of another variable's value is rendered under this
    // path. 0.00 is LV_GRAND_TOTAL's value and 12.50 is LT_ITEMS[1]-UNIT_PRICE's;
    // `rows[0]` would have printed the first of those as LV_ZMCP_NEG's.
    expect(result.text).not.toContain("0.00");
    expect(result.text).not.toContain("12.50");
    // The debugger sent 1501 bytes. Claiming "0 bytes" would be a convenient lie.
    expect(result.text).not.toContain("0 bytes");
    // Exactly one getVariables round trip — no recovery attempt on a stateful session.
    expect(countOf(log, "getVariables")).toBe(1);
  }, 20_000);

  it("rows nobody requested are disclosed by id and never rendered as the answer (102, real bytes)", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(
      log,
      HAPPY_TABLE({ getVariables: okResponse(live("102-np-vars-negative.xml")) }),
    );
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "D19b");

    const result = await abapDebugValue({ stateId, path: "LV_ZMCP_NEG" }, 60_000);

    expect(result.text).toContain("UNREQUESTED:");
    expect(result.text).toContain("LV_GRAND_TOTAL");
    expect(result.text).toContain("LT_ITEMS[1]-UNIT_PRICE");
    expect(result.text).toContain("2 row(s) whose id was NOT");
  }, 20_000);

  it("matches on ID, not on array position: the row asked for is the row rendered (102, real bytes)", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(
      log,
      HAPPY_TABLE({ getVariables: okResponse(live("102-np-vars-negative.xml")) }),
    );
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "D19c");

    // LT_ITEMS[1]-UNIT_PRICE is the SECOND row of the capture. Positional
    // indexing renders the first (LV_GRAND_TOTAL, 0.00) under this path.
    const result = await abapDebugValue({ stateId, path: "LT_ITEMS[1]-UNIT_PRICE" }, 60_000);

    expect(result.text).toContain("12.50");
    expect(result.text).not.toContain("0.00");
    // Nothing was omitted here — the one id asked for was answered.
    expect(result.text).not.toContain("OMITTED:");
    // The one row the caller did not ask for is still surfaced, by id only.
    expect(result.text).toContain("UNREQUESTED:");
    expect(result.text).toContain("LV_GRAND_TOTAL");
  }, 20_000);

  it("picks the right row out of a FULL answer too — 223 returns all four ids (real bytes)", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(
      log,
      HAPPY_TABLE({ getVariables: okResponse(live("223-np-vars-negative.xml")) }),
    );
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "D19d");

    // 4th of 4 rows. `rows[0]` is LV_ZMCP_NEG, value "123.45-".
    const result = await abapDebugValue({ stateId, path: "LT_ITEMS[1]-UNIT_PRICE" }, 60_000);

    expect(result.text).toContain("12.50");
    expect(result.text).not.toContain("123.45");
    expect(result.text).not.toContain("OMITTED:");
  }, 20_000);

  it("a row-window batch that comes back short says so, with the row ids that went unanswered (102, real bytes)", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(
      log,
      // Root read: LT_ITEMS is a 4-row table (harness scaffolding). Row batch:
      // the captured short answer, verbatim.
      HAPPY_TABLE({ getVariables: liveRowsResponder("LT_ITEMS", 4, live("102-np-vars-negative.xml")) }),
    );
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "D19e");

    const result = await abapDebugValue({ stateId, path: "LT_ITEMS", from: 1, count: 4 }, 60_000);

    // Four row ids went out; the capture answers none of them.
    const rowFetch = transport.calls.find((c) => c.body?.includes("LT_ITEMS["));
    expect([...rowFetch!.body!.matchAll(/<ID>LT_ITEMS\[\d+\]<\/ID>/g)]).toHaveLength(4);

    expect(result.text).toContain("OMITTED:");
    expect(result.text).toContain("0 of the 4 variable id(s)");
    for (const n of [1, 2, 3, 4]) expect(result.text).toContain(`LT_ITEMS[${n}]`);
    // The renderer's in-window elide would otherwise present a REFUSED row as
    // merely not-yet-fetched, so the note must say "no row at all".
    expect(result.text).toContain("NO row at all");
    // The two rows the batch did return belonged to nobody's request.
    expect(result.text).toContain("UNREQUESTED:");
    expect(result.text).toContain("LV_GRAND_TOTAL");
    // Partial ≠ failure: this is still a normal response, and the empty-body
    // trap's "0 bytes" must not be claimed for a 1501-byte answer.
    expect(result.text).not.toContain("0 bytes");
    expect(result.truncated).toBe(false);
  }, 20_000);

  it("says NOTHING about omissions when every requested id is answered", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    // `tableResponder` echoes exactly the ids it was sent — the shape the wire
    // shows whenever the debugger can resolve them all (027, 223, 024).
    const transport = new FakeTransport(log, HAPPY_TABLE({ getVariables: tableResponder("LT_ITEMS", 3) }));
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "D19f");

    const result = await abapDebugValue({ stateId, path: "LT_ITEMS", count: 3 }, 60_000);
    expect(result.text).not.toContain("OMITTED:");
    expect(result.text).not.toContain("UNREQUESTED:");
  }, 20_000);
});

describe("D19 — the disclosure never truncates its own evidence silently", () => {
  it("clips a long omitted-id list with compact.ts's TRUNCATED idiom, naming the cut count (037, real 0-byte body)", async () => {
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(
      log,
      // 037-vars-out-of-range-row is a REAL zero-byte 200 answer to a
      // getVariables batch — the appliance's way of resolving nothing at all.
      HAPPY_TABLE({
        getVariables: liveRowsResponder("LT_ITEMS", 30, live("037-vars-out-of-range-row.txt")),
      }),
    );
    const deps = makeDeps({ log, transport, listener });
    const stateId = await startSuspended(deps, listener, "D19g");

    const result = await abapDebugValue({ stateId, path: "LT_ITEMS", from: 1, count: 30 }, 60_000);

    expect(result.text).toContain("OMITTED:");
    expect(result.text).toContain("0 of the 30 variable id(s)");
    // The note lists 25 ids and SAYS it stopped there.
    expect(result.text).toContain("[TRUNCATED: 25 of 30 id(s) listed, 5 cut]");
    expect(result.text).toContain("LT_ITEMS[25]");
    expect(result.text).not.toContain("LT_ITEMS[26]");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// M11 / M13 / M14 — `DebugSession`'s pool lease (`sessionLease`).
//
// `handleStart` (src/tools/debug.ts) now does, after all input validation and
// before building the client:
//   const slot = await deps.reserveDebugSession?.("debugger/listeners");
//   session = deps.createSession(slot?.conn ?? conn, gate, { ..., sessionLease: slot });
// and `DebugSession.doTerminate()` (src/debug/session.ts) releases that lease
// as the LAST act of its `finally`, after the session is already "dead" and
// de-registered from `activeSessions`.
//
// A REAL `AdtSessionPool` (src/adt/pool.js) is used throughout, over a stub
// connection factory — never a socket. The stub only carries the ONE field
// the pool itself reads off a connection (`.breaker`, for L3's shared-breaker
// check); nothing here ever calls a network method on it, because
// `makeDeps()`'s `createSession` (top of this file, patched to forward
// `sessionOpts.sessionLease`) always builds its `DebugClient` from the fake
// `DebugRequestIssuer`/`DebugListenIssuer` pair, exactly like every other
// test in this file. What these three blocks pin is the LIFECYCLE of the
// lease through `handleStart` -> `DebugSession` -> `doTerminate`, not the wire.
// ---------------------------------------------------------------------------

/** A syntactically valid config with the pool-sizing fields overridable. Never contacted. */
function debugCfg(over: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    url: "http://offline.invalid:50000",
    user: "TESTUSER",
    password: "never-used",
    ...over,
  });
}

/** The one field `AdtSessionPool` ever reads off a connection: `.breaker` (L3, src/adt/pool.ts). */
function stubConnFactory(): {
  create: (c: Config, o: ConnectionOptions) => AbapConnection;
  created: Array<{ n: number; breaker: AuthCircuitBreaker }>;
} {
  const created: Array<{ n: number; breaker: AuthCircuitBreaker }> = [];
  const create = (_c: Config, o: ConnectionOptions): AbapConnection => {
    const stub = { n: created.length, breaker: o.breaker };
    created.push(stub);
    return stub as unknown as AbapConnection;
  };
  return { create, created };
}

/**
 * Deterministic clock + timer wheel — same idiom as `test/pool.test.ts`'s own
 * `clock()` (private to that file, so re-declared here rather than imported).
 * Lets the M13 test below prove a refusal arrived with NO timer ever fired,
 * rather than a parked caller that merely happened to be released.
 */
function injectedClock(start = 1_000_000): {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  armed: () => number;
} {
  let t = start;
  interface Handle {
    at: number;
    fn: () => void;
  }
  const timers: Handle[] = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number): unknown => {
      const h: Handle = { at: t + ms, fn };
      timers.push(h);
      return h;
    },
    clearTimer: (h: unknown): void => {
      const i = timers.indexOf(h as Handle);
      if (i >= 0) timers.splice(i, 1);
    },
    /** How many timers are currently armed. */
    armed: (): number => timers.length,
  };
}

/** A real `AdtSessionPool` over stub connections. `clk`, if given, replaces `now`/`setTimer`/`clearTimer`. */
function makeTestPool(
  over: Partial<Config> = {},
  clk?: ReturnType<typeof injectedClock>,
): { pool: AdtSessionPool; created: Array<{ n: number; breaker: AuthCircuitBreaker }> } {
  const f = stubConnFactory();
  const pool = new AdtSessionPool({
    cfg: debugCfg(over),
    breaker: new AuthCircuitBreaker(),
    createConnection: f.create,
    ...(clk ? { now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer } : {}),
  });
  return { pool, created: f.created };
}

describe("M11 — DebugSession releases its pool lease as the LAST act of terminate, not never", () => {
  it("after a clean stop, the debug lease is free again: a second reserveDebugSession succeeds and pool.stats().busy returns to 0", async () => {
    const { pool } = makeTestPool();
    const log: string[] = [];
    const listener = new FakeListener(log);
    const transport = new FakeTransport(log, HAPPY_TABLE());
    const base = makeDeps({ log, transport, listener });
    const deps: DebugToolDeps = { ...base, reserveDebugSession: (op: string) => pool.reserveDebug(op) };

    await startSuspended(deps, listener, "M11a");
    // The session is alive and holding the lease: the pool shows one busy slot.
    expect(pool.stats().busy).toBe(1);

    const stopped = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, deps, writableGate());
    expect(stopped.text).toBeTruthy();

    // M11: if `sessionLease?.release()` were deleted from `doTerminate`'s
    // `finally` (src/debug/session.ts), the slot would stay busy forever and
    // BOTH assertions below would fail — the second reservation would be
    // refused `lease-held` and `busy` would stay 1.
    expect(pool.stats().busy).toBe(0);
    const second = await pool.reserveDebug("debugger/listeners");
    expect(second).toBeDefined();
    second.release();
  }, 20_000);
});

describe("M13 — the pool lease is held for the session's ENTIRE life, not released at the end of armListener", () => {
  it(
    "an ordinary pool.withRead is STILL refused lease-held after the session is armed and suspended, " +
      "on a pool pinned to maxSessions:1 so the debug lease is the ONLY slot and has no spare to fall back on " +
      "(no injected clock ever advanced — a refusal arriving at all proves refusal, not a drained queue)",
    async () => {
      // maxSessions:1 is pinned DELIBERATELY, not inherited from the schema
      // default. `blockedOnlyByDebugLease()` / `park()`'s `lease-held` refusal
      // (src/adt/pool.ts) only fires when the pool is FULL and everything
      // busy is a debug lease — i.e. `liveCount() >= maxSessions`. At the
      // shipped default (`maxSessions: 5` as of 2026-08-06, src/config.ts)
      // one busy debug slot leaves four spares, so `withRead` would simply
      // mint a second connection and SUCCEED instead of being refused — a
      // real behaviour change, not a bug, but not what this test exists to
      // prove. Pinning `maxSessions: 1` here keeps this test covering the
      // lease-held-with-no-spare-slot refusal path regardless of where the
      // shipped default drifts to next.
      const clk = injectedClock();
      const { pool } = makeTestPool({ maxSessions: 1 }, clk);
      const log: string[] = [];
      const listener = new FakeListener(log);
      const transport = new FakeTransport(log, HAPPY_TABLE());
      const base = makeDeps({ log, transport, listener });
      const deps: DebugToolDeps = { ...base, reserveDebugSession: (op: string) => pool.reserveDebug(op) };

      // Drives all the way through: breakpoints set, listener armed, trigger
      // fired, attach done, stack + variables read — i.e. well past the point
      // `armListener()` returned. The session is now "suspended".
      await startSuspended(deps, listener, "M13a");

      // THE MUTANT THIS KILLS, AND THE IMPORTANT ONE: releasing the lease at
      // the end of `armListener()` instead of at `doTerminate()` looks
      // IDENTICAL to a correct implementation in every other start/stop test
      // in this file — every one of them stays green either way, because none
      // holds the lease open past arming and then probes it. On the live A4H
      // appliance, though, a request issued on a session with an outstanding
      // long poll is head-of-line blocked for the REMAINDER of that poll —
      // measured at 55,402 ms behind a 60s listener ("cross-session
      // interference from a blocked listener"). A
      // released-too-early lease is a green offline suite today and a
      // multi-minute hang in production tomorrow.
      const refused = await pool
        .withRead("abap_read", async () => "must never run")
        .then(() => null)
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(SessionBusyError);
      expect((refused as SessionBusyError).reason).toBe("lease-held");
      // No timer was ever armed for this refusal, and the clock was never
      // advanced — the rejection is synchronous, not a queue that drained.
      expect(clk.armed()).toBe(0);

      const stopped = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, deps, writableGate());
      expect(stopped.text).toBeTruthy();
    },
    20_000,
  );
});

describe("M14 — handleStart builds the debug client on the LEASED slot's connection, not the caller's", () => {
  it(
    "at maxSessions:2 the debug lease's connection is a DIFFERENT object than the caller's own " +
      "connection, and createSession receives the LEASED one (reference equality)",
    async () => {
      // maxSessions:2 matters: at the shipped maxSessions:1 the caller's
      // connection and the debug lease's connection are the SAME object (the
      // one pinned primary slot), so `slot?.conn ?? conn` and plain `conn`
      // are indistinguishable and this mutant would go unnoticed. Holding the
      // primary slot busy with an in-flight read forces `reserveDebug` to
      // mint a genuinely SECOND connection, so the two can never coincide.
      const { pool, created } = makeTestPool({ maxSessions: 2 });

      const log: string[] = [];
      const listener = new FakeListener(log);
      const transport = new FakeTransport(log, HAPPY_TABLE());
      const base = makeDeps({ log, transport, listener });

      let capturedConn: AbapConnection | undefined;
      let slotConn: AbapConnection | undefined;
      const deps: DebugToolDeps = {
        ...base,
        createSession(conn, safety, opts) {
          capturedConn = conn;
          return base.createSession(conn, safety, opts);
        },
        reserveDebugSession: async (op: string) => {
          const slot = await pool.reserveDebug(op);
          slotConn = slot.conn;
          return slot;
        },
      };

      // Hold the primary slot busy on an ordinary read so `reserveDebug`
      // cannot reuse it and must construct a second, distinct connection.
      let releasePrimary!: () => void;
      const primaryGate = new Promise<void>((res) => {
        releasePrimary = res;
      });
      const primaryHeld = pool.withRead("hold-primary", async () => primaryGate);
      await flushMicrotasks();

      const callerConn = {} as unknown as AbapConnection; // distinct from anything the pool made
      const promise = abapDebug(callerConn, START_INPUT, 60_000, deps, writableGate());
      await flushMicrotasks();
      listener.resolveWith(okResponse(buildDebuggeeXml("M14a")));
      await promise;

      // Sanity: the trick above actually forced a second connection — the
      // debug lease's connection is NOT the primary/pinned one.
      expect(created.length).toBeGreaterThanOrEqual(2);
      expect(slotConn).not.toBe(pool.primary());

      // THE ASSERTION THAT MATTERS: createSession was built on the LEASED
      // slot's connection, never on the caller's own connection. The long
      // poll reads its cookie jar and CSRF token from that connection, so
      // holding a lease on session B while polling on session A's cookies
      // would protect the wrong session. Reversing `slot?.conn ?? conn` to
      // `conn ?? slot?.conn` would flip this silently whenever both are
      // defined — exactly this test's setup.
      expect(capturedConn).toBe(slotConn);
      expect(capturedConn).not.toBe(callerConn);

      const stopped = await abapDebug(DUMMY_CONN, { action: "stop" } as DebugInput, 60_000, deps, writableGate());
      expect(stopped.text).toBeTruthy();
      releasePrimary();
      await primaryHeld;
    },
    20_000,
  );
});
