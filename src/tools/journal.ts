/**
 * `abap_journal` — undo/audit trail for writes made through this codebase.
 * Three modes: `list`, `show` (with before-image), `undo` (revert).
 *
 * `list`/`show` are pure local reads — zero network calls, work with the
 * ABAP system unreachable. `undo` is a write and is gated like one.
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
  deleteEvidenceBlocker,
  enhancementUndoBlocked,
  packageRecreateBlocker,
  performUndo,
  planUndo,
  plannedAction,
} from "../adt/undo.js";
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import { buildResponse, sliceLines, type BuiltResponse } from "../compact.js";
import { STALE_PENDING_MS, type Journal, type JournalEntry } from "../journal.js";
import { textTable } from "../compact.js";
import type { SafetyGate } from "../safety.js";

export const journalInputSchema = {
  mode: z
    .enum(["list", "show", "undo"])
    .optional()
    .describe("list (default): recent writes. show: one entry incl. its before-image. undo: revert one entry."),
  entry: z
    .string()
    .optional()
    .describe("Journal entry id from mode=list. Required for show and undo unless `object` is given."),
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
};

export const JournalInput = z.object(journalInputSchema);
export type JournalInput = z.infer<typeof JournalInput>;

const shortId = (id: string) => id;

function row(e: JournalEntry): Record<string, string> {
  const undo = e.undoneBy ? "undone" : e.undoOf ? "is-undo" : "";
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
    flags: undo,
  };
}

const LIST_COLUMNS = ["id", "when", "op", "object", "existed", "capture", "outcome", "flags"];
/** `actor` spliced in before `flags` — only shown when the page has one to show. */
const LIST_COLUMNS_WITH_ACTOR = LIST_COLUMNS.flatMap((c) => (c === "flags" ? ["actor", "flags"] : c));

/**
 * Journalled but not undoable, decided without a connection. Mirrors
 * `undoBlocker()` / `deleteEvidenceBlocker()` in adt/undo.ts for the *listing*
 * view only — the real check happens against live server state.
 */
function undoHint(e: JournalEntry): string {
  if (e.operation === "transport-release") {
    return "RELEASED TRANSPORT — refused: a released transport cannot be recalled; create a corrective transport instead";
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
    const refusal = deleteEvidenceBlocker(e);
    return refusal
      ? `undo would DELETE this object, and WILL BE REFUSED: ${refusal}`
      : "undo would DELETE this object (abapsmith created it, and confirmed it was absent first)";
  }
  if (action === "recreate") {
    const refusal = packageRecreateBlocker(e);
    return refusal
      ? `undo would RE-CREATE this object, and WILL BE REFUSED: ${refusal}`
      : "undo would RE-CREATE this object from the before-image";
  }
  return "undo would restore the previous source";
}

/** Class entries are only ever half-covered — see FIX E4 in adt/undo.ts. */
function classWarning(e: JournalEntry): string | undefined {
  if (!/^CLAS/i.test(e.object.type)) return undefined;
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
          "abap_journal mode=show, and resolve it deliberately.",
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

  const entry = await pickEntry(j, input, mode);

  // ------------------------------------------------------------- show ----
  if (mode === "show") {
    const before = await j.beforeImage(entry);
    const sections: Array<{ title: string; content: string }> = [];
    if (before !== undefined) {
      const win = sliceLines(before, 1);
      const label = entry.beforeKind === "package-metadata" ? "package metadata, " : "";
      sections.push({ title: `BEFORE-IMAGE (${label}${entry.before?.bytes ?? 0} bytes)`, content: win.text });
    } else {
      sections.push({
        title: "BEFORE-IMAGE",
        content: entry.existedBefore
          ? entry.beforeCapture === "failed"
            ? "(none was ever captured — the entry says the object existed but its source " +
              "read never resolved, whether it didn't complete or came back inconclusive. " +
              "Not a retention problem; there is nothing to restore.)"
            : "(recorded, but the blob is gone — pruned or the journal dir was cleaned)"
          : "(none — the entry records that the object did not exist before this operation, " +
            `so undo would mean DELETE; provenance: beforeCapture="${entry.beforeCapture}")`,
      });
    }

    const notes: string[] = [];
    if (entry.outcome === "pending") {
      notes.push(
        "THIS IS NOT A USABLE UNDO. The entry is still `pending`: abapsmith wrote the " +
          "before-image and then never recorded an outcome, so it does not know whether the " +
          "write reached the server at all. Undo refuses pending entries rather than guess " +
          "which state to put the object back into. Read the object (abap_read) and compare " +
          "it with the images above to find out what actually happened.",
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
        uri: entry.object.uri,
        package: entry.object.package,
        existedBefore: entry.existedBefore,
        beforeCapture: entry.beforeCapture,
        beforeKind: entry.beforeKind,
        outcome: entry.outcome,
        error: entry.error,
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
      hints: [`abap_journal mode=undo entry=${entry.id}`],
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
          ? `${entry.object.name} is NOT the object that was deleted: what came back is its ` +
            "main include and nothing else. Restore the local and test includes from SAP's " +
            "own version management (SE24 → Utilities → Versions) before trusting it, and do " +
            "not run its unit tests expecting them to exist."
          : "Drift in those includes was neither detected nor reverted."),
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
 * abapsmith wrote. `list`/`show` are pure local reads (no network, no gate);
 * `undo` is a write, gated on the object the journal already knows locally.
 */
export function registerJournalTools(mcp: McpServer, deps: JournalToolDeps): void {
  mcp.registerTool(
    "abap_journal",
    {
      description:
        "History and undo for writes abapsmith made. mode=list: recent writes with entry " +
        "ids. mode=show: one entry with its before-image. mode=undo: revert it — refuses " +
        "on drift, delete-gate, or an enhancement object; see abapsmith-recover-a-bad-write " +
        "for details.",
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
        // list/show never touch the network: they work with the system down.
        if (isUndo) await deps.ensureConnected();
        const run = (conn: AbapConnection) =>
          abapJournal(conn, args as JournalInput, deps.cfg.maxResponseChars, deps.journal, deps.safety);
        // Only undo leases a slot — list/show put zero requests on the wire
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
