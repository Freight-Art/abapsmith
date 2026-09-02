/**
 * `abap_write`'s edit primitive: exact-substring matcher/splicer, no ADT or
 * network dependency. `resolveWriteSource` (`src/tools/write.ts`) is the only
 * caller and owns everything wire-shaped.
 *
 * Matching is exact-substring — no regex, case-folding, or whitespace
 * collapsing; narrowing `old_string` until unique is the caller's job. Both
 * `source` and `old_string`/`new_string` are LF-normalized before matching,
 * and `result` is built from the normalized pieces, so a CRLF-authored object
 * comes back all-LF even far from the edited region. Whether PUTting that
 * back causes anything beyond ordinary server reformatting is unconfirmed —
 * see the git history.
 *
 * Matches are counted non-overlapping, left-to-right. Empty `old_string`, or
 * `old_string === new_string`, throw {@link EditInputError} before any scan —
 * never folded into a "0 matches" result.
 */

/** A `source`/`old_string` line, 1-based — as printed by `abap_read`. */
export type LineNumber = number;

export interface EditOk {
  readonly ok: true;
  readonly result: string;
}

export interface EditNoMatch {
  readonly ok: false;
  readonly kind: "no-match";
  /** Line(s) where old_string's first line alone was found; absent means even that missed. */
  readonly firstLineOccurrences?: readonly LineNumber[];
}

export interface EditAmbiguous {
  readonly ok: false;
  readonly kind: "ambiguous";
  /** Every non-overlapping match's starting line, in source order. */
  readonly matchLines: readonly LineNumber[];
}

export type EditResult = EditOk | EditNoMatch | EditAmbiguous;

/**
 * Thrown by {@link applyEdit} for a malformed call — empty `old_string`, or
 * `old_string === new_string` — not a failed search. Kept out of
 * {@link EditResult} so consumers don't handle it as a search outcome.
 */
export class EditInputError extends Error {}

const toLf = (s: string): string => s.replace(/\r\n/g, "\n");

/** Every non-overlapping occurrence of `needle` in `haystack`, left to right. */
function findAll(haystack: string, needle: string): number[] {
  const offsets: number[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    offsets.push(idx);
    from = idx + needle.length;
  }
  return offsets;
}

/** Character offset of the start of each line in `s` (`starts[0] === 0`). */
function lineStarts(s: string): number[] {
  const starts = [0];
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/** 1-based line number containing character `offset`, via `lineStarts(s)`. */
function lineAt(starts: readonly number[], offset: number): LineNumber {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Apply one unique-match (or `replaceAll`) splice to `source`. See the module
 * doc comment for matching rules.
 */
export function applyEdit(
  source: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,
): EditResult {
  if (oldString === "") {
    throw new EditInputError(
      "old_string must not be empty — an empty needle matches everywhere, which is never the intent.",
    );
  }
  if (oldString === newString) {
    throw new EditInputError("old_string and new_string are identical — this edit would change nothing.");
  }

  const normSource = toLf(source);
  const normOld = toLf(oldString);
  const normNew = toLf(newString);

  const offsets = findAll(normSource, normOld);

  if (offsets.length === 0) {
    const firstLine = normOld.split("\n")[0] ?? "";
    let firstLineOccurrences: LineNumber[] | undefined;
    // Blank first line would match everywhere — skip, not a useful hint.
    if (firstLine !== "") {
      const hits = findAll(normSource, firstLine);
      if (hits.length > 0) {
        const starts = lineStarts(normSource);
        firstLineOccurrences = hits.map((o) => lineAt(starts, o));
      }
    }
    return { ok: false, kind: "no-match", ...(firstLineOccurrences ? { firstLineOccurrences } : {}) };
  }

  if (offsets.length > 1 && !replaceAll) {
    const starts = lineStarts(normSource);
    return { ok: false, kind: "ambiguous", matchLines: offsets.map((o) => lineAt(starts, o)) };
  }

  let result = "";
  let cursor = 0;
  for (const o of offsets) {
    result += normSource.slice(cursor, o) + normNew;
    cursor = o + normOld.length;
  }
  result += normSource.slice(cursor);

  return { ok: true, result };
}

/**
 * Caller-facing prose for an `EditResult` failure — shown to the model via
 * `resolveWriteSource`'s thrown `AbapError`, so it can act without
 * re-deriving the diagnosis itself.
 */
export function describeEditFailure(r: EditNoMatch | EditAmbiguous): string {
  if (r.kind === "ambiguous") {
    return (
      `old_string appears ${r.matchLines.length} times ` +
      `(lines ${r.matchLines.join(", ")}) — pass replace_all:true to replace every ` +
      "occurrence, or narrow old_string (e.g. include a neighbouring line) so it matches exactly once."
    );
  }
  if (r.firstLineOccurrences && r.firstLineOccurrences.length > 0) {
    return (
      "old_string was not found (0 matches), but its first line alone appears at " +
      `line(s) ${r.firstLineOccurrences.join(", ")} — the rest of old_string has likely drifted ` +
      "from the current source (stale read, prior edit, or a whitespace mismatch). Re-read the " +
      "object and copy old_string verbatim from the current source."
    );
  }
  return (
    "old_string was not found (0 matches), and not even its first line appears anywhere in the " +
    "current source. Re-read the object to confirm old_string against what is actually there."
  );
}
