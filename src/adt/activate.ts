/**
 * Syntax check (`checkruns`) + activation + message rendering — the text a
 * model reads after a failed edit, so line numbers must be correct.
 *
 * Key facts (full evidence: the git history):
 *  1. Activation failures return HTTP 200. Success = 200 + empty body; syntax
 *     errors = 200 + an `application/xml` `chkl:messages` body. Never trust
 *     the status code — always parse the body.
 *  2. `msg/@line` is the message ORDINAL, not the source line — the real
 *     position is only in `@href`'s `#start=line,col` fragment. Everything
 *     here goes through `parseStartFragment`, never reads `@line`.
 *  3. `checkruns` beats activate-and-read-errors on every axis (no lock/write,
 *     faster, correct position, reports `W` that activation swallows) —
 *     `checkSource` is the intended pre-flight.
 *  4. A rejected DDIC source PUT carries no line/column of its own;
 *     `checkSource` is also how a failed PUT gets explained after the fact.
 *
 * Nothing in this module ever hands raw ADT XML upward.
 */
import type {
  ActivationResult,
  ActivationResultMessage,
  InactiveObjectElement,
  InactiveObjectRecord,
} from "abap-adt-api/build/api/activate.js";
import type { SyntaxCheckResult } from "abap-adt-api/build/api/syntax.js";
import { fullParse, xmlArray, xmlNode, xmlNodeAttr } from "abap-adt-api/build/utilities.js";
import type { AbapConnection } from "./connection.js";
import type { ResolvedTarget } from "./write.js";
import { AbapError, describeUnknownError, isAbapError } from "./errors.js";
import { truncateForDisplay, ECHO_LINE_MAX } from "../truncate.js";
import { elide } from "../debug/render.js";
import { specForType } from "./types.js";
import { normaliseRevisions } from "./revisions.js";

export interface AdtMessage {
  severity: string;
  /** Real source line, parsed out of the href fragment. */
  line?: number;
  col?: number;
  text: string;
  objDescr?: string;
  uri?: string;
  forceSupported?: boolean;
}

export interface CheckOutcome {
  ok: boolean;
  messages: AdtMessage[];
  errors: number;
  warnings: number;
}

/** One entry of `<ioc:inactiveObjects>` — a dependent still inactive. `uri` is optional; response shape only partly verified, see `mapInactiveObjects`. */
export interface InactiveObjectRef {
  name: string;
  type: string;
  uri?: string;
}

export interface ActivationOutcome extends CheckOutcome {
  activated: boolean;
  /** `<ioc:inactiveObjects>` — activation refused because dependents are inactive. */
  inactive: InactiveObjectRef[];
  /** The preaudit reply's object set, set only when a second POST naming it was actually sent. */
  preaudit?: InactiveObjectRef[];
}

/**
 * Minimal shape needed to POST `activation?method=activate` and name the
 * object in errors. Deliberately not `ResolvedTarget` — callers like
 * `./bopf.ts`'s `activateBusinessObject` rarely have write-path fields
 * (`sourceUri`/`packageSource`) on hand. Any `ResolvedTarget` satisfies this
 * structurally, so existing callers pass it unchanged.
 */
export interface ActivationTarget {
  name: string;
  uri: string;
  /**
   * ADT type code, e.g. `DOMA/DD`. Optional (minimal shape), but populated in
   * practice since most callers pass a `ResolvedTarget`. Missing/unrecognised
   * is treated as fan-out-prone by `isFanoutProneType` — the safe direction
   * to be wrong in.
   */
  type?: string;
}

// ------------------------------------------------------------- primitives ---

/**
 * `[EAX]` = failure, exactly as `abap-adt-api`'s own success computation does
 * it (`api/activate.js`: `if (m.type.match(/[EAX]/)) success = false`). `W` and
 * `I` are reported but do not fail anything.
 */
export function isFailureSeverity(severity: string | undefined): boolean {
  return /[EAX]/.test(String(severity ?? "").toUpperCase());
}

/**
 * `…/source/main#start=4,0` → `{ line: 4, col: 0 }`; `undefined` when the href
 * carries no fragment. Aligned with `parseFragmentRange` in `./source.ts` and
 * `abap-adt-api`'s `api/syntax.js`, but column is optional here — activation
 * hrefs are the one place a bare `#start=<line>` has been seen, and losing the
 * line to a missing column is the exact failure this module exists to prevent.
 */
export function parseStartFragment(
  href: string | undefined,
): { line: number; col: number } | undefined {
  if (!href) return undefined;
  const m = /#start=(\d+)(?:,(\d+))?/.exec(String(href));
  if (!m) return undefined;
  const line = Number(m[1]);
  if (!Number.isFinite(line) || line <= 0) return undefined;
  return { line, col: m[2] ? Number(m[2]) : 0 };
}

/** Exported so `enhancement-bridge.ts` can compute the same counts without duplicating this loop. */
export function tally(messages: AdtMessage[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const m of messages) {
    if (isFailureSeverity(m.severity)) errors++;
    else if (String(m.severity).toUpperCase() === "W") warnings++;
  }
  return { errors, warnings };
}

// ------------------------------------------------------------- rendering ---

/** E/A/X first, then W, then I, then anything else. */
function severityRank(severity: string): number {
  const s = String(severity ?? "").toUpperCase();
  if (/[EAX]/.test(s)) return 0;
  if (s === "W") return 1;
  if (s === "I") return 2;
  return 3;
}

/**
 * Compact, model-facing rendering — the payload a model self-corrects from.
 * Priorities: correct line numbers, offending source line inlined, brevity.
 *
 * Shape (stable and greppable — `^[EWIAX] line \d+` matches every message):
 *
 *     E line 5 col 0  The statement "WRIT" is not expected. …
 *          5 |   WRIT 'hello'.
 *            |   ^
 *
 * Rules: errors before warnings, then ascending line, ties keep server order
 * (stable sort). Source echo only when `source` is supplied; a repeated line
 * echoes once. `objDescr` prefixed only when the batch spans multiple objects.
 * When any message carries `forceSupported`, one trailing line is appended
 * after the whole block. Never XML, never JSON.
 */
export function renderMessages(messages: AdtMessage[], source?: string): string {
  if (messages.length === 0) return "";

  const ordered = messages
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const bySeverity = severityRank(a.m.severity) - severityRank(b.m.severity);
      if (bySeverity !== 0) return bySeverity;
      const byLine = (a.m.line ?? Number.MAX_SAFE_INTEGER) - (b.m.line ?? Number.MAX_SAFE_INTEGER);
      if (byLine !== 0) return byLine;
      const byCol = (a.m.col ?? 0) - (b.m.col ?? 0);
      if (byCol !== 0) return byCol;
      return a.i - b.i;
    })
    .map((x) => x.m);

  const lines = source === undefined ? undefined : source.replace(/\r\n/g, "\n").split("\n");
  const objects = new Set(ordered.map((m) => m.objDescr).filter(Boolean));
  const showObj = objects.size > 1;
  const gutter = String(Math.max(...ordered.map((m) => m.line ?? 0), 0)).length;

  const out: string[] = [];
  let lastEchoed: number | undefined;

  for (const m of ordered) {
    const sev = String(m.severity ?? "?").toUpperCase();
    const where =
      m.line === undefined
        ? "(no position)"
        : `line ${m.line}${m.col === undefined ? "" : ` col ${m.col}`}`;
    const who = showObj && m.objDescr ? `[${m.objDescr}] ` : "";
    out.push(`${sev} ${where}  ${who}${m.text}`);

    if (!lines || m.line === undefined) continue;
    if (m.line === lastEchoed) continue;
    const raw = lines[m.line - 1];
    if (raw === undefined) continue;

    // Long generated lines (DDIC, string templates) would blow the budget.
    const clipped = truncateForDisplay(raw, ECHO_LINE_MAX);
    const pad = " ".repeat(gutter);
    out.push(`  ${String(m.line).padStart(gutter)} | ${clipped}`);
    const col = m.col ?? 0;
    if (col <= clipped.length) {
      // Column is 0-based in the ADT fragment; the caret sits under it.
      out.push(`  ${pad} | ${" ".repeat(col)}^`);
    }
    lastEchoed = m.line;
  }

  // `forceSupported`: appended as a single trailing line after the whole
  // block, so per-message rendering stays byte-identical. A model never told
  // the option exists cannot be told we refuse it.
  if (ordered.some((m) => m.forceSupported)) {
    out.push(
      "The ABAP system reports that this activation could be forced; " +
        "abapsmith does not force activation.",
    );
  }

  return out.join("\n");
}

/**
 * Caller-facing rendering of `<ioc:inactiveObjects>` — one `type name` per
 * line plus what to do. Separate from `renderMessages`: inactive dependents
 * carry no severity/line/source. Empty list ⇒ empty string.
 */
export function renderInactive(inactive: ReadonlyArray<InactiveObjectRef>): string {
  if (inactive.length === 0) return "";
  const { objects, unnamed } = displayInactive(inactive);
  if (objects.length === 0) {
    // Every entry was unnamed (see displayInactive) — still must say
    // something, never "0 dependent objects are still inactive".
    return unnamed === 1
      ? "1 dependent object is still inactive, but SAP's reply named neither it nor its type."
      : `${unnamed} dependent objects are still inactive, but SAP's reply named neither them nor their types.`;
  }
  const head =
    objects.length === 1
      ? "1 dependent object is still inactive:"
      : `${objects.length} dependent objects are still inactive:`;
  const lines = [
    head,
    ...objects.map((o) => `  ${o.type} ${o.name}`),
    "Activate them first, or activate them together with this object.",
  ];
  if (unnamed > 0) {
    lines.push(
      `${unnamed} more inactive dependent${unnamed === 1 ? "" : "s"} had no name/type in SAP's ` +
        `reply and ${unnamed === 1 ? "is" : "are"} omitted above.`,
    );
  }
  return lines.join("\n");
}

export interface InactiveDisplay {
  /** Distinct named objects, first occurrence kept (so it keeps that entry's uri). */
  objects: InactiveObjectRef[];
  /** Entries SAP's reply gave no usable name or type for. Counted, never presented as objects. */
  unnamed: number;
}

/**
 * Collapses `<ioc:inactiveObjects>` for a human reader. The fragment-keyed
 * request set (`activationRefKey`/`preauditActivationSet`) is right for
 * building a request but wrong for counting objects for a person: SAP's
 * preaudit reply lists a function group's generated sub-includes as
 * separate entries for the SAME `FUGR/F`, which live-observed turned one
 * inactive object into "4 dependent objects" (live-observed). Dedup by
 * name+type, case-insensitively — deliberately not by uri, since the same
 * object's different parts arrive under different uris.
 */
export function displayInactive(inactive: readonly InactiveObjectRef[]): InactiveDisplay {
  const objects: InactiveObjectRef[] = [];
  const seen = new Set<string>();
  let unnamed = 0;
  for (const ref of inactive) {
    const name = String(ref.name ?? "").trim();
    const type = String(ref.type ?? "").trim();
    if ((name === "(unknown)" && type === "(unknown)") || (!name && !type)) {
      unnamed++;
      continue;
    }
    const key = `${name.toLowerCase()} ${type.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    objects.push(ref);
  }
  return { objects, unnamed };
}

/** One-line summary, e.g. `2 errors, 1 warning`. Empty when there is nothing. */
export function summariseMessages(outcome: CheckOutcome): string {
  const parts: string[] = [];
  if (outcome.errors) parts.push(`${outcome.errors} error${outcome.errors === 1 ? "" : "s"}`);
  if (outcome.warnings)
    parts.push(`${outcome.warnings} warning${outcome.warnings === 1 ? "" : "s"}`);
  const other = outcome.messages.length - outcome.errors - outcome.warnings;
  if (other > 0) parts.push(`${other} info`);
  return parts.join(", ");
}

/**
 * Structured error for a classified failure. `details.messages` carries
 * rendered text (never XML); `details.raw` keeps parsed messages for callers.
 */
export function checkFailedError(
  outcome: CheckOutcome,
  context: { what: string; name?: string; source?: string; hint?: string } = { what: "Check" },
): AbapError {
  const rendered = renderMessages(outcome.messages, context.source);
  return new AbapError(
    "CHECK_FAILED",
    `${context.what}${context.name ? ` of ${context.name}` : ""} failed: ` +
      `${summariseMessages(outcome) || "no details returned"}.`,
    {
      ...(context.name ? { object: context.name } : {}),
      summary: summariseMessages(outcome),
      messages: rendered,
      raw: outcome.messages,
    },
    context.hint ??
      "Fix the reported lines and write again. Line numbers come from the ADT " +
        "href fragment, not from the message ordinal, so they are the real source lines.",
  );
}

/** Structural narrowing: only an activation outcome carries `activated`. */
export function isActivationOutcome(o: CheckOutcome): o is ActivationOutcome {
  return "activated" in o;
}

/** How many inactive dependents are named in the thrown message; the rest are counted. */
const INACTIVE_NAMES_IN_MESSAGE = 10;

/**
 * Throw `CHECK_FAILED` unless the outcome is genuinely clean.
 *
 * `errors > 0` alone is NOT sufficient on an activation: it can fail with zero
 * `[EAX]` messages (bare `success: false`, or inactive dependents), and a
 * caller that then executes the object (`run.ts`) would read the STALE
 * previously-active output as fresh. So any outcome that is not `activated`
 * throws here — the single place every caller funnels through. See archive
 * for the full incident reasoning.
 */
export function assertNoErrors<T extends CheckOutcome>(
  outcome: T,
  context: { what: string; name?: string; source?: string; hint?: string },
): T {
  if (outcome.errors > 0) throw checkFailedError(outcome, context);
  if (!isActivationOutcome(outcome) || outcome.activated) return outcome;

  const name = context.name ?? "the object";
  const details: Record<string, unknown> = {
    object: context.name,
    activated: false,
    inactive: outcome.inactive,
    errors: outcome.errors,
    warnings: outcome.warnings,
  };

  if (outcome.inactive.length > 0) {
    // Message count/list are the DEDUPED objects (displayInactive) — the raw
    // list above (`details.inactive`) stays the wire evidence, but repeating
    // one FUGR/F's generated sub-includes three times over in prose is the
    // exact miscount this dedup avoids.
    const { objects, unnamed } = displayInactive(outcome.inactive);
    const named = objects.slice(0, INACTIVE_NAMES_IN_MESSAGE).map((o) => `${o.type} ${o.name}`);
    const rest = objects.length - named.length;
    // Capped for readability; the cut is disclosed twice ("+N more" and via
    // elide()) — the full list is always present in `inactiveRendered`/`hint`.
    const namedList =
      rest > 0
        ? `${named.join(", ")}, +${rest} more (${elide(
            "dependent objects",
            rest,
            "this error's hint field, which lists every inactive object",
          )})`
        : named.join(", ");
    // When the preaudit handshake already ran, "activate them together with
    // this object" is advice the caller has no way to follow — abapsmith
    // already named every object ADT's own preaudit reply listed, and it is
    // STILL reporting these inactive. That is the FUGR/F fan-out's corollary:
    // say what actually happened instead of repeating unfollowable advice.
    const hint =
      context.hint ??
      (outcome.preaudit && outcome.preaudit.length > 0
        ? "abapsmith already re-sent the activation naming every object ADT's preaudit reply " +
          "listed, and a re-check still reports these as inactive — one of them cannot activate. " +
          "Check them individually with `abap_activate mode=check`."
        : renderInactive(outcome.inactive));
    throw new AbapError(
      "CHECK_FAILED",
      objects.length === 0 && unnamed > 0
        ? `${context.what} failed: ${name} was NOT activated. SAP's reply listed ${unnamed} ` +
          `inactive dependent${unnamed === 1 ? "" : "s"} but gave no name or type for ` +
          `${unnamed === 1 ? "it" : "them"}.`
        : `${context.what} failed: ${name} was NOT activated because ` +
          `${objects.length} dependent object${objects.length === 1 ? " is" : "s are"} ` +
          `still inactive (${namedList}).`,
      { ...details, inactiveRendered: renderInactive(outcome.inactive) },
      hint,
    );
  }

  if (outcome.messages.length === 0) {
    // Defensive: activation refused with neither messages nor inactive objects.
    // Never observed; surfaced rather than silently reported as success.
    throw new AbapError(
      "CHECK_FAILED",
      `Activation of ${name} reported failure without any message.`,
      details,
      context.hint ?? "Re-run the syntax check; the object is still inactive.",
    );
  }

  // Not activated, no inactive dependents, but there ARE messages (e.g. a
  // `W`-only body with `success: false`). Render normally, say plainly not active.
  const base = checkFailedError(outcome, context);
  throw new AbapError(
    "CHECK_FAILED",
    `${base.message} ${name} was NOT activated.`,
    { ...base.details, ...details },
    base.hint,
  );
}

// --------------------------------------------------------------- mapping ---

/**
 * `checkSource`/`checkruns` false positives that are known, on this system, to
 * be advisory rather than blocking — SAP's `abapCheckRun` reporter marks them
 * `E`, but they do not stop the object from activating.
 *
 * Evidenced case: `ZTM_S_ORDER` (`TABL/DS`) got severity `E` for "Tab.
 * ZTM_S_ORDER is of type INTTAB (Technical settings are not meaningful)", yet
 * activated cleanly moments later with zero messages. Matched on message TEXT
 * (not the stable T100 key — `abap-adt-api`'s `parseCheckResults` discards it
 * before this module sees the message; see archive). Keep this list narrow —
 * add only an actually-observed pattern, never a general "looks advisory"
 * heuristic.
 */
const KNOWN_ADVISORY_CHECK_MESSAGES: RegExp[] = [
  /^Tab\.\s+\S+\s+is of type INTTAB\s*\(Technical settings are not meaningful\)/i,
];

/** True when `text` matches a known-advisory `checkSource` false positive (see above). */
function isKnownAdvisoryCheckMessage(text: string): boolean {
  return KNOWN_ADVISORY_CHECK_MESSAGES.some((re) => re.test(text));
}

/**
 * `SyntaxCheckResult[]` → `AdtMessage[]`.
 *
 * Verified against `abap-adt-api`'s `parseCheckResults` (`api/syntax.js`):
 * reads `@chkrun:type`/`@chkrun:shortText` and the position from
 * `@chkrun:uri`'s `#start=` fragment — no `@line` ordinal trap on this path.
 * `line: 0, offset: 0` (no fragment) is normalised to `undefined` here so the
 * renderer says "(no position)" rather than pointing at line 0.
 *
 * A message matching `KNOWN_ADVISORY_CHECK_MESSAGES` is downgraded to `I`
 * (still reported, never dropped) so it no longer counts as a blocking error.
 */
export function mapCheckResults(results: SyntaxCheckResult[]): AdtMessage[] {
  return results.map((r) => ({
    severity: isKnownAdvisoryCheckMessage(String(r.text ?? ""))
      ? "I"
      : String(r.severity ?? "E").toUpperCase(),
    // `fullParse` has `parseAttributeValue: true`, so a purely numeric shortText
    // would arrive as a number — String() keeps the renderer total.
    text: String(r.text ?? "").trim(),
    ...(r.line > 0 ? { line: r.line, col: r.offset ?? 0 } : {}),
    ...(r.uri ? { uri: r.uri } : {}),
  }));
}

/**
 * `ActivationResult.messages[]` → `AdtMessage[]`.
 *
 * `m.line` is deliberately never read — it's the message ordinal, not a
 * source line; position comes only from `m.href`'s `#start=` fragment.
 */
export function mapActivationMessages(result: ActivationResult): AdtMessage[] {
  return (result.messages ?? []).map((m) => {
    const pos = parseStartFragment(m.href);
    return {
      severity: String(m.type ?? "E").toUpperCase(),
      text: String(m.shortText ?? "Syntax error").trim(),
      ...(pos ? { line: pos.line, col: pos.col } : {}),
      ...(m.objDescr ? { objDescr: String(m.objDescr) } : {}),
      ...(m.href ? { uri: String(m.href) } : {}),
      ...(m.forceSupported ? { forceSupported: true } : {}),
    };
  });
}

/**
 * `<ioc:inactiveObjects>` → a flat list.
 *
 * The shape itself is live-observed (probed directly with curl
 * against a real system); the exact `ioc:entry`/`ioc:object` nesting below
 * still comes from `abap-adt-api`'s `parseInactive`, not from a captured
 * body, so parsing follows it defensively rather than a verified fixture.
 *
 * An entry with no object node is kept as `(unknown)`/`(unknown)`, NOT
 * dropped — dropping would make the list length (what `activateObject`/
 * `assertNoErrors` gate on) depend on how well an unverified shape parses,
 * so a real failure could look clean. See archive for full reasoning.
 */
export function mapInactiveObjects(result: ActivationResult): InactiveObjectRef[] {
  return (result.inactive ?? []).map((rec) => {
    const o = rec.object;
    if (!o) return { name: "(unknown)", type: "(unknown)" };
    return {
      name: String(o["adtcore:name"] ?? ""),
      type: String(o["adtcore:type"] ?? ""),
      ...(o["adtcore:uri"] ? { uri: String(o["adtcore:uri"]) } : {}),
    };
  });
}

// ----------------------------------------------------------- checkruns ---

/**
 * True when `abap-adt-api` would route this URL to the CDS syntax-check
 * variant instead of the generic one — the two take arguments in opposite
 * order (`(artifact, checkObject)` vs `(checkObject, artifact)`), so the
 * caller must know which it is about to hit. Regex copied from `AdtClient.js`.
 */
const isCdsCheckUrl = (url: string): boolean =>
  /^\/sap\/bc\/adt\/((ddic\/ddlx?)|(acm\/dcl))\/sources\//.test(url);

/**
 * `POST /sap/bc/adt/checkruns?reporters=abapCheckRun` with source inline as
 * base64 — no lock, no write, no state change. Safe on unsaved source, which
 * is what makes it a *pre*-flight. Implemented on `abap-adt-api`'s
 * `syntaxCheck`.
 */
export async function checkSource(
  conn: AbapConnection,
  target: ResolvedTarget,
  source: string,
): Promise<CheckOutcome> {
  const objectUri = target.uri;
  const artifactUri = target.sourceUri || `${target.uri}/source/main`;

  let results: SyntaxCheckResult[];
  try {
    // Library dispatches on the FIRST argument: generic wants (artifact,
    // checkObject), CDS wants the reverse — swapped silently produces a
    // request with check-object/artifact reversed. DDLS/DDLX take the CDS
    // branch, SRVD the generic one; neither branch is live-verified through
    // this specific pre-flight call (see archive).
    results = isCdsCheckUrl(artifactUri)
      ? await conn.adt.syntaxCheck(objectUri, artifactUri, source)
      : await conn.adt.syntaxCheck(artifactUri, objectUri, source);
  } catch (e) {
    if (isAbapError(e)) throw e; // circuit breaker et al. pass through untouched
    throw new AbapError(
      "ADT_ERROR",
      `Syntax check of ${target.name} failed to run: ${describeUnknownError(e)}`,
      { object: target.name, uri: objectUri },
      "checkruns neither locks nor writes, so this is a transport/endpoint " +
        "problem, not a source problem. The object may not be a type the " +
        "abapCheckRun reporter supports.",
    );
  }

  const messages = mapCheckResults(results);
  const counts = tally(messages);
  // Clean source answers with an empty `chkrun:checkRunReports` envelope, which
  // parses to zero messages — that is the success case, not an error.
  return { ok: counts.errors === 0, messages, ...counts };
}

export interface FormatOutcome {
  source: string;
  changed: boolean;
  linesChanged: number;
}

/**
 * `POST /sap/bc/adt/abapsource/prettyprinter` — *format* verb only, never
 * `setPrettyPrinterSetting` (a system-wide team-editor setting). Stateless,
 * no lock. A falsy/empty response from the vendor's `prettyPrinter()` echoes
 * input back, reported here as benign `changed: false`, not a failure.
 */
export async function prettyPrintSource(
  conn: AbapConnection,
  source: string,
): Promise<FormatOutcome> {
  let formatted: string;
  try {
    formatted = await conn.adt.prettyPrinter(source);
  } catch (e) {
    if (isAbapError(e)) throw e; // circuit breaker et al. pass through untouched
    throw new AbapError(
      "ADT_ERROR",
      `Pretty-print failed to run: ${describeUnknownError(e)}`,
      {},
      "prettyprinter neither locks nor writes, so this is a transport/endpoint " +
        "problem, not a source problem.",
    );
  }

  // SAP's prettyprinter always answers CRLF regardless of input; this
  // codebase is LF-only. Left as-is it would persist CRLF to the server and
  // corrupt line endings on a later edit. Normalise BEFORE diffing.
  formatted = formatted.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const changed = formatted !== source;
  let linesChanged = 0;
  if (changed) {
    const inputLines = source.split("\n");
    const outputLines = formatted.split("\n");
    const commonLen = Math.min(inputLines.length, outputLines.length);
    let differing = 0;
    for (let i = 0; i < commonLen; i++) {
      if (inputLines[i] !== outputLines[i]) differing++;
    }
    linesChanged = differing + Math.abs(inputLines.length - outputLines.length);
  }

  return { source: formatted, changed, linesChanged };
}

// ---------------------------------------------------------- activation ---

/**
 * `POST /sap/bc/adt/activation?method=activate&preauditRequested=true`.
 *
 * Object must NOT be locked: activating while holding your own lock returns
 * `403 ExceptionResourceNoAccess` ("User X is currently editing…"), translated
 * to `LOCKED` here since it reads like someone else's conflict but is usually
 * self-inflicted. Order: lock → PUT → **unlock** → activate.
 *
 * Result classification: empty body ⇒ activated (the only success signal,
 * status is 200 either way); any `[EAX]` message ⇒ not activated; `W`-only ⇒
 * **activated, with warnings**; `ioc:inactiveObjects` triggers a second POST
 * naming the full preaudit set (see `activateWithPreauditSet`). If THAT POST
 * also answers a success-shaped empty 200, it still isn't trusted — the seeds'
 * OWN version history is read back as a verification (an empty
 * phase-two 200 is byte-identical to the no-op an incomplete set gets, AND —
 * live-observed — to a `FUGR/F` reply that lists generated sub-includes
 * whether or not the group is active, so re-running phase one as the
 * verification is itself unreliable for that type). Only history that
 * SURVIVES this sequence with a `99999` row means not activated.
 */

/**
 * A phase-two POST names objects to the SAP-side activation worklist, which
 * takes its own enqueue on each — separate from any lock abapsmith itself
 * holds (`abap_activate` takes none). If the handshake still ends
 * not-activated that enqueue has nowhere else to go: live-observed as
 * `Object LIMU REPS L<group>UXX is already locked` on every later write into
 * the same function group (live-observed). abapsmith has no handle on
 * that enqueue directly — an ADT lock lives and dies with its
 * `sap-contextid` (`connection.ts`, `withStatefulSession`), so discarding
 * the session is the only lever available. Skipped whenever a caller's own
 * stateful session is live, since dropping it would strand THAT session's
 * locks instead. This is the lever, not a proven fix — its effect on this
 * specific enqueue has not been live-verified.
 *
 * Exported so `./enhancement-bridge.ts`'s joint spot+implementation POST can
 * run the same cleanup on the same not-activated condition.
 */
export async function releaseActivationEnqueues(conn: AbapConnection): Promise<void> {
  if (conn.heldLockUris().length > 0) return;
  try {
    await conn.dropSession();
  } catch {
    // Must never surface: this runs after activation has already failed, and
    // a cleanup error here must not replace or mask that failure.
  }
}

export async function activateObject(
  conn: AbapConnection,
  target: ActivationTarget,
): Promise<ActivationOutcome> {
  let result: ActivationResult;
  try {
    // preaudit `true` — the shape the recon exercised end to end.
    result = await conn.adt.activate(target.name, target.uri, undefined, true);
  } catch (e) {
    if (isAbapError(e)) throw e;
    throw translateActivationError(e, target);
  }

  let preaudit: InactiveObjectRef[] | undefined;
  try {
    const phase2 = await activateWithPreauditSet(conn, [target], result);
    if (phase2) {
      result = phase2.result;
      preaudit = phase2.preaudit;
    }
  } catch (e) {
    if (isAbapError(e)) throw e;
    throw translateActivationError(e, target);
  }

  const messages = mapActivationMessages(result);
  const inactive = mapInactiveObjects(result);
  const counts = tally(messages);

  // ANDed with the library's own classification, so disagreement only ever
  // makes us more pessimistic.
  const activated = result.success !== false && counts.errors === 0 && inactive.length === 0;

  // A phase-two POST was actually sent (`preaudit` set) and it still didn't
  // end activated: whatever enqueue it took server-side is now stranded.
  if (preaudit && !activated) await releaseActivationEnqueues(conn);

  return {
    activated,
    ok: counts.errors === 0 && inactive.length === 0,
    messages,
    inactive,
    ...counts,
    ...(preaudit ? { preaudit } : {}),
  };
}

// ------------------------------------------------- batch activation ---

/**
 * Escapes the characters that would break the hand-built XML below. Names/URIs
 * are code-controlled, but escaping costs nothing and matches every other
 * hand-built XML body in this codebase. Moved here from `./enhancement-bridge.ts`.
 */
export function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The activation request body for one or more objects: `adtcore:uri` and
 * `adtcore:name` only.
 *
 * Do not "simplify" this back onto the vendor's array-form
 * `activate(InactiveObject[])` — it unconditionally emits `adtcore:type`/
 * `adtcore:parentUri` even as empty strings, and SAP hard-rejects those with
 * an HTTP 400 that isn't a classifiable activation-message failure (live-
 * verified against A4H, see archive). Hand-built and posted through
 * `conn.post` for that reason. The single-object `activateObject` above
 * still uses the vendor's STRING overload, which is correct and untouched.
 */
export function buildActivationBody(targets: readonly ActivationTarget[]): string {
  const refs = targets
    .map(
      (t) =>
        `<adtcore:objectReference adtcore:uri="${escapeXmlAttr(t.uri)}" adtcore:name="${escapeXmlAttr(t.name)}"/>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">${refs}</adtcore:objectReferences>`
  );
}

/**
 * `<ioc:object>`/`<ioc:transport>` → `{ deleted, user, ...refAttrs }`, or
 * `undefined` with no `ioc:ref`. Vendor's private `toElement` logic
 * (`api/activate.js`), reproduced (not exported) so the parse below matches
 * `InactiveObjectRecord`.
 */
function toActivationElement(source: unknown): InactiveObjectElement | undefined {
  const s = source as Record<string, unknown> | undefined;
  if (!s || !s["ioc:ref"]) return undefined;
  return {
    deleted: s["@_ioc:deleted"],
    user: s["@_ioc:user"],
    ...xmlNodeAttr(s["ioc:ref"]),
  } as InactiveObjectElement;
}

/** `<ioc:inactiveObjects>` → `InactiveObjectRecord[]`. Vendor's `parseInactive`, reproduced for the same reason as {@link toActivationElement}. */
function parseInactiveObjects(raw: unknown): InactiveObjectRecord[] {
  return xmlArray(raw, "ioc:inactiveObjects", "ioc:entry").map((obj: unknown) => ({
    object: toActivationElement(xmlNode(obj, "ioc:object")),
    transport: toActivationElement(xmlNode(obj, "ioc:transport")),
  }));
}

/**
 * Raw activation response body → the same `ActivationResult` shape
 * `conn.adt.activate()` returns, so downstream mapping needs no changes.
 * Reproduces the vendor's parse using the SAME utilities, not a second parser.
 */
export function parseActivationResponse(body: string): ActivationResult {
  let messages: ActivationResultMessage[] = [];
  let success = true;
  let inactive: InactiveObjectRecord[] = [];
  if (body) {
    const raw = fullParse(body);
    inactive = parseInactiveObjects(raw);
    messages = xmlArray(raw, "chkl:messages", "msg").map((m: unknown) => {
      const rec = m as Record<string, unknown>;
      const message = xmlNodeAttr(rec) as ActivationResultMessage;
      const shortTextNode = rec["shortText"] as { txt?: string } | undefined;
      message.shortText = shortTextNode?.txt || "Syntax error";
      return message;
    });
    if (inactive.length > 0) {
      success = false;
    } else {
      for (const m of messages) {
        if (/[EAX]/.test(String(m.type))) {
          success = false;
          break;
        }
      }
    }
  }
  return { messages, success, inactive };
}

/**
 * An ADT URI reduced to the form attribution compares: lowercased,
 * `#fragment`/`?query` removed, trailing `/` removed. ADT is inconsistent
 * about name-segment case between hrefs and metadata, so both sides of the
 * comparison go through this or messages silently go unattributed.
 */
export function normaliseAdtUri(uri: string | undefined): string {
  if (!uri) return "";
  return (String(uri).split("#")[0] ?? "").split("?")[0]!.replace(/\/+$/, "").toLowerCase();
}

/**
 * Dedup key for the activation-set builder, where `normaliseAdtUri` is wrong.
 * ADT addresses a class's methods and its public/protected/private section
 * parts at one `.../source/main` URI distinguished only by the fragment
 * (`#type=CLAS%2FOSI;name=…` vs `#type=CLAS%2FOM;name=…`). The same shape is
 * visible in `test/fixtures/live-captured/382-ut-testrun.xml`, where a local
 * test class and two of its methods share `.../includes/testclasses` and
 * differ only after the `#`. Stripping the fragment — correct in
 * `normaliseAdtUri`, whose job is message attribution — collapses those refs
 * into one, so the phase-two set silently loses the section parts.
 */
export function activationRefKey(uri: string | undefined): string {
  if (!uri) return "";
  const s = String(uri);
  const cut = s.indexOf("#");
  return cut === -1 ? normaliseAdtUri(s) : normaliseAdtUri(s.slice(0, cut)) + s.slice(cut).toLowerCase();
}

/** Shared by both activation phases. Does not catch — callers keep their own error translation. */
async function postActivation(
  conn: AbapConnection,
  targets: readonly ActivationTarget[],
  preauditRequested: boolean,
): Promise<ActivationResult> {
  const resp = await conn.post("/sap/bc/adt/activation", {
    qs: { method: "activate", preauditRequested: preauditRequested ? "true" : "false" },
    headers: { "Content-Type": "application/xml", Accept: "application/xml" },
    body: buildActivationBody(targets),
  });
  return parseActivationResponse(resp.body);
}

export interface PreauditSet {
  /** Seeds in the order given, then every preaudit ref carrying a uri, de-duplicated by `activationRefKey`. */
  targets: ActivationTarget[];
  /** Preaudit entries with no `adtcore:uri` — they cannot be named in a request. */
  unaddressable: number;
}

/**
 * The full second-phase POST set: `seeds` plus every addressable ref from
 * `inactive`, de-duplicated by `activationRefKey` — SAP repeats sub-parts
 * across preaudit entries (the same include reached via two parents), and a
 * raw string compare is not enough since it is also inconsistent about
 * name-segment case. The key keeps the URI fragment: a class's method refs
 * and its section-part refs (`CLAS/OSI`/`OSO`/`OSU`) share one `source/main`
 * URI and differ only there, so collapsing on the fragment-stripped form
 * (as `normaliseAdtUri` does) would silently drop them from the set.
 */
export function preauditActivationSet(
  seeds: readonly ActivationTarget[],
  inactive: readonly InactiveObjectRef[],
): PreauditSet {
  const targets: ActivationTarget[] = [...seeds];
  const seen = new Set<string>(seeds.map((s) => activationRefKey(s.uri)));
  let unaddressable = 0;
  for (const ref of inactive) {
    if (!ref.uri) {
      unaddressable++;
      continue;
    }
    const key = activationRefKey(ref.uri);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ name: ref.name, uri: ref.uri, ...(ref.type ? { type: ref.type } : {}) });
  }
  return { targets, unaddressable };
}

/**
 * `InactiveObjectRef` → the `InactiveObjectRecord` shape `mapInactiveObjects`
 * expects, so a version-history-derived verdict can flow back through the
 * same `ActivationResult`/`mapInactiveObjects` pipeline as a wire reply
 * instead of a parallel one. Same cast-a-partial-shape pattern as
 * {@link toActivationElement} above, for the same reason: the full
 * `InactiveObjectElement` carries fields (`user`, `deleted`, `adtcore:parentUri`)
 * this module never has values for.
 */
function toInactiveRecord(ref: InactiveObjectRef): InactiveObjectRecord {
  return {
    object: {
      "adtcore:name": ref.name,
      "adtcore:type": ref.type,
      ...(ref.uri ? { "adtcore:uri": ref.uri } : {}),
    } as InactiveObjectElement,
  };
}

/**
 * Ground truth for `activateWithPreauditSet`'s verification step: does EACH
 * seed's own version history still carry a `99999` (INACTIVE) row?
 *
 * A seed whose history can't be read (`revisions()` throws — no versions
 * link, or the type doesn't carry one) tells us nothing either way and is
 * skipped, not counted as inactive. `undefined` means NO seed's state could
 * be read at all: that's inconclusive, not evidence of failure.
 */
async function seedsStillInactive(
  conn: AbapConnection,
  seeds: readonly ActivationTarget[],
): Promise<InactiveObjectRef[] | undefined> {
  let anyReadable = false;
  const stillInactive: InactiveObjectRef[] = [];
  for (const seed of seeds) {
    let entries;
    try {
      entries = normaliseRevisions(await conn.adt.revisions(seed.uri));
    } catch {
      continue;
    }
    anyReadable = true;
    if (entries.some((e) => e.kind === "inactive")) {
      stillInactive.push({ name: seed.name, type: seed.type ?? "", uri: seed.uri });
    }
  }
  return anyReadable ? stillInactive : undefined;
}

/**
 * Phase two of the activation handshake, plus a verification read. Phase two
 * is sent only when the preaudit reply carries no `[EAX]` message of its own
 * (a real error means the source is broken, not that a bigger set would help)
 * and the preaudit set genuinely adds refs beyond `seeds` — re-posting only
 * the original refs answers a success-shaped empty 200 while activating
 * nothing (confirmed by curl probe, row 3). The whole set goes in ONE POST and is
 * deliberately not run through `chunkActivationTargets`: DDIC chunking
 * bounds a caller-sized request, but this set's size is dictated by the
 * server's own reply, and splitting it reproduces that same silent no-op.
 *
 * A phase-two reply is trusted directly only when it describes itself as a
 * failure. An empty 200 is re-checked against the seeds' OWN state; see below.
 *
 * Exported so `./enhancement-bridge.ts`'s joint spot+implementation POST can
 * share it: the joint body it re-sends is `buildActivationBody`, the same
 * builder phase one uses, so naming both seeds plus the preaudit set in one
 * POST keeps the two objects joint.
 */
export async function activateWithPreauditSet(
  conn: AbapConnection,
  seeds: readonly ActivationTarget[],
  first: ActivationResult,
): Promise<{ result: ActivationResult; preaudit: InactiveObjectRef[] } | undefined> {
  if (first.inactive.length === 0) return undefined;
  if (tally(mapActivationMessages(first)).errors > 0) return undefined;

  const preaudit = mapInactiveObjects(first);
  const set = preauditActivationSet(seeds, preaudit);
  if (set.targets.length <= seeds.length) return undefined;

  const second = await postActivation(conn, set.targets, false);
  if (second.inactive.length > 0 || tally(mapActivationMessages(second)).errors > 0) {
    return { result: second, preaudit };
  }

  // An empty phase-two 200 used to be re-checked by re-POSTing phase one on
  // the seeds and reading ITS `ioc:inactiveObjects` again — but that reply
  // describes the PREAUDIT DOCUMENT, not the object's state, and for a
  // `FUGR/F` those are different things: a function group's phase-one reply
  // lists its SAP-generated sub-includes (`L<name>TOP`, `L<name>UXX`)
  // whether or not the group is active. Live-observed: activating a
  // genuinely-active `ZTMD_HS358B_FG` got CHECK_FAILED off exactly that
  // reply, naming one object four times over, while version history showed
  // a single `00000 ACTIVE` row and no `99999`, `mode=check` was clean, and
  // the active source matched what was written. Version history is the
  // object's OWN state and was right in that same run, so that's what this
  // reads now.
  //
  // No seed readable at all (`seedsStillInactive` → `undefined`) is treated
  // as belief, not failure: phase two already named the COMPLETE
  // fragment-keyed set (`preauditActivationSet`), and an empty 200 to that
  // set is ADT's success shape — the alternative read (silent no-op) is what
  // this whole handshake exists to catch, and it already didn't happen here.
  // `test/fixtures/revisions/` holds four live A4H captures, all
  // active-shaped (`00000` plus released versions, never a `99999` row) — no
  // capture on file actually contains an INACTIVE entry, so the inactive
  // direction below is inferred from `revisionKind`, not measured live.
  const stillInactive = await seedsStillInactive(conn, seeds);
  if (stillInactive === undefined || stillInactive.length === 0) {
    return {
      // Phase two's own messages — warnings, typically — would otherwise be
      // dropped on the floor by a clean verification.
      result: { messages: second.messages, success: second.success, inactive: [] },
      preaudit,
    };
  }
  return {
    result: {
      messages: second.messages,
      success: false,
      inactive: stillInactive.map(toInactiveRecord),
    },
    preaudit,
  };
}

/**
 * True when `href` addresses `targetUri` or something inside it — exact
 * match or a match at a PATH SEGMENT boundary. The boundary is load-bearing:
 * plain `startsWith` would attribute `.../zfoo_long` to `.../zfoo`, blaming a
 * sibling for a prefix-sharing name — the normal case in a DDIC dependent set.
 */
function uriAddresses(href: string, targetUri: string): boolean {
  if (!href || !targetUri) return false;
  return href === targetUri || href.startsWith(`${targetUri}/`);
}

/**
 * Which of `targets` a message belongs to, or `undefined` when unclear.
 *
 * Two signals, in order, no third:
 *  1. **`href`** — the message's `#start=`-bearing URI; longest matching
 *     target URI wins, so a container and something inside it attribute to
 *     the more specific one.
 *  2. **`objDescr`** — SAP's prose label, consulted only with no usable href,
 *     matched whole-word, accepted only when exactly one target matches
 *     (prose is locale-dependent and distrusted for classification here).
 *
 * Anything else is `undefined` — **reported unattributed, never guessed onto
 * the first target**: a caller told the wrong object failed edits the wrong
 * source. See {@link activateObjects} for how unattributed messages still
 * fail the batch.
 */
export function attributeToTarget(
  message: Pick<AdtMessage, "uri" | "objDescr">,
  targets: readonly ActivationTarget[],
): ActivationTarget | undefined {
  const href = normaliseAdtUri(message.uri);
  if (href) {
    let best: ActivationTarget | undefined;
    let bestLen = -1;
    for (const t of targets) {
      const key = normaliseAdtUri(t.uri);
      if (uriAddresses(href, key) && key.length > bestLen) {
        best = t;
        bestLen = key.length;
      }
    }
    if (best) return best;
  }

  const descr = String(message.objDescr ?? "").toUpperCase();
  if (descr) {
    const hits = targets.filter((t) => {
      const name = t.name.trim().toUpperCase();
      if (!name) return false;
      // Whole-word: `ZFOO` must not match inside `ZFOO_ID`. `\b` is wrong here
      // because `_` is a word character in JS regex while it is part of an ABAP
      // identifier, so `\bZFOO\b` happily matches `ZFOO_ID`.
      return new RegExp(`(^|[^A-Z0-9_])${escapeRegExp(name)}([^A-Z0-9_]|$)`).test(descr);
    });
    if (hits.length === 1) return hits[0];
  }

  return undefined;
}

/** Regex-literalises a name for the whole-word `objDescr` probe above. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One member of a batch activation, with only the messages that are provably its own. */
export interface ObjectActivation {
  target: ActivationTarget;
  /** Whether THIS object is now active; `false` whenever the batch as a whole did not activate — see {@link BatchActivationOutcome}. */
  activated: boolean;
  /** No `[EAX]` message and no inactive-dependent entry was attributed to this object. */
  ok: boolean;
  messages: AdtMessage[];
  errors: number;
  warnings: number;
  inactive: InactiveObjectRef[];
}

/**
 * The outcome of one multi-object activation request.
 *
 * Extends `ActivationOutcome` so existing consumers see the WHOLE batch:
 * totals across all objects plus anything unattributed — keeping the failure
 * rule conservative, since an unplaced error still counts in `errors`.
 *
 * `perObject` splits the same messages by provable owner; `unattributed`
 * holds the rest — together exactly `messages`, no overlap.
 *
 * `ObjectActivation.activated` is the BATCH's verdict repeated, not a
 * per-object observation: the response never states per object "this one
 * went active". `activated: false` with `ok: true` means "nothing wrong with
 * this object, but its state is not confirmed" — callers needing certainty
 * must read the object back.
 */
export interface BatchActivationOutcome extends ActivationOutcome {
  targets: readonly ActivationTarget[];
  perObject: ObjectActivation[];
  /** Messages the response did not tie to any named target. Counted in the totals above. */
  unattributed: AdtMessage[];
  /** Inactive-dependent entries not tied to any named target. Counted in `inactive`. */
  unattributedInactive: InactiveObjectRef[];
}

/**
 * Refuse a batch naming the same object twice — a caller mistake that would
 * make per-object attribution ambiguous by construction.
 */
function assertNoDuplicates(targets: readonly ActivationTarget[]): void {
  const seen = new Map<string, string>();
  for (const t of targets) {
    const key = normaliseAdtUri(t.uri) || t.name.trim().toUpperCase();
    const prev = seen.get(key);
    if (prev !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `Activation set names the same object twice: ${prev} and ${t.name} both resolve to ${key}.`,
        { duplicate: t.name, alsoNamed: prev, uri: t.uri },
        "List each object once. Activation order inside the set does not matter — the server " +
          "resolves the dependencies itself — so a repeat buys nothing.",
      );
    }
    seen.set(key, t.name);
  }
}

/**
 * Upper bound on the SIZE of an `objects` array in one `abap_activate` call —
 * an input-shape ceiling (caller can't name a thousand refs), not a
 * per-request POST size. NOT the number of objects in one HTTP POST to
 * `/sap/bc/adt/activation` — that's chunked much smaller for DDIC types by
 * `isFanoutProneType`/`chunkActivationTargets` below; see that doc comment
 * before lowering this instead of chunking.
 */
export const MAX_ACTIVATION_BATCH = 50;

/**
 * Does activating this ADT type run through the classic ABAP Dictionary
 * mass-activation utility — and is it therefore subject to the SAP-internal
 * async-RFC fan-out this module chunks around?
 *
 * ## The incident (DDIC mass-activation fan-out)
 *
 * A single `abap_activate` batch of 47 DDIC objects took the A4H appliance
 * down: SAP's DDIC mass-activation utility (RADMASUTC) fans one activation
 * call out server-side into concurrent loopback async RFCs (one per
 * app-server instance, to invalidate the DD buffer cache); enough of them
 * saturated the appliance's dialog work processes from a single client
 * request. Full trace in the archive.
 *
 * **The multiplication happens server-side, after our POST is on the wire —
 * client-side concurrency was never the binding constraint.** Do not raise
 * `maxDdicActivationBatch` on "our concurrency is low" reasoning; the only
 * sound axis is the TARGET system's spare dialog capacity.
 *
 * ## Why chunk instead of lowering `MAX_ACTIVATION_BATCH`
 *
 * A flat cap low enough for DDIC would also cripple batches of classes/
 * programs, which never showed this problem — so the batch is split by type:
 * DDIC-mode types travel in small chunks (`maxDdicActivationBatch`, default
 * 5), everything else in much larger ones (`maxSafeActivationBatch`, 50).
 *
 * ## Classification
 *
 * Reuses `TypeSpec.mode` from `src/adt/types.ts`: `"ddic"` ⇒ fan-out-prone.
 * Evidenced for `TABL/DT`, `TABL/DS`, `DTEL/DE`, `DOMA/DD`, `TTYP/DA`; the
 * rest of `mode: "ddic"` is unconfirmed but grouped in anyway (errs toward
 * the DDIC chunk). `DDLS/DF` (CDS) is deliberately safe — a different compile
 * pipeline, already `mode: "source"`. Missing/unrecognised `type` ⇒
 * fan-out-prone, the conservative default.
 */
export function isFanoutProneType(type: string | undefined): boolean {
  const spec = specForType(type);
  if (!spec) return true;
  return spec.mode === "ddic";
}

/** Per-class chunk sizes {@link chunkActivationTargets} splits a batch by. */
export interface ActivationChunkSizes {
  /** Cap for targets where {@link isFanoutProneType} is true. */
  ddic: number;
  /** Cap for every other target. */
  safe: number;
}

/**
 * Splits an authorised activation set into the ordered sub-batches
 * `activateObjects` POSTs, one request per chunk.
 *
 * Order-preserving: a boundary is drawn only where the running chunk would
 * exceed its class's cap, or the next target's class differs. Consecutive
 * same-class targets under the cap share one chunk/POST, keeping a dependent
 * trio (domain → data element → table) together in the normal all-DDIC case.
 * A set that is BOTH mutually dependent AND straddles the DDIC/non-DDIC
 * boundary genuinely splits — a dependency in a later chunk fails the same
 * way a missing object would, attributed normally.
 *
 * Zero targets / non-positive caps are already rejected by the caller
 * (`activateObjects`); not re-guarded here.
 */
export function chunkActivationTargets(
  targets: readonly ActivationTarget[],
  sizes: ActivationChunkSizes,
): ActivationTarget[][] {
  const chunks: ActivationTarget[][] = [];
  let current: ActivationTarget[] = [];
  let currentFanoutProne: boolean | undefined;
  let currentCap = 0;

  for (const t of targets) {
    const fanoutProne = isFanoutProneType(t.type);
    const cap = fanoutProne ? sizes.ddic : sizes.safe;
    const startsNewChunk =
      current.length === 0 || currentFanoutProne !== fanoutProne || current.length >= currentCap;
    if (startsNewChunk) {
      if (current.length) chunks.push(current);
      current = [];
      currentFanoutProne = fanoutProne;
      currentCap = cap;
    }
    current.push(t);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * `POST /sap/bc/adt/activation?method=activate&preauditRequested=true` naming
 * EVERY target of ONE CHUNK in ONE request — same endpoint as
 * `activateObject`. `targets` may be split into several such requests; see
 * `chunkActivationTargets`/`isFanoutProneType` for why and how. A chunk whose
 * reply carries a genuine preaudit set gets one further POST naming that
 * chunk's full set, via `activateWithPreauditSet` — same handshake as
 * `activateObject`, bounded to the chunk rather than the whole batch.
 *
 * Matches what SE80/Eclipse do for an unchunked set: a mutually-dependent
 * group (domain → data element → table) is activated as one unit by the
 * server, which resolves order itself — `targets` order only decides
 * `perObject` presentation.
 *
 * Failure classification is `activateObject`'s, ANDed across every chunk.
 * Attribution is resolved against the FULL original `targets` list, so a
 * message about an object from a LATER chunk still lands correctly.
 *
 * Chunks are POSTed strictly SEQUENTIALLY, never concurrently — concurrent
 * POSTs would multiply the very server-side fan-out this function bounds.
 *
 * Takes no `SafetyGate`: authorisation is per object and belongs to the
 * caller (`src/tools/activate.ts` resolves-and-authorises the whole set
 * before calling this), so one forbidden object refuses everything.
 */
export async function activateObjects(
  conn: AbapConnection,
  targets: readonly ActivationTarget[],
): Promise<BatchActivationOutcome> {
  if (targets.length === 0) {
    throw new AbapError(
      "BAD_INPUT",
      "Activation set is empty; there is nothing to activate.",
      { count: 0 },
      "Name at least one object.",
    );
  }
  if (targets.length > MAX_ACTIVATION_BATCH) {
    throw new AbapError(
      "BAD_INPUT",
      `Activation set has ${targets.length} objects; the limit for one call is ${MAX_ACTIVATION_BATCH}.`,
      { count: targets.length, limit: MAX_ACTIVATION_BATCH },
      `Split it into sets of at most ${MAX_ACTIVATION_BATCH}. Keep mutually dependent objects ` +
        "together in the same set.",
    );
  }
  assertNoDuplicates(targets);

  const chunks = chunkActivationTargets(targets, {
    ddic: conn.cfg.maxDdicActivationBatch,
    safe: conn.cfg.maxSafeActivationBatch,
  });

  // --- buckets keyed by the ORIGINAL targets, filled across every chunk ---
  const buckets = new Map<ActivationTarget, { messages: AdtMessage[]; inactive: InactiveObjectRef[] }>();
  for (const t of targets) buckets.set(t, { messages: [], inactive: [] });
  const unattributed: AdtMessage[] = [];
  const unattributedInactive: InactiveObjectRef[] = [];
  const allMessages: AdtMessage[] = [];
  const allInactive: InactiveObjectRef[] = [];
  const allPreaudit: InactiveObjectRef[] = [];
  let anyChunkFailed = false;

  // Operational visibility only — never gates behaviour, silent in the
  // common single-chunk case. Same stderr fallback `AbapConnection` uses
  // internally; used directly here since `log` is private to that class.
  if (chunks.length > 1) {
    process.stderr.write(
      `[abapsmith] activation batch of ${targets.length} split into ${chunks.length} chunks ` +
        `(DDIC-aware chunking): sizes ${chunks.map((c) => c.length).join(", ")}\n`,
    );
  }

  for (const chunk of chunks) {
    let result: ActivationResult;
    try {
      result = await postActivation(conn, chunk, true);
      const phase2 = await activateWithPreauditSet(conn, chunk, result);
      if (phase2) {
        result = phase2.result;
        allPreaudit.push(...phase2.preaudit);
      }
    } catch (e) {
      if (isAbapError(e)) throw e;
      // Attributed to THIS CHUNK, not `targets[0]`: a transport failure on
      // the request is not evidence about any one member.
      throw translateActivationError(e, {
        name: chunk.map((t) => t.name).join(" + "),
        uri: chunk[0]!.uri,
      });
    }

    const messages = mapActivationMessages(result);
    const inactive = mapInactiveObjects(result);
    if (result.success === false) anyChunkFailed = true;
    allMessages.push(...messages);
    allInactive.push(...inactive);

    for (const m of messages) {
      const owner = attributeToTarget(m, targets);
      if (owner) buckets.get(owner)!.messages.push(m);
      else unattributed.push(m);
    }
    for (const i of inactive) {
      // Same two attribution signals as a message (URI, name standing in for
      // `objDescr`): a member of THIS batch is its own problem; an outside
      // object is a genuine external dependency belonging to the batch as a whole.
      const owner = attributeToTarget({ uri: i.uri, objDescr: i.name }, targets);
      if (owner) buckets.get(owner)!.inactive.push(i);
      else unattributedInactive.push(i);
    }
  }

  const counts = tally(allMessages);
  const activated = !anyChunkFailed && counts.errors === 0 && allInactive.length === 0;

  // At least one chunk's phase-two POST was actually sent (`allPreaudit`)
  // and the batch still didn't end activated: same stranded server-side
  // enqueue as `activateObject` — see `releaseActivationEnqueues`.
  if (allPreaudit.length > 0 && !activated) await releaseActivationEnqueues(conn);

  const perObject: ObjectActivation[] = targets.map((target) => {
    const b = buckets.get(target)!;
    const c = tally(b.messages);
    const objOk = c.errors === 0 && b.inactive.length === 0;
    return {
      target,
      // See BatchActivationOutcome: the batch's verdict, not a per-object
      // observation. Never `true` for a member of a batch that failed.
      activated: activated && objOk,
      ok: objOk,
      messages: b.messages,
      inactive: b.inactive,
      ...c,
    };
  });

  return {
    activated,
    ok: counts.errors === 0 && allInactive.length === 0,
    messages: allMessages,
    inactive: allInactive,
    ...counts,
    ...(allPreaudit.length ? { preaudit: allPreaudit } : {}),
    targets,
    perObject,
    unattributed,
    unattributedInactive,
  };
}

/** Structural narrowing: only a batch outcome carries `perObject`. */
export function isBatchActivationOutcome(o: CheckOutcome): o is BatchActivationOutcome {
  return "perObject" in o;
}

/**
 * Caller-facing per-object breakdown of a batch activation. Every named
 * object gets a line even when it has nothing to say — a list that omits the
 * quiet ones can't answer "which of the five did I get told about".
 * Unattributed messages get their own labelled final section.
 */
export function renderBatch(outcome: BatchActivationOutcome): string {
  const lines: string[] = [];
  for (const o of outcome.perObject) {
    const summary = summariseMessages(o) || (o.ok ? "clean" : "not activated");
    lines.push(`## ${o.target.name} — ${summary}${o.ok ? "" : "  <- BLAMED"}`);
    const text = renderMessages(o.messages);
    if (text.trim()) lines.push(text);
    if (o.inactive.length) lines.push(renderInactive(o.inactive));
  }
  if (outcome.unattributed.length || outcome.unattributedInactive.length) {
    lines.push(
      `## (unattributed) — ${outcome.unattributed.length} message(s), ` +
        `${outcome.unattributedInactive.length} inactive dependent(s)`,
      "The server did not tie these to any object in the set. They are NOT assigned to a " +
        "guessed owner, and they still count against the activation.",
    );
    const text = renderMessages(outcome.unattributed);
    if (text.trim()) lines.push(text);
    if (outcome.unattributedInactive.length) lines.push(renderInactive(outcome.unattributedInactive));
  }
  return lines.join("\n");
}

/**
 * `assertNoErrors` for a batch: same rule, but names WHICH objects were
 * blamed and carries the per-object breakdown in the thrown `CHECK_FAILED`.
 * Delegates the pass/fail decision to `assertNoErrors`; only enriches the error.
 */
export function assertBatchActivated(
  outcome: BatchActivationOutcome,
  context: { what: string } = { what: "Activation" },
): BatchActivationOutcome {
  if (outcome.activated && outcome.errors === 0) return outcome;

  const blamed = outcome.perObject.filter((o) => !o.ok);
  const names = blamed.map((o) => o.target.name);
  const unplaced = outcome.unattributed.length + outcome.unattributedInactive.length;
  const who =
    names.length > 0
      ? `${names.join(", ")} ${names.length === 1 ? "was" : "were"} blamed`
      : "no object could be blamed";
  const tail =
    unplaced > 0
      ? ` ${unplaced} message(s) could not be tied to any object in the set and are reported as unattributed.`
      : "";

  throw new AbapError(
    "CHECK_FAILED",
    `${context.what} of ${outcome.targets.length} objects failed: ` +
      `${summariseMessages(outcome) || "no details returned"}; ${who}.${tail}`,
    {
      activated: false,
      objects: outcome.targets.map((t) => t.name),
      blamed: names,
      unattributedCount: unplaced,
      summary: summariseMessages(outcome),
      perObject: outcome.perObject.map((o) => ({
        object: o.target.name,
        ok: o.ok,
        errors: o.errors,
        warnings: o.warnings,
        messages: o.messages,
        inactive: o.inactive,
      })),
      unattributed: outcome.unattributed,
      messages: renderBatch(outcome),
    },
    names.length > 0
      ? `Fix ${names.join(", ")} and activate the set again. The whole set is still inactive — ` +
        "objects with no messages of their own were not confirmed activated either, so re-activate " +
        "the complete set rather than only the objects you edited."
      : "The activation failed without naming an object in the set. Re-read the objects to see " +
        "which are still inactive, and check the unattributed messages above.",
  );
}

/** 403-while-locked and friends → structured errors instead of ADT prose. */
export function translateActivationError(e: unknown, target: ActivationTarget): AbapError {
  const err = e as { err?: number; status?: number; type?: string; message?: string };
  const status = Number(err?.err ?? err?.status ?? 0);
  const type = String(err?.type ?? "");
  const text = describeUnknownError(e);

  if (status === 403 && (/ResourceNoAccess/i.test(type) || /currently editing/i.test(text))) {
    return new AbapError(
      "LOCKED",
      `Cannot activate ${target.name}: the object is locked (${text}).`,
      { object: target.name, uri: target.uri, adtType: type || undefined },
      "You cannot activate an object while holding its own lock. " +
        "Unlock first: lock → PUT source → unlock → activate. If the lock " +
        "is held elsewhere, it must be released there: ADT locks bind to a " +
        "SESSION (`sap-contextid`), not a user, so the holder may be another " +
        "session of the SAME user (e.g. a stale editor tab), not necessarily a " +
        "different person.",
    );
  }

  return new AbapError(
    "ADT_ERROR",
    `Activation of ${target.name} failed: ${text}`,
    { object: target.name, uri: target.uri, status: status || undefined, adtType: type || undefined },
    "Activation returns 200 for syntax errors, so a thrown error here is a " +
      "transport/authorisation problem rather than a source problem.",
  );
}

/**
 * Recommended sequence for a caller that just wrote source: pre-flight with
 * `checkruns` (cheap, correct line numbers, catches warnings activation
 * swallows), activate only when clean. On a failed pre-flight throws
 * `CHECK_FAILED` without touching server state. Both stages gated by the
 * same `assertNoErrors`; this function adds no rules of its own.
 */
export async function checkThenActivate(
  conn: AbapConnection,
  target: ResolvedTarget,
  source: string,
): Promise<ActivationOutcome> {
  const pre = await checkSource(conn, target, source);
  assertNoErrors(pre, { what: "Syntax check", name: target.name, source });

  const act = await activateObject(conn, target);
  // Warnings surviving the pre-flight are returned, not thrown on: a `W`-only
  // activation IS activated.
  return assertNoErrors(act, { what: "Activation", name: target.name, source });
}
