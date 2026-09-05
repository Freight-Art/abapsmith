/**
 * Wire-conformance tests for `src/adt/quickfix.ts` (the ADT quick-fix
 * evaluation/proposal parser and request builder), against the same 12 REAL
 * ADT quickfix-protocol captures `test/range-edit-fixtures.test.ts` already
 * pins (`test/fixtures/live-captured/800-811-qf-*.{xml,meta.json}`).
 *
 * `test/range-edit-fixtures.test.ts` proves `applyRangeEdits` against deltas
 * extracted with its OWN throwaway regex parser. This file instead drives
 * everything through the PRODUCTION parser (`parseEvaluationResults`,
 * `parseProposalDeltas`, `parseDeltaFragment`, `buildProposalRequest`,
 * `quickFixFragmentUri`) — the six `expectedResult` strings for the
 * delta-bearing fixtures are reused verbatim from that file's `CASES` table
 * so both suites are provably checking the same ground truth.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import {
  buildProposalRequest,
  INTERACTIVE_QUICKFIX_TYPES,
  parseEvaluationResults,
  parseProposalDeltas,
  quickFixFragmentUri,
  type QuickFixPosition,
} from "../src/adt/quickfix.js";
import { applyRangeEdits, type Position, type RangeEdit } from "../src/adt/range-edit.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { LIVE_CAPTURED_DIR } from "./helpers/system-role-fake.js";

// ------------------------------------------------------------- fixture IO ---

/** The object path shared by every 803/805/806/809/810/811 delta unit (before its own `#` fragment). */
const SOURCE_URI = "/sap/bc/adt/programs/programs/zmcp_qf_probe1/source/main";

const fixtureXml = (base: string): string => readFileSync(join(LIVE_CAPTURED_DIR, `${base}.xml`), "utf8");

const fixtureMeta = (base: string): { requestBody: unknown; requestUrl: string } =>
  JSON.parse(readFileSync(join(LIVE_CAPTURED_DIR, `${base}.meta.json`), "utf8")) as {
    requestBody: unknown;
    requestUrl: string;
  };

/** Decodes the 5 predefined XML entities. Mirrors the identically-named helper in `test/range-edit-fixtures.test.ts`. */
function decodeXmlEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/**
 * The exact ABAP source posted in a proposal fixture's `.meta.json`
 * `requestBody` (`<input><content>`), CRLFs intact. Regex-extracted rather
 * than parsed through an XML parser — a spec-compliant parser normalises
 * `\r\n` to `\n`, which would hide the very CRLF-vs-LF distinction fixture
 * 806 exercises. Same technique, same reasoning, as `extractSource` in
 * `test/range-edit-fixtures.test.ts`.
 */
function postedSource(base: string): string {
  const { requestBody } = fixtureMeta(base);
  if (typeof requestBody !== "string") throw new Error(`${base}: requestBody is not a string`);
  const m = /<content>([\s\S]*?)<\/content>/.exec(requestBody);
  if (!m) throw new Error(`${base}: no <content> in requestBody`);
  return decodeXmlEntities(m[1]!);
}

/** Run `fn`, require an `AbapError`, hand it back for field-level assertions — same pattern as `test/activation-fugr-false-negative.test.ts`. */
function catchAbap(fn: () => unknown): AbapError {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected an AbapError, but the call returned normally");
}

// ===================================================== A: evaluation parsing

describe("parseEvaluationResults — fixture 804 (six proposals, deterministic-looking bait)", () => {
  const proposals = parseEvaluationResults(fixtureXml("804-qf-eval-proposals-deterministic-six"));
  const byId = new Map(proposals.map((p) => [p.id, p] as const));

  it("returns exactly six proposals, in document order, by id", () => {
    expect(proposals.map((p) => p.id)).toEqual([
      "unimplemented_methods",
      "generate_factory_method",
      "generate_constructor",
      "generate_class_constructor",
      "delete_member",
      "generate_table_type",
    ]);
  });

  it("first proposal: every field exact, including the id/type divergence", () => {
    const p = proposals[0]!;
    expect(p.uri).toBe("/sap/bc/adt/quickfixes/proposals/providers/refactoring/quickfixes/unimplemented_methods");
    // The URI's last segment ("unimplemented_methods") and adtcore:type
    // ("add_unimplemented_method") are DIFFERENT strings on the wire — `id`
    // is derived from the former, `type` is read verbatim as the latter.
    expect(p.id).toBe("unimplemented_methods");
    expect(p.type).toBe("add_unimplemented_method");
    expect(p.id).not.toBe(p.type);
    expect(p.title).toBe("Add implementation for 'run'");
    expect(p.description).toBe("Creates an empty method implementation for method run in class lcl.");
    expect(p.parameterized).toBe(false);
    expect(p.parameter).toBeUndefined();
    expect(p.userContent).toBeUndefined();
  });

  it("generate_factory_method and generate_constructor carry userContent and are parameterized, named by the userContent document's root element", () => {
    const factory = byId.get("generate_factory_method")!;
    const constructor = byId.get("generate_constructor")!;
    expect(factory.parameterized).toBe(true);
    expect(factory.parameter).toBe("generateConstructor");
    expect(constructor.parameterized).toBe(true);
    expect(constructor.parameter).toBe("generateConstructor");
    // Same parameter name for both: the wire distinguishes the two fixes by
    // `type`/`id`, not by the shape of the dialog document they prefill.
    expect(factory.parameter).toBe(constructor.parameter);

    for (const id of ["unimplemented_methods", "generate_class_constructor", "delete_member", "generate_table_type"]) {
      expect(byId.get(id)!.parameterized).toBe(false);
    }
  });

  it("delete_member: block-boundary HTML tags become a space, not a run-together word", () => {
    // From the fixture's raw adtcore:description (two <p> elements), stripped by stripHtml.
    expect(byId.get("delete_member")!.description).toBe(
      "Deletes local class lcl. The deletion will be executed even if usages of lcl exist.",
    );
  });

  it("behavioural: a classifier that trusts this fixture's own capture note ('generate_constructor' listed among the DETERMINISTIC fixes) gets it wrong", () => {
    // Hardcoded from the .meta.json `note` text (not derived from the
    // implementation under test), so this really is an independent naive rule.
    const noteClaimsDeterministic = new Set([
      "unimplemented_methods",
      "generate_constructor",
      "generate_class_constructor",
      "generate_table_type",
    ]);
    const naiveParameterized = (id: string) => !noteClaimsDeterministic.has(id);
    expect(naiveParameterized("generate_constructor")).toBe(false);
    // The real parser disagrees: the fix's own userContent proves interaction
    // is needed regardless of what the capture note calls it.
    expect(byId.get("generate_constructor")!.parameterized).toBe(true);
  });
});

describe("parseEvaluationResults — fixture 802 (interactive rename, no userContent at all)", () => {
  const xml = fixtureXml("802-qf-eval-proposals-rename");
  const proposals = parseEvaluationResults(xml);

  it("parses to exactly one proposal: qf_rename / rename_quickfix, with no userContent element on the wire", () => {
    expect(xml).not.toContain("<userContent>");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.id).toBe("qf_rename");
    expect(proposals[0]!.type).toBe("rename_quickfix");
    expect(proposals[0]!.title).toBe("Rename 'lv_unused'");
    expect(proposals[0]!.userContent).toBeUndefined();
  });

  it("description: block-boundary HTML tags become a space, not a run-together word", () => {
    // From the fixture's raw adtcore:description (two <p> elements), stripped by stripHtml.
    expect(proposals[0]!.description).toBe(
      "Renames lv_unused and adjusts all occurrences of lv_unused in the current source unit. If lv_unused is also used in other source units, the rename wizard will be opened.",
    );
  });

  it("is parameterized despite carrying no userContent — interactive by a deny-list entry, not by the userContent test", () => {
    // Absence of userContent is not proof a fix is parameter-free: fixture
    // 803's hop-2 delta for this same fix — posted with no new name supplied
    // — is an IDENTITY no-op (four units each replacing lv_text with
    // lv_text). A "parameterized iff userContent present" rule would call
    // this deterministic and silently apply that no-op as if it were the
    // requested rename.
    expect(proposals[0]!.parameterized).toBe(true);
    expect(proposals[0]!.parameter).toBe("new name");
    expect(INTERACTIVE_QUICKFIX_TYPES.has("rename_quickfix")).toBe(true);
  });

  it("behavioural: a 'no userContent means deterministic' classifier gets this fix wrong", () => {
    const naiveParameterized = (userContent: string | undefined) => userContent !== undefined;
    expect(naiveParameterized(proposals[0]!.userContent)).toBe(false);
    expect(proposals[0]!.parameterized).toBe(true);
  });
});

describe("parseEvaluationResults — fixture 801 (empty at an ATC finding's position)", () => {
  it("parses to exactly [], not an error", () => {
    expect(parseEvaluationResults(fixtureXml("801-qf-eval-empty-at-atc-finding"))).toEqual([]);
  });
});

// ============================================ B: delta parsing + application

interface DeltaCase {
  readonly file: string;
  readonly edits: readonly RangeEdit[];
  /** Reused verbatim from `test/range-edit-fixtures.test.ts`'s `CASES` table. */
  readonly expectedResult: string;
}

const DELTA_CASES: readonly DeltaCase[] = [
  {
    file: "803-qf-proposal-rename-multiunit",
    edits: [
      { range: { start: { line: 3, column: 5 }, end: { line: 3, column: 12 } }, content: "lv_text" },
      { range: { start: { line: 8, column: 14 }, end: { line: 8, column: 21 } }, content: "lv_text" },
      { range: { start: { line: 10, column: 10 }, end: { line: 10, column: 17 } }, content: "lv_text" },
      { range: { start: { line: 12, column: 8 }, end: { line: 12, column: 15 } }, content: "lv_text" },
    ],
    expectedResult:
      "REPORT zmcp_qf_probe1.\r\n\r\nDATA lv_text TYPE string.\r\nDATA lv_unused TYPE i.\r\n\r\nBREAK-POINT.\r\n\r\nMOVE 'abc' TO lv_text.\r\n\r\nTRANSLATE lv_text TO UPPER CASE.\r\n\r\nWRITE / lv_text.",
  },
  {
    file: "805-qf-proposal-insert-method-impl",
    edits: [
      {
        range: { start: { line: 9, column: 0 }, end: { line: 9, column: 0 } },
        content: "  METHOD run.\n\n  ENDMETHOD.\n\n",
      },
    ],
    expectedResult:
      "REPORT zmcp_qf_probe1.\r\n\r\nCLASS lcl DEFINITION.\r\n  PUBLIC SECTION.\r\n    METHODS run.\r\nENDCLASS.\r\n\r\nCLASS lcl IMPLEMENTATION.\r\n  METHOD run.\n\n  ENDMETHOD.\n\nENDCLASS.",
  },
  {
    file: "806-qf-proposal-constructor-replace-and-insert",
    edits: [
      {
        range: { start: { line: 5, column: 4 }, end: { line: 5, column: 16 } },
        content: "METHODS constructor.\n    METHODS run.",
      },
      {
        range: { start: { line: 8, column: 25 }, end: { line: 8, column: 25 } },
        content: "\n\n  METHOD constructor.\n\n  ENDMETHOD.",
      },
    ],
    expectedResult:
      "REPORT zmcp_qf_probe1.\r\n\r\nCLASS lcl DEFINITION.\r\n  PUBLIC SECTION.\r\n    METHODS constructor.\n    METHODS run.\r\nENDCLASS.\r\n\r\nCLASS lcl IMPLEMENTATION.\n\n  METHOD constructor.\n\n  ENDMETHOD.\r\nENDCLASS.",
  },
  {
    file: "809-qf-proposal-delete-member-empty-deltas",
    edits: [],
    expectedResult:
      "REPORT zmcp_qf_probe1.\r\n\r\nCLASS lcl DEFINITION.\r\n  PUBLIC SECTION.\r\n    METHODS run.\r\nENDCLASS.\r\n\r\nCLASS lcl IMPLEMENTATION.\r\nENDCLASS.",
  },
  {
    file: "810-qf-proposal-change-to-private-descending-units",
    edits: [
      {
        range: { start: { line: 5, column: 16 }, end: { line: 5, column: 16 } },
        content: "\n  PRIVATE SECTION.\n    METHODS run.",
      },
      { range: { start: { line: 5, column: 4 }, end: { line: 5, column: 16 } }, content: "" },
    ],
    expectedResult:
      "REPORT zmcp_qf_probe1.\r\n\r\nCLASS lcl DEFINITION.\r\n  PUBLIC SECTION.\r\n    \n  PRIVATE SECTION.\n    METHODS run.\r\nENDCLASS.\r\n\r\nCLASS lcl IMPLEMENTATION.\r\nENDCLASS.",
  },
  {
    file: "811-qf-proposal-factory-method-two-insertions",
    edits: [
      {
        range: { start: { line: 4, column: 17 }, end: { line: 4, column: 17 } },
        content: "\n    CLASS-METHODS create\n      RETURNING\n        value(r_result) TYPE REF TO lcl.",
      },
      {
        range: { start: { line: 8, column: 25 }, end: { line: 8, column: 25 } },
        content: "\n\n  METHOD create.\n\n    r_result = NEW #( ).\n\n  ENDMETHOD.",
      },
    ],
    expectedResult:
      "REPORT zmcp_qf_probe1.\r\n\r\nCLASS lcl DEFINITION.\r\n  PUBLIC SECTION.\n    CLASS-METHODS create\n      RETURNING\n        value(r_result) TYPE REF TO lcl.\r\n    METHODS run.\r\nENDCLASS.\r\n\r\nCLASS lcl IMPLEMENTATION.\n\n  METHOD create.\n\n    r_result = NEW #( ).\n\n  ENDMETHOD.\r\nENDCLASS.",
  },
];

describe("parseProposalDeltas + applyRangeEdits — the 6 proposal fixtures, table-driven", () => {
  it("the table covers exactly 803/805/806/809/810/811, in order", () => {
    expect(DELTA_CASES.map((c) => c.file.slice(0, 3))).toEqual(["803", "805", "806", "809", "810", "811"]);
  });

  for (const c of DELTA_CASES) {
    it(`${c.file}: parses to the exact RangeEdit[] and applies to the exact expected result`, () => {
      const edits = parseProposalDeltas(fixtureXml(c.file), SOURCE_URI);
      expect(edits).toEqual(c.edits);

      const result = applyRangeEdits(postedSource(c.file), edits);
      expect(result.ok, `${c.file}: ${JSON.stringify(result)}`).toBe(true);
      if (result.ok) expect(result.result).toBe(c.expectedResult);
    });
  }
});

describe("805 — zero-width insertion is a valid range, not a malformed one", () => {
  it("exactly one unit; start deep-equals end at (9,0) because the fragment carries no ;end=", () => {
    const edits = parseProposalDeltas(fixtureXml("805-qf-proposal-insert-method-impl"), SOURCE_URI);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.range.start).toEqual(edits[0]!.range.end);
    expect(edits[0]!.range.start).toEqual({ line: 9, column: 0 });
  });
});

describe("806 — one replacement + one zero-width insertion, LF content over a CRLF document", () => {
  const edits = parseProposalDeltas(fixtureXml("806-qf-proposal-constructor-replace-and-insert"), SOURCE_URI);

  it("exactly two units: a replacement (5,4 -> 5,16) and a zero-width insertion at (8,25)", () => {
    expect(edits).toHaveLength(2);
    expect(edits[0]!.range).toEqual({ start: { line: 5, column: 4 }, end: { line: 5, column: 16 } });
    expect(edits[1]!.range).toEqual({ start: { line: 8, column: 25 }, end: { line: 8, column: 25 } });
  });

  it("the inserted content uses LF while the posted document uses CRLF — the server does not match the document's line endings", () => {
    const source = postedSource("806-qf-proposal-constructor-replace-and-insert");
    expect(source).toContain("\r\n");
    expect(edits[1]!.content).toContain("\n");
    expect(edits[1]!.content).not.toContain("\r\n");
  });

  it("applies to the exact expected result", () => {
    const result = applyRangeEdits(postedSource("806-qf-proposal-constructor-replace-and-insert"), edits);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toBe(
        "REPORT zmcp_qf_probe1.\r\n\r\nCLASS lcl DEFINITION.\r\n  PUBLIC SECTION.\r\n    METHODS constructor.\n    METHODS run.\r\nENDCLASS.\r\n\r\nCLASS lcl IMPLEMENTATION.\n\n  METHOD constructor.\n\n  ENDMETHOD.\r\nENDCLASS.",
      );
    }
  });
});

describe("809 — <deltas/> is a legitimate no-op, not an error", () => {
  it("parses to exactly [], and applying [] returns the source unchanged", () => {
    const edits = parseProposalDeltas(fixtureXml("809-qf-proposal-delete-member-empty-deltas"), SOURCE_URI);
    expect(edits).toEqual([]);
    const source = postedSource("809-qf-proposal-delete-member-empty-deltas");
    const result = applyRangeEdits(source, edits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result).toBe(source);
  });
});

describe("810 — units arrive in descending document order; one is a deletion", () => {
  const edits = parseProposalDeltas(fixtureXml("810-qf-proposal-change-to-private-descending-units"), SOURCE_URI);

  it("the parser preserves the wire order — it does not sort", () => {
    expect(edits).toHaveLength(2);
    const [first, second] = edits as [RangeEdit, RangeEdit];
    const cmp = (a: Position, b: Position) => a.line - b.line || a.column - b.column;
    // first.start (5,16) is AFTER second.start (5,4): descending, as sent.
    expect(cmp(first.range.start, second.range.start)).toBeGreaterThan(0);
    expect(second.content).toBe("");
  });

  it("applies to the exact expected result, and reversing the array gives the identical result", () => {
    const source = postedSource("810-qf-proposal-change-to-private-descending-units");
    const asCaptured = applyRangeEdits(source, edits);
    expect(asCaptured.ok).toBe(true);
    if (asCaptured.ok) {
      expect(asCaptured.result).toBe(
        "REPORT zmcp_qf_probe1.\r\n\r\nCLASS lcl DEFINITION.\r\n  PUBLIC SECTION.\r\n    \n  PRIVATE SECTION.\n    METHODS run.\r\nENDCLASS.\r\n\r\nCLASS lcl IMPLEMENTATION.\r\nENDCLASS.",
      );
    }
    // applyRangeEdits documents that input order is never trusted (ranges are
    // re-sorted internally against the original source) — reversing the
    // parsed array must be byte-identical.
    const reversed = applyRangeEdits(source, [...edits].reverse());
    expect(reversed.ok).toBe(true);
    if (asCaptured.ok && reversed.ok) expect(reversed.result).toBe(asCaptured.result);
  });
});

describe("811 — both units are zero-width insertions", () => {
  it("exactly two units, both start === end, in ascending order", () => {
    const edits = parseProposalDeltas(fixtureXml("811-qf-proposal-factory-method-two-insertions"), SOURCE_URI);
    expect(edits).toHaveLength(2);
    for (const e of edits) expect(e.range.start).toEqual(e.range.end);
    expect(edits[0]!.range.start).toEqual({ line: 4, column: 17 });
    expect(edits[1]!.range.start).toEqual({ line: 8, column: 25 });
  });
});

describe("the inclusive-vs-exclusive hazard — 806's replacement range is half-open, not inclusive", () => {
  const source = postedSource("806-qf-proposal-constructor-replace-and-insert");
  const line5 = source.split("\r\n")[4]!;

  it("line 5 of the posted source is '    METHODS run.', and columns 4..16 (exclusive end) is exactly 'METHODS run.'", () => {
    // Independently verified against the fixture itself, not assumed.
    expect(line5).toBe("    METHODS run.");
    expect(line5.length).toBe(16);
    expect(line5.slice(4, 16)).toBe("METHODS run.");
  });

  it("the production parser reports the unit's end column as 16 — the exclusive bound, not the last included index (which would be 15)", () => {
    const edits = parseProposalDeltas(fixtureXml("806-qf-proposal-constructor-replace-and-insert"), SOURCE_URI);
    expect(edits[0]!.range.end).toEqual({ line: 5, column: 16 });
  });

  it("applying the real (5,4;end=5,16) edit replaces exactly 'METHODS run.' and produces the correct text", () => {
    const correct: RangeEdit = {
      range: { start: { line: 5, column: 4 }, end: { line: 5, column: 16 } },
      content: "METHODS constructor.\n    METHODS run.",
    };
    const result = applyRangeEdits(source, [correct]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toBe(
        "REPORT zmcp_qf_probe1.\r\n\r\nCLASS lcl DEFINITION.\r\n  PUBLIC SECTION.\r\n    METHODS constructor.\n    METHODS run.\r\nENDCLASS.\r\n\r\nCLASS lcl IMPLEMENTATION.\r\nENDCLASS.",
      );
    }
  });

  it("behavioural: an off-by-one 'inclusive end' reading (column 17) does not survive this real fixture — applyRangeEdits rejects it, where the correct exclusive reading succeeds", () => {
    // NOT `SourceRange`/`parseFragmentRange` (src/adt/source.ts): those are
    // line-only and inclusive, and must never be reused as a column source
    // for a quickfix delta.
    const inclusiveOffByOne: RangeEdit = {
      range: { start: { line: 5, column: 4 }, end: { line: 5, column: 17 } },
      content: "METHODS constructor.\n    METHODS run.",
    };
    const result = applyRangeEdits(source, [inclusiveOffByOne]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("out-of-bounds-column");
      if (result.kind === "out-of-bounds-column") {
        expect(result.column).toBe(17);
        expect(result.lineLength).toBe(16);
      }
    }
  });

  it("behavioural: a whole-line inclusive reading (the SourceRange shape: line 5 start to line 6 start) silently produces different, wrong text", () => {
    // This is the shape `parseFragmentRange` (src/adt/source.ts) would leave
    // you with if its line-only, inclusive-end `SourceRange` were ever
    // (mis)used as a stand-in for a column-precise ADT delta: rounded up to
    // cover the whole line, columns discarded entirely.
    const wholeLine: RangeEdit = {
      range: { start: { line: 5, column: 0 }, end: { line: 6, column: 0 } },
      content: "METHODS constructor.\n    METHODS run.",
    };
    const result = applyRangeEdits(source, [wholeLine]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Wrong: the 4-space indent before "METHODS constructor." is gone (it
      // was inside the deleted range, not preserved outside it), and line
      // 5's own CRLF terminator was consumed too, running the inserted text
      // straight into "ENDCLASS." with no line break at all.
      const wrong =
        "REPORT zmcp_qf_probe1.\r\n\r\nCLASS lcl DEFINITION.\r\n  PUBLIC SECTION.\r\nMETHODS constructor.\n    METHODS run.ENDCLASS.\r\n\r\nCLASS lcl IMPLEMENTATION.\r\nENDCLASS.";
      const correct =
        "REPORT zmcp_qf_probe1.\r\n\r\nCLASS lcl DEFINITION.\r\n  PUBLIC SECTION.\r\n    METHODS constructor.\n    METHODS run.\r\nENDCLASS.\r\n\r\nCLASS lcl IMPLEMENTATION.\r\nENDCLASS.";
      expect(result.result).toBe(wrong);
      expect(result.result).not.toBe(correct);
    }
  });
});

// ==================================================== C: request construction

describe("buildProposalRequest — structural match against fixture 805's recorded request", () => {
  const source = postedSource("805-qf-proposal-insert-method-impl");
  const pos: QuickFixPosition = { line: 3, column: 0 };
  const generated = buildProposalRequest(source, SOURCE_URI, pos);

  it("root element is quickfixes:proposalRequest", () => {
    expect(generated).toMatch(/^<\?xml[^>]*\?>\s*<quickfixes:proposalRequest\b/);
  });

  it("<input><content> carries the source with CRLFs preserved verbatim, XML-escaped", () => {
    const m = /<content>([\s\S]*?)<\/content>/.exec(generated);
    expect(m).not.toBeNull();
    expect(decodeXmlEntities(m![1]!)).toBe(source);
    // A literal, unescaped CRLF: it is not an XML-special character.
    expect(m![1]).toContain("\r\n");
  });

  it("<input><adtcore:objectReference> uri is <sourceUri>#start=3,0", () => {
    const m = /<adtcore:objectReference adtcore:uri="([^"]*)"/.exec(generated);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(`${SOURCE_URI}#start=3,0`);
  });

  it("<userContent> is empty when none is supplied", () => {
    const m = /<userContent>([\s\S]*?)<\/userContent>/.exec(generated);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("");
  });

  it("round-trips through the same house XML parser as the recorded requestBody: identical extracted source and objectReference uri", () => {
    // A local parser, not the production one — quickfix.ts never parses the
    // request document it builds, only the responses it receives. Compares
    // structure, not exact whitespace: cosmetic indentation is allowed to
    // differ from the recorded capture.
    const reqXml = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: true,
      parseAttributeValue: false,
      parseTagValue: false,
      trimValues: false,
    });

    const extract = (xml: string): { content: string; uri: string } => {
      const doc = reqXml.parse(xml) as Record<string, unknown>;
      const root = doc["proposalRequest"] as Record<string, unknown>;
      const input = root["input"] as Record<string, unknown>;
      const contentNode = input["content"];
      const contentRec =
        typeof contentNode === "object" && contentNode !== null ? (contentNode as Record<string, unknown>) : undefined;
      const content = typeof contentNode === "string" ? contentNode : typeof contentRec?.["#text"] === "string" ? (contentRec["#text"] as string) : "";
      const objectReference = input["objectReference"] as Record<string, unknown>;
      return { content, uri: objectReference["@_uri"] as string };
    };

    const recorded = fixtureMeta("805-qf-proposal-insert-method-impl").requestBody as string;
    const gen = extract(generated);
    const rec = extract(recorded);
    expect(gen.uri).toBe(rec.uri);
    expect(gen.uri).toBe(`${SOURCE_URI}#start=3,0`);
    expect(gen.content).toBe(rec.content);
  });
});

describe("quickFixFragmentUri — matches the fragment recorded on the wire", () => {
  it("801: matches the url-decoded uri query parameter", () => {
    const url = fixtureMeta("801-qf-eval-empty-at-atc-finding").requestUrl;
    // URLSearchParams already decodes percent-encoding, including the %23
    // that stands in for the fragment's literal "#" (it is part of the
    // query VALUE here, not an actual URL fragment).
    const decoded = new URL(url, "http://x").searchParams.get("uri");
    expect(decoded).toBe(`${SOURCE_URI}#start=6,0`);
    expect(quickFixFragmentUri(SOURCE_URI, { line: 6, column: 0 })).toBe(decoded);
  });

  it("804: matches the url-decoded uri query parameter", () => {
    const url = fixtureMeta("804-qf-eval-proposals-deterministic-six").requestUrl;
    const decoded = new URL(url, "http://x").searchParams.get("uri");
    expect(decoded).toBe(`${SOURCE_URI}#start=3,0`);
    expect(quickFixFragmentUri(SOURCE_URI, { line: 3, column: 0 })).toBe(decoded);
  });
});

// ======================================================== D: cross-doc guard

describe("parseProposalDeltas — cross-document guard", () => {
  it("throws when a unit's adtcore:uri names a different document than expectedSourceUri", () => {
    // Hand-built literal, shaped like 805's single-unit qf:proposalResult but
    // pointed at a second $TMP object instead of the one being fixed. Not a
    // fixture file: no such capture exists, and fabricating one under
    // test/fixtures/live-captured/ would misrepresent it as a live recording.
    const crossDocumentXml =
      `<?xml version="1.0" encoding="utf-8"?><qf:proposalResult xmlns:qf="http://www.sap.com/adt/quickfixes">` +
      `<deltas><unit><content>foo</content>` +
      `<adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/programs/zmcp_qf_probe2/source/main#start=1,0" ` +
      `adtcore:type="PROG/P" adtcore:name="Cross-document unit" xmlns:adtcore="http://www.sap.com/adt/core"/>` +
      `</unit></deltas></qf:proposalResult>`;

    const err = catchAbap(() => parseProposalDeltas(crossDocumentXml, SOURCE_URI));
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.details["expectedSourceUri"]).toBe(SOURCE_URI);
    expect(err.details["unitUri"]).toBe("/sap/bc/adt/programs/programs/zmcp_qf_probe2/source/main#start=1,0");
    // A fix spanning two documents can't be applied by a single-object write;
    // dropping the unit instead of throwing would silently produce a
    // half-applied fix, which is worse than refusing outright.
    expect(err.message).toMatch(/different object/);
  });
});
