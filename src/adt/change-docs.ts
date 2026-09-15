/**
 * `abap_fluid run tool:"core" action:"change_docs"`'s TypeScript side: input
 * validation before the network call, row validation for the NDJSON
 * `ZCL_ZMCP_FLUID_CORE` emits (`src/adt/fluid/builtin/core/abap-change-docs.ts`),
 * the position-level deny-list/row-cap policy pass, text-table rendering, and
 * a stderr audit line. Modeled directly on `src/adt/bal-log.ts`: `mapChangeDocRows`
 * rebuilds a typed result from the row array `dispatch()` returns, validating
 * each row's concrete shape beyond what the manifest's output schema already
 * checked (kind is a known string; the rest of the shape is this file's job),
 * and `renderChangeDocs` renders through the same `buildResponse`/`textTable`
 * machinery `renderLogRead` does.
 *
 * Unlike `log.read`, `core.change_docs` carries NO authorization policy on
 * the ABAP side at all — see the header comment on
 * `src/adt/fluid/builtin/core/abap-change-docs.ts` for why. That means the
 * deny-list/row-cap judgment other tools get for free from the ABAP side
 * (`abap_data_preview`'s `assertDataPreview` gate, called BEFORE the read)
 * has to happen HERE instead, AFTER the read, once for every distinct table
 * a returned `CDPOS` row names — `applyPositionPolicy` is that pass. A
 * denied position is dropped, never shown, and always counted so the
 * omission is visible in the rendered response's notes.
 */
import { AbapError } from "./errors.js";
import { buildResponse, textTable } from "../compact.js";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const CHANGE_DOCS_TOOL_ID = "core";
export const CHANGE_DOCS_ACTION = "change_docs";

// ---------------------------------------------------------------------------
// Result model
//
// Field names below are the WIRE names the `core.change_docs` NDJSON contract
// uses (`objectclas`, `udate`, `chngind`, …), not camelCased or corrected to
// the "objectclass" spelling used elsewhere in this same file for the
// caller-facing filter argument. That is deliberate: it keeps `mapChangeDocRows`
// a visibly one-to-one copy of the contract described in the ABAP side's doc
// comment, rather than a translation layer that could silently drift from it
// over time (see bal-log.ts's identical convention).
// ---------------------------------------------------------------------------

export interface ChangeDocPosition {
  readonly changenr: string;
  readonly tabname: string;
  readonly tabkey: string;
  readonly fname: string;
  readonly chngind: string;
  readonly value_old: string;
  readonly value_new: string;
}

export interface ChangeDocHeader {
  readonly objectclas: string;
  readonly objectid: string;
  readonly changenr: string;
  readonly username: string;
  readonly udate: string;
  readonly utime: string;
  readonly tcode: string;
  readonly change_ind: string;
  readonly positions: readonly ChangeDocPosition[];
}

export interface ChangeDocSummary {
  readonly changes_returned: number;
  readonly positions_returned: number;
  readonly truncated: boolean;
  readonly objectclass: string;
  readonly objectid: string;
  readonly user: string;
  readonly tcode: string;
  readonly since: string;
  readonly until: string;
  readonly max: number;
  readonly server_time: string;
}

export interface ChangeDocResult {
  readonly changes: readonly ChangeDocHeader[];
  readonly summary: ChangeDocSummary;
}

// ---------------------------------------------------------------------------
// Pre-network-call argument validation
// ---------------------------------------------------------------------------

/**
 * Client-side checks decidable from the arguments alone, so a caller mistake
 * gets `BAD_INPUT` for free, with no network call. Mirrors
 * `assertLogReadArgsNoWindowConflict` in bal-log.ts. Everything else — e.g.
 * whether `objectclass` names a real CDHDR-registered object class, whether
 * `max` exceeds any server-side ceiling — is left to the manifest schema and
 * the ABAP side, which already refuse those cleanly.
 */
export function assertChangeDocsArgs(args: unknown): void {
  const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;

  const objectclass = a["objectclass"];
  if (typeof objectclass !== "string" || objectclass.trim() === "") {
    throw new AbapError(
      "BAD_INPUT",
      "core.change_docs: objectclass is required and must be a non-empty string.",
      { field: "objectclass" },
      'Pass the CDHDR object class to read, e.g. { "objectclass": "MATERIAL" }.',
    );
  }

  const since = a["since"];
  if (since !== undefined) {
    if (typeof since !== "string" || !/^\d{14}$/.test(since)) {
      throw new AbapError(
        "BAD_INPUT",
        `core.change_docs: since must be 14 digits YYYYMMDDHHMMSS, got ${JSON.stringify(since)}.`,
        { field: "since" },
        "Pass server time as YYYYMMDDHHMMSS, e.g. \"20260915120000\".",
      );
    }
  }

  const until = a["until"];
  if (until !== undefined) {
    if (typeof until !== "string" || !/^\d{14}$/.test(until)) {
      throw new AbapError(
        "BAD_INPUT",
        `core.change_docs: until must be 14 digits YYYYMMDDHHMMSS, got ${JSON.stringify(until)}.`,
        { field: "until" },
        "Pass server time as YYYYMMDDHHMMSS, e.g. \"20260915120000\".",
      );
    }
  }

  // Plain string compare: both are already confirmed to be 14-digit
  // YYYYMMDDHHMMSS at this point, and that format sorts lexicographically in
  // the same order as chronologically.
  if (
    typeof since === "string" &&
    typeof until === "string" &&
    /^\d{14}$/.test(since) &&
    /^\d{14}$/.test(until) &&
    since > until
  ) {
    throw new AbapError(
      "BAD_INPUT",
      `core.change_docs: since (${since}) is after until (${until}).`,
      { field: "since" },
      "Swap since/until, or drop one so the window is open-ended on that side.",
    );
  }

  const max = a["max"];
  if (max !== undefined) {
    if (typeof max !== "number" || !Number.isInteger(max) || max < 0) {
      throw new AbapError(
        "BAD_INPUT",
        `core.change_docs: max must be a non-negative whole number, got ${JSON.stringify(max)}.`,
        { field: "max" },
        "Omit max for the server's default, or pass a whole number >= 0.",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Result mapping — pure and total; throws FLUID_PROTOCOL_ERROR on any shape
// the manifest's output schema does not actually rule out (see bal-log.ts's
// identical comment: `dispatch()` only checks that array items are objects
// with a string "kind"; the concrete per-row shape is this function's job).
// ---------------------------------------------------------------------------

function fail(reason: string, rows: unknown): never {
  throw new AbapError(
    "FLUID_PROTOCOL_ERROR",
    `change_docs ${reason}`,
    { tool: CHANGE_DOCS_TOOL_ID, action: CHANGE_DOCS_ACTION, result: rows },
  );
}

interface RawHeaderRow {
  [key: string]: unknown;
  kind: "header";
  objectclas: string;
  objectid: string;
  changenr: string;
  username: string;
  udate: string;
  utime: string;
  tcode: string;
  change_ind: string;
}

interface RawPosRow {
  [key: string]: unknown;
  kind: "pos";
  changenr: string;
  tabname: string;
  tabkey: string;
  fname: string;
  chngind: string;
  value_old: string;
  value_new: string;
}

interface RawSummaryRow {
  [key: string]: unknown;
  kind: "summary";
  changes_returned: number;
  positions_returned: number;
  truncated: boolean;
  objectclass: string;
  objectid: string;
  user: string;
  tcode: string;
  since: string;
  until: string;
  max: number;
  server_time: string;
}

function isHeaderRow(r: Record<string, unknown>): r is RawHeaderRow {
  return (
    typeof r["objectclas"] === "string" &&
    typeof r["objectid"] === "string" &&
    typeof r["changenr"] === "string" &&
    typeof r["username"] === "string" &&
    typeof r["udate"] === "string" &&
    typeof r["utime"] === "string" &&
    typeof r["tcode"] === "string" &&
    typeof r["change_ind"] === "string"
  );
}

function isPosRow(r: Record<string, unknown>): r is RawPosRow {
  return (
    typeof r["changenr"] === "string" &&
    typeof r["tabname"] === "string" &&
    typeof r["tabkey"] === "string" &&
    typeof r["fname"] === "string" &&
    typeof r["chngind"] === "string" &&
    typeof r["value_old"] === "string" &&
    typeof r["value_new"] === "string"
  );
}

function isSummaryRow(r: Record<string, unknown>): r is RawSummaryRow {
  return (
    typeof r["changes_returned"] === "number" &&
    typeof r["positions_returned"] === "number" &&
    typeof r["truncated"] === "boolean" &&
    typeof r["objectclass"] === "string" &&
    typeof r["objectid"] === "string" &&
    typeof r["user"] === "string" &&
    typeof r["tcode"] === "string" &&
    typeof r["since"] === "string" &&
    typeof r["until"] === "string" &&
    typeof r["max"] === "number" &&
    typeof r["server_time"] === "string"
  );
}

type MutableHeader = Omit<ChangeDocHeader, "positions"> & { positions: ChangeDocPosition[] };

export function mapChangeDocRows(rows: readonly unknown[]): ChangeDocResult {
  if (!Array.isArray(rows)) {
    fail("returned a result that is not an array", rows);
  }

  const changes: MutableHeader[] = [];
  let currentHeader: MutableHeader | undefined;
  let summary: ChangeDocSummary | undefined;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      fail(`row ${i} is not an object`, rows);
    }
    const r = row as Record<string, unknown>;
    if (r["kind"] !== "header" && r["kind"] !== "pos" && r["kind"] !== "summary") {
      fail(`row ${i} has kind "${String(r["kind"])}", expected "header", "pos" or "summary"`, rows);
    }
    // A row after the trailing summary row is always wrong, whatever its own
    // kind — this also gives "more than one summary row" and "summary row
    // not last" a single implementation instead of one per branch below.
    if (summary !== undefined) {
      fail(`row ${i} follows the trailing summary row`, rows);
    }

    if (r["kind"] === "header") {
      if (!isHeaderRow(r)) {
        fail(`row ${i} is a header row missing or mistyping one of its required fields`, rows);
      }
      const entry: MutableHeader = {
        objectclas: r.objectclas,
        objectid: r.objectid,
        changenr: r.changenr,
        username: r.username,
        udate: r.udate,
        utime: r.utime,
        tcode: r.tcode,
        change_ind: r.change_ind,
        positions: [],
      };
      changes.push(entry);
      currentHeader = entry;
      continue;
    }

    if (r["kind"] === "pos") {
      if (currentHeader === undefined) {
        fail(`row ${i} is a pos row before any header row`, rows);
      }
      if (!isPosRow(r)) {
        fail(`row ${i} is a pos row missing or mistyping one of its required fields`, rows);
      }
      if (r.changenr !== currentHeader.changenr) {
        fail(
          `row ${i} is a pos row for changenr "${r.changenr}", but the open header is changenr "${currentHeader.changenr}"`,
          rows,
        );
      }
      currentHeader.positions.push({
        changenr: r.changenr,
        tabname: r.tabname,
        tabkey: r.tabkey,
        fname: r.fname,
        chngind: r.chngind,
        value_old: r.value_old,
        value_new: r.value_new,
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
      changes_returned: r.changes_returned,
      positions_returned: r.positions_returned,
      truncated: r.truncated,
      objectclass: r.objectclass,
      objectid: r.objectid,
      user: r.user,
      tcode: r.tcode,
      since: r.since,
      until: r.until,
      max: r.max,
      server_time: r.server_time,
    };
  }

  if (summary === undefined) {
    fail("did not return a summary row", rows);
  }

  return { changes, summary };
}

// ---------------------------------------------------------------------------
// Policy pass — the deny-list/row-cap judgment `core.change_docs` gets none
// of for free from the ABAP side (see this file's header comment).
// ---------------------------------------------------------------------------

export interface DeniedPositionTable {
  readonly table: string;
  readonly reason: string;
  readonly rows: number;
}

export interface ChangeDocPolicyResult {
  readonly result: ChangeDocResult;
  readonly denied: readonly DeniedPositionTable[];
  readonly positionsTotal: number;
  readonly positionsAllowed: number;
  readonly positionsShown: number;
  readonly clamped: boolean;
  readonly maxRows: number;
}

/**
 * Judges every distinct `tabname` a returned `CDPOS` position names exactly
 * once (`opts.assertDataPreview` is not re-called for a table already
 * judged), drops the positions of any table it denies — counting them,
 * never silently — then clamps the survivors to `opts.maxRows`, walking
 * change documents and their positions in the order the ABAP side returned
 * them. A change document all of whose positions were dropped or clamped
 * still appears in the output, with an empty `positions` array, rather than
 * disappearing — the caller sees that the change happened even when none of
 * its field-level detail is shown. `result.summary` is passed through
 * unchanged: it already reports what the ABAP side actually read, before
 * this policy pass narrows what is shown.
 *
 * The clamp below is a deliberate counting loop rather than a bare slice
 * cap. This wording deliberately avoids spelling out that slice-call shape,
 * because `test/no-silent-truncation.test.ts` scans comment text too, not
 * just code, and this pass reports the drop one level up through
 * `clamped`/`positionsShown`/`positionsAllowed` in `renderChangeDocs`, not
 * inline here.
 */
export function applyPositionPolicy(
  result: ChangeDocResult,
  opts: { readonly assertDataPreview: (table: string) => void; readonly maxRows: number },
): ChangeDocPolicyResult {
  const verdicts = new Map<string, string | undefined>();
  const deniedCounts = new Map<string, { reason: string; rows: number }>();

  const judge = (table: string): string | undefined => {
    if (verdicts.has(table)) return verdicts.get(table);
    let reason: string | undefined;
    try {
      opts.assertDataPreview(table);
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    verdicts.set(table, reason);
    return reason;
  };

  let positionsTotal = 0;
  let positionsAllowed = 0;

  const allowedByHeader: ChangeDocPosition[][] = result.changes.map((header) => {
    const kept: ChangeDocPosition[] = [];
    for (const pos of header.positions) {
      positionsTotal++;
      const reason = judge(pos.tabname);
      if (reason !== undefined) {
        const existing = deniedCounts.get(pos.tabname);
        if (existing) {
          existing.rows++;
        } else {
          deniedCounts.set(pos.tabname, { reason, rows: 1 });
        }
        continue;
      }
      positionsAllowed++;
      kept.push(pos);
    }
    return kept;
  });

  // Clamp survivors to maxRows, walking docs/positions in the order they
  // were returned — an explicit counting loop, never `.slice`, see the
  // function doc comment above.
  let remaining = opts.maxRows;
  const finalByHeader: ChangeDocPosition[][] = allowedByHeader.map((positions) => {
    const kept: ChangeDocPosition[] = [];
    for (const pos of positions) {
      if (remaining <= 0) break;
      kept.push(pos);
      remaining--;
    }
    return kept;
  });

  let positionsShown = 0;
  for (const positions of finalByHeader) {
    positionsShown += positions.length;
  }

  const changes: ChangeDocHeader[] = result.changes.map((header, i) => ({
    ...header,
    positions: finalByHeader[i] ?? [],
  }));

  const denied: DeniedPositionTable[] = Array.from(deniedCounts.entries()).map(([table, v]) => ({
    table,
    reason: v.reason,
    rows: v.rows,
  }));

  return {
    result: { changes, summary: result.summary },
    denied,
    positionsTotal,
    positionsAllowed,
    positionsShown,
    clamped: positionsShown < positionsAllowed,
    maxRows: opts.maxRows,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const CHANGE_DOC_POSITION_COLUMNS = ["table", "key", "field", "old", "new", "ind"] as const;

function changeDocSectionTitle(doc: ChangeDocHeader): string {
  return `${doc.changenr} ${doc.username} ${doc.udate} ${doc.utime} ${doc.tcode} [${doc.change_ind}]`;
}

function changeDocSectionContent(doc: ChangeDocHeader): string {
  if (doc.positions.length === 0) return "(no positions)";
  const rows = doc.positions.map((p) => ({
    table: p.tabname,
    key: p.tabkey,
    field: p.fname,
    old: p.value_old,
    new: p.value_new,
    ind: p.chngind,
  }));
  return textTable(rows, [...CHANGE_DOC_POSITION_COLUMNS]);
}

/**
 * Renders `core.change_docs` as one header block plus one section PER
 * CHANGE DOCUMENT — mirrors `renderLogRead`'s one-section-per-log shape and
 * for the same reason: a flat table would either repeat every header field
 * on every position row or separate a change's positions from the header
 * that scopes them.
 */
export function renderChangeDocs(
  policy: ChangeDocPolicyResult,
  opts: { readonly ms?: number; readonly version?: string; readonly deployed?: boolean; readonly maxChars: number },
): { text: string; truncated: boolean } {
  const { result } = policy;

  const sections = result.changes.map((doc) => ({
    title: changeDocSectionTitle(doc),
    content: changeDocSectionContent(doc),
  }));

  const notes: string[] = [];

  if (policy.denied.length > 0) {
    for (const d of policy.denied) {
      notes.push(
        `DENIED: ${d.rows} position(s) on table ${d.table} were not shown (${d.reason}). The ` +
          "data-preview deny-list applies to every table a CDPOS row names, not just CDHDR/CDPOS " +
          "themselves — a change document naming a denied table still appears above, with that " +
          "position dropped.",
      );
    }
  }

  if (policy.clamped) {
    notes.push(
      `CLAMPED: ${policy.positionsAllowed} position(s) were allowed by policy, but only ` +
        `${policy.positionsShown} are shown here (max=${policy.maxRows}, ABAP_DATA_PREVIEW_MAX_ROWS-style ` +
        "row ceiling applied on the TypeScript side, not the ABAP side — see this file's header " +
        "comment). The positions beyond that were fetched but NOT shown.",
    );
  }

  if (result.summary.truncated) {
    notes.push(
      `Not every matching change document was returned (max=${result.summary.max}). Raise max, or ` +
        "narrow the window with since/until, or narrow objectid/user/tcode, to see a different slice.",
    );
  }

  notes.push(
    "chngind meaning: U = update, I = insert, D = delete, E = single-field delete (part of a " +
      "larger change).",
  );
  notes.push(
    "value_old and value_new are application/business data written by whatever program made the " +
      "change, not abapsmith's own output.",
  );

  const built = buildResponse({
    header: {
      tool: CHANGE_DOCS_TOOL_ID,
      action: CHANGE_DOCS_ACTION,
      changes: result.summary.changes_returned,
      positions_shown: policy.positionsShown,
      positions_total: policy.positionsTotal,
      objectclass: result.summary.objectclass,
      objectid: result.summary.objectid,
      user: result.summary.user,
      tcode: result.summary.tcode,
      since: result.summary.since,
      until: result.summary.until,
      server_time: result.summary.server_time,
      ...(opts.ms !== undefined ? { ms: opts.ms } : {}),
      ...(opts.version !== undefined ? { version: opts.version } : {}),
      ...(opts.deployed !== undefined ? { deployed: opts.deployed } : {}),
      truncated: result.summary.truncated,
    },
    sections,
    notes,
    // No `pagingParam`: `core.change_docs` has no offset/paging argument —
    // the fluid action narrows via since/until/objectid/user/tcode/max
    // instead. Advertising a parameter here would tell the caller to pass
    // something `dispatch()` would then reject; omitting it makes
    // `buildResponse` say paging isn't available instead.
    maxChars: opts.maxChars,
  });

  return { text: built.text, truncated: built.truncated };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * One stderr line naming only the filter (`objectclass`/`objectid`) and the
 * change/position/denied counts — never any field value, since CDPOS's
 * `value_old`/`value_new` are application data that may contain business
 * data (see `renderChangeDocs`'s note above). Deliberately mirrors
 * `auditLogRead`'s shape in bal-log.ts and `abap_data_preview`'s audit line
 * in `src/tools/data-preview.ts`: "what was looked at and how much came
 * back", nothing that came back.
 */
export function auditChangeDocs(policy: ChangeDocPolicyResult, audit: (m: string) => void): void {
  audit(
    "[abapsmith] audit: abap_fluid core.change_docs " +
      `objectclass=${policy.result.summary.objectclass} objectid=${policy.result.summary.objectid} ` +
      `changes=${policy.result.changes.length} positions=${policy.positionsShown} ` +
      `denied_tables=${policy.denied.length}`,
  );
}
