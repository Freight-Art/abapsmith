/**
 * Static undoability policy (issue #200) — decides, from an entry alone plus
 * a little context, whether it can ever be undone, and if not, why. Pure: no
 * I/O, no ADT calls.
 *
 * Called by `Journal.begin()` (src/journal.ts) for every new entry, so
 * `undoable`/`undoBlocker` are known at write time, not only when someone
 * later tries `abap_journal mode=undo`. From phase 2, `src/adt/undo.ts`
 * switches its own `undoBlocker()` to call this too, so both places agree —
 * the refusal-text constants/functions below are copied verbatim from
 * undo.ts for that reason; undo.ts itself is untouched by this file.
 *
 * Type-only import of `JournalEntry`/`BeforeImageCapture` from
 * src/journal.ts: erased at compile time, so journal.ts (which imports this
 * module for real, at runtime) and this module never form a runtime cycle.
 * `specFromUri` comes from src/adt/types.ts, which does not import
 * src/journal.ts either, so that import is runtime-safe too.
 */
import type { BeforeImageCapture, JournalEntry } from "./journal.js";
import { specFromUri, type ClassInclude } from "./adt/types.js";

// ---------------------------------------------------------------------------
// Refusal text — copied verbatim from src/adt/undo.ts (functions
// undoBlocker, classIncludeActionBlocker, packageRecreateBlocker,
// deleteEvidenceBlocker, captureExplanation). Phase 2 switches undo.ts to
// import these instead of keeping its own copies.
// ---------------------------------------------------------------------------

export const TRANSPORT_RELEASE_UNDO_BLOCKER =
  "a released transport cannot be recalled; create a corrective transport instead";

export const SERVICE_PUBLISH_UNDO_BLOCKER =
  "publishing a service binding changes the system's runtime surface (an ICF node under " +
  "/sap/opu/odata*), not the object's source, so there is no before-image to write back; " +
  'call abap_service op="unpublish" confirm=<binding> instead — a deliberate, separately ' +
  "confirmed act, not an automatic undo";

export const SERVICE_UNPUBLISH_UNDO_BLOCKER =
  "unpublishing a service binding changes the system's runtime surface, not the object's " +
  "source, so there is no before-image to restore; " +
  'call abap_service op="publish" confirm=<binding> instead — a deliberate, separately ' +
  "confirmed act, not an automatic undo";

export const TRANSPORT_GENERIC_UNDO_BLOCKER =
  "transport requests are not undone automatically; use abap_transport to reverse this manually";

export const IRREVERSIBLE_UNDO_BLOCKER =
  "This entry is marked irreversible — recorded for history only. No mechanism " +
  "can undo it, not even with force=true.";

/** How each provenance value fails to be evidence of absence. Verbatim from src/adt/undo.ts. */
export function captureExplanation(capture: BeforeImageCapture): string {
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

/** Verbatim from src/adt/undo.ts's `packageRecreateBlocker`, parameterised on the name alone. */
export function packageRecreateBlockerText(name: string): string {
  return (
    `Undoing this entry would RE-CREATE package ${name}, and abapsmith does not re-create ` +
    "packages from a journal entry. The before-image is the package's metadata document (a " +
    "package has no source), and abapsmith restores a before-image by writing it through the " +
    "ordinary write path, which would PUT that XML at a URI that has no source document. That " +
    "is refused rather than attempted. Nothing was changed. Re-create the package deliberately " +
    `with abap_write type="DEVC/K" (abap_journal mode=show entry=<id> prints the recorded ` +
    "metadata), then move its contents back. This refusal cannot be overridden with force=true."
  );
}

/** Verbatim from src/adt/undo.ts's `deleteEvidenceBlocker`, parameterised on name + capture. */
export function deleteEvidenceBlockerText(name: string, capture: BeforeImageCapture): string {
  return (
    `Undoing this entry would DELETE ${name} from the server, and the journal does not ` +
    `have positive evidence that ${name} was absent before abapsmith wrote it. The ` +
    `recorded provenance is beforeCapture="${capture}"; only ` +
    `"confirmed-absent" is positive evidence. ${captureExplanation(capture)} ` +
    `${name} may well have existed, in which case this undo would destroy source that ` +
    `abapsmith never recorded and therefore cannot put back. ` +
    "This refusal cannot be overridden — force=true overrides DRIFT, it does not " +
    "manufacture evidence that was never captured. " +
    `If you have read ${name} (abap_read) and you do want it gone, delete it ` +
    "deliberately with abap_write mode=delete, which records a real before-image first."
  );
}

/** Verbatim wording from src/adt/undo.ts's `classIncludeActionBlocker`. */
function classIncludeBlockerText(
  name: string,
  include: ClassInclude,
  action: "delete" | "recreate",
): string {
  const verb = action === "delete" ? "DELETE" : "RE-CREATE";
  return (
    `Undoing this entry would ${verb} the ${include} include of class ${name}, and ` +
    "ADT has no operation that deletes or re-creates one include of a class on its own — " +
    `deleteObject sends DELETE {classUri}, which would destroy ${name}'s main ` +
    "source and all of its other includes too, not just this one. That is refused rather than " +
    "attempted. Nothing was changed. To empty a class include, write a single comment line to " +
    'it (e.g. `*"* no local test classes`) — abapsmith does not send an empty document, and ' +
    "there is no ADT verb that deletes an include on its own. Do that with " +
    `abap_write include="${include}". This refusal cannot be overridden with force=true.`
  );
}

/** Same derivation `src/adt/undo.ts`'s `classIncludeFromSourceUri` uses. */
function classIncludeFromSourceUri(uri: string | undefined): ClassInclude | undefined {
  if (uri === undefined) return undefined;
  const inc = specFromUri(uri)?.include;
  return inc !== undefined && inc !== "main" ? inc : undefined;
}

/** Same three-way split `src/adt/undo.ts`'s `plannedAction` makes. */
function plannedActionOf(entry: JournalEntry): "delete" | "restore" | "recreate" {
  if (entry.operation === "delete") return "recreate";
  if (!entry.existedBefore) return "delete";
  return "restore";
}

const ENHANCEMENT_TYPES: ReadonlySet<string> = new Set(["ENHO/XH", "ENHO/XHH", "ENHS/XS"]);
const TEXT_POOL_RESOURCE_TYPES: ReadonlySet<string> = new Set(["PROG/PX", "CLAS/OCX", "FUGR/PX"]);

// ---------------------------------------------------------------------------
// precedingWriteEntry
// ---------------------------------------------------------------------------

/**
 * The latest entry earlier than `activate` (by `ts`, tie-broken by position
 * in `entries`) for the same object (type + name, case-insensitive) and the
 * same system (when both carry a `systemKey`), whose operation is a write
 * (create/update/delete) that succeeded. `activate` itself need not be
 * present in `entries` — `Journal.begin()` calls this before its own entry
 * has been appended, in which case `activate` is treated as coming after
 * everything already on disk.
 *
 * Undone entries are still returned — whether an undone preceding write
 * still counts is `writeTimeUndoability`'s call, not this function's.
 */
export function precedingWriteEntry(
  entries: readonly JournalEntry[],
  activate: JournalEntry,
): JournalEntry | undefined {
  const type = activate.object.type.toUpperCase();
  const name = activate.object.name.toUpperCase();
  let activateIndex = entries.findIndex((e) => e.id === activate.id);
  if (activateIndex < 0) activateIndex = entries.length;

  let best: JournalEntry | undefined;
  let bestIndex = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.id === activate.id) continue;
    if (e.object.type.toUpperCase() !== type) continue;
    if (e.object.name.toUpperCase() !== name) continue;
    if (
      activate.systemKey !== undefined &&
      e.systemKey !== undefined &&
      e.systemKey !== activate.systemKey
    ) {
      continue;
    }
    if (e.operation !== "create" && e.operation !== "update" && e.operation !== "delete") continue;
    if (e.outcome !== "succeeded") continue;

    const earlier = e.ts < activate.ts || (e.ts === activate.ts && i < activateIndex);
    if (!earlier) continue;

    const better = !best || e.ts > best.ts || (e.ts === best.ts && i > bestIndex);
    if (better) {
      best = e;
      bestIndex = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// writeTimeUndoability
// ---------------------------------------------------------------------------

/**
 * Decide, from the entry alone (plus a caller-supplied narrowing blocker
 * and, for `activate` entries, the preceding write), whether an entry can
 * ever be undone. First matching rule wins. Kept table-like on purpose: one
 * short comment per rule, no essays.
 */
export function writeTimeUndoability(
  entry: JournalEntry,
  ctx: { callerBlocker?: string; precedingWrite?: JournalEntry },
): { undoable: boolean; undoBlocker: string } {
  // 1. a caller-supplied blocker always wins — narrowing only, never widening.
  if (ctx.callerBlocker) {
    return { undoable: false, undoBlocker: ctx.callerBlocker };
  }

  // 2. transport/service entries: no before-image to write back, or nothing
  //    ADT lets us reverse.
  if (entry.operation === "transport-release") {
    return { undoable: false, undoBlocker: TRANSPORT_RELEASE_UNDO_BLOCKER };
  }
  if (entry.operation === "service-publish") {
    return { undoable: false, undoBlocker: SERVICE_PUBLISH_UNDO_BLOCKER };
  }
  if (entry.operation === "service-unpublish") {
    return { undoable: false, undoBlocker: SERVICE_UNPUBLISH_UNDO_BLOCKER };
  }
  if (entry.operation.startsWith("transport-")) {
    return { undoable: false, undoBlocker: TRANSPORT_GENERIC_UNDO_BLOCKER };
  }

  // 3. activate entries delegate to the preceding write for the same object.
  if (entry.operation === "activate") {
    const pw = ctx.precedingWrite;
    if (!pw) {
      return {
        undoable: false,
        undoBlocker:
          `No earlier write entry for ${entry.object.type} ${entry.object.name} in this journal, ` +
          "so there is no before-image to go back to. An activation on its own cannot be undone.",
      };
    }
    if (pw.undoneBy) {
      return {
        undoable: false,
        undoBlocker:
          `Undoing this activation means undoing write entry ${pw.id}, which was already undone ` +
          `by ${pw.undoneBy}.`,
      };
    }
    const pwUndoability =
      pw.undoable === false
        ? { undoable: false, undoBlocker: pw.undoBlocker ?? "" }
        : writeTimeUndoability(pw, {});
    if (!pwUndoability.undoable) {
      return {
        undoable: false,
        undoBlocker:
          `Undoing this activation means undoing write entry ${pw.id}, which is not undoable: ` +
          pwUndoability.undoBlocker,
      };
    }
    return { undoable: true, undoBlocker: "" };
  }

  // 4. irreversible catch-all, checked before any type-specific carve-out.
  if (entry.irreversible) {
    return { undoable: false, undoBlocker: IRREVERSIBLE_UNDO_BLOCKER };
  }

  const type = entry.object.type;
  const name = entry.object.name;

  // 5. enhancement objects: undoable only for a confirmed-absent create
  //    (undo deletes it) or a captured set_impl_active flip.
  if (ENHANCEMENT_TYPES.has(type)) {
    if (entry.operation === "create") {
      if (!entry.existedBefore && entry.beforeCapture === "confirmed-absent") {
        return { undoable: true, undoBlocker: "" };
      }
      return { undoable: false, undoBlocker: deleteEvidenceBlockerText(name, entry.beforeCapture) };
    }
    if (
      entry.operation === "update" &&
      entry.beforeKind === "enh-impl-active" &&
      entry.beforeCapture === "captured"
    ) {
      return { undoable: true, undoBlocker: "" };
    }
    return {
      undoable: false,
      undoBlocker:
        `Undo of an enhancement ${entry.operation} is not supported. Only create_spot, ` +
        "create_impl and create_hook (undo deletes the object) and set_impl_active (undo sets " +
        "the previous state back) have an undo. Reverse this with abap_enh or SE18/SE19.",
    };
  }

  // 6. BOPF: undoable only for a captured model update.
  if (type === "BOBF") {
    if (
      entry.operation === "update" &&
      entry.beforeKind === "bopf-model" &&
      entry.beforeCapture === "captured"
    ) {
      return { undoable: true, undoBlocker: "" };
    }
    return {
      undoable: false,
      undoBlocker: `BOPF ${entry.operation} has no undo: only abap_bopf_edit updates record the previous model.`,
    };
  }

  // 7. text pool: undoable only when the previous pool was captured.
  if (TEXT_POOL_RESOURCE_TYPES.has(type)) {
    if (entry.beforeKind === "text-pool" && entry.beforeCapture === "captured") {
      return { undoable: true, undoBlocker: "" };
    }
    return {
      undoable: false,
      undoBlocker: "This text pool write has no recorded previous text pool, so there is nothing to restore.",
    };
  }

  // 8. a package has no source to restore.
  if (entry.operation === "delete" && type === "DEVC/K") {
    return { undoable: false, undoBlocker: packageRecreateBlockerText(name) };
  }

  // 9. a class sub-include's own creation/deletion has no ADT verb of its own.
  const include = classIncludeFromSourceUri(entry.object.sourceUri);
  if (include && type === "CLAS/OC") {
    const action = plannedActionOf(entry);
    if (action === "delete" || action === "recreate") {
      return { undoable: false, undoBlocker: classIncludeBlockerText(name, include, action) };
    }
  }

  // 10. delete-shaped without positive evidence of prior absence.
  if (entry.operation !== "delete" && !entry.existedBefore && entry.beforeCapture !== "confirmed-absent") {
    return { undoable: false, undoBlocker: deleteEvidenceBlockerText(name, entry.beforeCapture) };
  }

  // 11. restore/recreate-shaped with no before-image blob to replay.
  if (
    (entry.existedBefore || entry.operation === "delete") &&
    (entry.beforeCapture !== "captured" || !entry.before?.blob)
  ) {
    return {
      undoable: false,
      undoBlocker: `No before-image was captured for ${name} (beforeCapture="${entry.beforeCapture}"), so there is nothing to restore.`,
    };
  }

  // 12. nothing above applies: an ordinary restore with a real before-image.
  return { undoable: true, undoBlocker: "" };
}
