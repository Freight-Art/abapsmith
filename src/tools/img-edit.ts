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
 * table-maintenance-generator events do NOT run. Only the row data itself
 * is written; validation an SM30 dialog would have performed did not
 * happen. `evaluateImgWrite` already seeds this
 * disclosure as the first note on every ALLOWED verdict (including
 * `preview`) — this module renders it verbatim for `upsert`/`delete` and
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
import { CUSTOMIZING_REQUEST_CLASS, type CustomizingRequestPlan } from "../adt/customizing-request.js";
import {
  runImgProbe,
  runImgApply,
  runCreateCustomizingRequest,
  type ImgProbeResult,
  type ImgApplyResult,
} from "../adt/img-write.js";
import {
  evaluateImgWrite,
  type ImgWriteProbe,
  type ImgWriteRequest,
  type PolicyField,
  type PolicyTable,
} from "../adt/img-write-policy.js";
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
  table: z
    .string()
    .optional()
    .describe("preview/upsert/delete: the base DDIC table to read/write, e.g. ZTEST_IMGW."),
  client_field: z
    .string()
    .optional()
    .describe('preview/upsert/delete: the table\'s client field name. Default "MANDT".'),
  key_fields: z
    .array(z.string())
    .optional()
    .describe("preview/upsert/delete: the table's key field names, in order. At least one required."),
  rows: z
    .array(imgEditRowSchema)
    .optional()
    .describe("preview/upsert/delete: 1-50 rows to probe/write. delete ignores each row's values."),
  view: z
    .string()
    .optional()
    .describe(
      "upsert/delete: the maintenance view or view cluster name recorded on the transport entry. " +
        "Defaults to table.",
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
    .describe("Pass true to write a client-independent table — affects every client on the system."),
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
  const verdict = evaluateImgWrite(stubProbe, req, safety.config, { previewDenyExtra: safety.config.dataPreviewDenyTables });
  if (!verdict.allowed && SAFE_PRECHECK_RULES.has(verdict.rule)) {
    throw new AbapError("SAFETY_DENIED", verdict.reason, { operation: mode, rule: verdict.rule, table: args.table });
  }
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
    targetKind: targetKind(args.table, args.view),
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

/**
 * The exact sentence `evaluateImgWrite` unconditionally seeds first in
 * `notes` on every ALLOWED verdict, preview included (img-write-policy.ts).
 * Kept as a single named constant, matched verbatim, so a preview render
 * filters precisely this one disclosure and nothing else — never re-authored
 * independently, so it can never drift from the policy module's own wording.
 */
const SM30_BYPASS_NOTE =
  "This write does not run the target view's own table-maintenance event modules (PBO/PAI, F4 " +
  "checks, consistency checks) — only the row data is written, so validation the SM30 dialog " +
  "would have performed did not happen here.";

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
    sections: [
      { title: "CURRENT ROWS", content: currentRowsTable(probe) },
      { title: "TRANSPORT ENTRY (DESCRIPTIVE ONLY)", content: transportEntryPreview(args, table) },
    ],
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
    sections: trkeyRows.length ? [{ title: "TRANSPORT ENTRY RECORDED", content: textTable(trkeyRows, ["row", "trkorr", "recorded_order", "recorded_task"]) }] : undefined,
    body: prospectiveRowsTable(mode, args),
    bodyLabel: mode === "delete" ? "ROWS DELETED" : "ROWS WRITTEN",
    notes: finalNotes,
    maxChars,
  }).text;
}

function renderCreateRequest(plan: CustomizingRequestPlan, result: Awaited<ReturnType<typeof runCreateCustomizingRequest>>, maxChars: number): string {
  const t = result.transcript;
  const notes: string[] = [];
  if (t.errors.length) notes.push(`The bridge reported ${t.errors.length} error line(s): ${t.errors.join("; ")}`);
  if (!t.request) notes.push("No request number was parsed from the transcript — see errors above, if any.");
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
    body: t.request ? `Request ${t.request}${t.task ? ` (task ${t.task})` : ""} created.` : "(no request created)",
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

async function runRowEditMode(deps: ImgEditToolDeps, mode: "preview" | "upsert" | "delete", input: ImgEditInput): Promise<CallToolResult> {
  const args = parseRowEditArgs(mode, input, deps.cfg);

  // Cheap, I/O-free short-circuit: a config-level refusal (productive/lockout/read-only) refuses
  // before the probe bridge is ever deployed. Anything else the stub might (mis)report is discarded —
  // see preflightPolicyCheck's own doc comment and SAFE_PRECHECK_RULES.
  preflightPolicyCheck(args, mode, deps.safety);

  deps.safety.assert("read");
  deps.safety.assert(
    "write",
    { name: IMGW_BRIDGE_CLASS.probe, packageName: HELPER_PACKAGE, type: "CLAS/OC" },
    { phase: "preflight" },
  );

  await deps.ensureConnected();

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

async function runCreateRequestMode(deps: ImgEditToolDeps, input: ImgEditInput): Promise<CallToolResult> {
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
  if (result.transcript.request) {
    const warn = deps.warn ?? ((m: string) => void process.stderr.write(`${m}\n`));
    try {
      const entry = await deps.journal.begin({
        operation: "transport-create",
        object: {
          name: result.transcript.request,
          type: "CTS/TR",
          uri: `/sap/bc/adt/cts/transportrequests/${result.transcript.request}`,
          package: "",
          description,
        },
        existedBefore: false,
        beforeCapture: "confirmed-absent",
        systemKey: systemKey({ sid: deps.cfg.sid, url: deps.cfg.url, client: deps.cfg.client }),
        corrNr: result.transcript.request,
        trSource: "caller",
        tool: "abap_img_edit",
      });
      if (entry) {
        const settled = await deps.journal.settle(entry.id, { outcome: "succeeded" });
        if (!settled.settled) warn(`[abapsmith] WARNING: ${result.transcript.request} — journal entry ${entry.id} could not be settled (${settled.reason}).`);
      }
    } catch (e) {
      warn(`[abapsmith] WARNING: ${result.transcript.request} — created but NOT journalled: ${(e as Error).message}.`);
    }
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
