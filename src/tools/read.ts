/**
 * `abap_read` — reads ABAP objects as source or rendered pseudo-DDL.
 *
 * Axes (composable, each opt-in beyond the default source/ddic read):
 *  - mode: source (CLAS·INTF·PROG·FUGR·DDLS·DDLX·BDEF·SRVD·XSLT) or
 *    ddic (TABL·TABL/DS·DTEL·DOMA·TTYP → pseudo-DDL, never raw XML).
 *  - `enhancements=true`: decode ENHO/XH, ENHO/XHH, ENHS via
 *    `../adt/enhancement.ts` instead of the source/ddic paths.
 *  - `view`: asks about something OTHER than the object's current
 *    definition, at three unrelated axes. "history" lists the ADT version
 *    feed; "diff" returns unified-diff hunks between two versions, never two
 *    full sources — see `../adt/revisions.ts` and `../diff.ts`. "definition"
 *    is position-driven, not version-driven: given `line`/`column` in the
 *    CURRENT source, it answers "what is this identifier", "where is it
 *    declared" and, for an interface method, "who implements it" — see
 *    `../adt/element-info.ts` and {@link readDefinition}. Because the three
 *    sit on different axes, most cross-combinations are refused outright
 *    (see {@link assertViewCompatible}) rather than answering a different
 *    question than the one asked.
 *  - `include`: ADT stores each of a class's five sections
 *    (main/definitions/implementations/macros/testclasses) as its own
 *    document; applies to the source read and `view` alike — see
 *    `sourceUriFor` (`../adt/source.ts`) and {@link assertIncludeCompatible}.
 *    Meaningful only for CLAS/OC: on every other type it is a no-op (the
 *    object has a single source document already), disclosed with a note
 *    rather than refused — see {@link includeIgnoredNote}.
 *
 * Every response carries a content-hash `etag` and goes through the shared
 * compactor, except the `view` paths (see {@link NO_ETAG}).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AbapConnection } from "../adt/connection.js";
import { fetchDdicXml, readDdic, type DdicRender } from "../adt/ddic.js";
import { capabilitiesFor, NON_READABLE_TYPES, PROPERTIES_SHAPE_TYPES } from "../adt/capabilities.js";
import { AbapError } from "../adt/errors.js";
import { readAuthorizationObject, renderAuthorizationObject, SUSO_WHERE_USED_NOTE } from "../adt/suso-read.js";
import { readSecondaryIndex, readTableIndexes, renderSecondaryIndex, renderSecondaryIndexList } from "../adt/index-read.js";
import {
  readBadiImplementation,
  readEnhancementSpot,
  readSourceCodePlugin,
} from "../adt/enhancement.js";
import type {
  BadiImplementationRead,
  EnhancementSpotRead,
  EnhObjectRef,
  FilterTreeNode,
  SourceCodePluginRead,
} from "../adt/enhancement-xml.js";
import { resolveObject, type ResolvedObject } from "../adt/resolve.js";
import {
  NO_RELEASED_HISTORY_EXPLANATION,
  describeEntry,
  listRevisions,
  releasedVersions,
  resolveDiffPair,
  revisionSource,
} from "../adt/revisions.js";
import {
  fetchElementInfo,
  findDefinitionTarget,
  findImplementations,
  identifierAt,
  isUnresolved,
  type ElementInfoEntry,
  type SourcePosition,
} from "../adt/element-info.js";
import { CLASS_INCLUDES, assertClassInclude, type ClassInclude } from "../adt/types.js";
import { DEFAULT_CONTEXT_LINES, diffSources, renderHunks } from "../diff.js";
import {
  classMembers,
  classMembersFor,
  grepSource,
  inheritedMembers,
  readMethod,
  readSource,
  renderInheritedOutline,
  renderOutline,
  renderSourceStructure,
  scanSourceStructure,
} from "../adt/source.js";
import {
  buildResponse,
  countLines,
  markEtagPartial,
  sliceLines,
  textTable,
  type BuiltResponse,
  type ResponseParts,
} from "../compact.js";
import { canonicalEtag, parseProcessingType } from "../adt/write.js";
import { parseFixPointArithmetic } from "../adt/program-create.js";
import { readTextPool, type TextPool } from "../adt/text-pool.js";
import { buildLineage, LINEAGE_DEFAULT_DEPTH, LINEAGE_MAX_DEPTH, renderLineage } from "../adt/cds-lineage.js";
import { buildFootprint, FOOTPRINT_TYPES, renderFootprint } from "../adt/footprint.js";
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import type { SafetyGate } from "../safety.js";
import {
  resolveDocuTarget,
  imgDocuTarget,
  extractAbapDoc,
  DOCU_FLATTEN_NOTE,
  docuEmptyText,
  type DocuTarget,
} from "../adt/docu.js";
import {
  DIGEST_TYPES,
  isDigestType,
  scanDependencies,
  scanProgramInterface,
  scanFunctionSignature,
  scanCdsFields,
  countTestClasses,
  summarisePublicApi,
  buildDigestSections,
  DIGEST_MAX_ROWS_PER_SECTION,
  type DigestInput,
  type DigestPublicApi,
  type DigestHistoryEntry,
  type DigestTests,
} from "../adt/digest.js";
import { dispatch, dispatchDisabledError } from "../adt/fluid/dispatch.js";
import { fluidDisabledReason } from "../adt/fluid/enabled.js";
import { FLUID_PACKAGE } from "../adt/fluid/package.js";
import { coreTool, CORE_TOOL_ID, CORE_BODY_CLASS } from "../adt/fluid/builtin/core.js";
import type { LoadedFluidTool } from "../adt/fluid/manifest.js";
// Circular by design: `read-systems.ts` imports `buildReadResponse`,
// `includeNote`, `DIFF_MAX_HUNKS` and the `ReadInput`/`ReadSystemSide`
// types back from this file, so the two share rendering machinery without
// either re-declaring it. Safe because every use on both sides is inside a
// function body (`registerReadTools`'s handler here, `runCrossSystemDiff`
// there) — nothing at either module's top level touches the other's
// exports before both have finished loading.
import { runCrossSystemDiff } from "./read-systems.js";

/**
 * Issue #148: a CLAS/INTF/PROG/FUGR source read above EITHER bound answers
 * with the outline instead of the source unless the caller asked for a
 * part (method/include/offset/limit/pattern) or the whole (full=true,
 * outline=false). Measured on the standard objects the issue quotes: full
 * reads of 10K–31K chars paged over 2–3 calls before an agent had even
 * decided which method it wanted.
 */
export const OUTLINE_DEFAULT_LINES = 150;
export const OUTLINE_DEFAULT_CHARS = 8000;
/** `pattern=`: matching lines rendered before the cut is disclosed (limit= overrides). */
export const PATTERN_MAX_MATCHES = 50;
/** `pattern=`: unchanged lines around each match when `context` is omitted. */
export const PATTERN_DEFAULT_CONTEXT = 2;

export const readInputSchema = {
  object: z.string().describe('Name, "class X", "table Y", or ADT URI.'),
  type: z
    .string()
    .optional()
    .describe(
      "ADT type to disambiguate. DEVC/K: package listing (types/depth filter it). SUSO/B: renders the " +
        "object's DEFINITION (fields, permitted activities) from the catalog — NOT who holds it, no " +
        "AGR_*/UST* table is read. TABL/DI: <TABLE>/<INDEX> renders one index, bare <TABLE> lists them all. " +
        `Not readable: ${NON_READABLE_TYPES.join(" ")}.`,
    ),
  method: z.string().optional().describe("Only this method/component."),
  outline: z
    .boolean()
    .optional()
    .describe(
      `Component list with line ranges. Default for CLAS/INTF/PROG/FUGR above ${OUTLINE_DEFAULT_LINES} ` +
        `lines or ${OUTLINE_DEFAULT_CHARS} chars unless method/include/offset/limit/pattern/full is given.`,
    ),
  full: z.boolean().optional().describe("Whole source even above the default-outline threshold."),
  pattern: z
    .string()
    .optional()
    .describe(
      `Regex (case-insensitive): only matching lines, numbered, with \`context\` lines around each ` +
        `(like grep -n -C). Max ${PATTERN_MAX_MATCHES} matches unless limit= is given; offset= sets the first line scanned.`,
    ),
  offset: z
    .number()
    .int()
    .min(1)
    .max(999_999)
    .optional()
    // Short on purpose (~15k tool-surface budget) — the full frame
    // explanation is emitted in the RESPONSE hint instead.
    .describe("1-based first line (chars if format=raw)."),
  limit: z.number().int().min(1).max(999_999).optional().describe("Max lines (chars if format=raw)."),
  enhancements: z
    .boolean()
    .optional()
    .describe("BAdI/plug-in/enhancement-spot decode (ENHO/XH,XHH,ENHS), not source."),
  // G-08: closed enum so the SDK rejects a typo (e.g. "Active") before the
  // handler runs, instead of zod silently stripping it and falling through
  // to whatever ADT reports as current. Never silently normalise.
  version: z
    .enum(["active", "inactive"])
    .optional()
    .describe("Default: current (active or newest inactive)."),
  // Closes a gap: the properties-shape types write a full XML descriptor PUT,
  // but the default read only produced lossy pseudo-DDL (or UNSUPPORTED).
  // Gated by capabilitiesFor, not a type list — additive only.
  format: z
    .enum(["raw"])
    .optional()
    .describe(`raw: XML, not pseudo-DDL (${PROPERTIES_SHAPE_TYPES.join(" ")} only).`),
  // Enum for the same reason as version/format (G-08): reject a typo rather
  // than silently falling through to an ordinary source read. Named `view`,
  // not `mode` — `mode` is already a response header key and `ResolvedObject.mode`.
  view: z
    .enum(["history", "diff", "definition", "lineage", "footprint", "docu", "digest"])
    .optional()
    .describe(
      "history: versions. diff: hunks. definition: element at line/column. lineage: CDS sources " +
        "down to base tables. footprint: database writes and commits. docu: SAP documentation " +
        '(type="SIMG" + object=<abap_img activity id> for an IMG activity). digest: one-page ' +
        "overview. Omit for a normal read.",
    ),
  from: z.string().optional().describe('diff: older side — version, transport, or "active".'),
  to: z.string().optional().describe("diff: newer side, same forms as `from`."),
  context: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe(`Lines around each pattern match (default ${PATTERN_DEFAULT_CONTEXT}) or per diff hunk (default 3).`),
  // Same names/bounds/semantics as abap_quick_fix's line/column (quickfix.ts)
  // — deliberately, so a caller who has already learned one learns both.
  // No `.default(0)` on column: unlike quick-fix (which always needs a
  // position), a default here would make "column was omitted" and "column=0
  // was passed with no view" indistinguishable, and the refusal below needs
  // that distinction.
  line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-based source line. Required with view="definition"; refused otherwise.'),
  column: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('0-based column. Default 0. Only meaningful with view="definition"; refused otherwise.'),
  // C-6: ADT versions each class include (main/definitions/
  // implementations/macros/testclasses) as its own document, so silently
  // defaulting to `main` hides changes made in e.g. testclasses. Selectable
  // on both the source-read and `view` paths, always disclosed.
  include: z
    .enum(CLASS_INCLUDES)
    .optional()
    .describe(
      'CLAS/OC only: which class include to read ("testclasses"=Unit tests; default "main"). ' +
        "Ignored, with a note, for every other type.",
    ),
  types: z
    .array(z.string())
    .optional()
    .describe('DEVC/K only: filter package contents to these kind codes, e.g. ["CLAS","DDLS"].'),
  field: z.string().optional().describe('view="lineage" only: trace one field back to its base columns.'),
  // The upper bound used to live in this schema as `.max(3)`, back when DEVC/K
  // was the only consumer of `depth`. Now two unrelated things share the
  // parameter — a DEVC/K package listing (max 3) and view="lineage" (max
  // LINEAGE_MAX_DEPTH, 10) — and zod has no way to make the max conditional
  // on another field, so the bound moved from the schema into code: each
  // consumer refuses a value above ITS OWN maximum, naming that maximum, via
  // AbapError("BAD_INPUT", …) rather than a zod validation error (G-08:
  // refused, never silently clamped). See the DEVC/K check in `abapRead` and
  // the lineage check in `readLineage` below — both still refuse out-of-range
  // input, just with a structured error instead of a schema rejection.
  depth: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'DEVC/K: subpackage nesting depth, default 1, max 3. view="lineage": levels of underlying views, ' +
        "default 5, max 10.",
    ),
};

export const ReadInput = z.object(readInputSchema);
export type ReadInput = z.infer<typeof ReadInput>;

/**
 * Cross-system `view="diff"` parameters (issue #93) — deliberately kept OUT
 * of `readInputSchema` itself and spliced in by `registerReadTools` only
 * when `deps.multiSystem` is true, so a single-system server's schema
 * bytes stay exactly as they were: these two fields would be dead weight
 * (nothing to name) when there is only one configured system.
 */
export const crossSystemInputSchema = {
  from_system: z
    .string()
    .optional()
    .describe('view="diff": compare the object as it is on this system. Defaults to the called system.'),
  to_system: z
    .string()
    .optional()
    .describe(
      'view="diff": the other side of a cross-system comparison, e.g. ' +
        '{"object":"ZCL_FOO","view":"diff","to_system":"QAS"}.',
    ),
};

/**
 * Kinds for which `outline=true` can actually produce a component list. ADT
 * serves `/objectstructure` components for object-oriented containers only —
 * a different fact from "has no components".
 */
export const OUTLINE_KINDS = new Set(["CLAS", "INTF"]);

/**
 * Kinds that get the outline BY DEFAULT above `OUTLINE_DEFAULT_LINES`/
 * `OUTLINE_DEFAULT_CHARS` (issue #148). CLAS/INTF use the ADT component
 * structure; PROG/FUGR have none, so they get `scanSourceStructure`'s
 * statement table of contents instead — disclosed as a text scan.
 */
const DEFAULT_OUTLINE_KINDS = new Set(["CLAS", "INTF", "PROG", "FUGR"]);

/**
 * `ResolvedObject.kind` values the enhancement decoders
 * (`src/adt/enhancement.ts`/`enhancement-xml.ts`) can render. `ENHO/XHH`
 * already reads as ordinary source; `enhancements=true` upgrades it to "raw
 * ABAP plus hook/usage metadata". `ENHO/XH` and `ENHS` have no source at all
 * (structured XML only) — without this flag they hit `readDdic`'s
 * UNSUPPORTED default, deliberately (see `src/adt/types.ts`).
 */
const ENHANCEMENT_KINDS = new Set(["ENHO/XH", "ENHO/XHH", "ENHS"]);

/** `type` + `name`, in the compact form the other renderers already use. */
function renderRef(ref: EnhObjectRef | undefined): string {
  if (!ref?.name) return "(none)";
  return ref.type ? `${ref.type} ${ref.name}` : ref.name;
}

/**
 * Renders a filter-tree node as nested `AND(...)`/`OR(...)`/leaf text.
 * `filterTree` is DERIVED/read-only (see `enhancement-xml.ts`'s module
 * header), display-only. Sibling ordering at one tree level is UNVERIFIED
 * (fast-xml-parser groups children by tag name, not document order) — see
 * `renderBadiImplementation` below for the caller-side note about that.
 */
function renderFilterTree(node: FilterTreeNode, indent: string): string {
  if (node.kind === "filter") {
    const c = node.condition;
    const range = c.value2 ? ` .. ${c.comparator2 ?? ""} ${c.value2}` : "";
    return `${indent}${c.filterName ?? "?"} ${c.comparator1 ?? "="} ${c.value1 ?? ""}${range}`;
  }
  const children = node.children.map((child) => renderFilterTree(child, indent + "  ")).join("\n");
  return `${indent}${node.kind.toUpperCase()}(\n${children}\n${indent})`;
}

/**
 * `enhoxh` — BAdI implementation(s). Prints `implementingClass` pre-formatted
 * for pasting into `abap_debug`'s breakpoint `object` field.
 */
function renderBadiImplementation(data: BadiImplementationRead): { body: string; notes: string[] } {
  const notes: string[] = [];
  // enho:isActive (runtime dispatch, per implementation) and adtcore:version
  // (this document's own design-time activation) are independent switches —
  // warn loudly when they disagree (field-evidenced: L17/ZTM_HW011B_IMPL).
  if (data.activationStatus === "inactive" && data.implementations.some((impl) => impl.isActive === true)) {
    notes.push(
      "DESIGN-TIME VERSION IS INACTIVE (adtcore:version, see activationStatus above) even though at " +
        "least one implementation below has isActive=true. These are independent switches — isActive is " +
        "only the runtime dispatch flag, not repository activation — and this object will not dispatch " +
        `reliably until adtcore:version is also active. Activate it directly, e.g. ` +
        `abap_activate(object:"${data.name}", type:"ENHO/XH").`,
    );
  }
  if (data.implementations.length > 1) {
    notes.push(
      "This document carries more than one <badiImplementation> element. Every capture T1 " +
        "was built against showed exactly one — multiplicity above 1 is UNVERIFIED shape here.",
    );
  }
  let sawFilterTree = false;
  const blocks = data.implementations.map((impl) => {
    if (impl.filterTree) sawFilterTree = true;
    const classLine = impl.implementingClass?.name
      ? `  implementing class: ${impl.implementingClass.name}` +
        `  -> paste into abap_debug as object: "class ${impl.implementingClass.name}"`
      : "  implementing class: (none)";
    return [
      `IMPLEMENTATION: ${impl.name}`,
      impl.shortText ? `  short text: ${impl.shortText}` : undefined,
      `  active: ${impl.isActive ? "yes" : "no"}  default: ${impl.isDefault ? "yes" : "no"}  ` +
        `customizing: ${impl.isCustomizingSupported ? "yes" : "no"}`,
      impl.enhancementSpot ? `  enhancement spot: ${renderRef(impl.enhancementSpot)}` : undefined,
      impl.badiDefinition ? `  BAdI definition: ${renderRef(impl.badiDefinition)}` : undefined,
      classLine,
      impl.filterTree ? `  filter tree:\n${renderFilterTree(impl.filterTree, "    ")}` : undefined,
    ]
      .filter((l): l is string => l !== undefined)
      .join("\n");
  });
  if (sawFilterTree) {
    notes.push(
      "filter tree: DERIVED for display, not a write target (see enhancement-xml.ts). Its " +
        "grammar was inferred from a single sample — whether a level can mix and/or/filter " +
        "siblings, and this decoder's ordering of them if so, is UNVERIFIED.",
    );
  }
  const implClassNames = [
    ...new Set(
      data.implementations.map((impl) => impl.implementingClass?.name).filter((n): n is string => !!n),
    ),
  ];
  if (implClassNames.length > 0) {
    notes.push(
      `implementing class ${implClassNames.length > 1 ? "names" : "name"} above (${implClassNames.join(", ")}) ` +
        `${implClassNames.length > 1 ? "are" : "is"} what this enhancement document records — abapsmith has ` +
        "not verified the class exists. A BAdI implementation can name a class that was never created. " +
        'abap_read(object:"<name>", type:"CLAS/OC") settles it.',
    );
  }
  return {
    body: blocks.join("\n\n") || "(this document has no <badiImplementation> elements)",
    notes,
  };
}

/** `enhoxhh` — source-code plug-in. Structured metadata alongside the raw
 *  ABAP the normal `mode: "source"` path already serves for this type. */
function renderSourceCodePlugin(data: SourceCodePluginRead): { body: string; notes: string[] } {
  const notes: string[] = [];
  if (data.switchState) {
    notes.push(
      `Switch-BC-Set gate present (state="${data.switchState}"` +
        `${data.switchReference ? `, ${renderRef(data.switchReference)}` : ""}). This field was ` +
        'observed on exactly one capture — whether "off" is the only possible state, or whether ' +
        "the reference can be absent while the switch is present, is UNVERIFIED.",
    );
  }
  const usageRows = data.usages.length
    ? textTable(
        data.usages.map((u) => ({
          programId: u.programId ?? "",
          usage: u.elementUsage ?? "",
          object: renderRef(u.objectReference),
        })),
        ["programId", "usage", "object"],
      )
    : "(none)";
  const hookBlocks = data.hookImplementations.map((h) =>
    [
      `HOOK: ${h.id ?? "(no id)"}`,
      h.spotName ? `  spot: ${h.spotName}` : undefined,
      h.programName ? `  program: ${h.programName}` : undefined,
      h.method ? `  method: ${h.method}` : undefined,
      h.overwrite ? `  overwrite: ${h.overwrite}` : undefined,
      // Only `full_name` has been observed on the wire; `fullname` is untested.
      h.fullName ? `  anchor: ${h.fullName}` : undefined,
      h.enclosureUri ? `  enclosure: ${h.enclosureUri}` : undefined,
    ]
      .filter((l): l is string => l !== undefined)
      .join("\n"),
  );
  const body = [
    data.enhancedObject ? `enhanced object: ${renderRef(data.enhancedObject)}` : undefined,
    data.sourceUri ? `source: ${data.sourceUri}` : undefined,
    "",
    "USAGES:",
    usageRows,
    "",
    "HOOK IMPLEMENTATIONS:",
    hookBlocks.join("\n\n") || "(none)",
  ]
    .filter((l): l is string => l !== undefined)
    .join("\n");
  return { body, notes };
}

/**
 * `enhsxs` — enhancement spot. Only the BADI_DEF-flavoured shape is
 * verified; a hook-flavoured spot document was never captured (500'd) — see
 * enhancement-xml.ts's module header. No isActive-disagreement note like
 * {@link renderBadiImplementation}: a BAdI DEFINITION has no per-entry
 * runtime-dispatch flag to disagree with — confirmed against fixture
 * 403-enhsxs-with-filters.xml, whose `<enhs:badiDefinition>`/`<enhs:filter>`
 * carry only structural attributes, nothing runtime-flavoured.
 */
function renderEnhancementSpot(data: EnhancementSpotRead): { body: string; notes: string[] } {
  const notes: string[] = [];
  if (data.badiDefinitions.length === 0) {
    notes.push(
      "No <badiDefinition> element in this document. This may be a genuinely empty spot, OR a " +
        "hook-flavoured spot — this decoder's handling of a hook-flavoured enhsxs document is " +
        "UNVERIFIED (the one live attempt returned HTTP 500, not 200).",
    );
  }
  const blocks = data.badiDefinitions.map((def) => {
    const filterRows = def.filters.length
      ? textTable(
          def.filters.map((f) => ({
            name: f.filterName ?? "",
            type: f.filterType ?? "",
            text: f.shorttext ?? "",
          })),
          ["name", "type", "text"],
        )
          .split("\n")
          .map((l) => "    " + l)
          .join("\n")
      : "    (none declared)";
    return [
      `BADI DEFINITION: ${def.name}`,
      def.shorttext ? `  short text: ${def.shorttext}` : undefined,
      `  single use: ${def.singleUse ? "yes" : "no"}  fallback class: ${def.useFallbackClass ? "yes" : "no"}  ` +
        `filter limitation: ${def.filterLimitation ? "yes" : "no"}`,
      def.interfaceRef ? `  interface: ${renderRef(def.interfaceRef)}` : undefined,
      "  filters:",
      filterRows,
    ]
      .filter((l): l is string => l !== undefined)
      .join("\n");
  });
  return {
    body: blocks.join("\n\n") || "(this document has no <badiDefinition> elements)",
    notes,
  };
}

/**
 * The one function that turns bytes into the etag `abap_read` hands out.
 *
 * Every read path must feed this the resource's OWN canonical bytes (what a
 * fresh GET of the object's content returns), never a derived rendering —
 * computing per-rendering hashes previously produced different etags for the
 * same unchanged object 6/6 times and made `abap_write` loop on
 * ETAG_CONFLICT with no exit. See the git history for
 * the measured repro.
 *
 * Delegates to `canonicalEtag` (adt/write.ts) — the same function
 * `assertEtagMatches` hashes current server content with, so an etag
 * produced here is the PRIMARY value that comparison accepts.
 */
function resourceEtag(canonicalBytes: string): string {
  return canonicalEtag(canonicalBytes);
}

/**
 * Shared response assembly for every `DdicRender`-shaped read: the DDIC
 * pseudo-DDL branch below, and the two catalog-table renders (SUSO/B,
 * TABL/DI in `abapRead`'s dispatch, before `resolveObject` ever runs) —
 * all three produce the same {ddl, sections, meta, notes, hashInput,
 * bodyLabel?} shape, so they share this instead of three copies of the same
 * etag/windowing/response-building sequence.
 *
 * `header` is everything the caller wants ABOVE `rendered.meta`/`etag`/
 * `totalLines` — those three are always appended last, in that order, so
 * every DdicRender-shaped response has the same tail regardless of caller.
 */
function buildDdicLikeResponse(
  rendered: DdicRender,
  header: Record<string, string | number | undefined>,
  offset: number | undefined,
  limit: number | undefined,
  hints: string[],
  maxChars: number,
): BuiltResponse & { etag: string } {
  const etag = resourceEtag(rendered.hashInput);
  const window = sliceLines(rendered.ddl, offset ?? 1, limit);
  const built = buildReadResponse({
    header: { ...header, ...rendered.meta, etag, totalLines: window.total },
    sections: rendered.sections,
    body: window.text,
    bodyLabel: rendered.bodyLabel ?? "PSEUDO-DDL",
    bodyOffset: window.offset,
    bodyTotalLines: window.total,
    notes: rendered.notes,
    hints,
    pagingParam: "offset",
    maxChars,
  });
  return { ...built, etag };
}

/**
 * The one sentence a truncated source read has to put where the caller cannot
 * miss it — emitted as a `notes` entry, rendered ABOVE the source, so an
 * agent that extracts the source by parsing the `--- SOURCE ---` fence does
 * not strip the truncation warning along with it.
 */
const TRUNCATED_SOURCE_NOTE =
  "INCOMPLETE — NOT the whole text (counts in TRUNCATED, below). The etag is marked `partial:`: " +
  "abap_write REFUSES a full-source rewrite presenting it, since that would delete everything " +
  "past the cut. Splice with edit={old_string,new_string}, or page it all in with offset/limit.";

/**
 * buildResponse emits no `--- SOURCE ---` block for an empty body — say so, or
 * an empty object reads as a failed/truncated one.
 */
const EMPTY_SOURCE_NOTE =
  "Source is empty (0 bytes) — that is the whole body, not a truncated read; there is no SOURCE " +
  "section below because there is nothing to show.";

/**
 * Builds a response over (part of) the object's writable text; if the body
 * came out incomplete, rebuilds it with the incompleteness stated up top and
 * the etag marked `partial:` — an unmarked truncated read
 * followed by a full-source write silently deletes the object's tail. The
 * hash still covers the FULL server source (see `PARTIAL_ETAG_PREFIX` in
 * compact.ts, changing that would break the concurrency guarantee) — this
 * only adds back the "incomplete" fact the read path already had.
 *
 * Two passes because truncation is only known after `buildResponse` runs but
 * the etag lives in the header it consumes; re-rendering (not string-patching)
 * keeps `hardClamp`'s cap intact and can't loop — a longer header/notes block
 * only ever stays truncated. `forceIncomplete` is for the format:"raw" path,
 * which windows by CHARACTERS before `buildResponse` ever sees the body.
 */
/** Compact `TEXT POOL` section body (issue #182) — omits an empty group entirely. */
function renderTextPool(pool: TextPool): string {
  const parts: string[] = [];
  const symbolKeys = Object.keys(pool.symbols);
  if (symbolKeys.length > 0) {
    parts.push("symbols:");
    for (const key of symbolKeys) parts.push(`  ${key}  ${pool.symbols[key]}`);
  }
  const selectionNames = Object.keys(pool.selectionTexts);
  if (selectionNames.length > 0) {
    parts.push("selection_texts:");
    for (const name of selectionNames) parts.push(`  ${name}  ${pool.selectionTexts[name]}`);
  }
  return parts.join("\n");
}

function buildSourceResponse(
  parts: ResponseParts,
  etag: string,
  forceIncomplete = false,
): BuiltResponse & { etag: string } {
  const first = buildReadResponse(parts);
  if (!first.truncated && !forceIncomplete) return { ...first, etag };
  const partialEtag = markEtagPartial(etag);
  // Plain buildResponse, not buildReadResponse: this branch is BY DEFINITION
  // the truncated case (that's what put us here), and buildReadResponse's
  // whole job is deciding whether to add a header line to a response that
  // turned out complete. Running it here would cost a wasted extra
  // buildResponse call for a header line the TRUNCATED_SOURCE_NOTE/WINDOW
  // notice below already makes redundant (see buildReadResponse).
  const second = buildResponse({
    ...parts,
    header: { ...parts.header, etag: partialEtag },
    notes: [TRUNCATED_SOURCE_NOTE, ...(parts.notes ?? [])],
    size: true,
  });
  return { ...second, truncated: true, etag: partialEtag };
}

/**
 * The counters `structuredContent` used to carry before it was removed —
 * truncated/hasMore/returnedLines/totalLines/estimatedTokens — rendered as
 * one extra header line inside the SAME budgeted render `buildResponse`
 * already produces, so `hardClamp`'s `text.length <= maxChars` guarantee
 * still holds: the facts are added BEFORE the cap is applied, never
 * appended after.
 *
 * Two-pass, like `buildSourceResponse` above and for the same reason:
 * whether the extra header line itself pushes the response over budget is
 * only knowable after a `buildResponse` call, and that call needs the
 * header to exist first. Only the COMPLETE case gets the second pass — an
 * incomplete response already states all five facts explicitly, in the
 * `--- WINDOW ---`/`--- TRUNCATED ---` notice `buildResponse` emits
 * unconditionally (`notice()` in compact.ts: "Returned lines X..Y of N",
 * the cap, and "last chunk" or "offset=Z (K line(s) not shown)"). Rebuilding
 * a header from the first pass's counts in that case would also be WRONG,
 * not just redundant — a header line stealing budget from the body can
 * shrink the body further, and a second `buildResponse` call recomputes the
 * notice against the smaller body, so a header computed from the first
 * pass's line counts would contradict the second pass's true ones. So the
 * truncated path is returned untouched.
 *
 * `estimatedTokens` in the facts line is measured on `first` — i.e. BEFORE
 * this header line exists — because measuring it on the final text would be
 * self-referential (the line's own length changes the count it reports).
 * It is therefore short by roughly this line's own length (~100 chars, ~30
 * tokens), which is what the `~` prefix is there to admit — on top of
 * `estimateTokens` already being a `CHARS_PER_TOKEN` division, not a
 * tokenizer (compact.ts).
 *
 * `withFacts.truncated ? first : withFacts`: adding the facts line can only
 * ever leave the response exactly as complete as `first` or discard the
 * line entirely — never trade away body lines the caller didn't ask to
 * lose just to fit a header the caller didn't ask for.
 */
export function buildReadResponse(parts: ResponseParts): BuiltResponse {
  // `size: true` — every read answer states its own chars/lines/truncated
  // (issue #148), rendered inside the budget by compact.ts.
  const first = buildResponse({ ...parts, size: true });
  if (first.truncated) return first;
  const facts = [
    "truncated=false",
    ...(first.hasMore === undefined ? [] : [`hasMore=${first.hasMore}`]),
    ...(first.returnedLines === undefined ? [] : [`returnedLines=${first.returnedLines}`]),
    ...(first.totalLines === undefined ? [] : [`totalLines=${first.totalLines}`]),
    `estimatedTokens=~${first.estimatedTokens}`,
  ].join(" ");
  const withFacts = buildResponse({
    ...parts,
    header: { ...parts.header, response: `complete (${facts})` },
    size: true,
  });
  return withFacts.truncated ? first : withFacts;
}

/**
 * The exact XML descriptor at a properties-shape object's own URI — what
 * format:"raw" returns verbatim, and what write.ts's compare-before-write
 * fetches too (via `fetchDdicXml`), so both paths hash identical bytes (see
 * {@link resourceEtag}). Called only on the format:"raw" path — a default
 * DTEL/DOMA/TTYP read gets these bytes once already, inside `readDdic`.
 */
async function fetchRawDescriptor(conn: AbapConnection, obj: ResolvedObject): Promise<string> {
  // SRVB/SVB needs its exact vendor media type; every other properties-shape
  // type reads fine with the generic "application/*".
  return fetchDdicXml(conn, obj, "read raw XML descriptor", capabilitiesFor(obj.type)?.mediaType);
}

/**
 * Formats `adjustmentStatus` (ENHO/XH, ENHO/XHH only) for the response
 * header — previously invisible until a failed write surfaced it as a hint
 * (`hintAdjustmentStatusIfLikelyCause` in enhancement-write.ts).
 *
 * Shown even when `""` (fixture 354-enhoxh-no-filter.xml): unlike
 * `renderHeader`'s (compact.ts) usual drop-empty-fields rule, `""` here is
 * the actionable non-nominal state — enhancement-write.ts treats anything
 * but exactly "adjusted" as such — so it is rewritten to "(empty)" rather
 * than hidden. A genuinely absent value stays dropped like any other field.
 * ENHS is excluded: `EnhancementSpotRead` has no such field to reference.
 */
function renderAdjustmentStatus(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value === "" ? "(empty)" : value;
}

/**
 * Formats the enhancement document's OWN root adtcore:description — distinct
 * from the header's search-index-sourced `description` key
 * (`baseHeader.description`, from `obj.description`; see `finishFromSearch`
 * in resolve.ts). Only the document's own value
 * (`EnhCommonFields.description`, parsed by `parseCommon` in
 * enhancement-xml.ts) gates ENHANCEMENT_DESCRIPTION_REQUIRED
 * (enhancement-write.ts's `assertDescriptionWillBePresent`). The two sources
 * are read independently and can disagree; "not yet observed disagreeing" is
 * not "cannot disagree" — see the git history.
 *
 * Unlike {@link renderAdjustmentStatus}, absence is shown too: `undefined`
 * and `""` both render as "(empty)" — blank is the actionable state here,
 * the signal that the next write/activation will refuse.
 */
function renderEnhancementDescription(value: string | undefined): string {
  return value ? value : "(empty)";
}

/**
 * Loud note when the document's own description
 * ({@link renderEnhancementDescription}) is empty or absent — `abap_enh`'s
 * pre-lock guard (`assertDescriptionWillBePresent`, enhancement-write.ts)
 * refuses EVERY subsequent write against this object, including
 * `set_impl_active` and writes unrelated to the description, until it is set.
 */
function enhancementDescriptionRequiredNote(ctx: { type: string; name: string }): string {
  return (
    `${ctx.type} ${ctx.name}: this document's own root adtcore:description is empty. SAP's enhancement PUT ` +
    "handler refuses EVERY write or activation against this object until it is set — HTTP 400 " +
    'ExceptionInvalidData, SWB_TOOL19/scr_prop_no_decr, "The description is missing" (ENHANCEMENT_DESCRIPTION_REQUIRED) ' +
    "— including set_impl_active and any write that has nothing to do with the description itself " +
    "(enhancement-write.ts's assertDescriptionWillBePresent/putEnhancementDocument). Nothing is broken yet, " +
    `but the next write or abap_activate call on this object will refuse. Call abap_enh ` +
    `operation:"write_description" (name:"${ctx.name}", type:"${ctx.type}") to give it one.`
  );
}

/**
 * Dispatches to T1's three enhancement readers for `enhancements=true`.
 * Called only when `obj.kind` is already known to be in
 * {@link ENHANCEMENT_KINDS} — see the call site in {@link abapRead}.
 */
async function readEnhancementObject(
  conn: AbapConnection,
  obj: ResolvedObject,
  baseHeader: Record<string, string | number | undefined>,
  input: ReadInput,
  maxChars: number,
): Promise<BuiltResponse & { etag: string }> {
  let doc: { xml: string };
  let rendered: { body: string; notes: string[] };
  let extraHeader: Record<string, string | number | undefined>;
  let documentDescription: string | undefined;

  if (obj.kind === "ENHO/XH") {
    const d = await readBadiImplementation(conn, obj.name);
    doc = d;
    rendered = renderBadiImplementation(d.data);
    documentDescription = d.data.description;
    extraHeader = {
      toolType: d.data.toolType,
      activationStatus: d.data.activationStatus,
      masterSystem: d.data.masterSystem,
      responsible: d.data.responsible,
      adjustmentStatus: renderAdjustmentStatus(d.data.adjustmentStatus),
    };
  } else if (obj.kind === "ENHO/XHH") {
    const d = await readSourceCodePlugin(conn, obj.name);
    doc = d;
    rendered = renderSourceCodePlugin(d.data);
    documentDescription = d.data.description;
    extraHeader = {
      toolType: d.data.toolType,
      activationStatus: d.data.activationStatus,
      masterSystem: d.data.masterSystem,
      responsible: d.data.responsible,
      adjustmentStatus: renderAdjustmentStatus(d.data.adjustmentStatus),
    };
  } else {
    // ENHS spot documents are gated by the same PUT-side description
    // invariant as the other two (enh.ts:241, enhancement-write.ts) — no
    // evidence this branch needs different treatment.
    const d = await readEnhancementSpot(conn, obj.name);
    doc = d;
    rendered = renderEnhancementSpot(d.data);
    documentDescription = d.data.description;
    extraHeader = {
      toolType: d.data.toolType,
      activationStatus: d.data.activationStatus,
      masterSystem: d.data.masterSystem,
      responsible: d.data.responsible,
    };
  }

  // The document's own description is authoritative for writes/activations —
  // override baseHeader's search-index-sourced value under the same key.
  extraHeader.description = renderEnhancementDescription(documentDescription);
  if (obj.description && obj.description !== documentDescription) {
    // Sources disagree — surface the index value too, under a distinct key,
    // rather than silently discarding it.
    extraHeader.searchIndexDescription = obj.description;
    rendered.notes.push(
      `The ADT search index reports a different description ("${obj.description}", shown above as ` +
        'searchIndexDescription) than this document\'s own root adtcore:description (shown above as ' +
        "description). Only the document's own value governs writes and activations " +
        "(ENHANCEMENT_DESCRIPTION_REQUIRED) — the search index value is informational only, shown here so " +
        "it isn't silently dropped.",
    );
  }
  if (!documentDescription) {
    rendered.notes.push(enhancementDescriptionRequiredNote({ type: obj.type, name: obj.name }));
  }
  rendered.notes.push(...includeIgnoredNote(input, obj));

  const etag = resourceEtag(doc.xml);
  const window = sliceLines(rendered.body, input.offset ?? 1, input.limit);
  const built = buildReadResponse({
    header: { ...baseHeader, mode: "enhancement", etag, ...extraHeader, totalLines: window.total },
    body: window.text,
    bodyLabel: "ENHANCEMENT",
    bodyOffset: window.offset,
    bodyTotalLines: window.total,
    notes: rendered.notes,
    hints: [
      "For a BAdI implementation, paste \"implementing class\" straight into abap_debug's " +
        "breakpoint object field to set a breakpoint there.",
    ],
    pagingParam: "offset",
    maxChars,
  });
  return { ...built, etag };
}

/**
 * The etag a `view` response carries: none. A history listing isn't the
 * resource and a diff is a rendering of two OLD versions — hashing either
 * would mint a token that looks like a write credential (for `abap_write`)
 * and isn't one. Callers that want a write token re-read without `view`.
 */
const NO_ETAG = "";

/**
 * The fluid tool map `docu`'s `dispatch()` call needs — mirrors
 * `SCAN_TOOLS` in `source-scan.ts`, but built from `core.ts`'s
 * already-fully-assembled `coreTool` rather than re-assembling one, since
 * `core.ts` exports one ready to use.
 */
const CORE_TOOLS: ReadonlyMap<string, LoadedFluidTool> = new Map([[CORE_TOOL_ID, coreTool]]);

/**
 * Hunk ceiling for one diff response. Excess is reported, never dropped
 * silently. Exported so `read-systems.ts`'s cross-system diff shares the
 * exact same ceiling as the same-system `readDiff` below, rather than
 * re-declaring a second number that could drift from it.
 */
export const DIFF_MAX_HUNKS = 200;

/**
 * DEVC/K's own maximum for `depth` — used to live as zod's `.max(3)` on the
 * shared `depth` schema field; moved into code because `depth` now also
 * bounds view="lineage" (max `LINEAGE_MAX_DEPTH`, imported from
 * `../adt/cds-lineage.js`), a different maximum for a different consumer.
 * `src/adt/ddic.ts` enforces the identical bound independently as
 * `MAX_PACKAGE_DEPTH` (not exported) once `readDdic` actually walks the
 * package tree; this constant is read.ts's OWN copy, checked before that
 * call, so the parameter-boundary refusal for this file's callers lives in
 * this file rather than one call deep in an adt module. Keep the two values
 * in sync if either changes.
 */
const DEVC_MAX_DEPTH = 3;

/**
 * Rejects parameter combinations that `view` cannot honour, rather than
 * answering a different question than the one asked. Same rule as the `version`
 * and `format` refusals below (G-08): never silently normalise.
 */
function assertViewCompatible(input: ReadInput, obj: ResolvedObject): void {
  const clash = (param: string, why: string, hint: string): never => {
    throw new AbapError(
      "UNSUPPORTED",
      `${param} cannot be combined with view="${input.view}" for ${obj.type} ${obj.name}: ${why}`,
      { type: obj.type, name: obj.name, view: input.view, param },
      hint,
    );
  };
  // "definition" sits on a different axis from "history"/"diff" (position in
  // the CURRENT source vs. a version feed), so most of the clashes below
  // need one message for the version-feed views and a different, honest one
  // for definition — never the same wording stretched to cover both.
  // "lineage" and "footprint" are two MORE axes again (a tree over OTHER
  // objects; a whole-object write scan), each needing its own honest reason
  // rather than inheriting the history/diff or definition wording. "docu"
  // and "digest" are two further axes again (a documentation object has no
  // version feed, no position axis and no XML descriptor; a digest is a
  // fixed six-section overview, not a source read), so each of those needs
  // its own wording too — never the same sentence stretched to cover all
  // of them.
  const isDefinition = input.view === "definition";
  const isLineage = input.view === "lineage";
  const isFootprint = input.view === "footprint";
  const isDocu = input.view === "docu";
  const isDigest = input.view === "digest";

  if (input.format) {
    clash(
      'format="raw"',
      isDefinition
        ? "raw returns the XML descriptor of a properties-shape type; there is no source text to " +
          "resolve a line/column position in."
        : isLineage
          ? "raw returns the current XML descriptor of ONE object; lineage renders a dependency tree " +
            "parsed from CDS DDL source text across many objects — there is no single XML descriptor " +
            "that answers it."
          : isFootprint
            ? "raw returns the current XML descriptor of ONE object; footprint renders a scan of ABAP " +
              "source text for write statements — there is no XML descriptor that answers it."
            : isDocu
              ? "docu reads SAP's own documentation store (DOKHL/DOKTL), not this object's own wire " +
                "document — there is no XML descriptor of a documentation object to return."
              : isDigest
                ? "a digest is a rendered six-section overview built from several separate reads, not " +
                  "this object's own current XML descriptor."
                : "raw returns the current XML descriptor, which has no version feed behind it.",
      isDefinition
        ? "Drop format — a definition lookup only makes sense against source text."
        : isLineage || isFootprint
          ? `Drop format — view="${input.view}" produces its own rendering, not the wire document.`
          : isDocu || isDigest
            ? "Drop format, or drop view."
            : "Drop one of the two: view for history/diff, format for the current wire document.",
    );
  }
  if (input.enhancements) {
    clash(
      "enhancements=true",
      isDefinition
        ? "the enhancement decoders read a structured ENHO/ENHS document, not the source text a " +
          "position lookup resolves against."
        : isLineage
          ? "the enhancement decoders read a structured ENHO/ENHS document; lineage reads CDS DDL " +
            "source, a different document entirely."
          : isFootprint
            ? "the enhancement decoders read a structured ENHO/ENHS document; footprint scans ABAP " +
              "source for writes, not an enhancement document."
            : isDocu
              ? "the enhancement decoders read an ENHO/ENHS document; docu reads the DOKHL/DOKTL " +
                "documentation store instead — the two never apply to the same request."
              : isDigest
                ? "the enhancement decoders read an ENHO/ENHS document; a digest summarises an " +
                  "ordinary repository object instead — the two never apply to the same request."
                : "the enhancement decoders read the current definition only.",
      "Drop enhancements, or drop view.",
    );
  }
  // For definition, `version="active"` is a no-op worth allowing (it names
  // the source abap_read would post anyway); only "inactive" is refused,
  // since the elementinfo/navigation POSTs always carry whatever source
  // abap_read read — asking about "inactive" while posting the active
  // source would silently answer a question about the wrong version.
  if (input.version && (!isDefinition || input.version === "inactive")) {
    clash(
      `version="${input.version}"`,
      isDefinition
        ? "the elementinfo and navigation-target POSTs always carry the source abap_read itself " +
          "read; asking about the inactive version while posting the active source would answer a " +
          "question about a version that was never sent."
        : isLineage
          ? "lineage always walks the ACTIVE source of the view and everything it references — " +
            "there is no per-node way to ask for an inactive version across a whole dependency tree."
          : isFootprint
            ? "footprint always scans the ACTIVE source of every include it finds — there is no " +
              "per-include way to ask for an inactive version across a whole-object scan."
            : isDocu
              ? "SAP's documentation store (DOKHL/DOKTL) is not version-controlled the way ABAP " +
                "source is — there is no active/inactive pair to select between."
              : isDigest
                ? "a digest always summarises the CURRENT active state (falling back to the newest " +
                  "inactive version only the way an ordinary read would); the active/inactive " +
                  "selector is not a thing a fixed overview can apply per section."
                : 'the active/inactive pair is a different axis from the version FEED; "inactive" is ' +
                  "not a feed entry and has no history row.",
      isDefinition
        ? "Activate the object first and read the active source, or drop version."
        : isLineage || isFootprint
          ? `Drop version — view="${input.view}" always reads the current active source.`
          : isDocu || isDigest
            ? "Drop version."
            : 'Use from/to to name feed versions (list them with view="history").',
    );
  }
  if (input.pattern !== undefined) {
    clash(
      `pattern="${input.pattern}"`,
      "pattern greps the object's plain SOURCE lines; a view renders something other than the " +
        "plain source, so there are no source lines for it to filter.",
      "Drop pattern, or drop view to grep the source.",
    );
  }
  if (input.full) {
    clash(
      "full=true",
      "full only overrides the default outline of a large SOURCE read; a view is never replaced " +
        "by an outline, so there is nothing for it to override.",
      "Drop full.",
    );
  }
  if (input.outline) {
    clash(
      "outline=true",
      isDefinition
        ? "outline lists the whole component structure, not source text — there is no line/column " +
          "position in a component list to resolve."
        : isLineage
          ? "outline lists ONE object's own component structure; lineage's output is a dependency " +
            "tree over OTHER objects, not a component list of this one."
          : isFootprint
            ? "outline lists ONE object's own component structure; footprint's output is a scan of " +
              "write statements across all of this object's includes, not a component list."
            : isDocu
              ? "outline lists the component structure of a CLASS or INTERFACE object; docu reads a " +
                "documentation object, which has no component structure of its own."
              : isDigest
                ? "a digest already includes its own PUBLIC API section, built the same way outline=true " +
                  "is — asking for outline=true too would run that pass twice for no new information."
                : "the outline lists the CURRENT component structure; ADT serves no per-version outline.",
      isLineage || isFootprint
        ? `Drop outline, or omit view to see ${obj.type} ${obj.name}'s own outline.`
        : isDocu || isDigest
          ? "Drop outline."
          : "Read the outline separately, without view.",
    );
  }
  // `method` is the one param docu ACCEPTS: for a CLAS target it selects
  // which method's ABAP Doc comment to read (readDocu below), the same way
  // an ordinary read's method= selects source. Every other view refuses it.
  if (input.method && !isDocu) {
    clash(
      `method="${input.method}"`,
      isDefinition
        ? "method slices the source down to one component's block and renumbers its lines from 1; " +
          "a line/column that identifies a position in the FULL source would silently land on " +
          "whatever happens to sit at that line number inside the renumbered excerpt instead of the " +
          "position you meant."
        : isLineage
          ? "a CDS view's DDL source has no components to slice — lineage traces data sources and " +
            "associations across the whole definition, not one method."
          : isFootprint
            ? "footprint scans ALL of the object's includes/components together by design — " +
              "selecting one method would only hide writes reachable from the others, defeating the " +
              "point of a whole-object write scan."
            : isDigest
              ? "a digest is a fixed six-section overview of the object as a whole; narrowing it to one " +
                "method would answer a smaller, different question than the digest is for — the PUBLIC " +
                "API section already lists every public method."
              : "ADT versions whole objects (or whole class includes), not individual methods, so there " +
                "is no per-method feed to read or diff.",
      isDefinition
        ? "Drop method and read the definition against the full source (optionally with include)."
        : isLineage
          ? "Drop method."
          : isFootprint
            ? "Drop method — footprint's output already labels which include each occurrence is in."
            : isDigest
              ? "Drop method — read that one method directly without view, or find it in the digest's " +
                "PUBLIC API section."
              : "Drop method — the diff hunks already carry line numbers you can map back to a method.",
    );
  }
  // `include` selects a class's documented section (main/definitions/…);
  // neither axis below has a "which document" question to answer — docu
  // reads a completely separate DOKHL/DOKTL store, and a digest always
  // summarises the class's own main source plus its testclasses include,
  // never a caller-picked one — so both refuse it outright, unconditionally,
  // rather than only when obj.kind disagrees (the check the ordinary read
  // path applies below).
  if (input.include && (isDocu || isDigest)) {
    clash(
      `include="${input.include}"`,
      isDocu
        ? "docu resolves its own documentation target from the object's type and name; there is no " +
          "class-include axis on a documentation read."
        : "a digest always reads the class's own main source (plus its testclasses include, to " +
          "count FOR TESTING classes) — there is no caller-selectable include axis on a fixed " +
          "six-section overview.",
      "Drop include.",
    );
  }
  if (input.include && obj.kind !== "CLAS") {
    clash(
      `include="${input.include}"`,
      `only a class has includes, and ${obj.type} ${obj.name} is not one.`,
      "Drop include.",
    );
  }
  // footprint is the one new view that CAN target a class (CLAS/OC is in
  // FOOTPRINT_TYPES), so the generic "only a class has includes" check above
  // does not catch it — footprint needs its own, view-specific reason: it
  // scans every include by design, so naming one contradicts the view.
  if (input.include && isFootprint) {
    clash(
      `include="${input.include}"`,
      "footprint scans ALL of the object's includes/sections by design — a write reachable only " +
        "from testclasses, or from a class's implementations section, must not go unseen. " +
        "Selecting one include would contradict that.",
      "Drop include — footprint's output already labels which include each occurrence is in.",
    );
  }
  if (input.include && obj.include && input.include !== obj.include) {
    clash(
      `include="${input.include}"`,
      `the object reference already named include "${obj.include}". Two different includes were ` +
        "asked for and there is no non-arbitrary way to pick one.",
      `Drop one of them: either include="${input.include}" or the /includes/${obj.include} suffix ` +
        "on the object reference.",
    );
  }
  if (input.view === "history") {
    for (const [param, value] of [
      ["from", input.from],
      ["to", input.to],
      ["context", input.context],
    ] as const) {
      if (value !== undefined) {
        clash(
          param,
          "it selects or formats a diff, and history only lists versions.",
          `Use view="diff" with ${param}, or drop ${param}.`,
        );
      }
    }
  }
  if (isDefinition) {
    for (const [param, value] of [
      ["from", input.from],
      ["to", input.to],
      ["context", input.context],
    ] as const) {
      if (value !== undefined) {
        clash(
          param,
          "they parameterise a diff between two versions; definition resolves a position in the " +
            "current source, not a comparison between versions.",
          `Drop ${param}, or use view="diff" to compare versions instead.`,
        );
      }
    }
  }
  if (isDocu || isDigest) {
    for (const [param, value] of [
      ["from", input.from],
      ["to", input.to],
      ["context", input.context],
    ] as const) {
      if (value !== undefined) {
        clash(
          param,
          isDocu
            ? "they parameterise a diff between two source versions; a documentation object has no " +
              "version feed to diff."
            : "they parameterise a diff between two source versions; a digest summarises the CURRENT " +
              "state only, not a comparison between versions.",
          `Drop ${param}${isDocu ? "" : ', or use view="diff" to compare versions instead'}.`,
        );
      }
    }
  }
  // line/column are meaningful for view="definition" ONLY — every other
  // view (history/diff, lineage/footprint, docu/digest) is refused here,
  // each with its own honest reason rather than the history/diff wording
  // stretched to cover a tree, a whole-object scan or an overview too.
  if (!isDefinition) {
    for (const [param, value] of [
      ["line", input.line],
      ["column", input.column],
    ] as const) {
      if (value !== undefined) {
        clash(
          param,
          isLineage
            ? "it selects a position in ONE object's CURRENT source; lineage's output is a tree " +
              "across MANY objects, so there is no single source position for it to mean."
            : isFootprint
              ? "it selects a position in ONE object's CURRENT source; footprint's output is a scan " +
                "across ALL of the object's includes, not a position within one of them."
              : isDocu
                ? "it selects a position in ABAP source; docu returns flattened documentation text, " +
                  "which has no line/column axis of its own to resolve a position in."
                : isDigest
                  ? "it selects a position in ABAP source; a digest is a fixed six-section overview, not " +
                    "a position lookup."
                  : "it selects a position in the CURRENT source; history and diff are about versions, " +
                    "not positions.",
          'Use view="definition" for a position lookup, or drop it.',
        );
      }
    }
  }
  // types filters a DEVC/K package listing only; lineage/footprint never
  // read a package, so it has nothing to filter — refuse it rather than
  // silently discard it (the from/to/context loops above do the same for
  // history/definition; types was never guarded here at all before lineage/
  // footprint existed, since DEVC/K never reaches assertViewCompatible —
  // DEVC/K reads have no `view`).
  if (input.types !== undefined && (isLineage || isFootprint)) {
    clash(
      "types",
      `types filters a DEVC/K package listing to certain kind codes; view="${input.view}" is not a ` +
        "package read.",
      "Drop types.",
    );
  }
  // Neither new view pages its body by line: lineage's tree (or field
  // chain) is bounded by depth/nodeBudget, and footprint's occurrence list
  // is grouped by table — offset/limit would have nothing to window into,
  // so they are refused rather than silently ignored.
  if (isLineage || isFootprint) {
    for (const [param, value] of [
      ["offset", input.offset],
      ["limit", input.limit],
    ] as const) {
      if (value !== undefined) {
        clash(
          param,
          isLineage
            ? "lineage's tree (or field chain, with field=) is bounded by depth/nodeBudget, not " +
              "paged by line — there is no line-numbered body for offset/limit to window into."
            : "footprint's occurrence list is grouped by table, not paged by line — there is no " +
              "line-numbered body for offset/limit to window into.",
          isLineage ? `Drop ${param} — narrow the walk with depth instead.` : `Drop ${param}.`,
        );
      }
    }
  }
  // field only means something for view="lineage" (it selects which field
  // to trace instead of rendering the whole tree) — refuse it for every
  // other view rather than silently ignoring it.
  if (input.field !== undefined && !isLineage) {
    throw new AbapError(
      "BAD_INPUT",
      `field is only meaningful with view="lineage"; view="${input.view}" doesn't use it.`,
      { type: obj.type, name: obj.name, view: input.view, param: "field" },
      'Drop field, or use view="lineage".',
    );
  }
  // depth means something for view="lineage" (bounds the walk) and for a
  // DEVC/K package listing (which has no `view` at all) — refuse it for
  // every other view that reaches this function.
  if (input.depth !== undefined && !isLineage) {
    throw new AbapError(
      "BAD_INPUT",
      `depth is only meaningful with view="lineage", or with a DEVC/K package read (no view); ` +
        `view="${input.view}" doesn't use it.`,
      { type: obj.type, name: obj.name, view: input.view, param: "depth" },
      `Drop depth, or use view="lineage" to bound the lineage walk.`,
    );
  }
  if (isDefinition && input.line === undefined) {
    throw new AbapError(
      "BAD_INPUT",
      'view="definition" requires line: a definition lookup is position-driven; without a line ' +
        "there is no element to resolve.",
      { type: obj.type, name: obj.name },
      "Add line (1-based); column (0-based) defaults to 0 if omitted.",
    );
  }
  // ELEMENT INFO/NAVIGATION POST the source abap_read reads for the object —
  // a non-source object (mode "ddic": TABL/DTEL/DOMA/TTYP/MSAG/ENQU/SRVB/…,
  // including every PROPERTIES_SHAPE_TYPES entry — see types.ts, every one
  // of which is `mode: "ddic"` with `supportsSource: false`) has no ABAP
  // source for a position to be IN.
  if (isDefinition && (obj.mode === "ddic" || !obj.sourceUri)) {
    throw new AbapError(
      "UNSUPPORTED",
      `view="definition" is not supported for ${obj.type} ${obj.name}: element info is a ` +
        "source-position lookup, and this object has no ABAP source to resolve a position in.",
      { type: obj.type, name: obj.name, mode: obj.mode },
      "Omit view, or point this at a source-based object (CLAS, INTF, PROG, FUGR, DDLS, DDLX, " +
        "BDEF, SRVD, XSLT).",
    );
  }
}

/**
 * Which class include a `view` call is about. ADT's versions link relation
 * appears once PER INCLUDE — five times on the live-captured
 * `CL_ABAP_UNIT_ASSERT` fixture (test/fixtures/live-captured/455-ver-
 * objectstructure-class-control.xml) — and `abap-adt-api` defaults silently
 * to `main`, so a change made in e.g. testclasses reports "no differences".
 * Available includes are read off the object's own links, never assumed —
 * see `versionedIncludes` in ../adt/revisions.ts. `undefined` for a
 * non-class: those have one feed, linked from the object itself.
 */
function viewInclude(input: ReadInput, obj: ResolvedObject): ClassInclude | undefined {
  if (obj.kind !== "CLAS") return undefined;
  return input.include ?? obj.include ?? "main";
}

/**
 * The disclosure that goes with {@link viewInclude}. Never silent. Exported
 * for `read-systems.ts`'s cross-system diff, which asks the identical
 * question about a caller-chosen `include` on two systems at once.
 */
export function includeNote(include: ClassInclude | undefined): string[] {
  if (!include) return [];
  const others = CLASS_INCLUDES.filter((i) => i !== include);
  return [
    `This covers class include "${include}" ONLY. ADT versions each include separately, so a ` +
      `change made in ${others.join(", ")} does not appear here — re-run with include="…" to ` +
      "see those.",
  ];
}

/**
 * `include` is a no-op for anything that is not a class: those have one
 * source document, so there is nothing for `include` to select. Rather than
 * refusing (the old behaviour), the read proceeds against that single
 * document and discloses that the include was dropped. Empty when there is
 * nothing to disclose: no `include` was asked for, the object is a class
 * (handled by {@link assertIncludeCompatible} / {@link includeNote}
 * instead), or the object reference itself already named an include (that
 * case is still a hard refusal in {@link assertIncludeCompatible}).
 */
export function includeIgnoredNote(input: ReadInput, obj: ResolvedObject): string[] {
  if (!input.include || obj.kind === "CLAS" || obj.include) return [];
  return [
    "this object has a single source document; include ignored — " +
      `${obj.type} ${obj.name} has no "${input.include}" include (class includes ` +
      `${CLASS_INCLUDES.join(", ")} exist only for CLAS/OC); the single document is shown, ` +
      "nothing was substituted.",
  ];
}

/**
 * The include an ORDINARY (non-`view`) read is about, refusing every
 * combination it cannot honour. `sourceUriFor` (adt/source.ts)
 * guarantees a non-`main` include is never silently answered from main — but
 * format:"raw" (properties-shape only, never a class), enhancements
 * (different document), and outline/method (both read `/objectstructure`,
 * which describes the GLOBAL class and numbers lines against `main`) would
 * each quietly mis-answer otherwise. Checked against the EFFECTIVE include
 * (`input.include ?? obj.include`), since a raw `.../includes/testclasses`
 * URI could already reach this before `include` existed as a parameter.
 * `main` is exempt: it names the document every path already reads.
 */
function assertIncludeCompatible(input: ReadInput, obj: ResolvedObject): ClassInclude | undefined {
  if (input.include && obj.include && input.include !== obj.include) {
    throw new AbapError(
      "UNSUPPORTED",
      `include="${input.include}" contradicts the object reference, which already named include ` +
        `"${obj.include}". Two different includes were asked for and there is no non-arbitrary ` +
        "way to pick one.",
      { type: obj.type, name: obj.name, requested: input.include, fromUri: obj.include },
      `Drop one of them: either include="${input.include}" or the /includes/${obj.include} ` +
        "suffix on the object reference.",
    );
  }
  const include = input.include ?? obj.include;
  if (!include) return undefined;
  if (obj.kind !== "CLAS") {
    // A non-class object has one source document. `input.include` alone is
    // now a no-op (see includeIgnoredNote) — but the object REFERENCE
    // itself naming a different include (obj.include) is still refused:
    // that would mean silently substituting a document the caller never
    // asked to read here.
    if (obj.include) {
      throw new AbapError(
        "UNSUPPORTED",
        `${obj.type} ${obj.name} has no "${include}" include — class includes ` +
          `(${CLASS_INCLUDES.join(", ")}) exist only for classes.`,
        { type: obj.type, name: obj.name, requested: include },
        "Drop include. This object has a single source document, and it was NOT silently " +
          "returned in place of the include you asked for.",
      );
    }
    return undefined;
  }
  if (include === "main") return include;

  const clash = (param: string, why: string, hint: string): never => {
    throw new AbapError(
      "UNSUPPORTED",
      `${param} cannot be combined with include="${include}" for ${obj.type} ${obj.name}: ${why}`,
      { type: obj.type, name: obj.name, include, param },
      hint,
    );
  };
  if (input.format) {
    clash(
      'format="raw"',
      "raw returns an object's whole XML descriptor, which exists only for the properties-shape " +
        `types (${PROPERTIES_SHAPE_TYPES.join(", ")}) — a class has none, and a class include is source.`,
      "Drop format — an include read already returns exactly the source bytes a write of that " +
        "include replaces.",
    );
  }
  if (input.enhancements) {
    clash(
      "enhancements=true",
      "the enhancement decoders read an ENHO/ENHS document, not a class include.",
      "Drop one of the two.",
    );
  }
  if (input.outline) {
    clash(
      "outline=true",
      "the ADT component structure describes the GLOBAL class and reports its line ranges " +
        `against the class's main document, so an outline of "${include}" is not a thing ADT ` +
        "serves — the rows would be main's, with main's line numbers.",
      `Read include="${include}" in full (offset/limit page it), or drop include to outline the ` +
        "global class.",
    );
  }
  const method = input.method ?? obj.member;
  // `method=` + include="definitions" is the signature route (issue #146):
  // the declaration alone, cut from the class's main document — the global
  // definition lives there, not in CCDEF. Every other include still clashes.
  if (method && include !== "definitions") {
    clash(
      `method="${method}"`,
      "the method's line range comes from the ADT component structure, which numbers lines in " +
        "the class's main document. Cutting those lines out of a different include would return " +
        "whatever happens to sit at them — not that method.",
      `Read include="${include}" in full and locate the method in it, drop include to read ` +
        `${method} from the class body, or use include="definitions" for its declaration alone.`,
    );
  }
  return include;
}

/** `view="history"` — the version feed as a table. */
async function readHistory(
  conn: AbapConnection,
  obj: ResolvedObject,
  baseHeader: Record<string, string | number | undefined>,
  input: ReadInput,
  maxChars: number,
): Promise<BuiltResponse & { etag: string }> {
  const include = viewInclude(input, obj);
  const entries = await listRevisions(conn, obj, include);
  const released = releasedVersions(entries);
  const table = textTable(
    entries.map((e) => ({
      version: e.versionId || "?",
      kind: e.kind === "released" ? "" : e.kind.toUpperCase(),
      transport: e.transport,
      author: e.author,
      changed: e.date,
      description: e.description,
    })),
    ["version", "kind", "transport", "author", "changed", "description"],
  );
  const window = sliceLines(table, input.offset ?? 1, input.limit);

  const notes: string[] = [
    "Sorted newest-first — pseudo-versions first, then released versions by version NUMBER, " +
      "which is monotonic where atom:updated is often absent — and DE-DUPLICATED by version " +
      "number. The raw feed is neither: one captured A4H feed returned 68 entries of which ~60 " +
      "were the same ACTIVE row, most carrying no date at all.",
    "00000 is the ACTIVE pseudo-version — it serves the object's CURRENT source, not a snapshot " +
      "— and 99999 is INACTIVE. Neither is history. An empty transport/author/date is the feed's " +
      "own silence, not a lookup failure.",
    'The "description" column is the entry\'s atom:title, which is the TRANSPORT description in ' +
      "free prose. It is not a version label; the version number is the first column.",
    ...includeNote(include),
  ];
  // Say what the single row is, rather than presenting current source as a change log.
  if (entries.length > 0 && released.length === 0) {
    notes.unshift(
      `${obj.type} ${obj.name} ${NO_RELEASED_HISTORY_EXPLANATION} The row below is that ACTIVE ` +
        "entry — it is the object as it stands now, not a record of a change.",
    );
  }

  const built = buildReadResponse({
    header: {
      ...baseHeader,
      view: "history",
      ...(include ? { include } : {}),
      versions: entries.length,
      released: released.length,
    },
    body: entries.length
      ? window.text
      : `(${obj.type} ${obj.name} has a version feed, but ADT returned no entries in it.)`,
    bodyLabel: "VERSION HISTORY",
    bodyOffset: entries.length ? window.offset : undefined,
    bodyTotalLines: entries.length ? window.total : undefined,
    notes,
    hints:
      released.length >= 2
        ? [
            'Diff the last released change with view="diff" and no other parameters. Diff any ' +
              'pair with view="diff" from="00063" to="00067".',
          ]
        : released.length === 1
          ? [
              'view="diff" with no other parameters compares the one released version against ' +
                "the current source.",
            ]
          : [
              "There is nothing to diff here. Read the current source with a plain abap_read " +
                "(omit view).",
            ],
    pagingParam: "offset",
    maxChars,
  });
  return { ...built, etag: NO_ETAG };
}

/** `view="diff"` — unified-diff hunks between two feed versions. Never two full sources. */
async function readDiff(
  conn: AbapConnection,
  obj: ResolvedObject,
  baseHeader: Record<string, string | number | undefined>,
  input: ReadInput,
  maxChars: number,
): Promise<BuiltResponse & { etag: string }> {
  const include = viewInclude(input, obj);
  const entries = await listRevisions(conn, obj, include);
  // Refuses "no released history" here — never diff ACTIVE against itself
  // and report "no differences" for a $TMP-style object.
  const pair = resolveDiffPair(entries, input.from, input.to, { name: obj.name, type: obj.type });
  const ctx = { name: obj.name, type: obj.type };
  const [oldSource, newSource] = await Promise.all([
    revisionSource(conn, pair.older, ctx),
    revisionSource(conn, pair.newer, ctx),
  ]);

  const result = diffSources(oldSource, newSource, {
    context: input.context ?? DEFAULT_CONTEXT_LINES,
    maxHunks: DIFF_MAX_HUNKS,
  });
  const rendered = renderHunks(result.hunks);
  const window = sliceLines(rendered, input.offset ?? 1, input.limit);

  const side = (e: typeof pair.older): string =>
    `${e.author || "author not recorded"}, ${e.date || "date not recorded"}` +
    `${e.transport ? `, ${e.transport}` : ", no transport recorded"}` +
    `${e.description ? ` — "${e.description}"` : ""}`;
  const notes: string[] = [
    `from ${describeEntry(pair.older)} — ${side(pair.older)}` +
      (pair.olderDefaulted ? " (defaulted: the released version before the newer side)" : ""),
    `to   ${describeEntry(pair.newer)} — ${side(pair.newer)}` +
      (pair.newerDefaulted ? " (defaulted: the newest released version)" : ""),
    ...includeNote(include),
  ];
  if (pair.newerIsActive) {
    notes.push(
      "The NEWER side is the ACTIVE pseudo-version 00000, i.e. the object's CURRENT source, not " +
        "a released snapshot. So this answers \"what has changed since the last release\", and it " +
        "includes any local activation that was never transported.",
    );
  }
  if (result.coarse) {
    notes.push(
      "COARSE DIFF: the two versions share almost no leading or trailing lines, so the exact " +
        "line-matching pass was skipped and the whole changed region is reported as one " +
        "delete-then-insert block. The diff is correct but not minimal.",
    );
  }
  if (result.droppedHunks > 0) {
    notes.push(
      `TRUNCATED: showing ${result.hunks.length} of ${result.totalHunks} hunks; ` +
        `${result.droppedHunks} were withheld to stay inside the response budget. Narrow the ` +
        "comparison (an adjacent pair changes less) or read the versions separately.",
    );
  }

  const built = buildReadResponse({
    header: {
      ...baseHeader,
      view: "diff",
      ...(include ? { include } : {}),
      from: describeEntry(pair.older),
      to: describeEntry(pair.newer),
      added: result.added,
      removed: result.removed,
      hunks: result.totalHunks,
    },
    body: result.identical
      ? `(no differences: ${describeEntry(pair.older)} and ${describeEntry(pair.newer)} of ` +
        `${obj.type} ${obj.name} are line-for-line identical.)`
      : window.text,
    bodyLabel: "DIFF",
    bodyOffset: result.identical ? undefined : window.offset,
    bodyTotalLines: result.identical ? undefined : window.total,
    notes,
    hints: [
      "Unified-diff hunks only — the unchanged bulk of both versions was never fetched into this " +
        "response. Read a version in full with a plain abap_read if you need it.",
      'List the versions with view="history".',
    ],
    pagingParam: "offset",
    maxChars,
  });
  return { ...built, etag: NO_ETAG };
}

/** `view="lineage"` — trace a CDS view's data sources down to base tables (issue #106). */
async function readLineage(
  conn: AbapConnection,
  obj: ResolvedObject,
  baseHeader: Record<string, string | number | undefined>,
  input: ReadInput,
  maxChars: number,
): Promise<BuiltResponse & { etag: string }> {
  if (obj.type !== "DDLS/DF") {
    throw new AbapError(
      "UNSUPPORTED",
      `view="lineage" only traces CDS source (DDLS/DF) — ${obj.type} ${obj.name} is not a CDS view.`,
      { type: obj.type, name: obj.name },
      "Point it at a DDLS/DF object, or drop view to read this object directly.",
    );
  }
  if (input.depth !== undefined && input.depth > LINEAGE_MAX_DEPTH) {
    throw new AbapError(
      "BAD_INPUT",
      `depth=${input.depth} exceeds the maximum for view="lineage" (${LINEAGE_MAX_DEPTH}); refused, not clamped.`,
      { type: obj.type, name: obj.name, depth: input.depth, max: LINEAGE_MAX_DEPTH },
      `Use depth between 1 and ${LINEAGE_MAX_DEPTH}, or omit it for the default (${LINEAGE_DEFAULT_DEPTH}).`,
    );
  }

  const result = await buildLineage(conn, obj, { depth: input.depth, field: input.field });
  const rendered = renderLineage(result, { field: input.field });

  const built = buildReadResponse({
    header: {
      ...baseHeader,
      ...rendered.header,
      view: "lineage",
    },
    body: rendered.body,
    bodyLabel: "LINEAGE",
    notes: [...rendered.notes],
    hints: [...rendered.hints],
    maxChars,
  });
  return { ...built, etag: NO_ETAG };
}

/** `view="footprint"` — static scan of an object's database writes and commits (issue #107). */
async function readFootprint(
  conn: AbapConnection,
  obj: ResolvedObject,
  baseHeader: Record<string, string | number | undefined>,
  input: ReadInput,
  maxChars: number,
): Promise<BuiltResponse & { etag: string }> {
  if (!(FOOTPRINT_TYPES as readonly string[]).includes(obj.type)) {
    throw new AbapError(
      "UNSUPPORTED",
      `view="footprint" supports ${FOOTPRINT_TYPES.join(", ")} — ${obj.type} ${obj.name} is not one of them.`,
      { type: obj.type, name: obj.name, supported: [...FOOTPRINT_TYPES] },
      "Read the object directly instead of asking for its write footprint.",
    );
  }

  const result = await buildFootprint(conn, obj);
  const rendered = renderFootprint(result);

  const built = buildReadResponse({
    header: {
      ...baseHeader,
      ...rendered.header,
      view: "footprint",
    },
    body: rendered.body,
    bodyLabel: "DATABASE FOOTPRINT",
    notes: rendered.notes,
    hints: rendered.hints,
    maxChars,
  });
  return { ...built, etag: NO_ETAG };
}

// ---------------------------------------------------------------- definition --

/** Display cap for `IMPLEMENTED BY` — mirrors `whereUsed`'s `max` role in `search.ts`, but fixed rather than caller-tunable: this section is a side note on a definition lookup, not the point of the call. */
const IMPLEMENTATIONS_DISPLAY_MAX = 50;

/**
 * Heuristic cost signal for disclosing the `findImplementations` fetch,
 * mirroring `search.ts`'s `SLOW_FETCH_MS`/`HIGH_FAN_IN_REFERENCES` (kept as
 * a separate, private constant here rather than importing search.ts's,
 * which are not exported) — fixture 961's own capture took ~9.9s for a
 * two-implementer toy example, so this path is expected to be slow even at
 * small scale.
 */
const SLOW_IMPLEMENTATIONS_FETCH_MS = 5000;

/**
 * `<p>Creates <b>x</b>.</p>` → `Creates x.` — behaviourally identical to
 * `quickfix.ts`'s private `stripHtml` (not exported, and this task's remit
 * is `read.ts` only, so it cannot be imported without touching that file).
 * Tags become a space, not empty, so adjacent block elements don't run
 * together; the space is then dropped again before punctuation. Entities in
 * `abapDoc` are already decoded once by `element-info.ts`'s own XML parser
 * (see that field's doc comment) — this only strips tags.
 */
function stripAbapDocHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

/**
 * Best-effort `{name, type}` off a navigation/implementation target URI —
 * grounded only in what fixtures 958 (interface) and 961 (class) actually
 * show; every other object kind is left with `type: undefined` rather than
 * guessed, per the instruction not to fabricate a type this module cannot
 * derive.
 */
const OBJECT_URI_KIND: ReadonlyArray<{ re: RegExp; type: string }> = [
  { re: /\/oo\/classes\/([^/]+)(?:\/|$)/i, type: "CLAS/OC" },
  { re: /\/oo\/interfaces\/([^/]+)(?:\/|$)/i, type: "INTF/OI" },
];

function objectRefFromUri(uri: string): { name?: string; type?: string } {
  for (const { re, type } of OBJECT_URI_KIND) {
    const m = re.exec(uri);
    if (m?.[1]) return { name: m[1].toUpperCase(), type };
  }
  return {};
}

/** A literal, copy-pasteable `abap_read` call for the DEFINITION section — the issue's own acceptance criterion. */
function renderAbapReadCall(name: string | undefined, type: string | undefined): string {
  if (!name) return "(no navigation target — nothing to open)";
  return type ? `abap_read {"object":"${name}","type":"${type}"}` : `abap_read {"object":"${name}"}`;
}

/** Renders `info.children` (method/FM parameters, or structure components) as a table whose columns are driven by what is actually present — never a fixed column set, since a structure component (954) carries none of a parameter's properties. */
function renderChildrenTable(children: readonly ElementInfoEntry[], candidates: readonly string[]): string {
  if (children.length === 0) return "";
  const field = (c: ElementInfoEntry, key: string): string | undefined =>
    key === "name" ? c.name : key === "shortText" ? c.shortText : c.properties[key];
  const present = candidates.filter((key) => children.some((c) => field(c, key) !== undefined));
  if (present.length === 0) return "";
  const rows = children.map((c) => {
    const row: Record<string, string> = {};
    for (const key of present) row[key] = field(c, key) ?? "";
    return row;
  });
  return textTable(rows, [...present]);
}

const SIGNATURE_COLUMNS = ["name", "paramType", "abapType", "optional", "byValue", "paramDefaultValue", "shortText"];
const COMPONENT_COLUMNS = ["name", "abapType"];

/**
 * Element types whose answer is a callable, so "no parameters" is a real
 * answer worth printing rather than a missing section. `FUGR/FF` is here
 * for a different reason than the other two — ADT returns no signature at
 * all for a function module (see the note below) — but the rendering is the
 * same, and the note below depends on the section existing.
 */
const CALLABLE_ELEMENT_TYPES = new Set(["INTF/IO", "CLAS/OM", "FUGR/FF"]);

/**
 * `view="definition"` — ADT's element-info/navigation-target/usage-references
 * endpoints, read-only element lookup at a source position. Returns
 * `{...built, etag: NO_ETAG}` like {@link readHistory}/{@link readDiff}: this
 * is a lookup, not the resource, and must not mint a token that looks like a
 * write credential for `abap_write`.
 *
 * `assertViewCompatible` has already refused every combination this handler
 * cannot honour (raw/enhancements/inactive-version/outline/method, a
 * non-source object, a missing `line`) — this function only has to handle
 * the shapes that remain.
 */
async function readDefinition(
  conn: AbapConnection,
  obj: ResolvedObject,
  baseHeader: Record<string, string | number | undefined>,
  input: ReadInput,
  maxChars: number,
): Promise<BuiltResponse & { etag: string }> {
  const include = viewInclude(input, obj);
  // version is either undefined or "active" here (assertViewCompatible
  // refused "inactive") — passed through unchanged so the header/notes below
  // describe exactly what was posted, the same as the plain source-read path.
  const { source, sourceUri } = await readSource(conn, obj, include, input.version);
  const line = input.line!; // assertViewCompatible guarantees this is set.
  const column = input.column ?? 0;

  const totalLines = countLines(source);
  if (line > totalLines) {
    throw new AbapError(
      "BAD_INPUT",
      `line=${line} is past the end of ${obj.type} ${obj.name}'s source (${include ? `include "${include}", ` : ""}${totalLines} line(s)).`,
      { type: obj.type, name: obj.name, line, totalLines, include },
      `Pick a line between 1 and ${totalLines}, or re-read without offset/limit to see the source first.`,
    );
  }

  const pos: SourcePosition = { line, column };
  const token = identifierAt(source, pos);
  const info = await fetchElementInfo(conn, sourceUri, pos, source);

  const lineText = source.replace(/\r\n/g, "\n").split("\n")[line - 1] ?? "";

  const header: Record<string, string | number | undefined> = {
    ...baseHeader,
    mode: "definition",
    ...(include ? { include } : {}),
    ...(include && include !== "main" ? { uri: sourceUri } : {}),
    line,
    column,
  };
  const notes: string[] = [...includeNote(include)];

  if (isUnresolved(info)) {
    const built = buildReadResponse({
      header,
      sections: [
        {
          title: "DEFINITION",
          content:
            `No resolvable element at line ${line}, column ${column} of ${obj.type} ${obj.name}.\n` +
            `${line}: ${lineText}`,
        },
      ],
      notes: [
        "ADT answered HTTP 200 with an element-info document that names no element at this " +
          "position — this is a fact about the position, not a lookup failure.",
        ...notes,
      ],
      hints: ["Pick a position on an identifier — a variable, method call, or type name."],
      maxChars,
    });
    return { ...built, etag: NO_ETAG };
  }

  const props = info.properties;
  header.element = `${info.type ?? "?"} ${info.name ?? "?"}`;
  header.kind = props.kind;
  header.visibility = props.visibility;
  header.level = props.level;
  header.abapType = props.abapType;

  const lookup = token
    ? await findDefinitionTarget(conn, sourceUri, { line, startColumn: token.startColumn, endColumn: token.endColumn }, source)
    : undefined;
  const target = lookup?.target;
  const targetRef = target ? objectRefFromUri(target.uri) : undefined;

  const defLines: string[] = [`${line}: ${lineText}`];
  if (target === undefined) {
    defLines.push(
      token === undefined
        ? "This position is not on an identifier — ADT still resolved an element here (below), but " +
          "there is no source range to ask the navigation-target endpoint for a declaration site."
        : lookup?.noTargetReason === "declaration-itself"
          ? "This position is the declaration itself — ADT reports the definition location is here " +
            "(SAP message ED263)."
          : lookup?.noTargetReason === "undecidable"
            ? "ADT named no navigation target: more than one implementation exists, so the declaration " +
              "site is undecidable from this position."
            : "ADT named no navigation target for this identifier.",
    );
  } else {
    defLines.push(
      `declared at: ${target.uri}` +
        (target.line !== undefined ? ` (line ${target.line}, column ${target.column})` : ""),
    );
    defLines.push(`open with: ${renderAbapReadCall(targetRef?.name, targetRef?.type)}`);
  }

  const sections: Array<{ title: string; content: string }> = [{ title: "DEFINITION", content: defLines.join("\n") }];

  const signature = renderChildrenTable(info.children, SIGNATURE_COLUMNS);
  const components = signature ? "" : renderChildrenTable(info.children, COMPONENT_COLUMNS);
  if (signature) {
    sections.push({ title: "SIGNATURE", content: signature });
  } else if (components) {
    sections.push({ title: "COMPONENTS", content: components });
  } else if (info.type !== undefined && CALLABLE_ELEMENT_TYPES.has(info.type)) {
    sections.push({ title: "SIGNATURE", content: "(none)" });
  }

  const docLines: string[] = [];
  if (info.shortText) docLines.push(`short text: ${info.shortText}`);
  if (info.abapDoc) {
    const stripped = stripAbapDocHtml(info.abapDoc);
    if (stripped) docLines.push(`ABAP Doc: ${stripped}`);
  }
  if (docLines.length > 0) sections.push({ title: "DOC", content: docLines.join("\n") });

  if (info.type === "FUGR/FF") {
    notes.push(
      "Function modules resolve to name and type only — ADT's element info returns no visibility, " +
        "no signature and no documentation for FUGR/FF (verified live against RFC_PING). The empty " +
        "SIGNATURE section above is that fact, not a rendering gap.",
    );
  }

  // Where-used-based implementer listing — interface methods only. The
  // interface's own declaration site is reached one of two ways: (a) a use
  // site elsewhere (e.g. `zif_x~run` in an implementing class, or a call
  // through an interface reference) whose navigation target resolves into
  // the interface, or (b) the object being read IS the interface, in which
  // case there is no navigation target to resolve — ADT names none there
  // either (see ED263 above) — and the declaration site is just the
  // position asked about. Either way this is still the most expensive call
  // on this path (fixture 961: ~9.9s for two implementers), so it must not
  // run for anything but an interface method.
  let implInterfaceUri: string | undefined;
  let implInterfaceName: string | undefined;
  let implPos: SourcePosition | undefined;
  if (info.type === "INTF/IO" && info.name) {
    if (target !== undefined && /\/oo\/interfaces\//i.test(target.uri) && targetRef?.name) {
      implInterfaceUri = target.uri;
      implInterfaceName = targetRef.name;
      implPos =
        target.line !== undefined && target.column !== undefined
          ? { line: target.line, column: target.column }
          : undefined;
    } else if (obj.type === "INTF/OI") {
      implInterfaceUri = sourceUri;
      implInterfaceName = obj.name;
      implPos = pos;
    }
  }
  if (implInterfaceUri && implInterfaceName && info.name) {
    const { implementations, fetchMs, totalReferences } = await findImplementations(
      conn,
      implInterfaceUri,
      implPos,
      implInterfaceName,
      info.name,
    );
    const kept = implementations.slice(0, IMPLEMENTATIONS_DISPLAY_MAX);
    const omitted = implementations.length - kept.length;
    const rows = kept.map((i) => ({ class: i.className, method: i.methodName, package: i.packageName ?? "" }));
    const capLine =
      omitted > 0
        ? `\n--- TRUNCATED --- ${omitted} of ${implementations.length} implementer(s) not shown ` +
          `(display cap ${IMPLEMENTATIONS_DISPLAY_MAX}).`
        : "";
    sections.push({
      title: "IMPLEMENTED BY",
      content:
        (implementations.length ? textTable(rows, ["class", "method", "package"]) : "(no implementing classes found)") +
        capLine,
    });
    if (fetchMs >= SLOW_IMPLEMENTATIONS_FETCH_MS || totalReferences >= 500) {
      notes.push(
        `FETCH COST: listing implementers took ${(fetchMs / 1000).toFixed(1)}s over ` +
          `${totalReferences} where-used reference(s) — ADT's usageReferences endpoint has no ` +
          "server-side limit, so the whole set was fetched and filtered to implementers " +
          "client-side.",
      );
    }
    notes.push(
      "Where-used is static. Dynamic calls (CALL FUNCTION lv_name, PERFORM (lv_form), " +
        "SUBMIT (lv_prog)) do not appear here — these are static-analysis blind spots.",
    );
  }

  const built = buildReadResponse({
    header,
    sections,
    notes,
    maxChars,
  });
  return { ...built, etag: NO_ETAG };
}

/** `core.docu`'s decoded head row — see `../adt/fluid/builtin/core/abap-docu.ts` for the exact JSON it emits. */
interface DocuHeadRow {
  readonly found: boolean;
  readonly language: string;
  readonly requestedLanguage: string;
  readonly fallbackUsed: boolean;
  readonly title: string;
  readonly doktyp: string;
  readonly dokstate: string;
  readonly available: readonly string[];
}

function failDocu(reason: string, result: unknown): never {
  throw new AbapError("FLUID_PROTOCOL_ERROR", `core.docu ${reason}`, {
    tool: CORE_TOOL_ID,
    action: "docu",
    result,
  });
}

/**
 * Rebuilds a typed result from `core.docu`'s row array, the same way
 * `mapScanRows` (`../adt/source-scan.ts`) does for `scan.source` — `dispatch()`
 * only checks the manifest's declared output schema (array of objects), so
 * this is the one place that turns "the schema matched" into "this specific
 * row is well-formed", against the exact field names `do_docu` emits.
 */
function mapDocuRows(rows: unknown): { head: DocuHeadRow; lines: string[] } {
  if (!Array.isArray(rows) || rows.length === 0) {
    failDocu("returned a result that is not a non-empty array", rows);
  }
  const arr = rows as unknown[];
  const first = arr[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) {
    failDocu("row 0 is not an object", rows);
  }
  const h = first as Record<string, unknown>;
  if (h["kind"] !== "docu") {
    failDocu(`row 0 has kind "${String(h["kind"])}", expected "docu" (the head row)`, rows);
  }
  if (
    typeof h["found"] !== "boolean" ||
    typeof h["language"] !== "string" ||
    typeof h["requested_language"] !== "string" ||
    typeof h["fallback_used"] !== "boolean" ||
    typeof h["title"] !== "string" ||
    typeof h["doktyp"] !== "string" ||
    typeof h["dokstate"] !== "string" ||
    !Array.isArray(h["available"])
  ) {
    failDocu("head row is missing or mistyping one of its required fields", rows);
  }
  const head: DocuHeadRow = {
    found: h["found"] as boolean,
    language: h["language"] as string,
    requestedLanguage: h["requested_language"] as string,
    fallbackUsed: h["fallback_used"] as boolean,
    title: h["title"] as string,
    doktyp: h["doktyp"] as string,
    dokstate: h["dokstate"] as string,
    available: (h["available"] as unknown[]).map((v) => String(v)),
  };

  const lines: string[] = [];
  let sawSummary = false;
  for (let i = 1; i < arr.length; i++) {
    const row = arr[i];
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      failDocu(`row ${i} is not an object`, rows);
    }
    const r = row as Record<string, unknown>;
    if (r["kind"] === "line") {
      if (sawSummary) failDocu(`row ${i} is a line row after the summary row`, rows);
      if (typeof r["text"] !== "string") {
        failDocu(`row ${i} is a line row missing or mistyping "text"`, rows);
      }
      lines.push(r["text"] as string);
      continue;
    }
    if (r["kind"] === "summary") {
      if (sawSummary) failDocu("returned more than one summary row", rows);
      if (typeof r["lines_returned"] !== "number") {
        failDocu(`row ${i} is a summary row missing or mistyping "lines_returned"`, rows);
      }
      if (i !== arr.length - 1) {
        failDocu("returned a summary row that is not the last element", rows);
      }
      sawSummary = true;
      continue;
    }
    failDocu(`row ${i} has kind "${String(r["kind"])}", expected "line" or "summary"`, rows);
  }
  if (!sawSummary) failDocu("did not return a summary row", rows);

  return { head, lines };
}

/**
 * `view="docu"` — SAP's own documentation (DOKHL/DOKTL), read through the
 * fluid `core.docu` action (see `../adt/docu.ts`'s module comment: no ADT
 * REST endpoint reads this store directly, so there is no plain-read path
 * for it). `method=` reads ABAP Doc from source instead: a method has no
 * DOKHL entry of its own — ABAP Doc comments ARE its documentation — so this
 * never falls back to the class-level DOKHL text for a method target, which
 * would silently answer a different, wrong question. Because that branch is
 * a pure source scan (`readSource` + `extractAbapDoc`), it never dispatches
 * `core.docu` and so needs no {@link SafetyGate} at all — `gate` is only
 * required, and only checked, in the object-based branch below.
 *
 * No `language` input exists on `abap_read` (and none is added here): the
 * ABAP side already tries the logon language, then EN, on its own, and the
 * response states which language actually came back (`language`) and
 * whether that was a fallback (`fallback_used`), so a caller never has to
 * guess or ask twice.
 */
async function readDocu(
  conn: AbapConnection,
  obj: ResolvedObject,
  baseHeader: Record<string, string | number | undefined>,
  input: ReadInput,
  maxChars: number,
  gate: SafetyGate | undefined,
): Promise<BuiltResponse & { etag: string }> {
  if (input.method !== undefined) {
    if (obj.kind !== "CLAS") {
      throw new AbapError(
        "UNSUPPORTED",
        `method="${input.method}" is only meaningful for a class: ABAP Doc lives on a method's ` +
          `own declaration in source, and ${obj.type} ${obj.name} is not a class.`,
        { type: obj.type, name: obj.name, method: input.method },
        "Drop method to read this object's own SAP documentation instead.",
      );
    }
    const { source } = await readSource(conn, obj, undefined, undefined);
    const doc = extractAbapDoc(source, input.method);
    const built = buildReadResponse({
      header: { ...baseHeader, view: "docu", docu: `method ${input.method}` },
      body:
        doc.length > 0
          ? doc.join("\n")
          : `(${obj.type} ${obj.name} method ${input.method} carries no ABAP Doc comment.)`,
      bodyLabel: "DOCUMENTATION",
      notes: [
        'ABAP Doc: the "!-prefixed comment block immediately above the method\'s ' +
          "METHODS/CLASS-METHODS declaration — the only documentation a method itself carries. " +
          'This never falls back to the class-level DOKHL text (view="docu" without method= reads ' +
          "that instead) — a method's own doc and its class's doc answer different questions.",
      ],
      maxChars,
    });
    return { ...built, etag: NO_ETAG };
  }

  // Object-based path: obj.name is the RESOLVED name (a real ADT object),
  // which is exactly what resolveDocuTarget wants for every type it accepts
  // here except MSAG — that case never reaches this function, see the
  // MSAG/SIMG bypass in abapRead just above the resolveObject call, and
  // that branch's own comment for why.
  //
  // This is the one branch of readDocu that actually dispatches core.docu
  // (via renderDocuTarget), so it is also the one place a gate is required —
  // checked here, not by the caller, so the method= branch above never has
  // to carry a gate it does not use.
  const g = requireDocuGate(gate, { type: obj.type, name: obj.name, view: input.view });
  const target = resolveDocuTarget({ type: obj.type, object: obj.name });
  return await renderDocuTarget(conn, target, baseHeader, maxChars, g);
}

/**
 * Guards the three `view="docu"` paths that actually run through
 * `dispatch()` under the hood (see {@link readDocu}'s doc comment) since
 * there is no plain ADT REST endpoint for SAP's documentation store: the
 * object-based path in {@link readDocu} (no `method=`), and the two paths in
 * `abapRead` that bypass `resolveObject` entirely (MSAG, the `SIMG`
 * pseudo-type) — none of the three has any other way to obtain a
 * {@link SafetyGate} to judge the write `dispatch()` deploys under the hood.
 * `readDocu`'s `method=` branch is NOT one of these: it is a pure source
 * scan that never dispatches anything, so it never calls this function and
 * needs no gate at all. `gate` is only ever `undefined` when a caller
 * invokes `abapRead` directly without going through `registerReadTools`'s
 * fluid-write routing (e.g. a test) — there is no sound fallback for that.
 */
function requireDocuGate(
  gate: SafetyGate | undefined,
  ctx: Record<string, string | number | undefined>,
): SafetyGate {
  if (gate === undefined) {
    throw new AbapError(
      "UNSUPPORTED",
      'view="docu" reads through a deployed fluid tool, which needs a SafetyGate to judge; ' +
        "none was supplied to this call.",
      ctx,
    );
  }
  return gate;
}

/**
 * The dispatch-and-render tail every `view="docu"` path shares, once the
 * caller-specific work of producing a {@link DocuTarget} and a `baseHeader`
 * is done: the object-based path in {@link readDocu} (built from a real
 * `ResolvedObject`), and `abapRead`'s MSAG and `SIMG`-pseudo-type bypasses
 * (built by hand — neither has a `ResolvedObject` to draw one from).
 */
async function renderDocuTarget(
  conn: AbapConnection,
  target: DocuTarget,
  baseHeader: Record<string, string | number | undefined>,
  maxChars: number,
  gate: SafetyGate,
): Promise<BuiltResponse & { etag: string }> {
  const res = await dispatch(
    { conn, cfg: conn.cfg, gate, tools: CORE_TOOLS },
    {
      tool: CORE_TOOL_ID,
      action: "docu",
      args: { id: target.id, object: target.object },
      caller: { tool: "abap_read", action: "docu" },
    },
  );
  const { head, lines } = mapDocuRows(res.result);

  const header: Record<string, string | number | undefined> = {
    ...baseHeader,
    view: "docu",
    docu: `${target.id} ${target.object}`,
    language: head.found ? head.language : undefined,
    title: head.found ? head.title : undefined,
  };

  const notes: string[] = [DOCU_FLATTEN_NOTE];
  if (head.found && head.fallbackUsed) {
    notes.push(
      `Requested language "${head.requestedLanguage}" has no documentation for this ${target.kind}; ` +
        `SAP returned it in "${head.language}" instead.`,
    );
  }
  if (head.available.length > 0) {
    notes.push(
      `DOKIL lists documentation entries for: ${head.available.join(", ")} (langu:typ:dokstate) — ` +
        "informational only; it is not what core.docu used to pick a language (see abap-docu.ts).",
    );
  }

  // The only candidate the TS layer can actually name: `requested_language`
  // is the FIRST language `do_docu` tried (the logon language, since no
  // `language` input is ever sent — see readDocu's doc comment); EN was
  // also tried whenever that first candidate wasn't already EN itself.
  const tried = head.requestedLanguage === "EN" ? [head.requestedLanguage] : [head.requestedLanguage, "EN"];

  const built = buildReadResponse({
    header,
    body: head.found && lines.length > 0 ? lines.join("\n") : docuEmptyText(tried),
    bodyLabel: "DOCUMENTATION",
    notes,
    maxChars,
  });
  return { ...built, etag: NO_ETAG };
}

/**
 * Same refusals {@link assertViewCompatible} makes for the object-based
 * `view="docu"` path, for the two targets that bypass `resolveObject`
 * entirely and so have no `ResolvedObject` for that function to check
 * against. `method` is refused unconditionally here (unlike the object
 * path, which accepts it for a CLAS): a message class and an IMG activity
 * are never a CLAS, so there is no ABAP Doc comment `method=` could select.
 */
function assertDocuBypassCompatible(input: ReadInput, kind: string): void {
  const clash = (param: string): never => {
    throw new AbapError(
      "UNSUPPORTED",
      `${param} cannot be combined with view="docu" for a ${kind}: only object and type are ` +
        "meaningful for this documentation lookup.",
      { view: "docu", kind, param },
      `Drop ${param}.`,
    );
  };
  if (input.method !== undefined) clash("method");
  if (input.format !== undefined) clash('format="raw"');
  if (input.enhancements) clash("enhancements=true");
  if (input.version !== undefined) clash(`version="${input.version}"`);
  if (input.outline) clash("outline=true");
  if (input.pattern !== undefined) clash(`pattern="${input.pattern}"`);
  if (input.full) clash("full=true");
  if (input.include !== undefined) clash(`include="${input.include}"`);
  if (input.from !== undefined) clash("from");
  if (input.to !== undefined) clash("to");
  if (input.context !== undefined) clash("context");
  if (input.line !== undefined) clash("line");
  if (input.column !== undefined) clash("column");
}

/**
 * `view="digest"` — a one-page, bounded overview (issue #110). Everything
 * that decides WHAT the sections say lives in `../adt/digest.ts`
 * (`buildDigestSections`, `scanDependencies`, `scanProgramInterface`,
 * `countTestClasses`, `summarisePublicApi`) — this function's only job is
 * fetching the ADT facts those pure functions need and shaping them into a
 * `DigestInput`. Read-only throughout: no fluid, no extra gate, the same
 * `pool.withRead` path as an ordinary read, so it stays available under
 * `ABAP_MODE=read`.
 *
 * Where-used is deliberately never fetched — see `digest.ts`'s module
 * comment; `buildDigestSections` itself names the `abap_search
 * {"mode":"where_used"}` call in its own notes.
 */
async function readDigest(
  conn: AbapConnection,
  obj: ResolvedObject,
  baseHeader: Record<string, string | number | undefined>,
  input: ReadInput,
  maxChars: number,
): Promise<BuiltResponse & { etag: string }> {
  if (!isDigestType(obj.type)) {
    throw new AbapError(
      "UNSUPPORTED",
      `view="digest" supports ${DIGEST_TYPES.join(", ")}; ${obj.type} ${obj.name} is not one of ` +
        "those.",
      { type: obj.type, name: obj.name, supported: DIGEST_TYPES },
      "Drop view for an ordinary read, or point digest at a CLAS/OC, INTF/OI, PROG/P, FUGR/F, " +
        "FUGR/FF or DDLS/DF object.",
    );
  }

  // ---- version feed: last-changed fact + recent history rows -------------
  const entries = await listRevisions(conn, obj, undefined);
  const released = releasedVersions(entries);
  const lastChangedSource: "released" | "active" = released.length > 0 ? "released" : "active";
  const latest = released[0] ?? entries[0];
  const lastChanged = latest
    ? [latest.date, latest.author ? `by ${latest.author}` : undefined, `(version ${latest.versionId || "?"})`]
        .filter((p): p is string => Boolean(p))
        .join(" ")
    : undefined;
  const history: DigestHistoryEntry[] = entries.map((e) => ({
    version: e.versionId || "?",
    date: e.date || undefined,
    author: e.author || undefined,
    note: e.description || undefined,
  }));

  // ---- source: dependency scan, PROG/P interface scan -------------------
  const { source } = await readSource(conn, obj, undefined, undefined);
  const dependencies = scanDependencies(source, { selfName: obj.name });

  // ---- public API -----------------------------------------------------
  const extraNotes: string[] = [];
  let publicApi: DigestPublicApi;
  if (OUTLINE_KINDS.has(obj.kind)) {
    const members = await classMembers(conn, obj);
    publicApi = {
      ...summarisePublicApi(members),
      // Outline really is the source of these rows for CLAS/INTF —
      // outline=true genuinely returns more when this section is
      // truncated, and "no rows" here really does mean the outline scan
      // found nothing public.
      fullCallLine: `abap_read {"object":"${obj.name}","outline":true}`,
      emptyText: "(no public components found by the outline scan)",
    };
  } else if (obj.type === "PROG/P") {
    const pi = scanProgramInterface(source);
    publicApi = {
      rows: [
        ...pi.parameters.map((name) => ({ name, kind: "parameter" })),
        ...pi.selectOptions.map((name) => ({ name, kind: "select-option" })),
        ...pi.forms.map((name) => ({ name, kind: "form" })),
      ],
      hiddenCounts: [],
      // outline=true is refused for PROG/P (OUTLINE_KINDS is CLAS/INTF
      // only) — the rows above came from a static scan of the source
      // itself, so re-reading that source is what actually has the rest.
      fullCallLine: `abap_read {"object":"${obj.name}","type":"PROG/P"}`,
      emptyText: "(no parameters, select-options or forms found by the source scan)",
    };
    if (pi.hasStartOfSelection) extraNotes.push("START-OF-SELECTION is present in this program's source.");
  } else if (obj.type === "FUGR/FF") {
    // The function module's own signature IS its public API — scanned from
    // the source already fetched above for the dependency scan (see
    // digest.ts's module comment). `scanFunctionSignature` tries the NATIVE
    // `FUNCTION <name> IMPORTING ... .` signature statement first — issue
    // #108's live verifier found that is what ADT actually serves on a real
    // system (A4H), keywords upper- or lowercase — and falls back to the
    // LEGACY ADT-generated `*"*"Local Interface:` comment block only when
    // the native parse finds nothing. `optional` has no separate column of
    // its own: it is folded into `detail` (spelling: "<typing> (optional)",
    // or bare "(optional)" for a DEFAULT/OPTIONAL exception/RAISING line,
    // which carries no typing) so the row shape stays the same
    // {name, kind, detail} every other branch uses.
    const { form, parameters: params } = scanFunctionSignature(source);
    publicApi = {
      rows: params.map((p) => {
        const detail = [p.typing || undefined, p.optional ? "(optional)" : undefined]
          .filter((s): s is string => s !== undefined)
          .join(" ");
        return { name: p.name, kind: p.kind, detail: detail || undefined };
      }),
      // A function module's interface has no private/protected half to hide
      // counts for — everything IMPORTING/EXPORTING/CHANGING/TABLES/
      // EXCEPTIONS/RAISING declares is already the whole public signature.
      hiddenCounts: [],
      // outline=true is refused for FUGR/FF ("has no ADT component
      // structure to list") — the rows above came from the source scan
      // above, so re-reading that source (with `type` to disambiguate from
      // FUGR/F, the function group) is what actually has the rest.
      fullCallLine: `abap_read {"object":"${obj.name}","type":"FUGR/FF"}`,
      emptyText: "(no parameters found by the source scan)",
    };
    if (params.length === 0) {
      if (form === "native") {
        // issue #108 defect: the native FUNCTION statement WAS found and
        // walked — this is not a failed scan, the module genuinely
        // declares no parameters (e.g. RFC_PING). The note used to be the
        // both-forms-tried one below regardless, which was simply false
        // for this case.
        extraNotes.push(
          `PUBLIC API is empty for ${obj.name}: its native "FUNCTION ${obj.name} ... ." statement was ` +
            "found and parsed, and it declares no IMPORTING, EXPORTING, CHANGING, TABLES, EXCEPTIONS or " +
            "RAISING clause at all — this module takes nothing, returns nothing and raises no exception. " +
            "That is its real signature, not a limitation of this scan.",
        );
      } else {
        extraNotes.push(
          `PUBLIC API is empty for ${obj.name}: its source carries neither a parseable native ` +
            '"FUNCTION … IMPORTING/EXPORTING/… ." signature statement (the form ADT serves on this system) ' +
            'nor the legacy generated "Local Interface:" comment block — a real outcome (the source is ' +
            "malformed, hand-edited, or shaped in a way this scan does not recognise), not a limitation of " +
            "this tool.",
        );
      }
    }
  } else if (obj.type === "DDLS/DF") {
    // The projected field list IS the view's public API. `scanCdsFields`
    // deliberately returns [] for the whole view rather than a partial list
    // when it meets anything it isn't confident about (see its doc comment
    // in digest.ts) — an empty result here means "could not parse
    // confidently", not "this view has no fields".
    const fields = scanCdsFields(source);
    publicApi = {
      rows: fields.map((name) => ({ name, kind: "field" })),
      hiddenCounts: [],
      // outline=true is refused for DDLS/DF ("has no ADT component
      // structure to list") — the rows above came from the source scan
      // above, so re-reading that source (with `type` for symmetry with
      // the other non-outline branches) is what actually has the rest.
      fullCallLine: `abap_read {"object":"${obj.name}","type":"DDLS/DF"}`,
      emptyText: "(no fields found by the source scan)",
    };
    if (fields.length === 0) {
      extraNotes.push(
        `PUBLIC API is empty for ${obj.name}: its select list could not be parsed confidently — e.g. ` +
          "no recognisable `select from { ... }` projection block, a bare (non-navigated) association " +
          "exposed in the list, or an entry that is a cast, function call, sub-select or otherwise not " +
          "a plain field reference. This is not a statement that the view projects no fields.",
      );
    }
  } else {
    // FUGR/F only reaches here: listing a function group's function modules
    // needs a search call (there is no /objectstructure-style listing for a
    // FUGR/F group), and this view deliberately never makes one — see this
    // function's module comment on where-used for the same reasoning.
    publicApi = {
      rows: [],
      hiddenCounts: [],
      // Never truncated (rows is always []), but still named accurately:
      // no outline scan runs here at all, so outline=true would be as much
      // a dead end as it is for the other non-outline types.
      fullCallLine: `abap_search {"query":"${obj.name}"}`,
      emptyText: "(FUGR/F lists no modules directly — see note below)",
    };
    extraNotes.push(
      `PUBLIC API is empty for ${obj.type}: listing a function group's modules needs a search call, ` +
        'which this view does not make — use abap_search to list FUGR/F\'s modules, or point digest ' +
        "at one of them directly (FUGR/FF).",
    );
  }

  // ---- tests: testclasses include, CLAS only -----------------------------
  let tests: DigestTests;
  if (obj.kind === "CLAS") {
    let testSource = "";
    let hasInclude = true;
    try {
      const r = await readSource(conn, obj, "testclasses", undefined);
      testSource = r.source;
    } catch (e) {
      if (e instanceof AbapError && e.code === "NOT_FOUND") {
        hasInclude = false;
      } else {
        throw e;
      }
    }
    tests = {
      hasTestInclude: hasInclude && testSource.trim() !== "",
      testClassCount: hasInclude ? countTestClasses(testSource) : 0,
      testCall: `abap_test {"object":"${obj.name}"}`,
      atcCall: `abap_atc {"object":"${obj.name}"}`,
    };
  } else {
    tests = {
      hasTestInclude: false,
      testClassCount: 0,
      testCall: `abap_test {"object":"${obj.name}"}`,
      atcCall: `abap_atc {"object":"${obj.name}"}`,
    };
  }

  const nextSteps: string[] = [
    `Read the full source: abap_read {"object":"${obj.name}"}`,
    ...(OUTLINE_KINDS.has(obj.kind)
      ? [`See the full component list: abap_read {"object":"${obj.name}","outline":true}`]
      : []),
    `See the full version history: abap_read {"object":"${obj.name}","view":"history"}`,
  ];

  const digestInput: DigestInput = {
    header: {
      type: obj.type,
      name: obj.name,
      packageName: obj.packageName,
      description: obj.description,
      // No source for `responsible` in this codebase's existing read
      // machinery (ResolvedObject carries none) — left undefined (optional
      // on DigestHeader) rather than fabricated.
      lastChanged,
      lastChangedSource,
      activationState: obj.activation,
    },
    publicApi,
    dependencies,
    tests,
    history,
    nextSteps,
  };

  const { sections, notes } = buildDigestSections(digestInput, {
    maxRowsPerSection: DIGEST_MAX_ROWS_PER_SECTION,
  });

  const built = buildResponse({
    header: { ...baseHeader, view: "digest" },
    sections,
    notes: [...notes, ...extraNotes],
    maxChars,
  });
  return { ...built, etag: NO_ETAG };
}

/**
 * Every parameter that means nothing for a `catalogRead` type: there is no
 * ADT resource, so no source/outline/history/raw-XML axis exists to apply
 * them to. Refused the same way from/to/context are refused against a
 * non-diff read — naming the parameter, not silently discarding it.
 */
const CATALOG_READ_IRRELEVANT_PARAMS = [
  "method",
  "outline",
  "pattern",
  "full",
  "enhancements",
  "version",
  "view",
  "from",
  "to",
  "context",
  "include",
  "types",
  "depth",
  "format",
  "field",
] as const;

/**
 * Renders SUSO/B (authorization object) and TABL/DI (table secondary index)
 * from catalog tables — the two `catalogRead` types, dispatched by `abapRead`
 * on the explicit `type` hint before `resolveObject` ever runs, since
 * neither has a URI to resolve. Shares `buildDdicLikeResponse` with the DDIC
 * branch so both produce the same response shape.
 */
async function readCatalogObject(
  conn: AbapConnection,
  input: ReadInput,
  catalogRead: { readonly from: string; readonly nameForm: string },
  label: string,
  maxChars: number,
): Promise<BuiltResponse & { etag: string }> {
  const code = input.type!.trim().toUpperCase();
  for (const param of CATALOG_READ_IRRELEVANT_PARAMS) {
    if (input[param] !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `${param} is not supported for ${label} (${code}): this type has no ADT resource, so ` +
          `abap_read renders it directly from the catalog (${catalogRead.from}) with no source, ` +
          "outline, history or raw-XML axis to apply it to.",
        { type: code, param },
        `Drop ${param}.`,
      );
    }
  }

  const header: Record<string, string | number | undefined> = {
    system: conn.cfg.sid,
    mode: "catalog",
  };

  if (code === "SUSO/B") {
    const obj = await readAuthorizationObject(conn, input.object);
    const rendered = renderAuthorizationObject(obj);
    return buildDdicLikeResponse(
      rendered,
      { ...header, object: `${code} ${obj.name}` },
      input.offset,
      input.limit,
      [SUSO_WHERE_USED_NOTE],
      maxChars,
    );
  }

  // TABL/DI: <TABLE>/<INDEX> renders one index, bare <TABLE> lists them all.
  const parts = input.object.split("/");
  const trimmedParts = parts.map((p) => p.trim());
  const isListRoute = trimmedParts.length === 1 && trimmedParts[0] !== "";
  const isSingleIndexRoute = trimmedParts.length === 2 && trimmedParts[0] !== "" && trimmedParts[1] !== "";
  if (!isListRoute && !isSingleIndexRoute) {
    throw new AbapError(
      "BAD_INPUT",
      `"${input.object}" is not a valid ${code} name: expected ${catalogRead.nameForm}.`,
      { object: input.object, type: code },
      'Name one index as <TABLE>/<INDEX>, e.g. "ZTAB/Z01", or give the bare table name to list every ' +
        'secondary index: abap_read {"object":"ZTAB","type":"TABL/DI"}.',
    );
  }

  if (isListRoute) {
    const table = parts[0]!.trim().toUpperCase();
    const { indexes, notes } = await readTableIndexes(conn, table);
    const rendered = renderSecondaryIndexList(table, indexes);
    rendered.notes.push(...notes);
    const hints = [
      `abap_read {"object":"${table}/<INDEX>","type":"TABL/DI"} renders one index on its own.`,
      `abap_read {"object":"${table}","type":"TABL/DT"} shows the table's own structure.`,
    ];
    return buildDdicLikeResponse(rendered, { ...header, object: `${code} ${table}` }, input.offset, input.limit, hints, maxChars);
  }

  const [table, indexId] = parts as [string, string];
  const TABLE = table.trim().toUpperCase();
  const ID = indexId.trim().toUpperCase();
  const hint = `abap_read {"object":"${TABLE}","type":"TABL/DI"} lists every secondary index of the table; ` +
    `abap_read {"object":"${TABLE}","type":"TABL/DT"} shows its structure.`;
  const { index, indexes, notes } = await readSecondaryIndex(conn, table, indexId);
  if (index === undefined) {
    const existing = indexes.map((i) => i.id);
    throw new AbapError(
      "NOT_FOUND",
      `Table ${TABLE} has no secondary index ${ID} in DD12V on this system — ` +
        (existing.length > 0 ? `its secondary indexes are ${existing.join(", ")}` : "it has no secondary index at all") +
        ` (definitive empty result: HTTP 200, 0 rows for ${ID}, not a refused read).`,
      { table: TABLE, index: ID, existing },
      hint,
    );
  }
  const rendered = renderSecondaryIndex(index);
  rendered.notes.push(...notes);
  return buildDdicLikeResponse(
    rendered,
    { ...header, object: `${code} ${index.table}/${index.id}` },
    input.offset,
    input.limit,
    [hint],
    maxChars,
  );
}

/**
 * Argument-only checks for issue #148's `pattern`/`full` — decidable
 * before resolveObject's first request, so they cost no round trip.
 * `full` contradicts anything narrower; `pattern` has its own line frame
 * (offset= is where scanning starts, limit= the match cap), so method= and
 * outline= are refused rather than silently reinterpreted (G-08).
 */
function assertPatternAndFullArgs(input: ReadInput): void {
  if (input.full) {
    for (const [param, value] of [
      ["outline=true", input.outline || undefined],
      ["method", input.method],
      ["pattern", input.pattern],
    ] as const) {
      if (value !== undefined) {
        throw new AbapError(
          "BAD_INPUT",
          `full=true asks for the whole source; ${param} asks for part of it — both cannot be honoured.`,
          { object: input.object, param: "full", with: param },
          `Drop full, or drop ${param}.`,
        );
      }
    }
  }
  if (input.pattern === undefined) return;
  if (input.pattern === "") {
    throw new AbapError(
      "BAD_INPUT",
      "pattern is empty — an empty regex matches every line, which is a plain read, not a filter.",
      { object: input.object, param: "pattern" },
      "Pass a regex, or drop pattern to read the source.",
    );
  }
  try {
    new RegExp(input.pattern, "i");
  } catch (e) {
    throw new AbapError(
      "BAD_INPUT",
      `pattern is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`,
      { object: input.object, param: "pattern", pattern: input.pattern },
      "Fix the regex (JavaScript syntax, matched case-insensitively per line).",
    );
  }
  for (const [param, value] of [
    ["outline=true", input.outline || undefined],
    ["method", input.method],
  ] as const) {
    if (value !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `pattern cannot be combined with ${param}: pattern filters the document's own lines ` +
          "(absolute line numbers), which is a different answer from a component list or one method's block.",
        { object: input.object, param: "pattern", with: param },
        `Drop ${param} (pattern already narrows the read), or drop pattern.`,
      );
    }
  }
}

/**
 * `pattern`/`full` only mean something on the plain source path; every
 * other rendering (raw XML, enhancement decode, pseudo-DDL) would discard
 * them — refused, naming the parameter, like from/to/context are.
 */
function refuseSourceOnlyParams(input: ReadInput, obj: ResolvedObject, why: string): void {
  for (const [param, value] of [
    ["pattern", input.pattern],
    ["full", input.full || undefined],
  ] as const) {
    if (value !== undefined) {
      throw new AbapError(
        "UNSUPPORTED",
        `${param} is only meaningful for a source read; ${why} for ${obj.type} ${obj.name}.`,
        { type: obj.type, name: obj.name, param },
        `Drop ${param}.`,
      );
    }
  }
}

export async function abapRead(
  conn: AbapConnection,
  input: ReadInput,
  maxChars: number,
  gate?: SafetyGate,
): Promise<BuiltResponse & { etag: string }> {
  // Decidable from the argument alone, before resolveObject's first request,
  // so it must not cost a round trip. Enforced here too, not just by the v1
  // schema's closed z.enum, since abapRead is also called directly (tests,
  // v2) and v2 forbids closed enums. `ccau` is SE24's name for `testclasses`
  // — a mistake a caller will actually make.
  if (input.include !== undefined) assertClassInclude(input.include, input.object);
  assertPatternAndFullArgs(input);

  // SUSO/B and TABL/DI have no ADT resource, so resolveObject cannot reach
  // them (see capabilities.ts's `catalogRead`). Dispatch on the explicit type
  // hint first: the catalog render needs the name, not a URI.
  const catalogCap = input.type ? capabilitiesFor(input.type) : undefined;
  if (catalogCap?.catalogRead) {
    return readCatalogObject(conn, input, catalogCap.catalogRead, catalogCap.label, maxChars);
  }

  // `SIMG` (see the `type` schema's doc comment) addresses an IMG activity,
  // never a real ADT object — it exists only to spell a docu request, so
  // any other view is refused here, loudly, rather than falling through to
  // resolveObject and mis-resolving as "no ABAP object named SIMG... found".
  const pseudoType = input.type?.split("/")[0]?.toUpperCase();
  if (pseudoType === "SIMG" && input.view !== "docu") {
    throw new AbapError(
      "UNSUPPORTED",
      'type="SIMG" only addresses an IMG activity\'s documentation, which needs view="docu" — there ' +
        "is no ADT object of type SIMG to read any other way.",
      { type: input.type, view: input.view },
      'Add view="docu", or drop type="SIMG" and pass the real ADT type of what you meant to read.',
    );
  }

  // A bare "FUGR" is genuinely ambiguous between the function group (FUGR/F)
  // and a single function module (FUGR/FF) — digest.ts's isDigestType
  // already refuses it bare for exactly that reason (see its doc comment),
  // but that check never gets a chance to run: resolveObject normalises a
  // bare "FUGR" to FUGR/F before readDigest ever sees obj.type, so the
  // ambiguity was silently resolved by then. Caught here instead, against
  // the caller's raw type, before resolveObject runs — same place and
  // pattern as the SIMG pseudo-type check just above. Case-insensitive and
  // whitespace-tolerant like that check's `pseudoType` comparison; only a
  // BARE "FUGR" is refused — "FUGR/F" and "FUGR/FF" are untouched, and so is
  // every view other than "digest".
  if (input.view === "digest" && input.type?.trim().toUpperCase() === "FUGR") {
    throw new AbapError(
      "UNSUPPORTED",
      'type="FUGR" is ambiguous for view="digest": it could mean the whole function group (FUGR/F) ' +
        "or a single function module (FUGR/FF), and digest needs to know which.",
      { type: input.type, view: input.view },
      'Pass type="FUGR/F" to digest the function group, or type="FUGR/FF" to digest one function ' +
        "module.",
    );
  }

  // MSAG and SIMG-under-docu both bypass resolveObject entirely, decided
  // here from the caller's raw type/object, before resolveObject ever runs:
  //  - MSAG: a message's identity is class + number ("ZSD 042"), and a
  //    number exists nowhere but the caller's own input — resolveObject
  //    resolves ADT OBJECTS, and "ZSD 042" is not a valid ADT object name at
  //    all (the space alone makes resolveObject's parser reject it outright,
  //    BAD_INPUT, before it would ever get a chance to return an object with
  //    the number silently dropped). Passing obj.name here instead of
  //    input.object would therefore not even paper over the bug — readDocu
  //    would simply never be reached.
  //  - SIMG: an IMG activity has no ADT object type of its own for
  //    resolveObject to resolve against at all (see docu.ts's
  //    imgDocuTarget doc comment) — there is no ResolvedObject to build a
  //    target or header from, ever, by construction.
  // Every OTHER type keeps going through resolveObject and obj.name below,
  // in readDocu — only these two lack a real ADT object to resolve.
  if (input.view === "docu" && (pseudoType === "MSAG" || pseudoType === "SIMG")) {
    const kind = pseudoType === "MSAG" ? "message class" : "IMG activity";
    assertDocuBypassCompatible(input, kind);
    const g = requireDocuGate(gate, { type: input.type, object: input.object, view: input.view });
    const target =
      pseudoType === "MSAG"
        ? resolveDocuTarget({ type: "MSAG", object: input.object })
        : imgDocuTarget(input.object);
    const baseHeader: Record<string, string | number | undefined> = {
      system: conn.cfg.sid,
      object: `${pseudoType} ${input.object}`,
    };
    return await renderDocuTarget(conn, target, baseHeader, maxChars, g);
  }

  const obj = await resolveObject(conn, input.object, input.type ? { type: input.type } : {});

  const baseHeader: Record<string, string | number | undefined> = {
    system: obj.system,
    object: `${obj.type} ${obj.name}`,
    uri: obj.uri,
    package: obj.packageName,
    description: obj.description,
  };

  // ------------------------------------------------ version history / diff ---
  // Placed first: `view` asks about HISTORY, not current-definition
  // rendering, so it must not fall through into a branch below.
  if (input.view !== undefined) {
    assertViewCompatible(input, obj);
    if (input.view === "history") return await readHistory(conn, obj, baseHeader, input, maxChars);
    if (input.view === "diff") return await readDiff(conn, obj, baseHeader, input, maxChars);
    if (input.view === "lineage") return await readLineage(conn, obj, baseHeader, input, maxChars);
    if (input.view === "footprint") return await readFootprint(conn, obj, baseHeader, input, maxChars);
    // gate may be undefined here: readDocu's method= branch needs none, and
    // checks that for itself before the object-based branch (the one that
    // does need it) calls requireDocuGate.
    if (input.view === "docu") return await readDocu(conn, obj, baseHeader, input, maxChars, gate);
    if (input.view === "digest") return await readDigest(conn, obj, baseHeader, input, maxChars);
    return await readDefinition(conn, obj, baseHeader, input, maxChars);
  }
  // from/to/context only parameterise `view`; silently ignoring them would
  // answer a diff request with an ordinary read (the G-08 failure). `include`
  // used to be refused here too — now routed into the source
  // read below, with unsupported combinations refused by assertIncludeCompatible.
  for (const [param, value] of [
    ["from", input.from],
    ["to", input.to],
  ] as const) {
    if (value !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `${param} is only meaningful with view="diff"; no view was requested, so this would ` +
          "have been an ordinary source read with your parameter discarded.",
        { type: obj.type, name: obj.name, param },
        `Add view="diff", or drop ${param}.`,
      );
    }
  }
  // `context` is shared by view="diff" (hunk context) and pattern= (lines
  // around a match, issue #148); with neither it would be discarded.
  if (input.context !== undefined && input.pattern === undefined) {
    throw new AbapError(
      "BAD_INPUT",
      'context is only meaningful with view="diff" or pattern; neither was requested, so this ' +
        "would have been an ordinary source read with your parameter discarded.",
      { type: obj.type, name: obj.name, param: "context" },
      'Add view="diff" or pattern="<regex>", or drop context.',
    );
  }
  // line/column only parameterise `view="definition"` — same shape as the
  // from/to/context loop above, kept separate because the message names a
  // different view and a caller who passed line/column almost certainly
  // meant to ask for a definition lookup, not a diff.
  for (const [param, value] of [
    ["line", input.line],
    ["column", input.column],
  ] as const) {
    if (value !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `${param} is only meaningful with view="definition"; no view was requested, so this ` +
          "would have been an ordinary source read with your parameter discarded.",
        { type: obj.type, name: obj.name, param },
        `Add view="definition", or drop ${param}.`,
      );
    }
  }
  // field only parameterises `view="lineage"` — same shape as the
  // line/column loop above, kept separate because the message names a
  // different view.
  if (input.field !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      'field is only meaningful with view="lineage"; no view was requested, so this would have ' +
        "been an ordinary source read with your parameter discarded.",
      { type: obj.type, name: obj.name, param: "field" },
      'Add view="lineage", or drop field.',
    );
  }
  // types/depth only parameterise a DEVC/K package listing; silently
  // discarding them against any other type would be the same G-08 failure
  // from/to/context are refused for above.
  for (const [param, value] of [
    ["types", input.types],
    ["depth", input.depth],
  ] as const) {
    if (value !== undefined && obj.type !== "DEVC/K") {
      throw new AbapError(
        "BAD_INPUT",
        `${param} is only meaningful for a DEVC/K package read; ${obj.type} ${obj.name} is not a ` +
          "package, so this would have been an ordinary read with your parameter discarded.",
        { type: obj.type, name: obj.name, param },
        `Drop ${param}, or read a package instead.`,
      );
    }
  }

  const include = assertIncludeCompatible(input, obj);
  const ignoredIncludeNotes = includeIgnoredNote(input, obj);

  // ------------------------------------------------------------------ raw ---
  // Placed ahead of every other mode: a request for the wire document
  // itself, not a rendering choice within source/ddic/enhancements.
  if (input.format === "raw") {
    refuseSourceOnlyParams(input, obj, 'format="raw" returns the XML descriptor, not source lines');
    if (input.version) {
      throw new AbapError(
        "UNSUPPORTED",
        `version="${input.version}" is not supported with format="raw": the raw XML descriptor ` +
          "always reflects the current definition, the same as a plain GET would.",
        { type: obj.type, name: obj.name, requested: input.version },
        'Omit version. version is only meaningful for source-mode reads (CLAS, INTF, PROG, …).',
      );
    }
    if (capabilitiesFor(obj.type)?.write?.shape !== "properties") {
      throw new AbapError(
        "UNSUPPORTED",
        `format="raw" is only defined for the properties-shape types (${PROPERTIES_SHAPE_TYPES.join(", ")}); ` +
          `${obj.type} ${obj.name} is not one of those.`,
        { type: obj.type, name: obj.name },
        `Omit format — the default read already returns ${
          obj.mode === "ddic" ? "a rendered definition" : "raw source"
        } for ${obj.type}, which is what a "source" shape write for this type needs anyway.`,
      );
    }
    const body = await fetchRawDescriptor(conn, obj);
    const etag = resourceEtag(body);
    // ADT emits this document as ONE line (SAP's MSAG/N "SY" measured at
    // ~320,000 chars, zero newlines). buildResponse's truncation can only
    // keep/drop WHOLE lines, which for one giant line means keeping none of
    // it — so offset/limit address CHARACTERS here instead, windowed BEFORE
    // buildResponse sees the body (bodyTotalLines left unset so it stays out
    // of the way; header/notes assembly and the hard clamp still apply).
    const charTotal = body.length;
    const charOffset = Math.min(Math.max(0, (input.offset ?? 1) - 1), charTotal);
    // Comfortably under maxChars so buildResponse's fast non-truncating path
    // is always taken here — the truncating path mishandles a single long line.
    const defaultWindowChars = Math.max(1000, maxChars - 6000);
    const requestedLimit = input.limit;
    const windowChars = Math.min(requestedLimit ?? defaultWindowChars, defaultWindowChars);
    const windowText = body.slice(charOffset, charOffset + windowChars);
    const nextOffset = charOffset + windowText.length + 1;
    const hasMore = charOffset + windowText.length < charTotal;
    // `forceIncomplete`, not `built.truncated`: buildResponse can't tell this
    // was windowed by characters before it saw the body. A properties-shape
    // write PUTs this exact document back, so an unmarked partial one is
    // the same data-loss risk with an XML body instead of ABAP source.
    const built = buildSourceResponse(
      {
        header: { ...baseHeader, mode: "raw", etag, totalChars: charTotal },
        body: windowText,
        bodyLabel: "XML DESCRIPTOR",
        notes: [
          ...ignoredIncludeNotes,
          "This is the exact ADT XML document — the same shape a properties-shape write must PUT " +
            "back to this object's own URI (not /source/main, which does not exist for this type). " +
            "It is NOT the pseudo-DDL abap_read renders by default; round-trip fidelity is exact " +
            "(this document, edited in place, is a valid PUT body) except for server-managed fields " +
            "documented as such (e.g. a domain fixed value's position is assigned by the server, " +
            "never sent by the client).",
          hasMore
            ? `offset/limit address CHARACTERS in format="raw" (this document is one line): showing ` +
              `${charOffset + 1}-${charOffset + windowText.length} of ${charTotal}. Fetch the rest ` +
              `with offset=${nextOffset}.`
            : `Full descriptor shown (${charTotal} characters).`,
          ...(requestedLimit && requestedLimit > defaultWindowChars
            ? [`limit=${requestedLimit} was clamped to ${defaultWindowChars} characters to stay under the response budget.`]
            : []),
        ],
        hints: [
          "Element order can be significant (e.g. TTYP/DA's <ttyp:builtInType>/<ttyp:rangeType> " +
            "must both be present, even empty, inside <ttyp:rowType> — see skills/ddic/SKILL.md).",
        ],
        maxChars,
      },
      etag,
      windowText.length < charTotal,
    );
    return built;
  }

  // ------------------------------------------------------- enhancements ---
  if (input.enhancements) {
    refuseSourceOnlyParams(input, obj, "enhancements=true renders a decoded enhancement document, not source lines");
    if (!ENHANCEMENT_KINDS.has(obj.kind)) {
      throw new AbapError(
        "UNSUPPORTED",
        `enhancements=true is only meaningful for a BAdI implementation (ENHO/XH), ` +
          `source-code plug-in (ENHO/XHH) or enhancement spot (ENHS); ${obj.type} ${obj.name} ` +
          `resolved to kind ${obj.kind}.`,
        { type: obj.type, name: obj.name, kind: obj.kind },
        "Omit enhancements, or point it at a BAdI implementation, source-code plug-in or enhancement spot.",
      );
    }
    return readEnhancementObject(conn, obj, baseHeader, input, maxChars);
  }

  // ---------------------------------------------------------------- DDIC ---
  if (obj.mode === "ddic") {
    refuseSourceOnlyParams(input, obj, `${obj.type} is rendered as pseudo-DDL from the dictionary, not read as source lines`);
    // G-08: not a silent normalisation — `active` is accepted only because it
    // names the no-op that already happens (disclosed below in a note), and
    // nothing is rewritten to get there. `inactive` asserts a state the
    // pseudo-DDL renderer has no concept of, so that value is still refused.
    if (input.version === "inactive") {
      throw new AbapError(
        "UNSUPPORTED",
        `version="inactive" is not supported for ${obj.type} ${obj.name}: ` +
          "DDIC reads (TABL, DTEL, DOMA, TTYP) always render the current definition.",
        { type: obj.type, name: obj.name, requested: input.version },
        'Omit version for DDIC objects. Omitting it and passing version="active" return the same bytes.',
      );
    }
    // depth for DEVC/K used to be bounded by zod's `.max(3)` on the schema
    // (see the `depth` schema comment above) — that bound moved into code
    // because view="lineage" now shares this parameter with a different
    // maximum. This is the one place read.ts calls readDdic for a package
    // listing, so it is the one place that has to re-assert DEVC/K's own
    // bound: refused, never silently clamped (G-08). The earlier
    // types/depth loop already guarantees obj.type === "DEVC/K" here
    // whenever input.depth is set.
    if (obj.type === "DEVC/K" && input.depth !== undefined && input.depth > DEVC_MAX_DEPTH) {
      throw new AbapError(
        "BAD_INPUT",
        `depth=${input.depth} exceeds the maximum for DEVC/K (${DEVC_MAX_DEPTH}); refused, not clamped.`,
        { type: obj.type, name: obj.name, depth: input.depth, max: DEVC_MAX_DEPTH },
        `Use depth between 1 and ${DEVC_MAX_DEPTH}.`,
      );
    }
    let rendered: Awaited<ReturnType<typeof readDdic>>;
    try {
      rendered = await readDdic(conn, obj, { types: input.types, depth: input.depth });
    } catch (e) {
      // readDdic's UNSUPPORTED message only lists what IS renderable, not
      // format:"raw" (a capabilities.ts concept, kept out of ddic.ts to avoid
      // an import cycle). Campaign-observed: an agent hit this for MSAG/N and
      // went on to fail 8 straight abap_write calls guessing the shape.
      // Re-point at format:"raw" here, the one place with both pieces.
      if (e instanceof AbapError && e.code === "UNSUPPORTED" && capabilitiesFor(obj.type)?.write?.shape === "properties") {
        throw new AbapError(
          e.code,
          e.message,
          e.details,
          `Use abap_read {object, type, format: "raw"} instead — ${obj.type} writes a full XML ` +
            "descriptor (not source), and format:\"raw\" returns that exact document, which is " +
            "the shape to imitate for the write.",
        );
      }
      throw e;
    }
    if (input.version === "active") {
      rendered.notes.push(
        'version="active" had no effect here: a DDIC read always renders the current definition, ' +
          "which is what active names. Omit it — the bytes are identical either way.",
      );
    }
    rendered.notes.push(...ignoredIncludeNotes);
    // `rendered.hashInput` used to be readDdic's pseudo-DDL rendering for a
    // properties-shape type — hashing a RENDERING was the root cause of the
    // measured etag-mismatch bug (see resourceEtag's doc comment). Fixed
    // without a second HTTP round-trip: readDdic's XML-only readers
    // (ddic.ts) now set `hashInput` to the same raw bytes they already
    // fetched once via `fetchDdicXml`, for every DDIC mode.
    return buildDdicLikeResponse(
      rendered,
      { ...baseHeader, mode: "ddic" },
      input.offset,
      input.limit,
      ["Use abap_search with mode=where_used to find consumers of this object."],
      maxChars,
    );
  }

  // -------------------------------------------------------------- source ---
  // `include` is passed explicitly, not left to readSource's own fallback:
  // this is the one place deciding which document the response is about,
  // disclosed in the header and, for a non-main include, in a note naming
  // the exact URI.
  // The signature route (`method=` + include="definitions") reads MAIN: the
  // global class's declarations are in the main document, and the component
  // structure numbers lines against it. CCDEF holds local definitions.
  const methodWanted = input.method ?? obj.member;
  const declarationOnly = Boolean(methodWanted) && include === "definitions";
  const {
    source,
    serverEtag,
    sourceUri: readUri,
  } = await readSource(conn, obj, declarationOnly ? "main" : include, input.version);
  const etag = resourceEtag(source);
  const header: Record<string, string | number | undefined> = {
    ...baseHeader,
    mode: "source",
    ...(include ? { include } : {}),
    ...(include && include !== "main" ? { uri: readUri } : {}),
    etag,
    serverEtag,
  };
  // Never silent: say which document these bytes are, and that the others
  // exist too — an agent unaware tests live in a separate document writes
  // them into the class body instead.
  const includeNotes: string[] =
    include && include !== "main"
      ? [
          `These bytes are class include "${include}" (${readUri}) ONLY — not ${obj.name}'s main ` +
            `source. ADT stores each include as its own document; ${CLASS_INCLUDES.filter(
              (i) => i !== include,
            ).join(", ")} are elsewhere and are not shown here. The etag above covers this ` +
            "include alone.",
          ...(input.version
            ? [
                `version="${input.version}" was sent as the query parameter on this include's own ` +
                  "GET, exactly as it is for a main-source read — it was NOT applied by reading " +
                  "main instead. Whether ADT honours the active/inactive selector per include is " +
                  "UNVERIFIED here; if the returned bytes look active when you asked for " +
                  'inactive, treat that as the server ignoring the parameter, and use view="history" ' +
                  "on this include to see what versions it actually has.",
              ]
            : []),
        ]
      : [...ignoredIncludeNotes];
  const sourceHints: string[] =
    include && include !== "main"
      ? [
          "offset/limit page this include. method= and outline=true are refused alongside a " +
            "non-main include — both describe the class body, which is a different document.",
        ]
      : [
          'Read a single method with method="<NAME>".',
          "Get the component list first with outline=true.",
          'pattern="<regex>" returns only matching lines (numbered, with context).',
          ...(obj.kind === "CLAS"
            ? [
                'Local and test classes are NOT in this source: read them with include="testclasses" ' +
                  '(ABAP Unit), "definitions", "implementations" or "macros".',
              ]
            : []),
        ];

  const totalLines = countLines(source);
  const totalChars = source.length;
  const method = input.method ?? obj.member;

  // ------------------------------------------------- pattern (issue #148) ---
  // grep -n -C over the document: only matching lines, absolute line
  // numbers (the offset= frame), `context` lines around each. The etag is
  // marked partial: a pattern read never shows the whole text, so a
  // full-source write presenting it would be exactly the truncated-read
  // write-back TRUNCATED_SOURCE_NOTE exists for.
  if (input.pattern !== undefined) {
    const context = input.context ?? PATTERN_DEFAULT_CONTEXT;
    const maxMatches = input.limit ?? PATTERN_MAX_MATCHES;
    const grep = grepSource(source, input.pattern, {
      context,
      fromLine: input.offset ?? 1,
      maxMatches,
    });
    const partialEtag = markEtagPartial(etag);
    const nextOffset = grep.lastShownLine !== undefined ? grep.lastShownLine + 1 : undefined;
    const truncLine = grep.truncated
      ? `--- TRUNCATED --- ${grep.shown} of ${grep.total} matching line(s) shown (cap ${maxMatches}` +
        `${input.limit === undefined ? ", raise with limit=" : ""}). Continue with offset=${nextOffset}, ` +
        "or narrow the pattern."
      : undefined;
    const body = [
      grep.text ||
        `(no line of ${obj.type} ${obj.name}${include && include !== "main" ? ` include "${include}"` : ""}` +
          ` matches /${input.pattern}/i${input.offset ? ` from line ${input.offset}` : ""})`,
      truncLine,
    ]
      .filter((s): s is string => s !== undefined)
      .join("\n");
    const built = buildReadResponse({
      header: {
        ...header,
        etag: partialEtag,
        pattern: input.pattern,
        context,
        matches: grep.total,
        matchesShown: grep.shown,
        ...(input.offset ? { scannedFrom: input.offset } : {}),
        totalLines,
        totalChars,
      },
      body,
      bodyLabel: "MATCHES",
      notes: [
        ...includeNotes,
        "Matches only, not the whole text: line numbers are absolute (read around one with " +
          "offset/limit), `:` marks a matching line, `-` a context line. The etag is marked " +
          "`partial:` — abap_write's edit={old_string,new_string} accepts it; a full-source " +
          "rewrite is refused.",
      ],
      hints: ["Narrow the pattern, or lower context, to fit more matches in one response."],
      maxChars,
    });
    return { ...built, etag: partialEtag };
  }

  // ---------------------------------------------- outline (issue #148) ---
  // Explicit outline=true, or the DEFAULT for a large CLAS/INTF/PROG/FUGR
  // when nothing narrower (method/include/offset/limit) and nothing wider
  // (full=true, outline=false) was asked for.
  const aboveThreshold = totalLines > OUTLINE_DEFAULT_LINES || totalChars > OUTLINE_DEFAULT_CHARS;
  const outlineByDefault =
    input.outline === undefined &&
    !input.full &&
    method === undefined &&
    include === undefined &&
    input.offset === undefined &&
    input.limit === undefined &&
    DEFAULT_OUTLINE_KINDS.has(obj.kind) &&
    aboveThreshold;
  if (input.outline || outlineByDefault) {
    const defaultNotes = outlineByDefault
      ? [
          `${obj.type} ${obj.name} is ${totalLines} lines / ${totalChars} chars — above the ` +
            `default-outline threshold (${OUTLINE_DEFAULT_LINES} lines or ${OUTLINE_DEFAULT_CHARS} ` +
            "chars), so this is the OUTLINE, not the source. Read a part with " +
            `${OUTLINE_KINDS.has(obj.kind) ? 'method="<NAME>", ' : ""}pattern="<regex>" or ` +
            `offset/limit, or the whole ${totalLines}-line source with full=true.`,
        ]
      : [];
    const outlineHeader = {
      ...header,
      outline: outlineByDefault ? "default (large source)" : "requested",
      totalLines,
      totalChars,
    };
    const partHints = [
      ...(OUTLINE_KINDS.has(obj.kind) ? ['Read one component with method="<NAME>".'] : []),
      'pattern="<regex>" returns only matching lines; offset/limit page the source; full=true reads all of it.',
    ];
    if (OUTLINE_KINDS.has(obj.kind)) {
      // Issue #147: the structure is resolved against the inactive version
      // when one exists (falling back to active); `structureVersion` says which.
      const own = await classMembersFor(conn, obj, input.version);
      const members = own.members;
      const ownOutline = renderOutline(members);
      // Issue #146 (2): public/protected members the class gets from its
      // superclasses and interfaces, grouped by the defining object. The
      // chain comes from INHERITING FROM / INTERFACES in the source already
      // in hand — zero extra requests for a class that names no parent.
      const chain = await inheritedMembers(conn, obj, source, members, input.version);
      const inheritedOutline = renderInheritedOutline(chain.inherited);
      const sections: string[] = [];
      if (ownOutline) sections.push(ownOutline);
      else if (inheritedOutline) {
        sections.push(`  (${obj.name} declares no methods, attributes or events of its own)`);
      }
      if (inheritedOutline) {
        sections.push(
          "",
          `INHERITED (${chain.inherited.length} public/protected members declared on ` +
            `${obj.name}'s superclasses/interfaces; method="<NAME>" resolves them automatically):`,
          inheritedOutline,
        );
      }
      const outline = sections.join("\n");
      const window = sliceLines(outline, input.offset ?? 1, input.limit);
      const notes = [...includeNotes, ...defaultNotes];
      if (chain.unresolved.length) {
        notes.push(
          "Inheritance chain incomplete — not readable on this system: " +
            chain.unresolved
              .map((u) => `${u.name} (${u.relation} of ${u.via}: ${u.reason})`)
              .join("; ") +
            ". Members declared there are not listed.",
        );
      }
      const built = buildReadResponse({
        header: {
          ...outlineHeader,
          components: members.length,
          inherited: chain.inherited.length,
          structureVersion: own.version,
        },
        body: outline
          ? window.text
          : `(${obj.type} ${obj.name} really has no methods, attributes or events — the ` +
            `component structure came back empty${
              chain.searched.length ? ` and so did ${chain.searched.join(", ")}'s` : ""
            }.)`,
        bodyLabel: "OUTLINE",
        bodyOffset: outline ? window.offset : undefined,
        bodyTotalLines: outline ? window.total : undefined,
        pagingParam: "offset",
        notes,
        hints: [
          ...partHints,
          ...(inheritedOutline
            ? [
                'Inherited members work the same way: method="<NAME>" walks the chain and reports ' +
                  "foundOn. Their line numbers are the defining object's.",
              ]
            : []),
          'To learn a signature, use method="<NAME>" with include="definitions" (declaration only); ' +
            "do not read the full class.",
        ],
        maxChars,
      });
      return { ...built, etag };
    }
    if (obj.kind === "PROG" || obj.kind === "FUGR") {
      // No ADT component structure for these — a statement table of
      // contents scanned from the text, said to be exactly that.
      const rows = scanSourceStructure(source);
      const built = buildReadResponse({
        header: { ...outlineHeader, components: rows.length },
        body: rows.length
          ? renderSourceStructure(rows)
          : `(the text scan found no FORM/FUNCTION/MODULE/CLASS/METHOD/INCLUDE statement or event ` +
            `block in ${obj.type} ${obj.name}'s ${totalLines} lines — this is a scan of statement ` +
            "keywords, NOT a statement that the program has no components.)",
        bodyLabel: "OUTLINE",
        notes: [
          ...includeNotes,
          ...defaultNotes,
          `${obj.type} has no ADT component structure; this outline is a text scan of statement-` +
            "initial keywords (REPORT/INCLUDE/FORM/FUNCTION/MODULE/CLASS/METHOD/INTERFACE and " +
            "event blocks) with their END lines. Line numbers are offset= positions in this document.",
        ],
        hints: partHints,
        maxChars,
      });
      return { ...built, etag };
    }
    // Outline is a CLASS/INTERFACE (ADT) or PROG/FUGR (text scan) feature;
    // for other types "(no components)" would misread as "genuinely has none".
    const built = buildReadResponse({
      header: { ...header, totalLines },
      body:
        `(outline is NOT SUPPORTED for ${obj.type} — it is implemented for classes and ` +
        `interfaces (ADT component structure) and programs/function groups (statement scan) ` +
        `only. This is a tool limitation, NOT a statement that ${obj.name} has no components.)`,
      bodyLabel: "OUTLINE",
      notes: [
        `outline=true was ignored: ${obj.type} has no component structure to list. ` +
          `Re-read without outline (optionally with offset/limit or pattern) to see the source.`,
      ],
      hints: ["Re-read without outline=true, using offset/limit to page the source."],
      maxChars,
    });
    return { ...built, etag };
  }

  // Method-level read.
  if (method) {
    // Issue #146: the chain (superclasses, then interfaces) is walked when
    // the object itself lacks the member; `foundOn` says where it came from.
    // Issue #147: members resolve against the inactive version when one
    // exists. include="definitions" narrows the answer to the declaration.
    const m = await readMethod(conn, obj, source, method, {
      version: input.version,
      inherited: true,
    });
    const parts = (declarationOnly ? [m.declaration] : [m.declaration, m.implementation])
      .filter(Boolean)
      .join("\n\n");
    const origin = m.foundOn;
    const originLabel = origin
      ? `${origin.name} (${origin.relation} of ${origin.via}, depth ${origin.depth})`
      : undefined;
    const methodNotes: string[] = [...ignoredIncludeNotes];
    if (origin) {
      methodNotes.push(
        `${m.member.name} is not declared by ${obj.name}; it comes from ${originLabel}. ` +
          `The block below and its line numbers are ${origin.name}'s, not ${obj.name}'s ` +
          `(searched: ${m.searched.join(" -> ")}).`,
      );
    }
    if (m.version === "inactive" && input.version !== "inactive") {
      methodNotes.push(
        `${origin?.name ?? obj.name} has a newer INACTIVE version; the method was resolved ` +
          "against it (ADT's default read returns that newest version too).",
      );
    }
    if (declarationOnly) {
      methodNotes.push(
        'include="definitions" with method= returns the declaration only, cut from the class ' +
          "definition in the main document (the CCDEF local-definitions include holds nothing " +
          "global). Drop include to get the implementation as well.",
      );
    }
    // FRAME MISMATCH (fixed): body here is the method block, so its line
    // count is RELATIVE to it. Passing the absolute source line as
    // bodyOffset while totalLines stayed relative produced notices like
    // "lines 250..289 of 40" and made an agent page forever without
    // advancing. offset/window/total are now all in the method-block frame.
    const window = sliceLines(parts, input.offset ?? 1, input.limit);
    // Also marked when the block itself is cut: write.ts's METHOD/ENDMETHOD
    // balance checks are SHAPE checks, not extent checks — a truncated-but-
    // balanced body splices in fine and silently shortens the method.
    return buildSourceResponse(
      {
        header: {
          ...header,
          method: m.member.name,
          visibility: m.member.visibility,
          foundOn: originLabel,
          structureVersion: m.version,
          // Absolute position in the object, for orientation only — never used as
          // the paging frame.
          sourceLines: m.implementationRange
            ? `${m.implementationRange.startLine}-${m.implementationRange.endLine}`
            : undefined,
          blockLines: parts ? window.total : undefined,
        },
        body: parts
          ? window.text
          : declarationOnly
            ? `(no METHODS declaration for ${m.member.name} found in ${origin?.name ?? obj.name}'s ` +
              "definition — ADT lists the component but the definition text does not declare it " +
              "under that name, e.g. an interface method implemented as IF~METHOD)"
            : "(no source found for this component)",
        bodyLabel: declarationOnly ? "METHOD DECLARATION" : "METHOD SOURCE",
        bodyOffset: parts ? window.offset : undefined,
        bodyTotalLines: parts ? window.total : undefined,
        notes: methodNotes,
        hints: [
          "`offset` here is relative to this method block (line 1 = first line shown above), " +
            "not to the object's source lines.",
          ...(declarationOnly
            ? ["Drop include=\"definitions\" to read the implementation as well."]
            : [
                'To learn a signature only, use method= with include="definitions"; do not read ' +
                  "the full class.",
              ]),
          "Omit `method` to read the whole object, or use outline=true for the component list.",
        ],
        pagingParam: "offset",
        maxChars,
      },
      etag,
    );
  }

  // FUGR/FF only: one extra GET for the module descriptor's processing type.
  // Never fails the read — errors are swallowed and the fields just omitted.
  let fmoduleHeader: Record<string, string> = {};
  if (obj.type === "FUGR/FF") {
    try {
      const descriptor = await conn.get(obj.uri, { headers: { Accept: "application/*" } });
      const processingType = parseProcessingType(descriptor.body ?? "");
      if (processingType !== undefined) {
        fmoduleHeader = { processing_type: processingType, remote_enabled: processingType === "rfc" ? "yes" : "no" };
      }
    } catch {
      // Omit processing_type/remote_enabled below.
    }
  }

  const window = sliceLines(source, input.offset ?? 1, input.limit);
  // Whole-object read: its body IS the exact text a full-source abap_write
  // replaces, so an incomplete body is data loss waiting to
  // happen — buildSourceResponse marks the etag `partial:` when it is.
  const wholeObjectRead = include === undefined || include === "main";
  const firstPage = (input.offset ?? 1) <= 1;

  // Issue #179: Fixed Point Arithmetic isn't in the source, only the
  // descriptor XML — one extra GET, best-effort. Any failure (older
  // release, network) just omits the line rather than failing the read.
  let fixPointArithmeticHeader: Record<string, string> = {};
  if (obj.type === "PROG/P" && wholeObjectRead) {
    try {
      const descriptor = await conn.get(obj.uri, {
        headers: { Accept: "application/vnd.sap.adt.programs.programs.v3+xml" },
      });
      const fpa = parseFixPointArithmetic(descriptor.body);
      if (fpa !== undefined) fixPointArithmeticHeader = { fixed_point_arithmetic: String(fpa) };
    } catch {
      // omit
    }
  }

  // Issue #182: the text pool (symbols/selection texts) is a separate
  // sub-resource, not part of this source — shown only on the first page of
  // a whole-object read, best-effort like the flag above.
  const textPoolSections: Array<{ title: string; content: string }> = [];
  if (obj.type === "PROG/P" && wholeObjectRead && firstPage) {
    try {
      const pool = await readTextPool(conn, obj.name);
      if (pool) textPoolSections.push({ title: "TEXT POOL", content: renderTextPool(pool) });
    } catch {
      // omit
    }
  }

  // Rebuilt (not just `{...header, fixed_point_arithmetic}`) so the new key
  // lands right after `description`, not at the end — a plain spread would
  // append it since it is new to this object.
  const wholeHeader: Record<string, string | number | undefined> = {
    system: header.system,
    object: header.object,
    uri: header.uri,
    package: header.package,
    description: header.description,
    ...fixPointArithmeticHeader,
    ...(header.mode !== undefined ? { mode: header.mode } : {}),
    ...(header.include !== undefined ? { include: header.include } : {}),
    ...(header.etag !== undefined ? { etag: header.etag } : {}),
    ...(header.serverEtag !== undefined ? { serverEtag: header.serverEtag } : {}),
  };

  return buildSourceResponse(
    {
      header: { ...wholeHeader, ...fmoduleHeader, totalLines: window.total, totalChars },
      sections: textPoolSections,
      body: window.text,
      bodyLabel: "SOURCE",
      bodyOffset: window.offset,
      bodyTotalLines: window.total,
      notes: source === "" ? [...includeNotes, EMPTY_SOURCE_NOTE] : includeNotes,
      hints: sourceHints,
      pagingParam: "offset",
      maxChars,
    },
    etag,
  );
}

/**
 * One side of a cross-system comparison (issue #93) — everything
 * `runCrossSystemDiff` (`read-systems.ts`) needs to read an object off ONE
 * configured system: its own pool, its own gate, its own connection
 * bootstrap. Declared here, not imported from `../systems/registry.ts`,
 * so this file (and `read-systems.ts`) has no compile-time dependency on
 * the multi-system composition layer — only on this narrow shape.
 * `SystemContext` (`../systems/registry.ts`) satisfies this structurally;
 * nothing here assumes it is the only thing that ever will.
 */
export interface ReadSystemSide {
  readonly alias: string;
  readonly cfg: Config;
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
}

export interface ReadToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  // Widened from `Pick<Config, "maxResponseChars">`: `view="docu"` routes
  // through `dispatchDisabledError`/`fluidDisabledReason` (see
  // `registerReadTools` below), both of which need the full `Config`, not
  // just the response-size field every other view uses.
  readonly cfg: Config;
  /**
   * Every configured system, for cross-system `view="diff"`
   * (`from_system`/`to_system`) — issue #93. `undefined` on a
   * single-system server exactly like `multiSystem` below; the two always
   * agree (`multiSystem` is `true` iff this is set), kept as two fields
   * rather than one so the schema-inclusion check (`multiSystem`) reads as
   * a plain boolean at the call site instead of an existence check on an
   * object whose only use is that check.
   */
  readonly systems?: {
    readonly aliases: readonly string[];
    resolve(alias?: string): ReadSystemSide;
  };
  /**
   * True when more than one system is configured. Gates whether
   * `from_system`/`to_system` are spliced into the registered schema at
   * all (see `registerReadTools`) — keeping a single-system server's
   * schema bytes exactly as they were, since a lone-system deployment has
   * no second system to name.
   */
  readonly multiSystem?: boolean;
}

/**
 * No tool this server registers declares an `outputSchema` (grep
 * `outputSchema` in `src/` — nothing), and `structuredContent` used to be
 * returned here anyway. Per the MCP spec a client that PREFERS structured
 * content when present has no schema-driven reason to also render `content`
 * — Claude Code is exactly such a client, so the agent got only the counter
 * dict (etag/truncated/hasMore/returnedLines/totalLines/estimatedTokens)
 * and NONE of the ABAP source, making `abap_read` unusable there. A tool
 * that doesn't declare `outputSchema` must not emit `structuredContent`, so
 * this only returns `content`, matching `abap_search`/`abap_journal`.
 *
 * The facts that used to live in `structuredContent` (truncated/
 * hasMore/returnedLines/totalLines/estimatedTokens) are not lost — they now
 * live inside `res.text` itself, added by `buildReadResponse` (above) as one
 * header line for a complete response, or already stated in full by the
 * `--- WINDOW ---`/`--- TRUNCATED ---` notice `buildResponse` emits for an
 * incomplete one. Do not resurrect a second output channel for them here;
 * fix `buildReadResponse` instead if a fact is missing from the text.
 */
const okRead = (res: BuiltResponse & { etag: string }): CallToolResult => ({
  content: [{ type: "text", text: res.text }],
});

/**
 * Validates a cross-system `view="diff"` request (`from_system`/
 * `to_system`, issue #93) and resolves both sides, or refuses with a
 * structured `AbapError` naming exactly which combination is unsupported.
 * Runs before either side's connection is opened — a refusal here costs
 * nothing beyond parsing the input. `input.include` is deliberately never
 * refused: a class include is legitimate on both sides of a cross-system
 * comparison (e.g. comparing `testclasses` on two systems), and is honoured
 * by `runCrossSystemDiff` exactly like an ordinary read honours it.
 */
function resolveCrossSystemSides(
  input: ReadInput & { from_system?: string; to_system?: string },
  deps: ReadToolDeps,
): { from: ReadSystemSide; to: ReadSystemSide } {
  if (!deps.multiSystem || !deps.systems) {
    throw new AbapError(
      "BAD_INPUT",
      "from_system/to_system name a system to compare against, but this server has only one " +
        `configured system (${deps.cfg.sid}) — there is nothing to compare it to.`,
      { object: input.object, system: deps.cfg.sid },
      "Configure a second system to enable cross-system diff; see doc/CONFIGURATION/multi-system.md.",
    );
  }
  if (input.view !== "diff") {
    throw new AbapError(
      "BAD_INPUT",
      "from_system/to_system is only meaningful with view=\"diff\"; " +
        (input.view === undefined
          ? "no view was requested"
          : `view="${input.view}" was requested instead`) +
        ", so this would have been answered by a different view entirely with your parameter discarded.",
      { object: input.object, view: input.view },
      'Add view="diff", or drop from_system/to_system.',
    );
  }
  // `from`/`to` select a VERSION on one system's history feed; a
  // cross-system diff compares CURRENT active source across two
  // independent systems instead — there is no shared version feed for
  // either to select from. `context` (hunk context lines) IS still
  // meaningful here and is deliberately not refused.
  for (const [param, value] of [
    ["from", input.from],
    ["to", input.to],
  ] as const) {
    if (value !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `${param} selects a version on one system's history feed; a cross-system diff (from_system/` +
          `to_system) compares the CURRENT ACTIVE source of ${input.object} on two different systems ` +
          `instead — two independent SAP systems share no version feed for ${param} to select from.`,
        { object: input.object, param },
        `Drop ${param}, or drop from_system/to_system and compare two versions on one system instead.`,
      );
    }
  }

  const from = deps.systems.resolve(input.from_system);
  const to = deps.systems.resolve(input.to_system);
  if (from.alias === to.alias) {
    throw new AbapError(
      "BAD_INPUT",
      `from_system and to_system both resolved to "${from.alias}" — a cross-system diff compares two ` +
        "DIFFERENT systems; comparing a system against itself would always report no differences for " +
        "current active source.",
      { object: input.object, alias: from.alias },
      "Name a different to_system, or drop from_system/to_system and use from/to to compare two " +
        `versions on ${from.alias} instead.`,
    );
  }

  // Every other view="diff" param that answers a narrower question than
  // "the whole object's current source" — mirrors the abapRead param-
  // refusal loops above, one message per parameter so the caller learns
  // exactly which one to drop rather than a generic "unsupported input".
  for (const [param, value] of [
    ["method", input.method],
    ["outline", input.outline],
    ["pattern", input.pattern],
    ["full", input.full],
    ["line", input.line],
    ["column", input.column],
    ["types", input.types],
    ["depth", input.depth],
  ] as const) {
    if (value !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `${param} is not meaningful for a cross-system diff: from_system/to_system compares the ` +
          `current active source of ${input.object} as a whole on two systems, not a single ` +
          "component, source position, or package listing within it.",
        { object: input.object, param },
        `Drop ${param}.`,
      );
    }
  }

  return { from, to };
}

/**
 * Registers `abap_read` on the given MCP server. Reads either raw source
 * (CLAS/INTF/PROG/FUGR/DDLS/DDLX/BDEF/SRVD) or a rendered pseudo-DDL
 * definition (TABL/STRU/DTEL/DOMA/TTYP), via `pool.withRead` — no write gate
 * needed since this tool never touches the wire for anything but a read.
 *
 * `view="definition"` ({@link readDefinition}) stays on this same
 * `pool.withRead`/`safety.assert("read")` path even though its
 * elementinfo/navigation-target/usageReferences calls are HTTP POSTs that
 * carry the object's full source in the request body — unlike
 * `abap_quick_fix`, which POSTs source to the SAME kind of ADT endpoint
 * (`evaluateQuickFixes`) but is gated as a WRITE, because a quick-fix's
 * whole purpose is to hand back an edit `abap_write` can apply. Definition
 * lookup can't: every one of its endpoints is ADT's own read-only
 * "what/where is this" surface, and none of it is capable of returning
 * anything `abap_write` would act on. A POST body here is an artefact of
 * the wire protocol, not evidence of a side effect — so the tool's own
 * read/write classification tracks what the call CAN do to the system, not
 * which HTTP verb happens to carry the request.
 *
 * `view="digest"` ({@link readDigest}) is likewise plain `pool.withRead` —
 * it only reads source/outline/history through machinery this file already
 * uses elsewhere, so it needs nothing this function's existing read path
 * doesn't already provide.
 *
 * `view="docu"` ({@link readDocu}, without `method=`) is the one exception:
 * SAP's documentation store (DOKHL/DOKIL/DOKTL) has no ADT REST endpoint, so
 * it is read through the fluid `core.docu` action, which deploys/calls a
 * small generated ABAP class the same way `abap_search`'s `mode="source"`
 * deploys `ZCL_ZMCP_FLUID_SCAN` (see `src/tools/search.ts`). That needs the
 * fluid API and a write-capable session/pool slot even though the caller is
 * only asking to read — routed here through the exact same
 * fluid-disabled-check-then-`pool.withWrite` shape `abap_search` uses,
 * before falling through to the ordinary `pool.withRead` path every other
 * view (including `docu` WITH `method=`, which reads ABAP Doc from source
 * and needs no fluid tool at all) takes.
 */
export function registerReadTools(mcp: McpServer, deps: ReadToolDeps): void {
  mcp.registerTool(
    "abap_read",
    {
      title: "Read ABAP object",
      description:
        "Read an ABAP object: source, pseudo-DDL, a DEVC/K package listing, or (SUSO/B, TABL/DI) " +
        "a read-only catalog render; view= selects docu/digest/history/diff/definition/lineage/" +
        "footprint. A CLAS/INTF/PROG/FUGR source above 150 lines or 8k chars answers with its " +
        "outline by default — then method=, pattern= (regex, with context), offset/limit, or " +
        "full=true. To learn a method's signature, use method= with include=\"definitions\" " +
        "(declaration only); method= also finds inherited members (superclasses and interfaces) " +
        "and reports foundOn. Returns an etag; capped ~15k tokens, truncation marked. " +
        "Example: {\"object\":\"ZCL_FOO\",\"type\":\"CLAS/OC\"}.",
      // `from_system`/`to_system` (issue #93, cross-system view="diff")
      // are spliced in only when more than one system is configured —
      // a single-system server has nothing a second system field could
      // ever name, so its schema bytes stay exactly what they always were.
      inputSchema: deps.multiSystem ? { ...readInputSchema, ...crossSystemInputSchema } : readInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        // `args as ReadInput & {...}`, not `as never` — see the comment on
        // the plain-`ReadInput` cast further down for why this matters.
        // `from_system`/`to_system` are cast here unconditionally: on a
        // single-system server they are simply never present in `args`
        // (dropped by the schema, which never declared them), so this
        // widening is safe regardless of `deps.multiSystem`.
        const input = args as ReadInput & { from_system?: string; to_system?: string };

        // Cross-system diff (issue #93): checked FIRST, before this call
        // touches the DEFAULT system's connection/pool/gate at all — both
        // sides open their own connection and assert their own gate inside
        // `runCrossSystemDiff`/`fetchCrossSystemSide`, never the default's.
        if (input.from_system !== undefined || input.to_system !== undefined) {
          const { from, to } = resolveCrossSystemSides(input, deps);
          const built = await runCrossSystemDiff({
            from,
            to,
            input,
            maxChars: deps.cfg.maxResponseChars,
          });
          return okRead({ ...built, etag: NO_ETAG });
        }

        // `view="docu"` without `method=` is the only branch that needs a
        // fluid write slot (see this function's JSDoc); every other input,
        // `docu` WITH `method=` included, stays on the ordinary read path
        // below. Mirrors `abap_search`'s `mode="source"` routing in
        // `src/tools/search.ts` exactly: fluid-disabled check first (a more
        // specific reason than a generic write-denied would give on a
        // read-only connection), then a preflight write-target assert, then
        // `pool.withWrite`.
        if (input.view === "docu" && input.method === undefined) {
          await deps.ensureConnected();
          deps.safety.assert("read");
          const disabled = fluidDisabledReason(deps.cfg, deps.safety);
          if (disabled) {
            throw dispatchDisabledError(disabled, deps.cfg, {
              tool: CORE_TOOL_ID,
              action: "docu",
              args: { object: input.object, type: input.type },
              caller: { tool: "abap_read", action: "docu" },
            });
          }
          deps.safety.assert(
            "write",
            { name: CORE_BODY_CLASS, packageName: FLUID_PACKAGE, type: "CLAS/OC" },
            { phase: "preflight" },
          );
          const res = await deps.pool.withWrite("abap_read", CORE_BODY_CLASS, (conn) =>
            abapRead(conn, input, deps.cfg.maxResponseChars, deps.safety),
          );
          return okRead(res);
        }

        await deps.ensureConnected();
        deps.safety.assert("read");
        // `args as ReadInput`, never `as never`: the MCP SDK hands the
        // callback zod's PARSED output, which silently drops fields the
        // schema doesn't declare — casting to the type DERIVED from the
        // registered schema turns that drift into a compile error. Already
        // cost two shipped defects in abap_write before this fix. Load-
        // bearing in all ten tool registrations — do not weaken to `never`.
        const res = await deps.pool.withRead("abap_read", (conn) =>
          abapRead(conn, input, deps.cfg.maxResponseChars),
        );
        return okRead(res);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
