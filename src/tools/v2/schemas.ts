/**
 * Rule 1: no closed enums. Every action/mode/view/scope/step/method-verb
 * parameter is `z.string()`; legal values live in `.describe()` prose and in
 * catalogue.ts. A source scan of this directory enforces that the closed-enum
 * combinator never appears here — so this sentence must not spell it out
 * literally (the scan needle is a plain substring, see
 * test/tools-v2-budget.test.ts "Rule 1").
 *
 * Each export is a plain object of zod fields (registerTool's inputSchema
 * wants the raw shape, not z.object({...})), matching v1 tool modules.
 */
import { z } from "zod";
import type { AbapMode } from "../../mode.js";
import { actionsForMode, groupsForMode } from "./catalogue.js";

export const ABAP_FIND_DESCRIPTION =
  "Locate anything in the SAP system: objects, usages, business objects, FPM configs, transports. " +
  "Returns URIs + kinds. Bare call lists the searchable kinds.";
export const abapFindInputSchema = {
  query: z.string().optional().describe("Name, pattern (ZCL_*), or free text."),
  kind: z.string().optional().describe("Narrow by kind: class, program, table, bo, fpm, badi, transport."),
  where: z.string().optional().describe("Scope: repository (default), usages, package."),
  type: z.string().optional().describe("ADT type code, e.g. CLAS/OC."),
  max: z.number().int().min(1).max(200).optional(),
};

export const ABAP_READ_DESCRIPTION =
  "Read anything: source, contract, one method, a diff, or metadata. Omit view to get source plus a " +
  "footer listing the other views.";
export const abapReadInputSchema = {
  object: z.string().optional().describe("Object name or ADT URI."),
  view: z.string().optional().describe("source (default) | contract | method | diff | metadata | outline | bopf | fpm."),
  method: z.string().optional().describe("Method name when view=method."),
  offset: z.number().int().min(1).optional().describe("1-based first line."),
  limit: z.number().int().min(1).optional(),
  version: z.string().optional().describe("active (default) | inactive."),
};

export const ABAP_WRITE_DESCRIPTION =
  "Change source. Prefer the edit splice — it is the cheapest and safest form. Forms: " +
  "{object,edit:{old_string,new_string}} unique-match splice; {object,method,source} whole-method " +
  "replace; {object,source} full rewrite; {object,mode:'delete'}. dry_run previews without writing.";
export const abapWriteInputSchema = {
  object: z.string().optional().describe("Object name or ADT URI."),
  edit: z
    .object({
      old_string: z.string().describe("Exact text to replace; must occur exactly once."),
      new_string: z.string().describe("Replacement text."),
      replace_all: z.boolean().optional().describe("Replace every occurrence instead of requiring one."),
    })
    .optional()
    .describe("Unique-match splice."),
  method: z.string().optional().describe("Replace this method's implementation with source."),
  // z.string(), not z.enum, per Rule 1; handler narrows via
  // assertClassInclude. Full rationale: the git history
  include: z
    .string()
    .optional()
    .describe("CLAS/OC only: main | definitions | implementations | macros | testclasses. testclasses = ABAP Unit tests. Default main."),
  source: z.string().optional().describe("New source for the method or the whole object."),
  mode: z.string().optional().describe("write (default) | delete."),
  type: z.string().optional().describe("ADT type code; required when creating."),
  package: z.string().optional(),
  description: z.string().optional(),
  expect_etag: z.string().optional().describe("Optimistic-concurrency guard from abap_read."),
  corr_nr: z.string().optional().describe("Transport request."),
  activate: z.boolean().optional(),
  format: z.boolean().optional(),
  dry_run: z
    .boolean()
    .optional()
    .describe("Preview: return the diff and the expect_etag a real write would assert, without writing."),
  // Mirrors v1's `ddic` (src/tools/write.ts) field-for-field.
  ddic: z
    .object({
      dataType: z.string().optional(),
      length: z.number().optional(),
      decimals: z.number().optional(),
      outputLength: z.number().optional(),
      lowercase: z.boolean().optional(),
      signExists: z.boolean().optional(),
      // z.string(), not z.enum, per Rule 1; handler narrows via assertDdicTypeKind.
      typeKind: z.string().optional().describe("domain | predefinedAbapType | dictionaryType."),
      typeName: z.string().optional(),
      shortLabel: z.string().optional(),
      shortLength: z.number().optional(),
      mediumLabel: z.string().optional(),
      mediumLength: z.number().optional(),
      longLabel: z.string().optional(),
      longLength: z.number().optional(),
      headingLabel: z.string().optional(),
      headingLength: z.number().optional(),
    })
    .strict()
    .optional()
    .describe(
      "Structured create for DOMA/DD, DTEL/DE, TTYP/DA only — alternative to `source`, never both. " +
        "Unverified: this path has never itself been sent to a live system.",
    ),
};

// abap_do's description is built per mode by buildAbapDoDescription(mode) below.
export const abapDoInputSchema = {
  action: z.string().optional().describe("Action name. Unknown values return UNKNOWN_ACTION with nearest matches."),
  object: z.string().optional().describe("Primary target of the action."),
  args: z.record(z.string(), z.unknown()).optional().describe("Action-specific arguments; the catalogue names the keys per action."),
  confirm: z.string().optional().describe("Literal confirmation token required by destructive actions."),
  dry_run: z.boolean().optional(),
};

export const ABAP_DEBUG_DESCRIPTION =
  "Live ABAP debug session: breakpoints, run, step, stack, variables. Stateful — every call after " +
  "start takes the returned stateId. Bare call lists the actions.";
export const abapDebugInputSchema = {
  action: z.string().optional().describe("start | step | stack | frame | vars | value | keepalive | stop | status."),
  stateId: z.string().optional().describe("From the start response; required by every later call."),
  run: z.string().optional().describe("Object to execute under the debugger (action=start)."),
  breakpoints: z.array(z.string()).optional().describe("OBJECT:LINE or exception:CLASS; suffix ?CONDITION or #SKIPCOUNT."),
  step: z.string().optional().describe("into | over | return | continue | runToLine | jumpToLine."),
  toLine: z.number().int().min(1).optional(),
  frame: z.number().int().min(1).optional().describe("1-based stack position to move the read cursor to (action=frame)."),
  path: z.string().optional().describe("Variable path (action=value)."),
  scope: z.string().optional().describe("all | locals | parameters | globals (action=vars)."),
  filter: z.string().optional(),
  from: z.number().int().min(1).optional(),
  count: z.number().int().min(1).optional(),
  depth: z.number().int().min(1).optional(),
};

/**
 * Fixed prose, not built per mode. GET-only in every mode including admin is
 * deliberate, not an omission: SafetyGate/JournalOperation have no raw-path
 * variant, so handlers/adt.ts refuses every non-GET verb regardless of mode.
 * This description previously (wrongly) promised admin-mode mutations; see
 * the git history for the correction history.
 */
export const ABAP_ADT_DESCRIPTION =
  "Raw ADT REST escape hatch for endpoints no other v2 tool covers. Prefer abap_find/abap_read/" +
  "abap_write/abap_do first — this is the fallback. GET-only in every mode, including admin.";
export const abapAdtInputSchema = {
  method: z.string().optional().describe("GET (default) | POST | PUT | DELETE."),
  path: z.string().optional().describe("Path under /sap/bc/adt/."),
  body: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
};

/**
 * groupsForMode/actionsForMode grow monotonically as mode goes
 * read -> edit -> admin, so this description grows with them instead of a
 * hand-maintained parallel table.
 */
export function buildAbapDoDescription(mode: AbapMode): string {
  const groups = groupsForMode(mode).join(", ");
  const n = actionsForMode(mode).length;
  return (
    "Single entry point for ABAP mutations and executions, organised by action " +
    `(groups in this mode: ${groups}). Bare call lists every action; an unrecognised ` +
    "action returns UNKNOWN_ACTION with the nearest legal names. " +
    `Call abap_do({}) for the catalogue of the ${n} actions available in this mode.`
  );
}
