/**
 * Built-in "classic" fluid tool: the nine classic DDIC/CTS mutations
 * (view/transaction/index/package create+delete, transport-entry-remove)
 * plus a read-only `exists` probe, all dispatched through one static
 * `ZCL_ZMCP_FLUID_CLASSIC` body class instead of a generated per-operation
 * `IF_OO_ADT_CLASSRUN` class. `ZCL_ZMCP_FLUID_RT` is deployed alongside it
 * (first in `objects`, so it exists before `ZCL_ZMCP_FLUID_CLASSIC` is
 * activated) — its source is the exact one the `rt` tool deploys, not a
 * copy.
 */
import type { FluidManifest, LoadedFluidTool } from "../manifest.js";
import { FLUID_CONTRACT, manifestVersion } from "../manifest.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeManifest, fluidRuntimeSources } from "../abap/runtime.js";
import { classicBodySource } from "./classic/abap-core.js";
import { viewPart } from "./classic/abap-view.js";
import { tranPart } from "./classic/abap-tran.js";
import { indexPart } from "./classic/abap-index.js";
import { packagePart } from "./classic/abap-package.js";
import { transportPart } from "./classic/abap-transport.js";
import { existsPart } from "./classic/abap-exists.js";

export const CLASSIC_TOOL_ID = "classic";
export const CLASSIC_BODY_CLASS = "ZCL_ZMCP_FLUID_CLASSIC";

const RUNTIME_SOURCE = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS);
if (RUNTIME_SOURCE === undefined) {
  throw new Error(`fluidRuntimeSources has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const RUNTIME_OBJECT = fluidRuntimeManifest.objects.find((o) => o.name === FLUID_RUNTIME_CLASS);
if (RUNTIME_OBJECT === undefined) {
  throw new Error(`fluidRuntimeManifest has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const CLASSIC_SOURCE = classicBodySource([viewPart, tranPart, indexPart, packagePart, transportPart, existsPart]);

export const classicManifest: FluidManifest = {
  contract: FLUID_CONTRACT,
  id: CLASSIC_TOOL_ID,
  title: "Classic DDIC/CTS bridge",
  description: "Classic-UI DDIC and CTS mutations (view, transaction, index, package, transport entry).",
  objects: [
    {
      name: FLUID_RUNTIME_CLASS,
      type: "CLAS/OC",
      // same live object as the rt tool's; derived so the two descriptions can't drift apart
      description: RUNTIME_OBJECT.description,
      source: { text: RUNTIME_SOURCE },
    },
    {
      name: CLASSIC_BODY_CLASS,
      type: "CLAS/OC",
      description: "fluid: classic DDIC/CTS mutations (view/tran/index/pkg)",
      source: { text: CLASSIC_SOURCE },
    },
  ],
  entry: CLASSIC_BODY_CLASS,
  actions: [
    {
      name: "create_view",
      category: "mutate",
      description: "Creates and activates a database view over one base table.",
      input: {
        type: "object",
        required: ["view_name", "base_table", "fields", "description", "package_name", "corr_nr"],
        properties: {
          view_name: { type: "string", maxLength: 30, description: "The view name (DD25L-VIEWNAME)." },
          base_table: { type: "string", maxLength: 30, description: "The single base table the view projects." },
          fields: {
            type: "array",
            items: { type: "string", maxLength: 30 },
            description: "Field names to project from the base table, in order.",
          },
          description: { type: "string", maxLength: 60, description: "Short text (DD25V-DDTEXT)." },
          package_name: { type: "string", maxLength: 30, description: "Target package (devclass)." },
          corr_nr: {
            type: "string",
            maxLength: 10,
            description: "Transport request. Empty string for a $ (local) package.",
          },
        },
      },
      output: { type: "array", items: { type: "string" }, description: "One transcript line per element." },
      targets: { object: "/view_name", package: "/package_name", transport: "/corr_nr" },
    },
    {
      name: "delete_view",
      category: "mutate",
      description: "Deletes a database view, active and inactive versions, and its TADIR row.",
      input: {
        type: "object",
        required: ["view_name", "package_name"],
        properties: {
          view_name: { type: "string", maxLength: 30, description: "The view name to delete." },
          package_name: { type: "string", maxLength: 30, description: "The view's current package, for the gate." },
        },
      },
      output: { type: "array", items: { type: "string" }, description: "One transcript line per element." },
      targets: { object: "/view_name", package: "/package_name", corr: "local" },
    },
    {
      name: "create_transaction",
      category: "mutate",
      description: "Registers a dialog transaction code against a report and dynpro 1000.",
      input: {
        type: "object",
        required: ["tcode", "program", "description", "package_name", "corr_nr"],
        properties: {
          tcode: { type: "string", maxLength: 20, description: "The transaction code to create." },
          program: { type: "string", maxLength: 40, description: "The report the tcode starts." },
          description: { type: "string", maxLength: 60, description: "Short text." },
          package_name: { type: "string", maxLength: 30, description: "Target package (devclass)." },
          corr_nr: {
            type: "string",
            maxLength: 10,
            description: "Transport request. Empty string for a $ (local) package.",
          },
        },
      },
      output: { type: "array", items: { type: "string" }, description: "One transcript line per element." },
      targets: { object: "/tcode", package: "/package_name", transport: "/corr_nr" },
    },
    {
      name: "delete_transaction",
      category: "mutate",
      description: "Deletes a dialog transaction code and confirms the TSTC row is gone.",
      input: {
        type: "object",
        required: ["tcode", "package_name"],
        properties: {
          tcode: { type: "string", maxLength: 20, description: "The transaction code to delete." },
          package_name: { type: "string", maxLength: 30, description: "The tcode's current package, for the gate." },
        },
      },
      output: { type: "array", items: { type: "string" }, description: "One transcript line per element." },
      targets: { object: "/tcode", package: "/package_name", corr: "local" },
    },
    {
      name: "create_index",
      category: "mutate",
      description: "Creates and activates a secondary index on one base table.",
      input: {
        type: "object",
        required: ["index_name", "base_table", "fields", "description", "package_name", "corr_nr"],
        properties: {
          index_name: { type: "string", maxLength: 3, description: "The 3-character index id (DD12V-INDEXNAME)." },
          base_table: { type: "string", maxLength: 30, description: "The table the index is created on." },
          fields: {
            type: "array",
            items: { type: "string", maxLength: 30 },
            description: "Field names in the index, in order.",
          },
          description: { type: "string", maxLength: 60, description: "Short text." },
          package_name: { type: "string", maxLength: 30, description: "Target package (devclass)." },
          corr_nr: {
            type: "string",
            maxLength: 10,
            description: "Transport request. Empty string for a $ (local) package.",
          },
          unique: { type: "boolean", description: "Whether the index enforces uniqueness." },
        },
      },
      output: { type: "array", items: { type: "string" }, description: "One transcript line per element." },
      targets: { object: "/base_table", package: "/package_name", transport: "/corr_nr" },
    },
    {
      name: "delete_index",
      category: "mutate",
      description: "Deletes a secondary index and confirms no catalog rows remain.",
      input: {
        type: "object",
        required: ["index_name", "base_table", "package_name", "corr_nr"],
        properties: {
          index_name: { type: "string", maxLength: 3, description: "The 3-character index id to delete." },
          base_table: { type: "string", maxLength: 30, description: "The table the index is on." },
          package_name: { type: "string", maxLength: 30, description: "The index's package, for the gate." },
          corr_nr: {
            type: "string",
            maxLength: 10,
            description: "Transport request. Empty string for a $ (local) package.",
          },
        },
      },
      output: { type: "array", items: { type: "string" }, description: "One transcript line per element." },
      targets: { object: "/base_table", package: "/package_name", transport: "/corr_nr" },
    },
    {
      name: "create_package",
      category: "mutate",
      description: "Creates a development package and optionally attaches it under a super package.",
      input: {
        type: "object",
        required: ["package_name", "description", "software_component", "corr_nr", "super_package"],
        properties: {
          package_name: { type: "string", maxLength: 30, description: "The package (devclass) to create." },
          description: { type: "string", maxLength: 60, description: "Short text." },
          software_component: { type: "string", maxLength: 30, description: "Delivery unit (TDEVC-DLVUNIT)." },
          corr_nr: {
            type: "string",
            maxLength: 10,
            description: "Transport request. Empty string for a $ (local) package.",
          },
          super_package: {
            type: "string",
            maxLength: 30,
            description: "Parent package. Empty string for a root package.",
          },
          package_type: {
            type: "string",
            maxLength: 20,
            description: "Only \"development\" is supported; omit for the default.",
          },
        },
      },
      output: { type: "array", items: { type: "string" }, description: "One transcript line per element." },
      targets: { object: "/package_name", package: "/super_package", transport: "/corr_nr" },
    },
    {
      name: "delete_package",
      category: "mutate",
      description: "Deletes a package after confirming it holds no sub-packages or objects.",
      input: {
        type: "object",
        required: ["package_name", "corr_nr"],
        properties: {
          package_name: { type: "string", maxLength: 30, description: "The package (devclass) to delete." },
          corr_nr: {
            type: "string",
            maxLength: 10,
            description: "Transport request. Empty string for a $ (local) package.",
          },
        },
      },
      output: { type: "array", items: { type: "string" }, description: "One transcript line per element." },
      targets: { object: "/package_name", package: "/package_name", transport: "/corr_nr" },
    },
    {
      name: "remove_transport_entry",
      category: "mutate",
      description: "Removes one object's E071 entry from a transport request or one of its tasks.",
      input: {
        type: "object",
        required: ["trkorr", "object_name"],
        properties: {
          trkorr: { type: "string", maxLength: 10, description: "The transport request holding the entry." },
          object_name: { type: "string", maxLength: 40, description: "The object name (E071-OBJ_NAME) to remove." },
        },
      },
      output: { type: "array", items: { type: "string" }, description: "One transcript line per element." },
    },
    {
      name: "exists",
      category: "read",
      description: "Checks whether a view, transaction, package or index currently exists.",
      input: {
        type: "object",
        required: ["kind", "name"],
        properties: {
          kind: {
            type: "string",
            enum: ["view", "transaction", "package", "index"],
            description: "Which catalog to check.",
          },
          name: { type: "string", maxLength: 30, description: "The object name to look up." },
          base_table: { type: "string", maxLength: 30, description: "Required only when kind is \"index\"." },
        },
      },
      output: { type: "array", items: { type: "string" }, description: "One transcript line per element." },
      targets: { object: "/name" },
    },
  ],
};

export const classicSources: ReadonlyMap<string, string> = new Map([
  [FLUID_RUNTIME_CLASS, RUNTIME_SOURCE],
  [CLASSIC_BODY_CLASS, CLASSIC_SOURCE],
]);

export const classicTool: LoadedFluidTool = {
  manifest: classicManifest,
  origin: "builtin",
  sources: classicSources,
  version: manifestVersion(classicManifest, classicSources),
};
