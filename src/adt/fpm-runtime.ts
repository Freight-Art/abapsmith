/**
 * `abap_fpm_read`'s adapter onto the static fluid `fpm` tool body
 * (`ZCL_ZMCP_FLUID_FPM`, src/adt/fluid/builtin/fpm.ts). FPM/FBI screen
 * configs live as XML in WDY_CONFIG_* tables with no ADT REST read path
 * (writes 405; no read endpoint) — the ABAP-level table/API choices are
 * unchanged from the original per-call-generated bridge this replaced; see
 * builtin/fpm.ts's header for the sandbox evidence behind them.
 *
 * `runFpmRead` maps a query onto a `dispatch()` call and rebuilds the same
 * `FpmTranscriptResult`/`FpmReadResult` shape the original bridge produced,
 * so `src/tools/fpm.ts`'s response builders need no changes.
 */
import type { AbapConnection } from "./connection.js";
import { AbapError, isAbapError } from "./errors.js";
import { assertPlainName, ERR_LINE_PREFIX } from "./run.js";
import type { SafetyGate } from "../safety.js";
import { dispatch } from "./fluid/dispatch.js";
import { fpmManifest, fpmSources, CONFIG_ID_LEN } from "./fluid/builtin/fpm.js";
import { manifestVersion, type LoadedFluidTool } from "./fluid/manifest.js";
import { splitEventFrames, resolveFpmEvents, type FpmEventsResolved } from "./fpm-events.js";

// ---------------------------------------------------------------------------
// Query model
// ---------------------------------------------------------------------------

export interface FpmFindQuery {
  mode: "find";
  /** Already-resolved NUMC2 string, e.g. "00" or "02". */
  configType: string;
  /** Component-scope only — caller must not set this together with configType "02". */
  component?: string;
  /** Raw query pattern, `*` wildcard, not yet SQL-escaped. */
  queryPattern?: string;
  package?: string;
}

export interface FpmOutlineQuery {
  mode: "outline";
  configId: string;
  configType: string;
  configVar: string;
}

export interface FpmAppQuery {
  mode: "app";
  configId: string;
  resolve: boolean;
}

export interface FpmEventsQuery {
  mode: "events";
  configId: string;
  configType: string;
  configVar: string;
  /** Restrict referenced-config reads to this config_id (case-insensitive on the ABAP side). */
  uibb?: string;
  /** Also fetch the CL_FPM_EVENT catalogue and, per referenced BOPF BO, its node/action catalogue. */
  resolve: boolean;
}

/** Issue #155: internal only — not reachable from FpmReadInput's `mode` enum (src/tools/fpm.ts). */
export interface FpmResolveQuery {
  mode: "resolve";
  configId: string;
}

export type FpmBridgeQuery = FpmFindQuery | FpmOutlineQuery | FpmAppQuery | FpmEventsQuery | FpmResolveQuery;

// ---------------------------------------------------------------------------
// Validation — kept for `fpm-lock.ts` (config_id/config_var share the same
// field widths) and for `tools/fpm.ts`'s zero-network preflight refusal.
// ---------------------------------------------------------------------------

// CONFIG_ID_LEN is defined in fluid/builtin/fpm.ts (the low-level module both
// this file and the builtin manifest depend on) and re-exported here so
// `fpm-lock.ts` and other existing callers keep importing it from this path.
export { CONFIG_ID_LEN };
const CONFIG_VAR_MAX = 6;

export function assertConfigId(value: string): string {
  const v = assertPlainName(value, "config_id");
  if (v.length > CONFIG_ID_LEN) {
    throw new AbapError(
      "BAD_INPUT",
      `config_id "${value}" is ${v.length} characters long; WDY_CONFIG_ID is CHAR${CONFIG_ID_LEN}.`,
      { value },
    );
  }
  return v;
}

export function assertConfigVar(value: string | undefined): string {
  const v = (value ?? "").trim();
  if (v === "") return "";
  if (!/^[A-Za-z0-9_]{1,6}$/.test(v) || v.length > CONFIG_VAR_MAX) {
    throw new AbapError(
      "BAD_INPUT",
      `config_var "${value}" must be up to ${CONFIG_VAR_MAX} letters/digits/underscore.`,
      { value },
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// dispatch() plumbing
// ---------------------------------------------------------------------------

const FPM_TOOLS: ReadonlyMap<string, LoadedFluidTool> = new Map([
  [
    "fpm",
    {
      manifest: fpmManifest,
      origin: "builtin",
      sources: fpmSources,
      version: manifestVersion(fpmManifest, fpmSources),
    } as const,
  ],
]);

/** Omits undefined-valued keys entirely rather than passing `undefined` through to `dispatch()`'s schema validation. */
function fpmDispatchArgs(query: FpmBridgeQuery): Record<string, unknown> {
  switch (query.mode) {
    case "find":
      return {
        config_type: query.configType,
        ...(query.component !== undefined ? { component: query.component } : {}),
        ...(query.queryPattern !== undefined ? { query: query.queryPattern } : {}),
        ...(query.package !== undefined ? { package: query.package } : {}),
      };
    case "outline":
      return { config_id: query.configId, config_type: query.configType, config_var: query.configVar };
    case "app":
      return { config_id: query.configId, resolve: query.resolve };
    case "events":
      return {
        config_id: query.configId,
        config_type: query.configType,
        config_var: query.configVar,
        ...(query.uibb !== undefined ? { uibb: query.uibb } : {}),
        resolve: query.resolve,
      };
    case "resolve":
      return { config_id: query.configId };
  }
}

// ---------------------------------------------------------------------------
// Result model (unchanged shape from the per-call-bridge era — tools/fpm.ts's
// response builders consume this directly)
// ---------------------------------------------------------------------------

export interface FpmConfigRow {
  configId: string;
  configType: string;
  configVar: string;
  component: string;
  description: string;
  devclass?: string;
  /** Issue #155: cheap existence check only — true when mode=app is expected to load this row. */
  loadable?: boolean;
  /** Issue #155: config_id to pass to mode=app; empty when nothing loadable was found. */
  appConfigId?: string;
  /** Issue #155: the component config (WDY_CONFIG_DATA, config_type 00) this row resolves to or is. */
  componentConfigId?: string;
  /** Issue #155: why loadable is false; empty when loadable is true. */
  reason?: string;
}

export interface FpmAppNode {
  nodePath: string;
  parentPath: string;
  isTopNode: boolean;
  nodeName: string;
  description: string;
  componentName: string;
  interfaceView: string;
  configId: string;
  configType: string;
  configVar: string;
  targetConfigId: string;
  isConfigurable: boolean;
  isCustomized: boolean;
  isEnhanced: boolean;
  isFreestyleUibb: boolean;
  isLeaf: boolean;
  resolved?: {
    xmlLen: number;
    feederHint: boolean;
    bopfHint: boolean;
    excerpt?: string;
  };
}

export interface FpmTranscriptResult {
  count?: number;
  configs: FpmConfigRow[];
  outlineXml?: string;
  outlineMeta?: {
    configIdPar: string;
    configTypePar: string;
    configVarPar: string;
    component: string;
    devclass: string;
  };
  appNodes: FpmAppNode[];
  events?: FpmEventsResolved;
  /** Issue #155: populated only for mode="resolve" (internal — see FpmResolveQuery). */
  resolve?: FpmResolveResult;
  diagnostics: string[];
  droppedLines: number;
}

export interface FpmReadResult {
  query: FpmBridgeQuery;
  bridgeClass: string;
  bridgeRefreshed: boolean;
  durationMs: number;
  transcript: FpmTranscriptResult;
  outputComplete: boolean;
  bodyBytes: number;
}

const EMPTY_TRANSCRIPT: Omit<FpmTranscriptResult, "diagnostics"> = {
  count: undefined,
  configs: [],
  outlineXml: undefined,
  outlineMeta: undefined,
  appNodes: [],
  droppedLines: 0,
};

/**
 * `outline`'s not-found case is a genuine `err()` failure in the fluid body
 * (builtin/fpm.ts's header explains why), unlike legacy's silent empty-XML
 * result. Narrowly matches the two not-found frame shapes builtin/fpm.ts's
 * `outline` method actually produces, and reconstructs the same diagnostic
 * line text legacy's `parseFpmTranscript` used to capture, so the rendered
 * "no XML content" response (buildOutlineResponse) stays byte-for-byte the
 * same. Any other `FLUID_ACTION_FAILED` (or any other error) is rethrown.
 */
function outlineNotFoundDiagnostic(e: unknown): string | undefined {
  if (!isAbapError(e) || e.code !== "FLUID_ACTION_FAILED") return undefined;
  const frames = e.details["frames"];
  if (!Array.isArray(frames) || frames.length !== 1) return undefined;
  const frame = frames[0] as { kind?: unknown; step?: unknown; text?: unknown };
  if (frame.kind === "subrc" && frame.step === "select" && typeof frame.text === "string") {
    return `${ERR_LINE_PREFIX}${frame.text}`;
  }
  if (frame.kind === "exception" && frame.step === "read_comp_config_from_db" && typeof frame.text === "string") {
    return `${ERR_LINE_PREFIX}READ_COMP_CONFIG_FROM_DB FAILED ${frame.text}`;
  }
  return undefined;
}

/**
 * Issue #155: `app`'s fluid body (builtin/fpm.ts) calls `err()` exactly once,
 * with `iv_step = 'load_configuration'`, when CL_FPM_CFG_HRCHY_BRWSR_ASSIST's
 * `load_configuration` raises — that's the one case `src/tools/fpm.ts`'s
 * mode=app flow needs to distinguish from every other failure, to decide
 * whether to fall back to a `resolve` dispatch. Mirrors
 * `outlineNotFoundDiagnostic`'s way of reading `details.frames`, but searches
 * the whole array (not just a single frame) since it's matching by step, not
 * by position.
 */
export function appLoadFailure(e: unknown): { text: string } | undefined {
  if (!isAbapError(e) || e.code !== "FLUID_ACTION_FAILED") return undefined;
  const frames = e.details["frames"];
  if (!Array.isArray(frames)) return undefined;
  for (const f of frames) {
    if (typeof f !== "object" || f === null) continue;
    const frame = f as { step?: unknown; text?: unknown };
    if (frame.step === "load_configuration" && typeof frame.text === "string") {
      return { text: frame.text };
    }
  }
  return undefined;
}

interface FpmFindRow {
  config_id: string;
  config_type: string;
  config_var: string;
  component: string;
  description: string;
  devclass: string;
  loadable?: boolean;
  app_config_id?: string;
  component_config_id?: string;
  reason?: string;
}

function isFpmFindRow(v: unknown): v is FpmFindRow {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (
    typeof r["config_id"] !== "string" ||
    typeof r["config_type"] !== "string" ||
    typeof r["config_var"] !== "string" ||
    typeof r["component"] !== "string" ||
    typeof r["description"] !== "string" ||
    typeof r["devclass"] !== "string"
  ) {
    return false;
  }
  if (r["loadable"] !== undefined && typeof r["loadable"] !== "boolean") return false;
  if (r["app_config_id"] !== undefined && typeof r["app_config_id"] !== "string") return false;
  if (r["component_config_id"] !== undefined && typeof r["component_config_id"] !== "string") return false;
  if (r["reason"] !== undefined && typeof r["reason"] !== "string") return false;
  return true;
}

interface FpmOutlineResult {
  config_id: string;
  config_type: string;
  config_var: string;
  xml: string;
  meta: {
    config_idpar: string;
    config_typepar: string;
    config_varpar: string;
    component: string;
    devclass: string;
  };
}

function isFpmOutlineResult(v: unknown): v is FpmOutlineResult {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (
    typeof r["config_id"] !== "string" ||
    typeof r["config_type"] !== "string" ||
    typeof r["config_var"] !== "string" ||
    typeof r["xml"] !== "string" ||
    typeof r["meta"] !== "object" ||
    r["meta"] === null
  ) {
    return false;
  }
  const m = r["meta"] as Record<string, unknown>;
  return (
    typeof m["config_idpar"] === "string" &&
    typeof m["config_typepar"] === "string" &&
    typeof m["config_varpar"] === "string" &&
    typeof m["component"] === "string" &&
    typeof m["devclass"] === "string"
  );
}

/** Issue #155: mapped result of the internal "resolve" action (see FpmResolveQuery). */
export interface FpmResolveResult {
  configId: string;
  existsAsApp: boolean;
  existsAsComponent: boolean;
  component: string;
  componentConfigVar: string;
  applicationConfigs: Array<{ configId: string; application: string; configVar: string }>;
  truncated: boolean;
}

interface FpmResolveRawResult {
  config_id: string;
  exists_as_app: boolean;
  exists_as_component: boolean;
  component: string;
  component_config_var: string;
  application_configs: Array<{ config_id: string; application: string; config_var: string }>;
  truncated: boolean;
}

function isFpmResolveResult(v: unknown): v is FpmResolveRawResult {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (
    typeof r["config_id"] !== "string" ||
    typeof r["exists_as_app"] !== "boolean" ||
    typeof r["exists_as_component"] !== "boolean" ||
    typeof r["component"] !== "string" ||
    typeof r["component_config_var"] !== "string" ||
    typeof r["truncated"] !== "boolean" ||
    !Array.isArray(r["application_configs"])
  ) {
    return false;
  }
  return r["application_configs"].every((a) => {
    if (typeof a !== "object" || a === null) return false;
    const ar = a as Record<string, unknown>;
    return (
      typeof ar["config_id"] === "string" && typeof ar["application"] === "string" && typeof ar["config_var"] === "string"
    );
  });
}

interface FpmAppNodeResult {
  node_path: string;
  parent_path: string;
  is_top_node: boolean;
  node_name: string;
  description: string;
  component_name: string;
  interface_view: string;
  config_id: string;
  config_type: string;
  config_var: string;
  target_config_id: string;
  is_configurable: boolean;
  is_customized: boolean;
  is_enhanced: boolean;
  is_freestyle_uibb: boolean;
  is_leaf: boolean;
  resolved?: { xml_len: number; feeder_hint: boolean; bopf_hint: boolean; excerpt?: string };
  resolve_error?: string;
}

/** Kept in lockstep with fpmManifest's "events" action output.items.properties.kind enum (fluid/builtin/fpm.ts) and splitEventFrames's own switch (fpm-events.ts). */
const FPM_EVENTS_FRAME_KINDS: ReadonlySet<string> = new Set([
  "config",
  "fpm_event",
  "fpm_event_error",
  "bopf_node",
  "bopf_action",
  "bopf_error",
  "text_id",
  "text_id_error",
  "summary",
]);

function isFpmEventsFrame(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const kind = (v as Record<string, unknown>)["kind"];
  return typeof kind === "string" && FPM_EVENTS_FRAME_KINDS.has(kind);
}

function isFpmAppNodeResult(v: unknown): v is FpmAppNodeResult {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["node_path"] === "string" &&
    typeof r["parent_path"] === "string" &&
    typeof r["is_top_node"] === "boolean" &&
    typeof r["node_name"] === "string" &&
    typeof r["description"] === "string" &&
    typeof r["component_name"] === "string" &&
    typeof r["interface_view"] === "string" &&
    typeof r["config_id"] === "string" &&
    typeof r["config_type"] === "string" &&
    typeof r["config_var"] === "string" &&
    typeof r["target_config_id"] === "string" &&
    typeof r["is_configurable"] === "boolean" &&
    typeof r["is_customized"] === "boolean" &&
    typeof r["is_enhanced"] === "boolean" &&
    typeof r["is_freestyle_uibb"] === "boolean" &&
    typeof r["is_leaf"] === "boolean"
  );
}

export async function runFpmRead(
  conn: AbapConnection,
  query: FpmBridgeQuery,
  gate: SafetyGate,
): Promise<FpmReadResult> {
  const started = Date.now();

  let res;
  try {
    res = await dispatch(
      { conn, cfg: conn.cfg, gate, tools: FPM_TOOLS },
      {
        tool: "fpm",
        action: query.mode,
        args: fpmDispatchArgs(query),
        // Names the MCP-facing tool/action in a FLUID_API_DISABLED refusal — see FluidRunRequest.caller's doc.
        caller: { tool: "abap_fpm_read", action: query.mode },
      },
    );
  } catch (e) {
    if (query.mode === "outline") {
      const diagnostic = outlineNotFoundDiagnostic(e);
      if (diagnostic !== undefined) {
        return {
          query,
          bridgeClass: fpmManifest.entry,
          bridgeRefreshed: false,
          durationMs: Date.now() - started,
          transcript: { ...EMPTY_TRANSCRIPT, diagnostics: [diagnostic] },
          outputComplete: true,
          bodyBytes: 0,
        };
      }
    }
    throw e;
  }

  let transcript: FpmTranscriptResult;
  switch (query.mode) {
    case "find": {
      if (!Array.isArray(res.result) || !res.result.every(isFpmFindRow)) {
        throw new AbapError(
          "FLUID_PROTOCOL_ERROR",
          "fpm.find returned a result that does not match the declared array-of-row schema.",
          { tool: "fpm", action: "find", result: res.result },
        );
      }
      const rows = res.result;
      transcript = {
        // The fluid body applies the `package` filter inside the same loop
        // that emits each row (builtin/fpm.ts), so — unlike the legacy
        // bridge's COUNT, taken before that filter — this count and the
        // number of emitted rows can never diverge: there is no separate
        // pre-filter total to report any more.
        count: rows.length,
        configs: rows.map((r) => ({
          configId: r.config_id,
          configType: r.config_type,
          configVar: r.config_var,
          component: r.component,
          description: r.description,
          devclass: r.devclass,
          loadable: r.loadable,
          appConfigId: r.app_config_id,
          componentConfigId: r.component_config_id,
          reason: r.reason,
        })),
        outlineXml: undefined,
        outlineMeta: undefined,
        appNodes: [],
        diagnostics: [],
        droppedLines: 0,
      };
      break;
    }
    case "outline": {
      if (!isFpmOutlineResult(res.result)) {
        throw new AbapError(
          "FLUID_PROTOCOL_ERROR",
          "fpm.outline returned a result that does not match the declared object schema.",
          { tool: "fpm", action: "outline", result: res.result },
        );
      }
      const r = res.result;
      transcript = {
        count: undefined,
        configs: [],
        outlineXml: r.xml,
        outlineMeta: {
          configIdPar: r.meta.config_idpar,
          configTypePar: r.meta.config_typepar,
          configVarPar: r.meta.config_varpar,
          component: r.meta.component,
          devclass: r.meta.devclass,
        },
        appNodes: [],
        diagnostics: [],
        droppedLines: 0,
      };
      break;
    }
    case "app": {
      if (!Array.isArray(res.result) || !res.result.every(isFpmAppNodeResult)) {
        throw new AbapError(
          "FLUID_PROTOCOL_ERROR",
          "fpm.app returned a result that does not match the declared array-of-node schema.",
          { tool: "fpm", action: "app", result: res.result },
        );
      }
      const nodes = res.result;
      const diagnostics: string[] = [];
      const appNodes: FpmAppNode[] = nodes.map((n) => {
        if (n.resolve_error !== undefined) {
          diagnostics.push(`${ERR_LINE_PREFIX}RESOLVE ${n.node_path} FAILED ${n.resolve_error}`);
        }
        return {
          nodePath: n.node_path,
          parentPath: n.parent_path,
          isTopNode: n.is_top_node,
          nodeName: n.node_name,
          description: n.description,
          componentName: n.component_name,
          interfaceView: n.interface_view,
          configId: n.config_id,
          configType: n.config_type,
          configVar: n.config_var,
          targetConfigId: n.target_config_id,
          isConfigurable: n.is_configurable,
          isCustomized: n.is_customized,
          isEnhanced: n.is_enhanced,
          isFreestyleUibb: n.is_freestyle_uibb,
          isLeaf: n.is_leaf,
          resolved: n.resolved
            ? {
                xmlLen: n.resolved.xml_len,
                feederHint: n.resolved.feeder_hint,
                bopfHint: n.resolved.bopf_hint,
                excerpt: n.resolved.excerpt,
              }
            : undefined,
        };
      });
      transcript = {
        count: nodes.length,
        configs: [],
        outlineXml: undefined,
        outlineMeta: undefined,
        appNodes,
        diagnostics,
        droppedLines: 0,
      };
      break;
    }
    case "events": {
      if (!Array.isArray(res.result) || !res.result.every(isFpmEventsFrame)) {
        throw new AbapError(
          "FLUID_PROTOCOL_ERROR",
          "fpm.events returned a result that does not match the declared array-of-frame schema.",
          { tool: "fpm", action: "events", result: res.result },
        );
      }
      const raw = splitEventFrames(res.result);
      const events = resolveFpmEvents(raw);
      transcript = {
        count: undefined,
        configs: [],
        outlineXml: undefined,
        outlineMeta: undefined,
        appNodes: [],
        events,
        diagnostics: raw.unrecognised.length
          ? [`${ERR_LINE_PREFIX}EVENTS ${raw.unrecognised.length} unrecognised frame(s) — protocol drift, see bodyBytes/raw result.`]
          : [],
        droppedLines: 0,
      };
      break;
    }
    case "resolve": {
      if (!isFpmResolveResult(res.result)) {
        throw new AbapError(
          "FLUID_PROTOCOL_ERROR",
          "fpm.resolve returned a result that does not match the declared object schema.",
          { tool: "fpm", action: "resolve", result: res.result },
        );
      }
      const r = res.result;
      transcript = {
        count: undefined,
        configs: [],
        outlineXml: undefined,
        outlineMeta: undefined,
        appNodes: [],
        resolve: {
          configId: r.config_id,
          existsAsApp: r.exists_as_app,
          existsAsComponent: r.exists_as_component,
          component: r.component,
          componentConfigVar: r.component_config_var,
          applicationConfigs: r.application_configs.map((a) => ({
            configId: a.config_id,
            application: a.application,
            configVar: a.config_var,
          })),
          truncated: r.truncated,
        },
        diagnostics: [],
        droppedLines: 0,
      };
      break;
    }
  }

  return {
    query,
    bridgeClass: fpmManifest.entry,
    bridgeRefreshed: res.deployed,
    durationMs: Date.now() - started,
    transcript,
    outputComplete: !res.truncated,
    bodyBytes: Buffer.byteLength(JSON.stringify(res.result), "utf8"),
  };
}
