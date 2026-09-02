/**
 * Selection-screen value marshalling for `abap_run` report mode.
 *
 * `SUBMIT <report> WITH SELECTION-TABLE <itab> AND RETURN` (itab `TYPE
 * STANDARD TABLE OF rsparams`) is what lets `abap_run` populate a classic
 * report's PARAMETERS/SELECT-OPTIONS instead of only ever running it with
 * defaults. This module turns a caller's typed, structured input into
 * validated `rsparams` rows; `run.ts` embeds them as ABAP literals in the
 * generated bridge.
 *
 * Design notes:
 *  - Value conversion is explicit via {@link RunParamType}/
 *    {@link formatSelectionValue}, never inferred from the string (e.g. a
 *    date vs. a char value that happens to look like one).
 *  - A PARAMETERS field is the degenerate range row
 *    `{sign:"I", option:"EQ", low:value}`, produced by
 *    {@link marshalSelectionTable} from the `value` shorthand.
 *  - Every check is client-side and throws `BAD_INPUT` naming the exact
 *    parameter and reason — no malformed `rsparams` row ever reaches ABAP.
 *
 * Background and live-verification evidence:
 * the git history
 */
import { AbapError } from "./errors.js";
import { assertAbapText } from "./enhancement-templates.js";

// ---------------------------------------------------------------------------
// RSPARAMS ground truth (live-verified, not guessed)
// ---------------------------------------------------------------------------
//
// Field lengths confirmed via RTTI against a real `rsparams` local
// (2026-08-12) rather than assumed — see archive; a wrong length here would
// silently truncate or misalign what SUBMIT receives.
export const RSPARAMS_SELNAME_MAX = 8;
export const RSPARAMS_KIND_MAX = 1;
export const RSPARAMS_SIGN_MAX = 1;
export const RSPARAMS_OPTION_MAX = 2;
export const RSPARAMS_LOW_MAX = 45;
export const RSPARAMS_HIGH_MAX = 45;

// ---------------------------------------------------------------------------
// Public input shapes
// ---------------------------------------------------------------------------

/**
 * How to convert a value's TEXT into the internal representation `SUBMIT …
 * WITH SELECTION-TABLE` expects in `rsparams-low`/`-high`. Explicit rather
 * than inferred: `"20260812"` is valid as both `char` and `date` with
 * different meanings, and guessing could silently pick the wrong one.
 */
export type RunParamType = "char" | "int" | "packed" | "date";

/** The ten standard ABAP select-option comparison operators. */
export type RunRangeOption = "EQ" | "NE" | "GT" | "LT" | "GE" | "LE" | "CP" | "NP" | "BT" | "NB";

const RANGE_OPTIONS: ReadonlySet<string> = new Set<RunRangeOption>([
  "EQ",
  "NE",
  "GT",
  "LT",
  "GE",
  "LE",
  "CP",
  "NP",
  "BT",
  "NB",
]);

/** Operators that take a `high` bound. Every other operator must NOT carry one. */
const RANGE_NEEDS_HIGH: ReadonlySet<string> = new Set<RunRangeOption>(["BT", "NB"]);

export interface RunParameterRange {
  /** `I` (include, the common case) or `E` (exclude). Defaults to `I`. */
  sign?: "I" | "E";
  /** One of the ten standard operators. Defaults to `EQ`. */
  option?: RunRangeOption;
  low: string;
  /** Required for `BT`/`NB`, refused for every other operator. */
  high?: string;
}

/**
 * One selection-screen field's worth of input. Exactly one of `value` /
 * `ranges` must be given — `value` is PARAMETERS shorthand for the single row
 * `{sign:"I", option:"EQ", low:value}`; `ranges` is the general SELECT-OPTIONS
 * form (also usable for a PARAMETERS field: a single-row `ranges` with
 * `option:"EQ"` is equivalent to `value`).
 */
export interface RunParameterInput {
  /** Selection-screen field name (`PARAMETERS`/`SELECT-OPTIONS` identifier). Case-insensitive, max 8 chars. */
  name: string;
  /** Conversion to apply to every `low`/`high` in this field. Defaults to `"char"`. */
  type?: RunParamType;
  value?: string;
  ranges?: RunParameterRange[];
}

// ---------------------------------------------------------------------------
// Marshalled output — what run.ts embeds into the bridge
// ---------------------------------------------------------------------------

export interface MarshalledSelectionRow {
  /** Uppercase, ≤8 chars, already validated as a plain ABAP identifier. */
  selname: string;
  /** `P` for a PARAMETERS-shorthand row, `S` for an explicit range row. */
  kind: "P" | "S";
  sign: "I" | "E";
  option: RunRangeOption;
  /** Already converted, already ≤45 chars, already control-char-free. */
  low: string;
  /** `""` when the operator takes no high bound. */
  high: string;
}

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

/**
 * Dynpro field name limit (letter, then letters/digits/underscore, ≤8 chars)
 * is ABAP-compiler-enforced, not a convention — refused here rather than
 * truncated, since a truncated name would address a different field, or none.
 */
const SELNAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,7}$/;

function assertSelname(name: string, what: string): string {
  if (typeof name !== "string" || !SELNAME_RE.test(name)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} ${JSON.stringify(name)} is not a valid selection-screen field name — a letter, ` +
        `then letters/digits/underscore, at most ${RSPARAMS_SELNAME_MAX} characters (the ` +
        "ABAP compiler's own PARAMETERS/SELECT-OPTIONS identifier limit).",
      { what, value: name, maxLength: RSPARAMS_SELNAME_MAX },
      "Check the report's own PARAMETERS/SELECT-OPTIONS statement for the exact name.",
    );
  }
  return name.toUpperCase();
}

// ---------------------------------------------------------------------------
// Typed value conversion
// ---------------------------------------------------------------------------

const INT_RE = /^-?\d{1,9}$/;
// Dot-decimal (not comma) is the only accepted decimal separator — confirmed
// live to round-trip correctly through SUBMIT WITH SELECTION-TABLE (see
// archive). Comma is refused rather than reinterpreted since the caller's
// intended locale isn't knowable here.
const PACKED_RE = /^-?\d+(\.\d+)?$/;

/**
 * Convert `raw` per `type` into the exact text `rsparams-low`/`-high` must
 * carry, or throw `BAD_INPUT` naming `what` and the reason. Never a short
 * dump: every rejection happens here, client-side, before any ABAP runs.
 */
export function formatSelectionValue(raw: string, type: RunParamType, what: string): string {
  if (typeof raw !== "string") {
    throw new AbapError("BAD_INPUT", `${what} must be a string.`, { what, type });
  }
  switch (type) {
    case "char":
      return assertAbapText(raw, what, RSPARAMS_LOW_MAX);

    case "int": {
      if (!INT_RE.test(raw)) {
        throw new AbapError(
          "BAD_INPUT",
          `${what} is ${JSON.stringify(raw)}, not a plain integer (optional leading "-", digits only).`,
          { what, type, value: raw },
        );
      }
      return raw;
    }

    case "packed": {
      if (!PACKED_RE.test(raw)) {
        throw new AbapError(
          "BAD_INPUT",
          `${what} is ${JSON.stringify(raw)}, not a plain decimal number — use digits with an ` +
            'optional leading "-" and an optional "." decimal point (not ",").',
          { what, type, value: raw },
        );
      }
      return raw;
    }

    case "date": {
      // Accepts ISO `YYYY-MM-DD`, converts to the internal `YYYYMMDD` text
      // rsparams-low/high requires. A `TYPE D` field has no conversion exit,
      // so any separator-bearing value (external or ISO form) dumps at
      // runtime — see archive for the live incident this fixed.
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
      if (!m) {
        throw new AbapError(
          "BAD_INPUT",
          `${what} is ${JSON.stringify(raw)}, not a date in "YYYY-MM-DD" form.`,
          { what, type, value: raw },
        );
      }
      const [, year, month, day] = m;
      const monthNum = Number(month);
      const dayNum = Number(day);
      if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) {
        throw new AbapError(
          "BAD_INPUT",
          `${what} is ${JSON.stringify(raw)} — month must be 01-12 and day 01-31.`,
          { what, type, value: raw },
        );
      }
      return `${year}${month}${day}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Range-row validation
// ---------------------------------------------------------------------------

function assertOption(option: string | undefined, what: string): RunRangeOption {
  const opt = (option ?? "EQ").toUpperCase();
  if (!RANGE_OPTIONS.has(opt)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what}.option is ${JSON.stringify(option)}, not one of the ten standard ABAP select-option ` +
        "operators (EQ, NE, GT, LT, GE, LE, CP, NP, BT, NB).",
      { what, value: option },
    );
  }
  return opt as RunRangeOption;
}

function assertSign(sign: string | undefined, what: string): "I" | "E" {
  const s = (sign ?? "I").toUpperCase();
  if (s !== "I" && s !== "E") {
    throw new AbapError(
      "BAD_INPUT",
      `${what}.sign is ${JSON.stringify(sign)}, not "I" (include) or "E" (exclude).`,
      { what, value: sign },
    );
  }
  return s;
}

function marshalRange(
  range: RunParameterRange,
  type: RunParamType,
  kind: "P" | "S",
  selname: string,
  what: string,
): MarshalledSelectionRow {
  const sign = assertSign(range.sign, what);
  const option = assertOption(range.option, what);
  const needsHigh = RANGE_NEEDS_HIGH.has(option);

  if (typeof range.low !== "string") {
    throw new AbapError("BAD_INPUT", `${what}.low is required and must be a string.`, { what });
  }
  if (needsHigh && (range.high === undefined || range.high === "")) {
    throw new AbapError(
      "BAD_INPUT",
      `${what}: option "${option}" requires a "high" bound, but none was given.`,
      { what, option },
    );
  }
  if (!needsHigh && range.high !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `${what}: option "${option}" does not take a "high" bound, but one was given ` +
        `(${JSON.stringify(range.high)}). Only BT/NB use "high".`,
      { what, option, value: range.high },
    );
  }

  const low = formatSelectionValue(range.low, type, `${what}.low`);
  const high = needsHigh ? formatSelectionValue(range.high!, type, `${what}.high`) : "";

  return { selname, kind, sign, option, low, high };
}

// ---------------------------------------------------------------------------
// Top-level marshalling
// ---------------------------------------------------------------------------

/**
 * Turn the caller's `parameters` input into validated `rsparams` rows, ready
 * for {@link "./run.js".bridgeClassSource} to embed as ABAP literals.
 *
 * Pure and side-effect-free: every failure is a thrown `BAD_INPUT` naming the
 * exact field (`name`, and `.low`/`.high`/`.option`/`.sign` within it) and the
 * exact reason — never a silent coercion, never a value that reaches ABAP
 * unchecked.
 */
export function marshalSelectionTable(inputs: readonly RunParameterInput[]): MarshalledSelectionRow[] {
  const rows: MarshalledSelectionRow[] = [];
  const seen = new Set<string>();

  for (const [i, input] of inputs.entries()) {
    const label = `parameters[${i}]`;
    if (!input || typeof input !== "object") {
      throw new AbapError("BAD_INPUT", `${label} must be an object.`, { index: i });
    }
    const selname = assertSelname(input.name, `${label}.name`);
    if (seen.has(selname)) {
      throw new AbapError(
        "BAD_INPUT",
        `${label}.name "${selname}" is a duplicate — each selection-screen field may appear only ` +
          "once (a SELECT-OPTIONS field with several ranges uses ONE entry with several \"ranges\" rows).",
        { name: selname },
      );
    }
    seen.add(selname);

    const type: RunParamType = input.type ?? "char";
    const hasValue = input.value !== undefined;
    const hasRanges = input.ranges !== undefined;

    if (hasValue === hasRanges) {
      throw new AbapError(
        "BAD_INPUT",
        `${label} ("${selname}") must set exactly one of "value" (a PARAMETERS field) or "ranges" ` +
          "(a SELECT-OPTIONS field), not both and not neither.",
        { name: selname, hasValue, hasRanges },
      );
    }

    if (hasValue) {
      const low = formatSelectionValue(input.value!, type, `${label}.value ("${selname}")`);
      rows.push({ selname, kind: "P", sign: "I", option: "EQ", low, high: "" });
      continue;
    }

    const ranges = input.ranges!;
    if (!Array.isArray(ranges) || ranges.length === 0) {
      throw new AbapError(
        "BAD_INPUT",
        `${label} ("${selname}").ranges must be a non-empty array.`,
        { name: selname },
      );
    }
    for (const [j, range] of ranges.entries()) {
      rows.push(marshalRange(range, type, "S", selname, `${label}.ranges[${j}] ("${selname}")`));
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Best-effort selection-screen discovery — ADT exposes no dedicated endpoint
// for this (checked live, see archive), so this parses the report's own
// PARAMETERS/SELECT-OPTIONS statements out of its source instead.
// ---------------------------------------------------------------------------

export interface ParsedSelectionField {
  name: string;
  statement: "PARAMETERS" | "SELECT-OPTIONS";
  /** The `TYPE ...` token verbatim, when present (best-effort — not resolved against DDIC). */
  type?: string;
  obligatory: boolean;
}

/**
 * Heuristic, best-effort extraction of `PARAMETERS`/`SELECT-OPTIONS`
 * declarations from a report's source text.
 *
 * **Not an ABAP parser.** Strips comments, splits on top-level statement
 * periods, and pattern-matches the two keywords — it will miss macros,
 * `INCLUDE`-generated screens, dynamically-built parameters, and unusual
 * formatting. Callers MUST treat a name this function didn't find as
 * "unconfirmed", never as "confirmed absent" — see `run.ts`, which only
 * WARNS on a mismatch, never refuses.
 */
export function parseSelectionScreen(source: string): ParsedSelectionField[] {
  if (typeof source !== "string" || source.length === 0) return [];

  const noLineComments = source
    .split(/\r\n|\r|\n/)
    .map((line) => (/^\s*\*/.test(line) ? "" : line))
    .join("\n");
  // `"` starts a comment to end of line; ABAP string literals use `'`, so
  // this doesn't collide with a genuine string containing a quote.
  const noComments = noLineComments.replace(/"[^\n]*/g, "");

  const statements = noComments.split(/\.(?=\s|$)/);
  const fields: ParsedSelectionField[] = [];

  const KEYWORD_RE = /^\s*(PARAMETERS|SELECT-OPTIONS)\s*:?\s*(.*)$/is;

  for (const stmt of statements) {
    const m = KEYWORD_RE.exec(stmt.trim());
    if (!m) continue;
    const statement = m[1]!.toUpperCase() as "PARAMETERS" | "SELECT-OPTIONS";
    const rest = m[2]!;
    // Colon-chained declaration list split on top-level commas; this grammar
    // has no parentheses, so a plain split is safe.
    const decls = rest.split(",");
    for (const decl of decls) {
      const trimmed = decl.trim();
      if (!trimmed) continue;
      const nameMatch = /^([A-Za-z][A-Za-z0-9_]{0,7})\b/.exec(trimmed);
      if (!nameMatch) continue;
      const name = nameMatch[1]!.toUpperCase();
      const typeMatch = /\bTYPE\s+([\w/]+)/i.exec(trimmed);
      const obligatory = /\bOBLIGATORY\b/i.test(trimmed);
      fields.push({
        name,
        statement,
        ...(typeMatch ? { type: typeMatch[1] } : {}),
        obligatory,
      });
    }
  }

  return fields;
}

/**
 * Turn a best-effort {@link parseSelectionScreen} result plus the caller's
 * `parameters` input into soft, human-readable notes — never a refusal.
 *
 * Flags exactly two things: a supplied name the parse didn't find (phrased as
 * "not found", not "does not exist" — the heuristic parser can miss it), and
 * a parsed `OBLIGATORY` field nothing was supplied for (explains a likely
 * blank-value dump instead of leaving the caller to guess). If parsing found
 * nothing at all, that's surfaced once as a general caveat, since every note
 * above is only as trustworthy as the parse feeding it.
 */
export function selectionScreenNotes(
  parsed: readonly ParsedSelectionField[],
  supplied: readonly RunParameterInput[],
): string[] {
  const notes: string[] = [];
  if (parsed.length === 0) {
    if (supplied.length > 0) {
      notes.push(
        "The report's source could not be parsed for PARAMETERS/SELECT-OPTIONS declarations " +
          "(or none were found), so the supplied parameter name(s) could not be cross-checked " +
          "against it. This is not evidence they are wrong — only that they are unconfirmed.",
      );
    }
    return notes;
  }

  const parsedByName = new Map(parsed.map((f) => [f.name, f]));
  const suppliedNames = new Set(supplied.map((p) => p.name.toUpperCase()));

  for (const input of supplied) {
    const name = input.name.toUpperCase();
    if (!parsedByName.has(name)) {
      notes.push(
        `Selection-screen field "${name}" was supplied but not found by source parsing — the ` +
          "parse is heuristic (macros/INCLUDEs/unusual layouts can defeat it), so this is not " +
          "proof the field doesn't exist, only that it could not be confirmed.",
      );
    }
  }

  for (const field of parsed) {
    if (field.obligatory && !suppliedNames.has(field.name)) {
      notes.push(
        `Selection-screen field "${field.name}" is declared OBLIGATORY in the source but no ` +
          "value was supplied — the report ran with it blank/initial, which may itself cause a " +
          "selection-screen error or an unintended default.",
      );
    }
  }

  return notes;
}
