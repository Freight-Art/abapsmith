/**
 * Enhancement / BAdI write choreography — LOCK → PUT → UNLOCK (→ activate),
 * for EXISTING `ENHO/XH`, `ENHO/XHH` and `ENHS/XS` objects only. Creating a
 * NEW object is out of scope: every function starts from a `GET` that must
 * succeed, refusing `NOT_FOUND` otherwise.
 *
 * Separate module rather than a branch in `write.ts`: `write.ts`'s
 * `ENHANCEABLE_TYPES` is `["ENHO/XHH"]` only (`test/write.test.ts` pins
 * `resolveWriteTarget` to refuse the other two), and `writeObject` assumes
 * a single `/source/main` sub-resource — never true for `ENHO/XH`/`ENHS/XS`
 * (`mode: "ddic"`, see `enhancement.ts`). Reuses `write.ts`'s generic
 * primitives and `./relock.ts`'s `withRelockRetry` directly.
 *
 * Scope: ONE field, root `adtcore:description`, patched by
 * `enhancement-xml.ts`'s `patchEnhancementRootAttribute` (byte-preserving
 * regex, not a full parse→rebuild — filter trees are derived/lossy).
 * Everything else (filters, hooks, BAdI definitions) stays out of scope:
 * no writable model for `enho:contentSpecific` exists.
 *
 * ## PUT verification — read before trusting `ENHO/XH`/`ENHS/XS`
 *
 * `enhoxhh` PUT is CONFIRMED (`138-put-wholedoc-success.meta.json`: 200,
 * real `etag`). `enhoxh`/`enhsxs` PUT has each succeeded live once
 * (2026-08 probe, verified by re-read) but has no citation file —
 * `putVerifiedBy` stays `undefined` for both; one success isn't proof of
 * reliable round-tripping. **Do not upgrade either without a real
 * captured 200 AND a citable fixture.** Not refusing the PUT call
 * regardless — LOCK/UNLOCK/activation are proven per-type
 * (`391-activate-success-enhoxh.meta.json`). Full history:
 * the git history.
 */
import type { AbapConnection } from "./connection.js";
import { AbapError, isAbapError } from "./errors.js";
import type { LockInfo, StatefulSession } from "./session.js";
import { translateAdtError } from "./session.js";
import { withRelockRetry } from "./relock.js";
import { activateObject, type ActivationOutcome } from "./activate.js";
import {
  ENHOXH_COLLECTION,
  ENHOXHH_COLLECTION,
  ENHSXS_COLLECTION,
  ENHOXH_ACCEPT,
  ENHOXHH_ACCEPT,
  ENHSXS_ACCEPT,
  buildEnhancementUri,
  readBadiImplementation,
  readSourceCodePlugin,
  readEnhancementSpot,
} from "./enhancement.js";
import {
  patchEnhancementRootAttribute,
  patchBadiImplementationActive,
  hasEnhancementRootDescription,
  type EnhCommonFields,
  type BadiImplementationRead,
  type BadiImplementationEntryRead,
} from "./enhancement-xml.js";
import type { EnhancementCollection } from "./discovery.js";
import {
  enhancementIntentFor,
  preflightCorr,
  transportFromLock,
  corrForMutation,
  canonicalEtag,
  postLockEtagConflict,
  transportRefusal,
  transportDivergence,
  type RefusalTarget,
  type EnhancedObjectRef,
  type TransportInfo,
  type TransportOptions,
  type PreflightTarget,
  type GatedCorr,
} from "./write.js";
import type { SessionTransport } from "./session-transport.js";
import type { AuthorizedTarget, SafetyGate } from "../safety.js";
import { type AbapMode, explainDeniedCapability } from "../mode.js";

// ---------------------------------------------------------------------------
// Types this module writes
// ---------------------------------------------------------------------------

export const ENHANCEMENT_WRITE_TYPES = ["ENHO/XH", "ENHO/XHH", "ENHS/XS"] as const;
export type EnhancementDocType = (typeof ENHANCEMENT_WRITE_TYPES)[number];

export function isEnhancementWriteType(type: string | undefined): type is EnhancementDocType {
  return (ENHANCEMENT_WRITE_TYPES as readonly string[]).includes(type ?? "");
}

// ---------------------------------------------------------------------------
// Per-type registry — collection, media type, read primitive, PUT evidence
// ---------------------------------------------------------------------------

interface EnhancementDocument {
  readonly xml: string;
  readonly data: EnhCommonFields;
  readonly etag?: string;
}

interface EnhancementDocSpec {
  readonly type: EnhancementDocType;
  readonly collection: string;
  /** Bare collection name (`collection`'s trailing path segment), matching
   *  `Discovery.assertEnhancementCapable`'s key space. */
  readonly bareCollection: EnhancementCollection;
  readonly accept: string;
  /** Capture citation proving whole-document PUT returns 200 for this
   *  collection, or `undefined` when there is none — see the module header's
   *  "PUT verification matrix". */
  readonly putVerifiedBy?: string;
  readonly read: (conn: AbapConnection, name: string) => Promise<EnhancementDocument>;
}

const ENHANCEMENT_SPECS: Readonly<Record<EnhancementDocType, EnhancementDocSpec>> = {
  "ENHO/XH": {
    type: "ENHO/XH",
    collection: ENHOXH_COLLECTION,
    bareCollection: "enhoxh",
    accept: ENHOXH_ACCEPT,
    // Undefined deliberately — one live success, no citation file yet. See
    // module header's "PUT verification matrix".
    putVerifiedBy: undefined,
    read: readBadiImplementation,
  },
  "ENHO/XHH": {
    type: "ENHO/XHH",
    collection: ENHOXHH_COLLECTION,
    bareCollection: "enhoxhh",
    accept: ENHOXHH_ACCEPT,
    // Backed by the fixture below plus a live end-to-end
    // writeAndActivateEnhancementDescription run after the LOCK Accept-header
    // fix (see withRelockRetry below) — before that fix every attempt died
    // at LOCK with a 406.
    putVerifiedBy: "test/fixtures/enhancement/138-put-wholedoc-success.meta.json",
    read: readSourceCodePlugin,
  },
  "ENHS/XS": {
    type: "ENHS/XS",
    collection: ENHSXS_COLLECTION,
    bareCollection: "enhsxs",
    accept: ENHSXS_ACCEPT,
    // Undefined deliberately — one live success, no citation file yet. See
    // module header's "PUT verification matrix".
    putVerifiedBy: undefined,
    read: readEnhancementSpot,
  },
};

function specFor(type: EnhancementDocType): EnhancementDocSpec {
  return ENHANCEMENT_SPECS[type];
}

/** Case-insensitive single-header lookup — copied rather than imported, per
 *  this codebase's established one-small-copy-per-wire-module convention
 *  (see `enhancement.ts`'s and `bopf.ts`'s own `firstHeader`). */
function firstHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) {
      const v = headers[k];
      if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
      return v === undefined || v === null ? undefined : String(v);
    }
  }
  return undefined;
}

// TRANSPORT_ERROR and ETAG_CONFLICT are added to write.ts's
// SAFETY_DENIED/BAD_INPUT/LOCKED exclusion set — neither is fixed by a fresh
// lock and re-read, so retrying would just reproduce the same refusal. See
// `./relock.ts`'s `defaultRetryable` for the base set this extends.
const NON_RETRYABLE_CODES = new Set([
  "SAFETY_DENIED",
  "BAD_INPUT",
  "LOCKED",
  "TRANSPORT_ERROR",
  "ETAG_CONFLICT",
  // Belt-and-suspenders: should never fire (assertDescriptionWillBePresent
  // catches this pre-lock), but retrying an identical payload would just
  // reproduce the same refusal.
  "ENHANCEMENT_DESCRIPTION_REQUIRED",
]);

function enhancementRetryable(e: unknown): boolean {
  if (isAbapError(e) && NON_RETRYABLE_CODES.has(e.code)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Public result / target shapes
// ---------------------------------------------------------------------------

export interface EnhancementWriteTarget {
  readonly type: EnhancementDocType;
  readonly name: string;
  readonly uri: string;
  readonly packageName: string;
  readonly description: string;
  readonly masterSystem?: string;
}

export interface EnhancementWriteResult {
  target: EnhancementWriteTarget;
  /** The object this write's enhancement `affects`, threaded through so a
   *  caller building a journal entry can populate `JournalObjectRef.affects`
   *  without re-deriving it. */
  affects: EnhancedObjectRef;
  /** `false` ⇒ the description already matched; no lock was taken, no PUT
   *  was sent, and `transport` is `not-determined` (mirrors `writeObject`'s
   *  own no-op short-circuit). */
  changed: boolean;
  /** Content hash of the whole document now on the server, canonicalised the
   *  same way `write.ts`'s `WriteResult.etag` is. */
  etag: string;
  previousEtag: string;
  transport: TransportInfo;
  /** The whole document's raw XML as it stood before this call (post pre-lock
   *  GET). `undefined` only on the no-op path, where nothing was re-read. */
  previousXml: string;
  /** The whole document's raw XML as PUT to the server (byte-identical to
   *  what a subsequent GET should return), when a mutation happened. */
  xml?: string;
  /** See the module header's "PUT verification matrix" — `false` means this
   *  collection's PUT success is not yet backed by a citable fixture. Does
   *  NOT mean the write failed. */
  putVerified: boolean;
}

/** `TransportOptions` mirrored with `affects` REQUIRED rather than optional —
 *  by design, `intent` (and therefore `affects`) is mandatory for every
 *  enhancement mutation, never an opt-in. Structurally a subtype of
 *  `TransportOptions` (a required field satisfies an optional one), so a
 *  value of this type is accepted anywhere `TransportOptions` is. */
export type EnhancementTransportOptions =
  | { transport?: undefined; gate?: undefined; corrNr?: string; affects: EnhancedObjectRef }
  | { transport: SessionTransport; gate: SafetyGate; corrNr?: string; affects: EnhancedObjectRef };

export interface EnhancementBeforeImage {
  /** The whole document's raw XML, exactly as GET returned it before the lock. */
  xml: string;
  target: EnhancementWriteTarget;
  affects: EnhancedObjectRef;
  /** The transport this mutation is about to go into, when resolved
   *  pre-flight — mirrors `write.ts`'s `BeforeImage.corrNr`. */
  corrNr?: string;
}

export type WriteEnhancementDescriptionOptions = EnhancementTransportOptions & {
  /** Compare-before-write: reject if the whole document's current
   *  content hash differs from this. Optional — unlike `writeObject`'s
   *  `source`, an enhancement write always re-reads and re-checks under the
   *  lock regardless (see the `reread` step below), so this only buys a
   *  cheaper, pre-lock refusal. */
  expectEtag?: string;
  /**
   * Called once the before-image is known, before ANY mutating request — the
   * journal seam, mirroring `writeObject`'s `onBeforeImage`. If it throws,
   * nothing is written.
   *
   * REQUIRED — it used to be optional and no caller passed it, so every
   * enhancement-description write reached a customer's system with no
   * before-image and no journal entry (see
   * the git history). Pass a real hook —
   * `withJournalledMutation()` in src/journal.ts — or `NO_JOURNAL` from
   * ./write.js to say out loud a write is not recorded.
   */
  onBeforeImage: (image: EnhancementBeforeImage) => Promise<void>;
};

// ---------------------------------------------------------------------------
// The core choreography
// ---------------------------------------------------------------------------

/**
 * Resolve → gate → (no-op check) → preflight transport → before-image hook →
 * LOCK → re-read-under-lock → patch `description` → PUT → UNLOCK, for an
 * EXISTING `ENHO/XH`, `ENHO/XHH` or `ENHS/XS` object.
 *
 * Matches `writeObject`'s step order: 1) `spec.read` GETs first, refusing
 * `NOT_FOUND` if absent — this module never creates. 2) The gate check
 * (`assertIntent`) runs BEFORE the no-op check, unconditionally, mirroring
 * `authorizeMutation`'s own ordering. 3) No-op short-circuits with no lock,
 * no PUT, `transport: not-determined`. 4) Optional pre-lock `expectEtag`
 * compare. 5) `preflightCorr`, pre-lock. 6) `onBeforeImage`, pre-lock. 7)
 * Inside `withStatefulSession`: `withRelockRetry`'s `reread` throws
 * `ETAG_CONFLICT` if the document moved since step 1 (read-modify-write
 * law); `rebuild` patches via `patchEnhancementRootAttribute`
 * (byte-preserving, never a full round trip); `attempt` reconciles the
 * preflight verdict against the lock's own transport via `corrForMutation`
 * (same asymmetric tie-break as `writeObject`, plus the same divergence
 * refusal) before PUTting, with `qs.corrNr` present iff `corr.kind ===
 * "transport"` (see `test/enhancement-write.test.ts`'s corrNr-shape test);
 * `session.unlock` runs explicitly right after, before any activation
 * (mirrors `writeObject`'s "activation while locked is a 403"). 8) A
 * `SESSION_DEAD` between steps is never retried and never silently
 * recovered against a stale lock handle. Full step-by-step reasoning:
 * the git history.
 */
/**
 * Pre-lock guard: SAP's enhancement PUT handler rejects ANY PUT (even one
 * unrelated to description) when the root `adtcore:description` would end up
 * empty — HTTP 400 `ExceptionInvalidData`, `SWB_TOOL19`/`scr_prop_no_decr`,
 * "The description is missing" (confirmed live). `nextDescription` is
 * whatever this write is about to leave as the root description —
 * `target.description` for `writeEnhancementDescription`, the object's own
 * current value (unless overridden by `setBadiImplementationActive`'s
 * `spec.description` escape hatch) for that function. Runs after each
 * function's no-op short-circuit and before any LOCK, so the common case —
 * an object that never had a description — refuses cheaply instead of
 * burning a lock/relock cycle. `putEnhancementDocument` re-checks the same
 * invariant against the actual outgoing bytes as defence in depth.
 */
function assertDescriptionWillBePresent(
  nextDescription: string | undefined,
  ctx: { name: string; type: EnhancementDocType | "ENHO/XH"; uri: string },
  hint: string,
): asserts nextDescription is string {
  if (nextDescription !== undefined && nextDescription !== "") return;
  throw new AbapError(
    "ENHANCEMENT_DESCRIPTION_REQUIRED",
    `${ctx.type} ${ctx.name}: this write would leave the root adtcore:description missing or empty. SAP's ` +
      'enhancement PUT handler rejects that unconditionally (HTTP 400 ExceptionInvalidData, SWB_TOOL19 / ' +
      'scr_prop_no_decr, "The description is missing") — even a write that has nothing to do with the ' +
      "description, like set_impl_active, is refused if the object has none. Nothing was locked or written.",
    { name: ctx.name, type: ctx.type, uri: ctx.uri },
    hint,
  );
}

/**
 * Defence-in-depth twin to {@link assertDescriptionWillBePresent}:
 * `adtcore:description` is CHAR60 — SAP rejects a longer value on the wire
 * (t100 SWB_TOOL/18, "Description too long") with no indication of the
 * limit. `src/tools/enh.ts` already refuses this pre-wire for the
 * `write_description` MCP operation; this catches every other caller of
 * `writeEnhancementDescription`/`setBadiImplementationActive`. Same pre-lock
 * placement as `assertDescriptionWillBePresent`.
 */
function assertDescriptionLength(
  description: string | undefined,
  ctx: { name: string; type: EnhancementDocType | "ENHO/XH"; uri: string },
): void {
  if (description === undefined || description.length <= 60) return;
  throw new AbapError(
    "BAD_INPUT",
    `${ctx.type} ${ctx.name}: description is ${description.length} characters, longer than SAP's 60-character ` +
      "limit for adtcore:description (t100 SWB_TOOL/18, \"Description too long\"). Nothing was locked or written.",
    { name: ctx.name, type: ctx.type, uri: ctx.uri, length: description.length },
  );
}

/**
 * UNCONFIRMED HYPOTHESIS — a hint added only AFTER a real write has already
 * failed as a generic `ADT_ERROR`, never a reason to refuse pre-emptively. A
 * live `set_impl_active` deactivate on an ENHO/XH BAdI implementation failed
 * twice with a T100 error (decoded via `reassembleSplitT100Variables` in
 * src/tool-errors.ts) reading "Enhancement <name> must still be adjusted".
 * That plausibly maps to `BadiImplementationRead.adjustmentStatus`
 * (`enho:adjustmentStatus`) not being `"adjusted"`, but no controlled
 * experiment isolates it from other state that may have differed at the
 * time. Full evidence and confidence analysis:
 * the git history.
 *
 * Deliberately never a pre-write refusal (would block calls that might
 * succeed) and never auto-sets `adjustmentStatus` to force the write
 * through (would falsely claim an adjustment that was never performed — the
 * only honest path is a real SPAU/SPDD adjustment outside this tool).
 *
 * Fires only when the failure is `ADT_ERROR` and `adjustmentStatus` was
 * already known, before the write, to be something other than `"adjusted"`;
 * never fires on any other error code; never replaces the real message,
 * only appends to `hint`.
 */
function hintAdjustmentStatusIfLikelyCause(
  e: unknown,
  adjustmentStatus: string | undefined,
  target: { name: string },
): never {
  if (isAbapError(e) && e.code === "ADT_ERROR" && adjustmentStatus !== undefined && adjustmentStatus !== "adjusted") {
    const observed = adjustmentStatus === "" ? "empty" : JSON.stringify(adjustmentStatus);
    const priorHint = e.hint ? `${e.hint} ` : "";
    throw new AbapError(
      e.code,
      e.message,
      e.details,
      `${priorHint}UNCONFIRMED HYPOTHESIS (not confirmed by experiment — see the doc comment on ` +
        "hintAdjustmentStatusIfLikelyCause in src/adt/enhancement-write.ts): " +
        `${target.name}'s own adjustmentStatus is ${observed}, not "adjusted". A live failure of this exact ` +
        'operation (deactivating a BAdI implementation) decoded, via T100 reassembly, to "Enhancement <name> ' +
        'must still be adjusted" — this MAY be the same precondition, but that link is not confirmed. If so, ' +
        `${target.name} likely needs an upgrade adjustment (SPAU/SPDD) performed outside this tool before this ` +
        "write can succeed; this tool will not set adjustmentStatus itself to force the write through, since " +
        "doing so would falsely claim an adjustment that was never actually performed.",
    );
  }
  throw e;
}

/**
 * The ONE call site for `conn.put` against an enhancement document
 * collection (confirmed via `grep -rn "conn\.put" src/adt/enhancement*.ts` —
 * `enhancement-bridge.ts`'s create/bridge ops never call `conn.put`).
 * Requires an `AuthorizedTarget<"write">` so "forgot to gate this call"
 * becomes a compile error — only `gate.authorizeIntent` can construct one.
 *
 * ALSO the defence-in-depth enforcement point for the non-empty-root-
 * description invariant `assertDescriptionWillBePresent` checks pre-lock:
 * inspects the actual outgoing `opts.body` via `hasEnhancementRootDescription`
 * rather than trusting the caller. Does not cover a hypothetical new call
 * site elsewhere — `test/enhancement-write.test.ts`'s "single conn.put call
 * site" test guards that by asserting the grep count directly.
 */
async function putEnhancementDocument(
  conn: AbapConnection,
  authorized: AuthorizedTarget<"write">,
  uri: string,
  opts: { headers: Record<string, string>; qs: Record<string, string>; body: string },
  ctx: { name: string; type: EnhancementDocType | "ENHO/XH" },
) {
  void authorized;
  if (!hasEnhancementRootDescription(opts.body)) {
    throw new AbapError(
      "ENHANCEMENT_DESCRIPTION_REQUIRED",
      `${ctx.type} ${ctx.name}: refusing to PUT — the outgoing document's root adtcore:description is missing ` +
        'or empty. SAP\'s enhancement PUT handler rejects this (HTTP 400 ExceptionInvalidData, SWB_TOOL19 / ' +
        'scr_prop_no_decr, "The description is missing") even when the write has nothing to do with the ' +
        "description. This should have been caught pre-lock; seeing this error instead means that guard was " +
        "bypassed somehow — please report it.",
      { name: ctx.name, type: ctx.type, uri },
      `Call abap_enh operation:"write_description" (name:"${ctx.name}", type:"${ctx.type}") to give this object ` +
        "a real description, then retry.",
    );
  }
  return conn.put(uri, opts);
}

export async function writeEnhancementDescription(
  conn: AbapConnection,
  gate: SafetyGate,
  target: { type: EnhancementDocType; name: string; description: string },
  opts: WriteEnhancementDescriptionOptions,
): Promise<EnhancementWriteResult> {
  if (typeof target.description !== "string") {
    throw new AbapError(
      "BAD_INPUT",
      "description must be a string; use undefined/omit the call to leave it alone. An empty string is a " +
        "well-formed request but is refused separately, below (ENHANCEMENT_DESCRIPTION_REQUIRED) — SAP's own " +
        "PUT handler does not accept an empty root description, so this operation cannot clear one.",
      { name: target.name, type: target.type },
    );
  }
  const spec = specFor(target.type);
  if (!spec) {
    throw new AbapError(
      "UNSUPPORTED",
      `${target.type} is not a type this module writes. Supported: ${ENHANCEMENT_WRITE_TYPES.join(", ")}.`,
      { type: target.type, name: target.name },
    );
  }
  // ---- 0. Discovery gate, fail-closed (not fail-open like assertSupported()
  // elsewhere) — a wrong verb here has previously crashed the session (see
  // discovery.ts's own doc comment); silence is never read as permission.
  conn.discovery.assertEnhancementCapable(spec.bareCollection, "PUT");

  const uri = buildEnhancementUri(spec.collection, target.name);
  const affects = opts.affects;

  // Defect 3, defense in depth — see assertDescriptionLength's doc comment.
  assertDescriptionLength(target.description, { name: target.name, type: target.type, uri });

  // ---- 1. Resolve — GET must succeed; this module never creates -----------
  const current = await spec.read(conn, target.name);
  const packageName = current.data.packageRef?.name ?? "";
  const masterSystem = current.data.masterSystem;
  const writeTarget: EnhancementWriteTarget = {
    type: target.type,
    name: target.name,
    uri,
    packageName,
    description: target.description,
    masterSystem,
  };

  /** Same shape `write.ts`'s shared refusal constructors expect. An
   *  enhancement document has no `TypeSpec`, so `type` itself is the
   *  human-facing label. */
  const refusalTarget: RefusalTarget = {
    name: writeTarget.name,
    type: writeTarget.type,
    uri: writeTarget.uri,
    packageName: writeTarget.packageName,
    spec: { label: writeTarget.type },
  };

  // ---- 2. Unconditional gate check — before any comparison ----------------
  const intent = enhancementIntentFor(
    { name: target.name, type: target.type, packageName, masterSystem },
    affects,
  );
  // `authorizeIntent` (not `assertIntent`): the returned token is the only
  // way to reach `putEnhancementDocument`'s `conn.put` further below.
  const authorized = gate.authorizeIntent("write", intent, writeTarget, { corr: { kind: "unresolved" } });

  const previousEtag = canonicalEtag(current.xml);

  // ---- 3. No-op short-circuit ------------------------------------------
  if ((current.data.description ?? "") === target.description) {
    return {
      target: writeTarget,
      affects,
      changed: false,
      etag: previousEtag,
      previousEtag,
      transport: { status: "not-determined", required: false, reason: "the description was already identical, so this call took no lock and ran no transport pre-check." },
      previousXml: current.xml,
      putVerified: spec.putVerifiedBy !== undefined,
    };
  }

  // ---- 3.5 Description-presence guard, pre-lock (SWB_TOOL19) --------------
  // No escape hatch needed here — target.description IS the value the root
  // will read after this PUT. This also means description:"" is refused
  // rather than attempted: SAP's PUT handler rejects an empty root
  // description the same as a missing one, so there is no live-safe way to
  // "clear" a description through this operation.
  assertDescriptionWillBePresent(
    target.description,
    { name: target.name, type: target.type, uri },
    "Provide a non-empty description. SAP's enhancement PUT handler does not accept an empty root " +
      "adtcore:description on this write either — there is no live-safe way to clear a description through " +
      "this operation.",
  );

  // ---- 4. Optional compare-before-write, pre-lock --------------------------
  if (opts.expectEtag !== undefined && opts.expectEtag !== previousEtag) {
    throw new AbapError(
      "ETAG_CONFLICT",
      `${target.type} ${target.name} changed since you read it.`,
      { name: target.name, type: target.type, uri, operation: "write", expectedEtag: opts.expectEtag, actualEtag: previousEtag },
      "Re-read the object, re-apply your change, and write again with the fresh etag. " +
        "Nothing was locked and nothing was written.",
    );
  }

  // ---- 5. TRANSPORT — pre-flight, before the lock --------------------------
  const preflightTarget: PreflightTarget = { uri, name: target.name, type: target.type, packageName };
  const transportOpts: TransportOptions =
    opts.transport === undefined
      ? { corrNr: opts.corrNr, affects }
      : { transport: opts.transport, gate: opts.gate, corrNr: opts.corrNr, affects };
  const preflight: GatedCorr | undefined = await preflightCorr(conn, preflightTarget, transportOpts, "U", "write");

  // ---- 6. Before-image hook, pre-lock (the journal seam) ------------------
  // Required at the type level (wired via withJournalledMutation in
  // src/tools/enh.ts and src/tools/v2/handlers/do/enhancements.ts); this
  // runtime guard covers callers test/ isn't type-checked against.
  if (opts.onBeforeImage) {
    await opts.onBeforeImage({
      xml: current.xml,
      target: writeTarget,
      affects,
      corrNr: preflight?.kind === "transport" ? preflight.corrNr : undefined,
    });
  }

  let finalXml = "";
  let finalEtag = "";
  let finalTransport: TransportInfo = { status: "not-determined", required: false, reason: "the lock response had not been read yet (this value is never returned)." };

  // ---- 7. LOCK -> reread -> patch -> PUT -> UNLOCK -------------------------
  await conn.withStatefulSession(async (session: StatefulSession) => {
    const outcome = await withRelockRetry<{ xml: string; etag?: string; transport: TransportInfo }>({
      session,
      uri,
      // NOT `lockAccept: spec.accept` — sending the document's own media type
      // as LOCK's Accept header gets a live 406 every time, every type.
      // Omitting it uses the session's own default Accept, which LOCK
      // accepts (confirmed live).
      retryable: enhancementRetryable,
      reread: async (lock: LockInfo) => {
        void lock;
        let body: string;
        try {
          const resp = await conn.get(uri, { headers: { Accept: spec.accept } });
          body = resp.body;
        } catch (e) {
          if (isAbapError(e)) throw e;
          throw translateAdtError(e, { operation: "write", uri, name: target.name, type: target.type });
        }
        // Read-modify-write law: the freshest bytes are what gets patched,
        // but the caller must be told when the document moved between the
        // pre-lock GET and the lock, not have it silently absorbed.
        const freshEtag = canonicalEtag(body);
        if (freshEtag !== previousEtag) {
          try {
            await session.unlock(uri);
          } catch {
            // Best-effort — the ETAG_CONFLICT below is the real answer either way.
          }
          throw postLockEtagConflict(refusalTarget, previousEtag, freshEtag);
        }
        return body;
      },
      rebuild: async (fresh: string) => patchEnhancementRootAttribute(fresh, "description", target.description),
      attempt: async (lock: LockInfo, payload: string) => {
        // Reconcile the preflight verdict against this lock's own transport,
        // using writeObject's same asymmetric tie-break.
        const lockTransport = transportFromLock(lock);
        const corr = corrForMutation(preflight, lockTransport);
        if (corr === undefined) {
          try {
            await session.unlock(uri);
          } catch {
            // best-effort
          }
          throw transportRefusal(refusalTarget, lockTransport, "written", opts.transport !== undefined);
        }
        if (
          corr.kind === "transport" &&
          lockTransport.required &&
          lockTransport.corrNr !== undefined &&
          lockTransport.corrNr !== "" &&
          lockTransport.corrNr.toUpperCase() !== corr.corrNr.toUpperCase()
        ) {
          try {
            await session.unlock(uri);
          } catch {
            // best-effort
          }
          // `created` is always false here — this write only ever touches an
          // existing document, so there is nothing to roll back.
          throw transportDivergence(refusalTarget, corr.corrNr, lockTransport.corrNr, false, { rolledBack: false });
        }
        // Literal two-shape switch, never a spread — corrNr is emitted iff
        // corr.kind === "transport". See the corrNr-shape test in
        // test/enhancement-write.test.ts.
        let resp;
        try {
          resp = await putEnhancementDocument(
            conn,
            authorized,
            uri,
            {
              headers: { "Content-Type": spec.accept, Accept: spec.accept },
              qs: corr.kind === "transport" ? { lockHandle: lock.handle, corrNr: corr.corrNr } : { lockHandle: lock.handle },
              body: payload,
            },
            { name: target.name, type: target.type },
          );
        } catch (e) {
          if (isAbapError(e)) throw e;
          throw translateAdtError(e, { operation: "write", uri, name: target.name, type: target.type });
        }
        const putEtag = firstHeader(resp.headers, "etag");
        const tinfo: TransportInfo =
          corr.kind === "transport"
            ? {
                status: "transport",
                required: true,
                corrNr: corr.corrNr,
                ...(lockTransport.corrUser === undefined ? {} : { corrUser: lockTransport.corrUser }),
                ...(lockTransport.corrText === undefined ? {} : { corrText: lockTransport.corrText }),
              }
            : lockTransport;
        return { xml: payload, etag: putEtag, transport: tinfo };
      },
    });

    // Explicit, before anything else — "activation while locked is a 403"
    // (writeObject's own discipline). withRelockRetry's success path does
    // not unlock itself; this releases the enqueue.
    await session.unlock(uri);

    finalXml = outcome.xml;
    finalEtag = outcome.etag ?? canonicalEtag(outcome.xml);
    finalTransport = outcome.transport;
  });

  return {
    target: writeTarget,
    affects,
    changed: true,
    etag: finalEtag,
    previousEtag,
    transport: finalTransport,
    previousXml: current.xml,
    xml: finalXml,
    putVerified: spec.putVerifiedBy !== undefined,
  };
}

// ---------------------------------------------------------------------------
// Write + activate composition — mirrors `writeObject`/`activateObject` being
// two separate calls at the tool layer, never one call that activates while
// still holding the lock. No-op writes are not activated: nothing
// changed, so there is nothing new to activate.
// ---------------------------------------------------------------------------

export interface WriteAndActivateEnhancementResult {
  write: EnhancementWriteResult;
  /** `undefined` when `write.changed` was `false` — nothing was written, so
   *  nothing was activated. */
  activation?: ActivationOutcome;
}

export async function writeAndActivateEnhancementDescription(
  conn: AbapConnection,
  gate: SafetyGate,
  target: { type: EnhancementDocType; name: string; description: string },
  opts: WriteEnhancementDescriptionOptions,
): Promise<WriteAndActivateEnhancementResult> {
  const write = await writeEnhancementDescription(conn, gate, target, opts);
  if (!write.changed) return { write };
  const activation = await activateObject(conn, { name: target.name, uri: write.target.uri });
  return { write, activation };
}

// ---------------------------------------------------------------------------
// Set active — LOCK -> re-read -> patch `enho:isActive` -> PUT -> UNLOCK, for
// an EXISTING ENHO/XH BAdI implementation ONLY. Exists to close the
// deactivate-before-delete gap: without it, `deleteEnhancementObject`'s H8
// refusal below could make an active implementation permanently
// undeletable through this server.
//
// Gated at "write" tier (op:"write", allowEnhancements, edit mode) — NOT the
// admin-tier op:"delete" `deleteEnhancementObject` uses. Deliberate:
// flipping isActive is reversible (call again with the opposite value),
// matching src/mode.ts's own `allowSourcePlugins` reasoning.
//
// Scope: ONE nested attribute, `enho:isActive` on ONE named
// `enho:badiImplementation` entry, patched byte-preservingly by
// `patchBadiImplementationActive`. This function only PUTs — it never calls
// `activateObject`; the tool layer (`runEnhSetActiveOperation` in
// src/tools/enh.ts) always activates afterward, unconditionally in both
// directions, because an un-activated PUT lands on the INACTIVE version
// (confirmed live) — the "ninth instance of the isActive-vs-adtcore:version
// defect class"; full history in
// the git history.
//
// `putVerified` inherits ENHO/XH's existing `putVerifiedBy: undefined` (see
// module header) — same unverified whole-document PUT mechanism
// `writeEnhancementDescription` already uses for this type.
// ---------------------------------------------------------------------------

export interface EnhancementActivationTarget {
  readonly type: "ENHO/XH";
  readonly name: string;
  /** The `enho:badiImplementation` entry's own `enho:name` that was actually
   *  resolved and flipped — NOT necessarily equal to `name` (the container).
   *  See `resolveBadiImplementationEntry` below for how this is picked. */
  readonly implName: string;
  readonly uri: string;
  readonly packageName: string;
  readonly active: boolean;
  readonly masterSystem?: string;
}

export interface EnhancementActivationResult {
  target: EnhancementActivationTarget;
  /** The object this write's enhancement `affects` — same threading reason as
   *  `EnhancementWriteResult.affects`. */
  affects: EnhancedObjectRef;
  /** `false` ⇒ the named implementation entry's `isActive` already matched
   *  the requested value; no lock was taken, no PUT was sent. */
  changed: boolean;
  etag: string;
  previousEtag: string;
  transport: TransportInfo;
  previousXml: string;
  xml?: string;
  putVerified: boolean;
}

export type SetBadiImplementationActiveOptions = EnhancementTransportOptions & {
  /** Compare-before-write, pre-lock — identical role to
   *  `WriteEnhancementDescriptionOptions.expectEtag`. */
  expectEtag?: string;
  /** REQUIRED — the journal seam, identical role and identical reasoning to
   *  `WriteEnhancementDescriptionOptions.onBeforeImage`. */
  onBeforeImage: (image: EnhancementBeforeImage) => Promise<void>;
};

/**
 * Resolves WHICH `<enho:badiImplementation>` entry a `set_impl_active` call
 * means — separate from `target.name` (the ENHO/XH container; a different
 * string in every real capture on file). Never guesses when ambiguous:
 * wrong-object activation on a live system is not a recoverable mistake.
 *
 * - `implName` given: exact match or `NOT_FOUND`, known entries in `details`.
 * - `implName` omitted, exactly one entry: that one (the common case).
 * - `implName` omitted, zero entries: `NOT_FOUND`.
 * - `implName` omitted, more than one entry: `BAD_INPUT` naming every entry
 *   found, so the caller can retry with `spec.implName` set.
 */
function resolveBadiImplementationEntry(
  badiData: BadiImplementationRead,
  implName: string | undefined,
  containerName: string,
  uri: string,
): BadiImplementationEntryRead {
  const entries = badiData.implementations;
  const knownEntries = entries.map((i) => i.name);
  if (implName !== undefined) {
    const entry = entries.find((i) => i.name === implName);
    if (!entry) {
      throw new AbapError(
        "NOT_FOUND",
        `${containerName} has no <enho:badiImplementation enho:name="${implName}"> entry in its own document — ` +
          "nothing to activate or deactivate.",
        { name: containerName, implName, type: "ENHO/XH", uri, knownEntries },
      );
    }
    return entry;
  }
  if (entries.length === 1) return entries[0]!;
  if (entries.length === 0) {
    throw new AbapError(
      "NOT_FOUND",
      `${containerName} has no <enho:badiImplementation> entries in its own document — nothing to activate or deactivate.`,
      { name: containerName, type: "ENHO/XH", uri, knownEntries },
    );
  }
  throw new AbapError(
    "BAD_INPUT",
    `${containerName} has ${entries.length} <enho:badiImplementation> entries (${knownEntries.join(", ")}) — ` +
      "spec.implName is required to say which one to activate or deactivate; omitting it is only safe when " +
      "there is exactly one.",
    { name: containerName, type: "ENHO/XH", uri, knownEntries },
  );
}

export async function setBadiImplementationActive(
  conn: AbapConnection,
  gate: SafetyGate,
  target: {
    name: string;
    active: boolean;
    implName?: string;
    /**
     * Escape hatch for ENHANCEMENT_DESCRIPTION_REQUIRED below — only takes
     * effect when the object currently has no description. Never overwrites
     * an existing, different description (refuses BAD_INPUT pre-lock
     * instead). A value matching the existing description is accepted as a
     * confirmation and injects nothing new.
     */
    description?: string;
  },
  opts: SetBadiImplementationActiveOptions,
): Promise<EnhancementActivationResult> {
  const spec = specFor("ENHO/XH");

  // ---- 0. Discovery gate — same fail-closed reasoning as
  // writeEnhancementDescription's identical step.
  conn.discovery.assertEnhancementCapable(spec.bareCollection, "PUT");

  const uri = buildEnhancementUri(spec.collection, target.name);
  const affects = opts.affects;

  // Defect 3, defense in depth — must run before the escape-hatch conflict
  // check below, which assumes a length-valid string.
  assertDescriptionLength(target.description, { name: target.name, type: "ENHO/XH", uri });

  // ---- 1. Resolve — GET must succeed; this never creates -------------------
  // spec.read for "ENHO/XH" is readBadiImplementation, so current.data is
  // BadiImplementationRead at runtime — same guarded cast H8 below makes.
  const current = await spec.read(conn, target.name);
  const badiData = current.data as BadiImplementationRead;
  const packageName = badiData.packageRef?.name ?? "";
  const masterSystem = badiData.masterSystem;
  // Captured now (cheap, pre-lock) but only ever consulted if the write
  // below fails — see hintAdjustmentStatusIfLikelyCause above.
  const adjustmentStatus = badiData.adjustmentStatus;

  // target.name is the container; which nested badiImplementation entry to
  // flip is a separate question — see resolveBadiImplementationEntry.
  const entry = resolveBadiImplementationEntry(badiData, target.implName, target.name, uri);

  const activationTarget: EnhancementActivationTarget = {
    type: "ENHO/XH",
    name: target.name,
    implName: entry.name,
    uri,
    packageName,
    active: target.active,
    masterSystem,
  };
  // Shape write.ts's shared helpers expect. description isn't meaningful
  // here; carrying the object's own current value keeps it truthful.
  const writeTarget: EnhancementWriteTarget = {
    type: "ENHO/XH",
    name: target.name,
    uri,
    packageName,
    description: badiData.description ?? "",
    masterSystem,
  };

  const refusalTarget: RefusalTarget = {
    name: activationTarget.name,
    type: activationTarget.type,
    uri: activationTarget.uri,
    packageName: activationTarget.packageName,
    spec: { label: activationTarget.type },
  };

  // ---- 2. Unconditional gate check — op:"write" (see this function's own
  // doc comment above for why this is deliberately not op:"delete").
  const intent = enhancementIntentFor(
    { name: target.name, type: "ENHO/XH", packageName, masterSystem },
    affects,
  );
  const authorized = gate.authorizeIntent("write", intent, writeTarget, { corr: { kind: "unresolved" } });

  const previousEtag = canonicalEtag(current.xml);

  // ---- 3. Description escape hatch, pre-lock (SWB_TOOL19) -------------------
  // Runs BEFORE the no-op short-circuit deliberately: argument validation
  // must never depend on whether the OTHER requested change (isActive)
  // happens to be a no-op. (Previously it ran after the no-op check, letting
  // a conflicting spec.description go unvalidated when `active` matched —
  // see the git history for the incident.)
  //
  // nextDescription is whatever the root will read as after this PUT: the
  // object's own current description, untouched, unless target.description
  // is supplied and the object currently has none.
  const existingDescription = badiData.description;
  let nextDescription = existingDescription;
  if (target.description !== undefined) {
    if (existingDescription !== undefined && existingDescription !== "" && existingDescription !== target.description) {
      throw new AbapError(
        "BAD_INPUT",
        `${target.name} already has a description ("${existingDescription}") — spec.description ` +
          `("${target.description}") differs and would silently overwrite it. spec.description on ` +
          "set_impl_active is only accepted when the object currently has none.",
        { name: target.name, type: "ENHO/XH", uri, existingDescription, suppliedDescription: target.description },
      );
    }
    nextDescription = target.description;
  }
  // `true` only when the escape hatch is actually filling a genuine gap —
  // what makes an isActive-matches call NOT a no-op: skipping the write
  // would leave the object permanently unwritable (SWB_TOOL19) while
  // reporting success.
  const injectingDescription =
    target.description !== undefined && (existingDescription === undefined || existingDescription === "");

  // ---- 4. No-op short-circuit ------------------------------------------------
  // A no-op means BOTH "isActive already matches" AND "nothing new to write
  // into the description" — see injectingDescription above.
  if (entry.isActive === target.active && !injectingDescription) {
    return {
      target: activationTarget,
      affects,
      changed: false,
      etag: previousEtag,
      previousEtag,
      transport: {
        status: "not-determined",
        required: false,
        reason: "isActive already matched the requested value, so this call took no lock and ran no transport pre-check.",
      },
      previousXml: current.xml,
      putVerified: spec.putVerifiedBy !== undefined,
    };
  }

  // ---- 4.5 Description-presence guard, pre-lock (SWB_TOOL19) ----------------
  // Only reached once we know a write will actually happen.
  assertDescriptionWillBePresent(
    nextDescription,
    { name: target.name, type: "ENHO/XH", uri },
    `${target.name} has no description of its own, and set_impl_active does not invent one. Call abap_enh ` +
      `operation:"write_description" (name:"${target.name}", type:"ENHO/XH") first, then retry — or pass ` +
      "spec.description in this same call (only accepted when the object currently has none, as it does now).",
  );

  // ---- 5. Optional compare-before-write, pre-lock ----------------------------
  if (opts.expectEtag !== undefined && opts.expectEtag !== previousEtag) {
    throw new AbapError(
      "ETAG_CONFLICT",
      `ENHO/XH ${target.name} changed since you read it.`,
      { name: target.name, type: "ENHO/XH", uri, operation: "write", expectedEtag: opts.expectEtag, actualEtag: previousEtag },
      "Re-read the object, re-apply your change, and write again with the fresh etag. " +
        "Nothing was locked and nothing was written.",
    );
  }

  // ---- 6. TRANSPORT — pre-flight, before the lock ----------------------------
  const preflightTarget: PreflightTarget = { uri, name: target.name, type: "ENHO/XH", packageName };
  const transportOpts: TransportOptions =
    opts.transport === undefined
      ? { corrNr: opts.corrNr, affects }
      : { transport: opts.transport, gate: opts.gate, corrNr: opts.corrNr, affects };
  const preflight: GatedCorr | undefined = await preflightCorr(conn, preflightTarget, transportOpts, "U", "write");

  // ---- 7. Before-image hook, pre-lock (the journal seam) --------------------
  if (opts.onBeforeImage) {
    await opts.onBeforeImage({
      xml: current.xml,
      target: writeTarget,
      affects,
      corrNr: preflight?.kind === "transport" ? preflight.corrNr : undefined,
    });
  }

  let finalXml = "";
  let finalEtag = "";
  let finalTransport: TransportInfo = {
    status: "not-determined",
    required: false,
    reason: "the lock response had not been read yet (this value is never returned).",
  };

  // ---- 8. LOCK -> reread -> patch -> PUT -> UNLOCK ---------------------------
  // Wrapped in try/catch ONLY so a failure can be enriched with
  // `hintAdjustmentStatusIfLikelyCause` below — every throw inside is
  // rethrown unchanged unless that function's own narrow condition matches.
  try {
    await conn.withStatefulSession(async (session: StatefulSession) => {
      const outcome = await withRelockRetry<{ xml: string; etag?: string; transport: TransportInfo }>({
        session,
        uri,
        // See writeEnhancementDescription's identical comment: no `lockAccept`
        // override — the document's own media type gets a live 406 on LOCK.
        retryable: enhancementRetryable,
        reread: async (lock: LockInfo) => {
          void lock;
          let body: string;
          try {
            const resp = await conn.get(uri, { headers: { Accept: spec.accept } });
            body = resp.body;
          } catch (e) {
            if (isAbapError(e)) throw e;
            throw translateAdtError(e, { operation: "write", uri, name: target.name, type: "ENHO/XH" });
          }
          const freshEtag = canonicalEtag(body);
          if (freshEtag !== previousEtag) {
            try {
              await session.unlock(uri);
            } catch {
              // Best-effort — the ETAG_CONFLICT below is the real answer either way.
            }
            throw postLockEtagConflict(refusalTarget, previousEtag, freshEtag);
          }
          return body;
        },
        rebuild: async (fresh: string) => {
          const flipped = patchBadiImplementationActive(fresh, entry.name, target.active);
          // Only touches the root description when injectingDescription is
          // true; otherwise left byte-identical.
          return injectingDescription ? patchEnhancementRootAttribute(flipped, "description", nextDescription!) : flipped;
        },
        attempt: async (lock: LockInfo, payload: string) => {
          const lockTransport = transportFromLock(lock);
          const corr = corrForMutation(preflight, lockTransport);
          if (corr === undefined) {
            try {
              await session.unlock(uri);
            } catch {
              // best-effort
            }
            throw transportRefusal(refusalTarget, lockTransport, "written", opts.transport !== undefined);
          }
          if (
            corr.kind === "transport" &&
            lockTransport.required &&
            lockTransport.corrNr !== undefined &&
            lockTransport.corrNr !== "" &&
            lockTransport.corrNr.toUpperCase() !== corr.corrNr.toUpperCase()
          ) {
            try {
              await session.unlock(uri);
            } catch {
              // best-effort
            }
            throw transportDivergence(refusalTarget, corr.corrNr, lockTransport.corrNr, false, { rolledBack: false });
          }
          let resp;
          try {
            resp = await putEnhancementDocument(
              conn,
              authorized,
              uri,
              {
                headers: { "Content-Type": spec.accept, Accept: spec.accept },
                qs: corr.kind === "transport" ? { lockHandle: lock.handle, corrNr: corr.corrNr } : { lockHandle: lock.handle },
                body: payload,
              },
              { name: target.name, type: "ENHO/XH" },
            );
          } catch (e) {
            if (isAbapError(e)) throw e;
            throw translateAdtError(e, { operation: "write", uri, name: target.name, type: "ENHO/XH" });
          }
          const putEtag = firstHeader(resp.headers, "etag");
          const tinfo: TransportInfo =
            corr.kind === "transport"
              ? {
                  status: "transport",
                  required: true,
                  corrNr: corr.corrNr,
                  ...(lockTransport.corrUser === undefined ? {} : { corrUser: lockTransport.corrUser }),
                  ...(lockTransport.corrText === undefined ? {} : { corrText: lockTransport.corrText }),
                }
              : lockTransport;
          return { xml: payload, etag: putEtag, transport: tinfo };
        },
      });

      await session.unlock(uri);

      finalXml = outcome.xml;
      finalEtag = outcome.etag ?? canonicalEtag(outcome.xml);
      finalTransport = outcome.transport;
    });
  } catch (e) {
    hintAdjustmentStatusIfLikelyCause(e, adjustmentStatus, { name: target.name });
  }

  return {
    target: activationTarget,
    affects,
    changed: true,
    etag: finalEtag,
    previousEtag,
    transport: finalTransport,
    previousXml: current.xml,
    xml: finalXml,
    putVerified: spec.putVerifiedBy !== undefined,
  };
}

// ---------------------------------------------------------------------------
// Delete — LOCK -> re-read -> DELETE, for an EXISTING ENHO/XH, ENHO/XHH or
// ENHS/XS object. Opt-in (`ABAP_ALLOW_ENHANCEMENT_DELETE`). For `ENHO/XH`
// specifically, ONE hard, flag-independent refusal (H8): a BAdI
// implementation reported (or not confirmably NOT) active is never deleted
// — deleting it would silently switch off live business logic with no error
// and no log, the same hazard `undoBlocker()` (src/adt/undo.ts) already
// refuses for undo-of-create against the same type. The other three named
// hazards (H7, H26-H28) don't need an additional refusal here — see
// the git history for why.
//
// Deliberately NOT `write.ts`'s generic `deleteObject` (assumes a single
// `/source/main` sub-resource, never true for any of these three types).
// Mirrors `deleteObject`'s delete-specific concerns instead — two-GET
// pattern, required `onBeforeImage`, `session.forgetLock()` rather than an
// explicit UNLOCK ("deleting a class takes its includes with it") — layered
// onto `writeEnhancementDescription`'s own choreography.
// ---------------------------------------------------------------------------

export interface EnhancementDeleteTarget {
  readonly type: EnhancementDocType;
  readonly name: string;
  readonly uri: string;
  readonly packageName: string;
  readonly masterSystem?: string;
}

export interface EnhancementDeleteResult {
  readonly target: EnhancementDeleteTarget;
  /** The object this delete's enhancement `affects` — same threading reason
   *  as `EnhancementWriteResult.affects`. */
  readonly affects: EnhancedObjectRef;
  readonly deleted: true;
  /** Content hash of the whole document as it stood immediately before the
   *  DELETE (post-lock re-read), canonicalised like `EnhancementWriteResult.etag`. */
  readonly previousEtag: string;
  /** The whole document's raw XML as it stood before this call (post pre-lock
   *  GET) — what the journal's before-image is built from. */
  readonly previousXml: string;
  readonly transport: TransportInfo;
}

export interface EnhancementDeleteBeforeImage {
  /** The whole document's raw XML, exactly as GET returned it before the lock. */
  readonly xml: string;
  readonly target: EnhancementDeleteTarget;
  readonly affects: EnhancedObjectRef;
  readonly corrNr?: string;
}

export type DeleteEnhancementObjectOptions = EnhancementTransportOptions & {
  /** Compare-before-delete: reject if the whole document's current
   *  content hash differs from this, pre-lock. */
  expectEtag?: string;
  /**
   * REQUIRED — a delete is the one mutation abapsmith cannot repeat its way
   * out of, and without a before-image the document is gone. See
   * `withJournalledMutation` (`src/journal.ts`).
   */
  onBeforeImage: (image: EnhancementDeleteBeforeImage) => Promise<void>;
  /**
   * The config-level opt-in (`ABAP_ALLOW_ENHANCEMENT_DELETE`) — REQUIRED,
   * never read from `process.env` here (this module never imports `Config`).
   * Checked before any network call. A double gate deliberately:
   * `src/tools/enh.ts` performs the identical check as its own zero-network
   * preflight; this module's own check protects any future non-`enh.ts`
   * caller of `deleteEnhancementObject`.
   */
  allowEnhancementDelete: boolean;
  /**
   * Which MECHANISM produced `allowEnhancementDelete` — `Config.abapMode`,
   * threaded through only so the refusal below can name the deciding input;
   * nothing here reads it to grant or deny. Only the TYPE is imported from
   * `../mode.js`, preserving the adt-layer's never-imports-`Config` invariant.
   */
  abapMode?: AbapMode;
};

/**
 * The only way to reach the `conn.del` that removes the enhancement document
 * — same `AuthorizedTarget<"delete">` discipline as `putEnhancementDocument`
 * above; only `gate.authorizeIntent("delete", …)` can construct that token.
 */
async function deleteEnhancementDocument(
  conn: AbapConnection,
  authorized: AuthorizedTarget<"delete">,
  uri: string,
  opts: { qs: Record<string, string> },
) {
  void authorized;
  return conn.del(uri, opts);
}

export async function deleteEnhancementObject(
  conn: AbapConnection,
  gate: SafetyGate,
  target: { type: EnhancementDocType; name: string },
  opts: DeleteEnhancementObjectOptions,
): Promise<EnhancementDeleteResult> {
  const spec = specFor(target.type);
  if (!spec) {
    throw new AbapError(
      "UNSUPPORTED",
      `${target.type} is not a type this module deletes. Supported: ${ENHANCEMENT_WRITE_TYPES.join(", ")}.`,
      { type: target.type, name: target.name },
    );
  }

  // ---- Config-level double gate — BEFORE any network call ------------------
  // Does NOT lift the H8 check below — only decides whether delete is
  // reachable at all; H8 has no override flag.
  if (opts.allowEnhancementDelete !== true) {
    // Previously named ABAP_ALLOW_ENHANCEMENT_DELETE unconditionally, so an
    // ABAP_MODE=edit operator (where that var is never read) was told to set
    // a flag they'd already set. explainDeniedCapability names the mechanism
    // actually in force instead of assuming one.
    const why = explainDeniedCapability("allowEnhancementDelete", opts.abapMode);
    throw new AbapError(
      "ENHANCEMENT_DISABLED",
      `Deleting an existing enhancement object is disabled. ${why.cause}`,
      {
        type: target.type,
        name: target.name,
        allowEnhancementDelete: opts.allowEnhancementDelete,
        // Named so a reader of the structured payload can tell which layer
        // decided without parsing the sentence above.
        decidedBy: why.decidedBy,
        ...(opts.abapMode !== undefined ? { abapMode: opts.abapMode } : {}),
      },
      why.remediation,
    );
  }

  // ---- 0. Discovery gate, fail-closed — see writeEnhancementDescription's
  // identical step for why this is fail-closed rather than fail-open here.
  conn.discovery.assertEnhancementCapable(spec.bareCollection, "DELETE");

  const uri = buildEnhancementUri(spec.collection, target.name);
  const affects = opts.affects;

  // ---- 1. Resolve — GET must succeed; nothing here creates -----------------
  const current = await spec.read(conn, target.name);
  const packageName = current.data.packageRef?.name ?? "";
  const masterSystem = current.data.masterSystem;
  const deleteTarget: EnhancementDeleteTarget = { type: target.type, name: target.name, uri, packageName, masterSystem };

  const refusalTarget: RefusalTarget = {
    name: deleteTarget.name,
    type: deleteTarget.type,
    uri: deleteTarget.uri,
    packageName: deleteTarget.packageName,
    spec: { label: deleteTarget.type },
  };

  // ---- H8 — hard, flag-independent refusal (see this function's own
  // section header above). current.data is BadiImplementationRead at
  // runtime whenever type === "ENHO/XH" (spec.read is readBadiImplementation)
  // — a guarded cast, not blind widening. isActive !== false treats both
  // `true` and `undefined` as "could be active" (unknown is never evidence
  // of safety), matching undoBlocker's own H8 policy in src/adt/undo.ts.
  if (target.type === "ENHO/XH") {
    const badiData = current.data as BadiImplementationRead;
    const unsafe = badiData.implementations.filter((impl) => impl.isActive !== false);
    if (unsafe.length > 0) {
      throw new AbapError(
        "ENHANCEMENT_ACTIVE_IMPLEMENTATION",
        `${target.name} has ${unsafe.length} BAdI implementation entr${unsafe.length === 1 ? "y" : "ies"} ` +
          `that ${unsafe.length === 1 ? "is" : "are"} active or not confirmably inactive ` +
          `(${unsafe.map((i) => `${i.name}: isActive=${i.isActive === undefined ? "unknown" : String(i.isActive)}`).join(", ")}) ` +
          "— deleting this object would silently switch off live business logic with no error " +
          "and no log (H8). This refusal has NO override: not ABAP_ALLOW_ENHANCEMENT_DELETE, not " +
          "any other flag.",
        {
          type: target.type,
          name: target.name,
          implementations: badiData.implementations.map((i) => ({ name: i.name, isActive: i.isActive })),
        },
        "Deactivate every implementation entry first — abap_enh operation:\"set_impl_active\" " +
          `(name: "${target.name}", the object being deleted — NOT an entry's own name; spec.implName: ` +
          "one of the names listed in this refusal's own details.implementations above; spec.active: false) " +
          "flips enho:isActive via the same PUT mechanism write_description uses (putVerified:false for " +
          "ENHO/XH, same as every other write against this type) — repeat once per entry listed above, " +
          "then re-read the object to confirm isActive=false on all entries before deleting again; this " +
          "refusal does not lift automatically. If the object has no adtcore:description at all, that " +
          "set_impl_active call will itself refuse first with ENHANCEMENT_DESCRIPTION_REQUIRED — SAP rejects " +
          'every enhoxh/enhoxhh/enhsxs PUT without one, even one only flipping isActive; call operation:"' +
          'write_description" once beforehand, or add spec.description to the same set_impl_active call ' +
          "(accepted only when the object currently has none), then retry.",
      );
    }
  }

  // ---- 2. Unconditional gate check — mints the AuthorizedTarget<"delete">
  const intent = enhancementIntentFor(
    { name: target.name, type: target.type, packageName, masterSystem },
    affects,
  );
  const authorized = gate.authorizeIntent("delete", intent, deleteTarget, { corr: { kind: "unresolved" } });

  const previousEtag = canonicalEtag(current.xml);

  // ---- 3. Optional compare-before-delete, pre-lock --------------------------
  if (opts.expectEtag !== undefined && opts.expectEtag !== previousEtag) {
    throw new AbapError(
      "ETAG_CONFLICT",
      `${target.type} ${target.name} changed since you read it.`,
      { name: target.name, type: target.type, uri, operation: "delete", expectedEtag: opts.expectEtag, actualEtag: previousEtag },
      "Re-read the object, confirm it is still the one you meant to delete, and delete again " +
        "with the fresh etag. Nothing was locked and nothing was deleted.",
    );
  }

  // ---- 4. TRANSPORT — pre-flight, before the lock --------------------------
  const preflightTarget: PreflightTarget = { uri, name: target.name, type: target.type, packageName };
  const transportOpts: TransportOptions =
    opts.transport === undefined
      ? { corrNr: opts.corrNr, affects }
      : { transport: opts.transport, gate: opts.gate, corrNr: opts.corrNr, affects };
  const preflight: GatedCorr | undefined = await preflightCorr(conn, preflightTarget, transportOpts, "U", "delete");

  // ---- 5. Before-image hook, pre-lock (the journal seam) -------------------
  if (opts.onBeforeImage) {
    await opts.onBeforeImage({
      xml: current.xml,
      target: deleteTarget,
      affects,
      corrNr: preflight?.kind === "transport" ? preflight.corrNr : undefined,
    });
  }

  let finalTransport: TransportInfo = { status: "not-determined", required: false, reason: "the lock response had not been read yet (this value is never returned)." };

  // ---- 6. LOCK -> reread -> DELETE ------------------------------------------
  await conn.withStatefulSession(async (session: StatefulSession) => {
    const outcome = await withRelockRetry<{ transport: TransportInfo }>({
      session,
      uri,
      // See writeEnhancementDescription's identical comment: no `lockAccept`
      // override — the document's own media type gets a live 406 on LOCK.
      retryable: enhancementRetryable,
      reread: async (lock: LockInfo) => {
        void lock;
        let body: string;
        try {
          const resp = await conn.get(uri, { headers: { Accept: spec.accept } });
          body = resp.body;
        } catch (e) {
          if (isAbapError(e)) throw e;
          throw translateAdtError(e, { operation: "delete", uri, name: target.name, type: target.type });
        }
        const freshEtag = canonicalEtag(body);
        if (freshEtag !== previousEtag) {
          try {
            await session.unlock(uri);
          } catch {
            // Best-effort — the ETAG_CONFLICT below is the real answer either way.
          }
          throw postLockEtagConflict(refusalTarget, previousEtag, freshEtag);
        }
        return body;
      },
      // No payload to build for a DELETE — `withRelockRetry` still requires the
      // slot, so this is the identity function; `attempt` below never reads it.
      rebuild: async (fresh: string) => fresh,
      attempt: async (lock: LockInfo, payload: string) => {
        void payload;
        const lockTransport = transportFromLock(lock);
        const corr = corrForMutation(preflight, lockTransport);
        if (corr === undefined) {
          try {
            await session.unlock(uri);
          } catch {
            // best-effort
          }
          throw transportRefusal(refusalTarget, lockTransport, "deleted", opts.transport !== undefined);
        }
        if (
          corr.kind === "transport" &&
          lockTransport.required &&
          lockTransport.corrNr !== undefined &&
          lockTransport.corrNr !== "" &&
          lockTransport.corrNr.toUpperCase() !== corr.corrNr.toUpperCase()
        ) {
          try {
            await session.unlock(uri);
          } catch {
            // best-effort
          }
          throw transportDivergence(refusalTarget, corr.corrNr, lockTransport.corrNr, false, { rolledBack: false });
        }
        try {
          await deleteEnhancementDocument(conn, authorized, uri, {
            qs: corr.kind === "transport" ? { lockHandle: lock.handle, corrNr: corr.corrNr } : { lockHandle: lock.handle },
          });
        } catch (e) {
          if (isAbapError(e)) throw e;
          throw translateAdtError(e, { operation: "delete", uri, name: target.name, type: target.type });
        }
        const tinfo: TransportInfo =
          corr.kind === "transport"
            ? {
                status: "transport",
                required: true,
                corrNr: corr.corrNr,
                ...(lockTransport.corrUser === undefined ? {} : { corrUser: lockTransport.corrUser }),
                ...(lockTransport.corrText === undefined ? {} : { corrText: lockTransport.corrText }),
              }
            : lockTransport;
        return { transport: tinfo };
      },
    });

    // The object and its enqueue are both gone: an UNLOCK now would be a
    // wasted request against a 404 — "deleting a class takes its includes
    // with it" (write.ts's deleteObject, same reasoning). withRelockRetry's
    // success path never unlocks itself, so this releases the ledger entry.
    session.forgetLock(uri);

    finalTransport = outcome.transport;
  });

  return {
    target: deleteTarget,
    affects,
    deleted: true,
    previousEtag,
    previousXml: current.xml,
    transport: finalTransport,
  };
}
