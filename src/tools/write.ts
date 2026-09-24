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
import { abapCreateIndexViaBridge, abapDeleteIndexViaBridge } from "./write-bridge-index.js";
import { abapUpdateViaBridge, bridgeUpdateNotSupported, isBridgeUpdateType } from "./write-bridge-update.js";
import { abapCreateSearchHelpViaBridge, abapDeleteSearchHelpViaBridge } from "./write-bridge-shlp.js";
import { abapBridgeCrud } from "./write-bridge.js";

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
