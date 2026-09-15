/**
 * Built-in "core" fluid tool: table select, function-module interface
 * description, function-module call, and SAP documentation reads, all
 * dispatched through one static `ZCL_ZMCP_FLUID_CORE` body class.
 * `ZCL_ZMCP_FLUID_RT` is deployed alongside it (first in `objects`, so it exists before
 * `ZCL_ZMCP_FLUID_CORE` is activated) — its source is the exact one the `rt`
 * tool deploys, not a copy. Same pattern as `classic.ts`.
 *
 * There is no `submit` action and there never will be one: `core` reads and
 * calls what already exists on the target system (a table, a function
 * module) — it does not accept and activate caller-supplied ABAP source the
 * way a generated invoker or a plugin body class does.
 */
import type { FluidManifest, LoadedFluidTool } from "../manifest.js";
import { FLUID_CONTRACT, manifestVersion } from "../manifest.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeManifest, fluidRuntimeSources } from "../abap/runtime.js";
import type { FluidDeps, FluidRunRequest } from "../dispatch.js";
import { AbapError } from "../../errors.js";
import { coreBodySource } from "./core/abap-core.js";
import { selectPart } from "./core/abap-select.js";
import { fmPart } from "./core/abap-fm.js";
import { docuPart } from "./core/abap-docu.js";

export const CORE_TOOL_ID = "core";
export const CORE_BODY_CLASS = "ZCL_ZMCP_FLUID_CORE";

const RUNTIME_SOURCE = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS);
if (RUNTIME_SOURCE === undefined) {
  throw new Error(`fluidRuntimeSources has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const RUNTIME_OBJECT = fluidRuntimeManifest.objects.find((o) => o.name === FLUID_RUNTIME_CLASS);
if (RUNTIME_OBJECT === undefined) {
  throw new Error(`fluidRuntimeManifest has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const CORE_SOURCE = coreBodySource([selectPart, fmPart, docuPart]);

export const coreManifest: FluidManifest = {
  contract: FLUID_CONTRACT,
  id: CORE_TOOL_ID,
  title: "Core read/execute bridge",
  description:
    "Table select, function-module interface description and call, and SAP documentation reads.",
  objects: [
    {
      name: FLUID_RUNTIME_CLASS,
      type: "CLAS/OC",
      // same live object as the rt tool's; derived so the two descriptions can't drift apart
      description: RUNTIME_OBJECT.description,
      source: { text: RUNTIME_SOURCE },
    },
    {
      name: CORE_BODY_CLASS,
      type: "CLAS/OC",
      description: "fluid: table select, FM describe/call, documentation",
      source: { text: CORE_SOURCE },
    },
  ],
  entry: CORE_BODY_CLASS,
  actions: [
    {
      name: "select",
      category: "read",
      description: "Reads rows from one table or view. Judged by the data-preview policy.",
      input: {
        type: "object",
        required: ["table"],
        properties: {
          table: { type: "string", maxLength: 30, description: "The table or view to read." },
          fields: {
            type: "array",
            items: { type: "string", maxLength: 30 },
            description: "Field names to project, in order. Omit for every field.",
          },
          where: {
            type: "string",
            description: "An Open SQL WHERE condition, evaluated dynamically against that one table.",
          },
          max_rows: {
            type: "integer",
            minimum: 0,
            description: "Row limit. Omitted or 0 means no limit — abapsmith imposes no default and no ceiling.",
          },
        },
      },
      output: {
        type: "array",
        items: { type: "object" },
        description: "One row per element; every column value is a JSON string.",
      },
      targets: { object: "/table" },
    },
    {
      name: "describe_fm",
      category: "read",
      description: "Describes a function module's importing/exporting/changing/tables/exception interface.",
      input: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", maxLength: 30, description: "The function module name." },
        },
      },
      output: {
        type: "object",
        required: ["name", "parameters", "exceptions", "params_schema"],
        properties: {
          name: { type: "string" },
          parameters: { type: "array", items: { type: "object" } },
          exceptions: { type: "array", items: { type: "string" } },
          params_schema: { type: "object" },
        },
      },
      targets: { object: "/name" },
    },
    {
      name: "docu",
      category: "read",
      description:
        "Reads SAP documentation (DOKHL/DOKTL) for one documentation object and returns it flattened to plain text.",
      input: {
        type: "object",
        required: ["id", "object"],
        properties: {
          id: {
            type: "string",
            maxLength: 2,
            description: "Documentation id, e.g. DE, DO, TB, CL, IF, FU, RE, NA, HY.",
          },
          object: {
            type: "string",
            maxLength: 60,
            description: "Documentation object name, already in its stored form.",
          },
          language: {
            type: "string",
            maxLength: 2,
            description: "Language to try first. Falls back to the logon language, then EN.",
          },
        },
      },
      output: {
        type: "array",
        items: { type: "object" },
        description: "One head row, one row per flattened text line, one trailing summary row.",
      },
      // No `targets`: this reads documentation, not an object the write gate can name — there
      // is nothing here for `deps.gate` to judge as a write target the way `select`'s table or
      // `describe_fm`'s function module name are.
    },
    {
      name: "call_fm",
      category: "execute",
      description: "Calls a function module in the caller's own system, under the caller's own authorizations.",
      input: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", maxLength: 30, description: "The function module to call." },
          params: {
            type: "object",
            description:
              "Parameter name -> value, every value a string. See core.describe_fm's params_schema.",
          },
          commit: {
            type: "boolean",
            description: "COMMIT WORK AND WAIT after the call. Requires confirm: \"core.call_fm\".",
          },
        },
      },
      output: {
        type: "array",
        items: { type: "object" },
        description: "One returned parameter per element: name, kind, value.",
      },
    },
  ],
};

export const coreSources: ReadonlyMap<string, string> = new Map([
  [FLUID_RUNTIME_CLASS, RUNTIME_SOURCE],
  [CORE_BODY_CLASS, CORE_SOURCE],
]);

export const coreTool: LoadedFluidTool = {
  manifest: coreManifest,
  origin: "builtin",
  sources: coreSources,
  version: manifestVersion(coreManifest, coreSources),
};

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Policy `core`'s manifest cannot express, checked once here rather than
 * duplicated per action: `select` is judged by the same data-preview policy
 * `abap_data_preview` uses (ceiling, deny-list, then the
 * `ABAP_ALLOW_DATA_PREVIEW` capability flag — the flag is a
 * registration-level gate for `abap_data_preview` in `src/server.ts:676`,
 * not something `evaluateDataPreview`/`assertDataPreview` itself reads, so
 * `core.select` has to apply it itself here); `call_fm` by
 * `ABAP_ALLOW_FLUID_CALL_FM` plus a per-call confirm echo when it commits;
 * `docu` is judged by neither policy (see the comment on its fallthrough
 * below) and `describe_fm` needs no guard here at all — reading a function
 * module's interface carries no data-preview or execution risk.
 * `SAFETY_DENIED` is the code for both capability refusals: no
 * `FLUID_CALL_FM_DISABLED` (or similarly named) code exists, and
 * `src/adt/errors.ts` is off-limits for this slice — both refusals are
 * terminal in the same way `SAFETY_DENIED` already is elsewhere.
 */
export async function guardCoreAction(deps: FluidDeps, req: FluidRunRequest): Promise<void> {
  if (req.tool !== CORE_TOOL_ID) return;

  if (req.action === "select") {
    const args = req.args;
    const table =
      typeof args === "object" && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)["table"]
        : undefined;
    if (!isNonEmptyString(table)) return; // schema validation, run right after this guard, reports BAD_INPUT
    deps.gate.assertDataPreview(table);
    if (!deps.cfg.allowDataPreview) {
      throw new AbapError(
        "SAFETY_DENIED",
        `core.select reads table data, which is off by default. Set ABAP_ALLOW_DATA_PREVIEW=true to allow it.`,
        { tool: req.tool, action: req.action, rule: "ABAP_ALLOW_DATA_PREVIEW" },
      );
    }
    return;
  }

  if (req.action === "call_fm") {
    if (!deps.cfg.allowFluidCallFm) {
      throw new AbapError(
        "SAFETY_DENIED",
        `core.call_fm calls an arbitrary function module and is off by default. Set ABAP_ALLOW_FLUID_CALL_FM=true to allow it.`,
        { tool: req.tool, action: req.action, rule: "ABAP_ALLOW_FLUID_CALL_FM" },
      );
    }
    const args = req.args;
    const commit =
      typeof args === "object" && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)["commit"]
        : undefined;
    if (commit === true) {
      const expectedConfirm = `${req.tool}.${req.action}`;
      if (req.confirm !== expectedConfirm) {
        throw new AbapError(
          "BAD_INPUT",
          `${req.tool}.${req.action} mutates state and requires confirm: ${JSON.stringify(expectedConfirm)} ` +
            `(got ${req.confirm === undefined ? "nothing" : JSON.stringify(req.confirm)}).`,
          { field: "confirm", expected: expectedConfirm, got: req.confirm },
        );
      }
    }
    return;
  }

  // `docu` reads SAP's own documentation text out of DOKTL, not application
  // table data, so it is deliberately not judged here: neither
  // `assertDataPreview` nor `ABAP_ALLOW_DATA_PREVIEW` applies to it. It
  // (and every other action this function does not name) falls through to
  // the implicit `return` below untouched.
}
