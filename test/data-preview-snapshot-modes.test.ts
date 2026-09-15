/**
 * `mode: "snapshot"` / `mode: "diff"` for `abap_data_preview` (issue #117).
 *
 * Two layers, tested separately:
 *
 *   1. `takeSnapshot`/`diffSnapshot` (`src/snapshot-run.ts`) against a FAKE
 *      `SnapshotRunDeps` — no network, no live system, `read` is a plain
 *      function under test control. Storage still goes through the real
 *      `snapshot-store.ts` against a temp `stateDir`.
 *   2. The tool-level argument cross-checks and the "mode omitted behaves
 *      like mode: preview" guarantee in `src/tools/data-preview.ts`, via a
 *      capturing fake `McpServer` (same pattern as
 *      `test/data-preview-gates.test.ts`) with `previewDdicEntity` mocked so
 *      no wire call can occur.
 *
 * Does not duplicate `test/data-preview.test.ts` (wire parsing) or
 * `test/data-preview-gates.test.ts` (the three preview gates) — this file is
 * only about the two new modes and their interaction with the existing one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { AbapError } from "../src/adt/errors.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type { SessionPool } from "../src/adt/pool.js";
import { previewDdicEntity, type PreviewResult } from "../src/adt/datapreview.js";
import type { PreviewFilter } from "../src/adt/datapreview-filter.js";
import { SafetyGate } from "../src/safety.js";
import { errorResult } from "../src/tool-errors.js";
import { takeSnapshot, diffSnapshot, type SnapshotRunDeps } from "../src/snapshot-run.js";
import { registerDataPreviewTools, type DataPreviewToolDeps } from "../src/tools/data-preview.js";

// `previewDdicEntity` is the network. Mocked (same pattern as
// test/data-preview-gates.test.ts) so the tool-level tests below can control
// exactly what a read returns, with no wire ever touched.
vi.mock("../src/adt/datapreview.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/adt/datapreview.js")>();
  return { ...actual, previewDdicEntity: vi.fn() };
});
const previewMock = vi.mocked(previewDdicEntity);

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

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

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "abapsmith-snapshot-modes-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ===========================================================================
// Part 1: takeSnapshot / diffSnapshot against a fake SnapshotRunDeps
// ===========================================================================

function baseDeps(over: Partial<SnapshotRunDeps> = {}): SnapshotRunDeps {
  return {
    read: vi.fn(async (table: string) => previewResult({ table })),
    assertDataPreview: vi.fn(() => {}),
    systemKey: "SID|http://sap.invalid:50000|100",
    maxRows: 100,
    ttlCeilingHours: 24,
    stateDir: tmpRoot,
    now: () => new Date("2026-09-15T00:00:00.000Z"),
    ...over,
  };
}

describe("takeSnapshot", () => {
  it("runs assertDataPreview BEFORE the read: a refusal costs zero reads", async () => {
    const read = vi.fn();
    const assertDataPreview = vi.fn(() => {
      throw new AbapError("SAFETY_DENIED", "denied", {}, undefined);
    });
    const deps = baseDeps({ read, assertDataPreview });

    await expect(takeSnapshot(deps, { table: "T000", maxRowsRequested: 10 })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it("clamps maxRowsRequested down to deps.maxRows, and the clamp is reflected in selection.max_rows", async () => {
    const read = vi.fn(async (table: string, maxRows: number) => previewResult({ table, rowsRequested: maxRows }));
    const deps = baseDeps({ maxRows: 5, read });

    const { snapshot } = await takeSnapshot(deps, { table: "T000", maxRowsRequested: 100 });

    expect(read).toHaveBeenCalledWith("T000", 5, undefined);
    expect(snapshot.selection.max_rows).toBe(5);
    expect(snapshot.selection.max_rows).toBeLessThan(100);
  });

  it("clamps ttl_hours DOWN when the request exceeds deps.ttlCeilingHours, and flags the clamp", async () => {
    const deps = baseDeps({ ttlCeilingHours: 10 });

    const { snapshot, ttlClamped } = await takeSnapshot(deps, {
      table: "T000",
      maxRowsRequested: 10,
      ttlHours: 50,
    });

    expect(ttlClamped).toBe(true);
    expect(snapshot.ttlHours).toBe(10);
  });

  it("honours ttl_hours unchanged when it is below deps.ttlCeilingHours", async () => {
    const deps = baseDeps({ ttlCeilingHours: 100 });

    const { snapshot, ttlClamped } = await takeSnapshot(deps, {
      table: "T000",
      maxRowsRequested: 10,
      ttlHours: 5,
    });

    expect(ttlClamped).toBe(false);
    expect(snapshot.ttlHours).toBe(5);
  });

  it("keyComplete follows the key-flagged columns when no projection was given", async () => {
    const read = vi.fn(async () =>
      previewResult({
        columns: [
          { name: "MANDT", type: "C", key: true },
          { name: "NAME", type: "C", key: false },
        ],
      }),
    );
    const deps = baseDeps({ read });

    const { snapshot } = await takeSnapshot(deps, { table: "T000", maxRowsRequested: 10 });

    expect(snapshot.keyComplete).toBe(true);
    expect(snapshot.keyColumns).toEqual(["MANDT"]);
  });

  it("keyComplete is false unconditionally when a columns projection was given, even one covering the full key", async () => {
    const read = vi.fn(async () => previewResult({ columns: [{ name: "MANDT", type: "C", key: true }] }));
    const deps = baseDeps({ read });

    const { snapshot } = await takeSnapshot(deps, {
      table: "T000",
      maxRowsRequested: 10,
      filter: { columns: ["MANDT"] },
    });

    // Read src/snapshot-run.ts's `takeSnapshot`: the `hasProjection` branch
    // sets `keyComplete: false` unconditionally — the response alone cannot
    // prove the projection covers the whole key, so it never guesses "yes".
    expect(snapshot.keyComplete).toBe(false);
    expect(snapshot.keyColumns).toEqual(["MANDT"]);
  });
});

describe("diffSnapshot", () => {
  it("calls assertDataPreview AGAIN before the re-read: a table denied between snapshot and diff is still refused", async () => {
    let calls = 0;
    const assertDataPreview = vi.fn(() => {
      calls += 1;
      if (calls === 2) throw new AbapError("SAFETY_DENIED", "now denied", {}, undefined);
    });
    const read = vi.fn(async (table: string, maxRows: number) => previewResult({ table, rowsRequested: maxRows }));
    const deps = baseDeps({ assertDataPreview, read });

    const { snapshot } = await takeSnapshot(deps, { table: "T000", maxRowsRequested: 10 });
    read.mockClear();

    await expect(diffSnapshot(deps, snapshot.id)).rejects.toThrow(/now denied/);
    expect(read).not.toHaveBeenCalled();
    expect(assertDataPreview).toHaveBeenCalledTimes(2);
  });

  it("replays the snapshot's own recorded selection (table, clamped max_rows, filter) rather than anything fresh", async () => {
    const filter: PreviewFilter = { where: [{ field: "MANDT", op: "eq", value: "100" }] };
    const read = vi.fn(async (table: string, maxRows: number) => previewResult({ table, rowsRequested: maxRows }));
    const deps = baseDeps({ maxRows: 50, read });

    const { snapshot } = await takeSnapshot(deps, { table: "T000", maxRowsRequested: 10, filter });
    read.mockClear();

    await diffSnapshot(deps, snapshot.id);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(snapshot.selection.table, snapshot.selection.max_rows, snapshot.selection.filter);
    expect(snapshot.selection.max_rows).toBe(10);
    expect(snapshot.selection.filter).toEqual(filter);
  });
});

// ===========================================================================
// Part 2: tool-level argument cross-checks and the "mode omitted" guarantee
// ===========================================================================

function fakeMcp(): {
  mcp: McpServer;
  tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>;
} {
  const tools = new Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>();
  const mcp = {
    registerTool: (name: string, _config: Record<string, unknown>, handler: (args: unknown) => Promise<CallToolResult>) => {
      tools.set(name, { handler });
      return {} as unknown;
    },
  } as unknown as McpServer;
  return { mcp, tools };
}

const FAKE_CONN = {} as AbapConnection;

function toolHarness(opts: { ensureConnected?: () => Promise<void> } = {}): {
  invoke: (args: unknown) => Promise<CallToolResult>;
  ensureConnected: ReturnType<typeof vi.fn>;
  withReadCalls: string[];
} {
  const withReadCalls: string[] = [];
  const pool = {
    withRead: <T,>(op: string, fn: (c: AbapConnection) => Promise<T>) => {
      withReadCalls.push(op);
      return fn(FAKE_CONN);
    },
  } as unknown as SessionPool;

  const ensureConnected = vi.fn(opts.ensureConnected ?? (async () => {}));

  const deps: DataPreviewToolDeps = {
    pool,
    safety: new SafetyGate({ readOnly: true, allowPackages: [], writesLockedOut: false }),
    ensureConnected,
    errorResult,
    cfg: {
      maxResponseChars: 60_000,
      dataPreviewMaxRows: 100,
      dataSnapshotTtlHours: 24,
      sid: "TST",
      url: "http://sap.invalid:50000",
      client: "001",
    },
  };

  const { mcp, tools } = fakeMcp();
  registerDataPreviewTools(mcp, deps);
  const entry = tools.get("abap_data_preview");
  if (!entry) throw new Error("abap_data_preview was never registered");
  return { invoke: entry.handler, ensureConnected, withReadCalls };
}

interface BadInputPayload {
  error: string;
  message: string;
}

function parseErrorPayload(res: CallToolResult): BadInputPayload {
  expect(res.isError).toBe(true);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as BadInputPayload;
}

describe("argument cross-checks — all BAD_INPUT, all refused before any connection is opened", () => {
  it("refuses snapshot_id with a non-diff mode", async () => {
    const { invoke, ensureConnected } = toolHarness();
    const res = await invoke({ table: "T000", mode: "preview", snapshot_id: "snap_x" });
    const payload = parseErrorPayload(res);
    expect(payload.error).toBe("BAD_INPUT");
    expect(payload.message).toContain('snapshot_id is only used with mode: "diff"');
    expect(ensureConnected).not.toHaveBeenCalled();
  });

  it("refuses ttl_hours with a non-snapshot mode", async () => {
    const { invoke, ensureConnected } = toolHarness();
    const res = await invoke({ table: "T000", mode: "preview", ttl_hours: 5 });
    const payload = parseErrorPayload(res);
    expect(payload.error).toBe("BAD_INPUT");
    expect(payload.message).toContain('ttl_hours is only used with mode: "snapshot"');
    expect(ensureConnected).not.toHaveBeenCalled();
  });

  it("refuses a non-integer ttl_hours", async () => {
    const { invoke, ensureConnected } = toolHarness();
    const res = await invoke({ table: "T000", mode: "snapshot", ttl_hours: 1.5 });
    const payload = parseErrorPayload(res);
    expect(payload.error).toBe("BAD_INPUT");
    expect(payload.message).toContain("ttl_hours must be a whole number of at least 1");
    expect(ensureConnected).not.toHaveBeenCalled();
  });

  it("refuses a ttl_hours below 1", async () => {
    const { invoke, ensureConnected } = toolHarness();
    const res = await invoke({ table: "T000", mode: "snapshot", ttl_hours: 0 });
    const payload = parseErrorPayload(res);
    expect(payload.error).toBe("BAD_INPUT");
    expect(payload.message).toContain("ttl_hours must be a whole number of at least 1");
    expect(ensureConnected).not.toHaveBeenCalled();
  });

  it('refuses mode: "diff" without snapshot_id', async () => {
    const { invoke, ensureConnected } = toolHarness();
    const res = await invoke({ mode: "diff" });
    const payload = parseErrorPayload(res);
    expect(payload.error).toBe("BAD_INPUT");
    expect(payload.message).toBe('mode: "diff" requires snapshot_id.');
    expect(ensureConnected).not.toHaveBeenCalled();
  });

  // Exactly DIFF_FORBIDDEN_KEYS from src/tools/data-preview.ts, read from
  // the source rather than guessed.
  const FORBIDDEN: Record<string, unknown> = {
    table: "T000",
    object: "T000",
    where: [{ field: "MANDT", op: "eq", value: "100" }],
    columns: ["MANDT"],
    order_by: [{ field: "MANDT" }],
    distinct: true,
    max_rows: 10,
  };

  for (const [key, value] of Object.entries(FORBIDDEN)) {
    it(`refuses mode: "diff" given the forbidden selection key "${key}"`, async () => {
      const { invoke, ensureConnected } = toolHarness();
      const res = await invoke({ mode: "diff", snapshot_id: "snap_x", [key]: value });
      const payload = parseErrorPayload(res);
      expect(payload.error).toBe("BAD_INPUT");
      expect(payload.message).toContain("cannot also be given");
      expect(payload.message).toContain(key);
      expect(ensureConnected).not.toHaveBeenCalled();
    });
  }
});

describe("mode omitted vs mode: \"preview\" — byte-identical", () => {
  it("neither writes a snapshot file nor changes the rendered text", async () => {
    // Guard against ANY accidental filesystem write escaping this test: if
    // something on the preview path ever called resolveStateDir() (it must
    // not — mode: "preview" never touches snapshot-run.ts at all), it would
    // resolve against this mocked cwd, not the real project directory.
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
    try {
      previewMock.mockResolvedValue(previewResult());

      const omitted = await toolHarness().invoke({ table: "T000" });
      const explicit = await toolHarness().invoke({ table: "T000", mode: "preview" });

      expect(omitted.isError).toBeFalsy();
      expect((omitted.content[0] as { text: string }).text).toBe((explicit.content[0] as { text: string }).text);
      expect(existsSync(join(tmpRoot, ".abapsmith", "snapshots"))).toBe(false);
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
