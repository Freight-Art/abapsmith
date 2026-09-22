/**
 * `abap_journal mode=show` — the `detail="summary"|"full"` split in
 * `src/tools/journal.ts`. `detail` defaults to `"summary"` and renders a
 * unified-diff DIFF section (capped at `SHOW_DIFF_MAX_CHARS`); `detail=
 * "full"` renders the complete BEFORE-IMAGE/AFTER-IMAGE sources instead.
 * Fixture pattern copied from `test/journal-reconcile-mode.test.ts`; `fakeConn`
 * as there — mode=show only ever reads `conn.cfg.sid`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AbapConnection } from "../src/adt/connection.js";
import {
  Journal,
  type JournalBeginInput,
  type JournalConfig,
  type JournalEntry,
  type JournalObjectRef,
} from "../src/journal.js";
import { abapJournal, SHOW_DIFF_MAX_CHARS } from "../src/tools/journal.js";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-journal-show-"));
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
  description: "journal show test",
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

/** mode=show only ever reads conn.cfg.sid — same fake as test/journal-reconcile-mode.test.ts. */
const fakeConn = { cfg: { sid: "A4H" } } as unknown as AbapConnection;

// ---------------------------------------------------------------------------
// Fixtures shared by a few tests below.
// ---------------------------------------------------------------------------

/**
 * 60 unchanged lines; the after-image changes lines 10 and 30 and inserts one
 * new line after line 45 — 2 line-replacements (1 removed + 1 added each)
 * plus 1 pure insertion (1 added) = diffAdded=3, diffRemoved=2.
 */
function smallDiffSources(): { beforeSource: string; afterSource: string } {
  const beforeLines = Array.from({ length: 60 }, (_, i) => `LINE ${i + 1} original text`);
  const beforeSource = `${beforeLines.join("\n")}\n`;
  const afterLines = [...beforeLines];
  afterLines[9] = "LINE 10 original text CHANGED";
  afterLines[29] = "LINE 30 original text CHANGED";
  afterLines.splice(45, 0, "LINE 45B a brand new inserted line");
  const afterSource = `${afterLines.join("\n")}\n`;
  return { beforeSource, afterSource };
}

/** 400 lines, every line changed — large enough to blow past SHOW_DIFF_MAX_CHARS. */
function bigDiffSources(): { beforeSource: string; afterSource: string } {
  const beforeLines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`);
  const afterLines = Array.from({ length: 400 }, (_, i) => `line ${i + 1} changed`);
  return { beforeSource: `${beforeLines.join("\n")}\n`, afterSource: `${afterLines.join("\n")}\n` };
}

describe("abap_journal mode=show: detail=summary|full", () => {
  it("summary is the default: header + unified diff, no BEFORE-IMAGE section", async () => {
    const { beforeSource, afterSource } = smallDiffSources();
    const j = new Journal(cfg(tmp));
    const entry = await begun(j, { beforeSource, afterSource });
    await j.finish(entry.id, { outcome: "succeeded" });

    const res = await abapJournal(fakeConn, { mode: "show", entry: entry.id }, 60_000, j);

    expect(res.text).toContain("detail: summary");
    expect(res.text).toContain("diffAdded: 3");
    expect(res.text).toContain("diffRemoved: 2");
    expect(res.text).toContain("--- DIFF (before → after, +3 −2 lines) ---");
    expect(res.text).toContain("@@");
    expect(res.text).toContain("+LINE 10 original text CHANGED");
    expect(res.text).not.toContain("BEFORE-IMAGE");
    expect(res.text.length).toBeLessThan(2500);
  });

  it("the diff is capped at SHOW_DIFF_MAX_CHARS", async () => {
    const { beforeSource, afterSource } = bigDiffSources();
    const j = new Journal(cfg(tmp));
    const entry = await begun(j, { beforeSource, afterSource });
    await j.finish(entry.id, { outcome: "succeeded" });

    // Generous overall cap: this test is about the DIFF section's own
    // internal cap (SHOW_DIFF_MAX_CHARS), not buildResponse's maxChars.
    const res = await abapJournal(fakeConn, { mode: "show", entry: entry.id }, 200_000, j);

    expect(res.text).toContain("[diff truncated:");
    expect(res.text).toContain('detail="full" returns the complete images');

    const match = res.text.match(/--- DIFF \([^)]*\) ---\n([\s\S]*)$/);
    expect(match).not.toBeNull();
    const diffBody = match![1]!;
    expect(diffBody.length).toBeLessThanOrEqual(SHOW_DIFF_MAX_CHARS + 200);
  });

  it("detail=full returns the images as before", async () => {
    const { beforeSource, afterSource } = smallDiffSources();
    const j = new Journal(cfg(tmp));
    const entry = await begun(j, { beforeSource, afterSource });
    await j.finish(entry.id, { outcome: "succeeded" });

    const res = await abapJournal(fakeConn, { mode: "show", entry: entry.id, detail: "full" }, 60_000, j);

    expect(res.text).toContain("BEFORE-IMAGE (");
    expect(res.text).toContain("AFTER-IMAGE (");
    expect(res.text).toContain("LINE 1 original text");
    expect(res.text).toContain("LINE 10 original text CHANGED");
    expect(res.text).not.toMatch(/DIFF \(/);
  });

  it("no after-image recorded", async () => {
    const j = new Journal(cfg(tmp));
    // No afterSource, and finish()/settle() is never called: outcome stays "pending".
    const entry = await begun(j, { afterSource: undefined });
    expect(entry.outcome).toBe("pending");

    const res = await abapJournal(fakeConn, { mode: "show", entry: entry.id }, 60_000, j);

    expect(res.text).toContain("no after-image was recorded");
  });

  it("header sizes", async () => {
    const { beforeSource, afterSource } = smallDiffSources();
    const j = new Journal(cfg(tmp));
    const entry = await begun(j, { beforeSource, afterSource });
    await j.finish(entry.id, { outcome: "succeeded" });

    const res = await abapJournal(fakeConn, { mode: "show", entry: entry.id }, 60_000, j);

    expect(res.text).toContain("beforeBytes:");
    expect(res.text).toContain("afterBytes:");
    expect(res.text).toContain("diffChars:");
  });

  it("detail=full is at least several times larger than summary", async () => {
    const beforeLines = Array.from({ length: 300 }, (_, i) => `line ${i + 1} of a longer source file`);
    const afterLines = [...beforeLines];
    afterLines[150] = "line 151 of a longer source file CHANGED";
    const beforeSource = `${beforeLines.join("\n")}\n`;
    const afterSource = `${afterLines.join("\n")}\n`;

    const j = new Journal(cfg(tmp));
    const entry = await begun(j, { beforeSource, afterSource });
    await j.finish(entry.id, { outcome: "succeeded" });

    const summary = await abapJournal(fakeConn, { mode: "show", entry: entry.id }, 200_000, j);
    const full = await abapJournal(fakeConn, { mode: "show", entry: entry.id, detail: "full" }, 200_000, j);

    expect(full.text.length).toBeGreaterThan(summary.text.length * 3);
  });

  it("the summary points to detail=full", async () => {
    const { beforeSource, afterSource } = bigDiffSources();
    const j = new Journal(cfg(tmp));
    const entry = await begun(j, { beforeSource, afterSource });
    await j.finish(entry.id, { outcome: "succeeded" });

    const res = await abapJournal(fakeConn, { mode: "show", entry: entry.id }, 200_000, j);

    // buildResponse renders `hints` only inside a truncation notice, so the
    // pointer to the full images is a note, present on every summary.
    expect(res.text).toContain('detail="full"');
    expect(res.text).toContain("returns the complete before-image and after-image");
  });
});
