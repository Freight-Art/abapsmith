/**
 * Shared on-disk state directory and cross-process file lock, used to
 * serialise the journal's index prune / blob sweep and to hold the durable
 * auth latch. An in-process mutex can't see these races: concurrent prunes
 * can destroy before-images still referenced by surviving index entries, and
 * a per-process auth latch lets N terminals each burn a logon attempt against
 * `login/fails_to_user_lock`. Measured incident and full defect list: see
 * the git history.
 *
 * Hand-rolled `O_EXCL` lockfile rather than `proper-lockfile`: that package is
 * unmaintained, untyped, and keeps a live `setInterval` that would pin an
 * otherwise-idle MCP stdio event loop. Decisive reason: the durable auth latch
 * is written from `AuthCircuitBreaker.trip()` (src/adt/circuit-breaker.ts),
 * on `AbapConnection`'s **synchronous** constructor seam, where a promise-only
 * lock cannot be taken — hence {@link withFileLockSync}, for that caller only.
 *
 * LOCK ORDERING — READ BEFORE ADDING A CALLER. Not re-entrant. The journal
 * takes this lock INSIDE its in-process queue, `runExclusive`
 * (src/journal.ts:649), never outside it — inverting it deadlocks a prune
 * (holding the file lock, waiting on the queue) against a queued append
 * (waiting on the file lock the prune holds):
 *
 *     runExclusive → withFileLock → fn        (correct)
 *     withFileLock → runExclusive → fn        (deadlock)
 *
 * Critical section: one exclusive lock, held for the whole of prune
 * (`readAll()` through the blob sweep's last `unlink`) and briefly, per
 * `appendFile`, by each append.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  promises as fs,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AbapError, isAbapError } from "./adt/errors.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_LOCK_WAIT_MS = 5_000;

/** Sanity bounds on `ABAP_LOCK_WAIT_MS`: below the floor a lock can't survive
 * a realistic prune; above the ceiling a tool call hangs long enough to look
 * like a wedged server. */
const MIN_LOCK_WAIT_MS = 100;
const MAX_LOCK_WAIT_MS = 120_000;

/** Sync variant's own ceiling: this wait stalls the whole process (no event
 * loop, no stdio), so 1s is the cap even when `ABAP_LOCK_WAIT_MS` is higher.
 * Losing the write falls back to the per-process latch behaviour already
 * shipped for months, which is a better trade than a multi-second stall. */
const SYNC_LOCK_WAIT_CAP_MS = 1_000;

/** First retry sleep, doubling per attempt up to {@link BACKOFF_CAP_MS}. */
const BACKOFF_BASE_MS = 5;
const BACKOFF_CAP_MS = 50;

/** Copied, not imported, from src/journal.ts:322-327 — the journal imports
 * this file, not the other way round. Unset/blank/non-numeric/negative all
 * fall back silently rather than making an env var typo fatal. */
function intFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * Root of the shared on-disk state: journal lockfile, in-flight blob
 * registry, durable auth latch.
 *
 *   ABAP_STATE_DIR → resolved against `cwd`, default `<cwd>/.abapsmith`
 *
 * Shaped like `journalConfigFromEnv` (src/journal.ts:356-359). Default is
 * deliberately the **parent** of the default journal root
 * (`<cwd>/.abapsmith/journal`): state is per-installation across every SID,
 * the journal is namespaced per SID underneath it.
 *
 * cwd-anchored like the journal dir, so two terminals in different
 * directories silently get separate, non-excluding state — hence printing
 * the resolved path at startup and offering `ABAP_STATE_DIR` as an escape
 * hatch.
 */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env, cwd?: string): string {
  const base = cwd ?? process.cwd();
  return env.ABAP_STATE_DIR?.trim()
    ? path.resolve(base, env.ABAP_STATE_DIR.trim())
    : path.resolve(base, ".abapsmith");
}

/**
 * How long to wait for the cross-process lock before giving up.
 *
 *   ABAP_LOCK_WAIT_MS → default 5 000 ms, accepted range 100…120 000 ms
 *
 * Out-of-range is treated like non-numeric: falls back to the default rather
 * than being clamped to the nearest bound. Clamping would quietly honour half
 * of a wrong instruction (`ABAP_LOCK_WAIT_MS=10` silently becoming 100 ms
 * looks like it took effect); the default is the more honest silent fallback.
 */
export function resolveLockWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const ms = intFromEnv(env.ABAP_LOCK_WAIT_MS, DEFAULT_LOCK_WAIT_MS);
  if (ms < MIN_LOCK_WAIT_MS || ms > MAX_LOCK_WAIT_MS) return DEFAULT_LOCK_WAIT_MS;
  return ms;
}

// ---------------------------------------------------------------------------
// Lock holder record
// ---------------------------------------------------------------------------

/**
 * What goes inside the lockfile — diagnosis, stale detection and release
 * ownership only; nothing here is authoritative, since a lockfile from an
 * older or foreign version may contain anything (a parse failure is always
 * treated as "unknown holder", never an error).
 *
 * `nonce` identifies THIS acquisition, not this process: pid + hostname alone
 * can't distinguish our lock file from one the same pid created after ours was
 * broken away from us (see {@link releaseOwnLock}).
 */
interface LockHolder {
  pid: number;
  hostname: string;
  startedAt: string;
  nonce: string;
}

/** 96 bits of randomness per acquisition; an identity tag, not a secret. */
function newNonce(): string {
  return randomBytes(12).toString("hex");
}

function holderPayload(now: () => number, nonce: string): string {
  const holder: LockHolder = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date(now()).toISOString(),
    nonce,
  };
  return JSON.stringify(holder);
}

/**
 * `nonce` is parsed as leniently as `startedAt` (missing/non-string → `""`),
 * load-bearing: a lock file predating the nonce field must still yield a
 * holder so {@link ownerIsGone} can break it once its pid is dead, rather than
 * being demoted to "unknown holder" and stuck behind the slow hard-stale
 * valve. A `""` nonce can never match ours ({@link newNonce} is 24 hex chars),
 * so it's never mistaken for our own on release.
 */
function parseHolder(raw: string): LockHolder | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { pid, hostname, startedAt, nonce } = parsed as Partial<LockHolder>;
    if (typeof pid !== "number" || typeof hostname !== "string") return undefined;
    return {
      pid,
      hostname,
      startedAt: typeof startedAt === "string" ? startedAt : "",
      nonce: typeof nonce === "string" ? nonce : "",
    };
  } catch {
    return undefined;
  }
}

/**
 * True only when we can PROVE the recorded owner is gone. Two deliberate
 * refusals: a different `hostname` means we can't test liveness of a pid on
 * another machine (guessing could delete a lock a second host actively
 * holds); `EPERM` from `kill(pid, 0)` means the process exists but belongs to
 * another user — alive, not stale. Only `ESRCH` counts.
 */
function ownerIsGone(holder: LockHolder): boolean {
  if (holder.hostname !== os.hostname()) return false;
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return false;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * The safety valve: past this age a lockfile is removed regardless of what it
 * says or whether its pid is alive. Needed because `ownerIsGone` alone can't
 * catch pid reuse, foreign/unparseable lockfiles, or shared filesystems — see
 * the git history for the full case-by-case argument.
 * Safe for the journal specifically because its protected section is small
 * and bounded (a `readFile`, a `readdir`, a handful of `unlink`s).
 *
 * This is about the PROTECTED SECTION's duration, not the contender's
 * patience — do not derive it from `waitMs`. `FileLockObjectGate`
 * (src/adt/pool.ts) has a deliberately short `waitMs` (1500 ms) guarding an
 * entire tool action that can exceed a minute; deriving the valve from its
 * `waitMs` would let a contender break a live holder. Such callers must pass
 * {@link FileLockOptions.hardStaleMs} explicitly.
 *
 * This is only the DEFAULT, unchanged so existing journal call sites are
 * unaffected.
 */
function defaultHardStaleMs(waitMs: number): number {
  return Math.max(10 * waitMs, 60_000);
}

// ---------------------------------------------------------------------------
// Release ownership
// ---------------------------------------------------------------------------

/** Reaching this means another process decided our lock was stale and broke
 * it while we were still inside the critical section. The old unconditional
 * unlink let a third process walk straight in behind it; refusing to unlink
 * here stops the cascade at two participants and this warning makes it
 * diagnosable. */
function lockBrokenWarning(lockPath: string, holder: LockHolder | undefined): string {
  const who = holder
    ? `it is now held by pid ${holder.pid} on ${holder.hostname} since ` +
      `${holder.startedAt || "an unknown time"}`
    : "it has been deleted, or its contents are not a holder record we can read";
  return (
    `[abapsmith] WARNING: our lock file ${lockPath} was broken while we still held it — ` +
    `${who}. NOT unlinking it: it is somebody else's lock now, and removing it would let a ` +
    `third process into the same critical section. Two processes have already been inside it ` +
    `concurrently. If the work under this lock legitimately takes this long, raise the ` +
    `caller's hardStaleMs.\n`
  );
}

/** Half-jittered exponential backoff, capped so a long prune isn't waited on
 * in ever-growing steps. Jitter avoids N servers that collide once colliding
 * again in lockstep on every subsequent attempt. */
function backoffMs(attempt: number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
  return base / 2 + Math.random() * (base / 2);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function lockIoError(what: string, lockPath: string, cause: unknown): AbapError {
  const err = cause as NodeJS.ErrnoException;
  return new AbapError(
    "JOURNAL_IO",
    `${what} (${lockPath}): ${err.message}`,
    { lockPath, errno: err.code },
    "Check that the state directory exists and is writable, or point ABAP_STATE_DIR at a " +
      "directory you own.",
  );
}

/** The part of a {@link LockHolder} safe to repeat back to a caller: who
 * holds the lock and since when. `nonce` is deliberately absent — it means
 * nothing outside {@link releaseOwnLock}. */
export interface FileLockHolder {
  pid: number;
  hostname: string;
  startedAt: string;
}

/**
 * True only for the error {@link withFileLock} throws when it FAILS TO ACQUIRE
 * `lockPath` (timeout, or create/write failure) — never for whatever `fn()`
 * threw once the lock was granted. Both carry `JOURNAL_IO`, so the
 * discriminator is `details.lockPath`, which an acquisition failure always
 * carries as exactly the caller's path and `fn()` can't produce by
 * coincidence.
 *
 * Lives here rather than duplicated per caller since it's a statement about
 * `lockTimeoutError`/`lockIoError`'s own `details` shape. Used by
 * `FileLockObjectGate` (src/adt/object-gate.ts) and `FileLockDebugArmLock`
 * (src/debug/arm-lock.ts).
 */
export function isFileLockAcquisitionFailure(e: unknown, lockPath: string): e is AbapError {
  return isAbapError(e) && e.code === "JOURNAL_IO" && e.details.lockPath === lockPath;
}

/** The holder recorded on a lock-acquisition failure, or `undefined` when
 * there was none to read. Callers must never invent one. */
export function fileLockHolderOf(e: AbapError): FileLockHolder | undefined {
  return e.details.holder as FileLockHolder | undefined;
}

function lockTimeoutError(lockPath: string, waitMs: number, holder?: LockHolder): AbapError {
  const since = holder?.startedAt || "an unknown time";
  const held = holder
    ? `held by pid ${holder.pid} on ${holder.hostname} since ${since}`
    : "holder unknown — the lock file is unreadable, or was written by another version";
  return new AbapError(
    "JOURNAL_IO",
    `Timed out after ${waitMs} ms waiting for the cross-process lock ${lockPath} (${held}).`,
    { lockPath, waitMs, holder },
    `Another abapsmith process is holding this lock. Raise ABAP_LOCK_WAIT_MS (currently ` +
      `${waitMs} ms) if your journal is large and prunes are slow. If no MCP server is ` +
      `running, the lock is a leftover and you can delete ${lockPath} by hand.`,
  );
}

// ---------------------------------------------------------------------------
// Async lock — the journal's path
// ---------------------------------------------------------------------------

export interface FileLockOptions {
  /**
   * How long a CONTENDER may wait to acquire before giving up with
   * `JOURNAL_IO`. Defaults to `ABAP_LOCK_WAIT_MS` ({@link resolveLockWaitMs}).
   */
  waitMs?: number;
  /**
   * How long the HOLDER may legitimately keep the lock before a contender may
   * break it regardless of the holder record — see {@link defaultHardStaleMs}.
   * A property of the protected section, not the caller's patience; defaults
   * to `max(10 * waitMs, 60 000)`. Callers whose critical section is a long
   * ADT round trip MUST pass their own.
   */
  hardStaleMs?: number;
  /** Lets tests drive the clock; must be `Date.now`-compatible since
   * staleness compares it against the lockfile's `mtimeMs`. */
  now?: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readHolder(lockPath: string): Promise<LockHolder | undefined> {
  try {
    return parseHolder(await fs.readFile(lockPath, "utf8"));
  } catch {
    return undefined;
  }
}

async function unlinkQuietly(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * Release a lock we acquired: unlink the lock file ONLY if it still carries our
 * `nonce`. Anything else — a different nonce, no nonce, unparseable contents,
 * or no file at all — means the lock was broken away from us, so we warn and
 * leave the file exactly where it is. See {@link lockBrokenWarning}.
 *
 * Non-`ENOENT` read failures are rethrown so the caller's release `catch` can
 * report them under its existing "could not release" wording; this function
 * never throws for the ownership decision itself.
 */
async function releaseOwnLock(lockPath: string, nonce: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    process.stderr.write(lockBrokenWarning(lockPath, undefined));
    return;
  }
  const holder = parseHolder(raw);
  if (holder !== undefined && holder.nonce === nonce) {
    await unlinkQuietly(lockPath);
    return;
  }
  process.stderr.write(lockBrokenWarning(lockPath, holder));
}

/** One stale check per retry attempt. Returns true if the lock was removed and
 * the caller should retry immediately rather than sleep. */
async function breakIfStale(
  lockPath: string,
  waitMs: number,
  hardMs: number,
  now: () => number,
): Promise<boolean> {
  let age: number;
  try {
    age = now() - (await fs.stat(lockPath)).mtimeMs;
  } catch (e) {
    // ENOENT: the holder released between our failed open and this stat — that
    // is a free retry, not an error.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }

  if (age > hardMs) {
    await unlinkQuietly(lockPath);
    return true;
  }
  if (age > 2 * waitMs) {
    const holder = await readHolder(lockPath);
    if (holder && ownerIsGone(holder)) {
      await unlinkQuietly(lockPath);
      return true;
    }
  }
  return false;
}

/**
 * Run `fn` holding an exclusive cross-process lock on `lockPath`.
 *
 * **Not re-entrant** — see the lock-ordering rule in the file header. Take
 * this INSIDE `runExclusive` (src/journal.ts:649), never around it.
 *
 * Async `fs` throughout because this lock sits on the MCP stdio hot path
 * (every `append()`); a synchronous retry loop would block the event loop for
 * the whole wait budget. `"wx"` is `O_CREAT | O_EXCL | O_WRONLY`.
 *
 * The holder record is written via the FileHandle's own `write`, not
 * `fs.writeFile` — required because test/journal.test.ts:656-699 spies on the
 * module-level `promises.writeFile` to park a specific blob write, and a lock
 * write through that spy would corrupt it.
 *
 * Released in a `finally` so `fn`'s rejection propagates and the lock still
 * frees. Release is OWNERSHIP-CHECKED: unlinks only if the lock file still
 * carries this acquisition's nonce; see {@link releaseOwnLock}.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const now = opts.now ?? (() => Date.now());
  const waitMs = opts.waitMs ?? resolveLockWaitMs();
  const hardMs = opts.hardStaleMs ?? defaultHardStaleMs(waitMs);
  const nonce = newNonce();

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const deadline = now() + waitMs;
  let attempt = 0;

  for (;;) {
    let handle;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw lockIoError("Could not create the lock file", lockPath, e);
      }
    }

    if (handle !== undefined) {
      try {
        try {
          await handle.write(holderPayload(now, nonce));
        } finally {
          await handle.close();
        }
      } catch (e) {
        // We own the file but failed to describe ourselves in it. Leaving it
        // behind would wedge every other process until the hard-stale valve
        // fires, so drop it and fail loudly instead.
        await unlinkQuietly(lockPath);
        throw lockIoError("Could not write the lock holder record", lockPath, e);
      }
      break;
    }

    if (await breakIfStale(lockPath, waitMs, hardMs, now)) {
      attempt = 0;
      continue;
    }

    const remaining = deadline - now();
    if (remaining <= 0) throw lockTimeoutError(lockPath, waitMs, await readHolder(lockPath));
    await sleep(Math.min(backoffMs(attempt), remaining));
    attempt += 1;
  }

  try {
    return await fn();
  } finally {
    try {
      await releaseOwnLock(lockPath, nonce);
    } catch (e) {
      // Never throw from the release: `fn`'s own error is the one the caller
      // needs, and masking it with an unlink failure would be a strictly worse
      // diagnostic. The hard-stale valve bounds the damage of a lock we failed
      // to remove.
      process.stderr.write(
        `[abapsmith] WARNING: could not release the lock file ${lockPath} ` +
          `(${(e as Error).message}). It will be broken as stale by the next waiter.\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Sync lock — the auth latch's path, and nothing else
// ---------------------------------------------------------------------------
//
// Duplicates the async algorithm above rather than sharing it: JS has no way
// to share a body between sync and async implementations, and this one must
// stay genuinely synchronous. Kept deliberately line-for-line comparable.

/** Sleep that doesn't spin: `Atomics.wait` on a private `SharedArrayBuffer`
 * nobody can notify parks the thread properly instead of busy-waiting on
 * `Date.now()`, which would burn a core on an already-blocked event loop.
 * Legal on Node's main thread (unlike a browser's). */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readHolderSync(lockPath: string): LockHolder | undefined {
  try {
    return parseHolder(readFileSync(lockPath, "utf8"));
  } catch {
    return undefined;
  }
}

function unlinkQuietlySync(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** Sync twin of {@link releaseOwnLock}; same ownership rule, same warning. */
function releaseOwnLockSync(lockPath: string, nonce: string): void {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    process.stderr.write(lockBrokenWarning(lockPath, undefined));
    return;
  }
  const holder = parseHolder(raw);
  if (holder !== undefined && holder.nonce === nonce) {
    unlinkQuietlySync(lockPath);
    return;
  }
  process.stderr.write(lockBrokenWarning(lockPath, holder));
}

/** Sync twin of {@link breakIfStale}; same rules, same safety valve. */
function breakIfStaleSync(
  lockPath: string,
  waitMs: number,
  hardMs: number,
  now: () => number,
): boolean {
  let age: number;
  try {
    age = now() - statSync(lockPath).mtimeMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }

  if (age > hardMs) {
    unlinkQuietlySync(lockPath);
    return true;
  }
  if (age > 2 * waitMs) {
    const holder = readHolderSync(lockPath);
    if (holder && ownerIsGone(holder)) {
      unlinkQuietlySync(lockPath);
      return true;
    }
  }
  return false;
}

/**
 * Synchronous twin of {@link withFileLock}, for callers with no `await` to
 * give. Exactly one caller and there should never be a second:
 * `AuthCircuitBreaker.trip()` (src/adt/circuit-breaker.ts:681), reached from
 * `AbapConnection`'s synchronous constructor. Everything else must use the
 * async form.
 *
 * Default wait budget is `min(ABAP_LOCK_WAIT_MS, 1 000 ms)`, not
 * `ABAP_LOCK_WAIT_MS`: this wait stalls the entire process, and a
 * multi-second constructor stall is worse than losing one latch write. Pass
 * `opts.waitMs` to override, and think about what you're blocking first.
 *
 * Not re-entrant; same lock-ordering rule as the async form.
 */
export function withFileLockSync<T>(
  lockPath: string,
  fn: () => T,
  opts: FileLockOptions = {},
): T {
  const now = opts.now ?? (() => Date.now());
  const waitMs = opts.waitMs ?? Math.min(resolveLockWaitMs(), SYNC_LOCK_WAIT_CAP_MS);
  const hardMs = opts.hardStaleMs ?? defaultHardStaleMs(waitMs);
  const nonce = newNonce();

  mkdirSync(path.dirname(lockPath), { recursive: true });

  const deadline = now() + waitMs;
  let attempt = 0;

  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw lockIoError("Could not create the lock file", lockPath, e);
      }
    }

    if (fd !== undefined) {
      try {
        try {
          writeSync(fd, holderPayload(now, nonce));
        } finally {
          closeSync(fd);
        }
      } catch (e) {
        unlinkQuietlySync(lockPath);
        throw lockIoError("Could not write the lock holder record", lockPath, e);
      }
      break;
    }

    if (breakIfStaleSync(lockPath, waitMs, hardMs, now)) {
      attempt = 0;
      continue;
    }

    const remaining = deadline - now();
    if (remaining <= 0) throw lockTimeoutError(lockPath, waitMs, readHolderSync(lockPath));
    sleepSync(Math.min(backoffMs(attempt), remaining));
    attempt += 1;
  }

  try {
    return fn();
  } finally {
    try {
      releaseOwnLockSync(lockPath, nonce);
    } catch (e) {
      process.stderr.write(
        `[abapsmith] WARNING: could not release the lock file ${lockPath} ` +
          `(${(e as Error).message}). It will be broken as stale by the next waiter.\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Write `data` to `filePath` via a uniquely named temporary + `rename`, atomic
 * within a filesystem, so a reader never observes a partial file.
 *
 * tmp name carries pid AND four random bytes — pid alone isn't enough (one
 * process can have two writes to the same target in flight, and pids recycle)
 * and a fixed name caused a real incident: two concurrent prunes wrote the
 * same tmp file (the git history).
 *
 * Sync because callers (auth latch, prune rewrite's sync mirror) already hold
 * the lock and want bytes on disk before releasing it. On failure the tmp
 * file is best-effort removed and the original error rethrown unchanged.
 *
 * SECURITY: temp file mode `0600` — `rename(2)` moves the inode's mode too,
 * so every rewrite through this function ends up `0600` regardless of a
 * pre-existing file's mode or the process umask. Does NOT fix a permissive
 * file that is never rewritten again; see {@link hardenFileModeSync}.
 */
export function atomicWriteFileSync(filePath: string, data: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, filePath);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort: the write already failed, and a leftover .tmp is inert */
    }
    throw e;
  }
}

/**
 * Best-effort `chmod` to `0600` for files predating this fix (or never
 * rewritten since) — `atomicWriteFileSync`'s rename-based fix only takes
 * effect on the NEXT write, so a latch entry read many times but never
 * mutated again would otherwise keep its original mode forever.
 *
 * No-op on Windows (no POSIX permission bits) and swallows `ENOENT` (file
 * legitimately gone between the caller's read and this call, already handled
 * by the caller's read path). Every other error — e.g. `EPERM` — is rethrown
 * so the caller can fold it into its own "latch degraded" warning rather than
 * this silently masking a real permissions problem.
 */
export function hardenFileModeSync(filePath: string): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(filePath, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}
