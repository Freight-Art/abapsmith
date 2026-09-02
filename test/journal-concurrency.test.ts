/**
 * The write journal ACROSS PROCESSES.
 *
 * test/journal.test.ts pins the journal's behaviour inside one process, where
 * `runExclusive()` is a real mutex and `inFlight` is a `Set` everybody can see.
 * Running four MCP server processes against one journal directory, offline,
 * showed that assumption stopped holding: 3× `ENOENT` on rename and — the
 * finding that matters — **6 of 22 surviving index entries referenced a
 * before-image that had been destroyed**. Undo had silently stopped being able
 * to restore what it promised. This file pins the fixes for the three defects
 * that caused it, numbered "item 1" / "item 2" / "item 4" below to match the
 * `describe` blocks further down that pin each one:
 *
 *  - **item 1 (CRITICAL, silent).** `pruneLocked()` read-modify-writes
 *    `index.jsonl` via tmp+rename. Another process's `appendFile()` lands in the
 *    OLD inode between the `readAll()` and the `rename()` and ceases to exist —
 *    the `begin` line, before-image pointer and all. Fixed by a cross-process
 *    file lock (`withIndexLock()` → `withFileLock()` in
 *    src/state-dir.ts), taken INSIDE `runExclusive()`, never around it.
 *  - **item 2 (CRITICAL).** `sweepBlobs()` unlinks another process's live
 *    before-image, because `inFlight` is a `Set` in one heap. `readBlob()` then
 *    swallows the ENOENT and undo restores nothing. Fixed by an on-disk
 *    in-flight registry — `.inflight/<id>.<pid>` marker files, beside
 *    the index rather than `<blobDir>/.inflight` (see `INFLIGHT_DIR`) —
 *    together with the reaping rule that stops a crashed process protecting a
 *    blob for ever (age past `INFLIGHT_GRACE_MS` **and** a pid that is provably
 *    not running on this host).
 *  - **item 4 (HIGH).** Two prunes shared one fixed temp path
 *    `${indexPath}.tmp`; that alone accounted for 3 of the 6 observed failures.
 *    Fixed by `${indexPath}.${pid}.${randomHex}.tmp`.
 *
 * ## How a second process is simulated
 *
 * Almost everything here uses **two `Journal` instances over the same
 * directory**. That is a faithful stand-in for two server processes for every
 * defect above, and faithful precisely where it counts: each instance has its
 * own `tail`, so `runExclusive()` does not serialise them at all, and its own
 * in-memory `inFlight` Set, so neither can see the other's live writes. Those
 * two facts ARE the cross-process defect. What the simulation cannot reproduce
 * is pid-based liveness — both instances share `process.pid` — so there is
 * exactly one genuine child-process test, at the bottom, for the rule that a
 * crashed process must never be able to deadlock the journal.
 *
 * Fixtures are copied from test/journal.test.ts rather than imported: that
 * suite exports none of them, and a shared fixture module would couple two
 * suites that are deliberately about different scopes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  Journal,
  type JournalBeginInput,
  type JournalConfig,
  type JournalEntry,
  type JournalObjectRef,
} from "../src/journal.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Fixtures (shape copied from test/journal.test.ts:46-113)
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-journal-xp-"));
});

/**
 * Registered FIRST so it runs last: `vitest.config.ts` sets
 * `fileParallelism: false`, so every suite in this run shares one process and
 * one `promises` object. A spy left installed here would follow the next suite
 * into its own tests.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const cfg = (dir: string, over: Partial<JournalConfig> = {}): JournalConfig => ({
  dir,
  enabled: true,
  maxEntries: 200,
  maxAgeDays: 30,
  ...over,
});

const objectRef = (name = "ZMCP_DEMO"): JournalObjectRef => ({
  name,
  type: "PROG/P",
  uri: `/sap/bc/adt/programs/programs/${name.toLowerCase()}`,
  sourceUri: `/sap/bc/adt/programs/programs/${name.toLowerCase()}/source/main`,
  package: "$TMP",
  description: "journal concurrency test",
});

const beginInput = (over: Partial<JournalBeginInput> = {}): JournalBeginInput => ({
  operation: "update",
  object: objectRef(),
  existedBefore: true,
  beforeSource: "REPORT zmcp_demo.\nWRITE: / 'old'.\n",
  afterSource: "REPORT zmcp_demo.\nWRITE: / 'new'.\n",
  tool: "abap_write",
  ...over,
});

/** See test/journal.test.ts:99-110 — an `undefined` here is a broken test. */
const begun = async (j: Journal, over: Partial<JournalBeginInput> = {}): Promise<JournalEntry> => {
  const entry = await j.begin(beginInput(over));
  if (!entry) throw new Error("begin() returned undefined, but this journal is enabled");
  return entry;
};

const indexLines = async (dir: string): Promise<string[]> =>
  (await fs.readFile(path.join(dir, "index.jsonl"), "utf8")).split("\n").filter((l) => l.trim());

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Yield to the event loop enough times for a couple of queued fs ops to run. */
const settleEventLoop = async (ticks = 20): Promise<void> => {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r));
};

/**
 * Wait until `cond` holds. Unbounded ticking with a wall-clock backstop, for the
 * reason test/journal.test.ts:641-654 gives: how many event-loop turns an mkdir
 * + writeFile takes is a property of the machine, not of the code under test.
 * The predicate may be async here because most of the states these tests wait
 * for are on disk.
 */
const waitUntil = async (
  cond: () => boolean | Promise<boolean>,
  what: string,
): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
};

const blobDir = (): string => path.join(tmp, "blobs");
const inFlightDir = (): string => path.join(tmp, ".inflight");
const lockPath = (): string => path.join(tmp, "index.jsonl.lock");

const countBlobs = async (suffix: string): Promise<number> =>
  (await fs.readdir(blobDir())).filter((f) => f.endsWith(suffix)).length;

const listMarkers = async (): Promise<string[]> => {
  try {
    return await fs.readdir(inFlightDir());
  } catch {
    return [];
  }
};

/**
 * The exact temp name `pruneLocked()` must mint: the index path, this process's
 * pid, and four random bytes as eight hex characters. Not a fixed
 * `${indexPath}.tmp` — see the file header, item 4.
 */
const TMP_NAME_RE = new RegExp(`\\.${String(process.pid)}\\.[0-9a-f]{8}\\.tmp$`);

/**
 * A pid that is certainly not running here, for the marker-reaping rule. Probed
 * upward over a bounded range so a machine that somehow has every one of them
 * occupied skips the test rather than hanging or asserting against a live
 * process. `EPERM` (exists, another user's) keeps scanning — only `ESRCH`
 * proves absence, which is exactly `pidIsAlive()`'s own rule.
 */
function findDeadPid(): number | undefined {
  for (let p = 30_000; p < 40_000; p++) {
    try {
      process.kill(p, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return p;
    }
  }
  return undefined;
}
const DEAD_PID = findDeadPid();

// ---------------------------------------------------------------------------
// Defect 1 — the lost append  (item 1)
// ---------------------------------------------------------------------------

describe("the index lock stops one process's prune swallowing another's append", () => {
  /**
   * The cross-process case, and NOT the one test/journal.test.ts:701-731 already
   * covers.
   *
   * That test fires the append from the SAME `Journal` object whose prune is
   * parked, so `runExclusive()` alone is enough to order the two: both sections
   * queue on one `tail`. Here the appending journal is a DIFFERENT object over
   * the same directory — a different `tail`, therefore no shared queue, which is
   * precisely the shape of two server processes sharing `.abapsmith/journal/A4H`.
   * The only thing that can order them is the file lock. Remove
   * `withIndexLock` from `append()` or from `prune()` and this test fails: A's
   * line lands in the inode B is about to unlink, and the entry — before-image
   * pointer included — ceases to exist with no error anywhere.
   */
  it("keeps an entry appended by another instance while a prune rewrites the index", async () => {
    // Seed through A so the index has something a prune will genuinely rewrite.
    const a = new Journal(cfg(tmp), "A4H");
    for (let i = 0; i < 4; i++) await begun(a, { beforeSource: `SOURCE ${i}\n` });

    // maxEntries 2 against 4 entries ⇒ drop 2, so pruneLocked() takes the
    // tmp+rename path rather than the cheap sweep-only one.
    const b = new Journal(cfg(tmp, { maxEntries: 2 }), "A4H");

    const LATE = "REPORT zmcp_late.\nWRITE: / 'the only copy'.\n";
    const events: string[] = [];
    let lockHeldAtRename: boolean | undefined;
    let fired = false;
    let appended: Promise<JournalEntry | undefined> = Promise.resolve(undefined);

    const realAppendFile = fs.appendFile;
    vi.spyOn(fs, "appendFile").mockImplementation(async (file, data, opts) => {
      events.push("append");
      return (realAppendFile as (...x: unknown[]) => Promise<void>)(file, data, opts);
    });

    const realRename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (!fired) {
        fired = true;
        // A whole new entry, not just a patch: on the unfixed code this is the
        // begin line AND the before-image pointer that vanishes.
        appended = a.begin(beginInput({ object: objectRef("ZMCP_LATE"), beforeSource: LATE }));
        // Park until A has both blobs on disk — its very next step is the
        // append — and then give it plenty of turns to reach the index lock and
        // be refused by it. Without the lock those turns are more than enough
        // for the append to land in the doomed inode.
        await waitUntil(
          async () => (await countBlobs(".before.txt")) === 5 && (await countBlobs(".after.txt")) === 5,
          "the concurrent begin() to write both of its blobs",
        );
        await settleEventLoop();
        lockHeldAtRename = existsSync(lockPath());
      }
      events.push("rename");
      return (realRename as (...x: unknown[]) => Promise<void>)(from, to);
    });

    await b.prune();
    const entry = await appended;
    expect(entry).toBeDefined();

    // Ordering evidence. The append was issued BEFORE the rename and completed
    // AFTER it, because the file lock B held made it wait. If the lock were not
    // there the two events would be the other way round and the assertions below
    // would be reading a line the rename had already destroyed.
    expect(lockHeldAtRename).toBe(true);
    expect(events).toEqual(["rename", "append"]);

    // The entry survived the rewrite, on disk and through both instances.
    const lines = await indexLines(tmp);
    expect(lines.some((l) => (JSON.parse(l) as JournalEntry).id === entry!.id)).toBe(true);
    expect(await a.get(entry!.id)).toBeDefined();
    expect((await b.get(entry!.id))!.object.name).toBe("ZMCP_LATE");

    // …and so did what undo actually needs: the bytes.
    expect(await new Journal(cfg(tmp), "A4H").beforeImage(entry!)).toBe(LATE);
  });
});

// ---------------------------------------------------------------------------
// Defect 2 — the swept live before-image  (item 2)
// ---------------------------------------------------------------------------

describe("the on-disk in-flight registry protects another instance's live write", () => {
  /**
   * This is the test that would fail against the old code. B's `inFlight`
   * is a different heap object from A's, so B's sweep has no in-memory way to
   * know that `<id>.before.txt` belongs to a `begin()` that has not appended its
   * index line yet — the blob is indistinguishable on disk from a crash orphan,
   * and the old rule unlinked it. `.inflight/<id>.<pid>` is what carries
   * that knowledge across the process boundary.
   */
  it("does not sweep a before-image whose begin() is parked in another instance", async () => {
    const a = new Journal(cfg(tmp), "A4H");
    const b = new Journal(cfg(tmp), "A4H");

    // One completed entry so prune() has an index to work on and does not bail
    // out early on an empty journal.
    const anchor = await begun(a, { object: objectRef("ZMCP_ANCHOR") });

    // Park A's begin() after the before-image and before the index append —
    // idiom and predicate from test/journal.test.ts:669-676.
    let release!: () => void;
    const parked = new Promise<void>((r) => (release = r));
    let parkedOnce = false;
    const realWriteFile = fs.writeFile;
    vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, opts) => {
      if (!parkedOnce && String(file).endsWith(".after.txt")) {
        parkedOnce = true;
        await parked;
      }
      return (realWriteFile as (...x: unknown[]) => Promise<void>)(file, data, opts);
    });

    const SECRET = "REPORT zmcp_demo.\nWRITE: / 'the only copy'.\n";
    const inFlight = a.begin(beginInput({ object: objectRef("ZMCP_LIVE"), beforeSource: SECRET }));
    await waitUntil(() => parkedOnce, "begin() to reach its after-image write");

    // The marker is published before the first blob byte, so by now it is there.
    const during = await listMarkers();
    expect(during).toHaveLength(1);
    expect(during[0]!.endsWith(`.${process.pid}`)).toBe(true);

    // The blob is real and on disk; the index still knows nothing about it.
    expect(await countBlobs(".before.txt")).toBe(2);
    expect(await indexLines(tmp)).toHaveLength(1);
    const liveBlob = (await fs.readdir(blobDir()))
      .filter((f) => f.endsWith(".before.txt"))
      .find((f) => !f.startsWith(anchor.id));
    expect(liveBlob).toBeDefined();

    // The OTHER instance sweeps. It must remove nothing.
    const res = await b.prune();
    expect(res.removedBlobs).toBe(0);
    expect(existsSync(path.join(blobDir(), liveBlob!))).toBe(true);

    release();
    const entry = await inFlight;
    expect(entry).toBeDefined();

    // The whole point: undo can still restore exactly what it promised, byte for
    // byte, read back through either instance.
    expect(await a.beforeImage(entry!)).toBe(SECRET);
    expect(await b.beforeImage((await b.get(entry!.id))!)).toBe(SECRET);

    // And the marker is retracted in the same `finally` as the in-memory set.
    expect(await listMarkers()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Marker reaping — a crashed process cannot protect a blob for ever
// ---------------------------------------------------------------------------

describe("in-flight markers are reaped, but only on proof", () => {
  /**
   * A marker whose owner died between `publishInFlight()` and its `finally`
   * would otherwise pin its blob for the life of the directory — a slow leak of
   * exactly the files retention exists to bound. Both halves of the proof are
   * required, so the two negative controls below matter as much as the positive
   * case: age alone would destroy the before-image of a slow live write, and a
   * dead pid alone is meaningless for a marker written by another host.
   */
  const ORPHAN = "20200101T000000000Z-dead01";
  const AGED = new Date(Date.now() - 30 * 60_000); // twice INFLIGHT_GRACE_MS

  /** Anchor entry + a hand-made orphan blob and its marker. */
  const seedOrphan = async (markerPid: number, mtime?: Date): Promise<string> => {
    const j = new Journal(cfg(tmp), "A4H");
    await begun(j, { object: objectRef("ZMCP_ANCHOR") });
    await fs.writeFile(path.join(blobDir(), `${ORPHAN}.before.txt`), "the orphan", "utf8");
    const marker = path.join(inFlightDir(), `${ORPHAN}.${markerPid}`);
    await fs.writeFile(marker, "", "utf8");
    if (mtime) await fs.utimes(marker, mtime, mtime);
    return marker;
  };

  it.skipIf(DEAD_PID === undefined)(
    "reaps an aged marker whose pid is dead and sweeps its blob in the SAME sweep",
    async () => {
      const marker = await seedOrphan(DEAD_PID!, AGED);
      const blob = path.join(blobDir(), `${ORPHAN}.before.txt`);

      const res = await new Journal(cfg(tmp), "A4H").prune();

      // Reaping happens before `registered` is computed, so the marker stops
      // protecting in the very sweep it is removed in — not one sweep later.
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(blob)).toBe(false);
      expect(res.removedBlobs).toBe(1);
    },
  );

  it.skipIf(DEAD_PID === undefined)(
    "keeps a YOUNG marker with a dead pid — a fork can outrun its own marker's mtime",
    async () => {
      const marker = await seedOrphan(DEAD_PID!); // mtime = now
      const blob = path.join(blobDir(), `${ORPHAN}.before.txt`);

      const res = await new Journal(cfg(tmp), "A4H").prune();

      expect(existsSync(marker)).toBe(true);
      expect(existsSync(blob)).toBe(true);
      expect(res.removedBlobs).toBe(0);
    },
  );

  it("keeps an AGED marker whose pid is ours — this process knows better than an mtime", async () => {
    const marker = await seedOrphan(process.pid, AGED);
    const blob = path.join(blobDir(), `${ORPHAN}.before.txt`);

    const res = await new Journal(cfg(tmp), "A4H").prune();

    expect(existsSync(marker)).toBe(true);
    expect(existsSync(blob)).toBe(true);
    expect(res.removedBlobs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Defect 4 — the shared prune temp path  (item 4)
// ---------------------------------------------------------------------------

describe("concurrent prunes do not collide on the rewrite temp path", () => {
  const seed = async (n: number): Promise<Journal> => {
    const j = new Journal(cfg(tmp), "A4H"); // cap 200: never self-prunes here
    for (let i = 0; i < n; i++) await begun(j, { beforeSource: `SOURCE ${i}\n` });
    return j;
  };

  it("two instances pruning at once both resolve, and leave a valid index and no .tmp", async () => {
    await seed(8);
    const a = new Journal(cfg(tmp, { maxEntries: 2 }), "A4H");
    const b = new Journal(cfg(tmp, { maxEntries: 2 }), "A4H");

    const temps: string[] = [];
    const realRename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      temps.push(String(from));
      return (realRename as (...x: unknown[]) => Promise<void>)(from, to);
    });

    // The old fixed `${indexPath}.tmp` produced ENOENT on the second rename —
    // the first prune had already renamed the shared file away. `Promise.all`
    // rejects on the first failure, so simply resolving is the assertion.
    const [ra, rb] = await Promise.all([a.prune(), b.prune()]);

    // 8 entries, cap 2: exactly 6 dropped in total. Not 12 (double-dropped) and
    // not 6-plus-a-lost-line.
    expect(ra.removedEntries + rb.removedEntries).toBe(6);

    const lines = await indexLines(tmp);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const rec = JSON.parse(line) as JournalEntry; // throws ⇒ the index is not valid JSONL
      expect(typeof rec.id).toBe("string");
    }

    expect((await fs.readdir(tmp)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(temps.length).toBeGreaterThanOrEqual(1);
    for (const t of temps) {
      expect(t.startsWith(`${path.join(tmp, "index.jsonl")}.`)).toBe(true);
      expect(t).toMatch(TMP_NAME_RE);
    }
  });

  it("mints a fresh pid-and-random temp name for every rewrite, never a fixed one", async () => {
    const writer = await seed(8);

    const temps: string[] = [];
    const realRename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      temps.push(String(from));
      return (realRename as (...x: unknown[]) => Promise<void>)(from, to);
    });

    const j = new Journal(cfg(tmp, { maxEntries: 2 }), "A4H");
    await j.prune();
    for (let i = 0; i < 3; i++) await begun(writer, { beforeSource: `MORE ${i}\n` });
    await j.prune();

    expect(temps).toHaveLength(2);
    // Uniqueness is the property. A pid alone would make these two equal, which
    // is the shape a prune killed between writeFile and rename leaves behind for
    // the next one to inherit.
    expect(temps[0]).not.toBe(temps[1]);
    expect(temps[0]).toMatch(TMP_NAME_RE);
    expect(temps[1]).toMatch(TMP_NAME_RE);
  });
});

// ---------------------------------------------------------------------------
// The new on-disk furniture must be invisible to everything that reads
// ---------------------------------------------------------------------------

describe("the lock file and the in-flight registry are invisible to the journal itself", () => {
  it("list() and get() ignore index.jsonl.lock and .inflight/", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const one = await begun(j, { object: objectRef("ZMCP_ONE") });
    const two = await begun(j, { object: objectRef("ZMCP_TWO") });

    // A lock held by somebody else, and a foreign process's marker. Neither is
    // an index line and neither is an entry.
    await fs.writeFile(
      lockPath(),
      JSON.stringify({ pid: 999_999, hostname: "elsewhere", startedAt: new Date().toISOString() }),
      "utf8",
    );
    await fs.mkdir(inFlightDir(), { recursive: true });
    await fs.writeFile(path.join(inFlightDir(), "20200101T000000000Z-aaaaaa.999999"), "", "utf8");

    // Reads take no lock, so this must not block and must not see the furniture.
    const ids = (await j.list()).map((e) => e.id).sort();
    expect(ids).toEqual([one.id, two.id].sort());
    expect(await j.get(one.id)).toBeDefined();
    expect(await new Journal(cfg(tmp), "A4H").list()).toHaveLength(2);
  });

  it("a sweep never destroys the .inflight registry directory", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    await begun(j);
    // A well-formed but unclaimed orphan, so the sweep really does delete
    // something on this run and is not vacuously leaving the directory alone.
    await fs.writeFile(path.join(blobDir(), "20200101T000000000Z-dead99.before.txt"), "x", "utf8");

    const res = await j.prune();
    expect(res.removedBlobs).toBe(1);
    expect(existsSync(inFlightDir())).toBe(true);
    // Beside the index, where `sweepBlobs()`'s `readdir` cannot even see it —
    // and NOT inside `blobs/`, which holds blobs and nothing else.
    expect(await fs.readdir(tmp)).toContain(".inflight");
    expect(await fs.readdir(blobDir())).not.toContain(".inflight");
  });

  /**
   * The invariant `blobs/` has always had to satisfy, pinned here where the
   * journal's own suite can see it break.
   *
   * test/transport-tools.test.ts:2005-2014 proves no journal blob can carry a
   * credential, cookie or CSRF token by reading EVERY entry of `blobs/` as
   * UTF-8. A subdirectory there — which is exactly where the in-flight
   * registry lives — fails that with `EISDIR` before it can inspect a single
   * byte, and no guard inside
   * `sweepBlobs()` can help, because the rule is about what a `readdir` of
   * `blobs/` may hand to ANYONE. This is the test that would have caught it.
   */
  it("leaves every entry in blobs/ a readable UTF-8 file, even mid-begin()", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    await begun(j, { object: objectRef("ZMCP_ANCHOR") });

    // Park a begin() between its blobs and its index line — the window in which
    // the registry is populated, so a marker is certainly on disk while we look.
    let release!: () => void;
    const parked = new Promise<void>((r) => (release = r));
    let parkedOnce = false;
    const realWriteFile = fs.writeFile;
    vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, opts) => {
      if (!parkedOnce && String(file).endsWith(".after.txt")) {
        parkedOnce = true;
        await parked;
      }
      return (realWriteFile as (...x: unknown[]) => Promise<void>)(file, data, opts);
    });

    const inFlight = j.begin(beginInput({ object: objectRef("ZMCP_LIVE") }));
    await waitUntil(() => parkedOnce, "begin() to reach its after-image write");

    // The invariant is checked BEFORE the marker precondition on purpose: if the
    // registry is ever moved back under `blobs/`, this loop is what has to fail,
    // and it cannot do that from behind an assertion about where markers live.
    const entries = await fs.readdir(blobDir());
    expect(entries.length).toBeGreaterThan(0);
    for (const f of entries) {
      expect((await fs.stat(path.join(blobDir(), f))).isFile(), f).toBe(true);
      // Byte for byte what test/transport-tools.test.ts does to each of them.
      expect(typeof (await fs.readFile(path.join(blobDir(), f), "utf8"))).toBe("string");
    }
    // …and a marker really was on disk throughout, so this was not vacuous.
    expect(await listMarkers()).toHaveLength(1);

    release();
    expect(await inFlight).toBeDefined();
    // And still true once the entry has landed and the marker is retracted.
    for (const f of await fs.readdir(blobDir())) {
      expect((await fs.stat(path.join(blobDir(), f))).isFile()).toBe(true);
    }
  });

  it("puts the lock beside index.jsonl, never inside blobs/", async () => {
    const writer = new Journal(cfg(tmp), "A4H");
    for (let i = 0; i < 4; i++) await begun(writer, { beforeSource: `SOURCE ${i}\n` });

    let lockSeenAtIndex: boolean | undefined;
    let blobsAtRename: string[] = [];
    const realRename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      // Mid-rewrite the lock is definitely held, so this is the one moment it is
      // guaranteed observable on disk.
      lockSeenAtIndex = existsSync(lockPath());
      blobsAtRename = await fs.readdir(blobDir());
      return (realRename as (...x: unknown[]) => Promise<void>)(from, to);
    });

    await new Journal(cfg(tmp, { maxEntries: 2 }), "A4H").prune();

    expect(lockSeenAtIndex).toBe(true);
    // Not in the one directory this class unlinks out of.
    expect(blobsAtRename.filter((f) => f.includes(".lock"))).toEqual([]);
    expect(existsSync(path.join(blobDir(), "index.jsonl.lock"))).toBe(false);
    // Released afterwards.
    expect(existsSync(lockPath())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A disabled journal still touches no disk
// ---------------------------------------------------------------------------

describe("disabled journal, with the lock in the picture", () => {
  /**
   * Mirrors test/journal.test.ts:980-1000, and it is not redundant: `prune()`
   * now reaches `withFileLock`, whose first act is `mkdir(dirname(lockPath),
   * { recursive: true })`. The `enabled` guard has to come STRICTLY before the
   * lock, or a journal that is switched off creates its own directory tree.
   */
  it("creates nothing at all, lock file and registry included", async () => {
    const dir = path.join(tmp, "never-created");
    const j = new Journal(cfg(dir, { enabled: false }), "A4H");

    expect(await j.begin(beginInput())).toBeUndefined();
    const madeUp = "20200101T000000000Z-abcdef";
    expect(await j.finish(madeUp, { outcome: "succeeded" })).toBeUndefined();
    expect(await j.prune()).toEqual({ removedEntries: 0, removedBlobs: 0 });
    expect(await j.list()).toEqual([]);

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(path.join(dir, "index.jsonl.lock"))).toBe(false);
    expect(existsSync(path.join(dir, ".inflight"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GENUINE cross-process: a crashed process must not deadlock the journal
// ---------------------------------------------------------------------------

/**
 * The one thing two `Journal` instances in one process cannot simulate: a
 * lockfile naming a pid that is REALLY not running any more. Everything above
 * shares `process.pid`, so `ownerIsGone()` can never fire for it.
 *
 * A real child takes the lock the same way `withFileLock` does — `open(…, "wx")`
 * plus the holder record — and then exits without releasing, which is exactly
 * what a killed MCP server leaves behind. `node:fs` only, no TS loader, no build
 * step, so this cannot go stale against the source tree.
 */
const CHILD_TAKES_LOCK = `
import { openSync, writeSync, closeSync } from "node:fs";
import { hostname } from "node:os";
const fd = openSync(process.env.LOCK_PATH, "wx");
writeSync(fd, JSON.stringify({
  pid: process.pid,
  hostname: hostname(),
  startedAt: new Date().toISOString(),
}));
closeSync(fd);
`;

describe("a crashed process cannot deadlock the journal", () => {
  it("breaks a lock abandoned by a real child process that exited without releasing", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const anchor = await begun(j, { object: objectRef("ZMCP_ANCHOR") });

    await execFileAsync(process.execPath, ["--input-type=module", "-e", CHILD_TAKES_LOCK], {
      env: { ...process.env, LOCK_PATH: lockPath() },
    });

    // The child really did hold it, and really is gone.
    expect(existsSync(lockPath())).toBe(true);
    const holder = JSON.parse(await fs.readFile(lockPath(), "utf8")) as {
      pid: number;
      hostname: string;
    };
    expect(holder.pid).not.toBe(process.pid);
    expect(holder.hostname).toBe(os.hostname());
    expect(() => process.kill(holder.pid, 0)).toThrowError(/ESRCH|kill ESRCH/);

    // Age the lock past `2 * waitMs` so the liveness rule is consulted — and
    // deliberately NOT past the 60 s hard-stale valve, so what breaks this lock
    // is the pid test on a genuinely foreign pid and nothing else.
    const aged = new Date(Date.now() - 1_000);
    await fs.utimes(lockPath(), aged, aged);

    const saved = process.env.ABAP_LOCK_WAIT_MS;
    process.env.ABAP_LOCK_WAIT_MS = "100";
    try {
      await expect(j.prune()).resolves.toEqual({ removedEntries: 0, removedBlobs: 0 });
    } finally {
      if (saved === undefined) delete process.env.ABAP_LOCK_WAIT_MS;
      else process.env.ABAP_LOCK_WAIT_MS = saved;
    }

    // The abandoned lock is gone and the journal is usable again.
    expect(existsSync(lockPath())).toBe(false);
    expect((await j.list()).map((e) => e.id)).toEqual([anchor.id]);
    const next = await begun(j, { object: objectRef("ZMCP_AFTER") });
    expect(await new Journal(cfg(tmp), "A4H").get(next.id)).toBeDefined();
  });
});
