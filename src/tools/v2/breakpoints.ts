/**
 * Parser for v2's `abap_debug` `breakpoints: string[]` — a compact string
 * encoding of v1's structured breakpoint objects (see `src/tools/debug.ts`),
 * chosen per v2 Rule 1 (no closed enums / minimal shape surface in
 * `v2/schemas.ts`). This is the only place the string is decoded; its output
 * is exactly v1's element type.
 *
 * Grammar, per entry:
 *
 *     target(#skipCount)?(?condition)?
 *
 *     target     = "exception:CLASSNAME" | "OBJECT:LINE" (split on the LAST
 *                  ':' — OBJECT may itself contain colons)
 *     #skipCount = optional non-negative integer, must precede "?condition"
 *     ?condition = everything after the first '?', verbatim to end of
 *                  string, never re-split (see the NOTES case below)
 *
 * `skipCount: 0` ("break on every hit") is a meaningful wire value — presence
 * checks use `!== undefined`, never truthiness.
 *
 * Parsing is all-or-nothing: the first malformed entry throws `BAD_INPUT`
 * (naming its index/text) before anything is returned — never arms a
 * partial breakpoint set.
 *
 * A condition ending in something shaped like "#digits" is not an error —
 * unambiguous by grammar — but is flagged via `notes` in case the caller
 * misplaced a skipCount.
 */
import { AbapError } from "../../adt/errors.js";
import type { DebugInput } from "../debug.js";

/** Exactly v1's existing breakpoint element type — never a new shape. */
export type ParsedBreakpoint = NonNullable<DebugInput["breakpoints"]>[number];

export interface ParsedBreakpoints {
  readonly breakpoints: ParsedBreakpoint[];
  /** Non-fatal disclosures, e.g. a misplaced "#skipCount" folded into a condition. */
  readonly notes: string[];
}

const TRAILING_SKIPCOUNT_LOOKALIKE = /#\d+$/;
const SKIPCOUNT_SUFFIX = /#(\d+)$/;
const MAX_SKIPCOUNT = 1_000_000;
const MAX_CONDITION_LENGTH = 255;
const MAX_LINE = 999_999;

function badEntry(index: number, raw: string, reason: string): never {
  throw new AbapError(
    "BAD_INPUT",
    `Malformed breakpoint at breakpoints[${index}] ("${raw}"): ${reason}`,
    { index, raw, reason },
    'Grammar: target(#skipCount)?(?condition)?, target = "exception:CLASSNAME" or "OBJECT:LINE".',
  );
}

export function parseBreakpoints(specs: readonly string[]): ParsedBreakpoints {
  const breakpoints: ParsedBreakpoint[] = [];
  const notes: string[] = [];

  for (let index = 0; index < specs.length; index++) {
    const raw = specs[index]!;
    if (raw.trim().length === 0) {
      badEntry(index, raw, "empty entry.");
    }

    // Condition: split at the first '?', verbatim thereafter.
    const qIdx = raw.indexOf("?");
    const prefix = qIdx === -1 ? raw : raw.slice(0, qIdx);
    let condition: string | undefined;
    if (qIdx !== -1) {
      const rawCondition = raw.slice(qIdx + 1).trim();
      if (rawCondition.length === 0) {
        badEntry(index, raw, "empty condition after '?'.");
      }
      if (rawCondition.length > MAX_CONDITION_LENGTH) {
        badEntry(index, raw, `condition exceeds ${MAX_CONDITION_LENGTH} characters.`);
      }
      condition = rawCondition;
      if (TRAILING_SKIPCOUNT_LOOKALIKE.test(rawCondition)) {
        notes.push(
          `breakpoints[${index}]: condition "${rawCondition}" ends with what looks like a ` +
            "misplaced #skipCount — skipCount must appear BEFORE '?condition', not after. " +
            "The entire text after '?' was treated as the condition, verbatim.",
        );
      }
    }

    // Optional "#skipCount" suffix on the prefix.
    let targetText = prefix;
    let skipCount: number | undefined;
    const skipMatch = SKIPCOUNT_SUFFIX.exec(prefix);
    if (skipMatch) {
      const hashIdx = skipMatch.index;
      targetText = prefix.slice(0, hashIdx);
      skipCount = Number(skipMatch[1]);
      if (!Number.isSafeInteger(skipCount) || skipCount < 0 || skipCount > MAX_SKIPCOUNT) {
        badEntry(index, raw, `skipCount out of range (0..${MAX_SKIPCOUNT}).`);
      }
    }

    if (targetText.trim().length === 0) {
      badEntry(index, raw, "missing target before the skipCount/condition suffix.");
    }

    // target: "exception:CLASSNAME" or "OBJECT:LINE" (split on the LAST ':').
    if (/^exception:/i.test(targetText)) {
      const exceptionClass = targetText.slice("exception:".length).trim();
      if (exceptionClass.length === 0) {
        badEntry(index, raw, "empty exception class after 'exception:'.");
      }
      breakpoints.push({
        kind: "exception",
        exceptionClass,
        ...(condition !== undefined ? { condition } : {}),
        ...(skipCount !== undefined ? { skipCount } : {}),
      });
      continue;
    }

    const lastColonIdx = targetText.lastIndexOf(":");
    if (lastColonIdx === -1) {
      badEntry(index, raw, 'expected "OBJECT:LINE" or "exception:CLASSNAME".');
    }
    const object = targetText.slice(0, lastColonIdx).trim();
    const lineText = targetText.slice(lastColonIdx + 1).trim();
    if (object.length === 0) {
      badEntry(index, raw, "empty object before the last ':'.");
    }
    if (!/^\d+$/.test(lineText)) {
      badEntry(index, raw, `expected an integer line number after the last ':', got "${lineText}".`);
    }
    const line = Number(lineText);
    if (line < 1 || line > MAX_LINE) {
      badEntry(index, raw, `line out of range (1..${MAX_LINE}).`);
    }

    breakpoints.push({
      kind: "line",
      object,
      line,
      ...(condition !== undefined ? { condition } : {}),
      ...(skipCount !== undefined ? { skipCount } : {}),
    });
  }

  return { breakpoints, notes };
}
