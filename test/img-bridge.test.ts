/**
 * Tests for `src/adt/img-bridge.ts` — bridge generation, transcript parsing,
 * and query-field validation for `abap_img`.
 *
 * Pure-function tests only, no connection/HTTP fake — mirrors the
 * `fpm-runtime.test.ts` / `fpm-tools.test.ts` split. Tool-surface behaviour
 * (rendering, paging, safety-ordering) lives in `test/img-tool.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { ERR_LINE_PREFIX } from "../src/adt/run.js";
import { ABAP_SOURCE_LINE_MAX, DDIC_ERR_PREFIX } from "../src/adt/ddic-bridge.js";
import {
  IMG_BRIDGE_CLASS,
  IMG_LINE_PREFIX,
  IMG_PAGE_MAX,
  imgBridgeClassName,
  imgBridgeSource,
  imgLikePattern,
  parseImgTranscript,
  validateImgQuery,
  type ImgMode,
  type ImgObjectKind,
  type ImgQuery,
} from "../src/adt/img-bridge.js";

function expectBadInput(fn: () => unknown): AbapError {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) {
      expect(e.code).toBe("BAD_INPUT");
      return e;
    }
    throw e;
  }
  throw new Error("expected fn() to throw a BAD_INPUT AbapError");
}

// Not exported by img-bridge.ts — kept here as a literal copy of the private
// KNOWN_OBJECT_KINDS list so the OBJ-kind-normalisation tests can loop over
// every recognised kind without reaching into module internals.
const KNOWN_OBJECT_KINDS: readonly ImgObjectKind[] = [
  "view",
  "cluster",
  "transaction",
  "table",
  "report",
  "customizing_object",
  "unknown",
];

const baseSearch = (over: Partial<ImgQuery & { mode: "search" }> = {}): ImgQuery => ({
  mode: "search",
  text: "FOO",
  language: "EN",
  offset: 0,
  limit: 25,
  ...over,
});
const baseShow = (over: Partial<ImgQuery & { mode: "show" }> = {}): ImgQuery => ({
  mode: "show",
  activity: "SIMG_ACT",
  language: "EN",
  ...over,
});
const baseTree = (over: Partial<ImgQuery & { mode: "tree" }> = {}): ImgQuery => ({
  mode: "tree",
  node: "SIMG_ROOT",
  language: "EN",
  offset: 0,
  limit: 25,
  ...over,
});
const baseObjects = (over: Partial<ImgQuery & { mode: "objects" }> = {}): ImgQuery => ({
  mode: "objects",
  object: "T001",
  language: "EN",
  ...over,
});

// ---------------------------------------------------------------------------
// Transcript grammar — one test per head
// ---------------------------------------------------------------------------

describe("parseImgTranscript — grammar", () => {
  it("parses TOTAL", () => {
    const t = parseImgTranscript(`${IMG_LINE_PREFIX}TOTAL n=[42]`);
    expect(t.total).toBe(42);
    expect(t.droppedLines).toBe(0);
  });

  it("parses PAGE with more=X as true", () => {
    const t = parseImgTranscript(`${IMG_LINE_PREFIX}PAGE offset=[25] limit=[25] more=[X]`);
    expect(t.page).toEqual({ offset: 25, limit: 25, more: true });
  });

  it("parses PAGE with more absent-of-X as false", () => {
    const t = parseImgTranscript(`${IMG_LINE_PREFIX}PAGE offset=[0] limit=[25] more=[]`);
    expect(t.page).toEqual({ offset: 0, limit: 25, more: false });
  });

  it("parses ACT", () => {
    const t = parseImgTranscript(`${IMG_LINE_PREFIX}ACT activity=[SIMG_ACT] objects=[3] nodes=[1] title=[Configure Foo]`);
    expect(t.activities).toEqual([{ activity: "SIMG_ACT", objects: 3, nodes: 1, title: "Configure Foo" }]);
  });

  it("parses APATH", () => {
    const t = parseImgTranscript(`${IMG_LINE_PREFIX}APATH activity=[SIMG_ACT] pos=[2] node=[SIMG_NODE] title=[Foo Bar]`);
    expect(t.path).toEqual([{ activity: "SIMG_ACT", position: 2, node: "SIMG_NODE", title: "Foo Bar" }]);
  });

  it("parses NODE (folder, with children count)", () => {
    const t = parseImgTranscript(
      `${IMG_LINE_PREFIX}NODE node=[N1] parent=[N0] kind=[folder] activity=[] children=[3] title=[Folder One]`,
    );
    expect(t.nodes).toEqual([{ node: "N1", parent: "N0", kind: "folder", activity: "", children: 3, title: "Folder One" }]);
  });

  it("parses NODE (activity leaf, children absent -> null)", () => {
    const t = parseImgTranscript(
      `${IMG_LINE_PREFIX}NODE node=[N2] parent=[N0] kind=[activity] activity=[SIMG_ACT] children=[] title=[Leaf]`,
    );
    expect(t.nodes[0]!.children).toBeNull();
    expect(t.nodes[0]!.kind).toBe("activity");
  });

  it("drops a NODE line with an unrecognised kind", () => {
    const t = parseImgTranscript(`${IMG_LINE_PREFIX}NODE node=[N1] parent=[N0] kind=[bogus] activity=[] children=[] title=[X]`);
    expect(t.nodes).toEqual([]);
    expect(t.droppedLines).toBe(1);
  });

  it("parses OBJ with a recognised kind", () => {
    const t = parseImgTranscript(`${IMG_LINE_PREFIX}OBJ activity=[SIMG_ACT] kind=[table] name=[T001] title=[Company Codes]`);
    expect(t.objects).toEqual([{ activity: "SIMG_ACT", kind: "table", name: "T001", title: "Company Codes" }]);
  });

  it("normalises an unrecognised OBJ kind to 'unknown' rather than dropping the row", () => {
    const t = parseImgTranscript(`${IMG_LINE_PREFIX}OBJ activity=[SIMG_ACT] kind=[frobnicator] name=[X] title=[Y]`);
    expect(t.objects).toEqual([{ activity: "SIMG_ACT", kind: "unknown", name: "X", title: "Y" }]);
    expect(t.droppedLines).toBe(0);
  });

  it("parses every recognised OBJ kind unchanged", () => {
    for (const kind of KNOWN_OBJECT_KINDS) {
      const t = parseImgTranscript(`${IMG_LINE_PREFIX}OBJ activity=[A] kind=[${kind}] name=[N] title=[T]`);
      expect(t.objects[0]!.kind).toBe(kind);
    }
  });

  it("parses TAB with clidep=X as client-dependent", () => {
    const t = parseImgTranscript(`${IMG_LINE_PREFIX}TAB object=[T001] table=[T001] clidep=[X] via=[DD02L] title=[Company Codes]`);
    expect(t.tables).toEqual([{ object: "T001", table: "T001", clientDependent: true, via: "DD02L", title: "Company Codes" }]);
  });

  it("parses TAB with clidep omitted as not client-dependent", () => {
    const t = parseImgTranscript(`${IMG_LINE_PREFIX}TAB object=[T001] table=[T001] clidep=[] via=[DD02L] title=[X]`);
    expect(t.tables[0]!.clientDependent).toBe(false);
  });

  it("parses FLD with key=X as a key field", () => {
    const t = parseImgTranscript(
      `${IMG_LINE_PREFIX}FLD table=[T001] field=[BUKRS] key=[X] pos=[1] type=[CHAR] len=[4] rollname=[BUKRS]`,
    );
    expect(t.fields).toEqual([
      { table: "T001", field: "BUKRS", key: true, position: 1, dataType: "CHAR", length: "4", dataElement: "BUKRS" },
    ]);
  });

  it("parses FLD with key omitted as not a key field", () => {
    const t = parseImgTranscript(
      `${IMG_LINE_PREFIX}FLD table=[T001] field=[BUTXT] key=[] pos=[2] type=[CHAR] len=[25] rollname=[BUTXT]`,
    );
    expect(t.fields[0]!.key).toBe(false);
  });

  it("parses DOC", () => {
    const t = parseImgTranscript(`${IMG_LINE_PREFIX}DOC activity=[SIMG_ACT] class=[D] name=[SIMG_ACT_DOC]`);
    expect(t.docs).toEqual([{ activity: "SIMG_ACT", docClass: "D", docName: "SIMG_ACT_DOC" }]);
  });

  it("parses NOTE", () => {
    const t = parseImgTranscript(`${IMG_LINE_PREFIX}NOTE text=[no title for this activity and language]`);
    expect(t.notes).toEqual(["no title for this activity and language"]);
  });
});

// ---------------------------------------------------------------------------
// droppedLines
// ---------------------------------------------------------------------------

describe("parseImgTranscript — droppedLines", () => {
  it("counts an unknown head", () => {
    const t = parseImgTranscript(`${IMG_LINE_PREFIX}BOGUS x=[1]`);
    expect(t.droppedLines).toBe(1);
  });

  it("counts an IMG-prefixed line missing a required field", () => {
    const t = parseImgTranscript(`${IMG_LINE_PREFIX}TOTAL nope=[1]`);
    expect(t.total).toBeNull();
    expect(t.droppedLines).toBe(1);
  });

  it("counts a completely foreign line", () => {
    const t = parseImgTranscript("this is not a transcript line at all");
    expect(t.droppedLines).toBe(1);
  });

  it("does not count blank lines", () => {
    const t = parseImgTranscript(`${IMG_LINE_PREFIX}TOTAL n=[1]\n\n   \n`);
    expect(t.droppedLines).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Error lines
// ---------------------------------------------------------------------------

describe("parseImgTranscript — error lines", () => {
  it("routes a ZMCP-ERR> line to .errors, trimmed, not a row", () => {
    const t = parseImgTranscript(`${ERR_LINE_PREFIX}activation failed: syntax error  `);
    expect(t.errors).toEqual(["activation failed: syntax error"]);
    expect(t.activities).toEqual([]);
    expect(t.droppedLines).toBe(0);
  });

  it("routes a ZMCP-DDIC-ERR> line to .errors, trimmed, not a row", () => {
    const t = parseImgTranscript(`${DDIC_ERR_PREFIX} table DD02L has no field FOO  `);
    expect(t.errors).toEqual(["table DD02L has no field FOO"]);
    expect(t.tables).toEqual([]);
    expect(t.droppedLines).toBe(0);
  });

  it("keeps errors, rows and notes in their own buckets when interleaved", () => {
    const text = [
      `${IMG_LINE_PREFIX}ACT activity=[A] objects=[1] nodes=[0] title=[X]`,
      `${ERR_LINE_PREFIX}one field lookup failed`,
      `${IMG_LINE_PREFIX}NOTE text=[a standing note]`,
    ].join("\n");
    const t = parseImgTranscript(text);
    expect(t.activities).toHaveLength(1);
    expect(t.errors).toEqual(["one field lookup failed"]);
    expect(t.notes).toEqual(["a standing note"]);
  });
});

// ---------------------------------------------------------------------------
// Free-text invariant
//
// The brief this suite was written from claimed the risk case was a
// duplicate key at the end of a line (`title=[Foo] title=[Bar]`), which is
// not a mis-split at all — it's two independently well-formed field matches
// where the second simply overwrites the first key in the output object.
// Verified against parseBracketFields's actual regex
// (`/(\w+)=\[(.*?)\](?=\s+\w+=\[|\s*$)/g`, src/adt/run.ts) the real failure
// mode is different: a SINGLE free-text value that happens to contain an
// embedded "] word=[" -shaped substring gets silently split into two
// fabricated fields, truncating the true value, with no error signal and no
// droppedLines increment. img-bridge.ts's own comment above
// parseImgTranscript names exactly this risk, which is why every emitted
// line puts its one free-text field last.
// ---------------------------------------------------------------------------

describe("parseImgTranscript — free-text field, embedded bracket behaviour", () => {
  it("an embedded ']' NOT immediately followed by a bare 'word=[' shape parses as one whole value", () => {
    const t = parseImgTranscript(`${IMG_LINE_PREFIX}NOTE text=[Configure A]B settings]`);
    expect(t.notes).toEqual(["Configure A]B settings"]);
    expect(t.droppedLines).toBe(0);
  });

  it("duplicate key on one line: the second occurrence overwrites the first (not a mis-split)", () => {
    const t = parseImgTranscript(`${IMG_LINE_PREFIX}ACT activity=[A] objects=[1] nodes=[0] title=[Foo] title=[Bar]`);
    expect(t.activities[0]!.title).toBe("Bar");
  });

  it("pins the real mis-split: an embedded ']  word=[' shape truncates the value and fabricates an extra field", () => {
    // Intended value: "See table] entries=[updated" as ONE note. The lazy
    // regex instead treats it as two fields: text="See table",
    // entries="updated" — silently, with droppedLines untouched.
    const t = parseImgTranscript(`${IMG_LINE_PREFIX}NOTE text=[See table] entries=[updated]`);
    expect(t.notes).toEqual(["See table"]);
    expect(t.droppedLines).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// imgLikePattern — escaping contract
//
// Per this task's concurrency note: the auto-wrap of a bare (wildcard-free)
// term into a %substring% pattern is the OTHER worker's contract to assert
// exact literal equality on. These tests pin only the escaping MECHANICS
// (# -> ##, _ -> #_, * -> %, escapeChar "#", applied in that order) via
// relationship/substring assertions.
// ---------------------------------------------------------------------------

describe("imgLikePattern — escaping contract", () => {
  it("uses '#' as the escape character", () => {
    expect(imgLikePattern("FOO").escapeChar).toBe("#");
  });

  it("doubles every literal '#'", () => {
    const { literal } = imgLikePattern("A#B");
    // one raw '#' becomes '##'
    expect(literal).toContain("##");
  });

  it("escapes '_' as '#_'", () => {
    const { literal } = imgLikePattern("A_B");
    expect(literal).toContain("#_");
  });

  it("converts '*' to the SQL wildcard '%'", () => {
    const { literal } = imgLikePattern("FOO*BAR");
    expect(literal).toContain("%");
    expect(literal).not.toContain("*");
  });

  it("applies '#' escaping before '_' escaping, per the documented order", () => {
    // A bare '_' escapes to '#_' when '#' is escaped first. If the order were
    // reversed (escape '_' before '#'), the '#' just introduced by that step
    // would itself get doubled, producing '##_' instead — a different,
    // wrong, string. This is the discriminating case: only the code's
    // documented order ('#' first) produces a lone '#_' pair here.
    const { literal } = imgLikePattern("_");
    const hashCount = literal.split("").filter((c) => c === "#").length;
    expect(hashCount).toBe(1);
    expect(literal).toContain("#_");
  });

  it("structurally: every '#' in the output belongs to a '##' or '#_' escape pair", () => {
    // count(#) in output must equal 2*count(#) + count(_) in the trimmed
    // input, for any input free of '*' (which does not touch '#' or '_').
    const raw = "A#B_C#_D";
    const trimmed = raw.trim();
    const rawHashes = (trimmed.match(/#/g) ?? []).length;
    const rawUnderscores = (trimmed.match(/_/g) ?? []).length;
    const { literal } = imgLikePattern(raw);
    const outHashes = (literal.match(/#/g) ?? []).length;
    expect(outHashes).toBe(2 * rawHashes + rawUnderscores);
  });

  it("rejects a raw value containing a literal quote (no legal input can carry one through to SQL)", () => {
    expectBadInput(() => imgLikePattern("O'BRIEN"));
  });
});

// ---------------------------------------------------------------------------
// validateImgQuery — injection / range validation
//
// Brief inaccuracy found and preserved here rather than papered over: the
// brief claimed "--" is always refused. It is not — assertActivityOrNode's
// and imgLikePattern's character classes both allow "-" freely and place no
// restriction on repetition (real SAP activity ids commonly contain
// hyphens), so "--" is ordinary, accepted input for search/show/tree.
// assertObjectName's class has no "-" at all, so "--" IS refused there.
// Tests below assert the code's actual behaviour in both directions.
// ---------------------------------------------------------------------------

describe("validateImgQuery — injection payloads", () => {
  const ALWAYS_BAD = ["O'BRIEN", "A\"B", "A;B", "A\nB", "A\rB"];

  it("refuses a quote/semicolon/newline in text (search)", () => {
    for (const bad of ALWAYS_BAD) {
      expectBadInput(() => validateImgQuery(baseSearch({ text: bad })));
    }
  });

  it("refuses a quote/semicolon/newline in activity (show)", () => {
    for (const bad of ALWAYS_BAD) {
      expectBadInput(() => validateImgQuery(baseShow({ activity: bad })));
    }
  });

  it("refuses a quote/semicolon/newline in node (tree)", () => {
    for (const bad of ALWAYS_BAD) {
      expectBadInput(() => validateImgQuery(baseTree({ node: bad })));
    }
  });

  it("refuses a quote/semicolon/newline in object (objects)", () => {
    for (const bad of ALWAYS_BAD) {
      expectBadInput(() => validateImgQuery(baseObjects({ object: bad })));
    }
  });

  it("accepts '--' in text/activity/node (hyphen is a legal, unrestricted character there)", () => {
    expect(() => validateImgQuery(baseSearch({ text: "AB--CD" }))).not.toThrow();
    expect(() => validateImgQuery(baseShow({ activity: "AB--CD" }))).not.toThrow();
    expect(() => validateImgQuery(baseTree({ node: "AB--CD" }))).not.toThrow();
  });

  it("refuses '--' in object (assertObjectName's character class has no '-' at all)", () => {
    expectBadInput(() => validateImgQuery(baseObjects({ object: "AB--CD" })));
  });

  it("never emits an unescaped caller quote into generated source — because a quote is refused before any SQL is built", () => {
    // None of the four validators' character classes admit a literal "'" at
    // all, so no legal ImgQuery can carry one through to imgBridgeSource.
    // The property therefore holds by construction: every mode throws
    // BAD_INPUT on a quote before imgBridgeSource assembles any SQL.
    expectBadInput(() => imgBridgeSource(baseSearch({ text: "O'BRIEN" })));
    expectBadInput(() => imgBridgeSource(baseShow({ activity: "O'BRIEN" })));
    expectBadInput(() => imgBridgeSource(baseTree({ node: "O'BRIEN" })));
    expectBadInput(() => imgBridgeSource(baseObjects({ object: "O'BRIEN" })));
  });
});

describe("validateImgQuery — length limits", () => {
  it("text (search): accepts 40 chars, refuses 41", () => {
    expect(() => validateImgQuery(baseSearch({ text: "A".repeat(40) }))).not.toThrow();
    expectBadInput(() => validateImgQuery(baseSearch({ text: "A".repeat(41) })));
  });

  it("activity (show): accepts 60 chars, refuses 61", () => {
    expect(() => validateImgQuery(baseShow({ activity: "A".repeat(60) }))).not.toThrow();
    expectBadInput(() => validateImgQuery(baseShow({ activity: "A".repeat(61) })));
  });

  it("node (tree): accepts 60 chars, refuses 61", () => {
    expect(() => validateImgQuery(baseTree({ node: "A".repeat(60) }))).not.toThrow();
    expectBadInput(() => validateImgQuery(baseTree({ node: "A".repeat(61) })));
  });

  it("object (objects): accepts 30 chars, refuses 31", () => {
    expect(() => validateImgQuery(baseObjects({ object: "A".repeat(30) }))).not.toThrow();
    expectBadInput(() => validateImgQuery(baseObjects({ object: "A".repeat(31) })));
  });
});

describe("validateImgQuery — offset/limit range", () => {
  it("refuses offset -1 and accepts offset 0 and 100000", () => {
    expectBadInput(() => validateImgQuery(baseSearch({ offset: -1 })));
    expect(() => validateImgQuery(baseSearch({ offset: 0 }))).not.toThrow();
    expect(() => validateImgQuery(baseSearch({ offset: 100000 }))).not.toThrow();
  });

  it("refuses offset 100001", () => {
    expectBadInput(() => validateImgQuery(baseSearch({ offset: 100001 })));
  });

  it("refuses limit 0 and accepts limit 1 and IMG_PAGE_MAX", () => {
    expectBadInput(() => validateImgQuery(baseSearch({ limit: 0 })));
    expect(() => validateImgQuery(baseSearch({ limit: 1 }))).not.toThrow();
    expect(() => validateImgQuery(baseSearch({ limit: IMG_PAGE_MAX }))).not.toThrow();
  });

  it(`refuses limit ${IMG_PAGE_MAX + 1}`, () => {
    expectBadInput(() => validateImgQuery(baseSearch({ limit: IMG_PAGE_MAX + 1 })));
  });

  it("same offset/limit range applies to tree mode", () => {
    expectBadInput(() => validateImgQuery(baseTree({ offset: -1 })));
    expectBadInput(() => validateImgQuery(baseTree({ limit: IMG_PAGE_MAX + 1 })));
    expect(() => validateImgQuery(baseTree({ offset: 100000, limit: IMG_PAGE_MAX }))).not.toThrow();
  });
});

describe("validateImgQuery — tree root vs show activity emptiness", () => {
  it("accepts an empty node in tree mode (reference-IMG root)", () => {
    expect(() => validateImgQuery(baseTree({ node: "" }))).not.toThrow();
  });

  it("refuses an empty activity in show mode", () => {
    expectBadInput(() => validateImgQuery(baseShow({ activity: "" })));
  });
});

// ---------------------------------------------------------------------------
// Generated source — line length ceiling
// ---------------------------------------------------------------------------

describe("imgBridgeSource — generated line length", () => {
  function maxLineLength(source: string): number {
    return Math.max(...source.split("\n").map((l) => l.length));
  }

  it("search mode: longest legal input stays within ABAP_SOURCE_LINE_MAX", () => {
    const q = baseSearch({ text: "A".repeat(40), language: "EN", offset: 100000, limit: IMG_PAGE_MAX });
    expect(maxLineLength(imgBridgeSource(q))).toBeLessThanOrEqual(ABAP_SOURCE_LINE_MAX);
  });

  it("show mode: longest legal input stays within ABAP_SOURCE_LINE_MAX", () => {
    const q = baseShow({ activity: "A".repeat(60), language: "EN" });
    expect(maxLineLength(imgBridgeSource(q))).toBeLessThanOrEqual(ABAP_SOURCE_LINE_MAX);
  });

  it("tree mode: longest legal input stays within ABAP_SOURCE_LINE_MAX", () => {
    const q = baseTree({ node: "A".repeat(60), language: "EN", offset: 100000, limit: IMG_PAGE_MAX });
    expect(maxLineLength(imgBridgeSource(q))).toBeLessThanOrEqual(ABAP_SOURCE_LINE_MAX);
  });

  it("objects mode: longest legal input stays within ABAP_SOURCE_LINE_MAX, for every kind", () => {
    const kinds: (ImgObjectKind | undefined)[] = [...KNOWN_OBJECT_KINDS, undefined];
    for (const kind of kinds) {
      const q = baseObjects({ object: "A".repeat(30), language: "EN", kind });
      expect(maxLineLength(imgBridgeSource(q))).toBeLessThanOrEqual(ABAP_SOURCE_LINE_MAX);
    }
  });
});

// ---------------------------------------------------------------------------
// imgBridgeClassName / IMG_BRIDGE_CLASS
// ---------------------------------------------------------------------------

describe("imgBridgeClassName", () => {
  it("returns a fixed, mode-specific class name for every mode", () => {
    const expected: Record<ImgMode, string> = {
      search: "ZCL_ZMCP_IMG_SEARCH",
      show: "ZCL_ZMCP_IMG_SHOW",
      tree: "ZCL_ZMCP_IMG_TREE",
      objects: "ZCL_ZMCP_IMG_OBJECTS",
    };
    for (const mode of Object.keys(expected) as ImgMode[]) {
      expect(imgBridgeClassName(mode)).toBe(expected[mode]);
      expect(IMG_BRIDGE_CLASS[mode]).toBe(expected[mode]);
    }
  });
});
