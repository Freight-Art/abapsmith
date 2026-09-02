/**
 * `abap_read` — reads ABAP objects as source or rendered pseudo-DDL.
 *
 * Axes (composable, each opt-in beyond the default source/ddic read):
 *  - mode: source (CLAS·INTF·PROG·FUGR·DDLS·DDLX·BDEF·SRVD·XSLT) or
 *    ddic (TABL·TABL/DS·DTEL·DOMA·TTYP → pseudo-DDL, never raw XML).
 *  - `enhancements=true`: decode ENHO/XH, ENHO/XHH, ENHS via
 *    `../adt/enhancement.ts` instead of the source/ddic paths.
 *  - `view`: asks about the object's HISTORY, not its current definition.
 *    "history" lists the ADT version feed; "diff" returns unified-diff hunks
 *    between two versions, never two full sources. See `../adt/revisions.ts`
 *    and `../diff.ts`.
 *  - `include`: class-only. ADT stores each of a class's five sections
 *    (main/definitions/implementations/macros/testclasses) as its own
 *    document; applies to the source read and `view` alike — see
 *    `sourceUriFor` (`../adt/source.ts`) and {@link assertIncludeCompatible}.
 *
 * Every response carries a content-hash `etag` and goes through the shared
 * compactor, except the `view` paths (see {@link NO_ETAG}).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AbapConnection } from "../adt/connection.js";
import { fetchDdicXml, readDdic } from "../adt/ddic.js";
import { capabilitiesFor, NON_READABLE_TYPES } from "../adt/capabilities.js";
import { AbapError } from "../adt/errors.js";
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
import { CLASS_INCLUDES, assertClassInclude, type ClassInclude } from "../adt/types.js";
import { DEFAULT_CONTEXT_LINES, diffSources, renderHunks } from "../diff.js";
import { classMembers, readMethod, readSource, renderOutline } from "../adt/source.js";
import {
  buildResponse,
  markEtagPartial,
  sliceLines,
  textTable,
  type BuiltResponse,
  type ResponseParts,
} from "../compact.js";
import { canonicalEtag } from "../adt/write.js";
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import type { SafetyGate } from "../safety.js";

export const readInputSchema = {
  object: z.string().describe('Name, "class X", "table Y", or ADT URI.'),
  type: z
    .string()
    .optional()
    .describe(`ADT type to disambiguate. Not readable: ${NON_READABLE_TYPES.join(" ")}.`),
  method: z.string().optional().describe("Only this method/component."),
  outline: z.boolean().optional().describe("Component list with line ranges."),
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
  // Closes a gap: DOMA/DTEL/TTYP/MSAG/ENQU write a full XML descriptor PUT,
  // but the default read only produced lossy pseudo-DDL (or UNSUPPORTED).
  // Gated by capabilitiesFor, not a type list — additive only.
  format: z
    .enum(["raw"])
    .optional()
    .describe("raw: XML, not pseudo-DDL (DOMA/DTEL/TTYP/MSAG/ENQU only)."),
  // Enum for the same reason as version/format (G-08): reject a typo rather
  // than silently falling through to an ordinary source read. Named `view`,
  // not `mode` — `mode` is already a response header key and `ResolvedObject.mode`.
  view: z
    .enum(["history", "diff"])
    .optional()
    .describe("history: versions. diff: hunks. Omit for normal read."),
  from: z.string().optional().describe('diff: older side — version, transport, or "active".'),
  to: z.string().optional().describe("diff: newer side, same forms as `from`."),
  context: z.number().int().min(0).max(20).optional().describe("diff: context lines per hunk. Default 3."),
  // C-6: ADT versions each class include (main/definitions/
  // implementations/macros/testclasses) as its own document, so silently
  // defaulting to `main` hides changes made in e.g. testclasses. Selectable
  // on both the source-read and `view` paths, always disclosed.
  include: z
    .enum(CLASS_INCLUDES)
    .optional()
    .describe('Class include. "testclasses"=Unit tests. Default "main".'),
};

export const ReadInput = z.object(readInputSchema);
export type ReadInput = z.infer<typeof ReadInput>;

/**
 * Kinds for which `outline=true` can actually produce a component list. ADT
 * serves `/objectstructure` components for object-oriented containers only —
 * a different fact from "has no components".
 */
export const OUTLINE_KINDS = new Set(["CLAS", "INTF"]);

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
function buildReadResponse(parts: ResponseParts): BuiltResponse {
  const first = buildResponse(parts);
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

/** Hunk ceiling for one diff response. Excess is reported, never dropped silently. */
const DIFF_MAX_HUNKS = 200;

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

  if (input.format) {
    clash(
      'format="raw"',
      "raw returns the current XML descriptor, which has no version feed behind it.",
      "Drop one of the two: view for history/diff, format for the current wire document.",
    );
  }
  if (input.enhancements) {
    clash(
      "enhancements=true",
      "the enhancement decoders read the current definition only.",
      "Drop enhancements, or drop view.",
    );
  }
  if (input.version) {
    clash(
      `version="${input.version}"`,
      'the active/inactive pair is a different axis from the version FEED; "inactive" is not a ' +
        "feed entry and has no history row.",
      'Use from/to to name feed versions (list them with view="history").',
    );
  }
  if (input.outline) {
    clash(
      "outline=true",
      "the outline lists the CURRENT component structure; ADT serves no per-version outline.",
      'Read the outline separately, without view.',
    );
  }
  if (input.method) {
    clash(
      `method="${input.method}"`,
      "ADT versions whole objects (or whole class includes), not individual methods, so there is " +
        "no per-method feed to read or diff.",
      "Drop method — the diff hunks already carry line numbers you can map back to a method.",
    );
  }
  if (input.include && obj.kind !== "CLAS") {
    clash(
      `include="${input.include}"`,
      `only a class has includes, and ${obj.type} ${obj.name} is not one.`,
      "Drop include — this object has a single version feed.",
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

/** The disclosure that goes with {@link viewInclude}. Never silent. */
function includeNote(include: ClassInclude | undefined): string[] {
  if (!include) return [];
  const others = CLASS_INCLUDES.filter((i) => i !== include);
  return [
    `This covers class include "${include}" ONLY. ADT versions each include separately, so a ` +
      `change made in ${others.join(", ")} does not appear here — re-run with include="…" to ` +
      "see those.",
  ];
}

/**
 * The include an ORDINARY (non-`view`) read is about, refusing every
 * combination it cannot honour. `sourceUriFor` (adt/source.ts)
 * guarantees a non-`main` include is never silently answered from main — but
 * format:"raw" (properties-shape DDIC only, never a class), enhancements
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
    throw new AbapError(
      "UNSUPPORTED",
      `${obj.type} ${obj.name} has no "${include}" include — class includes ` +
        `(${CLASS_INCLUDES.join(", ")}) exist only for classes.`,
      { type: obj.type, name: obj.name, requested: include },
      "Drop include. This object has a single source document, and it was NOT silently " +
        "returned in place of the include you asked for.",
    );
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
        "DDIC types (DOMA/DTEL/TTYP/MSAG/ENQU) — a class has none, and a class include is source.",
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
  if (method) {
    clash(
      `method="${method}"`,
      "the method's line range comes from the ADT component structure, which numbers lines in " +
        "the class's main document. Cutting those lines out of a different include would return " +
        "whatever happens to sit at them — not that method.",
      `Read include="${include}" in full and locate the method in it, or drop include to read ` +
        `${method} from the class body.`,
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

export async function abapRead(
  conn: AbapConnection,
  input: ReadInput,
  maxChars: number,
): Promise<BuiltResponse & { etag: string }> {
  // Decidable from the argument alone, before resolveObject's first request,
  // so it must not cost a round trip. Enforced here too, not just by the v1
  // schema's closed z.enum, since abapRead is also called directly (tests,
  // v2) and v2 forbids closed enums. `ccau` is SE24's name for `testclasses`
  // — a mistake a caller will actually make.
  if (input.include !== undefined) assertClassInclude(input.include, input.object);

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
    return input.view === "history"
      ? await readHistory(conn, obj, baseHeader, input, maxChars)
      : await readDiff(conn, obj, baseHeader, input, maxChars);
  }
  // from/to/context only parameterise `view`; silently ignoring them would
  // answer a diff request with an ordinary read (the G-08 failure). `include`
  // used to be refused here too — now routed into the source
  // read below, with unsupported combinations refused by assertIncludeCompatible.
  for (const [param, value] of [
    ["from", input.from],
    ["to", input.to],
    ["context", input.context],
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
  const include = assertIncludeCompatible(input, obj);

  // ------------------------------------------------------------------ raw ---
  // Placed ahead of every other mode: a request for the wire document
  // itself, not a rendering choice within source/ddic/enhancements.
  if (input.format === "raw") {
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
        `format="raw" is only defined for the properties-shape DDIC types (DOMA/DD, DTEL/DE, ` +
          `TTYP/DA, MSAG/N, ENQU/DL); ${obj.type} ${obj.name} is not one of those.`,
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
    let rendered: Awaited<ReturnType<typeof readDdic>>;
    try {
      rendered = await readDdic(conn, obj);
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
    // `rendered.hashInput` used to be readDdic's pseudo-DDL rendering for a
    // properties-shape type — hashing a RENDERING was the root cause of the
    // measured etag-mismatch bug (see resourceEtag's doc comment). Fixed
    // without a second HTTP round-trip: readDdic's XML-only readers
    // (ddic.ts) now set `hashInput` to the same raw bytes they already
    // fetched once via `fetchDdicXml`, for every DDIC mode.
    const etag = resourceEtag(rendered.hashInput);
    // offset/limit window the rendered DDL, so the paging hint stays truthful.
    const window = sliceLines(rendered.ddl, input.offset ?? 1, input.limit);
    const built = buildReadResponse({
      header: { ...baseHeader, ...rendered.meta, mode: "ddic", etag, totalLines: window.total },
      sections: rendered.sections,
      body: window.text,
      bodyLabel: "PSEUDO-DDL",
      bodyOffset: window.offset,
      bodyTotalLines: window.total,
      notes: rendered.notes,
      hints: ["Use abap_search with mode=where_used to find consumers of this object."],
      pagingParam: "offset",
      maxChars,
    });
    return { ...built, etag };
  }

  // -------------------------------------------------------------- source ---
  // `include` is passed explicitly, not left to readSource's own fallback:
  // this is the one place deciding which document the response is about,
  // disclosed in the header and, for a non-main include, in a note naming
  // the exact URI.
  const {
    source,
    serverEtag,
    sourceUri: readUri,
  } = await readSource(conn, obj, include, input.version);
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
      : [];
  const sourceHints: string[] =
    include && include !== "main"
      ? [
          "offset/limit page this include. method= and outline=true are refused alongside a " +
            "non-main include — both describe the class body, which is a different document.",
        ]
      : [
          'Read a single method with method="<NAME>".',
          "Get the component list first with outline=true.",
          ...(obj.kind === "CLAS"
            ? [
                'Local and test classes are NOT in this source: read them with include="testclasses" ' +
                  '(ABAP Unit), "definitions", "implementations" or "macros".',
              ]
            : []),
        ];

  // Outline: the cheap orientation pass.
  if (input.outline) {
    // Outline is a CLASS/INTERFACE-only feature (/objectstructure); for
    // other types "(no components)" would misread as "genuinely has none".
    if (!OUTLINE_KINDS.has(obj.kind)) {
      const built = buildReadResponse({
        header: { ...header, totalLines: source.split("\n").length },
        body:
          `(outline is NOT SUPPORTED for ${obj.type} — it is implemented for classes and ` +
          `interfaces only, via the ADT component structure. This is a tool limitation, ` +
          `NOT a statement that ${obj.name} has no components.)`,
        bodyLabel: "OUTLINE",
        notes: [
          `outline=true was ignored: ${obj.type} has no ADT component structure to list. ` +
            `Re-read without outline (optionally with offset/limit) to see the source.`,
        ],
        hints: ["Re-read without outline=true, using offset/limit to page the source."],
        maxChars,
      });
      return { ...built, etag };
    }
    const members = await classMembers(conn, obj);
    const outline = renderOutline(members);
    const window = sliceLines(outline, input.offset ?? 1, input.limit);
    const built = buildReadResponse({
      header: {
        ...header,
        components: members.length,
        totalLines: source.split("\n").length,
      },
      body: outline
        ? window.text
        : `(${obj.type} ${obj.name} really has no methods, attributes or events — the ` +
          `component structure came back empty.)`,
      bodyLabel: "OUTLINE",
      bodyOffset: outline ? window.offset : undefined,
      bodyTotalLines: outline ? window.total : undefined,
      hints: ['Read one component with method="<NAME>".'],
      pagingParam: "offset",
      maxChars,
    });
    return { ...built, etag };
  }

  // Method-level read.
  const method = input.method ?? obj.member;
  if (method) {
    const m = await readMethod(conn, obj, source, method);
    const parts = [m.declaration, m.implementation].filter(Boolean).join("\n\n");
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
          // Absolute position in the object, for orientation only — never used as
          // the paging frame.
          sourceLines: m.implementationRange
            ? `${m.implementationRange.startLine}-${m.implementationRange.endLine}`
            : undefined,
          blockLines: parts ? window.total : undefined,
        },
        body: parts ? window.text : "(no source found for this component)",
        bodyLabel: "METHOD SOURCE",
        bodyOffset: parts ? window.offset : undefined,
        bodyTotalLines: parts ? window.total : undefined,
        hints: [
          "`offset` here is relative to this method block (line 1 = first line shown above), " +
            "not to the object's source lines.",
          "Omit `method` to read the whole object, or use outline=true for the component list.",
        ],
        pagingParam: "offset",
        maxChars,
      },
      etag,
    );
  }

  const window = sliceLines(source, input.offset ?? 1, input.limit);
  // Whole-object read: its body IS the exact text a full-source abap_write
  // replaces, so an incomplete body is data loss waiting to
  // happen — buildSourceResponse marks the etag `partial:` when it is.
  return buildSourceResponse(
    {
      header: { ...header, totalLines: window.total },
      body: window.text,
      bodyLabel: "SOURCE",
      bodyOffset: window.offset,
      bodyTotalLines: window.total,
      notes: includeNotes,
      hints: sourceHints,
      pagingParam: "offset",
      maxChars,
    },
    etag,
  );
}

export interface ReadToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars">;
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
 * Registers `abap_read` on the given MCP server. Reads either raw source
 * (CLAS/INTF/PROG/FUGR/DDLS/DDLX/BDEF/SRVD) or a rendered pseudo-DDL
 * definition (TABL/STRU/DTEL/DOMA/TTYP), via `pool.withRead` — no write gate
 * needed since this tool never touches the wire for anything but a read.
 */
export function registerReadTools(mcp: McpServer, deps: ReadToolDeps): void {
  mcp.registerTool(
    "abap_read",
    {
      title: "Read ABAP object",
      description:
        "Read an ABAP object: source or pseudo-DDL. Returns an etag. Capped ~15k tokens — " +
        "use outline/method/offset for large objects. Example: {\"object\":\"ZCL_FOO\",\"type\":\"CLAS/OC\"}.",
      inputSchema: readInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        await deps.ensureConnected();
        deps.safety.assert("read");
        // `args as ReadInput`, never `as never`: the MCP SDK hands the
        // callback zod's PARSED output, which silently drops fields the
        // schema doesn't declare — casting to the type DERIVED from the
        // registered schema turns that drift into a compile error. Already
        // cost two shipped defects in abap_write before this fix. Load-
        // bearing in all ten tool registrations — do not weaken to `never`.
        const res = await deps.pool.withRead("abap_read", (conn) =>
          abapRead(conn, args as ReadInput, deps.cfg.maxResponseChars),
        );
        return okRead(res);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
