/**
 * Portions derived from vibing-steampunk — `pkg/adt/debugger.go`'s
 * `convertToClassPool` (`handlers_debugger.go:170-200`, ported below as
 * `toClassPool`), `DebuggerStepWithBatch`'s 4-operation batch recipe (ported
 * below as `stepWithBatch`, REWRITTEN: the original always returns
 * `variables: nil` and swallows both parse errors — see `decodeBatchPart`),
 * and the `handleDebuggerGetVariables` `@ROOT`→`getChildVariables` reroute
 * (ported below as `getRootVariables`, and extended for the live-verified
 * two-hop scope-index behaviour that vsp never encountered).
 * Copyright (c) 2025-2026 Alice Vinogradova and contributors, MIT.
 * See THIRD-PARTY-NOTICES.md.
 */

/**
 * Debugger client: one method per SAP debugger operation, composing
 * endpoints.ts (URL) → xml-request.ts (body) → transport.ts (request) →
 * xml-response.ts (parse). No state, retries, or timers of its own — that
 * belongs to the session layer above.
 *
 * Two exceptions still count as "pure composition": `getRootVariables()` and
 * `stepWithBatch()` each make a fixed, data-driven sequence of HTTP calls
 * (never an open-ended loop or retry), and `terminateDebuggee()` unwraps one
 * SAP wire quirk (a 500 that IS success for that one operation).
 *
 * FORBIDDEN: `/sap/bc/adt/debugger/variables/{name}/{part}` endpoints
 * (`variableDataUrl`/`variableSubcomponentsUrl`/etc., see endpoints.ts) are
 * broken on this release — live testing found they destroy the HTTP and
 * debug session. Every variable read here goes through
 * `getVariables`/`getChildVariables` with path-addressed ids instead.
 *
 * Offline-only: all network I/O goes through the two constructor-injected
 * collaborators (`DebugRequestIssuer`, `DebugListenIssuer`), narrow
 * structural interfaces so tests can supply plain fakes.
 */
import { createHash, randomUUID } from "node:crypto";
import { AbapError, isAbapError } from "../adt/errors.js";
import { truncateDiagnosticBody } from "../truncate.js";
import {
  BATCH_ACCEPT,
  BATCH_CONTENT_TYPE_PREFIX,
  BREAKPOINTS_ACCEPT,
  BREAKPOINTS_CONTENT_TYPE,
  CANARY_VARIABLE_ID,
  DEBUGGER_DISPATCH_PATH,
  GET_CHILD_VARIABLES_ACCEPT,
  GET_CHILD_VARIABLES_CONTENT_TYPE,
  GET_VARIABLES_ACCEPT,
  GET_VARIABLES_CONTENT_TYPE,
  LISTENER_ACCEPT,
  ROOT_VARIABLE_ID,
  STACK_EMODE,
  TERMINAL_ID_LENGTH,
  assertValidTerminalId,
  attachUrl,
  batchUrl,
  breakpointsPostUrl,
  buildUrl,
  deleteBreakpointUrl,
  getChildVariablesUrl,
  getStackUrl,
  getVariablesUrl,
  listenerGetUrl,
  listenerLaunchUrl,
  listenerStopUrl,
  setDebuggerSettingsUrl,
  setStackPositionUrl,
  setVariableValueUrl,
  stepUrl,
  terminateDebuggeeUrl,
  type AttachParams,
  type DeleteBreakpointParams,
  type ListenerGetParams,
  type ListenerLaunchParams,
  type ListenerStopParams,
  type StackQueryParams,
  type StepParams,
} from "./endpoints.js";
import { buildBreakpointsRequestXml, buildGetChildVariablesXml, buildGetVariablesXml } from "./xml-request.js";
import {
  parseAdtError,
  parseAttachResponse,
  parseBatchResponse,
  parseBreakpointsResponse,
  parseChildVariablesResponse,
  parseDebuggeeResponse,
  parseSettingsResponse,
  parseStackResponse,
  parseStepResponse,
  parseVariablesResponse,
} from "./xml-response.js";
import type { DebugRequestOptions, LongPollHandle } from "./transport.js";
import type {
  AdtError,
  BatchOperation,
  BatchResult,
  Breakpoint,
  BreakpointError,
  BreakpointsRequest,
  ChildVariablesResult,
  CreatedBreakpoint,
  DebugAttachResult,
  DebugSettings,
  DebugStack,
  DebugStackType,
  DebugStepKind,
  DebugStepResult,
  DebugVariable,
  DebugVariableHierarchy,
  ListenResult,
  ListenerConflict,
  RawResponse,
} from "./types.js";

// Re-exported so callers of this module don't also need a direct import from
// types.ts just to name a breakpoint kind or a step kind.
export type { Breakpoint, BreakpointsRequest, DebugStepKind };

// Collaborator interfaces — structural shape of DebugTransport/DebugLongPollClient; tests supply plain fakes.

export interface DebugRequestIssuer {
  request(opts: DebugRequestOptions): Promise<RawResponse>;
}

export interface DebugListenIssuer {
  listen(
    path: string,
    opts?: { qs?: Record<string, string>; headers?: Record<string, string>; signal?: AbortSignal },
  ): LongPollHandle;
  /** Client-side abort deadline (ms), if the issuer exposes one (real `DebugLongPollClient` does; test fakes may not). */
  readonly clientAbortTimeoutMs?: number;
}

export interface DebugClientOptions {
  transport: DebugRequestIssuer;
  longPoll: DebugListenIssuer;
  /** Non-fatal diagnostics sink; defaults to stderr (stdout is the MCP transport). Used by `setDebuggerSettings` when the server's echo is missing/unreadable. */
  warn?: (msg: string) => void;
}

// attach/step/stack/setStackPosition/terminateDebuggee all answer plain XML — no shared constant exists for this family elsewhere.
const DBG_XML_ACCEPT = "application/xml";
const DBG_XML_CONTENT_TYPE = "application/xml";

/**
 * `@ROOT` case-folded for comparison: scope pseudo-ids (`@…`) are fixed
 * tokens and may be case-folded, but ordinary variable-id paths must never
 * be (e.g. `LT_MAP['abc']`).
 */
const ROOT_SCOPE_ID_UPPER = ROOT_VARIABLE_ID.trim().toUpperCase();

// toClassPool — ported from prior-art, then verified against a live fixture.

/**
 * Padded width before the `CP` suffix. Verified against a live fixture
 * (`ZMCP_DBG_RUN` → `MAIN_PROGRAM=ZMCP_DBG_RUN==================CP`, 30+2=32
 * chars) — see the git history.
 */
const CLASS_POOL_NAME_WIDTH = 30;
const CLASS_POOL_SUFFIX = "CP";

/**
 * Class breakpoints target the class-pool program name, not the class name.
 * Ported from the reference implementation's `convertToClassPool`, cross-checked against a live
 * fixture. Uppercases, right-pads with `=` to 30 chars, appends `CP`; throws
 * rather than truncating if the name is too long.
 */
export function toClassPool(className: string): string {
  const upper = className.trim().toUpperCase();
  if (upper.length === 0) {
    throw new AbapError("BAD_INPUT", "toClassPool requires a non-empty class name.");
  }
  if (upper.length > CLASS_POOL_NAME_WIDTH) {
    throw new AbapError(
      "BAD_INPUT",
      `toClassPool: class name "${className}" is ${upper.length} characters long; a class-pool ` +
        `program name requires it to fit within ${CLASS_POOL_NAME_WIDTH} characters.`,
      { className, length: upper.length },
    );
  }
  return upper.padEnd(CLASS_POOL_NAME_WIDTH, "=") + CLASS_POOL_SUFFIX;
}

// resolveTerminalId — deterministic, stable, never random per call.

/**
 * Resolve the 32-char `SYSUUID_C32` terminal id. Must be stable for the
 * server's lifetime and IDENTICAL between breakpoint-setting and listening
 * (the id itself is the server-side correlation key — see
 * `IDE_ID_CONSISTENCY_NOTE` in types.ts). `opts.explicit` (e.g.
 * `ABAP_TERMINAL_ID`) wins when present; otherwise a deterministic
 * `sha256(seed)` digest, same pattern as `run.ts`'s `bridgeClassName`. Pure
 * function — callers must compute once and hold the result for the session.
 */
export function resolveTerminalId(opts: { explicit?: string; seed: string }): string {
  const explicit = opts.explicit?.trim();
  if (explicit) {
    assertValidTerminalId(explicit, "resolveTerminalId's explicit override");
    return explicit;
  }
  const hex = createHash("sha256").update(opts.seed, "utf8").digest("hex").slice(0, TERMINAL_ID_LENGTH).toUpperCase();
  assertValidTerminalId(hex, "resolveTerminalId's derived id"); // defensive; always exactly 32 by construction
  return hex;
}

// Listener result types not already covered by ListenResult (types.ts).

/**
 * An empty long-poll body always means the server hold genuinely expired —
 * live capture disproved the old belief that a colliding request on the same
 * session could end the poll early (it's head-of-line blocked behind it
 * instead). The wire can't say whether a collision happened at all; only
 * DebugSession knows that and reports it separately as `timeout`/`blocked`.
 */
export type ListenOutcome =
  | Extract<ListenResult, { kind: "debuggee" | "conflict" }>
  | { kind: "empty" };

export interface ListenHandle {
  /** Resolves once the long-poll request is dispatched — see `LongPollHandle.armed` in transport.ts. */
  armed: Promise<void>;
  /** Caught debuggee, conflict, or empty (server hold expired — see `ListenOutcome`). Always settles. */
  result: Promise<ListenOutcome>;
  abort: () => void;
  readonly aborted: boolean;
}

/**
 * `getListener`'s result — deliberately not `ListenResult` (types.ts), which
 * models the blocking long-poll's outcomes. This is the non-blocking status
 * GET: `exists`/`absent` in the query branch, `conflict`/`clear` when
 * `checkConflict` is set.
 */
export type ListenerCheckResult =
  | { kind: "exists" }
  | { kind: "absent" }
  | { kind: "clear" }
  | { kind: "conflict"; conflict: ListenerConflict };

function looksLikeExceptionEnvelope(body: string): boolean {
  return /<exc:exception[\s>]/i.test(body) || /<exception[\s>]/i.test(body);
}

/**
 * Targeted parser for the listener conflict envelope's `conflictText`/
 * `ideUser` fields — xml-response.ts has no dedicated parser for this shape,
 * only the generic `parseAdtError` (subtype only). Two regexes over a known
 * `<entry key="...">` shape; a candidate to move into xml-response.ts later.
 */
function parseListenerConflictBody(body: string): ListenerConflict {
  const conflictTextMatch = /<entry\s+key="conflictText"[^>]*>([^<]*)<\/entry>/i.exec(body);
  const ideUserMatch = /<entry\s+key="ideUser"[^>]*>([^<]*)<\/entry>/i.exec(body);
  const parsed = parseAdtError(body, 200, "");
  return {
    conflictText: (conflictTextMatch?.[1] ?? parsed.message).trim(),
    ideUser: ideUserMatch?.[1]?.trim() || undefined,
    subType: parsed.subtype,
  };
}

/** Empty body → hold expired naturally (see `ListenOutcome`); exception envelope → conflict; otherwise a caught debuggee. */
function parseListenResult(raw: RawResponse): ListenOutcome {
  if (raw.body.trim() === "") return { kind: "empty" };
  if (looksLikeExceptionEnvelope(raw.body)) {
    return { kind: "conflict", conflict: parseListenerConflictBody(raw.body) };
  }
  return { kind: "debuggee", debuggee: parseDebuggeeResponse(raw.body) };
}

// Batch — per-sub-request outcome type. Failures are visible, never flattened to success (see `BatchResult` in types.ts).

export type BatchStepPart<T> = { ok: true; value: T } | { ok: false; error: AdtError };

export interface StepWithBatchResult {
  step: BatchStepPart<DebugStepResult>;
  stack: BatchStepPart<DebugStack>;
  rootVariables: BatchStepPart<ChildVariablesResult>;
  canary: BatchStepPart<DebugVariable[]>;
}

export interface RootVariablesResult {
  /**
   * Which of the three genuinely different "empty-ish" outcomes this is — an
   * empty `variables` alone is ambiguous and must never be read as "this frame
   * simply has no variables".
   *
   * - `no-scopes` — hop 1 returned zero usable scope handles (the debugger
   *   reported no scopes AT ALL, or every handle it reported was blank or a
   *   self-reference). Almost certainly a fault, NOT an empty frame: every live
   *   frame has at least `@GLOBALS`.
   * - `empty-scopes` — hop 1 gave scopes but hop 2 returned zero variables.
   * - `enumerated` — a real enumeration; hop 2 returned at least one variable.
   */
  outcome: "enumerated" | "no-scopes" | "empty-scopes";
  /** The scope pseudo-variables under `@ROOT` — e.g. `@GLOBALS`, and inside a method frame also `@PARAMETERS`/`@LOCALS`. */
  scopes: DebugVariableHierarchy[];
  /** Every real local variable, one level below the scope ids (the second round trip). */
  variables: ChildVariablesResult;
}

export interface TerminateResult {
  /** Always `true` when this resolves — a 500 with `subtype=terminateDebuggee` IS success and is unwrapped into this, never thrown. */
  terminated: true;
}

export interface SetStackPositionParams {
  /**
   * 1-based, matching `DebugStackFrame.stackPosition` on the wire (confirmed
   * by `stack.xml`) — an earlier CLI wrongly compares the 0-based array index
   * instead. Do not renumber before calling.
   */
  stackPosition: number;
  stackType: DebugStackType;
}

function buildMultipartBatchBody(operations: readonly BatchOperation[], boundary: string): string {
  const parts = operations.map((op) => {
    const headerLines = [`${op.method} ${op.path} HTTP/1.1`];
    if (op.contentType) headerLines.push(`Content-Type: ${op.contentType}`);
    if (op.accept) headerLines.push(`Accept: ${op.accept}`);
    const httpRequest = `${headerLines.join("\r\n")}\r\n\r\n${op.body ?? ""}`;
    return `--${boundary}\r\nContent-Type: application/http\r\ncontent-transfer-encoding: binary\r\n\r\n${httpRequest}\r\n`;
  });
  return `${parts.join("")}--${boundary}--\r\n`;
}

function decodeBatchPart<T>(result: BatchResult, path: string, parse: (body: string) => T): BatchStepPart<T> {
  if (result.status >= 400) {
    return { ok: false, error: parseAdtError(result.body, result.status, path) };
  }
  try {
    return { ok: true, value: parse(result.body) };
  } catch (e) {
    // A parse failure on an otherwise-2xx sub-response is a real failure, not
    // something to swallow (an earlier DebuggerStepWithBatch does) — represented
    // the same shape as a status failure so callers check one thing.
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: { status: result.status, message, path, bodyExcerpt: truncateDiagnosticBody(result.body) } };
  }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class DebugClient {
  private readonly transport: DebugRequestIssuer;
  private readonly longPoll: DebugListenIssuer;
  private readonly warn: (msg: string) => void;

  constructor(opts: DebugClientOptions) {
    this.transport = opts.transport;
    this.longPoll = opts.longPoll;
    this.warn = opts.warn ?? ((m: string) => process.stderr.write(m + "\n"));
  }

  /** Forwards the long-poll issuer's client-side abort deadline, for callers (e.g. `DebugSession`) validating it against the server-side listener hold. `undefined` for fakes lacking the accessor. */
  longPollAbortTimeoutMs(): number | undefined {
    return this.longPoll.clientAbortTimeoutMs;
  }

  // --- Breakpoints -----------------------------------------------------

  async setBreakpoints(
    request: BreakpointsRequest,
    opts: { checkConflict?: boolean } = {},
  ): Promise<Array<CreatedBreakpoint | BreakpointError>> {
    const raw = await this.transport.request({
      method: "POST",
      path: breakpointsPostUrl({ checkConflict: opts.checkConflict }),
      headers: { "Content-Type": BREAKPOINTS_CONTENT_TYPE, Accept: BREAKPOINTS_ACCEPT },
      body: buildBreakpointsRequestXml(request),
    });
    return parseBreakpointsResponse(raw.body);
  }

  async deleteBreakpoint(params: DeleteBreakpointParams): Promise<void> {
    await this.transport.request({ method: "DELETE", path: deleteBreakpointUrl(params) });
  }

  // --- Listeners -------------------------------------------------------

  /**
   * Blocking long-poll. Returns a handle immediately without awaiting the
   * result, so the caller can await `armed`, wait, then trigger the debuggee.
   */
  launchListener(params: ListenerLaunchParams): ListenHandle {
    const handle = this.longPoll.listen(listenerLaunchUrl(params), { headers: { Accept: LISTENER_ACCEPT } });
    const result = handle.result.then(parseListenResult);
    // HAZARD: this derived promise is returned but may not be awaited at the
    // moment the long poll rejects in the background. An unobserved rejection
    // raises Node's `unhandledRejection` and can kill the whole MCP server
    // process, not just the debug session. Marking it observed does NOT swallow
    // the error: `catch` returns a NEW promise which we deliberately discard, so
    // anyone awaiting `result` still receives the original rejection unchanged.
    // Do not "simplify" this line away. (`armed` / `abort` are passed through
    // from the transport untouched — already handled there.)
    void result.catch(() => {});
    return {
      armed: handle.armed,
      result,
      abort: handle.abort,
      get aborted() {
        return handle.aborted;
      },
    };
  }

  async stopListener(params: ListenerStopParams): Promise<void> {
    await this.transport.request({ method: "DELETE", path: listenerStopUrl(params) });
  }

  /** Non-blocking status check — semantics of `checkConflict` are INVERTED between branches, see `ListenerGetParams`'s doc comment in `endpoints.ts`. */
  async getListener(params: ListenerGetParams): Promise<ListenerCheckResult> {
    let raw: RawResponse;
    try {
      raw = await this.transport.request({ method: "GET", path: listenerGetUrl(params) });
    } catch (e) {
      // "No listener registered" is an ADT-shaped 404 only: the transport drops
      // `status`/`subtype` on NOT_FOUND, leaving `abapType` as the sole
      // discriminator. `abapType === "ExceptionResourceNotFound"` → absent;
      // `undefined` → a transport fault (wrong URL/proxy) and must rethrow.
      if (isAbapError(e) && e.code === "NOT_FOUND" && e.details?.["abapType"] !== undefined) {
        return { kind: "absent" };
      }
      throw e;
    }
    if (raw.body.trim() === "") {
      return params.checkConflict ? { kind: "clear" } : { kind: "exists" };
    }
    // Undocumented outside checkConflict=true, but any non-empty body is
    // treated as a conflict rather than silently discarded.
    return { kind: "conflict", conflict: parseListenerConflictBody(raw.body) };
  }

  // --- Attach / step / terminate --------------------------------------

  async attach(params: AttachParams): Promise<DebugAttachResult> {
    // Session-lifecycle note: a 500 with subtype=invalidDebuggee ("Debuggee
    // already attached") means "double attach — ignore". This method doesn't
    // swallow it itself; it surfaces the AbapError for the session layer to classify.
    const raw = await this.transport.request({
      method: "POST",
      path: attachUrl(params),
      headers: { Accept: DBG_XML_ACCEPT },
    });
    return parseAttachResponse(raw.body);
  }

  /**
   * Any `DebugStepKind`, including `terminateDebuggee` (excluding it from
   * the MCP tool layer is a separate decision). Prefer `terminateDebuggee()`
   * to actually end a session — it unwraps the success-shaped 500 that this
   * method would otherwise throw on.
   */
  async step(params: StepParams): Promise<DebugStepResult> {
    const raw = await this.transport.request({
      method: "POST",
      path: stepUrl(params),
      headers: { Accept: DBG_XML_ACCEPT },
    });
    return parseStepResponse(raw.body);
  }

  /**
   * `POST ?method=terminateDebuggee`. HTTP 500 with
   * `subtype=terminateDebuggee` IS success — ending a session surfaces from
   * the ADI layer as `CX_TPDA_SYS_COMM_DBGSESSIONEND` — unwrapped here into
   * an always-successful `TerminateResult`.
   */
  async terminateDebuggee(): Promise<TerminateResult> {
    try {
      await this.transport.request({
        method: "POST",
        path: terminateDebuggeeUrl(),
        headers: { Accept: DBG_XML_ACCEPT },
      });
      return { terminated: true };
    } catch (e) {
      // subtype alone isn't enough: accept {terminated:true} only when status is
      // undefined, 2xx, or 5xx (500 is the confirmed live success shape). Reject
      // (rethrow) 3xx/4xx even with a matching subtype — the request was
      // refused, so the debuggee is still alive holding a dialog work process.
      if (isAbapError(e) && e.details?.["subtype"] === "terminateDebuggee") {
        const rawStatus = e.details?.["status"];
        // non-number status treated as absent (→ accepted), never coerced
        const status = typeof rawStatus === "number" ? rawStatus : undefined;
        const accepted = status === undefined || (status >= 200 && status < 300) || (status >= 500 && status < 600);
        if (accepted) return { terminated: true };
      }
      throw e;
    }
  }

  // --- Stack -------------------------------------------------------------

  async getStack(params: StackQueryParams = {}): Promise<DebugStack> {
    const raw = await this.transport.request({
      method: "GET",
      path: getStackUrl({ emode: params.emode ?? STACK_EMODE, semanticURIs: params.semanticURIs ?? true }),
      headers: { Accept: DBG_XML_ACCEPT },
    });
    return parseStackResponse(raw.body);
  }

  /**
   * Wire shape verified live: `POST .../debugger?method=setStackPosition&position={n}`
   * — 1-based `position`, no `stackType`, no body (the previous
   * stackType/stackPosition form was rejected by the server). CAVEAT: the
   * call succeeds but was not observed to actually move the debug cursor —
   * see the git history. `params.stackType` stays on
   * the API surface but is deliberately not sent.
   */
  async setStackPosition(params: SetStackPositionParams): Promise<void> {
    if (!Number.isInteger(params.stackPosition) || params.stackPosition < 1) {
      throw new AbapError(
        "BAD_INPUT",
        `setStackPosition: stackPosition is 1-based (see SetStackPositionParams's doc comment); got ${params.stackPosition}.`,
        { stackPosition: params.stackPosition },
      );
    }
    const url = setStackPositionUrl(params.stackPosition);
    await this.transport.request({ method: "POST", path: url, headers: { Accept: DBG_XML_ACCEPT } });
  }

  // --- Variables -----------------------------------------------------

  /** Batch of path-addressed variable ids, e.g. `["SY-SUBRC", "LT_ITEMS[1]-MATNR"]`. Never use the forbidden `/variables/{name}/{part}` family — see this file's header. */
  async getVariables(variableIds: readonly string[]): Promise<DebugVariable[]> {
    const raw = await this.transport.request({
      method: "POST",
      path: getVariablesUrl(),
      headers: { "Content-Type": GET_VARIABLES_CONTENT_TYPE, Accept: GET_VARIABLES_ACCEPT },
      body: buildGetVariablesXml(variableIds),
    });
    return parseVariablesResponse(raw.body);
  }

  /**
   * Batch of parent ids to expand, e.g. `["LT_ITEMS[1]"]` or `["LS_ITEM"]`.
   * `@ROOT` is rejected — see the guard below. Scope pseudo-ids
   * (`@GLOBALS`/`@LOCALS`/`@PARAMETERS`) are accepted like any other parent.
   */
  async getChildVariables(parentIds: readonly string[]): Promise<ChildVariablesResult> {
    if (parentIds.length === 0) {
      throw new AbapError(
        "BAD_INPUT",
        "getChildVariables requires at least one parent id; an empty batch has no meaning on the wire.",
        { count: 0 },
      );
    }
    const normalised = parentIds.map((rawId, index) => {
      const id = rawId.trim();
      if (id.length === 0) {
        throw new AbapError(
          "BAD_INPUT",
          `getChildVariables: parentIds[${index}] is empty (or only whitespace); every parent id must name a variable.`,
          { index, parentId: rawId },
        );
      }
      // Only `@…` pseudo-tokens are fixed and may be case-folded; variable-id
      // paths must never be, since they can carry case-sensitive keys like `LT_MAP['abc']`.
      const isRootScope = id.toUpperCase() === ROOT_SCOPE_ID_UPPER;
      if (isRootScope) {
        // `@ROOT` is a scope INDEX, not a frame of variables — the server
        // answers 200 with an empty `<VARIABLES/>`, which would misreport the
        // scope as empty (and silently no-op in a mixed batch). Rejected
        // outright rather than partially honoured; @GLOBALS/@LOCALS/@PARAMETERS
        // remain legitimate parents.
        throw new AbapError(
          "BAD_INPUT",
          `getChildVariables: "${ROOT_SCOPE_ID_UPPER}" (parentIds[${index}], given as "${id}") is a scope INDEX, not an ` +
            `expandable parent — expanding it returns zero variables and would misreport the frame as empty. ` +
            `Call getRootVariables() instead to enumerate every local (it resolves the scope index and expands it), ` +
            `or from the tool layer abap_debug_vars({scope:…}).`,
          { index, parentId: id },
        );
      }
      return id;
    });
    return this.requestChildVariables(normalised);
  }

  /** Wire half of `getChildVariables`, with no `@ROOT` guard — hop 1 of `getRootVariables` needs to expand `@ROOT` legitimately. */
  private async requestChildVariables(parentIds: readonly string[]): Promise<ChildVariablesResult> {
    const raw = await this.transport.request({
      method: "POST",
      path: getChildVariablesUrl(),
      headers: { "Content-Type": GET_CHILD_VARIABLES_CONTENT_TYPE, Accept: GET_CHILD_VARIABLES_ACCEPT },
      body: buildGetChildVariablesXml(parentIds),
    });
    return parseChildVariablesResponse(raw.body);
  }

  /**
   * `@ROOT` is a scope index, not a frame of variables: expanding it returns
   * zero variables plus a `HIERARCHIES` list of scope ids (`@GLOBALS`, and in
   * a method frame also `@PARAMETERS`/`@LOCALS`). Enumerating "every local"
   * is genuinely two round trips — resolve the scope index, then expand every
   * scope id — fixed, data-driven composition, not a retry loop.
   */
  async getRootVariables(): Promise<RootVariablesResult> {
    // Hop 1: the private helper, since the public getChildVariables rejects @ROOT.
    const scopeLevel = await this.requestChildVariables([ROOT_VARIABLE_ID]);
    const scopeIds = [
      ...new Set(
        scopeLevel.hierarchies
          .map((h) => h.childId.trim())
          // Drop blanks and any self-referencing handle (would re-ask @ROOT on hop 2).
          .filter((id) => id.length > 0 && id.toUpperCase() !== ROOT_SCOPE_ID_UPPER),
      ),
    ];
    if (scopeIds.length === 0) {
      return { outcome: "no-scopes", scopes: scopeLevel.hierarchies, variables: { hierarchies: [], variables: [] } };
    }
    const variables = await this.requestChildVariables(scopeIds);
    return {
      outcome: variables.variables.length === 0 ? "empty-scopes" : "enumerated",
      scopes: scopeLevel.hierarchies,
      variables,
    };
  }

  async setVariableValue(variableName: string, value: string): Promise<void> {
    await this.transport.request({
      method: "POST",
      path: setVariableValueUrl(variableName),
      headers: { Accept: DBG_XML_ACCEPT },
      body: value,
    });
  }

  // --- Settings ------------------------------------------------------

  /**
   * Returns the settings the SERVER SAYS IT APPLIED (the POST response's own
   * `<dbg:settings>` echo), not the requested ones — callers used to assert
   * against a later STEP response's settings snapshot, which is not a
   * contract and broke in a live run. Request body shape is inferred (no
   * xml-request.ts builder exists for it) from the same element seen on
   * attach/step responses.
   *
   * A missing/unparseable echo warns and falls back to returning `settings`
   * as given, rather than throwing — by the time the body is read, the 2xx
   * has already been accepted and the mutation applied server-side.
   */
  async setDebuggerSettings(settings: DebugSettings): Promise<DebugSettings> {
    const b = (v: boolean): string => (v ? "true" : "false");
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<dbg:settings xmlns:dbg="http://www.sap.com/adt/debugger" ` +
      `systemDebugging="${b(settings.systemDebugging)}" ` +
      `createExceptionObject="${b(settings.createExceptionObject)}" ` +
      `backgroundRFC="${b(settings.backgroundRFC)}" ` +
      `sharedObjectDebugging="${b(settings.sharedObjectDebugging)}" ` +
      `showDataAging="${b(settings.showDataAging)}" ` +
      `updateDebugging="${b(settings.updateDebugging)}"/>`;
    const raw = await this.transport.request({
      method: "POST",
      path: setDebuggerSettingsUrl(),
      headers: { "Content-Type": DBG_XML_CONTENT_TYPE, Accept: DBG_XML_ACCEPT },
      body,
    });
    if (!raw.body || raw.body.trim() === "") {
      this.warn(
        `[setDebuggerSettings] server returned an EMPTY body where a <dbg:settings> echo was expected; ` +
          `returning the requested settings unverified.`,
      );
      return settings;
    }
    try {
      return parseSettingsResponse(raw.body);
    } catch (e) {
      this.warn(
        `[setDebuggerSettings] could not parse the server's settings echo (${(e as Error).message}); ` +
          `returning the requested settings unverified.`,
      );
      return settings;
    }
  }

  // --- Batch -----------------------------------------------------------

  /**
   * General batch primitive: one multipart POST, one `BatchResult` per
   * sub-operation in order, each carrying its own status.
   *
   * UNVERIFIED live: `/debugger/batch` itself was flagged "not probed" during
   * the live spike. Treat as needing one careful, disposable-session probe
   * before depending on it for anything destructive.
   */
  async runBatch(operations: readonly BatchOperation[]): Promise<BatchResult[]> {
    if (operations.length === 0) {
      throw new AbapError("BAD_INPUT", "runBatch requires at least one operation.");
    }
    const boundary = `batch_${randomUUID()}`;
    const raw = await this.transport.request({
      method: "POST",
      path: batchUrl(),
      headers: { "Content-Type": `${BATCH_CONTENT_TYPE_PREFIX}; boundary=${boundary}`, Accept: BATCH_ACCEPT },
      body: buildMultipartBatchBody(operations, boundary),
    });
    const results = parseBatchResponse(raw.body);
    // parseBatchResponse silently skips any non-`application/http` part, which
    // would shift every later part's index — positional decoding is only sound
    // when the counts match.
    if (results.length !== operations.length) {
      throw new AbapError(
        "ADT_ERROR",
        `runBatch: batch part-count mismatch — expected ${operations.length} sub-response(s), got ${results.length}. ` +
          `Sub-responses are mapped to operations BY POSITION, so a mismatched count means no result can be ` +
          `trusted to belong to the operation it appears to answer.`,
        { expected: operations.length, actual: results.length, batchArity: true },
      );
    }
    return results;
  }

  /**
   * `DebuggerStepWithBatch`, ported and rewritten: the reference implementation's version always
   * returns `variables: nil` and swallows parse errors; here each of the four
   * sub-results is decoded independently via `decodeBatchPart`, so a failure
   * in one is visible on that part alone.
   *
   * The four operations (verbatim from the Eclipse capture): step, getStack,
   * `getChildVariables(["@ROOT"])`, `getVariables(["SY-SUBRC"])` (canary).
   * `rootVariables` here is the single `@ROOT` call only — full two-hop local
   * enumeration is the separate `getRootVariables()`.
   */
  async stepWithBatch(step: DebugStepKind, uri?: string): Promise<StepWithBatchResult> {
    const stepOp: BatchOperation = { method: "POST", path: stepUrl({ step, uri }) };
    const stackOp: BatchOperation = {
      method: "POST",
      path: buildUrl(DEBUGGER_DISPATCH_PATH, { method: "getStack", emode: STACK_EMODE, semanticURIs: true }),
    };
    const rootOp: BatchOperation = {
      method: "POST",
      path: getChildVariablesUrl(),
      contentType: GET_CHILD_VARIABLES_CONTENT_TYPE,
      accept: GET_CHILD_VARIABLES_ACCEPT,
      body: buildGetChildVariablesXml([ROOT_VARIABLE_ID]),
    };
    const canaryOp: BatchOperation = {
      method: "POST",
      path: getVariablesUrl(),
      contentType: GET_VARIABLES_CONTENT_TYPE,
      accept: GET_VARIABLES_ACCEPT,
      body: buildGetVariablesXml([CANARY_VARIABLE_ID]),
    };

    // DOUBLE-STEP HAZARD: by the time a batch response fails to parse into the
    // right number of parts, the step sub-request has already run on the
    // debuggee. Retrying this call would step it a second time.
    let results: BatchResult[];
    try {
      results = await this.runBatch([stepOp, stackOp, rootOp, canaryOp]);
    } catch (e) {
      if (isAbapError(e) && e.details?.["batchArity"] === true) {
        throw new AbapError(
          "ADT_ERROR",
          `stepWithBatch: ${e.message} THE STEP HAS ALREADY EXECUTED on the debuggee — DO NOT RETRY this call: ` +
            `retrying would step the debuggee a SECOND time. Call getStack() to resynchronise with the debuggee's ` +
            `actual position instead.`,
          { ...e.details, stepExecuted: true, retrySafe: false },
        );
      }
      throw e;
    }
    if (results.length !== 4) {
      throw new AbapError(
        "ADT_ERROR",
        `stepWithBatch: expected 4 batch sub-responses, got ${results.length}. THE STEP HAS ALREADY EXECUTED on the ` +
          `debuggee — DO NOT RETRY this call: retrying would step the debuggee a SECOND time. Call getStack() to ` +
          `resynchronise with the debuggee's actual position instead.`,
        { count: results.length, stepExecuted: true, retrySafe: false },
      );
    }
    const [stepResult, stackResult, rootResult, canaryResult] = results as [
      BatchResult,
      BatchResult,
      BatchResult,
      BatchResult,
    ];

    return {
      step: decodeBatchPart(stepResult, stepOp.path, parseStepResponse),
      stack: decodeBatchPart(stackResult, stackOp.path, parseStackResponse),
      rootVariables: decodeBatchPart(rootResult, rootOp.path, parseChildVariablesResponse),
      canary: decodeBatchPart(canaryResult, canaryOp.path, parseVariablesResponse),
    };
  }
}
