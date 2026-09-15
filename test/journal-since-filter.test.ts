/**
 * `Journal.list()`'s `since`/`systemKey` filters (issue #111), added so
 * scope="impacted" (src/tools/test.ts) can ask "what changed on THIS system
 * since THIS time" without also picking up entries from other systems or
 * from before the window.
 *
 * Entries are written directly as raw JSONL lines rather than through
 * `begin()`/`finish()` — `begin()` always stamps `ts` with `new Date()`,
 * which gives no control over the exact instants these tests need to sit on
 * either side of `since`. Writing the lines directly is the same idiom
 * `test/journal.test.ts` uses for its "truncated last line" case: the index
 * file's on-disk shape is itself part of the module's public contract
 * (`isEntry()` in src/journal.ts), so exercising it directly is legitimate,
 * not a layering violation.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isAbapError } from "../src/adt/errors.js";
import { Journal, type JournalConfig, type JournalEntry } from "../src/journal.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-journal-since-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const cfg = (dir: string): JournalConfig => ({
  dir,
  enabled: true,
  maxEntries: 200,
  maxAgeDays: 30,
});

/** Writes one raw JSONL line — a complete `begin` record, no `finish` patch. */
async function writeEntry(dir: string, e: Partial<JournalEntry> & { id: string }): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const rec = {
    ts: "2026-01-01T00:00:00.000Z",
    operation: "update",
    outcome: "succeeded",
    object: { name: "ZCL_DEMO", type: "CLAS/OC", uri: "/x", package: "$TMP" },
    existedBefore: true,
    beforeCapture: "captured",
    ...e,
  };
  await fs.appendFile(path.join(dir, "index.jsonl"), `${JSON.stringify(rec)}\n`, "utf8");
}

describe("Journal.list() — since", () => {
  it("keeps entries at or after `since`, drops earlier ones", async () => {
    await writeEntry(tmp, { id: "e1", ts: "2026-01-01T00:00:00.000Z" });
    await writeEntry(tmp, { id: "e2", ts: "2026-01-02T00:00:00.000Z" });
    await writeEntry(tmp, { id: "e3", ts: "2026-01-03T00:00:00.000Z" });

    const j = new Journal(cfg(tmp), "A4H");
    const entries = await j.list({ since: "2026-01-02T00:00:00.000Z" });

    expect(entries.map((e) => e.id).sort()).toEqual(["e2", "e3"]);
  });

  it("drops an entry whose own `ts` does not parse, rather than guessing it is in range", async () => {
    await writeEntry(tmp, { id: "e1", ts: "not-a-timestamp" });
    await writeEntry(tmp, { id: "e2", ts: "2026-01-03T00:00:00.000Z" });

    const j = new Journal(cfg(tmp), "A4H");
    const entries = await j.list({ since: "2026-01-01T00:00:00.000Z" });

    expect(entries.map((e) => e.id)).toEqual(["e2"]);
  });

  it("throws BAD_INPUT when `since` itself does not parse, naming the value", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    try {
      await j.list({ since: "definitely not a date" });
      expect.unreachable("list() should have thrown");
    } catch (e) {
      expect(isAbapError(e)).toBe(true);
      if (isAbapError(e)) {
        expect(e.code).toBe("BAD_INPUT");
        expect(e.message).toContain("definitely not a date");
      }
    }
  });

  it("an unparseable `since` throws before any filtering happens, even against an empty journal", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    await expect(j.list({ since: "nope" })).rejects.toThrow();
  });
});

describe("Journal.list() — systemKey", () => {
  it("keeps only entries with an exactly matching systemKey", async () => {
    await writeEntry(tmp, { id: "e1", systemKey: "A4H|https://a4h.example|100" });
    await writeEntry(tmp, { id: "e2", systemKey: "PRD|https://prd.example|100" });
    await writeEntry(tmp, { id: "e3", systemKey: "A4H|https://a4h.example|100" });

    const j = new Journal(cfg(tmp), "A4H");
    const entries = await j.list({ systemKey: "A4H|https://a4h.example|100" });

    expect(entries.map((e) => e.id).sort()).toEqual(["e1", "e3"]);
  });

  it("drops an entry with NO systemKey — it is never assumed to match", async () => {
    await writeEntry(tmp, { id: "e1" }); // no systemKey field at all
    await writeEntry(tmp, { id: "e2", systemKey: "A4H|https://a4h.example|100" });

    const j = new Journal(cfg(tmp), "A4H");
    const entries = await j.list({ systemKey: "A4H|https://a4h.example|100" });

    expect(entries.map((e) => e.id)).toEqual(["e2"]);
  });

  it("combines with `since`: both must hold", async () => {
    await writeEntry(tmp, {
      id: "e1",
      ts: "2026-01-01T00:00:00.000Z",
      systemKey: "A4H|https://a4h.example|100",
    });
    await writeEntry(tmp, {
      id: "e2",
      ts: "2026-01-05T00:00:00.000Z",
      systemKey: "A4H|https://a4h.example|100",
    });
    await writeEntry(tmp, {
      id: "e3",
      ts: "2026-01-05T00:00:00.000Z",
      systemKey: "PRD|https://prd.example|100",
    });

    const j = new Journal(cfg(tmp), "A4H");
    const entries = await j.list({
      since: "2026-01-02T00:00:00.000Z",
      systemKey: "A4H|https://a4h.example|100",
    });

    expect(entries.map((e) => e.id)).toEqual(["e2"]);
  });
});
