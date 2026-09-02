/**
 * `abap_enh` — MCP tool layer over `src/adt/enhancement-write.ts`, mirroring
 * `registerBopfTools`'s composition pattern (`src/tools/bopf.ts`) over `src/adt/bopf.ts`.
 *
 * Scope: writing the root `adtcore:description` of an EXISTING `ENHO/XH` (BAdI
 * implementation), `ENHO/XHH` (source-code plug-in) or `ENHS/XS` (enhancement spot),
 * optionally followed by activation. Creating a NEW object is out of scope for this
 * path (see the six create_* operations instead). Reading/searching is already
 * covered by `abap_read`/`abap_search`. Writing an `ENHO/XHH` plug-in's own
 * `/source/main` body is `abap_write` (`src/tools/write.ts`), not this tool.
 *
 * ## Gating — two-phase, `EnhancementIntent`-shaped
 * `writeEnhancementDescription` already performs its own unconditional final
 * `assertIntent(op:"write")`. This tool adds only a cheap, zero-network
 * `{ phase: "preflight" }` check before `ensureConnected()` (same shape
 * `abap_bopf_edit` uses) — `enhancementPackage: ""` defers the package-allowlist
 * rule until the real package is known, inside `writeEnhancementDescription`'s own GET.
 *
 * ## The activation leg is gated HERE, not inside `enhancement-write.ts`
 * `activateObject` takes no gate; `writeAndActivateEnhancementDescription` composes
 * write+activate with no independent check on the activate leg (unlike `bopf.ts`'s
 * edit path, which re-checks "activate" against the real package every time — a real
 * asymmetry between the two write surfaces, not fixed here). This tool never calls
 * that composed helper: it calls `writeEnhancementDescription` directly and, only
 * when `activate:true` was requested and the write changed something, asserts
 * `op:"activate"` against the REAL resolved package before calling `activateObject`
 * itself — mirroring `bopf.ts`. See the git history for the full
 * original reasoning.
 *
 * ## The `ENHO/XH` / `ENHS/XS` unverified-write caveat
 * `putVerified` is `false` for those two types: one clean, read-back-confirmed 200
 * PUT has been observed for each (see `enhancement-write.ts`'s "PUT verification
 * matrix"), but that single observation isn't the repeated, citable evidence
 * `ENHO/XHH` has. `buildEnhResponse` always echoes this caveat when `putVerified` is
 * `false` — it is a caveat on an already-SUCCESS result, not a failure signal.
 *
 * ## Refusal classification
 * Every thrown error passes through `classifyEnhancementRefusal`
 * (`src/adt/enhancement-refusals.ts`) before `deps.errorResult`, upgrading six
 * specific refusal families to a proper `AbapErrorCode` where capture evidence
 * supports it (see that module's header). Everything unmatched fails closed to the
 * unmodified error.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { SessionPool } from "../adt/pool.js";
import type { SessionTransport } from "../adt/session-transport.js";
import type { Config } from "../config.js";
import { normalizeCorrNr, type SafetyGate } from "../safety.js";
import { explainDeniedCapabilities, type ModeGovernedCapability } from "../mode.js";
import type { Journal, JournalFinishPatch } from "../journal.js";
import { journalRef, systemKey, withJournalledMutation } from "../journal.js";
import { AbapError } from "../adt/errors.js";
import { buildResponse } from "../compact.js";
import { activateObject, type ActivationOutcome } from "../adt/activate.js";
import { renderCoActivated } from "./activate.js";
import {
  writeEnhancementDescription,
  deleteEnhancementObject,
  setBadiImplementationActive,
  isEnhancementWriteType,
  ENHANCEMENT_WRITE_TYPES,
  type EnhancementWriteResult,
  type EnhancementBeforeImage,
  type EnhancementDeleteResult,
  type EnhancementDeleteBeforeImage,
  type EnhancementActivationResult,
} from "../adt/enhancement-write.js";
import { enhancementIntentFor, type EnhancedObjectRef } from "../adt/write.js";
import { classifyEnhancementRefusal } from "../adt/enhancement-refusals.js";
import type { RunResult } from "../adt/run.js";
import type { ExerciseParam } from "../adt/enhancement-templates.js";
import {
  ENH_CREATE_PACKAGE,
  createEnhancementSpot,
  addBadiDefinition,
  addFilterDefinition,
  createBadiImplementation,
  setFilterValues,
  exerciseBadi,
  spotUri,
  implUri,
  type EnhTranscriptResult,
} from "../adt/enhancement-bridge.js";
import {
  discoverHookAnchors,
  createHookImplementation,
  parseAnchorFullName,
  type HookHostRef,
  type HookAnchor,
  type CreateHookResult,
} from "../adt/enhancement-hook.js";
import { buildEnhancementUri, ENHOXHH_COLLECTION } from "../adt/enhancement.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ENH_CREATE_OPERATIONS = [
  "create_spot",
  "add_badi_def",
  "add_filter_def",
  "create_impl",
  "set_filter_values",
  "exercise",
] as const;
export type EnhCreateOperation = (typeof ENH_CREATE_OPERATIONS)[number];

/** Anchor discovery + source-code plug-in create (`src/adt/enhancement-hook.ts`) — two ops since MCP
 *  calls are stateless: discover an anchor, then create against it, in two round trips. */
export const ENH_HOOK_OPERATIONS = ["discover_hook_anchors", "create_hook"] as const;
export type EnhHookOperation = (typeof ENH_HOOK_OPERATIONS)[number];

/** Deletes an EXISTING enhancement object outright (`deleteEnhancementObject`, enhancement-write.ts);
 *  just `type` + `name`, no discovery round trip needed. */
export const ENH_DELETE_OPERATIONS = ["delete"] as const;
export type EnhDeleteOperation = (typeof ENH_DELETE_OPERATIONS)[number];

/** Flips `enho:isActive` on an EXISTING ENHO/XH implementation (SE19's "Active" checkbox) via
 *  `setBadiImplementationActive`. Reversible (call again with the opposite spec.active), so gated at
 *  the same "write" tier as write_description — never delete's admin tier. */
export const ENH_ACTIVATION_OPERATIONS = ["set_impl_active"] as const;
export type EnhActivationOperation = (typeof ENH_ACTIVATION_OPERATIONS)[number];

export const enhInputSchema = {
  operation: z
    .enum([
      "write_description",
      ...ENH_CREATE_OPERATIONS,
      ...ENH_HOOK_OPERATIONS,
      ...ENH_DELETE_OPERATIONS,
      ...ENH_ACTIVATION_OPERATIONS,
    ])
    .optional()
    .describe(
      'Default "write_description". Six create ops: always $TMP, always activate. discover_hook_anchors: ' +
        "read-only. delete needs ABAP_ALLOW_ENHANCEMENT_DELETE=true, irreversible. set_impl_active: reversible.",
    ),
  type: z
    .enum(ENHANCEMENT_WRITE_TYPES)
    .optional()
    .describe("Required for write_description/delete; unused otherwise."),
  name: z
    .string()
    .describe(
      "write_description/delete/set_impl_active: container name (never the nested badiImplementation " +
        "entry - use spec.implName). create_spot/add_badi_def/add_filter_def: spotName. " +
        "create_impl/set_filter_values: enhName. exercise: badiName. create_hook: new name. " +
        "discover_hook_anchors: unused.",
    ),
  description: z
    .string()
    .optional()
    .describe("Required for write_description/create_hook (new adtcore:description, max 60). Unused otherwise."),
  spec: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Fields per op (?=optional, else required; numbers=max chars). IDs max 30 chars, see enhancement skill.\n" +
        "create_spot: description(60).\n" +
        "add_badi_def: badiName, interfaceName, singleUse(bool), shortText(60).\n" +
        "add_filter_def: badiName, filterName, filterType(1 upper letter, e.g. C), filterText?(255).\n" +
        "create_impl: spotName, badiName, implName, implClass, active(bool), description(60).\n" +
        "set_filter_values: spotName, implName, filterName, filterType(as above), compare(=,<>,<,<=,>,>=,EQ," +
        "NE,LT,LE,GT,GE), value(255).\n" +
        "exercise: methodName, filterName?, filterValue?, params?[{name, kind?(importing/changing/exporting/" +
        "receiving, default importing, max 1 receiving), value?(req for importing/changing, else forbidden), " +
        "type?(params[].type: req for changing/exporting/receiving, else forbidden; namespaced type ref)}].\n" +
        "discover_hook_anchors: hostType, hostName, hostUri.\n" +
        "create_hook: hostType(PROG/P only), hostName, hostUri, anchorFullName, anchorFullDescription(200), " +
        "responsible?(12), activate?(bool).\n" +
        "set_impl_active: active(bool), implName?(omit only if exactly one entry), description?(60).",
    ),
  affects: z
    .object({
      name: z.string().describe("Affected object name."),
      packageName: z.string().describe("Affected object package."),
      masterSystem: z.string().optional().describe("SID if foreign; omit if local."),
      spotName: z.string().optional().describe("Spot name, if reached via one."),
    })
    .optional()
    .describe("Object affected; required except discover_hook_anchors."),
  corr_nr: z.string().optional().describe("Transport request (write_description/delete/set_impl_active only)."),
  expect_etag: z
    .string()
    .optional()
    .describe("Refuse if etag differs (write_description/delete/set_impl_active only)."),
  activate: z
    .boolean()
    .optional()
    .describe(
      "write_description only: activate after a changed write. create_hook uses spec.activate; " +
        "set_impl_active always activates.",
    ),
};

export const EnhInput = z.object(enhInputSchema);
export type EnhInput = z.infer<typeof EnhInput>;

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface EnhToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<
    Config,
    | "maxResponseChars"
    | "allowEnhancements"
    | "allowSourcePlugins"
    | "allowEnhancementDelete"
    | "user"
    // Not a capability — records which mechanism produced the three booleans above, so refusals
    // name the input that actually decided, not a hard-coded legacy flag. See archive.
    | "abapMode"
  >;
  /** Needed for the corrNr-flavoured write path, same as `abap_write`/`abap_bopf_edit`. */
  readonly transport: SessionTransport;
  /**
   * The write journal — same seam `abap_write` uses (`WriteToolDeps.journal`). REQUIRED: this
   * field was briefly optional once and `abap_enh` went silently unjournalled as a result — see
   * the git history for the incident.
   */
  readonly journal: Journal;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/** Stable, case-insensitive gate key for `pool.withWrite`'s `objectUri` slot. */
function enhGateKey(name: string): string | undefined {
  const trimmed = name.trim().toUpperCase();
  return trimmed === "" ? undefined : trimmed;
}

/** `affects` is schema-optional (only discover_hook_anchors — a pure read — can omit it); every other
 *  operation requires it and gets a clear BAD_INPUT, not a TypeError on `undefined.name`, if it is missing. */
function requireAffects(input: EnhInput, operation: string): EnhancedObjectRef {
  const a = input.affects;
  if (!a) {
    throw new AbapError(
      "BAD_INPUT",
      `operation:"${operation}" requires affects (the object this enhancement changes the behaviour of).`,
      { operation },
    );
  }
  return { name: a.name, packageName: a.packageName, masterSystem: a.masterSystem, spotName: a.spotName };
}

// ---------------------------------------------------------------------------
// Response rendering
// ---------------------------------------------------------------------------

function buildEnhResponse(write: EnhancementWriteResult, activation: ActivationOutcome | undefined, maxChars: number): string {
  const notes: string[] = [];
  if (!write.changed) {
    notes.push("No-op: the description already matched. Nothing was locked, written or activated.");
  }
  if (write.putVerified === false) {
    notes.push(
      `${write.target.type} PUT success is UNVERIFIED on this codebase — a live 200 against this collection ` +
        "has been observed once, independently confirmed by read-back, but not the repeated, citable evidence " +
        "ENHO/XHH has. This write is presented as a success because the server answered 200, but that response " +
        "shape is not yet corroborated to the same degree ENHO/XHH's has. Re-read the object to confirm the " +
        "description actually changed if this matters.",
    );
  }
  if (activation) {
    notes.push(
      activation.activated
        ? "Activated successfully."
        : "Activation did NOT succeed (a 200 status with a non-empty message checklist is a failure, not a " +
            "success — see activationMessages below).",
    );
  }
  return buildResponse({
    header: {
      type: write.target.type,
      name: write.target.name,
      changed: write.changed,
      etag: write.etag,
      previousEtag: write.previousEtag,
      transport: write.transport.status,
      corrNr: write.transport.status === "transport" ? write.transport.corrNr : undefined,
      putVerified: write.putVerified,
      affects: `${write.affects.name} (${write.affects.packageName})`,
      activated: activation?.activated,
      activationMessages: activation && activation.messages.length ? JSON.stringify(activation.messages) : undefined,
    },
    notes,
    maxChars,
  }).text;
}

/** Response for `operation:"delete"`. Deliberately terse: there is no `changed`/`putVerified`/
 *  activation state to report, just what was destroyed and how it was authorized (transport-wise). */
function buildEnhDeleteResponse(del: EnhancementDeleteResult, maxChars: number): string {
  return buildResponse({
    header: {
      type: del.target.type,
      name: del.target.name,
      deleted: del.deleted,
      previousEtag: del.previousEtag,
      transport: del.transport.status,
      corrNr: del.transport.status === "transport" ? del.transport.corrNr : undefined,
      affects: `${del.affects.name} (${del.affects.packageName})`,
    },
    notes: [
      "Irreversible: abapsmith has no undo for an enhancement delete (see undoBlocker in src/adt/undo.ts). " +
        "The journal entry for this delete is recorded but marked irreversible.",
    ],
    maxChars,
  }).text;
}

/** Response for `operation:"set_impl_active"`. Mirrors `buildEnhResponse`'s shape (this is a
 *  write, after all — same `changed`/`etag`/`putVerified`/`activated` fields matter here) rather than
 *  `buildEnhDeleteResponse`'s terser one, since nothing here is destroyed. */
function buildEnhActivationResponse(
  set: EnhancementActivationResult,
  activation: ActivationOutcome | undefined,
  maxChars: number,
): string {
  const notes: string[] = [];
  if (!set.changed) {
    notes.push("No-op: isActive already matched the requested value. Nothing was locked, written or activated.");
  }
  if (set.putVerified === false) {
    notes.push(
      "ENHO/XH PUT success is UNVERIFIED on this codebase — a live 200 against this collection has been " +
        "observed once, independently confirmed by read-back, but not the repeated, citable evidence ENHO/XHH " +
        "has. This write is presented as a success because the server answered 200, but that response shape is " +
        "not yet corroborated to the same degree ENHO/XHH's has. Re-read the object to confirm isActive " +
        "actually changed if this matters.",
    );
  }
  if (activation) {
    notes.push(
      activation.activated
        ? "Activated successfully."
        : "Activation did NOT succeed (a 200 status with a non-empty message checklist is a failure, not a " +
            "success — see activationMessages below).",
    );
  }
  return buildResponse({
    header: {
      type: set.target.type,
      name: set.target.name,
      implName: set.target.implName,
      active: set.target.active,
      changed: set.changed,
      etag: set.etag,
      previousEtag: set.previousEtag,
      transport: set.transport.status,
      corrNr: set.transport.status === "transport" ? set.transport.corrNr : undefined,
      putVerified: set.putVerified,
      affects: `${set.affects.name} (${set.affects.packageName})`,
      activated: activation?.activated,
      activationMessages: activation && activation.messages.length ? JSON.stringify(activation.messages) : undefined,
    },
    notes,
    maxChars,
  }).text;
}

/**
 * `operation:"set_impl_active"`. Same choreography as `write_description`'s branch below
 * (zero-network preflight, journalled mutation, final "activate" check against the resolved
 * package), calling `setBadiImplementationActive` against a hardcoded `type: "ENHO/XH"`.
 *
 * Activation is UNCONDITIONAL on a real change here, never opt-in — `input.activate` is not read.
 * A prior version gated it behind `input.activate` (default false); a live run then found
 * `set_impl_active(active:true)` reporting `changed:true` while a re-read showed
 * `activationStatus:inactive` — an unactivated PUT lands only on the object's INACTIVE version, and
 * ADT's unversioned GET returns that version's content, so a naive read-back looked correct too. Every
 * real change now runs `assertIntent(op:"activate")` + `activateObject`, in both directions
 * (activating and deactivating alike). See the git history for the full incident.
 * Activation failure is reported as data (`activated:false` + `activationMessages`), never thrown, so
 * a write that already landed is never stranded by a subsequent throw.
 */
async function runEnhSetActiveOperation(deps: EnhToolDeps, input: EnhInput): Promise<string> {
  const spec = input.spec as Record<string, unknown> | undefined;
  const active = requireSpecBool(spec, "active", "set_impl_active");
  const implName = specStr(spec, "implName");
  const description = specStr(spec, "description");
  const affects = requireAffects(input, "set_impl_active");

  // Zero-network preflight — same `enhancementPackage: ""` deferral write_description uses.
  // Both "write" and "activate" are asserted unconditionally (see doc comment above).
  const preflightIntent = enhancementIntentFor({ name: input.name, type: "ENHO/XH", packageName: "" }, affects);
  deps.safety.assertIntent(preflightIntent, { op: "write", phase: "preflight" });
  deps.safety.assertIntent(preflightIntent, { op: "activate", phase: "preflight" });

  await deps.ensureConnected();

  const gateKey = enhGateKey(input.name);
  const { set, activation } = await deps.pool.withWrite("abap_enh", gateKey, async (conn) => {
    const { result: set, settle } = await withJournalledMutation(
      deps.journal,
      {
        begin: (img: EnhancementBeforeImage) => ({
          operation: "update" as const,
          object: { ...journalRef(img.target), affects: img.affects },
          existedBefore: true,
          beforeCapture: "captured" as const,
          beforeSource: img.xml,
          ...(img.corrNr !== undefined ? { corrNr: img.corrNr } : {}),
          // undoBlocker() refuses EVERY enhancement type unconditionally, regardless of reversibility.
          irreversible: true,
          // Needed for systemMismatchBlocker's strong SID+origin+client comparison (src/adt/undo.ts);
          // without it, the SID-only fallback can't tell two boxes sharing a SID apart.
          systemKey: systemKey(conn.cfg),
          tool: "abap_enh",
        }),
      },
      (onBeforeImage) =>
        setBadiImplementationActive(
          conn,
          deps.safety,
          { name: input.name, active, implName, description },
          {
            transport: deps.transport,
            gate: deps.safety,
            // Blank-normalised: "" means "named nothing", not a request whose name is "".

            corrNr: normalizeCorrNr(input.corr_nr),
            affects,
            expectEtag: input.expect_etag,
            onBeforeImage,
          },
        ),
    );

    await settle({
      outcome: "succeeded",
      ...(set.xml ? { afterSource: set.xml } : {}),
      ...(set.transport.status === "transport" ? { corrNr: set.transport.corrNr } : {}),
      activation: { attempted: false },
    });

    // Unconditional: every real change is activated, in both directions (see doc comment above).
    let activation: ActivationOutcome | undefined;
    if (set.changed) {
      const finalIntent = enhancementIntentFor(
        { name: input.name, type: "ENHO/XH", packageName: set.target.packageName, masterSystem: set.target.masterSystem },
        affects,
      );
      deps.safety.assertIntent(finalIntent, { op: "activate" });
      activation = await activateObject(conn, { name: set.target.name, uri: set.target.uri });
      await settle({ outcome: "succeeded", activation: { attempted: true, activated: activation.activated } });
    }
    return { set, activation };
  });

  return buildEnhActivationResponse(set, activation, deps.cfg.maxResponseChars);
}

// ---------------------------------------------------------------------------
// The six create operations (`src/adt/enhancement-bridge.ts`)
// ---------------------------------------------------------------------------

function specStr(spec: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = spec?.[key];
  return typeof v === "string" ? v : undefined;
}

function specBool(spec: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const v = spec?.[key];
  return typeof v === "boolean" ? v : undefined;
}

/** Required-field reader for `spec` — throws BAD_INPUT (not a silent undefined) on anything missing or the wrong type. */
function requireSpecStr(spec: Record<string, unknown> | undefined, key: string, operation: string): string {
  const v = specStr(spec, key);
  if (v === undefined || v.trim() === "") {
    throw new AbapError("BAD_INPUT", `operation:"${operation}" requires spec.${key} (a non-empty string).`, {
      operation,
      field: key,
    });
  }
  return v;
}

function requireSpecBool(spec: Record<string, unknown> | undefined, key: string, operation: string): boolean {
  const v = specBool(spec, key);
  if (v === undefined) {
    throw new AbapError("BAD_INPUT", `operation:"${operation}" requires spec.${key} (a boolean).`, {
      operation,
      field: key,
    });
  }
  return v;
}

// Single source of truth for spec.params[].kind, so the shape check below and the schema
// .describe() text can't drift apart.
const EXERCISE_PARAM_KINDS = ["importing", "changing", "exporting", "receiving"] as const;

/**
 * `spec.params` for `exercise` — a closed shape (named scalar args), not free-form ABAP.
 * Defaults to `[]`. Validates SHAPE only (right JS type per field); per-kind cross-field rules
 * (which kinds require value/type, at-most-one-receiving, duplicate names) are validated once,
 * synchronously, in `exerciseFragment` (../adt/enhancement-templates.js) before any network call.
 */
function parseExerciseParams(spec: Record<string, unknown> | undefined): ExerciseParam[] {
  const raw = spec?.["params"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new AbapError(
      "BAD_INPUT",
      'operation:"exercise" spec.params must be an array of {name, kind?, value?, type?}.',
      { got: typeof raw },
    );
  }
  return raw.map((item, i) => {
    const rec = item as Record<string, unknown> | null;
    if (!rec || typeof rec !== "object" || typeof rec["name"] !== "string") {
      throw new AbapError(
        "BAD_INPUT",
        `operation:"exercise" spec.params[${i}] must be {name: string, kind?: string, value?: string, type?: string}.`,
        { index: i },
      );
    }
    if (rec["kind"] !== undefined && !EXERCISE_PARAM_KINDS.includes(rec["kind"] as (typeof EXERCISE_PARAM_KINDS)[number])) {
      throw new AbapError(
        "BAD_INPUT",
        `operation:"exercise" spec.params[${i}].kind must be one of ${EXERCISE_PARAM_KINDS.join(", ")} when given.`,
        { index: i, got: rec["kind"] },
      );
    }
    if (rec["value"] !== undefined && typeof rec["value"] !== "string") {
      throw new AbapError(
        "BAD_INPUT",
        `operation:"exercise" spec.params[${i}].value must be a string when given.`,
        { index: i },
      );
    }
    if (rec["type"] !== undefined && typeof rec["type"] !== "string") {
      throw new AbapError(
        "BAD_INPUT",
        `operation:"exercise" spec.params[${i}].type must be a string when given.`,
        { index: i },
      );
    }
    return {
      name: rec["name"] as string,
      kind: rec["kind"] as ExerciseParam["kind"],
      value: rec["value"] as string | undefined,
      type: rec["type"] as string | undefined,
    };
  });
}

/**
 * `postActivation` covers the follow-up activation the six create operations except `exercise`
 * perform, always non-fatal (the object is already created either way; a failure here means
 * "created, not activated", never "nothing was created"): `set_filter_values`'s joint
 * spot+implementation re-activation, and `create_impl`/`create_spot`/`add_badi_def`/
 * `add_filter_def`'s own post-create activation of the object each just made or mutated.
 *
 * `activationTarget` names the object actually activated, for the retry hint on failure — not
 * always `objectName` (the headline name reported: e.g. add_badi_def/add_filter_def report
 * badiName/filterName but activate the SPOT they were added to). Omit to default to
 * `{ name: objectName, type: "ENHO/XH" }` (create_impl's shape, where the two coincide).
 */
function buildEnhCreateResponse(
  operation: EnhCreateOperation,
  objectName: string,
  run: RunResult,
  transcript: EnhTranscriptResult,
  postActivation: ActivationOutcome | undefined,
  maxChars: number,
  extraNotes?: string[],
  activationTarget?: { name: string; type: string },
): string {
  const notes: string[] = [
    `Landed in ${ENH_CREATE_PACKAGE} — the only package this codebase's non-atomic multi-step enhancement ` +
      "create has been proven safe in.",
  ];
  if (postActivation) {
    if (operation === "set_filter_values") {
      notes.push(
        postActivation.activated
          ? "The joint spot+implementation re-activation that a filter change requires also succeeded."
          : "The joint spot+implementation re-activation did NOT succeed — see activationMessages below.",
      );
    } else {
      const target = activationTarget ?? { name: objectName, type: "ENHO/XH" };
      notes.push(
        postActivation.activated
          ? `The operation above completed AND ${target.name}'s design-time version was activated ` +
            "(adtcore:version) — not just spec.active's runtime dispatch flag where one exists (enho:isActive " +
            "is a separate, orthogonal switch)."
          : `The operation above completed (see tags above) but ${target.name}'s design-time version was NOT ` +
            "activated — see activationMessages below. It exists but will not dispatch or be treated as " +
            `active until this is resolved (a common cause: a referenced class fails to compile). Fix the ` +
            `underlying problem, then retry activation directly, e.g. ` +
            `abap_activate(object:"${target.name}", type:"${target.type}").`,
      );
    }
  }
  if (extraNotes) notes.push(...extraNotes);
  // The preaudit set is SAP's, not the caller's: these objects were never named in the request.
  const sections =
    postActivation?.preaudit?.length
      ? [{ title: "CO-ACTIVATED", content: renderCoActivated(postActivation.preaudit) }]
      : undefined;
  return buildResponse({
    header: {
      operation,
      object: objectName,
      tags: transcript.tags.join(", "),
      durationMs: run.durationMs,
      outputComplete: run.outputComplete,
      activated: postActivation?.activated,
      activationMessages:
        postActivation && postActivation.messages.length ? JSON.stringify(postActivation.messages) : undefined,
    },
    body: run.output || undefined,
    bodyLabel: run.output ? "BRIDGE OUTPUT" : undefined,
    notes,
    ...(sections ? { sections } : {}),
    maxChars,
  }).text;
}

/**
 * Dispatches one of the six create operations. Each `enhancement-bridge.ts` function performs its
 * own unconditional final `gate.assertIntent` call — mirroring the same intent fields here lets the
 * zero-network preflight below refuse on the same grounds, without duplicating that authoritative check.
 */
export async function runEnhCreateOperation(
  deps: EnhToolDeps,
  operation: EnhCreateOperation,
  input: EnhInput,
): Promise<string> {
  const name = input.name;
  const spec = input.spec as Record<string, unknown> | undefined;
  const affects: EnhancedObjectRef = requireAffects(input, operation);
  const gateKey = enhGateKey(name);
  const maxChars = deps.cfg.maxResponseChars;

  switch (operation) {
    case "create_spot": {
      const spotName = name;
      const description = requireSpecStr(spec, "description", operation);
      const intent = enhancementIntentFor({ name: spotName, type: "ENHS/XS", packageName: ENH_CREATE_PACKAGE }, affects);
      deps.safety.assertIntent(intent, { op: "write", phase: "preflight" });
      deps.safety.assertIntent(intent, { op: "activate", phase: "preflight" });
      await deps.ensureConnected();
      const { run, transcript, activation } = await deps.pool.withWrite("abap_enh", gateKey, async (conn) => {
        // This dispatcher used to reference deps.journal nowhere at all. No GET
        // precedes this classrun create, so beforeCapture is left unset — Journal.begin() derives
        // the conservative "unknown" default, not create_hook's stronger "confirmed-absent" below
        // (this call's only evidence is a classrun print, not a checked POST status). irreversible:
        // true throughout this file: undoBlocker() (src/adt/undo.ts) refuses undo for EVERY
        // enhancement type unconditionally. See the git history for detail.
        const { result, settle } = await withJournalledMutation(
          deps.journal,
          {
            begin: () => ({
              operation: "create" as const,
              object: {
                ...journalRef({
                  name: spotName,
                  type: "ENHS/XS",
                  uri: spotUri(spotName),
                  packageName: ENH_CREATE_PACKAGE,
                  description,
                }),
                affects,
              },
              existedBefore: false,
              irreversible: true,
              systemKey: systemKey(conn.cfg),
              tool: "abap_enh",
            }),
          },
          async (onBeforeImage) => {
            await onBeforeImage(undefined);
            return createEnhancementSpot(conn, deps.safety, { spotName, description, affects });
          },
        );
        await settle({
          outcome: "succeeded",
          activation: { attempted: true, activated: result.activation.activated },
        });
        return result;
      });
      return buildEnhCreateResponse(operation, spotName, run, transcript, activation, maxChars, undefined, {
        name: spotName,
        type: "ENHS/XS",
      });
    }
    case "add_badi_def": {
      const spotName = name;
      const badiName = requireSpecStr(spec, "badiName", operation);
      const interfaceName = requireSpecStr(spec, "interfaceName", operation);
      const singleUse = requireSpecBool(spec, "singleUse", operation);
      const shortText = requireSpecStr(spec, "shortText", operation);
      const intent = enhancementIntentFor(
        { name: badiName, type: "ENHS/XS", packageName: ENH_CREATE_PACKAGE },
        { ...affects, spotName },
      );
      deps.safety.assertIntent(intent, { op: "write", phase: "preflight" });
      deps.safety.assertIntent(intent, { op: "activate", phase: "preflight" });
      await deps.ensureConnected();
      const { run, transcript, activation } = await deps.pool.withWrite("abap_enh", gateKey, async (conn) => {
        // Mutates the SPOT's own document (badiName is a definition entry WITHIN it,
        // not a separate ADT object — see addBadiDefinition's comment in enhancement-bridge.ts):
        // operation:"update", existedBefore:true. beforeCapture:"failed" (not "captured") since the
        // bridge classrun's own GET happens server-side and never returns source to this layer.
        const { result, settle } = await withJournalledMutation(
          deps.journal,
          {
            begin: () => ({
              operation: "update" as const,
              object: { ...journalRef({ name: spotName, type: "ENHS/XS", uri: spotUri(spotName), packageName: ENH_CREATE_PACKAGE }), affects },
              existedBefore: true,
              beforeCapture: "failed" as const,
              irreversible: true,
              systemKey: systemKey(conn.cfg),
              tool: "abap_enh",
            }),
          },
          async (onBeforeImage) => {
            await onBeforeImage(undefined);
            return addBadiDefinition(conn, deps.safety, { spotName, badiName, interfaceName, singleUse, shortText, affects });
          },
        );
        await settle({
          outcome: "succeeded",
          activation: { attempted: true, activated: result.activation.activated },
        });
        return result;
      });
      return buildEnhCreateResponse(
        operation,
        badiName,
        run,
        transcript,
        activation,
        maxChars,
        [
          `To call this BAdI from ABAP: DATA lo TYPE REF TO ${badiName}. GET BADI lo. — type the handle ` +
            `against the DEFINITION name (${badiName}, this call's own badiName), never against interfaceName ` +
            `(${interfaceName}) or spotName. Typing it against the interface fails to COMPILE, with the exact ` +
            `message "<handle> is not a valid BAdI handle here." — see the badi skill.`,
        ],
        // Activated object is the SPOT (spotName), not badiName — a definition is an entry within
        // the spot's own document, not a separate ADT object. See addBadiDefinition's own comment.
        { name: spotName, type: "ENHS/XS" },
      );
    }
    case "add_filter_def": {
      const spotName = name;
      const badiName = requireSpecStr(spec, "badiName", operation);
      const filterName = requireSpecStr(spec, "filterName", operation);
      const filterType = requireSpecStr(spec, "filterType", operation);
      const filterText = specStr(spec, "filterText");
      const intent = enhancementIntentFor(
        { name: badiName, type: "ENHS/XS", packageName: ENH_CREATE_PACKAGE },
        { ...affects, spotName },
      );
      deps.safety.assertIntent(intent, { op: "write", phase: "preflight" });
      deps.safety.assertIntent(intent, { op: "activate", phase: "preflight" });
      await deps.ensureConnected();
      const { run, transcript, activation } = await deps.pool.withWrite("abap_enh", gateKey, async (conn) => {
        // Same shape as add_badi_def above: mutates the SPOT's own document
        // (filterName is a definition-level entry within it), existedBefore:true, beforeCapture:"failed".
        const { result, settle } = await withJournalledMutation(
          deps.journal,
          {
            begin: () => ({
              operation: "update" as const,
              object: { ...journalRef({ name: spotName, type: "ENHS/XS", uri: spotUri(spotName), packageName: ENH_CREATE_PACKAGE }), affects },
              existedBefore: true,
              beforeCapture: "failed" as const,
              irreversible: true,
              systemKey: systemKey(conn.cfg),
              tool: "abap_enh",
            }),
          },
          async (onBeforeImage) => {
            await onBeforeImage(undefined);
            return addFilterDefinition(conn, deps.safety, { spotName, badiName, filterName, filterType, filterText, affects });
          },
        );
        await settle({
          outcome: "succeeded",
          activation: { attempted: true, activated: result.activation.activated },
        });
        return result;
      });
      // Activated object is the SPOT (spotName), not filterName — single-object here, unlike
      // set_filter_values's joint spot+implementation form. See addFilterDefinition's comment.
      return buildEnhCreateResponse(operation, filterName, run, transcript, activation, maxChars, undefined, {
        name: spotName,
        type: "ENHS/XS",
      });
    }
    case "create_impl": {
      const enhName = name;
      const spotName = requireSpecStr(spec, "spotName", operation);
      const badiName = requireSpecStr(spec, "badiName", operation);
      const implName = requireSpecStr(spec, "implName", operation);
      const implClass = requireSpecStr(spec, "implClass", operation);
      const active = requireSpecBool(spec, "active", operation);
      const description = requireSpecStr(spec, "description", operation);
      const intent = enhancementIntentFor(
        { name: enhName, type: "ENHO/XH", packageName: ENH_CREATE_PACKAGE },
        { ...affects, spotName },
      );
      deps.safety.assertIntent(intent, { op: "write", phase: "preflight" });
      deps.safety.assertIntent(intent, { op: "activate", phase: "preflight" });
      await deps.ensureConnected();
      const { run, transcript, activation, implClass: implClassCheck } = await deps.pool.withWrite("abap_enh", gateKey, async (conn) => {
        // A genuinely new ENHO/XH object (operation:"create", existedBefore:false) —
        // same reasoning as create_spot above (no GET precedes this create, beforeCapture left
        // unset). undoBlocker()'s delete-of-create wording here is the SHARPEST of the three
        // enhancement refusals (src/adt/undo.ts): undoing this create would delete a possibly-active implementation.
        const { result, settle } = await withJournalledMutation(
          deps.journal,
          {
            begin: () => ({
              operation: "create" as const,
              object: {
                ...journalRef({ name: enhName, type: "ENHO/XH", uri: implUri(enhName), packageName: ENH_CREATE_PACKAGE, description }),
                affects,
              },
              existedBefore: false,
              irreversible: true,
              systemKey: systemKey(conn.cfg),
              tool: "abap_enh",
            }),
          },
          async (onBeforeImage) => {
            await onBeforeImage(undefined);
            return createBadiImplementation(conn, deps.safety, { enhName, spotName, badiName, implName, implClass, active, description, affects });
          },
        );
        await settle({
          outcome: "succeeded",
          activation: { attempted: true, activated: result.activation.activated },
        });
        return result;
      });
      const createImplNotes = [
        `To call this from ABAP: DATA lo TYPE REF TO ${badiName}. GET BADI lo. CALL BADI lo->... — type the ` +
          `handle against the BAdI DEFINITION name (${badiName}), never against the marker interface or ` +
          `spotName (${spotName}). Typing it against the interface fails to COMPILE, with the exact message ` +
          `"<handle> is not a valid BAdI handle here." — see the badi skill.`,
      ];
      // Defect-2 guard: add_filter_def (definition-side) and set_filter_values (implementation-
      // side) are separate operations, so a new implementation may have no filter value yet — it
      // then dispatches for ANY filter value, silently. See badiFilterCheckFragment.
      if (transcript.tags.includes("BADI-HAS-FILTERS")) {
        createImplNotes.push(
          `WARNING: BAdI definition ${badiName} declares one or more filters, but this implementation has no ` +
            `filter values registered yet. Until set_filter_values(name:"${enhName}", spec:{spotName:"${spotName}", ` +
            `implName:"${implName}", ...}) is called, this implementation dispatches for ANY filter value on a ` +
            "multi-use BAdI — silently, with no exception, log, or warning at dispatch time.",
        );
      } else if (transcript.tags.includes("BADI-FILTER-CHECK-INCONCLUSIVE")) {
        createImplNotes.push(
          `Could not determine whether BAdI definition ${badiName} declares filters (diagnostic-only check did ` +
            "not complete) — if it does, verify filter values are registered via set_filter_values before relying " +
            "on this implementation to dispatch selectively.",
        );
      }
      if (implClassCheck.exists === false) {
        createImplNotes.push(
          `The enhancement now names ${implClass} as its implementing class, but ${implClass} DOES NOT EXIST on ` +
            "this system — create_impl records the reference, it does not generate the class shell SE19 " +
            `generates. This implementation cannot dispatch until you create the class yourself: ` +
            `abap_write(object:"${implClass}", type:"CLAS/OC", ...) with a class that implements the BAdI ` +
            "definition's marker interface, then activate it.",
        );
      } else if (implClassCheck.exists === undefined) {
        createImplNotes.push(
          `Could not check whether implementing class ${implClass} exists (the check did not complete). ` +
            `create_impl never creates it — unlike SE19 — so confirm it with abap_read(object:"${implClass}", ` +
            'type:"CLAS/OC") and create it if it is missing.',
        );
      }
      return buildEnhCreateResponse(operation, enhName, run, transcript, activation, maxChars, createImplNotes);
    }
    case "set_filter_values": {
      const enhName = name;
      const spotName = requireSpecStr(spec, "spotName", operation);
      const implName = requireSpecStr(spec, "implName", operation);
      const filterName = requireSpecStr(spec, "filterName", operation);
      const filterType = requireSpecStr(spec, "filterType", operation);
      const compare = requireSpecStr(spec, "compare", operation);
      const value = requireSpecStr(spec, "value", operation);
      const intent = enhancementIntentFor(
        { name: enhName, type: "ENHO/XH", packageName: ENH_CREATE_PACKAGE },
        { ...affects, spotName },
      );
      deps.safety.assertIntent(intent, { op: "write", phase: "preflight" });
      deps.safety.assertIntent(intent, { op: "activate", phase: "preflight" });
      await deps.ensureConnected();
      const { run, transcript, jointActivation } = await deps.pool.withWrite("abap_enh", gateKey, async (conn) => {
        // Mutates an EXISTING ENHO/XH implementation: operation:"update",
        // existedBefore:true, beforeCapture:"failed" (same reasoning as add_badi_def above).
        //
        // setFilterValues's joint POST /sap/bc/adt/activation also mutates a SECOND object in the
        // same call (the spot, ENHS/XS) that this outer entry doesn't name — a nested
        // withJournalledMutation begins that entry from onJointActivation, firing just before the
        // joint POST, so it lands on disk before the wire call that activates it.
        let jointSettle: ((patch: JournalFinishPatch) => Promise<void>) | undefined;
        const { result, settle } = await withJournalledMutation(
          deps.journal,
          {
            begin: () => ({
              operation: "update" as const,
              object: { ...journalRef({ name: enhName, type: "ENHO/XH", uri: implUri(enhName), packageName: ENH_CREATE_PACKAGE }), affects },
              existedBefore: true,
              beforeCapture: "failed" as const,
              irreversible: true,
              systemKey: systemKey(conn.cfg),
              tool: "abap_enh",
            }),
          },
          async (onBeforeImage) => {
            await onBeforeImage(undefined);
            const joint = await withJournalledMutation(
              deps.journal,
              {
                begin: () => ({
                  operation: "activate" as const,
                  object: {
                    ...journalRef({ name: spotName, type: "ENHS/XS", uri: spotUri(spotName), packageName: ENH_CREATE_PACKAGE }),
                    affects,
                  },
                  existedBefore: true,
                  beforeCapture: "failed" as const,
                  irreversible: true,
                  systemKey: systemKey(conn.cfg),
                  tool: "abap_enh",
                }),
              },
              async (onJoint) =>
                setFilterValues(conn, deps.safety, {
                  enhName,
                  spotName,
                  implName,
                  filterName,
                  filterType,
                  compare,
                  value,
                  affects,
                  onJointActivation: () => onJoint(undefined),
                }),
            );
            jointSettle = joint.settle;
            return joint.result;
          },
        );
        await jointSettle?.({
          outcome: "succeeded",
          activation: { attempted: true, activated: result.jointActivation.activated },
        });
        await settle({
          outcome: "succeeded",
          activation: { attempted: true, activated: result.jointActivation.activated },
        });
        return result;
      });
      return buildEnhCreateResponse(operation, enhName, run, transcript, jointActivation, maxChars);
    }
    case "exercise": {
      const badiName = name;
      const methodName = requireSpecStr(spec, "methodName", operation);
      const filterName = specStr(spec, "filterName");
      const filterValue = specStr(spec, "filterValue");
      // Defect 1(a): a filter value with no field name to substitute into `GET BADI ... FILTERS`
      // is the missing-parameter bug that used to emit the literal placeholder `flt`. Caught here,
      // before any wire call.
      if ((filterName === undefined) !== (filterValue === undefined)) {
        throw new AbapError(
          "BAD_INPUT",
          "exercise: spec.filterName and spec.filterValue must be given together (both or neither) — a filter " +
            "value with no filter field name has nothing to substitute into `GET BADI ... FILTERS`.",
          { filterName, filterValue },
        );
      }
      const params = parseExerciseParams(spec);
      const intent = enhancementIntentFor({ name: badiName, type: "ENHO/XH", packageName: ENH_CREATE_PACKAGE }, affects);
      // No read-only classrun exemption — "execute" is judged exactly like write/activate.
      deps.safety.assertIntent(intent, { op: "execute", phase: "preflight" });
      await deps.ensureConnected();
      const { run, transcript } = await deps.pool.withWrite("abap_enh", gateKey, (conn) =>
        exerciseBadi(conn, deps.safety, { badiName, methodName, filterName, filterValue, params, affects }),
      );
      return buildEnhCreateResponse(operation, badiName, run, transcript, undefined, maxChars);
    }
  }
}

// ---------------------------------------------------------------------------
// Anchor discovery + source-code plug-in create (`src/adt/enhancement-hook.ts`)
// ---------------------------------------------------------------------------

function specRequiredHost(spec: Record<string, unknown> | undefined, operation: string): HookHostRef {
  return {
    type: requireSpecStr(spec, "hostType", operation),
    name: requireSpecStr(spec, "hostName", operation),
    uri: requireSpecStr(spec, "hostUri", operation),
  };
}

function buildDiscoverHookAnchorsResponse(host: HookHostRef, anchors: HookAnchor[], maxChars: number): string {
  return buildResponse({
    header: {
      host: `${host.name} (${host.type})`,
      anchorCount: anchors.length,
    },
    body: JSON.stringify(anchors, null, 2),
    bodyLabel: "ANCHORS",
    notes: anchors.length === 0 ? ["No enhancement anchors found for this host."] : [],
    maxChars,
  }).text;
}

function buildCreateHookResponse(result: CreateHookResult, maxChars: number): string {
  const notes: string[] = [
    `Landed in ${ENH_CREATE_PACKAGE} — the only package this codebase's enhancement create has been proven safe in.`,
  ];
  if (result.activation) {
    notes.push(
      result.activation.activated
        ? "Activated successfully."
        : "Activation did NOT succeed (a 200 status with a non-empty message checklist is a failure, not a " +
            "success — see activationMessages below).",
    );
  } else {
    notes.push("Not activated — pass spec.activate=true to also activate (a separate POST, never atomic with create).");
  }
  return buildResponse({
    header: {
      name: result.name,
      uri: result.uri,
      etag: result.etag,
      location: result.location,
      activated: result.activation?.activated,
      activationMessages:
        result.activation && result.activation.messages.length ? JSON.stringify(result.activation.messages) : undefined,
    },
    notes,
    maxChars,
  }).text;
}

/**
 * Dispatches the two hook operations. `create_hook` runs the same `EnhToolDeps.cfg`-sourced
 * double-gate check (allowEnhancements AND allowSourcePlugins, never process.env) as its own
 * zero-network preflight, on top of the identical check `createHookImplementation` itself performs.
 */
export async function runEnhHookOperation(
  deps: EnhToolDeps,
  operation: EnhHookOperation,
  input: EnhInput,
): Promise<string> {
  const spec = input.spec as Record<string, unknown> | undefined;
  const maxChars = deps.cfg.maxResponseChars;

  if (operation === "discover_hook_anchors") {
    const host = specRequiredHost(spec, operation);
    await deps.ensureConnected();
    const anchors = await deps.pool.withRead("abap_enh", (conn) => discoverHookAnchors(conn, host));
    return buildDiscoverHookAnchorsResponse(host, anchors, maxChars);
  }

  // create_hook
  const host = specRequiredHost(spec, operation);
  const anchorFullName = parseAnchorFullName(requireSpecStr(spec, "anchorFullName", operation));
  const anchorFullDescription = requireSpecStr(spec, "anchorFullDescription", operation);
  const responsible = specStr(spec, "responsible") ?? deps.cfg.user.toUpperCase();
  const activate = specBool(spec, "activate") ?? false;
  const name = input.name;
  const description = input.description;
  if (description === undefined) {
    throw new AbapError(
      "BAD_INPUT",
      'operation:"create_hook" requires description (the new hook implementation\'s adtcore:description).',
      {},
    );
  }
  const affects = requireAffects(input, operation);

  // Double gate before any network call, in addition to assertIntent below. Read from
  // EnhToolDeps.cfg, never process.env directly.
  if (deps.cfg.allowEnhancements !== true || deps.cfg.allowSourcePlugins !== true) {
    const missing: ModeGovernedCapability[] = [
      ...(deps.cfg.allowEnhancements !== true ? (["allowEnhancements"] as const) : []),
      ...(deps.cfg.allowSourcePlugins !== true ? (["allowSourcePlugins"] as const) : []),
    ];
    const why = explainDeniedCapabilities(missing, deps.cfg.abapMode);
    throw new AbapError(
      "ENHANCEMENT_DISABLED",
      `Creating a source-code plug-in hook is disabled. ${why.cause}`,
      {
        allowEnhancements: deps.cfg.allowEnhancements,
        allowSourcePlugins: deps.cfg.allowSourcePlugins,
        ...(deps.cfg.abapMode !== undefined ? { abapMode: deps.cfg.abapMode } : {}),
      },
      why.remediation,
    );
  }

  const intent = enhancementIntentFor({ name, type: "ENHO/XHH", packageName: ENH_CREATE_PACKAGE }, affects);
  deps.safety.assertIntent(intent, { op: "write", phase: "preflight" });
  if (activate) {
    deps.safety.assertIntent(intent, { op: "activate", phase: "preflight" });
  }

  await deps.ensureConnected();

  const gateKey = enhGateKey(name);
  const hookUri = buildEnhancementUri(ENHOXHH_COLLECTION, name.trim().toLowerCase());
  const result = await deps.pool.withWrite("abap_enh", gateKey, async (conn) => {
    // A genuinely new ENHO/XHH object: operation:"create", existedBefore:false, and
    // (unlike the bridge-classrun sites above) beforeCapture:"confirmed-absent" — this call is a
    // plain conn.post (postHookImplementation) whose resp.status!==201 check + throw-on-non-2xx
    // transport gives the same "only returns normally on the create path" evidence
    // createBusinessObject's confirmed-absent relies on (bopf.ts). No recovered/not-recovered
    // fallback here — a throw propagates directly. irreversible:true (undoBlocker() refuses
    // ENHO/XHH unconditionally). hookUri is computed up front via the same deterministic formula
    // createHookImplementation builds internally, so the journal entry's identity is known before
    // the mutating call.
    const { result: hookResult, settle } = await withJournalledMutation(
      deps.journal,
      {
        begin: () => ({
          operation: "create" as const,
          object: {
            ...journalRef({ name, type: "ENHO/XHH", uri: hookUri, packageName: ENH_CREATE_PACKAGE, description }),
            affects,
          },
          existedBefore: false,
          beforeCapture: "confirmed-absent" as const,
          irreversible: true,
          systemKey: systemKey(conn.cfg),
          tool: "abap_enh",
        }),
      },
      async (onBeforeImage) => {
        await onBeforeImage(undefined);
        return createHookImplementation(conn, deps.safety, {
          name,
          description,
          host,
          anchor: { fullName: anchorFullName, fullDescription: anchorFullDescription },
          responsible,
          affects,
          activate,
          allowEnhancements: deps.cfg.allowEnhancements,
          allowSourcePlugins: deps.cfg.allowSourcePlugins,
          // Not a capability — carries which mechanism decided the two booleans above, so the
          // adt layer's own copy of this gate refuses with the same accurate remediation.
          ...(deps.cfg.abapMode !== undefined ? { abapMode: deps.cfg.abapMode } : {}),
        });
      },
    );
    // create_hook's activation is OPTIONAL (spec.activate, default false) — unlike the
    // other five enhancement mutations, which always activate. Record `attempted: false`
    // when activation was never requested, rather than a misleading `activated: false`.
    await settle({
      outcome: "succeeded",
      activation: hookResult.activation ? { attempted: true, activated: hookResult.activation.activated } : { attempted: false },
    });
    return hookResult;
  });
  return buildCreateHookResponse(result, maxChars);
}

/**
 * `operation:"delete"`. Same double-gate + preflight/final-assertIntent shape as
 * `write_description`, but with `op:"delete"` throughout, and journalled with `operation:"delete"` /
 * `irreversible: true`. See `deleteEnhancementObject`'s module header for why the
 * active-BAdI-implementation refusal alone survives as a hard, flag-independent refusal.
 *
 * The same `EnhToolDeps.cfg`-sourced double gate (allowEnhancements AND allowEnhancementDelete,
 * never process.env) that `deleteEnhancementObject` itself also checks — a genuine double gate:
 * this layer saves a caller a wasted round trip; the adt-layer copy protects any future non-tool caller.
 */
async function runEnhDeleteOperation(deps: EnhToolDeps, input: EnhInput): Promise<string> {
  const type = input.type;
  if (type === undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `operation:"delete" requires type. Supported: ${ENHANCEMENT_WRITE_TYPES.join(", ")}.`,
      { operation: "delete", arg: "type" },
    );
  }
  if (!isEnhancementWriteType(type)) {
    throw new AbapError(
      "UNSUPPORTED",
      `${type} is not a type abap_enh deletes. Supported: ${ENHANCEMENT_WRITE_TYPES.join(", ")}.`,
      { type },
    );
  }
  const affects = requireAffects(input, "delete");

  // Double gate before any network call, in addition to the identical check
  // deleteEnhancementObject performs itself.
  if (deps.cfg.allowEnhancements !== true || deps.cfg.allowEnhancementDelete !== true) {
    // Fixed a live incident: this message used to name both legacy variables even on a server
    // running ABAP_MODE=edit (where neither is read) with both already set by the operator. Now
    // only the capabilities genuinely missing are named, by the mechanism that actually decided them.
    const missing: ModeGovernedCapability[] = [
      ...(deps.cfg.allowEnhancements !== true ? (["allowEnhancements"] as const) : []),
      ...(deps.cfg.allowEnhancementDelete !== true ? (["allowEnhancementDelete"] as const) : []),
    ];
    const why = explainDeniedCapabilities(missing, deps.cfg.abapMode);
    throw new AbapError(
      "ENHANCEMENT_DISABLED",
      `Deleting an existing enhancement object is disabled. ${why.cause} ` +
        "Lifting this still does not lift the unconditional refusal for a BAdI implementation " +
        "reported (or not confirmably NOT) active.",
      {
        type,
        name: input.name,
        allowEnhancements: deps.cfg.allowEnhancements,
        allowEnhancementDelete: deps.cfg.allowEnhancementDelete,
        ...(deps.cfg.abapMode !== undefined ? { abapMode: deps.cfg.abapMode } : {}),
      },
      why.remediation,
    );
  }

  // Zero-network preflight, same `enhancementPackage: ""` deferral write_description uses — the
  // real package is not known until deleteEnhancementObject's own GET.
  const preflightIntent = enhancementIntentFor({ name: input.name, type, packageName: "" }, affects);
  deps.safety.assertIntent(preflightIntent, { op: "delete", phase: "preflight" });

  await deps.ensureConnected();

  const gateKey = enhGateKey(input.name);
  const del = await deps.pool.withWrite("abap_enh", gateKey, async (conn) => {
    // Journalled through the same helper as write_description. irreversible:true for the same
    // reason: undoBlocker() refuses EVERY enhancement type unconditionally and unforceably.
    const { result: del, settle } = await withJournalledMutation(
      deps.journal,
      {
        begin: (img: EnhancementDeleteBeforeImage) => ({
          operation: "delete" as const,
          object: { ...journalRef(img.target), affects: img.affects },
          existedBefore: true,
          beforeCapture: "captured" as const,
          beforeSource: img.xml,
          ...(img.corrNr !== undefined ? { corrNr: img.corrNr } : {}),
          irreversible: true,
          systemKey: systemKey(conn.cfg),
          tool: "abap_enh",
        }),
      },
      (onBeforeImage) =>
        deleteEnhancementObject(
          conn,
          deps.safety,
          { type, name: input.name },
          {
            transport: deps.transport,
            gate: deps.safety,
            // Blank-normalised: "" means "named nothing", not a request whose name is "".

            corrNr: normalizeCorrNr(input.corr_nr),
            affects,
            expectEtag: input.expect_etag,
            onBeforeImage,
            allowEnhancementDelete: deps.cfg.allowEnhancementDelete,
            // See the createHookImplementation call above: mechanism, not
            // capability, so deleteEnhancementObject's own double-gate copy of
            // this refusal names the deciding input too.
            ...(deps.cfg.abapMode !== undefined ? { abapMode: deps.cfg.abapMode } : {}),
          },
        ),
    );

    await settle({
      outcome: "succeeded",
      ...(del.transport.status === "transport" ? { corrNr: del.transport.corrNr } : {}),
    });

    return del;
  });

  return buildEnhDeleteResponse(del, deps.cfg.maxResponseChars);
}

// Kept short: operation/type/affects/corr_nr's own .describe() text already renders alongside this in
// the same schema payload, and mode-gating detail is generated fresh into the refusal message itself —
// restating either here taxed every session for nothing. What survives: the type-code glossary, the
// abap_write pointer, and a signpost to `operation`.
const ENH_TOOL_DESCRIPTION =
  "Default op writes the root adtcore:description of an existing ENHO/XH, ENHO/XHH or ENHS/XS, optionally " +
  "activating it. ENHO/XHH plug-in source body: use abap_write, not this tool. See operation for the other ops.";

/** Registers `abap_enh` on `mcp`. */
export function registerEnhancementTools(mcp: McpServer, deps: EnhToolDeps): void {
  mcp.registerTool(
    "abap_enh",
    {
      description: ENH_TOOL_DESCRIPTION,
      inputSchema: enhInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      try {
        const input = args as EnhInput;
        const operation = input.operation ?? "write_description";
        if (operation === "discover_hook_anchors" || operation === "create_hook") {
          const text = await runEnhHookOperation(deps, operation, input);
          return ok(text);
        }
        if (operation === "delete") {
          const text = await runEnhDeleteOperation(deps, input);
          return ok(text);
        }
        if (operation === "set_impl_active") {
          const text = await runEnhSetActiveOperation(deps, input);
          return ok(text);
        }
        if (operation !== "write_description") {
          const text = await runEnhCreateOperation(deps, operation, input);
          return ok(text);
        }

        const type = input.type;
        if (type === undefined) {
          throw new AbapError(
            "BAD_INPUT",
            `operation:"write_description" requires type. Supported: ${ENHANCEMENT_WRITE_TYPES.join(", ")}.`,
            { operation: "write_description", arg: "type" },
          );
        }
        if (!isEnhancementWriteType(type)) {
          throw new AbapError(
            "UNSUPPORTED",
            `${type} is not a type abap_enh writes. Supported: ${ENHANCEMENT_WRITE_TYPES.join(", ")}.`,
            { type },
          );
        }
        // description is schema-optional (create ops never use it) but required here — the only
        // field this path writes. Guarded explicitly rather than reaching writeEnhancementDescription's
        // required field silently.
        const description = input.description;
        if (description === undefined) {
          throw new AbapError(
            "BAD_INPUT",
            'operation:"write_description" requires description (the new adtcore:description value).',
            {},
          );
        }
        // Defect 3: adtcore:description is CHAR60 (t100 SWB_TOOL/18). Refused here, before any
        // wire call, mirroring abap_transport's own description field check (src/tools/transport.ts).
        if (description.length > 60) {
          throw new AbapError(
            "BAD_INPUT",
            `operation:"write_description" description is ${description.length} characters, longer than SAP's ` +
              "60-character limit for adtcore:description (t100 SWB_TOOL/18).",
            { length: description.length },
          );
        }
        const affects: EnhancedObjectRef = requireAffects(input, "write_description");
        const wantsActivate = input.activate === true;

        // Zero-network preflight — enhancementPackage:"" defers the package-allowlist rule until
        // writeEnhancementDescription's own GET resolves it; everything else still runs. Does NOT
        // duplicate that function's own unconditional final assertIntent (which runs with the real
        // package). Built via enhancementIntentFor (../adt/write.js), the same helper
        // enhancement-write.ts itself uses, so the masterSystem fields can't be mixed up.
        const preflightIntent = enhancementIntentFor({ name: input.name, type, packageName: "" }, affects);
        deps.safety.assertIntent(preflightIntent, { op: "write", phase: "preflight" });
        if (wantsActivate) {
          // activateObject takes no gate, and the composed writeAndActivateEnhancementDescription
          // helper doesn't gate the activate leg either (see module header). This preflight, and
          // the final check after the write below, are this tool's own addition.
          deps.safety.assertIntent(preflightIntent, { op: "activate", phase: "preflight" });
        }

        await deps.ensureConnected();

        const gateKey = enhGateKey(input.name);
        const { write, activation } = await deps.pool.withWrite("abap_enh", gateKey, async (conn) => {
          // Journalled through the same helper as `abap_write` (src/journal.ts): the entry lands
          // on disk before the lock/PUT, and is patched `failed` if the write throws.
          //
          // irreversible:true, deliberately: undoBlocker() (src/adt/undo.ts) refuses EVERY
          // enhancement type unconditionally. The record still has value (only trace of the prior
          // description) — it just must not promise a rollback it cannot perform.
          const { result: write, settle } = await withJournalledMutation(
            deps.journal,
            {
              begin: (img: EnhancementBeforeImage) => ({
                // Never a create: writeEnhancementDescription reads first and
                // throws NOT_FOUND rather than creating (step 1).
                operation: "update" as const,
                object: { ...journalRef(img.target), affects: img.affects },
                existedBefore: true,
                beforeCapture: "captured" as const,
                // The WHOLE document's XML, not just the description — needed to let a human
                // reconstruct the previous state.
                beforeSource: img.xml,
                ...(img.corrNr !== undefined ? { corrNr: img.corrNr } : {}),
                irreversible: true,
                systemKey: systemKey(conn.cfg),
                tool: "abap_enh",
              }),
            },
            (onBeforeImage) =>
              writeEnhancementDescription(
                conn,
                deps.safety,
                { type, name: input.name, description },
                {
                  transport: deps.transport,
                  gate: deps.safety,
                  // Blank-normalised: "" means "named nothing", not a request whose name is "".

                  corrNr: normalizeCorrNr(input.corr_nr),
                  affects,
                  expectEtag: input.expect_etag,
                  onBeforeImage,
                },
              ),
          );

          // Settled BEFORE the activation leg: the PUT is already durable by this point, so an
          // entry left "pending" by a later throw (gate check or activation) would misreport a
          // write that did land. The second settle() below only upgrades `activation`.
          await settle({
            outcome: "succeeded",
            ...(write.xml ? { afterSource: write.xml } : {}),
            ...(write.transport.corrNr ? { corrNr: write.transport.corrNr } : {}),
            activation: { attempted: false },
          });

          let activation: ActivationOutcome | undefined;
          if (wantsActivate && write.changed) {
            // Final "activate" check against the REAL resolved package/masterSystem — mirrors
            // bopf.ts's edit path, never trusting the earlier preflight alone. Only the
            // enhancement's own package/masterSystem (now resolved) differs from the preflight call above.
            const finalIntent = enhancementIntentFor(
              { name: input.name, type, packageName: write.target.packageName, masterSystem: write.target.masterSystem },
              affects,
            );
            deps.safety.assertIntent(finalIntent, { op: "activate" });
            activation = await activateObject(conn, { name: write.target.name, uri: write.target.uri });
            await settle({
              outcome: "succeeded",
              activation: { attempted: true, activated: activation.activated },
            });
          }
          return { write, activation };
        });

        return ok(buildEnhResponse(write, activation, deps.cfg.maxResponseChars));
      } catch (e) {
        return deps.errorResult(classifyEnhancementRefusal(e));
      }
    },
  );
}
