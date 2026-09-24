/**
 * Search help (SHLP) create and delete through the classrun bridge.
 */
import type { AbapConnection } from "../adt/connection.js";
import { capabilitiesFor } from "../adt/capabilities.js";
import { type DdicTranscript } from "../adt/ddic-bridge.js";
import { CLASSIC_BODY_CLASS } from "../adt/fluid/builtin/classic.js";
import { AbapError } from "../adt/errors.js";
import type { RunResult } from "../adt/run.js";
import { isLocalPackageName } from "../adt/transports.js";
import { assertSearchHelpTarget, createSearchHelp, type SearchHelpParams } from "../adt/shlp-create.js";
import { deleteSearchHelpViaBridge } from "../adt/shlp-delete.js";
import { vitBridgeUri } from "../adt/write-verify.js";
import type { WriteTarget } from "../adt/write.js";
import { buildResponse, type BuiltResponse } from "../compact.js";
import type { BeforeImageCapture, Journal } from "../journal.js";
import { journalRef, systemKey, withJournalledMutation } from "../journal.js";
import { normalizeCorrNr, type SafetyGate } from "../safety.js";
import type { SessionTransport } from "../adt/session-transport.js";
import { bridgeDeleteTransportEntryNote, transportHeaderText } from "./write-notes.js";
import type { WriteInput } from "./write-schema.js";
import {
  bridgePreflightCorr,
  bridgeTransportNotes,
  probeSearchHelp,
  probeSearchHelpAnyState,
  resolveBridgeCreateCorr,
  resolveShlpPackage,
} from "./write-bridge-common.js";

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
export async function abapCreateSearchHelpViaBridge(
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
export async function abapDeleteSearchHelpViaBridge(
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
