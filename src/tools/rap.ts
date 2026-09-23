/**
 * `abap_rap` (issue #197): generates a full RAP stack (root/projection CDS
 * views, root/projection behavior definitions, a behavior implementation
 * class, a service definition and a service binding, plus an optional draft
 * table) from an existing ABAP table, and writes every artifact through the
 * same core `abapWrite` uses.
 *
 * Every artifact name is derivable from `name_prefix` (or `names` overrides)
 * with zero network access (`deriveRapNames`, `src/adt/rap-generate.ts`), so
 * the safety gate runs once per artifact BEFORE `ensureConnected()` — a
 * refused call, `dry_run` or not, costs zero requests, same rule as
 * `abap_write`.
 *
 * A real run writes artifacts strictly in dependency order and stops at the
 * first failure: already-written artifacts stay written (nothing is rolled
 * back), and the thrown `RAP_PARTIAL` error's `details.artifacts` reports
 * exactly which ones, so a retry only needs to fix the cause and call again.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AbapConnection } from "../adt/connection.js";
import { AbapError } from "../adt/errors.js";
import type { SessionPool } from "../adt/pool.js";
import type { SessionTransport } from "../adt/session-transport.js";
import type { Config } from "../config.js";
import type { Journal } from "../journal.js";
import type { SafetyGate } from "../safety.js";
import { buildResponse, type BuiltResponse } from "../compact.js";
import { preflight } from "./preflight.js";
import { abapWrite, type WriteInput } from "./write.js";
import { resolveObject } from "../adt/resolve.js";
import { readSource } from "../adt/source.js";
import { parseDdl, type DdlField } from "../adt/ddic.js";
import { readServiceBinding } from "../adt/odata.js";
import {
  deriveRapNames,
  generateRapStack,
  renderRapSummary,
  type RapArtifact,
  type RapNameOverrides,
  type RapSpec,
  type RapStack,
} from "../adt/rap-generate.js";

// ------------------------------------------------------------------ schema ---

const rapNamesSchema = z
  .object({
    root_view: z.string().optional().describe("Override the derived root CDS view name."),
    projection_view: z.string().optional().describe("Override the derived projection CDS view name."),
    behaviour_class: z.string().optional().describe("Override the derived behavior implementation class name."),
    service_definition: z.string().optional().describe("Override the derived service definition name."),
    service_binding: z.string().optional().describe("Override the derived service binding name (bypasses the 26-char check)."),
    draft_table: z.string().optional().describe("Override the derived draft table name (bypasses the 16-char check)."),
    root_sql_view: z.string().optional().describe("Override the classic form root view's @AbapCatalog.sqlViewName."),
    projection_sql_view: z.string().optional().describe("Override the classic form projection view's @AbapCatalog.sqlViewName."),
  })
  .strict()
  .optional()
  .describe("Overrides for individually derived names; every field is optional.");

export const rapInputSchema = {
  table: z.string().describe("Existing DDIC table (TABL/DT) to generate the RAP stack from."),
  package: z.string().describe("Package for every generated artifact."),
  name_prefix: z
    .string()
    .optional()
    .describe(
      "Customer-namespace prefix (Z/Y or /NS/) every derived name is built from, e.g. \"ZAS_BK197\". " +
        "Required unless `names` supplies every derived name explicitly.",
    ),
  names: rapNamesSchema,
  flavour: z
    .enum(["managed", "unmanaged"])
    .optional()
    .describe("RAP implementation type for the root behavior definition. Default managed."),
  draft: z.boolean().optional().describe("Generate a draft table and draft-enable the root behavior definition. Default false."),
  service_binding_type: z
    .enum(["OData V2", "OData V4"])
    .optional()
    .describe("OData protocol version for the service binding. Default OData V4."),
  include_projection: z
    .boolean()
    .optional()
    .describe("Generate the projection CDS view and its behavior definition. Default true."),
  cds_form: z
    .enum(["entity", "classic"])
    .optional()
    .describe("CDS view syntax: entity (define ... view entity) or classic (define view, @AbapCatalog.sqlViewName). Default entity."),
  dry_run: z.boolean().optional().describe("Preview every artifact's derived name and source; writes nothing. Default false."),
  corr_nr: z.string().optional().describe("Transport request for every artifact. Omitted: resolved per abap_write's own rules."),
  activate: z.boolean().optional().describe("Activate each artifact after writing it. Default true."),
};

export const RapInput = z.object(rapInputSchema);
export type RapInput = z.infer<typeof RapInput>;

const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(RapInput.shape));

function rejectUnknownArgs(args: Record<string, unknown>): void {
  const unknown = Object.keys(args).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length === 0) return;
  throw new AbapError(
    "BAD_INPUT",
    `abap_rap does not take ${unknown.map((k) => `\`${k}\``).join(", ")}.`,
    { unknown, known: [...KNOWN_KEYS] },
    `Parameters are: ${[...KNOWN_KEYS].join(", ")}.`,
  );
}

function bindingType(input: Pick<RapInput, "service_binding_type">): "V2" | "V4" {
  return input.service_binding_type === "OData V2" ? "V2" : "V4";
}

function overridesOf(input: Pick<RapInput, "names">): RapNameOverrides | undefined {
  return input.names as RapNameOverrides | undefined;
}

/** Zero-network: everything an artifact's preflight/gate check needs, derived from raw args alone. */
function deriveArtifactTargets(input: RapInput): Array<{ name: string; type: string; include?: string }> {
  const names = deriveRapNames(input.name_prefix, { names: overridesOf(input), bindingType: bindingType(input) });
  const includeProjection = input.include_projection ?? true;
  const draft = input.draft ?? false;
  const targets: Array<{ name: string; type: string; include?: string }> = [];
  if (draft) targets.push({ name: names.draftTable, type: "TABL/DT" });
  targets.push({ name: names.rootView, type: "DDLS/DF" });
  targets.push({ name: names.rootView, type: "BDEF/BDO" });
  if (includeProjection) {
    targets.push({ name: names.projectionView, type: "DDLS/DF" });
    targets.push({ name: names.projectionView, type: "BDEF/BDO" });
  }
  targets.push({ name: names.behaviourClass, type: "CLAS/OC" });
  targets.push({ name: names.behaviourClass, type: "CLAS/OC", include: "implementations" });
  targets.push({ name: names.serviceDefinition, type: "SRVD/SRV" });
  targets.push({ name: names.serviceBinding, type: "SRVB/SVB" });
  return targets;
}

// -------------------------------------------------------------------- I/O ---

export interface RapIo {
  readTableFields(conn: AbapConnection, table: string): Promise<{ name: string; packageName?: string; fields: DdlField[] }>;
  writeArtifact(conn: AbapConnection, input: WriteInput): Promise<BuiltResponse>;
  readBindingUrl?(conn: AbapConnection, bindingName: string): Promise<string | undefined>;
}

export interface RapToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars" | "verifyWrites">;
  readonly journal: Journal;
  readonly transport: SessionTransport;
}

export function defaultRapIo(deps: RapToolDeps): RapIo {
  return {
    async readTableFields(conn, table) {
      const obj = await resolveObject(conn, table, { type: "TABL/DT", trustHint: true });
      const { source } = await readSource(conn, obj);
      const parsed = parseDdl(source);
      if (parsed.fields.length === 0) {
        throw new AbapError(
          "BAD_INPUT",
          `${table} has no fields abap_rap could parse from its DDL source.`,
          { table },
          "Confirm the table exists, is a database table (TABL/DT), and has at least one field.",
        );
      }
      return { name: obj.name, packageName: obj.packageName, fields: parsed.fields };
    },
    async writeArtifact(conn, input) {
      return abapWrite(conn, input, deps.cfg.maxResponseChars, deps.safety, deps.journal, deps.transport, deps.cfg.verifyWrites, "abap_rap");
    },
    async readBindingUrl(conn, bindingName) {
      try {
        const info = await readServiceBinding(conn, bindingName);
        return info.catalogueUrl;
      } catch {
        return undefined;
      }
    },
  };
}

// -------------------------------------------------------------------- core ---

interface ArtifactStatus {
  key: string;
  name: string;
  type: string;
  written: boolean;
  activated?: boolean;
  failed?: boolean;
  error?: string;
  status?: string;
}

function parseHeaderBool(text: string, key: string): boolean | undefined {
  const m = new RegExp(`^${key}:\\s*(\\S+)`, "mi").exec(text);
  if (!m) return undefined;
  return m[1]!.trim().toLowerCase() === "true";
}

function toWriteInput(spec: RapSpec, art: RapArtifact, input: RapInput): WriteInput {
  return {
    object: art.name,
    type: art.type,
    source: art.source,
    package: spec.package,
    description: art.description,
    ...(art.include ? { include: art.include } : {}),
    ...(input.corr_nr !== undefined ? { corr_nr: input.corr_nr } : {}),
    activate: input.activate ?? true,
  } as WriteInput;
}

function buildSpec(input: RapInput, table: { name: string; fields: DdlField[] }): RapSpec {
  const bt = bindingType(input);
  const names = deriveRapNames(input.name_prefix, { names: overridesOf(input), bindingType: bt });
  return {
    table: table.name,
    package: input.package,
    names,
    alias: names.alias,
    fields: table.fields,
    flavour: input.flavour ?? "managed",
    draft: input.draft ?? false,
    bindingType: bt,
    includeProjection: input.include_projection ?? true,
    cdsForm: input.cds_form ?? "entity",
  };
}

function dryRunResponse(spec: RapSpec, stack: RapStack, maxChars: number): BuiltResponse {
  const sections = stack.artifacts.map((a) => ({
    title: `${a.type} ${a.name}${a.include ? ` (${a.include})` : ""}`,
    content: a.source,
  }));
  return buildResponse({
    header: {
      tool: "abap_rap",
      table: spec.table,
      package: spec.package,
      flavour: spec.flavour,
      draft: spec.draft,
      cds_form: spec.cdsForm,
      binding_type: spec.bindingType,
      writes: 0,
    },
    sections,
    body: renderRapSummary(stack.summary),
    bodyLabel: "FIELD COVERAGE",
    notes: ["DRY RUN — nothing was written. Call again with dry_run: false to generate the stack."],
    maxChars,
  });
}

/**
 * Writes every artifact in `stack.artifacts` order, stopping at the first
 * failure. On success, returns the success response (with the service
 * binding URL, when `io.readBindingUrl` resolves one). On failure, throws
 * `AbapError("RAP_PARTIAL", ...)` with a full-length `details.artifacts`.
 */
export async function abapRap(
  conn: AbapConnection,
  input: RapInput,
  deps: { maxChars: number },
  io: RapIo,
): Promise<BuiltResponse> {
  const table = await io.readTableFields(conn, input.table);
  const spec = buildSpec(input, table);
  const stack = generateRapStack(spec);

  if (input.dry_run) {
    return dryRunResponse(spec, stack, deps.maxChars);
  }

  const statuses: ArtifactStatus[] = stack.artifacts.map((a) => ({
    key: a.key,
    name: a.name,
    type: a.type,
    written: false,
    status: "not attempted",
  }));

  let bindingUrl: string | undefined;

  for (let i = 0; i < stack.artifacts.length; i++) {
    const art = stack.artifacts[i]!;
    try {
      const res = await io.writeArtifact(conn, toWriteInput(spec, art, input));
      const activated = parseHeaderBool(res.text, "activated") ?? false;
      statuses[i] = { key: art.key, name: art.name, type: art.type, written: true, activated };
      if (art.key === "service_binding" && io.readBindingUrl) {
        bindingUrl = await io.readBindingUrl(conn, art.name);
      }
    } catch (e) {
      statuses[i] = {
        key: art.key,
        name: art.name,
        type: art.type,
        written: false,
        failed: true,
        error: (e as Error).message ?? String(e),
      };
      throw new AbapError(
        "RAP_PARTIAL",
        `abap_rap stopped after ${art.type} ${art.name} failed to write; ${i} of ` +
          `${stack.artifacts.length} artifacts were already written and stay written.`,
        { table: spec.table, package: spec.package, artifacts: statuses, journal_tool: "abap_rap" },
        "Fix the underlying failure (shown in this error), then call abap_rap again with the " +
          "same arguments — already-written artifacts are simply rewritten in place.",
      );
    }
  }

  const artifactLines = stack.artifacts.map((a, i) => {
    const s = statuses[i]!;
    return `${a.type} ${a.name} — written, activated: ${s.activated === true ? "true" : "false"}`;
  });

  return buildResponse({
    header: {
      tool: "abap_rap",
      table: spec.table,
      package: spec.package,
      flavour: spec.flavour,
      draft: spec.draft,
      binding: spec.names.serviceBinding,
      cds_form: spec.cdsForm,
      writes: stack.artifacts.length,
      ...(bindingUrl ? { service_binding_url: bindingUrl } : {}),
    },
    body: artifactLines.join("\n"),
    bodyLabel: "ARTIFACTS",
    notes: [renderRapSummary(stack.summary)],
    hints: [
      `abap_service op="publish" binding="${spec.names.serviceBinding}" confirm="${spec.names.serviceBinding}"`,
    ],
    maxChars: deps.maxChars,
  });
}

// ---------------------------------------------------------------- register ---

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/**
 * Registers `abap_rap`. Every artifact's preflight/gate check runs from raw
 * arguments alone, BEFORE `ensureConnected()` — a refusal, `dry_run` or not,
 * touches zero requests, same rule `abap_write` follows.
 */
export function registerRapTools(mcp: McpServer, deps: RapToolDeps, io: RapIo = defaultRapIo(deps)): void {
  mcp.registerTool(
    "abap_rap",
    {
      description:
        "Generate a RAP stack (root/projection CDS views, behavior definitions, behavior " +
        "implementation class, service definition, service binding, optional draft table) " +
        "from an existing table. dry_run previews every artifact's name and source with zero " +
        "writes. A real run writes in dependency order and stops at the first failure " +
        "(RAP_PARTIAL), leaving already-written artifacts in place for a retry.",
      inputSchema: rapInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      try {
        const a = (args ?? {}) as Record<string, unknown>;
        rejectUnknownArgs(a);
        const input = RapInput.parse(a);

        const targets = deriveArtifactTargets(input);
        for (const t of targets) {
          const pf = preflight({ object: t.name, type: t.type, package: input.package });
          deps.safety.assert("write", pf, { phase: "preflight", corr: { kind: "unresolved" } });
        }

        await deps.ensureConnected();
        const res = await deps.pool.withWrite("abap_rap", undefined, (conn) =>
          abapRap(conn, input, { maxChars: deps.cfg.maxResponseChars }, io),
        );
        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
