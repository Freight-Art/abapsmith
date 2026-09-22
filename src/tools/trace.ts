/**
 * `abap_trace` — ABAP runtime tracing (SAT) over ADT.
 *
 * Wraps the three-request choreography documented in `../adt/traces-query.ts`
 * (parameters POST → request POST → the traced call itself → read back by
 * id) behind five ops: `start`/`run` create a trace request (`run` also
 * executes the object and reads the result back in one call), `list`/`read`
 * are plain reads, `delete` removes a request or a run.
 *
 * `../adt/traces.ts` does the wire I/O and says explicitly that journalling
 * belongs one level up, here — see its module header. This file is that
 * "one level up".
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AbapConnection } from "../adt/connection.js";
import { AbapError } from "../adt/errors.js";
import { bridgeClassName } from "../adt/run.js";
import { resolveObject, type ResolvedObject } from "../adt/resolve.js";
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import { buildResponse, textTable, type BuiltResponse } from "../compact.js";
import {
  systemKey,
  withJournalledMutation,
  type BeforeImageCapture,
  type Journal,
  type JournalBeginInput,
  type JournalObjectRef,
} from "../journal.js";
import type { SafetyGate } from "../safety.js";
import {
  ABAPTRACES_BASE,
  ABAPTRACES_REQUESTS_BASE,
  TRACE_DEFAULT_EXECUTIONS,
  TRACE_LIST_KINDS,
  TRACE_MAX_EXECUTIONS,
  TRACE_MAX_SECONDS,
  TRACE_MAX_SIZE_KB,
  TRACE_MAX_TREE_DEPTH,
  TRACE_OPS,
  TRACE_REQUEST_TTL_MS,
  TRACE_VIEWS,
  assertTreeViewAllowed,
  classrunScopeUri,
  normaliseTraceRequestId,
  normaliseTraceRunId,
  resolveTop,
  resolveTraceOptions,
  resolveTreeDepth,
  type TraceListKind,
  type TraceOp,
  type TraceView,
} from "../adt/traces-query.js";
import {
  awaitNewTraceRun,
  createTraceParameters,
  createTraceRequest,
  deleteTraceRequest,
  deleteTraceRun,
  fetchTraceDbAccesses,
  fetchTraceHitList,
  fetchTraceStatements,
  listTraceRequests,
  listTraceRuns,
  readTraceRun,
} from "../adt/traces.js";
import type { TraceRequestSummary, TraceRunSummary, TraceStatementNode } from "../adt/traces-xml.js";
import { preflight } from "./preflight.js";
import { abapRun } from "./run.js";

// ------------------------------------------------------------------ schema ---

/**
 * The raw zod shape for `abap_trace` — exported for type inference
 * (`TraceInput` below) and so tests can rebuild the registered schema
 * directly. Never register this object itself: see the note on
 * `registerTraceTools` about why it must go through `z.looseObject(...)`.
 */
export const traceInputSchema = {
  op: z
    .enum(TRACE_OPS)
    .optional()
    .describe(`Operation. Default "run". One of: ${TRACE_OPS.join(", ")}.`),
  object: z
    .string()
    .optional()
    .describe("Class or report to trace. Required for op=start and op=run."),
  type: z.string().optional().describe("ADT type, e.g. CLAS/OC, when ambiguous. op=start/run only."),
  id: z
    .string()
    .optional()
    .describe(
      "A trace run id (op=read) or run/request id (op=delete); bare id or the full path a " +
        "previous list/create answered with.",
    ),
  kind: z
    .enum(TRACE_LIST_KINDS)
    .optional()
    .describe(`What to list. Default "runs". One of: ${TRACE_LIST_KINDS.join(", ")}. op=list only.`),
  view: z
    .enum(TRACE_VIEWS)
    .optional()
    .describe(`What to read. Default "hitlist". One of: ${TRACE_VIEWS.join(", ")}. op=read only.`),
  top: z
    .number()
    .int()
    .optional()
    .describe("Cap on rows shown. Default 20, max 100. op=read (hitlist/tree) and op=run only."),
  depth: z
    .number()
    .int()
    .optional()
    .describe(
      "Max call-tree depth relative to the traced object's own entry node. Default 4, max 12. " +
        "op=read view=tree only.",
    ),
  root: z
    .string()
    .optional()
    .describe(
      "Anchor the tree view at the first call-tree node matching this text (case-insensitive " +
        "substring on description or calling-program name), overriding the automatic entry-node " +
        "anchor. op=read view=tree only.",
    ),
  description: z
    .string()
    .optional()
    .describe("Short label for the trace request (max 60 chars). op=start/run only."),
  aggregate: z
    .boolean()
    .optional()
    .describe(
      "Aggregate repeated calls (no call tree afterwards). Default true. op=start/run only.",
    ),
  sql_trace: z.boolean().optional().describe("Record SQL statements. Default true. op=start/run only."),
  db_events: z.boolean().optional().describe("Record database events. Default true. op=start/run only."),
  procedural_units: z
    .boolean()
    .optional()
    .describe("Record procedural units (FORM/FUNCTION/METHOD calls). Default true. op=start/run only."),
  internal_tables: z
    .boolean()
    .optional()
    .describe("Record internal-table operations. Default false. op=start/run only."),
  max_size_kb: z
    .number()
    .int()
    .optional()
    .describe(`Trace file size cap in KB. Default 30720, max ${TRACE_MAX_SIZE_KB}. op=start/run only.`),
  max_seconds: z
    .number()
    .int()
    .optional()
    .describe(`Trace duration cap in seconds. Default 600, max ${TRACE_MAX_SECONDS}. op=start/run only.`),
  executions: z
    .number()
    .int()
    .optional()
    .describe(
      `How many executions the request stays armed for, default ${TRACE_DEFAULT_EXECUTIONS}, max ` +
        `${TRACE_MAX_EXECUTIONS}. op=start only — op=run always arms a single execution.`,
    ),
};

export const TraceInput = z.object(traceInputSchema);
export type TraceInput = z.infer<typeof TraceInput>;

const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(TraceInput.shape));

/** Refuse arguments this tool does not have — same pattern as `atc.ts`/`dumps.ts`. */
function rejectUnknownArgs(args: Record<string, unknown>): void {
  const unknown = Object.keys(args).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length === 0) return;
  throw new AbapError(
    "BAD_INPUT",
    `abap_trace does not take ${unknown.map((k) => `\`${k}\``).join(", ")}.`,
    { unknown, known: [...KNOWN_KEYS] },
    `Parameters are: ${[...KNOWN_KEYS].join(", ")}.`,
  );
}

const TRACE_OPTION_KEYS = [
  "description",
  "aggregate",
  "sql_trace",
  "db_events",
  "procedural_units",
  "internal_tables",
  "max_size_kb",
  "max_seconds",
] as const;

const OP_ALLOWED_KEYS: Readonly<Record<TraceOp, ReadonlySet<string>>> = {
  start: new Set(["object", "type", "executions", ...TRACE_OPTION_KEYS]),
  run: new Set(["object", "type", "top", ...TRACE_OPTION_KEYS]),
  list: new Set(["kind"]),
  read: new Set(["id", "view", "top", "depth", "root"]),
  delete: new Set(["id"]),
};

/** Keys that only mean something for `op="read"` `view="tree"`; refused under any other view. */
const TREE_ONLY_KEYS = ["depth", "root"] as const;

/** Reads and validates `op`, defaulting to `"run"`. Never touches the network. */
function resolveOp(args: Record<string, unknown>): TraceOp {
  const raw = args.op;
  if (raw === undefined) return "run";
  if (typeof raw === "string" && (TRACE_OPS as readonly string[]).includes(raw)) {
    return raw as TraceOp;
  }
  throw new AbapError(
    "BAD_INPUT",
    `abap_trace op must be one of ${TRACE_OPS.join(", ")}; got ${JSON.stringify(raw)}.`,
    { op: raw },
    `Pass op as one of: ${TRACE_OPS.join(", ")}.`,
  );
}

/** Op-specific key allowlist plus required-field checks. Zero network cost. */
function validateOpArgs(args: Record<string, unknown>, op: TraceOp): void {
  const allowed = OP_ALLOWED_KEYS[op];
  const irrelevant = Object.keys(args).filter(
    (k) => k !== "op" && args[k] !== undefined && !allowed.has(k),
  );
  if (irrelevant.length > 0) {
    throw new AbapError(
      "BAD_INPUT",
      `abap_trace op="${op}" does not take ${irrelevant.map((k) => `\`${k}\``).join(", ")}.`,
      { op, irrelevant },
      `Drop ${irrelevant.length === 1 ? "that parameter" : "those parameters"}, or pick the op that takes ${
        irrelevant.length === 1 ? "it" : "them"
      }.`,
    );
  }

  if ((op === "start" || op === "run") && typeof args.object !== "string") {
    throw new AbapError(
      "BAD_INPUT",
      `abap_trace op="${op}" needs \`object\`.`,
      { op },
      "Pass the class or report name to trace as `object`.",
    );
  }

  if (op === "read") {
    const view = args.view ?? "hitlist";
    const treeOnly = TREE_ONLY_KEYS.filter((k) => args[k] !== undefined);
    if (view !== "tree" && treeOnly.length > 0) {
      throw new AbapError(
        "BAD_INPUT",
        `abap_trace op="read" view="${String(view)}" does not take ${treeOnly
          .map((k) => `\`${k}\``)
          .join(", ")}; ${treeOnly.length === 1 ? "it applies" : "they apply"} to view="tree" only.`,
        { op, view, irrelevant: treeOnly },
        `Drop ${treeOnly.length === 1 ? "that parameter" : "those parameters"}, or pass view="tree".`,
      );
    }
  }

  if ((op === "read" || op === "delete") && typeof args.id !== "string") {
    throw new AbapError(
      "BAD_INPUT",
      `abap_trace op="${op}" needs \`id\`.`,
      { op },
      op === "read"
        ? 'Pass a trace run id as `id` — see op="list" for ids that still exist.'
        : 'Pass a trace run or request id as `id` — see op="list" for ids that still exist.',
    );
  }
}

function resolveExecutions(raw: unknown): number {
  if (raw === undefined) return TRACE_DEFAULT_EXECUTIONS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
    throw new AbapError(
      "BAD_INPUT",
      `'executions' must be a positive integer, got ${JSON.stringify(raw)}.`,
      { executions: raw },
      `Omit 'executions' to use the default of ${TRACE_DEFAULT_EXECUTIONS}, or pass 1 to ${TRACE_MAX_EXECUTIONS}.`,
    );
  }
  if (raw > TRACE_MAX_EXECUTIONS) {
    throw new AbapError(
      "BAD_INPUT",
      `'executions' of ${raw} exceeds the cap of ${TRACE_MAX_EXECUTIONS}.`,
      { executions: raw, max: TRACE_MAX_EXECUTIONS },
      `Pass 'executions' no greater than ${TRACE_MAX_EXECUTIONS}.`,
    );
  }
  return raw;
}

// -------------------------------------------------------------- rendering ---

/** The last path segment of a full ADT resource path — `atom:id` is always
 * served as a full path (`.../abaptraces/<id>` or `.../abaptraces/requests/<id>`),
 * never a bare id, confirmed against `test/fixtures/traces/*.xml`. */
function shortId(fullId: string): string {
  const idx = fullId.lastIndexOf("/");
  return idx === -1 ? fullId : fullId.slice(idx + 1);
}

const msFromUs = (us: number): string => String(Math.round(us / 1000));
const pct = (p: number): string => `${p.toFixed(1)}%`;

function renderRunsTable(runs: TraceRunSummary[]): string {
  const rows = runs.map((r) => ({
    id: shortId(r.id),
    object: r.objectName,
    published: r.published,
    size: String(r.size),
    runtime_ms: msFromUs(r.runtime),
    state: r.stateText || r.state,
    aggregated: r.isAggregated ? "yes" : "no",
  }));
  return textTable(rows, ["id", "object", "published", "size", "runtime_ms", "state", "aggregated"]);
}

function renderRequestsTable(requests: TraceRequestSummary[]): string {
  const rows = requests.map((r) => ({
    id: shortId(r.id),
    description: r.description,
    object: r.objectName,
    expires: r.expires ?? "",
    executions: `${r.completedExecutions}/${r.maximalExecutions}`,
  }));
  return textTable(rows, ["id", "description", "object", "expires", "executions"]);
}

async function renderList(
  conn: AbapConnection,
  kind: TraceListKind,
  maxChars: number,
): Promise<BuiltResponse> {
  const user = conn.cfg.user;
  if (kind === "requests") {
    const requests = await listTraceRequests(conn, user);
    if (requests.length === 0) {
      return buildResponse({
        body: `No trace requests found for user ${user.toUpperCase()}.`,
        hints: ['Use op="run" to trace an object as part of executing it, or op="start" to arm a request to run later.'],
        maxChars,
      });
    }
    return buildResponse({ body: renderRequestsTable(requests), bodyLabel: "TRACE REQUESTS", maxChars });
  }
  const runs = await listTraceRuns(conn, user);
  if (runs.length === 0) {
    return buildResponse({
      body: `No trace runs found for user ${user.toUpperCase()}.`,
      hints: ['Use op="run" to trace an object as part of executing it.'],
      maxChars,
    });
  }
  return buildResponse({ body: renderRunsTable(runs), bodyLabel: "TRACE RUNS", maxChars });
}

function renderHitList(
  entries: Array<{
    rank: number;
    hitCount: number;
    netTime: { time: number; percentage: number };
    grossTime: { time: number; percentage: number };
    callingProgram?: { name?: string };
    calledProgram: string;
    description: string;
  }>,
  top: number,
): { table: string; note?: string } {
  const cut = entries.slice(0, top);
  const rows = cut.map((e) => ({
    rank: String(e.rank),
    hits: String(e.hitCount),
    net_ms: msFromUs(e.netTime.time),
    net_pct: pct(e.netTime.percentage),
    gross_ms: msFromUs(e.grossTime.time),
    gross_pct: pct(e.grossTime.percentage),
    program: e.callingProgram?.name ?? e.calledProgram ?? "",
    description: e.description,
  }));
  const table = textTable(rows, [
    "rank",
    "hits",
    "net_ms",
    "net_pct",
    "gross_ms",
    "gross_pct",
    "program",
    "description",
  ]);
  return {
    table,
    note: entries.length > top ? `showing top ${top} of ${entries.length} hit-list entries` : undefined,
  };
}

function renderDbAccesses(
  db: Awaited<ReturnType<typeof fetchTraceDbAccesses>>,
  top: number,
): { table: string; tables: string; note?: string; totalMs: string } {
  const cut = db.accesses.slice(0, top);
  const rows = cut.map((a) => ({
    table: a.tableName,
    statement: a.statement,
    type: a.type,
    total_count: String(a.totalCount),
    buffered: String(a.bufferedCount),
    total_ms: msFromUs(a.totalTime),
    db_ms: msFromUs(a.databaseTime),
    pct_of_trace: pct(a.ratioOfTraceTotal),
  }));
  const table = textTable(rows, [
    "table",
    "statement",
    "type",
    "total_count",
    "buffered",
    "total_ms",
    "db_ms",
    "pct_of_trace",
  ]);
  const tableRows = db.tables.map((t) => ({
    name: t.name,
    table_class: t.tableClass,
    buffer_mode: t.bufferMode,
    package: t.package,
  }));
  const tables = textTable(tableRows, ["name", "table_class", "buffer_mode", "package"]);
  return {
    table,
    tables,
    note: db.accesses.length > top ? `showing top ${top} of ${db.accesses.length} DB-access entries` : undefined,
    totalMs: msFromUs(db.totalDbTime),
  };
}

/**
 * `run.objectName` is the classrun URL the trace request was scoped to
 * (`/sap/bc/adt/oo/classrun/ZCL_I77_PROBE`), which for both a traced class
 * and a traced report (routed through a generated bridge class — see
 * `tracedObjectUrl` above) ends in the class name that call-tree nodes for
 * the traced object's own code will name. `""` (unscoped, shouldn't happen
 * for a trace this tool created, but defensive) yields `undefined`.
 */
function anchorHintFromObjectUrl(objectUrl: string): string | undefined {
  const last = objectUrl.split("/").filter((s) => s.length > 0).pop();
  return last === undefined || last.length === 0 ? undefined : last;
}

/**
 * Find the first call-tree node that belongs to the traced object: a
 * case-insensitive substring match against the node's description (e.g.
 * `"Call M.  ZCL_V77_SLOW->IF_OO_ADT_CLASSRUN~MAIN"` matching hint
 * `"ZCL_V77_SLOW"`), or a case-insensitive match against its calling
 * program's name. Statements are in document (pre-order) order, so the
 * first match is the object's own entry node, not a later reference to it
 * from inside its own subtree.
 */
function findTreeAnchorIndex(statements: readonly TraceStatementNode[], hint: string): number {
  const needle = hint.trim().toUpperCase();
  if (needle.length === 0) return -1;
  return statements.findIndex((s) => {
    if (s.description.toUpperCase().includes(needle)) return true;
    const name = s.callingProgram?.name;
    return name !== undefined && name.toUpperCase().includes(needle);
  });
}

async function renderRead(conn: AbapConnection, args: TraceInput, maxChars: number): Promise<BuiltResponse> {
  const rawId = args.id as string;
  const run = await readTraceRun(conn, rawId);
  const id = shortId(run.id);
  const view: TraceView = args.view ?? "hitlist";
  const top = resolveTop(args.top);

  const header = {
    trace_run_id: id,
    object: run.objectName,
    aggregated: run.isAggregated ? "yes" : "no",
    size: run.size,
    runtime_ms: msFromUs(run.runtime),
  };

  if (view === "hitlist") {
    const hit = await fetchTraceHitList(conn, run.id);
    const { table, note } = renderHitList(hit.entries, top);
    return buildResponse({
      header,
      body: table,
      bodyLabel: "HIT LIST",
      notes: note ? [note] : undefined,
      maxChars,
    });
  }

  if (view === "db") {
    const db = await fetchTraceDbAccesses(conn, run.id);
    const { table, tables, note, totalMs } = renderDbAccesses(db, top);
    return buildResponse({
      header,
      sections: [
        { title: "DB ACCESSES", content: table },
        { title: "TABLES", content: tables },
      ],
      body: `Total DB time: ${totalMs} ms.`,
      notes: note ? [note] : undefined,
      maxChars,
    });
  }

  // view === "tree"
  assertTreeViewAllowed(run.isAggregated, id);
  const depth = resolveTreeDepth(args.depth);
  const stmt = await fetchTraceStatements(conn, run.id);
  const rootHint = args.root ?? anchorHintFromObjectUrl(run.objectName);
  const anchorIndex = rootHint === undefined ? -1 : findTreeAnchorIndex(stmt.statements, rootHint);

  const notes: string[] = [];
  let subtree: TraceStatementNode[];
  let relativeLevel: (s: TraceStatementNode) => number;

  if (anchorIndex === -1) {
    // No anchor found (or no hint to search for): fall back to the old
    // absolute-level rendering, rooted at the ADT dispatch root. On A4H the
    // dispatch machinery alone is >12 levels deep, so this fallback will
    // usually show none of the traced object's own code — it exists only so
    // a caller who passed an unmatched `root`, or whose object name can't be
    // derived, still gets *something* back instead of an empty tree.
    subtree = stmt.statements;
    relativeLevel = (s) => s.callLevel;
    notes.push(
      rootHint === undefined
        ? "could not determine the traced object's name to anchor the call tree on; showing " +
            "the tree from the ADT dispatch root instead — pass 'root' to anchor it explicitly"
        : `no call-tree node matched root ${JSON.stringify(rootHint)}; showing the tree from ` +
            "the ADT dispatch root instead — check the spelling, or omit 'root' to let the " +
            "traced object be found automatically",
    );
  } else {
    const anchor = stmt.statements[anchorIndex]!;
    const anchorLevel = anchor.callLevel;
    subtree = [anchor];
    for (let i = anchorIndex + 1; i < stmt.statements.length; i++) {
      const s = stmt.statements[i]!;
      if (s.callLevel <= anchorLevel) break;
      subtree.push(s);
    }
    relativeLevel = (s) => s.callLevel - anchorLevel;
    notes.push(
      `call tree rooted at ${JSON.stringify(anchor.description.trim())} ` +
        `(absolute level ${anchorLevel}); levels below are relative to this node`,
    );
  }

  const flattened = subtree.filter((s) => relativeLevel(s) <= depth);
  const cut = flattened.slice(0, top);
  const rows = cut.map((s) => {
    const level = relativeLevel(s);
    return {
      level: String(level),
      hits: String(s.hitCount),
      net_ms: msFromUs(s.netTime.time),
      gross_ms: msFromUs(s.grossTime.time),
      description: `${"  ".repeat(Math.max(level, 0))}${s.description}`,
    };
  });
  const table = textTable(rows, ["level", "hits", "net_ms", "gross_ms", "description"]);
  if (flattened.length > top) {
    notes.push(
      `showing top ${top} of ${flattened.length} call-tree entries at depth <= ${depth} ` +
        `(${stmt.count} statements total in the untruncated tree)`,
    );
  }
  if (subtree.length > flattened.length) {
    notes.push(
      `depth <= ${depth} kept ${flattened.length} of ${subtree.length} call-tree nodes; ` +
        `deeper nodes were dropped — raise 'depth' (max ${TRACE_MAX_TREE_DEPTH}) to see them`,
    );
  }
  return buildResponse({ header, body: table, bodyLabel: "CALL TREE", notes, maxChars });
}

// ------------------------------------------------------------------ object ---

/**
 * `abap_run` executes a class directly at `/sap/bc/adt/oo/classrun/<CLASS>`,
 * but a REPORT runs through a generated bridge class deployed and POSTed to
 * `/sap/bc/adt/oo/classrun/<BRIDGE>` (see `bridgeClassName`/`runReport` in
 * `../adt/run.ts`) — the report's own name never appears in the classrun
 * URL. A trace request is scoped to exactly one URL (`buildCreateRequestQuery`'s
 * doc comment in `traces-query.ts`), so tracing a report must scope to the
 * BRIDGE class's classrun URL, not the report's — scoping to the report
 * itself would create a request that never sees a single matching dispatch.
 */
function tracedObjectUrl(resolved: ResolvedObject): string {
  if (resolved.kind === "CLAS") return classrunScopeUri(resolved.name);
  if (resolved.kind === "PROG") return classrunScopeUri(bridgeClassName(resolved.name));
  throw new AbapError(
    "UNSUPPORTED",
    `${resolved.type} ${resolved.name} cannot be traced: only classes implementing ` +
      "IF_OO_ADT_CLASSRUN and reports (PROG) are dispatched through a single classrun URL a " +
      "trace request can scope to.",
    { object: resolved.name, type: resolved.type, kind: resolved.kind },
    "Trace a class or report.",
  );
}

// --------------------------------------------------------------- journal ---

/**
 * `journal` is REQUIRED (not optional) on `TraceToolDeps`: an absent journal
 * would silently lose every trace-request create/delete entry rather than
 * recording nothing on purpose. Disabled journalling is modelled by passing
 * `new Journal({enabled: false})`, never by omitting the field — mirrors
 * `TransportJournalDeps.journal` in `../tools/transport.ts` and the
 * `journal-contract.test.ts` rule that pins every registrar deps type this
 * way.
 */
export interface TraceToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars">;
  readonly journal: Journal;
}

function traceRequestRef(id: string, description: string): JournalObjectRef {
  return { name: id, type: "TRACE/REQ", uri: `${ABAPTRACES_REQUESTS_BASE}/${id}`, package: "", description };
}

function traceRunRef(id: string, description: string): JournalObjectRef {
  return { name: id, type: "TRACE/RUN", uri: `${ABAPTRACES_BASE}/${id}`, package: "", description };
}

/**
 * Every entry this file writes is `irreversible: true` — `undoBlocker()` in
 * `../adt/undo.ts` already refuses any irreversible entry through its
 * catch-all (same precedent as `abap_ui`'s PRESS entries and BOPF writes),
 * so no undo path is claimed for a trace create or a trace/request delete.
 * There is no dedicated `JournalOperation` for tracing (that union is
 * closed, pinned by contract tests) — creates reuse `"create"`, deletes
 * reuse `"delete"`.
 */
function traceSystemKey(conn: AbapConnection): string {
  return systemKey({ sid: conn.cfg.sid, url: conn.cfg.url, client: conn.cfg.client });
}

/**
 * Journal a trace-request create via `withJournalledMutation`. The id is
 * minted by the server and is not known until `createTraceRequest`'s POST
 * returns, so — unlike the ordinary write path, where the before-image hook
 * fires strictly before the mutating request — `onBeforeImage` is invoked
 * from inside the mutator immediately after the POST succeeds, with the
 * real created id. `../tools/transport.ts`'s analogous case (a transport
 * request whose number is also unknown pre-create) instead uses
 * `beforeCapture: "unknown"` and its own hand-rolled begin-after-POST helper,
 * reasoning that "nothing was checked before creating". A trace-request id
 * is different: it is minted fresh by SAT on every call with no possibility
 * of naming a pre-existing candidate (a transport number at least
 * conceivably could), so "no id existed before this POST" is not a guess
 * here but a structural fact — `beforeCapture: "confirmed-absent"` is used
 * per this tool's spec.
 */
async function journalledCreateTraceRequest(
  conn: AbapConnection,
  journal: Journal,
  input: Parameters<typeof createTraceRequest>[1],
): Promise<TraceRequestSummary> {
  const { result, settle } = await withJournalledMutation<TraceRequestSummary, TraceRequestSummary>(
    journal,
    {
      begin: (created): JournalBeginInput => ({
        operation: "create",
        object: traceRequestRef(shortId(created.id), created.description),
        existedBefore: false,
        beforeCapture: "confirmed-absent",
        irreversible: true,
        systemKey: traceSystemKey(conn),
        tool: "abap_trace",
      }),
    },
    async (onBeforeImage) => {
      const created = await createTraceRequest(conn, input);
      await onBeforeImage(created);
      return created;
    },
  );
  await settle({ outcome: "succeeded" });
  return result;
}

async function journalledDeleteRequest(
  conn: AbapConnection,
  journal: Journal,
  id: string,
  description: string,
  beforeCapture: BeforeImageCapture,
): Promise<void> {
  const { settle } = await withJournalledMutation<void, void>(
    journal,
    {
      begin: (): JournalBeginInput => ({
        operation: "delete",
        object: traceRequestRef(id, description),
        existedBefore: true,
        beforeCapture,
        irreversible: true,
        systemKey: traceSystemKey(conn),
        tool: "abap_trace",
      }),
    },
    async (onBeforeImage) => {
      await onBeforeImage();
      await deleteTraceRequest(conn, id);
    },
  );
  await settle({ outcome: "succeeded" });
}

async function journalledDeleteRun(
  conn: AbapConnection,
  journal: Journal,
  id: string,
  description: string,
): Promise<void> {
  const { settle } = await withJournalledMutation<void, void>(
    journal,
    {
      begin: (): JournalBeginInput => ({
        operation: "delete",
        object: traceRunRef(id, description),
        existedBefore: true,
        beforeCapture: "unknown",
        irreversible: true,
        systemKey: traceSystemKey(conn),
        tool: "abap_trace",
      }),
    },
    async (onBeforeImage) => {
      await onBeforeImage();
      await deleteTraceRun(conn, id);
    },
  );
  await settle({ outcome: "succeeded" });
}

// ------------------------------------------------------------------- start ---

async function abapTraceStart(
  conn: AbapConnection,
  journal: Journal,
  args: TraceInput,
  maxChars: number,
): Promise<BuiltResponse> {
  const object = args.object as string;
  // Pure, offline validation FIRST — a refused write must cost zero requests
  // (see `validateOpArgs`'s doc comment above and `../tools/preflight.ts`'s
  // module header). `resolveTraceOptions` can only default its description
  // from the RAW `object` string here, since `resolved.name` does not exist
  // yet; once `resolveObject` below succeeds, the default (and ONLY the
  // default — never caller-supplied text) is refreshed to name the resolved
  // object, matching the description this tool has always shown. That
  // refresh does not need to re-run `assertDescription`: it is server-shaped
  // text this code generates, not caller input, so it cannot fail validation
  // it already passed as a shorter/equal-length string built the same way.
  const options = resolveTraceOptions(args, `abapsmith trace of ${object}`);
  const executions = resolveExecutions(args.executions);

  const resolved = await resolveObject(conn, object, { type: args.type });
  const scopeUrl = tracedObjectUrl(resolved);
  const usedDefaultDescription = typeof args.description !== "string" || args.description.trim() === "";
  if (usedDefaultDescription) {
    options.description = `abapsmith trace of ${resolved.name}`;
  }

  const parametersId = await createTraceParameters(conn, options);
  const request = await journalledCreateTraceRequest(conn, journal, {
    description: options.description,
    traceUser: conn.cfg.user,
    traceClient: conn.cfg.client,
    objectName: scopeUrl,
    parametersId,
    maximalExecutions: executions,
    expires: new Date(Date.now() + TRACE_REQUEST_TTL_MS),
  });

  const requestId = shortId(request.id);
  return buildResponse({
    header: {
      request_id: requestId,
      traced_object: scopeUrl,
      expires: request.expires,
      maximal_executions: request.maximalExecutions,
    },
    body: `Trace request ${requestId} created, scoped to ${scopeUrl}.`,
    hints: [
      `Execute ${resolved.name} through its normal entry point (it must dispatch through ` +
        `${scopeUrl}), then run abap_trace op="list" kind="runs" to find the new trace run id, ` +
        'and op="read" with that id to read it.',
      `Delete this request with op="delete" id="${requestId}" once you are done with it — a ` +
        "fully consumed trace request is not retired by the server on its own.",
    ],
    maxChars,
  });
}

// --------------------------------------------------------------------- run ---

async function abapTraceRun(
  conn: AbapConnection,
  journal: Journal,
  safety: SafetyGate,
  args: TraceInput,
  maxChars: number,
): Promise<BuiltResponse> {
  const object = args.object as string;
  // Pure, offline validation FIRST — a refused write must cost zero requests
  // (see `validateOpArgs`'s doc comment above and `../tools/preflight.ts`'s
  // module header). `resolveTraceOptions` can only default its description
  // from the RAW `object` string here, since `resolved.name` does not exist
  // yet; once `resolveObject` below succeeds, the default (and ONLY the
  // default — never caller-supplied text) is refreshed to name the resolved
  // object, matching the description this tool has always shown. That
  // refresh does not need to re-run `assertDescription`: it is server-shaped
  // text this code generates, not caller input, so it cannot fail validation
  // it already passed as a shorter/equal-length string built the same way.
  const options = resolveTraceOptions(args, `abapsmith trace of ${object}`);
  const top = resolveTop(args.top);

  const resolved = await resolveObject(conn, object, { type: args.type });
  const scopeUrl = tracedObjectUrl(resolved);
  const usedDefaultDescription = typeof args.description !== "string" || args.description.trim() === "";
  if (usedDefaultDescription) {
    options.description = `abapsmith trace of ${resolved.name}`;
  }

  const parametersId = await createTraceParameters(conn, options);
  const request = await journalledCreateTraceRequest(conn, journal, {
    description: options.description,
    traceUser: conn.cfg.user,
    traceClient: conn.cfg.client,
    objectName: scopeUrl,
    parametersId,
    maximalExecutions: 1,
    expires: new Date(Date.now() + TRACE_REQUEST_TTL_MS),
  });
  const requestId = shortId(request.id);

  const notes: string[] = [];
  let runOutputText = "";
  let runSummary: TraceRunSummary | undefined;
  let runError: unknown;

  try {
    const before = await listTraceRuns(conn, conn.cfg.user);
    const knownIds = new Set(before.map((r) => r.id));

    const runMode: "class" | "report" = resolved.kind === "PROG" ? "report" : "class";
    const runRes = await abapRun(conn, { object: resolved.name, mode: runMode }, maxChars, safety);
    runOutputText = runRes.text;

    runSummary = await awaitNewTraceRun(conn, conn.cfg.user, knownIds);
  } catch (e) {
    runError = e;
  } finally {
    // ALWAYS clean up the trace request — never delete the trace RUN itself,
    // the caller may still want op="read" on it. A failed cleanup must never
    // mask the real result: swallow it into a note naming the id.
    try {
      await journalledDeleteRequest(conn, journal, requestId, request.description, "captured");
    } catch (e) {
      notes.push(
        `Could not delete trace request ${requestId} after the run: ${(e as Error).message}. ` +
          `Delete it by hand with op="delete" id="${requestId}".`,
      );
    }
  }

  if (runError) throw runError;

  if (runSummary === undefined) {
    notes.push(
      `No new trace run appeared for ${resolved.name} within the poll budget. This usually means ` +
        `the execution did not dispatch through the traced URL (${scopeUrl}) — e.g. it ran in a ` +
        "session that bypassed the classrun bridge, or the object never actually executed.",
    );
    return buildResponse({
      header: { system: conn.cfg.sid, object: `${resolved.type} ${resolved.name}` },
      sections: [{ title: "RUN OUTPUT", content: runOutputText }],
      notes,
      maxChars,
    });
  }

  const runId = shortId(runSummary.id);
  const hit = await fetchTraceHitList(conn, runSummary.id);
  const { table: hitTable, note: hitNote } = renderHitList(hit.entries, top);
  if (hitNote) notes.push(hitNote);

  const db = await fetchTraceDbAccesses(conn, runSummary.id);
  const { table: dbTable, note: dbNote, totalMs } = renderDbAccesses(db, top);
  if (dbNote) notes.push(dbNote);

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      object: `${resolved.type} ${resolved.name}`,
      trace_run_id: runId,
      aggregated: runSummary.isAggregated ? "yes" : "no",
      total_db_ms: totalMs,
    },
    sections: [
      { title: "RUN OUTPUT", content: runOutputText },
      { title: "HIT LIST", content: hitTable },
      { title: "DB ACCESSES", content: dbTable },
    ],
    notes,
    hints: [`Run abap_trace op="read" id="${runId}" view="tree" for a call tree (non-aggregated traces only).`],
    maxChars,
  });
}

// ------------------------------------------------------------------ delete ---

async function abapTraceDelete(
  conn: AbapConnection,
  journal: Journal,
  args: TraceInput,
  maxChars: number,
): Promise<BuiltResponse> {
  const raw = args.id as string;
  let kind: "request" | "run";
  let full: string;
  try {
    full = normaliseTraceRequestId(raw);
    kind = "request";
  } catch {
    full = normaliseTraceRunId(raw);
    kind = "run";
  }
  const id = shortId(full);
  if (kind === "request") {
    await journalledDeleteRequest(conn, journal, id, `trace request ${id}`, "unknown");
  } else {
    await journalledDeleteRun(conn, journal, id, `trace run ${id}`);
  }
  return buildResponse({
    header: { deleted: kind, id },
    body: `Deleted trace ${kind} ${id}.`,
    maxChars,
  });
}

// ---------------------------------------------------------------- register ---

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/**
 * Target-less capability probe, copied from `assertCanDeleteAtcWorklist` in
 * `./atc.ts`: `op="delete"` names a trace by id, not a repository object, so
 * `gate.authorize`/`gate.assert` cannot mint a `SafetyTarget` for it (that
 * type requires a `name`). `gate.evaluate("execute", undefined, {})` falls
 * through to the generic no-target `SAFETY_DENIED` branch, which is
 * undecidable (not a real denial) here and is treated as allowed; READ_ONLY
 * and ROLE_PROBE_FAILED still fire unconditionally ahead of that branch.
 */
function assertCanTrace(gate: SafetyGate, opLabel: string): void {
  const d = gate.evaluate("execute", undefined, {});
  if (d.allowed || d.code === "SAFETY_DENIED") return;
  throw new AbapError(
    d.code ?? "READ_ONLY",
    d.reason,
    { operation: `trace.${opLabel}`, rule: d.rule },
    d.hint ?? "ABAP runtime tracing needs write capability (ABAP_MODE=edit/admin).",
  );
}

/**
 * Registers `abap_trace` unconditionally (not mode-locked — see
 * `./locked.ts`'s header for why `abap_data_preview` is excluded there for
 * the same reason). `op="list"`/`op="read"` are plain reads and dispatch
 * with no gate call at all, exactly like `abap_transport`'s read ops.
 * `op="start"`/`op="run"`/`op="delete"` are gated as `execute`: a target-less
 * probe first (zero HTTP cost, same guarantee as `run.ts`'s preflight
 * assert), and for `start`/`run` — which name a real repository object —
 * ALSO the object-specific `preflight()` assert `run.ts` itself uses, before
 * any network call. A refused write costs zero requests either way.
 *
 * `op="run"` dispatches via `pool.withWrite`: it calls `abapRun()` inside,
 * which executes ABAP and is refused by `pool.withRead`'s `EXECUTES_ABAP_OPS`
 * guard under the name `"abap_run"` — dispatching this tool's own op name
 * through the read lane would not trip that guard, but the underlying
 * classrun POST has the exact same dead-slot-replay hazard `run.ts`
 * documents, so it needs the same write lease. `op="start"`/`op="list"`/
 * `op="read"`/`op="delete"` take no ABAP enqueue and use `pool.withRead`,
 * mirroring `abap_atc`'s `run`/`delete_worklist` (`./atc.ts`).
 */
export function registerTraceTools(mcp: McpServer, deps: TraceToolDeps): void {
  mcp.registerTool(
    "abap_trace",
    {
      description:
        "ABAP runtime tracing (SAT): records everything a traced request's dispatch touches — " +
        'time per call and every database access. op="run" (default) traces one execution of ' +
        'a class/report and reads the result back; op="start" arms a request to trace a later ' +
        'run yourself; op="list" shows existing runs/requests; op="read" reads a run\'s hit ' +
        'list, DB accesses, or call tree; op="delete" removes a run or request.',
      // Registering the raw `traceInputSchema` shape directly here would have
      // the MCP SDK wrap it in a stripping `z.object`, which silently deletes
      // unknown keys before they ever reach the handler — `rejectUnknownArgs`
      // below would then be dead code, refusing nothing, because there would
      // be nothing left to refuse. `z.looseObject(...)` keeps unknown keys on
      // the parsed object (and reports `additionalProperties: {}` in the
      // advertised JSON schema, verified live) so the handler-side check can
      // actually see and name them. See `./dumps.ts`'s `dumpsInputSchema` for
      // the precedent this mirrors.
      inputSchema: z.looseObject(traceInputSchema),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      try {
        const a = (args ?? {}) as Record<string, unknown>;
        rejectUnknownArgs(a);
        const op = resolveOp(a);
        validateOpArgs(a, op);
        const input = a as TraceInput;

        if (op === "list") {
          await deps.ensureConnected();
          const res = await deps.pool.withRead("abap_trace", (conn) =>
            renderList(conn, input.kind ?? "runs", deps.cfg.maxResponseChars),
          );
          return ok(res.text);
        }

        if (op === "read") {
          await deps.ensureConnected();
          const res = await deps.pool.withRead("abap_trace", (conn) =>
            renderRead(conn, input, deps.cfg.maxResponseChars),
          );
          return ok(res.text);
        }

        if (op === "delete") {
          assertCanTrace(deps.safety, "delete");
          await deps.ensureConnected();
          const res = await deps.pool.withRead("abap_trace", (conn) =>
            abapTraceDelete(conn, deps.journal, input, deps.cfg.maxResponseChars),
          );
          return ok(res.text);
        }

        if (op === "start") {
          assertCanTrace(deps.safety, "start");
          deps.safety.assert("execute", preflight({ object: input.object as string, type: input.type }), {
            phase: "preflight",
          });
          await deps.ensureConnected();
          const res = await deps.pool.withRead("abap_trace", (conn) =>
            abapTraceStart(conn, deps.journal, input, deps.cfg.maxResponseChars),
          );
          return ok(res.text);
        }

        // op === "run"
        assertCanTrace(deps.safety, "run");
        deps.safety.assert("execute", preflight({ object: input.object as string, type: input.type }), {
          phase: "preflight",
        });
        await deps.ensureConnected();
        const res = await deps.pool.withWrite("abap_trace", undefined, (conn) =>
          abapTraceRun(conn, deps.journal, deps.safety, input, deps.cfg.maxResponseChars),
        );
        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
