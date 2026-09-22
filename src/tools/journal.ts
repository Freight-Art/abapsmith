/**
 * `abap_journal` — undo/audit trail for writes made through this codebase.
 * Four modes: `list`, `show` (with before-image), `undo` (revert),
 * `reconcile` (close a stranded `pending` entry with a stated outcome).
 *
 * `list`/`show`/`reconcile` are pure local operations — zero network calls,
 * work with the ABAP system unreachable; `reconcile` writes only to the
 * local journal file, never to SAP. `undo` is a write and is gated like one.
 *
 * The tool description below is deliberately verbose (drift rule, force
 * flag) — see the git history.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AbapConnection } from "../adt/connection.js";
import { AbapError } from "../adt/errors.js";
import { renderMessages } from "../adt/activate.js";
import {
  classIncludeActionBlocker,
  deleteEvidenceBlocker,
  enhancementUndoBlocked,
  packageRecreateBlocker,
  performUndo,
  planUndo,
  plannedAction,
} from "../adt/undo.js";
import { specFromUri } from "../adt/types.js";
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import { buildResponse, sliceLines, type BuiltResponse } from "../compact.js";
import { diffSources, renderHunks } from "../diff.js";
import { STALE_PENDING_MS, type Journal, type JournalEntry, type JournalImagePart } from "../journal.js";
import { textTable } from "../compact.js";
import type { SafetyGate } from "../safety.js";

export const journalInputSchema = {
  mode: z
    .enum(["list", "show", "undo", "reconcile"])
    .optional()
    .describe(
      "list (default): recent writes. show: one entry incl. its before-image. undo: revert one " +
        "entry. reconcile: close a stranded pending entry with an outcome you establish and a " +
        "stated reason.",
    ),
  entry: z
    .string()
    .optional()
    .describe("Journal entry id from mode=list. Required for show and undo unless `object` is given."),
  detail: z
    .enum(["summary", "full"])
    .optional()
    .describe(
      'show only. "summary" (default): header plus a unified diff of before-image → after-image, ' +
        'capped at about 2,000 characters. "full": the complete before-image (and after-image ' +
        "when one was recorded), as before.",
    ),
  object: z
    .string()
    .optional()
    .describe("Filter by object name; for undo, targets that object's most recent undoable entry."),
  limit: z.number().min(1).max(999_999).optional().describe("mode=list: entries to return. Default 20."),
  session: z
    .string()
    .optional()
    .describe(
      "mode=list: filter to one session's entries. \"current\" resolves to this running " +
        "server's own session id (see the echoed `session` in the response header).",
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      "mode=undo: proceed even though the object changed on the server after abapsmith wrote it. " +
        "This OVERWRITES whatever that other change was. Read the object first.",
    ),
  activate: z.boolean().optional().describe("mode=undo: re-activate after restoring. Default true."),
  outcome: z
    .enum(["succeeded", "failed"])
    .optional()
    .describe(
      "mode=reconcile: the outcome you are asserting for a `pending` entry. Required. " +
        "`pending` is the state being left, so it is not offered.",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "mode=reconcile: how you established that outcome. Required, recorded verbatim on the " +
        "entry, and the only evidence it will ever carry for the asserted outcome.",
    ),
};

export const JournalInput = z.object(journalInputSchema);
export type JournalInput = z.infer<typeof JournalInput>;

/** mode=show, detail="summary": cap on the rendered diff text, in characters. */
export const SHOW_DIFF_MAX_CHARS = 2_000;

const shortId = (id: string) => id;

function row(e: JournalEntry): Record<string, string> {
  const flags = [e.undoneBy ? "undone" : e.undoOf ? "is-undo" : undefined, e.reconciled ? "reconciled" : undefined]
    .filter(Boolean)
    .join(" ");
  return {
    id: shortId(e.id),
    when: e.ts.replace("T", " ").replace(/\.\d+Z$/, "Z"),
    op: e.operation,
    object: `${e.object.type} ${e.object.name}`,
    existed: e.existedBefore ? "yes" : "no",
    // undo only ever deletes when beforeCapture is "confirmed-absent".
    capture: e.beforeCapture,
    outcome: e.outcome,
    actor: e.actor ?? "",
    flags,
  };
}

const LIST_COLUMNS = ["id", "when", "op", "object", "existed", "capture", "outcome", "flags"];
/** `actor` spliced in before `flags` — only shown when the page has one to show. */
const LIST_COLUMNS_WITH_ACTOR = LIST_COLUMNS.flatMap((c) => (c === "flags" ? ["actor", "flags"] : c));

/**
 * Which class sub-include a `sourceUri` names, or `undefined` for a main
 * source / non-class document. Structural (via `specFromUri`), matching
 * `entryClassInclude`/`classIncludeFromSourceUri` in adt/undo.ts — this file
 * must not grow its own regex for the same fact.
 */
function includeFromSourceUri(uri: string | undefined): string | undefined {
  if (uri === undefined) return undefined;
  const inc = specFromUri(uri)?.include;
  return inc !== undefined && inc !== "main" ? inc : undefined;
}

/** Which class sub-include THIS entry's own `sourceUri` names, if any. */
function entrySubInclude(e: JournalEntry): string | undefined {
  return includeFromSourceUri(e.object.sourceUri);
}

/** One `entry.parts[]` element as a table row. Provenance is per-part, not inherited from the primary object. */
function partRow(p: JournalImagePart): Record<string, string> {
  return {
    object: `${p.object.type} ${p.object.name}`,
    package: p.object.package,
    // A class-delete's four parts are all the same object/type/package — without
    // naming the include, the ALSO TOUCHED rows are indistinguishable from each other.
    include: includeFromSourceUri(p.object.sourceUri) ?? "-",
    existed: p.existedBefore ? "yes" : "no",
    capture: p.beforeCapture,
    bytes: p.before?.bytes !== undefined ? String(p.before.bytes) : "-",
  };
}

const PART_COLUMNS = ["object", "include", "existed", "capture", "bytes"];
/** `package` spliced in after `object` — only shown when at least one part carries one. */
const PART_COLUMNS_WITH_PACKAGE = PART_COLUMNS.flatMap((c) => (c === "object" ? ["object", "package"] : c));

/**
 * Journalled but not undoable, decided without a connection. Mirrors
 * `undoBlocker()` / `deleteEvidenceBlocker()` in adt/undo.ts for the *listing*
 * view only — the real check happens against live server state.
 */
function undoHint(e: JournalEntry): string {
  if (e.operation === "transport-release") {
    return "RELEASED TRANSPORT — refused: a released transport cannot be recalled; create a corrective transport instead";
  }
  if (e.operation === "service-publish") {
    return 'PUBLISHED SERVICE — refused: publishing changed the runtime surface, not the object source; call abap_service op="unpublish" confirm=<binding> instead';
  }
  if (e.operation === "service-unpublish") {
    return 'UNPUBLISHED SERVICE — refused: unpublishing changed the runtime surface, not the object source; call abap_service op="publish" confirm=<binding> instead';
  }
  if (e.operation.startsWith("transport-")) {
    return "refused: transport requests are not undone automatically; use abap_transport to reverse this manually";
  }
  if (e.operation === "activate") return "activation — nothing to reverse";
  if (e.undoneBy) return `already undone by ${e.undoneBy}`;
  // Must precede the branches below: undoBlocker() (adt/undo.ts) refuses
  // ENHO/ENHS entries unconditionally, even under force=true — this keeps
  // that refusal visible in the list view, not just in `show`.
  if (e.irreversible) {
    return "IRREVERSIBLE — refused: recorded for history only, no mechanism can undo it";
  }
  const action = plannedAction(e);
  if (action === "delete") {
    // Checked first: an include-scoped delete/recreate refusal
    // (classIncludeActionBlocker, adt/undo.ts) is unconditional and not
    // forceable, unlike deleteEvidenceBlocker below — promising a plain
    // DELETE here for an entry undo will actually refuse would be a lie.
    const includeRefusal = classIncludeActionBlocker(e, action);
    if (includeRefusal) return `undo would DELETE this object, and WILL BE REFUSED: ${includeRefusal}`;
    const refusal = deleteEvidenceBlocker(e);
    return refusal
      ? `undo would DELETE this object, and WILL BE REFUSED: ${refusal}`
      : "undo would DELETE this object (abapsmith created it, and confirmed it was absent first)";
  }
  if (action === "recreate") {
    const includeRefusal = classIncludeActionBlocker(e, action);
    if (includeRefusal) return `undo would RE-CREATE this object, and WILL BE REFUSED: ${includeRefusal}`;
    const refusal = packageRecreateBlocker(e);
    return refusal
      ? `undo would RE-CREATE this object, and WILL BE REFUSED: ${refusal}`
      : "undo would RE-CREATE this object from the before-image";
  }
  return "undo would restore the previous source";
}

/**
 * Class entries come in three shapes, and each needs a different warning:
 * an entry ABOUT one sub-include (this entry covers only that document, not
 * the class), a class-delete entry that recorded its sub-includes
 * (`entry.parts` — see `deleteObject`'s four extra GETs, adt/write.ts, and
 * FIX E4 in adt/undo.ts), and a class entry with none recorded (a class
 * UPDATE, or an old delete from before this fix landed).
 */
function classWarning(e: JournalEntry): string | undefined {
  const include = entrySubInclude(e);
  if (include) {
    return (
      `This entry is about class ${e.object.name}'s ${include} include ONLY, not the whole ` +
      "class: its main body and its other local includes are each tracked (when abapsmith " +
      "wrote them) by their own separate journal entries, and undoing THIS entry touches only " +
      "this one document."
    );
  }
  if (!/^CLAS/i.test(e.object.type)) return undefined;
  if (e.parts?.length) {
    const recorded = e.parts
      .filter((p) => p.beforeCapture === "captured" || p.beforeCapture === "confirmed-absent")
      .map((p) => includeFromSourceUri(p.object.sourceUri))
      .filter((i): i is string => i !== undefined);
    const unrecorded = e.parts
      .filter((p) => p.beforeCapture !== "captured" && p.beforeCapture !== "confirmed-absent")
      .map((p) => includeFromSourceUri(p.object.sourceUri))
      .filter((i): i is string => i !== undefined);
    return (
      `${e.object.name} is a CLASS. abapsmith recorded its main include` +
      (recorded.length ? ` plus its ${recorded.join(", ")} include(s)` : "") +
      " when it was deleted. Undoing that delete recreates every include recorded here, not " +
      "just the main body." +
      (unrecorded.length
        ? ` Its ${unrecorded.join(", ")} include(s) could NOT be recorded (the read at delete ` +
          "time failed) and will NOT come back — recreating anyway is refused unless you pass " +
          "force=true, and the result is reported PARTIAL."
        : "")
    );
  }
  return (
    `${e.object.name} is a CLASS and abapsmith records only its MAIN include. Its local ` +
    "definitions (CCDEF), local implementations (CCIMP), macros (CCMAC) and local test " +
    "classes (CCAU) are NOT in this journal entry: they are not restored by an undo and " +
    "changes to them are not detected as drift. Undoing a class DELETE therefore brings " +
    "back a class without its local helpers or its unit tests, and is refused unless you " +
    "pass force=true."
  );
}

function requireJournal(journal: Journal | undefined): Journal {
  if (!journal || !journal.enabled) {
    throw new AbapError(
      "UNSUPPORTED",
      "The write journal is disabled, so there is no history and no undo.",
      { enabled: false },
      "Unset ABAP_JOURNAL=off (or set ABAP_JOURNAL_DIR to a writable path) and restart the server. " +
        "Only writes made *after* the journal is on can be undone.",
    );
  }
  return journal;
}

/** Resolve which entry the caller means. Local only — no network. */
async function pickEntry(journal: Journal, input: JournalInput, mode: "show" | "undo"): Promise<JournalEntry> {
  if (input.entry) {
    const e = await journal.get(input.entry);
    if (!e) {
      throw new AbapError(
        "NOT_FOUND",
        `No journal entry ${input.entry}.`,
        { entry: input.entry },
        "Run abap_journal mode=list to see the ids that exist. Ids are dropped by the " +
          "retention policy, so an old one may simply have aged out.",
      );
    }
    return e;
  }
  if (!input.object) {
    throw new AbapError(
      "BAD_INPUT",
      `mode=${mode} needs \`entry\` (from mode=list) or \`object\`.`,
      {},
      "abap_journal mode=list shows the ids.",
    );
  }
  const candidates = await journal.list({ object: input.object, limit: 50 });
  // Skip transport entries — undoBlocker() refuses them all (transport-release
  // unconditionally), so object= undo must reach the object-level entry
  // underneath instead of failing on the first match.
  const usable = candidates.find(
    (e) => e.operation !== "activate" && !e.operation.startsWith("transport-") && !e.undoneBy,
  );
  if (!usable) {
    throw new AbapError(
      "NOT_FOUND",
      candidates.length
        ? `Every journalled change to ${input.object.toUpperCase()} has already been undone, ` +
          "or records only an activation."
        : `abapsmith has no journal entry for ${input.object.toUpperCase()} — it never wrote ` +
          "this object (or the entry aged out of the retention window).",
      { object: input.object, seen: candidates.length },
      // Never say "restored" for an object the journal never saw — fabrication.
      "Objects abapsmith did not write cannot be undone: there is no before-image to " +
        "restore and abapsmith will not reconstruct one. Use SAP's own version " +
        "management (SE38 → Utilities → Versions) for changes made outside this server.",
    );
  }
  return usable;
}

/** mode=show, detail="summary": cut rendered diff text to {@link SHOW_DIFF_MAX_CHARS}, at a line break. */
function truncateDiffText(text: string): string {
  if (text.length <= SHOW_DIFF_MAX_CHARS) return text;
  const window = text.slice(0, SHOW_DIFF_MAX_CHARS);
  const lastBreak = window.lastIndexOf("\n");
  const cut = lastBreak >= 0 ? window.slice(0, lastBreak) : window;
  return (
    `${cut}\n[diff truncated: ${cut.length} of ${text.length} characters shown; ` +
    'detail="full" returns the complete images]'
  );
}

export async function abapJournal(
  conn: AbapConnection,
  input: JournalInput,
  maxChars: number,
  journal?: Journal,
  gate?: SafetyGate,
): Promise<BuiltResponse> {
  const mode = input.mode ?? "list";
  const j = requireJournal(journal);

  // ------------------------------------------------------------- list ----
  if (mode === "list") {
    // "current" means THIS process's session — resolve it before the filter
    // runs, and fail loudly rather than silently falling back to "no filter"
    // if there is nothing to resolve it to yet (see `Journal.sessionId`).
    let sessionFilter = input.session;
    if (sessionFilter === "current") {
      sessionFilter = j.sessionId;
      if (!sessionFilter) {
        throw new AbapError(
          "BAD_INPUT",
          'session="current" was requested, but this server process has no session id yet.',
          {},
          "This can only happen before the MCP initialize handshake has completed. Retry once " +
            "the client is connected.",
        );
      }
    }
    const entries = await j.list({
      limit: input.limit ?? 20,
      ...(input.object ? { object: input.object } : {}),
      ...(sessionFilter ? { sessionId: sessionFilter } : {}),
    });
    // Checked across the WHOLE journal, not just this page — hiding a stranded
    // pending entry behind limit/object filter would make it invisible.
    const pendingAll = await j.listPending();
    const pendingStale = await j.listPending({ staleAfterMs: STALE_PENDING_MS });
    const staleIds = new Set(pendingStale.map((e) => e.id));
    const pendingFresh = pendingAll.filter((e) => !staleIds.has(e.id));

    const notes: string[] = [];
    if (pendingStale.length) {
      notes.push(
        `STRANDED: ${pendingStale.length} journal entr${pendingStale.length === 1 ? "y is" : "ies are"} ` +
          `still \`pending\` after more than ${Math.round(STALE_PENDING_MS / 60_000)} minutes — ` +
          `${pendingStale.map((e) => `${e.id} (${e.operation} ${e.object.name})`).join(", ")}. ` +
          "The before-image was written and the outcome never was, which is what a crash " +
          "mid-write looks like: nobody knows whether those writes landed. They are NOT " +
          "usable undos — abapsmith refuses to undo a pending entry, because it cannot tell " +
          "what to undo. Read each object (abap_read), compare it against " +
          "abap_journal mode=show, and resolve it deliberately. Once you have established " +
          "what actually happened to one of them, close it with abap_journal mode=reconcile " +
          'entry=<id> outcome=succeeded|failed reason="…" — that records your finding on the ' +
          "entry and deletes nothing. Entries whose live source settles the question can be " +
          "classified in bulk by bin/abap-journal-reconcile.",
      );
    }
    if (pendingFresh.length) {
      notes.push(
        `${pendingFresh.length} entr${pendingFresh.length === 1 ? "y" : "ies"} began less than ` +
          `${Math.round(STALE_PENDING_MS / 60_000)} minutes ago and ${pendingFresh.length === 1 ? "is" : "are"} ` +
          "still `pending` — most likely a write that is in flight right now. Re-run mode=list " +
          "in a moment; if it is still pending it is stranded, not in flight.",
      );
    }
    if (entries.some((e) => e.beforeCapture !== "captured" && e.beforeCapture !== "confirmed-absent")) {
      notes.push(
        "`capture` is how each entry established whether the object existed beforehand. " +
          "`captured` = the previous source was read; `confirmed-absent` = the object was " +
          "positively confirmed missing; `failed` = the read didn't establish absence; `unknown` = not " +
          "recorded. An undo that would DELETE is refused for anything but " +
          "`confirmed-absent`, and that refusal is not overridable.",
      );
    }
    notes.push(`Journal: ${j.dir} (retention: ${j.config.maxEntries} entries / ${j.config.maxAgeDays} days).`);
    return buildResponse({
      header: {
        system: conn.cfg.sid,
        mode: "list",
        entries: entries.length,
        filter: input.object?.toUpperCase(),
        session: sessionFilter,
      },
      body: entries.length
        ? textTable(entries.map(row), entries.some((e) => e.actor) ? LIST_COLUMNS_WITH_ACTOR : LIST_COLUMNS)
        : "(no journalled writes)",
      bodyLabel: "WRITES (newest first)",
      notes,
      hints: ["abap_journal mode=show entry=<id> for the recorded source images."],
      maxChars,
    });
  }

  // -------------------------------------------------------- reconcile ----
  // Deliberately BEFORE `pickEntry()` and never routed through it: reconcile
  // closes exactly the entry the caller names, never an `object` fallback —
  // guessing which stranded entry was meant and writing a false outcome into
  // the audit trail is worse than refusing. Every refusal below is decided
  // locally, so a bad call costs zero network requests, same as list/show.
  if (mode === "reconcile") {
    if (!input.entry) {
      throw new AbapError(
        "BAD_INPUT",
        "mode=reconcile needs `entry` — the id of the pending entry you are closing.",
        {},
        "abap_journal mode=list shows the ids, and names the stranded ones. There is no " +
          "`object` fallback here: closing the wrong entry writes a false outcome into the " +
          "audit trail, so reconcile insists on the exact id.",
      );
    }
    if (!input.outcome) {
      throw new AbapError(
        "BAD_INPUT",
        "mode=reconcile needs `outcome`: \"succeeded\" or \"failed\". `pending` is the state " +
          "being left, so it is not offered as something to arrive at.",
        { entry: input.entry },
        'Pass outcome: "succeeded" or "failed".',
      );
    }
    const reason = input.reason?.trim() ?? "";
    if (!reason) {
      throw new AbapError(
        "BAD_INPUT",
        "mode=reconcile needs a non-empty `reason`: abapsmith did not observe this entry's " +
          "outcome, so the reason is all a later reader will ever have as evidence for it.",
        { entry: input.entry },
        "Pass reason describing how the outcome was established.",
      );
    }
    const target = await j.get(input.entry);
    if (!target) {
      throw new AbapError(
        "NOT_FOUND",
        `No journal entry ${input.entry}.`,
        { entry: input.entry },
        "Run abap_journal mode=list to see the ids that exist. Ids are dropped by the " +
          "retention policy, so an old one may simply have aged out.",
      );
    }
    if (target.outcome !== "pending") {
      throw new AbapError(
        "BAD_INPUT",
        `${input.entry} already reads \`${target.outcome}\` — reconcile only closes an entry ` +
          "whose outcome was never recorded. Overwriting an observed outcome would destroy " +
          "the only observed fact this entry carries.",
        { entry: target.id, outcome: target.outcome },
        "Nothing to do here: the entry already has a real outcome.",
      );
    }

    const res = await j.reconcile(target.id, { outcome: input.outcome, reason });
    if (!res.reconciled) {
      if (res.reason === "disabled") {
        // Cannot normally happen: requireJournal() above already proved the
        // journal is enabled. Kept as a defensive branch, not a live path.
        throw new AbapError(
          "UNSUPPORTED",
          "The write journal is disabled, so there is nothing to reconcile.",
          { entry: target.id },
        );
      }
      if (res.reason === "unknown-entry") {
        throw new AbapError(
          "NOT_FOUND",
          `${target.id} aged out of the retention window between being read and being reconciled.`,
          { entry: target.id },
          "Run abap_journal mode=list to see what still exists.",
        );
      }
      if (res.reason === "already-settled") {
        throw new AbapError(
          "BAD_INPUT",
          `${target.id} settled for real (outcome=${res.entry?.outcome}) between being read and ` +
            "being reconciled — the observed outcome wins over the asserted one.",
          { entry: target.id, outcome: res.entry?.outcome },
          `Run abap_journal mode=show entry=${target.id} to see what it now says.`,
        );
      }
      throw new AbapError(
        "ADT_ERROR",
        `Could not write the reconciliation for ${target.id}: ${res.error}. Nothing was written — ` +
          `the entry still reads \`pending\`.`,
        { entry: target.id, error: res.error },
        "Retry mode=reconcile with the same outcome and reason.",
      );
    }

    const notes: string[] = [`Recorded reason: ${reason}`];
    notes.push(
      "This changed the LOCAL journal only — nothing was sent to the system, no SAP object " +
        "and no transport request was touched, and nothing was deleted: the before-image and " +
        "every earlier line for this entry are still on disk.",
    );
    notes.push(
      "The outcome is now recorded as an ASSERTION, not an observation: the entry carries " +
        "`reconciled` with the reason and (when known) who stated it, so a later reader can " +
        "tell it apart from an outcome abapsmith itself watched happen.",
    );
    if (res.entry.outcome === "succeeded") {
      notes.push(
        "The entry is now terminal, so mode=undo will no longer refuse it for being `pending` " +
          "— undo replays the before-image, so only assert `succeeded` when it is established " +
          "that the write landed.",
      );
    }

    return buildResponse({
      header: {
        system: conn.cfg.sid,
        mode: "reconcile",
        entry: res.entry.id,
        operation: res.entry.operation,
        object: `${res.entry.object.type} ${res.entry.object.name}`,
        was: "pending",
        outcome: res.entry.outcome,
        by: res.entry.reconciled?.by,
        at: res.entry.reconciled?.at,
      },
      notes,
      hints: [`abap_journal mode=show entry=${res.entry.id}`],
      maxChars,
    });
  }

  const entry = await pickEntry(j, input, mode);

  // ------------------------------------------------------------- show ----
  if (mode === "show") {
    const detail = input.detail ?? "summary";
    const before = await j.beforeImage(entry);
    const after = await j.afterImage(entry);
    const sections: Array<{ title: string; content: string }> = [];

    const beforeImagePlaceholder = entry.existedBefore
      ? entry.beforeCapture === "failed"
        ? "(none was ever captured — the entry says the object existed but its source " +
          "read never resolved, whether it didn't complete or came back inconclusive. " +
          "Not a retention problem; there is nothing to restore.)"
        : "(recorded, but the blob is gone — pruned or the journal dir was cleaned)"
      : "(none — the entry records that the object did not exist before this operation, " +
        `so undo would mean DELETE; provenance: beforeCapture="${entry.beforeCapture}")`;

    let diff: ReturnType<typeof diffSources> | undefined;
    let diffFullText: string | undefined;
    if (before !== undefined && after !== undefined) {
      diff = diffSources(before, after);
      diffFullText = diff.identical ? "(before-image and after-image are identical)" : renderHunks(diff.hunks);
    }

    if (detail === "full") {
      if (before !== undefined) {
        const win = sliceLines(before, 1);
        const label = entry.beforeKind === "package-metadata" ? "package metadata, " : "";
        sections.push({ title: `BEFORE-IMAGE (${label}${entry.before?.bytes ?? 0} bytes)`, content: win.text });
      } else {
        sections.push({ title: "BEFORE-IMAGE", content: beforeImagePlaceholder });
      }
      if (after !== undefined) {
        const win = sliceLines(after, 1);
        sections.push({ title: `AFTER-IMAGE (${entry.after?.bytes ?? 0} bytes)`, content: win.text });
      }
    } else if (before !== undefined && after !== undefined && diff && diffFullText !== undefined) {
      let text = truncateDiffText(diffFullText);
      if (diff.droppedHunks > 0) text += `\n[${diff.droppedHunks} more hunk(s) omitted]`;
      sections.push({ title: `DIFF (before → after, +${diff.added} −${diff.removed} lines)`, content: text });
    } else if (before !== undefined && after === undefined) {
      sections.push({
        title: "DIFF",
        content:
          `(no after-image was recorded for this entry — before-image is ${entry.before?.bytes ?? 0} ` +
          'bytes; detail="full" shows it)',
      });
    } else if (before === undefined && after !== undefined) {
      const d = diffSources("", after);
      const rendered = d.identical ? "(before-image and after-image are identical)" : renderHunks(d.hunks);
      let text = truncateDiffText(rendered);
      if (d.droppedHunks > 0) text += `\n[${d.droppedHunks} more hunk(s) omitted]`;
      sections.push({ title: `DIFF (object created, +${d.added} lines)`, content: text });
    } else {
      sections.push({ title: "DIFF", content: beforeImagePlaceholder });
    }

    if (entry.parts?.length) {
      const columns = entry.parts.some((p) => p.object.package) ? PART_COLUMNS_WITH_PACKAGE : PART_COLUMNS;
      sections.push({ title: `ALSO TOUCHED (${entry.parts.length})`, content: textTable(entry.parts.map(partRow), columns) });
    }

    const notes: string[] = [];
    if (detail === "summary") {
      notes.push('Summary view: detail="full" returns the complete before-image and after-image.');
    }
    if (entry.outcome === "pending") {
      notes.push(
        "THIS IS NOT A USABLE UNDO. The entry is still `pending`: abapsmith wrote the " +
          "before-image and then never recorded an outcome, so it does not know whether the " +
          "write reached the server at all. Undo refuses pending entries rather than guess " +
          "which state to put the object back into. Read the object (abap_read) and compare " +
          "it with the images above to find out what actually happened.",
      );
    }
    if (entry.reconciled) {
      notes.push(
        `This entry's outcome was RECONCILED BY HAND (at ${entry.reconciled.at}` +
          (entry.reconciled.by ? `, by ${entry.reconciled.by}` : "") +
          `), because: ${entry.reconciled.reason}. abapsmith did not observe that outcome; it ` +
          "is a stated finding, and the entry stayed `pending` until someone stated it.",
      );
    }
    notes.push(
      `Before-image provenance: beforeCapture="${entry.beforeCapture}" — ` +
        (entry.beforeCapture === "captured"
          ? entry.beforeKind === "package-metadata"
            ? "the captured image is the package's metadata document, not source — undo will not re-create the package."
            : "the previous source was read successfully."
          : entry.beforeCapture === "confirmed-absent"
            ? "the object was positively confirmed absent beforehand."
            : entry.beforeCapture === "failed"
              ? "the before-image probe never completed or came back inconclusive, so " +
                "`existedBefore` is a guess."
              : "not recorded (the entry predates provenance tracking), so `existedBefore` " +
                "is unverified."),
    );
    notes.push(undoHint(entry));
    const cls = classWarning(entry);
    if (cls) notes.push(cls);
    if (entry.irreversible) {
      notes.push(
        "IRREVERSIBLE: this entry can never be undone by any mechanism, not even force=true.",
      );
    }

    return buildResponse({
      header: {
        system: entry.system,
        systemKey: entry.systemKey,
        entry: entry.id,
        when: entry.ts,
        operation: entry.operation,
        object: `${entry.object.type} ${entry.object.name}`,
        // Present only for an entry ABOUT one class sub-include (not the
        // main body) — see `entrySubInclude`. Absent for every other entry,
        // including a class-delete entry whose `parts` recorded includes
        // alongside the main body (those are listed in ALSO TOUCHED below).
        include: entrySubInclude(entry),
        uri: entry.object.uri,
        package: entry.object.package,
        existedBefore: entry.existedBefore,
        beforeCapture: entry.beforeCapture,
        beforeKind: entry.beforeKind,
        outcome: entry.outcome,
        reconciled: entry.reconciled?.at,
        error: entry.error,
        detail,
        beforeBytes: entry.before?.bytes,
        afterBytes: entry.after?.bytes,
        ...(diff && diffFullText !== undefined
          ? {
              diffAdded: diff.added,
              diffRemoved: diff.removed,
              diffHunks: diff.totalHunks,
              diffChars: diffFullText.length,
            }
          : {}),
        beforeEtag: entry.before?.etag,
        beforeServerEtag: entry.before?.serverEtag,
        afterEtag: entry.after?.etag,
        activated: entry.activation?.activated,
        undoOf: entry.undoOf,
        undoneBy: entry.undoneBy,
        tool: entry.tool,
        actor: entry.actor,
        sessionId: entry.sessionId,
        sessionIdSource: entry.sessionIdSource,
        corrNr: entry.corrNr,
        irreversible: entry.irreversible || undefined,
      },
      sections,
      notes,
      hints: [`abap_journal mode=undo entry=${entry.id}`, `abap_journal mode=show entry=${entry.id} detail=full`],
      maxChars,
    });
  }

  // ------------------------------------------------------------- undo ----
  // `gate` is optional only because list/show must work without one; undo is
  // a write and must not silently degrade to an unenforced no-op — see
  // the git history.
  if (!gate) {
    throw new AbapError(
      "SAFETY_DENIED",
      "abap_journal mode=undo was called without a safety gate. An undo writes to " +
        "the system — for an undo of a create it deletes an object — so it cannot run " +
        "unchecked. Nothing was changed.",
      { entry: entry.id, object: entry.object.name, operation: entry.operation },
      "This is a wiring bug, not a user error: the caller must pass the SafetyGate " +
        "it enforces every other write with.",
    );
  }
  const res = await performUndo(conn, j, entry, {
    ...(input.force ? { force: true } : {}),
    ...(input.activate !== undefined ? { activate: input.activate } : {}),
    // A DEVC/K undo deletes through the classrun bridge, which gates itself.
    gate,
    // Re-authorise on the resolved object: only here is delete vs. write known.
    // gate.authorize both checks and mints the AuthorizedTarget proof that
    // writeObject/deleteObject require to run at all (Layer 2, src/mode.ts) —
    // pass the FULL target, not a name/type/packageName subset, since they
    // also need uri/sourceUri/spec.
    assertAllowed: (action, target) => gate.authorize(action === "delete" ? "delete" : "write", target),
  });

  const notes: string[] = [];
  // Advisory regardless of res.performed — a no-op plan still needs the
  // released-transport warning surfaced.
  if (res.plan.releasedTransportWarning) notes.push(res.plan.releasedTransportWarning);
  if (!res.performed) {
    // "Object already gone" is a SUCCESS, not a failure — say so explicitly,
    // or the caller goes looking for cleanup that isn't needed.
    notes.push(
      plannedAction(entry) === "delete"
        ? `DONE — nothing was sent. ${res.plan.drift.reason} No DELETE was issued: abapsmith ` +
            "does not send a destructive request that the observed state does not justify. " +
            "Nothing is left to clean up. The journal entry stays as it is, because no undo " +
            "was performed to record — running this again will simply say the same thing."
        : "Nothing was written: the server already matches the recorded before-image. " +
            res.plan.drift.reason,
    );
  }
  if (res.check && !res.check.ok) {
    // Advisory only — the restore already happened; don't let this read as "undo failed".
    notes.push(
      `The restored version has ${res.check.errors} syntax error(s) and ` +
        `${res.check.warnings} warning(s). The undo was performed anyway: getting back to a ` +
        "known state is the point, even when that state was broken. The object is saved" +
        (res.activation ? " but activation will have failed" : " and INACTIVE") +
        " — fix it forward from here.",
    );
  }
  if (res.performed && res.checkUnavailable) {
    // Silence about the syntax check must not read as "the check passed".
    notes.push(
      `No syntax check result: ${res.checkUnavailable}. The restore itself succeeded; ` +
        "run abap_check or abap_activate if you need to know whether what came back compiles.",
    );
  }
  if (res.performed && res.deleteUnverified) {
    // The undo's DELETE was sent and accepted, but abapsmith could not
    // confirm the object is actually gone — silence about that must not read
    // as confirmation either.
    notes.push(
      `${res.deleteUnverified} The undo itself succeeded (the DELETE was accepted); this is only ` +
        "about whether abapsmith can prove it.",
    );
  }
  if (res.forced && res.plan.drift.drifted) {
    notes.push(
      "force=true OVERRODE a drift refusal — a change made outside abapsmith has just " +
        "been overwritten. What was there is preserved as the before-image of journal " +
        (res.undoEntryId
          ? `entry ${res.undoEntryId}, so it can be put back.`
          : "— NOTHING: this undo was not journalled (see below), so the overwritten " +
            "version is GONE."),
    );
  }
  // E4: a partial undo must never read as a clean success.
  if (res.performed && res.partial) {
    notes.push(
      `PARTIAL — this object was NOT fully ${res.plan.action === "recreate" ? "recreated" : "restored"}. ` +
        `${res.partial.reason} Unrestored includes: ${res.partial.unrestored.join(", ")}. ` +
        (res.plan.action === "recreate"
          ? `${entry.object.name} is NOT the object that was deleted: what came back is its main ` +
            `include${res.restoredIncludes?.length ? ` plus its ${res.restoredIncludes.join(", ")} include(s)` : ""}, ` +
            `not the ${res.partial.unrestored.join(", ")} include(s) — those were never recorded ` +
            "and are not restored. Restore them from SAP's own version management (SE24 → " +
            "Utilities → Versions) before trusting it, and do not run its unit tests expecting " +
            "them to exist unless testclasses is among what came back."
          : "Drift in those includes was neither detected nor reverted."),
    );
  }
  // Independent of `res.partial`: a FULLY recorded class recreate (every
  // sub-include captured or confirmed-absent) never sets `plan.partial`, but
  // still has includes to report — say what came back so this doesn't read
  // as a plain main-source-only restore (the old, pre-fix behaviour).
  if (res.performed && res.restoredIncludes?.length) {
    notes.push(
      `Also restored: its ${res.restoredIncludes.join(", ")} include(s) — recorded alongside ` +
        "the main body when the class was deleted, written back and activated together with it.",
    );
  }
  if (res.performed && res.skippedIncludes?.length) {
    notes.push(
      `NOT restored: ${res.skippedIncludes.map((s) => `its ${s.include} include (${s.reason})`).join("; ")}.`,
    );
  }
  if (res.undoEntryId) {
    notes.push("The undo is itself journalled, so it can be undone.");
  } else {
    notes.push(
      "This undo was NOT journalled — the write journal is disabled, so no before-image " +
        "of what it overwrote exists and THIS UNDO CANNOT BE UNDONE. Whatever was on the " +
        "server a moment ago is only recoverable from SAP's own version management.",
    );
  }

  const body: string[] = [];
  if (res.activation) {
    const msgs = renderMessages(res.activation.messages, res.plan.restoreSource ?? "");
    if (msgs.trim()) body.push(`# ACTIVATION\n${msgs}`);
  }

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      mode: "undo",
      undid: entry.id,
      object: `${entry.object.type} ${entry.object.name}`,
      uri: res.plan.target.uri,
      action: res.plan.action,
      performed: res.performed,
      partial: res.partial ? `yes — ${res.partial.unrestored.join(", ")} NOT restored` : undefined,
      restoredIncludes: res.restoredIncludes?.length ? res.restoredIncludes.join(", ") : undefined,
      skippedIncludes: res.skippedIncludes?.length ? res.skippedIncludes.map((s) => s.include).join(", ") : undefined,
      forced: res.forced || undefined,
      driftDetected: res.plan.drift.drifted || undefined,
      newEntry: res.undoEntryId ?? (res.performed ? "NOT JOURNALLED" : undefined),
      activated: res.activation ? res.activation.activated : "n/a",
    },
    body: body.join("\n\n"),
    bodyLabel: "MESSAGES",
    notes,
    hints: [
      res.undoEntryId
        ? `abap_journal mode=undo entry=${res.undoEntryId} undoes this undo.`
        : "There is no entry id for this undo and no way to undo it — the journal is off.",
    ],
    maxChars,
  });
}

/**
 * Everything server.ts's safety pre-flight needs, decided from the local
 * journal alone (`undefined` for read-only modes). This is why a refused
 * undo makes zero network calls: name/type/package come from the journal
 * file, so the gate can refuse before `ensureConnected()` — a logon — runs.
 */
export async function undoPreflightTarget(
  journal: Journal | undefined,
  input: { mode?: string; entry?: string; object?: string },
): Promise<{ op: "write" | "delete"; name: string; packageName?: string; type?: string } | undefined> {
  if ((input.mode ?? "list") !== "undo") return undefined;
  if (!journal || !journal.enabled) return undefined;
  let entry: JournalEntry | undefined;
  if (input.entry) entry = await journal.get(input.entry);
  else if (input.object) {
    const list = await journal.list({ object: input.object, limit: 50 });
    entry = list.find((e) => e.operation !== "activate" && !e.undoneBy);
  }
  if (!entry) return undefined; // the tool body produces the precise error
  return {
    op: plannedAction(entry) === "delete" ? "delete" : "write",
    name: entry.object.name,
    packageName: entry.object.package,
    type: entry.object.type,
  };
}

export { planUndo };

export interface JournalToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars">;
  readonly journal: Journal;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/**
 * Registers `abap_journal` on the MCP server — history/undo for everything
 * abapsmith wrote. `list`/`show` are pure local reads; `reconcile` is a
 * write, but only to the local journal file, never to SAP (no network, no
 * gate). `undo` is the only mode that touches SAP, gated on the object the
 * journal already knows locally.
 */
export function registerJournalTools(mcp: McpServer, deps: JournalToolDeps): void {
  mcp.registerTool(
    "abap_journal",
    {
      description:
        "History and undo for writes abapsmith made. Parameters: mode (list|show|undo|reconcile, " +
        "default list), entry, object, detail, limit, session, force, activate, outcome, reason. Common " +
        "calls: mode=list (recent writes with entry ids); mode=show entry=<id> (one entry with " +
        "its before-image; detail=full for the complete images); mode=undo entry=<id> " +
        "activate=true (revert it — refuses on drift, delete-gate, or an enhancement object; " +
        "see abapsmith-recover-a-bad-write); mode=reconcile entry=<id> outcome=<succeeded|failed> " +
        "reason=<text> (close a stranded `pending` entry — journal bookkeeping only, nothing is " +
        "sent to SAP).",
      inputSchema: journalInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      try {
        const a = args as { mode?: string; entry?: string; object?: string };
        const isUndo = (a.mode ?? "list") === "undo";
        /** ObjectGate key for the undo write — see {@link writeGateKey}. */
        let undoGateKey: string | undefined;
        if (isUndo) {
          // BEFORE ensureConnected() — the journal is local, so a refused undo
          // costs zero network requests, same guarantee as abap_write.
          const t = await undoPreflightTarget(deps.journal, a);
          // Costs no request either — same rule as writeGateKey.
          undoGateKey = t?.name ? t.name.trim().toUpperCase() : undefined;
          // ENHO/ENHS entries are refused unconditionally by undoBlocker() in
          // performUndo. Checking here (same wording, zero-network) avoids the
          // generic gate call's misleading "affects" refusal shadowing this
          // purpose-built one — see the git history.
          const blocked = t ? enhancementUndoBlocked(t.type ?? "", t.op, t.name) : undefined;
          if (blocked) {
            throw new AbapError(
              "UNSUPPORTED",
              blocked,
              { entry: a.entry, object: t?.name ?? a.object },
              "There is no override for this refusal. Reverse the change deliberately through " +
                "the ABAP enhancement UI instead.",
            );
          }
          deps.safety.assert(t?.op ?? "write", t ? { name: t.name, packageName: t.packageName, type: t.type } : { name: a.object ?? "" }, {
            phase: t ? "final" : "preflight",
          });
        }
        // list/show/reconcile never touch the network: they work with the system down.
        if (isUndo) await deps.ensureConnected();
        const run = (conn: AbapConnection) =>
          abapJournal(conn, args as JournalInput, deps.cfg.maxResponseChars, deps.journal, deps.safety);
        // Only undo leases a slot — list/show/reconcile put zero requests on the wire
        // and must keep working with the system down / all slots held.
        const res = isUndo
          ? await deps.pool.withWrite("abap_journal", undoGateKey, run)
          : await run(deps.pool.primary());
        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
