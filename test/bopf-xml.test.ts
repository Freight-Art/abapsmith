/**
 * `src/adt/bopf-xml.ts` — the byte-splice engine for BOPF whole-model XML.
 *
 * The binding acceptance criterion: for all
 * five captured model fixtures, (a) `splice(xml, p, "")` must be byte-identical
 * to the original `xml` for every valid insertion point `p`, and (b)
 * insert-then-remove of a rendered element must return byte-identical output
 * to before the insert. Both are tested directly against real captured bytes
 * below — nothing here is a synthetic string.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isAbapError } from "../src/adt/errors.js";
import {
  ACTION_CHILD_ORDER,
  QUERY_CHILD_ORDER,
} from "../src/adt/bopf-types.js";
import {
  insertionPoint,
  locate,
  locateToken,
  mintGuid,
  parseModel,
  patchOpenTagAttrs,
  renderAlternativeKeyElement,
  renderAssociationElement,
  renderDeterminationElement,
  renderDeterminationTrigger,
  renderElement,
  renderProperty,
  renderQueryElement,
  renderRef,
  renderRelation,
  renderValidationElement,
  renderValidationTrigger,
  scanModel,
  splice,
  spliceOut,
  spliceSetElementRef,
} from "../src/adt/bopf-xml.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const read = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/** The five model documents the acceptance criterion binds on. */
const MODEL_FIXTURES: ReadonlyArray<readonly [string, string]> = [
  ["01", "01-get-demo_sales_order.v4.xml"],
  ["02", "02-created-zbopf_prb1-root-only.v4.xml"],
  ["03", "03-after-put-item-node-and-assoc.v4.xml"],
  ["04", "04-active-after-structures.v4.xml"],
  ["10", "10-model-coverage-final.v4.xml"],
];

const ALL_CHILD_KINDS = [
  "association",
  "action",
  "determination",
  "validation",
  "query",
  "alternativeKey",
] as const;

function expectBadInput(fn: () => unknown): void {
  let threw: unknown;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeDefined();
  expect(isAbapError(threw)).toBe(true);
  if (isAbapError(threw)) expect(threw.code).toBe("BAD_INPUT");
}

describe("scanModel: accepts every real capture", () => {
  for (const [label, file] of MODEL_FIXTURES) {
    it(`tokenizes fixture ${label} without throwing`, () => {
      const xml = read(file);
      const tokens = scanModel(xml);
      expect(tokens.length).toBeGreaterThan(0);
      // Exactly one root.
      expect(tokens.filter((t) => t.depth === 0).length).toBe(1);
    });
  }

  it("also tokenizes the two request-payload fixtures (05, 06)", () => {
    expect(() => scanModel(read("05-request-create-payload.v4.xml"))).not.toThrow();
    expect(() => scanModel(read("06-request-put-payload.v4.xml"))).not.toThrow();
  });

  it("every token's byte range is internally consistent and in-bounds", () => {
    const xml = read("10-model-coverage-final.v4.xml");
    const tokens = scanModel(xml);
    for (const t of tokens) {
      expect(t.openStart).toBeGreaterThanOrEqual(0);
      expect(t.openEnd).toBeGreaterThanOrEqual(t.openStart);
      expect(t.closeEnd).toBeGreaterThanOrEqual(t.openEnd);
      expect(t.closeEnd).toBeLessThanOrEqual(xml.length);
      if (t.kind === "empty") expect(t.closeEnd).toBe(t.openEnd);
      // The tag text must actually start with '<' + the token's name.
      expect(xml.slice(t.openStart, t.openStart + 1)).toBe("<");
      expect(xml.startsWith(t.name, t.openStart + 1)).toBe(true);
    }
  });
});

describe("scanModel: refuses rather than guesses (BAD_INPUT)", () => {
  const validPrefix = '<?xml version="1.0" encoding="utf-8"?><bo:businessObject xmlns:bo="x" xmlns:adtcore="y">';

  it("rejects a document with no XML declaration", () => {
    expectBadInput(() => scanModel('<bo:businessObject xmlns:bo="x"/>'));
  });

  it("rejects an unterminated XML declaration", () => {
    expectBadInput(() => scanModel('<?xml version="1.0"'));
  });

  it("rejects a comment", () => {
    expectBadInput(() => scanModel(`${validPrefix}<!-- hi --></bo:businessObject>`));
  });

  it("rejects a CDATA section", () => {
    expectBadInput(() => scanModel(`${validPrefix}<![CDATA[x]]></bo:businessObject>`));
  });

  it("rejects a DOCTYPE", () => {
    expectBadInput(() => scanModel('<?xml version="1.0"?><!DOCTYPE foo><bo:businessObject/>'));
  });

  it("rejects a second processing instruction", () => {
    expectBadInput(() => scanModel(`${validPrefix}<?pi target?></bo:businessObject>`));
  });

  it("rejects a non-predefined entity reference", () => {
    expectBadInput(() => scanModel(`<?xml version="1.0"?><bo:businessObject bo:x="&custom;"/>`));
  });

  it("accepts the five predefined entities in an attribute value", () => {
    const xml = `<?xml version="1.0"?><bo:businessObject bo:x="&amp;&lt;&gt;&apos;&quot;"/>`;
    const tokens = scanModel(xml);
    expect(tokens[0]?.attrs.get("bo:x")).toBe(`&<>'"`);
  });

  it("rejects mismatched open/close tags", () => {
    expectBadInput(() => scanModel(`${validPrefix}<bo:nodes></bo:wrong></bo:businessObject>`));
  });

  it("rejects an unclosed element", () => {
    expectBadInput(() => scanModel(`${validPrefix}<bo:nodes bo:name="X">`));
  });

  it("rejects text content between elements", () => {
    expectBadInput(() => scanModel(`${validPrefix}some text</bo:businessObject>`));
  });

  it("rejects more than one root element", () => {
    expectBadInput(() =>
      scanModel('<?xml version="1.0"?><a/><b/>'),
    );
  });

  it("rejects a raw '<' inside an attribute value", () => {
    expectBadInput(() => scanModel(`<?xml version="1.0"?><bo:businessObject bo:x="a<b"/>`));
  });

  it("accepts single-quoted attribute values", () => {
    const xml = `<?xml version="1.0"?><bo:businessObject bo:x='value'/>`;
    const tokens = scanModel(xml);
    expect(tokens[0]?.attrs.get("bo:x")).toBe("value");
  });
});

describe("acceptance criterion (a): splice(xml, p, \"\") is byte-identical for every valid insertion point", () => {
  for (const [label, file] of MODEL_FIXTURES) {
    it(`holds for fixture ${label} across every node × every child kind`, () => {
      const xml = read(file);
      const tokens = scanModel(xml);
      const nodeTokens = tokens.filter((t) => t.name === "bo:nodes");
      expect(nodeTokens.length).toBeGreaterThan(0);

      let checked = 0;
      for (const nodeTok of nodeTokens) {
        if (nodeTok.kind !== "container") continue; // self-closing nodes have no interior insertion point in this fixture
        for (const kind of ALL_CHILD_KINDS) {
          const p = insertionPoint(tokens, nodeTok, kind);
          expect(p).toBeGreaterThanOrEqual(nodeTok.openEnd);
          expect(p).toBeLessThanOrEqual(nodeTok.closeEnd);
          expect(splice(xml, p, "")).toBe(xml);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
    });
  }
});

/** Build one minimal, self-consistent rendered fragment per child kind, with a distinctive marker name. */
function renderMarker(kind: (typeof ALL_CHILD_KINDS)[number], marker: string): string {
  switch (kind) {
    case "association":
      return renderAssociationElement({ name: marker, nodeId: mintGuid("association") });
    case "action":
      return renderElement("action", { name: marker, nodeID: mintGuid("action") });
    case "determination":
      return renderDeterminationElement({
        name: marker,
        nodeId: mintGuid("determination"),
        triggers: [renderDeterminationTrigger({ node: "ROOT", create: true })],
      });
    case "validation":
      return renderValidationElement({
        name: marker,
        nodeId: mintGuid("validation"),
        triggers: [renderValidationTrigger({ node: "ROOT", check: true })],
      });
    case "query":
      return renderQueryElement({ name: marker, nodeId: mintGuid("query") });
    case "alternativeKey":
      return renderAlternativeKeyElement({ name: marker, nodeId: mintGuid("alternativeKey") });
  }
}

describe("acceptance criterion (b): insert-then-remove round-trips to byte-identical output", () => {
  for (const [label, file] of MODEL_FIXTURES) {
    it(`holds for fixture ${label} for one marker element of every child kind, on the first open node`, () => {
      const original = read(file);
      const tokens = scanModel(original);
      const nodeTok = tokens.find((t) => t.name === "bo:nodes" && t.kind === "container");
      expect(nodeTok, `fixture ${label} has no container-form bo:nodes to test against`).toBeDefined();
      if (!nodeTok) return;

      for (const kind of ALL_CHILD_KINDS) {
        const marker = `ZZ_T1_MARKER_${kind.toUpperCase()}`;
        const fragment = renderMarker(kind, marker);
        const at = insertionPoint(tokens, nodeTok, kind);
        const inserted = splice(original, at, fragment);

        // Re-scan the mutated document and locate the marker precisely.
        const tokens2 = scanModel(inserted);
        const range = locate(tokens2, {
          node: nodeTok.attrs.get("bo:name") ?? "",
          nodeId: nodeTok.attrs.get("bo:nodeID"),
          child: kind,
          name: marker,
        });
        expect(range, `could not locate the ${kind} marker just inserted in fixture ${label}`).toBeDefined();
        if (!range) continue;
        expect(inserted.slice(range.start, range.end)).toBe(fragment);

        const removed = spliceOut(inserted, range);
        expect(removed).toBe(original);
      }
    });
  }
});

describe("locate", () => {
  it("finds a known node by name in fixture 01 and returns its exact element text", () => {
    const xml = read("01-get-demo_sales_order.v4.xml");
    const tokens = scanModel(xml);
    const range = locate(tokens, { node: "ROOT" });
    expect(range).toBeDefined();
    if (!range) return;
    const text = xml.slice(range.start, range.end);
    expect(text.startsWith("<bo:nodes")).toBe(true);
    expect(text.includes('bo:name="ROOT"')).toBe(true);
  });

  it("returns undefined for a node that does not exist", () => {
    const xml = read("01-get-demo_sales_order.v4.xml");
    const tokens = scanModel(xml);
    expect(locate(tokens, { node: "NO_SUCH_NODE_XYZ" })).toBeUndefined();
  });

  it("returns undefined for a child selector under a node that does not exist", () => {
    const xml = read("01-get-demo_sales_order.v4.xml");
    const tokens = scanModel(xml);
    expect(
      locate(tokens, { node: "NO_SUCH_NODE_XYZ", child: "association", name: "X" }),
    ).toBeUndefined();
  });
});

describe("locateToken: token-level counterpart of locate", () => {
  it("for a node selector, returns the exact Token locate derives its range from", () => {
    const xml = read("01-get-demo_sales_order.v4.xml");
    const tokens = scanModel(xml);
    const tok = locateToken(tokens, { node: "ROOT" });
    const range = locate(tokens, { node: "ROOT" });
    expect(tok).toBeDefined();
    expect(range).toBeDefined();
    if (!tok || !range) return;
    expect(tok.name).toBe("bo:nodes");
    expect(tok.openStart).toBe(range.start);
    expect(tok.closeEnd).toBe(range.end);
  });

  it("for a child selector, returns the child's own Token (attrs, kind, depth included)", () => {
    const xml = read("10-model-coverage-final.v4.xml");
    const tokens = scanModel(xml);
    const tok = locateToken(tokens, { node: "ROOT", child: "action", name: "LOCK_ROOT" });
    expect(tok).toBeDefined();
    if (!tok) return;
    expect(tok.name).toBe("bo:actions");
    expect(tok.kind).toBe("container");
    expect(tok.attrs.get("bo:name")).toBe("LOCK_ROOT");
  });

  it("returns undefined exactly where locate would (missing node, missing child)", () => {
    const xml = read("01-get-demo_sales_order.v4.xml");
    const tokens = scanModel(xml);
    expect(locateToken(tokens, { node: "NO_SUCH_NODE_XYZ" })).toBeUndefined();
    expect(locateToken(tokens, { node: "NO_SUCH_NODE_XYZ", child: "association", name: "X" })).toBeUndefined();
  });
});

describe("patchOpenTagAttrs: open-tag attribute patcher", () => {
  const xml = read("10-model-coverage-final.v4.xml");
  const tokens = scanModel(xml);

  /** Only bytes in [token.openStart, newOpenTagEnd) may differ from the original — this proves it by anchoring on the untouched prefix and the untouched suffix (everything from the original openEnd onward), which for a container includes every one of its child elements. */
  function expectOnlyOpenTagChanged(patched: string, token: (typeof tokens)[number]): void {
    expect(patched.slice(0, token.openStart)).toBe(xml.slice(0, token.openStart));
    const suffix = xml.slice(token.openEnd);
    expect(patched.endsWith(suffix)).toBe(true);
  }

  it("replaces an existing attribute in place", () => {
    const token = locateToken(tokens, { node: "ROOT", child: "action", name: "LOCK_ROOT" });
    expect(token).toBeDefined();
    if (!token) return;
    const patched = patchOpenTagAttrs(xml, token, new Map([["category", "9"]]));
    expectOnlyOpenTagChanged(patched, token);
    const suffix = xml.slice(token.openEnd);
    const newOpenTag = patched.slice(token.openStart, patched.length - suffix.length);
    expect(newOpenTag).toContain('bo:category="9"');
    expect(newOpenTag).not.toContain('bo:category="3"');
    expect(scanModel(patched).length).toBe(tokens.length); // well-formed; no element gained or lost
  });

  it("string values pass through escapeAttrValue (quotes and ampersands escaped)", () => {
    const token = locateToken(tokens, { node: "ROOT", child: "action", name: "LOCK_ROOT" });
    expect(token).toBeDefined();
    if (!token) return;
    const patched = patchOpenTagAttrs(xml, token, new Map([["xmlName", 'Lock "Root" & Release']]));
    const suffix = xml.slice(token.openEnd);
    const newOpenTag = patched.slice(token.openStart, patched.length - suffix.length);
    expect(newOpenTag).toContain('bo:xmlName="Lock &quot;Root&quot; &amp; Release"');
  });

  it("patching bo:category does not touch the longer bo:exportingParameterCategoryType attribute", () => {
    const token = locateToken(tokens, { node: "ROOT", child: "action", name: "LOCK_ROOT" });
    expect(token).toBeDefined();
    if (!token) return;
    expect(token.attrs.get("bo:exportingParameterCategoryType")).toBe("None");
    const patched = patchOpenTagAttrs(xml, token, new Map([["category", "9"]]));
    const suffix = xml.slice(token.openEnd);
    const newOpenTag = patched.slice(token.openStart, patched.length - suffix.length);
    expect(newOpenTag).toContain('bo:exportingParameterCategoryType="None"');
    expect(newOpenTag).toContain('bo:category="9"');
    expect(newOpenTag).not.toContain('bo:category="3"');
  });

  it("appends a missing attribute just before the closing '>'", () => {
    const token = locateToken(tokens, { node: "ROOT", child: "action", name: "LOCK_ROOT" });
    expect(token).toBeDefined();
    if (!token) return;
    expect(token.attrs.has("bo:xmlName")).toBe(false);
    const patched = patchOpenTagAttrs(xml, token, new Map([["xmlName", "Lock Root"]]));
    expectOnlyOpenTagChanged(patched, token);
    const suffix = xml.slice(token.openEnd);
    const newOpenTag = patched.slice(token.openStart, patched.length - suffix.length);
    expect(newOpenTag).toContain('bo:xmlName="Lock Root"');
    expect(newOpenTag.endsWith(">")).toBe(true);
    expect(newOpenTag.endsWith("/>")).toBe(false); // container form preserved
  });

  it("removes an attribute given null", () => {
    const token = locateToken(tokens, { node: "ROOT", child: "action", name: "LOCK_ROOT" });
    expect(token).toBeDefined();
    if (!token) return;
    expect(token.attrs.has("bo:isExtensible")).toBe(true);
    const patched = patchOpenTagAttrs(xml, token, new Map([["isExtensible", null]]));
    expectOnlyOpenTagChanged(patched, token);
    const suffix = xml.slice(token.openEnd);
    const newOpenTag = patched.slice(token.openStart, patched.length - suffix.length);
    expect(newOpenTag).not.toContain("bo:isExtensible");
  });

  it("preserves self-closing form on a self-closing element", () => {
    const token = locateToken(tokens, { node: "ROOT", child: "query", name: "SELECT_ALL" });
    expect(token).toBeDefined();
    if (!token) return;
    expect(token.kind).toBe("empty");
    const patched = patchOpenTagAttrs(
      xml,
      token,
      new Map<string, string | boolean | null>([
        ["category", "selectNone"],
        ["objectModelGenerated", true],
      ]),
    );
    expectOnlyOpenTagChanged(patched, token);
    const suffix = xml.slice(token.openEnd);
    const newOpenTag = patched.slice(token.openStart, patched.length - suffix.length);
    expect(newOpenTag.endsWith("/>")).toBe(true);
    expect(newOpenTag).toContain('bo:category="selectNone"');
    expect(newOpenTag).toContain('bo:objectModelGenerated="true"');
    const reTokens = scanModel(patched);
    expect(reTokens.length).toBe(tokens.length); // no element gained or lost
  });

  it("on a container tag, every child element downstream survives byte-for-byte", () => {
    const token = locateToken(tokens, { node: "ROOT", child: "action", name: "LOCK_ROOT" });
    expect(token).toBeDefined();
    if (!token) return;
    const childText = xml.slice(token.openEnd, token.closeEnd); // implementationClassRef + parameterStructureRef + closing tag
    const patched = patchOpenTagAttrs(
      xml,
      token,
      new Map<string, string | boolean | null>([
        ["category", "9"],
        ["xmlName", "Lock Root"],
        ["isExtensible", null],
      ]),
    );
    const suffix = xml.slice(token.openEnd);
    const newOpenTag = patched.slice(token.openStart, patched.length - suffix.length);
    expect(patched.slice(patched.length - suffix.length, patched.length - suffix.length + childText.length)).toBe(
      childText,
    );
    expect(newOpenTag).toContain('bo:category="9"');
  });

  it("changes no bytes anywhere else in the document (whole-document diff outside the patched tag)", () => {
    const token = locateToken(tokens, { node: "ROOT", child: "action", name: "LOCK_ROOT" });
    expect(token).toBeDefined();
    if (!token) return;
    const patched = patchOpenTagAttrs(xml, token, new Map([["category", "9"]]));
    expect(patched.slice(0, token.openStart)).toBe(xml.slice(0, token.openStart));
    expect(patched.slice(patched.length - (xml.length - token.openEnd))).toBe(xml.slice(token.openEnd));
  });
});

describe("spliceSetElementRef: generalised singular-ref splice for any container element", () => {
  it("inserts a new ref respecting childOrder, after an earlier-ordered sibling", () => {
    const xml = read("10-model-coverage-final.v4.xml");
    const tokens = scanModel(xml);
    // SELECT_BY_ELEMENTS has dataTypeRef only; QUERY_CHILD_ORDER puts implementationClassRef right after it.
    const owner = locateToken(tokens, { node: "ROOT", child: "query", name: "SELECT_BY_ELEMENTS" });
    expect(owner).toBeDefined();
    if (!owner) return;
    const result = spliceSetElementRef(
      xml,
      tokens,
      owner,
      "bo:implementationClassRef",
      { name: "ZCL_QUERY_IMPL", type: "CLAS/OC" },
      QUERY_CHILD_ORDER,
    );
    const reTokens = scanModel(result);
    const reOwner = locateToken(reTokens, { node: "ROOT", child: "query", name: "SELECT_BY_ELEMENTS" });
    expect(reOwner).toBeDefined();
    if (!reOwner) return;
    const body = result.slice(reOwner.openEnd, reOwner.closeEnd);
    expect(body.startsWith("<bo:dataTypeRef")).toBe(true);
    expect(body).toContain('<bo:implementationClassRef adtcore:type="CLAS/OC" adtcore:name="ZCL_QUERY_IMPL"/>');
    const dataTypeIdx = body.indexOf("<bo:dataTypeRef");
    const implIdx = body.indexOf("<bo:implementationClassRef");
    expect(dataTypeIdx).toBeLessThan(implIdx);
  });

  it("inserts a new ref BEFORE an already-present later-ordered sibling", () => {
    const synthetic =
      `<?xml version="1.0" encoding="utf-8"?><bo:businessObject xmlns:bo="http://www.sap.com/bopf/bo/BusinessObject" ` +
      `xmlns:adtcore="http://www.sap.com/adt/core"><bo:nodes bo:name="ROOT"><bo:actions bo:name="ACT1">` +
      `<bo:parameterStructureRef adtcore:type="TABL/DS" adtcore:name="ZS1"/></bo:actions></bo:nodes></bo:businessObject>`;
    const tokens = scanModel(synthetic);
    const owner = locateToken(tokens, { node: "ROOT", child: "action", name: "ACT1" });
    expect(owner).toBeDefined();
    if (!owner) return;
    // ACTION_CHILD_ORDER = [implementationClassRef, parameterStructureRef] — implementationClassRef must land BEFORE the existing parameterStructureRef.
    const result = spliceSetElementRef(
      synthetic,
      tokens,
      owner,
      "bo:implementationClassRef",
      { name: "ZCL1", type: "CLAS/OC" },
      ACTION_CHILD_ORDER,
    );
    const reTokens = scanModel(result);
    const reOwner = locateToken(reTokens, { node: "ROOT", child: "action", name: "ACT1" });
    expect(reOwner).toBeDefined();
    if (!reOwner) return;
    const body = result.slice(reOwner.openEnd, reOwner.closeEnd);
    expect(body.indexOf("<bo:implementationClassRef")).toBeLessThan(body.indexOf("<bo:parameterStructureRef"));
  });

  it("replaces an existing ref in place, leaving sibling refs untouched", () => {
    const xml = read("10-model-coverage-final.v4.xml");
    const tokens = scanModel(xml);
    const owner = locateToken(tokens, { node: "ROOT", child: "action", name: "LOCK_ROOT" });
    expect(owner).toBeDefined();
    if (!owner) return;
    const paramRefBefore = xml.slice(
      xml.indexOf("<bo:parameterStructureRef", owner.openStart),
      xml.indexOf("/>", xml.indexOf("<bo:parameterStructureRef", owner.openStart)) + 2,
    );
    const result = spliceSetElementRef(
      xml,
      tokens,
      owner,
      "bo:implementationClassRef",
      { name: "ZCL_REPLACED", type: "CLAS/OC" },
      ACTION_CHILD_ORDER,
    );
    expect(result).toContain('<bo:implementationClassRef adtcore:type="CLAS/OC" adtcore:name="ZCL_REPLACED"/>');
    expect(result).not.toContain("/BOBF/CL_LIB_A_LOCK");
    expect(result).toContain(paramRefBefore); // sibling untouched
  });

  it("clears an existing ref given null", () => {
    const xml = read("10-model-coverage-final.v4.xml");
    const tokens = scanModel(xml);
    const owner = locateToken(tokens, { node: "ROOT", child: "action", name: "LOCK_ROOT" });
    expect(owner).toBeDefined();
    if (!owner) return;
    const result = spliceSetElementRef(xml, tokens, owner, "bo:parameterStructureRef", null, ACTION_CHILD_ORDER);
    expect(result).not.toContain("bo:parameterStructureRef");
    expect(result).toContain("/BOBF/CL_LIB_A_LOCK"); // implementationClassRef, the sibling, survives
    expect(scanModel(result).length).toBe(tokens.length - 1); // exactly the cleared element's token is gone
  });

  it("clearing a ref that is already absent is a no-op", () => {
    const xml = read("10-model-coverage-final.v4.xml");
    const tokens = scanModel(xml);
    const owner = locateToken(tokens, { node: "ROOT", child: "action", name: "Z_ACTION" }); // has implementationClassRef only
    expect(owner).toBeDefined();
    if (!owner) return;
    const result = spliceSetElementRef(xml, tokens, owner, "bo:parameterStructureRef", null, ACTION_CHILD_ORDER);
    expect(result).toBe(xml);
  });

  it("promotes a self-closing owner to a container before inserting", () => {
    const xml = read("10-model-coverage-final.v4.xml");
    const tokens = scanModel(xml);
    const owner = locateToken(tokens, { node: "ROOT", child: "query", name: "SELECT_ALL" });
    expect(owner).toBeDefined();
    if (!owner) return;
    expect(owner.kind).toBe("empty");
    const result = spliceSetElementRef(
      xml,
      tokens,
      owner,
      "bo:dataTypeRef",
      { name: "ZTMD_S_ROOT6", type: "TABL/DS" },
      QUERY_CHILD_ORDER,
    );
    const reTokens = scanModel(result);
    const reOwner = locateToken(reTokens, { node: "ROOT", child: "query", name: "SELECT_ALL" });
    expect(reOwner).toBeDefined();
    if (!reOwner) return;
    expect(reOwner.kind).toBe("container");
    expect(result.slice(reOwner.openEnd, reOwner.closeEnd)).toBe(
      '<bo:dataTypeRef adtcore:type="TABL/DS" adtcore:name="ZTMD_S_ROOT6"/></bo:queries>',
    );
  });

  it("siblings elsewhere in the document are preserved byte-for-byte", () => {
    const xml = read("10-model-coverage-final.v4.xml");
    const tokens = scanModel(xml);
    const owner = locateToken(tokens, { node: "ROOT", child: "action", name: "LOCK_ROOT" });
    expect(owner).toBeDefined();
    if (!owner) return;
    const result = spliceSetElementRef(
      xml,
      tokens,
      owner,
      "bo:implementationClassRef",
      { name: "ZCL_REPLACED", type: "CLAS/OC" },
      ACTION_CHILD_ORDER,
    );
    expect(result.slice(0, owner.openStart)).toBe(xml.slice(0, owner.openStart));
    expect(result.slice(result.length - (xml.length - owner.closeEnd))).toBe(xml.slice(owner.closeEnd));
  });
});

describe("renderElement / renderRef: attribute order and self-closing form", () => {
  it("renders a self-closing element with attributes in the declared order", () => {
    const out = renderElement("query", { category: "01", name: "Q1", objectModelGenerated: false });
    // QUERY_ATTR_ORDER = name, nodeID, objectModelGenerated, xmlName, category
    expect(out).toBe('<bo:queries bo:name="Q1" bo:objectModelGenerated="false" bo:category="01"/>');
  });

  it("renders a container element when children are supplied", () => {
    const out = renderElement("association", { name: "A1" }, "<bo:targetNodeRef/>");
    expect(out).toBe('<bo:associations bo:name="A1"><bo:targetNodeRef/></bo:associations>');
  });

  it("renders a ref with uri, type and name in order", () => {
    const out = renderRef("bo:implementationClassRef", { uri: "/sap/x", type: "CLAS/OC", name: "ZCL_FOO" });
    expect(out).toBe('<bo:implementationClassRef adtcore:uri="/sap/x" adtcore:type="CLAS/OC" adtcore:name="ZCL_FOO"/>');
  });

  it("renders a ref without uri when omitted", () => {
    const out = renderRef("bo:targetNodeRef", { type: "X", name: "Y" });
    expect(out).toBe('<bo:targetNodeRef adtcore:type="X" adtcore:name="Y"/>');
  });

  it("escapes &, < and \" in attribute values", () => {
    const out = renderElement("query", { name: 'A & B < "C"' });
    expect(out).toBe('<bo:queries bo:name="A &amp; B &lt; &quot;C&quot;"/>');
  });

  it("renders a property leaf in PROPERTY_ATTR_ORDER", () => {
    expect(renderProperty({ name: "ID", enabled: true, readonly: false })).toBe(
      '<bo:properties bo:name="ID" bo:enabled="true" bo:readonly="false"/>',
    );
  });

  it("renders a relation leaf with no bo:name attribute", () => {
    expect(renderRelation({ node: "ITEM", determination: "CALC_TOTAL" })).toBe(
      '<bo:relations bo:node="ITEM" bo:determination="CALC_TOTAL"/>',
    );
  });
});

describe("mintGuid: encoding matches GUID_ENCODING per element kind", () => {
  it("mints base64 for node/determination/validation", () => {
    for (const kind of ["node", "determination", "validation"] as const) {
      const g = mintGuid(kind);
      // 16 bytes base64: 24 chars, may end in '=' padding.
      expect(g.length).toBeGreaterThanOrEqual(22);
      expect(() => Buffer.from(g, "base64")).not.toThrow();
    }
  });

  it("mints 32-char uppercase hex for association/query/action/alternativeKey", () => {
    for (const kind of ["association", "query", "action", "alternativeKey"] as const) {
      const g = mintGuid(kind);
      expect(g).toMatch(/^[0-9A-F]{32}$/);
    }
  });

  it("mints different values on successive calls", () => {
    expect(mintGuid("node")).not.toBe(mintGuid("node"));
  });
});

describe("parseModel: read view over real captures", () => {
  it("parses fixture 01 into a model with the expected root and node names", () => {
    const model = parseModel(read("01-get-demo_sales_order.v4.xml"));
    expect(model.type).toBe("BOBF");
    expect(model.nodes.length).toBeGreaterThan(0);
    const names = model.nodes.map((n) => n.name);
    expect(names).toContain("ROOT");
  });

  it("parses fixture 02 (root-only, freshly created) without throwing", () => {
    const model = parseModel(read("02-created-zbopf_prb1-root-only.v4.xml"));
    expect(model.name.length).toBeGreaterThan(0);
  });

  it("parses fixture 10 (model coverage final) and surfaces at least one association, action, determination, validation and query", () => {
    // 10 does not contain a `bo:alternativeKeys` element (only 01 does — confirmed by
    // grep against the raw fixture bytes), so that kind is checked against 01 below instead.
    const model = parseModel(read("10-model-coverage-final.v4.xml"));
    const all = {
      associations: model.nodes.flatMap((n) => n.associations),
      actions: model.nodes.flatMap((n) => n.actions),
      determinations: model.nodes.flatMap((n) => n.determinations),
      validations: model.nodes.flatMap((n) => n.validations),
      queries: model.nodes.flatMap((n) => n.queries),
    };
    for (const [key, arr] of Object.entries(all)) {
      expect(arr.length, `expected at least one ${key} in fixture 10`).toBeGreaterThan(0);
    }
  });

  it("parses fixture 01's alternative keys", () => {
    const model = parseModel(read("01-get-demo_sales_order.v4.xml"));
    const keys = model.nodes.flatMap((n) => n.alternativeKeys);
    expect(keys.length).toBeGreaterThan(0);
  });

  it("rejects a document that has no bo:businessObject root", () => {
    expectBadInput(() => parseModel('<?xml version="1.0"?><notABusinessObject/>'));
  });

  it("round-trips a node's boolean flags as real booleans, not strings", () => {
    const model = parseModel(read("01-get-demo_sales_order.v4.xml"));
    const root = model.nodes.find((n) => n.name === "ROOT");
    expect(root).toBeDefined();
    if (!root) return;
    expect(typeof root.rootNode).toBe("boolean");
    expect(root.rootNode).toBe(true);
  });
});
