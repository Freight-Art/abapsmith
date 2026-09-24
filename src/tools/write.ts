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
  SOURCE_LINE_MAX,
  withSourceContext,
} from "../adt/activate.js";
import type {
  ActivationOutcome,
  CheckOutcome,
  FormatOutcome,
  InactiveObjectRef,
} from "../adt/activate.js";
import type { AbapConnection } from "../adt/connection.js";
import { renderCoActivated } from "./activate.js";
import { enrichLockedError, type LockHolderLookup } from "../adt/locked-holders.js";
// Imported directly from capabilities.ts, not via this file's re-export:
// this module is `vi.mock`ed wholesale by test/tools.test.ts, so routing a
// pure lookup through that seam breaks mocked tests for no benefit.
import {
  capabilitiesFor,
  isBridgeCreatableType,
  isBridgeOnlyCreateType,
  NON_WRITABLE_TYPES,
} from "../adt/capabilities.js";
import { CLASSIC_BODY_CLASS } from "../adt/fluid/builtin/classic.js";
import { type DdicTranscript } from "../adt/ddic-bridge.js";
import { discardedDescriptorValues, type DiscardedValue } from "../adt/descriptor-fidelity.js";
import {
  assertSecondaryIndexTarget,
  callerVisibleIndexTags,
  createSecondaryIndex,
  deleteSecondaryIndexViaBridge,
  indexGateName,
  resolveIndexObjectInput,
  resolveIndexOwner,
} from "../adt/index-create.js";
import { readTableIndexes, type SecondaryIndexInfo } from "../adt/index-read.js";
import { createPackageViaBridge, tdevcDiscrepancies } from "../adt/package-create.js";
import type { RunResult } from "../adt/run.js";
import { serverPackage, type ServerPackage } from "../adt/resolved-package.js";
import { isLocalPackageName } from "../adt/transports.js";
import {
  assertTransactionCreateTarget,
  assertTransactionKindParams,
  createTransaction,
  type TransactionParams,
} from "../adt/tran-create.js";
import { deleteTransactionViaBridge, verifyTransactionDeleted } from "../adt/tran-delete.js";
import { assertTransactionUpdateTarget, updateTransaction } from "../adt/tran-update.js";
import { lookupTransaction } from "../adt/ui-tstc.js";
import { assertClassicViewCreateTarget, classicViewUri, createClassicView } from "../adt/view-create.js";
import { deleteClassicViewViaBridge } from "../adt/view-delete.js";
import { updateClassicView } from "../adt/view-update.js";
import { assertSearchHelpTarget, createSearchHelp, updateSearchHelp, type SearchHelpParams } from "../adt/shlp-create.js";
import { deleteSearchHelpViaBridge } from "../adt/shlp-delete.js";
import { readClassicView, readSearchHelp, readTransaction } from "../adt/catalog-read.js";
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
import { entryLabel, readBackTransportEntry, type TrReadback } from "../adt/transport-readback.js";
import {
  countMethodKeywordLines,
  methodNamesMatch,
  readMethod,
  scanMethodBlocks,
} from "../adt/source.js";
import type { MethodBlock, SourceRange } from "../adt/source.js";
import { CLASS_INCLUDES, specForKeyword, specForType } from "../adt/types.js";
import type { DdicRender } from "../adt/ddic.js";
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
  NO_JOURNAL,
  PACKAGE_SOFTWARE_COMPONENT_HINT,
  preflightPackageCorr,
  readCurrentSource,
  refuseUnwritableType,
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
import { assertProgramOnlyOption } from "../adt/program-create.js";
import { assertTextPoolShape, assertTextPoolType, textPoolWriteSummary, type TextPoolWriteResult } from "../adt/text-pool.js";
import { TEXT_POOL_JOURNAL_NOTE, toTextPoolInput, writeTextPoolJournalled } from "./write-text-pool.js";
import { buildResponse, stripPartialEtag, type BuiltResponse } from "../compact.js";
import type { Config, VerifyWritesMode } from "../config.js";
import type { BeforeImageCapture, Journal } from "../journal.js";
import { journalRef, systemKey, withJournalledMutation } from "../journal.js";
import {
  normalizeCorrNr,
  type AuthorizedTarget,
  type MutatingOperation,
  type SafetyCorr,
  type SafetyGate,
} from "../safety.js";
import { applyEdit, describeEditFailure, EditInputError } from "./edit.js";
import { buildDeleteDryRunResponse, buildWriteDryRunResponse, dryRunNotSupported } from "./write-dry-run.js";
import { enhancementPreflightIntent, preflight, writeGateKey } from "./preflight.js";
import {
  resolveDdicStructuredSource,
  targetFromInput,
  writeInputSchema,
  WriteInput,
} from "./write-schema.js";
import type { WriteInputV2 } from "./write-schema.js";
import {
  bridgeDeleteTransportEntryNote,
  captureOf,
  corrNrNotHonouredNote,
  corrNrOverriddenWriteNote,
  deleteJournalNote,
  deleteNotConfirmedSentence,
  describeDiscard,
  describeShrink,
  describeVerification,
  includeCaptureOf,
  languageDependentDiscardHint,
  ok,
  packageDeleteTransportNote,
  releaseClause,
  tableDeleteIndexNote,
  transportHeaderText,
  transportNote,
} from "./write-notes.js";
import {
  assertNotOrphanMethodBlock,
  assertNotToolResponseEcho,
  isUnexpectedStatementRejection,
  resolveWriteSource,
  rethrowWithDdicSkeletonHint,
  rethrowWithSourceShapeHint,
  sourceShapeGuidance,
  spliceMethodBlock,
} from "./write-source.js";
import {
  bridgePreflightCorr,
  bridgeCreateRegistration,
  bridgeReversalNote,
  bridgeTransportHeaderInfo,
  bridgeTransportNotes,
  catalogProbe,
  journalBridgeCreate,
  probeSearchHelp,
  probeSearchHelpAnyState,
  resolveBridgeCreateCorr,
  resolveBridgeUpdateTarget,
  resolveShlpPackage,
} from "./write-bridge-common.js";
import type { BridgeRegistration } from "./write-bridge-common.js";

/**
 * `enhancementPreflightIntent` lives in src/tools/preflight.ts next to
 * `preflight()` — the two must always be called in pairs when a registrar's
 * `type` can be an enhancement type. Re-exported for existing imports.
 */
export { enhancementPreflightIntent };

export { writeInputSchema, WriteInput, targetFromInput } from "./write-schema.js";
export type { WriteEdit, WriteInputV2 } from "./write-schema.js";

export {
  assertNotOrphanMethodBlock,
  assertNotToolResponseEcho,
  isUnexpectedStatementRejection,
  resolveWriteSource,
  rethrowWithDdicSkeletonHint,
  rethrowWithSourceShapeHint,
  sourceShapeGuidance,
  spliceMethodBlock,
} from "./write-source.js";

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
  /** Journal attribution: who actually made the write. abap_quick_fix routes
   * through this same core, so its journal entries should say so, not
   * "abap_write". */
  toolLabel: string = "abap_write",
): Promise<BuiltResponse> {
  // Set by the `ddic` branch below when `description` was empty/absent and defaulted to
  // the object's own name (issue #209); surfaced in the create/write response notes.
  let ddicDescriptionDefaultNote: string | undefined;
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
        "index_fields",
        "index_unique",
        "program",
        "affects",
        "ddic",
        "fixed_point_arithmetic",
        "text_pool",
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

  let objectRef = input.object;
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

  // TABL/DI has no ADT resource of its own (see src/adt/index-create.ts's
  // header), so `targetFromInput` below (via the shared `parseObjectRef`)
  // never learns to split its parented "<TABLE>/<INDEX>" form — the same
  // form `abap_read` already accepts. Resolve that here, before
  // `targetFromInput` ever sees `objectRef`, so both that form and the
  // existing bare-name + `base_table` form reach it as a plain index name.
  if ((input.type ?? "").trim().toUpperCase() === "TABL/DI") {
    const resolved = resolveIndexObjectInput(objectRef, input.base_table);
    objectRef = resolved.object;
    input = { ...input, base_table: resolved.baseTable };
  }

  // Raise-only: a per-call verify:true escalates one write; verify:false is
  // accepted but cannot lower a server configured "verified". Unrelated to
  // FAILURE-path verification (reportCreateOrphan, src/adt/write.ts), which
  // stays unconditional in both modes.
  const verifyMode: VerifyWritesMode =
    verifyWrites === "verified" || input.verify === true ? "verified" : "speculative";

  const target = targetFromInput({ ...input, object: objectRef });

  // Zero-network: refuse an unknown/unwritable explicit type before anything
  // else, including the `source`-required guard below, so a caller who typo'd
  // the type learns THAT before being told source is missing. Packages and
  // bridge-only-create types keep their own routing further down, so they are
  // skipped here — every other explicit type is validated first.
  const earlyTypeSpec = input.type ? (specForType(input.type) ?? specForKeyword(input.type)) : undefined;
  if (input.type !== undefined && !isPackageType(earlyTypeSpec?.type) && !isBridgeOnlyCreateType(input.type)) {
    refuseUnwritableType(input.type, target.name, (input.mode ?? "write") === "delete" ? "delete" : "write");
  }

  // Zero-network: remote_enabled applies to FUGR/FF only, and not to a delete.
  if (input.remote_enabled !== undefined) {
    if (target.type !== "FUGR/FF") {
      throw new AbapError(
        "BAD_INPUT",
        target.type
          ? `remote_enabled applies to function modules (FUGR/FF) only; ${input.object} was given as ${target.type}.`
          : "remote_enabled applies to function modules (FUGR/FF) only; pass type \"FUGR/FF\" explicitly.",
        { type: target.type, object: input.object },
        'Drop `remote_enabled`, or pass type "FUGR/FF" and name the module as "<GROUP>/<MODULE>".',
      );
    }
    if ((input.mode ?? "write") === "delete") {
      throw new AbapError(
        "BAD_INPUT",
        "remote_enabled applies to function modules (FUGR/FF) only, and not to mode=delete.",
        { type: target.type, object: input.object },
        "Drop `remote_enabled` for a delete.",
      );
    }
  }

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
    const resolved = resolveDdicStructuredSource(input, target);
    input = { ...input, source: resolved.source };
    if (resolved.descriptionDefaultedTo !== undefined) {
      ddicDescriptionDefaultNote = `description defaulted to "${resolved.descriptionDefaultedTo}" (none was given).`;
    }
  }

  // Hoisted ABOVE the delete branch, unlike DEVC/K's routing below, and for
  // EVERY mode, not just create: `resolveWriteTarget` refuses these
  // types outright, so `mode=delete` would otherwise reach it and get a
  // generic "cannot be written" refusal instead of the specific reason, or
  // (worse) leave `resolveWriteTarget`'s own delete gate as a second route
  // that must be kept in sync with this one. `abapBridgeCrud` owns all
  // three types and both modes.
  //
  // `isBridgeOnlyCreateType`, not `isBridgeCreatableType`: DEVC/K now also
  // declares `bridgeCreate`, but it already has its own routing
  // below (`isPackageType`) that handles both its REST and bridge routes.
  if (isBridgeOnlyCreateType(input.type)) {
    if (input.dry_run) throw dryRunNotSupported("bridge", input.type);
    return await abapBridgeCrud(conn, target, input, maxChars, gate, journal, transport);
  }

  // Zero-network refusal for `mode="update"` on any type that isn't one of the three
  // bridge update routes (VIEW/DV, TRAN/T, SHLP/DH — see `isBridgeUpdateType` /
  // `BRIDGE_UPDATE_TYPES` near `abapUpdateViaBridge`). Every type with a real update
  // route is `isBridgeOnlyCreateType` and already returned above, dispatched into
  // `abapBridgeCrud` → `abapUpdateViaBridge`, whose OWN type check re-derives the same
  // answer from the same list — so this and that can never disagree. Without this gate,
  // a type like CLAS/OC falls through to the generic write path below, which has no idea
  // `mode="update"` was ever requested and misreports the failure as a missing `source`
  // (issue #83) — so this must fire before `authorizeMutation` or any other network use
  // below, not just before the misleading message.
  if ((input.mode ?? "write") === "update") {
    const requestedType = (input.type ?? "").trim().toUpperCase();
    if (!isBridgeUpdateType(requestedType)) {
      throw bridgeUpdateNotSupported(requestedType, target.name);
    }
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
    // my test class" would instead delete the whole class AND its other
    // includes. The journal now records all four local includes on a CLAS/OC
    // delete (src/adt/write.ts's `deleteObject`), so undoing the WHOLE delete
    // does bring them back — but there is still no verb that deletes one
    // include on its own, so this is refused for every include value,
    // including `main`, so callers never learn that `include` narrows a
    // delete. Zero-network, before `authorizeMutation` — src/adt/write.ts
    // refuses this too, for every other caller of `WriteTarget`; this is the
    // cheap early copy.
    if (input.include !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `\`include\` does not apply to mode=delete: ADT cannot delete one include of a class, only ` +
          `the whole class. Deleting ${target.name} because you asked to delete its ` +
          `${input.include} would destroy its main source and its other includes too.`,
        { object: target.name, include: input.include, mode: "delete" },
        `To empty an include, WRITE it: {object, include:"${input.include}", source:"<the new, ` +
          `possibly empty, content>"}. To delete the whole class, drop \`include\` — its includes ` +
          `are now recorded too, so abap_journal mode=undo on that delete restores all of them.`,
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
    // Issue #86: a base TABLE's secondary indexes have no ADT resource of
    // their own (see src/adt/index-create.ts's header) and are not captured
    // by the before-image the journal takes below — deleting the table
    // takes them with it with nothing anywhere recording what they were.
    // Read them now, BEFORE the delete: reading after would just see the
    // rows already gone (or the table itself gone, if it's a real DDIC
    // drop). TABL/DT only — a STRU has no index, and TABL/DI's own delete
    // path (abapDeleteIndexViaBridge below) is a single index, not a table.
    let preDeleteIndexes: readonly SecondaryIndexInfo[] | undefined;
    let preDeleteIndexesFailure: string | undefined;
    if (authorized.target.type === "TABL/DT") {
      try {
        preDeleteIndexes = (await readTableIndexes(conn, authorized.target.name)).indexes;
      } catch (e) {
        preDeleteIndexesFailure = e instanceof Error ? e.message : String(e);
      }
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
            // A CLAS/OC delete's four local includes (src/adt/write.ts's
            // `deleteObject`) — recorded as `parts` so undo of the whole
            // delete can restore each one, not just the main body. Each
            // part's `object` is the class's own ref with `sourceUri`
            // overridden to that include's document — the class identity is
            // the same, only the document under discussion differs.
            ...(img.includes?.length
              ? {
                  parts: img.includes.map((i) => ({
                    object: { ...journalRef(img.target), sourceUri: i.sourceUri },
                    existedBefore: i.existed,
                    beforeCapture: i.capture,
                    ...(i.source !== undefined ? { beforeSource: i.source } : {}),
                  })),
                }
              : {}),
            systemKey: systemKey(conn.cfg),
            tool: "abap_write",
          };
        },
      },
      (onBeforeImage) =>
        deleteObject(conn, authorized, {
          ...trOpts,
          ...(input.expect_etag ? { expectEtag: input.expect_etag } : {}),
          // `withJournalledMutation` (src/journal.ts) hands back a closure
          // that is a harmless no-op when `journal` is undefined — but it is
          // NOT `=== NO_JOURNAL`, so `deleteObject` cannot tell from the
          // closure alone that nothing will ever be done with a captured
          // before-image. Passing the literal sentinel here when there is no
          // journal to write to lets a CLAS/OC delete's four sub-include
          // reads (src/adt/write.ts's `deleteObject`) be skipped rather than
          // spent for nothing.
          onBeforeImage: journal !== undefined ? onBeforeImage : NO_JOURNAL,
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
        ...(res.corrNrHonoured === false ? { corr_nr_honoured: false } : {}),
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
        // Three mutually exclusive cases, checked in order: (1) the caller's corr_nr was
        // auto-resolved onto a DIFFERENT request than the lock named, so the ordinary
        // transport note's "that is the number this write sent" claim would be false —
        // corrNrNotHonouredNote replaces it rather than sitting alongside it; (2) package
        // delete + real transport, see packageDeleteTransportNote; (3) the ordinary case.
        res.corrNrHonoured === false && res.corrNrSent !== undefined && res.transport.corrNr !== undefined
          ? corrNrNotHonouredNote(res.corrNrSent, res.transport.corrNr, res.target.type, res.target.name)
          : isPackageDelete && res.transport.status === "transport" && res.transport.corrNr !== undefined
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
        ...(res.target.type === "TABL/DT"
          ? [tableDeleteIndexNote(res.target.name, preDeleteIndexes, preDeleteIndexesFailure)]
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

  // `fixed_point_arithmetic` applies to PROG/P only; `text_pool` to PROG/P,
  // CLAS/OC or FUGR/F. Checked here, zero-network, when `type` was given;
  // checked again below against the resolved target for the (usual) case
  // where an existing object's real type is only known once resolved.
  if (input.fixed_point_arithmetic !== undefined && input.type !== undefined) {
    assertProgramOnlyOption("fixed_point_arithmetic", requestedSpec?.type, {
      type: requestedSpec?.type ?? input.type,
    });
  }
  if (input.text_pool !== undefined && input.type !== undefined) {
    const requestedType = requestedSpec?.type;
    const textPoolDetails = { type: requestedType ?? input.type };
    assertTextPoolType(requestedType, textPoolDetails);
    assertTextPoolShape(requestedType, toTextPoolInput(input.text_pool), textPoolDetails);
  }

  // Zero-network refusal for a genuinely empty call (none of source/edit/
  // method/text_pool given), ahead of `authorizeMutation` so it costs nothing
  // on the wire. Everything else wrong with edit/method needs the resolved
  // target to explain precisely, so it's diagnosed in `resolveWriteSource`
  // instead.
  if (
    input.source === undefined &&
    input.edit === undefined &&
    input.method === undefined &&
    input.text_pool === undefined
  ) {
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

  // Post-resolution version of the two zero-network checks above, for when
  // `type` was not given.
  if (input.fixed_point_arithmetic !== undefined) {
    assertProgramOnlyOption("fixed_point_arithmetic", authorized.target.type, {
      type: authorized.target.type,
      name: authorized.target.name,
    });
  }
  if (input.text_pool !== undefined) {
    const resolvedType = authorized.target.type;
    const textPoolDetails = { type: resolvedType, name: authorized.target.name };
    assertTextPoolType(resolvedType, textPoolDetails);
    assertTextPoolShape(resolvedType, toTextPoolInput(input.text_pool), textPoolDetails);
  }

  // `text_pool` with no source/edit/method: write only the text pool of an
  // existing object, leaving its ABAP source untouched (issue #182). Reached
  // only when `text_pool` is set — the empty-call refusal above already
  // covers the case where nothing at all was given.
  if (input.source === undefined && input.edit === undefined && input.method === undefined) {
    if (!authorized.target.exists) {
      throw new AbapError(
        "BAD_INPUT",
        "text_pool without source needs an existing object; pass source to create it.",
        { name: authorized.target.name },
      );
    }
    const textPool = input.text_pool as NonNullable<WriteInputV2["text_pool"]>;
    const activateTextPool =
      (input.activate ?? true) && capabilitiesFor(authorized.target.type)?.activate !== false;
    const poolResult = await writeTextPoolJournalled(
      conn,
      journal,
      authorized,
      toTextPoolInput(textPool),
      { activate: activateTextPool, corrNr },
    );
    return buildResponse({
      header: {
        system: conn.cfg.sid,
        object: `${authorized.target.type} ${authorized.target.name}`,
        text_pool: textPoolWriteSummary(poolResult),
        text_pool_activated: poolResult.activation?.activated ? "yes" : "no",
      },
      notes: [TEXT_POOL_JOURNAL_NOTE],
      maxChars,
    });
  }

  // No CDS-specific `format` refusal needed: DDLS/DF, DDLX/EX, SRVD/SRV are
  // source-shape and `format` applies normally; DTEL/DE, DOMA/DD, TTYP/DA
  // are properties-shape and are refused explicitly below (the
  // `write.shape === "properties"` check). A type absent from
  // WRITABLE_TYPES/ENHANCEABLE_TYPES was already refused UNSUPPORTED by
  // `refuseUnwritableType` above, before `format:true` is ever scrutinised.

  // Turns whichever of source/edit/method the caller used into the one thing
  // `writeObject` needs: a complete replacement `source`, plus (for
  // edit/method) an `expectEtag` pinned to the bytes just read.
  const {
    source: resolvedSource,
    expectEtag: resolvedExpectEtag,
    current: resolvedCurrent,
    methodVersion: resolvedMethodVersion,
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
          // A sub-include's absence is `confirmed-absent` evidence, not the
          // generic `captureOf` path — see `includeCaptureOf`. Gated on
          // `img.include` so every non-include write keeps `captureOf`.
          beforeCapture: img.include !== undefined ? includeCaptureOf(img) : captureOf(img),
          ...(img.source !== undefined ? { beforeSource: img.source } : {}),
          // See the delete branch: begin(), since pre-flight resolution
          // already knows the request at this point.
          ...(img.corrNr !== undefined ? { corrNr: img.corrNr } : {}),
          afterSource: source,
          systemKey: systemKey(conn.cfg),
          tool: toolLabel,
        }),
      },
      (onBeforeImage) =>
        writeObject(conn, authorized, {
          source,
          ...trOpts,
          ...(resolvedExpectEtag ? { expectEtag: resolvedExpectEtag } : {}),
          ...(input.fixed_point_arithmetic !== undefined
            ? { fixedPointArithmetic: input.fixed_point_arithmetic }
            : {}),
          ...(input.remote_enabled !== undefined ? { remoteEnabled: input.remote_enabled } : {}),
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
              "nothing ran to check it. " +
              (languageDependentDiscardHint(discarded, source) ??
                "Re-read the object with abap_read to see the descriptor " +
                  "the server actually holds, then either rework the payload so the dropped " +
                  "element(s) survive, or accept the object as written and activate it yourself " +
                  "with abap_activate.") +
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
      // Issue #147 (3): each message carries the offending line (trimmed to
      // 200 chars) and one line of context each side, cut from `source` —
      // the bytes just sent — so no round trip and nothing to re-read.
      const rendered = renderMessages(check.messages, source);
      throw new AbapError(
        "CHECK_FAILED",
        `syntax check reported ${check.errors} error(s), ${check.warnings} warning(s)` +
          (rendered ? `:\n${rendered}` : ""),
        {
          messages: withSourceContext(check.messages, source, {
            maxLen: SOURCE_LINE_MAX,
            context: 1,
          }),
          rendered,
        },
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
        // #200: this settle and the one below are alternatives, so both carry it.
        ...(written.createdFresh ? { createdFresh: written.createdFresh } : {}),
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
    // Issue #217: assertNoErrors's CHECK_FAILED already carries the dependents still
    // inactive (e.details.inactive) — surface them here so the caller can act on them
    // directly instead of parsing the message. Drop any entry that just names the object
    // we ourselves wrote (same name, and same type when both are known).
    const inactiveDeps: InactiveObjectRef[] =
      isAbapError(e) && Array.isArray(e.details.inactive)
        ? (e.details.inactive as InactiveObjectRef[]).filter((r) => {
            if (!r || typeof r.name !== "string" || r.name.trim() === "") return false;
            const sameName = r.name.trim().toLowerCase() === objectName.trim().toLowerCase();
            const sameType =
              r.type && written.target.type
                ? r.type.toLowerCase() === written.target.type.toLowerCase()
                : true;
            return !(sameName && sameType);
          })
        : [];
    const inactiveDepsSummary =
      inactiveDeps.length > 0
        ? " Inactive dependencies: " +
          inactiveDeps
            .slice(0, 10)
            .map((r) => `${r.type} ${r.name}`)
            .join(", ") +
          (inactiveDeps.length > 10 ? `, +${inactiveDeps.length - 10} more` : "") +
          "."
        : "";
    const inactiveDepsHintPrefix =
      inactiveDeps.length > 0
        ? "Activate the inactive dependencies first — `abap_activate objects=[...]` naming " +
          `them (or \`abap_activate package=${written.target.packageName}\` for everything ` +
          `inactive in the package) — then activate ${objectName}. `
        : "";
    throw new AbapError(
      "CHECK_FAILED",
      `The source of ${objectName} WAS WRITTEN AND SAVED on ${conn.cfg.sid}, but ` +
        (attempted
          ? "activation failed"
          : "the syntax check failed before activation was attempted") +
        `, so the object is saved INACTIVE: ${cause}` +
        inactiveDepsSummary,
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
        ...(inactiveDeps.length > 0
          ? {
              inactive_dependencies: inactiveDeps.map((r) => ({
                name: r.name,
                type: r.type,
                ...(r.uri ? { uri: r.uri } : {}),
              })),
            }
          : {}),
        failure: isAbapError(e)
          ? {
              code: e.code,
              message: e.message,
              details: e.details,
              ...(e.hint ? { hint: e.hint } : {}),
            }
          : cause,
      },
      inactiveDepsHintPrefix +
        "The write itself succeeded and is NOT rolled back: the new source is on the server " +
        "and the object is INACTIVE, so it will not execute and callers still see the last " +
        "active version. Fix the reported lines — for a class, abap_write method=\"<NAME>\" " +
        "repairs one method against the INACTIVE version (no re-read needed; " +
        "details.failure.details.messages carries each offending line with context); " +
        "otherwise use edit= or write the full source again — then abap_activate, or write " +
        "with activate=true" +
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
    // #200: the create POST's 201 + Location; settle() ignores it when absence was already confirmed.
    ...(written.createdFresh ? { createdFresh: written.createdFresh } : {}),
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
  const notes: string[] = [
    written.corrNrOverrode !== undefined && written.corrNrSent !== undefined
      ? corrNrOverriddenWriteNote(written.corrNrOverrode, written.corrNrSent, written.target.type, written.target.name)
      : transportNote(written.transport, gate.config?.abapMode),
  ];
  if (ddicDescriptionDefaultNote !== undefined) notes.push(ddicDescriptionDefaultNote);
  if (written.processingTypeChanged) {
    notes.push(
      `Processing type set to ${written.processingType} via the ADT function-module descriptor ` +
        "(PUT under the same lock as the source). The descriptor PUT leaves an inactive version, " +
        "which activation picks up.",
    );
  }
  if (written.createLockRetried) {
    notes.push(
      `The create left the server's own enqueue on ${written.target.name} (blocking user = the ` +
        "connected user), so the lock was retried once in a fresh session; it succeeded and the " +
        "content was written under that lock (#205).",
    );
  }
  if (input.method !== undefined && resolvedMethodVersion !== undefined) {
    notes.push(
      `method="${input.method}" was resolved against the ${resolvedMethodVersion.toUpperCase()} ` +
        "version's component structure" +
        (resolvedMethodVersion === "inactive"
          ? " — a newer inactive version existed (e.g. after a CHECK_FAILED write) and its " +
            "line ranges were used."
          : "."),
    );
  }
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

  // `text_pool` alongside `source`: write it after the source write/
  // activation above completes. An AbapError here must not discard the
  // source write's result — it becomes a FAILED note/header instead of a throw.
  let textPoolResult: TextPoolWriteResult | undefined;
  let textPoolFailure: string | undefined;
  if (input.text_pool !== undefined) {
    try {
      textPoolResult = await writeTextPoolJournalled(
        conn,
        journal,
        authorized,
        toTextPoolInput(input.text_pool),
        { activate: wantActivate, corrNr },
      );
      notes.push(TEXT_POOL_JOURNAL_NOTE);
    } catch (e) {
      if (!isAbapError(e)) throw e;
      textPoolFailure = e.message;
      notes.push(`text_pool write failed: ${textPoolFailure}`);
    }
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
      ...(written.processingType !== undefined ? { processing_type: written.processingType } : {}),
      ...(written.corrNrOverrode !== undefined ? { corr_nr_honoured: false } : {}),
      check: propertiesShape
        ? "n/a (XML descriptor — validated by the server on write)"
        : check.ok
          ? "clean"
          : `${check.errors} error(s), ${check.warnings} warning(s)`,
      activated: activation ? activation.activated : activationSuppressed ? "n/a (always active)" : "skipped",
      ...(input.text_pool !== undefined
        ? {
            text_pool: textPoolResult
              ? textPoolWriteSummary(textPoolResult)
              : `FAILED — ${textPoolFailure}`,
            ...(textPoolResult
              ? { text_pool_activated: textPoolResult.activation?.activated ? "yes" : "no" }
              : {}),
          }
        : {}),
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
  /** The number this object's DELETE actually sent as `corrNr`; absent when it sent none. */
  readonly corrNrSent?: string;
  /**
   * Where CTS actually recorded the deletion — set whenever `corrNrSent` is set and that
   * could be confirmed, whether or not it agrees with `corrNrSent`. Read off the ADT lock
   * response for an ordinary delete; for a TRAN/T bridge delete (no lock response to read),
   * `readBackTransportEntry` instead, same as {@link abapDeleteViaBridge}'s single-object route.
   */
  readonly corrNrRecorded?: string;
  /** `false` when `corrNrSent` and `corrNrRecorded` differ. The batch never names a `corr_nr` of its own, so this can only fire on auto-resolution. */
  readonly corrNrHonoured?: boolean;
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
    | { kind: "absent"; name: string; type: string; uri: string }
    | {
        kind: "bridge-tran";
        name: string;
        uri: string;
        packageName: ServerPackage;
        corrNr?: string;
        corrSource?: "named" | "auto";
        transportInfo?: TransportInfo;
      };
  const pass1: Pass1Entry[] = [];
  for (const w of wanted) {
    const wType = w.type?.trim().toUpperCase();
    // Issue #202: TRAN/T has no writable ADT collection — `authorizeMutation` (via
    // `resolveWriteTarget`'s `refuseUnwritableType`) would abort the WHOLE batch with
    // UNSUPPORTED for it, same as it does for VIEW/DV, SHLP/DH and TABL/DI. TRAN/T is now
    // deletable in a batch, resolved through the same VIT-bridge/package/corr route
    // `abapDeleteViaBridge` uses for a single object; the other three bridge-only types
    // stay refused, with a clearer BAD_INPUT pointing at the single-object route instead
    // of the generic UNSUPPORTED `refuseUnwritableType` would throw.
    if (wType !== undefined && isBridgeOnlyCreateType(wType)) {
      if (wType !== "TRAN/T") {
        throw new AbapError(
          "BAD_INPUT",
          `${w.name} (${wType}) cannot be deleted in a batch: only ordinary ADT-resolvable types ` +
            "and TRAN/T are supported in `objects`. Nothing in this batch was deleted.",
          { type: wType, name: w.name },
          `Delete ${w.name} on its own with abap_write { mode: "delete", type: "${wType}", ` +
            `object: "${w.name}" } — or delete the remaining objects in a separate batch without it.`,
        );
      }
      const found = await verifyViaVitBridge(conn, "trant", w.name, "TRAN/T");
      if (found.status === "confirmed-absent") {
        pass1.push({ kind: "absent", name: w.name, type: "TRAN/T", uri: found.uri });
        continue;
      }
      if (found.status === "indeterminate") {
        throw new AbapError(
          "SAFETY_DENIED",
          `abapsmith could not confirm TRAN/T ${w.name}'s existence or its package before a ` +
            `delete, so it refuses the whole batch (${found.reason}).`,
          { reason: "PACKAGE_UNKNOWN", object: w.name, type: "TRAN/T", uri: found.uri, cause: found.reason },
          "Every delete is judged against the object's real package. Rather than guess, abapsmith " +
            "stops here. Check the object exists and this connection can read it, then retry.",
          { retryable: true }, // existence could not be confirmed, not denied — a healthy connection resolves it
        );
      }
      // Issue #201 (delete pre-check): the VIT bridge's stub can answer 200
      // for a TRAN/T TSTC has no row for at all. Cross-check before
      // resolving a package or a transport, so a phantom entry costs neither.
      const tstc = await lookupTransaction(conn, w.name);
      if (tstc === undefined) {
        pass1.push({ kind: "absent", name: w.name, type: "TRAN/T", uri: found.uri });
        continue;
      }
      const resolved = serverPackage(found);
      if (resolved === undefined) {
        throw new AbapError(
          "SAFETY_DENIED",
          `abapsmith could not determine which package TRAN/T ${w.name} belongs to, so it refuses ` +
            "the whole batch: the VIT bridge read answered but carried no <adtcore:packageRef> element.",
          { reason: "PACKAGE_UNKNOWN", object: w.name, type: "TRAN/T", uri: found.uri },
        );
      }
      // Batch `objects` entries carry no `corr_nr` field of their own — always
      // auto-resolved, the same route a caller-omitted corr_nr takes for a
      // single-object TRAN/T delete.
      const { corrNr, corrSource, transportInfo } = await resolveBridgeCreateCorr(
        conn,
        gate,
        transport,
        { name: w.name, type: "TRAN/T", uri: found.uri, packageName: resolved.name, op: "delete" },
        undefined,
      );
      pass1.push({
        kind: "bridge-tran",
        name: w.name,
        uri: found.uri,
        packageName: resolved,
        ...(corrNr !== undefined ? { corrNr } : {}),
        ...(corrSource !== undefined ? { corrSource } : {}),
        ...(transportInfo !== undefined ? { transportInfo } : {}),
      });
      continue;
    }
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

    if (p.kind === "bridge-tran") {
      // Mirrors abapDeleteViaBridge's TRAN/T branch: run the classic bridge delete, then
      // read back through the VIT bridge before trusting the transcript. No
      // `withJournalledMutation` here — a bridge delete captures no before-image, so
      // this entry's `journalEntry` stays unset, same as the single-object route.
      try {
        const deleted = await deleteTransactionViaBridge(conn, gate, {
          tcode: p.name,
          packageName: p.packageName,
          ...(p.corrNr !== undefined ? { corrNr: p.corrNr } : {}),
          ...(p.corrSource !== undefined ? { corrSource: p.corrSource } : {}),
        });
        // Mirrors abapDeleteViaBridge: confirm which request CTS actually recorded the
        // deletion under, since a bridge delete has no ADT lock response to read that off.
        let corrNrRecorded: string | undefined;
        let corrNrHonoured: boolean | undefined;
        if (p.transportInfo?.corrNr !== undefined) {
          const readback = await readBackTransportEntry(conn, {
            intended: p.transportInfo.corrNr,
            entry: { pgmid: "R3TR", type: "TRAN", name: p.name },
            lookup: { uri: p.uri, devclass: p.packageName.name },
          });
          if (readback.status === "confirmed-same") {
            corrNrRecorded = readback.trkorr;
            corrNrHonoured = true;
          } else if (readback.status === "confirmed-other") {
            corrNrRecorded = readback.trkorr;
            corrNrHonoured = false;
          }
        }
        // Issue #201: the VIT bridge's stub can answer 200 for a TRAN/T that TSTC has
        // no row for at all, so a bare 200 read-back is cross-checked against TSTC
        // before it is trusted as "still there".
        const outcome = await verifyTransactionDeleted(conn, p.name);
        if (outcome.status === "confirmed") {
          outcomes.push({
            name: p.name,
            type: "TRAN/T",
            uri: p.uri,
            ok: false,
            deleted: false,
            error: {
              code: "CHECK_FAILED",
              message:
                `${CLASSIC_BODY_CLASS} reported success (the transcript carries ` +
                `${deleted.transcript.tags.join(", ")}) but ${p.name} is STILL confirmed present ` +
                `at ${outcome.uri} (via ${outcome.via}) after delete.`,
            },
            ...(p.corrNr !== undefined ? { corrNrSent: p.corrNr } : {}),
            ...(corrNrRecorded !== undefined ? { corrNrRecorded } : {}),
            ...(corrNrHonoured !== undefined ? { corrNrHonoured } : {}),
          });
        } else {
          outcomes.push({
            name: p.name,
            type: "TRAN/T",
            uri: p.uri,
            ok: true,
            deleted: outcome.status === "confirmed-absent" ? true : "unverified",
            ...(p.corrNr !== undefined ? { corrNrSent: p.corrNr } : {}),
            ...(corrNrRecorded !== undefined ? { corrNrRecorded } : {}),
            ...(corrNrHonoured !== undefined ? { corrNrHonoured } : {}),
          });
        }
      } catch (e) {
        // A programmer error must still crash, not be folded into a per-object outcome.
        if (!isAbapError(e)) throw e;
        outcomes.push({
          name: p.name,
          type: "TRAN/T",
          uri: p.uri,
          ok: false,
          deleted: false,
          error: { code: e.code, message: e.message },
        });
      }
      continue;
    }

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
          ...(res.corrNrSent !== undefined ? { corrNrSent: res.corrNrSent } : {}),
          ...(res.transport.corrNr !== undefined ? { corrNrRecorded: res.transport.corrNr } : {}),
          ...(res.corrNrHonoured !== undefined ? { corrNrHonoured: res.corrNrHonoured } : {}),
        });
      } else {
        outcomes.push({
          name: res.target.name,
          type: res.target.type,
          uri: res.target.uri,
          ok: true,
          deleted: res.deleted,
          ...(entryId !== undefined ? { journalEntry: entryId } : {}),
          ...(res.corrNrSent !== undefined ? { corrNrSent: res.corrNrSent } : {}),
          ...(res.transport.corrNr !== undefined ? { corrNrRecorded: res.transport.corrNr } : {}),
          ...(res.corrNrHonoured !== undefined ? { corrNrHonoured: res.corrNrHonoured } : {}),
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
      // Only reachable via auto-resolution (the batch never names its own corr_nr), but
      // still worth flagging per-object: the caller may not otherwise learn that CTS
      // recorded this one on a different request than the one abapsmith resolved.
      const corrNrSuffix =
        o.corrNrHonoured === false && o.corrNrSent && o.corrNrRecorded
          ? ` (corr_nr ${o.corrNrSent} was not used — ${o.name} was locked by ${o.corrNrRecorded} and CTS recorded the deletion there)`
          : "";
      return o.deleted === "unverified"
        ? `${o.type} ${o.name}: deleted (UNVERIFIED — abapsmith could not confirm the object is ` +
            `actually gone)${journalSuffix}${corrNrSuffix}`
        : `${o.type} ${o.name}: deleted${journalSuffix}${corrNrSuffix}`;
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
          ...(o.corrNrSent !== undefined ? { corrNrSent: o.corrNrSent } : {}),
          ...(o.corrNrRecorded !== undefined ? { corrNrRecorded: o.corrNrRecorded } : {}),
          ...(o.corrNrHonoured !== undefined ? { corrNrHonoured: o.corrNrHonoured } : {}),
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
      `${CLASSIC_BODY_CLASS} reported success (the transcript carries ` +
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
      bridge_class: CLASSIC_BODY_CLASS,
      markers: bridgeRes.transcript.tags.join(" "),
      tdevc: bridgeRes.tdevc
        ? `DEVCLASS=${bridgeRes.tdevc.devclass} PARENTCL=${bridgeRes.tdevc.parentcl} ` +
          `DLVUNIT=${bridgeRes.tdevc.dlvunit} KORRFLAG=${bridgeRes.tdevc.korrflag}`
        : undefined,
      journal: journalled ? entryId : "off (nothing recorded)",
    },
    notes: [
      transportNote(transportInfo, gate.config?.abapMode),
      "Created by running the classic fluid tool's body class " + CLASSIC_BODY_CLASS +
        ", not over ADT REST: CL_PACKAGE_FACTORY=>CREATE_NEW_PACKAGE, then " +
        "lo_package->save(i_transport_request=...) — SE21's own backend. See " +
        "src/adt/package-create.ts and src/adt/classic-call.ts.",
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
 * Zero-network refusal for the three where-used/impact guard flags
 * (`confirm_in_use`, `confirm_maintenance_dialog`, `confirm_in_role_menu`):
 * each means something for exactly one type+mode combination (or, for
 * `confirm_in_role_menu`, two — TRAN/T delete and TRAN/T mode="update"),
 * never a silent no-op for any other. All three are threaded through to the
 * classrun bridge that actually enforces the guard: `confirm_in_use` by
 * `deleteSearchHelpViaBridge` (`src/adt/shlp-delete.ts`),
 * `confirm_maintenance_dialog` by `deleteClassicViewViaBridge`
 * (`src/adt/view-delete.ts`), and `confirm_in_role_menu` by
 * `deleteTransactionViaBridge` (`src/adt/tran-delete.ts`) and
 * `updateTransaction` (`src/adt/tran-update.ts`).
 */
function assertGuardFlagsApplicable(type: string, input: WriteInput): void {
  const mode = input.mode ?? "write";
  const inapplicable = (field: string, message: string): never => {
    throw new AbapError("BAD_INPUT", message, { type, mode, field });
  };

  if (input.confirm_in_use !== undefined && !(type === "SHLP/DH" && mode === "delete")) {
    inapplicable(
      "confirm_in_use",
      "`confirm_in_use` only applies to a SHLP/DH delete (DD04L/DD35L/DD31S where-used guard). " +
        `Omit it for ${type || "this type"} mode="${mode}".`,
    );
  }
  if (input.confirm_maintenance_dialog !== undefined && !(type === "VIEW/DV" && mode === "delete")) {
    inapplicable(
      "confirm_maintenance_dialog",
      "`confirm_maintenance_dialog` only applies to a VIEW/DV delete (TVDIR maintenance-dialog " +
        `guard). Omit it for ${type || "this type"} mode="${mode}".`,
    );
  }
  if (input.confirm_in_role_menu !== undefined) {
    if (type !== "TRAN/T") {
      inapplicable(
        "confirm_in_role_menu",
        `\`confirm_in_role_menu\` only applies to TRAN/T. Omit it for ${type || "this type"}.`,
      );
    }
    if (mode !== "delete" && mode !== "update") {
      inapplicable(
        "confirm_in_role_menu",
        `\`confirm_in_role_menu\` only applies to TRAN/T mode="delete" or mode="update". Omit it for mode="${mode}".`,
      );
    }
  }
}

/**
 * `VIEW/DV` / `TRAN/T` / `SHLP/DH` / `TABL/DI` — create, update and delete, through the
 * classrun bridge. `resolveWriteTarget` refuses these types outright for ANY op (see the
 * `isBridgeOnlyCreateType` refusal in `src/adt/write.ts`) — there is no writable ADT
 * collection to resolve a URI against — so this is the ONLY place any of them is gated.
 * `TABL/DI` is dispatched to its own pair of functions first (no `update`: an index has
 * no in-place retarget, only re-create-after-delete): the `vitType` ternary
 * `abapCreateViaBridge`/`abapDeleteViaBridge` use below has no VIT bridge object type for
 * a secondary index (it has no ADT resource at all, VIT or otherwise), so a third type
 * cannot be folded into that pair without breaking it. `SHLP/DH` has no VIT bridge type
 * either (ADT 404s on it too, and there is no VIT stub for search helps) — its create and
 * delete are their own functions below, verified through `readSearchHelp`
 * (`src/adt/catalog-read.ts`) instead. `mode: "update"` is dispatched before any create/
 * delete sibling is reached — it never applies to `TABL/DI`.
 */
async function abapBridgeCrud(
  conn: AbapConnection,
  target: WriteTarget,
  input: WriteInput,
  maxChars: number,
  gate: SafetyGate,
  journal?: Journal,
  transport?: SessionTransport,
): Promise<BuiltResponse> {
  const type = (input.type ?? "").trim().toUpperCase();
  assertGuardFlagsApplicable(type, input);
  const mode = input.mode ?? "write";
  // Issue #214: `kind`/`screen`/`target_transaction`/`skip_first_screen`/`parameters`/
  // `variant`/`cross_client_variant`/`class`/`update_mode` only mean anything for a
  // TRAN/T create — refused here, zero-network, once for every other type/mode this
  // dispatcher can route to, instead of repeating the field list in each sibling.
  if (
    (type !== "TRAN/T" || mode === "update" || mode === "delete") &&
    (input.kind !== undefined ||
      input.screen !== undefined ||
      input.target_transaction !== undefined ||
      input.skip_first_screen !== undefined ||
      input.parameters !== undefined ||
      input.variant !== undefined ||
      input.cross_client_variant !== undefined ||
      input.class !== undefined ||
      input.update_mode !== undefined)
  ) {
    throw new AbapError(
      "BAD_INPUT",
      "`kind`, `screen`, `target_transaction`, `skip_first_screen`, `parameters`, `variant`, " +
        "`cross_client_variant`, `class` and `update_mode` only apply to a TRAN/T create. Omit them " +
        `for ${type || "this type"} mode="${mode}".`,
      { type, mode },
    );
  }
  if (type === "TABL/DI") {
    if (mode === "update") {
      throw new AbapError(
        "BAD_INPUT",
        'A TABL/DI (secondary index) has no update route: DD_INDEX_INTERFACE creates or drops one, ' +
          "it does not retarget an existing index's fields in place.",
        { type, mode },
        'Delete the index (mode="delete") and create a new one with the desired `index_fields`.',
      );
    }
    return mode === "delete"
      ? abapDeleteIndexViaBridge(conn, target, input, maxChars, gate, transport)
      : abapCreateIndexViaBridge(conn, target, input, maxChars, gate, transport);
  }
  if (mode === "update") {
    return abapUpdateViaBridge(conn, target, input, maxChars, gate, journal);
  }
  if (type === "SHLP/DH") {
    return mode === "delete"
      ? abapDeleteSearchHelpViaBridge(conn, target, input, maxChars, gate, journal)
      : abapCreateSearchHelpViaBridge(conn, target, input, maxChars, gate, journal, transport);
  }
  return mode === "delete"
    ? abapDeleteViaBridge(conn, target, input, maxChars, gate, transport)
    : abapCreateViaBridge(conn, target, input, maxChars, gate, journal, transport);
}

async function abapCreateViaBridge(
  conn: AbapConnection,
  target: WriteTarget,
  input: WriteInput,
  maxChars: number,
  gate: SafetyGate,
  journal?: Journal,
  transport?: SessionTransport,
): Promise<BuiltResponse> {
  const type = (input.type ?? "").trim().toUpperCase();
  const cap = capabilitiesFor(type);
  const label = cap?.label ?? type;
  const bad = (message: string, hint?: string): never => {
    throw new AbapError("BAD_INPUT", message, { object: target.name, type }, hint);
  };

  // `method` is refused here EXCEPT for TRAN/T kind=oo, where it is the OO method the
  // transaction calls (TransactionParams.methodName below), not a source-edit field.
  const methodAllowed = type === "TRAN/T" && input.kind === "oo";
  if (input.source !== undefined || input.edit !== undefined || (!methodAllowed && input.method !== undefined)) {
    bad(
      `A ${label} (${type}) has no source: it is created from its definition, not from ABAP text. ` +
        "Omit `source`, `edit`" +
        (methodAllowed ? "" : " and `method`") +
        ".",
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
  // combination costs no request: a $-package (including this $TMP default) must not
  // carry corr_nr, and a supplied corr_nr must be TRKORR-shaped. A transportable
  // package needing a request is resolved below (preflightPackageCorr), not asserted
  // here — view-create.ts's own `validate` still refuses an unresolved one as defence
  // in depth, not the only enforcement point.
  const named = normalizeCorrNr(input.corr_nr);
  if (type === "VIEW/DV") assertClassicViewCreateTarget(packageName, named);
  // Same pairing for TRAN/T: RPY_TRANSACTION_INSERT's own RS_CORR_INSERT needs the request.
  // A transportable package with NO corr_nr is not asserted here either — it is resolved
  // below by `resolveBridgeCreateCorr` (issue #141), and tran-create.ts's own `validate`
  // still refuses an unresolved one as defence in depth.
  if (type === "TRAN/T" && (named !== undefined || isLocalPackageName(packageName))) {
    assertTransactionCreateTarget(packageName, named);
  }
  // Issue #209: a create without `description` used to be refused; it now defaults to the
  // object's own name (upper-cased) and the response notes say so.
  const descriptionDefaulted = !input.description?.trim();
  const description = input.description?.trim() || target.name.toUpperCase();

  // Zero-network TRAN/T kind validation (issue #214): must run before the VIT
  // pre-check below, the first network call in this function. Also replaces the old
  // unconditional "program is required" check with a kind-aware one — report/dialog
  // need `program`, parameter/variant need `target_transaction`, oo needs `class`+`method`.
  let transactionParams: TransactionParams | undefined;
  if (type === "TRAN/T") {
    transactionParams = {
      tcode: target.name,
      program: input.program,
      description,
      packageName,
      kind: input.kind,
      screen: input.screen,
      targetTransaction: input.target_transaction,
      skipFirstScreen: input.skip_first_screen,
      parameters: input.parameters,
      variant: input.variant,
      crossClientVariant: input.cross_client_variant,
      className: input.class,
      methodName: input.method,
      updateMode: input.update_mode,
    };
    assertTransactionKindParams(transactionParams);
  }

  // Zero-network gate verdict BEFORE any request leaves (TRAN/T's program look-up,
  // the absence probe, the resolver): a refused package, name, mode, or — under
  // ABAP_ALLOW_TRANSPORTS=auto — a caller-named corr_nr costs nothing on the wire
  // and can never leave a freshly created request behind (issues #141/#142). The
  // same verdict is repeated on the resolved request inside
  // `resolveBridgeCreateCorr` and again in the bridge module's own gate call;
  // every layer must pass, this one only moves the first refusal earlier.
  gate.assert(
    "write",
    { name: target.name, type, packageName: packageName.toUpperCase(), exists: false },
    { corr: bridgePreflightCorr(named), intent: undefined, phase: "preflight" },
  );

  const common = { description: description as string, packageName };
  let created: { run: RunResult; transcript: DdicTranscript };
  let bridgeClass: string;
  let detail: string;
  let verified: boolean;
  let verifyNote: string;
  let entryId: string | undefined;
  let registration: BridgeRegistration;
  // Set for a transportable create of either type once `resolveBridgeCreateCorr` resolves
  // a request; stays undefined for a local package (no transport).
  let transportInfo: TransportInfo | undefined;
  // Set below, once transportInfo.corrNr is known, by reading back which request CTS
  // actually recorded the object in — neither bridge type's lock response says.
  let readback: TrReadback | undefined;

  const vitType = type === "VIEW/DV" ? "viewdv" : "trant";
  const objectUri = vitBridgeUri(vitType, target.name);

  // Positive absence evidence, read BEFORE the create — the one value
  // (beforeCapture: "confirmed-absent") that `deleteEvidenceBlocker` (src/adt/undo.ts)
  // accepts as authorising a later delete-shaped undo. Skipped entirely when the journal
  // is off: nothing downstream would use it, so there is no reason to pay for the read.
  let beforeCapture: BeforeImageCapture = "failed";
  let tstcCrossCheckNote = "";
  if (journal) {
    const preCheck = await verifyViaVitBridge(conn, vitType, target.name, type);
    if (preCheck.status === "confirmed" && type === "TRAN/T") {
      // Issue #201: the VIT bridge's stub can answer 200 for a TRAN/T that TSTC has no
      // row for at all (a stale/generic stub response, not evidence of a real
      // transaction). Cross-check against TSTC directly before refusing the create.
      let tstc: Awaited<ReturnType<typeof lookupTransaction>>;
      try {
        tstc = await lookupTransaction(conn, target.name);
      } catch (err) {
        throw new AbapError(
          "CHECK_FAILED",
          `${label} ${target.name} already exists (confirmed at ${preCheck.uri}, via ${preCheck.via}). ` +
            `abap_write mode="write" creates a NEW ${label}; it does not overwrite one that is already ` +
            "there, and neither DDIC bridge FM has a modelled overwrite behaviour to fall back on" +
            `; the TSTC cross-check failed: ${err instanceof Error ? err.message : String(err)}`,
          { object: target.name, type, uri: preCheck.uri },
          `Delete the existing ${label} first (abap_write mode="delete"), or pick a different name.`,
        );
      }
      if (tstc === undefined) {
        beforeCapture = "confirmed-absent";
        tstcCrossCheckNote =
          `The VIT bridge answered 200 for ${target.name} at ${preCheck.uri}, but TSTC has no row for ` +
          "it, so it is treated as absent and created (issue #201).";
      } else {
        throw new AbapError(
          "CHECK_FAILED",
          `${label} ${target.name} already exists (confirmed at ${preCheck.uri}, via ${preCheck.via}; ` +
            `TSTC confirms a row (program ${tstc.program})). abap_write mode="write" creates a NEW ` +
            `${label}; it does not overwrite one that is already there, and neither DDIC bridge FM has ` +
            "a modelled overwrite behaviour to fall back on.",
          { object: target.name, type, uri: preCheck.uri },
          `Delete the existing ${label} first (abap_write mode="delete"), or pick a different name.`,
        );
      }
    } else if (preCheck.status === "confirmed") {
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
    bridgeClass = CLASSIC_BODY_CLASS;
    const { corrNr, corrSource, transportInfo: viewTransport } = await resolveBridgeCreateCorr(
      conn,
      gate,
      transport,
      { name: target.name, type: "VIEW/DV", uri: classicViewUri(target.name), packageName },
      named,
    );
    transportInfo = viewTransport;
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
          ...(corrSource !== undefined ? { corrSource } : {}),
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
    if (transportInfo?.corrNr !== undefined) {
      readback = await readBackTransportEntry(conn, {
        intended: transportInfo.corrNr,
        entry: { pgmid: "R3TR", type: "VIEW", name: target.name },
        lookup: { uri: objectUri, devclass: packageName },
      });
    }
  } else {
    if (input.base_table !== undefined || input.view_fields !== undefined) {
      bad("`base_table` and `view_fields` are VIEW/DV fields; a transaction has no base table.");
    }
    if (input.activate === true) bad("A transaction has no activation step; omit `activate`.");
    // `transactionParams`/`assertTransactionKindParams` above already validated, zero-network,
    // that the fields this `kind` needs are present — this block only resolves/verifies the
    // ones that need a network round trip.
    const params = transactionParams as TransactionParams;
    const kind = params.kind ?? "report";

    let program: string | undefined;
    let screen: string | undefined;
    let targetTransaction: string | undefined;
    let className: string | undefined;

    if (kind === "report" || kind === "dialog") {
      // Closed defect: a transaction bound to an unchecked program used to be created
      // unconditionally (the FM doesn't validate it either), so a typo landed as a
      // working-looking `created: true` pointing at nothing. One real GET, reusing the
      // same resolver every other write path uses.
      program = (input.program as string).trim().toUpperCase();
      const programTarget = await resolveWriteTarget(conn, { type: "PROG/P", name: program });
      if (!programTarget.exists) {
        throw new AbapError(
          "NOT_FOUND",
          `Program ${program} does not exist on ${conn.cfg.sid}, so a transaction cannot be created ` +
            "to start it. abapsmith checks this before creating a TRAN/T, rather than creating one " +
            "that points nowhere and reporting success.",
          { object: target.name, type, program },
          `Create the program first with abap_write (type="PROG/P"), or correct ` +
            "`program` if this was a typo.",
        );
      }
      if (kind === "dialog") screen = (input.screen as string).trim();
    } else if (kind === "parameter" || kind === "variant") {
      targetTransaction = (input.target_transaction as string).trim().toUpperCase();
      let tstc: Awaited<ReturnType<typeof lookupTransaction>>;
      try {
        tstc = await lookupTransaction(conn, targetTransaction);
      } catch (err) {
        throw new AbapError(
          "CHECK_FAILED",
          `Checking whether transaction ${targetTransaction} exists (TSTC) failed: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          { object: target.name, type, targetTransaction },
        );
      }
      if (tstc === undefined) {
        throw new AbapError(
          "NOT_FOUND",
          `Transaction ${targetTransaction} does not exist on ${conn.cfg.sid}, so a parameter/variant ` +
            "transaction cannot call it.",
          { object: target.name, type, targetTransaction },
          `Create ${targetTransaction} first, or correct \`target_transaction\` if this was a typo.`,
        );
      }
    } else {
      className = (input.class as string).trim().toUpperCase();
      const classTarget = await resolveWriteTarget(conn, { type: "CLAS/OC", name: className });
      if (!classTarget.exists) {
        throw new AbapError(
          "NOT_FOUND",
          `Class ${className} does not exist on ${conn.cfg.sid}, so an OO transaction cannot call it.`,
          { object: target.name, type, className },
          `Create the class first with abap_write (type="CLAS/OC"), or correct \`class\` if this was ` +
            "a typo.",
        );
      }
    }

    bridgeClass = CLASSIC_BODY_CLASS;
    // Same route as VIEW/DV above: a transportable package resolves its request under
    // ABAP_ALLOW_TRANSPORTS (issue #141) instead of demanding a named one.
    const { corrNr, corrSource, transportInfo: tranTransport } = await resolveBridgeCreateCorr(
      conn,
      gate,
      transport,
      { name: target.name, type: "TRAN/T", uri: objectUri, packageName },
      named,
    );
    transportInfo = tranTransport;
    ({ result: created, entryId } = await journalBridgeCreate(
      journal,
      conn,
      { name: target.name, type, uri: objectUri, packageName, description: description as string },
      beforeCapture,
      corrNr,
      () =>
        createTransaction(conn, gate, {
          ...params,
          program,
          screen,
          targetTransaction,
          className,
          corrNr,
          ...(corrSource !== undefined ? { corrSource } : {}),
        }),
    ));
    detail =
      kind === "report"
        ? `report transaction starting ${program} (dynpro 1000)`
        : kind === "dialog"
          ? `dialog transaction starting ${program} screen ${screen}`
          : kind === "parameter"
            ? `parameter transaction calling ${targetTransaction} (skip first screen: ` +
              `${params.skipFirstScreen ? "yes" : "no"}) with ${params.parameters?.length ?? 0} parameter(s)`
            : kind === "variant"
              ? `variant transaction calling ${targetTransaction} with variant ${params.variant}`
              : `OO transaction calling ${className}=>${params.methodName} via OS_APPLICATION ` +
                `(update mode ${params.updateMode ?? "S"})`;

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
    if (transportInfo?.corrNr !== undefined) {
      readback = await readBackTransportEntry(conn, {
        intended: transportInfo.corrNr,
        entry: { pgmid: "R3TR", type: "TRAN", name: target.name },
        lookup: { uri: objectUri, devclass: packageName },
      });
    }
  }

  const headerTransportInfo = bridgeTransportHeaderInfo(transportInfo, readback);
  return buildResponse({
    header: {
      system: conn.cfg.sid,
      object: `${type} ${target.name}`,
      package: packageName,
      ...(headerTransportInfo !== undefined ? { transport: transportHeaderText(headerTransportInfo) } : {}),
      mode: "create-bridge",
      created: true,
      verified,
      detail,
      bridge_class: bridgeClass,
      markers: created.transcript.tags.join(" "),
      journal: entryId !== undefined ? entryId : "off (not journalled — see notes)",
    },
    notes: [
      `Created by running the classic fluid tool's body class ${bridgeClass}, not over ADT REST: ` +
        `${cap?.bridgeCreate?.via ?? "see src/adt/classic-call.ts"}`,
      cap?.bridgeCreate?.limits ?? "",
      descriptionDefaulted ? `description defaulted to "${description}" (none was given).` : "",
      tstcCrossCheckNote,
      ...bridgeTransportNotes(transportInfo, transport, gate, readback),
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
 * `source`/`edit`/`method`/`include`/`expect_etag`/`software_component`/
 * `package_type`/`transport_layer`/`format` to mean on a delete.
 *
 * `corr_nr`: VIEW/DV's delete bridge (`src/adt/view-delete.ts`) still takes no transport
 * parameter at all and refuses one zero-network here, as before. TRAN/T's delete bridge
 * (`src/adt/tran-delete.ts`) is transport-aware (issue #202): a transportable package
 * registers the delete via `RS_CORR_INSERT` before `RPY_TRANSACTION_DELETE` runs, so a
 * `corr_nr` is resolved (not refused) the same way {@link abapCreateViaBridge}'s TRAN/T
 * branch resolves one, through {@link resolveBridgeCreateCorr}; a local package still
 * refuses one, enforced by `deleteTransactionViaBridge` itself once the real (server-read)
 * package is known.
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
 * asking the server — and it is also why the `corr_nr`/local-package pairing for TRAN/T
 * cannot be checked zero-network either (same precedent as `abapDeleteIndexViaBridge`'s
 * `base_table`-dependent package read).
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
  transport?: SessionTransport,
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
  const named = normalizeCorrNr(input.corr_nr);
  // Issue #202: VIEW/DV's delete bridge still takes no transport parameter at all, so
  // `corr_nr` stays refused zero-network for it. TRAN/T's now does — resolved below,
  // once the real package is known, instead of refused here.
  if (type === "VIEW/DV" && named !== undefined) {
    bad(
      `\`corr_nr\` cannot be honoured for a ${label} delete: the view delete bridge takes no ` +
        "transport parameter (src/adt/view-delete.ts). None is needed either — the delete " +
        "registers nothing in CTS, so it is judged as a local mutation and no transport " +
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
  if (type === "TRAN/T") {
    // Issue #201 (delete pre-check): a VIT-bridge 200 is not proof the
    // transaction exists — TSTC is. Checked before any transport
    // resolution, so a phantom delete costs no transport request.
    const tstc = await lookupTransaction(conn, target.name);
    if (tstc === undefined) {
      throw new AbapError(
        "NOT_FOUND",
        `${label} ${target.name} does not exist, so there is nothing to delete (the VIT bridge ` +
          `answered 200 at ${found.uri}, but TSTC has no row for it).`,
        { object: target.name, type, uri: found.uri },
      );
    }
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
  let transportInfo: TransportInfo | undefined;
  let readback: TrReadback | undefined;

  if (type === "VIEW/DV") {
    bridgeClass = CLASSIC_BODY_CLASS;
    // `resolved`, not `packageName`: both bridges now require the branded `ServerPackage`
    // (src/adt/resolved-package.ts) so the compiler, not just this function, refuses a
    // caller-supplied or re-derived string at this boundary.
    deleted = await deleteClassicViewViaBridge(conn, gate, {
      viewName: target.name,
      packageName: resolved,
      confirmMaintenanceDialog: input.confirm_maintenance_dialog,
    });
  } else {
    bridgeClass = CLASSIC_BODY_CLASS;
    // Issue #202: same corr_nr resolution route abapCreateViaBridge's TRAN/T branch
    // uses — a local package returns `named` unchecked (deleteTransactionViaBridge
    // itself refuses a corr_nr against one), a transportable package resolves one
    // under ABAP_ALLOW_TRANSPORTS via preflightPackageCorr.
    const { corrNr, corrSource, transportInfo: tranTransport } = await resolveBridgeCreateCorr(
      conn,
      gate,
      transport,
      { name: target.name, type: "TRAN/T", uri: found.uri, packageName, op: "delete" },
      named,
    );
    transportInfo = tranTransport;
    deleted = await deleteTransactionViaBridge(conn, gate, {
      tcode: target.name,
      packageName: resolved,
      confirmInRoleMenu: input.confirm_in_role_menu,
      ...(corrNr !== undefined ? { corrNr } : {}),
      ...(corrSource !== undefined ? { corrSource } : {}),
    });
    if (transportInfo?.corrNr !== undefined) {
      readback = await readBackTransportEntry(conn, {
        intended: transportInfo.corrNr,
        entry: { pgmid: "R3TR", type: "TRAN", name: target.name },
        lookup: { uri: found.uri, devclass: packageName },
      });
    }
  }

  // Issue #201: TRAN/T's VIT-bridge stub can answer 200 for a TCODE that never
  // existed, so its post-delete read-back cross-checks TSTC directly; VIEW/DV has
  // no such stand-in and keeps the plain read-back + repository-search verifier.
  const outcome =
    type === "TRAN/T"
      ? await verifyTransactionDeleted(conn, target.name)
      : await verifyObjectDeleted(conn, {
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
    verifyNote =
      outcome.via === "tstc"
        ? `Read back: the VIT bridge answered 200 but TSTC has no row for ${target.name} — confirmed ` +
          "absent (issue #201)."
        : `Read back and confirmed absent at ${outcome.uri} (via ${outcome.via}) after delete.`;
  } else {
    verified = false;
    verifyNote =
      `NOT independently confirmed absent: ${outcome.reason} abapsmith still reports the delete here, ` +
      "trusting the classrun transcript (the markers above) — but that is not the same confidence " +
      "as a live read-back. See src/adt/write-verify.ts.";
  }

  const headerTransportInfo = bridgeTransportHeaderInfo(transportInfo, readback);
  return buildResponse({
    header: {
      system: conn.cfg.sid,
      object: `${type} ${target.name}`,
      package: packageName,
      ...(headerTransportInfo !== undefined ? { transport: transportHeaderText(headerTransportInfo) } : {}),
      mode: "delete-bridge",
      deleted: true,
      verified,
      bridge_class: bridgeClass,
      markers: deleted.transcript.tags.join(" "),
      journal: "off (not journalled — see notes)",
    },
    notes: [
      `Deleted by running the classic fluid tool's body class ${bridgeClass}, not over ADT REST — ` +
        `${type} has no writable ADT collection at all (see this type's REGISTRY entry in ` +
        "src/adt/capabilities.ts).",
      verifyNote,
      "NOT journalled: a bridge delete captures no before-image, so abap_journal mode=undo cannot " +
        "restore this object. To bring it back, create it again with a fresh abap_write call.",
      type === "VIEW/DV" && !isLocalPackageName(packageName)
        ? bridgeDeleteTransportEntryNote(label, target.name, packageName)
        : "",
      ...(type === "TRAN/T" ? bridgeTransportNotes(transportInfo, transport, gate, readback) : []),
    ].filter((n) => n !== ""),
    maxChars,
  });
}

/**
 * `SHLP/DH` create. Sibling of {@link abapCreateViaBridge}, but not folded into it —
 * `abapBridgeCrud`'s doc comment explains why SHLP/DH is dispatched on its own rather
 * than joining that function's `vitType` ternary: there is no VIT bridge object type
 * for a search help. Verification here goes through {@link probeSearchHelp}
 * (`readSearchHelp`, `src/adt/catalog-read.ts`) instead of `verifyObjectCreated`, and
 * package resolution goes through {@link resolveShlpPackage} instead of a VIT-bridge
 * read — see that helper's own doc comment for the weaker guarantee that implies.
 *
 * Journalled through a BESPOKE inline `withJournalledMutation` call, deliberately NOT
 * the shared {@link journalBridgeCreate} VIEW/DV and TRAN/T use: this entry is marked
 * `irreversible: true` unconditionally. `src/adt/undo.ts`'s `vitTypeFor()` throws an
 * internal-invariant `SAFETY_DENIED` for any type it has no VIT-bridge segment for,
 * and has no case for SHLP/DH — `resolveBridgeCreateUndo` would reach that throw for
 * an ordinary (non-irreversible) `isBridgeOnlyCreateType` entry, which SHLP/DH has
 * been ever since `capabilities.ts` started declaring a `bridgeCreate` for it (this
 * change). Marking the entry irreversible makes `undo.ts`'s `undoBlocker()` refuse
 * cleanly ("This entry is marked irreversible...") before `planUndo` ever reaches the
 * crashing branch, while still recording the create for the audit trail. Reversal is
 * `abap_write { mode: "delete", type: "SHLP/DH" }`, never undo.
 */
async function abapCreateSearchHelpViaBridge(
  conn: AbapConnection,
  target: WriteTarget,
  input: WriteInput,
  maxChars: number,
  gate: SafetyGate,
  journal?: Journal,
  transport?: SessionTransport,
): Promise<BuiltResponse> {
  const type = "SHLP/DH";
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
  if (input.include !== undefined) {
    bad(`\`include\` is a CLAS/OC field; a ${label} (${type}) has no class includes.`);
  }
  if (input.expect_etag !== undefined) {
    bad(`\`expect_etag\` does not apply to a ${label} create — there is no prior version to compare.`);
  }
  if (input.software_component !== undefined || input.package_type !== undefined || input.transport_layer !== undefined) {
    bad("`software_component`, `package_type` and `transport_layer` are DEVC/K fields only.");
  }
  if (input.base_table !== undefined || input.view_fields !== undefined) {
    bad("`base_table` and `view_fields` are VIEW/DV fields; a search help has neither.");
  }
  if (input.program !== undefined) bad("`program` is a TRAN/T field; a search help does not start a program.");
  if (input.activate === false) {
    bad(
      "A search help cannot be created without activating it: DDIF_SHLP_ACTIVATE runs inside the " +
        "same bridge execution as DDIF_SHLP_PUT. Omit `activate`.",
    );
  }
  if (!input.shlp) {
    bad(
      `\`shlp\` is required to create a ${label} (${type}): its DD30V/DD32P/DD31V/DD33V definition. ` +
        "See SearchHelpParams in src/adt/shlp-create.ts.",
    );
  }
  // `bad()` always throws, but TS's never-return narrowing doesn't follow a call
  // through a local `const` arrow function value — same cast `abapCreateViaBridge`
  // uses for `base_table`/`program` above.
  const shlp = input.shlp as NonNullable<WriteInput["shlp"]>;
  // Issue #209: an absent description defaults to the object's own name rather than
  // being refused; the response notes say so.
  const descriptionDefaulted = !input.description?.trim();
  const description = input.description?.trim() || target.name.toUpperCase();

  const packageNameStr = target.packageName?.trim() || "$TMP";
  const named = normalizeCorrNr(input.corr_nr);
  // Zero-network local+corr_nr pairing check, same "a bad combination costs no
  // request" discipline as abapCreateViaBridge. The other pairing direction
  // (transportable without corr_nr) is no longer a refusal: the request is
  // resolved below by `resolveBridgeCreateCorr` (issue #141), and
  // createSearchHelp's own validate() still refuses an unresolved one as
  // defence in depth.
  if (named !== undefined || isLocalPackageName(packageNameStr)) {
    assertSearchHelpTarget(packageNameStr, named);
  }
  // Zero-network gate verdict on the caller-named package BEFORE the package
  // read below, so a refused package/name/mode costs no request at all. The
  // same verdict is repeated on the server-resolved package inside
  // `resolveBridgeCreateCorr` and again in createSearchHelp's own gate call —
  // every layer must pass; this one only moves the first refusal earlier.
  gate.assert(
    "write",
    { name: target.name, type, packageName: packageNameStr.trim().toUpperCase(), exists: false },
    { corr: bridgePreflightCorr(named), intent: undefined, phase: "preflight" },
  );

  const packageName = await resolveShlpPackage(conn, packageNameStr);
  const { corrNr, corrSource, transportInfo } = await resolveBridgeCreateCorr(
    conn,
    gate,
    transport,
    {
      name: target.name,
      type,
      uri: vitBridgeUri("shlpdh", target.name),
      packageName: packageName.name,
    },
    named,
  );

  // Positive absence evidence, read BEFORE the create — same "confirmed-absent"
  // discipline as abapCreateViaBridge's own pre-check, skipped entirely when the
  // journal is off: create_search_help's own ABAP-side probe already refuses an
  // existing name either way (abap-shlp.ts's create_search_help method), so nothing
  // downstream needs this read when there is no journal to feed it.
  let beforeCapture: BeforeImageCapture = "failed";
  if (journal) {
    const existing = await probeSearchHelp(conn, target.name);
    if (existing !== undefined) {
      throw new AbapError(
        "CHECK_FAILED",
        `${label} ${target.name} already exists. abap_write mode="write" creates a NEW ${label}; it ` +
          "does not overwrite one that is already there.",
        { object: target.name, type },
        `Delete the existing ${label} first (abap_write mode="delete"), pick a different name, or ` +
          'use mode="update" to replace its definition in place.',
      );
    }
    beforeCapture = "confirmed-absent";
  }

  const params: SearchHelpParams = {
    shlpName: target.name,
    description: description as string,
    packageName,
    ...(corrNr !== undefined ? { corrNr } : {}),
    ...(corrSource !== undefined ? { corrSource } : {}),
    selectionMethod: shlp.selectionMethod,
    selectionMethodType: shlp.selectionMethodType,
    dialogType: shlp.dialogType,
    textTable: shlp.textTable,
    hotKey: shlp.hotKey,
    elementary: shlp.elementary,
    fields: shlp.fields,
    includes: shlp.includes,
    assignments: shlp.assignments,
  };

  const { result: created, entryId, settle } = await withJournalledMutation<undefined, { run: RunResult; transcript: DdicTranscript }>(
    journal,
    {
      begin: () => ({
        operation: "create",
        object: journalRef({
          name: target.name,
          type,
          uri: `urn:abapsmith:shlp:${target.name}`,
          packageName: packageName.name,
          description: description as string,
        }),
        existedBefore: false,
        beforeCapture,
        systemKey: systemKey(conn.cfg),
        tool: "abap_write",
        irreversible: true,
        ...(corrNr ? { corrNr } : {}),
      }),
    },
    async (onBeforeImage) => {
      await onBeforeImage(undefined);
      return await createSearchHelp(conn, gate, params);
    },
  );
  await settle({ outcome: "succeeded", activation: { attempted: false } });

  const after = await probeSearchHelp(conn, target.name);
  let verified: boolean;
  let verifyNote: string;
  if (after === undefined) {
    verified = false;
    verifyNote =
      "NOT independently confirmed present: a follow-up catalog read (src/adt/catalog-read.ts) did " +
      "not find it. abapsmith still reports created:true here, trusting the classrun transcript " +
      "(the markers above) — SHLP/DH has no VIT-bridge stub to read back through the way VIEW/DV " +
      "and TRAN/T do, so this is a weaker confirmation than either of those types gets. Confirm by " +
      "hand in SE11 before relying on it.";
  } else {
    verified = true;
    verifyNote = "Read back and confirmed present via a catalog read (src/adt/catalog-read.ts) after create.";
  }

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      object: `${type} ${target.name}`,
      package: packageName.name,
      ...(transportInfo !== undefined ? { transport: transportHeaderText(transportInfo) } : {}),
      mode: "create-bridge",
      created: true,
      verified,
      detail: `${shlp.elementary ? "elementary" : "collective"} search help`,
      bridge_class: CLASSIC_BODY_CLASS,
      markers: created.transcript.tags.join(" "),
      journal: entryId ?? "off (not journalled — see notes)",
    },
    notes: [
      `Created by running the classic fluid tool's body class ${CLASSIC_BODY_CLASS}, not over ADT ` +
        `REST: ${cap?.bridgeCreate?.via ?? "see src/adt/classic-call.ts"}`,
      cap?.bridgeCreate?.limits ?? "",
      descriptionDefaulted ? `description defaulted to "${description}" (none was given).` : "",
      ...bridgeTransportNotes(transportInfo, transport, gate),
      verifyNote,
      entryId !== undefined
        ? `Journalled as ${entryId}, but marked irreversible: SHLP/DH has no VIT-bridge type for ` +
          "abap_journal mode=undo to resolve it through (src/adt/undo.ts's vitTypeFor only covers " +
          'VIEW/DV and TRAN/T), so undo refuses this entry rather than crash. Reverse by hand with ' +
          'abap_write { mode: "delete", type: "SHLP/DH" }.'
        : 'Not journalled (no journal was open). Reverse by hand with abap_write { mode: "delete", ' +
          'type: "SHLP/DH" }.',
      "abapsmith could only confirm the NAMED package is real (via DEVC/K, or trusted zero-network " +
        "for a local $-prefixed name) — unlike VIEW/DV and TRAN/T, there is no VIT-bridge stub or " +
        "TADIR column in the catalog read for SHLP/DH to confirm the object's OWN registered " +
        "package after create; see resolveShlpPackage's doc comment.",
    ].filter((n) => n !== ""),
    maxChars,
  });
}

/**
 * `SHLP/DH` delete. Sibling of {@link abapDeleteViaBridge}, but not folded into it:
 * SHLP/DH has no VIT bridge type to read through, so existence/package resolution
 * goes through {@link probeSearchHelpAnyState}/{@link resolveShlpPackage} instead — see
 * `resolveShlpPackage`'s doc comment for the weaker guarantee that implies here:
 * unlike VIEW/DV's and TRAN/T's delete, this cannot confirm the search help's OWN
 * current package, only that the NAMED package is real.
 *
 * Journalled through a BESPOKE inline `withJournalledMutation` call, the same shape
 * {@link abapCreateSearchHelpViaBridge} above and this function's own update sibling
 * below use. The pre-delete {@link probeSearchHelpAnyState} read a few lines down —
 * needed anyway to confirm the object exists before deleting it — IS the before-image:
 * its rendered pseudo-DDL (`existing.ddl`, rendered by `readSearchHelpImpl` in
 * `src/adt/catalog-read.ts`, which follows the same pseudo-DDL convention as
 * `src/adt/ddic.ts`) becomes the entry's `beforeSource`.
 * `beforeCapture` is always `"captured"` here, never `"confirmed-absent"`: the
 * NOT_FOUND throw a few lines below already refused an absent object before any
 * journal entry is opened, so by the time one is, `existing` is always defined — a
 * genuine absence, not a swallowed error, since `catalogProbe` (`probeSearchHelpAnyState`'s
 * base, `src/adt/write.ts`'s neighbour `catalogProbe` helper above) returns
 * `undefined` only on a server NOT_FOUND and rethrows everything else. `existing` is not
 * always an ACTIVE definition, though: `probeSearchHelpAnyState` also resolves an
 * inactive-only search help (`existing.meta.versionState === "inactive"` — a create that
 * PUT but never activated, DD30L-AS4LOCAL='N', no active row at all), and this function
 * proceeds with the delete in that case rather than refusing NOT_FOUND, since the
 * bridge's `delete_search_help` removes both DDIC states and the TADIR entry either
 * way. The response and journal note both say so, so `beforeSource`/`existing.ddl` is
 * never mistaken for an active definition when it is actually the inactive one.
 *
 * `irreversible: true` unconditionally, for two independent reasons. Mechanically: the
 * stored before-image is rendered pseudo-DDL, not a `DDIF_SHLP_PUT` payload, so there
 * is nothing for undo to replay even if it tried — the entry exists for audit and
 * manual reconstruction only. Safety-critically: `src/adt/undo.ts`'s `vitTypeFor()` has
 * no case for SHLP/DH regardless (same reasoning as {@link abapCreateSearchHelpViaBridge}'s
 * own doc comment above), so marking it irreversible makes `undo.ts`'s `undoBlocker()`
 * refuse cleanly before `planUndo` ever reaches that gap. Reversal is a fresh
 * `abap_write { mode: "write", type: "SHLP/DH" }` recreating the definition by hand,
 * never `abap_journal mode=undo`.
 */
async function abapDeleteSearchHelpViaBridge(
  conn: AbapConnection,
  target: WriteTarget,
  input: WriteInput,
  maxChars: number,
  gate: SafetyGate,
  journal?: Journal,
): Promise<BuiltResponse> {
  const type = "SHLP/DH";
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
    bad("`description` is a create/update field; a delete does not rename anything.");
  }
  if (input.activate !== undefined) bad("`activate` is a create-only field; a delete has nothing to activate.");
  if (input.base_table !== undefined || input.view_fields !== undefined) {
    bad("`base_table` and `view_fields` are VIEW/DV create fields; a delete needs neither.");
  }
  if (input.program !== undefined) bad("`program` is a TRAN/T create field; a delete needs no program.");
  if (input.shlp !== undefined) bad("`shlp` is a create/update field; a delete does not redefine anything.");
  if (
    input.software_component !== undefined ||
    input.package_type !== undefined ||
    input.transport_layer !== undefined
  ) {
    bad("`software_component`, `package_type` and `transport_layer` are DEVC/K create fields only.");
  }
  if (normalizeCorrNr(input.corr_nr) !== undefined) {
    bad(
      `\`corr_nr\` cannot be honoured for a ${label} delete: the delete bridge takes no transport ` +
        "parameter (src/adt/shlp-delete.ts). None is needed either — the delete registers nothing " +
        "in CTS, so it is judged as a local mutation and no transport allowlist blocks it.",
      "Retry without `corr_nr`.",
    );
  }

  const existing = await probeSearchHelpAnyState(conn, target.name);
  if (existing === undefined) {
    throw new AbapError(
      "NOT_FOUND",
      `${label} ${target.name} does not exist, so there is nothing to delete.`,
      { object: target.name, type },
    );
  }
  // Inactive-only leftover — a create that PUT but never activated (DD30L-AS4LOCAL='N',
  // no active row at all). `probeSearchHelpAnyState`'s doc comment explains why the
  // delete proceeds here instead of refusing NOT_FOUND: the bridge's `delete_search_help`
  // removes both DDIC states and the TADIR entry regardless of which one is active.
  const inactiveOnly = existing.meta.versionState === "inactive";

  const packageNameStr = target.packageName?.trim() || "$TMP";
  const resolvedPackage = await resolveShlpPackage(conn, packageNameStr);

  // `existing` (read above to confirm the object is there to delete) doubles as the
  // journal's before-image — see this function's doc comment for why `beforeCapture`
  // is always "captured" at this point and why the entry is unconditionally irreversible.
  // When `inactiveOnly`, `existing.ddl` is the INACTIVE definition (no active version
  // ever existed to read instead) — the note below and the journal entry's own note say
  // so, so `beforeSource` is never mistaken for an active definition on restore.
  const { result: deleted, entryId, settle } = await withJournalledMutation<
    undefined,
    { run: RunResult; transcript: DdicTranscript }
  >(
    journal,
    {
      begin: () => ({
        operation: "delete",
        object: journalRef({
          name: target.name,
          type,
          uri: `urn:abapsmith:shlp:${target.name}`,
          packageName: resolvedPackage.name,
        }),
        existedBefore: true,
        beforeCapture: "captured",
        beforeSource: existing.ddl,
        systemKey: systemKey(conn.cfg),
        tool: "abap_write",
        irreversible: true,
      }),
    },
    async (onBeforeImage) => {
      await onBeforeImage(undefined);
      return await deleteSearchHelpViaBridge(conn, gate, {
        shlpName: target.name,
        packageName: resolvedPackage,
        confirmInUse: input.confirm_in_use,
      });
    },
  );
  await settle({ outcome: "succeeded", activation: { attempted: false } });

  // Any-state here too, not just active-only: the bridge is expected to remove BOTH
  // DDIC states, so a leftover inactive row after a claimed success must still fail
  // this check the same way a leftover active row would.
  const after = await probeSearchHelpAnyState(conn, target.name);
  if (after !== undefined) {
    throw new AbapError(
      "CHECK_FAILED",
      `${CLASSIC_BODY_CLASS} reported success (the transcript carries ` +
        `${deleted.transcript.tags.join(", ")}) but ${target.name} is STILL confirmed present via a ` +
        "catalog read (src/adt/catalog-read.ts) after delete. abapsmith will not report a delete as " +
        "successful when it can prove the object is still there." +
        (entryId !== undefined
          ? ` This was already journalled as ${entryId}; whether there is anything left to act on is ` +
            "unresolved — the object may still exist."
          : ""),
      { object: target.name, type, markers: deleted.transcript.tags.join(" ") },
    );
  }
  const verified = true;
  const verifyNote = "Read back and confirmed absent via a catalog read (src/adt/catalog-read.ts) after delete.";

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      object: `${type} ${target.name}`,
      package: resolvedPackage.name,
      mode: "delete-bridge",
      deleted: true,
      verified,
      bridge_class: CLASSIC_BODY_CLASS,
      markers: deleted.transcript.tags.join(" "),
      journal: entryId ?? "off (not journalled — see notes)",
    },
    notes: [
      `Deleted by running the classic fluid tool's body class ${CLASSIC_BODY_CLASS}, not over ADT ` +
        `REST — ${type} has no writable ADT collection at all (see this type's REGISTRY entry in ` +
        "src/adt/capabilities.ts).",
      inactiveOnly
        ? `${target.name} had no ACTIVE version — only an inactive one (DD30L-AS4LOCAL='N'), the ` +
          "state a create that PUT but failed to activate leaves behind. abapsmith deleted it anyway: " +
          "the bridge's delete_search_help removes both DDIC states and the TADIR entry, whichever " +
          "is (or isn't) active. The before-image captured for this journal entry (and quoted below) " +
          "is that INACTIVE definition — there was never an active one to read instead."
        : "",
      verifyNote,
      entryId !== undefined
        ? `Journalled as ${entryId}, but marked irreversible: the stored before-image is rendered ` +
          "pseudo-DDL (src/adt/catalog-read.ts), not a DDIF_SHLP_PUT payload, so nothing can mechanically " +
          "replay it back into existence, and SHLP/DH has no VIT-bridge type for abap_journal " +
          "mode=undo to resolve it through either way (src/adt/undo.ts's vitTypeFor only covers " +
          "VIEW/DV and TRAN/T). The entry is kept for audit and manual reconstruction only — THIS " +
          'DELETE CANNOT BE UNDONE with abap_journal. To bring the search help back, recreate it by ' +
          'hand with abap_write { mode: "write", type: "SHLP/DH" }, using the pre-delete definition ' +
          `recorded in this journal entry${inactiveOnly ? " (which is the INACTIVE definition — there was no active one)" : ""}.`
        : 'Not journalled (no journal was open), so abapsmith kept no copy of the definition either — ' +
          "this deletion is IRREVERSIBLE from here. To bring the search help back, recreate it by " +
          'hand with abap_write { mode: "write", type: "SHLP/DH" }.',
      "abapsmith could only confirm the NAMED package is real, not that it is the search help's OWN " +
        "current package — unlike VIEW/DV's and TRAN/T's delete, there is no VIT-bridge read here to " +
        "gate on the server's own answer instead of the caller's. See resolveShlpPackage's doc " +
        "comment in src/tools/write.ts.",
      isLocalPackageName(resolvedPackage.name)
        ? ""
        : bridgeDeleteTransportEntryNote(label, target.name, resolvedPackage.name),
    ].filter((n) => n !== ""),
    maxChars,
  });
}

/**
 * `VIEW/DV` / `TRAN/T` / `SHLP/DH` update (`mode: "update"`), dispatched from
 * `abapBridgeCrud` before any create/delete sibling is reached. Unlike create, where
 * absence is proof enough to proceed, an update needs a REAL current object to
 * retarget/replace — so this always resolves the object's package the anti-bypass
 * way (via a fresh server read: {@link resolveBridgeUpdateTarget} for VIEW/DV and
 * TRAN/T, {@link resolveShlpPackage} for SHLP/DH — a caller's `package` argument is
 * only ever checked for agreement, never substituted, the same discipline
 * {@link abapDeleteViaBridge} uses), then captures a real before-image via the
 * matching catalog read (`src/adt/catalog-read.ts`) before dispatching the update.
 *
 * Every update-mode journal entry is marked `irreversible: true` — deliberately, for
 * two independent reasons. Semantically: none of the three DDIC bridge FMs
 * (`DDIF_VIEW_PUT`, `DDIF_SHLP_PUT`, `RPY_TRANSACTION_DELETE`+`RPY_TRANSACTION_INSERT`)
 * has a real "put the old definition back" primitive, so there is nothing for undo to
 * replay even with a captured before-image. Safety-critically: `src/adt/undo.ts`'s
 * bridge-create-undo path (`resolveBridgeCreateUndo`/`vitTypeFor`) is the only branch
 * `planUndo` has for an `isBridgeOnlyCreateType` entry regardless of its `operation`,
 * `vitTypeFor` has no SHLP/DH case and throws an internal-invariant `SAFETY_DENIED`
 * for it — so an update entry left reversible would crash `abap_journal mode=undo`
 * for SHLP/DH exactly the way an ordinary create entry would. `irreversible: true`
 * makes `undo.ts`'s `undoBlocker()` refuse cleanly before `planUndo` ever reaches that
 * branch, for all three types uniformly (VIEW/DV and TRAN/T included, even though
 * `vitTypeFor` does support them — an update has nothing to undo TO either way).
 */

/**
 * Single source of truth for "which types have a real `mode=\"update\"` route" —
 * consulted both by `abapUpdateViaBridge` below (reached only for a type
 * `isBridgeOnlyCreateType` already routed here) and by `abapWrite`'s own zero-network
 * gate (reached for every OTHER type, which never gets near `isBridgeOnlyCreateType`'s
 * dispatch at all). One list, so the two refusals can never drift apart.
 */
const BRIDGE_UPDATE_TYPES: readonly string[] = ["VIEW/DV", "TRAN/T", "SHLP/DH"];

function isBridgeUpdateType(type: string): boolean {
  return BRIDGE_UPDATE_TYPES.includes(type);
}

/**
 * The one "no update route" refusal both call sites above throw for a type outside
 * {@link BRIDGE_UPDATE_TYPES} — built in one place so a caller sees a single wording,
 * never two variants depending on which of the two gates happened to catch it.
 */
function bridgeUpdateNotSupported(type: string, objectName: string): AbapError {
  return new AbapError(
    "BAD_INPUT",
    `${type || "This type"} has no update route: mode="update" is only wired for VIEW/DV, TRAN/T ` +
      "and SHLP/DH.",
    { object: objectName, type, mode: "update" },
    'Use mode="write" to create, or (for most other types) an ordinary abap_write with `source`/' +
      '`edit` to change an existing object\'s definition in place.',
  );
}

async function abapUpdateViaBridge(
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
    throw new AbapError("BAD_INPUT", message, { object: target.name, type, mode: "update" }, hint);
  };

  if (!isBridgeUpdateType(type)) {
    throw bridgeUpdateNotSupported(type, target.name);
  }
  if (input.source !== undefined || input.edit !== undefined || input.method !== undefined) {
    bad(`A ${label} (${type}) has no source: omit \`source\`, \`edit\` and \`method\`.`);
  }
  if (input.format) bad(`A ${label} (${type}) has no source; \`format\` does not apply.`);
  if (input.include !== undefined) bad(`\`include\` is a CLAS/OC field; a ${label} (${type}) has no class includes.`);
  if (input.expect_etag !== undefined) {
    bad(`\`expect_etag\` does not apply to a ${label} update — there is no ADT resource to hold one.`);
  }
  if (input.software_component !== undefined || input.package_type !== undefined || input.transport_layer !== undefined) {
    bad("`software_component`, `package_type` and `transport_layer` are DEVC/K fields only.");
  }

  const requestedPackage = target.packageName?.trim();
  const corrNr = normalizeCorrNr(input.corr_nr);
  const description = input.description?.trim();

  if (type === "VIEW/DV") {
    if (input.program !== undefined) bad("`program` is a TRAN/T field; a view does not start a program.");
    if (input.shlp !== undefined) bad("`shlp` is a SHLP/DH field; a view has no search-help definition.");
    if (input.confirm_in_use !== undefined || input.confirm_in_role_menu !== undefined) {
      bad(`Neither confirm_in_use nor confirm_in_role_menu applies to ${type}; omit them.`);
    }
    if (input.activate === false) {
      bad(
        "A classic view update cannot skip activation: DDIF_VIEW_ACTIVATE runs inside the same " +
          "bridge execution as DDIF_VIEW_PUT. Omit `activate`.",
      );
    }
    if (!input.base_table?.trim()) {
      bad("`base_table` is required to update a classic view (VIEW/DV): the single table it projects.");
    }
    if (!input.view_fields || input.view_fields.length === 0) {
      bad(
        "`view_fields` is required to update a classic view (VIEW/DV) — an update replaces the " +
          "whole field list, and DDIF_VIEW_PUT would not accept a view projecting no field at all.",
      );
    }
    if (!description) {
      bad(
        `\`description\` is required to update a ${label} (${type}) — DDIF_VIEW_PUT replaces the ` +
          "whole definition, including the text, every time.",
      );
    }
    const baseTable = input.base_table as string;
    const viewFields = input.view_fields as string[];

    const resolvedPackage = await resolveBridgeUpdateTarget(
      conn,
      "viewdv",
      target.name,
      type,
      label,
      requestedPackage,
    );
    const before = await catalogProbe(() => readClassicView(conn, target.name));
    if (before === undefined) {
      throw new AbapError(
        "NOT_FOUND",
        `View ${target.name} does not exist, so there is nothing to update.`,
        { object: target.name, type },
      );
    }
    const local = isLocalPackageName(resolvedPackage.name);
    const corrSource: "named" | "auto" | undefined = local ? undefined : "named";

    const { result: updated, entryId, settle } = await withJournalledMutation<
      undefined,
      { run: RunResult; transcript: DdicTranscript }
    >(
      journal,
      {
        begin: () => ({
          operation: "update",
          object: journalRef({
            name: target.name,
            type,
            uri: vitBridgeUri("viewdv", target.name),
            packageName: resolvedPackage.name,
            description: description as string,
          }),
          existedBefore: true,
          beforeCapture: "captured",
          beforeSource: before.ddl,
          systemKey: systemKey(conn.cfg),
          tool: "abap_write",
          irreversible: true,
          ...(corrNr ? { corrNr } : {}),
        }),
      },
      async (onBeforeImage) => {
        await onBeforeImage(undefined);
        return await updateClassicView(conn, gate, {
          viewName: target.name,
          baseTable,
          fields: viewFields,
          description: description as string,
          packageName: resolvedPackage.name,
          corrNr,
          corrSource,
        });
      },
    );
    await settle({ outcome: "succeeded", activation: { attempted: false } });

    const after = await catalogProbe(() => readClassicView(conn, target.name));
    const verified = after !== undefined;
    const verifyNote = verified
      ? "Read back and confirmed present via a catalog read (src/adt/catalog-read.ts) after update."
      : "NOT independently confirmed present after update: a follow-up catalog read did not find " +
        "it. abapsmith still reports this update as done, trusting the classrun transcript (the " +
        "markers above) — but that is not the same confidence as a live read-back.";

    return buildResponse({
      header: {
        system: conn.cfg.sid,
        object: `${type} ${target.name}`,
        package: resolvedPackage.name,
        mode: "update-bridge",
        updated: true,
        verified,
        bridge_class: CLASSIC_BODY_CLASS,
        markers: updated.transcript.tags.join(" "),
        journal: entryId ?? "off (not journalled — see notes)",
      },
      notes: [
        `Updated by running the classic fluid tool's body class ${CLASSIC_BODY_CLASS}, not over ADT ` +
          `REST: ${cap?.bridgeCreate?.via ?? "see src/adt/classic-call.ts"}`,
        cap?.bridgeCreate?.limits ?? "",
        verifyNote,
        "DDIF_VIEW_PUT replaces the whole definition: any joined table or field not passed in this " +
          "call was removed.",
        entryId !== undefined
          ? `Journalled as ${entryId}, but marked irreversible: neither DDIF_VIEW_PUT nor any other ` +
            "primitive this bridge calls can put the OLD definition back, so there is nothing for " +
            "abap_journal mode=undo to replay even with the before-image captured above. Reverse by " +
            "hand with another mode=\"update\" call carrying the old field list."
          : "Not journalled (no journal was open).",
      ].filter((n) => n !== ""),
      maxChars,
    });
  }

  if (type === "TRAN/T") {
    if (input.base_table !== undefined || input.view_fields !== undefined) {
      bad("`base_table` and `view_fields` are VIEW/DV fields; a transaction has no base table.");
    }
    if (input.shlp !== undefined) bad("`shlp` is a SHLP/DH field; a transaction has no search-help definition.");
    if (input.activate === true) bad("A transaction has no activation step; omit `activate`.");
    if (input.confirm_in_use !== undefined) bad("`confirm_in_use` does not apply to TRAN/T; omit it.");
    if (!input.program || !input.program.trim()) {
      bad(
        "`program` is required to update a transaction (TRAN/T): the EXISTING report program it " +
          "should start after the retarget.",
      );
    }
    if (!description) {
      bad(
        `\`description\` is required to update a ${label} (${type}) — RPY_TRANSACTION_INSERT ` +
          "replaces the whole definition, including the text, every time.",
      );
    }
    const program = (input.program as string).trim().toUpperCase();

    // Same closed defect as abapCreateViaBridge's TRAN/T branch: check the program
    // exists before pointing a transaction at it, rather than creating a
    // working-looking retarget to nothing.
    const programTarget = await resolveWriteTarget(conn, { type: "PROG/P", name: program });
    if (!programTarget.exists) {
      throw new AbapError(
        "NOT_FOUND",
        `Program ${program} does not exist on ${conn.cfg.sid}, so a transaction cannot be retargeted ` +
          "to start it.",
        { object: target.name, type, program },
        `Create the program first with abap_write (type="PROG/P"), or correct `+
          "\`program\` if this was a typo.",
      );
    }

    const resolvedPackage = await resolveBridgeUpdateTarget(
      conn,
      "trant",
      target.name,
      type,
      label,
      requestedPackage,
    );
    const before = await catalogProbe(() => readTransaction(conn, target.name));
    if (before === undefined) {
      throw new AbapError(
        "NOT_FOUND",
        `Transaction ${target.name} does not exist, so there is nothing to retarget.`,
        { object: target.name, type },
      );
    }

    const { result: updated, entryId, settle } = await withJournalledMutation<
      undefined,
      { run: RunResult; transcript: DdicTranscript }
    >(
      journal,
      {
        begin: () => ({
          operation: "update",
          object: journalRef({
            name: target.name,
            type,
            uri: vitBridgeUri("trant", target.name),
            packageName: resolvedPackage.name,
            description: description as string,
          }),
          existedBefore: true,
          beforeCapture: "captured",
          beforeSource: before.ddl,
          systemKey: systemKey(conn.cfg),
          tool: "abap_write",
          irreversible: true,
          ...(corrNr ? { corrNr } : {}),
        }),
      },
      async (onBeforeImage) => {
        await onBeforeImage(undefined);
        return await updateTransaction(conn, gate, {
          tcode: target.name,
          program,
          description: description as string,
          packageName: resolvedPackage,
          corrNr,
          corrSource: corrNr !== undefined ? "named" : undefined,
          confirmInRoleMenu: input.confirm_in_role_menu,
        });
      },
    );
    await settle({ outcome: "succeeded", activation: { attempted: false } });

    const after = await catalogProbe(() => readTransaction(conn, target.name));
    const verified = after !== undefined && after.meta.program === program;
    const verifyNote = verified
      ? "Read back and confirmed present, retargeted to the new program, via a catalog read " +
        "(src/adt/catalog-read.ts) after update."
      : "NOT independently confirmed retargeted: a follow-up catalog read either did not find the " +
        "transaction or still showed the old program. abapsmith still reports this update as done, " +
        "trusting the classrun transcript (the markers above) — but that is not the same confidence " +
        "as a live read-back.";

    return buildResponse({
      header: {
        system: conn.cfg.sid,
        object: `${type} ${target.name}`,
        package: resolvedPackage.name,
        mode: "update-bridge",
        updated: true,
        verified,
        bridge_class: CLASSIC_BODY_CLASS,
        markers: updated.transcript.tags.join(" "),
        journal: entryId ?? "off (not journalled — see notes)",
      },
      notes: [
        `Updated by running the classic fluid tool's body class ${CLASSIC_BODY_CLASS}, not over ADT ` +
          `REST: ${cap?.bridgeCreate?.via ?? "see src/adt/classic-call.ts"}`,
        cap?.bridgeCreate?.limits ?? "",
        verifyNote,
        entryId !== undefined
          ? `Journalled as ${entryId}, but marked irreversible: RPY_TRANSACTION_DELETE has no ` +
            "companion that restores a deleted transaction's prior TSTC row, so there is nothing " +
            "for abap_journal mode=undo to replay even with the before-image captured above. " +
            'Reverse by hand with another mode="update" call carrying the old program.'
          : "Not journalled (no journal was open).",
      ].filter((n) => n !== ""),
      maxChars,
    });
  }

  // type === "SHLP/DH"
  if (input.base_table !== undefined || input.view_fields !== undefined) {
    bad("`base_table` and `view_fields` are VIEW/DV fields; a search help has neither.");
  }
  if (input.program !== undefined) bad("`program` is a TRAN/T field; a search help does not start a program.");
  if (input.confirm_in_role_menu !== undefined) bad("`confirm_in_role_menu` does not apply to SHLP/DH; omit it.");
  if (input.activate === false) {
    bad(
      "A search help update cannot skip activation: DDIF_SHLP_ACTIVATE runs inside the same bridge " +
        "execution as DDIF_SHLP_PUT. Omit `activate`.",
    );
  }
  if (!input.shlp) {
    bad(
      `\`shlp\` is required to update a ${label} (${type}): its full DD30V/DD32P/DD31V/DD33V ` +
        "definition — update_search_help REPLACES the whole thing, so every field, include and " +
        "assignment to keep must be passed again.",
    );
  }
  const shlp = input.shlp as NonNullable<WriteInput["shlp"]>;
  if (!description) {
    bad(
      `\`description\` is required to update a ${label} (${type}) — DDIF_SHLP_PUT replaces the ` +
        "whole definition, including the text, every time.",
    );
  }

  const packageNameStr = requestedPackage || "$TMP";
  const resolvedPackage = await resolveShlpPackage(conn, packageNameStr);
  const before = await probeSearchHelp(conn, target.name);
  if (before === undefined) {
    throw new AbapError(
      "NOT_FOUND",
      `Search help ${target.name} does not exist, so there is nothing to update.`,
      { object: target.name, type },
    );
  }
  const local = isLocalPackageName(resolvedPackage.name);
  const corrSource: "named" | "auto" | undefined = local ? undefined : "named";

  const params: SearchHelpParams = {
    shlpName: target.name,
    description: description as string,
    packageName: resolvedPackage,
    corrNr,
    corrSource,
    selectionMethod: shlp.selectionMethod,
    selectionMethodType: shlp.selectionMethodType,
    dialogType: shlp.dialogType,
    textTable: shlp.textTable,
    hotKey: shlp.hotKey,
    elementary: shlp.elementary,
    fields: shlp.fields,
    includes: shlp.includes,
    assignments: shlp.assignments,
  };

  const { result: updated, entryId, settle } = await withJournalledMutation<
    undefined,
    { run: RunResult; transcript: DdicTranscript }
  >(
    journal,
    {
      begin: () => ({
        operation: "update",
        object: journalRef({
          name: target.name,
          type,
          uri: `urn:abapsmith:shlp:${target.name}`,
          packageName: resolvedPackage.name,
          description: description as string,
        }),
        existedBefore: true,
        beforeCapture: "captured",
        beforeSource: before.ddl,
        systemKey: systemKey(conn.cfg),
        tool: "abap_write",
        irreversible: true,
        ...(corrNr ? { corrNr } : {}),
      }),
    },
    async (onBeforeImage) => {
      await onBeforeImage(undefined);
      return await updateSearchHelp(conn, gate, params);
    },
  );
  await settle({ outcome: "succeeded", activation: { attempted: false } });

  const after = await probeSearchHelp(conn, target.name);
  const verified = after !== undefined;
  const verifyNote = verified
    ? "Read back and confirmed present via a catalog read (src/adt/catalog-read.ts) after update."
    : "NOT independently confirmed present after update: a follow-up catalog read did not find it. " +
      "abapsmith still reports this update as done, trusting the classrun transcript (the markers " +
      "above) — SHLP/DH has no VIT-bridge stub to read back through the way VIEW/DV and TRAN/T do.";

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      object: `${type} ${target.name}`,
      package: resolvedPackage.name,
      mode: "update-bridge",
      updated: true,
      verified,
      bridge_class: CLASSIC_BODY_CLASS,
      markers: updated.transcript.tags.join(" "),
      journal: entryId ?? "off (not journalled — see notes)",
    },
    notes: [
      `Updated by running the classic fluid tool's body class ${CLASSIC_BODY_CLASS}, not over ADT ` +
        `REST: ${cap?.bridgeCreate?.via ?? "see src/adt/classic-call.ts"}`,
      cap?.bridgeCreate?.limits ?? "",
      verifyNote,
      "DDIF_SHLP_PUT replaces the whole definition: any field, include or assignment not passed in " +
        "this call was removed.",
      "abapsmith could only confirm the NAMED package is real, not that it is the search help's OWN " +
        "current package — see resolveShlpPackage's doc comment.",
      entryId !== undefined
        ? `Journalled as ${entryId}, but marked irreversible: DDIF_SHLP_PUT has no companion that ` +
          "restores a search help's prior definition, and SHLP/DH has no VIT-bridge type for " +
          "abap_journal mode=undo to resolve it through either way. Reverse by hand with another " +
          'mode="update" call carrying the old definition.'
        : "Not journalled (no journal was open).",
    ].filter((n) => n !== ""),
    maxChars,
  });
}

/**
 * `TABL/DI` (secondary index) create, through the `DD_INDEX_INTERFACE`
 * classrun bridge (`src/adt/index-create.ts`). A sibling of
 * {@link abapCreateViaBridge}, but never folded into it — see
 * `abapBridgeCrud`'s doc comment for why a third type can't join that
 * function's `vitType` ternary.
 *
 * Every field with no meaning on an index create is refused zero-network,
 * mirroring `abapCreateViaBridge`'s own refusals. Exactly one network read
 * follows: `resolveIndexOwner` (`src/adt/index-create.ts`) — an index has no
 * package of its own to be asked for, it inherits its base table's, so the
 * table is read once and a caller-supplied `package` is only ever checked
 * for AGREEMENT against that answer, never trusted or substituted (the same
 * reasoning `abapDeleteViaBridge`'s own package read above uses, applied
 * here to a create rather than a delete).
 *
 * No `journal` parameter: `src/adt/undo.ts`'s `vitTypeFor()` has no case for
 * TABL/DI and throws SAFETY_DENIED "INTERNAL INVARIANT VIOLATED" for a type
 * it does not recognise, so accepting one here would let a later
 * `abap_journal mode=undo` hit that invariant instead of a clean refusal.
 * Reversal is `abap_write { mode: "delete", type: "TABL/DI" }`, never undo.
 *
 * There is no ADT resource of any kind to read an index back from through
 * REST (this type's REGISTRY entry, `src/adt/capabilities.ts`, has no route
 * at all), so this never calls `verifyObjectCreated` or `verifyViaVitBridge`.
 * Instead, `createSecondaryIndex` (`src/adt/index-create.ts`) re-reads DD12V
 * and DD17S directly through `verifySecondaryIndex` after the bridge
 * returns, and `verified` here carries that verdict's own `verified` flag —
 * a real boolean, not a constant. `INDEX-ACTIVE`/`INDEX-FIELDS` in the
 * transcript remain the generated bridge fragment's own post-`COMMIT WORK`
 * `SELECT COUNT( * )` on DD12V/DD17S inside the same classrun execution, but
 * they are no longer the only evidence: the catalog re-read is a second,
 * independent confirmation, and `createSecondaryIndex` itself throws (via
 * `assertCreateVerdictAgrees`) if that re-read disagrees with the bridge's
 * claim of success.
 */
async function abapCreateIndexViaBridge(
  conn: AbapConnection,
  target: WriteTarget,
  input: WriteInput,
  maxChars: number,
  gate: SafetyGate,
  transport?: SessionTransport,
): Promise<BuiltResponse> {
  const type = "TABL/DI";
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
  if (input.include !== undefined) {
    bad(`\`include\` is a CLAS/OC field; a ${label} (${type}) has no class includes.`);
  }
  if (input.expect_etag !== undefined) {
    bad(`\`expect_etag\` does not apply to a ${label} create — there is no prior version to compare.`);
  }
  if (
    input.software_component !== undefined ||
    input.package_type !== undefined ||
    input.transport_layer !== undefined
  ) {
    bad("`software_component`, `package_type` and `transport_layer` are DEVC/K fields only.");
  }
  if (input.program !== undefined) bad("`program` is a TRAN/T field; an index does not start a program.");
  if (input.view_fields !== undefined) {
    bad("`view_fields` is a VIEW/DV field; an index projects nothing of its own — use `index_fields`.");
  }
  if (input.activate === false) {
    bad(
      "A secondary index cannot be created without activating it: DD_INDEX_INTERFACE runs with " +
        "ACTIVATE = 'X'. Omit `activate`.",
    );
  }
  if (!input.base_table?.trim()) {
    bad(
      `\`base_table\` is required to create a ${label} (${type}): the existing table the index is ` +
        "built over, e.g. ZMCP_CARRIER.",
    );
  }
  if (!input.index_fields || input.index_fields.length === 0) {
    bad(
      `\`index_fields\` is required to create a ${label} (${type}): the base-table fields the index ` +
        'covers, in order, e.g. ["CARRIER_ID"]. There is no "all fields" default.',
    );
  }
  // `bad()` always throws, but TS's never-return narrowing doesn't follow a call
  // through a local `const` arrow function (same cast a few lines down for TRAN/T's `program`).
  const baseTable = (input.base_table as string).trim();
  // Issue #209: an absent description defaults to `<table> index <id>` rather than
  // being refused.
  const descriptionDefaulted = !input.description?.trim();
  const description = input.description?.trim() || `${baseTable} index ${target.name}`;
  const indexFields = input.index_fields as string[];

  // The one network read this function makes — see this function's doc comment.
  const owner = await resolveIndexOwner(conn, baseTable);
  const requestedPackage = target.packageName?.trim().toUpperCase();
  if (requestedPackage && requestedPackage !== owner.packageName.name) {
    throw new AbapError(
      "BAD_INPUT",
      `Base table ${baseTable} is in package ${owner.packageName.name}, but the request asked for ` +
        `${requestedPackage}. abapsmith does not move objects between packages, and will not create ` +
        "an index in a package other than its base table's.",
      { object: target.name, type, baseTable, serverPackage: owner.packageName.name, requestedPackage },
      "Drop the `package` argument to create the index where its base table actually lives, or " +
        "correct it if this named the wrong table.",
    );
  }

  const named = normalizeCorrNr(input.corr_nr);
  // Zero-network package/corr_nr pairing check against the SERVER-resolved
  // package, same discipline as VIEW/DV's `assertClassicViewCreateTarget` call
  // in `abapCreateViaBridge` above. A transportable package with NO corr_nr is
  // resolved by `resolveBridgeCreateCorr` (issue #141) rather than refused;
  // `createSecondaryIndex`'s own `validate()` still refuses an unresolved one
  // as defence in depth, not the only enforcement point.
  if (named !== undefined || isLocalPackageName(owner.packageName.name)) {
    assertSecondaryIndexTarget(owner.packageName.name, named);
  }
  const { corrNr, corrSource, transportInfo } = await resolveBridgeCreateCorr(
    conn,
    gate,
    transport,
    {
      name: indexGateName(baseTable, target.name),
      type,
      uri: vitBridgeUri("tabldi", `${baseTable}-${target.name}`),
      packageName: owner.packageName.name,
    },
    named,
  );

  const created = await createSecondaryIndex(conn, gate, {
    indexName: target.name,
    baseTable,
    fields: indexFields,
    description,
    packageName: owner.packageName,
    ...(corrNr !== undefined ? { corrNr } : {}),
    ...(corrSource !== undefined ? { corrSource } : {}),
    unique: input.index_unique,
  });

  const detail =
    `secondary index over ${indexFields.length} field(s) of ${baseTable}` +
    (input.index_unique ? ", unique" : "");

  // Neither DD_INDEX_INTERFACE's transcript nor its verified-present check names which
  // request CTS actually recorded the index under — read it back the same way the
  // VIEW/DV and TRAN/T bridge creates do (see abapCreateViaBridge).
  let readback: TrReadback | undefined;
  if (transportInfo?.corrNr !== undefined) {
    readback = await readBackTransportEntry(conn, {
      intended: transportInfo.corrNr,
      entry: { pgmid: "LIMU", type: "INDX", name: `${baseTable} ${target.name}` },
      covering: { pgmid: "R3TR", type: "TABL", name: baseTable },
      lookup: { uri: `/sap/bc/adt/ddic/tables/${baseTable.toLowerCase()}`, devclass: owner.packageName.name },
    });
  }
  const headerTransportInfo = bridgeTransportHeaderInfo(transportInfo, readback);

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      object: `${type} ${target.name}`,
      package: owner.packageName.name,
      ...(headerTransportInfo !== undefined ? { transport: transportHeaderText(headerTransportInfo) } : {}),
      mode: "create-bridge",
      created: true,
      verified: created.verdict.verified,
      index_present: created.verdict.present,
      index_active: created.verdict.active,
      detail,
      bridge_class: CLASSIC_BODY_CLASS,
      markers: created.transcript.tags.join(" "),
      journal: "off (never journalled — see notes)",
    },
    notes: [
      `Created by running the classic fluid tool's body class ${CLASSIC_BODY_CLASS}, not over ` +
        `ADT REST: ${cap?.bridgeCreate?.via ?? "see src/adt/index-create.ts"}`,
      cap?.bridgeCreate?.limits ?? "",
      descriptionDefaulted ? `description defaulted to "${description}" (none was given).` : "",
      ...bridgeTransportNotes(transportInfo, transport, gate, readback),
      created.verdict.verified
        ? `Independently verified with a fresh DD12V/DD17S catalog read after the bridge returned: ` +
          `${created.verdict.statement}`
        : `NOT independently verified: the post-create catalog re-read did not run (${created.verdict.reason ?? "reason unknown"}). ` +
          "abapsmith reports created:true based only on the bridge's own transcript (the INDEX-ACTIVE " +
          "and INDEX-FIELDS markers above, from its post-COMMIT WORK SELECT COUNT( * ) on DD12V and " +
          "DD17S inside that same classrun execution) — that is all that is known here.",
      `To read the index back independently at any time: abap_read {"object":"${baseTable}/${target.name}",` +
        `"type":"TABL/DI"}.`,
      "NOT journalled: an index create has no undo path (src/adt/undo.ts recognises no TABL/DI " +
        "shape and would throw on one). To reverse this, delete the index with a fresh " +
        'abap_write { mode: "delete", type: "TABL/DI" } call, not abap_journal mode=undo.',
    ].filter((n) => n !== ""),
    maxChars,
  });
}

/**
 * `TABL/DI` (secondary index) delete. Sibling of {@link abapDeleteViaBridge}
 * above, never folded into it for the same reasons
 * {@link abapCreateIndexViaBridge}'s doc comment gives.
 *
 * `base_table` is REQUIRED here, unlike `abapDeleteViaBridge`'s VIEW/DV and
 * TRAN/T deletes, which blanket-refuse it: an index has no identity apart
 * from its base table — `DD_INDEX_INTERFACE`'s `ACTION = 'D'` call needs both
 * together, and `resolveIndexOwner` needs it to find the owning package.
 *
 * `corr_nr` is deliberately NOT blanket-refused, a divergence from VIEW/DV's
 * and TRAN/T's deletes above (neither of their delete bridges takes a
 * transport parameter at all): `DD_INDEX_INTERFACE`'s `ACTION = 'D'` call
 * DOES take one, so a transportable package's index delete needs one —
 * governed by `assertSecondaryIndexTarget` against the server-resolved
 * package, the same as the create side.
 *
 * Same "never trust the caller's `package`" rule as `abapDeleteViaBridge`:
 * `resolveIndexOwner` reads the base table's real package once, and a
 * caller-supplied `package` is only ever checked for agreement.
 *
 * There is no ADT resource to read an index back from through REST, so this
 * never calls `verifyObjectDeleted` — see {@link abapCreateIndexViaBridge}'s
 * doc comment. Instead, `deleteSecondaryIndexViaBridge`
 * (`src/adt/index-create.ts`) re-reads DD12V/DD17S directly through
 * `verifySecondaryIndex` after the bridge returns, and `verified` here
 * carries that verdict's own `verified` flag. Unlike the create side, a
 * verdict disagreement on delete is never thrown from
 * `deleteSecondaryIndexViaBridge` — it is only carried out as `verdict` for
 * this function to report, since a delete that the bridge reports as done
 * but the catalog still shows present is still better surfaced as a
 * (loudly caveated) response than as a thrown error after the DDIC change
 * may already have happened.
 */
async function abapDeleteIndexViaBridge(
  conn: AbapConnection,
  target: WriteTarget,
  input: WriteInput,
  maxChars: number,
  gate: SafetyGate,
  transport?: SessionTransport,
): Promise<BuiltResponse> {
  const type = "TABL/DI";
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
  if (input.view_fields !== undefined) bad("`view_fields` is a VIEW/DV create field; an index delete needs none.");
  if (input.program !== undefined) bad("`program` is a TRAN/T create field; an index delete needs no program.");
  if (
    input.software_component !== undefined ||
    input.package_type !== undefined ||
    input.transport_layer !== undefined
  ) {
    bad("`software_component`, `package_type` and `transport_layer` are DEVC/K create fields only.");
  }
  if (input.index_fields !== undefined) {
    bad("`index_fields` is a create-only field; a delete removes the index as it already stands.");
  }
  if (input.index_unique !== undefined) {
    bad("`index_unique` is a create-only field; a delete removes the index as it already stands.");
  }
  if (!input.base_table?.trim()) {
    bad(
      `\`base_table\` is required to delete a ${label} (${type}): DD_INDEX_INTERFACE deletes an ` +
        "index by base table and index name together, and abapsmith needs it to find the owning " +
        "package too.",
    );
  }
  // `bad()` always throws, but TS's never-return narrowing doesn't follow a call
  // through a local `const` arrow function (same cast a few lines down for TRAN/T's `program`).
  const baseTable = (input.base_table as string).trim();

  // Same reasoning as abapCreateIndexViaBridge above: an index has no
  // package of its own, it inherits the base table's — one network read,
  // never the caller's `package` trusted or substituted.
  const owner = await resolveIndexOwner(conn, baseTable);
  const requestedPackage = target.packageName?.trim().toUpperCase();
  if (requestedPackage && requestedPackage !== owner.packageName.name) {
    throw new AbapError(
      "BAD_INPUT",
      `Base table ${baseTable} is in package ${owner.packageName.name}, but the request asked for ` +
        `${requestedPackage}. abapsmith does not move objects between packages, and will not ` +
        "delete against the wrong one.",
      { object: target.name, type, baseTable, serverPackage: owner.packageName.name, requestedPackage },
      "Drop the `package` argument to delete the index where its base table actually lives, or " +
        "correct it if this named the wrong table.",
    );
  }

  const named = normalizeCorrNr(input.corr_nr);
  // Divergence from abapDeleteViaBridge's blanket corr_nr refusal — see this
  // function's doc comment: DD_INDEX_INTERFACE's ACTION='D' call DOES take a
  // transport parameter, so a transportable package's index delete needs one.
  // Resolved the same way as the create (issue #141) when none is named.
  if (named !== undefined || isLocalPackageName(owner.packageName.name)) {
    assertSecondaryIndexTarget(owner.packageName.name, named);
  }
  const { corrNr, corrSource, transportInfo } = await resolveBridgeCreateCorr(
    conn,
    gate,
    transport,
    {
      name: indexGateName(baseTable, target.name),
      type,
      uri: vitBridgeUri("tabldi", `${baseTable}-${target.name}`),
      packageName: owner.packageName.name,
      op: "delete",
    },
    named,
  );

  const deleted = await deleteSecondaryIndexViaBridge(conn, gate, {
    indexName: target.name,
    baseTable,
    packageName: owner.packageName,
    ...(corrNr !== undefined ? { corrNr } : {}),
    ...(corrSource !== undefined ? { corrSource } : {}),
  });

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      object: `${type} ${target.name}`,
      package: owner.packageName.name,
      ...(transportInfo !== undefined ? { transport: transportHeaderText(transportInfo) } : {}),
      mode: "delete-bridge",
      deleted: true,
      verified: deleted.verdict.verified,
      index_present: deleted.verdict.present,
      index_active: deleted.verdict.active,
      bridge_class: CLASSIC_BODY_CLASS,
      // `callerVisibleIndexTags`, not the raw `transcript.tags`: an
      // `ACTFAILED`-named tag can appear here even on a delete that fully
      // succeeded (see that function's doc comment) — `verified`/
      // `index_present`/`index_active` above already carry the fact a
      // caller should act on, so the raw flag is filtered out of this
      // field rather than left to read as an unexplained failure marker.
      markers: callerVisibleIndexTags(deleted.transcript.tags).join(" "),
      journal: "off (not journalled — see notes)",
    },
    notes: [
      `Deleted by running the classic fluid tool's body class ${CLASSIC_BODY_CLASS}, not over ` +
        `ADT REST — ${type} has no writable ADT collection at all (see this type's REGISTRY entry ` +
        "in src/adt/capabilities.ts).",
      deleted.verdict.verified
        ? `Independently verified with a fresh DD12V/DD17S catalog read after the bridge returned: ` +
          `${deleted.verdict.statement}`
        : `NOT independently verified: the post-delete catalog re-read did not run (${deleted.verdict.reason ?? "reason unknown"}). ` +
          "abapsmith reports deleted:true based only on the bridge's own transcript (the INDEX-GONE " +
          "marker above, from its post-COMMIT WORK SELECT COUNT( * ) on DD12V and DD17S inside that " +
          "same classrun execution) — that is all that is known here.",
      `To confirm independently at any time: abap_read {"object":"${baseTable}/${target.name}",` +
        `"type":"TABL/DI"} — it should now report the index absent.`,
      "NOT journalled: a bridge delete captures no before-image, so abap_journal mode=undo cannot " +
        "restore this index. To bring it back, create it again with a fresh abap_write call.",
    ],
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
  /**
   * Optional best-effort enqueue lookup used to name a lock holder on a
   * LOCKED refusal. Absent = no lookup, refusal unchanged.
   */
  readonly lockHolders?: LockHolderLookup;
  /** Warning sink for a failed best-effort holder lookup. Defaults to stderr. */
  readonly warn?: (message: string) => void;
}

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
        "VIEW/DV create resolves its own corr_nr for a transportable package (supply one to pin it), " +
        "none for a $ one; the view itself can't be read back via abap_read. " +
        "corr_nr resolution order: server pin > corr_nr/config pin > request this session created " +
        "(abap_transport create counts) > older abapsmith-described request only when the session has " +
        "none > create one; bridge creates (VIEW/DV, TRAN/T, TABL/DI) read back which request holds the object. " +
        "DEVC/K delete only if empty. " +
        "dry_run previews the diff and expect_etag without writing anything.",
      inputSchema: writeInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      // Resolved inside the try, at the point the single-object path knows
      // its target; read back in the catch to drive the best-effort holder
      // lookup on a LOCKED refusal. Stays `undefined` for the batch
      // (`objects`) path — there is no one object name a batch LOCKED
      // refusal could be attributed to.
      let lockedObject: string | undefined;
      try {
        const a = args as {
          object?: string;
          type?: string;
          package?: string;
          mode?: string;
          affects?: EnhancedObjectRef;
          base_table?: string;
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
        lockedObject = object;

        // BEFORE ensureConnected(): a denied write must never reach the wire.
        // `base_table`: only meaningful for `type: "TABL/DI"` — see
        // `preflight`'s own doc comment for why it needs it there.
        const pf = preflight({ object, type: a.type, package: a.package, base_table: a.base_table });
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
        const res = await deps.pool.withWrite("abap_write", writeGateKey(object, a.type, a.base_table), (conn) =>
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
        // Safe here specifically because `pool.withWrite`'s lease has
        // already been released by the time this catch runs (the write
        // above either returned or threw past it) — the read this lookup
        // performs cannot deadlock against the write that just failed.
        return deps.errorResult(await enrichLockedError(e, lockedObject, "abap_write", deps.lockHolders, deps.warn));
      }
    },
  );
}
