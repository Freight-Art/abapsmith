/**
 * Response-text helpers for `abap_write`: transport/corr_nr notes, journal
 * and delete notes, verification wording, and shrink/discard disclosures —
 * plus the journal before-image capture mapping and the `ok` result builder.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DiscardedValue } from "../adt/descriptor-fidelity.js";
import type { SecondaryIndexInfo } from "../adt/index-read.js";
import type { VerifyOutcome } from "../adt/write-verify.js";
import type { BeforeImage, TransportInfo } from "../adt/write.js";
import type { BeforeImageCapture } from "../journal.js";

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
/**
 * The "abap_write never releases a transport" clause `transportNote` and
 * `bridgeTransportNotes`' confirmed-other note both end on. `admin` is the
 * REQUIRED mode for release, not the current one — do not interpolate
 * `abapMode` into it. Mirrors the identical note in src/tools/activate.ts.
 */
export function releaseClause(abapMode?: string): string {
  return (
    "abap_write never releases a transport — releasing is a separate tool, " +
    "abap_transport_release, which stays off unless " +
    (abapMode !== undefined
      ? "ABAP_MODE=admin (ABAP_ALLOW_TRANSPORT_RELEASE is not read while ABAP_MODE is set)."
      : "ABAP_ALLOW_TRANSPORT_RELEASE is set.")
  );
}

export function transportNote(t: TransportInfo, abapMode?: string, reRead?: string): string {
  switch (t.status) {
    case "local":
      return "Local object ($TMP-style): the lock reported no transport, so there is nothing to release.";
    case "transport":
      return (
        `Transport ${t.corrNr ?? "(unassigned)"}${t.corrText ? ` — ${t.corrText}` : ""}. ` +
        "That is the number this write sent, after the safety gate approved it; the text is as " +
        "the lock response reported it. " +
        (reRead ?? "abapsmith did NOT re-read the request to confirm the object is in it.") +
        " " +
        releaseClause(abapMode)
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
 * Replaces `transportNote` for a delete whose lock named a DIFFERENT request
 * than the one this DELETE sent — `transportNote`'s "that is the number this
 * write sent, after the safety gate approved it" clause is false in that
 * case: the number the gate approved was NOT the number CTS recorded the
 * deletion on, and this note says so instead of repeating the false claim.
 */
export function corrNrNotHonouredNote(sent: string, recorded: string, type: string, name: string): string {
  return (
    `corr_nr ${sent} was not used: ${type} ${name} was locked by transport request ${recorded}, ` +
    `and CTS recorded the deletion there. ${sent} is the number this DELETE sent on the wire; SAP ` +
    "records a change on the request that already holds the object, and a second request cannot " +
    "take it over. abapsmith did NOT re-read either request to confirm what is in it. To get the " +
    `entry off ${recorded}, use abap_transport operation removeObject (ABAP_MODE=admin).`
  );
}

/**
 * Replaces `transportNote` for a WRITE whose caller named one `corr_nr` while
 * CTS already had the object in another. `transportNote`'s "that is the
 * number this write sent, after the safety gate approved it" is true of
 * `used` but would let the caller believe their own number was honoured, so
 * this says both numbers instead. Unlike a delete, the write is NOT refused:
 * the object can only be recorded in the request that already holds it, and
 * the PUT succeeded there.
 */
export function corrNrOverriddenWriteNote(named: string, used: string, type: string, name: string): string {
  return (
    `corr_nr ${named} was overridden: ${type} ${name} is already recorded in transport request ` +
    `${used}, so CTS records this change there and that is the number this write sent on the ` +
    `wire — the safety gate judged ${used}, not ${named}. The write itself was NOT refused; a ` +
    "transportable object can only be recorded in the request that already holds it. abapsmith " +
    "did NOT re-read either request to confirm what is in it. To move the object off " +
    `${used}, use abap_transport operation removeObject (ABAP_MODE=admin) first, then retry. ` +
    "(A mode=delete in this situation IS refused — a delete's request cannot be redirected at all.)"
  );
}

/**
 * Short form of `TransportInfo` for the response header (`transportNote`
 * above carries the full explanation in `notes`). Same three-way switch on
 * `status` as `transportNote`.
 */
export function transportHeaderText(t: TransportInfo): string {
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
export function captureOf(img: BeforeImage): BeforeImageCapture {
  if (!img.existed) return "confirmed-absent";
  // Dead today — writeObject/deleteObject hardcode sourceReadable: true
  // (src/adt/write.ts) — kept as a guard for if that ever stops being true.
  if (!img.sourceReadable) return "failed";
  return img.source !== undefined ? "captured" : "failed";
}

/**
 * `captureOf`, narrowed for a class SUB-INCLUDE write (`img.include` set).
 * Written out explicitly rather than trusted to fall out of `captureOf`
 * above: a sub-include's `existed` is only ever `false` on a confirmed 404
 * of ITS OWN document (see `BeforeImage.absenceConfirmed` and
 * `writeObject`'s `emitBeforeImage`), so "confirmed-absent" here is always
 * real evidence, never `captureOf`'s generic (and here unreachable) "no read
 * ever ran" fallback. Scoped to the sub-include case only — every other
 * write path keeps using `captureOf` unchanged.
 */
export function includeCaptureOf(img: BeforeImage): BeforeImageCapture {
  if (img.source !== undefined) return "captured";
  return img.absenceConfirmed ? "confirmed-absent" : "failed";
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
export function deleteJournalNote(
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
 * Issue #86: a `TABL/DT` delete's response note naming the secondary
 * indexes that went with it. `indexes`/`readFailure` come from a catalog
 * read taken BEFORE the delete ran (see `abapWrite`'s delete branch) — by
 * the time this note is built the table (and, with it, its DD12V/DD17S
 * rows) may already be gone, so there is no "read after" to fall back to
 * here; whatever was captured beforehand is all there will ever be.
 */
export function tableDeleteIndexNote(
  tableName: string,
  indexes: readonly SecondaryIndexInfo[] | undefined,
  readFailure: string | undefined,
): string {
  if (indexes === undefined) {
    return (
      `This table's secondary indexes could not be listed before the delete (${readFailure}) — ` +
      "whether it had any, and what they covered, is UNKNOWN here, not confirmed as none."
    );
  }
  if (indexes.length === 0) {
    return `${tableName} had no secondary index (DD12V read before the delete returned zero rows).`;
  }
  const list = indexes
    .map((i) => `${i.id} (${i.fields.length ? i.fields.join(", ") : "no fields on record"})`)
    .join("; ");
  return (
    `${tableName} had ${indexes.length} secondary index${indexes.length === 1 ? "" : "es"}, defined over ` +
    `its fields, and ${indexes.length === 1 ? "it goes" : "they go"} with the table: ${list}.`
  );
}

/**
 * Renders a {@link VerifyOutcome} for a human sentence — the uri, plus
 * whichever of `via`/`reason` the outcome actually carries (mutually
 * exclusive on the type). Shared by the single-object delete's CHECK_FAILED
 * message and the batch delete path's per-entry error, so the two describe
 * the same contradiction the same way.
 */
export function describeVerification(v: VerifyOutcome): string {
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
export function deleteNotConfirmedSentence(type: string, name: string, verification: VerifyOutcome): string {
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
export function packageDeleteTransportNote(corrNr: string): string {
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
export function bridgeDeleteTransportEntryNote(label: string, name: string, packageName: string): string {
  return (
    `${label} ${name} was in transportable package ${packageName}, but this delete recorded nothing ` +
    "in CTS — the bridge passes no request and issues no RS_CORR_INSERT. Any entry it already had " +
    'on a transport request survives it; remove it with `abap_transport` operation: "removeObject" ' +
    "(transport, object, confirm), which needs ABAP_MODE=admin."
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
export function describeShrink(
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

/**
 * Leaf elements whose text the server keeps only when the root carries
 * `adtcore:masterLanguage`: DTEL field labels (`dtel:shortFieldLabel` …
 * `dtel:headingFieldLabel`) and DOMA fixed-value texts (`doma:text`). Both
 * were reproduced live on A4H — the document is accepted, the texts come back
 * empty, nothing warns (2026-09-16 for DTEL/DE ZAS_DTEL_TEST; the DOMA case is
 * what `assertDomaMasterLanguage` refuses up front).
 */
const LANGUAGE_DEPENDENT_TEXT_RE = /^(?:[\w.-]+:)?(?:\w+FieldLabel|text)$/;

/**
 * When EVERY dropped element is a language-dependent text, the cause is known
 * and the fix is one attribute — say so instead of the generic "rework the
 * payload". Returns `undefined` for any other mix, so the caller keeps the
 * generic hint.
 */
export function languageDependentDiscardHint(discarded: readonly DiscardedValue[], source: string): string | undefined {
  if (discarded.length === 0 || !discarded.every((d) => LANGUAGE_DEPENDENT_TEXT_RE.test(d.element))) return undefined;
  const rootTag = /<[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?\b[^>]*>/.exec(source.replace(/<\?xml[^>]*\?>/, ""))?.[0] ?? "";
  const hasMasterLanguage = /\badtcore:masterLanguage\s*=/.test(rootTag);
  const what = discarded.map((d) => d.element).join(", ");
  return (
    `The dropped element(s) — ${what} — are language-dependent texts (field labels / fixed-value ` +
    "texts), which ADT stores only when the root element carries adtcore:masterLanguage; " +
    (hasMasterLanguage
      ? "this document already has it, so something else emptied them — "
      : 'this document has none. Add adtcore:masterLanguage="EN" (and adtcore:language="EN") to the ' +
        "root element and send the same document again — rewriting the object in place repairs it, " +
        "which is exactly what fixed the live reproduction. ") +
    "Re-read the object with abap_read to see the descriptor the server actually holds, or activate " +
    "it as written with abap_activate."
  );
}

/** One `DiscardedValue` as `element (sent "a", "b", server now holds "c")`. */
export function describeDiscard(d: DiscardedValue): string {
  const sentText = d.sent.map((v) => JSON.stringify(v)).join(", ");
  const storedText = d.stored.length ? d.stored.map((v) => JSON.stringify(v)).join(", ") : "nothing";
  return `${d.element} (sent ${sentText}, server now holds ${storedText})`;
}

export const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });
