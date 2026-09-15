/**
 * Built-in "core" fluid tool: table select, function-module interface
 * description, function-module call, SAP documentation reads, change-document
 * (CDHDR/CDPOS) reads, and enqueue-lock (SM12) reads, all dispatched through
 * one static `ZCL_ZMCP_FLUID_CORE` body class.
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
import { changeDocsPart } from "./core/abap-change-docs.js";
import { locksPart } from "./core/abap-locks.js";

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

const CORE_SOURCE = coreBodySource([selectPart, fmPart, docuPart, changeDocsPart, locksPart]);

export const coreManifest: FluidManifest = {
  contract: FLUID_CONTRACT,
  id: CORE_TOOL_ID,
  title: "Core read/execute bridge",
  description:
    "Table select, function-module interface description and call, SAP documentation reads, " +
    "change-document (CDHDR/CDPOS) reads, and enqueue-lock (SM12) reads.",
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
      name: "change_docs",
      category: "read",
      description:
        "Reads SAP change documents (CDHDR/CDPOS) for one object class — who changed a business " +
        "object, when, and which field values changed. Judged by the data-preview policy.",
      input: {
        type: "object",
        required: ["objectclass"],
        properties: {
          objectclass: {
            type: "string",
            maxLength: 15,
            description: "The CDHDR object class to read, e.g. MATERIAL, KNA1.",
          },
          objectid: {
            type: "string",
            maxLength: 90,
            description:
              "CDHDR-OBJECTID. `*` is a wildcard; omitted matches every object id.",
          },
          user: {
            type: "string",
            maxLength: 12,
            description: "CDHDR-USERNAME. `*` is a wildcard; omitted is unrestricted.",
          },
          since: {
            type: "string",
            maxLength: 14,
            description:
              "Window start, YYYYMMDDHHMMSS in server time. Default window is the last 24 hours.",
          },
          until: {
            type: "string",
            maxLength: 14,
            description:
              "Window end, YYYYMMDDHHMMSS in server time. Default window is the last 24 hours.",
          },
          tcode: {
            type: "string",
            maxLength: 20,
            description: "CDHDR-TCODE. `*` is a wildcard.",
          },
          max: {
            type: "integer",
            minimum: 0,
            description:
              "Cap on change DOCUMENTS, not positions; 0 or omitted means 20. Positions of each " +
              "returned document are read in full, then clamped as a whole against the " +
              "data-preview row ceiling in TypeScript.",
          },
        },
      },
      output: {
        type: "array",
        items: { type: "object" },
        description:
          "One header row per change document, that document's position rows, then one trailing " +
          "summary row.",
      },
      // No `targets`: an object class is not a repository object the write gate can name the way
      // `select`'s table or `describe_fm`'s function module name are. The tables actually read —
      // CDHDR, CDPOS, and whatever tables the returned positions name — are judged by the
      // data-preview policy instead, partly in `guardCoreAction` below (CDHDR/CDPOS themselves,
      // before the ABAP runs) and partly in `applyPositionPolicy` after the rows come back (every
      // table a returned position names, which cannot be known until then).
    },
    {
      name: "locks",
      category: "read",
      description:
        "Reads enqueue locks (the SM12 view) filtered by lock object, lock argument or user. " +
        "Read-only; there is no release path. At least one of object/table/user is required — " +
        "without one this would dump the whole enqueue table.",
      input: {
        type: "object",
        properties: {
          object: {
            type: "string",
            maxLength: 30,
            description:
              "Lock object / table name pattern, matched against SEQG3-GNAME or SEQG3-GOBJ. `*` " +
              "is a wildcard. At least one of object/table/user is required.",
          },
          table: {
            type: "string",
            maxLength: 90,
            description:
              "Lock ARGUMENT pattern, matched against SEQG3-GARG. `*` is a wildcard. At least one " +
              "of object/table/user is required.",
          },
          user: {
            type: "string",
            maxLength: 12,
            description:
              "SEQG3-GUNAME pattern. `*` is a wildcard. At least one of object/table/user is required.",
          },
          max: {
            type: "integer",
            minimum: 0,
            description: "Row cap; 0 or omitted means 50.",
          },
        },
      },
      output: {
        type: "array",
        items: { type: "object" },
        description: "One meta row, one row per lock, then one trailing summary row.",
      },
      // No `targets`: an enqueue lock is runtime state, not a repository object the write gate
      // can name.
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
 * `change_docs` by the same data-preview policy as `select`, applied to the
 * two tables it always reads (CDHDR/CDPOS), with every table a returned
 * position names judged separately, afterwards, by `applyPositionPolicy` in
 * `src/adt/change-docs.ts`; `locks` is judged by neither policy (see its own
 * branch below); `docu` is judged by neither policy (see the comment on its
 * fallthrough below) and `describe_fm` needs no guard here at all — reading
 * a function module's interface carries no data-preview or execution risk.
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

  if (req.action === "change_docs") {
    // Same capability flag as `select`, plus the two tables this action
    // ALWAYS reads. This guard runs BEFORE the ABAP executes, and therefore
    // before any CDPOS row has named a table, so it can only judge CDHDR and
    // CDPOS themselves — every table a returned position names is judged
    // afterwards by `applyPositionPolicy` in `src/adt/change-docs.ts`, which
    // drops denied positions and reports the count. Without that second
    // pass, a change document on PA0008 would be a payroll read through a
    // gate that only ever looked at CDHDR.
    deps.gate.assertDataPreview("CDHDR");
    deps.gate.assertDataPreview("CDPOS");
    if (!deps.cfg.allowDataPreview) {
      throw new AbapError(
        "SAFETY_DENIED",
        `core.change_docs reads table data, which is off by default. Set ABAP_ALLOW_DATA_PREVIEW=true to allow it.`,
        { tool: req.tool, action: req.action, rule: "ABAP_ALLOW_DATA_PREVIEW" },
      );
    }
    return;
  }

  if (req.action === "locks") {
    // `core.locks` reads runtime enqueue state (who holds which lock), not
    // application table data, so neither `assertDataPreview` nor
    // `ABAP_ALLOW_DATA_PREVIEW` applies. It matches what `abap_fpm_read
    // mode=locks` already exposes ungated. It is read-only: no `DEQUEUE`
    // path exists anywhere in abapsmith.
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
