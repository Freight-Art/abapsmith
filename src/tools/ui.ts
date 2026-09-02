/**
 * `abap_ui` — drive classic SAP dynpro screens headlessly via batch input
 * (BDC), the same mechanism SAP GUI recording uses, without a GUI.
 *
 *   screen  discovery: given a tcode or program+dynpro, return the screen's
 *           fields, flow logic, and GUI status. Read-only in effect (writes
 *           only a throwaway $TMP bridge class, like abap_fpm_read).
 *   press   execute a batch-input script against a transaction. COMMITS —
 *           CALL TRANSACTION ... MODE 'N' UPDATE 'S' has no dry run and
 *           ROLLBACK WORK cannot reach back across the boundary. Gated by
 *           ABAP_MODE=admin AND a separate ABAP_ALLOW_UI_PRESS opt-in (see
 *           assertPressEnabled), a mandatory confirm:true, and a name-based
 *           tcode denylist (guardrail only — see UI_PRESS_DENYLIST). The
 *           real boundary is SAP's own authority check; generated ABAP never
 *           emits CALL TRANSACTION ... WITHOUT AUTHORITY-CHECK.
 *
 * BDC replays classic dynpros only — Web Dynpro, FPM/FBI (abap_fpm_read),
 * and Fiori/UI5 have no dynpro number and are unreachable here. When
 * TSTC-CINFO says report transaction ('80') rather than dialog ('00'),
 * press refuses (see assertBdcApplies) — use abap_run (report mode).
 *
 * The 00/344 discovery loop is the core workflow: when a press script runs
 * out of screens, CALL TRANSACTION returns sy-subrc=1001 / msg 00/344,
 * naming the program/dynpro it stalled on; the response surfaces the
 * follow-up screen call that resolves it.
 *
 * Reconciled against the real src/adt/ui-runtime.ts (drafted originally
 * against an assumed interface) — full reconciliation history in
 * the git history. Two points still shape logic here:
 * (1) UiBridgeResult has no `mode` discriminant, mode data lives at
 * transcript.press vs screen-only fields; (2) pressBody() runs CALL
 * TRANSACTION unconditionally with no CINFO check — assertBdcApplies below
 * adds that check at this layer.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { AbapError } from "../adt/errors.js";
import {
  runUiBridge,
  uiBridgeClassName,
  UI_FKEY_ROW_CAP,
  type UiBdcField,
  type UiBdcScreen,
  type UiBridgeResult,
  type UiMessage,
  type UiPressQuery,
  type UiScreenQuery,
  type UiScreenTarget,
} from "../adt/ui-runtime.js";
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import { buildResponse, textTable } from "../compact.js";
import { safetyTarget, type SafetyGate } from "../safety.js";
import { withJournalledMutation, systemKey, type Journal } from "../journal.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const uiPressFieldSchema = z.object({
  name: z.string().describe("Screen field name (D021S-FNAM), e.g. BKPF-BLDAT."),
  value: z.string().describe("Value to set (BDCDATA-FVAL, max 132 chars)."),
});

const uiPressScreenSchema = z.object({
  program: z.string().describe("Program owning this dynpro (from a prior screen call's resolved program)."),
  dynpro: z.string().describe('Screen number, e.g. "100" — padded to 4 digits automatically.'),
  okcode: z
    .string()
    .optional()
    .describe('Function code to fire, e.g. "=ENTR" or "/00". Sets BDC_OKCODE.'),
  cursorField: z
    .string()
    .optional()
    .describe("Field name to position the cursor on before the okcode fires. Sets BDC_CURSOR."),
  fields: z.array(uiPressFieldSchema).optional().describe("Field values to set on this screen before the okcode fires."),
});

export const uiInputSchema = {
  mode: z
    .enum(["screen", "press"])
    .describe(
      "screen: read one dynpro (discovery, read-only in effect). press: run a batch-input " +
        "script — commits, cannot be rolled back. Requires ABAP_MODE=admin, " +
        "ABAP_ALLOW_UI_PRESS=true, and confirm:true.",
    ),
  tcode: z
    .string()
    .optional()
    .describe("Transaction code. screen: alternative to program+dynpro. press: required."),
  program: z.string().optional().describe("screen only, with dynpro: program name instead of tcode."),
  dynpro: z.string().optional().describe('screen only, with program: screen number, e.g. "100".'),
  screens: z
    .array(uiPressScreenSchema)
    .optional()
    .describe(
      "press only, required: ordered batch-input script, one entry per dynpro the transaction " +
        "will show in sequence. Build it incrementally using the screen call's own field/status " +
        "output and the 00/344 stall this tool reports when a script runs out.",
    ),
  confirm: z
    .boolean()
    .optional()
    .describe(
      "press only, REQUIRED (must be exactly true) — acknowledges the commit. Omitted or " +
        "false is refused before any network call.",
    ),
};

export const UiInput = z.object(uiInputSchema);
export type UiInput = z.infer<typeof UiInput>;

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface UiToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  /**
   * Required (not optional): an optional journal on a mutating tool risks a
   * silent write with no before-image or forensic trail — same reasoning as
   * WriteToolDeps.journal / EnhToolDeps.journal.
   */
  readonly journal: Journal;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  /**
   * Not a real `Config` field yet (no `ABAP_ALLOW_UI_PRESS` in
   * src/config.ts) — declared on this tool's own deps type because this
   * file must not touch src/config.ts. Orchestrator TODO: add the env var
   * via `boolFromEnv`, mode-orthogonal like `allowDumpVariables`, and wire
   * it through when `registerUiTools` is called from server.ts.
   */
  readonly cfg: Pick<Config, "maxResponseChars" | "abapMode" | "sid" | "url" | "client"> & {
    readonly allowUiPress: boolean;
  };
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

// ---------------------------------------------------------------------------
// Fidelity notes — disclosed on every response, both modes.
// ---------------------------------------------------------------------------

const FIDELITY_NOTES: readonly string[] = [
  "Batch input (BDC) replays classic dynpro screens only. Web Dynpro, FPM/FBI (a different " +
    "mechanism — see abap_fpm_read), and Fiori/UI5 screens have no dynpro number and cannot be " +
    "reached by this tool at any effort level.",
  "BDC scripts are brittle by construction, not by defect: they hardcode screen numbers and " +
    "field names. A script proven against one system's layout can break on a modal dialog, an " +
    "authorization popup, a transaction variant, a customizing difference, or a support-package " +
    "UI change on another — a working sequence is not portable without re-verification.",
];

/**
 * Guardrail, not a security boundary — a transaction variant (SE93), a
 * wrapper transaction, or a direct CALL TRANSACTION of the underlying
 * program all evade this literal-name-only list. Catches operator/model
 * mistakes; the real boundary is SAP's own authority check (generated ABAP
 * never emits WITHOUT AUTHORITY-CHECK). Additive-only if extended — mirrors
 * dataPreviewDenyTables's framing in src/safety.ts.
 */
const UI_PRESS_DENYLIST: ReadonlySet<string> = new Set([
  // External command execution
  "SM49",
  "SM69",
  // User/role administration
  "SU01",
  "PFCG",
  "SU10",
  // Client operations
  "SCC5",
  "SCC1",
  // Arbitrary program execution
  "SA38",
  "SE38",
  // Transport administration
  "STMS",
  "SE06",
  "SE09",
  "SE10",
  // Direct table maintenance
  "SM30",
  "SM31",
  "SE16N",
]);

function normalizeTcode(raw: string): string {
  return raw.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Query builders — pure, zero-network, throw BAD_INPUT.
// ---------------------------------------------------------------------------

function buildScreenTarget(input: UiInput): UiScreenTarget {
  const tcode = input.tcode?.trim();
  const program = input.program?.trim();
  const dynpro = input.dynpro?.trim();
  if (tcode) {
    return { by: "tcode", tcode: normalizeTcode(tcode) };
  }
  if (program && dynpro) {
    return { by: "program", program, dynpro };
  }
  throw new AbapError(
    "BAD_INPUT",
    'mode:"screen" needs either tcode, or both program and dynpro.',
    { mode: "screen", tcode: input.tcode, program: input.program, dynpro: input.dynpro },
  );
}

function buildScreenQuery(input: UiInput): UiScreenQuery {
  return { mode: "screen", target: buildScreenTarget(input) };
}

function buildPressQuery(input: UiInput): UiPressQuery {
  const tcode = input.tcode?.trim();
  if (!tcode) {
    throw new AbapError("BAD_INPUT", 'mode:"press" requires tcode.', { mode: "press" });
  }
  if (!input.screens || input.screens.length === 0) {
    throw new AbapError(
      "BAD_INPUT",
      'mode:"press" requires a non-empty "screens" array — the batch-input script to run. Use ' +
        'mode:"screen" first to learn the first dynpro\'s fields and buttons.',
      { mode: "press", tcode },
    );
  }
  const screens: UiBdcScreen[] = input.screens.map((s) => ({
    program: s.program.trim(),
    dynpro: s.dynpro.trim(),
    okCode: s.okcode?.trim(),
    cursorField: s.cursorField?.trim(),
    fields: (s.fields ?? []).map((f): UiBdcField => ({ fieldName: f.name.trim(), value: f.value })),
  }));
  return { mode: "press", tcode: normalizeTcode(tcode), screens };
}

// ---------------------------------------------------------------------------
// press-specific safety gates. Order: cheapest / most tool-specific first, so
// a refused call never pays for a check further down the list.
// ---------------------------------------------------------------------------

/** confirm:true is load-bearing, not ceremony — no dry run, and ROLLBACK WORK can't reach across CALL TRANSACTION. */
function assertPressConfirmed(input: UiInput): void {
  if (input.confirm === true) return;
  throw new AbapError(
    "SAFETY_DENIED",
    "abap_ui press executes CALL TRANSACTION ... MODE 'N' UPDATE 'S' against a live system. " +
      "This COMMITS business data changes immediately and CANNOT be rolled back — MODE 'N' still " +
      "commits, and ROLLBACK WORK does not reach back across a CALL TRANSACTION boundary. There is " +
      "no dry run. Pass confirm: true to proceed.",
    { operation: "execute", phase: "preflight" },
    "Re-issue the call with confirm: true once you intend the script to actually run.",
    { retryable: true }, // confirm:true is a caller-supplied argument that makes this exact call succeed
  );
}

/** Guardrail against mistakes — see UI_PRESS_DENYLIST's own doc comment. */
function assertNotDenylisted(tcode: string): void {
  if (!UI_PRESS_DENYLIST.has(tcode)) return;
  throw new AbapError(
    "SAFETY_DENIED",
    `Transaction ${tcode} is on abap_ui press's denylist of transactions it refuses to drive via ` +
      "batch input (external-command execution, user/role administration, client operations, " +
      "arbitrary program execution, transport administration, or direct table maintenance). This " +
      "is a guardrail against mistakes, not a security boundary — see the tool's own source comment " +
      "on UI_PRESS_DENYLIST for why it cannot be one. There is no override for this list.",
    { operation: "execute", tcode, phase: "preflight" },
  );
}

/**
 * Requires admin mode AND a separate opt-in flag — mirrors
 * `allowDumpVariables`'s mode-orthogonal shape, deliberately NOT
 * `allowEnhancementDelete`'s mode-unlock shape (press must never be
 * reachable below admin). Both required together; neither alone suffices.
 */
function assertPressEnabled(cfg: UiToolDeps["cfg"]): void {
  const isAdmin = cfg.abapMode === "admin";
  const flagOn = cfg.allowUiPress === true;
  if (isAdmin && flagOn) return;
  const modeState = cfg.abapMode === undefined ? "unset (legacy per-flag config)" : cfg.abapMode;
  throw new AbapError(
    "SAFETY_DENIED",
    "abap_ui press is disabled. It requires BOTH ABAP_MODE=admin AND ABAP_ALLOW_UI_PRESS=true — " +
      "admin mode alone does not enable it, and the flag alone does not either. Batch input " +
      "executes arbitrary transactions under the connected user's full SAP authority with no dry " +
      `run. Current: ABAP_MODE=${modeState}, ABAP_ALLOW_UI_PRESS=${flagOn}.`,
    { operation: "execute", phase: "preflight", abapMode: cfg.abapMode, allowUiPress: flagOn },
    "Set both ABAP_MODE=admin and ABAP_ALLOW_UI_PRESS=true if this call is genuinely intended.",
  );
}

/**
 * ui-runtime's pressBody() runs CALL TRANSACTION unconditionally with no
 * CINFO check (only screenBody() reads it) — left alone, a report tcode
 * would just run the report and ignore the scripted BDCDATA. This closes
 * that gap: an extra screen-mode precheck call reads TSTC-CINFO before
 * every press. An unrecognised CINFO value is refused too, conservatively.
 */
async function assertBdcApplies(deps: UiToolDeps, tcode: string): Promise<void> {
  const precheckQuery: UiScreenQuery = { mode: "screen", target: { by: "tcode", tcode } };
  const precheckClass = uiBridgeClassName(precheckQuery);
  deps.safety.assert(
    "write",
    { name: precheckClass, packageName: "$TMP", type: "CLAS/OC" },
    { phase: "preflight" },
  );
  const precheck = await deps.pool.withWrite("abap_ui", precheckClass, (conn) =>
    runUiBridge(conn, precheckQuery, deps.safety),
  );
  const kind = precheck.transcript.tcode;
  if (!kind) {
    throw new AbapError(
      "ADT_ERROR",
      `Could not resolve transaction ${tcode} via TSTC before press — the precheck bridge returned no ` +
        "tcode record.",
      { tcode },
    );
  }
  if (kind.bdcApplies !== true) {
    throw new AbapError(
      "SAFETY_DENIED",
      `Transaction ${tcode} has TSTC-CINFO=${kind.cinfo} (${kind.kind}) — batch input only applies to ` +
        "confirmed dialog transactions (cinfo='00'). CALL TRANSACTION against a report transaction runs " +
        "the report directly and ignores scripted BDCDATA, which is not a safe no-op. Use abap_run " +
        "(report mode) or SUBMIT instead.",
      { tcode, cinfo: kind.cinfo, kind: kind.kind, phase: "preflight" },
    );
  }
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

/**
 * Renders bridge rows as key=[value] lines. header/fields/flow/statusList
 * are RTTI dumps (component names not independently confirmed — see
 * ui-runtime.ts); functions/fkeys are a fixed narrow projection instead of
 * an RTTI dump — a full dump of those two tables measured ~600 rows /
 * ~7,000 pairs on SAPLSETB and risked blowing buildResponse's maxChars
 * budget. All four share this renderer since the wire shape is identical.
 */
function renderRecordRows(rows: readonly Record<string, string>[]): string {
  if (!rows.length) return "(none)";
  return rows
    .map((row) =>
      Object.entries(row)
        .map(([k, v]) => `${k}=[${v}]`)
        .join(" "),
    )
    .join("\n");
}

function buildScreenResponse(query: UiScreenQuery, result: UiBridgeResult, maxChars: number): string {
  const t = result.transcript;
  const notes = [...FIDELITY_NOTES];

  if (t.tcode) {
    if (t.tcode.bdcApplies === false) {
      notes.push(
        `TSTC-CINFO=${t.tcode.cinfo} — ${t.tcode.kind}. abap_ui press refuses this transaction: ` +
          "use abap_run (report mode) or SUBMIT instead.",
      );
    } else if (t.tcode.bdcApplies === undefined) {
      notes.push(
        `TSTC-CINFO=${t.tcode.cinfo} is not a recognised value ('00' dialog / '80' report) — press ` +
          "will refuse this transaction conservatively until it is.",
      );
    }
  }
  if (t.droppedLines > 0) {
    notes.push(`${t.droppedLines} unprefixed line(s) from the bridge output were dropped (framing noise).`);
  }
  if (t.noCua) {
    notes.push(`No GUI status defined for program ${t.noCua.program} — this is normal, not an error.`);
  }
  if (t.statusLoop?.capped) {
    notes.push(
      `GUI status button lookup was capped at ${t.statusLoop.done} of ${t.statusLoop.total} statuses — ` +
        "FUNCTION KEYS below is an INCOMPLETE list, not the full set.",
    );
  }
  if (t.fkeyCap?.capped) {
    notes.push(
      `FUNCTION KEYS was capped at ${UI_FKEY_ROW_CAP} rows — this is an INCOMPLETE list of the buttons found.`,
    );
  }

  return buildResponse({
    header: {
      mode: "screen",
      tcode: t.tcode?.tcode,
      cinfo: t.tcode?.cinfo,
      program: t.resolved?.program,
      dynpro: t.resolved?.dynpro,
      fieldsCount: t.fieldsCount,
      flowCount: t.flowCount,
      statusCount: t.statusCount,
      functionsCount: t.functionsCount,
      fkeysCount: t.fkeysCount,
      statusLoopDone: t.statusLoop?.done,
      statusLoopTotal: t.statusLoop?.total,
      statusLoopCapped: t.statusLoop?.capped,
      fkeyCapEmitted: t.fkeyCap?.emitted,
      fkeyCapCapped: t.fkeyCap?.capped,
      bridgeClass: result.bridgeClass,
      bridgeRefreshed: result.bridgeRefreshed,
    },
    sections: [
      { title: "HEADER (RPY_DYNPRO_READ)", content: t.header ? renderRecordRows([t.header]) : "(not read)" },
      { title: "FLOW LOGIC", content: renderRecordRows(t.flow) },
      { title: "GUI STATUSES (names)", content: renderRecordRows(t.statusList) },
      { title: "FUNCTION CODES (program-wide)", content: renderRecordRows(t.functions) },
      { title: "FUNCTION KEYS", content: renderRecordRows(t.fkeys) },
      ...(t.diagnostics.length ? [{ title: "DIAGNOSTICS", content: t.diagnostics.join("\n") }] : []),
    ],
    body: renderRecordRows(t.fields),
    bodyLabel: "FIELDS",
    notes,
    maxChars,
  }).text;
}

function buildPressResponse(query: UiPressQuery, result: UiBridgeResult, maxChars: number): string {
  const t = result.transcript;
  const notes = [...FIDELITY_NOTES];
  notes.push(
    "This call committed (or attempted to commit) business data. There is no dry run and no " +
      "rollback — see the messages and sy-subrc below for what actually happened.",
  );

  const press = t.press;
  if (!press) {
    // Defensive: a successful bridge run should always yield a SUBRC line — fail loudly, don't mis-render.
    throw new AbapError(
      "ADT_ERROR",
      "ui-runtime returned no press result for a press query — the bridge transcript had no SUBRC line.",
      {},
    );
  }

  if (press.stalled) {
    notes.push(press.stalled.hint);
  }

  const messageRows = press.messages.map((m: UiMessage) => ({
    type: m.msgType,
    id: m.msgId,
    nr: m.msgNumber,
    text: m.text,
  }));

  return buildResponse({
    header: {
      mode: "press",
      tcode: query.tcode,
      subrc: press.subrc,
      rowCount: press.rowCount,
      stalled_at_program: press.stalled?.program,
      stalled_at_dynpro: press.stalled?.dynpro,
      bridgeClass: result.bridgeClass,
      bridgeRefreshed: result.bridgeRefreshed,
    },
    sections: t.diagnostics.length ? [{ title: "DIAGNOSTICS", content: t.diagnostics.join("\n") }] : undefined,
    body: messageRows.length ? textTable(messageRows, ["type", "id", "nr", "text"]) : "(no messages)",
    bodyLabel: "MESSAGES",
    notes,
    maxChars,
  }).text;
}

// ---------------------------------------------------------------------------
// Tool logic
// ---------------------------------------------------------------------------

async function runScreenTool(deps: UiToolDeps, input: UiInput): Promise<CallToolResult> {
  const query = buildScreenQuery(input);

  // Cheap, zero-network preflight — mirrors abap_fpm_read: bridge class name is a pure function of the query.
  const bridgeClass = uiBridgeClassName(query);
  deps.safety.assert("read");
  deps.safety.assert("write", { name: bridgeClass, packageName: "$TMP", type: "CLAS/OC" }, { phase: "preflight" });

  await deps.ensureConnected();

  const result = await deps.pool.withWrite("abap_ui", bridgeClass, (conn) =>
    runUiBridge(conn, query, deps.safety),
  );
  return ok(buildScreenResponse(query, result, deps.cfg.maxResponseChars));
}

async function runPressTool(deps: UiToolDeps, input: UiInput): Promise<CallToolResult> {
  // Order: cheapest / most tool-specific refusals first — same discipline as abap_enh's delete gate.
  assertPressConfirmed(input);
  const query = buildPressQuery(input);
  assertNotDenylisted(query.tcode);
  assertPressEnabled(deps.cfg);

  // General "execute" ceiling every mutating tool goes through. type:"TCODE"
  // (see INVOCATION_TARGET_TYPES in src/safety.ts) is load-bearing — dropping
  // it silently re-routes through the customer-namespace name-prefix rule and
  // refuses every standard transaction (the live SE16 failure this shape
  // fixes; see the git history). Layered under, not
  // instead of, assertPressEnabled/assertNotDenylisted above.
  deps.safety.assert("execute", safetyTarget({ name: query.tcode, type: "TCODE" }), { phase: "preflight" });

  await deps.ensureConnected();

  // Closes ui-runtime's missing CINFO check before the mutating CALL TRANSACTION — see assertBdcApplies.
  await assertBdcApplies(deps, query.tcode);

  const bridgeClass = uiBridgeClassName(query);
  deps.safety.assert("write", { name: bridgeClass, packageName: "$TMP", type: "CLAS/OC" }, { phase: "preflight" });

  // Journal every press with the BDCDATA script (deliberately not skipped,
  // unlike other bridge-based writes elsewhere — a known gap). JournalOperation
  // has no execute/press variant, so "update" is the closest fit. Before-image
  // is query.screens itself, the only forensic record available — UiPressResult
  // reports only a row count, never the literal BDCDATA rows submitted.
  const journalled = await withJournalledMutation<UiPressQuery, UiBridgeResult>(
    deps.journal,
    {
      begin: (image) => ({
        operation: "update",
        object: {
          name: image.tcode,
          type: "UI/PRESS",
          uri: "",
          package: "",
          description: `abap_ui press: ${image.tcode} (${image.screens.length} screen(s))`,
        },
        existedBefore: true,
        beforeCapture: "unknown",
        afterSource: JSON.stringify(image.screens, null, 2),
        tool: "abap_ui",
        irreversible: true,
        // No `conn` in scope here — `begin` fires from `onBeforeImage(query)`
        // below, before `deps.pool.withWrite` ever hands one back. Built from
        // `deps.cfg` directly, matching the `systemKey({ sid, url, client })`
        // spelling `src/tools/transport.ts` uses (not the `systemKey(conn.cfg)`
        // spelling used elsewhere, which needs a live connection this closure
        // doesn't have).
        systemKey: systemKey({ sid: deps.cfg.sid, url: deps.cfg.url, client: deps.cfg.client }),
      }),
    },
    async (onBeforeImage) => {
      await onBeforeImage(query);
      return deps.pool.withWrite("abap_ui", bridgeClass, (conn) => runUiBridge(conn, query, deps.safety));
    },
  );

  const result = journalled.result;
  const press = result.transcript.press;
  await journalled.settle({
    outcome: press && press.subrc === 0 ? "succeeded" : "failed",
  });

  return ok(buildPressResponse(query, result, deps.cfg.maxResponseChars));
}

const UI_TOOL_DESCRIPTION =
  "Drive classic SAP dynpro screens via batch input (BDC): screen reads one dynpro's " +
  "fields/flow/status; press runs a scripted transaction (commits, no rollback). Reaches " +
  "classic dialog dynpros ONLY — never Web Dynpro/FPM/Fiori.";

export async function runUiTool(deps: UiToolDeps, args: unknown): Promise<CallToolResult> {
  const input = args as UiInput;
  return input.mode === "press" ? runPressTool(deps, input) : runScreenTool(deps, input);
}

export function registerUiTools(mcp: McpServer, deps: UiToolDeps): void {
  mcp.registerTool(
    "abap_ui",
    {
      title: "Drive classic dynpro screens (batch input)",
      description: UI_TOOL_DESCRIPTION,
      inputSchema: uiInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return await runUiTool(deps, args);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
