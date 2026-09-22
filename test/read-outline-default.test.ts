/**
 * Issue #148 item 1: a CLAS/INTF/PROG/FUGR source read above the size
 * threshold (OUTLINE_DEFAULT_LINES lines or OUTLINE_DEFAULT_CHARS chars)
 * answers with the outline by default; anything narrower (method/include/
 * offset/limit/pattern) or wider (full=true, outline=false) still gets the
 * source. Offline: resolveObject, the source readers and the component lookup
 * (classMembersFor / inheritedMembers, issues #146/#147) are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import type { ClassMember } from "../src/adt/source.js";

const stub = {
  object: {} as ResolvedObject,
  source: "",
  members: [] as ClassMember[],
  classMembersCalls: 0,
};

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => stub.object,
}));

vi.mock("../src/adt/source.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/source.js")>()),
  readSource: async () => ({ source: stub.source, serverEtag: '"W/etag"' }),
  classMembers: async () => {
    stub.classMembersCalls += 1;
    return stub.members;
  },
  classMembersFor: async () => {
    stub.classMembersCalls += 1;
    return { members: stub.members, version: "active" };
  },
  inheritedMembers: async () => ({ inherited: [], unresolved: [], searched: [] }),
  readMethod: async () => {
    throw new Error("readMethod must not be called by these tests");
  },
}));

const { abapRead, OUTLINE_DEFAULT_CHARS, OUTLINE_DEFAULT_LINES } = await import("../src/tools/read.js");

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

/** `n` short lines — over the LINE bound, under the CHAR bound. */
const lines = (n: number): string => Array.from({ length: n }, (_, i) => `  line ${i + 1}.`).join("\n");

const MEMBERS: ClassMember[] = [
  { name: "CONSTRUCTOR", type: "CLAS/OM", visibility: "public", implementation: { startLine: 20, endLine: 40 } },
  { name: "RUN", type: "CLAS/OM", visibility: "public", implementation: { startLine: 41, endLine: 190 } },
] as unknown as ClassMember[];

beforeEach(() => {
  stub.object = resolved();
  stub.source = "";
  stub.members = MEMBERS;
  stub.classMembersCalls = 0;
});

describe("abap_read defaults to the outline above the size threshold", () => {
  it("a class over the line bound gets OUTLINE, not SOURCE, and says how to get parts", async () => {
    stub.source = lines(OUTLINE_DEFAULT_LINES + 1);
    const r = await abapRead(conn, { object: "ZCL_BIG" }, 47_100);
    expect(r.text).toContain("--- OUTLINE ---");
    expect(r.text).not.toContain("--- SOURCE ---");
    expect(r.text).toMatch(/^outline: default \(large source\)$/m);
    expect(r.text).toMatch(new RegExp(`^totalLines: ${OUTLINE_DEFAULT_LINES + 1}$`, "m"));
    expect(r.text).toMatch(/^totalChars: \d+$/m);
    // The note states the full line count and every way to get parts.
    expect(r.text).toMatch(new RegExp(`NOTE: CLAS/OC ZCL_BIG is ${OUTLINE_DEFAULT_LINES + 1} lines / \\d+ chars`));
    expect(r.text).toContain('method="<NAME>"');
    expect(r.text).toContain('pattern="<regex>"');
    expect(r.text).toContain("offset/limit");
    expect(r.text).toContain("full=true");
    expect(r.text).toContain("  RUN  [public]  lines 41-190");
    expect(stub.classMembersCalls).toBe(1);
    // Not a partial read: nothing was cut from a text the caller asked for.
    expect(r.etag.startsWith("partial:")).toBe(false);
  });

  it("a class over the CHAR bound but under the line bound also gets the outline", async () => {
    stub.source = Array.from({ length: 40 }, () => "x".repeat(300)).join("\n");
    expect(stub.source.length).toBeGreaterThan(OUTLINE_DEFAULT_CHARS);
    const r = await abapRead(conn, { object: "ZCL_BIG" }, 47_100);
    expect(r.text).toContain("--- OUTLINE ---");
    expect(r.text).toContain(`${OUTLINE_DEFAULT_CHARS} chars`);
  });

  it("a class at or under both bounds gets the source, untouched", async () => {
    stub.source = lines(OUTLINE_DEFAULT_LINES);
    const r = await abapRead(conn, { object: "ZCL_BIG" }, 47_100);
    expect(r.text).toContain("--- SOURCE ---");
    expect(r.text).not.toContain("--- OUTLINE ---");
    expect(r.text).toContain("  line 150.");
    expect(stub.classMembersCalls).toBe(0);
  });

  it.each([
    ["full=true", { full: true }],
    ["outline=false", { outline: false }],
    ["offset=", { offset: 100 }],
    ["limit=", { limit: 20 }],
  ])("%s on a large class still reads the source", async (_label, extra) => {
    stub.source = lines(OUTLINE_DEFAULT_LINES + 50);
    const r = await abapRead(conn, { object: "ZCL_BIG", ...extra }, 47_100);
    expect(r.text).toContain("--- SOURCE ---");
    expect(r.text).not.toMatch(/^outline:/m);
    expect(stub.classMembersCalls).toBe(0);
  });

  it("include= on a large class reads that include's source, not the outline", async () => {
    stub.source = lines(OUTLINE_DEFAULT_LINES + 50);
    const r = await abapRead(conn, { object: "ZCL_BIG", include: "testclasses" }, 47_100);
    expect(r.text).toContain("--- SOURCE ---");
    expect(r.text).toMatch(/^include: testclasses$/m);
  });

  it("an interface gets the ADT outline by default too", async () => {
    stub.object = resolved({ type: "INTF/OI", kind: "INTF", name: "ZIF_BIG" });
    stub.source = lines(OUTLINE_DEFAULT_LINES + 1);
    const r = await abapRead(conn, { object: "ZIF_BIG" }, 47_100);
    expect(r.text).toContain("--- OUTLINE ---");
    expect(r.text).toContain("NOTE: INTF/OI ZIF_BIG is");
  });

  it("a kind outside CLAS/INTF/PROG/FUGR keeps returning the source however large", async () => {
    stub.object = resolved({ type: "DDLS/DF", kind: "DDLS", name: "ZI_BIG" });
    stub.source = lines(OUTLINE_DEFAULT_LINES + 200);
    const r = await abapRead(conn, { object: "ZI_BIG" }, 47_100);
    expect(r.text).toContain("--- SOURCE ---");
    expect(r.text).not.toContain("--- OUTLINE ---");
  });
});

describe("abap_read outline for programs and function groups is a statement scan", () => {
  const PROG = [
    "REPORT zreport.",
    "INCLUDE zreport_top.",
    "DATA lv_x TYPE i.",
    "INITIALIZATION.",
    "  lv_x = 1.",
    "START-OF-SELECTION.",
    "  PERFORM get_data.",
    "FORM get_data.",
    ...Array.from({ length: 160 }, (_, i) => `  WRITE ${i}.`),
    "ENDFORM.",
    "* FORM in_a_comment.",
    "CLASS lcl_helper DEFINITION.",
    "  PUBLIC SECTION.",
    "    METHODS run.",
    "ENDCLASS.",
    "CLASS lcl_helper IMPLEMENTATION.",
    "  METHOD run.",
    "  ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n");

  it("a large PROG gets a table of contents by default, disclosed as a text scan", async () => {
    stub.object = resolved({ type: "PROG/P", kind: "PROG", name: "ZREPORT" });
    stub.source = PROG;
    const r = await abapRead(conn, { object: "ZREPORT" }, 47_100);
    expect(r.text).toContain("--- OUTLINE ---");
    expect(r.text).toMatch(/^outline: default \(large source\)$/m);
    expect(r.text).toContain("  REPORT ZREPORT  line 1");
    expect(r.text).toContain("  INCLUDE ZREPORT_TOP  line 2");
    expect(r.text).toContain("  INITIALIZATION  line 4");
    expect(r.text).toContain("  START-OF-SELECTION  line 6");
    expect(r.text).toContain("  FORM GET_DATA  lines 8-169");
    expect(r.text).toContain("  CLASS DEFINITION LCL_HELPER  lines 171-174");
    expect(r.text).toContain("  CLASS IMPLEMENTATION LCL_HELPER  lines 175-178");
    expect(r.text).toContain("    METHOD RUN  lines 176-177");
    expect(r.text).not.toContain("IN_A_COMMENT");
    expect(r.text).toMatch(/text scan of statement-initial keywords/);
    expect(r.text).not.toContain("NOT SUPPORTED");
    expect(r.text).not.toContain("(no components)");
    expect(stub.classMembersCalls).toBe(0);
  });

  it("explicit outline=true on a small PROG gives the same scan", async () => {
    stub.object = resolved({ type: "PROG/P", kind: "PROG", name: "ZSMALL" });
    stub.source = "REPORT zsmall.\nSTART-OF-SELECTION.\n  WRITE 1.";
    const r = await abapRead(conn, { object: "ZSMALL", outline: true }, 47_100);
    expect(r.text).toMatch(/^outline: requested$/m);
    expect(r.text).toContain("  START-OF-SELECTION  line 2");
  });

  it("a function group include gets FUNCTION/ENDFUNCTION ranges", async () => {
    stub.object = resolved({ type: "FUGR/FF", kind: "FUGR", name: "Z_GET_DATA" });
    stub.source = ["FUNCTION z_get_data.", ...Array.from({ length: 200 }, () => "  \" work"), "ENDFUNCTION."].join("\n");
    const r = await abapRead(conn, { object: "Z_GET_DATA" }, 47_100);
    expect(r.text).toContain("--- OUTLINE ---");
    expect(r.text).toContain("  FUNCTION Z_GET_DATA  lines 1-202");
  });

  it("a scan with no structure statements says so without claiming 'no components'", async () => {
    stub.object = resolved({ type: "PROG/I", kind: "PROG", name: "ZTOP" });
    stub.source = Array.from({ length: 200 }, (_, i) => `DATA lv_${i} TYPE i.`).join("\n");
    const r = await abapRead(conn, { object: "ZTOP" }, 47_100);
    expect(r.text).toContain("--- OUTLINE ---");
    expect(r.text).toMatch(/NOT a statement that the program has no components/);
    expect(r.text).not.toContain("(no components)");
  });
});

describe("full=true contradictions are refused before any read", () => {
  it.each([
    ["outline=true", { outline: true }],
    ["method", { method: "RUN" }],
    ["pattern", { pattern: "x" }],
  ])("full=true with %s is BAD_INPUT", async (_label, extra) => {
    await expect(abapRead(conn, { object: "ZCL_BIG", full: true, ...extra }, 47_100)).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
  });
});
