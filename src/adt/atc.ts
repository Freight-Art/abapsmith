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
 * requests: GET customizing (default variant, cached) → POST worklist
 * (create, cached per connection+variant — see {@link atcState}) →
 * POST run → GET worklist ×2 (unscoped, then re-read scoped to the
 * `LAST_RUN` object set the first read reveals). The double read is not
 * optional: a worklist accumulates findings across every run ever made
 * into it, so skipping the scoped re-read risks reporting a stale finding
 * against since-fixed source. See {@link AtcRunResult.scopedToLastRun}.
 *
 * Worklists have no delete in `abap-adt-api` or ADT, and a DELETE is not
 * attempted here (unverified experiment against a resource this client
 * does not understand — do not add one without confirming against a real
 * system first). Instead, worklist ids are cached and reused per
 * (connection, variant) so a session creates at most one per variant. See
 * the git history for the incident that prompted this.
 *
 * Most URL/header/body shapes are sourced from `abap-adt-api` v8.4.1's ATC
 * client (see `atc-query.ts`/`atc-xml.ts`) and remain unexercised against a
 * live system. One run/read pair (one object, one variant) is grounded in a
 * live capture instead — test/fixtures/live-captured/438-atc2-run.xml and
 * 439-atc2-worklist-read.xml — see doc/TOOLS/abap-atc.md for exactly what that
 * capture confirms and what's still untested.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import { adtExceptionInfo, type ErrorContext, translateAdtError } from "./session.js";
import type { AuthorizedTarget } from "../safety.js";
import {
  ATC_CUSTOMIZING_ACCEPT,
  ATC_CUSTOMIZING_PATH,
  ATC_RUN_ACCEPT,
  ATC_RUN_CONTENT_TYPE,
  ATC_WORKLIST_ACCEPT,
  ATC_WORKLIST_CREATE_ACCEPT,
  SYSTEM_CHECK_VARIANT_PROPERTY,
  assertVariantName,
  assertWorklistId,
  atcTimestampSeconds,
  buildAtcRunBody,
  buildRunUrl,
  buildWorklistCreateUrl,
  buildWorklistReadUrl,
  clampMaxVerdicts,
  lastRunObjectSet,
} from "./atc-query.js";
import {
  type AtcCounts,
  type AtcRunInfo,
  type AtcWorklist,
  type FlatAtcFinding,
  countFindings,
  flattenFindings,
  parseAtcCustomizing,
  parseAtcRunAck,
  parseAtcWorklist,
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

// --------------------------------------------------------------------- run ---

/** What to check, and how much of it to report. */
export interface AtcRunRequest {
  /** ADT URI of the object to check — normally a resolved object's `sourceUri`. */
  readonly objectUri: string;
  /** Check variant name; omitted means the system default. */
  readonly checkVariant?: string;
  /** `maximumVerdicts` on the run request. Clamped by `clampMaxVerdicts`. */
  readonly maxVerdicts?: number;
  /** Include findings that carry an approved exemption. Default false. */
  readonly includeExempted?: boolean;
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
  /** Server remarks from the run acknowledgement. Usually empty. */
  readonly infos: readonly AtcRunInfo[];
  readonly findings: readonly FlatAtcFinding[];
  readonly counts: AtcCounts;
  /** The worklist document the findings came from, for callers wanting detail. */
  readonly worklist: AtcWorklist;
}

/**
 * Run ATC over one object and collect the findings.
 *
 * `authorized` is a proof obligation (see doc/SAFETY/permission-model.md): only
 * `SafetyGate.authorize()` can mint an `AuthorizedTarget`, so this can't
 * run without a gate decision. Gated as `execute`, not a read, because (1)
 * worklist creation is persistent server state, and (2) `execute` carries
 * the Z/Y-prefix/package allowlist that stops this from running unbounded
 * checks against SAP-standard packages. Cost: under `ABAP_MODE=read` this
 * cannot run at all (doc/TOOLS/abap-atc.md).
 */
export async function runAtcCheck(
  conn: AbapConnection,
  request: AtcRunRequest,
  authorized: AuthorizedTarget<"execute">,
): Promise<AtcRunResult> {
  // Fail-open: assertSupported only throws on a positive "no ATC", never on "unknown".
  conn.discovery.assertSupported("atc", "ATC (ABAP Test Cockpit) runs");

  const objectName = authorized.target.name;
  const checkVariant =
    request.checkVariant === undefined
      ? await fetchDefaultCheckVariant(conn)
      : request.checkVariant;
  assertVariantName(checkVariant);

  const maxVerdicts = clampMaxVerdicts(request.maxVerdicts);
  const runBody = buildAtcRunBody(request.objectUri, maxVerdicts);

  let worklist = await ensureAtcWorklist(conn, checkVariant);
  let ack = await postRun(conn, worklist.worklistId, runBody, checkVariant, objectName, {
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
      objectName,
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
  return {
    checkVariant,
    worklistId: readId,
    worklistReused: worklist.reused,
    scopedToLastRun: lastRun !== undefined,
    objectSetIsComplete: scoped.objectSetIsComplete,
    maxVerdicts,
    infos: ack.infos,
    findings,
    counts: countFindings(findings),
    worklist: scoped,
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
