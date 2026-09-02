/**
 * `abap_do`'s enhancements group: 9 `enh_*` actions over v1's `abap_enh`
 * (src/tools/enh.ts). `object` maps to v1 `name` for every action here.
 *
 * Action -> v1 `operation` is the `enh_` prefix stripped, for 8 of 9 actions
 * (`enh_create_spot` -> `"create_spot"`, ...); `enh_write_description` maps
 * to v1's DEFAULT (`operation` omitted).
 *
 * `runEnhCreateOperation` and `runEnhHookOperation` are exported from
 * enh.ts and called directly. `write_description` is not exported there —
 * its registrar choreography (incl. the private helpers `enhGateKey`,
 * `requireAffects`, `buildEnhResponse`) is reproduced verbatim below under
 * a `Local` suffix, so this module doesn't depend on enh.ts exporting
 * internals it doesn't.
 *
 * Every handler here catches and re-throws through
 * `classifyEnhancementRefusal`, unlike other groups which let exceptions
 * propagate to `handlers/do.ts`'s own catch. This is required, not
 * inconsistency: `registerEnhancementTools` (src/tools/enh.ts) applies this
 * same classifier in its own catch, and the six refusal families
 * (corrNr-missing, task-not-request, ...) only get a specific
 * `AbapErrorCode` because of it — skipping it here would regress them to a
 * generic `ADT_ERROR` when reached via `abap_do`.
 */
import { normalizeCorrNr } from "../../../../safety.js";
import {
  EnhInput,
  ENH_CREATE_OPERATIONS,
  ENH_HOOK_OPERATIONS,
  runEnhCreateOperation,
  runEnhHookOperation,
  type EnhCreateOperation,
  type EnhHookOperation,
} from "../../../enh.js";
import {
  writeEnhancementDescription,
  isEnhancementWriteType,
  ENHANCEMENT_WRITE_TYPES,
  type EnhancementWriteResult,
  type EnhancementBeforeImage,
} from "../../../../adt/enhancement-write.js";
import { activateObject, type ActivationOutcome } from "../../../../adt/activate.js";
import { enhancementIntentFor, type EnhancedObjectRef } from "../../../../adt/write.js";
import { classifyEnhancementRefusal } from "../../../../adt/enhancement-refusals.js";
import { buildResponse } from "../../../../compact.js";
import { journalRef, systemKey, withJournalledMutation } from "../../../../journal.js";
import { AbapError } from "../../../../adt/errors.js";
import type { DoHandler } from "./types.js";
import { doOk, journalNext, parseV1, withField, withObject } from "./shared.js";

// ---------------------------------------------------------------------------
// Private helpers duplicated from enh.ts (not exported there).
// ---------------------------------------------------------------------------

function enhGateKeyLocal(name: string): string | undefined {
  const trimmed = name.trim().toUpperCase();
  return trimmed === "" ? undefined : trimmed;
}

function requireAffectsLocal(input: EnhInput, operation: string): EnhancedObjectRef {
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

function buildEnhResponseLocal(write: EnhancementWriteResult, activation: ActivationOutcome | undefined, maxChars: number): string {
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

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const writeDescription: DoHandler = async (ctx, deps) => {
  const args = withField(withObject(ctx.args, "name", ctx.object), "operation", "write_description");
  const input = parseV1(EnhInput, args);
  try {
    const type = input.type;
    if (!isEnhancementWriteType(type)) {
      throw new AbapError(
        "UNSUPPORTED",
        `${type} is not a type abap_enh writes. Supported: ${ENHANCEMENT_WRITE_TYPES.join(", ")}.`,
        { type },
      );
    }
    const description = input.description;
    if (description === undefined) {
      throw new AbapError(
        "BAD_INPUT",
        'operation:"write_description" requires description (the new adtcore:description value).',
        {},
      );
    }
    const affects = requireAffectsLocal(input, "write_description");
    const wantsActivate = input.activate === true;

    // Zero-network preflight; see enh.ts's header for why this doesn't
    // duplicate writeEnhancementDescription's own unconditional final check.
    const preflightIntent = enhancementIntentFor({ name: input.name, type, packageName: "" }, affects);
    deps.safety.assertIntent(preflightIntent, { op: "write", phase: "preflight" });
    if (wantsActivate) {
      deps.safety.assertIntent(preflightIntent, { op: "activate", phase: "preflight" });
    }

    await deps.ensureConnected();

    const gateKey = enhGateKeyLocal(input.name);
    const { write, activation } = await deps.pool.withWrite("abap_enh", gateKey, async (conn) => {
      // Journalled the same way as v1 `abap_enh operation=write_description`
      // (irreversible:true, settle-before-activate; see enh.ts for rationale).
      // journalNext() below promises this change is in the journal — it must
      // actually be there.
      const { result: write, settle } = await withJournalledMutation(
        deps.journal,
        {
          begin: (img: EnhancementBeforeImage) => ({
            operation: "update" as const,
            object: { ...journalRef(img.target), affects: img.affects },
            existedBefore: true,
            beforeCapture: "captured" as const,
            beforeSource: img.xml,
            ...(img.corrNr !== undefined ? { corrNr: img.corrNr } : {}),
            irreversible: true,
            // Needed so systemMismatchBlocker (adt/undo.ts) can do a strong
            // SID+origin+client compare instead of falling back to SID-only,
            // which conflates two boxes sharing a SID.
            systemKey: systemKey(conn.cfg),
            tool: "abap_do enh_write_description",
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
              // Blank-normalised, matching the v1 abap_enh path.
              corrNr: normalizeCorrNr(input.corr_nr),
              affects,
              expectEtag: input.expect_etag,
              onBeforeImage,
            },
          ),
      );

      await settle({
        outcome: "succeeded",
        ...(write.xml ? { afterSource: write.xml } : {}),
        ...(write.transport.corrNr ? { corrNr: write.transport.corrNr } : {}),
        activation: { attempted: false },
      });

      let activation: ActivationOutcome | undefined;
      if (wantsActivate && write.changed) {
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

    return doOk(buildEnhResponseLocal(write, activation, deps.cfg.maxResponseChars), journalNext());
  } catch (e) {
    throw classifyEnhancementRefusal(e);
  }
};

/** One enhancement-create action -> `runEnhCreateOperation` with the v1 `operation` this action name implies. */
function createOp(operation: EnhCreateOperation): DoHandler {
  return async (ctx, deps) => {
    const args = withField(withObject(ctx.args, "name", ctx.object), "operation", operation);
    const input = parseV1(EnhInput, args);
    try {
      const text = await runEnhCreateOperation(deps, operation, input);
      return doOk(text, []);
    } catch (e) {
      throw classifyEnhancementRefusal(e);
    }
  };
}

/** One hook action -> `runEnhHookOperation` with the v1 `operation` this action name implies. */
function hookOp(operation: EnhHookOperation): DoHandler {
  return async (ctx, deps) => {
    const args = withField(withObject(ctx.args, "name", ctx.object), "operation", operation);
    const input = parseV1(EnhInput, args);
    try {
      const text = await runEnhHookOperation(deps, operation, input);
      const next =
        operation === "discover_hook_anchors"
          ? [{ tool: "abap_do", args: { action: "enh_create_hook" }, why: "Create a hook bound to one of these anchors." }]
          : [];
      return doOk(text, next);
    } catch (e) {
      throw classifyEnhancementRefusal(e);
    }
  };
}

export const ENHANCEMENT_HANDLERS: ReadonlyMap<string, DoHandler> = new Map<string, DoHandler>([
  ["enh_write_description", writeDescription],
  ...ENH_CREATE_OPERATIONS.map((op): [string, DoHandler] => [`enh_${op}`, createOp(op)]),
  ...ENH_HOOK_OPERATIONS.map((op): [string, DoHandler] => [`enh_${op}`, hookOp(op)]),
]);
