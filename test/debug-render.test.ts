/**
 * Offline tests for `src/debug/render.ts`, the variable rendering and
 * context-budget layer. 100% offline: fixtures only, no HTTP, no live SAP calls.
 *
 * Two fixtures (`variables.xml`, `child-variables.xml`) are parsed via
 * `parseVariablesResponse`/`parseChildVariablesResponse` to build the small
 * real-shaped base case; everything else (the 100,000-row table, the
 * budget-busting survey, the malformed paths) is synthesised with `makeVar`,
 * which fills in every `DebugVariable` field so the synthetic rows have
 * exactly the same shape the real parser produces — not an invented shape.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatAbapNumeric,
  parseChildVariablesResponse,
  parseVariablesResponse,
} from "../src/debug/xml-response.js";
import type { DebugVariable } from "../src/debug/types.js";
import { debugValueInputSchema } from "../src/tools/debug.js";
import {
  DEBUG_MAX_CHARS,
  PathSyntaxError,
  SCAN_ROW_CAP,
  STATE_ID_PLACEHOLDER,
  buildRetrievalCall,
  retrievalWindow,
  describeComplex,
  elide,
  formatPath,
  isComplex,
  parsePath,
  renderDrill,
  renderEmptyBodyTrap,
  renderInline,
  renderScalar,
  renderScanReport,
  renderSurvey,
  renderTableRows,
  validatePath,
  withChildren,
  type SurveyEntry,
  type VariableNode,
} from "../src/debug/render.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "debugger");
const fixture = (name: string) => readFileSync(join(FIXTURE_DIR, name), "utf8");

/** Fill in every `DebugVariable` field so synthetic test rows have exactly the shape the real parser produces. */
function makeVar(overrides: Partial<DebugVariable> & { id: string; name: string }): DebugVariable {
  return {
    id: overrides.id,
    name: overrides.name,
    declaredTypeName: overrides.declaredTypeName ?? "",
    actualTypeName: overrides.actualTypeName ?? "",
    kind: overrides.kind ?? "LOCAL",
    instantiationKind: overrides.instantiationKind ?? "",
    accessKind: overrides.accessKind ?? "",
    metaType: overrides.metaType ?? "simple",
    parameterKind: overrides.parameterKind ?? "",
    value: overrides.value ?? "",
    hexValue: overrides.hexValue ?? "",
    readOnly: overrides.readOnly ?? false,
    technicalType: overrides.technicalType ?? "",
    length: overrides.length ?? 0,
    tableBody: overrides.tableBody ?? "",
    tableLines: overrides.tableLines ?? 0,
    isValueIncomplete: overrides.isValueIncomplete ?? false,
    isException: overrides.isException ?? false,
    inheritanceLevel: overrides.inheritanceLevel ?? 0,
    inheritanceClass: overrides.inheritanceClass ?? "",
  };
}

// ---------------------------------------------------------------------------
// Structural guarantee: elide() is the ONLY truncation primitive.
//
// Asserted against the module's SOURCE TEXT, not its export names, because the
// defect this replaces was an inline `.slice()` inside a non-exported helper.
// ---------------------------------------------------------------------------

const RENDER_SOURCE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "debug", "render.ts");
const RENDER_SOURCE = readFileSync(RENDER_SOURCE_PATH, "utf8");

/** A cutting construct found in the source, with the function that encloses it. */
interface Offender {
  line: number;
  fn: string;
  text: string;
}

/**
 * Every occurrence of a construct that can shorten a value: the slice family, plus
 * template literals that append an ellipsis glyph (the hand-rolled "truncate and
 * add …" pattern). Line-based so the failure message can name a real line.
 */
function scanForTruncation(source: string): Offender[] {
  const lines = source.split("\n");
  const found: Offender[] = [];
  let fn = "<module scope>";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const decl = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/.exec(line);
    if (decl) fn = decl[1]!;
    const isComment = /^\s*(\*|\/\/|\/\*)/.test(line);
    if (isComment) continue;
    if (/\.slice\(|\.substring\(|\.substr\(/.test(line) || /`[^`]*\$\{[^`]*\}\s*(?:…|\.\.\.)/.test(line)) {
      found.push({ line: i + 1, fn, text: line.trim() });
    }
  }
  return found;
}

/**
 * Occurrences that provably do not shorten a value. Keyed by enclosing function plus
 * a distinctive snippet rather than a line number, because line numbers rot. Adding
 * an entry here is a deliberate, reviewable act — which is the whole point.
 */
const TRUNCATION_ALLOWLIST: { fn: string; snippet: string; why: string }[] = [
  {
    fn: "parsePath",
    snippet: "raw.slice(start, j)",
    why: "Scan-cursor extraction of a complete identifier: `j` is where the scanner stopped, so this yields the whole token, never a shortened one.",
  },
  {
    fn: "parsePath",
    snippet: "raw.slice(digitsStart, j)",
    why: "Scan-cursor extraction of the complete digit run; the value is then range-checked and canonicality-checked, so nothing is silently cut.",
  },
  {
    fn: "parsePath",
    snippet: "raw.substring(i, closeAt + 1)",
    why: "Complete-segment extraction to the closing bracket or end of path; describeSegment() then quotes ALL of it or none of it, so no prefix is ever silently shown in place of the whole.",
  },
  {
    fn: "formatTrailingSignNumeric",
    snippet: "body.slice(0, -1)",
    why: "SIGN-COLUMN extraction, not truncation: the one character removed is the ABAP trailing sign ('-'), and its meaning is carried forward into the returned string as a LEADING minus, so no information is dropped — dropping it silently is exactly the bug this function exists to prevent (parseFloat('123.45-') === 123.45).",
  },
  {
    fn: "renderSurvey",
    snippet: "reachable.slice(kept)",
    why: "ARRAY slice selecting the REACHABLE entries that were omitted; every one of them is then named by an elide() block.",
  },
  {
    fn: "renderSurvey",
    snippet: "reachableTexts.slice(0, kept)",
    why: "ARRAY slice selecting the REACHABLE entries that were kept; the complement is covered by an elide() block.",
  },
  {
    fn: "renderTableWithinBudget",
    snippet: "parts.rows.slice(kept.length)",
    why: "ARRAY slice selecting the row units dropped for budget; their count feeds the elide() block that names them.",
  },
  {
    fn: "renderStackSection",
    snippet: "visible.slice(0, MAX_VISIBLE_FRAMES)",
    why: "ARRAY slice selecting the stack frames shown; the remainder is counted and named by an elide() block naming the abap_debug stack call, so deep stacks are never silently shortened.",
  },
];

function isAllowed(o: Offender): boolean {
  return TRUNCATION_ALLOWLIST.some((a) => a.fn === o.fn && o.text.includes(a.snippet));
}

/**
 * The output-side companion to the source scan: every omission marker in a rendered
 * body must be a well-formed elide — a real count, a noun, and a retrieval call.
 * The predecessor merely asserted `not.toContain("...")`, which a silent drop passes
 * trivially, because a dropped value leaves no marker at all.
 */
function expectEveryOmissionIsAWellFormedElide(text: string): void {
  expect(text).not.toContain("...");
  for (const m of text.matchAll(/\[([^\]]*?)not shown[^\]]*\]/g)) {
    expect(m[0], `omission block must name a count: ${m[0]}`).toMatch(/\[\d+ /);
    expect(m[0], `omission block must carry a retrieval call: ${m[0]}`).toContain("abap_debug_value({");
  }
}

// Parameter names are DERIVED FROM THE REAL SCHEMA, never restated here. A test that
// pinned the current output string would have passed happily while buildRetrievalCall
// emitted `rows:` — a key the schema does not have, which a non-strict z.object strips
// in silence. Reading the schema is what makes this test able to fail.
const DEBUG_VALUE_SCHEMA_KEYS = Object.keys(debugValueInputSchema);
const DEBUG_VALUE_REQUIRED_KEYS = Object.entries(debugValueInputSchema)
  .filter(([, v]) => !(v as { isOptional(): boolean }).isOptional())
  .map(([k]) => k);

/** Every `abap_debug_value({...})` call embedded in a rendered body, as key lists. */
function harvestRetrievalCalls(text: string): { call: string; keys: string[] }[] {
  return [...text.matchAll(/abap_debug_value\(\{([^}]*)\}\)/g)].map((m) => ({
    call: m[0],
    keys: [...m[1]!.matchAll(/(\w+)\s*:/g)].map((k) => k[1]!),
  }));
}

function expectRetrievalCallsAreExecutable(text: string): void {
  for (const { call, keys } of harvestRetrievalCalls(text)) {
    for (const k of keys) {
      expect(DEBUG_VALUE_SCHEMA_KEYS, `${call} uses key "${k}", absent from debugValueInputSchema`).toContain(k);
    }
    for (const req of DEBUG_VALUE_REQUIRED_KEYS) {
      expect(keys, `${call} omits required parameter "${req}"`).toContain(req);
    }
  }
}

// ---------------------------------------------------------------------------
// Path grammar: parse / format / validate, round-trip, malformed rejection
// ---------------------------------------------------------------------------

describe("path grammar", () => {
  const canonical = [
    "@ROOT",
    "@GLOBALS",
    "@LOCALS",
    "@PARAMETERS",
    "LT_ITEMS",
    "LT_ITEMS[3]",
    "LT_ITEMS[3]-MATERIAL",
    "SY-SUBRC",
    "LS_ITEM-CLIENT",
    "LT_ITEMS[1]-ITEM_ID",
    "LT_ITEMS[100000]-MATERIAL",
    "<LS_ITEM>",
    "<LS_ITEM>-MATERIAL",
    "<LT_INNER>[3]",
    "<LT_INNER>[3]-MATNR",
  ];

  it.each(canonical)("round-trips %s", (path) => {
    const parsed = parsePath(path);
    expect(formatPath(parsed)).toBe(path);
    // Re-parsing the formatted form must reproduce the same structure.
    expect(parsePath(formatPath(parsed))).toEqual(parsed);
  });

  it("parses a scope root with no steps", () => {
    expect(parsePath("@GLOBALS")).toEqual({ root: "@GLOBALS", steps: [] });
  });

  it("parses a mixed component/index chain in order", () => {
    expect(parsePath("LT_ITEMS[3]-MATERIAL")).toEqual({
      root: "LT_ITEMS",
      steps: [
        { kind: "index", value: 3 },
        { kind: "component", name: "MATERIAL" },
      ],
    });
  });

  it("parses a bare field-symbol root, brackets kept in the canonical root", () => {
    expect(parsePath("<LS_ITEM>")).toEqual({ root: "<LS_ITEM>", steps: [] });
  });

  it("parses a field-symbol root followed by an ordinary component/index chain", () => {
    expect(parsePath("<LS_ITEM>-MATERIAL")).toEqual({
      root: "<LS_ITEM>",
      steps: [{ kind: "component", name: "MATERIAL" }],
    });
    expect(parsePath("<LT_INNER>[3]-MATNR")).toEqual({
      root: "<LT_INNER>",
      steps: [
        { kind: "index", value: 3 },
        { kind: "component", name: "MATNR" },
      ],
    });
  });

  const malformed: Array<{ path: string; label: string }> = [
    { path: "", label: "empty path" },
    { path: "[3]", label: "starts with an index" },
    { path: "LT_ITEMS[0]", label: "0-based index" },
    { path: "LT_ITEMS[-1]", label: "negative index" },
    { path: "LT_ITEMS[abc]", label: "non-numeric index" },
    { path: "LT_ITEMS[3", label: "unterminated index" },
    { path: "LT_ITEMS-", label: "trailing dash with no component name" },
    { path: "@FOO", label: "unknown scope pseudo-segment" },
    { path: "LT ITEMS", label: "embedded space" },
    { path: "<", label: "bare open angle bracket, no name" },
    { path: "<LS_ITEM", label: "unterminated field-symbol bracket" },
    { path: "LS_ITEM>", label: "stray close angle bracket, no open" },
    { path: "<>", label: "empty field-symbol name" },
    { path: "<LS ITEM>", label: "embedded space inside field-symbol name" },
  ];

  it.each(malformed)("rejects $label ($path) by throwing, naming the offending segment", ({ path }) => {
    expect(() => parsePath(path)).toThrow(PathSyntaxError);
    let caught: unknown;
    try {
      parsePath(path);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PathSyntaxError);
    const err = caught as PathSyntaxError;
    expect(err.segment).not.toBe(undefined);
    expect(err.message.length).toBeGreaterThan(0);
  });

  it.each(malformed)("validatePath($path) reports ok:false with a message and segment, never coercing", ({ path }) => {
    const result = validatePath(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.length).toBeGreaterThan(0);
      expect(typeof result.segment).toBe("string");
    }
  });

  it("validatePath(valid path) reports ok:true with the parsed structure", () => {
    const result = validatePath("LT_ITEMS[1]-MATERIAL");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path.root).toBe("LT_ITEMS");
    }
  });
});

// ---------------------------------------------------------------------------
// The elision primitive and the "no bare ellipsis" structural guarantee
// ---------------------------------------------------------------------------

describe("elide() — the only truncation primitive", () => {
  it("always produces a block naming the count and the retrieval call, never a bare ellipsis", () => {
    const block = elide("rows", 99980, buildRetrievalCall("LT_ITEMS", retrievalWindow(21, 100_000)));
    expect(block).toContain("99980");
    expect(block).toContain("rows");
    expect(block).toContain("abap_debug_value");
    expect(block).not.toContain("...");
  });

  it("elide is the only construction that can shorten anything — asserted against module SOURCE TEXT", () => {
    // The predecessor of this test regexed only *exported function names* for
    // /truncat|ellipsis/. A helper named `shorten`, an inline `.slice()`, or a bare
    // template literal sailed straight through it — and one did: three
    // `raw.slice(i, Math.min(i + 12, n))` truncations lived undetected in parsePath's
    // error messages. This test reads the source and fails on any cutting construct
    // that is not `elide()` itself or an explicitly justified allow-list entry.
    const offenders = scanForTruncation(RENDER_SOURCE);
    const unlisted = offenders.filter((o) => !isAllowed(o));
    expect(
      unlisted.map((o) => `line ${o.line} in ${o.fn}(): ${o.text}`),
      "Unjustified cutting construct in src/debug/render.ts. Every omission must go " +
        "through elide(what, count, retrievalCall) so it names a real count and a " +
        "retrieval call that makes progress. If this occurrence genuinely does not " +
        "truncate (an array slice, a scan-cursor extraction), add it to TRUNCATION_ALLOWLIST " +
        "with a one-line justification.",
    ).toEqual([]);
    // The allow-list must not rot into a blanket permit: every entry must still match
    // something, or it is stale and hiding the fact that the guarantee moved.
    const unmatched = TRUNCATION_ALLOWLIST.filter((a) => !offenders.some((o) => o.fn === a.fn && o.text.includes(a.snippet)));
    expect(unmatched.map((a) => `${a.fn}: ${a.snippet}`), "Stale allow-list entry").toEqual([]);
  });

  it("the allow-listed occurrences are all array/cursor slices, never a string being cut short", () => {
    // Guards the allow-list itself: an entry may only be justified as non-truncating.
    const offenders = scanForTruncation(RENDER_SOURCE);
    expect(offenders.length).toBeGreaterThan(0); // the scanner really is finding things
    for (const a of TRUNCATION_ALLOWLIST) {
      expect(a.why.length, `allow-list entry ${a.fn} needs a justification`).toBeGreaterThan(20);
    }
  });
});

describe("every omission in rendered output is a well-formed elide — adversarial sweep", () => {
  it("a very long incomplete string value renders with the sanctioned single-glyph ellipsis, never three periods", () => {
    const v = makeVar({
      id: "LV_HUGE",
      name: "LV_HUGE",
      metaType: "string",
      value: "A".repeat(60),
      length: 500_000,
      isValueIncomplete: true,
    });
    const out = renderScalar(v);
    expectEveryOmissionIsAWellFormedElide(out);
    expect(out).toContain("…"); // the sanctioned U+2026 marker
    expect(out).toContain("500000");
  });

  it("a budget-busting survey of many huge variables never contains a bare '...'", () => {
    const entries: SurveyEntry[] = Array.from({ length: 400 }, (_, i) =>
      ({
        variable: makeVar({
          id: `LV_V${i}`,
          name: `LV_V${i}`,
          metaType: "string",
          value: "X".repeat(300),
          length: 300,
        }),
      }) satisfies SurveyEntry,
    );
    const result = renderSurvey(entries, { maxChars: 2_000 });
    expectEveryOmissionIsAWellFormedElide(result.text);
    expectRetrievalCallsAreExecutable(result.text);
  });

  it("a deeply nested structure cut off at depth never contains a bare '...'", () => {
    const leaf = makeVar({ id: "LS_ROOT-A-B-C-D", name: "D", metaType: "structure" });
    const level3: VariableNode = { variable: leaf, children: [] };
    const level2: VariableNode = {
      variable: makeVar({ id: "LS_ROOT-A-B-C", name: "C", metaType: "structure" }),
      children: [level3],
    };
    const level1: VariableNode = {
      variable: makeVar({ id: "LS_ROOT-A-B", name: "B", metaType: "structure" }),
      children: [level2],
    };
    const root: VariableNode = {
      variable: makeVar({ id: "LS_ROOT-A", name: "A", metaType: "structure" }),
      children: [level1],
    };
    const { text } = renderDrill(root, "LS_ROOT-A", { depth: 1 });
    expectEveryOmissionIsAWellFormedElide(text);
    expectRetrievalCallsAreExecutable(text);
  });

  it("a 100,000-row table window never contains a bare '...'", () => {
    const table = makeVar({ id: "LT_ITEMS", name: "LT_ITEMS", metaType: "table", tableLines: 100_000 });
    const rows: VariableNode[] = Array.from({ length: 20 }, (_, i) => ({
      variable: makeVar({
        id: `LT_ITEMS[${i + 1}]`,
        name: `LT_ITEMS[${i + 1}]`,
        metaType: "structure",
      }),
    }));
    const text = renderTableRows(table, rows, { start: 1, end: 20 }, "LT_ITEMS");
    expectEveryOmissionIsAWellFormedElide(text);
    expectRetrievalCallsAreExecutable(text);
  });

  it("a scan report at the hard cap never contains a bare '...'", () => {
    const text = renderScanReport({ path: "LT_ITEMS", totalRows: 100_000, examined: SCAN_ROW_CAP, matched: 3 });
    expectEveryOmissionIsAWellFormedElide(text);
    expectRetrievalCallsAreExecutable(text);
  });

  it("the empty-body trap message never contains a bare '...'", () => {
    const text = renderEmptyBodyTrap({ path: "LT_ITEMS[99999]", tableLines: 15 });
    expectEveryOmissionIsAWellFormedElide(text);
    expectRetrievalCallsAreExecutable(text);
  });
});

// ---------------------------------------------------------------------------
// Tier 1 — survey never drops a NAME, even at a hostile budget
// ---------------------------------------------------------------------------

describe("renderSurvey — never elides a name", () => {
  it("keeps every variable name even when the budget forces every scalar to degrade", () => {
    const entries: SurveyEntry[] = Array.from({ length: 500 }, (_, i) =>
      ({
        variable: makeVar({
          id: `LV_V${i}`,
          name: `LV_V${i}`,
          metaType: "simple",
          value: "0123456789".repeat(20),
          length: 200,
        }),
      }) satisfies SurveyEntry,
    );
    const tinyBudget = 3_000;
    const result = renderSurvey(entries, { maxChars: tinyBudget });

    for (const e of entries) {
      expect(result.text).toContain(e.variable.name + ":");
    }
    // Every scalar had to degrade to make room — the degrade list must be complete, not partial.
    expect(result.degraded.length).toBe(entries.length);
    // The full (non-degraded) rendering would have been far larger than the degraded one.
    const undegraded = renderSurvey(entries, { maxChars: Number.MAX_SAFE_INTEGER });
    expect(undegraded.text.length).toBeGreaterThan(result.text.length);
  });

  it("lists complex values in the REACHABLE block, largest first, each with a copy-pasteable retrieval call", () => {
    const small = makeVar({ id: "LT_SMALL", name: "LT_SMALL", metaType: "table", tableLines: 3 });
    const big = makeVar({ id: "LT_BIG", name: "LT_BIG", metaType: "table", tableLines: 100_000 });
    const scalar = makeVar({ id: "LV_COUNT", name: "LV_COUNT", metaType: "simple", value: "42" });
    const result = renderSurvey([{ variable: scalar }, { variable: small }, { variable: big }]);

    expect(result.text).toContain("REACHABLE");
    const bigIdx = result.text.indexOf("LT_BIG");
    const smallIdx = result.text.indexOf("LT_SMALL", result.text.indexOf("REACHABLE"));
    // In the REACHABLE block, LT_BIG (100,000 rows) must be listed before LT_SMALL (3 rows).
    const reachableBlock = result.text.slice(result.text.indexOf("REACHABLE"));
    expect(reachableBlock.indexOf("LT_BIG")).toBeLessThan(reachableBlock.indexOf("LT_SMALL"));
    expect(reachableBlock).toContain("abap_debug_value");
    expect(bigIdx).toBeGreaterThanOrEqual(0);
    expect(smallIdx).toBeGreaterThanOrEqual(0);
    // Every variable name still appears in the main body too.
    expect(result.text).toContain("LV_COUNT: 42");
  });

  it("never drops a name even when a single variable's degraded line is itself larger than the budget", () => {
    const entries: SurveyEntry[] = [
      { variable: makeVar({ id: "LV_ONE", name: "LV_ONE", metaType: "simple", value: "x".repeat(5000) }) },
    ];
    const result = renderSurvey(entries, { maxChars: 10 });
    expect(result.text).toContain("LV_ONE:");
  });
});

// ---------------------------------------------------------------------------
// The empty-body traps (Trap A/B, Trap C) render as
// "check indices", never as "no data".
// ---------------------------------------------------------------------------

describe("renderEmptyBodyTrap", () => {
  it("Trap A (bare table id) reads as 'check your indices', not 'no data'", () => {
    const text = renderEmptyBodyTrap({ path: "LT_ITEMS", tableLines: 15 });
    expect(text).toContain('does NOT mean "no data"');
    expect(text.toLowerCase()).toContain("check your indices");
    expect(text).toContain("LT_ITEMS[1]");
  });

  it("Trap B (out-of-range row) names TABLE_LINES and the valid range", () => {
    const text = renderEmptyBodyTrap({ path: "LT_ITEMS[16]", tableLines: 15 });
    expect(text).toContain('does NOT mean "no data"');
    expect(text).toContain("TABLE_LINES=15");
    expect(text).toContain("[1, 15]");
  });

  it("without a known TABLE_LINES still reads as 'check indices', never asserts absence of data", () => {
    const text = renderEmptyBodyTrap({ path: "@GLOBALS" });
    expect(text).toContain('does NOT mean "no data"');
    expect(text.toLowerCase()).not.toContain("no variables");
  });
});

// ---------------------------------------------------------------------------
// Never scan silently
// ---------------------------------------------------------------------------

describe("renderScanReport", () => {
  it("names the unexamined remainder explicitly, with a continue call and breakpoint advice", () => {
    const text = renderScanReport({ path: "LT_ITEMS", totalRows: 100_000, examined: 5_000, matched: 2 });
    expect(text).toContain("95000 rows NOT examined");
    expect(text).toContain('not "no more matches"');
    expect(text).toContain(buildRetrievalCall("LT_ITEMS", retrievalWindow(5001, 100_000)));
    expect(text.toLowerCase()).toContain("breakpoint");
  });

  it("omits the unexamined-remainder warning when the scan reached the end of the table", () => {
    const text = renderScanReport({ path: "LT_SMALL", totalRows: 10, examined: 10, matched: 1 });
    expect(text).not.toContain("NOT examined");
  });
});

// ---------------------------------------------------------------------------
// 100,000-row table: within budget, fully addressable
// ---------------------------------------------------------------------------

describe("100,000-row table rendering", () => {
  const table = makeVar({ id: "LT_ITEMS", name: "LT_ITEMS", metaType: "table", tableLines: 100_000 });
  const fetchedRows: VariableNode[] = Array.from({ length: 20 }, (_, i) => ({
    variable: makeVar({ id: `LT_ITEMS[${i + 1}]`, name: `LT_ITEMS[${i + 1}]`, metaType: "structure" }),
  }));

  it("renderTableRows stays within DEBUG_MAX_CHARS and remains fully addressable", () => {
    const text = renderTableRows(table, fetchedRows, { start: 1, end: 20 }, "LT_ITEMS");
    expect(text.length).toBeLessThan(DEBUG_MAX_CHARS);
    expect(text).toContain("100000");
    for (let i = 1; i <= 20; i++) expect(text).toContain(`[${i}]`);
    expect(text).toContain(buildRetrievalCall("LT_ITEMS", retrievalWindow(21, 100_000)));
  });

  it("renderDrill on the table root with a row window produces the same guarantee end-to-end", () => {
    const node: VariableNode = { variable: table, children: fetchedRows };
    const { text } = renderDrill(node, "LT_ITEMS", { rows: { start: 1, end: 20 } });
    expect(text.length).toBeLessThan(DEBUG_MAX_CHARS);
    expect(text).toContain("100000");
    expect(text).toContain("abap_debug_value");
  });

  it("a row deep in the table (e.g. row 99,999) is addressable via a single retrieval call", () => {
    const call = buildRetrievalCall("LT_ITEMS[99999]-MATERIAL");
    expect(call).toBe(`abap_debug_value({ stateId: "${STATE_ID_PLACEHOLDER}", path: "LT_ITEMS[99999]-MATERIAL" })`);
    expect(parsePath("LT_ITEMS[99999]-MATERIAL").steps).toEqual([
      { kind: "index", value: 99999 },
      { kind: "component", name: "MATERIAL" },
    ]);
  });

  it("appears in a survey's REACHABLE block as <tab 100000 rows> with a clamped 1-20 first-page call", () => {
    const result = renderSurvey([{ variable: table }]);
    expect(result.text).toContain("<tab 100000 rows>");
    expect(result.text).toContain(buildRetrievalCall("LT_ITEMS", retrievalWindow(1, 20)));
  });
});

// ---------------------------------------------------------------------------
// describeComplex / renderScalar / isComplex — the stub vocabulary
// ---------------------------------------------------------------------------

describe("describeComplex — the three complete-information stubs", () => {
  it("renders a table as <tab N rows>", () => {
    const v = makeVar({ id: "LT_X", name: "LT_X", metaType: "table", tableLines: 15 });
    expect(describeComplex(v)).toBe("<tab 15 rows>");
  });

  it("renders a structure with a known component count as 'struct, N comp'", () => {
    const v = makeVar({ id: "LS_X", name: "LS_X", metaType: "structure" });
    expect(describeComplex(v, 7)).toBe("struct, 7 comp");
  });

  it("renders a structure with an unknown component count as plain 'struct'", () => {
    const v = makeVar({ id: "LS_X", name: "LS_X", metaType: "structure" });
    expect(describeComplex(v)).toBe("struct");
  });

  it("renders an object reference with its address, extracted from the value or hex fallback", () => {
    const fromValue = makeVar({ id: "LO_X", name: "LO_X", metaType: "objectref", value: "\\CLASS=LCL_FOO 0xDEADBEEF" });
    expect(describeComplex(fromValue)).toBe("objectref → 0xDEADBEEF");

    const fromHex = makeVar({ id: "LO_Y", name: "LO_Y", metaType: "objectref", hexValue: "CAFEBABE" });
    expect(describeComplex(fromHex)).toBe("objectref → 0xCAFEBABE");
  });

  it("isComplex is a negative test — an unrecognised meta type still counts as complex", () => {
    expect(isComplex("simple")).toBe(false);
    expect(isComplex("string")).toBe(false);
    expect(isComplex("boxedcomp")).toBe(false);
    expect(isComplex("anonymcomp")).toBe(false);
    expect(isComplex("unknown")).toBe(false);
    expect(isComplex("structure")).toBe(true);
    expect(isComplex("table")).toBe(true);
    expect(isComplex("some-future-meta-type")).toBe(true);
  });
});

describe("renderScalar", () => {
  it("renders a complete value verbatim, with no marker at all", () => {
    const v = makeVar({ id: "LV_COUNT", name: "LV_COUNT", metaType: "simple", value: "42" });
    expect(renderScalar(v)).toBe("42");
  });

  it("renders an incomplete value with the single sanctioned truncation form", () => {
    const v = makeVar({
      id: "LV_TEXT",
      name: "LV_TEXT",
      metaType: "string",
      value: "Hello wor",
      length: 5000,
      isValueIncomplete: true,
    });
    expect(renderScalar(v)).toBe("'Hello wor…' [truncated, 5000 chars]");
  });
});

describe("renderInline", () => {
  it("dispatches scalars to renderScalar and complex values to describeComplex", () => {
    const scalar = makeVar({ id: "LV_COUNT", name: "LV_COUNT", metaType: "simple", value: "42" });
    const table = makeVar({ id: "LT_X", name: "LT_X", metaType: "table", tableLines: 5 });
    expect(renderInline(scalar)).toBe("LV_COUNT: 42");
    expect(renderInline(table)).toBe("LT_X: <tab 5 rows>");
  });
});

// ---------------------------------------------------------------------------
// Offline fixture: variables.xml + child-variables.xml
// ---------------------------------------------------------------------------

describe("offline fixture — variables.xml + child-variables.xml", () => {
  it("renders the real getVariables fixture's two rows without dropping either name", () => {
    const variables = parseVariablesResponse(fixture("variables.xml"));
    expect(variables.map((v) => v.name)).toEqual(["LV_COUNT", "LS_DATA"]);

    const result = renderSurvey(variables.map((variable) => ({ variable })));
    expect(result.text).toContain("LV_COUNT: 42");
    expect(result.text).toContain("LS_DATA: struct");
  });

  it("withChildren attaches @ROOT's children from the real getChildVariables fixture", () => {
    const { hierarchies, variables } = parseChildVariablesResponse(fixture("child-variables.xml"));
    const rootVar = makeVar({ id: "@ROOT", name: "@ROOT", metaType: "structure" });
    const node = withChildren(rootVar, { hierarchies, variables });

    expect(node.children?.map((c) => c.variable.name).sort()).toEqual(["LS_DATA", "LV_COUNT"]);
  });

  it("throws (never silently drops) when a hierarchy edge points at a variable id missing from the row set", () => {
    const rootVar = makeVar({ id: "@ROOT", name: "@ROOT", metaType: "structure" });
    expect(() =>
      withChildren(rootVar, {
        hierarchies: [{ parentId: "@ROOT", childId: "GHOST", childName: "GHOST" }],
        variables: [],
      }),
    ).toThrow(/GHOST/);
  });
});


// ---------------------------------------------------------------------------
// Retrieval calls must be EXECUTABLE — derived from debugValueInputSchema
// ---------------------------------------------------------------------------

describe("buildRetrievalCall emits a call the tool can actually accept", () => {
  it("uses only parameter names present in debugValueInputSchema, and every required one", () => {
    // Sanity: the schema really was read, not assumed.
    expect(DEBUG_VALUE_SCHEMA_KEYS).toContain("path");
    expect(DEBUG_VALUE_SCHEMA_KEYS).not.toContain("rows");
    expect(DEBUG_VALUE_REQUIRED_KEYS).toEqual(expect.arrayContaining(["stateId", "path"]));

    for (const call of [
      buildRetrievalCall("LT_ITEMS"),
      buildRetrievalCall("LT_ITEMS", retrievalWindow(1, 20)),
      buildRetrievalCall("LT_ITEMS", retrievalWindow(16, 10_000), "ST-42"),
      buildRetrievalCall("LT_ITEMS[99999]-MATERIAL", undefined, "ST-42"),
    ]) {
      expectRetrievalCallsAreExecutable(call);
    }
  });

  it("converts a 1-based inclusive row window to from/count without changing which rows it names", () => {
    expect(retrievalWindow(16, 10_000)).toEqual({ from: 16, count: 9985 });
    expect(retrievalWindow(7, 7)).toEqual({ from: 7, count: 1 });
    expect(retrievalWindow(5, 500, 10)).toEqual({ from: 5, count: 6 }); // clamped to the total
    expect(retrievalWindow(50, 60, 10)).toBeUndefined(); // wholly past the end: no window at all
  });

  it("carries a fill-in stateId slot when the renderer was given none, never omits the required key", () => {
    expect(buildRetrievalCall("LT")).toContain(`stateId: "${STATE_ID_PLACEHOLDER}"`);
    expect(buildRetrievalCall("LT", undefined, "ST-7")).toContain(`stateId: "ST-7"`);
  });

  it("every retrieval call emitted by a real render is executable", () => {
    const table = makeVar({ id: "LT", name: "LT", metaType: "table", tableLines: 100_000 });
    const rows: VariableNode[] = Array.from({ length: 200 }, (_, i) => ({
      variable: makeVar({ id: `LT[${i + 1}]`, name: `[${i + 1}]`, value: `row ${i + 1}` }),
    }));
    expectRetrievalCallsAreExecutable(renderDrill({ variable: table, children: rows }, "LT", {
      rows: { start: 1, end: 200 },
      maxChars: 200,
    }).text);
    expectRetrievalCallsAreExecutable(renderTableRows(table, rows, { start: 1, end: 200 }, "LT"));
    expectRetrievalCallsAreExecutable(
      renderSurvey(
        Array.from({ length: 400 }, (_, i) => ({
          variable: makeVar({ id: `LT_${i}`, name: `LT_${i}`, metaType: "table", tableLines: 1_000 + i }),
        })),
        { maxChars: 2_000 },
      ).text,
    );
  });
});

// ---------------------------------------------------------------------------
// renderDrill under a char budget — the path that had NO coverage at all
// ---------------------------------------------------------------------------

describe("renderDrill honours maxChars without deleting the table", () => {
  const bigTable = () => {
    const table = makeVar({ id: "LT", name: "LT", metaType: "table", tableLines: 100_000 });
    const rows: VariableNode[] = Array.from({ length: 200 }, (_, i) => ({
      variable: makeVar({ id: `LT[${i + 1}]`, name: `[${i + 1}]`, value: `row ${i + 1}` }),
    }));
    return { variable: table, children: rows } satisfies VariableNode;
  };

  it("a 100k-row table windowed to 200 rows at maxChars 200 keeps its header instead of collapsing to one elide", () => {
    // The defect: `lines = [renderTableRows(...)]` was ONE multi-line string, so the
    // budget loop dropped it atomically and the whole render became
    // `[1 lines not shown — retrieve with: abap_debug_value({ path: "LT" })]`.
    const { text } = renderDrill(bigTable(), "LT", { rows: { start: 1, end: 200 }, maxChars: 200 });
    expect(text).toMatch(/^LT: <tab 100000 rows>/);
    expect(text).not.toMatch(/^\[1 lines not shown/);
    expectEveryOmissionIsAWellFormedElide(text);
  });

  it("names a real count for the rows it dropped, never a meaningless '1 lines'", () => {
    const { text } = renderDrill(bigTable(), "LT", { rows: { start: 1, end: 200 }, maxChars: 200 });
    expect(text).toContain("200 rows not shown");
    expect(text).toContain("99800 rows not shown");
  });

  it("every suggested call makes PROGRESS — it asks for strictly less than the window that overflowed", () => {
    // An elide whose call re-renders the same over-budget output is not a fix.
    const { text } = renderDrill(bigTable(), "LT", { rows: { start: 1, end: 200 }, maxChars: 200 });
    const calls = harvestRetrievalCalls(text).map((c) => c.call);
    expect(calls.length).toBeGreaterThan(0);
    // The block covering the dropped rows must narrow to a single addressable row...
    expect(calls.some((c) => /path: "LT\[\d+\]"/.test(c))).toBe(true);
    // ...and no call may re-request the same 1-200 window that just overflowed.
    for (const c of calls) expect(c).not.toContain("from: 1, count: 200");
  });

  it("a generous budget renders the rows themselves", () => {
    const { text } = renderDrill(bigTable(), "LT", { rows: { start: 1, end: 200 }, maxChars: 30_000 });
    expect(text).toContain("[1]");
    expect(text).toContain("[200]");
    expectEveryOmissionIsAWellFormedElide(text);
  });
});

// ---------------------------------------------------------------------------
// renderTableRows must never drop a fetched row
// ---------------------------------------------------------------------------

describe("renderTableRows accounts for every fetched row", () => {
  it("a row whose id does not end in [N] is surfaced as an anomaly, never filtered into silence", () => {
    // The defect: `.filter()` on rowIndexOf === -1 discarded it with no elide, so a
    // 1-row table rendered as a header and nothing else — empty but successful.
    const table = makeVar({ id: "LT", name: "LT", metaType: "table", tableLines: 1 });
    const rows: VariableNode[] = [{ variable: makeVar({ id: "LT_ROW_A", name: "ROW_A", value: "hello" }) }];
    const text = renderTableRows(table, rows, { start: 1, end: 1 }, "LT");
    expect(text).toContain("LT_ROW_A");
    expect(text.split("\n").length).toBeGreaterThan(1);
    expectRetrievalCallsAreExecutable(text);
  });

  it("a window clamped against the real row count says so, and names what was rendered", () => {
    // The defect: total=10 with window 50-60 silently became `showing 10-10`, an elide
    // covered rows 1-9, and row 10 was rendered nowhere and named nowhere.
    const table = makeVar({ id: "LT", name: "LT", metaType: "table", tableLines: 10 });
    const rows: VariableNode[] = Array.from({ length: 10 }, (_, i) => ({
      variable: makeVar({ id: `LT[${i + 1}]`, name: `[${i + 1}]`, value: `v${i + 1}` }),
    }));
    const text = renderTableRows(table, rows, { start: 50, end: 60 }, "LT");
    expect(text).toMatch(/clamp/i);
    expect(text).toContain("50");
    expect(text).toContain("60");
    expect(text).toContain("[10]"); // the row that used to vanish
    expectEveryOmissionIsAWellFormedElide(text);
  });

  it("no fetched row disappears: every row is either rendered or covered by a counted elide", () => {
    const table = makeVar({ id: "LT", name: "LT", metaType: "table", tableLines: 50 });
    const rows: VariableNode[] = Array.from({ length: 50 }, (_, i) => ({
      variable: makeVar({ id: `LT[${i + 1}]`, name: `[${i + 1}]`, value: `v${i + 1}` }),
    }));
    const text = renderTableRows(table, rows, { start: 10, end: 20 }, "LT");
    for (let i = 10; i <= 20; i++) expect(text).toContain(`[${i}]`);
    const counts = [...text.matchAll(/\[(\d+) rows not shown/g)].map((m) => Number(m[1]));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(39); // 9 before + 30 after
  });
});

// ---------------------------------------------------------------------------
// Budget properties — over a range of budgets and input sizes
// ---------------------------------------------------------------------------

describe("budget properties", () => {
  const scalars = (n: number, valueLen: number): SurveyEntry[] =>
    Array.from({ length: n }, (_, i) => ({
      variable: makeVar({
        id: `V${String(i).padStart(4, "0")}`,
        name: `V${String(i).padStart(4, "0")}`,
        value: "x".repeat(valueLen),
        length: valueLen,
      }),
    }));

  const tables = (n: number): SurveyEntry[] =>
    Array.from({ length: n }, (_, i) => ({
      variable: makeVar({
        id: `LT_${String(i).padStart(4, "0")}`,
        name: `LT_${String(i).padStart(4, "0")}`,
        metaType: "table",
        tableLines: 1_000 + i,
      }),
    }));

  it("degrading NEVER lengthens the survey, across budgets and input sizes", () => {
    // The defect: 400 one-char scalars were 3,108 chars in full form and 30,998 with
    // maxChars 2000 — the elide block was longer than the value it replaced.
    for (const n of [1, 10, 400]) {
      for (const valueLen of [1, 5, 300]) {
        const entries = scalars(n, valueLen);
        const full = renderSurvey(entries).text.length;
        for (const maxChars of [50, 200, 2_000, 20_000]) {
          const budgeted = renderSurvey(entries, { maxChars }).text.length;
          expect(budgeted, `n=${n} valueLen=${valueLen} maxChars=${maxChars}`).toBeLessThanOrEqual(full);
        }
      }
    }
  });

  it("degraded[] lists only entries that were actually shortened", () => {
    // It previously reported 400 names as degraded after having LENGTHENED them.
    const entries = scalars(400, 1);
    const { degraded } = renderSurvey(entries, { maxChars: 2_000 });
    const full = renderSurvey(entries).text.length;
    const budgeted = renderSurvey(entries, { maxChars: 2_000 }).text.length;
    if (degraded.length > 0) expect(budgeted).toBeLessThan(full);
  });

  it("a hostile budget still leaves EVERY name visible — the invariant that outranks the budget", () => {
    for (const entries of [scalars(400, 300), tables(400)]) {
      for (const maxChars of [0, 1, 50, 200, 2_000]) {
        const { text } = renderSurvey(entries, { maxChars });
        const missing = entries.filter((e) => !text.includes(e.variable.name));
        expect(missing.map((e) => e.variable.name), `maxChars=${maxChars}`).toEqual([]);
      }
    }
  });

  it("complex entries participate in the budget instead of ignoring it", () => {
    // The defect: 400 tables at maxChars 2000 produced 37,307 chars with degraded: [].
    const { text } = renderSurvey(tables(400), { maxChars: 2_000 });
    expect(text.length).toBeLessThan(10_000); // was 37,307
    // The floor is the names themselves, which are never dropped; the budget may be
    // exceeded ONLY by that irreducible remainder, never by decorative blocks.
    const nameFloor = tables(400).reduce((n, e) => n + e.variable.name.length + 1, 0);
    expect(text.length).toBeLessThan(nameFloor * 2);
  });

  it("output stays line-oriented so src/compact.ts can trim it by lines", () => {
    for (const maxChars of [0, 200, 2_000]) {
      const { text } = renderSurvey(tables(50), { maxChars });
      expect(text).not.toContain("\n\n\n");
      expect(text.split("\n").every((l) => l.length < 4_000)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Path safety — unsafe indices are REJECTED, never coerced
// ---------------------------------------------------------------------------

describe("path indices are rejected rather than silently coerced", () => {
  it("an index beyond MAX_SAFE_INTEGER is rejected, not rounded to a different row", () => {
    // The defect: Number.isInteger(1e20) is true, so A[99999999999999999999] parsed and
    // formatPath returned A[100000000000000000000] — a DIFFERENT row.
    expect(() => parsePath("A[99999999999999999999]")).toThrow(PathSyntaxError);
    expect(() => parsePath(`A[${Number.MAX_SAFE_INTEGER}]`)).not.toThrow();
    expect(() => parsePath("A[9007199254740992]")).toThrow(PathSyntaxError);
  });

  it("a non-canonical index spelling is rejected so the round-trip cannot lie", () => {
    expect(() => parsePath("A[007]")).toThrow(PathSyntaxError);
    expect(() => parsePath("A[0]")).toThrow(PathSyntaxError);
    expect(() => parsePath("A[+5]")).toThrow(PathSyntaxError);
    expect(() => parsePath("A[-1]")).toThrow(PathSyntaxError);
    expect(() => parsePath("A[1e3]")).toThrow(PathSyntaxError);
    expect(() => parsePath("A[0x10]")).toThrow(PathSyntaxError);
    expect(() => parsePath("A[ 1]")).toThrow(PathSyntaxError);
  });

  it("formatPath(parsePath(s)) === s for every input that parses — no exceptions", () => {
    const corpus = [
      "@ROOT", "@GLOBALS", "@LOCALS", "A", "AB", "A-B", "A-B-C", "A-B-C-D",
      "A[1]", "A[2]", "A[20]", "A[99999]", "A[100000]", "A[9007199254740991]",
      "A[9007199254740992]", "A[0]", "A[-1]", "A[+5]", "A[1e3]", "A[0x10]",
      "A[ 1]", "A[1 ]", "A[]", "A[1", "A1]", "A[007]", "A[00]", "A[01]",
      "A[99999999999999999999]", "A[1]-B", "A-B[3]", "A-B[3]-C",
      "LT_ITEMS[99999]-MATERIAL", "@LOCALS-X", "@LOCALS-X[7]", "", "-", "[1]",
      "A--B", "A-", "-A", "A[1.5]", "ZZZ_LONG_NAME_1-SUB_2[42]-F",
      "A[12345678901234x]", "A[2147483647]",
    ];
    let parsed = 0;
    for (const s of corpus) {
      let p;
      try {
        p = parsePath(s);
      } catch {
        continue;
      }
      parsed++;
      expect(formatPath(p), `round-trip failed for ${JSON.stringify(s)}`).toBe(s);
    }
    expect(parsed).toBeGreaterThan(15); // the corpus really does exercise the happy path
  });
});

// ---------------------------------------------------------------------------
// Path error messages carry no unmarked truncation
// ---------------------------------------------------------------------------

describe("path error messages never truncate silently", () => {
  it("does not report a segment cut mid-token by a bare slice", () => {
    // The defect: raw.slice(i, Math.min(i + 12, n)) reported segment "[12345678901"
    // for A[12345678901234x] — exactly the raw truncate this module forbids.
    let err: PathSyntaxError | undefined;
    try {
      parsePath("A[12345678901234x]");
    } catch (e) {
      err = e as PathSyntaxError;
    }
    expect(err).toBeInstanceOf(PathSyntaxError);
    expect(err!.segment).not.toBe("[12345678901");
    expect(err!.message).not.toContain("12345678901");
    expect(err!.message.length).toBeGreaterThan(0);
  });

  it("stays bounded for a pathological path without cutting anything unmarked", () => {
    let err: PathSyntaxError | undefined;
    try {
      parsePath(`A[${"1".repeat(10_000)}x]`);
    } catch (e) {
      err = e as PathSyntaxError;
    }
    expect(err).toBeInstanceOf(PathSyntaxError);
    // Bounded by construction — it reports counts and one character, so there is no
    // long string present that would need cutting in the first place.
    expect(err!.message.length).toBeLessThan(300);
    expect(err!.message).not.toContain("1111111111");
    expect(err!.segment.length).toBeLessThan(300);
  });

  it("validatePath surfaces the same bounded message without throwing", () => {
    const r = validatePath("A[99999999999999999999]");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message.length).toBeGreaterThan(0);
      expect(r.message.length).toBeLessThan(300);
    }
  });
});

// ---------------------------------------------------------------------------
// `tableLines` went from `number` to `number | undefined` (src/debug/types.ts):
// a missing/malformed TABLE_LINES attribute must render differently from a
// genuine 0-row table — "row count unavailable" is not "table is empty".
// `makeVar`'s `tableLines: overrides.tableLines ?? 0` collapses an explicit
// `undefined` back to 0, so an unknown-count fixture is built by spreading
// over a `makeVar` result rather than passing `tableLines: undefined` through it.
// ---------------------------------------------------------------------------

describe("describeComplex — unknown vs genuinely-zero row count", () => {
  it("renders '<tab ? rows>' for an unknown count and '<tab 0 rows>' for a genuine zero, and the two never match", () => {
    const zero = makeVar({ id: "LT_ZERO", name: "LT_ZERO", metaType: "table", tableLines: 0 });
    const unknown = { ...makeVar({ id: "LT_UNKNOWN", name: "LT_UNKNOWN", metaType: "table" }), tableLines: undefined };

    const zeroText = describeComplex(zero);
    const unknownText = describeComplex(unknown);

    expect(zeroText).toBe("<tab 0 rows>");
    expect(unknownText).toBe("<tab ? rows>");
    expect(unknownText).not.toBe(zeroText);
    expect(unknownText).not.toContain("0 rows");
    expect(unknownText).not.toContain("undefined");
  });
});

describe("reachableWindow (via renderSurvey's REACHABLE block) — unknown vs genuinely-zero row count", () => {
  it("offers the first 20-row page for an unknown count but no window at all for a genuinely-empty table", () => {
    const zero = makeVar({ id: "LT_ZERO", name: "LT_ZERO", metaType: "table", tableLines: 0 });
    const unknown = { ...makeVar({ id: "LT_UNKNOWN", name: "LT_UNKNOWN", metaType: "table" }), tableLines: undefined };
    const result = renderSurvey([{ variable: zero }, { variable: unknown }]);
    const reachableBlock = result.text.slice(result.text.indexOf("REACHABLE"));
    const zeroLine = reachableBlock.split("\n").find((l) => l.includes("LT_ZERO"));
    const unknownLine = reachableBlock.split("\n").find((l) => l.includes("LT_UNKNOWN"));

    expect(zeroLine).toBeDefined();
    expect(unknownLine).toBeDefined();

    // Unknown count: we do NOT know it is empty, so the first page stays offered.
    // `count` must never be 0 — a `count: 0` is a hard Zod rejection downstream.
    expect(unknownLine).toContain("from: 1");
    expect(unknownLine).toContain("count: 20");
    expect(unknownLine).not.toContain("count: 0");

    // Genuinely empty: nothing to read, so no from/count is offered at all.
    expect(zeroLine).not.toContain("from:");
    expect(zeroLine).not.toContain("count:");
  });
});

describe("REACHABLE ordering — unknown counts sort last, deterministically", () => {
  it("sorts known counts largest-first with the unknown count last, regardless of input order", () => {
    const big = makeVar({ id: "LT_BIG", name: "LT_BIG", metaType: "table", tableLines: 20 });
    const mid = makeVar({ id: "LT_MID", name: "LT_MID", metaType: "table", tableLines: 5 });
    const zero = makeVar({ id: "LT_ZERO", name: "LT_ZERO", metaType: "table", tableLines: 0 });
    const unknown = { ...makeVar({ id: "LT_UNKNOWN", name: "LT_UNKNOWN", metaType: "table" }), tableLines: undefined };

    const orderA = renderSurvey([{ variable: big }, { variable: mid }, { variable: zero }, { variable: unknown }]);
    const orderB = renderSurvey([{ variable: unknown }, { variable: zero }, { variable: mid }, { variable: big }]);

    const namesInOrder = (text: string): string[] => {
      const block = text.slice(text.indexOf("REACHABLE"));
      return ["LT_BIG", "LT_MID", "LT_ZERO", "LT_UNKNOWN"]
        .map((name) => ({ name, idx: block.indexOf(name) }))
        .sort((a, b) => a.idx - b.idx)
        .map((e) => e.name);
    };

    const expected = ["LT_BIG", "LT_MID", "LT_ZERO", "LT_UNKNOWN"];
    expect(namesInOrder(orderA.text)).toEqual(expected);
    expect(namesInOrder(orderB.text)).toEqual(expected);
  });
});

describe("buildTableRowsRender (via renderTableRows) — unknown vs genuinely-zero row count", () => {
  it("renders the requested window unclamped for an unknown count, unlike a table with a known total", () => {
    const rows: VariableNode[] = Array.from({ length: 3 }, (_, i) => ({
      variable: makeVar({ id: `LT_X[${i + 1}]`, name: `LT_X[${i + 1}]`, metaType: "structure" }),
    }));

    const unknownTable = { ...makeVar({ id: "LT_X", name: "LT_X", metaType: "table" }), tableLines: undefined };
    const unknownText = renderTableRows(unknownTable, rows, { start: 1, end: 3 }, "LT_X");

    expect(unknownText).toContain("LT_X: <tab ? rows> — showing 1-3");
    expect(unknownText).not.toContain("window clamped");
    // All 3 requested rows were supplied, so nothing was omitted at all — no
    // leading/trailing elide() block of any kind.
    expect(unknownText).not.toContain("not shown");
    expect(unknownText).not.toContain("NaN");
    expect(unknownText).not.toContain("undefined");

    // The identical window and rows against a table with a KNOWN total of 10
    // DOES report the 7 remaining rows — proving the unknown branch's silence
    // above is a real behavioural difference, not just an empty fixture.
    const knownTable = makeVar({ id: "LT_X", name: "LT_X", metaType: "table", tableLines: 10 });
    const knownText = renderTableRows(knownTable, rows, { start: 1, end: 3 }, "LT_X");
    expect(knownText).toContain("<tab 10 rows>");
    expect(knownText).toContain("not shown");
  });

  it("still renders '<tab 0 rows>' for a genuinely-empty table, exactly as before", () => {
    const zeroTable = makeVar({ id: "LT_ZERO", name: "LT_ZERO", metaType: "table", tableLines: 0 });
    const text = renderTableRows(zeroTable, [], { start: 1, end: 5 }, "LT_ZERO");
    expect(text).toBe("LT_ZERO: <tab 0 rows>");
  });
});

// ===========================================================================
// DRIFT LOCK — render.ts's private `formatTrailingSignNumeric` vs
// xml-response.ts's canonical `formatAbapNumeric`, over the live captures.
//
// `src/debug/render.ts` (the doc comment on `TRAILING_SIGN_TYPES`) states that
// the duplication between the two sign parsers is safe because "a test in
// test/debug-render.test.ts … runs both this function and xml-response.ts's
// canonical formatAbapNumeric over every numeric row in the live captures and
// asserts they agree". Until now no such test existed and the claim was empty.
// This is it.
//
// `formatTrailingSignNumeric` is not exported, so it is reached through its
// only caller, `renderScalar`, which for a `P`/`I` row returns the helper's
// output when the helper accepts the value and falls back to the raw bytes when
// it refuses. The equivalent statement over the exported surface is therefore:
//
//     renderScalar(row) === (formatAbapNumeric(row.value) ?? row.value)
//
// Bytes only: every row below is read from `test/fixtures/live-captured/`, not
// from `fixtures/debugger/` (whose `variables.xml` is proven to contradict the
// wire) and not from `makeVar`.
// ===========================================================================

const LIVE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const live = (name: string) => readFileSync(join(LIVE_DIR, name), "utf8");

/**
 * Every live capture carrying `STPDA_ADT_VARIABLE` rows, parsed with whichever of the two
 * envelope parsers its body matches. Discovered from the directory rather than hardcoded, so a
 * capture added later is swept automatically; the try/fallback dispatch is safe because each
 * parser throws on the other's shape rather than returning `[]`.
 */
function liveVariableRows(): { file: string; row: DebugVariable }[] {
  const out: { file: string; row: DebugVariable }[] = [];
  for (const file of readdirSync(LIVE_DIR).filter((f) => f.endsWith(".xml")).sort()) {
    const xml = live(file);
    if (!xml.includes("<STPDA_ADT_VARIABLE>")) continue;
    let rows: DebugVariable[];
    try {
      rows = parseVariablesResponse(xml);
    } catch {
      rows = parseChildVariablesResponse(xml).variables;
    }
    for (const row of rows) out.push({ file, row });
  }
  return out;
}

const LIVE_ROWS = liveVariableRows();
const LIVE_NUMERIC = LIVE_ROWS.filter(({ row }) => row.technicalType === "P" || row.technicalType === "I");
const LIVE_CHARLIKE = LIVE_ROWS.filter(({ row }) => row.technicalType === "C" || row.technicalType === "D");

describe("DRIFT LOCK: renderScalar's sign parser vs xml-response.ts's formatAbapNumeric (live captures)", () => {
  it("corpus guard: the sweep really covers the 35 P/I and 42 C/D rows the captures contain", () => {
    // Without this, a discovery bug that silently found zero rows would make every sweep below
    // pass vacuously — which is exactly the failure mode this whole block exists to close.
    expect(LIVE_ROWS).toHaveLength(87);
    expect(LIVE_NUMERIC).toHaveLength(35);
    expect(LIVE_CHARLIKE).toHaveLength(42);
  });

  it("the two implementations agree on EVERY numeric row in the live captures", () => {
    const disagreements = LIVE_NUMERIC.map(({ file, row }) => ({
      file,
      id: row.id,
      technicalType: row.technicalType,
      value: row.value,
      renderScalar: renderScalar(row),
      formatAbapNumeric: formatAbapNumeric(row.value),
    })).filter((d) => d.renderScalar !== (d.formatAbapNumeric ?? d.value));

    // Reported as a list rather than a per-row assertion so a real divergence names every
    // offending row and both outputs at once, instead of stopping at the first.
    expect(disagreements).toEqual([]);
  });

  it("neither implementation REFUSES a real numeric row (agreement on `undefined` would be vacuous)", () => {
    for (const { file, row } of LIVE_NUMERIC) {
      expect(formatAbapNumeric(row.value), `${file} ${row.id} VALUE=[${row.value}]`).toBeDefined();
      // A refusal inside renderScalar shows up as the raw bytes coming back, trailing sign column
      // and all — so this also proves the agreement above is on formatted output, not fallback.
      expect(renderScalar(row), `${file} ${row.id} VALUE=[${row.value}]`).not.toBe(row.value);
    }
  });

  it("agrees on the rows that actually discriminate: the two captured negatives", () => {
    const neg = LIVE_NUMERIC.filter(({ row }) => row.value.trimEnd().endsWith("-"));
    // 223 and 224 each carry the P and the I negative — four rows, two distinct values.
    expect(new Set(neg.map(({ row }) => row.value))).toEqual(new Set(["123.45-", "42-"]));
    for (const { file, row } of neg) {
      expect(renderScalar(row), `${file} ${row.id}`).toBe(formatAbapNumeric(row.value));
      expect(renderScalar(row), `${file} ${row.id}`).toMatch(/^-/); // leading minus, sign preserved
    }
    expect(renderScalar(neg.find(({ row }) => row.technicalType === "P")!.row)).toBe("-123.45");
    expect(renderScalar(neg.find(({ row }) => row.technicalType === "I")!.row)).toBe("-42");
  });

  it("agrees on scale: two P(8) rows with one shared HEX_VALUE still render 0.00 and 0.0000", () => {
    const total = LIVE_ROWS.find(({ file, row }) => file === "027-vars-char-and-packed.xml" && row.id === "LV_GRAND_TOTAL")!.row;
    const avg = LIVE_ROWS.find(({ file, row }) => file === "027-vars-char-and-packed.xml" && row.id === "LV_AVERAGE")!.row;
    expect(total.hexValue).toBe(avg.hexValue);
    expect([renderScalar(total), renderScalar(avg)]).toEqual(["0.00", "0.0000"]);
    expect([formatAbapNumeric(total.value), formatAbapNumeric(avg.value)]).toEqual(["0.00", "0.0000"]);
  });

  it("C and D rows never enter the numeric path — renderScalar emits them byte-for-byte", () => {
    for (const { file, row } of LIVE_CHARLIKE) {
      // The padding IS the value (len(VALUE) === LENGTH on all 42), so trimming it is data loss.
      expect(renderScalar(row), `${file} ${row.id} VALUE=[${row.value}]`).toBe(row.value);
      expect(renderScalar(row).length, `${file} ${row.id}`).toBe(row.length);
    }
    // Including the ones a shape-based (rather than type-based) sign parser would happily eat:
    // a `D` date and a `C` client, both of which formatAbapNumeric accepts as bare strings.
    const date = LIVE_ROWS.find(({ row }) => row.technicalType === "D")!.row;
    expect(formatAbapNumeric(date.value)).toBe("20260111");
    expect(renderScalar(date)).toBe("20260111");
    const padded = LIVE_ROWS.find(({ file, row }) => file === "027-vars-char-and-packed.xml" && row.id === "LT_ITEMS[1]-ITEM_ID")!.row;
    expect(renderScalar(padded)).toBe("A001      ");
  });
});
