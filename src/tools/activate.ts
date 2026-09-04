/**
 * `abap_activate` — syntax check and activation.
 *
 * `mode=check`: cheap pre-flight (`POST /checkruns`), no lock, no state
 * change, ~80-250ms, reports the real source line, works on unsaved drafts,
 * available even in read-only mode. `source` is OPTIONAL:
 * omitting it fetches and checks the version already saved on the server
 * (one extra `GET .../source/main` beyond the checkruns POST itself) for any
 * type with `TypeSpec.supportsSource`. Refuses fast with `BAD_INPUT` —
 * before any request goes out, never `abap-adt-api`'s own untyped error on
 * empty content — only when there is genuinely nothing saved to check: the
 * object doesn't exist yet, or its type has no `/source/main` at all
 * (ENHO/XH, ENHS/XS, DTEL/DE, DOMA/DD, TTYP/DA, MSAG/N, ENQU/DL, DEVC/K,
 * SRVB/SVB — see src/adt/types.ts).
 *
 * `mode=activate`: checks first, activates only when clean. Activation
 * failures come back as HTTP 200 with a message body, so "200" is never the
 * success signal — an activation that did not activate (errors, inactive
 * dependents, bare `success: false`) is raised as `CHECK_FAILED` by
 * `assertNoErrors`, never returned success-shaped. `source` is optional:
 * omitting it activates the version already saved on the server, no
 * pre-flight check.
 *
 * No `package` argument: activation goes through `authorizeMutation`, which
 * asks the server what package the object is actually in and judges that
 * against the safety gate. That guarantee only holds for an object that
 * EXISTS — `resolveWriteTarget` would otherwise fabricate `$TMP` for an
 * absent one — so `mode=activate` on a nonexistent object is refused BEFORE
 * the gate is consulted. `mode=check` is unaffected; it never reaches the gate.
 *
 * ## Journalling
 *
 * `mode=activate` writes one `operation: "activate"` journal entry PER
 * OBJECT (single or batch), on disk before the request goes out. `mode=check`
 * writes nothing. These entries are HISTORY, not undo — `undoBlocker()`
 * (src/adt/undo.ts) refuses `operation: "activate"` by name (ADT has no
 * deactivate operation), and entries carry `irreversible: true` for every
 * presentation path. See `journalActivations` for the entry shape and
 * `abapActivateBatch` for why a batch is N entries rather than one.
 *
 * Full historical rationale: the git history
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  activateObject,
  activateObjects,
  assertBatchActivated,
  assertNoErrors,
  checkSource,
  MAX_ACTIVATION_BATCH,
  renderBatch,
  renderInactive,
  renderMessages,
} from "../adt/activate.js";
import type {
  ActivationDisposition,
  ActivationOutcome,
  ActivationTarget,
  AdtMessage,
  InactiveObjectRef,
} from "../adt/activate.js";
import type { AbapConnection } from "../adt/connection.js";
import { AbapError } from "../adt/errors.js";
import type { SessionPool } from "../adt/pool.js";
import { parseObjectRef } from "../adt/resolve.js";
import { translateAdtError } from "../adt/session.js";
import { specForKeyword, specForType } from "../adt/types.js";
import { toAbapError, type SessionTransport } from "../adt/session-transport.js";
import {
  authorizeMutation,
  enhancementIntentFor,
  resolveWriteTarget,
  type EnhancedObjectRef,
  type ResolvedTarget,
} from "../adt/write.js";
import { buildResponse, type BuiltResponse } from "../compact.js";
import type { Config } from "../config.js";
import {
  journalRef,
  systemKey,
  type Journal,
  type JournalFinishPatch,
} from "../journal.js";
import { isEnhancementType, normalizeCorrNr, type SafetyGate } from "../safety.js";
import { truncateText } from "../truncate.js";
import { enhancementPreflightIntent, preflight, writeGateKey } from "./preflight.js";

// Shared with the per-entry shape inside `objects` below so both stay in sync.
const affectsSchema = z.object({
  name: z.string(),
  packageName: z.string(),
  masterSystem: z.string().optional(),
  spotName: z.string().optional(),
});

export const activateInputSchema = {
  object: z.string().optional().describe("Object reference."),
  type: z.string().optional().describe("ADT type, e.g. CLAS/OC."),
  mode: z.enum(["check", "activate"]).optional().describe("Default activate."),
  source: z.string().optional().describe("Unsaved draft to check/activate."),
  corr_nr: z.string().optional().describe("Transport request. $TMP needs none."),
  // Same shape as abap_write's `affects` — REQUIRED to activate an EXISTING
  // ENHO/XH or ENHS/XS (safety.ts); ignored for every other type.
  affects: affectsSchema.optional().describe("Required to activate ENHO/XH or ENHS/XS."),
  // The batch form. ADT accepts many objects in ONE
  // `POST /sap/bc/adt/activation` request (`activateObjects`, src/adt/activate.ts)
  // with the server resolving dependency order. Every object is resolved AND
  // authorised BEFORE any is activated — one refusal refuses the whole set.
  // Mutually exclusive with `object` and the top-level `type`/`affects`/
  // `corr_nr`/`source` (doc/TOOLS/write-and-activate.md §abap_activate). mode=activate only;
  // there is no batch syntax check.
  objects: z
    .array(
      z.object({
        object: z.string().describe("Object to activate. Same spelling `object` accepts."),
        type: z.string().optional().describe("ADT type, e.g. DTEL/DE."),
        affects: affectsSchema.optional().describe("Required to activate ENHO/XH or ENHS/XS."),
      }),
    )
    .min(1)
    .max(MAX_ACTIVATION_BATCH)
    .optional()
    .describe("Batch activate, 2+ objects; omit `object`. mode=activate only."),
};

export const ActivateInput = z.object(activateInputSchema);
export type ActivateInput = z.infer<typeof ActivateInput>;

// ---------------------------------------------------------------------------
// Journalling
// ---------------------------------------------------------------------------

/**
 * One object about to be activated, as the journal needs to see it. `corrNr`
 * is per object, not per call: the batch path resolves a transport per
 * member, and two members can legitimately land in different requests.
 */
interface ActivationJournalTarget {
  readonly target: ResolvedTarget;
  /** The enhanced (target) object, for an `ENHO/*`/`ENHS/*` activation only. */
  readonly affects?: EnhancedObjectRef;
  readonly corrNr?: string;
}

/** What {@link journalActivations} hands back. */
interface JournalledActivation<T> {
  /** Whatever the wrapped activation returned. */
  readonly result: T;
  /**
   * Settles every entry with its terminal outcome; a no-op if nothing was
   * recorded. `null` leaves that entry `pending`.
   */
  settle(patchFor: (index: number) => JournalFinishPatch | null): Promise<void>;
}

/**
 * The journal's begin → mutate → settle choreography for activation.
 *
 * Not `withJournalledMutation` (src/journal.ts): that helper writes ONE entry
 * per call via an `onBeforeImage` hook, but activation reads no source and
 * takes no lock (nothing to hook), and one `activateObjects` request can
 * cover up to `MAX_ACTIVATION_BATCH` objects — so this writes ONE ENTRY PER
 * OBJECT instead (see `abapActivateBatch`'s doc comment for why). Otherwise
 * identical contract: every entry on disk before the mutating request,
 * disabled/absent journal is an inert pass-through. How a throw settles each
 * entry is the caller's to decide via `onThrow` — it defaults to every entry
 * `failed`, correct only when the call really is all-or-nothing.
 *
 * Entry shape: `irreversible: true` because ADT has no deactivate operation
 * at all (`undoBlocker()`, src/adt/undo.ts, already refuses by name — this
 * flag instead drives *presentation* paths like `abap_journal mode=show`'s
 * banner). `beforeCapture: "unknown"` with `existedBefore: true`: existence
 * IS verified (`assertActivatable`'s metadata GET), but there is no
 * before-image to capture since activation changes no source — `"unknown"`
 * avoids `begin()`'s default `"failed"`, which would wrongly imply a read
 * was attempted. Full rationale: the git history
 */
async function journalActivations<T>(
  journal: Journal | undefined,
  conn: AbapConnection,
  items: ReadonlyArray<ActivationJournalTarget>,
  run: () => Promise<T>,
  /**
   * Patch for entry `index` when `run()` throws; `null` leaves it `pending`.
   * Defaults to settling the whole set `failed` — correct only when the call
   * really was all-or-nothing.
   */
  onThrow?: (e: unknown, index: number) => JournalFinishPatch | null,
): Promise<JournalledActivation<T>> {
  const ids: string[] = [];

  const settleAll = async (patchFor: (index: number) => JournalFinishPatch | null): Promise<void> => {
    if (!journal) return;
    for (let i = 0; i < ids.length; i++) {
      const p = patchFor(i);
      if (p) await journal.finish(ids[i]!, p);
    }
  };

  if (journal) {
    try {
      for (const item of items) {
        const entry = await journal.begin({
          operation: "activate",
          object: {
            ...journalRef(item.target),
            // Set only for an enhancement object, so undo's/abap_journal's
            // messages can name the SAP object it affects, not just itself.
            ...(item.affects ? { affects: item.affects } : {}),
          },
          existedBefore: true,
          beforeCapture: "unknown",
          systemKey: systemKey(conn.cfg),
          ...(item.corrNr !== undefined ? { corrNr: item.corrNr } : {}),
          irreversible: true,
          // Also recorded for `abap_do action=activate`, which is a facade
          // that reshapes its args into `ActivateInput` and calls this
          // function — the tool that actually ran, not the caller's dialect.
          tool: "abap_activate",
        });
        if (entry) ids.push(entry.id);
      }
    } catch (e) {
      // begin() throwing aborts the activation. Entries 1..k-1 already
      // reached disk for a mutation that will now never run — settle them
      // `failed` rather than leave them `pending`.
      await settleAll(() => ({
        outcome: "failed",
        error: `activation abandoned: the journal entry for a later object in the same call could not be written (${String(e)}). No activation request was sent.`,
      }));
      throw e;
    }
  }

  let result: T;
  try {
    result = await run();
  } catch (e) {
    await settleAll((i) => (onThrow ? onThrow(e, i) : { outcome: "failed", error: String(e) }));
    throw e;
  }
  return { result, settle: settleAll };
}

/**
 * `AdtMessage[]` as one string for a journal entry's `activation.messages`,
 * or `undefined` when there's nothing to say. Capped — the journal index is
 * JSONL (one line per entry), and a noisy activation across a 50-object batch
 * would otherwise blow up every line; the response body the caller already
 * got is the unabridged copy. Goes through `truncateText`, not a hand-rolled
 * slice, so the cut self-discloses (`test/no-silent-truncation.test.ts`
 * enforces this — it caught the first version of this function).
 */
const JOURNAL_MESSAGES_MAX = 2000;
function journalMessages(messages: readonly AdtMessage[]): string | undefined {
  const text = renderMessages([...messages]).trim();
  if (!text) return undefined;
  return truncateText(text, JOURNAL_MESSAGES_MAX);
}

/**
 * How ONE object's journal entry settles when the batch as a whole threw.
 * The batch is not one request: chunks are POSTed sequentially and ADT has no
 * deactivate, so an earlier chunk that answered clean stays activated. `unknown`
 * (that chunk's POST never answered) has no terminal outcome in the journal's
 * `pending | succeeded | failed` model, so the entry deliberately stays
 * `pending` and the fact is warned about — same convention as
 * abap_transport_release's `unproven` verdict.
 */
function activationThrowPatch(
  disposition: ActivationDisposition,
  name: string,
  e: unknown,
): JournalFinishPatch | null {
  switch (disposition) {
    case "activated":
      return { outcome: "succeeded", activation: { attempted: true, activated: true } };
    case "unknown":
      process.stderr.write(
        `[abapsmith] WARNING: the journal entry for ${name} stays \`pending\` on purpose: the ` +
          `activation request naming it did not answer, so whether it activated was never ` +
          `observed. Re-read the object to see its state.\n`,
      );
      return null;
    case "not-sent":
      return {
        outcome: "failed",
        error: `no activation request naming ${name} was sent: an earlier chunk of the same batch failed first (${String(e)}).`,
      };
    case "not-activated":
      return { outcome: "failed", error: String(e) };
  }
}

/** Not `renderInactive` (adt/activate.ts): its closing line advises on an object still failing to activate — backwards here, since these already did. */
export function renderCoActivated(preaudit: readonly InactiveObjectRef[]): string {
  const named = preaudit.filter((o) => !(o.name === "(unknown)" && o.type === "(unknown)"));
  const skipped = preaudit.length - named.length;
  const lines: string[] = [];
  if (named.length > 0) {
    lines.push(
      `Activated together with the request, because SAP's preaudit required ${named.length === 1 ? "it" : "them"}:`,
      ...named.map((o) => `  ${o.name} (${o.type})`),
    );
  }
  if (skipped > 0) {
    lines.push(
      `${skipped} more co-activated object${skipped === 1 ? "" : "s"} had no name/type in SAP's ` +
        `reply and ${skipped === 1 ? "is" : "are"} omitted above.`,
    );
  }
  return lines.join("\n");
}

export async function abapActivate(
  conn: AbapConnection,
  input: ActivateInput,
  maxChars: number,
  gate: SafetyGate,
  /**
   * Activation of a transportable object routes through the same pre-flight
   * `resolve()` the write path uses. `mode=check` never touches it.
   */
  transport?: SessionTransport,
  /**
   * OPTIONAL here, REQUIRED on `ActivateToolDeps` below: this function is
   * exported so tests can drive activation directly without a composition
   * root, which a real server can't be built without. A caller that wants
   * nothing recorded passes the DISABLED journal, never `undefined`.
   */
  journal?: Journal,
): Promise<BuiltResponse> {
  // Hinted parse + explicit `containerName`, as `targetFromInput` does in
  // tools/write.ts — the hintless version bit this tool live for
  // container-parented types (FUGR/FF, FUGR/I); see archive for the incident.
  const mode = input.mode ?? "activate";

  // ---- batch dispatch ----------------------------------------------------
  //
  // `object`/`objects` are both plain-optional (not a `.refine()`-wrapped
  // union) so `ActivateInput` stays a bare `z.object(...)` — required by
  // `test/v2-write-arg-forwarding.test.ts` §6. The cross-field rules a union
  // would otherwise encode are therefore checked here, by hand.
  if (input.objects !== undefined) {
    const stray = (["object", "type", "affects", "corr_nr", "source"] as const).filter(
      (k) => input[k] !== undefined,
    );
    if (stray.length) {
      throw new AbapError(
        "BAD_INPUT",
        "`objects` is the batch form and does not combine with top-level " +
          `${stray.map((k) => `\`${k}\``).join(", ")} — each entry in \`objects\` carries its ` +
          "own `object`/`type`/`affects`.",
        { stray },
        "Drop the top-level field(s) named above, or activate that one object by itself with " +
          "`object` instead of `objects`.",
      );
    }
    if (mode !== "activate") {
      throw new AbapError(
        "BAD_INPUT",
        "`objects` (batch activation) only supports mode=activate — there is no batch syntax " +
          "check. Check each object individually with `object` + `mode: \"check\"` first if " +
          "needed.",
        { mode },
        "Drop `mode` (default is activate) or check objects one at a time with `object`.",
      );
    }
    return abapActivateBatch(conn, input.objects, maxChars, gate, transport, journal);
  }

  const objectRef = input.object;
  if (objectRef === undefined) {
    throw new AbapError(
      "BAD_INPUT",
      "Pass either `object` (single object) or `objects` (batch — 2 or more objects in one " +
        "activation request).",
      {},
      "Add `object: \"<name>\"` to activate one object, or `objects: [...]` to activate several.",
    );
  }

  const hint = input.type ? (specForType(input.type) ?? specForKeyword(input.type)) : undefined;
  const parsed = parseObjectRef(objectRef, hint);
  const type = input.type ?? parsed.spec?.type;

  const wanted = {
    name: parsed.name,
    ...(parsed.parent ? { containerName: parsed.parent } : {}),
    ...(type ? { type } : {}),
    // Carried through so `authorizeMutation` below can build an
    // `EnhancementIntent` for an ENHO/XH or ENHS/XS target — see the schema's
    // `affects` doc comment. Ignored by `resolveWriteTarget` for every other
    // type; harmless to pass unconditionally.
    ...(input.affects ? { affects: input.affects } : {}),
  };

  // Resolve first for BOTH modes — existence is only knowable from the
  // server. `resolveWriteTarget` also does a single metadata GET, making
  // `package` below a fact, not an assumption. `op: "activate"` additionally
  // admits an EXISTING ENHO/XH or ENHS/XS (`ACTIVATION_ONLY_TYPES`,
  // capabilities.ts) — types abap_write/abap_delete still cannot reach.
  const resolved = await resolveWriteTarget(conn, wanted, "activate");

  // NOT_FOUND, not BAD_INPUT: the request is well-formed, the object simply
  // isn't there — the same code every "not on this system" answer uses.
  const assertActivatable = (t: typeof resolved): void => {
    if (t.exists) return;
    throw new AbapError(
      "NOT_FOUND",
      `${t.spec.label} ${t.name} does not exist on ${conn.cfg.sid}, so there is nothing to ` +
        `activate. Nothing was checked, locked or changed.`,
      { object: t.name, type: t.type, uri: t.uri, system: conn.cfg.sid, mode },
      "Write it first with `abap_write` (that creates AND activates it), or correct the name / " +
        "`type` if you meant an object that is already there. To syntax-check a draft that has " +
        "no object on the server yet, use `mode=check` with `source`.",
    );
  };
  if (mode === "activate") assertActivatable(resolved);

  // Resolution and authorisation are one step: the gate must judge the
  // package the server reported for THIS object, so `authorizeMutation`
  // stays the ONE place a gate decision is made (costs a second metadata
  // GET). The re-assert below covers the tiny window where the object is
  // deleted between the two resolves — still answered NOT_FOUND.
  const authorized =
    mode === "activate" ? await authorizeMutation(conn, gate, "activate", wanted) : undefined;
  const target = authorized ? authorized.target : resolved;
  if (mode === "activate") assertActivatable(target);

  // Built once and reused by every later gate consultation (the C3 re-assert
  // below). A live A4H run found C3 re-consulting the gate on a bare
  // `{name, packageName, type}` with no intent, silently refusing every
  // ENHO/XH or ENHS/XS target regardless of `affects` — computing it here
  // from `input.affects` + `target` means it can't drift from what
  // `authorizeMutation` already decided. `undefined` for a non-enhancement
  // type or no `affects` is always inert, never wrong.
  const activateIntent =
    mode === "activate" && isEnhancementType(target.type) && input.affects
      ? enhancementIntentFor(target, input.affects)
      : undefined;

  // No draft ⇒ nothing to feed `checkruns` YET. `""` is not a safe stand-in:
  // `abap-adt-api`'s `syntaxCheck` throws its own untyped error on falsy
  // content for generic (non-CDS) objects. `mode=activate` doesn't need
  // source at all (`activateObject` uses what's saved).
  //
  // `mode=check` with no `source`: the caller almost always
  // means "check what I already saved" — that source IS retrievable for any
  // type with `TypeSpec.supportsSource`, so fetch it and check THAT instead
  // of refusing outright. Costs one extra ADT read (`getObjectSource`)
  // beyond the checkruns POST that would run anyway — a trade explicitly
  // accepted here. Still refuses `BAD_INPUT` fast, with no round trip
  // attempted, when a saved source genuinely cannot exist: the object
  // doesn't exist yet (nothing saved to fetch — mode=check never runs
  // `assertActivatable` above, so `target.exists` can be false here), or the
  // type has no `/source/main` at all (`supportsSource: false` — ENHO/XH,
  // ENHS/XS, DTEL/DE, DOMA/DD, TTYP/DA, MSAG/N, ENQU/DL, DEVC/K, SRVB/SVB;
  // see src/adt/types.ts).
  let source = input.source;
  let checkedSavedSource = false;
  if (source === undefined && mode === "check") {
    if (!target.exists || !target.spec.supportsSource) {
      throw new AbapError(
        "BAD_INPUT",
        `mode=check was given no \`source\`, and there is no saved source to check instead: ` +
          (target.exists
            ? `${target.spec.label} objects (${target.type}) have no retrievable ` +
              "\`/source/main\` — only source-based types get an automatic saved-source check."
            : `${target.spec.label} ${target.name} does not exist on ${conn.cfg.sid} yet, so ` +
              "nothing has been saved to check."),
        { object: target.name, type: target.type, mode, exists: target.exists },
        "Pass `source` with the text to check, or drop `mode` (default is activate) to activate " +
          "what is already saved on the server.",
      );
    }
    try {
      source = await conn.adt.getObjectSource(target.sourceUri);
    } catch (e) {
      // A typed error (NOT_FOUND, AUTH_FAILED, a dead session, …), not a
      // masqueraded BAD_INPUT: the type genuinely supports source and the
      // object genuinely exists, so a failure here is a real system problem,
      // not "the caller forgot to send source".
      throw translateAdtError(e, {
        operation: "read saved source for mode=check (no `source` was supplied)",
        uri: target.sourceUri,
        name: target.name,
        type: target.type,
      });
    }
    checkedSavedSource = true;
  }

  const check = source !== undefined ? await checkSource(conn, target, source) : undefined;

  let activation: ActivationOutcome | undefined;
  let corrNr: string | undefined;
  if (mode === "activate" && (check === undefined || check.ok)) {
    // ---- Transport, pre-flight ("abap_activate transport guard") ------
    // Closes a real defect: activating a transportable object can itself
    // demand a request, decided from the pre-flight `KORRFLAG`, never from
    // an activation error (there may be none). Placed inside `check.ok`,
    // immediately before activation, because `resolve()` can CREATE a
    // request and a skipped (failed-check) activation must not leave a
    // stray one behind.
    //
    // **UNVERIFIED**: an activation that itself demands a request was never
    // captured on A4H — that a `denied` resolution should refuse the
    // activation, and that no `corrNr` needs to travel on the activation
    // request itself, are inference, not observation. What IS enforced: if a
    // transportable object cannot be given a request, this refuses rather
    // than activating and hoping. See archive for full detail.
    if (transport) {
      const res = await transport.resolve(
        conn,
        {
          uri: target.sourceUri,
          devclass: target.packageName,
          name: target.name,
          type: target.type,
        },
        "U",
        // Blank-normalised: `""` means "named nothing", not "a request
        // whose name is the empty string" — same reading as abap_write's.
        normalizeCorrNr(input.corr_nr) === undefined ? {} : { corrNr: normalizeCorrNr(input.corr_nr) },
      );
      const denial = toAbapError(res);
      if (denial) throw denial;
      corrNr = res.outcome === "transport" ? res.corrNr : undefined;
      // C3: re-consult the gate now the transport is actually resolved — the
      // ONE post-resolution check for the activate path (mirrors
      // `preflightCorr` on write/delete). `intent: activateIntent` and
      // `phase: "final"` matter: a live A4H run found this call site missing
      // both, refusing every ENHO/XH and ENHS/XS unconditionally. `phase:
      // "final"` lets the gate tell "you forgot affects" apart from "this
      // call site forgot to build the intent" (`INTERNAL_GATE_MISUSE`,
      // adt/errors.ts).
      gate.assert(
        "activate",
        { name: target.name, packageName: target.packageName, type: target.type },
        {
          phase: "final",
          intent: activateIntent,
          corr:
            res.outcome === "transport"
              ? {
                  kind: "transport",
                  corrNr: res.corrNr,
                  source:
                    res.source === "config-pin" || res.source === "caller" ? "named" : "auto",
                }
              : { kind: "local" },
        },
      );
    }

    // ---- Journal, then activate -----------------------------------------
    // Entry lands on disk BEFORE the POST. `assertNoErrors` runs INSIDE the
    // wrapped mutation: an activation with `[EAX]` messages or inactive
    // dependents did not activate, so `journalActivations` settles that
    // entry `failed` from the same throw the caller sees — the `CHECK_FAILED`
    // error itself is unchanged.
    const journalled = await journalActivations(
      journal,
      conn,
      [
        {
          target,
          // Keyed off `activateIntent`, not a re-test of `isEnhancementType`,
          // so the journal ref can't drift from what the gate was told.
          ...(activateIntent !== undefined && input.affects ? { affects: input.affects } : {}),
          ...(corrNr !== undefined ? { corrNr } : {}),
        },
      ],
      async () => {
        const outcome = await activateObject(conn, target);
        // An outcome that did not activate throws CHECK_FAILED here instead
        // of being dressed up as a result with `activated: false`.
        assertNoErrors(outcome, {
          what: "Activation",
          name: target.name,
          ...(input.source ? { source: input.source } : {}),
        });
        return outcome;
      },
    );
    activation = journalled.result;
    // Settled AFTER activation: `activated`/messages are the server's answer
    // and don't exist until the POST returns. `corrNr` went on `begin()`
    // instead, since the transport was resolved first.
    const settledMessages = journalMessages(journalled.result.messages);
    await journalled.settle(() => ({
      outcome: "succeeded",
      activation: {
        attempted: true,
        activated: journalled.result.activated,
        ...(settledMessages !== undefined ? { messages: settledMessages } : {}),
      },
    }));
  }

  const blocks: string[] = [];
  if (check) {
    // `source`, not `input.source`: when the source came from the saved-source
    // fetch (`checkedSavedSource`) rather than the caller, `input.source` is
    // `undefined` and would silently drop the line-context rendering below.
    const checkText = renderMessages(check.messages, source);
    blocks.push(`# SYNTAX CHECK\n${checkText.trim() || "(no messages)"}`);
  }
  if (activation) {
    const actText = renderMessages(activation.messages, input.source);
    if (actText.trim()) blocks.push(`# ACTIVATION\n${actText}`);
    if (activation.preaudit?.length) {
      blocks.push(`# CO-ACTIVATED\n${renderCoActivated(activation.preaudit)}`);
    }
    // Defensive: `assertNoErrors` above already throws on a non-empty list.
    if (activation.inactive.length) {
      blocks.push(`# INACTIVE DEPENDENTS\n${renderInactive(activation.inactive)}`);
    }
  }

  const notes: string[] = [];
  if (corrNr !== undefined) {
    notes.push(
      `This object is transportable and was activated under transport ${corrNr}. ` +
        "abap_activate never releases a transport — releasing is a separate tool, " +
        "abap_transport_release, which stays off unless " +
        // Names the lever actually in force (ABAP_MODE vs. the legacy flag).
        // Optional-chained: this is a NOTE, not a gate — test stubs hand in a
        // minimal SafetyGate, and a cosmetic sentence must never throw.
        (gate.config?.abapMode !== undefined
          ? "ABAP_MODE=admin (ABAP_ALLOW_TRANSPORT_RELEASE is not read while ABAP_MODE is set)."
          : "ABAP_ALLOW_TRANSPORT_RELEASE is set."),
    );
  }
  if (mode === "activate" && check !== undefined && !check.ok) {
    notes.push("Activation was SKIPPED: the syntax check reported errors. Nothing changed.");
  }
  if (input.source) {
    if (mode === "check") {
      notes.push("Checked the supplied draft, not the version stored on the server.");
    }
  } else if (checkedSavedSource) {
    // No `source` was supplied, but mode=check fetched and checked the
    // version already saved on the server instead of refusing outright.
    notes.push(
      "No `source` was supplied, so the version already saved on the server was fetched and " +
        "checked instead (one extra ADT read). Pass `source` explicitly to check an unsaved " +
        "draft instead of what's on the server.",
    );
  } else {
    // mode is necessarily "activate" here — mode=check with no retrievable
    // saved source (nonexistent object, or a type with no `/source/main`)
    // threw BAD_INPUT above instead of reaching this point.
    notes.push(
      "No `source` was supplied, so no pre-flight syntax check ran. Activation acted directly " +
        "on the version already stored on the server; any activation messages above are the " +
        "only check that actually ran.",
    );
  }

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      object: `${target.type} ${target.name}`,
      uri: target.uri,
      package: target.packageName,
      // "server" = read off adtcore:packageRef (what the gate judged);
      // "requested" = object doesn't exist yet, nothing to confirm.
      package_source: target.packageSource,
      mode,
      result: check
        ? check.ok
          ? "clean"
          : `${check.errors} error(s), ${check.warnings} warning(s)`
        : activation
          ? activation.ok
            ? "clean (no pre-flight check ran)"
            : `${activation.errors} error(s), ${activation.warnings} warning(s)`
          : "not checked",
      activated: activation ? activation.activated : mode === "activate" ? false : "n/a",
      ...(corrNr === undefined ? {} : { transport: corrNr }),
    },
    body: blocks.join("\n\n"),
    bodyLabel: "MESSAGES",
    notes,
    hints: [
      "Line numbers come from the check run and refer to the source that was checked.",
    ],
    maxChars,
  });
}

/**
 * The batch path for `abap_activate`'s `objects` field. Called from
 * `abapActivate` once `objects` is validated as the only relevant input;
 * also exported for direct test use.
 *
 * ## Two passes, nothing activated until both are done
 *
 * Pass 1 resolves and authorises EVERY entry — `authorizeMutation` throws on
 * the first failure, before any transport or activation request for ANY
 * entry, so a mixed batch is refused as a WHOLE. Pass 2 mirrors the
 * single-object path's per-object transport pre-flight (its "C3" comment) —
 * not shared, since resolve/re-assert are inherently per-object; same
 * UNVERIFIED risk, reachable across more objects here. `activateObjects`
 * after both passes is the only call that can change what's active.
 *
 * ## ONE JOURNAL ENTRY PER OBJECT, not one per call
 *
 * A batch is one wire request, but `Journal.list()` (src/journal.ts) filters
 * only `entry.object.name`, not `entry.parts` — one entry for a 50-object
 * batch would leave `abap_journal object=` blind to 49 of them (the exact
 * gap described above). `parts`' atomicity guarantee (undo restoring
 * some members not others) doesn't apply either, since activation can never
 * be undone. Per-object entries also keep history independent of how the
 * caller phrased the call, and let each entry carry its own
 * `BatchActivationOutcome.perObject` detail instead of 50 copies of one blob.
 *
 * Cost: a 50-object batch appends 50 index lines and can evict a quarter of
 * the default 200-entry retention (`DEFAULT_MAX_ENTRIES`, tunable via
 * `ABAP_JOURNAL_MAX_ENTRIES`) — real, but not worth losing per-object search
 * for. The batch is POSTed in chunks (`chunkActivationTargets`), so entries
 * CAN legitimately disagree — an earlier chunk activates and a later one
 * fails — and each entry is settled from `BatchActivationOutcome.perObject[i].disposition`.
 *
 * Full rationale: the git history
 */
export async function abapActivateBatch(
  conn: AbapConnection,
  entries: ReadonlyArray<{ object: string; type?: string; affects?: EnhancedObjectRef }>,
  maxChars: number,
  gate: SafetyGate,
  transport?: SessionTransport,
  /** See `abapActivate`'s own `journal` parameter. */
  journal?: Journal,
): Promise<BuiltResponse> {
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

  // ---- pass 1: resolve + authorise EVERY entry before activating ANY -----
  const authorized: Array<{ target: ResolvedTarget; affects?: EnhancedObjectRef }> = [];
  for (const w of wanted) {
    const a = await authorizeMutation(conn, gate, "activate", w);
    authorized.push({ target: a.target, affects: w.affectsRef });
  }

  // ---- pass 2: per-object transport pre-flight, only after ALL are authorised
  const targets: ActivationTarget[] = [];
  // Built in lockstep with `targets` (index i names the same object in
  // both) so each entry can settle with its own `perObject[i]` outcome below.
  const journalItems: ActivationJournalTarget[] = [];
  const corrNrs = new Set<string>();
  for (const { target, affects } of authorized) {
    let corrNr: string | undefined;
    if (transport) {
      const activateIntent =
        isEnhancementType(target.type) && affects ? enhancementIntentFor(target, affects) : undefined;
      const res = await transport.resolve(
        conn,
        { uri: target.sourceUri, devclass: target.packageName, name: target.name, type: target.type },
        "U",
        {},
      );
      const denial = toAbapError(res);
      if (denial) throw denial;
      if (res.outcome === "transport") {
        corrNrs.add(res.corrNr);
        corrNr = res.corrNr;
      }
      // C3, per object — see the single-object path's identical call.
      gate.assert(
        "activate",
        { name: target.name, packageName: target.packageName, type: target.type },
        {
          phase: "final",
          intent: activateIntent,
          corr:
            res.outcome === "transport"
              ? {
                  kind: "transport",
                  corrNr: res.corrNr,
                  source: res.source === "config-pin" || res.source === "caller" ? "named" : "auto",
                }
              : { kind: "local" },
        },
      );
    }
    targets.push(target);
    journalItems.push({
      target,
      // `affects` only meaningful for an enhancement type — same predicate as
      // `activateIntent` above.
      ...(isEnhancementType(target.type) && affects ? { affects } : {}),
      ...(corrNr !== undefined ? { corrNr } : {}),
    });
  }

  // Entries are on disk before any chunk's POST. `assertBatchActivated` runs
  // inside the wrapped mutation, and on a throw each entry settles from its
  // own object's disposition — the batch is chunked, so an earlier chunk that
  // already answered clean stays activated whatever a later one does.
  let dispositions: readonly ActivationDisposition[] = targets.map(() => "not-sent" as ActivationDisposition);
  const journalled = await journalActivations(
    journal,
    conn,
    journalItems,
    async () => {
      const o = await activateObjects(conn, targets, {
        onDisposition: (d) => {
          dispositions = d;
        },
      });
      assertBatchActivated(o, { what: "Activation" });
      return o;
    },
    (e, i) => activationThrowPatch(dispositions[i] ?? "unknown", targets[i]?.name ?? `object ${i + 1}`, e),
  );
  const outcome = journalled.result;
  await journalled.settle((i) => {
    const per = outcome.perObject[i];
    const messages = per ? journalMessages(per.messages) : undefined;
    return {
      outcome: "succeeded",
      activation: {
        attempted: true,
        // `perObject[i].activated`, not the batch's own `outcome.activated`:
        // they agree today, but this stays honest if partial success is ever added.
        activated: per ? per.activated : outcome.activated,
        ...(messages !== undefined ? { messages } : {}),
      },
    };
  });

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      objects: targets.map((t) => t.name).join(", "),
      count: targets.length,
      mode: "activate",
      result:
        outcome.warnings > 0 ? `clean, ${outcome.warnings} warning(s)` : "clean",
      activated: outcome.activated,
      ...(corrNrs.size ? { transport: [...corrNrs].join(", ") } : {}),
    },
    body: [
      renderBatch(outcome),
      ...(outcome.preaudit?.length ? [`## CO-ACTIVATED\n${renderCoActivated(outcome.preaudit)}`] : []),
    ]
      .filter((s) => s.trim())
      .join("\n\n"),
    bodyLabel: "MESSAGES",
    notes: [
      ...(corrNrs.size
        ? [
            `Transportable object(s) activated under transport ${[...corrNrs].join(", ")}. ` +
              "abap_activate never releases a transport — see abap_transport_release.",
          ]
        : []),
      "No `source` was supplied for any object — batch activation acts directly on the version " +
        "already saved on the server for each one; the messages above are the only check that ran.",
    ],
    hints: [
      "Each object's own section above is what the server tied to it; the (unattributed) " +
        "section, if present, could not be tied to any one object and still counts against " +
        "the batch.",
    ],
    maxChars,
  });
}

export interface ActivateToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars">;
  readonly transport: SessionTransport;
  /**
   * REQUIRED, not optional: absent from this interface until added,
   * `abap_activate` left nothing on disk, single or batch. "Journalling is
   * off" is already modelled INSIDE `Journal` (`begin()` returns `undefined`
   * when disabled) — pass the disabled journal, never no journal.
   */
  readonly journal: Journal;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/**
 * Registers `abap_activate` on `mcp`. mode=check runs a lock-free syntax
 * check (available even in read-only mode, per the module doc comment
 * above); mode=activate checks then activates, gated and routed through
 * `pool.withWrite` on the object.
 */
export function registerActivateTools(mcp: McpServer, deps: ActivateToolDeps): void {
  mcp.registerTool(
    "abap_activate",
    {
      description: "mode=check: syntax check, no lock. mode=activate: check then activate.",
      inputSchema: activateInputSchema,
      /**
       * `destructiveHint: true` — a judgement call (MCP doesn't formally
       * define the hint as "irreversible"). Evidence: `undoBlocker`
       * (src/adt/undo.ts) refuses every `activate` entry outright, and
       * activating REPLACES the active version with no earlier state to
       * return to. `abap_write` gets `destructiveHint: true` despite being
       * MORE reversible (journalled, undo-able) — leaving this at `false`
       * would invert that signal. See archive for full citations.
       */
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      try {
        const a = args as {
          object?: string;
          type?: string;
          mode?: string;
          affects?: EnhancedObjectRef;
          objects?: Array<{ object: string; type?: string; affects?: EnhancedObjectRef }>;
        };
        const mode = a.mode ?? "activate";

        if (a.objects !== undefined) {
          // Same rule `abapActivate` enforces again below, but this half
          // must fail BEFORE `ensureConnected()`.
          if (mode !== "activate") {
            throw new AbapError(
              "BAD_INPUT",
              "`objects` (batch activation) only supports mode=activate — there is no batch " +
                "syntax check.",
              { mode },
              "Drop `mode` (default is activate), or check objects one at a time with `object` " +
                'and `mode: "check"`.',
            );
          }
          // Zero-network preflight, once per object, so a refusal on ANY
          // member costs zero requests and happens before `ensureConnected()`.
          for (const entry of a.objects) {
            const pf = preflight(entry);
            deps.safety.assert("activate", pf, {
              phase: "preflight",
              corr: { kind: "unresolved" },
              intent: enhancementPreflightIntent({
                name: pf.name,
                type: pf.type,
                affects: entry.affects,
              }),
            });
          }
          await deps.ensureConnected();
          const run = (conn: AbapConnection) =>
            abapActivate(conn, args as ActivateInput, deps.cfg.maxResponseChars, deps.safety, deps.transport, deps.journal);
          // `pool.withWrite` takes at most ONE object-gate key — no
          // multi-object form. `undefined` is its documented "take a slot,
          // take no gate" contract: the batch still serialises via the write
          // slot, but doesn't additionally block a concurrent single-object
          // write to one of its members. Accepted as a known gap.
          const res = await deps.pool.withWrite("abap_activate", undefined, run);
          return ok(res.text);
        }

        if (a.object === undefined) {
          throw new AbapError(
            "BAD_INPUT",
            "Pass either `object` (single object) or `objects` (batch — 2 or more objects in " +
              "one activation request).",
            {},
            'Add `object: "<name>"` to activate one object, or `objects: [...]` to activate ' +
              "several.",
          );
        }
        const object = a.object;

        if (mode === "activate") {
          // `pf` computed once and reused below so the two calls can't drift.
          // A live A4H run found this call site once missing the paired
          // `enhancementPreflightIntent()` call, refusing well-formed
          // `affects` on every enhancement-type object.
          const pf = preflight({ object, type: a.type });
          deps.safety.assert("activate", pf, {
            phase: "preflight",
            corr: { kind: "unresolved" },
            intent: enhancementPreflightIntent({ name: pf.name, type: pf.type, affects: a.affects }),
          });
        } else {
          // Syntax check writes nothing, runs no customer code — available
          // even in read-only mode. `analyze` is outside MUTATING_OPS, so
          // this asserts explicitly rather than leaving the branch un-checked.
          deps.safety.assert("analyze", preflight({ object, type: a.type }), { phase: "preflight" });
        }
        await deps.ensureConnected();
        // Split by mode: pool.ts's ROLE SEMANTICS count checkruns (mode=check)
        // as a READ — it neither locks nor writes, so gating it would
        // serialise a harmless compile behind real writes for no gain.
        // Identical at maxSessions=1; matters once reads/writes get separate slots.
        const run = (conn: AbapConnection) =>
          abapActivate(conn, args as ActivateInput, deps.cfg.maxResponseChars, deps.safety, deps.transport, deps.journal);
        const res =
          mode === "activate"
            ? await deps.pool.withWrite("abap_activate", writeGateKey(object, a.type), run)
            : await deps.pool.withRead("abap_activate", run);
        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
