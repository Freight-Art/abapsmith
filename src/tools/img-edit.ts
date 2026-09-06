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
import { HELPER_PACKAGE } from "../adt/helper-package.js";
import {
  IMGW_BRIDGE_CLASS,
  type ImgProbePlan,
  type ImgApplyPlan,
  type ImgWriteField,
  type ImgWriteRow,
  type ImgWriteValueRow,
} from "../adt/img-write-bridge.js";
import {
  CUSTOMIZING_REQUEST_CLASS,
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
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import { buildResponse, textTable } from "../compact.js";
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
      "preview: validate rows against policy and show current vs. prospective rows, without writing. " +
        "upsert: write rows (insert new keys, update existing ones). delete: remove rows. " +
        "create_request: create a new customizing (type W) transport request and return its number.",
    ),
  activity: z
    .string()
    .optional()
    .describe(
      "preview/upsert/delete: an IMG activity id, exactly as abap_img show accepts. Resolved to its " +
        "base table, key fields, and client field automatically. Exactly one of activity/object/table " +
        "is required. Conflicts with key_fields/client_field (those are derived from the resolution).",
    ),
  object: z
    .string()
    .optional()
    .describe(
      "preview/upsert/delete: a maintenance view, view cluster, transaction, or table name, exactly as " +
        "abap_img objects accepts. Resolved to its base table, key fields, and client field " +
        "automatically. Exactly one of activity/object/table is required. Conflicts with " +
        "key_fields/client_field (those are derived from the resolution).",
    ),
  kind: z
    .enum(["table", "view", "cluster", "transaction", "customizing_object", "report"])
    .optional()
    .describe(
      "Only meaningful together with object: which catalog to resolve object against. Omitted: probed " +
        "as table, then view, then cluster, then transaction, then customizing object, first match wins.",
    ),
  table: z
    .string()
    .optional()
    .describe(
      "Expert escape hatch: the base DDIC table to read/write directly, e.g. ZTEST_IMGW, bypassing " +
        "activity/object resolution. Exactly one of activity/object/table is required for " +
        "preview/upsert/delete. Requires key_fields; client_field is optional (defaults to MANDT) " +
        "but this tool cannot write a genuinely client-independent table regardless — the write " +
        "always sets client_field from sy-mandt.",
    ),
  client_field: z
    .string()
    .optional()
    .describe(
      "table (expert escape hatch) only: the table's client field name, e.g. MANDT. Conflicts with " +
        "activity/object, whose client field is resolved automatically.",
    ),
  key_fields: z
    .array(z.string())
    .optional()
    .describe(
      "table (expert escape hatch) only: the table's key field names, in order, excluding the client " +
        "field. At least one required. Conflicts with activity/object, whose key fields are resolved " +
        "automatically.",
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
        "With activity/object, defaults to the resolved view/cluster name (or table, if the resolved " +
        "target is a table). With table, defaults to table.",
    ),
  master_type: z
    .enum(["VDAT", "CDAT"])
    .optional()
    .describe(
      'upsert/delete: the transport entry\'s object type. "VDAT" for a maintenance view (default), ' +
        '"CDAT" for a customizing object recorded directly.',
    ),
  language: z
    .string()
    .regex(/^[A-Za-z]{1,2}$/, "1-2 letters")
    .optional()
    .describe('1-2 letter language code the probe reads DD02L/DD03L texts in. Default "EN".'),
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
        "the write possible — the generated apply class always sets the client field from sy-mandt, " +
        "which a genuinely client-independent table has none of.",
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
  /** `sid`/`url`/`client` are for `systemKey()` on journal entries, same as `TransportToolDeps`. */
  readonly cfg: Pick<Config, "maxResponseChars" | "language" | "sid" | "url" | "client">;
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
    language: (input.language ?? (cfg.language || "EN")).trim(),
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
          "table/key_fields/client_field expert escape hatch: the generated apply class always sets a client " +
          "field from sy-mandt, which a table shaped this way does not have. Maintain this table by hand " +
          "(SM30/SM34) instead.",
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
    table: t?.table ?? args.table,
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

function currentRowsTable(probe: ImgProbeResult): string {
  const t = probe.transcript;
  const present = groupByRow(t.before);
  const absent = new Set(t.beforeAbsent.map((a) => a.row));
  const rowNumbers = new Set<number>([...present.keys(), ...absent]);
  const rows = [...rowNumbers]
    .sort((a, b) => a - b)
    .map((row) => {
      if (absent.has(row)) return { row: String(row), status: "does not exist yet", fields: "" };
      const fields = present.get(row) ?? {};
      return {
        row: String(row),
        status: "exists",
        fields: Object.entries(fields)
          .map(([k, v]) => `${k}=${v}`)
          .join(", "),
      };
    });
  return rows.length ? textTable(rows, ["row", "status", "fields"]) : "(no rows probed)";
}

function prospectiveRowsTable(mode: "upsert" | "delete", args: RowEditArgs): string {
  const rows = args.rows.map((r, i) => ({
    row: String(i),
    key: Object.entries(r.key)
      .map(([k, v]) => `${k}=${v}`)
      .join(", "),
    change: mode === "delete" ? "DELETE this row" : `SET ${Object.entries(r.values ?? {}).map(([k, v]) => `${k}=${v}`).join(", ")}`,
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

function renderPreview(args: RowEditArgs, probe: ImgProbeResult, notes: readonly string[], maxChars: number): string {
  const table = policyTableFromProbe(args, probe);
  const filteredNotes = notes.filter((n) => n !== SM30_BYPASS_NOTE);
  const t = probe.transcript;
  if (t.errors.length) filteredNotes.push(`The bridge reported ${t.errors.length} error line(s): ${t.errors.join("; ")}`);
  if (t.droppedLines) filteredNotes.push(`${t.droppedLines} transcript line(s) were not recognised by the parser.`);

  const sections = [
    { title: "CURRENT ROWS", content: currentRowsTable(probe) },
    { title: "TRANSPORT ENTRY (DESCRIPTIVE ONLY)", content: transportEntryPreview(args, table) },
  ];
  if (args.resolution) sections.unshift({ title: "RESOLVED", content: renderResolvedSection(args.resolution, args) });

  return buildResponse({
    header: {
      mode: "preview",
      table: table.table,
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

function renderArmed(
  mode: "upsert" | "delete",
  args: RowEditArgs,
  apply: ImgApplyResult,
  notes: readonly string[],
  journalNote: string | undefined,
  maxChars: number,
): string {
  const t = apply.transcript;
  const finalNotes = [...notes];
  if (journalNote) finalNotes.push(journalNote);
  if (t.errors.length) finalNotes.push(`The bridge reported ${t.errors.length} error line(s): ${t.errors.join("; ")}`);
  if (t.droppedLines) finalNotes.push(`${t.droppedLines} transcript line(s) were not recognised by the parser.`);

  const trkeyRows = t.trkeys.map((k) => ({
    row: String(k.row),
    trkorr: k.trkorr,
    recorded_order: k.recordedOrder ?? "",
    recorded_task: k.recordedTask ?? "",
  }));

  const sections: { title: string; content: string }[] = trkeyRows.length
    ? [{ title: "TRANSPORT ENTRY RECORDED", content: textTable(trkeyRows, ["row", "trkorr", "recorded_order", "recorded_task"]) }]
    : [];
  if (args.resolution) sections.unshift({ title: "RESOLVED", content: renderResolvedSection(args.resolution, args) });

  return buildResponse({
    header: {
      mode,
      table: args.table,
      view: args.view,
      masterType: args.masterType,
      corrNr: args.corrNr,
      applied: t.applied ?? undefined,
      bridgeClass: apply.bridgeClass,
      bridgeRefreshed: apply.bridgeRefreshed,
    },
    sections: sections.length ? sections : undefined,
    body: prospectiveRowsTable(mode, args),
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
      bridgeClass: result.bridgeClass,
      bridgeRefreshed: result.bridgeRefreshed,
    },
    body: t.request ? `Request ${t.request}${t.task ? ` (task ${t.task})` : ""} created.` : "Request could not be confirmed — see notes.",
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
  const snapshot = Array.from({ length: totalRows }, (_, row) =>
    absent.has(row) ? { row, existed: false } : { row, existed: true, values: present.get(row) ?? {} },
  );
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

  const t = apply.transcript;
  const outcome: "succeeded" | "failed" = t.errors.length === 0 ? "succeeded" : "failed";
  try {
    const settled = await deps.journal.settle(entry.id, {
      outcome,
      ...(outcome === "failed" ? { error: t.errors.join("; ") } : {}),
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
    { name: IMGW_BRIDGE_CLASS.probe, packageName: HELPER_PACKAGE, type: "CLAS/OC" },
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
  const probe = await deps.pool.withWrite("abap_img_edit", IMGW_BRIDGE_CLASS.probe, (conn) =>
    runImgProbe(conn, deps.safety, probePlan),
  );

  const verdict = evaluateReal(args, mode, probe, deps.safety);

  if (mode === "preview") {
    return ok(renderPreview(args, probe, verdict.notes, deps.cfg.maxResponseChars));
  }

  const table = policyTableFromProbe(args, probe);
  deps.safety.assert(
    "write",
    { name: IMGW_BRIDGE_CLASS.apply, packageName: HELPER_PACKAGE, type: "CLAS/OC" },
    { phase: "preflight" },
  );

  const fields: ImgWriteField[] = table.fields.map((f) => ({ ...f }));
  const applyPlan: ImgApplyPlan = {
    table: args.table,
    clientField: args.clientField,
    keyFields: args.keyFields,
    rows: bridgeRows(args.rows),
    language: args.language,
    op: mode,
    fields,
    corrNr: args.corrNr,
    expectedDeliveryClass: table.deliveryClass,
    expectedClientDependent: table.clientDependent,
    view: args.view,
    masterType: args.masterType,
  };
  const apply = await deps.pool.withWrite("abap_img_edit", IMGW_BRIDGE_CLASS.apply, (conn) =>
    runImgApply(conn, deps.safety, applyPlan),
  );

  const journalNote = await recordRowMutation(deps, mode, args, probe, apply);

  return ok(renderArmed(mode, args, apply, verdict.notes, journalNote, deps.cfg.maxResponseChars));
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
  const language = (input.language ?? (deps.cfg.language || "EN")).trim();
  const corrNr = input.corr_nr;
  const confirm = input.confirm;
  const allowCrossClient = input.allow_cross_client ?? false;
  const identifier = selector.kind === "activity" ? selector.activity : selector.object;

  // Config-level refusals must be checked BEFORE the resolution read is issued, not just before the
  // probe bridge — see preflightConfigOnly's own doc comment.
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

  deps.safety.assert("read");
  deps.safety.assert(
    "write",
    { name: CUSTOMIZING_REQUEST_CLASS, packageName: HELPER_PACKAGE, type: "CLAS/OC" },
    { phase: "preflight" },
  );

  await deps.ensureConnected();

  const result = await deps.pool.withWrite("abap_img_edit", CUSTOMIZING_REQUEST_CLASS, (conn) =>
    runCreateCustomizingRequest(conn, deps.safety, plan),
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
      { description, errors: t.errors, warnings: t.warnings },
    );
  }

  return ok(renderCreateRequest(plan, result, deps.cfg.maxResponseChars));
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const IMG_EDIT_TOOL_DESCRIPTION =
  "preview (table, key_fields, rows) validates rows against policy and shows current vs. prospective " +
  "rows without writing. upsert/delete (table, key_fields, rows, confirm) write rows; confirm must " +
  "equal table (case-insensitive) and corr_nr is usually required. view/master_type name the " +
  "transport entry recorded for upsert/delete (default: table/VDAT). create_request (description, " +
  "owner) mints a new customizing (type W) transport request. First call per mode deploys and " +
  "activates a $ZMCP_HELPERS bridge class.";

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
