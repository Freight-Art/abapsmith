/**
 * Read-only IMG (SPRO customizing) navigation, reached the same way as
 * `fpm-runtime.ts`/`ddic-bridge.ts`: ADT has no IMG REST route, so every mode
 * here (`search`/`show`/`tree`/`objects`) deploys a generated
 * `IF_OO_ADT_CLASSRUN` class to `$TMP` that only ever SELECTs from catalog
 * tables — it never reads or writes a customizing entry itself. Caller input
 * reaches SQL only as a validated, quoted literal built in this file; no
 * caller string is ever concatenated into ABAP source directly.
 *
 * Every catalog table/field name below comes from `./img-catalog.ts`, the
 * single place they are recorded — none of them has been confirmed against a
 * live SAP system yet (see that file's header).
 *
 * Deploying the bridge is a `$TMP` write, so — even though this module reads
 * nothing but catalog rows — it cannot run under `ABAP_MODE=read`.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyGate } from "../safety.js";
import { ddicBridgeSource, DDIC_ERR_PREFIX } from "./ddic-bridge.js";
import { BRIDGE_PACKAGE, deployBridge, executeBridge, ERR_LINE_PREFIX, parseBracketFields, verifyBridgeActivation } from "./run.js";
import { IMG_CATALOG, type ImgCatalogKey } from "./img-catalog.js";

export const IMG_BRIDGE_PACKAGE = BRIDGE_PACKAGE;
export const IMG_LINE_PREFIX = "IMG> ";
export const IMG_PAGE_DEFAULT = 25;
export const IMG_PAGE_MAX = 200;

/** Fixed per-mode class name — never generated or caller-influenced. */
export const IMG_BRIDGE_CLASS = {
  search: "ZCL_ZMCP_IMG_SEARCH",
  show: "ZCL_ZMCP_IMG_SHOW",
  tree: "ZCL_ZMCP_IMG_TREE",
  objects: "ZCL_ZMCP_IMG_OBJECTS",
} as const;

export type ImgMode = keyof typeof IMG_BRIDGE_CLASS;

export type ImgObjectKind = "view" | "cluster" | "transaction" | "table" | "report" | "customizing_object" | "unknown";

export interface ImgSearchQuery {
  mode: "search";
  text: string;
  language: string;
  offset: number;
  limit: number;
}

export interface ImgShowQuery {
  mode: "show";
  activity: string;
  language: string;
}

export interface ImgTreeQuery {
  mode: "tree";
  node: string;
  language: string;
  offset: number;
  limit: number;
}

export interface ImgObjectsQuery {
  mode: "objects";
  object: string;
  language: string;
  kind?: ImgObjectKind;
}

export type ImgQuery = ImgSearchQuery | ImgShowQuery | ImgTreeQuery | ImgObjectsQuery;

export interface ImgActivityRow {
  activity: string;
  objects: number;
  nodes: number;
  title: string;
}

export interface ImgPathRow {
  activity: string;
  position: number;
  node: string;
  title: string;
}

export interface ImgNodeRow {
  node: string;
  parent: string;
  kind: "folder" | "activity";
  activity: string;
  children: number | null;
  title: string;
}

export interface ImgObjectRow {
  activity: string;
  kind: ImgObjectKind;
  objectType: string;
  name: string;
  title: string;
}

export interface ImgTableRow {
  object: string;
  table: string;
  clientDependent: boolean;
  deliveryClass: string;
  via: string;
  title: string;
}

export interface ImgFieldRow {
  table: string;
  field: string;
  key: boolean;
  position: number;
  dataType: string;
  length: string;
  dataElement: string;
}

export interface ImgDocRow {
  activity: string;
  docClass: string;
  docName: string;
}

export interface ImgPageState {
  offset: number;
  limit: number;
  more: boolean;
}

export interface ImgTranscript {
  total: number | null;
  page: ImgPageState | null;
  activities: ImgActivityRow[];
  path: ImgPathRow[];
  nodes: ImgNodeRow[];
  objects: ImgObjectRow[];
  tables: ImgTableRow[];
  fields: ImgFieldRow[];
  docs: ImgDocRow[];
  notes: string[];
  errors: string[];
  droppedLines: number;
  raw: string;
}

export interface ImgReadResult {
  query: ImgQuery;
  bridgeClass: string;
  bridgeRefreshed: boolean;
  durationMs: number;
  transcript: ImgTranscript;
  outputComplete: boolean;
  bodyBytes: number;
}

export function imgBridgeClassName(mode: ImgMode): string {
  return IMG_BRIDGE_CLASS[mode];
}

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function tbl(key: ImgCatalogKey): string {
  return IMG_CATALOG[key].table.toLowerCase();
}

function fld<K extends ImgCatalogKey, F extends keyof (typeof IMG_CATALOG)[K]["fields"]>(key: K, field: F): string {
  // The cast is only to satisfy TS2536 (a generic key can't double-index the catalog type directly);
  // `field`'s type is still tied to this specific K, so a typo or a wrong-table field stays a compile error.
  const fields = IMG_CATALOG[key].fields as Record<F, string>;
  return fields[field].toLowerCase();
}

/** Code-controlled note text only — never caller input. */
function selectGuard(note: string): string[] {
  if (!/^[A-Za-z0-9_ -]+$/.test(note)) {
    throw new AbapError("CHECK_FAILED", `IMG bridge note text ${JSON.stringify(note)} is not plain text.`, { note });
  }
  return [`IF sy-subrc <> 0.`, `  out->write( |${IMG_LINE_PREFIX}NOTE text=[${note}]| ).`, `ENDIF.`];
}

function assertLanguage(value: string): string {
  const v = value.trim();
  if (!/^[A-Za-z]{1,2}$/.test(v)) {
    throw new AbapError("BAD_INPUT", `language "${value}" must be exactly 1 or 2 letters.`, { value });
  }
  return v.toUpperCase();
}

function assertOffset(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 100000) {
    throw new AbapError("BAD_INPUT", `offset ${value} must be an integer between 0 and 100000.`, { value });
  }
  return value;
}

function assertLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > IMG_PAGE_MAX) {
    throw new AbapError("BAD_INPUT", `limit ${value} must be an integer between 1 and ${IMG_PAGE_MAX}.`, { value });
  }
  return value;
}

function assertActivityOrNode(value: string, label: "activity" | "node", opts?: { allowEmpty?: boolean }): string {
  const v = value.trim();
  if (opts?.allowEmpty && v.length === 0) {
    return v;
  }
  if (v.length < 1 || v.length > 60 || !/^[A-Za-z0-9_/\-]{1,60}$/.test(v)) {
    throw new AbapError(
      "BAD_INPUT",
      `${label} "${value}" must be 1-60 characters of letters, digits, underscore, "/" or "-".`,
      { value },
    );
  }
  return v;
}

function assertObjectName(value: string): string {
  const v = value.trim();
  if (v.length < 1 || v.length > 30 || !/^[A-Za-z0-9_/]{1,30}$/.test(v)) {
    throw new AbapError(
      "BAD_INPUT",
      `object "${value}" must be 1-30 characters of letters, digits, underscore or "/" (a DDIC/view/cluster name).`,
      { value },
    );
  }
  return v;
}

/**
 * '#' is both a legal input character and the LIKE escape character, so a
 * caller's literal '#' must be doubled before '_' gets escaped with it —
 * otherwise a raw '#' in the query would be read as the start of an escape
 * sequence by the database.
 */
export function imgLikePattern(raw: string): { literal: string; escapeChar: string } {
  const trimmed = raw.trim();
  if (trimmed === "" || !/^[A-Za-z0-9_/*.\-# ]{1,40}$/.test(trimmed)) {
    throw new AbapError(
      "BAD_INPUT",
      `text "${raw}" may only contain letters, digits, underscore, "/", "*" (wildcard), ".", "-", "#" or space, 1-40 chars.`,
      { value: raw },
    );
  }
  const escapeChar = "#";
  const hasWildcard = trimmed.includes("*");
  const escaped = trimmed.replace(/#/g, "##").replace(/_/g, "#_").replace(/\*/g, "%");
  // A bare term (no '*') is a title-word search, not an exact id — wrap it so it matches as a substring.
  const literal = hasWildcard ? escaped : `%${escaped}%`;
  return { literal: sqlQuote(literal), escapeChar };
}

export function validateImgQuery(q: ImgQuery): void {
  assertLanguage(q.language);
  switch (q.mode) {
    case "search":
      imgLikePattern(q.text);
      assertOffset(q.offset);
      assertLimit(q.limit);
      break;
    case "show":
      assertActivityOrNode(q.activity, "activity");
      break;
    case "tree":
      assertActivityOrNode(q.node, "node", { allowEmpty: true });
      assertOffset(q.offset);
      assertLimit(q.limit);
      break;
    case "objects":
      assertObjectName(q.object);
      break;
  }
}

function pagingCounters(offset: number, limit: number): string[] {
  return [
    `DATA(lv_offset) = ${offset}.`,
    `DATA(lv_limit) = ${limit}.`,
    "DATA lv_idx TYPE i.",
    "lv_idx = 0.",
    "DATA lv_emitted TYPE i.",
    "lv_emitted = 0.",
    "DATA lv_more TYPE abap_bool.",
    "lv_more = abap_false.",
  ];
}

function pagingSkipAndStop(): string[] {
  return [
    "  lv_idx = lv_idx + 1.",
    "  IF lv_idx <= lv_offset.",
    "    CONTINUE.",
    "  ENDIF.",
    "  IF lv_emitted >= lv_limit.",
    "    lv_more = abap_true.",
    "    EXIT.",
    "  ENDIF.",
    "  lv_emitted = lv_emitted + 1.",
  ];
}

function searchFragment(q: ImgSearchQuery): { data: string[]; body: string[] } {
  const language = assertLanguage(q.language);
  const { literal, escapeChar } = imgLikePattern(q.text);
  const offset = assertOffset(q.offset);
  const limit = assertLimit(q.limit);
  const langLit = sqlQuote(language);

  const actTextTable = tbl("imgActivityText");
  const fActivity = fld("imgActivityText", "activity");
  const fLang = fld("imgActivityText", "language");
  const fText = fld("imgActivityText", "text");

  const actTable = tbl("imgActivity");
  const fA_activity = fld("imgActivity", "activity");
  const fA_cActivity = fld("imgActivity", "cActivity");

  const objTable = tbl("imgActivityObject");
  const fO_actId = fld("imgActivityObject", "actId");

  const body: string[] = [
    `SELECT COUNT(*) FROM ${actTextTable}`,
    `  WHERE ${fLang} = '${langLit}'`,
    `    AND ( ${fActivity} LIKE '${literal}' ESCAPE '${escapeChar}'`,
    `       OR ${fText} LIKE '${literal}' ESCAPE '${escapeChar}' )`,
    `  INTO @DATA(lv_total).`,
    `out->write( |${IMG_LINE_PREFIX}TOTAL n=[{ lv_total }]| ).`,
    ``,
    `SELECT ${fActivity}, ${fText} FROM ${actTextTable}`,
    `  WHERE ${fLang} = '${langLit}'`,
    `    AND ( ${fActivity} LIKE '${literal}' ESCAPE '${escapeChar}'`,
    `       OR ${fText} LIKE '${literal}' ESCAPE '${escapeChar}' )`,
    `  ORDER BY ${fActivity}`,
    `  INTO TABLE @DATA(lt_rows)`,
    `  UP TO ${offset + limit + 1} ROWS.`,
    ...selectGuard("no activities matched"),
    ``,
    ...pagingCounters(offset, limit),
    `LOOP AT lt_rows INTO DATA(ls_row).`,
    ...pagingSkipAndStop(),
    `  SELECT SINGLE ${fA_cActivity} FROM ${actTable} WHERE ${fA_activity} = @ls_row-${fActivity}`,
    `    INTO @DATA(lv_c_activity).`,
    `  SELECT COUNT(*) FROM ${objTable} WHERE ${fO_actId} = @lv_c_activity INTO @DATA(lv_objs).`,
    // no activity-to-tree-node link table was found; see imgStructure's catalog note.
    `  DATA lv_nodes TYPE i.`,
    `  lv_nodes = 0.`,
    `  out->write( |${IMG_LINE_PREFIX}ACT activity=[{ ls_row-${fActivity} }] objects=[{ lv_objs }] | &&`,
    `    |nodes=[{ lv_nodes }] title=[{ ls_row-${fText} }]| ).`,
    `ENDLOOP.`,
    `out->write( |${IMG_LINE_PREFIX}PAGE offset=[{ lv_offset }] limit=[{ lv_limit }] more=[{ lv_more }]| ).`,
  ];

  return { data: [], body };
}

function showFragment(q: ImgShowQuery): { data: string[]; body: string[] } {
  const language = assertLanguage(q.language);
  const activity = assertActivityOrNode(q.activity, "activity");
  const langLit = sqlQuote(language);
  const activityLit = sqlQuote(activity);

  const actTextTable = tbl("imgActivityText");
  const fAT_activity = fld("imgActivityText", "activity");
  const fAT_lang = fld("imgActivityText", "language");
  const fAT_text = fld("imgActivityText", "text");

  const actTable = tbl("imgActivity");
  const fA_activity = fld("imgActivity", "activity");
  const fA_cActivity = fld("imgActivity", "cActivity");
  const fA_docId = fld("imgActivity", "docId");

  const actHeaderTable = tbl("cusActivityHeader");
  const fAH_actId = fld("cusActivityHeader", "actId");

  const objTable = tbl("imgActivityObject");
  const fO_actId = fld("imgActivityObject", "actId");
  const fO_object = fld("imgActivityObject", "object");
  const fO_objectType = fld("imgActivityObject", "objectType");

  const objTblTable = tbl("cusObjectTable");
  const fOT_object = fld("cusObjectTable", "object");
  const fOT_table = fld("cusObjectTable", "table");

  const ddicTableTable = tbl("ddicTable");
  const fDT_table = fld("ddicTable", "table");
  const fDT_clidep = fld("ddicTable", "clientDependent");
  const fDT_delclass = fld("ddicTable", "deliveryClass");
  const fDT_active = fld("ddicTable", "activeState");

  const body: string[] = [
    `SELECT SINGLE ${fAT_text} FROM ${actTextTable}`,
    `  WHERE ${fAT_activity} = '${activityLit}' AND ${fAT_lang} = '${langLit}'`,
    `  INTO @DATA(lv_title).`,
    ...selectGuard("no title for this activity and language"),
    `SELECT SINGLE ${fA_cActivity}, ${fA_docId} FROM ${actTable}`,
    `  WHERE ${fA_activity} = '${activityLit}'`,
    `  INTO (@DATA(lv_c_activity), @DATA(lv_doc_id)).`,
    `SELECT SINGLE ${fAH_actId} FROM ${actHeaderTable} WHERE ${fAH_actId} = @lv_c_activity`,
    `  INTO @DATA(lv_act_id).`,
    `SELECT COUNT(*) FROM ${objTable} WHERE ${fO_actId} = @lv_act_id INTO @DATA(lv_objs).`,
    // no activity-to-tree-node link table was found; see imgStructure's catalog note.
    `DATA lv_nodes TYPE i.`,
    `lv_nodes = 0.`,
    `out->write( |${IMG_LINE_PREFIX}ACT activity=[${activity}] objects=[{ lv_objs }] | &&`,
    `  |nodes=[{ lv_nodes }] title=[{ lv_title }]| ).`,
    ``,
    `IF lv_doc_id IS NOT INITIAL.`,
    `  out->write( |${IMG_LINE_PREFIX}DOC activity=[${activity}] class=[] name=[{ lv_doc_id }]| ).`,
    `ELSE.`,
    `  out->write( |${IMG_LINE_PREFIX}NOTE text=[no documentation entry for this activity]| ).`,
    `ENDIF.`,
    ``,
    // activity-to-tree-node path is not available: TTREE has no confirmed parent/child field.
    `out->write( |${IMG_LINE_PREFIX}NOTE text=[activity-to-tree-node path not available]| ).`,
    ``,
    `SELECT ${fO_object}, ${fO_objectType} FROM ${objTable} WHERE ${fO_actId} = @lv_act_id`,
    `  INTO TABLE @DATA(lt_objs)`,
    `  UP TO 200 ROWS.`,
    ...selectGuard("no customizing objects linked to this activity"),
    `LOOP AT lt_objs INTO DATA(ls_obj).`,
    `  out->write( |${IMG_LINE_PREFIX}OBJ activity=[${activity}] kind=[unknown] | &&`,
    `    |objtype=[{ ls_obj-${fO_objectType} }] name=[{ ls_obj-${fO_object} }] title=[]| ).`,
    // ls_obj-objectType is CUS_ACTOBJ's D/S vocabulary, not OBJS's C/S/V one — object name only below.
    `  SELECT ${fOT_table} FROM ${objTblTable} WHERE ${fOT_object} = @ls_obj-${fO_object}`,
    `    INTO TABLE @DATA(lt_obj_tabs)`,
    `    UP TO 20 ROWS.`,
    `  LOOP AT lt_obj_tabs INTO DATA(ls_obj_tab).`,
    `    SELECT SINGLE ${fDT_clidep}, ${fDT_delclass} FROM ${ddicTableTable}`,
    `      WHERE ${fDT_table} = @ls_obj_tab-${fOT_table} AND ${fDT_active} = 'A'`,
    `      INTO (@DATA(lv_clidep), @DATA(lv_delclass)).`,
    `    IF sy-subrc <> 0.`,
    `      CLEAR lv_clidep.`,
    `      CLEAR lv_delclass.`,
    `    ENDIF.`,
    `    out->write( |${IMG_LINE_PREFIX}TAB object=[{ ls_obj-${fO_object} }] | &&`,
    `      |table=[{ ls_obj_tab-${fOT_table} }] clidep=[{ lv_clidep }] | &&`,
    `      |delclass=[{ lv_delclass }] via=[OBJS] title=[]| ).`,
    `  ENDLOOP.`,
    `ENDLOOP.`,
  ];

  return { data: [], body };
}

function treeFragment(q: ImgTreeQuery): { data: string[]; body: string[] } {
  const language = assertLanguage(q.language);
  const node = assertActivityOrNode(q.node, "node", { allowEmpty: true });
  const offset = assertOffset(q.offset);
  const limit = assertLimit(q.limit);
  const langLit = sqlQuote(language);
  const nodeLit = sqlQuote(node);

  const nodeTable = tbl("imgNode");
  const fN_node = fld("imgNode", "node");
  const fN_parent = fld("imgNode", "parent");

  const nodeTextTable = tbl("imgNodeText");
  const fNT_node = fld("imgNodeText", "node");
  const fNT_lang = fld("imgNodeText", "language");
  const fNT_text = fld("imgNodeText", "text");

  const body: string[] = [
    // Assumption pending live discovery: the reference-IMG root's children are the TTREE rows
    // whose PARENT is initial — an empty `node` maps straight to that, needing no separate branch.
    `SELECT COUNT(*) FROM ${nodeTable} WHERE ${fN_parent} = '${nodeLit}' INTO @DATA(lv_total).`,
    `out->write( |${IMG_LINE_PREFIX}TOTAL n=[{ lv_total }]| ).`,
    ``,
    `SELECT ${fN_node} FROM ${nodeTable} WHERE ${fN_parent} = '${nodeLit}'`,
    `  ORDER BY ${fN_node}`,
    `  INTO TABLE @DATA(lt_rows)`,
    `  UP TO ${offset + limit + 1} ROWS.`,
    ...selectGuard("node has no children"),
    ``,
    ...pagingCounters(offset, limit),
    `LOOP AT lt_rows INTO DATA(ls_row).`,
    ...pagingSkipAndStop(),
    `  SELECT SINGLE ${fNT_text} FROM ${nodeTextTable}`,
    `    WHERE ${fNT_node} = @ls_row-${fN_node} AND ${fNT_lang} = '${langLit}'`,
    `    INTO @DATA(lv_child_title).`,
    `  IF sy-subrc <> 0.`,
    `    CLEAR lv_child_title.`,
    `  ENDIF.`,
    // no activity-to-tree-node link table was found; every node reports as a folder.
    `  DATA lv_kind TYPE string.`,
    `  lv_kind = 'folder'.`,
    `  DATA lv_child_activity TYPE string.`,
    `  CLEAR lv_child_activity.`,
    `  SELECT COUNT(*) FROM ${nodeTable} WHERE ${fN_parent} = @ls_row-${fN_node} INTO @DATA(lv_children).`,
    `  out->write( |${IMG_LINE_PREFIX}NODE node=[{ ls_row-${fN_node} }] parent=[${node}] | &&`,
    `    |kind=[{ lv_kind }] activity=[{ lv_child_activity }] children=[{ lv_children }] | &&`,
    `    |title=[{ lv_child_title }]| ).`,
    `ENDLOOP.`,
    `out->write( |${IMG_LINE_PREFIX}PAGE offset=[{ lv_offset }] limit=[{ lv_limit }] more=[{ lv_more }]| ).`,
  ];

  return { data: [], body };
}

function objectsTableFragment(object: string, objectLit: string, langLit: string): { data: string[]; body: string[] } {
  const ddicTable = tbl("ddicTable");
  const fT_table = fld("ddicTable", "table");
  const fT_clidep = fld("ddicTable", "clientDependent");
  const fT_delclass = fld("ddicTable", "deliveryClass");
  const fT_active = fld("ddicTable", "activeState");

  const textTable = tbl("ddicTableText");
  const fTT_table = fld("ddicTableText", "table");
  const fTT_lang = fld("ddicTableText", "language");
  const fTT_text = fld("ddicTableText", "text");
  const fTT_active = fld("ddicTableText", "activeState");

  const fieldTable = tbl("ddicField");
  const fF_table = fld("ddicField", "table");
  const fF_field = fld("ddicField", "field");
  const fF_pos = fld("ddicField", "position");
  const fF_key = fld("ddicField", "keyFlag");
  const fF_elem = fld("ddicField", "dataElement");
  const fF_type = fld("ddicField", "dataType");
  const fF_len = fld("ddicField", "length");
  const fF_active = fld("ddicField", "activeState");

  const body: string[] = [
    `SELECT SINGLE ${fT_clidep}, ${fT_delclass} FROM ${ddicTable}`,
    `  WHERE ${fT_table} = '${objectLit}' AND ${fT_active} = 'A'`,
    `  INTO (@DATA(lv_clidep), @DATA(lv_delclass)).`,
    ...selectGuard("no active DD02L row for this table"),
    `SELECT SINGLE ${fTT_text} FROM ${textTable}`,
    `  WHERE ${fTT_table} = '${objectLit}' AND ${fTT_lang} = '${langLit}' AND ${fTT_active} = 'A'`,
    `  INTO @DATA(lv_title).`,
    ...selectGuard("no title for this table and language"),
    `out->write( |${IMG_LINE_PREFIX}OBJ activity=[] kind=[table] objtype=[] name=[${object}] title=[{ lv_title }]| ).`,
    `out->write( |${IMG_LINE_PREFIX}TAB object=[${object}] table=[${object}] | &&`,
    `  |clidep=[{ lv_clidep }] delclass=[{ lv_delclass }] via=[DD02L] title=[{ lv_title }]| ).`,
    ``,
    `SELECT ${fF_field}, ${fF_key}, ${fF_pos}, ${fF_type}, ${fF_len}, ${fF_elem} FROM ${fieldTable}`,
    `  WHERE ${fF_table} = '${objectLit}' AND ${fF_active} = 'A'`,
    `  ORDER BY ${fF_pos}`,
    `  INTO TABLE @DATA(lt_fields)`,
    `  UP TO 200 ROWS.`,
    ...selectGuard("no active fields for this table"),
    `LOOP AT lt_fields INTO DATA(ls_fld).`,
    `  out->write( |${IMG_LINE_PREFIX}FLD table=[${object}] field=[{ ls_fld-${fF_field} }] | &&`,
    `    |key=[{ ls_fld-${fF_key} }] pos=[{ ls_fld-${fF_pos} }] type=[{ ls_fld-${fF_type} }] | &&`,
    `    |len=[{ ls_fld-${fF_len} }] rollname=[{ ls_fld-${fF_elem} }]| ).`,
    `ENDLOOP.`,
  ];

  return { data: [], body };
}

function objectsViewFragment(object: string, objectLit: string, langLit: string): { data: string[]; body: string[] } {
  const viewTextTable = tbl("viewText");
  const fVT_view = fld("viewText", "view");
  const fVT_lang = fld("viewText", "language");
  const fVT_text = fld("viewText", "text");
  const fVT_active = fld("viewText", "activeState");

  const baseTable = tbl("viewBaseTable");
  const fB_view = fld("viewBaseTable", "view");
  const fB_table = fld("viewBaseTable", "table");
  const fB_pos = fld("viewBaseTable", "position");
  const fB_active = fld("viewBaseTable", "activeState");

  const viewFieldTable = tbl("viewField");
  const fVF_view = fld("viewField", "view");
  const fVF_table = fld("viewField", "table");
  const fVF_field = fld("viewField", "field");
  const fVF_active = fld("viewField", "activeState");

  const fieldTable = tbl("ddicField");
  const fF_table = fld("ddicField", "table");
  const fF_field = fld("ddicField", "field");
  const fF_pos = fld("ddicField", "position");
  const fF_key = fld("ddicField", "keyFlag");
  const fF_elem = fld("ddicField", "dataElement");
  const fF_type = fld("ddicField", "dataType");
  const fF_len = fld("ddicField", "length");
  const fF_active = fld("ddicField", "activeState");

  const ddicTable = tbl("ddicTable");
  const fT_table = fld("ddicTable", "table");
  const fT_clidep = fld("ddicTable", "clientDependent");
  const fT_delclass = fld("ddicTable", "deliveryClass");
  const fT_active = fld("ddicTable", "activeState");

  const body: string[] = [
    `SELECT SINGLE ${fVT_text} FROM ${viewTextTable}`,
    `  WHERE ${fVT_view} = '${objectLit}' AND ${fVT_lang} = '${langLit}' AND ${fVT_active} = 'A'`,
    `  INTO @DATA(lv_title).`,
    ...selectGuard("no title for this view and language"),
    `out->write( |${IMG_LINE_PREFIX}OBJ activity=[] kind=[view] objtype=[] name=[${object}] title=[{ lv_title }]| ).`,
    ``,
    `SELECT ${fB_table} FROM ${baseTable}`,
    `  WHERE ${fB_view} = '${objectLit}' AND ${fB_active} = 'A'`,
    `  ORDER BY ${fB_pos}`,
    `  INTO TABLE @DATA(lt_bases)`,
    `  UP TO 50 ROWS.`,
    ...selectGuard("no base tables for this view"),
    `LOOP AT lt_bases INTO DATA(ls_base).`,
    `  SELECT SINGLE ${fT_clidep}, ${fT_delclass} FROM ${ddicTable}`,
    `    WHERE ${fT_table} = @ls_base-${fB_table} AND ${fT_active} = 'A'`,
    `    INTO (@DATA(lv_base_clidep), @DATA(lv_base_delclass)).`,
    `  IF sy-subrc <> 0.`,
    `    CLEAR lv_base_clidep.`,
    `    CLEAR lv_base_delclass.`,
    `  ENDIF.`,
    `  out->write( |${IMG_LINE_PREFIX}TAB object=[${object}] table=[{ ls_base-${fB_table} }] | &&`,
    `    |clidep=[{ lv_base_clidep }] delclass=[{ lv_base_delclass }] via=[DD26S] title=[]| ).`,
    `ENDLOOP.`,
    ``,
    `SELECT ${fVF_table}, ${fVF_field} FROM ${viewFieldTable}`,
    `  WHERE ${fVF_view} = '${objectLit}' AND ${fVF_active} = 'A'`,
    `  INTO TABLE @DATA(lt_vfields)`,
    `  UP TO 200 ROWS.`,
    ...selectGuard("no fields for this view"),
    `LOOP AT lt_vfields INTO DATA(ls_vfld).`,
    `  SELECT SINGLE ${fF_pos}, ${fF_key}, ${fF_type}, ${fF_len}, ${fF_elem} FROM ${fieldTable}`,
    `    WHERE ${fF_table} = @ls_vfld-${fVF_table} AND ${fF_field} = @ls_vfld-${fVF_field}`,
    `      AND ${fF_active} = 'A'`,
    `    INTO (@DATA(lv_fpos), @DATA(lv_fkey), @DATA(lv_ftype), @DATA(lv_flen), @DATA(lv_frollname)).`,
    `  IF sy-subrc <> 0.`,
    `    CONTINUE.`,
    `  ENDIF.`,
    `  out->write( |${IMG_LINE_PREFIX}FLD table=[{ ls_vfld-${fVF_table} }] field=[{ ls_vfld-${fVF_field} }] | &&`,
    `    |key=[{ lv_fkey }] pos=[{ lv_fpos }] type=[{ lv_ftype }] | &&`,
    `    |len=[{ lv_flen }] rollname=[{ lv_frollname }]| ).`,
    `ENDLOOP.`,
  ];

  return { data: [], body };
}

function objectsClusterFragment(object: string, objectLit: string, langLit: string): { data: string[]; body: string[] } {
  const clusterText = tbl("viewClusterText");
  const fCT_cluster = fld("viewClusterText", "cluster");
  const fCT_lang = fld("viewClusterText", "language");
  const fCT_text = fld("viewClusterText", "text");

  const memberTable = tbl("viewClusterMember");
  const fM_cluster = fld("viewClusterMember", "cluster");
  const fM_object = fld("viewClusterMember", "object");

  const ddicTable = tbl("ddicTable");
  const fT_table = fld("ddicTable", "table");
  const fT_clidep = fld("ddicTable", "clientDependent");
  const fT_delclass = fld("ddicTable", "deliveryClass");
  const fT_active = fld("ddicTable", "activeState");

  const body: string[] = [
    `SELECT SINGLE ${fCT_text} FROM ${clusterText}`,
    `  WHERE ${fCT_cluster} = '${objectLit}' AND ${fCT_lang} = '${langLit}'`,
    `  INTO @DATA(lv_title).`,
    ...selectGuard("no title for this cluster and language"),
    `out->write( |${IMG_LINE_PREFIX}OBJ activity=[] kind=[cluster] objtype=[] name=[${object}] title=[{ lv_title }]| ).`,
    `SELECT ${fM_object} FROM ${memberTable} WHERE ${fM_cluster} = '${objectLit}'`,
    `  INTO TABLE @DATA(lt_members)`,
    `  UP TO 50 ROWS.`,
    ...selectGuard("no members for this cluster"),
    `LOOP AT lt_members INTO DATA(ls_member).`,
    `  SELECT SINGLE ${fT_clidep}, ${fT_delclass} FROM ${ddicTable}`,
    `    WHERE ${fT_table} = @ls_member-${fM_object} AND ${fT_active} = 'A'`,
    `    INTO (@DATA(lv_member_clidep), @DATA(lv_member_delclass)).`,
    `  IF sy-subrc <> 0.`,
    `    CLEAR lv_member_clidep.`,
    `    CLEAR lv_member_delclass.`,
    `  ENDIF.`,
    `  out->write( |${IMG_LINE_PREFIX}TAB object=[${object}] table=[{ ls_member-${fM_object} }] | &&`,
    `    |clidep=[{ lv_member_clidep }] delclass=[{ lv_member_delclass }] via=[VCLSTRUC] title=[]| ).`,
    `ENDLOOP.`,
  ];

  return { data: [], body };
}

function objectsTransactionFragment(object: string, objectLit: string, langLit: string): { data: string[]; body: string[] } {
  const tstct = tbl("transactionText");
  const fTT_tcode = fld("transactionText", "transaction");
  const fTT_lang = fld("transactionText", "language");
  const fTT_text = fld("transactionText", "text");

  const body: string[] = [
    `SELECT SINGLE ${fTT_text} FROM ${tstct}`,
    `  WHERE ${fTT_tcode} = '${objectLit}' AND ${fTT_lang} = '${langLit}'`,
    `  INTO @DATA(lv_title).`,
    ...selectGuard("no title for this transaction and language"),
    `out->write( |${IMG_LINE_PREFIX}OBJ activity=[] kind=[transaction] objtype=[] name=[${object}] title=[{ lv_title }]| ).`,
  ];

  return { data: [], body };
}

function objectsCustomizingFragment(object: string, objectLit: string): { data: string[]; body: string[] } {
  const objHeader = tbl("cusObjectHeader");
  const fOH_object = fld("cusObjectHeader", "object");
  const fOH_objectType = fld("cusObjectHeader", "objectType");

  const objTable = tbl("cusObjectTable");
  const fOT_object = fld("cusObjectTable", "object");
  const fOT_objectType = fld("cusObjectTable", "objectType");
  const fOT_table = fld("cusObjectTable", "table");

  const ddicTable = tbl("ddicTable");
  const fT_table = fld("ddicTable", "table");
  const fT_clidep = fld("ddicTable", "clientDependent");
  const fT_delclass = fld("ddicTable", "deliveryClass");
  const fT_active = fld("ddicTable", "activeState");

  const body: string[] = [
    `SELECT SINGLE ${fOH_object}, ${fOH_objectType} FROM ${objHeader}`,
    `  WHERE ${fOH_object} = '${objectLit}'`,
    `  INTO (@DATA(lv_found), @DATA(lv_objtype)).`,
    ...selectGuard("no OBJH row for this customizing object"),
    `out->write( |${IMG_LINE_PREFIX}OBJ activity=[] kind=[customizing_object] | &&`,
    `  |objtype=[{ lv_objtype }] name=[${object}] title=[]| ).`,
    // OBJH and OBJS share the same OBJECTTYPE vocabulary (C/S/V), so the type carries over here.
    `SELECT ${fOT_table} FROM ${objTable}`,
    `  WHERE ${fOT_object} = '${objectLit}' AND ${fOT_objectType} = @lv_objtype`,
    `  INTO TABLE @DATA(lt_tabs)`,
    `  UP TO 50 ROWS.`,
    ...selectGuard("no tables linked to this customizing object"),
    `LOOP AT lt_tabs INTO DATA(ls_tab).`,
    `  SELECT SINGLE ${fT_clidep}, ${fT_delclass} FROM ${ddicTable}`,
    `    WHERE ${fT_table} = @ls_tab-${fOT_table} AND ${fT_active} = 'A'`,
    `    INTO (@DATA(lv_tab_clidep), @DATA(lv_tab_delclass)).`,
    `  IF sy-subrc <> 0.`,
    `    CLEAR lv_tab_clidep.`,
    `    CLEAR lv_tab_delclass.`,
    `  ENDIF.`,
    `  out->write( |${IMG_LINE_PREFIX}TAB object=[${object}] table=[{ ls_tab-${fOT_table} }] | &&`,
    `    |clidep=[{ lv_tab_clidep }] delclass=[{ lv_tab_delclass }] via=[OBJS] title=[]| ).`,
    `ENDLOOP.`,
  ];

  return { data: [], body };
}

/** No catalog table for reports/programs is recorded — say so rather than guessing one. No SQL here, so no literal to quote. */
function objectsReportFragment(object: string): { data: string[]; body: string[] } {
  const body: string[] = [
    `out->write( |${IMG_LINE_PREFIX}OBJ activity=[] kind=[report] objtype=[] name=[${object}] title=[]| ).`,
    `out->write( |${IMG_LINE_PREFIX}NOTE text=[no catalog table for reports is defined in this bridge]| ).`,
  ];
  return { data: [], body };
}

function objectsAutoFragment(object: string, objectLit: string): { data: string[]; body: string[] } {
  const tstc = tbl("transaction");
  const fTC_tcode = fld("transaction", "transaction");
  const ddicTable = tbl("ddicTable");
  const fDT_table = fld("ddicTable", "table");
  const fDT_active = fld("ddicTable", "activeState");
  const viewHeader = tbl("viewHeader");
  const fVH_view = fld("viewHeader", "view");
  const fVH_active = fld("viewHeader", "activeState");
  const viewCluster = tbl("viewCluster");
  const fVC_cluster = fld("viewCluster", "cluster");
  const objHeader = tbl("cusObjectHeader");
  const fOH_object = fld("cusObjectHeader", "object");
  const fOH_objectType = fld("cusObjectHeader", "objectType");

  const body: string[] = [
    `SELECT SINGLE ${fTC_tcode} FROM ${tstc} WHERE ${fTC_tcode} = '${objectLit}' INTO @DATA(lv_tcode).`,
    `IF sy-subrc = 0.`,
    `  out->write( |${IMG_LINE_PREFIX}OBJ activity=[] kind=[transaction] objtype=[] name=[${object}] title=[]| ).`,
    `  RETURN.`,
    `ENDIF.`,
    `SELECT SINGLE ${fDT_table} FROM ${ddicTable}`,
    `  WHERE ${fDT_table} = '${objectLit}' AND ${fDT_active} = 'A'`,
    `  INTO @DATA(lv_tabname).`,
    `IF sy-subrc = 0.`,
    `  out->write( |${IMG_LINE_PREFIX}OBJ activity=[] kind=[table] objtype=[] name=[${object}] title=[]| ).`,
    `  RETURN.`,
    `ENDIF.`,
    `SELECT SINGLE ${fVH_view} FROM ${viewHeader}`,
    `  WHERE ${fVH_view} = '${objectLit}' AND ${fVH_active} = 'A'`,
    `  INTO @DATA(lv_viewname).`,
    `IF sy-subrc = 0.`,
    `  out->write( |${IMG_LINE_PREFIX}OBJ activity=[] kind=[view] objtype=[] name=[${object}] title=[]| ).`,
    `  RETURN.`,
    `ENDIF.`,
    `SELECT SINGLE ${fVC_cluster} FROM ${viewCluster} WHERE ${fVC_cluster} = '${objectLit}' INTO @DATA(lv_clustername).`,
    `IF sy-subrc = 0.`,
    `  out->write( |${IMG_LINE_PREFIX}OBJ activity=[] kind=[cluster] objtype=[] name=[${object}] title=[]| ).`,
    `  RETURN.`,
    `ENDIF.`,
    `SELECT SINGLE ${fOH_object}, ${fOH_objectType} FROM ${objHeader}`,
    `  WHERE ${fOH_object} = '${objectLit}'`,
    `  INTO (@DATA(lv_objname), @DATA(lv_auto_objtype)).`,
    `IF sy-subrc = 0.`,
    `  out->write( |${IMG_LINE_PREFIX}OBJ activity=[] kind=[customizing_object] | &&`,
    `    |objtype=[{ lv_auto_objtype }] name=[${object}] title=[]| ).`,
    `  RETURN.`,
    `ENDIF.`,
    `out->write( |${IMG_LINE_PREFIX}OBJ activity=[] kind=[unknown] objtype=[] name=[${object}] title=[]| ).`,
    `out->write( |${IMG_LINE_PREFIX}NOTE text=[object not found in any catalog table this bridge checks]| ).`,
  ];

  return { data: [], body };
}

function objectsFragment(q: ImgObjectsQuery): { data: string[]; body: string[] } {
  const language = assertLanguage(q.language);
  const object = assertObjectName(q.object);
  const langLit = sqlQuote(language);
  const objectLit = sqlQuote(object);

  switch (q.kind) {
    case "table":
      return objectsTableFragment(object, objectLit, langLit);
    case "view":
      return objectsViewFragment(object, objectLit, langLit);
    case "cluster":
      return objectsClusterFragment(object, objectLit, langLit);
    case "transaction":
      return objectsTransactionFragment(object, objectLit, langLit);
    case "customizing_object":
      return objectsCustomizingFragment(object, objectLit);
    case "report":
      return objectsReportFragment(object);
    case "unknown":
    case undefined:
      return objectsAutoFragment(object, objectLit);
  }
}

export function imgBridgeSource(q: ImgQuery): string {
  validateImgQuery(q);
  let frag: { data: string[]; body: string[] };
  switch (q.mode) {
    case "search":
      frag = searchFragment(q);
      break;
    case "show":
      frag = showFragment(q);
      break;
    case "tree":
      frag = treeFragment(q);
      break;
    case "objects":
      frag = objectsFragment(q);
      break;
  }
  return ddicBridgeSource(imgBridgeClassName(q.mode), frag.data, frag.body);
}

// abapsmith's own kind taxonomy — unrelated to SAP's OBJECTTYPE codes, which come in two
// incompatible vocabularies (CUS_ACTOBJ's D/S vs OBJH/OBJS's C/S/V) passed through as objtype.
const KNOWN_OBJECT_KINDS: readonly ImgObjectKind[] = [
  "view",
  "cluster",
  "transaction",
  "table",
  "report",
  "customizing_object",
  "unknown",
];

/**
 * Every emitted line puts its one free-text field (a SAP-authored title or
 * note) last — `parseBracketFields`'s lazy `]`-then-next-`key=[` match would
 * mis-split on an embedded "] word=[" if free text came before another field.
 */
export function parseImgTranscript(text: string): ImgTranscript {
  const result: ImgTranscript = {
    total: null,
    page: null,
    activities: [],
    path: [],
    nodes: [],
    objects: [],
    tables: [],
    fields: [],
    docs: [],
    notes: [],
    errors: [],
    droppedLines: 0,
    raw: text,
  };

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith(IMG_LINE_PREFIX)) {
      const rest = line.slice(IMG_LINE_PREFIX.length);
      const spaceIdx = rest.indexOf(" ");
      const head = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
      const remainder = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);
      const fields = parseBracketFields(remainder);

      switch (head) {
        case "TOTAL": {
          const n = Number(fields.n);
          if (fields.n === undefined || Number.isNaN(n)) {
            result.droppedLines++;
            break;
          }
          result.total = n;
          break;
        }
        case "PAGE": {
          const offset = Number(fields.offset);
          const limit = Number(fields.limit);
          if (fields.offset === undefined || fields.limit === undefined || fields.more === undefined || Number.isNaN(offset) || Number.isNaN(limit)) {
            result.droppedLines++;
            break;
          }
          result.page = { offset, limit, more: fields.more === "X" };
          break;
        }
        case "ACT": {
          const objects = Number(fields.objects);
          const nodes = Number(fields.nodes);
          if (fields.activity === undefined || fields.objects === undefined || fields.nodes === undefined || fields.title === undefined || Number.isNaN(objects) || Number.isNaN(nodes)) {
            result.droppedLines++;
            break;
          }
          result.activities.push({ activity: fields.activity, objects, nodes, title: fields.title });
          break;
        }
        case "APATH": {
          const position = Number(fields.pos);
          if (fields.activity === undefined || fields.pos === undefined || fields.node === undefined || fields.title === undefined || Number.isNaN(position)) {
            result.droppedLines++;
            break;
          }
          result.path.push({ activity: fields.activity, position, node: fields.node, title: fields.title });
          break;
        }
        case "NODE": {
          if (fields.node === undefined || fields.parent === undefined || fields.kind === undefined || fields.activity === undefined || fields.title === undefined) {
            result.droppedLines++;
            break;
          }
          if (fields.kind !== "folder" && fields.kind !== "activity") {
            result.droppedLines++;
            break;
          }
          const childrenRaw = fields.children;
          const childrenNum = childrenRaw === undefined ? NaN : Number(childrenRaw);
          const children = childrenRaw === undefined || childrenRaw === "" || Number.isNaN(childrenNum) ? null : childrenNum;
          result.nodes.push({ node: fields.node, parent: fields.parent, kind: fields.kind, activity: fields.activity, children, title: fields.title });
          break;
        }
        case "OBJ": {
          if (fields.activity === undefined || fields.kind === undefined || fields.name === undefined || fields.title === undefined) {
            result.droppedLines++;
            break;
          }
          const kind = (KNOWN_OBJECT_KINDS as readonly string[]).includes(fields.kind) ? (fields.kind as ImgObjectKind) : "unknown";
          result.objects.push({ activity: fields.activity, kind, objectType: fields.objtype ?? "", name: fields.name, title: fields.title });
          break;
        }
        case "TAB": {
          if (fields.object === undefined || fields.table === undefined || fields.via === undefined || fields.title === undefined) {
            result.droppedLines++;
            break;
          }
          result.tables.push({
            object: fields.object,
            table: fields.table,
            clientDependent: fields.clidep === "X",
            deliveryClass: fields.delclass ?? "",
            via: fields.via,
            title: fields.title,
          });
          break;
        }
        case "FLD": {
          const position = Number(fields.pos);
          if (fields.table === undefined || fields.field === undefined || fields.pos === undefined || fields.type === undefined || fields.len === undefined || fields.rollname === undefined || Number.isNaN(position)) {
            result.droppedLines++;
            break;
          }
          result.fields.push({ table: fields.table, field: fields.field, key: fields.key === "X", position, dataType: fields.type, length: fields.len, dataElement: fields.rollname });
          break;
        }
        case "DOC": {
          if (fields.activity === undefined || fields.class === undefined || fields.name === undefined) {
            result.droppedLines++;
            break;
          }
          result.docs.push({ activity: fields.activity, docClass: fields.class, docName: fields.name });
          break;
        }
        case "NOTE": {
          if (fields.text === undefined) {
            result.droppedLines++;
            break;
          }
          result.notes.push(fields.text);
          break;
        }
        default:
          result.droppedLines++;
      }
    } else if (line.startsWith(DDIC_ERR_PREFIX)) {
      result.errors.push(line.slice(DDIC_ERR_PREFIX.length).trim());
    } else if (line.startsWith(ERR_LINE_PREFIX)) {
      result.errors.push(line.slice(ERR_LINE_PREFIX.length).trim());
    } else if (line.trim() === "") {
      // blank — ignored
    } else {
      result.droppedLines++;
    }
  }

  return result;
}

export async function runImgRead(conn: AbapConnection, query: ImgQuery, gate: SafetyGate): Promise<ImgReadResult> {
  const started = Date.now();
  validateImgQuery(query);
  const className = imgBridgeClassName(query.mode);
  const source = imgBridgeSource(query);

  const deployed = await deployBridge(conn, gate, {
    className,
    source,
    description: "abapsmith IMG catalog reader",
    packageName: IMG_BRIDGE_PACKAGE,
    what: `Activation of the generated IMG ${query.mode} bridge`,
    hint:
      "The bridge only SELECTs from catalog tables named in img-catalog.ts, none of which have " +
      "been confirmed against a live system — a syntax error here most likely means one of those " +
      "table or field names is wrong.",
    verify: (activation) => verifyBridgeActivation(activation, className, "IMG bridge", { mode: query.mode }),
  });
  const { bridgeRefreshed } = deployed;

  const run = await executeBridge(conn, gate, deployed);
  const transcript = parseImgTranscript(run.output);

  return {
    query,
    bridgeClass: className,
    bridgeRefreshed,
    durationMs: Date.now() - started,
    transcript,
    outputComplete: run.outputComplete,
    bodyBytes: run.bodyBytes,
  };
}
