/**
 * `abap_write` — one tool for create/update/delete (`mode`). `lock`/`unlock`
 * are deliberately not exposed separately (risk of a forgotten unlock); the
 * lock spans only the PUT, inside `writeObject`.
 *
 * Lifecycle: resolve target + safety gate (authorizeMutation) → create-if-missing
 * → lock → PUT → unlock (writeObject) → checkrun → activation (only if clean).
 *
 * Once the PUT returns, the source is on the server regardless of what
 * happens next, so a failing check/activation is reported as saved-but-INACTIVE
 * (journal already settled `succeeded`), never as "the write failed".
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  activateObject,
  assertNoErrors,
  checkSource,
  prettyPrintSource,
  renderInactive,
  renderMessages,
} from "../adt/activate.js";
import type { ActivationOutcome, CheckOutcome, FormatOutcome } from "../adt/activate.js";
import type { AbapConnection } from "../adt/connection.js";
import { renderCoActivated } from "./activate.js";
// Imported directly from capabilities.ts, not via this file's re-export:
// this module is `vi.mock`ed wholesale by test/tools.test.ts, so routing a
// pure lookup through that seam breaks mocked tests for no benefit.
import {
  capabilitiesFor,
  isBridgeCreatableType,
  isBridgeOnlyCreateType,
  NON_WRITABLE_TYPES,
} from "../adt/capabilities.js";
import { DDIC_BRIDGE_CLASS, type DdicTranscript } from "../adt/ddic-bridge.js";
import { discardedDescriptorValues, type DiscardedValue } from "../adt/descriptor-fidelity.js";
import { createPackageViaBridge, tdevcDiscrepancies } from "../adt/package-create.js";
import type { RunResult } from "../adt/run.js";
import { serverPackage } from "../adt/resolved-package.js";
import { isLocalPackageName } from "../adt/transports.js";
import { assertTransactionCreateTarget, createTransaction } from "../adt/tran-create.js";
import { deleteTransactionViaBridge } from "../adt/tran-delete.js";
import { assertClassicViewCreateTarget, createClassicView } from "../adt/view-create.js";
import { deleteClassicViewViaBridge } from "../adt/view-delete.js";
import {
  verifyObjectCreated,
  verifyObjectDeleted,
  verifyObjectPresent,
  verifyViaRepositorySearch,
  verifyViaVitBridge,
  vitBridgeUri,
  VIT_STUB_ACCEPT,
  type VerifyOutcome,
} from "../adt/write-verify.js";
import { assertDdicDescriptorShape, buildStructuredDdicDescriptor, ddicDescriptorSkeleton } from "../adt/ddic-payload.js";
import { AbapError, isAbapError } from "../adt/errors.js";
import type { SessionPool } from "../adt/pool.js";
import { parseObjectRef } from "../adt/resolve.js";
import type { ResolvedObject } from "../adt/resolve.js";
import type { SessionTransport } from "../adt/session-transport.js";
import {
  countMethodKeywordLines,
  methodNamesMatch,
  readMethod,
  scanMethodBlocks,
} from "../adt/source.js";
import type { MethodBlock, SourceRange } from "../adt/source.js";
import { CLASS_INCLUDES, specForKeyword, specForType } from "../adt/types.js";
import {
  activationFromBody,
  assertNoDuplicateDeleteTargets,
  authorizeMutation,
  canonicalEtag,
  contentAccept,
  contentUri,
  createPackage,
  deleteObject,
  isPackageType,
  MAX_DELETE_BATCH,
  PACKAGE_SOFTWARE_COMPONENT_HINT,
  preflightPackageCorr,
  readCurrentSource,
  resolveWriteTarget,
  writeObject,
} from "../adt/write.js";
import type {
  BeforeImage,
  EnhancedObjectRef,
  PreflightTarget,
  ResolvedTarget,
  TransportInfo,
  TransportOptions,
  WriteTarget,
} from "../adt/write.js";
import { buildResponse, stripPartialEtag, type BuiltResponse } from "../compact.js";
import type { Config, VerifyWritesMode } from "../config.js";
import type { BeforeImageCapture, Journal } from "../journal.js";
import { journalRef, systemKey, withJournalledMutation } from "../journal.js";
import { normalizeCorrNr, type AuthorizedTarget, type MutatingOperation, type SafetyGate } from "../safety.js";
import { applyEdit, describeEditFailure, EditInputError } from "./v2/edit.js";
import { buildDeleteDryRunResponse, buildWriteDryRunResponse, dryRunNotSupported } from "./write-dry-run.js";
import { enhancementPreflightIntent, preflight, writeGateKey } from "./preflight.js";

// Mirrors the top-level `affects` field below, kept as a separate literal
// (not shared) so editing that field's prose can't silently change every
// batch-delete entry's schema too. Used only inside `objects`.
const deleteEntryAffectsSchema = z.object({
  name: z.string().describe("Object this enhancement binds to."),
  packageName: z.string().describe("Its package."),
  masterSystem: z.string().optional().describe("Its masterSystem. Omit for local/$TMP."),
  spotName: z.string().optional().describe("Enhancement spot, if reached via one."),
});

export const writeInputSchema = {
  object: z.string().optional().describe("Object reference."),
  type: z
    .string()
    .optional()
    .describe(`ADT type of a NEW object, e.g. CLAS/OC. Not writable: ${NON_WRITABLE_TYPES.join(" ")}.`),
  source: z
    .string()
    .optional()
    .describe("Full source, required unless deleting."),
  // `edit`/`method` must be declared here: zod strips undeclared keys before
  // the callback sees them, so an undeclared `method` silently fell through
  // to the whole-object-rewrite branch instead of erroring — see
  // the git history for the incident.
  edit: z
    .object({
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    })
    .optional()
    .describe("Splice a unique old_string; skip `source`."),
  method: z
    .string()
    .optional()
    .describe("One method to replace; body in `source`."),
  // `source`/`edit`/`method` all apply to the include named here
  // (`resolveWriteTarget` builds `sourceUri` from it). Must be declared for
  // the same zod-strips-undeclared-keys reason as `edit`/`method` above — an
  // undeclared `include:"testclasses"` would silently overwrite MAIN source.
  // `z.enum(CLASS_INCLUDES)`, matching `readInputSchema.include`
  // (src/tools/read.ts), turns a typo into a schema rejection.
  include: z
    .enum(CLASS_INCLUDES)
    .optional()
    .describe("CLAS/OC only; testclasses=ABAP Unit tests, default main."),
  package: z
    .string()
    .optional()
    .describe(
      "Package for a NEW object. Default $TMP. VIEW/DV and TRAN/T: a transportable one needs " +
        "corr_nr, a $-package refuses it.",
    ),
  description: z
    .string()
    .optional()
    .describe("Required to create a TRAN/T. Max 37 chars."),
  // Structured create for the three XML-only DDIC types, so a
  // caller doesn't have to hand-compose the descriptor. Builder + grounding
  // citation live in src/adt/ddic-payload.ts (buildStructuredDdicDescriptor);
  // this schema only lists the fields that builder actually accepts. Kept
  // flat and terse — schema prose here is billed on every `tools/list`.
  ddic: z
    .object({
      dataType: z.string().optional(),
      length: z.number().optional(),
      decimals: z.number().optional(),
      outputLength: z.number().optional(),
      lowercase: z.boolean().optional(),
      signExists: z.boolean().optional(),
      typeKind: z.enum(["domain", "predefinedAbapType", "dictionaryType"]).optional(),
      typeName: z.string().optional(),
      shortLabel: z.string().optional(),
      shortLength: z.number().optional(),
      mediumLabel: z.string().optional(),
      mediumLength: z.number().optional(),
      longLabel: z.string().optional(),
      longLength: z.number().optional(),
      headingLabel: z.string().optional(),
      headingLength: z.number().optional(),
    })
    .strict()
    .optional()
    .describe("DOMA/DD, DTEL/DE, TTYP/DA: alt to `source`, never both."),
  expect_etag: z.string().optional().describe("Etag from abap_read; fails if changed."),
  mode: z.enum(["write", "delete"]).optional().describe("Default write."),
  activate: z.boolean().optional().describe("Default true."),
  verify: z.boolean().optional().describe("Force verified mode; reads back after write."),
  format: z.boolean().optional().describe("Pretty-print source before writing."),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Preview only: resolve, read, apply the edit locally, run the safety gate, and return the " +
        "diff and the expect_etag a real write would assert. Makes no lock, PUT, DELETE, " +
        "activation, unlock or transport call and journals nothing.",
    ),
  corr_nr: z
    .string()
    .optional()
    .describe(
      "Transport request. $TMP needs none. Required for a VIEW/DV or TRAN/T create into a " +
        "transportable package, refused for a $ package. Refused on VIEW/DV or TRAN/T delete.",
    ),
  software_component: z.string().optional().describe("DEVC/K required: LOCAL or transportable."),
  package_type: z.string().optional().describe("DEVC/K only. Default development."),
  transport_layer: z.string().optional().describe("DEVC/K only. Default empty."),
  // The three fields the classrun-bridge create needs and no existing field
  // can carry (src/adt/ddic-bridge.ts); everything else (name, description,
  // package, corr_nr) is already on this shape, which is why this extends
  // `abap_write` rather than being a new tool. Descriptions kept terse
  // deliberately: schema prose is billed on every `tools/list`, while the
  // fuller guidance is billed only to a caller who gets it wrong
  // (`abapCreateViaBridge`, below) — see test/tools.test.ts's "tool surface".
  base_table: z.string().optional().describe("VIEW/DV create only: the single base table the view projects."),
  view_fields: z
    .array(z.string())
    .optional()
    .describe("VIEW/DV create only: base-table fields to project, in order."),
  // "EXISTING" and "SUBMIT-only" are load-bearing: abapsmith checks the
  // program exists first, and RPY_TRANSACTION_INSERT only wires a
  // report/SUBMIT transaction, never a dialog one.
  program: z
    .string()
    .optional()
    .describe("TRAN/T, required: existing SUBMIT-only report."),
  // Same shape/wording as abap_enh's `affects` field (src/tools/enh.ts), so
  // callers share one vocabulary. Required for an enhancement-type write
  // (ENHO/XHH): the gate can't judge one from name/package/URI alone.
  affects: z
    .object({
      name: z.string().describe("Object this enhancement binds to."),
      packageName: z.string().describe("Its package."),
      // Absent masterSystem is treated as LOCAL and never refused, same for a
      // value equal to this server's own SID; only a genuinely foreign SID is
      // judged against ABAP_ENHANCE_TARGETS/ABAP_ORIGIN_SYSTEMS. That policy
      // lives in the refusal (safety.ts), not here — same trim as abap_debug's
      // `force` (test/tools.test.ts).
      masterSystem: z.string().optional().describe("Its masterSystem. Omit for local/$TMP."),
      spotName: z.string().optional().describe("Enhancement spot, if reached via one."),
    })
    .optional()
    .describe("REQUIRED for enhancement types (ENHO/XHH)."),
  // Batch delete only — the ONLY batch form `abap_write` accepts (no batch
  // create/edit; write is naturally one-object-at-a-time). Mirrors
  // `abap_activate`'s `objects` shape, but UNLIKE activation there is no
  // server-side batch-delete endpoint: `abapWriteBatchDelete` is a
  // client-side loop of the normal lock→DELETE→unlock per object, saving
  // model turns, not requests or server load.
  //
  // Exactly one of `object`/`objects`, never both. `mode: "delete"` must be
  // given explicitly (write's default mode is "write", unlike activate's).
  // Deleted IN THE ORDER GIVEN — abapsmith does not compute dependency order,
  // so the caller must list dependents before dependencies.
  //
  // The whole set is validated first (resolves, deletable, gated, no dupes)
  // and the batch is refused entirely if any entry fails — except an entry
  // that does not exist, which is reported per-entry as already-absent
  // instead of aborting the batch. Once deletion starts, one failure does
  // not stop the rest — every object is deleted and
  // journalled (with its own before-image) individually before the next is
  // attempted, so a batch that dies halfway leaves an accurate per-object
  // record for `abap_journal mode=undo`. That per-object continuation
  // is execution only — the RETURNED envelope throws CHECK_FAILED (isError)
  // if even one object was not deleted, so a caller keying on `isError` is
  // never told a delete happened when it did not.
  objects: z
    .array(
      z.object({
        object: z.string().describe("Object to delete. Same spelling `object` accepts."),
        type: z.string().optional().describe("ADT type, if the name alone is ambiguous."),
        affects: deleteEntryAffectsSchema
          .optional()
          .describe("REQUIRED for this entry if it names an enhancement type (ENHO/XHH)."),
      }),
    )
    .min(1)
    .max(MAX_DELETE_BATCH)
    .optional()
    .describe(`Batch delete ≤${MAX_DELETE_BATCH}; mode=delete, replaces \`object\`.`),
};

export const WriteInput = z.object(writeInputSchema);
export type WriteInput = z.infer<typeof WriteInput>;

/**
 * Parses `object`/`type` into a `WriteTarget`, hinting the parse the same way
 * `resolveWriteTarget` hints its own and passing `containerName` explicitly
 * rather than relying on it surviving a round trip through a string —
 * dropping the parent used to break `FUGR/FF`-style container types; see
 * the git history for the incident.
 *
 * Exported for `test/write.test.ts` only: a pure function of input + type
 * registry, needing no connection, fake or route table to pin.
 */
export function targetFromInput(input: WriteInput & { object: string }): WriteTarget {
  const hint = input.type ? (specForType(input.type) ?? specForKeyword(input.type)) : undefined;
  const parsed = parseObjectRef(input.object, hint);
  const target: WriteTarget = { name: parsed.name };
  if (parsed.parent) target.containerName = parsed.parent;
  const type = input.type ?? parsed.spec?.type;
  if (type) target.type = type;
  if (input.package) target.packageName = input.package;
  if (input.description) target.description = input.description;
  if (input.affects) target.affects = input.affects;
  // The one hop from tool input to `WriteTarget`; everything downstream reads
  // `include` from the target, never from `input`. Passed through AS GIVEN,
  // including an explicit `"main"` — `ResolvedTarget.include` distinguishes
  // "caller said nothing" (undefined) from "caller asked for main".
  if (input.include) target.include = input.include;
  return target;
}

/**
 * Turns `input.ddic` into the same `source` string a caller
 * would otherwise have to hand-compose, via {@link buildStructuredDdicDescriptor}
 * — called BEFORE the normal source-resolution branch below, so the result
 * flows through {@link assertDdicDescriptorShape} downstream exactly like any
 * other `source`, with no separate validation path.
 */
function resolveDdicStructuredSource(input: WriteInputV2, target: WriteTarget): string {
  if (input.source !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      "`source` and `ddic` cannot both be given — they are two ways to build the same descriptor.",
      { name: target.name, type: target.type },
      "Drop one: `ddic` for a structured create of DOMA/DD, DTEL/DE, or TTYP/DA, or `source` for " +
        "hand-composed XML (any type, including these three).",
    );
  }
  if (!target.type) {
    throw new AbapError(
      "BAD_INPUT",
      "`ddic` requires `type` to be given explicitly (DOMA/DD, DTEL/DE, or TTYP/DA).",
      { name: target.name },
      "Add `type`, or drop `ddic` and pass hand-composed XML via `source`.",
    );
  }
  const description = target.description?.trim();
  if (!description) {
    throw new AbapError(
      "BAD_INPUT",
      `\`description\` is required to create a ${target.type} with \`ddic\` — it is the object's ` +
        "short text, and the descriptor has no default for it.",
      { name: target.name, type: target.type },
      "Add `description`.",
    );
  }
  const packageName = target.packageName?.trim() || "$TMP";
  return buildStructuredDdicDescriptor(target.type, target.name, description, packageName, input.ddic!);
}

/**
 * `enhancementPreflightIntent` lives in src/tools/preflight.ts next to
 * `preflight()` — the two must always be called in pairs when a registrar's
 * `type` can be an enhancement type. Re-exported for existing imports.
 */
export { enhancementPreflightIntent };

/**
 * Switches on `t.status` (the three-way epistemic answer `TransportInfo`
 * carries) rather than on `required`/`changed`, so this never has to
 * reconstruct status from proxy signals.
 *
 * The transportable note blends three DIFFERENT epistemic statuses — do not
 * blur them: `corrNr` is what abapsmith DID (the gate-approved request);
 * `required`/`corrText` are what the SERVER reported off the lock response
 * (when abapsmith created the request itself, `corrText` is its own
 * description round-tripping back, not independent confirmation); "the
 * object is in that request" is an ASSUMPTION — no write path re-reads the
 * request's object list, and membership was only ever observed once by hand.
 */
function transportNote(t: TransportInfo, abapMode?: string): string {
  switch (t.status) {
    case "local":
      return "Local object ($TMP-style): the lock reported no transport, so there is nothing to release.";
    case "transport":
      return (
        `Transport ${t.corrNr ?? "(unassigned)"}${t.corrText ? ` — ${t.corrText}` : ""}. ` +
        "That is the number this write sent, after the safety gate approved it; the text is as " +
        "the lock response reported it. abapsmith did NOT re-read the request to confirm the " +
        "object is in it. abap_write never releases a transport — releasing is a separate tool, " +
        "abap_transport_release, which stays off unless " +
        // Name the lever actually in force. `admin` is the REQUIRED mode for
        // release, not the current one — do not interpolate `abapMode` here.
        // Mirrors the identical note in src/tools/activate.ts.
        (abapMode !== undefined
          ? "ABAP_MODE=admin (ABAP_ALLOW_TRANSPORT_RELEASE is not read while ABAP_MODE is set)."
          : "ABAP_ALLOW_TRANSPORT_RELEASE is set.")
      );
    case "not-determined":
      return (
        "Nothing was resolved: no transport question was asked of the ABAP system. Reason: " +
        t.reason
      );
    /* istanbul ignore next -- exhaustiveness guard, not a reachable branch */
    default: {
      const _exhaustive: never = t;
      throw new Error(`Unhandled TransportInfo.status: ${String((_exhaustive as TransportInfo).status)}`);
    }
  }
}

/**
 * Short form of `TransportInfo` for the response header (`transportNote`
 * above carries the full explanation in `notes`). Same three-way switch on
 * `status` as `transportNote`.
 */
function transportHeaderText(t: TransportInfo): string {
  switch (t.status) {
    case "local":
      return "none ($TMP/local)";
    case "transport":
      return t.corrNr ?? "required";
    case "not-determined":
      return "n/a (nothing written, no transport resolved)";
    /* istanbul ignore next -- exhaustiveness guard, not a reachable branch */
    default: {
      const _exhaustive: never = t;
      throw new Error(`Unhandled TransportInfo.status: ${String((_exhaustive as TransportInfo).status)}`);
    }
  }
}

/**
 * Provenance of the before-image, translated into the journal's vocabulary
 * (`beforeCapture`, the one channel for this — no second parallel flag).
 *
 *  - absent → "confirmed-absent": `img.existed` is a real GET result
 *    (`isNotFoundError`), not a guess — `deleteEvidenceBlocker`/`performUndo`
 *    (src/adt/undo.ts) refuse any weaker value, and reporting "unknown" here
 *    made undo of a freshly created object permanently impossible.
 *  - read failed → "failed": `existedBefore` is a guess, nothing downstream may act on it.
 *  - existed + bytes held → "captured".
 *  - existed + no bytes → "failed", never "captured" (nothing to restore) —
 *    see `captureExplanation()` in src/adt/undo.ts.
 */
function captureOf(img: BeforeImage): BeforeImageCapture {
  if (!img.existed) return "confirmed-absent";
  // Dead today — writeObject/deleteObject hardcode sourceReadable: true
  // (src/adt/write.ts) — kept as a guard for if that ever stops being true.
  if (!img.sourceReadable) return "failed";
  return img.source !== undefined ? "captured" : "failed";
}

/**
 * The mode=delete response's undo-ability note — selected by the JOURNAL'S
 * OWN capture outcome (`captureOf`, above) plus the before-image's KIND,
 * never guessed from the object's type alone. A package's metadata XML
 * counts as a genuine capture (`captureOf` returns `"captured"` for it), but
 * it is not source, so it gets its own branch: the entry preserves the
 * metadata, and undo does not re-create the package from it.
 *
 * Only `"captured"` and `"failed"` are reachable through `abap_write`'s
 * mode=delete path: `authorizeMutation` already refuses NOT_FOUND before
 * `deleteObject` ever calls its `onBeforeImage` hook, so `img.existed` is
 * always `true` here and `captureOf` can never return `"confirmed-absent"`
 * on this path. `"confirmed-absent"`/`"unknown"` are handled below anyway,
 * generically, so nothing here silently mis-describes a value it wasn't
 * written to expect if that invariant ever changes.
 */
function deleteJournalNote(
  entryId: string,
  capture: BeforeImageCapture,
  type: string,
  name: string,
  kind?: "package-metadata",
): string {
  if (capture === "captured" && kind === "package-metadata") {
    return (
      `The package's metadata was journalled as ${entryId} before the delete — a package has no ` +
      `source, so that is the whole before-image, and abap_journal mode=undo will NOT re-create ` +
      `${type} ${name} from it. Re-create it with abap_write type="DEVC/K" if you need it back.`
    );
  }
  if (capture === "captured") {
    return (
      `The source was journalled as ${entryId} before the delete — ` +
      `abap_journal mode=undo entry=${entryId} re-creates the object from it.`
    );
  }
  return (
    `A journal entry was recorded as ${entryId} for the audit trail, but no source was captured ` +
    `for ${type} ${name} (beforeCapture="${capture}") — abap_journal mode=undo CANNOT restore it ` +
    "from this entry; this deletion is effectively irreversible."
  );
}

/**
 * Renders a {@link VerifyOutcome} for a human sentence — the uri, plus
 * whichever of `via`/`reason` the outcome actually carries (mutually
 * exclusive on the type). Shared by the single-object delete's CHECK_FAILED
 * message and the batch delete path's per-entry error, so the two describe
 * the same contradiction the same way.
 */
function describeVerification(v: VerifyOutcome): string {
  const parts = [`uri ${v.uri}`];
  if (v.status !== "indeterminate") parts.push(`via ${v.via}`);
  else parts.push(v.reason);
  return parts.join(", ");
}

/**
 * `res.deleted === false` means a read-back AND an independent
 * repository search both still find the object — the DELETE reached the
 * server (it is journalled, hence recoverable through abap_journal
 * mode=undo) but did not do what it was accepted to do. One sentence, shared
 * between the single-object delete's CHECK_FAILED throw (full) and the batch
 * delete path's per-entry error (shortened by the caller).
 */
function deleteNotConfirmedSentence(type: string, name: string, verification: VerifyOutcome): string {
  return (
    `the DELETE of ${type} ${name} was accepted, but a read-back and an independent repository ` +
    `search both still find the object (${describeVerification(verification)})`
  );
}

/**
 * DEVC/K delete only: the classrun bridge's SAVE was
 * observed on a live system to NOT record the deletion into the named
 * transport. Non-package deletes use the ordinary DELETE path and don't get
 * this warning.
 */
function packageDeleteTransportNote(corrNr: string): string {
  return (
    `Transport ${corrNr} was gate-approved and passed to the delete bridge, but on a live system ` +
    `this was observed to NOT record the deletion into ${corrNr} (or into any other request) — ` +
    "package deletes run through CL_PACKAGE_FACTORY's own SAVE, not the ordinary ADT DELETE this " +
    "field usually confirms. Do not infer the deletion is captured in this transport."
  );
}

/**
 * VIEW/DV and TRAN/T bridge delete only, non-$ package: the bridge passes no
 * request and issues no RS_CORR_INSERT, so this delete registers nothing in
 * CTS — any entry the object already had on a transport request (typically
 * its create) survives it.
 */
function bridgeDeleteTransportEntryNote(label: string, name: string, packageName: string): string {
  return (
    `${label} ${name} was in transportable package ${packageName}, but this delete recorded nothing ` +
    "in CTS — the bridge passes no request and issues no RS_CORR_INSERT. Any entry it already had " +
    'on a transport request survives it; remove it with `abap_transport` operation: "removeObject" ' +
    "(transport, object, confirm), which needs ABAP_MODE=admin."
  );
}

/** `abap_write`'s `edit` form (v2). */
export interface WriteEdit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * `edit`/`method` are now declared directly in `writeInputSchema`, so
 * `WriteInput` already carries them. This is kept as an ALIAS (not a
 * hand-widened `extends`) so there remains exactly ONE list of fields
 * `abap_write` accepts — the schema — and the core can no longer read a
 * field the schema doesn't declare (see the `edit` field comment above for
 * the incident this fixed).
 */
export type WriteInputV2 = WriteInput;

/**
 * Adapts `t: ResolvedTarget` (write/authorize pipeline) into the
 * `ResolvedObject` shape `readMethod`/`classMembers` (src/adt/source.js)
 * want, avoiding a second `resolveObject` round trip. Every field those two
 * functions actually read (`.uri`, `.type`, `.name`) comes from `t`; the rest
 * exist only to satisfy the shape: `system`/`kind`/`label` are still real
 * values (just sourced from `t.spec`/`conn.cfg`), `mode: "source"` is
 * accurate for method-replace targets, and `activation: "unknown"` is
 * `ActivationState`'s own honest default, not a guess.
 */
function resolvedObjectAdapter(conn: AbapConnection, t: ResolvedTarget): ResolvedObject {
  return {
    system: conn.cfg.sid,
    type: t.type,
    kind: t.spec.kind,
    label: t.spec.label,
    name: t.name,
    uri: t.uri,
    sourceUri: t.sourceUri,
    packageName: t.packageName,
    description: t.description,
    mode: "source",
    activation: "unknown",
    spec: t.spec,
  };
}

/** A complete `METHOD <name>. ... ENDMETHOD.` block — case-insensitive keywords. */
const METHOD_BLOCK_RE = /^\s*METHOD\s+\S+\s*\.[\s\S]*\n?\s*ENDMETHOD\s*\.\s*$/i;

/**
 * Replace ONE method's `METHOD … ENDMETHOD.` block inside `current`.
 *
 * Does NOT simply slice ADT's `{startLine,endLine}` range from
 * `/objectstructure`: that range isn't guaranteed to index the same document
 * being spliced (ADT reports ranges against includes and other objects too),
 * and a wrong slice used to silently emit unparseable ABAP. Instead the
 * boundaries are DERIVED from the bytes being rewritten, keyed by method
 * NAME (meaningful across documents), with ADT's range demoted to a
 * cross-check/disambiguator only. The result is then VERIFIED (step 6, the
 * METHOD/ENDMETHOD count invariant) before it can reach the wire.
 *
 * `scanMethodBlocks` blanks string literals/comments first, so a body
 * containing `"… ENDMETHOD …"` cannot move a boundary.
 *
 * Exported for test/write-method-splice.test.ts: pure function of two
 * strings and a name, pinnable with no connection, fake or route table.
 */
export function spliceMethodBlock(args: {
  /** The object's current source — the text whose line numbers are authoritative. */
  current: string;
  /** The replacement, already trimmed: exactly one complete METHOD…ENDMETHOD block. */
  replacement: string;
  /** ADT's canonical member name, e.g. `ZIF_FOO~BAR`. */
  memberName: string;
  /** What the caller actually typed, for error messages and as a second key. */
  requested: string;
  /** ADT's claim about where the block is. A hint — never the authority. */
  range?: SourceRange;
  /** Object name, for error details. */
  object: string;
}): string {
  const { current, replacement, memberName, requested, range, object } = args;
  const details = { object, method: requested, member: memberName };

  // 1. The replacement must be exactly ONE well-formed block — unlike
  //    METHOD_BLOCK_RE (a whole-string regex), this can't be fooled by an
  //    ENDMETHOD. inside a literal or by two concatenated methods.
  const rep = scanMethodBlocks(replacement);
  if (rep.malformed || rep.blocks.length !== 1) {
    throw new AbapError(
      "BAD_INPUT",
      `source for method=${requested} must be exactly ONE complete "METHOD ... ENDMETHOD." block ` +
        `(found ${rep.blocks.length}${rep.malformed ? `; ${rep.malformed}` : ""}).`,
      { ...details, blocks: rep.blocks.length, ...(rep.malformed ? { malformed: rep.malformed } : {}) },
      "Send one method only. To change several, call abap_write once per method, or rewrite the " +
        "whole object with `source` alone.",
    );
  }

  // 2. The object's own source must tokenise cleanly, or we don't know where
  //    anything begins/ends and a rewrite would be a guess.
  const scan = scanMethodBlocks(current);
  if (scan.malformed) {
    throw new AbapError(
      "UNSUPPORTED",
      `The current source of ${object} does not parse into well-formed method blocks ` +
        `(${scan.malformed}), so abapsmith cannot safely replace ${requested} inside it.`,
      { ...details, malformed: scan.malformed },
      "Read the object, fix the unbalanced METHOD/ENDMETHOD, and write the whole source back — " +
        "or pass the complete new source with `source` alone.",
    );
  }

  // 3. Locate the block BY NAME. Exact match wins; the interface-prefix-
  //    insensitive rule is the fallback for an ALIASES declaration
  //    (`METHOD bar.` implementing `ZIF_FOO~BAR`).
  const named = (name: string): MethodBlock[] => {
    const exact = scan.blocks.filter((b) => b.name.toUpperCase() === name.toUpperCase());
    return exact.length ? exact : scan.blocks.filter((b) => methodNamesMatch(b.name, name));
  };
  let candidates = named(memberName);
  if (candidates.length === 0) candidates = named(requested);

  if (candidates.length === 0) {
    // The method exists on the server but its block isn't in the text we
    // hold — the implementation lives in another document. Refuse rather
    // than cut at line numbers that describe a different document.
    throw new AbapError(
      "NOT_FOUND",
      `No "METHOD ${memberName} ... ENDMETHOD." block was found in the current source of ${object}, ` +
        `so there is nothing to replace. The class reports the method, but its implementation is not ` +
        `in the source abapsmith read` +
        (range?.document ? ` (ADT places it in ${range.document})` : "") +
        ".",
      {
        ...details,
        ...(range ? { adtRange: `${range.startLine}-${range.endLine}` } : {}),
        ...(range?.document ? { adtDocument: range.document } : {}),
        methodsInSource: scan.blocks.map((b) => b.name),
      },
      "The implementation may live in a class include or another object. Read the object first and " +
        "use `edit` to splice the exact text you can see, or write the full source.",
    );
  }

  // 4. Two blocks can legitimately share a short name (`IF1~DO`/`IF2~DO` both
  //    match bare `DO`) — ADT's range is the tie-breaker here, never the boundary itself.
  let block = candidates[0] as MethodBlock;
  if (candidates.length > 1) {
    const pinned = range
      ? candidates.filter((b) => b.startLine <= range.startLine && range.startLine <= b.endLine)
      : [];
    if (pinned.length !== 1) {
      throw new AbapError(
        "AMBIGUOUS",
        `${object} has ${candidates.length} method blocks matching ${requested} ` +
          `(lines ${candidates.map((b) => `${b.startLine}-${b.endLine}`).join(", ")}), and abapsmith ` +
          "cannot tell which one you mean.",
        { ...details, candidates: candidates.map((b) => ({ name: b.name, lines: `${b.startLine}-${b.endLine}` })) },
        "Name the method with its full interface prefix, e.g. ZIF_FOO~BAR.",
      );
    }
    block = pinned[0] as MethodBlock;
  }

  // 5. Splice on the LOCALLY DERIVED, name-verified boundaries — used even
  //    when ADT's range disagrees; step 6 re-checks the result either way.
  const lines = current.replace(/\r\n/g, "\n").split("\n");
  const spliced = [
    ...lines.slice(0, block.startLine - 1),
    replacement,
    ...lines.slice(block.endLine),
  ].join("\n");

  // 6. THE BACKSTOP: one block out, one block in, so the object must end up
  //    with exactly as many METHOD/ENDMETHOD statements as it started with.
  //    Cheap invariant over the finished text; holds regardless of which
  //    assumption above turns out to be wrong.
  const before = countMethodKeywordLines(current);
  const after = countMethodKeywordLines(spliced);
  if (after.method !== before.method || after.endmethod !== before.endmethod) {
    throw new AbapError(
      "UNSUPPORTED",
      `Internal check failed: replacing ${requested} in ${object} changed the object's METHOD/ENDMETHOD ` +
        `balance (before ${before.method}/${before.endmethod}, after ${after.method}/${after.endmethod}), ` +
        "which cannot be valid ABAP. Nothing was written.",
      { ...details, before, after, block: `${block.startLine}-${block.endLine}` },
      "This is an abapsmith bug, not a problem with your code — the source on the server is untouched. " +
        "Rewrite the whole object with `source` alone, and please report the object shape.",
    );
  }
  return spliced;
}

/**
 * Refuse a whole-object rewrite whose ENTIRE text is a single method block —
 * the second, defense-in-depth closure of the `edit`/`method`-dropped-by-
 * schema incident above: whatever drops `method` next (a proxy, a future
 * surface), the bytes still can't reach the wire, since no ABAP object's
 * complete source is one bare METHOD block.
 *
 * Deliberately narrow (a false refusal is worse than the hole): fires only
 * when the text is exactly one block and nothing else. `INCLUDE_TYPES` are
 * exempt — a `PROG/I` include pulled into a `CLASS … IMPLEMENTATION` can
 * legitimately be nothing but a method block.
 */
const INCLUDE_TYPES = new Set(["PROG/I", "FUGR/I"]);

export function assertNotOrphanMethodBlock(source: string, object: string, type?: string): void {
  if (type !== undefined && INCLUDE_TYPES.has(type.toUpperCase())) return;
  const scan = scanMethodBlocks(source);
  if (scan.malformed || scan.blocks.length !== 1) return;
  const block = scan.blocks[0] as MethodBlock;
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const firstCode = lines.findIndex((l) => l.trim() !== "") + 1;
  let lastCode = lines.length;
  while (lastCode > 0 && (lines[lastCode - 1] ?? "").trim() === "") lastCode -= 1;
  if (block.startLine !== firstCode || block.endLine !== lastCode) return;
  throw new AbapError(
    "BAD_INPUT",
    `The source given for ${object} is a single "METHOD ${block.name} ... ENDMETHOD." block, not a ` +
      "complete object source. Writing it would REPLACE the whole object with that one method, and " +
      "the result cannot compile — no ABAP object's full source is a bare METHOD block.",
    { object, method: block.name, lines: `${block.startLine}-${block.endLine}` },
    "To replace one method, pass `method` alongside `source`: " +
      '{object, method: "MY_METHOD", source: "METHOD my_method. ... ENDMETHOD."}. If the `method` ' +
      "field is being dropped before it reaches abapsmith, the tool schema in use does not declare it. " +
      "To rewrite the whole object, send its complete source including the CLASS/REPORT scaffolding.",
  );
}

/** abapsmith's own response furniture; `buildResponse` (src/compact.ts) emits each as a whole line. */
const TOOL_RESPONSE_FENCE_RE =
  /^[ \t]*--- (SOURCE|METHOD SOURCE|XML DESCRIPTOR|PSEUDO-DDL|OUTLINE|TRUNCATED|WINDOW|OUTPUT HARD-CLAMPED) ---[ \t]*$/m;

/**
 * The no-etag half of refusing a full rewrite whose "source" is an
 * `abap_read` RESPONSE, not an object's source. The one completeness signal
 * available when the caller passes no `expect_etag` for
 * `assertNotPartialReadSource` (src/adt/write.ts) to check.
 *
 * A *proof*, not a heuristic: these fence lines are strings abapsmith itself
 * printed, and no ABAP source or ADT XML descriptor has a line consisting
 * solely of `--- SOURCE ---` (a line starting `---` isn't valid ABAP; ABAP
 * comments start with `*` or `"`). No legitimate write can trip it.
 *
 * Only catches the sloppy case — an agent pasting back the whole tool
 * response. An agent that cleanly extracts the fenced text (losing the
 * TRUNCATED warning with it) lands in the gap `assertNotPartialReadSource` documents instead.
 */
export function assertNotToolResponseEcho(source: string, object: string, type?: string): void {
  const m = TOOL_RESPONSE_FENCE_RE.exec(source);
  if (!m) return;
  throw new AbapError(
    "BAD_INPUT",
    `The source given for ${object} contains abapsmith's own response markers (the line ` +
      `"${(m[0] ?? "").trim()}"), so it is an abap_read RESPONSE, not an object's source. ` +
      "Writing it would replace the whole object with a tool transcript — and if a " +
      "`--- TRUNCATED ---` marker is in there, the transcript is not even the whole object.",
    { object, ...(type ? { type } : {}), marker: (m[0] ?? "").trim() },
    "Send only the text INSIDE the source fence, with no header, notes, hints or TRUNCATED " +
      "block — and check that block first: if the read was truncated, the text inside the fence " +
      "is not the whole object either. Use {edit:{old_string,new_string}} to change part of an " +
      "object without holding a complete copy of it.",
  );
}

/**
 * Fraction of an object's lines a write must remove before the size change is
 * worth a note. A DISCLOSURE threshold, never a refusal — see the call site
 * in `abapWrite`. Set past "trimmed some dead code" into "check this was
 * intentional"; being wrong either way just costs an unneeded/missing note.
 */
const SHRINK_DISCLOSURE_FRACTION = 1 / 3;

/**
 * Smallest absolute line loss worth mentioning, so a 3-line object losing one
 * line does not get a warning about deleting 33% of itself.
 */
const SHRINK_DISCLOSURE_MIN_LINES = 20;

/** Non-empty only when `after` lost a substantial part of `before`. */
function describeShrink(
  before: string | undefined,
  after: string,
): { beforeLines: number; removedLines: number; percent: number } | undefined {
  if (before === undefined) return undefined;
  const beforeLines = before.replace(/\r\n/g, "\n").split("\n").length;
  const afterLines = after.replace(/\r\n/g, "\n").split("\n").length;
  const removedLines = beforeLines - afterLines;
  if (removedLines < SHRINK_DISCLOSURE_MIN_LINES) return undefined;
  if (removedLines / beforeLines < SHRINK_DISCLOSURE_FRACTION) return undefined;
  return { beforeLines, removedLines, percent: Math.round((removedLines / beforeLines) * 100) };
}

/** One `DiscardedValue` as `element (sent "a", "b", server now holds "c")`. */
function describeDiscard(d: DiscardedValue): string {
  const sentText = d.sent.map((v) => JSON.stringify(v)).join(", ");
  const storedText = d.stored.length ? d.stored.map((v) => JSON.stringify(v)).join(", ") : "nothing";
  return `${d.element} (sent ${sentText}, server now holds ${storedText})`;
}

/** SAP's `OO_SOURCE_BASED` message 38 — "The statement X is unexpected". */
const UNEXPECTED_STATEMENT_T100 = { id: "OO_SOURCE_BASED", no: 38 } as const;

/**
 * Dig a T100 key out of an `AbapError`'s details, whatever shape it arrived
 * in — src/adt/session.ts stores raw `"T100KEY-ID"`/`"T100KEY-NO"` while
 * src/tool-errors.ts normalises to `{id, no}`; both are matched so this
 * doesn't fire inconsistently. Recursive since envelope nesting varies by
 * layer; depth-capped because details are caller-influenced data.
 */
function findT100(v: unknown, depth = 0): { id?: string; no?: string } {
  const out: { id?: string; no?: string } = {};
  if (!v || typeof v !== "object" || depth > 4) return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") {
      const key = k.toUpperCase();
      if (key === "T100KEY-ID") out.id ??= val;
      else if (key === "T100KEY-NO") out.no ??= val;
      continue;
    }
    if (val && typeof val === "object") {
      if (k.toLowerCase() === "t100") {
        const t = val as { id?: unknown; no?: unknown };
        if (typeof t.id === "string") out.id ??= t.id;
        if (typeof t.no === "string") out.no ??= t.no;
      }
      const nested = findT100(val, depth + 1);
      out.id ??= nested.id;
      out.no ??= nested.no;
    }
  }
  return out;
}

/**
 * True when SAP rejected the PUT with the ABAP parser's "unexpected
 * statement" complaint. Keyed on the T100 id/no (stable, language-
 * independent); message text is a localised fallback. Number compared
 * numerically since it arrives as both `"38"` and `"038"` depending on layer.
 */
export function isUnexpectedStatementRejection(e: unknown): boolean {
  if (!isAbapError(e)) return false;
  const { id, no } = findT100(e.details);
  if (id === UNEXPECTED_STATEMENT_T100.id && no !== undefined && Number(no) === UNEXPECTED_STATEMENT_T100.no) {
    return true;
  }
  return /\bstatement\b.*\bis unexpected\b/i.test(e.message);
}

/**
 * Say which `source` shape THIS tool expects, for the write form actually
 * used. SAP's rejection names only the token its parser choked on — live
 * telemetry caught a caller burning both its guesses on the same
 * `OO_SOURCE_BASED 38` (bare method body, then the same body wrapped in
 * METHOD/ENDMETHOD), never told the contract it was failing.
 *
 * Lives here, not in `summarise()` (src/tool-errors.ts, facts-only) or the
 * adt layer (never sees the caller's write form), because only here is
 * `input.method`/`input.edit` still in scope.
 */
export function sourceShapeGuidance(input: Pick<WriteInputV2, "method" | "edit">, type?: string): string {
  if (input.method !== undefined) {
    return (
      `\`source\` under \`method\` must be exactly one complete "METHOD ${input.method} ... ENDMETHOD." ` +
      "block — the METHOD and ENDMETHOD lines included, the method body alone is not accepted and is " +
      "never auto-wrapped."
    );
  }
  if (input.edit !== undefined) {
    return (
      "`edit` spliced into the object's current source and the result did not parse, so `old_string`/" +
      "`new_string` most likely straddle a statement boundary. Re-read the object with abap_read and " +
      "widen the match to whole statements."
    );
  }
  const scaffold =
    type && type.toUpperCase().startsWith("CLAS")
      ? "a complete `CLASS ... IMPLEMENTATION. ... ENDCLASS.` source"
      : "the object's COMPLETE source including its scaffolding";
  return (
    `\`source\` on its own REPLACES THE WHOLE OBJECT, so it must be ${scaffold} — not a fragment and ` +
    "not a single method. To change one method use {object, type, method, source} with source as a " +
    "full METHOD ... ENDMETHOD. block; to change a few lines use {object, edit:{old_string, new_string}}."
  );
}

/**
 * Rethrow a write rejection, appending the expected-shape sentence when
 * SAP's complaint was a bare parser token. Keeps SAP's message verbatim; any
 * other error passes through untouched.
 */
export function rethrowWithSourceShapeHint(
  e: unknown,
  input: Pick<WriteInputV2, "method" | "edit">,
  type?: string,
): never {
  if (!isAbapError(e) || !isUnexpectedStatementRejection(e)) throw e;
  const guidance = sourceShapeGuidance(input, type);
  throw new AbapError(
    e.code,
    e.message,
    { ...e.details, expectedSourceShape: guidance },
    e.hint ? `${e.hint} ${guidance}` : guidance,
  );
}

/**
 * Rethrow a write rejection for one of the three XML-only DDIC types,
 * attaching a known-accepted skeleton — same keep-SAP's-message-verbatim
 * idiom as `rethrowWithSourceShapeHint`. `details.ddicSkeleton` already set
 * means our OWN pre-send `assertDdicDescriptorShape` guard raised this one
 * (see the call site above `writeObject`); re-appending would duplicate a
 * 1-2 KB skeleton the caller already has.
 */
export function rethrowWithDdicSkeletonHint(e: unknown, type?: string, name?: string): never {
  if (!isAbapError(e) || e.details.ddicSkeleton !== undefined) throw e;
  const skeleton = type && name ? ddicDescriptorSkeleton(type, name) : undefined;
  if (!skeleton) throw e;
  const guidance = `Known-accepted starting document for ${type}:\n${skeleton}`;
  throw new AbapError(
    e.code,
    e.message,
    { ...e.details, ddicSkeleton: skeleton },
    e.hint ? `${e.hint} ${guidance}` : guidance,
  );
}

/**
 * Produce the full replacement `source` string for `abapWrite`, from
 * whichever of the three write forms `input` used:
 *
 *  - `edit` — splice a unique (or every, with `replace_all`) match of
 *    `old_string` in the object's CURRENT source. Reads first (one GET), so
 *    this has a real TOCTOU window, closed by defaulting `expectEtag` to
 *    `canonicalEtag` of the bytes just read, unless the caller supplied
 *    their own (which wins). This default is specific to `edit` — it is
 *    NOT a general `abap_write` statement; the full-rewrite branch never
 *    defaults its etag.
 *  - `method` (+ `source`) — replace one method's implementation. `source`
 *    must be a complete `METHOD ... ENDMETHOD.` block (BAD_INPUT otherwise;
 *    no auto-wrap of a bare body). Same TOCTOU treatment as `edit`.
 *  - `source` alone — full rewrite, no extra read, no etag default. The
 *    destructive branch: the whole-object data-loss risk lives here, replacing the
 *    WHOLE object with whatever the caller holds. Guarded by
 *    `assertNotToolResponseEcho` below and, when an etag is supplied,
 *    `writeObject`'s `assertNotPartialReadSource` (src/adt/write.ts).
 *
 * `handlers/write.ts` (v2) already rejects `edit`+`source`/`edit`+`method`
 * together; the checks here are a defensive re-statement for other callers
 * (tests, `abapWrite` driven directly), not the primary gate.
 */
export async function resolveWriteSource(
  conn: AbapConnection,
  authorized: AuthorizedTarget<MutatingOperation, ResolvedTarget>,
  input: WriteInputV2,
): Promise<{
  source: string;
  expectEtag?: string;
  /** Server bytes the splice actually ran against — undefined for the plain-`source` form, which reads nothing. */
  current?: string;
}> {
  const t = authorized.target;

  if (input.edit) {
    if (input.source !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        "Pass either `edit` or `source`, not both — they are two different ways of saying what the new source is.",
        { object: t.name },
        "Drop `source` to splice with `edit`, or drop `edit` and pass the complete new source.",
      );
    }
    if (!t.exists) {
      throw new AbapError(
        "NOT_FOUND",
        `${t.spec.label} ${t.name} does not exist on ${conn.cfg.sid}, so there is no source to edit.`,
        { object: t.name, name: t.name, type: t.type, system: conn.cfg.sid },
        "Use {object, type, source} to create it — `edit` only applies to an object that already exists.",
      );
    }
    const current = await readCurrentSource(conn, t);
    if (current === undefined) {
      // Unreachable given `t.exists` above (readCurrentSource returns
      // undefined only for !t.exists, throwing otherwise) — kept as an
      // honest guard rather than a non-null assertion.
      throw new AbapError(
        "UNSUPPORTED",
        `${t.spec.label} ${t.name} exists but its current source could not be read.`,
        { object: t.name },
      );
    }
    let result: ReturnType<typeof applyEdit>;
    try {
      result = applyEdit(current, input.edit.old_string, input.edit.new_string, input.edit.replace_all);
    } catch (e) {
      if (e instanceof EditInputError) {
        throw new AbapError("BAD_INPUT", e.message, { object: t.name });
      }
      throw e;
    }
    if (!result.ok) {
      throw new AbapError(
        "BAD_INPUT",
        describeEditFailure(result),
        {
          object: t.name,
          editFailure: result.kind,
          ...(result.kind === "ambiguous" ? { matchLines: result.matchLines } : {}),
          ...(result.kind === "no-match" && result.firstLineOccurrences
            ? { firstLineOccurrences: result.firstLineOccurrences }
            : {}),
        },
        "Re-read the object with abap_read to see the CURRENT source, then retry with old_string " +
          "copied verbatim from it.",
      );
    }
    // `stripPartialEtag`: `edit` is the ONE form a truncated read cannot turn
    // into data loss — the splice runs against `current`, the
    // object's complete server source just read above, so a caller who only
    // saw a truncated read can pick a worse `old_string` but can't delete a
    // tail they never mentioned. Marker dropped so the etag keeps doing its
    // concurrency job instead of refusing the form callers should be
    // steered TOWARDS after a truncated read.
    return {
      source: result.result,
      expectEtag: input.expect_etag ? stripPartialEtag(input.expect_etag) : canonicalEtag(current),
      current,
    };
  }

  if (input.method !== undefined) {
    if (input.source === undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `\`method\` requires \`source\`: the complete replacement for ${input.method}.`,
        { object: t.name, method: input.method },
        "Pass source as a full `METHOD ... ENDMETHOD.` block, or use `edit` for a smaller, partial change.",
      );
    }
    const trimmed = input.source.replace(/\r\n/g, "\n").trim();
    if (!METHOD_BLOCK_RE.test(trimmed)) {
      throw new AbapError(
        "BAD_INPUT",
        `source for method=${input.method} must be a complete "METHOD ... ENDMETHOD." block — abapsmith ` +
          "does not auto-wrap a bare body.",
        { object: t.name, method: input.method },
        "Include the METHOD and ENDMETHOD lines themselves, or use `edit` to splice a fragment instead.",
      );
    }
    if (!t.exists) {
      throw new AbapError(
        "NOT_FOUND",
        `${t.spec.label} ${t.name} does not exist on ${conn.cfg.sid}, so there is no method ${input.method} to replace.`,
        { object: t.name, name: t.name, type: t.type, system: conn.cfg.sid, method: input.method },
        "Use {object, type, source} to create the object first.",
      );
    }
    const current = await readCurrentSource(conn, t);
    if (current === undefined) {
      throw new AbapError(
        "UNSUPPORTED",
        `${t.spec.label} ${t.name} exists but its current source could not be read.`,
        { object: t.name },
      );
    }
    const ms = await readMethod(conn, resolvedObjectAdapter(conn, t), current, input.method);
    if (!ms.implementationRange) {
      throw new AbapError(
        "NOT_FOUND",
        `${t.spec.label} ${t.name} method ${input.method} has no implementation block to replace ` +
          "(an interface method or an abstract method has none).",
        { object: t.name, method: input.method },
      );
    }
    const spliced = spliceMethodBlock({
      current,
      replacement: trimmed,
      memberName: ms.member.name,
      requested: input.method,
      ...(ms.implementationRange ? { range: ms.implementationRange } : {}),
      object: t.name,
    });
    return { source: spliced, expectEtag: input.expect_etag ?? canonicalEtag(current), current };
  }

  if (input.source !== undefined) {
    // The only destructive branch: replaces the ENTIRE object. A caller who
    // meant {method, source} but had `method` stripped in transit lands here
    // — see `assertNotOrphanMethodBlock`.
    assertNotOrphanMethodBlock(input.source, t.name, t.type);
    assertNotToolResponseEcho(input.source, t.name, t.type);
    // `partial:` marker passed through UNSTRIPPED (unlike `edit` above) —
    // `writeObject` (src/adt/write.ts) refuses it there where `current` is
    // already in hand, covering v1 and v2 in one place.
    return { source: input.source, ...(input.expect_etag ? { expectEtag: input.expect_etag } : {}) };
  }

  throw new AbapError(
    "BAD_INPUT",
    "`source` is required for mode=write.",
    { object: input.object },
    "Pass the complete new source, {edit:{old_string,new_string}} to splice a unique match, or " +
      "{method,source} to replace one method's implementation. Use mode=delete to remove the object.",
  );
}

/**
 * `gate` is REQUIRED (not optional-chained): every mutation goes through
 * `authorizeMutation`, which resolves the target and judges its real package
 * in one indivisible step, so a call site can no longer forget the gate and
 * authorise everything silently.
 */
export async function abapWrite(
  conn: AbapConnection,
  input: WriteInputV2,
  maxChars: number,
  gate: SafetyGate,
  journal?: Journal,
  /** Per-session transport manager. Its absence does not allow writing
   * transportable objects without a request — writeObject still refuses
   * those; the manager only adds the ability to say yes. */
  transport?: SessionTransport,
  /** Configured verification posture (`ABAP_VERIFY_WRITES`). A per-call
   * `verify:true` raises this to "verified"; nothing can lower it. */
  verifyWrites: VerifyWritesMode = "speculative",
): Promise<BuiltResponse> {
  // ---- batch delete dispatch ---------------------------------------------
  //
  // `object`/`objects` are both plain-optional (not a `.refine()`-wrapped
  // union), same as `abap_activate`'s `objects` field (activate.ts) — the
  // cross-field rules a union would encode are checked here by hand instead.
  if (input.objects !== undefined) {
    if (input.dry_run) throw dryRunNotSupported("objects");
    const stray = (
      [
        "object",
        "type",
        "source",
        "edit",
        "method",
        "package",
        "description",
        "expect_etag",
        "activate",
        "verify",
        "format",
        "corr_nr",
        "software_component",
        "package_type",
        "transport_layer",
        "base_table",
        "view_fields",
        "program",
        "affects",
        "ddic",
      ] as const
    ).filter((k) => input[k] !== undefined);
    if (stray.length) {
      throw new AbapError(
        "BAD_INPUT",
        "`objects` is the batch-delete form and does not combine with top-level " +
          `${stray.map((k) => `\`${k}\``).join(", ")} — each entry in \`objects\` carries its ` +
          "own `object`/`type`/`affects`.",
        { stray },
        "Drop the top-level field(s) named above, or delete that one object by itself with " +
          "`object` instead of `objects`.",
      );
    }
    if ((input.mode ?? "write") !== "delete") {
      throw new AbapError(
        "BAD_INPUT",
        "`objects` (batch delete) requires `mode: \"delete\"` — there is no batch write or " +
          "create; unlike `abap_activate`, write's default mode is \"write\", not \"delete\", so " +
          "this must be stated explicitly.",
        { mode: input.mode ?? "write" },
        "Add `mode: \"delete\"`, or drop `objects` and use `object` + `source` to write one " +
          "object instead.",
      );
    }
    return abapWriteBatchDelete(conn, input.objects, maxChars, gate, journal, transport);
  }

  const objectRef = input.object;
  if (objectRef === undefined) {
    throw new AbapError(
      "BAD_INPUT",
      "Pass either `object` (single object) or `objects` (batch delete — 2 or more objects in " +
        "one call, mode: \"delete\" only).",
      {},
      "Add `object: \"<name>\"` to write or delete one object, or `objects: [...]` with " +
        'mode: "delete" to delete several.',
    );
  }

  // Raise-only: a per-call verify:true escalates one write; verify:false is
  // accepted but cannot lower a server configured "verified". Unrelated to
  // FAILURE-path verification (reportCreateOrphan, src/adt/write.ts), which
  // stays unconditional in both modes.
  const verifyMode: VerifyWritesMode =
    verifyWrites === "verified" || input.verify === true ? "verified" : "speculative";

  const target = targetFromInput({ ...input, object: objectRef });

  // `ddic` is another way to arrive at `source`, not a parallel
  // pipeline — resolve it to a `source` string BEFORE anything below reads
  // `input.source`, so the rest of this function (including the pre-send
  // `assertDdicDescriptorShape` guard near the PUT call) treats it exactly
  // like hand-composed XML.
  if (input.ddic !== undefined) {
    if ((input.mode ?? "write") === "delete") {
      throw new AbapError(
        "BAD_INPUT",
        '`ddic` builds a create/write descriptor — it does not apply to mode="delete".',
        { name: target.name, type: target.type },
        "Drop `ddic` for a delete; there is no descriptor to build.",
      );
    }
    input = { ...input, source: resolveDdicStructuredSource(input, target) };
  }

  // Hoisted ABOVE the delete branch, unlike DEVC/K's routing below, and for
  // EVERY mode, not just create: `resolveWriteTarget` refuses these
  // two types outright, so `mode=delete` would otherwise reach it and get a
  // generic "cannot be written" refusal instead of the specific reason, or
  // (worse) leave `resolveWriteTarget`'s own delete gate as a second route
  // that must be kept in sync with this one. `abapBridgeCrud` owns both
  // types and both modes.
  //
  // `isBridgeOnlyCreateType`, not `isBridgeCreatableType`: DEVC/K now also
  // declares `bridgeCreate`, but it already has its own routing
  // below (`isPackageType`) that handles both its REST and bridge routes.
  if (isBridgeOnlyCreateType(input.type)) {
    if (input.dry_run) throw dryRunNotSupported("bridge", input.type);
    return await abapBridgeCrud(conn, target, input, maxChars, gate, journal);
  }

  /** Transport plumbing, spread into both mutation calls so write/delete can't drift apart on it. */
  // `normalizeCorrNr` rather than the falsy check this used to carry:
  // same outcome for `""`, but it also folds `" "` in, and it is the one
  // spelling abap_enh and abap_activate now share.
  const corrNr = normalizeCorrNr(input.corr_nr);
  const trOpts = transport
    ? { transport, gate, ...(corrNr ? { corrNr } : {}), ...(input.affects ? { affects: input.affects } : {}) }
    : { ...(corrNr ? { corrNr } : {}), ...(input.affects ? { affects: input.affects } : {}) };
  if ((input.mode ?? "write") === "delete") {
    // Zero-network refusal: there is no source to pretty-print on a delete.
    if (input.format) {
      throw new AbapError(
        "BAD_INPUT",
        "`format` does not apply to mode=delete; there is no source to pretty-print.",
        { object: target.name },
      );
    }
    // The dangerous corner: `include` + `mode=delete`. ADT has
    // no per-include DELETE — `deleteObject` sends `DELETE {t.uri}`, the
    // CLASS URI — so `{mode:"delete", include:"testclasses"}` meaning "drop
    // my test class" would instead delete the whole class, and undo can't
    // restore it (its local includes were never captured; src/adt/undo.ts).
    // Refused for every include value, including `main`, so callers never
    // learn that `include` narrows a delete. Zero-network, before
    // `authorizeMutation` — src/adt/write.ts refuses this too, for every
    // other caller of `WriteTarget`; this is the cheap early copy.
    if (input.include !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `\`include\` does not apply to mode=delete: ADT cannot delete one include of a class, only ` +
          `the whole class. Deleting ${target.name} because you asked to delete its ` +
          `${input.include} would destroy its main source and its other includes too, and that ` +
          `delete could not be undone — abapsmith's journal never captured the local includes.`,
        { object: target.name, include: input.include, mode: "delete" },
        `To empty an include, WRITE it: {object, include:"${input.include}", source:"<the new, ` +
          `possibly empty, content>"}. To delete the whole class, drop \`include\`.`,
      );
    }
    // A PACKAGE_UNKNOWN refusal here is the fail-closed rule, deliberately
    // not caught or softened.
    const authorized = await authorizeMutation(conn, gate, "delete", target);
    if (input.dry_run) {
      return buildDeleteDryRunResponse({
        conn,
        target: authorized.target,
        input,
        journalled: journal !== undefined,
        maxChars,
      });
    }
    // `withJournalledMutation` (src/journal.ts) fires `begin()` from INSIDE
    // `deleteObject`'s call chain (entry lands on disk before the DELETE
    // goes out), captures the id, and patches the entry to `failed` on throw.
    // `beforeCapture` is also stashed into this outer variable so the
    // response's note (below) can be selected by the SAME outcome the
    // journal entry itself records — never re-derived or guessed.
    let beforeCapture: BeforeImageCapture | undefined;
    let beforeKind: BeforeImage["sourceKind"];
    const { result: res, entryId, settle } = await withJournalledMutation(
      journal,
      {
        begin: (img: BeforeImage) => {
          beforeCapture = captureOf(img);
          beforeKind = img.sourceKind;
          return {
            operation: "delete",
            object: journalRef(img.target),
            existedBefore: img.existed,
            beforeCapture,
            ...(img.source !== undefined ? { beforeSource: img.source } : {}),
            ...(img.sourceKind !== undefined ? { beforeKind: img.sourceKind } : {}),
            // On begin(), not finish(): resolution is pre-flight, so the
            // request is already known — see BeforeImage.corrNr (src/adt/write.ts).
            ...(img.corrNr !== undefined ? { corrNr: img.corrNr } : {}),
            systemKey: systemKey(conn.cfg),
            tool: "abap_write",
          };
        },
      },
      (onBeforeImage) =>
        deleteObject(conn, authorized, {
          ...trOpts,
          ...(input.expect_etag ? { expectEtag: input.expect_etag } : {}),
          onBeforeImage,
          // DEVC/K runs through the classrun bridge, which needs the gate itself
          // even when no transport manager is wired.
          bridgeGate: gate,
        }),
    );
    // The journal settles `succeeded` regardless of what the verification
    // below finds: the DELETE request reached the server and its before-image
    // is (when captured) recoverable through abap_journal mode=undo — that is
    // a true statement about the mutation whether or not the object is
    // actually gone. Settling it `failed` would misdescribe what happened.
    await settle({ outcome: "succeeded", activation: { attempted: false } });
    // `entryId !== undefined` is the only thing that makes this delete
    // reversible — begin() returns undefined, never an entry, when the
    // journal is off, so this alone means "a real entry is on disk".
    const journalled = entryId !== undefined;

    // Two probes agreeing the object is still there is refused outright
    // — the journal entry (settled above) is what makes this delete
    // recoverable, so it is named here rather than left for the caller to
    // dig up.
    if (res.deleted === false) {
      throw new AbapError(
        "CHECK_FAILED",
        `abap_write mode=delete: ${deleteNotConfirmedSentence(res.target.type, res.target.name, res.verification)}.` +
          (journalled
            ? ` The delete was journalled as ${entryId}, so abap_journal mode=undo entry=${entryId} can restore it.`
            : " Nothing was journalled, so there is no undo entry for it."),
        {
          reason: "DELETE_NOT_CONFIRMED",
          object: res.target.name,
          type: res.target.type,
          uri: res.target.uri,
          deleted: false,
          verification: res.verification,
          ...(journalled ? { journalEntry: entryId } : {}),
        },
        "Re-read the object with abap_read to see its current state before retrying the delete.",
      );
    }

    // Delete responses now get a `transport:` line, same as writeObject.
    const isPackageDelete = isPackageType(res.target.type);
    return buildResponse({
      header: {
        system: conn.cfg.sid,
        object: `${res.target.type} ${res.target.name}`,
        uri: res.target.uri,
        package: res.target.packageName,
        package_source: res.target.packageSource,
        mode: "delete",
        deleted: res.deleted,
        markers: res.markers?.join(" "),
        transport: transportHeaderText(res.transport),
        journal: journalled ? entryId : "off (nothing recorded)",
      },
      notes: [
        entryId !== undefined
          ? // `journalled` (⇔ `entryId !== undefined`) is exactly when
            // `withJournalledMutation`'s `begin()` ran, which is exactly when
            // `beforeCapture` above was set — see `withJournalledMutation`
            // (src/journal.ts): `spec.begin(image)` is evaluated as part of
            // building the `journal.begin()` call whose result produces
            // `entryId`, so `entryId !== undefined` cannot happen without
            // `beforeCapture` having already been assigned. The `?? "failed"`
            // is a type-only fallback, never expected to fire.
            deleteJournalNote(entryId, beforeCapture ?? "failed", res.target.type, res.target.name, beforeKind)
          : "Nothing was journalled (the write journal is off or was not available), so " +
            "abapsmith kept NO copy of the source: this deletion is IRREVERSIBLE from here.",
        // Package delete only: unlike the ordinary REST delete's hardcoded
        // `deleted: true`, this route's is backed by PKG-GONE — see the markers line.
        ...(isPackageDelete
          ? [
              "`deleted: true` here is backed by PKG-GONE, which the classrun bridge emits only " +
                "after re-reading TDEVC once COMMIT WORK returns — not from a clean return alone.",
            ]
          : []),
        // Package delete + real transport only; see packageDeleteTransportNote.
        isPackageDelete && res.transport.status === "transport" && res.transport.corrNr !== undefined
          ? packageDeleteTransportNote(res.transport.corrNr)
          : transportNote(res.transport, gate.config?.abapMode),
        // The verification could not settle either way — the DELETE was
        // accepted, but abapsmith cannot say whether the object is actually
        // gone. Only reachable when res.deleted === "unverified" (the
        // `false` case above always throws first).
        ...(res.deleted === "unverified"
          ? [
              `deleted: unverified — the DELETE was accepted, but abapsmith could not confirm ` +
                `${res.target.type} ${res.target.name} is actually gone (${describeVerification(res.verification)}). ` +
                "Check for yourself with abap_read on the object (a NOT_FOUND confirms it is gone) or " +
                `abap_search for "${res.target.name}".`,
            ]
          : []),
      ],
      maxChars,
    });
  }

  // A package (DEVC/K) has no source, so it must be routed BEFORE the
  // `source` guard below. Reuses the same `specForType`/`specForKeyword` pair
  // `resolveWriteTarget` uses, so this agrees with the ADT layer. Keyed off
  // `input.type` alone, not `target.type`: no naming convention maps to
  // DEVC/K, so an absent `input.type` is never a package.
  const requestedSpec = input.type ? (specForType(input.type) ?? specForKeyword(input.type)) : undefined;
  if (isPackageType(requestedSpec?.type)) {
    if (input.dry_run) throw dryRunNotSupported("package");
    return await abapCreatePackage(conn, target, input, maxChars, gate, trOpts, journal);
  }

  // Zero-network refusal for a genuinely empty call (none of source/edit/
  // method given), ahead of `authorizeMutation` so it costs nothing on the
  // wire. Everything else wrong with edit/method needs the resolved target
  // to explain precisely, so it's diagnosed in `resolveWriteSource` instead.
  if (input.source === undefined && input.edit === undefined && input.method === undefined) {
    throw new AbapError(
      "BAD_INPUT",
      "`source` is required for mode=write.",
      { object: input.object },
      "Pass the complete new source, {edit:{old_string,new_string}} to splice a unique match, or " +
        "{method,source} to replace one method's implementation. Use mode=delete to remove the object.",
    );
  }

  // As on the delete branch: resolve and gate in one step.
  const authorized = await authorizeMutation(conn, gate, "write", target);

  // No CDS-specific `format` refusal needed: DDLS/DF, DDLX/EX, SRVD/SRV are
  // source-shape and `format` applies normally; DTEL/DE, DOMA/DD, TTYP/DA
  // are properties-shape and are refused explicitly below (the
  // `write.shape === "properties"` check). A type absent from
  // WRITABLE_TYPES/ENHANCEABLE_TYPES is refused UNSUPPORTED by
  // `resolveWriteTarget` before `format:true` is ever scrutinised.

  // Turns whichever of source/edit/method the caller used into the one thing
  // `writeObject` needs: a complete replacement `source`, plus (for
  // edit/method) an `expectEtag` pinned to the bytes just read.
  const {
    source: resolvedSource,
    expectEtag: resolvedExpectEtag,
    current: resolvedCurrent,
  } = await resolveWriteSource(conn, authorized, input);
  // Pretty-print AFTER resolving the final source (post edit/method splice),
  // BEFORE the PUT: every downstream consumer of `source` must see the same
  // formatted bytes actually written to the server. `resolvedExpectEtag` is
  // compared against the server's CURRENT source and is left untouched by
  // our own formatting.
  // The pretty-printer (`POST /abapsource/prettyprinter`) is an ABAP
  // formatter; a properties-shape payload is an XML descriptor whose element
  // ORDER is significant, so running it through would at best no-op and at
  // worst get silently reordered or rejected. Refuse rather than ignore.
  if (input.format && capabilitiesFor(authorized.target.type)?.write?.shape === "properties") {
    throw new AbapError(
      "BAD_INPUT",
      `format=true is not available for ${authorized.target.type}.`,
      { type: authorized.target.type, name: authorized.target.name },
      "This type is written as an XML descriptor, not as ABAP source, so there is nothing " +
        "for the ABAP pretty-printer to format. Drop `format` and write the XML as-is.",
    );
  }
  const formatted: FormatOutcome | undefined = input.format
    ? await prettyPrintSource(conn, resolvedSource)
    : undefined;
  const source = formatted ? formatted.source : resolvedSource;

  // A CDS view names the database view its activation creates via its own
  // `@AbapCatalog.sqlViewName` annotation, inside `source` — independent of
  // the object's own name, so a `Z`-named DDLS could still point at a
  // database view outside the customer namespace. This is the single point
  // every write form funnels through with a FINAL source and before any
  // network write; see `gate.evaluateDdlsSqlViewName` (src/safety.ts) for
  // the extraction rules.
  if (authorized.target.type === "DDLS/DF") {
    gate.assertDdlsSqlViewName(source, { name: authorized.target.name, type: authorized.target.type });
  }
  // Same funnel point: the one place with a FINAL, post-format `source` and
  // no network write yet. No-ops for any type outside the three XML-only
  // DDIC properties shapes — see src/adt/ddic-payload.ts.
  assertDdicDescriptorShape(authorized.target.type, authorized.target.name, source);

  if (input.dry_run) {
    return buildWriteDryRunResponse({
      conn,
      target: authorized.target,
      input,
      source,
      // The plain-{object,source} form reads nothing on a real write, so
      // `resolvedCurrent` is undefined here even for an existing object —
      // spend one extra GET so the preview can still show a diff and a
      // candidate etag.
      current:
        resolvedCurrent ??
        (authorized.target.exists ? await readCurrentSource(conn, authorized.target) : undefined),
      expectEtag: resolvedExpectEtag,
      formatted: formatted !== undefined,
      journalled: journal !== undefined,
      maxChars,
    });
  }

  // The before-image lands on disk BEFORE the create/lock/PUT, which is why
  // `withJournalledMutation` hands the hook INTO `writeObject` rather than
  // wrapping it. Not called for a refused etag check or byte-identical
  // no-op (nothing to undo); on throw the helper patches the entry `failed`.
  let written: Awaited<ReturnType<typeof writeObject>>;
  let entryId: Awaited<ReturnType<typeof withJournalledMutation>>["entryId"];
  let settle: Awaited<ReturnType<typeof withJournalledMutation>>["settle"];
  try {
    ({
      result: written,
      entryId,
      settle,
    } = await withJournalledMutation(
      journal,
      {
        begin: (img: BeforeImage) => ({
          operation: img.existed ? "update" : "create",
          object: journalRef(img.target),
          existedBefore: img.existed,
          beforeCapture: captureOf(img),
          ...(img.source !== undefined ? { beforeSource: img.source } : {}),
          // See the delete branch: begin(), since pre-flight resolution
          // already knows the request at this point.
          ...(img.corrNr !== undefined ? { corrNr: img.corrNr } : {}),
          afterSource: source,
          systemKey: systemKey(conn.cfg),
          tool: "abap_write",
        }),
      },
      (onBeforeImage) =>
        writeObject(conn, authorized, {
          source,
          ...trOpts,
          ...(resolvedExpectEtag ? { expectEtag: resolvedExpectEtag } : {}),
          onBeforeImage,
        }),
    ));
  } catch (e) {
    // SAP answers unparseable source with a bare parser token, never the
    // shape this tool wanted — append that one fact, rethrow everything else untouched.
    // Nested try/catch, not two statements: rethrowWithSourceShapeHint always
    // throws, so its enrichment (or pass-through) must run and land here
    // BEFORE the DDIC skeleton hint gets a chance to add its own.
    try {
      rethrowWithSourceShapeHint(e, input, authorized.target.type);
    } catch (e2) {
      rethrowWithDdicSkeletonHint(e2, authorized.target.type, authorized.target.name);
    }
  }

  // ---- Post-write. The source is ON the server from here on. --------------
  //
  // Separate try/catch: everything below runs AFTER a durable PUT, so a
  // failure here is never a failed write. The journal entry is settled
  // `succeeded` before any error is raised, since a `pending` entry is one
  // `abap_journal mode=undo` won't touch — un-undoable exactly when undo is needed.
  const objectName = `${written.target.type} ${written.target.name}`;
  const caps = capabilitiesFor(written.target.type);
  const propertiesShape = caps?.write?.shape === "properties";
  // ---- Two registry-driven suppressions on the post-write path ------------
  //
  // 1. `checkSource` POSTs to `/checkruns`; properties-shape types have no
  //    such resource (404, XML not ABAP) — the server validates the
  //    document eagerly on the PUT instead. So "clean" here is a statement
  //    about a check that does not exist: zero messages, `ok`, no request.
  //
  // 2. `activate: false` in the registry means the type has no inactive
  //    version to publish (e.g. MSAG/N is created already ACTIVE). Read in
  //    the NEGATIVE direction only — absent or `true` behaves as before.
  const wantActivate = (input.activate ?? true) && caps?.activate !== false;
  const activationSuppressed = (input.activate ?? true) && !wantActivate;
  let check: CheckOutcome;
  let activation: ActivationOutcome | undefined;
  let attempted = false;
  try {
    // Pre-flight for activation: no lock, no state change, and reports the real source line.
    check = propertiesShape
      ? { ok: true, messages: [], errors: 0, warnings: 0 }
      : await checkSource(conn, written.target, source);

    if (wantActivate && check.ok) {
      // `check.ok` is `errors === 0` over the CURATED severities (see
      // `mapCheckResults` in activate.ts, which downgrades a known SAP
      // `abapCheckRun` false positive to `I`) — one function both
      // `abap_write` and `abap_activate mode=check` funnel through, so the
      // two tools agree about the same object.
      //
      // ---- Pre-activation content gate (lost-update race) ----------------
      //
      // The lock releases inside `writeObject`; activation happens HERE,
      // outside it, and is itself unpinned (POSTs name+URI only, no
      // If-Match — the etag on this path is a client-side content hash, not
      // a wire header). So between our UNLOCK and our activation, a second
      // writer can lock/PUT/unlock, and our activation would publish THEIR
      // bytes while we report success under a hash of content that exists
      // nowhere. Reachable today with no special config: `InProcessObjectGate`
      // is in-process, so two abapsmith processes share no gate at all. Full
      // incident and line references: the git history.
      //
      // Fix: refuse to activate content we did not write — one extra GET,
      // only on the path that actually activates, deliberately not cached
      // (a cached answer is the very staleness being guarded against).
      // `exists: true` is forced because `written.target` is pre-write (on
      // create it still says `exists: false`, which would make
      // `readCurrentSource` read a freshly created object as "vanished").
      // Both sides use the SAME `canonicalEtag` so this fires on real
      // divergence, not server-side reformatting.
      const observed = await readCurrentSource(conn, { ...written.target, exists: true });
      const observedEtag = observed === undefined ? null : canonicalEtag(observed);
      if (observedEtag !== written.etag) {
        // Same code/details shape as the two pre-lock conflicts in src/adt/write.ts,
        // both keyed by `phase` — but unlike those, this one is raised AFTER a durable PUT.
        throw new AbapError(
          "ETAG_CONFLICT",
          `${objectName} changed between abapsmith's write and its activation, so it was ` +
            `NOT activated. The source abapsmith saved is on ${conn.cfg.sid} as the INACTIVE ` +
            `version, but the inactive version now on the server is somebody else's: ` +
            `activating would have published THEIR source under abapsmith's etag.`,
          {
            name: written.target.name,
            type: written.target.type,
            uri: written.target.uri,
            operation: "write",
            phase: "pre-activation",
            written: true,
            activated: false,
            object: objectName,
            created: written.created,
            expectedEtag: written.etag,
            actualEtag: observedEtag,
            // see the delete branch: an id exists iff a real entry landed
            ...(entryId !== undefined ? { journal: entryId } : {}),
          },
          "Another writer changed this object between abapsmith's PUT and its activation — " +
            "the object lock does NOT span activation, and activation cannot be pinned to a " +
            "version on this protocol. DO NOT simply write again: your PUT already landed and " +
            "was then overwritten, so a blind retry re-runs the same race and silently discards " +
            "the other writer's work. Re-read the object to see what is actually there now, " +
            "merge the two changes deliberately, and write the merged source. Note the last " +
            "ACTIVE version is untouched and still what callers execute.",
        );
      }

      // A second, cheaper-to-miss failure mode the etag check above cannot see:
      // the document changed and `observedEtag` matches, but the server itself
      // silently emptied one or more elements while accepting the rest (a
      // `TTYP/DA` write's `<ttyp:rangeType>` came back `<ttyp:rangeType/>`
      // with `activated: true` and no warning). `observed` is the SAME
      // independent read the etag check just used, so this costs no extra
      // request; refuse to activate a document we know is missing part of
      // what was asked for rather than publish it silently.
      if (propertiesShape && observed !== undefined) {
        const discarded = discardedDescriptorValues(source, observed);
        if (discarded.length > 0) {
          throw new AbapError(
            "CHECK_FAILED",
            `${objectName} WAS written and saved on ${conn.cfg.sid}, and is INACTIVE: ` +
              "activation was deliberately NOT attempted because a read-back taken " +
              "immediately before activation shows the server silently dropped " +
              `${discarded.length === 1 ? "an element" : `${discarded.length} elements`} from ` +
              `what was sent — ${discarded.map(describeDiscard).join("; ")}.`,
            {
              reason: "VALUE_DISCARDED",
              phase: "pre-activation",
              object: objectName,
              uri: written.target.uri,
              type: written.target.type,
              written: true,
              activated: false,
              created: written.created,
              etag: written.etag,
              discarded,
              ...(entryId !== undefined ? { journal: entryId } : {}),
            },
            "This is a server-side discard, not a rejection — the document was accepted and " +
              "nothing ran to check it. Re-read the object with abap_read to see the descriptor " +
              "the server actually holds, then either rework the payload so the dropped " +
              "element(s) survive, or accept the object as written and activate it yourself " +
              "with abap_activate." +
              (entryId !== undefined
                ? ` Remove this write with abap_journal mode=undo entry=${entryId}.`
                : " The write journal is off, so abapsmith cannot undo this for you."),
          );
        }
      }

      attempted = true;
      activation = await activateObject(conn, written.target);
      // `activated: false` and inactive dependents are failures, not quiet
      // successes — `assertNoErrors` owns that rule for every caller.
      try {
        assertNoErrors(activation, { what: "Activation", name: objectName, source });
      } catch (ae) {
        // check.ok was true, so check.messages holds only warnings at this point — but
        // activation swallows W severities on this system, so fold the pre-flight text
        // in as preflightMessages rather than losing it or rewriting checkFailedError's shape.
        if (isAbapError(ae) && check.messages.length > 0) {
          throw new AbapError(
            ae.code,
            ae.message,
            {
              ...ae.details,
              preflightMessages: renderMessages(check.messages, source),
              preflightRaw: check.messages,
            },
            ae.hint,
          );
        }
        throw ae;
      }
    } else if (wantActivate && !check.ok) {
      // Real check errors, so activation was skipped. Throw into the catch below so this
      // gets the same isError:true / written:true,activated:false shape as every other
      // "saved but not activated" cause (G-05: this must never fall through as a silent success).
      throw new AbapError(
        "CHECK_FAILED",
        `syntax check reported ${check.errors} error(s), ${check.warnings} warning(s)`,
        { messages: check.messages },
      );
    }
  } catch (e) {
    // The ONE message this block exists to deliver is "your source is on the server and
    // the object is INACTIVE". A journal I/O failure must never replace it — swallow it
    // and carry it in details.journalError instead.
    let journalError: string | undefined;
    try {
      await settle({
        outcome: "succeeded",
        ...(written.normalisedSource ? { afterSource: written.normalisedSource } : {}),
        // `attempted` is the local truth, not a constant: a syntax-check transport
        // failure also lands here with activation never reached.
        activation: { attempted, ...(attempted ? { activated: false } : {}) },
      });
    } catch (je) {
      journalError = String(je);
    }
    // The pre-activation gate above is NOT "the server rejected your source" — it is
    // "your source is fine and somebody else's is on top of it" (ETAG_CONFLICT), or
    // "the server kept your source but silently threw part of it away"
    // (CHECK_FAILED/VALUE_DISCARDED). Neither ran a check, so re-wrapping either as the
    // generic CHECK_FAILED below would bury the real code and its specific hint — both
    // are settled like everything else here and re-raised unchanged.
    //
    // Journal outcome is deliberately `succeeded` with `activation.attempted: false`,
    // not `failed` or `pending`: the PUT is durable, so `failed` would be a lie and
    // `pending` would make `abap_journal mode=undo` decline it right when it's needed.
    // `afterSource` is left as OUR bytes, not rewritten to what we just observed — undo's
    // drift check compares against the recorded after-image, and recording the other
    // writer's bytes would make undo overwrite their work with our before-image instead
    // of failing safely.
    if (isAbapError(e)) {
      const isPreActivationRefusal =
        (e.code === "ETAG_CONFLICT" && e.details.phase === "pre-activation") ||
        (e.code === "CHECK_FAILED" && e.details.reason === "VALUE_DISCARDED");
      if (isPreActivationRefusal) {
        if (!journalError) throw e;
        throw new AbapError(e.code, e.message, { ...e.details, journalError }, e.hint);
      }
    }
    const journalled = entryId !== undefined; // see the delete branch
    const cause = isAbapError(e) ? e.message : String(e);
    throw new AbapError(
      "CHECK_FAILED",
      `The source of ${objectName} WAS WRITTEN AND SAVED on ${conn.cfg.sid}, but ` +
        (attempted
          ? "activation failed"
          : "the syntax check failed before activation was attempted") +
        `, so the object is saved INACTIVE: ${cause}`,
      {
        written: true,
        activated: false,
        object: objectName,
        uri: written.target.uri,
        package: written.target.packageName,
        created: written.created,
        etag: written.etag,
        ...(journalled ? { journal: entryId } : {}),
        ...(journalError ? { journalError } : {}),
        failure: isAbapError(e)
          ? {
              code: e.code,
              message: e.message,
              details: e.details,
              ...(e.hint ? { hint: e.hint } : {}),
            }
          : cause,
      },
      "The write itself succeeded and is NOT rolled back: the new source is on the server " +
        "and the object is INACTIVE, so it will not execute and callers still see the last " +
        "active version. Fix the reported lines and write again to activate it" +
        (journalled
          ? `, or restore the previous source with abap_journal mode=undo entry=${entryId}.`
          : ". The write journal is off, so abapsmith cannot undo this for you — write the " +
            "previous source back by hand if you need the old version.") +
        (journalError
          ? ` NOTE: the journal entry could not be settled (${journalError}), so ${entryId} may ` +
            "still read as pending and undo may decline it — check abap_journal first."
          : ""),
    );
  }

  // Settle FIRST, with the pre-activation bytes; only THEN look for the post-activation
  // ones (next block). A settle before any further request guarantees the entry reaches
  // a TERMINAL outcome — if the re-read ran first and failed silently, the entry could be
  // left `pending`, which `undoBlocker()` refuses outright with no `force` escape. That's
  // strictly worse than the wrong-but-forceable after-image this trades for. Settling twice
  // degrades, at worst, to the pre-fix behaviour.
  await settle({
    outcome: "succeeded",
    // Provisional after-image: what abapsmith PUT, before activation. Correct for
    // every write that doesn't activate; upgraded in place below for those that do.
    ...(written.normalisedSource ? { afterSource: written.normalisedSource } : {}),
    activation: {
      attempted,
      ...(activation ? { activated: activation.activated } : {}),
    },
  });

  // ---- Post-activation re-read: the returned etag AND the after-image ------
  //
  // `writeObject` never activates, so `written.etag`/`written.normalisedSource` are
  // always pre-activation. For properties-shape types that DO activate (DOMA/DD,
  // TTYP/DA, ENQU/DL — not MSAG/N, born active with no inactive version), activation
  // flips `adtcore:version`/`adtcore:changedAt`, and since the etag hashes the WHOLE XML
  // descriptor (no separate /source/main like PROG/P/CLAS/OC), that changes the hash.
  // Source-shape types never show this because activation doesn't rewrite their bare
  // source text. Full incident and root-cause notes: the git history.
  //
  // Two consequences, both from feeding one stale pre-activation value to two consumers:
  //  1. The etag returned to the caller was stale, so round-tripping it as `expect_etag`
  //     on the next write produced a spurious ETAG_CONFLICT against nothing.
  //  2. `settle()` used to run before this re-read, recording the pre-activation document
  //     as the journal's after-image; `detectDrift` then compared a post-activation read
  //     against it on every later undo and threw a false ETAG_CONFLICT.
  //
  // Fix: read once, HERE, and feed the same result to both the returned etag and a SECOND
  // settle that upgrades the after-image (settling twice is an established idiom — see
  // src/tools/enh.ts — and `Journal.settleInner` merges patches last-write-wins by id).
  // No extra request: the old code already paid for this read and discarded half its value.
  //
  // Scoped to `propertiesShape && activation?.activated === true` only — every other path's
  // etag/source already matches a subsequent read, so widening this would add a round trip
  // to writes the bug doesn't affect. `previousEtag`/`changed` describe the WRITE itself and
  // are untouched by activation.
  //
  // Both the re-read and the upgrade-settle are best-effort and fall back to the pre-fix
  // values on failure — this can only degrade to the old (forceable-false-conflict)
  // behaviour, never below it, and a failure is surfaced as a note (below), never swallowed.
  // The two failure modes are tracked separately since they leave the caller in different
  // states (failed re-read: both etag and after-image stale; failed upgrade-settle: only
  // the after-image stale).
  let finalEtag = written.etag;
  let postActivationReadError: string | undefined;
  let afterImageUpgradeError: string | undefined;
  // Whether the re-read below (already paid for) also settles two questions
  // the caller would otherwise re-read to answer: is the object there, and
  // does its own descriptor claim to be the active version.
  let readBackActive = false;
  let readBackPresent = false;
  if (propertiesShape && activation?.activated === true) {
    let postActivationSource: string | undefined;
    try {
      postActivationSource = await readCurrentSource(conn, { ...written.target, exists: true });
    } catch (e) {
      postActivationReadError = String(e);
    }
    if (postActivationSource !== undefined) {
      readBackPresent = true;
      readBackActive = activationFromBody(postActivationSource) === "active-is-current";
      finalEtag = canonicalEtag(postActivationSource);
      try {
        await settle({
          outcome: "succeeded",
          // The fix from above, in one field: the after-image undo compares against is now
          // the post-activation document, not the one abapsmith PUT before it.
          afterSource: postActivationSource,
          // Re-stated, not omitted, so the last record a reader sees isn't silent about activation.
          activation: {
            attempted,
            ...(activation ? { activated: activation.activated } : {}),
          },
        });
      } catch (e) {
        afterImageUpgradeError = String(e);
      }
    }
  }

  // verified mode only: one read-back that presence-checks what was just
  // written. `speculative` skips it — a clean create+activate is taken as
  // sufficient. This is the success path; failure-path verification
  // (reportCreateOrphan, src/adt/write.ts) is unconditional in both modes.
  let verifyOutcome: VerifyOutcome | undefined;
  if (verifyMode === "verified") {
    verifyOutcome = await verifyObjectPresent(conn, {
      uri: contentUri(written.target),
      accept: contentAccept(written.target),
      objectName,
      expectType: written.target.type,
    });
  }

  // Same reasoning as the delete branch: an id exists iff a real entry landed.
  const journalled = entryId !== undefined;

  const blocks: string[] = [];
  const checkText = renderMessages(check.messages, source);
  if (checkText.trim()) blocks.push(`# SYNTAX CHECK\n${checkText}`);
  if (activation) {
    const actText = renderMessages(activation.messages, source);
    if (actText.trim()) blocks.push(`# ACTIVATION\n${actText}`);
    if (activation.preaudit?.length) {
      blocks.push(`# CO-ACTIVATED\n${renderCoActivated(activation.preaudit)}`);
    }
    if (activation.inactive.length) {
      blocks.push(`# INACTIVE DEPENDENTS\n${renderInactive(activation.inactive)}`);
    }
  }

  // NOTE: `wantActivate && !check.ok` is unreachable here — it throws in the try block
  // above (G-05), so getting this far means either activation ran or activate=false.
  const notes: string[] = [transportNote(written.transport, gate.config?.abapMode)];
  // Quote the resolver's own account of the transport decision, but only when its
  // trkorr provably matches the one this write actually used — a stale or
  // unrelated lastAutoDecision must never be attributed to this write.
  if (
    transport !== undefined &&
    written.transport.status === "transport" &&
    written.transport.corrNr !== undefined &&
    transport.lastAutoDecision?.trkorr.toUpperCase() === written.transport.corrNr.toUpperCase()
  ) {
    notes.push(transport.lastAutoDecision.reason);
  }
  // Two distinct notes: the two failures leave different values stale, and a caller
  // acts on them differently. The write itself succeeded and is activated in both cases.
  if (postActivationReadError) {
    notes.push(
      `${objectName} WAS written and activated, but the read-back taken after activation ` +
        `failed (${postActivationReadError}), so the etag reported above and the after-image ` +
        "recorded for undo are both the PRE-activation values. This is not a conflict and " +
        "nobody else touched the object. Do not pass this etag as expect_etag — re-read " +
        `${objectName} and use that etag instead. abap_journal mode=undo still works, but its ` +
        "drift check may refuse with ETAG_CONFLICT purely because of this stale image; if it " +
        "does, that refusal is about this failed read, not about a real conflict.",
    );
  } else if (afterImageUpgradeError) {
    notes.push(
      `${objectName} WAS written and activated, and the etag reported above is correct, but ` +
        `the journal's after-image could not be updated to the post-activation document ` +
        `(${afterImageUpgradeError}). The write is journalled and undoable; the recorded image ` +
        "is the pre-activation one, so abap_journal mode=undo may refuse with ETAG_CONFLICT " +
        "even though nobody else touched the object. If it does, compare the object against " +
        "the recorded image with abap_journal mode=show before deciding, and pass force=true " +
        "only once you have confirmed the only writer was abapsmith.",
    );
  }
  if (activationSuppressed) {
    // Not the same statement as activate=false below — that would be a lie in the
    // dangerous direction: the object is ACTIVE, not saved-inactive-and-inert.
    notes.push(
      `${written.target.type} has no inactive version — it is active as written, and no ` +
        "activation step was needed or attempted.",
    );
  } else if (!wantActivate) {
    notes.push("activate=false — the object is saved INACTIVE and will not execute.");
  }
  // Set true wherever a silent-drop / no-op WARNING below is pushed — the
  // CONCLUSIVE note (further down) checks this rather than string-matching notes.
  let dropWarned = false;
  if (propertiesShape) {
    notes.push(
      "This type is written as its complete XML descriptor: a write REPLACES the whole " +
        "object, so read it first and send back the full document with your edits applied.",
    );
    // Live finding: a MSAG/N write carrying a fabricated child element (`<mc:longtext>`)
    // returned changed:true, but the etag was unchanged on a follow-up read — the element
    // was silently discarded server-side, a true no-op the caller had no way to see.
    //
    // Fix: for a properties-shape UPDATE, `written.etag` now comes from an independent
    // post-write GET (`written.etagSource === "post-write-read"`), and `written.changed`
    // is derived by comparing that against what was there before — so a silently discarded
    // write now surfaces as `changed: false`, turned into an explicit warning below.
    if (written.etagSource === "post-write-read" && !written.changed) {
      dropWarned = true;
      notes.push(
        "WARNING: the write you asked for differed from what was on the server, and the " +
          "server accepted it (no error), but a read-back taken right after the write shows " +
          "the object's etag UNCHANGED — canonically, nothing you asked for actually took " +
          "effect. abapsmith cannot tell WHY (a fabricated or misspelled element the server " +
          "silently discarded is one common cause), only THAT nothing landed; re-read the " +
          "object and rework your payload before retrying.",
      );
    } else if (
      written.etagSource === undefined &&
      written.changed &&
      written.previousEtag !== undefined &&
      written.etag === written.previousEtag
    ) {
      // Defensive fallback for any properties-shape path the post-write-read fix doesn't
      // reach (currently only CREATE, not known reachable today, but left in so a future
      // path without its own post-write read isn't left with zero coverage). Heuristic
      // only: both etags trace back to the PUT's own response, not independent confirmation.
      dropWarned = true;
      notes.push(
        "WARNING: the server reported this write as accepted, but the object's etag is " +
          "UNCHANGED from before the write — canonically, nothing about the stored document " +
          "actually differs. abapsmith cannot tell whether the whole payload was a no-op or " +
          "whether the server silently discarded something it did not recognise (a fabricated " +
          "or misspelled element, for example); either way, re-read the object and confirm your " +
          "change actually landed before relying on it.",
      );
    }
    // Element-level discards. The activate path above REFUSES to activate when
    // it finds one (there is a claim of "activated" it can still retract); this site can
    // only warn, because by the time `written` exists the PUT already landed and — on the
    // `activate: false` path that reaches here — nothing was ever staged for activation to un-claim.
    if (written.etagSource === "post-write-read" && written.normalisedSource !== undefined) {
      const discarded = discardedDescriptorValues(source, written.normalisedSource);
      if (discarded.length > 0) {
        dropWarned = true;
        notes.push(
          `WARNING: the server silently dropped ${discarded.length === 1 ? "an element" : `${discarded.length} elements`} ` +
            `abapsmith sent, keeping the rest — ${discarded.map(describeDiscard).join("; ")}. ` +
            "Re-read the object to see the descriptor the server actually holds.",
        );
      }
    }
  }
  // ---- Say it out loud when a write made the object smaller ----
  // Disclosure, not a refusal: large shrinks are often legitimate, so a blocking threshold
  // would just get switched off. Refusal is reserved for cases with actual proof the caller
  // never held the whole text (a `partial:` etag or an echoed tool response, above). This
  // note just makes a silent tail deletion visible; the journal entry (below) makes it recoverable.
  const shrink = describeShrink(written.previousSource, source);
  if (written.changed && shrink) {
    notes.push(
      `SIZE: this write REMOVED ${shrink.removedLines} of ${shrink.beforeLines} line(s) ` +
        `(${shrink.percent}% of the object). If you did not intend to delete that much — the ` +
        "usual cause is editing and writing back the text from a TRUNCATED read — " +
        // Must be true of THIS call — naming undo when the journal is off would
        // contradict the "journal is OFF" note a few lines below.
        (journalled
          ? "undo it with abap_journal mode=undo before anything else touches the object."
          : "restore it NOW: the write journal is off, so there is no before-image to undo from " +
            "and the removed lines exist only in whatever copy you still hold."),
    );
  }
  if (written.normalisedSource) {
    // Scoped to CONTENT, so it does not read as a contradiction of the CONCLUSIVE
    // note below, which settles only that the write landed.
    notes.push(
      "The server normalised the source, so the bytes it stored are not the bytes you sent; " +
        "re-read the object before editing it again.",
    );
  }
  if (formatted?.changed) {
    notes.push(
      "format:true — the source was pretty-printed before saving; the bytes on the server are " +
        "not the bytes you sent. Re-read before editing again.",
    );
  }
  if (journalled) {
    notes.push(
      written.created
        ? `Journalled as ${entryId}. This object did not exist before, so undo DELETES it.`
        : `Journalled as ${entryId}, with the previous source kept as the before-image.`,
    );
  } else if (!journal?.enabled) {
    notes.push("The write journal is OFF — abapsmith cannot undo this change.");
  } else if (!written.changed) {
    notes.push("Source was already identical — nothing was written, so nothing was journalled.");
  }
  // Every signal here already exists above; this just states the conclusion they add up to,
  // so a caller doesn't re-read an object this response already proves landed. All must hold.
  const conclusive =
    wantActivate &&
    (activation?.activated === true || activationSuppressed) &&
    (propertiesShape || check.ok) &&
    !dropWarned &&
    (written.created === true || finalEtag !== written.previousEtag) &&
    postActivationReadError === undefined &&
    (!(propertiesShape && activation?.activated === true) || readBackActive);
  if (conclusive) {
    // Each clause is emitted only by the signal that establishes it, so the prose cannot
    // drift away from its evidence. `conclusive` implies `wantActivate`, so the activation
    // branch above ran — and that branch reads the object back and REFUSES to activate
    // unless the stored source hashes to `written.etag` (the pre-activation content gate).
    // That read, not the PUT's own echo, is what earns "as written" here.
    //
    // `written.created` short-circuits the etag disjunct in `conclusive`, and a create has
    // no pre-write etag to advance from — so only claim an advance when one was compared.
    const etagAdvanced =
      !written.created && written.previousEtag !== undefined && finalEtag !== written.previousEtag;
    const landedClause = readBackActive
      ? `abapsmith read it back from the server after activation and the server returned it as the active version`
      : "the server accepted the write, a read-back taken before activation confirmed the stored " +
        "source matches the etag reported above" +
        (etagAdvanced ? ", that etag differs from the pre-write one" : "") +
        ", and activation reported success";
    notes.push(
      `CONCLUSIVE: ${objectName} is on ${conn.cfg.sid} as written — ${landedClause}. That settles ` +
        "that this write landed, so an abap_read to check THAT would repeat what this response " +
        "already establishes. It does NOT settle whether the source says what you meant, which is " +
        "the only thing worth reading it back for.",
    );
  } else if (readBackPresent && !readBackActive) {
    notes.push(
      `abapsmith read ${objectName} back from ${conn.cfg.sid} after activation and the server ` +
        "returned it, so it is present — but the descriptor it returned does not report itself as " +
        "the active version, so its active state is NOT settled here. Confirm it with abap_read " +
        '{object, type, version:"active"} before building on it.',
    );
  }
  if (verifyMode === "speculative") {
    // Suppressed wherever a stronger note above already answers the same question:
    // the properties-shape re-read (`readBackPresent`) and the CONCLUSIVE note both
    // settle that the object is there, and this note's opposite framing ("you do not
    // need to read it back") only muddles them. Only push it when nothing else did.
    if (!readBackPresent && !conclusive) {
      // Say what actually happened: `activate:false` activates nothing and a
      // byte-identical source writes nothing — the old wording claimed both.
      // Written and activated are stated separately because they come apart.
      const happened =
        (written.changed
          ? "this write saved without error"
          : "the source was already identical, so nothing was written") +
        (activation !== undefined
          ? " and activation reported success"
          : activationSuppressed
            ? ", and this type needs no activation"
            : ", and nothing was activated (activate=false)");
      notes.push(
        `verify: speculative — ${happened} — abapsmith is treating that as sufficient; you do ` +
          "not need to read the object back to confirm it. The checks that cost nothing still " +
          "apply: " +
          (activation !== undefined
            ? 'activation messages with type "E" mean it FAILED despite the 200, and '
            : "") +
          "an unchanged etag means the PUT was a no-op. Set ABAP_VERIFY_WRITES=verified, or pass " +
          "verify:true on one risky write, to have abapsmith read it back.",
      );
    }
  } else if (verifyOutcome?.status === "confirmed") {
    notes.push(
      `verify: verified — ${objectName} was read back after the write and confirmed present at ` +
        `${verifyOutcome.uri} (via ${verifyOutcome.via}). That settles that the object is there; ` +
        "it does not settle that its CONTENT is what you intended. If that matters, " +
        'abap_read {object, type, version:"active"} — omitting version can return a newer ' +
        "INACTIVE version.",
    );
  } else {
    const reason =
      verifyOutcome?.status === "indeterminate"
        ? verifyOutcome.reason
        : "a repository search found no exact-name hit";
    notes.push(
      "verify: verified — the write reported success, but the read-back did NOT confirm " +
        `${objectName} is there: ${reason} This is NOT proof the write failed (an index can lag ` +
        "a fresh create), and abapsmith is not retracting the success above — but do not build on " +
        "this object until you have confirmed it yourself with abap_read {object, type, " +
        'version:"active"}.',
    );
  }

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      object: objectName,
      uri: written.target.uri,
      // `uri` is the CLASS even when the bytes went to a local include (that's
      // what was locked/transported), so without this the include field a CCAU write
      // is indistinguishable from a main-source write. Only emitted for a real sub-include.
      ...(written.target.include && written.target.include !== "main"
        ? { include: written.target.include }
        : {}),
      package: written.target.packageName,
      package_source: written.target.packageSource,
      mode: "write",
      created: written.created,
      changed: written.changed,
      etag: finalEtag,
      previousEtag: written.previousEtag,
      transport: transportHeaderText(written.transport),
      check: propertiesShape
        ? "n/a (XML descriptor — validated by the server on write)"
        : check.ok
          ? "clean"
          : `${check.errors} error(s), ${check.warnings} warning(s)`,
      activated: activation ? activation.activated : activationSuppressed ? "n/a (always active)" : "skipped",
      verify:
        verifyMode === "speculative"
          ? readBackActive
            ? "confirmed — read back after activation"
            : readBackPresent
              ? "read back after activation — NOT reported active"
              : // "not read back" beside the CONCLUSIVE note is the strongest available
                // signal to re-read an object that note just settled. Names the read that
                // did happen — the pre-activation content gate, not a confirmation after it.
                conclusive
                ? "speculative — matched a read-back taken before activation, not after"
                : "speculative (not read back)"
          : verifyOutcome?.status === "confirmed"
            ? `verified — confirmed present via ${verifyOutcome.via}`
            : "verified — NOT confirmed (see NOTE)",
      formatted: !input.format ? "no" : formatted?.changed ? `${formatted.linesChanged} line(s)` : "no change",
      journal: journalled ? entryId : "off (nothing recorded)",
    },
    body: blocks.join("\n\n"),
    bodyLabel: "MESSAGES",
    notes,
    hints: [
      "Pass expect_etag from the last abap_read to make the next write compare-before-write.",
      "Use abap_activate mode=check to syntax-check a draft without saving it.",
      ...(journalled ? [`Revert this change with abap_journal mode=undo entry=${entryId}.`] : []),
    ],
    maxChars,
  });
}

/** One `objects` entry's outcome — see {@link abapWriteBatchDelete}. */
export interface ObjectDeleteOutcome {
  readonly name: string;
  readonly type: string;
  readonly uri: string;
  readonly ok: boolean;
  /**
   * Four states, mirroring `deleteObject`'s own return plus one Pass-1
   * outcome: `true` — a read-back confirmed the object is gone. `false` —
   * two probes (a read-back and an independent repository search) agree the
   * object is still there; the DELETE was accepted but did not take, and
   * `ok` is `false` for this entry too. `"unverified"` — neither probe could
   * settle it; `ok` stays `true` (the DELETE itself was accepted and is
   * durable), but the caller should treat the object's actual fate as
   * unconfirmed. `"already-absent"` — the object was not on the system in
   * Pass 1, so nothing was locked, deleted, or journalled for it; `ok` stays
   * `true` because the requested end state (the object gone) already held.
   */
  readonly deleted: boolean | "unverified" | "already-absent";
  /**
   * The journal entry this delete's before-image was captured under, set
   * whenever the delete was actually journalled — REGARDLESS of `ok`. A
   * `deleted: false` (contradicted) entry that was journalled is still
   * recoverable through `abap_journal mode=undo`; this field is what says so.
   */
  readonly journalEntry?: string;
  /** Set only on a failed delete (`ok: false`), including a contradicted (`deleted: false`) one. */
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * A DELETE ends the ABAP session, so the next entry's LOCK must not ride the
 * dropped context. `dropSession()` re-establishes it; `connect()` revives an
 * already-dead connection.
 */
async function renewSessionBetweenDeletes(conn: AbapConnection): Promise<void> {
  if (!conn.isDead) {
    try {
      await conn.dropSession();
    } catch {
      // Swallowed — next entry issues its own request.
    }
  }
  if (conn.isDead) {
    try {
      await conn.connect();
    } catch {
      // Swallowed — ditto.
    }
  }
}

/**
 * Batch path for `abap_write`'s `objects` field (mode=delete only). See that schema
 * field's doc comment for the caller contract, and `MAX_DELETE_BATCH` (src/adt/write.ts)
 * for the cap's derivation.
 *
 * Two passes, structurally like `abapActivateBatch`, but Pass 2 diverges on purpose.
 * **Pass 1 (validation) is all-or-nothing, with one exception**: every entry is resolved via
 * `authorizeMutation` and ALSO checked with `isPackageType` directly — `authorizeMutation` only
 * refuses packages for op:"activate", so this catches a DEVC/K before Pass 2 could delete
 * anything ahead of it. The exception is an entry that does not exist at all: that is recorded
 * as `deleted: "already-absent"` and the rest of the batch still proceeds. Every other Pass 1
 * refusal — an existing package, a duplicate name, an unknown/ambiguous type, a gate refusal —
 * still aborts the whole call before anything is deleted.
 *
 * **Pass 2 (execution) does NOT mirror activation's Pass 2.** Activation's mutation phase
 * is one real server-side batch POST, so atomicity is free. ADT has no multi-object DELETE
 * — each object here is its own lock→DELETE — so faking atomicity would mean either rolling
 * back completed deletes (impossible, no undo but the journal) or aborting after the first
 * failure (hides which objects are already gone). Instead: delete one at a time, in the
 * exact caller order (no dependency reordering), and do not stop on a failure.
 *
 * Every entry runs its own `withJournalledMutation` call, so a batch of N produces up to N
 * independent journal entries — never one aggregate entry — since `abap_journal mode=undo`
 * operates on one entry at a time and a partially-failed batch must stay undoable per-object.
 *
 * Pass 2 also renews the ABAP session between entries: `deleteObject`'s own
 * `withStatefulSession` tears the session down after a DELETE, so the next entry's LOCK
 * would ride a context the server already dropped — see `renewSessionBetweenDeletes`.
 *
 * That per-object continuation is execution only: the value this function returns/throws
 * does NOT stay `ok` for a partial failure — any object left undeleted throws `CHECK_FAILED`,
 * same as a total wipeout, so a caller reading only `isError` is never told a delete happened
 * when it did not. `details.perObject` on that throw still carries every succeeded object's
 * `journalEntry`, so the throw never hides an undo id for a delete that actually happened.
 */
export async function abapWriteBatchDelete(
  conn: AbapConnection,
  entries: ReadonlyArray<{ object: string; type?: string; affects?: EnhancedObjectRef }>,
  maxChars: number,
  gate: SafetyGate,
  journal: Journal | undefined,
  transport?: SessionTransport,
): Promise<BuiltResponse> {
  // Defensive re-check: the schema enforces .min(1).max(MAX_DELETE_BATCH), but this
  // function is exported and callable directly without going through it.
  if (entries.length === 0) {
    throw new AbapError("BAD_INPUT", "`objects` must name at least one object.", {});
  }
  if (entries.length > MAX_DELETE_BATCH) {
    throw new AbapError(
      "BAD_INPUT",
      `\`objects\` names ${entries.length} objects, more than the ${MAX_DELETE_BATCH}-object ` +
        "batch delete cap.",
      { count: entries.length, max: MAX_DELETE_BATCH },
      `Split this into batches of at most ${MAX_DELETE_BATCH} objects.`,
    );
  }

  const wanted = entries.map((e) => {
    const hint = e.type ? (specForType(e.type) ?? specForKeyword(e.type)) : undefined;
    const parsed = parseObjectRef(e.object, hint);
    const type = e.type ?? parsed.spec?.type;
    return {
      name: parsed.name,
      ...(parsed.parent ? { containerName: parsed.parent } : {}),
      ...(type ? { type } : {}),
      ...(e.affects ? { affects: e.affects } : {}),
      affectsRef: e.affects,
    };
  });

  // ---- pass 1: resolve + authorise + package-refuse EVERY entry, before
  // deleting ANY -----------------------------------------------------------
  // Ordered like `wanted` — an authorized target keeps its `affects`; an
  // already-absent entry carries just enough to report it (no `affects`, it
  // is never mutated). Kept as one union array, not two lists, so pass 2 can
  // walk it in caller order without re-deriving that order.
  type Pass1Entry =
    | {
        kind: "authorized";
        authorized: AuthorizedTarget<MutatingOperation, ResolvedTarget>;
        affects?: EnhancedObjectRef;
      }
    | { kind: "absent"; name: string; type: string; uri: string };
  const pass1: Pass1Entry[] = [];
  for (const w of wanted) {
    let a: AuthorizedTarget<MutatingOperation, ResolvedTarget>;
    try {
      a = await authorizeMutation(conn, gate, "delete", w);
    } catch (e) {
      // An already-absent entry is a no-op, not a refusal — UNLESS it
      // resolved to a package: a would-be DEVC/K stays a whole-batch abort,
      // same as an EXISTING package below, so it can't sneak past that guard
      // by not existing. Also require `operation === "delete"`: that field
      // is only ever set by `authorizeMutation`'s own "does not exist" throw,
      // so a different NOT_FOUND surfaced through `resolveWriteTarget` (e.g.
      // a stale search-index contradiction) keeps its own guidance and still
      // aborts the batch, rather than being swallowed as "already absent".
      if (
        isAbapError(e) &&
        e.code === "NOT_FOUND" &&
        e.details.operation === "delete" &&
        !isPackageType(e.details.type as string | undefined)
      ) {
        pass1.push({
          kind: "absent",
          name: (e.details.name as string | undefined) ?? w.name,
          type: (e.details.type as string | undefined) ?? w.type ?? "",
          uri: (e.details.uri as string | undefined) ?? "",
        });
        continue;
      }
      throw e;
    }
    if (isPackageType(a.target.type)) {
      throw new AbapError(
        "UNSUPPORTED",
        `Packages are deleted one at a time, not in a batch (${a.target.name} in \`objects\` is ` +
          "DEVC/K). Nothing in this batch was deleted.",
        { type: a.target.type, name: a.target.name },
        "Remove the package from `objects` and use a single-object " +
          '`abap_write { mode: "delete", type: "DEVC/K" }` call for it — or delete the remaining ' +
          "objects in a separate batch without it.",
      );
    }
    pass1.push({ kind: "authorized", authorized: a, affects: w.affectsRef });
  }
  assertNoDuplicateDeleteTargets(
    pass1.map((p) => (p.kind === "authorized" ? p.authorized.target : p)),
  );

  // ---- pass 2: delete one at a time, in caller order, continue past a
  // per-object failure -------------------------------------------------------
  const outcomes: ObjectDeleteOutcome[] = [];
  let sessionSpent = false;
  for (const p of pass1) {
    if (p.kind === "absent") {
      outcomes.push({
        name: p.name,
        type: p.type,
        uri: p.uri,
        ok: true,
        deleted: "already-absent",
      });
      continue;
    }
    if (sessionSpent) await renewSessionBetweenDeletes(conn);
    sessionSpent = true;
    const { authorized: a, affects } = p;
    const t = a.target;
    const trOpts = transport
      ? { transport, gate, ...(affects ? { affects } : {}) }
      : { ...(affects ? { affects } : {}) };
    try {
      const { result: res, entryId, settle } = await withJournalledMutation(
        journal,
        {
          begin: (img: BeforeImage) => ({
            operation: "delete" as const,
            object: journalRef(img.target),
            existedBefore: img.existed,
            beforeCapture: captureOf(img),
            ...(img.source !== undefined ? { beforeSource: img.source } : {}),
            ...(img.sourceKind !== undefined ? { beforeKind: img.sourceKind } : {}),
            ...(img.corrNr !== undefined ? { corrNr: img.corrNr } : {}),
            systemKey: systemKey(conn.cfg),
            tool: "abap_write",
          }),
        },
        (onBeforeImage) => deleteObject(conn, a, { ...trOpts, onBeforeImage }),
      );
      await settle({ outcome: "succeeded", activation: { attempted: false } });
      // A `deleted: false` result (two probes agree the object is
      // still there) must NOT be counted as a success — but it still carries
      // its journalEntry when one exists, since that entry is what makes
      // this object's delete recoverable. This is why the batch never
      // throws on it: one object failing verification must not abort the
      // rest of the run.
      if (res.deleted === false) {
        outcomes.push({
          name: res.target.name,
          type: res.target.type,
          uri: res.target.uri,
          ok: false,
          deleted: false,
          error: {
            code: "CHECK_FAILED",
            message: `${deleteNotConfirmedSentence(res.target.type, res.target.name, res.verification)}.`,
          },
          ...(entryId !== undefined ? { journalEntry: entryId } : {}),
        });
      } else {
        outcomes.push({
          name: res.target.name,
          type: res.target.type,
          uri: res.target.uri,
          ok: true,
          deleted: res.deleted,
          ...(entryId !== undefined ? { journalEntry: entryId } : {}),
        });
      }
    } catch (e) {
      // A programmer error must still crash, not be folded into a per-object outcome.
      if (!isAbapError(e)) throw e;
      outcomes.push({
        name: t.name,
        type: t.type,
        uri: t.uri,
        ok: false,
        deleted: false,
        error: { code: e.code, message: e.message },
      });
    }
  }

  const succeeded = outcomes.filter((o) => o.ok);
  const failed = outcomes.filter((o) => !o.ok);
  // `succeeded` still includes `deleted: "unverified"` entries (ok stays
  // true — see ObjectDeleteOutcome), but the rollup below must not fold them
  // into a plain "deleted" count.
  const confirmed = succeeded.filter((o) => o.deleted === true);
  const unverified = succeeded.filter((o) => o.deleted === "unverified");
  const absent = outcomes.filter((o) => o.deleted === "already-absent");
  // By `journalEntry !== undefined`, not by `ok`: a contradicted
  // delete (`ok: false`, `deleted: false`) that was still journalled is
  // recoverable through abap_journal mode=undo just like a succeeded one,
  // and the tally below must say so.
  const journalled = outcomes.filter((o) => o.journalEntry !== undefined);

  const body = outcomes
    .map((o) => {
      if (!o.ok) {
        return (
          `${o.type} ${o.name}: FAILED — [${o.error!.code}] ${o.error!.message}` +
          (o.journalEntry ? ` (journalled as ${o.journalEntry}, still recoverable)` : "")
        );
      }
      if (o.deleted === "already-absent") {
        return `${o.type} ${o.name}: already absent — nothing to delete, nothing was locked or journalled`;
      }
      const journalSuffix = o.journalEntry
        ? ` — journalled as ${o.journalEntry}`
        : " — NOT journalled (irreversible)";
      return o.deleted === "unverified"
        ? `${o.type} ${o.name}: deleted (UNVERIFIED — abapsmith could not confirm the object is ` +
            `actually gone)${journalSuffix}`
        : `${o.type} ${o.name}: deleted${journalSuffix}`;
    })
    .join("\n");

  // ANY failure — not just a total wipeout — means the envelope must
  // not be `ok`. A caller keying on `isError` (as the MCP protocol says it
  // should) must not be told a delete happened for an object that was never
  // even attempted (e.g. its before-image never captured, so it has zero
  // journal entries). Execution itself is unchanged (still continues past a
  // per-object failure, see this function's doc comment); only the reported
  // outcome is. `perObject` below still carries every succeeded object's
  // `journalEntry`/`deleted`, so this throw can never hide an undo id for a
  // delete that genuinely happened.
  if (failed.length > 0) {
    const total = failed.length === outcomes.length;
    throw new AbapError(
      "CHECK_FAILED",
      total
        ? `Batch delete of ${outcomes.length} object(s) failed: none were deleted.`
        : `Batch delete of ${outcomes.length} object(s): ${confirmed.length} deleted` +
          (unverified.length > 0 ? `, ${unverified.length} unverified` : "") +
          (absent.length > 0 ? `, ${absent.length} already absent` : "") +
          `, ${failed.length} failed. The ${succeeded.length} that succeeded are NOT rolled back.`,
      {
        objects: outcomes.map((o) => o.name),
        blamed: failed.map((o) => o.name),
        perObject: outcomes.map((o) => ({
          object: o.name,
          type: o.type,
          ok: o.ok,
          deleted: o.deleted,
          ...(o.journalEntry !== undefined ? { journalEntry: o.journalEntry } : {}),
          error: o.error,
        })),
        body,
      },
      total
        ? "Fix the failure(s) above and retry — nothing in this batch was deleted."
        : "Fix the failure(s) above and retry them individually — the objects already deleted are " +
          "not restored automatically. abapsmith does not roll back a partial batch; each " +
          "succeeded delete is undoable on its own via `abap_journal mode=undo entry=<id>`, using " +
          "the `journalEntry` id in `details.perObject`.",
    );
  }

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      objects: outcomes.map((o) => o.name).join(", "),
      count: outcomes.length,
      mode: "delete",
      deleted: confirmed.length,
      ...(unverified.length > 0 ? { unverified: unverified.length } : {}),
      ...(absent.length > 0 ? { absent: absent.length } : {}),
      failed: failed.length,
    },
    body,
    bodyLabel: "OBJECTS",
    // `failed` is always empty here — any failure threw CHECK_FAILED above — so this
    // no longer needs a NOT-deleted branch; only the all-succeeded case reaches this point.
    //
    // The summary line is a small helper rather than a nested ternary: a batch can be
    // confirmed/unverified/already-absent in any mix, and the all-absent batch needs its
    // own plain statement (no object existed) rather than a "0 confirmed deleted" reading.
    notes: [
      absent.length === outcomes.length
        ? `None of the ${outcomes.length} object(s) in this batch existed on ${conn.cfg.sid} — ` +
          "nothing was deleted."
        : unverified.length > 0 || absent.length > 0
          ? `${confirmed.length} of ${outcomes.length} object(s) confirmed deleted` +
            (unverified.length > 0 ? `; ${unverified.length} unverified` : "") +
            (absent.length > 0 ? `; ${absent.length} already absent` : "") +
            (unverified.length > 0 ? " — see the UNVERIFIED marker(s) above." : ".")
          : `All ${outcomes.length} object(s) were deleted.`,
      ...(journalled.length > 0
        ? [
            `${journalled.length} deletion(s) were journalled individually — ` +
              "abap_journal mode=undo entry=<id> re-creates any ONE of them from its own " +
              "before-image; there is no single id for the whole batch.",
          ]
        : []),
      // Every outcome here is a success (a failure of any kind throws above), so
      // `succeeded` and `outcomes` coincide. An already-absent entry is also `ok: true`
      // with no `journalEntry` but deleted nothing, so it must NOT count toward
      // "irreversible" — only successes that actually deleted something belong here.
      ...(succeeded.some((o) => o.deleted !== "already-absent" && o.journalEntry === undefined)
        ? [
            `${succeeded.filter((o) => o.deleted !== "already-absent" && o.journalEntry === undefined).length} ` +
              "deleted object(s) were NOT journalled (the write journal is off or was not available) " +
              "and are IRREVERSIBLE from here.",
          ]
        : []),
    ],
    maxChars,
  });
}

/**
 * `DEVC/K` create branch, reached only from the routing check above `abapWrite`'s
 * `source` guard. Mirrors the write path's shape but calls `createPackage`
 * (src/adt/write.ts) instead of `writeObject`: a package has no source, so there's
 * no check, activation, or `checkSource`/`activateObject`/`assertNoErrors` call.
 */
async function abapCreatePackage(
  conn: AbapConnection,
  target: WriteTarget,
  input: WriteInput,
  maxChars: number,
  gate: SafetyGate,
  trOpts: TransportOptions,
  journal?: Journal,
): Promise<BuiltResponse> {
  // Before any network request: none of these apply to a package create.
  if (input.source !== undefined) {
    throw new AbapError("BAD_INPUT", "A package has no source; omit `source`.", { name: target.name });
  }
  if (input.format) {
    throw new AbapError("BAD_INPUT", "A package has no source; `format` does not apply.", { name: target.name });
  }
  if (input.expect_etag !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      "`expect_etag` does not apply to a package create.",
      { name: target.name },
    );
  }
  if (input.activate === true) {
    throw new AbapError("BAD_INPUT", "A package cannot be activated.", { name: target.name });
  }
  if (!input.software_component?.trim()) {
    // Same guard as createPackage's — kept here too so it stays a
    // zero-network refusal (this fires before authorizeMutation below).
    // Shared hint text with the create route below.
    throw new AbapError(
      "BAD_INPUT",
      "`software_component` is required to create a package.",
      { name: target.name },
      PACKAGE_SOFTWARE_COMPONENT_HINT,
    );
  }

  // Bound outside the closure: TS discards the narrowing from the guard above
  // once inside a nested function body (the property could be reassigned before the call).
  const softwareComponent = input.software_component;

  // `software_component` is the only discriminator between the two create
  // routes. REST's `createPackage` can't create a transportable package:
  // its CTS pre-flight can only answer "local" for an object that doesn't
  // exist yet — the bridge route uses `preflightPackageCorr` instead.
  const wantsTransport = softwareComponent.trim().toUpperCase() !== "LOCAL";

  // Checked before authorizeMutation/any gate: `transport_layer` maps to
  // SCOMPKDTLN-PDEVCLASS (the transport LAYER, not a request number), and
  // setting it wrong on this API short-dumps LAYER_INVALID, so the bridge
  // never sets it — silently dropping the field here would be worse.
  if (wantsTransport && input.transport_layer !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      "`transport_layer` cannot be honoured for a transportable package created via the classrun " +
        "bridge (software_component is not LOCAL): SCOMPKDTLN-PDEVCLASS is the transport LAYER, " +
        "and setting it wrong on this API short-dumps LAYER_INVALID — so the bridge never sets " +
        "it, and abapsmith would be dropping the value silently rather than applying it.",
      { name: target.name, transportLayer: input.transport_layer },
      "Only a LOCAL package (created over ADT REST) accepts `transport_layer`. For a " +
        "transportable package, leave it unset — the software component's own configured " +
        "transport route decides — or set the layer by hand in SE21 afterward.",
    );
  }

  // "write" because a package create IS a create, not delete/activate
  // (authorizeMutation's NOT_FOUND-before-gate carve-out is for those only).
  const authorized = await authorizeMutation(conn, gate, "write", target);

  if (!wantsTransport) {
    // ---- REST route: software_component=LOCAL, entirely unchanged. ----
    const { result: res, entryId, settle } = await withJournalledMutation(
      journal,
      {
        begin: (img: BeforeImage) => ({
          operation: "create",
          object: journalRef(img.target),
          existedBefore: img.existed,
          beforeCapture: captureOf(img),
          ...(img.corrNr !== undefined ? { corrNr: img.corrNr } : {}),
          systemKey: systemKey(conn.cfg),
          tool: "abap_write",
          // Undo of a package create is a real delete through the bridge,
          // gated by `deleteEvidenceBlocker`'s absence proof plus the bridge's
          // own emptiness precondition.
        }),
      },
      (onBeforeImage) =>
        createPackage(conn, authorized, {
          ...trOpts,
          softwareComponent,
          ...(input.package_type ? { packageType: input.package_type } : {}),
          ...(input.transport_layer !== undefined ? { transportLayer: input.transport_layer } : {}),
          onBeforeImage,
        }),
    );

    await settle({ outcome: "succeeded", activation: { attempted: false } });
    const journalled = entryId !== undefined;

    return buildResponse({
      header: {
        system: conn.cfg.sid,
        object: `${res.target.type} ${res.target.name}`,
        uri: res.target.uri,
        package: res.target.packageName,
        package_source: res.target.packageSource,
        super_package: res.superPackage,
        mode: "create-package",
        created: res.created,
        software_component: res.softwareComponent,
        package_type: res.packageType,
        transport_layer: res.transportLayer,
        transport: transportHeaderText(res.transport),
        journal: journalled ? entryId : "off (nothing recorded)",
      },
      notes: [
        transportNote(res.transport, gate.config?.abapMode),
        journalled
          ? `Journalled as ${entryId}. abap_journal mode=undo deletes it while it stays empty ` +
            "(abapsmith can also delete it directly, abap_write mode=delete). SE80/SE21 otherwise."
          : "The write journal is OFF. abapsmith can still delete this package directly " +
            "(abap_write mode=delete) while it stays empty, or remove it in SE80/SE21.",
        ...(res.superPackage === undefined
          ? [
              "ROOT package: no parent, no allowlisted container — permitted only because " +
                "ABAP_ALLOW_PACKAGES has the explicit `*` entry. Attach it to a parent, or " +
                "delete it directly (it's still deletable while empty).",
            ]
          : []),
      ],
      maxChars,
    });
  }

  // ---- Bridge route: software_component is anything other than LOCAL. ----

  // An internal wiring failure, not a caller mistake: every other
  // transportable mutation reaches here with a transport manager already
  // resolved into `trOpts` by the dispatcher above.
  if (trOpts.transport === undefined) {
    throw new AbapError(
      "TRANSPORT_ERROR",
      `${target.name} needs a transport request (software_component=${softwareComponent} is not ` +
        "LOCAL), but no transport manager is wired into this call. This is an internal wiring " +
        "failure in abapsmith — the dispatcher did not pass a transport manager through to the " +
        "package bridge route — not a mistake in the request, and not something fixable by " +
        "passing different arguments.",
      { name: target.name, softwareComponent },
    );
  }
  const transportMgr = trOpts.transport;
  const trGate = trOpts.gate;

  // Built from `authorized.target` (what `authorizeMutation`'s real GET
  // just resolved), never re-derived from the raw, unresolved `target`
  // this function was called with.
  const preflightTarget: PreflightTarget = {
    uri: authorized.target.uri,
    name: authorized.target.name,
    type: "DEVC/K",
    packageName: authorized.target.packageName,
    ...(authorized.target.superPackage !== undefined ? { superPackage: authorized.target.superPackage } : {}),
    exists: false,
  };
  // `trOpts.corrNr`, not a fresh `input.corr_nr` re-derivation: reading
  // `input.corr_nr` directly here would reopen the blank/whitespace bug
  // `normalizeCorrNr` already fixed for `trOpts`.
  const corr = await preflightPackageCorr(conn, preflightTarget, {
    transport: transportMgr,
    gate: trGate,
    ...(trOpts.corrNr !== undefined ? { corrNr: trOpts.corrNr } : {}),
  });
  // Any refusal `preflightPackageCorr` throws (its own gate, or CHECK_FAILED
  // if the transport resolver ever returns an outcome other than
  // "transport") propagates untouched — not wrapped, not re-worded.

  const superPackage = authorized.target.superPackage;
  // Same source REST's `createNewPackage` uses (`t.description`, i.e.
  // `authorized.target.description`) — already defaulted by
  // `resolveWriteTarget` if the caller supplied none.
  const description = authorized.target.description;

  const {
    result: bridgeRes,
    entryId,
    settle,
  } = await withJournalledMutation(
    journal,
    {
      begin: (img: BeforeImage) => ({
        operation: "create",
        object: journalRef(img.target),
        existedBefore: img.existed,
        beforeCapture: captureOf(img),
        ...(img.corrNr !== undefined ? { corrNr: img.corrNr } : {}),
        systemKey: systemKey(conn.cfg),
        tool: "abap_write",
        // Same as the REST route above: undo is a real bridge delete,
        // gated by `deleteEvidenceBlocker` plus the bridge's emptiness check.
      }),
    },
    async (onBeforeImage) => {
      // Same before-image shape REST's `createPackage` sends for a
      // not-yet-existing object (`existed: false` is what `authorized.target`
      // already reported via a real GET, not a guess), plus the `corrNr`
      // `preflightPackageCorr` just resolved.
      await onBeforeImage({
        source: undefined,
        existed: false,
        sourceReadable: true,
        target: authorized.target,
        corrNr: corr.corrNr,
      });
      return await createPackageViaBridge(conn, trGate, {
        packageName: preflightTarget.name,
        description,
        softwareComponent,
        corrNr: corr.corrNr,
        // The same "named"/"auto" `preflightPackageCorr` just resolved and
        // gated with — the second (domain-object) gate inside
        // createPackageViaBridge must judge the identical mutation, not a
        // re-guessed one.
        corrSource: corr.source,
        ...(superPackage !== undefined ? { superPackage } : {}),
        ...(input.package_type ? { packageType: input.package_type } : {}),
        exists: false,
      });
    },
  );

  await settle({ outcome: "succeeded", activation: { attempted: false } });
  const journalled = entryId !== undefined;

  // After `settle()`, not before: the journal already trusts the bridge's
  // own TDEVC re-read. `abap_read` is not used here — a live run found it
  // reports success for a nonexistent DEVC/K — so `verifyViaRepositorySearch` is
  // used instead, as `abapCreateViaBridge` does for VIEW/DV.
  // DEVC/K stays out of SEARCH_BLIND_TYPES: probed live 2026-09-05 for a local ($TMP-parented)
  // and a transportable package — search 0 hits before the create, 1 after, TDEVC classrun oracle.
  const verifyOutcome = await verifyViaRepositorySearch(conn, target.name, "DEVC/K");
  let verified: boolean;
  let verifyNote: string;
  if (verifyOutcome.status === "confirmed-absent") {
    throw new AbapError(
      "CHECK_FAILED",
      `${DDIC_BRIDGE_CLASS.createPackage} reported success (the transcript carries ` +
        `${bridgeRes.transcript.tags.join(", ")}) but a follow-up repository search returned no ` +
        `hit for ${target.name} (${verifyOutcome.uri}, via ${verifyOutcome.via}) — the same ` +
        "false-success shape VIEW/DV was once reproduced against live for (see " +
        "abapCreateViaBridge above). The search is calibrated for packages: live, a package " +
        "present in TDEVC was found by it both as a local and as a transportable package, so a " +
        "miss is strong evidence the create did not land — evidence, not proof of absence. This " +
        "was already journalled as created above: confirm which it is before acting, and if " +
        "CL_PACKAGE_FACTORY did leave something behind, delete it (abap_write mode=delete, " +
        "while empty) or clean up by hand in SE21.",
      { object: target.name, type: "DEVC/K", markers: bridgeRes.transcript.tags.join(" ") },
      "Confirm before acting: abap_search mode=objects type=\"DEVC\" for this name, or read TDEVC " +
        "directly (abap_data_preview, devclass = the package name). SE21 also shows it.",
    );
  } else if (verifyOutcome.status === "confirmed") {
    verified = true;
    verifyNote =
      `Read back and confirmed present at ${verifyOutcome.uri} (via ${verifyOutcome.via}) after create.`;
  } else {
    verified = false;
    verifyNote =
      `NOT independently confirmed present: ${verifyOutcome.reason} abapsmith still reports ` +
      "created:true here, trusting the classrun transcript (the markers above) — but that is not " +
      "the same confidence as a live read-back. `abap_read` on DEVC/K is NOT an acceptable " +
      "substitute for this check: a live run found it reports success for a package that does " +
      "not exist. Confirm by hand with abap_search mode=objects type=\"DEVC/K\".";
  }

  const transportInfo: TransportInfo = { status: "transport", required: true, corrNr: corr.corrNr };

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      object: `DEVC/K ${target.name}`,
      uri: authorized.target.uri,
      package: authorized.target.packageName,
      package_source: authorized.target.packageSource,
      super_package: superPackage,
      mode: "create-package-bridge",
      created: true,
      software_component: softwareComponent,
      package_type: input.package_type?.trim() || "development",
      transport: transportHeaderText(transportInfo),
      verified,
      bridge_class: DDIC_BRIDGE_CLASS.createPackage,
      markers: bridgeRes.transcript.tags.join(" "),
      tdevc: bridgeRes.tdevc
        ? `DEVCLASS=${bridgeRes.tdevc.devclass} PARENTCL=${bridgeRes.tdevc.parentcl} ` +
          `DLVUNIT=${bridgeRes.tdevc.dlvunit} KORRFLAG=${bridgeRes.tdevc.korrflag}`
        : undefined,
      journal: journalled ? entryId : "off (nothing recorded)",
    },
    notes: [
      transportNote(transportInfo, gate.config?.abapMode),
      "Created by running a generated ZCL_ZMCP_DDIC_CPKG classrun bridge, not over ADT REST: " +
        "CL_PACKAGE_FACTORY=>CREATE_NEW_PACKAGE, then lo_package->save(i_transport_request=...) " +
        "— SE21's own backend. See src/adt/package-create.ts and src/adt/ddic-bridge.ts.",
      verifyNote,
      ...tdevcDiscrepancies(bridgeRes.tdevc, {
        softwareComponent,
        ...(superPackage !== undefined ? { superPackage } : {}),
      }),
      journalled
        ? `Journalled as ${entryId}. abap_journal mode=undo deletes it while it stays empty ` +
          "(abapsmith can also delete it directly, abap_write mode=delete). SE80/SE21 otherwise."
        : "The write journal is OFF. abapsmith can still delete this package directly " +
          "(abap_write mode=delete) while it stays empty, or remove it in SE80/SE21.",
      ...(superPackage === undefined
        ? [
            "This is a ROOT package: it sits under no parent, in no container that any allowlist " +
              "names. It was permitted only because ABAP_ALLOW_PACKAGES contains the explicit `*` " +
              "wildcard entry. Attach it to a parent, or delete it directly (it's still deletable " +
              "while empty).",
          ]
        : []),
      "This bridge route (a transportable DEVC/K create via the classrun bridge) has NOT been " +
        "exercised against a live SAP system by the change that introduced it. The " +
        "underlying recipe (CL_PACKAGE_FACTORY=>CREATE_NEW_PACKAGE / lo_package->save, driven " +
        "through this same classrun-bridge mechanism) was verified live on A4H for a root package " +
        "and for a sub-package under a real transportable parent — see this type's capability " +
        "entry in src/adt/capabilities.ts — but that verification predates and is separate from " +
        "this specific code path; treat the first live call through abap_write on this route as a " +
        "first live call, not as a route with a track record.",
    ],
    maxChars,
  });
}

/**
 * `VIEW/DV` / `TRAN/T` — both create and delete, through the classrun bridge.
 * `resolveWriteTarget` refuses these two types outright for ANY op (see the
 * `isBridgeOnlyCreateType` refusal in `src/adt/write.ts`) — there is no writable ADT
 * collection to resolve a URI against — so this is the ONLY place either type's write or
 * delete is gated. Dispatches on `mode` before either sibling below is reached.
 */
async function abapBridgeCrud(
  conn: AbapConnection,
  target: WriteTarget,
  input: WriteInput,
  maxChars: number,
  gate: SafetyGate,
  journal?: Journal,
): Promise<BuiltResponse> {
  return (input.mode ?? "write") === "delete"
    ? abapDeleteViaBridge(conn, target, input, maxChars, gate)
    : abapCreateViaBridge(conn, target, input, maxChars, gate, journal);
}

/**
 * `VIEW/DV` / `TRAN/T` create. Delete is {@link abapDeleteViaBridge} below;
 * {@link abapBridgeCrud} dispatches between the two.
 *
 * Sibling of {@link abapCreatePackage}: no source, no check-run, no separate activation
 * POST. Almost every refusal below is zero-network and happens before the gate — the
 * exceptions are TRAN/T's program-existence check, the pre-create absence read below
 * (journal on, only), and both types' post-create read-back.
 *
 * Journalled as a plain `create` entry with `existedBefore: false` — but only when a
 * real read confirms absence first (`beforeCapture: "confirmed-absent"`, the one value
 * `deleteEvidenceBlocker` in src/adt/undo.ts accepts as authorising a delete-shaped undo).
 * That read is skipped entirely when `journal` is off: nothing downstream needs it then.
 * `abap_journal mode=undo` reverses this by resolving the object fresh through the VIT
 * bridge and calling the same delete bridge {@link abapDeleteViaBridge} uses — see
 * `src/adt/undo.ts`'s `isBridgeOnlyCreateType` branch in `planUndo`/`performUndo`.
 *
 * Both types are verified against a real read-back (`src/adt/write-verify.ts`) before
 * `created: true` is allowed to leave this function — a classrun transcript alone is not
 * proof (see that module's doc). Live-observed defect: VIEW/DV's transcript used to report
 * success (VIEW-PUT, VIEW-ACTIVATED, sy-subrc 0) for a view that was actually absent on
 * read-back, since `DDIF_VIEW_PUT` is an update-task-style write with no commit of its
 * own; `src/adt/view-create.ts` now issues an explicit `COMMIT WORK`, and if the object is
 * still confirmed-absent after create this throws `CHECK_FAILED` instead of reporting
 * success (see the throw in the `type === "VIEW/DV"` branch). A view that DOES persist is
 * still only ever a DATABASE view (DD25V class 'D'), never a maintenance view (class 'M').
 */
/**
 * Journals a VIEW/DV or TRAN/T create. Both bridge-create call sites share this
 * shape: neither type has source, so the only before-image fact worth recording is
 * existence — already established by `abapCreateViaBridge`'s pre-create read above.
 */
async function journalBridgeCreate<T>(
  journal: Journal | undefined,
  conn: AbapConnection,
  ref: { name: string; type: string; uri: string; packageName: string; description: string },
  beforeCapture: BeforeImageCapture,
  corrNr: string | undefined,
  mutate: () => Promise<T>,
): Promise<{ result: T; entryId: string | undefined }> {
  const { result, entryId, settle } = await withJournalledMutation<undefined, T>(
    journal,
    {
      begin: () => ({
        operation: "create",
        object: journalRef(ref),
        existedBefore: false,
        beforeCapture,
        systemKey: systemKey(conn.cfg),
        tool: "abap_write",
        ...(corrNr ? { corrNr } : {}),
      }),
    },
    async (onBeforeImage) => {
      await onBeforeImage(undefined);
      return await mutate();
    },
  );
  await settle({ outcome: "succeeded", activation: { attempted: false } });
  return { result, entryId };
}

/**
 * What THIS create's own read-back established about TADIR registration —
 * the fact both the delete gate and undo actually key on.
 * `"unregistered"` only fires for a VIT-bridge `confirmed` with no
 * `packageRef` (the live-observed orphan outcome); a repository-search
 * `confirmed` never carries a package either, but that is silence, not
 * evidence, so it stays `"unknown"`.
 */
type BridgeRegistration =
  | { readonly state: "registered"; readonly packageName: string }
  | { readonly state: "unregistered" }
  | { readonly state: "unknown" };

function bridgeCreateRegistration(outcome: VerifyOutcome): BridgeRegistration {
  if (outcome.status === "confirmed" && outcome.packageName !== undefined) {
    return { state: "registered", packageName: outcome.packageName };
  }
  if (outcome.status === "confirmed" && outcome.via === "vit-bridge") return { state: "unregistered" };
  return { state: "unknown" };
}

/** The create response's closing note on whether undo/delete can reverse this — three-way on {@link BridgeRegistration}, never the old blanket "it works" claim. */
function bridgeReversalNote(
  entryId: string | undefined,
  beforeCapture: BeforeImageCapture,
  registration: BridgeRegistration,
  label: string,
  type: string,
  objectName: string,
): string {
  if (entryId === undefined) {
    if (registration.state === "registered") {
      return (
        `abapsmith can reach a ${label} (${type}) via the classrun bridge (abap_write ` +
        `mode="delete") — this create's read-back found it registered in package ` +
        `${registration.packageName}; see the limits note above for whether that bridge's delete ` +
        "is proven for this type. This create was not journalled (no journal was open), so " +
        'abap_journal mode=undo will not reverse it — use an explicit mode="delete" call instead.'
      );
    }
    if (registration.state === "unregistered") {
      return (
        "This create's read-back found it present with no <adtcore:packageRef> — active but " +
        "unregistered in TADIR, so abap_write mode=\"delete\" would refuse it too " +
        "(SAFETY_DENIED / PACKAGE_UNKNOWN); removing it needs SE11/SE14 by hand. This create was " +
        "not journalled either (no journal was open)."
      );
    }
    return (
      `abapsmith can reach a ${label} (${type}) via the classrun bridge (abap_write ` +
      'mode="delete") if it is registered — but this create\'s read-back did not establish a ' +
      "package for it, and a bridge create can land active but unregistered in TADIR, in " +
      'which case delete refuses with SAFETY_DENIED / PACKAGE_UNKNOWN too. This create was not ' +
      "journalled (no journal was open), so abap_journal mode=undo will not reverse it regardless."
    );
  }
  if (beforeCapture !== "confirmed-absent") {
    return (
      `Journalled as ${entryId} for the audit trail, but the pre-create existence check could ` +
      `not positively confirm ${objectName} was absent beforehand (beforeCapture="${beforeCapture}") ` +
      "— abap_journal mode=undo will refuse to delete it on that entry alone. Use an explicit " +
      'mode="delete" call instead.'
    );
  }
  if (registration.state === "registered") {
    return (
      `Journalled as ${entryId}. This create's read-back found it registered in package ` +
      `${registration.packageName} — the packageRef abap_write mode="delete" and abap_journal ` +
      `mode=undo entry=${entryId} both gate on — so undo can reach it through the same classrun ` +
      'bridge abap_write mode="delete" uses; see the limits note above for whether that bridge\'s ' +
      "delete is itself proven for this type."
    );
  }
  if (registration.state === "unregistered") {
    return (
      `Journalled as ${entryId}, but the read-back found it present with no <adtcore:packageRef> ` +
      "— active and unregistered in TADIR. abap_write mode=\"delete\" refuses that with " +
      `SAFETY_DENIED / PACKAGE_UNKNOWN, and abap_journal mode=undo entry=${entryId} refuses it ` +
      "too, non-overridably — removing it needs SE11/SE14 by hand."
    );
  }
  return (
    `Journalled as ${entryId}. abap_journal mode=undo entry=${entryId} can reach it through the ` +
    'same classrun bridge abap_write mode="delete" uses if it is registered — but this create\'s ' +
    "read-back did not establish a package for it, and a bridge create can land active but " +
    "unregistered in TADIR, in which case both refuse with SAFETY_DENIED / PACKAGE_UNKNOWN."
  );
}

async function abapCreateViaBridge(
  conn: AbapConnection,
  target: WriteTarget,
  input: WriteInput,
  maxChars: number,
  gate: SafetyGate,
  journal?: Journal,
): Promise<BuiltResponse> {
  const type = (input.type ?? "").trim().toUpperCase();
  const cap = capabilitiesFor(type);
  const label = cap?.label ?? type;
  const bad = (message: string, hint?: string): never => {
    throw new AbapError("BAD_INPUT", message, { object: target.name, type }, hint);
  };

  if (input.source !== undefined || input.edit !== undefined || input.method !== undefined) {
    bad(
      `A ${label} (${type}) has no source: it is created from its definition, not from ABAP text. ` +
        "Omit `source`, `edit` and `method`.",
    );
  }
  if (input.format) bad(`A ${label} (${type}) has no source; \`format\` does not apply.`);
  // This branch never reaches `resolveWriteTarget`, so the "only CLAS/OC
  // has includes" refusal there can't cover it — an `include` would be silently ignored.
  if (input.include !== undefined) {
    bad(`\`include\` is a CLAS/OC field; a ${label} (${type}) has no class includes.`);
  }
  if (input.expect_etag !== undefined) {
    bad(`\`expect_etag\` does not apply to a ${label} create — there is no prior version to compare.`);
  }
  if (input.software_component !== undefined || input.package_type !== undefined || input.transport_layer !== undefined) {
    bad("`software_component`, `package_type` and `transport_layer` are DEVC/K fields only.");
  }
  const packageName = target.packageName?.trim() || "$TMP";
  // Zero-network package/corr_nr check for a VIEW/DV create, done here so a bad
  // combination costs no request: a transportable package needs corr_nr, a $-package
  // (including this $TMP default) must not have one. view-create.ts's own `validate`
  // repeats this as defence in depth, not the only enforcement point.
  if (type === "VIEW/DV") assertClassicViewCreateTarget(packageName, normalizeCorrNr(input.corr_nr));
  // Same pairing for TRAN/T: RPY_TRANSACTION_INSERT's own RS_CORR_INSERT needs the request.
  if (type === "TRAN/T") assertTransactionCreateTarget(packageName, normalizeCorrNr(input.corr_nr));
  const description = input.description?.trim();
  if (!description) {
    bad(
      `\`description\` is required to create a ${label} (${type}) — it is the object's short text ` +
        `(${type === "TRAN/T" ? "TSTCT-TTEXT" : "DD25V-DDTEXT"}), and the API has no default for it.`,
    );
  }

  const common = { description: description as string, packageName };
  let created: { run: RunResult; transcript: DdicTranscript };
  let bridgeClass: string;
  let detail: string;
  let verified: boolean;
  let verifyNote: string;
  let entryId: string | undefined;
  let registration: BridgeRegistration;

  const vitType = type === "VIEW/DV" ? "viewdv" : "trant";
  const objectUri = vitBridgeUri(vitType, target.name);

  // Positive absence evidence, read BEFORE the create — the one value
  // (beforeCapture: "confirmed-absent") that `deleteEvidenceBlocker` (src/adt/undo.ts)
  // accepts as authorising a later delete-shaped undo. Skipped entirely when the journal
  // is off: nothing downstream would use it, so there is no reason to pay for the read.
  let beforeCapture: BeforeImageCapture = "failed";
  if (journal) {
    const preCheck = await verifyViaVitBridge(conn, vitType, target.name, type);
    if (preCheck.status === "confirmed") {
      throw new AbapError(
        "CHECK_FAILED",
        `${label} ${target.name} already exists (confirmed at ${preCheck.uri}, via ${preCheck.via}). ` +
          `abap_write mode="write" creates a NEW ${label}; it does not overwrite one that is already ` +
          "there, and neither DDIC bridge FM has a modelled overwrite behaviour to fall back on.",
        { object: target.name, type, uri: preCheck.uri },
        `Delete the existing ${label} first (abap_write mode="delete"), or pick a different name.`,
      );
    }
    if (preCheck.status === "confirmed-absent") beforeCapture = "confirmed-absent";
  }

  if (type === "VIEW/DV") {
    if (input.program !== undefined) bad("`program` is a TRAN/T field; a view does not start a program.");
    if (input.activate === false) {
      bad(
        "A classic view cannot be created without activating it: DDIF_VIEW_ACTIVATE runs inside " +
          "the same bridge execution as DDIF_VIEW_PUT. Omit `activate`.",
      );
    }
    if (!input.base_table?.trim()) {
      bad(
        "`base_table` is required to create a classic view (VIEW/DV): the single table the view " +
          "projects, e.g. ZTM_CARRIER.",
      );
    }
    if (!input.view_fields || input.view_fields.length === 0) {
      bad(
        "`view_fields` is required to create a classic view (VIEW/DV): the base-table fields to " +
          "project, in order, e.g. [\"CARRIER_ID\", \"NAME\"]. There is no 'all fields' default — " +
          "the DDIC API takes an explicit field list.",
      );
    }
    // `bad()` always throws, but TS's never-return narrowing doesn't follow a call
    // through a local `const` arrow function (same cast a few lines down for TRAN/T's `program`).
    const baseTable = input.base_table as string;
    const viewFields = input.view_fields as string[];

    // See this function's doc comment for the live-observed defect and fix. Whether the
    // COMMIT WORK fix closes the gap is NOT assumed here — the read-back below decides,
    // live, on every call.
    bridgeClass = DDIC_BRIDGE_CLASS.createView;
    const corrNr = normalizeCorrNr(input.corr_nr);
    ({ result: created, entryId } = await journalBridgeCreate(
      journal,
      conn,
      { name: target.name, type, uri: objectUri, packageName, description: description as string },
      beforeCapture,
      corrNr,
      () =>
        createClassicView(conn, gate, {
          ...common,
          viewName: target.name,
          baseTable,
          fields: viewFields,
          corrNr,
        }),
    ));
    detail = `database view (DD25V class 'D') projecting ${viewFields.length} field(s) of ${baseTable}`;

    // Same invariant as TRAN/T below: a transcript proves the FMs ran, never that the
    // result stuck (src/adt/write-verify.ts).
    const outcome = await verifyObjectCreated(conn, {
      vitType: "viewdv",
      objectName: target.name,
      expectType: type,
    });
    if (outcome.status === "confirmed-absent") {
      throw new AbapError(
        "CHECK_FAILED",
        `${bridgeClass} reported success (the transcript carries ${created.transcript.tags.join(", ")}) ` +
          `but a follow-up read at ${outcome.uri} (via ${outcome.via}) did not find ${target.name} — not ` +
          "proof the object is absent (an identical CHECK_FAILED here was later found to have a " +
          "present, merely unregistered, object). This is the exact false-success shape abapsmith was " +
          "reproduced against live on this system: DDIF_VIEW_PUT / DDIF_VIEW_ACTIVATE report sy-subrc 0 " +
          "while a follow-up read still does not find the view, and adding an explicit COMMIT WORK " +
          "to the generated bridge did not close it here. abapsmith will not report a create as " +
          "successful when the follow-up read cannot find the object." +
          (entryId !== undefined
            ? ` This was already journalled as ${entryId}; whether undo has anything to act on is ` +
              "unresolved — the object may still exist, unregistered, and need SE11/SE14 to " +
              "clear by hand."
            : ""),
        { object: target.name, type, markers: created.transcript.tags.join(" ") },
        "Use type=\"DDLS/DF\" (CDS view) instead — a fully supported, verified create/write path and " +
          "the modern equivalent. A true SE11/SE54 maintenance view has to be authored by hand.",
      );
    }
    registration = bridgeCreateRegistration(outcome);
    if (outcome.status === "confirmed") {
      verified = true;
      verifyNote =
        `Read back and confirmed present at ${outcome.uri} (via ${outcome.via}) after create. This is ` +
        "a DATABASE view (DD25V class 'D'), not a maintenance view (class 'M') — SE54/SM30 will not " +
        "offer it; see the limits note below.";
    } else {
      verified = false;
      verifyNote =
        `NOT independently confirmed present: ${outcome.reason} abapsmith still reports created:true ` +
        "here, trusting the classrun transcript (the markers above) — but that is not the same " +
        "confidence as a live read-back, and VIEW/DV is exactly the type this codebase was once wrong " +
        "about in this way. Treat verified:false here as a reason to confirm by hand in SE11 before " +
        "relying on it. See src/adt/write-verify.ts.";
    }
  } else {
    if (input.base_table !== undefined || input.view_fields !== undefined) {
      bad("`base_table` and `view_fields` are VIEW/DV fields; a transaction has no base table.");
    }
    if (input.activate === true) bad("A transaction has no activation step; omit `activate`.");
    if (!input.program || !input.program.trim()) {
      bad(
        "`program` is required to create a transaction (TRAN/T): the EXISTING report program the " +
          "transaction starts, e.g. ZTM_CARRIER_LIST. abapsmith checks it exists before creating the " +
          "transaction.",
      );
    }
    // `bad()` always throws; TS's narrowing doesn't follow it through a `const` function
    // value — cast matches the `description as string` convention a few lines up.
    const program = (input.program as string).trim().toUpperCase();

    // Closed defect: a transaction bound to an unchecked program used to be created
    // unconditionally (the FM doesn't validate it either), so a typo landed as a
    // working-looking `created: true` pointing at nothing. One real GET, reusing the
    // same resolver every other write path uses — the ONE network call this function
    // makes before generating or deploying a bridge class.
    const programTarget = await resolveWriteTarget(conn, { type: "PROG/P", name: program });
    if (!programTarget.exists) {
      throw new AbapError(
        "NOT_FOUND",
        `Program ${program} does not exist on ${conn.cfg.sid}, so a transaction cannot be created ` +
          "to start it. abapsmith checks this before creating a TRAN/T, rather than creating one " +
          "that points nowhere and reporting success.",
        { object: target.name, type, program },
        `Create the program first with abap_write (type="PROG/P"), or correct `+
          "\`program\` if this was a typo.",
      );
    }

    bridgeClass = DDIC_BRIDGE_CLASS.createTransaction;
    const corrNr = normalizeCorrNr(input.corr_nr);
    ({ result: created, entryId } = await journalBridgeCreate(
      journal,
      conn,
      { name: target.name, type, uri: objectUri, packageName, description: description as string },
      beforeCapture,
      corrNr,
      () => createTransaction(conn, gate, { ...common, tcode: target.name, program, corrNr }),
    ));
    detail = `report transaction starting ${program} (dynpro 1000)`;

    // Same fix as VIEW/DV above: the transcript proves RPY_TRANSACTION_INSERT ran, not
    // that the row is still there. Read it back before saying `created: true`
    // unconditionally.
    const outcome = await verifyObjectCreated(conn, {
      vitType: "trant",
      objectName: target.name,
      expectType: type,
    });
    if (outcome.status === "confirmed-absent") {
      throw new AbapError(
        "CHECK_FAILED",
        `${bridgeClass} reported success (the transcript carries ${created.transcript.tags.join(", ")}) ` +
          `but a follow-up read at ${outcome.uri} (via ${outcome.via}) did not find ${target.name} — not ` +
          "proof the object is absent (the same gap was measured for VIEW/DV, over the same " +
          "verification path). abapsmith will not report a create as successful when the follow-up read " +
          "cannot find the object." +
          (entryId !== undefined
            ? ` This was already journalled as ${entryId}; whether undo has anything to act on is ` +
              "unresolved — the object may still exist."
            : ""),
        { object: target.name, type, markers: created.transcript.tags.join(" ") },
        "This is the exact failure mode VIEW/DV's read-back above guards against; if this recurs " +
          "for TRAN/T, treat it as a live regression in the bridge, not a fluke.",
      );
    }
    registration = bridgeCreateRegistration(outcome);
    if (outcome.status === "confirmed") {
      verified = true;
      verifyNote = `Read back and confirmed present at ${outcome.uri} (via ${outcome.via}) after create.`;
    } else {
      verified = false;
      verifyNote =
        `NOT independently confirmed present: ${outcome.reason} abapsmith still reports created:true ` +
        "here, trusting the classrun transcript (the markers above) — but that is not the same " +
        "confidence as a live read-back. See src/adt/write-verify.ts.";
    }
  }

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      object: `${type} ${target.name}`,
      package: packageName,
      mode: "create-bridge",
      created: true,
      verified,
      detail,
      bridge_class: bridgeClass,
      markers: created.transcript.tags.join(" "),
      journal: entryId !== undefined ? entryId : "off (not journalled — see notes)",
    },
    notes: [
      `Created by running a generated ${bridgeClass} classrun bridge, not over ADT REST: ` +
        `${cap?.bridgeCreate?.via ?? "see src/adt/ddic-bridge.ts"}`,
      cap?.bridgeCreate?.limits ?? "",
      verifyNote,
      bridgeReversalNote(entryId, beforeCapture, registration, label, type, target.name),
    ].filter((n) => n !== ""),
    maxChars,
  });
}

/**
 * `VIEW/DV` / `TRAN/T` delete. Sibling of {@link abapCreateViaBridge} above;
 * {@link abapBridgeCrud} dispatches between the two.
 *
 * Every create-only field is refused zero-network before any bridge class is generated —
 * there is nothing for `base_table`/`view_fields`/`program`/`description`/`activate`/
 * `source`/`edit`/`method`/`include`/`corr_nr`/`expect_etag`/`software_component`/
 * `package_type`/`transport_layer`/`format` to mean on a delete.
 *
 * `package` is NOT trusted from the caller for the gate: neither delete bridge can look its
 * object's own package up itself (both gate zero-network and say so in their own doc
 * comments — `src/adt/view-delete.ts`, `src/adt/tran-delete.ts`), so judging the allowlist
 * against a caller-named value would let a caller name a permissive package and slip a
 * delete past a gate that should have refused it. This function reads the object through
 * the VIT bridge first and gates on THAT package — a caller-supplied `package` is optional
 * and only ever checked for agreement, never substituted for or trusted over the server's
 * answer. That read is a deliberate, necessary exception to this function's otherwise
 * zero-network refusals: there is no way to know an existing object's real package without
 * asking the server.
 *
 * Verified against a real read-back (`verifyObjectDeleted`) before the delete is reported
 * as done: a transcript claiming `*-GONE` is not proof, the same discipline the create
 * path already applies — except inverted, since here `confirmed` (the object is STILL
 * there) is the failure.
 */
async function abapDeleteViaBridge(
  conn: AbapConnection,
  target: WriteTarget,
  input: WriteInput,
  maxChars: number,
  gate: SafetyGate,
): Promise<BuiltResponse> {
  const type = (input.type ?? "").trim().toUpperCase();
  const cap = capabilitiesFor(type);
  const label = cap?.label ?? type;
  const bad = (message: string, hint?: string): never => {
    throw new AbapError("BAD_INPUT", message, { object: target.name, type }, hint);
  };

  if (
    input.source !== undefined ||
    input.edit !== undefined ||
    input.method !== undefined ||
    input.include !== undefined
  ) {
    bad(
      `A ${label} (${type}) delete has no source to touch: omit \`source\`, \`edit\`, \`method\` ` +
        "and `include`.",
    );
  }
  if (input.format) bad(`A ${label} (${type}) has no source; \`format\` does not apply to a delete.`);
  if (input.expect_etag !== undefined) {
    bad(`\`expect_etag\` does not apply to a ${label} delete — the classrun bridge has no etag to compare.`);
  }
  if (input.description !== undefined) {
    bad("`description` is a create-only field; a delete does not rename anything.");
  }
  if (input.activate !== undefined) bad("`activate` is a create-only field; a delete has nothing to activate.");
  if (input.base_table !== undefined || input.view_fields !== undefined) {
    bad("`base_table` and `view_fields` are VIEW/DV create fields; a delete needs neither.");
  }
  if (input.program !== undefined) bad("`program` is a TRAN/T create field; a delete needs no program.");
  if (
    input.software_component !== undefined ||
    input.package_type !== undefined ||
    input.transport_layer !== undefined
  ) {
    bad("`software_component`, `package_type` and `transport_layer` are DEVC/K create fields only.");
  }
  if (normalizeCorrNr(input.corr_nr) !== undefined) {
    bad(
      `\`corr_nr\` cannot be honoured for a ${label} delete: neither delete bridge takes a transport ` +
        "parameter (src/adt/view-delete.ts, src/adt/tran-delete.ts). None is needed either — the " +
        "delete registers nothing in CTS, so it is judged as a local mutation and no transport " +
        "allowlist blocks it.",
      "Retry without `corr_nr`. Any entry the object already had on a transport request survives " +
        'this delete; use `abap_transport` operation: "removeObject" (transport, object, confirm) ' +
        "for that, which needs ABAP_MODE=admin.",
    );
  }

  // Neither delete bridge can look its object's own package up itself (both gate
  // zero-network, before any ABAP is generated — see their own doc comments), and the
  // caller's `package` cannot be trusted as-is either: `assertBridgeMutation`'s package
  // allowlist is the safety gate's central rule, and judging it against a value nobody
  // server-side vouched for would let a caller name a permissive package and slip a
  // delete through the gate that should have refused it. So this READS the object first —
  // the one place in this function where the gate stops being zero-network — through the
  // same VIT bridge the post-delete verification below reuses, and gates on ITS answer,
  // never the caller's.
  const vitType = type === "VIEW/DV" ? "viewdv" : "trant";
  const found = await verifyViaVitBridge(conn, vitType, target.name, type);
  if (found.status === "confirmed-absent") {
    throw new AbapError(
      "NOT_FOUND",
      `${label} ${target.name} does not exist, so there is nothing to delete.`,
      { object: target.name, type, uri: found.uri },
    );
  }
  if (found.status === "indeterminate") {
    throw new AbapError(
      "SAFETY_DENIED",
      `abapsmith could not confirm ${label} ${target.name}'s existence or its package before a ` +
        `delete, so it refuses the operation (${found.reason})`,
      { reason: "PACKAGE_UNKNOWN", object: target.name, type, uri: found.uri, cause: found.reason },
      "Every delete is judged against the object's real package. Rather than guess, abapsmith " +
        "stops here. Check the object exists and this connection can read it, then retry.",
      { retryable: true }, // existence could not be confirmed, not denied — a healthy connection resolves it
    );
  }
  // `serverPackage` (src/adt/resolved-package.ts) is the only constructor for this branded
  // type — it can only be minted from a `confirmed` `VerifyOutcome`, so nothing downstream
  // of this point can be handed a caller-supplied or guessed package under this name.
  const resolved = serverPackage(found);
  if (resolved === undefined) {
    // `packageUnknown` in src/adt/write.ts is the model for this refusal — same reasoning,
    // reimplemented here rather than imported: that function takes a `ResolvedTarget`
    // (`spec`/`uri`), which VIEW/DV and TRAN/T never have.
    throw new AbapError(
      "SAFETY_DENIED",
      `abapsmith could not determine which package ${label} ${target.name} belongs to, so it ` +
        "refuses the delete: the VIT bridge read answered but carried no <adtcore:packageRef> element.",
      { reason: "PACKAGE_UNKNOWN", object: target.name, type, uri: found.uri },
      "Every delete is judged against the object's real package. Rather than assume the " +
        "caller's `package` argument or $TMP — either could let an allowlist approve an " +
        "object that is really in a different package — abapsmith stops here. This matches " +
        "the known orphan outcome: the object is active but unregistered in " +
        "TADIR, so no package can be established for it. Retrying with a different `package` " +
        "argument will not help — the gate is deliberately not guessing. Removing it needs " +
        "SE11/SE14 by hand.",
    );
  }
  const requestedPackage = target.packageName?.trim().toUpperCase();
  if (requestedPackage && requestedPackage !== resolved.name) {
    throw new AbapError(
      "BAD_INPUT",
      `${label} ${target.name} is in package ${resolved.name}, but the request asked for ` +
        `${requestedPackage}. abapsmith does not move objects between packages, and will not ` +
        "delete against the wrong one.",
      { object: target.name, type, serverPackage: resolved.name, requestedPackage },
      "Drop the `package` argument to delete the object where it actually is, or correct it if " +
        "this named the wrong object.",
    );
  }
  const packageName = resolved.name;

  let deleted: { run: RunResult; transcript: DdicTranscript };
  let bridgeClass: string;

  if (type === "VIEW/DV") {
    bridgeClass = DDIC_BRIDGE_CLASS.deleteView;
    // `resolved`, not `packageName`: both bridges now require the branded `ServerPackage`
    // (src/adt/resolved-package.ts) so the compiler, not just this function, refuses a
    // caller-supplied or re-derived string at this boundary.
    deleted = await deleteClassicViewViaBridge(conn, gate, { viewName: target.name, packageName: resolved });
  } else {
    bridgeClass = DDIC_BRIDGE_CLASS.deleteTransaction;
    deleted = await deleteTransactionViaBridge(conn, gate, { tcode: target.name, packageName: resolved });
  }

  const outcome = await verifyObjectDeleted(conn, {
    uri: vitBridgeUri(vitType, target.name),
    accept: VIT_STUB_ACCEPT,
    objectName: target.name,
    expectType: type,
  });

  let verified: boolean;
  let verifyNote: string;
  if (outcome.status === "confirmed") {
    // Inverted from the create path: here `confirmed` means the object is STILL there,
    // which is the failure — a transcript claiming *-GONE is not proof (see this
    // function's doc comment), and the read-back and search agree it persists.
    throw new AbapError(
      "CHECK_FAILED",
      `${bridgeClass} reported success (the transcript carries ${deleted.transcript.tags.join(", ")}) ` +
        `but ${target.name} is STILL confirmed present at ${outcome.uri} (via ${outcome.via}) after ` +
        "delete. abapsmith will not report a delete as successful when it can prove the object is " +
        "still there.",
      { object: target.name, type, markers: deleted.transcript.tags.join(" ") },
    );
  } else if (outcome.status === "confirmed-absent") {
    verified = true;
    verifyNote = `Read back and confirmed absent at ${outcome.uri} (via ${outcome.via}) after delete.`;
  } else {
    verified = false;
    verifyNote =
      `NOT independently confirmed absent: ${outcome.reason} abapsmith still reports the delete here, ` +
      "trusting the classrun transcript (the markers above) — but that is not the same confidence " +
      "as a live read-back. See src/adt/write-verify.ts.";
  }

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      object: `${type} ${target.name}`,
      package: packageName,
      mode: "delete-bridge",
      deleted: true,
      verified,
      bridge_class: bridgeClass,
      markers: deleted.transcript.tags.join(" "),
      journal: "off (not journalled — see notes)",
    },
    notes: [
      `Deleted by running a generated ${bridgeClass} classrun bridge, not over ADT REST — ${type} ` +
        "has no writable ADT collection at all (see this type's REGISTRY entry in src/adt/capabilities.ts).",
      verifyNote,
      "NOT journalled: a bridge delete captures no before-image, so abap_journal mode=undo cannot " +
        "restore this object. To bring it back, create it again with a fresh abap_write call.",
      isLocalPackageName(packageName) ? "" : bridgeDeleteTransportEntryNote(label, target.name, packageName),
    ].filter((n) => n !== ""),
    maxChars,
  });
}

export interface WriteToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars" | "verifyWrites">;
  readonly journal: Journal;
  readonly transport: SessionTransport;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/**
 * Registers `abap_write` on `mcp`. Create, change or delete (mode=delete) an ABAP object
 * in one call: resolve + gate, create-if-missing, lock → PUT → unlock, checkrun, activation.
 */
export function registerWriteTools(mcp: McpServer, deps: WriteToolDeps): void {
  mcp.registerTool(
    "abap_write",
    {
      description:
        "Create, change or delete an ABAP object: save/check/activate; locking handled. " +
        "TRAN/T deletable+undoable, and needs corr_nr for a transportable package, none for a $ one. " +
        "VIEW/DV create needs corr_nr for a transportable package, none for a $ one; the view can't " +
        "be read back via abap_read. DEVC/K delete only if empty. " +
        "dry_run previews the diff and expect_etag without writing anything.",
      inputSchema: writeInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      try {
        const a = args as {
          object?: string;
          type?: string;
          package?: string;
          mode?: string;
          affects?: EnhancedObjectRef;
          objects?: Array<{ object: string; type?: string; affects?: EnhancedObjectRef }>;
        };

        // Same shape as `registerActivateTools`'s `objects` branch (src/tools/activate.ts);
        // only diverging steps are commented here.
        if (a.objects !== undefined) {
          // Must fail BEFORE ensureConnected(): abapWrite's own check only runs once a
          // connection is already held.
          if ((a.mode ?? "write") !== "delete") {
            throw new AbapError(
              "BAD_INPUT",
              "`objects` (batch delete) requires `mode: \"delete\"` — there is no batch write or " +
                "create.",
              { mode: a.mode ?? "write" },
              "Add `mode: \"delete\"`, or drop `objects` and use `object` + `source` to write one " +
                "object instead.",
            );
          }
          // Zero-network preflight, once per object, so a refusal on ANY member costs zero
          // requests and happens before ensureConnected(). Every entry asserts "delete"
          // specifically — a member fine to WRITE but refused to DELETE must be caught here.
          for (const entry of a.objects) {
            const pf = preflight(entry);
            deps.safety.assert("delete", pf, {
              phase: "preflight",
              corr: { kind: "unresolved" },
              intent: enhancementPreflightIntent({
                name: pf.name,
                type: pf.type,
                affects: entry.affects,
              }),
            });
          }
          await deps.ensureConnected();
          const run = (conn: AbapConnection) =>
            abapWrite(
              conn,
              args as WriteInput,
              deps.cfg.maxResponseChars,
              deps.safety,
              deps.journal,
              deps.transport,
              deps.cfg.verifyWrites,
            );
          // `undefined` gate key: "take a slot, take no gate" (writeGateKey's doc comment)
          // — no single string names a set of objects the way one key names one object. A
          // batch write still serialises through the write SLOT, just not additionally
          // against a concurrent single-object write to one of its own members.
          const res = await deps.pool.withWrite("abap_write", undefined, run);
          return ok(res.text);
        }

        if (a.object === undefined) {
          throw new AbapError(
            "BAD_INPUT",
            "Pass either `object` (single object) or `objects` (batch delete — 2 or more objects " +
              'in one call, mode: "delete" only).',
            {},
            "Add `object: \"<name>\"` to write or delete one object, or `objects: [...]` with " +
              'mode: "delete" to delete several.',
          );
        }
        const object = a.object;

        // BEFORE ensureConnected(): a denied write must never reach the wire.
        const pf = preflight({ object, type: a.type, package: a.package });
        deps.safety.assert(a.mode === "delete" ? "delete" : "write", pf, {
          phase: "preflight",
          corr: { kind: "unresolved" },
          intent: enhancementPreflightIntent({ name: pf.name, type: pf.type, affects: a.affects }),
        });
        await deps.ensureConnected();
        // LOCK → PUT → UNLOCK, gated on the object so two writes to the same one can never
        // interleave. Gate taken OUTSIDE the slot by withWrite — inside would deadlock at
        // maxSessions = 1.
        // `args as WriteInput`, NOT `args as never`: the `never` cast silenced the check that
        // would flag the core reading a field the registered schema doesn't declare — casting
        // to the schema-derived type means any new field the core reads must be added to
        // `writeInputSchema` to compile.
        const res = await deps.pool.withWrite("abap_write", writeGateKey(object, a.type), (conn) =>
          abapWrite(
            conn,
            args as WriteInput,
            deps.cfg.maxResponseChars,
            deps.safety,
            deps.journal,
            deps.transport,
            deps.cfg.verifyWrites,
          ),
        );
        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
