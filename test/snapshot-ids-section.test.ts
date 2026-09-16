/**
 * `runSnapshotDiffs` (`src/tools/run.ts`) and `renderDataChangesSection`
 * (`src/snapshot-run.ts`) — the `DATA CHANGES` section that `abap_run`/
 * `abap_test`/`abap_bopf_test`/`abap_ui` append when a caller passes
 * `snapshot_ids`.
 *
 * Two layers:
 *
 *   1. `renderDataChangesSection` in isolation — a pure function over
 *      already-produced outcomes, no filesystem, no network.
 *   2. `runSnapshotDiffs` end to end — it builds its own `SnapshotRunDeps`
 *      internally (not injectable), so this drives it through a real
 *      `snapshot-store.ts` against a temp state dir (via `ABAP_STATE_DIR`,
 *      the only knob `runSnapshotDiffs` leaves for a caller to redirect
 *      storage) with `previewDdicEntity` mocked so no wire call can occur.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { previewDdicEntity, type PreviewResult } from "../src/adt/datapreview.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type { SessionPool } from "../src/adt/pool.js";
import { SafetyGate } from "../src/safety.js";
import { systemKey } from "../src/journal.js";
import { newSnapshotId, writeSnapshot, diffSnapshotRows, type StoredSnapshot } from "../src/snapshot-store.js";
import { renderDataChangesSection } from "../src/snapshot-run.js";
import { runSnapshotDiffs, type SnapshotDiffCapableDeps } from "../src/tools/run.js";

// `previewDdicEntity` is the network boundary `runSnapshotDiffs` reaches
// through `pool.withRead`. Mocked (same pattern as
// test/data-preview-snapshot-modes.test.ts) so nothing here ever touches a
// wire, and so the test controls exactly what each "after" read returns.
vi.mock("../src/adt/datapreview.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/adt/datapreview.js")>();
  return { ...actual, previewDdicEntity: vi.fn() };
});
const previewMock = vi.mocked(previewDdicEntity);

function previewResult(over: Partial<PreviewResult> = {}): PreviewResult {
  return {
    table: "T000",
    columns: [{ name: "MANDT", type: "C", length: 3, key: true }],
    rows: [["100"]],
    rowsRequested: 100,
    moreRowsExist: false,
    messages: [],
    ...over,
  };
}

// ===========================================================================
// Part 1: renderDataChangesSection — pure, no I/O
// ===========================================================================

function fakeSnapshot(over: Partial<StoredSnapshot> = {}): StoredSnapshot {
  return {
    version: 1,
    id: newSnapshotId(),
    systemKey: "SID|http://sap.invalid:50000|100",
    createdAt: new Date(Date.now() - 60_000).toISOString(), // anchored to the test clock: a fixed date expired once the calendar passed it
    expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    ttlHours: 24,
    selection: { table: "T000", max_rows: 10 },
    columns: [{ name: "MANDT", key: true }],
    rows: [["100"]],
    moreRowsExist: false,
    keyColumns: ["MANDT"],
    keyComplete: true,
    ...over,
  };
}

/** Builds a real `diffSnapshot`-shaped outcome from a real `diffSnapshotRows` call, without going through I/O. */
function diffOutcome(before: StoredSnapshot, afterRows: readonly (readonly string[])[]) {
  const diff = diffSnapshotRows(before, { columns: before.columns, rows: afterRows }, before.keyColumns);
  return {
    before,
    after: previewResult({ table: before.selection.table, rows: afterRows.map((r) => [...r]) }),
    diff,
    moreRowsExistBefore: before.moreRowsExist,
    moreRowsExistAfter: false,
  };
}

describe("renderDataChangesSection", () => {
  it("reports each successful diff, in the given order, with +insert -delete ~change counts", () => {
    const snapA = fakeSnapshot({ id: "snap_a", selection: { table: "T_A", max_rows: 10 } });
    const snapB = fakeSnapshot({ id: "snap_b", selection: { table: "T_B", max_rows: 10 } });

    const section = renderDataChangesSection([
      { id: "snap_a", outcome: diffOutcome(snapA, [["200"]]) }, // 100 deleted, 200 inserted
      { id: "snap_b", outcome: diffOutcome(snapB, [["100"]]) }, // unchanged
    ]);

    const lines = section.split("\n\n");
    expect(lines[0]).toContain("snapshot snap_a on T_A: +1 -1 ~0");
    expect(lines[1]).toContain("snapshot snap_b on T_B: +0 -0 ~0");
    // Order preserved: snap_a's block precedes snap_b's block.
    expect(section.indexOf("snap_a")).toBeLessThan(section.indexOf("snap_b"));
  });

  it("names the refusal reason for a diff that could not be produced", () => {
    const section = renderDataChangesSection([{ id: "snap_x", outcome: { refused: "NOT_FOUND: no such snapshot" } }]);
    expect(section).toBe("snapshot snap_x: refused — NOT_FOUND: no such snapshot");
  });

  it("mixes successful and refused outcomes in the given order", () => {
    const snapA = fakeSnapshot({ id: "snap_a", selection: { table: "T_A", max_rows: 10 } });
    const section = renderDataChangesSection([
      { id: "snap_a", outcome: diffOutcome(snapA, [["100"]]) },
      { id: "snap_z", outcome: { refused: "SNAPSHOT_EXPIRED: too old" } },
    ]);
    expect(section.indexOf("snap_a")).toBeLessThan(section.indexOf("snap_z"));
    expect(section).toContain("snapshot snap_z: refused — SNAPSHOT_EXPIRED: too old");
  });
});

// ===========================================================================
// Part 2: runSnapshotDiffs — end to end, real store, mocked network
// ===========================================================================

const CFG = {
  dataPreviewMaxRows: 100,
  dataSnapshotTtlHours: 24,
  sid: "SID",
  url: "http://sap.invalid:50000",
  client: "100",
};
const SYSTEM_KEY = systemKey(CFG);
const FAKE_CONN = {} as AbapConnection;

let tmpRoot: string;
let prevStateDir: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "abapsmith-snapshot-ids-"));
  prevStateDir = process.env.ABAP_STATE_DIR;
  // `runSnapshotDiffs` builds its own `SnapshotRunDeps` internally and never
  // exposes a `stateDir` knob, so `ABAP_STATE_DIR` is the only way to keep
  // its `readSnapshot`/`writeSnapshot` calls inside a temp directory instead
  // of the real project's `.abapsmith`.
  process.env.ABAP_STATE_DIR = tmpRoot;
});

afterEach(() => {
  if (prevStateDir === undefined) delete process.env.ABAP_STATE_DIR;
  else process.env.ABAP_STATE_DIR = prevStateDir;
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDeps(over: Partial<SnapshotDiffCapableDeps> = {}): SnapshotDiffCapableDeps {
  const pool = {
    withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(FAKE_CONN),
  } as unknown as SessionPool;
  return {
    pool,
    safety: new SafetyGate({ readOnly: true, allowPackages: [], writesLockedOut: false }),
    cfg: CFG,
    ...over,
  };
}

function storeSnapshot(over: Partial<StoredSnapshot> = {}): StoredSnapshot {
  const snap: StoredSnapshot = {
    version: 1,
    id: newSnapshotId(),
    systemKey: SYSTEM_KEY,
    createdAt: new Date(Date.now() - 60_000).toISOString(), // anchored to the test clock: a fixed date expired once the calendar passed it
    expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    ttlHours: 24,
    selection: { table: "T000", max_rows: 10 },
    columns: [{ name: "MANDT", key: true }],
    rows: [["100"]],
    moreRowsExist: false,
    keyColumns: ["MANDT"],
    keyComplete: true,
    ...over,
  };
  writeSnapshot(snap, { stateDir: tmpRoot });
  return snap;
}

describe("runSnapshotDiffs", () => {
  it("returns undefined for undefined ids, touching neither the pool nor the safety gate", async () => {
    const pool = { withRead: vi.fn() } as unknown as SessionPool;
    const safety = { assertDataPreview: vi.fn() } as unknown as SafetyGate;
    const audit = vi.fn();

    const result = await runSnapshotDiffs(makeDeps({ pool, safety }), undefined, audit);

    expect(result).toBeUndefined();
    expect((pool as unknown as { withRead: ReturnType<typeof vi.fn> }).withRead).not.toHaveBeenCalled();
    expect((safety as unknown as { assertDataPreview: ReturnType<typeof vi.fn> }).assertDataPreview).not.toHaveBeenCalled();
  });

  it("returns undefined for an empty ids array, touching neither the pool nor the safety gate", async () => {
    const pool = { withRead: vi.fn() } as unknown as SessionPool;
    const safety = { assertDataPreview: vi.fn() } as unknown as SafetyGate;
    const audit = vi.fn();

    const result = await runSnapshotDiffs(makeDeps({ pool, safety }), [], audit);

    expect(result).toBeUndefined();
    expect((pool as unknown as { withRead: ReturnType<typeof vi.fn> }).withRead).not.toHaveBeenCalled();
    expect((safety as unknown as { assertDataPreview: ReturnType<typeof vi.fn> }).assertDataPreview).not.toHaveBeenCalled();
  });

  it("diffs several ids sequentially, in the given order, and reports each", async () => {
    const snapA = storeSnapshot({ selection: { table: "T_A", max_rows: 10 }, rows: [["100"]] });
    const snapB = storeSnapshot({ selection: { table: "T_B", max_rows: 10 }, rows: [["200"]] });

    const callOrder: string[] = [];
    previewMock.mockImplementation(async (_conn, input) => {
      callOrder.push(input.table);
      // Both come back unchanged from their own recorded snapshot rows.
      const rows = input.table === "T_A" ? [["100"]] : [["200"]];
      return previewResult({ table: input.table, rows });
    });

    const audit = vi.fn();
    // Deliberately given in B-then-A order: the section and the underlying
    // reads must follow THIS order, not insertion order or any other.
    const section = await runSnapshotDiffs(makeDeps(), [snapB.id, snapA.id], audit);

    expect(callOrder).toEqual(["T_B", "T_A"]);
    expect(section).toBeDefined();
    const blocks = section!.split("\n\n");
    expect(blocks[0]).toContain(`snapshot ${snapB.id} on T_B: +0 -0 ~0`);
    expect(blocks[1]).toContain(`snapshot ${snapA.id} on T_A: +0 -0 ~0`);
  });

  it("emits one audit line per successful diff carrying counts, never row values", async () => {
    const snap = storeSnapshot({
      selection: { table: "T000", max_rows: 10 },
      rows: [["100", "SEKRIT-AUDIT-VALUE"]],
      columns: [
        { name: "MANDT", key: true },
        { name: "NAME", key: false },
      ],
      keyColumns: ["MANDT"],
      keyComplete: true,
    });
    previewMock.mockResolvedValue(
      previewResult({
        table: "T000",
        columns: [
          { name: "MANDT", type: "C", key: true },
          { name: "NAME", type: "C", key: false },
        ],
        rows: [["100", "SEKRIT-AUDIT-VALUE-CHANGED"]],
      }),
    );

    const audit = vi.fn();
    await runSnapshotDiffs(makeDeps(), [snap.id], audit);

    expect(audit).toHaveBeenCalledTimes(1);
    const message = audit.mock.calls[0]![0] as string;
    expect(message).toContain("inserted=0");
    expect(message).toContain("deleted=0");
    expect(message).toContain("changed=1");
    expect(message).toContain("table=T000");
    // Counts only — never a cell value.
    expect(message).not.toContain("SEKRIT-AUDIT-VALUE");
  });

  it("reports a diff that throws as a refused line naming the reason, and never throws itself", async () => {
    const unknownId = newSnapshotId(); // never written
    const audit = vi.fn();

    let result: string | undefined;
    await expect(
      (async () => {
        result = await runSnapshotDiffs(makeDeps(), [unknownId], audit);
      })(),
    ).resolves.not.toThrow();

    expect(result).toBeDefined();
    expect(result).toContain(`snapshot ${unknownId}: refused —`);
    expect(result).toContain("NOT_FOUND");
    // The failed id never reached a read, so no audit line for it.
    expect(audit).not.toHaveBeenCalled();
  });

  it("never throws even when one of several ids fails and another succeeds, and reports both", async () => {
    const okSnap = storeSnapshot({ selection: { table: "T_OK", max_rows: 10 }, rows: [["1"]] });
    const badId = newSnapshotId(); // never written
    previewMock.mockResolvedValue(previewResult({ table: "T_OK", rows: [["1"]] }));

    const audit = vi.fn();
    const section = await runSnapshotDiffs(makeDeps(), [okSnap.id, badId], audit);

    expect(section).toBeDefined();
    expect(section).toContain(`snapshot ${okSnap.id} on T_OK: +0 -0 ~0`);
    expect(section).toContain(`snapshot ${badId}: refused —`);
    expect(section).toContain("NOT_FOUND");
    expect(section!.indexOf(okSnap.id)).toBeLessThan(section!.indexOf(badId));
  });
});
