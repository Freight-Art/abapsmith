/**
 * Tests for `src/adt/img-resolve.ts` — the pure activity/object/table join
 * over an `ImgTranscript`. No connection, no bridge, no tool layer: fixtures
 * here are `ImgTranscript` object literals built directly, since `img-read.ts`
 * (unlike the withdrawn `img-bridge.ts`) has no line-based transcript format
 * to parse — a transcript is just the typed rows a read call assembled.
 */
import { describe, expect, it } from "vitest";

import type { ImgTranscript } from "../src/adt/img-read.js";
import { parseDeliveryClass, resolveActivity, resolveObject } from "../src/adt/img-resolve.js";

/** Every field defaulted to "nothing found"; each test overrides only the rows it needs. */
function blankTranscript(overrides: Partial<ImgTranscript> = {}): ImgTranscript {
  return {
    totalRows: null,
    page: null,
    treeId: null,
    activities: [],
    path: [],
    nodes: [],
    objects: [],
    tables: [],
    fields: [],
    docs: [],
    notes: [],
    errors: [],
    raw: "",
    ...overrides,
  };
}

describe("parseDeliveryClass", () => {
  it("recognises every real SAP delivery class letter", () => {
    for (const c of ["A", "C", "E", "G", "L", "S", "W"]) {
      expect(parseDeliveryClass(c)).toBe(c);
    }
  });

  it("maps an unrecognised letter to 'unknown' rather than a plausible-looking default", () => {
    expect(parseDeliveryClass("Z")).toBe("unknown");
  });

  it("maps an empty string to 'unknown'", () => {
    expect(parseDeliveryClass("")).toBe("unknown");
  });

  it("is tolerant of stray whitespace and case", () => {
    expect(parseDeliveryClass(" a ")).toBe("A");
  });
});

describe("resolveActivity", () => {
  it("returns an empty-but-valid value for an empty transcript, never throwing", () => {
    const t = blankTranscript();
    const r = resolveActivity(t);
    expect(r.activity).toBe("");
    expect(r.title).toBe("");
    expect(r.path).toEqual([]);
    expect(r.objects).toEqual([]);
    expect(r.doc).toBeUndefined();
    expect(r.primary).toBeUndefined();
    expect(r.primaryTable).toBeUndefined();
    expect(r.ambiguity).toBeUndefined();
  });

  it("sorts path steps by position regardless of row order", () => {
    const t = blankTranscript({
      activities: [{ activity: "SIMG_ACT", title: "Activity", objects: 1, nodes: 1 }],
      path: [
        { activity: "SIMG_ACT", position: 2, node: "N2", title: "Second" },
        { activity: "SIMG_ACT", position: 1, node: "N1", title: "First" },
        { activity: "SIMG_ACT", position: 3, node: "N3", title: "Third" },
      ],
      objects: [{ kind: "table", objectType: "", name: "T001", title: "Company Codes" }],
      tables: [
        {
          object: "T001",
          table: "T001",
          clientDependent: true,
          deliveryClass: "A",
          via: "OBJSL",
          title: "Company Codes",
        },
      ],
    });
    const r = resolveActivity(t);
    expect(r.path.map((p) => p.node)).toEqual(["N1", "N2", "N3"]);
    expect(r.path.map((p) => p.title)).toEqual(["First", "Second", "Third"]);
  });

  it("joins fields onto their table, ordered by position, with keyFields as the key=true subset", () => {
    const t = blankTranscript({
      activities: [{ activity: "SIMG_ACT", title: "Activity", objects: 1, nodes: 0 }],
      objects: [{ kind: "table", objectType: "", name: "T001", title: "Company Codes" }],
      tables: [
        {
          object: "T001",
          table: "T001",
          clientDependent: true,
          deliveryClass: "A",
          via: "OBJSL",
          title: "Company Codes",
        },
      ],
      fields: [
        { table: "T001", field: "BUKRS", key: true, position: 1, dataType: "CHAR", length: "4", dataElement: "BUKRS" },
        { table: "T001", field: "MANDT", key: true, position: 0, dataType: "CLNT", length: "3", dataElement: "MANDT" },
        { table: "T001", field: "BUTXT", key: false, position: 2, dataType: "CHAR", length: "25", dataElement: "BUTXT" },
      ],
    });
    const r = resolveActivity(t);
    const table = r.primaryTable;
    expect(table).toBeDefined();
    expect(table!.fields.map((f) => f.field)).toEqual(["MANDT", "BUKRS", "BUTXT"]);
    expect(table!.keyFields.map((f) => f.field)).toEqual(["MANDT", "BUKRS"]);
    expect(table!.clientDependent).toBe(true);
    expect(table!.deliveryClass).toBe("A");
  });

  it("sets primary when exactly one object resolves, and primaryTable when that object has exactly one table", () => {
    const t = blankTranscript({
      activities: [{ activity: "SIMG_ACT", title: "Activity", objects: 1, nodes: 0 }],
      objects: [{ kind: "table", objectType: "", name: "T001", title: "Company Codes" }],
      tables: [
        {
          object: "T001",
          table: "T001",
          clientDependent: true,
          deliveryClass: "A",
          via: "OBJSL",
          title: "Company Codes",
        },
      ],
    });
    const r = resolveActivity(t);
    expect(r.primary?.name).toBe("T001");
    expect(r.primaryTable?.table).toBe("T001");
    expect(r.ambiguity).toBeUndefined();
  });

  it("leaves primary unset and names the candidates in ambiguity when an activity has several objects", () => {
    const t = blankTranscript({
      activities: [{ activity: "SIMG_ACT", title: "Activity", objects: 2, nodes: 0 }],
      objects: [
        { kind: "view", objectType: "", name: "V_T001", title: "Company Codes View" },
        { kind: "table", objectType: "", name: "T001", title: "Company Codes" },
      ],
    });
    const r = resolveActivity(t);
    expect(r.primary).toBeUndefined();
    expect(r.primaryTable).toBeUndefined();
    expect(r.ambiguity).toBeDefined();
    expect(r.ambiguity).toContain("V_T001");
    expect(r.ambiguity).toContain("T001");
    expect(r.objects.map((o) => o.name)).toEqual(["V_T001", "T001"]);
  });

  it("leaves primaryTable unset and names the candidates in ambiguity when the one object spans several tables", () => {
    const t = blankTranscript({
      activities: [{ activity: "SIMG_ACT", title: "Activity", objects: 1, nodes: 0 }],
      objects: [{ kind: "view", objectType: "", name: "V_FOO", title: "Foo View" }],
      tables: [
        { object: "V_FOO", table: "T001", clientDependent: true, deliveryClass: "A", via: "DD26S", title: "" },
        { object: "V_FOO", table: "T002", clientDependent: false, deliveryClass: "C", via: "DD26S", title: "" },
      ],
    });
    const r = resolveActivity(t);
    expect(r.primary?.name).toBe("V_FOO");
    expect(r.primaryTable).toBeUndefined();
    expect(r.ambiguity).toBeDefined();
    expect(r.ambiguity).toContain("T001");
    expect(r.ambiguity).toContain("T002");
  });

  it("attaches the activity's documentation reference when a doc row is present", () => {
    const t = blankTranscript({
      activities: [{ activity: "SIMG_ACT", title: "Activity", objects: 0, nodes: 0 }],
      docs: [{ activity: "SIMG_ACT", docId: "SIMG_ACT_DOC" }],
    });
    const r = resolveActivity(t);
    expect(r.doc).toEqual({ docId: "SIMG_ACT_DOC" });
  });
});

describe("resolveObject", () => {
  it("returns undefined for an empty transcript rather than throwing", () => {
    const t = blankTranscript();
    expect(resolveObject(t)).toBeUndefined();
  });

  it("joins the one object's tables and fields", () => {
    const t = blankTranscript({
      objects: [{ kind: "customizing_object", objectType: "V", name: "ZFOO", title: "Foo" }],
      tables: [
        { object: "ZFOO", table: "ZFOO_T", clientDependent: true, deliveryClass: "C", via: "OBJSL", title: "Foo Table" },
      ],
      fields: [
        { table: "ZFOO_T", field: "MANDT", key: true, position: 0, dataType: "CLNT", length: "3", dataElement: "MANDT" },
        { table: "ZFOO_T", field: "ID", key: true, position: 1, dataType: "CHAR", length: "10", dataElement: "ZFOO_ID" },
      ],
    });
    const o = resolveObject(t);
    expect(o?.name).toBe("ZFOO");
    expect(o?.objectType).toBe("V");
    expect(o?.tables).toHaveLength(1);
    expect(o?.tables[0]?.deliveryClass).toBe("C");
    expect(o?.tables[0]?.keyFields.map((f) => f.field)).toEqual(["MANDT", "ID"]);
  });
});
