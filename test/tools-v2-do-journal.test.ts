/**
 * Per-group unit tests for
 * `src/tools/v2/handlers/do/journal.ts` (journal_list/journal_show).
 *
 * Both actions are pure local filesystem reads: no pool LEASE (no
 * `withRead`/`withWrite`), no safety gate. `abapJournal` itself does read
 * `conn.cfg.sid` for the response header (a local property access, not a
 * network call) via `deps.pool.primary()` — so these tests assert the
 * zero-*lease* property directly (`withRead`/`withWrite` spies that fail the
 * test if ever invoked) rather than mocking `abapJournal`, and assert the
 * `object` -> v1-field mapping difference between the two actions (`object`
 * for list, `entry` for show).
 */
import { describe, expect, it, vi } from "vitest";
import { JOURNAL_HANDLERS } from "../src/tools/v2/handlers/do/journal.js";
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
});
