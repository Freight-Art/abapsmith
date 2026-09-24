/**
 * Package (DEVC/K) creation for `abap_write` — a separate path from the
 * ordinary object write lifecycle (no source, no check, no activation):
 * REST for a LOCAL software component, the classrun bridge otherwise.
 */
import type { AbapConnection } from "../adt/connection.js";
import { createPackageViaBridge, tdevcDiscrepancies } from "../adt/package-create.js";
import type { PreflightTarget, TransportInfo } from "../adt/write.js";
import { CLASSIC_BODY_CLASS } from "../adt/fluid/builtin/classic.js";
import { verifyViaRepositorySearch } from "../adt/write-verify.js";
import { AbapError } from "../adt/errors.js";
import {
  authorizeMutation,
  createPackage,
  PACKAGE_SOFTWARE_COMPONENT_HINT,
  preflightPackageCorr,
} from "../adt/write.js";
import type {
  BeforeImage,
  TransportOptions,
  WriteTarget,
} from "../adt/write.js";
import { buildResponse, type BuiltResponse } from "../compact.js";
import type { SafetyGate } from "../safety.js";
import type { Journal } from "../journal.js";
import { journalRef, systemKey, withJournalledMutation } from "../journal.js";
import { captureOf, transportHeaderText, transportNote } from "./write-notes.js";
import { WriteInput } from "./write-schema.js";

/**
 * `DEVC/K` create branch, reached only from the routing check above `abapWrite`'s
 * `source` guard. Mirrors the write path's shape but calls `createPackage`
 * (src/adt/write.ts) instead of `writeObject`: a package has no source, so there's
 * no check, activation, or `checkSource`/`activateObject`/`assertNoErrors` call.
 */
export async function abapCreatePackage(
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
