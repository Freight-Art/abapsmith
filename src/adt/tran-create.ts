/**
 * # `TRAN/T` create — SE93's own backend, over the fluid `classic` tool
 *
 * ADT has no writable collection for `TRAN/T` (405 on every mutating verb via
 * the VIT bridge — see `./capabilities.ts`). SE93 itself calls
 * `RPY_TRANSACTION_INSERT` (function group `SEUA`), so this module validates
 * and gates the request, then dispatches it as the `create_transaction`
 * action of the fluid `classic` tool (`./classic-call.ts`), which calls that
 * FM from `ZCL_ZMCP_FLUID_CLASSIC` and reads the outcome back off a tagged
 * transcript. The ABAP itself now lives in
 * `src/adt/fluid/builtin/classic/abap-tran.ts`.
 *
 * ## Scope
 *
 * {@link createTransaction} now supports every `RPY_TRANSACTION_INSERT`
 * transaction_type this bridge can reach: report (`'R'`, an EXISTING report
 * program), dialog (`'D'`, program+dynpro), parameter (`'P'`, a target
 * transaction plus screen-field assignments) and variant (`'V'`, a target
 * transaction plus a screen variant). An OO transaction "with transaction
 * model" (SE93's OS_APPLICATION form) is also reachable, as `kind: "oo"` —
 * it is stored as a parameter transaction against the fixed target
 * `OS_APPLICATION` with `CLASS`/`METHOD`/`UPDATE_MODE` TSTCP assignments.
 * The other OO form (no transaction model, TSTCP `\CLASS=...\METHOD=...`)
 * has no SAP API and is read-only. None of these check that the underlying
 * program/class/method exists (that check, where it exists at all, lives one
 * layer up, in `src/tools/write-bridge.ts`'s `abapCreateViaBridge`, before this
 * module is ever called — see `src/adt/write-verify.ts`'s module doc for
 * why).
 *
 * ## Evidence status
 *
 * The capture proves `RPY_TRANSACTION_INSERT` exists and quotes its `tstc`/
 * `tstct`/`tstcc` insert block verbatim. On 2026-09-05 four signature lines —
 * `development_class`, `transport_number`, `genflag`, `suppress_corr_insert`
 * — and the `RS_CORR_INSERT` block that forwards `transport_number` as
 * `korrnum` were read from the live source on A4H. Every other parameter
 * name, and the EXCEPTIONS list AND ITS ORDER, is still only a prose
 * paraphrase and remains an ASSUMPTION flagged at its use site. No create
 * has yet been run live with `transport_number` passed. Full detail: the
 * git history.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyCorr, SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import { assertBridgeMutation } from "./bridge-mutation.js";
import type { DdicTranscript } from "./ddic-transcript.js";
import { runClassicAction } from "./classic-call.js";
import { assertAbapText, assertEnhIdentifier } from "./enhancement-templates.js";
import { isLocalPackageName, isTrkorr } from "./transports.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** `TSTC-TCODE` is CHAR20. */
const TCODE_MAX_LENGTH = 20;

/** `TSTCT-TTEXT` is CHAR80 on the system, but this bridge enforces a 36-character limit (issue #209). Longer text is REFUSED, never truncated — see {@link TransactionParams.description}. */
const TTEXT_MAX_LENGTH = 36;

/** `PROGNAME`/`TSTC-PGMNA` is CHAR40. */
const PROGRAM_MAX_LENGTH = 40;

/** Package names may be local (`$TMP`), so `allowLocal` is on. `DEVCLASS` is CHAR30. */
const PACKAGE_MAX_LENGTH = 30;

// ---------------------------------------------------------------------------
// Validation, applied to every caller string
// ---------------------------------------------------------------------------

/**
 * A transaction code, validated before it is handed to the fluid `classic`
 * tool as the `tcode` argument.
 *
 * Its own grammar, not {@link assertEnhIdentifier}'s: a letter, then
 * letters/digits/underscores, max {@link TCODE_MAX_LENGTH}. Deliberately
 * NARROWER than SAP's own rule — no `/` or `-` — because nothing in this
 * codebase has validated that punctuation is safe once it reaches
 * `abap-tran.ts`'s `s( 'tcode' )` read and the `CALL FUNCTION` it feeds. Not
 * trimmed or upper-cased, so validation and dispatch see the same string.
 * Full argument: the git history.
 */
export function assertTransactionCode(value: string, what = "tcode"): string {
  if (typeof value !== "string" || !new RegExp(`^[A-Za-z][A-Za-z0-9_]{0,${TCODE_MAX_LENGTH - 1}}$`).test(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} ${JSON.stringify(value)} is not a valid transaction code for this bridge (a letter, then ` +
        `letters, digits and underscores only, max ${TCODE_MAX_LENGTH} characters).`,
      { what, value, maxLength: TCODE_MAX_LENGTH },
      "A quote, a period or a newline is refused outright, not escaped or stripped. SAP itself allows " +
        "'/' and '-' in customer transaction codes; this bridge does not, because no run in this " +
        "codebase has established that they are safe in that position.",
    );
  }
  return value;
}

/**
 * `corrNr`, validated as an ALREADY gate-judged TRKORR — same grammar as
 * `view-create.ts`'s and `package-create.ts`'s own copies of this check.
 * Exported so `./tran-delete.ts` shares this exact validation rather than
 * keeping a third copy.
 */
export function assertTransactionCorrNr(value: string): string {
  if (!isTrkorr(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `corr_nr ${JSON.stringify(value)} is not a transport request/task number this system would ` +
        "issue (e.g. A4HK900121). This module never acquires a request on its own — the caller " +
        "must hand it one that has already been judged by the safety gate.",
      { what: "corrNr", value },
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Target validation
// ---------------------------------------------------------------------------

/** Which `RPY_TRANSACTION_INSERT` transaction_type {@link createTransaction} builds. Defaults to `"report"`. */
export type TransactionKind = "report" | "dialog" | "parameter" | "variant" | "oo";

/** One TSTCP screen-field assignment for a parameter transaction, e.g. `{ field: "VIEWNAME", value: "/AIF/BDC_V_CONF" }`. */
export interface TransactionParameterAssignment {
  readonly field: string;
  readonly value: string;
}

export interface TransactionParams {
  /** The transaction code to create, e.g. ZTM_CARRIERS. */
  readonly tcode: string;
  /** TSTCT-TTEXT. */
  readonly description: string;
  /** DEVCLASS. */
  readonly packageName: string;
  /**
   * An ALREADY gate-judged TRKORR. Required for a transportable
   * (non-`$`-prefixed) package — `RPY_TRANSACTION_INSERT`'s own
   * `RS_CORR_INSERT` call needs one to register the transaction in CTS — and
   * refused for a local, `$`-prefixed package, which registers with
   * `korrnum = space` instead (see {@link assertTransactionCreateTarget}).
   */
  readonly corrNr?: string;
  /**
   * How `corrNr` was chosen, for the gate: `"named"` when a human named it
   * (caller-supplied or a configured pin), `"auto"` when the session
   * resolver picked or created it (`preflightPackageCorr`). Defaults to
   * `"named"`, the stricter reading — under `ABAP_ALLOW_TRANSPORTS=auto`
   * only `"auto"` passes, so a caller that resolved the request itself must
   * say so or be refused.
   */
  readonly corrSource?: "named" | "auto";
  /** Which transaction_type to build. Defaults to `"report"`. */
  readonly kind?: TransactionKind;
  /** The EXISTING program it starts — report, dialog. */
  readonly program?: string;
  /** The 4-digit dynpro it starts on — dialog only. */
  readonly screen?: string;
  /** The transaction this one calls into — parameter, variant. */
  readonly targetTransaction?: string;
  /** Whether the target transaction's first screen is skipped — parameter only. Defaults to `false`. */
  readonly skipFirstScreen?: boolean;
  /** Screen-field assignments passed to the target transaction — parameter only. */
  readonly parameters?: readonly TransactionParameterAssignment[];
  /** The screen variant passed to the target transaction — variant only. */
  readonly variant?: string;
  /** Whether the variant is cross-client (TSTCP `@@`) rather than client-specific (`@`) — variant only. */
  readonly crossClientVariant?: boolean;
  /** The class implementing the transaction model — oo only. */
  readonly className?: string;
  /** The method implementing the transaction model — oo only. */
  readonly methodName?: string;
  /** OS_APPLICATION's UPDATE_MODE: `S` (synchronous), `A` (asynchronous) or `L` (local). Defaults to `"S"` — oo only. */
  readonly updateMode?: "S" | "A" | "L";
}

const TARGET_TRANSACTION_RE = /^[A-Za-z0-9_/]{1,20}$/;
const SCREEN_RE = /^\d{4}$/;
const PARAMETER_FIELD_RE = /^[A-Za-z0-9_/-]{1,30}$/;
const VARIANT_RE = /^[A-Za-z0-9_/]{1,30}$/;
const CLASS_NAME_RE = /^[A-Za-z0-9_/]{1,30}$/;
const METHOD_NAME_RE = /^[A-Za-z0-9_]{1,30}$/;

function refuse(tcode: string, kind: TransactionKind, field: string, message: string): never {
  throw new AbapError("BAD_INPUT", message, { tcode, kind, field });
}

/**
 * Zero-network check: does this {@link TransactionParams} make sense for its
 * (possibly defaulted) {@link TransactionKind}? Every field is named by its
 * `abap_write` schema name (snake_case) in error `details`/messages, not its
 * TS property name, since that is the name a caller actually typed. Returns
 * the effective kind (the default, `"report"`, when `p.kind` is omitted).
 */
export function assertTransactionKindParams(p: TransactionParams): TransactionKind {
  const kind = p.kind ?? "report";
  const tcode = p.tcode;

  const refuseForeign = (field: string, ownerKind: TransactionKind) =>
    refuse(
      tcode,
      kind,
      field,
      `${field} applies to kind=${ownerKind}, not kind=${kind}.`,
    );

  switch (kind) {
    case "report": {
      if (p.program === undefined || p.program === "") {
        refuse(tcode, kind, "program", `kind=report requires program (the existing report it starts).`);
      }
      if (p.screen !== undefined) refuseForeign("screen", "dialog");
      if (p.targetTransaction !== undefined) refuseForeign("target_transaction", "parameter");
      if (p.parameters !== undefined) refuseForeign("parameters", "parameter");
      if (p.variant !== undefined) refuseForeign("variant", "variant");
      if (p.className !== undefined) refuseForeign("class", "oo");
      if (p.methodName !== undefined) refuseForeign("method", "oo");
      break;
    }
    case "dialog": {
      if (p.program === undefined || p.program === "") {
        refuse(tcode, kind, "program", `kind=dialog requires program (the existing screen program it starts).`);
      }
      if (p.screen === undefined || p.screen === "") {
        refuse(tcode, kind, "screen", `kind=dialog requires screen (a 4-digit dynpro number).`);
      }
      if (!SCREEN_RE.test(p.screen)) {
        refuse(tcode, kind, "screen", `screen ${JSON.stringify(p.screen)} must be exactly 4 digits.`);
      }
      if (p.targetTransaction !== undefined) refuseForeign("target_transaction", "parameter");
      if (p.parameters !== undefined) refuseForeign("parameters", "parameter");
      if (p.variant !== undefined) refuseForeign("variant", "variant");
      if (p.className !== undefined) refuseForeign("class", "oo");
      if (p.methodName !== undefined) refuseForeign("method", "oo");
      break;
    }
    case "parameter": {
      if (p.program !== undefined) refuseForeign("program", "report");
      if (p.screen !== undefined) refuseForeign("screen", "dialog");
      if (p.targetTransaction === undefined || p.targetTransaction === "") {
        refuse(tcode, kind, "target_transaction", `kind=parameter requires target_transaction.`);
      }
      if (!TARGET_TRANSACTION_RE.test(p.targetTransaction)) {
        refuse(
          tcode,
          kind,
          "target_transaction",
          `target_transaction ${JSON.stringify(p.targetTransaction)} must match ${TARGET_TRANSACTION_RE}.`,
        );
      }
      for (const a of p.parameters ?? []) {
        if (!PARAMETER_FIELD_RE.test(a.field)) {
          refuse(
            tcode,
            kind,
            "parameters",
            `parameters field ${JSON.stringify(a.field)} must match ${PARAMETER_FIELD_RE}.`,
          );
        }
        if (a.value === "" || a.value.includes(";")) {
          refuse(
            tcode,
            kind,
            "parameters",
            `parameters value for field ${JSON.stringify(a.field)} must be non-empty and must not contain ';'.`,
          );
        }
      }
      if (p.variant !== undefined) refuseForeign("variant", "variant");
      if (p.className !== undefined) refuseForeign("class", "oo");
      if (p.methodName !== undefined) refuseForeign("method", "oo");
      break;
    }
    case "variant": {
      if (p.program !== undefined) refuseForeign("program", "report");
      if (p.screen !== undefined) refuseForeign("screen", "dialog");
      if (p.targetTransaction === undefined || p.targetTransaction === "") {
        refuse(tcode, kind, "target_transaction", `kind=variant requires target_transaction.`);
      }
      if (!TARGET_TRANSACTION_RE.test(p.targetTransaction)) {
        refuse(
          tcode,
          kind,
          "target_transaction",
          `target_transaction ${JSON.stringify(p.targetTransaction)} must match ${TARGET_TRANSACTION_RE}.`,
        );
      }
      if (p.variant === undefined || p.variant === "") {
        refuse(tcode, kind, "variant", `kind=variant requires variant.`);
      }
      if (!VARIANT_RE.test(p.variant)) {
        refuse(tcode, kind, "variant", `variant ${JSON.stringify(p.variant)} must match ${VARIANT_RE} (no whitespace).`);
      }
      if (p.parameters !== undefined) refuseForeign("parameters", "parameter");
      if (p.className !== undefined) refuseForeign("class", "oo");
      if (p.methodName !== undefined) refuseForeign("method", "oo");
      break;
    }
    case "oo": {
      if (p.program !== undefined) refuseForeign("program", "report");
      if (p.screen !== undefined) refuseForeign("screen", "dialog");
      if (p.targetTransaction !== undefined) refuseForeign("target_transaction", "parameter");
      if (p.parameters !== undefined) refuseForeign("parameters", "parameter");
      if (p.variant !== undefined) refuseForeign("variant", "variant");
      if (p.className === undefined || p.className === "") {
        refuse(tcode, kind, "class", `kind=oo requires class.`);
      }
      if (!CLASS_NAME_RE.test(p.className)) {
        refuse(tcode, kind, "class", `class ${JSON.stringify(p.className)} must match ${CLASS_NAME_RE}.`);
      }
      if (p.methodName === undefined || p.methodName === "") {
        refuse(tcode, kind, "method", `kind=oo requires method.`);
      }
      if (!METHOD_NAME_RE.test(p.methodName)) {
        refuse(tcode, kind, "method", `method ${JSON.stringify(p.methodName)} must match ${METHOD_NAME_RE}.`);
      }
      if (p.updateMode !== undefined && p.updateMode !== "S" && p.updateMode !== "A" && p.updateMode !== "L") {
        refuse(tcode, kind, "update_mode", `update_mode ${JSON.stringify(p.updateMode)} must be one of "S", "A" or "L".`);
      }
      break;
    }
  }
  return kind;
}

/**
 * Builds the flat classic-tool args `create_transaction`/`abap-tran.ts`
 * reads, from an already-{@link assertTransactionKindParams}-checked
 * {@link TransactionParams}. Zero-network, pure mapping — `tcode`,
 * `description`, `package_name`, `corr_nr` are read by the caller
 * (`createTransaction`) instead, since those are shared with every kind and
 * already validated there.
 */
export function transactionInsertArgs(p: TransactionParams): Record<string, unknown> {
  const kind = p.kind ?? "report";
  const transactionType = kind === "report" ? "R" : kind === "dialog" ? "D" : kind === "oo" ? "P" : kind === "variant" ? "V" : "P";

  const program = kind === "report" || kind === "dialog" ? (p.program ?? "") : "";
  const dynpro = kind === "report" ? "1000" : kind === "dialog" ? (p.screen ?? "") : "";
  const calledTransaction =
    kind === "parameter" || kind === "variant" ? (p.targetTransaction ?? "") : kind === "oo" ? "OS_APPLICATION" : "";
  const skipFirstScreen = kind === "parameter" ? (p.skipFirstScreen ?? false) : kind === "oo" ? true : false;
  const variant = kind === "variant" ? (p.variant ?? "") : "";
  const crossClientVariant = kind === "variant" ? (p.crossClientVariant ?? false) : false;

  const parameters: Array<{ field: string; value: string }> =
    kind === "parameter"
      ? (p.parameters ?? []).map((a) => ({ field: a.field.toUpperCase(), value: a.value }))
      : kind === "oo"
        ? [
            { field: "CLASS", value: (p.className ?? "").toUpperCase() },
            { field: "METHOD", value: (p.methodName ?? "").toUpperCase() },
            { field: "UPDATE_MODE", value: p.updateMode ?? "S" },
          ]
        : [];

  return {
    tcode: p.tcode,
    description: p.description,
    package_name: p.packageName,
    corr_nr: p.corrNr ?? "",
    transaction_type: transactionType,
    program,
    dynpro,
    called_transaction: calledTransaction,
    skip_first_screen: skipFirstScreen,
    variant,
    cross_client_variant: crossClientVariant,
    parameters,
  };
}

/**
 * No-network check: does this package/corr_nr pair make sense for a
 * transaction create? A local (`$`-prefixed) package refuses a `corrNr` — it
 * registers with `korrnum = space`, not a transport request, so there is
 * nothing for one to attach to. A transportable package requires a `corrNr`
 * in TRKORR format ({@link isTrkorr}), because `RPY_TRANSACTION_INSERT`'s own
 * `RS_CORR_INSERT` call needs one to register the transaction in CTS.
 */
export function assertTransactionCreateTarget(
  packageName: string,
  corrNr: string | undefined,
): string {
  const validated = assertEnhIdentifier(packageName, "packageName", {
    maxLength: PACKAGE_MAX_LENGTH,
    allowLocal: true,
  });
  const local = isLocalPackageName(validated);
  if (local && corrNr !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `corr_nr ${JSON.stringify(corrNr)} was supplied for local package ${JSON.stringify(validated)}, ` +
        "but a local ($-prefixed) transaction is registered with korrnum = space rather than on a " +
        "transport request, so there is nothing here for one to attach to.",
      { packageName: validated, corrNr },
    );
  }
  if (!local && corrNr === undefined) {
    throw new AbapError(
      "TRANSPORT_ERROR",
      `packageName ${JSON.stringify(validated)} is not local ($-prefixed), so this transaction must ` +
        "be registered in CTS via RPY_TRANSACTION_INSERT's own RS_CORR_INSERT call, which requires a " +
        "transport request — and none was resolved for this call.",
      { packageName: validated },
      "Through abap_write no corr_nr is needed: omitted, the request is resolved under " +
        "ABAP_ALLOW_TRANSPORTS before this module runs (auto reuses a modifiable request this " +
        "session created for the package, else creates one; a pinned list uses one of its " +
        "entries). Reaching this refusal from abap_write means no session transport manager was " +
        "wired into the call — an abapsmith wiring defect, not a caller error. A direct caller of " +
        "this module hands it a TRKORR the safety gate has already judged.",
    );
  }
  if (corrNr !== undefined) assertTransactionCorrNr(corrNr);
  return validated;
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * Create a transaction code — report (default), dialog, parameter, variant,
 * or an OO transaction with transaction model (OS_APPLICATION form).
 *
 * Order matters: (1) validate every caller string first, including the
 * kind-specific fields via {@link assertTransactionKindParams} and the
 * package/corr_nr pairing via {@link assertTransactionCreateTarget}; (2)
 * {@link assertBridgeMutation} on the DOMAIN object (`TRAN/T` `tcode` in
 * `packageName`, with `corr` set for a transportable package), zero-network,
 * before dispatching anything — the fluid tool's own gate only judges the
 * invoker class deployment, a different object entirely, so skipping this
 * step would let that gate silently approve a transaction in a customer
 * package (`activate: false` because a transaction has no activation step);
 * (3) dispatch the `create_transaction` action and assert the transcript.
 *
 * `abap-tran.ts`'s `create_transaction` method calls
 * `RPY_TRANSACTION_INSERT` with `suppress_corr_insert` left UNPASSED for
 * both a transportable and a local package — verbatim-read live on A4H
 * 2026-09-05: it `default`s to `space`, and only when it is initial does the
 * FM run `RS_CORR_INSERT` itself, forwarding `transport_number` straight
 * through as `korrnum`. `transport_number` (also read verbatim 2026-09-05)
 * carries `corr_nr` through to `korrnum` — the TRKORR for a transportable
 * package, `space` (ABAP's SPACE constant) for a local one. `language =
 * sy-langu`: the short text is written in the session's logon language;
 * there is no parameter for choosing another one.
 *
 * Throws `BAD_INPUT` for any refused string (including a bad corr_nr, one
 * supplied for a local package, or a field misplaced for the effective
 * kind), `TRANSPORT_ERROR` for a transportable package given no corr_nr,
 * whatever the gate throws for a refused mutation (all before any network
 * call), and `CHECK_FAILED` when the transcript comes back without the
 * `TRAN-CREATED` tag — including empty output, which is a failure, not a
 * success with nothing to say. `beforeAssert` turns an
 * `already_exist`/other named `RPY_TRANSACTION_INSERT` failure line into a
 * `CHECK_FAILED` naming the exception, ahead of the generic missing-tag
 * message.
 */
export async function createTransaction(
  conn: AbapConnection,
  gate: SafetyGate,
  params: TransactionParams,
): Promise<{ run: RunResult; transcript: DdicTranscript }> {
  const kind = assertTransactionKindParams(params);
  const tcode = assertTransactionCode(params.tcode);
  const description = assertAbapText(params.description, "description", TTEXT_MAX_LENGTH);
  const packageName = assertTransactionCreateTarget(params.packageName, params.corrNr);
  const local = isLocalPackageName(packageName);
  const corrNr = local ? undefined : params.corrNr;
  // same identifier grammar as before #214
  const program =
    kind === "report" || kind === "dialog"
      ? assertEnhIdentifier(params.program as string, "program", { maxLength: PROGRAM_MAX_LENGTH })
      : undefined;

  const corr: SafetyCorr | undefined = local
    ? undefined
    : { kind: "transport", corrNr: corrNr as string, source: params.corrSource ?? "named" };
  assertBridgeMutation(
    gate,
    { type: "TRAN/T", name: tcode, packageName },
    { activate: false, ...(corr !== undefined ? { corr } : {}) },
  );

  const args = transactionInsertArgs({
    ...params,
    tcode,
    description,
    packageName,
    corrNr,
    ...(program !== undefined ? { program } : {}),
  });

  const beforeAssert = (transcript: DdicTranscript): void => {
    const errorLine = transcript.errorLine;
    if (!errorLine || !errorLine.includes("RPY_TRANSACTION_INSERT failed")) return;
    if (errorLine.includes("already_exist")) {
      throw new AbapError(
        "CHECK_FAILED",
        `RPY_TRANSACTION_INSERT refused to create transaction ${tcode}: ${errorLine}`,
        { tcode, raw: transcript.raw },
        `abap_read {"object":"${tcode}","type":"TRAN/T"} shows the existing transaction. To point it ` +
          `at a different program use abap_write mode="update"; to replace it, delete it first ` +
          `(mode="delete") and create it again.`,
        { retryable: false }, // a retry cannot succeed until the transaction is deleted or retargeted
      );
    }
    const notRetryable = ["permission_error", "name_not_allowed", "name_conflict"];
    const retryable = ["db_access_error", "cancelled"];
    const named = [...notRetryable, ...retryable].find((n) => errorLine.includes(n));
    if (named) {
      throw new AbapError(
        "CHECK_FAILED",
        `RPY_TRANSACTION_INSERT refused to create transaction ${tcode}: ${errorLine}`,
        { tcode, raw: transcript.raw },
        retryable.includes(named)
          ? "Retry; if it recurs check SM12 locks on TSTC for the tcode."
          : undefined,
        { retryable: retryable.includes(named) }, // retryable only for the exceptions listed in `retryable` above
      );
    }
    throw new AbapError(
      "CHECK_FAILED",
      `RPY_TRANSACTION_INSERT failed to create transaction ${tcode}: ${errorLine}`,
      { tcode, raw: transcript.raw },
    );
  };

  return runClassicAction(conn, gate, {
    action: "create_transaction",
    args,
    what: `Creating ${kind} transaction ${tcode}`,
    ...(corr !== undefined ? { corrSource: corr.source } : {}),
    expectTags: ["TRAN-CREATED"],
    beforeAssert,
  });
}
