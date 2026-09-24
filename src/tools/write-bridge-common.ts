/**
 * Shared helpers for the classrun-bridge write paths: transport request
 * resolution and notes, bridge-create journalling and reversal notes,
 * catalog probes, search-help package resolution, and bridge update-target
 * resolution.
 */
import { readSearchHelp } from "../adt/catalog-read.js";
import type { AbapConnection } from "../adt/connection.js";
import type { DdicRender } from "../adt/ddic.js";
import { AbapError, isAbapError } from "../adt/errors.js";
import { serverPackage, type ServerPackage } from "../adt/resolved-package.js";
import type { SessionTransport } from "../adt/session-transport.js";
import { entryLabel, type TrReadback } from "../adt/transport-readback.js";
import { isLocalPackageName } from "../adt/transports.js";
import { preflightPackageCorr, resolveWriteTarget } from "../adt/write.js";
import type { PreflightTarget, TransportInfo } from "../adt/write.js";
import { verifyViaVitBridge, type VerifyOutcome } from "../adt/write-verify.js";
import type { BeforeImageCapture, Journal } from "../journal.js";
import { journalRef, systemKey, withJournalledMutation } from "../journal.js";
import type { SafetyCorr, SafetyGate } from "../safety.js";
import { releaseClause, transportNote } from "./write-notes.js";

/**
 * Transport for a classic-bridge create or index delete (`VIEW/DV`, `TRAN/T`,
 * `SHLP/DH`, `TABL/DI`) — the one place the four bridge routes decide their
 * `corr_nr`, so they cannot drift apart again (issue #141: only VIEW/DV had
 * the auto route; the other three demanded a named request that the gate
 * then refused under `ABAP_ALLOW_TRANSPORTS=auto`, a dead end).
 *
 * - A local (`$`) package: no transport. The zero-network pairing check the
 *   caller already ran proved `named` is undefined here.
 * - A transportable package: `preflightPackageCorr` (src/adt/write.ts) —
 *   gate verdict first at zero wire cost, then the session resolver, which
 *   under `auto` reuses a modifiable request this session created for the
 *   package or creates one, and under a pinned/wildcard list honours the
 *   named or configured request. The resolved number comes back with its
 *   `corrSource` (what the bridge's own gate call must report) and a
 *   `TransportInfo` for the response header, so every bridge create names
 *   the request it wrote under.
 *
 * `uri` is synthesized — none of these objects exists yet — and only reaches
 * the wire as `<REF>` if a new request is created, exactly as a DEVC/K
 * create's own not-yet-existing URI does.
 */
export async function resolveBridgeCreateCorr(
  conn: AbapConnection,
  gate: SafetyGate,
  transport: SessionTransport | undefined,
  t: { name: string; type: string; uri: string; packageName: string; op?: "write" | "delete" },
  named: string | undefined,
): Promise<{ corrNr?: string; corrSource?: "named" | "auto"; transportInfo?: TransportInfo }> {
  if (isLocalPackageName(t.packageName)) {
    return named === undefined ? {} : { corrNr: named };
  }
  if (transport === undefined) {
    // No session resolver wired (the historical, $TMP-only harness shape). A
    // caller-NAMED request still goes the way it always did — judged by the gate
    // here at zero wire cost and again by the bridge module's own gate call — but
    // an OMITTED one cannot be resolved by anybody, and that is an internal wiring
    // failure, not a caller mistake: every other transportable mutation reaches
    // here with a transport manager already resolved (same shape as
    // abapCreatePackage's bridge route).
    if (named !== undefined) {
      gate.assert(
        t.op ?? "write",
        { name: t.name, type: t.type, packageName: t.packageName, exists: t.op === "delete" },
        { corr: { kind: "transport", corrNr: named, source: "named" }, intent: undefined },
      );
      return {
        corrNr: named,
        corrSource: "named",
        transportInfo: { status: "transport", required: true, corrNr: named },
      };
    }
    throw new AbapError(
      "TRANSPORT_ERROR",
      `${t.name} needs a transport request (package ${t.packageName} is not local), but no ` +
        "transport manager is wired into this call. This is an internal wiring failure in " +
        "abapsmith, not a mistake in the request.",
      { name: t.name, type: t.type, packageName: t.packageName },
    );
  }
  const preflightTarget: PreflightTarget = {
    uri: t.uri,
    name: t.name,
    type: t.type,
    packageName: t.packageName,
    exists: t.op === "delete",
  };
  const corr = await preflightPackageCorr(conn, preflightTarget, {
    transport,
    gate,
    ...(named !== undefined ? { corrNr: named } : {}),
    ...(t.op !== undefined ? { op: t.op } : {}),
  });
  return {
    corrNr: corr.corrNr,
    corrSource: corr.source,
    transportInfo: { status: "transport", required: true, corrNr: corr.corrNr },
  };
}

/**
 * The `SafetyCorr` a zero-network gate preflight reports for a bridge create
 * before any request is resolved: the caller-named request as `"named"`, or
 * `unresolved` when the session resolver has yet to pick one. Under
 * `ABAP_ALLOW_TRANSPORTS=auto` a named request is refused right here, before
 * a single wire request, and the refusal carries the rule's own hint.
 */
export function bridgePreflightCorr(named: string | undefined): SafetyCorr {
  return named === undefined
    ? { kind: "unresolved" }
    : { kind: "transport", corrNr: named, source: "named" };
}

/**
 * Response notes for a bridge write's transport: the standard `transportNote`,
 * plus the resolver's own account of HOW it chose the request (created,
 * adopted, cached) when that decision is the one this write used — the same
 * attribution guard the ADT write path applies, so an unrelated
 * `lastAutoDecision` is never pinned on this write.
 *
 * `readback`, when given, is what `readBackTransportEntry` found after the
 * write — none of these types have an ADT lock response naming the request
 * CTS actually recorded the object in:
 *  - `confirmed-same`: the sent request lists the entry; `transportNote`'s
 *    "did NOT re-read" sentence is replaced with what the re-read found.
 *  - `confirmed-other`: a DIFFERENT request already held the object's lock
 *    and CTS recorded it there instead — `transportNote`'s "that is the
 *    number this write sent" framing would be false, so this note is built
 *    separately, naming both requests.
 *  - `unknown`: the re-read itself failed or was inconclusive — reported,
 *    not silently dropped.
 */
export function bridgeTransportNotes(
  transportInfo: TransportInfo | undefined,
  transport: SessionTransport | undefined,
  gate: SafetyGate,
  readback?: TrReadback,
): string[] {
  if (transportInfo === undefined) return [];
  const abapMode = gate.config?.abapMode;
  const decision = transport?.lastAutoDecision;
  const notes: string[] = [];

  if (readback === undefined || readback.status === "confirmed-same" || readback.status === "unknown") {
    const reRead =
      readback === undefined
        ? undefined
        : readback.status === "confirmed-same"
          ? `Read back after the write: request ${readback.trkorr} lists ${entryLabel(readback.matched)}.`
          : `Could not confirm from CTS which request holds ${entryLabel(readback.entry)} (${readback.reason}); ` +
            `${transportInfo.corrNr ?? "the transport"} is the number this write sent.`;
    notes.push(transportNote(transportInfo, abapMode, reRead));
    if (
      decision !== undefined &&
      transportInfo.corrNr !== undefined &&
      decision.trkorr.toUpperCase() === transportInfo.corrNr.toUpperCase()
    ) {
      notes.push(decision.reason);
    }
    return notes;
  }

  // confirmed-other
  const { trkorr, intended, matched } = readback;
  notes.push(
    `Recorded in ${trkorr} (holds the ${matched.pgmid} ${matched.type} lock for ${matched.name}), not in ` +
      `the session's request ${intended}. This write sent ${intended}; CTS recorded the object in the ` +
      `request that already holds its lock. ${releaseClause(abapMode)}`,
  );
  if (decision !== undefined && decision.trkorr.toUpperCase() === intended.toUpperCase()) {
    notes.push(decision.reason);
  }
  return notes;
}

/**
 * The `TransportInfo` a bridge create's response header quotes. A
 * `confirmed-other` read-back means the sent request is NOT what CTS
 * recorded the object under, so the header names the holder instead —
 * otherwise the header is `transportInfo` unchanged.
 */
export function bridgeTransportHeaderInfo(
  transportInfo: TransportInfo | undefined,
  readback: TrReadback | undefined,
): TransportInfo | undefined {
  if (transportInfo === undefined || readback?.status !== "confirmed-other") return transportInfo;
  return { status: "transport", required: true, corrNr: readback.trkorr, corrText: readback.holder.description };
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
export async function journalBridgeCreate<T>(
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
export type BridgeRegistration =
  | { readonly state: "registered"; readonly packageName: string }
  | { readonly state: "unregistered" }
  | { readonly state: "unknown" };

export function bridgeCreateRegistration(outcome: VerifyOutcome): BridgeRegistration {
  if (outcome.status === "confirmed" && outcome.packageName !== undefined) {
    return { state: "registered", packageName: outcome.packageName };
  }
  if (outcome.status === "confirmed" && outcome.via === "vit-bridge") return { state: "unregistered" };
  return { state: "unknown" };
}

/** The create response's closing note on whether undo/delete can reverse this — three-way on {@link BridgeRegistration}, never the old blanket "it works" claim. */
export function bridgeReversalNote(
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

/**
 * Runs a catalog read (`src/adt/catalog-read.ts`), returning `undefined` for a
 * "not found" `AbapError` rather than throwing — the SHLP/DH (and, inside
 * {@link abapUpdateViaBridge}, VIEW/DV and TRAN/T) analogue of
 * `verifyViaVitBridge`'s `confirmed-absent`, for the one type with no VIT bridge to
 * ask instead. Any OTHER `AbapError` (a connection failure, a malformed query) is
 * rethrown rather than swallowed into a false absence.
 */
export async function catalogProbe<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (e) {
    if (isAbapError(e) && e.code === "NOT_FOUND") return undefined;
    throw e;
  }
}

/** {@link catalogProbe} over `readSearchHelp` — used by SHLP/DH's create, delete and update. */
export async function probeSearchHelp(conn: AbapConnection, name: string): Promise<DdicRender | undefined> {
  return catalogProbe(() => readSearchHelp(conn, name));
}

/**
 * {@link catalogProbe} over `readSearchHelp` with `includeInactive: true` — the
 * DELETE-only sibling of {@link probeSearchHelp} above. A search help left behind by a
 * create that PUT but never activated has a DD30L row with `AS4LOCAL='N'` (inactive)
 * and no active row at all; `probeSearchHelp`'s active-only read sees that as absent
 * and would refuse the delete with NOT_FOUND even though `delete_search_help`
 * (`src/adt/shlp-delete.ts`'s bridge) happily removes both DDIC states and the TADIR
 * entry. `abapDeleteSearchHelpViaBridge` is the ONLY caller: the create path's
 * "already exists" probe and the update path's existence probe both keep using
 * `probeSearchHelp` above, deliberately unchanged — an inactive leftover should still
 * block a create (the name is taken) and an update has its own definition to replace,
 * not delete. When the result resolves, check `meta.versionState` ("active" or
 * "inactive") to tell which case was hit.
 */
export async function probeSearchHelpAnyState(conn: AbapConnection, name: string): Promise<DdicRender | undefined> {
  return catalogProbe(() => readSearchHelp(conn, name, undefined, { includeInactive: true }));
}

/**
 * Resolves a caller-named package string for a SHLP/DH create/update/delete into a
 * {@link ServerPackage} — the branded type every search-help mutation site
 * (`src/adt/shlp-create.ts`, `src/adt/shlp-delete.ts`) requires and cannot verify
 * itself.
 *
 * A materially weaker guarantee than {@link resolveBridgeUpdateTarget}'s (VIEW/DV,
 * TRAN/T): there is no VIT-bridge object type for a search help (ADT 404s on it, and
 * there is no VIT stub either — see `src/adt/capabilities.ts`), and `readSearchHelp`'s
 * catalog query (`src/adt/catalog-read.ts`) surfaces no TADIR/package column at all —
 * unlike `readClassicView`'s, which does. So this can only ever confirm the NAMED
 * package is a REAL package on the system (a DEVC/K read, for a transportable name) or
 * trust a local (`$`-prefixed) name zero-network — it can never confirm an EXISTING
 * search help's ACTUAL current package the way the VIEW/DV/TRAN/T helper below can. A
 * caller could in principle name a real but wrong package for an update or delete and
 * this has no way to catch that; {@link abapDeleteSearchHelpViaBridge} and
 * {@link abapUpdateViaBridge}'s SHLP/DH branch both call this out in their own response
 * notes rather than claim the same guarantee the other two types get.
 */
export async function resolveShlpPackage(conn: AbapConnection, packageNameStr: string): Promise<ServerPackage> {
  const trimmed = packageNameStr.trim().toUpperCase();
  const mint = (uri: string): ServerPackage => {
    const resolved = serverPackage({ status: "confirmed", uri, via: "repository-search", packageName: trimmed });
    if (resolved === undefined) {
      // Unreachable: `trimmed` is non-empty by construction below (the default is
      // "$TMP", never ""), so `serverPackage` always mints a value here.
      throw new AbapError(
        "SAFETY_DENIED",
        `abapsmith could not resolve package ${trimmed} for this search help — this should be ` +
          "unreachable.",
        { reason: "PACKAGE_UNKNOWN", packageName: trimmed },
      );
    }
    return resolved;
  };
  if (isLocalPackageName(trimmed)) {
    // Local packages are never asked for on the server for any other bridge type
    // either (VIEW/DV's and TRAN/T's create default to "$TMP" the same zero-network
    // way) — a $-prefixed name is trusted to exist without a read.
    return mint(`urn:abapsmith:local-package:${trimmed}`);
  }
  const pkgTarget = await resolveWriteTarget(conn, { type: "DEVC/K", name: trimmed });
  if (!pkgTarget.exists) {
    throw new AbapError(
      "NOT_FOUND",
      `Package ${trimmed} does not exist on ${conn.cfg.sid}, so a search help cannot be placed in it.`,
      { packageName: trimmed },
      'Create the package first with abap_write (type="DEVC/K"), or correct the `package` argument ' +
        "if this was a typo.",
    );
  }
  return mint(pkgTarget.uri);
}

/**
 * Resolves an EXISTING VIEW/DV or TRAN/T's real current package through the VIT
 * bridge, for {@link abapUpdateViaBridge} — a deliberate duplicate of
 * {@link abapDeleteViaBridge}'s own anti-bypass package-resolution block above, not an
 * extraction shared with it: reusing that already-correct, test-covered delete path
 * as a shared helper would risk a regression there for the sake of an update path
 * that did not exist when it was written. Same reasoning as that block: neither
 * bridge can look its own object's package up, so a caller-supplied `package` is only
 * ever checked for AGREEMENT, never trusted or substituted.
 */
export async function resolveBridgeUpdateTarget(
  conn: AbapConnection,
  vitType: string,
  name: string,
  type: string,
  label: string,
  requestedPackage: string | undefined,
): Promise<ServerPackage> {
  const found = await verifyViaVitBridge(conn, vitType, name, type);
  if (found.status === "confirmed-absent") {
    throw new AbapError(
      "NOT_FOUND",
      `${label} ${name} does not exist, so there is nothing to update.`,
      { object: name, type, uri: found.uri },
    );
  }
  if (found.status === "indeterminate") {
    throw new AbapError(
      "SAFETY_DENIED",
      `abapsmith could not confirm ${label} ${name}'s existence or its package before an update, ` +
        `so it refuses the operation (${found.reason})`,
      { reason: "PACKAGE_UNKNOWN", object: name, type, uri: found.uri, cause: found.reason },
      "Every update is judged against the object's real package. Rather than guess, abapsmith " +
        "stops here. Check the object exists and this connection can read it, then retry.",
      { retryable: true }, // existence could not be confirmed, not denied — a healthy connection resolves it
    );
  }
  const resolved = serverPackage(found);
  if (resolved === undefined) {
    throw new AbapError(
      "SAFETY_DENIED",
      `abapsmith could not determine which package ${label} ${name} belongs to, so it refuses the ` +
        "update: the VIT bridge read answered but carried no <adtcore:packageRef> element.",
      { reason: "PACKAGE_UNKNOWN", object: name, type, uri: found.uri },
      "Every update is judged against the object's real package. Rather than assume the caller's " +
        "`package` argument, abapsmith stops here. This matches the known orphan outcome: the " +
        "object is active but unregistered in TADIR, so no package can be established for it. " +
        "Removing/reregistering it needs SE11/SE14 by hand.",
    );
  }
  const requested = requestedPackage?.trim().toUpperCase();
  if (requested && requested !== resolved.name) {
    throw new AbapError(
      "BAD_INPUT",
      `${label} ${name} is in package ${resolved.name}, but the request asked for ${requested}. ` +
        "abapsmith does not move objects between packages, and will not update against the wrong one.",
      { object: name, type, serverPackage: resolved.name, requestedPackage: requested },
      "Drop the `package` argument to update the object where it actually is, or correct it if this " +
        "named the wrong object.",
    );
  }
  return resolved;
}
