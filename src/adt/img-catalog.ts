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
