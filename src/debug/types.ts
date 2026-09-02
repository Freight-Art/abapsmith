/**
 * Debugger module — every type that crosses an `src/debug/*` module boundary.
 * `import type` only, zero runtime code; `endpoints.ts`, `xml-request.ts`,
 * `xml-response.ts` and `transport.ts` share these shapes from here alone.
 *
 * Portions derived from vibing-steampunk (`pkg/adt/debugger.go`,
 * `pkg/adt/debugger_test.go`), Copyright (c) 2025-2026 Alice Vinogradova
 * and contributors, MIT. See THIRD-PARTY-NOTICES.md. Corrected against
 * SAP's own shipped source wherever the two disagree.
 *
 * See the doc comments on `ListenResult`, `Breakpoint` and `AdtError` for
 * design decisions frozen against the reference implementation, and why.
 */

// ---------------------------------------------------------------------------
// Enumerations shared across every debugger call
// ---------------------------------------------------------------------------

/**
 * `debuggingMode="terminal"` requires BOTH `terminalId` and `ideId`; `"user"`
 * requires `requestUser`.
 *
 * `"terminal"` IS MODELLED BUT IS NOT A WORKING ROUTE — measured 2026-08-02:
 * a terminal-scope listener arms and shows up in `ABDBG_LISTENER` but never
 * catches a debuggee (0/7 cells) against a same-run user-scope control that
 * caught in 527 ms. Kept in the union because the wire protocol has it, not
 * because anything here should select it. Full measurement:
 * the git history.
 */
export type DebuggingMode = "user" | "terminal";

/** `external` breakpoints persist across sessions; `debugger` is session-bound. */
export type DebuggerScope = "external" | "debugger";

export type DebugStepKind =
  | "stepInto"
  | "stepOver"
  | "stepReturn"
  | "stepContinue"
  | "stepRunToLine"
  | "stepJumpToLine"
  | "terminateDebuggee";

export type DebugStackType = "ABAP" | "DYNP" | "ENHANCEMENT";
export type DebugStackSourceType = "ABAP" | "DYNP" | "ST";

/**
 * `META_TYPE` on a `DebugVariable`. Scalar-like (cannot expand): `simple |
 * string | boxedcomp | anonymcomp | unknown`; everything else — including
 * future server-added values — counts as complex (`IsComplexType`). Treat as
 * open-ended; do not write an exhaustive switch that throws on the unknown.
 */
export type DebugMetaType =
  | "simple"
  | "string"
  | "boxedcomp"
  | "anonymcomp"
  | "unknown"
  | "structure"
  | "table"
  | "dataref"
  | "objectref"
  | "class"
  | "object"
  | "boxref";

/**
 * ABAP-flag boolean convention on the wire: the `asx:abap` family
 * (`getVariables`, `getChildVariables`, listener/debuggee body) uses
 * `"X"`/`""`; the `dbg:` family (attach/step/stack) uses `"true"`/`"false"`.
 * Never appears in a typed value below — `xml-response.ts` normalises to
 * `boolean` before anything here sees it.
 */
export type XBool = "X" | "";

/**
 * Shared query-parameter context for the non-breakpoint debugger endpoints
 * (listeners, attach, step, stack, variables).
 */
export interface DebugContext {
  debuggingMode: DebuggingMode;
  /**
   * Client-chosen, exactly 32 uppercase hex characters — wire type
   * `SYSUUID_C32`. Use `uuidv1().replace(/-/g,"").toUpperCase()`
   * (`vscode_abap_remote_fs`'s approach); a naive generator underfills to
   * 15-20 chars and relies on `to_c32` silently padding it.
   */
  terminalId: string;
  ideId: string;
  /** Mandatory when `debuggingMode` is `"user"`; not checked in `"terminal"` mode. */
  requestUser?: string;
}

// ---------------------------------------------------------------------------
// Breakpoints
// ---------------------------------------------------------------------------

/**
 * Fields shared by every breakpoint kind. `kind` is the only attribute the
 * server's XSLT emits unconditionally. `id` is server-assigned-only (never
 * send it on creation); `validationOnly` is compared case-insensitively
 * against the literal string `"true"` server-side, NOT an XML boolean —
 * `"X"`/`"1"` do not work.
 */
interface BreakpointCommon {
  /** Server-assigned; required for `DELETE`, omit when building a request. */
  id?: string;
  /** Correlation id that round-trips through a sync (declared elsewhere but never serialised). */
  clientId?: string;
  /** "Break on the *n*th hit" (declared elsewhere but never emitted). */
  skipCount?: number;
  /** ABAP boolean expression, XML-escaped by `xml-request.ts` — never build this string by hand (the reference implementation does not escape it). */
  condition?: string;
  /** Validate without registering — the safe first probe for any new breakpoint kind. */
  validationOnly?: boolean;
}

export interface LineBreakpoint extends BreakpointCommon {
  kind: "line";
  /**
   * The ONLY way to target a line breakpoint: a single `adtcore:uri`
   * carrying a `#start=<line>` fragment — no separate include/line
   * attributes, and `#start=L,C;end=L,C` is not accepted (the server
   * discards anything after the comma).
   *
   * The server may rewrite this to the nearest valid statement and return a
   * corrected URI in the response — a caller must read it back and report
   * the correction rather than assume the request was honoured verbatim.
   */
  uri: string;
}

export interface ExceptionBreakpoint extends BreakpointCommon {
  kind: "exception";
  exceptionClass: string;
}

export interface StatementBreakpoint extends BreakpointCommon {
  kind: "statement";
  /** A value from `/sap/bc/adt/debugger/breakpoints/statements`. */
  statement: string;
}

export interface MessageBreakpoint extends BreakpointCommon {
  kind: "message";
  msgId: string;
  /** Message number — an earlier implementation emits only `msgId`+`msgTy` and omits this, so it cannot target a specific message. */
  msgNo: string;
  /** A value from `/sap/bc/adt/debugger/breakpoints/messagetypes`. */
  msgTy: string;
}

/**
 * Discriminated on `kind`, covering ONLY the four kinds the wire protocol
 * actually supports. The reference implementation declares eight (also `badi`, `enhancement`,
 * `watchpoint`, `method`) but its XML builder has no `case` for those four —
 * an empty `<dbg:breakpoints/>` is POSTed, SAP silently accepts it, and the
 * caller is told it succeeded. Modelling only the real four makes that
 * failure mode unrepresentable instead of merely undocumented.
 */
export type Breakpoint = LineBreakpoint | ExceptionBreakpoint | StatementBreakpoint | MessageBreakpoint;

/** A breakpoint as echoed back by the server after a successful POST. */
export type CreatedBreakpoint = Breakpoint & { id: string };

/**
 * The server refused a breakpoint and said why, via an `errorMessage`
 * attribute on the response row. A naive parser silently drops these rows —
 * the caller cannot tell "SAP refused this" from "SAP created it and didn't
 * echo it". This type exists so `xml-response.ts` has somewhere to put that
 * message instead of discarding it.
 */
export interface BreakpointError {
  kind: string;
  clientId?: string;
  errorMessage: string;
}

/** The root `<dbg:breakpoints>` request. Built by `xml-request.ts`, never by hand. */
export interface BreakpointsRequest {
  debuggingMode: DebuggingMode;
  scope: DebuggerScope;
  requestUser?: string;
  terminalId?: string;
  ideId?: string;
  systemDebugging?: boolean;
  deactivated?: boolean;
  /**
   * Omit unless deliberately synchronising a scope — omission is legal and
   * is the non-destructive default. `mode:"full"` with no `objectUri`
   * deletes every OTHER external breakpoint on the same call — this is
   * `abap-adt-api`'s dangerous default, which we do not repeat.
   */
  syncScope?: { mode: "partial" | "full"; objectUri?: string };
  breakpoints: Breakpoint[];
}

// ---------------------------------------------------------------------------
// Listener / debuggee
// ---------------------------------------------------------------------------

export type DebuggeeKind = "debuggee" | "postmortem" | "postmortem_dialog";

/** What a caught listener (or a post-mortem short dump) gives you. */
export interface Debuggee {
  /** The handle passed to `attach`. */
  id: string;
  kind: DebuggeeKind;
  client: number;
  terminalId: string;
  ideId: string;
  user: string;
  /** `PRG_CURR` — the program where execution stopped. */
  program: string;
  /** `INCL_CURR`. */
  include: string;
  /** `LINE_CURR`. */
  line: number;
  rfcDest?: string;
  applServer?: string;
  sysId?: string;
  sysNr?: number;
  timestamp?: number;
  /** Normalised from the wire's negative flag: `IS_ATTACH_IMPOSSIBLE !== "X"`. Always false for a post-mortem debuggee. */
  isAttachable: boolean;
  /** Server-affinity warning: an HTTP request may land on a different application server than the one the debuggee is on. */
  isSameServer: boolean;
  instanceName?: string;
  /** Present only when `kind` is `"postmortem"` / `"postmortem_dialog"`. */
  dumpId?: string;
  dumpDate?: string;
  dumpTime?: string;
  dumpHost?: string;
  dumpUser?: string;
  dumpClient?: string;
  dumpUri?: string;
}

/** An active listener registered by someone else. */
export interface ListenerConflict {
  conflictText: string;
  ideUser?: string;
  /**
   * `com.sap.adt.communicationFramework.subType` from the `<exc:exception>`
   * envelope — the only safe way to recognise a conflict. An earlier
   * implementation substring-matches the literal word "conflict" in a formatted error
   * string that can carry up to 165 KB of arbitrary body text; not repeated here.
   */
  subType?: string;
}

/**
 * A tagged union, not the reference implementation's three nullable fields (`Debuggee *Debuggee,
 * Conflict *ListenerConflict, TimedOut bool`), whose zero value — all three
 * unset — is a reachable, meaningless fourth state.
 *
 * Covers both listener operations under one result type:
 *   - `"debuggee"` / `"conflict"` — either listen call caught something.
 *   - `"timeout"` — the bounded long-poll (`POST .../listeners`) elapsed with
 *     nobody caught: HTTP 200, empty body. Normal, expected outcome.
 *   - `"none"` — the non-blocking check (`GET .../listeners`) found no active
 *     listener and no conflict: HTTP 404 when `checkConflict` is
 *     absent/false, or HTTP 200 empty when `checkConflict=true`.
 */
export type ListenResult =
  | { kind: "debuggee"; debuggee: Debuggee }
  | { kind: "conflict"; conflict: ListenerConflict }
  | { kind: "timeout" }
  | { kind: "none" };

// ---------------------------------------------------------------------------
// Attach / step / settings / actions
// ---------------------------------------------------------------------------

export interface DebugSettings {
  systemDebugging: boolean;
  createExceptionObject: boolean;
  backgroundRFC: boolean;
  sharedObjectDebugging: boolean;
  showDataAging: boolean;
  updateDebugging: boolean;
}

/**
 * An entry in `<dbg:actions>`. `link` is a relative ADT URL
 * (`/sap/bc/adt/debugger/actions{?action,value}`) that no known client
 * invokes — reading `actions` off an attach/step response is currently the
 * only way to discover what is toggleable mid-session (system debugging,
 * non-exclusive, ABAP trace).
 */
export interface DebugAction {
  name: string;
  style: string;
  group: string;
  title: string;
  link: string;
  value: boolean | string;
  disabled: boolean;
}

export interface DebugReachedBreakpoint {
  id: string;
  kind: string;
  unresolvableCondition?: string;
  unresolvableConditionErrorOffset?: string;
}

/** Fields common to both the attach and step responses. */
export interface DebugSessionState {
  isRfc: boolean;
  isSameSystem: boolean;
  serverName: string;
  debugSessionId: string;
  processId: number;
  isPostMortem: boolean;
  /** Tells you up front whether `setVariableValue` will work. */
  isUserAuthorizedForChanges: boolean;
  debuggeeSessionId: string;
  abapTraceState: string;
  /** The feature-detection hook for the paginated ITAB (CSV) endpoints. */
  canAdvancedTableFeatures: boolean;
  isNonExclusive: boolean;
  isNonExclusiveToggled: boolean;
  guiEditorGuid: string;
  sessionTitle: string;
  /** Check before offering step tools. */
  isSteppingPossible: boolean;
  isTerminationPossible: boolean;
  actions: DebugAction[];
}

export interface DebugAttachResult extends DebugSessionState {
  reachedBreakpoints: DebugReachedBreakpoint[];
}

export interface DebugStepResult extends DebugSessionState {
  isDebuggeeChanged: boolean;
  settings: DebugSettings;
  reachedBreakpoints: DebugReachedBreakpoint[];
}

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

export interface DebugStackFrame {
  stackPosition: number;
  stackType: DebugStackType;
  stackUri: string;
  programName: string;
  includeName: string;
  line: number;
  eventType: string;
  eventName: string;
  sourceType: DebugStackSourceType;
  /** The compaction lever — filter these out of the stack before it reaches the model. */
  systemProgram: boolean;
  isVit: boolean;
  /** Not every frame carries a resolvable source URI — absent on some system frames (see `stack.xml`'s second entry). */
  uri?: string;
}

export interface DebugStack {
  isRfc: boolean;
  isSameSystem: boolean;
  serverName: string;
  debugCursorStackIndex?: number;
  frames: DebugStackFrame[];
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

/**
 * A row from `getVariables`/`getChildVariables`. `READ_ONLY`,
 * `IS_VALUE_INCOMPLETE` and `IS_EXCEPTION` arrive on the wire as `XBool`;
 * normalised to real booleans here by `xml-response.ts`'s parser.
 */
export interface DebugVariable {
  id: string;
  name: string;
  declaredTypeName: string;
  actualTypeName: string;
  kind: string;
  instantiationKind: string;
  accessKind: string;
  metaType: DebugMetaType;
  parameterKind: string;
  value: string;
  hexValue: string;
  readOnly: boolean;
  technicalType: string;
  length: number;
  /** ID of the table-body pseudo-variable. */
  tableBody: string;
  /** Row count. */
  tableLines?: number;
  /** `true` ⇒ SAP already truncated `value` for you; go to the `maxLength`/`csv` sub-resource for the rest. */
  isValueIncomplete: boolean;
  isException: boolean;
  inheritanceLevel: number;
  inheritanceClass: string;
}

/** An edge in `getChildVariables`'s `HIERARCHIES` list — the only thing attributing a child to its parent when batching. */
export interface DebugVariableHierarchy {
  parentId: string;
  childId: string;
  childName: string;
}

/**
 * `getChildVariables`'s full response. Envelope depth trap: `getVariables`
 * returns `<DATA><STPDA_ADT_VARIABLE>` directly, while this call nests
 * `<DATA><HIERARCHIES>…<VARIABLES><STPDA_ADT_VARIABLE>…</DATA>` — same row
 * type, different nesting. A single generic parser silently returns `[]` for
 * one of the two; `variables.xml` and `child-variables.xml` are the fixtures
 * that catch this.
 */
export interface ChildVariablesResult {
  hierarchies: DebugVariableHierarchy[];
  variables: DebugVariable[];
}

/**
 * Opaque key scoping variable IDs to exactly one stop state:
 * `sha256(debugSessionId, stackPosition, program, line, stepCounter)`. A
 * request/response carrying a stale `StateId` must be rejected with the
 * current state named, never silently answered against a different one —
 * deliberately no frameId auto-recovery, which would answer a different
 * question than the one asked.
 */
export type StateId = string;

// ---------------------------------------------------------------------------
// Batch endpoint
// ---------------------------------------------------------------------------

/** One sub-request inside a `multipart/mixed` POST to `/sap/bc/adt/debugger/batch`. */
export interface BatchOperation {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path plus query string, e.g. `"/sap/bc/adt/debugger?method=stepOver"`. */
  path: string;
  contentType?: string;
  accept?: string;
  body?: string;
}

/**
 * One sub-response, boundary-parsed out of the batch reply. `status` MUST be
 * the sub-response's own status — an earlier parser hardcodes `StatusCode: 200`
 * for every part, making sub-request failures invisible, and also advances
 * by a fixed offset even on a shorter boundary match, truncating bodies.
 * Neither defect is repeated here.
 */
export interface BatchResult {
  status: number;
  contentType?: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Raw HTTP (transport boundary)
// ---------------------------------------------------------------------------

/** The generic shape of a single raw HTTP response, before any debugger-specific parsing. */
export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A structured ADT-level error, parsed from the raw `<exc:exception>`
 * envelope of a debugger request. **Never string-match on `.message`** —
 * an earlier implementation's `APIError.Message` is `string(body)`, up to 165 KB, and its
 * retry/discrimination logic substring-matches that blob. Discriminate on
 * `status` and `subtype` only.
 *
 * Deliberately a NEW type, not a reuse of `AdtExceptionInfo`
 * (`src/adt/session.ts`, which normalises an exception `abap-adt-api` has
 * already parsed — this module bypasses that wrapping and talks to
 * `conn.h.request(...)` directly) or `AbapError` (`src/adt/errors.ts`, the
 * existing tool-boundary type every other module translates into via
 * `translateAdtError`). `AdtError` is this module's pre-translation shape;
 * it is expected to grow its own `translateDebugError` into `AbapError`,
 * reusing `AbapErrorCode` rather than inventing a rival union. That
 * translator lives elsewhere, not in this file.
 */
export interface AdtError {
  status: number;
  /** `com.sap.adt.communicationFramework.subType` — the safe discriminator for conflicts and session state. */
  subtype?: string;
  /** The ABAP exception class, e.g. `ExceptionResourceNoAccess` (`<type id="…">`). */
  abapType?: string;
  message: string;
  /** The request path that produced this error. */
  path: string;
  /**
   * Truncated response body — never the full payload (bodies can be up to
   * 165 KB; redirect raw ADT bodies to disk, never into model context).
   *
   * **Display/logging only, never a discrimination predicate.** On the
   * `abap-adt-api` path it isn't even the body (that library discards the
   * response object once it parses an `<exc:exception>`, so this falls back
   * to message text). Decisions must key on `status`/`subtype`/`abapType`/
   * `exceptionClassNames`, all extracted from the full body at parse time.
   */
  bodyExcerpt: string;
  /**
   * ABAP exception class names lifted from `<exc:exception>` properties
   * (`…ExceptionClassName`), upper-cased and de-duplicated — the
   * LANGUAGE-INDEPENDENT discriminator: a message is localised, a class name
   * is not (`CX_TPDA_SYS_COMM_DBGSESSIONEND` in every logon language). See
   * `isSessionExpired` in `xml-response.ts`.
   */
  exceptionClassNames?: readonly string[];
}

/**
 * Discrimination predicates, declared here as exported function TYPES only.
 * Implementations live in `xml-response.ts` next to `parseAdtError`;
 * `transport.ts` re-exports them rather than keeping a second copy. Every
 * caller uses these instead of `includes()`/`Contains()` on `.message`.
 */
export type IsConflict = (e: AdtError) => boolean;
export type IsSessionExpired = (e: AdtError) => boolean;
export type IsNoSessionAttached = (e: AdtError) => boolean;
