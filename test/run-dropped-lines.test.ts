/**
 * #180: `abap_run` used to report only a dropped-lines COUNT with no
 * indication of what was dropped or where. `stripListHeaderDetailed` and
 * `splitBridgeOutput` now also report each drop's reason and 1-based
 * position; `src/tools/run.ts` turns that into a specific note
 * (`describeDroppedLines`/`formatPositions`) and, when a size cut removes
 * body lines, `compact.ts`'s `omissionMarker` appends an in-place marker.
 *
 * Direct unit tests import the real functions from src/adt/run.js and
 * src/tools/run.js. The tool-level tests mock runReport only (model:
 * test/run-bal-hint.test.ts), via an importActual spread so the pure
 * functions above stay real.
 */
import { describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import {
  filterCapturedList,
  splitBridgeOutput,
  stripListHeader,
  stripListHeaderDetailed,
  type DroppedLine,
  type RunResult,
} from "../src/adt/run.js";
import { SafetyGate } from "../src/safety.js";

// --------------------------------------------------------------------- unit tests: src/adt/run.ts

describe("stripListHeaderDetailed", () => {
  it("reports each trailing blank as its own dropped entry, positions ascending", () => {
    const { lines, dropped } = stripListHeaderDetailed(["a", "", "b", "   ", ""]);
    expect(lines).toEqual(["a", "", "b"]);
    expect(dropped).toEqual([
      { reason: "blank", position: 4 },
      { reason: "blank", position: 5 },
    ]);
  });

  it("reports the page header and rule line as two 'header' entries at positions 1 and 2", () => {
    const { lines, dropped } = stripListHeaderDetailed([
      "01.01.2026   Report   1",
      "-".repeat(40),
      "    indented value      ",
    ]);
    expect(lines).toEqual(["    indented value"]);
    expect(dropped).toEqual([
      { reason: "header", position: 1 },
      { reason: "header", position: 2 },
    ]);
  });

  it("reports nothing dropped when there is no header and no trailing blank", () => {
    const { lines, dropped } = stripListHeaderDetailed(["just one line"]);
    expect(lines).toEqual(["just one line"]);
    expect(dropped).toEqual([]);
  });

  it("stripListHeader still returns only .lines, unchanged behaviour", () => {
    expect(stripListHeader(["a", "", "b", "   ", ""])).toEqual(["a", "", "b"]);
  });
});

describe("filterCapturedList", () => {
  const captured = [
    "22.09.2026        Header line                    1   ",
    "----------------------------------------------------",
    "Header line   ",
    "",
    "item one",
    "item two",
    "",
    "",
  ];

  it("keepBlankLines=false strips the page header and pops trailing blanks, reporting each drop", () => {
    const r = filterCapturedList(captured, false);
    expect(r.lines).toEqual(["Header line", "", "item one", "item two"]);
    expect(r.dropped).toEqual([
      { reason: "header", position: 1 },
      { reason: "header", position: 2 },
      { reason: "blank", position: 7 },
      { reason: "blank", position: 8 },
    ]);
  });

  it("keepBlankLines=true keeps header, rule line and every blank in place, only right-trimming", () => {
    const r = filterCapturedList(captured, true);
    expect(r.lines).toEqual([
      "22.09.2026        Header line                    1",
      "----------------------------------------------------",
      "Header line",
      "",
      "item one",
      "item two",
      "",
      "",
    ]);
    expect(r.dropped).toEqual([]);
  });
});

describe("splitBridgeOutput dropped-lines detail", () => {
  it("reports one 'unprefixed' entry per raw line that is neither LIST> nor ZMCP-ERR>", () => {
    // rawLines from splitting on "\n": ["LIST> a", "noise", "LIST> b", ""] —
    // the trailing "" from the final newline is itself an unprefixed line.
    const { list, droppedLines, dropped } = splitBridgeOutput("LIST> a\nnoise\nLIST> b\n");
    expect(list).toEqual(["a", "b"]);
    expect(droppedLines).toBe(2);
    expect(dropped).toEqual([
      { reason: "unprefixed", position: 2 },
      { reason: "unprefixed", position: 4 },
    ]);
  });
});

// --------------------------------------------------------------------- unit tests: src/tools/run.ts

const { formatPositions, describeDroppedLines } = await import("../src/tools/run.js");

describe("formatPositions", () => {
  it.each([
    [[9], "9"],
    [[1, 9], "1 and 9"],
    [[1, 4, 9], "1, 4 and 9"],
    [[1, 3, 4, 5, 9], "1, 3-5 and 9"],
  ])("%j -> %s", (positions, expected) => {
    expect(formatPositions(positions as number[])).toBe(expected);
  });
});

describe("describeDroppedLines", () => {
  it("describes a blank-only drop, singular for one line", () => {
    const text = describeDroppedLines([{ reason: "blank", position: 9 }]);
    expect(text).toContain("Dropped 1 blank line at position 9 (trailing list padding)");
    expect(text).toContain("Positions are 1-based line numbers of the captured list before dropping.");
    expect(text).toContain("Pass keep_blank_lines=true to receive the capture unfiltered.");
  });

  it("describes a blank-only drop, plural for several lines", () => {
    const text = describeDroppedLines([
      { reason: "blank", position: 5 },
      { reason: "blank", position: 6 },
    ]);
    expect(text).toContain("Dropped 2 blank lines at positions 5 and 6 (trailing list padding)");
  });

  it("describes a header-only drop", () => {
    const text = describeDroppedLines([
      { reason: "header", position: 1 },
      { reason: "header", position: 2 },
    ]);
    expect(text).toContain("Dropped the list header and rule line at positions 1 and 2");
  });

  it("describes an unprefixed-only drop, naming bridge line positions", () => {
    const text = describeDroppedLines([{ reason: "unprefixed", position: 3 }]);
    expect(text).toContain("Dropped 1 non-list line of bridge output at bridge line 3");
  });

  it("joins multiple reason groups in blank, header, unprefixed order", () => {
    const dropped: DroppedLine[] = [
      { reason: "unprefixed", position: 3 },
      { reason: "header", position: 1 },
      { reason: "header", position: 2 },
      { reason: "blank", position: 9 },
    ];
    const text = describeDroppedLines(dropped);
    const blankIdx = text.indexOf("blank line");
    const headerIdx = text.indexOf("list header");
    const unprefixedIdx = text.indexOf("non-list line");
    expect(blankIdx).toBeGreaterThan(-1);
    expect(headerIdx).toBeGreaterThan(blankIdx);
    expect(unprefixedIdx).toBeGreaterThan(headerIdx);
  });
});

// --------------------------------------------------------------------- tool-level tests: abapRun

const resolveStub = { object: {} as ResolvedObject };

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => resolveStub.object,
}));

const runReportCalls: unknown[][] = [];
const runReportStub = { result: {} as RunResult };

vi.mock("../src/adt/run.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/run.js")>()),
  runReport: async (...args: unknown[]) => {
    runReportCalls.push(args);
    return runReportStub.result;
  },
}));

const { abapRun } = await import("../src/tools/run.js");

function resolved(over: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "PROG/P",
    kind: "PROG",
    label: "Report",
    name: "ZAS_REPORT",
    uri: "/sap/bc/adt/programs/programs/zas_report",
    packageName: "$TMP",
    mode: "source",
    activation: "unknown",
    spec: {},
    ...over,
  } as unknown as ResolvedObject;
}

function permissiveGate(): SafetyGate {
  return new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowNamePrefixes: ["*"],
    writesLockedOut: false,
  });
}

const conn = { cfg: { sid: "TST" } } as unknown as AbapConnection;

function baseResult(over: Partial<RunResult> = {}): RunResult {
  return {
    mode: "report",
    object: "ZAS_REPORT",
    output: "line one\nline two",
    lines: 2,
    durationMs: 500,
    droppedLines: 0,
    bodyBytes: 20,
    outputComplete: true,
    ...over,
  };
}

describe("abapRun report mode: dropped-lines note", () => {
  it("uses describeDroppedLines when res.dropped is present, replacing the old generic sentence", async () => {
    resolveStub.object = resolved();
    runReportStub.result = baseResult({
      droppedLines: 2,
      dropped: [
        { reason: "blank", position: 5 },
        { reason: "blank", position: 6 },
      ],
    });
    const res = await abapRun(conn, { object: "ZAS_REPORT" }, 50_000, permissiveGate());
    expect(res.text).toContain("NOTE: Dropped 2 blank lines at positions 5 and 6 (trailing list padding).");
    expect(res.text).not.toContain("2 line(s) of captured output were dropped and are not shown below.");
  });

  it("falls back to the old generic sentence when res.dropped is absent", async () => {
    resolveStub.object = resolved();
    runReportStub.result = baseResult({ droppedLines: 3 });
    const res = await abapRun(conn, { object: "ZAS_REPORT" }, 50_000, permissiveGate());
    expect(res.text).toContain("3 line(s) of captured output were dropped and are not shown below.");
  });

  it("passes keep_blank_lines through to runReport as { keepBlankLines: true }", async () => {
    resolveStub.object = resolved();
    runReportStub.result = baseResult();
    runReportCalls.length = 0;
    await abapRun(conn, { object: "ZAS_REPORT", keep_blank_lines: true }, 50_000, permissiveGate());
    expect(runReportCalls).toHaveLength(1);
    expect(runReportCalls[0]![4]).toEqual({ keepBlankLines: true });
  });

  it("defaults keep_blank_lines to false when omitted", async () => {
    resolveStub.object = resolved();
    runReportStub.result = baseResult();
    runReportCalls.length = 0;
    await abapRun(conn, { object: "ZAS_REPORT" }, 50_000, permissiveGate());
    expect(runReportCalls[0]![4]).toEqual({ keepBlankLines: false });
  });

  it("shows an omissionMarker when a size cut trims body lines, and never exceeds maxChars", async () => {
    resolveStub.object = resolved();
    const lines = Array.from({ length: 400 }, (_, i) => `output line ${i + 1} ${"x".repeat(60)}`);
    runReportStub.result = baseResult({ output: lines.join("\n"), lines: 400 });
    const maxChars = 3000;
    const res = await abapRun(conn, { object: "ZAS_REPORT" }, maxChars, permissiveGate());
    expect(res.text.length).toBeLessThanOrEqual(maxChars);
    expect(res.text).toMatch(/… \(\d+ lines omitted\) …/);
  });
});
