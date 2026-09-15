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
import { truncateText, MESSAGE_EXCERPT_MAX } from "../truncate.js";

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

/**
 * One WDY_CONFIG_COMPT row (issue #101 Defect 3) — the real per-text-id
 * resolution table for a toolbar/button TEXT marked `Transl="true"`,
 * confirmed live against `/BOFU/TEST_FBI_SALES_ORDER_OVP` (TEXT_ID 30 ->
 * "Change", 34 -> "Save", 38 -> "Read-Only", 42 -> "Refresh", 46 ->
 * "Cancel", 12 -> "Start"). `langu` is SAP's 1-char legacy code (E/D/...),
 * not ISO 639-1.
 */
export interface FpmEventsTextIdFrame {
  kind: "text_id";
  config_id: string;
  config_type: string;
  config_var: string;
  langu: string;
  text_id: string;
  description: string;
}

export interface FpmEventsTextIdErrorFrame {
  kind: "text_id_error";
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
  /** Count of `text_id` frames emitted (issue #101 Defect 3). */
  text_ids: number;
  /** SY-LANGU at read time: the calling user's logon language, 1-char legacy code. Used by text_id resolution's language fallback (logon language -> "E" -> whatever exists — no master-language field exists on this table to try an "original language" step). */
  logon_langu: string;
  truncated: string;
}

export type FpmEventsFrame =
  | FpmEventsConfigFrame
  | FpmEventsCatalogueFrame
  | FpmEventsCatalogueErrorFrame
  | FpmEventsBopfNodeFrame
  | FpmEventsBopfActionFrame
  | FpmEventsBopfErrorFrame
  | FpmEventsTextIdFrame
  | FpmEventsTextIdErrorFrame
  | FpmEventsSummaryFrame;

export interface FpmEventsRaw {
  configs: FpmEventsConfigFrame[];
  fpmEvents: FpmEventsCatalogueFrame[];
  fpmEventErrors: FpmEventsCatalogueErrorFrame[];
  bopfNodes: FpmEventsBopfNodeFrame[];
  bopfActions: FpmEventsBopfActionFrame[];
  bopfErrors: FpmEventsBopfErrorFrame[];
  textIds: FpmEventsTextIdFrame[];
  textIdErrors: FpmEventsTextIdErrorFrame[];
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
    textIds: [],
    textIdErrors: [],
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
      case "text_id":
        raw.textIds.push(v as unknown as FpmEventsTextIdFrame);
        break;
      case "text_id_error":
        raw.textIdErrors.push(v as unknown as FpmEventsTextIdErrorFrame);
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
  /**
   * The BOPF node this handler acts on, taken from the config's own BO/NODE
   * pairing (an Item's NAME=BO/VALUE with a sibling NAME=NODE/VALUE, or a
   * literal `<BO>`/`<NODE>` sibling pair — see `collectBoNodePairs`), never
   * from EVENT_PARAMETERS (always empty in every observed config). Kept
   * even when it does not exist in `/BOBF/OBM_NODE` (see `note`) — only left
   * undefined when the config pairs no NODE with this BO at all.
   */
  node?: string;
  /**
   * The BOPF action this handler runs. The only candidate available is the
   * raw event id itself (again, EVENT_PARAMETERS is always empty), cross-
   * checked against `/BOBF/ACT_LIST`. Left undefined — with `note` always
   * explaining why — whenever that cannot be confirmed, including the
   * expected case of FBI framework events (FBI_CREATE/FBI_DELETE/...) whose
   * real BOPF action is mapped internally by the FBI connector and never
   * appears anywhere in configuration.
   */
  action?: string;
  /** Explains any gap in `node`/`action` above: unverifiable (no BOPF catalogue was fetched — pass resolve=true), not found in the catalogue, or not determinable from configuration at all. Always present when `node` or `action` is either undefined or unverified. */
  note?: string;
  /**
   * Ready-to-run follow-up. Deliberately still just `{"mode":"show","bo":...}`,
   * not `node`/`action` embedded: `abap_bopf`'s own read-tool schema
   * (src/tools/bopf.ts `bopfInputSchema`) only accepts
   * mode/bo/query/object_type/max_results/max_sites — it has no node/action
   * parameters at all (those exist only on the separate write tool
   * `abap_bopf_edit`) — so putting them in this JSON string would be
   * silently stripped by the tool's own schema and would misrepresent what
   * the call does. `mode:"show"` already returns the BO's full digest,
   * including every node/action name, which is the most specific call this
   * tool supports; `node`/`action` are surfaced as their own fields instead.
   */
  call: string;
}

/**
 * Maps a generic FPM GUIBB component name (WDY_CONFIG_DATA/_APPL's own
 * COMPONENT column, already on `FpmEventsConfigFrame.component`) to the
 * interface that declares its event entry point. LIST/FORM/SEARCH are each
 * confirmed live: every one declares its own `PROCESS_EVENT` method (not
 * inherited from the generic IF_FPM_GUIBB base, which only carries
 * GET_PARAMETER_LIST/INITIALIZE). TREE has no dedicated interface at all —
 * mapped to LIST's by symmetry, NOT independently confirmed. FORM_REPEATER/
 * LAUNCHPAD/CAROUSEL/CHART interfaces exist but their PROCESS_EVENT was not
 * read live, so they are deliberately absent here rather than guessed.
 */
const FEEDER_INTERFACE_BY_COMPONENT: Readonly<Record<string, string>> = {
  FPM_LIST_UIBB: "IF_FPM_GUIBB_LIST",
  FPM_FORM_UIBB: "IF_FPM_GUIBB_FORM",
  FPM_SEARCH_UIBB: "IF_FPM_GUIBB_SEARCH",
  FPM_TREE_UIBB: "IF_FPM_GUIBB_LIST",
};

export interface FpmEventHandlerFeeder {
  kind: "feeder";
  feederClass: string;
  configId: string;
  configType: string;
  configVar: string;
  /**
   * Interface-qualified GUIBB event entry point, e.g.
   * "IF_FPM_GUIBB_LIST~PROCESS_EVENT" — see `FEEDER_INTERFACE_BY_COMPONENT`.
   * Undefined when the target config's own COMPONENT does not match a known
   * generic FPM GUIBB kind (a fully custom component, or one of the kinds
   * not independently confirmed).
   */
  method?: string;
  /** `abap_read {"object":"<feederClass>","method":"<method>"}` — only set alongside `method`. */
  call?: string;
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

export interface FpmEventHandlerActionImpl {
  kind: "action_impl";
  /**
   * ABAP class named in an FBI action's ACTION_IMPL. A concrete handler —
   * this action IS implemented by this class — but not itself a config/BO/
   * event, so there is nothing further here to follow.
   */
  implClass: string;
}

export interface FpmEventHandlerUnresolved {
  kind: "unresolved";
  reason: string;
  /**
   * Serialisation of the raw XML element (or other frame) the resolver was
   * looking at when it gave up classifying it — issue #101's "unknown XML
   * shapes → unresolved with the raw element excerpt, never silently
   * dropped". This is `JSON.stringify` of the parsed element (fast-xml-parser
   * output), not the original XML bytes — this module's parser does not keep
   * source offsets — but it is exactly the shape the resolver examined, so
   * nothing about the offending element is lost. Truncated with
   * `truncateText`/`MESSAGE_EXCERPT_MAX` (src/truncate.ts) when long, never a
   * hand-rolled slice. Left absent only when the failure is purely logical —
   * no element was ever involved to excerpt (none of the sites in this file
   * hit that case today; every `unresolved` handler here is built from a
   * parsed Item/Node).
   */
  excerpt?: string;
}

export type FpmEventHandler =
  | FpmEventHandlerBopf
  | FpmEventHandlerFeeder
  | FpmEventHandlerAppController
  | FpmEventHandlerStandard
  | FpmEventHandlerActionImpl
  | FpmEventHandlerUnresolved;

export interface FpmEventRow {
  /** The config whose XML this toolbar element was found in. */
  configId: string;
  configType: string;
  configVar: string;
  /** `FpmViewRow.kind` for the config above — this event's own source UIBB kind, joined by config key. `""` when that view's own COMPONENT was empty. */
  uibbKind?: string;
  /** `FpmViewRow.feederClass` for the config above, when it names one. */
  feederClass?: string;
  source: "toolbar" | "uibb_toolbar" | "button_row" | "fbi_action";
  elementId: string;
  /**
   * The element's label. When the raw TEXT/HEADER value carried
   * `Transl="true"` and a matching WDY_CONFIG_COMPT row was found (see
   * `textKey`, and the module's final "text keys" note), this is the
   * resolved DESCRIPTION, not the bare key. Otherwise (not translatable, or
   * translatable but unresolved) this is the raw value as captured, exactly
   * as before Defect 3.
   */
  text?: string;
  /**
   * Present only when the raw TEXT/HEADER value carried `Transl="true"` —
   * the original WDY_CONFIG_COMPT `text_id` key, kept alongside the
   * (possibly resolved) `text` above so the raw key is never lost even when
   * resolution succeeds.
   */
  textKey?: string;
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

/**
 * One config (root or referenced child) whose XML was actually parsed for
 * this trace — the "source UIBB" doc/TOOLS/ui-and-fpm.md promises per event
 * (issue #101: "the source UIBB (config ID, kind, feeder class)" and "each
 * FBI view's BO and node"). `kind` is the config's own WDY_CONFIG_DATA/APPL
 * COMPONENT column (`ParsedConfig.component`, e.g. "FPM_LIST_UIBB" /
 * "FPM_FORM_UIBB" / "/BOFU/FBI_VIEW") — left `""` when the config's own
 * component was empty; never invented. `feederClass` is set only when the
 * config's own CONFIGURATION_CONTEXT names a FEEDER (`ParsedConfig.feeders`
 * first entry); when a config names more than one, the rest are not lost —
 * a note (see `FpmEventsResolved.notes`) records them. `bo`/`node` are set
 * only for FBI views that pair a BO with a NODE (`ParsedConfig.boNodePairs`
 * first entry) or, failing that, name a bare BO with no paired node
 * (`ParsedConfig.boNames` first entry) — both left undefined when the
 * config names neither, never the string "null".
 */
export interface FpmViewRow {
  configId: string;
  configType: string;
  configVar: string;
  kind: string;
  feederClass?: string;
  bo?: string;
  node?: string;
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
  /** Every config (root + children) whose XML was actually parsed — the source UIBB per event, see `FpmViewRow`. */
  views: FpmViewRow[];
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

/**
 * Same normalisation as `text()`, but also reports whether the element
 * carried `Transl="true"` — the marker (issue #101 Defect 3) that a bare
 * numeric value is a WDY_CONFIG_COMPT `text_id` key rather than a literal
 * label. Confirmed live: `<TEXT Transl="true">30</TEXT>` etc. in
 * test/fixtures/fpm-events/ovp-test-fbi-sales-order.config.xml, matching
 * exactly that fixture's real /BOFU/TEST_FBI_SALES_ORDER_OVP TEXT_ID rows.
 */
function textTransl(v: unknown): { value: string; translatable: boolean } {
  const value = text(v);
  const translatable = isRecord(v) && v["@_Transl"] === "true";
  return { value, translatable };
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
  /** True when TEXT carried `Transl="true"` — `text` is a WDY_CONFIG_COMPT text_id key, not a literal label (issue #101 Defect 3). */
  textTransl: boolean;
  type: string;
  actionIds: string[];
  /** The parsed BUTTON Item this row came from — excerpted into an unresolved handler, never dropped. */
  raw: Record<string, unknown>;
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
          const btnText = textTransl(buttonItem["TEXT"]);
          rows.push({
            source,
            elementId,
            text: btnText.value,
            textTransl: btnText.translatable,
            type: text(buttonItem["TYPE"]),
            actionIds: subActionIds.length ? subActionIds : elementId ? [elementId] : [],
            raw: buttonItem,
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
  /** True when TEXT carried `Transl="true"` — `text` is a WDY_CONFIG_COMPT text_id key, not a literal label (issue #101 Defect 3). */
  textTransl: boolean;
  displayType: string;
  events: { eventId: string; text: string }[];
  /** The parsed BUTTON_ROW_ELEMENT Item this row came from — excerpted into an unresolved handler, never dropped. */
  raw: Record<string, unknown>;
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
        const rowText = textTransl(elItem["TEXT"]);
        rows.push({
          elementId: text(elItem["ELEMENT_ID"]),
          text: rowText.value,
          textTransl: rowText.translatable,
          displayType: text(elItem["DISPLAY_TYPE"]),
          events,
          raw: elItem,
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
  /** True when TEXT carried `Transl="true"` — `text` is a WDY_CONFIG_COMPT text_id key, not a literal label (issue #101 Defect 3). */
  textTransl: boolean;
  tooltip: string;
  enabled: string;
  navRole: string;
  /** The parsed ACTIONS Item this row came from — excerpted into an unresolved handler, never dropped. */
  raw: Record<string, unknown>;
}

function collectFbiActions(root: Record<string, unknown>): FbiActionRaw[] {
  const rows: FbiActionRaw[] = [];
  for (const ctxNode of findAllNodesByName(root, "CONFIGURATION_CONTEXT")) {
    for (const ctxItem of items(ctxNode)) {
      for (const actionsNode of findAllNodesByName(ctxItem, "ACTIONS")) {
        for (const item of items(actionsNode)) {
          const actionText = textTransl(item["TEXT"]);
          rows.push({
            actionId: text(item["ACTIONID"]),
            actionImpl: text(item["ACTION_IMPL"]),
            actionConf: text(item["ACTION_CONF"]),
            text: actionText.value,
            textTransl: actionText.translatable,
            tooltip: text(item["TOOLTIP"]),
            enabled: text(item["ENABLED"]),
            navRole: text(item["NAV_ROLE"]),
            raw: item,
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

/**
 * Serialises the raw parsed XML element (or other frame) an unresolved
 * handler could not classify, for `FpmEventHandlerUnresolved.excerpt` — see
 * that field's doc comment. `JSON.stringify` rather than the original XML
 * bytes (this module's parser keeps no source offsets); truncated with the
 * shared `truncateText` helper, never a hand-rolled `.slice()`, so a long
 * element still discloses that it was cut.
 */
function excerptOf(el: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(el) ?? String(el);
  } catch {
    raw = String(el);
  }
  return truncateText(raw, MESSAGE_EXCERPT_MAX);
}

/** Attaches `excerptOf(raw)` to `handler` iff it is unresolved — every other kind is a concrete answer with nothing to excerpt. */
function withExcerpt(handler: FpmEventHandler, raw: unknown): FpmEventHandler {
  return handler.kind === "unresolved" ? { ...handler, excerpt: excerptOf(raw) } : handler;
}

/**
 * Finds an already-parsed config by its bare `config_id` alone, ignoring
 * type/var — used for FBI ACTION_CONF, which names a config_id but (unlike
 * ACTION/WIRE targets) carries no CONFIG_TYPE/CONFIG_VAR of its own. Only
 * ever finds a hit when that config happens to have been fetched some other
 * way (e.g. it's the root, or another element's CONFIG_ID reference reached
 * it) — walk_refs (fluid/builtin/fpm.ts) does not follow ACTION_CONF itself.
 */
function findConfigByBareId(configs: readonly ParsedConfig[], configId: string): ParsedConfig | undefined {
  const norm = configId.trim().toUpperCase();
  return configs.find((c) => c.configId.trim().toUpperCase() === norm);
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

/**
 * Pairs each BO name `collectBoNames` finds with whatever NODE sits
 * alongside it in the SAME Item — the config's own BO/NODE pairing (issue
 * #101 Defect 1), never EVENT_PARAMETERS (always empty in every observed
 * config). Mirrors `collectBoNames`'s two known shapes: a literal `<BO>`/
 * `<NODE>` sibling pair (FBI VIEW HEADER, e.g.
 * test/fixtures/fpm/36-BOFU_DEMO_SO_HDR_VIEW.full-config.xml), and a
 * PARAMETER Item's NAME=BO/VALUE with a sibling Item's NAME=NODE/VALUE
 * (GUIBB PARAMETER, e.g.
 * test/fixtures/fpm-events/list-uibb-test-sales-order-item.config.xml).
 * `node` is left undefined when a BO is found with no paired NODE anywhere
 * in the same Item — the caller (`classifyHandler`/`buildBopfHandler`) is
 * responsible for surfacing that gap via a `note`, not this collector.
 */
interface BoNodePair {
  bo: string;
  node?: string;
}

function collectBoNodePairs(root: Record<string, unknown>): BoNodePair[] {
  const out: BoNodePair[] = [];
  const walk = (el: unknown): void => {
    if (!isRecord(el)) return;
    const literalBo = text(el["BO"]);
    if (literalBo) out.push({ bo: literalBo, node: text(el["NODE"]) || undefined });
    const nameValue = new Map<string, string>();
    for (const item of items(el)) {
      const name = text(item["NAME"]);
      if (name) nameValue.set(name, text(item["VALUE"]));
    }
    const paramBo = nameValue.get("BO");
    if (paramBo) out.push({ bo: paramBo, node: nameValue.get("NODE") || undefined });
    for (const item of items(el)) walk(item);
    for (const node of asArray(el["Node"] as Record<string, unknown> | Record<string, unknown>[] | undefined)) walk(node);
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// resolveFpmEvents — ties everything above together.
// ---------------------------------------------------------------------------

interface ParsedConfig {
  configId: string;
  configType: string;
  configVar: string;
  /** WDY_CONFIG_DATA/_APPL's own COMPONENT column (FpmEventsConfigFrame.component) — the generic FPM GUIBB kind, e.g. "FPM_LIST_UIBB", or a fully custom component. Used to name the feeder's PROCESS_EVENT interface (Defect 2). */
  component: string;
  root: Record<string, unknown>;
  actions: ActionCatalogueRow[];
  toolbarButtons: ToolbarButtonRaw[];
  buttonRows: ButtonRowRaw[];
  fbiActions: FbiActionRaw[];
  wires: FpmWireRow[];
  appSpecificCC?: { component: string; configId: string; configType: string; configVar: string };
  feeders: string[];
  boNames: string[];
  boNodePairs: BoNodePair[];
}

function normKey(configId: string, configType: string | undefined, configVar: string | undefined): string {
  return `${configId.trim().toUpperCase()}|${(configType || "00").trim().toUpperCase()}|${(configVar ?? "").trim().toUpperCase()}`;
}

function parseConfig(frame: { config_id: string; config_type: string; config_var: string; component?: string; xml?: string }): ParsedConfig | undefined {
  const root = frame.xml ? parseConfigXml(frame.xml) : undefined;
  if (!root) return undefined;
  return {
    configId: frame.config_id,
    configType: frame.config_type || "00",
    configVar: frame.config_var,
    component: frame.component ?? "",
    root,
    actions: collectActions(root),
    toolbarButtons: collectToolbarButtons(root),
    buttonRows: collectButtonRows(root),
    fbiActions: collectFbiActions(root),
    wires: collectWires(root),
    appSpecificCC: collectAppSpecificCC(root),
    feeders: collectFeeders(root),
    boNames: collectBoNames(root),
    boNodePairs: collectBoNodePairs(root),
  };
}

interface HandlerTarget {
  component?: string;
  configId?: string;
  configType?: string;
  configVar?: string;
}

/**
 * Builds the "bopf" handler's node/action/note (Defect 1). `bo` and
 * `nodeCandidate` come from the target config's own `collectBoNodePairs`
 * result; `eventId` is the only available action-name candidate (raw event
 * id — EVENT_PARAMETERS is always empty). Cross-checks both against the
 * BOPF catalogue frames (`/BOBF/OBM_NODE`/`/BOBF/ACT_LIST`, only fetched
 * when `resolve=true`) without ever silently dropping a name that fails
 * verification — see the field doc comments on FpmEventHandlerBopf.
 */
function buildBopfHandler(
  bo: string,
  nodeCandidate: string | undefined,
  eventId: string,
  ctx: {
    bopfNodes: readonly FpmEventsBopfNodeFrame[];
    bopfActions: readonly FpmEventsBopfActionFrame[];
    bopfErrors: readonly FpmEventsBopfErrorFrame[];
  },
): FpmEventHandlerBopf {
  const call = `abap_bopf {"mode":"show","bo":"${bo}"}`;
  const nodesForBo = ctx.bopfNodes.filter((n) => n.bo === bo);
  const actionsForBo = ctx.bopfActions.filter((a) => a.bo === bo);
  const errorForBo = ctx.bopfErrors.find((e) => e.bo === bo);
  const catalogueFetched = nodesForBo.length > 0 || actionsForBo.length > 0 || errorForBo !== undefined;

  const notes: string[] = [];
  if (errorForBo) {
    notes.push(`the /BOBF/OBM_NODE + /BOBF/ACT_LIST read for BO "${bo}" failed (${errorForBo.text}) — node/action below are unverified.`);
  } else if (!catalogueFetched) {
    notes.push(`node/action were not verified against /BOBF/OBM_NODE or /BOBF/ACT_LIST for BO "${bo}" — pass resolve=true to fetch that catalogue.`);
  }

  const node = nodeCandidate || undefined;
  if (!nodeCandidate) {
    notes.push(`no NODE is paired with BO "${bo}" anywhere in this button's config — cannot say which BOPF node this handler acts on.`);
  } else if (catalogueFetched && !errorForBo && !nodesForBo.some((n) => n.node_name === nodeCandidate)) {
    notes.push(`node "${nodeCandidate}" was not found in /BOBF/OBM_NODE for BO "${bo}" — kept as-is rather than dropped, but unverified.`);
  }

  const matchedNode = nodeCandidate ? nodesForBo.find((n) => n.node_name === nodeCandidate) : undefined;
  const candidateActions = matchedNode ? actionsForBo.filter((a) => a.node_key === matchedNode.node_key) : actionsForBo;

  let action: string | undefined;
  if (!eventId) {
    notes.push("no event id was available to try as a BOPF action name.");
  } else if (catalogueFetched && !errorForBo) {
    const matchedAction = candidateActions.find((a) => a.act_name === eventId);
    if (matchedAction) {
      action = eventId;
    } else if (eventId.startsWith("FBI_")) {
      notes.push(
        `event "${eventId}" is an FBI framework event — its real BOPF action is mapped internally by the FBI connector and never appears in /BOBF/ACT_LIST or anywhere else in configuration, so it cannot be determined here.`,
      );
    } else {
      notes.push(
        `event "${eventId}" does not name any action in /BOBF/ACT_LIST for BO "${bo}"${matchedNode ? ` node "${nodeCandidate}"` : ""} — cannot say what action this handler runs.`,
      );
    }
  } else if (eventId.startsWith("FBI_")) {
    notes.push(
      `event "${eventId}" is an FBI framework event — its real BOPF action is mapped internally by the FBI connector and never appears in /BOBF/ACT_LIST or anywhere else in configuration, so it would not have been determinable even with resolve=true.`,
    );
  }

  return { kind: "bopf", bo, node, action, call, note: notes.length ? notes.join(" ") : undefined };
}

function classifyHandler(
  eventId: string,
  target: HandlerTarget | undefined,
  ctx: {
    standardEventIds: ReadonlySet<string>;
    standardVerified: boolean;
    configsByKey: ReadonlyMap<string, ParsedConfig>;
    bopfNodes: readonly FpmEventsBopfNodeFrame[];
    bopfActions: readonly FpmEventsBopfActionFrame[];
    bopfErrors: readonly FpmEventsBopfErrorFrame[];
  },
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
      if (bo) {
        const nodeCandidate = cfg.boNodePairs.find((p) => p.bo === bo)?.node;
        return buildBopfHandler(bo, nodeCandidate, eventId, ctx);
      }
      const feeder = cfg.feeders[0];
      if (feeder) {
        const iface = FEEDER_INTERFACE_BY_COMPONENT[cfg.component];
        const method = iface ? `${iface}~PROCESS_EVENT` : undefined;
        return {
          kind: "feeder",
          feederClass: feeder,
          configId: target.configId,
          configType: target.configType || "00",
          configVar: target.configVar ?? "",
          method,
          call: method ? `abap_read {"object":"${feeder}","method":"${method}"}` : undefined,
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

// ---------------------------------------------------------------------------
// WDY_CONFIG_COMPT text-id resolution (issue #101 Defect 3).
// ---------------------------------------------------------------------------

interface TextIdEntry {
  byLangu: Map<string, string>;
  /** Insertion order of the langu values seen, for the "whatever exists" fallback step. */
  order: string[];
}

/** Indexes every `text_id` frame by (config, text_id), keeping every language row so `resolveTextId` can fall back. */
function buildTextIndex(frames: readonly FpmEventsTextIdFrame[]): Map<string, TextIdEntry> {
  const idx = new Map<string, TextIdEntry>();
  for (const f of frames) {
    const key = `${normKey(f.config_id, f.config_type, f.config_var)} ${f.text_id}`;
    let entry = idx.get(key);
    if (!entry) {
      entry = { byLangu: new Map(), order: [] };
      idx.set(key, entry);
    }
    if (!entry.byLangu.has(f.langu)) {
      entry.byLangu.set(f.langu, f.description);
      entry.order.push(f.langu);
    }
  }
  return idx;
}

/**
 * Resolves one WDY_CONFIG_COMPT text_id to its DESCRIPTION for a given
 * config: logon language, then "E", then whatever language is on file.
 * WDY_CONFIG_COMPT has no master/original-language column, so — unlike a
 * text-table with an explicit original-language field — there is no middle
 * step to try between the logon language and "E"; this is a live finding,
 * not an oversight. Returns undefined when no row matches the config/text_id
 * pair at all.
 */
function resolveTextId(
  idx: Map<string, TextIdEntry>,
  configId: string,
  configType: string,
  configVar: string,
  textId: string,
  logonLangu: string,
): string | undefined {
  const entry = idx.get(`${normKey(configId, configType, configVar)} ${textId}`);
  if (!entry) return undefined;
  if (logonLangu && entry.byLangu.has(logonLangu)) return entry.byLangu.get(logonLangu);
  if (entry.byLangu.has("E")) return entry.byLangu.get("E");
  const first = entry.order[0];
  return first !== undefined ? entry.byLangu.get(first) : undefined;
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

  // Issue #101 Defect 3: resolve every Transl="true" TEXT against the
  // text_id frames the ABAP side already collected for every config read
  // (see fluid/builtin/fpm.ts's WDY_CONFIG_COMPT SELECT).
  const textIndex = buildTextIndex(raw.textIds);
  const logonLangu = raw.summary?.logon_langu ?? "";
  let hadTranslatableText = false;
  let hadUnresolvedTranslatableText = false;
  function resolveRowText(cfg: ParsedConfig, rawValue: string, translatable: boolean): { text?: string; textKey?: string } {
    if (!translatable || !rawValue) return { text: rawValue || undefined, textKey: undefined };
    hadTranslatableText = true;
    const resolved = resolveTextId(textIndex, cfg.configId, cfg.configType, cfg.configVar, rawValue, logonLangu);
    if (resolved === undefined) hadUnresolvedTranslatableText = true;
    return { text: resolved ?? rawValue, textKey: rawValue };
  }

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

  // Issue #101: the doc promises "the source UIBB (config ID, kind, feeder
  // class)" per event and "each FBI view's BO and node" — both come from
  // fields `parseConfig` already collected onto `ParsedConfig`, just never
  // surfaced. One `FpmViewRow` per parsed config (root + every referenced
  // child actually read), keyed the same way `configsByKey` is so events
  // below can join back to their own view.
  const views: FpmViewRow[] = parsedConfigs.map((cfg) => {
    if (cfg.feeders.length > 1) {
      notes.push(
        `config ${cfg.configId} names ${cfg.feeders.length} FEEDER classes (${cfg.feeders.join(", ")}) — only the first, "${cfg.feeders[0]}", is shown as this view's feeder class.`,
      );
    }
    const pair = cfg.boNodePairs[0];
    return {
      configId: cfg.configId,
      configType: cfg.configType,
      configVar: cfg.configVar,
      kind: cfg.component,
      feederClass: cfg.feeders[0],
      bo: pair ? pair.bo : cfg.boNames[0],
      node: pair ? pair.node : undefined,
    };
  });
  const viewsByKey = new Map<string, FpmViewRow>();
  for (const v of views) viewsByKey.set(normKey(v.configId, v.configType, v.configVar), v);

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

  const ctx = {
    standardEventIds,
    standardVerified: standardVerified && raw.fpmEventErrors.length === 0,
    configsByKey,
    bopfNodes: raw.bopfNodes,
    bopfActions: raw.bopfActions,
    bopfErrors: raw.bopfErrors,
  };

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
    const view = viewsByKey.get(normKey(cfg.configId, cfg.configType, cfg.configVar));
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
          uibbKind: view?.kind,
          feederClass: view?.feederClass,
          source: btn.source,
          elementId: btn.elementId || actionId,
          ...resolveRowText(cfg, btn.text, btn.textTransl),
          elementType: typeLabel,
          eventId: eventId || undefined,
          handler: withExcerpt(classifyHandler(eventId, target, ctx), btn.raw),
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
          uibbKind: view?.kind,
          feederClass: view?.feederClass,
          source: "button_row",
          elementId: row.elementId,
          ...resolveRowText(cfg, row.text, row.textTransl),
          elementType: typeLabel,
          handler: {
            kind: "unresolved",
            reason: "no BUTTON_ACTION child — this button row element declares no event",
            excerpt: excerptOf(row.raw),
          },
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
          uibbKind: view?.kind,
          feederClass: view?.feederClass,
          source: "button_row",
          elementId: row.elementId,
          ...resolveRowText(cfg, row.text, row.textTransl),
          elementType: typeLabel,
          eventId: ev.eventId || undefined,
          handler: withExcerpt(classifyHandler(ev.eventId, selfTarget, ctx), row.raw),
        });
      }
    }

    for (const action of cfg.fbiActions) {
      // ACTION_CONF names a config_id, but walk_refs (fluid/builtin/fpm.ts)
      // only follows Items with a literal CONFIG_ID child — ACTION_CONF is
      // not one — so that target is normally never fetched even when its
      // config exists. It is only "usable" here when the config happens to
      // have been fetched some other way (root, or another CONFIG_ID
      // reference reached it); otherwise it is no better than not having
      // one, and ACTION_IMPL — a concrete handler class — is preferred over
      // reporting unresolved. Confirmed against the /BOFU/DEMO_SO_HDR_VIEW
      // fixture's DELIVER_ORDER action, whose ACTION_CONF
      // ("/BOFU/DEMO/DELIVER_CONFIRMATION") is never fetched but whose
      // ACTION_IMPL ("DELIVER") is a real handler class.
      const confTarget = action.actionConf ? findConfigByBareId(parsedConfigs, action.actionConf) : undefined;
      if (confTarget) {
        events.push({
          configId: cfg.configId,
          configType: cfg.configType,
          configVar: cfg.configVar,
          uibbKind: view?.kind,
          feederClass: view?.feederClass,
          source: "fbi_action",
          elementId: action.actionId,
          ...resolveRowText(cfg, action.text, action.textTransl),
          handler: withExcerpt(
            classifyHandler(
              "",
              { configId: confTarget.configId, configType: confTarget.configType, configVar: confTarget.configVar },
              ctx,
            ),
            action.raw,
          ),
        });
        continue;
      }
      if (action.actionImpl) {
        events.push({
          configId: cfg.configId,
          configType: cfg.configType,
          configVar: cfg.configVar,
          uibbKind: view?.kind,
          feederClass: view?.feederClass,
          source: "fbi_action",
          elementId: action.actionId,
          ...resolveRowText(cfg, action.text, action.textTransl),
          handler: { kind: "action_impl", implClass: action.actionImpl },
        });
        continue;
      }
      events.push({
        configId: cfg.configId,
        configType: cfg.configType,
        configVar: cfg.configVar,
        uibbKind: view?.kind,
        feederClass: view?.feederClass,
        source: "fbi_action",
        elementId: action.actionId,
        ...resolveRowText(cfg, action.text, action.textTransl),
        handler: withExcerpt(
          action.actionConf
            ? {
                kind: "unresolved",
                reason: `ACTION_CONF points to config "${action.actionConf}" — not followed by the events scan (only CONFIG_ID-bearing references are walked), and there is no ACTION_IMPL to fall back to`,
              }
            : { kind: "unresolved", reason: "no ACTION_IMPL/ACTION_CONF — cannot tell what handles this action" },
          action.raw,
        ),
      });
    }
  }

  const rootParsed = configsByKey.get(normKey(rootFrame.config_id, rootFrame.config_type, rootFrame.config_var));
  if (!rootParsed && rootFrame.xml && rootFrame.xml.trim()) {
    notes.push("the root config's own XML could not be parsed as an fpm/fbi Component document — no toolbar/wire/action extraction was possible for it.");
  }

  if (hadTranslatableText) {
    if (raw.textIdErrors.length > 0) {
      notes.push(
        `Toolbar/action texts marked as text keys could not be resolved against WDY_CONFIG_COMPT (read failed: ${raw.textIdErrors.map((e) => e.text).join("; ")}) — "text" holds the raw numeric key instead of a label; see "textKey".`,
      );
    } else if (hadUnresolvedTranslatableText) {
      notes.push(
        'Some toolbar/action texts are WDY_CONFIG_COMPT text keys with no matching row for this config (logon language, "E", or any language on file) — for those, "text" falls back to the raw numeric key; see "textKey" for the key on every resolved element too.',
      );
    } else {
      notes.push(
        'Toolbar/action texts marked Transl="true" are WDY_CONFIG_COMPT text keys — "text" is resolved to the description for the logon language, falling back to "E" and then to whatever language is on file (WDY_CONFIG_COMPT has no master-language column), and "textKey" carries the original numeric key.',
      );
    }
  }

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
    views,
    events,
    unreadable,
    skipped,
    notes,
    truncated: raw.summary?.truncated ?? "",
  };
}
