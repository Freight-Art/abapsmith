/**
 * `abap_do`'s transports group: 9 `transport_*` actions wrapping v1's
 * `abap_transport` (8 ops) and `abap_transport_release` (kept separate in
 * v1 — see transport.ts — but grouped here as one "transport action" family).
 *
 * `ctx.object` maps to a different v1 field per action — see each
 * `transportOp` call below (`transport_users` takes no object at all and
 * rejects with `BAD_INPUT` if given).
 *
 * `ctx.confirm` folds into `args.confirm`; only delete/release read it.
 * `dry_run` is never folded in: delete has no dry-run concept, and
 * release's dry run is simply "confirm absent" — no separate flag exists
 * to receive it. Release's separate `confirm_unowned` override passes
 * through `args` untouched — `ctx.confirm` never folds into it.
 *
 * Per-op safety gating (ceiling checks, package-allowlist) lives inside
 * `abapTransport`/`abapTransportRelease` themselves — this module
 * intentionally never calls `deps.safety.assert` directly.
 */
import { z } from "zod";
import type { AbapConnection } from "../../../../adt/connection.js";
import { AbapError } from "../../../../adt/errors.js";
import {
  abapTransport,
  abapTransportRelease,
  transportInputSchema,
  transportReleaseInputSchema,
  type TransportInput,
  type TransportJournalDeps,
  type TransportReleaseInput,
} from "../../../transport.js";
import type { NextCall } from "../../envelope.js";
import type { DoHandler } from "./types.js";
import { doOk, parseV1, withField, withObject, withValue } from "./shared.js";

const TransportInputZ = z.object(transportInputSchema);
const TransportReleaseInputZ = z.object(transportReleaseInputSchema);

function journalDepsOf(deps: { journal: TransportJournalDeps["journal"]; warn: (msg: string) => void }, conn: AbapConnection): TransportJournalDeps {
  return { journal: deps.journal, cfg: conn.cfg, warn: deps.warn };
}

/** Runs one `abap_transport` operation end to end — shared by every action but `transport_release`. */
function transportOp(
  operation: TransportInput["operation"],
  mapObject: (args: Record<string, unknown>, object: string | undefined) => Record<string, unknown>,
  next: (input: TransportInput) => NextCall[],
): DoHandler {
  return async (ctx, deps) => {
    const withConfirm = withValue(ctx.args, "confirm", ctx.confirm);
    const withOp = withField(mapObject(withConfirm, ctx.object), "operation", operation);
    const input = parseV1(TransportInputZ, withOp);

    await deps.ensureConnected();
    const res = await deps.pool.withWrite("abap_transport", undefined, (conn) =>
      abapTransport(conn, input, deps.cfg.maxResponseChars, deps.safety, journalDepsOf(deps, conn), deps.transport),
    );
    return doOk(res.text, next(input));
  };
}

const list = transportOp(
  "list",
  (args, object) => withObject(args, "user", object),
  () => [{ tool: "abap_do", args: { action: "transport_show" }, why: "Show one request's tasks and objects." }],
);
const show = transportOp(
  "show",
  (args, object) => withObject(args, "transport", object),
  () => [{ tool: "abap_do", args: { action: "transport_check" }, why: "Check whether an object needs this transport before adding to it." }],
);
const check = transportOp(
  "check",
  (args, object) => withObject(args, "object", object),
  () => [{ tool: "abap_do", args: { action: "transport_create" }, why: "Create a request if none of the candidates fit." }],
);
const users = transportOp(
  "users",
  (args, object) => {
    if (object !== undefined) {
      throw new AbapError("BAD_INPUT", "transport_users takes no object — it lists every user CTS knows, unfiltered.", { object });
    }
    return args;
  },
  () => [{ tool: "abap_do", args: { action: "transport_add_user" }, why: "Add one of these users to a request." }],
);
const create = transportOp(
  "create",
  (args, object) => withObject(args, "object", object),
  () => [{ tool: "abap_do", args: { action: "activate" }, why: "The request number is ready to pass on subsequent writes." }],
);
const addUser = transportOp(
  "addUser",
  (args, object) => withObject(args, "transport", object),
  (input) => [{ tool: "abap_do", args: { action: "transport_show", object: input.transport }, why: "Confirm the user landed on the request." }],
);
const setOwner = transportOp(
  "setOwner",
  (args, object) => withObject(args, "transport", object),
  (input) => [{ tool: "abap_do", args: { action: "transport_show", object: input.transport }, why: "Confirm the new owner landed." }],
);
const del = transportOp(
  "delete",
  (args, object) => withObject(args, "transport", object),
  () => [{ tool: "abap_do", args: { action: "transport_list" }, why: "Confirm the request is gone." }],
);

const release: DoHandler = async (ctx, deps) => {
  const withConfirm = withValue(ctx.args, "confirm", ctx.confirm);
  const args = withObject(withConfirm, "transport", ctx.object);
  const input = parseV1(TransportReleaseInputZ, args) as TransportReleaseInput;

  await deps.ensureConnected();
  const res = await deps.pool.withWrite("abap_transport_release", undefined, (conn) =>
    abapTransportRelease(conn, input, deps.cfg.maxResponseChars, deps.safety, journalDepsOf(deps, conn), deps.transport),
  );
  return doOk(res.text, [
    { tool: "abap_do", args: { action: "transport_show", object: input.transport }, why: "Confirm the release landed." },
  ]);
};

export const TRANSPORT_HANDLERS: ReadonlyMap<string, DoHandler> = new Map<string, DoHandler>([
  ["transport_list", list],
  ["transport_show", show],
  ["transport_check", check],
  ["transport_users", users],
  ["transport_create", create],
  ["transport_add_user", addUser],
  ["transport_set_owner", setOwner],
  ["transport_delete", del],
  ["transport_release", release],
]);
