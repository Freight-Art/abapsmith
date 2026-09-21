/**
 * `src/adt/dumps-summary.ts` — the default `abap_dumps mode=show` view
 * (issue #149), distilled from the captured A4H fixtures. Pure text work:
 * no connection, no transport, no fakes beyond the fixture bytes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDumpDetail, TIER1_CHAPTER_NAMES, VARIABLES_CHAPTER_NAME } from "../src/adt/dumps-xml.js";
import {
  DUMP_SECTIONS,
  SECTION_CHAPTERS,
  SUMMARY_CHAPTER_NAMES,
  SUMMARY_PROSE_CHARS,
  chapterLines,
  cleanProse,
  isDumpSection,
  parseSourceLine,
  parseStackFrames,
  sectionChapterNames,
  summariseDump,
} from "../src/adt/dumps-summary.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "dumps");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const DETAIL = parseDumpDetail(fixture("dump-detail-v1.xml"));
const FORMATTED = fixture("dump-formatted.txt");

describe("sections", () => {
  it("names every section the tool accepts, and only those", () => {
    expect([...DUMP_SECTIONS]).toEqual(["analysis", "source", "variables", "stack", "environment", "all"]);
    for (const s of DUMP_SECTIONS) expect(isDumpSection(s)).toBe(true);
    expect(isDumpSection("everything")).toBe(false);
    expect(isDumpSection("ANALYSIS")).toBe(false);
    expect(isDumpSection(undefined)).toBe(false);
    expect(isDumpSection(7)).toBe(false);
  });

  it("selects chapters by NAME, and only the variables section touches kap10", () => {
    for (const [section, names] of Object.entries(SECTION_CHAPTERS)) {
      for (const n of names) expect(n).toMatch(/^kap\d+[a-z]?$/);
      if (section !== "variables") expect(names).not.toContain(VARIABLES_CHAPTER_NAME);
    }
    expect(sectionChapterNames("variables")).toEqual([VARIABLES_CHAPTER_NAME]);
    expect(sectionChapterNames("source")).toEqual(["kap7", "kap8"]);
    expect(sectionChapterNames("stack")).toContain("kap11");
    expect(sectionChapterNames("analysis")).toEqual(expect.arrayContaining(["kap3", "kap4"]));
    expect(sectionChapterNames("environment")).toContain("kap9");
  });

  it('"all" is exactly the tier-1 default set — today\'s full output, unchanged', () => {
    expect(sectionChapterNames("all")).toEqual([...TIER1_CHAPTER_NAMES]);
  });

  it("every section chapter exists in the captured dump, so the presets are not wishful", () => {
    const have = new Set(DETAIL.chapters.map((c) => c.name));
    for (const names of Object.values(SECTION_CHAPTERS)) {
      for (const n of names) expect(have.has(n), n).toBe(true);
    }
  });
});

describe("chapter text", () => {
  it("chapterLines returns one chapter's rows (banner to next banner) and undefined for an unknown name", () => {
    const kap8 = chapterLines(DETAIL, FORMATTED, "kap8");
    expect(kap8).toBeDefined();
    expect(kap8?.slice(0, 3).join("\n")).toMatch(/^\|Source Code Extract/m);
    expect(kap8?.join("\n")).toContain(">>>>>");
    // the next chapter's title row must NOT be inside this slice
    expect(kap8?.join("\n")).not.toContain("|Contents of system fields");
    expect(chapterLines(DETAIL, FORMATTED, "kap999")).toBeUndefined();
  });

  it("cleanProse drops the title row, re-joins five-space continuations and collapses blanks", () => {
    const lines = [
      "----------",
      "|Error analysis                            |",
      "|    An exception has occurred in class X. This    |",
      "|     exception was not caught                     |",
      "|                                                  |",
      "|                                                  |",
      "|    Second paragraph.                             |",
      "|                                                  |",
      "----------",
    ];
    expect(cleanProse(lines, "Error analysis")).toEqual([
      "An exception has occurred in class X. This exception was not caught",
      "",
      "Second paragraph.",
    ]);
  });
});

describe("source line", () => {
  it("reads include, line, procedure and the marked statement from kap7/kap8", () => {
    const source = parseSourceLine(
      DETAIL,
      chapterLines(DETAIL, FORMATTED, "kap7"),
      chapterLines(DETAIL, FORMATTED, "kap8"),
    );
    expect(source).toEqual({
      include: "ZCL_ZMCP_DMP_SQL==============CM001",
      line: 7,
      procedure: "IF_OO_ADT_CLASSRUN~MAIN",
      procedureKind: "METHOD",
      statement: "SELECT COUNT(*) FROM (lv_tab) INTO @lv_cnt.",
    });
  });

  it("falls back to the detail's termination line when kap7 is absent, and leaves the rest undefined", () => {
    const source = parseSourceLine(DETAIL, undefined, undefined);
    expect(source.line).toBe(DETAIL.termination?.line);
    expect(source.include).toBeUndefined();
    expect(source.statement).toBeUndefined();
  });
});

describe("call stack", () => {
  it("parses every frame of kap11 as printed, innermost first, with the name row attached", () => {
    const frames = parseStackFrames(chapterLines(DETAIL, FORMATTED, "kap11"));
    expect(frames).toHaveLength(12);
    expect(frames[0]).toEqual({
      no: 12,
      kind: "METHOD",
      program: "ZCL_ZMCP_DMP_SQL==============CP",
      include: "ZCL_ZMCP_DMP_SQL==============CM001",
      line: 7,
      name: "ZCL_ZMCP_DMP_SQL=>IF_OO_ADT_CLASSRUN~MAIN",
    });
    expect(frames[frames.length - 1]).toEqual({
      no: 1,
      kind: "MODULE (PBO)",
      program: "SAPMHTTP",
      include: "SAPMHTTP",
      line: 12,
      name: "%_HTTP_START",
    });
    expect(frames.map((f) => f.no)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("an absent chapter is an empty stack, not a throw", () => {
    expect(parseStackFrames(undefined)).toEqual([]);
  });
});

describe("summariseDump", () => {
  const summary = summariseDump(DETAIL, FORMATTED);

  it("carries the short text, the source line and the whole stack", () => {
    expect(summary.shortText).toBe(DETAIL.title);
    expect(summary.source.statement).toBe("SELECT COUNT(*) FROM (lv_tab) INTO @lv_cnt.");
    expect(summary.stack).toHaveLength(12);
    expect(summary.missing).toEqual([]);
  });

  it("keeps the reason from the error analysis and drops the sentences every dump repeats", () => {
    const text = summary.errorAnalysis.lines.join("\n");
    expect(text).toContain('"ZMCP_NO_SUCH_TABLE_XX" is not declared as a table');
    expect(text).not.toMatch(/Since the caller of the procedure could not have anticipated/);
    expect(text).not.toMatch(/The reason for the exception (occurring was|is):/);
    expect(text).not.toMatch(/^An exception has occurred in class/m);
    expect(text.length).toBeLessThanOrEqual(SUMMARY_PROSE_CHARS.errorAnalysis + 1);
    // What was dropped by the cap is counted, so the renderer can say so.
    expect(summary.errorAnalysis.omitted).toBeGreaterThan(0);
  });

  it("cuts 'How to correct' before SAP's support boilerplate and says that it did", () => {
    const text = summary.howToCorrect.lines.join("\n");
    expect(text).toContain("must be caught within");
    expect(text).not.toMatch(/non-modfied SAP program|SAP Notes|Support Portal/i);
    expect(summary.howToCorrect.boilerplateCut).toBe(true);
  });

  it("lists every chapter of the dump in chapter order, kap10 included, and never reads kap10 itself", () => {
    expect(summary.chapters.map((c) => c.name)).toEqual(
      [...DETAIL.chapters].sort((a, b) => a.chapterOrder - b.chapterOrder).map((c) => c.name),
    );
    expect(summary.chapters.some((c) => c.name === VARIABLES_CHAPTER_NAME)).toBe(true);
    expect(SUMMARY_CHAPTER_NAMES).not.toContain(VARIABLES_CHAPTER_NAME);
    // No variable value from kap10 leaks into any summary text: the chapter's
    // hex-dump rows and object references appear nowhere else in the dump.
    const kap10 = (chapterLines(DETAIL, FORMATTED, VARIABLES_CHAPTER_NAME) ?? []).join("\n");
    expect(kap10).toContain("5445544554455554333333333333334522222222");
    expect(kap10).toContain("{O:107*\\CLASS-POOL=CL_OO_ADT_RES_CLASSRUN");
    const everything = [
      ...summary.errorAnalysis.lines,
      ...summary.howToCorrect.lines,
      summary.source.statement ?? "",
      ...summary.stack.map((f) => `${f.name} ${f.include}`),
    ].join("\n");
    expect(everything).not.toContain("5445544554455554333333333333334522222222");
    expect(everything).not.toContain("{O:107*");
  });

  it("reports summary chapters the dump lacks by name instead of pretending", () => {
    const thin = { ...DETAIL, chapters: DETAIL.chapters.filter((c) => !["kap4", "kap11"].includes(c.name)) };
    const s = summariseDump(thin, FORMATTED);
    expect(s.missing).toEqual(["kap4", "kap11"]);
    expect(s.howToCorrect.lines).toEqual([]);
    expect(s.stack).toEqual([]);
    // and what is still there is still read
    expect(s.source.statement).toBe("SELECT COUNT(*) FROM (lv_tab) INTO @lv_cnt.");
  });
});
