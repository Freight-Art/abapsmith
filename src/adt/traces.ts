/**
 * ABAP-trace (SAT) over ADT — the I/O layer.
 *
 * Composes `traces-query.ts` (paths, ids, request/parameters bodies — see
 * that module's header for the three-request choreography: parameters POST
 * → request POST → the traced call itself → read back by id) and
 * `traces-xml.ts` (parsing). No second URL builder or parser lives here.
 *
 * Every wire fact below (URLs, query strings, headers, status/body shapes)
 * was verified live against an A4H appliance (SAP_BASIS 754) on 2026-09-15.
 *
 * ## Mutating calls: exactly four
 *
 * This module is one of the modules `test/safety-gate-contract.test.ts` and
 * `test/journal-contract.test.ts` pin the mutating-call count for. There are
 * **exactly four** calls to the connection's raw `post`/`del` helpers in this
 * file: {@link createTraceParameters} (1 post), {@link createTraceRequest}
 * (1 post), {@link deleteTraceRequest} (1 del), {@link deleteTraceRun}
 * (1 del). Those helpers route through `AbapConnection`'s private `raw()`,
 * which carries the `READ_ONLY` guard — nothing here bypasses it. Do not add
 * a fifth mutating call to this file without updating those two contract
 * tests (out of scope here — this file does not touch tests).
 *
 * ## Journalling lives one level up
 *
 * This module writes no journal entries itself. Exactly as `adt/write.ts` is
 * journalled by `tools/write.ts`, the trace entry point in `src/tools/trace.ts`
 * is responsible for recording what this module created/deleted.
 *
 * ## A trace request outlives its own usefulness
 *
 * A trace request (`CreateTraceRequestInput`/{@link createTraceRequest}) is
 * scoped to exactly one technical user and one object URL — see
 * `buildCreateRequestQuery`'s doc comment in `traces-query.ts` for why the
 * object scoping matters. Verified live: a request that had already reached
 * `maximalExecutions=1` with `completedExecutions=1` (i.e. fully consumed —
 * see {@link TraceRequestSummary}) was STILL listed by
 * {@link listTraceRequests} afterwards; SAT does not retire a spent request
 * on its own. A caller that creates requests in a loop must
 * {@link deleteTraceRequest} each one it no longer needs, or the request list
 * accumulates indefinitely (mirrors ATC's undeletable-worklist litter problem
 * in `atc.ts`'s module header, though here the DELETE verb itself works).
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import { adtExceptionInfo, type ErrorContext, translateAdtError } from "./session.js";
import {
  ABAPTRACES_BASE,
  ABAPTRACES_PARAMETERS_BASE,
  ABAPTRACES_REQUESTS_BASE,
  type CreateTraceRequestInput,
  type TraceOptions,
  buildCreateRequestQuery,
  buildTraceParametersXml,
  normaliseTraceRequestId,
  normaliseTraceRunId,
} from "./traces-query.js";
import {
  type TraceDbAccess,
  type TraceHitEntry,
  type TraceRequestSummary,
  type TraceRunSummary,
  type TraceStatementNode,
  type TraceTableInfo,
  parseTraceDbAccesses,
  parseTraceHitList,
  parseTraceRequests,
  parseTraceRuns,
  parseTraceStatements,
} from "./traces-xml.js";

// ------------------------------------------------------------------ errors ---

/** Context for {@link classifyTraceFailure}. */
export interface TraceErrorContext extends ErrorContext {
  /** The trace run id in play, when the failing request carried one. */
  readonly traceId?: string;
  /** The trace request id in play, when the failing request carried one. */
  readonly requestId?: string;
  /** The technical user a list/create call was scoped to. */
  readonly traceUser?: string;
}

/**
 * Turn a transport-level failure into something whose hint is about ABAP
 * runtime tracing, following {@link classifyAtcFailure}'s structure in
 * `atc.ts`: `translateAdtError` runs first; only ambiguous `ADT_ERROR`/
 * `NOT_FOUND` results are refined below — anything else (`LOCKED`,
 * `SESSION_DEAD`, …) is already decided and stands.
 *
 * Status is read from {@link adtExceptionInfo} on the original throwable,
 * not `err.details.status` — copying `atc.ts`'s `atcFailureStatus` helper,
 * because `translateAdtError` only populates `details.status` on its own
 * generic `ADT_ERROR` branch, which would skip refinement on the `NOT_FOUND`
 * branch entirely.
 */
export function classifyTraceFailure(e: unknown, ctx: TraceErrorContext): AbapError {
  const err = translateAdtError(e, ctx);
  if (err.code !== "ADT_ERROR" && err.code !== "NOT_FOUND") return err;

  const info = adtExceptionInfo(e);
  const status =
    info?.status ?? (typeof err.details.status === "number" ? err.details.status : undefined);
  const message = info?.message ?? "";
  const props = info?.properties ?? {};
  const extra = { ...err.details, ...(status === undefined ? {} : { status }) };

  // 1. Unknown trace id. Live capture: message "Trace file ... does not
  // exist", properties `{"T100KEY-ID":"ATRAPI","T100KEY-NO":"13","T100KEY-V1":"0"}`.
  if (
    ctx.traceId !== undefined &&
    status === 404 &&
    (props["T100KEY-ID"] === "ATRAPI" || /trace file.*does not exist/i.test(message))
  ) {
    return new AbapError(
      "NOT_FOUND",
      `Trace ${ctx.traceId} does not exist on this system.`,
      { ...extra, traceId: ctx.traceId },
      'Run abap_trace with op="list" to see the trace ids that still exist. Traces expire and ' +
        "are deleted by the system on its own schedule, so an id from an earlier answer can " +
        "already be gone.",
    );
  }

  // 2. Unknown request id, seen on DELETE. Live capture: message "Resource
  // does not exist.", properties `{"T100KEY-ID":"SADT_RESOURCE","T100KEY-NO":"2"}`.
  if (
    ctx.requestId !== undefined &&
    status === 404 &&
    (props["T100KEY-ID"] === "SADT_RESOURCE" || /resource\s*does not exist/i.test(message))
  ) {
    return new AbapError(
      "NOT_FOUND",
      `Trace request ${ctx.requestId} does not exist on this system.`,
      { ...extra, requestId: ctx.requestId },
      'Run abap_trace with op="list" and kind="requests" to see the request ids that still exist.',
    );
  }

  // 3. `/statements` on an aggregated trace. `assertTreeViewAllowed` in
  // traces-query.ts normally refuses this client-side before any request is
  // sent, so reaching this branch means the aggregation flag was not known
  // up front (e.g. a caller read the trace id from elsewhere and skipped the
  // pre-check) — this is the backstop for that pre-check, not the primary
  // guard. Live capture: HTTP 400,
  // `com.sap.adt.communicationFramework.subType: invalidRequestForAggregatedTraces`.
  if (status === 400 && /invalidRequestForAggregatedTraces/i.test(message)) {
    return new AbapError(
      "BAD_INPUT",
      `Trace ${ctx.traceId ?? "this trace"} was recorded with 'aggregate' on, so it has no call tree to read.`,
      { ...extra, ...(ctx.traceId === undefined ? {} : { traceId: ctx.traceId }), aggregate: true },
      "Start a new trace with aggregate=false to get a call tree; an aggregated trace only " +
        "supports the hitlist and db views.",
    );
  }

  // 4. 403 — tracing has its own authorisation objects (S_ADMI_FCD /
  // S_DEVELOP trace authority), separate from ordinary developer rights.
  // `atc.ts`'s own 403 branch (`classifyAtcFailure`) answers `ADT_ERROR`,
  // not an `AUTH_*` code, so this matches that rather than inventing one.
  if (status === 403) {
    return new AbapError(
      "ADT_ERROR",
      "The server refused the ABAP trace request (HTTP 403).",
      extra,
      "ABAP runtime tracing has its own authorisation objects (S_ADMI_FCD / S_DEVELOP trace " +
        "authority), granted separately from the developer authority that lets you display or " +
        "run the traced object. Being able to run a program does not imply being allowed to " +
        "record or read a trace over it.",
    );
  }

  // 5. 404 on the collection itself, as opposed to on a specific id (both
  // #1 and #2 above already claimed the id-scoped 404s).
  if (status === 404 && ctx.traceId === undefined && ctx.requestId === undefined) {
    return new AbapError(
      "UNSUPPORTED",
      `This system does not serve ${ctx.uri ?? "ABAP runtime traces"} (HTTP 404).`,
      extra,
      "This release does not expose ABAP trace (SAT) over ADT. There is no fallback and no " +
        "other path to it from here.",
    );
  }

  return err;
}

// -------------------------------------------------------------- headers ---

/** Case-insensitive header lookup — `res.headers` keys may already be lower-cased. */
function responseHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  if (key === undefined) return undefined;
  const value = headers[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

// -------------------------------------------------------------------- Accept ---

/**
 * `Accept` for `/statements` — without it the server does not answer with
 * the aggregated call-tree representation {@link parseTraceStatements} parses.
 */
const STATEMENTS_ACCEPT =
  "application/vnd.sap.adt.runtime.traces.abaptraces.aggcalltree+xml, application/xml";

// ------------------------------------------------------------------ lists ---

/** `GET /sap/bc/adt/runtime/traces/abaptraces?user=…` → {@link parseTraceRuns}. */
export async function listTraceRuns(
  conn: AbapConnection,
  user: string,
): Promise<TraceRunSummary[]> {
  conn.discovery.assertSupported("traces.abaptraces", "ABAP runtime tracing");
  const ctx: TraceErrorContext = {
    operation: "traces.listRuns",
    uri: ABAPTRACES_BASE,
    traceUser: user,
  };
  let body: string;
  try {
    ({ body } = await conn.get(ABAPTRACES_BASE, { qs: { user: user.toUpperCase() } }));
  } catch (e) {
    throw classifyTraceFailure(e, ctx);
  }
  return parseTraceRuns(body);
}

/** `GET /sap/bc/adt/runtime/traces/abaptraces/requests?user=…` → {@link parseTraceRequests}. */
export async function listTraceRequests(
  conn: AbapConnection,
  user: string,
): Promise<TraceRequestSummary[]> {
  conn.discovery.assertSupported("traces.abaptraces", "ABAP runtime tracing");
  const ctx: TraceErrorContext = {
    operation: "traces.listRequests",
    uri: ABAPTRACES_REQUESTS_BASE,
    traceUser: user,
  };
  let body: string;
  try {
    ({ body } = await conn.get(ABAPTRACES_REQUESTS_BASE, { qs: { user: user.toUpperCase() } }));
  } catch (e) {
    throw classifyTraceFailure(e, ctx);
  }
  return parseTraceRequests(body);
}

/**
 * `GET /sap/bc/adt/runtime/traces/abaptraces/{id}` (no query string). The
 * response is a bare `atom:entry`, which {@link parseTraceRuns} already
 * handles as a one-element array — take `[0]`. An empty array (the id
 * resolved but the document carried no entry) is reported as `NOT_FOUND`
 * here rather than as an index-out-of-bounds crash.
 */
export async function readTraceRun(conn: AbapConnection, traceId: string): Promise<TraceRunSummary> {
  conn.discovery.assertSupported("traces.abaptraces", "ABAP runtime tracing");
  const url = normaliseTraceRunId(traceId);
  const ctx: TraceErrorContext = { operation: "traces.readRun", uri: url, traceId };
  let body: string;
  try {
    ({ body } = await conn.get(url));
  } catch (e) {
    throw classifyTraceFailure(e, ctx);
  }
  const runs = parseTraceRuns(body);
  const run = runs[0];
  if (run === undefined) {
    throw new AbapError(
      "NOT_FOUND",
      `Trace ${traceId} does not exist on this system.`,
      { traceId, uri: url },
      'Run abap_trace with op="list" to see the trace ids that still exist. Traces expire and ' +
        "are deleted by the system on its own schedule.",
    );
  }
  return run;
}

// -------------------------------------------------------------- sub-views ---

/** `GET …/abaptraces/{id}/hitlist?withSystemEvents=…` → {@link parseTraceHitList}. */
export async function fetchTraceHitList(
  conn: AbapConnection,
  traceId: string,
  withSystemEvents?: boolean,
): Promise<{ parentId: string; entries: TraceHitEntry[] }> {
  conn.discovery.assertSupported("traces.abaptraces", "ABAP runtime tracing");
  const url = `${normaliseTraceRunId(traceId)}/hitlist`;
  const ctx: TraceErrorContext = { operation: "traces.hitlist", uri: url, traceId };
  let body: string;
  try {
    ({ body } = await conn.get(url, {
      qs: { withSystemEvents: String(withSystemEvents ?? false) },
    }));
  } catch (e) {
    throw classifyTraceFailure(e, ctx);
  }
  return parseTraceHitList(body);
}

/**
 * `GET …/abaptraces/{id}/dbAccesses?withSystemEvents=…` → {@link parseTraceDbAccesses}.
 * Note the camelCase capital `A` in `dbAccesses` — that is the real path,
 * verified live.
 */
export async function fetchTraceDbAccesses(
  conn: AbapConnection,
  traceId: string,
  withSystemEvents?: boolean,
): Promise<{
  parentId: string;
  totalDbTime: number;
  accesses: TraceDbAccess[];
  tables: TraceTableInfo[];
}> {
  conn.discovery.assertSupported("traces.abaptraces", "ABAP runtime tracing");
  const url = `${normaliseTraceRunId(traceId)}/dbAccesses`;
  const ctx: TraceErrorContext = { operation: "traces.dbAccesses", uri: url, traceId };
  let body: string;
  try {
    ({ body } = await conn.get(url, {
      qs: { withSystemEvents: String(withSystemEvents ?? false) },
    }));
  } catch (e) {
    throw classifyTraceFailure(e, ctx);
  }
  return parseTraceDbAccesses(body);
}

/**
 * `GET …/abaptraces/{id}/statements`, no query string, with
 * {@link STATEMENTS_ACCEPT} → {@link parseTraceStatements}.
 */
export async function fetchTraceStatements(
  conn: AbapConnection,
  traceId: string,
): Promise<{ parentId: string; count: number; statements: TraceStatementNode[] }> {
  conn.discovery.assertSupported("traces.abaptraces", "ABAP runtime tracing");
  const url = `${normaliseTraceRunId(traceId)}/statements`;
  const ctx: TraceErrorContext = { operation: "traces.statements", uri: url, traceId };
  let body: string;
  try {
    ({ body } = await conn.get(url, { headers: { Accept: STATEMENTS_ACCEPT } }));
  } catch (e) {
    throw classifyTraceFailure(e, ctx);
  }
  return parseTraceStatements(body);
}

// ---------------------------------------------------------------- create ---

/**
 * `POST /sap/bc/adt/runtime/traces/abaptraces/parameters` with
 * `Content-Type: application/xml` and {@link buildTraceParametersXml}'s body.
 * The server answers 200 with an EMPTY body and the parameters id in the
 * `location` response header — read case-insensitively since `res.headers`
 * keys may already be lower-cased. Never returns `undefined`: a missing or
 * non-string `location` is an `ADT_ERROR`, because without that id there is
 * nothing for {@link createTraceRequest} to reference.
 */
export async function createTraceParameters(
  conn: AbapConnection,
  options: TraceOptions,
): Promise<string> {
  conn.discovery.assertSupported("traces.abaptraces", "ABAP runtime tracing");
  const url = ABAPTRACES_PARAMETERS_BASE;
  const ctx: TraceErrorContext = { operation: "traces.createParameters", uri: url };
  const body = buildTraceParametersXml(options);
  let headers: Record<string, unknown>;
  try {
    ({ headers } = await conn.post(url, {
      headers: { "Content-Type": "application/xml" },
      body,
    }));
  } catch (e) {
    throw classifyTraceFailure(e, ctx);
  }
  const location = responseHeader(headers, "location");
  if (location === undefined || location === "") {
    throw new AbapError(
      "ADT_ERROR",
      "Creating ABAP trace parameters did not return a 'location' header naming the parameters id.",
      { uri: url },
      "This endpoint answers 200 with an empty body and puts the parameters id in the response's " +
        "'location' header. Without it there is nothing to pass as parametersId to the trace-" +
        "request POST — retry once; if it repeats, the parameters document itself may have been " +
        "rejected silently.",
    );
  }
  return location;
}

/**
 * `POST /sap/bc/adt/runtime/traces/abaptraces/requests?…` with
 * {@link buildCreateRequestQuery}'s query string and no body. The response
 * body is a request FEED (not a bare id) — parsed with
 * {@link parseTraceRequests} and the single echoed-back entry returned.
 */
export async function createTraceRequest(
  conn: AbapConnection,
  input: CreateTraceRequestInput,
): Promise<TraceRequestSummary> {
  conn.discovery.assertSupported("traces.abaptraces", "ABAP runtime tracing");
  const url = ABAPTRACES_REQUESTS_BASE;
  const ctx: TraceErrorContext = {
    operation: "traces.createRequest",
    uri: url,
    traceUser: input.traceUser,
  };
  let body: string;
  try {
    ({ body } = await conn.post(url, { qs: buildCreateRequestQuery(input) }));
  } catch (e) {
    throw classifyTraceFailure(e, ctx);
  }
  const requests = parseTraceRequests(body);
  const created = requests[0];
  if (created === undefined) {
    throw new AbapError(
      "ADT_ERROR",
      "Creating the ABAP trace request returned no request entry.",
      { uri: url },
      "This endpoint answers with a feed containing the just-created request; an empty feed " +
        "means the server accepted the call but echoed nothing back to reference, so the request " +
        "cannot be tracked or deleted later.",
    );
  }
  return created;
}

// ---------------------------------------------------------------- delete ---

/** `DELETE` a trace request by id. */
export async function deleteTraceRequest(conn: AbapConnection, requestId: string): Promise<void> {
  conn.discovery.assertSupported("traces.abaptraces", "ABAP runtime tracing");
  const url = normaliseTraceRequestId(requestId);
  const ctx: TraceErrorContext = { operation: "traces.deleteRequest", uri: url, requestId };
  try {
    await conn.del(url);
  } catch (e) {
    throw classifyTraceFailure(e, ctx);
  }
}

/** `DELETE` a trace run by id. */
export async function deleteTraceRun(conn: AbapConnection, traceId: string): Promise<void> {
  conn.discovery.assertSupported("traces.abaptraces", "ABAP runtime tracing");
  const url = normaliseTraceRunId(traceId);
  const ctx: TraceErrorContext = { operation: "traces.deleteRun", uri: url, traceId };
  try {
    await conn.del(url);
  } catch (e) {
    throw classifyTraceFailure(e, ctx);
  }
}

// ------------------------------------------------------------------ await ---

export interface AwaitTraceOptions {
  /** How many list polls to try before giving up. Default 5. */
  readonly attempts?: number;
  /** Delay between polls, not applied after the last attempt. Default 400ms. */
  readonly delayMs?: number;
}

/** {@link awaitNewTraceRun}'s default poll budget — see its doc comment for the measurement behind it. */
const AWAIT_TRACE_DEFAULT_ATTEMPTS = 5;
const AWAIT_TRACE_DEFAULT_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t: unknown = setTimeout(resolve, ms);
    (t as { unref?: () => void })?.unref?.();
  });
}

/**
 * Poll {@link listTraceRuns} until a run appears that was not already in
 * `knownIds`, returning the newest such run by `published` (or `undefined`
 * if none showed up within the budget). Deliberately a SHORT bounded retry,
 * not long polling: a live timing run of the full choreography (parameters
 * POST → request POST → the traced classrun POST → list) measured parameters
 * +96 ms, request +350 ms, classrun +784 ms, and the FIRST list poll —
 * at +943 ms — already showed the finished trace. Defaults of 5 attempts /
 * 400 ms are generous headroom over that single observed data point, not a
 * tuned SLA.
 *
 * Sleeps between attempts but not after the last one, so a caller who wants
 * `attempts=1` (a single immediate check) pays no wasted delay.
 */
export async function awaitNewTraceRun(
  conn: AbapConnection,
  user: string,
  knownIds: ReadonlySet<string>,
  opts: AwaitTraceOptions = {},
): Promise<TraceRunSummary | undefined> {
  const attempts = opts.attempts ?? AWAIT_TRACE_DEFAULT_ATTEMPTS;
  const delayMs = opts.delayMs ?? AWAIT_TRACE_DEFAULT_DELAY_MS;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const runs = await listTraceRuns(conn, user);
    const fresh = runs.filter((r) => !knownIds.has(r.id));
    if (fresh.length > 0) {
      fresh.sort((a, b) => (a.published < b.published ? 1 : a.published > b.published ? -1 : 0));
      return fresh[0];
    }
    if (attempt < attempts - 1) {
      await sleep(delayMs);
    }
  }
  return undefined;
}
