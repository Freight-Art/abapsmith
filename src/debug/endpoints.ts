/**
 * Portions derived from vibing-steampunk (pkg/adt/debugger.go),
 * Copyright (c) 2025-2026 Alice Vinogradova and contributors, MIT.
 * See THIRD-PARTY-NOTICES.md.
 */

/**
 * Debugger endpoint / constant table — one auditable place for every URL,
 * query parameter, content type and magic constant the debugger layer knows
 * about, each carrying a citation (live-verified against A4H, read from
 * shipped ABAP/XSLT, or lower-confidence prior art from an earlier implementation or Eclipse capture).
 * Live-verified findings win on conflict.
 *
 * **Most exports here have no caller, by design** — this is the full
 * endpoint surface, not just the wired-up subset. An unreferenced constant
 * is a recorded finding (e.g. `VARIABLE_PART`, tried and rejected), not dead
 * code; do not tree-shake this module against its call sites. See
 * the git history for why this note exists.
 *
 * Pure functions/constants only — no HTTP, state, or I/O; only import is
 * `import type` from `./types.js`. Follows the `src/adt/discovery.ts` /
 * `src/adt/resolve.ts` house style: small named exports plus one audit table
 * (`DEBUGGER_ENDPOINTS`).
 */
import type { DebugContext, DebugStepKind, DebuggerScope, DebuggingMode } from "./types.js";

// ============================================================================
// 1. Debugging-mode / scope / sync-scope enumerations
// ============================================================================

/** Verbatim from `CL_TPDA_ADT_RES_BREAKPOINTS` lines 71-81. Runtime companion to the `DebuggingMode` union in `./types.ts` (which is `import type` only). */
export const DEBUGGING_MODE = {
  /** `c_dbgmode_user`. Requires `requestUser`. */
  USER: "user",
  /** `c_dbgmode_terminal`. Requires BOTH `terminalId` AND `ideId`. */
  TERMINAL: "terminal",
} as const satisfies Record<string, DebuggingMode>;

/** `c_scope_external` / `c_scope_debugger`. */
export const DEBUGGER_SCOPE = {
  /** Persists across sessions, user- or terminal-keyed. */
  EXTERNAL: "external",
  /** Session-bound (set per attached thread once a debuggee is caught). */
  DEBUGGER: "debugger",
} as const satisfies Record<string, DebuggerScope>;

/** `c_bpkind_*` — the four kinds the wire protocol supports. See `./types.ts`'s `Breakpoint` union doc for why the other four (`badi`/`enhancement`/`watchpoint`/`method`) aren't modelled. */
export const BREAKPOINT_KIND = {
  LINE: "line",
  STATEMENT: "statement",
  EXCEPTION: "exception",
  MESSAGE: "message",
} as const;

/**
 * `c_syncmode_*`. Omitting `<syncScope>` is legal and the safe default.
 * Never default to `"full"`: with no `objectUri` it deletes every OTHER
 * external breakpoint the user has (this is `abap-adt-api`'s dangerous default).
 */
export const SYNC_SCOPE_MODE = {
  NONE: "",
  PARTIAL: "partial",
  FULL: "full",
} as const;

// ============================================================================
// 2. Base paths (the 16 debugger collections from discovery)
// ============================================================================

export const DEBUGGER_BASE_PATH = "/sap/bc/adt/debugger";

/**
 * `GET` → 405 (not a nested service document — empty `<templateLinks/>`).
 * This is the POST method-dispatch endpoint for the whole debug session:
 * `attach`, `getStack`, `getVariables`, `getChildVariables`, `setVariableValue`,
 * `setDebuggerSettings`, `setStackPosition` and every step type are all
 * `POST /sap/bc/adt/debugger?method=…`, never separate sub-paths.
 *
 * `attach` appears nowhere in the discovery document (zero hits in 165 KB).
 * Do NOT gate attach availability on `Discovery.supports("debugger")` —
 * that only proves the debugger collections exist, not that `attach` works.
 */
export const DEBUGGER_DISPATCH_PATH = DEBUGGER_BASE_PATH;

export const DEBUGGER_BREAKPOINTS_PATH = `${DEBUGGER_BASE_PATH}/breakpoints`;
/** GET → legal `statement` values for a `kind="statement"` breakpoint. */
export const DEBUGGER_BREAKPOINTS_STATEMENTS_PATH = `${DEBUGGER_BREAKPOINTS_PATH}/statements`;
/** GET → the 6 legal `msgTy` values (`A`/`E`/`I`/`S`/`W`/`X`) for a `kind="message"` breakpoint. */
export const DEBUGGER_BREAKPOINTS_MESSAGETYPES_PATH = `${DEBUGGER_BREAKPOINTS_PATH}/messagetypes`;
/** GET → 200/0 B with no parameters on this system. Parameterisation UNKNOWN — not probed further. */
export const DEBUGGER_BREAKPOINTS_CONDITIONS_PATH = `${DEBUGGER_BREAKPOINTS_PATH}/conditions`;
/** GET → 200/0 B with no parameters on this system. Parameterisation UNKNOWN. */
export const DEBUGGER_BREAKPOINTS_VALIDATIONS_PATH = `${DEBUGGER_BREAKPOINTS_PATH}/validations`;
/** VIT (includes) breakpoint sub-resource. "No other query parameter is read on POST except the /vit path discriminator" — the discriminator's exact shape was not probed; treat as UNKNOWN beyond the path itself. */
export const DEBUGGER_BREAKPOINTS_VIT_PATH = `${DEBUGGER_BREAKPOINTS_PATH}/vit`;

/**
 * **NOT a list endpoint.** `GET` reads only the `condition` URI attribute and
 * bails if empty — a `200`/0-byte response is expected and says nothing about
 * registered breakpoints. There is no read-only endpoint that lists external
 * breakpoints (a "breakpoints aren't persisted" panic in an earlier
 * implementation traced back to misreading this exact response). Track what you set client-side.
 */
export const DEBUGGER_BREAKPOINTS_CONDITION_VALIDATOR_PATH = DEBUGGER_BREAKPOINTS_PATH;

export const DEBUGGER_LISTENERS_PATH = `${DEBUGGER_BASE_PATH}/listeners`;
export const DEBUGGER_VARIABLES_PATH = `${DEBUGGER_BASE_PATH}/variables`;
export const DEBUGGER_ACTIONS_PATH = `${DEBUGGER_BASE_PATH}/actions`;

/**
 * The dedicated, VERIFIED-reachable stack resource: `GET
 * /debugger/stack` with nothing attached → `500` `AdiFailed` /
 * `noSessionAttached` — proof the ADI layer is live, not an error to retry.
 */
export const DEBUGGER_STACK_PATH = `${DEBUGGER_BASE_PATH}/stack`;

export const DEBUGGER_BATCH_PATH = `${DEBUGGER_BASE_PATH}/batch`;
export const DEBUGGER_SYSTEMAREAS_PATH = `${DEBUGGER_BASE_PATH}/systemareas`;

// ============================================================================
// 3. Query-string construction — the ONE place this module builds a query
//    string, so the sap-client rule below has exactly one place to hold.
// ============================================================================

export type QueryValue = string | number | boolean | undefined;
/** A value or an RFC 6570 EXPLODED list (`components=A&components=B`, never comma-joined — per the `csv` rel's `components*`). */
export type QueryParams = Record<string, QueryValue | QueryValue[]>;

/**
 * Serialise query parameters. Refuses (throws on) a `sap-client`/`sapClient`
 * key rather than silently dropping it — appending `sap-client` to an ADT URL
 * returns the ICF logon-failed HTML page and burns a logon attempt
 * (project-wide rule; see an earlier `buildURL` for the bug this avoids).
 */
export function buildQuery(params: QueryParams): string {
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(params)) {
    if (isSapClientKey(key)) {
      throw new Error(
        `buildQuery: refusing to append "${key}" — appending sap-client to an ADT URL returns the ICF ` +
          "logon-failed HTML page and burns a logon attempt. " +
          "Client selection happens at the session/cookie layer, never in a debugger query string.",
      );
    }
    if (raw === undefined) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const v of values) {
      if (v === undefined) continue;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

function isSapClientKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_]/g, "");
  return k === "sapclient";
}

/** Validate/normalise an ADT path before it's concatenated with a query string: rejects absolute URLs, embedded `?`/`#`, control chars, and `.`/`..` traversal. Error messages are prefixed `buildUrl: ` to distinguish from `buildQuery`'s. */
export function assertValidAdtPath(path: string): string {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error(`buildUrl: path must be a non-empty string — got ${JSON.stringify(path)}.`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.\-]*:/.test(path) || path.startsWith("//")) {
    throw new Error(
      `buildUrl: path must not be an absolute URL — got "${path}". This module only ever builds paths ` +
        "relative to the ADT server; scheme/host selection happens at the HTTP-client layer, never here.",
    );
  }
  if (path.includes("?")) {
    throw new Error(
      `buildUrl: path must not contain a query string — got "${path}". Query params must go through the ` +
        "params argument so they are encoded by buildQuery, not hand-concatenated onto path.",
    );
  }
  if (path.includes("#")) {
    throw new Error(
      `buildUrl: path must not contain a fragment — got "${path}". A "#start=N" fragment belongs in the ` +
        "uri query VALUE (see withStartFragment), not in path itself.",
    );
  }
  if (/[\\\s\x00-\x1f\x7f]/.test(path)) {
    throw new Error(
      `buildUrl: path must not contain a backslash, whitespace or control character — got "${path}".`,
    );
  }
  let normalised = path.startsWith("/") ? path : `/${path}`;
  while (normalised.length > 1 && normalised.endsWith("/")) {
    normalised = normalised.slice(0, -1);
  }
  const segments = normalised.split("/");
  if (segments.some((s) => s === "." || s === "..")) {
    throw new Error(`buildUrl: path must not contain a traversal segment ("." or "..") — got "${path}".`);
  }
  if (normalised !== "/sap/bc/adt" && !normalised.startsWith("/sap/bc/adt/")) {
    throw new Error(
      `buildUrl: path must equal "/sap/bc/adt" or start with "/sap/bc/adt/" — got "${normalised}".`,
    );
  }
  return normalised;
}

/** `path` plus a `buildQuery`-built query string. Callers should never concatenate `?`/`&` by hand. */
export function buildUrl(path: string, params?: QueryParams): string {
  const normalised = assertValidAdtPath(path);
  return params ? `${normalised}${buildQuery(params)}` : normalised;
}

// ============================================================================
// 4. Breakpoints — POST / DELETE / condition-validator GET
// ============================================================================

export interface BreakpointsPostQuery {
  /** Server reads this as a case-insensitive substring test for `t`/`T`, not a real boolean comparison — pass `true`/`"true"` for clarity, don't rely on the looseness. */
  checkConflict?: boolean;
}

/** `POST /sap/bc/adt/debugger/breakpoints{?checkConflict}`. Body is built by M2 — this only builds the URL. */
export function breakpointsPostUrl(query: BreakpointsPostQuery = {}): string {
  return buildUrl(DEBUGGER_BREAKPOINTS_PATH, { checkConflict: query.checkConflict });
}

export interface DeleteBreakpointParams {
  /** Server-assigned id, returned by the POST — never invent one. Structured (e.g. `KIND=0.SOURCETYPE=ABAP...`) — URI-encoded as a path segment here. */
  id: string;
  scope: DebuggerScope;
  debuggingMode: DebuggingMode;
  requestUser?: string;
  terminalId?: string;
  ideId?: string;
}

/**
 * `DELETE .../breakpoints/{urlencoded-id}{?scope,debuggingMode,requestUser,terminalId,ideId}`
 * — one breakpoint per call. Mode-dependent mandatory params mirror
 * `CL_TPDA_ADT_RES_BREAKPOINTS->init_static`: terminal mode requires BOTH
 * `terminalId` and `ideId`; user mode requires `requestUser`.
 *
 * **KNOWN DEFECT, live-verified 2026-08-01**: this exact param set (user mode,
 * `terminalId`/`ideId` omitted) was rejected by A4H with 400
 * `ExceptionParameterNotFound` on 5/5 calls, and was never exercised against a
 * breakpoint that actually existed — do not guess a corrected param set
 * without new live evidence. Full incident: the git history.
 */
export function deleteBreakpointUrl(params: DeleteBreakpointParams): string {
  const { id, terminalId, ideId, debuggingMode, requestUser, ...rest } = params;
  if (terminalId !== undefined) assertValidTerminalId(terminalId);
  if (ideId !== undefined) assertValidIdeId(ideId);
  if (debuggingMode === DEBUGGING_MODE.TERMINAL) {
    if (terminalId === undefined || ideId === undefined) {
      throw new Error(
        "deleteBreakpointUrl: debuggingMode is terminal mode, so BOTH terminalId AND ideId are mandatory " +
          "(CL_TPDA_ADT_RES_BREAKPOINTS->init_static) — " +
          `got terminalId=${terminalId === undefined ? "undefined" : `"${terminalId}"`}, ` +
          `ideId=${ideId === undefined ? "undefined" : `"${ideId}"`}. Note the server's own error names only ` +
          '"terminalId" even when ideId is the one actually missing — do not trust that error message alone ' +
          "to tell you which of the two is absent.",
      );
    }
  } else if (debuggingMode === DEBUGGING_MODE.USER) {
    if (requestUser === undefined) {
      throw new Error(
        "deleteBreakpointUrl: debuggingMode is user mode, so requestUser is mandatory " +
          "(CL_TPDA_ADT_RES_BREAKPOINTS->init_static) — got requestUser=undefined.",
      );
    }
  }
  return buildUrl(`${DEBUGGER_BREAKPOINTS_PATH}/${encodeURIComponent(id)}`, {
    ...rest,
    debuggingMode,
    requestUser,
    terminalId,
    ideId,
  });
}

/** Content-Type / Accept on the breakpoints POST — plain XML, not `asx:abap`. */
export const BREAKPOINTS_CONTENT_TYPE = "application/xml";
export const BREAKPOINTS_ACCEPT = "application/xml";

// ============================================================================
// 5. Listeners — launch / stop / get, three DIFFERENT legal param sets on the
//    SAME path
// ============================================================================

/** Server default when `timeout` omitted (`CL_TPDA_ADT_RES_LISTENERS`: `IF l_timeout IS INITIAL. l_timeout = 240.`). Tunable only via SAP memory PARAMETER ID `TPDA_ADT_LIS_TIMEOUT`, not a profile parameter. */
export const LISTENER_DEFAULT_TIMEOUT_SECONDS = 240;

/** Undocumented server-side cap observed in practice, not independently confirmed live. Advisory only — surface as a warning, don't enforce as a hard rule. */
export const MAX_HTTP_BREAKPOINTS_PER_USER = 30;

export interface ListenerLaunchParams extends DebugContext {
  /** Seconds; omit for the server's 240s default. Caller's HTTP client timeout must exceed this by a clear margin — a shorter one silently truncates the frame. */
  timeout?: number;
  checkConflict?: boolean;
  isNotifiedOnConflict?: boolean;
}

/** `POST /sap/bc/adt/debugger/listeners{?debuggingMode,requestUser,terminalId,ideId,timeout,checkConflict,isNotifiedOnConflict}` — the blocking long-poll. */
export function listenerLaunchUrl(params: ListenerLaunchParams): string {
  assertValidTerminalId(params.terminalId);
  if (params.ideId !== undefined) assertValidIdeId(params.ideId);
  return buildUrl(DEBUGGER_LISTENERS_PATH, { ...params });
}

export interface ListenerStopParams extends DebugContext {
  checkConflict?: boolean;
  notifyConflict?: boolean;
}

/** `DELETE .../listeners{?debuggingMode,requestUser,terminalId,ideId,checkConflict,notifyConflict}` — releases a blocked long-poll from a DIFFERENT connection than the one holding it. Note `notifyConflict`, not `isNotifiedOnConflict`, on this relation. */
export function listenerStopUrl(params: ListenerStopParams): string {
  assertValidTerminalId(params.terminalId);
  if (params.ideId !== undefined) assertValidIdeId(params.ideId);
  return buildUrl(DEBUGGER_LISTENERS_PATH, { ...params });
}

export interface ListenerGetParams extends DebugContext {
  /**
   * **Semantics INVERT between branches:** absent/false → query branch
   * (`404`=no listener, `200`=listener exists); `true` → conflict-check
   * branch (`200` empty=all clear, `<exc:exception>`=conflict). Do not guess
   * which branch a response came from.
   */
  checkConflict?: boolean;
}

/** `GET .../listeners{?debuggingMode,requestUser,terminalId,ideId,checkConflict}` — non-blocking check; doubles as a cheap pre-flight for auth/user-type/lock-state/listener availability. */
export function listenerGetUrl(params: ListenerGetParams): string {
  assertValidTerminalId(params.terminalId);
  if (params.ideId !== undefined) assertValidIdeId(params.ideId);
  return buildUrl(DEBUGGER_LISTENERS_PATH, { ...params });
}

/** `asx:abap`-wrapped `STPDA_DEBUGGEE`, NOT plain XML. Observed via Eclipse capture, not independently verified live (low-risk — it's only an Accept header). */
export const LISTENER_ACCEPT = "application/vnd.sap.as+xml";

// ============================================================================
// 6. The `?method=` dispatcher — attach, step, variables, settings, stack
// ============================================================================

/**
 * Every method the `/sap/bc/adt/debugger` resource dispatches on, POSTed as
 * `?method=<value>`. Step kinds come from `./types.ts`'s `DebugStepKind`,
 * which includes `terminateDebuggee` alongside the step verbs even though it
 * ends the session rather than moving the cursor — an earlier implementation
 * excludes it from its generic step tool for safety, but that's a decision
 * for the MCP tool layer, not this type.
 */
export type DebuggerDispatchMethod =
  | "attach"
  | "getStack"
  | "getVariables"
  | "getChildVariables"
  | "setVariableValue"
  | "setDebuggerSettings"
  | "setStackPosition"
  | DebugStepKind;

export interface AttachParams {
  /** The handle returned by a caught listener (`Debuggee.id` in `./types.ts`). */
  debuggeeId: string;
  debuggingMode: DebuggingMode;
  requestUser?: string;
  /** Magic constant, observed `true` on every captured attach call; meaning unconfirmed offline. Pass through verbatim; defaults `true` here to match. */
  dynproDebugging?: boolean;
}

/** `POST /sap/bc/adt/debugger?method=attach&debuggeeId=…&debuggingMode=…&requestUser=…&dynproDebugging=…`. **Not** `/debugger/attach` (an earlier design got this wrong). No `terminalId`/`ideId` here — the debuggee id alone is the session key. */
export function attachUrl(params: AttachParams): string {
  return buildUrl(DEBUGGER_DISPATCH_PATH, {
    method: "attach",
    debuggeeId: params.debuggeeId,
    debuggingMode: params.debuggingMode,
    requestUser: params.requestUser,
    dynproDebugging: params.dynproDebugging ?? true,
  });
}

export interface StepParams {
  /** One of `./types.ts`'s `DebugStepKind` values, verbatim as the `?method=` value. */
  step: DebugStepKind;
  /** Required for `stepRunToLine`/`stepJumpToLine` — an ADT URI carrying a `#start=<line>` fragment; see `withStartFragment` below. */
  uri?: string;
}

/** `POST /sap/bc/adt/debugger?method=<stepInto|stepOver|stepReturn|stepContinue|stepRunToLine|stepJumpToLine|terminateDebuggee>[&uri=…]`. Same dispatcher as attach — there is no separate `/debugger/actions/step` path. */
export function stepUrl(params: StepParams): string {
  return buildUrl(DEBUGGER_DISPATCH_PATH, { method: params.step, uri: params.uri });
}

/** The release primitive is `stepContinue`, not a `detach` endpoint (none exists). `terminateDebuggee` kills the debuggee outright — never default to it as `finally` teardown. */
export function terminateDebuggeeUrl(): string {
  return buildUrl(DEBUGGER_DISPATCH_PATH, { method: "terminateDebuggee" satisfies DebugStepKind });
}

/** `POST /sap/bc/adt/debugger?method=getVariables`. Body (an `asx:abap`-wrapped list of variable ids) is M2's job. */
export function getVariablesUrl(): string {
  return buildUrl(DEBUGGER_DISPATCH_PATH, { method: "getVariables" });
}

/** `POST /sap/bc/adt/debugger?method=getChildVariables`. */
export function getChildVariablesUrl(): string {
  return buildUrl(DEBUGGER_DISPATCH_PATH, { method: "getChildVariables" });
}

/** `POST /sap/bc/adt/debugger?method=setVariableValue&variableName=…` — raw value in the body, not XML-wrapped. */
export function setVariableValueUrl(variableName: string): string {
  return buildUrl(DEBUGGER_DISPATCH_PATH, { method: "setVariableValue", variableName });
}

/** `POST /sap/bc/adt/debugger?method=setDebuggerSettings`. */
export function setDebuggerSettingsUrl(): string {
  return buildUrl(DEBUGGER_DISPATCH_PATH, { method: "setDebuggerSettings" });
}

/**
 * `POST /sap/bc/adt/debugger?method=setStackPosition&position={n}`, 1-based,
 * no `stackType` param, no body — live server rejected `stackType`/`stackPosition`
 * with `Parameter position could not be found.`; matches `abap-adt-api`'s
 * `debuggerGoToStackOld`. (An earlier implementation instead uses a path-based
 * `PUT /debugger/stack/type/{ABAP|DYNP|...}/position/{n}`; not followed here.)
 */
export function setStackPositionUrl(position: number): string {
  return buildUrl(DEBUGGER_DISPATCH_PATH, { method: "setStackPosition", position });
}

/** `getVariables` Content-Type/Accept — `dataname=` suffix is MANDATORY, not decoration; wrong content type → `406`. */
export const GET_VARIABLES_CONTENT_TYPE = "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.debugger.Variables";
export const GET_VARIABLES_ACCEPT = GET_VARIABLES_CONTENT_TYPE;

/** Content-Type / Accept for `getChildVariables` — same family, different `dataname=`. */
export const GET_CHILD_VARIABLES_CONTENT_TYPE =
  "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.debugger.ChildVariables";
export const GET_CHILD_VARIABLES_ACCEPT = GET_CHILD_VARIABLES_CONTENT_TYPE;

// ============================================================================
// 7. Stack
// ============================================================================

/** Magic query value observed on the stack GET in Eclipse traffic (`emode=_`); meaning unconfirmed. Pass through verbatim, don't omit it. */
export const STACK_EMODE = "_";

export interface StackQueryParams {
  /** `./STACK_EMODE` (`"_"`) is the only value ever observed. */
  emode?: string;
  /** Requests URI-based (rather than positional) frame identifiers. */
  semanticURIs?: boolean;
}

/** `GET .../stack{?emode,semanticURIs}` — path live-verified (reaches ADI layer even unattached, `500 noSessionAttached`); query params from Eclipse capture only. */
export function getStackUrl(params: StackQueryParams = {}): string {
  return buildUrl(DEBUGGER_STACK_PATH, { ...params });
}

/** Legacy fallback (dispatcher `?method=getStack`) for releases without the dedicated GET resource — `abap-adt-api` picks between the two via `collectionFeatureDetails`. Prefer `getStackUrl()`. */
export function legacyGetStackUrl(): string {
  return buildUrl(DEBUGGER_DISPATCH_PATH, { method: "getStack" });
}

// ============================================================================
// 8. Variables — the paginated / CSV / valueStatement sub-resources
// ============================================================================

/**
 * **FORBIDDEN ENDPOINT FAMILY — DO NOT CALL (live-verified on A4H).**
 * `part="data"`/`"valueStatement"` → HTTP 500 ABAP short dump that **destroys
 * the HTTP session AND the attached debug session** (the debuggee then runs
 * to completion uncontrolled — one spike run was lost to this). `part="metadata"`
 * → `400`, unrouted. `part="subcomponents"` → `500 AdiFailed` (broken, non-destructive).
 * Treat the whole family as forbidden, not merely unimplemented; do not use
 * `canAdvancedTableFeatures` (`types.ts`) as a capability signal — it reads
 * `"true"` on this very system. Full investigation:
 * the git history.
 *
 * **Verified non-destructive replacement**: path-addressed ids through
 * `getVariablesUrl`/`getChildVariablesUrl` below, e.g.
 * `getVariables(["LT_ITEMS[1]-MATNR", …])` / `getChildVariables(["LT_ITEMS[3]"])`.
 * Every variable-reading method must build on those, never on this family.
 *
 * Kept (not deleted) for the audit table; `variablePartUrl` throws
 * unconditionally so nothing can wire this up by accident. `maxlength` was
 * never itself observed to dump but shares the same broken dispatch path —
 * refused here too until independently re-verified live.
 */
export const VARIABLE_PART = {
  DATA: "data",
  METADATA: "metadata",
  SUBCOMPONENTS: "subcomponents",
  VALUE_STATEMENT: "valueStatement",
} as const;
export type VariablePart = (typeof VARIABLE_PART)[keyof typeof VARIABLE_PART];

/**
 * **FORBIDDEN — throws unconditionally.** See `VARIABLE_PART` doc above.
 * Sole choke point for `variableDataUrl`/`variableSubcomponentsUrl`/
 * `variableValueStatementUrl`/`variableMaxLengthUrl`; calling any of them is a bug.
 */
export function variablePartUrl(variableName: string, part: string, params?: QueryParams): string {
  throw new Error(
    `variablePartUrl("${variableName}", "${part}"): /sap/bc/adt/debugger/variables/{name}/{part} ` +
      "is a FORBIDDEN endpoint family, not merely unimplemented — on this system 'data' and " +
      "'valueStatement' trigger an ABAP short dump that destroys the HTTP session and the attached " +
      "debug session, and 'metadata'/'subcomponents' are simply broken. " +
      "Use getVariablesUrl()/getChildVariablesUrl() with path-addressed ids " +
      '(e.g. "LT_ITEMS[1]-MATNR", "LT_ITEMS[3]") instead — see that section for the verified, ' +
      "non-destructive paging/projection/batching replacement. Do not remove this guard without a " +
      `fresh, dedicated live re-verification. (params: ${params ? JSON.stringify(params) : "none"})`,
  );
}

export interface VariableDataParams {
  offset?: number;
  length?: number;
  filter?: string;
  sortComponent?: string;
  /** Vocabulary UNVERIFIED — pass through whatever the server actually accepts once probed live. */
  sortDirection?: string;
  whereClause?: string;
  /** RFC 6570 EXPLODED (`components=A&components=B`), never a comma list. */
  components?: string[];
}

/**
 * `GET .../variables/{variableName}/data{?offset,length,filter,sortComponent,
 * sortDirection,whereClause,components*}` — the CSV rel, observed verbatim in
 * discovery capture. FORBIDDEN — see `VARIABLE_PART` above; kept for the
 * audit table only. Unverified even before that: whether `{variableName}`
 * accepts an indexed id like `LT_ITEMS[3]`, and whether `offset` is 0- or 1-based.
 */
export function variableDataUrl(variableName: string, params: VariableDataParams = {}): string {
  return variablePartUrl(variableName, VARIABLE_PART.DATA, { ...params });
}

export interface VariableValueStatementParams {
  /** `"a-b"` row-range syntax, e.g. `"1-10"`, `"99999-100000"`. */
  rows?: string;
  maxStringLength?: number;
  maxNestingLevel?: number;
  maxTotalSize?: number;
}

/**
 * `GET .../variables/{variableName}/valueStatement{?rows,maxStringLength,
 * maxNestingLevel,maxTotalSize}` — would return an ABAP `VALUE #( … )`
 * literal. FORBIDDEN (see `VARIABLE_PART` above). Even setting that aside,
 * none of these params appear in discovery (only `data`/`subcomponents`/`maxlength`
 * are declared) — UNVERIFIED vocabulary.
 */
export function variableValueStatementUrl(variableName: string, params: VariableValueStatementParams = {}): string {
  return variablePartUrl(variableName, VARIABLE_PART.VALUE_STATEMENT, { ...params });
}

export interface VariableSubcomponentsParams {
  component?: string;
  line?: number;
}

/** `GET .../variables/{variableName}/subcomponents{?component,line}`. FORBIDDEN — see `VARIABLE_PART` above. */
export function variableSubcomponentsUrl(variableName: string, params: VariableSubcomponentsParams = {}): string {
  return variablePartUrl(variableName, VARIABLE_PART.SUBCOMPONENTS, { ...params });
}

/** `GET .../variables/{variableName}/{part}{?maxLength}` — cap a single value's length. FORBIDDEN — see `VARIABLE_PART` above. */
export function variableMaxLengthUrl(variableName: string, part: string, maxLength: number): string {
  return variablePartUrl(variableName, part, { maxLength });
}

// ============================================================================
// 9. Batch (discovery entry "Debugger Batch Request")
// ============================================================================

/** Multipart content types for the batch round trip. Eclipse issues a step as ONE batch of four ops (step, getStack, getChildVariables(@ROOT), getVariables(SY-SUBRC)) — one MCP tool call should be one batch, not several round trips. */
export const BATCH_CONTENT_TYPE_PREFIX = "multipart/mixed";
export const BATCH_ACCEPT = "multipart/mixed";

/** `POST .../batch` — confirmed to work over plain HTTP (reached ADI layer, got a real `noSessionAttached`), not just RFC. */
export function batchUrl(): string {
  return DEBUGGER_BATCH_PATH;
}

// ============================================================================
// 10. System areas / actions — present in discovery, out of the
//     "must cover" core but included for a complete audit table.
// ============================================================================

export interface SystemAreaParams {
  offset?: number;
  length?: number;
  element?: string;
  isSelection?: boolean;
  selectedLine?: number;
  selectedColumn?: number;
  programContext?: string;
  filter?: string;
}

/** `GET /debugger/systemareas/{systemarea}{?offset,length,element,isSelection,selectedLine,selectedColumn,programContext,filter}`. Not exercised live. */
export function systemAreaUrl(systemarea: string, params: SystemAreaParams = {}): string {
  return buildUrl(`${DEBUGGER_SYSTEMAREAS_PATH}/${encodeURIComponent(systemarea)}`, { ...params });
}

/** `POST /debugger/actions{?action,value}` — UI-action toggles (garbageCollector, updateDebugging, commitWork, rollbackWork, kernelDebugger, memorySnapshot, stepSizeLine, stepSizeExpression). No known client invokes this; read `<dbg:actions>` off an attach/step response to discover what's toggleable. */
export function debuggerActionUrl(action: string, value?: string): string {
  return buildUrl(DEBUGGER_ACTIONS_PATH, { action, value });
}

// ============================================================================
// 11. Magic constants shared across the wire protocol
// ============================================================================

/**
 * `TERMINAL_ID`/`IDE_ID`/`DEBUGGEE_ID` are all `SYSUUID_C32` server side (32
 * chars, confirmed on live DDIC). The server's own conversion is a bare
 * assignment into a `CHAR32` target: ABAP silently pads a shorter string and
 * **silently truncates a longer one with no error** — two different 33+-char
 * ids sharing the first 32 characters COLLIDE indistinguishably on the
 * server. This module enforces exactly 32 (rejects rather than truncates) so
 * that silent collision never reaches the wire.
 */
export const TERMINAL_ID_LENGTH = 32;

/** Same `SYSUUID_C32` type and silent-truncation collision risk as `TERMINAL_ID_LENGTH` above — same rationale, same length. */
export const IDE_ID_LENGTH = 32;

/** Wire format is 32-char **uppercase** hex. Server does NOT normalise case — lowercase hex names a DIFFERENT session, not the same one. */
const SYSUUID_C32_RE = /^[0-9A-F]{32}$/;

/** Reject anything not exactly `TERMINAL_ID_LENGTH` chars — never truncate/pad (that would reproduce the server-side footgun this exists to avoid). Used for `terminalId` and `ideId` alike. */
export function assertValidTerminalId(id: string, label = "terminalId"): void {
  if (id.length !== TERMINAL_ID_LENGTH) {
    throw new Error(
      `${label} must be exactly ${TERMINAL_ID_LENGTH} characters (SYSUUID_C32) — got ${id.length}. ` +
        "The server silently truncates longer values instead of rejecting them, so this must be caught here, " +
        "before the value ever reaches the wire.",
    );
  }
  if (!SYSUUID_C32_RE.test(id)) {
    throw new Error(
      `${label} must be uppercase hex (SYSUUID_C32) — got "${id}". ` +
        "The server does not normalise case, so lowercase hex names a different session than the same " +
        "characters uppercased; lowercase hex is rejected here rather than silently accepted as equivalent.",
    );
  }
}

/** Delegates to `assertValidTerminalId` (same `SYSUUID_C32` type, same cross-talk risk) so both validators' messages stay in sync. */
export function assertValidIdeId(id: string, label = "ideId"): void {
  assertValidTerminalId(id, label);
}

/**
 * `ideId`/`terminalId` must be the SAME string across every listener,
 * breakpoint and attach call in one logical debug session — the id string
 * IS the correlation key (no server-side session object). Mixing user-mode
 * and terminal-mode lookup keys between "set" and "get" returns empty with
 * no error. This module is stateless; the caller owns one `ideId` for the
 * session's whole lifetime and must never regenerate it mid-session.
 */
export const IDE_ID_CONSISTENCY_NOTE =
  "ideId/terminalId must stay identical across every call in one debug session — see this constant's doc comment.";

/**
 * Line breakpoints and line-targeted steps identify a position with a
 * `#start=<line>` fragment. **Only the line goes here** — the `#start=L,C;end=L,C`
 * form used elsewhere in ADT is NOT accepted: the server does
 * `split l_frag at ',' into l_frag l_void`, silently DISCARDING anything
 * after the first comma (no parse error).
 */
export function startFragment(line: number): string {
  if (!Number.isInteger(line) || line < 1) {
    throw new Error(`startFragment: line must be a positive integer, got ${line}.`);
  }
  return `#start=${line}`;
}

/** Append a `#start=<line>` fragment to an ADT source URI. See `startFragment` for the constraints. */
export function withStartFragment(uri: string, line: number): string {
  return `${uri}${startFragment(line)}`;
}

/**
 * Parse a `#start=<line>` fragment back out of a returned `adtcore:uri`.
 * **The server may rewrite the requested line to the nearest valid statement
 * position** — the response URI can legitimately differ from what was sent.
 * Report "requested N, set at M" explicitly rather than assume it was honoured
 * verbatim (an earlier parser captures the corrected value but never surfaces
 * the discrepancy).
 */
export function parseStartFragment(uri: string): number | undefined {
  const m = /#start=(\d+)/.exec(uri);
  return m ? Number(m[1]) : undefined;
}

/** The root scope pseudo-variable. */
export const ROOT_VARIABLE_ID = "@ROOT";
/** The data-aging pseudo-variable, included alongside `@ROOT` by default. */
export const DATA_AGING_VARIABLE_ID = "@DATAAGING";
/** Default parents passed to `getChildVariables` when the caller specifies none (`["@ROOT", "@DATAAGING"]`). */
export const DEFAULT_CHILD_VARIABLE_PARENTS: readonly string[] = [ROOT_VARIABLE_ID, DATA_AGING_VARIABLE_ID];

/** Eclipse's canary variable, sent alongside caller-requested ids in every real `getVariables` capture — a cheap sanity check the debuggee is stopped/responsive, not a protocol requirement. */
export const CANARY_VARIABLE_ID = "SY-SUBRC";

// ============================================================================
// 12. The audit table — every endpoint in one place, cross-referenced above
// ============================================================================

export interface EndpointEntry {
  /** Stable, human-scannable identifier — not part of the wire protocol. */
  name: string;
  method: "GET" | "POST" | "DELETE" | "PUT";
  /** Path template as documented, `{placeholders}` literal. */
  path: string;
  /** Legal query parameter names (`*` suffix = RFC 6570 exploded list). */
  queryParams: readonly string[];
  contentType?: string;
  accept?: string;
  /** Provenance for this endpoint's shape (e.g. live-verified against A4H, Eclipse network capture). */
  citation: string;
  notes?: string;
}

export const DEBUGGER_ENDPOINTS: readonly EndpointEntry[] = [
  {
    name: "breakpoints.post",
    method: "POST",
    path: DEBUGGER_BREAKPOINTS_PATH,
    queryParams: ["checkConflict"],
    contentType: BREAKPOINTS_CONTENT_TYPE,
    accept: BREAKPOINTS_ACCEPT,
    citation: "live-verified against A4H",
  },
  {
    name: "breakpoints.delete",
    method: "DELETE",
    path: `${DEBUGGER_BREAKPOINTS_PATH}/{id}`,
    queryParams: ["scope", "debuggingMode", "requestUser", "terminalId", "ideId"],
    citation: "live-verified against A4H; see deleteBreakpointUrl doc comment for a known param-set defect",
  },
  {
    name: "breakpoints.get.conditionValidator",
    method: "GET",
    path: DEBUGGER_BREAKPOINTS_PATH,
    queryParams: ["condition"],
    citation: "live-verified against A4H",
    notes: "NOT a list endpoint. 200/0 B means nothing about stored breakpoints — condition-validator only.",
  },
  {
    name: "breakpoints.statements",
    method: "GET",
    path: DEBUGGER_BREAKPOINTS_STATEMENTS_PATH,
    queryParams: [],
    citation: "live-verified against A4H",
  },
  {
    name: "breakpoints.messagetypes",
    method: "GET",
    path: DEBUGGER_BREAKPOINTS_MESSAGETYPES_PATH,
    queryParams: [],
    citation: "live-verified against A4H",
  },
  {
    name: "breakpoints.conditions",
    method: "GET",
    path: DEBUGGER_BREAKPOINTS_CONDITIONS_PATH,
    queryParams: [],
    citation: "live-verified against A4H",
    notes: "200/0 B with no parameters on A4H. Further parameterisation UNKNOWN.",
  },
  {
    name: "breakpoints.validations",
    method: "GET",
    path: DEBUGGER_BREAKPOINTS_VALIDATIONS_PATH,
    queryParams: [],
    citation: "live-verified against A4H",
    notes: "200/0 B with no parameters on A4H. Further parameterisation UNKNOWN.",
  },
  {
    name: "listeners.launch",
    method: "POST",
    path: DEBUGGER_LISTENERS_PATH,
    queryParams: ["debuggingMode", "requestUser", "terminalId", "ideId", "timeout", "checkConflict", "isNotifiedOnConflict"],
    accept: LISTENER_ACCEPT,
    citation: "live-verified against A4H",
  },
  {
    name: "listeners.stop",
    method: "DELETE",
    path: DEBUGGER_LISTENERS_PATH,
    queryParams: ["debuggingMode", "requestUser", "terminalId", "ideId", "checkConflict", "notifyConflict"],
    citation: "live-verified against A4H",
  },
  {
    name: "listeners.get",
    method: "GET",
    path: DEBUGGER_LISTENERS_PATH,
    queryParams: ["debuggingMode", "requestUser", "terminalId", "ideId", "checkConflict"],
    citation: "live-verified against A4H",
    notes: "checkConflict semantics are INVERTED between branches — see ListenerGetParams doc comment.",
  },
  {
    name: "dispatch.attach",
    method: "POST",
    path: DEBUGGER_DISPATCH_PATH,
    queryParams: ["method=attach", "debuggeeId", "debuggingMode", "requestUser", "dynproDebugging"],
    citation: "live-verified against A4H",
    notes: 'NOT "/debugger/attach". Absent from discovery entirely — do not feature-probe for it.',
  },
  {
    name: "dispatch.step",
    method: "POST",
    path: DEBUGGER_DISPATCH_PATH,
    queryParams: ["method=<stepInto|stepOver|stepReturn|stepContinue|stepRunToLine|stepJumpToLine|terminateDebuggee>", "uri"],
    citation: "live-verified against A4H",
  },
  {
    name: "dispatch.getVariables",
    method: "POST",
    path: DEBUGGER_DISPATCH_PATH,
    queryParams: ["method=getVariables"],
    contentType: GET_VARIABLES_CONTENT_TYPE,
    accept: GET_VARIABLES_ACCEPT,
    citation: "live-verified against A4H; content type observed via Eclipse network capture",
  },
  {
    name: "dispatch.getChildVariables",
    method: "POST",
    path: DEBUGGER_DISPATCH_PATH,
    queryParams: ["method=getChildVariables"],
    contentType: GET_CHILD_VARIABLES_CONTENT_TYPE,
    accept: GET_CHILD_VARIABLES_ACCEPT,
    citation: "live-verified against A4H; content type observed via Eclipse network capture",
  },
  {
    name: "dispatch.setVariableValue",
    method: "POST",
    path: DEBUGGER_DISPATCH_PATH,
    queryParams: ["method=setVariableValue", "variableName"],
    citation: "live-verified against A4H; body shape observed via Eclipse network capture",
  },
  {
    name: "dispatch.setDebuggerSettings",
    method: "POST",
    path: DEBUGGER_DISPATCH_PATH,
    queryParams: ["method=setDebuggerSettings"],
    citation: "live-verified against A4H",
  },
  {
    name: "dispatch.setStackPosition",
    method: "POST",
    path: DEBUGGER_DISPATCH_PATH,
    queryParams: ["method=setStackPosition", "position"],
    citation: "live 400 `Parameter position could not be found.`; abap-adt-api debuggerGoToStackOld",
  },
  {
    name: "stack.get",
    method: "GET",
    path: DEBUGGER_STACK_PATH,
    queryParams: ["emode", "semanticURIs"],
    citation: "path live-verified against A4H; query params observed via Eclipse network capture",
  },
  {
    name: "stack.get.legacy",
    method: "POST",
    path: DEBUGGER_DISPATCH_PATH,
    queryParams: ["method=getStack"],
    citation: "reference: abap-adt-api's debuggerStackTrace fallback logic",
    notes: "Fallback for releases without the dedicated GET resource.",
  },
  {
    name: "variables.data",
    method: "GET",
    path: `${DEBUGGER_VARIABLES_PATH}/{variableName}/data`,
    queryParams: ["offset", "length", "filter", "sortComponent", "sortDirection", "whereClause", "components*"],
    citation: "csv rel, observed verbatim in discovery capture",
    notes:
      "FORBIDDEN — live-verified this triggers an ABAP short dump that destroys " +
      "the HTTP session and the attached debug session. variablePartUrl() throws unconditionally. " +
      "Use getVariables()/getChildVariables() with path-addressed ids instead.",
  },
  {
    name: "variables.subcomponents",
    method: "GET",
    path: `${DEBUGGER_VARIABLES_PATH}/{variableName}/subcomponents`,
    queryParams: ["component", "line"],
    citation: "observed in discovery capture",
    notes: "FORBIDDEN — live-verified 500 AdiFailed (broken, not routed). Do not call.",
  },
  {
    name: "variables.maxlength",
    method: "GET",
    path: `${DEBUGGER_VARIABLES_PATH}/{variableName}/{part}`,
    queryParams: ["maxLength"],
    citation: "observed in discovery capture",
    notes:
      "FORBIDDEN — shares the same broken {name}/{part} dispatch found broken/" +
      "destructive for every other {part} value tried; not itself independently re-verified live, " +
      "refused here as a precaution until it is.",
  },
  {
    name: "variables.valueStatement",
    method: "GET",
    path: `${DEBUGGER_VARIABLES_PATH}/{variableName}/valueStatement`,
    queryParams: ["rows", "maxStringLength", "maxNestingLevel", "maxTotalSize"],
    citation: "observed via Eclipse network capture",
    notes:
      "FORBIDDEN — live-verified this triggers an ABAP short dump (500 text/html) " +
      "that destroys the HTTP session and the attached debug session. The hoped-for VALUE #( … ) " +
      "literal serialisation does not exist on this release. variablePartUrl() throws unconditionally.",
  },
  {
    name: "batch",
    method: "POST",
    path: DEBUGGER_BATCH_PATH,
    queryParams: [],
    contentType: BATCH_CONTENT_TYPE_PREFIX,
    accept: BATCH_ACCEPT,
    citation: "live-verified against A4H; observed via Eclipse network capture",
    notes: "Confirmed to work over plain HTTP, not just RFC.",
  },
  {
    name: "systemareas.get",
    method: "GET",
    path: `${DEBUGGER_SYSTEMAREAS_PATH}/{systemarea}`,
    queryParams: [
      "offset",
      "length",
      "element",
      "isSelection",
      "selectedLine",
      "selectedColumn",
      "programContext",
      "filter",
    ],
    citation: "observed in discovery capture",
  },
  {
    name: "actions",
    method: "POST",
    path: DEBUGGER_ACTIONS_PATH,
    queryParams: ["action", "value"],
    citation: "observed via Eclipse network capture",
  },
] as const;
