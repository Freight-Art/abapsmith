/**
 * Line-oriented unified diff — the substrate for `abap_read`'s version diff.
 *
 * Computed here, not server-side: ADT has no endpoint that diffs two arbitrary
 * versions of one object (SAP's differ is scoped to transport requests only).
 *
 * Uses Hirschberg's linear-space LCS (exact, O(n·m) time, O(min(n,m)) space)
 * after common prefix/suffix trimming, since this repo has no diff dependency.
 * Adjacent ABAP versions share nearly every line, so the trimmed problem stays
 * small even for large sources.
 *
 * Truncation is always marked, never silent (see `src/truncate.ts` header):
 *   1. {@link MAX_DIFF_CELLS} — a pathological pair gets one coarse
 *      replace-everything hunk with `coarse: true`.
 *   2. {@link DIFF_LINE_MAX} — an absurdly long line is shortened via
 *      `truncateForDisplay`, which appends its own ellipsis.
 *   3. `maxHunks` — excess hunks are reported in {@link DiffResult.droppedHunks}.
 */

import { truncateForDisplay } from "./truncate.js";

/**
 * Per-line display ceiling. Set comfortably above ADT's 255-char physical
 * line limit (`ADT_MAX_SOURCE_LINE_LEN`, `src/adt/fpm-lock.ts`) so ordinary
 * ABAP source is never cut, with headroom for source kinds without that
 * 255-byte limit (CDS DDLS/DDLX, XSLT). What exceeds this is pathological and
 * gets marked, not dropped.
 */
export const DIFF_LINE_MAX = 512;

/**
 * Ceiling on `oldLines.length * newLines.length` after prefix/suffix
 * trimming, above which exact LCS is skipped for one coarse hunk. ~2,000
 * changed lines per side — reached only on a full rewrite or unrelated
 * objects. Never produces a wrong diff, only a less granular one.
 */
export const MAX_DIFF_CELLS = 4_000_000;

/** Default number of unchanged context lines kept either side of a change. */
export const DEFAULT_CONTEXT_LINES = 3;

/** One `@@` block of a unified diff. All line numbers are 1-based. */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Rendered lines, each already prefixed with `" "`, `"-"` or `"+"`. */
  lines: string[];
}

export interface DiffResult {
  hunks: DiffHunk[];
  /** Lines present only on the new side. */
  added: number;
  /** Lines present only on the old side. */
  removed: number;
  /** The two sides are line-for-line identical. `hunks` is then empty. */
  identical: boolean;
  /**
   * The exact LCS was skipped (see {@link MAX_DIFF_CELLS}) and the single
   * emitted hunk replaces the whole changed region wholesale. The diff is
   * still correct — applying it reproduces the new side — but it is not
   * minimal, and callers MUST say so in their output.
   */
  coarse: boolean;
  /** Hunks dropped by the caller's `maxHunks` cap. Zero when nothing was cut. */
  droppedHunks: number;
  /** Total hunks the diff actually contains, before `maxHunks` was applied. */
  totalHunks: number;
}

export interface DiffOptions {
  /** Unchanged lines kept either side of a change. Default {@link DEFAULT_CONTEXT_LINES}. */
  context?: number;
  /** Maximum hunks to return. Excess is reported via `droppedHunks`, never dropped silently. */
  maxHunks?: number;
}

type EditKind = "eq" | "del" | "ins";

interface Edit {
  kind: EditKind;
  text: string;
}

/**
 * Splits source into lines the way a diff must see them: `\r\n` and `\r`
 * normalised to `\n`, and a single trailing newline NOT treated as an extra
 * empty last line (otherwise every diff of a file whose last line changed
 * reports a phantom edit at EOF).
 */
export function splitSourceLines(source: string): string[] {
  const normalised = source.replace(/\r\n?/g, "\n");
  if (normalised === "") return [];
  const lines = normalised.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * One row of the Needleman-Wunsch LCS-length matrix — the "score" half of
 * Hirschberg's algorithm. Returns an array of `b.length + 1` LCS lengths of
 * `a` against every prefix of `b`, in O(b.length) space.
 */
function lcsRow(a: string[], b: string[]): Int32Array {
  let prev = new Int32Array(b.length + 1);
  let curr = new Int32Array(b.length + 1);
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    curr[0] = 0;
    for (let j = 0; j < b.length; j++) {
      curr[j + 1] = ai === b[j] ? prev[j]! + 1 : Math.max(curr[j]!, prev[j + 1]!);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev;
}

/** `lcsRow` over the reversed sequences, returned in forward orientation. */
function lcsRowReversed(a: string[], b: string[]): Int32Array {
  const ra = a.slice().reverse();
  const rb = b.slice().reverse();
  const row = lcsRow(ra, rb);
  const out = new Int32Array(row.length);
  for (let i = 0; i < row.length; i++) out[i] = row[row.length - 1 - i]!;
  return out;
}

/**
 * Hirschberg's divide-and-conquer LCS. Emits the edit script directly into
 * `out` so no intermediate arrays are concatenated at every recursion level.
 *
 * Deletions are emitted before insertions at the same position, which is the
 * conventional unified-diff ordering (`-` lines then `+` lines) and the one
 * `renderUnifiedDiff` below relies on.
 */
function hirschberg(a: string[], b: string[], out: Edit[]): void {
  if (a.length === 0) {
    for (const text of b) out.push({ kind: "ins", text });
    return;
  }
  if (b.length === 0) {
    for (const text of a) out.push({ kind: "del", text });
    return;
  }
  if (a.length === 1) {
    const only = a[0]!;
    const idx = b.indexOf(only);
    if (idx === -1) {
      out.push({ kind: "del", text: only });
      for (const text of b) out.push({ kind: "ins", text });
      return;
    }
    for (let j = 0; j < idx; j++) out.push({ kind: "ins", text: b[j]! });
    out.push({ kind: "eq", text: only });
    for (let j = idx + 1; j < b.length; j++) out.push({ kind: "ins", text: b[j]! });
    return;
  }

  const mid = a.length >> 1;
  const head = lcsRow(a.slice(0, mid), b);
  const tail = lcsRowReversed(a.slice(mid), b);
  let best = -1;
  let split = 0;
  for (let j = 0; j <= b.length; j++) {
    const score = head[j]! + tail[j]!;
    if (score > best) {
      best = score;
      split = j;
    }
  }
  hirschberg(a.slice(0, mid), b.slice(0, split), out);
  hirschberg(a.slice(mid), b.slice(split), out);
}

/** The edit script, with common prefix/suffix trimmed off before the LCS runs. */
function editScript(
  oldLines: string[],
  newLines: string[],
): { edits: Edit[]; coarse: boolean } {
  let start = 0;
  const maxStart = Math.min(oldLines.length, newLines.length);
  while (start < maxStart && oldLines[start] === newLines[start]) start++;

  let end = 0;
  const maxEnd = Math.min(oldLines.length, newLines.length) - start;
  while (
    end < maxEnd &&
    oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]
  ) {
    end++;
  }

  const oldMid = oldLines.slice(start, oldLines.length - end);
  const newMid = newLines.slice(start, newLines.length - end);

  const edits: Edit[] = [];
  for (let i = 0; i < start; i++) edits.push({ kind: "eq", text: oldLines[i]! });

  let coarse = false;
  if (oldMid.length * newMid.length > MAX_DIFF_CELLS) {
    // See MAX_DIFF_CELLS — correct, just not minimal.
    coarse = true;
    for (const text of oldMid) edits.push({ kind: "del", text });
    for (const text of newMid) edits.push({ kind: "ins", text });
  } else {
    hirschberg(oldMid, newMid, edits);
  }

  for (let i = oldLines.length - end; i < oldLines.length; i++) {
    edits.push({ kind: "eq", text: oldLines[i]! });
  }
  return { edits, coarse };
}

/** `truncateForDisplay` applied to the text, then the unified-diff sigil. */
function renderLine(sigil: string, text: string): string {
  return sigil + truncateForDisplay(text, DIFF_LINE_MAX);
}

/**
 * Groups an edit script into unified-diff hunks with `context` unchanged lines
 * either side of every run of changes. Adjacent changes closer than
 * `2 * context` land in one hunk, as `diff -U` does.
 */
function toHunks(edits: Edit[], context: number): DiffHunk[] {
  const changedAt: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i]!.kind !== "eq") changedAt.push(i);
  }
  if (changedAt.length === 0) return [];

  // Merge changes into one hunk when the unchanged gap between them fits two
  // context regions: `i - to <= 2 * context + 1`, matching `diff -U`. The `+1`
  // is load-bearing at context=0 — without it a deleted line immediately
  // followed by its replacement wrongly splits into two hunks instead of one.
  const ranges: Array<{ from: number; to: number }> = [];
  let from = changedAt[0]!;
  let to = changedAt[0]!;
  for (let k = 1; k < changedAt.length; k++) {
    const i = changedAt[k]!;
    if (i - to <= context * 2 + 1) {
      to = i;
    } else {
      ranges.push({ from, to });
      from = i;
      to = i;
    }
  }
  ranges.push({ from, to });

  // 1-based source line numbers for each edit index.
  const oldNo = new Int32Array(edits.length);
  const newNo = new Int32Array(edits.length);
  let o = 1;
  let n = 1;
  for (let i = 0; i < edits.length; i++) {
    oldNo[i] = o;
    newNo[i] = n;
    if (edits[i]!.kind !== "ins") o++;
    if (edits[i]!.kind !== "del") n++;
  }

  return ranges.map((range) => {
    const lo = Math.max(0, range.from - context);
    const hi = Math.min(edits.length - 1, range.to + context);
    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let i = lo; i <= hi; i++) {
      const e = edits[i]!;
      if (e.kind === "eq") {
        lines.push(renderLine(" ", e.text));
        oldCount++;
        newCount++;
      } else if (e.kind === "del") {
        lines.push(renderLine("-", e.text));
        oldCount++;
      } else {
        lines.push(renderLine("+", e.text));
        newCount++;
      }
    }
    return {
      // An empty side is conventionally addressed as line 0 in unified diffs.
      oldStart: oldCount === 0 ? 0 : oldNo[lo]!,
      oldLines: oldCount,
      newStart: newCount === 0 ? 0 : newNo[lo]!,
      newLines: newCount,
      lines,
    };
  });
}

/** Diffs two sources line-wise and returns unified-diff hunks, never full text. */
export function diffSources(
  oldSource: string,
  newSource: string,
  options: DiffOptions = {},
): DiffResult {
  const context = options.context ?? DEFAULT_CONTEXT_LINES;
  const oldLines = splitSourceLines(oldSource);
  const newLines = splitSourceLines(newSource);
  const { edits, coarse } = editScript(oldLines, newLines);

  let added = 0;
  let removed = 0;
  for (const e of edits) {
    if (e.kind === "ins") added++;
    else if (e.kind === "del") removed++;
  }

  const all = toHunks(edits, context);
  // Counted loop, not `all.slice(0, maxHunks)`: keeps `droppedHunks` from
  // drifting away from what was actually withheld.
  const ceiling = typeof options.maxHunks === "number" && options.maxHunks >= 0
    ? options.maxHunks
    : all.length;
  const kept: DiffHunk[] = [];
  for (const hunk of all) {
    if (kept.length >= ceiling) break;
    kept.push(hunk);
  }

  return {
    hunks: kept,
    added,
    removed,
    identical: added === 0 && removed === 0,
    coarse,
    droppedHunks: all.length - kept.length,
    totalHunks: all.length,
  };
}

/** Renders hunks as unified-diff text, `@@` headers included. Never emits full sources. */
export function renderHunks(hunks: DiffHunk[]): string {
  return hunks
    .map((h) => {
      const header = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
      return [header, ...h.lines].join("\n");
    })
    .join("\n");
}
