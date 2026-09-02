/**
 * Response compaction and etag (hard rule: ~15k tokens; etag emitted, then
 * enforced).
 */
import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_TOKENS,
  buildResponse,
  contentHash,
  estimateTokens,
  sliceLines,
  textTable,
} from "../src/compact.js";

const lines = (n: number, width = 60) =>
  Array.from({ length: n }, (_, i) => `line ${String(i + 1).padStart(5, "0")} ${"x".repeat(width)}`).join("\n");

describe("contentHash (etag)", () => {
  it("is stable and prefixed", () => {
    expect(contentHash("CLASS zcl_foo.")).toBe(contentHash("CLASS zcl_foo."));
    expect(contentHash("a")).toMatch(/^sha256:[0-9a-f]{32}$/);
  });

  it("changes when the content changes", () => {
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });

  it("ignores CRLF vs LF — ADT returns CRLF and a round trip must not be a conflict", () => {
    expect(contentHash("a\r\nb\r\n")).toBe(contentHash("a\nb\n"));
  });
});

describe("buildResponse — the hard 15k-token rule", () => {
  it("passes small responses through untruncated", () => {
    const r = buildResponse({
      header: { object: "CLAS/OC ZCL_FOO", etag: "sha256:abc" },
      body: "CLASS zcl_foo DEFINITION.\nENDCLASS.",
      bodyLabel: "SOURCE",
    });
    expect(r.truncated).toBe(false);
    expect(r.text).toContain("object: CLAS/OC ZCL_FOO");
    expect(r.text).toContain("--- SOURCE ---");
    expect(r.text).toContain("ENDCLASS.");
    expect(r.text).not.toContain("TRUNCATED");
  });

  it("drops header entries that are empty or undefined", () => {
    const r = buildResponse({ header: { a: "1", b: undefined, c: "", d: 0 }, body: "x" });
    expect(r.text).toContain("a: 1");
    expect(r.text).not.toContain("b:");
    expect(r.text).not.toContain("c:");
    expect(r.text).toContain("d: 0");
  });

  it("never exceeds maxChars, even for a 20k-line object", () => {
    const r = buildResponse({
      header: { object: "PROG/P ZBIG" },
      body: lines(20_000),
      bodyLabel: "SOURCE",
      maxChars: 4000,
    });
    expect(r.text.length).toBeLessThanOrEqual(4000);
    expect(r.truncated).toBe(true);
  });

  it("respects the default ~15k-token cap", () => {
    const r = buildResponse({ body: lines(50_000), bodyLabel: "SOURCE" });
    expect(r.text.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
    expect(estimateTokens(r.text)).toBeLessThanOrEqual(15_000);
  });

  it("marks the truncation explicitly and says how to get the rest", () => {
    const r = buildResponse({
      body: lines(5000),
      bodyLabel: "SOURCE",
      bodyOffset: 1,
      // The caller must declare the parameter name: `offset` is only real for
      // tools that actually accept it. Without this the response may
      // NOT advertise one — see the two tests below.
      pagingParam: "offset",
      hints: ['Read a single method with method="<NAME>".'],
      maxChars: 3000,
    });
    expect(r.text).toContain("--- TRUNCATED ---");
    expect(r.text).toMatch(/Returned lines 1\.\.\d+ of 5000/);
    expect(r.text).toContain('method="<NAME>"');
    expect(r.text).toMatch(/offset=\d+/);
  });

  it("emits an offset hint that actually points at the next unseen line", () => {
    const r = buildResponse({
      body: lines(500),
      bodyLabel: "SOURCE",
      pagingParam: "offset",
      maxChars: 2000,
    });
    const next = Number(/offset=(\d+)/.exec(r.text)![1]);
    expect(next).toBe((r.returnedLines ?? 0) + 1);
  });

  it("never advertises a paging parameter the calling tool does not accept", () => {
    const r = buildResponse({ body: lines(500), bodyLabel: "RESULTS", maxChars: 2000 });
    expect(r.truncated).toBe(true);
    expect(r.text).not.toMatch(/offset=\d+/);
    expect(r.text).toMatch(/NO offset\/paging parameter/);
    // The caller still learns exactly how much it is missing.
    expect(r.text).toMatch(/\d+ line\(s\) are not shown/);
  });

  it("names the tool's own parameter, not a hard-coded `offset`", () => {
    const r = buildResponse({
      body: lines(500),
      bodyLabel: "ROWS",
      pagingParam: "from",
      maxChars: 2000,
    });
    expect(r.text).toMatch(/from=\d+/);
    expect(r.text).not.toMatch(/offset=\d+/);
  });

  it("truncates whole lines only — never mid-line", () => {
    const r = buildResponse({ body: lines(2000), bodyLabel: "SOURCE", maxChars: 2500 });
    const body = r.text.split("--- SOURCE ---\n")[1]!.split("\n\n--- TRUNCATED")[0]!;
    for (const l of body.split("\n")) {
      expect(l).toMatch(/^line \d{5} x+$/);
    }
  });

  it("keeps the header and the truncation notice even on a tiny budget", () => {
    const r = buildResponse({
      header: { object: "PROG/P ZBIG", etag: "sha256:deadbeef" },
      body: lines(1000),
      bodyLabel: "SOURCE",
      maxChars: 400,
    });
    expect(r.text).toContain("etag: sha256:deadbeef");
    expect(r.text).toContain("TRUNCATED");
    expect(r.text.length).toBeLessThanOrEqual(400);
    expect(r.truncated).toBe(true);
  });

  it("drops the body entirely rather than blowing the budget", () => {
    const r = buildResponse({
      header: { object: "PROG/P ZBIG" },
      body: lines(1000),
      bodyLabel: "SOURCE",
      maxChars: 200,
    });
    expect(r.returnedLines).toBe(0);
    expect(r.text).not.toContain("--- SOURCE ---");
    expect(r.text).toContain("TRUNCATED");
  });

  it("reports truncation when the caller already windowed the body", () => {
    const r = buildResponse({
      body: lines(10),
      bodyLabel: "SOURCE",
      bodyOffset: 1,
      bodyTotalLines: 900,
    });
    expect(r.truncated).toBe(true);
    expect(r.totalLines).toBe(900);
  });

  it("uses a pessimistic chars-per-token ratio for ABAP", () => {
    expect(CHARS_PER_TOKEN).toBeLessThanOrEqual(4);
  });

  // G-36: DEFAULT_MAX_CHARS must stay derived, never a second hardcoded
  // literal that can drift from DEFAULT_MAX_TOKENS/CHARS_PER_TOKEN.
  it("DEFAULT_MAX_CHARS is derived from DEFAULT_MAX_TOKENS * CHARS_PER_TOKEN", () => {
    expect(DEFAULT_MAX_CHARS).toBe(Math.floor(DEFAULT_MAX_TOKENS * CHARS_PER_TOKEN));
  });
});

describe("sliceLines", () => {
  it("is 1-based and inclusive, matching the truncation hint", () => {
    const src = "a\nb\nc\nd\ne";
    expect(sliceLines(src, 1, 2).text).toBe("a\nb");
    expect(sliceLines(src, 3, 2).text).toBe("c\nd");
    expect(sliceLines(src, 3).text).toBe("c\nd\ne");
    expect(sliceLines(src, 3).offset).toBe(3);
    expect(sliceLines(src, 3).total).toBe(5);
  });

  it("normalises CRLF", () => {
    expect(sliceLines("a\r\nb", 1, 1).text).toBe("a");
  });
});

describe("textTable", () => {
  it("aligns and never leaves trailing whitespace", () => {
    const t = textTable(
      [
        { type: "CLAS/OC", name: "ZCL_A" },
        { type: "TABL/DT", name: "ZT_LONG_NAME" },
      ],
      ["type", "name"],
    );
    for (const l of t.split("\n")) expect(l).toBe(l.trimEnd());
    expect(t.split("\n")).toHaveLength(4);
  });

  it("returns empty for no rows", () => {
    expect(textTable([], ["a"])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The char budget covers the WHOLE response, not just the body.
// Sections, header, notes and hints used to be emitted whole; a DDIC read with
// large prologue sections measured 60,144 chars against a 52,500 cap.
// ---------------------------------------------------------------------------

describe("every part of the response is inside the budget", () => {
  /** Shaped like a real DDIC read: fat prologue sections plus a long body. */
  const fatParts = (maxChars: number) => ({
    header: { system: "A4H", object: "TABL/DT SFLIGHT", etag: "sha256:abc" },
    sections: [
      { title: "FIELDS", content: lines(600, 90) },
      { title: "FIXED VALUES", content: lines(400, 90) },
      { title: "FOREIGN KEYS", content: lines(300, 90) },
    ],
    body: lines(4000, 90),
    bodyLabel: "PSEUDO-DDL",
    bodyOffset: 1,
    bodyTotalLines: 4000,
    notes: ["A note that is always shown."],
    hints: ["Use abap_search with mode=where_used."],
    pagingParam: "offset",
    maxChars,
  });

  it("never exceeds the cap, at several caps", () => {
    for (const cap of [2_000, 10_000, 52_500, DEFAULT_MAX_CHARS]) {
      const r = buildResponse(fatParts(cap));
      expect(r.text.length, `cap ${cap}`).toBeLessThanOrEqual(cap);
      expect(r.chars).toBe(r.text.length);
      expect(estimateTokens(r.text)).toBeLessThanOrEqual(Math.ceil(cap / CHARS_PER_TOKEN));
    }
  });

  it("states, in numbers, that the sections were cut too", () => {
    const r = buildResponse(fatParts(10_000));
    expect(r.sectionsTruncated).toBe(true);
    const m = /Prologue sections were ALSO cut: (\d+) of (\d+) characters kept in (\d+) of (\d+) section/.exec(
      r.text,
    );
    expect(m, "the section cut must be disclosed with real numbers").not.toBeNull();
    const [keptChars, totalChars, keptSections, totalSections] = m!.slice(1).map(Number);
    expect(keptChars).toBeLessThan(totalChars!);
    expect(totalChars).toBeGreaterThan(10_000);
    expect(keptSections).toBeLessThanOrEqual(totalSections!);
    expect(totalSections).toBe(3);
  });

  it("never truncates without saying so", () => {
    const r = buildResponse(fatParts(10_000));
    expect(r.truncated).toBe(true);
    expect(r.hasMore).toBe(true);
    expect(r.text).toContain("--- TRUNCATED ---");
    expect(r.text).toMatch(/Returned lines 1\.\.\d+ of 4000/);
  });

  it("keeps the cap even when the budget is smaller than the notice itself", () => {
    const r = buildResponse({ ...fatParts(120), maxChars: 120 });
    expect(r.text.length).toBeLessThanOrEqual(120);
    // A clamp that eats the notice must still announce itself.
    expect(r.text).toMatch(/HARD-CLAMPED|TRUNCATED/);
  });

  it("does not report a body line as returned when the body did not fit", () => {
    const r = buildResponse({ ...fatParts(900), maxChars: 900 });
    expect(r.text.length).toBeLessThanOrEqual(900);
    if (r.returnedLines === 0) expect(r.text).toMatch(/Returned 0 of 4000 line\(s\)/);
  });

  it("pages a large body to completion: the loop TERMINATES and covers every line exactly once", () => {
    const TOTAL = 4000;
    const lines = Array.from({ length: TOTAL }, (_, i) => `L${i + 1} ${"z".repeat(80)}`);
    const seen = new Set<number>();
    let offset = 1;
    let iterations = 0;
    while (true) {
      if (++iterations > 200) throw new Error("NO-PROGRESS LOOP: exceeded 200 pages");
      const r = buildResponse({
        header: { object: "ZCL_X" },
        body: lines.slice(offset - 1).join("\n"),
        bodyLabel: "SOURCE",
        bodyOffset: offset,
        bodyTotalLines: TOTAL,
        pagingParam: "offset",
      });
      const returned = r.returnedLines ?? 0;
      expect(returned, "every page must make forward progress").toBeGreaterThan(0);
      for (let i = 0; i < returned; i++) seen.add(offset + i);
      if (!r.hasMore) break;
      offset += returned;
    }
    expect(seen.size).toBe(TOTAL);
    expect(Math.min(...seen)).toBe(1);
    expect(Math.max(...seen)).toBe(TOTAL);
  });
});
