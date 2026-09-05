/**
 * `abap_bopf` / `abap_bopf_edit` / `abap_bopf_delete` — MCP tool layer over
 * `src/adt/bopf.ts` (the wire client) and `src/adt/bopf-xml.ts` (the
 * byte-splice engine).
 *
 * This module owns three things the wire client does not:
 *  - The two-phase safety gate (cheap zero-network preflight before
 *    `ensureConnected()`, final assert once the real package is known).
 *  - Dangling-reference preflights for the write path: `checkReferences` is
 *    advisory-only and can't see a ref an edit is about to INTRODUCE.
 *    `danglingRefPreflight` covers class refs on add_action/
 *    add_determination/add_validation/add_query; `actionRefPreflight` covers
 *    add_validation's trigger action/actionNode. See their doc comments.
 *  - Byte-level element assembly composing `bopf-xml.ts`'s primitives
 *    (`render*Element`, `spliceInsertChild`, `spliceOut`) into "take this
 *    operation, mutate this document", including the one root-level
 *    insertion `spliceInsertChild` doesn't handle (`insertNodeAtRoot`).
 *
 * `dry_run` on `abap_bopf_delete` is hand-rolled — `deleteBusinessObject` has
 * no dry-run concept, so this reports DDIC cascade candidates from the model
 * without probing their existence (that costs a round trip per candidate);
 * the dry-run list can therefore differ from what an armed delete finds.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AbapConnection } from "../adt/connection.js";
import type { SessionPool } from "../adt/pool.js";
import type { SessionTransport } from "../adt/session-transport.js";
import type { Config } from "../config.js";
import type { SafetyCorr, SafetyGate } from "../safety.js";
import { AbapError, isAbapError } from "../adt/errors.js";
import { buildResponse } from "../compact.js";
import { renderCoActivated } from "./activate.js";
import { readCurrentSource, type ResolvedTarget } from "../adt/write.js";
import { specForType } from "../adt/types.js";
import {
  readModel,
  createBusinessObject,
  putModel,
  activateBusinessObject,
  deleteBusinessObject,
  searchBusinessObjects,
  checkReferences,
  collectRefSites,
  collectDdicCascadeCandidates,
  ddicSparedReason,
  checkRootNodeName,
  DEFAULT_CHECK_REFS_MAX_SITES,
  BOPF_TYPE,
  bopfUri,
  resolvePersistentCascadeRequest,
  probeRequestedPersistentTargets,
  type BopfModelRead,
  type ActivationOutcomeBopf,
  type DeleteBusinessObjectResult,
  type DdicCandidate,
  type RequestedDdicTarget,
  type CreateBusinessObjectInput,
  type RootNodeNameCheck,
} from "../adt/bopf.js";
import { withJournalledMutation, journalRef, systemKey, type Journal } from "../journal.js";
import {
  scanModel,
  locate,
  locateToken,
  listChildNames,
  splice,
  spliceOut,
  spliceInsertChild,
  spliceSetNodeRef,
  spliceSetElementRef,
  patchOpenTagAttrs,
  escapeAttrValue,
  NODE_REF_KINDS,
  type NodeRefKind,
  renderNodeElement,
  renderAssociationElement,
  renderActionElement,
  renderDeterminationElement,
  renderValidationElement,
  renderQueryElement,
  renderAlternativeKeyElement,
  renderDeterminationTrigger,
  renderValidationTrigger,
  renderRelation,
  mintGuid,
  type Token,
  type Range,
  type Selector,
  type NodeSelector,
  type ChildElementKind,
  type NodeFields,
  type AssociationFields,
  type ActionFields,
  type DeterminationFields,
  type ValidationFields,
  type QueryFields,
  type AlternativeKeyFields,
} from "../adt/bopf-xml.js";
import type {
  BoModel,
  BoNode,
  AdtObjectRef,
  IntegrityFinding,
  BoAssociation,
  BoAction,
  BoDetermination,
  BoValidation,
  BoQuery,
  BoAlternativeKey,
} from "../adt/bopf-types.js";
import {
  ASSOCIATION_CHILD_ORDER,
  ACTION_CHILD_ORDER,
  DETERMINATION_CHILD_ORDER,
  VALIDATION_CHILD_ORDER,
  QUERY_CHILD_ORDER,
  ALTERNATIVE_KEY_CHILD_ORDER,
} from "../adt/bopf-types.js";
import { validateSpecKeys, SET_CHILD_FIELD_TABLES, type SpecFieldTable } from "./bopf-spec-keys.js";
import { classifyNodes, classifyAssociation, describeNodeKind, describeAssociationKind } from "../adt/bopf-node-kinds.js";
import {
  isDelegationOperation,
  validateDelegationShape,
  refuseHandAssembledDelegation,
  delegationModelPreflight,
  mutateDelegation,
  verifyDelegation,
  delegationNotes,
  type DelegationInput,
} from "./bopf-delegation.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const bopfInputSchema = {
  mode: z
    .enum(["show", "raw", "search", "check_refs"])
    .optional()
    .describe('Default "show" (digest). "raw" is the expensive escape hatch.'),
  bo: z.string().optional().describe("BOPF business object name. Required for show/raw/check_refs."),
  query: z.string().optional().describe("search: free-text filter."),
  object_type: z.string().optional().describe('search: required, e.g. "BOBF"; omitting it 400s.'),
  max_results: z.number().min(1).max(999_999).optional().describe("search: cap on returned hits."),
  max_sites: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(`check_refs: cap on sites probed. Default ${DEFAULT_CHECK_REFS_MAX_SITES}.`),
};

export const BopfInput = z.object(bopfInputSchema);
export type BopfInput = z.infer<typeof BopfInput>;

export const bopfEditInputSchema = {
  bo: z.string().describe("BOPF business object name."),
  operation: z
    .enum([
      "create_bo",
      "add_node",
      "remove_node",
      "add_association",
      "remove_association",
      "set_association_fields",
      "add_action",
      "remove_action",
      "set_action_fields",
      "add_determination",
      "remove_determination",
      "set_determination_fields",
      "add_validation",
      "remove_validation",
      "set_validation_fields",
      "add_query",
      "remove_query",
      "set_query_fields",
      "add_alternative_key",
      "remove_alternative_key",
      "set_alternative_key_fields",
      "set_node_flags",
      "remove_dependent_object",
      "activate",
    ])
    .describe("The single edit to make."),
  node: z.string().optional().describe("Node the edit targets."),
  nodeId: z.string().optional().describe("Disambiguator for a non-unique node name."),
  name: z
    .string()
    .optional()
    .describe(
      "Element name. Required except for create_bo/remove_node/set_node_flags/activate.",
    ),
  spec: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Per-operation fields — see the abapsmith-edit-a-bopf-object skill."),
  activate: z.boolean().optional().describe("Activate after the edit succeeds."),
  allow_dangling_ref: z
    .boolean()
    .optional()
    .describe("Accepts the dangling-ref risk that otherwise refuses the write."),
  i_know_this_may_not_activate: z
    .boolean()
    .optional()
    .describe("Required true for add_alternative_key and set_alternative_key_fields."),
  package: z.string().optional().describe("create_bo: local ($TMP-style) package, required."),
  description: z.string().optional().describe("create_bo: optional description."),
  rootNodeName: z.string().optional().describe('create_bo only: root node name, default "ROOT".'),
};

export const BopfEditInput = z.object(bopfEditInputSchema);
export type BopfEditInput = z.infer<typeof BopfEditInput>;

export const bopfDeleteInputSchema = {
  bo: z.string().describe("BOPF business object name to delete."),
  confirm: z.string().optional().describe("Echo bo (case-insensitive) to arm the delete; required when dry_run: false."),
  cascade_ddic: z
    .boolean()
    .optional()
    .describe(
      "Also sweep generated DDIC objects. Spares persistentTableRef/persistentStructureRef unless " +
        "cascade_persistent names them.",
    ),
  confirm_cascade: z
    .string()
    .optional()
    .describe("Echo bo again; required with confirm when cascade_ddic: true."),
  cascade_persistent: z
    .array(z.string())
    .optional()
    .describe(
      "Exact DDIC names to also delete from persistentTableRef/persistentStructureRef — each must be " +
        "referenced by this BO and live in its package. Requires cascade_ddic: true.",
    ),
  dry_run: z.boolean().optional().describe("Default true: report only, delete nothing."),
};

export const BopfDeleteInput = z.object(bopfDeleteInputSchema);
export type BopfDeleteInput = z.infer<typeof BopfDeleteInput>;

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/**
 * Slice of {@link BopfToolDeps} the pure `runBopf*` handlers read.
 * Deliberately excludes `registerWrite` (registration-time-only, meaningless
 * to v2's `abap_do` handlers which call `runBopfEdit`/`runBopfDelete`/
 * `runBopfRead` directly with `V2ToolDeps`).
 */
export interface BopfRunDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars">;
  /** Needed by create_bo's pre-lock local-package-only check. */
  readonly transport: SessionTransport;
  /**
   * The write journal. REQUIRED — see the git history
   * for why this field is non-optional (an optional journal shipped once and
   * `src/server.ts` silently omitted it, so writes went
   * unrecorded with no compiler error). `test/journal-contract.test.ts`
   * statically checks every registrar with a `journal` field is wired one.
   */
  readonly journal: Journal;
}

export interface BopfToolDeps extends BopfRunDeps {
  /**
   * REQUIRED, not defaulted: whether to register `abap_bopf_edit`/
   * `abap_bopf_delete`. `abap_bopf` itself always registers (pure read).
   * Registration-time filtering is layered on top of `SafetyGate`, not
   * instead of it — the runtime gate is unchanged either way, only
   * `tools/list` advertising differs. Callers pass
   * `resolveStaticCapabilities(cfg).canWrite` (`src/config.ts`).
   */
  readonly registerWrite: boolean;
}

/** Stable, case-insensitive gate key for `pool.withWrite`'s `objectUri` slot. Empty/whitespace-only names gate on nothing. */
export function bopfGateKey(bo: string): string | undefined {
  const trimmed = bo.trim().toUpperCase();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * `CallToolResult` plus an INTERNAL-only `journalEntryId` — never a wire
 * field. A sibling defect: no tool in this server declares an
 * `outputSchema`, and an MCP client (Claude Code among them) prefers
 * `structuredContent` over `content` whenever it is present, so putting the
 * id in `structuredContent` made every journalling
 * `abap_bopf_edit`/`abap_bopf_delete` call show the caller
 * `{"journalEntryId": "..."}` and NONE of the result text — intermittent,
 * since it only bit calls that actually wrote a journal entry.
 * `journalEntryId` here rides the return value only as far as
 * `registerBopfTools`'s `mcp.registerTool` callbacks, which strip it via
 * `toMcpResult` before it can reach the wire; `src/tools/v2/handlers/do/
 * bopf.ts`'s `journalled()` reads it directly from `runBopfEdit`/
 * `runBopfDelete`'s return value, upstream of that strip.
 */
export type BopfCallResult = CallToolResult & { readonly journalEntryId?: string };

/**
 * Strips the internal `journalEntryId` before a result crosses the MCP
 * boundary. `mcp.registerTool`'s callback return value is serialized onto
 * the wire verbatim by the SDK — an extra top-level key survives exactly as
 * `structuredContent` used to (see the defect described above) — so every
 * `registerTool` callback in this module must return through here, never a
 * bare `BopfCallResult`.
 */
function toMcpResult(res: BopfCallResult): CallToolResult {
  const { journalEntryId: _journalEntryId, ...rest } = res;
  return rest;
}

/**
 * `journalEntryId` rides the INTERNAL `BopfCallResult.journalEntryId` field
 * (see its doc comment — NOT `structuredContent`, per the defect above), never
 * prepended to `text`, so `src/tools/v2/handlers/do/bopf.ts` can tell whether
 * an entry was actually journalled. Absent when journalling is disabled, on
 * a dry run, or for an op this module doesn't journal (`activate`). The id
 * itself still reaches the caller — via the response builders'
 * `journalEntryId` header line (`buildEditResponse`/
 * `buildDeleteResultResponse`), not appended here: appending after
 * `buildResponse` has already run would breach its `hardClamp`-guaranteed
 * `text.length <= maxChars`.
 */
const ok = (text: string, journalEntryId?: string): BopfCallResult => ({
  content: [{ type: "text", text }],
  ...(journalEntryId ? { journalEntryId } : {}),
});

// ---------------------------------------------------------------------------
// abap_bopf — read
// ---------------------------------------------------------------------------

/** Structural digest only — no read/write surface exists for BOPF config/customizing. */
const SHOW_NOTES = [
  "This digest covers the business object's structural definition only (nodes, associations, actions, " +
    "determinations, validations, queries, alternative keys). It does not include BOPF configuration/" +
    "customizing — abapsmith has no read surface and no write surface of any kind for it.",
  '"(representative)" marks a parentless node the server minted itself (named REP_<random>) in response to a ' +
    "cross-BO association — the link is the association, never the node, and abapsmith cannot create one of these " +
    'nodes directly; "(delegated via PARENT.ASSOC)" marks an embedded dependent object\'s node; a cross-BO ' +
    'association is suffixed "(-> OTHER_BO~NODE)".',
];

function buildShowResponse(model: BoModel, maxChars: number): string {
  const header = {
    bo: model.name,
    type: model.type,
    version: model.version,
    description: model.description,
    package: model.packageRef?.name,
    constantsInterface: model.constantsInterfaceRef?.name,
    nodeCount: model.nodes.length,
  };
  const kinds = classifyNodes(model);
  const sections = model.nodes.map((n) => {
    const lines = [
      `nodeId: ${n.nodeId ?? "(unknown)"}${n.parent ? `  parent: ${n.parent}` : ""}`,
      `flags: root=${n.rootNode} create=${n.createEnabled} update=${n.updateEnabled} delete=${n.deleteEnabled} ` +
        `auth=${n.authorizationCheck} extensible=${n.isExtensible}`,
      n.persistentStructureRef ? `persistentStructureRef: ${n.persistentStructureRef.name}` : undefined,
      n.combinedStructureRef ? `combinedStructureRef: ${n.combinedStructureRef.name}` : undefined,
      n.combinedTableRef ? `combinedTableRef: ${n.combinedTableRef.name}` : undefined,
      n.associations.length
        ? `associations: ${n.associations
            .map((a) => {
              const label = a.name || "(unnamed)";
              const kindText = describeAssociationKind(classifyAssociation(model, a));
              return kindText ? `${label} (${kindText})` : label;
            })
            .join(", ")}`
        : undefined,
      n.actions.length ? `actions: ${n.actions.map((a) => a.name).join(", ")}` : undefined,
      n.determinations.length ? `determinations: ${n.determinations.map((d) => d.name).join(", ")}` : undefined,
      n.validations.length ? `validations: ${n.validations.map((v) => v.name).join(", ")}` : undefined,
      n.queries.length ? `queries: ${n.queries.map((q) => q.name).join(", ")}` : undefined,
      n.alternativeKeys.length ? `alternativeKeys: ${n.alternativeKeys.map((k) => k.name).join(", ")}` : undefined,
    ].filter((l): l is string => l !== undefined);
    const kindText = describeNodeKind(kinds.get(n.name.toLowerCase()) ?? { kind: "standard" });
    return { title: `NODE ${n.name}${kindText ? ` (${kindText})` : ""}`, content: lines.join("\n") };
  });
  return buildResponse({ header, sections, notes: SHOW_NOTES, maxChars }).text;
}

function buildRawResponse(bo: string, xml: string, maxChars: number): string {
  return buildResponse({
    header: { bo, chars: xml.length },
    body: xml,
    bodyLabel: "XML",
    maxChars,
  }).text;
}

function buildSearchResponse(refs: readonly AdtObjectRef[], maxChars: number): string {
  const body = refs.map((r) => `${r.name}  type=${r.type}${r.uri ? `  uri=${r.uri}` : ""}`).join("\n");
  return buildResponse({
    header: { resultCount: refs.length },
    body: refs.length ? body : undefined,
    bodyLabel: refs.length ? "RESULTS" : undefined,
    maxChars,
  }).text;
}

function buildCheckRefsResponse(
  model: BoModel,
  findings: readonly IntegrityFinding[],
  totalSites: number,
  maxSites: number,
  maxChars: number,
): string {
  const unchecked = findings.filter((f) => f.verdict === "unchecked").length;
  const problems = findings.filter(
    (f) => f.verdict === "missing" || f.verdict === "wrong-interface" || f.verdict === "declaration-only",
  ).length;
  const notes: string[] = [];
  if (findings.length < totalSites) {
    notes.push(
      `checked ${findings.length} of ${totalSites} reference sites (max_sites=${maxSites}) — the rest were not ` +
        "probed at all, not assumed clean. Pass a higher max_sites to check more.",
    );
  }
  if (unchecked > 0) {
    notes.push(
      `${unchecked} reference(s) could not be checked (a probe failed or the ref could not be resolved) — a ` +
        "dangling reference among them cannot be ruled out from this report alone.",
    );
  }
  const body = findings
    .map((f) => {
      const loc = `${f.site.node}${f.site.member ? `/${f.site.member}` : ""}.${f.site.element}`;
      const name = f.site.ref.name ?? "(unnamed)";
      return `${loc}  ref=${name}  verdict=${f.verdict}${f.detail ? `  (${f.detail})` : ""}`;
    })
    .join("\n");
  return buildResponse({
    header: { bo: model.name, totalRefs: findings.length, totalSites, unchecked, problems },
    body: findings.length ? body : undefined,
    bodyLabel: findings.length ? "REFERENCES" : undefined,
    notes,
    maxChars,
  }).text;
}

const BOPF_TOOL_DESCRIPTION =
  "Reads a BOPF business object's design-time model: show (default, digest) | raw (v4 XML) | search " +
  `(needs object_type) | check_refs (up to max_sites, default ${DEFAULT_CHECK_REFS_MAX_SITES}).`;

export async function runBopfRead(deps: BopfRunDeps, args: unknown): Promise<BopfCallResult> {
  const input = args as BopfInput;
  const mode = input.mode ?? "show";

  deps.safety.assert("read");
  await deps.ensureConnected();

  if (mode === "search") {
    const refs = await deps.pool.withRead("abap_bopf", (conn) =>
      searchBusinessObjects(conn, {
        objectType: input.object_type ?? "",
        query: input.query,
        maxResults: input.max_results,
      }),
    );
    return ok(buildSearchResponse(refs, deps.cfg.maxResponseChars));
  }

  if (!input.bo || !input.bo.trim()) {
    throw new AbapError("BAD_INPUT", `mode "${mode}" requires bo.`, { mode });
  }
  const bo = input.bo;

  if (mode === "raw") {
    const { xml } = await deps.pool.withRead("abap_bopf", (conn) => readModel(conn, bo));
    return ok(buildRawResponse(bo, xml, deps.cfg.maxResponseChars));
  }

  if (mode === "check_refs") {
    const maxSites = input.max_sites ?? DEFAULT_CHECK_REFS_MAX_SITES;
    const { model, findings, totalSites } = await deps.pool.withRead("abap_bopf", async (conn) => {
      const read = await readModel(conn, bo);
      const totalSites = collectRefSites(read.model).length;
      const findings = await checkReferences(conn, read.model, { maxSites });
      return { model: read.model, findings, totalSites };
    });
    return ok(buildCheckRefsResponse(model, findings, totalSites, maxSites, deps.cfg.maxResponseChars));
  }

  // mode === "show"
  const { model } = await deps.pool.withRead("abap_bopf", (conn) => readModel(conn, bo));
  return ok(buildShowResponse(model, deps.cfg.maxResponseChars));
}

/** Registers `abap_bopf`, `abap_bopf_edit`, `abap_bopf_delete` on the MCP server. */
export function registerBopfTools(mcp: McpServer, deps: BopfToolDeps): void {
  mcp.registerTool(
    "abap_bopf",
    {
      description: BOPF_TOOL_DESCRIPTION,
      inputSchema: bopfInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return toMcpResult(await runBopfRead(deps, args));
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );

  // Gated on `deps.registerWrite` — a read-only process never advertises
  // the mutating tools; `abap_bopf` above is unconditional (pure read).
  if (deps.registerWrite) {
    registerBopfEditTool(mcp, deps);
    registerBopfDeleteTool(mcp, deps);
  }
}

// ---------------------------------------------------------------------------
// abap_bopf_edit — write
// ---------------------------------------------------------------------------

const DANGLING_REF_OPS = new Set([
  "add_action",
  "add_determination",
  "add_validation",
  "add_query",
  "set_action_fields",
  "set_determination_fields",
  "set_validation_fields",
  "set_query_fields",
]);

const IMPL_INTERFACE_BY_OP: Readonly<Record<string, string>> = {
  add_action: "/BOBF/IF_FRW_ACTION",
  add_determination: "/BOBF/IF_FRW_DETERMINATION",
  add_validation: "/BOBF/IF_FRW_VALIDATION",
  add_query: "/BOBF/IF_FRW_QUERY",
  set_action_fields: "/BOBF/IF_FRW_ACTION",
  set_determination_fields: "/BOBF/IF_FRW_DETERMINATION",
  set_validation_fields: "/BOBF/IF_FRW_VALIDATION",
  set_query_fields: "/BOBF/IF_FRW_QUERY",
};

/** Element-kind word for a dangling-ref message — "action" for both add_action and set_action_fields. */
function danglingRefElementLabel(operation: string): string {
  return operation.replace(/^(add|set)_/, "").replace(/_fields$/, "");
}

interface DanglingVerdict {
  readonly className: string;
  readonly verdict: "present" | "declaration-only" | "wrong-interface" | "allowed";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * Like `str`, but refuses (`BAD_INPUT`) a non-empty string not in `allowed`.
 * Used for the closed, wire-confirmed enums (`category` on validations,
 * queries, determinations) — NOT for `ActionCategoryCode` (opaque numeric
 * string, not an enum).
 *
 * An invalid `category` has been observed to cause a server-side short dump
 * (add_validation) and silently-inert determinations (never fire their
 * triggers) — see the git history for the incident
 * details. `"undefined"` is deliberately excluded from
 * `DETERMINATION_CATEGORIES`: it's BOPF's own inert default, never a
 * legitimate caller intent.
 */
function strEnum(v: unknown, allowed: readonly string[], field: string): string | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  if (!allowed.includes(s)) {
    throw new AbapError(
      "BAD_INPUT",
      `spec.${field} = "${s}" is not a recognised value. Allowed: ${allowed.map((a) => `"${a}"`).join(", ")}.`,
      { field, value: s, allowed },
      `An unrecognised ${field} has been observed to cause server-side failures (including a short dump for ` +
        `add_validation) — refusing client-side rather than sending it.`,
    );
  }
  return s;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function ref(v: unknown): AdtObjectRef | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const name = str(o.name);
  const type = str(o.type);
  if (!name || !type) return undefined;
  const uri = str(o.uri);
  return uri ? { uri, type, name } : { type, name };
}
function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length ? out : undefined;
}

/** `spec.implementationClassRef` (a full ref) wins; otherwise `spec.class`/`spec.implementationClass` (a bare name) is wrapped as `CLAS/OC`. */
function classRefFromSpec(spec: Record<string, unknown>): AdtObjectRef | undefined {
  const explicit = ref(spec.implementationClassRef);
  if (explicit) return explicit;
  const className = str(spec.class) ?? str(spec.implementationClass);
  return className ? { type: "CLAS/OC", name: className.toUpperCase() } : undefined;
}

/**
 * Which class name (if any) a spec is about to introduce a reference to, for
 * the dangling-ref preflight. Same lookup `classRefFromSpec` uses, kept
 * separate because the preflight only needs the bare name, before any node
 * lock exists — not a full `AdtObjectRef`.
 */
function specClassName(spec: Record<string, unknown> | undefined): string | undefined {
  if (!spec) return undefined;
  const explicit = ref(spec.implementationClassRef);
  if (explicit) return explicit.name;
  return str(spec.class) ?? str(spec.implementationClass);
}

/**
 * Dangling-class-ref mitigation for the write path: `checkReferences` only
 * sees refs already in the model, not one an edit is about to introduce.
 * Mirrors `adt/bopf.ts`'s `evaluateClassRef` — probes by SOURCE existence
 * (`GET .../source/main`) via `readCurrentSource`, not a plain object-URI GET
 * (which can 200 for a class that was never created).
 *
 * Only "missing" refuses (`BOPF_DANGLING_REF`), and only when `allowDangling`
 * is false; `declaration-only`/`wrong-interface` are informational notes.
 */
async function danglingRefPreflight(
  conn: AbapConnection,
  operation: string,
  spec: Record<string, unknown> | undefined,
  allowDangling: boolean,
): Promise<DanglingVerdict | undefined> {
  if (!DANGLING_REF_OPS.has(operation)) return undefined;
  const className = specClassName(spec);
  if (!className) return undefined;

  const lower = className.toLowerCase();
  // Sourced from the central type→URI registry rather than duplicated here.
  const classSpec = specForType("CLAS/OC")!;
  const target: ResolvedTarget = {
    spec: classSpec,
    type: classSpec.type,
    name: className,
    uri: `/sap/bc/adt/oo/classes/${lower}`,
    sourceUri: `/sap/bc/adt/oo/classes/${lower}/source/main`,
    packageName: "",
    description: "",
    exists: true,
    packageSource: "requested",
  };

  let source: string | undefined;
  try {
    source = await readCurrentSource(conn, target);
  } catch (e) {
    if (isAbapError(e) && e.code === "UNSUPPORTED") {
      if (allowDangling) return { className, verdict: "allowed" };
      throw new AbapError(
        "BOPF_DANGLING_REF",
        `Class ${className} does not exist as a source artifact — a ${danglingRefElementLabel(operation)} bound to ` +
          "it would activate cleanly and then silently never fire at runtime.",
        { class: className, operation },
        "Create the class first, or pass allow_dangling_ref: true to proceed anyway.",
      );
    }
    throw e;
  }

  if (source === undefined || !source.includes("IMPLEMENTATION")) {
    return { className, verdict: "declaration-only" };
  }
  const requiredInterface = IMPL_INTERFACE_BY_OP[operation];
  if (requiredInterface && !source.includes(requiredInterface)) {
    return { className, verdict: "wrong-interface" };
  }
  return { className, verdict: "present" };
}

/**
 * Mitigation for a second dangling-ref case `add_validation` triggers can
 * build: `bo:ValidationTrigger/@bo:action` names an action via an XPath
 * fragment. Unlike a class ref, existence is checkable for free from the
 * model this operation already read — no extra round trip — so this runs
 * directly for `add_validation`, not gated by `DANGLING_REF_OPS`.
 *
 * UNVERIFIED HYPOTHESIS: one live run observed a validation trigger's
 * `bo:action` (or the whole `bo:triggers` element) silently vanish after
 * activation when the named action didn't really exist — the same
 * activates-cleanly-then-silently-inert shape as the confirmed class-ref
 * case above, but not itself confirmed as the mechanism. See
 * the git history for the full recon and the exact
 * live test that would settle it.
 */
function actionRefPreflight(
  model: BoModel,
  ownerNode: string,
  spec: Record<string, unknown> | undefined,
  allowDangling: boolean,
): void {
  if (!spec || !Array.isArray(spec.triggers)) return;
  for (const t of spec.triggers) {
    if (!t || typeof t !== "object") continue; // shape is enforced later, in buildTriggerFragments
    const o = t as Record<string, unknown>;
    const actionName = str(o.action);
    if (actionName === undefined) continue;
    const actionNodeName = str(o.actionNode) ?? ownerNode;
    const node = model.nodes.find((n) => n.name === actionNodeName);
    const exists = node?.actions.some((a) => a.name === actionName) === true;
    if (exists || allowDangling) continue;
    const available = node?.actions.map((a) => a.name).join(", ") || "none";
    throw new AbapError(
      "BOPF_DANGLING_REF",
      `Trigger action "${actionName}" does not exist on node "${actionNodeName}" (actions that DO exist on ` +
        `"${actionNodeName}": ${available}) — a trigger referencing it would activate cleanly and then ` +
        `(hypothesised, not live-confirmed — see actionRefPreflight's doc comment) silently never fire at ` +
        `runtime.`,
      { action: actionName, node: actionNodeName, operation: "add_validation" },
      `Create the action first (add_action), correct "action"/"actionNode", or pass allow_dangling_ref: true ` +
        `to proceed anyway.`,
    );
  }
}

/**
 * `add_alternative_key` mitigation for a live failure pattern (7/7 live failures, 3/7
 * short-dumping the ADT session in `/BOBF/CL_CONF_MODEL_API_MAP`). Both
 * checks below are now LIVE-CONFIRMED as refusals in both directions (bogus
 * refused, real allowed) — but NOT confirmed as the dump's cause: it still
 * dumps with both satisfied.
 *
 * 1. Every `bo:keyElements/@bo:name` in `01-get-demo_sales_order.v4.xml`
 *    matches a `bo:properties/@bo:name` on the SAME node; the repro that
 *    started this named `TORDER_ID` on a ROOT node with only
 *    KEY/PARENT_KEY/ROOT_KEY (`02-created-zbopf_prb1-root-only.v4.xml`).
 * 2. Both nodes carrying a key in the capture (ROOT, ITEM) have a
 *    `bo:persistentStructureRef`; without one there's no DDIC structure and
 *    the node can't activate. Confirmed: properties populate when the ref
 *    is ASSIGNED, not at activation (fresh BO, property list unchanged
 *    after activation).
 */
function alternativeKeyPreflight(
  model: BoModel,
  sel: NodeSelector,
  spec: Record<string, unknown> | undefined,
  allowDangling: boolean,
): void {
  if (allowDangling || !spec) return;
  const node =
    sel.nodeId !== undefined
      ? model.nodes.find((n) => n.nodeId === sel.nodeId)
      : model.nodes.find((n) => n.name.toLowerCase() === sel.node.toLowerCase());
  if (!node) return; // requireLocate raises NOT_FOUND for this once mutateModel runs

  const keyElements = strArray(spec.keyElements) ?? [];
  const missing = keyElements.filter((name) => !node.properties.some((p) => p.name === name));
  if (missing.length > 0) {
    const available = node.properties.map((p) => p.name);
    throw new AbapError(
      "BOPF_DANGLING_REF",
      `add_alternative_key names keyElements that do not exist as properties on node "${node.name}": ` +
        `${missing.join(", ")} (properties that DO exist on "${node.name}": ${available.join(", ") || "none"}) — ` +
        `a live repro named TORDER_ID, an element the node it targeted did not have (only ` +
        `KEY/PARENT_KEY/ROOT_KEY), and that request short-dumped the ADT session in ` +
        `/BOBF/CL_CONF_MODEL_API_MAP.`,
      { operation: "add_alternative_key", bo: model.name, node: sel.node, missing, available },
      `Correct keyElements to name properties that exist on "${node.name}", or pass allow_dangling_ref: true to ` +
        `send it anyway.`,
    );
  }

  if (node.persistentStructureRef === undefined) {
    throw new AbapError(
      "BOPF_DANGLING_REF",
      `add_alternative_key targets node "${node.name}", which has no persistentStructureRef — there is no DDIC ` +
        `structure for a key to be a key of, and a node in that state cannot be activated. Both nodes ` +
        `carrying an alternative key in the capture (ROOT, ITEM) have a persistentStructureRef.`,
      { operation: "add_alternative_key", bo: model.name, node: sel.node },
      `Give the node a persistentStructureRef first (set_node_flags), or pass allow_dangling_ref: true to send ` +
        `it anyway.`,
    );
  }
}

/**
 * `input.node` may legitimately be `""` — `create_bo`'s auto-generated root
 * node has `bo:name=""`. Only genuinely missing (`undefined`) is rejected.
 * `input.nodeId` disambiguates when needed (e.g. targeting the empty-named
 * root) and flows through the returned selector.
 */
function requireNode(input: BopfEditInput): NodeSelector {
  if (input.node === undefined) {
    throw new AbapError("BAD_INPUT", `operation "${input.operation}" requires node.`, { operation: input.operation });
  }
  return input.nodeId === undefined ? { node: input.node } : { node: input.node, nodeId: input.nodeId };
}
function requireName(input: BopfEditInput): string {
  if (input.name === undefined || input.name === "") {
    throw new AbapError("BAD_INPUT", `operation "${input.operation}" requires name.`, { operation: input.operation });
  }
  return input.name;
}
function requireLocate(tokens: readonly Token[], sel: Selector): Range {
  const range = locate(tokens, sel);
  if (!range) {
    throw new AbapError("NOT_FOUND", `BOPF element not found for ${JSON.stringify(sel)}.`, { selector: sel });
  }
  return range;
}

/**
 * `add_alternative_key` requires the FULL shape: every `bo:alternativeKeys`
 * element captured on the wire (`test/fixtures/bopf/01-get-demo_sales_order.v4.xml`)
 * carries uniqueness, dataTypeRef, dataTableTypeRef and at least one
 * keyElements entry. A partial one is what BOPF's model mapper faults on,
 * and that fault took the whole ADT session down.
 */
function validateAlternativeKeySpec(name: string, spec: Record<string, unknown>): void {
  strEnum(spec.uniqueness, KEY_UNIQUENESS_VALUES, "uniqueness");
  const missing: string[] = [];
  if (str(spec.uniqueness) === undefined) missing.push("uniqueness");
  if (ref(spec.dataTypeRef) === undefined) missing.push("dataTypeRef");
  if (ref(spec.dataTableTypeRef) === undefined) missing.push("dataTableTypeRef");
  if (strArray(spec.keyElements) === undefined) missing.push("keyElements");
  if (missing.length === 0) return;
  throw new AbapError(
    "BAD_INPUT",
    `add_alternative_key "${name}" is missing required spec fields: ${missing.join(", ")}. Every ` +
      `bo:alternativeKeys element in the captured wire XML carries uniqueness, dataTypeRef, ` +
      `dataTableTypeRef and at least one keyElements entry; a partial one is what BOPF's model mapper ` +
      `(/BOBF/CL_CONF_MODEL_API_MAP) fails on, and that failure destroys the whole ADT session.`,
    { operation: "add_alternative_key", name, missing },
    `dataTypeRef and dataTableTypeRef are { name, type } refs — the key's DDIC structure and its table ` +
      `type, e.g. { "name": "ZSORDER_ID", "type": "TABL/DS" } and { "name": "ZTORDER_ID", "type": "TTYP/DA" }. ` +
      `uniqueness is one of "unique", "uniqueIfNotInitial", "notUnique". keyElements lists the node field ` +
      `names that make up the key.`,
  );
}

/** Cheap, zero-network shape validation, run before any preflight assert or network call. */
function validateEditInputShape(input: BopfEditInput): void {
  const needsNode = new Set([
    "remove_node",
    "add_association",
    "remove_association",
    "set_association_fields",
    "add_action",
    "remove_action",
    "set_action_fields",
    "add_determination",
    "remove_determination",
    "set_determination_fields",
    "add_validation",
    "remove_validation",
    "set_validation_fields",
    "add_query",
    "remove_query",
    "set_query_fields",
    "add_alternative_key",
    "remove_alternative_key",
    "set_alternative_key_fields",
    "set_node_flags",
    "remove_dependent_object",
  ]);
  const needsName = new Set([
    "add_node",
    "add_association",
    "remove_association",
    "set_association_fields",
    "add_action",
    "remove_action",
    "set_action_fields",
    "add_determination",
    "remove_determination",
    "set_determination_fields",
    "add_validation",
    "remove_validation",
    "set_validation_fields",
    "add_query",
    "remove_query",
    "set_query_fields",
    "add_alternative_key",
    "remove_alternative_key",
    "remove_dependent_object",
    "set_alternative_key_fields",
  ]);
  if (needsNode.has(input.operation)) requireNode(input);
  if (needsName.has(input.operation)) requireName(input);

  validateSpecKeys(input.operation, (input.spec ?? {}) as Record<string, unknown>);

  if (input.operation === "add_alternative_key") {
    validateAlternativeKeySpec(requireName(input), (input.spec ?? {}) as Record<string, unknown>);
  }

  if (isDelegationOperation(input.operation)) validateDelegationShape(input as DelegationInput);
  if (input.operation === "add_node" || input.operation === "add_association") {
    refuseHandAssembledDelegation(input.operation, (input.spec ?? {}) as Record<string, unknown>, input.name);
  }
}

interface ParentLink {
  readonly parent: string;
  readonly parentNodeId: string;
}

/**
 * Resolves `spec.parent`/`spec.parentNodeId` against the depth-1 `bo:nodes`
 * tokens of the freshly re-read model, and returns the matched
 * `bo:parent`/`bo:parentNodeID` pair. `undefined` when neither field was
 * given. `spec.parent` accepts a bare node name or the `[@bo:name='...']`
 * XPath fragment this tool itself emits; `spec.parentNodeId` must match a
 * `bo:nodeID` exactly.
 */
function resolveParentLink(spec: Record<string, unknown>, tokens: readonly Token[]): ParentLink | undefined {
  const parentSpec = str(spec.parent);
  const parentNodeIdSpec = str(spec.parentNodeId);
  if (parentSpec === undefined && parentNodeIdSpec === undefined) return undefined;

  const candidates = tokens.filter((t) => t.name === "bo:nodes" && t.depth === 1);
  const existingNames = () => candidates.map((t) => t.attrs.get("bo:name") || "(unnamed)").join(", ") || "none";

  let match: Token | undefined;
  if (parentSpec !== undefined) {
    const xpathName = /\[@bo:name='([^']*)'\]/.exec(parentSpec)?.[1];
    const wanted = (xpathName ?? parentSpec).toLowerCase();
    match = candidates.find((t) => (t.attrs.get("bo:name") ?? "").toLowerCase() === wanted);
    if (!match) {
      throw new AbapError(
        "NOT_FOUND",
        `add_node: spec.parent "${parentSpec}" does not match any existing node (nodes that DO exist: ` +
          `${existingNames()}).`,
        { parent: parentSpec },
      );
    }
  } else {
    match = candidates.find((t) => t.attrs.get("bo:nodeID") === parentNodeIdSpec);
    if (!match) {
      throw new AbapError(
        "NOT_FOUND",
        `add_node: spec.parentNodeId "${parentNodeIdSpec}" does not match any existing node's bo:nodeID ` +
          `(nodes that DO exist: ${existingNames()}).`,
        { parentNodeId: parentNodeIdSpec },
      );
    }
  }

  const matchedName = match.attrs.get("bo:name") ?? "";
  const matchedNodeId = match.attrs.get("bo:nodeID");
  if (!matchedNodeId) {
    throw new AbapError(
      "BAD_INPUT",
      `add_node: resolved parent node "${matchedName}" has no bo:nodeID — bo:parent and bo:parentNodeID must ` +
        `be written together, so a parent that lacks one can't be linked to.`,
      { parent: matchedName },
    );
  }
  if (parentSpec !== undefined && parentNodeIdSpec !== undefined && matchedNodeId !== parentNodeIdSpec) {
    throw new AbapError(
      "BAD_INPUT",
      `add_node: spec.parent "${parentSpec}" resolves to nodeID ${matchedNodeId}, which disagrees with ` +
        `spec.parentNodeId "${parentNodeIdSpec}".`,
      { parent: parentSpec, parentNodeId: parentNodeIdSpec, resolvedNodeId: matchedNodeId },
    );
  }

  return { parent: boParentRef(matchedName), parentNodeId: matchedNodeId };
}

function buildNodeFields(
  name: string,
  nodeId: string,
  spec: Record<string, unknown>,
  parentLink: ParentLink | undefined,
): NodeFields {
  return {
    name,
    nodeId,
    parent: parentLink?.parent,
    parentNodeId: parentLink?.parentNodeId,
    xmlName: str(spec.xmlName),
    doEmbeddingName: str(spec.doEmbeddingName),
    // Explicit spec.rootNode (false included) always wins; otherwise a
    // resolved parent link means this can't be the root — every captured
    // non-root node carries bo:rootNode="false" explicitly.
    rootNode: bool(spec.rootNode) ?? (parentLink ? false : undefined),
    textNode: bool(spec.textNode),
    isDependentObjectNode: bool(spec.isDependentObjectNode),
    createEnabled: bool(spec.createEnabled),
    updateEnabled: bool(spec.updateEnabled),
    deleteEnabled: bool(spec.deleteEnabled),
    authorizationCheck: bool(spec.authorizationCheck),
    isExtensible: bool(spec.isExtensible),
    objectModelGenerated: bool(spec.objectModelGenerated),
    objectModelObsolete: bool(spec.objectModelObsolete),
    persistentStructureRef: ref(spec.persistentStructureRef),
    transientStructureRef: ref(spec.transientStructureRef),
    combinedStructureRef: ref(spec.combinedStructureRef),
    combinedTableRef: ref(spec.combinedTableRef),
    persistentTableRef: ref(spec.persistentTableRef),
    defaultingClassRef: ref(spec.defaultingClassRef),
    dataAccessClassRef: ref(spec.dataAccessClassRef),
    authorizationClassRef: ref(spec.authorizationClassRef),
  };
}

function buildAssociationFields(name: string, nodeId: string, spec: Record<string, unknown>): AssociationFields {
  return {
    name,
    nodeId,
    xmlName: str(spec.xmlName),
    multiplicity: str(spec.multiplicity),
    implementationType: str(spec.implementationType),
    objectModelGenerated: bool(spec.objectModelGenerated),
    doEmbeddingName: str(spec.doEmbeddingName),
    targetNodeRef: ref(spec.targetNodeRef),
    implementationClassRef: classRefFromSpec(spec),
    parameterStructureRef: ref(spec.parameterStructureRef),
  };
}

function buildActionFields(name: string, nodeId: string, spec: Record<string, unknown>): ActionFields {
  return {
    name,
    nodeId,
    xmlName: str(spec.xmlName),
    category: str(spec.category),
    instanceMultiplicity: str(spec.instanceMultiplicity),
    exportingParameterCategoryType: str(spec.exportingParameterCategoryType),
    exportParameterLink: bool(spec.exportParameterLink),
    isExtensible: bool(spec.isExtensible),
    objectModelGenerated: bool(spec.objectModelGenerated),
    implementationClassRef: classRefFromSpec(spec),
    parameterStructureRef: ref(spec.parameterStructureRef),
  };
}

/**
 * `bo:triggers`/`bo:relations` node/association/determination attrs are
 * `[WIRE]`-confirmed XPath fragments, not bare names:
 *
 *   `%2F<bo-name>#//bo:businessObject/bo:nodes[@bo:name='<NODE>']`
 *   `.../bo:associations[@bo:name='<ASSOC>']`
 *   `.../bo:determinations[@bo:name='<DET>']`
 *
 * Root cause of a past "add_determination triggers never attach" defect:
 * sending a bare name here isn't resolvable and BOPF either silently ignores
 * the trigger or 400s. `encodeURIComponent` on a lower-cased name emits
 * uppercase `%2F` matching the captured wire form (the `adtcore:uri` form
 * uses lowercase `%2f` instead — a separate, deliberately-not-reused
 * convention).
 */
function boNodeRef(boName: string, nodeName: string): string {
  return `${encodeURIComponent(boName.toLowerCase())}#//bo:businessObject/bo:nodes[@bo:name='${nodeName}']`;
}
/**
 * `bo:nodes/@bo:parent` only — an EMPTY-base XPath fragment (no BO-name
 * prefix), unlike `boNodeRef` above. `[WIRE]`-confirmed against the captured
 * non-root `<bo:nodes>` fixtures in `test/fixtures/bopf/`: always written
 * paired with `bo:parentNodeID` on the same element — BOPF takes a
 * half-linked node with a 200 and then drops it.
 */
function boParentRef(nodeName: string): string {
  return `#//bo:businessObject/bo:nodes[@bo:name='${nodeName}']`;
}
function boAssociationRef(boName: string, nodeName: string, assocName: string): string {
  return `${boNodeRef(boName, nodeName)}/bo:associations[@bo:name='${assocName}']`;
}
function boDeterminationRef(boName: string, nodeName: string, detName: string): string {
  return `${boNodeRef(boName, nodeName)}/bo:determinations[@bo:name='${detName}']`;
}
/**
 * `bo:ValidationTrigger/@bo:action` only — same fragment shape as
 * `boDeterminationRef`, but anchored on the action's own owning node, which
 * is independent of the trigger's watched `node`/`association`
 * (`[WIRE]`-confirmed: a trigger can watch one node but gate on an action
 * defined on another).
 */
function boActionRef(boName: string, nodeName: string, actionName: string): string {
  return `${boNodeRef(boName, nodeName)}/bo:actions[@bo:name='${actionName}']`;
}

/**
 * Builds `<bo:triggers .../>` fragments for one determination/validation.
 *
 * A trigger's `node` is the WATCHED node (may differ from `ownerNode`);
 * `association` must live ON that watched node, pointing back toward
 * `ownerNode` — never a downward/composition association. Omitting both
 * defaults to a self-trigger (empty-name self-association), confirmed
 * `[WIRE]` against SAP-delivered demo BOs. `association` without `node`
 * stays refused as ambiguous.
 *
 * Validation-only `action` (absent from `bo:DeterminationTrigger`, refused
 * for determinations): combine with node/association for a gated trigger
 * (`actionNode` defaults to `ownerNode`), or give `action` alone for a
 * purely action-gated trigger with no `bo:node`/`bo:association` at all.
 */
function buildTriggerFragments(
  boName: string,
  ownerNode: string,
  spec: Record<string, unknown>,
  kind: "determination" | "validation",
): string[] | undefined {
  if (!Array.isArray(spec.triggers)) return undefined;
  const out: string[] = [];
  for (const t of spec.triggers) {
    // Previously silently skipped, which could drop ALL triggers with no
    // error surfaced — refuse instead.
    if (!t || typeof t !== "object") {
      throw new AbapError(
        "BAD_INPUT",
        `spec.triggers[${out.length}] must be an object, got ${t === null ? "null" : typeof t}.`,
        { index: out.length, value: t },
      );
    }
    const o = t as Record<string, unknown>;
    const nodeName = str(o.node);
    // Distinguish explicit "" (a real self-association wire value) from an
    // omitted key — `str("")` would collapse both to `undefined`.
    const assocGiven = typeof o.association === "string";
    const assocRaw = assocGiven ? (o.association as string) : undefined;
    const actionName = str(o.action);

    if (actionName !== undefined && kind === "determination") {
      throw new AbapError(
        "BAD_INPUT",
        `Determination triggers do not support "action" — bo:DeterminationTrigger has no bo:action attribute ` +
          `on the wire (only bo:ValidationTrigger does).`,
        { action: actionName },
        `Remove "action" from this trigger, or express it on an add_validation call instead.`,
      );
    }

    if (assocGiven && nodeName === undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `A trigger with "association" also needs "node" (the association's owning node) to build a valid ` +
          `reference.`,
        { association: assocRaw },
        `Add "node": "<the node ${assocRaw} belongs to>" alongside "association": "${assocRaw}", or use ` +
          `"node": "${ownerNode}" for a self-node trigger with an explicit association.`,
      );
    }

    const pureActionTrigger = actionName !== undefined && nodeName === undefined && !assocGiven;

    let nodeRef: string | undefined;
    let assocRef: string | undefined;
    if (!pureActionTrigger) {
      const effectiveNode = nodeName ?? ownerNode;
      const isSelfNode = effectiveNode === ownerNode;
      if (!assocGiven && !isSelfNode) {
        throw new AbapError(
          "BAD_INPUT",
          `A trigger watching node "${effectiveNode}" (different from this ${kind}'s own node "${ownerNode}") ` +
            `needs "association" — an association defined ON "${effectiveNode}" that points back toward ` +
            `"${ownerNode}". BOPF's trigger direction runs from the watched/source node's own association ` +
            `toward the ${kind}'s owning node, never the reverse (a downward/composition association owned by ` +
            `"${ownerNode}" itself is not valid here).`,
          { node: effectiveNode, ownerNode },
          `Add "association": "<an association owned by ${effectiveNode}, typically pointing back up toward ` +
            `${ownerNode}>", or omit "node" entirely for a same-node (self) trigger on "${ownerNode}".`,
        );
      }
      const effectiveAssoc = assocGiven ? assocRaw! : "";
      nodeRef = boNodeRef(boName, effectiveNode);
      assocRef = boAssociationRef(boName, effectiveNode, effectiveAssoc);
    }

    const actionRef =
      actionName !== undefined ? boActionRef(boName, str(o.actionNode) ?? ownerNode, actionName) : undefined;

    const base = {
      node: nodeRef,
      association: assocRef,
      create: bool(o.create),
      update: bool(o.update),
      delete: bool(o.delete),
    };
    out.push(
      kind === "determination"
        ? renderDeterminationTrigger({ ...base, load: bool(o.load), determine: bool(o.determine) })
        : renderValidationTrigger({ ...base, check: bool(o.check), action: actionRef }),
    );
  }
  // Guards against a future silent per-entry drop being reintroduced (see
  // the comment above the loop) — not reachable today.
  if (out.length !== spec.triggers.length) {
    throw new AbapError(
      "BAD_INPUT",
      `Internal: built ${out.length} trigger fragment(s) for ${spec.triggers.length} requested trigger(s) — ` +
        `refusing to silently render fewer triggers than spec.triggers requested.`,
      { requested: spec.triggers.length, rendered: out.length },
    );
  }
  return out.length ? out : undefined;
}

function buildRelationFragments(boName: string, spec: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(spec.relations)) return undefined;
  const out: string[] = [];
  for (const r of spec.relations) {
    // Same silent-discard class as `buildTriggerFragments` above — refuse
    // rather than skip a malformed entry with no error.
    if (!r || typeof r !== "object") {
      throw new AbapError(
        "BAD_INPUT",
        `spec.relations[${out.length}] must be an object, got ${r === null ? "null" : typeof r}.`,
        { index: out.length, value: r },
      );
    }
    const o = r as Record<string, unknown>;
    const nodeName = str(o.node);
    const detName = str(o.determination);
    if (nodeName === undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `A relation needs "node" (the node both this determination and the related determination live on) to ` +
          `build a valid reference.`,
        { relation: o },
      );
    }
    out.push(
      renderRelation({
        node: boNodeRef(boName, nodeName),
        determination: detName !== undefined ? boDeterminationRef(boName, nodeName, detName) : undefined,
        relationType: str(o.relationType),
      }),
    );
  }
  // Same structural invariant as `buildTriggerFragments` above.
  if (out.length !== spec.relations.length) {
    throw new AbapError(
      "BAD_INPUT",
      `Internal: built ${out.length} relation fragment(s) for ${spec.relations.length} requested relation(s) — ` +
        `refusing to silently render fewer relations than spec.relations requested.`,
      { requested: spec.relations.length, rendered: out.length },
    );
  }
  return out.length ? out : undefined;
}

/**
 * 12 of `DeterminationCategoryType`'s 13 members — `"undefined"` excluded
 * (BOPF's own inert default, see `strEnum`'s doc comment). Most are
 * `[SCHEMA]`-only/unconfirmed; `reactDuringSave`/`reactAfterModification`
 * are `[WIRE]`-confirmed as the values live trigger-attached determinations
 * actually use.
 */
const DETERMINATION_CATEGORIES = [
  "reactAfterModification",
  "calculateTransientAttributes",
  "calculateTransientSubNodeInstances",
  "calculateProperties",
  "reactOnCheckAndDetermine",
  "reactBeforeSave",
  "drawNumbersDuringCreate",
  "drawNumbersDuringSave",
  "reactDuringSave",
  "reactAfterSuccessfulSave",
  "reactAfterCleanupTransaction",
  "reactAfterFailedSave",
] as const;

function buildDeterminationFields(
  boName: string,
  ownerNode: string,
  name: string,
  nodeId: string,
  spec: Record<string, unknown>,
): DeterminationFields {
  return {
    name,
    nodeId,
    xmlName: str(spec.xmlName),
    category: strEnum(spec.category, DETERMINATION_CATEGORIES, "category"),
    objectModelGenerated: bool(spec.objectModelGenerated),
    implementationClassRef: classRefFromSpec(spec),
    triggers: buildTriggerFragments(boName, ownerNode, spec, "determination"),
    relations: buildRelationFragments(boName, spec),
  };
}

/** Wire-confirmed complete enumeration — see `strEnum`'s doc comment. */
const VALIDATION_CATEGORIES = ["consistencyCheck", "actionCheck"] as const;
/** Wire-confirmed complete enumeration — see `strEnum`'s doc comment. */
const QUERY_CATEGORIES = ["selectAll", "selectByElements", "customQuery"] as const;
/** Wire-confirmed complete enumeration (`KeyUniquenessType`, `src/adt/bopf-types.ts`) — see `strEnum`'s doc comment. */
const KEY_UNIQUENESS_VALUES = ["unique", "uniqueIfNotInitial", "notUnique"] as const;

function buildValidationFields(
  boName: string,
  ownerNode: string,
  name: string,
  nodeId: string,
  spec: Record<string, unknown>,
): ValidationFields {
  return {
    name,
    nodeId,
    xmlName: str(spec.xmlName),
    category: strEnum(spec.category, VALIDATION_CATEGORIES, "category"),
    checkBeforeSave: bool(spec.checkBeforeSave),
    createNode: bool(spec.createNode),
    updateNode: bool(spec.updateNode),
    deleteNode: bool(spec.deleteNode),
    objectModelGenerated: bool(spec.objectModelGenerated),
    implementationClassRef: classRefFromSpec(spec),
    triggers: buildTriggerFragments(boName, ownerNode, spec, "validation"),
  };
}

function buildQueryFields(name: string, nodeId: string, spec: Record<string, unknown>): QueryFields {
  return {
    name,
    nodeId,
    xmlName: str(spec.xmlName),
    category: strEnum(spec.category, QUERY_CATEGORIES, "category"),
    objectModelGenerated: bool(spec.objectModelGenerated),
    dataTypeRef: ref(spec.dataTypeRef),
    implementationClassRef: classRefFromSpec(spec),
  };
}

function buildAlternativeKeyFields(name: string, nodeId: string, spec: Record<string, unknown>): AlternativeKeyFields {
  return {
    name,
    nodeId,
    xmlName: str(spec.xmlName),
    uniqueness: strEnum(spec.uniqueness, KEY_UNIQUENESS_VALUES, "uniqueness"),
    checkAfterModify: bool(spec.checkAfterModify),
    checkBeforeSave: bool(spec.checkBeforeSave),
    noCheck: bool(spec.noCheck),
    objectModelGenerated: bool(spec.objectModelGenerated),
    dataTypeRef: ref(spec.dataTypeRef),
    dataTableTypeRef: ref(spec.dataTableTypeRef),
    keyElements: strArray(spec.keyElements),
  };
}

/**
 * `spliceInsertChild` only inserts into an EXISTING node's children
 * (`bopf-xml.ts` doesn't build a whole-document/root renderer). `add_node`
 * needs a new top-level `<bo:nodes>` as a direct child of
 * `<bo:businessObject>` — this is that root-level insertion, local to the
 * tool layer.
 *
 * Appends after the last depth-1 element (or right after the root's own
 * open tag if there are none), always a legal document-order position.
 *
 * Gap: a self-closing root (`kind === "empty"`, e.g. right after `create_bo`
 * with no prior `putModel`) has no interior range to insert into, and
 * promoting it to a container isn't implemented — refuses `UNSUPPORTED`
 * rather than guess.
 */
function insertNodeAtRoot(xml: string, tokens: readonly Token[], fragment: string): string {
  const root = tokens.find((t) => t.depth === 0);
  if (!root) {
    throw new AbapError("UNSUPPORTED", "BOPF XML: no root element found while inserting a new node.", {});
  }
  if (root.kind === "empty") {
    throw new AbapError(
      "UNSUPPORTED",
      "Cannot add a node to a business object whose root element is empty (self-closing) — promoting the root " +
        "to a container is not implemented.",
      { rootName: root.name },
      "Documented gap: add_node only supports a root that already has at least one child element (e.g. a " +
        "packageRef, always present after create_bo's fresh re-read).",
    );
  }
  const depth1 = tokens.filter((t) => t.depth === 1);
  const insertAt = depth1.length ? Math.max(...depth1.map((t) => t.closeEnd)) : root.openEnd;
  return splice(xml, insertAt, fragment);
}

const NODE_FLAG_NAMES = [
  "rootNode",
  "textNode",
  "isDependentObjectNode",
  "createEnabled",
  "updateEnabled",
  "deleteEnabled",
  "authorizationCheck",
  "isExtensible",
  "objectModelGenerated",
  "objectModelObsolete",
] as const;

/**
 * `set_node_flags` — hand-rolled regex patch on the node's own open-tag
 * bytes, not routed through `render*Element` (those emit a full new
 * element). Every boolean flag is `unsettable="true"` on the wire — absent
 * ≠ `false` — so `null` REMOVES the attribute rather than writing "false".
 *
 * Also accepts any `NODE_REF_KINDS` key (`persistentStructureRef`, etc.) as
 * a `{ name, type[, uri] }` ref or `null` to clear — these are CHILD
 * ELEMENTS, spliced via `spliceSetNodeRef` with a re-scan between each one
 * (offsets shift after each splice). Before this addendum there was no way
 * to add a `persistentStructureRef` to an EXISTING node (only `add_node`
 * could set one, on a node it was simultaneously creating) — so a
 * `create_bo`-created BO's auto-generated ROOT could never be activated
 * ("Data structure is missing") without editing outside the tool.
 */
function patchNodeFlags(xml: string, tokens: readonly Token[], sel: NodeSelector, spec: Record<string, unknown>): string {
  const nodeName = sel.node;
  // Tracks the node's CURRENT name — a spec.name rename below changes what
  // subsequent ref-splice re-scans must search for.
  let currentName = nodeName;
  const nodeTok = tokens.find(
    (t) =>
      t.name === "bo:nodes" &&
      t.attrs.get("bo:name") === nodeName &&
      (sel.nodeId === undefined || t.attrs.get("bo:nodeID") === sel.nodeId),
  );
  if (!nodeTok) {
    throw new AbapError("NOT_FOUND", `BOPF node "${nodeName}"${sel.nodeId ? ` (nodeId ${sel.nodeId})` : ""} not found.`, {
      node: nodeName,
      nodeId: sel.nodeId,
    });
  }

  let openTag = xml.slice(nodeTok.openStart, nodeTok.openEnd);

  // Renames the node (bo:name) when spec.name is given — a prerequisite for
  // activating any create_bo'd BO, since its auto-generated root has
  // bo:name="" and activation refuses an empty node name.
  if (typeof spec.name === "string") {
    if (!spec.name.trim()) {
      throw new AbapError("BAD_INPUT", `set_node_flags: "name" must be a non-empty string.`, { name: spec.name });
    }
    const nameRe = /\s+bo:name="[^"]*"/;
    if (!nameRe.test(openTag)) {
      throw new AbapError("BAD_INPUT", `set_node_flags: node element has no bo:name attribute to rename.`, {});
    }
    openTag = openTag.replace(nameRe, ` bo:name="${escapeAttrValue(spec.name, "bo:nodes/@bo:name")}"`);
    currentName = spec.name;
  }

  for (const flag of NODE_FLAG_NAMES) {
    if (!(flag in spec)) continue;
    const value = spec[flag];
    const attrRe = new RegExp(`\\s+bo:${flag}="[^"]*"`);
    if (value === null) {
      openTag = openTag.replace(attrRe, "");
      continue;
    }
    if (typeof value !== "boolean") {
      throw new AbapError("BAD_INPUT", `set_node_flags: "${flag}" must be a boolean or null, got ${typeof value}.`, {
        flag,
        value,
      });
    }
    const rendered = ` bo:${flag}="${value}"`;
    if (attrRe.test(openTag)) {
      openTag = openTag.replace(attrRe, rendered);
    } else {
      const closesSelf = openTag.endsWith("/>");
      const insertAt = closesSelf ? openTag.length - 2 : openTag.length - 1;
      openTag = openTag.slice(0, insertAt) + rendered + openTag.slice(insertAt);
    }
  }
  let result = xml.slice(0, nodeTok.openStart) + openTag + xml.slice(nodeTok.openEnd);

  const refKeys = (NODE_REF_KINDS as readonly string[]).filter((k) => k in spec);
  for (const key of refKeys) {
    const refKind = key as NodeRefKind;
    const value = spec[refKind];
    const freshTokens = scanModel(result);
    if (value === null) {
      result = spliceSetNodeRef(result, freshTokens, currentName, refKind, null, { nodeId: sel.nodeId });
      continue;
    }
    const r = ref(value);
    if (!r) {
      throw new AbapError(
        "BAD_INPUT",
        `set_node_flags: "${refKind}" must be an object ref ({name, type[, uri]}) or null, got ${typeof value}.`,
        { refKind, value },
      );
    }
    result = spliceSetNodeRef(result, freshTokens, currentName, refKind, r, { nodeId: sel.nodeId });
  }
  return result;
}

type RemoveChildOp =
  | "remove_association"
  | "remove_action"
  | "remove_determination"
  | "remove_validation"
  | "remove_query"
  | "remove_alternative_key";

/** A `Record` keyed on the literal `RemoveChildOp` union (not `string`) so indexing isn't subject to `noUncheckedIndexedAccess`. */
const REMOVE_CHILD_KIND: Readonly<Record<RemoveChildOp, ChildElementKind>> = {
  remove_association: "association",
  remove_action: "action",
  remove_determination: "determination",
  remove_validation: "validation",
  remove_query: "query",
  remove_alternative_key: "alternativeKey",
};

const CHILD_KIND_LABEL: Readonly<Record<ChildElementKind, string>> = {
  association: "association",
  action: "action",
  determination: "determination",
  validation: "validation",
  query: "query",
  alternativeKey: "alternative key",
};

function pluralChildKindLabel(kind: ChildElementKind): string {
  const label = CHILD_KIND_LABEL[kind];
  const plural = label === "query" ? "queries" : `${label}s`;
  return plural.charAt(0).toUpperCase() + plural.slice(1);
}

/**
 * Removing a member by name only ever takes out the FIRST match in document
 * order (`locate`'s contract) — deliberately, not a bug: it's exactly what
 * lets a caller unwind a duplicate-name mess one element per
 * call. The NOT_FOUND here is custom rather than `requireLocate`'s generic
 * one because the whole point of these operations is undoing a mess the
 * caller cannot see — so it lists what actually exists.
 */
function removeChildElement(freshXml: string, tokens: readonly Token[], input: BopfEditInput, op: RemoveChildOp): string {
  const kind = REMOVE_CHILD_KIND[op];
  const sel = requireNode(input);
  const name = requireName(input);
  const range = locate(tokens, { ...sel, child: kind, name });
  if (!range) {
    const existing = listChildNames(tokens, sel, kind);
    throw new AbapError(
      "NOT_FOUND",
      `${op} "${name}" on ${input.bo} node "${sel.node}": no ${CHILD_KIND_LABEL[kind]} of that name exists ` +
        `there. ${pluralChildKindLabel(kind)} present on that node: ${existing.length ? existing.join(", ") : "none"}.`,
      { operation: op, bo: input.bo, node: sel.node, name, kind, existing },
    );
  }
  return spliceOut(freshXml, range);
}

type SetChildFieldsOp =
  | "set_association_fields"
  | "set_action_fields"
  | "set_determination_fields"
  | "set_validation_fields"
  | "set_query_fields"
  | "set_alternative_key_fields";

/** A `Record` keyed on the literal `SetChildFieldsOp` union (not `string`) so indexing isn't subject to `noUncheckedIndexedAccess` — see `REMOVE_CHILD_KIND`. */
const SET_CHILD_KIND: Readonly<Record<SetChildFieldsOp, ChildElementKind>> = {
  set_association_fields: "association",
  set_action_fields: "action",
  set_determination_fields: "determination",
  set_validation_fields: "validation",
  set_query_fields: "query",
  set_alternative_key_fields: "alternativeKey",
};

/** Same rationale as `SET_CHILD_KIND` — keyed on `ChildElementKind` so `CHILD_ORDER_BY_KIND[kind]` needs no `noUncheckedIndexedAccess` guard. */
const CHILD_ORDER_BY_KIND: Readonly<Record<ChildElementKind, readonly string[]>> = {
  association: ASSOCIATION_CHILD_ORDER,
  action: ACTION_CHILD_ORDER,
  determination: DETERMINATION_CHILD_ORDER,
  validation: VALIDATION_CHILD_ORDER,
  query: QUERY_CHILD_ORDER,
  alternativeKey: ALTERNATIVE_KEY_CHILD_ORDER,
};

/**
 * Patches a subset of one existing child element's fields in place —
 * distinct from remove_*+add_* because that pair mints a fresh nodeId and
 * loses anything BOPF only assigns once, at creation. Attribute fields are
 * batched through one `patchOpenTagAttrs` call; ref fields splice one at a
 * time via `spliceSetElementRef`, re-scanning the document between each
 * splice since every earlier splice shifts later byte offsets (same
 * reasoning as `patchNodeFlags`).
 *
 * The enum checks below duplicate exactly what the matching `build*Fields`
 * function applies via `strEnum` — this must not let a patch write a value
 * `add_*` would have refused. `validateSpecKeys` has already confirmed
 * every key present is recognised and its JS shape (string/boolean/ref, or
 * null) is right; it does not check enum membership.
 */
function patchChildFields(freshXml: string, tokens: readonly Token[], input: BopfEditInput, op: SetChildFieldsOp): string {
  const kind = SET_CHILD_KIND[op];
  const sel = requireNode(input);
  const name = requireName(input);
  const spec = (input.spec ?? {}) as Record<string, unknown>;
  const table: SpecFieldTable = SET_CHILD_FIELD_TABLES[op] ?? {};

  const token = locateToken(tokens, { ...sel, child: kind, name });
  if (!token) {
    const existing = listChildNames(tokens, sel, kind);
    throw new AbapError(
      "NOT_FOUND",
      `${op} "${name}" on ${input.bo} node "${sel.node}": no ${CHILD_KIND_LABEL[kind]} of that name exists ` +
        `there. ${pluralChildKindLabel(kind)} present on that node: ${existing.length ? existing.join(", ") : "none"}.`,
      { operation: op, bo: input.bo, node: sel.node, name, kind, existing },
    );
  }

  if (
    (op === "set_determination_fields" || op === "set_validation_fields" || op === "set_query_fields") &&
    "category" in spec &&
    spec.category !== null
  ) {
    const categories =
      op === "set_determination_fields"
        ? DETERMINATION_CATEGORIES
        : op === "set_validation_fields"
          ? VALIDATION_CATEGORIES
          : QUERY_CATEGORIES;
    strEnum(spec.category, categories, "category");
  }
  if (op === "set_alternative_key_fields" && "uniqueness" in spec && spec.uniqueness !== null) {
    strEnum(spec.uniqueness, KEY_UNIQUENESS_VALUES, "uniqueness");
  }

  const patchableFields = Object.keys(table).filter((k) => k !== "class" && k !== "implementationClass");
  const implClassRefRequested = "implementationClassRef" in spec || "class" in spec || "implementationClass" in spec;
  const anyFieldRequested = patchableFields.some((k) => (k === "implementationClassRef" ? implClassRefRequested : k in spec));
  if (!anyFieldRequested) {
    throw new AbapError(
      "BAD_INPUT",
      `${op} on ${input.bo} node "${sel.node}" ("${name}") names no field to change — spec is empty, or names ` +
        `only fields this operation cannot change. Patchable field(s): ${patchableFields.join(", ")}.`,
      { operation: op, bo: input.bo, node: sel.node, name, patchable: patchableFields },
    );
  }

  const attrs = new Map<string, string | boolean | null>();
  for (const [key, shape] of Object.entries(table)) {
    if ((shape !== "stringOrNull" && shape !== "booleanOrNull") || !(key in spec)) continue;
    attrs.set(key, spec[key] as string | boolean | null);
  }
  let result = attrs.size > 0 ? patchOpenTagAttrs(freshXml, token, attrs) : freshXml;

  const childOrder = CHILD_ORDER_BY_KIND[kind];
  for (const [key, shape] of Object.entries(table)) {
    if (shape !== "refOrNull") continue;
    const isImplClassRef = key === "implementationClassRef";
    if (isImplClassRef ? !implClassRefRequested : !(key in spec)) continue;

    let value: AdtObjectRef | null;
    if (isImplClassRef) {
      value = spec.implementationClassRef === null ? null : (classRefFromSpec(spec) ?? null);
    } else {
      const raw = spec[key];
      if (raw === null) {
        value = null;
      } else {
        const parsed = ref(raw);
        // validateSpecKeys already guaranteed this shape — undefined here would mean this module's checks
        // disagree with that one's; skip rather than clear on a mismatch neither should ever produce.
        if (!parsed) continue;
        value = parsed;
      }
    }

    const freshTokens = scanModel(result);
    const freshToken = locateToken(freshTokens, { ...sel, child: kind, name });
    if (!freshToken) {
      throw new AbapError(
        "UNSUPPORTED",
        `${op}: lost track of "${name}" on node "${sel.node}" while splicing ref field "${key}" — internal error.`,
        { operation: op, bo: input.bo, node: sel.node, name, key },
      );
    }
    result = spliceSetElementRef(result, freshTokens, freshToken, `bo:${key}`, value, childOrder);
  }

  return result;
}

/** `add_*`/`remove_*`/`set_*_fields` op-name suffix for each `ChildElementKind` — `alternativeKey` is the one case where the wire's camelCase kind and the snake_case operation name diverge. */
const CHILD_OP_SUFFIX: Readonly<Record<ChildElementKind, string>> = {
  association: "association",
  action: "action",
  determination: "determination",
  validation: "validation",
  query: "query",
  alternativeKey: "alternative_key",
};

/**
 * `add_*`'s post-PUT re-read (`MEMBER_CHECK_BY_OP` in `runBopfEdit`) only
 * checks that the member count went up — it can't tell a genuine add from a
 * SECOND element landing next to a first one it already saw. `mutateModel`
 * runs on freshly re-read bytes under the write lock, so this pre-splice
 * check is the only place that can see ground truth before it's too late.
 */
function refuseDuplicateChild(tokens: readonly Token[], input: BopfEditInput, sel: NodeSelector, kind: ChildElementKind, name: string): void {
  const existing = listChildNames(tokens, sel, kind);
  if (!existing.some((n) => n.toLowerCase() === name.toLowerCase())) return;
  const suffix = CHILD_OP_SUFFIX[kind];
  throw new AbapError(
    "BAD_INPUT",
    `${input.operation} "${name}" on ${input.bo} node "${sel.node}": a ${CHILD_KIND_LABEL[kind]} of that name ` +
      `already exists there. ${input.operation} is not an upsert — proceeding would create a second element ` +
      `named "${name}". BOPF writes are journalled but irreversible, so the duplicate could not be undone ` +
      `afterward. Use set_${suffix}_fields to change the existing one, or remove_${suffix} first.`,
    { operation: input.operation, bo: input.bo, node: sel.node, name, kind, existing },
  );
}

/** Applies one `abap_bopf_edit` operation (everything except `create_bo`/`activate`, which never reach here) to freshly-reread bytes. */
function mutateModel(freshXml: string, input: BopfEditInput): string {
  const tokens = scanModel(freshXml);
  const spec = (input.spec ?? {}) as Record<string, unknown>;

  switch (input.operation) {
    case "add_node": {
      const name = requireName(input);
      const link = resolveParentLink(spec, tokens);
      if (!link && spec.rootNode !== true) {
        throw new AbapError(
          "BAD_INPUT",
          `add_node "${name}" needs a parent — neither spec.parent nor spec.parentNodeId names one, and ` +
            `spec.rootNode is not true. BOPF answers 200 and silently discards a node it can't place, rather ` +
            `than rejecting it.`,
          { name },
        );
      }
      const fields = buildNodeFields(name, mintGuid("node"), spec, link);
      return insertNodeAtRoot(freshXml, tokens, renderNodeElement(fields));
    }
    case "remove_node": {
      const range = requireLocate(tokens, requireNode(input));
      return spliceOut(freshXml, range);
    }
    case "add_association": {
      const sel = requireNode(input);
      const name = requireName(input);
      refuseDuplicateChild(tokens, input, sel, "association", name);
      const fields = buildAssociationFields(name, mintGuid("association"), spec);
      return spliceInsertChild(freshXml, tokens, sel.node, "association", renderAssociationElement(fields), {
        nodeId: sel.nodeId,
      });
    }
    case "add_action": {
      const sel = requireNode(input);
      const name = requireName(input);
      refuseDuplicateChild(tokens, input, sel, "action", name);
      const fields = buildActionFields(name, mintGuid("action"), spec);
      return spliceInsertChild(freshXml, tokens, sel.node, "action", renderActionElement(fields), { nodeId: sel.nodeId });
    }
    case "add_determination": {
      const sel = requireNode(input);
      const name = requireName(input);
      refuseDuplicateChild(tokens, input, sel, "determination", name);
      const fields = buildDeterminationFields(input.bo, sel.node, name, mintGuid("determination"), spec);
      return spliceInsertChild(freshXml, tokens, sel.node, "determination", renderDeterminationElement(fields), {
        nodeId: sel.nodeId,
      });
    }
    case "add_validation": {
      const sel = requireNode(input);
      const name = requireName(input);
      refuseDuplicateChild(tokens, input, sel, "validation", name);
      const fields = buildValidationFields(input.bo, sel.node, name, mintGuid("validation"), spec);
      return spliceInsertChild(freshXml, tokens, sel.node, "validation", renderValidationElement(fields), {
        nodeId: sel.nodeId,
      });
    }
    case "add_query": {
      const sel = requireNode(input);
      const name = requireName(input);
      refuseDuplicateChild(tokens, input, sel, "query", name);
      const fields = buildQueryFields(name, mintGuid("query"), spec);
      return spliceInsertChild(freshXml, tokens, sel.node, "query", renderQueryElement(fields), { nodeId: sel.nodeId });
    }
    case "add_alternative_key": {
      const sel = requireNode(input);
      const name = requireName(input);
      refuseDuplicateChild(tokens, input, sel, "alternativeKey", name);
      const fields = buildAlternativeKeyFields(name, mintGuid("alternativeKey"), spec);
      return spliceInsertChild(freshXml, tokens, sel.node, "alternativeKey", renderAlternativeKeyElement(fields), {
        nodeId: sel.nodeId,
      });
    }
    case "remove_association":
    case "remove_action":
    case "remove_determination":
    case "remove_validation":
    case "remove_query":
    case "remove_alternative_key":
      return removeChildElement(freshXml, tokens, input, input.operation);
    case "set_association_fields":
    case "set_action_fields":
    case "set_determination_fields":
    case "set_validation_fields":
    case "set_query_fields":
    case "set_alternative_key_fields":
      return patchChildFields(freshXml, tokens, input, input.operation);
    case "set_node_flags":
      return patchNodeFlags(freshXml, tokens, requireNode(input), spec);
    case "remove_dependent_object":
      return mutateDelegation(freshXml, input as DelegationInput);
    case "create_bo":
    case "activate":
      throw new AbapError(
        "UNSUPPORTED",
        `operation "${input.operation}" is handled by its caller and must never reach mutateModel.`,
        { operation: input.operation },
      );
  }
}

/**
 * Omitted `spec.category` is legitimate input, not refused — but per live
 * recon BOPF defaults it server-side to the literal "undefined", and every
 * sample found in that state had a trigger that never fired. Surfaced as an
 * explicit response note rather than silently proceeding.
 */
function determinationCategoryOmittedNote(input: BopfEditInput): string | undefined {
  if (input.operation !== "add_determination") return undefined;
  const spec = (input.spec ?? {}) as Record<string, unknown>;
  if (str(spec.category) !== undefined) return undefined;
  return (
    "spec.category was omitted — BOPF defaults an unset determination category to the literal \"undefined\" " +
    "server-side, and (per live A4H recon) a determination in that state does not fire its triggers. Pass a " +
    "real category (e.g. \"reactDuringSave\", \"reactAfterModification\") if this determination is meant to " +
    "run."
  );
}

/**
 * `create_bo`'s POST body (`buildCreateBody`, `src/adt/bopf.ts`) carries no
 * DDIC refs — so every ref present on the freshly re-read root node was
 * assigned by BOPF, not supplied by this call. Two consequences, surfaced
 * here rather than left for the caller to discover later:
 *  - no `persistentStructureRef` means activation fails ("Data structure is
 *    missing") until one is set — `set_node_flags` is the only
 *    operation that can add one to an existing node, per `patchNodeFlags`'s
 *    doc comment above.
 *  - `persistentTableRef`/`persistentStructureRef` are exactly the two ref
 *    slots `collectDdicCascadeCandidates` (`src/adt/bopf.ts`) spares from
 *    `cascade_ddic` — so whichever of them BOPF auto-assigned here is left
 *    on the system after a cascade delete, and this is the only
 *    point in the lifecycle where "BOPF assigned it, the caller didn't"
 *    is known.
 *
 * The other three ref slots invert that rule: `persistentTableRef`,
 * `combinedTableRef`, and `combinedStructureRef` must NOT already exist —
 * BOPF generates them at activation. Live A4H recon (2026-08-29): binding an
 * existing DDIC structure to `persistentStructureRef` activated cleanly;
 * binding an existing transparent table to `persistentTableRef` (root and a
 * child, both tested) produced severity-E "Data Type <NAME> already exists"
 * on `bo:persistentTableRef` instead. A control case (root's own
 * auto-assigned `persistentTableRef`, confirmed absent beforehand) activated
 * and created the table. Only `persistentTableRef` was tested against a
 * pre-existing object — whether `combinedStructureRef`/`combinedTableRef`
 * fail the same way, or whether this holds on releases other than A4H, is
 * not established. Root-only vs. child also differs: a root-only BO
 * activates on `persistentStructureRef` alone, a child needs all four slots
 * or fails with three severity-E messages ("Database table is missing",
 * "Combined table type is missing", "Combined structure is missing").
 * `add_node` does not supply the other three on a child — confirmed live:
 * a bare `add_node` gives a child none of the four ref slots, only
 * the root gets them auto-assigned. `03-after-put-item-node-and-assoc.v4.xml`
 * shows an ITEM with all three set, but it predates `add_node` (a
 * hand-authored PUT that supplied the refs itself) and does not reflect
 * current behaviour. See `test/fixtures/bopf/README.md`.
 */
function createBoActivatabilityNotes(model: BoModel): string[] {
  const root = model.nodes.find((n) => n.rootNode);
  if (!root) return [];
  const notes: string[] = [];
  if (!root.persistentStructureRef) {
    notes.push(
      `Root node "${root.name}" has no persistentStructureRef — activation will fail with "Data structure is ` +
        `missing" until one is set. Repair with abap_bopf_edit operation=set_node_flags on node "${root.name}", ` +
        `spec.persistentStructureRef = { name, type: "TABL/DS" }. create_bo cannot supply this itself. The DDIC ` +
        "structure only has to already exist — point at an existing one, or create it with abap_write.",
    );
    notes.push(
      "The other three ref slots — persistentTableRef, combinedTableRef, combinedStructureRef — work the " +
        "opposite way from persistentStructureRef: BOPF generates them at activation and they must NOT " +
        'already exist. Binding an existing transparent table to persistentTableRef (tested live, both root ' +
        'and a child node) activates with severity-E "Data Type <NAME> already exists" on ' +
        "bo:persistentTableRef — not a name collision to rename around, but an unactivatable object, since " +
        "the fix is a name nothing will ever create by hand. Whether combinedStructureRef/combinedTableRef " +
        "fail the same way, or whether this rule holds on releases other than A4H, was not tested. A child " +
        "node additionally needs persistentTableRef, combinedTableRef, and combinedStructureRef set before " +
        "it activates at all — a root-only BO activates with just persistentStructureRef, but an " +
        'otherwise-untouched child fails with three separate severity-E messages: "Database table is ' +
        'missing" (persistentTableRef), "Combined table type is missing" (combinedTableRef), "Combined ' +
        'structure is missing" (combinedStructureRef). Whether add_node leaves those three unset on a child ' +
        "varies by observation — don't assume either way.",
    );
  }
  const autoAssigned = (["persistentTableRef", "persistentStructureRef"] as const).flatMap((kind) => {
    const ref = root[kind];
    return ref ? [{ kind, name: ref.name }] : [];
  });
  if (autoAssigned.length > 0) {
    const autoAssignedNames = Array.from(new Set(autoAssigned.map((a) => a.name)));
    notes.push(
      `create_bo sends no DDIC refs, so ${autoAssigned.map((a) => `${a.kind} ${a.name}`).join(", ")} on root ` +
        `node "${root.name}" came from BOPF's own defaulting, not from this call. abap_bopf_delete's default ` +
        `cascade_ddic sweep spares ${autoAssigned.length === 1 ? "it" : "them"}; deleting ` +
        `${autoAssigned.length === 1 ? "it" : "them"} too takes an explicit opt-in by name on that call: ` +
        `cascade_persistent: [${autoAssignedNames.map((n) => `"${n}"`).join(", ")}].`,
    );
  }
  return notes;
}

/**
 * Renders the root-node-name discrepancy on a `create_bo` — a root node that
 * DID land, under a non-empty name other than the one requested. The
 * unnamed/absent cases are not reportable notes any more: `runBopfEdit`
 * refuses those with `BOPF_CREATE_UNUSABLE` (see `unusableRootNodeError`
 * below) before a success response is ever built.
 */
function createBoRootNodeNotes(boName: string, check: RootNodeNameCheck): string[] {
  if (check.actual !== undefined && check.actual !== "" && !check.matches) {
    return [
      `create_bo for "${boName}" requested root node "${check.requested}", but the root node actually created ` +
        `is named "${check.actual}" instead.`,
    ];
  }
  return [];
}

/**
 * The create landed, but the root node BOPF actually created is unnamed
 * (`bo:name=""`) or the read-back model carries no root node at all.
 * `buildCreateBody` (`src/adt/bopf.ts`) always sends an explicitly named
 * `bo:nodes` element — but the create POST is non-atomic (see that module's
 * header), and a `SESSION_DEAD` on it can still let the object land
 * server-side with a root node the server itself auto-generated, unnamed.
 * BOPF bakes that name into the generated `Z*_C` constants interface AT
 * CREATE TIME (`BEGIN OF ,` — invalid ABAP, when the name is empty) and
 * never regenerates that interface on any later PUT, rename, or activation
 * attempt — live-proven in this repo (renaming the empty-name root
 * post-create and retrying activation twice left the interface's source
 * etag unchanged both times; see the `create_bo` paragraph in
 * `doc/TOOLS/bopf.md` and the tests in `test/bopf-create-recovery.test.ts`).
 * Renaming is therefore not a repair — the only remedy is `abap_bopf_delete`
 * followed by creating the BO again.
 */
function unusableRootNodeError(
  boName: string,
  check: RootNodeNameCheck,
  entryId: string | undefined,
  activationSkipped: boolean,
): AbapError {
  // Only the leading clause differs between the two unusable shapes; the
  // rest of the wording (remedy, residue warning, journal reference, and
  // the activation-skipped addendum) is identical, so it is built once here
  // instead of twice.
  const lead =
    check.actual === undefined
      ? `create_bo for "${boName}" requested root node "${check.requested}", but the model read back after ` +
        "create carries no root node at all. BOPF bakes the root node name into the generated constants " +
        "interface AT CREATE TIME"
      : `create_bo for "${boName}" requested root node "${check.requested}", but the root node BOPF actually ` +
        'created came back UNNAMED (bo:name="") instead. BOPF bakes that empty name into the generated ' +
        'constants interface AT CREATE TIME (an invalid "BEGIN OF ," ABAP structure)';
  const tail =
    " and never regenerates that interface, so this business object can never be activated. Renaming the " +
    "root node afterward does NOT repair the interface — live-observed in this repo (two activation " +
    `retries, source etag unchanged). The only remedy: abap_bopf_delete "${boName}", then create it again. ` +
    "This BO already exists on the system right now and is residue that must be cleaned up" +
    (entryId !== undefined ? ` (journal entry ${entryId})` : "") +
    "." +
    (activationSkipped
      ? " No activation was attempted — an object whose constants interface is already invalid can only " +
        "fail to activate."
      : "");
  return new AbapError(
    "BOPF_CREATE_UNUSABLE",
    lead + tail,
    { bo: boName, requested: check.requested, actual: check.actual, journalEntryId: entryId },
    `abap_bopf_delete "${boName}", then create_bo again.`,
  );
}

/**
 * `add_node`'s PUT (`buildNodeFields`) maps caller-supplied
 * `spec.persistentTableRef`/`spec.persistentStructureRef` straight through —
 * unlike create_bo's POST, which carries no DDIC refs at all (see
 * `createBoActivatabilityNotes` above) — so a ref counts as BOPF's own
 * defaulting here only when `input.spec` for this call didn't send it; that
 * comparison is per-call against the actual request, not inferred from a
 * fixture. The naming family matches create_bo's regardless: the captured
 * create_bo response (`02-created-zbopf_prb1-root-only.v4.xml`, ROOT ->
 * persistentTableRef ZBOPF_D_ROOT) and the captured post-PUT shape
 * (`03-after-put-item-node-and-assoc.v4.xml`, ITEM -> persistentTableRef
 * ZBOPF_D_ITEM) are both `<stem>_{D,S,T}_<node name>` — same stem, node name
 * varying.
 */
function addNodeAutoAssignedRefsNote(input: BopfEditInput, model: BoModel): string | undefined {
  const name = requireName(input).toLowerCase();
  const node = model.nodes.find((n) => n.name.toLowerCase() === name);
  if (!node) return undefined;
  const spec = (input.spec ?? {}) as Record<string, unknown>;
  const autoAssigned = (["persistentTableRef", "persistentStructureRef"] as const).flatMap((kind) => {
    if (ref(spec[kind])) return [];
    const r = node[kind];
    return r ? [{ kind, name: r.name }] : [];
  });
  if (autoAssigned.length === 0) return undefined;
  const autoAssignedNames = Array.from(new Set(autoAssigned.map((a) => a.name)));
  return (
    `spec didn't set ${autoAssigned.map((a) => `${a.kind} ${a.name}`).join(", ")} on node "${node.name}", so ` +
    `${autoAssigned.length === 1 ? "it" : "they"} came from BOPF's own defaulting, not from this call — same ` +
    `naming family as create_bo's auto-assigned refs. abap_bopf_delete's default cascade_ddic sweep spares ` +
    `${autoAssigned.length === 1 ? "it" : "them"}; deleting ${autoAssigned.length === 1 ? "it" : "them"} too ` +
    `takes an explicit opt-in by name on that call: cascade_persistent: [${autoAssignedNames.map((n) => `"${n}"`).join(", ")}].`
  );
}

function buildEditResponse(
  bo: string,
  model: BoModel,
  danglingVerdict: DanglingVerdict | undefined,
  activation: ActivationOutcomeBopf | undefined,
  recovered: boolean,
  journalEntryId: string | undefined,
  maxChars: number,
  extraNotes: readonly string[] = [],
  rootNodeCheck?: RootNodeNameCheck,
): string {
  const notes: string[] = [...extraNotes];
  if (recovered) {
    notes.push(
      rootNodeCheck !== undefined && !rootNodeCheck.matches
        ? "The create POST itself failed/threw, but a re-GET afterwards confirmed the object was created anyway " +
            "(non-atomic create). NOT a clean create: the root node did not come back as requested — see the " +
            "root node note above."
        : "The create POST itself failed/threw, but a re-GET afterwards confirmed the object was created anyway " +
            "(non-atomic create). Treated as a successful create.",
    );
  }
  if (danglingVerdict && danglingVerdict.verdict !== "present") {
    notes.push(
      `Dangling-ref check on class ${danglingVerdict.className}: ${danglingVerdict.verdict}` +
        (danglingVerdict.verdict === "allowed"
          ? " — allow_dangling_ref: true was passed, so this proceeded despite the class not existing as a " +
            "source artifact. A determination/validation/action/query bound to it activates cleanly and " +
            "silently never fires."
          : danglingVerdict.verdict === "declaration-only"
            ? " — the class exists but has no IMPLEMENTATION section yet."
            : " — the class exists but does not (yet) implement the interface this element's role requires " +
              "(substring match only; inherited interfaces are not visible here)."),
    );
  }
  if (activation) {
    notes.push(
      activation.activated
        ? "Activated successfully (corroborated by a fresh re-read)."
        : "Activation did NOT succeed (activation always answers 200 even on failure; corroborated by " +
            `an independent re-read: version=${activation.version ?? "unknown"}). See activationMessages below.`,
    );
  }
  // Never named in the request — this is SAP's own preaudit set, dragged in by activation.
  const sections = activation?.preaudit?.length
    ? [{ title: "CO-ACTIVATED", content: renderCoActivated(activation.preaudit) }]
    : undefined;
  return buildResponse({
    header: {
      bo,
      version: model.version,
      package: model.packageRef?.name,
      constantsInterface: model.constantsInterfaceRef?.name,
      nodeCount: model.nodes.length,
      // Makes a clean live create's root node name observable at a glance.
      // The unnamed/absent cases never reach here — runBopfEdit refuses
      // those with BOPF_CREATE_UNUSABLE before building a response.
      ...(rootNodeCheck ? { rootNode: rootNodeCheck.actual } : {}),
      activated: activation?.activated,
      activationMessages: activation && activation.messages.length ? JSON.stringify(activation.messages) : undefined,
      journalEntryId,
    },
    notes,
    ...(sections ? { sections } : {}),
    maxChars,
  }).text;
}

type MemberKind = "association" | "action" | "determination" | "validation" | "query" | "alternativeKey";

type BoMember = BoAssociation | BoAction | BoDetermination | BoValidation | BoQuery | BoAlternativeKey;

const MEMBERS_BY_KIND: Readonly<Record<MemberKind, (n: BoNode) => readonly BoMember[]>> = {
  association: (n) => n.associations,
  action: (n) => n.actions,
  determination: (n) => n.determinations,
  validation: (n) => n.validations,
  query: (n) => n.queries,
  alternativeKey: (n) => n.alternativeKeys,
};

/** Count, not mere presence — an add matching a member that already existed must not pass just because a same-named member was already there before this call. */
function countMembers(model: BoModel, kind: MemberKind, node: string, member: string): number {
  const nodeName = node.toLowerCase();
  const memberName = member.toLowerCase();
  return model.nodes
    .filter((n) => n.name.toLowerCase() === nodeName)
    .flatMap((n) => MEMBERS_BY_KIND[kind](n))
    .filter((m) => m.name.toLowerCase() === memberName).length;
}

/**
 * Bare node name an association's `targetNodeRef` points at — same
 * resolution order as `targetNodeName` in bopf-runtime.ts (uri's XPath
 * fragment, else the part after the last `~` in name, else name unchanged).
 */
function resolveTargetNodeName(ref: AdtObjectRef | undefined): string | undefined {
  if (!ref) return undefined;
  if (ref.uri) {
    const m = /bo:nodes\[@bo:name='([^']*)'\]\s*$/.exec(ref.uri);
    if (m) return m[1];
  }
  const tilde = ref.name.lastIndexOf("~");
  return tilde >= 0 ? ref.name.slice(tilde + 1) : ref.name;
}

/**
 * An existing association on `node` with the same implementationType and
 * target node as the one just requested — the signature BOPF treats as a
 * duplicate and silently discards (e.g. add_node's auto-created ROOT→child
 * Composition link). Case-insensitive on both fields.
 */
function findEquivalentAssociation(
  node: BoNode,
  implementationType: string,
  targetNode: string,
): BoAssociation | undefined {
  const wantType = implementationType.toLowerCase();
  const wantTarget = targetNode.toLowerCase();
  return node.associations.find(
    (a) =>
      (a.implementationType ?? "").toLowerCase() === wantType &&
      (resolveTargetNodeName(a.targetNodeRef) ?? "").toLowerCase() === wantTarget,
  );
}

const MEMBER_CHECK_BY_OP: Readonly<Record<string, { readonly kind: MemberKind; readonly direction: "added" | "removed" }>> = {
  add_association: { kind: "association", direction: "added" },
  add_action: { kind: "action", direction: "added" },
  add_determination: { kind: "determination", direction: "added" },
  add_validation: { kind: "validation", direction: "added" },
  add_query: { kind: "query", direction: "added" },
  add_alternative_key: { kind: "alternativeKey", direction: "added" },
  remove_association: { kind: "association", direction: "removed" },
  remove_action: { kind: "action", direction: "removed" },
  remove_determination: { kind: "determination", direction: "removed" },
  remove_validation: { kind: "validation", direction: "removed" },
  remove_query: { kind: "query", direction: "removed" },
  remove_alternative_key: { kind: "alternativeKey", direction: "removed" },
};

type FlagMismatch = { readonly field: string; readonly sent: unknown; readonly readBack: unknown };

function describeFlagValue(v: unknown): string {
  if (v === null || v === undefined) return "absent";
  if (typeof v === "object") {
    const r = v as AdtObjectRef;
    return `${r.name} (${r.type})`;
  }
  return String(v);
}

/**
 * `set_node_flags` verification: a cleared boolean flag reads back as
 * `false` (an absent `bo:*` attribute parses to `false` in `parseNodeXml`),
 * and a cleared ref reads back as `undefined`. The `continue`s below skip
 * values `patchNodeFlags` already rejected with BAD_INPUT before the PUT.
 */
function nodeFlagMismatches(node: BoNode, spec: Record<string, unknown>): FlagMismatch[] {
  const out: FlagMismatch[] = [];
  for (const flag of NODE_FLAG_NAMES) {
    if (!(flag in spec)) continue;
    const sent = spec[flag];
    if (sent !== null && typeof sent !== "boolean") continue;
    const expected = sent === null ? false : sent;
    const readBack = node[flag];
    if (readBack !== expected) out.push({ field: flag, sent, readBack });
  }
  for (const kind of NODE_REF_KINDS) {
    if (!(kind in spec)) continue;
    const sent = spec[kind];
    const readBack = node[kind];
    if (sent === null) {
      if (readBack !== undefined) out.push({ field: kind, sent: null, readBack });
      continue;
    }
    const wanted = ref(sent);
    if (!wanted) continue;
    if (
      !readBack ||
      readBack.name.toLowerCase() !== wanted.name.toLowerCase() ||
      readBack.type.toLowerCase() !== wanted.type.toLowerCase()
    ) {
      out.push({ field: kind, sent: wanted, readBack: readBack ?? null });
    }
  }
  return out;
}

/**
 * `set_*_fields` verification counterpart to `nodeFlagMismatches`. Differs
 * from it in one deliberate way: a cleared `booleanOrNull` field is compared
 * with strict `===`, not "cleared reads back as `false`" — `parseNodeXml`
 * defaults an absent node boolean to `false` via `?? false`, but none of the
 * child-element parsers (`parseAssociationXml` etc.) apply that default, so
 * an absent child boolean reads back as `undefined`, and a `false` sent
 * would be indistinguishable from "discarded" if compared the node-flag way.
 */
function childFieldMismatches(
  element: Record<string, unknown>,
  spec: Record<string, unknown>,
  table: SpecFieldTable,
): FlagMismatch[] {
  const out: FlagMismatch[] = [];
  const implClassRefRequested = "implementationClassRef" in spec || "class" in spec || "implementationClass" in spec;
  for (const [key, shape] of Object.entries(table)) {
    if (key === "class" || key === "implementationClass") continue;
    if (key === "implementationClassRef") {
      if (!implClassRefRequested) continue;
      const sent = spec.implementationClassRef === null ? null : (classRefFromSpec(spec) ?? null);
      const readBack = element[key] as AdtObjectRef | undefined;
      if (sent === null) {
        if (readBack !== undefined) out.push({ field: key, sent: null, readBack });
        continue;
      }
      if (!readBack || readBack.name.toLowerCase() !== sent.name.toLowerCase() || readBack.type.toLowerCase() !== sent.type.toLowerCase()) {
        out.push({ field: key, sent, readBack: readBack ?? null });
      }
      continue;
    }
    if (!(key in spec)) continue;
    const sent = spec[key];
    if (shape === "refOrNull") {
      const readBack = element[key] as AdtObjectRef | undefined;
      if (sent === null) {
        if (readBack !== undefined) out.push({ field: key, sent: null, readBack });
        continue;
      }
      const wanted = ref(sent);
      if (!wanted) continue;
      if (!readBack || readBack.name.toLowerCase() !== wanted.name.toLowerCase() || readBack.type.toLowerCase() !== wanted.type.toLowerCase()) {
        out.push({ field: key, sent: wanted, readBack: readBack ?? null });
      }
    } else if (shape === "stringOrNull") {
      const readBack = element[key] as string | undefined;
      // Case-insensitive: SAP's own casing convention on a string field isn't ground truth for
      // whether the write stuck, and a case difference alone isn't evidence of a discarded value.
      const expected = sent === null ? undefined : sent;
      const same =
        expected === undefined
          ? readBack === undefined
          : typeof readBack === "string" && typeof expected === "string" && readBack.toLowerCase() === expected.toLowerCase();
      if (!same) out.push({ field: key, sent, readBack: readBack ?? null });
    } else if (shape === "booleanOrNull") {
      const readBack = element[key];
      const expected = sent === null ? undefined : sent;
      if (readBack !== expected) out.push({ field: key, sent, readBack: readBack ?? null });
    }
  }
  return out;
}

/**
 * Attaches which `abap_bopf_edit` call killed the session to a `SESSION_DEAD`
 * error, so a caller running a sequence of edits can tell which one did it.
 * Leaves every other error untouched, and carries
 * `e.details.condemned` through unchanged — `src/adt/pool.ts` reads it to
 * decide whether the slot is retired.
 */
function attributeSessionDeath(e: unknown, input: BopfEditInput): unknown {
  if (!isAbapError(e) || e.code !== "SESSION_DEAD") return e;
  const node = input.node;
  const name = input.name;
  const message =
    `${e.message} It died during abap_bopf_edit ${input.operation} on ${input.bo}` +
    (node !== undefined ? ` node "${node}"` : "") +
    (typeof name === "string" && name !== "" ? ` ("${name}")` : "") +
    ".";
  const details: Record<string, unknown> = {
    ...e.details,
    tool: "abap_bopf_edit",
    operation: input.operation,
    bo: input.bo,
    ...(node !== undefined ? { node } : {}),
    ...(typeof name === "string" && name !== "" ? { name } : {}),
  };
  const hint =
    e.details.kind === "dump"
      ? "The session died while the server was processing this edit, so every lock it held is already " +
        "released and nothing was activated. Do NOT retry the identical call — an ASSERTION_FAILED in " +
        "BOPF's model mapper (/BOBF/CL_CONF_MODEL_API_MAP) is deterministic in the payload, and the same " +
        "request will kill the session again. Re-read the BO first, since the PUT may or may not have " +
        "landed, and check the spec fields the mapper has to map (uniqueness/dataTypeRef/dataTableTypeRef/" +
        "keyElements on an alternative key, category on a determination/validation/query). This is NOT an " +
        "authentication failure."
      : e.hint;
  return new AbapError(e.code, message, details, hint);
}

const BOPF_EDIT_TOOL_DESCRIPTION =
  "One design-time edit to a BOPF business object (or create one). node/name/spec carry the specifics — " +
  "see the abapsmith-edit-a-bopf-object skill for spec shapes, add_node/remove_node rules, and " +
  "dangling-ref handling. add_alternative_key and set_alternative_key_fields both need " +
  "i_know_this_may_not_activate: true — the same short-dump-prone mapper handles both; add_alternative_key " +
  "additionally needs spec.uniqueness/dataTypeRef/dataTableTypeRef/keyElements, all four. remove_dependent_object " +
  "removes an existing dependent-object embedding (its DoComposition association plus the matching " +
  '"<name>.ROOT" node); abapsmith cannot create one — see doc/CAPABILITIES/bopf.md.';

/**
 * Takes the whole `createRequest`, not a bare BO name, so a future field
 * added to `CreateBusinessObjectInput` can't silently go unverified by
 * `createBoRootNodeNotes` on this path.
 */
function recoverCreateAfterSessionDeath(
  deps: BopfRunDeps,
  createRequest: CreateBusinessObjectInput,
): Promise<BopfModelRead> {
  return deps.pool.withRead("abap_bopf_edit", (conn) => readModel(conn, createRequest.name));
}

export async function runBopfEdit(deps: BopfRunDeps, args: unknown): Promise<BopfCallResult> {
  const input = args as BopfEditInput;
  const bo = input.bo;

  if (
    (input.operation === "add_alternative_key" || input.operation === "set_alternative_key_fields") &&
    input.i_know_this_may_not_activate !== true
  ) {
    throw new AbapError(
      "BAD_INPUT",
      `${input.operation} requires i_know_this_may_not_activate: true — an alternative-key payload goes ` +
        "through /BOBF/CL_CONF_MODEL_API_MAP, the same mapper an invalid one has short-dumped, and the " +
        "operation is not confirmed to succeed on any node.",
      { operation: input.operation },
    );
  }
  validateEditInputShape(input);

  const gateKey = bopfGateKey(bo);
  const wantsActivate = input.operation === "activate" || input.activate === true;

  // Zero-network preflight — refused here costs no request, and no transport
  // is resolved yet, so `{kind:"unresolved"}` keeps step 10 from fabricating an
  // "auto" to judge; deny-all still fires (write.ts's `preflightCorr` defers
  // the same way). Both calls carry it — same shape, and write refuses first.
  deps.safety.assert(
    "write",
    { name: bo, packageName: input.package, type: BOPF_TYPE },
    { phase: "preflight", corr: { kind: "unresolved" } },
  );
  if (wantsActivate) {
    deps.safety.assert(
      "activate",
      { name: bo, packageName: input.package, type: BOPF_TYPE },
      { phase: "preflight", corr: { kind: "unresolved" } },
    );
  }

  await deps.ensureConnected();

  if (input.operation === "create_bo") {
    if (!input.package || !input.package.trim()) {
      throw new AbapError("BAD_INPUT", "create_bo requires package.", { operation: input.operation });
    }
    // Built once, ahead of `pool.withWrite` below, so both the normal create
    // AND the SESSION_DEAD recovery read from the exact same request object —
    // a future field added to `CreateBusinessObjectInput`
    // then can't silently miss the recovery path the way a bare `bo` name
    // would let it.
    const createRequest: CreateBusinessObjectInput = {
      name: bo,
      packageName: input.package!,
      description: input.description,
      rootNodeName: input.rootNodeName,
    };
    // `existedBefore: false`/`beforeCapture: "confirmed-absent"`: `run` only
    // returns normally when the server accepted a genuine CREATE (including
    // both `recovered: true` paths below). `irreversible: true`: BOPF undo
    // is refused by `undoBlocker()`'s catch-all (`src/adt/undo.ts`) before
    // it matters that `resolveWriteTarget` would also reject BOPF_TYPE — see
    // doc/JOURNAL/undo-and-recovery.md's "Undo semantics" table.
    //
    // `withJournalledMutation` wraps `pool.withWrite` (not the reverse) so a
    // `SESSION_DEAD` from the write can be recovered on a DIFFERENT pool
    // slot — the dead slot is retired by the pool itself, and
    // `pool.withRead` must run outside the write lease that just died,
    // never nested inside it.
    let sessionDiedMidCreate = false;
    const { result, entryId, settle } = await withJournalledMutation(
      deps.journal,
      {
        begin: (cfg: Config) => ({
          operation: "create" as const,
          object: journalRef({
            name: bo,
            type: BOPF_TYPE,
            uri: bopfUri(bo),
            packageName: input.package!,
            ...(input.description ? { description: input.description } : {}),
          }),
          existedBefore: false,
          beforeCapture: "confirmed-absent" as const,
          irreversible: true,
          // Without `systemKey`, `systemMismatchBlocker` (adt/undo.ts) can't
          // do its strong SID+origin+client compare and falls back to
          // SID-only, which can't tell apart two boxes sharing a SID.
          systemKey: systemKey(cfg),
          tool: "abap_bopf_edit",
        }),
      },
      async (onBeforeImage) => {
        try {
          return await deps.pool.withWrite("abap_bopf_edit", gateKey, async (conn) => {
            // No fresh reread precedes a create (nothing to reread) —
            // calling this first satisfies the "entry on disk before the
            // mutating request" ordering rule directly.
            await onBeforeImage(conn.cfg);
            // Final-phase authorize — package is already known here
            // (create_bo requires it as direct input, unlike edit/delete).
            // Nothing is resolved yet; `createBusinessObject` below is what resolves it.
            const authorized = deps.safety.authorize(
              "write",
              { name: bo, packageName: input.package!, type: BOPF_TYPE },
              { corr: { kind: "unresolved" } },
            );
            const created = await createBusinessObject(conn, deps.transport, createRequest, authorized);
            const unusable = created.rootNodeCheck.actual === undefined || created.rootNodeCheck.actual === "";
            let activation: ActivationOutcomeBopf | undefined;
            // An object whose constants interface is already invalid can only
            // fail to activate — the round trip is refused below instead.
            if (wantsActivate && !unusable) {
              // Judges the same transport question createBusinessObject already
              // resolved, instead of a fabricated "auto" — one logical create,
              // one transport decision.
              deps.safety.assert(
                "activate",
                { name: bo, packageName: created.model.packageRef?.name ?? input.package, type: BOPF_TYPE },
                { corr: created.corr },
              );
              activation = await activateBusinessObject(conn, bo);
            }
            return {
              model: created.model,
              xml: created.xml,
              recovered: created.recovered === true,
              activation,
              rootNodeCheck: created.rootNodeCheck,
            };
          });
        } catch (e) {
          if (!(isAbapError(e) && e.code === "SESSION_DEAD")) throw e;
          // The write's own session died before its response arrived — the
          // create may have landed anyway. The dead slot is
          // retired; re-read on a fresh one. No activation was ever sent on
          // the dead session, and none is attempted here even if
          // `wantsActivate` — a session that died mid-request cannot be
          // trusted to have applied anything past the create.
          let reread: BopfModelRead;
          try {
            reread = await recoverCreateAfterSessionDeath(deps, createRequest);
          } catch {
            throw e;
          }
          sessionDiedMidCreate = true;
          return {
            model: reread.model,
            xml: reread.xml,
            recovered: true,
            activation: undefined,
            rootNodeCheck: checkRootNodeName(createRequest, reread.model),
          };
        }
      },
    );
    // The object genuinely exists on the system, so the journal entry stays
    // `succeeded` regardless of what happens next — the residue has to be
    // recorded, not hidden behind a failed mutation.
    await settle({ outcome: "succeeded", afterSource: result.xml });
    if (result.rootNodeCheck.actual === undefined || result.rootNodeCheck.actual === "") {
      throw unusableRootNodeError(bo, result.rootNodeCheck, entryId, wantsActivate);
    }
    return ok(
      buildEditResponse(
        bo,
        result.model,
        undefined,
        result.activation,
        result.recovered,
        entryId,
        deps.cfg.maxResponseChars,
        [
          ...(sessionDiedMidCreate
            ? [
                "The write session died (SESSION_DEAD) after the create request was sent; a fresh session re-read " +
                  "confirms the object exists and is usable. No activation was attempted on this call — the session " +
                  "that died cannot be trusted to have sent one, even if activate was requested.",
              ]
            : []),
          ...createBoRootNodeNotes(bo, result.rootNodeCheck),
          ...createBoActivatabilityNotes(result.model),
        ],
        result.rootNodeCheck,
      ),
      entryId,
    );
  }

  const result = await deps.pool.withWrite("abap_bopf_edit", gateKey, (conn) =>
    conn.withStatefulSession(async (session) => {
      const initial: BopfModelRead = await readModel(conn, bo);

      if (input.operation === "remove_node") {
        const target = requireNode(input).node.toLowerCase();
        const isRoot = initial.model.nodes.some((n) => n.name.toLowerCase() === target && n.rootNode);
        if (isRoot) {
          throw new AbapError(
            "BAD_INPUT",
            `remove_node cannot remove "${input.node}" on ${bo}: a business object has exactly one root ` +
              `node, and BOPF will not let a BO lose its root — a remove_node PUT targeting it answers 200 ` +
              `and changes nothing server-side — the same discarded-write shape as an unplaceable node. To ` +
              `delete ${bo} itself, use abap_bopf_delete, not remove_node.`,
            { bo, node: input.node },
          );
        }
      }

      // Runs before putModel takes its lock, so nothing is resolved yet.
      const authorized = deps.safety.authorize(
        "write",
        { name: bo, packageName: initial.model.packageRef?.name, type: BOPF_TYPE },
        { corr: { kind: "unresolved" } },
      );

      const danglingVerdict = await danglingRefPreflight(
        conn,
        input.operation,
        input.spec as Record<string, unknown> | undefined,
        input.allow_dangling_ref === true,
      );

      // Action-ref mitigation, add_validation only — determinations refuse
      // "action" outright in buildTriggerFragments. See actionRefPreflight.
      if (input.operation === "add_validation") {
        actionRefPreflight(
          initial.model,
          requireNode(input).node,
          input.spec as Record<string, unknown> | undefined,
          input.allow_dangling_ref === true,
        );
      }

      if (input.operation === "add_alternative_key") {
        alternativeKeyPreflight(
          initial.model,
          requireNode(input),
          input.spec as Record<string, unknown> | undefined,
          input.allow_dangling_ref === true,
        );
      }

      if (isDelegationOperation(input.operation)) {
        delegationModelPreflight(initial.model, input as DelegationInput);
      }

      let afterMutate: BopfModelRead;
      let entryId: string | undefined;
      // For a mutation, putModel resolves this under its own lock. For
      // "activate" no mutation runs, so it stays unresolved — that path
      // performs no transport resolution of its own (pre-existing).
      let mutationCorr: SafetyCorr = { kind: "unresolved" };
      if (input.operation === "activate") {
        afterMutate = initial;
      } else {
        // `beforeSource` is the post-lock XML putModel hands `mutate`
        // (fresher than `initial`), matching enh.ts's post-lock precedent.
        // `irreversible: true` — same undoBlocker() reasoning as create_bo.
        //
        // `mutate` can fire more than once per call (`withRelockRetry`
        // reruns rebuild -> mutate on retry), but `onBeforeImage` must fire
        // at most once — the `fired` flag enforces that; a retry's before-
        // image is the bytes as they stood at mutation start, not
        // necessarily the literal bytes the eventual PUT was built from
        // (accepted, documented staleness).
        let fired = false;
        const { result: putResult, entryId: id, settle } = await withJournalledMutation(
          deps.journal,
          {
            begin: (xml: string) => ({
              operation: "update" as const,
              object: journalRef({
                name: bo,
                type: BOPF_TYPE,
                uri: bopfUri(bo),
                packageName: initial.model.packageRef?.name ?? "",
              }),
              existedBefore: true,
              beforeCapture: "captured" as const,
              beforeSource: xml,
              irreversible: true,
              systemKey: systemKey(conn.cfg),
              tool: "abap_bopf_edit",
            }),
          },
          (onBeforeImage) =>
            putModel(
              conn,
              session,
              bo,
              async (xml) => {
                if (!fired) {
                  fired = true;
                  await onBeforeImage(xml);
                }
                return mutateModel(xml, input);
              },
              authorized,
            ),
        );
        // The PUT itself was accepted — settle the journal entry as succeeded
        // before checking whether the model actually changed; it did happen,
        // even if the node it was meant to add did not stick.
        await settle({ outcome: "succeeded", afterSource: putResult.xml });
        entryId = id;
        afterMutate = putResult;
        mutationCorr = putResult.corr;

        if (input.operation === "add_node") {
          const name = requireName(input).toLowerCase();
          // Count, not mere presence — an add_node for a name that already
          // existed must not pass just because a same-named node was already
          // in the model before this call.
          const countNamed = (m: BoModel) => m.nodes.filter((n) => n.name.toLowerCase() === name).length;
          const nodeCountBefore = countNamed(initial.model);
          const nodeCountAfter = countNamed(afterMutate.model);
          if (nodeCountAfter <= nodeCountBefore) {
            throw new AbapError(
              "CHECK_FAILED",
              `abap_bopf_edit add_node "${input.name}" on ${bo}: the PUT was accepted (journalEntryId ` +
                `${entryId}) but a fresh re-read shows ${nodeCountAfter} node(s) named "${input.name}" after ` +
                `the write, versus ${nodeCountBefore} before — the node was not actually added. Nodes present ` +
                `after the write: ${afterMutate.model.nodes.map((n) => n.name || "(unnamed)").join(", ") || "none"}. ` +
                `A BOPF PUT answers 200 whether or not the server kept what was sent, and nothing was activated.`,
              { bo, node: input.name, nodeCountBefore, nodeCountAfter, journalEntryId: entryId },
              `Check that spec.parent/spec.parentNodeId names a node that actually exists on ${bo}.`,
            );
          }
        }

        if (input.operation === "remove_node") {
          // Not folded into MEMBER_CHECK_BY_OP/countMembers below: those count
          // a MemberKind array scoped to one node (n) => n.associations etc.
          // remove_node's target is a node itself, counted across the whole
          // model's node list, and is named via input.node, not input.name —
          // a different selector and a different traversal, not just a
          // different MemberKind.
          const name = requireNode(input).node.toLowerCase();
          const countNamed = (m: BoModel) => m.nodes.filter((n) => n.name.toLowerCase() === name).length;
          const nodeCountBefore = countNamed(initial.model);
          const nodeCountAfter = countNamed(afterMutate.model);
          if (nodeCountAfter >= nodeCountBefore) {
            throw new AbapError(
              "CHECK_FAILED",
              `abap_bopf_edit remove_node "${input.node}" on ${bo}: the PUT was accepted (journalEntryId ` +
                `${entryId}) but a fresh re-read shows ${nodeCountAfter} node(s) named "${input.node}" after ` +
                `the write, versus ${nodeCountBefore} before — the node was not actually removed. A BOPF PUT ` +
                `answers 200 whether or not the server kept what was sent, and nothing was activated.`,
              { bo, node: input.node, nodeCountBefore, nodeCountAfter, journalEntryId: entryId },
            );
          }
        }

        const memberCheck = MEMBER_CHECK_BY_OP[input.operation];
        if (memberCheck) {
          const nodeName = requireNode(input).node;
          const member = requireName(input);
          const countBefore = countMembers(initial.model, memberCheck.kind, nodeName, member);
          const countAfter = countMembers(afterMutate.model, memberCheck.kind, nodeName, member);
          const moved = memberCheck.direction === "added" ? countAfter > countBefore : countAfter < countBefore;
          if (!moved) {
            // add_association only: check whether the miss is really a server-side
            // dedup (e.g. add_node's auto-created ROOT→child Composition link)
            // rather than a plain loss, and say so — but still CHECK_FAILED either
            // way, since the association the caller named does not exist.
            let equivalent: BoAssociation | undefined;
            let equivalentTarget: string | undefined;
            if (input.operation === "add_association") {
              const spec = (input.spec ?? {}) as Record<string, unknown>;
              const implementationType = str(spec.implementationType);
              const requestedTarget = resolveTargetNodeName(ref(spec.targetNodeRef));
              if (implementationType && requestedTarget) {
                const targetNode = afterMutate.model.nodes.find((n) => n.name.toLowerCase() === nodeName.toLowerCase());
                equivalent = targetNode && findEquivalentAssociation(targetNode, implementationType, requestedTarget);
                equivalentTarget = requestedTarget;
              }
            }
            if (equivalent) {
              throw new AbapError(
                "CHECK_FAILED",
                `abap_bopf_edit add_association "${member}" on ${bo} node "${nodeName}": the PUT was accepted ` +
                  `(journalEntryId ${entryId}) but a fresh re-read shows the association was not added. An ` +
                  `equivalent association "${equivalent.name}" (implementationType "${equivalent.implementationType}") ` +
                  `to node "${equivalentTarget}" is already present on that node, so BOPF most likely discarded ` +
                  `this one as a duplicate rather than erroring — the link you asked for already exists under ` +
                  `the name "${equivalent.name}", so the model is already correct; nothing was activated.`,
                {
                  bo,
                  node: nodeName,
                  name: member,
                  kind: memberCheck.kind,
                  countBefore,
                  countAfter,
                  journalEntryId: entryId,
                  existingEquivalent: {
                    name: equivalent.name,
                    implementationType: equivalent.implementationType,
                    targetNode: equivalentTarget,
                  },
                },
                `Use the existing association "${equivalent.name}" instead of adding a new one, or pass a different ` +
                  `implementationType/targetNodeRef if a genuinely distinct link is wanted. add_node auto-creates a ` +
                  `ROOT→child Composition association plus TO_PARENT/TO_ROOT on the child, which is the usual way ` +
                  `this collision arises.`,
              );
            }
            throw new AbapError(
              "CHECK_FAILED",
              `abap_bopf_edit ${input.operation} "${member}" on ${bo} node "${nodeName}": the PUT was accepted ` +
                `(journalEntryId ${entryId}) but a fresh re-read shows ${countAfter} ${memberCheck.kind}(s) named ` +
                `"${member}" on that node after the write, versus ${countBefore} before — nothing was ` +
                `${memberCheck.direction}. A BOPF PUT answers 200 whether or not the server kept what was sent, ` +
                `and nothing was activated.`,
              { bo, node: nodeName, name: member, kind: memberCheck.kind, countBefore, countAfter, journalEntryId: entryId },
            );
          }
        }

        if (input.operation === "set_node_flags") {
          const sel = requireNode(input);
          const sentSpec = (input.spec ?? {}) as Record<string, unknown>;
          const renamedTo = typeof sentSpec.name === "string" ? sentSpec.name : undefined;
          // nodeId narrows a duplicate name when it still matches; not a filter, since
          // nothing guarantees the server keeps the id across a rename.
          const locate = (wanted: string): BoNode | undefined => {
            const named = afterMutate.model.nodes.filter((n) => n.name.toLowerCase() === wanted.toLowerCase());
            return (sel.nodeId !== undefined ? named.find((n) => n.nodeId === sel.nodeId) : undefined) ?? named[0];
          };
          const expectedName = renamedTo ?? sel.node;
          const renamed = locate(expectedName);
          // A dropped rename leaves the node under its old name — diff the rest of the spec against it too.
          const node = renamed ?? (renamedTo !== undefined ? locate(sel.node) : undefined);
          if (!node) {
            throw new AbapError(
              "CHECK_FAILED",
              `abap_bopf_edit set_node_flags on ${bo} node "${sel.node}": the PUT was accepted (journalEntryId ` +
                `${entryId}) but a fresh re-read finds no node named "${expectedName}" on the model at all. Nodes ` +
                `present after the write: ${afterMutate.model.nodes.map((n) => n.name || "(unnamed)").join(", ") || "none"}. ` +
                `A BOPF PUT answers 200 whether or not the server kept what was sent, and nothing was activated.`,
              { bo, node: sel.node, expectedName, journalEntryId: entryId },
            );
          }
          const mismatches: FlagMismatch[] = [
            ...(renamed ? [] : [{ field: "name", sent: renamedTo, readBack: node.name }]),
            ...nodeFlagMismatches(node, sentSpec),
          ];
          if (mismatches.length > 0) {
            const detail = mismatches
              .map((m) => `${m.field}: sent ${m.sent === null ? "cleared" : describeFlagValue(m.sent)}, read back ${describeFlagValue(m.readBack)}`)
              .join("; ");
            throw new AbapError(
              "CHECK_FAILED",
              `abap_bopf_edit set_node_flags on ${bo} node "${sel.node}": the PUT was accepted (journalEntryId ` +
                `${entryId}) but a fresh re-read shows the server did not keep ${mismatches.length} of the ` +
                `field(s) sent — ${detail}. A BOPF PUT answers 200 whether or not the server kept what was ` +
                `sent, and nothing was activated.`,
              { bo, node: sel.node, mismatches, journalEntryId: entryId },
              `BOPF's model mapper discards payload it cannot map without erroring — check that a ref names an ` +
                `object that actually exists, then re-send only the fields that did not stick.`,
            );
          }
        }

        if (isDelegationOperation(input.operation)) {
          verifyDelegation(input as DelegationInput, initial.model, afterMutate.model, entryId);
        }
        if (
          input.operation === "set_association_fields" ||
          input.operation === "set_action_fields" ||
          input.operation === "set_determination_fields" ||
          input.operation === "set_validation_fields" ||
          input.operation === "set_query_fields" ||
          input.operation === "set_alternative_key_fields"
        ) {
          const op = input.operation;
          const sel = requireNode(input);
          const name = requireName(input);
          const kind = SET_CHILD_KIND[op];
          const sentSpec = (input.spec ?? {}) as Record<string, unknown>;
          const countBefore = countMembers(initial.model, kind, sel.node, name);
          const countAfter = countMembers(afterMutate.model, kind, sel.node, name);
          if (countAfter === 0 || countAfter !== countBefore) {
            throw new AbapError(
              "CHECK_FAILED",
              `abap_bopf_edit ${op} "${name}" on ${bo} node "${sel.node}": the PUT was accepted (journalEntryId ` +
                `${entryId}) but a fresh re-read shows ${countAfter} ${kind}(s) named "${name}" on that node ` +
                `after the write, versus ${countBefore} before — the element either vanished or was duplicated ` +
                `instead of being patched in place. A BOPF PUT answers 200 whether or not the server kept what ` +
                `was sent, and nothing was activated.`,
              { bo, node: sel.node, name, kind, countBefore, countAfter, journalEntryId: entryId },
            );
          }
          const node = afterMutate.model.nodes.find((n) => n.name.toLowerCase() === sel.node.toLowerCase());
          const member = node && MEMBERS_BY_KIND[kind](node).find((m) => m.name.toLowerCase() === name.toLowerCase());
          if (member) {
            const table: SpecFieldTable = SET_CHILD_FIELD_TABLES[op] ?? {};
            const mismatches = childFieldMismatches(member as unknown as Record<string, unknown>, sentSpec, table);
            if (mismatches.length > 0) {
              const detail = mismatches
                .map((m) => `${m.field}: sent ${m.sent === null ? "cleared" : describeFlagValue(m.sent)}, read back ${describeFlagValue(m.readBack)}`)
                .join("; ");
              throw new AbapError(
                "CHECK_FAILED",
                `abap_bopf_edit ${op} "${name}" on ${bo} node "${sel.node}": the PUT was accepted (journalEntryId ` +
                  `${entryId}) but a fresh re-read shows the server did not keep ${mismatches.length} of the ` +
                  `field(s) sent — ${detail}. A BOPF PUT answers 200 whether or not the server kept what was ` +
                  `sent, and nothing was activated.`,
                { bo, node: sel.node, name, kind, mismatches, journalEntryId: entryId },
                `BOPF's model mapper discards payload it cannot map without erroring — check that a ref names an ` +
                  `object that actually exists, then re-send only the fields that did not stick.`,
              );
            }
          }
        }
      }

      let activation: ActivationOutcomeBopf | undefined;
      if (wantsActivate) {
        deps.safety.assert(
          "activate",
          { name: bo, packageName: afterMutate.model.packageRef?.name, type: BOPF_TYPE },
          { corr: mutationCorr },
        );
        activation = await activateBusinessObject(conn, bo);
      }

      return { model: afterMutate.model, danglingVerdict, activation, entryId };
    }),
  ).catch((e) => {
    throw attributeSessionDeath(e, input);
  });

  const categoryNote = determinationCategoryOmittedNote(input);
  const addNodeNote = input.operation === "add_node" ? addNodeAutoAssignedRefsNote(input, result.model) : undefined;
  return ok(
    buildEditResponse(
      bo,
      result.model,
      result.danglingVerdict,
      result.activation,
      false,
      result.entryId,
      deps.cfg.maxResponseChars,
      [categoryNote, addNodeNote, ...delegationNotes(input as DelegationInput)].filter(
        (n): n is string => n !== undefined,
      ),
    ),
    result.entryId,
  );
}

function registerBopfEditTool(mcp: McpServer, deps: BopfToolDeps): void {
  mcp.registerTool(
    "abap_bopf_edit",
    {
      description: BOPF_EDIT_TOOL_DESCRIPTION,
      inputSchema: bopfEditInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      try {
        return toMcpResult(await runBopfEdit(deps, args));
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// abap_bopf_delete
// ---------------------------------------------------------------------------

/**
 * `candidates` are the `generated` half of `collectDdicCascadeCandidates` —
 * what an armed cascade delete would actually attempt. `spared` are the
 * `referenced` half — author-supplied refs (`persistentStructureRef`/
 * `persistentTableRef`) this preview must NOT list as deletion candidates,
 * since `deleteBusinessObject` never deletes them either.
 * Deliberately does not probe existence (a round trip per candidate a dry
 * run shouldn't spend).
 *
 * `candidates`/`spared` are ALWAYS the full split read off the model,
 * regardless of `cascadeDdic` — a dry run with no `cascade_ddic`
 * used to say nothing at all about the generated DDIC objects an armed
 * delete would not touch, which reads as "nothing to report" rather than
 * "not checked". When `cascadeDdic` is false, `candidates` is instead
 * rendered under DDIC NOT SWEPT, so the caller sees exactly what an armed
 * delete without `cascade_ddic` would not delete — names read off the
 * model, not existence on the server (relatedly, an
 * unactivated BO's combined table/structure names are reserved in the
 * model before DDIC ever materializes them, so a listed name is not
 * necessarily an object that exists).
 *
 * The header is mode-appropriate, not just mode-flagged: `ddicCandidateCount`/
 * `ddicSparedCount` only mean "would be deleted" / "would be spared by a
 * cascade" — printing them next to `cascadeDdic: false` invites the exact
 * misreading described above ("3 will be deleted") even though nothing
 * here is a deletion candidate in that mode. So `cascadeDdic: false` swaps
 * them for the one count that means something there: `ddicWouldRemainCount`,
 * the size of the DDIC NOT SWEPT list.
 *
 * `requested` is the `cascade_persistent` preview, if any — unlike
 * `candidates`/`spared`, these ARE existence-probed here, because the same
 * probe is what establishes the package a delete of them would be
 * authorized under; a preview that hid that refusal would be worse than
 * the round trip it costs. Rendered under DDIC DELETED ON REQUEST.
 */
function buildDryRunDeleteResponse(
  bo: string,
  candidates: readonly DdicCandidate[],
  spared: readonly DdicCandidate[],
  cascadeDdic: boolean,
  maxChars: number,
  requested: readonly RequestedDdicTarget[] = [],
): string {
  // Requested names are deleted (see DDIC DELETED ON REQUEST below), so they
  // must not also render as spared — a name can't be both.
  const requestedNames = new Set(requested.map((t) => t.candidate.name.trim().toUpperCase()));
  const unrequestedSpared = spared.filter((c) => !requestedNames.has(c.name.trim().toUpperCase()));
  const notes = [
    "dry_run: true (default) — NOTHING was deleted. Pass dry_run: false and confirm (echoing the BO name " +
      "exactly) to actually delete.",
  ];
  if (cascadeDdic) {
    notes.push(
      "cascade_ddic: true — the DDIC candidates below were found referenced in the model; their existence on " +
        "the server was NOT probed here (that costs a network round trip per candidate in a real delete). The " +
        "armed delete may find fewer, or report some as already absent.",
    );
  }
  if (cascadeDdic && unrequestedSpared.length) {
    notes.push(
      "The objects spared below can be deleted too: name them in cascade_persistent on the armed delete. Each " +
        "name must be one this BO actually references (i.e. a name spared below), and must live in this BO's " +
        "own package — e.g. a /BOBF/* demo structure referenced by the BO is refused, not deleted.",
    );
  }
  if (!cascadeDdic && candidates.length) {
    notes.push(
      "cascade_ddic was not requested — the generated DDIC objects listed under DDIC NOT SWEPT are names read " +
        "from the model; their existence on the server was NOT probed here (same as the cascade_ddic: true case " +
        "above). This delete will not touch them. Pass cascade_ddic: true (and confirm_cascade) on the armed " +
        "delete to remove whichever of them actually exist.",
    );
  }
  const body = candidates.map((c) => `${c.kind}  ${c.name}  ${c.uri}`).join("\n");
  const sparedContent = unrequestedSpared
    .map((c) => `${c.kind}  ${c.name}  ${c.uri}  (${ddicSparedReason(c.refSite)})`)
    .join("\n");
  const requestedContent = requested
    .map(
      (t) =>
        `${t.candidate.kind}  ${t.candidate.name}  ${t.candidate.uri}  existed=${t.present}  ` +
        (t.present ? "would delete" : "already absent — nothing to delete"),
    )
    .join("\n");
  const sections: Array<{ title: string; content: string }> = [];
  if (cascadeDdic && unrequestedSpared.length) {
    sections.push({ title: "DDIC SPARED (provenance unknown — never deleted)", content: sparedContent });
  }
  if (!cascadeDdic && candidates.length) {
    sections.push({ title: "DDIC NOT SWEPT (cascade_ddic not requested — would not be deleted)", content: body });
  }
  if (requested.length) {
    sections.push({ title: "DDIC DELETED ON REQUEST", content: requestedContent });
  }
  return buildResponse({
    header: {
      bo,
      dryRun: true,
      wouldDeleteBo: true,
      cascadeDdic,
      ddicCandidateCount: cascadeDdic ? candidates.length : undefined,
      ddicSparedCount: cascadeDdic ? unrequestedSpared.length : undefined,
      ddicWouldRemainCount: cascadeDdic ? undefined : candidates.length,
      ddicRequestedCount: requested.length || undefined,
    },
    body: cascadeDdic && candidates.length ? body : undefined,
    bodyLabel: cascadeDdic && candidates.length ? "DDIC CANDIDATES (not existence-checked)" : undefined,
    sections,
    notes,
    maxChars,
  }).text;
}

/**
 * `leftBehind` is the `generated` half of `collectDdicCascadeCandidates` on
 * the model read just before this delete — always passed in, but only
 * rendered when `cascadeDdic` is false. `ddicCount: 0` when
 * `cascade_ddic` was never requested used to read identically to "cascade
 * ran, found nothing to sweep" — the header now always states `cascadeDdic`
 * plainly, and `leftBehind` lets a no-cascade delete name exactly which
 * generated DDIC objects (e.g. the auto-generated constants interface) this
 * delete did not touch, instead of a bare `ddicCount: 0` that looks like a
 * clean sweep.
 *
 * These are names read from the model, not a read-back — existence on the
 * server is NOT probed on this path. Relatedly, BOPF reserves
 * the combined table/structure names in the model at create time but only
 * materializes those DDIC objects on activation, while the constants
 * interface is generated unconditionally at create time — so on a BO that
 * was never activated, a name listed here is not necessarily an object
 * that exists.
 *
 * `deleteBusinessObject` only ever populates `result.ddic`/`result.ddicSpared`
 * when `cascadeDdic` is true (see `src/adt/bopf.ts`), so `ddicCount`/
 * `ddicDeletedCount`/`ddicUnverifiedCount`/`ddicSparedCount` are trivially 0
 * on every no-cascade delete — same header-noise-around-the-one-number-that-
 * matters concern as the dry-run header above. So this header applies the
 * same mode split: `cascadeDdic: true` keeps the four DDIC-result counts and
 * drops `ddicLeftBehindCount` (which is itself always 0 in that mode, since
 * `leftBehind` is only ever populated when `cascadeDdic` is false);
 * `cascadeDdic: false` drops the four always-zero counts and keeps only
 * `ddicLeftBehindCount`, the one number that means something there.
 *
 * `spared` is the `referenced` half of the same no-cascade
 * `collectDdicCascadeCandidates` call that produces `leftBehind` — always
 * `[]` when `cascadeDdic` is true, since in that mode `result.ddicSpared`
 * already covers it. Rendered as its own DDIC SPARED section, same title
 * and `ddicSparedReason` wording as the cascade-true section above, so an
 * armed no-cascade delete, a dry run, and a cascade result all describe a
 * spared persistentTableRef/persistentStructureRef the same way. No new
 * header count: `ddicSparedCount` already means "spared by a cascade" in
 * this response, and this section fires precisely when that field is
 * `undefined` — a second count with the same name but the opposite mode
 * would be the kind of misreading described above.
 *
 * Separately, `result.ddicEnumerated` (set in `src/adt/bopf.ts`,
 * already `false` whenever `cascadeDdic` was requested but the internal
 * `readModel` threw after the BO delete ran) used to be read nowhere in this
 * function — a failed enumeration and a cascade that genuinely found nothing
 * both rendered `ddicCount: 0` etc. with no other signal, byte-identical.
 * Now `cascadeDdic: true` always states `ddicEnumerated` in the header
 * (omitted, not `false`, when `cascadeDdic` itself is false — that path has
 * its own `ddicLeftBehindCount`), and the four DDIC-result counts render
 * only when the walk actually ran (`cascadeDdic && result.ddicEnumerated`);
 * a failed enumeration drops them (same "don't print a count for a
 * measurement that never happened" idiom as the rest of this comment) and
 * adds a NOTE instead of a silent `0`.
 *
 * `result.ddicRequested` (the `cascade_persistent` opt-in) is reported in
 * its own DDIC DELETED ON REQUEST section regardless of `cascadeDdic`'s
 * mode split above — these are always-set, name-by-name deletion attempts,
 * never folded into `ddic`/`ddicSpared`/`leftBehind`.
 */
function buildDeleteResultResponse(
  bo: string,
  result: DeleteBusinessObjectResult,
  cascadeDdic: boolean,
  leftBehind: readonly DdicCandidate[],
  spared: readonly DdicCandidate[],
  journalEntryId: string | undefined,
  maxChars: number,
): string {
  const deletedCount = result.ddic.filter((d) => d.deleted === true).length;
  const unverifiedCount = result.ddic.filter((d) => d.deleted === "unverified").length;
  const body = result.ddic
    .map((d) => `${d.kind}  ${d.name}  existed=${d.existed}  deleted=${d.deleted}${d.reason ? `  reason=${d.reason}` : ""}`)
    .join("\n");
  // Requested names are reported under DDIC DELETED ON REQUEST below, so they
  // must not also render as spared — a name can't be both.
  const requestedNames = new Set(result.ddicRequested.map((d) => d.name.trim().toUpperCase()));
  const unrequestedDdicSpared = result.ddicSpared.filter((d) => !requestedNames.has(d.name.trim().toUpperCase()));
  const unrequestedSpared = spared.filter((c) => !requestedNames.has(c.name.trim().toUpperCase()));
  const sparedContent = unrequestedDdicSpared.map((d) => `${d.kind}  ${d.name}  ${d.reason}`).join("\n");
  const leftBehindContent = leftBehind.map((c) => `${c.kind}  ${c.name}  ${c.uri}`).join("\n");
  const notCascadedSparedContent = unrequestedSpared
    .map((c) => `${c.kind}  ${c.name}  ${c.uri}  (${ddicSparedReason(c.refSite)})`)
    .join("\n");
  const requestedDeletedCount = result.ddicRequested.filter((d) => d.deleted === true).length;
  const requestedUnverifiedCount = result.ddicRequested.filter((d) => d.deleted === "unverified").length;
  const requestedContent = result.ddicRequested
    .map((d) => `${d.kind}  ${d.name}  existed=${d.existed}  deleted=${d.deleted}${d.reason ? `  reason=${d.reason}` : ""}`)
    .join("\n");

  const sections: Array<{ title: string; content: string }> = [];
  // result.ddicSpared is only ever populated when cascadeDdic is true; spared
  // (the no-cascade referenced half) is only ever populated when cascadeDdic
  // is false — mutually exclusive, so at most one DDIC SPARED section renders.
  if (unrequestedDdicSpared.length) {
    sections.push({ title: "DDIC SPARED (provenance unknown — never deleted)", content: sparedContent });
  } else if (!cascadeDdic && unrequestedSpared.length) {
    sections.push({ title: "DDIC SPARED (provenance unknown — never deleted)", content: notCascadedSparedContent });
  }
  if (!cascadeDdic && leftBehind.length) {
    sections.push({
      title: "DDIC LEFT BEHIND (cascade_ddic was not requested — these generated objects were not deleted)",
      content: leftBehindContent,
    });
  }
  if (result.ddicRequested.length) {
    sections.push({ title: "DDIC DELETED ON REQUEST", content: requestedContent });
  }

  const notes: string[] = [];
  if (unrequestedDdicSpared.length) {
    notes.push(
      "The objects spared below went untouched because cascade_persistent did not name them on this delete " +
        "— naming them there would have deleted them as part of this same cascade. The BO is gone now; remove " +
        "them yourself with abap_write if that's actually wanted.",
    );
  }
  if (!cascadeDdic && unrequestedSpared.length) {
    notes.push(
      "persistentTableRef/persistentStructureRef objects (DDIC SPARED) are never touched by cascade_ddic " +
        "either — the model does not record whether this BO generated them, so they stay untouched whether " +
        "or not cascade_ddic was requested. Passing cascade_ddic: true, confirm_cascade, and cascade_persistent " +
        "naming them on this delete would have deleted them instead; the BO is gone now, so remove them " +
        "yourself with abap_write if that's actually wanted.",
    );
  }
  if (!cascadeDdic && leftBehind.length) {
    notes.push(
      "cascade_ddic was not requested — the generated DDIC objects listed under DDIC LEFT BEHIND were never " +
        "touched by this delete. These are names read from the BO's model, not a read-back — existence on the " +
        "server was NOT probed. BOPF reserves the combined table/structure names at create time but only " +
        "materializes those DDIC objects when the BO is activated, so on a BO that was never activated the " +
        "constants interface typically exists and the combined table/structure typically do not. Re-run with " +
        "cascade_ddic: true (and confirm_cascade) to remove whatever does exist, or delete each one individually " +
        "with abap_write.",
    );
  }
  if (unverifiedCount > 0) {
    notes.push(
      `${unverifiedCount} DDIC delete${unverifiedCount === 1 ? "" : "s"} could not be verified by a read-back ` +
        "(see reason= in DDIC CASCADE RESULTS). This is not proof the delete failed — a stale read " +
        "is possible — it means the tool could not confirm the object is actually gone.",
    );
  }
  if (requestedUnverifiedCount > 0) {
    notes.push(
      `${requestedUnverifiedCount} DDIC delete${requestedUnverifiedCount === 1 ? "" : "s"} named by ` +
        "cascade_persistent could not be verified by a read-back (see reason= in DDIC DELETED ON REQUEST). " +
        "This is not proof the delete failed — a stale read is possible — it means the tool could not confirm " +
        "the object is actually gone.",
    );
  }
  if (result.ddicRequested.length) {
    notes.push(
      "DDIC DELETED ON REQUEST objects were deleted because cascade_persistent named them by name — the " +
        "provenance-unknown default (persistentTableRef/persistentStructureRef otherwise spared) is unchanged " +
        "for every object not named there.",
    );
  }
  if (cascadeDdic && !result.ddicEnumerated) {
    notes.push(
      "cascade_ddic was requested but the model could not be re-read to enumerate DDIC candidates (readModel " +
        "threw after the BO delete already ran) — the cascade never happened. The empty/zero DDIC counts above " +
        "are NOT evidence of a clean sweep: this BO's generated companions (its combined table, structure, and " +
        "the constants interface) may still be present on the system, unchecked and undeleted. Re-run this " +
        "delete's dry run (dry_run: true, cascade_ddic: true) once the read succeeds to see what is actually " +
        "there, or find and remove them by hand with abap_bopf (read) / abap_write.",
    );
  }

  return buildResponse({
    header: {
      bo,
      boDeleted: result.boDeleted,
      cascadeDdic,
      ddicEnumerated: cascadeDdic ? result.ddicEnumerated : undefined,
      ddicCount: cascadeDdic && result.ddicEnumerated ? result.ddic.length : undefined,
      ddicDeletedCount: cascadeDdic && result.ddicEnumerated ? deletedCount : undefined,
      ddicUnverifiedCount: cascadeDdic && result.ddicEnumerated ? unverifiedCount : undefined,
      ddicSparedCount: cascadeDdic && result.ddicEnumerated ? unrequestedDdicSpared.length : undefined,
      ddicLeftBehindCount: cascadeDdic ? undefined : leftBehind.length,
      ddicRequestedCount: result.ddicRequested.length || undefined,
      ddicRequestedDeletedCount: result.ddicRequested.length ? requestedDeletedCount : undefined,
      journalEntryId,
    },
    body: result.ddic.length ? body : undefined,
    bodyLabel: result.ddic.length ? "DDIC CASCADE RESULTS" : undefined,
    sections,
    notes,
    maxChars,
  }).text;
}

/**
 * Refuses the WHOLE call up front if any requested target can't pass the
 * gate (e.g. a reserved SAP namespace) — same cascade-ceiling reasoning as
 * `deleteBusinessObject`'s own `allowCascadeDelete` check: a caller who
 * asked for a cascading delete and silently got a smaller one instead
 * would be misled about what actually happened. Skips absent targets.
 */
function assertRequestedTargetsGate(safety: SafetyGate, targets: readonly RequestedDdicTarget[]): void {
  for (const t of targets) {
    if (!t.present) continue;
    safety.assert(
      "delete",
      { name: t.candidate.name, packageName: t.packageName, type: t.candidate.type },
      { phase: "preflight" },
    );
  }
}

const BOPF_DELETE_TOOL_DESCRIPTION =
  "Delete a BOPF business object. dry_run defaults to true. dry_run: false plus confirm (echo bo) deletes. " +
  "cascade_ddic: true also sweeps generated DDIC objects (needs confirm_cascade too). cascade_persistent " +
  "names specific persistentTableRef/persistentStructureRef objects to delete too (requires cascade_ddic). " +
  "Refuses on a transportable package.";

export async function runBopfDelete(deps: BopfRunDeps, args: unknown): Promise<BopfCallResult> {
  const input = args as BopfDeleteInput;
  const bo = input.bo;
  const dryRun = input.dry_run !== false;
  const gateKey = bopfGateKey(bo);
  // Empty/all-blank means "not requested" — a caller passing [] or [""] gets
  // the unchanged default (persistentTableRef/persistentStructureRef spared).
  const requestedPersistent = (input.cascade_persistent ?? []).map((n) => n.trim()).filter((n) => n !== "");

  // Pure, before any request. `confirm_cascade` is already required below
  // whenever cascade_ddic is true, so no separate confirmation is needed here.
  if (requestedPersistent.length && !input.cascade_ddic) {
    throw new AbapError(
      "BAD_INPUT",
      "abap_bopf_delete: cascade_persistent requires cascade_ddic: true — it extends the DDIC cascade " +
        "rather than replacing it.",
      { bo },
    );
  }

  deps.safety.assert("delete", { name: bo, type: BOPF_TYPE }, { phase: "preflight" });

  if (!dryRun) {
    const target = bo.trim().toUpperCase();
    if (!input.confirm || input.confirm.trim().toUpperCase() !== target) {
      throw new AbapError(
        "BAD_INPUT",
        `abap_bopf_delete: confirm must echo the BO name exactly ("${bo}") to actually delete. Omit ` +
          "dry_run or set it true to preview without deleting.",
        { bo },
      );
    }
    if (input.cascade_ddic) {
      if (!input.confirm_cascade || input.confirm_cascade.trim().toUpperCase() !== target) {
        throw new AbapError(
          "BAD_INPUT",
          `abap_bopf_delete: cascade_ddic: true also requires confirm_cascade to echo the BO name ` +
            `exactly ("${bo}") — this additionally deletes DDIC objects the BO delete itself does not.`,
          { bo },
        );
      }
    }
  }

  await deps.ensureConnected();

  if (dryRun) {
    const { model, requestedTargets } = await deps.pool.withRead("abap_bopf_delete", async (conn) => {
      const model = (await readModel(conn, bo)).model;
      // The auto-enumerated candidates above are deliberately not
      // existence-probed on a dry run (a round trip each); explicitly named
      // ones are, because the same probe is what establishes the package —
      // a preview that hid a refusal the armed call would hit would be
      // worse than the round trip.
      const requestedTargets = requestedPersistent.length
        ? await probeRequestedPersistentTargets(
            conn,
            bo,
            model.packageRef?.name,
            resolvePersistentCascadeRequest(bo, model, requestedPersistent),
          )
        : [];
      assertRequestedTargetsGate(deps.safety, requestedTargets);
      return { model, requestedTargets };
    });
    // Always collected, regardless of cascade_ddic — see
    // buildDryRunDeleteResponse's doc comment for why a no-cascade dry run
    // must still name what an armed delete would not touch.
    const { generated, referenced } = collectDdicCascadeCandidates(model);
    return ok(
      buildDryRunDeleteResponse(
        bo,
        generated,
        referenced,
        input.cascade_ddic === true,
        deps.cfg.maxResponseChars,
        requestedTargets,
      ),
    );
  }

  // Must re-resolve the BO's actual package for the gate — omitting
  // packageName here previously hit safety.ts's "" fallback and
  // unconditionally denied every real delete ("Package (unknown) is not in
  // the allowlist"), confirmed live. See archive for the incident.
  const currentModelRead = await deps.pool.withRead("abap_bopf_delete", async (conn) => {
    const read = await readModel(conn, bo);
    // Same resolve+probe as the dry-run path, but here every refusal it can
    // throw (unreferenced name, ambiguous ref slot, wrong package) fires
    // before safety.authorize, before the write session, and before the
    // journal entry is begun.
    const requestedTargets = requestedPersistent.length
      ? await probeRequestedPersistentTargets(
          conn,
          bo,
          read.model.packageRef?.name,
          resolvePersistentCascadeRequest(bo, read.model, requestedPersistent),
        )
      : [];
    assertRequestedTargetsGate(deps.safety, requestedTargets);
    return { ...read, requestedTargets };
  });
  const currentModel = currentModelRead.model;
  const requestedTargets = currentModelRead.requestedTargets;
  // adt/bopf.ts refuses every transportable target before delete reaches the
  // wire, so no transport can be involved — `{kind:"unresolved"}` keeps this
  // from fabricating an "auto" transport to judge.
  const authorized = deps.safety.authorize(
    "delete",
    {
      name: bo,
      packageName: currentModel.packageRef?.name,
      type: BOPF_TYPE,
    },
    { corr: { kind: "unresolved" } },
  );
  const result = await deps.pool.withWrite("abap_bopf_delete", gateKey, (conn) =>
    conn.withStatefulSession(async (session) => {
      // `deleteBusinessObject` doesn't reread under its own lock, so
      // `currentModelRead` above (taken moments earlier) is the freshest
      // capture point — an accepted, documented staleness, not a silent gap.
      // `existedBefore: true` because the read above only got here by
      // succeeding. `irreversible: true` — same undoBlocker() reasoning as
      // create_bo/update. No retry loop here, so no `fired` guard needed.
      const { result: delResult, entryId, settle } = await withJournalledMutation(
        deps.journal,
        {
          begin: () => ({
            operation: "delete" as const,
            object: journalRef({
              name: bo,
              type: BOPF_TYPE,
              uri: bopfUri(bo),
              packageName: currentModel.packageRef?.name ?? "",
            }),
            existedBefore: true,
            beforeCapture: "captured" as const,
            beforeSource: currentModelRead.xml,
            irreversible: true,
            systemKey: systemKey(conn.cfg),
            tool: "abap_bopf_delete",
            // Only present when at least one target was requested —
            // `JournalEntry.parts` must be absent, not `[]`, on an
            // entry that only ever touched one object. The before-image
            // here is the package probe's own response, captured before
            // the delete; `confirmed-absent` is honest because a 404 on
            // that probe is a positive absence answer, not a guess.
            ...(requestedTargets.length
              ? {
                  parts: requestedTargets.map((t) => ({
                    object: journalRef({
                      name: t.candidate.name,
                      type: t.candidate.type,
                      uri: t.candidate.uri,
                      packageName: t.packageName ?? "",
                    }),
                    existedBefore: t.present,
                    beforeCapture: t.present ? ("captured" as const) : ("confirmed-absent" as const),
                    ...(t.beforeSource !== undefined ? { beforeSource: t.beforeSource } : {}),
                  })),
                }
              : {}),
          }),
        },
        async (onBeforeImage) => {
          await onBeforeImage(undefined);
          // `deps.safety` is threaded through — DDIC cascade candidates are
          // only discovered inside deleteBusinessObject, which authorizes
          // each one individually before its own DELETE.
          return deleteBusinessObject(conn, session, bo, authorized, deps.safety, {
            cascadeDdic: input.cascade_ddic,
            cascadePersistent: requestedTargets,
          });
        },
      );
      await settle({ outcome: "succeeded" });
      return { ...delResult, entryId };
    }),
  );
  // Reuses `currentModel` (already read above for the gate's packageName) —
  // no extra round trip. Both halves are only meaningful when cascade_ddic
  // was NOT requested; buildDeleteResultResponse only renders them in that
  // case, same as the dry-run path above.
  const { generated: leftBehind, referenced: notCascadedSpared } = input.cascade_ddic
    ? { generated: [] as readonly DdicCandidate[], referenced: [] as readonly DdicCandidate[] }
    : collectDdicCascadeCandidates(currentModel);
  return ok(
    buildDeleteResultResponse(
      bo,
      result,
      input.cascade_ddic === true,
      leftBehind,
      notCascadedSpared,
      result.entryId,
      deps.cfg.maxResponseChars,
    ),
    result.entryId,
  );
}

function registerBopfDeleteTool(mcp: McpServer, deps: BopfToolDeps): void {
  mcp.registerTool(
    "abap_bopf_delete",
    {
      description: BOPF_DELETE_TOOL_DESCRIPTION,
      inputSchema: bopfDeleteInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (args) => {
      try {
        return toMcpResult(await runBopfDelete(deps, args));
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
