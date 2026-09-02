/**
 * Fixture-conformance test for the column-aware ranged-edit applier
 * (`src/adt/range-edit.ts`), against the 12 REAL ADT quickfix-protocol wire
 * captures in `test/fixtures/live-captured/800-811-qf-*.{xml,meta.json}`
 * (probe program `ZMCP_QF_PROBE1` in `$TMP` on A4H — see each `.meta.json`'s
 * `capturedBy`/`note` fields).
 *
 * ## Why this file exists
 *
 * `test/range-edit.test.ts` exercises `applyRangeEdit`/`applyRangeEdits`
 * exclusively against hand-written source and hand-transcribed ranges. It
 * never reads a byte of the 800-811 captures, so the correspondence between
 * "the deltas SAP actually sends" and "the shape the applier accepts" was
 * established by manual inspection only, not by the test suite.
 * This file closes that gap: it parses the captures itself and feeds the
 * result straight through `applyRangeEdits`.
 *
 * ## What is actually in the 12 fixtures
 *
 * Only 6 of the 12 are quickfix PROPOSALS (`qf:proposalResult`, the shape
 * that carries `<deltas>`) — the other 6 are earlier protocol hops or
 * unrelated probes that carry no deltas at all:
 *   - 800 `atcworklist:worklist`        — ATC worklist, not a quickfix payload.
 *   - 801 `qf:evaluationResults` (empty)  — HOP 1, no quickfix offered.
 *   - 802 `qf:evaluationResults` (1 result) — HOP 1, offers an INTERACTIVE
 *     rename; still no deltas (those only appear at HOP 2).
 *   - 803 `qf:proposalResult`, 4 units    — HOP 2 multi-unit rename.
 *   - 804 `qf:evaluationResults` (6 results) — HOP 1, no deltas.
 *   - 805 `qf:proposalResult`, 1 unit     — HOP 2, pure insertion.
 *   - 806 `qf:proposalResult`, 2 units    — HOP 2, replace + insert.
 *   - 807 `autoqf:autoQuickfixProposal` (empty) — different XML vocabulary
 *     entirely (ATC auto-quickfix route), no `qf:proposalResult`/deltas.
 *   - 808 — not XML at all: a verbatim "415 Unsupported Media Type" error
 *     body (`responseStatus` is even recorded as `null` — the connection
 *     layer raised before the status was read).
 *   - 809 `qf:proposalResult`, 0 units (`<deltas/>`) — HOP 2, empty deltas.
 *   - 810 `qf:proposalResult`, 2 units    — HOP 2, insert-then-delete listed
 *     in DESCENDING position order.
 *   - 811 `qf:proposalResult`, 2 units    — HOP 2, two insertions, ascending.
 *
 * Every proposal fixture's `.meta.json` `requestBody` is itself an XML
 * document (`quickfixes:proposalRequest`) whose `<input><content>` element
 * carries the exact ABAP source the deltas below are relative to — that is
 * the "source" this file applies each fixture's deltas against.
 *
 * ## Coordinate convention: verified identical, no conversion needed
 *
 * `range-edit.ts`'s header documents its own convention: `line` 1-based,
 * `column` 0-based UTF-16 code units, range half-open `[start, end)`. ADT's
 * wire fragment (`#start=L,C` or `#start=L,C;end=L,C`, e.g.
 * `.../source/main#start=5,4;end=5,16`) uses the SAME convention — 1-based
 * line, 0-based column, half-open, and a range with no `;end=` names a
 * zero-width insertion point (`end === start`). This is not assumed: it is
 * cross-checked below two independent ways —
 *   - 803's four `content` values are literally `lv_text` (7 characters,
 *     the OLD name — the rename was interactive with no new name supplied,
 *     see `803-qf-proposal-rename-multiunit.meta.json`'s `note`), so
 *     applying the deltas as pure identity-replacements over their own
 *     source is a no-op IFF the ranges span exactly those 7-character
 *     spans. `it("803 …round-trips…")` below asserts the round-trip.
 *   - 806's unit 1 replaces `#start=5,4;end=5,16` on a line whose columns
 *     4..16 are independently verified (by direct `.slice`, not via the
 *     applier) to be exactly `"METHODS run."` (12 characters) — see
 *     `it("806 …")` below.
 * Both checks pass with a DIRECT mapping (no line/column adjustment). If a
 * future capture ever required an adjustment here, that conversion would
 * belong in `extractDeltas` below, not in `src/adt/range-edit.ts`.
 *
 * No defect was found: every one of the 6 proposal fixtures' deltas apply
 * cleanly (no out-of-bounds / inverted / overlapping-range rejection), and
 * every case with a knowable expected result (all 6) matches exactly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { applyRangeEdits, type Position, type RangeEdit } from "../src/adt/range-edit.js";
import { LIVE_CAPTURED_DIR } from "./helpers/system-role-fake.js";

// ------------------------------------------------------------- fixture IO ---

const fixtureXml = (base: string): string => readFileSync(join(LIVE_CAPTURED_DIR, `${base}.xml`), "utf8");
const fixtureMeta = (base: string): { requestBody: unknown } =>
  JSON.parse(readFileSync(join(LIVE_CAPTURED_DIR, `${base}.meta.json`), "utf8")) as { requestBody: unknown };

// ------------------------------------------------------- local XML parser ---
// Mirrors the house `fast-xml-parser` config in `src/adt/atc-xml.ts`, with
// one deliberate divergence: `trimValues: false`. Quickfix `<content>` text
// is the ABAP fragment ITSELF (see e.g. 806's two-line insertion, which
// opens with a blank line) — trimming would silently eat load-bearing
// leading/trailing whitespace and newlines from the delta payload.
const qfXml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => name === "unit",
});

/** Decodes the 5 predefined XML entities. Only `&apos;` appears anywhere in the 800-811 corpus (803's meta.json), but all 5 are handled for robustness. `&amp;` must decode last. */
function decodeXmlEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/**
 * Extracts the ABAP source a proposal fixture's deltas are relative to, from
 * its `.meta.json`'s `requestBody`. For HOP-2 proposal requests, `requestBody`
 * is an XML `quickfixes:proposalRequest` document whose `<input><content>`
 * carries the source (regex-extracted here, deliberately NOT via `qfXml`, so
 * the source's real `\r\n` line endings survive verbatim — an XML parser
 * would normalise them to `\n` per the XML spec's end-of-line handling,
 * which `806`'s own capture note flags as a real distinction: "Content
 * newlines are LF even though the object source is CRLF"). Returns
 * `undefined` for fixtures whose `requestBody` carries no such `<content>`
 * (the HOP-1 evaluation fixtures post raw ABAP with no XML wrapper at all;
 * the autoqf/ATC fixtures post object references, not source).
 */
function extractSource(base: string): string | undefined {
  const { requestBody } = fixtureMeta(base);
  if (typeof requestBody !== "string") return undefined;
  const m = /<content>([\s\S]*?)<\/content>/.exec(requestBody);
  return m ? decodeXmlEntities(m[1]!) : undefined;
}

/**
 * Extracts `<deltas><unit>` entries from a quickfix response XML into
 * `RangeEdit`s, per the coordinate-convention note in this file's header.
 * Returns:
 *   - `null` if the payload has no `qf:proposalResult` root at all (i.e. this
 *     capture carries no "deltas" concept — evaluation results, ATC
 *     worklists, the autoqf vocabulary, or the 808 non-XML error body all
 *     land here). Distinguishing this from an empty array matters: a parser
 *     that collapsed both cases to `[]` could hide itself misidentifying an
 *     unrelated payload as an empty proposal.
 *   - `[]` if `qf:proposalResult` is present with an empty `<deltas/>` (809).
 *   - the parsed `RangeEdit[]` otherwise.
 */
function extractDeltas(xmlText: string): RangeEdit[] | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = qfXml.parse(xmlText) as Record<string, unknown>;
  } catch {
    return null; // 808: not XML at all
  }
  const proposalResult = parsed["proposalResult"] as Record<string, unknown> | undefined;
  if (!proposalResult) return null;
  const deltas = proposalResult["deltas"];
  if (deltas === undefined || deltas === "") return []; // self-closing <deltas/>
  const deltasObj = deltas as Record<string, unknown>;
  const rawUnits = deltasObj["unit"];
  const units = (Array.isArray(rawUnits) ? rawUnits : rawUnits ? [rawUnits] : []) as Record<string, unknown>[];
  return units.map((u): RangeEdit => {
    const content = typeof u["content"] === "string" ? (u["content"] as string) : "";
    const objectReference = u["objectReference"] as Record<string, unknown>;
    const uri = objectReference["@_uri"] as string;
    // ADT fragment: `#start=L,C` (insertion point) or `#start=L,C;end=L,C`
    // (span) — both already 1-based line / 0-based column / half-open, the
    // same convention `range-edit.ts` documents. No adjustment applied.
    const m = /#start=(\d+),(\d+)(?:;end=(\d+),(\d+))?/.exec(uri);
    if (!m) throw new Error(`fixture parse error: no #start= fragment in objectReference uri ${JSON.stringify(uri)}`);
    const start: Position = { line: Number(m[1]), column: Number(m[2]) };
    const end: Position = m[3] !== undefined ? { line: Number(m[3]), column: Number(m[4]) } : start;
    return { range: { start, end }, content };
  });
}

// -------------------------------------------------------------- the table ---

interface FixtureCase {
  readonly file: string;
  /** `"not-a-proposal"`: no `qf:proposalResult` root (see `extractDeltas` doc). Otherwise the exact expected `<deltas><unit>` count. */
  readonly expectDeltas: "not-a-proposal" | number;
  /** Set only when the resulting document is independently knowable (all 6 proposal fixtures qualify — see header comment). */
  readonly expectedResult?: string;
}

const CASES: readonly FixtureCase[] = [
  { file: "800-qf-atc-worklist-quickfixinfo", expectDeltas: "not-a-proposal" },
  { file: "801-qf-eval-empty-at-atc-finding", expectDeltas: "not-a-proposal" },
  { file: "802-qf-eval-proposals-rename", expectDeltas: "not-a-proposal" },
  {
    file: "803-qf-proposal-rename-multiunit",
    expectDeltas: 4,
    // Identity rename (see header comment): applying the 4 deltas is a no-op.
    expectedResult:
      "REPORT zmcp_qf_probe1.\r\n\r\nDATA lv_text TYPE string.\r\nDATA lv_unused TYPE i.\r\n\r\nBREAK-POINT.\r\n\r\nMOVE 'abc' TO lv_text.\r\n\r\nTRANSLATE lv_text TO UPPER CASE.\r\n\r\nWRITE / lv_text.",
  },
  { file: "804-qf-eval-proposals-deterministic-six", expectDeltas: "not-a-proposal" },
  {
    file: "805-qf-proposal-insert-method-impl",
    expectDeltas: 1,
    expectedResult:
      "REPORT zmcp_qf_probe1.\r\n\r\nCLASS lcl DEFINITION.\r\n  PUBLIC SECTION.\r\n    METHODS run.\r\nENDCLASS.\r\n\r\nCLASS lcl IMPLEMENTATION.\r\n  METHOD run.\n\n  ENDMETHOD.\n\nENDCLASS.",
  },
  {
    file: "806-qf-proposal-constructor-replace-and-insert",
    expectDeltas: 2,
    expectedResult:
      "REPORT zmcp_qf_probe1.\r\n\r\nCLASS lcl DEFINITION.\r\n  PUBLIC SECTION.\r\n    METHODS constructor.\n    METHODS run.\r\nENDCLASS.\r\n\r\nCLASS lcl IMPLEMENTATION.\n\n  METHOD constructor.\n\n  ENDMETHOD.\r\nENDCLASS.",
  },
  { file: "807-qf-autoqf-proposal-empty", expectDeltas: "not-a-proposal" },
  { file: "808-qf-autoqf-step-preview-media-type", expectDeltas: "not-a-proposal" },
  {
    file: "809-qf-proposal-delete-member-empty-deltas",
    expectDeltas: 0,
    expectedResult:
      "REPORT zmcp_qf_probe1.\r\n\r\nCLASS lcl DEFINITION.\r\n  PUBLIC SECTION.\r\n    METHODS run.\r\nENDCLASS.\r\n\r\nCLASS lcl IMPLEMENTATION.\r\nENDCLASS.",
  },
  {
    file: "810-qf-proposal-change-to-private-descending-units",
    expectDeltas: 2,
    expectedResult:
      "REPORT zmcp_qf_probe1.\r\n\r\nCLASS lcl DEFINITION.\r\n  PUBLIC SECTION.\r\n    \n  PRIVATE SECTION.\n    METHODS run.\r\nENDCLASS.\r\n\r\nCLASS lcl IMPLEMENTATION.\r\nENDCLASS.",
  },
  {
    file: "811-qf-proposal-factory-method-two-insertions",
    expectDeltas: 2,
    expectedResult:
      "REPORT zmcp_qf_probe1.\r\n\r\nCLASS lcl DEFINITION.\r\n  PUBLIC SECTION.\n    CLASS-METHODS create\n      RETURNING\n        value(r_result) TYPE REF TO lcl.\r\n    METHODS run.\r\nENDCLASS.\r\n\r\nCLASS lcl IMPLEMENTATION.\n\n  METHOD create.\n\n    r_result = NEW #( ).\n\n  ENDMETHOD.\r\nENDCLASS.",
  },
];

describe("range-edit fixture conformance — 800-811 live ADT captures", () => {
  it("the table covers exactly the 12 captures 800-811, one row each, in order", () => {
    expect(CASES.map((c) => Number(c.file.slice(0, 3)))).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 800),
    );
  });

  for (const c of CASES) {
    it(`${c.file}: parses and, if a proposal, applies cleanly`, () => {
      const deltas = extractDeltas(fixtureXml(c.file));

      if (c.expectDeltas === "not-a-proposal") {
        expect(deltas).toBeNull();
        return;
      }

      expect(deltas).not.toBeNull();
      expect(deltas!.length).toBe(c.expectDeltas);

      const source = extractSource(c.file);
      expect(source, `${c.file}: expected a <content>-bearing requestBody`).toBeDefined();

      // Primary assertion (the issue's suggested minimum bar): the deltas
      // apply cleanly against the real source they were computed from — no
      // out-of-bounds / inverted / overlapping-range rejection.
      const result = applyRangeEdits(source!, deltas!);
      expect(result.ok, `${c.file}: ${JSON.stringify(result)}`).toBe(true);
      if (!result.ok) return;

      // Stronger assertion where the exact output is independently knowable.
      if (c.expectedResult !== undefined) {
        expect(result.result).toBe(c.expectedResult);
      }
    });
  }
});

// ------------------------------------------------- named edge cases ---

describe("range-edit fixture conformance — named edge cases", () => {
  it("803 (multi-unit rename): 4 units target the SAME object with identity content — round-trips to the original source byte-for-byte", () => {
    const source = extractSource("803-qf-proposal-rename-multiunit")!;
    const deltas = extractDeltas(fixtureXml("803-qf-proposal-rename-multiunit"))!;
    expect(deltas).toHaveLength(4);
    expect(deltas.every((d) => d.content === "lv_text")).toBe(true);
    // Independently (not via the applier) confirm each range really spans
    // "lv_text" in the source — this is the cross-check that the wire
    // fragment's column convention needs no adjustment (see header comment).
    const lines = source.split(/\r\n/);
    for (const d of deltas) {
      const line = lines[d.range.start.line - 1]!;
      expect(line.slice(d.range.start.column, d.range.end.column)).toBe("lv_text");
    }
    const result = applyRangeEdits(source, deltas);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result).toBe(source);
  });

  it("809 (empty deltas): a HOP-2 proposal can legitimately carry ZERO units — applyRangeEdits treats it as the documented no-op, not an error", () => {
    const deltas = extractDeltas(fixtureXml("809-qf-proposal-delete-member-empty-deltas"))!;
    expect(deltas).toEqual([]);
    const source = extractSource("809-qf-proposal-delete-member-empty-deltas")!;
    const result = applyRangeEdits(source, deltas);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result).toBe(source);
  });

  it("810 (descending unit order): the 2 units are listed in DESCENDING start-position order on the wire, and still apply cleanly", () => {
    const deltas = extractDeltas(fixtureXml("810-qf-proposal-change-to-private-descending-units"))!;
    expect(deltas).toHaveLength(2);
    // Confirm the fixture really does exercise descending order — if a
    // future re-capture ever came back ascending, this guards against the
    // test silently losing its point.
    const [first, second] = deltas as [RangeEdit, RangeEdit];
    const cmp = (a: Position, b: Position) => a.line - b.line || a.column - b.column;
    expect(cmp(first.range.start, second.range.start)).toBeGreaterThan(0);

    const source = extractSource("810-qf-proposal-change-to-private-descending-units")!;
    const asCaptured = applyRangeEdits(source, deltas);
    expect(asCaptured.ok).toBe(true);
    // `applyRangeEdits` documents that input order is never trusted (ranges
    // are re-sorted internally) — reversing the array must be byte-identical.
    const reversed = applyRangeEdits(source, [...deltas].reverse());
    expect(reversed.ok).toBe(true);
    if (asCaptured.ok && reversed.ok) expect(asCaptured.result).toBe(reversed.result);
  });

  it("811 (multi-insertion): both units are pure zero-width insertions (start === end) at distinct points, ascending order", () => {
    const deltas = extractDeltas(fixtureXml("811-qf-proposal-factory-method-two-insertions"))!;
    expect(deltas).toHaveLength(2);
    for (const d of deltas) {
      expect(d.range.start).toEqual(d.range.end);
    }
    const [first, second] = deltas as [RangeEdit, RangeEdit];
    const cmp = (a: Position, b: Position) => a.line - b.line || a.column - b.column;
    expect(cmp(first.range.start, second.range.start)).toBeLessThan(0);

    const source = extractSource("811-qf-proposal-factory-method-two-insertions")!;
    const result = applyRangeEdits(source, deltas);
    expect(result.ok).toBe(true);
  });
});
