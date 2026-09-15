/**
 * `abap_service` — reads the OData contract a RAP service binding (SRVB)
 * publishes, not its data; `op="publish"`/`"unpublish"` register or
 * deregister the binding in the OData service runtime.
 *
 * Three READ modes: `contract` (default) — header + entity-set table.
 * `entity` — expand one set into fields and navigation. `raw` — EDMX
 * verbatim, an escape hatch for when the compressed view drops something
 * needed.
 *
 * There is no mode that returns rows, and there will not be one: an ADT
 * connection is a developer session, and reading business data through it
 * borrows the developer's authority to bypass the application's. The refusal
 * is structural — the only URL this stack builds ends in `$metadata`. See the
 * P-40 argument in `src/adt/odata.ts` and `src/adt/edmx.ts`. Publishing does
 * not weaken this: it registers/deregisters an ICF node, it never reads or
 * writes a business row.
 *
 * `raw` isn't the default because EDMX is written for parsers and is mostly
 * repetition (annotations, role names, namespace repeated on every
 * reference); `contract` derives the three facts an agent actually wants
 * once: what sets exist, their keys, what they let you do.
 *
 * `op="read"` (the default, omitting `op` entirely) is registered
 * unconditionally, including in read-only mode: three GETs, no lock, no
 * stateful session, no server-side object created. Feature-gated on the RAP
 * discovery collection (`rap.srvb` → `/businessservices/bindings`),
 * fail-open like `abap_atc` on `/atc/` — an unreadable discovery document is
 * not assumed to mean an old backend. `op="publish"`/`"unpublish"` DO mutate
 * (an ADT publish job, `src/adt/odata.ts#runPublishJob`) and are gated at
 * call time by `SafetyConfig.allowServicePublish` — a separate, admin-mode
 * ceiling that ordinary write access does not imply. See
 * {@link abapServicePublish} for the confirm-echo/journal/ceiling sequence.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AbapConnection } from "../adt/connection.js";
import { AbapError } from "../adt/errors.js";
import type { SessionPool } from "../adt/pool.js";
import {
  bindingODataVersion,
  normaliseBindingName,
  publishJobPath,
  readServiceBinding,
  readServiceContract,
  readServiceRuntimeInfo,
  runPublishJob,
  serviceBindingUri,
  type PublishAction,
  type PublishOutcome,
  type ServiceBindingInfo,
  type ServiceContract,
  type ServiceRuntimeInfo,
} from "../adt/odata.js";
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
import { systemKey, type BeforeImageCapture, type Journal } from "../journal.js";
import type { SafetyDecision, SafetyGate, SafetyTarget } from "../safety.js";

// ------------------------------------------------------------------ schema ---

export const serviceInputSchema = {
  binding: z.string().describe("SRVB name, not the CDS view or SRVD."),
  mode: z
    .enum(["contract", "entity", "raw"])
    .optional()
    .describe("contract (default): sets/keys/perms. entity: expand one set, needs entity. raw: EDMX."),
  entity: z.string().optional().describe("Set/type to expand. Required for mode=entity."),
  op: z
    .enum(["read", "publish", "unpublish"])
    .optional()
    .describe(
      "read (default): contract/entity/raw as above. publish/unpublish: register or " +
        "deregister the binding in the OData service runtime — needs confirm, and is " +
        "off unless ABAP_ALLOW_SERVICE_PUBLISH permits it.",
    ),
  confirm: z
    .string()
    .optional()
    .describe(
      "Required to arm op=publish/unpublish: the binding name, echoed back exactly. " +
        "Omit it first to get a dry run.",
    ),
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
  /**
   * Only merged into the `contract` (default-mode) branch — the sole caller
   * that supplies it is {@link abapServicePublish}'s post-publish re-read,
   * which always calls with `input = {}` (default mode). `raw`/`entity`
   * ignore it silently rather than erroring, so a future caller that passes
   * it under a different mode fails soft instead of throwing on a header key
   * that would just be dropped.
   */
  extra?: { readonly header?: Record<string, string | number | boolean | undefined>; readonly notes?: string[] },
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
      ...extra?.header,
    },
    sections,
    body: renderEntitySets(sc),
    bodyLabel: "ENTITY SETS",
    notes: [
      ...(extra?.notes ?? []),
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

// ----------------------------------------------------------- publish/unpublish ---

/**
 * The safety-gate target for a publish/unpublish. `type: "SRVB/SVB"` names
 * the object kind the way `capabilities.ts` does elsewhere; `exists: true`
 * because a publish/unpublish always targets a binding {@link readServiceBinding}
 * just read — never a create.
 *
 * This routes a publish through every ORDINARY write ceiling too (SAP
 * namespace, package allowlist, name prefix), on top of the dedicated
 * `allowServicePublish` ceiling checked below: an SAP-namespace binding like
 * `/DMO/UI_TRAVEL_U_V2` is refused by the namespace rule exactly as an
 * ordinary write to it would be, while a customer `Z*`/`Y*` binding in an
 * allowed package is permitted, same as any other write. Intentional, not
 * an oversight — a publish changes the service runtime's registration for
 * that package as surely as changing the binding's source would.
 */
function publishTarget(binding: ServiceBindingInfo): SafetyTarget {
  return {
    name: binding.name,
    type: "SRVB/SVB",
    exists: true,
    ...(binding.packageName === undefined ? {} : { packageName: binding.packageName }),
  };
}

/**
 * Non-throwing verdict for a publish/unpublish, so a dry run can explain a
 * refusal instead of just failing. `op: "write"` (not `"transport"`) because
 * a publish is not a CTS operation — `corr: {kind:"local"}` tells
 * `SafetyGate.evaluate` this write involves no transport request at all, so
 * step 10 (the transport allowlist) is skipped rather than misapplied to an
 * action that never touches CTS.
 */
function publishCeilingDecision(gate: SafetyGate, binding: ServiceBindingInfo): SafetyDecision {
  return gate.evaluate("write", publishTarget(binding), { publish: true, corr: { kind: "local" } });
}

/**
 * Dynamic hint naming whichever lever is actually live, same pattern as
 * `writeAccessHint`/`releaseAccessHint` in `tools/transport.ts` —
 * `allowServicePublish` is admin-mode-only under `ABAP_MODE`, not implied by
 * `edit` (ordinary write access) any more than `allowTransportRelease` is.
 */
function publishAccessHint(gate: SafetyGate): string {
  const mode = gate.config.abapMode;
  return mode !== undefined
    ? `ABAP_MODE=admin (it is ${mode})`
    : "ABAP_ALLOW_SERVICE_PUBLISH=true";
}

/** Throwing form of {@link publishCeilingDecision}. Called BEFORE any mutating request. */
function assertPublishCeiling(gate: SafetyGate, binding: ServiceBindingInfo, action: PublishAction): void {
  const d = publishCeilingDecision(gate, binding);
  if (d.allowed) return;
  throw new AbapError(
    d.code ?? "READ_ONLY",
    d.reason,
    { operation: `service-${action}`, binding: binding.name, rule: d.rule },
    d.hint ??
      `${action === "publish" ? "Publishing" : "Unpublishing"} a service binding needs ` +
        `${publishAccessHint(gate)}. It is deliberately NOT implied by ordinary write access ` +
        "(ABAP_MODE=edit, or legacy ABAP_ALLOW_WRITE).",
  );
}

/** `confirm` must echo the binding name exactly (trim/case-insensitive) — same pattern as `abap_transport_release`'s `confirm`. */
function assertConfirm(action: PublishAction, bindingName: string, confirm: string): void {
  if (confirm.trim().toUpperCase() !== bindingName.trim().toUpperCase()) {
    throw new AbapError(
      "BAD_INPUT",
      `confirm must echo the binding name exactly to ${action} ${bindingName}.`,
      { binding: bindingName, action, confirm },
      `Call again with confirm: "${bindingName}" once you've reviewed the dry run.`,
    );
  }
}

/** What `abapServicePublish` needs in order to journal. Mirrors `TransportJournalDeps` in `tools/transport.ts`. */
export interface ServiceJournalDeps {
  readonly journal: Journal;
  readonly cfg: Pick<Config, "sid" | "url" | "client">;
  readonly warn: (msg: string) => void;
}

/**
 * Report the ceiling verdict and the exact armed call, without mutating
 * anything — `bindingODataVersion`/`publishJobPath` are best-effort here
 * (wrapped: an undecidable version must not stop a dry run from answering,
 * only the armed call needs them to actually succeed).
 */
function publishDryRun(
  binding: ServiceBindingInfo,
  action: PublishAction,
  ceiling: SafetyDecision,
  maxChars: number,
): BuiltResponse {
  let jobPath: string | undefined;
  try {
    jobPath = publishJobPath(action, bindingODataVersion(binding));
  } catch {
    jobPath = undefined;
  }
  const armedCall = JSON.stringify({ binding: binding.name, op: action, confirm: binding.name });
  return buildResponse({
    header: {
      binding: binding.name,
      service: binding.serviceName,
      op: action,
      published: binding.published,
      jobPath,
      gate: ceiling.allowed ? "allowed" : "refused",
    },
    notes: [
      ceiling.allowed
        ? `The safety gate permits this ${action}.`
        : `The safety gate refuses this ${action}: ${ceiling.reason}`,
      "DRY RUN — nothing was published or unpublished. This call only read the binding.",
      `To ${action}, call again with: ${armedCall}`,
    ],
    maxChars,
  });
}

/**
 * `abap_service` `op="publish"`/`"unpublish"`.
 *
 * Order of operations, and every step matters:
 *  1. Read the binding — `NOT_FOUND` surfaces here, before anything else.
 *  2. Compute the ceiling verdict (needed either way: shown in a dry run,
 *     asserted before an armed call).
 *  3. No `confirm` ⇒ dry run: report the verdict and the exact armed call,
 *     mutate nothing.
 *  4. `confirm` supplied ⇒ validate it echoes the binding name exactly.
 *  5. Assert the ceiling (throws before any mutating request) and mint the
 *     `AuthorizedTarget` proof `runPublishJob` requires.
 *  6. Best-effort pre-read of runtime info, for the journal before-image
 *     only — its failure (typical on a fresh publish: `SERVICE_NOT_PUBLISHED`)
 *     must not stop the publish job itself.
 *  7. Journal `begin()` BEFORE the POST, fail-closed, NOT wrapped in
 *     try/catch: `src/adt/undo.ts` refuses to undo a `service-publish`/
 *     `service-unpublish` entry regardless, so an unrecorded irreversible
 *     mutation is the one outcome worse than refusing the call.
 *  8. The POST (`runPublishJob`), wrapped: a throw here is not proof the job
 *     didn't reach the server, so on failure the entry stays `pending` (a
 *     warning is logged, never a `failed` settle) and the error is rethrown.
 *  9. Settle the journal entry `succeeded` on return — `runPublishJob`
 *     already turns a server-side "error" severity into a thrown
 *     `SERVICE_PUBLISH_FAILED` before it would ever return, so the only
 *     terminal state reachable here is success; an "ok"/"warning" severity
 *     is a completed job with a message worth surfacing, not a failure to
 *     record as one.
 * 10. `publish` only: a wrapped follow-up `readServiceContract` to render
 *     the now-live contract — wrapped because the publish already succeeded
 *     (`outcome` is in hand), so a failure reading it back must not be
 *     reported as if the publish itself had failed.
 * 11. `unpublish`: no follow-up read (there is no contract left); report the
 *     outcome directly.
 */
export async function abapServicePublish(
  conn: AbapConnection,
  input: ServiceInput,
  action: PublishAction,
  maxChars: number,
  gate: SafetyGate,
  journal: ServiceJournalDeps,
): Promise<BuiltResponse> {
  // Step 1
  const binding = await readServiceBinding(conn, input.binding);

  // Step 2
  const ceiling = publishCeilingDecision(gate, binding);

  // Step 3
  if (input.confirm === undefined) {
    return publishDryRun(binding, action, ceiling, maxChars);
  }

  // Step 4
  assertConfirm(action, binding.name, input.confirm);

  // Step 5
  assertPublishCeiling(gate, binding, action);
  const proof = gate.authorize("write", publishTarget(binding), {
    publish: true,
    corr: { kind: "local" },
  });

  // Step 6
  let beforeRuntime: ServiceRuntimeInfo | undefined;
  // "failed" (read attempted, did not succeed — existedBefore stays a
  // guess) vs "unknown" (provenance never recorded, a legacy entry): this
  // catch is the former case, never the latter.
  let beforeCapture: BeforeImageCapture = "captured";
  try {
    beforeRuntime = await readServiceRuntimeInfo(conn, binding);
  } catch {
    beforeRuntime = undefined;
    beforeCapture = "failed";
  }
  const beforeSource =
    `binding.published=${binding.published ?? "unstated"} ` +
    `runtime.published=${beforeRuntime?.published ?? "unstated"} ` +
    `allowedAction=${binding.allowedAction ?? "unstated"}`;

  // Step 7 — deliberately NOT wrapped in try/catch: see the algorithm
  // comment above and `abapTransportRelease` in `tools/transport.ts` for the
  // same reasoning applied to another irreversible mutation. The two
  // branches (rather than one call with `operation: action === "publish" ?
  // ... : ...`) are deliberate: `test/journal-contract.test.ts`'s
  // `JournalOperation coverage` check matches `operation: "<value>"` as a
  // literal, not through a ternary — see that file's `JOURNAL_OPERATIONS`
  // comment.
  const journalObject = {
    name: binding.name,
    type: "SRVB/SVB",
    uri: serviceBindingUri(binding.name),
    package: binding.packageName ?? "",
    description: binding.serviceName ?? binding.name,
  };
  const journalSystemKey = systemKey({ sid: journal.cfg.sid, url: journal.cfg.url, client: journal.cfg.client });
  const entry =
    action === "publish"
      ? await journal.journal.begin({
          operation: "service-publish",
          object: journalObject,
          existedBefore: true,
          beforeCapture,
          beforeSource,
          irreversible: true,
          systemKey: journalSystemKey,
          // No `trSource`: that field answers "where did the transport
          // request come from" (see `JournalTrSource`) — a publish has no
          // transport request at all (`corr: {kind:"local"}` above is exactly
          // this fact), so the field stays absent rather than naming a
          // request that doesn't exist.
          tool: "abap_service",
        })
      : await journal.journal.begin({
          operation: "service-unpublish",
          object: journalObject,
          existedBefore: true,
          beforeCapture,
          beforeSource,
          irreversible: true,
          systemKey: journalSystemKey,
          tool: "abap_service",
        });

  // Step 8
  let outcome: PublishOutcome;
  try {
    outcome = await runPublishJob(conn, binding, action, proof);
  } catch (e) {
    if (entry) {
      journal.warn(
        `[abapsmith] WARNING: ${binding.name} — the ${action} job failed with ` +
          `"${(e as Error).message}". Journal entry ${entry.id} stays \`pending\`: a failed ` +
          `call is not proof the ${action} did not reach the system. Re-check with ` +
          `abap_service {"binding":"${binding.name}"} before retrying.`,
      );
    }
    throw e;
  }

  // Step 9
  if (entry) {
    const settled = await journal.journal.settle(entry.id, {
      outcome: "succeeded",
      afterSource: `severity=${outcome.severity ?? "unstated"} action=${outcome.action}`,
    });
    if (!settled.settled) {
      journal.warn(
        `[abapsmith] WARNING: ${binding.name} — journal entry ${entry.id} could not be settled ` +
          `(${settled.reason}${settled.error ? `: ${settled.error}` : ""}). It will read as ` +
          `\`pending\`; the ${action} itself succeeded.`,
      );
    }
  }

  const warningNote =
    outcome.severity !== undefined && !outcome.severity.startsWith("ok") && !outcome.severity.startsWith("error")
      ? [`Server reported severity=${outcome.severity}: ${outcome.shortText ?? outcome.longText ?? "(no text)"}`]
      : [];

  // Step 11 (unpublish)
  if (action === "unpublish") {
    return buildResponse({
      header: {
        binding: outcome.bindingName,
        service: outcome.serviceName,
        op: "unpublish",
        odata: outcome.odataVersion,
        severity: outcome.severity,
      },
      notes: [
        `${outcome.bindingName} was unpublished from the OData service runtime.`,
        ...warningNote,
        outcome.shortText ?? "(server gave no short text)",
      ],
      maxChars,
    });
  }

  // Step 10 (publish)
  try {
    const sc = await readServiceContract(conn, binding.name);
    return renderServiceResult(sc, {}, maxChars, {
      header: { severity: outcome.severity },
      notes: [
        `${outcome.bindingName} was just published to the OData ${outcome.odataVersion} service runtime.`,
        ...warningNote,
      ],
    });
  } catch (e) {
    return buildResponse({
      header: {
        binding: outcome.bindingName,
        service: outcome.serviceName,
        op: "publish",
        odata: outcome.odataVersion,
        severity: outcome.severity,
      },
      notes: [
        `${outcome.bindingName} was published to the OData service runtime.`,
        ...warningNote,
        `Reading the updated contract back failed: ${(e as Error).message}. The publish ` +
          `itself succeeded — call abap_service {"binding":"${outcome.bindingName}"} to see it.`,
      ],
      maxChars,
    });
  }
}

// ---------------------------------------------------------------- register ---

export interface ServiceToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars" | "sid" | "url" | "client">;
  readonly journal: Journal;
  /** REQUIRED — unlike `TransportToolDeps.warn` (optional, defaulted to stderr). Every call site that can reach a mutating op already has one in scope. */
  readonly warn: (msg: string) => void;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

function journalDeps(deps: ServiceToolDeps): ServiceJournalDeps {
  return { journal: deps.journal, cfg: deps.cfg, warn: deps.warn };
}

/**
 * `op="read"` (default): no safety-gate call — `read` is outside
 * `MUTATING_OPS` and always allowed, a gate here would be ceremony, not a
 * real ceiling. `op="publish"`/`"unpublish"` DO mutate, so those dispatch
 * through `deps.pool.withWrite` and are gated by `deps.safety` at call time
 * inside {@link abapServicePublish} — registration itself stays
 * unconditional (see the module docblock and `server.ts`'s registration
 * comment for why: the connected ceilings are unknowable here).
 */
export function registerServiceTools(mcp: McpServer, deps: ServiceToolDeps): void {
  mcp.registerTool(
    "abap_service",
    {
      description:
        "OData contract a RAP SRVB publishes: entity sets, keys, fields, nav, " +
        "CRUD/search/page perms; V2/V4 detected. Cannot read entity data — contract " +
        'only. op="publish"/"unpublish" register or deregister the binding in the OData ' +
        "service runtime (admin-mode ceiling, confirm required to arm). Unpublished " +
        "bindings named as such.",
      inputSchema: serviceInputSchema,
      annotations: {
        // op="publish"/"unpublish" mutate (register/deregister an ICF node),
        // so this is no longer the always-read-only tool it was before:
        // readOnlyHint is now false. idempotentHint/openWorldHint stay true
        // — publishing an already-published binding (or unpublishing an
        // already-unpublished one) re-asserts the same end state rather
        // than accumulating, and the mutation reaches outside this MCP
        // session (the ICF/service catalogue), same as before.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const a = (args ?? {}) as Record<string, unknown>;
        rejectUnknownArgs(a);
        await deps.ensureConnected();
        const input = a as ServiceInput;
        const op = input.op ?? "read";
        if (op === "read") {
          const res = await deps.pool.withRead("abap_service", (conn) =>
            abapService(conn, input, deps.cfg.maxResponseChars),
          );
          return ok(res.text);
        }
        const res = await deps.pool.withWrite(
          "abap_service",
          serviceBindingUri(normaliseBindingName(input.binding)),
          (conn) => abapServicePublish(conn, input, op, deps.cfg.maxResponseChars, deps.safety, journalDeps(deps)),
        );
        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
