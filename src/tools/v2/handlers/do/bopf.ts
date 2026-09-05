/**
 * `abap_do`'s bopf group: 30 `bopf_*` actions delegating to v1's
 * `runBopfRead`/`runBopfEdit`/`runBopfDelete` (src/tools/bopf.ts) and
 * `runBopfTest` (src/tools/bopf-test.ts). Those v1 functions are self-contained
 * (own preflight/connect/pool slot/write-gating) and throw `AbapError` directly,
 * so handlers here need no local `try`/`catch` — an uncaught throw propagates to
 * `handlers/do.ts`'s own `catch`.
 *
 * `object` always maps to v1's `bo`. Action -> operation: `bopf_check_refs` uses
 * `mode: "check_refs"`; `bopf_create` is the one renamed operation (-> `"create_bo"`);
 * `bopf_test`/`bopf_delete` call their own v1 functions directly; every other
 * `bopf_*` strips its `bopf_` prefix to get the `runBopfEdit` `operation` value.
 *
 * Full rationale: the git history
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  bopfDeleteInputSchema,
  bopfEditInputSchema,
  bopfInputSchema,
  runBopfDelete,
  runBopfEdit,
  runBopfRead,
  type BopfCallResult,
} from "../../../bopf.js";
import { bopfTestInputSchema, createBopfTestDeps, runBopfTest, type BopfTestDeps } from "../../../bopf-test.js";
import { z } from "zod";
import type { DoHandler } from "./types.js";
import { doOk, journalNext, parseV1, textOf, withField, withObject, withValue } from "./shared.js";

const BopfInputZ = z.object(bopfInputSchema);
const BopfEditInputZ = z.object(bopfEditInputSchema);
const BopfDeleteInputZ = z.object(bopfDeleteInputSchema);
const BopfTestInputZ = z.object(bopfTestInputSchema);

const checkRefs: DoHandler = async (ctx, deps) => {
  const args = withField(withObject(ctx.args, "bo", ctx.object), "mode", "check_refs");
  const input = parseV1(BopfInputZ, args);

  const res: CallToolResult = await runBopfRead(deps, input);
  return doOk(textOf(res), [
    { tool: "abap_do", args: { action: "bopf_add_node", object: input.bo }, why: "Fix a dangling reference by editing the model." },
  ]);
};

/**
 * True when `res` carries a `journalEntryId`. `journalNext()` must only be offered
 * then — `bopf_activate` and dry-run deletes never write a journal entry.
 *
 * Reads `BopfCallResult.journalEntryId`, an INTERNAL field, NOT
 * `structuredContent`: no tool in this server
 * declares an `outputSchema`, so an MCP client that prefers
 * `structuredContent` over `content` (Claude Code among them) would show the
 * caller
 * `{"journalEntryId": "..."}` and none of the result text on every
 * journalling edit/delete. `runBopfEdit`/`runBopfDelete` (`src/tools/bopf.ts`)
 * are called directly here, upstream of the `toMcpResult` strip their
 * `mcp.registerTool` callbacks apply, so the field is still present on `res`.
 */
function journalled(res: BopfCallResult): boolean {
  return typeof res.journalEntryId === "string";
}

/** One `bopf_*` edit action -> `runBopfEdit` with the v1 `operation` this action name implies. */
function editOp(operation: string): DoHandler {
  return async (ctx, deps) => {
    const withOp = withField(withObject(ctx.args, "bo", ctx.object), "operation", operation);
    const input = parseV1(BopfEditInputZ, withOp);

    const res = await runBopfEdit(deps, input);
    return doOk(textOf(res), journalled(res) ? journalNext() : []);
  };
}

const test: DoHandler = async (ctx, deps) => {
  const args = withObject(ctx.args, "bo", ctx.object);
  const input = parseV1(BopfTestInputZ, args);

  const testDeps: BopfTestDeps = { ...deps, ...createBopfTestDeps() };
  const res = await runBopfTest(testDeps, input);
  return doOk(textOf(res), []);
};

const del: DoHandler = async (ctx, deps) => {
  const withConfirm = withValue(withValue(ctx.args, "confirm", ctx.confirm), "dry_run", ctx.dry_run);
  const args = withObject(withConfirm, "bo", ctx.object);
  const input = parseV1(BopfDeleteInputZ, args);

  const res = await runBopfDelete(deps, input);
  return doOk(textOf(res), journalled(res) ? journalNext() : []);
};

export const BOPF_HANDLERS: ReadonlyMap<string, DoHandler> = new Map<string, DoHandler>([
  ["bopf_check_refs", checkRefs],
  ["bopf_create", editOp("create_bo")],
  ["bopf_add_node", editOp("add_node")],
  ["bopf_remove_node", editOp("remove_node")],
  ["bopf_add_association", editOp("add_association")],
  ["bopf_remove_association", editOp("remove_association")],
  ["bopf_set_association_fields", editOp("set_association_fields")],
  ["bopf_add_action", editOp("add_action")],
  ["bopf_remove_action", editOp("remove_action")],
  ["bopf_set_action_fields", editOp("set_action_fields")],
  ["bopf_add_determination", editOp("add_determination")],
  ["bopf_remove_determination", editOp("remove_determination")],
  ["bopf_set_determination_fields", editOp("set_determination_fields")],
  ["bopf_add_validation", editOp("add_validation")],
  ["bopf_remove_validation", editOp("remove_validation")],
  ["bopf_set_validation_fields", editOp("set_validation_fields")],
  ["bopf_add_query", editOp("add_query")],
  ["bopf_remove_query", editOp("remove_query")],
  ["bopf_set_query_fields", editOp("set_query_fields")],
  ["bopf_add_alternative_key", editOp("add_alternative_key")],
  ["bopf_remove_alternative_key", editOp("remove_alternative_key")],
  ["bopf_set_alternative_key_fields", editOp("set_alternative_key_fields")],
  ["bopf_set_node_flags", editOp("set_node_flags")],
  ["bopf_add_representative_node", editOp("add_representative_node")],
  ["bopf_remove_representative_node", editOp("remove_representative_node")],
  ["bopf_embed_dependent_object", editOp("embed_dependent_object")],
  ["bopf_remove_dependent_object", editOp("remove_dependent_object")],
  ["bopf_activate", editOp("activate")],
  ["bopf_test", test],
  ["bopf_delete", del],
]);
