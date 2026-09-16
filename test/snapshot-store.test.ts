/**
 * `src/snapshot-store.ts` — the on-disk store for `abap_data_preview`
 * snapshots (issue #117).
 *
 * Every test here uses a fresh `mkdtempSync` directory as `ABAP_STATE_DIR`
 * (passed explicitly as `opts.stateDir`, never via the environment) and
 * removes it afterwards. Nothing is ever written outside that directory.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AbapError, isAbapError } from "../src/adt/errors.js";
import type { PreviewFilter } from "../src/adt/datapreview-filter.js";
import {
  newSnapshotId,
  writeSnapshot,
  readSnapshot,
  listSnapshots,
  pruneSnapshots,
  snapshotsRoot,
  type StoredSnapshot,
} from "../src/snapshot-store.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "abapsmith-snapshot-store-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

// --------------------------------------------------------------- helpers ---

const FILTER: PreviewFilter = {
  where: [{ field: "MANDT", op: "eq", value: "100" }],
  columns: ["MANDT", "NAME"],
  orderBy: [{ field: "MANDT", direction: "asc" }],
  distinct: false,
};

function makeSnapshot(over: Partial<StoredSnapshot> = {}): StoredSnapshot {
  return {
    version: 1,
    id: newSnapshotId(),
    systemKey: "SID|http://sap.invalid:50000|100",
    createdAt: new Date(Date.now() - 60_000).toISOString(), // anchored to the test clock: a fixed date expired once the calendar passed it
    expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    ttlHours: 24,
    selection: { table: "T000", max_rows: 10, filter: FILTER },
    columns: [
      { name: "MANDT", key: true },
      { name: "NAME", key: false },
    ],
    rows: [["100", "SEKRIT-VALUE-42"]],
    moreRowsExist: false,
    keyColumns: ["MANDT"],
    keyComplete: true,
    ...over,
  };
}

/** Walks `snapshotsRoot(stateDir)` recursively and returns the full path of the one file named `${id}.json`, if any. */
function findSnapshotFile(dir: string, id: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      const found = findSnapshotFile(full, id);
      if (found) return found;
    } else if (name === `${id}.json`) {
      return full;
    }
  }
  return undefined;
}

function expectAbapError(fn: () => unknown, code: string): AbapError {
  try {
    fn();
  } catch (e) {
    expect(isAbapError(e)).toBe(true);
    expect((e as AbapError).code).toBe(code);
    return e as AbapError;
  }
  throw new Error("expected fn() to throw, but it did not");
}

// ------------------------------------------------------------------ tests ---

describe("newSnapshotId", () => {
  it("produces distinct ids on successive calls", () => {
    const a = newSnapshotId();
    const b = newSnapshotId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^snap_[0-9a-f]{32}$/);
    expect(b).toMatch(/^snap_[0-9a-f]{32}$/);
  });
});

describe("writeSnapshot / readSnapshot round trip", () => {
  it("round-trips rows, columns, the recorded selection (including the structured filter) and key columns intact", () => {
    const snap = makeSnapshot();
    writeSnapshot(snap, { stateDir });

    const back = readSnapshot(snap.id, snap.systemKey, { stateDir });

    expect(back.rows).toEqual(snap.rows);
    expect(back.columns).toEqual(snap.columns);
    expect(back.selection).toEqual(snap.selection);
    expect(back.selection.filter).toEqual(FILTER);
    expect(back.keyColumns).toEqual(snap.keyColumns);
    expect(back.keyComplete).toBe(snap.keyComplete);
    expect(back.id).toBe(snap.id);
    expect(back.systemKey).toBe(snap.systemKey);
  });
});

describe("file permissions", () => {
  it("writes the snapshot file at mode 0600", () => {
    if (process.platform === "win32") {
      // POSIX permission bits are not meaningful on Windows; there is
      // nothing this test could assert here that would not be vacuous.
      return;
    }
    const snap = makeSnapshot();
    writeSnapshot(snap, { stateDir });

    const filePath = findSnapshotFile(snapshotsRoot(stateDir), snap.id);
    expect(filePath).toBeDefined();
    const mode = statSync(filePath!).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("system-key isolation", () => {
  it("refuses to read a snapshot written under a different systemKey", () => {
    const snap = makeSnapshot({ systemKey: "SIDA|http://a.invalid:50000|100" });
    writeSnapshot(snap, { stateDir });

    // Readable under its own system.
    expect(readSnapshot(snap.id, snap.systemKey, { stateDir }).id).toBe(snap.id);

    // NOT readable under a different system — refused, not merely absent
    // from a listing.
    const err = expectAbapError(
      () => readSnapshot(snap.id, "SIDB|http://b.invalid:50000|200", { stateDir }),
      "NOT_FOUND",
    );
    // The message must never leak which system actually holds the snapshot.
    expect(err.message).not.toContain("SIDA");
    expect(err.message).not.toContain("a.invalid");
  });

  it("excludes a foreign-system snapshot from listSnapshots", () => {
    const snap = makeSnapshot({ systemKey: "SIDA|http://a.invalid:50000|100" });
    writeSnapshot(snap, { stateDir });

    expect(listSnapshots("SIDB|http://b.invalid:50000|200", { stateDir })).toEqual([]);
    expect(listSnapshots(snap.systemKey, { stateDir }).map((s) => s.id)).toEqual([snap.id]);
  });
});

describe("TTL", () => {
  const t0 = Date.parse("2026-09-15T00:00:00.000Z");

  // `readSnapshot` settles the REQUESTED snapshot's own fate before the
  // housekeeping prune sweep ever touches the directory (src/snapshot-store.ts).
  // A snapshot past its TTL is therefore refused with SNAPSHOT_EXPIRED, not
  // NOT_FOUND — distinguishably from an id that never existed, so the
  // caller learns "this aged out" (take a fresh snapshot) rather than
  // "no such snapshot" (check the id) — and the expired file is still
  // deleted from disk as part of that refusal.
  it("refuses a snapshot past its TTL with SNAPSHOT_EXPIRED, and deletes the file", () => {
    const snap = makeSnapshot({
      createdAt: new Date(t0).toISOString(),
      expiresAt: new Date(t0 + 1_000).toISOString(),
      ttlHours: 1,
    });
    writeSnapshot(snap, { stateDir, now: new Date(t0) });

    // Past expiry: refused as expired, not as merely absent.
    expectAbapError(
      () => readSnapshot(snap.id, snap.systemKey, { stateDir, now: new Date(t0 + 2_000) }),
      "SNAPSHOT_EXPIRED",
    );

    // ...and the file is gone afterwards.
    expect(findSnapshotFile(snapshotsRoot(stateDir), snap.id)).toBeUndefined();
  });

  it("refuses an id that was never written with NOT_FOUND, distinct from an expired one", () => {
    expectAbapError(
      () => readSnapshot(newSnapshotId(), "SID|http://x.invalid:1|100", { stateDir, now: new Date(t0) }),
      "NOT_FOUND",
    );
  });

  it("pruneSnapshots removes an expired snapshot and reports the count", () => {
    const snap = makeSnapshot({
      createdAt: new Date(t0).toISOString(),
      expiresAt: new Date(t0 + 1_000).toISOString(),
      ttlHours: 1,
    });
    writeSnapshot(snap, { stateDir, now: new Date(t0) });

    const removed = pruneSnapshots(snap.systemKey, { stateDir, now: new Date(t0 + 2_000) });
    expect(removed).toBe(1);
    expect(findSnapshotFile(snapshotsRoot(stateDir), snap.id)).toBeUndefined();
  });

  it("a snapshot inside its TTL survives a prune and remains readable", () => {
    const snap = makeSnapshot({
      createdAt: new Date(t0).toISOString(),
      expiresAt: new Date(t0 + 100_000).toISOString(),
      ttlHours: 24,
    });
    writeSnapshot(snap, { stateDir, now: new Date(t0) });

    const removed = pruneSnapshots(snap.systemKey, { stateDir, now: new Date(t0 + 1_000) });
    expect(removed).toBe(0);

    const back = readSnapshot(snap.id, snap.systemKey, { stateDir, now: new Date(t0 + 1_000) });
    expect(back.id).toBe(snap.id);
  });
});

describe("unknown id", () => {
  it("refuses an id that was never written, with the code the source actually uses", () => {
    // readSnapshot's own source (`snapshotNotFound`) mints "NOT_FOUND" for
    // both "no such file" and "wrong system" — read, not guessed.
    expectAbapError(() => readSnapshot(newSnapshotId(), "SID|http://x.invalid:1|100", { stateDir }), "NOT_FOUND");
  });
});

describe("storage location", () => {
  it("never writes the snapshot id or any row value under the state dir's journal directory", () => {
    // Simulate a pre-existing journal directory sitting alongside the
    // snapshot store, the way a real `Journal` instance would leave one:
    // `<stateDir>/journal/<SID>/index.jsonl` plus a `blobs/` subdirectory.
    const journalDir = join(stateDir, "journal", "SID");
    mkdirSync(join(journalDir, "blobs"), { recursive: true });
    writeFileSync(join(journalDir, "index.jsonl"), "");
    writeFileSync(join(journalDir, "blobs", ".keep"), "");

    const snap = makeSnapshot({ rows: [["100", "SEKRIT-VALUE-42"]] });
    writeSnapshot(snap, { stateDir });

    // Belt-and-braces: the snapshot really did get written somewhere under
    // this state dir (otherwise the assertion below would be vacuous).
    expect(findSnapshotFile(snapshotsRoot(stateDir), snap.id)).toBeDefined();

    // Walk the whole journal subtree and grep every file for the snapshot
    // id and the distinctive row value — neither may appear anywhere in it.
    const journalRoot = join(stateDir, "journal");
    const contents: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else contents.push(readFileSync(full, "utf8"));
      }
    };
    walk(journalRoot);
    const blob = contents.join("\n");
    expect(blob).not.toContain(snap.id);
    expect(blob).not.toContain("SEKRIT-VALUE-42");
  });
});
