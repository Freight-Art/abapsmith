/**
 * The bridge CRUD dispatcher for object types ADT cannot create/delete
 * (routes to the per-type bridge modules), plus generic create/delete via
 * the classrun bridge for the remaining bridge-only types (VIEW/DV, TRAN/T).
 */
import type { AbapConnection } from "../adt/connection.js";
import { capabilitiesFor } from "../adt/capabilities.js";
import { CLASSIC_BODY_CLASS } from "../adt/fluid/builtin/classic.js";
import { type DdicTranscript } from "../adt/ddic-bridge.js";
import type { RunResult } from "../adt/run.js";
import { serverPackage } from "../adt/resolved-package.js";
import { isLocalPackageName } from "../adt/transports.js";
import {
  assertTransactionCreateTarget,
  assertTransactionKindParams,
  createTransaction,
  type TransactionParams,
} from "../adt/tran-create.js";
import { deleteTransactionViaBridge, verifyTransactionDeleted } from "../adt/tran-delete.js";
import { lookupTransaction } from "../adt/ui-tstc.js";
import { assertClassicViewCreateTarget, classicViewUri, createClassicView } from "../adt/view-create.js";
import { deleteClassicViewViaBridge } from "../adt/view-delete.js";
import {
  verifyObjectCreated,
  verifyObjectDeleted,
  verifyViaVitBridge,
  vitBridgeUri,
  VIT_STUB_ACCEPT,
} from "../adt/write-verify.js";
import { AbapError } from "../adt/errors.js";
import { resolveWriteTarget } from "../adt/write.js";
import type { TransportInfo, WriteTarget } from "../adt/write.js";
import { buildResponse, type BuiltResponse } from "../compact.js";
import type { BeforeImageCapture, Journal } from "../journal.js";
import { normalizeCorrNr, type SafetyGate } from "../safety.js";
import type { SessionTransport } from "../adt/session-transport.js";
import { readBackTransportEntry, type TrReadback } from "../adt/transport-readback.js";
import type { WriteInput } from "./write-schema.js";
import { bridgeDeleteTransportEntryNote, transportHeaderText } from "./write-notes.js";
import {
  bridgeCreateRegistration,
  bridgePreflightCorr,
  bridgeReversalNote,
  bridgeTransportHeaderInfo,
  bridgeTransportNotes,
  journalBridgeCreate,
  resolveBridgeCreateCorr,
  type BridgeRegistration,
} from "./write-bridge-common.js";
import { abapCreateIndexViaBridge, abapDeleteIndexViaBridge } from "./write-bridge-index.js";
import { abapUpdateViaBridge } from "./write-bridge-update.js";
import { abapCreateSearchHelpViaBridge, abapDeleteSearchHelpViaBridge } from "./write-bridge-shlp.js";

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
export async function abapBridgeCrud(
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
