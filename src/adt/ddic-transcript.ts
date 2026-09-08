/**
 * DDIC classrun-transcript parsing/assertion — pure, no ADT calls. Split out
 * of `./ddic-bridge.ts` into its own leaf so DDIC-family modules that only
 * need to parse/assert a transcript don't have to pull in `ddic-bridge.ts`,
 * which imports `./run.js`.
 */

import { AbapError } from "./errors.js";

/** ABAP class-source line limit — a line over this 255s the PUT with SEDI_ADT15/TooLongLine (live 2026-09-05). */
export const ABAP_SOURCE_LINE_MAX = 255;

/** Prefix of the line the generated `CATCH cx_root` handler — and every explicit `sy-subrc` check — writes. */
export const DDIC_ERR_PREFIX = "ZMCP-DDIC-ERR>";

/** Informational-only prefix: `parseDdicTranscript` does not look for this, so a line with it never becomes `errorLine`. */
export const DDIC_NOTE_PREFIX = "ZMCP-DDIC-NOTE>";

/** Closed set of success markers any fragment may emit; each operation's test feeds a generator's real output through {@link parseDdicTranscript} to prove parser and generators haven't drifted apart. */
export const DDIC_TAGS = [
  "VIEW-PUT",
  "VIEW-REGISTERED",
  "VIEW-ACTIVATED",
  "TRAN-CREATED",
  "PKG-CREATED",
  "PKG-PARENT-SET",
  "PKG-CONFIRMED",
  // package-delete bridge:
  "PKG-EMPTY",
  "PKG-DELETED",
  "PKG-GONE",
  // view-delete / transaction-delete bridges:
  "VIEW-DELETED",
  "VIEW-GONE",
  "TRAN-DELETED",
  "TRAN-GONE",
  // transport-entry-remove bridge:
  "TREN-REMOVED",
  "TREN-GONE",
  // index-create / index-delete bridges (TABL/DI, DD_INDEX_INTERFACE):
  "INDEX-CREATED",
  "INDEX-ACTIVE",
  "INDEX-FIELDS",
  "INDEX-DELETED",
  "INDEX-GONE",
  // FM reported ACTFAILED on delete but the post-commit DD12V/DD17S read-back found the index gone anyway — live 2026-09-05.
  "INDEX-DELETED-ACTFAILED",
] as const;
export type DdicTag = (typeof DDIC_TAGS)[number];

export interface DdicTranscript {
  /** Tags found, in the order the ABAP wrote them. */
  tags: DdicTag[];
  /** Any `ZMCP-DDIC-ERR>`-prefixed line — from a `sy-subrc` check or the `CATCH cx_root` handler. */
  errorLine?: string;
  /** Full captured output, for a caller that wants more than the tags. */
  raw: string;
}

/** Exported so each operation's test can feed a fragment's real `out->write` output through this parser as a drift check (cf. `parseEnhancementTranscript`, `parseBopfTranscript`). */
export function parseDdicTranscript(raw: string): DdicTranscript {
  const tags: DdicTag[] = [];
  let errorLine: string | undefined;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(DDIC_ERR_PREFIX)) {
      errorLine = trimmed.slice(DDIC_ERR_PREFIX.length).trim();
      continue;
    }
    const tag = (DDIC_TAGS as readonly string[]).find((t) => trimmed === t);
    if (tag) tags.push(tag as DdicTag);
  }
  return { tags, errorLine, raw };
}

/**
 * True when a bridge error line is CTS (or any other transaction) trying to pop an
 * interactive dynpro that a headless `IF_OO_ADT_CLASSRUN` execution has no window
 * system to render — e.g. `Sending of dynpro SAPLSTRD 0352 not possible: No
 * window system type specified`. Keyed on the two substrings the server actually
 * printed, not on the dynpro name (the screen number and program vary) or on the
 * object type being created — this must fire for whatever bridge hit it, not just
 * `VIEW/DV`.
 */
export function isHeadlessDynproFailure(errorLine: string | undefined): boolean {
  if (!errorLine) return false;
  const lower = errorLine.toLowerCase();
  return lower.includes("sending of dynpro") && lower.includes("no window system type specified");
}

const HEADLESS_DYNPRO_HINT =
  "The generated bridge class hit an interactive SAP dialog screen, which a headless " +
  "IF_OO_ADT_CLASSRUN execution has no window system to display, so it aborted before " +
  "the operation completed. The usual cause is a CTS transport-request prompt raised " +
  "because no request number was supplied: pass corr_nr.";

const PARTIAL_SUCCESS_HINT =
  "Do NOT simply retry this call: what is named above already exists, so a retry will collide " +
  "with an object the caller did not know it had created. Establish the object's current state " +
  "first and either continue from there or remove it, then create it again.";

/**
 * Throws when the transcript shows an error line, or none of the tags the caller expected —
 * an empty transcript is a failure, not a success with nothing to say.
 *
 * `opts.completed` maps a tag to a prose sentence describing what already took effect on the
 * server when that tag fired — a multi-step operation (e.g. package create + super-package
 * attach) can fail on a LATER step after an EARLIER one already committed; reporting only the
 * overall failure would tell the caller nothing happened when something did. Only tags that
 * actually fired AND have a `completed` entry are ever named — a tag that fired proves its own
 * step ran, never anything about a step after it.
 */
export function assertDdicTranscript(
  result: DdicTranscript,
  expectTags: readonly DdicTag[],
  what: string,
  opts?: { readonly completed?: Readonly<Partial<Record<DdicTag, string>>>; readonly partialHint?: string },
): void {
  if (result.errorLine) {
    const dynproHint = isHeadlessDynproFailure(result.errorLine) ? HEADLESS_DYNPRO_HINT : undefined;
    const firedCompleted = result.tags.filter((t) => opts?.completed?.[t] !== undefined);
    let message = `${what} failed on the server: ${result.errorLine}`;
    const details: Record<string, unknown> = { raw: result.raw };
    let hint = dynproHint;
    if (firedCompleted.length > 0) {
      const done = firedCompleted.map((t) => opts!.completed![t]!);
      const sep = /[.!?:]\s*$/.test(message) ? " " : ". ";
      message += `${sep}PARTIAL SUCCESS, NOT A NO-OP: this is a multi-step operation and earlier steps already took effect on the server and were NOT rolled back — ${done.join("; ")}.`;
      details.partial = true;
      details.completed = firedCompleted;
      const prefix = [PARTIAL_SUCCESS_HINT, opts?.partialHint].filter((s) => s !== undefined).join(" ");
      hint = [prefix, dynproHint].filter((s) => s !== undefined).join(" ");
    }
    throw new AbapError("CHECK_FAILED", message, details, hint);
  }
  const missing = expectTags.filter((t) => !result.tags.includes(t));
  if (missing.length > 0) {
    throw new AbapError(
      "CHECK_FAILED",
      `${what} did not report success — expected marker${missing.length > 1 ? "s" : ""} ` +
        `${missing.join(", ")} in the classrun output, got: ${result.raw || "(empty)"}`,
      { raw: result.raw, missing },
    );
  }
}
