/**
 * The four "special" undo kinds that `src/adt/undo.ts` cannot handle with
 * its generic write/delete replay: text pool restores, BOPF model restores,
 * enhancement create-undo (delete), and enhancement implementation-active
 * flips. See doc/JOURNAL/undo-and-recovery.md and src/undoability.ts (the
 * write-time policy that decides which entries can ever reach this module).
 *
 * `undo.ts` imports runtime values from here; this module must never import
 * runtime values back from `undo.ts` (circular import) — only `import type`.
 */
import {
  type Journal,
  type JournalEntry,
  journalRef,
  sourceFingerprint,
  systemKey,
  withJournalledMutation,
} from "../journal.js";
import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import { isNotFoundError } from "./session.js";
import { explainDeniedCapability } from "../mode.js";
import { specForType, type TypeSpec } from "./types.js";
import {
  resolveWriteTarget,
  enhancementIntentFor,
  type AuthorizedTarget,
  type MutatingOperation,
  type ResolvedTarget,
} from "./write.js";
import type { UndoAction, UndoOptions, UndoPlan, UndoResult } from "./undo.js";
import {
  readTextPool,
  writeTextPool,
  textPoolImage,
  parseTextPoolImage,
  type TextPoolObjectType,
} from "./text-pool.js";
import { readModel, putModel, activateBusinessObject, BOPF_TYPE } from "./bopf.js";
import { remapNodeIds, bopfModelComparable } from "./bopf-xml.js";
import {
  deleteEnhancementObject,
  setBadiImplementationActive,
  isEnhancementWriteType,
  type EnhancementDocType,
  type EnhancementDeleteBeforeImage,
  type EnhancementBeforeImage,
} from "./enhancement-write.js";
import { readBadiImplementation, readSourceCodePlugin, readEnhancementSpot } from "./enhancement.js";
import { parseBadiImplementation, type BadiImplementationRead } from "./enhancement-xml.js";
import { fetchUsageReferences } from "./element-info.js";
import { activateObject } from "./activate.js";

export type SpecialUndoKind = "text-pool" | "bopf-model" | "enh-delete" | "enh-impl-active";

// ---------------------------------------------------------------------------
// Local lookup tables — small, kind-scoped duplicates, same convention as
// undo.ts's own local ENHANCEMENT_TYPES and undoability.ts's
// TEXT_POOL_RESOURCE_TYPES (neither is exported for reuse here).
// ---------------------------------------------------------------------------

const TEXT_POOL_RESOURCE_TYPES: ReadonlySet<string> = new Set(["PROG/PX", "CLAS/OCX", "FUGR/PX"]);

const TEXT_POOL_OWNER_TYPE: Readonly<Record<string, TextPoolObjectType>> = {
  "PROG/PX": "PROG/P",
  "CLAS/OCX": "CLAS/OC",
  "FUGR/PX": "FUGR/F",
};

/** Read function enhancement-write.ts uses per document type, for the enh-delete existence probe. */
const ENH_READERS: Readonly<Record<EnhancementDocType, (conn: AbapConnection, name: string) => Promise<{ xml: string; data: unknown }>>> = {
  "ENHO/XH": readBadiImplementation,
  "ENHO/XHH": readSourceCodePlugin,
  "ENHS/XS": readEnhancementSpot,
};

// ---------------------------------------------------------------------------
// specialUndoKind — mirrors writeTimeUndoability's rules 5-7 (src/undoability.ts)
// exactly, structurally: any entry that fails these has already been marked
// undoable:false at write time and is caught by undo.ts's storedUndoableBlocker
// before specialUndoKind is ever consulted.
// ---------------------------------------------------------------------------

export function specialUndoKind(entry: JournalEntry): SpecialUndoKind | undefined {
  const type = entry.object.type;

  if (isEnhancementWriteType(type)) {
    if (entry.operation === "create" && !entry.existedBefore && entry.beforeCapture === "confirmed-absent") {
      return "enh-delete";
    }
    if (entry.operation === "update" && entry.beforeKind === "enh-impl-active" && entry.beforeCapture === "captured") {
      return "enh-impl-active";
    }
    return undefined;
  }

  if (type === BOPF_TYPE) {
    if (entry.operation === "update" && entry.beforeKind === "bopf-model" && entry.beforeCapture === "captured") {
      return "bopf-model";
    }
    return undefined;
  }

  if (
    TEXT_POOL_RESOURCE_TYPES.has(type) &&
    entry.beforeKind === "text-pool" &&
    entry.beforeCapture === "captured"
  ) {
    return "text-pool";
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** True for a 404 from either the raw ADT session or a translated AbapError. */
const isGone = (e: unknown): boolean => isNotFoundError(e) || (e instanceof AbapError && e.code === "NOT_FOUND");

/** A structurally-blocked plan for a special kind — zero further network calls. */
function blockedPlan(
  entry: JournalEntry,
  target: ResolvedTarget,
  action: UndoAction,
  kind: SpecialUndoKind,
  blocker: string,
): UndoPlan {
  return {
    entry,
    target,
    action,
    undoable: false,
    blocker,
    drift: { drifted: false, reason: blocker },
    currentlyExists: target.exists,
    special: kind,
  };
}

/** A noop plan — server already matches the before-image, or the object is already gone. */
function noopPlan(
  entry: JournalEntry,
  target: ResolvedTarget,
  kind: SpecialUndoKind,
  reason: string,
  restoreSource?: string,
  currentSource?: string,
): UndoPlan {
  return {
    entry,
    target,
    action: "noop",
    undoable: true,
    drift: { drifted: false, reason },
    restoreSource,
    currentSource,
    currentlyExists: target.exists,
    special: kind,
  };
}

/**
 * Same runtime half-check performUndo runs on its own `assertAllowed` result
 * (the compile-time proof can't catch a callback authorising the wrong verb).
 */
function assertOp(
  authorized: AuthorizedTarget<MutatingOperation, ResolvedTarget>,
  expectedOp: MutatingOperation,
  entry: JournalEntry,
  action: UndoAction,
): AuthorizedTarget<MutatingOperation, ResolvedTarget> {
  if (authorized.op !== expectedOp) {
    throw new AbapError(
      "BAD_INPUT",
      `INTERNAL INVARIANT VIOLATED: assertAllowed authorised "${authorized.op}" for an undo ` +
        `action ("${action}") that requires "${expectedOp}". Nothing was changed.`,
      { entry: entry.id, object: entry.object.name, action, authorizedOp: authorized.op },
      "This is a bug in the undo authorisation callback, not something to retry — please report it.",
    );
  }
  return authorized;
}

/**
 * `ResolvedTarget` for an enhancement object, mirroring undo.ts's own
 * `refusedEnhancementTarget()`/`targetFromEntry()` pattern but taking the
 * REAL existence value learned from a live read, since these plans are not
 * all refused.
 */
function enhancementTargetFromEntry(entry: JournalEntry, exists: boolean): ResolvedTarget {
  const spec = specForType(entry.object.type);
  if (!spec) {
    throw new AbapError(
      "BAD_INPUT",
      `enhancement type ${entry.object.type} has no TypeSpec in src/adt/types.ts — ` +
        "ENHANCEMENT_WRITE_TYPES and the registry have gone out of sync.",
      { type: entry.object.type },
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
    exists,
    packageSource: "requested",
  };
}

/**
 * `ResolvedTarget` for a BOPF business object. `BOBF` has no row in
 * src/adt/types.ts's registry, so a minimal `TypeSpec` is synthesised
 * inline — same fallback shape undo.ts's own `targetFromEntry()` uses for an
 * unregistered type.
 */
function bopfTargetFromEntry(entry: JournalEntry, exists: boolean): ResolvedTarget {
  const spec: TypeSpec = specForType(entry.object.type) ?? {
    type: entry.object.type,
    kind: entry.object.type,
    label: "BOPF business object",
    path: entry.object.uri,
    mode: "source",
    supportsSource: false,
    keywords: [],
  };
  return {
    spec,
    type: entry.object.type,
    name: entry.object.name,
    uri: entry.object.uri,
    sourceUri: entry.object.sourceUri ?? entry.object.uri,
    packageName: entry.object.package,
    description: entry.object.description ?? "",
    exists,
    packageSource: "requested",
  };
}

// ---------------------------------------------------------------------------
// planSpecialUndo / performSpecialUndo — dispatchers
// ---------------------------------------------------------------------------

export async function planSpecialUndo(
  conn: AbapConnection,
  journal: Journal,
  entry: JournalEntry,
  kind: SpecialUndoKind,
  action: UndoAction,
): Promise<UndoPlan> {
  switch (kind) {
    case "text-pool":
      return planTextPoolUndo(conn, journal, entry, action);
    case "bopf-model":
      return planBopfModelUndo(conn, journal, entry, action);
    case "enh-delete":
      return planEnhDeleteUndo(conn, entry, action);
    case "enh-impl-active":
      return planEnhImplActiveUndo(conn, journal, entry, action);
  }
}

export async function performSpecialUndo(
  conn: AbapConnection,
  journal: Journal,
  entry: JournalEntry,
  plan: UndoPlan,
  opts: UndoOptions,
): Promise<UndoResult> {
  switch (plan.special) {
    case "text-pool":
      return performTextPoolUndo(conn, journal, entry, plan, opts);
    case "bopf-model":
      return performBopfModelUndo(conn, journal, entry, plan, opts);
    case "enh-delete":
      return performEnhDeleteUndo(conn, journal, entry, plan, opts);
    case "enh-impl-active":
      return performEnhImplActiveUndo(conn, journal, entry, plan, opts);
    default:
      // Unreachable: only called from undo.ts when plan.special is set.
      throw new AbapError(
        "BAD_INPUT",
        "performSpecialUndo called with a plan that has no special kind.",
        { entry: entry.id },
      );
  }
}

// ---------------------------------------------------------------------------
// text-pool
// ---------------------------------------------------------------------------

async function planTextPoolUndo(
  conn: AbapConnection,
  journal: Journal,
  entry: JournalEntry,
  action: UndoAction,
): Promise<UndoPlan> {
  const resourceType = entry.object.type;
  const ownerType = TEXT_POOL_OWNER_TYPE[resourceType];
  if (!ownerType) {
    throw new AbapError(
      "BAD_INPUT",
      `INTERNAL INVARIANT VIOLATED: text-pool undo reached for unrecognised resource type "${resourceType}".`,
      { type: resourceType },
    );
  }

  const target = await resolveWriteTarget(conn, {
    name: entry.object.name,
    type: ownerType,
    packageName: entry.object.package,
  });

  const before = await journal.beforeImage(entry);
  if (before === undefined) {
    return blockedPlan(
      entry,
      target,
      action,
      "text-pool",
      "No before-image was recorded for this text pool write; nothing to restore.",
    );
  }

  let currentImage: string;
  try {
    const current = await readTextPool(conn, target.name, ownerType);
    currentImage = textPoolImage(current, ownerType);
  } catch (e) {
    return blockedPlan(
      entry,
      target,
      action,
      "text-pool",
      `Could not read the current text pool: ${(e as Error).message}`,
    );
  }

  const beforeFingerprint = sourceFingerprint(before);
  const currentFingerprint = sourceFingerprint(currentImage);

  if (currentFingerprint === beforeFingerprint) {
    return noopPlan(entry, target, "text-pool", "the text pool already matches the before-image", before, currentImage);
  }

  if (entry.after === undefined) {
    return {
      entry,
      target,
      action,
      undoable: true,
      drift: {
        drifted: true,
        reason:
          "no after-image recorded; cannot tell whether someone changed the texts since; force=true to restore anyway",
        actualFingerprint: currentFingerprint,
      },
      restoreSource: before,
      currentSource: currentImage,
      currentlyExists: target.exists,
      special: "text-pool",
    };
  }

  if (currentFingerprint !== entry.after.fingerprint) {
    return {
      entry,
      target,
      action,
      undoable: true,
      drift: {
        drifted: true,
        reason: `the text pool was changed since this write (expected fingerprint ${entry.after.fingerprint}, found ${currentFingerprint})`,
        expectedFingerprint: entry.after.fingerprint,
        actualFingerprint: currentFingerprint,
      },
      restoreSource: before,
      currentSource: currentImage,
      currentlyExists: target.exists,
      special: "text-pool",
    };
  }

  return {
    entry,
    target,
    action,
    undoable: true,
    drift: { drifted: false, reason: "the text pool matches what this write left behind" },
    restoreSource: before,
    currentSource: currentImage,
    currentlyExists: target.exists,
    special: "text-pool",
  };
}

async function performTextPoolUndo(
  conn: AbapConnection,
  journal: Journal,
  entry: JournalEntry,
  plan: UndoPlan,
  opts: UndoOptions,
): Promise<UndoResult> {
  const ownerType = TEXT_POOL_OWNER_TYPE[entry.object.type]!;
  const before = plan.restoreSource!;
  const pool = parseTextPoolImage(before, ownerType);

  const authorized = assertOp(opts.assertAllowed(plan.action, plan.target), "write", entry, plan.action);

  const { result, entryId, settle } = await withJournalledMutation(
    journal,
    {
      begin: (xml: string) => ({
        operation: "update" as const,
        object: journalRef(plan.target),
        existedBefore: true,
        beforeCapture: "captured" as const,
        beforeSource: xml,
        beforeKind: "text-pool" as const,
        undoOf: entry.id,
        systemKey: systemKey(conn.cfg),
        tool: "abap_journal undo",
        ...(entry.corrNr !== undefined ? { corrNr: entry.corrNr } : {}),
      }),
    },
    async (onBeforeImage) => {
      const currentPool = await readTextPool(conn, plan.target.name, ownerType);
      await onBeforeImage(textPoolImage(currentPool, ownerType));
      return writeTextPool(conn, authorized, pool, { activate: opts.activate ?? true, corrNr: entry.corrNr });
    },
  );

  let afterSource: string | undefined;
  try {
    const readBack = await readTextPool(conn, plan.target.name, ownerType);
    afterSource = textPoolImage(readBack, ownerType);
  } catch {
    // Best-effort read-back only — omit on failure, per the brief.
  }

  await settle({ outcome: "succeeded", ...(afterSource !== undefined ? { afterSource } : {}) });
  if (entryId) await journal.markUndone(entry.id, entryId);
  return { plan, undoEntryId: entryId, performed: true, activation: result.activation, forced: Boolean(opts.force) };
}

// ---------------------------------------------------------------------------
// bopf-model
// ---------------------------------------------------------------------------

async function planBopfModelUndo(
  conn: AbapConnection,
  journal: Journal,
  entry: JournalEntry,
  action: UndoAction,
): Promise<UndoPlan> {
  const bo = entry.object.name;

  const before = await journal.beforeImage(entry);
  if (before === undefined) {
    const target = bopfTargetFromEntry(entry, true);
    return blockedPlan(
      entry,
      target,
      action,
      "bopf-model",
      "No before-image was recorded for this BOPF model update; nothing to restore.",
    );
  }

  let currentXml: string;
  try {
    const current = await readModel(conn, bo);
    currentXml = current.xml;
  } catch (e) {
    const target = bopfTargetFromEntry(entry, false);
    return blockedPlan(entry, target, action, "bopf-model", `Could not read the current BOPF model: ${(e as Error).message}`);
  }

  const target = bopfTargetFromEntry(entry, true);
  const beforeFingerprint = sourceFingerprint(bopfModelComparable(before));
  const currentFingerprint = sourceFingerprint(bopfModelComparable(currentXml));

  // IDs and timestamps change on every PUT/activation, so compare the comparable form.
  if (currentFingerprint === beforeFingerprint) {
    return noopPlan(entry, target, "bopf-model", "the model already matches the before-image", before, currentXml);
  }

  const afterText = await journal.afterImage(entry);
  if (afterText === undefined) {
    return {
      entry,
      target,
      action,
      undoable: true,
      drift: {
        drifted: true,
        reason:
          "no after-image recorded; cannot tell whether someone changed the model since; force=true to restore anyway",
        actualFingerprint: currentFingerprint,
      },
      restoreSource: before,
      currentSource: currentXml,
      currentlyExists: true,
      special: "bopf-model",
    };
  }

  const afterFingerprint = sourceFingerprint(bopfModelComparable(afterText));
  if (currentFingerprint !== afterFingerprint) {
    return {
      entry,
      target,
      action,
      undoable: true,
      drift: {
        drifted: true,
        reason: `the model was changed since this write (node IDs and change timestamps ignored; expected fingerprint ${afterFingerprint}, found ${currentFingerprint})`,
        expectedFingerprint: afterFingerprint,
        actualFingerprint: currentFingerprint,
      },
      restoreSource: before,
      currentSource: currentXml,
      currentlyExists: true,
      special: "bopf-model",
    };
  }

  return {
    entry,
    target,
    action,
    undoable: true,
    drift: { drifted: false, reason: "the model matches what this write left behind" },
    restoreSource: before,
    currentSource: currentXml,
    currentlyExists: true,
    special: "bopf-model",
  };
}

async function performBopfModelUndo(
  conn: AbapConnection,
  journal: Journal,
  entry: JournalEntry,
  plan: UndoPlan,
  opts: UndoOptions,
): Promise<UndoResult> {
  const bo = entry.object.name;
  const beforeXml = plan.restoreSource!;
  const packageName = entry.object.package;

  const authorized = assertOp(opts.assertAllowed(plan.action, plan.target), "write", entry, plan.action);
  // putModel needs the narrower "write" proof; the check above already
  // confirmed op === "write", so this retype is sound, not a bypass.
  const writeAuthorized = authorized as unknown as AuthorizedTarget<"write">;

  let fired = false;
  const { result: put, entryId, settle } = await withJournalledMutation(
    journal,
    {
      begin: (xml: string) => ({
        operation: "update" as const,
        object: journalRef(plan.target),
        existedBefore: true,
        beforeCapture: "captured" as const,
        beforeSource: xml,
        beforeKind: "bopf-model" as const,
        undoOf: entry.id,
        systemKey: systemKey(conn.cfg),
        tool: "abap_journal undo",
        ...(entry.corrNr !== undefined ? { corrNr: entry.corrNr } : {}),
      }),
    },
    (onBeforeImage) =>
      conn.withStatefulSession((session) =>
        putModel(
          conn,
          session,
          bo,
          async (xml) => {
            if (!fired) {
              fired = true;
              await onBeforeImage(xml);
            }
            // BOPF re-mints bo:nodeID on each PUT — remap before sending.
            return remapNodeIds(beforeXml, xml);
          },
          writeAuthorized,
          { transport: opts.transport, gate: opts.gate, corrNr: entry.corrNr, packageName },
        ),
      ),
  );

  await settle({
    outcome: "succeeded",
    afterSource: put.xml,
    ...(put.corr.kind === "transport" ? { corrNr: put.corr.corrNr } : {}),
  });

  // activateBusinessObject's ActivationOutcomeBopf shape is not
  // ActivationOutcome-compatible (see phase report) — attempted but not
  // surfaced through UndoResult.activation.
  if (opts.activate ?? true) {
    await activateBusinessObject(conn, bo);
  }

  if (entryId) await journal.markUndone(entry.id, entryId);
  return { plan, undoEntryId: entryId, performed: true, forced: Boolean(opts.force) };
}

// ---------------------------------------------------------------------------
// enh-delete (undo of create_spot/create_impl/create_hook)
// ---------------------------------------------------------------------------

function usageRowLabel(row: Record<string, unknown>): string {
  const type = typeof row["adtcore:type"] === "string" ? (row["adtcore:type"] as string) : "?";
  const name = typeof row["adtcore:name"] === "string" ? (row["adtcore:name"] as string) : "?";
  return `${type} ${name}`;
}

async function planEnhDeleteUndo(
  conn: AbapConnection,
  entry: JournalEntry,
  action: UndoAction,
): Promise<UndoPlan> {
  const type = entry.object.type as EnhancementDocType;
  const name = entry.object.name;
  const reader = ENH_READERS[type];

  let xml: string;
  let data: unknown;
  try {
    const doc = await reader(conn, name);
    xml = doc.xml;
    data = doc.data;
  } catch (e) {
    if (isGone(e)) {
      const target = enhancementTargetFromEntry(entry, false);
      return noopPlan(entry, target, "enh-delete", "the object no longer exists; nothing to undo");
    }
    const target = enhancementTargetFromEntry(entry, false);
    return blockedPlan(
      entry,
      target,
      action,
      "enh-delete",
      `Could not verify whether ${name} still exists: ${(e as Error).message}`,
    );
  }

  const target = enhancementTargetFromEntry(entry, true);

  if (entry.object.affects === undefined) {
    return blockedPlan(
      entry,
      target,
      action,
      "enh-delete",
      "This entry has no recorded affected object; refusing to delete without it.",
    );
  }

  try {
    const { refs } = await fetchUsageReferences(conn, entry.object.uri, undefined, name);
    const others = refs.filter((row) => {
      const rowName = typeof row["adtcore:name"] === "string" ? (row["adtcore:name"] as string) : undefined;
      return rowName === undefined || rowName.toUpperCase() !== name.toUpperCase();
    });
    if (others.length > 0) {
      const names = others.slice(0, 5).map(usageRowLabel).join(", ");
      return blockedPlan(
        entry,
        target,
        action,
        "enh-delete",
        `${name} is referenced by: ${names}${others.length > 5 ? ", …" : ""}; refusing to delete something in use.`,
      );
    }
  } catch (e) {
    return blockedPlan(
      entry,
      target,
      action,
      "enh-delete",
      `the dependency check (where-used) failed: ${(e as Error).message}; refusing rather than deleting blind`,
    );
  }

  if (type === "ENHO/XH") {
    const badi = data as BadiImplementationRead;
    const active = badi.implementations.filter((impl) => impl.isActive !== false);
    if (active.length > 0) {
      const names = active.map((impl) => impl.name).join(", ");
      return blockedPlan(
        entry,
        target,
        action,
        "enh-delete",
        `${name} has active BAdI implementation entr${active.length === 1 ? "y" : "ies"}: ${names}; refusing to delete an active implementation.`,
      );
    }
  }

  return {
    entry,
    target,
    action,
    undoable: true,
    drift: { drifted: false, reason: "the object still exists and has no blocking dependents" },
    restoreSource: xml,
    currentSource: xml,
    currentlyExists: true,
    special: "enh-delete",
  };
}

async function performEnhDeleteUndo(
  conn: AbapConnection,
  journal: Journal,
  entry: JournalEntry,
  plan: UndoPlan,
  opts: UndoOptions,
): Promise<UndoResult> {
  // Config gate: plan-time has no `opts`, so this check — deliberately the
  // same shape as deleteEnhancementObject's own — runs here, before any
  // mutating call, rather than as a plan.blocker.
  if (opts.enhancement === undefined || opts.enhancement.allowEnhancementDelete !== true) {
    const why = explainDeniedCapability("allowEnhancementDelete", opts.enhancement?.abapMode);
    throw new AbapError(
      "ENHANCEMENT_DISABLED",
      `Deleting an existing enhancement object is disabled. ${why.cause}`,
      { type: entry.object.type, name: entry.object.name },
      why.remediation,
    );
  }

  if (opts.transport === undefined) {
    throw new AbapError(
      "TRANSPORT_ERROR",
      `Undo of ${entry.object.type} ${entry.object.name} needs a transport manager, but none was wired ` +
        "into this undo. Nothing was deleted.",
      { name: entry.object.name, type: entry.object.type },
      "This is an internal wiring failure in abapsmith, not a mistake in the request.",
    );
  }

  const type = entry.object.type as EnhancementDocType;
  const name = entry.object.name;
  const affects = entry.object.affects!;
  const transport = opts.transport;

  const { result: del, entryId, settle } = await withJournalledMutation(
    journal,
    {
      begin: (img: EnhancementDeleteBeforeImage) => ({
        operation: "delete" as const,
        object: { ...journalRef(img.target), affects: img.affects },
        existedBefore: true,
        beforeCapture: "captured" as const,
        beforeSource: img.xml,
        undoOf: entry.id,
        systemKey: systemKey(conn.cfg),
        tool: "abap_journal undo",
        irreversible: true,
        undoBlocker: "A deleted enhancement object cannot be recreated from its XML; recreate it with abap_enh.",
        ...(img.corrNr !== undefined ? { corrNr: img.corrNr } : {}),
      }),
    },
    (onBeforeImage) =>
      deleteEnhancementObject(
        conn,
        opts.gate,
        { type, name },
        {
          transport,
          gate: opts.gate,
          corrNr: entry.corrNr,
          affects,
          onBeforeImage,
          allowEnhancementDelete: opts.enhancement!.allowEnhancementDelete,
          ...(opts.enhancement!.abapMode !== undefined ? { abapMode: opts.enhancement!.abapMode } : {}),
        },
      ),
  );

  await settle({
    outcome: "succeeded",
    ...(del.transport.status === "transport" ? { corrNr: del.transport.corrNr } : {}),
  });

  if (entryId) await journal.markUndone(entry.id, entryId);
  return { plan, undoEntryId: entryId, performed: true, forced: Boolean(opts.force) };
}

// ---------------------------------------------------------------------------
// enh-impl-active (undo of set_impl_active)
// ---------------------------------------------------------------------------

function findImpl(entries: readonly BadiImplementationRead["implementations"][number][], implName: string) {
  return entries.find((impl) => impl.name === implName);
}

async function planEnhImplActiveUndo(
  conn: AbapConnection,
  journal: Journal,
  entry: JournalEntry,
  action: UndoAction,
): Promise<UndoPlan> {
  const name = entry.object.name;

  let live: BadiImplementationRead;
  try {
    live = (await readBadiImplementation(conn, name)).data;
  } catch (e) {
    const target = enhancementTargetFromEntry(entry, !isGone(e));
    if (isGone(e)) {
      return blockedPlan(entry, target, action, "enh-impl-active", "the implementation object no longer exists; cannot restore its active state");
    }
    return blockedPlan(entry, target, action, "enh-impl-active", `Could not read the current implementation: ${(e as Error).message}`);
  }

  const target = enhancementTargetFromEntry(entry, true);

  const before = await journal.beforeImage(entry);
  if (before === undefined) {
    return blockedPlan(entry, target, action, "enh-impl-active", "No before-image was recorded for this active-flag change; nothing to restore.");
  }

  const parsedBefore = parseBadiImplementation(before);
  const implName = entry.implName ?? parsedBefore.implementations[0]?.name;
  if (implName === undefined) {
    return blockedPlan(entry, target, action, "enh-impl-active", "Cannot determine which implementation to restore (no implName recorded).");
  }

  const previousActive = findImpl(parsedBefore.implementations, implName)?.isActive;
  const currentActive = findImpl(live.implementations, implName)?.isActive;

  if (currentActive === previousActive) {
    return noopPlan(entry, target, "enh-impl-active", "the implementation's active flag already matches the before-image", before);
  }

  // A no-op set_impl_active never reaches begin() (setBadiImplementationActive
  // short-circuits before onBeforeImage), so any journalled entry of this kind
  // is the product of a real change — entry.after should always be present.
  // Fall back to the same drift-shaped refusal as text-pool if it is ever
  // missing (legacy/defensive case, not expected in practice).
  const after = await journal.afterImage(entry);
  if (after === undefined) {
    return {
      entry,
      target,
      action,
      undoable: true,
      drift: {
        drifted: true,
        reason: "no after-image recorded; cannot tell whether someone changed the active flag since; force=true to restore anyway",
      },
      restoreSource: before,
      currentlyExists: true,
      special: "enh-impl-active",
    };
  }

  const parsedAfter = parseBadiImplementation(after);
  const expectedActive = findImpl(parsedAfter.implementations, implName)?.isActive;

  if (currentActive !== expectedActive) {
    return {
      entry,
      target,
      action,
      undoable: true,
      drift: {
        drifted: true,
        reason: `the active flag was changed since this write (expected ${String(expectedActive)}, found ${String(currentActive)})`,
      },
      restoreSource: before,
      currentlyExists: true,
      special: "enh-impl-active",
    };
  }

  return {
    entry,
    target,
    action,
    undoable: true,
    drift: { drifted: false, reason: "the active flag matches what this write left behind" },
    restoreSource: before,
    currentlyExists: true,
    special: "enh-impl-active",
  };
}

async function performEnhImplActiveUndo(
  conn: AbapConnection,
  journal: Journal,
  entry: JournalEntry,
  plan: UndoPlan,
  opts: UndoOptions,
): Promise<UndoResult> {
  if (opts.transport === undefined) {
    throw new AbapError(
      "TRANSPORT_ERROR",
      `Undo of ${entry.object.type} ${entry.object.name} needs a transport manager, but none was wired ` +
        "into this undo. Nothing was changed.",
      { name: entry.object.name, type: entry.object.type },
      "This is an internal wiring failure in abapsmith, not a mistake in the request.",
    );
  }
  const transport = opts.transport;

  const before = plan.restoreSource!;
  const parsedBefore = parseBadiImplementation(before);
  const implName = entry.implName ?? parsedBefore.implementations[0]?.name;
  if (implName === undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `INTERNAL INVARIANT VIOLATED: enh-impl-active undo performed for ${entry.object.name} with no implName resolvable.`,
      { entry: entry.id },
    );
  }
  const activeToRestore = findImpl(parsedBefore.implementations, implName)?.isActive === true;
  const affects = entry.object.affects!;

  const { result: set, entryId, settle } = await withJournalledMutation(
    journal,
    {
      begin: (img: EnhancementBeforeImage) => ({
        operation: "update" as const,
        object: { ...journalRef(img.target), affects: img.affects },
        existedBefore: true,
        beforeCapture: "captured" as const,
        beforeSource: img.xml,
        beforeKind: "enh-impl-active" as const,
        implName,
        undoOf: entry.id,
        systemKey: systemKey(conn.cfg),
        tool: "abap_journal undo",
        ...(img.corrNr !== undefined ? { corrNr: img.corrNr } : {}),
      }),
    },
    (onBeforeImage) =>
      setBadiImplementationActive(
        conn,
        opts.gate,
        { name: entry.object.name, active: activeToRestore, implName },
        { transport, gate: opts.gate, corrNr: entry.corrNr, affects, onBeforeImage },
      ),
  );

  await settle({
    activation: { attempted: false },
    ...(set.transport.status === "transport" ? { corrNr: set.transport.corrNr } : {}),
    afterSource: set.xml,
    outcome: "succeeded",
  });

  let activation: UndoResult["activation"];
  if (set.changed) {
    const finalIntent = enhancementIntentFor(
      {
        name: set.target.name,
        type: "ENHO/XH",
        packageName: set.target.packageName,
        ...(set.target.masterSystem !== undefined ? { masterSystem: set.target.masterSystem } : {}),
      },
      affects,
    );
    opts.gate.assertIntent(finalIntent, { op: "activate" });
    activation = await activateObject(conn, { name: set.target.name, uri: set.target.uri });
    await settle({ outcome: "succeeded", activation: { attempted: true, activated: activation.activated } });
  }

  if (entryId) await journal.markUndone(entry.id, entryId);
  return { plan, undoEntryId: entryId, performed: true, ...(activation !== undefined ? { activation } : {}), forced: Boolean(opts.force) };
}
