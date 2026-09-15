/**
 * `core.locks`'s TypeScript side: row validation for the NDJSON
 * `ZCL_ZMCP_FLUID_CORE#do_locks` emits (see `abap-locks.ts`,
 * `src/adt/fluid/builtin/core/abap-locks.ts`), text-table rendering, and a
 * stderr audit line. Modeled directly on `bal-log.ts`'s
 * `mapLogRows`/`renderLogRead`/`auditLogRead` for `log.read`: `mapLockRows`
 * rebuilds a typed result from the row array `dispatch()` returns,
 * validating each row's concrete shape beyond what the manifest's output
 * schema already checked (kind is a known string; the rest of the shape is
 * this file's job).
 *
 * `core.locks` is one action on the existing `core` tool (`CORE_TOOL_ID`,
 * `src/adt/fluid/builtin/core.ts`), not a tool of its own. `LOCKS_TOOL_ID`
 * is `CORE_TOOL_ID` re-exported under this file's own name so the code that
 * wires `core.locks` into dispatch has a name to import from here without
 * this file editing `core.ts`. `core.ts` has no per-action export the way
 * `log.ts` has `LOG_ACTION`, so `LOCKS_ACTION` is simply declared here.
 *
 * Field names on `EnqueueLockRow`/`EnqueueLockSummary` (`gname`, `garg`,
 * `gobj`, `guname`, `gclient`, `gusr`, `gusrvb`, `guse`, `gusevb`, the
 * optional `tcode`/`host`/`date`/`time`/`wp`/`sysnr`/`usec`, and
 * `fields_present`) are the WIRE names the `do_locks` NDJSON contract uses,
 * not camelCased — same reasoning as `bal-log.ts`: it keeps `mapLockRows` a
 * visibly one-to-one copy of the contract the ABAP side actually emits,
 * rather than a translation layer that could silently drift from it.
 *
 * There is no release/DEQUEUE path anywhere in this file, on purpose — see
 * `abap-locks.ts`'s header comment for why `core.locks` is read-only for
 * good, not just for now.
 */
import { AbapError } from "./errors.js";
import { CORE_TOOL_ID } from "./fluid/builtin/core.js";
import { GARG_WILDCARD_CHAR, hasWildcardFill } from "./fpm-lock.js";
import { buildResponse, textTable } from "../compact.js";

export const LOCKS_TOOL_ID = CORE_TOOL_ID;
export const LOCKS_ACTION = "locks";

// ---------------------------------------------------------------------------
// Result model — field names are WIRE names, see file header.
// ---------------------------------------------------------------------------

export interface EnqueueLockRow {
  readonly gname: string;
  readonly gobj: string;
  readonly garg: string;
  readonly gmode: string;
  readonly guname: string;
  readonly gclient: string;
  readonly gusr: string;
  readonly gusrvb: string;
  readonly guse: string;
  readonly gusevb: string;
  readonly tcode?: string;
  readonly host?: string;
  readonly date?: string;
  readonly time?: string;
  readonly wp?: string;
  readonly sysnr?: string;
  readonly usec?: string;
}

export interface EnqueueLockSummary {
  readonly object: string;
  readonly table: string;
  readonly user: string;
  readonly max: number;
  readonly locks_read: number;
  readonly matched: number;
  readonly kept: number;
  readonly truncated: boolean;
  readonly server_time: string;
  readonly fields_present: readonly string[];
}

export interface EnqueueReadResult {
  readonly locks: readonly EnqueueLockRow[];
  readonly summary: EnqueueLockSummary;
}

// ---------------------------------------------------------------------------
// Args validation — pre-network, mirrors bal-log.ts's assertNoWindowConflict:
// catch a caller mistake decidable from the arguments alone before spending a
// round trip on it. The ABAP side's own backstop (do_locks's "at least one of
// object, table or user is required" fail()) stays in place regardless, for
// any caller that reaches dispatch() by some other path than this function.
// ---------------------------------------------------------------------------

export function assertLocksArgs(args: unknown): void {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new AbapError("BAD_INPUT", "core.locks: args must be an object.", { args });
  }
  const a = args as Record<string, unknown>;
  const object = a["object"];
  const table = a["table"];
  const user = a["user"];
  const max = a["max"];

  if (object !== undefined && typeof object !== "string") {
    throw new AbapError("BAD_INPUT", "core.locks: object must be a string.", { object });
  }
  if (table !== undefined && typeof table !== "string") {
    throw new AbapError("BAD_INPUT", "core.locks: table must be a string.", { table });
  }
  if (user !== undefined && typeof user !== "string") {
    throw new AbapError("BAD_INPUT", "core.locks: user must be a string.", { user });
  }

  const hasObject = typeof object === "string" && object.trim() !== "";
  const hasTable = typeof table === "string" && table.trim() !== "";
  const hasUser = typeof user === "string" && user.trim() !== "";
  if (!hasObject && !hasTable && !hasUser) {
    throw new AbapError(
      "BAD_INPUT",
      "core.locks: at least one of object, table or user is required.",
      { object, table, user },
      "Pass object, table or user (any combination) to narrow the enqueue-table read.",
    );
  }

  if (max !== undefined && (typeof max !== "number" || !Number.isInteger(max) || max < 0)) {
    throw new AbapError("BAD_INPUT", "core.locks: max must be a non-negative integer.", { max });
  }
}

// ---------------------------------------------------------------------------
// Result mapping — pure and total; throws FLUID_PROTOCOL_ERROR on any shape
// the manifest's output schema does not actually rule out (see bal-log.ts's
// equivalent comment: dispatch() only checks that array items are objects
// with a string "kind"; the concrete per-row shape is this function's job).
// ---------------------------------------------------------------------------

function fail(reason: string, rows: unknown): never {
  throw new AbapError("FLUID_PROTOCOL_ERROR", `core.locks ${reason}`, {
    tool: LOCKS_TOOL_ID,
    action: LOCKS_ACTION,
    result: rows,
  });
}

const KNOWN_GT_FIELDS = ["tcode", "host", "date", "time", "wp", "sysnr", "usec"] as const;

interface RawMetaRow {
  [key: string]: unknown;
  kind: "meta";
  object: string;
  table: string;
  user: string;
  max: number;
  fields_present: string[];
}

interface RawLockRow {
  [key: string]: unknown;
  kind: "lock";
  gname: string;
  gobj: string;
  garg: string;
  gmode: string;
  guname: string;
  gclient: string;
  gusr: string;
  gusrvb: string;
  guse: string;
  gusevb: string;
  tcode?: string;
  host?: string;
  date?: string;
  time?: string;
  wp?: string;
  sysnr?: string;
  usec?: string;
}

interface RawSummaryRow {
  [key: string]: unknown;
  kind: "summary";
  locks_read: number;
  matched: number;
  kept: number;
  truncated: boolean;
  server_time: string;
}

function isMetaRow(r: Record<string, unknown>): r is RawMetaRow {
  const fieldsPresent = r["fields_present"];
  return (
    typeof r["object"] === "string" &&
    typeof r["table"] === "string" &&
    typeof r["user"] === "string" &&
    typeof r["max"] === "number" &&
    Array.isArray(fieldsPresent) &&
    fieldsPresent.every((f) => typeof f === "string")
  );
}

function isLockRow(r: Record<string, unknown>): r is RawLockRow {
  if (
    typeof r["gname"] !== "string" ||
    typeof r["gobj"] !== "string" ||
    typeof r["garg"] !== "string" ||
    typeof r["gmode"] !== "string" ||
    typeof r["guname"] !== "string" ||
    typeof r["gclient"] !== "string" ||
    typeof r["gusr"] !== "string" ||
    typeof r["gusrvb"] !== "string" ||
    typeof r["guse"] !== "string" ||
    typeof r["gusevb"] !== "string"
  ) {
    return false;
  }
  for (const f of KNOWN_GT_FIELDS) {
    if (f in r && typeof r[f] !== "string") return false;
  }
  return true;
}

function isSummaryRow(r: Record<string, unknown>): r is RawSummaryRow {
  return (
    typeof r["locks_read"] === "number" &&
    typeof r["matched"] === "number" &&
    typeof r["kept"] === "number" &&
    typeof r["truncated"] === "boolean" &&
    typeof r["server_time"] === "string"
  );
}

export function mapLockRows(rows: readonly unknown[]): EnqueueReadResult {
  if (!Array.isArray(rows)) {
    fail("returned a result that is not an array", rows);
  }
  if (rows.length === 0) {
    fail("returned no rows at all (expected at least a meta row and a summary row)", rows);
  }

  const first = rows[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) {
    fail("row 0 is not an object", rows);
  }
  const firstR = first as Record<string, unknown>;
  if (firstR["kind"] !== "meta") {
    fail(`row 0 has kind "${String(firstR["kind"])}", expected "meta"`, rows);
  }
  if (!isMetaRow(firstR)) {
    fail("row 0 is a meta row missing or mistyping one of its required fields", rows);
  }

  const locks: EnqueueLockRow[] = [];
  let summary: EnqueueLockSummary | undefined;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      fail(`row ${i} is not an object`, rows);
    }
    const r = row as Record<string, unknown>;
    if (r["kind"] !== "lock" && r["kind"] !== "summary") {
      fail(`row ${i} has kind "${String(r["kind"])}", expected "lock" or "summary"`, rows);
    }
    // A row after the trailing summary row is always wrong, whatever its own
    // kind — gives "more than one summary row" and "summary row not last" a
    // single implementation instead of one per branch below (bal-log.ts's
    // mapLogRows does the same).
    if (summary !== undefined) {
      fail(`row ${i} follows the trailing summary row`, rows);
    }

    if (r["kind"] === "lock") {
      if (!isLockRow(r)) {
        fail(`row ${i} is a lock row missing or mistyping one of its required fields`, rows);
      }
      const lock: EnqueueLockRow = {
        gname: r.gname,
        gobj: r.gobj,
        garg: r.garg,
        gmode: r.gmode,
        guname: r.guname,
        gclient: r.gclient,
        gusr: r.gusr,
        gusrvb: r.gusrvb,
        guse: r.guse,
        gusevb: r.gusevb,
        ...(r.tcode !== undefined ? { tcode: r.tcode } : {}),
        ...(r.host !== undefined ? { host: r.host } : {}),
        ...(r.date !== undefined ? { date: r.date } : {}),
        ...(r.time !== undefined ? { time: r.time } : {}),
        ...(r.wp !== undefined ? { wp: r.wp } : {}),
        ...(r.sysnr !== undefined ? { sysnr: r.sysnr } : {}),
        ...(r.usec !== undefined ? { usec: r.usec } : {}),
      };
      locks.push(lock);
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
      object: firstR.object,
      table: firstR.table,
      user: firstR.user,
      max: firstR.max,
      locks_read: r.locks_read,
      matched: r.matched,
      kept: r.kept,
      truncated: r.truncated,
      server_time: r.server_time,
      fields_present: firstR.fields_present,
    };
  }

  if (summary === undefined) {
    fail("did not return a summary row", rows);
  }

  return { locks, summary };
}

// ---------------------------------------------------------------------------
// GARG / age display helpers
// ---------------------------------------------------------------------------

/**
 * Replaces the observed `ENQUEUE_READ` wildcard-fill character (U+FFFF, see
 * `fpm-lock.ts`'s `GARG_WILDCARD_CHAR`) with `*` and trims the trailing
 * blanks a fixed-width GARG carries, purely for display. This is NOT
 * `fpm-lock.ts`'s `parseGarg`: that function additionally knows the byte
 * offsets of the WDY_CONFIG-specific configId/configType/configVar
 * segments, a layout specific to FPM's own lock-key scheme. A generic SM12
 * lock read via `core.locks` can be over any lock object at all, so there is
 * no segment layout here to decode — only this one generic substitution.
 */
function displayGarg(garg: string): string {
  return garg.split(GARG_WILDCARD_CHAR).join("*").trimEnd();
}

/** `YYYYMMDD`/`HHMMSS` (or a 14-digit `YYYYMMDDHHMMSS` split across the two
 * args) to epoch milliseconds, treating an initial (`00000000`) date or a
 * malformed value as "no timestamp" rather than throwing — a lock row with
 * no usable GTDATE/GTTIME is common (older systems, or the fields simply
 * never got set) and should render as "-", not blow up the whole read. */
function parseStamp(dateStr: string | undefined, timeStr: string | undefined): number | undefined {
  if (dateStr === undefined || timeStr === undefined) return undefined;
  if (dateStr.length !== 8 || timeStr.length !== 6) return undefined;
  if (dateStr === "00000000") return undefined;
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(4, 6));
  const day = Number(dateStr.slice(6, 8));
  const hour = Number(timeStr.slice(0, 2));
  const minute = Number(timeStr.slice(2, 4));
  const second = Number(timeStr.slice(4, 6));
  if ([year, month, day, hour, minute, second].some((n) => Number.isNaN(n))) return undefined;
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/** Larger unit unpadded, smaller unit zero-padded to 2 digits: "3m 12s",
 * "1h 04m", "2d 03h". Plain seconds alone under a minute ("42s"). */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    return `${h}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  }
  const d = Math.floor(s / 86400);
  return `${d}d ${String(Math.floor((s % 86400) / 3600)).padStart(2, "0")}h`;
}

/** "-" whenever either side of the subtraction has no usable timestamp, or
 * the lock's own timestamp is somehow after the server_time this same read
 * reported (clock skew between the enqueue table and this method's own
 * SY-DATUM/SY-UZEIT read, however unlikely, should read as "unknown", not a
 * negative age). */
function ageCell(dateStr: string | undefined, timeStr: string | undefined, serverTime: string): string {
  const lockMs = parseStamp(dateStr, timeStr);
  const nowMs = parseStamp(serverTime.slice(0, 8), serverTime.slice(8, 14));
  if (lockMs === undefined || nowMs === undefined || nowMs < lockMs) return "-";
  return formatDuration((nowMs - lockMs) / 1000);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const LOCK_COLUMNS_BASE = ["gname", "gobj", "user", "mode", "garg"] as const;

function lockRowCells(
  lock: EnqueueLockRow,
  fieldsPresent: ReadonlySet<string>,
  serverTime: string,
): Record<string, string> {
  const wild = hasWildcardFill(lock.garg) ? " (wildcard)" : "";
  const cells: Record<string, string> = {
    gname: lock.gname,
    gobj: lock.gobj,
    user: lock.guname,
    mode: lock.gmode,
    garg: displayGarg(lock.garg) + wild,
  };
  if (fieldsPresent.has("tcode")) cells["tcode"] = lock.tcode ?? "";
  if (fieldsPresent.has("host")) cells["host"] = lock.host ?? "";
  if (fieldsPresent.has("date") && fieldsPresent.has("time")) {
    cells["age"] = ageCell(lock.date, lock.time, serverTime);
  }
  return cells;
}

/**
 * Renders `core.locks` as one header block plus a single LOCKS section (a
 * flat table, unlike `renderLogRead`'s one-section-per-log: there is no
 * natural grouping key across arbitrary SM12 locks the way a BAL log number
 * groups its own messages). Columns beyond the always-present
 * gname/gobj/user/mode/garg are added only when this SAP release's SEQG3
 * actually carries the underlying field — see `abap-locks.ts`'s header
 * comment on why that has to be checked at runtime, not assumed.
 */
export function renderLocks(
  result: EnqueueReadResult,
  opts: { readonly ms?: number; readonly version?: string; readonly deployed?: boolean; readonly maxChars: number },
): { text: string; truncated: boolean } {
  const fieldsPresent = new Set(result.summary.fields_present);
  const columns: string[] = [...LOCK_COLUMNS_BASE];
  if (fieldsPresent.has("tcode")) columns.push("tcode");
  if (fieldsPresent.has("host")) columns.push("host");
  const hasAge = fieldsPresent.has("date") && fieldsPresent.has("time");
  if (hasAge) columns.push("age");

  const rows = result.locks.map((lock) => lockRowCells(lock, fieldsPresent, result.summary.server_time));
  const body = textTable(rows, columns);

  const notes: string[] = [];

  const missing = KNOWN_GT_FIELDS.filter((f) => !fieldsPresent.has(f));
  if (missing.length > 0) {
    notes.push(
      `This system's SEQG3 does not carry: ${missing.join(", ")}. Older SAP releases do not add ` +
        "these diagnostic fields to the lock table, so the corresponding column(s) above are omitted " +
        "entirely rather than shown blank.",
    );
  }

  if (
    hasAge &&
    result.locks.length > 0 &&
    result.locks.every((l) => l.date === undefined || l.date === "" || l.date === "00000000")
  ) {
    notes.push(
      "Every returned lock has an initial (00000000) enqueue date, so no age could be computed " +
        "for any row — this usually means the field is present but unset on this system, not that " +
        "every lock is brand new.",
    );
  }

  notes.push(
    "This is a point-in-time snapshot: ENQUEUE_READ takes no lock of its own on the enqueue " +
      "table, so a row shown here can already be gone, or a new one already added, by the time " +
      "this text is read.",
  );

  notes.push(
    "core.locks is read-only: there is no release/DEQUEUE action here, and there never will be " +
      "one. Releasing a lock safely requires knowing it is actually yours, which needs more than " +
      "an object/table/user filter can tell you.",
  );

  if (result.summary.truncated) {
    notes.push(
      `Not every matching lock was returned: ${result.summary.locks_read} lock(s) were read from the ` +
        `enqueue table, ${result.summary.matched} matched object/table/user, and only ${result.summary.kept} ` +
        `(max=${result.summary.max}) are shown below. Raise max, or narrow object/table/user, to see a ` +
        "different slice.",
    );
  }

  notes.push(
    "guname is the SAP user that owns a lock, not the session: two sessions of the same user " +
      "hold separate locks with the same guname but different gusr/gusrvb — compare gusr/gusrvb, " +
      "not guname, to tell sessions of the same user apart.",
  );

  const built = buildResponse({
    header: {
      tool: "core",
      action: "locks",
      object: result.summary.object || "*",
      table: result.summary.table || "*",
      user: result.summary.user || "*",
      max: result.summary.max,
      read: result.summary.locks_read,
      matched: result.summary.matched,
      kept: result.summary.kept,
      truncated: result.summary.truncated,
      server_time: result.summary.server_time,
      ...(opts.ms !== undefined ? { ms: opts.ms } : {}),
      ...(opts.version !== undefined ? { version: opts.version } : {}),
      ...(opts.deployed !== undefined ? { deployed: opts.deployed } : {}),
    },
    sections: [{ title: "LOCKS", content: body }],
    notes,
    // No `pagingParam`: `core.locks` narrows via object/table/user/max, not
    // an offset — same reasoning as `renderLogRead`'s omission for `log.read`.
    maxChars: opts.maxChars,
  });

  return { text: built.text, truncated: built.truncated };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * One stderr line naming the filters and the matched/kept counts — never a
 * GARG or any other row content. A GARG is built from application key
 * values (see `fpm-lock.ts`'s extensive discussion of what a GARG can
 * legitimately contain), so it is application data in the same sense BAL
 * message text is in `auditLogRead` — this line answers "what was looked at
 * and how much came back", nothing that came back.
 */
export function auditLocks(result: EnqueueReadResult, audit: (m: string) => void): void {
  audit(
    "[abapsmith] audit: abap_fluid core.locks " +
      `object=${result.summary.object || "*"} table=${result.summary.table || "*"} ` +
      `user=${result.summary.user || "*"} read=${result.summary.locks_read} ` +
      `matched=${result.summary.matched} kept=${result.summary.kept}`,
  );
}

// ---------------------------------------------------------------------------
// Holder summary — a small derived view, not a wire shape of its own.
// ---------------------------------------------------------------------------

/**
 * Turns a read result into at most `limit` holder records — e.g. for a
 * caller that wants "who holds what" without `renderLocks`'s full
 * text-table rendering. Pure and side-effect free.
 *
 * Deliberately a manual bounded loop rather than a bare slice cap. This
 * wording deliberately avoids spelling out that slice-call shape, because
 * `test/no-silent-truncation.test.ts` scans comment text too, not just
 * code. The cap here is `limit`, it is the caller's own argument, and it is
 * visible in this function's own signature — the bounded loop keeps the
 * omission the caller's own decision.
 */
export function formatLockHolders(
  result: EnqueueReadResult,
  limit: number,
): readonly {
  readonly user: string;
  readonly tcode?: string;
  readonly age?: string;
  readonly gname: string;
  readonly garg: string;
}[] {
  const out: { user: string; tcode?: string; age?: string; gname: string; garg: string }[] = [];
  for (const lock of result.locks) {
    if (out.length >= limit) break;
    const age = ageCell(lock.date, lock.time, result.summary.server_time);
    out.push({
      user: lock.guname,
      ...(lock.tcode !== undefined ? { tcode: lock.tcode } : {}),
      ...(age !== "-" ? { age } : {}),
      gname: lock.gname,
      garg: displayGarg(lock.garg),
    });
  }
  return out;
}
