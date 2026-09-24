/**
 * In-place update of bridge-only object types (classic view, transaction,
 * search help) through the classrun bridge.
 */
import type { AbapConnection } from "../adt/connection.js";
import { capabilitiesFor } from "../adt/capabilities.js";
import { type DdicTranscript } from "../adt/ddic-bridge.js";
import { CLASSIC_BODY_CLASS } from "../adt/fluid/builtin/classic.js";
import { AbapError } from "../adt/errors.js";
import type { RunResult } from "../adt/run.js";
import { isLocalPackageName } from "../adt/transports.js";
import { readClassicView, readTransaction } from "../adt/catalog-read.js";
import { updateClassicView } from "../adt/view-update.js";
import { updateTransaction } from "../adt/tran-update.js";
import { updateSearchHelp, type SearchHelpParams } from "../adt/shlp-create.js";
import { vitBridgeUri } from "../adt/write-verify.js";
import { resolveWriteTarget } from "../adt/write.js";
import type { WriteTarget } from "../adt/write.js";
import { buildResponse, type BuiltResponse } from "../compact.js";
import type { Journal } from "../journal.js";
import { journalRef, systemKey, withJournalledMutation } from "../journal.js";
import { normalizeCorrNr, type SafetyGate } from "../safety.js";
import type { WriteInput } from "./write-schema.js";
import {
  catalogProbe,
  probeSearchHelp,
  resolveBridgeUpdateTarget,
  resolveShlpPackage,
} from "./write-bridge-common.js";

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

export function isBridgeUpdateType(type: string): boolean {
  return BRIDGE_UPDATE_TYPES.includes(type);
}

/**
 * The one "no update route" refusal both call sites above throw for a type outside
 * {@link BRIDGE_UPDATE_TYPES} — built in one place so a caller sees a single wording,
 * never two variants depending on which of the two gates happened to catch it.
 */
export function bridgeUpdateNotSupported(type: string, objectName: string): AbapError {
  return new AbapError(
    "BAD_INPUT",
    `${type || "This type"} has no update route: mode="update" is only wired for VIEW/DV, TRAN/T ` +
      "and SHLP/DH.",
    { object: objectName, type, mode: "update" },
    'Use mode="write" to create, or (for most other types) an ordinary abap_write with `source`/' +
      '`edit` to change an existing object\'s definition in place.',
  );
}

export async function abapUpdateViaBridge(
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
