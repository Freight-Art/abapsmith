/**
 * The write journal ("No git means you own the safety net").
 *
 * Pure filesystem; nothing here touches a SAP system. The tests exist to pin
 * the four properties the journal is worthless without:
 *
 *  1. **A crash mid-write leaves evidence, not silence.** The before-image and
 *     the `pending` intent are on disk *before* the mutation is attempted, and
 *     a fresh process reading the same directory still sees them. That is what
 *     "the index is append-only" buys, so it is tested by literally building a
 *     second `Journal` and never calling `finish()`.
 *  2. **A truncated last line does not take the journal with it** — that is the
 *     exact shape of a crash mid-append.
 *  3. **`sourceFingerprint()` agrees with `sourceEquals()`** from
 *     src/adt/write.ts, which is the only correct notion of "same source" for a
 *     server that returns CRLF for LF and strips the trailing newline. The
 *     journal duplicates that normalisation, so the equivalence is pinned
 *     here on a table of pairs.
 *  4. **The before-image is byte-exact** — undo restores those bytes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { contentHash } from "../src/compact.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
// The real thing — the fingerprint contract is defined against this function.
import { sourceEquals } from "../src/adt/write.js";
import {
  Journal,
  journalConfigFromEnv,
  sourceFingerprint,
  systemKey,
  withJournalledMutation,
  type JournalBeginInput,
  type JournalConfig,
  type JournalEntry,
  type JournalObjectRef,
  type JournalOperation,
} from "../src/journal.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-journal-"));
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

/**
 * A transport request, as a `JournalObjectRef`: `name` is the TRKORR
 * ("transport entries use `object.name === trkorr`"). Type/uri
 * are opaque labels here — nothing in `journal.ts` interprets them, and
 * `specForType()` degrades unrecognised type codes to a generic fallback (see
 * `targetFromEntry()` in src/adt/undo.ts), so a made-up "CTS/TR" is safe to use
 * in a fixture without touching `src/adt/types.ts`.
 */
const transportRef = (trkorr = "A4HK900123"): JournalObjectRef => ({
  name: trkorr,
  type: "CTS/TR",
  uri: `/sap/bc/adt/cts/transportrequests/${trkorr}`,
  package: "",
  description: "transport request",
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

/**
 * `begin()` resolves to `undefined` when the journal is off — that is the point
 * of its return type, and the "disabled journal" suite below pins it. Every
 * other test here runs with the journal ENABLED, so an `undefined` at these
 * call sites is a broken test, not an outcome to branch on. Failing loudly here
 * keeps the rest of the file free of `!` and of accidental `undefined.id`.
 */
const begun = async (j: Journal, over: Partial<JournalBeginInput> = {}): Promise<JournalEntry> => {
  const entry = await j.begin(beginInput(over));
  if (!entry) throw new Error("begin() returned undefined, but this journal is enabled");
  return entry;
};

const indexLines = async (dir: string): Promise<string[]> =>
  (await fs.readFile(path.join(dir, "index.jsonl"), "utf8")).split("\n").filter((l) => l.trim());

// ---------------------------------------------------------------------------
// journalConfigFromEnv
// ---------------------------------------------------------------------------

describe("journalConfigFromEnv", () => {
  it("defaults to enabled, <cwd>/.abapsmith/journal/<SID>, 200 entries, 30 days", () => {
    const c = journalConfigFromEnv({}, "A4H", "/work");
    expect(c.enabled).toBe(true);
    expect(c.dir).toBe(path.join("/work", ".abapsmith", "journal", "A4H"));
    expect(c.maxEntries).toBe(200);
    expect(c.maxAgeDays).toBe(30);
  });

  it("keeps each system in its own directory — restoring into the wrong SID must be impossible", () => {
    const a = journalConfigFromEnv({}, "A4H", "/work").dir;
    const b = journalConfigFromEnv({}, "PRD", "/work").dir;
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(path.dirname(b));
  });

  it.each(["off", "false", "0", "OFF", "no"])("treats ABAP_JOURNAL=%s as disabled", (v) => {
    expect(journalConfigFromEnv({ ABAP_JOURNAL: v }, "A4H", "/work").enabled).toBe(false);
  });

  it("stays enabled for anything else, including unset — the safety net is the default", () => {
    expect(journalConfigFromEnv({ ABAP_JOURNAL: "on" }, "A4H", "/work").enabled).toBe(true);
    expect(journalConfigFromEnv({ ABAP_JOURNAL: "" }, "A4H", "/work").enabled).toBe(true);
    expect(journalConfigFromEnv({}, "A4H", "/work").enabled).toBe(true);
  });

  it("honours ABAP_JOURNAL_DIR and the numeric limits, ignoring junk", () => {
    const c = journalConfigFromEnv(
      {
        ABAP_JOURNAL_DIR: "/var/journals",
        ABAP_JOURNAL_MAX_ENTRIES: "10",
        ABAP_JOURNAL_MAX_AGE_DAYS: "nonsense",
      },
      "A4H",
      "/work",
    );
    expect(c.dir).toBe(path.join("/var/journals", "A4H"));
    expect(c.maxEntries).toBe(10);
    expect(c.maxAgeDays).toBe(30);
  });

  it("never lets a SID become a path", () => {
    const c = journalConfigFromEnv({}, "../../etc", "/work");
    expect(c.dir.startsWith(path.join("/work", ".abapsmith", "journal"))).toBe(true);
    expect(c.dir).not.toContain("..");
  });
});

// ---------------------------------------------------------------------------
// sourceFingerprint  ⟷  sourceEquals
// ---------------------------------------------------------------------------

describe("sourceFingerprint agrees with sourceEquals (src/adt/write.ts)", () => {
  /**
   * Covers: identical, trailing \n vs none, CRLF vs LF, several trailing
   * newlines, and genuinely different text. The server returns CRLF for
   * source PUT as LF and strips the trailing newline, so all of the first four
   * are the SAME source as far as A4H is concerned.
   */
  const SAMPLES = [
    "REPORT zmcp_demo.\nWRITE: / 'x'.",
    "REPORT zmcp_demo.\nWRITE: / 'x'.\n",
    "REPORT zmcp_demo.\nWRITE: / 'x'.\n\n\n",
    "REPORT zmcp_demo.\r\nWRITE: / 'x'.\r\n",
    "REPORT zmcp_demo.\r\nWRITE: / 'x'.",
    "REPORT zmcp_demo.\nWRITE: / 'y'.\n",
    "  REPORT zmcp_demo.\nWRITE: / 'x'.\n",
    "",
    "\n",
    "\r\n",
    // N7 — whitespace cases. With `sourceFingerprint` and
    // `sourceEquals` both now delegating to the SAME shared `canonicalSource`
    // (src/compact.ts), the pairwise loop below is TAUTOLOGICAL for these
    // entries: it can only ever confirm the two call sites agree with
    // THEMSELVES, not that the trim is correct. Do not cite this test as the
    // whitespace proof — that burden is carried by test/write.test.ts N1-N6,
    // which pin literal expectations `canonicalSource` cannot conspire with.
    "REPORT zmcp_demo.\nWRITE: / 'x'.  \n", // trailing spaces on the last line
    "REPORT zmcp_demo.  \nWRITE: / 'x'.", // trailing spaces on an internal line
    "REPORT zmcp_demo.\n   \nWRITE: / 'x'.", // whitespace-only internal line
    "REPORT zmcp_demo.\n\nWRITE: / 'x'.", // already-blank internal line — must equal the one above
    "   ", // whitespace-only, no other content
    "\t", // a lone tab
  ];

  it("matches sourceEquals on every pair", () => {
    for (const a of SAMPLES) {
      for (const b of SAMPLES) {
        expect(
          sourceFingerprint(a) === sourceFingerprint(b),
          `mismatch for ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
        ).toBe(sourceEquals(a, b));
      }
    }
  });

  it("is not vacuous: it equates non-identical strings and separates real edits", () => {
    expect(SAMPLES[0]).not.toBe(SAMPLES[3]);
    expect(sourceFingerprint(SAMPLES[0]!)).toBe(sourceFingerprint(SAMPLES[3]!));
    expect(sourceFingerprint(SAMPLES[0]!)).not.toBe(sourceFingerprint(SAMPLES[5]!));
  });

  it("is a sha256:… hash, like the etag", () => {
    expect(sourceFingerprint("x")).toMatch(/^sha256:[0-9a-f]{32}$/);
  });

  it("differs from the etag exactly where the trailing newline is the only change", () => {
    // This is the whole reason the entry carries both.
    expect(contentHash("a\n")).not.toBe(contentHash("a"));
    expect(sourceFingerprint("a\n")).toBe(sourceFingerprint("a"));
  });
});

// ---------------------------------------------------------------------------
// N8 — the whitespace claims in the journal's OWN vocabulary.
//
// Justified separately from N7 (and from write.test.ts's N1-N6): `sourceFingerprint`
// is a second exported entry point in its own right, and its output is PERSISTED
// to disk (as `entry.after.fingerprint`/`entry.before.fingerprint`) rather than
// used transiently the way `sourceEquals` is. A regression that broke
// `sourceFingerprint` specifically, while leaving `sourceEquals` intact, would
// not be caught by write.test.ts at all.
// ---------------------------------------------------------------------------

describe("N8 — sourceFingerprint's own whitespace claims", () => {
  it("equates a whitespace-only internal line with an already-blank one", () => {
    expect(sourceFingerprint("A.\n   \nB.")).toBe(sourceFingerprint("A.\n\nB."));
  });

  it("still separates that from the line being deleted outright", () => {
    expect(sourceFingerprint("A.\n   \nB.")).not.toBe(sourceFingerprint("A.\nB."));
  });

  it("ignores trailing space with no other change", () => {
    expect(sourceFingerprint("A.  ")).toBe(sourceFingerprint("A."));
  });
});

// ---------------------------------------------------------------------------
// begin
// ---------------------------------------------------------------------------

describe("begin — the before-image is on disk before anything is attempted", () => {
  it("persists a pending entry and a byte-exact before-image blob", async () => {
    // CRLF *and* a trailing newline: exactly what the server hands back, and
    // exactly what a naive "normalise on the way in" would destroy.
    const before = "REPORT zmcp_demo.\r\nWRITE: / 'old'.\r\n";
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j, { beforeSource: before, beforeServerEtag: "srv-1" });

    expect(entry.outcome).toBe("pending");
    expect(entry.existedBefore).toBe(true);
    expect(entry.system).toBe("A4H");
    expect(entry.tool).toBe("abap_write");

    // Index: one line, already complete, no outcome known yet.
    const lines = await indexLines(tmp);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).outcome).toBe("pending");

    // Blob: byte-identical, CRLF and trailing newline intact.
    const blob = await fs.readFile(path.join(tmp, "blobs", entry.before!.blob!), "utf8");
    expect(blob).toBe(before);
    expect(entry.before!.bytes).toBe(Buffer.byteLength(before, "utf8"));
    expect(entry.before!.etag).toBe(contentHash(before));
    expect(entry.before!.fingerprint).toBe(sourceFingerprint(before));
    expect(entry.before!.serverEtag).toBe("srv-1");
    expect(await j.beforeImage(entry)).toBe(before);
  });

  it("records the intended after-image too", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);
    expect(await j.afterImage(entry)).toBe("REPORT zmcp_demo.\nWRITE: / 'new'.\n");
  });

  it("mints ids that sort lexicographically by time", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await begun(j)).id);
    expect(ids[0]).toMatch(/^\d{8}T\d{9}Z-[0-9a-f]{6}$/);
    expect([...ids].sort()).toEqual(ids);
  });

  it("records no before-image when the object did not exist — that is what tells undo to DELETE", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j, {
      operation: "create",
      existedBefore: false,
      beforeSource: undefined,
    });
    expect(entry.before).toBeUndefined();
    expect(await j.beforeImage(entry)).toBeUndefined();
    expect(existsSync(path.join(tmp, "blobs", `${entry.id}.before.txt`))).toBe(false);

    // …and the fact round-trips through a fresh reader.
    const reloaded = await new Journal(cfg(tmp), "A4H").get(entry.id);
    expect(reloaded!.existedBefore).toBe(false);
    expect(reloaded!.before).toBeUndefined();
  });

  it("refuses loudly, saying the mutation was NOT attempted, if the journal cannot be written", async () => {
    // A file where the journal directory should be: mkdir fails with ENOTDIR.
    const blocked = path.join(tmp, "blocked");
    await fs.writeFile(blocked, "not a directory", "utf8");
    const j = new Journal(cfg(path.join(blocked, "A4H")), "A4H");

    await expect(j.begin(beginInput())).rejects.toThrow(/NOT attempted/);
    await j.begin(beginInput()).catch((e: unknown) => {
      expect(isAbapError(e)).toBe(true);
      // NOT `SAFETY_DENIED`: a disk/permissions failure reported as a safety
      // refusal sends the reader to the allowlists and ABAP_ALLOW_WRITE, which
      // is the wrong half of the system entirely.
      expect((e as { code: string }).code).toBe("JOURNAL_IO");
      const err = e as AbapError;
      expect(err.details.dir).toContain("blocked");
      expect(String(err.details.note)).toMatch(/LOCAL filesystem problem/);
      expect(err.hint).toMatch(/ABAP_JOURNAL_DIR|ABAP_JOURNAL=off/);
    });
  });
});

// ---------------------------------------------------------------------------
// finish
// ---------------------------------------------------------------------------

describe("finish — appends the outcome, never rewrites the intent", () => {
  it("merges into the begun entry and keeps the before-image", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);
    const merged = await j.finish(entry.id, {
      outcome: "succeeded",
      activation: { attempted: true, activated: true },
    });

    expect(merged!.outcome).toBe("succeeded");
    expect(merged!.activation).toEqual({ attempted: true, activated: true });

    const got = await j.get(entry.id);
    expect(got!.outcome).toBe("succeeded");
    expect(got!.before!.blob).toBe(entry.before!.blob);
    expect(await j.beforeImage(got!)).toBe(beginInput().beforeSource);

    // Append-only: two lines, the pending one still verbatim on disk.
    const lines = await indexLines(tmp);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).outcome).toBe("pending");
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: entry.id, outcome: "succeeded" });
  });

  it("records a failure with its error text", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);
    await j.finish(entry.id, { outcome: "failed", error: "ETAG_CONFLICT: changed underneath" });
    const got = await j.get(entry.id);
    expect(got!.outcome).toBe("failed");
    expect(got!.error).toMatch(/ETAG_CONFLICT/);
  });

  it("replaces the after-image when the server normalised what we sent (DDIC does)", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);
    const normalised = "REPORT zmcp_demo.\r\nWRITE: / 'new'.";
    await j.finish(entry.id, { outcome: "succeeded", afterSource: normalised });

    const got = await j.get(entry.id);
    expect(await j.afterImage(got!)).toBe(normalised);
    expect(got!.after!.etag).toBe(contentHash(normalised));
    // The fingerprint is unchanged — the server only reformatted line endings.
    expect(got!.after!.fingerprint).toBe(entry.after!.fingerprint);
  });

  it("returns undefined for an id it never began", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    expect(await j.finish("20200101T000000000Z-abcdef", { outcome: "succeeded" })).toBeUndefined();
  });

  it("rejects a structurally invalid id with BAD_INPUT", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    await expect(j.get("../../etc/passwd")).rejects.toMatchObject({ code: "BAD_INPUT" });
    await expect(j.finish("", { outcome: "succeeded" })).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
  });
});

// ---------------------------------------------------------------------------
// Crash / corruption
// ---------------------------------------------------------------------------

describe("crash evidence", () => {
  it("a process that dies before finish() leaves a pending entry with a readable before-image", async () => {
    const before = "REPORT zmcp_demo.\nWRITE: / 'the only copy'.\n";
    const crashed = new Journal(cfg(tmp), "A4H");
    const entry = await begun(crashed, { beforeSource: before });
    // …and now the process dies. No finish(), no cleanup, no in-memory state.

    const reopened = new Journal(cfg(tmp), "A4H");
    const list = await reopened.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(entry.id);
    expect(list[0]!.outcome).toBe("pending"); // surfaced, never silently repaired
    expect(await reopened.beforeImage(list[0]!)).toBe(before);
  });

  it("a truncated or garbage line does not prevent the other entries from loading", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const a = await begun(j, { object: objectRef("ZMCP_A") });
    await fs.appendFile(path.join(tmp, "index.jsonl"), "this is not json at all\n", "utf8");
    const b = await begun(j, { object: objectRef("ZMCP_B") });
    // A half-written final line — the realistic shape of a crash mid-append.
    await fs.appendFile(path.join(tmp, "index.jsonl"), '{"id":"20260731T0000', "utf8");

    const ids = (await new Journal(cfg(tmp), "A4H").list()).map((e) => e.id);
    expect(ids.sort()).toEqual([a.id, b.id].sort());
  });

  it("ignores a patch whose entry is gone rather than inventing half an entry", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(
      path.join(tmp, "index.jsonl"),
      JSON.stringify({ id: "20260731T000000000Z-aaaaaa", outcome: "succeeded" }) + "\n",
      "utf8",
    );
    expect(await j.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("list", () => {
  it("is newest-first and honours limit, object (case-insensitive) and operation", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const a = await begun(j, { object: objectRef("ZMCP_A"), operation: "update" });
    const b = await begun(j, {
      object: objectRef("ZMCP_B"),
      operation: "create",
      existedBefore: false,
    });
    const c = await begun(j, { object: objectRef("ZMCP_A"), operation: "delete" });

    expect((await j.list()).map((e) => e.id)).toEqual([c.id, b.id, a.id]);
    expect((await j.list({ limit: 2 })).map((e) => e.id)).toEqual([c.id, b.id]);
    expect((await j.list({ object: "zmcp_a" })).map((e) => e.id)).toEqual([c.id, a.id]);
    expect((await j.list({ object: "ZMCP_B" })).map((e) => e.id)).toEqual([b.id]);
    expect((await j.list({ operation: "create" })).map((e) => e.id)).toEqual([b.id]);
    expect(await j.list({ object: "ZMCP_NOPE" })).toEqual([]);
  });

  it("returns the merged view, not the raw lines", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const e = await begun(j);
    await j.finish(e.id, { outcome: "succeeded" });
    const list = await j.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.outcome).toBe("succeeded");
  });
});

// ---------------------------------------------------------------------------
// markUndone
// ---------------------------------------------------------------------------

describe("markUndone", () => {
  it("round-trips the undo link in both directions", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const original = await begun(j);
    await j.finish(original.id, { outcome: "succeeded" });

    const undo = await begun(j, {
      undoOf: original.id,
      tool: "abap_journal undo",
      operation: "update",
    });
    await j.finish(undo.id, { outcome: "succeeded" });
    await j.markUndone(original.id, undo.id);

    const fresh = new Journal(cfg(tmp), "A4H");
    const back = await fresh.get(original.id);
    expect(back!.undoneBy).toBe(undo.id);
    expect(back!.outcome).toBe("succeeded"); // the earlier patch is not lost
    expect(await fresh.beforeImage(back!)).toBe(beginInput().beforeSource);
    expect((await fresh.get(undo.id))!.undoOf).toBe(original.id);
  });

  it("reports an unknown id as BAD_INPUT", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    await expect(j.markUndone("20200101T000000000Z-abcdef", "20200101T000000001Z-abcdef"))
      .rejects.toMatchObject({ code: "BAD_INPUT" });
  });
});

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

describe("prune", () => {
  it("keeps the newest maxEntries, drops the rest with their blobs, and still loads", async () => {
    // Written through a journal with a roomy cap so the lazy auto-prune inside
    // begin() does not do the work before the assertion gets to look.
    const writer = new Journal(cfg(tmp), "A4H");
    const all = [];
    for (let i = 0; i < 6; i++) {
      all.push(await begun(writer, { beforeSource: `SOURCE ${i}\n` }));
    }

    const j = new Journal(cfg(tmp, { maxEntries: 3 }), "A4H");
    const res = await j.prune();
    expect(res.removedEntries).toBe(3);
    // Each entry has a before and an after blob.
    expect(res.removedBlobs).toBe(6);

    const survivors = await new Journal(cfg(tmp, { maxEntries: 3 }), "A4H").list();
    expect(survivors.map((e) => e.id)).toEqual([all[5]!.id, all[4]!.id, all[3]!.id]);
    // Survivor blobs are untouched and still readable.
    expect(await new Journal(cfg(tmp), "A4H").beforeImage(survivors[0]!)).toBe("SOURCE 5\n");
    // Dropped blobs are gone.
    expect(existsSync(path.join(tmp, "blobs", `${all[0]!.id}.before.txt`))).toBe(false);
    // The rewrite was atomic — no temp file left behind.
    expect(await fs.readdir(tmp)).not.toContain("index.jsonl.tmp");
  });

  it("drops entries older than maxAgeDays and keeps the young ones", async () => {
    const j = new Journal(cfg(tmp, { maxEntries: 100, maxAgeDays: 7 }), "A4H");
    const old = await begun(j, { object: objectRef("ZMCP_OLD") });
    const fresh = await begun(j, { object: objectRef("ZMCP_NEW") });
    // Age it by patching the append-only index the way the journal itself would.
    await fs.appendFile(
      path.join(tmp, "index.jsonl"),
      JSON.stringify({ id: old.id, ts: "2020-01-01T00:00:00.000Z" }) + "\n",
      "utf8",
    );

    const res = await j.prune();
    expect(res.removedEntries).toBe(1);
    const left = await new Journal(cfg(tmp), "A4H").list();
    expect(left.map((e) => e.id)).toEqual([fresh.id]);
    expect(existsSync(path.join(tmp, "blobs", `${old.id}.before.txt`))).toBe(false);
    expect(existsSync(path.join(tmp, "blobs", `${fresh.id}.before.txt`))).toBe(true);
  });

  /**
   * REWRITTEN. This used to assert, flatly, that a blob whose id is not in the
   * index gets unlinked — "not in the index" was treated as sufficient proof of
   * "orphaned". It is not: `begin()` writes blobs BEFORE the index line by
   * design, so a write that is still in flight looks identical on disk to a
   * crash orphan, and the old rule deleted the before-image of a live write.
   * The property that is actually wanted is narrower, so it is now stated
   * narrowly — a DEAD process's orphan goes; see the in-flight test below for
   * the case the old assertion got wrong.
   */
  it("sweeps a crashed process's orphan blob, and only files it can prove are journal blobs", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    await j.begin(beginInput());
    // A genuine orphan: well-formed id, no index line, and — the part that
    // makes it an orphan rather than a live write — no `begin()` in flight
    // holding it. Only a dead process can leave this behind.
    await fs.writeFile(path.join(tmp, "blobs", "20200101T000000000Z-dead99.before.txt"), "x");
    await fs.writeFile(path.join(tmp, "blobs", "README"), "not ours");

    const res = await j.prune();
    expect(res.removedEntries).toBe(0);
    expect(res.removedBlobs).toBe(1);
    expect(existsSync(path.join(tmp, "blobs", "20200101T000000000Z-dead99.before.txt"))).toBe(false);
    expect(existsSync(path.join(tmp, "blobs", "README"))).toBe(true);
  });

  it("leaves a foreign *.before.txt alone when its stem is not a journal id", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    await j.begin(beginInput());
    // The old code's comment said "not ours — leave it alone" while matching on
    // the SUFFIX only, so it cheerfully deleted anything ending in
    // `.before.txt`. A stem that this journal could never have minted is not
    // ours to delete.
    const foreign = path.join(tmp, "blobs", "notes.before.txt");
    const alsoForeign = path.join(tmp, "blobs", "my-backup-2020.after.txt");
    await fs.writeFile(foreign, "somebody else's file", "utf8");
    await fs.writeFile(alsoForeign, "and another", "utf8");

    const res = await j.prune();
    expect(res.removedBlobs).toBe(0);
    expect(await fs.readFile(foreign, "utf8")).toBe("somebody else's file");
    expect(await fs.readFile(alsoForeign, "utf8")).toBe("and another");
  });

  it("is a no-op on an empty journal", async () => {
    const j = new Journal(cfg(path.join(tmp, "empty")), "A4H");
    expect(await j.prune()).toEqual({ removedEntries: 0, removedBlobs: 0 });
  });

  it("prunes itself once the index grows well past maxEntries", async () => {
    const j = new Journal(cfg(tmp, { maxEntries: 4 }), "A4H");
    for (let i = 0; i < 12; i++) await j.begin(beginInput());
    // begin() prunes lazily (> maxEntries * 1.25), so we never keep 12 around.
    expect((await new Journal(cfg(tmp), "A4H").list()).length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// prune vs. a write that is still in flight  (E2)
// ---------------------------------------------------------------------------

/**
 * These are the only tests in the file that reach for a spy, and they do it for
 * one reason: the hazard IS a window between two disk operations, so a test
 * that does not control that window is testing the scheduler. Each spy parks
 * `begin()`/`prune()` at a precise point and holds it there, which turns "this
 * could interleave badly" into "this interleaves badly, every run".
 */
describe("prune must not destroy a write that is still in flight", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Yield to the event loop enough times for a couple of queued fs ops to run. */
  const settleEventLoop = async (ticks = 20): Promise<void> => {
    for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r));
  };

  /**
   * Wait until `cond` holds. Unbounded ticking (with a wall-clock backstop) is
   * what makes these tests deterministic rather than "usually fast enough": how
   * many event-loop turns an mkdir + writeFile takes is a property of the
   * machine, not of the code under test, so we wait for the state we need
   * instead of guessing a tick count.
   */
  const waitUntil = async (cond: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setImmediate(r));
    }
  };

  it("keeps the before-image of a begin() whose index line has not landed yet", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    // One completed entry, so prune() has something to survive and does not
    // bail out early on an empty journal.
    await begun(j, { object: objectRef("ZMCP_ANCHOR") });

    // Park begin() *after* it has written the before-blob and *before* it
    // appends the index line — precisely the state that is on disk for a real
    // concurrent write. The lock is deliberately still free here, so this pins
    // the in-flight set itself and not merely the serialisation.
    let release!: () => void;
    const parked = new Promise<void>((r) => (release = r));
    let parkedOnce = false;
    const realWriteFile = fs.writeFile;
    vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, opts) => {
      if (!parkedOnce && String(file).endsWith(".after.txt")) {
        parkedOnce = true;
        await parked;
      }
      return (realWriteFile as (...a: unknown[]) => Promise<void>)(file, data, opts);
    });

    const SECRET = "REPORT zmcp_demo.\nWRITE: / 'the only copy'.\n";
    const inFlight = j.begin(beginInput({ object: objectRef("ZMCP_LIVE"), beforeSource: SECRET }));
    await waitUntil(() => parkedOnce, "begin() to reach its after-image write");

    // The blob is real and on disk; the index knows nothing about it. This is
    // exactly the shape the old sweepBlobs() called an orphan.
    const stray = (await fs.readdir(path.join(tmp, "blobs"))).filter((f) =>
      f.endsWith(".before.txt"),
    );
    expect(stray).toHaveLength(2);
    expect(await indexLines(tmp)).toHaveLength(1); // …the live write is NOT in the index

    await j.prune();

    release();
    const entry = await inFlight;
    expect(entry).toBeDefined();

    // The whole point: undo can still restore what it promised to restore.
    expect(await j.beforeImage(entry!)).toBe(SECRET);
    expect(existsSync(path.join(tmp, "blobs", entry!.before!.blob!))).toBe(true);
  });

  it("does not discard an append that lands while the index is being rewritten", async () => {
    // A cap small enough that prune() genuinely rewrites (tmp + rename) rather
    // than taking the cheap no-drop path.
    const writer = new Journal(cfg(tmp), "A4H");
    const all: JournalEntry[] = [];
    for (let i = 0; i < 6; i++) all.push(await begun(writer, { beforeSource: `SOURCE ${i}\n` }));
    const target = all[5]!; // newest — certain to survive the prune

    const j = new Journal(cfg(tmp, { maxEntries: 3 }), "A4H");

    // Fire the append from inside prune's rename, i.e. after prune has already
    // read the index and staged its replacement. On the unfixed code that
    // append goes into the inode the rename is about to unlink, and the patch
    // evaporates with it.
    let appending: Promise<unknown> = Promise.resolve();
    const realRename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      appending = j.finish(target.id, { outcome: "succeeded" });
      await settleEventLoop(); // let it land, if the code lets it
      return (realRename as (...a: unknown[]) => Promise<void>)(from, to);
    });

    await j.prune();
    await appending;

    // Read it back from disk with a brand-new journal: the patch must be there.
    const reloaded = await new Journal(cfg(tmp), "A4H").get(target.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.outcome).toBe("succeeded");
    expect(await new Journal(cfg(tmp), "A4H").beforeImage(reloaded!)).toBe("SOURCE 5\n");
  });
});

// ---------------------------------------------------------------------------
// beforeCapture — provenance of existedBefore  (E1)
// ---------------------------------------------------------------------------

describe("beforeCapture records HOW existedBefore was decided", () => {
  it('is "captured" only when the previous source was actually read', async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const e = await begun(j, { existedBefore: true, beforeSource: "REPORT z.\n" });
    expect(e.beforeCapture).toBe("captured");
    expect(await j.beforeImage(e)).toBe("REPORT z.\n"); // there really are bytes
    expect((await new Journal(cfg(tmp), "A4H").get(e.id))!.beforeCapture).toBe("captured");
  });

  it('is "failed" when we claim it existed but hold no bytes — the fabricated image', async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const e = await begun(j, { existedBefore: true, beforeSource: undefined });
    expect(e.beforeCapture).toBe("failed");
    // The image is still recorded (the "before present iff existed" invariant),
    // and it is still empty — which is exactly why it needed a label. Without
    // beforeCapture this is indistinguishable from a genuinely empty object,
    // and undo would happily restore nothing over a real one.
    expect(e.before).toBeDefined();
    expect(e.before!.bytes).toBe(0);
    expect(e.before!.blob).toBeUndefined();
    expect(await j.beforeImage(e)).toBeUndefined();
  });

  it('is "unknown" for existedBefore:false — a bare false is not evidence of absence', async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const e = await begun(j, {
      operation: "create",
      existedBefore: false,
      beforeSource: undefined,
    });
    // NOT "confirmed-absent": nothing here checked. Only the caller can assert
    // that, and only that assertion may authorise an undo-by-delete.
    expect(e.beforeCapture).toBe("unknown");
  });

  it("takes the caller's word when the caller states it", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const e = await begun(j, {
      operation: "create",
      existedBefore: false,
      beforeSource: undefined,
      beforeCapture: "confirmed-absent",
    });
    expect(e.beforeCapture).toBe("confirmed-absent");
    expect((await new Journal(cfg(tmp), "A4H").get(e.id))!.beforeCapture).toBe("confirmed-absent");
  });

  it('reads a legacy entry written before the field existed as "unknown"', async () => {
    const j = new Journal(cfg(tmp), "A4H");
    await fs.mkdir(tmp, { recursive: true });
    const id = "20200101T000000000Z-abcdef";
    await fs.writeFile(
      path.join(tmp, "index.jsonl"),
      JSON.stringify({
        id,
        ts: "2020-01-01T00:00:00.000Z",
        system: "A4H",
        operation: "update",
        object: objectRef(),
        existedBefore: false,
        outcome: "pending",
      }) + "\n",
      "utf8",
    );
    // The fixture really does lack the field — the normalisation under test is
    // the journal's, not the test's.
    expect(JSON.parse((await indexLines(tmp))[0]!)).not.toHaveProperty("beforeCapture");

    expect((await j.get(id))!.beforeCapture).toBe("unknown");
    expect((await j.list())[0]!.beforeCapture).toBe("unknown");
    expect((await j.listPending())[0]!.beforeCapture).toBe("unknown");
  });

  it("degrades a hand-edited junk value to unknown rather than passing it through", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const e = await begun(j);
    await fs.appendFile(
      path.join(tmp, "index.jsonl"),
      JSON.stringify({ id: e.id, beforeCapture: "definitely-fine-honest" }) + "\n",
      "utf8",
    );
    expect((await j.get(e.id))!.beforeCapture).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// systemKey  (E3)
// ---------------------------------------------------------------------------

describe("systemKey identifies a system by more than its self-declared SID", () => {
  const key = (sid: string, url: string, client: string): string => systemKey({ sid, url, client });

  it("is stable across case and trailing-slash differences", () => {
    expect(key("A4H", "http://a4h.example:50000", "001")).toBe(
      key("a4h", "HTTP://A4H.EXAMPLE:50000/", " 001 "),
    );
    expect(key("A4H", "http://a4h.example:50000/", "001")).toBe(
      key(" a4h ", "http://a4h.example:50000", "001"),
    );
  });

  it("separates two boxes that share a SID and client but not a host", () => {
    // The exact accident the journal must never enable: ABAP_SID defaults to
    // "UNKNOWN", so two different systems can present the same label.
    expect(key("UNKNOWN", "http://box-a:50000", "001")).not.toBe(
      key("UNKNOWN", "http://box-b:50000", "001"),
    );
    // Port and scheme count too — they are different endpoints.
    expect(key("A4H", "http://a4h:50000", "001")).not.toBe(key("A4H", "http://a4h:50001", "001"));
    expect(key("A4H", "http://a4h:50000", "001")).not.toBe(key("A4H", "https://a4h:50000", "001"));
  });

  it("separates clients and SIDs on one host", () => {
    expect(key("A4H", "http://a4h:50000", "001")).not.toBe(key("A4H", "http://a4h:50000", "100"));
    expect(key("A4H", "http://a4h:50000", "001")).not.toBe(key("PRD", "http://a4h:50000", "001"));
  });

  it("keeps an unparsable URL as evidence instead of collapsing unknowns together", () => {
    expect(key("A4H", "not a url", "001")).not.toBe(key("A4H", "also not a url", "001"));
    expect(key("A4H", "NOT A URL", "001")).toBe(key("A4H", " not a url ", "001"));
  });

  it("cannot be spoofed by a part that contains the separator", () => {
    expect(key("A4H|http://x", "", "")).not.toBe(key("A4H", "http://x", ""));
  });

  it("is recorded verbatim by begin(), and simply absent when not supplied", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const k = key("A4H", "http://a4h.example:50000", "001");
    const withKey = await begun(j, { systemKey: k, object: objectRef("ZMCP_K") });
    const without = await begun(j, { object: objectRef("ZMCP_NOK") });

    expect(withKey.systemKey).toBe(k);
    expect(without.systemKey).toBeUndefined();

    // Not defaulted or invented anywhere on the way to disk, either.
    const fresh = new Journal(cfg(tmp), "A4H");
    expect((await fresh.get(withKey.id))!.systemKey).toBe(k);
    expect((await fresh.get(without.id))!.systemKey).toBeUndefined();
    const lines = await indexLines(tmp);
    expect(JSON.parse(lines[0]!).systemKey).toBe(k);
    expect(JSON.parse(lines[1]!)).not.toHaveProperty("systemKey");
  });

  it("exposes the journal's own system label so undo can compare against it", () => {
    expect(new Journal(cfg(tmp), "A4H").system).toBe("A4H");
  });
});

// ---------------------------------------------------------------------------
// settle / listPending — entries stranded pending  (E6)
// ---------------------------------------------------------------------------

describe("settle says whether the outcome actually landed", () => {
  it("distinguishes the reasons finish() flattens into undefined", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);

    expect(await j.settle("20200101T000000000Z-abcdef", { outcome: "succeeded" })).toEqual({
      settled: false,
      reason: "unknown-entry",
    });

    // "pending" is the state we are trying to LEAVE. Refusing it means refusing
    // to write it: the index must still hold exactly the one begin line.
    expect(await j.settle(entry.id, { outcome: "pending" })).toEqual({
      settled: false,
      reason: "not-terminal",
    });
    expect(await indexLines(tmp)).toHaveLength(1);
    expect((await j.get(entry.id))!.outcome).toBe("pending");

    const res = await j.settle(entry.id, { outcome: "succeeded" });
    expect(res).toMatchObject({ settled: true });
    expect(res.settled && res.entry.outcome).toBe("succeeded");
    // Real state, read back by a fresh process — not just the shape we passed in.
    expect((await new Journal(cfg(tmp), "A4H").get(entry.id))!.outcome).toBe("succeeded");
    expect(await indexLines(tmp)).toHaveLength(2);
  });

  it("still lets finish() behave exactly as before", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);
    const merged = await j.finish(entry.id, { outcome: "succeeded" });
    expect(merged!.id).toBe(entry.id);
    expect(merged!.outcome).toBe("succeeded");
    expect(await j.finish("20200101T000000000Z-abcdef", { outcome: "succeeded" })).toBeUndefined();
  });

  it("lists stranded pendings newest-first and never repairs them", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const done = await begun(j, { object: objectRef("ZMCP_DONE") });
    const stuckA = await begun(j, { object: objectRef("ZMCP_STUCK_A") });
    const stuckB = await begun(j, { object: objectRef("ZMCP_STUCK_B") });
    await j.finish(done.id, { outcome: "succeeded" });

    expect((await j.listPending()).map((e) => e.id)).toEqual([stuckB.id, stuckA.id]);
    // Listing is not repairing: they are still pending afterwards.
    expect((await j.listPending()).map((e) => e.id)).toEqual([stuckB.id, stuckA.id]);
    expect((await j.get(stuckA.id))!.outcome).toBe("pending");
  });

  it("honours staleAfterMs, and treats an unparsable ts as stale", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const young = await begun(j, { object: objectRef("ZMCP_YOUNG") });
    const old = await begun(j, { object: objectRef("ZMCP_OLD") });
    const broken = await begun(j, { object: objectRef("ZMCP_BROKEN") });

    // Age them the way the journal itself would — by appending a patch.
    const patch = async (id: string, ts: string): Promise<void> =>
      fs.appendFile(path.join(tmp, "index.jsonl"), JSON.stringify({ id, ts }) + "\n", "utf8");
    await patch(old.id, "2020-01-01T00:00:00.000Z");
    await patch(broken.id, "not a timestamp at all");

    // Nothing is a minute old yet except the two we aged.
    const stale = (await j.listPending({ staleAfterMs: 60_000 })).map((e) => e.id);
    expect(stale).toContain(old.id);
    // An unparsable ts counts as stale: a broken timestamp is damage, and an
    // age filter must not be the thing that hides it.
    expect(stale).toContain(broken.id);
    expect(stale).not.toContain(young.id);

    // With no threshold, everything pending comes back.
    expect((await j.listPending()).map((e) => e.id).sort()).toEqual(
      [young.id, old.id, broken.id].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// disabled
// ---------------------------------------------------------------------------

describe("disabled journal", () => {
  /**
   * REWRITTEN. This used to assert `entry.id.startsWith("disabled-")` — i.e. it
   * pinned the existence of a fake entry carrying a fake id. Callers all did
   * `entryId = e.id` and went on to report a journal id in their response, so a
   * disabled journal advertised an undo that could never be performed; the lie
   * only came apart later, for whoever tried to use the id. There is now no
   * value that reads like an id, because there is no entry.
   */
  it("touches the disk not at all, and hands back no entry rather than a fake one", async () => {
    const dir = path.join(tmp, "never-created");
    const j = new Journal(cfg(dir, { enabled: false }), "A4H");

    expect(await j.begin(beginInput())).toBeUndefined();

    // Everything else stays inert, and an id that never existed is not special.
    const madeUp = "20200101T000000000Z-abcdef";
    expect(await j.finish(madeUp, { outcome: "succeeded" })).toBeUndefined();
    expect(await j.settle(madeUp, { outcome: "succeeded" })).toEqual({
      settled: false,
      reason: "disabled",
    });
    await j.markUndone(madeUp, "whatever");
    expect(await j.prune()).toEqual({ removedEntries: 0, removedBlobs: 0 });
    expect(await j.list()).toEqual([]);
    expect(await j.listPending()).toEqual([]);
    expect(await j.get(madeUp)).toBeUndefined();

    expect(existsSync(dir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Transport entries — corrNr, irreversible, and the five new
// operation kinds.
// ---------------------------------------------------------------------------

describe("transport journal entries", () => {
  const TRANSPORT_KINDS: JournalOperation[] = [
    "transport-create",
    "transport-add-user",
    "transport-set-owner",
    "transport-delete",
    "transport-release",
  ];

  it("round-trips each transport-* operation kind through begin/list/get", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const ids: string[] = [];
    for (const op of TRANSPORT_KINDS) {
      const entry = await j.begin({
        operation: op,
        object: transportRef(),
        existedBefore: op !== "transport-create",
        corrNr: "A4HK900123",
      });
      if (!entry) throw new Error("begin() returned undefined, but this journal is enabled");
      expect(entry.operation).toBe(op);
      ids.push(entry.id);
    }

    // Every kind survives a fresh read from disk, individually...
    for (const [i, op] of TRANSPORT_KINDS.entries()) {
      expect((await j.get(ids[i]!))!.operation).toBe(op);
    }
    // ...and `list({ operation })` finds exactly the one it names, not the others.
    for (const op of TRANSPORT_KINDS) {
      const found = await j.list({ operation: op });
      expect(found.map((e) => e.operation)).toEqual([op]);
    }
  });

  it("persists corrNr supplied at begin() — known upfront for transport-* entries", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const e = await j.begin({
      operation: "transport-create",
      object: transportRef("A4HK900999"),
      existedBefore: false,
      corrNr: "A4HK900999",
    });
    expect(e!.corrNr).toBe("A4HK900999");
    expect((await j.get(e!.id))!.corrNr).toBe("A4HK900999");
    // ...and it shows up as an `object` filter hit too, since transport entries
    // are filed under their TRKORR as the object name.
    expect((await j.list({ object: "A4HK900999" }))[0]!.corrNr).toBe("A4HK900999");
  });

  it("persists corrNr recorded later via finish() — the ordinary-object-write case", async () => {
    // An ordinary create/update/delete does not know its transport at begin()
    // time: the lock (and with it the corrNr) is only taken AFTER the
    // before-image hook fires. `finish()` is where the real value lands.
    const j = new Journal(cfg(tmp), "A4H");
    const e = await begun(j); // plain `update`, no corrNr yet
    expect(e.corrNr).toBeUndefined();

    const merged = await j.finish(e.id, { outcome: "succeeded", corrNr: "A4HK900123" });
    expect(merged!.corrNr).toBe("A4HK900123");

    const got = await j.get(e.id);
    expect(got!.corrNr).toBe("A4HK900123");
    // Append-only: the original `begin` line is untouched, corrNr arrives on
    // the second line.
    const lines = await indexLines(tmp);
    expect(JSON.parse(lines[0]!).corrNr).toBeUndefined();
    expect(JSON.parse(lines[1]!).corrNr).toBe("A4HK900123");
  });

  it("persists trSource, which is what separates a request abapsmith CREATED from one it merely used", async () => {
    // `operation: "transport-create"` says a request was created; it does not
    // say whose idea it was. Only `session-created` means abapsmith minted a
    // numbered CTS object on its own initiative during a write — the one a human
    // is now on the hook to release or delete. See `JournalTrSource`.
    const j = new Journal(cfg(tmp), "A4H");
    const mine = await j.begin({
      operation: "transport-create",
      object: transportRef("A4HK900117"),
      existedBefore: false,
      corrNr: "A4HK900117",
      trSource: "session-created",
    });
    expect(mine!.trSource).toBe("session-created");
    expect((await j.get(mine!.id))!.trSource).toBe("session-created");

    // Unset means "not applicable", exactly like every other optional field —
    // never defaulted to `session-created`, which would claim responsibility for
    // a request abapsmith did not create.
    const plainWrite = await begun(j);
    expect(plainWrite.trSource).toBeUndefined();
    const rawFirstLine = JSON.parse((await indexLines(tmp))[0]!) as Record<string, unknown>;
    expect(rawFirstLine.trSource).toBe("session-created");
  });

  it("marks only transport-release irreversible; everything else is left unset", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const released = await j.begin({
      operation: "transport-release",
      object: transportRef(),
      existedBefore: true,
      corrNr: "A4HK900123",
      irreversible: true,
    });
    expect(released!.irreversible).toBe(true);
    expect((await j.get(released!.id))!.irreversible).toBe(true);

    const ordinaryWrite = await begun(j);
    expect(ordinaryWrite.irreversible).toBeUndefined();

    const otherTransportOp = await j.begin({
      operation: "transport-add-user",
      object: transportRef(),
      existedBefore: true,
      corrNr: "A4HK900123",
    });
    expect(otherTransportOp!.irreversible).toBeUndefined();
  });

  it("captures the FULL request contents as a transport-delete's before-image, not just the TRKORR", async () => {
    // Requirement: transport-delete's before-image must be the deleted request's
    // FULL contents (E071 object entries), not just the TRKORR. `journal.ts`
    // does not know or care what shape that JSON takes — it stores whatever
    // `beforeSource` bytes it is given, byte-exact, same as source text. This
    // pins that the blob is NOT truncated/summarised down to the bare TRKORR.
    const trkorr = "A4HK900123";
    const fullContents = JSON.stringify({
      trkorr,
      text: "Demo transport",
      owner: "DEVELOPER",
      objects: [
        { pgmid: "R3TR", object: "PROG", objName: "ZMCP_DEMO" },
        { pgmid: "R3TR", object: "CLAS", objName: "ZCL_MCP_DEMO" },
        { pgmid: "LIMU", object: "REPS", objName: "ZCL_MCP_DEMO===CP" },
      ],
    });

    const j = new Journal(cfg(tmp), "A4H");
    const e = await j.begin({
      operation: "transport-delete",
      object: transportRef(trkorr),
      existedBefore: true,
      beforeCapture: "captured",
      beforeSource: fullContents,
      corrNr: trkorr,
    });
    expect(e).toBeDefined();

    const stored = await j.beforeImage(e!);
    expect(stored).toBe(fullContents);
    // Not just the TRKORR — the whole point of the requirement.
    expect(stored).not.toBe(trkorr);
    expect(JSON.parse(stored!).objects).toHaveLength(3);

    // Survives a reload from disk too.
    const reopened = new Journal(cfg(tmp), "A4H");
    expect(await reopened.beforeImage((await reopened.get(e!.id))!)).toBe(fullContents);
  });
});

// ===========================================================================
// withJournalledMutation — the shared begin/settle choreography
// ===========================================================================

/**
 * The helper (`src/journal.ts`) replaces five hand-rolled copies of the same
 * dance in `src/tools/write.ts` (3) and `src/adt/undo.ts` (2). The thing worth
 * pinning is not that it calls `begin()` — it is WHEN: the design requires
 * the entry to be on disk BEFORE the mutating request goes out, which
 * is why the helper hands the mutator a hook to fire mid-call instead of
 * wrapping begin/mutate/finish around it. A wrapper would be simpler and wrong.
 */
describe("withJournalledMutation", () => {
  it("has the entry on disk BEFORE the mutation continues", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    let onDiskAtMutationTime: string[] = [];

    const { result, entryId } = await withJournalledMutation(
      j,
      { begin: () => ({ operation: "update" as const, object: objectRef(), existedBefore: true }) },
      async (onBeforeImage) => {
        // Nothing yet: the hook has not fired.
        expect(await new Journal(cfg(tmp), "A4H").list()).toHaveLength(0);
        await onBeforeImage(undefined);
        // Read through a SECOND Journal instance, so this asserts the disk and
        // not an in-memory cache.
        onDiskAtMutationTime = (await new Journal(cfg(tmp), "A4H").list()).map((e) => e.id);
        return "PUT-ok";
      },
    );

    expect(result).toBe("PUT-ok");
    expect(entryId).toBeDefined();
    expect(onDiskAtMutationTime).toEqual([entryId]);
    // Still pending until settle() says otherwise.
    expect((await j.get(entryId!))!.outcome).toBe("pending");
  });

  it("settle() patches the entry, and only the entry the hook created", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const { entryId, settle } = await withJournalledMutation(
      j,
      { begin: (src: string) => ({ operation: "update" as const, object: objectRef(), existedBefore: true, beforeSource: src }) },
      async (onBeforeImage) => onBeforeImage("OLD SOURCE"),
    );
    await settle({ outcome: "succeeded", activation: { attempted: false } });

    const entry = (await new Journal(cfg(tmp), "A4H").get(entryId!))!;
    expect(entry.outcome).toBe("succeeded");
    expect(await j.beforeImage(entry)).toBe("OLD SOURCE");
  });

  it("records `failed` and rethrows when the mutation throws after the hook fired", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    let id: string | undefined;
    await expect(
      withJournalledMutation(
        j,
        { begin: () => ({ operation: "delete" as const, object: objectRef(), existedBefore: true }) },
        async (onBeforeImage) => {
          await onBeforeImage(undefined);
          id = (await j.list())[0]!.id;
          throw new Error("server said no");
        },
      ),
    ).rejects.toThrow("server said no");

    const entry = (await new Journal(cfg(tmp), "A4H").get(id!))!;
    expect(entry.outcome).toBe("failed");
    expect(entry.error).toContain("server said no");
  });

  it('onError:"leave-pending" leaves it pending instead — undo.ts\'s behaviour, preserved', async () => {
    const j = new Journal(cfg(tmp), "A4H");
    await expect(
      withJournalledMutation(
        j,
        {
          begin: () => ({ operation: "delete" as const, object: objectRef(), existedBefore: true }),
          onError: "leave-pending",
        },
        async (onBeforeImage) => {
          await onBeforeImage(undefined);
          throw new Error("server said no");
        },
      ),
    ).rejects.toThrow("server said no");

    const entries = await new Journal(cfg(tmp), "A4H").list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe("pending");
  });

  it("a throw BEFORE the hook fires leaves nothing behind at all", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    await expect(
      withJournalledMutation(
        j,
        { begin: () => ({ operation: "update" as const, object: objectRef(), existedBefore: true }) },
        async () => {
          throw new Error("refused pre-flight");
        },
      ),
    ).rejects.toThrow("refused pre-flight");
    expect(await new Journal(cfg(tmp), "A4H").list()).toHaveLength(0);
  });

  it("a disabled journal yields no id and no entry — never a fabricated one", async () => {
    const j = new Journal(cfg(tmp, { enabled: false }), "A4H");
    const { result, entryId, settle } = await withJournalledMutation(
      j,
      { begin: () => ({ operation: "update" as const, object: objectRef(), existedBefore: true }) },
      async (onBeforeImage) => {
        await onBeforeImage(undefined);
        return 42;
      },
    );
    expect(result).toBe(42);
    // Not "disabled-…", not "": absent. Every caller renders undo advice from
    // `entryId !== undefined`, so anything truthy here is a promise it cannot keep.
    expect(entryId).toBeUndefined();
    await expect(settle({ outcome: "succeeded" })).resolves.toBeUndefined();
  });

  it("no journal at all still runs the mutation, and the hook is a no-op", async () => {
    const { result, entryId } = await withJournalledMutation(
      undefined,
      { begin: () => ({ operation: "update" as const, object: objectRef(), existedBefore: true }) },
      async (onBeforeImage) => {
        await onBeforeImage(undefined);
        return "ran";
      },
    );
    expect(result).toBe("ran");
    expect(entryId).toBeUndefined();
  });
});
