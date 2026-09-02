/**
 * SAP enqueue-lock discipline for FPM/FBI screen configurations.
 *
 * `CL_WDR_CFG_PERSISTENCE_UTILS=>SAVE_COMP_CONFIG_TO_DB` performs no enqueue check of its own — a
 * session whose own lock request was refused can still commit straight over another session's
 * locked config (observed live). This module enforces the lock itself in generated ABAP
 * ({@link buildLockedOperationSource}); like its sibling `fpm-runtime.ts`, nothing here is
 * reachable through ADT REST, so each operation is compiled into an `IF_OO_ADT_CLASSRUN` class in
 * `$TMP`, activated, executed, and read back as a line-prefixed transcript.
 *
 * Two rules are non-negotiable, each closing a landmine that was hit live:
 *  - `DEQUEUE_*`'s `subrc` is never evidence of a release (`subrc = 0` even when nothing was
 *    released) — only a fresh `ENQUEUE_READ` proves a lock is gone. Every release this module
 *    generates re-reads, and the transcript says `note=[subrc-is-not-evidence]`.
 *  - `CONFIG_TYPE` is `NUMC(2)`, so `'00'` satisfies `IS INITIAL`. Skipping an "initial-looking"
 *    key field silently widens the enqueue into a wildcard lock over every `CONFIG_TYPE` of a
 *    `CONFIG_ID` (observed blocking another session's types live). So every `X_CONFIG_*` flag is
 *    the literal `'X'`, unconditionally, with no `IS INITIAL` test anywhere in generated ABAP; and
 *    {@link FpmLockKey} is a branded type whose only constructor, {@link fpmLockKey}, makes an
 *    absent/malformed `configType` unconstructable at compile time.
 *
 * Confirmed-vs-inferred wire facts (lock objects, `_SCOPE` behavior, `GARG` layout, the `GUSR`
 * ownership discriminator, `ENQUE_DELETE` semantics), the full inferred/untested list, the
 * transcript phase grammar, and why `forceClear` ships gated off and unwired to any tool are all
 * archived verbatim in the git history — read it before changing lock
 * semantics here. Each inferred item is also re-noted at its point of use below, and every one
 * fails CLOSED (refuse / retain / report) rather than open.
 */
import { createHash } from "node:crypto";

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import {
  assertPlainName,
  deployBridge,
  ERR_LINE_PREFIX,
  executeBridge,
  MAX_NAME,
  parseBracketFields,
  verifyBridgeActivation,
} from "./run.js";
import { assertConfigId, assertConfigVar, CONFIG_ID_LEN } from "./fpm-runtime.js";
import type { SafetyGate } from "../safety.js";

// ---------------------------------------------------------------------------
// Key model — the wildcard-lock landmine, killed at the type level
// ---------------------------------------------------------------------------

export type FpmLockObjectKind = "component" | "application";

declare const fpmLockKeyBrand: unique symbol;

/**
 * A validated, complete enqueue key. The brand is not decoration: `configType` absent or
 * malformed is the exact input that widens a precise lock into a wildcard over every
 * `CONFIG_TYPE` of a `CONFIG_ID`, so `fpmLockKeyBrand` (a `unique symbol`, never defined) makes no
 * object literal satisfy this interface. Only {@link fpmLockKey} produces one, via
 * {@link assertLockConfigType} — "forgot config_type" is a compile error, not a runtime wildcard.
 */
export interface FpmLockKey {
  /** Validated, upper-cased, <= 32 chars. */
  readonly configId: string;
  /** EXACTLY 2 numeric digits, e.g. "00". Never absent, never blank. */
  readonly configType: string;
  /** May be "" — blank is a legal variant, and is always sent WITH its X-flag. */
  readonly configVar: string;
  readonly kind: FpmLockObjectKind;
  readonly [fpmLockKeyBrand]: true;
}

// CONFIG_ID_LEN (32, the width of WDY_CONFIG_ID) is imported from fpm-runtime.ts.
const CONFIG_TYPE_LEN = 2;
const CONFIG_VAR_LEN = 6;

/**
 * Strict NUMC2 validation for a lock key's `config_type`. Deliberately stricter than
 * `fpm-runtime.ts`'s `assertConfigType`, which defaults a missing value to `"00"` and trims —
 * neither is acceptable on a lock key: a default locks a config the caller never named, and a
 * trim hides whitespace where a NUMC2 belongs. Rejects `undefined`, `""`, `"0"`, `"000"`, `"0A"`.
 */
export function assertLockConfigType(value: string | undefined): string {
  if (typeof value !== "string" || !/^[0-9]{2}$/.test(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `config_type ${JSON.stringify(value)} must be exactly 2 numeric digits (NUMC2) with no ` +
        `surrounding whitespace — e.g. "00" (component) or "02" (application). It is a lock key ` +
        `field: an absent or malformed value would widen the enqueue into a wildcard lock over ` +
        `every config_type of this config_id.`,
      { value },
    );
  }
  return value;
}

/** `config_type "02"` is the repo-wide convention for application-scope (see `fpmReadInputSchema`); everything else is component-scope. */
export function lockKindForConfigType(configType: string): FpmLockObjectKind {
  return assertLockConfigType(configType) === "02" ? "application" : "component";
}

/** The ONLY constructor for {@link FpmLockKey}. */
export function fpmLockKey(input: {
  configId: string;
  /** REQUIRED. No default and no `| undefined`: see {@link assertLockConfigType}. */
  configType: string;
  configVar?: string;
  /** Defaults to {@link lockKindForConfigType}. */
  kind?: FpmLockObjectKind;
}): FpmLockKey {
  const configId = assertConfigId(input.configId).toUpperCase();
  const configType = assertLockConfigType(input.configType);
  const configVar = assertConfigVar(input.configVar).toUpperCase();
  const kind = input.kind ?? lockKindForConfigType(configType);
  return {
    configId,
    configType,
    configVar,
    kind,
    // The brand has no runtime existence; this cast is the single sanctioned
    // one in the module and it sits directly downstream of the validators.
  } as unknown as FpmLockKey;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Line prefix for this module's transcript. `ERR_LINE_PREFIX` is reused for diagnostics. */
export const LOCK_LINE_PREFIX = "LCK> ";

export const FPM_LOCK_BRIDGE_CLASS_PREFIX = "ZCL_ZMCP_FPMLK_";

/**
 * `_SCOPE` for BOTH the enqueue and the dequeue — one constant so the pair cannot disagree.
 * Enqueue `'2'`/dequeue `'1'` was observed NOT to release the lock while still returning
 * `subrc = 0`. `'1'` (dialog slot) is used because `1/1` is an observed-released pair and scope 1
 * parks the owner id in `GUSR`, the field the MINE/FOREIGN classification reads. See archive.
 */
export const FPM_LOCK_SCOPE = "1";

/**
 * The wildcard fill character, U+FFFF (UTF-8 `EF BF BF`) — not `0xFF`. The byte value is
 * observed in captured `GARG`s; that an unset X-flag is what produces it is inferred (see archive).
 */
export const GARG_WILDCARD_CHAR = "￿";

export const GARG_LENGTH = 150;

export const GARG_SEGMENTS: Readonly<
  Record<"configId" | "configType" | "configVar", readonly [number, number]>
> = {
  configId: [0, CONFIG_ID_LEN],
  configType: [CONFIG_ID_LEN, CONFIG_ID_LEN + CONFIG_TYPE_LEN],
  configVar: [CONFIG_ID_LEN + CONFIG_TYPE_LEN, CONFIG_ID_LEN + CONFIG_TYPE_LEN + CONFIG_VAR_LEN],
};

/** First offset past the 40 significant characters. */
const GARG_TAIL_OFFSET = GARG_SEGMENTS.configVar[1];

export const FPM_LOCK_OBJECTS: Readonly<
  Record<FpmLockObjectKind, { lockObject: string; enqueueFm: string; dequeueFm: string; gname: string }>
> = {
  component: {
    lockObject: "E_WDY_CONFCOMP",
    enqueueFm: "ENQUEUE_E_WDY_CONFCOMP",
    dequeueFm: "DEQUEUE_E_WDY_CONFCOMP",
    gname: "WDY_CONFIG_DATA",
  },
  /**
   * VERIFIED LIVE on A4H (2026-08-11): the FM/lock-object/`GNAME` triple, the 0/32/34
   * {@link GARG_SEGMENTS} layout, `GUSR` as owner slot, and DEQUEUE release are all confirmed for
   * this lock object (regression-pinned by test/integration-fpm-lock.test.ts). Still carried over
   * by analogy, not captured: the full `_SCOPE` release matrix and the X-flag/wildcard-fill
   * behaviour (only scope 1 / `E_WDY_CONFCOMP` were exercised). See archive for the capture.
   */
  application: {
    lockObject: "E_WDY_CONFAPPL",
    enqueueFm: "ENQUEUE_E_WDY_CONFAPPL",
    dequeueFm: "DEQUEUE_E_WDY_CONFAPPL",
    gname: "WDY_CONFIG_APPL",
  },
};

/**
 * Ceiling on `WDY_CONFIG_APPL` rows kept purely because the application `GARG` layout is inferred
 * (rows whose sliced id segment did not match, kept anyway in case the slice was wrong). The
 * classrun transcript truncates from the END, so an unbounded speculative tail can push the
 * trailing `COUNT`/`GUARD`/`RELEASE` lines off — a silent loss in the dangerous direction. A
 * bounded keep plus `GUARD reason=[appl-rows-truncated]` says so out loud. Rows whose id segment
 * DOES match are never capped.
 */
const MAX_INFERRED_APPL_ROWS = 50;

/**
 * ABAP variable holding the self-probe's `config_id`, and the fixed stem it's built from. Minted
 * at ABAP RUNTIME, once per run — never a module-global constant, or two concurrent sessions would
 * race for the same throwaway lock and the loser would refuse every locked operation. The
 * generated ABAP concatenates the stem with 21 hex chars of a fresh UUID (32 chars total =
 * `CONFIG_ID_LEN`), generated server-side so it carries no caller input and needs no validator.
 * `config_type '99'` keeps it outside the component/application convention; the lock is precise,
 * short-lived, released explicitly inside its own `TRY ... CATCH cx_root`, and re-read to confirm
 * release (`subrc` is not evidence — see module header).
 */
const SELF_PROBE_ID_VAR = "lv_lk_selfid";
const SELF_PROBE_ID_STEM = "ZMCP_LKSELF";
const SELF_PROBE_ID_ENTROPY_LEN = CONFIG_ID_LEN - SELF_PROBE_ID_STEM.length;

/**
 * An enqueue key as the ABAP generator sees it. `configIdExpr`, when present,
 * is emitted VERBATIM in place of a quoted literal — it is a module-internal
 * ABAP variable name (never caller data), which is what lets the self-probe
 * carry a runtime-minted id.
 */
interface AbapLockKeyOperand {
  configId: string;
  configType: string;
  configVar: string;
  configIdExpr?: string;
}

const SELF_PROBE: AbapLockKeyOperand = {
  /** Documentation only — never emitted; `configIdExpr` wins. */
  configId: SELF_PROBE_ID_STEM,
  configIdExpr: SELF_PROBE_ID_VAR,
  configType: "99",
  configVar: "SELFID",
};

/**
 * Every character legal in a `GARG` built from a validated key (key charset plus padding blank);
 * anything else, U+FFFF above all, is wildcard fill by definition. The blank sits in the MIDDLE of
 * the literal on purpose — ABAP strips TRAILING blanks from a text literal, so trailing would
 * silently drop it and flag every padded GARG as wildcard.
 */
const ABAP_LEGAL_GARG_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz0123456789_/";

// ---------------------------------------------------------------------------
// GARG construction and inspection
// ---------------------------------------------------------------------------

function padTo(value: string, len: number): string {
  return value.length >= len ? value.slice(0, len) : value + " ".repeat(len - value.length);
}

/**
 * The 40 significant characters: `config_id(32) + config_type(2) + config_var(6)`. This layout is
 * inferred, never captured, for `kind === "application"` (see archive) — safe to *build* with (a
 * wrong layout just never matches, reading as "not held"), dangerous to *filter* with, which is
 * why filters over application rows retain what they can't parse instead of dropping it.
 */
export function buildGargPrefix(key: FpmLockKey): string {
  return (
    padTo(key.configId, CONFIG_ID_LEN) +
    padTo(key.configType, CONFIG_TYPE_LEN) +
    padTo(key.configVar, CONFIG_VAR_LEN)
  );
}

/** The full 150-character, blank-padded `GARG`. */
export function buildGarg(key: FpmLockKey): string {
  return padTo(buildGargPrefix(key), GARG_LENGTH);
}

export interface GargView {
  raw: string;
  configId: string;
  configType: string;
  configVar: string;
  wildcardSegments: ("configId" | "configType" | "configVar" | "tail")[];
  isWildcard: boolean;
}

/**
 * Strict test for the OBSERVED wildcard fill byte sequence. Kept separate from {@link parseGarg}'s
 * broader "not a legal key character" sweep, which also catches a fill never actually observed.
 */
export function hasWildcardFill(garg: string): boolean {
  return garg.includes(GARG_WILDCARD_CHAR);
}

const LEGAL_GARG_CHAR = /^[A-Za-z0-9_/ ]*$/;

/**
 * Splits a `GARG` into its three key segments and reports which (plus the padding tail) carry
 * wildcard fill. Re-pads to 150 before slicing: ABAP's `C -> STRING` conversion strips trailing
 * blanks, so the transcript's `garg=[...]` for a precise component key arrives already truncated
 * (observed at 34 chars) — padding here restores information the wire dropped.
 */
export function parseGarg(garg: string): GargView {
  const padded = padTo(garg, GARG_LENGTH);
  const seg = (name: "configId" | "configType" | "configVar"): string => {
    const [from, to] = GARG_SEGMENTS[name];
    return padded.slice(from, to);
  };
  const configIdSeg = seg("configId");
  const configTypeSeg = seg("configType");
  const configVarSeg = seg("configVar");
  const tailSeg = padded.slice(GARG_TAIL_OFFSET);

  const wildcardSegments: GargView["wildcardSegments"] = [];
  if (!LEGAL_GARG_CHAR.test(configIdSeg)) wildcardSegments.push("configId");
  if (!LEGAL_GARG_CHAR.test(configTypeSeg)) wildcardSegments.push("configType");
  if (!LEGAL_GARG_CHAR.test(configVarSeg)) wildcardSegments.push("configVar");
  if (!LEGAL_GARG_CHAR.test(tailSeg)) wildcardSegments.push("tail");

  return {
    raw: garg,
    configId: configIdSeg.trimEnd(),
    configType: configTypeSeg.trimEnd(),
    configVar: configVarSeg.trimEnd(),
    wildcardSegments,
    isWildcard: wildcardSegments.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Rows / transcript model
// ---------------------------------------------------------------------------

export type LockOwnership = "MINE" | "FOREIGN" | "UNKNOWN";

export interface LockRow {
  gname: string;
  garg: string;
  gmode: string;
  guname: string;
  gclient: string;
  gusr: string;
  gusrvb: string;
  guse: string;
  gusevb: string;
  gobj: string;
  garg_view: GargView;
  ownership: LockOwnership;
}

export type LockReleaseOutcome = { status: "released" } | { status: "still-held"; rows: LockRow[] };

export interface LockPhaseSnapshot {
  phase: string;
  rows: LockRow[];
  /**
   * Row count the generated ABAP reported on its `COUNT` line, independent of how many `ROW` lines
   * survived transport. A phase appears (with `rows: []`) whenever either a `ROW` or `COUNT` line
   * names it, so "re-read ran and found nothing" stays distinguishable from "re-read never ran" —
   * load-bearing for `after-release`. Absent only if `ROW` lines arrived with no closing `COUNT`,
   * itself a truncation sign, which is why a mismatch raises a diagnostic.
   */
  reportedRows?: number;
}

export interface FpmLockTranscript {
  /** `GUSR` learned via the throwaway self-lock; absent when self-identification failed. */
  selfOwnerId?: string;
  acquire?: { subrc: number; foreignLock: boolean; systemFailure: boolean };
  preSaveVerify?: { held: boolean; mine: boolean; wildcard: boolean; passed: boolean };
  /** Did the generated ABAP actually reach the caller's body? */
  saveReached: boolean;
  release?: LockReleaseOutcome;
  phases: LockPhaseSnapshot[];
  wildcardDetected: boolean;
  /** `GUARD` lines — why the protocol refused to proceed. */
  aborts: string[];
  diagnostics: string[];
  droppedLines: number;
}

// ---------------------------------------------------------------------------
// Query / operation model
// ---------------------------------------------------------------------------

export interface FpmLockInspectQuery {
  mode: "locks";
  configId: string;
  /**
   * When absent, BOTH lock objects are inspected. In neither case is a `GARG`
   * filter sent — see {@link buildLockInspectSource} for why an exact-match
   * `GARG` filter would hide exactly the rows this report exists to find.
   */
  configType?: string;
  configVar?: string;
}

export interface FpmLockedOperation {
  key: FpmLockKey;
  /** Generator-produced ABAP statements to execute while the lock is verifiably held. */
  body: string;
  /** Short human label emitted into the transcript. Validated as a plain name. */
  bodyLabel: string;
}

// ---------------------------------------------------------------------------
// Body safety
// ---------------------------------------------------------------------------

const MAX_BODY_CHARS = 20000;

/**
 * Tokens a body may not contain, each paired with what it would break. Defense in depth, not the
 * primary control (bodies come from this repo's own generators, never caller free text): guards
 * against a generator bug — e.g. a bare `RETURN` — silently skipping the release/verify.
 */
const FORBIDDEN_BODY_TOKENS: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /\bENQUEUE\w*/i, why: "the body must not take or manipulate enqueue locks" },
  { re: /\bDEQUEUE\w*/i, why: "only the generated protocol may release the lock" },
  { re: /\bENQUE_\w+/i, why: "ENQUE_DELETE and friends are destructive and gated separately" },
  { re: /\bRETURN\b/i, why: "an early RETURN would skip the release and the post-body verify" },
  { re: /\bLEAVE\b/i, why: "LEAVE would abandon the protocol with the lock still held" },
  { re: /\bEXIT\b/i, why: "EXIT outside a loop leaves the method and skips the release" },
  { re: /\bSTOP\b/i, why: "STOP ends processing and skips the release" },
  { re: /\bCHECK\b/i, why: "a failing CHECK exits the processing block and skips the release" },
  { re: /\bENDMETHOD\b/i, why: "the body must not close the method it is nested in" },
  { re: /\bENDCLASS\b/i, why: "the body must not close the generated class" },
  { re: /\bCLASS\s+\w/i, why: "the body must not open a class definition" },
  { re: /\bSUBMIT\b/i, why: "SUBMIT starts a separate program with its own lock context" },
  { re: /\bCALL\s+TRANSACTION\b/i, why: "CALL TRANSACTION starts a separate lock context" },
  { re: /_lk_/i, why: "`_lk_` is the generated protocol's own variable prefix" },
  { re: /LCK>/, why: "the body must not be able to forge transcript lines" },
];

/**
 * Refuses a generator-produced body that would tamper with the protocol.
 * Returns the normalised body (CRLF folded, trailing whitespace trimmed).
 */
export function assertLockBodyIsSafe(body: string, label: string): string {
  if (typeof body !== "string") {
    throw new AbapError("BAD_INPUT", "Locked-operation body must be a string.", { label });
  }
  const normalised = body.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
  if (normalised.trim() === "") {
    throw new AbapError(
      "BAD_INPUT",
      "Refusing to take an enqueue lock around an empty body — a lock with nothing to protect " +
        "is pure contention.",
      { label },
    );
  }
  if (normalised.length > MAX_BODY_CHARS) {
    throw new AbapError(
      "BAD_INPUT",
      `Locked-operation body is ${normalised.length} characters; the ceiling is ${MAX_BODY_CHARS}.`,
      { label, length: normalised.length },
    );
  }
  // Control characters other than newline/tab would break the line-oriented
  // transcript the same way an embedded raw newline breaks `emit_xml`.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(normalised)) {
    throw new AbapError(
      "BAD_INPUT",
      "Locked-operation body contains control characters.",
      { label },
    );
  }
  if (normalised.includes("'") && !/^[^']*('[^']*'[^']*)*$/.test(normalised)) {
    throw new AbapError(
      "BAD_INPUT",
      "Locked-operation body has an unbalanced ABAP string literal — it would swallow the " +
        "release statements that follow it.",
      { label },
    );
  }
  for (const { re, why } of FORBIDDEN_BODY_TOKENS) {
    const m = re.exec(normalised);
    if (m) {
      throw new AbapError(
        "BAD_INPUT",
        `Locked-operation body contains "${m[0]}", which is refused: ${why}.`,
        { label, token: m[0] },
      );
    }
  }
  return normalised;
}

// ---------------------------------------------------------------------------
// Bridge naming
// ---------------------------------------------------------------------------

function isInspectQuery(q: FpmLockInspectQuery | FpmLockedOperation): q is FpmLockInspectQuery {
  return "mode" in q;
}

function validateInspectQuery(q: FpmLockInspectQuery): {
  configId: string;
  configType?: string;
  configVar?: string;
} {
  const configId = assertConfigId(q.configId).toUpperCase();
  const configType = q.configType === undefined ? undefined : assertLockConfigType(q.configType);
  const rawVar = assertConfigVar(q.configVar).toUpperCase();
  const configVar = q.configVar === undefined || rawVar === "" ? undefined : rawVar;
  return { configId, configType, configVar };
}

function lockDiscriminator(q: FpmLockInspectQuery | FpmLockedOperation): string {
  if (isInspectQuery(q)) {
    const v = validateInspectQuery(q);
    return JSON.stringify({
      mode: "locks",
      configId: v.configId,
      configType: v.configType ?? "",
      configVar: v.configVar ?? "",
    });
  }
  const body = assertLockBodyIsSafe(q.body, q.bodyLabel);
  const label = assertPlainName(q.bodyLabel, "bodyLabel");
  return JSON.stringify({
    mode: "locked-op",
    configId: q.key.configId,
    configType: q.key.configType,
    configVar: q.key.configVar,
    kind: q.key.kind,
    label,
    // Body's own hash: differing ABAP gets a differing bridge class.
    body: createHash("sha256").update(body, "utf8").digest("hex"),
  });
}

/**
 * Deterministic `$TMP` bridge-class name, mirroring `fpmBridgeClassName`: hashed from a canonical
 * serialisation of every input so identical requests reuse one class instead of churning `$TMP`.
 */
export function fpmLockBridgeClassName(q: FpmLockInspectQuery | FpmLockedOperation): string {
  const hashHexLen = MAX_NAME - FPM_LOCK_BRIDGE_CLASS_PREFIX.length;
  const hash = createHash("sha256")
    .update(lockDiscriminator(q), "utf8")
    .digest("hex")
    .slice(0, hashHexLen)
    .toUpperCase();
  return `${FPM_LOCK_BRIDGE_CLASS_PREFIX}${hash}`;
}

// ---------------------------------------------------------------------------
// ABAP source generation — shared fragments
// ---------------------------------------------------------------------------

/**
 * Last gate before a value becomes executable ABAP text. REFUSES rather than escapes (mirrors
 * `buildLikePattern` in `fpm-runtime.ts`) — an escaped-and-trusted quote is a bug waiting to happen.
 */
function abapLiteral(value: string, what: string): string {
  if (/['\r\n]/.test(value) || /[\u0000-\u001F]/.test(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} contains a character that cannot be embedded in generated ABAP source.`,
      { value: JSON.stringify(value), what },
    );
  }
  return value;
}

/**
 * The line-length ceiling ADT enforces on write: a source line over this length is rejected
 * WHOLESALE, before any ABAP runs, with `ADT_ERROR: "The line NNN exceeds 255 characters..."`
 * (`SEDI_ADT15`/`TooLongLine`). Two `emit_guard` literals in {@link buildLockInspectSource} hit
 * this live at 408/261 chars (see FIX-NOTES.md and the archive). Defined once so `255` is never
 * retyped elsewhere — {@link wrapAbapTemplateLines} and the regression test both reuse it.
 */
export const ADT_MAX_SOURCE_LINE_LEN = 255;

/**
 * Characters that are ABAP string-template syntax itself (`|` delimits it, `{`/`}` embed an
 * expression) and so cannot appear literally inside one. The template-literal analogue of
 * {@link abapLiteral}: REFUSE rather than escape.
 */
const TEMPLATE_CONTROL_CHAR_RE = new RegExp("[\\u0000-\\u001F]");

function abapTemplateLiteral(value: string, what: string): string {
  if (/[|{}\r\n]/.test(value) || TEMPLATE_CONTROL_CHAR_RE.test(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} contains a character that cannot be embedded in an ABAP string template.`,
      { value: JSON.stringify(value), what },
    );
  }
  return value;
}

/**
 * Word-wraps `text` into ABAP string-template fragments (`|...|`) joined by `&&`, one fragment
 * per returned line, so long diagnostic text never produces a source line ADT refuses (see
 * {@link ADT_MAX_SOURCE_LINE_LEN}). Wraps on space boundaries only; a single word longer than the
 * per-line budget is REFUSED rather than silently overflowing. Returns lines already carrying
 * `indent` and `|...| &&` / `|...|` formatting — join with `"\n"` or `lines.push(...result)`.
 * Callers that append extra text after the last fragment (see {@link emitWrappedGuardDetail})
 * must keep it short themselves.
 */
export function wrapAbapTemplateLines(text: string, indent: string, what: string): string[] {
  const checked = abapTemplateLiteral(text, what);
  // Per-line overhead: opening `|`, a trailing space (reproduces the word-separating space that
  // `&&` concatenation drops), closing `|`, and ` &&`. Only the last line needs less; budgeting
  // every line the same only ever leaves slack, never a shortfall.
  const overhead = indent.length + "| | &&".length;
  const budget = ADT_MAX_SOURCE_LINE_LEN - overhead;
  if (budget < 20) {
    throw new AbapError(
      "BAD_INPUT",
      `indent (${indent.length} chars) leaves no room to wrap ABAP text under the ` +
        `${ADT_MAX_SOURCE_LINE_LEN}-character ADT line limit.`,
      { what, indentLength: indent.length },
    );
  }
  const words = checked.split(" ").filter((w) => w.length > 0);
  for (const word of words) {
    if (word.length > budget) {
      throw new AbapError(
        "BAD_INPUT",
        `${what} contains a single word ${word.length} characters long, which cannot be wrapped ` +
          `under the ${ADT_MAX_SOURCE_LINE_LEN}-character ADT line limit (budget ${budget} at this ` +
          `indent) without splitting it mid-word.`,
        { what, word, budget },
      );
    }
  }
  const fragments: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length > budget && current !== "") {
      fragments.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  fragments.push(current);
  return fragments.map((frag, idx) =>
    idx === fragments.length - 1 ? `${indent}|${frag}|` : `${indent}|${frag} | &&`,
  );
}

/**
 * Wraps a long `emit_guard` `iv_detail` string via {@link wrapAbapTemplateLines} and closes the
 * `emit_guard( iv_reason = '...' iv_detail = ... )` call. Caller pushes the `iv_reason` line
 * first, then the result of this call.
 */
function emitWrappedGuardDetail(text: string, indent: string, what: string): string[] {
  const wrapped = wrapAbapTemplateLines(text, indent, what);
  wrapped[wrapped.length - 1] += " ).";
  return wrapped;
}

/**
 * The three X-flags, always the literal `'X'`, never conditional. `CONFIG_TYPE` is `NUMC(2)`, so
 * the legitimate value `'00'` satisfies `IS INITIAL` — a wrapper that set `x_config_type` only
 * when the value "looked set" would silently take a GENERIC lock covering every `CONFIG_TYPE` of
 * that `CONFIG_ID` (observed live, blocked another session's types `10`/`99`). No condition, no
 * ternary, no `IS INITIAL` test anywhere in the ABAP this module generates.
 */
function xFlagLines(indent: string): string[] {
  return [
    `${indent}    x_config_id   = 'X'`,
    `${indent}    x_config_type = 'X'`,
    `${indent}    x_config_var  = 'X'`,
  ];
}

/**
 * `config_id` as an ABAP operand: a quoted, validated literal, or (self-probe only) a runtime
 * variable name. The expression branch takes no caller data, so bypassing {@link abapLiteral}
 * there bypasses no injection defence.
 */
function configIdOperand(key: AbapLockKeyOperand): string {
  return key.configIdExpr ?? `'${abapLiteral(key.configId, "config_id")}'`;
}

function keyLines(indent: string, key: AbapLockKeyOperand): string[] {
  return [
    `${indent}    config_id     = ${configIdOperand(key)}`,
    `${indent}    config_type   = '${abapLiteral(key.configType, "config_type")}'`,
    `${indent}    config_var    = '${abapLiteral(key.configVar, "config_var")}'`,
  ];
}

/**
 * An `ENQUEUE_E_WDY_CONF*` call. No `MODE_*` parameter is passed, on purpose: the spike names the
 * mode parameter for CONFAPPL but not CONFCOMP, so half of any value written here would be a
 * guessed identifier — and the default (`'E'`, exclusive) is already the mode wanted. `_SCOPE`
 * comes from {@link FPM_LOCK_SCOPE}, the same constant the matching dequeue uses. `_WAIT` and
 * `_COLLECT` are left at their defaults too.
 */
function enqueueCall(
  indent: string,
  fm: string,
  key: AbapLockKeyOperand,
  subrcVar: string,
): string[] {
  const lines: string[] = [];
  lines.push(`${indent}CALL FUNCTION '${fm}'`);
  lines.push(`${indent}  EXPORTING`);
  lines.push(`${indent}    _scope        = '${FPM_LOCK_SCOPE}'`);
  lines.push(...keyLines(indent, key));
  lines.push(...xFlagLines(indent));
  lines.push(`${indent}  EXCEPTIONS`);
  lines.push(`${indent}    foreign_lock   = 1`);
  lines.push(`${indent}    system_failure = 2`);
  lines.push(`${indent}    OTHERS         = 3.`);
  lines.push(`${indent}${subrcVar} = sy-subrc.`);
  return lines;
}

/**
 * A `DEQUEUE_E_WDY_CONF*` call. Three spike findings shape this:
 *  - the X-flag shape MIRRORS the enqueue exactly (same {@link xFlagLines}) — a precise-shaped
 *    dequeue provably cannot release a generic lock;
 *  - `_SCOPE` is the SAME {@link FPM_LOCK_SCOPE} constant the enqueue used — enqueue `'2'` /
 *    dequeue `'1'` was observed NOT releasing while still returning `subrc = 0`;
 *  - there is NO `EXCEPTIONS` clause (the FM declares none); the captured `sy-subrc` is narration
 *    only, labelled `note=[subrc-is-not-evidence]` in the transcript.
 */
function dequeueCall(
  indent: string,
  fm: string,
  key: AbapLockKeyOperand,
  subrcVar: string,
): string[] {
  const lines: string[] = [];
  lines.push(`${indent}CALL FUNCTION '${fm}'`);
  lines.push(`${indent}  EXPORTING`);
  lines.push(`${indent}    _scope        = '${FPM_LOCK_SCOPE}'`);
  lines.push(...keyLines(indent, key));
  lines.push(...xFlagLines(indent));
  lines.push(`${indent}    .`);
  lines.push(`${indent}${subrcVar} = sy-subrc.`);
  return lines;
}

function gargBuildLines(indent: string, target: string, key: AbapLockKeyOperand): string[] {
  const [idFrom] = GARG_SEGMENTS.configId;
  const [typeFrom] = GARG_SEGMENTS.configType;
  const [varFrom] = GARG_SEGMENTS.configVar;
  return [
    `${indent}CLEAR ${target}.`,
    `${indent}${target}+${idFrom}(${CONFIG_ID_LEN})   = ${configIdOperand(key)}.`,
    `${indent}${target}+${typeFrom}(${CONFIG_TYPE_LEN})  = '${abapLiteral(key.configType, "config_type")}'.`,
    `${indent}${target}+${varFrom}(${CONFIG_VAR_LEN})  = '${abapLiteral(key.configVar, "config_var")}'.`,
  ];
}

/** The `DATA` block {@link selfIdentifyLines} needs; kept next to its consumer so they cannot drift. */
function selfIdentifyDataLines(indent: string): string[] {
  return [
    `${indent}DATA lv_lk_self     TYPE seqg3-gusr.`,
    `${indent}DATA lv_lk_selfone  TYPE seqg3-gusr.`,
    `${indent}DATA lv_lk_selfok   TYPE c LENGTH 1 VALUE '-'.`,
    `${indent}DATA lv_lk_selfbad  TYPE c LENGTH 1 VALUE '-'.`,
    `${indent}DATA lv_lk_selfsub  TYPE sy-subrc.`,
    `${indent}DATA lv_lk_selfgarg TYPE seqg3-garg.`,
    `${indent}DATA lv_lk_selfid   TYPE c LENGTH ${CONFIG_ID_LEN}.`,
    `${indent}DATA lv_lk_selfuid  TYPE c LENGTH 32.`,
    `${indent}DATA lv_lk_selfleft TYPE i.`,
    `${indent}DATA lt_lk_self     TYPE tt_enq.`,
    `${indent}DATA ls_lk_self     TYPE seqg3.`,
    // Declared here, not inline in CATCH: the block emits once per lock object, so an inline
    // DATA(..) here would be a duplicate declaration on the second iteration.
    `${indent}DATA lx_lk_self     TYPE REF TO cx_root.`,
  ];
}

/**
 * Self-identification: mint a per-run throwaway key, lock it, read the owner id back, release,
 * prove the release. Four fixed defects are load-bearing here:
 *  - **R1**: probe id is a per-run UUID ({@link SELF_PROBE_ID_VAR}) — a module-global constant
 *    made concurrent sessions collide on the same probe, and the loser refused every locked op.
 *  - **R2**: an empty learned owner id is treated as "not learned" (`ok=[-]`, all UNKNOWN),
 *    because `GUSR` is blank on every `_SCOPE = '2'` lock and would otherwise match everything.
 *  - **header item (g)**: the probe runs once per lock object; if two objects hand back different
 *    owner ids for this session, the learned id is discarded rather than assumed portable.
 *  - **D2**: a probe that failed to enqueue, or read back no owner id, used to silently fall
 *    through leaving an EARLIER object's `lv_lk_selfok = 'X'` in place, wrongly marking this
 *    object's rows MINE. Both paths now raise `GUARD` and set `lv_lk_selfbad`, forcing UNKNOWN.
 *
 * Dequeue `subrc` is not evidence here either: the probe is re-read afterward and a survivor
 * raises a `GUARD`.
 */
function selfIdentifyLines(indent: string, kinds: readonly FpmLockObjectKind[]): string[] {
  const lines: string[] = [];
  lines.push(`${indent}" ---- self-identify -------------------------------------------------`);
  lines.push(`${indent}" GUSR is the ONLY discriminator between our lock and a foreign lock`);
  lines.push(`${indent}" held by the SAME SAP user in another session: GUNAME is identical in`);
  lines.push(`${indent}" both and GTCODE is empty in both. The only way to learn our own is to`);
  lines.push(`${indent}" take a throwaway lock on a key that is not, and never will be, a real`);
  lines.push(`${indent}" configuration, and read the owner id straight back off it.`);
  lines.push(`${indent}"`);
  lines.push(`${indent}" The probe key is minted HERE, at runtime, once per execution. A fixed`);
  lines.push(`${indent}" one is a self-inflicted denial of service: two sessions probing at the`);
  lines.push(`${indent}" same moment fight over the SAME throwaway lock, and the loser then`);
  lines.push(`${indent}" refuses every locked operation it was asked to perform. Being minted`);
  lines.push(`${indent}" on the server it carries no caller input, so there is nothing here to`);
  lines.push(`${indent}" inject through - the usual quoting rules simply do not apply to it.`);
  lines.push(`${indent}" Unverified idiom (not covered by the lock spike): if create_uuid_c32_static`);
  lines.push(`${indent}" is absent here, activation fails loudly rather than silently reusing a`);
  lines.push(`${indent}" shared key.`);
  lines.push(`${indent}lv_lk_selfuid = cl_system_uuid=>create_uuid_c32_static( ).`);
  lines.push(
    `${indent}CONCATENATE '${SELF_PROBE_ID_STEM}' lv_lk_selfuid(${SELF_PROBE_ID_ENTROPY_LEN}) INTO lv_lk_selfid.`,
  );
  lines.push(...gargBuildLines(indent, "lv_lk_selfgarg", SELF_PROBE));

  for (const kind of kinds) {
    const obj = FPM_LOCK_OBJECTS[kind];
    lines.push(`${indent}" probe ${obj.lockObject} - one probe per lock object we are about to`);
    lines.push(`${indent}" read, because "the owner id is the same on every lock object" is an`);
    lines.push(`${indent}" INFERENCE the spike never tested. Below it is checked instead.`);
    lines.push(`${indent}CLEAR lv_lk_selfone.`);
    lines.push(...enqueueCall(indent, obj.enqueueFm, SELF_PROBE, "lv_lk_selfsub"));
    lines.push(`${indent}IF lv_lk_selfsub = 0.`);
    lines.push(`${indent}  " We are now HOLDING the probe lock. Everything between here and the`);
    lines.push(`${indent}  " DEQUEUE below runs inside its own TRY: an exception raised in the`);
    lines.push(`${indent}  " read-back would otherwise unwind straight to the single TRY in`);
    lines.push(`${indent}  " main, skipping this release - and the probe block is emitted once`);
    lines.push(`${indent}  " PER LOCK OBJECT, so it would strand this iteration-s lock and then`);
    lines.push(`${indent}  " never reach the next one-s either. A stranded lock is not swept up`);
    lines.push(`${indent}  " when the request ends (09-LOCK-DISCIPLINE-SPIKE-AUDIT.md), so the`);
    lines.push(`${indent}  " release has to be reached on every path, including this one.`);
    lines.push(`${indent}  TRY.`);
    lines.push(
      `${indent}      read_locks( EXPORTING iv_gname = '${obj.gname}' iv_garg = lv_lk_selfgarg IMPORTING et_enq = lt_lk_self ).`,
    );
    lines.push(`${indent}      LOOP AT lt_lk_self INTO ls_lk_self.`);
    lines.push(`${indent}        IF ls_lk_self-garg = lv_lk_selfgarg.`);
    lines.push(`${indent}          " A BLANK owner id is not an owner id. GUSR is blank on every`);
    lines.push(`${indent}          " update-task-slot lock, so accepting a blank here would make`);
    lines.push(`${indent}          " every one of those compare equal to "ours" further down.`);
    lines.push(`${indent}          IF ls_lk_self-gusr <> space.`);
    lines.push(`${indent}            lv_lk_selfone = ls_lk_self-gusr.`);
    lines.push(`${indent}          ENDIF.`);
    lines.push(`${indent}          EXIT.`);
    lines.push(`${indent}        ENDIF.`);
    lines.push(`${indent}      ENDLOOP.`);
    lines.push(`${indent}      IF lv_lk_selfone <> space.`);
    lines.push(`${indent}        IF lv_lk_selfok = 'X'.`);
    lines.push(`${indent}          IF lv_lk_selfone <> lv_lk_self.`);
    lines.push(`${indent}            " Two lock objects, two different owner ids for one session:`);
    lines.push(`${indent}            " the portability inference is false here. Fail closed.`);
    lines.push(`${indent}            lv_lk_selfbad = 'X'.`);
    lines.push(`${indent}          ENDIF.`);
    lines.push(`${indent}        ELSE.`);
    lines.push(`${indent}          lv_lk_self   = lv_lk_selfone.`);
    lines.push(`${indent}          lv_lk_selfok = 'X'.`);
    lines.push(`${indent}        ENDIF.`);
    lines.push(`${indent}      ELSE.`);
    lines.push(`${indent}        " The probe held the lock but produced NO usable owner id for this`);
    lines.push(`${indent}        " lock object: either the read-back found no row for the probe GARG`);
    lines.push(`${indent}        " or GUSR came back blank. Nothing was verified HERE, and an id`);
    lines.push(`${indent}        " learned from a PREVIOUS lock object's probe must not be reused to`);
    lines.push(`${indent}        " label this object's rows MINE - that is exactly the untested`);
    lines.push(`${indent}        " cross-lock-object portability inference (header item (g)). Throw`);
    lines.push(`${indent}        " the id away: an unverified probe forces UNKNOWN, never MINE.`);
    lines.push(`${indent}        lv_lk_selfbad = 'X'.`);
    lines.push(
      `${indent}        emit_guard( iv_reason = 'self-probe-owner-id-blank' iv_detail = |the throwaway self-probe on ${obj.lockObject} returned no usable GUSR, so no row on this lock object can be proved ours| ).`,
    );
    lines.push(`${indent}      ENDIF.`);
    lines.push(`${indent}    CATCH cx_root INTO lx_lk_self.`);
    lines.push(`${indent}      " Nothing was verified on this lock object, so the learned id is`);
    lines.push(`${indent}      " discarded exactly as for a failed probe: an unverified probe`);
    lines.push(`${indent}      " forces UNKNOWN, never MINE. Control falls through to the DEQUEUE.`);
    lines.push(`${indent}      lv_lk_selfbad = 'X'.`);
    lines.push(
      `${indent}      emit_guard( iv_reason = 'self-probe-exception' iv_detail = |the throwaway self-probe on ${obj.lockObject} raised { cl_abap_classdescr=>get_class_name( lx_lk_self ) }: { lx_lk_self->get_text( ) } - the probe lock is released below regardless| ).`,
    );
    lines.push(`${indent}  ENDTRY.`);
    lines.push(...dequeueCall(`${indent}  `, obj.dequeueFm, SELF_PROBE, "lv_lk_selfsub"));
    lines.push(`${indent}  " The dequeue subrc is narration, here as everywhere: it is 0 even`);
    lines.push(`${indent}  " when nothing was released. Re-read the probe key and say so if it`);
    lines.push(`${indent}  " survived.`);
    lines.push(
      `${indent}  read_locks( EXPORTING iv_gname = '${obj.gname}' iv_garg = lv_lk_selfgarg IMPORTING et_enq = lt_lk_self ).`,
    );
    lines.push(`${indent}  lv_lk_selfleft = lines( lt_lk_self ).`);
    lines.push(`${indent}  IF lv_lk_selfleft > 0.`);
    lines.push(
      `${indent}    emit_guard( iv_reason = 'self-probe-not-released' iv_detail = |the throwaway self-probe lock on ${obj.lockObject} survived its DEQUEUE, rows={ lv_lk_selfleft }| ).`,
    );
    lines.push(`${indent}  ENDIF.`);
    lines.push(`${indent}ELSE.`);
    lines.push(`${indent}  " The probe's OWN enqueue failed on this lock object. Silently doing`);
    lines.push(`${indent}  " nothing here was a fail-OPEN bug: lv_lk_selfok would still carry`);
    lines.push(`${indent}  " 'X' from an earlier lock object's probe, and every row of THIS`);
    lines.push(`${indent}  " lock object would then be compared against an id that was never`);
    lines.push(`${indent}  " verified for it - producing MINE on somebody else's lock. A probe`);
    lines.push(`${indent}  " that did not succeed must force UNKNOWN.`);
    lines.push(`${indent}  lv_lk_selfbad = 'X'.`);
    lines.push(
      `${indent}  emit_guard( iv_reason = 'self-probe-enqueue-failed' iv_detail = |ENQUEUE on ${obj.lockObject} for the throwaway self-probe returned subrc={ lv_lk_selfsub }, so this session-s owner id is unverified here| ).`,
    );
    lines.push(`${indent}ENDIF.`);
  }

  lines.push(`${indent}IF lv_lk_selfbad = 'X'.`);
  lines.push(`${indent}  CLEAR lv_lk_self.`);
  lines.push(`${indent}  lv_lk_selfok = '-'.`);
  lines.push(
    `${indent}  emit_guard( iv_reason = 'self-owner-id-not-portable' iv_detail = 'a probe either failed, returned no owner id, or disagreed with another lock object-s, so the learned id was discarded and no row can be proved ours' ).`,
  );
  lines.push(`${indent}ENDIF.`);
  lines.push(
    `${indent}mo_out->write( |${LOCK_LINE_PREFIX}SELF owner=[{ lv_lk_self }] ok=[{ lv_lk_selfok }]| ).`,
  );
  return lines;
}

// ---------------------------------------------------------------------------
// ABAP source generation — class shell
// ---------------------------------------------------------------------------

/**
 * The common class skeleton: the transcript helpers, the `ENQUEUE_READ`
 * wrapper (always `GUNAME = space` / `GCLIENT = space`) and the wildcard
 * detector, plus `main` wrapping `body`.
 */
function lockClassSource(className: string, what: string, body: string): string {
  const cls = assertPlainName(className, "Bridge class name").toLowerCase();
  return `CLASS ${cls} DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
  PRIVATE SECTION.
    TYPES tt_enq TYPE STANDARD TABLE OF seqg3 WITH DEFAULT KEY.
    "! Every character a GARG built from a validated key can legally contain.
    "! The blank sits in the MIDDLE because ABAP strips TRAILING blanks from a
    "! text literal — written at the end it would silently drop out of the set
    "! and every blank-padded GARG would look like a wildcard.
    CONSTANTS gc_legal TYPE string VALUE '${ABAP_LEGAL_GARG_CHARS}'.
    DATA mo_out TYPE REF TO if_oo_adt_classrun_out.
    "! ENQUEUE_READ with NO owner filter. Its GUNAME parameter DEFAULTS TO
    "! SY-UNAME and GCLIENT to SY-MANDT, so a naive call is blind to every
    "! other user's locks — which is the one thing this whole module exists to
    "! see. Filters are exact-match; blank means "no filter"; there is no
    "! prefix matching on GARG (GARGNOWC = 'X' changed nothing when probed).
    METHODS read_locks
      IMPORTING iv_gname TYPE seqg3-gname
                iv_garg  TYPE seqg3-garg
      EXPORTING et_enq   TYPE tt_enq.
    "! Comma-joined names of the GARG segments carrying wildcard fill; empty
    "! when the GARG is precise. REPORTING ONLY - it sweeps for "anything my
    "! own key charset cannot produce", which is deliberately broader than the
    "! fill the spike actually captured. Never use it to veto a write: see
    "! has_wildcard_fill.
    METHODS wildcard_segments
      IMPORTING iv_garg           TYPE seqg3-garg
      RETURNING VALUE(rv_segments) TYPE string.
    "! TRUE when the text carries the OBSERVED wildcard fill character U+FFFF
    "! (UTF-8 EF BF BF). This, not the gc_legal sweep, is what may veto a
    "! write: a FOREIGN config id can legitimately contain a character our own
    "! key validators would refuse, and reading that as wildcard fill would let
    "! an unrelated config block every write in the system.
    "! Unverified idiom (not covered by the lock spike): cl_abap_conv_in_ce is
    "! how U+FFFF is named without embedding a noncharacter in generated
    "! source. If it is absent here activation fails loudly.
    METHODS has_wildcard_fill
      IMPORTING iv_text        TYPE clike
      RETURNING VALUE(rv_wild) TYPE abap_bool.
    "! Narrows a raw ENQUEUE_READ result to the rows that can bear on ONE
    "! config id, BEFORE anything is written to the transcript: kept are an
    "! exact config_id-segment match and any row whose config_id segment is
    "! wildcard-filled (such a lock covers every config_id, ours included).
    "! Emitting whole unfiltered enqueue tables risks truncating the transcript
    "! and losing the trailing RELEASE verdict with it - and a report that
    "! cannot say whether the lock was released is worse than a long one.
    "! iv_keep_all = abap_true retains everything: see the caller comment about
    "! the INFERRED WDY_CONFIG_APPL GARG layout.
    METHODS filter_rows
      IMPORTING iv_config_id TYPE clike
                iv_keep_all  TYPE abap_bool
                it_enq       TYPE tt_enq
      EXPORTING et_enq       TYPE tt_enq.
    METHODS emit_rows
      IMPORTING iv_phase TYPE string
                it_enq   TYPE tt_enq.
    METHODS emit_guard
      IMPORTING iv_reason TYPE string
                iv_detail TYPE string.
ENDCLASS.

CLASS ${cls} IMPLEMENTATION.

  METHOD read_locks.
    DATA lv_lk_number TYPE i.
    DATA lv_lk_rsubrc TYPE sy-subrc.
    CLEAR et_enq.
    CALL FUNCTION 'ENQUEUE_READ'
      EXPORTING
        gclient               = space
        gname                 = iv_gname
        garg                  = iv_garg
        guname                = space
      IMPORTING
        number                = lv_lk_number
        subrc                 = lv_lk_rsubrc
      TABLES
        enq                   = et_enq
      EXCEPTIONS
        communication_failure = 1
        system_failure        = 2
        OTHERS                = 3.
    IF sy-subrc <> 0.
      CLEAR et_enq.
      mo_out->write( |${ERR_LINE_PREFIX}ENQUEUE_READ failed subrc={ sy-subrc } gname={ iv_gname }| ).
    ENDIF.
  ENDMETHOD.

  METHOD wildcard_segments.
    DATA lv_lk_g TYPE c LENGTH ${GARG_LENGTH}.
    lv_lk_g = iv_garg.
    CLEAR rv_segments.
*   CN = "contains not only": true as soon as one character falls outside the
*   legal set. That catches the OBSERVED U+FFFF fill without this class ever
*   having to name the code point, and catches any other fill too.
    IF lv_lk_g+${GARG_SEGMENTS.configId[0]}(${CONFIG_ID_LEN}) CN gc_legal.
      rv_segments = 'configId'.
    ENDIF.
    IF lv_lk_g+${GARG_SEGMENTS.configType[0]}(${CONFIG_TYPE_LEN}) CN gc_legal.
      IF strlen( rv_segments ) > 0.
        rv_segments = rv_segments && ','.
      ENDIF.
      rv_segments = rv_segments && 'configType'.
    ENDIF.
    IF lv_lk_g+${GARG_SEGMENTS.configVar[0]}(${CONFIG_VAR_LEN}) CN gc_legal.
      IF strlen( rv_segments ) > 0.
        rv_segments = rv_segments && ','.
      ENDIF.
      rv_segments = rv_segments && 'configVar'.
    ENDIF.
    IF lv_lk_g+${GARG_TAIL_OFFSET} CN gc_legal.
      IF strlen( rv_segments ) > 0.
        rv_segments = rv_segments && ','.
      ENDIF.
      rv_segments = rv_segments && 'tail'.
    ENDIF.
  ENDMETHOD.

  METHOD has_wildcard_fill.
    DATA lv_lk_fc TYPE c LENGTH 1.
    rv_wild = abap_false.
*   U+FFFF, the fill the spike actually captured (EF BF BF in UTF-8) - NOT
*   0xFF, and NOT "any character I would not have written myself".
    lv_lk_fc = cl_abap_conv_in_ce=>uccp( 'FFFF' ).
    IF iv_text CS lv_lk_fc.
      rv_wild = abap_true.
    ENDIF.
  ENDMETHOD.

  METHOD filter_rows.
    DATA lv_lk_fid TYPE c LENGTH ${CONFIG_ID_LEN}.
    CLEAR et_enq.
    LOOP AT it_enq INTO DATA(ls_lk_f).
      IF iv_keep_all = abap_true.
        APPEND ls_lk_f TO et_enq.
        CONTINUE.
      ENDIF.
      lv_lk_fid = ls_lk_f-garg+${GARG_SEGMENTS.configId[0]}(${CONFIG_ID_LEN}).
      IF lv_lk_fid = iv_config_id.
        APPEND ls_lk_f TO et_enq.
      ELSEIF has_wildcard_fill( lv_lk_fid ) = abap_true.
*       A wildcard-filled config_id segment covers every config_id, ours too.
        APPEND ls_lk_f TO et_enq.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD emit_rows.
    DATA lv_lk_wc TYPE string.
    LOOP AT it_enq INTO DATA(ls_lk_e).
      mo_out->write( |${LOCK_LINE_PREFIX}ROW phase=[{ iv_phase }] gname=[{ ls_lk_e-gname }] | &&
        |garg=[{ ls_lk_e-garg }] gmode=[{ ls_lk_e-gmode }] guname=[{ ls_lk_e-guname }] | &&
        |gclient=[{ ls_lk_e-gclient }] gusr=[{ ls_lk_e-gusr }] gusrvb=[{ ls_lk_e-gusrvb }] | &&
        |guse=[{ ls_lk_e-guse }] gusevb=[{ ls_lk_e-gusevb }] gobj=[{ ls_lk_e-gobj }]| ).
      lv_lk_wc = wildcard_segments( ls_lk_e-garg ).
      IF strlen( lv_lk_wc ) > 0.
*       Emitted as its own line so the TS side never has to depend on a raw
*       U+FFFF surviving the HTTP/UTF-8 round trip to know a wildcard is there.
        mo_out->write( |${LOCK_LINE_PREFIX}WILDCARD phase=[{ iv_phase }] garg=[{ ls_lk_e-garg }] segments=[{ lv_lk_wc }]| ).
      ENDIF.
    ENDLOOP.
    mo_out->write( |${LOCK_LINE_PREFIX}COUNT phase=[{ iv_phase }] rows=[{ lines( it_enq ) }]| ).
  ENDMETHOD.

  METHOD emit_guard.
    mo_out->write( |${LOCK_LINE_PREFIX}GUARD reason=[{ iv_reason }] detail=[{ iv_detail }]| ).
  ENDMETHOD.

  METHOD if_oo_adt_classrun~main.
*   Generated by abapsmith (${what}). Do not edit — this class is regenerated
*   from src/adt/fpm-lock.ts whenever its content hash changes.
    mo_out = out.
    TRY.
${body}
      CATCH cx_root INTO DATA(lx).
        out->write( |${ERR_LINE_PREFIX}EXCEPTION { cl_abap_classdescr=>get_class_name( lx ) }: { lx->get_text( ) }| ).
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
`;
}

// ---------------------------------------------------------------------------
// ABAP source generation — inspect (`mode: "locks"`)
// ---------------------------------------------------------------------------

/**
 * A read-only point-in-time lock report. Takes no lock on the caller's config — the only enqueue
 * it performs is the throwaway {@link SELF_PROBE}, which is what makes MINE/FOREIGN meaningful.
 *
 * No `GARG` filter is ever sent to `ENQUEUE_READ`, even when `configType` is known: `GARG`
 * filtering is exact-match over all 150 characters, so a wildcard lock (U+FFFF where key segments
 * should be) can never match a precise query `GARG` and would be hidden by server-side filtering.
 * Instead this reads unfiltered and narrows client-side on the `config_id` segment, keeping any
 * row whose segment is wildcard-filled unconditionally (module header item (b): exact-match is
 * inferred, not observed on the wire — reading unfiltered sidesteps that uncertainty entirely).
 */
export function buildLockInspectSource(q: FpmLockInspectQuery, className: string): string {
  const { configId, configType, configVar } = validateInspectQuery(q);
  const kinds: FpmLockObjectKind[] =
    configType === undefined ? ["component", "application"] : [lockKindForConfigType(configType)];

  const inspectsAppl = kinds.includes("application");

  const i = "      ";
  const lines: string[] = [];
  lines.push(...selfIdentifyDataLines(i));
  lines.push(`${i}DATA lt_lk_all      TYPE tt_enq.`);
  lines.push(`${i}DATA lt_lk_read     TYPE tt_enq.`);
  lines.push(`${i}DATA lt_lk_keep     TYPE tt_enq.`);
  lines.push(`${i}DATA ls_lk_r        TYPE seqg3.`);
  lines.push(`${i}DATA lv_lk_cfgid    TYPE c LENGTH ${CONFIG_ID_LEN}.`);
  lines.push(`${i}DATA lv_lk_idseg    TYPE c LENGTH ${CONFIG_ID_LEN}.`);
  lines.push(`${i}DATA lv_lk_tyseg    TYPE c LENGTH ${CONFIG_TYPE_LEN}.`);
  lines.push(`${i}DATA lv_lk_vrseg    TYPE c LENGTH ${CONFIG_VAR_LEN}.`);
  lines.push(`${i}DATA lv_lk_keep     TYPE c LENGTH 1.`);
  lines.push(`${i}DATA lv_lk_infer    TYPE c LENGTH 1.`);
  lines.push(`${i}DATA lv_lk_apflg    TYPE c LENGTH 1 VALUE '-'.`);
  lines.push(`${i}DATA lv_lk_aptr     TYPE c LENGTH 1 VALUE '-'.`);
  lines.push(`${i}DATA lv_lk_apn      TYPE i.`);
  lines.push(``);
  // One self-probe per lock object about to be read (header item (g)).
  lines.push(...selfIdentifyLines(i, kinds.length > 0 ? kinds : ["component"]));
  lines.push(``);
  lines.push(`${i}" ---- read every lock on the governing lock object(s) ---------------`);
  for (const kind of kinds) {
    const obj = FPM_LOCK_OBJECTS[kind];
    lines.push(`${i}CLEAR lt_lk_read.`);
    lines.push(`${i}read_locks( EXPORTING iv_gname = '${obj.gname}' iv_garg = space IMPORTING et_enq = lt_lk_read ).`);
    lines.push(`${i}APPEND LINES OF lt_lk_read TO lt_lk_all.`);
  }
  lines.push(``);
  lines.push(`${i}lv_lk_cfgid = '${abapLiteral(configId, "config_id")}'.`);
  lines.push(`${i}LOOP AT lt_lk_all INTO ls_lk_r.`);
  lines.push(`${i}  lv_lk_keep  = '-'.`);
  lines.push(`${i}  lv_lk_infer = '-'.`);
  if (inspectsAppl) {
    lines.push(`${i}  IF ls_lk_r-gname = '${FPM_LOCK_OBJECTS.application.gname}'.`);
    lines.push(`${i}    " INFERRED / UNTESTED (header item (f)): the 0/32/34/40 GARG layout`);
    lines.push(`${i}    " was captured for E_WDY_CONFCOMP ONLY. On WDY_CONFIG_APPL EVERY`);
    lines.push(`${i}    " slice below is an assumption - INCLUDING one that appears to match,`);
    lines.push(`${i}    " because a matching bytes-0-31 slice under a wrong layout is still a`);
    lines.push(`${i}    " guess. Marking the row inferred HERE, before the match test, is what`);
    lines.push(`${i}    " stops the config_type / config_var narrowing further down from`);
    lines.push(`${i}    " dropping the single most relevant application row in the report.`);
    lines.push(`${i}    lv_lk_infer = 'X'.`);
    lines.push(`${i}    " Skipping that narrowing is a real change to what the caller asked`);
    lines.push(`${i}    " for, so the report says it out loud rather than quietly widening.`);
    lines.push(`${i}    lv_lk_apflg = 'X'.`);
    lines.push(`${i}  ENDIF.`);
  }
  lines.push(`${i}  lv_lk_idseg = ls_lk_r-garg+${GARG_SEGMENTS.configId[0]}(${CONFIG_ID_LEN}).`);
  lines.push(`${i}  IF lv_lk_idseg = lv_lk_cfgid.`);
  lines.push(`${i}    lv_lk_keep = 'X'.`);
  lines.push(`${i}  ELSEIF has_wildcard_fill( lv_lk_idseg ) = abap_true.`);
  lines.push(`${i}    " wildcard in the config_id segment: it covers our config_id too.`);
  lines.push(`${i}    lv_lk_keep = 'X'.`);
  if (inspectsAppl) {
    lines.push(`${i}  ELSEIF ls_lk_r-gname = '${FPM_LOCK_OBJECTS.application.gname}'.`);
    lines.push(`${i}    " INFERRED / UNTESTED: the spike captured a GARG layout for`);
    lines.push(`${i}    " E_WDY_CONFCOMP only. It never read one back from E_WDY_CONFAPPL,`);
    lines.push(`${i}    " so the slice just taken may not be this row-s config id at all,`);
    lines.push(`${i}    " and "did not match" may only mean "different layout".`);
    lines.push(`${i}    " Dropping it would delete a real lock from a lock report - the one`);
    lines.push(`${i}    " direction that gets somebody-s work overwritten. Keep it, mark the`);
    lines.push(`${i}    " report, and let a human see a row we could not parse.`);
    lines.push(`${i}    " BUT NOT WITHOUT A CEILING: this keep is unbounded in the enqueue`);
    lines.push(`${i}    " table-s size, and an over-long transcript is truncated from the END,`);
    lines.push(`${i}    " which silently drops rows and the trailing verdict with them. Cap it`);
    lines.push(`${i}    " and SAY when the cap bit, rather than trading a silent drop here for`);
    lines.push(`${i}    " a silent drop one layer up.`);
    lines.push(`${i}    IF lv_lk_apn < ${MAX_INFERRED_APPL_ROWS}.`);
    lines.push(`${i}      lv_lk_apn   = lv_lk_apn + 1.`);
    lines.push(`${i}      lv_lk_keep  = 'X'.`);
    lines.push(`${i}    ELSE.`);
    lines.push(`${i}      lv_lk_aptr  = 'X'.`);
    lines.push(`${i}    ENDIF.`);
  }
  lines.push(`${i}  ENDIF.`);
  if (configType !== undefined) {
    lines.push(`${i}  IF lv_lk_keep = 'X' AND lv_lk_infer = '-'.`);
    lines.push(`${i}    lv_lk_tyseg = ls_lk_r-garg+${GARG_SEGMENTS.configType[0]}(${CONFIG_TYPE_LEN}).`);
    lines.push(
      `${i}    IF lv_lk_tyseg <> '${abapLiteral(configType, "config_type")}'`,
    );
    lines.push(`${i}       AND has_wildcard_fill( lv_lk_tyseg ) = abap_false.`);
    lines.push(`${i}      lv_lk_keep = '-'.`);
    lines.push(`${i}    ENDIF.`);
    lines.push(`${i}  ENDIF.`);
  }
  if (configVar !== undefined) {
    lines.push(`${i}  IF lv_lk_keep = 'X' AND lv_lk_infer = '-'.`);
    lines.push(`${i}    lv_lk_vrseg = ls_lk_r-garg+${GARG_SEGMENTS.configVar[0]}(${CONFIG_VAR_LEN}).`);
    lines.push(
      `${i}    IF lv_lk_vrseg <> '${abapLiteral(configVar, "config_var")}'`,
    );
    lines.push(`${i}       AND has_wildcard_fill( lv_lk_vrseg ) = abap_false.`);
    lines.push(`${i}      lv_lk_keep = '-'.`);
    lines.push(`${i}    ENDIF.`);
    lines.push(`${i}  ENDIF.`);
  }
  lines.push(`${i}  IF lv_lk_keep = 'X'.`);
  lines.push(`${i}    APPEND ls_lk_r TO lt_lk_keep.`);
  lines.push(`${i}  ENDIF.`);
  lines.push(`${i}ENDLOOP.`);
  if (inspectsAppl) {
    lines.push(`${i}IF lv_lk_apflg = 'X'.`);
    // Was one unbroken `iv_detail = '...'` literal; landed at 408 chars, over the 255-char ADT
    // line ceiling, every time mode:"locks" inspected an application-scope config live. Now
    // wrapped via wrapAbapTemplateLines so this can't silently reoccur; wording unchanged.
    lines.push(`${i}  emit_guard( iv_reason = 'appl-garg-layout-inferred'`);
    lines.push(`${i}    iv_detail =`);
    lines.push(
      ...emitWrappedGuardDetail(
        "the GARG segment layout of E_WDY_CONFAPPL was never captured by the spike, so EVERY " +
          "WDY_CONFIG_APPL row here is treated as unparseable: rows whose id segment did not match " +
          "were RETAINED rather than dropped, and the config_type / config_var narrowing was SKIPPED " +
          "for all of them - some of the rows below may belong to another config",
        `${i}      `,
        "appl-garg-layout-inferred detail",
      ),
    );
    lines.push(`${i}ENDIF.`);
    lines.push(`${i}IF lv_lk_aptr = 'X'.`);
    // Same defect, same fix: this one landed at 261 chars — just over the ceiling, the shape of
    // overrun easiest to miss in review. Wording unchanged.
    lines.push(`${i}  emit_guard( iv_reason = 'appl-rows-truncated'`);
    lines.push(`${i}    iv_detail =`);
    lines.push(
      ...emitWrappedGuardDetail(
        `more than ${MAX_INFERRED_APPL_ROWS} WDY_CONFIG_APPL rows were kept only because that lock ` +
          "object-s GARG layout is inferred; the rest were dropped from this report, so it is NOT a " +
          "complete picture of E_WDY_CONFAPPL",
        `${i}      `,
        "appl-rows-truncated detail",
      ),
    );
    lines.push(`${i}ENDIF.`);
  }
  lines.push(`${i}emit_rows( iv_phase = 'inspect' it_enq = lt_lk_keep ).`);

  return lockClassSource(className, "abap_fpm_read, mode=locks", lines.join("\n"));
}

// ---------------------------------------------------------------------------
// ABAP source generation — the advisory-lock-safe locked operation
// ---------------------------------------------------------------------------

/**
 * The whole enforce-the-advisory-lock protocol as ONE classrun body: self-identify -> acquire ->
 * read back -> refuse on wildcard/foreign -> verify held AND ours -> body -> re-verify -> release
 * -> re-read -> report `released` | `still-held`.
 *
 * One classrun so acquire and release are the same unit of execution — locks can outlive the HTTP
 * request (module header), so a TypeScript callback between acquire/release would hold a real
 * lock across round trips it doesn't control and strand it on failure. The body runs inside its
 * own `TRY ... CATCH cx_root` so an exception can't jump over the `DEQUEUE`.
 *
 * The guard is structural, not procedural: the caller's body is lexically nested inside
 * `IF <held> AND <ours> AND NOT <wildcard>. ... ELSE. <GUARD>. ENDIF.`, evaluated immediately
 * below the read that produced those observations — no "verified" boolean, no path reaches the
 * body without the `IF` being true.
 */
export function buildLockedOperationSource(op: FpmLockedOperation, className: string): string {
  const key = op.key;
  const label = assertPlainName(op.bodyLabel, "bodyLabel");
  const body = assertLockBodyIsSafe(op.body, label);
  const obj = FPM_LOCK_OBJECTS[key.kind];
  const plain = { configId: key.configId, configType: key.configType, configVar: key.configVar };

  // D2: E_WDY_CONFAPPL's GARG layout was never captured, so on that lock object we must not
  // filter on a sliced config_id segment — a wrong slice would silently drop a real foreign lock.
  const gargLayoutIsInferred = key.kind === "application";
  const keepAll = gargLayoutIsInferred ? "abap_true" : "abap_false";

  const i = "      ";
  const lines: string[] = [];
  lines.push(...selfIdentifyDataLines(i));
  lines.push(`${i}DATA lv_lk_garg     TYPE seqg3-garg.`);
  lines.push(`${i}DATA lv_lk_cfgid    TYPE c LENGTH ${CONFIG_ID_LEN}.`);
  lines.push(`${i}DATA lv_lk_subrc    TYPE sy-subrc.`);
  lines.push(`${i}DATA lv_lk_deqsub   TYPE sy-subrc.`);
  lines.push(`${i}DATA lv_lk_exc      TYPE string.`);
  lines.push(`${i}DATA lt_lk_raw      TYPE tt_enq.`);
  lines.push(`${i}DATA lt_lk_rows     TYPE tt_enq.`);
  lines.push(`${i}DATA lt_lk_after    TYPE tt_enq.`);
  lines.push(`${i}DATA ls_lk_v        TYPE seqg3.`);
  lines.push(`${i}DATA ls_lk_a        TYPE seqg3.`);
  lines.push(`${i}DATA lv_lk_held     TYPE c LENGTH 1.`);
  lines.push(`${i}DATA lv_lk_mine     TYPE c LENGTH 1.`);
  lines.push(`${i}DATA lv_lk_wild     TYPE c LENGTH 1.`);
  lines.push(`${i}DATA lv_lk_pass     TYPE c LENGTH 1.`);
  lines.push(`${i}DATA lv_lk_bodyexc  TYPE c LENGTH 1 VALUE '-'.`);
  lines.push(`${i}DATA lv_lk_rel      TYPE c LENGTH 1.`);
  lines.push(`${i}DATA lv_lk_vid      TYPE c LENGTH ${CONFIG_ID_LEN}.`);
  lines.push(`${i}DATA lv_lk_left     TYPE i.`);
  lines.push(``);
  lines.push(...selfIdentifyLines(i, [key.kind]));
  lines.push(``);
  lines.push(`${i}lv_lk_cfgid = '${abapLiteral(key.configId, "config_id")}'.`);
  lines.push(...gargBuildLines(i, "lv_lk_garg", plain));
  lines.push(``);
  lines.push(`${i}" ---- acquire ------------------------------------------------------`);
  lines.push(...enqueueCall(i, obj.enqueueFm, plain, "lv_lk_subrc"));
  lines.push(`${i}lv_lk_exc = 'none'.`);
  lines.push(`${i}IF lv_lk_subrc = 1.`);
  lines.push(`${i}  lv_lk_exc = 'foreign_lock'.`);
  lines.push(`${i}ELSEIF lv_lk_subrc = 2.`);
  lines.push(`${i}  lv_lk_exc = 'system_failure'.`);
  lines.push(`${i}ELSEIF lv_lk_subrc > 2.`);
  lines.push(`${i}  lv_lk_exc = 'system_failure'.`);
  lines.push(`${i}ENDIF.`);
  lines.push(
    `${i}mo_out->write( |${LOCK_LINE_PREFIX}ENQ fm=[${obj.enqueueFm}] subrc=[{ lv_lk_subrc }] exc=[{ lv_lk_exc }] scope=[${FPM_LOCK_SCOPE}]| ).`,
  );
  lines.push(``);
  lines.push(`${i}IF lv_lk_subrc = 0.`);
  lines.push(`${i}  " ---- read back ---------------------------------------------------`);
  lines.push(`${i}  " The read is deliberately unfiltered (ENQUEUE_READ narrows by exact`);
  lines.push(`${i}  " GARG only, so it cannot find the wildcard rows we must veto on), but`);
  lines.push(`${i}  " what we EMIT is narrowed to our config_id: on a busy system the full`);
  lines.push(`${i}  " enqueue table is unbounded, and a truncated transcript loses the`);
  lines.push(`${i}  " trailing RELEASE line — the one line that says whether we let go.`);
  lines.push(
    `${i}  read_locks( EXPORTING iv_gname = '${obj.gname}' iv_garg = space IMPORTING et_enq = lt_lk_raw ).`,
  );
  lines.push(
    `${i}  filter_rows( EXPORTING iv_config_id = lv_lk_cfgid iv_keep_all = ${keepAll} it_enq = lt_lk_raw IMPORTING et_enq = lt_lk_rows ).`,
  );
  lines.push(`${i}  emit_rows( iv_phase = 'after-acquire' it_enq = lt_lk_rows ).`);
  lines.push(...verifyLines(`${i}  `, "presave", key.kind));
  lines.push(``);
  lines.push(`${i}  " ---- the caller's body, and it is NOT REACHABLE otherwise ---------`);
  lines.push(`${i}  " The body is nested inside this IF. There is no flag consulted`);
  lines.push(`${i}  " later, no fallthrough and no ELSE branch that continues into it —`);
  lines.push(`${i}  " a failed verify can only reach the GUARD.`);
  lines.push(`${i}  IF lv_lk_held = 'X' AND lv_lk_mine = 'X' AND lv_lk_wild = '-'.`);
  lines.push(`${i}    mo_out->write( |${LOCK_LINE_PREFIX}BODY label=[${label}] state=[begin]| ).`);
  lines.push(`${i}    " The body gets its OWN TRY. assertLockBodyIsSafe bans RETURN/EXIT/`);
  lines.push(`${i}    " LEAVE/STOP/CHECK, but it cannot ban RAISE, MESSAGE ... RAISING or a`);
  lines.push(`${i}    " runtime dump, and an exception here would unwind to the single TRY in`);
  lines.push(`${i}    " main - skipping the DEQUEUE and the whole release/verify block below.`);
  lines.push(`${i}    " There is no request-end sweep to fall back on: locks CAN outlive the`);
  lines.push(`${i}    " HTTP request, so that would be a leaked lock. Catching here makes the`);
  lines.push(`${i}    " release unconditional.`);
  lines.push(`${i}    TRY.`);
  for (const bodyLine of body.split("\n")) {
    lines.push(`${i}        ${bodyLine}`);
  }
  lines.push(`${i}        mo_out->write( |${LOCK_LINE_PREFIX}BODY label=[${label}] state=[end]| ).`);
  lines.push(`${i}      CATCH cx_root INTO DATA(lx_lk_body).`);
  lines.push(`${i}        " No state=[end] line: the body did NOT complete. The flag below`);
  lines.push(`${i}        " suppresses only the post-body PASS gate - the release, the`);
  lines.push(`${i}        " re-read, the survivor count and the RELEASE verdict all still run.`);
  lines.push(`${i}        lv_lk_bodyexc = 'X'.`);
  lines.push(
    `${i}        emit_guard( iv_reason = 'body-exception' iv_detail = |the body raised { cl_abap_classdescr=>get_class_name( lx_lk_body ) }: { lx_lk_body->get_text( ) } - it did not complete, and the lock is released below regardless| ).`,
  );
  lines.push(`${i}    ENDTRY.`);
  lines.push(``);
  lines.push(`${i}    " ---- did we still hold it the whole way through? ---------------`);
  lines.push(
    `${i}    read_locks( EXPORTING iv_gname = '${obj.gname}' iv_garg = space IMPORTING et_enq = lt_lk_raw ).`,
  );
  lines.push(
    `${i}    filter_rows( EXPORTING iv_config_id = lv_lk_cfgid iv_keep_all = ${keepAll} it_enq = lt_lk_raw IMPORTING et_enq = lt_lk_rows ).`,
  );
  lines.push(`${i}    emit_rows( iv_phase = 'postbody' it_enq = lt_lk_rows ).`);
  lines.push(...verifyLines(`${i}    `, "postbody", key.kind));
  lines.push(`${i}    " Skipped when the body raised: 'lock-lost-during-body' would be a`);
  lines.push(`${i}    " second, misleading verdict on top of the body-exception GUARD that`);
  lines.push(`${i}    " already said what happened. The VERIFY line above is still emitted.`);
  lines.push(`${i}    IF lv_lk_bodyexc = '-' AND lv_lk_pass = '-'.`);
  lines.push(
    `${i}      emit_guard( iv_reason = 'lock-lost-during-body' iv_detail = 'the lock was not verifiably ours after the body ran; the body cannot be un-run' ).`,
  );
  lines.push(`${i}    ENDIF.`);
  lines.push(`${i}  ELSE.`);
  lines.push(
    `${i}    emit_guard( iv_reason = 'presave-verify-failed' iv_detail = |held={ lv_lk_held } mine={ lv_lk_mine } wildcard={ lv_lk_wild } - refusing to run the body| ).`,
  );
  lines.push(`${i}  ENDIF.`);
  lines.push(``);
  lines.push(`${i}  " ---- release -----------------------------------------------------`);
  lines.push(`${i}  " Reached on EVERY path below a successful enqueue: the body ran, the`);
  lines.push(`${i}  " pre-save verify refused it, or it raised - the body-s own TRY/CATCH`);
  lines.push(`${i}  " above turns that last case into a fall-through rather than an unwind`);
  lines.push(`${i}  " to main. If the enqueue succeeded we are holding something and it is`);
  lines.push(`${i}  " ours to give back, and nothing else will give it back for us: a lock`);
  lines.push(`${i}  " can outlive this HTTP request.`);
  lines.push(...dequeueCall(`${i}  `, obj.dequeueFm, plain, "lv_lk_deqsub"));
  lines.push(
    `${i}  mo_out->write( |${LOCK_LINE_PREFIX}DEQ fm=[${obj.dequeueFm}] subrc=[{ lv_lk_deqsub }] scope=[${FPM_LOCK_SCOPE}] note=[subrc-is-not-evidence]| ).`,
  );
  lines.push(`${i}  " DEQUEUE declares no exceptions and returned subrc=0`);
  lines.push(`${i}  " on a release that released nothing. The subrc above is narration.`);
  lines.push(`${i}  " The re-read below is the evidence.`);
  lines.push(
    `${i}  read_locks( EXPORTING iv_gname = '${obj.gname}' iv_garg = space IMPORTING et_enq = lt_lk_raw ).`,
  );
  lines.push(
    `${i}  filter_rows( EXPORTING iv_config_id = lv_lk_cfgid iv_keep_all = ${keepAll} it_enq = lt_lk_raw IMPORTING et_enq = lt_lk_rows ).`,
  );
  lines.push(`${i}  CLEAR lt_lk_after.`);
  lines.push(`${i}  lv_lk_left = 0.`);
  lines.push(`${i}  LOOP AT lt_lk_rows INTO ls_lk_a.`);
  lines.push(`${i}    IF ls_lk_a-garg = lv_lk_garg.`);
  lines.push(`${i}      APPEND ls_lk_a TO lt_lk_after.`);
  lines.push(`${i}      IF lv_lk_selfok = 'X'.`);
  lines.push(`${i}        IF ls_lk_a-gusr = lv_lk_self.`);
  lines.push(`${i}          lv_lk_left = lv_lk_left + 1.`);
  lines.push(`${i}        ENDIF.`);
  lines.push(`${i}      ELSE.`);
  lines.push(`${i}        " We never learned our own GUSR, so we cannot prove a surviving`);
  lines.push(`${i}        " row is somebody else's. Count it against us — fail loud.`);
  lines.push(`${i}        lv_lk_left = lv_lk_left + 1.`);
  lines.push(`${i}      ENDIF.`);
  lines.push(`${i}    ELSEIF has_wildcard_fill( ls_lk_a-garg ) = abap_true.`);
  lines.push(`${i}      APPEND ls_lk_a TO lt_lk_after.`);
  lines.push(`${i}    ENDIF.`);
  lines.push(`${i}  ENDLOOP.`);
  lines.push(`${i}  emit_rows( iv_phase = 'after-release' it_enq = lt_lk_after ).`);
  lines.push(`${i}  IF lv_lk_left = 0.`);
  lines.push(
    `${i}    mo_out->write( |${LOCK_LINE_PREFIX}RELEASE status=[released] remaining=[{ lv_lk_left }]| ).`,
  );
  lines.push(`${i}  ELSE.`);
  lines.push(
    `${i}    mo_out->write( |${LOCK_LINE_PREFIX}RELEASE status=[still-held] remaining=[{ lv_lk_left }]| ).`,
  );
  lines.push(
    `${i}    emit_guard( iv_reason = 'release-not-verified' iv_detail = 'DEQUEUE returned but a re-read still shows the lock' ).`,
  );
  lines.push(`${i}  ENDIF.`);
  lines.push(`${i}ELSE.`);
  lines.push(
    `${i}  emit_guard( iv_reason = 'enqueue-refused' iv_detail = |${obj.enqueueFm} subrc={ lv_lk_subrc } ({ lv_lk_exc }) - the body was not run and nothing was released| ).`,
  );
  lines.push(`${i}ENDIF.`);

  return lockClassSource(className, `abap_fpm_locked_operation, label=${label}`, lines.join("\n"));
}

/**
 * The verify step, shared by `presave` and `postbody`. Sets `lv_lk_held` / `lv_lk_mine` /
 * `lv_lk_wild` / `lv_lk_pass` from the rows just read and emits the `VERIFY` line; `lv_lk_pass`
 * exists only to be printed — the branch that guards the body re-states the three observations
 * directly rather than trusting it.
 *
 * A wildcard row is treated as a DEFECT (a dropped X-flag, or a lock far wider than intended),
 * never as a stronger lock that happens to cover us — the safe move is to refuse.
 *
 * The wildcard veto is scoped (R3), after two corrections over the first cut: (1) "wildcard"
 * means the U+FFFF fill character is actually present — the first version tested `CN gc_legal`
 * ("outside the expected charset"), which also fired on any ordinary lock with a dot, hyphen, or
 * non-ASCII letter in its key, wedging every save on the lock object for unrelated reasons; (2)
 * only rows that could actually cover OUR key veto us (matching config_id segment, or that
 * segment itself wildcard-filled) — an unrelated config held generically is not our business.
 * Exception: `application` scope, where the GARG layout is inferred/never captured, so every row
 * is treated as potentially relevant and the veto stays wide.
 */
function verifyLines(
  indent: string,
  phase: "presave" | "postbody",
  kind: FpmLockObjectKind,
): string[] {
  const gargLayoutIsInferred = kind === "application";
  const lines: string[] = [];
  lines.push(`${indent}lv_lk_held = '-'.`);
  lines.push(`${indent}lv_lk_mine = '-'.`);
  lines.push(`${indent}lv_lk_wild = '-'.`);
  lines.push(`${indent}LOOP AT lt_lk_rows INTO ls_lk_v.`);
  lines.push(`${indent}  lv_lk_rel = '-'.`);
  lines.push(`${indent}  lv_lk_vid = ls_lk_v-garg+${GARG_SEGMENTS.configId[0]}(${CONFIG_ID_LEN}).`);
  if (gargLayoutIsInferred) {
    lines.push(`${indent}  " INFERRED / UNTESTED layout on this lock object: the slice above may`);
    lines.push(`${indent}  " not be a config id at all, so no row can be ruled irrelevant here.`);
    lines.push(`${indent}  lv_lk_rel = 'X'.`);
  } else {
    lines.push(`${indent}  IF lv_lk_vid = lv_lk_garg+${GARG_SEGMENTS.configId[0]}(${CONFIG_ID_LEN}).`);
    lines.push(`${indent}    lv_lk_rel = 'X'.`);
    lines.push(`${indent}  ELSEIF has_wildcard_fill( lv_lk_vid ) = abap_true.`);
    lines.push(`${indent}    " generic fill in the config_id segment: covers our config_id too.`);
    lines.push(`${indent}    lv_lk_rel = 'X'.`);
    lines.push(`${indent}  ENDIF.`);
  }
  lines.push(`${indent}  IF lv_lk_rel = 'X' AND has_wildcard_fill( ls_lk_v-garg ) = abap_true.`);
  lines.push(`${indent}    " A wildcard lock that reaches our key covers it whatever its literal`);
  lines.push(`${indent}    " GARG says. Refuse regardless of owner.`);
  lines.push(`${indent}    lv_lk_wild = 'X'.`);
  lines.push(`${indent}  ENDIF.`);
  lines.push(`${indent}  IF ls_lk_v-garg = lv_lk_garg.`);
  lines.push(`${indent}    lv_lk_held = 'X'.`);
  lines.push(`${indent}    IF lv_lk_selfok = 'X' AND ls_lk_v-gusr = lv_lk_self.`);
  lines.push(`${indent}      " GUSR, not GUNAME: scope ${FPM_LOCK_SCOPE} parks the owner id there, and`);
  lines.push(`${indent}      " GUNAME cannot tell our session from another of the same user.`);
  lines.push(`${indent}      " A scope-2 row carries a BLANK GUSR (its owner is in GUSRVB) and`);
  lines.push(`${indent}      " can never satisfy this test: lv_lk_self is only ever set from a`);
  lines.push(`${indent}      " non-blank GUSR, so blank <> lv_lk_self always. Fail-closed.`);
  lines.push(`${indent}      lv_lk_mine = 'X'.`);
  lines.push(`${indent}    ENDIF.`);
  lines.push(`${indent}  ENDIF.`);
  lines.push(`${indent}ENDLOOP.`);
  lines.push(`${indent}lv_lk_pass = '-'.`);
  lines.push(`${indent}IF lv_lk_held = 'X' AND lv_lk_mine = 'X' AND lv_lk_wild = '-'.`);
  lines.push(`${indent}  lv_lk_pass = 'X'.`);
  lines.push(`${indent}ENDIF.`);
  lines.push(
    `${indent}mo_out->write( |${LOCK_LINE_PREFIX}VERIFY phase=[${phase}] held=[{ lv_lk_held }] mine=[{ lv_lk_mine }] wildcard=[{ lv_lk_wild }] passed=[{ lv_lk_pass }]| ).`,
  );
  return lines;
}

// ---------------------------------------------------------------------------
// forceClear — implemented, gated OFF, and wired to nothing (see module header)
// ---------------------------------------------------------------------------

export interface ForceClearOptions {
  allowForceClear?: boolean;
}

/**
 * The gate in front of `ENQUE_DELETE`. Default OFF; deliberately no env var, config field, or MCP
 * tool that can flip it — the only way through is a caller passing `allowForceClear: true` in
 * code that does not yet exist.
 *
 * Deviation from the pinned contract: it specifies `AbapError("REFUSED", ...)`, but `"REFUSED"`
 * is not a member of `AbapErrorCode` (`src/adt/errors.ts`, not to be modified here). Uses the
 * existing `"SAFETY_DENIED"` code instead. A dedicated `LOCK_FORCE_CLEAR_REFUSED` code belongs in
 * the PR that actually wires this up.
 */
export function assertForceClearAllowed(opts: ForceClearOptions): void {
  if (opts.allowForceClear !== true) {
    throw new AbapError(
      "SAFETY_DENIED",
      "Refusing to force-clear an enqueue lock. ENQUE_DELETE deletes ANOTHER SESSION's lock " +
        "silently — its SUBRC is 0 whether it deleted a row, deleted nothing, or was handed an " +
        "empty table — and the robbed session gets no signal at all: it carries on believing it " +
        "holds an exclusive lock. That is the exact failure mode this module " +
        "exists to close.",
      { allowForceClear: opts.allowForceClear ?? false },
      "This escape hatch is not wired to any MCP tool and has no environment switch. It is " +
        "opened only by a caller passing allowForceClear: true in code, and there is no such " +
        "caller in this PR.",
    );
  }
}

/**
 * The `GARG` the generated `ENQUE_DELETE` reconstruction will actually carry, computed in
 * TypeScript by mirroring the emitted ABAP statement for statement. Lets {@link buildForceClearSource}
 * check, before promising anything, whether the row it's about to feed back is the row it read.
 * {@link parseGarg} is lossy one way: it classifies a segment as wildcard when ANY character in it
 * is outside the key charset, and reconstruction then fills the WHOLE segment with U+FFFF — so a
 * `GARG` with one stray wildcard character comes back wider than it went in, matches nothing,
 * `ENQUE_DELETE` deletes zero rows and returns `subrc = 0`, and the re-read is indistinguishable
 * from a successful delete.
 */
function reconstructForceClearGarg(view: GargView): string {
  const segment = (name: "configId" | "configType" | "configVar", value: string): string => {
    const [from, to] = GARG_SEGMENTS[name];
    const len = to - from;
    return view.wildcardSegments.includes(name) ? GARG_WILDCARD_CHAR.repeat(len) : padTo(value, len);
  };
  const tailLen = GARG_LENGTH - GARG_TAIL_OFFSET;
  return (
    segment("configId", view.configId) +
    segment("configType", view.configType) +
    segment("configVar", view.configVar) +
    (view.wildcardSegments.includes("tail") ? GARG_WILDCARD_CHAR.repeat(tailLen) : " ".repeat(tailLen))
  );
}

const SEQG3_LITERAL = /^[A-Za-z0-9_/ .:-]{0,150}$/;

function assertSeqg3Literal(value: string, field: string): string {
  if (!SEQG3_LITERAL.test(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `SEQG3 field ${field} contains characters that cannot be fed back into generated ABAP.`,
      { field, value: JSON.stringify(value) },
    );
  }
  return value;
}

/**
 * Generates an `ENQUE_DELETE` call that feeds the observed `SEQG3` rows back EXACTLY as read — a
 * minimal row was observed returning `subrc = 0` and deleting nothing, so "just fill in the key
 * fields" is worse than useless: it looks like it worked. Which field the FM actually matches on
 * is inferred, not known; `GUSR`/`GUSRVB` are populated only because they were present in the
 * rows read.
 *
 * Known incompleteness: the transcript's `ROW` line carries ten of `SEQG3`'s twenty-two fields.
 * `GTHOST`/`GTWP`/`GTSYSNR`/`GTDATE`/`GTTIME`/`GTUSEC`/`GTMARK`/`GTARG`/`GTCODE`/`GBCKTYPE`/
 * `GUSETXT`/`GUSEVBT` are not reconstructed, so whether this actually deletes anything is
 * unproven. The generated source re-reads afterward and reports `RELEASE status=[...]`, since
 * `ENQUE_DELETE`'s own `SUBRC` is worthless (0 for a real delete, a no-op, or an empty table).
 *
 * **The re-read verdict is only as good as the reconstruction, so the reconstruction is checked
 * first (D1).** {@link parseGarg} is lossy: a segment with a single wildcard character is
 * reported wholly wildcarded, and {@link reconstructForceClearGarg} then fills the whole segment
 * — so the rebuilt row can be one that was never in the enqueue table, nothing matches it on
 * re-read, and old code called that `RELEASE status=[released] remaining=[0]`, a clean bill of
 * health for a delete that deleted nothing. Every row is now compared against the `GARG` it was
 * read from BEFORE any source is generated; one mismatch and the generated ABAP emits
 * `GUARD reason=[force-clear-garg-not-reconstructible]` and hard-codes
 * `RELEASE status=[still-held] remaining=[{ lines( lt_lk_del ) }]` without consulting the row
 * count. Fail closed.
 *
 * Inferred (spike item (d)): `CHECK_UPD_REQUESTS` was not echoed and is believed `0`; this
 * generator omits the parameter entirely rather than depending on that belief.
 *
 * Wildcard segments use `cl_abap_conv_in_ce=>uccp( 'FFFF' )` rather than a raw embedded U+FFFF.
 * Not spike-covered; if unavailable on the target system, activation fails loudly with a visible
 * ABAP syntax error (same degraded-failure mode `fpm-runtime.ts` accepts elsewhere), never a
 * silently wrong delete.
 */
export function buildForceClearSource(
  rows: LockRow[],
  opts: ForceClearOptions,
  className: string,
): string {
  assertForceClearAllowed(opts);
  if (rows.length === 0) {
    throw new AbapError("BAD_INPUT", "force-clear needs at least one SEQG3 row to delete.", {
      rows: 0,
    });
  }

  // D1: decide reconstruction fidelity before generating any verdict — every mismatch becomes a
  // hard still-held verdict plus a GUARD in the generated source, never `remaining=[0]`.
  const views = rows.map((row) => (row.garg_view.raw ? row.garg_view : parseGarg(row.garg)));
  const gargMismatches: number[] = [];
  views.forEach((view, idx) => {
    if (reconstructForceClearGarg(view) !== padTo(rows[idx]!.garg, GARG_LENGTH)) {
      gargMismatches.push(idx + 1);
    }
  });
  const gargReconstructible = gargMismatches.length === 0;

  const i = "      ";
  const lines: string[] = [];
  lines.push(`${i}DATA lt_lk_del TYPE tt_enq.`);
  lines.push(`${i}DATA ls_lk_del TYPE seqg3.`);
  lines.push(`${i}DATA lv_lk_wcc TYPE c LENGTH 1.`);
  lines.push(`${i}DATA lv_lk_dsub TYPE sy-subrc.`);
  lines.push(`${i}DATA lv_lk_off  TYPE i.`);
  lines.push(`${i}DATA lt_lk_rest TYPE tt_enq.`);
  lines.push(`${i}DATA lt_lk_left TYPE tt_enq.`);
  lines.push(`${i}DATA ls_lk_chk  TYPE seqg3.`);
  lines.push(`${i}DATA ls_lk_want TYPE seqg3.`);
  lines.push(`${i}DATA lv_lk_n    TYPE i.`);
  lines.push(`${i}" Unverified idiom (not covered by the lock spike): if uccp is absent`);
  lines.push(`${i}" here, activation fails loudly rather than deleting the wrong row.`);
  lines.push(`${i}lv_lk_wcc = cl_abap_conv_in_ce=>uccp( 'FFFF' ).`);

  rows.forEach((row, idx) => {
    const view = views[idx]!;
    lines.push(``);
    lines.push(`${i}" ---- row ${idx + 1} of ${rows.length} ----`);
    lines.push(`${i}CLEAR ls_lk_del.`);
    lines.push(`${i}ls_lk_del-gname   = '${assertSeqg3Literal(row.gname, "gname")}'.`);
    lines.push(`${i}ls_lk_del-gmode   = '${assertSeqg3Literal(row.gmode, "gmode")}'.`);
    lines.push(`${i}ls_lk_del-guname  = '${assertSeqg3Literal(row.guname, "guname")}'.`);
    lines.push(`${i}ls_lk_del-gclient = '${assertSeqg3Literal(row.gclient, "gclient")}'.`);
    lines.push(`${i}ls_lk_del-gusr    = '${assertSeqg3Literal(row.gusr, "gusr")}'.`);
    lines.push(`${i}ls_lk_del-gusrvb  = '${assertSeqg3Literal(row.gusrvb, "gusrvb")}'.`);
    lines.push(`${i}ls_lk_del-guse    = '${assertSeqg3Literal(row.guse, "guse")}'.`);
    lines.push(`${i}ls_lk_del-gusevb  = '${assertSeqg3Literal(row.gusevb, "gusevb")}'.`);
    lines.push(`${i}ls_lk_del-gobj    = '${assertSeqg3Literal(row.gobj, "gobj")}'.`);
    lines.push(`${i}CLEAR ls_lk_del-garg.`);
    for (const name of ["configId", "configType", "configVar"] as const) {
      const [from, to] = GARG_SEGMENTS[name];
      const len = to - from;
      if (view.wildcardSegments.includes(name)) {
        // Offset/length can't be chained in ABAP; `sy-index` starts at 1, hence the -1 bias.
        lines.push(`${i}DO ${len} TIMES.`);
        lines.push(`${i}  lv_lk_off = ${from} + sy-index - 1.`);
        lines.push(`${i}  ls_lk_del-garg+lv_lk_off(1) = lv_lk_wcc.`);
        lines.push(`${i}ENDDO.`);
      } else {
        const seg = name === "configId" ? view.configId : name === "configType" ? view.configType : view.configVar;
        lines.push(`${i}ls_lk_del-garg+${from}(${len}) = '${assertSeqg3Literal(seg, name)}'.`);
      }
    }
    if (view.wildcardSegments.includes("tail")) {
      lines.push(`${i}DO ${GARG_LENGTH - GARG_TAIL_OFFSET} TIMES.`);
      lines.push(`${i}  lv_lk_off = ${GARG_TAIL_OFFSET} + sy-index - 1.`);
      lines.push(`${i}  ls_lk_del-garg+lv_lk_off(1) = lv_lk_wcc.`);
      lines.push(`${i}ENDDO.`);
    }
    lines.push(`${i}APPEND ls_lk_del TO lt_lk_del.`);
  });

  lines.push(``);
  lines.push(`${i}emit_rows( iv_phase = 'force-clear-input' it_enq = lt_lk_del ).`);
  if (!gargReconstructible) {
    // D1: emitted unconditionally, right after the input rows — the mismatch is a fact about the
    // generated source, not a runtime outcome. A THIRD instance of the over-255-char defect fixed
    // in buildLockInspectSource (ADT_MAX_SOURCE_LINE_LEN / wrapAbapTemplateLines): with enough
    // mismatched rows, `row(s) ${gargMismatches.join(...)}` alone exceeds 255 chars (reproduced
    // locally at 300 rows). Never hit live (path not wired to any tool), but the regression test
    // covers it since it's reachable the moment forceClear ships. Join separator is now ", " so
    // the row list has wrap points; wording otherwise unchanged.
    lines.push(`${i}emit_guard( iv_reason = 'force-clear-garg-not-reconstructible'`);
    lines.push(`${i}  iv_detail =`);
    lines.push(
      ...emitWrappedGuardDetail(
        `the GARG rebuilt for row(s) ${gargMismatches.join(", ")} does not equal the GARG that was ` +
          "read back - a partly-wildcarded segment is rebuilt WHOLLY wildcarded, so ENQUE_DELETE is " +
          "being handed a row that was never in the enqueue table; no delete can be claimed",
        `${i}    `,
        "force-clear-garg-not-reconstructible detail",
      ),
    );
  }
  lines.push(`${i}CALL FUNCTION 'ENQUE_DELETE'`);
  lines.push(`${i}  IMPORTING`);
  lines.push(`${i}    subrc = lv_lk_dsub`);
  lines.push(`${i}  TABLES`);
  lines.push(`${i}    enq   = lt_lk_del.`);
  // No `scope=[..]` field here, deliberately: ENQUE_DELETE has NO `_SCOPE` parameter at all
  // (interface is SUBRC / CHECK_UPD_REQUESTS / SUPPRESS_SYSLOG_ENTRY / TABLES ENQ). Printing
  // FPM_LOCK_SCOPE here would narrate a parameter the call never sent.
  lines.push(
    `${i}mo_out->write( |${LOCK_LINE_PREFIX}DEQ fm=[ENQUE_DELETE] subrc=[{ lv_lk_dsub }] note=[subrc-is-not-evidence]| ).`,
  );
  // Re-read EVERY lock object touched, not just the first row's, and judge the delete only on the
  // rows actually asked for: `lines( )` over the whole lock object would report "still-held"
  // whenever any unrelated config is locked — a verdict about the system, not this operation.
  const gnames = [...new Set(rows.map((r) => assertSeqg3Literal(r.gname, "gname")))];
  lines.push(`${i}CLEAR lt_lk_left.`);
  lines.push(`${i}lv_lk_n = 0.`);
  for (const gname of gnames) {
    lines.push(`${i}CLEAR lt_lk_rest.`);
    lines.push(
      `${i}read_locks( EXPORTING iv_gname = '${gname}' iv_garg = space IMPORTING et_enq = lt_lk_rest ).`,
    );
    lines.push(`${i}LOOP AT lt_lk_rest INTO ls_lk_chk.`);
    lines.push(`${i}  LOOP AT lt_lk_del INTO ls_lk_want.`);
    lines.push(`${i}    IF ls_lk_want-gname = ls_lk_chk-gname AND ls_lk_want-garg = ls_lk_chk-garg.`);
    lines.push(`${i}      APPEND ls_lk_chk TO lt_lk_left.`);
    lines.push(`${i}      lv_lk_n = lv_lk_n + 1.`);
    lines.push(`${i}      EXIT.`);
    lines.push(`${i}    ENDIF.`);
    lines.push(`${i}  ENDLOOP.`);
    lines.push(`${i}ENDLOOP.`);
  }
  lines.push(`${i}emit_rows( iv_phase = 'after-release' it_enq = lt_lk_left ).`);
  if (gargReconstructible) {
    lines.push(`${i}IF lv_lk_n = 0.`);
    lines.push(`${i}  mo_out->write( |${LOCK_LINE_PREFIX}RELEASE status=[released] remaining=[0]| ).`);
    lines.push(`${i}ELSE.`);
    lines.push(
      `${i}  mo_out->write( |${LOCK_LINE_PREFIX}RELEASE status=[still-held] remaining=[{ lv_lk_n }]| ).`,
    );
    lines.push(`${i}ENDIF.`);
  } else {
    // D1, fail closed: the re-read counts rows matching the RECONSTRUCTED GARG, which is known
    // not to equal what was read, so `lv_lk_n = 0` is true whether the real lock was deleted or
    // untouched. Report every requested row as still held rather than risk a fail-open verdict.
    lines.push(`${i}" The GARG reconstruction is not faithful (see the GUARD above), so`);
    lines.push(`${i}" lv_lk_n is evidence about a row that does not exist. It is deliberately`);
    lines.push(`${i}" NOT consulted: nothing here may report a release it cannot prove.`);
    lines.push(
      `${i}mo_out->write( |${LOCK_LINE_PREFIX}RELEASE status=[still-held] remaining=[{ lines( lt_lk_del ) }]| ).`,
    );
  }

  return lockClassSource(className, "abap_fpm_lock_force_clear (NOT wired to any tool)", lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

// The `key=[value]` transcript grammar is parsed by `run.ts`'s shared `parseBracketFields`,
// including the embedded-`]` tolerance the lock rows need (documented there).

const flag = (v: string | undefined): boolean => v === "X";

interface RawRow {
  phase: string;
  row: Omit<LockRow, "ownership">;
}

/**
 * Consumes exactly the grammar {@link buildLockInspectSource} / {@link buildLockedOperationSource}
 * emit. Anything else — an unprefixed line, an unrecognized `LCK>` head — is counted into
 * `droppedLines` rather than ignored, so a transcript that silently changed shape shows up as a
 * number instead of a shorter table.
 */
export function parseLockTranscript(raw: string): FpmLockTranscript {
  const diagnostics: string[] = [];
  const aborts: string[] = [];
  let droppedLines = 0;

  const rawRows: RawRow[] = [];
  const phaseOrder: string[] = [];
  const reportedRows = new Map<string, number>();
  let selfOwnerId: string | undefined;
  let acquire: FpmLockTranscript["acquire"];
  let preSaveVerify: FpmLockTranscript["preSaveVerify"];
  let saveReached = false;
  let wildcardDetected = false;
  let releaseStatus: "released" | "still-held" | undefined;

  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith(ERR_LINE_PREFIX)) {
      diagnostics.push(line.trim());
      continue;
    }
    if (!line.startsWith(LOCK_LINE_PREFIX)) {
      if (line.trim() !== "") droppedLines++;
      continue;
    }
    const rest = line.slice(LOCK_LINE_PREFIX.length);
    const spaceIdx = rest.indexOf(" ");
    const head = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
    const remainder = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);
    const f = parseBracketFields(remainder);

    switch (head) {
      case "SELF":
        if (flag(f.ok) && (f.owner ?? "") !== "") selfOwnerId = f.owner;
        break;
      case "ENQ": {
        const subrc = Number(f.subrc ?? "");
        acquire = {
          subrc: Number.isNaN(subrc) ? -1 : subrc,
          foreignLock: f.exc === "foreign_lock",
          systemFailure: f.exc === "system_failure",
        };
        break;
      }
      case "ROW": {
        const phase = f.phase ?? "";
        if (!phaseOrder.includes(phase)) phaseOrder.push(phase);
        const garg = f.garg ?? "";
        rawRows.push({
          phase,
          row: {
            gname: f.gname ?? "",
            garg,
            gmode: f.gmode ?? "",
            guname: f.guname ?? "",
            gclient: f.gclient ?? "",
            gusr: f.gusr ?? "",
            gusrvb: f.gusrvb ?? "",
            guse: f.guse ?? "",
            gusevb: f.gusevb ?? "",
            gobj: f.gobj ?? "",
            garg_view: parseGarg(garg),
          },
        });
        break;
      }
      case "COUNT": {
        // Not merely informational: `emit_rows` writes a COUNT line for every phase, including a
        // zero-row one, so this is the only record that phase happened at all — keying phases off
        // ROW lines alone would erase the evidence that a release was verified, not assumed.
        const phase = f.phase ?? "";
        if (!phaseOrder.includes(phase)) phaseOrder.push(phase);
        const n = Number(f.rows ?? "");
        if (!Number.isNaN(n)) reportedRows.set(phase, n);
        break;
      }
      case "WILDCARD":
        wildcardDetected = true;
        break;
      case "VERIFY":
        if (f.phase === "presave") {
          preSaveVerify = {
            held: flag(f.held),
            mine: flag(f.mine),
            wildcard: flag(f.wildcard),
            passed: flag(f.passed),
          };
        }
        if (flag(f.wildcard)) wildcardDetected = true;
        break;
      case "GUARD":
        aborts.push(`${f.reason ?? "unknown"}: ${f.detail ?? ""}`.trim());
        break;
      case "BODY":
        if (f.state === "begin") saveReached = true;
        break;
      case "DEQ":
        // subrc is deliberately not recorded as evidence — `note=[subrc-is-not-evidence]` on the
        // wire. The RELEASE line, backed by a re-read, is the verdict.
        break;
      case "RELEASE":
        releaseStatus = f.status === "released" ? "released" : "still-held";
        break;
      default:
        droppedLines++;
        break;
    }
  }

  // Ownership is a second pass: the SELF line arrives before the rows in practice, but nothing in
  // the grammar guarantees it, and a line-order-dependent parser would be one ABAP reshuffle from
  // labelling every row UNKNOWN.
  //
  // Both owner slots are consulted since only one is populated per row: a scope-1 lock parks the
  // owner id in `GUSR`, a scope-2 lock carries blank `GUSR` and its owner in `GUSRVB`. Keying on
  // `GUSR` alone mislabelled scope-2 rows FOREIGN via blank-vs-nonblank inequality, and even
  // labelled a row with BOTH slots blank FOREIGN. MINE is reachable only through the scope-1
  // `GUSR` path (our own locks are always FPM_LOCK_SCOPE = "1"); the GUSRVB branch is a positive
  // FOREIGN identification only and the cross-session GUSRVB comparison was never wire-exercised.
  const blank = (v: string): boolean => v.trim() === "";
  const classify = (row: Omit<LockRow, "ownership">): LockOwnership => {
    if (selfOwnerId === undefined) return "UNKNOWN";
    if (!blank(row.gusr)) return row.gusr === selfOwnerId ? "MINE" : "FOREIGN";
    if (!blank(row.gusrvb)) return "FOREIGN";
    return "UNKNOWN";
  };

  const byPhase = new Map<string, LockRow[]>();
  for (const p of phaseOrder) byPhase.set(p, []);
  for (const { phase, row } of rawRows) {
    const full: LockRow = { ...row, ownership: classify(row) };
    if (full.garg_view.isWildcard) wildcardDetected = true;
    byPhase.get(phase)?.push(full);
  }
  const phases: LockPhaseSnapshot[] = phaseOrder.map((phase) => {
    const rows = byPhase.get(phase) ?? [];
    const reported = reportedRows.get(phase);
    // A COUNT that disagrees with the ROW lines means output was lost: the rows held are a floor,
    // not the set, so a "nothing is held" conclusion from them would be unsound.
    if (reported !== undefined && reported !== rows.length) {
      diagnostics.push(
        `phase ${phase}: ABAP reported ${reported} row(s) but ${rows.length} ROW line(s) were parsed — output may be truncated`,
      );
    }
    return { phase, rows, ...(reported === undefined ? {} : { reportedRows: reported }) };
  });

  let release: LockReleaseOutcome | undefined;
  if (releaseStatus === "released") {
    release = { status: "released" };
  } else if (releaseStatus === "still-held") {
    const after = byPhase.get("after-release") ?? [];
    const mine = after.filter((r) => r.ownership === "MINE");
    release = { status: "still-held", rows: mine.length > 0 ? mine : after };
  }

  return {
    ...(selfOwnerId === undefined ? {} : { selfOwnerId }),
    ...(acquire === undefined ? {} : { acquire }),
    ...(preSaveVerify === undefined ? {} : { preSaveVerify }),
    saveReached,
    ...(release === undefined ? {} : { release }),
    phases,
    wildcardDetected,
    aborts,
    diagnostics,
    droppedLines,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface FpmLockReadResult {
  query: FpmLockInspectQuery;
  bridgeClass: string;
  bridgeRefreshed: boolean;
  durationMs: number;
  transcript: FpmLockTranscript;
  outputComplete: boolean;
  bodyBytes: number;
}

/**
 * Write -> activate -> verify activation -> run -> parse, mirroring `runFpmRead`. Read-only with
 * respect to the caller's configuration — the bridge's only enqueue is the throwaway self-probe
 * on {@link SELF_PROBE}, released two statements later, without which MINE/FOREIGN could only
 * ever say UNKNOWN.
 */
export async function runFpmLockInspect(
  conn: AbapConnection,
  query: FpmLockInspectQuery,
  gate: SafetyGate,
): Promise<FpmLockReadResult> {
  const started = Date.now();
  const className = fpmLockBridgeClassName(query);
  const source = buildLockInspectSource(query, className);

  const deployed = await deployBridge(conn, gate, {
    className,
    source,
    description: "abapsmith FPM lock inspection bridge",
    what: "Activation of the generated FPM lock bridge",
    hint:
      "The bridge reads the enqueue table via ENQUEUE_READ and takes one throwaway self-lock " +
      "through ENQUEUE_E_WDY_CONFCOMP/CONFAPPL. A syntax error here most likely means one of " +
      "those function modules, or a SEQG3 field, is not shaped exactly as the lock-discipline " +
      "spike recorded (see this module's doc comment for confirmed vs. inferred).",
    verify: (activation) =>
      verifyBridgeActivation(activation, className, "FPM lock bridge", { mode: "locks" }),
  });
  const { bridgeRefreshed } = deployed;

  // Running the bridge is a distinct mutating operation from write/activate — it POSTs to the
  // classrun endpoint — so `executeBridge` gates it separately as "execute", as `runFpmRead` does.
  const run = await executeBridge(conn, gate, deployed);
  const transcript = parseLockTranscript(run.output);

  return {
    query,
    bridgeClass: className,
    bridgeRefreshed,
    durationMs: Date.now() - started,
    transcript,
    outputComplete: run.outputComplete,
    bodyBytes: run.bodyBytes,
  };
}
