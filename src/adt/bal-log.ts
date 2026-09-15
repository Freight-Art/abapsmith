/**
 * `abap_fluid run tool:"log" action:"read"`'s TypeScript side: row validation
 * for the NDJSON the `log` fluid tool emits (`ZCL_ZMCP_FLUID_LOG`,
 * src/adt/fluid/builtin/log.ts), text-table rendering, and a stderr audit
 * line. Modeled directly on `src/adt/source-scan.ts`: `logDispatchArgs`
 * builds `dispatch()`'s `args` the same way `scanDispatchArgs` does (omit
 * undefined/empty keys rather than pass them through to schema validation),
 * and `mapLogRows` rebuilds a typed result from the row array `dispatch()`
 * returns, validating each row's concrete shape beyond what the manifest's
 * output schema already checked (kind is a known string; the rest of the
 * shape is this file's job).
 *
 * Unlike `source-scan.ts` there is no `runLogRead` here: `abap_fluid run` is
 * generic over every tool/action, so `src/tools/fluid.ts`'s `runRun` already
 * calls `dispatch()` for every fluid call; it just hands tool:"log"
 * action:"read" results through `mapLogRows`/`renderLogRead`/`auditLogRead`
 * instead of the generic JSON dump it uses for every other tool.
 */
import { AbapError } from "./errors.js";
import { LOG_TOOL_ID, LOG_ACTION, logTool } from "./fluid/builtin/log.js";
import type { LoadedFluidTool } from "./fluid/manifest.js";
import { buildResponse, textTable } from "../compact.js";

// ---------------------------------------------------------------------------
// dispatch() plumbing
// ---------------------------------------------------------------------------

/** Mirrors `SCAN_TOOLS` in source-scan.ts — `log`'s `LoadedFluidTool` is already
 * fully built by builtin/log.ts, so there is nothing to assemble here. */
export const LOG_TOOLS: ReadonlyMap<string, LoadedFluidTool> = new Map([[LOG_TOOL_ID, logTool]]);

// ---------------------------------------------------------------------------
// Result model
//
// Field names below are the WIRE names the `log.read` NDJSON contract uses
// (`lognumber`, `msgty`, `probclass`, `context_tabname`, …), not camelCased.
// That is deliberate: it keeps `mapLogRows` a visibly one-to-one copy of the
// contract described in the ABAP side's doc comment, rather than a
// translation layer that could silently drift from it over time.
// ---------------------------------------------------------------------------

export interface BalLogHeader {
  readonly lognumber: string;
  readonly object: string;
  readonly subobject: string;
  readonly extnumber: string;
  readonly aldate: string;
  readonly altime: string;
  readonly aluser: string;
  readonly alprog: string;
  readonly altcode: string;
  readonly almode: string;
  readonly probclass: string;
  readonly msg_total: number;
  readonly msg_error: number;
  readonly msg_abort: number;
  readonly msg_warning: number;
  readonly msg_info: number;
  readonly msg_success: number;
}

export interface BalLogMessage {
  readonly lognumber: string;
  readonly msgnumber: number;
  readonly msgty: string;
  readonly msgid: string;
  readonly msgno: string;
  readonly msgv1: string;
  readonly msgv2: string;
  readonly msgv3: string;
  readonly msgv4: string;
  readonly text: string;
  readonly detlevel: number;
  readonly probclass: string;
  readonly context_tabname: string;
}

export interface BalLogSummary {
  readonly logs_returned: number;
  readonly messages_returned: number;
  readonly truncated: boolean;
  readonly detail: string;
  readonly since: string;
  readonly until: string;
  readonly user: string;
  readonly max: number;
  readonly server_time: string;
}

/** A `log` row plus the `msg` rows the wire contract nests directly after it. */
export type BalLogEntry = BalLogHeader & { readonly messages: readonly BalLogMessage[] };

export interface BalLogResult {
  readonly logs: readonly BalLogEntry[];
  readonly summary: BalLogSummary;
}

// ---------------------------------------------------------------------------
// Query model
// ---------------------------------------------------------------------------

/**
 * Default `max` when the caller doesn't pass one. The ABAP side applies no
 * default of its own (an unqualified `max` would be a free-form "however
 * many BAL entries match" query) — the default lives here, in the layer a
 * reader of this file can actually find it in, rather than buried in
 * generated ABAP.
 */
export const DEFAULT_LOG_MAX = 20;

/**
 * Default lookback window, in seconds, applied when the caller pins neither
 * an absolute window (`since`/`until`) nor a relative one (`lastSeconds`).
 * Without this floor, an unqualified `log.read` would ask the ABAP side to
 * scan the entire application log table (BAL_INDX can span years on a live
 * system) — exactly what `since`/`until`/`max` exist to avoid needing.
 */
export const DEFAULT_LOG_WINDOW_SECONDS = 3600;

export interface BalLogQuery {
  readonly object?: string;
  readonly subobject?: string;
  readonly extnumber?: string;
  readonly user?: string;
  readonly since?: string;
  readonly until?: string;
  readonly lastSeconds?: number;
  readonly tcode?: string;
  readonly program?: string;
  readonly max?: number;
  readonly detail?: "headers" | "messages";
}

/**
 * `last_seconds` combined with `since`/`until` is a caller mistake decidable
 * from the arguments alone — the ABAP side (`log.ts`'s `do_read`) already
 * refuses it, but only after a full round trip to the fluid runtime. Catching
 * it here means the caller gets `BAD_INPUT` for free, with no network call.
 * The ABAP-side check stays in place as a backstop (e.g. for a caller that
 * builds `dispatch()` args by some other path than `logDispatchArgs`).
 */
function assertNoWindowConflict(q: BalLogQuery): void {
  if (q.lastSeconds === undefined) return;
  if (q.since === undefined && q.until === undefined) return;
  throw new AbapError(
    "BAD_INPUT",
    "log.read: last_seconds cannot be combined with since or until.",
    { lastSeconds: q.lastSeconds, since: q.since, until: q.until },
    "Name the window one way: pass last_seconds alone, or since/until alone.",
  );
}

/**
 * `logDispatchArgs` only runs for callers that build a `BalLogQuery` first —
 * `abap_fluid run tool:"log" action:"read"` (`runRun` in `src/tools/fluid.ts`)
 * is not one of those: it hands the caller's raw `args` record straight to
 * `dispatch()`, so `assertNoWindowConflict` never saw it and the mistake
 * went undetected until the ABAP-side backstop caught it — after a full
 * round trip. This is the same check run against the WIRE record instead of
 * a `BalLogQuery`: `last_seconds`/`since`/`until` are the key names the
 * `log.read` action's manifest actually declares (see `do_read` in
 * `src/adt/fluid/builtin/log.ts`), not the `lastSeconds` TS-side name.
 * Values are read as-is and handed to `assertNoWindowConflict` without type
 * narrowing — a present-but-wrong-typed value (e.g. a stringified
 * `last_seconds`) is still a caller mistake worth refusing locally rather
 * than forwarding.
 */
export function assertLogReadArgsNoWindowConflict(args: Record<string, unknown>): void {
  assertNoWindowConflict({
    lastSeconds: args["last_seconds"] as number | undefined,
    since: args["since"] as string | undefined,
    until: args["until"] as string | undefined,
  });
}

/** Omits undefined/empty-valued keys entirely rather than passing them through to `dispatch()`'s
 * schema validation (mirrors `scanDispatchArgs` in source-scan.ts). Applies `DEFAULT_LOG_MAX`
 * and, when the caller pinned no window at all, `DEFAULT_LOG_WINDOW_SECONDS`. Refuses
 * `last_seconds` combined with `since`/`until` locally — see `assertNoWindowConflict`. */
export function logDispatchArgs(q: BalLogQuery): Record<string, unknown> {
  assertNoWindowConflict(q);
  const hasWindow = q.since !== undefined || q.until !== undefined || q.lastSeconds !== undefined;
  return {
    ...(q.object !== undefined && q.object !== "" ? { object: q.object } : {}),
    ...(q.subobject !== undefined && q.subobject !== "" ? { subobject: q.subobject } : {}),
    ...(q.extnumber !== undefined && q.extnumber !== "" ? { extnumber: q.extnumber } : {}),
    ...(q.user !== undefined && q.user !== "" ? { user: q.user } : {}),
    ...(q.since !== undefined && q.since !== "" ? { since: q.since } : {}),
    ...(q.until !== undefined && q.until !== "" ? { until: q.until } : {}),
    ...(q.lastSeconds !== undefined ? { last_seconds: q.lastSeconds } : {}),
    ...(hasWindow ? {} : { last_seconds: DEFAULT_LOG_WINDOW_SECONDS }),
    ...(q.tcode !== undefined && q.tcode !== "" ? { tcode: q.tcode } : {}),
    ...(q.program !== undefined && q.program !== "" ? { program: q.program } : {}),
    max: q.max ?? DEFAULT_LOG_MAX,
    ...(q.detail !== undefined ? { detail: q.detail } : {}),
  };
}

// ---------------------------------------------------------------------------
// Result mapping — pure and total; throws FLUID_PROTOCOL_ERROR on any shape
// the manifest's output schema does not actually rule out (see source-scan.ts's
// equivalent comment: `dispatch()` only checks that array items are objects
// with a string "kind"; the concrete per-row shape is this function's job).
// ---------------------------------------------------------------------------

function fail(reason: string, rows: unknown): never {
  throw new AbapError(
    "FLUID_PROTOCOL_ERROR",
    `log.read ${reason}`,
    { tool: LOG_TOOL_ID, action: LOG_ACTION, result: rows },
  );
}

interface RawLogRow {
  [key: string]: unknown;
  kind: "log";
  lognumber: string;
  object: string;
  subobject: string;
  extnumber: string;
  aldate: string;
  altime: string;
  aluser: string;
  alprog: string;
  altcode: string;
  almode: string;
  probclass: string;
  msg_total: number;
  msg_error: number;
  msg_abort: number;
  msg_warning: number;
  msg_info: number;
  msg_success: number;
}

interface RawMsgRow {
  [key: string]: unknown;
  kind: "msg";
  lognumber: string;
  msgnumber: number;
  msgty: string;
  msgid: string;
  msgno: string;
  msgv1: string;
  msgv2: string;
  msgv3: string;
  msgv4: string;
  text: string;
  detlevel: number;
  probclass: string;
  context_tabname: string;
}

interface RawSummaryRow {
  [key: string]: unknown;
  kind: "summary";
  logs_returned: number;
  messages_returned: number;
  truncated: boolean;
  detail: string;
  since: string;
  until: string;
  user: string;
  max: number;
  server_time: string;
}

function isLogRow(r: Record<string, unknown>): r is RawLogRow {
  return (
    typeof r["lognumber"] === "string" &&
    typeof r["object"] === "string" &&
    typeof r["subobject"] === "string" &&
    typeof r["extnumber"] === "string" &&
    typeof r["aldate"] === "string" &&
    typeof r["altime"] === "string" &&
    typeof r["aluser"] === "string" &&
    typeof r["alprog"] === "string" &&
    typeof r["altcode"] === "string" &&
    typeof r["almode"] === "string" &&
    typeof r["probclass"] === "string" &&
    typeof r["msg_total"] === "number" &&
    typeof r["msg_error"] === "number" &&
    typeof r["msg_abort"] === "number" &&
    typeof r["msg_warning"] === "number" &&
    typeof r["msg_info"] === "number" &&
    typeof r["msg_success"] === "number"
  );
}

function isMsgRow(r: Record<string, unknown>): r is RawMsgRow {
  return (
    typeof r["lognumber"] === "string" &&
    typeof r["msgnumber"] === "number" &&
    typeof r["msgty"] === "string" &&
    typeof r["msgid"] === "string" &&
    typeof r["msgno"] === "string" &&
    typeof r["msgv1"] === "string" &&
    typeof r["msgv2"] === "string" &&
    typeof r["msgv3"] === "string" &&
    typeof r["msgv4"] === "string" &&
    typeof r["text"] === "string" &&
    typeof r["detlevel"] === "number" &&
    typeof r["probclass"] === "string" &&
    typeof r["context_tabname"] === "string"
  );
}

function isSummaryRow(r: Record<string, unknown>): r is RawSummaryRow {
  return (
    typeof r["logs_returned"] === "number" &&
    typeof r["messages_returned"] === "number" &&
    typeof r["truncated"] === "boolean" &&
    typeof r["detail"] === "string" &&
    typeof r["since"] === "string" &&
    typeof r["until"] === "string" &&
    typeof r["user"] === "string" &&
    typeof r["max"] === "number" &&
    typeof r["server_time"] === "string"
  );
}

type MutableEntry = BalLogHeader & { messages: BalLogMessage[] };

export function mapLogRows(rows: readonly unknown[]): BalLogResult {
  if (!Array.isArray(rows)) {
    fail("returned a result that is not an array", rows);
  }

  const logs: MutableEntry[] = [];
  let currentLog: MutableEntry | undefined;
  let summary: BalLogSummary | undefined;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      fail(`row ${i} is not an object`, rows);
    }
    const r = row as Record<string, unknown>;
    if (r["kind"] !== "log" && r["kind"] !== "msg" && r["kind"] !== "summary") {
      fail(`row ${i} has kind "${String(r["kind"])}", expected "log", "msg" or "summary"`, rows);
    }
    // A row after the trailing summary row is always wrong, whatever its own
    // kind — this also gives "more than one summary row" and "summary row
    // not last" a single implementation instead of one per branch below.
    if (summary !== undefined) {
      fail(`row ${i} follows the trailing summary row`, rows);
    }

    if (r["kind"] === "log") {
      if (!isLogRow(r)) {
        fail(`row ${i} is a log row missing or mistyping one of its required fields`, rows);
      }
      const entry: MutableEntry = {
        lognumber: r.lognumber,
        object: r.object,
        subobject: r.subobject,
        extnumber: r.extnumber,
        aldate: r.aldate,
        altime: r.altime,
        aluser: r.aluser,
        alprog: r.alprog,
        altcode: r.altcode,
        almode: r.almode,
        probclass: r.probclass,
        msg_total: r.msg_total,
        msg_error: r.msg_error,
        msg_abort: r.msg_abort,
        msg_warning: r.msg_warning,
        msg_info: r.msg_info,
        msg_success: r.msg_success,
        messages: [],
      };
      logs.push(entry);
      currentLog = entry;
      continue;
    }

    if (r["kind"] === "msg") {
      if (currentLog === undefined) {
        fail(`row ${i} is a msg row before any log row`, rows);
      }
      if (!isMsgRow(r)) {
        fail(`row ${i} is a msg row missing or mistyping one of its required fields`, rows);
      }
      currentLog.messages.push({
        lognumber: r.lognumber,
        msgnumber: r.msgnumber,
        msgty: r.msgty,
        msgid: r.msgid,
        msgno: r.msgno,
        msgv1: r.msgv1,
        msgv2: r.msgv2,
        msgv3: r.msgv3,
        msgv4: r.msgv4,
        text: r.text,
        detlevel: r.detlevel,
        probclass: r.probclass,
        context_tabname: r.context_tabname,
      });
      continue;
    }

    // kind === "summary"
    if (!isSummaryRow(r)) {
      fail(`row ${i} is a summary row missing or mistyping one of its required fields`, rows);
    }
    if (i !== rows.length - 1) {
      fail("returned a summary row that is not the last element", rows);
    }
    summary = {
      logs_returned: r.logs_returned,
      messages_returned: r.messages_returned,
      truncated: r.truncated,
      detail: r.detail,
      since: r.since,
      until: r.until,
      user: r.user,
      max: r.max,
      server_time: r.server_time,
    };
  }

  if (summary === undefined) {
    fail("did not return a summary row", rows);
  }

  return { logs, summary };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const LOG_HEADER_COLUMNS = [
  "extnumber",
  "user",
  "date",
  "time",
  "program",
  "tcode",
  "total",
  "abort",
  "error",
  "warning",
  "info",
  "success",
] as const;

const LOG_MESSAGE_COLUMNS = ["no", "type", "message", "text", "level", "context"] as const;

function logSectionTitle(log: BalLogEntry): string {
  return log.subobject ? `LOG ${log.lognumber} ${log.object}/${log.subobject}` : `LOG ${log.lognumber} ${log.object}`;
}

function logSectionContent(log: BalLogEntry): string {
  const headerRow: Record<string, string> = {
    extnumber: log.extnumber,
    user: log.aluser,
    date: log.aldate,
    time: log.altime,
    program: log.alprog,
    tcode: log.altcode,
    total: String(log.msg_total),
    abort: String(log.msg_abort),
    error: String(log.msg_error),
    warning: String(log.msg_warning),
    info: String(log.msg_info),
    success: String(log.msg_success),
  };
  const headerTable = textTable([headerRow], [...LOG_HEADER_COLUMNS]);
  if (log.messages.length === 0) return headerTable;

  const messageRows = log.messages.map((m) => ({
    no: String(m.msgnumber),
    type: m.msgty,
    message: m.msgid !== "" && m.msgno !== "" ? `${m.msgid}${m.msgno}` : "",
    text: m.text,
    level: String(m.detlevel),
    context: m.context_tabname,
  }));
  const messageTable = textTable(messageRows, [...LOG_MESSAGE_COLUMNS]);
  return `${headerTable}\n\n${messageTable}`;
}

/**
 * Renders `log.read` as one header block plus one section PER LOG (each
 * section holding that log's own header table, and — when messages were
 * fetched — a second table of its messages). One table per log rather than
 * one giant flat table, because a flat table would either repeat every
 * header field on every message row or separate a log's messages from the
 * header that scopes them; neither reads well once more than one log comes
 * back.
 */
export function renderLogRead(
  result: BalLogResult,
  opts: { readonly ms?: number; readonly version?: string; readonly deployed?: boolean; readonly maxChars: number },
): { text: string; truncated: boolean } {
  const sections = result.logs.map((log) => ({
    title: logSectionTitle(log),
    content: logSectionContent(log),
  }));

  const notes: string[] = [];
  if (result.summary.detail === "messages") {
    notes.push(
      "Message text and its variables (msgv1..msgv4) are application data written by the " +
        "logging program, not abapsmith's own output, and may contain business data.",
    );
  }

  // `buildResponse`'s `hints` only render inside its WINDOW/TRUNCATED notice
  // block, which fires when the BODY is windowed (this call never passes
  // `body`/`bodyTotalLines`, only `sections`) or when the whole response
  // overflows `maxChars`. A `max`-capped BAL result usually produces
  // neither — the rendered response typically fits fine — so a hint here
  // would silently never be shown. `notes` always renders, so the statement
  // goes there instead.
  if (result.summary.truncated) {
    notes.push(
      `Not every matching log was returned (max=${result.summary.max}). Raise max, or narrow ` +
        "the window with since/until, to see a different slice.",
    );
  }

  const built = buildResponse({
    header: {
      tool: "log",
      action: "read",
      logs: result.summary.logs_returned,
      messages: result.summary.messages_returned,
      detail: result.summary.detail,
      since: result.summary.since,
      until: result.summary.until,
      user: result.summary.user,
      server_time: result.summary.server_time,
      ...(opts.ms !== undefined ? { ms: opts.ms } : {}),
      ...(opts.version !== undefined ? { version: opts.version } : {}),
      ...(opts.deployed !== undefined ? { deployed: opts.deployed } : {}),
      truncated: result.summary.truncated,
    },
    sections,
    notes,
    // No `pagingParam`: `log.read` has no offset/paging argument — the
    // fluid action narrows via since/until/max instead. Advertising a
    // parameter here would tell the caller to pass something `dispatch()`
    // would then reject; omitting it makes `buildResponse` say paging isn't
    // available instead.
    maxChars: opts.maxChars,
  });

  return { text: built.text, truncated: built.truncated };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * One stderr line naming only `object`/`subobject` and the log/message
 * counts — never message text or any other field, since BAL messages are
 * application data that may contain business data (see `renderLogRead`'s
 * note above). Deliberately mirrors `abap_data_preview`'s audit line in
 * `src/tools/data-preview.ts` (table name + row count, never row data): the
 * same shape — "what was looked at and how much came back", nothing that
 * came back.
 */
export function auditLogRead(result: BalLogResult, q: BalLogQuery, audit: (m: string) => void): void {
  audit(
    "[abapsmith] audit: abap_fluid log.read " +
      `object=${q.object ?? "*"} subobject=${q.subobject ?? "*"} ` +
      `logs=${result.summary.logs_returned} messages=${result.summary.messages_returned}`,
  );
}
