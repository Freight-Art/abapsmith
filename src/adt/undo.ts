/**
 * Undo — restore an object to a previous version. It is an ordinary write
 * carrying old text through the same lock → PUT → unlock → activate recipe,
 * the same safety gate, and it is itself journalled.
 *
 * The important part is the REFUSAL, not the restore: every undo re-reads
 * the server first and proves the object is still in the state we left it,
 * because silently overwriting a colleague's later edit is worse than no
 * undo at all.
 *
 * Drift is decided from a content fingerprint, not the server etag: ADT
 * metadata and source carry different etags; the source etag moves on
 * activation with no source change; and the server normalises line endings
 * so raw bytes never round-trip. The fingerprint mirrors `sourceEquals()`.
 * The server etag is still captured, as corroborating evidence only. See
 * the git history for the full original rationale.
 */
import { contentHash } from "../compact.js";
import type { BeforeImageCapture, Journal, JournalEntry } from "../journal.js";
import { journalRef, sourceFingerprint, systemKey, withJournalledMutation } from "../journal.js";
import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import { activateObject, checkSource, type ActivationOutcome, type CheckOutcome } from "./activate.js";
import type { SafetyGate } from "../safety.js";
import { isNotFoundError } from "./session.js";
import { CLASS_INCLUDES, specFromUri, specForType, type ClassInclude, type TypeSpec } from "./types.js";
import {
  canonicalEtag,
  contentAccept,
  contentUri,
  deleteObject,
  isPackageType,
  readCurrentSource,
  resolveWriteTarget,
  writeObject,
  type AuthorizedTarget,
  type BeforeImage,
  type BeforeImageHook,
  type MutatingOperation,
  type ResolvedTarget,
} from "./write.js";
import {
  verifyViaRepositorySearch,
  verifyViaVitBridge,
  verifyObjectDeleted,
  vitBridgeUri,
  VIT_STUB_ACCEPT,
  type VerifyOutcome,
} from "./write-verify.js";
import { isBridgeOnlyCreateType } from "./capabilities.js";
import { serverPackage } from "./resolved-package.js";
import { deleteClassicViewViaBridge } from "./view-delete.js";
import { deleteTransactionViaBridge } from "./tran-delete.js";

/**
 * Renders a {@link VerifyOutcome} for a human sentence — the uri plus
 * whichever of `via`/`reason` the outcome carries (mutually exclusive on the
 * type). Used only for the undo-of-delete's `false`/`"unverified"` messages
 * below — `deleteObject`'s own `verifyObjectDeleted` never throws, so
 * this module is the one place that turns its outcome into prose.
 */
function describeDeleteVerification(v: VerifyOutcome): string {
  const detail = v.status === "indeterminate" ? v.reason : `via ${v.via}`;
  return `${v.uri} (${detail})`;
}

/** What undoing this entry would actually do to the server. */
export type UndoAction =
  /** The journal says we created it ⇒ undo is a delete. */
  | "delete"
  /** We changed existing source ⇒ put the before-image back. */
  | "restore"
  /** We deleted it ⇒ create it again from the before-image. */
  | "recreate"
  /** Server already matches the before-image; there is nothing to do. */
  | "noop";

export interface DriftReport {
  drifted: boolean;
  /** Human-readable, and specific: *what* changed, not "something changed". */
  reason: string;
  expectedFingerprint?: string;
  actualFingerprint?: string;
  expectedEtag?: string;
  actualEtag?: string;
  /** Server etag now vs. at journal time. Corroborating only — see the header. */
  serverEtagAtWrite?: string;
  serverEtagNow?: string;
}

/**
 * What an undo would leave behind that it cannot put back. Populated for
 * classes: undo only ever touches `/oo/classes/{name}/source/main`, so
 * CCDEF/CCIMP/CCMAC/CCAU are never captured or restored — this exists so a
 * restore that silently dropped a class's unit tests is never reported as
 * plain "success".
 */
export interface PartialRestore {
  /** ADT include names that are NOT covered by this undo. */
  unrestored: string[];
  reason: string;
}

export interface UndoPlan {
  entry: JournalEntry;
  target: ResolvedTarget;
  action: UndoAction;
  /** False ⇒ `blocker` says why, and no network call beyond the state probe. */
  undoable: boolean;
  blocker?: string;
  /**
   * Whether `force=true` may override THIS blocker. Only true for the
   * partial-class-restore refusal — force overrides drift, it never
   * manufactures evidence (missing before-image, missing delete-evidence,
   * wrong system) that was never recorded.
   */
  blockerForceable?: boolean;
  /** Set when the undo cannot cover the whole object. See {@link PartialRestore}. */
  partial?: PartialRestore;
  drift: DriftReport;
  /** Source that would be written back (`restore` / `recreate`). */
  restoreSource?: string;
  /** What is on the server right now. */
  currentSource?: string;
  currentlyExists: boolean;
  /**
   * Set when `entry.corrNr` names a transport that has since been RELEASED.
   * Undoing is still allowed but is only HALF an undo — the released
   * transport already carries the original change and nothing here pulls it
   * back out. Advisory only; never blocks.
   */
  releasedTransportWarning?: string;
  /**
   * Raw VIT-bridge read from planning time, kept only for VIEW/DV and TRAN/T
   * undo. Lets `performUndo` derive a `ServerPackage` without a second round
   * trip and without trusting the journal's stored package name.
   */
  bridgeCreateVerify?: VerifyOutcome;
}

export interface UndoResult {
  plan: UndoPlan;
  /**
   * The journal entry recorded FOR the undo itself. `undefined` means the
   * journal is disabled, so this undo cannot itself be undone — never a
   * fabricated placeholder id.
   */
  undoEntryId?: string;
  /** Carried up from the plan when the undo covered only part of the object. */
  partial?: PartialRestore;
  performed: boolean;
  /**
   * Syntax check of the before-image, run BEFORE restoring it.
   *
   * Advisory only — never blocks the undo. Restoring a known-bad state to
   * fix it forward is a legitimate workflow; only drift blocks by default,
   * because that protects somebody ELSE's work.
   */
  check?: CheckOutcome;
  /**
   * Why `check` is absent, when it is — distinguishes "check=false" from "the
   * check silently failed" so a reader never mistakes swallowed failure for a
   * clean bill of health. Absent when `check` ran, or the undo was a delete.
   */
  checkUnavailable?: string;
  /**
   * Set only when an undo-of-create issued the DELETE, it was accepted, and
   * `deleteObject`'s post-delete verification could not settle either
   * way — carries a sentence built from `res.verification` explaining why. The
   * undo still settles `succeeded` and `entry` is still marked undone (the
   * DELETE did land and is durable); this is the caller's signal that
   * abapsmith cannot itself confirm the object is gone. Absent when `plan.action`
   * was not `"delete"`, or when the delete verified cleanly either way.
   */
  deleteUnverified?: string;
  activation?: ActivationOutcome;
  forced: boolean;
}

/**
 * The three ADT enhancement-framework types (BAdI implementation, source
 * plug-in, enhancement spot). Kept as undo.ts's own set rather than derived
 * from `src/adt/types.ts` because "is this an enhancement, as a category" is
 * a question only this module asks.
 */
const ENHANCEMENT_TYPES: ReadonlySet<string> = new Set(["ENHO/XH", "ENHO/XHH", "ENHS/XS"]);

function isEnhancementType(type: string): boolean {
  return ENHANCEMENT_TYPES.has(type);
}

/**
 * The enhancement half of {@link undoBlocker}, factored out so a zero-network
 * preflight (before the full {@link JournalEntry} is loaded) can produce the
 * same wording `undoBlocker()` would reach for the same object.
 *
 * `op` is `"delete"` for undo-of-create, `"write"` otherwise. `undefined` iff
 * `type` is not one of the three enhancement types — every enhancement type
 * gets a message; undo of one is unconditional and not forceable.
 */
export function enhancementUndoBlocked(type: string, op: "write" | "delete", name: string): string | undefined {
  if (!isEnhancementType(type)) return undefined;
  if (op === "delete" && type === "ENHO/XH") {
    return (
      `Undoing this entry would DELETE the BAdI implementation ${name} ` +
      "(undo-of-create). abapsmith has no local record of whether this implementation is " +
      "currently active — the journal does not carry `enho:isActive`, and this refusal is " +
      "decided without spending a request to go find out, like every other refusal here. If " +
      "it IS active, something may already depend on the behaviour it adds, and deleting it " +
      "would silently switch that off with no error and no log — a source restore is the " +
      "wrong tool to express \"deactivate\" regardless. This is refused even when the " +
      "implementation turns out to be inactive: see the general enhancement-undo refusal for " +
      "why deleting ANY enhancement object was found to be unsafe on the live A4H session. " +
      "There is no override. Remove it deliberately through the ABAP enhancement " +
      `UI (SE19) with ${name}'s current activation state in view.`
    );
  }
  return (
    `Undo of enhancement objects is refused outright — ${type} ` +
    `${name} will not be touched. Three things the live A4H session found make ` +
    "this unsafe even in principle, not merely as a policy choice: a create attempt the " +
    "server cleanly REFUSED still left a permanently undeletable phantom object behind " +
    '("ExceptionResourceDeletionFailure ... cannot be created without a package", no ' +
    "TADIR entry, unreadable via the ABAP API either); a delete the server reported as " +
    "succeeded (ADT 200) still left TADIR and E071 rows behind indefinitely, so a 404 " +
    "afterwards is never proof of removal; and on a landscape with `tp` misconfigured, " +
    "a transportable create could not be deleted through ADT at all — the request and the " +
    "package were both permanently stuck. Given that, \"undo\" for an enhancement — " +
    "recreating one that was deleted, or deleting one that was created — is not an operation " +
    "abapsmith can perform and then trust the result of. Reverse this deliberately through the " +
    "ABAP enhancement UI (SE18/SE19/SE80), with the residue risk above in view."
  );
}

/**
 * `activate` entries can't be reversed by writing source (no "deactivate" in
 * ADT). Enhancement-type entries are refused outright and unconditionally,
 * with two messages: undo-of-create against a BAdI implementation
 * (`ENHO/XH`) warns it may be active — `enho:isActive` on the `enhoxh`
 * document is a plain boolean (`isActive="true"/"false"`, not the ABAP `"X"`
 * flag; see `BadiImplementationEntryRead.isActive` in enhancement-xml.ts) but
 * the journal never records it, so this treats "unknown" as "could be
 * active". Every other enhancement undo gets the general reason: a live A4H
 * session found create-refused objects can leave undeletable phantoms,
 * "successful" deletes can leave TADIR/E071 residue, and a misconfigured
 * `tp` can strand a transportable create with no delete path at all.
 * NOT FORCEABLE — no flag manufactures the missing activity/residue
 * evidence. Full original rationale: the git history.
 */
/**
 * Which class sub-include a journal entry's WRITE actually addressed,
 * or `undefined` for `main`/everything else.
 *
 * Read off `entry.object.sourceUri` via `specFromUri` (the same parser
 * `abap_read` uses) rather than a second regex that could disagree with it.
 * Entries from before include-tracking was added all say `.../source/main`, which is why `main`
 * deliberately answers `undefined` — that is what undo has always replayed
 * correctly.
 */
function entryClassInclude(entry: JournalEntry): ClassInclude | undefined {
  const uri = entry.object.sourceUri;
  if (uri === undefined) return undefined;
  const inc = specFromUri(uri)?.include;
  return inc !== undefined && inc !== "main" ? inc : undefined;
}

/**
 * Closes a hole opened when class sub-includes (CCDEF/CCIMP/
 * CCMAC/CCAU) became writable: before that, no journal entry could carry a before-image
 * of one. Undo always replays a before-image through `/source/main` — so
 * without this check, undoing a CCAU write would write test-class source OVER
 * the class body and report it as a successful undo.
 *
 * Refuses only when the recorded `sourceUri` names a non-`main` include, so
 * every entry from before include-tracking and every `main` write is unaffected. Re-derives the
 * include structurally from `sourceUri` rather than trusting
 * `BeforeImage.include` (`src/adt/write.ts`) directly, so it also covers
 * producers that forget to set that field — but a future include-aware undo
 * should make `BeforeImage.include` the authority and keep this as a
 * cross-check. Include-aware undo is a known follow-up; untested
 * against a live system when written. Full rationale:
 * the git history.
 */
function classIncludeBlocker(entry: JournalEntry): string | undefined {
  const include = entryClassInclude(entry);
  if (!include) return undefined;
  return (
    `This entry records a write to the ${include} include of class ${entry.object.name} ` +
    `(${entry.object.sourceUri}), not to the class's main source. abapsmith restores a ` +
    "before-image through the ordinary write path, which addresses /source/main — so " +
    `replaying this entry would write ${entry.object.name}'s ${include} include OVER its ` +
    "class body, destroying the real source and reporting it as a successful undo. " +
    "That is refused rather than attempted. " +
    "Nothing was changed. Restore the include by hand: read the recorded before-image " +
    "(abap_journal mode=show), then write it back with abap_write using " +
    `include="${include}". Include-aware undo is a known follow-up, not yet implemented.`
  );
}

function undoBlocker(entry: JournalEntry): string | undefined {
  // Checked first: a released transport is the one place a regression here
  // would be unrecoverable.
  if (entry.operation === "transport-release") {
    return "a released transport cannot be recalled; create a corrective transport instead";
  }
  if (entry.operation.startsWith("transport-")) {
    return "transport requests are not undone automatically; use abap_transport to reverse this manually";
  }
  if (entry.operation === "activate") {
    // The WRITE entry carries the before-image; inventing one here would be
    // a different operation wearing undo's name.
    return (
      "This entry records an activation, not a source change. ADT has no " +
      "deactivate operation, so there is nothing to reverse. Undo the WRITE " +
      "entry for this object instead (abap_journal mode=list object=…)."
    );
  }
  if (entry.outcome === "pending") {
    return (
      "This entry is still `pending` — the server outcome was never recorded, " +
      "which usually means the process died mid-write. The before-image is " +
      "intact, but abapsmith cannot tell whether the write landed. Read the " +
      "object first (abap_read) and compare it with the recorded images " +
      "(abap_journal mode=show), then undo with force=true if you are sure."
    );
  }
  if (isEnhancementType(entry.object.type)) {
    // Guaranteed defined here: isEnhancementType() just confirmed this type
    // is one of the three.
    return enhancementUndoBlocked(
      entry.object.type,
      plannedAction(entry) === "delete" ? "delete" : "write",
      entry.object.name,
    );
  }
  // Catch-all, checked LAST: irreversible entries with no bespoke branch
  // above (`abap_ui` press, BOPF writes). `DEVC/K` create came
  // off this list: package delete now has a real undo mechanism.
  if (entry.irreversible) {
    return (
      "This entry is marked irreversible — recorded for history only. No mechanism " +
      "can undo it, not even with force=true."
    );
  }
  return undefined;
}

/**
 * How each provenance value fails to be evidence of absence. One sentence each,
 * because "beforeCapture=failed" on its own tells a reader nothing.
 */
function captureExplanation(capture: BeforeImageCapture): string {
  switch (capture) {
    case "failed":
      return (
        "The before-image probe did not yield usable evidence — it may never have " +
        "completed (timeout, 401, 403, 500 …), or it may have answered without " +
        "confirming absence — so `existedBefore: false` is a GUESS, not an observation " +
        "of an absent object."
      );
    case "unknown":
      return (
        "The entry does not record how `existedBefore` was established — it predates " +
        "provenance recording, or the recorded value was not one abapsmith understands. " +
        "Either way nothing here proves the object was absent."
      );
    case "captured":
      return (
        "The entry claims BOTH that the previous source was captured and that the object " +
        "did not exist. Those cannot both be true, so the entry contradicts itself and " +
        "none of it can be trusted to authorise a delete."
      );
    case "confirmed-absent":
      return "The absence was positively confirmed.";
  }
}

/**
 * FIX E1 — the delete gate. `existedBefore: false` means either a confirmed
 * 404 or a before-image read that merely blew up — only the recorded
 * provenance tells them apart, so only `beforeCapture === "confirmed-absent"`
 * authorises a delete. NOT FORCEABLE: `force` overrides drift, a deliberate
 * decision with both versions in view; there is no equivalent decision here
 * since the evidence was simply never captured.
 */
export function deleteEvidenceBlocker(entry: JournalEntry): string | undefined {
  // Undoing a delete is a recreate; undoing a change to an object that existed
  // is a restore. Neither removes anything.
  if (entry.operation === "delete" || entry.existedBefore) return undefined;
  if (entry.beforeCapture === "confirmed-absent") return undefined;

  const name = entry.object.name;
  return (
    `Undoing this entry would DELETE ${name} from the server, and the journal does not ` +
    `have positive evidence that ${name} was absent before abapsmith wrote it. The ` +
    `recorded provenance is beforeCapture="${entry.beforeCapture}"; only ` +
    `"confirmed-absent" is positive evidence. ${captureExplanation(entry.beforeCapture)} ` +
    `${name} may well have existed, in which case this undo would destroy source that ` +
    `abapsmith never recorded and therefore cannot put back. ` +
    "This refusal cannot be overridden — force=true overrides DRIFT, it does not " +
    "manufacture evidence that was never captured. " +
    `If you have read ${name} (abap_read) and you do want it gone, delete it ` +
    "deliberately with abap_write mode=delete, which records a real before-image first."
  );
}

/** The live system's identity, as seen from the connection (not from the entry). */
interface LiveSystem {
  key: string;
  sid: string;
  journalSystem: string;
}

function liveSystem(conn: AbapConnection, journal: Journal): LiveSystem {
  return {
    key: systemKey({ sid: conn.cfg.sid, url: conn.cfg.url, client: conn.cfg.client }),
    sid: conn.cfg.sid,
    journalSystem: journal.system,
  };
}

/**
 * FIX E3 — refuse to replay an entry against a system it was not recorded on.
 * `JournalEntry.system` (from `ABAP_SID`) can collide across boxes, so
 * `systemKey()` (SID + origin + client) is the real identity, compared when
 * the entry carries one. A missing `systemKey` (pre-dates the field) falls
 * back to the weaker SID-only comparison, and says so in the message.
 * NOT FORCEABLE — this is the wrong object, not a judgement call.
 */
export function systemMismatchBlocker(entry: JournalEntry, live: LiveSystem): string | undefined {
  if (entry.systemKey) {
    if (entry.systemKey === live.key) return undefined;
    return (
      `This journal entry was recorded against a DIFFERENT system. Recorded: ` +
      `${entry.systemKey} (SID+host+client). Connected: ${live.key}. Replaying it here ` +
      `would write ${entry.object.name}'s source from one system onto another system's ` +
      "object — the names match, the objects do not. Point abapsmith at the system the " +
      "entry came from (ABAP_URL / ABAP_CLIENT / ABAP_SID) and undo it there. " +
      "This refusal cannot be overridden."
    );
  }

  const recorded = entry.system?.trim().toUpperCase() ?? "";
  const connected = live.sid.trim().toUpperCase();
  if (recorded === connected) return undefined;
  return (
    `This journal entry was recorded on SID ${entry.system || "(none)"} but abapsmith is ` +
    `connected to SID ${live.sid} (journal directory's system: ${live.journalSystem}). ` +
    "The entry predates system-key recording, so this is the WEAKER, SID-only check — " +
    "it cannot even tell two hosts apart that share a SID, and it still says these are " +
    "not the same system. Replaying the entry here would write one system's source onto " +
    "another's object. This refusal cannot be overridden."
  );
}

/**
 * FIX E4 — a class is more than `/source/main`. ADT splits a global class
 * over five includes; undo only ever touches `main`, so a recreate comes
 * back without local helpers/unit tests, and a restore leaves drift in the
 * other four invisible.
 */
const CLASS_SUB_INCLUDES: string[] = CLASS_INCLUDES.filter((i) => i !== "main");

/** ADT include name → the CC* name the same thing has in SE24/SE80. */
const INCLUDE_LABELS: Record<string, string> = {
  definitions: "definitions (CCDEF — local class/type definitions)",
  implementations: "implementations (CCIMP — local class implementations)",
  macros: "macros (CCMAC)",
  testclasses: "testclasses (CCAU — local test classes)",
};

const describeIncludes = (): string => CLASS_SUB_INCLUDES.map((i) => INCLUDE_LABELS[i] ?? i).join(", ");

function isClassEntry(entry: JournalEntry): boolean {
  return specForType(entry.object.type)?.kind === "CLAS";
}

/** Non-undefined exactly when `action` writes source to a class. */
function partialClassRestore(entry: JournalEntry, action: UndoAction): PartialRestore | undefined {
  if (action !== "restore" && action !== "recreate") return undefined;
  if (!isClassEntry(entry)) return undefined;
  return {
    unrestored: [...CLASS_SUB_INCLUDES],
    reason:
      action === "recreate"
        ? `Only the main include of class ${entry.object.name} was ever recorded, so only ` +
          `the main include is recreated. NOT restored: ${describeIncludes()}. The class ` +
          "that comes back is not the class that was deleted."
        : `Only the main include of class ${entry.object.name} is covered by this undo. ` +
          `Its ${describeIncludes()} were never recorded, are not restored, and are not ` +
          "checked for drift — changes made there by anybody are invisible to abapsmith.",
  };
}

function classRecreateBlocker(entry: JournalEntry, partial: PartialRestore): string {
  return (
    `${entry.object.name} is a CLASS, and abapsmith only ever recorded its MAIN include ` +
    "(/oo/classes/…/source/main). Recreating it from the journal would produce a class " +
    "that LOOKS intact and is not: its " +
    describeIncludes() +
    " were never captured and would come back EMPTY — every local helper and every unit " +
    `test the deleted class had would be silently missing. Unrestored includes: ` +
    `${partial.unrestored.join(", ")}. ` +
    "If a main-include-only restore is genuinely what you want, repeat with force=true; " +
    "the result will be reported as PARTIAL and you will have to put the local and test " +
    "includes back by hand."
  );
}

/**
 * `restore`/`recreate`/`delete` — what undoing this entry would DO to the
 * server, decided purely from the recorded entry.
 *
 * A description, not an authorisation: it still answers "delete" for an
 * entry whose `existedBefore: false` came from a failed read, deliberately —
 * softening it would make the safety gate check mere write permission for a
 * delete-shaped undo. The actual refusal lives in
 * {@link deleteEvidenceBlocker}, enforced again right before `deleteObject()`.
 */
export function plannedAction(entry: JournalEntry): UndoAction {
  if (entry.operation === "delete") return "recreate";
  // THE decisive field. `create` vs `update` is a label; `existedBefore` is the
  // fact, and it is what says whether undo restores text or removes an object.
  if (!entry.existedBefore) return "delete";
  return "restore";
}

/**
 * A `ResolvedTarget` built from the journal entry alone, for refusals
 * decided before anything is resolved — costs zero requests. `exists: false`
 * is not a server claim; the plan it appears in always carries
 * `undoable: false`, so nothing acts on it.
 *
 * CALL-SITE DISCIPLINE — load-bearing: `packageSource: "requested"` is a lie
 * of convenience, safe only because this value never reaches a write path.
 * `ensureResolved` (src/adt/write.ts) accepts anything structurally
 * resolved-looking and would happily skip the real package-check
 * (SAFETY_DENIED/PACKAGE_UNKNOWN) on this object. Never make this reachable
 * from an `undoable: true` plan, or pass its result to `writeObject`/
 * `deleteObject` — resolve for real instead.
 *
 * THROWS for the three enhancement types rather than fabricating a
 * `/source/main` sourceUri known to 404 for them (`ENHO/XH`, `ENHS/XS` have
 * no `/source/main` on this release). Every real caller must already have
 * refused via `undoBlocker` before reaching here; use
 * `refusedEnhancementTarget()` for an already-blocked enhancement entry.
 * Full rationale: the git history.
 */
export function targetFromEntry(entry: JournalEntry): ResolvedTarget {
  if (isEnhancementType(entry.object.type)) {
    throw new AbapError(
      "BAD_INPUT",
      `targetFromEntry refuses to build an undo target for ${entry.object.type} ` +
        `${entry.object.name}. This function's fallback guesses a /source/main sourceUri ` +
        "when the entry does not carry one, and that guess is wrong for enhancement objects " +
        "on this release — undo of an enhancement entry must already be refused before a " +
        "target is needed at all (see undoBlocker).",
      { type: entry.object.type, name: entry.object.name },
      "This is an internal invariant, not a user-facing refusal — reaching it means a caller " +
        "is using targetFromEntry outside planUndo's refused-plan path. Use " +
        "refusedEnhancementTarget() for an already-blocked enhancement entry instead.",
      { retryable: false }, // internal invariant violation, not a caller-fixable argument
    );
  }
  const spec: TypeSpec = specForType(entry.object.type) ?? {
    type: entry.object.type,
    kind: entry.object.type,
    label: entry.object.type,
    path: entry.object.uri,
    mode: "source",
    supportsSource: entry.object.sourceUri !== undefined,
    keywords: [],
  };
  return {
    spec,
    type: entry.object.type,
    name: entry.object.name,
    uri: entry.object.uri,
    sourceUri: entry.object.sourceUri ?? `${entry.object.uri}/source/main`,
    packageName: entry.object.package,
    description: entry.object.description ?? "",
    exists: false,
    packageSource: "requested",
  };
}

/**
 * The `target` field for an ALREADY-REFUSED enhancement `UndoPlan` — zero
 * requests, like every other structural blocker. Unlike `targetFromEntry`,
 * does not guess a `/source/main` sourceUri: uses the entry's own recorded
 * `uri` verbatim, since `spec.supportsSource` already says nothing should
 * ever PUT source to it.
 */
function refusedEnhancementTarget(entry: JournalEntry): ResolvedTarget {
  const spec = specForType(entry.object.type);
  if (!spec) {
    // Unreachable unless ENHANCEMENT_TYPES and the types.ts registry drift
    // apart. Hard failure rather than a silent synthetic spec — this module
    // never fabricates.
    throw new AbapError(
      "BAD_INPUT",
      `enhancement type ${entry.object.type} has no TypeSpec in src/adt/types.ts — ` +
        "ENHANCEMENT_TYPES in undo.ts and the registry have gone out of sync.",
      { type: entry.object.type },
      "Add the missing TypeSpec row, or remove the type from undo.ts's ENHANCEMENT_TYPES.",
    );
  }
  return {
    spec,
    type: entry.object.type,
    name: entry.object.name,
    uri: entry.object.uri,
    sourceUri: entry.object.sourceUri ?? entry.object.uri,
    packageName: entry.object.package,
    description: entry.object.description ?? "",
    exists: false,
    packageSource: "requested",
  };
}

/**
 * What a live read of the object found — the "actual" side of every drift
 * comparison. `exists` is a separate field because `source` is absent both
 * when the object is gone and when it exists with no source document.
 */
export interface ProbeResult {
  source?: string;
  serverEtag?: string;
  exists: boolean;
  /**
   * Set only for a package whose existence `verifyViaRepositorySearch`
   * could not settle either way. When set, `exists` is a meaningless filler
   * (always `false`) — `planUndo` must act on `indeterminate`, not `exists`,
   * and returns a blocker before either field would otherwise be read.
   */
  indeterminate?: string;
}

/**
 * A package has no source and no `/source/main` — and, unlike the six
 * `write.shape: "properties"` types below, no readable content at its
 * object URI either: `contentAccept()` picks `text/plain` for `DEVC/K`
 * (it has no `write` entry in the capabilities REGISTRY at all, so
 * `writeShapeOf` never returns `"properties"` for it), and asking the
 * packages XML endpoint for `text/plain` is a live, reproducible 406
 * (`ExceptionResourceNotAcceptable`) — identical whether the package still
 * exists or not, because content negotiation fails before the server looks
 * the object up. `probe()` only needs existence for a package, so this asks
 * for exactly that through the same repository-search read-back
 * `package-create`'s own post-create check already trusts, never the
 * object-URI GET.
 */
async function probePackage(conn: AbapConnection, t: ResolvedTarget): Promise<ProbeResult> {
  const outcome = await verifyViaRepositorySearch(conn, t.name, t.type);
  if (outcome.status === "confirmed") return { exists: true };
  if (outcome.status === "confirmed-absent") return { exists: false };
  return { exists: false, indeterminate: outcome.reason };
}

/**
 * Read content and etag in one request. Uses `contentUri`/`contentAccept`
 * (src/adt/write.ts), NOT `t.sourceUri` — that defaults to `${uri}/source/main`
 * unconditionally, which does not exist for `DEVC/K` or any
 * `write.shape: "properties"` type (DTEL/DE, DOMA/DD, TTYP/DA, MSAG/N,
 * ENQU/DL, SRVB/SVB). Probing raw `sourceUri` previously 404'd for exactly
 * these seven types, and `detectDrift` read that as "already absent" —
 * `planUndo` reported a no-op while the object was still on the server. See
 * the git history for the full incident.
 *
 * `DEVC/K` is routed to {@link probePackage} instead, BEFORE `contentUri`/
 * `contentAccept` are consulted at all — see that function's doc for why.
 */
async function probe(conn: AbapConnection, t: ResolvedTarget): Promise<ProbeResult> {
  if (isPackageType(t.type)) return probePackage(conn, t);
  try {
    const resp = await conn.get(contentUri(t), { headers: { Accept: contentAccept(t) } });
    const etag = resp.headers["etag"] ?? resp.headers["ETag"];
    return {
      source: resp.body,
      serverEtag: typeof etag === "string" ? etag : undefined,
      exists: true,
    };
  } catch (e) {
    if (isNotFoundError(e)) return { exists: false };
    throw e;
  }
}

/**
 * `viewdv`/`trant` VIT-bridge path segment. Exhaustive rather than a
 * fallthrough `else`: `isBridgeOnlyCreateType` is derived from the
 * capability registry, not hardcoded to these two, so a future third type
 * must fail loudly here instead of silently being treated as TRAN/T.
 */
function vitTypeFor(type: string): string {
  if (type === "VIEW/DV") return "viewdv";
  if (type === "TRAN/T") return "trant";
  throw new AbapError(
    "SAFETY_DENIED",
    `INTERNAL INVARIANT VIOLATED: no VIT-bridge path segment known for type "${type}". ` +
      "Nothing was read or changed.",
    { type },
    "This is a bug in abapsmith's undo planning, not something to retry — please report it.",
  );
}

/**
 * `planUndo`'s target+existence resolution for VIEW/DV and TRAN/T, standing
 * in for both `resolveWriteTarget` (refuses these types unconditionally,
 * src/adt/write.ts) and `probe` (GETs `/source/main`, which neither type
 * has). One VIT-bridge read settles target and existence together, so
 * `planUndo` skips `probe()` entirely for these types.
 *
 * `packageSource: "requested"` in the confirmed-absent branch is NOT
 * `targetFromEntry`'s zero-network guess — a real VIT read just confirmed
 * the absence, the same "genuine 404 ⇒ requested" precedent
 * `resolveWriteTarget` itself relies on. Confirmed-with-a-package uses
 * `packageSource: "server"` instead, since the read gave a real one.
 * Confirmed-without-a-package and indeterminate both fall back to
 * `targetFromEntry`, which always resolves to `undoable: false` here — no
 * forged target ever reaches a mutating call.
 */
async function resolveBridgeCreateUndo(
  conn: AbapConnection,
  entry: JournalEntry,
): Promise<{ target: ResolvedTarget; now: ProbeResult; verify: VerifyOutcome }> {
  const type = entry.object.type;
  const found = await verifyViaVitBridge(conn, vitTypeFor(type), entry.object.name, type);
  const spec: TypeSpec = specForType(type) ?? {
    type,
    kind: type,
    label: type,
    path: entry.object.uri,
    mode: "source",
    supportsSource: false,
    keywords: [],
  };

  if (found.status === "confirmed-absent") {
    return {
      target: {
        spec,
        type,
        name: entry.object.name,
        uri: found.uri,
        sourceUri: found.uri,
        packageName: entry.object.package,
        description: entry.object.description ?? "",
        exists: false,
        packageSource: "requested",
      },
      now: { exists: false },
      verify: found,
    };
  }

  if (found.status === "confirmed") {
    const resolved = serverPackage(found);
    if (resolved) {
      return {
        target: {
          spec,
          type,
          name: entry.object.name,
          uri: found.uri,
          sourceUri: found.uri,
          packageName: resolved.name,
          description: entry.object.description ?? "",
          exists: true,
          packageSource: "server",
        },
        now: { exists: true },
        verify: found,
      };
    }
    return {
      target: targetFromEntry(entry),
      now: {
        exists: false,
        indeterminate:
          `${entry.object.name} was found via the VIT bridge, but the read carried no ` +
          "<adtcore:packageRef> element.",
      },
      verify: found,
    };
  }

  return { target: targetFromEntry(entry), now: { exists: false, indeterminate: found.reason }, verify: found };
}

/**
 * Half an undo, made visible: if `entry.corrNr`'s transport has since been
 * RELEASED (a `transport-release` entry exists, keyed by `object.name ===
 * trkorr`), restoring the object changes the server but not the already-left
 * request. Advisory, never a blocker.
 */
async function releasedTransportWarning(
  journal: Journal,
  entry: JournalEntry,
): Promise<string | undefined> {
  if (!entry.corrNr) return undefined;
  const releases = await journal.list({ object: entry.corrNr, operation: "transport-release" });
  if (releases.length === 0) return undefined;
  return (
    `This write was recorded against transport ${entry.corrNr}, which has ALREADY BEEN ` +
    `RELEASED (journal entry ${releases[0]!.id}). Undoing it will change the object on the ` +
    `server, but it CANNOT remove the original change from ${entry.corrNr} — that request ` +
    "has already left the system and may already be moving downstream. This is only HALF " +
    "an undo: the server will show the reverted source, but the released transport still " +
    "carries the original change. Create a corrective transport for the downstream systems " +
    "if this needs to be reversed there too."
  );
}

/**
 * Work out what undo would do and whether the server still looks like we left
 * it. Costs exactly **one** request (the state probe) and mutates nothing, so
 * it is safe to call for a dry run.
 */
export async function planUndo(
  conn: AbapConnection,
  journal: Journal,
  entry: JournalEntry,
): Promise<UndoPlan> {
  const action = plannedAction(entry);
  const restoreSource = action === "delete" ? undefined : await journal.beforeImage(entry);
  const transportWarning = await releasedTransportWarning(journal, entry);

  // ---- purely local refusals, decided before a single request ------------
  // Order: system check first (an entry from another box is wrong about
  // everything), then operation-shape blockers incl. classIncludeBlocker,
  // then the narrower delete-evidence gate.
  const localBlocker =
    systemMismatchBlocker(entry, liveSystem(conn, journal)) ??
    undoBlocker(entry) ??
    classIncludeBlocker(entry) ??
    deleteEvidenceBlocker(entry);

  if (localBlocker) {
    return {
      entry,
      // undoBlocker refuses every enhancement type unconditionally, so this
      // branch is always taken for one — never targetFromEntry, which throws
      // for these types instead.
      target: isEnhancementType(entry.object.type)
        ? refusedEnhancementTarget(entry)
        : targetFromEntry(entry),
      action,
      undoable: false,
      blocker: localBlocker,
      drift: { drifted: false, reason: "not evaluated — the entry is not undoable" },
      ...(restoreSource !== undefined ? { restoreSource } : {}),
      currentlyExists: false,
      ...(transportWarning ? { releasedTransportWarning: transportWarning } : {}),
    };
  }

  // VIEW/DV and TRAN/T never reach ADT REST at all (isBridgeOnlyCreateType,
  // src/adt/capabilities.ts) — resolveWriteTarget refuses them unconditionally,
  // and the generic probe() below GETs /source/main, which neither has. One
  // VIT-bridge read replaces both.
  const bridgeCreate = isBridgeOnlyCreateType(entry.object.type);
  let target: ResolvedTarget;
  let bridgeNow: ProbeResult | undefined;
  let bridgeCreateVerify: VerifyOutcome | undefined;
  if (bridgeCreate) {
    const resolved = await resolveBridgeCreateUndo(conn, entry);
    target = resolved.target;
    bridgeNow = resolved.now;
    bridgeCreateVerify = resolved.verify;
  } else {
    target = await resolveWriteTarget(conn, {
      name: entry.object.name,
      type: entry.object.type,
      packageName: entry.object.package,
      ...(entry.object.description ? { description: entry.object.description } : {}),
    });
  }

  if (action !== "delete" && restoreSource === undefined) {
    // Two different situations, two messages: a blob written then pruned IS a
    // retention story; a `begin()` that never captured one (failed read) is
    // not — blaming retention there sends the reader to
    // ABAP_JOURNAL_MAX_AGE_DAYS for a wire failure that already happened.
    const neverCaptured = entry.beforeCapture === "failed" || (entry.before !== undefined && !entry.before.blob);
    return {
      entry,
      target,
      action,
      undoable: false,
      blocker: neverCaptured
        ? `The journal has no before-image for ${entry.object.name}: one was never ` +
          `captured. The entry records that the object existed (beforeCapture=` +
          `"${entry.beforeCapture}") but its source read did not produce any bytes — a ` +
          "failed read, or an object with no readable source. Nothing was pruned; there " +
          "is simply nothing to restore, and abapsmith will not guess. Recover the " +
          "previous version from SAP's own version management (SE38/SE24 → Utilities → " +
          "Versions)."
        : `The journal has no before-image for ${entry.object.name}. Its blob is ` +
          "missing (pruned by the retention policy, or the journal directory was " +
          "cleaned). There is nothing to restore and abapsmith will not guess.",
      drift: { drifted: false, reason: "not evaluated — no before-image" },
      currentlyExists: false,
      ...(transportWarning ? { releasedTransportWarning: transportWarning } : {}),
    };
  }

  const now = bridgeNow ?? (await probe(conn, target));

  // Indeterminate existence (package OR bridge-only-create): refused the same
  // way every other structural blocker here is — as a plan, not a thrown
  // exception — so a dry run still gets a report rather than a crash. NOT
  // reported as existing or absent; nothing below this point ever consults
  // `now.exists`.
  if (now.indeterminate) {
    const howToCheck = bridgeCreate
      ? `abap_search mode=objects type="${entry.object.type}", or the relevant SE-transaction`
      : 'abap_search mode=objects type="DEVC/K", or SE21';
    return {
      entry,
      target,
      action,
      undoable: false,
      blocker:
        `Whether ${entry.object.name} still exists on the server could not be determined: ` +
        `${now.indeterminate} abapsmith will not guess either way before a delete-shaped undo. ` +
        `Confirm the object's state by hand (${howToCheck}) ` +
        "and retry once you know which way this goes. This refusal cannot be overridden with " +
        "force=true — force overrides DRIFT once both states are known; it does not manufacture " +
        "an existence check that never settled.",
      drift: { drifted: false, reason: "not evaluated — package existence could not be determined" },
      ...(restoreSource !== undefined ? { restoreSource } : {}),
      currentlyExists: false,
      ...(transportWarning ? { releasedTransportWarning: transportWarning } : {}),
    };
  }

  const drift = detectDrift(entry, action, now);

  // Server already in the state undo would put it in — not drift, nothing to
  // do. Reporting it as success would lie about having written anything.
  let effective: UndoAction = action;
  if (!drift.drifted) {
    if (action === "restore" && now.source !== undefined && restoreSource !== undefined) {
      if (sourceFingerprint(now.source) === sourceFingerprint(restoreSource)) effective = "noop";
    }
    if (action === "delete" && !now.exists) effective = "noop";
    if (action === "recreate" && now.exists) effective = "noop";
  }

  // E4: what this undo cannot cover. Attached to every class restore/recreate,
  // whether or not it blocks — a `restore` proceeds, but the user must know the
  // sub-includes are neither restored nor drift-checked.
  const partial = partialClassRestore(entry, effective);

  // Drift outranks the class refusal: it is the older and stricter rule, and
  // `force` already means "override drift" at that point.
  let blocker: string | undefined;
  let blockerForceable = false;
  if (drift.drifted) {
    blocker = drift.reason;
  } else if (partial && effective === "recreate") {
    blocker = classRecreateBlocker(entry, partial);
    blockerForceable = true;
  }

  return {
    entry,
    target,
    action: effective,
    undoable: !blocker,
    ...(blocker ? { blocker } : {}),
    ...(blockerForceable ? { blockerForceable } : {}),
    ...(partial ? { partial } : {}),
    drift,
    ...(restoreSource !== undefined ? { restoreSource } : {}),
    ...(now.source !== undefined ? { currentSource: now.source } : {}),
    currentlyExists: now.exists,
    ...(transportWarning ? { releasedTransportWarning: transportWarning } : {}),
    ...(bridgeCreateVerify ? { bridgeCreateVerify } : {}),
  };
}

/**
 * Third-party drift detection. The object may have been changed since we
 * wrote it, or deleted (or, for undo-of-delete, recreated) — all three are
 * somebody else's work and stop an undo by default.
 */
export function detectDrift(
  entry: JournalEntry,
  action: UndoAction,
  now: ProbeResult,
): DriftReport {
  const base = {
    ...(entry.after?.fingerprint ? { expectedFingerprint: entry.after.fingerprint } : {}),
    ...(now.source !== undefined ? { actualFingerprint: sourceFingerprint(now.source) } : {}),
    ...(entry.after?.etag ? { expectedEtag: entry.after.etag } : {}),
    ...(now.source !== undefined ? { actualEtag: contentHash(now.source) } : {}),
    ...(entry.after?.serverEtag ? { serverEtagAtWrite: entry.after.serverEtag } : {}),
    ...(now.serverEtag ? { serverEtagNow: now.serverEtag } : {}),
  };

  const name = entry.object.name;

  // ---- undo-of-create where the object is ALREADY gone -------------------
  // Not drift: undo-of-create's goal is "this object does not exist", and it
  // doesn't. Previously fell through to "everything else" below and threw
  // ETAG_CONFLICT for the exact state the user wanted — see
  // the git history. `now.exists === false` here is a
  // genuine 404 only: probe() rethrows every other failure.
  if (action === "delete" && !now.exists) {
    return {
      ...base,
      drifted: false,
      reason:
        `${name} is already absent from the server — which is exactly what ` +
        "undoing its creation would achieve. Whether abapsmith, a colleague in " +
        "Eclipse or a transport removed it, the result is the state you asked " +
        "for, so nothing needs to be sent.",
    };
  }

  // ---- undo-of-create, package or bridge-only object still there ---------
  // Neither a package nor a VIEW/DV or TRAN/T create has source, so `now.source`
  // is always undefined here and no after-image is ever recorded for one.
  // Falling through to the generic fingerprint check below would hit its
  // "journal never recorded an after-image" branch and report drift
  // unconditionally. Existence is the whole question for these types;
  // `now.exists === true` at this point already answers it.
  if (action === "delete" && (isPackageType(entry.object.type) || isBridgeOnlyCreateType(entry.object.type))) {
    return {
      ...base,
      drifted: false,
      reason: `${name} still exists on the server, as expected before deleting it.`,
    };
  }

  // ---- undo-of-delete: the object should still be gone -------------------
  if (action === "recreate") {
    if (now.exists) {
      return {
        ...base,
        drifted: true,
        reason:
          `${name} was deleted by abapsmith, but it EXISTS on the server again. ` +
          "Somebody (or something) recreated it after that delete. Recreating it " +
          "from the journal's before-image would overwrite whatever they put there.",
      };
    }
    return { ...base, drifted: false, reason: `${name} is still absent, as recorded.` };
  }

  // ---- everything else: the object should still be there -----------------
  if (!now.exists) {
    return {
      ...base,
      drifted: true,
      reason:
        `${name} no longer exists on the server. It was deleted after abapsmith ` +
        (action === "delete"
          ? "created it — so there is nothing left to delete."
          : "wrote it, by something other than abapsmith."),
    };
  }

  const expected = entry.after?.fingerprint;
  if (!expected) {
    return {
      ...base,
      drifted: true,
      reason:
        `The journal never recorded what abapsmith left on the server for ${name} ` +
        "(the entry has no after-image), so drift cannot be ruled out.",
    };
  }
  const actual = sourceFingerprint(now.source ?? "");
  if (actual === expected) {
    return { ...base, drifted: false, reason: `${name} is byte-for-byte what abapsmith left.` };
  }

  // Object already back at the before-image — "someone already undid this",
  // not third-party drift; the plan turns it into a no-op, not a refusal.
  if (entry.before?.fingerprint && actual === entry.before.fingerprint) {
    return {
      ...base,
      drifted: false,
      reason:
        `${name} already matches the recorded before-image — the change has ` +
        "already been reverted. Nothing to do.",
    };
  }

  return {
    ...base,
    drifted: true,
    reason:
      `${name} has CHANGED on the server since abapsmith wrote it. Expected ` +
      `content ${expected}, found ${actual}. Somebody else edited this object ` +
      "(Eclipse, SE38, another agent) after our write. " +
      // `action === "delete"` means undo-of-CREATE — nothing is "restored",
      // so state the actual action instead of the (false) restore wording
      // used for every other action.
      (action === "delete"
        ? "Deleting it now would silently destroy their change."
        : "Restoring the before-image now would silently destroy their change."),
  };
}

/**
 * `performUndo`'s delete-shaped dispatch for VIEW/DV and TRAN/T, replacing
 * `deleteObject` — which has no branch for either type; src/adt/write.ts's
 * own `isPackageType` arm handles its one bridge-delete type internally, not
 * generically, confirming there is nowhere in that function to extend.
 * `pkg` comes from `plan.bridgeCreateVerify` (this undo's own planning-time
 * VIT read), never rebuilt from the journal's stored `object.package`, which
 * nothing here has re-verified. Returns `deleteObject`'s own
 * `{deleted, verification}` shape so the caller's CHECK_FAILED / unverified
 * handling needs no changes.
 */
async function performBridgeCreateUndo(
  conn: AbapConnection,
  gate: SafetyGate,
  plan: UndoPlan,
  onBeforeImage: BeforeImageHook,
): Promise<{ deleted: boolean | "unverified"; verification: VerifyOutcome }> {
  const pkg = plan.bridgeCreateVerify && serverPackage(plan.bridgeCreateVerify);
  if (!pkg) {
    // Unreachable in normal flow: planUndo only reaches action === "delete" for
    // one of these entries once resolveBridgeCreateUndo confirmed the object
    // present WITH a package — the no-package and indeterminate cases both
    // refuse as a plan first, and confirmed-absent turns into a noop.
    throw new AbapError(
      "SAFETY_DENIED",
      `INTERNAL INVARIANT VIOLATED: about to delete ${plan.target.type} ${plan.target.name} for undo, ` +
        "but no server-confirmed package was carried from planning. Nothing was deleted.",
      { object: plan.target.name, type: plan.target.type },
      "This is a bug in abapsmith's undo planning, not something to retry — please report it.",
    );
  }

  // No source to capture — same shape src/adt/write.ts's own DEVC/K delete
  // branch reports for the same reason (neither type has one).
  await onBeforeImage({ source: undefined, existed: true, sourceReadable: true, target: plan.target });

  const type = plan.target.type;
  if (type === "VIEW/DV") {
    await deleteClassicViewViaBridge(conn, gate, { viewName: plan.target.name, packageName: pkg });
  } else if (type === "TRAN/T") {
    await deleteTransactionViaBridge(conn, gate, { tcode: plan.target.name, packageName: pkg });
  } else {
    // Unreachable in normal flow: only isBridgeOnlyCreateType entries reach this function,
    // and resolveBridgeCreateUndo already called vitTypeFor(type) once during planning.
    throw new AbapError(
      "SAFETY_DENIED",
      `INTERNAL INVARIANT VIOLATED: no bridge-delete function known for type "${type}". Nothing was deleted.`,
      { object: plan.target.name, type },
      "This is a bug in abapsmith's undo planning, not something to retry — please report it.",
    );
  }

  const outcome = await verifyObjectDeleted(conn, {
    uri: vitBridgeUri(vitTypeFor(type), plan.target.name),
    accept: VIT_STUB_ACCEPT,
    objectName: plan.target.name,
    expectType: type,
  });
  if (outcome.status === "confirmed") return { deleted: false, verification: outcome };
  if (outcome.status === "confirmed-absent") return { deleted: true, verification: outcome };
  return { deleted: "unverified", verification: outcome };
}

export interface UndoOptions {
  /** Proceed despite drift. The refusal is the feature; this is the escape. */
  force?: boolean;
  /** Re-activate after restoring. Default true. */
  activate?: boolean;
  /**
   * Syntax-check the before-image before restoring it. Default true. The result
   * is advisory: see `UndoResult.check`. Set false to save a request.
   */
  check?: boolean;
  /**
   * Authorisation hook, called once the plan is known, before anything
   * mutates. Throw to refuse; otherwise return the {@link AuthorizedTarget}
   * proof `writeObject`/`deleteObject` require (Layer 2, see write.ts).
   * Typically `(action, target) => gate.authorize(action === "delete" ?
   * "delete" : "write", target)`.
   *
   * REQUIRED deliberately: when optional, callers that forgot it produced
   * unauthorised mutations with no diagnostic. A caller with no gate must now
   * pass a callback that throws, which is greppable.
   *
   * `performUndo` re-checks the returned proof's `op` against the action at
   * runtime too, since `test/` is untyped and JS callers exist.
   */
  assertAllowed: (
    action: UndoAction,
    target: ResolvedTarget,
  ) => AuthorizedTarget<MutatingOperation, ResolvedTarget>;
  /**
   * The same gate `assertAllowed` is built from — REQUIRED for the same
   * reason. `deleteObject`'s DEVC/K bridge arm needs the live instance, not
   * an `AuthorizedTarget` proof: the bridge gates its own mutation and its
   * throwaway `$TMP` deploy class.
   */
  gate: SafetyGate;
}

/**
 * Perform the undo. Every mutating branch goes through `writeObject` /
 * `deleteObject` with a journal hook, so the undo lands in the journal exactly
 * like any other write and can itself be undone.
 */
export async function performUndo(
  conn: AbapConnection,
  journal: Journal,
  entry: JournalEntry,
  opts: UndoOptions,
): Promise<UndoResult> {
  // Fail closed BEFORE the first request: a caller here without an
  // authorisation hook is misconfigured. (Typechecked callers can't reach
  // this; test/ and JS callers can.)
  if (typeof opts?.assertAllowed !== "function") {
    throw new AbapError(
      "SAFETY_DENIED",
      "performUndo was called without an authorisation callback. An undo is a " +
        "write — for an undo-of-create it is a DELETE — so it must be checked " +
        "against the safety gate like any other write. Nothing was read and " +
        "nothing was changed.",
      { entry: entry.id, object: entry.object.name, operation: entry.operation },
      "Pass opts.assertAllowed, e.g. { assertAllowed: (action, target) => gate.assert(action, target) }. " +
        "If this call site really has no gate, pass an explicit no-op so the " +
        "decision is visible in the source.",
    );
  }

  const plan = await planUndo(conn, journal, entry);

  if (plan.blocker && !plan.drift.drifted && !(plan.blockerForceable && opts.force)) {
    // Structural blocker: activate entry, pending outcome, missing blob, no
    // absence evidence (E1), wrong system (E3), or main-only class recreate
    // (E4). `force` applies only to the last — the rest have no before-image
    // or evidence a flag could manufacture.
    throw new AbapError(
      "BAD_INPUT",
      plan.blocker,
      {
        entry: entry.id,
        object: entry.object.name,
        operation: entry.operation,
        plannedAction: plan.action,
        beforeCapture: entry.beforeCapture,
        existedBefore: entry.existedBefore,
        forceable: Boolean(plan.blockerForceable),
        ...(plan.partial ? { unrestored: plan.partial.unrestored } : {}),
      },
      plan.blockerForceable
        ? "Nothing was changed on the server. Repeat with force=true to accept the " +
          "partial restore described above."
        : "Nothing was changed on the server, and force=true will not change that.",
    );
  }

  if (plan.drift.drifted && !opts.force) {
    throw new AbapError(
      "ETAG_CONFLICT",
      plan.drift.reason,
      {
        entry: entry.id,
        object: entry.object.name,
        type: entry.object.type,
        uri: plan.target.uri,
        expectedFingerprint: plan.drift.expectedFingerprint,
        actualFingerprint: plan.drift.actualFingerprint,
        serverEtagAtWrite: plan.drift.serverEtagAtWrite,
        serverEtagNow: plan.drift.serverEtagNow,
      },
      "Nothing was changed on the server. Read the object (abap_read) and the " +
        "recorded images (abap_journal mode=show) and decide deliberately. " +
        "Pass force=true to overwrite the other change anyway.",
    );
  }

  if (plan.action === "noop") {
    return { plan, performed: false, forced: Boolean(opts.force) };
  }

  // `authorized` is the compile-time-enforced proof (Layer 2) —
  // writeObject/deleteObject take nothing else. The op-match check below is
  // the runtime half: it catches a callback that authorised the wrong verb,
  // which the generic return type cannot.
  const expectedOp: MutatingOperation = plan.action === "delete" ? "delete" : "write";
  const authorized = opts.assertAllowed(plan.action, plan.target);
  if (authorized.op !== expectedOp) {
    throw new AbapError(
      "BAD_INPUT",
      `INTERNAL INVARIANT VIOLATED: assertAllowed authorised "${authorized.op}" for an undo ` +
        `action ("${plan.action}") that requires "${expectedOp}". Nothing was changed.`,
      { entry: entry.id, object: entry.object.name, action: plan.action, authorizedOp: authorized.op },
      "This is a bug in the undo authorisation callback, not something to retry — please report it.",
      { retryable: false }, // internal invariant violation, not a caller-fixable argument
    );
  }

  const objectRef = journalRef(plan.target);

  let undoEntryId: string | undefined;
  let activation: ActivationOutcome | undefined;
  let check: CheckOutcome | undefined;
  let checkUnavailable: string | undefined;
  let deleteUnverified: string | undefined;

  const liveKey = liveSystem(conn, journal).key;

  /**
   * Provenance for the undo's OWN journal entry, stated from what this call
   * observed — never upgraded to make a future undo easier: bytes held →
   * "captured"; probe positively 404'd → "confirmed-absent"; object there but
   * no source → "failed" (marking it "captured" would let the NEXT undo
   * delete on the strength of a read that produced nothing).
   */
  const captureFor = (img: { source?: string }): BeforeImageCapture => {
    if (img.source !== undefined) return "captured";
    if (!plan.currentlyExists) return "confirmed-absent";
    return "failed";
  };

  if (plan.action === "delete") {
    // E1, defence in depth: asserts the invariant right before the object is
    // destroyed, so a future refactor that drops the structural blocker fails
    // loudly here instead of quietly deleting source.
    if (entry.beforeCapture !== "confirmed-absent") {
      throw new AbapError(
        "BAD_INPUT",
        `INTERNAL INVARIANT VIOLATED: about to DELETE ${entry.object.name} for a journal ` +
          `entry whose before-image provenance is "${entry.beforeCapture}", not ` +
          '"confirmed-absent". Undo may only delete an object it positively knows was ' +
          "absent beforehand. Nothing was deleted.",
        {
          entry: entry.id,
          object: entry.object.name,
          beforeCapture: entry.beforeCapture,
          existedBefore: entry.existedBefore,
        },
        "This is a bug in abapsmith's undo gating, not something to retry — please report it.",
        { retryable: false }, // internal invariant violation, not a caller-fixable argument
      );
    }
    // Same journalling helper the write path uses: `begin()` fires inside
    // `deleteObject`'s call chain, so the entry is on disk before the DELETE
    // goes out. `undefined` ⇒ journal is off; never a placeholder id.
    //
    // `leave-pending` preserved deliberately: a throw from the delete leaves
    // the entry `pending` rather than patched `failed` — unchanged from
    // before this refactor.
    const { result: res, entryId, settle } = await withJournalledMutation(
      journal,
      {
        begin: (img: BeforeImage) => ({
          operation: "delete",
          object: objectRef,
          existedBefore: img.existed,
          beforeCapture: captureFor(img),
          systemKey: liveKey,
          ...(img.source !== undefined ? { beforeSource: img.source } : {}),
          undoOf: entry.id,
          tool: "abap_journal undo",
        }),
        onError: "leave-pending",
      },
      (onBeforeImage) =>
        isBridgeOnlyCreateType(entry.object.type)
          ? performBridgeCreateUndo(conn, opts.gate, plan, onBeforeImage)
          : deleteObject(conn, authorized, { onBeforeImage, bridgeGate: opts.gate }),
    );
    undoEntryId = entryId;
    // `res.deleted` is now three-valued, and the ternary this replaced
    // silently treated `"unverified"` as truthy — settling it `succeeded`
    // was accidentally correct (the DELETE did land), but `false` reaching
    // the same `succeeded` branch would have let `markUndone` below mark the
    // ORIGINAL entry undone while the object it was supposed to remove is
    // demonstrably still there — a second lie stacked on the first. That
    // case must settle `failed` and throw before `markUndone` ever runs.
    if (res.deleted === false) {
      await settle({ outcome: "failed", activation: { attempted: false } });
      throw new AbapError(
        "CHECK_FAILED",
        `abap_journal mode=undo of entry ${entry.id}: the DELETE of ${entry.object.type} ` +
          `${entry.object.name} was accepted, but a read-back and an independent repository ` +
          `search both still find the object (${describeDeleteVerification(res.verification)}) — ` +
          "abapsmith will not mark the original entry undone while the object it was supposed " +
          "to remove is demonstrably still there.",
        {
          reason: "DELETE_NOT_CONFIRMED",
          entry: entry.id,
          object: entry.object.name,
          type: entry.object.type,
          deleted: false,
          verification: res.verification,
          ...(undoEntryId !== undefined ? { undoEntryId } : {}),
        },
        "Re-read the object with abap_read to see its current state before retrying the undo.",
      );
    }
    if (res.deleted === "unverified") {
      deleteUnverified =
        `abap_journal mode=undo's DELETE of ${entry.object.type} ${entry.object.name} was sent ` +
        "and accepted, but abapsmith could not confirm the object is actually gone " +
        `(${describeDeleteVerification(res.verification)}). Check for yourself with abap_read on ` +
        `the object (a NOT_FOUND confirms it is gone) or abap_search for "${entry.object.name}".`;
    }
    await settle({
      outcome: "succeeded",
      activation: { attempted: false },
    });
  } else {
    const source = plan.restoreSource;
    if (source === undefined) {
      throw new AbapError("BAD_INPUT", "No before-image to restore.", { entry: entry.id });
    }

    // Advisory pre-flight, free of side effects (no lock/save/activation).
    // Result never blocks the restore — see UndoResult.check.
    if (opts.check ?? true) {
      check = await checkSource(conn, plan.target, source).catch((e: unknown) => {
        // Swallowed on purpose but not silently: distinguishes "check found
        // nothing wrong" from "check never ran".
        checkUnavailable =
          `the syntax check could not be run (${e instanceof Error ? e.message : String(e)}), ` +
          "so the before-image was restored WITHOUT being checked";
        return undefined;
      });
    } else {
      checkUnavailable = "the syntax check was disabled for this undo (check=false)";
    }

    // Same helper, same ordering rule and the same `leave-pending` choice as the
    // delete branch above — see the comment there.
    const { result: written, entryId, settle } = await withJournalledMutation(
      journal,
      {
        begin: (img: BeforeImage) => ({
          // Recreating a deleted object IS a create, and journalling it as one
          // is what makes undo-of-undo-of-delete come out as a delete again.
          operation: img.existed ? "update" : "create",
          object: objectRef,
          existedBefore: img.existed,
          beforeCapture: captureFor(img),
          systemKey: liveKey,
          ...(img.source !== undefined ? { beforeSource: img.source } : {}),
          afterSource: source,
          undoOf: entry.id,
          tool: "abap_journal undo",
        }),
        onError: "leave-pending",
      },
      (onBeforeImage) => writeObject(conn, authorized, { source, onBeforeImage }),
    );
    undoEntryId = entryId; // see the note in the delete branch

    if (written.changed && (opts.activate ?? true)) {
      // Pre-activation guard (added 2026-08-06, matching src/tools/write.ts:455
      // — undo didn't have it before, a divergence from its own "ordinary
      // write" contract). Cannot assume `src/adt/pool.ts`'s object gate is
      // covering the unlock→activation window: it is switchable off via
      // ABAP_SERIALISE_SAME_OBJECT_WRITES=false. NARROWS the race to one
      // round trip, does not close it — ADT activation carries no version
      // pin. Getting it wrong here is worse than on the write path: this IS
      // the recovery path, so a lost update publishes a colleague's inactive
      // source while reporting a successful restore.
      //
      // `exists: true` forced for the same reason as src/tools/write.ts:444:
      // `written.target` predates the write, so on recreate it still says
      // `exists: false` and `readCurrentSource` would read "vanished" for an
      // object that was just recreated. Both sides compare through the same
      // `canonicalEtag` that produced `written.etag`.
      const observed = await readCurrentSource(conn, { ...written.target, exists: true });
      const observedEtag = observed === undefined ? null : canonicalEtag(observed);
      if (observedEtag !== written.etag) {
        throw new AbapError(
          "ETAG_CONFLICT",
          `${plan.target.name} changed between abapsmith's restore and its activation, so it ` +
            `was NOT activated. The before-image abapsmith restored IS saved on ${conn.cfg.sid} ` +
            `as the INACTIVE version, but the inactive version now on the server is somebody ` +
            `else's: activating would have published THEIR source as the result of this undo.`,
          {
            name: written.target.name,
            type: written.target.type,
            uri: written.target.uri,
            operation: "undo",
            phase: "pre-activation",
            written: true,
            activated: false,
            entry: entry.id,
            expectedEtag: written.etag,
            actualEtag: observedEtag,
            // an id exists iff a real entry landed (journal off ⇒ undefined)
            ...(undoEntryId !== undefined ? { journal: undoEntryId } : {}),
          },
          "Another writer changed this object between abapsmith's PUT and its activation — " +
            "the object lock does NOT span activation, and activation cannot be pinned to a " +
            "version on this protocol. DO NOT simply undo again: the before-image already " +
            "landed and was then overwritten, so a blind retry re-runs the same race and " +
            "silently discards the other writer's work. Read the object (abap_read) to see " +
            "what is actually there now, merge the two changes deliberately, and write the " +
            "merged source. The last ACTIVE version is untouched and still what callers run.",
        );
      }
      activation = await activateObject(conn, written.target);
    }
    await settle({
      outcome: "succeeded",
      ...(written.normalisedSource ? { afterSource: written.normalisedSource } : {}),
      // The transport the restore ACTUALLY landed in (not guessed from
      // entry.corrNr) — only known here because the lock/transport is taken
      // after `onBeforeImage` already recorded the entry (WP-E: "undoing a
      // write needs a transport too").
      ...(written.transport.corrNr ? { corrNr: written.transport.corrNr } : {}),
      activation: {
        attempted: Boolean(activation),
        ...(activation ? { activated: activation.activated } : {}),
      },
    });
  }

  if (undoEntryId) await journal.markUndone(entry.id, undoEntryId);

  return {
    plan,
    ...(undoEntryId ? { undoEntryId } : {}),
    // Only on a performed undo: a no-op restored nothing, so it left nothing
    // unrestored either, and warning about includes there would be noise.
    ...(plan.partial ? { partial: plan.partial } : {}),
    performed: true,
    ...(check ? { check } : {}),
    ...(checkUnavailable ? { checkUnavailable } : {}),
    ...(deleteUnverified ? { deleteUnverified } : {}),
    ...(activation ? { activation } : {}),
    forced: Boolean(opts.force),
  };
}
