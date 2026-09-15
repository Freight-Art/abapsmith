/**
 * On-disk store for `abap_data_preview` data snapshots (issue #117's storage
 * layer): a snapshot is a copy of the rows a preview call actually returned,
 * kept around long enough for a later call to diff against.
 *
 * Snapshots hold business rows. They live under `ABAP_STATE_DIR` in
 * `snapshots/<system>/`, NOT in the journal directory, are never referenced
 * from `index.jsonl` or `blobs/`, and therefore cannot surface through
 * `abap_journal mode=show` or any future journal export. The journal was
 * designed to carry before-images of SOURCE; it was never designed to carry
 * table data, and this store deliberately does not borrow its directory.
 *
 * Files are written with `atomicWriteFileSync` (src/state-dir.ts) and
 * hardened to mode 0600, same as the journal's own on-disk records.
 * `writeSnapshot` and `listSnapshots` prune expired files first, under
 * `withFileLockSync`, the way `Journal.prune()` sweeps `index.jsonl` under
 * `withFileLock` — see src/journal.ts's `pruneLocked()`/`sweepBlobs()` for
 * the model this follows. `readSnapshot` deliberately prunes LAST: it
 * settles the requested snapshot's own fate (found / expired-and-deleted /
 * not found) first, then sweeps the rest of the directory — see its own
 * comment for why the order is load-bearing.
 *
 * DIRECTORY NAMING: the per-system directory is named by a SHA-256 hash
 * (first 32 hex chars) of `systemKey()`'s output (src/journal.ts), not the
 * raw key string. `systemKey()` joins percent-encoded SID/origin/client with
 * `|`, which is not a portable single path segment on every filesystem, and
 * treating it as one anyway would tie a directory name to encoding details
 * that have nothing to do with this store. The full, unhashed `systemKey` is
 * still stored INSIDE every snapshot file and re-checked on every read — the
 * hash is only ever a filesystem-safe address, never the authority for which
 * system a snapshot belongs to.
 */
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { AbapError, isAbapError } from "./adt/errors.js";
import type { PreviewFilter } from "./adt/datapreview-filter.js";
import {
  atomicWriteFileSync,
  hardenFileModeSync,
  isFileLockAcquisitionFailure,
  resolveLockWaitMs,
  resolveStateDir,
  withFileLockSync,
} from "./state-dir.js";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface SnapshotSelection {
  readonly table: string;
  /** The EFFECTIVE (already clamped) row count — never the caller's raw ask. */
  readonly max_rows: number;
  /**
   * The structured filter exactly as it was sent to `previewDdicEntity`, so
   * `diff` re-reads the same selection rather than an approximation of it.
   * Absent means the read was unfiltered and went through the plain `ddic`
   * endpoint — a stored display string could not be replayed that way.
   */
  readonly filter?: PreviewFilter;
}

export interface SnapshotColumn {
  readonly name: string;
  /** DDIC primary-key marker — mirrors `PreviewColumn.key` (src/adt/datapreview.ts). */
  readonly key: boolean;
}

export interface StoredSnapshot {
  readonly version: 1;
  readonly id: string;
  readonly systemKey: string;
  readonly createdAt: string; // ISO 8601
  readonly expiresAt: string; // ISO 8601
  readonly ttlHours: number;
  readonly selection: SnapshotSelection;
  readonly columns: readonly SnapshotColumn[];
  readonly rows: readonly (readonly string[])[];
  readonly moreRowsExist: boolean;
  /** DDIC key columns present in `columns`. */
  readonly keyColumns: readonly string[];
  /** Are ALL of the entity's key columns present in `columns`? */
  readonly keyComplete: boolean;
}

export interface SnapshotStoreOptions {
  /** Defaults to `resolveStateDir()`. */
  readonly stateDir?: string;
  /** Injectable clock, for tests. Defaults to `new Date()`. */
  readonly now?: Date;
}

// ---------------------------------------------------------------------------
// Ids and paths
// ---------------------------------------------------------------------------

/** `snap_` plus 16 random bytes of hex — 32 hex chars, matching {@link SNAPSHOT_ID_RE}. */
export function newSnapshotId(): string {
  return `snap_${randomBytes(16).toString("hex")}`;
}

const SNAPSHOT_ID_RE = /^snap_[0-9a-f]{32}$/;

/**
 * Ids are used to build a filesystem path with no escaping, so a
 * caller-supplied one is checked BEFORE it ever touches `path.join` — a
 * rejected id costs zero filesystem calls, the same discipline
 * `assertValidId()` (src/journal.ts) applies to journal entry ids.
 */
function assertValidSnapshotId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !SNAPSHOT_ID_RE.test(id)) {
    throw new AbapError(
      "BAD_INPUT",
      `Not a valid snapshot id: ${JSON.stringify(id)}`,
      { id },
      "Snapshot ids look like snap_ followed by 32 hex characters — exactly what newSnapshotId() returns.",
    );
  }
}

/** Root of every system's snapshot directory. */
export function snapshotsRoot(stateDir?: string): string {
  return path.join(stateDir ?? resolveStateDir(), "snapshots");
}

/** See the file header's DIRECTORY NAMING note for why this is a hash, not the raw key. */
function hashSystemKey(systemKey: string): string {
  return createHash("sha256").update(systemKey, "utf8").digest("hex").slice(0, 32);
}

function systemDirFor(systemKey: string, stateDir?: string): string {
  return path.join(snapshotsRoot(stateDir), hashSystemKey(systemKey));
}

function snapshotFilePath(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

/** Matches only files this module could have written — see `pruneLocked()`/`listSnapshots()`. */
const SNAPSHOT_FILE_RE = /^(snap_[0-9a-f]{32})\.json$/;

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/**
 * Run `fn` under an exclusive cross-process lock on `dir`'s own lock file —
 * a SIBLING of the directory (`<dir>.lock`), not nested inside it, so
 * `readdirSync(dir)` in `pruneLocked()`/`listSnapshots()` never has to
 * recognise and skip it the way `sweepBlobs()` (src/journal.ts) has to skip
 * `index.jsonl.lock`. Mirrors `FileLockObjectGate.run()`
 * (src/adt/object-gate.ts): a failure to ACQUIRE the lock (detected via
 * `isFileLockAcquisitionFailure`) is already a well-formed `JOURNAL_IO`
 * naming the lock path and its holder, so it is rethrown unchanged rather
 * than translated into a code of its own — this store has no dedicated
 * lock-contention code, unlike `OBJECT_LOCKED_CROSS_PROCESS`, since snapshot
 * contention is expected to be rare and short-lived (one prune or one
 * write). Whatever `fn()` itself threw (an `AbapError` a caller should see
 * verbatim, e.g. `BAD_INPUT`) also propagates unchanged. Only a genuine,
 * un-coded filesystem failure inside `fn()` is wrapped into a fresh
 * `JOURNAL_IO`, mirroring `Journal.begin()`'s catch-all.
 */
function withSnapshotDirLock<T>(dir: string, fn: () => T): T {
  const lockPath = `${dir}.lock`;
  try {
    return withFileLockSync(lockPath, fn, { waitMs: resolveLockWaitMs() });
  } catch (e) {
    if (isFileLockAcquisitionFailure(e, lockPath)) throw e;
    if (isAbapError(e)) throw e;
    throw new AbapError(
      "JOURNAL_IO",
      `Could not access the snapshot store at ${dir}: ${(e as Error).message}.`,
      { dir, cause: (e as NodeJS.ErrnoException).code },
      "Check that ABAP_STATE_DIR is writable, or point ABAP_STATE_DIR at a directory you own.",
    );
  }
}

// ---------------------------------------------------------------------------
// Reading a snapshot file off disk
// ---------------------------------------------------------------------------

type ParsedSnapshotFile = { ok: true; snap: StoredSnapshot } | { ok: false };

/**
 * Minimal structural check, in the same spirit as `isEntry()`
 * (src/journal.ts): enough to keep a malformed or foreign file from being
 * handed to a caller as a `StoredSnapshot`, not a full schema validator.
 */
function isStoredSnapshotShape(v: unknown): v is StoredSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Partial<StoredSnapshot>;
  return (
    r.version === 1 &&
    typeof r.id === "string" &&
    typeof r.systemKey === "string" &&
    typeof r.createdAt === "string" &&
    typeof r.expiresAt === "string" &&
    typeof r.ttlHours === "number" &&
    typeof r.selection === "object" &&
    r.selection !== null &&
    Array.isArray(r.columns) &&
    Array.isArray(r.rows) &&
    typeof r.moreRowsExist === "boolean" &&
    Array.isArray(r.keyColumns) &&
    typeof r.keyComplete === "boolean"
  );
}

/**
 * `{ ok: false }` covers every "treat as absent" case in one place: no file
 * (ENOENT), a file that isn't valid JSON, and JSON that doesn't have the
 * shape of a `version: 1` snapshot. A real filesystem error (permissions,
 * I/O) is NOT swallowed here — it propagates so the caller's lock wrapper
 * (or the caller itself, for `readSnapshot`'s unlocked read) can report it
 * as what it is, rather than being misreported as "no such snapshot".
 */
function parseSnapshotFile(filePath: string): ParsedSnapshotFile {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: false };
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false }; // corrupt — treated as absent, per the module contract
  }
  if (!isStoredSnapshotShape(parsed)) return { ok: false };
  return { ok: true, snap: parsed };
}

/**
 * An unparseable `expiresAt` is treated as ALREADY expired, not as "never
 * expires" — the store must never accidentally grant an unbounded lifetime
 * to a record it cannot actually read a date out of.
 */
function isExpiredAt(snap: StoredSnapshot, now: Date): boolean {
  const t = Date.parse(snap.expiresAt);
  return !Number.isFinite(t) || t <= now.getTime();
}

// ---------------------------------------------------------------------------
// Prune
// ---------------------------------------------------------------------------

function pruneLocked(dir: string, now: Date): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
  let removed = 0;
  for (const name of entries) {
    // Anything not shaped like one of our own filenames (the lock file, or
    // foreign content someone dropped in this directory) is never touched —
    // same "positively identified before it's deleted" discipline as
    // `sweepBlobs()` (src/journal.ts).
    if (!SNAPSHOT_FILE_RE.test(name)) continue;
    const filePath = path.join(dir, name);
    const parsed = parseSnapshotFile(filePath);
    if (!parsed.ok || isExpiredAt(parsed.snap, now)) {
      try {
        unlinkSync(filePath);
        removed += 1;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
  }
  return removed;
}

/** How many files this call deleted (corrupt, wrong version, or expired). */
export function pruneSnapshots(systemKey: string, opts: SnapshotStoreOptions = {}): number {
  const dir = systemDirFor(systemKey, opts.stateDir);
  const now = opts.now ?? new Date();
  return withSnapshotDirLock(dir, () => pruneLocked(dir, now));
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function writeSnapshot(snap: StoredSnapshot, opts: SnapshotStoreOptions = {}): void {
  assertValidSnapshotId(snap.id);
  // Prune first — a directory that has accumulated expired snapshots should
  // not keep growing just because nothing ever reads from it.
  pruneSnapshots(snap.systemKey, opts);

  const dir = systemDirFor(snap.systemKey, opts.stateDir);
  withSnapshotDirLock(dir, () => {
    const filePath = snapshotFilePath(dir, snap.id);
    atomicWriteFileSync(filePath, JSON.stringify(snap));
    // Belt-and-braces: `atomicWriteFileSync`'s rename already leaves the file
    // at 0600 (see its own doc comment), but a snapshot is exactly the kind
    // of file this codebase already treats as sensitive enough to state the
    // mode explicitly rather than rely on that being read correctly.
    hardenFileModeSync(filePath);
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function readSnapshot(id: string, systemKey: string, opts: SnapshotStoreOptions = {}): StoredSnapshot {
  assertValidSnapshotId(id);

  const dir = systemDirFor(systemKey, opts.stateDir);
  const filePath = snapshotFilePath(dir, id);
  const now = opts.now ?? new Date();

  // Decide the REQUESTED snapshot's own fate before the housekeeping sweep
  // (below) ever touches this directory. This order is load-bearing: prune
  // shares `opts.now` with the expiry check just below, so pruning first
  // would delete an already-expired file out from under this read before
  // `parseSnapshotFile` ever looked at it — making it see ENOENT and throw
  // NOT_FOUND, and making SNAPSHOT_EXPIRED unreachable from this function.
  // That collapses two different facts ("this snapshot existed and aged
  // out" vs. "no such snapshot ever existed") into one, and the caller's
  // correct next action differs (take a fresh snapshot vs. check the id).
  // Do not "tidy" this back into prune-then-read.
  const parsed = parseSnapshotFile(filePath);
  if (!parsed.ok) throw snapshotNotFound(id);
  if (parsed.snap.systemKey !== systemKey) {
    // A snapshot taken on one system is not findable from another. The
    // message names only the id the caller asked for — never the other
    // system's key, which would leak which system actually holds a snapshot
    // under this id.
    throw snapshotNotFound(id);
  }
  if (isExpiredAt(parsed.snap, now)) {
    // Delete under lock, then refuse — never return an expired snapshot and
    // never let it collapse into a silently empty diff.
    withSnapshotDirLock(dir, () => {
      try {
        unlinkSync(filePath);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    });
    throw snapshotExpired(parsed.snap);
  }

  // Only now, having settled the requested snapshot's own fate, run the
  // housekeeping sweep over the rest of the directory.
  pruneSnapshots(systemKey, opts);

  return parsed.snap;
}

export function listSnapshots(systemKey: string, opts: SnapshotStoreOptions = {}): readonly StoredSnapshot[] {
  pruneSnapshots(systemKey, opts);
  const dir = systemDirFor(systemKey, opts.stateDir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: StoredSnapshot[] = [];
  for (const name of entries) {
    if (!SNAPSHOT_FILE_RE.test(name)) continue;
    const parsed = parseSnapshotFile(path.join(dir, name));
    // Pruning above already dropped anything expired/corrupt; this check is
    // belt-and-braces against a file that changed between the prune and this
    // read, and against the (should-never-happen) case of a foreign
    // snapshot's hash colliding into this directory.
    if (parsed.ok && parsed.snap.systemKey === systemKey) out.push(parsed.snap);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function snapshotNotFound(id: string): AbapError {
  return new AbapError(
    "NOT_FOUND",
    `No stored data snapshot ${id}.`,
    { id },
    "The snapshot id is wrong, or was never taken against this connection — snapshots are " +
      "scoped to one system and are never visible from another.",
  );
}

function snapshotExpired(snap: StoredSnapshot): AbapError {
  return new AbapError(
    "SNAPSHOT_EXPIRED",
    `Snapshot ${snap.id} was taken at ${snap.createdAt} and expired at ${snap.expiresAt} ` +
      `(TTL ${snap.ttlHours}h); it has been deleted.`,
    { id: snap.id, createdAt: snap.createdAt, expiresAt: snap.expiresAt, ttlHours: snap.ttlHours },
    "Take a fresh snapshot and diff against that instead — a deleted snapshot cannot be recovered.",
  );
}

// ---------------------------------------------------------------------------
// Pure diff
// ---------------------------------------------------------------------------

export interface FieldChange {
  readonly column: string;
  readonly old: string;
  readonly new: string;
}

export interface ChangedRow {
  readonly key: readonly string[];
  readonly changes: readonly FieldChange[];
}

export interface SnapshotDiff {
  readonly inserted: readonly (readonly string[])[];
  readonly deleted: readonly (readonly string[])[];
  readonly changed: readonly ChangedRow[];
  /** The columns rows were matched on. */
  readonly matchedOn: readonly string[];
  /** `false` when the snapshot lacks the full DDIC key and `matchedOn` fell back to every selected column. */
  readonly matchedOnFullKey: boolean;
  /** Column names present in `after` but not in `before`. */
  readonly columnsAddedInAfter: readonly string[];
  /** Column names present in `before` but not in `after`. */
  readonly columnsRemovedInAfter: readonly string[];
}

function indexByName(columns: readonly SnapshotColumn[]): Map<string, number> {
  const index = new Map<string, number>();
  columns.forEach((c, i) => index.set(c.name, i));
  return index;
}

function groupByKey<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

function isFullColumnSet(matchOn: readonly string[], names: ReadonlySet<string>): boolean {
  return matchOn.length === names.size && matchOn.every((c) => names.has(c));
}

/**
 * Diff two column-major-turned-row-major snapshots, matched on `matchOn`.
 *
 * MULTISET MATCHING: duplicate match keys are matched by COUNT, not by
 * presence. Grouping every row under its key and pairing occurrences
 * position-by-position (surplus on the `before` side is `deleted`, surplus
 * on the `after` side is `inserted`) means two rows sharing a key never
 * collapse into one comparison and never silently vanish — the alternative
 * (last-write-wins per key) would drop rows a caller has no way to know it
 * lost.
 *
 * WHEN `matchedOnFullKey` IS FALSE (the caller had no complete DDIC key and
 * fell back to matching on every selected column): two rows sharing that key
 * are identical in every matched column BY CONSTRUCTION, so this function
 * never reports such a pair as `changed` — an edited row no longer matches
 * its own old key, so a real edit always surfaces here as one `deleted` row
 * plus one `inserted` row instead. This is a structural limit of matching on
 * full-row identity, not a bug: there is no way to tell "row edited" apart
 * from "row deleted, different row inserted" without a key that survives the
 * edit, so this function reports the plain, honest fact — a pairing between
 * the two would be invented, not observed.
 *
 * COLUMN SETS: `before` and `after` may name different columns (order is
 * irrelevant; matching is by name). A column present on only one side is
 * reported as a change on every matched row it would appear on — there is no
 * counterpart value to compare, so "absent on this side" (rendered as `""`)
 * is itself the reported fact. `columnsAddedInAfter`/`columnsRemovedInAfter`
 * name the schema difference once, at the top level, rather than forcing a
 * caller to infer it by scanning every `changed` row for one particular
 * column name.
 */
export function diffSnapshotRows(
  before: { readonly columns: readonly SnapshotColumn[]; readonly rows: readonly (readonly string[])[] },
  after: { readonly columns: readonly SnapshotColumn[]; readonly rows: readonly (readonly string[])[] },
  matchOn: readonly string[],
): SnapshotDiff {
  const beforeIndex = indexByName(before.columns);
  const afterIndex = indexByName(after.columns);

  for (const col of matchOn) {
    if (!beforeIndex.has(col) || !afterIndex.has(col)) {
      throw new AbapError(
        "BAD_INPUT",
        `Cannot match snapshot rows on "${col}": it is not present in both snapshots being diffed.`,
        { column: col, matchOn },
        "matchOn must name columns present in BOTH the before and after snapshot.",
      );
    }
  }

  const beforeNames = new Set(before.columns.map((c) => c.name));
  const afterNames = new Set(after.columns.map((c) => c.name));
  const columnsAddedInAfter = [...afterNames].filter((n) => !beforeNames.has(n));
  const columnsRemovedInAfter = [...beforeNames].filter((n) => !afterNames.has(n));
  // Union of both sides' column names: before's own order first, then any
  // columns only `after` has. The order carries no meaning beyond being
  // deterministic.
  const allColumnNames = [...before.columns.map((c) => c.name), ...columnsAddedInAfter];

  // `matchedOnFullKey` is `false` exactly when `matchOn` IS the full column
  // set of either side — the "fell back to matching on everything" case
  // described in `StoredSnapshot.keyComplete`'s caller-side logic. Checked
  // against both sides (not just `before`) because a fallback match is, by
  // definition, matching on whatever was selected, and the two sides may not
  // share an identical selection.
  const matchedOnFullKey = !isFullColumnSet(matchOn, beforeNames) && !isFullColumnSet(matchOn, afterNames);

  const keyOf = (row: readonly string[], index: Map<string, number>): string =>
    JSON.stringify(matchOn.map((c) => row[index.get(c)!] ?? ""));

  const beforeGroups = groupByKey(before.rows, (r) => keyOf(r, beforeIndex));
  const afterGroups = groupByKey(after.rows, (r) => keyOf(r, afterIndex));

  const inserted: (readonly string[])[] = [];
  const deleted: (readonly string[])[] = [];
  const changed: ChangedRow[] = [];

  const allKeys = new Set([...beforeGroups.keys(), ...afterGroups.keys()]);
  for (const key of allKeys) {
    const bRows = beforeGroups.get(key) ?? [];
    const aRows = afterGroups.get(key) ?? [];
    const pairCount = Math.min(bRows.length, aRows.length);

    for (let i = 0; i < pairCount; i++) {
      const b = bRows[i]!;
      const a = aRows[i]!;
      const changes: FieldChange[] = [];
      for (const name of allColumnNames) {
        const bi = beforeIndex.get(name);
        const ai = afterIndex.get(name);
        const oldVal = bi === undefined ? "" : (b[bi] ?? "");
        const newVal = ai === undefined ? "" : (a[ai] ?? "");
        if (bi === undefined || ai === undefined || oldVal !== newVal) {
          changes.push({ column: name, old: oldVal, new: newVal });
        }
      }
      if (changes.length > 0) {
        changed.push({ key: JSON.parse(key) as string[], changes });
      }
    }
    for (let i = pairCount; i < bRows.length; i++) deleted.push(bRows[i]!);
    for (let i = pairCount; i < aRows.length; i++) inserted.push(aRows[i]!);
  }

  return {
    inserted,
    deleted,
    changed,
    matchedOn: [...matchOn],
    matchedOnFullKey,
    columnsAddedInAfter,
    columnsRemovedInAfter,
  };
}
