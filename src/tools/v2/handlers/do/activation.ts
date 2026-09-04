/**
 * `abap_do`'s activation group: `activate`, `run`, `test`, `undo`.
 * (`check` lives in `execution.ts`.)
 *
 * Each handler reshapes `ctx.object`/`ctx.args` into the v1 input shape,
 * validates with the existing v1 zod schema, then replicates its v1
 * registrar's orchestration verbatim (pool slot, gate call, connect
 * ordering) since that orchestration isn't exported from the v1 module.
 */
import type { AbapConnection } from "../../../../adt/connection.js";
import { AbapError } from "../../../../adt/errors.js";
import { enhancementUndoBlocked } from "../../../../adt/undo.js";
import { abapActivate, ActivateInput } from "../../../activate.js";
import { abapJournal, JournalInput, undoPreflightTarget } from "../../../journal.js";
import { enhancementPreflightIntent, preflight, writeGateKey } from "../../../preflight.js";
import { abapRun, RunInput } from "../../../run.js";
import { abapTest, TestInput } from "../../../test.js";
import type { DoHandler } from "./types.js";
import { doOk, journalNext, parseV1, withField, withObject } from "./shared.js";

const activate: DoHandler = async (ctx, deps) => {
  const args = withField(withObject(ctx.args, "object", ctx.object), "mode", "activate");
  const input = parseV1(ActivateInput, args);

  // registerActivateTools had this same bug: a separately maintained
  // preflight assert() here never built an `affects` intent, so
  // abap_do action=activate wrongly refused ENHO/XH and ENHS/XS. Fixed
  // identically — see the git history.
  // `input.object!`: optional only for ActivateInput's batch `objects` field;
  // withObject above guarantees it's set for abap_do.
  const pf = preflight({ object: input.object!, type: input.type });
  deps.safety.assert("activate", pf, {
    phase: "preflight",
    corr: { kind: "unresolved" },
    intent: enhancementPreflightIntent({ name: pf.name, type: pf.type, affects: input.affects }),
  });
  await deps.ensureConnected();

  // deps.journal forwarded: this is a second entry point into abapActivate,
  // so it must journal identically to abap_activate.
  const run = (conn: AbapConnection) =>
    abapActivate(conn, input, deps.cfg.maxResponseChars, deps.safety, deps.transport, deps.journal);
  const res = await deps.pool.withWrite("abap_activate", writeGateKey(input.object!, input.type), run);
  return doOk(res.text, [
    { tool: "abap_do", args: { action: "run", object: input.object }, why: "Execute the object now that it is active." },
  ]);
};

const run: DoHandler = async (ctx, deps) => {
  const args = withObject(ctx.args, "object", ctx.object);
  const input = parseV1(RunInput, args);

  deps.safety.assert("execute", preflight({ object: input.object }), { phase: "preflight" });
  await deps.ensureConnected();

  // WRITE slot, no object gate: replicates registerRunTools' orchestration —
  // see its comment for why a dead-slot replay must be gated here.
  const res = await deps.pool.withWrite("abap_run", undefined, (conn) => abapRun(conn, input, deps.cfg.maxResponseChars, deps.safety));
  return doOk(res.text, journalNext("abap_run does not journal, but a preceding activate/write does."));
};

const test: DoHandler = async (ctx, deps) => {
  const args = withObject(ctx.args, "object", ctx.object);
  const input = parseV1(TestInput, args);

  deps.safety.assert("execute", preflight({ object: input.object, type: input.type }), { phase: "preflight" });
  await deps.ensureConnected();

  // WRITE slot, no object gate: replicates registerTestTools' orchestration —
  // same reasoning as `run` above.
  const res = await deps.pool.withWrite("abap_test", undefined, (conn) => abapTest(conn, input, deps.cfg.maxResponseChars, deps.safety));
  return doOk(res.text, []);
};

const undo: DoHandler = async (ctx, deps) => {
  const args = withField(withObject(ctx.args, "object", ctx.object), "mode", "undo");
  const input = parseV1(JournalInput, args);

  // Zero-network preflight: the journal knows the object's name/package/type
  // locally, so a refused undo costs no request (mirrors registerJournalTools).
  const t = await undoPreflightTarget(deps.journal, { mode: "undo", entry: input.entry, object: input.object });
  const undoGateKey = t?.name ? t.name.trim().toUpperCase() : undefined;
  // Same fix as registerJournalTools: an enhancement-undo target reaching the
  // gate below at phase:"final" with no intent gets the wrong generic
  // "supply affects" refusal instead of undoBlocker()'s purpose-built one.
  // Checked here, zero-network, before the gate call.
  const blocked = t ? enhancementUndoBlocked(t.type ?? "", t.op, t.name) : undefined;
  if (blocked) {
    throw new AbapError(
      "UNSUPPORTED",
      blocked,
      { entry: input.entry, object: t?.name ?? input.object },
      "There is no override for this refusal. Reverse the change deliberately through the ABAP " +
        "enhancement UI instead.",
    );
  }
  deps.safety.assert(
    t?.op ?? "write",
    t ? { name: t.name, packageName: t.packageName, type: t.type } : { name: input.object ?? "" },
    { phase: t ? "final" : "preflight" },
  );

  await deps.ensureConnected();
  const runFn = (conn: AbapConnection) => abapJournal(conn, input, deps.cfg.maxResponseChars, deps.journal, deps.safety);
  const res = await deps.pool.withWrite("abap_journal", undoGateKey, runFn);
  return doOk(res.text, journalNext("Confirm the undo landed."));
};

export const ACTIVATION_HANDLERS: ReadonlyMap<string, DoHandler> = new Map<string, DoHandler>([
  ["activate", activate],
  ["run", run],
  ["test", test],
  ["undo", undo],
]);
