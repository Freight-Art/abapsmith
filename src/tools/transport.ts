/**
 * `abap_transport` / `abap_transport_release` — the user-facing half of CTS.
 * Release is a separate tool (not an `operation` enum value) so the one
 * irreversible verb isn't reachable by fuzzing an enum.
 *
 * This module never claims an outcome the wire didn't prove: a release
 * reporting an abort may have actually released (PU/238 — see
 * the git history), so all four outcomes from
 * `src/adt/transports.ts` are surfaced distinctly and `unknown` always means
 * "could not verify". A delete of a never-existent request looks identical
 * to a real one on the wire, so `existedBefore === false` renders as "no
 * such request", never "deleted".
 *
 * No lock-ignoring / check-bypassing path exists here — denied structurally
 * in `src/adt/http-guard.ts`.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { buildResponse, textTable, type BuiltResponse } from "../compact.js";
import type { AbapConnection } from "../adt/connection.js";
import { AbapError } from "../adt/errors.js";
import type { ObjectGate, SessionPool } from "../adt/pool.js";
import { resolveObject, searchExact } from "../adt/resolve.js";
import type { SessionTrOwner } from "../adt/session-transport.js";
import type { Config } from "../config.js";
import {
  systemKey,
  type BeforeImageCapture,
  type Journal,
  type JournalBeginInput,
  type JournalEntry,
  type JournalObjectRef,
  type JournalOperation,
} from "../journal.js";
import type { AuthorizedTarget, SafetyGate } from "../safety.js";
import {
  authorizeCeiling,
  isTrkorr,
  trAddUser,
  trCreate,
  trCreateSearchConfiguration,
  trDelete,
  trFindEntryHolder,
  trList,
  trRelease,
  trRequirement,
  trSearchConfigurations,
  trSetOwner,
  trShow,
  trUsers,
  type TrAddUserResult,
  type TrCreated,
  type TrDeleteResult,
  type TrEntryHolder,
  type TrHeader,
  type TrList,
  type TrObject,
  type TrReleaseMessage,
  type TrReleaseOutcome,
  type TrReleaseResult,
  type TrRequest,
  type TrSearchConfig,
  type TrSetOwnerResult,
  type TrStatus,
  type TrTask,
} from "../adt/transports.js";
import {
  removalTouchedNothing,
  removeTransportEntryViaBridge,
  type TransportEntryRemoveResult,
} from "../adt/transport-entry-remove.js";
import { readTransportLogViaBridge, type TransportLogResult } from "../adt/transport-log.js";
import { readImportQueueViaBridge, type TransportQueueResult } from "../adt/transport-queue.js";
import {
  createTransportOfCopiesViaBridge,
  type TransportOfCopiesResult,
} from "../adt/transport-copies.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const transportInputSchema = {
  operation: z
    .enum([
      "list",
      "show",
      "check",
      "users",
      "log",
      "queue",
      "create",
      "addUser",
      "setOwner",
      "delete",
      "removeObject",
    ])
    .describe(
      "What to do. list/show/check/users/log/queue are plain reads, always allowed. " +
        "create/addUser/setOwner need write access " +
        "(ABAP_MODE=edit or admin, or legacy ABAP_ALLOW_WRITE=true when ABAP_MODE is unset); " +
        "kind=\"copies\" needs no extra ceiling. removeObject and delete share one ceiling: " +
        "delete additionally needs the admin-only transport-delete ceiling " +
        "(ABAP_MODE=admin — no legacy flag grants it) and confirm; removeObject needs that same ceiling and confirm." +
        " Required args: list/users none; show transport; check object; log transport; " +
        "queue system; create package+description (plus target when kind=\"copies\"); " +
        "addUser/setOwner transport+user; delete transport+confirm; " +
        "removeObject transport+object+confirm.",
    ),
  transport: z
    .string()
    .optional()
    .describe(
      "Request/task number, e.g. A4HK900123. Required for operation=show/addUser/setOwner/delete" +
        "/removeObject and for operation=log.",
    ),
  user: z
    .string()
    .optional()
    .describe(
      "User: filter for list, new member/owner otherwise. Required for operation=addUser/setOwner.",
    ),
  object: z
    .string()
    .optional()
    .describe(
      "Object name. Required for operation=check/removeObject (removeObject: the entry to remove). " +
        "Optional anchor for create with kind=\"workbench\" (default); not for kind=\"copies\", which is created empty.",
    ),
  package: z
    .string()
    .optional()
    .describe("Development package (devclass). Required for operation=create."),
  description: z
    .string()
    .optional()
    .describe("Short text for the new request, max 60 chars. Required for operation=create."),
  kind: z
    .enum(["workbench", "copies"])
    .optional()
    .describe(
      "operation=\"create\" only. \"workbench\" (default): a normal transportable change request. " +
        "\"copies\": a snapshot sent to a target system, originals untouched; requires target.",
    ),
  target: z
    .string()
    .optional()
    .describe(
      "Target system for operation=\"create\" with kind=\"copies\", e.g. A4H. A transport of " +
        "copies with no target cannot be imported anywhere, so abapsmith refuses to create one.",
    ),
  system: z
    .string()
    .optional()
    .describe("Target system whose import queue to read, e.g. QAS. Required for operation=\"queue\"."),
  domain: z
    .string()
    .optional()
    .describe("TMS transport domain of system, e.g. DOMAIN_A4H. Optional; TMS resolves the local domain when omitted."),
  confirm: z
    .string()
    .optional()
    .describe("Echo the request number to arm delete or removeObject."),
};

const TransportInput = z.object(transportInputSchema);
export type TransportInput = z.infer<typeof TransportInput>;

export const transportReleaseInputSchema = {
  transport: z.string().describe("Request to release, e.g. A4HK900123."),
  confirm: z
    .string()
    .optional()
    .describe("Echo the request number to really release. Omitted = dry run."),
  confirm_unowned: z
    .string()
    .optional()
    .describe(
      "Echo the request number to release a request this session did not create.",
    ),
  scope: z
    .enum(["single", "request"])
    .optional()
    .describe(
      '"single" (default): release only the number named. "request": name a REQUEST; release ' +
        "each of its modifiable tasks that holds objects, in order, then the request itself, in " +
        "one call — stops at the first step that fails.",
    ),
};

const TransportReleaseInput = z.object(transportReleaseInputSchema);
export type TransportReleaseInput = z.infer<typeof TransportReleaseInput>;

export const TRANSPORT_TOOL_DESCRIPTION =
  "Inspect and manage CTS transport requests: list, show, check (does an object need a " +
  "transport?), users, log (a request's export/import log per target system), queue (a " +
  "target system's import buffer), create (kind=\"workbench\" default, or \"copies\" with " +
  "target), addUser, setOwner, delete, removeObject (drop one E071 entry and its CTS lock). " +
  "list/show/check/users/log/queue are plain reads, always allowed; create/addUser/setOwner " +
  "need write access; delete/removeObject additionally need the admin-only transport-delete " +
  "ceiling. Release is a separate tool, abap_transport_release. Semantics of log/queue/" +
  "copies/removeObject: doc/TOOLS/transports.md.";

export const TRANSPORT_RELEASE_TOOL_DESCRIPTION =
  "Release one CTS transport request — irreversible. Gated by a release ceiling separate " +
  "from ordinary write access; see abapsmith-orient. A request this session did not create " +
  "is refused unless confirm_unowned is also passed. scope: \"request\" releases a request's " +
  "modifiable tasks and then the request in one call, stopping at the first failure; naming a " +
  "task without it releases only the task and the response says whether the parent still has " +
  "to be released.";

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

/** A route-less system reports `tm:target=""` — that's a landscape fact, not an error. */
function fmtTarget(h: Pick<TrHeader, "target" | "targetDescription">): string {
  const t = (h.target ?? "").trim();
  if (t === "") return "no target (local-only system)";
  const d = (h.targetDescription ?? "").trim();
  return d === "" ? t : `${t} (${d})`;
}

function fmtStatus(status: TrStatus | undefined, text?: string): string {
  const base =
    status === "released"
      ? "Released (tm:status=R)"
      : status === "modifiable"
        ? "Modifiable (tm:status=D)"
        : status === "protected"
          ? "Protected"
          : "unknown";
  const t = (text ?? "").trim();
  return t === "" || t.toLowerCase() === status ? base : `${base} — ${t}`;
}

/**
 * One-letter TRFUNCTION values a TASK can carry. A details response usually
 * spells the type out (`Development/Correction`), but `abap_img_edit
 * create_request` reports the letter (`Q`), so a letter is glossed inline and
 * anything else is passed through exactly as sent — no attempt is made to map
 * a spelled-out form back to a letter, since the server's exact wording for
 * each type is not established here.
 */
const TASK_TYPE_NAMES: Readonly<Record<string, string>> = {
  S: "development/correction",
  R: "repair",
  Q: "customizing task",
  X: "unclassified task",
};

function fmtTaskType(h: TrHeader): string {
  const raw = (h.kindRaw ?? "").trim();
  if (raw === "") return "(none)";
  const gloss = TASK_TYPE_NAMES[raw.toUpperCase()];
  return gloss ? `${raw} (${gloss})` : raw;
}

function objectRows(objects: readonly TrObject[]): Array<Record<string, string>> {
  return objects.map((o) => ({
    pgmid: o.pgmid,
    type: o.type,
    name: o.rows !== undefined && o.rows >= 2 ? `${o.name} (x${o.rows}, duplicate E071 rows)` : o.name,
    locked: o.locked ? "yes" : "no",
    description: o.description ?? "",
  }));
}

function headerRows(items: readonly TrRequest[]): Array<Record<string, string>> {
  return items.map((r) => ({
    request: r.trkorr,
    status: r.status,
    owner: r.owner,
    target: fmtTarget(r),
    description: r.description,
  }));
}

/**
 * Union a request's objects with its tasks', de-duped by pgmid::type::name — `objectsOf`
 * (src/adt/transports.ts) only de-dupes WITHIN one node, so an entry recorded under both the
 * request and a task would otherwise be double-counted. Request objects first, first
 * occurrence wins; `rows` is the larger of what the request and its tasks reported (undefined
 * when neither reported one). Shared by `opShow` and `diagnoseLockedDelete` so the two can't drift.
 */
function unionedObjects(r: TrRequest): TrObject[] {
  const byKey = new Map<string, TrObject>();
  for (const obj of [...r.objects, ...r.tasks.flatMap((t) => t.objects)]) {
    const key = `${obj.pgmid}::${obj.type}::${obj.name}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, obj);
    } else if (obj.rows !== undefined && (existing.rows === undefined || obj.rows > existing.rows)) {
      byKey.set(key, { ...existing, rows: obj.rows });
    }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Subject substitution: the number you asked about vs. the one you were told about
// ---------------------------------------------------------------------------

/**
 * `GET /cts/transportrequests/<task>` answers with the task's PARENT request,
 * not the task — task and request numbers are indistinguishable by shape, so
 * `trShow` may return a `TrRequest` whose `trkorr` differs from what the
 * caller named. Every rendering path carries that comparison explicitly and
 * never treats a re-read of the parent as confirmation about the task (see
 * {@link releaseVerdict}).
 */
interface TrSubject {
  /** The number the caller named, normalised. */
  asked: string;
  /** The number the server actually answered about. */
  answered: string;
  /** True when those differ, i.e. `asked` is (almost certainly) a task of `answered`. */
  substituted: boolean;
}

function subjectOf(asked: string, answered: TrRequest): TrSubject {
  return { asked, answered: answered.trkorr, substituted: answered.trkorr !== asked };
}

/**
 * Header fields naming both numbers; empty when nothing was substituted.
 * `trShow` recovers a substituted task's own header from the sibling
 * `<tm:task>` CTS emits alongside `<tm:request>`, so `requestedStatus` is
 * normally the task's real status — it renders `not known` rather than being
 * omitted on the rare response where the task isn't among `answered.tasks`,
 * so the parent's status can't be mistaken for the answer.
 */
function subjectHeader(
  s: TrSubject,
  answered: TrRequest,
  extra?: Record<string, string>,
): Record<string, string> {
  if (!s.substituted) return {};
  const own = answered.tasks.find((t) => t.trkorr === s.asked);
  return {
    requested: s.asked,
    answeredAbout: s.answered,
    ...extra,
    requestedStatus: own ? fmtStatus(own.status, own.statusText) : "not known",
    requestedType: own ? fmtTaskType(own) : "not known",
  };
}

/** `parentStillOpen`'s value: whether the parent request still needs releasing. */
function parentStillOpenValue(res: TrReleaseResult): "yes" | "no" | "not known" {
  if (!res.verified) return "not known";
  return res.actualStatus === "released" ? "no" : "yes";
}

function subjectNotes(s: TrSubject, answered: TrRequest): string[] {
  if (!s.substituted) return [];
  const own = answered.tasks.find((t) => t.trkorr === s.asked);
  const notes = [
    `SUBSTITUTION — you named ${s.asked}, the server answered about ${s.answered}. In CTS a GET ` +
      `of a task number returns its PARENT request, so ${s.asked} is a task of ${s.answered}. ` +
      `requestedStatus (and, on a release, requestedStatusAfter) are ${s.asked}'s own readings; ` +
      `every other status field above describes ${s.answered}, not ${s.asked}.`,
  ];
  notes.push(
    own
      ? `${s.asked} is listed among ${s.answered}'s tasks and reads ${fmtStatus(own.status, own.statusText)}.`
      : `This call learned nothing about ${s.asked}'s own state: it is not among the ` +
          `${answered.tasks.length} task(s) the parsed response carries. Do not read the status ` +
          `above as ${s.asked}'s.`,
  );
  return notes;
}

/**
 * Did THIS server process create the request a release/show is about? Checks
 * both the number the caller named and the one the server answered about, so
 * a task under a request this process created still counts as owned.
 * `undefined` when no ownership record was supplied — never rendered as "no".
 * This is all `SessionTrOwner` (an in-memory, per-process set) can answer —
 * it says nothing about a request an EARLIER process created (see
 * {@link resolveCreatedBy}, which also consults the journal).
 */
function createdByThisProcess(
  ownership: SessionTrOwner | undefined,
  s: TrSubject,
): boolean | undefined {
  if (!ownership) return undefined;
  return ownership.createdThisSession(s.answered) || ownership.createdThisSession(s.asked);
}

/**
 * What abapsmith can say about who created the request a `show` / release dry
 * run is about.
 *
 * `SessionTrOwner` only knows what THIS server process created, so a host that
 * starts a fresh server per call — or a plain restart — made every request
 * abapsmith itself had minted read as a stranger's (issue #67). The journal
 * outlives the process: a `transport-create` entry filed under the request
 * number, recorded against this system, is evidence an earlier abapsmith
 * created it, so it is consulted whenever this process does not recognise the
 * number.
 */
type TrCreatedBy =
  | { kind: "this-process" }
  | { kind: "journal"; entry: JournalEntry }
  | { kind: "no"; sid: string }
  | { kind: "unknown"; why: string }
  | { kind: "not-checked" };

/**
 * The newest `transport-create` entry for either number the subject names,
 * recorded against THIS system. An entry carrying no `systemKey` is not
 * counted: journal directories are namespaced per SID only, so an entry that
 * does not name its box cannot prove it is this one. A `failed` entry is
 * skipped — it records a create that did not land.
 */
async function findTransportCreate(
  j: TransportJournalDeps,
  s: TrSubject,
): Promise<JournalEntry | undefined> {
  const key = systemKey({ sid: j.cfg.sid, url: j.cfg.url, client: j.cfg.client });
  const numbers = s.asked === s.answered ? [s.answered] : [s.answered, s.asked];
  for (const n of numbers) {
    // `list()` is newest-first, so the first match is the latest entry.
    const hit = (await j.journal.list({ object: n, operation: "transport-create" })).find(
      (e) => e.systemKey === key && e.outcome !== "failed",
    );
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Resolves what abapsmith can claim about the request's creator. The whole
 * feature stays opt-in, exactly as before: a direct caller that supplies no
 * ownership record gets no claim at all, and the journal is not consulted on
 * its behalf either.
 */
async function resolveCreatedBy(
  ownership: SessionTrOwner | undefined,
  journal: TransportJournalDeps | undefined,
  s: TrSubject,
): Promise<TrCreatedBy> {
  if (!ownership) return { kind: "not-checked" };
  if (createdByThisProcess(ownership, s)) return { kind: "this-process" };
  if (!journal) return { kind: "unknown", why: "no journal was supplied to this call" };
  if (!journal.journal.enabled) return { kind: "unknown", why: "the journal is off" };
  // A `show` (or a release dry run) is a read: it must not fail just because
  // the journal happens to be unreadable right now.
  try {
    const entry = await findTransportCreate(journal, s);
    return entry ? { kind: "journal", entry } : { kind: "no", sid: journal.cfg.sid };
  } catch {
    return { kind: "unknown", why: "the journal could not be read" };
  }
}

/**
 * Renders {@link resolveCreatedBy}'s verdict as the `createdByAbapsmith`
 * header field. `undefined` for `not-checked` omits the field entirely,
 * matching the pre-existing "no ownership record supplied" behaviour.
 */
function createdByField(c: TrCreatedBy): string | undefined {
  switch (c.kind) {
    case "this-process":
      return "yes (this server process)";
    case "journal":
      return `yes (journal entry ${c.entry.id})`;
    case "no":
      return `no (not this process; no journal entry on ${c.sid})`;
    case "unknown":
      return `unknown — ${c.why}`;
    case "not-checked":
      return undefined;
  }
}

/**
 * The dry-run notes for {@link resolveCreatedBy}'s verdict — shared by
 * `releaseDryRun` and `releaseDryRunRequestScope` so the wording can't drift
 * between the two. `requestTrkorr` is the request the ownership question is
 * about; `trkorr` is what `confirm_unowned` must echo.
 */
function createdByNotes(created: TrCreatedBy, requestTrkorr: string, trkorr: string): string[] {
  if (created.kind === "journal") {
    return [
      `${requestTrkorr} was created by abapsmith earlier (journal entry ${created.entry.id}), but ` +
        `not by this server process — the release guard counts only this process, so ` +
        `abap_transport_release will still refuse unless you also pass confirm_unowned: ` +
        `"${trkorr}".`,
    ];
  }
  if (created.kind === "no") {
    return [
      `${requestTrkorr} was NOT created by abapsmith (not by this server process, and no ` +
        "transport-create entry for it in this system's journal) — releasing it would also " +
        "transport whatever earlier work left in it. abap_transport_release will refuse unless " +
        `you also pass confirm_unowned: "${trkorr}".`,
    ];
  }
  if (created.kind === "unknown") {
    return [
      `${requestTrkorr} was not created by this server process, and ${created.why} — so abapsmith ` +
        "cannot tell whether an earlier process created it. Releasing it would also transport " +
        "whatever earlier work left in it; abap_transport_release will refuse unless you also " +
        `pass confirm_unowned: "${trkorr}".`,
    ];
  }
  return [];
}

/**
 * Release abort reasons collapse to two coarse codes; the message
 * class/number is the actionable signal, so it's always rendered with a
 * plain-English gloss for the classes seen on the wire.
 */
const RELEASE_MESSAGE_NOTES: Readonly<Record<string, string>> = {
  "TR/768": "the request was already released before this call",
  "EU/829": "an object in the request is inactive — activate it, then release",
  "TR/732": "a referencing task is not released yet — release the task first",
  "TK/494": "an unclassified task is attached — classify or delete it",
  "PU/238": "pre-export error; observed to abort the report even when the request WAS released",
};

function messageKey(m: TrReleaseMessage): string {
  const cls = (m.messageClass ?? "").trim();
  const num = (m.messageNumber ?? "").trim();
  return cls === "" || num === "" ? "" : `${cls}/${num}`;
}

function messageRows(messages: readonly TrReleaseMessage[]): Array<Record<string, string>> {
  return messages.map((m) => {
    const key = messageKey(m);
    return {
      message: key === "" ? "(no class)" : key,
      type: m.type,
      text: m.text,
      meaning: RELEASE_MESSAGE_NOTES[key] ?? "",
    };
  });
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/** A request/task number shape, e.g. A4HK900123 — used to guess a misnamed `object=`. */
const TRKORR_LIKE = /^[A-Z0-9]{3}K\d{6}$/i;

function normTrkorr(value: string | undefined, operation: string, objectValue?: string): string {
  const raw = (value ?? "").trim().toUpperCase();
  if (raw === "") {
    const guess = (objectValue ?? "").trim();
    const looksLikeTransport = TRKORR_LIKE.test(guess);
    throw new AbapError(
      "BAD_INPUT",
      `Operation "${operation}" needs "transport" (a request/task number, e.g. A4HK900123).` +
        (looksLikeTransport ? ` Did you mean transport="${guess}"?` : ""),
      { operation, arg: "transport" },
      looksLikeTransport ? `Retry with transport="${guess}".` : undefined,
    );
  }
  if (!isTrkorr(raw)) {
    throw new AbapError(
      "BAD_INPUT",
      `"${value}" is not a transport request number (expected e.g. A4HK900123).`,
      { operation, transport: value },
    );
  }
  return raw;
}

function required(value: string | undefined, arg: string, operation: string): string {
  const raw = (value ?? "").trim();
  if (raw === "") {
    throw new AbapError("BAD_INPUT", `Operation "${operation}" needs "${arg}".`, { operation, arg });
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

/**
 * Extra ceiling (beyond `readOnly`) a transport op needs, on top of
 * `"plain"`: `"release"` → `SafetyConfig.allowTransportRelease`, `"delete"` →
 * the admin-only `SafetyConfig.allowTransportDelete`.
 */
type TransportCeilingKind = "plain" | "release" | "delete";

/**
 * Write-access clause named in transport error hints. Under `ABAP_MODE`,
 * `ABAP_ALLOW_WRITE` is never read, so name whichever lever is
 * actually live — mirrors `instructionsFor`'s `writeGate` in `src/server.ts`.
 */
function writeAccessHint(gate: SafetyGate): string {
  const mode = gate.config.abapMode;
  return mode !== undefined ? `ABAP_MODE=edit or admin (it is ${mode})` : "ABAP_ALLOW_WRITE=true";
}

/**
 * Same as {@link writeAccessHint} for the release ceiling: `allowTransportRelease`
 * is admin-only under `ABAP_MODE`, not `edit`.
 */
function releaseAccessHint(gate: SafetyGate): string {
  const mode = gate.config.abapMode;
  return mode !== undefined ? `ABAP_MODE=admin (it is ${mode})` : "ABAP_ALLOW_TRANSPORT_RELEASE=true";
}

/**
 * `SafetyGate.evaluate` is written for object writes (namespace/package/prefix
 * rules against a target); a transport number isn't an object, so these ops
 * consult the gate with no target — every ceiling is decided before the
 * gate's no-target guard, which then allows unconditionally.
 */
function ceilingDecision(
  gate: SafetyGate,
  kind: TransportCeilingKind,
): { allowed: boolean; reason: string; code?: AbapError["code"]; rule?: string } {
  const opts =
    kind === "release" ? { release: true } : kind === "delete" ? { deleteTransport: true } : {};
  const d = gate.evaluate("transport", undefined, opts);
  if (d.allowed) {
    return { allowed: true, reason: "Permitted by the safety gate." };
  }
  return { allowed: false, reason: d.reason, code: d.code, rule: d.rule };
}

function assertCeiling(gate: SafetyGate, kind: TransportCeilingKind, operation: string): void {
  const d = ceilingDecision(gate, kind);
  if (d.allowed) return;
  throw new AbapError(
    d.code ?? "READ_ONLY",
    d.reason,
    { operation: `transport:${operation}`, rule: d.rule },
    kind === "release"
      ? `Releasing needs ${releaseAccessHint(gate)}. It is deliberately NOT implied by ordinary ` +
        "write access (ABAP_MODE=edit, or legacy ABAP_ALLOW_WRITE)."
      : kind === "delete"
        ? "Deleting a transport request needs the admin-mode transport-delete ceiling (ABAP_MODE=admin). It is deliberately NOT implied by ABAP_ALLOW_WRITE."
        : `Transport changes need ${writeAccessHint(gate)}.`,
  );
}

// ---------------------------------------------------------------------------
// Journalling caller-driven CTS mutations
// ---------------------------------------------------------------------------

/**
 * What this module needs in order to journal. Still OPTIONAL at the
 * `abapTransport` / `abapTransportRelease` call sites — a direct caller that
 * passes none gets the pre-journal behaviour (mutate CTS, record nothing,
 * never throw), pinned by test/transport-tools.test.ts. The composition root
 * can't reach that path: `TransportToolDeps.journal` is REQUIRED (see that
 * field's doc comment).
 */
export interface TransportJournalDeps {
  readonly journal: Journal;
  readonly cfg: Pick<Config, "sid" | "url" | "client">;
  readonly warn: (msg: string) => void;
}

/**
 * What can be said about a mutation once the server has answered — not just
 * `JournalOutcome` (`pending | succeeded | failed`) because a release or
 * delete has a fourth real state: we did it and cannot prove what it did.
 * Neither terminal value may be written then — `succeeded` would claim a
 * release the tool calls "NOT CONFIRMED"; `failed` would claim modifiable
 * when it may be frozen. `unproven` leaves the entry `pending` and sends the
 * verdict to the logger instead.
 */
type JournalVerdict =
  | { kind: "succeeded"; afterSource?: string }
  | { kind: "failed"; reason: string; afterSource?: string }
  | { kind: "unproven"; reason: string };

/** A transport entry is filed under the request number itself. */
function trRef(trkorr: string, description: string, pkg?: string): JournalObjectRef {
  return {
    name: trkorr,
    type: "CTS/TR",
    uri: `/sap/bc/adt/cts/transportrequests/${trkorr}`,
    package: pkg ?? "",
    description,
  };
}

interface TransportEntrySpec {
  operation: JournalOperation;
  trkorr: string;
  description: string;
  package?: string;
  existedBefore: boolean;
  beforeCapture?: BeforeImageCapture;
  beforeSource?: string;
  irreversible?: boolean;
  tool: string;
}

function beginInput(j: TransportJournalDeps, spec: TransportEntrySpec): JournalBeginInput {
  return {
    operation: spec.operation,
    object: trRef(spec.trkorr, spec.description, spec.package),
    existedBefore: spec.existedBefore,
    ...(spec.beforeCapture ? { beforeCapture: spec.beforeCapture } : {}),
    ...(spec.beforeSource !== undefined ? { beforeSource: spec.beforeSource } : {}),
    ...(spec.irreversible ? { irreversible: true } : {}),
    systemKey: systemKey({ sid: j.cfg.sid, url: j.cfg.url, client: j.cfg.client }),
    corrNr: spec.trkorr,
    // Every mutation here was caller-ordered (no auto-created request reaches
    // this file) — distinguishes these from `session-created` entries.
    trSource: "caller",
    tool: spec.tool,
  };
}

/**
 * Settle an entry, or deliberately leave it pending. Never throws: the CTS
 * side has already happened, so failing the tool call now would report a
 * failure for a mutation that is real.
 */
async function settleEntry(
  j: TransportJournalDeps,
  entry: JournalEntry,
  trkorr: string,
  verdict: JournalVerdict,
): Promise<void> {
  if (verdict.kind === "unproven") {
    j.warn(
      `[abapsmith] WARNING: ${trkorr} — journal entry ${entry.id} stays \`pending\` on purpose: ` +
        `${verdict.reason}. The journal cannot express "done, outcome unproven", and recording ` +
        `either \`succeeded\` or \`failed\` here would state something this call did not ` +
        `establish. Re-check ${trkorr} with abap_transport {"operation":"show"} and settle it by ` +
        `hand.`,
    );
    return;
  }
  try {
    const settled = await j.journal.settle(entry.id, {
      outcome: verdict.kind,
      ...(verdict.kind === "failed" ? { error: verdict.reason } : {}),
      ...(verdict.afterSource !== undefined ? { afterSource: verdict.afterSource } : {}),
    });
    if (!settled.settled) {
      j.warn(
        `[abapsmith] WARNING: ${trkorr} — journal entry ${entry.id} could not be settled ` +
          `(${settled.reason}${settled.error ? `: ${settled.error}` : ""}). It will read as ` +
          `\`pending\`; the real outcome was \`${verdict.kind}\`.`,
      );
    }
  } catch (e) {
    j.warn(
      `[abapsmith] WARNING: ${trkorr} — journal entry ${entry.id} could not be settled ` +
        `(${(e as Error).message}). It will read as \`pending\`; the real outcome was ` +
        `\`${verdict.kind}\`.`,
    );
  }
}

/**
 * Journal a mutation that has ALREADY happened: `begin()` then `settle()`,
 * after the server answered. Never throws, same reason as `settleEntry`; see
 * each call site for why it journals after rather than before.
 */
async function recordMutation(
  j: TransportJournalDeps | undefined,
  spec: TransportEntrySpec,
  verdict: JournalVerdict,
): Promise<void> {
  if (!j) return;
  let entry: JournalEntry | undefined;
  try {
    entry = await j.journal.begin(beginInput(j, spec));
  } catch (e) {
    j.warn(
      `[abapsmith] WARNING: ${spec.trkorr} — the ${spec.operation} DID happen on ${j.cfg.sid} but ` +
        `could NOT be journalled: ${(e as Error).message}. Nothing on disk records it. Write ` +
        `${spec.trkorr} down now; recovery is manual.`,
    );
    return;
  }
  if (!entry) return; // journal disabled — nothing was ever going to be written
  await settleEntry(j, entry, spec.trkorr, verdict);
}

// ---------------------------------------------------------------------------
// abap_transport
// ---------------------------------------------------------------------------

export async function abapTransport(
  conn: AbapConnection,
  input: TransportInput,
  maxChars: number,
  gate: SafetyGate,
  journal?: TransportJournalDeps,
  ownership?: SessionTrOwner,
): Promise<BuiltResponse> {
  switch (input.operation) {
    // `show`/`check`/`users`/`log`/`queue` are reads — journalling those
    // would stop the journal from being a record of what changed. `list` is
    // almost a read too: `opList` may create a search configuration (a real
    // write) to see Modifiable requests, but that isn't a TRKORR-identified
    // object, so it's never routed through `recordMutation` — it's surfaced
    // in the response's `notes` instead.
    case "list":
      return await opList(conn, input, maxChars, gate, journal);
    case "show":
      return await opShow(conn, input, maxChars, journal, ownership);
    case "check":
      return await opCheck(conn, input, maxChars);
    case "users":
      return await opUsers(conn, maxChars);
    case "log":
      return await opLog(conn, gate, input, maxChars);
    case "queue":
      return await opQueue(conn, gate, input, maxChars);
    case "create":
      return await opCreate(conn, input, maxChars, gate, journal, ownership);
    case "addUser":
      return await opAddUser(conn, input, maxChars, gate, journal);
    case "setOwner":
      return await opSetOwner(conn, input, maxChars, gate, journal);
    case "delete":
      return await opDelete(conn, input, maxChars, gate, journal);
    case "removeObject":
      return await opRemoveObject(conn, input, maxChars, gate, journal);
  }
}

/** "transportOfCopies" -> "TRANSPORT OF COPIES". */
function categoryTitle(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toUpperCase();
}

/**
 * Per-connection cache of a discovered/created search-configuration URI. Pure
 * optimisation — `resolveSearchConfigUri` re-discovers from scratch when
 * absent, and `opList` drops a stale entry on the fallback `catch` below.
 */
const searchConfigCache = new WeakMap<AbapConnection, string>();

/**
 * Resolve the `configUri` `list` should query with: at most one discovery
 * GET, and — only when a transport write is already permitted — at most one
 * creating POST. `GET .../transportrequests` only returns the
 * `tm:modifiable` category when called with a `configUri`, so:
 *
 *   1. Always try to discover an existing configuration first (a GET).
 *   2. Only if none exists AND the safety gate already allows a transport
 *      write, create one via `authorizeCeiling`.
 *   3. Otherwise proceed without a `configUri`, noting that Modifiable
 *      requests could not be verified.
 *
 * Never throws: failures fall back to "no configUri" with an explanatory note.
 */
async function resolveSearchConfigUri(
  conn: AbapConnection,
  gate: SafetyGate,
): Promise<{ uri?: string; note?: string }> {
  const cached = searchConfigCache.get(conn);
  if (cached) return { uri: cached };

  let existing: TrSearchConfig[];
  try {
    existing = await trSearchConfigurations(conn);
  } catch {
    existing = []; // discovery is best-effort — list must not fail because of it
  }
  if (existing.length > 0) {
    searchConfigCache.set(conn, existing[0]!.uri);
    return { uri: existing[0]!.uri };
  }

  if (!ceilingDecision(gate, "plain").allowed) return {};

  try {
    const proof = authorizeCeiling(gate, "transport");
    const created = await trCreateSearchConfiguration(conn, proof);
    searchConfigCache.set(conn, created.uri);
    return {
      uri: created.uri,
      note:
        `No saved CTS search configuration existed for this user, so one was created ` +
        `(${created.uri}) — without it, "list" cannot see Modifiable requests at all. It is a ` +
        "permanent, reusable object; this tool will not delete it.",
    };
  } catch (e) {
    return {
      note:
        "No saved CTS search configuration existed, and creating one failed: " +
        `${(e as Error).message}`,
    };
  }
}

async function opList(
  conn: AbapConnection,
  input: TransportInput,
  maxChars: number,
  gate: SafetyGate,
  journal?: TransportJournalDeps,
): Promise<BuiltResponse> {
  void journal; // list never journals — see the dispatcher comment above
  const user = (input.user ?? "").trim();
  const { uri: configUri, note: configNote } = await resolveSearchConfigUri(conn, gate);

  // `trList` parses the CTS XML itself — do not swap this back to the
  // abap-adt-api library helper, which mis-parses route-less-system responses
  // (see the git history).
  let res: TrList;
  let usedConfig = false;
  if (configUri) {
    try {
      res = await trList(conn, { configUri });
      usedConfig = true;
    } catch {
      searchConfigCache.delete(conn); // stale — drop it and fall back
      res = await trList(conn, user === "" ? {} : { user });
    }
  } else {
    res = await trList(conn, user === "" ? {} : { user });
  }

  // Render whatever categories `trList` returns (not a hardcoded pair) so a
  // future category shows up without a change here.
  const categories = Object.entries(res).filter(
    (e): e is [string, TrRequest[]] => Array.isArray(e[1]),
  );
  const cols = ["request", "status", "owner", "target", "description"];
  const sections = categories
    .filter(([, items]) => items.length > 0)
    .map(([key, items]) => ({
      title: categoryTitle(key),
      content: textTable(headerRows(items), cols),
    }));

  const header: Record<string, string | number> = {
    operation: "list",
    user: user === "" ? "(all)" : user,
  };
  let total = 0;
  for (const [key, items] of categories) {
    header[key] = items.length;
    total += items.length;
  }

  const notes: string[] = [];
  if (configNote) notes.push(configNote);
  if (!usedConfig) {
    notes.push(
      `This list did not use a saved search configuration, so it does NOT reliably include ` +
        `Modifiable requests${total === 0 ? "" : ` — the ${total} shown may all be Released`}. ` +
        'Check a known request directly with operation "show" if its state matters.',
    );
  }

  return buildResponse({ header, sections, notes, maxChars });
}

async function opShow(
  conn: AbapConnection,
  input: TransportInput,
  maxChars: number,
  journal?: TransportJournalDeps,
  ownership?: SessionTrOwner,
): Promise<BuiltResponse> {
  const trkorr = normTrkorr(input.transport, "show", input.object);
  const r = await trShow(conn, trkorr);
  const subject = subjectOf(trkorr, r);
  // Read-only: the journal is only ever consulted here, never written to.
  const created = await resolveCreatedBy(ownership, journal, subject);
  const sections: Array<{ title: string; content: string }> = [];
  if (r.tasks.length) {
    sections.push({
      title: "TASKS",
      content: textTable(
        r.tasks.map((t) => ({
          task: t.trkorr,
          type: fmtTaskType(t),
          status: t.status,
          owner: t.owner,
          objects: String(t.objects.length),
          description: t.description,
        })),
        ["task", "type", "status", "owner", "objects", "description"],
      ),
    });
  }
  const objects = unionedObjects(r);
  if (objects.length) {
    sections.push({
      title: "OBJECTS",
      content: textTable(objectRows(objects), ["pgmid", "type", "name", "locked", "description"]),
    });
  }
  // The "already released" note is about `r`; only stated unqualified when
  // `r` is what the caller actually asked about. When substituted, the same
  // claim uses the task's own status recovered from `r.tasks`.
  const notes: string[] = subjectNotes(subject, r);
  const duplicateRowsCount = objects.filter((o) => o.rows !== undefined && o.rows >= 2).length;
  if (duplicateRowsCount > 0) {
    notes.push(
      `${duplicateRowsCount} object(s) have duplicate E071 rows (E071's key is TRKORR+AS4POS, ` +
        "so CTS accepts them); removeObject collapses the duplicates to one row before removing the entry.",
    );
  }
  if (!subject.substituted && r.status === "released") {
    notes.push("Already released — it can no longer be changed.");
  } else if (subject.substituted) {
    const ownTask = r.tasks.find((t) => t.trkorr === trkorr);
    if (ownTask?.status === "released") {
      notes.push(`${trkorr} is itself already released — it can no longer be changed.`);
    }
  }
  if (created.kind === "journal") {
    notes.push(
      `${r.trkorr} was created by abapsmith earlier — journal entry ${created.entry.id} records ` +
        `a transport-create for it on this system — but NOT by this server process. The release ` +
        `guard counts only this process, so releasing it still needs confirm_unowned: ` +
        `"${r.trkorr}".`,
    );
  } else if (created.kind === "no") {
    notes.push(
      `${r.trkorr} was NOT created by abapsmith: this server process did not create it, and ` +
        "this system's journal holds no transport-create entry for it. It was already open, so " +
        "it may hold objects from earlier work.",
    );
  } else if (created.kind === "unknown") {
    notes.push(
      `${r.trkorr} was not created by this server process, and ${created.why} — so abapsmith ` +
        "cannot tell whether an earlier process created it. It may hold objects from earlier work.",
    );
  }
  return buildResponse({
    header: {
      transport: r.trkorr,
      ...subjectHeader(subject, r),
      kind: r.kind,
      status: fmtStatus(r.status, r.statusText),
      owner: r.owner,
      createdByAbapsmith: createdByField(created),
      description: r.description,
      target: fmtTarget(r),
      client: r.client,
      lastChanged: r.lastChanged,
      tasks: r.tasks.length,
      objects: objects.length,
    },
    sections,
    notes,
    maxChars,
  });
}

async function opUsers(conn: AbapConnection, maxChars: number): Promise<BuiltResponse> {
  const users = await trUsers(conn);
  return buildResponse({
    header: { operation: "users", count: users.length },
    sections: [
      {
        title: "USERS",
        content: textTable(
          users.map((u) => ({ user: u.id, name: u.title })),
          ["user", "name"],
        ),
      },
    ],
    maxChars,
  });
}

async function opCheck(
  conn: AbapConnection,
  input: TransportInput,
  maxChars: number,
): Promise<BuiltResponse> {
  const object = required(input.object, "object", "check");
  const resolved = await resolveObject(conn, object);
  const devclass = (input.package ?? "").trim() || resolved.packageName;
  const req = await trRequirement(conn, resolved.uri, devclass);

  const sections: Array<{ title: string; content: string }> = [];
  if (req.candidates.length) {
    sections.push({
      title: "CANDIDATE REQUESTS",
      content: textTable(
        req.candidates.map((c) => ({
          request: c.trkorr,
          status: c.status,
          owner: c.owner,
          target: fmtTarget(c),
          description: c.description,
        })),
        ["request", "status", "owner", "target", "description"],
      ),
    });
  }
  if (req.locks.length) {
    sections.push({
      title: "LOCKS",
      content: textTable(
        req.locks.map((l) => ({
          object: `${l.object.pgmid} ${l.object.type} ${l.object.name}`,
          request: l.request.trkorr,
          owner: l.request.owner,
        })),
        ["object", "request", "owner"],
      ),
    });
  }
  if (req.messages.length) {
    sections.push({
      title: "MESSAGES",
      content: textTable(
        req.messages.map((m) => ({
          message: `${m.messageClass}/${m.messageNumber}`,
          severity: m.severity,
          text: m.text,
        })),
        ["message", "severity", "text"],
      ),
    });
  }

  const notes: string[] = [];
  if (req.kind === "local") {
    notes.push("Local object: writes need no transport (and must not pass one).");
  } else if (req.kind === "transport-auto-created") {
    notes.push(
      "Transportable, and the server would SILENTLY FABRICATE a request+task if you write " +
        "without an explicit transport — a write with no corr_nr returns a clean 200 either way. " +
        "Always pass an explicit transport.",
    );
  } else {
    notes.push("Transportable: every write must supply an explicit transport, or be refused.");
  }
  if (req.checkFailed) {
    notes.push(
      "The pre-flight check itself was rejected by the server — treat this answer as UNVERIFIED, " +
        "not as 'no transport needed'.",
    );
  }
  if (req.pinnedTo) notes.push(`Objects here are already pinned to ${req.pinnedTo}.`);

  return buildResponse({
    header: {
      object: resolved.name,
      type: resolved.type,
      uri: resolved.uri,
      package: req.devclass ?? devclass,
      requirement: req.kind,
      mustSupplyCorrNr: req.mustSupplyCorrNr,
      serverWouldFabricate: req.serverWouldFabricate,
      korrflag: req.raw.korrflag === "" ? "(empty)" : req.raw.korrflag,
      recording: req.raw.recording === "" ? "(empty)" : req.raw.recording,
    },
    sections,
    notes,
    maxChars,
  });
}

/**
 * A `transport` value with no format check — `readTransportLogViaBridge` (`src/adt/
 * transport-log.ts`) validates the shape itself via its own `assertTrkorr`, so this only
 * covers the "missing entirely" case, in the same BAD_INPUT shape `normTrkorr` uses for it.
 *
 * `objectValue` is the caller's `object=` argument, if any (issue #156: a common mix-up is
 * passing the request number as `object` instead of `transport`) — when it looks like a
 * request/task number, the refusal points the caller at the fix instead of a bare "missing".
 */
function requireTransportArg(value: string | undefined, operation: string, objectValue?: string): string {
  const raw = (value ?? "").trim().toUpperCase();
  if (raw === "") {
    const guess = (objectValue ?? "").trim();
    const looksLikeTransport = TRKORR_LIKE.test(guess);
    throw new AbapError(
      "BAD_INPUT",
      `Operation "${operation}" needs "transport" (a request/task number, e.g. A4HK900123).` +
        (looksLikeTransport ? ` Did you mean transport="${guess}"?` : ""),
      { operation, arg: "transport" },
      looksLikeTransport ? `Retry with transport="${guess}".` : undefined,
    );
  }
  return raw;
}

/**
 * E070-TRFUNCTION / E070-TRSTATUS are raw one-letter domain codes — unreadable without CTS's
 * own code table. `fmtTrFunction`/`fmtTrStatus` below gloss them as `label (CODE)` (falling
 * back to the bare code for anything not in the table, and to `(empty)` for a blank, matching
 * the convention `opCheck` uses for `korrflag`/`recording` above).
 *
 * These are two SEPARATE tables, not one shared map, because the domains collide: `D` means
 * "modifiable" as a TRSTATUS but "piece list (upgrade)" as a TRFUNCTION. Merging them would
 * silently mislabel every modifiable request as a piece list (or vice versa) — do not do that
 * in a future edit.
 *
 * Values below are E070's own documented domain fixed values (domains TRFUNCTION / TRSTATUS).
 * Only `T` (TRFUNCTION) and `D` (TRSTATUS) were observed live, on A4H on 2026-09-15 — the
 * transport of copies this feature creates comes back with exactly those two codes. The rest
 * of each table is unverified on this box; none of it is claimed as observed.
 */
const TRFUNCTION_LABELS: Record<string, string> = {
  K: "workbench request",
  W: "customizing request",
  T: "transport of copies",
  C: "relocation of objects without package change",
  O: "relocation of objects with package change",
  E: "relocation of a complete package",
  S: "development/correction task",
  R: "repair task",
  X: "unclassified task",
  Q: "customizing task",
  G: "piece list (CTS project)",
  D: "piece list (upgrade)",
};

const TRSTATUS_LABELS: Record<string, string> = {
  D: "modifiable",
  L: "modifiable, protected",
  O: "release started",
  R: "released",
  N: "released, with import protection for repaired objects",
};

function fmtCodeWithLabel(raw: string, labels: Record<string, string>): string {
  const code = raw.trim();
  if (code === "") return "(empty)";
  const label = labels[code.toUpperCase()];
  return label ? `${label} (${code})` : code;
}

function fmtTrFunction(raw: string): string {
  return fmtCodeWithLabel(raw, TRFUNCTION_LABELS);
}

function fmtTrStatus(raw: string): string {
  return fmtCodeWithLabel(raw, TRSTATUS_LABELS);
}

async function opLog(
  conn: AbapConnection,
  gate: SafetyGate,
  input: TransportInput,
  maxChars: number,
): Promise<BuiltResponse> {
  const trkorr = requireTransportArg(input.transport, "log", input.object);
  const result: TransportLogResult = await readTransportLogViaBridge(conn, gate, { trkorr });

  const sections: Array<{ title: string; content: string }> = [];
  for (const sys of result.systems) {
    const date = (sys.date ?? "").trim();
    const collected = date === "" || date === "00000000" ? "never imported" : `${date} ${sys.time}`;
    const rc = (sys.rc ?? "").trim();
    const rcLine = rc === "" ? "no return code yet" : rc + (sys.rcText ? ` (${sys.rcText})` : "");
    const head = [
      `System: ${sys.system}${sys.systemText ? ` — ${sys.systemText}` : ""}`,
      `Return code: ${rcLine}`,
      `Collected: ${collected}`,
    ].join("\n");
    let body: string;
    if (sys.lines.length === 0) {
      body =
        head +
        "\n\nNo log lines recorded for this system. That is the normal answer, not a failure, " +
        "for a request that has not been exported yet: the log file is written by tp at export " +
        "time, so a modifiable or never-exported request legitimately has an overview row and " +
        "zero log lines (observed live on A4H on 2026-09-15, for every request tried).";
    } else {
      body =
        head +
        "\n\n" +
        textTable(
          sys.lines.map((l) => ({
            severity: l.severity,
            class: l.msgClass,
            number: l.msgNumber,
            text: l.text,
          })),
          ["severity", "class", "number", "text"],
        );
    }
    sections.push({ title: `SYSTEM ${sys.system}`, content: body });
  }

  const notes: string[] = [];
  if (result.systems.length === 0) {
    notes.push(`${result.trkorr} reports no log systems at all — it may have no log overview yet.`);
  }

  return buildResponse({
    header: {
      operation: "log",
      transport: result.trkorr,
      trFunction: fmtTrFunction(result.trFunction),
      trStatus: fmtTrStatus(result.trStatus),
      systems: result.systems.length,
    },
    sections,
    notes,
    maxChars,
  });
}

async function opQueue(
  conn: AbapConnection,
  gate: SafetyGate,
  input: TransportInput,
  maxChars: number,
): Promise<BuiltResponse> {
  const system = required(input.system, "system", "queue").toUpperCase();
  const domain = (input.domain ?? "").trim();
  const result: TransportQueueResult = await readImportQueueViaBridge(conn, gate, {
    system,
    ...(domain === "" ? {} : { domain }),
  });

  const sections: Array<{ title: string; content: string }> = [];
  if (result.entries.length > 0) {
    sections.push({
      title: "QUEUE",
      content: textTable(
        result.entries.map((e) => ({
          position: e.position,
          request: e.trkorr,
          importFlag: e.importFlag,
          maxRc: e.maxRc,
          function: e.trFunction,
          owner: e.owner,
          client: e.targetClient,
          description: e.description,
        })),
        ["position", "request", "importFlag", "maxRc", "function", "owner", "client", "description"],
      ),
    });
  }

  const notes: string[] = [];
  if (result.entries.length === 0) {
    notes.push(
      `The import queue for ${result.system} is EMPTY — no requests are waiting to be imported. ` +
        "This is the current state of the target system's buffer, not an error and not a failed read.",
    );
  }
  notes.push(
    "The queue IS the import buffer, not a history: a request that has already been imported " +
      "has left the buffer, so its absence here does not by itself prove the change never " +
      `reached ${result.system} — check the request's own log (operation "log") for that.`,
  );

  return buildResponse({
    header: {
      operation: "queue",
      system: result.system,
      domain: result.domain.trim() === "" ? "(local domain)" : result.domain,
      collected: `${result.collectedDate} ${result.collectedTime}`.trim(),
      entries: result.entries.length,
    },
    sections,
    notes,
    maxChars,
  });
}

/**
 * Best-effort recovery after a failed `trCreate`: a client-side timeout can arrive AFTER the
 * server already created the request, and the caller must not be told "nothing happened" when
 * it did. Looks for a modifiable workbench request whose description exactly matches this
 * call's — never throws itself, so a broken lookup can never replace or mask the real failure
 * (`opCreate`'s catch still has the original error to fall back to).
 *
 * `TrHeader` carries no devclass/package field (only `trRequirement`'s check-response shape
 * does — see `TrRequirementBase`), so this can only match on description, not on `devClass`.
 */
async function recoverPossiblyCreated(
  conn: AbapConnection,
  description: string,
): Promise<string[]> {
  try {
    const user = (conn.cfg.user ?? "").trim();
    const res = await trList(conn, user ? { user } : {});
    return res.workbench
      .filter((r) => r.kind === "workbench" && r.status === "modifiable")
      .filter((r) => r.description === description)
      .map((r) => r.trkorr);
  } catch {
    return [];
  }
}

async function opCreate(
  conn: AbapConnection,
  input: TransportInput,
  maxChars: number,
  gate: SafetyGate,
  journal?: TransportJournalDeps,
  ownership?: SessionTrOwner,
): Promise<BuiltResponse> {
  const devClass = required(input.package, "package", "create").toUpperCase();
  const description = required(input.description, "description", "create");
  if (description.length > 60) {
    throw new AbapError("BAD_INPUT", "description must be 60 characters or fewer.", {
      length: description.length,
    });
  }
  if (devClass.startsWith("$")) {
    // Correct refusal: a local package's objects never enter CTS. The
    // message below also names the package-allowlist rule a few lines down,
    // so a $TMP-only allowlist reads as "no satisfiable input" rather than
    // two refusals pointing at each other (see archive for the incident).
    const allowPackages = gate?.config?.allowPackages ?? [];
    const allowList = allowPackages.length ? allowPackages.join(", ") : "(empty)";
    const onlyLocal =
      allowPackages.length > 0 && allowPackages.every((p) => p.trim().startsWith("$"));
    throw new AbapError(
      "BAD_INPUT",
      `${devClass} is a local package — its objects are never transported, so there is nothing to ` +
        `create. Writes into ${devClass} need no transport at all: omit the transport rather than ` +
        `creating one.`,
      { package: devClass, allowPackages: [...allowPackages] },
      `A transport request can only be created for a TRANSPORTABLE (non-$) package, and that ` +
        `package must ALSO be named by ABAP_ALLOW_PACKAGES — currently [${allowList}]` +
        (onlyLocal
          ? `, which names local packages only. On this configuration create therefore has no ` +
            `satisfiable input: a local package is refused here, and every transportable package ` +
            `is refused by the package allowlist. That is the configuration, not a defect — an ` +
            `operator who adds a transportable package (ABAP_ALLOW_PACKAGES=$TMP,ZFOO, with the ` +
            `name also inside ABAP_ALLOW_NAME_PREFIXES) makes it reachable.`
          : `. Retry with a transportable package from that list; its name must also be inside ` +
            `ABAP_ALLOW_NAME_PREFIXES.`),
    );
  }
  // Package gating for create, both fail-closed:
  // (a) The target package must be allowlisted — a request is the container
  //     every subsequent write into `devClass` is recorded in, so an
  //     empty (explicitly denied) ABAP_ALLOW_PACKAGES refuses create exactly
  //     as it refuses a write.
  // (b) The package name is passed as `name` too, so ABAP_ALLOW_NAME_PREFIXES
  //     also judges it (can only narrow (a), never widen it); the refusal
  //     text below is reworded since the generic object-name-rule wording is
  //     misleading for a create.
  //
  // `{kind:"unresolved"}` (not the omitted-corr default): supplying an object
  // here means the pin-rule step now fires, so this preserves the deny-all
  // refusal while dropping the pin refusal (the created request is a
  // container, not a recording).
  const decision = gate.evaluate(
    "transport",
    { name: devClass, packageName: devClass },
    { corr: { kind: "unresolved" } },
  );
  if (!decision.allowed) {
    const nameRule = decision.rule === "object-name allowlist";
    throw new AbapError(
      decision.code ?? "READ_ONLY",
      nameRule
        ? `Package ${devClass} is outside the allowed object-name prefixes, so no transport ` +
          `request may be created for it. Creating a request commits this server to recording ` +
          `writes into ${devClass}, so the same name rule that governs those writes governs the ` +
          `container. Widen ABAP_ALLOW_NAME_PREFIXES or pick a package inside it.`
        : decision.reason,
      {
        operation: "create",
        rule: decision.rule,
        package: devClass,
        object: devClass,
        allowPackages: [...(gate?.config?.allowPackages ?? [])],
      },
      // Other half of the pair at the `$`-package refusal above: a caller
      // refused here must not conclude a LOCAL package is the way round it.
      `Creating a transport request needs ${writeAccessHint(gate)}, the target package in ` +
        "ABAP_ALLOW_PACKAGES, and a package name inside ABAP_ALLOW_NAME_PREFIXES. " +
        "Retrying with a local package ($TMP, or any $-prefixed package) is NOT a way round this: " +
        "create refuses those outright — local objects are never transported, so there is nothing " +
        "to create. The only satisfiable input is a TRANSPORTABLE package that is itself " +
        "allowlisted, so if ABAP_ALLOW_PACKAGES names local packages only, no input to create can " +
        "succeed until an operator widens it.",
    );
  }

  // Re-runs the same `evaluate()` as `decision` (guaranteed to succeed,
  // already checked) — `authorize()` is the only sanctioned way to construct
  // the `AuthorizedTarget` `trCreate` requires.
  const authorized = gate.authorize(
    "transport",
    { name: devClass, packageName: devClass },
    { corr: { kind: "unresolved" } },
  );

  // `kind === "copies"` branches out here, AFTER the shared preamble above (devClass/
  // description validation, the `$`-package refusal, and the `evaluate`/`authorize` pair) but
  // BEFORE the workbench-only anchor resolution below — so a transport of copies gets the
  // identical gate decision a workbench create gets, never a second, potentially-diverging
  // `evaluate`/`authorize` call, and the workbench path below is reached only when this branch
  // is not taken, unchanged from before this feature existed.
  if (input.kind === "copies") {
    return await createCopies(
      conn,
      gate,
      maxChars,
      journal,
      ownership,
      input,
      devClass,
      description,
      authorized,
    );
  }

  const anchor = (input.object ?? "").trim();
  const objSourceUrl =
    anchor === ""
      ? `/sap/bc/adt/packages/${encodeURIComponent(devClass.toLowerCase())}`
      : (await resolveObject(conn, anchor)).uri;

  let created: TrCreated;
  try {
    created = await trCreate(conn, { objSourceUrl, description, devClass }, authorized);
  } catch (e) {
    // A failed create is not proof nothing happened — a timeout can lose the response after
    // the server already acted. Recovery is best-effort and swallows its own failures; when it
    // finds nothing, the original error is rethrown completely unchanged (required: a lookup
    // that can't find evidence must not invent a different failure).
    const candidates = await recoverPossiblyCreated(conn, description);
    if (candidates.length === 0) throw e;
    // Ownership BEFORE the throw, and on this path too — not just the success path below.
    // The server may already have created the request; if it did, it is as much this
    // session's as one whose response arrived, and the release guard must not later demand
    // confirm_unowned for a request this call in fact created. Nothing after a `throw`
    // runs, so this is the only place it can go.
    //
    // Only an unambiguous recovery is noted. With several matches at most one is really
    // ours, so noting them all would spend the confirm_unowned guarantee on the others —
    // and the match is only user+modifiable+workbench+exact description, which collides in
    // practice. The ambiguous case is deliberately left unowned: the caller still gets the
    // full list below, and a later release names the exact confirm_unowned to pass.
    if (candidates.length === 1) ownership?.noteCreated(candidates[0]!);
    const originalDetails = e instanceof AbapError ? e.details : {};
    const code = e instanceof AbapError ? e.code : "TRANSPORT_ERROR";
    const cause = e instanceof Error ? e.message : String(e);
    const sid = conn.cfg.sid;
    const n = candidates.length;
    const list = candidates.join(", ");
    const first = candidates[0];
    throw new AbapError(
      code,
      `Creating a transport request for ${devClass} failed, but ${n === 1 ? "a modifiable request that matches this create already exists" : `${n} modifiable requests that match this create already exist`} on ${sid}: ${list}. abapsmith cannot prove ${n === 1 ? "it came" : "they came"} from this call — but a create that fails AFTER the server has already acted looks exactly like this, so do NOT treat this as "nothing happened". The original failure was: ${cause}`,
      { ...originalDetails, possiblyCreated: candidates, operation: "create", package: devClass, description },
      `Check before creating another request: abap_transport operation="show" transport="${first}" tells you what ${first} actually is, and abap_transport operation="list" shows every request owned by this user. If one of them is the request this call meant to create, pass it as the transport on subsequent writes instead of creating a second one.`,
    );
  }
  // A request this session created by hand is as much this session's as an
  // auto-created one — later auto-resolution prefers it (see SessionTrOwner).
  // Outside the try: the try body is kept to the one call whose failure the
  // catch is written to interpret, so a throw from here could never be
  // mistaken for trCreate failing and send us into recovery.
  ownership?.noteCreated(created.trkorr);
  // JOURNAL — after the POST, awaited before the number is handed back.
  // No request number exists before the POST, so an early entry would file a
  // phantom for every refused creation. ACCEPTED FAILURE: a crash between the
  // server confirming and the entry landing leaves an unrecorded request.
  // `beforeCapture` stays "unknown" (begin()'s default), not
  // "confirmed-absent" — only that explicit value may authorise an
  // undo-by-delete, and nothing was checked before creating.
  await recordMutation(
    journal,
    {
      operation: "transport-create",
      trkorr: created.trkorr,
      description,
      package: devClass,
      existedBefore: false,
      tool: "abap_transport create",
    },
    { kind: "succeeded" },
  );
  const notes = [
    `Created ${created.trkorr}. Pass it as the transport on subsequent writes.`,
  ];
  if (anchor === "") {
    notes.push(
      "No object was given, so the package URI was used as the request's reference object. " +
        "If the server rejects that, retry with object: <an object in the package>.",
    );
  }
  return buildResponse({
    header: {
      operation: "create",
      transport: created.trkorr,
      package: devClass,
      description,
      reference: objSourceUrl,
    },
    notes,
    maxChars,
  });
}

/**
 * {@link recoverPossiblyCreated}, adapted for a transport of copies: that function filters on
 * `kind === "workbench"`, which a copies request never matches — its own `kind` is
 * `"transport-of-copies"` (see `TrKind`, src/adt/transports.ts) — so it cannot be reused
 * unmodified. Also matched on `target`: a transport of copies is only a plausible match for
 * THIS call's request when it carries the same destination, not just the same description.
 */
async function recoverPossiblyCreatedCopies(
  conn: AbapConnection,
  description: string,
  target: string,
): Promise<string[]> {
  try {
    const user = (conn.cfg.user ?? "").trim();
    const res = await trList(conn, user ? { user } : {});
    return res.workbench
      .filter((r) => r.kind === "transport-of-copies" && r.status === "modifiable")
      .filter((r) => r.description === description && (r.target ?? "").toUpperCase() === target)
      .map((r) => r.trkorr);
  } catch {
    return [];
  }
}

/**
 * The `kind === "copies"` half of `operation: "create"` — split out of `opCreate` once the
 * shared preamble (package/description validation and the gate `evaluate`/`authorize` pair)
 * has run, so both paths are governed by the identical authorization decision. Takes the
 * already-minted `authorized` rather than re-deriving it, for the same reason.
 */
async function createCopies(
  conn: AbapConnection,
  gate: SafetyGate,
  maxChars: number,
  journal: TransportJournalDeps | undefined,
  ownership: SessionTrOwner | undefined,
  input: TransportInput,
  devClass: string,
  description: string,
  authorized: AuthorizedTarget<"transport", { name: string; packageName?: string }>,
): Promise<BuiltResponse> {
  const target = (input.target ?? "").trim().toUpperCase();
  if (target === "") {
    throw new AbapError(
      "BAD_INPUT",
      'Operation "create" with kind "copies" needs "target": a transport of copies with no ' +
        "target cannot be imported anywhere, so abapsmith refuses to create one.",
      { operation: "create", kind: "copies", arg: "target" },
    );
  }
  const anchor = (input.object ?? "").trim();
  if (anchor !== "") {
    throw new AbapError(
      "BAD_INPUT",
      'Operation "create" with kind "copies" does not take "object": a transport of copies is ' +
        "created empty and objects are added to it afterwards, so the anchor object a " +
        "workbench create uses does not apply here.",
      { operation: "create", kind: "copies", arg: "object" },
    );
  }

  let copies: TransportOfCopiesResult;
  try {
    copies = await createTransportOfCopiesViaBridge(
      conn,
      gate,
      { description, target, devClass },
      authorized,
    );
  } catch (e) {
    // Same failure mode `trCreate`'s catch above guards against — a client-side timeout can
    // arrive AFTER the server already created the request. `recoverPossiblyCreated` itself
    // can't be reused here (see `recoverPossiblyCreatedCopies`'s doc comment), so its
    // copies-specific counterpart is used instead.
    const candidates = await recoverPossiblyCreatedCopies(conn, description, target);
    if (candidates.length === 1) {
      const candidate = candidates[0]!;
      // Ownership BEFORE the throw, same reasoning as the workbench path: if the server really
      // did create this, it is as much this session's as one whose response arrived.
      ownership?.noteCreated(candidate);
      // Unlike the workbench recovery above — which notes ownership but never journals on
      // failure, because an ambiguous or absent candidate leaves no trkorr to file an entry
      // under — an UNAMBIGUOUS candidate here does have a number, so it CAN be journalled. But
      // neither terminal verdict would be honest: `succeeded` would claim this call created it
      // when the match is only owner+modifiable+transport-of-copies+description+target (a
      // coincidence, however unlikely, is possible), and `failed` would claim nothing happened
      // when the request may be exactly the one this call just created. `unproven` is the only
      // verdict that doesn't overstate what this recovery lookup actually established.
      await recordMutation(
        journal,
        {
          operation: "transport-create",
          trkorr: candidate,
          description,
          package: devClass,
          existedBefore: false,
          tool: "abap_transport create kind=copies",
        },
        {
          kind: "unproven",
          reason:
            `createTransportOfCopiesViaBridge failed (${e instanceof Error ? e.message : String(e)}), ` +
            "but a modifiable transport of copies matching this call's description and target " +
            `already exists on ${conn.cfg.sid}: ${candidate}.`,
        },
      );
    }
    const originalDetails = e instanceof AbapError ? e.details : {};
    const code = e instanceof AbapError ? e.code : "TRANSPORT_ERROR";
    const cause = e instanceof Error ? e.message : String(e);
    const sid = conn.cfg.sid;
    const n = candidates.length;
    if (n === 0) {
      throw new AbapError(
        code,
        `Creating a transport of copies for ${devClass} → ${target} failed: ${cause}`,
        {
          ...originalDetails,
          operation: "create",
          kind: "copies",
          package: devClass,
          target,
          description,
        },
      );
    }
    const list = candidates.join(", ");
    const first = candidates[0];
    throw new AbapError(
      code,
      `Creating a transport of copies for ${devClass} → ${target} failed, but ${n === 1 ? "a modifiable transport of copies that matches this create already exists" : `${n} modifiable transports of copies that match this create already exist`} on ${sid}: ${list}. abapsmith cannot prove ${n === 1 ? "it came" : "they came"} from this call — but a create that fails AFTER the server has already acted looks exactly like this, so do NOT treat this as "nothing happened". The original failure was: ${cause}`,
      {
        ...originalDetails,
        possiblyCreated: candidates,
        operation: "create",
        kind: "copies",
        package: devClass,
        target,
        description,
      },
      `Check before creating another: abap_transport operation="show" transport="${first}" tells you what ${first} actually is.`,
    );
  }

  // A request this session created by hand is as much this session's as an auto-created one.
  ownership?.noteCreated(copies.trkorr);
  // JOURNAL — after the POST, same reasoning as the workbench path: no request number exists
  // before it, so an early entry would file a phantom for every refused creation.
  await recordMutation(
    journal,
    {
      operation: "transport-create",
      trkorr: copies.trkorr,
      description,
      package: devClass,
      existedBefore: false,
      tool: "abap_transport create kind=copies",
    },
    { kind: "succeeded" },
  );

  return buildResponse({
    header: {
      operation: "create",
      kind: categoryTitle("transportOfCopies"),
      transport: copies.trkorr,
      trFunction: fmtTrFunction(copies.trFunction),
      trStatus: fmtTrStatus(copies.trStatus),
      package: devClass,
      description,
      target: copies.target,
      owner: copies.owner,
      tasks: copies.tasks,
    },
    notes: [
      `Created ${copies.trkorr}, a TRANSPORT OF COPIES targeting ${copies.target}. It was ` +
        "created empty; add objects to it the same way as any other request, then pass it as " +
        "the transport on writes whose changes should be copied there.",
      "The objects' original request is untouched and they stay modifiable in this system — a " +
        "transport of copies carries a snapshot to the target; it does not move or freeze the " +
        "originals.",
      "A transport of copies has no tasks (observed live on A4H on 2026-09-15: zero task headers).",
    ],
    maxChars,
  });
}

// A status-bearing refusal means SAP answered "no" and changed nothing; only a
// session death or a response lost before any status was seen may have landed.
function mutationMayHaveLanded(e: unknown): e is AbapError {
  return (
    e instanceof AbapError &&
    (e.code === "SESSION_DEAD" || (e.code === "TRANSPORT_ERROR" && e.details.status === undefined))
  );
}

// Same shape as discloseBridgeResidue in run.ts: a new error, same code and
// message, hint extended — never invents a verdict the caller didn't earn.
function discloseUnprovenMutation(e: AbapError, trkorr: string): AbapError {
  const residueHint =
    `Whether this reached ${trkorr} is unknown — the response was lost, not refused. ` +
    `Its journal entry stays \`pending\`; re-check with abap_transport {"operation":"show"} ` +
    "before retrying.";
  const disclosed = new AbapError(
    e.code,
    e.message,
    { ...e.details, trkorr },
    e.hint ? `${e.hint} ${residueHint}` : residueHint,
  );
  disclosed.stack = e.stack;
  disclosed.cause = e.cause;
  return disclosed;
}

async function opAddUser(
  conn: AbapConnection,
  input: TransportInput,
  maxChars: number,
  gate: SafetyGate,
  journal?: TransportJournalDeps,
): Promise<BuiltResponse> {
  const trkorr = normTrkorr(input.transport, "addUser", input.object);
  const user = required(input.user, "user", "addUser").toUpperCase();
  assertCeiling(gate, "plain", "addUser");
  // Guaranteed to succeed: assertCeiling above already threw on denial via
  // the same object-less evaluate() call authorizeCeiling makes internally.
  const proof = authorizeCeiling(gate, "transport");
  let res: TrAddUserResult;
  try {
    res = await trAddUser(conn, trkorr, user, proof);
  } catch (e) {
    // A plain refusal (SAP said no) leaves this untouched — see the ACCEPTED
    // FAILURE note below. Only a lost response gets a pending journal entry.
    if (!mutationMayHaveLanded(e)) throw e;
    await recordMutation(
      journal,
      {
        operation: "transport-add-user",
        trkorr,
        description: `addUser ${user} — POST response lost, outcome unproven`,
        existedBefore: true,
        beforeCapture: "unknown",
        tool: "abap_transport addUser",
      },
      { kind: "unproven", reason: e.message },
    );
    throw discloseUnprovenMutation(e, trkorr);
  }
  // JOURNAL — after the POST: trAddUser throws on non-2xx (a pre-entry would
  // record refusals that changed nothing), and the minted task number doesn't
  // exist until the POST returns. ACCEPTED FAILURE: a crash between POST and
  // entry leaves an unrecorded task — recoverable via operation "show".
  await recordMutation(
    journal,
    {
      operation: "transport-add-user",
      trkorr: res.trkorr,
      description: res.task
        ? `addUser ${res.user} → task ${res.task}`
        : `addUser ${res.user} (the server reported no task)`,
      existedBefore: true,
      // Ideally the request's current task/user list, but no GET is made for
      // this — "unknown" claims no provenance without falsely implying a
      // read was attempted and failed.
      beforeCapture: "unknown",
      tool: "abap_transport addUser",
    },
    { kind: "succeeded" },
  );
  return buildResponse({
    header: {
      operation: "addUser",
      transport: res.trkorr,
      user: res.user,
      task: res.task ?? "(none reported)",
    },
    notes: res.task
      ? [`${user} now owns task ${res.task} in ${res.trkorr}.`]
      : [
          `The server reported no task for ${user}. Run operation "show" to see what actually exists.`,
        ],
    maxChars,
  });
}

async function opSetOwner(
  conn: AbapConnection,
  input: TransportInput,
  maxChars: number,
  gate: SafetyGate,
  journal?: TransportJournalDeps,
): Promise<BuiltResponse> {
  const trkorr = normTrkorr(input.transport, "setOwner", input.object);
  const user = required(input.user, "user", "setOwner").toUpperCase();
  assertCeiling(gate, "plain", "setOwner");
  const proof = authorizeCeiling(gate, "transport");
  let res: TrSetOwnerResult;
  try {
    res = await trSetOwner(conn, trkorr, user, proof);
  } catch (e) {
    if (!mutationMayHaveLanded(e)) throw e;
    await recordMutation(
      journal,
      {
        operation: "transport-set-owner",
        trkorr,
        description: `setOwner ${user} — PUT response lost, outcome unproven`,
        existedBefore: true,
        beforeCapture: "unknown",
        tool: "abap_transport setOwner",
      },
      { kind: "unproven", reason: e.message },
    );
    throw discloseUnprovenMutation(e, trkorr);
  }
  // JOURNAL — after the PUT, same reasoning as addUser. ACCEPTED FAILURE: a
  // crash between PUT and entry loses the record — recoverable via "show".
  // NOT recoverable: the PREVIOUS owner (would be the before image, never
  // read here, and not invented).
  await recordMutation(
    journal,
    {
      operation: "transport-set-owner",
      trkorr: res.trkorr,
      description: `setOwner → ${res.owner}`,
      existedBefore: true,
      beforeCapture: "unknown",
      tool: "abap_transport setOwner",
    },
    { kind: "succeeded" },
  );
  return buildResponse({
    header: { operation: "setOwner", transport: res.trkorr, owner: res.owner },
    maxChars,
  });
}

async function opDelete(
  conn: AbapConnection,
  input: TransportInput,
  maxChars: number,
  gate: SafetyGate,
  journal?: TransportJournalDeps,
): Promise<BuiltResponse> {
  const trkorr = normTrkorr(input.transport, "delete", input.object);
  const confirm = input.confirm;
  if (confirm === undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `Deleting ${trkorr} is irreversible. To delete, call again with confirm: "${trkorr}"`,
      { transport: trkorr },
    );
  }
  if (confirm.trim().toUpperCase() !== trkorr) {
    throw new AbapError("BAD_INPUT", "confirm must echo the transport number exactly", {
      transport: trkorr,
      confirm,
    });
  }
  // Gated by the admin-mode-only allowTransportDelete ceiling, not just the
  // plain readOnly check (SafetyConfig.allowTransportDelete, src/safety.ts).
  assertCeiling(gate, "delete", "delete");
  // "transport", not "delete": the object-less ceiling shortcut in
  // SafetyGate.evaluate only fires for op "transport", and authorizeCeiling's
  // CeilingGate type doesn't know deleteTransport at all. Still safe: the
  // assertCeiling above already proved the strictly stronger condition
  // (readOnly false AND allowTransportDelete true), so this opts-less
  // re-check — which only needs readOnly false — is guaranteed to pass.
  const proof = authorizeCeiling(gate, "transport");
  let res: TrDeleteResult;
  try {
    res = await trDelete(conn, trkorr, proof);
  } catch (e) {
    throw await diagnoseLockedDelete(conn, trkorr, e);
  }
  // JOURNAL — after the DELETE. `existedBefore` is REQUIRED by begin() and
  // can't be patched by settle(), and only `trDelete`'s own internal probe
  // establishes it (CTS returns a byte-identical empty 200 whether the
  // request existed or not) — a pre-entry would have to guess it permanently,
  // and a separate pre-read would create a second source of truth that could
  // disagree with the one `trDelete` acted on. ACCEPTED FAILURE: a crash
  // between DELETE and entry leaves a destroyed request with no record.
  await recordMutation(
    journal,
    {
      operation: "transport-delete",
      trkorr: res.trkorr,
      description: deleteVerdict(res),
      existedBefore: res.existedBefore,
      // trDelete's probe positively READ the absence ("confirmed-absent");
      // when it existed, this layer holds none of the probe's bytes, so no
      // before-image provenance is claimed.
      beforeCapture: res.existedBefore ? "unknown" : "confirmed-absent",
      tool: "abap_transport delete",
    },
    deleteJournalVerdict(res),
  );
  return buildResponse({
    header: {
      operation: "delete",
      transport: res.trkorr,
      verdict: deleteVerdict(res),
      existedBefore: res.existedBefore,
      gone: res.gone,
      verified: res.verified,
      httpStatus: res.httpStatus,
    },
    notes: deleteNotes(res),
    maxChars,
  });
}

/**
 * Drop one E071 row (plus its CTS lock) from a request/task, so a request
 * holding an entry for an already-deleted object can afterwards be deleted.
 * Order matters: every refusal below (bad input, missing confirm, ceiling,
 * NOT_FOUND) costs zero network requests, let alone mutations.
 */
async function opRemoveObject(
  conn: AbapConnection,
  input: TransportInput,
  maxChars: number,
  gate: SafetyGate,
  journal?: TransportJournalDeps,
): Promise<BuiltResponse> {
  const trkorr = normTrkorr(input.transport, "removeObject", input.object);
  const objectName = required(input.object, "object", "removeObject").trim().toUpperCase();
  const confirm = input.confirm;
  if (confirm === undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `Removing ${objectName} from ${trkorr} is destructive. To remove, call again with confirm: "${trkorr}"`,
      { transport: trkorr, object: objectName },
    );
  }
  if (confirm.trim().toUpperCase() !== trkorr) {
    throw new AbapError("BAD_INPUT", "confirm must echo the transport number exactly", {
      transport: trkorr,
      confirm,
    });
  }
  // Same admin-only allowTransportDelete ceiling as "delete": removing a CTS
  // row is destructive and, unlike an ordinary write, not undoable.
  assertCeiling(gate, "delete", "removeObject");
  // "transport", not "delete" — same reasoning as opDelete's own re-check;
  // the assertCeiling above already proved the strictly stronger condition.
  const proof = authorizeCeiling(gate, "transport");
  // First network call, a read: NOT_FOUND propagates unchanged, before any mutation.
  const holder: TrEntryHolder = await trFindEntryHolder(conn, trkorr, objectName);
  // Removing the entry drops CTS's lock unconditionally — this settles what that lock is
  // actually protecting before it's gone. Never blocks the removal on the answer.
  const objectOnSystem = await probeObjectOnSystem(conn, holder.rows);
  let res: TransportEntryRemoveResult;
  try {
    res = await removeTransportEntryViaBridge(conn, gate, { trkorr: holder.trkorr, objectName }, proof);
  } catch (e) {
    // The ABAP loop can fail after removing one row, so a bare rethrow would
    // leave a real mutation unrecorded — but most failures here are refusals
    // that removed nothing (CTS_DUPLICATE_ENTRY, NOT_FOUND), and leaving
    // THOSE `pending` makes `abap_journal mode=list` call them STRANDED,
    // which tells the operator nobody knows whether the write landed when in
    // fact nothing did. `removalTouchedNothing` reads the transcript for
    // that difference: proven-untouched settles `failed`, everything else
    // stays `unproven`.
    const touchedNothing = removalTouchedNothing(e);
    await recordMutation(
      journal,
      {
        operation: "transport-remove-object",
        trkorr: holder.trkorr,
        description: touchedNothing
          ? `removeObject ${objectName} from ${holder.trkorr} — refused, nothing was removed`
          : `removeObject ${objectName} from ${holder.trkorr}`,
        existedBefore: true,
        beforeCapture: "captured",
        beforeSource: removeObjectBeforeImage(holder),
        tool: "abap_transport removeObject",
      },
      touchedNothing
        ? { kind: "failed", reason: `Refused, nothing was removed: ${(e as Error).message}` }
        : { kind: "unproven", reason: (e as Error).message },
    );
    throw enrichRemovalRefusal(e, objectOnSystem);
  }
  await recordMutation(
    journal,
    {
      operation: "transport-remove-object",
      trkorr: res.holder,
      description: `removeObject ${objectName} from ${res.holder}`,
      existedBefore: true,
      beforeCapture: "captured",
      beforeSource: removeObjectBeforeImage(holder),
      tool: "abap_transport removeObject",
    },
    { kind: "succeeded" },
  );
  const notes: string[] = [];
  if (res.holder !== trkorr) {
    notes.push(`${objectName} lived on ${res.holder}, a task of the request you passed (${trkorr}).`);
  }
  if (res.removed.length > 0) {
    notes.push(
      "Removed: " + res.removed.map((r) => `${r.pgmid} ${r.object} ${r.name}`).join(", ") + ".",
    );
  }
  for (const c of res.collapsed) {
    notes.push(
      `Collapsed ${c.rows} duplicate E071 rows for ${c.pgmid} ${c.object} ${c.name} ` +
        `(AS4POS ${c.positions.join(", ")}) to one row before removing it.`,
    );
  }
  notes.push(
    `This only removes the entry — it does not say ${res.holder} is now deletable. ` +
      'Follow up with operation "delete" to find out.',
  );
  if (objectOnSystem === "present") {
    notes.push(
      `${objectName} still exists on the system — removing this entry stripped CTS's lock ` +
        "from a live object. The object itself is untouched, but the request no longer " +
        "records the change, and the object is no longer protected against being edited " +
        "under a different request.",
    );
  } else if (objectOnSystem === "unknown") {
    notes.push(
      `Could not settle whether ${objectName} still exists on the system — do not read this as "gone".`,
    );
  }
  return buildResponse({
    header: {
      operation: "removeObject",
      transport: trkorr,
      holder: res.holder,
      object: objectName,
      objectOnSystem,
      removedCount: res.removed.length,
      collapsedRows: res.collapsed.reduce((sum, c) => sum + (c.rows - 1), 0),
      gone: res.transcript.tags.includes("TREN-GONE"),
    },
    notes,
    maxChars,
  });
}

/** Rows past this cap are reported "unknown", not guessed at — removeObject usually sees one. */
const OBJECT_ON_SYSTEM_PROBE_CAP = 5;

/**
 * Does the object an E071 entry names still exist? `removeObject` drops CTS's lock
 * unconditionally, so this is what tells the caller whether that lock was still guarding a
 * live object. Same probe, same fail-closed contract as `diagnoseLockedDelete`'s: a throw
 * is "unknown", never a guessed yes/no.
 */
async function probeObjectOnSystem(
  conn: AbapConnection,
  rows: readonly TrObject[],
): Promise<"present" | "absent" | "unknown"> {
  let present = 0;
  let absent = 0;
  let unknown = 0;
  for (const [i, row] of rows.entries()) {
    if (i >= OBJECT_ON_SYSTEM_PROBE_CAP) {
      unknown++;
      continue;
    }
    try {
      const hits = await searchExact(conn, row.name, row.wbType);
      if (hits.length > 0) present++;
      else absent++;
    } catch {
      unknown++;
    }
  }
  if (present > 0) return "present";
  if (unknown > 0) return "unknown";
  return absent > 0 ? "absent" : "unknown";
}

const COMM_OBJECT_KEYS_HINT =
  "The entry and its CTS lock are still on the request — it cannot be deleted while they are. " +
  'If the refusal names a lock or an owner, SE03\'s "Unlock Objects (Expert Tool)" is the tool ' +
  "for that — it does nothing for the duplicate-row guard (TR 292), which counts E071 rows, " +
  "not locks. Every remaining route is outside abapsmith and not guaranteed to succeed: edit " +
  "the request's object list in SE09/SE10; or release the request (irreversible). " +
  "The msg= fragment in the message above is the T100 message CTS itself raised — it may be " +
  "blank (a function module that raises with a bare RAISE sets no message) — but quote it " +
  "when reporting this failure.";

/**
 * A late TR_DELETE_COMM_OBJECT_KEYS failure has no AS4POS values to report — unlike the
 * bridge's own pre-check, which counted the rows before calling the FM.
 */
const LATE_DUPLICATE_ENTRY_HINT =
  "The request holds two or more E071 rows for this object (same PGMID+OBJECT+OBJ_NAME) — " +
  "E071's key is TRKORR+AS4POS, not object identity, so this is legal, but abapsmith cannot " +
  "say which action produced the extra row, and TR_DELETE_COMM_OBJECT_KEYS refuses to pick " +
  "one to drop. The entry and its lock are still on the request. Every remaining route is " +
  "outside abapsmith and not guaranteed to succeed: edit the request's object list in " +
  "SE09/SE10; or release the request (irreversible).";

/**
 * `new AbapError(...)` can't accept a prior stack/cause, so a reconstruction loses both unless
 * they are copied over. `retryable` needs no such care here: it is
 * `options?.retryable ?? defaultRetryable(code)`, and nothing that throws on these two paths
 * passes `options`, so re-deriving it from the code gives the same answer the original had —
 * and where the code deliberately changes (the TR 292 reclassification below), re-deriving is
 * the point, since the new code's own default must win.
 */
function carryOrigin(fresh: AbapError, origin: AbapError): AbapError {
  fresh.stack = origin.stack;
  fresh.cause = origin.cause;
  return fresh;
}

/**
 * Both shapes of CTS's comm-object-keys refusal: the bridge's own pre-check throwing
 * `CTS_DUPLICATE_ENTRY` (its message and hint already name the duplicate rows — this only
 * attaches `objectOnSystem`), and a `CHECK_FAILED` that reached `TR_DELETE_COMM_OBJECT_KEYS`
 * itself, which raises the same guard (`MESSAGE e292(tr)`, rendered `msg=E TR 292`) at 2+ E071
 * rows for one PGMID+OBJECT+OBJ_NAME — E071's key is TRKORR+AS4POS, not object identity, so
 * duplicate rows are legal, though what produces them is not established. That late case is
 * reclassified as `CTS_DUPLICATE_ENTRY`; any other CHECK_FAILED naming the FM keeps its code and
 * gets the generic hint appended. Any other error is returned unchanged.
 */
function enrichRemovalRefusal(e: unknown, objectOnSystem: "present" | "absent" | "unknown"): unknown {
  if (!(e instanceof AbapError)) return e;
  if (e.code === "CTS_DUPLICATE_ENTRY") {
    return carryOrigin(new AbapError(e.code, e.message, { ...e.details, objectOnSystem }, e.hint), e);
  }
  if (e.code !== "CHECK_FAILED" || !e.message.includes("TR_DELETE_COMM_OBJECT_KEYS")) return e;
  if (e.message.includes("msg=E TR 292")) {
    // Reclassified to a different code, so CTS_DUPLICATE_ENTRY's own "terminal" default applies
    // rather than CHECK_FAILED's "conditional" one — the refusal really is terminal.
    return carryOrigin(
      new AbapError(
        "CTS_DUPLICATE_ENTRY",
        e.message,
        { ...e.details, objectOnSystem },
        [e.hint, LATE_DUPLICATE_ENTRY_HINT].filter((h): h is string => h !== undefined).join(" "),
      ),
      e,
    );
  }
  return carryOrigin(
    new AbapError(
      e.code,
      e.message,
      { ...e.details, objectOnSystem },
      [e.hint, COMM_OBJECT_KEYS_HINT].filter((h): h is string => h !== undefined).join(" "),
    ),
    e,
  );
}

/**
 * The before image for a removeObject mutation: the resolved holder and the
 * exact E071 row(s) about to be dropped — not undoable, so this is the only
 * record of what they were.
 */
function removeObjectBeforeImage(holder: TrEntryHolder): string {
  return JSON.stringify({
    trkorr: holder.trkorr,
    requested: holder.requested,
    rows: holder.rows.map((r) => ({ pgmid: r.pgmid, type: r.type, name: r.name, locked: r.locked })),
  });
}

/** One locked-request entry plus what a re-probe found for it. */
interface LockedEntryDiagnosis {
  pgmid: string;
  type: string;
  name: string;
  locked: boolean;
  /** "unknown" if the probe threw or was never attempted (truncated census) — never read as "gone". */
  object: "present" | "absent" | "unknown";
}

/** Locked entries this pass didn't probe (past the cap) — reported, not guessed at. */
const LOCKED_PROBE_CAP = 10;

/**
 * `trDelete` threw TRANSPORT_LOCKED. The census below says WHICH entries are
 * locked and whether they still exist — that's what tells the caller whether
 * `removeObject` is the right next move, instead of repeating false advice.
 * Any other error, or a re-read that itself fails, passes `e` through unchanged.
 */
async function diagnoseLockedDelete(conn: AbapConnection, trkorr: string, e: unknown): Promise<unknown> {
  if (!(e instanceof AbapError) || e.code !== "TRANSPORT_LOCKED") return e;
  const req = await trShow(conn, trkorr).catch(() => undefined);
  if (!req) return e;

  const unioned = unionedObjects(req);
  const locked = unioned.filter((o) => o.locked);

  const entries: LockedEntryDiagnosis[] = [];
  for (const obj of locked) {
    const base = { pgmid: obj.pgmid, type: obj.type, name: obj.name, locked: true as const };
    if (entries.length >= LOCKED_PROBE_CAP) {
      entries.push({ ...base, object: "unknown" });
      continue;
    }
    let object: LockedEntryDiagnosis["object"];
    try {
      const hits = await searchExact(conn, obj.name, obj.wbType);
      object = hits.length > 0 ? "present" : "absent";
    } catch {
      object = "unknown"; // could not look (no conn.adt in some contexts, or search itself failed) — do not invent a yes/no
    }
    entries.push({ ...base, object });
  }

  return new AbapError(
    e.code,
    e.message,
    { ...e.details, trkorr, entries, lockedCount: locked.length, entryCount: unioned.length },
    lockedDeleteHint(entries, lockedMessageDiscrepancy(e.message, trkorr, req)),
  );
}

/** SAP TRKORR shape: 3-char system id + K + 6 digits, e.g. A4HK900222. */
const TRKORR_TOKEN_RE = /\b[A-Z][A-Z0-9]{2}K\d{6}\b/g;

/**
 * SAP's locked-delete message can name a different number than the one the caller passed
 * (live: message said task A4HK900223, `details.trkorr` said request A4HK900222 — no way to
 * tell which to act on). States the relationship as fact only when it's provable — the named
 * number is one of `req.tasks` — otherwise flags a bare discrepancy without calling it a task.
 */
function lockedMessageDiscrepancy(message: string, trkorr: string, req: TrRequest): string | undefined {
  const named = new Set(
    (message.match(TRKORR_TOKEN_RE) ?? []).map((s) => s.toUpperCase()).filter((n) => n !== trkorr),
  );
  if (named.size === 0) return undefined;
  const taskNumbers = new Set(req.tasks.map((t) => t.trkorr));
  const asTask = [...named].find((n) => taskNumbers.has(n));
  if (asTask) {
    return (
      `SAP's message names ${asTask}, a task of ${trkorr} — the request you passed. ${trkorr} is ` +
      `the number to act on; the diagnosis below already covers ${asTask}.`
    );
  }
  return `SAP's message names ${[...named][0]}, a different number than the ${trkorr} you passed.`;
}

function lockedDeleteHint(entries: LockedEntryDiagnosis[], discrepancy?: string): string {
  const prefix = discrepancy ? `${discrepancy} ` : "";
  return prefix + lockedDeleteBaseHint(entries);
}

function lockedDeleteBaseHint(entries: LockedEntryDiagnosis[]): string {
  const exits =
    "The only real exits: abap_transport " +
    "operation \"removeObject\" with object = the entry's name and confirm = the request " +
    "number (admin mode only); release the request (irreversible); or in SE03 run " +
    "\"Unlock Objects (Expert Tool)\" and then handle it by hand in SE09/SE10.";
  if (entries.length === 0) {
    return `A re-read found no locked entries, yet the server still refused the delete. ${exits} Check SE09/SE10 for this request's actual state.`;
  }
  const present = entries.filter((entry) => entry.object === "present");
  const absent = entries.filter((entry) => entry.object === "absent");
  if (present.length === 0 && absent.length === entries.length) {
    return `Every locked entry (${absent.map((entry) => entry.name).join(", ")}) is a leftover of an already-deleted object — deleting it again will not clear the lock. ${exits}`;
  }
  if (present.length > 0) {
    const names = present.slice(0, 5).map((entry) => entry.name);
    const rest = present.length > 5 ? ` (+${present.length - 5} more)` : "";
    return `Locked and still present: ${names.join(", ")}${rest}. ${exits}`;
  }
  return `Could not settle whether the locked entries still exist as objects — do not treat this as "gone". ${exits}`;
}

function deleteVerdict(res: TrDeleteResult): string {
  if (!res.existedBefore) return "NO SUCH REQUEST — nothing was deleted";
  if (res.verified && res.gone) return "DELETED — confirmed gone";
  if (res.verified && !res.gone) return "NOT DELETED — the request still exists";
  return "COULD NOT VERIFY — the delete may or may not have taken effect";
}

/**
 * The journal's version of `deleteVerdict`, same words, so an entry never
 * reads stronger than what the tool told the user. `!existedBefore` is
 * journalled, not skipped — a DELETE was still sent — as `failed`, with
 * `existedBefore: false` on the entry making the non-event unmistakable.
 */
function deleteJournalVerdict(res: TrDeleteResult): JournalVerdict {
  const verdict = deleteVerdict(res);
  if (!res.existedBefore) return { kind: "failed", reason: verdict };
  if (res.verified && res.gone) return { kind: "succeeded" };
  if (res.verified && !res.gone) return { kind: "failed", reason: verdict };
  return {
    kind: "unproven",
    reason: verdict + (res.verificationError ? ` (${res.verificationError})` : ""),
  };
}

function deleteNotes(res: TrDeleteResult): string[] {
  if (!res.existedBefore) {
    return [
      `${res.trkorr} did not exist before this call, so nothing was deleted. The server returns ` +
        "a byte-identical empty 200 for a real and for a never-existent request, so a bare 200 " +
        "is not evidence of a deletion — this is a 'not found', not a success.",
    ];
  }
  if (res.verified && res.gone) {
    return [`${res.trkorr} existed before the call and a follow-up read confirms it is gone.`];
  }
  if (res.verified && !res.gone) {
    // `res.remaining` is the PARENT for a task-number delete, so look the
    // named number up among its tasks first.
    const own: TrHeader | undefined =
      res.remaining && res.remaining.trkorr !== res.trkorr
        ? res.remaining.tasks.find((t) => t.trkorr === res.trkorr)
        : res.remaining;
    return [
      `${res.trkorr} is still readable after the delete call — the delete did NOT take effect. ` +
        (own ? `It is still ${fmtStatus(own.status)}.` : ""),
    ];
  }
  return [
    `The delete call returned, but the follow-up read that would prove it failed` +
      `${res.verificationError ? ` (${res.verificationError})` : ""}. Treat this as neither ` +
      `deleted nor kept, and re-check with operation "show".`,
  ];
}

// ---------------------------------------------------------------------------
// abap_transport_release
// ---------------------------------------------------------------------------

/**
 * The "ALREADY RELEASED" short-circuit shared by the single- and
 * request-scope armed paths: a parent already released, or (under
 * substitution) the named task already released. `undefined` means neither
 * holds — the caller should continue with the ordinary armed path.
 */
function alreadyReleasedResponse(
  trkorr: string,
  subject: TrSubject,
  before: TrRequest,
  maxChars: number,
  extraHeader?: Record<string, string>,
): BuiltResponse | undefined {
  const ownTask = subject.substituted ? before.tasks.find((t) => t.trkorr === trkorr) : undefined;
  const parentReleased = before.status === "released";
  const taskReleased = ownTask?.status === "released";
  if (!parentReleased && !taskReleased) return undefined;
  const detail = !subject.substituted
    ? `${trkorr} was already released before this call (TR/768). No release was attempted.`
    : taskReleased
      ? `${trkorr} is itself already released — reads ${fmtStatus(ownTask!.status, ownTask!.statusText)}. ` +
        `No release was attempted.`
      : `${subject.answered} — the request the server answered about when you named ` +
        `${trkorr} — is already released, and a task cannot stay modifiable under a released ` +
        `request. No release was attempted.`;
  return buildResponse({
    header: {
      transport: trkorr,
      ...subjectHeader(subject, before),
      ...extraHeader,
      verdict: "ALREADY RELEASED — this call released nothing",
      status: fmtStatus(before.status, before.statusText),
      owner: before.owner,
      target: fmtTarget(before),
    },
    notes: [detail, ...subjectNotes(subject, before)],
    maxChars,
  });
}

/**
 * The ownership guard shared by both armed paths: refuse to release a
 * request this PROCESS did not create unless `confirmUnowned` echoes
 * `trkorr`. Deliberately per-process, not journal-aware — see
 * {@link createdByThisProcess}.
 */
function assertOwned(
  ownership: SessionTrOwner | undefined,
  subject: TrSubject,
  before: TrRequest,
  trkorr: string,
  confirmUnowned: string | undefined,
): void {
  const owned = createdByThisProcess(ownership, subject);
  if (owned !== false || confirmUnowned !== undefined) return;
  const carried = unionedObjects(before);
  const held =
    carried.length === 0
      ? "It holds no objects."
      : `It holds ${carried.length} object(s) this release would carry: ${carried
          .map((o) => `${o.pgmid} ${o.type} ${o.name}`)
          .join(", ")}.`;
  throw new AbapError(
    "BAD_INPUT",
    `${trkorr} was not created by this abapsmith server process — it was already open when ` +
      `this process started, so releasing it also transports whatever earlier work left in ` +
      `it, and a release is irreversible. ${held} To release it anyway, call again with ` +
      `confirm_unowned: "${trkorr}"`,
    {
      transport: trkorr,
      owner: before.owner,
      objects: carried.map((o) => `${o.pgmid} ${o.type} ${o.name}`),
    },
  );
}

/** The `journal.warn` wording shared by both armed paths on a POST throw. */
function warnReleasePostFailed(
  journal: TransportJournalDeps,
  entry: JournalEntry,
  number: string,
  errMessage: string,
): void {
  journal.warn(
    `[abapsmith] WARNING: ${number} — the release POST failed with "${errMessage}". ` +
      `Journal entry ${entry.id} stays \`pending\`: a failed call is not proof the release ` +
      `did not reach the system. Re-check ${number} with abap_transport ` +
      `{"operation":"show"} before retrying.`,
  );
}

/** scope: "request" needs an actual request — thrown before any network call reveals a task. */
function scopeRequestNeedsRequestError(trkorr: string, parent: string): AbapError {
  return new AbapError(
    "BAD_INPUT",
    `scope: "request" needs a request number, and ${trkorr} is a task of ${parent}. Call again ` +
      `with transport: "${parent}" (and confirm: "${parent}" to release) to release its ` +
      "remaining tasks and the request in one call.",
    { transport: trkorr, parent, scope: "request" },
  );
}

/**
 * The steps scope: "request" plans: each modifiable task holding objects, in
 * `r.tasks` order (the request itself is appended by the caller), and the
 * modifiable-but-empty tasks it skips — an empty open task does not block a
 * release, so it needs no step of its own.
 */
function planRequestSteps(r: TrRequest): { tasks: TrTask[]; skipped: TrTask[] } {
  return {
    tasks: r.tasks.filter((t) => t.status === "modifiable" && t.objects.length > 0),
    skipped: r.tasks.filter((t) => t.status === "modifiable" && t.objects.length === 0),
  };
}

/** Wording shared by the scope: "request" dry run and armed render for skipped empty tasks. */
function skippedEmptyTasksNote(skipped: readonly TrTask[]): string[] {
  if (!skipped.length) return [];
  return [
    `${skipped.length} modifiable task(s) hold no objects and are skipped (${skipped
      .map((t) => t.trkorr)
      .join(", ")}): observed on A4H, an empty open task does not block the request's release ` +
      "(TR/732 is raised only for a task that holds objects).",
  ];
}

export async function abapTransportRelease(
  conn: AbapConnection,
  input: TransportReleaseInput,
  maxChars: number,
  gate: SafetyGate,
  journal?: TransportJournalDeps,
  ownership?: SessionTrOwner,
): Promise<BuiltResponse> {
  const trkorr = normTrkorr(input.transport, "release");
  const ceiling = ceilingDecision(gate, "release");

  if (input.confirm !== undefined && input.confirm.trim().toUpperCase() !== trkorr) {
    throw new AbapError("BAD_INPUT", "confirm must echo the transport number exactly", {
      transport: trkorr,
      confirm: input.confirm,
    });
  }
  if (
    input.confirm_unowned !== undefined &&
    input.confirm_unowned.trim().toUpperCase() !== trkorr
  ) {
    throw new AbapError("BAD_INPUT", "confirm_unowned must echo the transport number exactly", {
      transport: trkorr,
      confirm_unowned: input.confirm_unowned,
    });
  }
  const armed = input.confirm !== undefined;
  const scope = input.scope ?? "single";

  // Read-only: the journal is only ever consulted here, never written to.
  if (!armed) {
    return scope === "request"
      ? await releaseDryRunRequestScope(conn, trkorr, ceiling, maxChars, journal, ownership)
      : await releaseDryRun(conn, trkorr, ceiling, maxChars, journal, ownership);
  }

  if (scope === "request") {
    return await releaseRequestScope(
      conn,
      trkorr,
      gate,
      maxChars,
      journal,
      ownership,
      input.confirm_unowned,
    );
  }

  // Armed: refuse BEFORE any network call if the server's policy forbids
  // release — must run ahead of the pre-read GET below.
  assertCeiling(gate, "release", "release");
  // Guaranteed to succeed: assertCeiling above already threw on denial via
  // the same object-less evaluate() call authorizeCeiling makes internally.
  const releaseProof = authorizeCeiling(gate, "transport", { release: true });

  // Read first: releasing an already-released request produces a TR/768
  // abort whose re-read says "released" — reading first avoids taking credit
  // for a release that happened before we arrived.
  const before = await trShow(conn, trkorr);
  const subject = subjectOf(trkorr, before);
  // Substitution means `trkorr` named a task: `before` describes its PARENT.
  // A released parent implies the task can't meaningfully be released, but
  // the task can also be released while its parent isn't (observed live:
  // A4HK900132 "R" under parent A4HK900131 still "D") — either short-circuits
  // before the POST.
  const already = alreadyReleasedResponse(trkorr, subject, before, maxChars);
  if (already) return already;

  assertOwned(ownership, subject, before, trkorr, input.confirm_unowned);

  const ownTask = subject.substituted ? before.tasks.find((t) => t.trkorr === trkorr) : undefined;

  // JOURNAL — BEFORE the POST. The only operation in this module journalled
  // ahead of the mutation: the pre-read above already gives a real
  // before-image, the act is irreversible (a crash between POST and entry
  // would leave a frozen request with no record of who froze it), and an
  // unprovable outcome is *supposed* to leave a pending entry here.
  // ACCEPTED FAILURE: a journal that can't be written REFUSES the release
  // (begin() throws JOURNAL_IO before any POST) — fail-closed, since a full
  // disk costing a release is recoverable but a silent unrecorded one isn't.
  // (`ABAP_JOURNAL=off` returns `undefined` rather than throwing, so
  // switching the journal off deliberately still releases.)
  const entry = journal
    ? await journal.journal.begin(
        beginInput(journal, {
          operation: "transport-release",
          trkorr,
          description: subject.substituted
            ? `release ${trkorr} (a task; the server's read answered about ${subject.answered})`
            : `release ${trkorr}${before.description ? ` — ${before.description}` : ""}`,
          existedBefore: true,
          // `before` describes the PARENT when a task was named; without the
          // task's own row from `before.tasks`, no provenance is claimed.
          beforeCapture: subject.substituted && !ownTask ? "unknown" : "captured",
          beforeSource: releaseBeforeImage(trkorr, before, subject, ownTask),
          // Set unconditionally (this entry is written before any re-read
          // exists) — true either way, since a release ATTEMPT can't be
          // undone and `undoBlocker()` refuses every `transport-*` entry
          // regardless. Whether it actually released lives in the outcome
          // and after-image, never in this flag.
          irreversible: true,
          tool: "abap_transport_release",
        }),
      )
    : undefined;

  let res: TrReleaseResult;
  try {
    res = await trRelease(conn, trkorr, releaseProof);
  } catch (e) {
    // The POST threw, but may still have reached CTS (a timeout after a
    // successful release looks identical), so the entry stays pending rather
    // than settling `failed`.
    if (journal && entry) warnReleasePostFailed(journal, entry, trkorr, (e as Error).message);
    throw e;
  }
  const built = renderRelease(res, before, subject, maxChars);
  if (journal && entry) {
    await settleEntry(journal, entry, trkorr, releaseJournalVerdict(res, subject));
  }
  return built;
}

/**
 * Did a re-read of the number the caller actually named return and settle the
 * outcome? Shared with `renderRelease` so the journal entry and the rendered
 * answer can't drift apart.
 */
function releaseConfirmed(res: TrReleaseResult, subject: TrSubject): boolean {
  if (!res.verified) return false;
  if (!subject.substituted) return true;
  // A substituted re-read used to be the end of the story. It is not:
  // when the parent it answered about carries the asked task's own row, that
  // row settles the task's state, and `confirmedByReRead` must agree with the
  // verdict rather than contradicting it in the same response. An indecisive
  // or absent row leaves this false, as before.
  return releaseVerdict(res, subject).proved !== undefined;
}

/**
 * The journal's version of the release outcome, derived from the SAME
 * `releaseVerdict` the user sees: an entry may never read stronger than the
 * answer. `succeeded` only when `releaseVerdict` itself proved a release;
 * "COULD NOT VERIFY"/"NOT CONFIRMED" is always `unproven`; `failed` is gated
 * on the verdict's own proof, not on a second guess at it — the old `failed`
 * arm additionally required `outcome === "aborted"`, which `proved ===
 * "not-released"` already implies for the non-substituted path.
 */
function releaseJournalVerdict(res: TrReleaseResult, subject: TrSubject): JournalVerdict {
  const { verdict, detail, proved } = releaseVerdict(res, subject);
  if (proved === "released") {
    return { kind: "succeeded", afterSource: releaseAfterImage(res, subject, verdict) };
  }
  if (proved === "not-released") {
    return {
      kind: "failed",
      reason: `${verdict}. ${detail}`,
      afterSource: releaseAfterImage(res, subject, verdict),
    };
  }
  return { kind: "unproven", reason: `${verdict}. ${detail}` };
}

/**
 * The before image: the request as read immediately before the POST. Plain,
 * greppable text (owner, status, object list). Only CTS metadata — no
 * header, cookie, token or credential is ever to be added here.
 */
function releaseBeforeImage(
  asked: string,
  before: TrRequest,
  subject: TrSubject,
  ownTask: TrHeader | undefined,
): string {
  const lines: string[] = [
    `requested: ${asked}`,
    `answered: ${before.trkorr}`,
    `substituted: ${subject.substituted}`,
    `status: ${fmtStatus(before.status, before.statusText)}`,
    `owner: ${before.owner}`,
    `description: ${before.description}`,
    `target: ${fmtTarget(before)}`,
  ];
  if (ownTask) {
    lines.push(
      `ownTask: ${ownTask.trkorr} ${fmtStatus(ownTask.status, ownTask.statusText)} owner=${ownTask.owner}`,
    );
  }
  for (const t of before.tasks) {
    lines.push(`task: ${t.trkorr} ${t.status} owner=${t.owner} objects=${t.objects.length}`);
  }
  for (const o of [...before.objects, ...before.tasks.flatMap((t) => t.objects)]) {
    lines.push(`object: ${o.pgmid} ${o.type} ${o.name}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * The after image: records BOTH the release report's own claim and the
 * `tm:status` re-read, since those two can disagree. Written only for
 * terminal outcomes — `unproven` never settles, so it never gets one.
 */
function releaseAfterImage(res: TrReleaseResult, subject: TrSubject, verdict: string): string {
  const lines: string[] = [
    `verdict: ${verdict}`,
    `outcome: ${releaseOutcome(res, subject)}`,
    `reportedReleased: ${res.reportedReleased}`,
    `reportClaim: ${releaseClaim(res)}`,
    `verified: ${res.verified}`,
    `confirmedByReRead: ${releaseConfirmed(res, subject)}`,
  ];
  // Same rename `renderRelease` applies: under substitution, `statusAfter`
  // is object-scoped elsewhere and must not read as a claim about the task.
  if (subject.substituted) {
    const own = substitutedTaskRow(res, subject);
    lines.push(`requestedStatusAfter: ${own ? fmtStatus(own.status, own.statusText) : "not known"}`);
    lines.push(
      `parentStatusAfter: ${res.verified ? fmtStatus(res.actualStatus, res.actualStatusText) : "re-read failed"}`,
    );
  } else {
    lines.push(
      `statusAfter: ${res.verified ? fmtStatus(res.actualStatus, res.actualStatusText) : "re-read failed"}`,
    );
  }
  if (res.releaseTimestamp) lines.push(`releasedAt: ${res.releaseTimestamp}`);
  if (res.verificationError) lines.push(`verificationError: ${res.verificationError}`);
  for (const m of res.messages) {
    lines.push(`message: ${messageKey(m)} ${m.type} ${m.text}`.trimEnd());
  }
  return lines.join("\n") + "\n";
}

async function releaseDryRun(
  conn: AbapConnection,
  trkorr: string,
  ceiling: { allowed: boolean; reason: string },
  maxChars: number,
  journal?: TransportJournalDeps,
  ownership?: SessionTrOwner,
): Promise<BuiltResponse> {
  const r = await trShow(conn, trkorr);
  const subject = subjectOf(trkorr, r);
  // Read-only: the journal is only ever consulted here, never written to.
  const created = await resolveCreatedBy(ownership, journal, subject);
  // Same de-duped union `opShow` uses — a naive concat would double-count an
  // object recorded under both the request and one of its tasks.
  const objects = unionedObjects(r);
  const openTasks = r.tasks.filter((t) => t.status !== "released");
  // A task cannot block its own release — TR/732 is raised when a REQUEST
  // is released while a task UNDER it is still open, so when the caller named a
  // task, that task is not one of its own referencing tasks.
  const referencing = openTasks.filter((t) => t.trkorr !== trkorr);
  // An open task only aborts the parent's release when it actually holds
  // objects. Both outcomes were observed live: a request whose open task held 0
  // objects released cleanly, and one whose task held 1 object aborted with
  // TR/732. The object count is already in hand here, so the two cases are
  // separated instead of being collapsed into one warning that is right half
  // the time.
  const blockingTasks = referencing.filter((t) => t.objects.length > 0);
  const emptyOpenTasks = referencing.filter((t) => t.objects.length === 0);

  const sections: Array<{ title: string; content: string }> = [];
  if (r.tasks.length) {
    sections.push({
      title: "TASKS",
      content: textTable(
        r.tasks.map((t) => ({
          task: t.trkorr,
          type: fmtTaskType(t),
          status: t.status,
          owner: t.owner,
          objects: String(t.objects.length),
        })),
        ["task", "type", "status", "owner", "objects"],
      ),
    });
  }
  if (objects.length) {
    sections.push({
      title: "OBJECTS THAT WOULD BE RELEASED",
      content: textTable(objectRows(objects), ["pgmid", "type", "name", "locked", "description"]),
    });
  }

  const notes: string[] = ["DRY RUN — nothing was released.", ...subjectNotes(subject, r)];
  if (subject.substituted && r.status !== "released") {
    notes.push(
      `${r.trkorr} is the parent request of ${trkorr}. Releasing ${trkorr} leaves ${r.trkorr} ` +
        "open; it has to be released afterwards — or call abap_transport_release with " +
        `transport: "${r.trkorr}" and scope: "request" to release its remaining tasks and the ` +
        "request in one call.",
    );
  }
  // When substituted, "already released" is sayable either because the
  // parent is released, or because the task itself is released while its
  // parent isn't (recovered from `r.tasks`).
  const ownTask = subject.substituted ? r.tasks.find((t) => t.trkorr === trkorr) : undefined;
  const alreadyReleased = subject.substituted
    ? r.status === "released" || ownTask?.status === "released"
    : r.status === "released";
  if (alreadyReleased) {
    notes.push(
      !subject.substituted
        ? "Already released (TR/768) — there is nothing left to do."
        : ownTask?.status === "released"
          ? `${trkorr} is itself already released — reads ${fmtStatus(ownTask.status, ownTask.statusText)}. ` +
            "There is nothing left to do."
          : `${subject.answered} — the request the server answered about when you named ` +
            `${trkorr} — is already released, and a task cannot stay modifiable under a released ` +
            `request. There is nothing left to do.`,
    );
  } else if (!ceiling.allowed) {
    notes.push(`Release is refused by the server's policy: ${ceiling.reason}`);
  } else {
    notes.push(`To release, call again with confirm: "${trkorr}"`);
  }
  if (blockingTasks.length) {
    notes.push(
      `${blockingTasks.length} task(s) under ${r.trkorr} are still modifiable AND hold objects ` +
        `(${blockingTasks.map((t) => t.trkorr).join(", ")}). A referencing task that is not ` +
        `released aborts the release with TR/732. Release ${blockingTasks
          .map((t) => t.trkorr)
          .join(", ")} first, then ${trkorr}.`,
    );
  }
  if (emptyOpenTasks.length) {
    notes.push(
      `${emptyOpenTasks.length} task(s) are still modifiable but hold no objects ` +
        `(${emptyOpenTasks.map((t) => t.trkorr).join(", ")}). Observed on A4H: a release ` +
        `with an empty task still open went through and the request ended Released — an empty ` +
        `task is not the TR/732 case, so this is not a blocker. If a release does abort on ` +
        `TR/732 anyway, release that task first and retry.`,
    );
  }
  notes.push(...createdByNotes(created, r.trkorr, trkorr));

  return buildResponse({
    header: {
      transport: r.trkorr,
      ...subjectHeader(subject, r),
      mode: "dry run",
      status: fmtStatus(r.status, r.statusText),
      owner: r.owner,
      createdByAbapsmith: createdByField(created),
      description: r.description,
      target: fmtTarget(r),
      tasks: r.tasks.length,
      objects: objects.length,
      releasePermitted: ceiling.allowed ? "yes" : "no",
      // Deliberately NOT folded into `releasePermitted`. That field
      // answers "does this server's policy permit the call"; whether CTS will
      // accept it is a different question with a different answer, and
      // callers already branch on the first one. Present only when a task
      // really does block, so its absence is not a claim that nothing does.
      releaseBlockedBy: blockingTasks.length
        ? blockingTasks.map((t) => t.trkorr).join(", ")
        : undefined,
    },
    sections,
    notes,
    maxChars,
  });
}

/**
 * The dry run for scope: "request" — a request number, not a task: plans
 * every modifiable task that holds objects (in order) plus the request
 * itself, without touching CTS. Throws before any of that when `trkorr`
 * names a task, since scope: "request" only makes sense on the request.
 */
async function releaseDryRunRequestScope(
  conn: AbapConnection,
  trkorr: string,
  ceiling: { allowed: boolean; reason: string },
  maxChars: number,
  journal?: TransportJournalDeps,
  ownership?: SessionTrOwner,
): Promise<BuiltResponse> {
  const r = await trShow(conn, trkorr);
  const subject = subjectOf(trkorr, r);
  if (subject.substituted) throw scopeRequestNeedsRequestError(trkorr, r.trkorr);

  const created = await resolveCreatedBy(ownership, journal, subject);
  const objects = unionedObjects(r);
  const { tasks, skipped } = planRequestSteps(r);
  const N = tasks.length + 1;
  const steps: Array<{ step: number; number: string; kind: "task" | "request" }> = [
    ...tasks.map((t, i) => ({ step: i + 1, number: t.trkorr, kind: "task" as const })),
    { step: N, number: trkorr, kind: "request" as const },
  ];

  const sections: Array<{ title: string; content: string }> = [
    {
      title: "STEPS",
      content: textTable(
        steps.map((s) => {
          const task = s.kind === "task" ? tasks.find((t) => t.trkorr === s.number) : undefined;
          return {
            step: String(s.step),
            number: s.number,
            kind: s.kind,
            status: s.kind === "task" ? (task?.status ?? "") : r.status,
            objects: s.kind === "task" ? String(task?.objects.length ?? 0) : String(objects.length),
          };
        }),
        ["step", "number", "kind", "status", "objects"],
      ),
    },
  ];
  if (objects.length) {
    sections.push({
      title: "OBJECTS THAT WOULD BE RELEASED",
      content: textTable(objectRows(objects), ["pgmid", "type", "name", "locked", "description"]),
    });
  }

  const notes: string[] = ["DRY RUN — nothing was released."];
  if (r.status === "released") {
    notes.push("Already released (TR/768) — there is nothing left to do.");
  } else if (!ceiling.allowed) {
    notes.push(`Release is refused by the server's policy: ${ceiling.reason}`);
  } else {
    notes.push(`To release, call again with confirm: "${trkorr}" and scope: "request"`);
  }
  notes.push(...skippedEmptyTasksNote(skipped));
  notes.push(...createdByNotes(created, r.trkorr, trkorr));

  return buildResponse({
    header: {
      transport: r.trkorr,
      scope: "request",
      stepsPlanned: N,
      mode: "dry run",
      status: fmtStatus(r.status, r.statusText),
      owner: r.owner,
      createdByAbapsmith: createdByField(created),
      description: r.description,
      target: fmtTarget(r),
      tasks: r.tasks.length,
      objects: objects.length,
      releasePermitted: ceiling.allowed ? "yes" : "no",
    },
    sections,
    notes,
    maxChars,
  });
}

function releaseClaim(res: TrReleaseResult): string {
  const status = res.reports.find((r) => r.status)?.status;
  const key = res.messages.map(messageKey).find((k) => k !== "");
  if (status && key) return `"${status}" (${key})`;
  if (status) return `"${status}"`;
  if (key) return `(${key})`;
  return res.reportedReleased ? '"released"' : '"aborted"';
}

/**
 * What this call PROVED about the number the caller named — never about a
 * number CTS substituted for it. `undefined` is the only honest answer when
 * nothing settled it, and it is what every "COULD NOT VERIFY" path returns.
 */
type ReleaseProof = "released" | "not-released" | undefined;

/**
 * The one field that settles a TASK release. A GET of a task number
 * returns its PARENT, so `res.actualStatus` describes the parent and proves
 * nothing about the task — but the parent carries the task's own row, and
 * `TrReleaseResult.request` IS that parent re-read (set only when
 * verification ran and succeeded). Returns the row for the number the caller
 * named, or `undefined` when the re-read did not settle anything.
 */
function substitutedTaskRow(res: TrReleaseResult, subject: TrSubject): TrTask | undefined {
  if (!res.verified || !subject.substituted) return undefined;
  return res.request?.tasks.find((t) => t.trkorr === subject.asked);
}

/**
 * `outcome` for the number the CALLER named, not `res.outcome` — under
 * substitution `res.outcome` reconciles the envelope against the PARENT,
 * which proves nothing about a task (see {@link releaseVerdict}). The
 * task's own row is the only thing that settles it, so this derives outcome
 * from the same verdict the header and journal already agree on.
 */
function releaseOutcome(res: TrReleaseResult, subject: TrSubject): TrReleaseOutcome {
  if (!subject.substituted) return res.outcome;
  const { proved } = releaseVerdict(res, subject);
  if (proved === "released") return res.reportedReleased ? "released" : "released-despite-abort";
  if (proved === "not-released") return "aborted";
  return "unknown";
}

/**
 * All four outcomes are worded distinctly and none overstates what the wire
 * proved: `released-despite-abort` is success *with* why the abort was
 * disbelieved; `unknown` is always "could not verify". Two failure modes this
 * must avoid (both happened before, see archive): claiming a confirmation
 * that never returned (`outcome: "released"` with `verified: false` is the
 * envelope's word alone), and blaming a re-read that actually succeeded but
 * contradicted the report. `subject` carries a third case — a re-read that
 * succeeded but answered about a different transport number — handled ahead
 * of the switch and never reaching a success verdict.
 *
 * That third case is no longer always terminal. When the parent it
 * answered about carries the asked task's own row ({@link substitutedTaskRow}),
 * that row — and ONLY that row — may raise it to a real verdict; a
 * `protected` or `unknown` row still establishes nothing and still falls
 * back to "COULD NOT VERIFY".
 */
function releaseVerdict(
  res: TrReleaseResult,
  subject: TrSubject,
): { verdict: string; detail: string; proved: ReleaseProof } {
  const now = fmtStatus(res.actualStatus, res.actualStatusText);

  // The POST targets the named number; only the reads around it get
  // redirected to the parent by CTS. So a re-read on a different subject
  // describes the parent, not the release just performed.
  if (res.verified && subject.substituted) {
    const own = substitutedTaskRow(res, subject);
    const ownNow = own ? fmtStatus(own.status, own.statusText) : "";

    // Only `released` and `modifiable` are decisive. `protected` and
    // `unknown` (an unrecognised raw `tm:status`) establish nothing and fall
    // through to the fallback below — the point of this branch is to read
    // one field, not to guess from a status this code did not recognise.
    if (own?.status === "released" && res.reportedReleased) {
      return {
        verdict: "RELEASED — the task's own row in the parent confirms it",
        detail:
          `The release was aimed at ${subject.asked} and the report claimed ${releaseClaim(res)}. ` +
          `The re-read answered about ${subject.answered} — in CTS a GET of a task number returns ` +
          `its PARENT request — but ${subject.answered}'s task list carries ${subject.asked} itself, ` +
          `and that row now reads ${ownNow}. The row is about ${subject.asked}; the parent's own ` +
          `status (${now}) is not, and is not what this verdict rests on.`,
        proved: "released",
      };
    }
    if (own?.status === "released" && !res.reportedReleased) {
      return {
        verdict: "RELEASED — despite an abort report, the task's own row in the parent confirms it",
        detail:
          `The release report claimed ${releaseClaim(res)}, but ${subject.answered}'s task list — ` +
          `from the re-read that answered about the parent, not about ${subject.asked} — shows ` +
          `${subject.asked} itself now reads ${ownNow}. The abort was contradicted by CTS's own ` +
          `state: the task IS released. The parent ${subject.answered} is ${now}, which this says ` +
          `nothing about.`,
        proved: "released",
      };
    }
    if (own?.status === "modifiable" && res.reportedReleased) {
      return {
        verdict: "COULD NOT VERIFY — the report and the task's own row disagree",
        detail:
          `The report claimed ${releaseClaim(res)} for ${subject.asked}, but ${subject.answered}'s ` +
          `task list shows ${subject.asked} still reads ${ownNow}. The re-read did NOT fail: it ` +
          `succeeded and contradicts the report. This is neither success nor failure — do not ` +
          `report ${subject.asked} as released, and do not report it as unreleased. Re-check with ` +
          `abap_transport {"operation":"show","transport":"${subject.answered}"} and read its TASKS ` +
          `row for ${subject.asked}.`,
        proved: undefined,
      };
    }
    if (own?.status === "modifiable" && !res.reportedReleased) {
      return {
        verdict: "NOT RELEASED — the release was aborted",
        detail:
          `The release of ${subject.asked} was aborted (${releaseClaim(res)}) and ${subject.answered}'s ` +
          `task list confirms ${subject.asked} is still ${ownNow}. Nothing was released; fix the ` +
          `cause below and try again.`,
        proved: "not-released",
      };
    }

    // Fallback: no row (the task isn't among the parent's tasks), or a row
    // whose status is `protected`/`unknown` — neither establishes anything,
    // so this reads exactly like a re-read that answered about a different
    // number, because that is exactly what happened.
    return {
      verdict: "COULD NOT VERIFY — the re-read answered about a different number",
      detail:
        `The release was aimed at ${subject.asked} and the report claimed ${releaseClaim(res)}, ` +
        `but the re-read that would settle it answered about ${subject.answered} (${now}) — in ` +
        `CTS a GET of a task number returns its PARENT request. Nothing here establishes ` +
        `${subject.asked}'s own state: do not report it as released, and do not report it as ` +
        `unreleased. ` +
        (own
          ? `${subject.answered}'s task list does carry ${subject.asked}, but it reads ${ownNow}, ` +
            `which settles nothing either way. `
          : `${subject.asked} is not among the ${res.request?.tasks.length ?? 0} task(s) that ` +
            `re-read carries, so its own row could not be read. `) +
        `Re-check with abap_transport {"operation":"show","transport":"${subject.answered}"} and ` +
        `read its TASKS row for ${subject.asked}.`,
      proved: undefined,
    };
  }

  switch (res.outcome) {
    case "released":
      // `outcome: "released"` is the ENVELOPE's word; only `verified` means
      // we saw it ourselves.
      if (!res.verified) {
        return {
          verdict: "RELEASED (REPORTED) — NOT CONFIRMED",
          detail:
            `The system reported the release, but the re-read that would prove it failed` +
            `${res.verificationError ? ` (${res.verificationError})` : ""}, so we did NOT observe ` +
            `the request in a released state. This is the server's word and nothing more: treat ` +
            `it as unconfirmed and re-check with abap_transport ` +
            `{"operation":"show","transport":"${res.trkorr}"} before acting on it.`,
          proved: undefined,
        };
      }
      return {
        verdict: "RELEASED — reported and confirmed",
        detail: `The system reported the release and a re-read of the request confirms it is now ${now}.`,
        proved: "released",
      };
    case "released-despite-abort":
      return {
        verdict: "RELEASED — despite an abort report",
        detail:
          `The release report claimed ${releaseClaim(res)}, but a re-read of the request shows it is ` +
          `${now}. The abort was contradicted by the system's own state: the request IS released. ` +
          "This is the known lying-envelope case — the report is not authoritative, the re-read is.",
        proved: res.verified ? "released" : undefined,
      };
    case "aborted":
      return {
        verdict: "NOT RELEASED — the release was aborted",
        detail:
          `The release was aborted (${releaseClaim(res)}) and a re-read confirms the request is still ` +
          `${now}. Nothing was released; fix the cause below and try again.`,
        proved: res.verified ? "not-released" : undefined,
      };
    case "unknown":
      if (res.verified) {
        // The re-read ran and returned; `unknown` here means the report and
        // the request's own state contradict each other — must not be
        // described as a failed re-read.
        return {
          verdict: "COULD NOT VERIFY — the report and the re-read disagree",
          detail:
            `The re-read did NOT fail: it succeeded and shows the request is ${now}, which ` +
            `contradicts the release report (${releaseClaim(res)}). One of the two is wrong and ` +
            `this call cannot tell which. This is neither success nor failure: do not report the ` +
            `request as released, and do not report it as unreleased. Re-check with abap_transport ` +
            `{"operation":"show","transport":"${res.trkorr}"} before acting.`,
          proved: undefined,
        };
      }
      return {
        verdict: "COULD NOT VERIFY — outcome unknown",
        detail:
          `The release call returned, but the re-read that would prove the outcome failed` +
          `${res.verificationError ? ` (${res.verificationError})` : ""}. This is neither success ` +
          `nor failure: do not report the request as released, and do not report it as unreleased. ` +
          `Re-check with abap_transport {"operation":"show","transport":"${res.trkorr}"} before acting.`,
        proved: undefined,
      };
  }
}

function renderRelease(
  res: TrReleaseResult,
  before: TrRequest,
  subject: TrSubject,
  maxChars: number,
): BuiltResponse {
  const { verdict, detail, proved } = releaseVerdict(res, subject);
  // Everything downstream that states the post-release condition as fact
  // (`statusAfter`, "is now frozen") is gated on this, never on `outcome` —
  // same predicate the journal entry for this release is gated on.
  const confirmed = releaseConfirmed(res, subject);
  const sections: Array<{ title: string; content: string }> = [];
  if (res.messages.length) {
    sections.push({
      title: "MESSAGES",
      content: textTable(messageRows(res.messages), ["message", "type", "text", "meaning"]),
    });
  }

  // After a release, the task's row in the POST-release re-read is the
  // current one; rendering the pre-read's row here would print "reads
  // Modifiable" directly under a verdict that says it is released.
  const notes: string[] = [detail, ...subjectNotes(subject, res.request ?? before)];
  if (subject.substituted) {
    notes.push(
      `requestedStatus/requestedStatusAfter are ${subject.asked}'s own readings and the fields to ` +
        `act on for this release. parentStatusBefore/parentStatusAfter describe ${subject.answered} ` +
        `and can stay Modifiable even when ${subject.asked} released cleanly.`,
    );
    // Naming a task without scope: "request" releases only that task; the
    // parent's own fate is a separate question this answers explicitly
    // rather than leaving the caller to infer it from parentStatusAfter.
    const parentStillOpen = parentStillOpenValue(res);
    const parentNow = fmtStatus(res.actualStatus, res.actualStatusText);
    if (parentStillOpen === "yes" && proved === "released") {
      notes.push(
        `${subject.answered} — the parent request — is still ${parentNow}: releasing ` +
          `${subject.asked} did not release it. To finish, release the parent: ` +
          `abap_transport_release {"transport":"${subject.answered}","confirm":"${subject.answered}"} ` +
          `— or call it with scope: "request" on ${subject.answered} to release its remaining ` +
          "tasks and the request in one call.",
      );
    } else if (parentStillOpen === "yes") {
      notes.push(
        `${subject.answered} — the parent request — is still ${parentNow} and still has to be ` +
          `released once ${subject.asked} is.`,
      );
    } else if (parentStillOpen === "no") {
      notes.push(
        `${subject.answered} — the parent request — reads ${parentNow}; nothing is left to release.`,
      );
    } else {
      notes.push(
        `Whether ${subject.answered} — the parent request — still has to be released is not known ` +
          "(the re-read failed). Check it with abap_transport " +
          `{"operation":"show","transport":"${subject.answered}"}.`,
      );
    }
  }
  // Only a proven release may be described as having happened — an
  // envelope-only "released" says nothing about the locks. The
  // substituted path can now prove a release too, and this note must follow
  // the proof, not the outcome.
  if (proved === "released") {
    notes.push(
      `${res.trkorr} is now frozen: its objects are unlocked and the request can no longer be changed.`,
    );
  }
  // A landscape property, stated whenever it holds (including when the
  // outcome is unproven) — otherwise the wording implies a route that
  // doesn't exist.
  if ((before.target ?? "").trim() === "") {
    notes.push(
      "This system has no transport route (empty target), so a release here only flips the " +
        "status and frees the locks — nothing is exported anywhere.",
    );
  }

  // `requestedStatus` (from `subjectHeader`) is the PRE-release reading
  // of the task, taken from the pre-read — the answer to the caller's
  // question is the reading AFTER, which the parent re-read carries when it
  // lists the task at all. `not known` rather than an omission, so the
  // parent's status is never mistaken for the task's.
  let requestedStatusAfter: string | undefined;
  if (subject.substituted && res.verified) {
    const own = substitutedTaskRow(res, subject);
    requestedStatusAfter = own ? fmtStatus(own.status, own.statusText) : "not known";
  }

  // Under substitution these describe the PARENT, not the number the caller
  // asked about — `statusBefore`/`statusAfter` are object-scoped everywhere
  // else, so keeping those names here would read as a claim about the task.
  // Same values, renamed; `requestedStatusAfter` above is the task's own.
  const statusFields = subject.substituted
    ? {
        parentStatusBefore: fmtStatus(before.status, before.statusText),
        parentStatusAfter: res.verified
          ? fmtStatus(res.actualStatus, res.actualStatusText)
          : "re-read failed",
      }
    : {
        statusBefore: fmtStatus(before.status, before.statusText),
        statusAfter: res.verified
          ? fmtStatus(res.actualStatus, res.actualStatusText)
          : "re-read failed",
      };

  return buildResponse({
    header: {
      transport: res.trkorr,
      ...subjectHeader(subject, before, {
        parent: subject.answered,
        parentStillOpen: parentStillOpenValue(res),
      }),
      requestedStatusAfter,
      verdict,
      outcome: releaseOutcome(res, subject),
      reportedReleased: res.reportedReleased,
      // Separate column on purpose: `outcome: released` with
      // `confirmedByReRead: false` is a real and important state.
      confirmedByReRead: confirmed,
      ...statusFields,
      verified: res.verified,
      releasedAt: res.releaseTimestamp,
      target: fmtTarget(before),
    },
    sections,
    notes,
    maxChars,
  });
}

/** One planned step of a scope: "request" release: a task, or the request itself. */
interface RequestScopeStep {
  step: number;
  number: string;
  kind: "task" | "request";
}

/** A planned step this call actually attempted, with what it proved. */
interface RequestScopeStepResult extends RequestScopeStep {
  outcome: TrReleaseOutcome;
  verdict: string;
  detail: string;
  proved: ReleaseProof;
  res: TrReleaseResult;
}

/**
 * The armed path for scope: "request" — release a request's modifiable,
 * non-empty tasks in order, then the request itself, stopping at the first
 * step that does not prove `released`. Every safety property of the
 * single-scope path applies per step: the ceiling gate runs before any
 * network call, the ownership guard runs once (against the request) before
 * the first POST, and each step's journal entry is begun before its POST.
 */
async function releaseRequestScope(
  conn: AbapConnection,
  trkorr: string,
  gate: SafetyGate,
  maxChars: number,
  journal: TransportJournalDeps | undefined,
  ownership: SessionTrOwner | undefined,
  confirmUnowned: string | undefined,
): Promise<BuiltResponse> {
  assertCeiling(gate, "release", "release");
  const releaseProof = authorizeCeiling(gate, "transport", { release: true });

  const before = await trShow(conn, trkorr);
  const subject = subjectOf(trkorr, before);
  if (subject.substituted) throw scopeRequestNeedsRequestError(trkorr, before.trkorr);

  const already = alreadyReleasedResponse(trkorr, subject, before, maxChars, { scope: "request" });
  if (already) return already;

  assertOwned(ownership, subject, before, trkorr, confirmUnowned);

  const { tasks, skipped } = planRequestSteps(before);
  const N = tasks.length + 1;
  const steps: RequestScopeStep[] = [
    ...tasks.map((t, i) => ({ step: i + 1, number: t.trkorr, kind: "task" as const })),
    { step: N, number: trkorr, kind: "request" as const },
  ];

  const results: RequestScopeStepResult[] = [];
  let latest: TrRequest = before;
  let stoppedAt: RequestScopeStep | undefined;

  for (const s of steps) {
    // The request step's own subject is not "substituted" — it IS what was
    // asked and what CTS answers about; only task steps redirect.
    const stepSubject: TrSubject =
      s.kind === "task"
        ? { asked: s.number, answered: trkorr, substituted: true }
        : { asked: trkorr, answered: trkorr, substituted: false };
    const ownTaskRow = s.kind === "task" ? latest.tasks.find((t) => t.trkorr === s.number) : undefined;

    const entry = journal
      ? await journal.journal.begin(
          beginInput(journal, {
            operation: "transport-release",
            trkorr: s.number,
            description:
              `release ${s.number} (${s.kind === "task" ? `a task of ${trkorr}` : "the request"}) — ` +
              `step ${s.step} of ${N} of scope "request" on ${trkorr}` +
              (s.kind === "request" && before.description ? ` — ${before.description}` : ""),
            existedBefore: true,
            beforeCapture: s.kind === "task" ? (ownTaskRow ? "captured" : "unknown") : "captured",
            beforeSource: releaseBeforeImage(s.number, latest, stepSubject, ownTaskRow),
            irreversible: true,
            tool: "abap_transport_release",
          }),
        )
      : undefined;

    let res: TrReleaseResult;
    try {
      res = await trRelease(conn, s.number, releaseProof);
    } catch (e) {
      if (journal && entry) warnReleasePostFailed(journal, entry, s.number, (e as Error).message);
      if (e instanceof AbapError) {
        throw new AbapError(
          e.code,
          `scope "request" on ${trkorr} stopped at step ${s.step} of ${N} (${s.number}, ${s.kind}): ` +
            e.message,
          {
            ...e.details,
            transport: trkorr,
            step: s.step,
            stepsPlanned: N,
            stepsCompleted: results.filter((r) => r.proved === "released").map((r) => r.number),
            failedStep: s.number,
          },
          e.hint,
        );
      }
      throw e;
    }

    const { verdict, detail, proved } = releaseVerdict(res, stepSubject);
    const outcome = releaseOutcome(res, stepSubject);
    if (journal && entry) {
      await settleEntry(journal, entry, s.number, releaseJournalVerdict(res, stepSubject));
    }
    if (res.verified && res.request) latest = res.request;

    results.push({ step: s.step, number: s.number, kind: s.kind, outcome, verdict, detail, proved, res });
    if (proved !== "released") {
      stoppedAt = { step: s.step, number: s.number, kind: s.kind };
      break;
    }
  }

  return renderReleaseRequestScope(trkorr, before, latest, steps, results, stoppedAt, skipped, N, maxChars);
}

/** Renders {@link releaseRequestScope}'s outcome — attempted and not-attempted steps alike. */
function renderReleaseRequestScope(
  trkorr: string,
  before: TrRequest,
  latest: TrRequest,
  steps: readonly RequestScopeStep[],
  results: readonly RequestScopeStepResult[],
  stoppedAt: RequestScopeStep | undefined,
  skipped: readonly TrTask[],
  N: number,
  maxChars: number,
): BuiltResponse {
  const tasksPlanned = N - 1;
  const lastResult = results[results.length - 1];
  const requestResult = results.find((r) => r.kind === "request");

  const verdict = stoppedAt
    ? `STOPPED AT STEP ${stoppedAt.step} of ${N} (${stoppedAt.number}, ${stoppedAt.kind}) — ${lastResult?.verdict}`
    : tasksPlanned === 0
      ? `RELEASED — the request ${trkorr} (no task needed releasing)`
      : `RELEASED — ${tasksPlanned} task(s) and the request ${trkorr}`;

  const sections: Array<{ title: string; content: string }> = [
    {
      title: "STEPS",
      content: textTable(
        steps.map((s) => {
          const r = results.find((x) => x.step === s.step);
          return {
            step: String(s.step),
            number: s.number,
            kind: s.kind,
            outcome: r ? r.outcome : "not attempted",
            verdict: r ? r.verdict : "not attempted",
          };
        }),
        ["step", "number", "kind", "outcome", "verdict"],
      ),
    },
  ];

  const messagesSource = stoppedAt ? lastResult?.res : requestResult?.res;
  if (messagesSource && messagesSource.messages.length) {
    sections.push({
      title: "MESSAGES",
      content: textTable(messageRows(messagesSource.messages), ["message", "type", "text", "meaning"]),
    });
  }

  const notes: string[] = results.map((r) => `Step ${r.step} (${r.number}, ${r.kind}): ${r.detail}`);
  notes.push(...skippedEmptyTasksNote(skipped));
  if (stoppedAt && stoppedAt.step < N) {
    const remaining = steps.filter((s) => s.step > stoppedAt.step);
    const which =
      remaining.length === 1 ? `Step ${N} was` : `Steps ${stoppedAt.step + 1}..${N} were`;
    notes.push(
      `${which} not attempted (${remaining.map((s) => s.number).join(", ")}). Fix the cause and ` +
        "call again with the same arguments — a task that is already released is no longer " +
        "planned, so the retry resumes at the failed step.",
    );
  }
  if (requestResult && requestResult.proved === "released") {
    notes.push(
      `${trkorr} is now frozen: its objects are unlocked and the request can no longer be changed.`,
    );
  }
  if ((before.target ?? "").trim() === "") {
    notes.push(
      "This system has no transport route (empty target), so a release here only flips the " +
        "status and frees the locks — nothing is exported anywhere.",
    );
  }

  const statusAfter =
    lastResult && lastResult.res.verified ? fmtStatus(latest.status, latest.statusText) : "re-read failed";

  return buildResponse({
    header: {
      transport: trkorr,
      scope: "request",
      verdict,
      stepsPlanned: N,
      stepsCompleted: results.filter((r) => r.proved === "released").length,
      stoppedAtStep: stoppedAt?.step,
      stoppedAt: stoppedAt ? `${stoppedAt.number} (${stoppedAt.kind})` : undefined,
      statusBefore: fmtStatus(before.status, before.statusText),
      statusAfter,
      verified: lastResult?.res.verified,
      releasedAt: requestResult?.res.releaseTimestamp,
      target: fmtTarget(before),
    },
    sections,
    notes,
    maxChars,
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface TransportToolDeps {
  /**
   * The session pool, NOT a bare connection: both tools mutate CTS, so they
   * run on a write-role slot serialised against every other write. A TRKORR
   * takes no ABAP enqueue, so there's no {@link ObjectGate} key — the call
   * passes `undefined`. A bare `AbapConnection` would let a transport
   * mutation run concurrently with an open stateful edit once
   * `maxSessions > 1`.
   */
  readonly pool: SessionPool;
  /** `sid`/`url`/`client` are for `systemKey()` on journal entries. */
  readonly cfg: Pick<Config, "maxResponseChars" | "sid" | "url" | "client">;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  /**
   * REQUIRED because it once was optional and silently omitted — the shipped
   * server let create/re-own/DELETE/RELEASE happen with nothing landing on
   * disk (see the git history; second instance of
   * this pattern on this branch, both now pinned end-to-end by
   * test/session-transport-journal.test.ts). "Journalling switched off" is
   * modelled inside `Journal` itself (`ABAP_JOURNAL=off`) — pass the disabled
   * journal, never no journal.
   */
  readonly journal: Journal;
  /** Where journal failures are reported; defaults to stderr in `journalDeps()`. */
  readonly warn?: (msg: string) => void;
  /**
   * REQUIRED, same stance as `journal`: without it, `operation=show` and a
   * release dry run can't say whether THIS session created the request, and
   * `abap_transport_release` can't refuse to release one it didn't — the very
   * gap this whole change closes. `abapTransport`/`abapTransportRelease` still
   * take it as an optional sixth parameter for direct callers (tests).
   */
  readonly ownership: SessionTrOwner;
  /**
   * REQUIRED, not defaulted: whether to register `abap_transport_release` at
   * all. `abap_transport` is unaffected (always registered). This is
   * defense-in-depth on top of `SafetyGate`, not instead of it —
   * `abapTransportRelease()` still calls `assertCeiling` regardless. Callers
   * pass `resolveStaticCapabilities(cfg).canReleaseTransport` (`src/config.ts`).
   */
  readonly registerRelease: boolean;
}

/** `journal` is required on `TransportToolDeps`, so this is always real. */
function journalDeps(deps: TransportToolDeps): TransportJournalDeps {
  const warn = deps.warn ?? ((m: string) => void process.stderr.write(`${m}\n`));
  return { journal: deps.journal, cfg: deps.cfg, warn };
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/** Registers `abap_transport` and `abap_transport_release` on the MCP server. */
export function registerTransportTools(mcp: McpServer, deps: TransportToolDeps): void {
  mcp.registerTool(
    "abap_transport",
    {
      description: TRANSPORT_TOOL_DESCRIPTION,
      inputSchema: transportInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      try {
        await deps.ensureConnected();
        const res = await deps.pool.withWrite("abap_transport", undefined, (conn) =>
          abapTransport(
            conn,
            args as TransportInput,
            deps.cfg.maxResponseChars,
            deps.safety,
            journalDeps(deps),
            deps.ownership,
          ),
        );
        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );

  // Gated on `deps.registerRelease`: a release-disallowed process never
  // advertises the one irreversible verb in `tools/list`. The runtime
  // `assertCeiling` check in `abapTransportRelease()` remains authoritative.
  if (deps.registerRelease) {
    mcp.registerTool(
      "abap_transport_release",
      {
        description: TRANSPORT_RELEASE_TOOL_DESCRIPTION,
        inputSchema: transportReleaseInputSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      async (args) => {
        try {
          await deps.ensureConnected();
          const res = await deps.pool.withWrite("abap_transport_release", undefined, (conn) =>
            abapTransportRelease(
              conn,
              args as TransportReleaseInput,
              deps.cfg.maxResponseChars,
              deps.safety,
              journalDeps(deps),
              deps.ownership,
            ),
          );
          return ok(res.text);
        } catch (e) {
          return deps.errorResult(e);
        }
      },
    );
  }
}
