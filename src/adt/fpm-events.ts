/**
 * Semantic resolution for the fluid `fpm` tool's `events` action
 * (`src/adt/fluid/builtin/fpm.ts`). The ABAP side only gathers data — one
 * config's XML, its referenced configs' XML, and (if `resolve` was passed)
 * the standard `CL_FPM_EVENT` catalogue plus any referenced BOPF BO's
 * node/action catalogue. Every semantic judgement ("this toolbar button
 * raises FPM_SAVE, which is a standard event" / "this button is BOPF-backed
 * because its target config declares a BO parameter") happens here, in pure
 * TypeScript, from the raw JSON frames.
 *
 * Pure module: no network, no `adt/connection` import. `splitEventFrames`
 * takes the raw frame array `dispatch()` returns for the `events` action
 * (one element per OUT/OUTE frame, see `fluid/dispatch.ts`); `resolveFpmEvents`
 * takes that split and does the rest. Both are unit-testable directly against
 * a captured transcript or a fixture's `.config.xml` wrapped into a frame,
 * without a live system.
 *
 * XML shape knowledge (`Component` > `Node[Name=...]` > `Item` > leaf
 * elements / further `Node`s) comes from five captured fixtures under
 * `test/fixtures/fpm-events/` and `test/fixtures/fpm/` — see the pointers
 * on each `collect*` function below. Child element order is NOT stable and
 * Items may omit children entirely, so every lookup here is by name, never
 * by position, and every field access tolerates "absent".
 */
import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// Raw frames — mirrors fpmManifest's "events" action output exactly
// (fluid/builtin/fpm.ts). Kept separate from the resolved model below: this
// section is "what the ABAP said", the rest of the file is "what it means".
// ---------------------------------------------------------------------------

export interface FpmEventsConfigFrame {
  kind: "config";
  role: "root" | "child";
  ref_node?: string;
  config_id: string;
  config_type: string;
  config_var: string;
  component?: string;
  devclass?: string;
  xml?: string;
  skipped?: string;
  read_error?: string;
}

export interface FpmEventsCatalogueFrame {
  kind: "fpm_event";
  name: string;
  event_id: string;
}

export interface FpmEventsCatalogueErrorFrame {
  kind: "fpm_event_error";
  text: string;
}

export interface FpmEventsBopfNodeFrame {
  kind: "bopf_node";
  bo: string;
  node_name: string;
  node_key: string;
  bo_key: string;
}

export interface FpmEventsBopfActionFrame {
  kind: "bopf_action";
  bo: string;
  act_name: string;
  act_key: string;
  node_key: string;
  act_class: string;
  act_cat: string;
}

export interface FpmEventsBopfErrorFrame {
  kind: "bopf_error";
  bo: string;
  text: string;
}

export interface FpmEventsSummaryFrame {
  kind: "summary";
  configs_read: number;
  configs_failed: number;
  configs_skipped: number;
  bopf_nodes: number;
  bopf_actions: number;
  fpm_events: number;
  truncated: string;
}

export type FpmEventsFrame =
  | FpmEventsConfigFrame
  | FpmEventsCatalogueFrame
  | FpmEventsCatalogueErrorFrame
  | FpmEventsBopfNodeFrame
  | FpmEventsBopfActionFrame
  | FpmEventsBopfErrorFrame
  | FpmEventsSummaryFrame;

export interface FpmEventsRaw {
  configs: FpmEventsConfigFrame[];
  fpmEvents: FpmEventsCatalogueFrame[];
  fpmEventErrors: FpmEventsCatalogueErrorFrame[];
  bopfNodes: FpmEventsBopfNodeFrame[];
  bopfActions: FpmEventsBopfActionFrame[];
  bopfErrors: FpmEventsBopfErrorFrame[];
  summary?: FpmEventsSummaryFrame;
  /** Frames whose "kind" didn't match anything above — a protocol drift, not swallowed silently. */
  unrecognised: unknown[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Buckets `dispatch()`'s raw `result` array (every OUT/OUTE frame, in
 * document order — `action.output.type === "array"`, see `fluid/dispatch.ts`)
 * by `kind`. Never throws on an unexpected shape: an unrecognised frame is
 * collected in `unrecognised` rather than dropped, so a protocol drift
 * upstream is visible instead of silently losing rows.
 */
export function splitEventFrames(values: readonly unknown[]): FpmEventsRaw {
  const raw: FpmEventsRaw = {
    configs: [],
    fpmEvents: [],
    fpmEventErrors: [],
    bopfNodes: [],
    bopfActions: [],
    bopfErrors: [],
    summary: undefined,
    unrecognised: [],
  };

  for (const v of values) {
    if (!isRecord(v) || typeof v["kind"] !== "string") {
      raw.unrecognised.push(v);
      continue;
    }
    switch (v["kind"]) {
      case "config":
        raw.configs.push(v as unknown as FpmEventsConfigFrame);
        break;
      case "fpm_event":
        raw.fpmEvents.push(v as unknown as FpmEventsCatalogueFrame);
        break;
      case "fpm_event_error":
        raw.fpmEventErrors.push(v as unknown as FpmEventsCatalogueErrorFrame);
        break;
      case "bopf_node":
        raw.bopfNodes.push(v as unknown as FpmEventsBopfNodeFrame);
        break;
      case "bopf_action":
        raw.bopfActions.push(v as unknown as FpmEventsBopfActionFrame);
        break;
      case "bopf_error":
        raw.bopfErrors.push(v as unknown as FpmEventsBopfErrorFrame);
        break;
      case "summary":
        raw.summary = v as unknown as FpmEventsSummaryFrame;
        break;
      default:
        raw.unrecognised.push(v);
    }
  }

  return raw;
}

// ---------------------------------------------------------------------------
// Resolved model
// ---------------------------------------------------------------------------

export interface FpmEventHandlerBopf {
  kind: "bopf";
  bo: string;
  /** Ready-to-run follow-up: `abap_bopf`'s param is `bo`, not `node`/`action` — see this file's header note on the discrepancy this corrects. */
  call: string;
}

export interface FpmEventHandlerFeeder {
  kind: "feeder";
  feederClass: string;
  configId: string;
  configType: string;
  configVar: string;
}

export interface FpmEventHandlerAppController {
  kind: "app_controller";
  component: string;
}

export interface FpmEventHandlerStandard {
  kind: "standard";
  eventId: string;
  /** Only set when `resolve=true` and this event_id was found in the fetched CL_FPM_EVENT catalogue; otherwise this is a name-prefix guess. */
  constantName?: string;
  verified: boolean;
}

export interface FpmEventHandlerUnresolved {
  kind: "unresolved";
  reason: string;
}

export type FpmEventHandler =
  | FpmEventHandlerBopf
  | FpmEventHandlerFeeder
  | FpmEventHandlerAppController
  | FpmEventHandlerStandard
  | FpmEventHandlerUnresolved;

export interface FpmEventRow {
  /** The config whose XML this toolbar element was found in. */
  configId: string;
  configType: string;
  configVar: string;
  source: "toolbar" | "uibb_toolbar" | "button_row" | "fbi_action";
  elementId: string;
  /** Raw TEXT/HEADER value — often a bare number (a WDY_CONFIG_DATT/_APPT text-table key), see the module note below. */
  text?: string;
  /** Decoded TYPE/DISPLAY_TYPE label, e.g. "Button", "Toggle Button" — the raw code if not in the known domain values. */
  elementType?: string;
  eventId?: string;
  handler: FpmEventHandler;
}

export interface FpmWireRow {
  configId: string;
  configType: string;
  configVar: string;
  component: string;
  srcConfigId: string;
  srcConfigType: string;
  srcConfigVar: string;
  srcComponent: string;
  connector: string;
  portType: string;
  portIdentifier: string;
  primaryAttribute: string;
}

export interface FpmEventsResolved {
  root: {
    configId: string;
    configType: string;
    configVar: string;
    component: string;
    devclass: string;
  };
  /** From the first APP_SPECIFIC_CC found across root+children, if any. */
  appController?: { component: string; configId: string; configType: string; configVar: string };
  wires: FpmWireRow[];
  /** config_id of every config (root + children) whose XML was actually parsed. */
  views: string[];
  events: FpmEventRow[];
  unreadable: { configId: string; configType: string; configVar: string; error: string }[];
  skipped: { configId: string; configType: string; configVar: string }[];
  notes: string[];
  truncated: string;
}

// ---------------------------------------------------------------------------
// XML walking — one parser instance, this codebase's per-module convention
// (see bopf-xml.ts, ddic.ts, aunit.ts, ...).
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
});

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** fast-xml-parser: a plain leaf is a bare string; a leaf with attributes (e.g. `Transl="true"`) becomes `{ "@_Transl": "true", "#text": "..." }`; an EMPTY attributed leaf has no `#text` at all. All three normalise to "". */
function text(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (isRecord(v)) {
    const t = v["#text"];
    return typeof t === "string" ? t : "";
  }
  return String(v);
}

function items(node: unknown): Record<string, unknown>[] {
  if (!isRecord(node)) return [];
  return asArray(node["Item"] as Record<string, unknown> | Record<string, unknown>[] | undefined).filter(isRecord);
}

/**
 * Every `Node`/`Item` descendant named `name`, at any depth — mirrors the
 * ABAP side's own generic `walk_refs`/`walk_bo` recursion (fluid/builtin/fpm.ts):
 * neither side assumes a fixed nesting depth, since UIBB_TOOLBAR/TOOLBAR and
 * BUTTON_ROW can sit under an arbitrary chain of Node/Item ancestors
 * depending on floorplan/UIBB kind.
 */
function findAllNodesByName(el: unknown, name: string, acc: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!isRecord(el)) return acc;
  for (const node of asArray(el["Node"] as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
    if (!isRecord(node)) continue;
    if (node["@_Name"] === name) acc.push(node);
    findAllNodesByName(node, name, acc);
  }
  for (const item of items(el)) {
    findAllNodesByName(item, name, acc);
  }
  return acc;
}

function parseConfigXml(xml: string): Record<string, unknown> | undefined {
  if (!xml.trim()) return undefined;
  try {
    const doc = xmlParser.parse(xml) as unknown;
    if (!isRecord(doc)) return undefined;
    const root = doc["Component"];
    return isRecord(root) ? root : undefined;
  } catch {
    // Malformed/unexpected XML — treated the same as "nothing found", not a hard failure:
    // this module never raises on a config it can't fully parse, it just resolves less.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Shape 1: OVP floorplan toolbar, and its per-UIBB alias UIBB_TOOLBAR/
// UIBB_BUTTON/UIBB_BUTTON_SUB_ITEM (same structural shape, different Node
// names) — test/fixtures/fpm-events/ovp-test-fbi-sales-order.config.xml,
// ovp-appcc-class.config.xml.
// ---------------------------------------------------------------------------

interface ToolbarButtonRaw {
  source: "toolbar" | "uibb_toolbar";
  elementId: string;
  text: string;
  type: string;
  actionIds: string[];
}

const FPM_BUTTON_TYPE: Readonly<Record<string, string>> = {
  BU: "Button",
  TB: "Toggle Button",
  BC: "Button Choice",
  LA: "Link To Action",
};

function collectToolbarButtons(root: Record<string, unknown>): ToolbarButtonRaw[] {
  const rows: ToolbarButtonRaw[] = [];
  const variants: readonly [string, string, string, ToolbarButtonRaw["source"]][] = [
    ["TOOLBAR", "BUTTON", "BUTTON_SUB_ITEM", "toolbar"],
    ["UIBB_TOOLBAR", "UIBB_BUTTON", "UIBB_BUTTON_SUB_ITEM", "uibb_toolbar"],
  ];
  for (const [toolbarName, buttonName, subName, source] of variants) {
    for (const toolbarNode of findAllNodesByName(root, toolbarName)) {
      for (const buttonNode of findAllNodesByName(toolbarNode, buttonName)) {
        for (const buttonItem of items(buttonNode)) {
          const elementId = text(buttonItem["ELEMENT_ID"]);
          const subActionIds = findAllNodesByName(buttonItem, subName)
            .flatMap((n) => items(n))
            .map((i) => text(i["ACTION_ID"]))
            .filter((id) => id !== "");
          rows.push({
            source,
            elementId,
            text: text(buttonItem["TEXT"]),
            type: text(buttonItem["TYPE"]),
            actionIds: subActionIds.length ? subActionIds : elementId ? [elementId] : [],
          });
        }
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Shape 2: GUIBB button row — BUTTON_ROW/BUTTON_ROW_ELEMENT/BUTTON_ACTION.
// test/fixtures/fpm-events/list-uibb-test-sales-order-item.config.xml.
// ---------------------------------------------------------------------------

interface ButtonRowRaw {
  elementId: string;
  text: string;
  displayType: string;
  events: { eventId: string; text: string }[];
}

const FPMGB_DISPLAY_TYPE: Readonly<Record<string, string>> = {
  BT: "Button",
  TB: "Toggle Button",
  BC: "Button-Choice",
  SE: "Separator",
  LA: "Link to Action",
};

function collectButtonRows(root: Record<string, unknown>): ButtonRowRaw[] {
  const rows: ButtonRowRaw[] = [];
  for (const rowNode of findAllNodesByName(root, "BUTTON_ROW")) {
    for (const elNode of findAllNodesByName(rowNode, "BUTTON_ROW_ELEMENT")) {
      for (const elItem of items(elNode)) {
        const events = findAllNodesByName(elItem, "BUTTON_ACTION")
          .flatMap((n) => items(n))
          .map((i) => ({ eventId: text(i["EVENT_ID"]), text: text(i["TEXT"]) }));
        rows.push({
          elementId: text(elItem["ELEMENT_ID"]),
          text: text(elItem["TEXT"]),
          displayType: text(elItem["DISPLAY_TYPE"]),
          events,
        });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Shape 3: FBI view action mapping — CONFIGURATION_CONTEXT/ACTIONS.
// test/fixtures/fpm/36-BOFU_DEMO_SO_HDR_VIEW.full-config.xml.
// ---------------------------------------------------------------------------

interface FbiActionRaw {
  actionId: string;
  actionImpl: string;
  actionConf: string;
  text: string;
  tooltip: string;
  enabled: string;
  navRole: string;
}

function collectFbiActions(root: Record<string, unknown>): FbiActionRaw[] {
  const rows: FbiActionRaw[] = [];
  for (const ctxNode of findAllNodesByName(root, "CONFIGURATION_CONTEXT")) {
    for (const ctxItem of items(ctxNode)) {
      for (const actionsNode of findAllNodesByName(ctxItem, "ACTIONS")) {
        for (const item of items(actionsNode)) {
          rows.push({
            actionId: text(item["ACTIONID"]),
            actionImpl: text(item["ACTION_IMPL"]),
            actionConf: text(item["ACTION_CONF"]),
            text: text(item["TEXT"]),
            tooltip: text(item["TOOLTIP"]),
            enabled: text(item["ENABLED"]),
            navRole: text(item["NAV_ROLE"]),
          });
        }
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Standard ACTION catalogue (ELEMENT_ID/ACTION_ID -> EVENT_ID + optional
// handler target) — every fixture with a TOOLBAR/UIBB_TOOLBAR has one.
// ---------------------------------------------------------------------------

interface ActionCatalogueRow {
  id: string;
  eventId: string;
  component: string;
  configId: string;
  configType: string;
  configVar: string;
}

function collectActions(root: Record<string, unknown>): ActionCatalogueRow[] {
  const rows: ActionCatalogueRow[] = [];
  for (const actionNode of findAllNodesByName(root, "ACTION")) {
    for (const item of items(actionNode)) {
      rows.push({
        id: text(item["ID"]),
        eventId: text(item["EVENT_ID"]),
        component: text(item["COMPONENT"]),
        configId: text(item["CONFIG_ID"]),
        configType: text(item["CONFIG_TYPE"]),
        configVar: text(item["CONFIG_VAR"]),
      });
    }
  }
  return rows;
}

/**
 * SAP appends a generated "_<n>" counter to a standard button's own ACTION
 * catalogue ID (e.g. toolbar ACTION_ID "FPM_SAVE" is catalogued under ID
 * "FPM_SAVE_1", EVENT_ID "FPM_SAVE") — confirmed in
 * ovp-appcc-class.config.xml. Exact ID match is tried first; this is the
 * fallback for that generated-counter case only, never used the other way
 * around (a real ID never has ITS OWN suffix stripped to look for a match).
 */
function stripCounterSuffix(id: string): string {
  return id.replace(/_\d+$/, "");
}

function findAction(actions: ActionCatalogueRow[], actionId: string): ActionCatalogueRow | undefined {
  return actions.find((a) => a.id === actionId) ?? actions.find((a) => stripCounterSuffix(a.id) === actionId);
}

// ---------------------------------------------------------------------------
// WIRE_MODEL/WIRE and APP_SPECIFIC_CC — test/fixtures/fpm-events/
// ovp-test-fbi-sales-order.config.xml (WIRE with a UIBB target),
// ovp-appcc-class.config.xml (WIRE with a class-only, blank-CONFIG_ID target).
// ---------------------------------------------------------------------------

function collectWires(root: Record<string, unknown>): FpmWireRow[] {
  const rows: FpmWireRow[] = [];
  for (const wmNode of findAllNodesByName(root, "WIRE_MODEL")) {
    for (const wireNode of findAllNodesByName(wmNode, "WIRE")) {
      for (const item of items(wireNode)) {
        rows.push({
          configId: text(item["CONFIG_ID"]),
          configType: text(item["CONFIG_TYPE"]),
          configVar: text(item["CONFIG_VAR"]),
          component: text(item["COMPONENT"]),
          srcConfigId: text(item["SRC_CONFIG_ID"]),
          srcConfigType: text(item["SRC_CONFIG_TYPE"]),
          srcConfigVar: text(item["SRC_CONFIG_VAR"]),
          srcComponent: text(item["SRC_COMPONENT"]),
          connector: text(item["CONNECTOR"]),
          portType: text(item["PORT_TYPE"]),
          portIdentifier: text(item["PORT_IDENTIFIER"]),
          primaryAttribute: text(item["FPM_PRIMARY_ATTRIBUTE"]),
        });
      }
    }
  }
  return rows;
}

function collectAppSpecificCC(
  root: Record<string, unknown>,
): { component: string; configId: string; configType: string; configVar: string } | undefined {
  for (const node of findAllNodesByName(root, "APP_SPECIFIC_CC")) {
    for (const item of items(node)) {
      return {
        component: text(item["COMPONENT"]),
        configId: text(item["CONFIG_ID"]),
        configType: text(item["CONFIG_TYPE"]),
        configVar: text(item["CONFIG_VAR"]),
      };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// FEEDER / BO discovery — used by classifyHandler to tell "feeder" from
// "bopf" once a target config is known. test/fixtures/fpm-events/
// list-uibb-test-sales-order-item.config.xml (both FEEDER and a
// PARAMETER NAME=BO/VALUE pair in the same config);
// test/fixtures/fpm/36-BOFU_DEMO_SO_HDR_VIEW.full-config.xml (a literal
// <BO> element instead of a NAME/VALUE pair).
// ---------------------------------------------------------------------------

function collectFeeders(root: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (el: unknown): void => {
    if (!isRecord(el)) return;
    const feeder = text(el["FEEDER"]);
    if (feeder) out.push(feeder);
    for (const node of asArray(el["Node"] as Record<string, unknown> | Record<string, unknown>[] | undefined)) walk(node);
    for (const item of items(el)) walk(item);
  };
  walk(root);
  return out;
}

function collectBoNames(root: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const walk = (el: unknown): void => {
    if (!isRecord(el)) return;
    const bo = text(el["BO"]);
    if (bo) out.add(bo);
    for (const item of items(el)) {
      if (text(item["NAME"]) === "BO") {
        const value = text(item["VALUE"]);
        if (value) out.add(value);
      }
      walk(item);
    }
    for (const node of asArray(el["Node"] as Record<string, unknown> | Record<string, unknown>[] | undefined)) walk(node);
  };
  walk(root);
  return [...out];
}

// ---------------------------------------------------------------------------
// resolveFpmEvents — ties everything above together.
// ---------------------------------------------------------------------------

interface ParsedConfig {
  configId: string;
  configType: string;
  configVar: string;
  root: Record<string, unknown>;
  actions: ActionCatalogueRow[];
  toolbarButtons: ToolbarButtonRaw[];
  buttonRows: ButtonRowRaw[];
  fbiActions: FbiActionRaw[];
  wires: FpmWireRow[];
  appSpecificCC?: { component: string; configId: string; configType: string; configVar: string };
  feeders: string[];
  boNames: string[];
}

function normKey(configId: string, configType: string | undefined, configVar: string | undefined): string {
  return `${configId.trim().toUpperCase()}|${(configType || "00").trim().toUpperCase()}|${(configVar ?? "").trim().toUpperCase()}`;
}

function parseConfig(frame: { config_id: string; config_type: string; config_var: string; xml?: string }): ParsedConfig | undefined {
  const root = frame.xml ? parseConfigXml(frame.xml) : undefined;
  if (!root) return undefined;
  return {
    configId: frame.config_id,
    configType: frame.config_type || "00",
    configVar: frame.config_var,
    root,
    actions: collectActions(root),
    toolbarButtons: collectToolbarButtons(root),
    buttonRows: collectButtonRows(root),
    fbiActions: collectFbiActions(root),
    wires: collectWires(root),
    appSpecificCC: collectAppSpecificCC(root),
    feeders: collectFeeders(root),
    boNames: collectBoNames(root),
  };
}

interface HandlerTarget {
  component?: string;
  configId?: string;
  configType?: string;
  configVar?: string;
}

function classifyHandler(
  eventId: string,
  target: HandlerTarget | undefined,
  ctx: { standardEventIds: ReadonlySet<string>; standardVerified: boolean; configsByKey: ReadonlyMap<string, ParsedConfig> },
): FpmEventHandler {
  if (eventId) {
    const looksStandard = eventId.startsWith("FPM_");
    if (ctx.standardVerified ? ctx.standardEventIds.has(eventId) : looksStandard) {
      return { kind: "standard", eventId, verified: ctx.standardVerified && ctx.standardEventIds.has(eventId) };
    }
  }
  if (target?.configId) {
    const cfg = ctx.configsByKey.get(normKey(target.configId, target.configType, target.configVar));
    if (cfg) {
      const bo = cfg.boNames[0];
      if (bo) return { kind: "bopf", bo, call: `abap_bopf {"mode":"show","bo":"${bo}"}` };
      const feeder = cfg.feeders[0];
      if (feeder) {
        return {
          kind: "feeder",
          feederClass: feeder,
          configId: target.configId,
          configType: target.configType || "00",
          configVar: target.configVar ?? "",
        };
      }
      return {
        kind: "unresolved",
        reason: `target config ${target.configId} was read but declares no FEEDER and no BO parameter`,
      };
    }
    return {
      kind: "unresolved",
      reason: `target config ${target.configId} was not read (skipped by uibb filter, failed to read, or not walked) — cannot tell feeder from BOPF from app controller`,
    };
  }
  if (target?.component) {
    // A WIRE/ACTION/APP_SPECIFIC_CC target with a component but no config_id
    // is a class- or WD-component-only extension point, not a UIBB — see
    // ovp-appcc-class.config.xml's CL_FPM_WIRE_TEST_APPCC_ASSIST WIRE.
    return { kind: "app_controller", component: target.component };
  }
  return {
    kind: "unresolved",
    reason: eventId
      ? `event "${eventId}" is not a standard FPM event and has no ACTION target to follow`
      : "no ACTION catalogue entry matched this toolbar element's id",
  };
}

/**
 * Turns `splitEventFrames`'s buckets into a "which toolbar element raises
 * which event, and what handles it" model. Best-effort throughout — see the
 * per-branch comments in `classifyHandler` and the notes this function
 * attaches; nothing here has been verified against every possible FPM/FBI
 * shape, only the five fixtures cited above.
 */
export function resolveFpmEvents(raw: FpmEventsRaw): FpmEventsResolved {
  const notes: string[] = [];
  const rootFrame = raw.configs.find((c) => c.role === "root");
  if (!rootFrame) {
    throw new Error("resolveFpmEvents: no root config frame present — splitEventFrames was given an empty/invalid transcript");
  }

  const unreadable = raw.configs
    .filter((c) => c.role === "child" && c.read_error !== undefined)
    .map((c) => ({ configId: c.config_id, configType: c.config_type || "00", configVar: c.config_var, error: c.read_error ?? "" }));
  const skipped = raw.configs
    .filter((c) => c.role === "child" && c.skipped !== undefined)
    .map((c) => ({ configId: c.config_id, configType: c.config_type || "00", configVar: c.config_var }));

  const readable = raw.configs.filter((c) => c.xml !== undefined);
  const parsedConfigs: ParsedConfig[] = [];
  for (const frame of readable) {
    const parsed = parseConfig(frame);
    if (parsed) {
      parsedConfigs.push(parsed);
    } else if (frame.xml && frame.xml.trim()) {
      notes.push(`config ${frame.config_id} has XML but it could not be parsed as an fpm/fbi Component document — skipped for event resolution.`);
    }
  }

  const configsByKey = new Map<string, ParsedConfig>();
  for (const cfg of parsedConfigs) configsByKey.set(normKey(cfg.configId, cfg.configType, cfg.configVar), cfg);

  const standardEventIds = new Set(raw.fpmEvents.map((f) => f.event_id));
  const standardVerified = raw.fpmEvents.length > 0 || raw.fpmEventErrors.length > 0;
  if (!standardVerified) {
    notes.push(
      'resolve was not requested (or the CL_FPM_EVENT catalogue read produced nothing): "standard" handlers below ' +
        'are a name-prefix guess ("FPM_..." events only), not verified against the actual catalogue. Pass resolve=true for a verified match.',
    );
  } else if (raw.fpmEventErrors.length > 0) {
    notes.push(`the CL_FPM_EVENT catalogue read failed (${raw.fpmEventErrors.map((e) => e.text).join("; ")}) — "standard" handlers below are a name-prefix guess, not verified.`);
  }

  const ctx = { standardEventIds, standardVerified: standardVerified && raw.fpmEventErrors.length === 0, configsByKey };

  const wires: FpmWireRow[] = [];
  let appController: { component: string; configId: string; configType: string; configVar: string } | undefined;
  for (const cfg of parsedConfigs) {
    wires.push(...cfg.wires);
    if (!appController && cfg.appSpecificCC && (cfg.appSpecificCC.component || cfg.appSpecificCC.configId)) {
      appController = cfg.appSpecificCC;
    }
  }

  const events: FpmEventRow[] = [];

  for (const cfg of parsedConfigs) {
    for (const btn of cfg.toolbarButtons) {
      const typeLabel = FPM_BUTTON_TYPE[btn.type] ?? (btn.type ? `${btn.type} (code not decoded)` : undefined);
      const actionIds = btn.actionIds.length ? btn.actionIds : [btn.elementId];
      for (const actionId of actionIds) {
        if (!actionId) continue;
        const action = findAction(cfg.actions, actionId);
        const eventId = action?.eventId ?? "";
        const target: HandlerTarget | undefined = action
          ? { component: action.component, configId: action.configId, configType: action.configType, configVar: action.configVar }
          : undefined;
        events.push({
          configId: cfg.configId,
          configType: cfg.configType,
          configVar: cfg.configVar,
          source: btn.source,
          elementId: btn.elementId || actionId,
          text: btn.text || undefined,
          elementType: typeLabel,
          eventId: eventId || undefined,
          handler: classifyHandler(eventId, target, ctx),
        });
      }
    }

    for (const row of cfg.buttonRows) {
      const typeLabel = FPMGB_DISPLAY_TYPE[row.displayType] ?? (row.displayType ? `${row.displayType} (code not decoded)` : undefined);
      if (row.events.length === 0) {
        events.push({
          configId: cfg.configId,
          configType: cfg.configType,
          configVar: cfg.configVar,
          source: "button_row",
          elementId: row.elementId,
          text: row.text || undefined,
          elementType: typeLabel,
          handler: { kind: "unresolved", reason: "no BUTTON_ACTION child — this button row element declares no event" },
        });
        continue;
      }
      for (const ev of row.events) {
        // A GUIBB button row's own event has no COMPONENT/CONFIG_ID of its own
        // (see list-uibb-test-sales-order-item.config.xml) — it is handled by
        // the SAME config's own FEEDER/BO, so default the lookup target to
        // "this config" rather than leaving it unresolved for lack of an
        // explicit target. Confirmed correct for that fixture's FBI_CREATE/
        // FBI_DELETE (both resolve to the config's own BO parameter).
        const selfTarget: HandlerTarget = { configId: cfg.configId, configType: cfg.configType, configVar: cfg.configVar };
        events.push({
          configId: cfg.configId,
          configType: cfg.configType,
          configVar: cfg.configVar,
          source: "button_row",
          elementId: row.elementId,
          text: row.text || undefined,
          elementType: typeLabel,
          eventId: ev.eventId || undefined,
          handler: classifyHandler(ev.eventId, selfTarget, ctx),
        });
      }
    }

    for (const action of cfg.fbiActions) {
      if (action.actionConf) {
        // ACTION_CONF is a config_id, not a CONFIG_ID-bearing child element —
        // the ABAP side's walk_refs only follows Items with a literal
        // CONFIG_ID child (fluid/builtin/fpm.ts), so this target was never
        // walked/fetched even if its config exists. Reported as-is, not
        // resolved further.
        events.push({
          configId: cfg.configId,
          configType: cfg.configType,
          configVar: cfg.configVar,
          source: "fbi_action",
          elementId: action.actionId,
          text: action.text || undefined,
          handler: {
            kind: "unresolved",
            reason: `ACTION_CONF points to config "${action.actionConf}" — not followed by the events scan (only CONFIG_ID-bearing references are walked)`,
          },
        });
        continue;
      }
      events.push({
        configId: cfg.configId,
        configType: cfg.configType,
        configVar: cfg.configVar,
        source: "fbi_action",
        elementId: action.actionId,
        text: action.text || undefined,
        handler: action.actionImpl
          ? { kind: "unresolved", reason: `ACTION_IMPL "${action.actionImpl}" — a handler class, not a config/BO; not resolved further` }
          : { kind: "unresolved", reason: "no ACTION_IMPL/ACTION_CONF — cannot tell what handles this action" },
      });
    }
  }

  const rootParsed = configsByKey.get(normKey(rootFrame.config_id, rootFrame.config_type, rootFrame.config_var));
  if (!rootParsed && rootFrame.xml && rootFrame.xml.trim()) {
    notes.push("the root config's own XML could not be parsed as an fpm/fbi Component document — no toolbar/wire/action extraction was possible for it.");
  }

  notes.push(
    "Toolbar texts shown as a bare number are WDY_CONFIG_DATT/_APPT text keys, not labels — this mode does not resolve them.",
  );

  return {
    root: {
      configId: rootFrame.config_id,
      configType: rootFrame.config_type || "00",
      configVar: rootFrame.config_var,
      component: rootFrame.component ?? "",
      devclass: rootFrame.devclass ?? "",
    },
    appController,
    wires,
    views: parsedConfigs.map((c) => c.configId),
    events,
    unreadable,
    skipped,
    notes,
    truncated: raw.summary?.truncated ?? "",
  };
}
