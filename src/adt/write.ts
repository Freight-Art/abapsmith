/**
 * Write path: resolve target (need not exist) → create if missing → lock →
 * PUT source → unlock. PROG/P → /programs/programs, CLAS/OC → /oo/classes,
 * INTF/OI → /oo/interfaces (200, empty body); TABL/DT → /ddic/tables (201 +
 * Location + etag + 2.4 KB).
 *
 * Non-negotiables (the git history carries the full reasoning behind each):
 *  - Compare-before-write runs pre-lock (cheap) AND again, unconditionally,
 *    once the lock is held — the GET→lock window (transport pre-check,
 *    journal writes, a 3–8s create) is a race another writer can land in.
 *  - A byte-identical source is never written — compare via `contentHash()`,
 *    which normalises the server's LF→CRLF round-trip.
 *  - The lock handle never escapes this module; `writeObject` never
 *    activates (a 403 under your own lock). Every path runs inside
 *    `AbapConnection.withStatefulSession()`.
 *  - Object creation takes 3–8s; DDIC table activation up to 8s more — no
 *    short timeouts here.
 *  - The safety gate judges the server's package, never the caller's;
 *    `resolveWriteTarget` fails closed when it cannot determine it.
 *
 * `writeObject`/`deleteObject`/`createPackage` accept only a capability-checked
 * `AuthorizedTarget<MutatingOperation, ResolvedTarget>` (`src/safety.ts`),
 * minted solely via `SafetyGate.authorize`/`authorizeMutation` below — forgetting
 * the gate is a compile error, not a convention to drop. Exception:
 * `src/adt/undo.ts` still passes a bare `WriteTarget`-shaped object
 * (own `assertAllowed` callback); pre-existing, out of scope here.
 */
import { CreatableTypes, type CreatableTypeIds } from "abap-adt-api";
import { canonicalSource, contentHash, isPartialEtag, stripPartialEtag } from "../compact.js";
import {
  isAddressableAbapObjectName,
  isEnhancementType,
  type AuthorizedTarget,
  type EnhancementIntent,
  type MutatingOperation,
  type SafetyGate,
} from "../safety.js";
import {
  checkSource,
  normaliseAdtUri,
  renderMessages,
  summariseMessages,
  type CheckOutcome,
} from "./activate.js";
import type { AbapConnection } from "./connection.js";
import { assertBridgeMutation } from "./ddic-bridge.js";
import { missingEnhancementWrapperError } from "./enhancement-refusals.js";
import { AbapError, describeUnknownError, isAbapError } from "./errors.js";
import { deletePackageViaBridge } from "./package-delete.js";
import { activationFromVersion, identifyByName, parseObjectRef, type ActivationState } from "./resolve.js";
import { toAbapError, type SessionTransport } from "./session-transport.js";
import {
  adtExceptionInfo,
  isNotFoundError,
  translateAdtError,
  type LockInfo,
  type StatefulSession,
} from "./session.js";
import { classifyCorrNrError, type TrOperation } from "./transports.js";
import { parsePackageRef, XML_COMMENT_RE } from "./package-ref.js";
import { verifyObjectDeleted, verifyObjectPresent, type VerifyOutcome } from "./write-verify.js";
import {
  assertClassInclude,
  CLASS_INCLUDES,
  buildUri,
  classIncludeUri,
  specForKeyword,
  specForType,
  type ClassInclude,
  type TypeSpec,
} from "./types.js";

// Backward-compatible re-export: other modules have historically imported
// `AuthorizedTarget`/`MutatingOperation` FROM this file rather than from
// `src/safety.ts` directly. The real definitions now live in safety.ts —
// this is a pure alias, not a second declaration.
export type { AuthorizedTarget, MutatingOperation } from "../safety.js";

/**
 * The object an enhancement `affects` — needed because `SafetyGate.evaluate()`
 * cannot derive it from the enhancement artefact's own URI/name/package.
 * Threaded through `WriteTarget`/`TransportOptions` so `authorizeMutation`/
 * `preflightCorr` can build the `EnhancementIntent` the gate requires for
 * enhancement types (`isEnhancementType`, `src/safety.ts`); its absence there
 * is a refusal, not a silent skip. See archive for full rationale.
 */
export interface EnhancedObjectRef {
  /** Name of the object this enhancement intercepts or binds to. */
  name: string;
  packageName: string;
  /** `adtcore:masterSystem` of the affected object, when known (SID string, e.g. "SAP", "A4H"). */
  masterSystem?: string;
  /** The enhancement spot name, when the affected object is reached through one rather than named directly. */
  spotName?: string;
}

/** What to write. The object need not exist yet. */
export interface WriteTarget {
  /** ADT type code or keyword, e.g. "PROG/P", "CLAS/OC", "TABL/DT", "report". */
  type?: string;
  /** Object name, uppercased by the resolver. */
  name: string;
  /** Package for a *new* object. Existing objects keep theirs. */
  packageName?: string;
  description?: string;
  /** For a `DEVC/K` create only: the parent package in the package hierarchy. Empty/undefined means a root package. */
  superPackage?: string;
  /**
   * The CONTAINER object this one lives inside — a function group for a
   * `FUGR/FF`. Only meaningful for types whose `TypeSpec` has a `parentPath`
   * and whose registry entry declares `create.parent: "container"`.
   *
   * Optional here because it is usually already inside `name`:
   * `"ZMY_GROUP/Z_MY_FM"` and `"Z_MY_FM in ZMY_GROUP"` both parse into a
   * container (`parseObjectRef`). This field is the explicit spelling for
   * callers that have the two apart, and it WINS over the parsed one when both
   * are present and they disagree — an argument the caller wrote by hand is a
   * stronger statement of intent than a slash in a name.
   */
  containerName?: string;
  /** The object this mutation `affects`, required whenever `type` is an enhancement type. See {@link EnhancedObjectRef}. */
  affects?: EnhancedObjectRef;
  /**
   * Which of a global class's five source sections to write.
   *
   * `undefined` and `"main"` both mean the main class body, which is what every
   * write did before this existed. `definitions`/`implementations`/`macros`/
   * `testclasses` address the CCDEF/CCIMP/CCMAC/CCAU local includes — the only
   * place ABAP Unit test classes can live.
   *
   * Only meaningful for `CLAS/OC`. Naming one on any other type is a loud
   * refusal, never a silent downgrade to the main source.
   */
  include?: ClassInclude;
}

export interface ResolvedTarget {
  spec: TypeSpec;
  type: string;
  name: string;
  uri: string;
  sourceUri: string;
  /**
   * The object's package. When `packageSource === "server"` this is what the
   * system itself reported; it is never guessed (see `resolveWriteTarget`).
   */
  packageName: string;
  description: string;
  /** The object exists on the server right now — a real GET said so. */
  exists: boolean;
  /**
   * Where `packageName` came from. `"server"` ⇒ read off the object's own
   * `adtcore:packageRef`. `"requested"` ⇒ the object does not exist yet, so the
   * caller's package (defaulted to `$TMP`) is the only truth there can be.
   */
  packageSource: "server" | "requested";
  /** For a `DEVC/K` create only: the parent package in the package hierarchy. Empty/undefined means a root package. */
  superPackage?: string;
  /**
   * The container object this one lives inside — see
   * {@link WriteTarget.containerName}. Present exactly when the type's
   * `TypeSpec` has a `parentPath`, and it is what `{parent}` in `uri` was built
   * from, so the two can never disagree.
   */
  containerName?: string;
  /**
   * `adtcore:masterSystem` off the same GET `packageName` came from — a SID
   * string (e.g. `"SAP"`, `"A4H"`), generic to ADT object metadata and not
   * enhancement-specific (verified live on CLAS/OC, ENHS/XS and ENHO/XHH
   * alike). `undefined` on a create (`exists: false`): there is no server
   * document yet to read it from, and this is never guessed.
   */
  masterSystem?: string;
  /**
   * The class include `sourceUri` addresses, when the caller named one.
   * `undefined` means no include was named — NOT the same as `"main"`, so a
   * consumer can still tell "the caller asked for the main body" from "the
   * caller said nothing". See {@link WriteTarget.include}.
   */
  include?: ClassInclude;
  /**
   * Free evidence off the SAME GET `packageName` came from:
   * `"active-is-current"` only when every `adtcore:version` attribute in the
   * body — root plus every class include — agreed; see `activationFromBody`.
   * `"unknown"`/absent on a create (`exists: false`, nothing to read yet), on
   * anything unparseable or mixed, and on the handful of synthetic
   * `ResolvedTarget`s built outside `resolveWriteTarget` (`bopf.ts`,
   * `tools/bopf.ts` readCurrentSource placeholders) — optional rather than
   * required so those keep compiling; absent must read exactly like
   * `"unknown"` everywhere this is checked. Lets `deployBridge` skip a
   * redundant activation POST without a second round trip — see its F6 comment.
   */
  activation?: ActivationState;
}

/**
 * What this call can say about the object's transport status: `"local"`,
 * `"transport"`, or `"not-determined"` (nobody asked — never inferred from
 * the package name or from an absent corrNr; see archive for the defect this
 * third state fixes). `required` answers a different question from `status`:
 * "did THIS operation put the object into a transport?", not "is the object
 * transportable?" — on `not-determined` it is `false` because nothing was
 * written/locked/sent, not because the object is local. Switch on `status`
 * for the object-level answer, never on `required`.
 */
export type TransportInfo =
  /** The lock said `IS_LOCAL = X` with an empty CORRNR — measured, not assumed. */
  | {
      readonly status: "local";
      readonly required: false;
      readonly corrNr?: undefined;
      readonly corrUser?: undefined;
      readonly corrText?: undefined;
    }
  /**
   * `corrNr` is the number this call sent, or what the lock reported. Optional
   * because `transportFromLock` can see `IS_LOCAL` empty with an empty CORRNR
   * too — the server saying "transportable" without naming a request.
   */
  | {
      readonly status: "transport";
      readonly required: true;
      readonly corrNr?: string;
      readonly corrUser?: string;
      readonly corrText?: string;
    }
  /** Nobody asked the system — a statement about our own ignorance, never inferred. */
  | {
      readonly status: "not-determined";
      readonly required: false;
      /** Why nobody asked — reported verbatim, so the caller can judge it. */
      readonly reason: string;
      readonly corrNr?: undefined;
      readonly corrUser?: undefined;
      readonly corrText?: undefined;
    };

/** The only way to spell "we did not ask", and it always has to say why. */
function notDetermined(reason: string): TransportInfo {
  return { status: "not-determined", required: false, reason };
}

/**
 * The transport decision as the mutating HTTP request itself sees it. A
 * transportable write with no `corrNr` does not fail — see archive for the
 * 2026-08-01 incident (SAP silently fabricated request `A4HK900117`) that
 * makes omitting the number *strictly worse* than refusing. This type makes
 * `{ required: true, corrNr: undefined }` unrepresentable: the transportable
 * arm's `corrNr` is `string`, full stop, so `putSource`/DELETE can build
 * their query string by switching on `kind` and never emit a transport
 * write without a number. `corrForMutation` returning `undefined` is the
 * only refusal path.
 */
export type WriteCorr =
  | { readonly kind: "local" }
  | { readonly kind: "transport"; readonly corrNr: string };

declare const CORR_GATED: unique symbol;

/**
 * A `WriteCorr` whose transport arm has been judged by the gate against the
 * REAL TRKORR. `putSource` and the DELETE take this, not `WriteCorr`, so
 * "a transport number reached the wire without step 10 seeing it" has no
 * representation. Minted in exactly one place: `preflightCorr`, on the line
 * after `gate.assert`.
 */
export type GatedCorr =
  | { readonly kind: "local" }
  | {
      readonly kind: "transport";
      readonly corrNr: string;
      readonly [CORR_GATED]: true;
      /**
       * "named"/"auto" provenance the gate already judged this corrNr under
       * (see `SafetyCorr` in src/safety.ts) — carried through so a SECOND
       * gate.assert on the same mutation (e.g. the package-delete bridge's
       * own domain-object gate) can judge the identical corr instead of
       * synthesising a fabricated "auto".
       */
      readonly source: "named" | "auto";
    };

/** The one and only `local` value — there is nothing to vary. No brand needed: it type-checks as either `WriteCorr` or `GatedCorr`. */
const LOCAL_WRITE: GatedCorr = { kind: "local" };

/**
 * How a mutation gets its transport request. `transport` absent means "no
 * manager is wired", NOT "skip the transport" — a transportable object is
 * still refused via `TRANSPORT_ERROR` (`corrForMutation`); nothing here can
 * turn a transportable write into an un-numbered one. A union rather than an
 * interface with optional fields so "manager wired, gate missing" cannot be
 * constructed — a resolved transport number must always have a gate to be
 * judged against.
 */
export type TransportOptions =
  | { transport?: undefined; gate?: undefined; corrNr?: string; affects?: EnhancedObjectRef }
  | {
      /** When present, `resolve()` runs pre-flight — before journal, lock, or any mutating request. */
      transport: SessionTransport;
      /** The gate that judges the RESOLVED transport — required whenever `transport` is. */
      gate: SafetyGate;
      /** A TRKORR the caller named. Honoured only if `ABAP_ALLOW_TRANSPORTS` permits it. */
      corrNr?: string;
      /** The object this mutation `affects`, required whenever the target is an enhancement type. See {@link EnhancedObjectRef}. */
      affects?: EnhancedObjectRef;
    };

export interface WriteResult {
  target: ResolvedTarget;
  /**
   * The object did not exist and was created by this call. Computed once
   * from `current === undefined` (step 1's fresh pre-lock GET), never
   * reassigned — answers only "did THIS call's own existence check find
   * nothing?", not the object's whole history. An object an earlier attempt
   * already created under the same name correctly reports `created: false`
   * here even to a caller expecting their first-ever write. See archive for
   * a live `DOMA/DD` report that surfaced this and why it was traced to a
   * non-virgin object, not a defect (unconfirmed hypothesis).
   */
  created: boolean;
  /** Source actually differed and was PUT. */
  changed: boolean;
  /** Content hash of the source now on the server. */
  etag: string;
  /** Content hash of what was there before, when the object already existed. */
  previousEtag?: string;
  /**
   * Switch on `.status`, not on `.required` — `required: false` covers both
   * "measured local" and "nobody asked" (D2, see `TransportInfo`). A no-op
   * write is always the latter.
   */
  transport: TransportInfo;
  /** Server-normalised source, when the server returns one (DDIC does). */
  normalisedSource?: string;
  /**
   * Where `etag` actually came from. `"post-write-read"`: a fresh GET issued
   * after the PUT — `changed` is derived from comparing this against the
   * pre-write content. `"put-response"`: the PUT's own response body treated
   * as a read-back, which it is not (a `200` only proves acceptance) — this
   * was the original, sole source and the confirmed root cause of a live
   * finding that the etag-unchanged warning could never fire (see archive).
   * Present only for properties-shape UPDATES (`DOMA/DD`, `DTEL/DE`,
   * `TTYP/DA`, `MSAG/N`, `ENQU/DL`); `undefined` elsewhere means the fix did
   * not touch that path, not that it is untrustworthy.
   */
  etagSource?: "post-write-read" | "put-response";
  /**
   * The source that was on the server before this call — the before-image the
   * journal needs. `undefined` means the object did not exist.
   *
   * It is returned rather than re-read because `writeObject` has already paid
   * for this GET during compare-before-write; making the journal read it again
   * would double the cost of every write for no new information.
   */
  previousSource?: string;
}

/**
 * What the journal is told, immediately before anything mutates. A hook
 * rather than a return value so the journal entry lands on disk BEFORE the
 * create/lock/PUT — a crash between them leaves evidence instead of silence.
 * Fires only when a mutation will actually be attempted, never for a refused
 * etag check or a byte-identical no-op.
 */
export interface BeforeImage {
  /** `undefined` means absent or unreadable — see `existed`/`sourceReadable`. A failed read never reaches here. */
  source?: string;
  /** Whether the object existed — from `ResolvedTarget.exists` (a real GET), never inferred from whether a source read produced a string. Decides restore vs delete on undo. */
  existed: boolean;
  /**
   * The current source was read successfully. Hardcoded `true` at both call
   * sites (not computed) — safe because a hook only fires on a path where the
   * read already succeeded (`readCurrentSource` throws otherwise). Fed from
   * the post-lock re-read (step 4a of `writeObject`), since pre-lock bytes
   * can be stale by the time the enqueue is held; the create's image is the
   * one exception, emitted pre-session with `source: undefined`.
   */
  sourceReadable: boolean;
  target: ResolvedTarget;
  /**
   * The transport request this mutation is about to go into. Recorded here
   * (pre-flight, before the hook fires) rather than after, so `begin()` can
   * write `corrNr` to disk BEFORE the request that puts the object in the
   * transport — avoiding a crash window where the journal never names the
   * request the object landed in. `undefined` means local, no transport.
   */
  corrNr?: string;
  /**
   * Which document `source` was read from when not the object's own source —
   * one of the four class sub-includes; `undefined` means
   * `/source/main`. Top-level (not just `target.include`) because a consumer
   * that ignores it and replays through the ordinary write path would
   * overwrite a class's body with its test classes.
   */
  include?: ClassInclude;
}

/**
 * Called after the before-image is known and before ANY mutating request. If
 * it throws, nothing is written. This module imports nothing from
 * `src/journal.ts`; `withJournalledMutation()` there is the intended hook.
 */
export type BeforeImageHook = (image: BeforeImage) => Promise<void>;

/**
 * The visible way to say "this mutation is deliberately NOT journalled".
 * `onBeforeImage` is REQUIRED on converted mutators (`deleteObject`,
 * `createPackage`, `writeEnhancementDescription`) so skipping the journal is
 * a decision visible at the call site, not a forgotten field's silent
 * default. Typed `() => Promise<void>` (not `BeforeImageHook`) so this one
 * constant satisfies every hook signature, including enhancement-write.ts's.
 */
export const NO_JOURNAL: () => Promise<void> = async () => {};

export type WriteOptions = TransportOptions & {
  source: string;
  /** Compare-before-write: reject if the current content hash differs. */
  expectEtag?: string;
  /**
   * See {@link BeforeImageHook}. REQUIRED, like `deleteObject`/`createPackage`/
   * `writeEnhancementDescription` — a real hook or {@link NO_JOURNAL}, so
   * skipping the journal can't happen by omission. `deployBridge` (run.ts)
   * and `ensureMarkerInterface` (enhancement-bridge.ts) previously went
   * un-journalled by forgetting this; both now pass `NO_JOURNAL` explicitly
   * since they write generated `$TMP` helpers, not user source.
   */
  onBeforeImage: BeforeImageHook;
};

/**
 * The object types this phase can create and write. Computed from
 * `src/adt/capabilities.ts`'s `REGISTRY` rather than hand-listed. Re-exported
 * under their original names since other modules/tests historically import
 * them from here.
 */
export {
  WRITABLE_TYPES,
  CREATE_ONLY_TYPES,
  CREATABLE_TYPES,
  ENHANCEABLE_TYPES,
  ACTIVATION_ONLY_TYPES,
  DELETABLE_TYPES,
  VERIFIED_CREATABLE_TYPES,
  capabilitiesFor,
  type TypeCapabilities,
} from "./capabilities.js";
import {
  WRITABLE_TYPES,
  CREATE_ONLY_TYPES,
  CREATABLE_TYPES,
  ENHANCEABLE_TYPES,
  ACTIVATION_ONLY_TYPES,
  DELETABLE_TYPES,
  VERIFIED_CREATABLE_TYPES,
  ABAP_WRITE_TYPES,
  writableTypesHint,
  capabilitiesFor,
  isBridgeOnlyCreateType,
  isBridgeDeletableType,
  TERMINAL_REFUSAL_NOTE,
  type WriteShape,
  type CreateCapability,
} from "./capabilities.js";
const CREATABLE = new Set<string>(CREATABLE_TYPES);
const CREATE_ONLY = new Set<string>(CREATE_ONLY_TYPES);
const ENHANCEABLE = new Set<string>(ENHANCEABLE_TYPES);
/**
 * Types with no write/create capability at all, that `resolveWriteTarget` may
 * still resolve when `op === "activate"` — an EXISTING `ENHO/XH`/`ENHS/XS`.
 * See {@link ACTIVATION_ONLY_TYPES}'s doc comment in capabilities.ts for why
 * this is additive to, not a replacement for, `CREATABLE`/`ENHANCEABLE`.
 */
const ACTIVATE_ONLY = new Set<string>(ACTIVATION_ONLY_TYPES);
/**
 * Types `resolveWriteTarget` will resolve a DELETE target for.
 * Consulted ONLY when `op === "delete"`, as an ADDITIONAL check layered on
 * top of the existing `CREATABLE`/`ENHANCEABLE`/`activatable` gate below —
 * not a replacement for it, so write/create/activate behaviour for every
 * type is completely unchanged by this. See {@link DELETABLE_TYPES}'s doc
 * comment in capabilities.ts for what a membership here is and is not
 * backed by.
 */
const DELETABLE = new Set<string>(DELETABLE_TYPES);
/** True when `type` is in the write-but-never-created set this module can resolve/write (see {@link ENHANCEABLE_TYPES}). */
export function isEnhanceableType(type: string | undefined): boolean {
  return type !== undefined && ENHANCEABLE.has(type);
}
/** True when `type` names an ABAP package. */
export function isPackageType(type: string | undefined): boolean {
  return type === "DEVC/K";
}

/**
 * Cap on `abap_write`'s `objects` (batch delete) — see that schema field's
 * doc comment in `src/tools/write.ts`. Deliberately NOT derived from
 * `MAX_ACTIVATION_BATCH` (50) — that number proved unsound (DDIC
 * mass activation fans out server-side regardless of client throttling).
 * Delete has no equivalent fan-out hazard (no batch-delete endpoint exists;
 * `abapWriteBatchDelete` just loops `deleteObject` serially), so 10 is sized
 * on blast radius instead: deletes are irreversible beyond the journal
 * window, and the real cleanup run that motivated this feature
 * (`cleanup-run-9MNEE.mjs`) split 23 objects into layers of 3–5. See archive
 * for full reasoning.
 */
export const MAX_DELETE_BATCH = 10;

/**
 * Refuses a batch that names the same object twice. Mirrors (but does not
 * import, since it is private there) `assertNoDuplicates` in
 * `src/adt/activate.ts`. Unlike a duplicate activation target (harmless), a
 * duplicate delete's second attempt hits a 404 `deleteObject` cannot
 * distinguish from a real race, reporting a confusing `BEFORE_IMAGE_UNAVAILABLE`
 * or `ETAG_CONFLICT` instead of this upfront refusal.
 */
export function assertNoDuplicateDeleteTargets(
  targets: ReadonlyArray<{ name: string; uri: string }>,
): void {
  const seen = new Map<string, string>();
  for (const t of targets) {
    const key = normaliseAdtUri(t.uri) || t.name.trim().toUpperCase();
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `\`objects\` names ${t.name} more than once — abapsmith refuses a batch delete with a ` +
          "duplicate rather than deleting it once and then failing confusingly on the repeat.",
        { name: t.name, uri: t.uri },
        "List each object once. Nothing in this batch was deleted.",
      );
    }
    seen.set(key, t.uri);
  }
}

/**
 * ADT name-length limits not in the vendor's creation table
 * (`objectcreator.js`'s `CreatableTypes`, e.g. TABL/DT = 16) — `TTYP/DA`,
 * `ENQU/DL` and `TYPE/DG` are absent there and would silently inherit the
 * generic 30 without this. `SRVB/SVB` is deliberately NOT overridden: it
 * already has a correct vendor entry (`maxLen: 26`); adding one here would
 * risk drift. `FUGR/I` IS in the vendor table, but its `maxLen: 3` describes
 * only the suffix a GUI would prompt for — abapsmith passes the full
 * `L<GROUP><suffix>` name, so it needs the override too.
 */
const NAME_LIMIT_OVERRIDES: Record<string, number> = {
  "TTYP/DA": 30, // DD40L-TYPENAME
  "ENQU/DL": 16, // DD25L-VIEWNAME, same field the classic view name uses
  "FUGR/I": 30, // full "L"+group(26)+suffix(3) name, not the vendor's 3-char suffix-only maxLen
  "TYPE/DG": 5, // TYPE-POOL naming rule (DD ABAP type-pool names are 5 characters)
};

function maxNameLength(type: string): number {
  return (
    NAME_LIMIT_OVERRIDES[type] ?? CreatableTypes.get(type as CreatableTypeIds)?.maxLen ?? 30
  );
}

// ---------------------------------------------------------------------------
// Write shape (src/adt/capabilities.ts `WriteShape`) — two ways to put
// content into an ADT object, confined to the four functions below.
// `writeObject`'s choreography (compare-before-write, transport pre-flight,
// journal before-image, create/lock/re-read/PUT/unlock, rollback) is one
// body of code shared by both, deliberately, so safety properties aren't
// re-proved (and silently drift) on a forked copy.
//
//   "source"     — PUT {uri}/source/main, text/plain, ABAP source.
//                  PROG/P, CLAS/OC, INTF/OI, TABL/DT, TABL/DS, DDLS/DF,
//                  FUGR/FF, ENHO/XHH.
//   "properties" — PUT {uri} (object's own URI), application/*, complete
//                  XML descriptor. DOMA/DD, DTEL/DE, TTYP/DA, MSAG/N,
//                  ENQU/DL — all 404 on /source/main, so this is the only door.
//
// `WriteOptions.source` also carries the properties-shape XML — one field,
// not two, since downstream handling (etag, sourceEquals, journal, undo) is
// content-agnostic text handling either way.

/** `"source"` unless the registry says otherwise. Types with no `write` entry never reach a write. */
function writeShapeOf(type: string): WriteShape {
  return capabilitiesFor(type)?.write?.shape ?? "source";
}

/**
 * The URI this type's CONTENT lives at (GET before write, PUT under lock) —
 * NOT `t.uri` in general, since for the source shape content is a
 * sub-resource. Exported for `src/adt/undo.ts`'s `probe()`, which needs the
 * same resolution rather than a second one that could quietly disagree.
 */
export function contentUri(t: ResolvedTarget): string {
  return usesObjectUriForContent(t.type) ? t.uri : t.sourceUri;
}

/**
 * The class SUB-include this target addresses, or `undefined`.
 * `"main"` also answers `undefined` (it IS the object's own `/source/main`),
 * which keeps `ResolvedTarget.include` free to stay tri-valued: absent ≠
 * `"main"`, so a consumer can tell "caller said nothing" from "caller asked
 * for the main body".
 */
function subInclude(t: { include?: ClassInclude }): ClassInclude | undefined {
  return t.include !== undefined && t.include !== "main" ? t.include : undefined;
}

/**
 * How to NAME the thing this mutation acts on, in a sentence a human reads.
 * A 404 on `…/includes/testclasses` means the include is absent, not that
 * the class is misnamed — an ETAG_CONFLICT on it is a conflict on the test
 * classes, not the class body, so the message must say which. Matches how
 * `src/adt/source.ts` (the read path) already words its refusals.
 */
function targetLabel(t: { spec: { label: string }; name: string; include?: ClassInclude }): string {
  const inc = subInclude(t);
  return inc ? `the ${inc} include of ${t.spec.label} ${t.name}` : `${t.spec.label} ${t.name}`;
}

/**
 * The one place the write path decides WHAT it takes an enqueue on. The PUT
 * goes to `contentUri(t)` (for an include write, `…/includes/testclasses`)
 * while the lock is taken here — different URIs, spelled as a
 * function so changing the choice is one line, not six call sites.
 *
 * Implemented: (a) the class-level enqueue on `/oo/classes/{name}` is shared
 * and authorises PUTs to all five source resources. The alternative, (b) a
 * per-include enqueue on `…/includes/<x>`, is a real option too — LIVE
 * 2026-08-18 (A4H) testing confirmed both the include is independently
 * lockable AND the class-level lock covers it end to end (create/lock/PUT).
 * (a) is kept because it serialises concurrent writers to different
 * includes of the same class pool (they'd otherwise both activate the same
 * pool invisibly to each other), matches `deleteObject`'s "deleting a class
 * takes its includes with it", and matches `abap-adt-api`'s own
 * `createTestInclude`, which takes the class's lock handle. Do not take a
 * second lock alongside the first, whichever way this goes — two enqueues
 * held across one PUT is how a failed unlock leaves a class half-locked in
 * SM12. See archive for the full live-run notes and what switching to (b)
 * would require (a lock-ledger key change in `session.ts`, not just this
 * function).
 *
 * `rollbackCreate` deliberately does NOT use this — it locks to DELETE the
 * object it just created, so it always wants the object URI.
 */
function lockUri(t: ResolvedTarget): string {
  return t.uri;
}

/**
 * Does this type's content live at the object URI itself (no `/source/main`
 * sub-resource)? Split out from `contentUri` because `preflightCorr` (which
 * has only the narrower `PreflightTarget`) needs the same question answered
 * — handing CTS a URI that doesn't resolve fails the write outright.
 */
function usesObjectUriForContent(type: string): boolean {
  return isPackageType(type) || writeShapeOf(type) === "properties";
}

/**
 * What to ask for when reading content, per shape. `application/*` is what
 * every properties-shape type except `SRVB/SVB` was verified live with;
 * `SRVB/SVB` sets an explicit `mediaType` because the wildcard was never
 * tested against its endpoint and a different generic Accept is documented
 * to 406 there — see the PROVENANCE WARNING on its REGISTRY entry in
 * `src/adt/capabilities.ts`. Exported alongside `contentUri` for
 * `src/adt/undo.ts`'s `probe()`.
 */
export function contentAccept(t: ResolvedTarget): string {
  if (writeShapeOf(t.type) !== "properties") return "text/plain";
  return capabilitiesFor(t.type)?.mediaType ?? "application/*";
}

/**
 * What to send when writing content, per shape. `application/*` (not a
 * versioned media type) is what all five original properties-shape types
 * were verified live with, and what `abap-adt-api` sends unconditionally.
 * `SRVB/SVB` is the one exception — see `contentAccept`.
 */
function contentType(t: ResolvedTarget): string {
  if (writeShapeOf(t.type) !== "properties") return "text/plain; charset=utf-8";
  return capabilitiesFor(t.type)?.mediaType ?? "application/*";
}

const XML_NAME_ATTR_RE = /(?:^|\s)adtcore:name\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
/** Root element only — `adtcore:name` also appears on nested `<adtcore:packageRef>`, which a whole-document search would wrongly match. */
const XML_ROOT_ELEMENT_RE = /<[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?[^>]*>/;

/**
 * A properties-shape write's BODY is the object's identity, not just its
 * content — the safety gate judged `t.name` in `t.packageName`, and a body
 * naming something else would send a gated call at an ungated object. Not
 * hypothetical for create: the body is POSTed to a collection and the name
 * in it decides what gets created. Checked on both the create POST and the
 * PUT. Deliberately narrow — only the two facts the gate judged; everything
 * else the server rejects on its own.
 */
function assertPayloadMatchesTarget(t: ResolvedTarget, xml: string): void {
  const stripped = xml.replace(XML_COMMENT_RE, "");
  const root = XML_ROOT_ELEMENT_RE.exec(stripped)?.[0] ?? "";
  const declared = XML_NAME_ATTR_RE.exec(root)
    ?.slice(1)
    .find((v) => v !== undefined);
  if (declared === undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `The XML for ${t.spec.label} ${t.name} carries no adtcore:name attribute.`,
      { name: t.name, type: t.type, uri: t.uri },
      "A properties-shape write sends the object's complete XML descriptor. Its root " +
        `element must carry adtcore:name="${t.name}" — abapsmith will not write a document ` +
        "whose identity it cannot verify against the object the safety gate approved.",
    );
  }
  if (declared.trim().toUpperCase() !== t.name) {
    throw new AbapError(
      "BAD_INPUT",
      `The XML names ${declared.trim().toUpperCase()}, but this write targets ${t.name}.`,
      { name: t.name, type: t.type, uri: t.uri, declaredName: declared.trim().toUpperCase() },
      "The safety gate approved a specific object; the payload must be that object. " +
        "Nothing was written.",
    );
  }
  const declaredPackage = parsePackageRef(stripped);
  if (declaredPackage !== undefined && declaredPackage.toUpperCase() !== t.packageName) {
    throw new AbapError(
      "BAD_INPUT",
      `The XML puts ${t.name} in package ${declaredPackage.toUpperCase()}, but this write ` +
        `targets package ${t.packageName}.`,
      {
        name: t.name,
        type: t.type,
        uri: t.uri,
        declaredPackage: declaredPackage.toUpperCase(),
        packageName: t.packageName,
      },
      "The package allowlist judged the target package. Change the " +
        "<adtcore:packageRef adtcore:name=…> in the payload to match, or write to the " +
        "package the payload names. Nothing was written.",
    );
  }
}

const DOMA_TEXT_RE = /<doma:text\b[^>]*>([\s\S]*?)<\/doma:text>/gi;
const MASTER_LANGUAGE_ATTR_RE = /(?:^|\s)adtcore:masterLanguage\s*=\s*(?:"[^"]*"|'[^']*')/i;

/**
 * A `DOMA/DD` payload whose root element omits `adtcore:masterLanguage`
 * silently drops every `<doma:fixedValue><doma:text>` description on write —
 * the write reports `activated: true`, no message, no error, and only the
 * fixed-value CODES survive. Live-verified 7/7 on A4H `$TMP` (controlled
 * probes plus six unrelated pre-existing objects); adding the attribute and
 * re-writing repairs an already-damaged domain in place. Refused before
 * sending, not merely warned — a write that reports success while quietly
 * discarding data is worse than an upfront rejection the caller can fix by
 * adding one attribute. Checked at all three properties-shape enforcement
 * points alongside `assertPayloadMatchesTarget`: the early pre-flight before
 * any request, `createByXml`'s POST, and `putContent`'s PUT.
 *
 * Deliberately narrow: only `DOMA/DD`, and only payloads that actually carry
 * non-empty `<doma:text>` content — a domain with no fixed-value text, or one
 * that already carries the attribute, has nothing to lose here.
 *
 * NOT to be confused with the `language` attribute on the `<doma:text>`
 * CHILD element — a different attribute on a different element.
 * `src/adt/ddic.ts`'s "the write guard" section (~line 449) records that a
 * pre-send lint on THAT attribute was tried and removed after live
 * verification showed a compliant payload failing identically to a
 * non-compliant one. That finding stands; it does not apply here.
 *
 * Exported so `test/ddic-write-guard.test.ts` can unit-test the condition
 * directly against XML fixtures, the same way `assertPayloadMatchesTarget`'s
 * sibling checks are exercised through the write flow elsewhere.
 */
export function assertDomaMasterLanguage(t: ResolvedTarget, xml: string): void {
  if (t.type !== "DOMA/DD") return;
  const stripped = xml.replace(XML_COMMENT_RE, "");
  DOMA_TEXT_RE.lastIndex = 0;
  let hasText = false;
  let m: RegExpExecArray | null;
  while ((m = DOMA_TEXT_RE.exec(stripped)) !== null) {
    if ((m[1] ?? "").trim() !== "") {
      hasText = true;
      break;
    }
  }
  if (!hasText) return;
  const root = XML_ROOT_ELEMENT_RE.exec(stripped)?.[0] ?? "";
  if (MASTER_LANGUAGE_ATTR_RE.test(root)) return;
  throw new AbapError(
    "BAD_INPUT",
    `The XML for ${t.spec.label} ${t.name} carries fixed-value <doma:text> content but its ` +
      "root element has no adtcore:masterLanguage attribute.",
    { name: t.name, type: t.type, uri: t.uri },
    'Add adtcore:masterLanguage="EN" to the root element and re-send. Without it, ADT ' +
      "accepts the write and reports activated: true while silently discarding every " +
      "<doma:fixedValue><doma:text> description — the fixed-value codes survive, only the " +
      "text vanishes. Re-writing an already-damaged domain with the attribute present " +
      "repairs it in place.",
  );
}

const VALUE_INFORMATION_OPEN_RE = /<((?:[A-Za-z_][\w.-]*:)?)valueInformation\b([^>]*)>/gi;
const VALUE_INFORMATION_CLOSE_RE = /<\/(?:[A-Za-z_][\w.-]*:)?valueInformation\s*>/gi;
const FIX_VALUES_OPEN_RE = /<(?:[A-Za-z_][\w.-]*:)?fixValues\b/gi;

/**
 * Writing a `DOMA/DD` whose `<doma:valueInformation>` omits
 * `<doma:fixValues>` is rejected by the ABAP system even when the domain has
 * NO fixed values at all — an empty self-closing `<doma:fixValues/>` is
 * mandatory regardless. Live-confirmed across 12 domains in one session: all
 * 11 with no fixed values needed the element added before the write would
 * take; the empty domain the probing write had created was deleted again by
 * the server, so nothing was left behind. The server's own rejection is
 * unambiguous about WHERE the element belongs:
 *
 *   System expected the element '{http://www.sap.com/dictionary/domain}fixValues'
 *   (doma:domain(1)doma:content(2)doma:valueInformation(3) @ 840)
 *
 * — the validator had already consumed every child present and hit the close
 * of `valueInformation` still expecting `fixValues`, so `fixValues` belongs
 * as the LAST child of `valueInformation` (after `valueTableRef` /
 * `appendExists` when either is present). That is where this injects.
 *
 * Comments are masked before detection — replaced with an equal-length run
 * of spaces via `XML_COMMENT_RE`, so offsets into the ORIGINAL string stay
 * valid and every comment survives verbatim in the returned document —
 * because a `<doma:fixValues/>` sitting only inside a comment must not count
 * as present, and a commented-out `<doma:valueInformation>` must not count as
 * the element to inject into.
 *
 * Fails OPEN (returns `xml` unchanged) whenever the document is ambiguous:
 * zero or more than one `valueInformation` element anywhere in the document,
 * or no matching close tag found for the paired form. The point is not to
 * guess at a shape this function doesn't understand — an odd document is
 * better left to the server's own (good) rejection than "fixed" wrong by a
 * guess at where to inject. Namespace-prefix-agnostic throughout (reuses this
 * file's `(?:[A-Za-z_][\w.-]*:)?` idiom), and the injected `fixValues`
 * element reuses whatever prefix the `valueInformation` open tag carried.
 *
 * Idempotent: a document that already carries a `fixValues` child (checked
 * with a trailing `\b` so the singular `<doma:fixValue>` sibling element
 * doesn't fool it) comes back byte-identical, which is what makes it safe to
 * call at all three write chokepoints (`writeObject`, `createByXml`,
 * `putContent`) on the same payload as it travels through them — only the
 * first application does anything.
 *
 * Exported so `test/ddic-write-guard.test.ts` can unit-test it directly
 * against XML fixtures, the same way `assertDomaMasterLanguage` is exported
 * for its own guard tests.
 */
export function injectEmptyFixValues(t: ResolvedTarget, xml: string): string {
  if (t.type !== "DOMA/DD") return xml;

  const masked = xml.replace(XML_COMMENT_RE, (m) => " ".repeat(m.length));

  VALUE_INFORMATION_OPEN_RE.lastIndex = 0;
  const opens: RegExpExecArray[] = [];
  for (let m = VALUE_INFORMATION_OPEN_RE.exec(masked); m; m = VALUE_INFORMATION_OPEN_RE.exec(masked)) {
    opens.push(m);
  }
  const open = opens[0];
  if (opens.length !== 1 || !open) return xml;

  const [full, prefix, attrs] = open;
  const openStart = open.index;
  const openEnd = openStart + full.length;

  // Self-closing `<pfx:valueInformation …/>`: the captured attrs text always
  // ends with the `/` that made it self-closing (optionally followed by
  // whitespace, since that's still before the `>` our outer match stops at).
  const selfClose = /\/(\s*)$/.exec(attrs ?? "");
  if (selfClose) {
    const openAttrs = (attrs ?? "").slice(0, selfClose.index) + selfClose[1];
    const replacement =
      `<${prefix}valueInformation${openAttrs}>` +
      `<${prefix}fixValues/>` +
      `</${prefix}valueInformation>`;
    return xml.slice(0, openStart) + replacement + xml.slice(openEnd);
  }

  VALUE_INFORMATION_CLOSE_RE.lastIndex = openEnd;
  const close = VALUE_INFORMATION_CLOSE_RE.exec(masked);
  if (!close) return xml;
  const closeStart = close.index;

  FIX_VALUES_OPEN_RE.lastIndex = 0;
  if (FIX_VALUES_OPEN_RE.test(masked.slice(openEnd, closeStart))) return xml;

  return xml.slice(0, closeStart) + `<${prefix}fixValues/>` + xml.slice(closeStart);
}

const FUGR_INCLUDE_STATEMENT_RE = /\bINCLUDE\s+([A-Za-z0-9_/]+)/gi;
const FUGR_IMPLEMENTATION_INCLUDE_RE = /(?:UXX|U\d+)$/;

function stripAbapEolComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'") inString = !inString;
    else if (ch === '"' && !inString) return line.slice(0, i);
  }
  return line;
}

/**
 * A FUGR/F's `/source/main` is not ABAP code — it is the function
 * group's include list. SE37 generates two lines, `INCLUDE L<GROUP>TOP.`
 * then `INCLUDE L<GROUP>UXX.`; the second is the SAP-generated include that
 * pulls in the function module implementation includes (`L<GROUP>U01`,
 * `U02`, …). A caller who sends only the TOP line gets a group that writes,
 * activates, and reads back active — every abapsmith signal reports success
 * — while none of its function module bodies are in the compiled unit, so
 * every CALL FUNCTION against it dumps CX_SY_DYN_CALL_ILLEGAL_FUNC /
 * CALL_FUNCTION_NOT_ACTIVE. Reproduced in `$TMP`, no transport involved.
 *
 * Refused, not repaired: every byte of a FUGR/F main source is
 * caller-authored, and abapsmith silently inserting a line the caller didn't
 * write would be its own defect. A group that lists its implementation
 * includes individually (`U01`, `U02`, … with no `UXX`) is a legitimate
 * shape and passes untouched.
 *
 * Exported so `test/fugr-include-list.test.ts` can unit-test the condition
 * directly against source fixtures, the same way `assertDomaMasterLanguage`
 * is exported for its own guard tests.
 */
export function assertFunctionGroupImplementationInclude(t: ResolvedTarget, source: string): void {
  if (t.type !== "FUGR/F") return;

  const names: string[] = [];
  for (const rawLine of source.split("\n")) {
    if (rawLine.trimStart().startsWith("*")) continue;
    const code = stripAbapEolComment(rawLine);
    FUGR_INCLUDE_STATEMENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FUGR_INCLUDE_STATEMENT_RE.exec(code)) !== null) {
      names.push(m[1]!.toUpperCase());
    }
  }

  const top = names.find((n) => n.endsWith("TOP"));
  if (!top) return;
  if (names.some((n) => FUGR_IMPLEMENTATION_INCLUDE_RE.test(n))) return;

  const missing = `${top.slice(0, -3)}UXX`;
  throw new AbapError(
    "BAD_INPUT",
    `The main source of ${t.spec.label} ${t.name} names its ${top} include but no ` +
      "implementation include, so no function module body would be part of the compiled unit.",
    { name: t.name, type: t.type, uri: t.uri, topInclude: top, missingInclude: missing },
    `Add \`INCLUDE ${missing}.\` after \`INCLUDE ${top}.\` and re-send. ${missing} is the ` +
      "SAP-generated include that pulls in the function module implementation includes " +
      `(${top.slice(0, -3)}U01, U02, …). Without it the group writes, activates and reads ` +
      "back as active while every CALL FUNCTION against its modules dumps " +
      "CX_SY_DYN_CALL_ILLEGAL_FUNC / CALL_FUNCTION_NOT_ACTIVE. A group that lists its " +
      "implementation includes individually instead is accepted as-is. Nothing was written.",
  );
}

/**
 * `adtcore:masterSystem="SAP"` / `"A4H"` — a SID-valued root-element attribute,
 * generic to ADT object metadata (not enhancement-specific); verified live on
 * both plain writable types and enhancement objects (ENHS/XS, ENHO/XHH).
 * Same ambiguity-safe collect-and-agree shape as `parsePackageRef` (feeds the
 * safety gate's origin ceiling), though no capture reviewed has shown it
 * legitimately repeating with different values.
 */
const MASTER_SYSTEM_ATTR_RE =
  /(?:^|\s)(?:[A-Za-z_][\w.-]*:)?masterSystem\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function parseMasterSystem(xml: string): string | undefined {
  const doc = xml.replace(XML_COMMENT_RE, "");
  let first: string | undefined;
  const seen = new Set<string>();
  MASTER_SYSTEM_ATTR_RE.lastIndex = 0;
  for (let m = MASTER_SYSTEM_ATTR_RE.exec(doc); m; m = MASTER_SYSTEM_ATTR_RE.exec(doc)) {
    const value = (m[1] ?? m[2] ?? "").trim();
    if (!value) continue;
    seen.add(value.toUpperCase());
    first ??= value;
  }
  return seen.size === 1 ? first?.toUpperCase() : undefined;
}

/**
 * `adtcore:version` — the same GET's free evidence of whether the ACTIVE
 * version is current. Unlike `parsePackageRef`/`parseMasterSystem`,
 * agreement is not "one distinct value": a class document carries one
 * `adtcore:version` per include PLUS one on the root, and they legitimately
 * disagree (live fixture 062: root + `main` include `"inactive"`,
 * `definitions`/`implementations`/`macros` `"active"`). Reuses
 * `activationFromVersion` (resolve.ts) so "never guessed into
 * active-is-current" has one implementation, not two.
 */
const ADTCORE_VERSION_ATTR_RE = /(?:^|\s)adtcore:version\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

export function activationFromBody(xml: string): ActivationState {
  const doc = xml.replace(XML_COMMENT_RE, "");
  ADTCORE_VERSION_ATTR_RE.lastIndex = 0;
  let found = false;
  for (let m = ADTCORE_VERSION_ATTR_RE.exec(doc); m; m = ADTCORE_VERSION_ATTR_RE.exec(doc)) {
    found = true;
    if (activationFromVersion(m[1] ?? m[2] ?? "") !== "active-is-current") return "unknown";
  }
  return found ? "active-is-current" : "unknown";
}

/**
 * We do not know which package this object is in, so we refuse to touch it —
 * the package allowlist is the server's central safety rule, and a rule
 * evaluated against a guessed `$TMP` default would let an object in ZLOCAL
 * sail through it.
 */
// TODO(errors.ts): a dedicated PACKAGE_UNKNOWN code belongs in AbapErrorCode; SAFETY_DENIED + details.reason is the closest available today.
function packageUnknown(
  t: Pick<ResolvedTarget, "name" | "type" | "uri" | "spec">,
  cause: string,
): AbapError {
  return new AbapError(
    "SAFETY_DENIED",
    `abapsmith could not determine which package ${t.spec.label} ${t.name} belongs to, ` +
      `so it refuses the operation (${cause}).`,
    { reason: "PACKAGE_UNKNOWN", name: t.name, type: t.type, uri: t.uri, cause },
    "Every write, delete and activation is judged against the object's real package. " +
      "Rather than assume $TMP — which would let an allowlist of " +
      "$TMP approve an object in any package at all — abapsmith stops here. Check that " +
      "the connection is healthy and that this user may read the object, then retry.",
    { retryable: true }, // a failure to determine the package, not a policy verdict — a healthy connection resolves it
  );
}

/**
 * The package of a container-parented object, read from the CONTAINER. A
 * function module's own ADT metadata carries no `<adtcore:packageRef>` —
 * caught live, an existing FM's GET returned no package element, so every
 * write/delete of an existing FM was wrongly refused `PACKAGE_UNKNOWN` (the
 * create path never noticed, since a 404 lets the caller's own `package`
 * argument stand in). This reads the group's own `<adtcore:packageRef>`
 * instead — the server's authoritative answer, not a guess. Returns
 * `undefined` (never throws) so `packageUnknown`'s refusal stays the single
 * failure path.
 */
async function containerPackage(
  conn: AbapConnection,
  spec: TypeSpec,
  containerName: string | undefined,
): Promise<string | undefined> {
  if (!spec.parentPath || !containerName) return undefined;
  const uri = spec.parentPath.replace("{parent}", encodeURIComponent(containerName.toLowerCase()));
  try {
    const resp = await conn.get(uri, { headers: { Accept: "application/*" } });
    return parsePackageRef(resp.body ?? "");
  } catch {
    return undefined;
  }
}

/**
 * Resolve a write target without requiring the object to exist.
 *
 * Two phases, in this order and for a reason:
 *
 * Two phases: (1) offline validation (member refusal, unknown/unwritable
 * type, name shape/length) throws before any byte goes on the wire; (2) one
 * live GET of the object URI (not `/source/main`) with `Accept:
 * application/*`, which answers existence and package together from
 * `<adtcore:packageRef>` — verified live for all four writable types. The
 * lock response cannot substitute: it carries IS_LOCAL/CORRNR/CORRUSER but
 * never DEVCLASS, and arrives too late (the gate must decide before anything
 * is enqueued).
 */
export async function resolveWriteTarget(
  conn: AbapConnection,
  target: WriteTarget,
  // "activate" additionally admits ACTIVATE_ONLY types below; other callers
  // keep today's write/delete behaviour unchanged by omitting this.
  op: "write" | "delete" | "activate" = "write",
): Promise<ResolvedTarget> {
  // `target.type` is a hint for disambiguating e.g. "ZGRP/ZFM"; an explicit
  // type inside target.name still wins over it.
  const explicit = target.type
    ? (specForType(target.type) ?? specForKeyword(target.type))
    : undefined;
  const parsed = parseObjectRef(target.name, explicit);

  if (parsed.member) {
    throw new AbapError(
      "BAD_INPUT",
      `Cannot write a single member (${parsed.member}) — writes replace a whole object's source.`,
      { name: target.name, member: parsed.member },
      "Read the object, edit the text, and write the complete source back.",
    );
  }

  // Explicit-type refusal, before the types.ts lookup below: SHLP/DH,
  // VIEW/DV, TRAN/T, PROG/PS, PROG/PC, PROG/PT, SUSO/B aren't in types.ts's
  // TYPES array, so without this they'd fall into a generic "Unknown object
  // type" instead of their specific, actionable refusal.
  if (target.type) {
    const unsupportedCap = capabilitiesFor(target.type);
    if (unsupportedCap?.unsupported) {
      throw new AbapError(
        "UNSUPPORTED",
        `${unsupportedCap.label} (${target.type.trim().toUpperCase()}) cannot be written by ` +
          `abapsmith. ${unsupportedCap.unsupported.reason} ${TERMINAL_REFUSAL_NOTE}`,
        { type: target.type.trim().toUpperCase(), name: parsed.name },
        unsupportedCap.unsupported.alternative,
        { retryable: false }, // matches UNSUPPORTED's own default; reaffirmed for readability at the throw site
      );
    }
    // bridgeCreate types (VIEW/DV, TRAN/T) are creatable, but not by
    // RESOLVING — ADT has no writable collection for them. abapWrite routes
    // them to the classrun bridge before reaching here; a direct caller
    // still gets UNSUPPORTED, but with the working route named.
    //
    // DEVC/K also declares bridgeCreate but is excluded — its writable
    // collection handles LOCAL create; TRANSPORTABLE create is routed by
    // src/tools/write.ts's isPackageType branch instead. Mirrors resolve.ts.
    if (unsupportedCap?.bridgeCreate && isBridgeOnlyCreateType(target.type)) {
      const code = target.type.trim().toUpperCase();
      throw new AbapError(
        "UNSUPPORTED",
        `${unsupportedCap.label} (${code}) has no writable ADT collection to resolve a URI ` +
          `against, so it cannot be written as source. ${unsupportedCap.bridgeCreate.adtRest} ` +
          TERMINAL_REFUSAL_NOTE,
        { type: code, name: parsed.name },
        // Routing a caller to the bridge create is only honest while the
        // bridge create is actually attempted — `createRefused` says it isn't.
        `abapsmith implements no update route for this type — the bridge is create and delete ` +
          `only. ` +
          (unsupportedCap.bridgeCreate.createRefused ??
            `To create a NEW ${unsupportedCap.label}, call abap_write with type="${code}" and ` +
              `no \`source\` (there is no mode=create — abap_write's mode is write/delete, and a ` +
              `create is a write to a name that does not exist yet). ` +
              unsupportedCap.bridgeCreate.limits),
        { retryable: false }, // matches UNSUPPORTED's own default; reaffirmed for readability at the throw site
      );
    }
  }

  if (target.type && !explicit) {
    throw new AbapError(
      "BAD_INPUT",
      `Unknown object type ${JSON.stringify(target.type)}.`,
      { type: target.type, writable: [...ABAP_WRITE_TYPES] },
      writableTypesHint(),
    );
  }

  // ARCH-09 §5.2: ask the server for the type rather than refuse outright —
  // a type it reports for an existing name is a fact, not a guess, and can
  // only make this an EDIT. Creates still refuse: nothing found, nothing to report.
  const offlineSpec = explicit ?? parsed.spec;
  const identified = offlineSpec ? [] : await identifyByName(conn, parsed.name);
  const spec = offlineSpec ?? (identified.length === 1 ? identified[0] : undefined);
  const specSource: "caller" | "server" = offlineSpec ? "caller" : "server";
  if (!spec) {
    throw new AbapError(
      "BAD_INPUT",
      identified.length > 1
        ? `${parsed.name} exists as ${identified.length} different object types.`
        : `Cannot tell what kind of object ${parsed.name} is, and no object of that name exists.`,
      {
        name: parsed.name,
        writable: [...ABAP_WRITE_TYPES],
        ...(identified.length > 1 ? { candidates: identified.map((s) => s.type) } : {}),
      },
      'Pass an explicit type, e.g. {"type": "PROG/P"} or {"type": "class"}. ' +
        "A write must never guess: creating the wrong object type is not undoable in one step.",
    );
  }

  const activatable = op === "activate" && ACTIVATE_ONLY.has(spec.type);
  if (!CREATABLE.has(spec.type) && !ENHANCEABLE.has(spec.type) && !activatable) {
    throw new AbapError(
      "UNSUPPORTED",
      `${spec.label} (${spec.type}) cannot be written by abapsmith. ${TERMINAL_REFUSAL_NOTE}`,
      { type: spec.type, writable: [...ABAP_WRITE_TYPES] },
      writableTypesHint(),
      { retryable: false }, // matches UNSUPPORTED's own default; reaffirmed for readability at the throw site
    );
  }

  // Before this, `delete` could pass the writability gate above
  // and still reach a real DELETE even when capabilities.ts never claimed
  // `delete: true`. This is the one choke point both `deleteObject` and the
  // batch-delete path (via `authorizeMutation`) resolve through.
  // `DELETABLE_TYPES` answers "REST DELETE exists"; a `bridgeDelete` type has
  // no REST route but is still deletable, via the classrun bridge.
  if (op === "delete" && !DELETABLE.has(spec.type) && !isBridgeDeletableType(spec.type)) {
    throw new AbapError(
      "UNSUPPORTED",
      `${spec.label} (${spec.type}) cannot be deleted by abapsmith. ${TERMINAL_REFUSAL_NOTE}`,
      { type: spec.type, deletable: [...DELETABLE_TYPES] },
      `Deletable types are ${DELETABLE_TYPES.join(", ")}. See that type's REGISTRY entry in ` +
        `src/adt/capabilities.ts for why delete is refused here — either it has never been tried ` +
        `live, or it was tried and did not reliably work.`,
      { retryable: false }, // matches UNSUPPORTED's own default; reaffirmed for readability at the throw site
    );
  }

  const name = parsed.name.toUpperCase();
  if (!isAddressableAbapObjectName(name)) {
    throw new AbapError("BAD_INPUT", `${JSON.stringify(target.name)} is not a valid ABAP object name.`, {
      name: target.name,
    });
  }
  // A4H refuses this at create with 403 / "Do not use underscores in type
  // group names" (2026-09-04) — checked here, before the length check, so
  // the more actionable rule wins when a name breaks both.
  if (spec.type === "TYPE/DG" && name.includes("_")) {
    throw new AbapError(
      "BAD_INPUT",
      `${name} contains an underscore — type group names cannot.`,
      { name, type: spec.type },
      "Use only letters and digits, max 5 characters, e.g. ZTMDX.",
    );
  }
  const limit = maxNameLength(spec.type);
  if (name.length > limit) {
    throw new AbapError(
      "BAD_INPUT",
      `${name} is ${name.length} characters — ${spec.label} names are limited to ${limit}.`,
      { name, type: spec.type, maxLength: limit },
      spec.type === "TABL/DT"
        ? "DDIC table names max out at 16 characters."
        : undefined,
    );
  }

  // Container-parented types (TypeSpec.parentPath): a function module's URI
  // needs a {parent} segment naming its group, or it resolves to nothing.
  // Explicit argument wins over the one parsed from the name.
  const containerName = target.containerName?.trim().toUpperCase() || parsed.parent;
  if (spec.parentPath && !containerName) {
    throw new AbapError(
      "BAD_INPUT",
      `${spec.label} ${parsed.name} lives inside a container object, and none was named.`,
      { name: parsed.name, type: spec.type },
      `Name the container, e.g. "ZMY_GROUP/${parsed.name}", "${parsed.name} in ZMY_GROUP", ` +
        "or pass it explicitly. Its URI cannot be built without one.",
    );
  }
  if (containerName && !isAddressableAbapObjectName(containerName)) {
    throw new AbapError(
      "BAD_INPUT",
      `${JSON.stringify(containerName)} is not a valid ABAP object name, so it cannot be ${spec.label} ${name}'s container.`,
      { containerName, name, type: spec.type },
      "The container name goes straight into the object's URI, so a malformed one would " +
        "address a different object instead of failing.",
    );
  }
  const uri = buildUri(spec, name, containerName);

  // Class includes: sourceUri used to be hardcoded to /source/main,
  // making CCDEF/CCIMP/CCMAC/CCAU (ABAP Unit test classes) unwritable. An
  // include named on a non-class type is REFUSED, never silently dropped to
  // the main source — that would be silent data loss.
  const include = target.include ? assertClassInclude(target.include, uri) : undefined;
  if (include && spec.type !== "CLAS/OC") {
    throw new AbapError(
      "BAD_INPUT",
      `include="${include}" was named, but only a global class (CLAS/OC) has includes — ` +
        `${spec.label} ${name} does not.`,
      { name, type: spec.type, include, supported: [...CLASS_INCLUDES] },
      "Drop `include`. The write was NOT silently redirected to this object's main source.",
    );
  }

  const base = {
    spec,
    type: spec.type,
    name,
    uri,
    sourceUri: include ? classIncludeUri(uri, include) : `${uri}/source/main`,
    description: target.description?.trim() || `${spec.label} ${name}`,
    // Overwritten below once `body` exists; a create has no document to read
    // this off (see `ResolvedTarget.activation`).
    activation: "unknown" as ActivationState,
    ...(containerName ? { containerName } : {}),
    ...(include ? { include } : {}),
  };
  const requestedPackage = target.packageName?.trim().toUpperCase();

  // The one live request. Nothing below this line may guess. `Accept` is
  // per-type (mirrors contentAccept/contentType) since SRVB/SVB 406s a
  // generic Accept — see PROVENANCE WARNING on its REGISTRY entry.
  let body: string;
  try {
    const resp = await conn.get(uri, {
      headers: { Accept: capabilitiesFor(spec.type)?.mediaType ?? "application/*" },
    });
    body = resp.body ?? "";
  } catch (e) {
    // Branch order is load-bearing.
    // 1. Not-found (ExceptionResourceNotFound) must be tested first — a 404
    //    is a definite "this is a create" and arrives already structured
    //    (translateAdtError -> NOT_FOUND); re-throwing structured errors
    //    ahead of this would abort every create instead of creating it.
    if (isNotFoundError(e)) {
      if (specSource === "server") {
        // The search index said this object exists but the authoritative
        // read disagrees — a create is not the safe reading of that
        // contradiction, since the caller never named a type.
        throw new AbapError(
          "NOT_FOUND",
          `${parsed.name} was reported as a ${spec.label} but reading it found nothing.`,
          { name, type: spec.type, uri, typeSource: "repository-search" },
          `Pass an explicit type, e.g. {"type": "${spec.type}"}, to create it.`,
        );
      }
      if (CREATE_ONLY.has(spec.type)) {
        // A package IS its own package (adtcore:packageRef = itself), so the
        // caller's `package` here is the SUPERpackage, a separate hierarchy
        // field — must not be fed to the gate as the landing package.
        return {
          ...base,
          exists: false,
          packageName: base.name,
          packageSource: "server",
          ...(requestedPackage ? { superPackage: requestedPackage } : {}),
        };
      }
      // A create: no server-side package to read, so $TMP stays the default
      // only here, where the object genuinely has none yet.
      return {
        ...base,
        exists: false,
        packageName: requestedPackage || "$TMP",
        packageSource: "requested",
      };
    }
    // 2. Anything that already knows what it is keeps its own identity (same
    //    idiom as `checkSource` in activate.ts) rather than being re-badged
    //    as SAFETY_DENIED / PACKAGE_UNKNOWN.
    if (isAbapError(e)) throw e;
    // 3. Timeout/socket-reset/500/unrecognised throw: the package could not
    //    be determined, but this may also mean the SESSION died on an
    //    earlier request and this GET never reached the object at all
    //    (isAbapError above only catches already-translated errors; a raw
    //    library throw like "400 Session Timed Out" lands here). This used to
    //    always report PACKAGE_UNKNOWN, which reads as a
    //    deliberate policy refusal about the object when it's really a dead
    //    connection. Ask `translateAdtError` first — only its generic
    //    ADT_ERROR catch-all is ambiguous enough to still become
    //    `packageUnknown`; anything it recognises (SESSION_DEAD above all)
    //    is reported as that, with the real cause named.
    const translated = translateAdtError(e, { operation: "read", uri, name: base.name, type: base.type });
    if (translated.code !== "ADT_ERROR") throw translated;
    throw packageUnknown(base, describeUnknownError(e));
  }

  const serverPackage =
    parsePackageRef(body) ?? (await containerPackage(conn, spec, containerName));
  if (!serverPackage && !CREATE_ONLY.has(spec.type)) {
    // Every writable type either carries adtcore:packageRef itself or
    // inherits one from its container — reaching here is a genuine anomaly.
    throw packageUnknown(base, "the object's metadata carried no <adtcore:packageRef> element");
  }
  // A root LOCAL package created over REST reads back with an empty
  // <pak:superPackage/> and no adtcore:packageRef at all (A4H, 2026-09-04);
  // a package is its own package, same as the not-yet-exists branch above.
  const packageName = (serverPackage ?? base.name).toUpperCase();

  if (!CREATE_ONLY.has(spec.type) && requestedPackage && requestedPackage !== packageName) {
    throw new AbapError(
      "BAD_INPUT",
      `${spec.label} ${name} already exists in package ${packageName}, but the request asked ` +
        `for ${requestedPackage}. abapsmith does not move objects between packages.`,
      {
        name,
        type: spec.type,
        uri,
        serverPackage: packageName,
        requestedPackage,
      },
      "Drop the `package` argument to edit the object where it already is. Moving an " +
        "object between packages is a transport-organiser operation and needs a human.",
    );
  }

  return {
    ...base,
    exists: true,
    packageName,
    packageSource: "server",
    masterSystem: parseMasterSystem(body),
    activation: activationFromBody(body),
  };
}

/**
 * Current source, or `undefined` when the object does not exist. Existence is
 * already settled by `resolveWriteTarget`, so this is zero-cost for a create.
 * A 404 on an existing object means it is not source-based, not "missing".
 *
 * Exception: a 404 on a class SUB-include means the include is
 * absent, which is a real, writable state — see the branch below. `contentUri`
 * builds `sourceUri` via `classIncludeUri` for this case, so the pre-write
 * compare/etag/post-lock re-read all operate on the same document the PUT
 * overwrites; an etag computed over `main` while writing `testclasses` would
 * wrongly pass `assertEtagMatches` otherwise.
 */
export async function readCurrentSource(
  conn: AbapConnection,
  t: ResolvedTarget,
): Promise<string | undefined> {
  if (!t.exists) return undefined;
  // Shape decides where/how to fetch — see contentUri/contentAccept. A
  // properties-shape 404 here is as unwritable as a source-shape 404.
  const uri = contentUri(t);
  const inc = subInclude(t);
  try {
    const resp = await conn.get(uri, { headers: { Accept: contentAccept(t) } });
    return resp.body;
  } catch (e) {
    if (isNotFoundError(e)) {
      // A missing sub-include is EMPTY, not unwritable: `t.exists` is the
      // class's own GET, so a 404 here is about the include alone (e.g. a class
      // with no test class yet has no `testclasses` doc). `undefined` means "no
      // previousEtag, no no-op short-circuit, not a class create" — the write
      // path already handles that. PUT to an absent include does NOT create it
      // (measured live, 2026-08-18/A4H: rejected with "does not have any
      // inactive version") — `writeObject` step 4a-ii POSTs it into existence
      // under the lock first; see archive. In practice only CCAU is ever
      // actually absent — CCDEF/CCIMP/CCMAC get a generated stub on a new class.
      if (inc) return undefined;
      throw new AbapError(
        "UNSUPPORTED",
        `${t.spec.label} ${t.name} exists but has no readable content at ${uri}.`,
        { uri: t.uri, sourceUri: t.sourceUri, contentUri: uri, type: t.type },
        "Only source-based objects can be written. Nothing was changed.",
      );
    }
    throw translateAdtError(e, {
      // Matches src/adt/source.ts's wording so sub-include failures read consistently.
      operation: inc ? `read include ${inc}` : "read",
      uri,
      name: t.name,
      type: t.type,
    });
  }
}

/**
 * `readCurrentSource` for callers that must tell "absent" from "unreadable".
 * Never throws: `{ ok: false }` is a failed read (timeout/500/dead session),
 * not "nothing there" — `deleteObject` records a before-image from this, and
 * flattening a failed read into `undefined` would make a delete unrecoverable.
 */
export async function readCurrentSourceResult(
  conn: AbapConnection,
  t: ResolvedTarget,
): Promise<{ ok: true; source: string | undefined } | { ok: false; error: unknown }> {
  if (!t.exists) return { ok: true, source: undefined };
  try {
    const resp = await conn.get(contentUri(t), { headers: { Accept: contentAccept(t) } });
    return { ok: true, source: resp.body };
  } catch (e) {
    // 404 (existing object, no source doc — or include absent) is a real
    // answer here, not a failure; no include branch needed since deleteObject
    // (this fn's one caller) refuses includes up front.
    if (isNotFoundError(e)) return { ok: true, source: undefined };
    return { ok: false, error: e };
  }
}

/**
 * Build the `EnhancementIntent` `SafetyGate.evaluate()` requires when the
 * mutated object is an enhancement type — its own identity plus what it
 * `affects`. `t.masterSystem` is optional because `preflightCorr`'s narrowed
 * `PreflightTarget` doesn't carry it; harmless since the origin ceiling judges
 * the AFFECTED object's master system, not the enhancement's own.
 *
 * Exported so `src/adt/enhancement-write.ts` (ENHO/XH, ENHS/XS — types
 * `resolveWriteTarget` refuses, so they can't reuse `authorizeMutation`) builds
 * the identical shape instead of a hand-copy that could drift.
 */
export function enhancementIntentFor(
  t: { name: string; type: string; packageName: string; masterSystem?: string },
  affects: EnhancedObjectRef,
): EnhancementIntent {
  return {
    enhancementName: t.name,
    enhancementPackage: t.packageName,
    enhancementType: t.type,
    enhancementMasterSystem: t.masterSystem,
    spotName: affects.spotName,
    targetName: affects.name,
    targetPackage: affects.packageName,
    targetMasterSystem: affects.masterSystem,
  };
}

/**
 * Resolve a target against the server and put its **real** package through the
 * safety gate, in that order — the only supported way to authorize a mutation
 * (the gate is required, never optional, so no call site can forget it).
 *
 * `delete`/`activate` require the object to exist: for an absent object,
 * `resolveWriteTarget` answers `packageName: requestedPackage || "$TMP"`,
 * which is the right fiction for a CREATE but not something to hand to
 * `gate.assert` for a delete/activate (there's no real caller-supplied
 * package to judge) — so those two fail `NOT_FOUND` before the gate runs.
 * `write` keeps working on an absent object; that's the create path.
 */
export async function authorizeMutation(
  conn: AbapConnection,
  gate: SafetyGate,
  op: "write" | "delete" | "activate",
  target: WriteTarget,
): Promise<AuthorizedTarget<MutatingOperation, ResolvedTarget>> {
  const t = await resolveWriteTarget(conn, target, op);
  if (!t.exists && op !== "write") {
    // NOT_FOUND rather than BAD_INPUT: the request is well-formed — legal name,
    // real type — the object simply is not on this system. Same code, and the
    // same shape of answer, as the guard in src/tools/activate.ts.
    throw new AbapError(
      "NOT_FOUND",
      `${t.spec.label} ${t.name} does not exist on ${conn.cfg.sid}, so there is nothing to ` +
        `${op}. Nothing was locked and nothing was changed.`,
      { object: t.name, name: t.name, type: t.type, uri: t.uri, system: conn.cfg.sid, operation: op },
      op === "delete"
        ? "Check the name with abap_search — it may already have been deleted, or the " +
          "`type` may not be the one it is stored under."
        : "Write it first with `abap_write` (that creates AND activates it), or correct the " +
          "name / `type` if you meant an object that is already there.",
    );
  }
  if (op === "activate" && isPackageType(t.type)) {
    throw new AbapError("UNSUPPORTED", "A package cannot be activated.", {
      type: t.type,
      name: t.name,
    });
  }
  return gate.authorize(op, t, {
    corr: { kind: "unresolved" },
    intent:
      isEnhancementType(t.type) && target.affects
        ? enhancementIntentFor(t, target.affects)
        : undefined,
  });
}

/**
 * `IS_LOCAL = X` with an empty CORRNR ⇒ local object, no transport. Always
 * returns `"local"` or `"transport"`, never `"not-determined"` — a lock
 * response IS an answer, whichever way it comes out (fixture:
 * `test/fixtures/cts/lock-transportable-object.xml`).
 */
export function transportFromLock(lock: LockInfo): TransportInfo {
  if (lock.isLocal && !lock.corrNr) return { status: "local", required: false };
  return {
    status: "transport",
    required: true,
    corrNr: lock.corrNr,
    corrUser: lock.corrUser,
    corrText: lock.corrText,
  };
}

/**
 * The minimal shape `preflightCorr` needs — narrower than `ResolvedTarget` so
 * callers with an object identity from elsewhere (e.g. `src/adt/bopf.ts`'s
 * BOPF business objects) don't have to fabricate one. Every `ResolvedTarget`
 * satisfies it structurally. `sourceUri` is optional since non-source objects
 * have none. `superPackage`/`exists` let a second `gate.assert` here rebuild
 * the same `SafetyTarget` `authorizeMutation` already judged (a package
 * create's allowlist question is answered by the superpackage, not
 * `packageName` — see `src/safety.ts`), so this doesn't silently reach a
 * different verdict for the same mutation.
 */
export interface PreflightTarget {
  uri: string;
  sourceUri?: string;
  name: string;
  type: string;
  packageName: string;
  superPackage?: string;
  exists?: boolean;
  /**
   * Set when `sourceUri` addresses a class sub-include rather than the object's
   * own source. Optional and absent for every non-class caller;
   * `ResolvedTarget` supplies it structurally. Read below only to decide which
   * URI CTS is shown — see there.
   */
  include?: ClassInclude;
}

/**
 * Decide which transport this mutation goes into — **pre-flight**, before the
 * journal hook, the lock, or any mutating request. `SessionTransport.resolve()`
 * decides from `POST /sap/bc/adt/cts/transportchecks`'s `KORRFLAG`, never from
 * inferring "needs a transport" off a failure (a transportable write with no
 * `corrNr` just succeeds and SAP silently fabricates a request).
 *
 * `undefined` means no manager is wired — NOT a licence to proceed;
 * `corrForMutation` turns that into a local write or a refusal, never an
 * un-numbered transportable one. A `denied` resolution throws here, before
 * anything is locked/journalled/touched.
 *
 * Exported so nothing elsewhere hand-rolls a second copy of this preflight —
 * see `src/adt/bopf.ts`'s module header for why its `createBusinessObject`
 * doesn't (yet) call this instead.
 */
export async function preflightCorr(
  conn: AbapConnection,
  t: PreflightTarget,
  opts: TransportOptions,
  operation: TrOperation,
  op: "write" | "delete",
): Promise<GatedCorr | undefined> {
  if (opts.transport === undefined) return undefined;
  const mgr = opts.transport;
  const res = await mgr.resolve(
    conn,
    // transportchecks needs a URI CTS can map to an object. Properties-shape
    // objects and class sub-includes use the object URI, not
    // `/source/main` or the include path — a real MSAG/N write 400'd with
    // "No URI-Mapping defined for URI" against the source-suffixed path; the
    // object URI resolves cleanly. For includes this is also semantically
    // right: the transport always records `R3TR CLAS ZCL_X`, matching the
    // lock's CORRNR (see lockUri). See archive for the full incident and the
    // one still-unverified inference (include-path mapping on a transportable
    // class was never directly tested).
    {
      uri:
        usesObjectUriForContent(t.type) || subInclude(t) !== undefined
          ? t.uri
          : (t.sourceUri ?? t.uri),
      devclass: t.packageName,
      name: t.name,
      type: t.type,
    },
    operation,
    opts.corrNr === undefined ? {} : { corrNr: opts.corrNr },
  );
  const denial = toAbapError(res);
  if (denial) throw denial;
  if (res.outcome !== "transport") return LOCAL_WRITE;
  // `config-pin`/`caller` are a HUMAN naming the request; everything else
  // (`session-created`/`session-cached`/`server-pin`) is the SERVER choosing
  // it — see SafetyCorr's doc comment (src/safety.ts) for why that maps to
  // "auto" even though the resolved TRKORR is a real number, not literally
  // the string "auto".
  const source = res.source === "config-pin" || res.source === "caller" ? "named" : "auto";
  opts.gate.assert(
    op,
    {
      name: t.name,
      packageName: t.packageName,
      type: t.type,
      // See the `PreflightTarget` doc comment: without these two, a package
      // create would be judged on its own name here — the container question
      // `authorizeMutation` already answered using the superpackage — and the
      // two gate calls could disagree on the identical mutation.
      ...(t.superPackage !== undefined ? { superPackage: t.superPackage } : {}),
      ...(t.exists !== undefined ? { exists: t.exists } : {}),
    },
    {
      corr: { kind: "transport", corrNr: res.corrNr, source },
      intent:
        isEnhancementType(t.type) && opts.affects
          ? enhancementIntentFor(t, opts.affects)
          : undefined,
    },
  );
  // Sole `as GatedCorr` in the codebase — minted here, right after the gate
  // judges the real TRKORR. `source` is the same value just asserted above.
  return { kind: "transport", corrNr: res.corrNr, source } as GatedCorr;
}

/**
 * `preflightCorr`'s sibling for a not-yet-existing transportable `DEVC/K`
 * create: CTS can't classify an object it's never seen, so `resolve()`
 * would wrongly answer `local` and drop `corr_nr`. Returns a plain
 * corrNr, not `GatedCorr`, since the bridge substitutes it into ABAP source.
 */
export async function preflightPackageCorr(
  conn: AbapConnection,
  t: PreflightTarget,
  opts: { transport: SessionTransport; gate: SafetyGate; corrNr?: string },
): Promise<{ corrNr: string; source: "named" | "auto" }> {
  const res = await opts.transport.resolveForNewTransportable(
    conn,
    {
      uri:
        usesObjectUriForContent(t.type) || subInclude(t) !== undefined
          ? t.uri
          : (t.sourceUri ?? t.uri),
      devclass: t.packageName,
      name: t.name,
      type: t.type,
    },
    opts.corrNr === undefined ? {} : { corrNr: opts.corrNr },
  );
  const denial = toAbapError(res);
  if (denial) throw denial;
  if (res.outcome !== "transport") {
    // resolveForNewTransportable() documents that it never returns
    // "not-needed"; reaching here means that contract broke, not that
    // this package is legitimately local.
    throw new AbapError(
      "CHECK_FAILED",
      `resolveForNewTransportable() returned outcome ${JSON.stringify(res.outcome)} for ${t.name}, ` +
        `but it documents that it never returns "not-needed" — this is an internal invariant ` +
        "violation in the transport resolver, not a decision about this package.",
      { name: t.name, outcome: res.outcome },
    );
  }
  // config-pin/caller are a human naming the request; other sources are the
  // server choosing it (see SafetyCorr in src/safety.ts).
  const source = res.source === "config-pin" || res.source === "caller" ? "named" : "auto";
  opts.gate.assert(
    "write",
    {
      name: t.name,
      packageName: t.packageName,
      type: t.type,
      // See the `PreflightTarget` doc comment: without these two, a package
      // create would be judged on its own name here — the container question
      // `authorizeMutation` already answered using the superpackage — and the
      // two gate calls could disagree on the identical mutation.
      ...(t.superPackage !== undefined ? { superPackage: t.superPackage } : {}),
      ...(t.exists !== undefined ? { exists: t.exists } : {}),
    },
    {
      corr: { kind: "transport", corrNr: res.corrNr, source },
      intent: undefined,
    },
  );
  return { corrNr: res.corrNr, source };
}

/**
 * Reconcile the pre-flight verdict with what the lock said; `undefined` means
 * refuse (`TRANSPORT_ERROR`, nothing written). The tie-break is asymmetric:
 * pre-flight-transport/lock-local sends the `corrNr` anyway (measured live: a
 * superfluous `corrNr` on a `$TMP` create returns 200 and is silently
 * ignored, never a 403 — only a malformed/not-a-change-request number is
 * rejected); pre-flight-local/lock-transportable refuses, because an
 * un-numbered transportable write doesn't fail, it silently fabricates a
 * request. Either way, nothing transportable is ever written unnumbered.
 *
 * Exported so `src/adt/enhancement-write.ts`'s ENHO/ENHS write path
 * reconciles identically rather than hand-copying this tie-break.
 */
export function corrForMutation(
  preflight: GatedCorr | undefined,
  lock: TransportInfo,
): GatedCorr | undefined {
  if (preflight?.kind === "transport") return preflight;
  if (lock.required) return undefined;
  return LOCAL_WRITE;
}

/**
 * The session TR died out from under us, one of two ways: a 403 naming our own request as
 * missing (`TRANSPORT_GONE`), or a refusal because it was released after this session
 * started using it (`corrNrFailure`'s `released` branch, `details.trStatus === "released"`).
 * Either way, drop it from the cache so the next write resolves afresh. Deliberately
 * no retry here ("fail loud once, then heal"): silently re-writing into a replacement
 * request would hide that something happened outside this session's knowledge.
 */
function noteTransportDead(mgr: SessionTransport | undefined, corr: WriteCorr, e: unknown): void {
  if (mgr === undefined || corr.kind !== "transport") return;
  if (!isAbapError(e)) return;
  if (e.code === "TRANSPORT_GONE") {
    mgr.invalidate(corr.corrNr, "not-found");
  } else if (e.details["trStatus"] === "released") {
    mgr.invalidate(corr.corrNr, "released");
  }
}

/**
 * Translate a 403 about the `corrNr` itself, before `translateWriteFailure`'s
 * syntax-error heuristic — a rejected transport number is not a rejected
 * program. Discrimination is free-text matching (`classifyCorrNrError`); a
 * non-matching 403 falls through to normal translation. UNVERIFIED: the
 * not-found and not-a-change-request branches are inferred from bad-number
 * fixtures, and the released branch from `trDelete`'s captured
 * already-released DELETE refusal — none of the three has ever been captured
 * on this write PUT itself.
 */
function corrNrFailure(e: unknown, t: ResolvedTarget, corr: WriteCorr): AbapError | undefined {
  if (corr.kind !== "transport") return undefined;
  const diag = classifyCorrNrError(e);
  if (diag === undefined) return undefined;
  const trkorr = diag.trkorr ?? corr.corrNr;
  if (diag.problem === "not-found") {
    return new AbapError(
      "TRANSPORT_GONE",
      `Transport request ${trkorr} no longer exists on the system, so ${t.spec.label} ` +
        `${t.name} was NOT written. The request was released or deleted after this session ` +
        "started using it.",
      { name: t.name, type: t.type, uri: t.uri, trkorr, corrNr: corr.corrNr, written: false },
      "The dead request has been dropped from this session. Retry the write: a fresh " +
        "request will be created (or name one with `corr_nr`). Nothing was written and the " +
        "lock was released — this is reported rather than retried automatically, because a " +
        "request vanishing mid-session means something happened outside abapsmith's knowledge.",
    );
  }
  if (diag.problem === "not-a-change-request") {
    return new AbapError(
      "TRANSPORT_ERROR",
      `${trkorr} is not a change request, so ${t.spec.label} ${t.name} was NOT written.`,
      { name: t.name, type: t.type, uri: t.uri, trkorr, corrNr: corr.corrNr, written: false },
      "Name a workbench change request (a TRKORR such as A4HK900123), or set " +
        "ABAP_ALLOW_TRANSPORTS=auto and let this session create one.",
    );
  }
  if (diag.problem === "released") {
    return new AbapError(
      "TRANSPORT_ERROR",
      `Transport request ${trkorr} has already been released, so ${t.spec.label} ${t.name} ` +
        "was NOT written. The request was released after this session started using it.",
      {
        name: t.name,
        type: t.type,
        uri: t.uri,
        trkorr,
        corrNr: corr.corrNr,
        written: false,
        // `noteTransportDead` keys on this to invalidate the session's copy of the request.
        trStatus: "released",
      },
      "A released request can take no further objects — this is not transient, and retrying " +
        "with the same request cannot succeed. The dead request has been dropped from this " +
        "session, so retrying the write resolves a fresh one. Under ABAP_ALLOW_TRANSPORTS=auto " +
        "a caller-named `corr_nr` is refused by policy, so retry rather than passing `corr_nr` " +
        "again — or configure a specific request in ABAP_ALLOW_TRANSPORTS.",
    );
  }
  return undefined;
}

/**
 * The fields a mutation refusal needs in order to name the object it refuses.
 *
 * Structural rather than `ResolvedTarget` so that `src/adt/enhancement-write.ts`
 * — which resolves its own `EnhancementWriteTarget` and never builds a
 * `TypeSpec` — can raise the SAME refusals rather than hand-copying their
 * message text. It did hand-copy them, and the copies had already drifted
 * (`corrNr` vs `corr_nr` in the remediation hint, a shorter divergence hint).
 * `ResolvedTarget` satisfies this as-is.
 */
export interface RefusalTarget {
  name: string;
  type: string;
  uri: string;
  packageName: string;
  /** The human-facing type name. `ResolvedTarget` supplies it as `spec.label`. */
  spec: { label: string };
  /**
   * Present when the refusal is about a class sub-include, so
   * `targetLabel` can say "the testclasses include of class ZCL_X" instead of
   * naming the class and sending the reader to the wrong document. Optional:
   * `src/adt/enhancement-write.ts`'s targets never carry one.
   */
  include?: ClassInclude;
}

/**
 * The refusal raised when a transportable object cannot be given a number.
 * One message covers two causes — no transport manager wired at all, or one
 * is wired but pre-flight said "local" while the lock disagreed — since
 * neither may degrade into writing without a `corrNr`. Exported so
 * `src/adt/enhancement-write.ts` reports both causes identically.
 */
export function transportRefusal(
  t: RefusalTarget,
  transport: TransportInfo,
  operation: "written" | "deleted",
  managed: boolean,
  extra: Record<string, unknown> = {},
  suffix = "",
): AbapError {
  return new AbapError(
    "TRANSPORT_ERROR",
    `${t.spec.label} ${t.name} is not a local object — the ABAP system wants a ` +
      (operation === "written"
        ? "transport request, which abapsmith cannot supply."
        : "transport request to delete it, which abapsmith cannot supply.") +
      suffix,
    { name: t.name, type: t.type, package: t.packageName, ...transport, ...extra },
    managed
      ? "The transport pre-check reported this object as local, but the lock demands a " +
        "request — the two disagree, so nothing was written. Name a request explicitly with " +
        "`corr_nr`, or re-check the object's package."
      : "Only local ($TMP) objects can be written by abapsmith today. The transport " +
        "path is unverified on this system and is deliberately not attempted.",
  );
}

/**
 * What a rollback attempt did, in the shape both refusal paths (and the
 * content-PUT-rejection path) report it.
 */
interface RollbackOutcome {
  rolledBack: boolean;
  rollbackError?: string;
  /**
   * `false` means rollback was never TRIED — distinct from "tried and
   * failed". Omitted (⇒ `true`) at the two pre-existing refusal call sites.
   * The PUT-rejection path sets it `false` when the failure class makes
   * automatic cleanup unsafe, not merely unsuccessful — see
   * `putRejectionRollbackSkipReason`.
   */
  attempted?: boolean;
  /** Set only when `attempted` is `false` — WHY cleanup was not even tried. */
  skipReason?: string;
}

/**
 * Delete an object this call created moments ago, because the write it was
 * created for is about to be refused. Caller must have released its own lock
 * first — this takes a fresh one for the DELETE. A rollback failure is
 * reported back as data, never thrown, so it doesn't shadow the
 * TRANSPORT_ERROR the caller needs to see.
 *
 * On success the lock is *forgotten*, not released (the object and its
 * enqueue are both gone — an UNLOCK would hit a 404); on failure it is kept,
 * since the enqueue may still be held.
 *
 * `preflight` is omitted by the two pre-existing refusal
 * call sites on purpose — both are reached because no usable transport
 * number exists, so `qs` stays `{ lockHandle }` only, matching the wire
 * sequence `test/write.test.ts:2211` pins. The third call site (the
 * content-PUT-rejection path) has a real, gate-judged `GatedCorr`, and
 * reconciles it against the FRESH lock's transport verdict (never reuses the
 * original write's number blindly) via the same two checks the original
 * write itself made: `corrForMutation` returning `undefined`, or its number
 * disagreeing with what the fresh lock reports. Either way the DELETE is
 * never sent un-numbered or mis-numbered — rollback is reported failed
 * instead, leaving the create on the server rather than risk fabricating a
 * transport assignment. See archive for the full reasoning.
 */
async function rollbackCreate(
  conn: AbapConnection,
  session: StatefulSession,
  t: ResolvedTarget,
  preflight?: GatedCorr,
): Promise<RollbackOutcome> {
  // This internal rollback path calls `conn.del`
  // directly and bypasses `resolveWriteTarget`'s delete gate. Without this
  // check, a type the registry doesn't trust `delete` for (e.g. BDEF/BDO,
  // live-proven to report DELETE success while the object survives) would
  // still attempt cleanup here and print a false "nothing left behind" via
  // `rollbackSuffix`. Strict `!== true` so both `false` and `"unverified"`
  // refuse, covering all three call sites of `rollbackCreate`.
  if (capabilitiesFor(t.type)?.delete !== true) {
    return {
      rolledBack: false,
      attempted: false,
      skipReason:
        `${t.spec.label}'s delete is not verified to work (see its REGISTRY entry in ` +
        "src/adt/capabilities.ts), so the object this call just created was left on the " +
        "server rather than risk reporting a rollback that did not actually happen",
    };
  }
  try {
    const cleanup = await session.lock(t.uri);
    let qs: { lockHandle: string; corrNr?: string } = { lockHandle: cleanup.handle };
    if (preflight !== undefined) {
      const freshTransport = transportFromLock(cleanup);
      const corr = corrForMutation(preflight, freshTransport);
      if (corr === undefined) {
        return {
          rolledBack: false,
          rollbackError:
            "the fresh lock taken for cleanup disagrees with this write's own transport " +
            "verdict, so no safe corrNr could be determined for the rollback DELETE",
        };
      }
      if (
        corr.kind === "transport" &&
        freshTransport.required &&
        freshTransport.corrNr !== undefined &&
        freshTransport.corrNr !== "" &&
        freshTransport.corrNr.toUpperCase() !== corr.corrNr.toUpperCase()
      ) {
        return {
          rolledBack: false,
          rollbackError:
            `the fresh lock now names request ${freshTransport.corrNr}, not ` +
            `${corr.corrNr} as before, so the rollback DELETE was refused rather than risk ` +
            "fabricating a transport assignment",
        };
      }
      if (corr.kind === "transport") qs = { ...qs, corrNr: corr.corrNr };
    }
    await conn.del(t.uri, { qs });
    session.forgetLock(t.uri);
    return { rolledBack: true };
  } catch (e) {
    return { rolledBack: false, rollbackError: describeUnknownError(e) };
  }
}

/** The sentence a refusal appends about the object it had already created. */
function rollbackSuffix(t: RefusalTarget, created: boolean, r: RollbackOutcome): string {
  if (!created) return "";
  if (r.attempted === false) {
    return ` This call had already created ${t.spec.label} ${t.name} and did NOT attempt ` +
      `to remove it automatically (${r.skipReason ?? "not safe to determine"}) — it is still ` +
      "on the server and may need to be deleted or overwritten by hand.";
  }
  return r.rolledBack
    ? ` The empty ${t.spec.label} this call had just created was deleted again, ` +
        "so nothing was left behind."
    : ` This call had already created an empty ${t.spec.label} ${t.name} and could ` +
        `NOT remove it again (${r.rollbackError ?? "unknown error"}) — it is still on ` +
        "the server and has to be deleted by hand.";
}

/**
 * The lock names a DIFFERENT request from the one the gate judged — the
 * transport-fabrication signature: before `corrNr` was sent on create, SAP
 * would record a new object in a request of its own choosing and the PUT
 * would collide with it (500 "already locked in request …"), and a retry
 * would succeed into a request no gate had judged. Should be unreachable now
 * that create sends `corrNr`, but checked and named loudly anyway rather than
 * left to a 500 nobody parses.
 *
 * Exported for `src/adt/enhancement-write.ts`, which has no
 * create-and-rollback path and passes `created: false` with an empty
 * rollback outcome.
 */
export function transportDivergence(
  t: RefusalTarget,
  gated: string,
  server: string,
  created: boolean,
  rollback: RollbackOutcome,
): AbapError {
  return new AbapError(
    "TRANSPORT_ERROR",
    `${t.spec.label} ${t.name} is recorded in transport request ${server}, but the request ` +
      `this write was authorised for is ${gated}. Nothing was written.` +
      rollbackSuffix(t, created, rollback),
    {
      name: t.name,
      type: t.type,
      package: t.packageName,
      gatedCorrNr: gated,
      serverCorrNr: server,
      created,
      ...(rollback.rolledBack ? { rolledBack: true } : { rolledBack: false }),
      ...(rollback.rollbackError ? { rollbackError: rollback.rollbackError } : {}),
    },
    `The ABAP system put this object in ${server} rather than in ${gated}. Writing anyway ` +
      `would record it in a request no safety gate has judged, so it was refused. Either ` +
      `name ${server} explicitly with \`corr_nr\` (it will then be gated like any other), or ` +
      `find out who moved the object — a second session, or a request generated by the ` +
      `system itself.`,
  );
}

/**
 * Obstacle 5: not every rejection of the fill-in PUT after a create
 * should trigger an automatic delete. Returns `undefined` when rollback is
 * safe; otherwise a short reason it isn't, for `rollbackSuffix`/
 * `details.skipReason`. Three independently-sufficient hazards: (1) the
 * rejection isn't a confirmed content rejection (only `BAD_INPUT`/
 * `CHECK_FAILED` are — anything else, e.g. a timeout after the server already
 * committed, risks deleting a write that actually succeeded); (2)
 * `SESSION_DEAD` — a dead session can't LOCK/DELETE/UNLOCK, so rollback would
 * just fail again; (3) the create already sent the FULL payload (TTYP/DA,
 * ENQU/DL — `create.vendor === false` properties-shape types whose create
 * POST carries the caller's own XML, not an empty skeleton, so "rollback"
 * would delete real content). BDEF/BDO is also `create.vendor === false` but
 * source-shape with a generated empty skeleton, so it's not excluded here.
 */
function putRejectionRollbackSkipReason(t: ResolvedTarget, err: AbapError): string | undefined {
  if (err.code === "SESSION_DEAD") {
    return "the session that held the lock is gone, so nothing can be locked, deleted or " +
      "unlocked automatically";
  }
  if (err.code !== "BAD_INPUT" && err.code !== "CHECK_FAILED") {
    return `the rejection (${err.code}) is not a confirmed content rejection — a transport-level ` +
      "failure could have hit AFTER the server already committed the write, and deleting on " +
      "that guess could destroy a successful write rather than an empty object";
  }
  if (writeShapeOf(t.type) === "properties" && capabilitiesFor(t.type)?.create?.vendor === false) {
    return `the create request for ${t.spec.label} already carried the full submitted ` +
      "content, not an empty skeleton, so an automatic delete would remove a complete " +
      "object rather than undo an empty one";
  }
  return undefined;
}

/**
 * `translateWriteFailure`'s "The object was NOT changed and the lock was
 * released" hint is true for a PUT rejected against a pre-existing object,
 * but false once `created` is true (the create POST DID change server
 * state). Rather than teach that function about `created`, the one caller
 * that knows better corrects the claim after the fact.
 */
function correctChangedClaim(hint: string | undefined, created: boolean): string | undefined {
  if (hint === undefined || !created) return hint;
  const claim = "The object was NOT changed and the lock was released.";
  if (!hint.includes(claim)) return hint;
  return hint.replace(
    claim,
    "This call had already created the object moments earlier, so it DID change server " +
      "state — see the message above for what happened to that empty object.",
  );
}

/**
 * The content PUT that fills in a just-created object was rejected.
 * Previously `writeObject` just rethrew `e` here, leaving the empty (or, for
 * TTYP/DA/ENQU/DL, full) object the create POST made permanently on the
 * server — the third path `rollbackCreate` wasn't wired to (the other two,
 * above, are reached before any content is sent). Not called when `!created`
 * — nothing to roll back. Always returns an `AbapError` to throw in place of
 * `e`; an unexpected unlock failure on an otherwise-healthy session still
 * propagates, as at the other call sites.
 */
async function reportCreatePutRejection(
  conn: AbapConnection,
  session: StatefulSession,
  t: ResolvedTarget,
  preflight: GatedCorr | undefined,
  err: AbapError,
): Promise<AbapError> {
  const skip = putRejectionRollbackSkipReason(t, err);
  const rollback: RollbackOutcome =
    skip !== undefined
      ? { rolledBack: false, attempted: false, skipReason: skip }
      : await (async () => {
          // Obstacle 2: `rollbackCreate` requires the caller to have released
          // its OWN lock first, so `session.lock` inside it takes a real wire
          // LOCK rather than short-circuiting to the handle this call is
          // still holding. Mirrors the two pre-existing call sites above
          // exactly (`await session.unlock(lockUri(t));` immediately before
          // `rollbackCreate`).
          await session.unlock(lockUri(t));
          // Obstacle 1: unlike the two pre-existing call sites (reached
          // because no usable corrNr exists at all), this path DOES have a
          // gate-judged one — pass it through so the cleanup DELETE carries
          // the same `corrNr` the create and the rejected PUT did.
          return rollbackCreate(conn, session, t, preflight);
        })();
  const suffix = rollbackSuffix(t, true, rollback);
  return new AbapError(
    err.code,
    err.message + suffix,
    {
      ...err.details,
      created: true,
      rolledBack: rollback.rolledBack,
      ...(rollback.attempted === false ? { rollbackAttempted: false } : {}),
      ...(rollback.skipReason ? { rollbackSkipReason: rollback.skipReason } : {}),
      ...(rollback.rollbackError ? { rollbackError: rollback.rollbackError } : {}),
    },
    correctChangedClaim(err.hint, true),
  );
}

/**
 * The LOCK (or, for a sub-include, the includes-collection POST) right
 * after `createNewObject`'s POST can itself fail — live-captured as a
 * non-ADT HTML 400 from the gateway. The create already landed; retrying
 * under the same name is what turned one stranded object into six in the
 * incident this closes. Deliberately does NOT call `rollbackCreate`: that
 * needs a FRESH lock to issue its DELETE, and the failure here IS "locking
 * is broken" — plus SAP is likely still holding the enqueue the failed LOCK
 * took. Attempting a rollback would burn a second lock/unlock cycle that can
 * itself leak. Report, don't mutate; never throws.
 */
async function reportCreateOrphan(conn: AbapConnection, t: ResolvedTarget, e: unknown): Promise<AbapError> {
  const original = isAbapError(e)
    ? e
    : translateAdtError(e, { operation: "lock", uri: lockUri(t), name: t.name, type: t.type });

  let verification: VerifyOutcome;
  try {
    verification = await verifyObjectPresent(conn, {
      uri: contentUri(t),
      accept: contentAccept(t),
      objectName: t.name,
      expectType: t.type,
    });
  } catch (verifyErr) {
    verification = {
      status: "indeterminate",
      uri: contentUri(t),
      reason: `Verification itself failed: ${describeUnknownError(verifyErr)}`,
    };
  }

  const objectExists: boolean | "unverified" =
    verification.status === "confirmed"
      ? true
      : verification.status === "confirmed-absent"
        ? false
        : "unverified";

  const suffix =
    verification.status === "confirmed"
      ? ` ${targetLabel(t)} WAS created and is still on the server (confirmed via ${verification.via}) — ` +
        "do not retry this create under this name."
      : verification.status === "confirmed-absent"
        ? ` A repository search found no trace of ${t.name} afterwards.`
        : ` Whether ${t.name} now exists on the server could not be confirmed (${verification.reason}) — ` +
          "verify before retrying this create under this name.";

  // The before-image lands in the journal as confirmed-absent — see emitBeforeImage's call
  // site below — the one provenance value deleteEvidenceBlocker accepts, so undo is
  // authorised even when verification couldn't confirm the object is there.
  const undoHint =
    verification.status === "confirmed-absent"
      ? undefined
      : "The create was journalled before this failure, so `abap_journal mode=undo` can remove " +
        "the orphaned object — do not retry this create under this name until that has run.";
  const hint = [correctChangedClaim(original.hint, true), undoHint].filter((s): s is string => s !== undefined).join(" ");

  return new AbapError(
    original.code,
    original.message + suffix,
    { ...original.details, created: true, verification, objectExists },
    hint === "" ? undefined : hint,
  );
}

/**
 * Is this the same source, as far as the ABAP server is concerned? Needs
 * three normalisations beyond `contentHash()` — line endings (LF vs CRLF),
 * per-line trailing space/tab stripping, and trailing-newline stripping
 * (CLAS preserves these; PROG/P doesn't — both verified live). See
 * `canonicalSource` in src/compact.ts for the full measurement record. Do
 * not simplify this back to a bare `contentHash` comparison — missing (2)
 * and (3) is silent and expensive, not incorrect (every unchanged write
 * still locks/PUTs/unlocks/activates).
 */
export function sourceEquals(a: string, b: string): boolean {
  return canonicalSource(a) === canonicalSource(b);
}

// canonicalSource lives in src/compact.ts (dependency-free) and is imported
// here rather than re-spelled, so this file and journal.ts's
// sourceFingerprint() can't drift on "same source" — they once did
// (strip-one vs strip-all) until a live probe settled it; see that doc comment.

/**
 * The etag abapsmith emits: a content hash of the canonical form. Exported
 * only so the pre-activation gate in src/tools/write.ts can hash a re-read
 * source with the identical normalisation — a second spelled-out
 * `contentHash(canonicalSource(…))` there could drift, as it once did.
 */
export const canonicalEtag = (s: string): string => contentHash(canonicalSource(s));

/**
 * Normalise a caller-supplied etag: we emit `sha256:…`, accept a bare digest
 * too. The `partial:` marker is stripped, not compared — it says
 * nothing about the resource, and every comparison here is a concurrency
 * question. `writeObject`'s full-source guard judges the marker instead, and
 * runs before this.
 */
function normaliseEtag(etag: string): string {
  const e = stripPartialEtag(etag).trim();
  return /^[0-9a-f]{16,}$/i.test(e) ? `sha256:${e.toLowerCase()}` : e;
}

/**
 * Refuse a whole-object rewrite pinned to an etag
 * `abap_read` minted alongside an INCOMPLETE delivery of that object's text.
 *
 * Keyed on the `partial:` marker, not a shrink percentage — a large shrink is
 * often legitimate (`test/write.test.ts` writes 17 chars over 31), and a
 * percentage guard just gets disabled by the first person it annoys. The real
 * distinguishing fact is "derived from text the caller never saw in full",
 * which is exactly what the marker carries.
 *
 * Runs here (not earlier) because `current` is already in hand from step 1
 * (no extra round trip), on the one path both write surfaces funnel through.
 *
 * Does not fire for a splice: `resolveWriteSource`'s `edit` form strips the
 * marker (it re-reads current full source and splices in, so truncation
 * can only affect which fragment was chosen). `method` keeps the marker —
 * `METHOD_BLOCK_RE`/`spliceMethodBlock`'s balance checks are shape checks
 * only, and a truncated-but-balanced method body would pass them.
 */
function assertNotPartialReadSource(t: ResolvedTarget, expectEtag: string, current: string | undefined): void {
  if (!isPartialEtag(expectEtag)) return;
  throw new AbapError(
    "PARTIAL_READ_SOURCE",
    `Refusing to overwrite ${targetLabel(t)} with source derived from a TRUNCATED read. ` +
      "The etag supplied is marked `partial:` — abap_read handed it out with a response that did " +
      "NOT contain the whole object" +
      (current === undefined ? "" : ` (the server copy is ${current.split("\n").length} line(s))`) +
      ". Writing back what that response showed would silently delete everything past the point " +
      "where it was cut.",
    {
      name: t.name,
      type: t.type,
      uri: t.uri,
      operation: "write",
      expectedEtag: expectEtag,
      ...(current === undefined ? {} : { currentLines: current.split("\n").length, currentChars: current.length }),
    },
    "Do NOT simply drop expect_etag — that removes the check, not the problem. Either (a) use " +
      "`edit` with {old_string, new_string} to splice a targeted change into the server's current " +
      "source, which never needs the whole text in hand; or (b) re-read the object in complete " +
      "pieces with offset/limit until you hold every line, and write back with the etag from a read " +
      "that was not truncated.",
  );
}

/**
 * Compare-before-write / compare-before-delete. Throws `ETAG_CONFLICT`,
 * returns silently on a match. Shared by both mutating paths so they can't
 * disagree on what counts as a conflict.
 *
 * Accepts two hashes: `abap_read`'s raw `contentHash(rawServerBytes)` and
 * the canonical hash everything here emits — they differ by trailing
 * newlines the server strips on store, and accepting only one would
 * manufacture conflicts out of source nobody touched.
 */
function assertEtagMatches(
  t: ResolvedTarget,
  current: string | undefined,
  expectEtag: string,
  operation: "write" | "delete",
): void {
  const expected = normaliseEtag(expectEtag);
  const actualEtag = current === undefined ? undefined : canonicalEtag(current);
  // Deliberately not narrowed to `actualEtag` alone, even though every read
  // format now routes through `canonicalEtag` (src/tools/read.ts's
  // `resourceEtag`). Kept as a compatibility net for etags callers are still
  // holding from before that fix, and because `test/write.test.ts` pins
  // acceptance of a raw-hash etag directly — removing this is a breaking
  // change to a tested contract. Safe: `contentHash` is a strictly weaker
  // normalisation than `canonicalEtag`, so this can only accept a raw-hash
  // etag `canonicalEtag` would have rejected, never mask a genuine conflict.
  const actualEtagRaw = current === undefined ? undefined : contentHash(current);
  if (expected === actualEtag || expected === actualEtagRaw) return;
  throw new AbapError(
    "ETAG_CONFLICT",
    current === undefined
      ? subInclude(t)
        ? // An absent sub-include ≠ a deleted object — the class is still
          // there (t.exists came from its own GET); only the include is missing.
          `${targetLabel(t)} has no source, but an etag was supplied — that include ` +
          "has been emptied or removed since you read it."
        : `${t.spec.label} ${t.name} does not exist, but an etag was supplied — ` +
          "it must have been deleted since you read it."
      : `${targetLabel(t)} changed since you read it.`,
    {
      name: t.name,
      type: t.type,
      uri: t.uri,
      ...(subInclude(t) ? { include: t.include, contentUri: contentUri(t) } : {}),
      operation,
      expectedEtag: expected,
      actualEtag: actualEtag ?? null,
      /** The un-canonicalised hash, i.e. what `abap_read` would have handed out. */
      actualEtagRaw: actualEtagRaw ?? null,
    },
    // A retry hint is only honest if a retry can succeed. Before every read
    // format agreed on one resource-derived etag, "re-read and retry" could
    // loop forever (live-observed) — now a genuine re-read always differs
    // from the rejected etag unless the object truly hasn't changed, so the
    // hint says that explicitly instead of implying a retry always helps.
    operation === "delete"
      ? "Re-read the object, confirm it is still the one you meant to delete, and delete " +
        "again with the FRESH etag from that re-read. If the fresh read's etag is identical " +
        "to the one you just tried, stop — retrying cannot succeed no matter how many times " +
        "it is repeated. Nothing was locked and nothing was deleted."
      : "Re-read the object, re-apply your change to its current source, and write again " +
        "with the FRESH etag from that re-read. If the fresh read's etag is identical to the " +
        "one you just tried, stop — retrying cannot succeed no matter how many times it is " +
        "repeated. Nothing was locked and nothing was written.",
  );
}

/**
 * The OTHER `ETAG_CONFLICT`: the document moved between the pre-lock read and
 * the lock, so nothing the caller was shown is current any more.
 *
 * `phase: "post-lock"` is the one key that distinguishes this from
 * `assertEtagMatches`'s refusal; everything else is deliberately the same
 * shape, so a consumer parses one conflict, not two.
 *
 * Exported for `src/adt/enhancement-write.ts`, whose in-lock re-read enforces
 * the same read-modify-write law against the same window.
 */
export function postLockEtagConflict(
  t: RefusalTarget,
  expected: string | null,
  actual: string | null,
  extra: Record<string, unknown> = {},
): AbapError {
  return new AbapError(
    "ETAG_CONFLICT",
    `${targetLabel(t)} changed between the pre-write read and the lock.`,
    {
      name: t.name,
      type: t.type,
      uri: t.uri,
      ...(subInclude(t) ? { include: t.include } : {}),
      operation: "write",
      phase: "post-lock",
      expectedEtag: expected,
      actualEtag: actual,
      ...extra,
    },
    "The object changed between the pre-write read and the lock. Nothing was written; " +
      "the lock was released. Re-read the object, re-apply your change to the current " +
      "source, and write again.",
  );
}

/**
 * Create-if-missing, then `lock → PUT → unlock`. Never activates — that's a
 * separate step, since it can't happen while the lock is held.
 *
 * After an include write, activate the GLOBAL CLASS, never the
 * include: `WriteResult.target` already carries the class's `uri`/`name`/
 * `type` (only `sourceUri` moves to the include), so a caller activating
 * `written.target` is already doing the right thing. CCDEF/CCIMP/CCMAC/CCAU
 * have no independent active/inactive version — confirmed live (2026-08-18,
 * A4H): activating the class alone made a freshly written test class run
 * under ABAP Unit. If a release ever needs to name the include explicitly,
 * the vendor library's `activate` accepts an unused `?context=<mainInclude>`
 * param — see `src/adt/activate.ts`, not here. See archive for the full
 * live-run evidence.
 */
export async function writeObject(
  conn: AbapConnection,
  target: AuthorizedTarget<MutatingOperation, ResolvedTarget>,
  opts: WriteOptions,
): Promise<WriteResult> {
  const t = target.target;

  // An empty write is refusable without doing anything else, so it must not
  // cost a request.
  if (typeof opts.source !== "string" || opts.source.length === 0) {
    throw new AbapError(
      "BAD_INPUT",
      `Refusing to write empty source to ${targetLabel(t)}.`,
      { name: t.name, type: t.type, ...(subInclude(t) ? { include: t.include } : {}) },
      subInclude(t)
        ? "To empty a class include, write a single comment line to it (e.g. `*\"* no local " +
          "test classes`) — abapsmith does not send an empty document, and there is no ADT " +
          "verb that deletes an include on its own."
        : "To remove an object use the delete operation, not an empty write.",
    );
  }

  if (isPackageType(t.type)) {
    throw new AbapError(
      "UNSUPPORTED",
      "A package has no source; use createPackage to create one.",
      { type: t.type, name: t.name },
      "Packages are create-only.",
    );
  }

  // A FUGR/F main source naming its TOP include but no UXX/Uxx implementation include.
  assertFunctionGroupImplementationInclude(t, opts.source);

  // ---- 0a. An include write never CREATES the class ------------------------
  // create-if-missing here would synthesise a class skeleton and PUT
  // opts.source to `…/includes/testclasses`, giving the class a main body
  // NOBODY WROTE — a fabricated object, which this module refuses everywhere
  // (assertPayloadMatchesTarget, transportDivergence).
  //
  // Two calls, in an order the caller chooses on purpose, is the whole remedy:
  // write the class, then write its include. Nothing is lost — the second write
  // needs no lock the first one held — and the caller keeps authorship of the
  // class body. Refused before the first request, so it costs nothing.
  if (subInclude(t) && !t.exists) {
    throw new AbapError(
      "NOT_FOUND",
      `${t.spec.label} ${t.name} does not exist on ${conn.cfg.sid}, so its ${t.include} ` +
        "include cannot be written. abapsmith will NOT create the class as a side effect of " +
        "an include write: the class body would be a generated skeleton nobody wrote.",
      {
        name: t.name,
        type: t.type,
        uri: t.uri,
        include: t.include,
        contentUri: contentUri(t),
        system: conn.cfg.sid,
      },
      `Write ${t.name} itself first (abap_write with no \`include\`, which creates and ` +
        `activates it), then write its ${t.include} include in a second call. Nothing was ` +
        "locked and nothing was changed.",
    );
  }

  // ---- 0. The payload's own identity, for the properties shape -----------
  // For these types the body IS the object (names itself + its package), and
  // a create POSTs it to a collection where that name decides what's
  // created. Checked here, before the first request, so a mismatch costs
  // nothing; createByXml/putContent re-check as the actual enforcement points.
  if (writeShapeOf(t.type) === "properties") {
    // Normalise FIRST, before either assert, by reassigning `opts`
    // itself — every later use of `opts.source` in this function (`nextEtag`
    // via `canonicalEtag`, the `sourceEquals(current, opts.source)` no-op
    // short-circuit, the create POST body, the PUT body, the fallback etag)
    // must see the same bytes that actually go on the wire, not the bytes
    // the caller happened to pass in. `injectEmptyFixValues` is a no-op for
    // every type but `DOMA/DD` and idempotent even there, so this costs
    // nothing on the common path.
    opts = { ...opts, source: injectEmptyFixValues(t, opts.source) };
    assertPayloadMatchesTarget(t, opts.source);
    assertDomaMasterLanguage(t, opts.source);
  }

  // ---- 1. What is there now? (No lock yet.) ----------------------
  const current = await readCurrentSource(conn, t);
  const previousEtag = current === undefined ? undefined : canonicalEtag(current);
  const nextEtag = canonicalEtag(opts.source);

  // ---- 2. Compare-before-write, BEFORE taking any lock -------------------
  // Completeness first, then concurrency: a `partial:` etag whose hash still
  // matches the server would sail through assertEtagMatches (the hash is
  // over the FULL source) — exactly how a partial-read data loss passed every
  // existing check.
  if (opts.expectEtag !== undefined) {
    assertNotPartialReadSource(t, opts.expectEtag, current);
    assertEtagMatches(t, current, opts.expectEtag, "write");
  }

  // ---- 3. Identical? Then do not write at all ---------------------------
  // Compares via sourceEquals/canonicalSource (CRLF→LF plus trailing-newline
  // stripping — contentHash() alone covers only the first). Verified live
  // 2026-07-31 on ZMCP_DEMO_CNT: a raw contentHash comparison reported
  // `changed: true` on every write of unmodified PROG/TABL source (server
  // strips trailing newlines on store), so the skip-the-PUT optimisation
  // never fired. The etag handed back is over this SAME canonical form so a
  // later read can reproduce it; `abap_read`'s raw contentHash is still
  // accepted by assertEtagMatches, so the two spellings never collide.
  if (current !== undefined && sourceEquals(current, opts.source)) {
    return {
      target: t,
      created: false,
      changed: false,
      // The etag of what is ACTUALLY on the server, not of the caller's buffer.
      // Those differ by whatever trailing newlines the server strips, and
      // handing back the caller's hash would produce an etag that fails its own
      // next `expect_etag` check.
      etag: previousEtag ?? nextEtag,
      previousEtag,
      // D2: nothing was written, so `required: false` is true of the
      // OPERATION — but this return is above both signals that could answer
      // whether the OBJECT itself is transportable (preflightCorr's
      // transportchecks, and session.lock's IS_LOCAL/CORRNR), so that is
      // genuine ignorance, not "local". Deliberately not resolved by paying
      // for either signal (lock costs an enqueue for a no-op write;
      // preflightCorr can mint a transport request for a change that isn't
      // happening) or by inferring from `t.packageName`.
      transport: notDetermined(
        "the source was already identical, so this call took no lock and ran no transport " +
          "pre-check — nothing asked the ABAP system whether this object is transportable.",
      ),
      previousSource: current,
    };
  }

  // `created` means bringing the OBJECT into existence — not just
  // `current === undefined`, which is wrong for a class with no `testclasses`
  // document — that answers `undefined` while the class demonstrably exists.
  // `t.exists` is the authority; the content read only says whether there
  // are bytes to compare. (Step 0a already refused the other half of the
  // cross-product, so `!t.exists` here is always a genuine object create.)
  const created = current === undefined && !t.exists;

  // The CREATE-direction twin of the delete gate below.
  // `CREATABLE_TYPES` (already checked in resolveWriteTarget) is deliberately
  // broad, to avoid blocking EDITS of a type whose create was just never
  // proven live — so an unverified-create type can still arrive here as
  // `created`. Can't be caught in resolveWriteTarget itself: "is this a
  // create" is only knowable from `t.exists` + `current`, both settled here.
  // Placed before step 3a's preflightCorr (which can itself mint a transport
  // request) so a refused create never fabricates one — though the upstream
  // existence GET and this function's own readCurrentSource have already hit
  // the wire, so this guarantees zero MUTATING requests, not zero requests.
  // Strict `!== true` on the tri-state `CreateCapability.verified`, same
  // discipline as the DELETABLE gate and rollbackCreate's own check. Gated on
  // `created` alone, so edits never reach this branch. No DEVC/K carve-out
  // needed — package create is a wholly separate path (isPackageType above
  // already refuses to touch it here).
  if (created && capabilitiesFor(t.type)?.create?.verified !== true) {
    throw new AbapError(
      "UNSUPPORTED",
      `${t.spec.label} (${t.type}) cannot be created by abapsmith. ${TERMINAL_REFUSAL_NOTE}`,
      { type: t.type, creatable: [...VERIFIED_CREATABLE_TYPES] },
      `Creatable types are ${VERIFIED_CREATABLE_TYPES.join(", ")}. See that type's REGISTRY ` +
        "entry in src/adt/capabilities.ts for why create is refused here — either it has never " +
        "been tried live, or it was tried and did not reliably work.",
      { retryable: false }, // matches UNSUPPORTED's own default; reaffirmed for readability at the throw site
    );
  }

  // Not yet observable (every return path overwrites this from
  // transportFromLock) but spelled truthfully anyway, so a future early
  // return here inherits "we did not ask" rather than "it is local".
  let transport: TransportInfo = notDetermined(
    "the lock response had not been read yet (this value is never returned).",
  );
  let normalisedSource: string | undefined;
  // Populated only on the properties-shape UPDATE path (step 4b) — see
  // WriteResult.etagSource's doc comment. undefined elsewhere.
  let postWriteSource: string | undefined;
  // Seeded with the pre-lock read; overwritten on the update path with the
  // bytes re-read under the lock (step 4a) — canonically equal, but the
  // fresh ones are what the journal entry carries.
  let previousSource: string | undefined = current;

  // ---- 3a. TRANSPORT — PRE-FLIGHT, never error-driven --------------------
  // After the no-op check (a byte-identical write mints no transport
  // request), before the journal hook (a denied resolution leaves no entry
  // on disk, and the entry that IS written can carry corrNr from begin()),
  // before the lock (the verdict comes from transportchecks/KORRFLAG, not
  // the lock). "I"/"U" is insert vs update.
  const preflight = await preflightCorr(conn, t, opts, created ? "I" : "U", "write");

  // ---- 3b. JOURNAL — before-image on disk before anything mutates --------
  // Deliberately after the etag check and the no-op check (neither mutates
  // anything, so neither has anything to undo). WHERE it fires from there is
  // path-dependent, because "on disk before anything mutates" and "built from
  // the bytes that are actually on the server" pull in opposite directions
  // across the GET→LOCK window:
  //
  //  - CREATE — here, before `createNewObject`'s POST in step 4. An unrecorded
  //    create is unrecoverable (there is no earlier state to reconstruct from
  //    and no undo entry naming the object), so the record has to land first.
  //    Being early costs nothing on this path: a create has no pre-image bytes
  //    at all (`source: undefined`, and `current` IS undefined here — that is
  //    what `created` means), so there is nothing a concurrent edit could
  //    invalidate, and no pre-read to re-validate.
  //  - UPDATE — in step 4a, after the lock and the post-lock re-read, fed the
  //    post-lock bytes. The pre-lock bytes are stale by construction: the
  //    window they were read in contains the transport pre-check and this very
  //    disk write. An image built from them makes undo restore a state that
  //    never existed. It is still "before anything mutates": a lock is an
  //    enqueue, not a change, and the PUT is two steps further down.
  //
  // If the hook throws, an unrecordable write is refused rather than
  // performed unrecorded; on the update path `withStatefulSession`'s finally
  // still releases the enqueue. `existed` comes from `t.exists` (the real
  // GET), not `!created`, so it stays correct if that equivalence ever
  // breaks. `sourceReadable` is unconditionally true — readCurrentSource
  // throws on a failed read at both call sites.
  const emitBeforeImage = async (source: string | undefined): Promise<void> => {
    if (!opts.onBeforeImage) return;
    await opts.onBeforeImage({
      source,
      existed: t.exists,
      sourceReadable: true,
      target: t,
      // See BeforeImage.include — an entry missing which document `source` came from replays into /source/main.
      ...(subInclude(t) ? { include: t.include } : {}),
      ...(preflight?.kind === "transport" ? { corrNr: preflight.corrNr } : {}),
    });
  };

  if (created) await emitBeforeImage(undefined);

  // ---- 4. create? → lock → recheck → PUT → unlock, one session ----------
  await conn.withStatefulSession(async (session) => {
    // `corrNr` goes on the CREATE too, not just the PUT: without it SAP files
    // the new object under a request of its own choosing and the PUT then
    // collides with it (see `createNewObject`). Same gate-judged `preflight`
    // value both times.
    if (created) await createNewObject(conn, t, preflight, opts.source);

    // `lockUri(t)`, not `t.uri`: for an include write the enqueue and the PUT
    // address different URIs, and `lockUri` is the one place that decides
    // which. Every unlock/forget below asks the same function so the lock
    // ledger can't end up holding a key nothing releases — see `lockUri`.
    //
    // If `created`, the create POST above already landed — a LOCK
    // failure here must not read like nothing happened. See reportCreateOrphan.
    let lock: LockInfo;
    try {
      lock = await session.lock(lockUri(t));
    } catch (e) {
      throw created ? await reportCreateOrphan(conn, t, e) : e;
    }

    // ---- 4a. Post-lock recheck, then the update path's before-image ------
    // The enqueue is the first point nothing else can move the bytes under
    // us; everything read before it (GET, transport round trips, journal
    // writes) was read across an open window. Re-read and refuse if the bytes
    // moved — unconditional, not gated on `expectEtag`. A plain
    // readCurrentSource + canonicalEtag suffices: there is no `If-Match` on
    // this protocol, the etag is our own content hash.
    //
    // Also detects a session that expired between LOCK and PUT — expiry
    // releases enqueues silently. Live-captured 2026-08-02 measurement and
    // the SESSION_DEAD-vs-ETAG_CONFLICT classification rule: see
    // the git history. translateAdtError (session.ts:538)
    // classifies SESSION_DEAD before this comparison runs; deleteObject's
    // twin re-read repeats the same classification explicitly.
    //
    // CREATE is exempt: no pre-read baseline exists; test fakes leave
    // GET …/source/main unrouted on the create path to prove this request
    // never happens there.
    if (!created) {
      let fresh: string | undefined;
      try {
        fresh = await readCurrentSource(conn, t);
      } catch (e) {
        // ---- 4a-i. A dead session is told nothing, not even UNLOCK --------
        // Symmetric with deleteObject's SESSION_DEAD branch. Once the
        // contextid is gone the enqueue went with it and the handle can't
        // even be used to ask — sending UNLOCK would be harmless but proves
        // nothing (live testing: UNLOCK returns 200 even for a meaningless
        // handle). Rule: treat "session died" as "all its locks are gone",
        // not "locks to be cleaned up later". Keyed on the SESSION_DEAD
        // classification specifically, never on "the unlock failed" — any
        // other failure still takes the full retry-and-escalate route in
        // `releaseLock` (test/session.test.ts). Full 2026-08-02 live-capture
        // evidence: see the git history.
        if (isAbapError(e) && e.code === "SESSION_DEAD") session.forgetLock(lockUri(t));
        throw e;
      }
      const actualEtag = fresh === undefined ? null : canonicalEtag(fresh);
      const actualEtagRaw = fresh === undefined ? null : contentHash(fresh);
      if (actualEtag !== (previousEtag ?? null)) {
        // Explicit unlock here (not left to the finally): "nothing was
        // written" includes "the lock was released".
        await session.unlock(lockUri(t));
        throw postLockEtagConflict(t, previousEtag ?? null, actualEtag, {
          /** The un-canonicalised hash, i.e. what `abap_read` would hand out. */
          actualEtagRaw,
        });
      }
      // The bytes the undo record must restore, captured under the enqueue.
      previousSource = fresh;
      await emitBeforeImage(fresh);
    }

    transport = transportFromLock(lock);
    const corr = corrForMutation(preflight, transport);
    if (corr === undefined) {
      // No usable number for a transportable object. Historically this was the
      // only outcome ("the transport path is unverified"); it now also covers a
      // pre-flight that said "local" while the lock disagrees. Either way the
      // one thing that must NOT happen is a PUT without a `corrNr` — that would
      // return 200 and have SAP fabricate a request behind our back. Release
      // the lock and report exactly what the server said.
      await session.unlock(lockUri(t));

      // The transport verdict genuinely cannot be known before the lock — it IS
      // the lock response — so the create above has already happened. Undo
      // it, or this refusal leaves an empty object behind on the server for
      // every attempt.
      const rollback: RollbackOutcome = created
        ? await rollbackCreate(conn, session, t)
        : { rolledBack: false };

      throw transportRefusal(
        t,
        transport,
        "written",
        opts.transport !== undefined,
        {
          created,
          rolledBack: rollback.rolledBack,
          ...(rollback.rollbackError ? { rollbackError: rollback.rollbackError } : {}),
        },
        rollbackSuffix(t, created, rollback),
      );
    }

    // The gate judged one TRKORR; the server disagrees. Refuse, name both
    // numbers, and roll back anything this call created — see
    // `transportDivergence`.
    if (
      corr.kind === "transport" &&
      transport.required &&
      transport.corrNr !== undefined &&
      transport.corrNr !== "" &&
      transport.corrNr.toUpperCase() !== corr.corrNr.toUpperCase()
    ) {
      await session.unlock(lockUri(t));
      const rollback: RollbackOutcome = created
        ? await rollbackCreate(conn, session, t)
        : { rolledBack: false };
      throw transportDivergence(t, corr.corrNr, transport.corrNr, created, rollback);
    }

    // The lock reports the request the object is already in; `corr` is the
    // one this PUT puts it in — what the caller must be told.
    if (corr.kind === "transport") {
      // Spelled out rather than spread: `TransportInfo`'s arms are literal
      // shapes, so "transportable" is constructed as one; the two
      // descriptive fields carry across only when the lock reported them.
      transport = {
        status: "transport",
        required: true,
        corrNr: corr.corrNr,
        ...(transport.corrUser === undefined ? {} : { corrUser: transport.corrUser }),
        ...(transport.corrText === undefined ? {} : { corrText: transport.corrText }),
      };
    }

    // ---- 4a-ii. The include may not EXIST yet, and PUT will not create it ---
    // CCDEF/CCIMP/CCMAC materialise as empty stubs on a brand-new class; CCAU
    // does not exist until something creates it, and a PUT against it 404s
    // (live finding 2026-08-18, A4H — exact error and stub sizes: see
    // the git history). Remedy: POST to the `…/includes`
    // collection first, same as Eclipse ADT / `createTestInclude`, under this
    // call's lock and `corrNr` (avoids the create/write transport split
    // `createNewObject` also avoids). Keyed on `previousSource === undefined`
    // (the under-lock read from step 4a) so a concurrent create in the open
    // window is detected as "it is there now", not duplicated.
    if (subInclude(t) && previousSource === undefined) {
      await createClassInclude(conn, t, lock.handle, corr);
    }

    try {
      normalisedSource = await putContent(conn, t, opts.source, lock.handle, corr);
    } catch (e) {
      // A dead session request (missing or released out from under us)
      // retires it from the session cache so the next write resolves
      // afresh. No retry here.
      noteTransportDead(opts.transport, corr, e);
      // Guard kept rather than assumed (putContent always translates
      // before rethrowing, but an unexpected raw error should still
      // propagate as itself). Only reached for `created` — an existing
      // object's rejected PUT never created anything to roll back.
      throw created && e instanceof AbapError
        ? await reportCreatePutRejection(conn, session, t, preflight, e)
        : e;
    }

    // ---- 4b. Post-write confirmation ----------------------------------------
    // For the properties shape, `putContent`'s response is the server's
    // ACCEPTANCE of the request, not proof of what it now holds — a live
    // MSAG/N finding showed a 200 that echoes the submitted document proves
    // nothing about persistence. So on UPDATE (where a genuine before/after
    // comparison is possible via a real GET), re-read through the same lock
    // before releasing it. A throw here (404, session death) propagates
    // rather than being swallowed into a false success — CREATE's
    // `etagSource` stays `undefined`, unproven either way, since there's no
    // live evidence for that path yet.
    if (!created && writeShapeOf(t.type) === "properties") {
      postWriteSource = await readCurrentSource(conn, t);
    }

    // Explicit, and before anything else: the caller will likely activate
    // next, and activation while the lock is held is a 403.
    //
    // UNLOCK answers 200 even for a garbage handle (live lock-handle-
    // validation testing), so its status proves nothing by itself — but the
    // handle sent here is the one THIS session got from LOCK for THIS
    // object, so the release is as real as our own lock was. UNTESTED:
    // whether UNLOCK with a bogus handle, on a session genuinely holding the
    // real lock, releases it — this line never hits that case (see
    // `forgetLock`'s hazard note in session.ts).
    await session.unlock(lockUri(t));
  });

  // `postWriteSource` is set only when step 4b ran a genuine post-write GET
  // (properties-shape UPDATE). When it did, `changed`/`etag`/
  // `normalisedSource` are derived from that real read, compared against
  // `previousSource` (step 4a's freshest "before") — distinguishing "the
  // server changed" from "the server silently kept the old document despite
  // a 200" (step 3's `sourceEquals` short-circuit already ruled out "nothing
  // was asked"). Every other path keeps `postWriteSource`/
  // `confirmedPostWrite`/`etagSource` undefined/false — honest silence
  // rather than a confirmation never sought.
  let changed: boolean;
  let etag: string;
  let finalNormalisedSource: string | undefined = normalisedSource;
  let etagSource: WriteResult["etagSource"];
  if (postWriteSource !== undefined) {
    // Narrowed here rather than via a separate boolean — TS wouldn't carry
    // that narrowing to a later use of `postWriteSource` anyway.
    changed = !(previousSource !== undefined && sourceEquals(previousSource, postWriteSource));
    etag = canonicalEtag(postWriteSource);
    finalNormalisedSource = postWriteSource;
    etagSource = "post-write-read";
  } else {
    changed = true;
    // DDIC hands back the normalised source; trust it over what we sent.
    // Either way the etag is canonical — hashing the caller's raw buffer
    // (trailing newline intact) used to cause spurious ETAG_CONFLICTs.
    etag = canonicalEtag(normalisedSource ?? opts.source);
  }

  return {
    target: t,
    created,
    changed,
    etag,
    previousEtag,
    transport,
    normalisedSource: finalNormalisedSource,
    ...(etagSource !== undefined ? { etagSource } : {}),
    // Post-lock bytes on the update path (step 4a), the pre-lock read on a
    // create — where they are `undefined` either way.
    previousSource,
  };
}

/**
 * Options for {@link createPackage}. Not a plain `interface … extends
 * TransportOptions` — `TransportOptions` is a union (`{transport?: undefined,
 * …} | {transport: SessionTransport, gate: SafetyGate, …}`, see its doc
 * comment), and a TS interface cannot extend a union type. `WriteOptions`
 * hits the same wall and is spelled the same way, as an intersection type.
 */
export type PackageCreateOptions = TransportOptions & {
  /**
   * Software component, e.g. `HOME` (transportable) or `LOCAL` ($TMP-like).
   * Required: it decides transportability, so abapsmith will not guess it.
   */
  softwareComponent: string;
  /** `development` (default), `structure` or `main`. */
  packageType?: string;
  /** Transport layer. Default `""` — the value a confirmed-transportable package carries on this appliance. */
  transportLayer?: string;
  /** REQUIRED — see {@link BeforeImageHook} and {@link NO_JOURNAL}; a create is unrecoverable if unrecorded. */
  onBeforeImage: BeforeImageHook;
};

export interface PackageCreateResult {
  target: ResolvedTarget;
  created: true;
  superPackage?: string;
  softwareComponent: string;
  packageType: string;
  transportLayer: string;
  transport: TransportInfo;
}

/**
 * Shared with the tool layer (`src/tools/write.ts`'s `abapCreatePackage`),
 * which duplicates this same empty-`software_component` check as a
 * zero-network refusal before `authorizeMutation` — that shadow guard fires
 * first, so this constant is the one place the wording can change.
 */
export const PACKAGE_SOFTWARE_COMPONENT_HINT =
  "Use HOME (or another real software component) for a transportable package. LOCAL only " +
  "works for a $-named local package — abapsmith's default Z*/Y* names are not eligible, " +
  "and SAP refuses the assignment with TR/462.";

/**
 * Create a `DEVC/K` package. Create-only, by design (`CREATE_ONLY_TYPES`): a
 * package has no source, so there is no rewrite/delete/activate here, only
 * this one POST, gated like every other mutation in the module.
 */
export async function createPackage(
  conn: AbapConnection,
  target: AuthorizedTarget<MutatingOperation, ResolvedTarget>,
  opts: PackageCreateOptions,
): Promise<PackageCreateResult> {
  const t = target.target;

  if (!isPackageType(t.type)) {
    throw new AbapError("BAD_INPUT", "createPackage only creates DEVC/K objects.", { type: t.type });
  }
  if (t.exists) {
    throw new AbapError(
      // No dedicated "already exists" code in AbapErrorCode; BAD_INPUT is
      // what the rest of this file uses for "not the state the request assumed".
      "BAD_INPUT",
      `Package ${t.name} already exists.`,
      { name: t.name },
      "abapsmith creates packages but does not modify existing ones.",
    );
  }
  const swcomp = opts.softwareComponent.trim().toUpperCase();
  if (!swcomp) {
    throw new AbapError(
      "BAD_INPUT",
      "`software_component` is required to create a package.",
      { name: t.name },
      PACKAGE_SOFTWARE_COMPONENT_HINT,
    );
  }
  const packageType = (opts.packageType ?? "development").trim();
  const transportLayer = opts.transportLayer ?? "";

  // createPackage creates LOCAL packages only; a non-LOCAL software_component
  // is now routed to the classrun bridge by src/tools/write.ts before
  // reaching here. This guard is defence-in-depth: CTS answers "local" for an
  // object that doesn't exist yet, so preflight can never be "transport" here.
  // Kept anyway: creates have no lock, so an unguarded POST could let SAP silently fabricate a transport request.
  const wantsTransport = swcomp !== "LOCAL";

  const preflight = await preflightCorr(conn, t, opts, "I", "write");

  if (wantsTransport && preflight?.kind !== "transport") {
    throw new AbapError(
      "TRANSPORT_ERROR",
      `${t.name} cannot be created as a transportable package on this path: \`createPackage\` (` +
        "POST /sap/bc/adt/packages) creates LOCAL packages only. A transportable package is " +
        "created by a generated classrun bridge instead (src/adt/package-create.ts), which " +
        "an `abap_write type=DEVC/K` create with a non-LOCAL software_component now reaches " +
        "directly. CTS answers \"local\" for a package that does not exist yet — there is nothing " +
        "yet for it to classify as transportable — so this guard's precondition can never be " +
        "satisfied here; it is retained only as defence-in-depth. Reaching this throw " +
        `means the router in src/tools/write.ts failed to send this software_component=${swcomp} ` +
        "create to the bridge: an internal routing failure, not something fixable by passing " +
        "different arguments to this call.",
      { name: t.name, softwareComponent: swcomp },
      "This is an internal routing defect (src/tools/write.ts did not route a non-LOCAL " +
        "software_component create to the classrun bridge) — it is not caused by, and cannot be " +
        "worked around with, any argument to this call. Report it rather than retrying.",
    );
  }

  // Same before-image shape `writeObject` sends for a not-yet-existing
  // object; `existed: false` is what `t.exists` (a real GET) just reported,
  // not a guess. Guard kept for callers not type-checked against the
  // required field (test/ is excluded from tsconfig.json).
  if (opts.onBeforeImage) {
    await opts.onBeforeImage({
      source: undefined,
      existed: false,
      sourceReadable: true,
      target: t,
      ...(preflight?.kind === "transport" ? { corrNr: preflight.corrNr } : {}),
    });
  }

  await createNewPackage(conn, t, preflight, { swcomp, packageType, transportLayer });

  // Same construction `writeObject` uses when `corr.kind === "transport"`
  // (status/required/corrNr from the gated corr), minus the corrUser/corrText
  // enrichment that only a lock response carries — there is no lock here.
  const transport: TransportInfo =
    preflight?.kind === "transport"
      ? { status: "transport", required: true, corrNr: preflight.corrNr }
      : { status: "local", required: false };

  return {
    target: t,
    created: true,
    ...(t.superPackage ? { superPackage: t.superPackage } : {}),
    softwareComponent: swcomp,
    packageType,
    transportLayer,
    transport,
  };
}

/**
 * `POST /sap/bc/adt/{collection}`.
 *
 * Response shapes are NOT uniform: PROG/CLAS/INTF answer 200 with an empty
 * body and no Location; TABL answers 201 with a Location, an etag and a
 * 2.4 KB descriptor. So there is no "was it created?" check here — the
 * library throws on failure, and the subsequent lock+PUT is the real proof.
 *
 * ## The CREATE carries the `corrNr` too (closed 2026-08-01)
 *
 * Unnumbered, this POST let SAP file the new object under a request of its
 * own choosing, colliding with the PUT's own (correct) corrNr — HTTP 500
 * "already locked in request...". Fixed via the `transport` option, which
 * the library turns into `?corrNr=` on this exact POST. `corr` is
 * `GatedCorr`, not a bare string: the number here is the same gate-judged
 * number the PUT carries, minted once in `preflightCorr`. `undefined` means
 * no transport manager is wired in (the historical $TMP-only path) — not a
 * licence to create a transportable object unnumbered; `corrForMutation`
 * refuses after the lock and rolls the create back.
 *
 * Live-measured asymmetry: a superfluous corrNr on a $TMP create does NOT
 * fail — silently ignored (200, object never appears in that request). Only
 * a malformed/unknown/non-CR corrNr gets a 403 (see the
 * `create-object-error-corrnr-*` fixtures). Full live capture with request
 * numbers: see the git history.
 */
async function createNewObject(
  conn: AbapConnection,
  t: ResolvedTarget,
  corr: GatedCorr | undefined,
  /**
   * Consulted only by the no-vendor branch, and only when the type has no
   * `create.skeleton` (see `createByXml`): a properties-shape type POSTs it
   * as the create body itself; a skeleton type sends it on the PUT instead.
   * `undefined` on every `vendor: true` path — those fill an empty skeleton
   * via the following PUT.
   */
  payload: string | undefined,
): Promise<void> {
  const cap = capabilitiesFor(t.type);
  // Defence-in-depth: `writeObject`'s own `created` gate already
  // refuses an unverified type, but that gate lives in the caller — this
  // function is the ONE place that actually sends the create POST (every
  // caller, present or future, funnels here), so a check here holds by
  // construction regardless of whether the caller remembered to gate itself.
  // `!== true`, strict, so both `false` and `"unverified"` refuse — same
  // discipline as `rollbackCreate`'s `delete` guard and the
  // `DELETABLE`/`DELETABLE_TYPES` check. DEVC/K needs no carve-out: a package
  // create never reaches this function.
  if (cap?.create?.verified !== true) {
    throw new AbapError(
      "UNSUPPORTED",
      `${t.spec.label} (${t.type}) cannot be created by abapsmith. ${TERMINAL_REFUSAL_NOTE}`,
      { type: t.type, creatable: [...VERIFIED_CREATABLE_TYPES] },
      `Creatable types are ${VERIFIED_CREATABLE_TYPES.join(", ")}. See that type's REGISTRY ` +
        "entry in src/adt/capabilities.ts for why create is refused here — either it has never " +
        "been tried live, or it was tried and did not reliably work.",
      { retryable: false }, // matches UNSUPPORTED's own default; reaffirmed for readability at the throw site
    );
  }
  if (cap?.create?.vendor === false) {
    await createByXml(conn, t, corr, payload);
    return;
  }
  // ---- Which parent, and how it is named (`CreateCapability.parent`) -------
  // Not every create is parented by a package: the vendor library parents
  // some types (e.g. FUGR/FF) by a container, and its body builder emits
  // `<adtcore:containerRef>` from these two fields — a package name there
  // produces a containerRef pointing at a package, and the create fails.
  const parent =
    cap?.create?.parent === "container"
      ? containerParent(t)
      : {
          parentName: t.packageName,
          parentPath: `/sap/bc/adt/packages/${encodeURIComponent(t.packageName.toLowerCase())}`,
        };
  try {
    await conn.adt.createObject({
      objtype: t.type as CreatableTypeIds,
      name: t.name,
      ...parent,
      description: t.description,
      // `responsible` defaults to the logged-on user inside the library.
      // Two literal shapes, never a `corrNr: undefined` — see above.
      ...(corr?.kind === "transport" ? { transport: corr.corrNr } : {}),
    });
  } catch (e) {
    throw translateAdtError(e, {
      operation: "create",
      uri: t.uri,
      name: t.name,
      type: t.type,
    });
  }
}

/**
 * The parent of a `ParentKind = "container"` create — a function GROUP, not a
 * package. Throws rather than falling back to the package: a create silently
 * parented by the wrong object is exactly the failure this switch exists to
 * prevent, and `ResolvedTarget.containerName` is populated by
 * `resolveWriteTarget` for every type whose `TypeSpec` has a `parentPath`.
 */
function containerParent(t: ResolvedTarget): { parentName: string; parentPath: string } {
  if (!t.containerName) {
    throw new AbapError(
      "BAD_INPUT",
      `${t.spec.label} ${t.name} is created inside a container object, and none was named.`,
      { name: t.name, type: t.type, uri: t.uri },
      `Pass the containing object as part of the name, e.g. "ZMY_GROUP/${t.name}", or as ` +
        "an explicit container argument. A function module cannot be created into a package.",
    );
  }
  const group = t.containerName;
  return {
    parentName: group,
    parentPath: `/sap/bc/adt/functions/groups/${encodeURIComponent(group.toLowerCase())}`,
  };
}

/** Local to this module, deliberately — see the house-idiom note on `escapeXml` in transports.ts: every module that needs one keeps its own rather than sharing an exported helper. Attribute-value escaping only; this module never builds XML text content. */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Builds a `create.skeleton` type's create-POST body from the target itself —
 * `BDEF/BDO`'s way of getting a create body when neither the vendor library
 * nor the caller's payload (ABAP source, not XML) can supply one. See
 * `SkeletonCreate` in capabilities.ts: the shape below is a raw-wire capture
 * of what the orchestrator hand-POSTed and A4H accepted (201), not something
 * this function itself has been run against a live system through.
 *
 * Attribute order/defaults mirror `abap-adt-api`'s own `createBodySimple`.
 * `$TMP`-only in practice today, but `<adtcore:packageRef>` still names
 * `t.packageName` rather than hardcoding `$TMP`, so a transportable package
 * is not silently misrouted if one ever reaches this path.
 */
function buildSkeletonXml(
  conn: AbapConnection,
  t: ResolvedTarget,
  skeleton: NonNullable<CreateCapability["skeleton"]>,
): string {
  const root = skeleton.rootName;
  // rootAttributes (e.g. XSLT/VT's trans:transformationType) splices in here,
  // right after the namespace declarations — absent for every other skeleton.
  const rootAttrs = skeleton.rootAttributes ? `${skeleton.rootAttributes} ` : "";
  return (
    `<${root} ${skeleton.namespace} xmlns:adtcore="http://www.sap.com/adt/core" ` +
    rootAttrs +
    `adtcore:description="${escapeXmlAttr(t.description)}" ` +
    `adtcore:name="${escapeXmlAttr(t.name)}" ` +
    `adtcore:type="${escapeXmlAttr(t.type)}" ` +
    `adtcore:language="EN" adtcore:masterLanguage="EN" ` +
    `adtcore:responsible="${escapeXmlAttr(conn.cfg.user)}">` +
    `<adtcore:packageRef adtcore:name="${escapeXmlAttr(t.packageName)}"/>` +
    `</${root}>`
  );
}

/**
 * `POST {collection}` — the create path for types `abap-adt-api`'s
 * `CreatableTypes` map does not contain (`TTYP/DA`, `ENQU/DL`, `BDEF/BDO`).
 * Two ways to get a body, selected by
 * `capabilitiesFor(t.type)?.create?.skeleton` — see `CreateCapability.vendor`
 * and `SkeletonCreate` in capabilities.ts:
 *
 *   - **No skeleton** — the caller's own XML, unchanged. The only thing that
 *     works for `ENQU/DL` (a skeleton POST with no primaryTable is refused,
 *     400 "Primary table name must not be empty"). `TTYP/DA` accepts either;
 *     using the full body keeps both types on one path, and the PUT that
 *     follows is then a harmless no-op repeat of the same document.
 *   - **Skeleton present** — `buildSkeletonXml` builds the body from `t`;
 *     `payload` is ignored here and goes on the following PUT instead, like
 *     a `vendor: true` source-shape create. Content-Type is
 *     `skeleton.contentType` verbatim — see that field's doc for the 406
 *     trap a `; charset=…` suffix hits on these RAP resources.
 *
 * The collection is derived from `TypeSpec.path` by dropping `/{name}`, so it
 * can't drift from the URI the rest of the module builds.
 */
async function createByXml(
  conn: AbapConnection,
  t: ResolvedTarget,
  corr: GatedCorr | undefined,
  payload: string | undefined,
): Promise<void> {
  const skeleton = capabilitiesFor(t.type)?.create?.skeleton;
  let body: string;
  let contentTypeHeader: string;
  if (skeleton) {
    body = buildSkeletonXml(conn, t, skeleton);
    contentTypeHeader = skeleton.contentType;
    // No `assertPayloadMatchesTarget` here: the body is built FROM `t`, so
    // it's self-consistent by construction — nothing external to check.
  } else {
    if (payload === undefined || payload.trim() === "") {
      throw new AbapError(
        "BAD_INPUT",
        `Creating ${t.spec.label} ${t.name} needs its complete XML descriptor as the payload.`,
        { name: t.name, type: t.type, uri: t.uri },
        "This type has no create-empty-then-fill path on ADT — the first POST must already " +
          "carry the object's content.",
      );
    }
    // The body is POSTed to a COLLECTION, so `adtcore:name` inside it is the
    // only thing deciding which object comes into existence.
    assertPayloadMatchesTarget(t, payload);
    assertDomaMasterLanguage(t, payload);
    // Last step before this becomes the POST body, so the bytes sent
    // are the bytes both asserts above just checked plus the mandatory empty
    // `<doma:fixValues/>` — see `injectEmptyFixValues`.
    body = injectEmptyFixValues(t, payload);
    // `contentType(t)`, not a bare literal: gives SRVB/SVB its
    // vendor-specific Content-Type (see PROVENANCE WARNING on its REGISTRY
    // entry) while other no-skeleton types keep the plain `application/*`
    // they always used (falls through when `mediaType` is unset).
    contentTypeHeader = contentType(t);
  }
  const collection = t.spec.path.replace(/\/\{name\}$/, "");
  if (collection === t.spec.path) {
    throw new AbapError(
      "UNSUPPORTED",
      `Cannot derive a create collection URI for ${t.type} from ${t.spec.path}.`,
      { type: t.type, path: t.spec.path },
    );
  }
  try {
    await conn.post(collection, {
      body,
      headers: { "Content-Type": contentTypeHeader },
      ...(corr?.kind === "transport" ? { qs: { corrNr: corr.corrNr } } : {}),
    });
  } catch (e) {
    throw translateAdtError(e, {
      operation: "create",
      uri: t.uri,
      name: t.name,
      type: t.type,
    });
  }
}

/**
 * `POST /sap/bc/adt/packages` for a `DEVC/K`, the sibling of `createNewObject`
 * for the one type that is create-only. Goes through the SAME
 * `conn.adt.createObject` vendor call and the SAME `translateAdtError` — no
 * parallel HTTP path for packages.
 */
async function createNewPackage(
  conn: AbapConnection,
  t: ResolvedTarget,
  corr: GatedCorr | undefined,
  pkg: { swcomp: string; packageType: string; transportLayer: string },
): Promise<void> {
  // `parentName` maps to <pak:superPackage> for DEVC/K, not a containing
  // package. "" renders an empty <pak:superPackage/>, i.e. a root package.
  const superPackage = t.superPackage ?? "";
  // KNOWN VENDOR DEFECT (abap-adt-api 8.4.1, objectcreator.js:42): the
  // DEVC/K body template hardcodes <adtcore:packageRef adtcore:name="YMU_RAP"/>
  // regardless of options. Whether SAP honours or ignores it is unverified.
  try {
    await conn.adt.createObject({
      objtype: "DEVC/K",
      name: t.name,
      parentName: superPackage,
      parentPath: "/sap/bc/adt/packages",
      description: t.description,
      swcomp: pkg.swcomp,
      packagetype: pkg.packageType,
      transportLayer: pkg.transportLayer,
      ...(corr?.kind === "transport" ? { transport: corr.corrNr } : {}),
      // `conn.adt.createObject`'s single-argument overload is typed
      // `NewObjectOptions` only, not the `| NewPackageOptions` union the
      // runtime actually accepts — cast needed for the excess properties.
    } as Parameters<typeof conn.adt.createObject>[0]);
  } catch (e) {
    throw translateAdtError(e, { operation: "create", uri: t.uri, name: t.name, type: "DEVC/K" });
  }
}

/**
 * Bring a class SUB-INCLUDE into existence — `POST {class}/includes`.
 *
 * A PUT to an absent include does NOT create it (2026-08-18 A4H finding):
 * writing to a class that never had a test class is rejected with
 * "ZCL_…================CCAU does not have any inactive version". Only CCAU
 * is ever actually missing — CCDEF/CCIMP/CCMAC exist as empty stubs from
 * class creation. `includeType` is still taken from the target rather than
 * hardcoded to `testclasses`, so a flavour where CCDEF is also absent can't
 * silently get a CCAU instead (the vendor's `createTestInclude` hardcodes it;
 * that's a narrower function, not a contract).
 *
 * The document is byte-for-byte the vendor's `createTestInclude`
 * (objectcreator.js) except `class:includeType`. `adtcore:name="dummy"` is
 * the vendor's literal, kept deliberately — the server derives the real
 * include name from the class in the URI.
 *
 * Does NOT lock (runs inside `writeObject`'s session/handle), does NOT
 * create the class (step 0a already refused an include write against an
 * absent class), and does NOT report `created: true` — an object section
 * came into existence, not the object.
 */
async function createClassInclude(
  conn: AbapConnection,
  t: ResolvedTarget,
  lockHandle: string,
  corr: GatedCorr,
): Promise<void> {
  const inc = subInclude(t);
  // Unreachable via the one call site (guarded by the same `subInclude`), and
  // spelled anyway so this can never be repurposed into creating `main`.
  if (!inc) return;
  const body =
    `<?xml version="1.0" encoding="UTF-8"?><class:abapClassInclude ` +
    `xmlns:class="http://www.sap.com/adt/oo/classes" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:name="dummy" class:includeType="${inc}"/>`;
  try {
    await conn.post(`${t.uri}/includes`, {
      body,
      headers: { "Content-Type": "application/*" },
      qs: corr.kind === "transport" ? { lockHandle, corrNr: corr.corrNr } : { lockHandle },
    });
  } catch (e) {
    // Named as its own operation, not folded into the PUT's failure
    // translation — "could not create the include" and "could not write it"
    // send the reader to different places.
    const generic = translateAdtError(e, {
      operation: `create include ${inc}`,
      uri: `${t.uri}/includes`,
      name: t.name,
      type: t.type,
    });
    throw new AbapError(
      generic.code,
      `${t.spec.label} ${t.name} has no "${inc}" include yet and this system refused to create ` +
        `one: ${generic.message}`,
      {
        name: t.name,
        type: t.type,
        uri: t.uri,
        include: inc,
        contentUri: contentUri(t),
        ...generic.details,
      },
      `Nothing was written and the lock was released. The CLASS is fine — it is the ${inc} ` +
        "include that could not be brought into existence. Create it once in Eclipse ADT or " +
        "SE24 (for test classes: the class editor's Test Classes tab) and write it again.",
    );
  }
}

/**
 * The one PUT, for both write shapes.
 *
 *  - `"source"`     — `PUT {uri}/source/main?lockHandle=…`, `text/plain; charset=utf-8`.
 *  - `"properties"` — `PUT {uri}?lockHandle=…`, `application/*`, body = the object's complete XML descriptor.
 *
 * URI, Content-Type and response interpretation are the only three things
 * that vary; lock handle, `GatedCorr` chokepoint and failure translation are
 * identical, which is why this is one function.
 *
 * Returns the server-normalised content when sent back: for source that's
 * DDIC's reformatted source (PROG/CLAS return empty; an XML body means
 * "descriptor, not source" ⇒ `undefined`). For properties the XML is exactly
 * what was asked for, returned as-is, which is what makes the returned etag
 * reproducible.
 */
async function putContent(
  conn: AbapConnection,
  t: ResolvedTarget,
  source: string,
  lockHandle: string,
  /**
   * `GatedCorr`, not `string | undefined`: built by switching on `kind` into
   * one of two literal shapes, so the forbidden combination (transportable
   * object, no number) has no representation to arrive in. The brand also
   * ensures the number was judged by the gate against the real TRKORR — see
   * `preflightCorr`.
   */
  corr: GatedCorr,
): Promise<string | undefined> {
  const properties = writeShapeOf(t.type) === "properties";
  // Second of the two enforcement points — see `assertPayloadMatchesTarget`.
  // Cheap, and it fires while the lock is held but before the mutation, so a
  // mismatched payload releases the lock without touching the object.
  if (properties) {
    assertPayloadMatchesTarget(t, source);
    assertDomaMasterLanguage(t, source);
    // Reassign `source` itself so both the PUT body below and
    // `translateWriteFailure` on a rejection see what was actually sent, not
    // what the caller passed in — see `injectEmptyFixValues`.
    source = injectEmptyFixValues(t, source);
  }
  let body: string;
  try {
    const resp = await conn.put(contentUri(t), {
      body: source,
      headers: { "Content-Type": contentType(t) },
      qs: corr.kind === "transport" ? { lockHandle, corrNr: corr.corrNr } : { lockHandle },
    });
    body = resp.body ?? "";
  } catch (e) {
    throw await translateWriteFailure(conn, e, t, source, corr);
  }
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  // The properties shape's response IS the normalised object — same
  // descriptor a subsequent GET returns, version/changedAt updated. Handing
  // it back lets `WriteResult.etag` be reproducible from a read-back.
  if (properties) return body;
  // Source shape: a returned XML document would be an object descriptor, not source.
  if (trimmed.startsWith("<")) return undefined;
  return body;
}

/**
 * A rejected DDIC source PUT reports a terse envelope with no line/column —
 * `ExceptionResourceAlreadyExists` (sic), "Can't save due to errors in
 * source; execute check for details", empty `<properties/>`. The same
 * terseness also shows up under `ExceptionResourceScanDuringSaveFailure`,
 * captured both with a useful message and with nothing but generic
 * boilerplate — the type id alone doesn't tell you which you got.
 *
 * `POST /checkruns` (`checkSource`, ./activate.ts) reliably answers with a
 * real line/column/message for exactly this situation. On a rejection that
 * looks like a swallowed syntax/content problem, this runs `checkSource`
 * inline (~80–250ms, failure path only) and reports what it finds instead of
 * the terse envelope — degrading honestly to the original message if
 * `checkSource` can't run or comes back clean.
 */
async function translateWriteFailure(
  conn: AbapConnection,
  e: unknown,
  t: ResolvedTarget,
  source: string,
  corr: WriteCorr,
): Promise<AbapError> {
  // A rejected transport number is not a rejected program, and the DDIC
  // "AlreadyExists"-means-syntax heuristic below would happily swallow it.
  const corrProblem = corrNrFailure(e, t, corr);
  if (corrProblem) return corrProblem;
  const info = adtExceptionInfo(e);
  // ---- Properties shape: the server validates the DOCUMENT, eagerly --------
  // All five properties-shape types PUT their complete XML descriptor and the
  // server validates that document, not ABAP source — no /checkruns fallback
  // (all five 404 there), so the syntax-check enrichment below never applies.
  //
  // `ExceptionInvalidData` is the confirmed common case and comes with
  // XML_PATH/XML_OFFSET naming the offending element. The SAME mistake class
  // (wrong element/attribute name, e.g. `mc:number` instead of `mc:msgno`,
  // live-captured) has also been observed as `ExceptionResourceBadRequest`
  // with no XML_PATH/XML_OFFSET at all — keying on exception type misses
  // that second shape and sends it through the generic ADT_ERROR fallback
  // with nothing for the caller to act on.
  //
  // So this is keyed on the WRITE SHAPE, not the exception type: any
  // rejection that isn't a general ADT condition (lock/stale/dead-session/404
  // — already handled by translateAdtError) is a payload problem, and this
  // is the one place that can say so honestly, with the server's own
  // coordinates when given and a concrete next step when not.
  if (writeShapeOf(t.type) === "properties") {
    const generic = translateAdtError(e, { operation: "write", uri: contentUri(t), name: t.name, type: t.type });
    // A lock conflict, stale handle, dead session or not-found has nothing
    // to do with the payload being XML — translateAdtError already
    // classified it; only an otherwise-unclassified rejection (generic
    // ADT_ERROR, not INVALID_LOCK_HANDLE) gets reinterpreted below.
    if (generic.code === "ADT_ERROR" && generic.details.reason !== "INVALID_LOCK_HANDLE") {
      const where = [info?.properties.XML_PATH, info?.properties.XML_OFFSET]
        .filter((v): v is string => typeof v === "string" && v !== "")
        .join(" @ ");
      return new AbapError(
        "BAD_INPUT",
        `The ABAP system rejected the XML for ${t.spec.label} ${t.name}: ${
          info?.message || describeUnknownError(e)
        }${where ? ` (${where})` : ""}`,
        {
          name: t.name,
          type: t.type,
          uri: t.uri,
          adtExceptionType: info?.type,
          ...(info?.properties.XML_PATH ? { xmlPath: info.properties.XML_PATH } : {}),
          ...(info?.properties.XML_OFFSET ? { xmlOffset: info.properties.XML_OFFSET } : {}),
          ...(!where ? { position: "not reported by the server for this rejection" } : {}),
        },
        where
          ? "This is a payload problem, not a source problem — there is no syntax check to " +
            "run. The element order in these descriptors is significant (a table type that " +
            "omits <ttyp:builtInType> is rejected outright, for example). The object was NOT " +
            "changed and the lock was released."
          : "This is a payload problem, not a source problem — there is no syntax check to " +
            "run, and this particular rejection came back with no element/offset position at " +
            "all (the server does not always include one for this failure class — a wrong " +
            "attribute name, e.g. mc:number instead of mc:msgno, is a confirmed live cause). " +
            "Re-read the object (abap_read) to see its current, known-good descriptor and " +
            "compare element and attribute names against what you sent, rather than retrying " +
            "the same payload unchanged. The object was NOT changed and the lock was released.",
      );
    }
    return generic;
  }
  // ---- Source shape: a 404 on a sub-include is about the INCLUDE -----------
  // The class provably exists (writeObject step 0a refuses an include write
  // against an absent class), so a not-found here means the include document
  // itself is absent. Second line of defence, not the first: since the
  // 2026-08-18 A4H probe, step 4a-ii POSTs the include into existence under
  // the lock first, so reaching here means it vanished between create and
  // PUT, or a rarer not-found the create didn't see.
  const inc = subInclude(t);
  if (inc) {
    const generic = translateAdtError(e, {
      operation: `write include ${inc}`,
      uri: contentUri(t),
      name: t.name,
      type: t.type,
    });
    if (generic.code === "NOT_FOUND") {
      return new AbapError(
        "NOT_FOUND",
        `${t.spec.label} ${t.name} exists, but its "${inc}" include does not, and this ABAP ` +
          `system did not create it on write: ${contentUri(t)}`,
        {
          name: t.name,
          type: t.type,
          uri: t.uri,
          contentUri: contentUri(t),
          include: inc,
          ...generic.details,
        },
        `The CLASS is fine — it is the ${inc} include that is missing. Create the include in ` +
          "Eclipse ADT/SE24 once (for test classes: the class editor's Test Classes tab), then " +
          "write it again. Nothing was written and the lock was released.",
      );
    }
  }

  const looksLikeSyntax =
    /execute check for details|errors in source/i.test(info?.message ?? "") ||
    (info?.type === "ExceptionResourceAlreadyExists" && info.status !== 404) ||
    info?.type === "ExceptionResourceScanDuringSaveFailure";
  if (looksLikeSyntax) {
    // Only the source shape has a /source/main resource for checkruns to
    // check — the properties shape 404s on it. `looksLikeSyntax` never fires
    // for a properties-shape rejection in practice (those come back
    // ExceptionInvalidData, handled above), but the guard stays so a future
    // exception-type addition can't send an XML descriptor to checkSource.
    //
    // A sub-include write needs nothing special: checkSource posts
    // `t.sourceUri` as the artifact and `t.uri` as the check object — check
    // this document in the context of its class, which is what a test
    // class's syntax errors need to be checked against.
    const canEnrich = writeShapeOf(t.type) === "source";
    const outcome = canEnrich ? await tryCheckSource(conn, t, source) : undefined;
    // For a wrapper-less ENHO/XHH body the checkrun reports a missing
    // REPORT/PROGRAM statement, which describes SAP's mis-parse rather than the
    // omission; it rides along in the wrapper error's details instead of standing
    // alone as the diagnosis.
    const wrapper = missingEnhancementWrapperError(
      { name: t.name, type: t.type, uri: t.uri },
      source,
      info?.message,
      outcome && outcome.messages.length > 0
        ? {
            summary: summariseMessages(outcome),
            messages: renderMessages(outcome.messages, source),
            raw: outcome.messages,
          }
        : undefined,
    );
    if (wrapper) return wrapper;
    if (outcome && outcome.messages.length > 0) {
      return new AbapError(
        "CHECK_FAILED",
        `The ABAP system rejected the source of ${targetLabel(t)}: ` +
          `${summariseMessages(outcome) || "syntax check failed"}.`,
        {
          name: t.name,
          type: t.type,
          uri: t.uri,
          adtExceptionType: info?.type,
          originalMessage: info?.message,
          summary: summariseMessages(outcome),
          messages: renderMessages(outcome.messages, source),
          raw: outcome.messages,
        },
        "Fix the reported lines and write again. The object was NOT changed and the lock was " +
          "released. (abapsmith already ran the syntax check that would explain this — no need " +
          "to run one yourself.)",
      );
    }
    return new AbapError(
      "CHECK_FAILED",
      `The ABAP system rejected the source of ${targetLabel(t)}: ${
        info?.message || describeUnknownError(e)
      }`,
      {
        name: t.name,
        type: t.type,
        uri: t.uri,
        adtExceptionType: info?.type,
        note: canEnrich
          ? outcome
            ? "abapsmith ran an automatic syntax check to explain this and it found no errors " +
              "either, despite the PUT rejection — the server is not saying why."
            : "abapsmith tried to run an automatic syntax check to explain this, but the check " +
              "itself failed to run — see checkAttemptFailed."
          : "This type has no separate source resource to check.",
        ...(canEnrich && !outcome ? { checkAttemptFailed: true } : {}),
      },
      "Run a syntax check (POST /checkruns) on this source to get the actual " +
        "line, column and message. The object was NOT changed and the lock was released.",
    );
  }
  // `operation` names the include when there is one, so an unclassified server
  // rejection reads as "write include testclasses", not "write" against a class
  // whose main body was never touched.
  return translateAdtError(e, {
    operation: inc ? `write include ${inc}` : "write",
    uri: contentUri(t),
    name: t.name,
    type: t.type,
  });
}

/**
 * `checkSource` wrapped so a transport/endpoint failure in the ENRICHMENT
 * attempt (see `translateWriteFailure`) degrades to "could not enrich"
 * instead of replacing the real PUT-rejection error with a checkruns error.
 * The object is already unlocked and unchanged by the time this runs — this
 * is purely a best-effort attempt to explain what the caller already knows
 * failed, so it must never throw.
 */
async function tryCheckSource(
  conn: AbapConnection,
  t: ResolvedTarget,
  source: string,
): Promise<CheckOutcome | undefined> {
  try {
    return await checkSource(conn, t, source);
  } catch {
    return undefined;
  }
}

export type DeleteOptions = TransportOptions & {
  /** Compare-before-delete: reject if the current content hash differs. */
  expectEtag?: string;
  /**
   * REQUIRED — see {@link BeforeImageHook} and {@link NO_JOURNAL}. A delete
   * is the one mutation abapsmith cannot repeat its way out of: without a
   * before-image the source is gone. `opts` keeps a default
   * (`{ onBeforeImage: NO_JOURNAL }`) so the two-arg call still visibly means
   * "un-journalled delete", while a three-arg call can't quietly drop the
   * hook out of an options bag.
   */
  onBeforeImage: BeforeImageHook;
  /**
   * The gate the classrun bridge judges itself with, for bridge-deletable
   * types (`DEVC/K`). Separate from `TransportOptions.gate`, which
   * exists only when a transport manager is wired. Must be the gate that
   * authorized this mutation, never a fresh or more permissive one.
   */
  bridgeGate?: SafetyGate;
};

/**
 * `lock → DELETE → (the lock is gone with the object)`.
 *
 * Unlike `writeObject`, this pays for the before-image: no compare-before-
 * write step has read the source yet, so one extra GET is the price of a
 * delete being undoable — worth paying only if the answer is trustworthy,
 * hence a *failed* read refuses the delete rather than recording
 * `undefined`. `existed` comes from `ResolvedTarget.exists` (a real GET),
 * never from whether the source read produced a string — the old code let a
 * timeout record `existedBefore: false`, after which undo plans a DELETE and
 * the source is gone for good.
 *
 * `ResolvedTarget.include` (any of the five, `main` included) is REFUSED
 * here — see the function's first statement. The lock is deliberately
 * `t.uri`, not `lockUri(t)`: this function locks to DELETE the object, so it
 * wants the object's own enqueue regardless of what `lockUri` returns for a
 * write.
 *
 * The GET is paid twice: once pre-lock (`expectEtag` refusal + recordability
 * gate), once post-lock (the before-image and returned `previousSource`,
 * taken when the object cannot move). The post-lock read failing refuses
 * the delete on every path, not only when a journal hook is present —
 * under the enqueue an unreadable source means we can't say what we're
 * about to destroy.
 *
 * `deleted` is no longer a hardcoded `true` once the DELETE promise resolves
 * — the generic branch pays for one more GET, through
 * `verifyObjectDeleted`, and a `404` there is the SUCCESS signal. A `200`
 * on that read-back does not by itself mean the delete failed (it can
 * be a stale read), so `deleted` only goes `false` when an independent
 * repository search agrees the object is still there.
 */
export async function deleteObject(
  conn: AbapConnection,
  target: AuthorizedTarget<MutatingOperation, ResolvedTarget>,
  opts: DeleteOptions = { onBeforeImage: NO_JOURNAL },
): Promise<{
  target: ResolvedTarget;
  /** `true` only when a read-back confirmed absence; `false` when two probes agree the object is still there; `"unverified"` when neither could settle it. */
  deleted: boolean | "unverified";
  /** The read-back that decided `deleted` — never the DELETE's own status. */
  verification: VerifyOutcome;
  previousSource?: string;
  /** What this delete resolved for transport — was previously discarded. */
  transport: TransportInfo;
  /**
   * Classrun-bridge transcript tags — present only for the package
   * (DEVC/K) route, where `PKG-GONE` is what backs `deleted: true`.
   */
  markers?: readonly string[];
}> {
  const t = target.target;

  // ---- `include` on a DELETE is refused outright ---------------------------
  // The only DELETE this function can issue is `DELETE /oo/classes/{name}`,
  // which destroys the WHOLE CLASS — there is no ADT verb for one include.
  // An `include` reaching here could mean "delete just the test classes"
  // (which would actually lose the whole class) or an accidental include
  // name on a real class-delete; both are catastrophic if it falls through.
  // Emptying it is not silently substituted either — that's a WRITE, a
  // different operation with its own journal/undo/transport record.
  //
  // First statement in the function, before any request, so refusal costs
  // nothing. `main` is refused too (hence `t.include`, not `subInclude(t)` —
  // the one place that distinction goes the other way): "delete the main
  // include" isn't a thing ADT can do either, and a caller who typed
  // `include: "main"` deserves the sentence below, not a silent whole-class
  // delete.
  const deleteInclude = t.include;
  if (deleteInclude !== undefined) {
    throw new AbapError(
      "UNSUPPORTED",
      `Refusing to delete ${t.spec.label} ${t.name}: you named its "${deleteInclude}" include, ` +
        "and ADT has no delete for a single class include — the only DELETE there is would " +
        `remove the entire class, its main body and all four of its local includes.`,
      {
        name: t.name,
        type: t.type,
        uri: t.uri,
        include: deleteInclude,
        operation: "delete",
        reason: "INCLUDE_NOT_DELETABLE",
      },
      `To empty the ${deleteInclude} include, WRITE it with a placeholder (e.g. a single ` +
        `comment line) — that is an ordinary write and is undoable. To delete the class ` +
        `${t.name} itself, repeat this delete WITHOUT \`include\`, so the consequence is the ` +
        "one you asked for. Nothing was locked and nothing was deleted.",
    );
  }

  if (isPackageType(t.type)) {
    // `TransportOptions.gate` only exists alongside a wired transport manager
    // (a LOCAL delete or the undo path have neither) — `bridgeGate` is the
    // classrun bridge's own, independent of that.
    const gate = opts.gate ?? opts.bridgeGate;
    if (gate === undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `Package ${t.name} cannot be deleted: opts.bridgeGate was not supplied (internal wiring bug).`,
        { type: t.type, name: t.name },
        undefined,
        { retryable: false }, // internal wiring bug at the call site, not a caller-fixable argument
      );
    }
    // The gate must refuse before any request, so the domain assertion runs
    // ahead of transport pre-flight — a refusal here costs zero network
    // requests, because the transport isn't resolved yet at this point. The
    // transport-level judgement happens at the second gate, inside the
    // bridge below, once preflightCorr has resolved the real corr; the
    // bridge also repeats this same domain assertion for its own direct callers.
    // `corr: { kind: "unresolved" }`: the real corrNr isn't known yet, so
    // without this safety.ts would default to a fabricated "auto" and judge
    // that against ABAP_ALLOW_TRANSPORTS instead of the caller's real corr
    // (a live finding). Defers the allowlist check to the second gate
    // below; the zero-network deny-all refusal still fires here regardless.
    assertBridgeMutation(
      gate,
      { type: "DEVC/K", name: t.name, packageName: t.name, exists: true },
      { activate: false, op: "delete", corr: { kind: "unresolved" } },
    );

    const preflight = await preflightCorr(conn, t, opts, "U", "delete");
    // Unlike a package CREATE, a package DELETE targets an object that
    // already exists, so CTS transportchecks can classify it and ordinary
    // preflightCorr works — no resolveForNewTransportable equivalent needed.
    const corrNr = preflight?.kind === "transport" ? preflight.corrNr : "";

    if (opts.onBeforeImage) {
      await opts.onBeforeImage({
        source: undefined,
        existed: true,
        sourceReadable: true,
        target: t,
        ...(preflight?.kind === "transport" ? { corrNr: preflight.corrNr } : {}),
      });
    }

    const bridgeRes = await deletePackageViaBridge(conn, gate, {
      packageName: t.name,
      corrNr,
      // The same "named"/"auto" preflightCorr just judged the real corrNr
      // under (carried on GatedCorr) — the bridge's own domain-object gate
      // must judge the identical corr, not a re-guessed "auto".
      ...(preflight?.kind === "transport" ? { corrSource: preflight.source } : {}),
    });

    // What this call resolved, not what the bridge recorded — see the
    // package-only honesty note in src/tools/write.ts.
    const transportInfo: TransportInfo =
      preflight === undefined
        ? notDetermined("no transport manager was wired for this delete")
        : preflight.kind === "local"
          ? { status: "local", required: false }
          : { status: "transport", required: true, corrNr: preflight.corrNr };

    // Unlike the generic branch below, this `deleted: true` needs no separate
    // read-back GET: the bridge only resolves after the generated ABAP
    // re-reads TDEVC post-COMMIT and emits PKG-GONE, so the verification
    // already happened server-side, under the same transaction as the delete.
    return {
      target: t,
      deleted: true,
      verification: { status: "confirmed-absent", uri: t.uri, via: "read-back" },
      transport: transportInfo,
      markers: bridgeRes.transcript.tags,
    };
  }

  // Etag-check/recheck baseline. Never throws, so the two failure modes
  // below can be told apart. Not what the before-image is built from — that
  // is the post-lock read inside the session.
  const read = await readCurrentSourceResult(conn, t);
  // `undefined` for a source-less object AND for a failed read — told apart
  // by `read.ok`, so a missing baseline is never mistaken for "was empty".
  const previousEtag =
    read.ok && read.source !== undefined ? canonicalEtag(read.source) : undefined;

  // ---- Compare-before-delete, BEFORE any lock is taken ------------------
  if (opts.expectEtag !== undefined) {
    if (!read.ok) {
      throw new AbapError(
        "ADT_ERROR",
        `The current source of ${t.spec.label} ${t.name} could not be read, so the etag you ` +
          `supplied could not be checked and the delete was refused: ${describeUnknownError(read.error)}`,
        {
          name: t.name,
          type: t.type,
          uri: t.uri,
          reason: "ETAG_UNVERIFIABLE",
        },
        "Nothing was locked and nothing was deleted. Retry once the object is readable again.",
      );
    }
    assertEtagMatches(t, read.source, opts.expectEtag, "delete");
  }

  // ---- Transport, pre-flight — before the journal and the lock -----------
  // A delete is an update to the object's transport-recorded state, so the
  // check runs as `"U"`. Same placement rationale as `writeObject`: a `denied`
  // resolution refuses before anything is journalled or locked.
  const preflight = await preflightCorr(conn, t, opts, "U", "delete");

  // ---- Before-image, gated here and captured later ----------------------
  // Refusal stays pre-lock (costs no enqueue); what moved is the CAPTURE —
  // the hook fires from inside the session, fed bytes re-read under the
  // lock, since the bytes read up here crossed the same GET→LOCK window
  // `writeObject` re-checks: a concurrent edit there would leave the journal
  // recording source that isn't what actually got deleted.
  let previousSource: string | undefined;
  // Set inside the session below, same hoist-then-assign as `previousSource`.
  let transportInfo: TransportInfo = notDetermined("the delete has not reached the lock yet");
  // `!== NO_JOURNAL`, not bare truthiness: a caller that typed the opt-out
  // has said it doesn't want an undo trail, so this refusal (which exists
  // solely to protect that trail) must stay off for it.
  if (opts.onBeforeImage !== NO_JOURNAL && !read.ok) {
    throw new AbapError(
      "ADT_ERROR",
      `The current source of ${t.spec.label} ${t.name} could not be read, so the delete was ` +
        `refused: it would not be undoable. Underlying failure: ${describeUnknownError(read.error)}`,
      {
        name: t.name,
        type: t.type,
        uri: t.uri,
        reason: "BEFORE_IMAGE_UNAVAILABLE",
      },
      "A delete is only reversible through the before-image the journal records, and that " +
        "image could not be captured. Nothing was locked and nothing was deleted — retry " +
        "once the object reads cleanly.",
    );
  }

  await conn.withStatefulSession(async (session) => {
    const lock = await session.lock(t.uri);

    // ---- Post-lock recheck, then the before-image -------------------------
    // Same reasoning as `writeObject` step 4a, same shape: the enqueue is the
    // first moment the object can't move under us, so the recorded before-image
    // and the enforced etag both come from here, not the pre-lock read. Runs
    // before the transport refusal below so a refused delete still leaves a
    // journal entry and no object removed.
    //
    // Also doubles as the session-expiry detector (an expired session hands
    // back its enqueues silently — no error at lock time; live-captured
    // 2026-08-02, see the git history). That's
    // `SESSION_DEAD`, not an etag mismatch or unreadable object.
    const fresh = await readCurrentSourceResult(conn, t);
    if (!fresh.ok) {
      // Unlike `writeObject`'s `readCurrentSource`, this reader never throws — a
      // timeout, a 500 AND a dead session all arrive here as `{ ok: false }`. So
      // translate before judging, or the one failure that has its own remedy gets
      // re-badged as "the object was unreadable".
      const err = translateAdtError(fresh.error, {
        operation: "delete",
        uri: t.sourceUri,
        name: t.name,
        type: t.type,
      });
      if (err.code === "SESSION_DEAD") {
        // Rethrown unchanged — "reconnect", not a refusal about an object that
        // reads fine elsewhere. No UNLOCK first: the handle died with the
        // session (UNLOCK on it also answers 400), so drop the ledger entry
        // instead and spare `withStatefulSession`'s finally a dead request.
        session.forgetLock(t.uri);
        throw err;
      }
      // Everything else: unreadable while the enqueue is held, so we can't
      // confirm this is the object read or record what's about to be
      // destroyed. Release and refuse — pre-lock twin of this refusal is above.
      await session.unlock(t.uri);
      throw new AbapError(
        "ADT_ERROR",
        `The current source of ${t.spec.label} ${t.name} could not be read after the lock was ` +
          `taken, so the delete was refused: ${describeUnknownError(fresh.error)}`,
        {
          name: t.name,
          type: t.type,
          uri: t.uri,
          reason: "ETAG_UNVERIFIABLE",
          phase: "post-lock",
        },
        "The lock was released and nothing was deleted. Retry once the object is readable " +
          "again.",
      );
    }
    const actualEtag = fresh.source === undefined ? null : canonicalEtag(fresh.source);
    const actualEtagRaw = fresh.source === undefined ? null : contentHash(fresh.source);
    // `read.ok` guards the comparison, not the re-read: a failed pre-lock read
    // leaves no baseline, which must not read as "was empty, now isn't". That
    // case only reaches here with no `expectEtag` and no journal hook.
    if (read.ok && actualEtag !== (previousEtag ?? null)) {
      await session.unlock(t.uri);
      throw new AbapError(
        "ETAG_CONFLICT",
        `${t.spec.label} ${t.name} changed between the pre-delete read and the lock.`,
        {
          name: t.name,
          type: t.type,
          uri: t.uri,
          operation: "delete",
          phase: "post-lock",
          expectedEtag: previousEtag ?? null,
          actualEtag,
          /** The un-canonicalised hash, i.e. what `abap_read` would hand out. */
          actualEtagRaw,
        },
        "The object changed between the pre-delete read and the lock. Re-read it, confirm it " +
          "is still the one you meant to delete, and delete again with the fresh etag. " +
          "Nothing was deleted; the lock was released.",
      );
    }
    // What undo restores, as it stands under the enqueue.
    previousSource = fresh.source;
    // Field is required at the type level; this guard is for callers not
    // type-checked against it (test/ is excluded from tsconfig.json).
    // `NO_JOURNAL` is a no-op, so calling it is harmless.
    if (opts.onBeforeImage) {
      // A source-less object still gets an entry: `existed` records what the
      // GET actually saw. If the hook throws, we're still holding the lock;
      // `withStatefulSession`'s finally releases it and the DELETE never runs.
      await opts.onBeforeImage({
        source: previousSource,
        existed: t.exists,
        sourceReadable: true,
        target: t,
        ...(preflight?.kind === "transport" ? { corrNr: preflight.corrNr } : {}),
      });
    }

    const transport = transportFromLock(lock);
    transportInfo = transport;
    const corr = corrForMutation(preflight, transport);
    if (corr === undefined) {
      // Same refusal as in writeObject — see `corrForMutation`. A DELETE with
      // no `corrNr` is the same silent-fabrication hazard as a PUT with none.
      await session.unlock(t.uri);
      throw transportRefusal(t, transport, "deleted", opts.transport !== undefined);
    }
    try {
      // `DELETE {uri}?lockHandle=…`, stateful. `corrNr` emitted only when
      // present — two literal shapes, not a spread of an optional field
      // (see `WriteCorr`). 1.4-5.9s.
      await conn.del(t.uri, {
        qs:
          corr.kind === "transport"
            ? { lockHandle: lock.handle, corrNr: corr.corrNr }
            : { lockHandle: lock.handle },
      });
    } catch (e) {
      const err =
        corrNrFailure(e, t, corr) ??
        translateAdtError(e, {
          operation: "delete",
          uri: t.uri,
          name: t.name,
          type: t.type,
        });
      noteTransportDead(opts.transport, corr, err);
      throw err;
    }
    // The object is gone and so is its enqueue: an UNLOCK now would just be a
    // wasted request against a 404. Deleting a class takes its includes with it.
    session.forgetLock(t.uri);
  });

  // The DELETE resolving is not evidence by itself — a read-back
  // decides `deleted`. Never throws (see `verifyObjectDeleted`'s own
  // never-throws contract): the DELETE already reached the server by this
  // point, so a verification failure degrades to `"unverified"` rather than
  // turning a completed delete into a thrown error. Each of the three
  // callers (undo, the batch delete path, the single-object tool) decides
  // for itself what a `false`/`"unverified"` result means; `deleteObject`
  // does not pick for them.
  let verification = await verifyObjectDeleted(conn, {
    uri: contentUri(t),
    accept: contentAccept(t),
    objectName: t.name,
    expectType: t.type,
  });
  let deleted: boolean | "unverified" =
    verification.status === "confirmed-absent"
      ? true
      : verification.status === "confirmed"
        ? false
        : "unverified";

  // Evidence guard: a `confirmed-absent` read-back only proves the DELETE did
  // something if the object was READABLE before the DELETE ran. When the
  // pre-delete read produced no content document at all (`previousSource ===
  // undefined`, see `readCurrentSourceResult`), the content URI may never have
  // resolved for this object in the first place — a 404 afterwards is then
  // consistent with "always 404'd" just as much as with "was deleted", so it
  // is not evidence either way. This does NOT touch the `confirmed`
  // (still-present) case: two probes agreeing the object is still there stays
  // `deleted: false` regardless of the before-image.
  if (verification.status === "confirmed-absent" && verification.via === "read-back" && previousSource === undefined) {
    deleted = "unverified";
    verification = {
      status: "indeterminate",
      uri: verification.uri,
      reason:
        `The post-delete read-back of ${t.spec.label} ${t.name} answered 404, but the object ` +
        "was not readable before the DELETE either (no content document could be read " +
        "pre-delete), so its absence afterwards is not evidence — the content URI may never " +
        "have resolved for this object. Treated as unverified rather than confirmed.",
    };
  }

  return { target: t, deleted, verification, previousSource, transport: transportInfo };
}
