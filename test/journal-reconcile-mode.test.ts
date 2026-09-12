/**
 * `Journal.reconcile()` and `abap_journal mode=reconcile`.
 *
 * Every other terminal outcome a journal entry ever carries comes from
 * abapsmith itself watching a write happen (`begin()` then `finish()`/
 * `settle()`). `reconcile()` is the ONE path by which a `pending` entry
 * becomes terminal WITHOUT abapsmith having observed anything — a human
 * states what happened, from outside, after the fact (typically because a
 * crash or a dropped connection left the entry stranded). Getting this
 * wrong is expensive in both directions: refuse it, and a stranded entry
 * can never be closed or undone; let it silently overwrite an OBSERVED
 * outcome, and the one fact the entry actually carries is destroyed. So
 * these tests pin, in order:
 *
 *  - The write itself: append-only (nothing is rewritten or deleted), the
 *    asserted outcome/reason land verbatim, and provenance (`reconciled`)
 *    always says WHO and WHY, distinguishing a stated finding from an
 *    observed one.
 *  - The refusals: unknown id, already-settled (never overwrite an
 *    observed outcome), disabled journal, malformed input.
 *  - The tool surface (`abap_journal mode=reconcile`): the same refusals
 *    again as MCP-boundary errors, PLUS the deliberate absence of the
 *    `object` fallback every other mode offers — reconcile insists on the
 *    exact entry id because guessing which stranded entry was meant would
 *    write a false outcome into the audit trail. And zero network calls,
 *    always: this is a purely local operation, same as list/show.
 *  - `list`/`show` surfacing: the STRANDED note in mode=list telling an
 *    operator how to close an entry, and the `reconciled` flag/header/note
 *    once one has been.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AbapConnection } from "../src/adt/connection.js";
import { isAbapError } from "../src/adt/errors.js";
import { abapJournal } from "../src/tools/journal.js";
import {
  Journal,
  STALE_PENDING_MS,
  type JournalBeginInput,
  type JournalConfig,
  type JournalEntry,
  type JournalObjectRef,
  type JournalReconcileInput,
} from "../src/journal.js";

// ---------------------------------------------------------------------------
// Fixtures — same idioms as test/journal.test.ts / test/journal-actor.test.ts
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-journal-reconcile-"));
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
  description: "journal test",
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

const begun = async (j: Journal, over: Partial<JournalBeginInput> = {}): Promise<JournalEntry> => {
  const entry = await j.begin(beginInput(over));
  if (!entry) throw new Error("begin() returned undefined, but this journal is enabled");
  return entry;
};

const indexLines = async (dir: string): Promise<string[]> =>
  (await fs.readFile(path.join(dir, "index.jsonl"), "utf8")).split("\n").filter((l) => l.trim());

/** `mode=list`/`mode=show` only ever read `conn.cfg.sid` — same fake as test/journal-actor.test.ts. */
const fakeConn = { cfg: { sid: "A4H" } } as unknown as AbapConnection;

/**
 * A connection that throws (and counts) on ANY property access beyond
 * `cfg` — proof, not assertion, that `mode=reconcile` never reaches for the
 * network. Kept separate from `fakeConn` above so a real bug (some code
 * path reading `conn.http` or similar) fails loudly instead of silently
 * returning `undefined`.
 */
function networkGuardedConn(): { conn: AbapConnection; calls: () => number } {
  let calls = 0;
  const conn = new Proxy(
    { cfg: { sid: "A4H" } },
    {
      get(target, prop) {
        if (prop === "cfg") return target.cfg;
        calls++;
        throw new Error(`mode=reconcile touched AbapConnection.${String(prop)} — it must stay local-only`);
      },
    },
  ) as unknown as AbapConnection;
  return { conn, calls: () => calls };
}

/** Backdate an entry's `ts` the way the journal itself would — by appending a patch (see test/journal.test.ts). */
const backdate = async (dir: string, id: string, ts: string): Promise<void> =>
  fs.appendFile(path.join(dir, "index.jsonl"), JSON.stringify({ id, ts }) + "\n", "utf8");

const catchErr = async (p: Promise<unknown>): Promise<import("../src/adt/errors.js").AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as import("../src/adt/errors.js").AbapError;
};

// ===========================================================================
// Part A — Journal.reconcile() directly
// ===========================================================================

describe("Journal.reconcile()", () => {
  it("closes a pending entry as failed: outcome, error, and reconciled.reason/at all land", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);

    const before = new Date();
    const res = await j.reconcile(entry.id, { outcome: "failed", reason: "  checked SE38 by hand: source unchanged  " });
    expect(res).toMatchObject({ reconciled: true });
    if (!res.reconciled) throw new Error("unreachable");

    expect(res.entry.outcome).toBe("failed");
    // A reconciled failure's `error` doubles as the stated reason — that is
    // the only evidence this entry will ever carry for its outcome.
    expect(res.entry.error).toBe("checked SE38 by hand: source unchanged");
    expect(res.entry.reconciled).toBeDefined();
    // Trimmed, not verbatim-with-whitespace.
    expect(res.entry.reconciled!.reason).toBe("checked SE38 by hand: source unchanged");
    expect(new Date(res.entry.reconciled!.at).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(Number.isNaN(new Date(res.entry.reconciled!.at).getTime())).toBe(false);

    // A fresh reader sees the same thing.
    const reread = await new Journal(cfg(tmp), "A4H").get(entry.id);
    expect(reread!.outcome).toBe("failed");
    expect(reread!.reconciled!.reason).toBe("checked SE38 by hand: source unchanged");
  });

  it("closes a pending entry as succeeded: outcome lands, but error is NOT set from the reason", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);

    const res = await j.reconcile(entry.id, { outcome: "succeeded", reason: "confirmed via abap_read afterwards" });
    expect(res).toMatchObject({ reconciled: true });
    if (!res.reconciled) throw new Error("unreachable");

    expect(res.entry.outcome).toBe("succeeded");
    // `error` is what went wrong — nothing did, so it stays unset even
    // though a reason was recorded (in `reconciled.reason`, not `error`).
    expect(res.entry.error).toBeUndefined();
    expect(res.entry.reconciled!.reason).toBe("confirmed via abap_read afterwards");
  });

  it("records reconciled.by from the resolved actor when one is configured", async () => {
    const j = new Journal(cfg(tmp, { actor: "qa-reviewer" }), "A4H");
    const entry = await begun(j);
    const res = await j.reconcile(entry.id, { outcome: "succeeded", reason: "verified" });
    expect(res.reconciled).toBe(true);
    if (!res.reconciled) throw new Error("unreachable");
    expect(res.entry.reconciled!.by).toBe("qa-reviewer");
  });

  it("omits reconciled.by entirely — never a placeholder — when no actor resolves", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);
    const res = await j.reconcile(entry.id, { outcome: "succeeded", reason: "verified" });
    expect(res.reconciled).toBe(true);
    if (!res.reconciled) throw new Error("unreachable");
    // Not `by: undefined` either — the KEY itself must be absent, same rule
    // JournalEntry.actor follows (see test/journal-actor.test.ts).
    expect("by" in res.entry.reconciled!).toBe(false);
  });

  it("refuses to overwrite an entry that already settled for real — the observed outcome wins", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);
    await j.finish(entry.id, { outcome: "succeeded" });
    const settled = await j.get(entry.id);

    const res = await j.reconcile(entry.id, { outcome: "failed", reason: "trying to overwrite it" });
    expect(res).toEqual({ reconciled: false, reason: "already-settled", entry: settled });

    // Unchanged: no reconciled field, outcome still what finish() recorded.
    const reread = await j.get(entry.id);
    expect(reread!.outcome).toBe("succeeded");
    expect(reread!.reconciled).toBeUndefined();
  });

  it("returns unknown-entry for an id that was never begun", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const res = await j.reconcile("20200101T000000000Z-abcdef", { outcome: "succeeded", reason: "n/a" });
    expect(res).toEqual({ reconciled: false, reason: "unknown-entry" });
  });

  it("throws BAD_INPUT for an empty or whitespace-only reason", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);
    await expect(j.reconcile(entry.id, { outcome: "succeeded", reason: "" })).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
    await expect(j.reconcile(entry.id, { outcome: "succeeded", reason: "   " })).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
    // Refused before anything is written.
    expect(await indexLines(tmp)).toHaveLength(1);
  });

  it("throws BAD_INPUT for an outcome other than succeeded/failed", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);
    // `outcome` is a closed union at the TypeScript boundary, but callers
    // reaching this through the MCP tool surface (Part B) are unchecked
    // strings by the time zod hands them off — cast here to exercise the
    // runtime guard the same way a bad MCP call would.
    const bad = { outcome: "pending", reason: "x" } as unknown as JournalReconcileInput;
    await expect(j.reconcile(entry.id, bad)).rejects.toMatchObject({ code: "BAD_INPUT" });
  });

  it("returns disabled for a disabled journal, without needing a real entry", async () => {
    const j = new Journal(cfg(tmp, { enabled: false }), "A4H");
    const res = await j.reconcile("20200101T000000000Z-abcdef", { outcome: "succeeded", reason: "n/a" });
    expect(res).toEqual({ reconciled: false, reason: "disabled" });
  });

  it("append-only: the original pending line and its before-image blob are still on disk after reconciling", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);
    const blobPath = path.join(tmp, "blobs", entry.before!.blob!);
    expect(await fs.readFile(blobPath, "utf8")).toBe(beginInput().beforeSource);

    await j.reconcile(entry.id, { outcome: "failed", reason: "gone" });

    // Two lines now: the original `pending` one, verbatim, plus the patch.
    const lines = await indexLines(tmp);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: entry.id, outcome: "pending" });
    expect(JSON.parse(lines[0]!)).not.toHaveProperty("reconciled");

    // The before-image blob was never touched, let alone deleted.
    expect(await fs.readFile(blobPath, "utf8")).toBe(beginInput().beforeSource);
  });
});

// ===========================================================================
// Part B — abap_journal mode=reconcile through abapJournal()
// ===========================================================================

describe("abap_journal mode=reconcile", () => {
  it("happy path: outcome=failed records the id, outcome, reason, and the local-only/assertion notes", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);

    const res = await abapJournal(
      fakeConn,
      { mode: "reconcile", entry: entry.id, outcome: "failed", reason: "confirmed nothing landed" },
      60_000,
      j,
    );
    expect(res.text).toContain(entry.id);
    expect(res.text).toMatch(/outcome: failed/);
    expect(res.text).toContain("confirmed nothing landed");
    expect(res.text).toMatch(/LOCAL journal only/);
    expect(res.text).toMatch(/ASSERTION, not an observation/);

    expect((await j.get(entry.id))!.outcome).toBe("failed");
  });

  it("happy path: outcome=succeeded additionally warns the entry is now terminal and undo will no longer refuse it", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);

    const res = await abapJournal(
      fakeConn,
      { mode: "reconcile", entry: entry.id, outcome: "succeeded", reason: "confirmed via abap_read" },
      60_000,
      j,
    );
    expect(res.text).toMatch(/outcome: succeeded/);
    expect(res.text).toMatch(/now terminal/);
    expect(res.text).toMatch(/mode=undo will no longer refuse it/);
  });

  it("missing entry, missing outcome, and a blank reason each refuse BAD_INPUT", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);

    const noEntry = await catchErr(abapJournal(fakeConn, { mode: "reconcile", outcome: "failed", reason: "x" }, 60_000, j));
    expect(noEntry.code).toBe("BAD_INPUT");

    const noOutcome = await catchErr(abapJournal(fakeConn, { mode: "reconcile", entry: entry.id, reason: "x" }, 60_000, j));
    expect(noOutcome.code).toBe("BAD_INPUT");

    const blankReason = await catchErr(
      abapJournal(fakeConn, { mode: "reconcile", entry: entry.id, outcome: "failed", reason: "   " }, 60_000, j),
    );
    expect(blankReason.code).toBe("BAD_INPUT");

    // None of these wrote anything.
    expect(await indexLines(tmp)).toHaveLength(1);
  });

  it("an unknown entry id refuses NOT_FOUND", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const err = await catchErr(
      abapJournal(
        fakeConn,
        { mode: "reconcile", entry: "20200101T000000000Z-abcdef", outcome: "failed", reason: "x" },
        60_000,
        j,
      ),
    );
    expect(err.code).toBe("NOT_FOUND");
  });

  it("an already-settled entry refuses BAD_INPUT, naming the outcome it already has", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);
    await j.finish(entry.id, { outcome: "succeeded" });

    const err = await catchErr(
      abapJournal(fakeConn, { mode: "reconcile", entry: entry.id, outcome: "failed", reason: "x" }, 60_000, j),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("succeeded");
  });

  it("has NO `object` fallback — object= alone, without entry=, still refuses BAD_INPUT even though a pending entry for that object exists", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    // A pending entry that DOES match the object filter — proves this is not
    // simply "no entries found", but a deliberate absence of the fallback
    // every other mode (show/undo) offers. Guessing which stranded entry was
    // meant and writing a false outcome into the audit trail is worse than
    // refusing outright (see the comment in src/tools/journal.ts).
    await begun(j, { object: objectRef("ZMCP_TARGET") });

    const err = await catchErr(
      abapJournal(
        fakeConn,
        { mode: "reconcile", object: "ZMCP_TARGET", outcome: "failed", reason: "x" },
        60_000,
        j,
      ),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("entry");
  });

  it("makes zero network calls", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);
    const { conn, calls } = networkGuardedConn();

    await abapJournal(conn, { mode: "reconcile", entry: entry.id, outcome: "failed", reason: "x" }, 60_000, j);
    expect(calls()).toBe(0);
  });
});

// ===========================================================================
// Part C — list/show surfacing
// ===========================================================================

describe("abap_journal mode=list surfacing of reconciled entries", () => {
  it('shows "reconciled" in the flags column, both flags for an undone-and-reconciled entry, and an empty cell for an ordinary entry', async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const ordinary = await begun(j, { object: objectRef("ZMCP_ORDINARY") });
    const reconciledOnly = await begun(j, { object: objectRef("ZMCP_RECONCILED") });
    const undoneAndReconciled = await begun(j, { object: objectRef("ZMCP_BOTH") });

    await j.reconcile(reconciledOnly.id, { outcome: "succeeded", reason: "checked by hand" });
    await j.reconcile(undoneAndReconciled.id, { outcome: "succeeded", reason: "checked by hand" });
    await j.markUndone(undoneAndReconciled.id, "20200101T000000001Z-abcdef");

    const res = await abapJournal(fakeConn, { mode: "list" }, 60_000, j);
    const lines = res.text.split("\n");
    const header = lines.find((l) => l.startsWith("id "));
    expect(header, `no table header found in:\n${res.text}`).toBeDefined();
    const flagsCol = header!.indexOf("flags");

    const cellFor = (id: string): string => {
      const line = lines.find((l) => l.startsWith(id));
      expect(line, `no row for ${id} in:\n${res.text}`).toBeDefined();
      return line!.slice(flagsCol).trim();
    };

    expect(cellFor(ordinary.id)).toBe("");
    expect(cellFor(reconciledOnly.id)).toBe("reconciled");
    expect(cellFor(undoneAndReconciled.id)).toBe("undone reconciled");
  });

  it("names mode=reconcile in the STRANDED note for an entry older than STALE_PENDING_MS", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const stuck = await begun(j, { object: objectRef("ZMCP_STUCK") });
    const oldTs = new Date(Date.now() - STALE_PENDING_MS - 60_000).toISOString();
    await backdate(tmp, stuck.id, oldTs);

    const res = await abapJournal(fakeConn, { mode: "list" }, 60_000, j);
    expect(res.text).toMatch(/STRANDED/);
    expect(res.text).toContain(stuck.id);
    // The usage hint is a generic template, not the specific id substituted in.
    expect(res.text).toContain('mode=reconcile entry=<id> outcome=succeeded|failed reason="…"');
  });
});

describe("abap_journal mode=show surfacing of a reconciled entry", () => {
  it("prints a reconciled header field and a note with the reason and RECONCILED BY HAND", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j, { object: objectRef("ZMCP_SHOWME") });
    await j.reconcile(entry.id, { outcome: "failed", reason: "server-side check confirmed nothing changed" });

    const res = await abapJournal(fakeConn, { mode: "show", entry: entry.id }, 60_000, j);
    expect(res.text).toMatch(/^reconciled: /m);
    expect(res.text).toMatch(/RECONCILED BY HAND/);
    expect(res.text).toContain("server-side check confirmed nothing changed");
  });
});
