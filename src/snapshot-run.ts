/**
 * Shared snapshot/diff engine for `abap_data_preview`'s `mode: "snapshot"`/
 * `mode: "diff"` (issue #117) and — later, wired up by another change — the
 * `snapshot_ids` option `abap_run`/`abap_test`/`abap_bopf_test`/`abap_ui`
 * accept to report what a mutating call changed in the tables it touched.
 * All of those go through the two functions below (`takeSnapshot`/
 * `diffSnapshot`) rather than each re-implementing the clamp/gate/re-read
 * sequence, so the sequence is guaranteed identical everywhere it runs.
 *
 * `snapshot`/`diff` go through the SAME THREE GATES, in the SAME ORDER, as
 * `mode: "preview"` (`src/tools/data-preview.ts`): (1) the tool must be
 * enabled at all (`toolCapabilities.canPreviewData`, checked before this
 * module is ever reached); (2) the row ceiling (here: `deps.maxRows`,
 * `cfg.dataPreviewMaxRows`); (3) `deps.assertDataPreview`
 * (`safety.assertDataPreview`), called before EVERY read this module makes —
 * once when a snapshot is taken, and AGAIN when it is diffed, since the
 * deny-list can grow between the two (see `diffSnapshot`'s own comment).
 *
 * Snapshot files live under `ABAP_STATE_DIR` (`src/snapshot-store.ts`),
 * never in the journal directory, so a stored snapshot's rows cannot surface
 * through `abap_journal` or any journal export — the journal exists to
 * carry before-images of SOURCE, not table data.
 */
import { AbapError } from "./adt/errors.js";
import type { PreviewResult } from "./adt/datapreview.js";
import { isEmptyFilter, type PreviewFilter, type PreviewCondition } from "./adt/datapreview-filter.js";
import {
  newSnapshotId,
  readSnapshot,
  writeSnapshot,
  diffSnapshotRows,
  type StoredSnapshot,
  type SnapshotColumn,
  type SnapshotDiff,
  type ChangedRow,
} from "./snapshot-store.js";
import { buildResponse, textTable, type BuiltResponse } from "./compact.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface SnapshotRunDeps {
  /** Runs one preview read. Wraps `previewDdicEntity` plus whatever pool lease the caller uses. */
  readonly read: (table: string, maxRows: number, filter?: PreviewFilter) => Promise<PreviewResult>;
  /** `safety.assertDataPreview` — called before EVERY read, snapshot and diff alike. */
  readonly assertDataPreview: (table: string) => void;
  /** `systemKey({sid, url, client})` of the live connection. */
  readonly systemKey: string;
  readonly maxRows: number; // cfg.dataPreviewMaxRows
  readonly ttlCeilingHours: number; // cfg.dataSnapshotTtlHours
  readonly stateDir?: string; // tests inject; production omits
  readonly now?: () => Date; // tests inject
}

// ---------------------------------------------------------------------------
// takeSnapshot
// ---------------------------------------------------------------------------

/**
 * Whether the read projected a subset of columns rather than the whole
 * entity — the one thing that decides if `keyComplete` below can be trusted.
 */
function hasProjection(filter: PreviewFilter | undefined): boolean {
  return filter?.columns !== undefined && filter.columns.length > 0;
}

export async function takeSnapshot(
  deps: SnapshotRunDeps,
  opts: { table: string; maxRowsRequested: number; filter?: PreviewFilter; ttlHours?: number },
): Promise<{ snapshot: StoredSnapshot; result: PreviewResult; ttlClamped: boolean }> {
  // 1. Gate BEFORE the read — a denied table costs zero READ requests, same
  //    discipline as the plain preview path.
  deps.assertDataPreview(opts.table);

  // 2. Row ceiling clamp. `effective` is what actually gets asked for and is
  //    what ends up recorded in `selection.max_rows` — never the caller's
  //    raw ask.
  const effective = Math.min(opts.maxRowsRequested, deps.maxRows);

  // 3. TTL ceiling clamp. The operator setting (`deps.ttlCeilingHours`) is a
  //    CEILING, not a default: it only ever clamps DOWN. A non-integer or
  //    `< 1` `ttlHours` is refused by the tool layer as `BAD_INPUT` before
  //    this function is ever called — this function only ever clamps a
  //    value already known to be a valid positive integer.
  const requestedTtl = opts.ttlHours ?? deps.ttlCeilingHours;
  const ttlHours = Math.min(requestedTtl, deps.ttlCeilingHours);
  const ttlClamped = ttlHours < requestedTtl;

  // 4. The read.
  const result = await deps.read(opts.table, effective, opts.filter);

  // 5. Build and store the snapshot.
  const now = deps.now?.() ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000).toISOString();

  const columns: SnapshotColumn[] = result.columns.map((c) => ({ name: c.name, key: c.key === true }));

  // KEY COMPLETENESS — the honesty-critical part. `result.columns` only
  // describes the columns that actually came back.
  let keyColumns: readonly string[];
  let keyComplete: boolean;
  if (!hasProjection(opts.filter)) {
    // No projection was given: every column of the entity came back, so the
    // key-flagged columns in the response ARE the entity's full DDIC key.
    // A DDIC entity that reports no key column at all (some CDS views) gets
    // `keyComplete: false` here too — an empty key is not a complete one.
    keyColumns = columns.filter((c) => c.key).map((c) => c.name);
    keyComplete = keyColumns.length > 0;
  } else {
    // A `columns` projection WAS given. This response alone cannot say
    // whether the projection covers the entity's full key — a key column
    // left out of the projection simply never appears here; there is no
    // signal in this response that could tell "the key is fully present"
    // apart from "the key just isn't projected". `keyComplete: false` is
    // therefore unconditional on this branch: a deliberate, conservative,
    // honest answer, not a bug. Inferring completeness from a projection
    // (e.g. "the caller listed every key field they knew about") would be a
    // guess this module has no basis for making.
    keyColumns = columns.filter((c) => c.key).map((c) => c.name);
    keyComplete = false;
  }

  const snapshot: StoredSnapshot = {
    version: 1,
    id: newSnapshotId(),
    systemKey: deps.systemKey,
    createdAt,
    expiresAt,
    ttlHours,
    selection: {
      table: result.table,
      max_rows: effective,
      ...(opts.filter !== undefined && !isEmptyFilter(opts.filter) ? { filter: opts.filter } : {}),
    },
    columns,
    rows: result.rows,
    moreRowsExist: result.moreRowsExist,
    keyColumns,
    keyComplete,
  };

  writeSnapshot(snapshot, { stateDir: deps.stateDir, now });

  return { snapshot, result, ttlClamped };
}

// ---------------------------------------------------------------------------
// diffSnapshot
// ---------------------------------------------------------------------------

export async function diffSnapshot(
  deps: SnapshotRunDeps,
  id: string,
): Promise<{
  before: StoredSnapshot;
  after: PreviewResult;
  diff: SnapshotDiff;
  moreRowsExistBefore: boolean;
  moreRowsExistAfter: boolean;
}> {
  // 1. `NOT_FOUND` for an unknown id or a foreign system, `SNAPSHOT_EXPIRED`
  //    past the TTL — both propagate unchanged.
  const before = readSnapshot(id, deps.systemKey, { stateDir: deps.stateDir, now: deps.now?.() });

  // 2. Gate AGAIN, at diff time. `ABAP_DATA_PREVIEW_DENY_TABLES` can grow
  //    between the snapshot and the diff, and a stored snapshot must not be
  //    a way around a later addition. This runs BEFORE the re-read below, so
  //    a now-denied table costs zero READ requests here too.
  deps.assertDataPreview(before.selection.table);

  // 3. Re-read with the snapshot's OWN recorded selection — never the
  //    current caller's arguments (there are none to take; see the tool
  //    layer's cross-checks), and never re-clamped against a ceiling that
  //    may have changed since the snapshot was taken. `selection.max_rows`
  //    is already the clamped effective count from when the snapshot was
  //    taken.
  const after = await deps.read(before.selection.table, before.selection.max_rows, before.selection.filter);

  // 4. Decide what to match rows on.
  let matchOn: readonly string[];
  if (before.keyComplete) {
    matchOn = before.keyColumns;
  } else {
    const afterNames = new Set(after.columns.map((c) => c.name));
    matchOn = before.columns.map((c) => c.name).filter((name) => afterNames.has(name));
    if (matchOn.length === 0) {
      throw new AbapError(
        "BAD_INPUT",
        `Snapshot ${before.id} of ${before.selection.table} has no complete key, and the current ` +
          "read shares no column name with it, so the two reads cannot be compared.",
        { snapshotId: before.id, table: before.selection.table },
        "Take a fresh snapshot of the entity in its current shape and diff against that instead.",
      );
    }
  }

  const afterColumns: SnapshotColumn[] = after.columns.map((c) => ({ name: c.name, key: c.key === true }));

  // 5. The pure diff.
  const diff = diffSnapshotRows(before, { columns: afterColumns, rows: after.rows }, matchOn);

  return {
    before,
    after,
    diff,
    moreRowsExistBefore: before.moreRowsExist,
    moreRowsExistAfter: after.moreRowsExist,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Dedupes column names for `textTable` (keyed by name) so same-named or
 * unnamed columns don't collapse and drop data. Duplicated from
 * `src/tools/data-preview.ts`'s private helper of the same name rather than
 * imported: that module imports THIS one (for `SnapshotRunDeps`/
 * `takeSnapshot`/`diffSnapshot`/the render functions below), so an import in
 * the other direction would close a cycle.
 */
function uniqueColumnKeys(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw, i) => {
    const base = raw === "" ? `col${i + 1}` : raw;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n + 1}`;
  });
}

function rowsTable(names: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "";
  const keys = uniqueColumnKeys(names);
  const records = rows.map((cells) => {
    const rec: Record<string, string> = {};
    keys.forEach((k, i) => {
      rec[k] = cells[i] ?? "";
    });
    return rec;
  });
  return textTable(records, keys);
}

const CHANGED_ROW_COLUMNS = ["key", "column", "old", "new"] as const;

/** One rendered row per field change, `key` being the matched key values joined by `/`. */
function changedRowsTable(changed: readonly ChangedRow[]): string {
  const rows: Record<string, string>[] = [];
  for (const row of changed) {
    const key = row.key.join("/");
    for (const c of row.changes) {
      rows.push({ key, column: c.column, old: c.old, new: c.new });
    }
  }
  return textTable(rows, [...CHANGED_ROW_COLUMNS]);
}

/** `{field} {op} {value}` — a readable rendering of one stored where-condition, not the compiled SQL. */
function renderWhereCondition(c: PreviewCondition): string {
  if (c.op === "is_null") return `${c.field} is_null`;
  if (Array.isArray(c.value)) return `${c.field} ${c.op} (${c.value.join(", ")})`;
  return `${c.field} ${c.op} ${String(c.value)}`;
}

/**
 * Renders a `snapshot` response. Never prints a business row — the rows are
 * stored, not shown; a note says so. Every omission (row clamp, "more rows
 * exist", TTL clamp, incomplete key) is stated in a note, matching
 * `renderPreview`'s (`src/tools/data-preview.ts`) convention of never
 * leaving an omission implicit.
 */
export function renderSnapshot(
  snapshot: StoredSnapshot,
  result: PreviewResult,
  opts: { maxRowsRequested: number; ttlClamped: boolean; ttlRequested: number; ttlCeiling: number; maxChars: number },
): BuiltResponse {
  const notes: string[] = [
    "Rows were stored for a later `diff`, not shown here — a snapshot response prints no business rows.",
  ];

  if (snapshot.selection.max_rows < opts.maxRowsRequested) {
    notes.push(
      `CLAMPED: max_rows:${opts.maxRowsRequested} exceeds this server's ${snapshot.selection.max_rows}-row ` +
        `ceiling (ABAP_DATA_PREVIEW_MAX_ROWS), so only ${snapshot.selection.max_rows} row(s) were requested ` +
        `from ${snapshot.selection.table}. The rows beyond that were NOT fetched and are NOT stored. The ` +
        "ceiling is an operator setting — no argument raises it.",
    );
  }

  if (result.moreRowsExist) {
    notes.push(
      `INCOMPLETE: ${snapshot.selection.table} holds more rows than the ${snapshot.rows.length} stored. ` +
        "This snapshot covers only the first N rows in the table's own order, NOT a sample and NOT the whole " +
        "table — a later `diff` against this snapshot cannot see inserts or deletes beyond that ceiling and " +
        "will not invent them.",
    );
  }

  if (opts.ttlClamped) {
    notes.push(
      `TTL CLAMPED: ttl_hours:${opts.ttlRequested} exceeds this server's ${opts.ttlCeiling}-hour ceiling ` +
        `(ABAP_DATA_SNAPSHOT_TTL_HOURS), so this snapshot expires at ${snapshot.expiresAt} instead. The ` +
        "ceiling is an operator setting — no argument raises it.",
    );
  }

  if (!snapshot.keyComplete) {
    notes.push(
      "INCOMPLETE KEY: " +
        (snapshot.keyColumns.length > 0
          ? `${snapshot.selection.table}'s DDIC key was not fully covered by what was read (columns: ` +
            `${snapshot.keyColumns.join(", ")}).`
          : `${snapshot.selection.table} reported no key column at all.`) +
        " A later `diff` will match on every selected column instead, so an edited row will surface as one " +
        "deleted row plus one inserted row, not as a change.",
    );
  }

  const filter = snapshot.selection.filter;
  const selectionLines: string[] = [`table: ${snapshot.selection.table}`, `max_rows: ${snapshot.selection.max_rows}`];
  if (filter?.columns?.length) selectionLines.push(`columns: ${filter.columns.join(", ")}`);
  if (filter?.where?.length) {
    selectionLines.push(`where: ${filter.where.map(renderWhereCondition).join(" AND ")}`);
  }
  if (filter?.orderBy?.length) {
    selectionLines.push(`order_by: ${filter.orderBy.map((o) => `${o.field} ${o.direction ?? "asc"}`).join(", ")}`);
  }
  if (filter?.distinct) selectionLines.push("distinct: true");

  return buildResponse({
    header: {
      snapshot_id: snapshot.id,
      table: snapshot.selection.table,
      columns: snapshot.columns.length,
      rows_stored: snapshot.rows.length,
      rows_requested: opts.maxRowsRequested,
      more_rows_exist: result.moreRowsExist,
      expires_at: snapshot.expiresAt,
      ttl_hours: snapshot.ttlHours,
    },
    sections: [
      { title: "SELECTION", content: selectionLines.join("\n") },
      {
        title: "KEY",
        content: snapshot.keyComplete
          ? `key columns (complete): ${snapshot.keyColumns.join(", ")}`
          : snapshot.keyColumns.length > 0
            ? `key columns (incomplete): ${snapshot.keyColumns.join(", ")}`
            : "no key columns reported",
      },
    ],
    notes,
    maxChars: opts.maxChars,
  });
}

/** Renders a `diff` response: inserted/deleted rows plus field-level changes, and every note a caller needs to read the counts correctly. */
export function renderDiff(out: Awaited<ReturnType<typeof diffSnapshot>>, maxChars: number): BuiltResponse {
  const { before, after, diff } = out;

  const notes: string[] = [];

  if (!diff.matchedOnFullKey) {
    notes.push(
      "MATCHED ON SELECTED COLUMNS, NOT A KEY: the snapshot did not have a complete DDIC key, so rows were " +
        "matched on every selected column instead. An edited row therefore shows up as one DELETED row plus " +
        "one INSERTED row rather than a CHANGED row — a structural limit of matching on full-row identity, " +
        "not a failure.",
    );
  }
  if (out.moreRowsExistBefore || out.moreRowsExistAfter) {
    notes.push(
      "Both reads stopped at the same row ceiling, so rows past it were never compared on either side and " +
        "are not reported here as inserted or deleted.",
    );
  }
  if (diff.columnsAddedInAfter.length > 0) {
    notes.push(
      `COLUMNS ADDED: ${diff.columnsAddedInAfter.join(", ")} are present in the new read but were not in the ` +
        "snapshot, so every matched row shows them as a change — there is no snapshot-side value to compare " +
        "against.",
    );
  }
  if (diff.columnsRemovedInAfter.length > 0) {
    notes.push(
      `COLUMNS REMOVED: ${diff.columnsRemovedInAfter.join(", ")} were in the snapshot but are no longer in ` +
        "the new read, so every matched row shows them as a change — there is no new-side value to compare " +
        "against.",
    );
  }
  if (diff.inserted.length === 0 && diff.deleted.length === 0 && diff.changed.length === 0) {
    notes.push(
      'No difference was found within the compared window — a real "nothing changed" for the rows that ' +
        "were compared. It says nothing about rows beyond the ceiling, if the note above applies.",
    );
  }

  return buildResponse({
    header: {
      snapshot_id: before.id,
      table: before.selection.table,
      taken_at: before.createdAt,
      inserted: diff.inserted.length,
      deleted: diff.deleted.length,
      changed: diff.changed.length,
      matched_on_full_key: diff.matchedOnFullKey,
    },
    sections: [
      { title: "MATCHED ON", content: diff.matchedOn.join(", ") },
      { title: "INSERTED", content: rowsTable(after.columns.map((c) => c.name), diff.inserted) },
      { title: "DELETED", content: rowsTable(before.columns.map((c) => c.name), diff.deleted) },
      { title: "CHANGED", content: changedRowsTable(diff.changed) },
    ],
    notes,
    maxChars,
  });
}

/**
 * The `DATA CHANGES` section body another change appends to
 * `abap_run`/`abap_test`/`abap_bopf_test`/`abap_ui` output when the caller
 * passed `snapshot_ids`. Never throws — the run result already stands by the
 * time this renders; a diff that could not be produced is reported as a
 * `{refused}` line, not an exception.
 */
export function renderDataChangesSection(
  results: readonly { id: string; outcome: Awaited<ReturnType<typeof diffSnapshot>> | { refused: string } }[],
): string {
  const blocks: string[] = [];
  for (const r of results) {
    if ("refused" in r.outcome) {
      blocks.push(`snapshot ${r.id}: refused — ${r.outcome.refused}`);
      continue;
    }
    const out = r.outcome;
    const line =
      `snapshot ${r.id} on ${out.before.selection.table}: ` +
      `+${out.diff.inserted.length} -${out.diff.deleted.length} ~${out.diff.changed.length}`;
    const table = changedRowsTable(out.diff.changed);
    blocks.push(table ? `${line}\n${table}` : line);
  }
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Audit
//
// Table name and counts only — never a column name, never a cell value,
// never a key value. Same shape as `auditLogRead` (`src/adt/bal-log.ts`):
// what was looked at and how much came back, nothing that came back.
// ---------------------------------------------------------------------------

export function auditSnapshot(snapshot: StoredSnapshot, log: (m: string) => void): void {
  log(
    `[abapsmith] audit: abap_data_preview mode=snapshot table=${snapshot.selection.table} ` +
      `rows=${snapshot.rows.length} snapshot_id=${snapshot.id}`,
  );
}

export function auditDiff(out: Awaited<ReturnType<typeof diffSnapshot>>, log: (m: string) => void): void {
  log(
    `[abapsmith] audit: abap_data_preview mode=diff table=${out.before.selection.table} ` +
      `inserted=${out.diff.inserted.length} deleted=${out.diff.deleted.length} changed=${out.diff.changed.length}`,
  );
}
