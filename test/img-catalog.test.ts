// Expected names/keys below are pinned against the "Tables read" answer block
// in live/c01-img-read/REPORT.md (not reproduced here; see that file).
import { describe, expect, it } from "vitest";
import { IMG_CATALOG, lowConfidenceTables } from "../src/adt/img-catalog.js";

function keys(entry: { fields: Readonly<Record<string, string>> }, ...logical: string[]): string[] {
  return logical.map((k) => entry.fields[k]);
}

describe("IMG_CATALOG — pinned against live discovery", () => {
  it("CUS_IMGACH: key ACTIVITY, one doc field, C_ACTIVITY link", () => {
    const e = IMG_CATALOG.imgActivity;
    expect(e.table).toBe("CUS_IMGACH");
    expect(keys(e, "activity")).toEqual(["ACTIVITY"]);
    expect(e.fields.docId).toBe("DOCU_ID");
    expect(e.fields.cActivity).toBe("C_ACTIVITY");
    expect(e.fields.docClass).toBeUndefined();
    expect(e.fields.docName).toBeUndefined();
  });

  it("CUS_IMGACT: key SPRAS+ACTIVITY, title field is TEXT", () => {
    const e = IMG_CATALOG.imgActivityText;
    expect(e.table).toBe("CUS_IMGACT");
    expect(keys(e, "language", "activity")).toEqual(["SPRAS", "ACTIVITY"]);
    expect(e.fields.text).toBe("TEXT");
  });

  it("CUS_ACTOBJ: five-part key, no ACTIVITY field", () => {
    const e = IMG_CATALOG.imgActivityObject;
    expect(e.table).toBe("CUS_ACTOBJ");
    expect(keys(e, "actId", "objectType", "object", "tcode", "subObjName")).toEqual([
      "ACT_ID",
      "OBJECTTYPE",
      "OBJECTNAME",
      "TCODE",
      "SUBOBJNAME",
    ]);
    expect(e.fields.activity).toBeUndefined();
  });

  it("CUS_ACTH: load-bearing activity header, key ACT_ID", () => {
    const e = IMG_CATALOG.cusActivityHeader;
    expect(e.table).toBe("CUS_ACTH");
    expect(keys(e, "actId")).toEqual(["ACT_ID"]);
  });

  it("OBJS is the object->base-table mapping, not OBJSL", () => {
    const e = IMG_CATALOG.cusObjectTable;
    expect(e.table).toBe("OBJS");
    expect(keys(e, "object", "objectType", "table")).toEqual(["OBJECTNAME", "OBJECTTYPE", "TABNAME"]);
    expect(Object.values(IMG_CATALOG).some((t) => t.table === "OBJSL")).toBe(false);
  });

  it("OBJH: object header, key OBJECTNAME+OBJECTTYPE", () => {
    const e = IMG_CATALOG.cusObjectHeader;
    expect(e.table).toBe("OBJH");
    expect(keys(e, "object", "objectType")).toEqual(["OBJECTNAME", "OBJECTTYPE"]);
  });

  it("OBJT: object text table, key LANGUAGE+OBJECTNAME+OBJECTTYPE, text DDTEXT", () => {
    const e = IMG_CATALOG.cusObjectText;
    expect(e.table).toBe("OBJT");
    expect(keys(e, "language", "object", "objectType")).toEqual(["LANGUAGE", "OBJECTNAME", "OBJECTTYPE"]);
    expect(e.fields.text).toBe("DDTEXT");
  });

  it("VCLDIRT: text field is TEXT, not VCLTEXT", () => {
    const e = IMG_CATALOG.viewClusterText;
    expect(e.table).toBe("VCLDIRT");
    expect(e.fields.text).toBe("TEXT");
    expect(e.fields.language).toBe("SPRAS");
  });

  it("VCLSTRUC: records OBJPOS/OBJLEVEL for ordering", () => {
    const e = IMG_CATALOG.viewClusterMember;
    expect(e.table).toBe("VCLSTRUC");
    expect(e.fields.objPos).toBe("OBJPOS");
    expect(e.fields.objLevel).toBe("OBJLEVEL");
  });

  it("DD02L: CONTFLAG=delivery class, CLIDEP=client dependence, measured", () => {
    const e = IMG_CATALOG.ddicTable;
    expect(e.table).toBe("DD02L");
    expect(e.fields.deliveryClass).toBe("CONTFLAG");
    expect(e.fields.clientDependent).toBe("CLIDEP");
    expect(e.confidence).toBe("high");
  });

  it("SIMGH and CUS_IMGAC are absent from the catalog", () => {
    const tables = Object.values(IMG_CATALOG).map((t) => t.table);
    expect(tables).not.toContain("SIMGH");
    expect(tables).not.toContain("CUS_IMGAC");
  });

  it("lowConfidenceTables() names exactly the unresolved entries", () => {
    expect(lowConfidenceTables()).toEqual(["TTREE", "UNRESOLVED"]);
  });
});
