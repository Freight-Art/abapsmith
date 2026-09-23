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
import { normalizeCorrNr, type SafetyCorr, type SafetyGate } from "../safety.js";
import { explainDeniedCapabilities, type ModeGovernedCapability } from "../mode.js";
import type { BeforeImageCapture, Journal, JournalFinishPatch } from "../journal.js";
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
import { enhancementIntentFor, resolveWriteTarget, type EnhancedObjectRef } from "../adt/write.js";
import { classifyEnhancementRefusal } from "../adt/enhancement-refusals.js";
import { isLocalPackageName } from "../adt/transports.js";
import type { RunResult } from "../adt/run.js";
import type { ExerciseParam } from "../adt/enhancement-templates.js";
import {
  ENH_CREATE_PACKAGE,
  ENH_BRIDGE_PACKAGE,
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
import {
  buildEnhancementUri,
  ENHOXHH_COLLECTION,
  readBadiImplementation,
  readEnhancementSpot,
} from "../adt/enhancement.js";
import { parseBadiImplementation } from "../adt/enhancement-xml.js";

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

/** The ops that take `package`/`corr_nr`/`activate`; `exercise` creates nothing of the caller's own. */
export const ENH_FLUID_OPS = ["create_spot", "add_badi_def", "add_filter_def", "create_impl", "set_filter_values"] as const;
export type EnhFluidOp = (typeof ENH_FLUID_OPS)[number];

/** Ops for which `affects` is required (BAD_INPUT, zero network, when omitted). */
const AFFECTS_REQUIRED_OPS = [
  "create_impl",
  "set_filter_values",
  "exercise",
  "write_description",
  "delete",
  "set_impl_active",
] as const;

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
      'Default "write_description". The five fluid ops (create_spot, add_badi_def, add_filter_def, ' +
        "create_impl, set_filter_values) take package (default $TMP), corr_nr and activate (default true). " +
        "exercise creates nothing of the caller's own (its bridge class lives in $ABAPSMITH_FLUID_API). " +
        "create_hook lands in $TMP. discover_hook_anchors: read-only. delete needs " +
        "ABAP_ALLOW_ENHANCEMENT_DELETE=true, irreversible; set_impl_active: reversible.",
    ),
  package: z
    .string()
    .optional()
    .describe(
      "Target package for the five fluid ops only (create_spot, add_badi_def, add_filter_def, create_impl, " +
        "set_filter_values). Default $TMP; trimmed and uppercased. Given on any other operation: BAD_INPUT.",
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
      "Fields per op (?=optional; IDs max 30 chars; lengths and value rules in doc/TOOLS/enhancements.md).\n" +
        "create_spot: description.\n" +
        "add_badi_def: badiName, interfaceName, singleUse, shortText.\n" +
        "add_filter_def: badiName, filterName, filterType, filterText?.\n" +
        "create_impl: spotName, badiName, implName, implClass, active, description.\n" +
        "set_filter_values: spotName, implName, filterName, filterType, compare, value.\n" +
        "exercise: methodName, filterName?, filterValue?, params?[{name, kind?, value?, type?}] " +
        "(params[].type: required for changing/exporting/receiving, forbidden otherwise; a namespaced type ref is allowed).\n" +
        "discover_hook_anchors: hostType, hostName, hostUri.\n" +
        "create_hook: hostType(PROG/P only), hostName, hostUri, anchorFullName, anchorFullDescription, " +
        "responsible?, activate?.\n" +
        "set_impl_active: active, implName?(omit only if exactly one entry), description?.",
    ),
  affects: z
    .object({
      name: z.string().describe("Affected object name."),
      packageName: z.string().describe("Affected object package."),
      masterSystem: z.string().optional().describe("SID if foreign; omit if local."),
      spotName: z.string().optional().describe("Spot name, if reached via one."),
    })
    .optional()
    .describe(
      "Object affected. create_spot: optional, defaults to the spot itself. add_badi_def/add_filter_def: " +
        "optional, defaults to the spot itself. create_hook: optional, derived from spec.hostName when " +
        "omitted (one GET; NOT_FOUND if the host does not exist). REQUIRED (BAD_INPUT if omitted): " +
        `${AFFECTS_REQUIRED_OPS.join(", ")}. discover_hook_anchors: never used.`,
    ),
  corr_nr: z
    .string()
    .optional()
    .describe(
      "write_description/delete/set_impl_active: transport request, unchanged. Five fluid ops: the " +
        "transport for a transportable (non-$) package; with a local package this is BAD_INPUT. Omitted " +
        "with a transportable package is resolved by the session resolver under ABAP_ALLOW_TRANSPORTS=auto.",
    ),
  expect_etag: z
    .string()
    .optional()
    .describe("Refuse if etag differs (write_description/delete/set_impl_active only)."),
  activate: z
    .boolean()
    .optional()
    .describe(
      "write_description: activate after a changed write (input.activate === true). Five fluid ops: " +
        "default true; false saves without activating, leaving the object inactive. create_hook uses " +
        "spec.activate (default false); set_impl_active always activates.",
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

/** For the six ops in {@link AFFECTS_REQUIRED_OPS}: a clear BAD_INPUT, not a TypeError on
 *  `undefined.name`, when `affects` is missing. */
function requireAffects(input: EnhInput, operation: string): EnhancedObjectRef {
  const a = input.affects;
  if (!a) {
    throw new AbapError(
      "BAD_INPUT",
      `operation:"${operation}" requires affects (the object this enhancement changes the behaviour of). ` +
        `Operations that require it: ${AFFECTS_REQUIRED_OPS.join(", ")}. create_spot, add_badi_def and ` +
        "add_filter_def default to the spot; create_hook derives it from spec.hostName.",
      { operation, requiredFor: AFFECTS_REQUIRED_OPS },
    );
  }
  return { name: a.name, packageName: a.packageName, masterSystem: a.masterSystem, spotName: a.spotName };
}

/** create_spot/add_badi_def/add_filter_def: `affects` given by the caller, or defaulted to `fallback`
 *  (the spot itself) — see `enhInputSchema.affects`'s `.describe()`. */
function affectsOrDefault(input: EnhInput, fallback: EnhancedObjectRef): EnhancedObjectRef {
  const a = input.affects;
  return a ? { name: a.name, packageName: a.packageName, masterSystem: a.masterSystem, spotName: a.spotName } : fallback;
}

/** Five fluid ops: package (default $TMP)/corr_nr/activate, with the zero-network
 *  local-package-plus-named-corr refusal that must fire before ensureConnected(). */
function resolveFluidPackage(input: EnhInput): { packageName: string; named: string | undefined; activate: boolean } {
  const packageName = (input.package ?? "$TMP").trim().toUpperCase();
  const named = normalizeCorrNr(input.corr_nr);
  const activate = input.activate ?? true;
  if (isLocalPackageName(packageName) && named !== undefined) {
    throw new AbapError("BAD_INPUT", `package ${packageName} is local; a transport request does not apply.`, {
      field: "corr_nr",
      packageName,
      corrNr: named,
    });
  }
  return { packageName, named, activate };
}

/** Mirrors bridgePreflightCorr (src/tools/write.ts): the zero-network SafetyCorr shape for a preflight assert. */
function fluidPreflightCorr(named: string | undefined): SafetyCorr {
  return named === undefined ? { kind: "unresolved" } : { kind: "transport", corrNr: named, source: "named" };
}

/** The lead notes for buildEnhCreateResponse's five fluid-op call sites — package, an optional
 *  transport-recorded note, and an optional inactive-object note when activate:false. */
function fluidLeadNotes(
  packageName: string,
  activate: boolean,
  corr: { corrNr: string; source: "named" | "auto" } | undefined,
  name: string,
  type: string,
  affects: EnhancedObjectRef,
): string[] {
  const notes = [`Package ${packageName}.`];
  if (corr) {
    notes.push(
      `Recorded in transport request ${corr.corrNr} (${corr.source === "auto" ? "auto-resolved by the session" : "named by the caller"}).`,
    );
  }
  if (!activate) {
    const ref = `object:"${name}", type:"${type}"`;
    notes.push(
      `Created inactive (activate:false): review with abap_read(${ref}, enhancements:true), then ` +
        `abap_activate(${ref}, affects:${JSON.stringify(affects)}).`,
    );
  }
  return notes;
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
      "Irreversible: a deleted enhancement object cannot be recreated from its captured XML. The " +
        "journal entry for this delete is recorded, with that reason as its undoBlocker.",
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
          beforeKind: "enh-impl-active" as const,
          // The flipped implementation's name: the caller's own `implName` if it gave
          // one, else the sole entry in the before-image XML (set_impl_active refuses
          // an ambiguous "which one" earlier when there is more than one, so at this
          // point there is exactly one to pick). No result to fall back to here:
          // begin() runs before setBadiImplementationActive, via onBeforeImage.
          implName: implName ?? parseBadiImplementation(img.xml).implementations[0]?.name,
          ...(img.corrNr !== undefined ? { corrNr: img.corrNr } : {}),
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
  leadNotes: string[],
  extraNotes?: string[],
  activationTarget?: { name: string; type: string },
): string {
  const notes: string[] = [...leadNotes];
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
 * Runs a create's pre-flight existence read (issue #200): a create must not silently overwrite
 * an existing object, and a confirmed-absent read is what lets undo delete the object it created
 * without also deleting something the caller never made. NOT_FOUND (the read functions in
 * src/adt/enhancement.ts throw an `AbapError`, never a raw not-found shape, so `e.code` is checked
 * directly rather than `isNotFoundError`, which expects the untranslated error) means the create
 * may proceed with `beforeCapture: "confirmed-absent"`. Found means the create must not run at
 * all: throws `CHECK_FAILED` before any mutation. Any other error: the create still proceeds (as
 * before #200), just with `beforeCapture: "failed"` — no positive evidence either way.
 */
async function checkAbsentBeforeCreate(
  read: () => Promise<unknown>,
  ctx: { name: string; type: string },
): Promise<BeforeImageCapture> {
  try {
    await read();
  } catch (e) {
    if (e instanceof AbapError && e.code === "NOT_FOUND") return "confirmed-absent";
    return "failed";
  }
  throw new AbapError(
    "CHECK_FAILED",
    `${ctx.type} ${ctx.name} already exists — create cannot run over it.`,
    { name: ctx.name, type: ctx.type },
  );
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
  const gateKey = enhGateKey(name);
  const maxChars = deps.cfg.maxResponseChars;

  switch (operation) {
    case "create_spot": {
      const spotName = name;
      const description = requireSpecStr(spec, "description", operation);
      const { packageName, named, activate } = resolveFluidPackage(input);
      const affects = affectsOrDefault(input, { name: spotName, packageName });
      const intent = enhancementIntentFor({ name: spotName, type: "ENHS/XS", packageName }, affects);
      const preflightCorr = fluidPreflightCorr(named);
      deps.safety.assertIntent(intent, { op: "write", corr: preflightCorr, phase: "preflight" });
      if (activate) deps.safety.assertIntent(intent, { op: "activate", corr: preflightCorr, phase: "preflight" });
      await deps.ensureConnected();
      const { run, transcript, activation, corr } = await deps.pool.withWrite("abap_enh", gateKey, async (conn) => {
        // A GET precedes this classrun create (checkAbsentBeforeCreate) to establish
        // beforeCapture before the mutation — "confirmed-absent" on NOT_FOUND, undoable via
        // delete; "failed" on any other read error, same as before #200.
        const { result, settle } = await withJournalledMutation(
          deps.journal,
          {
            begin: (beforeCapture: BeforeImageCapture) => ({
              operation: "create" as const,
              object: {
                ...journalRef({
                  name: spotName,
                  type: "ENHS/XS",
                  uri: spotUri(spotName),
                  packageName,
                  description,
                }),
                affects,
              },
              existedBefore: false,
              beforeCapture,
              systemKey: systemKey(conn.cfg),
              tool: "abap_enh",
            }),
          },
          async (onBeforeImage) => {
            const beforeCapture = await checkAbsentBeforeCreate(() => readEnhancementSpot(conn, spotName), {
              name: spotName,
              type: "ENHS/XS",
            });
            await onBeforeImage(beforeCapture);
            return createEnhancementSpot(conn, deps.safety, {
              spotName,
              description,
              affects,
              packageName,
              corrNr: named,
              transport: deps.transport,
              activate,
            });
          },
        );
        await settle({
          outcome: "succeeded",
          activation: { attempted: activate, activated: result.activation?.activated ?? false },
        });
        return result;
      });
      return buildEnhCreateResponse(
        operation,
        spotName,
        run,
        transcript,
        activation,
        maxChars,
        fluidLeadNotes(packageName, activate, corr, spotName, "ENHS/XS", affects),
        undefined,
        { name: spotName, type: "ENHS/XS" },
      );
    }
    case "add_badi_def": {
      const spotName = name;
      const badiName = requireSpecStr(spec, "badiName", operation);
      const interfaceName = requireSpecStr(spec, "interfaceName", operation);
      const singleUse = requireSpecBool(spec, "singleUse", operation);
      const shortText = requireSpecStr(spec, "shortText", operation);
      const { packageName, named, activate } = resolveFluidPackage(input);
      const affects = affectsOrDefault(input, { name: spotName, packageName, spotName });
      const intent = enhancementIntentFor({ name: badiName, type: "ENHS/XS", packageName }, affects);
      const preflightCorr = fluidPreflightCorr(named);
      deps.safety.assertIntent(intent, { op: "write", corr: preflightCorr, phase: "preflight" });
      if (activate) deps.safety.assertIntent(intent, { op: "activate", corr: preflightCorr, phase: "preflight" });
      await deps.ensureConnected();
      const { run, transcript, activation, corr } = await deps.pool.withWrite("abap_enh", gateKey, async (conn) => {
        // Mutates the SPOT's own document (badiName is a definition entry WITHIN it,
        // not a separate ADT object — see addBadiDefinition's comment in enhancement-bridge.ts):
        // operation:"update", existedBefore:true. beforeCapture:"failed" (not "captured") since the
        // bridge classrun's own GET happens server-side and never returns source to this layer.
        const { result, settle } = await withJournalledMutation(
          deps.journal,
          {
            begin: () => ({
              operation: "update" as const,
              object: { ...journalRef({ name: spotName, type: "ENHS/XS", uri: spotUri(spotName), packageName }), affects },
              existedBefore: true,
              beforeCapture: "failed" as const,
              irreversible: true,
              undoBlocker:
                "abap_enh has no undo for add_badi_def: the spot's previous definition list is not " +
                "recorded. Remove the BAdI definition in SE18.",
              systemKey: systemKey(conn.cfg),
              tool: "abap_enh",
            }),
          },
          async (onBeforeImage) => {
            await onBeforeImage(undefined);
            return addBadiDefinition(conn, deps.safety, {
              spotName,
              badiName,
              interfaceName,
              singleUse,
              shortText,
              affects,
              packageName,
              corrNr: named,
              transport: deps.transport,
              activate,
            });
          },
        );
        await settle({
          outcome: "succeeded",
          activation: { attempted: activate, activated: result.activation?.activated ?? false },
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
        fluidLeadNotes(packageName, activate, corr, spotName, "ENHS/XS", affects),
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
      const { packageName, named, activate } = resolveFluidPackage(input);
      const affects = affectsOrDefault(input, { name: spotName, packageName, spotName });
      const intent = enhancementIntentFor({ name: badiName, type: "ENHS/XS", packageName }, affects);
      const preflightCorr = fluidPreflightCorr(named);
      deps.safety.assertIntent(intent, { op: "write", corr: preflightCorr, phase: "preflight" });
      if (activate) deps.safety.assertIntent(intent, { op: "activate", corr: preflightCorr, phase: "preflight" });
      await deps.ensureConnected();
      const { run, transcript, activation, corr } = await deps.pool.withWrite("abap_enh", gateKey, async (conn) => {
        // Same shape as add_badi_def above: mutates the SPOT's own document
        // (filterName is a definition-level entry within it), existedBefore:true, beforeCapture:"failed".
        const { result, settle } = await withJournalledMutation(
          deps.journal,
          {
            begin: () => ({
              operation: "update" as const,
              object: { ...journalRef({ name: spotName, type: "ENHS/XS", uri: spotUri(spotName), packageName }), affects },
              existedBefore: true,
              beforeCapture: "failed" as const,
              irreversible: true,
              undoBlocker:
                "abap_enh has no undo for add_filter_def: the spot's previous filter definition list " +
                "is not recorded. Remove the filter definition in SE18/SE19.",
              systemKey: systemKey(conn.cfg),
              tool: "abap_enh",
            }),
          },
          async (onBeforeImage) => {
            await onBeforeImage(undefined);
            return addFilterDefinition(conn, deps.safety, {
              spotName,
              badiName,
              filterName,
              filterType,
              filterText,
              affects,
              packageName,
              corrNr: named,
              transport: deps.transport,
              activate,
            });
          },
        );
        await settle({
          outcome: "succeeded",
          activation: { attempted: activate, activated: result.activation?.activated ?? false },
        });
        return result;
      });
      // Activated object is the SPOT (spotName), not filterName — single-object here, unlike
      // set_filter_values's joint spot+implementation form. See addFilterDefinition's comment.
      return buildEnhCreateResponse(
        operation,
        filterName,
        run,
        transcript,
        activation,
        maxChars,
        fluidLeadNotes(packageName, activate, corr, spotName, "ENHS/XS", affects),
        undefined,
        { name: spotName, type: "ENHS/XS" },
      );
    }
    case "create_impl": {
      const enhName = name;
      const spotName = requireSpecStr(spec, "spotName", operation);
      const badiName = requireSpecStr(spec, "badiName", operation);
      const implName = requireSpecStr(spec, "implName", operation);
      const implClass = requireSpecStr(spec, "implClass", operation);
      const active = requireSpecBool(spec, "active", operation);
      const description = requireSpecStr(spec, "description", operation);
      const affects = requireAffects(input, operation);
      const { packageName, named, activate } = resolveFluidPackage(input);
      const intent = enhancementIntentFor({ name: enhName, type: "ENHO/XH", packageName }, { ...affects, spotName });
      const preflightCorr = fluidPreflightCorr(named);
      deps.safety.assertIntent(intent, { op: "write", corr: preflightCorr, phase: "preflight" });
      if (activate) deps.safety.assertIntent(intent, { op: "activate", corr: preflightCorr, phase: "preflight" });
      await deps.ensureConnected();
      const {
        run,
        transcript,
        activation,
        implClass: implClassCheck,
        corr,
      } = await deps.pool.withWrite("abap_enh", gateKey, async (conn) => {
        // A genuinely new ENHO/XH object (operation:"create", existedBefore:false) — same
        // pre-create existence read as create_spot above (checkAbsentBeforeCreate):
        // "confirmed-absent" on NOT_FOUND makes this undoable (undo deletes the implementation
        // it created); any other read outcome leaves it "failed", same as before #200.
        const { result, settle } = await withJournalledMutation(
          deps.journal,
          {
            begin: (beforeCapture: BeforeImageCapture) => ({
              operation: "create" as const,
              object: {
                ...journalRef({ name: enhName, type: "ENHO/XH", uri: implUri(enhName), packageName, description }),
                affects,
              },
              existedBefore: false,
              beforeCapture,
              systemKey: systemKey(conn.cfg),
              tool: "abap_enh",
            }),
          },
          async (onBeforeImage) => {
            const beforeCapture = await checkAbsentBeforeCreate(() => readBadiImplementation(conn, enhName), {
              name: enhName,
              type: "ENHO/XH",
            });
            await onBeforeImage(beforeCapture);
            return createBadiImplementation(conn, deps.safety, {
              enhName,
              spotName,
              badiName,
              implName,
              implClass,
              active,
              description,
              affects,
              packageName,
              corrNr: named,
              transport: deps.transport,
              activate,
            });
          },
        );
        await settle({
          outcome: "succeeded",
          activation: { attempted: activate, activated: result.activation?.activated ?? false },
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
      return buildEnhCreateResponse(
        operation,
        enhName,
        run,
        transcript,
        activation,
        maxChars,
        fluidLeadNotes(packageName, activate, corr, enhName, "ENHO/XH", affects),
        createImplNotes,
      );
    }
    case "set_filter_values": {
      const enhName = name;
      const spotName = requireSpecStr(spec, "spotName", operation);
      const implName = requireSpecStr(spec, "implName", operation);
      const filterName = requireSpecStr(spec, "filterName", operation);
      const filterType = requireSpecStr(spec, "filterType", operation);
      const compare = requireSpecStr(spec, "compare", operation);
      const value = requireSpecStr(spec, "value", operation);
      const affects = requireAffects(input, operation);
      const { packageName, named, activate } = resolveFluidPackage(input);
      const intent = enhancementIntentFor({ name: enhName, type: "ENHO/XH", packageName }, { ...affects, spotName });
      const preflightCorr = fluidPreflightCorr(named);
      deps.safety.assertIntent(intent, { op: "write", corr: preflightCorr, phase: "preflight" });
      if (activate) deps.safety.assertIntent(intent, { op: "activate", corr: preflightCorr, phase: "preflight" });
      await deps.ensureConnected();
      const { run, transcript, jointActivation, corr } = await deps.pool.withWrite("abap_enh", gateKey, async (conn) => {
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
              object: { ...journalRef({ name: enhName, type: "ENHO/XH", uri: implUri(enhName), packageName }), affects },
              existedBefore: true,
              beforeCapture: "failed" as const,
              irreversible: true,
              undoBlocker:
                "abap_enh has no undo for set_filter_values: the implementation's previous filter values " +
                "are not recorded. Set them back with abap_enh set_filter_values, or in SE19.",
              systemKey: systemKey(conn.cfg),
              tool: "abap_enh",
            }),
          },
          async (onBeforeImage) => {
            await onBeforeImage(undefined);
            const joint = await withJournalledMutation(
              deps.journal,
              {
                // No `irreversible` here: an `operation: "activate"` entry's undo delegates to
                // the preceding write for the same object (writeTimeUndoability, src/undoability.ts),
                // which for the spot is history-only anyway — this flag would be inert either way.
                begin: () => ({
                  operation: "activate" as const,
                  object: {
                    ...journalRef({ name: spotName, type: "ENHS/XS", uri: spotUri(spotName), packageName }),
                    affects,
                  },
                  existedBefore: true,
                  beforeCapture: "failed" as const,
                  systemKey: systemKey(conn.cfg),
                  tool: "abap_enh",
                }),
              },
              // activate:false: setFilterValues skips the joint activation, so jointSettle is a no-op.
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
                  packageName,
                  corrNr: named,
                  transport: deps.transport,
                  activate,
                  onJointActivation: () => onJoint(undefined),
                }),
            );
            jointSettle = joint.settle;
            return joint.result;
          },
        );
        await jointSettle?.({
          outcome: "succeeded",
          activation: { attempted: activate, activated: result.jointActivation?.activated ?? false },
        });
        await settle({
          outcome: "succeeded",
          activation: { attempted: activate, activated: result.jointActivation?.activated ?? false },
        });
        return result;
      });
      return buildEnhCreateResponse(
        operation,
        enhName,
        run,
        transcript,
        jointActivation,
        maxChars,
        fluidLeadNotes(packageName, activate, corr, enhName, "ENHO/XH", affects),
      );
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
      const affects = requireAffects(input, operation);
      const intent = enhancementIntentFor({ name: badiName, type: "ENHO/XH", packageName: ENH_CREATE_PACKAGE }, affects);
      // No read-only classrun exemption — "execute" is judged exactly like write/activate.
      deps.safety.assertIntent(intent, { op: "execute", phase: "preflight" });
      await deps.ensureConnected();
      const { run, transcript } = await deps.pool.withWrite("abap_enh", gateKey, (conn) =>
        exerciseBadi(conn, deps.safety, { badiName, methodName, filterName, filterValue, params, affects }),
      );
      return buildEnhCreateResponse(operation, badiName, run, transcript, undefined, maxChars, [
        `Bridge class landed in ${ENH_BRIDGE_PACKAGE} — exercise creates nothing of the caller's own, only a ` +
          "throwaway invoker there.",
      ]);
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

  const assertHookIntent = (a: EnhancedObjectRef) => {
    const intent = enhancementIntentFor({ name, type: "ENHO/XHH", packageName: ENH_CREATE_PACKAGE }, a);
    deps.safety.assertIntent(intent, { op: "write", phase: "preflight" });
    if (activate) deps.safety.assertIntent(intent, { op: "activate", phase: "preflight" });
  };

  let affects: EnhancedObjectRef;
  if (input.affects) {
    affects = requireAffects(input, operation);
    assertHookIntent(affects);
    await deps.ensureConnected();
  } else {
    // Deriving affects from the host needs one GET, so the zero-network preflight
    // above cannot run first here — it runs right after, still ahead of any mutation.
    await deps.ensureConnected();
    affects = await deps.pool.withRead("abap_enh", async (conn) => {
      const resolved = await resolveWriteTarget(conn, { type: host.type, name: host.name }, "write");
      if (!resolved.exists) {
        throw new AbapError("NOT_FOUND", `create_hook: host ${host.name} (${host.type}) does not exist.`, {
          name: host.name,
          type: host.type,
        });
      }
      return { name: resolved.name.toUpperCase(), packageName: resolved.packageName, masterSystem: resolved.masterSystem };
    });
    assertHookIntent(affects);
  }

  const gateKey = enhGateKey(name);
  const hookUri = buildEnhancementUri(ENHOXHH_COLLECTION, name.trim().toLowerCase());
  const result = await deps.pool.withWrite("abap_enh", gateKey, async (conn) => {
    // A genuinely new ENHO/XHH object: operation:"create", existedBefore:false, and
    // (unlike the bridge-classrun sites above) beforeCapture:"confirmed-absent" — this call is a
    // plain conn.post (postHookImplementation) whose resp.status!==201 check + throw-on-non-2xx
    // transport gives the same "only returns normally on the create path" evidence
    // createBusinessObject's confirmed-absent relies on (bopf.ts). No recovered/not-recovered
    // fallback here — a throw propagates directly. Undoable (undo deletes the object): no
    // `irreversible` flag. hookUri is computed up front via the same deterministic formula
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
    // `createdFresh` (#200) is a no-op while beforeCapture above is already "confirmed-absent".
    await settle({
      outcome: "succeeded",
      activation: hookResult.activation ? { attempted: true, activated: hookResult.activation.activated } : { attempted: false },
      ...(hookResult.location !== undefined ? { createdFresh: { status: 201, location: hookResult.location } } : {}),
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
    // Journalled through the same helper as write_description. irreversible:true: the XML this
    // captures is the object's OWN document, not evidence for recreating it — a delete has no undo.
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
          undoBlocker: "A deleted enhancement object cannot be recreated from its XML; recreate it with abap_enh.",
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
        // Zero-network: `package` only applies to the five fluid ops.
        if (input.package !== undefined && !(ENH_FLUID_OPS as readonly string[]).includes(operation)) {
          throw new AbapError(
            "BAD_INPUT",
            `operation:"${operation}" does not take package — only ${ENH_FLUID_OPS.join(", ")} do.`,
            { operation, field: "package" },
          );
        }
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
          // irreversible:true, deliberately: `writeTimeUndoability` (src/undoability.ts) implements
          // no undo for an enhancement update — only a confirmed-absent create, a captured
          // set_impl_active flip, or a delegated activate do. The record still has value (only
          // trace of the prior description) — it just must not promise a rollback it cannot perform.
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
                undoBlocker:
                  "abap_enh has no undo for write_description. The previous XML is kept as this entry's " +
                  "before-image; set the description back with abap_enh write_description.",
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
