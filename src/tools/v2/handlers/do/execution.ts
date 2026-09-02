/**
 * `abap_do`'s execution group: `check` only. Lives in `do/` despite
 * `catalogue.ts` labelling `check`'s `group` as `"activation"` — directory
 * layout here is independent of that metadata field.
 */
import type { AbapConnection } from "../../../../adt/connection.js";
import { abapActivate, ActivateInput } from "../../../activate.js";
import { preflight } from "../../../preflight.js";
import type { DoHandler } from "./types.js";
import { doOk, parseV1, withField, withObject } from "./shared.js";

const check: DoHandler = async (ctx, deps) => {
  const args = withField(withObject(ctx.args, "object", ctx.object), "mode", "check");
  const input = parseV1(ActivateInput, args);

  // Writes nothing, runs no customer code -> classified "analyze" (usable
  // read-only), matching mode=check in src/tools/activate.ts.
  // `input.object!`: optional only for the batch form; withObject above
  // guarantees it's set here since abap_do never uses that form.
  deps.safety.assert("analyze", preflight({ object: input.object!, type: input.type }), {
    phase: "preflight",
  });
  await deps.ensureConnected();

  const run = (conn: AbapConnection) => abapActivate(conn, input, deps.cfg.maxResponseChars, deps.safety, deps.transport);
  // `checkruns` neither locks nor writes — a read slot, not withWrite.
  const res = await deps.pool.withRead("abap_activate", run);
  return doOk(res.text, [
    { tool: "abap_do", args: { action: "activate", object: input.object }, why: "Activate once the check is clean." },
  ]);
};

export const EXECUTION_HANDLERS: ReadonlyMap<string, DoHandler> = new Map<string, DoHandler>([["check", check]]);
