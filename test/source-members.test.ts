/**
 * Member resolution on classes — issues #146 (inherited members and
 * signatures) and #147 (`method=` after CHECK_FAILED).
 *
 * Everything here is offline: the connection is a routing fake that answers
 * `GET …/source/main`, `GET …/objectstructure?version=inactive` and
 * `adt.classComponents` (the active structure) from in-memory fixtures and
 * records every request, so the tests can also pin how many round trips a
 * resolution costs.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapError } from "../src/adt/errors.js";
import { withSourceContext } from "../src/adt/activate.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import {
  AVAILABLE_MEMBERS_MAX_DEFAULT,
  abapStatements,
  availableMembersMax,
  classMembersFor,
  findMethodDeclaration,
  flattenComponents,
  inheritedMembers,
  parseClassParents,
  rankCandidates,
  readMethod,
  renderInheritedOutline,
} from "../src/adt/source.js";
import { buildUri, specForType } from "../src/adt/types.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function objectOf(typeCode: string, name: string, activation: ResolvedObject["activation"] = "unknown"): ResolvedObject {
  const spec = specForType(typeCode)!;
  const uri = buildUri(spec, name);
  return {
    system: "A4H",
    type: spec.type,
    kind: spec.kind,
    label: spec.label,
    name,
    uri,
    sourceUri: `${uri}/source/main`,
    mode: spec.mode,
    activation,
    spec,
  } as ResolvedObject;
}

interface Comp {
  name: string;
  type: string;
  visibility?: string;
  impl?: string;
  def?: string;
}

/** `/objectstructure` XML, in the shape A4H serves (see test/write-dry-run.test.ts). */
function structureXml(name: string, type: string, comps: Comp[]): string {
  const links = (c: Comp) =>
    (c.def
      ? `<atom:link href="./source/main#${c.def}" rel="http://www.sap.com/adt/relations/source/definitionBlock"/>`
      : "") +
    (c.impl
      ? `<atom:link href="./source/main#${c.impl}" rel="http://www.sap.com/adt/relations/source/implementationBlock"/>`
      : "");
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<abapsource:objectStructureElement xmlns:abapsource="http://www.sap.com/adt/abapsource" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" xmlns:atom="http://www.w3.org/2005/Atom" ` +
    `adtcore:name="${name}" adtcore:type="${type}">` +
    comps
      .map(
        (c) =>
          `<abapsource:objectStructureElement adtcore:name="${c.name}" adtcore:type="${c.type}"` +
          (c.visibility ? ` visibility="${c.visibility}"` : "") +
          `>${links(c)}</abapsource:objectStructureElement>`,
      )
      .join("") +
    `</abapsource:objectStructureElement>`
  );
}

/** The parsed shape `adt.classComponents` returns for the same components. */
function structureParsed(name: string, type: string, comps: Comp[]): unknown {
  return {
    "adtcore:name": name,
    "adtcore:type": type,
    links: [],
    components: comps.map((c) => ({
      "adtcore:name": c.name,
      "adtcore:type": c.type,
      visibility: c.visibility,
      links: [
        ...(c.def
          ? [{ rel: "http://www.sap.com/adt/relations/source/definitionBlock", href: `./source/main#${c.def}` }]
          : []),
        ...(c.impl
          ? [{ rel: "http://www.sap.com/adt/relations/source/implementationBlock", href: `./source/main#${c.impl}` }]
          : []),
      ],
    })),
  };
}

interface Fixture {
  source: string;
  /** Components of the ACTIVE structure; `undefined` = the object does not exist. */
  active?: Comp[];
  /** Components of the INACTIVE structure; `undefined` = the server has no inactive version and answers 404. */
  inactive?: Comp[];
}

interface Call {
  url: string;
  qs?: Record<string, string>;
}

/**
 * Routing fake. `objects` is keyed by object URI. Unknown URIs answer
 * NOT_FOUND the way `readSource` classifies a real 404.
 */
function fakeConn(objects: Record<string, Fixture>): { conn: AbapConnection; calls: Call[] } {
  const calls: Call[] = [];
  const notFound = (url: string) =>
    new AbapError("NOT_FOUND", `${url} does not exist`, { status: 404, uri: url });
  const conn = {
    cfg: { sid: "A4H" },
    get: async (url: string, opts?: { qs?: Record<string, string> }) => {
      calls.push({ url, ...(opts?.qs ? { qs: opts.qs } : {}) });
      const src = /^(.*)\/source\/main$/.exec(url);
      if (src) {
        const fx = objects[src[1]!];
        if (!fx) throw notFound(url);
        return { body: fx.source, status: 200, headers: { etag: '"W/1"' } };
      }
      const struct = /^(.*)\/objectstructure$/.exec(url);
      if (struct) {
        const fx = objects[struct[1]!];
        if (!fx || fx.inactive === undefined) throw notFound(url);
        const [name, type] = [struct[1]!.split("/").pop()!.toUpperCase(), struct[1]!.includes("/interfaces/") ? "INTF/OI" : "CLAS/OC"];
        return { body: structureXml(name, type, fx.inactive), status: 200, headers: {} };
      }
      throw notFound(url);
    },
    adt: {
      classComponents: async (url: string) => {
        calls.push({ url, qs: { version: "active" } });
        const fx = objects[url];
        if (!fx || fx.active === undefined) throw notFound(url);
        const type = url.includes("/interfaces/") ? "INTF/OI" : "CLAS/OC";
        return structureParsed(url.split("/").pop()!.toUpperCase(), type, fx.active);
      },
    },
  };
  return { conn: conn as unknown as AbapConnection, calls };
}

const caught = async (fn: () => Promise<unknown>): Promise<AbapError> => {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AbapError);
    return e as AbapError;
  }
  throw new Error("expected a throw");
};

const CHILD_URI = "/sap/bc/adt/oo/classes/zcl_as_child";
const PARENT_URI = "/sap/bc/adt/oo/classes/zcl_as_parent";
const GRAND_URI = "/sap/bc/adt/oo/classes/zcl_as_grand";
const INTF_URI = "/sap/bc/adt/oo/interfaces/zif_as_thing";

const CHILD_SRC = [
  "CLASS zcl_as_child DEFINITION PUBLIC",
  "  INHERITING FROM zcl_as_parent",
  "  CREATE PUBLIC.",
  "  PUBLIC SECTION.",
  "    INTERFACES zif_as_thing.",
  "    METHODS own_method.",
  "ENDCLASS.",
  "CLASS zcl_as_child IMPLEMENTATION.",
  "  METHOD own_method.",
  "  ENDMETHOD.",
  "  METHOD zif_as_thing~do_it.",
  "  ENDMETHOD.",
  "ENDCLASS.",
].join("\n");

const PARENT_SRC = [
  "CLASS zcl_as_parent DEFINITION PUBLIC INHERITING FROM zcl_as_grand CREATE PUBLIC.",
  "  PUBLIC SECTION.",
  "    METHODS get_columns",
  "      RETURNING VALUE(rt_columns) TYPE string_table.",
  "  PROTECTED SECTION.",
  "    METHODS helper.",
  "  PRIVATE SECTION.",
  "    METHODS secret.",
  "ENDCLASS.",
  "CLASS zcl_as_parent IMPLEMENTATION.",
  "  METHOD get_columns.",
  "    rt_columns = VALUE #( ( `A` ) ).",
  "  ENDMETHOD.",
  "  METHOD helper.",
  "  ENDMETHOD.",
  "  METHOD secret.",
  "  ENDMETHOD.",
  "ENDCLASS.",
].join("\n");

const GRAND_SRC = [
  "CLASS zcl_as_grand DEFINITION PUBLIC CREATE PUBLIC.",
  "  PUBLIC SECTION.",
  "    METHODS root_method.",
  "ENDCLASS.",
  "CLASS zcl_as_grand IMPLEMENTATION.",
  "  METHOD root_method.",
  "  ENDMETHOD.",
  "ENDCLASS.",
].join("\n");

const INTF_SRC = [
  "INTERFACE zif_as_thing PUBLIC.",
  "  METHODS do_it.",
  "  METHODS do_other IMPORTING iv_x TYPE i.",
  "ENDINTERFACE.",
].join("\n");

const PARENT_COMPS: Comp[] = [
  { name: "GET_COLUMNS", type: "CLAS/OM", visibility: "public", def: "start=3,4;end=4,50", impl: "start=11,2;end=13,12" },
  { name: "HELPER", type: "CLAS/OM", visibility: "protected", impl: "start=14,2;end=15,12" },
  { name: "SECRET", type: "CLAS/OM", visibility: "private", impl: "start=16,2;end=17,12" },
];
const CHILD_COMPS: Comp[] = [
  { name: "OWN_METHOD", type: "CLAS/OM", visibility: "public", impl: "start=9,2;end=10,12" },
  { name: "ZIF_AS_THING~DO_IT", type: "CLAS/OM", visibility: "public", impl: "start=11,2;end=12,12" },
];
const GRAND_COMPS: Comp[] = [{ name: "ROOT_METHOD", type: "CLAS/OM", visibility: "public", impl: "start=6,2;end=7,12" }];
const INTF_COMPS: Comp[] = [
  { name: "DO_IT", type: "INTF/OM", visibility: "public" },
  { name: "DO_OTHER", type: "INTF/OM", visibility: "public" },
];

/** The whole family, every object active-only. */
const FAMILY: Record<string, Fixture> = {
  [CHILD_URI]: { source: CHILD_SRC, active: CHILD_COMPS },
  [PARENT_URI]: { source: PARENT_SRC, active: PARENT_COMPS },
  [GRAND_URI]: { source: GRAND_SRC, active: GRAND_COMPS },
  [INTF_URI]: { source: INTF_SRC, active: INTF_COMPS },
};

const CHILD = objectOf("CLAS/OC", "ZCL_AS_CHILD");

// ---------------------------------------------------------------------------
// #147 — the inactive structure is consulted first
// ---------------------------------------------------------------------------

describe("classMembersFor resolves against the inactive version first (#147)", () => {
  it("uses the inactive structure when the server has one", async () => {
    const { conn, calls } = fakeConn({
      [CHILD_URI]: { source: CHILD_SRC, active: [], inactive: CHILD_COMPS },
    });
    const r = await classMembersFor(conn, CHILD);
    expect(r.version).toBe("inactive");
    expect(r.members.map((m) => m.name)).toEqual(["OWN_METHOD", "ZIF_AS_THING~DO_IT"]);
    expect(calls).toEqual([{ url: `${CHILD_URI}/objectstructure`, qs: { version: "inactive", withShortDescriptions: "true" } }]);
  });

  it("falls back to the active structure when the inactive request fails", async () => {
    const { conn, calls } = fakeConn({ [CHILD_URI]: { source: CHILD_SRC, active: CHILD_COMPS } });
    const r = await classMembersFor(conn, CHILD);
    expect(r.version).toBe("active");
    expect(r.members).toHaveLength(2);
    expect(calls.map((c) => c.qs?.version)).toEqual(["inactive", "active"]);
  });

  it("falls back to active when the inactive structure is empty", async () => {
    const { conn } = fakeConn({ [CHILD_URI]: { source: CHILD_SRC, active: CHILD_COMPS, inactive: [] } });
    const r = await classMembersFor(conn, CHILD);
    expect(r.version).toBe("active");
    expect(r.members).toHaveLength(2);
  });

  it("skips the inactive attempt when the descriptor already says active is current", async () => {
    const { conn, calls } = fakeConn({ [CHILD_URI]: { source: CHILD_SRC, active: CHILD_COMPS, inactive: CHILD_COMPS } });
    const r = await classMembersFor(conn, objectOf("CLAS/OC", "ZCL_AS_CHILD", "active-is-current"));
    expect(r.version).toBe("active");
    expect(calls.map((c) => c.qs?.version)).toEqual(["active"]);
  });

  it("honours an explicit version without trying the other", async () => {
    const { conn, calls } = fakeConn({ [CHILD_URI]: { source: CHILD_SRC, active: CHILD_COMPS, inactive: [] } });
    const r = await classMembersFor(conn, CHILD, "active");
    expect(r.version).toBe("active");
    expect(calls.map((c) => c.qs?.version)).toEqual(["active"]);
    const err = await caught(() => classMembersFor(fakeConn({ [CHILD_URI]: { source: CHILD_SRC, active: CHILD_COMPS } }).conn, CHILD, "inactive"));
    expect(err.code).toBe("NOT_FOUND");
  });

  it("never lists the class or interface itself as a member (#147 item 2)", () => {
    const root = {
      "adtcore:name": "ZCL_AS_CHILD",
      "adtcore:type": "CLAS/OC",
      links: [],
      components: [
        { "adtcore:name": "ZCL_AS_CHILD", "adtcore:type": "CLAS/OC", links: [], components: [{ "adtcore:name": "M1", "adtcore:type": "CLAS/OM", links: [] }] },
        { "adtcore:name": "ZIF_AS_THING", "adtcore:type": "INTF/OI", links: [] },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(flattenComponents(root).map((m) => m.name)).toEqual(["M1"]);
  });

  it("readMethod's NOT_FOUND names the version it looked at and lists methods only", async () => {
    const { conn } = fakeConn({
      [CHILD_URI]: { source: CHILD_SRC, active: [], inactive: CHILD_COMPS },
    });
    const err = await caught(() => readMethod(conn, CHILD, CHILD_SRC, "NOPE"));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.details.version).toBe("inactive");
    expect(err.details.available).toEqual(["OWN_METHOD", "ZIF_AS_THING~DO_IT"]);
    expect(err.details.available).not.toContain("ZCL_AS_CHILD");
    expect(err.message).toContain("has no method NOPE");
  });

  it("says so when the structure declares no methods at all, instead of an unexplained empty list", async () => {
    const { conn } = fakeConn({ [CHILD_URI]: { source: CHILD_SRC, active: [] } });
    const err = await caught(() => readMethod(conn, CHILD, CHILD_SRC, "NOPE"));
    expect(err.message).toMatch(/declares no methods at all/);
    expect(err.message).toMatch(/no inactive version was found/);
    expect(err.details.availableTotal).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #146 — inherited members and signatures
// ---------------------------------------------------------------------------

describe("readMethod walks the inheritance chain (#146)", () => {
  it("finds a superclass method and says where it came from", async () => {
    const { conn, calls } = fakeConn(FAMILY);
    const r = await readMethod(conn, CHILD, CHILD_SRC, "GET_COLUMNS", { inherited: true });
    expect(r.foundOn).toEqual({ name: "ZCL_AS_PARENT", type: "CLAS/OC", relation: "superclass", via: "ZCL_AS_CHILD", depth: 1 });
    expect(r.member.name).toBe("GET_COLUMNS");
    // The parent carries a definitionBlock range, so the declaration is the range verbatim.
    expect(r.declaration).toBe("    METHODS get_columns\n      RETURNING VALUE(rt_columns) TYPE string_table.");
    expect(r.implementation).toContain("rt_columns = VALUE #( ( `A` ) ).");
    expect(r.implementationRange).toEqual({ startLine: 11, endLine: 13, document: "./source/main" });
    expect(r.searched).toEqual(["ZCL_AS_CHILD", "ZCL_AS_PARENT (superclass of ZCL_AS_CHILD)"]);
    // Own structure (inactive attempt + active), then the parent's source and structure.
    expect(calls.map((c) => c.url)).toEqual([
      `${CHILD_URI}/objectstructure`,
      CHILD_URI,
      `${PARENT_URI}/source/main`,
      `${PARENT_URI}/objectstructure`,
      PARENT_URI,
    ]);
  });

  it("finds an interface method through the interface, and a grandparent's through two levels", async () => {
    const { conn } = fakeConn(FAMILY);
    const viaIntf = await readMethod(conn, CHILD, CHILD_SRC, "DO_OTHER", { inherited: true });
    expect(viaIntf.foundOn?.name).toBe("ZIF_AS_THING");
    expect(viaIntf.foundOn?.relation).toBe("interface");
    expect(viaIntf.declaration).toBe("METHODS do_other IMPORTING iv_x TYPE i.");
    expect(viaIntf.implementation).toBeUndefined();

    const viaGrand = await readMethod(conn, CHILD, CHILD_SRC, "ROOT_METHOD", { inherited: true });
    expect(viaGrand.foundOn).toMatchObject({ name: "ZCL_AS_GRAND", depth: 2, via: "ZCL_AS_PARENT" });
  });

  it("prefers the class's own member and costs no chain request for it", async () => {
    const { conn, calls } = fakeConn(FAMILY);
    const r = await readMethod(conn, CHILD, CHILD_SRC, "OWN_METHOD", { inherited: true });
    expect(r.foundOn).toBeUndefined();
    expect(r.declaration).toBe("METHODS own_method.");
    expect(calls.every((c) => c.url.startsWith(CHILD_URI))).toBe(true);
  });

  it("without `inherited` the chain is never read", async () => {
    const { conn, calls } = fakeConn(FAMILY);
    const err = await caught(() => readMethod(conn, CHILD, CHILD_SRC, "GET_COLUMNS"));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.details.availableInherited).toBeUndefined();
    expect(calls.every((c) => c.url.startsWith(CHILD_URI))).toBe(true);
  });

  it("lists inherited candidates tagged with their origin when nothing matches anywhere", async () => {
    const { conn } = fakeConn(FAMILY);
    const err = await caught(() => readMethod(conn, CHILD, CHILD_SRC, "GET_COLUMN", { inherited: true }));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toMatch(/neither does anything it inherits from or implements/);
    expect(err.details.available).toEqual(["OWN_METHOD", "ZIF_AS_THING~DO_IT"]);
    const inherited = err.details.availableInherited as string[];
    // Prefix match first; a superclass's PRIVATE method is not inherited and is not offered.
    expect(inherited[0]).toBe("GET_COLUMNS (ZCL_AS_PARENT)");
    expect(inherited).toContain("HELPER (ZCL_AS_PARENT)");
    expect(inherited).toContain("ROOT_METHOD (ZCL_AS_GRAND)");
    expect(inherited).toContain("DO_OTHER (ZIF_AS_THING)");
    expect(inherited.join(" ")).not.toContain("SECRET");
    expect(err.details.availableInheritedTotal).toBe(inherited.length);
    expect(err.hint ?? "").toMatch(/availableInherited/);
  });

  it("reports a parent it cannot read instead of failing the whole lookup", async () => {
    const { conn } = fakeConn({
      [CHILD_URI]: FAMILY[CHILD_URI]!,
      [INTF_URI]: FAMILY[INTF_URI]!,
      // ZCL_AS_PARENT is missing: a superclass in a package this user cannot see.
    });
    const err = await caught(() => readMethod(conn, CHILD, CHILD_SRC, "GET_COLUMNS", { inherited: true }));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.details.unresolved).toEqual([
      expect.objectContaining({ name: "ZCL_AS_PARENT", relation: "superclass", via: "ZCL_AS_CHILD" }),
    ]);
    // The interface was still walked.
    expect(err.details.availableInherited).toContain("DO_OTHER (ZIF_AS_THING)");
  });
});

describe("inheritedMembers / renderInheritedOutline (#146 outline section)", () => {
  it("collects public and protected members per defining object, nearest first, skipping what the class has", async () => {
    const { conn } = fakeConn(FAMILY);
    const own = (await classMembersFor(conn, CHILD)).members;
    const r = await inheritedMembers(conn, CHILD, CHILD_SRC, own);
    expect(r.searched).toEqual(["ZCL_AS_PARENT", "ZIF_AS_THING", "ZCL_AS_GRAND"]);
    expect(r.unresolved).toEqual([]);
    expect(r.inherited.map((m) => `${m.name}@${m.on}`)).toEqual([
      "GET_COLUMNS@ZCL_AS_PARENT",
      "HELPER@ZCL_AS_PARENT",
      // DO_IT is implemented by the class itself (ZIF_AS_THING~DO_IT) — not listed.
      "DO_OTHER@ZIF_AS_THING",
      "ROOT_METHOD@ZCL_AS_GRAND",
    ]);
    const text = renderInheritedOutline(r.inherited);
    expect(text).toContain("  from ZCL_AS_PARENT (superclass, depth 1; line numbers are ZCL_AS_PARENT's):");
    expect(text).toContain("    GET_COLUMNS  [public]  lines 11-13");
    expect(text).toContain("    HELPER  [protected]  lines 14-15");
    expect(text).toContain("  from ZIF_AS_THING (interface, depth 1; line numbers are ZIF_AS_THING's):");
    expect(text).toContain("  from ZCL_AS_GRAND (superclass, depth 2;");
    expect(text).not.toContain("SECRET");
  });

  it("costs nothing for a class that names no parent", async () => {
    const { conn, calls } = fakeConn(FAMILY);
    const grand = objectOf("CLAS/OC", "ZCL_AS_GRAND");
    const r = await inheritedMembers(conn, grand, GRAND_SRC, []);
    expect(r.inherited).toEqual([]);
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scanners
// ---------------------------------------------------------------------------

describe("parseClassParents", () => {
  it("reads INHERITING FROM and every INTERFACES statement of the global definition only", () => {
    expect(parseClassParents(CHILD_SRC)).toEqual({ superclass: "ZCL_AS_PARENT", interfaces: ["ZIF_AS_THING"] });
    expect(parseClassParents(GRAND_SRC)).toEqual({ interfaces: [] });
    expect(parseClassParents(INTF_SRC)).toEqual({ interfaces: [] });
  });

  it("unchains INTERFACES: a, b and ignores comments, DEFERRED/LOAD and local classes", () => {
    const src = [
      'CLASS zcl_x DEFINITION DEFERRED.',
      "CLASS zcl_y DEFINITION LOAD.",
      "* INHERITING FROM zcl_commented",
      "CLASS zcl_real DEFINITION PUBLIC INHERITING FROM zcl_base. \" INHERITING FROM zcl_trailing",
      "  PUBLIC SECTION.",
      "    INTERFACES: zif_a, zif_b ALL METHODS FINAL.",
      "    INTERFACES zif_c.",
      "ENDCLASS.",
      "CLASS lcl_local DEFINITION INHERITING FROM zcl_other.",
      "  PUBLIC SECTION. INTERFACES zif_local.",
      "ENDCLASS.",
    ].join("\n");
    expect(parseClassParents(src)).toEqual({ superclass: "ZCL_BASE", interfaces: ["ZIF_A", "ZIF_B", "ZIF_C"] });
  });

  it("reads an interface's component interfaces", () => {
    const src = "INTERFACE zif_child PUBLIC.\n  INTERFACES zif_base.\n  METHODS m.\nENDINTERFACE.";
    expect(parseClassParents(src)).toEqual({ interfaces: ["ZIF_BASE"] });
  });
});

describe("findMethodDeclaration", () => {
  it("returns a multi-line declaration (outer indentation trimmed) and unchains METHODS: a, b", () => {
    expect(findMethodDeclaration(PARENT_SRC, "get_columns")).toBe(
      "METHODS get_columns\n      RETURNING VALUE(rt_columns) TYPE string_table.",
    );
    const chained = "CLASS z DEFINITION.\n  PUBLIC SECTION.\n    METHODS: alpha IMPORTING iv TYPE i,\n      beta,\n      gamma RETURNING VALUE(rv) TYPE string.\nENDCLASS.";
    expect(findMethodDeclaration(chained, "BETA")).toBe("METHODS beta.");
    expect(findMethodDeclaration(chained, "gamma")).toBe("METHODS gamma RETURNING VALUE(rv) TYPE string.");
    expect(findMethodDeclaration(chained, "ALPHA")).toBe("METHODS alpha IMPORTING iv TYPE i.");
  });

  it("handles CLASS-METHODS, is not fooled by comments or literals, and answers undefined when absent", () => {
    const src = [
      "CLASS z DEFINITION.",
      "  PUBLIC SECTION.",
      '    CONSTANTS c TYPE string VALUE `METHODS fake.`.',
      "*   METHODS commented.",
      "    CLASS-METHODS create RETURNING VALUE(ro) TYPE REF TO z. \" METHODS trailing.",
      "ENDCLASS.",
    ].join("\n");
    expect(findMethodDeclaration(src, "create")).toBe("CLASS-METHODS create RETURNING VALUE(ro) TYPE REF TO z.");
    expect(findMethodDeclaration(src, "fake")).toBeUndefined();
    expect(findMethodDeclaration(src, "commented")).toBeUndefined();
    expect(findMethodDeclaration(src, "trailing")).toBeUndefined();
  });
});

describe("abapStatements", () => {
  it("splits on periods outside comments and literals and keeps line numbers", () => {
    const src = ["DATA a TYPE string. \" c.", "a = 'x. y'.", "* whole line.", "b = 1", "  + 2."].join("\n");
    const st = abapStatements(src);
    expect(st.map((s) => [s.text.trim(), s.startLine, s.endLine])).toEqual([
      ["DATA a TYPE string", 1, 1],
      ["a = 'x. y'", 2, 2],
      ["b = 1\n  + 2", 4, 5],
    ]);
    expect(st[1]!.code).not.toContain("x. y");
  });
});

describe("rankCandidates / availableMembersMax (#146 item 4)", () => {
  afterEach(() => {
    delete process.env.ABAP_AVAILABLE_MEMBERS_MAX;
  });

  it("puts names sharing the longest prefix with the request first, then the closest edit distance", () => {
    const names = ["ZZZ", "GET_COLUMN_X", "GET_COLUMNS", "GET_ROWS", "SET_COLUMNS", "GET_COLUMNS_TABLE"];
    expect(rankCandidates(names, "get_columns")).toEqual([
      "GET_COLUMNS",
      "GET_COLUMNS_TABLE",
      "GET_COLUMN_X",
      "GET_ROWS",
      "SET_COLUMNS",
      "ZZZ",
    ]);
  });

  it("defaults to 40 and reads ABAP_AVAILABLE_MEMBERS_MAX when it is a positive integer", () => {
    expect(AVAILABLE_MEMBERS_MAX_DEFAULT).toBe(40);
    expect(availableMembersMax()).toBe(40);
    process.env.ABAP_AVAILABLE_MEMBERS_MAX = "7";
    expect(availableMembersMax()).toBe(7);
    process.env.ABAP_AVAILABLE_MEMBERS_MAX = "0";
    expect(availableMembersMax()).toBe(40);
    process.env.ABAP_AVAILABLE_MEMBERS_MAX = "lots";
    expect(availableMembersMax()).toBe(40);
  });

  it("the env cap governs readMethod's list and prefix-sharing names survive the cut", async () => {
    process.env.ABAP_AVAILABLE_MEMBERS_MAX = "3";
    const comps: Comp[] = [
      ...Array.from({ length: 30 }, (_, i) => ({ name: `FILLER_${String(i).padStart(2, "0")}`, type: "CLAS/OM" })),
      { name: "GET_COLUMNS_TABLE", type: "CLAS/OM" },
      { name: "GET_COLUMNS", type: "CLAS/OM" },
    ];
    const { conn } = fakeConn({ [CHILD_URI]: { source: CHILD_SRC, active: comps } });
    const err = await caught(() => readMethod(conn, CHILD, CHILD_SRC, "GET_COLUMN"));
    expect(err.details.available).toEqual(["GET_COLUMNS", "GET_COLUMNS_TABLE", "FILLER_00"]);
    expect(err.details.availableTruncated).toBe(29);
    expect(err.message).toMatch(/listing 3 of 32/);
  });
});

// ---------------------------------------------------------------------------
// #147 item 3 — the offending line and its neighbours, from the sent bytes
// ---------------------------------------------------------------------------

describe("withSourceContext", () => {
  const SRC = ["REPORT z.", "DATA a TYPE i.", "a = 1", "WRITE a.", "x".repeat(400)].join("\n");

  it("attaches the reported line and one line of context each side", () => {
    const [m] = withSourceContext([{ severity: "E", text: "period missing", line: 3, col: 5 }], SRC);
    expect(m).toEqual({
      severity: "E",
      text: "period missing",
      line: 3,
      col: 5,
      sourceLine: "a = 1",
      before: { line: 2, text: "DATA a TYPE i." },
      after: { line: 4, text: "WRITE a." },
    });
  });

  it("omits a neighbour that does not exist and trims long lines to 200 characters", () => {
    const [first, last] = withSourceContext(
      [
        { severity: "E", text: "x", line: 1 },
        { severity: "E", text: "y", line: 5 },
      ],
      SRC,
    );
    expect(first!.before).toBeUndefined();
    expect(first!.after).toEqual({ line: 2, text: "DATA a TYPE i." });
    expect(last!.after).toBeUndefined();
    expect(last!.sourceLine!.length).toBeLessThanOrEqual(200 + 32);
    expect(last!.sourceLine!.startsWith("x".repeat(150))).toBe(true);
    expect(last!.sourceLine).not.toBe("x".repeat(400));
  });

  it("leaves unpositioned or out-of-range messages untouched", () => {
    const r = withSourceContext(
      [
        { severity: "E", text: "no line" },
        { severity: "E", text: "beyond", line: 99 },
      ],
      SRC,
    );
    expect(r).toEqual([
      { severity: "E", text: "no line" },
      { severity: "E", text: "beyond", line: 99 },
    ]);
  });
});
