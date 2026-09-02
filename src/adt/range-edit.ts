/**
 * Pure, offline, dependency-free column-aware ranged-edit applier for ABAP
 * source. Mirrors `applyEdit` (`src/tools/v2/edit.ts`)'s discriminated-union
 * `ApplyResult` style, but never throws.
 *
 * Built to apply ADT quickfix deltas (`fixEdits`, `abap-adt-api`'s
 * `refactor.js`), which carry `{line, column}` ranges — unlike this repo's
 * line-only `SourceRange` (`src/adt/source.ts`). Every existing `#start=L,C`
 * parser in this codebase discards the column; this module is the missing
 * primitive that keeps it. General-purpose, not quickfix-specific (also
 * serves dry-run/preview on the write path).
 *
 * Semantics (every one load-bearing — get these wrong and a quickfix
 * corrupts source; full rationale and a live A4H-captured verification are
 * archived in the git history):
 * - Line 1-based; column 0-based UTF-16 code-unit caret position (the gap
 *   before the char at that index — `column === line.length` is valid, EOL).
 * - Range is half-open `[start, end)`; `start === end` is a valid insertion.
 * - Deliberately diverges from `SourceRange` (inclusive-end, whole-line).
 *   Do not reuse `parseFragmentRange` (`src/adt/source.ts`) here — it rounds
 *   `end` up to a whole line, which would delete text a quickfix never
 *   touched.
 * - Line endings and `edit.content` are never normalised/rewritten — only
 *   `source.slice`d outside the edited span (unlike `applyEdit`, which
 *   LF-normalises).
 * - Multi-edit: every range resolves against the ORIGINAL `source`; input
 *   order is never trusted (edits are re-sorted internally).
 * - A delta set may freely mix replacements and insertions, and may be
 *   empty (`applyRangeEdits(source, [])` is a no-op success).
 * - Overlaps are rejected, never silently resolved; edits that merely touch
 *   are fine. Two zero-width edits at the same point are a conflict.
 * - Out-of-bounds line/column is always rejected, never clamped (clamping
 *   risks silently truncating the ABAP object on write-back).
 * - Lines follow the LSP "phantom last line" convention: a trailing
 *   terminator opens a new addressable empty final line. Only `\n`/`\r\n`
 *   are terminators.
 */

/** A caret position: `line` 1-based, `column` 0-based UTF-16 code units — see the module header. */
export interface Position {
  readonly line: number;
  readonly column: number;
}

/** A half-open `[start, end)` span of caret positions — see the module header. */
export interface ColumnRange {
  readonly start: Position;
  readonly end: Position;
}

/** One ranged edit: replace everything in `range` with `content`, verbatim (no normalisation). */
export interface RangeEdit {
  readonly range: ColumnRange;
  readonly content: string;
}

export interface ApplyOk {
  readonly ok: true;
  readonly result: string;
}

/** Which endpoint of a range failed validation. */
export type RangeEndpoint = "start" | "end";

export interface ApplyOutOfBoundsLine {
  readonly ok: false;
  readonly kind: "out-of-bounds-line";
  readonly endpoint: RangeEndpoint;
  readonly line: number;
  /** The document's actual line count (1-based; the largest valid `line`). */
  readonly lineCount: number;
  /** Index into the `edits` array passed to `applyRangeEdits`; absent for `applyRangeEdit`. */
  readonly editIndex?: number;
}

export interface ApplyOutOfBoundsColumn {
  readonly ok: false;
  readonly kind: "out-of-bounds-column";
  readonly endpoint: RangeEndpoint;
  readonly line: number;
  readonly column: number;
  /** The line's length in UTF-16 code units (the largest valid `column` on this line). */
  readonly lineLength: number;
  readonly editIndex?: number;
}

export interface ApplyInvertedRange {
  readonly ok: false;
  readonly kind: "inverted-range";
  readonly range: ColumnRange;
  readonly editIndex?: number;
}

export interface ApplyOverlappingEdits {
  readonly ok: false;
  readonly kind: "overlapping-edits";
  /** Indices into the original `edits` array, in input order (not sorted order). */
  readonly firstIndex: number;
  readonly secondIndex: number;
}

export type ApplyResult =
  | ApplyOk
  | ApplyOutOfBoundsLine
  | ApplyOutOfBoundsColumn
  | ApplyInvertedRange
  | ApplyOverlappingEdits;

/** A validation/offset failure that isn't `ApplyOverlappingEdits` (that one only exists in the multi-edit path). */
type SingleEditFailure = ApplyOutOfBoundsLine | ApplyOutOfBoundsColumn | ApplyInvertedRange;

/** One line's extent in the source: `start` is its absolute offset, `length` excludes any terminator. */
interface LineExtent {
  readonly start: number;
  readonly length: number;
}

/**
 * Split `source` into line extents under the "phantom last line" convention
 * documented in the module header. Only `\n` and `\r\n` are terminators.
 */
function splitLines(source: string): LineExtent[] {
  const lines: LineExtent[] = [];
  const terminator = /\r\n|\n/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = terminator.exec(source)) !== null) {
    lines.push({ start: cursor, length: m.index - cursor });
    cursor = m.index + m[0].length;
  }
  lines.push({ start: cursor, length: source.length - cursor });
  return lines;
}

/** `a` before `b` → negative, equal → 0, `a` after `b` → positive. */
function comparePositions(a: Position, b: Position): number {
  return a.line - b.line || a.column - b.column;
}

/** Resolve one `Position` to an absolute offset into `source`, or a validation failure. */
function resolvePosition(
  lines: readonly LineExtent[],
  pos: Position,
  endpoint: RangeEndpoint,
  editIndex?: number,
): { ok: true; offset: number } | SingleEditFailure {
  if (!Number.isInteger(pos.line) || pos.line < 1 || pos.line > lines.length) {
    return {
      ok: false,
      kind: "out-of-bounds-line",
      endpoint,
      line: pos.line,
      lineCount: lines.length,
      ...(editIndex !== undefined ? { editIndex } : {}),
    };
  }
  const line = lines[pos.line - 1]!;
  if (!Number.isInteger(pos.column) || pos.column < 0 || pos.column > line.length) {
    return {
      ok: false,
      kind: "out-of-bounds-column",
      endpoint,
      line: pos.line,
      column: pos.column,
      lineLength: line.length,
      ...(editIndex !== undefined ? { editIndex } : {}),
    };
  }
  return { ok: true, offset: line.start + pos.column };
}

/**
 * Validate and resolve one `RangeEdit` against pre-split `lines`. Returns the
 * edit's `[startOffset, endOffset)` on success. `editIndex` is threaded
 * through into any failure purely for `applyRangeEdits`'s diagnostics — pass
 * `undefined` from `applyRangeEdit`.
 */
function resolveEdit(
  lines: readonly LineExtent[],
  edit: RangeEdit,
  editIndex?: number,
): { ok: true; startOffset: number; endOffset: number } | SingleEditFailure {
  const start = resolvePosition(lines, edit.range.start, "start", editIndex);
  if (!start.ok) return start;
  const end = resolvePosition(lines, edit.range.end, "end", editIndex);
  if (!end.ok) return end;
  if (comparePositions(edit.range.start, edit.range.end) > 0) {
    return {
      ok: false,
      kind: "inverted-range",
      range: edit.range,
      ...(editIndex !== undefined ? { editIndex } : {}),
    };
  }
  return { ok: true, startOffset: start.offset, endOffset: end.offset };
}

/**
 * Apply one column-precise ranged edit to `source`. Never throws — see the
 * module header for the full semantics (indexing, inclusivity, line endings,
 * column unit). `content` is inserted byte-for-byte; nothing outside
 * `[range.start, range.end)` is touched.
 */
export function applyRangeEdit(source: string, edit: RangeEdit): ApplyResult {
  const lines = splitLines(source);
  const resolved = resolveEdit(lines, edit);
  if (!resolved.ok) return resolved;
  const result = source.slice(0, resolved.startOffset) + edit.content + source.slice(resolved.endOffset);
  return { ok: true, result };
}

/**
 * Apply several column-precise ranged edits to `source` in one pass. Every
 * `edit.range` is relative to the ORIGINAL `source`, never to a
 * partially-edited intermediate — see the module header. Overlapping ranges
 * (sharing any character) are rejected outright, as is the ambiguous case of
 * two zero-width insertions at the identical position. An empty `edits`
 * array is a no-op success returning `source` unchanged.
 */
export function applyRangeEdits(source: string, edits: readonly RangeEdit[]): ApplyResult {
  if (edits.length === 0) return { ok: true, result: source };

  const lines = splitLines(source);

  // Resolve against the ORIGINAL source; bail on the first per-edit failure.
  const resolved: { index: number; startOffset: number; endOffset: number; start: Position; end: Position; content: string }[] =
    [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    const r = resolveEdit(lines, edit, i);
    if (!r.ok) return r;
    resolved.push({
      index: i,
      startOffset: r.startOffset,
      endOffset: r.endOffset,
      start: edit.range.start,
      end: edit.range.end,
      content: edit.content,
    });
  }

  // Tie-break by original index; the overlap check below catches same-start
  // edits regardless of tie-break order.
  const sorted = [...resolved].sort((a, b) => comparePositions(a.start, b.start) || a.index - b.index);

  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i]!;
    const next = sorted[i + 1]!;
    const gap = comparePositions(cur.end, next.start);
    const curZeroWidth = comparePositions(cur.start, cur.end) === 0;
    const nextZeroWidth = comparePositions(next.start, next.end) === 0;
    const sameZeroWidthPoint = gap === 0 && curZeroWidth && nextZeroWidth && comparePositions(cur.start, next.start) === 0;
    if (gap > 0 || sameZeroWidthPoint) {
      return { ok: false, kind: "overlapping-edits", firstIndex: cur.index, secondIndex: next.index };
    }
  }

  // Ascending accumulate-and-concat pass (equivalent to descending
  // splice-back-to-front); offsets already resolved against pristine `source`.
  let result = "";
  let cursor = 0;
  for (const r of sorted) {
    result += source.slice(cursor, r.startOffset) + r.content;
    cursor = r.endOffset;
  }
  result += source.slice(cursor);

  return { ok: true, result };
}
