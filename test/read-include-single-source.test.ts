/**
 * Issue #211: `include=` used to be refused outright for anything that is
 * not a class ("has no "definitions" include — class includes exist only
 * for classes"). A non-class object has exactly one source document, so
 * there is nothing for `include` to select — it is now a no-op, disclosed
 * with a note, rather than a refusal. The refusal survives only where the
 * OBJECT REFERENCE itself already named a (different) include.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import type { ClassMember, ClassInclude, MethodSource } from "../src/adt/source.js";

const stub = {
  object: {} as ResolvedObject,
  source: "",
  members: [] as ClassMember[],
  method: undefined as MethodSource | undefined,
  readSourceInclude: undefined as ClassInclude | undefined,
};

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => stub.object,
}));

vi.mock("../src/adt/source.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/source.js")>()),
  readSource: async (_conn: unknown, _obj: unknown, include: ClassInclude | undefined) => {
    stub.readSourceInclude = include;
    return { source: stub.source, serverEtag: '"W/etag"', sourceUri: "/whatever" };
  },
  classMembers: async () => stub.members,
  classMembersFor: async () => ({ members: stub.members, version: "active" }),
  inheritedMembers: async () => ({ inherited: [], unresolved: [], searched: [] }),
  readMethod: async () => {
    if (!stub.method) throw new Error("stub.method not set");
    return stub.method;
  },
}));

const { abapRead } = await import("../src/tools/read.js");

function resolved(over: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "CLAS/OC",
    kind: "CLAS",
    label: "class",
    name: "ZCL_BIG",
    uri: "/sap/bc/adt/oo/classes/zcl_big",
    mode: "source",
    activation: "unknown",
    spec: {},
    ...over,
  } as unknown as ResolvedObject;
}

const conn = { cfg: { sid: "A4H" } } as unknown as AbapConnection;

beforeEach(() => {
  stub.object = resolved();
  stub.source = "  METHOD run.\n  ENDMETHOD.";
  stub.members = [];
  stub.method = undefined;
  stub.readSourceInclude = undefined;
});

const IGNORED_NOTE = "this object has a single source document; include ignored";

describe("abap_read: include is a no-op for non-class objects (issue #211)", () => {
  it('INTF/OI with include=definitions returns the interface source with the ignored-include note', async () => {
    stub.object = resolved({
      type: "INTF/OI",
      kind: "INTF",
      label: "interface",
      name: "ZIF_ACTION",
      uri: "/sap/bc/adt/oo/interfaces/zif_action",
    });
    stub.source = "  METHODS execute.";
    const r = await abapRead(conn, { object: "ZIF_ACTION", include: "definitions" }, 47_100);
    expect(r.text).toContain("--- SOURCE ---");
    expect(r.text).toContain("METHODS execute");
    expect(r.text).toContain(IGNORED_NOTE);
    expect(r.text).not.toMatch(/^include:/m);
    expect(stub.readSourceInclude).toBeUndefined();
  });

  it("FUGR/FF with include=definitions returns the function module source with the note", async () => {
    stub.object = resolved({
      type: "FUGR/FF",
      kind: "FUGR",
      label: "function module",
      name: "Z_XX_SAVE",
      uri: "/sap/bc/adt/functions/groups/zxx/fmodules/z_xx_save",
    });
    stub.source = "FUNCTION z_xx_save.\nENDFUNCTION.";
    const r = await abapRead(conn, { object: "Z_XX_SAVE", include: "definitions" }, 47_100);
    expect(r.text).toContain("--- SOURCE ---");
    expect(r.text).toContain("FUNCTION z_xx_save");
    expect(r.text).toContain(IGNORED_NOTE);
    expect(r.text).not.toMatch(/^include:/m);
    expect(stub.readSourceInclude).toBeUndefined();
  });

  it("INTF/OI with method=EXECUTE and include=definitions returns the method declaration", async () => {
    stub.object = resolved({
      type: "INTF/OI",
      kind: "INTF",
      label: "interface",
      name: "ZIF_ACTION",
      uri: "/sap/bc/adt/oo/interfaces/zif_action",
    });
    stub.source = "  METHODS execute\n    IMPORTING iv_x TYPE i.";
    stub.method = {
      member: { name: "EXECUTE", type: "INTF/OM", visibility: "public" },
      declaration: "  METHODS execute\n    IMPORTING iv_x TYPE i.",
      implementation: "",
      version: "active",
      searched: ["ZIF_ACTION"],
    };
    const r = await abapRead(conn, { object: "ZIF_ACTION", method: "EXECUTE", include: "definitions" }, 47_100);
    expect(r.text).toContain("METHODS execute");
    expect(r.text).toMatch(/^method: EXECUTE$/m);
    expect(r.text).toContain(IGNORED_NOTE);
    expect(r.text).not.toContain('include="definitions" with method= returns the declaration only');
  });

  it("PROG/P with include=testclasses returns the program source with the note, not an error", async () => {
    stub.object = resolved({
      type: "PROG/P",
      kind: "PROG",
      label: "program",
      name: "ZDEMO",
      uri: "/sap/bc/adt/programs/programs/zdemo",
    });
    stub.source = "REPORT zdemo.\nWRITE 'hi'.";
    const r = await abapRead(conn, { object: "ZDEMO", include: "testclasses" }, 47_100);
    expect(r.text).toContain("--- SOURCE ---");
    expect(r.text).toContain("REPORT zdemo");
    expect(r.text).toContain(IGNORED_NOTE);
    expect(r.text).not.toMatch(/^include:/m);
    expect(stub.readSourceInclude).toBeUndefined();
  });

  it("CLAS/OC with include=definitions is unchanged: the definitions include is read and no ignored note appears", async () => {
    stub.object = resolved();
    stub.source = "  DATA lv_x TYPE i.";
    const r = await abapRead(conn, { object: "ZCL_BIG", include: "definitions" }, 47_100);
    expect(stub.readSourceInclude).toBe("definitions");
    expect(r.text).toMatch(/^include: definitions$/m);
    expect(r.text).not.toContain("include ignored");
  });

  it("a non-class whose object reference itself named an include is still refused", async () => {
    stub.object = resolved({
      type: "PROG/P",
      kind: "PROG",
      label: "program",
      name: "ZDEMO",
      uri: "/sap/bc/adt/programs/programs/zdemo",
      include: "testclasses",
    });
    await expect(abapRead(conn, { object: "ZDEMO", include: "testclasses" }, 47_100)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});
