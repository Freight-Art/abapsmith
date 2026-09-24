/**
 * Coverage-focused edge cases for `src/adt/cds-lineage.ts`, complementing
 * test/cds-lineage.test.ts's live-capture-driven tests with hand-written DDL
 * snippets that exercise parser branches, buildLineage error/stop paths and
 * field-lineage tracing the captures don't happen to hit.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { parseDdl } from "../src/adt/cds-lineage.js";

const resolveMap = new Map<string, ResolvedObject>();
const plainErrorNames = new Set<string>();

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async (_conn: unknown, name: string) => {
    if (plainErrorNames.has(name.toUpperCase())) {
      throw new Error(`${name}: plain failure (test stub)`);
    }
    const hit = resolveMap.get(name.toUpperCase());
    if (!hit) {
      const { AbapError: Err } = await import("../src/adt/errors.js");
      throw new Err("NOT_FOUND", `${name} not found (test stub)`, { name });
    }
    return hit;
  },
}));

const { buildLineage, renderLineage } = await import("../src/adt/cds-lineage.js");

function ddlsObj(name: string, sourceUri: string): ResolvedObject {
  return {
    system: "A4H",
    type: "DDLS/DF",
    kind: "DDLS",
    label: "CDS view",
    name,
    uri: `/sap/bc/adt/ddic/ddl/sources/${name.toLowerCase()}`,
    sourceUri,
    mode: "source",
    activation: "unknown",
    spec: {},
  } as unknown as ResolvedObject;
}

function tableObj(name: string): ResolvedObject {
  return {
    system: "A4H",
    type: "TABL/DT",
    kind: "TABL",
    label: "table",
    name,
    uri: `/sap/bc/adt/ddic/tables/${name.toLowerCase()}`,
    mode: "ddic",
    activation: "unknown",
    spec: {},
  } as unknown as ResolvedObject;
}

async function catchAbapAsync(p: Promise<unknown>): Promise<AbapError> {
  try {
    await p;
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected an AbapError, but the call resolved normally");
}

beforeEach(() => {
  resolveMap.clear();
  plainErrorNames.clear();
});

describe("parseDdl: annotation stripping edge cases", () => {
  it("a single-line brace-valued annotation (opens and closes on the same physical line) is stripped, nested braces included", () => {
    const src = '@Anno: { x: { y: 1 } } define view entity FOO as select from BAR as B { key B.id as id }';
    const parsed = parseDdl(src);
    expect(parsed.kind).toBe("view entity");
    expect(parsed.name).toBe("FOO");
    expect(parsed.fields).toHaveLength(1);
  });

  it("a multi-line brace-valued annotation whose continuation line itself opens a nested brace stays balanced", () => {
    const src = [
      "@Anno: {",
      "  x: { y: 1 }",
      "}",
      "define view entity FOO as select from BAR as B {",
      "  key B.id as id",
      "}",
    ].join("\n");
    const parsed = parseDdl(src);
    expect(parsed.kind).toBe("view entity");
    expect(parsed.fields).toHaveLength(1);
  });

  it("a doubled single-quote inside a string literal doesn't confuse the trailing // comment stripper", () => {
    const src = [
      "define view entity FOO as select from BAR as B {",
      "  key B.id as id, 'it''s fine' as note // trailing comment",
      "}",
    ].join("\n");
    const parsed = parseDdl(src);
    const note = parsed.fields.find((f) => f.alias === "note");
    expect(note?.text).toBe("'it''s fine' as note");
    expect(parsed.fields.some((f) => f.isKey)).toBe(true);
  });
});

describe("parseDdl: kind/data-source forms not covered by the live captures", () => {
  it('"extend view X with Y" parses kind "extend view", name X', () => {
    const parsed = parseDdl("extend view ZFOO with ZFOO_EXT { key id }");
    expect(parsed.kind).toBe("extend view");
    expect(parsed.name).toBe("ZFOO");
  });

  it('"as projection on" yields a from-relation data source', () => {
    const parsed = parseDdl("define view entity PVIEW as projection on BASE as B { key B.id as id }");
    expect(parsed.dataSources).toHaveLength(1);
    expect(parsed.dataSources[0]?.relation).toBe("from");
    expect(parsed.dataSources[0]?.target).toBe("BASE");
    expect(parsed.dataSources[0]?.alias).toBe("B");
  });

  it("with parameters clause extracts parameter names, stopping before the select", () => {
    const src = "define view entity PVIEW with parameters p1 : abap.char(10), p2 : abap.numc(4) as select from BASE as A { key A.id as id }";
    const parsed = parseDdl(src);
    expect(parsed.parameters).toEqual(["p1", "p2"]);
  });

  it("a DDL with no field list at all yields empty fields (no { present)", () => {
    const parsed = parseDdl("define view entity FOO as select from BAR as B");
    expect(parsed.fields).toEqual([]);
    expect(parsed.dataSources[0]?.target).toBe("BAR");
  });

  it("an unbalanced (never-closed) field list is treated as no field list found", () => {
    const parsed = parseDdl("define view entity FOO as select from BAR as B { key B.id as id");
    expect(parsed.fields).toEqual([]);
  });
});

describe("buildLineage: input validation beyond depth", () => {
  const MINIMAL_VIEW = "define view entity ROOT1 as select from BASE as B { key B.id as id }";

  it("a non-positive-integer nodeBudget is refused BAD_INPUT", async () => {
    const root = ddlsObj("ROOT1", "/root1/source/main");
    const conn = { cfg: { sid: "A4H" }, get: async () => ({ body: MINIMAL_VIEW, headers: {} }) } as unknown as AbapConnection;
    const err = await catchAbapAsync(buildLineage(conn, root, { nodeBudget: 0 }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("nodeBudget");
  });

  it("a non-CDS root object is refused UNSUPPORTED before any read", async () => {
    const root = tableObj("ZTABLE1");
    const conn = {
      cfg: { sid: "A4H" },
      get: async () => {
        throw new Error("should not be called");
      },
    } as unknown as AbapConnection;
    const err = await catchAbapAsync(buildLineage(conn, root, {}));
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).toContain("ZTABLE1");
  });
});

describe("buildLineage: root read failure wraps the underlying error rather than rethrowing it raw", () => {
  it("an AbapError thrown by readSource becomes the root's leaf reason unchanged", async () => {
    const root = ddlsObj("ROOT2", "/root2/source/main");
    const conn = {
      cfg: { sid: "A4H" },
      get: async () => {
        throw new AbapError("NOT_FOUND", "ROOT2 missing", {});
      },
    } as unknown as AbapConnection;
    const result = await buildLineage(conn, root, {});
    expect(result.root.leaf).toBe(true);
    expect(result.root.leafReason).toContain("ROOT2 missing");
  });

  it("a plain Error thrown by readSource is wrapped via describeUnknownError", async () => {
    const root = ddlsObj("ROOT3", "/root3/source/main");
    const conn = {
      cfg: { sid: "A4H" },
      get: async () => {
        throw new Error("boom");
      },
    } as unknown as AbapConnection;
    const result = await buildLineage(conn, root, {});
    expect(result.root.leaf).toBe(true);
    expect(result.root.leafReason).toMatch(/not found:.*boom/);
  });

  it("a plain Error thrown by resolveObject (not readSource) is wrapped via toAbapError's fallback", async () => {
    const root = ddlsObj("ROOT4", "/root4/source/main");
    const src = "define view entity ROOT4 as select from OTHERVIEW as A { key A.id as id }";
    plainErrorNames.add("OTHERVIEW");
    const conn = { cfg: { sid: "A4H" }, get: async () => ({ body: src, headers: {} }) } as unknown as AbapConnection;
    const result = await buildLineage(conn, root, {});
    const child = result.root.children?.[0];
    expect(child?.leaf).toBe(true);
    expect(child?.leafReason).toMatch(/resolving reference:.*plain failure/);
  });
});

describe("buildLineage: stop reasons besides the depth limit", () => {
  it("a table function root stops immediately, never decomposed", async () => {
    const root = ddlsObj("TFUNC1", "/tfunc1/source/main");
    const src = "define table function TFUNC1 returns { key id : abap.char(10); }";
    const conn = { cfg: { sid: "A4H" }, get: async () => ({ body: src, headers: {} }) } as unknown as AbapConnection;
    const result = await buildLineage(conn, root, {});
    expect(result.root.leaf).toBe(true);
    expect(result.root.leafReason).toContain("table function");
  });

  it("a parameterised (non-table-function) view stops citing unresolved parameter bindings", async () => {
    const root = ddlsObj("PVIEW1", "/pview1/source/main");
    const src = "define view entity PVIEW1 with parameters p1 : abap.char(10) as select from BASE as A { key A.id as id }";
    const conn = { cfg: { sid: "A4H" }, get: async () => ({ body: src, headers: {} }) } as unknown as AbapConnection;
    const result = await buildLineage(conn, root, {});
    expect(result.root.leaf).toBe(true);
    expect(result.root.leafReason).toContain("parameterised view");
  });
});

describe("buildLineage: an unselected association is a \"(not selected)\" leaf, never walked into", () => {
  it("an association defined but never referenced in the field list is not resolved", async () => {
    const root = ddlsObj("ROOTA", "/roota/source/main");
    const src = [
      "define view entity ROOTA as select from BASE as B",
      "  association [0..1] to OTHERV as _Other on B.id = _Other.id",
      "{",
      "  key B.id as id",
      "}",
    ].join("\n");
    resolveMap.set("BASE", tableObj("BASE"));
    const conn = { cfg: { sid: "A4H" }, get: async () => ({ body: src, headers: {} }) } as unknown as AbapConnection;
    const result = await buildLineage(conn, root, {});
    const child = result.root.children.find((c) => c.associationName === "_Other");
    expect(child?.leaf).toBe(true);
    expect(child?.leafReason).toBe("not selected");
  });
});

describe("renderLineage: join/union relation labels", () => {
  it("a join data source renders its join kind and target", async () => {
    const root = ddlsObj("ROOTJ", "/rootj/source/main");
    const src = [
      "define view entity ROOTJ as select from BASE1 as A",
      "  inner join BASE2 as Bx on A.id = Bx.id",
      "{",
      "  key A.id as id",
      "}",
    ].join("\n");
    resolveMap.set("BASE1", tableObj("BASE1"));
    resolveMap.set("BASE2", tableObj("BASE2"));
    const conn = { cfg: { sid: "A4H" }, get: async () => ({ body: src, headers: {} }) } as unknown as AbapConnection;
    const result = await buildLineage(conn, root, {});
    const rendered = renderLineage(result);
    expect(rendered.body).toMatch(/inner join BASE2 as Bx \(table\)/);
  });

  it("a union data source renders as \"union <target>\"", async () => {
    const root = ddlsObj("ROOTU", "/rootu/source/main");
    const src = "define view entity ROOTU as select from BASE1 as A { key A.id as id } union select from BASE3 { key id }";
    resolveMap.set("BASE1", tableObj("BASE1"));
    resolveMap.set("BASE3", tableObj("BASE3"));
    const conn = { cfg: { sid: "A4H" }, get: async () => ({ body: src, headers: {} }) } as unknown as AbapConnection;
    const result = await buildLineage(conn, root, {});
    const rendered = renderLineage(result);
    expect(rendered.body).toMatch(/union BASE3 \(table\)/);
  });
});

describe("buildLineage field option: terminal reasons other than \"has no field\"", () => {
  it("a function-call expression with zero traceable sources terminates as ambiguous", async () => {
    const root = ddlsObj("FLD1", "/fld1/source/main");
    const src = "define view entity FLD1 as select from BASE as B { key B.id as id, sysuuid_x16() as guid }";
    resolveMap.set("BASE", tableObj("BASE"));
    const conn = { cfg: { sid: "A4H" }, get: async () => ({ body: src, headers: {} }) } as unknown as AbapConnection;
    const result = await buildLineage(conn, root, { field: "guid" });
    expect(result.fieldChain).toHaveLength(1);
    expect(result.fieldChain?.[0]?.terminalReason).toBe("expression has no traceable source reference");
  });

  it("an expression combining multiple source references terminates as ambiguous", async () => {
    const root = ddlsObj("FLD2", "/fld2/source/main");
    const src = [
      "define view entity FLD2 as select from BASE1 as A",
      "  inner join BASE2 as C on A.id = C.id",
      "{",
      "  key A.id as id,",
      "  coalesce(A.x, C.y) as combined",
      "}",
    ].join("\n");
    resolveMap.set("BASE1", tableObj("BASE1"));
    resolveMap.set("BASE2", tableObj("BASE2"));
    const conn = { cfg: { sid: "A4H" }, get: async () => ({ body: src, headers: {} }) } as unknown as AbapConnection;
    const result = await buildLineage(conn, root, { field: "combined" });
    const step = result.fieldChain?.[0];
    expect(step?.terminal).toBe(true);
    expect(step?.terminalReason).toMatch(/combines 2 source references/);
  });

  it("a bare column with no alias terminates, described as belonging to its own data source", async () => {
    const root = ddlsObj("FLD3", "/fld3/source/main");
    const src = "define view entity FLD3 as select from BASE as B { key id }";
    resolveMap.set("BASE", tableObj("BASE"));
    const conn = { cfg: { sid: "A4H" }, get: async () => ({ body: src, headers: {} }) } as unknown as AbapConnection;
    const result = await buildLineage(conn, root, { field: "id" });
    const step = result.fieldChain?.[0];
    expect(step?.terminal).toBe(true);
    expect(step?.terminalReason).toBe("column of this node's own data source — not itself an alias to follow");
  });

  it("an alias that matches no known data source or association terminates, naming the alias", async () => {
    const root = ddlsObj("FLD4", "/fld4/source/main");
    const src = "define view entity FLD4 as select from BASE as B { key B.id as id, foo.bar as ualias }";
    resolveMap.set("BASE", tableObj("BASE"));
    const conn = { cfg: { sid: "A4H" }, get: async () => ({ body: src, headers: {} }) } as unknown as AbapConnection;
    const result = await buildLineage(conn, root, { field: "ualias" });
    const step = result.fieldChain?.[0];
    expect(step?.terminal).toBe(true);
    expect(step?.terminalReason).toBe('alias "foo" does not match a known data source or association here');
  });
});

describe("buildLineage field option: multi-hop chains through traceField's own resolve/read", () => {
  it("a chained alias.field resolves through a CDS child view down to a base (non-CDS) column", async () => {
    const root = ddlsObj("FLD5ROOT", "/fld5root/source/main");
    const child = ddlsObj("FLD5CHILD", "/fld5child/source/main");
    const rootSrc = "define view entity FLD5ROOT as select from FLD5CHILD as Ch { key Ch.id as id, Ch.name as chainedfield }";
    const childSrc = "define view entity FLD5CHILD as select from BASE_T as T { key T.id as id, T.name as name }";
    resolveMap.set("FLD5CHILD", child);
    resolveMap.set("BASE_T", tableObj("BASE_T"));
    const conn = {
      cfg: { sid: "A4H" },
      get: async (uri: string) => {
        if (uri === "/fld5root/source/main") return { body: rootSrc, headers: {} };
        if (uri === "/fld5child/source/main") return { body: childSrc, headers: {} };
        throw new Error(`unexpected uri: ${uri}`);
      },
    } as unknown as AbapConnection;
    const result = await buildLineage(conn, root, { field: "chainedfield" });
    expect(result.fieldChain).toHaveLength(3);
    expect(result.fieldChain?.[0]?.terminal).toBe(false);
    expect(result.fieldChain?.[1]?.terminal).toBe(false);
    expect(result.fieldChain?.[2]?.terminal).toBe(true);
    expect(result.fieldChain?.[2]?.terminalReason).toContain("is not CDS source — base column");

    const rendered = renderLineage(result, { field: "chainedfield" });
    expect(rendered.header.field).toBe("chainedfield");
    expect(rendered.body).toContain("FLD5ROOT.chainedfield");
  });

  it("traceField's own resolveObject failure terminates with a not-found reason", async () => {
    const root = ddlsObj("FLD6", "/fld6/source/main");
    const src = "define view entity FLD6 as select from MISSINGV as M { key M.id as id, M.val as val }";
    const conn = { cfg: { sid: "A4H" }, get: async () => ({ body: src, headers: {} }) } as unknown as AbapConnection;
    const result = await buildLineage(conn, root, { field: "val" });
    const step = result.fieldChain?.[1];
    expect(step?.terminal).toBe(true);
    expect(step?.terminalReason).toContain("not found");
  });

  it("traceField's own readSource failure (after a successful resolve) terminates with a not-found reason", async () => {
    const root = ddlsObj("FLD7", "/fld7/source/main");
    const nextObj = ddlsObj("FLD7NEXT", "/fld7next/source/main");
    const src = "define view entity FLD7 as select from FLD7NEXT as N { key N.id as id, N.val as val }";
    resolveMap.set("FLD7NEXT", nextObj);
    const conn = {
      cfg: { sid: "A4H" },
      get: async (uri: string) => {
        if (uri === "/fld7/source/main") return { body: src, headers: {} };
        if (uri === "/fld7next/source/main") throw new Error("read failed");
        throw new Error(`unexpected uri: ${uri}`);
      },
    } as unknown as AbapConnection;
    const result = await buildLineage(conn, root, { field: "val" });
    const step = result.fieldChain?.[1];
    expect(step?.terminal).toBe(true);
    expect(step?.terminalReason).toContain("not found");
  });

  it("a later hop's own missing-field check names that node, not the root", async () => {
    const root = ddlsObj("FLD8", "/fld8/source/main");
    const next = ddlsObj("FLD8NEXT", "/fld8next/source/main");
    const src = "define view entity FLD8 as select from FLD8NEXT as N { key N.id as id, N.othername as h }";
    const nextSrc = "define view entity FLD8NEXT as select from BASE as T { key T.id as id }";
    resolveMap.set("FLD8NEXT", next);
    resolveMap.set("BASE", tableObj("BASE"));
    const conn = {
      cfg: { sid: "A4H" },
      get: async (uri: string) => {
        if (uri === "/fld8/source/main") return { body: src, headers: {} };
        if (uri === "/fld8next/source/main") return { body: nextSrc, headers: {} };
        throw new Error(`unexpected uri: ${uri}`);
      },
    } as unknown as AbapConnection;
    const result = await buildLineage(conn, root, { field: "h" });
    expect(result.fieldChain).toHaveLength(2);
    const step = result.fieldChain?.[1];
    expect(step?.terminal).toBe(true);
    expect(step?.terminalReason).toBe('FLD8NEXT has no field "othername"');
  });

  it("a field chain that loops back to an already-visited node/field pair terminates as a cycle", async () => {
    const rootC = ddlsObj("FLDCYC1", "/fldcyc1/source/main");
    const src1 = "define view entity FLDCYC1 as select from FLDCYC2 as R { key R.id as id, R.x as x }";
    const src2 = "define view entity FLDCYC2 as select from FLDCYC1 as R2 { key R2.id as id, R2.x as x }";
    resolveMap.set("FLDCYC2", ddlsObj("FLDCYC2", "/fldcyc2/source/main"));
    resolveMap.set("FLDCYC1", rootC);
    const conn = {
      cfg: { sid: "A4H" },
      get: async (uri: string) => {
        if (uri === "/fldcyc1/source/main") return { body: src1, headers: {} };
        if (uri === "/fldcyc2/source/main") return { body: src2, headers: {} };
        throw new Error(`unexpected uri: ${uri}`);
      },
    } as unknown as AbapConnection;
    const result = await buildLineage(conn, rootC, { field: "x" });
    const chain = result.fieldChain!;
    expect(chain).toHaveLength(3);
    expect(chain[2]?.terminalReason).toBe("cycle -> seen above");
  });
});

describe("buildLineage field option: BAD_INPUT message edge cases", () => {
  it("a root read failure plus a field option still refuses BAD_INPUT with an empty known-fields list, not a crash", async () => {
    const root = ddlsObj("FLD9", "/fld9/source/main");
    const conn = {
      cfg: { sid: "A4H" },
      get: async () => {
        throw new Error("network down");
      },
    } as unknown as AbapConnection;
    const err = await catchAbapAsync(buildLineage(conn, root, { field: "anything" }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("Known fields: .");
  });

  it("more than 40 known fields are truncated with an \"... and N more\" suffix", async () => {
    const root = ddlsObj("FLD10", "/fld10/source/main");
    const fieldList = Array.from({ length: 45 }, (_, i) => `key${i}`).join(", ");
    const src = `define view entity FLD10 as select from BASE as B { ${fieldList} }`;
    resolveMap.set("BASE", tableObj("BASE"));
    const conn = { cfg: { sid: "A4H" }, get: async () => ({ body: src, headers: {} }) } as unknown as AbapConnection;
    const err = await catchAbapAsync(buildLineage(conn, root, { field: "NoSuchField" }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain(", ... and 5 more");
  });
});
