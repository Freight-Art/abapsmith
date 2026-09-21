/**
 * After-the-fact dump lookup for `abap_run` (issue #149).
 *
 * When the classrun request times out, or answers HTTP 200 with something
 * that is not console output, the ICF error page that would have named the
 * short dump never arrived. The dump itself, if there was one, is still in
 * ST22 — so this module asks the dumps feed for entries of the same user
 * within the last minute and matches them on the terminated program.
 *
 * Wire cost: one feed GET (`probe: false` — no catalog round trip; the
 * as-captured contract carries the `user` predicate) plus one detail GET for
 * the matching entry, to name the exception class the feed row does not
 * carry. A lookup that fails for any reason is reported as such in
 * `RecentDumpLookup.failure` and never masks the original run error.
 *
 * Clock: the request never got an answer, so there is no server time to
 * anchor on. The window is built from this process's clock, formatted as
 * UTC, which is what A4H's feed timestamps are (every captured
 * `atom:published` carries `Z`). A system whose feed runs on another local
 * time drifts the window by that offset — `details.dumpLookup` states the
 * window so the miss is visible, not silent.
 */
import type { AbapConnection } from "./connection.js";
import { fetchDumpDetail, listDumps } from "./dumps.js";

/** How far back the feed is asked for a dump of this run. */
export const RECENT_DUMP_LOOKBACK_SECONDS = 60;

/** Rows requested from the feed. Each is ~12 KB on the wire; a user rarely dumps this often in a minute. */
export const RECENT_DUMP_MAX_ROWS = 20;

/** Class pool names are the class name padded with `=` to 30 characters, then `CP`. */
const CLASS_NAME_WIDTH = 30;

/**
 * `ZCL_FOO` → `ZCL_FOO=======================CP` — how the dumps feed names a
 * class's terminated program (`atom:category[@label="Terminated ABAP program"]`).
 */
export function classPoolName(className: string): string {
  return `${className.toUpperCase().padEnd(CLASS_NAME_WIDTH, "=")}CP`;
}

/** Case-insensitive match of a feed row's terminated program against the run's candidates. */
export function programMatches(terminatedProgram: string, programs: readonly string[]): boolean {
  const upper = terminatedProgram.trim().toUpperCase();
  return upper !== "" && programs.some((p) => p.trim().toUpperCase() === upper);
}

/** The window the feed was asked about — the same shape `RUNTIME_DUMP.details.dumpCorrelation` uses. */
export interface RecentDumpWindow {
  /** 14-digit, inclusive. */
  from: string;
  /** 14-digit, inclusive. */
  to: string;
  /** UPPERCASED user the feed was filtered on; absent when the connection has none. */
  user?: string;
  /** The FQL sent as `$query`, when a user was known. */
  query?: string;
}

/** One feed row, reduced to what an error envelope needs. */
export interface RecentDump {
  /** The feed key, verbatim — the only thing `abap_dumps mode=show` accepts. */
  key: string;
  /** e.g. `COMPUTE_INT_ZERODIVIDE`. */
  runtimeError: string;
  /** The exception class (`CX_SY_ZERODIVIDE`), from the detail document. Absent when that fetch failed or the dump has none. */
  exception?: string;
  /** The feed row's title. */
  shortText: string;
  /** The terminated program as the feed names it, e.g. `ZCL_FOO=======================CP`. */
  program: string;
  user: string;
  /** ISO instant from the feed row. */
  published: string;
}

export interface RecentDumpLookup {
  window: RecentDumpWindow;
  /** The programs the rows were matched against. */
  programs: string[];
  /** The newest matching dump, when there is one. */
  found?: RecentDump;
  /** Rows the feed returned for this user in the window, before the program match. */
  candidates: number;
  /** Set when the feed (not the match) failed — nothing can then be said either way. */
  failure?: string;
}

const FAILURE_TEXT_MAX = 200;

function describeFailure(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return text.length > FAILURE_TEXT_MAX ? `${text.slice(0, FAILURE_TEXT_MAX)}…` : text;
}

/**
 * Ask the feed for dumps of `window.user` inside `window` and return the
 * newest one whose terminated program is one of `programs`.
 *
 * Never throws: a feed or detail failure lands in the result. The feed is
 * newest-first, so the first match is the newest.
 */
export async function findRecentDump(
  conn: AbapConnection,
  window: RecentDumpWindow,
  programs: readonly string[],
): Promise<RecentDumpLookup> {
  const wanted = programs.map((p) => p.toUpperCase());
  const base: RecentDumpLookup = { window, programs: wanted, candidates: 0 };

  let entries;
  try {
    const page = await listDumps(
      conn,
      {
        ...(window.query === undefined ? {} : { $query: window.query }),
        from: window.from,
        to: window.to,
        $top: RECENT_DUMP_MAX_ROWS,
      },
      { probe: false },
    );
    entries = page.entries;
  } catch (e) {
    return { ...base, failure: describeFailure(e) };
  }

  // The server filtered on user already when a query went out; filter again so
  // a feed that silently ignored `$query` (its documented failure mode) cannot
  // attribute another user's dump to this run.
  const mine =
    window.user === undefined
      ? entries
      : entries.filter((entry) => entry.user.toUpperCase() === window.user);
  const match = mine.find((entry) => programMatches(entry.terminatedProgram, wanted));
  if (match === undefined) return { ...base, candidates: mine.length };

  const found: RecentDump = {
    key: match.key,
    runtimeError: match.runtimeError,
    shortText: match.title,
    program: match.terminatedProgram,
    user: match.user,
    published: match.published,
  };
  try {
    const detail = await fetchDumpDetail(conn, match.key);
    if (detail.exception) found.exception = detail.exception;
  } catch {
    // The feed row already names the runtime error; the exception class is a nicety.
  }
  return { ...base, found, candidates: mine.length };
}
