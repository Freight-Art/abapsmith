/**
 * Static contract test: EVERY journal-entry
 * construction across the journal-linked tool files must set `systemKey`.
 *
 * ---------------------------------------------------------------------------
 * WHY A STATIC TRIPWIRE AND NOT (ONLY) ANOTHER BEHAVIOURAL TEST
 * ---------------------------------------------------------------------------
 *
 * The original bug: `abap_write` never wrote `systemKey`, so
 * `systemMismatchBlocker` (src/adt/undo.ts) could never reach its strong
 * `entry.systemKey === live.key` match and every abap_write entry fell through
 * to the weak, SID-only comparison — which cannot tell two boxes apart that
 * share a SID. The fix set `systemKey: systemKey(conn.cfg)` at each call site,
 * and behavioural tests pin the sites that existed at the time:
 * `test/write-system-key.test.ts` (create/update, real `abapWrite` + real
 * `Journal` round trip) and the batch-delete assertion in
 * `test/write.test.ts`.
 *
 * Those tests are necessary and insufficient, and we know that because it
 * already happened: a later change added `abapWriteBatchDelete` — a NEW, independent
 * `withJournalledMutation` call site — after the original fix was written,
 * and reintroduced the exact same gap on the new site. Every existing test
 * stayed green, because a per-site behavioural test can only assert about the
 * sites someone remembered to write one for. The failure mode is not "the
 * existing code regressed", it is "a sixth site arrives tomorrow and nothing
 * notices" — and only a test that enumerates the sites itself can catch that.
 *
 * The same gap surfaced one layer out: `abap_enh`
 * (src/tools/enh.ts) constructs journal entries at nine sites and set
 * `systemKey` at none of them — the field was never scoped beyond `write.ts`
 * because the original tripwire was never scoped beyond `write.ts` either.
 * It then happened a third time, and for the third distinct reason: the BOPF
 * tools (src/tools/bopf.ts, 3 sites) and the v2 `abap_do` enhancement handler
 * (src/tools/v2/handlers/do/enhancements.ts, 1 site) are journalling surfaces
 * that never went through `abap_write` OR `abap_enh` at all, so neither
 * earlier repair reached them and neither earlier version of this list named
 * them. The lesson each time is the same one: the enumeration, not the
 * per-site test, is what generalises.
 *
 * This file now enumerates the sites in every file named by
 * `JOURNAL_LINKED_FILES` below, so it asserts a property of the SOURCE, in the
 * same spirit as `test/journal-contract.test.ts` and
 * `test/safety-gate-contract.test.ts`: find every journal-entry construction
 * in each listed file, and require each one to set `systemKey`. Adding a new
 * journalled mutation to any of them without one turns this red, and the diff
 * that fixes it is one line.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT ASSERT
 * ---------------------------------------------------------------------------
 *
 * That the VALUE is correct. A source-text check cannot know what
 * `systemKey(conn.cfg)` evaluates to, and `JournalEntry.systemKey` is optional
 * with `src/journal.ts` writing it only when truthy, so a site that sets the
 * field to something empty would satisfy this file and still persist nothing.
 * That is exactly why the behavioural tests above exist alongside it: they
 * assert the PERSISTED entry's key equals `systemKey(conn.cfg)` byte for byte
 * — and, for the two newest surfaces, do it by reading the raw `index.jsonl`
 * line off disk rather than trusting `Journal.list()` or `abap_journal
 * mode=show` to have rendered the field back faithfully (see
 * `test/v2-enh-write-systemkey.test.ts` and the raw-bytes case in
 * `test/bopf-journal.test.ts`). That distinction is not pedantry: the truthy
 * check in `src/journal.ts` means an empty-string `systemKey` is dropped
 * SILENTLY at write time, so a test asserting on a formatted view — or merely
 * on the absence of a crash — passes against a completely broken field.
 * The two kinds of check cover different failure modes and neither replaces
 * the other.
 *
 * This file also says nothing about `systemMismatchBlocker`'s SID-only
 * fallback for historical entries, which must NOT be removed — 247 entries in
 * this repo's own journal predate the field and a backfill is impossible
 * because the information was never captured. That behaviour is pinned by
 * `test/undo.test.ts` ("does NOT refuse merely because the entry predates
 * systemKey" and the weak-check message assertion), which construct a genuinely
 * legacy entry by deleting the field rather than relying on what the write path
 * happens to emit today.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The journal-linked files this tripwire covers. Deliberately a list and not a
 * hard-coded path: the previous revision named `src/tools/bopf.ts` and
 * `src/tools/v2/handlers/do/enhancements.ts` as known-uncovered, pending the
 * `fix/bopf-v2-systemkey` branch, and asked that whichever branch touched this
 * line second resolve to the UNION of both lists rather than either side's.
 * That branch has now landed and both files are appended here, so the list is
 * that union.
 *
 * A later fix closed the fourth instance: `src/tools/ui.ts`'s single
 * `withJournalledMutation` site (`abap_ui press`, a BDC screen sequence) set
 * no `systemKey` either. Its `begin` builder has no `conn` in scope — `begin`
 * fires from `onBeforeImage(query)` before `deps.pool.withWrite` ever hands
 * one back — so the repair there uses the `systemKey({ sid, url, client })`
 * spelling `src/tools/transport.ts` and `src/server.ts` use, built from
 * `deps.cfg` (widened to carry `sid`/`url`/`client`), not the
 * `systemKey(conn.cfg)` spelling every other file in the list below uses.
 * The regex below accepts either spelling.
 *
 * Any further journal-linked file must be added here or this test cannot see
 * it. `test/journal-contract.test.ts` is the cross-check on that list being
 * complete.
 */
const JOURNAL_LINKED_FILES = [
  "src/tools/write.ts",
  "src/tools/enh.ts",
  "src/tools/bopf.ts",
  "src/tools/v2/handlers/do/enhancements.ts",
  "src/tools/ui.ts",
] as const;

const ABS_PATHS = JOURNAL_LINKED_FILES.map(
  (rel) => new URL(`../${rel}`, import.meta.url).pathname,
);

/**
 * Blank out comments and string/template contents, preserving length and
 * newlines so every index into the result still addresses the same character
 * of the original file.
 *
 * Both halves matter. Comments: this codebase's doc comments discuss the
 * journal constantly, and files like `src/tools/write.ts` explain
 * `systemKey` in prose next to the code — a naive search would score a pass on
 * the explanation of a site that does not set it, which is the precise mistake
 * `test/journal-contract.test.ts` documents having made. Strings: parenthesis
 * counting has to skip `"("` inside a message or the balanced slice below runs
 * off the end of the call.
 */
/** Keywords after which a `/` opens a regex literal rather than dividing. */
const REGEX_PREFIX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "new",
  "delete",
  "void",
  "throw",
]);

/**
 * Whether the `/` at `i` starts a regex literal. Looks back over the already
 * masked output, so blanked comments read as whitespace and are skipped for
 * free. A `/` divides only when it follows a value; everything else — operators,
 * `(`, `,`, `[`, `{`, `;`, start of file, or one of the keywords above — opens a
 * literal.
 */
function regexCanStartAt(out: string[], i: number): boolean {
  let j = i - 1;
  while (j >= 0) {
    const ch = out[j] as string;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") j--;
    else break;
  }
  if (j < 0) return true;
  const prev = out[j] as string;
  if (prev === ")" || prev === "]") return false;
  if (/[A-Za-z0-9_$]/.test(prev)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k] as string)) k--;
    const word = out.slice(k + 1, j + 1).join("");
    return REGEX_PREFIX_KEYWORDS.has(word);
  }
  return true;
}

/**
 * Index just past a regex literal (delimiters and flags included) starting at
 * `start`, or null if it does not close on the same line — in which case the
 * `/` was division after all and the caller must not consume it.
 */
function scanRegexLiteral(src: string, start: number): number | null {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\n") return null;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      i++;
      while (i < src.length && /[a-z]/.test(src[i] as string)) i++;
      return i;
    }
    i++;
  }
  return null;
}

function mask(src: string): string {
  const out = src.split("");
  const blank = (i: number) => {
    if (out[i] !== "\n") out[i] = " ";
  };
  // Frames model `` `text ${ expr } text` `` nesting. Inside a template —
  // interpolated expression as much as literal text — every character is
  // blanked, which is the same "string contents vanish" contract as before; the
  // frames exist only so the scanner can find where a template truly ends.
  // Scanning flatly to "the next backtick" instead gets this wrong the moment a
  // `${…}` holds another template or a backtick inside a nested string: the
  // scanner pairs an opening backtick with a closing one that is not its own and
  // every backtick after it is off by one. That is not hypothetical — it silently
  // masked out all three real `withJournalledMutation(` call sites in
  // src/tools/bopf.ts, so the per-file assertion below was passing on files it
  // had actually stopped reading (found while debugging this exact masker).
  type Frame = { kind: "text" } | { kind: "expr"; brace: number };
  const stack: Frame[] = [];
  const inTemplate = () => stack.length > 0;
  let brace = 0;
  let i = 0;
  while (i < src.length) {
    const top = stack[stack.length - 1];
    if (top?.kind === "text") {
      if (src[i] === "\\") {
        blank(i++);
        blank(i++);
        continue;
      }
      if (src[i] === "`") {
        stack.pop();
        if (inTemplate()) blank(i);
        i++; // keep the closing backtick of a top-level template
        continue;
      }
      if (src[i] === "$" && src[i + 1] === "{") {
        stack.push({ kind: "expr", brace });
        blank(i++);
        blank(i++);
        continue;
      }
      blank(i++);
      continue;
    }
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") blank(i++);
      continue;
    }
    if (c === "/" && n === "*") {
      blank(i++);
      blank(i++);
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) blank(i++);
      blank(i++);
      blank(i++);
      continue;
    }
    // Regex literals. `/\s+bo:name="[^"]*"/` in src/tools/bopf.ts holds an ODD
    // number of `"`, so a scanner that does not know regexes exist reads them as
    // string delimiters and every quote after it is off by one — which is how
    // this masker used to lose the tail of that file. Deciding regex-vs-division
    // needs the previous token: after a value (identifier, literal, `)`, `]`) a
    // `/` divides; anywhere else it opens a literal.
    if (c === "/" && regexCanStartAt(out, i)) {
      const end = scanRegexLiteral(src, i);
      if (end !== null) {
        while (i < end) blank(i++);
        continue;
      }
    }
    if (c === '"' || c === "'") {
      const quote = c;
      if (inTemplate()) blank(i);
      i++; // keep the opening quote, so the token still looks like a string
      while (i < src.length) {
        if (src[i] === "\\") {
          blank(i++);
          blank(i++);
          continue;
        }
        if (src[i] === quote) break;
        blank(i++);
      }
      if (inTemplate()) blank(i);
      i++; // and the closing quote
      continue;
    }
    if (c === "`") {
      if (inTemplate()) blank(i);
      i++; // keep the opening backtick
      stack.push({ kind: "text" });
      continue;
    }
    if (c === "{") {
      brace++;
      if (inTemplate()) blank(i);
      i++;
      continue;
    }
    if (c === "}") {
      if (top?.kind === "expr" && top.brace === brace) {
        stack.pop(); // closes the `${`
        blank(i++);
        continue;
      }
      brace--;
      if (inTemplate()) blank(i);
      i++;
      continue;
    }
    if (inTemplate()) blank(i);
    i++;
  }
  return out.join("");
}

/**
 * The balanced `(…)` slice starting at `open`, which must index the "(".
 * Returns the slice INCLUDING both parentheses. Throws rather than returning a
 * truncated slice: a silent truncation would make a site that DOES set
 * `systemKey` look like one that does not, and a green/red result that can be
 * produced by a parsing bug is worse than no test.
 */
function balancedParens(masked: string, open: number, file: string): string {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")") {
      depth--;
      if (depth === 0) return masked.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced parentheses starting at offset ${open} of ${file}`);
}

const lineOf = (src: string, offset: number) => src.slice(0, offset).split("\n").length;

/** Every journal-entry construction across all journal-linked files. */
function entryConstructionSites(): { file: string; line: number; text: string }[] {
  const sites: { file: string; line: number; text: string }[] = [];

  // The only two ways a journal entry comes into existence anywhere in `src/`
  // — `Journal.begin` is the sole writer of a new index line, and
  // `withJournalledMutation` is a wrapper around it. Same pair
  // `test/journal-contract.test.ts` uses to decide a file is journal-linked.
  // The optional `<…>` allows the explicit type arguments the call sites use.
  const CALL_RE = /\b(?:withJournalledMutation\s*(?:<[^(]*>)?|journal\??\.begin)\s*\(/g;

  for (let fi = 0; fi < JOURNAL_LINKED_FILES.length; fi++) {
    const file = JOURNAL_LINKED_FILES[fi];
    const raw = readFileSync(ABS_PATHS[fi], "utf8");
    const masked = mask(raw);
    for (const m of masked.matchAll(CALL_RE)) {
      const open = m.index + m[0].length - 1;
      sites.push({
        file,
        line: lineOf(raw, m.index),
        text: balancedParens(masked, open, file),
      });
    }
  }
  return sites;
}

describe("every journal entry construction sets systemKey", () => {
  it("finds the journal-entry construction sites across the journal-linked files", () => {
    const sites = entryConstructionSites();
    // A lower bound, not an exact count: this must not go red merely because a
    // legitimate new journalled mutation was added. It exists so that a broken
    // regex — which would find zero sites and vacuously pass every assertion
    // below — is itself a failure. At the time of writing there are 4 sites in
    // write.ts, 9 in enh.ts, 3 in bopf.ts, 1 in the v2 enhancement handler and
    // 1 in ui.ts (18 total); 16 is comfortably below that and comfortably
    // above zero.
    expect(sites.length).toBeGreaterThanOrEqual(16);

    // A whole-file total can stay above the bound even if ONE file's regex
    // silently stops matching (e.g. a helper gets renamed only in that file) —
    // the other files' counts mask the drop. Assert per-file too, so that
    // failure mode is caught rather than hidden.
    for (const file of JOURNAL_LINKED_FILES) {
      const count = sites.filter((s) => s.file === file).length;
      expect(count, `expected at least one journal-entry construction site in ${file}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("EVERY site sets systemKey — a new one that forgets it turns this red", () => {
    const missing = entryConstructionSites()
      .filter((s) => !/\bsystemKey\s*:/.test(s.text))
      .map((s) => `${s.file}:${s.line}`);

    expect(
      missing,
      missing.length === 0
        ? ""
        : `These journal-entry constructions do not set \`systemKey\`:\n` +
            missing.map((m) => `  - ${m}`).join("\n") +
            `\n\nAn entry without one cannot be checked by systemMismatchBlocker's strong\n` +
            `(SID + origin + client) comparison in src/adt/undo.ts — it silently falls back\n` +
            `to the SID-only check, which cannot tell a DEV and a sandbox both called A4H\n` +
            `apart, so a before-image from one can be restored onto the other. That is\n` +
            `the original systemKey gap, already reintroduced once on a newly added site.\n\n` +
            `Fix: add \`systemKey: systemKey(conn.cfg),\` to the entry, matching the other\n` +
            `sites in ${JOURNAL_LINKED_FILES.join(", ")} and src/tools/activate.ts / src/tools/transport.ts.`,
    ).toEqual([]);
  });

  it("the sites use the shared systemKey() helper rather than an ad-hoc string", () => {
    // `systemKey()` (src/journal.ts) is what `systemMismatchBlocker` builds the
    // LIVE side of its comparison with. A site that hand-rolled an equivalent
    // string would compare equal today and drift the moment the normalisation
    // (origin lowercasing, percent-encoding, the "|" join) is ever changed —
    // and the symptom would be undo refusing a legitimate entry, blamed on the
    // journal rather than on the duplication. There is one definition; use it.
    for (const site of entryConstructionSites()) {
      const m = /\bsystemKey\s*:\s*([^,\n]+)/.exec(site.text);
      expect(m, `no systemKey at ${site.file}:${site.line}`).not.toBeNull();
      expect(m![1].trim(), `${site.file}:${site.line}`).toMatch(/^systemKey\(/);
    }
  });
});
