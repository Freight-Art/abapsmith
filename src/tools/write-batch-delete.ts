/**
 * `abap_write mode=delete` with `objects[]`: batch delete. Each entry gets
 * its own journalled entry and a fresh session between deletes — see
 * {@link abapWriteBatchDelete}'s own doc comment for the two-pass contract.
 */
import type { AbapConnection } from "../adt/connection.js";
import { isBridgeOnlyCreateType } from "../adt/capabilities.js";
import { CLASSIC_BODY_CLASS } from "../adt/fluid/builtin/classic.js";
import { serverPackage, type ServerPackage } from "../adt/resolved-package.js";
import { deleteTransactionViaBridge, verifyTransactionDeleted } from "../adt/tran-delete.js";
import { lookupTransaction } from "../adt/ui-tstc.js";
import { verifyViaVitBridge } from "../adt/write-verify.js";
import { AbapError, isAbapError } from "../adt/errors.js";
import { parseObjectRef } from "../adt/resolve.js";
import type { SessionTransport } from "../adt/session-transport.js";
import { readBackTransportEntry } from "../adt/transport-readback.js";
import { specForKeyword, specForType } from "../adt/types.js";
import {
  assertNoDuplicateDeleteTargets,
  authorizeMutation,
  deleteObject,
  isPackageType,
  MAX_DELETE_BATCH,
} from "../adt/write.js";
import type {
  BeforeImage,
  EnhancedObjectRef,
  ResolvedTarget,
  TransportInfo,
} from "../adt/write.js";
import { buildResponse, type BuiltResponse } from "../compact.js";
import type { Journal } from "../journal.js";
import { journalRef, systemKey, withJournalledMutation } from "../journal.js";
import {
  type AuthorizedTarget,
  type MutatingOperation,
  type SafetyGate,
} from "../safety.js";
import { captureOf, deleteNotConfirmedSentence } from "./write-notes.js";
import { resolveBridgeCreateCorr } from "./write-bridge-common.js";

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
