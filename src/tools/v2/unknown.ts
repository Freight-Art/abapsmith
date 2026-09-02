/**
 * Shared helpers for `abap_find`/`abap_read`: an "unrecognised value" responder
 * for their free-form `kind`/`where`/`view` fields, and an adapter that lifts a
 * rendered v1 `CallToolResult` into a `V2Response`.
 *
 * Own file rather than `envelope.ts`/`runtime.ts` (kept frozen) or
 * `catalogue.ts` (owned by `abap_do`'s dispatch); only `find.ts`/`read.ts`
 * import this. See the git history for the fuller
 * original rationale.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { nearest, type NextCall, type V2Err, type V2Response } from "./envelope.js";

/**
 * `kind`/`where`/`view` are free-form strings by design (no closed enums;
 * legal values live in prose, not the zod shape). Shared "value not
 * recognised" response, same shape as `unknownAction` (`envelope.ts`) but
 * keyed off a plain field name since neither field has a catalogue module.
 */
export function unknownValue(
  tool: string,
  field: string,
  given: string,
  legalValues: readonly string[],
): V2Err {
  const closest = nearest(given, legalValues, 3);
  const closestPart = closest.length > 0 ? ` Closest match(es): ${closest.join(", ")}.` : "";
  return {
    ok: false,
    tool,
    error: "UNKNOWN_" + field.toUpperCase(),
    message: `"${given}" is not a recognised ${field} for ${tool}.${closestPart} Legal values: ${legalValues.join(", ")}.`,
    hint: `Call ${tool}({}) with no args for a bare-call description of every legal ${field}.`,
    retryable: true, // a legal value would work
    given,
    closest,
    catalogue: `${tool}({}) — bare call — lists every legal ${field} in its description.`,
    next: [
      {
        tool,
        args: {},
        why: `List ${tool}'s bare-call description, including every legal ${field}.`,
      },
    ],
  };
}

/**
 * Extracts the first text block from a rendered v1 `CallToolResult` (e.g.
 * `runBopfRead`, `runFpmReadTool`) and folds it into a `V2Response`. Checks
 * `isError` defensively — neither caller sets it today (both throw instead)
 * — so a future v1 change that does set it fails loud instead of reporting
 * success.
 */
export function liftV1Result(tool: string, res: CallToolResult, next: readonly NextCall[]): V2Response {
  const first = res.content.find((c): c is { type: "text"; text: string } => c.type === "text");
  const text = first?.text ?? "";
  if (res.isError) {
    return {
      ok: false,
      tool,
      error: "ADT_ERROR",
      message: text || "The underlying v1 tool reported a failure with no text content.",
      retryable: undefined, // lifted from a v1 tool; cause unknown, no claim
      next,
    };
  }
  return { ok: true, tool, data: text, next };
}
