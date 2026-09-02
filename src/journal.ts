/**
 * Local write journal: the offline undo/audit trail (this tool has no git).
 *
 * Append-only JSONL index — `begin()` writes intent + before-image blob
 * before the mutation is attempted, `finish()` appends the outcome after. A
 * crash mid-write leaves a `pending` entry on disk with a readable
 * before-image; `list()`/`listPending()` surface it, and nothing here ever
 * auto-resolves a `pending` entry (see `settle()`).
 *
 * ADT does not hand back the bytes it was sent (CRLF→LF, trailing whitespace
 * and ALL trailing newlines stripped — see `canonicalSource()` in
 * src/compact.ts for the measurement record). So every image carries both an
 * `etag` (`contentHash()`, raw bytes, what `abap_read` hands out) and a
 * `fingerprint` (`sourceFingerprint()`, normalised, what `sourceEquals()` in
 * src/adt/write.ts compares) — drift detection uses the fingerprint, etag
 * continuity uses the etag.
 *
 * Before-image blobs are written raw UTF-8, byte-exact, never
 * trimmed/normalised — that is what undo restores, even though the hashes
 * beside them are normalised.
 *
 * `sourceFingerprint()` shares `canonicalSource()` (src/compact.ts) with
 * `sourceEquals()` so the journal and the write path cannot drift on what
 * counts as "same source" — see the git history for the
 * incident where they once did. test/journal.test.ts pins the equivalence
 * against the real `sourceEquals`.
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { AbapError } from "./adt/errors.js";
import { canonicalSource, contentHash } from "./compact.js";
import { withFileLock } from "./state-dir.js";

export type JournalOperation =
  | "create"
  | "update"
  | "delete"
  | "activate"
  | "transport-create"
  | "transport-add-user"
  | "transport-set-owner"
  | "transport-delete"
  | "transport-release";
export type JournalOutcome = "pending" | "succeeded" | "failed";

/**
 * Mirrors `EnhancedObjectRef` (src/adt/write.ts) field-for-field, restated
 * rather than imported so this module stays independent of `src/adt/` — same
 * rationale as `JournalObjectRefSource` below. Kept in sync by hand.
 */
export interface JournalEnhancedObjectRef {
  name: string;
  packageName: string;
  masterSystem?: string;
  spotName?: string;
}

export interface JournalObjectRef {
  name: string;
  type: string;
  uri: string;
  sourceUri?: string;
  package: string;
  description?: string;
  /**
   * Present iff this ref names an enhancement object (`ENHO/*`, `ENHS/*`)
   * that itself enhances some OTHER SAP object. Lets `undo`'s messages name
   * the object an enhancement write actually affects, not just the
   * enhancement object's own opaque generated name.
   */
  affects?: JournalEnhancedObjectRef;
}

/**
 * What a `JournalObjectRef` is projected FROM: the ADT layer's field names
 * (`packageName`), vs the on-disk record's (`package`). Structural on
 * purpose, so `journalRef()` can be shared by both `ResolvedTarget`
 * (src/adt/write.ts) and undo's `plan.target` (src/adt/undo.ts) without this
 * module importing from `src/adt/`.
 */
export interface JournalObjectRefSource {
  name: string;
  type: string;
  uri: string;
  sourceUri?: string;
  packageName: string;
  description?: string;
}

/** Journal object-ref projection of a resolved write/undo target. */
export function journalRef(t: JournalObjectRefSource): JournalObjectRef {
  return {
    name: t.name,
    type: t.type,
    uri: t.uri,
    sourceUri: t.sourceUri,
    package: t.packageName,
    description: t.description,
  };
}

/** A recorded snapshot of a source text. */
export interface JournalImage {
  /** `contentHash()` of the exact bytes — same form abap_read hands out as its etag. */
  etag: string;
  /** Trailing-newline- and CRLF-insensitive hash. THE drift-detection key. */
  fingerprint: string;
  bytes: number;
  /** Blob filename relative to `<dir>/blobs/`. Absent when there is no text. */
  blob?: string;
  /** Etag the SERVER reported at read time, when we have one. */
  serverEtag?: string;
}

/**
 * One SAP object's before/after state within a multi-part journal entry.
 *
 * A single operation can legitimately touch more than one SAP object (e.g. a
 * throwaway helper class created and deleted alongside a BAdI implementation,
 * or an edit that also triggers activation of a second object).
 * `JournalEntry.parts` records the whole group as one undoable unit instead
 * of N separate entries an undo could restore only some of.
 *
 * Deliberately a plain struct, not a variant of `JournalImage`: an image is
 * "a snapshot of one source text", a part is "one object's before/after pair
 * plus its own existed/capture provenance".
 *
 * journal.ts stays object-type-agnostic here — nothing about a part's shape
 * says what KIND of relationship it has to the primary object; that
 * vocabulary belongs to whichever caller constructs the parts.
 */
export interface JournalImagePart {
  /** Which SAP object this part is about. */
  object: JournalObjectRef;
  /** Same meaning as `JournalEntry.existedBefore`, scoped to THIS object. */
  existedBefore: boolean;
  /** Same meaning as `JournalEntry.beforeCapture`, scoped to THIS object. */
  beforeCapture: BeforeImageCapture;
  /** Source immediately before the mutation. Absent iff !existedBefore. */
  before?: JournalImage;
  /** What we intended to leave behind. Absent for a delete. */
  after?: JournalImage;
}

/**
 * How `existedBefore` was established. `existedBefore:false` is only safe to
 * act on — i.e. to undo by DELETING the object — when it is "confirmed-absent".
 */
export type BeforeImageCapture =
  | "captured" // the previous source was read successfully
  | "confirmed-absent" // positively confirmed the object did not exist
  | "failed" // the read failed; existedBefore is a GUESS
  | "unknown"; // provenance not recorded (entry predates this field)

const CAPTURE_VALUES: ReadonlySet<string> = new Set<BeforeImageCapture>([
  "captured",
  "confirmed-absent",
  "failed",
  "unknown",
]);

/**
 * Total: any value not in `CAPTURE_VALUES` degrades to "unknown", the value
 * that authorises nothing. Undo branches on this to decide whether it may
 * DELETE, so a leaked `undefined` must never read as "not confirmed-absent"
 * by luck.
 */
function normaliseCapture(value: unknown): BeforeImageCapture {
  return typeof value === "string" && CAPTURE_VALUES.has(value)
    ? (value as BeforeImageCapture)
    : "unknown";
}

/**
 * Provenance of the transport request a `transport-create` entry is about:
 * whose decision it was that this request should exist. Only
 * `session-created` means abapsmith minted it on its own initiative during a
 * write the human thought was just a write — the kind of side effect a human
 * has to go release or delete afterwards. The other five values describe a
 * request that was already there.
 *
 * Mirrors `SessionTrSource` in src/adt/session-transport.ts, restated rather
 * than imported (same on-disk-independence rationale as
 * `JournalObjectRefSource` above). `test/session-transport-journal.test.ts`
 * holds a compile-time assertion that `SessionTrSource` stays assignable to
 * this, so the two cannot drift apart silently.
 */
export type JournalTrSource =
  | "session-created"
  | "session-cached"
  | "session-adopted"
  | "config-pin"
  | "server-pin"
  | "caller";

/**
 * Stable identity of the system a journal entry was recorded against.
 *
 * The SID alone is a caller-supplied label (from `ABAP_SID`, defaults
 * "UNKNOWN"), so two different boxes can present the same one. Host + client
 * + SID together is what actually identifies a system, recorded normalised
 * as one comparable string, each part percent-encoded before joining so the
 * "|" separator cannot occur inside a part.
 *
 * Normalisation: URL origin lowercased; SID uppercased; client trimmed. A URL
 * that does not parse degrades to its raw trimmed text rather than being
 * dropped — an unparsable URL is still evidence.
 */
export function systemKey(parts: { sid: string; url: string; client: string }): string {
  const raw = parts.url.trim();
  let origin: string;
  try {
    const u = new URL(raw);
    // `origin` is the literal string "null" for opaque schemes; protocol+host
    // is the stable pair underneath it.
    origin = (u.origin && u.origin !== "null" ? u.origin : `${u.protocol}//${u.host}`).toLowerCase();
  } catch {
    origin = raw.toLowerCase();
  }
  return [parts.sid.trim().toUpperCase(), origin, parts.client.trim()]
    .map(encodeURIComponent)
    .join("|");
}

export interface JournalEntry {
  id: string;
  ts: string;
  system: string;
  /**
   * `systemKey()` of the connection this was recorded against, when the
   * caller supplied one. Never defaulted: an absent key means "we do not
   * know which box this was", not a fabricated guess.
   */
  systemKey?: string;
  operation: JournalOperation;
  object: JournalObjectRef;
  /**
   * Did the object exist on the server before this operation? Decides
   * whether undo means "restore source" or "delete the object".
   */
  existedBefore: boolean;
  /**
   * HOW `existedBefore` was established. On its own `existedBefore` is
   * lossy — a before-read that timed out or 401'd also records `false` — so
   * this provenance is carried so undo can refuse rather than DELETE on the
   * strength of a failure.
   */
  beforeCapture: BeforeImageCapture;
  /** Server source immediately before the mutation. Absent iff !existedBefore. */
  before?: JournalImage;
  /** What we intended to leave behind. Absent for a delete. */
  after?: JournalImage;
  /**
   * Additional SAP objects touched by the SAME logical operation as
   * `object`/`before`/`after`, beyond the primary one (e.g. a throwaway
   * helper class, or a second object an edit also drove to activation).
   * `object`/`before`/`after` remain the primary object and are never
   * duplicated into `parts`. Absent (not `[]`) on every entry that only
   * touched one object — every entry recorded before this field existed and
   * the overwhelming majority since — so existing callers of
   * `begin()`/`finish()` and `src/adt/undo.ts` keep working unchanged.
   */
  parts?: JournalImagePart[];
  outcome: JournalOutcome;
  error?: string;
  activation?: { attempted: boolean; activated?: boolean; messages?: string };
  /** Set when this entry IS an undo of another entry. */
  undoOf?: string;
  /** Set when this entry HAS BEEN undone by a later entry (that entry's id). */
  undoneBy?: string;
  /** Which tool produced it, e.g. "abap_write" / "abap_journal undo". */
  tool?: string;
  /** WHO produced it — see `Journal.resolveActor()`. Absent, never a placeholder: an always-populated field with no real provenance is the defect this field exists to fix. */
  actor?: string;
  /**
   * WHICH conversation produced it — split out from `actor` because "who"
   * and "which conversation" are different questions (`actor` answers the
   * former). Set from `Journal.setClientSession()`, same lazy-timing reason
   * as `actor`: unknown at construction, known only after the MCP
   * `initialize` handshake (src/server.ts `oninitialized`). Absent, never a
   * placeholder, for entries written before a session id was ever set.
   */
  sessionId?: string;
  /**
   * Provenance of `sessionId`, so a reader can tell "this server run" from
   * "this client session" without knowing the deployment — see the doc
   * comment on `Journal.setClientSession()`. Absent iff `sessionId` is.
   *  - `"transport"`: the MCP transport supplied a session identity.
   *  - `"process"`: no transport session identity was available, so a value
   *    generated once for this server process was used instead.
   */
  sessionIdSource?: "transport" | "process";
  /**
   * The transport request this write was recorded in, when the object is
   * transportable. Set on ordinary object writes AND on `transport-*`
   * entries, where it names the request the entry is ABOUT. Lets undo reuse
   * the same request rather than stranding the restored source elsewhere,
   * and lets a caller check whether that transport was released before an
   * undo — see the partial-undo warning in src/adt/undo.ts.
   */
  corrNr?: string;
  /**
   * For `transport-create`: who decided the request should exist. See
   * {@link JournalTrSource}. Absent on entries not about the origin of a
   * transport request.
   */
  trSource?: JournalTrSource;
  /**
   * Marks an entry that can never be undone by ANY mechanism. Absent (not
   * `false`) for everything else. Five producers, each recording something
   * abapsmith positively refuses to reverse:
   *
   *  - `transport-release` (src/tools/transport.ts): ADT has no "un-release".
   *  - Activation entries (src/tools/activate.ts): `operation: "activate"`
   *    is refused by name — ADT has no deactivate operation either.
   *  - Enhancement create/update/delete (src/tools/enh.ts and its v2 twin,
   *    src/tools/v2/handlers/do/enhancements.ts): `undoBlocker()`
   *    (src/adt/undo.ts) refuses `ENHO/XH`, `ENHO/XHH` and `ENHS/XS`
   *    unconditionally.
   *  - BOPF writes (src/tools/bopf.ts): no BOPF-specific check in
   *    `undoBlocker()` either, so every BOPF entry falls through to its
   *    generic `irreversible` catch-all. `DEVC/K` package creates used to
   *    fall through the same catch-all — fixed by giving a package a real
   *    delete/undo path, so its create no longer sets this flag.
   *  - `abap_ui` press entries (src/tools/ui.ts): BDCDATA script runs have
   *    no undo path; falls through to the same generic catch-all as BOPF.
   *
   * The entry is still written — the before-image is worth having even when
   * undo is refused. Full rationale (including the phantom-object and
   * TADIR/E071-residue findings behind the enhancement refusal) is archived
   * in the git history. See also doc/JOURNAL/undo-and-recovery.md's "Undo
   * semantics" table.
   */
  irreversible?: boolean;
}

export interface JournalConfig {
  /** Absolute path to the journal root for ONE system. */
  dir: string;
  enabled: boolean;
  maxEntries: number;
  maxAgeDays: number;
  /** `ABAP_ACTOR`, trimmed. Wins over the MCP client identity — see `Journal.resolveActor()`. */
  actor?: string;
}

/**
 * One additional object to record as part of a multi-part `begin()`. Mirrors
 * the primary object's fields on `JournalBeginInput`, scoped to this object —
 * see `JournalEntry.parts`.
 */
export interface JournalBeginInputPart {
  object: JournalObjectRef;
  existedBefore: boolean;
  /** See `JournalBeginInput.beforeCapture`, scoped to THIS object. */
  beforeCapture?: BeforeImageCapture;
  beforeSource?: string;
  afterSource?: string;
  beforeServerEtag?: string;
}

export interface JournalBeginInput {
  operation: JournalOperation;
  object: JournalObjectRef;
  existedBefore: boolean;
  /**
   * How the caller established `existedBefore`. Only a caller that positively
   * confirmed absence may say "confirmed-absent" — only that value ever
   * authorises an undo-by-delete. Omitted, `begin()` derives a conservative
   * value (see its body).
   */
  beforeCapture?: BeforeImageCapture;
  beforeSource?: string;
  afterSource?: string;
  beforeServerEtag?: string;
  /** `systemKey()` of the live connection. Recorded verbatim; never defaulted. */
  systemKey?: string;
  undoOf?: string;
  tool?: string;
  /** See `JournalEntry.corrNr`. */
  corrNr?: string;
  /** See `JournalEntry.trSource`. */
  trSource?: JournalTrSource;
  /** See `JournalEntry.irreversible`. */
  irreversible?: boolean;
  /**
   * Additional objects touched by this same operation — see
   * `JournalEntry.parts`. Each element follows the same before/after-capture
   * rules as the top-level fields, scoped to its own object. Blobs share the
   * primary object's id and in-flight protection, so the whole group lands —
   * or fails to land — together.
   */
  parts?: JournalBeginInputPart[];
}

export interface JournalFinishPatch {
  outcome: JournalOutcome;
  error?: string;
  activation?: { attempted: boolean; activated?: boolean; messages?: string };
  /** Set when the server normalised what we sent (DDIC does) — replaces `after`. */
  afterSource?: string;
  /**
   * See `JournalEntry.corrNr`. Recorded here too because for an ordinary
   * object write the transport isn't known until the lock is taken — after
   * `begin()`'s before-image hook has already fired.
   */
  corrNr?: string;
  /**
   * Replacement after-images for `entry.parts`, keyed by index into that
   * array. Sparse — an absent index leaves that part's `after` untouched.
   * Ignored (not an error) for a stale index that no longer exists on the
   * entry.
   */
  partsAfterSource?: Record<number, string>;
}

/**
 * The outcome of `settle()`. `finish()` answers "here is the merged entry, or
 * undefined" and cannot distinguish "no such entry" from "the disk refused" —
 * both look like silence to the caller. This says which.
 */
export type SettleResult =
  | { settled: true; entry: JournalEntry }
  | {
      settled: false;
      reason: "disabled" | "unknown-entry" | "not-terminal" | "io-error";
      error?: string;
    };

export const DEFAULT_MAX_ENTRIES = 200;
export const DEFAULT_MAX_AGE_DAYS = 30;

/**
 * How old a `pending` entry has to be before it is called *stranded* rather
 * than *in flight*. `begin()` writes the entry BEFORE the mutation, so every
 * write is legitimately `pending` for the lock → PUT → unlock → activate
 * round trip (measured worst case: seconds) — five minutes is generous
 * headroom, short enough that a crashed write is called out in the very next
 * `mode=list`.
 *
 * Shared by `src/tools/journal.ts` (STRANDED classification in
 * `abap_journal mode=list`) and `src/bin/journal-reconcile.ts` (default
 * `--stale-after-ms` floor).
 */
export const STALE_PENDING_MS = 5 * 60_000;

const INDEX_FILE = "index.jsonl";
const BLOB_DIR = "blobs";
/**
 * On-disk mirror of the in-memory `inFlight` set. A SIBLING of `index.jsonl`
 * and `blobs/`, deliberately NOT nested under `blobs/.inflight`: `blobs/`
 * must hold only readable blob files — test/transport-tools.test.ts:2005-2014
 * reads every entry of `blobs/` as UTF-8 to prove no blob can carry a
 * credential, cookie or CSRF token, and a subdirectory there fails that test
 * with `EISDIR`. Cross-process bookkeeping lives beside the index instead,
 * exactly where `${indexPath}.lock` already does.
 */
const INFLIGHT_DIR = ".inflight";
/**
 * How old a marker file must be before it is even a CANDIDATE for reaping.
 * Not a correctness knob — slack against the gap between a process forking
 * and its marker being written, and against pid reuse. A marker only stops
 * protecting when it is both this old AND its recorded pid is provably not
 * running (see {@link pidIsAlive}). Being too protective costs one extra
 * sweep; being not protective enough destroys a before-image somebody is
 * about to restore.
 */
const INFLIGHT_GRACE_MS = 15 * 60_000;
/** Only prune every so often — `begin()` is on the write path. */
const PRUNE_SLACK = 1.25;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OFF_VALUES = new Set(["off", "false", "0", "no", "none", "disabled"]);

function intFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/** `$TMP` and friends are legal SIDs-in-name-only; keep them off the filesystem. */
function safeSegment(sid: string): string {
  const cleaned = sid.trim().replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned.length ? cleaned.toUpperCase() : "UNKNOWN";
}

/**
 * Journal config from the environment.
 *
 *   ABAP_JOURNAL=off|false|0     → disabled (anything else, including unset,
 *                                  leaves it ON — the safety net is the default)
 *   ABAP_JOURNAL_DIR             → root, default `<cwd>/.abapsmith/journal`
 *   ABAP_JOURNAL_MAX_ENTRIES     → default 200
 *   ABAP_JOURNAL_MAX_AGE_DAYS    → default 30
 *   ABAP_ACTOR                   → who to record as `actor` on each new entry
 *
 * The returned `dir` is `<root>/<SID>` so two systems never share a journal —
 * restoring a before-image into the wrong system is the one mistake the journal
 * must never enable.
 */
export function journalConfigFromEnv(
  env: NodeJS.ProcessEnv,
  sid: string,
  cwd?: string,
): JournalConfig {
  const flag = env.ABAP_JOURNAL?.trim().toLowerCase();
  const enabled = !(flag !== undefined && OFF_VALUES.has(flag));

  const base = cwd ?? process.cwd();
  const root = env.ABAP_JOURNAL_DIR?.trim()
    ? path.resolve(base, env.ABAP_JOURNAL_DIR.trim())
    : path.resolve(base, ".abapsmith", "journal");

  const actor = env.ABAP_ACTOR?.trim() || undefined;

  return {
    dir: path.join(root, safeSegment(sid)),
    enabled,
    maxEntries: intFromEnv(env.ABAP_JOURNAL_MAX_ENTRIES, DEFAULT_MAX_ENTRIES),
    maxAgeDays: intFromEnv(env.ABAP_JOURNAL_MAX_AGE_DAYS, DEFAULT_MAX_AGE_DAYS),
    ...(actor ? { actor } : {}),
  };
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * CRLF-, per-line-trailing-whitespace- and trailing-newline-insensitive hash
 * of a source text.
 *
 * MUST agree with `sourceEquals()` in src/adt/write.ts:
 *   sourceEquals(a, b) === (sourceFingerprint(a) === sourceFingerprint(b))
 * Both go through the same `canonicalSource()` (src/compact.ts) so they
 * cannot drift on the normalisation itself; test/journal.test.ts pins the
 * equivalence against the real `sourceEquals`. See `canonicalSource` in
 * src/compact.ts for the full measurement record (CRLF folding, the per-line
 * trim, the strip-all-trailing-newlines rule and its CLAS/PROG divergence).
 *
 * Do not strip only ONE trailing newline here — an earlier version did,
 * reasoned to be "safer", and that was backwards: the server strips ALL
 * trailing newlines, so a strip-one fingerprint disagreed with the write path
 * and recorded phantom journal entries for unchanged sources. See
 * the git history for the incident.
 */
export function sourceFingerprint(source: string): string {
  return contentHash(canonicalSource(source));
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * Ids must sort lexicographically by time (`list()` is newest-first by id),
 * so the clock is forced strictly monotonic per process; the 6 random hex
 * chars only guard against collisions between processes sharing a directory.
 */
let lastMs = 0;

function compactTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
}

function newId(): string {
  const ms = Math.max(Date.now(), lastMs + 1);
  lastMs = ms;
  return `${compactTimestamp(ms)}-${randomBytes(3).toString("hex")}`;
}

/**
 * The exact shape `newId()` mints: `20260731T134500123Z-a1b2c3`. Stricter
 * than `assertValidId()`, which only refuses ids that could escape
 * `<dir>/blobs/`. Used to decide whether a file in the blob directory is a
 * journal blob at all — `sweepBlobs()` deletes things, so there an
 * unrecognised name must survive.
 */
const JOURNAL_ID_RE = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/;

function looksLikeJournalId(stem: string): boolean {
  return JOURNAL_ID_RE.test(stem);
}

/**
 * Ids end up in blob filenames, so anything that could escape `<dir>/blobs/` is
 * rejected outright rather than sanitised — a silently rewritten id would read
 * back as "entry not found".
 */
function assertValidId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.trim() === "" || /[/\\]/.test(id) || id.includes("..")) {
    throw new AbapError(
      "BAD_INPUT",
      `Not a valid journal entry id: ${JSON.stringify(id)}`,
      { id },
      "Ids look like 20260731T134500123Z-a1b2c3; list the journal to get one.",
    );
  }
}

// ---------------------------------------------------------------------------
// In-flight registry
// ---------------------------------------------------------------------------

/**
 * A marker file's name: `<journal id>.<pid>`. Ids never contain a `.` (see
 * `JOURNAL_ID_RE`), so the LAST dot is unambiguously the separator, and
 * requiring the tail to be all digits means a foreign file can't be mistaken
 * for a protective entry.
 */
const MARKER_RE = /^(.*)\.(\d+)$/;

/**
 * Is `pid` a process running on THIS host? Signal 0 performs the permission
 * and existence checks without delivering anything. Biased towards "alive":
 * only `ESRCH` proves absence; `EPERM` means the process exists but belongs
 * to another user, which is alive and not ours to declare dead. Mirrors
 * `ownerIsGone` in src/state-dir.ts, which makes the same call for the
 * lockfile's holder.
 *
 * Caveat: on a shared filesystem a marker's pid can belong to another
 * machine, where this test is meaningless — which is why a dead pid is never
 * sufficient on its own to reap a marker; {@link INFLIGHT_GRACE_MS} must also
 * have elapsed.
 */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

type Patch = { id: string } & Partial<JournalEntry>;

/** What one retention sweep dropped. File-local: `prune`/`pruneLocked` only. */
type PruneResult = { removedEntries: number; removedBlobs: number };

function isEntry(rec: Partial<JournalEntry>): rec is JournalEntry {
  return (
    typeof rec.id === "string" &&
    typeof rec.ts === "string" &&
    typeof rec.operation === "string" &&
    typeof rec.outcome === "string" &&
    typeof rec.object === "object" &&
    rec.object !== null
  );
}

export class Journal {
  readonly enabled: boolean;
  readonly dir: string;
  readonly config: Readonly<JournalConfig>;
  /**
   * Public so undo can check that the entry it is about to replay was
   * recorded against the system it is connected to. Read-only.
   */
  readonly system: string;

  private readonly indexPath: string;
  private readonly blobDir: string;
  /**
   * Cross-process lock guarding `index.jsonl` — see src/state-dir.ts. A
   * SIBLING of the index, deliberately NOT inside `blobs/`: `sweepBlobs()`
   * reads and deletes out of that directory, and a lock file appearing and
   * disappearing under another process's feet has no business being where
   * the sweep can see it. Per journal directory (per SID) — two SIDs have no
   * reason to wait on each other.
   */
  private readonly lockPath: string;
  /**
   * On-disk mirror of {@link inFlight} — see {@link INFLIGHT_DIR} for why it
   * is a sibling of the index rather than nested under `blobs/.inflight`.
   */
  private readonly inFlightDir: string;
  /**
   * Serialises index mutations within the process so two writers never
   * interleave — see `runExclusive()`.
   */
  private tail: Promise<unknown> = Promise.resolve();
  /**
   * Ids whose blobs are on disk but whose index line has not landed yet.
   * `begin()` writes blobs first BY DESIGN (the index must never point at a
   * blob that does not exist yet), so between the two `readAll()` cannot see
   * the id but its blobs are real — a concurrent `prune()`/`sweepBlobs()`
   * must be told to spare them, or the index line lands pointing at a deleted
   * blob and undo is silently left with nothing to restore.
   *
   * PROCESS-LOCAL. A four-process reproduction found the same bug one level
   * up — process A's sweep cannot see process B's set — hence
   * {@link inFlightDir}, which mirrors this set to disk. The mirror is
   * advisory (best-effort, may lag or leak); this set stays the authority for
   * our own ids and is consulted first in `sweepBlobs()`.
   */
  private readonly inFlight = new Set<string>();
  /** Lines currently in the index, once known. Drives the lazy prune. */
  private lineCount: number | undefined;
  /** MCP client identity, set post-construction — see `setClientActor()`. */
  private clientActor: string | undefined;
  /** This process/session's id, set post-construction — see `setClientSession()`. */
  private clientSessionId: string | undefined;
  /** Provenance of {@link clientSessionId}. Meaningful only alongside it. */
  private clientSessionSource: "transport" | "process" | undefined;

  constructor(cfg: JournalConfig, system: string) {
    this.config = Object.freeze({ ...cfg });
    this.enabled = cfg.enabled;
    this.dir = cfg.dir;
    // A caller-supplied label, nothing more. `systemKey()` is the identity.
    this.system = system;
    this.indexPath = path.join(cfg.dir, INDEX_FILE);
    this.blobDir = path.join(cfg.dir, BLOB_DIR);
    this.lockPath = `${this.indexPath}.lock`;
    this.inFlightDir = path.join(this.dir, INFLIGHT_DIR);
  }

  /** Must be lazy, unlike `config.actor`: the client identity is unknown until the transport's initialize handshake completes, which is after this `Journal` is constructed (src/server.ts). */
  setClientActor(name: string | undefined): void {
    this.clientActor = name?.trim() || undefined;
  }

  /** `ABAP_ACTOR` (`config.actor`) wins over the MCP client identity. */
  private resolveActor(): string | undefined {
    return this.config.actor ?? this.clientActor;
  }

  /**
   * Set the id this server run/session writes onto every entry from here on
   * — see `JournalEntry.sessionId`/`sessionIdSource`. Same lazy-timing
   * reason as `setClientActor()`: called once, from `oninitialized`
   * (src/server.ts), after this `Journal` is constructed.
   */
  setClientSession(id: string | undefined, source: "transport" | "process"): void {
    this.clientSessionId = id?.trim() || undefined;
    this.clientSessionSource = this.clientSessionId ? source : undefined;
  }

  /**
   * The session id that would be spliced onto the NEXT entry, or `undefined`
   * if none has been set yet. Exposed for `abap_journal mode=list
   * session=current` (src/tools/journal.ts) to resolve "this conversation"
   * without duplicating `setClientSession()`'s storage.
   */
  get sessionId(): string | undefined {
    return this.clientSessionId;
  }

  // -- reading ------------------------------------------------------------

  /**
   * Read the append-only index and merge it shallowly by id, in file order.
   * A malformed line — the realistic shape of a crash mid-append is a truncated
   * *last* line — is skipped, never fatal: the rest of the journal is exactly
   * the evidence someone is looking for after that crash.
   */
  private async readAll(): Promise<Map<string, JournalEntry>> {
    let text: string;
    try {
      text = await fs.readFile(this.indexPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw e;
    }

    const merged = new Map<string, Partial<JournalEntry>>();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue; // truncated / garbage line — skip, keep loading
      }
      if (typeof rec !== "object" || rec === null) continue;
      const patch = rec as Patch;
      if (typeof patch.id !== "string" || patch.id === "") continue;
      merged.set(patch.id, { ...(merged.get(patch.id) ?? {}), ...patch });
    }

    // Drop orphan patches: a patch whose `begin` line was pruned away is not
    // an entry. This is also the ONE place provenance is normalised, so no
    // caller anywhere has to guess what `beforeCapture === undefined` means
    // on the branch that decides whether undo may DELETE.
    const out = new Map<string, JournalEntry>();
    for (const [id, rec] of merged) {
      if (!isEntry(rec)) continue;
      out.set(id, { ...rec, beforeCapture: normaliseCapture(rec.beforeCapture) });
    }
    return out;
  }

  private static sortNewestFirst(entries: JournalEntry[]): JournalEntry[] {
    return entries.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  async get(id: string): Promise<JournalEntry | undefined> {
    if (!this.enabled) return undefined;
    assertValidId(id);
    return (await this.readAll()).get(id);
  }

  /**
   * Newest first. `object` filters on object name (case-insensitive, exact).
   * `sessionId` filters on `JournalEntry.sessionId` (exact — it's an opaque
   * id, not a human-typed name, so no case-folding).
   */
  async list(
    opts: { object?: string; limit?: number; operation?: JournalOperation; sessionId?: string } = {},
  ): Promise<JournalEntry[]> {
    if (!this.enabled) return [];
    const wanted = opts.object?.trim().toUpperCase();
    const wantedSession = opts.sessionId?.trim();
    let entries = [...(await this.readAll()).values()];
    if (wanted) entries = entries.filter((e) => (e.object?.name ?? "").toUpperCase() === wanted);
    if (opts.operation) entries = entries.filter((e) => e.operation === opts.operation);
    if (wantedSession) entries = entries.filter((e) => e.sessionId === wantedSession);
    entries = Journal.sortNewestFirst(entries);
    return opts.limit !== undefined && opts.limit >= 0 ? entries.slice(0, opts.limit) : entries;
  }

  private async readBlob(image: JournalImage | undefined): Promise<string | undefined> {
    if (!this.enabled || !image?.blob) return undefined;
    const file = path.join(this.blobDir, image.blob);
    // Defence in depth: a hand-edited index must not read outside the journal.
    if (path.dirname(path.resolve(file)) !== path.resolve(this.blobDir)) return undefined;
    try {
      return await fs.readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  /** The recorded before-image source text, or undefined. */
  beforeImage(entry: JournalEntry): Promise<string | undefined> {
    return this.readBlob(entry.before);
  }

  afterImage(entry: JournalEntry): Promise<string | undefined> {
    return this.readBlob(entry.after);
  }

  // -- writing ------------------------------------------------------------

  /**
   * Both directories the write path needs, created idempotently.
   *
   * `blobs/` and `.inflight/` are siblings — see {@link INFLIGHT_DIR} — so
   * both `mkdir`s are load-bearing. Must NOT take the index lock: it is
   * called from `begin()` and `settleInner()` (outside any locked section)
   * AND from `pruneLocked()` (inside one), and the lock is not re-entrant.
   */
  private async ensureDirs(): Promise<void> {
    await fs.mkdir(this.blobDir, { recursive: true });
    await fs.mkdir(this.inFlightDir, { recursive: true });
  }

  /**
   * Run `fn` with exclusive access to the index file, queued behind every
   * other exclusive section.
   *
   * `append()` needs this so two lines never interleave. `prune()` needs it
   * for a sharper reason: it rewrites the file via tmp+rename, and an
   * `append()` landing in the OLD inode between prune's `readAll()` and its
   * `rename()` would be silently discarded.
   *
   * DEADLOCK: an exclusive section must NEVER await another one, because the
   * inner call queues behind the outer, which is waiting for it. `begin()`
   * calls both, but strictly in sequence: it awaits `append()` to completion,
   * leaving the section, before calling `maybePrune()` → `prune()`. A failed
   * section must not poison the queue, so the tail swallows.
   */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * `runExclusive()`'s cross-process other half — orders writers against the
   * other N-1 server processes sharing the directory, which an in-process
   * promise chain cannot see.
   *
   * ORDERING RULE, which every caller must obey: take this INSIDE
   * `runExclusive()`, never around it. `withFileLock` is not re-entrant; the
   * inverted order deadlocks against a queued `append()` that is itself
   * waiting on the file lock, ended only by the wait budget expiring into a
   * `JOURNAL_IO` throw.
   *
   * Not taken by `ensureDirs()` or `sweepBlobs()`: both are reached from
   * inside and outside the locked section, so neither may acquire on its own.
   */
  private withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.lockPath, fn);
  }

  /**
   * Where this process publishes "I am mid-`begin()` on `id`". The pid is
   * part of the NAME, not the contents: reaping needs it without opening the
   * file, and two processes racing on a colliding id still get one marker
   * each.
   */
  private markerPath(id: string): string {
    return path.join(this.inFlightDir, `${id}.${process.pid}`);
  }

  /**
   * Publish / retract an in-flight marker. Both are BEST-EFFORT and neither
   * may ever throw: the marker is a strict improvement over the status quo
   * (today the sweep sees nothing of other processes), and a safety
   * improvement that can fail a write is not an improvement — `begin()`
   * already refuses loudly on journal I/O for that exact reason.
   *
   * Uses `fs.open(…, "w")` rather than `fs.writeFile` deliberately:
   * test/journal.test.ts:670 replaces the module-level `promises.writeFile`
   * to park a specific blob write mid-`begin()`, and going through that mock
   * would be a needless dependency on its exact predicate — src/state-dir.ts's
   * lock write dodges the same spy for the same reason.
   */
  private async publishInFlight(id: string): Promise<void> {
    try {
      const handle = await fs.open(this.markerPath(id), "w");
      await handle.close();
    } catch {
      // See above: never fatal.
    }
  }

  private async retractInFlight(id: string): Promise<void> {
    try {
      await fs.unlink(this.markerPath(id));
    } catch {
      // Already gone, or never created because the publish failed. A leftover
      // marker is inert — it delays one orphan by one sweep and is then reaped.
    }
  }

  private append(record: Patch): Promise<void> {
    const line = JSON.stringify(record) + "\n";
    // Queue first, THEN take the file lock — see `withIndexLock()`.
    //
    // Appends do not need to exclude each other for atomicity: a realistic
    // index line (well under where atomicity starts to break down) lands
    // whole. The lock is here for one job — to exclude against a prune's
    // `rename()`, which would otherwise swallow this line along with the
    // inode it lands in. Measured and the shared-mode alternative considered
    // and rejected; see the git history.
    return this.runExclusive(() =>
      this.withIndexLock(async () => {
        await fs.appendFile(this.indexPath, line, "utf8");
        if (this.lineCount !== undefined) this.lineCount += 1;
      }),
    );
  }

  /**
   * `partIndex` names a blob belonging to `entry.parts[partIndex]` instead of
   * the primary `entry.before`/`entry.after` — see `JournalEntry.parts`. Only
   * changes the filename (`<id>.part<N>.before|after.txt` instead of
   * `<id>.before|after.txt`); `sweepBlobs()`'s pattern is kept in sync with
   * this shape.
   */
  private async writeImage(
    id: string,
    which: "before" | "after",
    source: string,
    serverEtag?: string,
    partIndex?: number,
  ): Promise<JournalImage> {
    const blob = partIndex === undefined ? `${id}.${which}.txt` : `${id}.part${partIndex}.${which}.txt`;
    // Byte-exact: this is what undo restores. No trim, no newline fixing.
    await fs.writeFile(path.join(this.blobDir, blob), source, "utf8");
    return {
      etag: contentHash(source),
      fingerprint: sourceFingerprint(source),
      bytes: Buffer.byteLength(source, "utf8"),
      blob,
      ...(serverEtag ? { serverEtag } : {}),
    };
  }

  /**
   * Record the intent + before-image BEFORE the mutation, and get it on disk
   * (blobs first, then the index line, so the index never points at a blob
   * that does not exist yet).
   *
   * A filesystem failure here is NOT swallowed: a journal that silently fails
   * to record is worse than no journal, because the caller believes it has
   * undo. Throws `JOURNAL_IO` stating plainly that the mutation was not
   * attempted — deliberately NOT `SAFETY_DENIED`, which would send whoever
   * hits a disk-full/permissions error reading allowlists for a problem that
   * has nothing to do with the ABAP system.
   *
   * Returns `undefined` when the journal is disabled — never a fabricated
   * entry. The old code handed back an entry with id `disabled-<ts>-<hex>`,
   * and every caller advertised an undo that could never work, surfacing only
   * later as "unknown journal entry".
   */
  async begin(input: JournalBeginInput): Promise<JournalEntry | undefined> {
    if (!this.enabled) return undefined; // nothing touches the disk at all

    const id = newId();
    const ts = new Date().toISOString();

    /**
     * Derive provenance CONSERVATIVELY when the caller did not state it:
     * never invent positive evidence.
     *  - existed + we have the bytes → "captured"
     *  - existed + no bytes          → "failed" (see the fabricated image
     *    below: we assert it existed but hold nothing to prove it)
     *  - !existed                    → "unknown", NOT "confirmed-absent" — the
     *    caller passed a bare `false`, not a claim to have checked. Only an
     *    explicit `beforeCapture: "confirmed-absent"` may authorise an
     *    undo-by-delete.
     */
    const beforeCapture: BeforeImageCapture =
      input.beforeCapture ??
      (input.existedBefore ? (input.beforeSource !== undefined ? "captured" : "failed") : "unknown");
    const actor = this.resolveActor();
    const sessionId = this.clientSessionId;
    const sessionIdSource = this.clientSessionSource;

    const entry: JournalEntry = {
      id,
      ts,
      system: this.system,
      ...(input.systemKey ? { systemKey: input.systemKey } : {}),
      operation: input.operation,
      object: input.object,
      existedBefore: input.existedBefore,
      beforeCapture,
      outcome: "pending",
      ...(input.undoOf ? { undoOf: input.undoOf } : {}),
      ...(input.tool ? { tool: input.tool } : {}),
      ...(actor ? { actor } : {}),
      ...(sessionId ? { sessionId, sessionIdSource } : {}),
      ...(input.corrNr ? { corrNr: input.corrNr } : {}),
      ...(input.trSource ? { trSource: input.trSource } : {}),
      ...(input.irreversible ? { irreversible: input.irreversible } : {}),
    };

    // Claim the id BEFORE the first byte hits the disk. From here until the
    // index line has landed, this id is invisible to `readAll()` but its blobs
    // are real, so `prune()`/`sweepBlobs()` must be told to spare them.
    this.inFlight.add(id);
    try {
      await this.ensureDirs();
      // Mirror that claim onto disk before the first blob exists, so no other
      // process can ever observe a blob of ours without also being able to
      // observe the marker that protects it. It has to come after
      // `ensureDirs()` — the marker needs its directory — and before the first
      // `writeImage()` below, which is the first byte another process can see.
      await this.publishInFlight(id);

      if (input.existedBefore) {
        entry.before =
          input.beforeSource !== undefined
            ? await this.writeImage(id, "before", input.beforeSource, input.beforeServerEtag)
            : // The object existed but we could not read source for it. Record
              // a blob-less image so "before is present iff it existed" holds.
              // FABRICATED — etag/fingerprint hash the empty string, not
              // anything the server sent — which is why the derivation above
              // marks this case "failed": undo must not restore this over a
              // real object.
              {
                etag: contentHash(""),
                fingerprint: sourceFingerprint(""),
                bytes: 0,
                ...(input.beforeServerEtag ? { serverEtag: input.beforeServerEtag } : {}),
              };
      }
      if (input.afterSource !== undefined) {
        entry.after = await this.writeImage(id, "after", input.afterSource);
      }

      if (input.parts && input.parts.length > 0) {
        const parts: JournalImagePart[] = [];
        for (let i = 0; i < input.parts.length; i++) {
          const p = input.parts[i]!;
          // Same conservative derivation as the primary object's — see above.
          const partCapture: BeforeImageCapture =
            p.beforeCapture ??
            (p.existedBefore ? (p.beforeSource !== undefined ? "captured" : "failed") : "unknown");
          const part: JournalImagePart = {
            object: p.object,
            existedBefore: p.existedBefore,
            beforeCapture: partCapture,
          };
          if (p.existedBefore) {
            part.before =
              p.beforeSource !== undefined
                ? await this.writeImage(id, "before", p.beforeSource, p.beforeServerEtag, i)
                : // Same fabricated-empty-image case as the primary object's — see above.
                  {
                    etag: contentHash(""),
                    fingerprint: sourceFingerprint(""),
                    bytes: 0,
                    ...(p.beforeServerEtag ? { serverEtag: p.beforeServerEtag } : {}),
                  };
          }
          if (p.afterSource !== undefined) {
            part.after = await this.writeImage(id, "after", p.afterSource, undefined, i);
          }
          parts.push(part);
        }
        entry.parts = parts;
      }

      await this.append(entry);
    } catch (e) {
      throw new AbapError(
        "JOURNAL_IO",
        `Could not write the local journal at ${this.dir}: ${(e as Error).message}. ` +
          `The ${input.operation} of ${input.object?.name ?? "(unknown)"} was NOT attempted.`,
        {
          dir: this.dir,
          operation: input.operation,
          object: input.object?.name,
          cause: (e as NodeJS.ErrnoException).code,
          note:
            "This is a LOCAL filesystem problem, not an ABAP authorisation or " +
            "safety-gate refusal. Nothing was sent to the ABAP system.",
        },
        "Fix the journal directory (permissions, disk space, ABAP_JOURNAL_DIR) or set " +
          "ABAP_JOURNAL=off to knowingly work without an undo trail.",
      );
    } finally {
      // Only once the append has SETTLED — success or failure. Released any
      // earlier and a prune could still slip between the blob and the line.
      // The on-disk mirror is retracted in the same breath and, like its
      // creation, cannot fail the write: a `finally` that throws would replace
      // the real journal error with a bookkeeping one.
      this.inFlight.delete(id);
      await this.retractInFlight(id);
    }

    // Deliberately outside the try, and outside the append's exclusive section:
    // `prune()` takes the same lock, so calling it from inside one would
    // deadlock. See `runExclusive()`.
    await this.maybePrune();
    return entry;
  }

  /**
   * Append the outcome of a previously-begun entry.
   *
   * By the time this runs the mutation has already happened, so a filesystem
   * failure here must never mask the real outcome: it is reported on stderr
   * and the merged entry is returned anyway. Throws only for a structurally
   * invalid id (`BAD_INPUT`), which is a caller bug.
   *
   * A thin lossy view of `settle()`: everything that is not an outright
   * success collapses back to `undefined`. New code should call `settle()`.
   */
  async finish(id: string, patch: JournalFinishPatch): Promise<JournalEntry | undefined> {
    // `merged` is returned even on io-error, preserving the long-standing
    // behaviour documented above: the mutation already happened, so handing
    // back a view that is right about the outcome and only wrong about what
    // reached the disk beats handing back nothing at all.
    return (await this.settleInner(id, patch)).merged;
  }

  /**
   * Total, non-silent version of finish(): resolves an entry to a DEFINITE
   * terminal outcome and tells the caller whether it actually landed.
   *
   * `finish()` returns `undefined` for an unknown id, for a disabled journal
   * and (in effect) for a write that failed, so a caller cannot tell "there
   * was never such an entry" from "the disk refused the patch". This is
   * caller-driven resolution, NOT auto-repair: it only ever writes the
   * outcome the caller asserts — see the header, and `listPending()`.
   */
  async settle(id: string, patch: JournalFinishPatch): Promise<SettleResult> {
    return (await this.settleInner(id, patch)).result;
  }

  /**
   * The shared body. Returns both the machine-readable result and the merged
   * view, because `finish()` and `settle()` disagree about what to do with the
   * io-error case and neither should be reimplemented in terms of the other's
   * lossy answer.
   */
  private async settleInner(
    id: string,
    patch: JournalFinishPatch,
  ): Promise<{ result: SettleResult; merged?: JournalEntry }> {
    if (!this.enabled) return { result: { settled: false, reason: "disabled" } };
    assertValidId(id); // a malformed id is a caller bug, not an outcome

    // "pending" is the state we are trying to leave, not a state to arrive at.
    // Writing it would append a line that changes nothing and report success,
    // which is the precise lie this method exists to stop telling.
    if (patch.outcome === "pending") {
      return { result: { settled: false, reason: "not-terminal" } };
    }

    const existing = (await this.readAll()).get(id);
    if (!existing) return { result: { settled: false, reason: "unknown-entry" } };

    const record: Patch = { id, outcome: patch.outcome };
    if (patch.error !== undefined) record.error = patch.error;
    if (patch.activation !== undefined) record.activation = patch.activation;
    if (patch.corrNr !== undefined) record.corrNr = patch.corrNr;

    try {
      if (patch.afterSource !== undefined) {
        await this.ensureDirs();
        record.after = await this.writeImage(id, "after", patch.afterSource);
      }
      if (patch.partsAfterSource) {
        await this.ensureDirs();
        // `parts` is one field, patched whole — like `after` above — so the
        // record must carry every existing part, not just the changed ones,
        // or the merge in `readAll()` would silently drop the untouched
        // ones' before-images.
        const parts = (existing.parts ?? []).map((p) => ({ ...p }));
        for (const [idxStr, source] of Object.entries(patch.partsAfterSource)) {
          const idx = Number(idxStr);
          if (!Number.isInteger(idx) || idx < 0 || idx >= parts.length) continue; // stale index: ignore, don't throw away the outcome
          parts[idx] = { ...parts[idx]!, after: await this.writeImage(id, "after", source, undefined, idx) };
        }
        record.parts = parts;
      }
      await this.append(record);
    } catch (e) {
      process.stderr.write(
        `[abapsmith] WARNING: journal finish for ${id} could not be written ` +
          `(${(e as Error).message}). The operation itself already completed with ` +
          `outcome=${patch.outcome}.\n`,
      );
      return {
        result: { settled: false, reason: "io-error", error: (e as Error).message },
        merged: { ...existing, ...record },
      };
    }

    const merged: JournalEntry = { ...existing, ...record };
    return { result: { settled: true, entry: merged }, merged };
  }

  /**
   * Entries still sitting at `outcome: "pending"`, newest first. Nothing
   * sweeps them, so unless something *lists* them they accumulate invisibly.
   *
   * `staleAfterMs` filters to entries at least that old. An entry whose `ts`
   * does not parse counts as STALE — hiding it behind an age filter would
   * bury the one entry most worth a human's attention. (`prune()` makes the
   * opposite call for the same input — there an unparsable ts means KEEP —
   * and both land on "the evidence stays visible".)
   */
  async listPending(opts: { staleAfterMs?: number } = {}): Promise<JournalEntry[]> {
    if (!this.enabled) return [];
    const pending = [...(await this.readAll()).values()].filter((e) => e.outcome === "pending");
    const stale = opts.staleAfterMs;
    const now = Date.now();
    const filtered =
      stale === undefined || stale <= 0
        ? pending
        : pending.filter((e) => {
            const t = Date.parse(e.ts);
            return Number.isFinite(t) ? now - t >= stale : true;
          });
    return Journal.sortNewestFirst(filtered);
  }

  /**
   * Record that `id` was undone by entry `undoneBy`. Best-effort for the same
   * reason as `finish()` — it runs after a real mutation — but an unknown id is
   * a caller bug and is reported as `BAD_INPUT`.
   */
  async markUndone(id: string, undoneBy: string): Promise<void> {
    if (!this.enabled) return;
    assertValidId(id);
    assertValidId(undoneBy);

    if (!(await this.readAll()).has(id)) {
      throw new AbapError("BAD_INPUT", `Unknown journal entry: ${id}`, { id });
    }
    try {
      await this.append({ id, undoneBy });
    } catch (e) {
      process.stderr.write(
        `[abapsmith] WARNING: could not record that ${id} was undone by ${undoneBy} ` +
          `(${(e as Error).message}). The undo itself already ran.\n`,
      );
    }
  }

  // -- retention ----------------------------------------------------------

  /** Prune only when the index has grown meaningfully past the cap. */
  private async maybePrune(): Promise<void> {
    const cap = this.config.maxEntries;
    if (cap <= 0) return;
    if (this.lineCount === undefined) {
      try {
        const text = await fs.readFile(this.indexPath, "utf8");
        this.lineCount = text.split("\n").filter((l) => l.trim() !== "").length;
      } catch {
        this.lineCount = 0;
      }
    }
    if (this.lineCount <= cap * PRUNE_SLACK) return;
    try {
      await this.prune();
    } catch (e) {
      // The entry is already safely on disk; a failed prune must not fail a write.
      process.stderr.write(`[abapsmith] WARNING: journal prune failed: ${(e as Error).message}\n`);
    }
  }

  /**
   * Apply the retention policy. Keeps entries newer than `maxAgeDays` AND
   * within the newest `maxEntries` — dropped if it fails either rule. Either
   * limit is disabled by setting it to 0.
   *
   * The index is rewritten atomically (`index.jsonl.tmp` + rename), the only
   * place in this module that does not append. The whole body runs under
   * `runExclusive()` AND the cross-process file lock (`withIndexLock()`):
   * "atomic rename" only protects a *reader*, not a concurrent `append()`
   * whose line lands in the inode about to be replaced. A four-process test
   * without the cross-process lock left 6 of 22 surviving index entries
   * pointing at a destroyed before-image.
   */
  async prune(): Promise<PruneResult> {
    // STRICTLY before any lock: a disabled journal must not touch the disk at
    // all, and `withFileLock` mkdirs the lock file's parent directory.
    // test/journal.test.ts:999 asserts the journal directory is never created.
    if (!this.enabled) return { removedEntries: 0, removedBlobs: 0 };
    // Queue first, file lock second, body third — never the other way round,
    // see `withIndexLock()`'s ordering rule. Wrapping HERE rather than inside
    // `pruneLocked()` also covers all three of its exits (empty-journal,
    // sweep-only, full rewrite) with one acquisition and one release.
    return this.runExclusive(() => this.withIndexLock(() => this.pruneLocked()));
  }

  private async pruneLocked(): Promise<PruneResult> {
    const all = await this.readAll();
    if (all.size === 0) return { removedEntries: 0, removedBlobs: 0 };

    const ordered = Journal.sortNewestFirst([...all.values()]); // newest first
    const cutoff =
      this.config.maxAgeDays > 0 ? Date.now() - this.config.maxAgeDays * 86_400_000 : undefined;

    const keep: JournalEntry[] = [];
    const drop: JournalEntry[] = [];
    for (const e of ordered) {
      const tooOld = (() => {
        if (cutoff === undefined) return false;
        const t = Date.parse(e.ts);
        return Number.isFinite(t) ? t < cutoff : false; // unparsable ts: keep the evidence
      })();
      const tooMany = this.config.maxEntries > 0 && keep.length >= this.config.maxEntries;
      // An in-flight id is never droppable: its `begin()` hasn't returned yet,
      // so dropping it here would delete the before-image of a mutation about
      // to be attempted. Reachable only in the sliver where the index line
      // has landed but `begin()` hasn't cleared the flag; cheap insurance.
      if ((tooOld || tooMany) && !this.inFlight.has(e.id)) drop.push(e);
      else keep.push(e);
    }

    if (drop.length === 0) {
      // Still worth sweeping orphan blobs from a crash, but nothing to rewrite.
      const removedBlobs = await this.sweepBlobs(new Set(keep.map((e) => e.id)));
      this.lineCount = keep.length;
      return { removedEntries: 0, removedBlobs };
    }

    // Oldest-first on disk, so the file stays chronological like an append log.
    const body = keep
      .slice()
      .reverse()
      .map((e) => JSON.stringify(e))
      .join("\n");
    // Unique per write, never a fixed `${indexPath}.tmp`: two concurrent
    // prunes writing that same path accounted for 3 of 6 failures in a
    // four-process reproduction — the file lock doesn't make a fixed name
    // safe either, since a prune killed between `writeFile` and `rename`
    // leaves the tmp behind for the next prune to inherit as its own scratch
    // file. Same recipe (pid + random suffix) as `atomicWriteFileSync` in
    // src/state-dir.ts.
    const tmp = `${this.indexPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await this.ensureDirs();
    await fs.writeFile(tmp, body.length ? body + "\n" : "", "utf8");
    await fs.rename(tmp, this.indexPath);
    // Assignment, not decrement: it stomps whatever `append()` counted. Safe
    // only because we hold the exclusive lock, so no append can have landed
    // since `readAll()` above — outside it this line silently lost writes.
    this.lineCount = keep.length;

    const removedBlobs = await this.sweepBlobs(new Set(keep.map((e) => e.id)));
    return { removedEntries: drop.length, removedBlobs };
  }

  /**
   * Delete blobs that no entry can still reach. Returns how many went.
   *
   * Deleting is irreversible and these files are the undo trail, so the
   * burden of proof runs one way: a file is removed only if it is positively
   * identified as a journal blob AND positively known to be unreachable —
   * ALL of:
   *
   *  - the name matches `<id>.before|after.txt` or a multi-part image's
   *    `<id>.part<N>.before|after.txt` (see `JournalEntry.parts`); either
   *    shape's stem is the entry id, which is all this function keys
   *    survival on;
   *  - the stem is a well-formed journal id (`looksLikeJournalId`) — the old
   *    code only checked the suffix and happily unlinked `notes.before.txt`
   *    sitting in the blob directory;
   *  - the id is not in `surviving`, not in `inFlight` (an in-flight entry
   *    has no index line yet, so it cannot be in `surviving`), and not
   *    REGISTERED in the on-disk in-flight registry — the cross-process
   *    extension of `inFlight`, without which process A's sweep could unlink
   *    process B's live before-image (a four-process run left 6 of 22
   *    surviving entries in exactly that state, silently swallowed by
   *    `readBlob()`'s ENOENT handling).
   *
   * Deliberately NOT a survival rule: the age of the BLOB. An mtime grace
   * window was proposed and rejected — a crash-orphaned blob is
   * indistinguishable on disk from one written a millisecond ago by a live
   * `begin()`; only knowing which writes are open can tell them apart, which
   * is what the in-flight rules do instead. test/journal.test.ts:573-588 pins
   * that an orphan blob written moments ago is swept on the very next prune.
   *
   * The registry directory itself is a sibling of the index (see
   * {@link INFLIGHT_DIR}), so this `readdir` never returns it.
   */
  private async sweepBlobs(surviving: Set<string>): Promise<number> {
    let files: string[];
    try {
      files = await fs.readdir(this.blobDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw e;
    }
    // Read (and reap) the registry ONCE, before the loop: a stat per marker per
    // blob would be quadratic, and re-reading it mid-loop would let two blobs of
    // the same entry be judged by different answers.
    const registered = await this.readInFlightRegistry();
    let removed = 0;
    for (const f of files) {
      // The `(?:part\d+\.)?` piece is what makes a multi-part image's
      // `<id>.part<N>.before|after.txt` reduce to the same stem as the
      // primary `<id>.before|after.txt` — see the doc comment above.
      const m = /^(.+)\.(?:part\d+\.)?(before|after)\.txt$/.exec(f);
      if (!m || !m[1]) continue; // wrong shape of name — not a journal blob
      const stem = m[1];
      if (!looksLikeJournalId(stem)) continue; // not an id we could ever have minted
      if (surviving.has(stem) || this.inFlight.has(stem) || registered.has(stem)) continue;
      try {
        await fs.unlink(path.join(this.blobDir, f));
        removed += 1;
      } catch {
        // Already gone, or not ours to delete. Never fatal.
      }
    }
    return removed;
  }

  /**
   * The ids some process is currently mid-`begin()` on, per the on-disk
   * registry — and, as a side effect, where markers that can no longer be
   * protecting anything are reaped (before the returned set is built, so a
   * reaped marker never gets one more free pass — without reaping at all, a
   * process killed between `publishInFlight()` and its `finally` would
   * protect a blob forever).
   *
   * A marker is reaped only when BOTH {@link INFLIGHT_GRACE_MS} has elapsed
   * AND {@link pidIsAlive} proves the pid dead — never one of our own,
   * whatever its age. Every uncertainty resolves towards protecting: a
   * marker we could not `stat` keeps its id alive, an over-protective entry
   * costs one delayed sweep, an under-protective one destroys a before-image.
   */
  private async readInFlightRegistry(): Promise<Set<string>> {
    let markers: string[];
    try {
      markers = await fs.readdir(this.inFlightDir);
    } catch (e) {
      // No registry directory yet — nothing is registered. Any other error is
      // a real filesystem problem and is the prune's to report.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Set<string>();
      throw e;
    }

    const registered = new Set<string>();
    const now = Date.now();
    for (const name of markers) {
      const m = MARKER_RE.exec(name);
      const id = m?.[1];
      const pid = m?.[2] !== undefined ? Number(m[2]) : Number.NaN;
      if (await this.reapMarker(name, pid, now)) continue;
      // An unparseable name that survived the reap protects nothing — there is
      // no id in it to protect — but it is left on disk rather than deleted
      // early, because we cannot prove it is ours to delete.
      if (id) registered.add(id);
    }
    return registered;
  }

  /** True when `name` no longer protects an id — see `readInFlightRegistry()`. */
  private async reapMarker(name: string, pid: number, now: number): Promise<boolean> {
    if (pid === process.pid) return false; // our own live write; never reapable
    const marker = path.join(this.inFlightDir, name);

    let age: number;
    try {
      age = now - (await fs.stat(marker)).mtimeMs;
    } catch {
      // Unreadable, or removed by its owner between the `readdir` and here.
      // Either way there is nothing to reap and no evidence to act on, so keep
      // protecting: over-protection costs one sweep, the other way costs data.
      return false;
    }
    if (age <= INFLIGHT_GRACE_MS) return false;

    // A pid that does not parse as a positive integer is not evidence of a live
    // process, so an old marker carrying one is reapable. `pidIsAlive()` is the
    // conservative half: only a proven-absent pid counts as dead.
    if (Number.isInteger(pid) && pid > 0 && pidIsAlive(pid)) return false;

    try {
      await fs.unlink(marker);
    } catch {
      // Best effort. A marker we failed to remove is retried next sweep.
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// The begin/settle choreography, once
// ---------------------------------------------------------------------------

/**
 * What a journalled mutation hands back: the mutator's own result, the id of
 * the entry that reached disk (`undefined` ⇔ no entry exists — see
 * `withJournalledMutation`), and the one way to give that entry a terminal
 * outcome.
 */
export interface JournalledMutation<T> {
  /** Whatever the wrapped mutator returned. */
  readonly result: T;
  /**
   * The id of the entry ON DISK, or `undefined` when the journal is off (or
   * absent). Not "we forgot the id" — `begin()` returns nothing at all for a
   * disabled journal, so `entryId !== undefined` is exactly the claim "this
   * mutation is undoable" that every user-facing message may make.
   */
  readonly entryId: string | undefined;
  /**
   * Append the outcome. A no-op — not an error — when there is no entry, so a
   * caller never has to re-ask "is the journal on?". Throws whatever
   * `Journal.finish` throws — `src/tools/write.ts`'s post-write block
   * deliberately swallows it into `details.journalError`.
   */
  settle(patch: JournalFinishPatch): Promise<void>;
}

/** How a journalled mutation records the mutator throwing. */
export type JournalledMutationOnError =
  /** Patch the entry to `failed` before rethrowing. */
  | "record-failed"
  /**
   * Rethrow with the entry left `pending`. For undo, where a `pending` entry
   * is the honest record: the undo write may or may not have landed, and
   * `listPending()`/`settle()` exist so a human resolves it deliberately
   * rather than have this layer assert an outcome it did not observe.
   */
  | "leave-pending";

export interface JournalledMutationSpec<Img> {
  /**
   * Build the `begin()` input from the before-image the mutator hands the
   * hook. Called at most once, from INSIDE the mutator's call chain.
   */
  begin: (image: Img) => JournalBeginInput;
  /** Defaults to `"record-failed"`. */
  onError?: JournalledMutationOnError;
}

/**
 * Run a mutation with its journal entry on disk before the mutating request —
 * this module's ordering rule — without every call site hand-rolling the
 * sequence.
 *
 * The entry must land BEFORE the create/lock/PUT, and the before-image it
 * carries must be built from the bytes the mutator actually read (post-lock
 * on the update path) — facts only the mutator knows, at a moment only the
 * mutator can name. So this does NOT wrap `begin() → mutate() → finish()`
 * around the call: it hands the mutator a hook, the mutator fires it at its
 * own ordering point, and `begin()` completes (blobs and index line on disk)
 * before the hook returns and the mutator proceeds. A hook that throws aborts
 * the mutation, unrecorded and therefore unperformed.
 *
 * What this owns is everything AROUND that: capturing the id, keeping "no
 * journal" and "no entry" the same single `undefined`, recording a failure
 * when the mutator throws, and offering one `settle()` that is a no-op when
 * there is nothing to settle. Before this existed, the same dance was
 * hand-rolled five times (three in `src/tools/write.ts`, two in
 * `src/adt/undo.ts`) with the mutators' `onBeforeImage` OPTIONAL, so a caller
 * that omitted it wrote to a customer's system with no before-image and no
 * undo trail, silently. The hook is required now (`NO_JOURNAL` in
 * src/adt/write.ts is the visible opt-out).
 *
 * `journal` is allowed to be `undefined` so a caller holding an optional
 * journal does not need its own `journal ? {...} : {}` spread.
 */
export async function withJournalledMutation<Img, T>(
  journal: Journal | undefined,
  spec: JournalledMutationSpec<Img>,
  run: (onBeforeImage: (image: Img) => Promise<void>) => Promise<T>,
): Promise<JournalledMutation<T>> {
  let entryId: string | undefined;

  const onBeforeImage = async (image: Img): Promise<void> => {
    if (!journal) return;
    const entry = await journal.begin(spec.begin(image));
    // `if (entry)` and not `entryId = entry?.id`: a disabled journal wrote
    // nothing, so there must be no value here that reads like an entry.
    if (entry) entryId = entry.id;
  };

  const settle = async (patch: JournalFinishPatch): Promise<void> => {
    if (!journal || entryId === undefined) return;
    await journal.finish(entryId, patch);
  };

  let result: T;
  try {
    result = await run(onBeforeImage);
  } catch (e) {
    if ((spec.onError ?? "record-failed") === "record-failed") {
      await settle({ outcome: "failed", error: String(e) });
    }
    throw e;
  }

  return { result, entryId, settle };
}
