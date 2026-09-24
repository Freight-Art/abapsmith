/**
 * The `abap_write` input schema (zod), its inferred input types, and
 * target/structured-source resolution from that input.
 */
import { z } from "zod";
import { NON_WRITABLE_TYPES } from "../adt/capabilities.js";
import { AbapError } from "../adt/errors.js";
import { buildStructuredDdicDescriptor } from "../adt/ddic-payload.js";
import { parseObjectRef } from "../adt/resolve.js";
import { CLASS_INCLUDES, specForKeyword, specForType } from "../adt/types.js";
import { MAX_DELETE_BATCH } from "../adt/write.js";
import type { WriteTarget } from "../adt/write.js";

// Mirrors the top-level `affects` field below, kept as a separate literal
// (not shared) so editing that field's prose can't silently change every
// batch-delete entry's schema too. Used only inside `objects`.
const deleteEntryAffectsSchema = z.object({
  name: z.string().describe("Object this enhancement binds to."),
  packageName: z.string().describe("Its package."),
  masterSystem: z.string().optional().describe("Its masterSystem. Omit for local/$TMP."),
  spotName: z.string().optional().describe("Enhancement spot, if reached via one."),
});

export const writeInputSchema = {
  object: z.string().optional().describe("Object reference."),
  type: z
    .string()
    .optional()
    .describe(`ADT type of a NEW object, e.g. CLAS/OC. Not writable: ${NON_WRITABLE_TYPES.join(" ")}.`),
  source: z
    .string()
    .optional()
    .describe("Full source, required unless deleting."),
  fixed_point_arithmetic: z
    .boolean()
    .optional()
    .describe(
      "PROG/P only. Set false to create the report with Fixed Point Arithmetic off. Default true.",
    ),
  text_pool: z
    .object({
      symbols: z.record(z.string(), z.string()).optional(),
      selection_texts: z.record(z.string(), z.string()).optional(),
      headings: z
        .object({
          list_header: z.string().optional(),
          column_headers: z.array(z.string()).max(4).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional()
    .describe(
      "PROG/P, CLAS/OC or FUGR/F. Text symbols (all three), and selection texts and list " +
        "headings (PROG/P and FUGR/F only), written to the object's text pool after the source; " +
        "allowed without `source` on an existing object. Each group given replaces that group " +
        "entirely.",
    ),
  // `edit`/`method` must be declared here: zod strips undeclared keys before
  // the callback sees them, so an undeclared `method` silently fell through
  // to the whole-object-rewrite branch instead of erroring — see
  // the git history for the incident.
  edit: z
    .object({
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    })
    .optional()
    .describe("Splice a unique old_string; skip `source`."),
  method: z
    .string()
    .optional()
    .describe(
      "CLAS/OC: one method to replace; body in `source`. TRAN/T kind=oo: public method " +
        "without mandatory parameters.",
    ),
  // `source`/`edit`/`method` all apply to the include named here
  // (`resolveWriteTarget` builds `sourceUri` from it). Must be declared for
  // the same zod-strips-undeclared-keys reason as `edit`/`method` above — an
  // undeclared `include:"testclasses"` would silently overwrite MAIN source.
  // `z.enum(CLASS_INCLUDES)`, matching `readInputSchema.include`
  // (src/tools/read.ts), turns a typo into a schema rejection.
  include: z
    .enum(CLASS_INCLUDES)
    .optional()
    .describe("CLAS/OC only; testclasses=ABAP Unit tests, default main."),
  package: z
    .string()
    .optional()
    .describe(
      "Package for a NEW object. Default $TMP. A transportable one resolves its transport " +
        "request under ABAP_ALLOW_TRANSPORTS when corr_nr is omitted (every type, including " +
        "TRAN/T, VIEW/DV, SHLP/DH and TABL/DI). A $-package refuses corr_nr. " +
        "TABL/DI: ignored except to check agreement — an index's package is always the base " +
        "table's, never caller-chosen.",
    ),
  description: z
    .string()
    .optional()
    .describe(
      "Short text for a create. Default: the object name (TABL/DI: `<table> index <id>`). Limit: " +
        "36 chars for TRAN/T (TSTCT-TTEXT), 60 for DDIC types (DDTEXT). Required for mode=update of " +
        "TRAN/T, VIEW/DV, SHLP/DH.",
    ),
  // Structured create for the three XML-only DDIC types, so a
  // caller doesn't have to hand-compose the descriptor. Builder + grounding
  // citation live in src/adt/ddic-payload.ts (buildStructuredDdicDescriptor);
  // this schema only lists the fields that builder actually accepts. Kept
  // flat and terse — schema prose here is billed on every `tools/list`.
  ddic: z
    .object({
      dataType: z.string().optional(),
      length: z.number().optional(),
      decimals: z.number().optional(),
      outputLength: z.number().optional(),
      lowercase: z.boolean().optional(),
      signExists: z.boolean().optional(),
      fixedValues: z
        .array(z.object({ low: z.string(), high: z.string().optional(), text: z.string() }).strict())
        .optional()
        .describe(
          "DOMA/DD only: fixed values, in order. `low` (or `low`..`high` for an interval) max 10 " +
            "chars and within the domain length; `text` max 60 chars.",
        ),
      valueTable: z.string().optional().describe("DOMA/DD only: value table name (existence checked by the server)."),
      typeKind: z.enum(["domain", "predefinedAbapType", "dictionaryType"]).optional(),
      typeName: z.string().optional(),
      shortLabel: z.string().optional(),
      shortLength: z.number().optional(),
      mediumLabel: z.string().optional(),
      mediumLength: z.number().optional(),
      longLabel: z.string().optional(),
      longLength: z.number().optional(),
      headingLabel: z.string().optional(),
      headingLength: z.number().optional(),
      searchHelp: z
        .string()
        .optional()
        .describe(
          "DTEL/DE only: search help attached to this data element (DD04L-SHLPNAME). Not checked " +
            "before send. Uppercased, max 30 chars.",
        ),
      searchHelpParameter: z
        .string()
        .optional()
        .describe(
          "DTEL/DE only: the search help's own interface parameter this data element binds to " +
            "(DD04L-SHLPFIELD). Refused without `searchHelp`. Uppercased, max 30 chars.",
        ),
    })
    .strict()
    .optional()
    .describe("DOMA/DD, DTEL/DE, TTYP/DA: alt to `source`, never both."),
  // SHLP/DH create/update, required: DD30V/DD32P/DD31V/DD33V fields no
  // existing field can carry. Mirrors `ddic` above's structured-field
  // convention rather than a flat SHLP_* field explosion. Builder is
  // `SearchHelpParams` (src/adt/shlp-create.ts); this schema only lists the
  // fields that shape accepts. `update_search_help` REPLACES the whole
  // interface/includes/assignments list, same as a DDIF_VIEW_PUT view
  // update — nothing carried over here from what already exists.
  shlp: z
    .object({
      selectionMethod: z
        .string()
        .optional()
        .describe(
          "DD30V-SELMETHOD: table or view the search help selects from. Omit for a collective search " +
            "help, or an elementary one driven by a search-help exit instead of a table/view.",
        ),
      selectionMethodType: z
        .enum(["T", "V", "M"])
        .optional()
        .describe(
          "DD30V-SELMTYPE. Only meaningful alongside selectionMethod; omit when selectionMethod is " +
            "omitted too.",
        ),
      dialogType: z.string().optional().describe("DD30V-DIALOGTYPE. Defaults to \"D\" when omitted."),
      textTable: z.string().optional().describe("DD30V-TEXTTAB."),
      hotKey: z.string().optional().describe("DD30V-HOTKEY, one character."),
      elementary: z
        .boolean()
        .describe("DD30V-ISSIMPLE. If true, `fields` must carry at least one import and one export parameter."),
      fields: z
        .array(
          z.object({
            name: z.string().describe("DD32P-FIELDNAME."),
            dataElement: z.string().describe("DD32P-ROLLNAME."),
            import: z.boolean().optional().describe("DD32P-SHLPINPUT."),
            export: z.boolean().optional().describe("DD32P-SHLPOUTPUT."),
            defaultValue: z.string().optional().describe("DD32P-DEFAULTVAL."),
          }),
        )
        .describe("Interface fields (DD32P), in order."),
      includes: z
        .array(z.object({ name: z.string().describe("DD31V-SUBSHLP.") }))
        .optional()
        .describe(
          "Other search helps included by this one (DD31V), in order. Optional — empty or omitted is " +
            "fine, including for elementary: false. Each name must exist as an ACTIVE search help " +
            "(DD30L); refused before registration otherwise (CHECK_FAILED).",
        ),
      assignments: z
        .array(
          z.object({
            field: z
              .string()
              .describe(
                "DD33V-FIELDNAME, this search help's field. Must match one of this call's own " +
                  "`fields[].name` (case-insensitive); refused before send otherwise (BAD_INPUT).",
              ),
            includedHelp: z
              .string()
              .describe(
                "DD33V-SUBSHLP. Must match one of this call's own `includes[].name` " +
                  "(case-insensitive); refused before send otherwise (BAD_INPUT).",
              ),
            includedField: z
              .string()
              .describe(
                "DD33V-SUBFIELD. Must be an ACTIVE interface parameter (DD32S) of `includedHelp`; " +
                  "checked server-side before RS_CORR_INSERT, not zero-network, and refused " +
                  "otherwise (CHECK_FAILED).",
              ),
            direction: z
              .enum(["I", "E"])
              .describe(
                'DD33V-VALUEDIREC: I=import into, E=export from the included help. May read back as ' +
                  'C ("both import and export") when the target parameter is both import and export.',
              ),
          }),
        )
        .optional()
        .describe(
          "Field assignments (DD33V) between an included search help and this one's interface. " +
            "`field`, `includedHelp` and `includedField` are each validated against this call's own " +
            "fields/includes/target help; see each field below.",
        ),
    })
    .strict()
    .optional()
    .describe("SHLP/DH create/update, required: search help definition. See SearchHelpParams in src/adt/shlp-create.ts."),
  expect_etag: z.string().optional().describe("Etag from abap_read; fails if changed."),
  mode: z
    .enum(["write", "delete", "update"])
    .optional()
    .describe(
      "Default write (create for most types). \"update\" retargets/replaces an EXISTING " +
        "VIEW/DV, TRAN/T or SHLP/DH in place (whole definition replaced) — refused zero-network " +
        "for every other type.",
    ),
  activate: z.boolean().optional().describe("Default true."),
  verify: z.boolean().optional().describe("Force verified mode; reads back after write."),
  format: z.boolean().optional().describe("Pretty-print source before writing."),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Preview only: returns the diff and the expect_etag a real write would assert. Makes no " +
        "lock, PUT, DELETE, activation, unlock or transport call and journals nothing.",
    ),
  corr_nr: z
    .string()
    .optional()
    .describe(
      "Transport request. $TMP needs none. Optional for every transportable create, including " +
        "the bridge types TRAN/T, VIEW/DV, SHLP/DH and TABL/DI: omitted, one is resolved under " +
        "ABAP_ALLOW_TRANSPORTS (auto reuses a modifiable request this session created for the " +
        "package, else creates one; under auto a NAMED request is refused, so omit it). Refused " +
        "for a $ package, and on VIEW/DV or TRAN/T delete. TABL/DI delete: same package-derived " +
        "resolution as its create, not refused. " +
        "If the object is already recorded in a DIFFERENT request, CTS imposes that one instead: " +
        "mode=write proceeds under it and reports corr_nr_honoured: false; mode=delete is refused " +
        "outright with TRANSPORT_ERROR (CORR_NR_NOT_HONOURED) and deletes nothing.",
    ),
  remote_enabled: z
    .boolean()
    .optional()
    .describe(
      "FUGR/FF only: true makes the module remote-enabled (processing type rfc), false makes " +
        "it a normal module. Refused for every other type and for mode=delete.",
    ),
  software_component: z.string().optional().describe("DEVC/K required: LOCAL or transportable."),
  package_type: z.string().optional().describe("DEVC/K only. Default development."),
  transport_layer: z.string().optional().describe("DEVC/K only. Default empty."),
  // The three fields the classrun-bridge create needs and no existing field
  // can carry (src/adt/ddic-bridge.ts); everything else (name, description,
  // package, corr_nr) is already on this shape, which is why this extends
  // `abap_write` rather than being a new tool. Descriptions kept terse
  // deliberately: schema prose is billed on every `tools/list`, while the
  // fuller guidance is billed only to a caller who gets it wrong
  // (`abapCreateViaBridge`, below) — see test/tools.test.ts's "tool surface".
  base_table: z
    .string()
    .optional()
    .describe(
      "VIEW/DV create: the single base table the view projects. TABL/DI create+delete, " +
        "required: the table the index belongs to.",
    ),
  view_fields: z
    .array(z.string())
    .optional()
    .describe("VIEW/DV create only: base-table fields to project, in order."),
  index_fields: z
    .array(z.string())
    .optional()
    .describe("TABL/DI create only, required: base-table fields the index covers, in order."),
  index_unique: z
    .boolean()
    .optional()
    .describe(
      "TABL/DI create only: mark the index UNIQUE. Default false. On a client-dependent base " +
        "table, a unique index must include the table's client field (usually MANDT) in " +
        "`index_fields` — a create that omits it is refused rather than left to fail activation " +
        "on the server.",
    ),
  // "EXISTING" and "SUBMIT-only" are load-bearing: abapsmith checks the
  // program exists first, and RPY_TRANSACTION_INSERT only wires a
  // report/SUBMIT transaction, never a dialog one.
  program: z
    .string()
    .optional()
    .describe("TRAN/T kind=report|dialog: existing program."),
  kind: z
    .enum(["report", "dialog", "parameter", "variant", "oo"])
    .optional()
    .describe(
      "TRAN/T create. report (default): program, dynpro 1000. dialog: program + screen. " +
        "parameter: target_transaction + parameters (+ skip_first_screen). variant: " +
        "target_transaction + variant. oo: class + method (+ update_mode), stored as an " +
        "OS_APPLICATION transaction-model transaction.",
    ),
  screen: z.string().optional().describe("TRAN/T kind=dialog: 4-digit screen of program."),
  target_transaction: z
    .string()
    .optional()
    .describe("TRAN/T kind=parameter|variant: existing transaction to call."),
  skip_first_screen: z
    .boolean()
    .optional()
    .describe(
      "TRAN/T kind=parameter: skip the called transaction's first screen. Default false.",
    ),
  parameters: z
    .array(z.object({ field: z.string(), value: z.string() }).strict())
    .optional()
    .describe(
      'TRAN/T kind=parameter: screen-field values, e.g. [{field:"VIEWNAME",value:"V_T001"},' +
        '{field:"UPDATE",value:"X"}].',
    ),
  variant: z
    .string()
    .optional()
    .describe("TRAN/T kind=variant: transaction variant (SHD0) of target_transaction."),
  cross_client_variant: z
    .boolean()
    .optional()
    .describe("TRAN/T kind=variant: variant is cross-client. Default false."),
  class: z.string().optional().describe("TRAN/T kind=oo: global class."),
  update_mode: z
    .enum(["S", "A", "L"])
    .optional()
    .describe("TRAN/T kind=oo: S synchronous (default), A asynchronous, L local update."),
  confirm_in_use: z
    .boolean()
    .optional()
    .describe(
      "SHLP/DH delete only: required true when the search help is still attached to a data " +
        "element, a table/view field, or included by a collective search help (DD04L/DD35L/" +
        "DD31S). Refused zero-network for any other type/mode combination.",
    ),
  confirm_maintenance_dialog: z
    .boolean()
    .optional()
    .describe(
      "VIEW/DV delete: overrides the bridge's refusal when the view still has a generated " +
        "SE54 maintenance dialog (TVDIR), which the delete leaves broken; the refusal names the " +
        "dialog. Refused zero-network for any other type/mode combination.",
    ),
  confirm_in_role_menu: z
    .boolean()
    .optional()
    .describe(
      "TRAN/T mode=\"delete\" or mode=\"update\" (retarget): overrides the bridge's refusal " +
        "when the tcode is assigned to role menus (AGR_TCODES) — deleting removes it from them, " +
        "retargeting changes what they launch; the refusal names the roles. An SM01 lock is not " +
        "checked. Refused zero-network for any other type/mode combination.",
    ),
  // Same shape/wording as abap_enh's `affects` field (src/tools/enh.ts), so
  // callers share one vocabulary. Required for an enhancement-type write
  // (ENHO/XHH): the gate can't judge one from name/package/URI alone.
  affects: z
    .object({
      name: z.string().describe("Object this enhancement binds to."),
      packageName: z.string().describe("Its package."),
      // Absent masterSystem is treated as LOCAL and never refused, same for a
      // value equal to this server's own SID; only a genuinely foreign SID is
      // judged against ABAP_ENHANCE_TARGETS/ABAP_ORIGIN_SYSTEMS. That policy
      // lives in the refusal (safety.ts), not here — same trim as abap_debug's
      // `force` (test/tools.test.ts).
      masterSystem: z.string().optional().describe("Its masterSystem. Omit for local/$TMP."),
      spotName: z.string().optional().describe("Enhancement spot, if reached via one."),
    })
    .optional()
    .describe("REQUIRED for enhancement types (ENHO/XHH)."),
  // Batch delete only — the ONLY batch form `abap_write` accepts (no batch
  // create/edit; write is naturally one-object-at-a-time). Mirrors
  // `abap_activate`'s `objects` shape, but UNLIKE activation there is no
  // server-side batch-delete endpoint: `abapWriteBatchDelete` is a
  // client-side loop of the normal lock→DELETE→unlock per object, saving
  // model turns, not requests or server load.
  //
  // Exactly one of `object`/`objects`, never both. `mode: "delete"` must be
  // given explicitly (write's default mode is "write", unlike activate's).
  // Deleted IN THE ORDER GIVEN — abapsmith does not compute dependency order,
  // so the caller must list dependents before dependencies.
  //
  // The whole set is validated first (resolves, deletable, gated, no dupes)
  // and the batch is refused entirely if any entry fails — except an entry
  // that does not exist, which is reported per-entry as already-absent
  // instead of aborting the batch. Once deletion starts, one failure does
  // not stop the rest — every object is deleted and
  // journalled (with its own before-image) individually before the next is
  // attempted, so a batch that dies halfway leaves an accurate per-object
  // record for `abap_journal mode=undo`. That per-object continuation
  // is execution only — the RETURNED envelope throws CHECK_FAILED (isError)
  // if even one object was not deleted, so a caller keying on `isError` is
  // never told a delete happened when it did not.
  objects: z
    .array(
      z.object({
        object: z.string().describe("Object to delete. Same spelling `object` accepts."),
        type: z.string().optional().describe("ADT type, if the name alone is ambiguous."),
        affects: deleteEntryAffectsSchema
          .optional()
          .describe("REQUIRED for this entry if it names an enhancement type (ENHO/XHH)."),
      }),
    )
    .min(1)
    .max(MAX_DELETE_BATCH)
    .optional()
    .describe(`Batch delete ≤${MAX_DELETE_BATCH}; mode=delete, replaces \`object\`.`),
};

export const WriteInput = z.object(writeInputSchema);
export type WriteInput = z.infer<typeof WriteInput>;

/**
 * Parses `object`/`type` into a `WriteTarget`, hinting the parse the same way
 * `resolveWriteTarget` hints its own and passing `containerName` explicitly
 * rather than relying on it surviving a round trip through a string —
 * dropping the parent used to break `FUGR/FF`-style container types; see
 * the git history for the incident.
 *
 * Exported for `test/write.test.ts` only: a pure function of input + type
 * registry, needing no connection, fake or route table to pin.
 */
export function targetFromInput(input: WriteInput & { object: string }): WriteTarget {
  const hint = input.type ? (specForType(input.type) ?? specForKeyword(input.type)) : undefined;
  const parsed = parseObjectRef(input.object, hint);
  const target: WriteTarget = { name: parsed.name };
  if (parsed.parent) target.containerName = parsed.parent;
  const type = input.type ?? parsed.spec?.type;
  if (type) target.type = type;
  if (input.package) target.packageName = input.package;
  if (input.description) target.description = input.description;
  if (input.affects) target.affects = input.affects;
  // The one hop from tool input to `WriteTarget`; everything downstream reads
  // `include` from the target, never from `input`. Passed through AS GIVEN,
  // including an explicit `"main"` — `ResolvedTarget.include` distinguishes
  // "caller said nothing" (undefined) from "caller asked for main".
  if (input.include) target.include = input.include;
  return target;
}

/**
 * Turns `input.ddic` into the same `source` string a caller
 * would otherwise have to hand-compose, via {@link buildStructuredDdicDescriptor}
 * — called BEFORE the normal source-resolution branch below, so the result
 * flows through {@link assertDdicDescriptorShape} downstream exactly like any
 * other `source`, with no separate validation path.
 */
export interface DdicStructuredSource {
  source: string;
  /** Set when `description` was empty/absent and defaulted to the object's own name (issue #209). */
  descriptionDefaultedTo?: string;
}

export function resolveDdicStructuredSource(input: WriteInputV2, target: WriteTarget): DdicStructuredSource {
  // An empty `source` is treated as absent: clients that always send the
  // field (`source: ""` next to `ddic`) are not asking for two descriptors.
  if (input.source !== undefined && input.source !== "") {
    throw new AbapError(
      "BAD_INPUT",
      "`source` and `ddic` cannot both be given — they are two ways to build the same descriptor.",
      { name: target.name, type: target.type },
      "Drop one: `ddic` for a structured create of DOMA/DD, DTEL/DE, or TTYP/DA, or `source` for " +
        "hand-composed XML (any type, including these three).",
    );
  }
  if (!target.type) {
    throw new AbapError(
      "BAD_INPUT",
      "`ddic` requires `type` to be given explicitly (DOMA/DD, DTEL/DE, or TTYP/DA).",
      { name: target.name },
      "Add `type`, or drop `ddic` and pass hand-composed XML via `source`.",
    );
  }
  const explicit = target.description?.trim();
  // Issue #209: an absent description defaults to the object's own name rather than
  // being refused.
  const description = explicit || target.name.toUpperCase();
  const packageName = target.packageName?.trim() || "$TMP";
  return {
    source: buildStructuredDdicDescriptor(target.type, target.name, description, packageName, input.ddic!),
    ...(explicit ? {} : { descriptionDefaultedTo: description }),
  };
}

/** `abap_write`'s `edit` form. */
export interface WriteEdit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * `edit`/`method` are now declared directly in `writeInputSchema`, so
 * `WriteInput` already carries them. This is kept as an ALIAS (not a
 * hand-widened `extends`) so there remains exactly ONE list of fields
 * `abap_write` accepts — the schema — and the core can no longer read a
 * field the schema doesn't declare (see the `edit` field comment above for
 * the incident this fixed).
 */
export type WriteInputV2 = WriteInput;
