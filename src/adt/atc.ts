/**
 * ATC (ABAP Test Cockpit) static analysis over ADT — the I/O layer.
 *
 * Composes the pure modules beside it — `atc-query.ts` (paths, URLs, run
 * body) and `atc-xml.ts` (parsing) — against the wire. Value proposition:
 * ATC ships with every ABAP system, but Eclipse's ATC only works from
 * inside a logged-on IDE; this makes it reachable from CI, hooks, agents.
 *
 * ATC has no stateless "check and tell me" endpoint. Findings live in a
 * persistent server-side **worklist**, so one logical run costs up to four
 * requests: GET customizing (default variant, cached; skipped when the
 * caller names a variant — see {@link resolveCheckVariant}) → POST worklist
 * (create, cached per connection+variant — see {@link atcState}) →
 * POST run → GET worklist ×2 (unscoped, then re-read scoped to the
 * `LAST_RUN` object set the first read reveals). The double read is not
 * optional: a worklist accumulates findings across every run ever made
 * into it, so skipping the scoped re-read risks reporting a stale finding
 * against since-fixed source. See {@link AtcRunResult.scopedToLastRun}.
 *
 * ## Worklists cannot be deleted on A4H, and this file does not pretend
 *
 * Issue #78 ran the actual experiments the previous header said not to run
 * without confirming against a real system first:
 *
 *   - `DELETE /sap/bc/adt/atc/worklists/{id}` → **405**
 *     `ExceptionMethodNotSupported`, "Resource controller does not support
 *     method DELETE" (capture `857-i78-worklist-delete-405.xml`).
 *   - `PUT` on the same resource → also 405.
 *   - The advertised `?action=deleteFindings` action (ADT discovery lists it
 *     as `rel="…/actions/deleteFindings"`) → **200 with a zero-byte body**,
 *     and the worklist's findings are unchanged afterwards (capture
 *     `858-i78-worklist-action-deletefindings-noop.xml`). Server-side,
 *     `CL_SATC_ADT_RES_WORKLIST->post` returns immediately for a URI
 *     carrying a worklist id, and the `lcl_handler_delete_findings`
 *     implementation in its CCIMP include is commented out in its entirety
 *     on this release. Calling that action would be pretending to clean up,
 *     so {@link deleteAtcWorklist} never calls it — only the real DELETE.
 *
 * So on this release, worklists genuinely accumulate and nothing here can
 * remove them. {@link deleteAtcWorklist} still attempts the DELETE (a
 * release that supports it would just work) and honestly reports the
 * refusal via {@link AtcWorklistCleanup} rather than silently swallowing
 * it. {@link runAtcCheck}'s `autoCleanup` option surfaces the same refusal
 * in {@link AtcRunResult.cleanup} without losing the findings that were
 * already read — see the worklist-id caching note in {@link atcState}: a
 * failed delete deliberately KEEPS the cached id so a later run reuses the
 * same undeletable worklist instead of minting a new one every time.
 *
 * ## Timeout vs. observed package-run duration
 *
 * A synchronous run over a whole package is slow: capture
 * `853-i78-run-two-packages.xml` (two packages, 5 objects, 29 findings) took
 * 23 s on a re-run; a separate live run of one package
 * (`$ABAPSMITH_FLUID_API`, ~77 classes, 677 findings) took **134 s**. This
 * client's default HTTP timeout (`cfg.timeoutMs`, `src/config.ts:309`) is
 * **60 000 ms** — well under that. A caller that points `runAtcCheck` at a
 * large package (directly, or via {@link expandPackageTree}) can time out
 * mid-run with a worklist left behind that nothing here can delete (see
 * above). {@link ATC_MAX_RUN_TARGETS} in `atc-query.ts` bounds the object
 * *count*, not the wall-clock cost of any one of them, so this remains a
 * real risk for a big package even under that cap — callers should raise
 * `ABAP_TIMEOUT_MS` for a package-scoped run rather than assume the default
 * is enough.
 *
 * Most URL/header/body shapes are sourced from `abap-adt-api` v8.4.1's ATC
 * client (see `atc-query.ts`/`atc-xml.ts`); issue #78 grounded several of
 * them (run body, worklist read, customizing, check-variant list, worklist
 * delete) against real A4H captures — `atc-query.ts`'s header says which.
 * One run/read pair (one object, one variant) was already grounded before
 * that — test/fixtures/live-captured/438-atc2-run.xml and
 * 439-atc2-worklist-read.xml — see doc/TOOLS/abap-atc.md for exactly what
 * each capture confirms and what's still untested (e.g. server-side
 * subpackage expansion via the async `SATC_RUN_REQ_2` API is out of scope
 * here and unobserved; see {@link expandPackageTree}).
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import { adtExceptionInfo, type ErrorContext, translateAdtError } from "./session.js";
import type { AuthorizedTarget } from "../safety.js";
import {
  ATC_CHECK_VARIANT_SEARCH_ACCEPT,
  ATC_CUSTOMIZING_ACCEPT,
  ATC_CUSTOMIZING_PATH,
  ATC_MAX_RUN_TARGETS,
  ATC_RUN_ACCEPT,
  ATC_RUN_CONTENT_TYPE,
  ATC_WORKLIST_ACCEPT,
  ATC_WORKLIST_CREATE_ACCEPT,
  ATC_WORKLIST_DELETE_ACCEPT,
  SYSTEM_CHECK_VARIANT_PROPERTY,
  assertVariantName,
  assertWorklistId,
  atcTimestampSeconds,
  buildAtcRunBody,
  buildCheckVariantSearchUrl,
  buildRunUrl,
  buildWorklistCreateUrl,
  buildWorklistDeleteUrl,
  buildWorklistReadUrl,
  clampMaxVerdicts,
  lastRunObjectSet,
} from "./atc-query.js";
import {
  type AtcCheckVariant,
  type AtcCounts,
  type AtcRunInfo,
  type AtcWorklist,
  type FlatAtcFinding,
  countFindings,
  flattenFindings,
  parseAtcCustomizing,
  parseAtcRunAck,
  parseAtcWorklist,
  parseCheckVariantList,
  systemCheckVariant,
} from "./atc-xml.js";

// ------------------------------------------------------------------ errors ---

/** Context for {@link classifyAtcFailure}. */
export interface AtcErrorContext extends ErrorContext {
  /** The check variant in play, when one had been decided. */
  readonly checkVariant?: string;
  /** The worklist in play, when one had been created. */
  readonly worklistId?: string;
}

/**
 * Turn a transport-level failure into something whose hint is about ATC.
 *
 * `translateAdtError` runs first; only ambiguous `ADT_ERROR`/`NOT_FOUND`
 * results are refined here. 404 is refined too (not just `ADT_ERROR`)
 * because `translateAdtError` maps every 404 to `NOT_FOUND` ("create the
 * object"), which is wrong for a missing ATC collection. 403 means the
 * separate `S_ATCVIOL` ATC authorization, not ordinary developer rights.
 * 400 on the run POST usually means a bad check variant.
 *
 * Status is read from {@link adtExceptionInfo} on the original throwable,
 * not `err.details.status` — `translateAdtError` only sets that field on
 * the generic `ADT_ERROR` branch, which would skip refinement elsewhere.
 */
export function classifyAtcFailure(e: unknown, ctx: AtcErrorContext): AbapError {
  const err = translateAdtError(e, ctx);
  // Internal AbapErrors are already decided; only ambiguous transport
  // failures (ADT_ERROR/NOT_FOUND) get refined below — LOCKED etc. stand.
  if (err.code !== "ADT_ERROR" && err.code !== "NOT_FOUND") return err;

  const status = atcFailureStatus(e, err);
  const extra = {
    ...(status === undefined ? {} : { status }),
    ...err.details,
    ...(ctx.checkVariant === undefined ? {} : { checkVariant: ctx.checkVariant }),
    ...(ctx.worklistId === undefined ? {} : { worklistId: ctx.worklistId }),
  };

  if (status === 404) {
    return new AbapError(
      "UNSUPPORTED",
      `This system does not serve ${ctx.uri ?? "the ATC resource"} (HTTP 404).`,
      extra,
      "ATC over ADT is not available on every release or is not activated in this system's " +
        "ICF tree. Check abap://system for the collections this server does publish; there is " +
        "no fallback and no other path to ATC from here.",
    );
  }

  if (status === 403) {
    return new AbapError(
      "ADT_ERROR",
      `The server refused the ATC request (HTTP 403).`,
      extra,
      "ATC has its own authorisation objects, granted separately from the developer authority " +
        "that lets you read the object. Being able to display a class does not imply being " +
        "allowed to run checks over it or to create a worklist.",
    );
  }

  if (status === 400 && ctx.checkVariant !== undefined) {
    return new AbapError(
      "BAD_INPUT",
      `The server rejected ATC check variant "${ctx.checkVariant}" (HTTP 400).`,
      extra,
      "Check variants are system-specific SCI objects. Omit the variant to use the system " +
        "default from ATC customizing, which is what ADT itself uses.",
    );
  }

  return err;
}

/**
 * The HTTP status behind a failure, preferring the raw throwable.
 * `err.details.status` is a fallback for when the original is gone.
 */
function atcFailureStatus(e: unknown, err: AbapError): number | undefined {
  const info = adtExceptionInfo(e);
  if (info?.status !== undefined) return info.status;
  return typeof err.details.status === "number" ? err.details.status : undefined;
}

/**
 * Whether a run POST failure looks like the worklist having gone stale —
 * worth one retry. Used only by {@link postRun}; kept beside the classifier
 * because both rely on 404 already having been renamed `NOT_FOUND`.
 */
function isStaleWorklistFailure(e: unknown, err: AbapError): boolean {
  const status = atcFailureStatus(e, err);
  return status === 404 || status === 400;
}

// ------------------------------------------------------------------ caches ---

/**
 * Per-connection ATC state: resolved default variant, and one worklist id
 * per check variant. `WeakMap`-keyed like `capabilityCache` (dumps.ts) and
 * `searchConfigCache` (tools/transport.ts) — describes the system, not the
 * request. The worklist entry exists for litter control (see module
 * header), which is why {@link clearAtcCaches} exists: a reconnect may be
 * a different system, so a stale worklist id is worse than none.
 */
interface AtcConnectionState {
  defaultVariant?: string;
  readonly worklists: Map<string, string>;
  /** {@link listCheckVariants}'s cache — the variant list doesn't change mid-session either. */
  checkVariants?: readonly AtcCheckVariant[];
}

const atcState = new WeakMap<AbapConnection, AtcConnectionState>();

function stateFor(conn: AbapConnection): AtcConnectionState {
  const existing = atcState.get(conn);
  if (existing !== undefined) return existing;
  const created: AtcConnectionState = { worklists: new Map() };
  atcState.set(conn, created);
  return created;
}

/** Forget everything cached for this connection — for tests and for reconnects. */
export function clearAtcCaches(conn: AbapConnection): void {
  atcState.delete(conn);
}

/** Worklist ids this connection created — exposed so an operator who cannot delete them can at least find them. */
export function knownAtcWorklists(conn: AbapConnection): readonly string[] {
  return [...(atcState.get(conn)?.worklists.values() ?? [])];
}

/**
 * Forget whichever (variant → worklistId) cache entries point at this
 * worklist. Used only by {@link deleteAtcWorklist} on a confirmed success —
 * on a refusal the cached id is deliberately left alone (see module header).
 */
function forgetCachedWorklist(conn: AbapConnection, worklistId: string): void {
  const state = atcState.get(conn);
  if (state === undefined) return;
  for (const [variant, id] of state.worklists) {
    if (id === worklistId) state.worklists.delete(variant);
  }
}

// ---------------------------------------------------------- name display ---

/** Cap on how many names {@link namesLabel} spells out before truncating. */
const ATC_NAME_DISPLAY_MAX = 20;

/**
 * Join names for an error message/hint, capping and marking truncation the
 * way {@link truncateText} marks a cut body — never a silent `.slice()`.
 * Used both for the object names in a multi-target run's error context and
 * for the available check-variant names in {@link resolveCheckVariant}'s
 * refusal.
 */
function namesLabel(names: readonly string[]): string {
  if (names.length <= ATC_NAME_DISPLAY_MAX) return names.join(", ");
  const shown = names.slice(0, ATC_NAME_DISPLAY_MAX);
  return `${shown.join(", ")} … [truncated, ${shown.length} of ${names.length} shown]`;
}

// ------------------------------------------------------------- customizing ---

/**
 * The system's default check variant, cached per connection (ATC
 * customizing doesn't change mid-session). Only a successful non-empty
 * answer is cached — caching a failed probe would freeze one network
 * blip into a permanent "none" for the connection's lifetime.
 */
export async function fetchDefaultCheckVariant(conn: AbapConnection): Promise<string> {
  const state = stateFor(conn);
  if (state.defaultVariant !== undefined) return state.defaultVariant;

  const ctx: AtcErrorContext = {
    operation: "atc.customizing",
    uri: ATC_CUSTOMIZING_PATH,
  };
  let body: string;
  try {
    ({ body } = await conn.get(ATC_CUSTOMIZING_PATH, {
      headers: { Accept: ATC_CUSTOMIZING_ACCEPT },
    }));
  } catch (e) {
    throw classifyAtcFailure(e, ctx);
  }

  const customizing = parseAtcCustomizing(body);
  const variant = systemCheckVariant(customizing, SYSTEM_CHECK_VARIANT_PROPERTY);
  if (variant === undefined) {
    throw new AbapError(
      "UNSUPPORTED",
      "This system's ATC customizing names no default check variant.",
      {
        uri: ATC_CUSTOMIZING_PATH,
        property: SYSTEM_CHECK_VARIANT_PROPERTY,
        propertiesSeen: customizing.properties.map((p) => p.name),
      },
      "ATC has not been configured with a system check variant here. Name one explicitly, or " +
        "have someone set the system variant in ATC customizing (transaction ATC).",
    );
  }
  // Validate before caching — fail once here rather than at every later use.
  assertVariantName(variant);
  state.defaultVariant = variant;
  return variant;
}

// ----------------------------------------------------------- check variants ---

/**
 * List every ATC check variant this system knows, cached per connection
 * (like {@link fetchDefaultCheckVariant}, one HTTP call per connection
 * lifetime). Grounded in capture `852-i78-checkvariants-quicksearch.xml`:
 * a repository quickSearch scoped to `objectType=CHKV`, since a direct GET
 * on `/sap/bc/adt/atc/checkvariants` answers 400 `uriMappingError` on A4H —
 * see {@link buildCheckVariantSearchUrl}.
 */
export async function listCheckVariants(
  conn: AbapConnection,
): Promise<readonly AtcCheckVariant[]> {
  const state = stateFor(conn);
  if (state.checkVariants !== undefined) return state.checkVariants;

  const url = buildCheckVariantSearchUrl();
  const ctx: AtcErrorContext = { operation: "atc.checkVariants", uri: url };
  let body: string;
  try {
    ({ body } = await conn.get(url, {
      headers: { Accept: ATC_CHECK_VARIANT_SEARCH_ACCEPT },
    }));
  } catch (e) {
    throw classifyAtcFailure(e, ctx);
  }

  const variants = parseCheckVariantList(body);
  state.checkVariants = variants;
  return variants;
}

/**
 * Validate a caller-supplied check variant against {@link listCheckVariants}
 * and return the SERVER'S OWN spelling (matched case-insensitively) —
 * necessary because `POST .../atc/worklists?checkVariant=<nonsense>`
 * answers 200 and creates a real worklist for a variant that does not exist
 * (observed live; see `buildCheckVariantSearchUrl`'s doc comment). The
 * server will not catch a typo; this function is the only thing that does.
 *
 * FAILS OPEN when the listing itself cannot be obtained (network failure,
 * unparseable response, ATC not exposed on this release, …): a variant this
 * client cannot currently validate is not proof it is wrong, and refusing a
 * run the server would have accepted just because the validation call
 * itself failed would be worse than running unvalidated. The caller gets
 * `unvalidatedReason` back and must decide whether to surface it.
 */
export async function resolveCheckVariant(
  conn: AbapConnection,
  requested: string,
): Promise<{ readonly name: string; readonly unvalidatedReason?: string }> {
  assertVariantName(requested);

  let variants: readonly AtcCheckVariant[];
  try {
    variants = await listCheckVariants(conn);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      name: requested,
      unvalidatedReason: `The check-variant list could not be read, so "${requested}" was not ` +
        `validated before use: ${reason}`,
    };
  }

  const match = variants.find((v) => v.name.toLowerCase() === requested.toLowerCase());
  if (match !== undefined) return { name: match.name };

  const available = namesLabel(variants.map((v) => v.name));
  throw new AbapError(
    "BAD_INPUT",
    `"${requested}" is not a check variant this system lists (${variants.length} known).`,
    { requested, availableCount: variants.length, available: variants.map((v) => v.name) },
    `The server itself does not reject an unknown check variant name (it would create a real ` +
      `worklist for one anyway), so this is caught here instead. Known variants: ${available}.`,
  );
}

// ---------------------------------------------------------------- worklist ---

/**
 * Get (or create) the worklist for a check variant on this connection.
 * The create POST returns the id as a plain-text body; there's no way to
 * ask the server "do I already have one?", hence the cache.
 */
export async function ensureAtcWorklist(
  conn: AbapConnection,
  checkVariant: string,
  opts: { readonly forceNew?: boolean } = {},
): Promise<{ readonly worklistId: string; readonly reused: boolean }> {
  assertVariantName(checkVariant);
  const state = stateFor(conn);
  if (opts.forceNew !== true) {
    const cached = state.worklists.get(checkVariant);
    if (cached !== undefined) return { worklistId: cached, reused: true };
  }

  const url = buildWorklistCreateUrl(checkVariant);
  const ctx: AtcErrorContext = { operation: "atc.createWorklist", uri: url, checkVariant };
  let body: string;
  let status: number;
  try {
    // Deliberately `conn.post`, not a read-path bypass like `dataPreviewDdic`
    // uses — this creates persistent server state, so ABAP_MODE=read must
    // refuse it even though "it's only a worklist" sounds harmless.
    ({ body, status } = await conn.post(url, {
      headers: { Accept: ATC_WORKLIST_CREATE_ACCEPT },
    }));
  } catch (e) {
    throw classifyAtcFailure(e, ctx);
  }

  const worklistId = body.trim();
  if (worklistId === "") {
    throw new AbapError(
      "ADT_ERROR",
      `Creating an ATC worklist returned an empty body (HTTP ${status}).`,
      { uri: url, status, checkVariant },
      "The worklist id is the whole response body for this endpoint. Without it there is " +
        "nothing to run checks into.",
    );
  }
  // Validate before caching: a document body (ICF logon page, error envelope)
  // arriving with HTTP 200 would otherwise get spliced straight into the run URL.
  assertWorklistId(worklistId);
  state.worklists.set(checkVariant, worklistId);
  return { worklistId, reused: false };
}

/**
 * The outcome of attempting to remove a worklist — see the module header
 * for why this is a report, not a guarantee.
 */
export interface AtcWorklistCleanup {
  readonly worklistId: string;
  /** `true` only when the server actually removed the worklist. */
  readonly deleted: boolean;
  /** HTTP status observed on the attempt (405 on A4H; see module header). */
  readonly status?: number;
  /** Short, server-derived explanation, safe to print — never a raw dump. */
  readonly reason?: string;
  /** Whether this connection's cached worklist id for that variant was forgotten. */
  readonly cacheCleared: boolean;
}

/**
 * Attempt to delete an ATC worklist. NEVER throws on a server refusal — a
 * worklist a caller can't clean up is an unfortunate fact to report, not a
 * reason to fail whatever operation asked for the cleanup (see
 * {@link runAtcCheck}'s `autoCleanup`). Only a malformed `worklistId` throws
 * (`assertWorklistId`, `BAD_INPUT`) — that is caller error, not a server
 * refusal.
 *
 * On A4H this always answers 405 `ExceptionMethodNotSupported` (capture
 * `857-i78-worklist-delete-405.xml`) — see the module header for the full
 * picture, including why the advertised `?action=deleteFindings` action is
 * deliberately never called here (it is a documented no-op, not a cleanup).
 *
 * On failure the cached worklist id for whichever variant it belongs to is
 * left alone (`cacheCleared: false`) so a later run reuses this same
 * undeletable worklist instead of minting a new littered one every time.
 * Only a confirmed success forgets it.
 */
export async function deleteAtcWorklist(
  conn: AbapConnection,
  worklistId: string,
): Promise<AtcWorklistCleanup> {
  assertWorklistId(worklistId);
  const url = buildWorklistDeleteUrl(worklistId);
  const ctx: AtcErrorContext = { operation: "atc.deleteWorklist", uri: url, worklistId };

  try {
    const resp = await conn.del(url, { headers: { Accept: ATC_WORKLIST_DELETE_ACCEPT } });
    if (resp.status >= 200 && resp.status < 300) {
      forgetCachedWorklist(conn, worklistId);
      return { worklistId, deleted: true, status: resp.status, cacheCleared: true };
    }
    // Some non-2xx statuses (e.g. certain 3xx) don't throw in this client's
    // transport; treat anything short of 2xx as a refusal, not a success.
    return {
      worklistId,
      deleted: false,
      status: resp.status,
      reason: `HTTP ${resp.status}`,
      cacheCleared: false,
    };
  } catch (e) {
    const err = classifyAtcFailure(e, ctx);
    const status = atcFailureStatus(e, err);
    const info = adtExceptionInfo(e);
    const reason =
      info?.type !== undefined && info.message !== ""
        ? `${info.type}: ${info.message}`
        : (info?.message ?? err.message);
    return {
      worklistId,
      deleted: false,
      ...(status === undefined ? {} : { status }),
      reason,
      cacheCleared: false,
    };
  }
}

// --------------------------------------------------------------------- run ---

/** What to check, and how much of it to report. */
export interface AtcRunRequest {
  /**
   * ADT URIs of the objects (or packages, via {@link packageObjectUri}) to
   * check — normally resolved objects' `sourceUri`s. Passed straight to
   * {@link buildAtcRunBody}, which de-dupes, validates and enforces
   * {@link ATC_MAX_RUN_TARGETS}.
   */
  readonly objectUris: readonly string[];
  /** Check variant name; omitted means the system default (unvalidated — see {@link resolveCheckVariant}). */
  readonly checkVariant?: string;
  /** `maximumVerdicts` on the run request. Clamped by `clampMaxVerdicts`. */
  readonly maxVerdicts?: number;
  /** Include findings that carry an approved exemption. Default false. */
  readonly includeExempted?: boolean;
  /** Delete the worklist after findings are read. See {@link AtcRunResult.cleanup}. */
  readonly autoCleanup?: boolean;
}

/** Everything one ATC run produced, plus how much of it can be trusted. */
export interface AtcRunResult {
  readonly checkVariant: string;
  readonly worklistId: string;
  /** True when an existing worklist was reused rather than a new one created. */
  readonly worklistReused: boolean;
  /**
   * False when the server named no `LAST_RUN` object set and the findings are
   * therefore the whole worklist, which may include earlier runs. The caller
   * MUST surface this.
   */
  readonly scopedToLastRun: boolean;
  /** False when ATC stopped early — typically `maximumVerdicts` was reached. */
  readonly objectSetIsComplete: boolean;
  /** The `maximumVerdicts` actually requested, after clamping. */
  readonly maxVerdicts: number;
  /** Distinct object URIs actually sent, after {@link buildAtcRunBody}'s de-dupe. */
  readonly targetCount: number;
  /**
   * Set only when `request.checkVariant` was given AND
   * {@link resolveCheckVariant} had to fail open (its own listing call
   * failed) — the variant was used unvalidated. `undefined` means either no
   * variant was named (system default, never validated — that path is
   * unchanged) or it WAS validated successfully.
   */
  readonly variantUnvalidated?: string;
  /** Server remarks from the run acknowledgement. Usually empty. */
  readonly infos: readonly AtcRunInfo[];
  readonly findings: readonly FlatAtcFinding[];
  readonly counts: AtcCounts;
  /** The worklist document the findings came from, for callers wanting detail. */
  readonly worklist: AtcWorklist;
  /** Present iff `request.autoCleanup` was true. See module header. */
  readonly cleanup?: AtcWorklistCleanup;
}

/**
 * Run ATC over one or more objects (or packages) and collect the findings.
 *
 * `authorized` is a proof obligation (see doc/SAFETY/permission-model.md): only
 * `SafetyGate.authorize()` can mint an `AuthorizedTarget`, so this can't
 * run without a gate decision — one per object being checked, hence the
 * array. Gated as `execute`, not a read, because (1) worklist creation is
 * persistent server state, and (2) `execute` carries the Z/Y-prefix/package
 * allowlist that stops this from running unbounded checks against
 * SAP-standard packages. Cost: under `ABAP_MODE=read` this cannot run at
 * all (doc/TOOLS/abap-atc.md).
 *
 * An empty `authorized` array is an internal contract violation, not a
 * recoverable user-input mistake — every call site is expected to gate
 * every target before calling this — so it is refused with `BAD_INPUT`
 * before any request is made, not silently treated as "check nothing".
 */
export async function runAtcCheck(
  conn: AbapConnection,
  request: AtcRunRequest,
  authorized: readonly AuthorizedTarget<"execute">[],
): Promise<AtcRunResult> {
  if (!Array.isArray(authorized) || authorized.length === 0) {
    throw new AbapError(
      "BAD_INPUT",
      "runAtcCheck was called with no authorized targets.",
      { objectUris: request.objectUris },
      "Every object an ATC run touches must first pass SafetyGate.authorize(\"execute\", …); " +
        "an empty list means nothing was gated, so nothing can run.",
    );
  }

  // Fail-open: assertSupported only throws on a positive "no ATC", never on "unknown".
  conn.discovery.assertSupported("atc", "ATC (ABAP Test Cockpit) runs");

  const objectLabel = namesLabel(authorized.map((a) => a.target.name));

  let checkVariant: string;
  let variantUnvalidated: string | undefined;
  if (request.checkVariant === undefined) {
    // Unchanged path: the system default is never validated against the
    // check-variant list — it came from ATC customizing itself.
    checkVariant = await fetchDefaultCheckVariant(conn);
  } else {
    const resolved = await resolveCheckVariant(conn, request.checkVariant);
    checkVariant = resolved.name;
    variantUnvalidated = resolved.unvalidatedReason;
  }

  const maxVerdicts = clampMaxVerdicts(request.maxVerdicts);
  const runBody = buildAtcRunBody(request.objectUris, maxVerdicts);
  const targetCount = new Set(request.objectUris).size;

  let worklist = await ensureAtcWorklist(conn, checkVariant);
  let ack = await postRun(conn, worklist.worklistId, runBody, checkVariant, objectLabel, {
    retryable: worklist.reused,
  });

  // A cached worklist id can go stale (expired, or reconnected to a
  // different system). Retry once with a fresh worklist — but only when
  // the id used was cached, else we'd just create a second new one.
  if (ack === "stale") {
    worklist = await ensureAtcWorklist(conn, checkVariant, { forceNew: true });
    const retried = await postRun(
      conn,
      worklist.worklistId,
      runBody,
      checkVariant,
      objectLabel,
      { retryable: false },
    );
    /* c8 ignore next 3 -- `retryable: false` makes "stale" unreachable; the
       branch exists so the type narrows without a cast. */
    if (retried === "stale") {
      throw new AbapError(
        "ADT_ERROR",
        "The ATC run was rejected even with a newly created worklist.",
        { checkVariant, worklistId: worklist.worklistId },
        "The worklist was created and immediately refused for the run, which points at the " +
          "check variant or at ATC authorisations rather than at a stale id.",
      );
    }
    ack = retried;
  }

  // Trust the server's echoed worklist id over the one we sent.
  const readId = ack.worklistId === "" ? worklist.worklistId : ack.worklistId;

  const unscoped = await readWorklist(conn, readId, checkVariant, {
    includeExempted: request.includeExempted === true,
  });

  const lastRun = lastRunObjectSet(unscoped.objectSets);
  let scoped = unscoped;
  if (lastRun !== undefined) {
    const timestamp = atcTimestampSeconds(ack.timestamp ?? unscoped.timestamp);
    scoped = await readWorklist(conn, readId, checkVariant, {
      includeExempted: request.includeExempted === true,
      usedObjectSet: lastRun.name,
      ...(timestamp === undefined ? {} : { timestamp }),
    });
  }

  const findings = flattenFindings(scoped);

  // Cleanup runs AFTER the findings are already in hand: a refusal (the
  // expected outcome on A4H — see module header) must not lose them.
  const cleanup =
    request.autoCleanup === true ? await deleteAtcWorklist(conn, readId) : undefined;

  return {
    checkVariant,
    worklistId: readId,
    worklistReused: worklist.reused,
    scopedToLastRun: lastRun !== undefined,
    objectSetIsComplete: scoped.objectSetIsComplete,
    maxVerdicts,
    targetCount,
    ...(variantUnvalidated === undefined ? {} : { variantUnvalidated }),
    infos: ack.infos,
    findings,
    counts: countFindings(findings),
    worklist: scoped,
    ...(cleanup === undefined ? {} : { cleanup }),
  };
}

/**
 * POST the run. Returns `"stale"` instead of throwing when the failure looks
 * like the worklist id having gone away, so the caller can decide to retry.
 */
async function postRun(
  conn: AbapConnection,
  worklistId: string,
  body: string,
  checkVariant: string,
  objectName: string,
  opts: { readonly retryable: boolean },
): Promise<{ worklistId: string; timestamp?: string; infos: readonly AtcRunInfo[] } | "stale"> {
  const url = buildRunUrl(worklistId);
  const ctx: AtcErrorContext = {
    operation: "atc.run",
    uri: url,
    name: objectName,
    checkVariant,
    worklistId,
  };
  let responseBody: string;
  try {
    ({ body: responseBody } = await conn.post(url, {
      headers: { Accept: ATC_RUN_ACCEPT, "Content-Type": ATC_RUN_CONTENT_TYPE },
      body,
    }));
  } catch (e) {
    const err = classifyAtcFailure(e, ctx);
    if (opts.retryable && isStaleWorklistFailure(e, err)) return "stale";
    throw err;
  }
  return parseAtcRunAck(responseBody);
}

/** GET a worklist, scoped or not. */
async function readWorklist(
  conn: AbapConnection,
  worklistId: string,
  checkVariant: string,
  opts: {
    readonly timestamp?: number;
    readonly usedObjectSet?: string;
    readonly includeExempted?: boolean;
  },
): Promise<AtcWorklist> {
  const url = buildWorklistReadUrl(worklistId, opts);
  const ctx: AtcErrorContext = {
    operation: "atc.worklist",
    uri: url,
    checkVariant,
    worklistId,
  };
  let body: string;
  try {
    ({ body } = await conn.get(url, { headers: { Accept: ATC_WORKLIST_ACCEPT } }));
  } catch (e) {
    throw classifyAtcFailure(e, ctx);
  }
  return parseAtcWorklist(body);
}

// ---------------------------------------------------------- package tree ---

/**
 * Cap on the number of package names {@link expandPackageTree} will return.
 * Set equal to `ATC_MAX_RUN_TARGETS` (atc-query.ts): an expanded package
 * tree only ever feeds an ATC run, so a looser cap here would just move
 * the "too many objects" refusal downstream into `buildAtcRunBody`, with a
 * less specific error message. Inferred, not observed — A4H has no
 * customer package with subpackages to exercise this against (see module
 * header).
 */
export const ATC_MAX_PACKAGE_NODES = ATC_MAX_RUN_TARGETS;

/**
 * Recursion-depth cap for {@link expandPackageTree}'s breadth-first walk.
 * SAP package hierarchies are conventionally a handful of levels deep
 * under a top-level application component; 8 is a generous safety bound
 * against a pathological tree, not a documented SAP limit — inferred, not
 * observed, same caveat as {@link ATC_MAX_PACKAGE_NODES}.
 */
export const ATC_MAX_PACKAGE_DEPTH = 8;

function normalizePackageName(packageName: string): string {
  const trimmed = typeof packageName === "string" ? packageName.trim() : "";
  if (trimmed === "") {
    throw new AbapError(
      "BAD_INPUT",
      "expandPackageTree needs a package name.",
      { packageName },
      "Pass the package name, e.g. Z_MY_PACKAGE or $TMP.",
    );
  }
  return trimmed.toUpperCase();
}

/**
 * Resolve a package name to the flat list of package names an ATC run
 * should cover: just the root, or — when `includeSubpackages` is true —
 * the root plus every package nested under it.
 *
 * Expansion happens client-side, walking `conn.adt.nodeContents("DEVC/K",
 * …)` breadth-first and collecting rows whose `OBJECT_TYPE` starts with
 * `DEVC` (same endpoint and filter as `readPackage` in ddic.ts:858),
 * because the synchronous run request this file builds
 * (`buildAtcRunBody`, `SATC_RUN_REQ`) has no `includeSubpackages` field of
 * its own — only the asynchronous `SATC_RUN_REQ_2` shape reportedly does,
 * and that request/poll lifecycle is out of scope for this issue. So
 * "check a package and its subpackages" has to be built here, by turning
 * one package name into many package names before any of them reach
 * `buildAtcRunBody`.
 *
 * `includeSubpackages` false or omitted makes NO HTTP call at all — it is
 * just name normalisation — because a single flat package (no tree walk)
 * is the common case, and every live package run this issue captured
 * (853/854) was against flat packages.
 *
 * The walk is root-first, then each level in server node order, de-duped
 * by name and cycle-guarded by the same `seen` set (a name already
 * emitted is never re-queued, so a cyclic or re-nested tree can't loop).
 *
 * UNVERIFIED against A4H: this system has no customer package with
 * subpackages, so the recursive branch is exercised only against `$TMP`
 * (which also has none, so it too returns just the root) and against
 * hand-written fakes in the test suite — labelled as such there.
 */
export async function expandPackageTree(
  conn: AbapConnection,
  packageName: string,
  opts: { readonly includeSubpackages?: boolean } = {},
): Promise<readonly string[]> {
  const root = normalizePackageName(packageName);
  if (opts.includeSubpackages !== true) return [root];

  const seen = new Set<string>([root]);
  const result: string[] = [root];
  let frontier: readonly string[] = [root];
  let depth = 0;

  while (frontier.length > 0) {
    if (depth >= ATC_MAX_PACKAGE_DEPTH) {
      throw new AbapError(
        "BAD_INPUT",
        `The package tree under ${root} is deeper than the ${ATC_MAX_PACKAGE_DEPTH}-level cap this client enforces.`,
        { root, depth, cap: ATC_MAX_PACKAGE_DEPTH },
        "Expand a narrower sub-package instead of the whole tree.",
      );
    }
    depth += 1;

    const next: string[] = [];
    for (const pkg of frontier) {
      const ctx: AtcErrorContext = { operation: "atc.packageTree", name: pkg };
      let nodes;
      try {
        nodes = (await conn.adt.nodeContents("DEVC/K", pkg)).nodes ?? [];
      } catch (e) {
        throw classifyAtcFailure(e, ctx);
      }
      for (const n of nodes) {
        const type = (n.OBJECT_TYPE ?? "").toUpperCase();
        const name = (n.OBJECT_NAME ?? "").trim().toUpperCase();
        if (name === "" || !type.startsWith("DEVC")) continue;
        if (seen.has(name)) continue; // de-dupe AND cycle guard
        if (result.length >= ATC_MAX_PACKAGE_NODES) {
          throw new AbapError(
            "BAD_INPUT",
            `${root} and its sub-packages exceed the ${ATC_MAX_PACKAGE_NODES}-package cap this client enforces.`,
            { root, cap: ATC_MAX_PACKAGE_NODES },
            `Expand a narrower sub-package, or split the run into batches of at most ${ATC_MAX_PACKAGE_NODES} packages.`,
          );
        }
        seen.add(name);
        result.push(name);
        next.push(name);
      }
    }
    frontier = next;
  }

  return result;
}
