/**
 * Variable rendering and context-budget layer — pure functions only (no HTTP,
 * state, or I/O), exercised entirely offline against `test/fixtures/debugger/`.
 *
 * Two modes: Tier 1 `renderSurvey` ("show me everything", never elides a NAME)
 * and Tier 2 `renderDrill` ("one thing, in detail", never elides a VALUE
 * silently). All truncation goes through `elide()` — the only truncation
 * primitive in this module (enforced by a structural + adversarial-input test
 * in `test/debug-render.test.ts`); the sanctioned marker is U+2026, never "...".
 *
 * Non-elided complete-information stubs: `<tab N rows>`, `struct, N comp`,
 * `objectref →0xADDR`.
 *
 * Do not build on SAP's `valueStatement` endpoint — unimplemented on this
 * release and unsafe to probe (see the git history).
 * Every render here works from `getVariables`/`getChildVariables` row data
 * only, using verified row-id addressing (`LT_ITEMS[3]-MATERIAL`) and
 * guarding the two silent-empty traps (see `renderEmptyBodyTrap`).
 */

import type {
  ChildVariablesResult,
  DebugMetaType,
  DebugStack,
  DebugVariable,
  StateId,
} from "./types.js";

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** Debugger char budget — deliberately below `src/compact.ts`'s repo-wide `DEFAULT_MAX_CHARS` (47,100): debugger output is denser and fetched repeatedly per stop. See archive for the full rationale. */
export const DEBUG_MAX_CHARS = 30_000;

/** Hard cap on rows examined by a `where=`-style scan before reporting the unexamined remainder explicitly (never scan silently). */
export const SCAN_ROW_CAP = 5_000;

/** Hard cap on stack frames listed in a rendered STACK section; the remainder is `elide()`d, never dropped silently. */
export const MAX_VISIBLE_FRAMES = 50;

// ---------------------------------------------------------------------------
// Path grammar — `root ( '-' segment | '[' index ']' )*`, 1-based indices.
// root: plain identifier, `<NAME>` field-symbol ref (only ROOT can be a field
// symbol; components after it use ordinary `-NAME`/`[N]`), or an @-prefixed
// scope pseudo-segment. @ROOT is a scope index (children @GLOBALS, and inside
// a method frame also @PARAMETERS/@LOCALS) — never a variable itself.
// ---------------------------------------------------------------------------

export type PathStep = { kind: "component"; name: string } | { kind: "index"; value: number };

export interface ParsedPath {
  /** The first segment: a plain identifier or one of the four scope pseudo-segments. */
  root: string;
  /** Zero or more `-NAME` / `[N]` steps, in order. */
  steps: PathStep[];
}

const SCOPE_SEGMENTS: ReadonlySet<string> = new Set(["@ROOT", "@GLOBALS", "@LOCALS", "@PARAMETERS"]);

function isIdentChar(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

/** Thrown by `parsePath` on any malformed path. `segment` names the offending piece — never coerced silently. */
export class PathSyntaxError extends Error {
  readonly segment: string;
  constructor(message: string, segment: string) {
    super(message);
    this.name = "PathSyntaxError";
    this.segment = segment;
  }
}

/** Parse a variable-ID path (`LT_ITEMS[3]-MATERIAL`, `@GLOBALS`, `SY-SUBRC`, …). Throws `PathSyntaxError` naming the offending segment — never coerces a malformed path into something plausible. */
/** Segment quoting cap: full text if short, else length-only (never a silently cut prefix) — the same "whole or none" promise `elide()` makes elsewhere; `elide()` itself doesn't apply here since it needs a retrieval call. */
const MAX_QUOTED_SEGMENT = 40;

function describeSegment(seg: string): string {
  return seg.length <= MAX_QUOTED_SEGMENT
    ? `"${seg}"`
    : `a ${seg.length}-character segment (too long to quote in full)`;
}

export function parsePath(raw: string): ParsedPath {
  if (raw.length === 0) {
    throw new PathSyntaxError("path is empty", "");
  }
  const n = raw.length;
  const readIdentFrom = (start: number): string => {
    let j = start;
    while (j < n && isIdentChar(raw[j]!)) j++;
    return raw.slice(start, j);
  };

  let root: string;
  let i: number;
  if (raw[0] === "@") {
    // readIdentFrom doesn't match "@" itself — scan after it and re-attach.
    root = "@" + readIdentFrom(1);
    if (!SCOPE_SEGMENTS.has(root)) {
      throw new PathSyntaxError(
        `unknown scope pseudo-segment "${root}" — expected one of @ROOT, @GLOBALS, @LOCALS, @PARAMETERS`,
        root,
      );
    }
    i = root.length;
  } else if (raw[0] === "<") {
    // Field-symbol root (e.g. `<LS_ITEM>`) — debugger addresses it with the same
    // angle-bracket spelling as ABAP source, no bracket-less alias. Only ROOT can
    // be a field symbol; components after it use the ordinary `-NAME`/`[N]` steps below.
    const nameStart = 1;
    const name = readIdentFrom(nameStart);
    if (name.length === 0) {
      const found = nameStart < n ? `"${raw[nameStart]!}"` : "the end of the path";
      throw new PathSyntaxError(
        `expected a field-symbol name after "<" at position 0, found ${found}`,
        "<",
      );
    }
    const closeAt = nameStart + name.length;
    if (raw[closeAt] !== ">") {
      const found = closeAt < n ? `"${raw[closeAt]!}"` : "the end of the path";
      throw new PathSyntaxError(
        `unterminated field-symbol name at position 0 — expected ">" after "<${name}", found ${found}`,
        "<",
      );
    }
    // Keep brackets in root — formatPath echoes root verbatim, so this is what
    // makes the round trip work without any special-casing there.
    root = `<${name}>`;
    i = closeAt + 1;
  } else if (/[A-Za-z_]/.test(raw[0]!)) {
    root = readIdentFrom(0);
    i = root.length;
  } else {
    // raw[0] exists (empty-path checked above); quote just that char + length
    // so an unbounded path can't yield an unbounded error message.
    throw new PathSyntaxError(
      `path must start with a name, "<FIELD_SYMBOL_NAME>", or a scope pseudo-segment ` +
        `(@ROOT/@GLOBALS/@LOCALS/@PARAMETERS), got "${raw[0]!}" (path is ${n} characters)`,
      raw[0]!,
    );
  }

  const steps: PathStep[] = [];
  while (i < n) {
    const c = raw[i]!;
    if (c === "-") {
      const nameStart = i + 1;
      const name = readIdentFrom(nameStart);
      if (name.length === 0) {
        const found = nameStart < n ? `"${raw[nameStart]!}"` : "the end of the path";
        throw new PathSyntaxError(`expected a component name after "-" at position ${i}, found ${found}`, "-");
      }
      steps.push({ kind: "component", name });
      i = nameStart + name.length;
    } else if (c === "[") {
      const digitsStart = i + 1;
      let j = digitsStart;
      while (j < n && /[0-9]/.test(raw[j]!)) j++;
      // Complete digit run (not truncated) — only its length is quoted in
      // errors, not the text, so a pathological run can't inflate an error.
      const digits = raw.slice(digitsStart, j);
      if (digits.length === 0) {
        const found = digitsStart < n ? `"${raw[digitsStart]!}"` : "the end of the path";
        // Extract to closing "]" or end of path; describeSegment quotes all or none of it.
        const closeAt = raw.indexOf("]", i);
        const segment = closeAt === -1 ? raw.substring(i) : raw.substring(i, closeAt + 1);
        throw new PathSyntaxError(
          `malformed index ${describeSegment(segment)} at position ${i} — expected "[<positive integer>]", found ${found} after "["`,
          segment,
        );
      }
      if (raw[j] !== "]") {
        const found = j < n ? `"${raw[j]!}"` : "the end of the path";
        throw new PathSyntaxError(
          `unterminated index at position ${i} — expected "]" after ${digits.length} digit(s), found ${found}`,
          "[",
        );
      }
      const value = Number(digits);
      // Reject rather than coerce: above 2^53-1 Number silently rounds, which
      // would address a different row than the caller wrote.
      if (!Number.isSafeInteger(value)) {
        throw new PathSyntaxError(
          `index at position ${i} is too large — it has ${digits.length} digits and the largest addressable row is ${Number.MAX_SAFE_INTEGER}`,
          "[",
        );
      }
      if (value < 1) {
        throw new PathSyntaxError(`index at position ${i} must be 1-based (>=1), got ${value}`, "[");
      }
      // Enforces round-trip: formatPath emits String(value), so accepting e.g.
      // "[007]" would break formatPath(parsePath(s)) === s.
      if (String(value) !== digits) {
        throw new PathSyntaxError(
          `index at position ${i} must not be written with leading zeros — write "[${value}]"`,
          "[",
        );
      }
      steps.push({ kind: "index", value });
      i = j + 1;
    } else {
      throw new PathSyntaxError(`unexpected character "${c}" at position ${i} — expected "-" or "["`, c);
    }
  }

  return { root, steps };
}

/** Render a `ParsedPath` back to its canonical string form — the inverse of `parsePath`. */
export function formatPath(path: ParsedPath): string {
  let out = path.root;
  for (const step of path.steps) {
    out += step.kind === "component" ? `-${step.name}` : `[${step.value}]`;
  }
  return out;
}

export type PathValidation = { ok: true; path: ParsedPath } | { ok: false; message: string; segment: string };

/** Non-throwing wrapper around `parsePath`, for callers that want a result rather than a catch block. */
export function validatePath(raw: string): PathValidation {
  try {
    return { ok: true, path: parsePath(raw) };
  } catch (e) {
    if (e instanceof PathSyntaxError) return { ok: false, message: e.message, segment: e.segment };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// The elision primitive — the ONLY truncation primitive in this module.
// ---------------------------------------------------------------------------

/** The only truncation primitive in this module: names what was cut, how much, and the exact retrieval call — never a bare ellipsis. (`describeComplex`'s complete-info stubs are not truncation and need no marker.) */
export function elide(what: string, count: number, retrievalCall: string): string {
  return `[${count} ${what} not shown — retrieve with: ${retrievalCall}]`;
}

/** Placeholder `stateId` used when the renderer wasn't given a real one. Deliberately a fill-in slot, not an omission: omitting the required field yields a bare "Required" error, while this placeholder is caught and explained by the handler's stale-state check. Loud-and-wrong beats quiet-and-wrong. */
export const STATE_ID_PLACEHOLDER = "<stateId>";

/** Row window in `abap_debug_value`'s terms (1-based `from` + `count`), not a display string. `count` is required — omitting it would let the handler silently default to 20 rows, which this type rules out. */
export interface RetrievalWindow {
  /** 1-based index of the first row to fetch. Always >= 1. */
  from: number;
  /** Number of rows to fetch. Always >= 1. */
  count: number;
}

/**
 * Convert 1-based inclusive `[start, end]` into `from`/`count`, clamped to stay positive.
 * `total`, when given, clamps `end` against the table length (reading past the end is a
 * silent empty result, not an error). Returns `undefined` for an empty/out-of-range window —
 * `count: 0` is a hard Zod rejection and omitting `count` would default to 20 rows. A
 * non-contiguous row set is passed through as its SPAN, not a set: over-fetching is
 * harmless, silently dropping rows is not.
 */
export function retrievalWindow(start: number, end: number, total?: number): RetrievalWindow | undefined {
  const from = Math.max(1, Math.trunc(start));
  const last = total === undefined ? Math.trunc(end) : Math.min(Math.trunc(end), Math.trunc(total));
  const count = last - from + 1;
  return count >= 1 ? { from, count } : undefined;
}

/**
 * Exact, copy-pasteable Tier-2 call text every `elide()` block and REACHABLE entry points to.
 * Keys emitted here MUST exist in `debugValueInputSchema` (src/tools/debug.ts) — that schema
 * is a non-strict `z.object`, so an unknown key is silently stripped, not rejected. Do not
 * add a key here without adding it there first.
 */
export function buildRetrievalCall(path: string, window?: RetrievalWindow, stateId?: string): string {
  const args = [`stateId: "${stateId ?? STATE_ID_PLACEHOLDER}"`, `path: "${path}"`];
  if (window !== undefined) {
    args.push(`from: ${window.from}`, `count: ${window.count}`);
  }
  return `abap_debug_value({ ${args.join(", ")} })`;
}

// ---------------------------------------------------------------------------
// Scalar / complex value rendering
// ---------------------------------------------------------------------------

const SCALAR_LIKE: ReadonlySet<DebugMetaType> = new Set([
  "simple",
  "string",
  "boxedcomp",
  "anonymcomp",
  "unknown",
]);

/** Same negative test as `xml-response.ts`'s `isComplexType` (see its doc comment on `DebugMetaType`), restated locally so this module has no runtime dependency on `xml-response.ts` — the file banner promises types-only imports. */
export function isComplex(metaType: string): boolean {
  return !SCALAR_LIKE.has(metaType as DebugMetaType);
}

/** U+2026 HORIZONTAL ELLIPSIS — the ONLY sanctioned truncation glyph. A bare three-period ellipsis must never appear anywhere in this module's output; see the structural test in `test/debug-render.test.ts`. */
const ELLIPSIS = "…";

/**
 * ABAP types whose wire VALUE carries its sign in a TRAILING column (live-proven in the
 * np-vars-negative fixtures): P packed and I integer. C/D have no sign column — trailing
 * spaces ARE the value there. Restated locally (not imported from xml-response.ts) to avoid
 * a runtime dependency; drift is caught by a cross-check test in test/debug-render.test.ts.
 */
const TRAILING_SIGN_TYPES = new Set(["P", "I"]);

/** Digits, at most one decimal point. No exponent, no `+`, no thousands separator — none observed. */
const NUMERIC_MAGNITUDE = /^\d+(?:\.\d+)?$/;

/**
 * `"123.45-"` → `"-123.45"`; `undefined` when unrecognised (caller falls back to raw bytes).
 * Never uses parseFloat/Number/unary `+` on the wire value: `parseFloat("123.45-")` silently
 * drops the sign, and converting to a JS number would lose the decimal scale (no DECIMALS
 * field exists; two P(8) rows with identical HEX_VALUE render "0.00 " vs "0.0000 ").
 */
function formatTrailingSignNumeric(raw: string): string | undefined {
  const body = raw.replace(/\s+$/, "");
  const negative = body.endsWith("-");
  const magnitude = (negative ? body.slice(0, -1) : body).replace(/^\s+/, "");
  if (!NUMERIC_MAGNITUDE.test(magnitude)) return undefined;
  return negative ? `-${magnitude}` : magnitude;
}

/**
 * P/I get sign-normalised (`formatTrailingSignNumeric`); everything else is emitted
 * byte-for-byte, trailing spaces included — for C/D the padding IS the value. When the
 * server flags `isValueIncomplete`, emits `'text…' [truncated, N chars]` (N = declared
 * length, else string length); never sign-normalised, since a fragment isn't a number.
 */
export function renderScalar(v: DebugVariable): string {
  if (!v.isValueIncomplete) {
    if (TRAILING_SIGN_TYPES.has(v.technicalType)) {
      const formatted = formatTrailingSignNumeric(v.value);
      if (formatted !== undefined) return formatted;
    }
    return v.value;
  }
  const n = v.length > 0 ? v.length : v.value.length;
  return `'${v.value}${ELLIPSIS}' [truncated, ${n} chars]`;
}

/**
 * One of three complete-information stubs (never truncation, no `elide()` marker needed):
 * `<tab N rows>`, `struct[, N comp]`, `objectref → 0xADDR`. Anything else complex falls back
 * to its declared type name.
 */
export function describeComplex(v: DebugVariable, childCount?: number): string {
  switch (v.metaType) {
    case "table":
      return v.tableLines === undefined ? `<tab ? rows>` : `<tab ${v.tableLines} rows>`;
    case "structure":
      return childCount === undefined ? "struct" : `struct, ${childCount} comp`;
    case "objectref":
    case "object":
    case "class":
    case "dataref": {
      const addr = extractAddress(v);
      return `objectref → ${addr}`;
    }
    default:
      return v.declaredTypeName || v.actualTypeName || v.metaType;
  }
}

function extractAddress(v: DebugVariable): string {
  const fromValue = /0x[0-9A-Fa-f]+/.exec(v.value);
  if (fromValue) return fromValue[0];
  if (v.hexValue) return `0x${v.hexValue}`;
  return "0x0";
}

/** One inline "name: value" line for a single variable — the building block both tiers assemble from. */
export function renderInline(v: DebugVariable, childCount?: number): string {
  const rendered = isComplex(v.metaType) ? describeComplex(v, childCount) : renderScalar(v);
  return `${v.name}: ${rendered}`;
}

// ---------------------------------------------------------------------------
// Tier 1 — the survey ("show me everything"). Must never elide a NAME.
// ---------------------------------------------------------------------------

export interface SurveyEntry {
  variable: DebugVariable;
  /** Component count, if already known from a prior expansion — feeds `describeComplex`. */
  childCount?: number;
}

export interface SurveyResult {
  text: string;
  /** Names whose line was shortened to fit budget (elide()'d value, or stripped to a bare name) — never a name that was dropped; every variable always has exactly one line in `text`. */
  degraded: string[];
}

/** The literal that opens the addressability block. Named because the budget arithmetic has to price the block without building it. */
const REACHABLE_HEADER = "--- REACHABLE ---";

/** The row window a REACHABLE entry's retrieval call opens with: the first page of a table, clamped to 20 rows. `undefined` for anything that is not a non-empty table. */
function reachableWindow(v: DebugVariable): RetrievalWindow | undefined {
  if (v.metaType !== "table") return undefined;
  if (v.tableLines === undefined) return { from: 1, count: 20 };
  return v.tableLines > 0 ? { from: 1, count: Math.min(20, v.tableLines) } : undefined;
}

/** One `--- REACHABLE ---` line: the complex value's inline stub plus the exact, copy-pasteable Tier-2 call that retrieves it. */
function reachableLine(e: SurveyEntry, stateId?: string): string {
  const v = e.variable;
  return `  ${v.name} (${describeComplex(v, e.childCount)}) → ${buildRetrievalCall(v.name, reachableWindow(v), stateId)}`;
}

/**
 * Degraded form of a survey line: name kept, value replaced by `elide()`. Returns `undefined`
 * when degrading wouldn't actually shorten the line (complex values, or short scalars whose
 * elide block is longer than the value) — prevents degradation from growing the survey.
 */
function degradedLine(e: SurveyEntry, fullLine: string, stateId?: string): string | undefined {
  const v = e.variable;
  if (isComplex(v.metaType)) return undefined;
  const fullLen = v.length > 0 ? v.length : v.value.length;
  const line = `${v.name}: ${elide("chars", fullLen, buildRetrievalCall(v.name, undefined, stateId))}`;
  return line.length < fullLine.length ? line : undefined;
}

/** One survey line while the budget ladder runs: its full form, its degraded form when that is genuinely shorter, and the form currently chosen. */
interface SurveyRow {
  entry: SurveyEntry;
  full: string;
  short: string | undefined;
  text: string;
  degraded: boolean;
}

/**
 * Tier 1 — "show me everything". One line per variable; NEVER drops a name, no
 * matter how tight the budget. Ends with a REACHABLE block (complex values,
 * largest-first) each with a copy-pasteable Tier-2 retrieval call — complete
 * inventory plus complete addressability.
 *
 * Over budget, three levers fire in order, cheapest information first, each an
 * `elide()` that makes real progress:
 *   1. Trim the REACHABLE block tail-first (sorted largest-first), one collective
 *      `elide()` for the rest — pure addressability, sacrificed before any value.
 *   2. Degrade values, biggest saving first, only as many as needed and only
 *      where the degraded line is genuinely shorter. Freed budget goes back to
 *      the REACHABLE block.
 *   3. Last resort: strip values to bare `NAME:` lines, one collective `elide()`.
 *
 * Names are never a lever — if even bare names exceed `maxChars`, the result is
 * returned over budget; completeness of the name list outranks the budget.
 */
export function renderSurvey(
  entries: SurveyEntry[],
  opts?: { maxChars?: number; scopeLabel?: string; stateId?: string },
): SurveyResult {
  const maxChars = opts?.maxChars ?? DEBUG_MAX_CHARS;
  const stateId = opts?.stateId;
  const header = opts?.scopeLabel ? `=== ${opts.scopeLabel} ===` : "=== VARIABLES ===";

  const reachable = entries
    .filter((e) => isComplex(e.variable.metaType))
    .sort((a, b) => {
      // -1 is a sort sentinel only (never rendered): unknown-count tables sort last.
      const aLines = a.variable.tableLines ?? -1;
      const bLines = b.variable.tableLines ?? -1;
      const linesDiff = bLines - aLines;
      if (linesDiff !== 0) return linesDiff;
      return b.variable.length - a.variable.length;
    });
  // NOT point-free: `Array.prototype.map` passes `(element, index, array)`, so
  // `map(reachableLine)` would feed the array index into the `stateId` slot.
  const reachableTexts = reachable.map((e) => reachableLine(e, stateId));

  /** The single `elide()` standing in for the REACHABLE lines past `kept`; empty when none are omitted. Its call retrieves the largest omitted value, so it always makes progress. */
  const collapseLine = (kept: number): string => {
    const omitted = reachable.slice(kept);
    const [first] = omitted;
    if (first === undefined) return "";
    const v = first.variable;
    return `  ${elide("retrieval calls", omitted.length, buildRetrievalCall(v.name, reachableWindow(v), stateId))}`;
  };

  const buildBlock = (kept: number): string => {
    if (reachable.length === 0) return "";
    const shown = reachableTexts.slice(0, kept);
    const collapsed = collapseLine(kept);
    if (collapsed.length > 0) shown.push(collapsed);
    return `${REACHABLE_HEADER}\n${shown.join("\n")}`;
  };

  /** `buildBlock(kept).length` without building it — the fit search prices every `kept`. */
  const blockLen = (kept: number): number => {
    if (reachable.length === 0) return 0;
    const collapsed = collapseLine(kept);
    return (
      REACHABLE_HEADER.length +
      reachableTexts.slice(0, kept).reduce((n, t) => n + 1 + t.length, 0) +
      (collapsed.length > 0 ? 1 + collapsed.length : 0)
    );
  };

  const rows: SurveyRow[] = entries.map((e) => {
    const full = renderInline(e.variable, e.childCount);
    return { entry: e, full, short: degradedLine(e, full, stateId), text: full, degraded: false };
  });

  /** The name list, plus the one collective `elide()` once values have been stripped. */
  let valuesElided = "";
  const listSection = (): string => {
    const body = rows.map((r) => r.text).join("\n");
    return valuesElided.length > 0 ? `${body}\n${valuesElided}` : body;
  };

  const assemble = (kept: number): string =>
    [header, listSection(), buildBlock(kept)].filter((s) => s.length > 0).join("\n\n");

  /** The largest number of REACHABLE lines that still fits — the whole block when it fits, and never a collapsed form longer than the block it replaces. */
  const fitKept = (): number => {
    const n = reachable.length;
    if (n === 0) return 0;
    const outside = header.length + 2 + listSection().length + 2;
    const fullLen = blockLen(n);
    if (outside + fullLen <= maxChars) return n;
    let best = n;
    for (let kept = n - 1; kept >= 0; kept--) {
      const len = blockLen(kept);
      if (len >= fullLen) continue;
      best = kept;
      if (outside + len <= maxChars) break;
    }
    return best;
  };

  let kept = fitKept();
  let text = assemble(kept);

  if (text.length > maxChars) {
    // Lever 2 — degrade values, biggest saving first, only as many as needed.
    const candidates: { row: SurveyRow; short: string; saving: number }[] = rows.flatMap((row) =>
      row.short === undefined ? [] : [{ row, short: row.short, saving: row.full.length - row.short.length }],
    );
    candidates.sort((a, b) => b.saving - a.saving);
    let projected = text.length;
    for (const c of candidates) {
      if (projected <= maxChars) break;
      projected -= c.saving;
      c.row.text = c.short;
      c.row.degraded = true;
    }
    kept = fitKept();
    text = assemble(kept);
  }

  if (text.length > maxChars) {
    // Lever 3 — strip values, keep names, account for all of them in one
    // `elide()`. `+ 1` in the filter excludes lines with no value to hide, so
    // the collective marker can never claim something that was never there.
    const candidates: { row: SurveyRow; bare: string }[] = rows
      .map((row) => ({ row, bare: `${row.entry.variable.name}:` }))
      .filter((c) => c.row.text.length > c.bare.length + 1)
      .sort((a, b) => b.row.text.length - b.bare.length - (a.row.text.length - a.bare.length));
    const longestName = candidates.reduce(
      (name, c) => (c.row.entry.variable.name.length > name.length ? c.row.entry.variable.name : name),
      "",
    );
    // Upper bound on the marker line the stripping will add, reserved up front so
    // the greedy loop can never stop one line short of actually fitting.
    const reserve = 1 + elide("values", candidates.length, buildRetrievalCall(longestName, undefined, stateId)).length;
    const stripped: { row: SurveyRow; bare: string }[] = [];
    let saved = 0;
    for (const c of candidates) {
      if (text.length + reserve - saved <= maxChars) break;
      saved += c.row.text.length - c.bare.length;
      stripped.push(c);
    }
    const strippedRows = new Set(stripped.map((c) => c.row));
    const firstStripped = rows.find((r) => strippedRows.has(r));
    if (firstStripped !== undefined) {
      const marker = elide(
        "values",
        strippedRows.size,
        buildRetrievalCall(firstStripped.entry.variable.name, undefined, stateId),
      );
      if (saved > marker.length + 1) {
        for (const c of stripped) {
          c.row.text = c.bare;
          c.row.degraded = true;
        }
        valuesElided = marker;
        kept = fitKept();
        text = assemble(kept);
      }
    }
  }

  return { text, degraded: rows.filter((r) => r.degraded).map((r) => r.entry.variable.name) };
}

// ---------------------------------------------------------------------------
// Tier 2 — the drill-in ("one thing, in detail"). Must never elide a VALUE
// silently.
// ---------------------------------------------------------------------------

export interface VariableNode {
  variable: DebugVariable;
  /** Present only when this node's children were actually fetched (one `getChildVariables` call per level). Absent means "not yet expanded" — a fact this module reports explicitly, never confuses with "no children". */
  children?: VariableNode[];
}

/** Attach one level of children to `parent` from a `getChildVariables` result, using `HIERARCHIES` to de-multiplex rows by parent. Call again on a child to grow the tree deeper. */
export function withChildren(parent: DebugVariable, result: ChildVariablesResult): VariableNode {
  const byId = new Map(result.variables.map((v) => [v.id, v] as const));
  const childIds = result.hierarchies.filter((h) => h.parentId === parent.id).map((h) => h.childId);
  const children = childIds.map((id) => {
    const v = byId.get(id);
    if (!v) {
      throw new Error(`withChildren: no variable row for child id "${id}" of parent "${parent.id}"`);
    }
    return { variable: v } satisfies VariableNode;
  });
  return { variable: parent, children };
}

export interface TableWindowOptions {
  /** 1-based inclusive row range requested, clamped against `TABLE_LINES` before rendering (reading past the end is a silent empty, so callers must clamp, never trust an out-of-range request to fail loudly). */
  start: number;
  end: number;
}

/**
 * Pieces of a windowed table render, kept apart (not pre-joined) so a budget-constrained
 * caller can drop ROWS individually with a correct `elide()`. `header`/`leading`/`trailing`
 * ARE the addressability and are never dropped; `rows` is the only droppable part.
 */
interface TableRowsRender {
  /** One-line header: name, total row count, and the window actually rendered. */
  header: string;
  /** Blocks belonging before the rows — the "rows before the window" `elide()`. */
  leading: string[];
  /** One unit per rendered row, ascending by `index`. A unit is either a row line or an in-window gap `elide()` covering rows the caller never fetched; `index` is the first table row the unit accounts for. */
  rows: { index: number; line: string }[];
  /** Blocks belonging after the rows: the "rows after the window" `elide()`, the clamp notice, and every fetched row that could not be placed. */
  trailing: string[];
  /** The clamped window actually rendered. `undefined` only for a table the server reports as having no rows. */
  window?: TableWindowOptions;
}

/** Name every fetched row with no place in the rendered window, one line each with its own retrieval call — dropping one silently would be "empty but successful", the worst outcome this module can produce. */
function unplaceableRowsBlock(nodes: VariableNode[], reason: string, stateId?: string): string[] {
  return [
    `  [${nodes.length} fetched row(s) could not be placed — ${reason}; listed individually so none is dropped]`,
    ...nodes.map(
      (n) =>
        `    ${n.variable.id}: ${describeComplex(n.variable, n.children?.length)} → ${buildRetrievalCall(n.variable.id, undefined, stateId)}`,
    ),
  ];
}

/**
 * Build the individually-elidable pieces of a windowed table render: `elide()` blocks for
 * rows before/after the window, unfetched in-window rows, out-of-window fetched rows, and
 * unindexed rows. A clamped window says so explicitly.
 */
function buildTableRowsRender(
  v: DebugVariable,
  rows: VariableNode[],
  window: TableWindowOptions,
  path: string,
  stateId?: string,
): TableRowsRender {
  const total = v.tableLines;
  if (total !== undefined && total <= 0) {
    return {
      header: `${v.name}: <tab 0 rows>`,
      leading: [],
      rows: [],
      trailing:
        rows.length > 0
          ? unplaceableRowsBlock(rows, "TABLE_LINES=0, so there is no window to place them in", stateId)
          : [],
    };
  }

  // Clamped against TABLE_LINES when known. When unknown we still open the
  // requested window (we don't know it's empty) rather than skip clamping —
  // Math.min(x, undefined) is NaN, which would poison every bound below.
  const lo = total === undefined ? Math.max(1, window.start) : Math.min(Math.max(1, window.start), total);
  const hi = total === undefined ? Math.max(lo, window.end) : Math.min(Math.max(lo, window.end), total);
  const header = `${v.name}: <tab ${total ?? "?"} rows> — showing ${lo}-${hi}`;

  const indexed = rows.map((r) => ({ index: rowIndexOf(r.variable.id), node: r }));
  const placed = indexed
    .filter((r) => r.index >= lo && r.index <= hi)
    .sort((a, b) => a.index - b.index);
  const outside = indexed.filter((r) => r.index >= 1 && (r.index < lo || r.index > hi));
  const unindexed = indexed.filter((r) => r.index < 1);

  const units: { index: number; line: string }[] = [];
  let next = lo;
  for (const r of placed) {
    if (r.index > next) {
      units.push({
        index: next,
        line: `  ${elide("rows", r.index - next, buildRetrievalCall(path, retrievalWindow(next, r.index - 1, total), stateId))}`,
      });
    }
    units.push({
      index: r.index,
      line: `  [${r.index}] ${describeComplex(r.node.variable, r.node.children?.length)}`,
    });
    next = Math.max(next, r.index + 1);
  }
  if (next <= hi) {
    units.push({
      index: next,
      line: `  ${elide("rows", hi - next + 1, buildRetrievalCall(path, retrievalWindow(next, hi, total), stateId))}`,
    });
  }

  const leading: string[] = [];
  const before = lo - 1;
  if (before > 0) {
    leading.push(`  ${elide("rows", before, buildRetrievalCall(path, retrievalWindow(1, before, total), stateId))}`);
  }

  const trailing: string[] = [];
  // Both notes claim things about the total; with TABLE_LINES unknown neither
  // can be made truthfully, so skip both.
  if (total !== undefined) {
    const after = total - hi;
    if (after > 0) {
      trailing.push(
        `  ${elide("rows", after, buildRetrievalCall(path, retrievalWindow(hi + 1, total, total), stateId))}`,
      );
    }
    if (window.start !== lo || window.end !== hi) {
      trailing.push(
        `  [window clamped — requested ${window.start}-${window.end}, table has ${total} row(s); rendered ${lo}-${hi}]`,
      );
    }
  }
  if (outside.length > 0) {
    const indices = outside.map((r) => r.index);
    trailing.push(
      `  ${elide(
        "fetched rows outside the rendered window",
        outside.length,
        // A SPAN not a set — over-fetching gaps is harmless, dropping rows silently is not.
        buildRetrievalCall(path, retrievalWindow(Math.min(...indices), Math.max(...indices), total), stateId),
      )}`,
    );
  }
  if (unindexed.length > 0) {
    trailing.push(
      ...unplaceableRowsBlock(
        unindexed.map((r) => r.node),
        'their row id does not end in "[N]"',
        stateId,
      ),
    );
  }

  return { header, leading, rows: units, trailing, window: { start: lo, end: hi } };
}

/**
 * Render a windowed slice of a table's already-fetched rows (`VariableNode`s). Clamps the
 * window against `TABLE_LINES` (says so explicitly), and `elide()`s everything it doesn't
 * render — never a silent cut or drop. How a 100,000-row table stays within budget while
 * remaining fully addressable.
 */
export function renderTableRows(
  v: DebugVariable,
  rows: VariableNode[],
  window: TableWindowOptions,
  path: string,
  stateId?: string,
): string {
  const parts = buildTableRowsRender(v, rows, window, path, stateId);
  return [parts.header, ...parts.leading, ...parts.rows.map((u) => u.line), ...parts.trailing].join("\n");
}

function rowIndexOf(id: string): number {
  const m = /\[(\d+)\]$/.exec(id);
  return m ? Number(m[1]) : -1;
}

export interface DrillOptions {
  /** Max nesting depth to render before cutting off with an `elide()` block. Default 3. */
  depth?: number;
  /** 1-based inclusive row window — only meaningful when the root node is a table. */
  rows?: TableWindowOptions;
  maxChars?: number;
  /** The debug state the emitted retrieval hints should quote. Omitted → hints carry `STATE_ID_PLACEHOLDER`. */
  stateId?: string;
}

/**
 * Render one node to bounded depth. Nested tables below the top level always render as the
 * terse `<tab N rows>` stub plus retrieval call — never expanded, even if rows happen to be
 * fetched, so nested tables can't runaway-expand.
 */
function renderNode(
  node: VariableNode,
  depth: number,
  maxDepth: number,
  path: string,
  stateId?: string,
): string[] {
  const v = node.variable;
  const indent = "  ".repeat(depth);

  if (v.metaType === "table") {
    return [
      `${indent}${v.name}: ${describeComplex(v)}`,
      `${indent}  → ${buildRetrievalCall(path, reachableWindow(v), stateId)}`,
    ];
  }

  if (!isComplex(v.metaType)) {
    return [`${indent}${v.name}: ${renderScalar(v)}`];
  }

  const line = `${indent}${v.name}: ${describeComplex(v, node.children?.length)}`;

  if (depth >= maxDepth) {
    if (node.children && node.children.length > 0) {
      return [
        line,
        `${indent}  ${elide("children", node.children.length, buildRetrievalCall(path, undefined, stateId))}`,
      ];
    }
    return [line];
  }

  if (!node.children) {
    return [line, `${indent}  (not expanded — ${buildRetrievalCall(path, undefined, stateId)})`];
  }

  const childLines = node.children.flatMap((c) =>
    renderNode(c, depth + 1, maxDepth, `${path}-${c.variable.name}`, stateId),
  );
  return [line, ...childLines];
}

/**
 * Fit a windowed table render into `maxChars` by dropping ROWS from the end, never by dropping
 * the render whole. Header, leading/trailing `elide()` blocks and the unplaceable-row report
 * are reserved first and always survive — an over-budget render that keeps them beats a
 * correctly-sized one that says nothing.
 *
 * The `elide()` for dropped rows always suggests a narrower, progress-making window; when no
 * row fits at all, it falls back to a single-row path (`LT[N]`).
 */
function renderTableWithinBudget(
  v: DebugVariable,
  rows: VariableNode[],
  window: TableWindowOptions,
  path: string,
  maxChars: number,
  stateId?: string,
): string {
  const parts = buildTableRowsRender(v, rows, window, path, stateId);
  const assemble = (units: { index: number; line: string }[], drop?: string): string =>
    [
      parts.header,
      ...parts.leading,
      ...units.map((u) => u.line),
      ...(drop === undefined ? [] : [drop]),
      ...parts.trailing,
    ].join("\n");

  const full = assemble(parts.rows);
  if (full.length <= maxChars || parts.window === undefined || parts.rows.length === 0) {
    return full;
  }

  const worstDrop = `  ${elide(
    "rows",
    parts.window.end - parts.window.start + 1,
    buildRetrievalCall(path, retrievalWindow(parts.window.start, parts.window.end), stateId),
  )}`;
  const overhead = [parts.header, ...parts.leading, ...parts.trailing, worstDrop].reduce(
    (n, line) => n + line.length + 1,
    0,
  );

  const kept: { index: number; line: string }[] = [];
  let used = overhead;
  for (const unit of parts.rows) {
    if (used + unit.line.length + 1 > maxChars) break;
    kept.push(unit);
    used += unit.line.length + 1;
  }
  const dropped = parts.rows.slice(kept.length);
  if (dropped.length === 0) return full;

  const droppedStart = dropped[0]!.index;
  const droppedEnd = parts.window.end;
  const nextCall =
    kept.length > 0
      ? buildRetrievalCall(
          path,
          retrievalWindow(droppedStart, Math.min(droppedStart + kept.length - 1, droppedEnd)),
          stateId,
        )
      : buildRetrievalCall(`${path}[${droppedStart}]`, undefined, stateId);
  return assemble(kept, `  ${elide("rows", droppedEnd - droppedStart + 1, nextCall)}`);
}

/**
 * Tier 2 — "drill into exactly one thing": row windows for a table, nesting to `depth` for a
 * structure/object. Never elides a value silently — every cut goes through `elide()` with a
 * count and a retrieval call. A windowed table is budgeted row-by-row via
 * `renderTableWithinBudget`, so a tight budget costs rows, never the whole table.
 */
export function renderDrill(node: VariableNode, path: string, opts?: DrillOptions): { text: string } {
  const maxDepth = opts?.depth ?? 3;
  const maxChars = opts?.maxChars ?? DEBUG_MAX_CHARS;
  const stateId = opts?.stateId;

  if (node.variable.metaType === "table" && opts?.rows && node.children) {
    return { text: renderTableWithinBudget(node.variable, node.children, opts.rows, path, maxChars, stateId) };
  }

  const lines = renderNode(node, 0, maxDepth, path, stateId);
  let text = lines.join("\n");
  if (text.length > maxChars) {
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > maxChars) break;
      kept.push(line);
      used += line.length + 1;
    }
    // The node's own name/value line is never dropped: a response that has
    // shed even the thing it was asked about is unusable, budget or not.
    if (kept.length === 0 && lines.length > 0) kept.push(lines[0]!);
    const remaining = lines.length - kept.length;
    text =
      remaining > 0
        ? [...kept, elide("lines", remaining, buildRetrievalCall(path, undefined, stateId))].join("\n")
        : kept.join("\n");
  }
  return { text };
}

// ---------------------------------------------------------------------------
// The two silent-empty traps (Trap A/B and Trap C, handled by renderEmptyBodyTrap below).
// ---------------------------------------------------------------------------

export interface EmptyBodyContext {
  path: string;
  tableLines?: number;
}

/**
 * Render the response for a 200-OK/0-byte reply — trap A/B (bare table's children instead of a
 * row; out-of-range row index) and trap C (`@ROOT` is a scope index with zero variables).
 * Indistinguishable from the response alone, so this always leads with: NEVER "no data".
 */
export function renderEmptyBodyTrap(ctx: EmptyBodyContext): string {
  const lines = [
    `No data returned for "${ctx.path}" (0 bytes). This does NOT mean "no data" — check your indices.`,
  ];
  if (ctx.tableLines !== undefined) {
    lines.push(`TABLE_LINES=${ctx.tableLines}. A requested row index must be in [1, ${ctx.tableLines}].`);
  }
  lines.push(
    `Common causes: (a) asking for the bare table's children instead of a row — use "${ctx.path}[1]", not "${ctx.path}"; (b) an out-of-range row index; (c) expanding a scope pseudo-segment (@ROOT/@GLOBALS/@LOCALS/@PARAMETERS) whose own row set is empty — its children are the scope index, not the payload.`,
  );
  // Field-symbol root: SAP can't distinguish "name doesn't exist" from "name exists but
  // empty" — both are the same 200-OK/0-byte reply (proof: fixture 038-vars-unknown-name is
  // byte-identical to out-of-range-row captures). Also covers an UNASSIGNED field symbol,
  // which SAP reports the same way rather than as a distinct error.
  if (/^<[A-Za-z_][A-Za-z0-9_]*>/.test(ctx.path)) {
    lines.push(
      `"${ctx.path}" is a field-symbol reference. A fourth cause applies here: (d) the field ` +
        `symbol is UNASSIGNED at this stop (no ASSIGN/LOOP...ASSIGNING has run yet, or it ran ` +
        `and later fell out of scope) — SAP reports that the same way as "name not found", with ` +
        `no way to tell the two apart from this response alone. Confirm the exact spelling and ` +
        `whether it is currently assigned via abap_debug_vars' REACHABLE block for this stop ` +
        `before assuming the path is wrong.`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Never scan silently.
// ---------------------------------------------------------------------------

export interface ScanReport {
  path: string;
  totalRows: number;
  examined: number;
  matched: number;
  cap?: number;
  /** The debug state the continuation call should quote. Omitted → the call carries `STATE_ID_PLACEHOLDER`. */
  stateId?: string;
}

/**
 * Report for a `where=`-style scan that hit the hard cap before the table end. Always names
 * the unexamined remainder explicitly — not "no more matches" — with a continuation call and
 * advice to use a breakpoint instead of scanning further.
 */
export function renderScanReport(report: ScanReport): string {
  const cap = report.cap ?? SCAN_ROW_CAP;
  const unexamined = report.totalRows - report.examined;
  const nextOffset = report.examined + 1;
  const lines = [
    `Scanned ${report.examined} of ${report.totalRows} rows of "${report.path}" (hard cap ${cap} rows per call), found ${report.matched} match(es).`,
  ];
  if (unexamined > 0) {
    lines.push(
      `${unexamined} rows NOT examined. This is not "no more matches" — the scan stopped at the cap, not at the end of the table.`,
    );
    lines.push(
      `Continue with: ${buildRetrievalCall(
        report.path,
        retrievalWindow(nextOffset, report.totalRows, report.totalRows),
        report.stateId,
      )}`,
    );
    lines.push(
      `Prefer a conditional breakpoint or an exception breakpoint over scanning further — it is cheaper and does not risk missing the row that matters between polls.`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Call stack — the STACK section of every stop/step/stack/frame response.
// ---------------------------------------------------------------------------

export function formatStackFrame(f: DebugStack["frames"][number]): string {
  const includePart =
    f.includeName && f.includeName !== f.programName ? ` (${f.includeName})` : "";
  return `#${f.stackPosition} ${f.programName}${includePart}:${f.line} [${f.eventType} ${f.eventName}]`;
}

export function renderStackSection(stack: DebugStack, stateId: StateId): string {
  const visible = stack.frames.filter((f) => !f.systemProgram);
  const capped = visible.slice(0, MAX_VISIBLE_FRAMES);
  const lines = capped.map(formatStackFrame);
  const rest = visible.length - capped.length;
  if (rest > 0) {
    lines.push(elide("frames", rest, `abap_debug({action:"stack", stateId:"${stateId}"})`));
  }
  return lines.join("\n");
}
