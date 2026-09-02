/**
 * Response compaction.
 *
 *   "Hard rule: no tool response exceeds ~15k tokens. Above that, truncate with
 *    an explicit marker and a hint for fetching the rest (offset, method=,
 *    include=)."
 *
 * Every tool goes through `buildResponse`. Doing this per-tool is how the rule
 * quietly stops being true, so there is exactly one implementation and the tool
 * modules have no truncation logic of their own.
 */
import { createHash } from "node:crypto";

/**
 * 3.14 chars/token — deliberately the most conservative (smallest) of three
 * unverified candidates (3.14, 3.5, 4.41), since under-estimating chars/token
 * breaks the hard 15k-token rule while over-estimating only costs a little
 * payload. Not a measurement; see the git history.
 */
export const CHARS_PER_TOKEN = 3.14;

export const DEFAULT_MAX_TOKENS = 15_000;
export const DEFAULT_MAX_CHARS = Math.floor(DEFAULT_MAX_TOKENS * CHARS_PER_TOKEN);

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Content hash used as the etag. Normalises line endings so a CRLF/LF round
 * trip is not a false conflict — ADT returns CRLF.
 */
export function contentHash(content: string): string {
  const normalised = content.replace(/\r\n/g, "\n");
  return "sha256:" + createHash("sha256").update(normalised, "utf8").digest("hex").slice(0, 32);
}

/**
 * Marker prefix for an etag handed out alongside an incomplete delivery of
 * the text it hashes. The hash still covers the FULL resource —
 * hashing only the delivered window was considered and rejected, since an
 * etag over a window can't answer "did the resource change". It records one
 * extra fact: the caller never saw the whole text, which is what lets
 * `writeObject` (src/adt/write.ts) tell a truncated-read-written-back-whole
 * bug apart from a legitimate large deletion. `normaliseEtag` strips this
 * prefix before comparing, so concurrency checks are unaffected. See
 * the git history.
 */
export const PARTIAL_ETAG_PREFIX = "partial:";

/** True when `etag` was minted alongside an incomplete delivery of its text. */
export function isPartialEtag(etag: string): boolean {
  return etag.trim().toLowerCase().startsWith(PARTIAL_ETAG_PREFIX);
}

/** Wrap an etag as partial. Idempotent — never double-prefixes. */
export function markEtagPartial(etag: string): string {
  return isPartialEtag(etag) ? etag : `${PARTIAL_ETAG_PREFIX}${etag}`;
}

/**
 * The bare hash inside a `partial:`-marked etag, or `etag` unchanged.
 *
 * Used wherever the etag is being compared rather than judged — the marker is
 * a statement about the READ that produced it, never about the resource.
 */
export function stripPartialEtag(etag: string): string {
  const e = etag.trim();
  return isPartialEtag(e) ? e.substring(PARTIAL_ETAG_PREFIX.length) : etag;
}

/**
 * The form in which two sources the ABAP server considers identical are
 * identical: LF endings, trailing `[ \t]` trimmed per line (line kept, not
 * deleted), all trailing newlines stripped. Single source of truth for
 * `src/adt/write.ts` (`sourceEquals`/`canonicalEtag`) and `src/journal.ts`
 * (`sourceFingerprint`) — both import this rather than re-spelling it.
 *
 * Each step is independently measured against the real server; see
 * the git history for the probes, hashes and byte counts.
 * Two things are load-bearing and easy to regress:
 *
 * - Step 2 (whitespace trim) MUST run before step 3 (newline strip): a
 *   whitespace-only last line has no trailing newline to strip until step 2
 *   empties it first. Reversed, `"A.\n   "` canonicalises to `"A.\n"` instead
 *   of `"A."`, which the server never returns.
 * - The trim is `.split("\n").map(l => l.replace(/[ \t]+$/, "")).join("\n")`,
 *   not a single `/[ \t]+$/gm` (multiline `$` also matches before a bare
 *   `\r`, which is not known to be a line boundary here) and not `\s` (would
 *   also absorb FF/VT/CR/NBSP, which are untested as trim vs. line-terminator
 *   bytes and could silently pick the wrong handling).
 *
 * CLAS preserves trailing newlines server-side (unlike PROG, which strips
 * them all); strip-all is still applied uniformly here because the function
 * runs symmetrically over the caller's buffer and the server readback, so a
 * CLAS write still round-trips to a fixpoint.
 */
export function canonicalSource(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

export interface ResponseParts {
  /** `key: value` header lines. Undefined/empty values are dropped. */
  header?: Record<string, string | number | boolean | undefined | null>;
  /** Free-form sections rendered above the body (dependency prologue, DDL, …). */
  sections?: Array<{ title: string; content: string }>;
  /** The truncatable payload. Truncation is line-wise, never mid-line. */
  body?: string;
  /** Label for the body block, e.g. "SOURCE" or "FIELDS". */
  bodyLabel?: string;
  /**
   * 1-based line where the body starts. Must share a frame with
   * `bodyTotalLines` (both relative to a block, or both absolute) — mixing
   * them makes the paging hint never advance (see `tools/read.ts`).
   */
  bodyOffset?: number;
  /** Total line count in the SAME frame as `bodyOffset`. */
  bodyTotalLines?: number;
  /** Shown verbatim when the response is incomplete. */
  hints?: string[];
  /** Always shown. Blind-spot warnings etc. */
  notes?: string[];
  /**
   * This tool's input parameter that fetches the next chunk, e.g. "offset".
   * Omit if the tool has none — the notice then says paging isn't available
   * instead of advertising a parameter the tool would reject.
   */
  pagingParam?: string;
  maxChars?: number;
}

export interface BuiltResponse {
  text: string;
  /** The emitted text is not the whole body — either windowed or cut to fit. */
  truncated: boolean;
  /**
   * Anything AFTER the returned window? `truncated` can't answer that — the
   * last page of a windowed read is still `truncated: true` with nothing
   * left, so a paging loop keyed on `truncated` alone would never terminate.
   */
  hasMore?: boolean;
  estimatedTokens: number;
  returnedLines?: number;
  totalLines?: number;
  /** Exact emitted character count. Guaranteed `<= maxChars`. */
  chars?: number;
  /** True when the prologue sections had to be cut to fit the budget. */
  sectionsTruncated?: boolean;
}

function renderHeader(header: ResponseParts["header"]): string {
  if (!header) return "";
  const lines: string[] = [];
  for (const [k, v] of Object.entries(header)) {
    if (v === undefined || v === null || v === "") continue;
    lines.push(`${k}: ${v}`);
  }
  return lines.join("\n");
}

/** How much of the post-overhead budget the body may claim before sections are cut. */
const BODY_RESERVE_SHARE = 0.5;

/** Last-resort clamp. Guarantees the emitted text never exceeds `maxChars`. */
function hardClamp(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const original = text.length;
  const marker = (emitted: number) =>
    `\n--- OUTPUT HARD-CLAMPED ---\n${emitted} of ${original} characters emitted` +
    ` (hard cap ${maxChars}). The rest was dropped mid-text.`;
  let emitted = Math.max(0, maxChars - marker(original).length);
  while (emitted > 0 && emitted + marker(emitted).length > maxChars) emitted--;
  const clamped = text.slice(0, emitted) + marker(emitted);
  // Degenerate cap (smaller than the marker itself): still never exceed it.
  return clamped.length <= maxChars ? clamped : clamped.slice(0, maxChars);
}

/** Keep whole lines of `text` up to `budget` characters. */
function keepLines(text: string, budget: number): { kept: string; cutChars: number } {
  if (budget >= text.length) return { kept: text, cutChars: 0 };
  if (budget <= 0) return { kept: "", cutChars: text.length };
  const out: string[] = [];
  let left = budget;
  for (const line of text.split("\n")) {
    if (left - (line.length + 1) < 0) break;
    out.push(line);
    left -= line.length + 1;
  }
  const kept = out.join("\n");
  return { kept, cutChars: text.length - kept.length };
}

/**
 * Render a tool response so the WHOLE thing stays under the cap and every
 * omission is stated in the text the agent reads. Sections are budgeted and
 * cut line-wise like the body — previously only the body was fitted and large
 * sections blew straight through the cap (measured: 60,144 chars against a
 * 52,500 cap; see the git history) — and a final hard
 * clamp makes the cap unconditional.
 */
export function buildResponse(parts: ResponseParts): BuiltResponse {
  const maxChars = parts.maxChars ?? DEFAULT_MAX_CHARS;
  const header = renderHeader(parts.header);
  const sectionBlocks = (parts.sections ?? [])
    .filter((s) => s.content.trim().length > 0)
    .map((s) => `--- ${s.title} ---\n${s.content.trimEnd()}`);
  const sectionsFull = sectionBlocks.join("\n\n");
  const notes = (parts.notes ?? []).map((n) => `NOTE: ${n}`).join("\n");

  const bodyRaw = parts.body ?? "";
  const bodyLines = bodyRaw.length ? bodyRaw.replace(/\r\n/g, "\n").split("\n") : [];
  const totalLines = parts.bodyTotalLines ?? bodyLines.length;
  const label = parts.bodyLabel ?? "BODY";
  const offset = parts.bodyOffset ?? 1;

  const assemble = (sectionBlock: string, bodyBlock: string, notice: string): string =>
    [header, notes, sectionBlock, bodyBlock, notice]
      .filter((s) => s && s.trim().length > 0)
      .join("\n\n");

  /** Lines that exist AFTER the window this response returned. */
  const remainingAfter = (kept: number): number =>
    Math.max(0, totalLines - (offset - 1) - kept);

  /** The one place that decides whether `offset` may be advertised. */
  const nextChunkLine = (kept: number): string => {
    const remaining = remainingAfter(kept);
    if (remaining === 0) return "- This is the last chunk.";
    if (parts.pagingParam) {
      return (
        `- Fetch the next chunk with ${parts.pagingParam}=${offset + kept}` +
        ` (${remaining} line(s) not shown).`
      );
    }
    return (
      `- ${remaining} line(s) are not shown and this tool has NO offset/paging parameter —` +
      ` passing one would be rejected. Narrow the request instead (see the hints above).`
    );
  };

  const notice = (
    title: string,
    kept: number,
    sectionsCut?: { keptChars: number; totalChars: number; keptSections: number },
  ): string =>
    [
      `--- ${title} ---`,
      kept > 0
        ? `Returned lines ${offset}..${offset + kept - 1} of ${totalLines}` +
          ` (response capped at ${maxChars} chars / ~${Math.floor(maxChars / CHARS_PER_TOKEN)} tokens).`
        : `Returned 0 of ${totalLines} line(s) — the body did not fit` +
          ` (response capped at ${maxChars} chars / ~${Math.floor(maxChars / CHARS_PER_TOKEN)} tokens).`,
      ...(sectionsCut
        ? [
            `Prologue sections were ALSO cut: ${sectionsCut.keptChars} of` +
              ` ${sectionsCut.totalChars} characters kept in` +
              ` ${sectionsCut.keptSections} of ${sectionBlocks.length} section(s).`,
          ]
        : []),
      ...(parts.hints ?? []).map((h) => `- ${h}`),
      nextChunkLine(kept),
    ].join("\n");

  // ---- Fast path: everything fits. --------------------------------------
  const windowed = bodyLines.length < totalLines;
  const fastNotice = windowed ? notice("WINDOW", bodyLines.length) : "";
  const full = assemble(
    sectionsFull,
    bodyLines.length ? `--- ${label} ---\n${bodyRaw.trimEnd()}` : "",
    fastNotice,
  );
  if (full.length <= maxChars) {
    return {
      text: full,
      truncated: windowed,
      hasMore: remainingAfter(bodyLines.length) > 0,
      estimatedTokens: estimateTokens(full),
      returnedLines: bodyLines.length || undefined,
      totalLines: totalLines || undefined,
      chars: full.length,
      sectionsTruncated: false,
    };
  }

  // ---- Budget the sections first, then the body. -------------------------
  // Notice length isn't monotonic in `kept` (kept=0 has the longest wording,
  // kept=totalLines the widest line numbers) — reserve for the longer of the
  // two, or the cap gets breached by the difference (measured: 116 chars).
  const worstOf = (a: string, b: string) => (a.length >= b.length ? a : b);
  const worstNoticeFor = (cut?: { keptChars: number; totalChars: number; keptSections: number }) =>
    worstOf(notice("TRUNCATED", 0, cut), notice("TRUNCATED", totalLines, cut));
  const worstNotice = worstNoticeFor(
    sectionBlocks.length
      ? { keptChars: sectionsFull.length, totalChars: sectionsFull.length, keptSections: sectionBlocks.length }
      : undefined,
  );
  const overheadNoSections = assemble("", `--- ${label} ---\n`, worstNotice).length;
  const remainingBudget = Math.max(0, maxChars - overheadNoSections);
  const bodyReserve = Math.min(bodyRaw.length, Math.floor(remainingBudget * BODY_RESERVE_SHARE));
  const sectionsBudget = Math.max(0, remainingBudget - bodyReserve);

  const sectionsFit = keepLines(sectionsFull, sectionsBudget);
  const sectionsCut =
    sectionsFit.cutChars > 0
      ? {
          keptChars: sectionsFit.kept.length,
          totalChars: sectionsFull.length,
          keptSections: sectionsFit.kept
            ? sectionsFit.kept.split("\n").filter((l) => /^--- .* ---$/.test(l)).length
            : 0,
        }
      : undefined;

  const bodyOverhead = assemble(
    sectionsFit.kept,
    `--- ${label} ---\n`,
    worstNoticeFor(sectionsCut),
  ).length;
  const bodyFit = keepLines(bodyRaw.replace(/\r\n/g, "\n").trimEnd(), maxChars - bodyOverhead);
  const keptLines = bodyFit.kept ? bodyFit.kept.split("\n") : [];

  const text = hardClamp(
    assemble(
      sectionsFit.kept,
      keptLines.length ? `--- ${label} ---\n${bodyFit.kept}` : "",
      notice("TRUNCATED", keptLines.length, sectionsCut),
    ),
    maxChars,
  );

  return {
    text,
    truncated: true,
    hasMore: remainingAfter(keptLines.length) > 0,
    estimatedTokens: estimateTokens(text),
    returnedLines: keptLines.length,
    totalLines,
    chars: text.length,
    sectionsTruncated: Boolean(sectionsCut),
  };
}

/**
 * Take a line window out of a source string.
 * `offset` is 1-based and inclusive, matching what the truncation hint emits.
 */
export function sliceLines(
  source: string,
  offset = 1,
  limit?: number,
): { text: string; offset: number; total: number } {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const start = Math.max(0, offset - 1);
  const end = limit ? start + limit : lines.length;
  return {
    text: lines.slice(start, end).join("\n"),
    offset: start + 1,
    total: lines.length,
  };
}

/** Collapse an array of records into an aligned text table. Compact and cheap. */
export function textTable(rows: Array<Record<string, string>>, columns: string[]): string {
  if (rows.length === 0) return "";
  const widths = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => (r[c] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [line(columns), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(columns.map((c) => r[c] ?? "")))].join("\n");
}
