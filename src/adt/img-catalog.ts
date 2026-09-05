/**
 * The single record of every IMG (SPRO customizing) catalog table and field
 * name `img-bridge.ts` uses. Most entries below were confirmed against a
 * live SAP system on 2026-09-05; `IMG_CATALOG_VERIFIED` is `false` because
 * two entries (imgNode's parent/child edge, imgStructure's activity-node
 * link) are still unresolved — see lowConfidenceTables(). This is the one
 * file that changes when discovery findings change.
 * `img-bridge.ts` is the only consumer.
 */

export type CatalogConfidence = "high" | "low";

export interface CatalogTable {
  /** DDIC table name as it goes into the generated SELECT. */
  readonly table: string;
  /** Logical field name -> DDIC field name. */
  readonly fields: Readonly<Record<string, string>>;
  readonly confidence: CatalogConfidence;
  /** What would settle it, or why it is only "low". */
  readonly note?: string;
}

const MEASURED_NOTE = "measured 2026-09-05";

export const IMG_CATALOG = Object.freeze({
  ddicTable: Object.freeze({
    table: "DD02L",
    fields: Object.freeze({
      table: "TABNAME",
      tableClass: "TABCLASS",
      clientDependent: "CLIDEP",
      deliveryClass: "CONTFLAG",
      maintenance: "MAINFLAG",
      activeState: "AS4LOCAL",
    }),
    confidence: "high",
    note: MEASURED_NOTE + ": CONTFLAG=delivery class, CLIDEP=client dependence",
  }),
  ddicTableText: Object.freeze({
    table: "DD02T",
    fields: Object.freeze({
      table: "TABNAME",
      language: "DDLANGUAGE",
      text: "DDTEXT",
      activeState: "AS4LOCAL",
    }),
    confidence: "high",
  }),
  ddicField: Object.freeze({
    table: "DD03L",
    fields: Object.freeze({
      table: "TABNAME",
      field: "FIELDNAME",
      position: "POSITION",
      keyFlag: "KEYFLAG",
      dataElement: "ROLLNAME",
      dataType: "DATATYPE",
      length: "LENG",
      activeState: "AS4LOCAL",
    }),
    confidence: "high",
  }),
  viewHeader: Object.freeze({
    table: "DD25L",
    fields: Object.freeze({
      view: "VIEWNAME",
      aggregateType: "AGGTYPE",
      rootTable: "ROOTTAB",
      activeState: "AS4LOCAL",
    }),
    confidence: "high",
  }),
  viewText: Object.freeze({
    table: "DD25T",
    fields: Object.freeze({
      view: "VIEWNAME",
      language: "DDLANGUAGE",
      text: "DDTEXT",
      activeState: "AS4LOCAL",
    }),
    confidence: "high",
  }),
  viewBaseTable: Object.freeze({
    table: "DD26S",
    fields: Object.freeze({
      view: "VIEWNAME",
      table: "TABNAME",
      position: "TABPOS",
      activeState: "AS4LOCAL",
    }),
    confidence: "high",
  }),
  viewField: Object.freeze({
    table: "DD27S",
    fields: Object.freeze({
      view: "VIEWNAME",
      viewField: "VIEWFIELD",
      table: "TABNAME",
      field: "FIELDNAME",
      position: "OBJPOS",
      activeState: "AS4LOCAL",
    }),
    confidence: "high",
  }),
  transaction: Object.freeze({
    table: "TSTC",
    fields: Object.freeze({
      transaction: "TCODE",
      program: "PGMNA",
      dynpro: "DYPNO",
    }),
    confidence: "high",
  }),
  transactionText: Object.freeze({
    table: "TSTCT",
    fields: Object.freeze({
      transaction: "TCODE",
      language: "SPRSL",
      text: "TTEXT",
    }),
    confidence: "high",
  }),
  viewDirectory: Object.freeze({
    table: "TVDIR",
    fields: Object.freeze({
      view: "TABNAME",
      area: "AREA",
      type: "TYPE",
      baseTable: "BASTAB",
      generated: "FLAG",
    }),
    confidence: "high",
    note: MEASURED_NOTE,
  }),
  viewCluster: Object.freeze({
    table: "VCLDIR",
    fields: Object.freeze({
      cluster: "VCLNAME",
    }),
    confidence: "high",
    note: MEASURED_NOTE,
  }),
  viewClusterText: Object.freeze({
    table: "VCLDIRT",
    fields: Object.freeze({
      cluster: "VCLNAME",
      language: "SPRAS",
      text: "TEXT",
    }),
    confidence: "high",
    note: MEASURED_NOTE,
  }),
  viewClusterMember: Object.freeze({
    table: "VCLSTRUC",
    fields: Object.freeze({
      cluster: "VCLNAME",
      object: "OBJECT",
      objPos: "OBJPOS",
      objLevel: "OBJLEVEL",
    }),
    confidence: "high",
    note: MEASURED_NOTE,
  }),
  cusObjectHeader: Object.freeze({
    table: "OBJH",
    fields: Object.freeze({
      object: "OBJECTNAME",
      objectType: "OBJECTTYPE",
    }),
    confidence: "high",
    // OBJH/OBJS OBJECTTYPE is C/S/V — a different vocabulary from CUS_ACTOBJ's D/S.
    note: MEASURED_NOTE,
  }),
  cusObjectTable: Object.freeze({
    table: "OBJS",
    fields: Object.freeze({
      object: "OBJECTNAME",
      objectType: "OBJECTTYPE",
      table: "TABNAME",
    }),
    confidence: "high",
    note: MEASURED_NOTE + "; OBJSL maps object->transport object (TOBJ), not object->table",
  }),
  imgActivity: Object.freeze({
    table: "CUS_IMGACH",
    fields: Object.freeze({
      activity: "ACTIVITY",
      attributes: "ATTRIBUTES",
      docId: "DOCU_ID",
      cActivity: "C_ACTIVITY",
    }),
    confidence: "high",
    note: MEASURED_NOTE + "; one doc field (DOCU_ID), not a class/name pair",
  }),
  imgActivityText: Object.freeze({
    table: "CUS_IMGACT",
    fields: Object.freeze({
      activity: "ACTIVITY",
      language: "SPRAS",
      text: "TEXT",
    }),
    confidence: "high",
    note: MEASURED_NOTE,
  }),
  imgActivityObject: Object.freeze({
    table: "CUS_ACTOBJ",
    fields: Object.freeze({
      actId: "ACT_ID",
      objectType: "OBJECTTYPE",
      object: "OBJECTNAME",
      tcode: "TCODE",
      subObjName: "SUBOBJNAME",
    }),
    confidence: "high",
    // no ACTIVITY field here; joins via ACT_ID -> CUS_ACTH -> CUS_IMGACH.C_ACTIVITY.
    // OBJECTTYPE values are D/S — a different vocabulary from OBJH/OBJS's C/S/V.
    note: MEASURED_NOTE,
  }),
  cusActivityHeader: Object.freeze({
    table: "CUS_ACTH",
    fields: Object.freeze({
      actId: "ACT_ID",
    }),
    confidence: "high",
    note: MEASURED_NOTE + "; link: CUS_IMGACH.C_ACTIVITY -> CUS_ACTH.ACT_ID -> CUS_ACTOBJ.ACT_ID",
  }),
  imgNode: Object.freeze({
    table: "TTREE",
    fields: Object.freeze({
      node: "ID",
      treeType: "TYPE",
      parent: "PARENT",
    }),
    confidence: "low",
    note:
      MEASURED_NOTE +
      ": TTREE exists and holds IMG nodes (TYPE='IMG'), but has no parent/child field — 'parent' is still an unresolved placeholder",
  }),
  imgNodeText: Object.freeze({
    table: "TTREET",
    fields: Object.freeze({
      node: "ID",
      language: "SPRAS",
      text: "TEXT",
    }),
    confidence: "high",
    note: MEASURED_NOTE,
  }),
  cusObjectText: Object.freeze({
    table: "OBJT",
    fields: Object.freeze({
      language: "LANGUAGE",
      object: "OBJECTNAME",
      objectType: "OBJECTTYPE",
      text: "DDTEXT",
    }),
    confidence: "high",
    note: MEASURED_NOTE + "; not wired into img-bridge.ts yet",
  }),
  // SIMGH is a transaction (TRAN/T), not a table, and no activity-to-node
  // link table was found. Kept empty (table "UNRESOLVED") because
  // src/tools/img.ts still reads this key's .table for a status message.
  imgStructure: Object.freeze({
    table: "UNRESOLVED",
    fields: Object.freeze({}),
    confidence: "low",
    note: MEASURED_NOTE + ": SIMGH is a transaction, not a table; no replacement found",
  }),
  // Second discovery pass, 2026-09-05: the real tree tables, found after
  // imgNode/imgStructure above were already known wrong. Those two are left
  // as-is here; removing them is a separate change.
  imgTreeNode: Object.freeze({
    table: "TNODEIMG",
    fields: Object.freeze({
      treeId: "TREE_ID",
      extension: "EXTENSION",
      nodeId: "NODE_ID",
      extKey: "EXT_KEY",
      parentId: "PARENT_ID",
      brotherId: "BROTHER_ID",
      refNodeId: "REFNODE_ID",
      refTreeId: "REFTREE_ID",
      nodeType: "NODE_TYPE",
    }),
    confidence: "high",
    note:
      MEASURED_NOTE +
      ": key is TREE_ID+EXTENSION+NODE_ID+EXT_KEY (include HIER_NODEK); no CHILD_ID — " +
      "children are found by selecting on PARENT_ID. " +
      "BROTHER_ID names a node's PREVIOUS sibling, not its next one: the child whose own " +
      "BROTHER_ID is blank is the FIRST child, and walking forward means repeatedly finding " +
      "the sibling whose BROTHER_ID equals the id you are currently on, stopping when no such " +
      "sibling exists. This was derived from the run's row-level BROTHER_ID chains, " +
      "cross-checked against the titles those chains spell out, and against the reference IMG " +
      "root: of its thirty depth-1 children exactly one has a blank BROTHER_ID, and that node " +
      "is an activity leaf (NODE_TYPE IMG) carrying no chapter text — consistent with a first " +
      "child being an activity rather than a chapter (the run recorded no title for that node, " +
      "and none is claimed here). The discovery run's own summary prose states the BROTHER_ID " +
      "direction the other way round (calls it 'next sibling') and is wrong. The chain is also " +
      "not guaranteed to be a clean linked list on a live system: rows " +
      "have been seen where more than one sibling under the same parent carries the same " +
      "BROTHER_ID value, and where a sibling's BROTHER_ID names a node that is not among that " +
      "parent's children at all — a walker must tolerate a branched or broken chain, not assume " +
      "a perfect list. " +
      "TNODEIMG also has a W_SUBNODES field (include HIER_NODED), but it is a CHAR 1 yes/no " +
      "flag, not a child count, and it was found blank on every sampled row including chapter " +
      "nodes that provably have children — on this system it carries no usable information, so " +
      "it is deliberately left out of `fields` above; a caller that needs a child count must " +
      "count PARENT_ID matches instead.",
  }),
  imgTreeNodeText: Object.freeze({
    table: "TNODEIMGT",
    fields: Object.freeze({
      language: "SPRAS",
      treeId: "TREE_ID",
      extension: "EXTENSION",
      branch: "BRANCH",
      nodeId: "NODE_ID",
      extKey: "EXT_KEY",
      text: "TEXT",
    }),
    confidence: "high",
    note:
      MEASURED_NOTE +
      ": an activity leaf (NODE_TYPE IMG) often has no row here — its title comes from " +
      "CUS_IMGACT.TEXT via the node's COBJ reference in TNODEIMGR",
  }),
  imgTreeNodeRef: Object.freeze({
    table: "TNODEIMGR",
    fields: Object.freeze({
      nodeId: "NODE_ID",
      extKey: "EXT_KEY",
      refType: "REF_TYPE",
      refObject: "REF_OBJECT",
    }),
    confidence: "high",
    // no TREE_ID column (include HIER_REFK) — unlike TNODEIMG/TNODEIMGT, a
    // join to this table cannot be scoped by tree, only by NODE_ID.
    note: MEASURED_NOTE + ": REF_TYPE COBJ joins CUS_IMGACH.ACTIVITY / CUS_ACTOBJ.ACT_ID",
  }),
  // TTREE is a tree directory, not a node table — contrast imgNode above,
  // which wrongly treats it as one.
  treeDirectory: Object.freeze({
    table: "TTREE",
    fields: Object.freeze({
      id: "ID",
      treeType: "TYPE",
      rootNodeId: "NODE_ID",
    }),
    confidence: "high",
    note:
      MEASURED_NOTE +
      ": ID is the tree's GUID, not a mnemonic — WHERE id IN ('SIMG','SIMG_ALL','IMG','CUST') " +
      "returned 0 rows (TTREET has no text rows for those ids either), so the reference IMG has " +
      "to be found by title text in TNODEIMGT rather than by a well-known id. " +
      "TTREE's own column literally named TREE_ID is blank on every row seen (filtering on " +
      "tree_id IN (...) with real tree ids returned 0 rows; filtering the same tree by id = " +
      "'<guid>' found it immediately, with TREE_ID blank in the returned row) — a tree's identity " +
      "lives in TTREE.ID, and TREE_ID must never be used as a join key or lookup column.",
  }),
} satisfies Record<string, CatalogTable>);

export type ImgCatalogKey = keyof typeof IMG_CATALOG;

/** Set only when a live discovery run has confirmed every entry above. */
export const IMG_CATALOG_VERIFIED = false;

/** DDIC names of every `confidence: "low"` entry, sorted. */
export function lowConfidenceTables(): readonly string[] {
  return Object.values(IMG_CATALOG)
    .filter((t) => t.confidence === "low")
    .map((t) => t.table)
    .sort();
}

/** TNODEIMGR.REF_TYPE value that links a node to a customizing activity (joins CUS_IMGACH.ACTIVITY / CUS_ACTOBJ.ACT_ID). */
export const IMG_ACTIVITY_REF_TYPE = "COBJ";

/**
 * LIKE prefix for finding the reference IMG tree by TNODEIMGT.TEXT (language "E").
 * A text match, not an id lookup, because TTREE.ID has no mnemonic (a WHERE id IN
 * (...) probe for common candidates returned 0 rows) and the GUID differs per
 * system, so one can never be hard-coded here.
 */
export const IMG_TREE_TEXT_PROBE = "SAP Customizing Implementation";

/** TNODEIMG.NODE_TYPE values seen: IMG0 chapter, IMG activity leaf, REF mount of another tree. */
export const IMG_NODE_TYPES = Object.freeze(["IMG0", "IMG", "REF"] as const);
