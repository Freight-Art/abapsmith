/**
 * The single record of every IMG (SPRO customizing) catalog table and field
 * name `img-bridge.ts` uses. No name below has been confirmed against a live
 * SAP system — `IMG_CATALOG_VERIFIED` stays `false` until a live discovery
 * run settles them, and this is the one file that changes when it does.
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

const UNSETTLED_NOTE =
  "name and key fields not confirmed against a live system; settle with abap_read on TABL/DT";

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
      generated: "GENFLAG",
    }),
    confidence: "low",
    note: UNSETTLED_NOTE,
  }),
  viewCluster: Object.freeze({
    table: "VCLDIR",
    fields: Object.freeze({
      cluster: "VCLNAME",
    }),
    confidence: "low",
    note: UNSETTLED_NOTE,
  }),
  viewClusterText: Object.freeze({
    table: "VCLDIRT",
    fields: Object.freeze({
      cluster: "VCLNAME",
      language: "LANGU",
      text: "VCLTEXT",
    }),
    confidence: "low",
    note: UNSETTLED_NOTE,
  }),
  viewClusterMember: Object.freeze({
    table: "VCLSTRUC",
    fields: Object.freeze({
      cluster: "VCLNAME",
      object: "OBJECT",
    }),
    confidence: "low",
    note: UNSETTLED_NOTE,
  }),
  cusObjectHeader: Object.freeze({
    table: "OBJH",
    fields: Object.freeze({
      object: "OBJECTNAME",
      objectType: "OBJECTTYPE",
    }),
    confidence: "low",
    note: UNSETTLED_NOTE,
  }),
  cusObjectTable: Object.freeze({
    table: "OBJSL",
    fields: Object.freeze({
      object: "OBJECTNAME",
      objectType: "OBJECTTYPE",
      table: "TABNAME",
      position: "TAB_POS",
    }),
    confidence: "low",
    note: UNSETTLED_NOTE,
  }),
  imgActivity: Object.freeze({
    table: "CUS_IMGACH",
    fields: Object.freeze({
      activity: "ACTIVITY",
      attributes: "ATTRIBUTES",
      docClass: "DOKU_ID",
      docName: "DOKU_OBJECT",
    }),
    confidence: "low",
    note: UNSETTLED_NOTE,
  }),
  imgActivityText: Object.freeze({
    table: "CUS_IMGACT",
    fields: Object.freeze({
      activity: "ACTIVITY",
      language: "SPRAS",
      text: "ATTRIBUTES",
    }),
    confidence: "low",
    note: UNSETTLED_NOTE,
  }),
  imgActivityObject: Object.freeze({
    table: "CUS_ACTOBJ",
    fields: Object.freeze({
      activity: "ACTIVITY",
      objectType: "OBJECTTYPE",
      object: "OBJECTNAME",
    }),
    confidence: "low",
    note: UNSETTLED_NOTE,
  }),
  imgNode: Object.freeze({
    table: "TTREE",
    fields: Object.freeze({
      node: "ID",
      treeType: "TYPE",
      parent: "PARENT",
    }),
    confidence: "low",
    note: UNSETTLED_NOTE,
  }),
  imgNodeText: Object.freeze({
    table: "TTREET",
    fields: Object.freeze({
      node: "ID",
      language: "SPRAS",
      text: "TEXT",
    }),
    confidence: "low",
    note: UNSETTLED_NOTE,
  }),
  imgStructure: Object.freeze({
    table: "SIMGH",
    fields: Object.freeze({
      node: "IMG_STRUCT",
      activity: "ACTIVITY",
    }),
    confidence: "low",
    note: UNSETTLED_NOTE,
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
