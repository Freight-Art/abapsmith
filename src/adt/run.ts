/**
 * Execution — `classrun` plus the report bridge.
 *
 * Two traps: (1) classrun runs whatever's already loaded in the session's
 * program buffer, so an edit-then-run flow that reuses a session can silently
 * re-execute stale code (HTTP 200, plausible, wrong) — every execution goes
 * through `AbapConnection.withFreshSession()` (see `runClass()`); (2) a short
 * dump returns `500 text/html` and kills the session — must surface as a
 * structured error, never HTML, and must not trip the auth circuit breaker.
 *
 * This module does not consult `conn.readOnly` or the safety allowlist —
 * that's decided one layer up (src/safety.ts + src/tools/*), like the write
 * path. It only refuses input it cannot safely turn into ABAP.
 */
import { createHash } from "node:crypto";
import type { AbapConnection } from "./connection.js";
import { AbapError, isAbapError } from "./errors.js";
import { truncateText, DUMP_SHORT_TEXT_MAX } from "../truncate.js";
// Dump parsing and ADT-error translation live in session.ts — single source of
// truth, so the write path and the run path classify a dead session identically.
import {
  classifySessionFailure,
  parseDumpPage,
  translateAdtError,
  type SessionFailureKind,
} from "./session.js";
import {
  authorizeMutation,
  writeObject,
  NO_JOURNAL,
  type ResolvedTarget,
  type WriteResult,
} from "./write.js";
import type { SafetyGate } from "../safety.js";
import { activateObject, assertNoErrors, type ActivationOutcome } from "./activate.js";
// Correlation only — FQL builder/validator + feed path, so the query handed
// to a caller matches what the dumps tool accepts. Acyclic (verified: chain
// dumps-query -> dumps-xml -> errors never reaches run.js) — re-check before widening.
import { buildFqlQuery, isValidTimestamp14, timestamp14, DUMPS_FEED_PATH } from "./dumps-query.js";
import { abapLiteral } from "./enhancement-templates.js";
import {
  marshalSelectionTable,
  parseSelectionScreen,
  type MarshalledSelectionRow,
  type RunParameterInput,
} from "./run-parameters.js";

export interface DumpInfo {
  shortText: string;
  serverTime?: string;
}

/**
 * Where to look for the ST22 dump matching a `RUNTIME_DUMP`.
 *
 * Arguments, never content — {@link translateRunFailure}'s `kind === "dump"`
 * branch deliberately does not fetch the feed itself; see its comment.
 */
export interface DumpCorrelation {
  /** Inclusive lower bound, 14 digits `YYYYMMDDHHMMSS` — server time − 2 s. */
  from: string;
  /** Inclusive upper bound, 14 digits `YYYYMMDDHHMMSS` — server time + 2 s. */
  to: string;
  /** The logon user, uppercased. Absent when the connection carries no user. */
  user?: string;
  /** Validated FQL `$query`, e.g. `and ( equals ( user , DEVELOPER ) )`. Absent whenever {@link user} is. */
  query?: string;
  /** The raw feed, for a deployment where `abap_dumps` is not registered. */
  feedPath: string;
  /** Ready to forward verbatim; no field needs rebuilding. */
  call: {
    tool: "abap_dumps";
    arguments: { mode: "list"; from: string; to: string; query?: string };
  };
  /**
   * Always `"candidates"`, never `"exact"` — the feed key `(host, user,
   * client, MODNO, timestamp)` cannot disambiguate two dumps from one user in
   * the same second. Measured, not hypothetical: on 2026-08-11 two
   * concurrently-fired classes both landed on `20260811193452` and the
   * window returned 2 distinct candidates. Full measurement: see
   * the git history.
   */
  confidence: "candidates";
}

/** ±N seconds around the reported server time. Small on purpose: see {@link buildDumpCorrelation}. */
const DUMP_CORRELATION_SLACK_SECONDS = 2;

/**
 * Turn `parseDumpPage`'s `{serverTime, user}` into a dump-feed lookup, or
 * `undefined` when it cannot be built honestly. Pure and exported for unit
 * testing without a connection or HTTP fake.
 *
 * Do NOT build a `Date` from `serverTime` directly: it's the SAP app server's
 * wall clock (`"2026-08-11 12:34:47"`, no zone), and `new Date(...)` would
 * reinterpret it in the Node host's local zone, silently shifting the window
 * — the likeliest regression here. Strip non-digits and treat the 14 digits
 * as an opaque wall clock instead. The ±2s arithmetic below is safe because
 * it goes through `Date.UTC` (numeric components only, no parsing/zone
 * inference) + {@link timestamp14} (reads back with `getUTC*` only).
 *
 * ±2s slack is measured, not arbitrary — see the git history
 * for the capture where the ICF page and the feed stamped the same dump one
 * second apart.
 *
 * @param serverTime `parseDumpPage().serverTime`, or `undefined`.
 * @param user the logon user (`conn.cfg.user`), or `undefined`.
 */
export function buildDumpCorrelation(
  serverTime: string | undefined,
  user: string | undefined,
): DumpCorrelation | undefined {
  if (!serverTime) return undefined;

  // Digit-strip only. NOT `new Date(serverTime)` — see the header above.
  const digits = serverTime.replace(/\D/g, "");
  // Must be a real instant, not just 14 digits: the feed answers a malformed
  // from= with 200 and the whole unfiltered feed — worse than no bound.
  if (!isValidTimestamp14(digits)) return undefined;

  const at = Date.UTC(
    Number(digits.slice(0, 4)),
    Number(digits.slice(4, 6)) - 1,
    Number(digits.slice(6, 8)),
    Number(digits.slice(8, 10)),
    Number(digits.slice(10, 12)),
    Number(digits.slice(12, 14)),
  );
  const slack = DUMP_CORRELATION_SLACK_SECONDS * 1_000;
  const from = timestamp14(new Date(at - slack));
  const to = timestamp14(new Date(at + slack));

  // FQL `user` operand is case-insensitive (measured live 2026-08-11 — see
  // archive); this uppercasing is cosmetic, not correctness-bearing. Kept for
  // consistency with how SAP stores logon users and how this value is echoed
  // back to the caller in `dumpCorrelation.query` and the hint.
  const upper = user?.trim().toUpperCase();

  // Absent user drops the predicate rather than emitting an invalid
  // `equals ( user , )`, which the feed 400s on with an opaque, unhelpful
  // body — a time-only window is a worse filter but a correct one.
  //
  // `buildFqlQuery` validates before printing, so a query that reaches a
  // caller is one the feed's own contract accepts.
  const query = upper
    ? buildFqlQuery({
        junction: "and",
        predicates: [{ attribute: "user", operator: "equals", operands: [upper] }],
      })
    : undefined;

  return {
    from,
    to,
    ...(upper ? { user: upper } : {}),
    ...(query ? { query } : {}),
    feedPath: DUMPS_FEED_PATH,
    call: {
      tool: "abap_dumps",
      arguments: { mode: "list", from, to, ...(query ? { query } : {}) },
    },
    confidence: "candidates",
  };
}

/**
 * The `RUNTIME_DUMP` hint. Constraints, all load-bearing:
 *  - "Any output written before the dump is lost." must appear verbatim.
 *  - `/sap/bc/adt/runtime/dumps` appears exactly once — it's the only true
 *    instruction when `abap_dumps` isn't registered (ABAP_TOOL_SURFACE=v2).
 *  - Candidates, never "your dump" — see {@link DumpCorrelation.confidence}.
 *  - Arguments come from `JSON.stringify(correlation.call.arguments)` so the
 *    copy-pasteable text can't drift from the machine-readable `details`.
 *  - Length ~100–550 chars, pinned in test/run.test.ts.
 */
function dumpHint(correlation: DumpCorrelation | undefined): string {
  // No server time on the page ⇒ no honest window. Say so and use placeholders
  // rather than inventing digits that would look authoritative and be wrong.
  const args = correlation
    ? JSON.stringify(correlation.call.arguments)
    : '{"mode":"list","from":"[YYYYMMDDHHMMSS just before this call]","to":"[just after]"}';
  const lead = correlation
    ? "The ICF error page carries only the exception short text — no dump id, no call stack, no source position."
    : "The ICF error page carries only the exception short text — no dump id, no call stack, no source position, and no server time.";
  return (
    `${lead} Any output written before the dump is lost. The ABAP session was destroyed and ` +
    `has been discarded. Read the full ST22 dump with abap_dumps ${args} — a window can hold ` +
    `several dumps, so treat each row as a candidate, not the answer. Where that tool is not ` +
    `registered the same feed is ${DUMPS_FEED_PATH}, reaching only the last 8 days.`
  );
}

export interface RunResult {
  mode: "class" | "report";
  object: string;
  /** Captured output, already stripped of the ASCII list header lines. */
  output: string;
  lines: number;
  durationMs: number;
  /**
   * Lines removed from `output` and not otherwise surfaced — the header strip
   * (report mode) plus any unprefixed non-blank line and any discarded blank
   * line the bridge split had to drop (F2/F3). 0 when nothing was removed.
   */
  droppedLines: number;
  /** Raw response body length in bytes, before any parsing. */
  bodyBytes: number;
  /** False when any ABAP-side width truncation was detected (F5). */
  outputComplete: boolean;
  /** Report mode: the generated `IF_OO_ADT_CLASSRUN` wrapper that was used. */
  bridgeClass?: string;
  /** Report mode: whether the bridge class had to be (re)generated this call. */
  bridgeRefreshed?: boolean;
  /**
   * Report mode only: true ONLY when activation of the bridge class was
   * positively verified by this call before executing it (F6). Never
   * defaulted to true — either verified or the call threw before returning.
   */
  bridgeActivationVerified?: boolean;
  /**
   * Report mode, additive: bridge output that was *not* part of the captured
   * list — i.e. the `ZMCP-ERR>` markers the driver emits when SUBMIT or the
   * LIST_* function modules fail. Normally empty. Kept out of `output` so the
   * report's own list is never contaminated.
   */
  diagnostics?: string[];
}

/** Package the generated bridge classes live in. Local ⇒ no transport. */
export const BRIDGE_PACKAGE = "$TMP";

/** Prefix the driver puts on every captured list line. */
export const LIST_LINE_PREFIX = "LIST> ";

/** Prefix the driver puts on its own failure diagnostics. */
export const ERR_LINE_PREFIX = "ZMCP-ERR> ";

/**
 * Substring the generated bridge (F5) embeds in its own diagnostic when a
 * captured list line hits the `ty_txt_line` capture width — the wording is
 * shared between the ABAP template below and the TS-side detection in
 * `runReport` so the two never drift apart.
 */
export const WIDTH_TRUNCATION_MARKER = "capture width and may be truncated";

/** The only execution collection in the discovery document. */
export const CLASSRUN_PATH = "/sap/bc/adt/oo/classrun/";

const BRIDGE_CLASS_PREFIX = "ZCL_ZMCP_RUN_";
/**
 * ABAP repository object names are 30 characters. Exported because every
 * bridge-name builder in the codebase needs the same ceiling
 * (`bopf-runtime.ts`, `fpm-runtime.ts`, `fpm-lock.ts`) and it is one fact
 * about ABAP, not three.
 */
export const MAX_NAME = 30;
/** Hex digits of the disambiguating hash appended to truncated names. */
const HASH_LEN = 6;

/**
 * Anything that ends up textually inside generated ABAP has to be provably a
 * plain repository name — otherwise `runReport("X. DELETE FROM t. SUBMIT y")`
 * would be an ABAP injection into a program we then activate and execute.
 *
 * Exported: the BOPF runtime bridge generator (`src/adt/bopf-runtime.ts`)
 * reuses this exact guard rather than duplicating the injection-defense
 * regex in a second module.
 */
const ABAP_NAME = /^[A-Za-z0-9_/]{1,40}$/;

export function assertPlainName(value: string, what: string): string {
  const v = value.trim();
  if (!ABAP_NAME.test(v)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} "${value}" is not a valid ABAP object name.`,
      { value },
      "Only letters, digits, underscore and / (namespaces) are accepted — the name is " +
        "embedded verbatim in generated ABAP source.",
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// Bridge class naming
// ---------------------------------------------------------------------------

/**
 * Deterministic bridge-class name for a report, ≤ 30 chars.
 *
 * Must start with `Z`: the bridge is a real repository object we create on
 * the user's system, so it needs a customer-namespace name (test/run.test.ts:
 * `startsWith("Z")`).
 *
 * `ZCL_ZMCP_RUN_` is 13 characters, leaving 17. Longer report names (and any
 * name that had to be sanitised, e.g. namespaced `/DMO/FLIGHT`) keep 10
 * characters of the original for human recognisability plus a 6-hex-digit
 * hash of the *unsanitised* name, so two different reports can never collapse
 * onto the same bridge class.
 */
export function bridgeClassName(report: string): string {
  const canon = assertPlainName(report, "Report name").toUpperCase();
  const safe = canon.replace(/[^A-Z0-9_]/g, "_");
  const budget = MAX_NAME - BRIDGE_CLASS_PREFIX.length; // 17
  if (safe.length <= budget && safe === canon) return BRIDGE_CLASS_PREFIX + safe;

  const hash = createHash("sha256").update(canon, "utf8").digest("hex").slice(0, HASH_LEN).toUpperCase();
  const keep = safe.slice(0, budget - HASH_LEN - 1); // 10 chars + "_" + 6 = 17
  return `${BRIDGE_CLASS_PREFIX}${keep}_${hash}`;
}

// ---------------------------------------------------------------------------
// Bridge class source
// ---------------------------------------------------------------------------

/**
 * The generated `IF_OO_ADT_CLASSRUN` wrapper that SUBMITs a report to memory.
 * There is no ADT endpoint that runs a classic report and returns its list —
 * this recipe (`SUBMIT ... AND RETURN EXPORTING LIST TO MEMORY` then
 * `LIST_FROM_MEMORY` + `LIST_TO_ASCI`) was verified live on A4H.
 *
 * Output must stay byte-stable for the same inputs: the write path skips the
 * PUT when the content hash is unchanged, which is what makes refreshing the
 * bridge on every run cheap. Never interpolate a timestamp/counter here.
 *
 * `sy-subrc` after SUBMIT is reported but not fatal — a report ending via
 * MESSAGE/LEAVE can set non-zero subrc while leaving a good list in memory.
 */
export function bridgeClassSource(
  className: string,
  report: string,
  selectionRows: readonly MarshalledSelectionRow[] = [],
): string {
  const cls = assertPlainName(className, "Class name").toLowerCase();
  const rep = assertPlainName(report, "Report name").toLowerCase();

  // No rows ⇒ output must stay byte-identical to the pre-parameters shape —
  // keeps the content-hash PUT-skip working; guarded by test/run.test.ts.
  const seltabDecl =
    selectionRows.length > 0
      ? `    DATA: lt_seltab TYPE STANDARD TABLE OF rsparams,
          ls_seltab TYPE rsparams.
`
      : "";
  const seltabFill =
    selectionRows.length > 0
      ? selectionRows
          .map(
            (row) =>
              `    CLEAR ls_seltab.
    ls_seltab-selname = ${abapLiteral(row.selname)}.
    ls_seltab-kind    = ${abapLiteral(row.kind)}.
    ls_seltab-sign    = ${abapLiteral(row.sign)}.
    ls_seltab-option  = ${abapLiteral(row.option)}.
    ls_seltab-low     = ${abapLiteral(row.low)}.
    ls_seltab-high    = ${abapLiteral(row.high)}.
    APPEND ls_seltab TO lt_seltab.
`,
          )
          .join("")
      : "";
  const submitStmt =
    selectionRows.length > 0
      ? `SUBMIT ${rep} WITH SELECTION-TABLE lt_seltab AND RETURN EXPORTING LIST TO MEMORY.`
      : `SUBMIT ${rep} AND RETURN EXPORTING LIST TO MEMORY.`;

  return `CLASS ${cls} DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.


CLASS ${cls} IMPLEMENTATION.

  METHOD if_oo_adt_classrun~main.
*   Generated by abapsmith. Runs ${rep.toUpperCase()} and streams its classic list
*   back through classrun. Do not edit: this class is regenerated from
*   src/adt/run.ts whenever its content hash changes.
*   Capture width is 1023 chars (F5) — the ceiling for a classic ABAP list
*   line, not a cap chosen here. LOOP below still discloses a residual cut.
    TYPES: ty_txt_line TYPE c LENGTH 1023.
    DATA: lt_list TYPE TABLE OF abaplist,
          lt_txt  TYPE TABLE OF ty_txt_line.
${seltabDecl}
${seltabFill}    ${submitStmt}
    IF sy-subrc <> 0.
      out->write( |${ERR_LINE_PREFIX}SUBMIT ${rep.toUpperCase()} set sy-subrc = { sy-subrc }| ).
    ENDIF.

    CALL FUNCTION 'LIST_FROM_MEMORY'
      TABLES
        listobject = lt_list
      EXCEPTIONS
        not_found  = 1
        OTHERS     = 2.
    IF sy-subrc <> 0.
      out->write( |${ERR_LINE_PREFIX}LIST_FROM_MEMORY sy-subrc = { sy-subrc } (1 = no list in ABAP memory)| ).
      RETURN.
    ENDIF.

    CALL FUNCTION 'LIST_TO_ASCI'
      EXPORTING
        list_index         = -1
      TABLES
        listobject         = lt_list
        listasci           = lt_txt
      EXCEPTIONS
        empty_list         = 1
        list_index_invalid = 2
        OTHERS             = 3.
    IF sy-subrc <> 0.
      out->write( |${ERR_LINE_PREFIX}LIST_TO_ASCI sy-subrc = { sy-subrc } (1 = empty list)| ).
      RETURN.
    ENDIF.

    LOOP AT lt_txt INTO DATA(lv_line).
      IF strlen( lv_line ) >= 1023.
        out->write( |${ERR_LINE_PREFIX}list line hit the 1023-char ${WIDTH_TRUNCATION_MARKER}| ).
      ENDIF.
      out->write( |${LIST_LINE_PREFIX}{ lv_line }| ).
    ENDLOOP.

  ENDMETHOD.

ENDCLASS.
`;
}

// ---------------------------------------------------------------------------
// List post-processing
// ---------------------------------------------------------------------------

/** A `LIST_TO_ASCI` rule line: the full list width in dashes, nothing else. */
const isRuleLine = (line: string): boolean => /^-{20,}$/.test(line.trim());

/**
 * ABAP's default list-header date, `DD.MM.YYYY`, anchored at the line's left
 * edge (where `sy-datum` goes) — a date anywhere else isn't header evidence.
 */
const LIST_HEADER_DATE_AT_START = /^\s*\d{2}\.\d{2}\.\d{4}\b/;
/** A trailing page number, right-padded then right-trimmed off the header. */
const LIST_HEADER_PAGE_NO = /\s\d+$/;

/**
 * F2/F6: line 0 must look like a genuine page header (both date-at-left AND
 * page-no-at-right) before it's eligible to be dropped. Used to be `||`,
 * which was a live false positive — `Total: 5` alone matched on trailing
 * number, `Posting date 01.01.2026` alone matched on date — silently eating a
 * report's first two real output lines when followed by its own rule line.
 * Requiring both errs safe: at worst, header furniture survives visibly.
 */
const looksLikeListPageHeader = (line: string): boolean =>
  LIST_HEADER_DATE_AT_START.test(line) && LIST_HEADER_PAGE_NO.test(line);

/**
 * Drop the two leading lines of a `LIST_TO_ASCI` result (page header + rule)
 * and trim the list-width right-padding.
 *
 *     31.07.2026        MCP write recon probe report        1     ← page header
 *     -------------------------------------------------------     ← rule
 *     ZMCP probe line 1                                           ← report's own output
 *
 * Conservative: only strips when line 2 is a rule line AND line 0 looks like
 * a page header (F2) — otherwise a report whose own first two lines are
 * text-then-rule would silently lose both. Non-list output is returned intact
 * apart from the right-trim. Removal is always exactly 2 lines or 0, never a
 * silent partial amount — callers can diff `lines.length` to detect it.
 */
export function stripListHeader(lines: string[]): string[] {
  // LIST_TO_ASCI right-pads every line to the list width.
  const out = lines.map((l) => l.replace(/[ \t\r ]+$/, ""));
  // …and pads the page out with blank lines. Trailing only — never internal.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();

  if (out.length >= 2 && out[0] !== "" && looksLikeListPageHeader(out[0]!) && isRuleLine(out[1]!)) {
    return out.slice(2);
  }
  return out;
}

/**
 * Split raw bridge output into captured list lines and driver diagnostics.
 *
 * F3: only genuine `ZMCP-ERR>` lines go into `diagnostics` — an unprefixed
 * non-blank line used to be mislabelled as one, hiding real bytes. Anything
 * that's neither a `LIST>` nor a `ZMCP-ERR>` line is counted into
 * `droppedLines` instead, so removal is disclosed, not silent. List lines are
 * never `.trim()`-ed, only prefix-stripped, so column alignment survives.
 */
export function splitBridgeOutput(
  raw: string,
): { list: string[]; diagnostics: string[]; droppedLines: number } {
  const list: string[] = [];
  const diagnostics: string[] = [];
  let droppedLines = 0;
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith(LIST_LINE_PREFIX)) {
      // Exactly one prefix — leading blanks of the list line are column
      // alignment and must survive.
      list.push(line.slice(LIST_LINE_PREFIX.length));
    } else if (line.replace(/\s+$/, "") === LIST_LINE_PREFIX.trimEnd()) {
      list.push(""); // an empty list line
    } else if (line.startsWith(ERR_LINE_PREFIX)) {
      diagnostics.push(line.trim());
    } else {
      // Neither LIST> nor ZMCP-ERR> (F3) — disclosed via droppedLines rather
      // than silently absorbed.
      droppedLines++;
    }
  }
  return { list, diagnostics, droppedLines };
}

/**
 * Parse the `key=[value] key=[value] …` bracket-field wire format the
 * generated bridges emit, into a plain record. Shared by `fpm-runtime.ts`
 * and `fpm-lock.ts` (previously duplicated and had drifted apart).
 *
 * An embedded `]` must not truncate the value — the naive `\[([^\]]*)\]`
 * stops at the first `]` and silently shortens e.g. a foreign lock's `garg`,
 * making it compare unequal to the real one. Instead matched LAZILY up to the
 * `]` followed by the next ` key=[` or end of line:
 *  - `garg=[AB]CD]`         -> `"AB]CD"` (embedded `]` preserved)
 *  - `garg=[A]B] gmode=[E]` -> `"A]B"` and `"E"` (fields still split)
 * Only unresolvable case: a value literally containing `] word=[`, which
 * cannot occur in any field these bridges emit.
 */
export function parseBracketFields(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)=\[(.*?)\](?=\s+\w+=\[|\s*$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Session handling — trap #1
// ---------------------------------------------------------------------------

/**
 * Mark the session dead **locally**, without a network call.
 *
 * `AdtHTTP.loggedin` is `csrfToken !== "fetch"`; resetting it forces the next
 * request to log on fresh rather than retry cookies the server already tore
 * down (eight requests were burned that way before this fix). Not a
 * credential retry — the breaker still governs the logon itself.
 */
function invalidateSession(conn: AbapConnection): void {
  try {
    conn.adt.httpClient.csrfToken = "fetch";
  } catch {
    /* breaker open — there is no session left to invalidate */
  }
}

// ---------------------------------------------------------------------------
// Failure classification — trap #2
// ---------------------------------------------------------------------------

interface RawResponse {
  status: number;
  headers: Record<string, unknown>;
  body: string;
  statusText?: string;
}

const isResponseLike = (v: unknown): v is { status: number; headers?: unknown; body?: unknown } =>
  typeof v === "object" && v !== null && typeof (v as { status?: unknown }).status === "number";

/**
 * Dig the raw HTTP response out of whatever `abap-adt-api` threw.
 *
 * There are two shapes depending on whether the transport threw or returned:
 *  - transport threw (axios ≥400)  → `AdtHttpException.parent.response`
 *  - transport returned the 500    → `AdtErrorException.response`
 * and `AbapError`s from our own guard carry nothing at all.
 */
function responseOf(e: unknown): RawResponse | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [e];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    const n = node as Record<string, unknown>;
    if (isResponseLike(node) && typeof n.body === "string") {
      return {
        status: n.status as number,
        headers: (n.headers as Record<string, unknown>) ?? {},
        body: n.body as string,
        statusText: typeof n.statusText === "string" ? n.statusText : undefined,
      };
    }
    queue.push(n.response, n.parent, n.request);
  }
  return undefined;
}

/**
 * `(termination: RABAX_STATE)` is ICM boilerplate glued onto the short text, and
 * `Error:` labels sometimes survive the page-to-text flattening. Neither is part
 * of the ABAP exception's short text.
 */
export function tidyShortText(text: string): string {
  const normalised = text
    .replace(/\(termination:[^)]*\)\s*$/i, "")
    .replace(/^(?:error|exception|fehler)\s*:\s*/i, "")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateText(normalised, DUMP_SHORT_TEXT_MAX);
}

/**
 * Turn whatever classrun threw into a structured error.
 *
 * Hard rules:
 *  - a short dump is `RUNTIME_DUMP` carrying `{shortText, serverTime}` and NO HTML;
 *  - a dead session is `SESSION_DEAD`, never an auth failure — a user's syntax
 *    mistake must not brick the server by tripping the circuit breaker;
 *  - the session is marked dead locally in both cases, because the server has
 *    already torn it down (`connection: close`).
 */
function translateRunFailure(conn: AbapConnection, className: string, e: unknown): AbapError {
  // Our own guard's errors (circuit open, …) are already correct — never
  // reinterpret them as a runtime problem.
  if (isAbapError(e)) return e;

  const resp = responseOf(e);
  const kind: SessionFailureKind | undefined = classifySessionFailure(resp);

  if (kind === "dump") {
    // The server already tore the session down (`connection: close`); make sure
    // nothing in this process ever tries the dead cookies again.
    invalidateSession(conn);
    const parsed = parseDumpPage(resp!.body);
    const shortText = parsed.shortText
      ? tidyShortText(parsed.shortText)
      : "(the ICM error page carried no exception short text)";
    const info: DumpInfo = {
      shortText,
      ...(parsed.serverTime ? { serverTime: parsed.serverTime } : {}),
    };
    // Deliberately does not fetch the dumps feed here — emit arguments, never
    // content. Two reasons hold: (1) the feed key (user, timestamp) provably
    // cannot disambiguate two dumps in the same second (measured 2026-08-11),
    // so an auto-fetched body would be a confident guess between candidates;
    // (2) this function is shared by six callers above the tool layer that
    // owns the safety gate, response budget and read-lane slot. NOT because of
    // feed latency — that was measured sub-second (173/218/385ms) and
    // disproven as a concern. Full history: the git history.
    const correlation = buildDumpCorrelation(parsed.serverTime, conn.cfg.user);
    return new AbapError(
      "RUNTIME_DUMP",
      `${className} short-dumped: ${shortText}`,
      {
        class: className,
        ...info,
        status: resp!.status,
        // Machine-readable so a v2 surface/orchestrator can act without
        // regex-scraping the hint prose.
        ...(correlation ? { dumpCorrelation: correlation } : {}),
      },
      dumpHint(correlation),
    );
  }

  if (kind === "session-timeout") {
    invalidateSession(conn);
    return new AbapError(
      "SESSION_DEAD",
      `The ABAP session was gone while running ${className} (HTTP ${resp!.status}, "Session Timed Out").`,
      { class: className, status: resp!.status, kind },
      "This is NOT an authentication failure and does not count against the logon-attempt " +
        "budget. The session has been discarded; retry the call and a fresh one is " +
        "established. If it recurs, something dumped just before this request.",
    );
  }

  // Anything else is an ordinary ADT failure. session.translateAdtError() owns
  // that mapping (and guarantees no raw XML/HTML crosses the boundary).
  return translateAdtError(e, {
    operation: "run class",
    name: className,
    uri: `${CLASSRUN_PATH}${className}`,
  });
}

// ---------------------------------------------------------------------------
// Body plausibility — trap #3 (F1)
// ---------------------------------------------------------------------------

/**
 * `abap-adt-api`'s `runClass()` does `return "" + response.body`, so a 200
 * with an absent/empty body, an ADT error envelope, or an ICF HTML page all
 * come back as ordinary strings — indistinguishable from real output unless
 * checked here. HTTP 200 proves the round trip succeeded, not that ABAP
 * produced output.
 */
const UNDEFINED_BODY_LITERAL = "undefined";
const XML_OR_HTML_BODY_PREFIX = /^(<\?xml|<!DOCTYPE|<html)/i;
const ADT_EXCEPTION_MARKER = /exc:exception|<exc:/i;

function bogusBodyReason(raw: string, trimmed: string): string | undefined {
  if (raw === UNDEFINED_BODY_LITERAL) return 'the body is the literal string "undefined" (an absent HTTP body)';
  if (ADT_EXCEPTION_MARKER.test(raw)) return "the body carries an ADT exception envelope (exc:exception)";
  if (XML_OR_HTML_BODY_PREFIX.test(trimmed)) return "the body is XML/HTML markup, not console output";
  return undefined;
}

/**
 * Throw when `raw` cannot plausibly be the class's own console output. A
 * genuinely empty body (`""`, `bodyBytes: 0`) is a legitimate run that
 * printed nothing and is NOT rejected here — only the shapes that are
 * indistinguishable-by-accident from a real 200 are (F1).
 */
function assertPlausibleRunOutput(className: string, raw: string, bodyBytes: number): void {
  const reason = bogusBodyReason(raw, raw.trim());
  if (!reason) return;

  throw new AbapError(
    "ADT_ERROR",
    `${className} returned HTTP 200, but ${reason} — the response is not usable as program output.`,
    { class: className, bodyBytes },
    "classrun returns 200 for both genuine output and an ADT error envelope / ICF error " +
      "page — the status code alone proves nothing. Treat this the same as a thrown ADT " +
      "error rather than trusting the body.",
  );
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Run an `IF_OO_ADT_CLASSRUN` class in a **fresh** session.
 *
 * `POST /sap/bc/adt/oo/classrun/{CLASSNAME}` — class name UPPERCASE in the
 * path, no body, no Content-Type. Success is `200 text/plain` whose body is the
 * raw console output and nothing else: no XML, no envelope.
 *
 * TIMEOUTS: the recon never exercised a server-side classrun timeout, so its
 * behaviour is unknown. No client-side timeout is imposed here beyond the
 * connection-wide one — a short timeout would abandon a running ABAP session
 * without stopping it, which is worse than waiting. Revisit once a long-running
 * classrun has actually been observed.
 */
export async function runClass(conn: AbapConnection, className: string): Promise<RunResult> {
  const name = assertPlainName(className, "Class name").toUpperCase();
  if (name.length > MAX_NAME) {
    throw new AbapError(
      "BAD_INPUT",
      `Class name ${name} is longer than ${MAX_NAME} characters.`,
      { class: name },
    );
  }

  const started = Date.now();
  // ⚠️ withFreshSession is NOT an optimisation target ⚠️ — classrun runs
  // whatever's in the session's program buffer, which after a PUT+activate
  // can be the stale implementation (verified: byte-identical wrong output,
  // HTTP 200). Every execution gets a fresh session unconditionally; skipping
  // it costs a tool that lies with a straight face.
  const raw = await conn.withFreshSession(async (client) => {
    try {
      return await client.runClass(name);
    } catch (e) {
      throw translateRunFailure(conn, name, e);
    }
  });

  // `client.runClass()` does `return "" + response.body`, so `raw` is always a
  // string — the old `typeof raw === "string" ? … : ""` branch was dead code.
  const bodyBytes = Buffer.byteLength(raw, "utf8");
  assertPlausibleRunOutput(name, raw, bodyBytes);

  const output = raw.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return {
    mode: "class",
    object: name,
    output,
    lines: output === "" ? 0 : output.split("\n").length,
    durationMs: Date.now() - started,
    droppedLines: 0,
    bodyBytes,
    // No visibility into ABAP-side width truncation for an arbitrary class
    // (only the report bridge, F5, can detect that) — so `true`.
    outputComplete: true,
  };
}

/**
 * F6 defence in depth: re-derive the activation verdict from
 * `ActivationOutcome`'s own fields rather than trusting a single upstream
 * boolean, and throw — never proceed to `runClass` — on anything short of
 * `activated === true`, no error message, and an empty inactive list.
 *
 * Redundant by construction today: given activate.ts's
 * `activated = result.success !== false && errors === 0 && inactive.length === 0`,
 * `assertNoErrors` (called immediately before this, at the only call site)
 * already guarantees this can't throw. Kept anyway as a cross-module
 * invariant check — cheap, no I/O — that fails loudly if a future change to
 * activate.ts (a file this module doesn't own) loosens how `activated` is
 * computed, e.g. dropping the `inactive.length === 0` conjunct.
 *
 * Exported and shared: `bopf-runtime.ts`, `fpm-runtime.ts`, `fpm-lock.ts` and
 * `enhancement-bridge.ts` used to each carry their own copy of this check —
 * five copies in two variants, one of which omitted the `inactive.length`
 * conjunct. `what` names the bridge in the error message, `details` carries
 * whatever the domain wants in the payload.
 */
export function verifyBridgeActivation(
  activation: ActivationOutcome,
  className: string,
  what: string,
  details?: Record<string, unknown>,
): true {
  const positiveEvidence =
    activation.activated === true && activation.errors === 0 && activation.inactive.length === 0;

  if (!positiveEvidence) {
    throw new AbapError(
      "CHECK_FAILED",
      `Activation of the generated ${what} ${className} could not be positively verified ` +
        "before executing it.",
      {
        bridgeClass: className,
        ...details,
        activated: activation.activated,
        errors: activation.errors,
        inactive: activation.inactive,
      },
      "Never executed: activation reported something short of unambiguous success (not " +
        "`activated === true`, or a non-empty inactive-objects list). Check the bridge " +
        "class in ADT before retrying.",
    );
  }

  return true;
}

// ---------------------------------------------------------------------------
// Bridge deploy / execute — the choreography every generated bridge shares
// ---------------------------------------------------------------------------

/** What varies between the callers of {@link deployBridge}; nothing else does. */
export interface DeployBridgeOptions {
  /** Generated class name. Must be `Z*` — the gate allowlists nothing else. */
  className: string;
  /** The generated ABAP source, already built by the caller. */
  source: string;
  /** `adtcore:description` for the created class. */
  description: string;
  /**
   * Defaults to {@link BRIDGE_PACKAGE}. A parameter and not a constant because
   * `enhancement-bridge.ts` names the same package through its own
   * `ENH_CREATE_PACKAGE` alias, and because the day the two diverge this is
   * where it has to be expressible.
   */
  packageName?: string;
  /** `assertNoErrors`' `what` — the caller's exact wording, per bridge. */
  what: string;
  /** `assertNoErrors`' `hint`, when the caller has a domain-specific cause. */
  hint?: string;
  /**
   * Domain check on the activation outcome, run after `assertNoErrors` and
   * before the caller may execute anything. Returns `true` or throws — never
   * reports a negative verdict by returning.
   */
  verify: (activation: ActivationOutcome) => true;
}

/** Proof that {@link deployBridge} ran, and the only input {@link executeBridge} takes. */
export interface DeployedBridge {
  className: string;
  /**
   * The target the SERVER resolved, carried out of `authorizeMutation` — not
   * the one the caller asked for. Every subsequent gate call names this one.
   */
  target: ResolvedTarget;
  write: WriteResult;
  /** `write.created || write.changed` — did the bridge have to be (re)generated? */
  bridgeRefreshed: boolean;
  /**
   * Only present when `activationSource === "post"`. Never fabricated on the
   * `"already-active"` path — there was no POST, so there is no outcome to report.
   */
  activation?: ActivationOutcome;
  /**
   * `"post"`: `activateObject` ran and {@link DeployBridgeOptions.verify}
   * judged its result. `"already-active"`: skipped — round trip 1's own
   * body already proved the active version is current, see F6 below.
   */
  activationSource: "post" | "already-active";
  /**
   * Always `true`: on `"post"`, `verify` threw otherwise; on `"already-active"`,
   * the `adtcore:version` evidence behind that source IS the positive evidence
   * `verifyBridgeActivation` would otherwise have demanded from a POST.
   */
  activationVerified: true;
}

/**
 * Write + activate + verify the generated bridge class. First half of the
 * choreography; {@link executeBridge} is the second.
 *
 * Ordering is not negotiable:
 *   1. `authorizeMutation(conn, gate, "write", …)` — resolve against the
 *      server FIRST, gate the package the object really lives in.
 *   2. `writeObject()` — create-if-missing, lock → PUT → unlock (skips the
 *      PUT when the content hash is unchanged, making per-run refresh cheap).
 *   3. `gate.assert("activate", …)` then `activateObject()` — OUTSIDE the
 *      lock (activating while holding it is a 403 ExceptionResourceNoAccess).
 *      Skipped when F6 already has positive evidence.
 *   4. `assertNoErrors` + `verify` — nothing executes on a single upstream
 *      boolean's word. Also skipped on the F6 skip path — nothing to verify.
 *
 * F7: the bridge class is a real repository object in a real package, so
 * running a bridge writes. This used to call `writeObject` directly on an
 * unauthorized target, leaving only an *optional* tools/run.ts check between
 * `abap_run` and writing to the customer's system. Routing through
 * `authorizeMutation` (like every other mutation in write.ts) is what makes
 * the productive-system lockout apply to `abap_run`, and it's authoritative
 * because it judges the package the SERVER reports, not the one requested.
 *
 * F6: bare `write.changed === false` still never skips activation — it can be
 * computed against an INACTIVE source read, so alone it doesn't prove the
 * active version is what's about to run. The POST is skipped ONLY alongside
 * `write.target.activation === "active-is-current"`: round trip 1's
 * own `adtcore:version` attributes, conservatively ANDed (write.ts,
 * `activationFromBody`), proving THAT SAME read was of the active version.
 * Activating an already-active object is an idempotent no-op either way.
 *
 * Rejected alternative (option B, a per-className memo): hit rate is
 * narrow (source varies per call even for fixed bridge class names), and it
 * is UNSAFE for those fixed names specifically — another process could put
 * different source under the same class, and a memo would skip the very read
 * that catches it, running the wrong bridge with HTTP 200. Not built.
 *
 * Shared, not copied: `bopf-runtime.ts`, `fpm-runtime.ts`, `fpm-lock.ts`,
 * `enhancement-bridge.ts` and `runReport` each used to carry their own copy
 * of these four steps. The deploy/execute split exists so BOPF's
 * `generateOnly` mode can skip {@link executeBridge} with no hook parameter.
 */
export async function deployBridge(
  conn: AbapConnection,
  gate: SafetyGate,
  opts: DeployBridgeOptions,
): Promise<DeployedBridge> {
  const { className, source } = opts;

  const authorized = await authorizeMutation(conn, gate, "write", {
    type: "CLAS/OC",
    name: className,
    packageName: opts.packageName ?? BRIDGE_PACKAGE,
    description: opts.description,
  });

  // NO_JOURNAL: this is a generated $TMP bridge, not a user object —
  // journalling it would fill abap_journal with machine-written scaffolding.
  const write = await writeObject(conn, authorized, {
    source,
    onBeforeImage: NO_JOURNAL,
  });

  // `writeObject` skips the PUT when the content hash is unchanged, so an
  // unchanged bridge costs no write. Activation itself is skipped only under
  // F6's positive evidence, below.
  const bridgeRefreshed = Boolean(write.created || write.changed);

  // F6: the activation POST is redundant when NOTHING changed AND
  // round trip 1's own body already showed the active version is current —
  // see the F6 paragraph above for why `changed: false` alone is not enough.
  const alreadyActive =
    !write.created && !write.changed && write.target.activation === "active-is-current";

  // From here, `write` has already landed — any throw leaves `className`
  // behind, written but not activated. ARCH-09 §5.6/P9: disclose that
  // residue rather than leaving the caller nothing to clean up. `stage` is
  // tracked as each step starts, not inferred from the caught error, so
  // disclosure names what actually ran.
  let stage: BridgeResidueStage = "activate-gate";
  try {
    // `activate` is a distinct gated operation (safety.ts `Operation`);
    // target is the server-resolved one, not the one requested. Asserted
    // even on the skip path — cheap (no I/O) and keeps the gate authoritative
    // over every deploy, POST or not.
    gate.assert("activate", {
      name: authorized.target.name,
      packageName: authorized.target.packageName,
      type: authorized.target.type,
    });

    if (alreadyActive) {
      return {
        className,
        target: authorized.target,
        write,
        bridgeRefreshed,
        activationSource: "already-active",
        activationVerified: true,
      };
    }

    stage = "activation";
    const activation = await activateObject(conn, write.target);
    assertNoErrors(activation, {
      what: opts.what,
      name: className,
      source,
      ...(opts.hint === undefined ? {} : { hint: opts.hint }),
    });

    stage = "verify";
    const activationVerified = opts.verify(activation);

    return {
      className,
      target: authorized.target,
      write,
      bridgeRefreshed,
      activation,
      activationSource: "post",
      activationVerified,
    };
  } catch (e) {
    throw discloseBridgeResidue(e, className, authorized.target.packageName, stage);
  }
}

/** Which post-write step {@link discloseBridgeResidue} caught the failure in. */
type BridgeResidueStage = "activate-gate" | "activation" | "verify";

/**
 * ARCH-09 §5.6/P9: once `writeObject` succeeds, any failure below it leaves
 * `className` behind in `packageName`. Disclosure, not deletion — deleting it
 * would destroy an artefact a developer might want to inspect — so this only
 * adds facts to the existing error; `code`/`message` stay untouched since
 * callers/tests branch on `code`.
 *
 * `stage` (not the caught error's `code`) decides the wording, since only
 * `stage` says what actually ran. Only called from the catch below
 * `writeObject` — a refusal from `authorizeMutation` must reach the caller
 * unchanged, so this isn't hoisted to wrap the whole function.
 */
function discloseBridgeResidue(
  e: unknown,
  className: string,
  packageName: string,
  stage: BridgeResidueStage,
): unknown {
  if (!isAbapError(e)) return e; // every step above throws AbapError; anything else passes through untouched.

  const outcome =
    stage === "activate-gate"
      ? "was blocked before activation could run; it is left behind there, inactive"
      : stage === "activation"
        ? "failed to activate; it is left behind there, inactive"
        : "activated, then failed post-activation verification; it is left behind there";

  const residueHint = `Bridge class ${className} was written to ${packageName} but ${outcome} — safe to delete.`;

  const disclosed = new AbapError(
    e.code,
    e.message,
    { ...e.details, bridgeClass: className, bridgeLeftBehind: true },
    e.hint ? `${e.hint} ${residueHint}` : residueHint,
  );
  disclosed.stack = e.stack;
  disclosed.cause = e.cause;
  return disclosed;
}

/**
 * Run a bridge {@link deployBridge} just deployed, in a fresh session — what
 * makes the difference between running the code just activated and quietly
 * re-running the previous version.
 *
 * F8: executing is a THIRD distinct mutating operation from write/activate;
 * it used to be reachable with only those two gated, since nothing gated the
 * POST to `${CLASSRUN_PATH}${className}` itself. `gate.authorize("execute", …)`
 * both asserts and mints the proof, and using the minted target's own name
 * (not `deployed.className`) is what makes `runClass` unreachable here
 * without that call.
 *
 * Takes a {@link DeployedBridge}, not a name, for the same reason one level
 * up: no way to spell "execute" without first proving written+activated+verified.
 *
 * `runClass` already wraps in `conn.withFreshSession(...)` — no extra
 * wrapping needed. Caller parses `run.output` itself.
 */
export async function executeBridge(
  conn: AbapConnection,
  gate: SafetyGate,
  deployed: DeployedBridge,
): Promise<RunResult> {
  const executeAuthorization = gate.authorize("execute", {
    name: deployed.target.name,
    packageName: deployed.target.packageName,
    type: deployed.target.type,
  });

  return runClass(conn, executeAuthorization.target.name);
}

/**
 * Generate/refresh the report bridge class, then run it.
 *
 * The write → activate → verify → gate → run choreography lives in
 * {@link deployBridge} / {@link executeBridge}; read those before changing
 * anything here. What is local to a report is the SUBMIT-shaped hint, the
 * `LIST>`/`ZMCP-ERR>` transcript split and the list-header strip.
 */
export async function runReport(
  conn: AbapConnection,
  reportName: string,
  gate: SafetyGate,
  parameters: readonly RunParameterInput[] = [],
): Promise<RunResult> {
  const started = Date.now();
  const report = assertPlainName(reportName, "Report name").toUpperCase();
  // Marshal BEFORE anything touches the wire: every malformed value/range is
  // refused right here, as a `BAD_INPUT`, never as ABAP that goes on to dump.
  const rows = marshalSelectionTable(parameters);
  const className = bridgeClassName(report);
  const source = bridgeClassSource(className, report, rows);

  const deployed = await deployBridge(conn, gate, {
    className,
    source,
    description: `abapsmith run bridge for report ${report}`,
    what: "Activation of the generated run bridge",
    hint:
      `The bridge SUBMITs ${report} by name, so the usual cause is that ${report} does ` +
      "not exist, is not a report, or is itself inactive." +
      (rows.length > 0
        ? ` It also populates a selection table with ${rows.length} row(s) — a value that does ` +
          "not fit the target field can dump here even when the report itself is fine."
        : ""),
    verify: (activation) => verifyBridgeActivation(activation, className, "run bridge", { report }),
  });
  const { bridgeRefreshed, activationVerified: bridgeActivationVerified } = deployed;

  const run = await executeBridge(conn, gate, deployed);
  const { list, diagnostics, droppedLines: bridgeDroppedLines } = splitBridgeOutput(run.output);
  const beforeHeaderStrip = list.length;
  const stripped = stripListHeader(list);
  const headerDroppedLines = beforeHeaderStrip - stripped.length;
  const output = stripped.join("\n");
  // F5: the bridge discloses width truncation via a ZMCP-ERR> diagnostic —
  // surface that as `outputComplete: false` rather than leaving it buried in
  // `diagnostics` for the caller to notice on their own.
  const outputComplete = !diagnostics.some((d) => d.includes(WIDTH_TRUNCATION_MARKER));

  return {
    mode: "report",
    object: report,
    output,
    lines: stripped.length,
    // F4: the full write → activate → run round trip, not just the classrun leg.
    durationMs: Date.now() - started,
    droppedLines: bridgeDroppedLines + headerDroppedLines,
    bodyBytes: run.bodyBytes,
    outputComplete,
    bridgeClass: className,
    bridgeRefreshed,
    bridgeActivationVerified,
    ...(diagnostics.length ? { diagnostics } : {}),
  };
}
