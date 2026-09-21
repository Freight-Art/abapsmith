/**
 * `abap_img_edit` — write IMG (SPRO) customizing table rows: `preview`,
 * `upsert`, `delete`, and `create_request` (mint a customizing transport
 * request). Sits on top of `src/adt/img-write.ts`'s three orchestration
 * functions (`runImgProbe`/`runImgApply`/`runCreateCustomizingRequest`) and
 * `src/adt/img-write-policy.ts`'s pure `evaluateImgWrite` — this module
 * contributes only argument parsing, the two-phase bridge-deploy safety
 * gate, mode dispatch, rendering, and post-hoc journalling. Every
 * plan-validation rule and every refusal rule already lives in one of those
 * two modules; nothing here re-implements either.
 *
 * IMPORTANT, stated once here rather than per row: `upsert`/`delete` do a
 * direct `MODIFY`/`DELETE` on the target table (see `img-write-bridge.ts`).
 * The target view's own foreign-key checks, fixed-value checks, and
 * table-maintenance-generator events do NOT run — only the row data itself
 * is written, so validation the SM30 dialog would have performed did not
 * happen here. `evaluateImgWrite` (img-write-policy.ts) already seeds this
 * disclosure, `SM30_BYPASS_NOTE`, as the first note on every ALLOWED verdict
 * (including `preview`) — this module imports that constant rather than
 * keeping its own copy, renders it verbatim for `upsert`/`delete`, and
 * deliberately filters that one sentence out of `preview`'s own notes,
 * since nothing has been written yet for a preview to disclose a bypass of.
 *
 * UNPROVEN, same standing as `img-write.ts`/`img-write-bridge.ts`/
 * `customizing-request.ts`: no function in this chain — probe, apply, or
 * customizing-request creation — has ever been executed against a live SAP
 * system. Nothing below may imply otherwise.
 *
 * `create_request` lives here, not in `abap_transport`: that tool's
 * `operation: "create"` is package-driven from its very first argument (a
 * developed/transportable package name resolves the request type), which
 * has no meaning for a customizing (`type: "W"`) request — a customizing
 * request is not filed against a package at all. Duplicating `abap_transport`
 * just to special-case type `W` would blur a tool that is otherwise entirely
 * package-shaped; a customizing-request mode belongs next to the other IMG
 * write modes that actually consume its output (an `upsert`/`delete`'s own
 * `corr_nr`) instead.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { AbapError } from "../adt/errors.js";
import { FLUID_PACKAGE } from "../adt/fluid/package.js";
import { imgManifest } from "../adt/fluid/builtin/img.js";
import { IMG_DEFAULT_LANGUAGE, IMG_LANGUAGE_RE, assertImgLanguage } from "../adt/img-query.js";
import {
  validateApplyPlan,
  type ImgProbePlan,
  type ImgApplyPlan,
  type ImgWriteField,
  type ImgWriteRow,
  type ImgWriteValueRow,
} from "../adt/img-write-bridge.js";
import {
  type CustomizingRequestPlan,
  type CustomizingRequestTranscript,
} from "../adt/customizing-request.js";
import {
  runImgProbe,
  runImgApply,
  runCreateCustomizingRequest,
  type ImgProbeResult,
  type ImgApplyResult,
} from "../adt/img-write.js";
import {
  evaluateImgWrite,
  SM30_BYPASS_NOTE,
  type ImgWriteProbe,
  type ImgWriteRequest,
  type PolicyField,
  type PolicyTable,
} from "../adt/img-write-policy.js";
import { readImgShow, readImgObjects, type ImgObjectKind, type ImgReadConnection } from "../adt/img-read.js";
import { resolveActivity, resolveObject, type ResolvedTable } from "../adt/img-resolve.js";
import { readImgChecks, type ImgChecksResult } from "../adt/img-checks.js";
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import { buildResponse, textTable } from "../compact.js";
import { truncateText, MESSAGE_EXCERPT_MAX } from "../truncate.js";
import type { SafetyGate } from "../safety.js";
import {
  systemKey,
  type BeforeImageCapture,
  type Journal,
  type JournalBeginInput,
  type JournalEntry,
  type JournalObjectRef,
  type JournalOperation,
} from "../journal.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const imgEditRowSchema = z
  .object({
    key: z.record(z.string(), z.string()).describe("Key field name -> value, one entry per key_fields."),
    values: z
      .record(z.string(), z.string())
      .optional()
      .describe("upsert only: non-key field name -> value to write. Ignored by delete."),
  })
  .strict();

export const imgEditInputSchema = {
  mode: z
    .enum(["preview", "upsert", "delete", "create_request"])
    .describe(
      "preview: validate rows and show current vs. prospective, without writing. upsert: write rows " +
        "(insert or update). delete: remove rows. create_request: create a customizing (type W) transport request.",
    ),
  activity: z
    .string()
    .optional()
    .describe(
      "preview/upsert/delete: an IMG activity id, as abap_img show accepts. Resolves to base table, key " +
        "fields, and client field. Exactly one of activity/object/table is required. Conflicts with key_fields/client_field.",
    ),
  object: z
    .string()
    .optional()
    .describe(
      "preview/upsert/delete: a maintenance view, view cluster, transaction or table name, as abap_img " +
        "objects accepts. Exactly one of activity/object/table is required. Conflicts with key_fields/client_field.",
    ),
  kind: z
    .enum(["table", "view", "cluster", "transaction", "customizing_object", "report"])
    .optional()
    .describe(
      "Only meaningful with object: which catalog to resolve object against. Omitted: tries table, " +
        "view, cluster, transaction, customizing object, in that order, first match wins.",
    ),
  table: z
    .string()
    .optional()
    .describe(
      "Expert escape hatch: the base DDIC table to read/write directly, bypassing activity/object " +
        "resolution. Exactly one of activity/object/table is required. Requires key_fields; " +
        "a genuinely client-independent table cannot be written.",
    ),
  client_field: z
    .string()
    .optional()
    .describe(
      "table (expert escape hatch) only: the table's client field name, e.g. MANDT. Conflicts with activity/object.",
    ),
  key_fields: z
    .array(z.string())
    .optional()
    .describe(
      "table (expert escape hatch) only: the table's key field names, in order, excluding the client " +
        "field. At least one required. Conflicts with activity/object.",
    ),
  rows: z
    .array(imgEditRowSchema)
    .optional()
    .describe("preview/upsert/delete: 1-50 rows to probe/write. delete ignores each row's values."),
  view: z
    .string()
    .optional()
    .describe(
      "upsert/delete: the maintenance view or view cluster name recorded on the transport entry. " +
        "Defaults to the resolved view/cluster (or table if the resolved target is a table); with table, defaults to table.",
    ),
  master_type: z
    .enum(["VDAT", "CDAT"])
    .optional()
    .describe(
      'upsert/delete: the transport entry\'s object type — "VDAT" for a maintenance view (default), ' +
        '"CDAT" for a customizing object recorded directly.',
    ),
  language: z
    .string()
    .regex(IMG_LANGUAGE_RE, "single-character SAP language key (SPRAS), not an ISO code")
    .optional()
    .describe(
      `Single-character SAP language key (SPRAS), e.g. E or D — not EN/DE. Default ${JSON.stringify(IMG_DEFAULT_LANGUAGE)}.`,
    ),
  corr_nr: z
    .string()
    .optional()
    .describe(
      "upsert/delete: transport request to record the write on. Required unless the client is proven " +
        "not to auto-record client-dependent changes.",
    ),
  confirm: z
    .string()
    .optional()
    .describe("upsert/delete: must equal table, case-insensitive, to arm the write."),
  allow_cross_client: z
    .boolean()
    .optional()
    .describe(
      "Clears the policy refusal for a client-independent (affects-every-client) table. Does not make " +
        "it writable — the apply class always sets the client field from sy-mandt.",
    ),
  description: z.string().optional().describe("create_request only: the request's description text."),
  owner: z.string().optional().describe("create_request only: the request owner. Defaults to the logged-in user."),
};

export const ImgEditInput = z.object(imgEditInputSchema);
export type ImgEditInput = z.infer<typeof ImgEditInput>;

export interface ImgEditToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  /** Full `Config`: the preview mode now dispatches through the fluid `img` tool, which needs it whole. */
  readonly cfg: Config;
  /**
   * REQUIRED, same stance as `TransportToolDeps.journal` (src/tools/transport.ts): a row write here
   * is exactly as irreversible as a transport mutation, and "journalling switched off" is already
   * modelled inside `Journal` itself (`ABAP_JOURNAL=off`) — pass the disabled journal, never no journal.
   */
  readonly journal: Journal;
  /** Where journal failures are reported; defaults to stderr. */
  readonly warn?: (msg: string) => void;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function requireString(mode: string, field: string, value: string | undefined): string {
  const v = (value ?? "").trim();
  if (!v) throw new AbapError("BAD_INPUT", `mode "${mode}" requires ${field}.`, { mode, field });
  return v;
}

function rejectForMode(mode: string, field: string, value: unknown): void {
  if (value !== undefined) {
    throw new AbapError("BAD_INPUT", `"${field}" is not valid with mode "${mode}".`, { mode, field });
  }
}

/**
 * Present only when `table` was resolved from `activity`/`object` rather than supplied directly.
 * Carries what a RESOLVED response section needs to name, plus the resolution reads' own cost so it
 * can be folded into that section's prose instead of inventing a new header field (`img-write.ts`'s
 * `ImgProbeResult`/`ImgApplyResult` have no `statementsIssued` of their own to fold into instead).
 */
interface ResolutionSummary {
  selector: "activity" | "object";
  identifier: string;
  activityTitle?: string;
  objectName: string;
  objectKind: ImgObjectKind;
  policyTargetKind: "view" | "cluster" | "table" | "other";
  statementsIssued: number;
  durationMs: number;
}

interface RowEditArgs {
  table: string;
  clientField: string;
  keyFields: string[];
  rows: readonly { key: Record<string, string>; values?: Record<string, string> }[];
  view: string;
  masterType: "VDAT" | "CDAT";
  language: string;
  corrNr?: string;
  confirm?: string;
  allowCrossClient: boolean;
  resolution?: ResolutionSummary;
}

function parseRowEditArgs(mode: "preview" | "upsert" | "delete", input: ImgEditInput, cfg: Pick<Config, "language">): RowEditArgs {
  rejectForMode(mode, "description", input.description);
  rejectForMode(mode, "owner", input.owner);

  const table = requireString(mode, "table", input.table);
  const keyFields = input.key_fields ?? [];
  if (keyFields.length < 1) {
    throw new AbapError("BAD_INPUT", `mode "${mode}" requires at least one key_fields entry.`, { mode });
  }
  const rows = input.rows ?? [];
  if (rows.length < 1) {
    throw new AbapError("BAD_INPUT", `mode "${mode}" requires at least one row.`, { mode });
  }

  return {
    table,
    clientField: (input.client_field ?? "MANDT").trim(),
    keyFields,
    rows,
    view: (input.view ?? table).trim(),
    masterType: input.master_type ?? "VDAT",
    language: assertImgLanguage(input.language ?? (cfg.language || IMG_DEFAULT_LANGUAGE)),
    corrNr: input.corr_nr,
    confirm: input.confirm,
    allowCrossClient: input.allow_cross_client ?? false,
  };
}

function bridgeRows(rows: RowEditArgs["rows"]): ImgWriteRow[] {
  return rows.map((r) => ({ key: r.key, values: r.values ?? {} }));
}

/** `evaluateImgWrite`'s row-count rule only looks at `.length` — a flat merge of key+values satisfies its type without inventing a second row shape. */
function policyRows(rows: RowEditArgs["rows"]): Record<string, string>[] {
  return rows.map((r) => ({ ...r.key, ...(r.values ?? {}) }));
}

/** This tool only ever targets a table directly or a view distinct from it — "cluster"/"other" are not reachable through these arguments. */
function targetKind(table: string, view: string): "view" | "table" {
  return table.trim().toUpperCase() === view.trim().toUpperCase() ? "table" : "view";
}

/** The resolved path's own real target-kind classification, so `evaluateReal`'s policy-kind check does not fall back to the string heuristic above (which would misclassify e.g. a resolved customizing_object as "table" — see `mapPolicyTargetKind`). */
function resolvedPolicyTargetKind(args: RowEditArgs): "view" | "cluster" | "table" | "other" {
  return args.resolution?.policyTargetKind ?? targetKind(args.table, args.view);
}

// ---------------------------------------------------------------------------
// Resolution: activity/object -> base table
// ---------------------------------------------------------------------------

type Selector =
  | { readonly kind: "table" }
  | { readonly kind: "activity"; readonly activity: string }
  | { readonly kind: "object"; readonly object: string; readonly objKind?: ImgObjectKind };

/** Exactly one of activity/object/table is required for preview/upsert/delete; kind is only valid with object. */
function selectTarget(mode: "preview" | "upsert" | "delete", input: ImgEditInput): Selector {
  const present: string[] = [];
  if (input.activity !== undefined) present.push("activity");
  if (input.object !== undefined) present.push("object");
  if (input.table !== undefined) present.push("table");

  if (present.length === 0) {
    throw new AbapError(
      "BAD_INPUT",
      `mode "${mode}" requires exactly one of "activity", "object", or "table".`,
      { mode },
    );
  }
  if (present.length > 1) {
    throw new AbapError(
      "BAD_INPUT",
      `mode "${mode}" accepts only one of "activity", "object", or "table" at a time — got ${present.join(", ")}.`,
      { mode, fields: present },
    );
  }
  if (input.kind !== undefined && input.object === undefined) {
    throw new AbapError("BAD_INPUT", '"kind" is only valid together with "object".', { mode });
  }

  if (present[0] === "table") return { kind: "table" };
  if (present[0] === "activity") return { kind: "activity", activity: requireString(mode, "activity", input.activity) };
  return { kind: "object", object: requireString(mode, "object", input.object), objKind: input.kind };
}

/** key_fields/client_field are derived from the resolution when activity/object is used — supplying them too is a conflict, not a merge. */
function rejectDerivedFieldConflicts(mode: string, selector: Selector, input: ImgEditInput): void {
  if (selector.kind === "table") return;
  const via = selector.kind;
  if (input.key_fields !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `"key_fields" conflicts with "${via}" — key fields are derived from the resolved table, not supplied directly.`,
      { mode, field: "key_fields" },
    );
  }
  if (input.client_field !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `"client_field" conflicts with "${via}" — the client field is derived from the resolved table, not supplied directly.`,
      { mode, field: "client_field" },
    );
  }
}

/** Only "table"/"view"/"cluster" are writable (evaluateImgWrite rule 5) — everything else, including customizing_object, maps to "other" so that rule refuses it instead of the raw-table string heuristic silently misclassifying it. */
function mapPolicyTargetKind(kind: ImgObjectKind): "view" | "cluster" | "table" | "other" {
  switch (kind) {
    case "table":
      return "table";
    case "view":
      return "view";
    case "cluster":
      return "cluster";
    default:
      return "other";
  }
}

/**
 * Splits a resolved table's key fields into its client field (the CLNT-typed one) and the rest, in
 * position order — the shape `img-write-bridge.ts`'s plans require (it rejects `keyFields` that
 * still include the client field). Not "MANDT" by name: some tables (e.g. TB004) name their client
 * field something else entirely; what makes a field the client field is its DDIC data type, `CLNT`.
 */
function splitClientField(table: ResolvedTable, objectLabel: string): { clientField: string; keyFields: string[] } {
  const clientKeyField = table.keyFields.find((f) => f.dataType.trim().toUpperCase() === "CLNT");
  if (!clientKeyField) {
    if (!table.clientDependent) {
      throw new AbapError(
        "BAD_INPUT",
        `"${objectLabel}" resolves to base table ${table.table}, which is client-independent (no CLNT-typed ` +
          "key field) — this tool cannot write a client-independent table at all, through this path or the " +
          "table/key_fields/client_field expert escape hatch: the shared apply class refuses outright, before " +
          "touching any row, when the declared client field is not a component of the table — which a table " +
          "shaped this way never has. Maintain this table by hand (SM30/SM34) instead.",
        { table: table.table },
      );
    }
    throw new AbapError(
      "BAD_INPUT",
      `"${objectLabel}" resolves to base table ${table.table}, which DD02L marks client-dependent but whose ` +
        "key fields include no CLNT-typed field — this tool cannot tell which key field is the client field " +
        "from that data alone. Use the table/key_fields/client_field expert escape hatch instead.",
      { table: table.table },
    );
  }
  const clientField = clientKeyField.field;
  const keyFields = table.keyFields.filter((f) => f !== clientKeyField).map((f) => f.field);
  return { clientField, keyFields };
}

interface TableResolutionOk {
  readonly ok: true;
  readonly table: ResolvedTable;
  readonly objectName: string;
  readonly objectKind: ImgObjectKind;
  readonly statementsIssued: number;
  readonly durationMs: number;
}

interface TableResolutionAmbiguous {
  readonly ok: false;
  readonly ambiguity: string;
  readonly statementsIssued: number;
  readonly durationMs: number;
}

type TableOutcome = TableResolutionOk | TableResolutionAmbiguous;

/**
 * Resolves an `abap_img objects`-shaped identifier down to a single base table's real (DD03L-sourced)
 * key fields. Not-found throws `NOT_FOUND` directly; "resolved but not to exactly one table" (a
 * cluster, a transaction, or an object spanning several tables) comes back as an ambiguity outcome
 * rather than throwing, so the caller can route it through `evaluateImgWrite` rule 4 like any other
 * ambiguous-target refusal instead of a parallel error path.
 */
async function resolveTableFromObjectName(
  conn: ImgReadConnection,
  objectName: string,
  kind: ImgObjectKind | undefined,
  language: string,
): Promise<TableOutcome> {
  const result = await readImgObjects(conn, { mode: "objects", object: objectName, language, kind });
  const ro = resolveObject(result.transcript);
  if (!ro || ro.kind === "unknown") {
    throw new AbapError(
      "NOT_FOUND",
      `"${objectName}" did not resolve to a known maintenance view, view cluster, transaction, or table` +
        (kind ? ` of kind "${kind}"` : "") +
        ". Try abap_img objects or abap_img search to find the right name.",
      { object: objectName, kind },
    );
  }
  if (ro.tables.length === 0) {
    return {
      ok: false,
      ambiguity:
        `"${objectName}" resolved to a ${ro.kind} with no known base table for this reader to resolve — pass ` +
        "the underlying table or view name explicitly instead.",
      statementsIssued: result.statementsIssued,
      durationMs: result.durationMs,
    };
  }
  if (ro.tables.length > 1) {
    const names = ro.tables.map((t) => t.table).join(", ");
    return {
      ok: false,
      ambiguity: `"${objectName}" spans ${ro.tables.length} base tables — ${names} — a write must name one table explicitly.`,
      statementsIssued: result.statementsIssued,
      durationMs: result.durationMs,
    };
  }

  // Exactly one base table. Re-resolve it BY NAME as its own "table" object regardless of what kind
  // ro.kind actually was — this is the one call in this chain guaranteed to come from fillTable's
  // DD03L join, which is the only one of the five fillX helpers that returns real per-field
  // key/dataType data (fillView hardcodes key:false/dataType:"", fillCluster/fillTransaction never
  // resolve a table at all, so this step cannot be skipped even when ro.kind was already "table").
  const [onlyTable] = ro.tables;
  if (!onlyTable) {
    // Unreachable given the length===0/length>1 checks above, kept for type-safety under
    // noUncheckedIndexedAccess rather than an unchecked index.
    throw new AbapError("NOT_FOUND", `"${objectName}" resolved to no base table.`, { object: objectName });
  }
  const tableName = onlyTable.table;
  const tableResult = await readImgObjects(conn, { mode: "objects", object: tableName, language, kind: "table" });
  const tableObj = resolveObject(tableResult.transcript);
  const [resolvedTable] = tableObj?.tables ?? [];
  if (!tableObj || tableObj.kind === "unknown" || tableObj.tables.length !== 1 || !resolvedTable) {
    throw new AbapError(
      "NOT_FOUND",
      `"${objectName}" resolved to base table ${tableName}, but its key fields could not be read — no active ` +
        `DD03L rows for ${tableName}. Try abap_img objects to check the table name directly.`,
      { object: objectName, table: tableName },
    );
  }

  return {
    ok: true,
    table: resolvedTable,
    objectName: ro.name,
    objectKind: ro.kind,
    statementsIssued: result.statementsIssued + tableResult.statementsIssued,
    durationMs: result.durationMs + tableResult.durationMs,
  };
}

interface ActivityResolution {
  readonly activityTitle: string;
  readonly outcome: TableOutcome;
}

/**
 * Resolves an IMG activity down to a single object, then delegates to the same table-resolution core
 * the object path uses (see `resolveTableFromObjectName`'s doc comment) — `readImgShow`'s own
 * `tables`/`primaryTable` are real but carry no reliable object `kind`, so re-querying the resolved
 * object name through `readImgObjects` is what actually supplies one.
 */
async function resolveViaActivity(conn: ImgReadConnection, activity: string, language: string): Promise<ActivityResolution> {
  const showResult = await readImgShow(conn, { mode: "show", activity, language });
  const resolved = resolveActivity(showResult.transcript);

  if (resolved.objects.length === 0) {
    return {
      activityTitle: resolved.title,
      outcome: {
        ok: false,
        ambiguity:
          `IMG activity "${activity}" (title: "${resolved.title}") has no linked maintenance objects for this ` +
          "reader to resolve — pass the view or table name explicitly instead.",
        statementsIssued: showResult.statementsIssued,
        durationMs: showResult.durationMs,
      },
    };
  }

  if (resolved.ambiguity !== undefined) {
    return {
      activityTitle: resolved.title,
      outcome: {
        ok: false,
        ambiguity: resolved.ambiguity,
        statementsIssued: showResult.statementsIssued,
        durationMs: showResult.durationMs,
      },
    };
  }

  const primary = resolved.primary;
  if (!primary) {
    // Defensive only: resolveActivity's own invariants already guarantee primary is set whenever
    // objects.length === 1 and ambiguity is unset (the two cases handled above) — kept total rather
    // than assumed.
    return {
      activityTitle: resolved.title,
      outcome: {
        ok: false,
        ambiguity:
          `IMG activity "${activity}" (title: "${resolved.title}") did not resolve to a single maintenance ` +
          "object — pass the view or table name explicitly instead.",
        statementsIssued: showResult.statementsIssued,
        durationMs: showResult.durationMs,
      },
    };
  }

  const inner = await resolveTableFromObjectName(conn, primary.name, undefined, language);
  if (inner.ok) {
    return {
      activityTitle: resolved.title,
      outcome: {
        ok: true,
        table: inner.table,
        objectName: inner.objectName,
        objectKind: inner.objectKind,
        statementsIssued: inner.statementsIssued + showResult.statementsIssued,
        durationMs: inner.durationMs + showResult.durationMs,
      },
    };
  }
  return {
    activityTitle: resolved.title,
    outcome: {
      ok: false,
      ambiguity: inner.ambiguity,
      statementsIssued: inner.statementsIssued + showResult.statementsIssued,
      durationMs: inner.durationMs + showResult.durationMs,
    },
  };
}

function policyTableFromResolved(table: ResolvedTable, clientField: string): PolicyTable {
  const fields: PolicyField[] = table.fields
    .filter((f) => f.field.toUpperCase() !== clientField.toUpperCase())
    .map((f) => ({ field: f.field, dataType: f.dataType, key: f.key }));
  return {
    table: table.table,
    clientDependent: table.clientDependent,
    deliveryClass: table.deliveryClass,
    fields,
  };
}

// ---------------------------------------------------------------------------
// Two-phase policy evaluation
// ---------------------------------------------------------------------------

/**
 * Measured live 2026-09-06: with the startup probe suppressed (`ABAP_STARTUP_PROBE` off), the first
 * call of a fresh process being an `abap_img_edit` preview was refused with `SAFETY_DENIED` rule
 * `write-lockout`, even though writes were live on that system; a read call first cleared it.
 *
 * The mechanism: `ensureConnected()` (src/server.ts) is what transcribes the T000 role-probe verdict
 * into the gate via `safety.update({ writesLockedOut, ... })` — until some call has connected,
 * `safety.config.writesLockedOut` is `undefined`. `evaluateImgWrite` (img-write-policy.ts) refuses on
 * `writesLockedOut === true || === undefined` — fail-closed by design, and correct; this helper does
 * not change that. `abap_write` (src/tools/write.ts) already runs its zero-network `preflight()` and
 * only then `await deps.ensureConnected()`, so by the time it consults the gate the verdict exists.
 * `abap_img_edit`'s row-edit and create_request paths used to do the opposite: consult the gate before
 * ever connecting, so a cold process could never get past its very first call. This mirrors
 * `abap_write`'s ordering instead.
 *
 * Conditional, not unconditional: a process whose verdict is already known must still refuse without
 * paying for a logon it does not need. Called after input parsing/validation so a BAD_INPUT call still
 * costs no logon either.
 */
async function ensureRoleVerdict(deps: ImgEditToolDeps): Promise<void> {
  if (deps.safety.config.writesLockedOut === undefined) await deps.ensureConnected();
}

/**
 * Rules that never consult `probe.table`/`probe.cccoractiv` — see
 * `evaluateImgWrite`'s own rule ordering (img-write-policy.ts). Only a
 * refusal carrying one of these names is trustworthy from a table-less stub;
 * every other rule (delivery-class, cross-client, preview-deny-list,
 * key-field-type, cccoractiv, corr_nr/confirm) needs the real probe and
 * would otherwise misreport ("delivery class could not be determined") for
 * a table this call has not actually read yet.
 */
const SAFE_PRECHECK_RULES: ReadonlySet<string> = new Set([
  "productive-system",
  "write-lockout",
  "read-only",
  "ambiguous-target",
  "target-kind",
]);

/** Subset of SAFE_PRECHECK_RULES trustworthy from a stub with no table identity at all — the config-only gate the activity/object path runs BEFORE the resolution read is even issued. */
const CONFIG_ONLY_RULES: ReadonlySet<string> = new Set(["productive-system", "write-lockout", "read-only"]);

/** Shared "evaluate, throw if refused-and-in-ruleset" tail used by every preflight function below. */
function evaluateAgainstRules(
  rules: ReadonlySet<string>,
  probe: ImgWriteProbe,
  req: ImgWriteRequest,
  mode: "preview" | "upsert" | "delete",
  safety: SafetyGate,
): void {
  const verdict = evaluateImgWrite(probe, req, safety.config, { previewDenyExtra: safety.config.dataPreviewDenyTables });
  if (!verdict.allowed && rules.has(verdict.rule)) {
    throw new AbapError("SAFETY_DENIED", verdict.reason, { operation: mode, rule: verdict.rule, table: probe.table.table });
  }
}

/** No I/O: a config-only refusal (productive/lockout/read-only) is refused before any bridge is ever deployed. */
function preflightPolicyCheck(args: RowEditArgs, mode: "preview" | "upsert" | "delete", safety: SafetyGate): void {
  const stubTable: PolicyTable = { table: args.table, clientDependent: false, deliveryClass: "", fields: [] };
  const stubProbe: ImgWriteProbe = { table: stubTable, targetKind: targetKind(args.table, args.view) };
  const req: ImgWriteRequest = {
    mode,
    rows: policyRows(args.rows),
    corrNr: args.corrNr,
    confirm: args.confirm,
    allowCrossClient: args.allowCrossClient,
  };
  evaluateAgainstRules(SAFE_PRECHECK_RULES, stubProbe, req, mode, safety);
}

/**
 * Activity/object path only, before the resolution read is issued: no table identity exists yet, so
 * only a genuinely table-less config refusal (productive/lockout/read-only) is trustworthy.
 */
function preflightConfigOnly(mode: "preview" | "upsert" | "delete", safety: SafetyGate): void {
  const stubTable: PolicyTable = { table: "", clientDependent: false, deliveryClass: "", fields: [] };
  const stubProbe: ImgWriteProbe = { table: stubTable, targetKind: "table" };
  const req: ImgWriteRequest = { mode, rows: [] };
  evaluateAgainstRules(CONFIG_ONLY_RULES, stubProbe, req, mode, safety);
}

/**
 * Activity/object path only, after the resolution read comes back — called twice: once with an
 * "ambiguous-target" stub right after resolution reports ambiguity (expected to refuse via rule 4),
 * and once with the real resolved table right before the probe bridge is deployed (the raw-table
 * path's own `evaluateReal` does this same full-rule check, but post-probe; here the resolved table
 * is already known, so it happens pre-probe instead).
 */
function preflightResolved(
  mode: "preview" | "upsert" | "delete",
  safety: SafetyGate,
  table: PolicyTable,
  targetKind: "view" | "cluster" | "table" | "other",
  ambiguity: string | undefined,
  rows: readonly { key: Record<string, string>; values?: Record<string, string> }[],
  corrNr: string | undefined,
  confirm: string | undefined,
  allowCrossClient: boolean,
): void {
  const probe: ImgWriteProbe = { table, targetKind, ambiguity };
  const req: ImgWriteRequest = { mode, rows: policyRows(rows), corrNr, confirm, allowCrossClient };
  evaluateAgainstRules(SAFE_PRECHECK_RULES, probe, req, mode, safety);
}

function policyTableFromProbe(args: RowEditArgs, probe: ImgProbeResult): PolicyTable {
  const t = probe.transcript.table;
  const fields: PolicyField[] = probe.transcript.fields
    .filter((f) => f.field.toUpperCase() !== args.clientField.toUpperCase())
    .map((f) => ({ field: f.field, dataType: f.dataType, key: f.key }));
  return {
    // The bridge's TABLE transcript line does NOT come from a DDIC read: img-write-bridge.ts emits
    // `TABLE table=[${tableLower}] ...` where tableLower is the generation-time TypeScript constant
    // we built the bridge source with — it is always our own lower-cased spelling of args.table, never
    // whatever case DD02L happens to hold (only delclass/clidep on that line are server-read values).
    // Upper-case it here at the render boundary purely to match how SAP itself spells table names in
    // DD02L, so preview/armed headers and the descriptive transport-entry line show that spelling
    // regardless of what case the caller happened to type — this is cosmetic, not a correctness fix.
    table: (t?.table ?? args.table).trim().toUpperCase(),
    clientDependent: t?.clientDependent ?? false,
    deliveryClass: t?.deliveryClass ?? "",
    fields,
  };
}

function evaluateReal(
  args: RowEditArgs,
  mode: "preview" | "upsert" | "delete",
  probe: ImgProbeResult,
  safety: SafetyGate,
) {
  const realProbe: ImgWriteProbe = {
    table: policyTableFromProbe(args, probe),
    targetKind: resolvedPolicyTargetKind(args),
    cccoractiv: probe.transcript.client?.cccoractiv,
  };
  const req: ImgWriteRequest = {
    mode,
    rows: policyRows(args.rows),
    corrNr: args.corrNr,
    confirm: args.confirm,
    allowCrossClient: args.allowCrossClient,
  };
  const verdict = evaluateImgWrite(realProbe, req, safety.config, {
    previewDenyExtra: safety.config.dataPreviewDenyTables,
  });
  if (!verdict.allowed) {
    throw new AbapError("SAFETY_DENIED", verdict.reason, { operation: mode, rule: verdict.rule, table: args.table });
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// Check-metadata disclosure (CHECKS NOT RUN)
// ---------------------------------------------------------------------------

/**
 * Either the real read result, or a short reason it could not be produced —
 * see `readChecksSafely`. Kept as a plain union (not an `undefined`) so
 * `checksSection`/`checksNotesFor` have one value to switch on instead of
 * two independent optionals that could disagree.
 */
type ChecksOutcome = ImgChecksResult | { readonly failure: string };

/**
 * Reads what SM30 would have run for this write — maintenance event
 * routines (TVIMF), check tables, and domain fixed-value violations — purely
 * so `preview`/the armed response can disclose it (issue #62: this tool
 * writes the base table directly and none of that check logic ever runs).
 *
 * This is a diagnostic side-read, not part of the write path: every error it
 * can raise (a network hiccup, a bridge failure, a parse error in
 * `readImgChecks` itself) is caught here and turned into a short failure
 * reason string instead of being thrown. Write semantics for rows that pass
 * today must not change (issue #62 is explicit about this) — a broken
 * check-metadata read must never prevent a preview from rendering or an
 * armed upsert/delete from proceeding.
 */
async function readChecksSafely(
  deps: ImgEditToolDeps,
  args: RowEditArgs,
  mode: "preview" | "upsert" | "delete",
): Promise<ChecksOutcome> {
  try {
    return await deps.pool.withRead("abap_img_edit", (conn) =>
      readImgChecks(conn, {
        table: args.table,
        view: args.view,
        clientField: args.clientField,
        language: args.language,
        checkValues: mode !== "delete",
        rows: args.rows,
      }),
    );
  } catch (e) {
    return { failure: truncateText((e as Error).message, MESSAGE_EXCERPT_MAX) };
  }
}

/**
 * Content for the "CHECKS NOT RUN" section — one function `renderPreview`
 * and `renderArmed` both call, so the two paths can never render this
 * disclosure differently (same reasoning as `requestedChangeCell` above).
 */
function checksSection(checks: ChecksOutcome): string {
  const parts: string[] = [
    "This tool writes the base table directly. The maintenance dialog's own check logic does not run — " +
      "below is what SM30 would have run for this data.",
  ];

  if ("failure" in checks) {
    parts.push(
      `The check metadata could not be read (${checks.failure}), so nothing can be said about which checks SM30 would have run.`,
    );
    return parts.join("\n\n");
  }

  const blocks: string[] = [];

  if (checks.events.length) {
    const rows = checks.events.map((e) => ({ view: e.view, event: e.event, when: e.description, routine: e.formName }));
    blocks.push(
      "Maintenance event routines registered in TVIMF (SM30 calls these; this tool does not):\n" +
        textTable(rows, ["view", "event", "when", "routine"]),
    );
  }

  if (checks.checkTables.length) {
    const rows = checks.checkTables.map((c) => ({ field: c.field, check_table: c.checkTable }));
    blocks.push(
      "Check tables for the fields this call writes (foreign keys not verified):\n" +
        textTable(rows, ["field", "check_table"]),
    );
  }

  if (checks.fixedValueFindings.length) {
    const rows = checks.fixedValueFindings.map((f) => ({
      field: f.field,
      domain: f.domain,
      value: f.value === "" ? "''" : f.value,
      allowed: f.allowed.join(", "),
    }));
    blocks.push(
      "Written values that are not fixed values of their domain:\n" + textTable(rows, ["field", "domain", "value", "allowed"]),
    );
  }

  if (blocks.length === 0) {
    parts.push(
      "No maintenance event routines, check tables or domain fixed values were found for the fields this call writes — only DDIC typing was enforced here.",
    );
  } else {
    parts.push(...blocks);
  }

  // Folded in here rather than into the response `notes` list too — see the module's CHECKS NOT RUN
  // contract: one place for the read's own notes, not two that could drift.
  if (checks.notes.length) {
    parts.push(`Notes from the check-metadata read:\n${checks.notes.join("\n")}`);
  }

  return parts.join("\n\n");
}

/**
 * The response `notes` entries this same read contributes, restated as flat
 * notes (distinct from `checksSection`'s tables) so a caller that only reads
 * `notes` still sees the two highest-signal findings — a fixed-value
 * violation SM30 would have rejected outright, and a maintenance event
 * routine that silently does not run. Empty when the read failed (that case
 * is disclosed only in the CHECKS NOT RUN section, see `checksSection`) or
 * found nothing.
 */
function checksNotesFor(checks: ChecksOutcome): string[] {
  if ("failure" in checks) return [];
  const notes: string[] = [];
  for (const f of checks.fixedValueFindings) {
    notes.push(
      `Field ${f.field}: value "${f.value}" is not one of domain ${f.domain}'s fixed values (${f.allowed.join(", ")}). ` +
        "SM30 would have rejected this input; this tool does not.",
    );
  }
  if (checks.events.length) {
    const formNames = checks.events.map((e) => e.formName);
    const shownNames = formNames.length > 5 ? [...formNames.slice(0, 5), "..."] : formNames;
    // Not `checks.views` — that is every name the TVIMF lookup covered, including names that
    // turned out to have no events at all. Name only the views that actually appear in
    // `checks.events`, so this note never implies a routine exists for a view that has none.
    const viewsWithEvents = [...new Set(checks.events.map((e) => e.view))];
    notes.push(
      `${checks.events.length} maintenance event routine(s) registered for ${viewsWithEvents.join(", ")} will not run: ` +
        `${shownNames.join(", ")}. See CHECKS NOT RUN.`,
    );
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function groupByRow(values: readonly ImgWriteValueRow[]): Map<number, Record<string, string>> {
  const out = new Map<number, Record<string, string>>();
  for (const v of values) {
    const row = out.get(v.row) ?? {};
    row[v.field] = v.value;
    out.set(v.row, row);
  }
  return out;
}

function currentRowsTable(args: RowEditArgs, probe: ImgProbeResult): string {
  const t = probe.transcript;
  const present = groupByRow(t.before);
  const absent = new Set(t.beforeAbsent.map((a) => a.row));
  // Transcript row numbers are 1-based (`rowNo = i + 1` in img-write-bridge.ts); displayed here
  // 0-based to match the caller's own rows[] index — the same index PROSPECTIVE CHANGE labels the
  // row with, so a preview never shows the same row under two different numbers in one response.
  const rows = args.rows.map((_, i) => {
    const rowNo = i + 1;
    if (absent.has(rowNo)) return { row: String(i), status: "does not exist yet", fields: "" };
    const fields = present.get(rowNo);
    if (!fields) return { row: String(i), status: "unknown (no probe data for this row)", fields: "" };
    return {
      row: String(i),
      status: "exists",
      fields: Object.entries(fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(", "),
    };
  });
  return rows.length ? textTable(rows, ["row", "status", "fields"]) : "(no rows probed)";
}

/**
 * The requested-change text for one row — factored out so preview's own table and the armed
 * upsert echo (`armedUpsertRowsTable`) can never drift apart on how a key-only row is worded.
 */
function requestedChangeCell(mode: "upsert" | "delete", r: RowEditArgs["rows"][number]): string {
  if (mode === "delete") return "DELETE this row";
  const values = Object.entries(r.values ?? {});
  // A row naming zero value fields is a legal upsert (see validateApplyPlan,
  // img-write-bridge.ts) — say what it actually does rather than rendering a dangling
  // empty "SET ".
  return values.length
    ? `SET ${values.map(([k, v]) => `${k}=${v}`).join(", ")}`
    : "key-only row (no value fields); insert if absent, otherwise no change";
}

function rowKeyCell(r: RowEditArgs["rows"][number]): string {
  return Object.entries(r.key)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

function prospectiveRowsTable(mode: "upsert" | "delete", args: RowEditArgs): string {
  const rows = args.rows.map((r, i) => ({
    row: String(i),
    key: rowKeyCell(r),
    change: requestedChangeCell(mode, r),
  }));
  return textTable(rows, ["row", "key", "change"]);
}

/** Renders what activity/object resolved to, ahead of everything else — the caller may be seeing the base table for the first time. */
function renderResolvedSection(r: ResolutionSummary, args: RowEditArgs): string {
  const lines: string[] = [];
  lines.push(`Input: ${r.selector} "${r.identifier}"${r.activityTitle ? ` (title: "${r.activityTitle}")` : ""}`);
  lines.push(`Object: ${r.objectName} (${r.objectKind})`);
  lines.push(`Base table: ${args.table}`);
  lines.push(`Key fields (in order): ${args.keyFields.length ? args.keyFields.join(", ") : "(none)"}`);
  lines.push(`Client field: ${args.clientField}`);
  lines.push(`Resolution reads: ${r.statementsIssued} statement(s), ${r.durationMs}ms.`);
  return lines.join("\n");
}

/** Descriptive only — a real TABKEY value is never computed here. See the module doc comment on why `preview` cannot show one. */
function transportEntryPreview(args: RowEditArgs, table: PolicyTable): string {
  return (
    `An armed upsert/delete would record ${args.rows.length} row(s) on transport object ` +
    `TABU ${table.table}, master ${args.masterType} ${args.view}. The actual E071K TABKEY value is ` +
    "computed server-side at apply time (see img-write-bridge.ts's ctsRecordFragment) and is not " +
    "reproduced here — this line only names what kind of entry would be filed, not its bytes."
  );
}

function renderPreview(
  args: RowEditArgs,
  probe: ImgProbeResult,
  notes: readonly string[],
  checks: ChecksOutcome,
  maxChars: number,
): string {
  const table = policyTableFromProbe(args, probe);
  // Nothing has been written yet for a preview to disclose a bypass of — see the module doc comment.
  // The CHECKS NOT RUN section below says the same thing concretely (which specific checks would not
  // have run), so keeping SM30_BYPASS_NOTE filtered out here avoids naming that same fact twice.
  const filteredNotes = notes.filter((n) => n !== SM30_BYPASS_NOTE);
  const t = probe.transcript;
  if (t.errors.length) filteredNotes.push(`The bridge reported ${t.errors.length} error line(s): ${t.errors.join("; ")}`);
  if (t.droppedLines) filteredNotes.push(`${t.droppedLines} transcript line(s) were not recognised by the parser.`);
  filteredNotes.push(...checksNotesFor(checks));

  const sections = [
    { title: "CURRENT ROWS", content: currentRowsTable(args, probe) },
    { title: "CHECKS NOT RUN", content: checksSection(checks) },
    { title: "TRANSPORT ENTRY (DESCRIPTIVE ONLY)", content: transportEntryPreview(args, table) },
  ];
  if (args.resolution) sections.unshift({ title: "RESOLVED", content: renderResolvedSection(args.resolution, args) });

  return buildResponse({
    header: {
      mode: "preview",
      table: table.table,
      language: args.language,
      view: args.view,
      masterType: args.masterType,
      deliveryClass: table.deliveryClass,
      clientDependent: table.clientDependent,
      bridgeClass: probe.bridgeClass,
      bridgeRefreshed: probe.bridgeRefreshed,
    },
    sections,
    body: prospectiveRowsTable("upsert", { ...args }),
    bodyLabel: "PROSPECTIVE CHANGE",
    notes: filteredNotes,
    maxChars,
  }).text;
}

function sameFieldMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

interface RowChangeSummary {
  changed: "yes" | "no" | "unknown";
  description: string;
}

/**
 * Measures what an armed upsert actually did to each row, from the apply transcript's
 * before/after images — never assumed from the caller's own input. Transcript row numbers are
 * 1-based (`lv_ri + 1` in the `apply` action's generated ABAP, src/adt/fluid/builtin/img.ts) while
 * `args.rows`/the rendered table are 0-based, so row `i` here is looked up as transcript row `i + 1`.
 */
function rowChangeSummaries(rows: RowEditArgs["rows"], t: ImgApplyResult["transcript"]): RowChangeSummary[] {
  const beforePresent = groupByRow(t.before);
  const beforeAbsent = new Set(t.beforeAbsent.map((a) => a.row));
  const afterPresent = groupByRow(t.after);
  const afterAbsent = new Set(t.afterAbsent.map((a) => a.row));

  return rows.map((r, i) => {
    const rowNo = i + 1;
    const wasAbsent = beforeAbsent.has(rowNo);
    const wasPresent = beforePresent.has(rowNo);
    const isAbsentAfter = afterAbsent.has(rowNo);
    const isPresentAfter = afterPresent.has(rowNo);

    if (!isAbsentAfter && !isPresentAfter) {
      // The transcript said nothing about this row's after-image (e.g. truncated output) —
      // never guess what happened.
      return { changed: "unknown", description: "no after-image reported for this row" };
    }
    if (wasAbsent && isPresentAfter) {
      return { changed: "yes", description: "inserted" };
    }
    if (wasPresent && isPresentAfter) {
      const same = sameFieldMap(beforePresent.get(rowNo) ?? {}, afterPresent.get(rowNo) ?? {});
      if (same) {
        const keyOnly = Object.keys(r.values ?? {}).length === 0;
        return { changed: "no", description: keyOnly ? "row exists, no value fields to write" : "no change" };
      }
      return { changed: "yes", description: "updated" };
    }
    // Any other before/after combination (e.g. present before, absent after, on an upsert row)
    // should never happen — reported rather than silently misclassified.
    return { changed: "unknown", description: "before/after image combination not recognised" };
  });
}

/** What {@link applyFailure} found wrong with an apply, and how sure it can be that nothing ran. */
interface ApplyFailure {
  reasons: string[];
  mayHaveExecuted: boolean;
}

/**
 * Whether an armed apply is fully accounted for — every row's after-image is present, every
 * upsert row's change is classified (never `"unknown"`), every delete row is actually gone, the
 * bridge raised no runtime exception, and the commit was observed. Returns `undefined` when all
 * of that holds; otherwise every applicable reason (not just the first) plus a conservative
 * `mayHaveExecuted`.
 *
 * `rowChangeSummaries` is written for upsert: a normal, SUCCESSFUL delete row (present before,
 * absent after) is exactly the "before/after image combination not recognised" fallback it
 * reports as `"unknown"`, because that combination never legitimately arises on an upsert. Calling
 * it for delete rows would therefore make every successful delete throw — so it is only called
 * here for `mode === "upsert"`; delete rows are checked directly against `transcript.after`
 * instead (still present after a delete is the only delete-specific failure).
 */
function applyFailure(mode: "upsert" | "delete", rows: RowEditArgs["rows"], apply: ImgApplyResult): ApplyFailure | undefined {
  const t = apply.transcript;
  const reasons: string[] = [...t.errors];

  if (t.applied === null) {
    reasons.push("the bridge never reported APPLIED — the commit was never observed");
  }

  const afterPresent = groupByRow(t.after);
  const afterAbsentSet = new Set(t.afterAbsent.map((a) => a.row));
  // Only valid for upsert — see the doc comment above.
  const upsertSummaries = mode === "upsert" ? rowChangeSummaries(rows, t) : undefined;

  rows.forEach((_, i) => {
    const rowNo = i + 1;
    const hasAfterImage = afterPresent.has(rowNo) || afterAbsentSet.has(rowNo);
    if (!hasAfterImage) {
      reasons.push(`row ${i}: no after-image reported for this row (transcript row ${rowNo})`);
      return;
    }
    if (mode === "upsert") {
      const summary = upsertSummaries![i]!;
      if (summary.changed === "unknown") reasons.push(`row ${i}: ${summary.description}`);
    } else if (afterPresent.has(rowNo)) {
      reasons.push(`row ${i}: still present in the table after a delete (transcript row ${rowNo})`);
    }
  });

  if (reasons.length === 0) return undefined;

  // Conservative, decided only from transcript markers, never from the request: a WROTE marker
  // means that row's MODIFY/DELETE returned sy-subrc 0, and an after-image or APPLIED marker is
  // only reached after COMMIT WORK AND WAIT — but the ABAP method can also end without an
  // explicit commit, and the dialog step's own implicit commit may still persist a write that
  // already ran. `false` therefore means no transcript marker shows that any row write even
  // started — it is NOT proof that the system is unchanged.
  const mayHaveExecuted = t.wrote.length > 0 || t.applied !== null || t.after.length > 0 || t.afterAbsent.length > 0;

  return { reasons, mayHaveExecuted };
}

/**
 * The message for the `CHECK_FAILED` thrown when an armed upsert/delete apply cannot be fully
 * accounted for (see `applyFailure`). Never claims the system is unchanged — only what transcript
 * markers do or do not show.
 */
function applyFailureMessage(
  mode: "upsert" | "delete",
  args: RowEditArgs,
  apply: ImgApplyResult,
  failure: ApplyFailure,
  journalNote: string | undefined,
): string {
  const t = apply.transcript;
  const parts: string[] = [`The ${mode} on table ${args.table} could not be confirmed.`];
  if (t.errors.length) parts.push(`The bridge reported: ${t.errors.join("; ")}.`);
  const otherReasons = failure.reasons.filter((r) => !t.errors.includes(r));
  if (otherReasons.length) parts.push(`${otherReasons.join("; ")}.`);
  if (journalNote) parts.push(journalNote);
  parts.push(
    failure.mayHaveExecuted
      ? "The write may already have executed and committed — re-read the rows with abap_data_preview before retrying."
      : "No transcript marker shows that any row write started, but the rows should still be re-read with abap_data_preview before a retry.",
  );
  return parts.join(" ");
}

function armedUpsertRowsTable(args: RowEditArgs, apply: ImgApplyResult): string {
  const summaries = rowChangeSummaries(args.rows, apply.transcript);
  const rows = args.rows.map((r, i) => ({
    row: String(i),
    key: rowKeyCell(r),
    // What was requested — the same wording prospectiveRowsTable would have shown in preview for
    // this row (key-only wording included), so the armed response never just says what happened
    // without also saying what was asked for.
    change: requestedChangeCell("upsert", r),
    changed: summaries[i]!.changed,
    result: summaries[i]!.description,
  }));
  return textTable(rows, ["row", "key", "change", "changed", "result"]);
}

/**
 * Delete-side counterpart of `rowChangeSummaries`, measuring what an armed delete actually did to
 * each row from the apply transcript's before/after images. Kept separate from
 * `rowChangeSummaries` rather than folding delete in as another mode: `applyFailure`'s own doc
 * comment establishes that a normal, SUCCESSFUL delete row (present before, absent after) is
 * exactly the combination `rowChangeSummaries` classifies as `"unknown"` (its "before/after image
 * combination not recognised" fallback, legitimate only for delete) — re-parameterising that
 * function to also accept delete rows would make every successful delete throw. Transcript row
 * numbers are 1-based, `args.rows`/the rendered table are 0-based — same convention as
 * `rowChangeSummaries`/`armedUpsertRowsTable`.
 *
 * Fixes the live defect where an armed delete of a row that does not exist rendered a
 * `ROWS DELETED` body with no `changed`/`result` column at all (just the row/key/change echo of
 * what was requested), which a caller could only read as "the row was deleted".
 */
function rowDeleteSummaries(rows: RowEditArgs["rows"], t: ImgApplyResult["transcript"]): RowChangeSummary[] {
  const beforePresent = groupByRow(t.before);
  const afterPresent = groupByRow(t.after);
  const afterAbsent = new Set(t.afterAbsent.map((a) => a.row));

  return rows.map((_, i) => {
    const rowNo = i + 1;
    const isPresentAfter = afterPresent.has(rowNo);
    const isAbsentAfter = afterAbsent.has(rowNo);

    if (isPresentAfter) {
      // Unreachable in a successful response: `applyFailure` (mode === "delete") treats a row
      // still present after a delete as a failure reason and throws CHECK_FAILED before
      // `renderArmed` is ever called. Kept so this renderer itself can never silently misreport
      // the row as deleted when the transcript says otherwise.
      return { changed: "unknown", description: "still present in the table after the delete" };
    }
    if (!isAbsentAfter) {
      // Also unreachable in a successful response, for the same reason: `applyFailure` treats a
      // missing after-image as a failure reason (checked before the mode split, so it applies to
      // delete too) and throws before rendering.
      return { changed: "unknown", description: "no after-image reported for this row" };
    }
    // From here the row is confirmed absent after the delete — the only question is whether it was
    // ever there to begin with. The `apply` action's before-image SELECT (see its delete branch,
    // src/adt/fluid/builtin/img.ts) always emits exactly one of BVAL/BABSENT for a row it reaches
    // this far for, so `beforePresent` is the only marker checked; anything not confirmed present
    // is reported as the "nothing to delete" case rather than guessed as a deletion.
    if (beforePresent.has(rowNo)) return { changed: "yes", description: "deleted" };
    return { changed: "no", description: "absent (nothing to delete)" };
  });
}

function armedDeleteRowsTable(args: RowEditArgs, apply: ImgApplyResult): string {
  const summaries = rowDeleteSummaries(args.rows, apply.transcript);
  const rows = args.rows.map((r, i) => ({
    row: String(i),
    key: rowKeyCell(r),
    // Same reasoning as armedUpsertRowsTable: what was requested is shown alongside what happened.
    change: requestedChangeCell("delete", r),
    changed: summaries[i]!.changed,
    result: summaries[i]!.description,
  }));
  return textTable(rows, ["row", "key", "change", "changed", "result"]);
}

function renderArmed(
  mode: "upsert" | "delete",
  args: RowEditArgs,
  apply: ImgApplyResult,
  notes: readonly string[],
  checks: ChecksOutcome,
  journalNote: string | undefined,
  maxChars: number,
): string {
  const t = apply.transcript;
  const finalNotes = [...notes];
  if (journalNote) finalNotes.push(journalNote);
  if (t.errors.length) finalNotes.push(`The bridge reported ${t.errors.length} error line(s): ${t.errors.join("; ")}`);
  if (t.droppedLines) finalNotes.push(`${t.droppedLines} transcript line(s) were not recognised by the parser.`);
  finalNotes.push(...checksNotesFor(checks));

  // Live defect fixed here: an armed delete of a row that does not exist used to render
  // `[ok] applied: N` with nothing telling the caller that nothing was actually deleted — the
  // header's `applied` only ever means "the bridge processed N rows", not "N rows changed". Name
  // every absent row explicitly so a caller cannot read `applied: N` as a changed-row count.
  if (mode === "delete") {
    const deleteSummaries = rowDeleteSummaries(args.rows, t);
    const absentRows = deleteSummaries.reduce<number[]>((acc, s, i) => {
      if (s.changed === "no") acc.push(i);
      return acc;
    }, []);
    if (absentRows.length) {
      finalNotes.push(
        `Row(s) ${absentRows.join(", ")} did not exist before this call — nothing was deleted for ` +
          "them and no transport entry was recorded for them. The header's `applied` count above " +
          "is the number of rows the bridge processed, not the number of rows actually changed.",
      );
    }
  }

  // The CTS identity fields (pgmid/object/objname/mastertype/mastername) are NOT carried by the
  // IMGW> TRKEY transcript line — they are the generator's own inputs (see ctsRecordFragment in
  // img-write-bridge.ts: PGMID/OBJECT are fixed constants 'R3TR'/'TABU', OBJNAME/MASTERTYPE/
  // MASTERNAME are args.table/args.masterType/args.view baked into the generated ABAP before the
  // apply ever runs), so they are read from args here, not parsed out of the transcript. They are
  // constant across every row of one call, so they are rendered once, above the per-row table,
  // rather than repeated in every row.
  const CTS_PGMID = "R3TR";
  const CTS_OBJECT = "TABU";
  const identityLine =
    `${CTS_PGMID} ${CTS_OBJECT} ${args.table.toUpperCase()} ` +
    `(master ${args.masterType} ${args.view.toUpperCase()})`;

  // The generated ABAP stores TABKEY as `sy-mandt` (client) followed by the cast key
  // (`ls_e071k-tabkey = |{ sy-mandt }{ <key_c> }|`), but the IMGW> TRKEY line's own
  // `value=[{ <key_c> }]` is the key WITHOUT the client prefix — so the client has to be sourced
  // separately, from the IMGW> CLIENT line (`t.client?.mandt`), to reconstruct what was actually
  // stored. When no CLIENT line was parsed, the client prefix is not fabricated — the key portion
  // is shown alone and callers are told, via a note, that it is unprefixed.
  const mandt = t.client?.mandt;
  const trkeyRows = t.trkeys.map((k) => ({
    row: String(k.row),
    tabkey: mandt !== undefined ? `${mandt}${k.value}` : k.value,
    trkorr: k.trkorr,
    recorded_order: k.recordedOrder ?? "",
    recorded_task: k.recordedTask ?? "",
  }));
  if (trkeyRows.length && mandt === undefined) {
    finalNotes.push(
      "The transport entry's tabkey below is the key portion only (no IMGW> CLIENT line was parsed to supply the client prefix SAP actually stored).",
    );
  }

  const sections: { title: string; content: string }[] = trkeyRows.length
    ? [
        {
          title: "TRANSPORT ENTRY RECORDED",
          content: `${identityLine}\n${textTable(trkeyRows, ["row", "tabkey", "trkorr", "recorded_order", "recorded_task"])}`,
        },
      ]
    : [];
  if (args.resolution) sections.unshift({ title: "RESOLVED", content: renderResolvedSection(args.resolution, args) });
  // Last, after RESOLVED/TRANSPORT ENTRY RECORDED — same disclosure preview shows, restated for
  // what was actually written rather than what was prospective.
  sections.push({ title: "CHECKS NOT RUN", content: checksSection(checks) });

  return buildResponse({
    header: {
      mode,
      table: args.table,
      language: args.language,
      view: args.view,
      masterType: args.masterType,
      corrNr: args.corrNr,
      applied: t.applied ?? undefined,
      bridgeClass: apply.bridgeClass,
      bridgeRefreshed: apply.bridgeRefreshed,
    },
    sections: sections.length ? sections : undefined,
    body: mode === "delete" ? armedDeleteRowsTable(args, apply) : armedUpsertRowsTable(args, apply),
    bodyLabel: mode === "delete" ? "ROWS DELETED" : "ROWS WRITTEN",
    notes: finalNotes,
    maxChars,
  }).text;
}

/**
 * The message for the `CHECK_FAILED` thrown when a `create_request` call
 * cannot be confirmed: the FM this bridge calls creates the request before
 * this code can observe any failure, so a bad transcript does NOT mean
 * nothing happened — it means this server cannot say what happened, which
 * is worse.
 */
function createRequestFailureMessage(t: CustomizingRequestTranscript, description: string): string {
  const bridgeLines = t.errors.length
    ? t.errors.join("; ")
    : "no request number was parsed from the bridge transcript, and no error line was reported either";
  return (
    `The customizing request could not be confirmed — the bridge reported: ${bridgeLines}. ` +
    "A customizing request may nonetheless have been created in the system: " +
    "TR_INSERT_REQUEST_WITH_TASKS creates the request before this code can observe the failure. " +
    "Check for it with `abap_transport list` (customizing section), matched on the description " +
    `${JSON.stringify(description)}. If one is found and is not wanted, delete it.`
  );
}

/**
 * Reached only when `runCreateRequestMode` did NOT throw — i.e. a request
 * number was parsed and the transcript carried no error line. The
 * `!t.request` note and body below, and the `t.request ?? "(unknown)"`
 * fallback in the `NO_TASK` note, are defensive only and not exercised on
 * that path.
 */
function renderCreateRequest(plan: CustomizingRequestPlan, result: Awaited<ReturnType<typeof runCreateCustomizingRequest>>, maxChars: number): string {
  const t = result.transcript;
  const notes: string[] = [];
  if (t.errors.length) notes.push(`The bridge reported ${t.errors.length} error line(s): ${t.errors.join("; ")}`);
  if (!t.request) notes.push("No request number was parsed from the transcript — see errors above, if any.");
  const warnings = t.warnings;
  if (warnings.length) {
    notes.push(`The bridge reported ${warnings.length} warning(s): ${warnings.join("; ")}.`);
    if (warnings.some((w) => w.startsWith("NO_TASK"))) {
      notes.push(
        `NO_TASK: request ${t.request ?? "(unknown)"} was created with no task under it; its number is what ` +
          "would be passed as corr_nr. Whether a task-less request accepts recorded rows has not been " +
          "established from here. Add a task to it yourself, or delete the request.",
      );
    }
  }
  return buildResponse({
    header: {
      mode: "create_request",
      description: plan.description,
      owner: plan.owner,
      request: t.request,
      task: t.task,
      taskType: t.taskType,
      bridgeClass: result.bridgeClass,
      bridgeRefreshed: result.bridgeRefreshed,
    },
    body: t.request
      ? `Request ${t.request}${t.task ? ` (task ${t.task}${t.taskType ? `, type ${t.taskType}` : ""})` : ""} created.`
      : "Request could not be confirmed — see notes.",
    bodyLabel: "RESULT",
    notes,
    maxChars,
  }).text;
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

/**
 * `JournalOperation` has no img-write-specific variant (src/journal.ts) — an
 * IMG row `upsert` reuses `"update"`, `delete` reuses `"delete"` verbatim.
 * Both describe the same shape of change (an existing/absent row's content
 * changing), so no new union member is minted for this one caller.
 */
function journalOperationFor(mode: "upsert" | "delete"): JournalOperation {
  return mode === "upsert" ? "update" : "delete";
}

interface RowBeforeImage {
  existedBefore: boolean;
  beforeCapture: BeforeImageCapture;
  beforeSource?: string;
}

/** Built from the PROBE transcript (before any apply) — the only point a before-image can be captured. */
function beforeImageFor(args: RowEditArgs, probe: ImgProbeResult): RowBeforeImage {
  const t = probe.transcript;
  const totalRows = args.rows.length;
  if (t.beforeAbsent.length === totalRows && t.before.length === 0) {
    return { existedBefore: false, beforeCapture: "confirmed-absent" };
  }
  const present = groupByRow(t.before);
  const absent = new Set(t.beforeAbsent.map((a) => a.row));
  if (present.size === 0 && absent.size === 0) {
    // The probe transcript said nothing about any row — a scaffold-level gap, not proof of absence.
    return { existedBefore: false, beforeCapture: "unknown" };
  }
  // Transcript row numbers are 1-based (`rowNo = i + 1` in img-write-bridge.ts); the journal's own
  // `row` field stays 0-based to match the caller's rows[] index — the same convention BAD_INPUT's
  // `details.row` uses. Only the lookup into the transcript's before-image maps is renumbered; what
  // is written to the journal is not.
  const snapshot = Array.from({ length: totalRows }, (_, row) => {
    const rowNo = row + 1;
    return absent.has(rowNo) ? { row, existed: false } : { row, existed: true, values: present.get(rowNo) ?? {} };
  });
  return { existedBefore: true, beforeCapture: "captured", beforeSource: JSON.stringify({ table: args.table, rows: snapshot }) };
}

function afterSourceFor(apply: ImgApplyResult): string {
  const t = apply.transcript;
  const after = groupByRow(t.after);
  const afterAbsent = t.afterAbsent.map((a) => a.row);
  return JSON.stringify({ after: Object.fromEntries(after), afterAbsent, trkeys: t.trkeys });
}

/**
 * Journal a mutation that has ALREADY happened: `begin()` then `settle()`,
 * mirroring `src/tools/transport.ts`'s own `recordMutation`/`beginInput`/
 * `settleEntry` post-hoc idiom exactly — the apply already ran on the wire
 * by the time this is called, so failing the tool call now would report a
 * failure for a mutation that is real. Never throws.
 */
async function recordRowMutation(
  deps: ImgEditToolDeps,
  mode: "upsert" | "delete",
  args: RowEditArgs,
  probe: ImgProbeResult,
  apply: ImgApplyResult,
  failure: ApplyFailure | undefined,
): Promise<string | undefined> {
  const warn = deps.warn ?? ((m: string) => void process.stderr.write(`${m}\n`));
  const before = beforeImageFor(args, probe);
  const object: JournalObjectRef = {
    name: args.table,
    // TABU: the real CTS object type for table-content/customizing entries — informational here,
    // not itself asserted to be what a live TR_OBJECTS_INSERT call would record (see CTS_INSERT_FM).
    type: "TABU",
    // No ADT resource exists for a raw table row write — same convention as src/tools/ui.ts's own synthetic refs.
    uri: "",
    package: "",
    description: `${mode} ${args.rows.length} row(s) via ${args.view} (${args.masterType})`,
  };
  const beginInput: JournalBeginInput = {
    operation: journalOperationFor(mode),
    object,
    existedBefore: before.existedBefore,
    beforeCapture: before.beforeCapture,
    ...(before.beforeSource !== undefined ? { beforeSource: before.beforeSource } : {}),
    // No generic undo exists for a raw table MODIFY/DELETE that bypasses the view's own event modules.
    irreversible: true,
    systemKey: systemKey({ sid: deps.cfg.sid, url: deps.cfg.url, client: deps.cfg.client }),
    ...(args.corrNr !== undefined ? { corrNr: args.corrNr } : {}),
    trSource: "caller",
    tool: "abap_img_edit",
  };

  let entry: JournalEntry | undefined;
  try {
    entry = await deps.journal.begin(beginInput);
  } catch (e) {
    warn(`[abapsmith] WARNING: ${args.table} — the ${mode} DID happen but could NOT be journalled: ${(e as Error).message}.`);
    return undefined;
  }
  if (!entry) return undefined; // journal disabled — nothing was ever going to be written

  // Failed whenever applyFailure found anything unaccounted for, not only when the bridge itself
  // raised an error line — failure.reasons always includes transcript.errors verbatim (see
  // applyFailure), so this subsumes the old "t.errors.length === 0" check.
  const outcome: "succeeded" | "failed" = failure ? "failed" : "succeeded";
  try {
    const settled = await deps.journal.settle(entry.id, {
      outcome,
      ...(failure ? { error: failure.reasons.join("; ") } : {}),
      afterSource: afterSourceFor(apply),
    });
    if (!settled.settled) {
      warn(`[abapsmith] WARNING: ${args.table} — journal entry ${entry.id} could not be settled (${settled.reason}).`);
    }
    return `Journalled as entry ${entry.id} (${outcome}).`;
  } catch (e) {
    warn(`[abapsmith] WARNING: ${args.table} — journal entry ${entry.id} could not be settled (${(e as Error).message}).`);
    return `Journal entry ${entry.id} could not be settled — see server log.`;
  }
}

// ---------------------------------------------------------------------------
// Mode handlers
// ---------------------------------------------------------------------------

/**
 * Builds the `ImgApplyPlan` both the preview and armed paths validate/apply against — see
 * `runProbeAndApply`'s single `validateApplyPlan` call below for why this exists as its own
 * function rather than being inlined twice.
 */
function buildApplyPlan(args: RowEditArgs, op: "upsert" | "delete", table: PolicyTable): ImgApplyPlan {
  const fields: ImgWriteField[] = table.fields.map((f) => ({ ...f }));
  return {
    table: args.table,
    clientField: args.clientField,
    keyFields: args.keyFields,
    rows: bridgeRows(args.rows),
    language: args.language,
    op,
    fields,
    corrNr: args.corrNr,
    expectedDeliveryClass: table.deliveryClass,
    expectedClientDependent: table.clientDependent,
    view: args.view,
    masterType: args.masterType,
  };
}

/**
 * Shared tail for both target paths: deploy the probe bridge, evaluate the real policy, render
 * preview or go on to deploy the apply bridge. `opts.needsReadAndConnect` gates the
 * `assert("read")`/`ensureConnected()` calls so the raw-table path's original ordering
 * (`assert(read)` -> `assert(write probe)` -> `ensureConnected()`) is preserved byte-for-byte, while
 * the resolved path — which already did both of those before its resolution reads — skips them here.
 */
async function runProbeAndApply(
  deps: ImgEditToolDeps,
  mode: "preview" | "upsert" | "delete",
  args: RowEditArgs,
  opts: { needsReadAndConnect: boolean },
): Promise<CallToolResult> {
  if (opts.needsReadAndConnect) deps.safety.assert("read");
  deps.safety.assert(
    "write",
    { name: imgManifest.entry, packageName: FLUID_PACKAGE, type: "CLAS/OC" },
    { phase: "preflight" },
  );

  if (opts.needsReadAndConnect) await deps.ensureConnected();

  const probePlan: ImgProbePlan = {
    table: args.table,
    clientField: args.clientField,
    keyFields: args.keyFields,
    rows: bridgeRows(args.rows),
    language: args.language,
  };
  const probe = await deps.pool.withWrite("abap_img_edit", imgManifest.entry, (conn) =>
    runImgProbe(conn, deps.safety, probePlan, deps.cfg, mode),
  );

  const verdict = evaluateReal(args, mode, probe, deps.safety);

  const table = policyTableFromProbe(args, probe);
  // Preview and the armed call must never disagree about whether a plan is even well-formed: both
  // build the identical ImgApplyPlan (preview always as if it were an upsert — its own prospective
  // table already previews one) and run it through the SAME validateApplyPlan a real upsert would
  // hit, before either one renders anything. This is what closed the bug where preview rendered a
  // key-only row as an empty "SET" while the armed upsert call refused the identical row with
  // BAD_INPUT — the two paths now share one plan and one validator instead of preview skipping it.
  const planOp = mode === "preview" ? "upsert" : mode;
  const applyPlan = buildApplyPlan(args, planOp, table);
  validateApplyPlan(applyPlan);

  // Diagnostic side-read, not part of the write path — see readChecksSafely's own doc comment. Its
  // failure (caught inside readChecksSafely, never thrown here) must never stop a preview from
  // rendering or an armed write from proceeding, so this runs unconditionally for both.
  const checks = await readChecksSafely(deps, args, mode);

  if (mode === "preview") {
    return ok(renderPreview(args, probe, verdict.notes, checks, deps.cfg.maxResponseChars));
  }

  deps.safety.assert(
    "write",
    { name: imgManifest.entry, packageName: FLUID_PACKAGE, type: "CLAS/OC" },
    { phase: "preflight" },
  );

  const apply = await deps.pool.withWrite("abap_img_edit", imgManifest.entry, (conn) =>
    runImgApply(conn, deps.safety, applyPlan, deps.cfg, mode),
  );

  const failure = applyFailure(mode, args.rows, apply);
  const journalNote = await recordRowMutation(deps, mode, args, probe, apply, failure);

  if (failure) {
    throw new AbapError("CHECK_FAILED", applyFailureMessage(mode, args, apply, failure, journalNote), {
      table: args.table,
      mode,
      bridgeClass: apply.bridgeClass,
      mayHaveExecuted: failure.mayHaveExecuted,
      errors: apply.transcript.errors,
      reasons: failure.reasons,
    });
  }

  return ok(renderArmed(mode, args, apply, verdict.notes, checks, journalNote, deps.cfg.maxResponseChars));
}

interface ResolveCallbackResult {
  readonly outcome: TableOutcome;
  readonly activityTitle?: string;
}

async function runRowEditMode(deps: ImgEditToolDeps, mode: "preview" | "upsert" | "delete", input: ImgEditInput): Promise<CallToolResult> {
  rejectForMode(mode, "description", input.description);
  rejectForMode(mode, "owner", input.owner);

  const selector = selectTarget(mode, input);

  if (selector.kind === "table") {
    const args = parseRowEditArgs(mode, input, deps.cfg);
    // A cold process's write-lockout verdict must exist before the gate below is ever consulted —
    // see ensureRoleVerdict's own doc comment.
    await ensureRoleVerdict(deps);
    // Cheap, I/O-free short-circuit: a config-level refusal (productive/lockout/read-only) refuses
    // before the probe bridge is ever deployed. Anything else the stub might (mis)report is discarded —
    // see preflightPolicyCheck's own doc comment and SAFE_PRECHECK_RULES.
    preflightPolicyCheck(args, mode, deps.safety);
    return runProbeAndApply(deps, mode, args, { needsReadAndConnect: true });
  }

  rejectDerivedFieldConflicts(mode, selector, input);

  const rows = input.rows ?? [];
  if (rows.length < 1) {
    throw new AbapError("BAD_INPUT", `mode "${mode}" requires at least one row.`, { mode });
  }
  const masterType = input.master_type ?? "VDAT";
  const language = assertImgLanguage(input.language ?? (deps.cfg.language || IMG_DEFAULT_LANGUAGE));
  const corrNr = input.corr_nr;
  const confirm = input.confirm;
  const allowCrossClient = input.allow_cross_client ?? false;
  const identifier = selector.kind === "activity" ? selector.activity : selector.object;

  // A cold process's write-lockout verdict must exist before the gate below is ever consulted —
  // see ensureRoleVerdict's own doc comment.
  await ensureRoleVerdict(deps);
  // Config-level refusals must be checked BEFORE the resolution read is issued, not just before the
  // probe bridge — see preflightConfigOnly's own doc comment. Connecting is not a resolution read:
  // ensureRoleVerdict above (when it runs at all) only transcribes the role-probe verdict already
  // implied by this call reaching here, it never reads IMG catalog data.
  preflightConfigOnly(mode, deps.safety);

  deps.safety.assert("read");
  await deps.ensureConnected();

  const resolved: ResolveCallbackResult = await deps.pool.withRead("abap_img_edit", async (conn) => {
    if (selector.kind === "activity") {
      const r = await resolveViaActivity(conn, selector.activity, language);
      return { outcome: r.outcome, activityTitle: r.activityTitle };
    }
    const r = await resolveTableFromObjectName(conn, selector.object, selector.objKind, language);
    return { outcome: r };
  });

  if (!resolved.outcome.ok) {
    const stubTable: PolicyTable = { table: "", clientDependent: false, deliveryClass: "", fields: [] };
    preflightResolved(mode, deps.safety, stubTable, "table", resolved.outcome.ambiguity, rows, corrNr, confirm, allowCrossClient);
    // Defensive only: preflightResolved is expected to always throw via rule 4 above, given a
    // populated ambiguity string — this only guards against evaluateImgWrite somehow not doing so.
    throw new AbapError("SAFETY_DENIED", resolved.outcome.ambiguity, { operation: mode, rule: "ambiguous-target" });
  }

  const resolvedTable = resolved.outcome.table;
  const { clientField, keyFields } = splitClientField(resolvedTable, identifier);
  const policyTargetKind = mapPolicyTargetKind(resolved.outcome.objectKind);
  const computedView =
    resolved.outcome.objectKind === "view" || resolved.outcome.objectKind === "cluster"
      ? resolved.outcome.objectName
      : resolvedTable.table;
  // Mirrors parseRowEditArgs's raw-table `view` handling: an explicitly supplied view (even "") wins
  // over the computed default — only an absent `input.view` falls back.
  const view = (input.view ?? computedView).trim();

  const realTable = policyTableFromResolved(resolvedTable, clientField);
  // Full rule set, before the probe bridge is deployed — see preflightResolved's own doc comment.
  preflightResolved(mode, deps.safety, realTable, policyTargetKind, undefined, rows, corrNr, confirm, allowCrossClient);

  const resolution: ResolutionSummary = {
    selector: selector.kind,
    identifier,
    activityTitle: resolved.activityTitle,
    objectName: resolved.outcome.objectName,
    objectKind: resolved.outcome.objectKind,
    policyTargetKind,
    statementsIssued: resolved.outcome.statementsIssued,
    durationMs: resolved.outcome.durationMs,
  };

  const args: RowEditArgs = {
    table: resolvedTable.table,
    clientField,
    keyFields,
    rows,
    view,
    masterType,
    language,
    corrNr,
    confirm,
    allowCrossClient,
    resolution,
  };

  // The read-assert and connect already happened above, before the resolution reads.
  return runProbeAndApply(deps, mode, args, { needsReadAndConnect: false });
}

async function runCreateRequestMode(deps: ImgEditToolDeps, input: ImgEditInput): Promise<CallToolResult> {
  rejectForMode("create_request", "activity", input.activity);
  rejectForMode("create_request", "object", input.object);
  rejectForMode("create_request", "kind", input.kind);
  rejectForMode("create_request", "table", input.table);
  rejectForMode("create_request", "key_fields", input.key_fields);
  rejectForMode("create_request", "rows", input.rows);
  rejectForMode("create_request", "view", input.view);
  rejectForMode("create_request", "corr_nr", input.corr_nr);
  rejectForMode("create_request", "confirm", input.confirm);

  const description = requireString("create_request", "description", input.description);
  const plan: CustomizingRequestPlan = { description, owner: input.owner };

  // A cold process's write-lockout verdict must exist before the gate below is ever consulted —
  // see ensureRoleVerdict's own doc comment.
  await ensureRoleVerdict(deps);
  deps.safety.assert("read");
  deps.safety.assert(
    "write",
    { name: imgManifest.entry, packageName: FLUID_PACKAGE, type: "CLAS/OC" },
    { phase: "preflight" },
  );

  await deps.ensureConnected();

  const result = await deps.pool.withWrite("abap_img_edit", imgManifest.entry, (conn) =>
    runCreateCustomizingRequest(conn, deps.safety, plan, deps.cfg),
  );

  // Addition beyond the strict minimum: journal the created request the same way
  // src/tools/transport.ts's own trCreate path does, so a customizing request minted here is not the
  // one CTS mutation this server makes and forgets.
  //
  // Split on whether a request NUMBER was parsed, not on whether the transcript is otherwise
  // clean: TR_INSERT_REQUEST_WITH_TASKS creates the request before this code can observe any
  // later failure (a missing task, a scaffold error line), so a parsed number always means a
  // real request exists and is journalled as such — the "NO_TASK" warning path (request set,
  // task not) takes this branch too. Only the absence of a number means this server cannot even
  // name what it may have created; that is the suspected-orphan branch below. Either way the
  // journal write happens BEFORE the throw below, never after — a thrown error must not race an
  // unwritten journal entry.
  const t = result.transcript;
  const warn = deps.warn ?? ((m: string) => void process.stderr.write(`${m}\n`));
  const sysKey = systemKey({ sid: deps.cfg.sid, url: deps.cfg.url, client: deps.cfg.client });

  if (t.request) {
    try {
      const entry = await deps.journal.begin({
        operation: "transport-create",
        object: {
          name: t.request,
          type: "CTS/TR",
          uri: `/sap/bc/adt/cts/transportrequests/${t.request}`,
          package: "",
          description,
        },
        existedBefore: false,
        beforeCapture: "confirmed-absent",
        systemKey: sysKey,
        corrNr: t.request,
        trSource: "caller",
        tool: "abap_img_edit",
      });
      if (entry) {
        const settled = await deps.journal.settle(entry.id, { outcome: "succeeded" });
        if (!settled.settled) warn(`[abapsmith] WARNING: ${t.request} — journal entry ${entry.id} could not be settled (${settled.reason}).`);
      }
    } catch (e) {
      warn(`[abapsmith] WARNING: ${t.request} — created but NOT journalled: ${(e as Error).message}.`);
    }
  } else {
    // No number parsed — this server cannot say a request was NOT created (the FM creates it
    // before this code can observe the failure), so it journals a suspected orphan on the only
    // handle it has: the description. Placeholder object name is deliberately non-numeric so it
    // can never be mistaken for a real transport number by anything reading the journal back.
    const reason = t.errors.length ? t.errors.join("; ") : "no request number was parsed from the bridge transcript";
    try {
      const entry = await deps.journal.begin({
        operation: "transport-create",
        object: {
          name: "(unknown)",
          type: "CTS/TR",
          uri: "",
          package: "",
          description,
        },
        existedBefore: false,
        beforeCapture: "confirmed-absent",
        systemKey: sysKey,
        trSource: "caller",
        tool: "abap_img_edit",
      });
      if (entry) {
        const settled = await deps.journal.settle(entry.id, { outcome: "failed", error: reason });
        if (!settled.settled) warn(`[abapsmith] WARNING: suspected orphan customizing request — journal entry ${entry.id} could not be settled (${settled.reason}).`);
      }
    } catch (e) {
      warn(`[abapsmith] WARNING: suspected orphan customizing request — NOT journalled: ${(e as Error).message}.`);
    }
  }

  if (t.errors.length || !t.request) {
    throw new AbapError(
      "CHECK_FAILED",
      createRequestFailureMessage(t, description),
      { description, task: t.task, taskType: t.taskType, errors: t.errors, warnings: t.warnings },
    );
  }

  return ok(renderCreateRequest(plan, result, deps.cfg.maxResponseChars));
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const IMG_EDIT_TOOL_DESCRIPTION =
  "Write IMG customizing rows. preview validates rows against policy and shows current vs. " +
  "prospective rows without writing; upsert/delete write rows and need confirm equal to table " +
  "(case-insensitive) — corr_nr is usually required; create_request (description, owner) mints " +
  "a customizing (type W) transport request. First call per mode deploys and activates a " +
  "bridge class in $ABAPSMITH_FLUID_API. Details: doc/TOOLS/abap-img-edit.md.";

export async function runImgEditTool(deps: ImgEditToolDeps, args: unknown): Promise<CallToolResult> {
  const input = args as ImgEditInput;
  switch (input.mode) {
    case "create_request":
      return runCreateRequestMode(deps, input);
    case "preview":
    case "upsert":
    case "delete":
      return runRowEditMode(deps, input.mode, input);
  }
}

export function registerImgEditTools(mcp: McpServer, deps: ImgEditToolDeps): void {
  mcp.registerTool(
    "abap_img_edit",
    {
      title: "Write IMG customizing rows",
      description: IMG_EDIT_TOOL_DESCRIPTION,
      inputSchema: imgEditInputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (toolArgs) => {
      try {
        return await runImgEditTool(deps, toolArgs);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
