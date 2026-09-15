/**
 * TS runtime wrapper for the built-in `authtrace` fluid tool
 * (`src/adt/fluid/builtin/authtrace.ts`). Modeled on `src/adt/source-scan.ts`:
 * a `LoadedFluidTool` map, one `dispatch()` call per action, and typed row
 * mapping that turns dispatch()'s already-schema-checked-but-untyped `result`
 * array into concrete TS shapes (throwing `FLUID_PROTOCOL_ERROR` on anything
 * the manifest's declared schema does not itself rule out).
 *
 * Deliberately free of MCP/tool-layer concerns: no `buildResponse`, no gate
 * wiring beyond taking a `SafetyGate` through {@link AuthTraceDeps}, no
 * journal calls (the underlying fluid actions are `read`/`execute`, never
 * `mutate`, so `dispatch()` itself never journals them). The tool layer that
 * eventually calls this module owns request/response shaping.
 */
import { AbapError, isAbapError } from "./errors.js";
import type { AbapConnection } from "./connection.js";
import { dispatch } from "./fluid/dispatch.js";
import {
  authtraceManifest,
  authtraceSources,
  AUTHTRACE_TOOL_ID,
  AUTHTRACE_ACTION_STATUS,
  AUTHTRACE_ACTION_ON,
  AUTHTRACE_ACTION_OFF,
  AUTHTRACE_ACTION_READ,
  AUTHTRACE_ACTION_SU53,
} from "./fluid/builtin/authtrace.js";
import { manifestVersion, type LoadedFluidTool } from "./fluid/manifest.js";
import type { SafetyGate } from "../safety.js";

// ---------------------------------------------------------------------------
// dispatch() plumbing
// ---------------------------------------------------------------------------

export interface AuthTraceDeps {
  readonly conn: AbapConnection;
  readonly gate: SafetyGate;
}

const AUTHTRACE_TOOLS: ReadonlyMap<string, LoadedFluidTool> = new Map([
  [
    AUTHTRACE_TOOL_ID,
    {
      manifest: authtraceManifest,
      origin: "builtin",
      sources: authtraceSources,
      version: manifestVersion(authtraceManifest, authtraceSources),
    } as const,
  ],
]);

async function runAuthtrace(
  deps: AuthTraceDeps,
  action: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await dispatch(
    { conn: deps.conn, cfg: deps.conn.cfg, gate: deps.gate, tools: AUTHTRACE_TOOLS },
    {
      tool: AUTHTRACE_TOOL_ID,
      action,
      args,
      caller: { tool: "authtrace", action },
    },
  );
  return res.result;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface AuthTraceStatus {
  readonly active: boolean;
  readonly anyActive: boolean;
  readonly forUser: string;
  readonly errorsOnly: boolean;
}

export interface AuthTraceOnResult {
  readonly active: boolean;
  readonly forUser: string;
  readonly errorsOnly: boolean;
  /**
   * The SAP server's own `EV_TIMESTAMP` (YYYYMMDDHHMMSS, UTC) from
   * `SUAUTH_SYSTEM_TRACE_FOR_AUTH`, observed live on A4H. Empty string if the
   * FM did not return one — callers should fall back to a host-clock
   * timestamp in that case, never treat empty as "now".
   */
  readonly timestamp: string;
}

export interface AuthTraceOffResult {
  readonly active: boolean;
}

/** One failed authority check, from either the kernel trace or the SU53 fallback. */
export interface FailedAuthCheck {
  readonly origin: "trace" | "su53";
  readonly object: string;
  readonly rc: string;
  readonly reason: string;
  readonly fields: string;
  readonly program: string;
  readonly line: string;
  readonly tcode: string;
  readonly timestamp: string;
}

// ---------------------------------------------------------------------------
// Row validation — pure and total; throws FLUID_PROTOCOL_ERROR on any shape
// the manifest's output schema does not itself rule out.
// ---------------------------------------------------------------------------

function fail(action: string, reason: string, result: unknown): never {
  throw new AbapError(
    "FLUID_PROTOCOL_ERROR",
    `authtrace.${action} ${reason}`,
    { tool: AUTHTRACE_TOOL_ID, action, result },
  );
}

function singleRow(action: string, result: unknown): Record<string, unknown> {
  if (!Array.isArray(result)) {
    fail(action, "returned a result that is not an array", result);
  }
  if (result.length !== 1) {
    fail(action, `returned ${result.length} rows, expected exactly 1`, result);
  }
  const row = result[0];
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    fail(action, "row 0 is not an object", result);
  }
  return row as Record<string, unknown>;
}

function reqBool(action: string, row: Record<string, unknown>, key: string, result: unknown): boolean {
  const v = row[key];
  if (typeof v !== "boolean") {
    fail(action, `row 0.${key} is missing or not a boolean`, result);
  }
  return v;
}

function reqString(action: string, row: Record<string, unknown>, key: string, result: unknown): string {
  const v = row[key];
  if (typeof v !== "string") {
    fail(action, `row 0.${key} is missing or not a string`, result);
  }
  return v;
}

/**
 * Lenient string read: missing/non-string comes back as "", never throws.
 * Used for fields the FM may legitimately omit (e.g. `on`'s `timestamp`).
 *
 * Trims the value. `on`'s `timestamp` is fed straight through by
 * `withAuthTrace` as the read-back's `from`, which `read`/`su53` both reject
 * outright unless `strlen( ) = 14` — a numeric/packed ABAP field (like the
 * `timestamp TYPE timestamp` this value comes from) renders with a stray
 * trailing blank unless explicitly `CONDENSE`d server-side (see
 * `src/adt/fluid/builtin/authtrace.ts`), so trimming here too is a second,
 * independent line of defense: any future ABAP change that reintroduces the
 * blank cannot silently kill the read-back again. Trimming is scoped to this
 * lenient helper rather than `reqString` (used for many other fields whose
 * exact content callers may want to see un-mangled) because this is the one
 * helper already documented as feeding a value back into another API call's
 * strict-length validation.
 */
function optString(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v.trim() : "";
}

function mapStatusRow(result: unknown): AuthTraceStatus {
  const row = singleRow(AUTHTRACE_ACTION_STATUS, result);
  return {
    active: reqBool(AUTHTRACE_ACTION_STATUS, row, "active", result),
    anyActive: reqBool(AUTHTRACE_ACTION_STATUS, row, "any_active", result),
    forUser: reqString(AUTHTRACE_ACTION_STATUS, row, "for_user", result),
    errorsOnly: reqBool(AUTHTRACE_ACTION_STATUS, row, "errors_only", result),
  };
}

function mapOnRow(result: unknown): AuthTraceOnResult {
  const row = singleRow(AUTHTRACE_ACTION_ON, result);
  return {
    active: reqBool(AUTHTRACE_ACTION_ON, row, "active", result),
    forUser: reqString(AUTHTRACE_ACTION_ON, row, "for_user", result),
    errorsOnly: reqBool(AUTHTRACE_ACTION_ON, row, "errors_only", result),
    timestamp: optString(row, "timestamp"),
  };
}

function mapOffRow(result: unknown): AuthTraceOffResult {
  const row = singleRow(AUTHTRACE_ACTION_OFF, result);
  return {
    active: reqBool(AUTHTRACE_ACTION_OFF, row, "active", result),
  };
}

/**
 * Exported (not just used internally) so unit tests can construct/validate
 * `read`/`su53` rows the same way `readFailedAuthChecks` does, without going
 * through `dispatch()`.
 */
export function mapCheckRows(action: string, result: unknown, expectedOrigin: "trace" | "su53"): FailedAuthCheck[] {
  if (!Array.isArray(result)) {
    fail(action, "returned a result that is not an array", result);
  }
  return result.map((row, i) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      fail(action, `row ${i} is not an object`, result);
    }
    const r = row as Record<string, unknown>;
    const origin = r["origin"];
    if (origin !== "trace" && origin !== "su53") {
      fail(action, `row ${i}.origin is "${String(origin)}", expected "trace" or "su53"`, result);
    }
    if (origin !== expectedOrigin) {
      fail(action, `row ${i}.origin is "${origin}", expected "${expectedOrigin}" for action "${action}"`, result);
    }
    const check: FailedAuthCheck = {
      origin,
      object: reqString(action, r, "object", result),
      rc: reqString(action, r, "rc", result),
      reason: reqString(action, r, "reason", result),
      fields: reqString(action, r, "fields", result),
      program: reqString(action, r, "program", result),
      line: reqString(action, r, "line", result),
      tcode: reqString(action, r, "tcode", result),
      timestamp: reqString(action, r, "timestamp", result),
    };
    return check;
  });
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function authTraceStatus(deps: AuthTraceDeps): Promise<AuthTraceStatus> {
  const result = await runAuthtrace(deps, AUTHTRACE_ACTION_STATUS, {});
  return mapStatusRow(result);
}

export async function authTraceOn(
  deps: AuthTraceDeps,
  user: string,
  opts: { readonly errorsOnly?: boolean } = {},
): Promise<AuthTraceOnResult> {
  const errorsOnly = opts.errorsOnly ?? true;
  const result = await runAuthtrace(deps, AUTHTRACE_ACTION_ON, { user, errors_only: errorsOnly });
  return mapOnRow(result);
}

export async function authTraceOff(deps: AuthTraceDeps): Promise<AuthTraceOffResult> {
  const result = await runAuthtrace(deps, AUTHTRACE_ACTION_OFF, {});
  return mapOffRow(result);
}

export interface ReadFailedAuthChecksQuery {
  readonly user: string;
  /** YYYYMMDDHHMMSS, exactly 14 digits. */
  readonly from: string;
  /** YYYYMMDDHHMMSS, exactly 14 digits, or "now" / omitted. */
  readonly to?: string;
}

export interface ReadFailedAuthChecksResult {
  readonly checks: readonly FailedAuthCheck[];
  /** True when the kernel trace (`read`) returned zero rows and the SU53 buffer (`su53`) was used instead. */
  readonly usedFallback: boolean;
}

/**
 * Reads back failed authority checks. Tries the kernel trace first
 * (`read`); if — as observed live on at least one system — it returns zero
 * rows, falls back to the SU53 buffer (`su53`) and labels every returned
 * row `origin: "su53"`. Never assumes the kernel trace returns rows.
 */
export async function readFailedAuthChecks(
  deps: AuthTraceDeps,
  query: ReadFailedAuthChecksQuery,
): Promise<ReadFailedAuthChecksResult> {
  const readArgs: Record<string, unknown> = { user: query.user, from: query.from };
  if (query.to !== undefined) {
    readArgs["to"] = query.to;
  }
  const traceResult = await runAuthtrace(deps, AUTHTRACE_ACTION_READ, readArgs);
  const traceChecks = mapCheckRows(AUTHTRACE_ACTION_READ, traceResult, "trace");
  if (traceChecks.length > 0) {
    return { checks: traceChecks, usedFallback: false };
  }

  const su53Result = await runAuthtrace(deps, AUTHTRACE_ACTION_SU53, { user: query.user, from: query.from });
  const su53Checks = mapCheckRows(AUTHTRACE_ACTION_SU53, su53Result, "su53");
  return { checks: su53Checks, usedFallback: true };
}

/**
 * Renders a `FAILED AUTH CHECKS` section, one line per check. Every line
 * carries a provenance label — `[trace]` for the kernel trace, `[SU53
 * fallback]` for the SU53-buffer fallback — and empty parts (blank object,
 * fields, rc, program, or line) are omitted rather than left dangling (no
 * bare "rc=", no "at  line " with nothing to fill it in).
 *
 * Returns an empty string when `checks` is empty: the "no failed checks"
 * fact belongs in whatever header/summary field the caller renders, not in
 * an otherwise-empty `FAILED AUTH CHECKS` section with no lines under it.
 *
 * Deliberately does NOT say the SU53 buffer shows only the last failed
 * check: it is the SU53 buffer for the requested window, which the system
 * may cap or overwrite, and it is used here only as a fallback for when the
 * kernel trace itself returns nothing.
 */
export function renderFailedAuthChecks(checks: readonly FailedAuthCheck[]): string {
  if (checks.length === 0) {
    return "";
  }
  const lines: string[] = ["FAILED AUTH CHECKS"];
  for (const c of checks) {
    const provenance = c.origin === "trace" ? "[trace]" : "[SU53 fallback]";
    const parts: string[] = [];
    if (c.object !== "") parts.push(c.object);
    if (c.fields !== "") parts.push(c.fields);
    if (c.rc !== "") parts.push(`rc=${c.rc}`);

    let at = "";
    if (c.program !== "" && c.line !== "") {
      at = `at ${c.program} line ${c.line}`;
    } else if (c.program !== "") {
      at = `at ${c.program}`;
    } else if (c.line !== "") {
      at = `at line ${c.line}`;
    }
    if (at !== "") parts.push(at);

    parts.push(provenance);
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// withAuthTrace — guaranteed switch-off around an arbitrary run
// ---------------------------------------------------------------------------

/**
 * Fallback only, used when `SUAUTH_SYSTEM_TRACE_FOR_AUTH` did not return its
 * own `EV_TIMESTAMP` (see {@link AuthTraceOnResult.timestamp}). The MCP host
 * clock and the SAP application server clock can drift; using the host clock
 * as the read-back window's `from` would silently narrow or zero out the
 * window on skew, producing a false "no failed checks" result that looks
 * identical to a genuinely clean run. Prefer the server's own timestamp
 * whenever it is available.
 */
function abapTimestamp(d: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

function describeFailure(e: unknown): string {
  if (isAbapError(e)) {
    return `${e.code}: ${e.message}`;
  }
  if (e instanceof Error) {
    return e.message;
  }
  try {
    return String(e);
  } catch {
    return "unknown error";
  }
}

export type AuthTraceOutcome =
  | { readonly ok: true; readonly checks: readonly FailedAuthCheck[]; readonly usedFallback: boolean }
  | { readonly ok: false; readonly reason: string };

export interface WithAuthTraceResult<T> {
  readonly value: T;
  readonly authTrace: AuthTraceOutcome;
  /**
   * Set when switching the trace back off failed AFTER `fn` already ran.
   * `fn`'s own result/error always wins — this field exists only so a
   * caller can surface (e.g. log) that the trace may have been left on,
   * without that failure ever masking `fn`'s outcome.
   */
  readonly switchOffError?: string;
}

/** Non-enumerable so a caller inspecting/serializing the original thrown error sees no new shape, only a place `withAuthTrace` can stash the swallowed switch-off failure. */
const SWITCH_OFF_ERROR_KEY = "__authTraceSwitchOffError__";
/** Non-enumerable stash of the {@link AuthTraceOutcome} computed for a run whose `fn` threw, so a tool wrapper can still render `FAILED AUTH CHECKS` for a dump / `SESSION_DEAD` / parse-failure error via {@link authTraceOf}. */
const AUTH_TRACE_KEY = "__authTraceOutcome__";

/**
 * Switches the authorization trace ON for `user`, runs `fn`, reads back
 * failed authority checks, and switches the trace back OFF — on EVERY path:
 * normal return, `fn` throwing an `AbapError`, `fn` throwing a non-`Error`
 * value, an ABAP dump inside `fn`, or a dead session.
 *
 * The read-back happens on both the success path and the throw path, before
 * the unconditional switch-off: a run that dies because of a missing
 * authorization is exactly when the caller most needs `FAILED AUTH CHECKS`,
 * so it must not be skipped just because `fn` threw. When `fn` threw, the
 * resulting `AuthTraceOutcome` is stashed on the rethrown error (when it is
 * an object) via a non-enumerable property, retrievable with
 * {@link authTraceOf}, so a tool wrapper can render the section even though
 * the error propagates instead of a normal result.
 *
 * If the read-back itself fails, that failure is swallowed into
 * `{ ok: false, reason }` rather than replacing/masking `fn`'s outcome. The
 * same applies to the switch-off call: if it throws, that failure is
 * swallowed rather than replacing/masking whatever `fn` produced or threw —
 * it is recorded on the result (`switchOffError`) on the success path, or
 * stashed on the rethrown error object (via {@link switchOffErrorOf}) when
 * `fn` threw and the error is an object.
 *
 * If switching the trace ON fails, `fn` still runs (auth-trace failure must
 * never fail the run itself); `authTrace` comes back `{ ok: false, reason:
 * "unavailable: <reason>" }` and no read-back or switch-OFF call is
 * attempted (nothing was switched on by this call).
 */
export async function withAuthTrace<T>(
  deps: AuthTraceDeps,
  user: string,
  fn: () => Promise<T>,
): Promise<WithAuthTraceResult<T>> {
  let switchedOn = false;
  let onFailureReason: string | undefined;
  let from = abapTimestamp(new Date()); // fallback only — overwritten below when the FM returns its own timestamp
  try {
    const onResult = await authTraceOn(deps, user);
    switchedOn = true;
    if (onResult.timestamp !== "") {
      from = onResult.timestamp;
    }
  } catch (e) {
    onFailureReason = describeFailure(e);
  }

  let result: T | undefined;
  let fnError: unknown;
  let fnThrew = false;
  try {
    result = await fn();
  } catch (e) {
    fnThrew = true;
    fnError = e;
  }

  // Read back failed checks on BOTH the success and throw paths, before the
  // unconditional switch-off below (see the function doc for why).
  let authTrace: AuthTraceOutcome;
  if (!switchedOn) {
    authTrace = { ok: false, reason: `unavailable: ${onFailureReason ?? "unknown reason"}` };
  } else {
    try {
      const to = abapTimestamp(new Date());
      const { checks, usedFallback } = await readFailedAuthChecks(deps, { user, from, to });
      authTrace = { ok: true, checks, usedFallback };
    } catch (e) {
      authTrace = { ok: false, reason: `unavailable: ${describeFailure(e)}` };
    }
  }

  let switchOffError: string | undefined;
  if (switchedOn) {
    try {
      await authTraceOff(deps);
    } catch (e) {
      switchOffError = describeFailure(e);
    }
  }

  if (fnThrew) {
    if (typeof fnError === "object" && fnError !== null) {
      try {
        Object.defineProperty(fnError, AUTH_TRACE_KEY, {
          value: authTrace,
          enumerable: false,
          configurable: true,
        });
        if (switchOffError !== undefined) {
          Object.defineProperty(fnError, SWITCH_OFF_ERROR_KEY, {
            value: switchOffError,
            enumerable: false,
            configurable: true,
          });
        }
      } catch {
        // Best-effort only (e.g. a frozen error object) — never let stashing
        // these extras mask fn's original error.
      }
    }
    throw fnError;
  }

  return {
    value: result as T,
    authTrace,
    ...(switchOffError !== undefined ? { switchOffError } : {}),
  };
}

/** Reads the `switchOffError` a `withAuthTrace` call may have stashed on a rethrown error object. Returns undefined for anything else. */
export function switchOffErrorOf(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const v = (e as Record<string, unknown>)[SWITCH_OFF_ERROR_KEY];
  return typeof v === "string" ? v : undefined;
}

/** Reads the {@link AuthTraceOutcome} a `withAuthTrace` call may have stashed on a rethrown error object (when `fn` itself threw). Returns undefined for anything else. */
export function authTraceOf(e: unknown): AuthTraceOutcome | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const v = (e as Record<string, unknown>)[AUTH_TRACE_KEY];
  return v === undefined ? undefined : (v as AuthTraceOutcome);
}
