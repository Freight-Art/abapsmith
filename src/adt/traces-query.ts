/**
 * ABAP-trace (SAT) request building — pure functions, no socket, no XML
 * parser. Modelled on `src/adt/atc-query.ts` and `src/adt/dumps-query.ts`:
 * this module only decides what a request should look like; `connection.ts`
 * (never imported here) is what actually sends it.
 *
 * SAT traces are created in three requests, mirroring ATC's worklist/run
 * split:
 *   1. `POST /runtime/traces/abaptraces/parameters` + `<trc:parameters>` body
 *      → a `location` header naming the parameters set just created (see
 *      {@link buildTraceParametersXml}).
 *   2. `POST /runtime/traces/abaptraces/requests?…` naming the object to
 *      trace, the parameters set from step 1, and an expiry — the actual
 *      trace request (see {@link buildCreateRequestQuery}).
 *   3. The traced request itself runs (e.g. a classrun POST), then the trace
 *      is read back by id (`GET /runtime/traces/abaptraces/{id}` or its
 *      `/statements` sub-resource for a call tree).
 *
 * Every wire fact below was verified live against an A4H appliance on
 * 2026-09-15; each function says which finding backs it.
 */

import { AbapError } from "./errors.js";
import { CLASSRUN_PATH, assertPlainName } from "./run.js";

// ------------------------------------------------------------------ paths ---

export const ABAPTRACES_BASE = "/sap/bc/adt/runtime/traces/abaptraces";
export const ABAPTRACES_REQUESTS_BASE = `${ABAPTRACES_BASE}/requests`;
export const ABAPTRACES_PARAMETERS_BASE = `${ABAPTRACES_BASE}/parameters`;

/**
 * The standalone SQL-trace collection. UNVERIFIED as a working resource on
 * this release: `GET /sap/bc/adt/runtime/traces/sqltraces` on A4H answered
 * "Resource /sap/bc/adt/runtime/traces/sqltraces does not exist.", and the
 * ADT discovery document served there does not advertise `traces.sqltraces`
 * at all. On A4H, SQL tracing is reachable only as the `sqlTrace` flag inside
 * the ABAP-trace parameters document (see {@link TraceOptions.sqlTrace}), not
 * through this path. Kept as a named constant so a caller on a release where
 * it does exist has something to point at, not as a claim that it works here.
 */
export const SQLTRACES_BASE = "/sap/bc/adt/runtime/traces/sqltraces";

// -------------------------------------------------------------- op/view ---

export const TRACE_OPS = ["start", "run", "list", "read", "delete"] as const;
export type TraceOp = (typeof TRACE_OPS)[number];

export const TRACE_VIEWS = ["hitlist", "db", "tree"] as const;
export type TraceView = (typeof TRACE_VIEWS)[number];

export const TRACE_LIST_KINDS = ["runs", "requests"] as const;
export type TraceListKind = (typeof TRACE_LIST_KINDS)[number];

// ------------------------------------------------------------- constants ---

export const TRACE_DEFAULT_TOP = 20;
export const TRACE_MAX_TOP = 100;
export const TRACE_DEFAULT_TREE_DEPTH = 4;
export const TRACE_MAX_TREE_DEPTH = 12;
export const TRACE_DEFAULT_MAX_SIZE_KB = 30_720;
export const TRACE_MAX_SIZE_KB = 102_400;
export const TRACE_DEFAULT_MAX_SECONDS = 600;
export const TRACE_MAX_SECONDS = 1_800;
export const TRACE_DEFAULT_EXECUTIONS = 1;
export const TRACE_MAX_EXECUTIONS = 5;

/** How far ahead a created trace request is set to expire. */
export const TRACE_REQUEST_TTL_MS = 60 * 60 * 1000;

// ------------------------------------------------------------- parameters ---

export interface TraceOptions {
  description: string;
  aggregate: boolean;
  sqlTrace: boolean;
  allDbEvents: boolean;
  allProceduralUnits: boolean;
  allInternalTableEvents: boolean;
  allMiscAbapStatements: boolean;
  allDynproEvents: boolean;
  allSystemKernelEvents: boolean;
  withRfcTracing: boolean;
  explicitOnOff: boolean;
  maxSizeForTraceFile: number;
  maxTimeForTracing: number;
}

/** Defaults a caller gets when they pass no options at all. */
export const TRACE_DEFAULT_OPTIONS: TraceOptions = Object.freeze({
  description: "abapsmith trace",
  aggregate: true,
  sqlTrace: true,
  allDbEvents: true,
  allProceduralUnits: true,
  allInternalTableEvents: false,
  allMiscAbapStatements: false,
  allDynproEvents: false,
  allSystemKernelEvents: false,
  withRfcTracing: false,
  explicitOnOff: false,
  maxSizeForTraceFile: TRACE_DEFAULT_MAX_SIZE_KB,
  maxTimeForTracing: TRACE_DEFAULT_MAX_SECONDS,
}) as TraceOptions;

/** SAP's description field is short; longer text is refused, not silently cut, so a caller notices. */
const DESCRIPTION_MAX_LEN = 60;

/**
 * Escapes the five XML-significant characters for use inside a double-quoted
 * attribute value. `description` goes into `<trc:description value="…">` as
 * an ATTRIBUTE, not element text — an unescaped `"` or `<` in it would break
 * the document (close the attribute early, or open a bogus tag), so every
 * description is passed through this before being spliced in.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Rejects ASCII control characters (0x00-0x1F, 0x7F) — none are legal in an XML attribute value. */
function hasControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1F\x7F]/.test(value);
}

function assertDescription(description: string): string {
  if (typeof description !== "string" || description.trim() === "") {
    throw new AbapError(
      "BAD_INPUT",
      "A trace needs a description.",
      { description },
      "Pass a short, human-readable label — it is shown back in worklist listings.",
    );
  }
  if (hasControlChars(description)) {
    throw new AbapError(
      "BAD_INPUT",
      "The trace description contains control characters, which are not legal in an XML attribute.",
      { description },
      "Use plain printable text.",
    );
  }
  if (description.length > DESCRIPTION_MAX_LEN) {
    throw new AbapError(
      "BAD_INPUT",
      `The trace description is ${description.length} characters; SAP's field holds at most ${DESCRIPTION_MAX_LEN}.`,
      { description, length: description.length, max: DESCRIPTION_MAX_LEN },
      `Shorten the description to ${DESCRIPTION_MAX_LEN} characters or fewer.`,
    );
  }
  return description;
}

const boolAttr = (name: string, value: boolean): string =>
  `    <trc:${name} value="${value ? "true" : "false"}"></trc:${name}>\n`;

/**
 * Builds the `<trc:parameters>` document POSTed to
 * {@link ABAPTRACES_PARAMETERS_BASE}. Element ORDER matters to the server —
 * this reproduces exactly the order captured from a working live request;
 * reordering elements is not known to be safe and is not attempted here.
 *
 * Booleans render as the bare literals `true`/`false`; numbers render bare
 * (no unit suffix). `description` is the one attribute carrying caller text,
 * so it alone goes through {@link escapeAttr} — an unescaped description
 * (e.g. containing `"` or `<`) would otherwise break the document.
 */
export function buildTraceParametersXml(options: TraceOptions): string {
  const description = assertDescription(options.description);
  const body =
    boolAttr("allMiscAbapStatements", options.allMiscAbapStatements) +
    boolAttr("allProceduralUnits", options.allProceduralUnits) +
    boolAttr("allInternalTableEvents", options.allInternalTableEvents) +
    boolAttr("allDynproEvents", options.allDynproEvents) +
    `    <trc:description value="${escapeAttr(description)}"></trc:description>\n` +
    boolAttr("aggregate", options.aggregate) +
    boolAttr("explicitOnOff", options.explicitOnOff) +
    boolAttr("withRfcTracing", options.withRfcTracing) +
    boolAttr("allSystemKernelEvents", options.allSystemKernelEvents) +
    boolAttr("sqlTrace", options.sqlTrace) +
    boolAttr("allDbEvents", options.allDbEvents) +
    `    <trc:maxSizeForTraceFile value="${options.maxSizeForTraceFile}"></trc:maxSizeForTraceFile>\n` +
    `    <trc:maxTimeForTracing value="${options.maxTimeForTracing}"></trc:maxTimeForTracing>\n`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<trc:parameters xmlns:trc="http://www.sap.com/adt/runtime/traces/abaptraces">\n' +
    body +
    "</trc:parameters>"
  );
}

// -------------------------------------------------------------- classrun ---

/**
 * `/sap/bc/adt/oo/classrun/<CLASSNAME-UPPERCASED>` — the URL a traced
 * classrun POST hits. Reuses {@link CLASSRUN_PATH} from `run.ts` (rather than
 * re-spelling the path here) so the two can never drift apart — see the
 * comment at `run.ts:262`. The class name must be upper-cased in the URL, and
 * must first pass {@link assertPlainName}'s injection guard: this URL becomes
 * `objectName` in {@link buildCreateRequestQuery}, and from there flows into
 * an SAP request the server treats as the scope of the trace.
 */
export function classrunScopeUri(className: string): string {
  const canon = assertPlainName(className, "Class name").toUpperCase();
  return `${CLASSRUN_PATH}${canon}`;
}

// ------------------------------------------------------------- id parsing ---

/** A bare 32-hex trace run id, as SAT hands them out. */
const TRACE_RUN_ID_RE = /^[0-9A-Fa-f]{32}$/;

/**
 * Accepts a bare 32-hex id or a full `/sap/bc/adt/runtime/traces/abaptraces/<id>`
 * path; returns the full path either way, so callers can pass either form
 * without repeating this prefix check at every call site.
 */
export function normaliseTraceRunId(raw: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (TRACE_RUN_ID_RE.test(value)) return `${ABAPTRACES_BASE}/${value}`;
  const prefix = `${ABAPTRACES_BASE}/`;
  if (value.startsWith(prefix) && TRACE_RUN_ID_RE.test(value.slice(prefix.length))) {
    return value;
  }
  throw new AbapError(
    "BAD_INPUT",
    `"${raw}" is not a usable ABAP-trace run id.`,
    { traceId: raw },
    `Pass either the bare 32-hex id or the full path returned by a previous list/read, e.g. ${ABAPTRACES_BASE}/<32-hex-id>.`,
  );
}

/**
 * A bare trace-request id, e.g. `4%2c20260915023824` — a small integer, a
 * literal `%2c` (percent-encoded comma) or `,`, then a 14-digit timestamp.
 * Accepted either percent-encoded or with a literal comma, since both forms
 * have been seen echoed back by the server.
 */
const TRACE_REQUEST_ID_RE = /^\d+(?:%2c|%2C|,)\d{14}$/;

/**
 * Accepts a bare `4%2c20260915023824`-style id or a full requests path;
 * returns the full path either way.
 */
export function normaliseTraceRequestId(raw: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (TRACE_REQUEST_ID_RE.test(value)) return `${ABAPTRACES_REQUESTS_BASE}/${value}`;
  const prefix = `${ABAPTRACES_REQUESTS_BASE}/`;
  if (value.startsWith(prefix) && TRACE_REQUEST_ID_RE.test(value.slice(prefix.length))) {
    return value;
  }
  throw new AbapError(
    "BAD_INPUT",
    `"${raw}" is not a usable ABAP-trace request id.`,
    { requestId: raw },
    `Pass either the bare id (e.g. 4%2c20260915023824) or the full path returned by a previous ` +
      `create/list, e.g. ${ABAPTRACES_REQUESTS_BASE}/<id>.`,
  );
}

// --------------------------------------------------------- create request ---

export interface CreateTraceRequestInput {
  description: string;
  traceUser: string;
  traceClient: string;
  /** e.g. `classrunScopeUri("ZCL_FOO")`. */
  objectName: string;
  /** The `location` header from the parameters POST. */
  parametersId: string;
  maximalExecutions: number;
  expires: Date;
}

/**
 * Query string for `POST /sap/bc/adt/runtime/traces/abaptraces/requests`.
 * All values are returned as strings, ready to hand to `URLSearchParams`.
 *
 * `objectName` is undocumented in `abap-adt-api` but required in practice:
 * without it the trace request is unscoped and captures abapsmith's OWN ADT
 * traffic instead of the traced object's, and a single run then consumes
 * every allowed execution on noise. Verified live: a scoped request (this
 * field set to a classrun URL) produced exactly one trace, whose own
 * `objectName` echoed back that same classrun URL.
 */
export function buildCreateRequestQuery(input: CreateTraceRequestInput): Record<string, string> {
  return {
    server: "*",
    description: input.description,
    traceUser: input.traceUser.toUpperCase(),
    traceClient: input.traceClient,
    processType: `${ABAPTRACES_BASE}/processtypes/http`,
    objectType: `${ABAPTRACES_BASE}/objecttypes/url`,
    objectName: input.objectName,
    expires: input.expires.toISOString(),
    maximalExecutions: String(input.maximalExecutions),
    parametersId: input.parametersId,
  };
}

// ------------------------------------------------------------------ range ---

/** Clamp/validate a caller's `top`. */
export function resolveTop(raw: unknown): number {
  if (raw === undefined) return TRACE_DEFAULT_TOP;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
    throw new AbapError(
      "BAD_INPUT",
      `'top' must be a positive integer, got ${JSON.stringify(raw)}.`,
      { top: raw },
      `Omit 'top' to use the default of ${TRACE_DEFAULT_TOP}, or pass an integer from 1 to ${TRACE_MAX_TOP}.`,
    );
  }
  if (raw > TRACE_MAX_TOP) {
    throw new AbapError(
      "BAD_INPUT",
      `'top' of ${raw} exceeds the cap of ${TRACE_MAX_TOP} this client enforces.`,
      { top: raw, max: TRACE_MAX_TOP },
      `Pass 'top' no greater than ${TRACE_MAX_TOP}.`,
    );
  }
  return raw;
}

/** Clamp/validate a caller's `depth`. */
export function resolveTreeDepth(raw: unknown): number {
  if (raw === undefined) return TRACE_DEFAULT_TREE_DEPTH;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
    throw new AbapError(
      "BAD_INPUT",
      `'depth' must be a positive integer, got ${JSON.stringify(raw)}.`,
      { depth: raw },
      `Omit 'depth' to use the default of ${TRACE_DEFAULT_TREE_DEPTH}, or pass an integer from 1 to ${TRACE_MAX_TREE_DEPTH}.`,
    );
  }
  if (raw > TRACE_MAX_TREE_DEPTH) {
    throw new AbapError(
      "BAD_INPUT",
      `'depth' of ${raw} exceeds the cap of ${TRACE_MAX_TREE_DEPTH} this client enforces.`,
      { depth: raw, max: TRACE_MAX_TREE_DEPTH },
      `Pass 'depth' no greater than ${TRACE_MAX_TREE_DEPTH}.`,
    );
  }
  return raw;
}

function assertBoolOption(raw: unknown, snakeName: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") {
    throw new AbapError(
      "BAD_INPUT",
      `'${snakeName}' must be a boolean, got ${JSON.stringify(raw)}.`,
      { [snakeName]: raw },
      `Pass true or false for '${snakeName}'.`,
    );
  }
  return raw;
}

/**
 * Build a {@link TraceOptions} from raw snake_case tool args, applying
 * defaults and range checks. Only the options a caller can usefully steer
 * are read from `args`; `allMiscAbapStatements`, `allDynproEvents`,
 * `allSystemKernelEvents`, `withRfcTracing` and `explicitOnOff` are always
 * false and are NOT caller-settable — each multiplies trace size (dynpro
 * events, kernel events, misc ABAP statements) or changes trace semantics in
 * ways (RFC tracing, explicit on/off) that don't answer the questions this
 * tool asks (where does this call spend time / hit the database), so there
 * is no snake_case parameter for them to be reached through.
 */
export function resolveTraceOptions(
  args: Record<string, unknown>,
  defaultDescription: string,
): TraceOptions {
  const description =
    typeof args.description === "string" && args.description.trim() !== ""
      ? args.description
      : defaultDescription;

  const aggregate = assertBoolOption(args.aggregate, "aggregate") ?? true;
  const sqlTrace = assertBoolOption(args.sql_trace, "sql_trace") ?? true;
  const allDbEvents = assertBoolOption(args.db_events, "db_events") ?? true;
  const allProceduralUnits = assertBoolOption(args.procedural_units, "procedural_units") ?? true;
  const allInternalTableEvents = assertBoolOption(args.internal_tables, "internal_tables") ?? false;

  let maxSizeForTraceFile = TRACE_DEFAULT_MAX_SIZE_KB;
  if (args.max_size_kb !== undefined) {
    const raw = args.max_size_kb;
    if (
      typeof raw !== "number" ||
      !Number.isFinite(raw) ||
      !Number.isInteger(raw) ||
      raw < 1 ||
      raw > TRACE_MAX_SIZE_KB
    ) {
      throw new AbapError(
        "BAD_INPUT",
        `'max_size_kb' must be an integer from 1 to ${TRACE_MAX_SIZE_KB}, got ${JSON.stringify(raw)}.`,
        { max_size_kb: raw, max: TRACE_MAX_SIZE_KB },
        `Pass 'max_size_kb' between 1 and ${TRACE_MAX_SIZE_KB}, or omit it for the default of ${TRACE_DEFAULT_MAX_SIZE_KB}.`,
      );
    }
    maxSizeForTraceFile = raw;
  }

  let maxTimeForTracing = TRACE_DEFAULT_MAX_SECONDS;
  if (args.max_seconds !== undefined) {
    const raw = args.max_seconds;
    if (
      typeof raw !== "number" ||
      !Number.isFinite(raw) ||
      !Number.isInteger(raw) ||
      raw < 1 ||
      raw > TRACE_MAX_SECONDS
    ) {
      throw new AbapError(
        "BAD_INPUT",
        `'max_seconds' must be an integer from 1 to ${TRACE_MAX_SECONDS}, got ${JSON.stringify(raw)}.`,
        { max_seconds: raw, max: TRACE_MAX_SECONDS },
        `Pass 'max_seconds' between 1 and ${TRACE_MAX_SECONDS}, or omit it for the default of ${TRACE_DEFAULT_MAX_SECONDS}.`,
      );
    }
    maxTimeForTracing = raw;
  }

  return {
    description,
    aggregate,
    sqlTrace,
    allDbEvents,
    allProceduralUnits,
    allInternalTableEvents,
    // Always false — not caller-settable; see the doc comment above.
    allMiscAbapStatements: false,
    allDynproEvents: false,
    allSystemKernelEvents: false,
    withRfcTracing: false,
    explicitOnOff: false,
    maxSizeForTraceFile,
    maxTimeForTracing,
  };
}

/**
 * Refuses BEFORE the request when a tree view is asked of an aggregated
 * trace. Observed live: `GET {id}/statements` against an aggregated trace
 * answers HTTP 400 with `com.sap.adt.communicationFramework.subType:
 * invalidRequestForAggregatedTraces` — a call tree needs the individual call
 * events an aggregated trace has already collapsed away.
 */
export function assertTreeViewAllowed(isAggregated: boolean, traceId: string): void {
  if (!isAggregated) return;
  throw new AbapError(
    "BAD_INPUT",
    `Trace ${traceId} was recorded with 'aggregate' on, so it has no call tree to read.`,
    { traceId, aggregate: true, view: "tree" satisfies TraceView },
    "Start a new trace with aggregate=false to get a call tree; an aggregated trace only " +
      "supports the hitlist and db views.",
  );
}
