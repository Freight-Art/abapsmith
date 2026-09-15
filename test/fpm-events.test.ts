/**
 * Pure unit tests for src/adt/fpm-events.ts (`splitEventFrames` +
 * `resolveFpmEvents`) — the model behind `abap_fpm_read mode=events`
 * (issue #101). No network, no AbapConnection, no fluid protocol layer:
 * these tests hand-build the raw frame arrays `splitEventFrames` would
 * receive from `dispatch()`, and feed real captured config XML (from
 * test/fixtures/fpm-events/ and test/fixtures/fpm/) through
 * `resolveFpmEvents` exactly as the production code would.
 *
 * A note on scope: `resolveFpmEvents` is explicitly a best-effort trace,
 * documented (in its own source comments and in its `notes` output) as
 * verified against only five fixtures. These tests check it against
 * exactly those fixtures plus hand-built shapes for the "we don't
 * recognise this" paths — they do not prove correctness against the full
 * space of FPM/FBI/OVP configuration shapes that exist in the wild.
 *
 * A note on the "coverage limits" disclosures: the four issue-#101
 * disclosures (AppCC override, personalisation, CBA/deltas, nothing
 * executed) are NOT part of `resolveFpmEvents`'s own `notes` array — they
 * live in `EVENTS_COVERAGE_LIMITS` in src/tools/fpm.ts and are prepended
 * by `buildEventsResponse` at the tool layer. They are asserted in
 * test/fpm-events-tool.test.ts instead. What `resolveFpmEvents.notes`
 * itself unconditionally contains is the "bare number is a text key" note,
 * plus conditional notes about unverified standard-event guesses, a failed
 * CL_FPM_EVENT catalogue read, and unparseable config XML — those are what
 * this file checks.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  splitEventFrames,
  resolveFpmEvents,
  type FpmEventsConfigFrame,
  type FpmEventRow,
} from "../src/adt/fpm-events.js";

const FIXTURES_EVENTS = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fpm-events");
const FIXTURES_FPM = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fpm");

const OVP_TOOLBAR_XML = readFileSync(join(FIXTURES_EVENTS, "ovp-test-fbi-sales-order.config.xml"), "utf8");
const LIST_GUIBB_XML = readFileSync(join(FIXTURES_EVENTS, "list-uibb-test-sales-order-item.config.xml"), "utf8");
const APPCC_XML = readFileSync(join(FIXTURES_EVENTS, "ovp-appcc-class.config.xml"), "utf8");
const FBI_VIEW_XML = readFileSync(join(FIXTURES_FPM, "36-BOFU_DEMO_SO_HDR_VIEW.full-config.xml"), "utf8");
const BOPF_CATALOGUE = JSON.parse(readFileSync(join(FIXTURES_EVENTS, "bopf-test-sales-order.json"), "utf8")) as {
  bo: string;
  nodes: { nodeName: string; nodeKey: string; boKey: string }[];
  actions: { actName: string; actKey: string; nodeKey: string; actClass: string; actCat: string }[];
};

function rootConfig(overrides: Partial<FpmEventsConfigFrame> & { config_id: string; xml: string }): FpmEventsConfigFrame {
  return {
    kind: "config",
    role: "root",
    config_type: "00",
    config_var: "",
    component: "",
    devclass: "$TMP",
    ...overrides,
  } as FpmEventsConfigFrame;
}

function childConfig(overrides: Partial<FpmEventsConfigFrame> & { config_id: string }): FpmEventsConfigFrame {
  return {
    kind: "config",
    role: "child",
    config_type: "00",
    config_var: "",
    component: "",
    devclass: "$TMP",
    ...overrides,
  } as FpmEventsConfigFrame;
}

function byElementId(rows: readonly FpmEventRow[], elementId: string): FpmEventRow | undefined {
  return rows.find((r) => r.elementId === elementId);
}

describe("splitEventFrames", () => {
  it("buckets every frame kind, in a single pass, without touching order within a bucket", () => {
    const raw = splitEventFrames([
      { kind: "config", role: "root", config_id: "A", config_type: "00", config_var: "" },
      { kind: "fpm_event", name: "GC_EVENT_SAVE", event_id: "FPM_SAVE" },
      { kind: "fpm_event_error", text: "boom" },
      { kind: "bopf_node", bo: "X", node_name: "ROOT", node_key: "K1", bo_key: "BK1" },
      { kind: "bopf_action", bo: "X", act_name: "SAVE", act_key: "K2", node_key: "K1", act_class: "", act_cat: "8" },
      { kind: "bopf_error", bo: "X", text: "bad table" },
      { kind: "summary", configs_read: 1, configs_failed: 0, configs_skipped: 0, bopf_nodes: 1, bopf_actions: 1, fpm_events: 1, truncated: "" },
    ]);
    expect(raw.configs.length).toBe(1);
    expect(raw.fpmEvents.length).toBe(1);
    expect(raw.fpmEventErrors.length).toBe(1);
    expect(raw.bopfNodes.length).toBe(1);
    expect(raw.bopfActions.length).toBe(1);
    expect(raw.bopfErrors.length).toBe(1);
    expect(raw.summary).toBeDefined();
    expect(raw.unrecognised).toEqual([]);
  });

  it("never throws on garbage input, and buckets unknown/malformed frames as unrecognised rather than dropping them", () => {
    const raw = splitEventFrames([
      { kind: "something_new_the_test_does_not_know_about", x: 1 },
      "just a string",
      42,
      null,
      undefined,
      [1, 2, 3],
      { no_kind_field: true },
    ]);
    expect(raw.unrecognised.length).toBe(7);
    expect(raw.configs).toEqual([]);
  });
});

describe("resolveFpmEvents — no root frame", () => {
  it("throws a clear error rather than silently returning an empty model", () => {
    const raw = splitEventFrames([{ kind: "summary", configs_read: 0, configs_failed: 0, configs_skipped: 0, bopf_nodes: 0, bopf_actions: 0, fpm_events: 0, truncated: "" }]);
    expect(() => resolveFpmEvents(raw)).toThrow(/no root config frame present/);
  });
});

describe("resolveFpmEvents — OVP toolbar (ovp-test-fbi-sales-order.config.xml)", () => {
  it("resolves both TOOLBAR areas' buttons with their real element IDs, texts, types, and event IDs", () => {
    const raw = splitEventFrames([
      rootConfig({ config_id: "/BOFU/TEST_FBI_SALES_ORDER_OVP", component: "FPM_OVP_COMPONENT", xml: OVP_TOOLBAR_XML }),
    ]);
    const ev = resolveFpmEvents(raw);

    // Six buttons total: five in the MAIN content area's TOOLBAR, one in the
    // INITIAL content area's TOOLBAR. All are TYPE=BU -> "Button". Every
    // EVENT_ID in this fixture's ACTION catalogue happens to be a real
    // standard FPM_* event, but no fpm_event catalogue frame was supplied
    // here, so standardVerified is false and every one comes back verified:false
    // (a name-prefix guess, not a verified match) - this is deliberate: it
    // shows the two-tier trust model, not just the happy path.
    const expected: [string, string, string][] = [
      ["ELEMENT_ID_5", "30", "FPM_EDIT"],
      ["ELEMENT_ID_6", "34", "FPM_SAVE"],
      ["ELEMENT_ID_7", "38", "FPM_READ_ONLY"],
      ["ELEMENT_ID_8", "42", "FPM_REFRESH"],
      ["ELEMENT_ID_9", "46", "FPM_CANCEL"],
      ["FPM_LEAVE_INITIAL_SCREEN_1", "12", "FPM_LEAVE_INITIAL_SCREEN"],
    ];
    for (const [elementId, text, eventId] of expected) {
      const row = byElementId(ev.events, elementId);
      expect(row, `no event row for ${elementId}`).toBeDefined();
      if (!row) continue;
      expect(row.source).toBe("toolbar");
      expect(row.text).toBe(text);
      expect(row.elementType).toBe("Button");
      expect(row.eventId).toBe(eventId);
      expect(row.handler).toEqual({ kind: "standard", eventId, verified: false });
    }
    expect(ev.events.length).toBe(6);
    expect(ev.notes).toContain(
      'resolve was not requested (or the CL_FPM_EVENT catalogue read produced nothing): "standard" handlers below ' +
        'are a name-prefix guess ("FPM_..." events only), not verified against the actual catalogue. Pass resolve=true for a verified match.',
    );
  });

  it("classifies the same event as verified once a matching fpm_event catalogue frame is present", () => {
    const raw = splitEventFrames([
      rootConfig({ config_id: "/BOFU/TEST_FBI_SALES_ORDER_OVP", xml: OVP_TOOLBAR_XML }),
      { kind: "fpm_event", name: "GC_EVENT_EDIT", event_id: "FPM_EDIT" },
      { kind: "fpm_event", name: "GC_EVENT_SAVE", event_id: "FPM_SAVE" },
    ]);
    const ev = resolveFpmEvents(raw);
    const edit = byElementId(ev.events, "ELEMENT_ID_5");
    const save = byElementId(ev.events, "ELEMENT_ID_6");
    expect(edit?.handler).toEqual({ kind: "standard", eventId: "FPM_EDIT", verified: true });
    expect(save?.handler).toEqual({ kind: "standard", eventId: "FPM_SAVE", verified: true });
    // FPM_READ_ONLY has no matching fpm_event frame in this raw, but the
    // catalogue WAS read successfully (standardVerified=true) - so it is no
    // longer given the benefit of the "looks standard" guess: not found in
    // the catalogue means genuinely unresolved, not a downgraded guess.
    const readOnly = byElementId(ev.events, "ELEMENT_ID_7");
    expect(readOnly?.handler.kind).toBe("unresolved");
  });

  it("reports a catalogue-read failure honestly rather than silently falling back", () => {
    const raw = splitEventFrames([
      rootConfig({ config_id: "/BOFU/TEST_FBI_SALES_ORDER_OVP", xml: OVP_TOOLBAR_XML }),
      { kind: "fpm_event_error", text: "CX_SY_DYN_CALL_ILLEGAL_METHOD: describe_by_name failed" },
    ]);
    const ev = resolveFpmEvents(raw);
    expect(
      ev.notes.some(
        (n) => n.includes("CL_FPM_EVENT catalogue read failed") && n.includes("CX_SY_DYN_CALL_ILLEGAL_METHOD"),
      ),
    ).toBe(true);
    // Falls back to the same unverified name-prefix guess as "never resolved".
    expect(byElementId(ev.events, "ELEMENT_ID_5")?.handler).toEqual({ kind: "standard", eventId: "FPM_EDIT", verified: false });
  });

  it("falls back to the raw numeric text key, with a note, when no WDY_CONFIG_COMPT row matches it (issue #101 Defect 3)", () => {
    // No text_id frames at all here, so every Transl="true" TEXT (30, 34,
    // 38, 42, 46, 12 in this fixture) is left unresolved.
    const raw = splitEventFrames([rootConfig({ config_id: "/BOFU/TEST_FBI_SALES_ORDER_OVP", xml: OVP_TOOLBAR_XML })]);
    const ev = resolveFpmEvents(raw);
    const translatable = ev.events.filter((e) => e.textKey !== undefined);
    expect(translatable.length).toBeGreaterThan(0);
    for (const row of translatable) {
      expect(row.text).toBe(row.textKey);
    }
    expect(ev.notes.some((n) => n.includes("WDY_CONFIG_COMPT") && n.includes("no matching row"))).toBe(true);
  });

  it("resolves a Transl=\"true\" toolbar text to its WDY_CONFIG_COMPT description, preferring the logon language (issue #101 Defect 3)", () => {
    const raw = splitEventFrames([
      rootConfig({ config_id: "/BOFU/TEST_FBI_SALES_ORDER_OVP", xml: OVP_TOOLBAR_XML }),
      { kind: "text_id", config_id: "/BOFU/TEST_FBI_SALES_ORDER_OVP", config_type: "00", config_var: "", langu: "E", text_id: "30", description: "Change" },
      { kind: "text_id", config_id: "/BOFU/TEST_FBI_SALES_ORDER_OVP", config_type: "00", config_var: "", langu: "D", text_id: "30", description: "Ändern" },
      { kind: "summary", configs_read: 1, configs_failed: 0, configs_skipped: 0, bopf_nodes: 0, bopf_actions: 0, fpm_events: 0, text_ids: 2, logon_langu: "D", truncated: "" },
    ]);
    const ev = resolveFpmEvents(raw);
    const changed = ev.events.find((e) => e.textKey === "30");
    expect(changed).toBeDefined();
    expect(changed?.text).toBe("Ändern");
    expect(changed?.textKey).toBe("30");
    expect(ev.notes.some((n) => n.includes("WDY_CONFIG_COMPT") && n.includes("resolved"))).toBe(true);
  });

  it("falls back to \"E\", then to whatever language is on file, when the logon language has no row (issue #101 Defect 3)", () => {
    const rawFallbackToE = splitEventFrames([
      rootConfig({ config_id: "/BOFU/TEST_FBI_SALES_ORDER_OVP", xml: OVP_TOOLBAR_XML }),
      { kind: "text_id", config_id: "/BOFU/TEST_FBI_SALES_ORDER_OVP", config_type: "00", config_var: "", langu: "E", text_id: "30", description: "Change" },
      { kind: "summary", configs_read: 1, configs_failed: 0, configs_skipped: 0, bopf_nodes: 0, bopf_actions: 0, fpm_events: 0, text_ids: 1, logon_langu: "F", truncated: "" },
    ]);
    const evFallbackToE = resolveFpmEvents(rawFallbackToE);
    expect(evFallbackToE.events.find((e) => e.textKey === "30")?.text).toBe("Change");

    const rawFallbackToFirst = splitEventFrames([
      rootConfig({ config_id: "/BOFU/TEST_FBI_SALES_ORDER_OVP", xml: OVP_TOOLBAR_XML }),
      { kind: "text_id", config_id: "/BOFU/TEST_FBI_SALES_ORDER_OVP", config_type: "00", config_var: "", langu: "J", text_id: "30", description: "変更" },
      { kind: "summary", configs_read: 1, configs_failed: 0, configs_skipped: 0, bopf_nodes: 0, bopf_actions: 0, fpm_events: 0, text_ids: 1, logon_langu: "F", truncated: "" },
    ]);
    const evFallbackToFirst = resolveFpmEvents(rawFallbackToFirst);
    expect(evFallbackToFirst.events.find((e) => e.textKey === "30")?.text).toBe("変更");
  });

  it("reports a WDY_CONFIG_COMPT read failure as an explicit note, and leaves text as the raw key (issue #101 Defect 3)", () => {
    const raw = splitEventFrames([
      rootConfig({ config_id: "/BOFU/TEST_FBI_SALES_ORDER_OVP", xml: OVP_TOOLBAR_XML }),
      { kind: "text_id_error", text: "DBIF_RSQL_TABLE_UNKNOWN" },
    ]);
    const ev = resolveFpmEvents(raw);
    const row = ev.events.find((e) => e.textKey === "30");
    expect(row?.text).toBe("30");
    expect(ev.notes.some((n) => n.includes("WDY_CONFIG_COMPT") && n.includes("DBIF_RSQL_TABLE_UNKNOWN"))).toBe(true);
  });

  it("decodes all four WIRE_MODEL/WIRE rows (source/target/connector), and does not attempt to decode DEPENDENCY_PARAM", () => {
    const raw = splitEventFrames([rootConfig({ config_id: "/BOFU/TEST_FBI_SALES_ORDER_OVP", xml: OVP_TOOLBAR_XML })]);
    const ev = resolveFpmEvents(raw);
    expect(ev.wires.length).toBe(4);
    expect(ev.wires.map((w) => [w.configId, w.srcConfigId, w.srcComponent, w.connector])).toEqual([
      ["/BOFU/TEST_SALES_ORDER_BOOTSTRAP", "/BOFU/TEST_SALES_ORDER_ALTKEY", "FPM_FORM_UIBB", "/BOFU/CL_FBI_CONNECTOR"],
      ["/BOFU/TEST_SALES_ORDER_MAIN_FORM", "/BOFU/TEST_SALES_ORDER_BOOTSTRAP", "FPM_FORM_UIBB", "/BOFU/CL_FBI_CONNECTOR"],
      ["/BOFU/TEST_SALES_ORDER_ITEM_LIST", "/BOFU/TEST_SALES_ORDER_MAIN_FORM", "FPM_FORM_UIBB", "/BOFU/CL_FBI_CONNECTOR"],
      ["/BOFU/TEST_SALES_ORDER_ITEM_DET", "/BOFU/TEST_SALES_ORDER_ITEM_LIST", "FPM_LIST_UIBB", "/BOFU/CL_FBI_CONNECTOR"],
    ]);
    // FpmWireRow (src/adt/fpm-events.ts) has no dependencyParam field at
    // all — DEPENDENCY_PARAM (double-HTML-entity-escaped embedded XML, per
    // this fixture) is read from the config's raw XML but never surfaced in
    // the resolved wire row. This is not a decode failure to fix here, just
    // an honest statement of current scope: the double-escaped payload is
    // simply not part of what this trace reports.
    expect(Object.keys(ev.wires[0])).not.toContain("dependencyParam");
  });
});

describe("resolveFpmEvents — LIST GUIBB button row (list-uibb-test-sales-order-item.config.xml)", () => {
  it("resolves BUTTON_ROW_ELEMENT/BUTTON_ACTION to a bopf handler via the row's own config BO parameter", () => {
    const raw = splitEventFrames([
      rootConfig({ config_id: "/BOFU/TEST_SALES_ORDER_ITEM_LIST", component: "FPM_LIST_UIBB", xml: LIST_GUIBB_XML }),
    ]);
    const ev = resolveFpmEvents(raw);
    expect(ev.events.length).toBe(2);

    const create = byElementId(ev.events, "_CFG_BUTTON_ROW_ELEMENT_6");
    const del = byElementId(ev.events, "_CFG_BUTTON_ROW_ELEMENT_8");
    expect(create).toBeDefined();
    expect(del).toBeDefined();
    if (!create || !del) return;

    expect(create.source).toBe("button_row");
    expect(create.eventId).toBe("FBI_CREATE");
    expect(create.elementType).toBe("Button");
    expect(del.eventId).toBe("FBI_DELETE");

    // The config's own PARAMETER node has NAME=BO/VALUE=/BOFU/TEST_SALES_ORDER
    // and a sibling NAME=NODE/VALUE=ITEM pair (an Item/NAME-VALUE pair, not a
    // literal <BO>/<NODE> element — see the FBI VIEW test below for the
    // other shape) and a literal FEEDER element (/BOFU/CL_FBI_GUIBB_LIST).
    // Because a BO parameter is present, "bopf" wins over "feeder"
    // (classifyHandler checks boNames before feeders). No bopf_node/
    // bopf_action frames were supplied in this raw (resolve was not
    // requested), so `action` stays undefined even though FBI_CREATE/
    // FBI_DELETE are exactly the framework-event case issue #101 calls
    // out: their real BOPF action (CREATE_ITEM/DELETE_ITEM under BOPF node
    // ITEM, confirmed live against /BOFU/TEST_SALES_ORDER's own
    // /BOBF/ACT_LIST) is mapped internally by the FBI connector and never
    // named as "FBI_CREATE"/"FBI_DELETE" anywhere in configuration or in
    // the BOPF catalogue itself.
    const noteFor = (eventId: string) =>
      `node/action were not verified against /BOBF/OBM_NODE or /BOBF/ACT_LIST for BO "/BOFU/TEST_SALES_ORDER" — pass resolve=true to fetch that catalogue. ` +
      `event "${eventId}" is an FBI framework event — its real BOPF action is mapped internally by the FBI connector and never appears in /BOBF/ACT_LIST or anywhere else in configuration, so it would not have been determinable even with resolve=true.`;
    expect(create.handler).toEqual({
      kind: "bopf",
      bo: "/BOFU/TEST_SALES_ORDER",
      node: "ITEM",
      action: undefined,
      call: 'abap_bopf {"mode":"show","bo":"/BOFU/TEST_SALES_ORDER"}',
      note: noteFor("FBI_CREATE"),
    });
    expect(del.handler).toEqual({
      kind: "bopf",
      bo: "/BOFU/TEST_SALES_ORDER",
      node: "ITEM",
      action: undefined,
      call: 'abap_bopf {"mode":"show","bo":"/BOFU/TEST_SALES_ORDER"}',
      note: noteFor("FBI_DELETE"),
    });
  });
});

describe("resolveFpmEvents — FBI VIEW action mapping (36-BOFU_DEMO_SO_HDR_VIEW.full-config.xml)", () => {
  it("resolves DELIVER_ORDER from ACTION_IMPL, since its ACTION_CONF target was never fetched (ACTION_CONF is only preferred when it names a config that was actually read)", () => {
    // This fixture's own ACTIONS/DELIVER_ORDER entry has BOTH an ACTION_CONF
    // ("/BOFU/DEMO/DELIVER_CONFIRMATION") and an ACTION_IMPL ("DELIVER").
    // walk_refs (fluid/builtin/fpm.ts) only follows Items with a literal
    // CONFIG_ID child, and ACTION_CONF is not one, so that config is never
    // fetched in practice. Per the source's precedence (src/adt/fpm-events.ts),
    // ACTION_CONF only wins when it names a config that is actually among the
    // ones read (parsedConfigs); here it doesn't, so resolution falls through
    // to the concrete ACTION_IMPL class instead of reporting unresolved.
    const raw = splitEventFrames([
      rootConfig({ config_id: "/BOFU/DEMO_SO_HDR_VIEW", component: "/BOFU/FBI_VIEW", xml: FBI_VIEW_XML }),
    ]);
    const ev = resolveFpmEvents(raw);
    const row = byElementId(ev.events, "DELIVER_ORDER");
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.source).toBe("fbi_action");
    expect(row.text).toBe("DELIVER");
    expect(row.handler).toEqual({ kind: "action_impl", implClass: "DELIVER" });
  });

  it("extracts BO/NODE from HEADER's literal <BO>/<NODE> elements (the shape this fixture uses, distinct from the Item/NAME=BO,VALUE pair the LIST GUIBB fixture uses) and resolves a referencing toolbar button to bopf", () => {
    // HEADER declares <BO>/BOFU/DEMO_SALES_ORDER</BO><NODE>ROOT</NODE> as bare
    // elements, not wrapped in an Item with NAME="BO". collectBoNames handles
    // both shapes (src/adt/fpm-events.ts collectBoNames), but is not exported,
    // so it is only checkable indirectly: wire a root config's toolbar button
    // at this child config and confirm the handler comes back "bopf" with the
    // BO taken from HEADER.
    const rootXml =
      `<?xml version="1.0"?><Component Name="ROOT" ConfId="ROOT_CFG" ConfType="00" ConfVar="">` +
      `<Node Name="CONFIGURATION_CONTEXT" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<Node Name="ACTION" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<ID>OPEN_HDR</ID><EVENT_ID>SHOW_DETAIL</EVENT_ID><COMPONENT></COMPONENT>` +
      `<CONFIG_ID>/BOFU/DEMO_SO_HDR_VIEW</CONFIG_ID><CONFIG_TYPE>00</CONFIG_TYPE><CONFIG_VAR></CONFIG_VAR>` +
      `</Item></Node></Item></Node>` +
      `<Node Name="TOOLBAR" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<Node Name="BUTTON" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<ELEMENT_ID>OPEN_HDR</ELEMENT_ID><TEXT>1</TEXT><TYPE>BU</TYPE>` +
      `<Node Name="BUTTON_SUB_ITEM" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<ACTION_ID>OPEN_HDR</ACTION_ID></Item></Node>` +
      `</Item></Node></Item></Node></Component>`;

    const raw = splitEventFrames([
      rootConfig({ config_id: "ROOT_CFG", xml: rootXml }),
      childConfig({ config_id: "/BOFU/DEMO_SO_HDR_VIEW", ref_node: "TOOLBAR", xml: FBI_VIEW_XML }),
    ]);
    const ev = resolveFpmEvents(raw);
    expect(ev.views).toEqual(["ROOT_CFG", "/BOFU/DEMO_SO_HDR_VIEW"]);

    const openHdr = byElementId(ev.events, "OPEN_HDR");
    expect(openHdr).toBeDefined();
    // The event id here is "SHOW_DETAIL" (this ACTION catalogue entry's own
    // EVENT_ID), not an FBI_ framework event — so the note is the plain
    // "not verified" one, without the framework-event caveat.
    expect(openHdr?.handler).toEqual({
      kind: "bopf",
      bo: "/BOFU/DEMO_SALES_ORDER",
      node: "ROOT",
      action: undefined,
      call: 'abap_bopf {"mode":"show","bo":"/BOFU/DEMO_SALES_ORDER"}',
      note: 'node/action were not verified against /BOBF/OBM_NODE or /BOBF/ACT_LIST for BO "/BOFU/DEMO_SALES_ORDER" — pass resolve=true to fetch that catalogue.',
    });

    // The referenced child config's own DELIVER_ORDER fbi_action is still
    // resolved too (parsedConfigs includes every readable config, root and
    // child alike) - same ACTION_IMPL fallback outcome as above.
    const deliver = byElementId(ev.events, "DELIVER_ORDER");
    expect(deliver?.handler.kind).toBe("action_impl");
  });
});

describe("resolveFpmEvents — app controller (ovp-appcc-class.config.xml)", () => {
  it("resolves APP_SPECIFIC_CC to the ABAP class, and does not mistake its empty CONFIG_ID for a component config", () => {
    const raw = splitEventFrames([
      rootConfig({ config_id: "FPM_WIRE_TEST_OVP_APPCC_CL", component: "FPM_OVP_COMPONENT", xml: APPCC_XML }),
    ]);
    const ev = resolveFpmEvents(raw);
    expect(ev.appController).toBeDefined();
    // CONFIG_ID on this APP_SPECIFIC_CC entry is blank — only COMPONENT is
    // set. classifyHandler's own component-target branch and
    // resolveFpmEvents's own appController-detection both treat a truthy
    // COMPONENT (even with a blank CONFIG_ID) as enough to register an app
    // controller; if this were reversed (requiring configId to be truthy)
    // the app controller would be silently missed for every AppCC-only
    // config, since AppCC is class-based and never carries a config_id.
    expect(ev.appController).toEqual({
      component: "CL_FPM_WIRE_TEST_APPCC_ASSIST",
      configId: "",
      configType: "00",
      configVar: "",
    });
  });

  it("resolves a toolbar button's ACTION_ID via the counter-suffix fallback (ACTION_ID 'FPM_SAVE' catalogued under ID 'FPM_SAVE_1')", () => {
    const raw = splitEventFrames([rootConfig({ config_id: "FPM_WIRE_TEST_OVP_APPCC_CL", xml: APPCC_XML })]);
    const ev = resolveFpmEvents(raw);
    const save = byElementId(ev.events, "FPM_SAVE");
    expect(save).toBeDefined();
    expect(save?.eventId).toBe("FPM_SAVE");
    expect(save?.handler).toEqual({ kind: "standard", eventId: "FPM_SAVE", verified: false });
  });

  it('reports a toolbar button whose target config was never read as unresolved, naming the specific reason ("not read")', () => {
    // UIBB_ACTION1's ACTION catalogue entry targets FPM_LIST_UIBB config
    // FPM_WIRE_TEST_SOURCE_LIST, which this raw never supplies a config
    // frame for (only the root APPCC config is present) — classifyHandler
    // must say so explicitly, not guess a handler kind it cannot support.
    const raw = splitEventFrames([rootConfig({ config_id: "FPM_WIRE_TEST_OVP_APPCC_CL", xml: APPCC_XML })]);
    const ev = resolveFpmEvents(raw);
    const uibbAction = byElementId(ev.events, "UIBB_ACTION1");
    expect(uibbAction).toBeDefined();
    expect(uibbAction?.handler.kind).toBe("unresolved");
    if (uibbAction?.handler.kind === "unresolved") {
      expect(uibbAction.handler.reason).toContain("FPM_WIRE_TEST_SOURCE_LIST");
      expect(uibbAction.handler.reason).toContain("was not read");
    }
  });
});

describe("resolveFpmEvents — unresolved shapes are always surfaced, never dropped", () => {
  it("a toolbar button with no ACTION_SUB_ITEM and no matching ACTION catalogue entry comes back unresolved with a specific reason", () => {
    // This is the single most important behaviour for issue #101: an
    // unrecognised/unmatched element must be reported, not silently vanish
    // from the trace. FpmEventHandlerUnresolved (src/adt/fpm-events.ts)
    // carries both a `reason: string` and an `excerpt` of the raw offending
    // element (truncated via truncateText, never a hand-rolled slice) —
    // assert both below.
    const rootXml =
      `<?xml version="1.0"?><Component Name="X" ConfId="MYSTERY" ConfType="00" ConfVar="">` +
      `<Node Name="TOOLBAR" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<Node Name="BUTTON" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<ELEMENT_ID>MYSTERY_BTN</ELEMENT_ID><TEXT>1</TEXT><TYPE>ZZ</TYPE>` +
      `</Item></Node></Item></Node></Component>`;
    const raw = splitEventFrames([rootConfig({ config_id: "MYSTERY", xml: rootXml })]);
    const ev = resolveFpmEvents(raw);
    expect(ev.events.length).toBe(1);
    const row = ev.events[0];
    expect(row.elementId).toBe("MYSTERY_BTN");
    // Unrecognised TYPE code "ZZ" is reported as-is rather than mapped to a
    // decoded label — same "surface it, don't guess" principle.
    expect(row.elementType).toBe("ZZ (code not decoded)");
    expect(row.handler.kind).toBe("unresolved");
    if (row.handler.kind === "unresolved") {
      expect(row.handler.reason.length).toBeGreaterThan(0);
      expect(row.handler.reason).toContain("no ACTION catalogue entry matched this toolbar element's id");
      expect(row.handler.excerpt).toBeDefined();
      expect(row.handler.excerpt?.length ?? 0).toBeGreaterThan(0);
      expect(row.handler.excerpt).toContain("MYSTERY_BTN");
    }
  });

  it("a BUTTON_ROW_ELEMENT with no BUTTON_ACTION child comes back unresolved rather than being skipped", () => {
    const rootXml =
      `<?xml version="1.0"?><Component Name="X" ConfId="ROWCFG" ConfType="00" ConfVar="">` +
      `<Node Name="BUTTON_ROW" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<Node Name="BUTTON_ROW_ELEMENT" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<ELEMENT_ID>NO_ACTION_ROW</ELEMENT_ID><TEXT></TEXT><DISPLAY_TYPE>BT</DISPLAY_TYPE>` +
      `</Item></Node></Item></Node></Component>`;
    const raw = splitEventFrames([rootConfig({ config_id: "ROWCFG", xml: rootXml })]);
    const ev = resolveFpmEvents(raw);
    expect(ev.events.length).toBe(1);
    const handler = ev.events[0].handler;
    expect(handler.kind).toBe("unresolved");
    if (handler.kind === "unresolved") {
      expect(handler.reason).toBe("no BUTTON_ACTION child — this button row element declares no event");
      expect(handler.excerpt).toBeDefined();
      expect(handler.excerpt?.length ?? 0).toBeGreaterThan(0);
      expect(handler.excerpt).toContain("NO_ACTION_ROW");
    }
  });

  it("an fbi_action with neither ACTION_IMPL nor ACTION_CONF comes back unresolved rather than being skipped", () => {
    const rootXml =
      `<?xml version="1.0"?><Component Name="X" ConfId="ACTCFG" ConfType="00" ConfVar="">` +
      `<Node Name="CONFIGURATION_CONTEXT" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<Node Name="ACTIONS" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<ACTIONID>BARE_ACTION</ACTIONID><TEXT>bare</TEXT>` +
      `</Item></Node></Item></Node></Component>`;
    const raw = splitEventFrames([rootConfig({ config_id: "ACTCFG", xml: rootXml })]);
    const ev = resolveFpmEvents(raw);
    expect(ev.events.length).toBe(1);
    const handler = ev.events[0].handler;
    expect(handler.kind).toBe("unresolved");
    if (handler.kind === "unresolved") {
      expect(handler.reason).toBe("no ACTION_IMPL/ACTION_CONF — cannot tell what handles this action");
      expect(handler.excerpt).toBeDefined();
      expect(handler.excerpt?.length ?? 0).toBeGreaterThan(0);
      expect(handler.excerpt).toContain("BARE_ACTION");
    }
  });
});

describe("resolveFpmEvents — root XML that does not parse as an fpm/fbi Component", () => {
  it("discloses the parse failure via a note rather than throwing or silently returning an empty trace", () => {
    const raw = splitEventFrames([rootConfig({ config_id: "BROKEN", xml: "not xml at all { }" })]);
    const ev = resolveFpmEvents(raw);
    expect(ev.events).toEqual([]);
    expect(
      ev.notes.some((n) => n.includes("could not be parsed as an fpm/fbi Component document")),
    ).toBe(true);
  });
});

describe("resolveFpmEvents — unreadable/skipped child configs are reported, not silently absorbed", () => {
  it("carries read_error and skipped children through to ev.unreadable / ev.skipped", () => {
    const raw = splitEventFrames([
      rootConfig({ config_id: "ROOT", xml: `<Component Name="X" ConfId="ROOT" ConfType="00" ConfVar=""/>` }),
      childConfig({ config_id: "BAD_CHILD", read_error: "wdy_config_appl: no matching row for the given key" }),
      childConfig({ config_id: "SKIPPED_CHILD", skipped: "uibb-filter" }),
    ]);
    const ev = resolveFpmEvents(raw);
    expect(ev.unreadable).toEqual([
      { configId: "BAD_CHILD", configType: "00", configVar: "", error: "wdy_config_appl: no matching row for the given key" },
    ]);
    expect(ev.skipped).toEqual([{ configId: "SKIPPED_CHILD", configType: "00", configVar: "" }]);
  });
});

describe("resolveFpmEvents — BOPF catalogue frames pass through splitEventFrames intact", () => {
  it("a sample of the captured /BOBF/OBM_NODE + /BOBF/ACT_LIST rows bucket correctly and do not affect event resolution", () => {
    const node = BOPF_CATALOGUE.nodes.find((n) => n.nodeName === "ROOT");
    const action = BOPF_CATALOGUE.actions.find((a) => a.actName === "DELIVER");
    expect(node).toBeDefined();
    expect(action).toBeDefined();
    if (!node || !action) return;

    const raw = splitEventFrames([
      rootConfig({ config_id: "ROOT", xml: `<Component Name="X" ConfId="ROOT" ConfType="00" ConfVar=""/>` }),
      { kind: "bopf_node", bo: BOPF_CATALOGUE.bo, node_name: node.nodeName, node_key: node.nodeKey, bo_key: node.boKey },
      {
        kind: "bopf_action",
        bo: BOPF_CATALOGUE.bo,
        act_name: action.actName,
        act_key: action.actKey,
        node_key: action.nodeKey,
        act_class: action.actClass,
        act_cat: action.actCat,
      },
    ]);
    expect(raw.bopfNodes.length).toBe(1);
    expect(raw.bopfActions.length).toBe(1);
    expect(raw.bopfActions[0].act_class).toBe("/BOBF/CL_DEMO_SAM_SALES_ORDER");

    // This particular config has no toolbar/button elements at all, so
    // there is nothing here for the bopf_node/bopf_action frames to feed
    // into — `events` stays empty. See the next describe block for cases
    // where they DO feed into a "bopf" handler's node/action fields.
    const ev = resolveFpmEvents(raw);
    expect(ev.events).toEqual([]);
  });
});

describe("resolveFpmEvents — bopf handler node/action verification against the BOPF catalogue (issue #101 Defect 1)", () => {
  // A minimal synthetic config: one BUTTON_ROW_ELEMENT whose BUTTON_ACTION
  // event id is deliberately chosen to literally match a real BOPF action
  // name, on a config whose PARAMETER declares BO+NODE — every field
  // classifyHandler/buildBopfHandler needs, isolated from any of the other
  // fixtures' incidental shapes.
  function rowConfigXml(bo: string, node: string, eventId: string): string {
    return (
      `<?xml version="1.0"?><Component Name="X" ConfId="BOPFCFG" ConfType="00" ConfVar="">` +
      `<Node Name="PARAMETER" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<Item Index="000001"><NAME>BO</NAME><VALUE>${bo}</VALUE></Item>` +
      `<Item Index="000002"><NAME>NODE</NAME><VALUE>${node}</VALUE></Item>` +
      `</Item></Node>` +
      `<Node Name="BUTTON_ROW" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<Node Name="BUTTON_ROW_ELEMENT" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<ELEMENT_ID>ROW_1</ELEMENT_ID><TEXT></TEXT><DISPLAY_TYPE>BT</DISPLAY_TYPE>` +
      `<Node Name="BUTTON_ACTION" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<EVENT_ID>${eventId}</EVENT_ID><TEXT></TEXT></Item></Node>` +
      `</Item></Node></Item></Node></Component>`
    );
  }

  it("confirms both node and action when they match the fetched /BOBF/OBM_NODE + /BOBF/ACT_LIST rows — no note needed", () => {
    const bo = BOPF_CATALOGUE.bo;
    const node = BOPF_CATALOGUE.nodes.find((n) => n.nodeName === "ITEM");
    const action = BOPF_CATALOGUE.actions.find((a) => a.actName === "CREATE_ITEM");
    expect(node).toBeDefined();
    expect(action).toBeDefined();
    if (!node || !action) return;

    const raw = splitEventFrames([
      rootConfig({ config_id: "BOPFCFG", xml: rowConfigXml(bo, "ITEM", "CREATE_ITEM") }),
      { kind: "bopf_node", bo, node_name: node.nodeName, node_key: node.nodeKey, bo_key: node.boKey },
      { kind: "bopf_action", bo, act_name: action.actName, act_key: action.actKey, node_key: action.nodeKey, act_class: action.actClass, act_cat: action.actCat },
    ]);
    const ev = resolveFpmEvents(raw);
    const row = byElementId(ev.events, "ROW_1");
    expect(row?.handler).toEqual({
      kind: "bopf",
      bo,
      node: "ITEM",
      action: "CREATE_ITEM",
      call: `abap_bopf {"mode":"show","bo":"${bo}"}`,
      note: undefined,
    });
  });

  it("keeps an unmatched node name rather than dropping it, and explains why the action can't be confirmed either", () => {
    const bo = BOPF_CATALOGUE.bo;
    const node = BOPF_CATALOGUE.nodes.find((n) => n.nodeName === "ITEM");
    expect(node).toBeDefined();
    if (!node) return;

    const raw = splitEventFrames([
      rootConfig({ config_id: "BOPFCFG", xml: rowConfigXml(bo, "NO_SUCH_NODE", "NO_SUCH_ACTION") }),
      { kind: "bopf_node", bo, node_name: node.nodeName, node_key: node.nodeKey, bo_key: node.boKey },
    ]);
    const ev = resolveFpmEvents(raw);
    const row = byElementId(ev.events, "ROW_1");
    expect(row?.handler.kind).toBe("bopf");
    if (row?.handler.kind !== "bopf") return;
    expect(row.handler.node).toBe("NO_SUCH_NODE");
    expect(row.handler.action).toBeUndefined();
    expect(row.handler.note).toContain(`node "NO_SUCH_NODE" was not found in /BOBF/OBM_NODE for BO "${bo}"`);
    expect(row.handler.note).toContain(`event "NO_SUCH_ACTION" does not name any action in /BOBF/ACT_LIST for BO "${bo}"`);
  });

  it("reports a failed BOPF catalogue read as an explicit note rather than a false negative", () => {
    const bo = BOPF_CATALOGUE.bo;
    const raw = splitEventFrames([
      rootConfig({ config_id: "BOPFCFG", xml: rowConfigXml(bo, "ITEM", "CREATE_ITEM") }),
      { kind: "bopf_error", bo, text: "DBIF_RSQL_TABLE_UNKNOWN" },
    ]);
    const ev = resolveFpmEvents(raw);
    const row = byElementId(ev.events, "ROW_1");
    expect(row?.handler.kind).toBe("bopf");
    if (row?.handler.kind !== "bopf") return;
    expect(row.handler.node).toBe("ITEM");
    expect(row.handler.action).toBeUndefined();
    expect(row.handler.note).toContain(`the /BOBF/OBM_NODE + /BOBF/ACT_LIST read for BO "${bo}" failed (DBIF_RSQL_TABLE_UNKNOWN)`);
  });

  it("leaves node undefined, with a note, when the config pairs no NODE with its BO at all", () => {
    const rootXml =
      `<?xml version="1.0"?><Component Name="X" ConfId="NONODE" ConfType="00" ConfVar="">` +
      `<Node Name="PARAMETER" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<Item Index="000001"><NAME>BO</NAME><VALUE>/BOFU/X</VALUE></Item>` +
      `</Item></Node>` +
      `<Node Name="BUTTON_ROW" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<Node Name="BUTTON_ROW_ELEMENT" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<ELEMENT_ID>ROW_1</ELEMENT_ID><TEXT></TEXT><DISPLAY_TYPE>BT</DISPLAY_TYPE>` +
      `<Node Name="BUTTON_ACTION" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<EVENT_ID>SOME_EVENT</EVENT_ID><TEXT></TEXT></Item></Node>` +
      `</Item></Node></Item></Node></Component>`;
    const raw = splitEventFrames([rootConfig({ config_id: "NONODE", xml: rootXml })]);
    const ev = resolveFpmEvents(raw);
    const row = byElementId(ev.events, "ROW_1");
    expect(row?.handler.kind).toBe("bopf");
    if (row?.handler.kind !== "bopf") return;
    expect(row.handler.node).toBeUndefined();
    expect(row.handler.note).toContain('no NODE is paired with BO "/BOFU/X" anywhere in this button\'s config');
  });
});

describe("resolveFpmEvents — feeder handler method (issue #101 Defect 2)", () => {
  // No BO anywhere in this config, so classifyHandler falls through to the
  // feeder branch instead of bopf. FEEDER_INTERFACE_BY_COMPONENT is keyed
  // by the config's own COMPONENT (WDY_CONFIG_DATA/_APPL's COMPONENT
  // column, threaded straight through as FpmEventsConfigFrame.component).
  function feederConfigXml(eventId: string): string {
    return (
      `<?xml version="1.0"?><Component Name="X" ConfId="FEEDERCFG" ConfType="00" ConfVar="">` +
      `<Node Name="CONFIGURATION_CONTEXT" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<FEEDER>ZCL_MY_FEEDER</FEEDER>` +
      `<Node Name="BUTTON_ROW" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<Node Name="BUTTON_ROW_ELEMENT" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<ELEMENT_ID>ROW_1</ELEMENT_ID><TEXT></TEXT><DISPLAY_TYPE>BT</DISPLAY_TYPE>` +
      `<Node Name="BUTTON_ACTION" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<EVENT_ID>${eventId}</EVENT_ID><TEXT></TEXT></Item></Node>` +
      `</Item></Node></Item></Node>` +
      `</Item></Node></Component>`
    );
  }

  it("names the interface-qualified PROCESS_EVENT method and an abap_read call for a known GUIBB component", () => {
    const raw = splitEventFrames([
      rootConfig({ config_id: "FEEDERCFG", component: "FPM_FORM_UIBB", xml: feederConfigXml("MY_EVENT") }),
    ]);
    const ev = resolveFpmEvents(raw);
    const row = byElementId(ev.events, "ROW_1");
    expect(row?.handler).toEqual({
      kind: "feeder",
      feederClass: "ZCL_MY_FEEDER",
      configId: "FEEDERCFG",
      configType: "00",
      configVar: "",
      method: "IF_FPM_GUIBB_FORM~PROCESS_EVENT",
      call: 'abap_read {"object":"ZCL_MY_FEEDER","method":"IF_FPM_GUIBB_FORM~PROCESS_EVENT"}',
    });
  });

  it("leaves method and call undefined for a component with no confirmed GUIBB event interface", () => {
    const raw = splitEventFrames([
      rootConfig({ config_id: "FEEDERCFG", component: "/BOFU/FBI_VIEW", xml: feederConfigXml("MY_EVENT") }),
    ]);
    const ev = resolveFpmEvents(raw);
    const row = byElementId(ev.events, "ROW_1");
    expect(row?.handler.kind).toBe("feeder");
    if (row?.handler.kind !== "feeder") return;
    expect(row.handler.feederClass).toBe("ZCL_MY_FEEDER");
    expect(row.handler.method).toBeUndefined();
    expect(row.handler.call).toBeUndefined();
  });
});
