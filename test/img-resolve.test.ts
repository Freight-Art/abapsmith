/**
 * Tests for `src/adt/img-resolve.ts` — the pure activity/object/table join
 * over a parsed `ImgTranscript`. No connection, no bridge, no tool layer:
 * transcripts here are built directly from `IMG_LINE_PREFIX` lines and fed
 * through `parseImgTranscript`, exactly like `img-bridge.test.ts` does.
 */
import { describe, expect, it } from "vitest";

import { IMG_LINE_PREFIX, parseImgTranscript } from "../src/adt/img-bridge.js";
import { parseDeliveryClass, resolveActivity, resolveObject } from "../src/adt/img-resolve.js";

function lines(...rows: string[]): string {
  return rows.map((r) => `${IMG_LINE_PREFIX}${r}`).join("\n");
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
    const t = parseImgTranscript("");
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

  it("sorts path steps by APATH position regardless of line order", () => {
    const t = parseImgTranscript(
      lines(
        "ACT activity=[SIMG_ACT] objects=[1] nodes=[1] title=[Activity]",
        "APATH activity=[SIMG_ACT] pos=[2] node=[N2] title=[Second]",
        "APATH activity=[SIMG_ACT] pos=[1] node=[N1] title=[First]",
        "APATH activity=[SIMG_ACT] pos=[3] node=[N3] title=[Third]",
        "OBJ activity=[SIMG_ACT] kind=[table] objtype=[] name=[T001] title=[Company Codes]",
        "TAB object=[T001] table=[T001] clidep=[X] delclass=[A] via=[OBJSL] title=[Company Codes]",
      ),
    );
    const r = resolveActivity(t);
    expect(r.path.map((p) => p.node)).toEqual(["N1", "N2", "N3"]);
    expect(r.path.map((p) => p.title)).toEqual(["First", "Second", "Third"]);
  });

  it("joins fields onto their table, ordered by position, with keyFields as the KEYFLAG=X subset", () => {
    const t = parseImgTranscript(
      lines(
        "ACT activity=[SIMG_ACT] objects=[1] nodes=[0] title=[Activity]",
        "OBJ activity=[SIMG_ACT] kind=[table] objtype=[] name=[T001] title=[Company Codes]",
        "TAB object=[T001] table=[T001] clidep=[X] delclass=[A] via=[OBJSL] title=[Company Codes]",
        "FLD table=[T001] field=[BUKRS] pos=[1] key=[X] type=[CHAR] len=[4] rollname=[BUKRS]",
        "FLD table=[T001] field=[MANDT] pos=[0] key=[X] type=[CLNT] len=[3] rollname=[MANDT]",
        "FLD table=[T001] field=[BUTXT] pos=[2] key=[] type=[CHAR] len=[25] rollname=[BUTXT]",
      ),
    );
    const r = resolveActivity(t);
    const table = r.primaryTable;
    expect(table).toBeDefined();
    expect(table!.fields.map((f) => f.field)).toEqual(["MANDT", "BUKRS", "BUTXT"]);
    expect(table!.keyFields.map((f) => f.field)).toEqual(["MANDT", "BUKRS"]);
    expect(table!.clientDependent).toBe(true);
    expect(table!.deliveryClass).toBe("A");
  });

  it("sets primary when exactly one object resolves, and primaryTable when that object has exactly one table", () => {
    const t = parseImgTranscript(
      lines(
        "ACT activity=[SIMG_ACT] objects=[1] nodes=[0] title=[Activity]",
        "OBJ activity=[SIMG_ACT] kind=[table] objtype=[] name=[T001] title=[Company Codes]",
        "TAB object=[T001] table=[T001] clidep=[X] delclass=[A] via=[OBJSL] title=[Company Codes]",
      ),
    );
    const r = resolveActivity(t);
    expect(r.primary?.name).toBe("T001");
    expect(r.primaryTable?.table).toBe("T001");
    expect(r.ambiguity).toBeUndefined();
  });

  it("leaves primary unset and names the candidates in ambiguity when an activity has several objects", () => {
    const t = parseImgTranscript(
      lines(
        "ACT activity=[SIMG_ACT] objects=[2] nodes=[0] title=[Activity]",
        "OBJ activity=[SIMG_ACT] kind=[view] objtype=[] name=[V_T001] title=[Company Codes View]",
        "OBJ activity=[SIMG_ACT] kind=[table] objtype=[] name=[T001] title=[Company Codes]",
      ),
    );
    const r = resolveActivity(t);
    expect(r.primary).toBeUndefined();
    expect(r.primaryTable).toBeUndefined();
    expect(r.ambiguity).toBeDefined();
    expect(r.ambiguity).toContain("V_T001");
    expect(r.ambiguity).toContain("T001");
    expect(r.objects.map((o) => o.name)).toEqual(["V_T001", "T001"]);
  });

  it("leaves primaryTable unset and names the candidates in ambiguity when the one object spans several tables", () => {
    const t = parseImgTranscript(
      lines(
        "ACT activity=[SIMG_ACT] objects=[1] nodes=[0] title=[Activity]",
        "OBJ activity=[SIMG_ACT] kind=[view] objtype=[] name=[V_FOO] title=[Foo View]",
        "TAB object=[V_FOO] table=[T001] clidep=[X] delclass=[A] via=[DD26S] title=[]",
        "TAB object=[V_FOO] table=[T002] clidep=[] delclass=[C] via=[DD26S] title=[]",
      ),
    );
    const r = resolveActivity(t);
    expect(r.primary?.name).toBe("V_FOO");
    expect(r.primaryTable).toBeUndefined();
    expect(r.ambiguity).toBeDefined();
    expect(r.ambiguity).toContain("T001");
    expect(r.ambiguity).toContain("T002");
  });

  it("attaches the activity's documentation reference when a DOC line is present", () => {
    const t = parseImgTranscript(
      lines(
        "ACT activity=[SIMG_ACT] objects=[0] nodes=[0] title=[Activity]",
        "DOC activity=[SIMG_ACT] class=[TX] name=[SIMG_ACT_DOC]",
      ),
    );
    const r = resolveActivity(t);
    expect(r.doc).toEqual({ docClass: "TX", docName: "SIMG_ACT_DOC" });
  });
});

describe("resolveObject", () => {
  it("returns undefined for an empty transcript rather than throwing", () => {
    const t = parseImgTranscript("");
    expect(resolveObject(t)).toBeUndefined();
  });

  it("joins the one object's tables and fields", () => {
    const t = parseImgTranscript(
      lines(
        "OBJ activity=[SIMG_ACT] kind=[customizing_object] objtype=[V] name=[ZFOO] title=[Foo]",
        "TAB object=[ZFOO] table=[ZFOO_T] clidep=[X] delclass=[C] via=[OBJSL] title=[Foo Table]",
        "FLD table=[ZFOO_T] field=[MANDT] pos=[0] key=[X] type=[CLNT] len=[3] rollname=[MANDT]",
        "FLD table=[ZFOO_T] field=[ID] pos=[1] key=[X] type=[CHAR] len=[10] rollname=[ZFOO_ID]",
      ),
    );
    const o = resolveObject(t);
    expect(o?.name).toBe("ZFOO");
    expect(o?.objectType).toBe("V");
    expect(o?.tables).toHaveLength(1);
    expect(o?.tables[0]?.deliveryClass).toBe("C");
    expect(o?.tables[0]?.keyFields.map((f) => f.field)).toEqual(["MANDT", "ID"]);
  });
});
