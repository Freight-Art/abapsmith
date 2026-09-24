/**
 * Secondary index (TABL/DI) create and delete through the classrun bridge.
 */
import type { AbapConnection } from "../adt/connection.js";
import { CLASSIC_BODY_CLASS } from "../adt/fluid/builtin/classic.js";
import { AbapError } from "../adt/errors.js";
import {
  assertSecondaryIndexTarget,
  callerVisibleIndexTags,
  createSecondaryIndex,
  deleteSecondaryIndexViaBridge,
  indexGateName,
  resolveIndexOwner,
} from "../adt/index-create.js";
import { capabilitiesFor } from "../adt/capabilities.js";
import type { SessionTransport } from "../adt/session-transport.js";
import { readBackTransportEntry, type TrReadback } from "../adt/transport-readback.js";
import { isLocalPackageName } from "../adt/transports.js";
import { vitBridgeUri } from "../adt/write-verify.js";
import type { WriteTarget } from "../adt/write.js";
import { buildResponse, type BuiltResponse } from "../compact.js";
import { normalizeCorrNr, type SafetyGate } from "../safety.js";
import type { WriteInput } from "./write-schema.js";
import { transportHeaderText } from "./write-notes.js";
import { bridgeTransportHeaderInfo, bridgeTransportNotes, resolveBridgeCreateCorr } from "./write-bridge-common.js";

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
export async function abapCreateIndexViaBridge(
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
export async function abapDeleteIndexViaBridge(
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
