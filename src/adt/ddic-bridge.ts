/**
 * classic-DDIC / SE93 classrun bridge.
 *
 * ADT REST is GET-only for classic views (`VIEW/DV`) and transactions
 * (`TRAN/T`) — every mutating verb 405s (`ExceptionMethodNotSupported`); see
 * `./capabilities.ts`. SE11/SE93 write these objects through ordinary
 * function modules, so — like `./enhancement-bridge.ts` for BAdIs — this
 * module reaches them via a generated `IF_OO_ADT_CLASSRUN` class:
 *
 *   1. build ABAP from a closed set of fragment generators (never by
 *      concatenating caller input — see `./enhancement-templates.ts`)
 *   2. `deployBridge` — write + activate the class in `$TMP`
 *   3. `executeBridge` — gated `execute`, POST to `/sap/bc/adt/oo/classrun/…`
 *   4. parse the tagged `out->write(...)` transcript; a 200 with no tag is
 *      treated as failure
 *
 * Two independent gates: one for creating the bridge class itself
 * (`deployBridge`/`executeBridge`, scoped to `$TMP`), and one —
 * {@link assertBridgeMutation} — for the object the generated ABAP will
 * create, which no HTTP request here ever names. The domain gate runs first
 * and is zero-network. Full original rationale, including why the
 * transcript must be tagged (function modules report failure via
 * `sy-subrc`, not exceptions), is archived in
 * the git history.
 *
 * A third operation rides this bridge: `DEVC/K` (package)
 * create via `CL_PACKAGE_FACTORY` (see `./package-create.ts`). Unlike
 * `VIEW/DV`/`TRAN/T` (which 405), the blocker here is the CTS
 * transport-check pre-flight — full mechanism in that file's header.
 *
 * `IF_PACKAGE`'s methods (`./package-create.ts`, `./package-delete.ts`) raise
 * CLASSIC (non-`cx_root`) exceptions, same as `DDIF_VIEW_PUT` above — a
 * locked package short-dumped live through an unguarded
 * `lo_package->set_changeable( abap_true )` and destroyed the whole
 * transcript. `subrcGuardFragment` below is the
 * tagless counterpart to `subrcCheckFragment` used to close every such call.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { Operation, SafetyCorr, SafetyGate } from "../safety.js";
import { ECHO_LINE_MAX, truncateForDisplay } from "../truncate.js";
import {
  assertPlainName,
  BRIDGE_PACKAGE,
  deployBridge,
  executeBridge,
  verifyBridgeActivation,
  type RunResult,
} from "./run.js";

/** Package the generated bridge class lives in — named separately from `BRIDGE_PACKAGE` so this file doesn't require cross-referencing run.ts, and so the two can diverge later. */
export const DDIC_BRIDGE_PACKAGE = BRIDGE_PACKAGE;

/** Fixed per-operation class name, never generated or caller-influenced (`deployBridge` rewrites in place, keyed by content hash). Exported so tests can route fake-server calls against the real names. */
export const DDIC_BRIDGE_CLASS = {
  createView: "ZCL_ZMCP_DDIC_CVIEW",
  createTransaction: "ZCL_ZMCP_DDIC_CTRAN",
  createPackage: "ZCL_ZMCP_DDIC_CPKG",
  deletePackage: "ZCL_ZMCP_DDIC_DPKG",
  deleteView: "ZCL_ZMCP_DDIC_DVIEW",
  deleteTransaction: "ZCL_ZMCP_DDIC_DTRAN",
  removeTransportEntry: "ZCL_ZMCP_DDIC_TREN",
  createIndex: "ZCL_ZMCP_DDIC_CINDX",
  deleteIndex: "ZCL_ZMCP_DDIC_DINDX",
} as const;

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

/**
 * Wrap `dataLines`/`bodyLines` in a minimal `IF_OO_ADT_CLASSRUN` class.
 *
 * `dataLines` are bare declarations (`ls_dd25v TYPE dd25v.`) with no leading
 * `DATA` keyword; this is the one place that prepends it — a real activation
 * failed when that assumption was wrong (see archive).
 *
 * Exported so each operation's test can run a generator/parser drift check
 * against the real emitted source.
 */
export function ddicBridgeSource(
  className: string,
  dataLines: readonly string[],
  bodyLines: readonly string[],
): string {
  const cls = assertPlainName(className, "Class name").toLowerCase();
  const data = dataLines.map((l) => `    DATA ${l}`).join("\n");
  const body = bodyLines.map((l) => `    ${l}`).join("\n");
  const source = `CLASS ${cls} DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.


CLASS ${cls} IMPLEMENTATION.

  METHOD if_oo_adt_classrun~main.
*   Generated by abapsmith. Do not edit: this class is regenerated from
*   src/adt/ddic-bridge.ts whenever its content hash changes.
${data}
    TRY.
${body}
      CATCH cx_root INTO DATA(lx_err).
        out->write( |${DDIC_ERR_PREFIX} { lx_err->get_text( ) }| ).
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
`;
  // Caught here, not at the server: a line over this fails the class-source PUT itself
  // (SEDI_ADT15/TooLongLine, live 2026-09-05) before DD_INDEX_INTERFACE or any other FM runs.
  source.split("\n").forEach((line, i) => {
    if (line.length > ABAP_SOURCE_LINE_MAX) {
      const excerpt = truncateForDisplay(line, ECHO_LINE_MAX);
      throw new AbapError(
        "CHECK_FAILED",
        `Generated bridge source line ${i + 1} is ${line.length} chars, over ABAP's ` +
          `${ABAP_SOURCE_LINE_MAX}-char class-source limit: ${excerpt}`,
        { line: i + 1, length: line.length, excerpt },
      );
    }
  });
  return source;
}

/**
 * The `IF sy-subrc <> 0. ... RETURN. ENDIF.` block on its own, with NO
 * trailing success-tag write — for an intermediate step that has no tag of
 * its own (e.g. a single `CALL METHOD ... EXCEPTIONS OTHERS = 1.` inside a
 * multi-step fragment such as `packageDeleteFragment`/`packageFragment`).
 * {@link subrcCheckFragment} is exactly this block plus one more line, and
 * delegates here so the two can't drift apart.
 *
 * Why `EXCEPTIONS OTHERS = 1` (not a named exception) is what callers pair
 * this with: naming an exception not present in a method's real signature is
 * a HARD SYNTAX ERROR (caught at bridge activation, before any mutation
 * runs) and this codebase cannot verify method signatures without touching
 * the live system — see `./package-delete.ts` / `./package-create.ts`
 * headers for the incident this exists to close.
 *
 * `sy-msgid`/`sy-msgno` are included as best-effort evidence, not asserted
 * as authoritative: a plain `RAISE <exception>.` (as opposed to `MESSAGE ...
 * RAISING ...`) never sets them, so they may print blank here even though a
 * real classic exception fired. Callers must not read their presence/absence
 * as proof of anything.
 *
 * `what` is code-controlled text (an operation name from this codebase), never caller input.
 */
export function subrcGuardFragment(what: string): string[] {
  if (!/^[A-Za-z0-9_ ]+$/.test(what)) {
    throw new AbapError("CHECK_FAILED", `Bridge step name ${JSON.stringify(what)} is not plain text.`, { what });
  }
  return [
    `IF sy-subrc <> 0.`,
    `  out->write( |${DDIC_ERR_PREFIX} ${what} failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).`,
    `  RETURN.`,
    `ENDIF.`,
  ];
}

/**
 * Reusable `sy-subrc` check fragment. `DDIF_VIEW_PUT` / `RPY_TRANSACTION_INSERT`
 * report failure via classic `EXCEPTIONS` (`sy-subrc`), invisible to
 * `CATCH cx_root` — every fragment routes its outcome through this rather
 * than writing its success tag unconditionally.
 *
 * `what` is code-controlled text (an operation name from this codebase), never caller input.
 * Byte-identical to {@link subrcGuardFragment}'s block plus one trailing
 * `out->write(successTag)` line — kept as a thin wrapper (not a hand-copy)
 * precisely so the two cannot drift apart; existing callers see no change.
 */
export function subrcCheckFragment(what: string, successTag: DdicTag): string[] {
  if (!(DDIC_TAGS as readonly string[]).includes(successTag)) {
    throw new AbapError("CHECK_FAILED", `${successTag} is not a declared DDIC bridge tag.`, { successTag });
  }
  return [...subrcGuardFragment(what), `out->write( '${successTag}' ).`];
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

/** The domain object a bridge is about to create — the SECOND gate's subject (module header). */
export interface BridgeMutationTarget {
  /** ADT type code of the object the generated ABAP will create — `VIEW/DV`, `TRAN/T`, `DEVC/K`. */
  type: string;
  name: string;
  packageName: string;
  /**
   * `DEVC/K` create only: the parent package. `src/safety.ts` judges the
   * allowlist by SUPERPACKAGE, not by the not-yet-existing name — must
   * match what `authorizeMutation` already judged for this mutation.
   */
  superPackage?: string;
  /**
   * `DEVC/K` create only: whether the object already exists. See
   * `superPackage` — `src/safety.ts` only treats a `DEVC/K` write as a
   * create when `exists !== true`.
   */
  exists?: boolean;
}

/**
 * Gate the mutation the GENERATED CLASS will perform, before generating it.
 * `deployBridge`'s own gate only covers `ZCL_ZMCP_DDIC_*` in `$TMP` — this
 * covers the object the caller actually asked for, which is never named in
 * an HTTP request the bridge makes.
 *
 * Zero-network: the object doesn't exist yet and no ADT endpoint answers for
 * these types anyway. The package is judged exactly as the caller stated it
 * (never widened).
 *
 * `activate` is asserted separately from `write` since a view's
 * `DDIF_VIEW_ACTIVATE` is a distinct gate operation (`safety.ts`'s
 * `Operation`); callers that don't activate anything pass `activate: false`.
 *
 * `corr`, when supplied, is the transport this mutation will ACTUALLY use —
 * threaded straight to BOTH `gate.assert` calls' `EvaluateOptions.corr` (the
 * `write`/`op` assert above and the `activate` assert below) so `safety.ts`
 * judges (and, on refusal, names) the real request instead of synthesising
 * a literal `"auto"` transport nobody named. Previously,
 * only the first assert got `corr` — the activate assert always fabricated
 * `"auto"`, so `ABAP_ALLOW_TRANSPORTS=<the pinned request>` satisfied the
 * first gate and was refused by the second. Both `VIEW/DV` and `TRAN/T`
 * creates now pass `corr` for a transportable package; callers that have no
 * transport to name — a `$`-package create (its `RS_CORR_INSERT` runs with
 * `korrnum = space`) and the delete paths — omit it, unchanged; both asserts
 * then fall back to the gate's own default.
 */
export function assertBridgeMutation(
  gate: SafetyGate,
  target: BridgeMutationTarget,
  opts: { activate: boolean; op?: Operation; corr?: SafetyCorr },
): void {
  // A DEVC/K delete must be gated and audited as a delete, not a write.
  gate.assert(
    opts.op ?? "write",
    {
      type: target.type,
      name: target.name,
      packageName: target.packageName,
      // superPackage/exists must reach the gate so it judges the same
      // mutation `authorizeMutation` already did (see `BridgeMutationTarget`).
      // Spread conditionally to avoid adding `undefined` keys for existing
      // VIEW/DV/TRAN/T callers.
      ...(target.superPackage !== undefined ? { superPackage: target.superPackage } : {}),
      ...(target.exists !== undefined ? { exists: target.exists } : {}),
    },
    opts.corr !== undefined ? { corr: opts.corr } : {},
  );
  if (opts.activate) {
    gate.assert("activate", target, opts.corr !== undefined ? { corr: opts.corr } : {});
  }
}

/** What varies between this module's operations; nothing else does. */
export interface RunDdicBridgeOptions {
  className: string;
  source: string;
  description: string;
  /** Human wording for the transcript assertion and the activation failure. */
  what: string;
  expectTags: readonly DdicTag[];
  /**
   * A non-empty package delete is a legitimate refusal carrying its own
   * tagged evidence — without this hook the generic tag assertion
   * below would only ever report "missing expected tag", losing it.
   */
  beforeAssert?: (transcript: DdicTranscript) => void;
  /** Threaded straight to {@link assertDdicTranscript}'s `opts` — see there. */
  completed?: Readonly<Partial<Record<DdicTag, string>>>;
  /** Threaded straight to {@link assertDdicTranscript}'s `opts` — see there. */
  partialHint?: string;
}

/** Deploy + execute + parse + assert — the second half of every operation in this bridge, shared rather than transcribed per operation. */
export async function runDdicBridge(
  conn: AbapConnection,
  gate: SafetyGate,
  opts: RunDdicBridgeOptions,
): Promise<{ run: RunResult; transcript: DdicTranscript }> {
  const deployed = await deployBridge(conn, gate, {
    className: opts.className,
    source: opts.source,
    description: opts.description,
    packageName: DDIC_BRIDGE_PACKAGE,
    what: `Activation of the generated DDIC bridge ${opts.className}`,
    verify: (activation) => verifyBridgeActivation(activation, opts.className, "DDIC bridge"),
  });
  const run = await executeBridge(conn, gate, deployed);
  const transcript = parseDdicTranscript(run.output);
  if (opts.beforeAssert) opts.beforeAssert(transcript);
  assertDdicTranscript(transcript, opts.expectTags, opts.what, {
    completed: opts.completed,
    partialHint: opts.partialHint,
  });
  return { run, transcript };
}
