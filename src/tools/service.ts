/**
 * `abap_service` — reads the OData contract a RAP service binding (SRVB)
 * publishes, not its data.
 *
 * Three modes: `contract` (default) — header + entity-set table. `entity` —
 * expand one set into fields and navigation. `raw` — EDMX verbatim, an escape
 * hatch for when the compressed view drops something needed.
 *
 * There is no fourth mode that returns rows, and there will not be one: an
 * ADT connection is a developer session, and reading business data through it
 * borrows the developer's authority to bypass the application's. The refusal
 * is structural — the only URL this stack builds ends in `$metadata`. See the
 * P-40 argument in `src/adt/odata.ts` and `src/adt/edmx.ts`.
 *
 * `raw` isn't the default because EDMX is written for parsers and is mostly
 * repetition (annotations, role names, namespace repeated on every
 * reference); `contract` derives the three facts an agent actually wants
 * once: what sets exist, their keys, what they let you do.
 *
 * Registered unconditionally, including in read-only mode: three GETs, no
 * lock, no stateful session, no server-side object created. Feature-gated on
 * the RAP discovery collection (`rap.srvb` → `/businessservices/bindings`),
 * fail-open like `abap_atc` on `/atc/` — an unreadable discovery document is
 * not assumed to mean an old backend.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AbapConnection } from "../adt/connection.js";
import { AbapError } from "../adt/errors.js";
import type { SessionPool } from "../adt/pool.js";
import { readServiceContract, type ServiceContract } from "../adt/odata.js";
import {
  findEntitySet,
  findEntityType,
  localName,
  type EdmxCapabilities,
  type EdmxEntitySet,
  type EdmxEntityType,
} from "../adt/edmx.js";
import type { Config } from "../config.js";
import { buildResponse, textTable, type BuiltResponse } from "../compact.js";

// ------------------------------------------------------------------ schema ---

export const serviceInputSchema = {
  binding: z.string().describe("SRVB name, not the CDS view or SRVD."),
  mode: z
    .enum(["contract", "entity", "raw"])
    .optional()
    .describe("contract (default): sets/keys/perms. entity: expand one set, needs entity. raw: EDMX."),
  entity: z.string().optional().describe("Set/type to expand. Required for mode=entity."),
};

export const ServiceInput = z.object(serviceInputSchema);
export type ServiceInput = z.infer<typeof ServiceInput>;

const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(ServiceInput.shape));

/** Same pattern as `rejectUnknownArgs` in `./atc.ts` and `./dumps.ts`. */
function rejectUnknownArgs(args: Record<string, unknown>): void {
  const unknown = Object.keys(args).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length === 0) return;
  throw new AbapError(
    "BAD_INPUT",
    `abap_service does not take ${unknown.map((k) => `\`${k}\``).join(", ")}.`,
    { unknown, known: [...KNOWN_KEYS] },
    `Parameters are: ${[...KNOWN_KEYS].join(", ")}. There is deliberately no parameter that ` +
      "returns entity data — abapsmith reads OData contracts, never rows.",
  );
}

// --------------------------------------------------------------- rendering ---

/** Compact capability flags; `undefined` stays absent — "not stated" and "no" are different facts. */
function capsOf(c: EdmxCapabilities): string {
  const out: string[] = [];
  const flag = (label: string, v: boolean | undefined): void => {
    if (v === true) out.push(label);
    else if (v === false) out.push(`-${label}`);
  };
  flag("C", c.creatable);
  flag("U", c.updatable);
  flag("D", c.deletable);
  flag("search", c.searchable);
  flag("page", c.pageable);
  if (c.requiresFilter === true) out.push("needs-filter");
  return out.join(" ");
}

function shortType(t: string): string {
  return t.startsWith("Edm.") ? t.slice(4) : localName(t);
}

function typeWithFacets(p: { type: string; maxLength?: string; precision?: string; scale?: string }): string {
  const base = shortType(p.type);
  if (p.maxLength !== undefined) return `${base}(${p.maxLength})`;
  if (p.precision !== undefined) {
    return p.scale === undefined ? `${base}(${p.precision})` : `${base}(${p.precision},${p.scale})`;
  }
  return base;
}

function keysOf(type: EdmxEntityType | undefined): string {
  return type ? type.keys.join(",") : "";
}

function renderEntitySets(sc: ServiceContract): string {
  const rows = sc.contract.entitySets.map((s: EdmxEntitySet) => {
    const t = findEntityType(sc.contract, s.entityType);
    return {
      SET: s.name,
      KEY: keysOf(t),
      PROPS: t ? String(t.properties.length) : "?",
      NAV: t ? String(t.navigation.length) : "?",
      CAPS: capsOf(s.capabilities),
      LABEL: s.label ?? t?.label ?? "",
    };
  });
  const columns = ["SET", "KEY", "PROPS", "NAV", "CAPS"];
  if (rows.some((r) => r.LABEL !== "")) columns.push("LABEL");
  return textTable(rows, columns);
}

function renderProperties(type: EdmxEntityType): string {
  const keys = new Set(type.keys);
  const rows = type.properties.map((p) => ({
    FIELD: p.name,
    TYPE: typeWithFacets(p),
    KEY: keys.has(p.name) ? "K" : "",
    REQ: p.nullable === false ? "*" : "",
    FLAGS: [
      p.creatable === false ? "-C" : "",
      p.updatable === false ? "-U" : "",
      p.filterable === false ? "-filter" : "",
      p.sortable === false ? "-sort" : "",
      p.requiredInFilter === true ? "needs-filter" : "",
      p.unit === undefined ? "" : `unit=${p.unit}`,
      p.text === undefined ? "" : `text=${p.text}`,
    ]
      .filter(Boolean)
      .join(" "),
    LABEL: p.label ?? "",
  }));
  const columns = ["FIELD", "TYPE", "KEY", "REQ"];
  if (rows.some((r) => r.FLAGS !== "")) columns.push("FLAGS");
  if (rows.some((r) => r.LABEL !== "")) columns.push("LABEL");
  return textTable(rows, columns);
}

function renderNavigation(type: EdmxEntityType): string {
  if (type.navigation.length === 0) return "";
  return textTable(
    type.navigation.map((n) => ({
      NAV: n.name,
      TARGET: n.unresolved ? n.target : localName(n.target),
      CARD: n.multiplicity ?? "",
    })),
    ["NAV", "TARGET", "CARD"],
  );
}

function renderOperations(sc: ServiceContract): string {
  if (sc.contract.operations.length === 0) return "";
  return textTable(
    sc.contract.operations.map((o) => ({
      NAME: o.name,
      KIND: o.kind,
      METHOD: o.httpMethod ?? "",
      RETURNS: o.returnType === undefined ? "" : shortType(o.returnType),
      PARAMS: o.parameters.map((p) => `${p.name}:${shortType(p.type)}`).join(" "),
    })),
    ["NAME", "KIND", "METHOD", "RETURNS", "PARAMS"],
  );
}

/** Shared notes every mode carries. */
function commonNotes(sc: ServiceContract): string[] {
  const notes: string[] = [];
  if (sc.version.disagreement !== undefined) {
    notes.push(`VERSION MISMATCH: ${sc.version.disagreement}`);
  }
  if (sc.cookieJarChanged) {
    notes.push(
      "The OData service runtime set its own session cookie. abapsmith discarded it and " +
        "restored the ADT session jar — the two ICF nodes must not share a session or the " +
        "ADT session would be stranded.",
    );
  }
  notes.push(
    "This is the service CONTRACT, not its data. abapsmith reads $metadata only and has no " +
      "mode that returns entity rows (parity item P-40) — an ADT developer session is not an " +
      "application user session. Use an OData client with its own credentials for data.",
  );
  return notes;
}

/** Split from {@link abapService} so rendering is testable without a connection. */
export function renderServiceResult(
  sc: ServiceContract,
  input: { readonly mode?: string; readonly entity?: string },
  maxChars: number,
): BuiltResponse {
  const mode = input.mode ?? "contract";
  const c = sc.contract;

  if (mode === "raw") {
    return buildResponse({
      header: {
        binding: sc.binding.name,
        odata: c.version,
        path: sc.metadataPath,
        bytes: c.rawBytes,
      },
      body: sc.raw ?? "",
      bodyLabel: "EDMX",
      notes: [
        ...commonNotes(sc),
        `Raw EDMX is ${c.rawBytes} bytes. mode="contract" renders the same service in a ` +
          "fraction of that; use raw only when the compressed view dropped something you need.",
      ],
      maxChars,
    });
  }

  if (mode === "entity") {
    const wanted = input.entity;
    if (wanted === undefined || wanted.trim() === "") {
      throw new AbapError(
        "BAD_INPUT",
        'mode="entity" needs the entity parameter.',
        { mode, entitySets: c.entitySets.map((s) => s.name) },
        `Name one of the service's entity sets: ${
          c.entitySets
            .slice(0, 20)
            .map((s) => s.name)
            .join(", ") || "(this service exposes none)"
        }. Or call with mode="contract" to list them.`,
      );
    }
    const set = findEntitySet(c, wanted);
    const type = findEntityType(c, set?.entityType ?? wanted);
    if (!type) {
      throw new AbapError(
        "NOT_FOUND",
        `Service ${sc.binding.name} exposes no entity set or entity type called '${wanted}'.`,
        { entity: wanted, entitySets: c.entitySets.map((s) => s.name) },
        `Known entity sets: ${
          c.entitySets
            .slice(0, 30)
            .map((s) => s.name)
            .join(", ") || "(none)"
        }. Note the OData convention: the SET and the TYPE usually have different names ` +
          "(Travel vs TravelType) — either is accepted here.",
      );
    }

    const sections: Array<{ title: string; content: string }> = [];
    const nav = renderNavigation(type);
    if (nav !== "") sections.push({ title: "NAVIGATION", content: nav });

    return buildResponse({
      header: {
        binding: sc.binding.name,
        odata: c.version,
        set: set?.name ?? "(type only)",
        type: type.name,
        keys: type.keys.join(",") || "(none)",
        fields: type.properties.length,
        caps: set ? capsOf(set.capabilities) || "(unstated)" : undefined,
        label: type.label ?? set?.label,
      },
      sections,
      body: renderProperties(type),
      bodyLabel: "FIELDS",
      notes: [
        ...commonNotes(sc),
        "K marks a key field, * marks Nullable=false. A flag is shown only when the service " +
          "states it: a blank cell means the metadata is silent, not that the answer is yes.",
      ],
      maxChars,
    });
  }

  // -- contract (default) --
  const sections: Array<{ title: string; content: string }> = [];
  const ops = renderOperations(sc);
  if (ops !== "") sections.push({ title: "OPERATIONS", content: ops });

  const built = buildResponse({
    header: {
      binding: sc.binding.name,
      service: sc.binding.serviceName,
      odata: c.version,
      path: sc.metadataPath,
      sets: c.entitySets.length,
      types: c.entityTypes.length,
      package: sc.binding.packageName,
    },
    sections,
    body: renderEntitySets(sc),
    bodyLabel: "ENTITY SETS",
    notes: [
      ...commonNotes(sc),
      "CAPS: C/U/D = creatable/updatable/deletable, a leading minus means the service " +
        "explicitly forbids it, and an absent letter means the metadata does not say.",
      `Compressed from ${c.rawBytes} bytes of EDMX. Expand one set with mode="entity", or ` +
        'get the original with mode="raw".',
    ],
    hints: [
      'Use mode="entity" with a set name for its fields, keys and navigation.',
    ],
    maxChars,
  });
  return built;
}

/** Compression ratio of a rendered response against the EDMX it came from. */
export function compressionRatio(sc: ServiceContract, rendered: BuiltResponse): number {
  const out = rendered.chars ?? rendered.text.length;
  return out === 0 ? 0 : sc.contract.rawBytes / out;
}

// -------------------------------------------------------------------- core ---

export async function abapService(
  conn: AbapConnection,
  input: ServiceInput,
  maxChars: number,
): Promise<BuiltResponse> {
  const sc = await readServiceContract(conn, input.binding, {
    includeRaw: input.mode === "raw",
  });
  return renderServiceResult(
    sc,
    {
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.entity === undefined ? {} : { entity: input.entity }),
    },
    maxChars,
  );
}

// ---------------------------------------------------------------- register ---

export interface ServiceToolDeps {
  readonly pool: SessionPool;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars">;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/** No safety-gate call: `read` ops are always allowed outside `MUTATING_OPS`; a gate here would be ceremony, not a real ceiling. */
export function registerServiceTools(mcp: McpServer, deps: ServiceToolDeps): void {
  mcp.registerTool(
    "abap_service",
    {
      description:
        "OData contract a RAP SRVB publishes: entity sets, keys, fields, nav, " +
        "CRUD/search/page perms; V2/V4 detected. Cannot read entity data — contract " +
        "only. Unpublished bindings named as such.",
      inputSchema: serviceInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const a = (args ?? {}) as Record<string, unknown>;
        rejectUnknownArgs(a);
        await deps.ensureConnected();
        const res = await deps.pool.withRead("abap_service", (conn) =>
          abapService(conn, a as ServiceInput, deps.cfg.maxResponseChars),
        );
        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
