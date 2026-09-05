// Expected names/keys below are pinned against the "Tables read" answer block
// in live/c01-img-read/REPORT.md (not reproduced here; see that file).
import { describe, expect, it } from "vitest";
import {
  IMG_ACTIVITY_REF_TYPE,
  IMG_CATALOG,
  IMG_NODE_TYPES,
  IMG_TREE_TEXT_PROBE,
  lowConfidenceTables,
} from "../src/adt/img-catalog.js";
import * as imgCatalogModule from "../src/adt/img-catalog.js";

function keys(entry: { fields: Readonly<Record<string, string>> }, ...logical: string[]): string[] {
  return logical.map((k) => entry.fields[k]);
}

// Collects every string reachable from a module's exported values, so a
// hard-coded GUID pasted anywhere (a note, a nested field map, a constant)
// gets caught, not just the ones an author remembered to check by hand.
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
  return out;
}

const HEX32 = /[0-9a-f]{32}/i;

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

  it("TNODEIMG: ordered key TREE_ID+EXTENSION+NODE_ID+EXT_KEY, PARENT_ID+BROTHER_ID present, no CHILD_ID", () => {
    const e = IMG_CATALOG.imgTreeNode;
    expect(e.table).toBe("TNODEIMG");
    expect(keys(e, "treeId", "extension", "nodeId", "extKey")).toEqual([
      "TREE_ID",
      "EXTENSION",
      "NODE_ID",
      "EXT_KEY",
    ]);
    expect(e.fields.parentId).toBe("PARENT_ID");
    expect(e.fields.brotherId).toBe("BROTHER_ID");
    expect(Object.values(e.fields)).not.toContain("CHILD_ID");
    expect(e.confidence).toBe("high");
  });

  it("TNODEIMGT: ordered key SPRAS+TREE_ID+EXTENSION+BRANCH+NODE_ID+EXT_KEY, text field TEXT", () => {
    const e = IMG_CATALOG.imgTreeNodeText;
    expect(e.table).toBe("TNODEIMGT");
    expect(keys(e, "language", "treeId", "extension", "branch", "nodeId", "extKey")).toEqual([
      "SPRAS",
      "TREE_ID",
      "EXTENSION",
      "BRANCH",
      "NODE_ID",
      "EXT_KEY",
    ]);
    expect(e.fields.text).toBe("TEXT");
  });

  it("TNODEIMGR: ordered key NODE_ID+EXT_KEY+REF_TYPE+REF_OBJECT, no TREE_ID", () => {
    const e = IMG_CATALOG.imgTreeNodeRef;
    expect(e.table).toBe("TNODEIMGR");
    expect(keys(e, "nodeId", "extKey", "refType", "refObject")).toEqual([
      "NODE_ID",
      "EXT_KEY",
      "REF_TYPE",
      "REF_OBJECT",
    ]);
    expect(Object.values(e.fields)).not.toContain("TREE_ID");
  });

  it("treeDirectory (TTREE): ID+TYPE+NODE_ID, high confidence", () => {
    const e = IMG_CATALOG.treeDirectory;
    expect(e.table).toBe("TTREE");
    expect(keys(e, "id", "treeType", "rootNodeId")).toEqual(["ID", "TYPE", "NODE_ID"]);
    expect(e.confidence).toBe("high");
  });

  it("IMG_ACTIVITY_REF_TYPE is COBJ", () => {
    expect(IMG_ACTIVITY_REF_TYPE).toBe("COBJ");
  });

  it("IMG_NODE_TYPES is exactly IMG0/IMG/REF", () => {
    expect(IMG_NODE_TYPES).toEqual(["IMG0", "IMG", "REF"]);
  });

  it("IMG_TREE_TEXT_PROBE is the documented prefix and carries no GUID", () => {
    expect(IMG_TREE_TEXT_PROBE).toBe("SAP Customizing Implementation");
    expect(HEX32.test(IMG_TREE_TEXT_PROBE)).toBe(false);
  });

  it("no exported value anywhere in the module contains a 32-hex-char GUID", () => {
    const strings = collectStrings(imgCatalogModule);
    const offenders = strings.filter((s) => HEX32.test(s));
    expect(offenders).toEqual([]);
  });
});
