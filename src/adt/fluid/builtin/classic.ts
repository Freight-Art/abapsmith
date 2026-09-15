/**
 * Built-in "classic" fluid tool: fourteen classic DDIC/CTS mutations
 * (view/transaction/index/package/search-help create+delete, view/
 * transaction update, transport-entry-remove) plus a read-only `exists`
 * probe, all dispatched through one static `ZCL_ZMCP_FLUID_CLASSIC` body
 * class instead of a generated per-operation `IF_OO_ADT_CLASSRUN` class.
 * `ZCL_ZMCP_FLUID_RT` is deployed alongside it (first in `objects`, so it
 * exists before `ZCL_ZMCP_FLUID_CLASSIC` is activated) — its source is the
 * exact one the `rt` tool deploys, not a copy.
 *
 * Note (issue #83): `exists` does NOT cover search helps — its `kind` enum
 * is deliberately left as `["view", "transaction", "package", "index"]`.
 * Extending it (and `abap-exists.ts`) was out of scope for this change; see
 * the accompanying report for why.
 */
import type { FluidManifest, LoadedFluidTool } from "../manifest.js";
import { FLUID_CONTRACT, manifestVersion } from "../manifest.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeManifest, fluidRuntimeSources } from "../abap/runtime.js";
import { classicBodySource } from "./classic/abap-core.js";
import { viewPart } from "./classic/abap-view.js";
import { tranPart } from "./classic/abap-tran.js";
import { shlpPart } from "./classic/abap-shlp.js";
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

const CLASSIC_SOURCE = classicBodySource([
  viewPart,
  tranPart,
  shlpPart,
  indexPart,
  packagePart,
  transportPart,
  existsPart,
]);

export const classicManifest: FluidManifest = {
  contract: FLUID_CONTRACT,
  id: CLASSIC_TOOL_ID,
  title: "Classic DDIC/CTS bridge",
  description: "Classic-UI DDIC and CTS mutations (view, transaction, search help, index, package, transport entry).",
  // This tool's ABAP reads args with the flat, single-pass `scan()`
  // (`./classic/abap-core.ts`) — see `FluidManifest.flatArgs` — so the
  // dispatcher flattens nested arrays-of-objects/objects (e.g. `shlp`'s
  // `fields`/`includes`/`assignments`) before serialising. The declared
  // schemas below stay the honest, caller-facing nested shape; validation
  // still runs against them before flattening.
  flatArgs: true,
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
      description: "fluid: classic DDIC/CTS mutations (view/tran/shlp/index/pkg)",
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
          confirm_maintenance_dialog: {
            type: "boolean",
            description:
              "Required (true) if the view has a generated maintenance dialog (TVDIR) — deleting the " +
              "view leaves that dialog broken.",
          },
        },
      },
      output: { type: "array", items: { type: "string" }, description: "One transcript line per element." },
      targets: { object: "/view_name", package: "/package_name", corr: "local" },
    },
    {
      name: "update_view",
      category: "mutate",
      description: "Replaces and re-activates an existing database view's definition.",
      input: {
        type: "object",
        required: ["view_name", "base_table", "fields", "description", "package_name", "corr_nr"],
        properties: {
          view_name: { type: "string", maxLength: 30, description: "The existing view name (DD25L-VIEWNAME)." },
          base_table: { type: "string", maxLength: 30, description: "The single base table the view projects." },
          fields: {
            type: "array",
            items: { type: "string", maxLength: 30 },
            description: "Field names to project from the base table, in order. Replaces the whole field list.",
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
      name: "update_transaction",
      category: "mutate",
      description: "Retargets an existing dialog transaction code to a different report.",
      input: {
        type: "object",
        required: ["tcode", "program", "description", "package_name", "corr_nr"],
        properties: {
          tcode: { type: "string", maxLength: 20, description: "The existing transaction code to retarget." },
          program: { type: "string", maxLength: 40, description: "The new report the tcode starts." },
          description: { type: "string", maxLength: 60, description: "Short text." },
          package_name: { type: "string", maxLength: 30, description: "Target package (devclass)." },
          corr_nr: {
            type: "string",
            maxLength: 10,
            description: "Transport request. Empty string for a $ (local) package.",
          },
          confirm_in_role_menu: {
            type: "boolean",
            description:
              "Required (true) if the tcode is already assigned to one or more roles' menus (AGR_TCODES) — " +
              "retargeting it changes what those menu entries launch. An SM01 transaction lock is not checked.",
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
          confirm_in_role_menu: {
            type: "boolean",
            description:
              "Required (true) if the tcode is already assigned to one or more roles' menus (AGR_TCODES) — " +
              "deleting it removes it from those role menus. An SM01 transaction lock is not checked.",
          },
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
      name: "create_search_help",
      category: "mutate",
      description: "Creates and activates an elementary or collective search help.",
      input: {
        type: "object",
        required: [
          "shlp_name",
          "description",
          "package_name",
          "corr_nr",
          "fields",
          "elementary",
        ],
        properties: {
          shlp_name: { type: "string", maxLength: 30, description: "The search help name (DD30L-SHLPNAME)." },
          description: { type: "string", maxLength: 60, description: "Short text (DD30V-DDTEXT)." },
          package_name: { type: "string", maxLength: 30, description: "Target package (devclass)." },
          corr_nr: {
            type: "string",
            maxLength: 10,
            description: "Transport request. Empty string for a $ (local) package.",
          },
          selection_method: {
            type: "string",
            maxLength: 30,
            description:
              "Table or view the search help selects from (DD30V-SELMETHOD). Empty string (the " +
              "default) means none: a collective search help, or an elementary one driven by a " +
              "search-help exit instead of a table/view.",
          },
          selection_method_type: {
            type: "string",
            maxLength: 1,
            description:
              "Selection method type: \"T\" (table) or \"V\" (view); others are not checked here. " +
              "Only meaningful alongside a non-empty selection_method; leave empty (the default) when " +
              "selection_method is empty too.",
          },
          dialog_type: {
            type: "string",
            maxLength: 1,
            description: "DD30V-DIALOGTYPE. Defaults to \"D\" (dialog only if needed) when omitted.",
          },
          text_table: { type: "string", maxLength: 30, description: "Optional text table (DD30V-TEXTTAB)." },
          hot_key: { type: "string", maxLength: 1, description: "Optional single-character hotkey." },
          elementary: {
            type: "boolean",
            description:
              "Whether this is an elementary search help (DD30V-ISSIMPLE). If true, at least one field " +
              "must be marked import and at least one export.",
          },
          fields: {
            type: "array",
            description: "Interface fields (DD32P), in order.",
            items: {
              type: "object",
              required: ["name", "data_element"],
              properties: {
                name: { type: "string", maxLength: 30, description: "Field name." },
                data_element: { type: "string", maxLength: 30, description: "Data element (DD32P-ROLLNAME)." },
                import: { type: "boolean", description: "Whether this field is an import parameter." },
                export: { type: "boolean", description: "Whether this field is an export parameter." },
                default_value: { type: "string", description: "Optional default value." },
              },
            },
          },
          includes: {
            type: "array",
            description: "Other search helps included by this one (DD31V), in order.",
            items: {
              type: "object",
              required: ["name"],
              properties: { name: { type: "string", maxLength: 30, description: "Included search help name." } },
            },
          },
          assignments: {
            type: "array",
            description: "Field assignments between an included search help and this one's interface (DD33V).",
            items: {
              type: "object",
              required: ["field", "included_help", "included_field", "direction"],
              properties: {
                field: { type: "string", maxLength: 30, description: "This search help's field (DD33V-FIELDNAME)." },
                included_help: { type: "string", maxLength: 30, description: "The included search help's name." },
                included_field: { type: "string", maxLength: 30, description: "The included search help's field." },
                direction: {
                  type: "string",
                  maxLength: 1,
                  description: "DD33V-VALUEDIREC ('I' import into, 'E' export from the included help).",
                },
              },
            },
          },
        },
      },
      output: { type: "array", items: { type: "string" }, description: "One transcript line per element." },
      targets: { object: "/shlp_name", package: "/package_name", transport: "/corr_nr" },
    },
    {
      name: "update_search_help",
      category: "mutate",
      description: "Replaces and re-activates an existing search help's definition.",
      input: {
        type: "object",
        required: [
          "shlp_name",
          "description",
          "package_name",
          "corr_nr",
          "fields",
          "elementary",
        ],
        properties: {
          shlp_name: { type: "string", maxLength: 30, description: "The existing search help name." },
          description: { type: "string", maxLength: 60, description: "Short text (DD30V-DDTEXT)." },
          package_name: { type: "string", maxLength: 30, description: "Target package (devclass)." },
          corr_nr: {
            type: "string",
            maxLength: 10,
            description: "Transport request. Empty string for a $ (local) package.",
          },
          selection_method: {
            type: "string",
            maxLength: 30,
            description:
              "Table or view the search help selects from (DD30V-SELMETHOD). Empty string (the " +
              "default) means none: a collective search help, or an elementary one driven by a " +
              "search-help exit instead of a table/view.",
          },
          selection_method_type: {
            type: "string",
            maxLength: 1,
            description:
              "Selection method type: \"T\" (table) or \"V\" (view); others are not checked here. " +
              "Only meaningful alongside a non-empty selection_method; leave empty (the default) when " +
              "selection_method is empty too.",
          },
          dialog_type: {
            type: "string",
            maxLength: 1,
            description: "DD30V-DIALOGTYPE. Defaults to \"D\" (dialog only if needed) when omitted.",
          },
          text_table: { type: "string", maxLength: 30, description: "Optional text table (DD30V-TEXTTAB)." },
          hot_key: { type: "string", maxLength: 1, description: "Optional single-character hotkey." },
          elementary: {
            type: "boolean",
            description:
              "Whether this is an elementary search help (DD30V-ISSIMPLE). If true, at least one field " +
              "must be marked import and at least one export.",
          },
          fields: {
            type: "array",
            description: "Interface fields (DD32P), in order. Replaces the whole interface.",
            items: {
              type: "object",
              required: ["name", "data_element"],
              properties: {
                name: { type: "string", maxLength: 30, description: "Field name." },
                data_element: { type: "string", maxLength: 30, description: "Data element (DD32P-ROLLNAME)." },
                import: { type: "boolean", description: "Whether this field is an import parameter." },
                export: { type: "boolean", description: "Whether this field is an export parameter." },
                default_value: { type: "string", description: "Optional default value." },
              },
            },
          },
          includes: {
            type: "array",
            description: "Other search helps included by this one (DD31V), in order. Replaces the whole list.",
            items: {
              type: "object",
              required: ["name"],
              properties: { name: { type: "string", maxLength: 30, description: "Included search help name." } },
            },
          },
          assignments: {
            type: "array",
            description:
              "Field assignments between an included search help and this one's interface (DD33V). " +
              "Replaces the whole list.",
            items: {
              type: "object",
              required: ["field", "included_help", "included_field", "direction"],
              properties: {
                field: { type: "string", maxLength: 30, description: "This search help's field (DD33V-FIELDNAME)." },
                included_help: { type: "string", maxLength: 30, description: "The included search help's name." },
                included_field: { type: "string", maxLength: 30, description: "The included search help's field." },
                direction: {
                  type: "string",
                  maxLength: 1,
                  description: "DD33V-VALUEDIREC ('I' import into, 'E' export from the included help).",
                },
              },
            },
          },
        },
      },
      output: { type: "array", items: { type: "string" }, description: "One transcript line per element." },
      targets: { object: "/shlp_name", package: "/package_name", transport: "/corr_nr" },
    },
    {
      name: "delete_search_help",
      category: "mutate",
      description: "Deletes a search help, active and inactive versions, and its TADIR row.",
      input: {
        type: "object",
        required: ["shlp_name", "package_name"],
        properties: {
          shlp_name: { type: "string", maxLength: 30, description: "The search help name to delete." },
          package_name: {
            type: "string",
            maxLength: 30,
            description: "The search help's current package, for the gate.",
          },
          confirm_in_use: {
            type: "boolean",
            description:
              "Required (true) if the search help is still attached to a data element, a table/view field, " +
              "or included by a collective search help.",
          },
        },
      },
      output: { type: "array", items: { type: "string" }, description: "One transcript line per element." },
      targets: { object: "/shlp_name", package: "/package_name", corr: "local" },
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
