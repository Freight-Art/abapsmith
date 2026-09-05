/**
 * Credential-fingerprint registry and the durable, cross-process auth latch.
 *
 * Split out of `src/adt/circuit-breaker.ts` (was a 1700-line file mixing four
 * concerns). This file owns the in-process fingerprint registry, the
 * JSON-file-backed durable latch, and `lookupTrippedFingerprint` — the only
 * parts that touch `node:fs`. `circuit-breaker.ts` re-exports everything this
 * file exports, so no import site needed to change. `AuthCircuitBreaker.trip()`
 * calls INTO this module, never the reverse.
 *
 * Two standing rules constrain everything below: synchronous (reached from
 * the synchronous `AuthCircuitBreaker.forConfig`) and non-throwing (a broken
 * latch file must degrade to per-process behaviour, never break a connection).
 * See the git history for full design history.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { atomicWriteFileSync, hardenFileModeSync, resolveStateDir, withFileLockSync } from "../state-dir.js";
import type { TripInfo, TripReason } from "./circuit-breaker.js";

/**
 * D1 — fingerprint-keyed auth latch, process-wide, in-memory.
 *
 * `AuthCircuitBreaker` is per-instance, but short-lived one-shot connections
 * each build their own breaker, so a rejected password was never remembered
 * past the object that discovered it. This map fixes that: once a breaker
 * with a `credentialFingerprint` trips, `lookupTrippedFingerprint()` lets the
 * next connection replay the trip for zero network calls / zero lockout spend.
 *
 * Persistence (cross-PROCESS, not just cross-connection) is handled by a
 * SEPARATE, differently-keyed file — see the durable-latch section below.
 * SECURITY: nothing password-derived (not even length) ever reaches disk —
 * see `INSTALL_SALT` below and the git history for
 * the full constraint and a known url+user+client keying gap.
 *
 * The only clear is {@link clearTrippedFingerprint}, called after a re-armed
 * probe comes back authenticated — wire success is the one piece of evidence
 * that outranks the latch. `resetForTests()` still does not touch it — a
 * stray fixture call must not un-latch a real credential rejection.
 */
const TRIPPED_FINGERPRINTS = new Map<string, TripInfo>();

/**
 * Per-process random salt for `fingerprintCredentials()`. Regenerated every
 * process, and that is a hard security requirement, not a convenience: a
 * durable salt + durable sha256(salt+url+user+password) would be an offline
 * password-guessing oracle in a file the SAP user can read. This is why the
 * durable latch below is keyed on non-secret url+user instead of the
 * fingerprint. See the git history for the full
 * reasoning.
 */
const INSTALL_SALT = randomBytes(16).toString("hex");

/**
 * Non-secret (url, user) identity behind each fingerprint, so the durable
 * latch (which never sees the password) can still be keyed sensibly.
 * `fingerprintCredentials()` is the only seam where url/user/password are all
 * visible at once. Holds no secret: no password, length, hash, or preimage.
 */
const FINGERPRINT_IDENTITIES = new Map<string, CredentialIdentity>();

interface CredentialIdentity {
  url: string;
  user: string;
}

/**
 * `sha256(installSalt + url + user + password)`, truncated to 16 hex chars.
 * Never logged, never placed in an error, never written to disk.
 *
 * Side effect: registers the non-secret (url, user) pair in
 * {@link FINGERPRINT_IDENTITIES} — the only place that can, since it's the
 * only place that sees all three values.
 */
export function fingerprintCredentials(url: string, user: string, password: string): string {
  const fingerprint = createHash("sha256")
    .update(INSTALL_SALT + url + user + password, "utf8")
    .digest("hex")
    .slice(0, 16);
  FINGERPRINT_IDENTITIES.set(fingerprint, { url, user });
  return fingerprint;
}

// ---------------------------------------------------------------------------
// The durable, cross-process auth latch: N terminals opened against a stale
// password each burn a real logon against `login/fails_to_user_lock`
// (default 5) and lock the SAP user. `<stateDir>/auth-latch.json` makes that
// cost one logon total, keyed on sha256("abapsmith-auth-latch " + url + user)
// — non-secret identity only. Same two standing rules as above apply
// (synchronous, non-throwing).
// ---------------------------------------------------------------------------

const AUTH_LATCH_FILE = "auth-latch.json";
const AUTH_LATCH_VERSION = 1;

/**
 * How long a durable latch entry stays authoritative before a fresh lookup
 * drops it and lets the next connection spend its own logon attempt.
 *
 * Replaces a removed `passwordLength` discriminator that let a lookup infer
 * "password corrected" — but required a password-derived value on disk. TTL
 * costs nothing in secrecy: staleness is judged purely by the entry's `at`
 * timestamp. Strictly weaker than the old auto-clear (a corrected password
 * now waits out the TTL instead of clearing immediately); worst case after
 * expiry is one real logon attempt, same as pre-latch behaviour.
 *
 * 15 minutes: long enough to not fight an operator mid-terminal-juggling,
 * short enough that a corrected `.env` isn't blocked all session.
 */
export const AUTH_LATCH_TTL_MS = 15 * 60 * 1000;

/** On-disk shape of one entry. `url`/`user` stored in clear (already in the
 * config, logs and README); nothing here is password-derived. */
interface DurableLatchEntry {
  url: string;
  user: string;
  reason: TripReason;
  message: string;
  status?: number;
  /** `TripInfo.url` — the failed ADT request, renamed to avoid confusion
   * with the system `url` that forms half of the key. */
  requestUrl?: string;
  /** ISO 8601; the sole input to the TTL check in `lookupDurableLatch`. */
  at: string;
}

interface DurableLatchFile {
  version: number;
  entries: Record<string, DurableLatchEntry>;
}

const TRIP_REASONS: readonly TripReason[] = [
  "http-401",
  "http-403-auth",
  "icf-logon-page",
  "icf-password-change",
  "manual",
];

/** Installed only by {@link __setAuthLatchDirForTests}, which is itself
 * VITEST-gated — so this is always `undefined` in production. */
let authLatchDirForTests: string | undefined;

/** One warning per process. A degraded latch is worth saying once; saying it on
 * every `new AbapConnection` would bury the operator in stderr. */
let latchWarned = false;

/** One warning per process for a permission-hardening failure, distinct from
 * {@link latchWarned}: the latch is still fully functional when this fires. */
let latchPermWarned = false;

/** One hardening attempt per process — see its call site in {@link readLatchFile}. */
let latchPermHardenAttempted = false;

interface LatchCacheEntry {
  latchPath: string;
  mtimeMs: number;
  size: number;
  file: DurableLatchFile;
}

/** `forConfig` runs whenever a process mints its breaker, so the read path must not
 * re-parse the file each time. Invalidated by `mtimeMs`+`size` (and dropped
 * outright after any write of our own). */
let latchCache: LatchCacheEntry | undefined;

function underVitest(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
}

/**
 * Where the latch lives — resolved lazily (never at import time, since
 * `resolveStateDir` is cwd/env-dependent). `undefined` disables the durable
 * latch; every caller treats that as a silent no-op.
 *
 * Under vitest the latch is INERT unless a test explicitly installs a
 * directory (mandatory, not tidy): most test files share one url/user and
 * isolate cases only by password, so an always-on latch would cross-
 * contaminate cases and, via `resolveStateDir`'s cwd-anchored default, write
 * into the developer's working tree on every `npm test`.
 */
function authLatchPath(): string | undefined {
  if (underVitest()) {
    return authLatchDirForTests ? path.join(authLatchDirForTests, AUTH_LATCH_FILE) : undefined;
  }
  return path.join(resolveStateDir(process.env), AUTH_LATCH_FILE);
}

/**
 * The durable key: FULL sha256 (not truncated — a collision would latch the
 * wrong system) of a domain-separated, non-secret preimage. Not salted: a
 * salt would make the key process-local and defeat cross-process sharing.
 */
function authLatchKey(url: string, user: string): string {
  return createHash("sha256")
    .update("abapsmith-auth-latch " + url + " " + user, "utf8")
    .digest("hex");
}

function warnLatchDegraded(latchPath: string, what: string, cause: unknown): void {
  if (latchWarned) return;
  latchWarned = true;
  process.stderr.write(
    `[abapsmith] WARNING: ${what} the durable auth latch ${latchPath} ` +
      `(${(cause as Error)?.message ?? String(cause)}). The cross-terminal lockout guard is ` +
      "degraded: each MCP server process may now spend its own logon attempt against " +
      "login/fails_to_user_lock. The in-process latch is unaffected. Delete the file, or point " +
      "ABAP_STATE_DIR at a directory you own.\n",
  );
}

/**
 * Unlike {@link warnLatchDegraded}, this failure does not mean the latch
 * stopped working — only that a pre-existing file may be readable by other
 * accounts on a shared host.
 */
function warnLatchPermissions(latchPath: string, cause: unknown): void {
  if (latchPermWarned) return;
  latchPermWarned = true;
  process.stderr.write(
    `[abapsmith] WARNING: could not restrict permissions on the durable auth latch ${latchPath} ` +
      `(${(cause as Error)?.message ?? String(cause)}). It may be readable by other accounts on ` +
      "this host. The latch itself is still fully functional; fix the file's ownership/permissions " +
      "by hand if this host is shared.\n",
  );
}

/**
 * Structural validation AND sanitisation — rebuilds the object field-by-field
 * rather than narrowing `value` itself, so a legacy `passwordLength` field
 * (present on entries written before that field was removed) cannot ride
 * along in memory and get written back to disk during some other entry's
 * read-modify-write.
 */
function coerceLatchEntry(value: unknown): DurableLatchEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const e = value as Partial<DurableLatchEntry>;
  if (
    typeof e.url !== "string" ||
    typeof e.user !== "string" ||
    typeof e.message !== "string" ||
    typeof e.at !== "string" ||
    !TRIP_REASONS.some((r) => r === e.reason) ||
    (e.status !== undefined && typeof e.status !== "number") ||
    (e.requestUrl !== undefined && typeof e.requestUrl !== "string")
  ) {
    return undefined;
  }
  const entry: DurableLatchEntry = {
    url: e.url,
    user: e.user,
    reason: e.reason as TripReason,
    message: e.message,
    at: e.at,
  };
  if (typeof e.status === "number") entry.status = e.status;
  if (typeof e.requestUrl === "string") entry.requestUrl = e.requestUrl;
  return entry;
}

/** Structural validation, entry by entry. A file written by a future version,
 * a different tool or a half-finished hand-edit yields whatever entries still
 * parse and silently drops the rest — never an exception. */
function coerceLatchFile(parsed: unknown): DurableLatchFile | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const raw = parsed as Partial<DurableLatchFile>;
  if (raw.version !== AUTH_LATCH_VERSION) return undefined;
  if (typeof raw.entries !== "object" || raw.entries === null) return undefined;
  const entries: Record<string, DurableLatchEntry> = {};
  for (const [key, value] of Object.entries(raw.entries as Record<string, unknown>)) {
    const entry = coerceLatchEntry(value);
    if (entry) entries[key] = entry;
  }
  return { version: AUTH_LATCH_VERSION, entries };
}

/**
 * Read and parse the latch, or `undefined` for "no usable latch". ENOENT is
 * the common case and not a warning.
 *
 * `bypassCache`: used by the read-modify-write path, which needs the bytes on
 * disk right now, not a cached snapshot.
 */
function readLatchFile(latchPath: string, bypassCache = false): DurableLatchFile | undefined {
  let stat;
  try {
    stat = statSync(latchPath);
  } catch {
    latchCache = undefined;
    return undefined;
  }

  // Legacy files may have a permissive mode from before `atomicWriteFileSync`
  // passed `mode`; hardened at most once per process (idempotent, see
  // hardenFileModeSync's doc comment).
  if (!latchPermHardenAttempted) {
    latchPermHardenAttempted = true;
    try {
      hardenFileModeSync(latchPath);
    } catch (e) {
      warnLatchPermissions(latchPath, e);
    }
  }

  const cached = latchCache;
  if (
    !bypassCache &&
    cached &&
    cached.latchPath === latchPath &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size
  ) {
    return cached.file;
  }

  let file: DurableLatchFile | undefined;
  try {
    file = coerceLatchFile(JSON.parse(readFileSync(latchPath, "utf8")));
  } catch (e) {
    warnLatchDegraded(latchPath, "could not parse", e);
    latchCache = undefined;
    return undefined;
  }
  if (!file) {
    warnLatchDegraded(latchPath, "ignored an unrecognised", new Error("unexpected file shape"));
    latchCache = undefined;
    return undefined;
  }

  latchCache = { latchPath, mtimeMs: stat.mtimeMs, size: stat.size, file };
  return file;
}

/**
 * Read-modify-write the latch under the cross-process lock. `mutate` returns
 * false to mean "nothing changed, do not write".
 *
 * If the lock can't be taken within its budget, we do the read-modify-write
 * unlocked anyway rather than skip it — skipping means our entry never lands
 * and the next terminal burns a real logon, the exact failure this file
 * exists to prevent. The fallback re-reads immediately before writing, so the
 * race window is microseconds, and self-heals: a concurrent writer still
 * holds its entry in `TRIPPED_FINGERPRINTS`.
 */
function mutateLatchFile(latchPath: string, mutate: (file: DurableLatchFile) => boolean): void {
  let ran = false;
  const rmw = (): void => {
    ran = true;
    const current = readLatchFile(latchPath, true);
    const next: DurableLatchFile = {
      version: AUTH_LATCH_VERSION,
      entries: { ...(current?.entries ?? {}) },
    };
    if (!mutate(next)) return;
    // 2-space indent, trailing newline: a human is expected to open this file,
    // read it and delete it. That is the documented remediation.
    atomicWriteFileSync(latchPath, JSON.stringify(next, null, 2) + "\n");
    latchCache = undefined;
  };

  try {
    withFileLockSync(latchPath + ".lock", rmw);
  } catch (e) {
    // `rmw` already ran and threw — a real I/O failure, not lock contention;
    // let the caller turn it into a warning rather than retry.
    if (ran) throw e;
    rmw();
  }
}

/** Drop one entry — the credentials for this (url, user) changed. */
function dropLatchEntry(latchPath: string, key: string): void {
  mutateLatchFile(latchPath, (file) => {
    if (file.entries[key] === undefined) return false;
    delete file.entries[key];
    return true;
  });
}

/**
 * The durable half of {@link lookupTrippedFingerprint}. Returns a `TripInfo`
 * reconstructed from disk, or `undefined` for every failure mode.
 *
 * Auto-clear is TTL-only (see `AUTH_LATCH_TTL_MS`) rather than comparing
 * password-derived state, which no longer exists on disk.
 */
function lookupDurableLatch(identity: CredentialIdentity): TripInfo | undefined {
  const latchPath = authLatchPath();
  if (!latchPath) return undefined;
  try {
    const file = readLatchFile(latchPath);
    if (!file) return undefined;
    const key = authLatchKey(identity.url, identity.user);
    const entry = file.entries[key];
    if (!entry) return undefined;

    const at = new Date(entry.at);
    const atValid = !Number.isNaN(at.getTime());

    if (atValid && Date.now() - at.getTime() > AUTH_LATCH_TTL_MS) {
      // Stale: ages out on its own `at` timestamp regardless of whether the
      // next password would be the same bad one or a corrected one.
      dropLatchEntry(latchPath, key);
      return undefined;
    }

    return {
      reason: entry.reason,
      message: entry.message,
      status: entry.status,
      url: entry.requestUrl,
      at: atValid ? at : new Date(),
    };
  } catch (e) {
    warnLatchDegraded(latchPath, "could not read", e);
    return undefined;
  }
}

/**
 * The durable half of {@link recordTrippedFingerprint}, called only from
 * `AuthCircuitBreaker.trip()`'s `credentialFingerprint` branch — so a latch
 * replayed FROM disk can never rewrite the entry it was replayed from.
 *
 * Returns the path just written to on success, `undefined` on any no-op or
 * failure — the direct, non-re-reading answer to "did this land." Callers
 * that need staleness-aware "does an entry currently exist" semantics (e.g.
 * `forConfig`'s replay branch, well after the write that made it) want
 * {@link durableLatchPathFor} instead; that function's TTL-drop side effect
 * must never run as a side effect of confirming a write that just happened,
 * or a write with an already-stale `at` would immediately erase itself.
 *
 * NEVER THROWS: `trip()` is on a synchronous constructor path that must not
 * turn a full disk into a crash; the in-memory latch still works regardless.
 */
function persistDurableLatch(fingerprint: string, info: TripInfo): string | undefined {
  const identity = FINGERPRINT_IDENTITIES.get(fingerprint);
  // Fingerprint we never minted — nothing to key on.
  if (!identity) return undefined;
  const latchPath = authLatchPath();
  if (!latchPath) return undefined;

  try {
    const key = authLatchKey(identity.url, identity.user);
    const entry: DurableLatchEntry = {
      url: identity.url,
      user: identity.user,
      reason: info.reason,
      message: info.message,
      at: info.at.toISOString(),
    };
    if (typeof info.status === "number") entry.status = info.status;
    if (info.url) entry.requestUrl = info.url;
    mutateLatchFile(latchPath, (file) => {
      file.entries[key] = entry;
      return true;
    });
    return latchPath;
  } catch (e) {
    warnLatchDegraded(latchPath, "could not write", e);
    return undefined;
  }
}

function assertAuthLatchTestOnly(fn: string): void {
  // Test-only in the strongest way this codebase allows, exactly as
  // `AuthCircuitBreaker.resetForTests()` does it: vitest sets VITEST in every
  // worker's environment, so a production process cannot get here.
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    throw new Error(
      `${fn}() is test-only and must never run in production. The durable auth latch lives ` +
        "under ABAP_STATE_DIR and is cleared by deleting that file, not by calling into this " +
        "module.",
    );
  }
}

/**
 * Opt a test INTO the durable latch via a private directory (`undefined` to
 * opt back out). Inert under vitest otherwise — see {@link authLatchPath}.
 * Does not clear `TRIPPED_FINGERPRINTS` — no exported clear exists for it.
 */
export function __setAuthLatchDirForTests(dir: string | undefined): void {
  assertAuthLatchTestOnly("__setAuthLatchDirForTests");
  authLatchDirForTests = dir;
  latchCache = undefined;
}

/** Forget the installed directory, the identity side channel and the read
 * cache. `TRIPPED_FINGERPRINTS` is untouched, on purpose — see above. */
export function __resetAuthLatchForTests(): void {
  assertAuthLatchTestOnly("__resetAuthLatchForTests");
  FINGERPRINT_IDENTITIES.clear();
  authLatchDirForTests = undefined;
  latchCache = undefined;
  latchWarned = false;
  latchPermWarned = false;
  latchPermHardenAttempted = false;
}

/**
 * Prior real trip for these credentials, if any: checks the in-memory map,
 * then the durable latch file via the fingerprint's registered identity.
 *
 * A durable hit does NOT seed `TRIPPED_FINGERPRINTS` — that's what lets
 * `rm auth-latch.json` take effect immediately in a running process.
 */
export function lookupTrippedFingerprint(fingerprint: string): TripInfo | undefined {
  const inMemory = TRIPPED_FINGERPRINTS.get(fingerprint);
  if (inMemory) return inMemory;
  const identity = FINGERPRINT_IDENTITIES.get(fingerprint);
  if (!identity) return undefined;
  return lookupDurableLatch(identity);
}

/**
 * Where the durable entry for `fingerprint`'s registered identity lives, or
 * `undefined` when no such entry currently exists — no identity registered,
 * no latch directory resolved (the vitest default), no file, no entry, or a
 * stale one that {@link lookupDurableLatch} has just TTL-dropped. Deliberately
 * routes through `lookupDurableLatch` rather than re-reading the file itself,
 * so "currently exists" always agrees with what a lookup would find, staleness
 * included.
 *
 * Same two standing rules as everything else here: synchronous, never throws.
 */
export function durableLatchPathFor(fingerprint: string): string | undefined {
  const identity = FINGERPRINT_IDENTITIES.get(fingerprint);
  if (!identity) return undefined;
  const latchPath = authLatchPath();
  if (!latchPath) return undefined;
  try {
    return lookupDurableLatch(identity) ? latchPath : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write-side counterpart to {@link lookupTrippedFingerprint}, called only
 * from `AuthCircuitBreaker.trip()`'s `credentialFingerprint` branch: remember
 * the trip in-process, then durably. Returns the durable latch path on a
 * successful write, `undefined` otherwise, so the caller can record it
 * directly instead of re-deriving it with a second, staleness-aware lookup.
 */
export function recordTrippedFingerprint(fingerprint: string, info: TripInfo): string | undefined {
  TRIPPED_FINGERPRINTS.set(fingerprint, info);
  // Stops the second TERMINAL (not just the second connection) from
  // reaching `login/fails_to_user_lock`. Cannot throw.
  return persistDurableLatch(fingerprint, info);
}

// ---------------------------------------------------------------------------
// Operator re-arm signal: the ONLY way to admit another logon attempt once
// latched. No timer anywhere re-probes on its own — see circuit-breaker.ts.
// ---------------------------------------------------------------------------

/** Filename of the operator re-arm signal, beside auth-latch.json in the state dir. */
const AUTH_REARM_FILE = "auth-rearm";

/**
 * Where an operator drops the re-arm signal, or `undefined` when no state
 * directory is in play (the vitest default — a test opts in with
 * {@link __setAuthLatchDirForTests}, exactly like the durable latch).
 */
export function authRearmSignalPath(): string | undefined {
  if (underVitest()) {
    return authLatchDirForTests ? path.join(authLatchDirForTests, AUTH_REARM_FILE) : undefined;
  }
  return path.join(resolveStateDir(process.env), AUTH_REARM_FILE);
}

/**
 * Consume the operator's re-arm signal: true iff the file existed, and
 * removes it — one file, one admitted logon attempt. Never throws.
 */
export function consumeAuthRearmSignal(): boolean {
  const signalPath = authRearmSignalPath();
  if (!signalPath) return false;
  try {
    statSync(signalPath);
  } catch {
    return false;
  }
  try {
    unlinkSync(signalPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Forget a trip once a re-armed probe proved the credentials are accepted:
 * drops the in-memory entry and the durable one, so neither the next
 * connection here nor a fresh process replays it. Never throws.
 */
export function clearTrippedFingerprint(fingerprint: string): void {
  TRIPPED_FINGERPRINTS.delete(fingerprint);
  try {
    const identity = FINGERPRINT_IDENTITIES.get(fingerprint);
    if (!identity) return;
    const latchPath = authLatchPath();
    if (!latchPath) return;
    dropLatchEntry(latchPath, authLatchKey(identity.url, identity.user));
  } catch {
    /* never throws */
  }
}
