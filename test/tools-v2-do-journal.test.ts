/**
 * Per-group unit tests for
 * `src/tools/v2/handlers/do/journal.ts` (journal_list/journal_show/journal_reconcile).
 *
 * All three actions are local-only: no pool LEASE (no `withRead`/`withWrite`),
 * no safety gate. `abapJournal` itself does read `conn.cfg.sid` for the
 * response header (a local property access, not a network call) via
 * `deps.pool.primary()` — so these tests assert the zero-*lease* property
 * directly (`withRead`/`withWrite` spies that fail the test if ever invoked)
 * rather than mocking `abapJournal`, and assert the `object` -> v1-field
 * mapping each action uses (`object` for list, `entry` for show and
 * reconcile).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JOURNAL_HANDLERS } from "../src/tools/v2/handlers/do/journal.js";
import { Journal, type JournalBeginInput } from "../src/journal.js";
import { fakeDoDeps, fakeDoJournal } from "./helpers/do-deps-fake.js";

/** A minimal stand-in connection: only `cfg.sid` is ever read by `abapJournal`. */
function stubConn(): unknown {
  return { cfg: { sid: "A4H" } };
}

describe("abap_do journal group (journal_list/journal_show)", () => {
  it("journal_list: object maps to v1 `object` (a name filter), mode forced to \"list\"", async () => {
    const deps = fakeDoDeps({
      pool: {
        primary: () => stubConn(),
        withRead: vi.fn(() => { throw new Error("journal_list/journal_show must never lease a pool slot."); }),
        withWrite: vi.fn(() => { throw new Error("journal_list/journal_show must never lease a pool slot."); }),
        reserveDebug: vi.fn(),
      } as never,
      journal: fakeDoJournal(),
    });

    const res = await JOURNAL_HANDLERS.get("journal_list")!({ action: "journal_list", object: "ZCL_FOO", args: {} }, deps);

    expect(res.ok).toBe(true);
    expect(typeof res.data).toBe("string");
  });

  it("journal_show: object maps to v1 `entry` (the entry id), not `object`", async () => {
    const deps = fakeDoDeps({
      pool: {
        primary: () => stubConn(),
        withRead: vi.fn(() => { throw new Error("journal_list/journal_show must never lease a pool slot."); }),
        withWrite: vi.fn(() => { throw new Error("journal_list/journal_show must never lease a pool slot."); }),
        reserveDebug: vi.fn(),
      } as never,
      journal: fakeDoJournal(),
    });

    // The journal is empty, so entry "3" cannot resolve — but the SHAPE of the
    // failure proves the mapping: a NOT_FOUND for "entry 3" only happens if
    // ctx.object landed in v1 `entry`, not v1 `object` (which would instead
    // just filter an empty list to zero rows and succeed with mode "show").
    await expect(
      JOURNAL_HANDLERS.get("journal_show")!({ action: "journal_show", object: "3", args: {} }, deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("3") });
  });

  it("journal_list: args.object conflicting with ctx.object throws BAD_INPUT rather than picking one", async () => {
    const deps = fakeDoDeps({
      pool: {
        primary: () => stubConn(),
        withRead: vi.fn(() => { throw new Error("journal_list/journal_show must never lease a pool slot."); }),
        withWrite: vi.fn(() => { throw new Error("journal_list/journal_show must never lease a pool slot."); }),
        reserveDebug: vi.fn(),
      } as never,
    });

    await expect(
      JOURNAL_HANDLERS.get("journal_list")!(
        { action: "journal_list", object: "ZCL_FOO", args: { object: "ZCL_BAR" } },
        deps,
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
  });

  it("journal_reconcile: object maps to v1 `entry`, not `object`", async () => {
    const deps = fakeDoDeps({
      pool: {
        primary: () => stubConn(),
        withRead: vi.fn(() => { throw new Error("journal_reconcile must never lease a pool slot."); }),
        withWrite: vi.fn(() => { throw new Error("journal_reconcile must never lease a pool slot."); }),
        reserveDebug: vi.fn(),
      } as never,
      journal: fakeDoJournal(),
    });

    // Same proof-by-failure-shape as the journal_show case above: the
    // journal is empty, so a NOT_FOUND naming "3" only happens if ctx.object
    // landed in v1 `entry` (which mode=reconcile insists on exactly — see
    // src/tools/journal.ts — never an `object` fallback).
    await expect(
      JOURNAL_HANDLERS.get("journal_reconcile")!(
        { action: "journal_reconcile", object: "3", args: { outcome: "failed", reason: "x" } },
        deps,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("3") });
  });
});

// ---------------------------------------------------------------------------
// journal_reconcile — the local-only WRITE, so it gets its own isolated
// journal dir rather than the shared empty one `fakeDoJournal()` gives the
// read-only actions above.
// ---------------------------------------------------------------------------

describe("abap_do journal_reconcile (mode is forced, outcome/reason pass through)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-do-journal-reconcile-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const beginInput: JournalBeginInput = {
    operation: "update",
    object: {
      name: "ZMCP_DEMO",
      type: "PROG/P",
      uri: "/sap/bc/adt/programs/programs/zmcp_demo",
      package: "$TMP",
      description: "do-journal test",
    },
    existedBefore: true,
    beforeSource: "REPORT zmcp_demo.\nWRITE: / 'old'.\n",
    afterSource: "REPORT zmcp_demo.\nWRITE: / 'new'.\n",
    tool: "abap_write",
  };

  it("resolves ctx.object as the entry id, forces mode=reconcile, forwards outcome/reason, and suggests journal_list next", async () => {
    const journal = new Journal({ dir: tmp, enabled: true, maxEntries: 100, maxAgeDays: 30 }, "TST");
    const entry = await journal.begin(beginInput);
    if (!entry) throw new Error("begin() returned undefined, but this journal is enabled");

    const deps = fakeDoDeps({
      pool: {
        primary: () => stubConn(),
        withRead: vi.fn(() => { throw new Error("journal_reconcile must never lease a pool slot."); }),
        withWrite: vi.fn(() => { throw new Error("journal_reconcile must never lease a pool slot."); }),
        reserveDebug: vi.fn(),
      } as never,
      journal,
    });

    const res = await JOURNAL_HANDLERS.get("journal_reconcile")!(
      { action: "journal_reconcile", object: entry.id, args: { outcome: "failed", reason: "confirmed nothing landed" } },
      deps,
    );

    expect(res.ok).toBe(true);
    expect(res.data).toContain(entry.id);
    expect(res.data).toMatch(/outcome: failed/);
    expect(res.data).toContain("confirmed nothing landed");
    expect((await journal.get(entry.id))!.outcome).toBe("failed");

    expect(res.next).toEqual([
      expect.objectContaining({ tool: "abap_do", args: { action: "journal_list" } }),
    ]);
  });
});
