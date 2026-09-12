// Expected names/keys below are pinned against the "Tables read" answer block
// in live/c01-img-read/REPORT.md (not reproduced here; see that file).
import { describe, expect, it } from "vitest";
import {
  IMG_ACTIVITY_REF_TYPE,
  IMG_CATALOG,
  IMG_NODE_TYPES,
  IMG_TREE_TEXT_PROBE,
  MAINTENANCE_EVENT_DOMAIN,
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

  it("lowConfidenceTables() is empty now that every entry is high confidence", () => {
    expect(lowConfidenceTables()).toEqual([]);
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

  it("imgTreeNode: no subNodeCount key and no field mapped to W_SUBNODES — the flag is unreliable, not a count", () => {
    const e = IMG_CATALOG.imgTreeNode;
    expect(e.fields as Record<string, string>).not.toHaveProperty("subNodeCount");
    expect(Object.values(e.fields)).not.toContain("W_SUBNODES");
  });

  it("imgTreeNode note: documents why W_SUBNODES was dropped, not just that it was", () => {
    const note = IMG_CATALOG.imgTreeNode.note ?? "";
    expect(note).toContain("W_SUBNODES");
    // it must say what kind of field it really is (a flag, not a count) ...
    expect(note.toLowerCase()).toContain("char 1");
    expect(note.toLowerCase()).toContain("yes/no");
    // ... and why that flag can't be trusted (blank on nodes that do have children) ...
    expect(note.toLowerCase()).toContain("blank");
    expect(note.toLowerCase()).toContain("children");
    // ... and what a caller should do instead.
    expect(note).toContain("PARENT_ID");
  });

  it("imgTreeNode note: BROTHER_ID is the PREVIOUS sibling, and the blank-BROTHER_ID child is FIRST", () => {
    const note = IMG_CATALOG.imgTreeNode.note ?? "";
    expect(note).toContain("PREVIOUS sibling");
    expect(note).toContain("FIRST child");
    // it must flag that the run's own summary got the direction backwards
    expect(note.toLowerCase()).toContain("summary");
    expect(note.toLowerCase()).toMatch(/wrong|backwards|other way round/);
  });

  it("imgTreeNode note: warns the BROTHER_ID chain may be branched or broken, not a clean list", () => {
    const note = IMG_CATALOG.imgTreeNode.note ?? "";
    expect(note.toLowerCase()).toContain("branched");
    expect(note.toLowerCase()).toContain("broken");
  });

  it("treeDirectory note: TTREE.TREE_ID is blank; ID (not TREE_ID) is the key", () => {
    const note = IMG_CATALOG.treeDirectory.note ?? "";
    expect(note).toContain("TREE_ID");
    expect(note.toLowerCase()).toContain("blank");
    expect(note).toMatch(/\bID\b/);
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

  // --------------------------------------------------- issue #62: checks ---

  it("ddicField (DD03L): gained checkTable/domainName under CHECKTABLE/DOMNAME, high confidence", () => {
    const e = IMG_CATALOG.ddicField;
    expect(e.table).toBe("DD03L");
    expect(keys(e, "checkTable", "domainName")).toEqual(["CHECKTABLE", "DOMNAME"]);
    expect(e.confidence).toBe("high");
  });

  it("domainValue (DD07L): position/valueLow/valueHigh/appendValue/activeState field names", () => {
    const e = IMG_CATALOG.domainValue;
    expect(e.table).toBe("DD07L");
    expect(keys(e, "domain", "position", "valueLow", "valueHigh", "appendValue", "activeState")).toEqual([
      "DOMNAME",
      "VALPOS",
      "DOMVALUE_L",
      "DOMVALUE_H",
      "APPVAL",
      "AS4LOCAL",
    ]);
    expect(e.confidence).toBe("high");
  });

  it("domainValue note: a domain with no rows is not an error, and a non-blank DOMVALUE_H means a range", () => {
    const note = IMG_CATALOG.domainValue.note ?? "";
    expect(note.toLowerCase()).toContain("no fixed values");
    expect(note).toContain("not an error");
    expect(note).toContain("DOMVALUE_H");
    expect(note.toUpperCase()).toContain("RANGE");
  });

  it("domainValueText (DD07T): domain/position/valueLow/language/text/activeState field names", () => {
    const e = IMG_CATALOG.domainValueText;
    expect(e.table).toBe("DD07T");
    expect(keys(e, "domain", "position", "valueLow", "language", "text", "activeState")).toEqual([
      "DOMNAME",
      "VALPOS",
      "DOMVALUE_L",
      "DDLANGUAGE",
      "DDTEXT",
      "AS4LOCAL",
    ]);
    expect(e.confidence).toBe("high");
  });

  it("viewMaintenanceEvent (TVIMF): view/event/formName field names, no activeState/client field", () => {
    const e = IMG_CATALOG.viewMaintenanceEvent;
    expect(e.table).toBe("TVIMF");
    expect(keys(e, "view", "event", "formName")).toEqual(["TABNAME", "EVENT", "FORMNAME"]);
    // TVIMF genuinely has only these three columns — no client field and no AS4LOCAL/active-state
    // field to filter on, unlike almost every other entry in this catalog.
    expect(Object.keys(e.fields)).toEqual(["view", "event", "formName"]);
    expect(e.fields as Record<string, string>).not.toHaveProperty("activeState");
    expect(e.fields as Record<string, string>).not.toHaveProperty("client");
    expect(Object.values(e.fields)).not.toContain("AS4LOCAL");
    expect(Object.values(e.fields)).not.toContain("MANDT");
    expect(e.confidence).toBe("high");
  });

  it("viewMaintenanceEvent note: documents the missing client/AS4LOCAL columns explicitly", () => {
    const note = IMG_CATALOG.viewMaintenanceEvent.note ?? "";
    expect(note.toLowerCase()).toContain("no client column");
    expect(note).toContain("AS4LOCAL");
  });

  it("MAINTENANCE_EVENT_DOMAIN is the DD07L/DD07T domain for TVIMF-EVENT codes", () => {
    expect(MAINTENANCE_EVENT_DOMAIN).toBe("MAINTEVENT");
  });

  it("no exported value anywhere in the module contains a 32-hex-char GUID", () => {
    const strings = collectStrings(imgCatalogModule);
    const offenders = strings.filter((s) => HEX32.test(s));
    expect(offenders).toEqual([]);
  });
});
