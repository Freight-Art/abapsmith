/**
 * BOPF runtime exerciser — offline. Nothing here touches SAP; the transport is
 * faked through `ConnectionOptions.httpClient` exactly like test/run.test.ts,
 * whose `RecordingClient` / `resp` / `connected` pattern this file repeats
 * self-contained rather than importing (matching that file's own choice not
 * to share a fixture module with test/write.test.ts's heavier `FakeAdt`).
 */
import { describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { deployBridge, executeBridge, ERR_LINE_PREFIX } from "../src/adt/run.js";
import {
  BOPF_LINE_PREFIX,
  bopfBridgeClassName,
  bopfBridgeSource,
  formatNodeLabel,
  parseBopfTranscript,
  runBopfTest,
  type BoModel,
  type BopfTestScenario,
} from "../src/adt/bopf-runtime.js";
import type { AdtObjectRef, BoAssociation, BoNode } from "../src/adt/bopf-types.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
//
// The real BoModel/BoNode/BoAssociation (bopf-types.ts) mark almost every field
// `readonly`, and carry a lot of boilerplate this suite doesn't care about
// (properties/alternativeKeys/queries/actions/determinations/validations are
// always []). `Mut<T>` strips the readonly modifiers one level deep so tests
// can mutate a cloned fixture in place, exactly like the old placeholder types
// allowed; `makeNode`/`makeAssociation` fill in the required-but-irrelevant
// fields so each test only has to name what it's actually varying.

type Mut<T> = { -readonly [K in keyof T]: T[K] };

const ref = (type: string, name: string): AdtObjectRef => ({ type, name });

function makeAssociation(over: Partial<BoAssociation> & { name: string }): Mut<BoAssociation> {
  return { ...over };
}

function makeNode(
  over: Partial<BoNode> & { name: string; rootNode: boolean },
): Mut<BoNode> & { associations: Mut<BoAssociation>[] } {
  return {
    xmlName: undefined,
    doEmbeddingName: undefined,
    parentNodeId: undefined,
    parent: undefined,
    nodeId: undefined,
    textNode: false,
    isDependentObjectNode: false,
    createEnabled: true,
    updateEnabled: true,
    deleteEnabled: true,
    authorizationCheck: false,
    isExtensible: false,
    objectModelGenerated: false,
    objectModelObsolete: false,
    properties: [],
    alternativeKeys: [],
    queries: [],
    actions: [],
    determinations: [],
    validations: [],
    associations: [],
    ...over,
  };
}

const CONSTANTS_INTERFACE = "ZIF_BOPF_ORDER_C";

const MODEL: BoModel = {
  name: "ZBOPF_ORDER",
  type: "BOBF",
  version: "active",
  constantsInterfaceRef: ref("BOPF/CI", CONSTANTS_INTERFACE),
  nodes: [
    makeNode({
      name: "ROOT",
      rootNode: true,
      persistentStructureRef: ref("DDLS/DF", "ZBOPF_S_ORDER_ROOT"),
      persistentTableRef: ref("TABL/DT", "ZBOPF_D_ORDER_ROOT"),
      associations: [makeAssociation({ name: "ITEMS", targetNodeRef: ref("BOPF/NODE", "ITEM") })],
    }),
    makeNode({
      name: "ITEM",
      rootNode: false,
      persistentStructureRef: ref("DDLS/DF", "ZBOPF_S_ORDER_ITEM"),
      persistentTableRef: ref("TABL/DT", "ZBOPF_D_ORDER_ITEM"),
    }),
  ],
};

const SCENARIO: BopfTestScenario = {
  nodes: [
    { node: "ROOT", fields: { ORDER_ID: "MCP0001", SALES_ORG: "MCP" } },
    { node: "ITEM", parentNode: "ROOT", fields: { ITEM_NO: "0010" } },
  ],
};

/** Deep-value-equal but freshly allocated — proves byte-stability is not an
 *  accident of object identity/reference reuse. Returns a deeply mutable copy
 *  so tests can vary individual fields (Mut<T> — the real types are readonly). */
function cloneModel(m: BoModel): Mut<BoModel> & { nodes: (Mut<BoNode> & { associations: Mut<BoAssociation>[] })[] } {
  return {
    name: m.name,
    type: m.type,
    version: m.version,
    constantsInterfaceRef: m.constantsInterfaceRef,
    nodes: m.nodes.map((n) => ({ ...n, associations: n.associations.map((a) => ({ ...a })) })),
  };
}
function cloneScenario(s: BopfTestScenario): BopfTestScenario {
  return {
    cleanup: s.cleanup,
    nodes: s.nodes.map((n) => ({ node: n.node, parentNode: n.parentNode, fields: { ...n.fields } })),
  };
}

function expectBadInput(fn: () => unknown): AbapError {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) {
      expect(e.code).toBe("BAD_INPUT");
      return e;
    }
    throw e;
  }
  throw new Error("expected fn() to throw a BAD_INPUT AbapError");
}

// ---------------------------------------------------------------------------

describe("bopfBridgeClassName", () => {
  it("is deterministic, Z-prefixed and within the 30-char limit", () => {
    for (const bo of ["ZBOPF_ORDER", "Z_SHORT", "ZBOPF_VERY_LONG_BO_NAME_THAT_OVERFLOWS", "RSUSR002"]) {
      const name = bopfBridgeClassName(bo);
      expect(name).toBe(bopfBridgeClassName(bo));
      expect(name.length).toBeLessThanOrEqual(30);
      expect(name.startsWith("Z")).toBe(true);
      expect(name).toMatch(/^[A-Z0-9_]+$/);
    }
  });

  it("is case-insensitive on the BO name", () => {
    expect(bopfBridgeClassName("zbopf_order")).toBe(bopfBridgeClassName("ZBOPF_ORDER"));
  });

  it("keeps the readable prefix for short names — computed by hand, not guessed", () => {
    // ZCL_ZMCP_BO_ is 12 chars, budget = 30-12 = 18; "ZBOPF_ORDER" is 11 <= 18.
    expect(bopfBridgeClassName("ZBOPF_ORDER")).toBe("ZCL_ZMCP_BO_ZBOPF_ORDER");
  });

  it("stays collision-safe for long names sharing an 11-char prefix", () => {
    const a = bopfBridgeClassName("ZBOPF_VERY_LONG_BO_NAME_AAA");
    const b = bopfBridgeClassName("ZBOPF_VERY_LONG_BO_NAME_BBB");
    expect(a).not.toBe(b);
    expect(a.length).toBe(30);
    expect(b.length).toBe(30);
  });

  it("rejects anything that is not a plain repository name", () => {
    expect(() => bopfBridgeClassName("ZBOPF. DELETE FROM t")).toThrowError(/not a valid ABAP object name/);
    expect(() => bopfBridgeClassName("")).toThrowError(/not a valid ABAP object name/);
  });
});

describe("bopfBridgeSource", () => {
  const cls = bopfBridgeClassName(MODEL.name);
  const src = bopfBridgeSource(MODEL, SCENARIO, cls);

  it("is byte-stable across calls, including with freshly reconstructed value-equal objects", () => {
    expect(bopfBridgeSource(MODEL, SCENARIO, cls)).toBe(src);
    expect(bopfBridgeSource(cloneModel(MODEL), cloneScenario(SCENARIO), cls)).toBe(src);
    expect(bopfBridgeSource(cloneModel(MODEL), cloneScenario(SCENARIO), cls)).toBe(src);
  });

  it("carries the verified service-manager / transaction-manager / modify / save / retrieve shapes", () => {
    expect(src).toContain("INTERFACES if_oo_adt_classrun.");
    expect(src).toContain("/bobf/cl_tra_serv_mgr_factory=>get_service_manager(");
    expect(src).toContain("/bobf/cl_tra_trans_mgr_factory=>get_transaction_manager(");
    expect(src).toContain("/bobf/cl_frw_factory=>get_new_key(");
    expect(src).toContain("lo_sm->modify(");
    expect(src).toContain("lo_tm->save(");
    expect(src).toContain("lo_sm->retrieve(");
    expect(src).toContain("lo_sm->retrieve_by_association(");
    expect(src).toContain(`out->write( '${BOPF_LINE_PREFIX}`);
    expect(src).toContain("CATCH cx_root INTO DATA(lx).");
    expect(src.trimEnd().endsWith("ENDCLASS.")).toBe(true);
  });

  it("names the BO's own constants interface, never a derived guess", () => {
    expect(src).toContain("zif_bopf_order_c=>sc_bo_key");
  });

  it("discloses a missing persistentTableRef via ZMCP-ERR> instead of skipping silently", () => {
    const model = cloneModel(MODEL);
    model.nodes[0]!.persistentTableRef = undefined;
    const s = bopfBridgeSource(model, SCENARIO, cls);
    // The DBCOUNT label is now slot-keyed ("root_0", ROOT's slot-0
    // idLower) rather than name-keyed ("root") — see the node/slot
    // decomposition describe block below for why.
    expect(s).toContain(`${ERR_LINE_PREFIX}DBCOUNT root_0 pending`);
    expect(s).not.toContain("SELECT COUNT(*) FROM zbopf_d_order_root");
  });

  it("appends a cleanup delete+save block only when scenario.cleanup is set", () => {
    const withCleanup = bopfBridgeSource(MODEL, { ...SCENARIO, cleanup: true }, cls);
    expect(withCleanup).toContain("sc_modify_delete");
    expect(withCleanup).toContain("CLEANUP_SAVE");
    expect(src).not.toContain("sc_modify_delete");
  });

  describe("injection defence — assertPlainName guards every identifier reaching generated ABAP", () => {
    it("rejects an invalid model.name", () => {
      expect(() =>
        bopfBridgeSource({ ...cloneModel(MODEL), name: "ZBOPF_ORDER'; DELETE" }, SCENARIO, cls),
      ).toThrowError(/not a valid ABAP object name/);
    });

    it("rejects an invalid node name", () => {
      const model = cloneModel(MODEL);
      model.nodes[0]!.name = "ROOT;";
      const scenario: BopfTestScenario = {
        nodes: [{ node: "ROOT;", fields: { ORDER_ID: "MCP0001" } }],
      };
      expect(() => bopfBridgeSource(model, scenario, cls)).toThrowError(/not a valid ABAP object name/);
    });

    it("rejects an invalid field name", () => {
      const scenario: BopfTestScenario = {
        nodes: [{ node: "ROOT", fields: { "ORDER'ID": "MCP0001" } }],
      };
      expect(() => bopfBridgeSource(MODEL, scenario, cls)).toThrowError(/not a valid ABAP object name/);
    });

    it("rejects an invalid association name", () => {
      const model = cloneModel(MODEL);
      model.nodes[0]!.associations[0]!.name = "ITEMS'";
      expect(() => bopfBridgeSource(model, SCENARIO, cls)).toThrowError(/not a valid ABAP object name/);
    });
  });

  it("rejects a non-string field value instead of coercing it", () => {
    const scenario = {
      nodes: [{ node: "ROOT", fields: { ORDER_ID: 12345 as unknown as string } }],
    } as BopfTestScenario;
    const err = expectBadInput(() => bopfBridgeSource(MODEL, scenario, cls));
    expect(err.message).toMatch(/must be a string/);
  });

  it("escapes a literal quote in a VALUE but rejects one in a NAME", () => {
    const scenario: BopfTestScenario = {
      nodes: [{ node: "ROOT", fields: { ORDER_ID: "O'Brien" } }],
    };
    expect(bopfBridgeSource(MODEL, scenario, cls)).toContain("'O''Brien'");

    const model = cloneModel(MODEL);
    model.nodes[0]!.name = "RO'OT"; // the ROOT node itself, quote and all
    expect(() =>
      bopfBridgeSource(model, { nodes: [{ node: "RO'OT", fields: {} }] }, cls),
    ).toThrowError(/not a valid ABAP object name/);
  });

  it("rejects a scenario whose (parentNode, node) pair has no matching association, naming both nodes", () => {
    const model = cloneModel(MODEL);
    model.nodes[0]!.associations = [];
    const err = expectBadInput(() => bopfBridgeSource(model, SCENARIO, cls));
    expect(err.message).toContain("ROOT");
    expect(err.message).toContain("ITEM");
  });

  // -------------------------------------------------------------------------
  // Round 3 fix: `findAssociation` used to compare a bare target node name
  // against `targetNodeRef.name`, which on the REAL wire carries the
  // target's full `<BO>~<NODE>` object name, not a bare node name (confirmed
  // via test/fixtures/bopf/03-after-put-item-node-and-assoc.v4.xml:
  // adtcore:name="ZBOPF_PRB1~ITEM" for a node literally named "ITEM"). That
  // made every real multi-node composite refuse with a self-contradictory
  // error ("no association ROOT -> ITEM exists" while the same error's own
  // "associations that DO exist" listing named ROOT -> ITEM). `MODEL` above
  // uses an already-bare `targetNodeRef.name` (`ref("BOPF/NODE", "ITEM")`),
  // so it never exercised the bug — these tests use the real prefixed form.
  // -------------------------------------------------------------------------
  describe("targetNodeRef bare-vs-<BO>~<NODE>-prefixed node name handling", () => {
    it("accepts a composite child row when targetNodeRef.name carries the real wire's <BO>~<NODE> prefix, not just a bare name (defect 1, positive)", () => {
      const model = cloneModel(MODEL);
      model.nodes[0]!.associations[0]!.targetNodeRef = ref("BOBF", "ZBOPF_ORDER~ITEM");
      expect(() => bopfBridgeSource(model, SCENARIO, cls)).not.toThrow();
      expect(bopfBridgeSource(model, SCENARIO, cls)).toContain("ITEM");
    });

    it("prefers targetNodeRef.uri's bo:nodes[@bo:name='...'] fragment over a stale/mismatched name", () => {
      const model = cloneModel(MODEL);
      model.nodes[0]!.associations[0]!.targetNodeRef = {
        type: "BOBF",
        name: "ZBOPF_ORDER~SOMETHING_ELSE", // deliberately wrong, to prove uri wins
        uri: "/sap/bc/adt/bopf/businessobjects/zbopf_order#//bo:businessObject/bo:nodes[@bo:name='ITEM']",
      };
      expect(() => bopfBridgeSource(model, SCENARIO, cls)).not.toThrow();
    });

    it("still refuses a genuinely non-existent association even with a real prefixed targetNodeRef present elsewhere, naming the caller-facing (bare) node form (defect 1, negative)", () => {
      const model = cloneModel(MODEL);
      // ROOT's only association is real and well-formed (prefixed, like the
      // wire) but points to OTHER, not ITEM -- simply the wrong one. The fix
      // must not weaken the check into a no-op: this must still refuse.
      model.nodes[0]!.associations = [
        makeAssociation({ name: "OTHER_ASSOC", targetNodeRef: ref("BOBF", "ZBOPF_ORDER~OTHER") }),
      ];
      const err = expectBadInput(() => bopfBridgeSource(model, SCENARIO, cls));
      expect(err.message).toContain('to node "ITEM"');
      expect(err.message).toContain("OTHER_ASSOC -> OTHER");
      // Caller-facing form only -- never the raw internal "ZBOPF_ORDER~OTHER".
      expect(err.message).not.toContain("~");
    });
  });

  it("rejects a scenario whose first node is not the model's root", () => {
    const err1 = expectBadInput(() =>
      bopfBridgeSource(MODEL, { nodes: [{ node: "ITEM", fields: {} }] }, cls),
    );
    expect(err1.message).toContain("ROOT");
    expect(err1.message).toContain("ITEM");

    const model = cloneModel(MODEL);
    model.nodes.forEach((n) => (n.rootNode = false));
    const err2 = expectBadInput(() => bopfBridgeSource(model, SCENARIO, cls));
    expect(err2.message).toMatch(/no node marked rootNode/);
  });

  // -------------------------------------------------------------------------
  // Round 4 fix: every local ABAP identifier the generator emits (lv_key_,
  // ls_, lt_, lt_tk_, lv_nr_, and the retrieve loops' FIELD-SYMBOL) used to be
  // derived from the scenario NODE NAME, not from the scenario ENTRY. Any
  // 2+-node composite therefore already redeclared `FIELD-SYMBOL(<row>)`
  // twice (live-confirmed: "<ROW>" was already declared", ABAP syntax check
  // failure on activation) — and a scenario that legitimately repeats a node
  // name (ROOT + two ITEM rows) redeclared `lt_item`/`ls_item`/`lv_key_item`
  // too. These tests exercise both the two-node case (the live-reported
  // symptom) and the repeated-node-name case (the wider bug class the live
  // symptom was only the first visible instance of).
  // -------------------------------------------------------------------------
  describe("round 4: local-identifier collisions across scenario entries", () => {
    /**
     * Collects every LOCAL identifier the generator declares — `DATA(name)`
     * inline declarations, classic `DATA name TYPE ...` declarations, and
     * `FIELD-SYMBOL(<name>)` — and returns them in declaration order,
     * lowercased, with field symbols kept in their `<...>` form so they can
     * never collide with a same-named `DATA` in this list by construction.
     *
     * Honest about scope: this only recognises the three declaration shapes
     * `bopfBridgeSource` actually emits. It does NOT parse TYPES/CONSTANTS,
     * does not understand ABAP block scoping (irrelevant here — every
     * declaration this generator emits lives in the one flat
     * `if_oo_adt_classrun~main` method body, so "declared twice anywhere in
     * the source" is exactly "declared twice in the same scope", which is
     * exactly what the live syntax-check error was about), and would not
     * catch a collision hidden behind some OTHER declaration shape a future
     * change might introduce. It is a mechanical net over the real live
     * failure mode, not a general ABAP parser.
     */
    function declaredLocalIdentifiers(src: string): string[] {
      const found: string[] = [];
      for (const m of src.matchAll(/\bDATA\(([A-Za-z_][A-Za-z0-9_]*)\)/g)) found.push(m[1]!.toLowerCase());
      for (const m of src.matchAll(/\bDATA\s+([A-Za-z_][A-Za-z0-9_]*)\s+TYPE\b/g))
        found.push(m[1]!.toLowerCase());
      for (const m of src.matchAll(/FIELD-SYMBOL\(<([A-Za-z_][A-Za-z0-9_]*)>\)/g))
        found.push(`<${m[1]!.toLowerCase()}>`);
      return found;
    }

    function assertNoDuplicateDeclarations(src: string): void {
      const counts = new Map<string, number>();
      for (const id of declaredLocalIdentifiers(src)) counts.set(id, (counts.get(id) ?? 0) + 1);
      const dupes = [...counts.entries()].filter(([, n]) => n > 1);
      expect(dupes, `duplicate local declarations found: ${JSON.stringify(dupes)}`).toEqual([]);
    }

    it("a 2-node ROOT+ITEM composite (the live-reported shape) declares every local identifier exactly once", () => {
      const src = bopfBridgeSource(MODEL, SCENARIO, cls);
      assertNoDuplicateDeclarations(src);
      // Sanity: the mechanical check above isn't vacuously passing on empty
      // input — prove it actually saw the FIELD-SYMBOL declarations it's
      // supposed to be distinguishing: one per resolved row's retrieve loop
      // (root's own retrieve + one retrieve_by_association per ITEM row),
      // plus the class's own fixed `emit()` method, which always declares
      // exactly one more (`FIELD-SYMBOL(<m>)`, over the message table —
      // unrelated to any scenario row, present in every generated class).
      const fieldSymbols = [...src.matchAll(/FIELD-SYMBOL\(<[A-Za-z0-9_]+>\)/g)];
      expect(fieldSymbols.length).toBe(3); // root loop + item loop + emit()'s <m>
    });

    it("a 3-entry scenario with a REPEATED node name (ROOT + ITEM + ITEM) declares every local identifier exactly once", () => {
      const scenario: BopfTestScenario = {
        nodes: [
          { node: "ROOT", fields: { ORDER_ID: "MCP0001", SALES_ORG: "MCP" } },
          { node: "ITEM", parentNode: "ROOT", fields: { ITEM_NO: "0010" } },
          { node: "ITEM", parentNode: "ROOT", fields: { ITEM_NO: "0020" } },
        ],
      };
      const src = bopfBridgeSource(MODEL, scenario, cls);
      assertNoDuplicateDeclarations(src);
      // root's retrieve loop + one retrieve_by_association loop per ITEM row
      // (2) + emit()'s own fixed <m> = 4.
      const fieldSymbols = [...src.matchAll(/FIELD-SYMBOL\(<[A-Za-z0-9_]+>\)/g)];
      expect(fieldSymbols.length).toBe(4);
    });

    it("sc_node-/sc_association- references still name the REAL model node, unsuffixed, even with a repeated node name", () => {
      const scenario: BopfTestScenario = {
        nodes: [
          { node: "ROOT", fields: {} },
          { node: "ITEM", parentNode: "ROOT", fields: {} },
          { node: "ITEM", parentNode: "ROOT", fields: {} },
        ],
      };
      const src = bopfBridgeSource(MODEL, scenario, cls);
      // Every sc_node-/sc_association- reference must use the bare, real node
      // name -- never a slot-suffixed synthetic identifier.
      expect(src).toContain(`${CONSTANTS_INTERFACE.toLowerCase()}=>sc_node-root`);
      // Two ITEM rows both reference the SAME real node/association -- both
      // occurrences of sc_node-item and sc_association-root-items appear
      // exactly as the bare name, never "item_1"/"item_2".
      const scNodeItem = [...src.matchAll(/sc_node-item\b/g)];
      expect(scNodeItem.length).toBeGreaterThanOrEqual(2);
      expect(src).not.toMatch(/sc_node-item_\d/);
      expect(src).not.toMatch(/sc_node-root_\d/);
      // Each ITEM row references sc_association-root-items TWICE: once in
      // its modify-append block (BOPF association key for the create), and
      // once in its retrieve_by_association call. Two ITEM rows -> 4 total.
      const scAssoc = [...src.matchAll(/sc_association-root-items\b/g)];
      expect(scAssoc.length).toBe(4);
      expect(src).not.toMatch(/sc_association-root_\d/);
      expect(src).not.toMatch(/sc_association-[a-z]+-items_\d/);
    });

    it("local variables ARE slot-suffixed and therefore distinguishable per row, and the stage labels read as distinct text", () => {
      const scenario: BopfTestScenario = {
        nodes: [
          { node: "ROOT", fields: {} },
          { node: "ITEM", parentNode: "ROOT", fields: {} },
          { node: "ITEM", parentNode: "ROOT", fields: {} },
        ],
      };
      const src = bopfBridgeSource(MODEL, scenario, cls);
      // Local variables for the two ITEM rows are distinguishable by slot.
      expect(src).toContain("DATA(lv_key_item_1)");
      expect(src).toContain("DATA(lv_key_item_2)");
      expect(src).toContain("DATA ls_item_1 TYPE");
      expect(src).toContain("DATA ls_item_2 TYPE");
      // The human-readable stage strings fed to emit(iv_stage = ...) are also
      // distinguishable per row, not two identical, unreadable duplicates.
      expect(src).toContain("emit( iv_stage = 'RBA_ITEM_1'");
      expect(src).toContain("emit( iv_stage = 'RBA_ITEM_2'");
    });

    it("a scenario node whose parentNode name is itself ambiguous attaches to the NEAREST PRECEDING entry with that name", () => {
      // ROOT -> ITEM (ITEMS, already on MODEL) and ITEM -> SUBITEM (SUBS, new).
      const model = cloneModel(MODEL);
      model.nodes.push(
        makeNode({
          name: "SUBITEM",
          rootNode: false,
          persistentStructureRef: ref("DDLS/DF", "ZBOPF_S_ORDER_SUBITEM"),
          persistentTableRef: ref("TABL/DT", "ZBOPF_D_ORDER_SUBITEM"),
        }),
      );
      model.nodes[1]!.associations.push(makeAssociation({ name: "SUBS", targetNodeRef: ref("BOPF/NODE", "SUBITEM") }));

      const scenario: BopfTestScenario = {
        nodes: [
          { node: "ROOT", fields: {} },
          { node: "ITEM", parentNode: "ROOT", fields: {} }, // slot 1
          { node: "ITEM", parentNode: "ROOT", fields: {} }, // slot 2 -- "the ITEM I just added"
          { node: "SUBITEM", parentNode: "ITEM", fields: {} }, // slot 3 -- must attach to slot 2, not slot 1
        ],
      };
      const src = bopfBridgeSource(model, scenario, cls);
      assertNoDuplicateDeclarations(src);
      // The SUBITEM row's MODIFY entry must reference slot 2's local key/data
      // (lv_key_item_2 / ls_item_2), never slot 1's (lv_key_item_1).
      const subitemBlockMatch = /APPEND VALUE #\( node        = zif_bopf_order_c=>sc_node-subitem[\s\S]*?TO lt_mod\./.exec(
        src,
      );
      expect(subitemBlockMatch).not.toBeNull();
      const subitemBlock = subitemBlockMatch![0];
      expect(subitemBlock).toContain("source_key  = lv_key_item_2");
      expect(subitemBlock).not.toContain("lv_key_item_1");
      // The retrieve_by_association for SUBITEM also anchors on slot 2.
      expect(src).toContain("iv_node_key    = zif_bopf_order_c=>sc_node-item");
      expect(src).toContain("it_key         = VALUE #( ( key = lv_key_item_2 ) )");
    });

    it("a node whose parentNode names a node absent from the SCENARIO (even though present in the model) is refused client-side, not silently misresolved", () => {
      // ROOT has no association-carrying scenario row named "GHOST" -- this
      // would previously have produced `lv_key_ghost`, a reference to a
      // variable never declared anywhere (a different, unrelated ABAP compile
      // error at a different line), rather than a clear client-side refusal.
      const model = cloneModel(MODEL);
      const scenario: BopfTestScenario = {
        nodes: [
          { node: "ROOT", fields: {} },
          { node: "ITEM", parentNode: "GHOST", fields: {} },
        ],
      };
      // GHOST isn't even a real node/association source, so this actually
      // fails at the association-lookup stage first -- confirms the ordinary
      // "no such association" path still fires before slot-resolution is
      // ever reached for a bogus parentNode.
      const err = expectBadInput(() => bopfBridgeSource(model, scenario, cls));
      expect(err.message).toContain("GHOST");
    });

    it("a node whose parentNode names a REAL node/association pair that simply never appears earlier in scenario.nodes is refused, distinctly from a bogus parentNode", () => {
      // Model-level lookup (findAssociation) succeeds here -- ITEM really
      // does have a SUBS association to SUBITEM -- but the scenario never
      // actually adds an ITEM row before SUBITEM's. This is the new
      // slot-resolution guard (distinct from the "no such association at
      // all" case above, which fails one step earlier).
      const model = cloneModel(MODEL);
      model.nodes.push(
        makeNode({
          name: "SUBITEM",
          rootNode: false,
          persistentStructureRef: ref("DDLS/DF", "ZBOPF_S_ORDER_SUBITEM"),
          persistentTableRef: ref("TABL/DT", "ZBOPF_D_ORDER_SUBITEM"),
        }),
      );
      model.nodes[1]!.associations.push(makeAssociation({ name: "SUBS", targetNodeRef: ref("BOPF/NODE", "SUBITEM") }));

      const scenario: BopfTestScenario = {
        nodes: [
          { node: "ROOT", fields: {} },
          { node: "SUBITEM", parentNode: "ITEM", fields: {} }, // ITEM never appears as its own row
        ],
      };
      const err = expectBadInput(() => bopfBridgeSource(model, scenario, cls));
      expect(err.message).toContain("ITEM");
      expect(err.message).toMatch(/no earlier/);
    });
  });
});

// ---------------------------------------------------------------------------
// parseBopfTranscript
// ---------------------------------------------------------------------------

describe("parseBopfTranscript", () => {
  it("parses a clean run: messages, a data row, a key, no rejection, nothing dropped", () => {
    const raw =
      `${BOPF_LINE_PREFIX}STEP1 OK service manager obtained\n` +
      `${BOPF_LINE_PREFIX}KEY root=0050560A1B2C3D4E5F60718293A4B5C6\n` +
      `${BOPF_LINE_PREFIX}MSG MODIFY (0 messages)\n` +
      `${BOPF_LINE_PREFIX}STEP2 save() ev_rejected= \n` +
      `${BOPF_LINE_PREFIX}MSG SAVE (0 messages)\n` +
      `${BOPF_LINE_PREFIX}DATA root key=0050560A1B2C3D4E5F60718293A4B5C6 order_id=MCP0001`;

    const result = parseBopfTranscript(raw);

    expect(result.rejected).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(result.droppedLines).toBe(0);
    expect(result.keys).toEqual([{ node: "root", key: "0050560A1B2C3D4E5F60718293A4B5C6" }]);
    expect(result.data).toEqual([
      { node: "root", fields: { key: "0050560A1B2C3D4E5F60718293A4B5C6", order_id: "MCP0001" } },
    ]);
    expect(result.messages).toEqual([{ stage: "MODIFY" }, { stage: "SAVE" }]);
    expect(result.transcript).toContain("STEP1 OK service manager obtained");
  });

  it("parses a rejected run with an error message attached", () => {
    const raw =
      `${BOPF_LINE_PREFIX}MSG SAVE SEV=E Order could not be saved\n` +
      `${BOPF_LINE_PREFIX}STEP2 save() ev_rejected=X\n`;

    const result = parseBopfTranscript(raw);

    expect(result.rejected).toBe(true);
    expect(result.messages).toEqual([
      { stage: "SAVE", severity: "E", text: "Order could not be saved" },
    ]);
  });

  it("`ev_rejected=X` parses as rejected:true even with no other failure signal", () => {
    // No error messages, no diagnostics — the SAVE call itself reported clean
    // messages, yet the framework still rejected the transaction. This is the
    // non-negotiable case: rejected must not be inferred from message severity.
    const raw =
      `${BOPF_LINE_PREFIX}MSG SAVE (0 messages)\n` + `${BOPF_LINE_PREFIX}STEP2 save() ev_rejected=X\n`;
    const result = parseBopfTranscript(raw);
    expect(result.rejected).toBe(true);
    expect(result.messages).toEqual([{ stage: "SAVE" }]);
  });

  it("a later cleanup-save's ev_rejected wins over an earlier create-save", () => {
    const raw =
      `${BOPF_LINE_PREFIX}STEP2 save() ev_rejected=X\n` +
      `${BOPF_LINE_PREFIX}STEP9 cleanup save() ev_rejected= \n`;
    expect(parseBopfTranscript(raw).rejected).toBe(false);

    const raw2 =
      `${BOPF_LINE_PREFIX}STEP2 save() ev_rejected= \n` +
      `${BOPF_LINE_PREFIX}STEP9 cleanup save() ev_rejected=X\n`;
    expect(parseBopfTranscript(raw2).rejected).toBe(true);
  });

  it("carries ZMCP-ERR> diagnostics (prefix retained, matching splitBridgeOutput)", () => {
    const raw =
      `${BOPF_LINE_PREFIX}STEP1 OK service manager obtained\n` +
      `${ERR_LINE_PREFIX}DBCOUNT root pending — no persistentTableRef in the model\n`;
    const result = parseBopfTranscript(raw);
    expect(result.diagnostics).toEqual([
      `${ERR_LINE_PREFIX}DBCOUNT root pending — no persistentTableRef in the model`,
    ]);
    expect(result.transcript).toEqual(["STEP1 OK service manager obtained"]);
  });

  it("counts a stray unprefixed line in droppedLines rather than silently absorbing it", () => {
    const raw =
      `${BOPF_LINE_PREFIX}STEP1 OK service manager obtained\n` +
      `some noise a debugger or the kernel wrote to stdout\n` +
      `${BOPF_LINE_PREFIX}STEP2 OK transaction manager obtained`;
    const result = parseBopfTranscript(raw);
    expect(result.droppedLines).toBe(1);
    expect(result.transcript).toEqual([
      "STEP1 OK service manager obtained",
      "STEP2 OK transaction manager obtained",
    ]);
  });

  it("treats plain narration (matches none of the sub-tags) as transcript-only, not dropped", () => {
    const raw = `${BOPF_LINE_PREFIX}STEP1 OK service manager obtained`;
    const result = parseBopfTranscript(raw);
    expect(result.droppedLines).toBe(0);
    expect(result.messages).toEqual([]);
    expect(result.data).toEqual([]);
    expect(result.keys).toEqual([]);
  });

  it("handles empty input", () => {
    const result = parseBopfTranscript("");
    expect(result).toEqual({
      rejected: false,
      messages: [],
      data: [],
      keys: [],
      diagnostics: [],
      transcript: [],
      // "".split("\n") yields [""] — one line, matching neither prefix, so it
      // counts as dropped. Same algorithm as splitBridgeOutput (src/adt/run.ts);
      // run.test.ts never asserts this edge case, but the behavior is identical.
      droppedLines: 1,
    });
  });

  // ---------------------------------------------------------------------------
  // Node-fix: emitted DATA/KEY tokens are slot-suffixed
  // (`${nameLower}_${slot}`, the fix for an ABAP-identifier collision) but the
  // PARSED `.node` field must carry the bare, real node name — the slot moves
  // to its own `.slot` field instead. See `splitNodeToken`'s doc comment in
  // src/adt/bopf-runtime.ts for why splitting on the LAST `_<digits>` is safe.
  // ---------------------------------------------------------------------------
  describe("node/slot decomposition", () => {
    it("splits a plain slot-0 token into { node, slot }", () => {
      const raw =
        `${BOPF_LINE_PREFIX}KEY root_0=0050560A1B2C3D4E5F60718293A4B5C6\n` +
        `${BOPF_LINE_PREFIX}DATA root_0 key=0050560A1B2C3D4E5F60718293A4B5C6 order_id=MCP0001`;
      const result = parseBopfTranscript(raw);
      expect(result.keys).toEqual([{ node: "root", slot: 0, key: "0050560A1B2C3D4E5F60718293A4B5C6" }]);
      expect(result.data).toEqual([
        {
          node: "root",
          slot: 0,
          fields: { key: "0050560A1B2C3D4E5F60718293A4B5C6", order_id: "MCP0001" },
        },
      ]);
    });

    it("two same-name entries (item_1, item_2) decompose to the SAME node with DIFFERENT slots", () => {
      const raw =
        `${BOPF_LINE_PREFIX}KEY item_1=KEY1\n` +
        `${BOPF_LINE_PREFIX}KEY item_2=KEY2\n` +
        `${BOPF_LINE_PREFIX}DATA item_1 key=KEY1\n` +
        `${BOPF_LINE_PREFIX}DATA item_2 key=KEY2`;
      const result = parseBopfTranscript(raw);
      expect(result.keys).toEqual([
        { node: "item", slot: 1, key: "KEY1" },
        { node: "item", slot: 2, key: "KEY2" },
      ]);
      expect(result.data.map((d) => d.node)).toEqual(["item", "item"]);
      expect(result.data.map((d) => d.slot)).toEqual([1, 2]);
    });

    it("a node name that itself ends in `_<digits>` (item_2) at slot 5 decomposes correctly, not ambiguously", () => {
      // Emitted token is "item_2_5" (nameLower "item_2" + "_" + slot "5").
      // Splitting on the LAST `_<digits>$` must yield node="item_2", slot=5 —
      // not node="item", slot="2_5" (which wouldn't even match \d+) and not
      // node="item_2_5", slot=undefined.
      const raw =
        `${BOPF_LINE_PREFIX}KEY item_2_5=KEYX\n` + `${BOPF_LINE_PREFIX}DATA item_2_5 key=KEYX foo=bar`;
      const result = parseBopfTranscript(raw);
      expect(result.keys).toEqual([{ node: "item_2", slot: 5, key: "KEYX" }]);
      expect(result.data).toEqual([{ node: "item_2", slot: 5, fields: { key: "KEYX", foo: "bar" } }]);
    });

    it("a bare, non-suffixed token (a cached bridge class from before the node-fix) leaves slot undefined and does NOT invent one", () => {
      const raw = `${BOPF_LINE_PREFIX}KEY root=KEYX\n` + `${BOPF_LINE_PREFIX}DATA root key=KEYX order_id=MCP0001`;
      const result = parseBopfTranscript(raw);
      expect(result.keys).toEqual([{ node: "root", key: "KEYX" }]);
      expect(result.keys[0]!.slot).toBeUndefined();
      expect(result.data).toEqual([
        { node: "root", fields: { key: "KEYX", order_id: "MCP0001" } },
      ]);
      expect(result.data[0]!.slot).toBeUndefined();
    });
  });
});

describe("formatNodeLabel", () => {
  it("recomposes the slot-suffixed display label when slot is present", () => {
    expect(formatNodeLabel({ node: "root", slot: 0 })).toBe("root_0");
    expect(formatNodeLabel({ node: "item", slot: 2 })).toBe("item_2");
    expect(formatNodeLabel({ node: "item_2", slot: 5 })).toBe("item_2_5");
  });

  it("falls back to the bare node name when slot is undefined (backward-compat transcript)", () => {
    expect(formatNodeLabel({ node: "root" })).toBe("root");
  });
});

// ---------------------------------------------------------------------------
// runBopfTest orchestration — offline, faked HttpClient
// ---------------------------------------------------------------------------

/**
 * `withStatefulSession` (LOCK) additionally requires the CONNECTION itself to
 * prove the system non-productive (connection.ts `applyReadOnlyPolicy`)
 * — a check the `SafetyGate` passed to `runBopfTest` cannot substitute for.
 * That proof comes from a live-captured T000 data-preview response, exactly
 * like test/write.test.ts's `T000_NONPRODUCTIVE` — reused here via the same
 * on-disk fixture rather than re-captured, since it is the identical wire
 * contract (`classifyT000Response`) this suite also depends on. Both it and
 * `DATAPREVIEW_XML` are imported from ./helpers/system-role-fake.js.
 */

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    // Non-productive proof is attributed to THIS client (client 001 reads "C"
    // in the captured T000 fixture — see write.test.ts's identical comment).
    client: "001",
    readOnly: false,
  });

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
  statusText = String(status),
): HttpClientResponse => ({ status, statusText, body, headers }) as unknown as HttpClientResponse;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

const SESSION_URL = "/sap/bc/adt/compatibility/graph";

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

/**
 * Full write → activate → (maybe) classrun happy path for a bridge class that
 * does not exist yet on the fake server (the normal first-run case): GET 404
 * → POST create → LOCK → PUT source → UNLOCK → activate (clean) → optionally
 * classrun. Shaped after test/write.test.ts's "creates a missing object
 * first" fixture and test/activate.test.ts's clean-activation response
 * (`resp(200, "", { "content-length": "0" })`).
 */
function bridgeHappyPath(
  className: string,
  classrun: (o: HttpClientOptions) => HttpClientResponse,
): (o: HttpClientOptions) => HttpClientResponse {
  const classUri = `/sap/bc/adt/oo/classes/${className.toLowerCase()}`;
  const sourceUri = `${classUri}/source/main`;
  return (o: HttpClientOptions) => {
    const qs = (o.qs ?? {}) as Record<string, string>;
    const method = (o.method ?? "GET").toUpperCase();

    if (o.url.startsWith("/sap/bc/adt/oo/classrun/")) return classrun(o);
    if (o.url.includes(SESSION_URL)) {
      return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
    }
    if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
    if (o.url.includes("/ato/settings")) {
      return resp(200, "<settings/>", { "content-type": "application/xml" });
    }
    if (o.url === classUri && method === "GET" && !qs._action) {
      const r = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
      throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
    }
    if (o.url === "/sap/bc/adt/oo/classes" && method === "POST") return resp(200, "", {});
    if (qs._action === "LOCK") return resp(200, LOCK_XML(), { "content-type": "application/xml" });
    if (qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (o.url === sourceUri && method === "PUT") return resp(200, "", { "content-type": "text/plain" });
    if (o.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return resp(200, "<ok/>", { "content-type": "application/xml" });
  };
}

async function connected(
  route: (o: HttpClientOptions) => HttpClientResponse,
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(route);
  const conn = new AbapConnection(cfg(), {
    httpClient: inner,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner };
}

const allowingGate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], writesLockedOut: false });

describe("runBopfTest", () => {
  it("generateOnly:true writes and activates the bridge but never calls runClass / hits classrun", async () => {
    const className = bopfBridgeClassName(MODEL.name);
    let classrunHit = false;
    const { conn, inner } = await connected(
      bridgeHappyPath(className, () => {
        classrunHit = true;
        return resp(200, "should never be reached", { "content-type": "text/plain" });
      }),
    );

    const result = await runBopfTest(conn, MODEL, SCENARIO, allowingGate(), { generateOnly: true });

    expect(classrunHit).toBe(false);
    expect(inner.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(false);
    expect(result.generateOnly).toBe(true);
    expect(result.bridgeClass).toBe(className);
    expect(result.bridgeRefreshed).toBe(true);
    expect(result.constantsInterface).toBe(CONSTANTS_INTERFACE);
    expect(result.rejected).toBeUndefined();
    expect(result.transcript).toBeUndefined();

    // …and the bridge really was written and activated (that is the whole
    // point of generateOnly: leave a class ready to trigger via abap_debug).
    expect(inner.calls.some((c) => (c.method ?? "").toUpperCase() === "PUT")).toBe(true);
    expect(inner.calls.some((c) => c.url.includes("/sap/bc/adt/activation"))).toBe(true);
  });

  it("a normal run writes, activates, executes and returns a populated BopfTestResult with transcript present", async () => {
    const className = bopfBridgeClassName(MODEL.name);
    const TRANSCRIPT_BODY =
      `${BOPF_LINE_PREFIX}STEP1 OK service manager obtained\n` +
      `${BOPF_LINE_PREFIX}STEP2 OK transaction manager obtained\n` +
      `${BOPF_LINE_PREFIX}KEY root=0050560000001EEDB4C1B4A8E7D8E1D1\n` +
      `${BOPF_LINE_PREFIX}KEY item=0050560000001EEDB4C1B4A8E7D8E1D2\n` +
      `${BOPF_LINE_PREFIX}STEP3 modify() returned without exception\n` +
      `${BOPF_LINE_PREFIX}MSG MODIFY (0 messages)\n` +
      `${BOPF_LINE_PREFIX}STEP4 save() ev_rejected= \n` +
      `${BOPF_LINE_PREFIX}MSG SAVE (0 messages)\n` +
      `${BOPF_LINE_PREFIX}STEP5 retrieve(root) rows=1\n` +
      `${BOPF_LINE_PREFIX}MSG RETRIEVE_ROOT (0 messages)\n` +
      `${BOPF_LINE_PREFIX}DATA root key=0050560000001EEDB4C1B4A8E7D8E1D1 order_id=MCP0001 sales_org=MCP\n` +
      `${BOPF_LINE_PREFIX}STEP6 DBCOUNT root ZBOPF_D_ORDER_ROOT=1\n`;

    const { conn, inner } = await connected(
      bridgeHappyPath(className, () => resp(200, TRANSCRIPT_BODY, { "content-type": "text/plain" })),
    );

    const result = await runBopfTest(conn, MODEL, SCENARIO, allowingGate());

    expect(result.generateOnly).toBe(false);
    expect(result.bridgeClass).toBe(className);
    expect(result.rejected).toBe(false);
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(0);
    expect(result.rowsWritten).toBe(2);
    expect(result.transcript).toBeDefined();
    expect(result.transcript?.keys).toHaveLength(2);
    expect(result.transcript?.data.some((d) => d.node === "root" && d.fields.order_id === "MCP0001")).toBe(
      true,
    );
    expect(typeof result.durationMs).toBe("number");
    expect(inner.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
  });
});

/**
 * ARCH-09 §5.6 / P9 — `deployBridge` is shared by every bridge caller
 * (`runBopfTest` included), so the fix belongs here rather than in any one
 * caller. When activation fails AFTER `writeObject` has already landed the
 * class, the thrown error must name the leftover; when the gate refuses
 * BEFORE any write, nothing was left behind and the error must say so by
 * saying nothing extra at all.
 */
describe("deployBridge bridge residue disclosure (ARCH-09 §5.6, P9)", () => {
  const RESIDUE_CLASS = "ZCL_ZMCP_RESIDUE_TEST";

  /** VERBATIM shape (activate.test.ts) — HTTP 200 + a `chkl:messages` error body. */
  const activationErrors = (className: string) => {
    const sourceUri = `/sap/bc/adt/oo/classes/${className.toLowerCase()}/source/main`;
    return (
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">` +
      `<msg objDescr="Class ${className}" type="E" line="1" ` +
      `href="${sourceUri}#start=1,0" forceSupported="true">` +
      `<shortText><txt>Syntax error in generated bridge class.</txt></shortText>` +
      `</msg></chkl:messages>`
    );
  };

  /**
   * Same choreography as `bridgeHappyPath` above but with the activation
   * response parameterised — the residue fix only matters when activation
   * FAILS after the write succeeded, which `bridgeHappyPath` never exercises
   * (its activation is hard-coded to the clean-success response).
   */
  function bridgeRouteWithActivation(
    className: string,
    activation: (o: HttpClientOptions) => HttpClientResponse,
  ): (o: HttpClientOptions) => HttpClientResponse {
    const classUri = `/sap/bc/adt/oo/classes/${className.toLowerCase()}`;
    const sourceUri = `${classUri}/source/main`;
    return (o: HttpClientOptions) => {
      const qs = (o.qs ?? {}) as Record<string, string>;
      const method = (o.method ?? "GET").toUpperCase();

      if (o.url.startsWith(SESSION_URL) || o.url.includes(SESSION_URL)) {
        return resp(200, "<graph/>", {
          "content-type": "application/xml",
          "x-csrf-token": "TOKEN123",
        });
      }
      if (o.url.includes("/datapreview/freestyle")) {
        return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
      }
      if (o.url.includes("/ato/settings")) {
        return resp(200, "<settings/>", { "content-type": "application/xml" });
      }
      if (o.url === classUri && method === "GET" && !qs._action) {
        const r = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
        throw new HttpClientException(
          "Request failed with status code 404",
          "404",
          404,
          undefined,
          o,
          r,
        );
      }
      if (o.url === "/sap/bc/adt/oo/classes" && method === "POST") return resp(200, "", {});
      if (qs._action === "LOCK") return resp(200, LOCK_XML(), { "content-type": "application/xml" });
      if (qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
      if (o.url === sourceUri && method === "PUT") return resp(200, "", { "content-type": "text/plain" });
      if (o.url.includes("/sap/bc/adt/activation")) return activation(o);
      return resp(200, "<ok/>", { "content-type": "application/xml" });
    };
  }

  it("names the leftover class and its real package when activation fails after the write lands", async () => {
    const { conn, inner } = await connected(
      bridgeRouteWithActivation(RESIDUE_CLASS, () =>
        resp(200, activationErrors(RESIDUE_CLASS), { "content-type": "application/xml" }),
      ),
    );

    // A non-default package, allowlisted here instead of $TMP, proves the hint
    // names the package `authorized.target` actually resolved rather than a
    // hard-coded "$TMP" — deployBridge is shared by callers that pass their own.
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_BRIDGES"],
      writesLockedOut: false,
    });

    const err = await deployBridge(conn, gate, {
      className: RESIDUE_CLASS,
      source: "CLASS zcl_zmcp_residue_test DEFINITION.\nENDCLASS.",
      description: "MCP residue disclosure test bridge",
      packageName: "ZFOO_BRIDGES",
      what: "Bridge activation",
      verify: () => true,
    }).catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    const e = err as AbapError;

    // The original error is preserved exactly — callers and tests branch on `code`.
    expect(e.code).toBe("CHECK_FAILED");
    expect(e.message).toBe(`Bridge activation of ${RESIDUE_CLASS} failed: 1 error.`);

    // The write actually happened (PUT reached the wire), so the residue claim is real.
    expect(inner.calls.some((c) => c.url.endsWith("/source/main") && c.method === "PUT")).toBe(true);

    expect(e.details.bridgeClass).toBe(RESIDUE_CLASS);
    expect(e.details.bridgeLeftBehind).toBe(true);
    expect(e.hint).toContain(RESIDUE_CLASS);
    expect(e.hint).toContain("ZFOO_BRIDGES");
    expect(e.hint).not.toContain("$TMP");
    expect(e.hint).toMatch(/failed to activate/);
    expect(e.hint).toMatch(/inactive/);
    expect(e.hint).toMatch(/safe to delete/);
  });

  it("leaves the error completely unchanged when the gate refuses before any write", async () => {
    const denyingGate = (): SafetyGate =>
      new SafetyGate({ readOnly: false, allowPackages: ["ZFOO_*"], writesLockedOut: false }); // deliberately NOT $TMP

    const { conn, inner } = await connected(
      bridgeRouteWithActivation(RESIDUE_CLASS, () => resp(200, "", { "content-length": "0" })),
    );

    const err = await deployBridge(conn, denyingGate(), {
      className: RESIDUE_CLASS,
      source: "CLASS zcl_zmcp_residue_test DEFINITION.\nENDCLASS.",
      description: "MCP residue disclosure test bridge",
      what: "Bridge activation",
      verify: () => true,
    }).catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    const e = err as AbapError;

    expect(e.code).toBe("SAFETY_DENIED");
    expect(e.details.bridgeClass).toBeUndefined();
    expect(e.details.bridgeLeftBehind).toBeUndefined();

    // Nothing was written — no phantom residue to disclose, and none is claimed.
    const mutations = inner.calls.filter(
      (c) => c.method === "PUT" || c.method === "POST" || String(c.url).includes("_action=LOCK"),
    );
    expect(mutations).toEqual([]);
  });
});

/**
 * The warm bridge path (class already exists, byte-identical source):
 * `writeObject`'s compare-before-write already skips LOCK/PUT/UNLOCK, so
 * before this fix the ONLY thing standing between "nothing changed" and
 * "still costs a round trip" was the unconditional activation POST. These
 * pin the exact wire-call count on both sides of that fix, per class GET
 * body shape, so a future change can't silently widen "active" back into a
 * guess. Fixture 062 (`062-class-get-check.xml`) is the real captured shape
 * used for the "mixed" case: root + `main` include `inactive`, the other
 * three includes `active`.
 */
describe("deployBridge / executeBridge warm-path round trips", () => {
  const WARM_CLASS = "ZCL_ZMCP_WARM_TEST";
  const WARM_SOURCE = "CLASS zcl_zmcp_warm_test DEFINITION.\nENDCLASS.\nCLASS zcl_zmcp_warm_test IMPLEMENTATION.\nENDCLASS.";

  /**
   * A `class:abapClass` document shaped like `062-class-get-check.xml`:
   * root version + one `adtcore:version` per include (definitions,
   * implementations, macros, main). `mainVersion` defaults to `rootVersion`
   * (the all-agree case); fixture 062 itself is reproduced by passing both
   * explicitly as `"inactive"` while the other three includes stay `"active"`.
   */
  function classDocXml(
    className: string,
    opts: { rootVersion?: string; mainVersion?: string; omitVersions?: boolean } = {},
  ): string {
    const root = opts.rootVersion ?? "active";
    const main = opts.mainVersion ?? root;
    const ver = (v: string) => (opts.omitVersions ? "" : ` adtcore:version="${v}"`);
    const inc = (type: string, version: string) =>
      `<class:include class:includeType="${type}" ` +
      `abapsource:sourceUri="${type === "main" ? "source/main" : `includes/${type}`}" ` +
      `adtcore:name="" adtcore:type="CLAS/I"${ver(version)}/>`;
    return (
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<class:abapClass adtcore:name="${className}" adtcore:type="CLAS/OC"${ver(root)} ` +
      `xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core" ` +
      `xmlns:abapsource="http://www.sap.com/adt/abapsource">` +
      `<adtcore:packageRef adtcore:name="$TMP"/>` +
      inc("definitions", "active") +
      inc("implementations", "active") +
      inc("macros", "active") +
      inc("main", main) +
      `</class:abapClass>`
    );
  }

  /**
   * Warm route: the class GET returns 200 (not 404) with `classDoc`, and
   * `GET source/main` returns `serverSource` — byte-identical to `WARM_SOURCE`
   * by default, so `writeObject` takes its no-op short-circuit and LOCK/PUT/
   * UNLOCK never hit the wire. LOCK/PUT/UNLOCK routes are still wired for the
   * "changed source" case, which walks the same choreography as
   * `bridgeHappyPath` from that point on.
   */
  function bridgeRouteWarm(
    className: string,
    classDoc: string,
    serverSource: string,
    classrun: (o: HttpClientOptions) => HttpClientResponse,
  ): (o: HttpClientOptions) => HttpClientResponse {
    const classUri = `/sap/bc/adt/oo/classes/${className.toLowerCase()}`;
    const sourceUri = `${classUri}/source/main`;
    return (o: HttpClientOptions) => {
      const qs = (o.qs ?? {}) as Record<string, string>;
      const method = (o.method ?? "GET").toUpperCase();

      if (o.url.startsWith("/sap/bc/adt/oo/classrun/")) return classrun(o);
      if (o.url.includes(SESSION_URL)) {
        return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
      }
      if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
      if (o.url.includes("/ato/settings")) {
        return resp(200, "<settings/>", { "content-type": "application/xml" });
      }
      if (o.url === classUri && method === "GET" && !qs._action) {
        return resp(200, classDoc, { "content-type": "application/xml" });
      }
      if (o.url === sourceUri && method === "GET") {
        return resp(200, serverSource, { "content-type": "text/plain" });
      }
      if (qs._action === "LOCK") return resp(200, LOCK_XML(), { "content-type": "application/xml" });
      if (qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
      if (o.url === sourceUri && method === "PUT") return resp(200, "", { "content-type": "text/plain" });
      if (o.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
      return resp(200, "<ok/>", { "content-type": "application/xml" });
    };
  }

  const cleanClassrun = () => resp(200, "warm run ok", { "content-type": "text/plain" });

  async function deployAndRun(route: (o: HttpClientOptions) => HttpClientResponse, source = WARM_SOURCE) {
    const { conn, inner } = await connected(route);
    const gate = allowingGate();
    const deployed = await deployBridge(conn, gate, {
      className: WARM_CLASS,
      source,
      description: "MCP warm-path round-trip test bridge",
      what: "Bridge activation",
      verify: () => true,
    });
    await executeBridge(conn, gate, deployed);
    return { deployed, inner };
  }

  it("all adtcore:version attributes active: write unchanged, activation POST absent (5 -> 4 round trips)", async () => {
    const classDoc = classDocXml(WARM_CLASS); // root + every include "active"
    const { deployed, inner } = await deployAndRun(
      bridgeRouteWarm(WARM_CLASS, classDoc, WARM_SOURCE, cleanClassrun),
    );

    expect(deployed.write.created).toBe(false);
    expect(deployed.write.changed).toBe(false);
    expect(deployed.activationSource).toBe("already-active");
    expect(deployed.activation).toBeUndefined();
    expect(deployed.bridgeRefreshed).toBe(false);

    expect(inner.calls.some((c) => (c.method ?? "").toUpperCase() === "PUT")).toBe(false);
    expect(inner.calls.some((c) => c.url.includes("/sap/bc/adt/activation"))).toBe(false);

    // GET class + GET source/main + dropSession + classrun POST. No LOCK/PUT/
    // UNLOCK/activation — this is the round trip this issue removes one from.
    expect(inner.calls).toHaveLength(4);
  });

  it("fixture 062's real shape (root + main inactive, rest active): activation POST still fires", async () => {
    const classDoc = classDocXml(WARM_CLASS, { rootVersion: "inactive", mainVersion: "inactive" });
    const { deployed, inner } = await deployAndRun(
      bridgeRouteWarm(WARM_CLASS, classDoc, WARM_SOURCE, cleanClassrun),
    );

    expect(deployed.write.created).toBe(false);
    expect(deployed.write.changed).toBe(false);
    expect(deployed.activationSource).toBe("post");
    expect(deployed.activation).toBeDefined();

    expect(inner.calls.some((c) => (c.method ?? "").toUpperCase() === "PUT")).toBe(false);
    expect(inner.calls.some((c) => c.url.includes("/sap/bc/adt/activation"))).toBe(true);

    // GET class + GET source/main + activation POST + dropSession + classrun.
    expect(inner.calls).toHaveLength(5);
  });

  it("adtcore:version absent from the class GET body: never guesses active, activation POST still fires", async () => {
    const classDoc = classDocXml(WARM_CLASS, { omitVersions: true });
    const { deployed, inner } = await deployAndRun(
      bridgeRouteWarm(WARM_CLASS, classDoc, WARM_SOURCE, cleanClassrun),
    );

    expect(deployed.write.created).toBe(false);
    expect(deployed.write.changed).toBe(false);
    expect(deployed.target.activation).toBe("unknown");
    expect(deployed.activationSource).toBe("post");
    expect(deployed.activation).toBeDefined();

    expect(inner.calls.some((c) => c.url.includes("/sap/bc/adt/activation"))).toBe(true);
    expect(inner.calls).toHaveLength(5);
  });

  it("changed source, all versions active: write still happens, activation POST still fires", async () => {
    const classDoc = classDocXml(WARM_CLASS); // all active
    const STALE_SOURCE = "CLASS zcl_zmcp_warm_test DEFINITION.\nENDCLASS.\nCLASS zcl_zmcp_warm_test IMPLEMENTATION.\n* stale\nENDCLASS.";
    const { deployed, inner } = await deployAndRun(
      bridgeRouteWarm(WARM_CLASS, classDoc, STALE_SOURCE, cleanClassrun),
      WARM_SOURCE,
    );

    expect(deployed.write.created).toBe(false);
    expect(deployed.write.changed).toBe(true);
    expect(deployed.activationSource).toBe("post");
    expect(deployed.activation).toBeDefined();

    expect(inner.calls.some((c) => (c.method ?? "").toUpperCase() === "PUT")).toBe(true);
    expect(inner.calls.some((c) => c.url.includes("/sap/bc/adt/activation"))).toBe(true);

    // GET class + GET source/main (compare) + LOCK + GET source/main again
    // (writeObject's post-lock recheck, step 4a — the bytes could have moved
    // in the window between the compare-read and the enqueue) + PUT +
    // UNLOCK + activation + dropSession + classrun.
    expect(inner.calls).toHaveLength(9);
  });

  it("cold/create path round-trip count is unchanged by the warm-path fast path (still 5, not 4)", async () => {
    const { conn, inner } = await connected(bridgeHappyPath(WARM_CLASS, cleanClassrun));
    const gate = allowingGate();
    const deployed = await deployBridge(conn, gate, {
      className: WARM_CLASS,
      source: WARM_SOURCE,
      description: "MCP warm-path round-trip test bridge (cold create)",
      what: "Bridge activation",
      verify: () => true,
    });
    await executeBridge(conn, gate, deployed);

    expect(deployed.write.created).toBe(true);
    expect(deployed.activationSource).toBe("post");

    // GET class (404) + POST create + LOCK + PUT + UNLOCK + activation +
    // dropSession + classrun — the warm-path fast path never applies to a create.
    expect(inner.calls).toHaveLength(8);
  });
});
