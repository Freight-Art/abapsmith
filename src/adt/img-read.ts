/**
 * IMG (SPRO customizing) reads, orchestrated over `img-query.ts`'s SQL
 * builders and `AbapConnection.dataPreviewFreestyle`. This is the read-only
 * replacement for the withdrawn `img-bridge.ts` route (generate an ABAP
 * class, deploy it, activate it, POST to the classrun endpoint): that route
 * called `deployBridge`, which authorizes as a "write" unconditionally, so
 * `ABAP_MODE=read` refused the tool outright — in exactly the mode it belongs
 * in — and it deployed a class when the tool is specified to create nothing.
 * This module creates nothing: every read is one or more plain-text
 * `SELECT`s through the freestyle preview endpoint.
 *
 * This module never calls `img-bridge.ts` and is not called by it. It does
 * not write SQL of its own beyond what `buildSelect`/the builders in
 * `img-query.ts` already produce — it decides which builders a mode needs,
 * issues them, and assembles the returned records into a transcript.
 *
 * `raw` on the transcript is the concatenation of every response body this
 * call issued, newline-joined in issue order — the closest equivalent to the
 * old bridge's raw classrun output, and enough to recover exactly what was
 * asked and answered if a caller needs to audit a read.
 */
import { AbapError } from "./errors.js";
import { parsePreviewBody } from "./datapreview.js";
import {
  IMG_ACTIVITY_REF_TYPE,
  IMG_CATALOG,
  type ImgCatalogKey,
} from "./img-catalog.js";
import {
  MAX_IN_LIST,
  buildActivityHeaderQuery,
  buildActivityHeadersByIdQuery,
  buildActivityIdSearchQuery,
  buildActivityObjectsQuery,
  buildActivityTitleSearchQuery,
  buildActivityTitlesQuery,
  buildNodeRefsQuery,
  buildNodesByRefObjectQuery,
  buildObjectHeadersQuery,
  buildObjectTablesQuery,
  buildObjectTextsQuery,
  buildTableDeliveryClassQuery,
  buildTableFieldsQuery,
  buildTableTextsQuery,
  buildTransactionTextsQuery,
  buildTransactionsQuery,
  buildTreeChildrenQuery,
  buildTreeDirectoryQuery,
  buildTreeNodeByIdQuery,
  buildTreeNodeQuery,
  buildTreeRootProbeQuery,
  buildViewBaseTablesQuery,
  buildViewClusterMembersQuery,
  buildViewClusterQuery,
  buildViewClusterTextQuery,
  buildViewFieldsQuery,
  buildViewHeaderQuery,
  buildViewTextQuery,
  requireColumn,
  toRecordSet,
  type PreviewRecord,
  type PreviewRecordSet,
} from "./img-query.js";

// ------------------------------------------------------------------ tuning ---

/** Caller-facing page size ceiling for search/tree listings. */
export const IMG_PAGE_MAX = 200;
export const IMG_PAGE_DEFAULT = 25;

/**
 * Upper bound on how many DD03L/CUS_ACTOBJ/etc. detail rows a single
 * non-paged lookup fetches in one call. Not a caller-facing page size — this
 * exists only so one activity or table with an unusually large number of
 * linked rows still gets a bounded, single-statement fetch instead of an
 * unbounded one.
 */
const IMG_READ_ROW_CAP = 200;

/**
 * How many children of one parent are fetched in a single call so the
 * BROTHER_ID chain can be walked in full before the caller's own page/limit
 * is applied (see `orderImgTreeSiblings`). `buildTreeChildrenQuery`'s
 * `ORDER BY n~NODE_ID` is GUID order, unrelated to display order, so display
 * order can only be reconstructed once the whole sibling set for this parent
 * is in hand — walking a partial fetch would risk stopping the chain early
 * and reporting a truncated, wrongly-ordered page. 1000 is comfortably above
 * any sibling count seen in discovery (the reference IMG's largest observed
 * parent has 30 children) while still being one bounded statement.
 */
const TREE_CHILDREN_FETCH_CAP = 1000;

/**
 * Bound on how many PARENT_ID hops `walkImgPath` (show mode's reference-IMG
 * ancestor walk) will follow before giving up and reporting a cut-off note
 * rather than climbing indefinitely. 32 is generous — nothing in this
 * module's own discovery data comes close to it — chosen as a safety net
 * against a corrupt or unexpectedly deep PARENT_ID chain, not a tuned
 * measurement of real tree depth.
 */
const IMG_PATH_MAX_DEPTH = 32;

function assertLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > IMG_PAGE_MAX) {
    throw new AbapError("BAD_INPUT", `limit ${value} must be an integer between 1 and ${IMG_PAGE_MAX}.`, { value });
  }
  return value;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

// -------------------------------------------------------------- catalog io ---

function tbl<K extends ImgCatalogKey>(key: K): string {
  return IMG_CATALOG[key].table;
}

function fld<K extends ImgCatalogKey, F extends keyof (typeof IMG_CATALOG)[K]["fields"]>(key: K, field: F): string {
  const fields = IMG_CATALOG[key].fields as Record<F, string>;
  return fields[field];
}

// ------------------------------------------------------------------- query ---

export type ImgMode = "search" | "show" | "tree" | "objects";

export type ImgObjectKind = "table" | "view" | "cluster" | "transaction" | "customizing_object" | "report" | "unknown";

export interface ImgSearchQuery {
  mode: "search";
  /** Matched against both activity id and activity title (see `imgLikePattern`). */
  text: string;
  language: string;
  after?: string;
  limit: number;
}

export interface ImgShowQuery {
  mode: "show";
  activity: string;
  language: string;
}

export interface ImgTreeQuery {
  mode: "tree";
  /**
   * Not in the old bridge's shape — added because a bare `node` id does not
   * say which tree it belongs to once REF mounts are in play (a REF node's
   * children live in a *different* tree's node-id space). Omitted, the
   * reference IMG is discovered via `buildTreeRootProbeQuery`, same as the
   * old tool's implicit default; supplying it (e.g. the `treeId` returned on
   * a previous page, or one reached by following a REF) bypasses that probe
   * entirely, including its English-only limitation.
   */
  treeId?: string;
  /** Node whose children are listed. Omitted: that tree's own root (or, with no treeId either, the reference IMG's root). */
  node?: string;
  language: string;
  after?: string;
  limit: number;
}

export interface ImgObjectsQuery {
  mode: "objects";
  object: string;
  language: string;
  /** Omitted: probed in this order — table, view, cluster, transaction, customizing object. */
  kind?: ImgObjectKind;
}

export type ImgQuery = ImgSearchQuery | ImgShowQuery | ImgTreeQuery | ImgObjectsQuery;

// --------------------------------------------------------------------- rows ---

export interface ImgActivityRow {
  activity: string;
  title: string;
  /**
   * Linked CUS_ACTOBJ rows. Populated for real in `show` mode (one activity,
   * one already-necessary batched query). `null` in `search` mode: getting
   * an exact count per page row would cost one extra round-trip per
   * activity, and no batched "count of objects per activity" builder exists
   * to do it in one call — see the divergence note in the module docs.
   */
  objects: number | null;
  /**
   * How many distinct TNODEIMGR nodes mount this activity (REF_TYPE
   * `IMG_ACTIVITY_REF_TYPE`) — `0` when the activity exists but is mounted
   * nowhere. Populated for real in `show` mode, where `walkImgPath` already
   * has to issue this lookup to build `ImgTranscript.path`; the earlier
   * claim that no activity-to-tree-node link table existed at all
   * (`IMG_CATALOG.imgStructure`, `table: "UNRESOLVED"`) was about a
   * different, never-found table and did not survive the second discovery
   * pass that found TNODEIMGR. Still `null` in `search` mode: getting a
   * real count per page row would cost one extra round-trip per activity,
   * same round-trip-cost reason `objects` stays `null` there.
   */
  nodes: number | null;
}

export type ImgNodeKind = "folder" | "activity" | "ref";

export interface ImgNodeRow {
  node: string;
  parent: string;
  kind: ImgNodeKind;
  /** CUS_IMGACH activity id, only for `kind: "activity"`; "" otherwise. */
  activity: string;
  title: string;
  /**
   * Grandchild count for this row. Always `null` in this pass: the only
   * candidate field, TNODEIMG.W_SUBNODES, is a blank CHAR1 flag on this
   * system (see `img-catalog.ts`), and getting a real count needs a grouped
   * `COUNT(*) ... GROUP BY PARENT_ID` builder that does not exist among
   * `img-query.ts`'s 27 exports. Never `0` — `0` would claim a definite
   * childless leaf, which is not known.
   */
  children: number | null;
}

export interface ImgObjectRow {
  kind: ImgObjectKind;
  /** OBJH/OBJS's C/S/V vocabulary for customizing_object, "" for every other kind (those kinds have no analogous type column). */
  objectType: string;
  name: string;
  title: string;
}

export interface ImgTableRow {
  /** The customizing object or activity this table was reached through; "" when looked up directly (`objects` mode on a table). */
  object: string;
  table: string;
  clientDependent: boolean;
  deliveryClass: string;
  /** DD02L, or the join table this row's CLIDEP/CONTFLAG came via — always DD02L today; kept for the same reason `tablesQueried` exists. */
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
  docId: string;
}

// ----------------------------------------------------------------- transcript ---

export interface ImgPageState {
  after?: string;
  next?: string;
  limit: number;
  more: boolean;
}

/**
 * One step of the reference-IMG ancestor path to an activity, root-first
 * (`position` 0 is the tree root; the highest `position` is the activity
 * leaf itself). Shape matches `img-bridge.ts`'s `ImgPathRow` exactly and is
 * what `img-resolve.ts`'s `resolveActivity` already filters/sorts/maps by
 * `activity` and `position` — kept in lockstep on purpose, since a later
 * change repoints `img-resolve.ts` at this module instead of the bridge.
 */
export interface ImgPathRow {
  activity: string;
  position: number;
  node: string;
  title: string;
}

export interface ImgTranscript {
  /**
   * `<dataPreview:totalRows>` off the mode's primary listing query — see
   * `datapreview.ts`. `null` when the mode has no single query whose total
   * is meaningful: `show`/`objects` never page, and `search` issues two
   * independent listing queries (id-pattern, title-pattern) whose true
   * de-duplicated union total cannot be derived from either alone.
   */
  totalRows: number | null;
  page: ImgPageState | null;
  /** `tree` mode: the tree the listed nodes actually belong to (may differ from the caller's `treeId`/root-probe input after a REF redirect). `null` otherwise, or when the root probe found nothing. */
  treeId: string | null;
  activities: ImgActivityRow[];
  /**
   * The reference-IMG ancestor path to `show` mode's activity, root-first.
   * Empty (`[]`) for every other mode, and for `show` itself when the
   * activity exists but is not mounted in any IMG tree (see
   * `ImgActivityRow.nodes` and `walkImgPath`) — that is a real, reported
   * state, not a failure.
   */
  path: ImgPathRow[];
  nodes: ImgNodeRow[];
  objects: ImgObjectRow[];
  tables: ImgTableRow[];
  fields: ImgFieldRow[];
  docs: ImgDocRow[];
  notes: string[];
  /**
   * Always empty in this pass. A failure surfaces as a thrown `AbapError`
   * (`NOT_FOUND`/`BAD_INPUT`/`CHECK_FAILED`) rather than being swallowed into
   * a string here, matching every other `adt/*.ts` module in this repo. Kept
   * on the shape for parity with the old transcript and so a future in-band
   * partial-failure case has somewhere to go without a further shape change.
   */
  errors: string[];
  /** Every issued query's response body, in issue order, newline-joined. */
  raw: string;
}

export interface ImgReadResult {
  query: ImgQuery;
  /** How many `dataPreviewFreestyle` calls this read issued. */
  statementsIssued: number;
  /** Catalog tables this call actually touched — a fact, not the old tool's static per-mode guess. */
  tablesQueried: string[];
  durationMs: number;
  transcript: ImgTranscript;
}

// -------------------------------------------------------------- connection ---

/**
 * The one connection capability this module needs. Deliberately narrower
 * than `AbapConnection` (structurally compatible with it — a real connection
 * can be passed straight through) so a test can supply a minimal fake
 * without a full HTTP mock or a `connect()` handshake.
 */
export interface ImgReadConnection {
  dataPreviewFreestyle(sql: string, rowNumber: number): Promise<{ body: string }>;
}

interface ReadCtx {
  statementsIssued: number;
  tablesQueried: Set<string>;
  rawParts: string[];
}

function newCtx(): ReadCtx {
  return { statementsIssued: 0, tablesQueried: new Set(), rawParts: [] };
}

interface Issued {
  rs: PreviewRecordSet;
  totalRows?: number;
}

/**
 * Issues one statement and records it on `ctx`. Parses the body twice — once
 * through `toRecordSet` (the shared record-mapping this file must not
 * reimplement) and once through `parsePreviewBody` directly to read
 * `totalRows` (which `toRecordSet`/`PreviewRecordSet` do not carry) — a
 * small, deliberate cost in exchange for never hand-rolling the row mapping
 * `img-query.ts` already owns.
 */
async function issue(
  conn: ImgReadConnection,
  ctx: ReadCtx,
  sql: string,
  rowNumber: number,
  tables: string | readonly string[],
): Promise<Issued> {
  const resp = await conn.dataPreviewFreestyle(sql, rowNumber);
  ctx.statementsIssued++;
  ctx.rawParts.push(resp.body);
  for (const t of Array.isArray(tables) ? tables : [tables]) ctx.tablesQueried.add(t);
  const rs = toRecordSet(resp.body);
  const { totalRows } = parsePreviewBody(resp.body);
  return { rs, totalRows };
}

function serverNotes(rs: PreviewRecordSet): string[] {
  return rs.messages.map((m) => `[server] ${m.text}${m.severity ? ` (${m.severity})` : ""}`);
}

// ==================================================================== search ===

export async function readImgSearch(conn: ImgReadConnection, q: ImgSearchQuery): Promise<ImgReadResult> {
  const started = Date.now();
  const limit = assertLimit(q.limit);
  const ctx = newCtx();
  const notes: string[] = [];

  const ACT = fld("imgActivity", "activity");
  const TACT = fld("imgActivityText", "activity");
  const TTEXT = fld("imgActivityText", "text");

  const idResult = await issue(conn, ctx, buildActivityIdSearchQuery(q.text, q.after), limit + 1, tbl("imgActivity"));
  notes.push(...serverNotes(idResult.rs));
  const idIds = idResult.rs.records.map((r) => requireColumn(r, ACT));

  const titleResult = await issue(
    conn,
    ctx,
    buildActivityTitleSearchQuery(q.text, q.language, q.after),
    limit + 1,
    tbl("imgActivityText"),
  );
  notes.push(...serverNotes(titleResult.rs));
  const titleIds = titleResult.rs.records.map((r) => requireColumn(r, TACT));

  const merged = [...new Set([...idIds, ...titleIds])].sort();
  const more = merged.length > limit;
  const page = merged.slice(0, limit);
  const next = more ? page[page.length - 1] : undefined;

  const titleByActivity = new Map<string, string>();
  for (const r of titleResult.rs.records) {
    titleByActivity.set(requireColumn(r, TACT), requireColumn(r, TTEXT));
  }
  const missingTitles = page.filter((a) => !titleByActivity.has(a));
  if (missingTitles.length > 0) {
    for (const group of chunk(missingTitles, MAX_IN_LIST)) {
      const titlesResult = await issue(conn, ctx, buildActivityTitlesQuery(group, q.language), group.length, tbl("imgActivityText"));
      notes.push(...serverNotes(titlesResult.rs));
      for (const r of titlesResult.rs.records) {
        titleByActivity.set(requireColumn(r, TACT), requireColumn(r, TTEXT));
      }
    }
  }

  const activities: ImgActivityRow[] = page.map((activity) => ({
    activity,
    title: titleByActivity.get(activity) ?? "",
    objects: null,
    nodes: null,
  }));

  return {
    query: q,
    statementsIssued: ctx.statementsIssued,
    tablesQueried: [...ctx.tablesQueried],
    durationMs: Date.now() - started,
    transcript: {
      totalRows: null,
      page: { after: q.after, next, limit, more },
      treeId: null,
      activities,
      path: [],
      nodes: [],
      objects: [],
      tables: [],
      fields: [],
      docs: [],
      notes,
      errors: [],
      raw: ctx.rawParts.join("\n"),
    },
  };
}

// ====================================================================== show ===

/**
 * Finds the reference-IMG path to `activity` and climbs it to the root.
 *
 * 1. `buildNodesByRefObjectQuery` — the inverse of `buildNodeRefsQuery` —
 *    finds every TNODEIMGR node that mounts this activity (REF_TYPE
 *    `IMG_ACTIVITY_REF_TYPE`). Zero rows means the activity is a real,
 *    existing CUS_IMGACH row that simply is not mounted anywhere — reported
 *    as a note, not an error, with an empty path and `mountedNodes: 0`.
 *    More than one row is normal, not exotic (the same activity can be
 *    mounted by several different nodes); the first (lowest NODE_ID, for
 *    determinism) is walked, and a note names the count so a caller never
 *    silently gets "a" path without knowing more existed.
 * 2. TNODEIMGR carries no TREE_ID (see `img-catalog.ts`'s note on it), so
 *    `buildTreeNodeQuery` — which requires one — cannot run yet.
 *    `buildTreeNodeByIdQuery` (not part of the literal ask that named only
 *    `buildNodesByRefObjectQuery`, but required to act on its result: see
 *    that builder's own doc comment) looks the mounted node up by NODE_ID
 *    alone to learn its TREE_ID, bootstrapping every step after it.
 * 3. From there, `buildTreeNodeQuery(treeId, parentId, ...)` climbs
 *    PARENT_ID one hop at a time until it goes blank (root reached), the
 *    walk revisits a node already seen (cycle — same defensive posture as
 *    `orderImgTreeSiblings`), or `IMG_PATH_MAX_DEPTH` hops pass without
 *    reaching a blank PARENT_ID (cut-off). Both cycle and cut-off push an
 *    explanatory note and return whatever of the path was actually walked
 *    — never silently presented as the complete root-to-leaf chain.
 *
 * The activity leaf's own title is the one `readImgShow` already fetched
 * via CUS_IMGACT (`activityTitle`, passed in rather than re-queried);
 * ancestor folder titles come from TNODEIMGT, already LEFT-JOINed into
 * `buildTreeNodeByIdQuery`/`buildTreeNodeQuery`'s own result — the same
 * node-title split `readImgTree` already uses (see its own comment on why
 * an activity leaf's title never comes from TNODEIMGT).
 *
 * Returned root-first: the walk itself collects leaf-to-root, then reverses
 * before handing back, renumbering `position` 0..n-1 so `img-resolve.ts`'s
 * `.sort((a, b) => a.position - b.position)` reproduces this same order.
 */
async function walkImgPath(
  conn: ImgReadConnection,
  ctx: ReadCtx,
  notes: string[],
  activity: string,
  activityTitle: string,
  language: string,
): Promise<{ path: ImgPathRow[]; mountedNodes: number }> {
  const refsResult = await issue(
    conn,
    ctx,
    buildNodesByRefObjectQuery(activity, IMG_ACTIVITY_REF_TYPE),
    IMG_READ_ROW_CAP,
    tbl("imgTreeNodeRef"),
  );
  notes.push(...serverNotes(refsResult.rs));
  const nodeIds = [...new Set(refsResult.rs.records.map((r) => requireColumn(r, fld("imgTreeNodeRef", "nodeId"))))].sort();

  if (nodeIds.length === 0) {
    notes.push(
      `Activity "${activity}" has no ${tbl("imgTreeNodeRef")} row (REF_TYPE "${IMG_ACTIVITY_REF_TYPE}") — it exists but is not mounted in any IMG tree.`,
    );
    return { path: [], mountedNodes: 0 };
  }
  if (nodeIds.length > 1) {
    notes.push(
      `Activity "${activity}" is mounted at ${nodeIds.length} different ${tbl("imgTreeNodeRef")} nodes (${nodeIds.join(", ")}) — only the first was walked.`,
    );
  }
  const leafNodeId = nodeIds[0]!;

  const rootResult = await issue(conn, ctx, buildTreeNodeByIdQuery(leafNodeId, language), 1, [tbl("imgTreeNode"), tbl("imgTreeNodeText")]);
  notes.push(...serverNotes(rootResult.rs));
  if (rootResult.rs.records.length === 0) {
    notes.push(
      `Node "${leafNodeId}" is referenced by ${tbl("imgTreeNodeRef")} for activity "${activity}" but has no ${tbl("imgTreeNode")} row — cannot walk its ancestors.`,
    );
    return { path: [], mountedNodes: nodeIds.length };
  }
  const leafRec = rootResult.rs.records[0]!;
  const treeId = requireColumn(leafRec, fld("imgTreeNode", "treeId"));

  // Leaf-to-root order while walking; reversed to root-first once the climb is done.
  const chain: ImgPathRow[] = [{ activity, position: 0, node: leafNodeId, title: activityTitle }];
  const visited = new Set<string>([leafNodeId]);
  let parentId = requireColumn(leafRec, fld("imgTreeNode", "parentId"));
  let steps = 0;

  while (parentId.trim() !== "") {
    if (visited.has(parentId)) {
      notes.push(
        `Ancestor walk for activity "${activity}" revisited node "${parentId}" — TNODEIMG.PARENT_ID cycles here; the returned path stops at the point of the revisit, not the true root.`,
      );
      break;
    }
    if (steps >= IMG_PATH_MAX_DEPTH) {
      notes.push(
        `Ancestor walk for activity "${activity}" stopped after ${IMG_PATH_MAX_DEPTH} hops without reaching a blank PARENT_ID — the returned path is truncated, not the full root-to-leaf chain.`,
      );
      break;
    }
    const nodeResult = await issue(conn, ctx, buildTreeNodeQuery(treeId, parentId, language), 1, [tbl("imgTreeNode"), tbl("imgTreeNodeText")]);
    notes.push(...serverNotes(nodeResult.rs));
    if (nodeResult.rs.records.length === 0) {
      notes.push(
        `Ancestor node "${parentId}" of activity "${activity}"'s mount has no ${tbl("imgTreeNode")} row in tree "${treeId}" — the returned path stops here, not at the true root.`,
      );
      break;
    }
    const rec = nodeResult.rs.records[0]!;
    const nodeId = requireColumn(rec, fld("imgTreeNode", "nodeId"));
    chain.push({ activity, position: chain.length, node: nodeId, title: requireColumn(rec, fld("imgTreeNodeText", "text")) });
    visited.add(nodeId);
    steps++;
    parentId = requireColumn(rec, fld("imgTreeNode", "parentId"));
  }

  const rootFirst = chain
    .slice()
    .reverse()
    .map((row, i) => ({ ...row, position: i }));
  return { path: rootFirst, mountedNodes: nodeIds.length };
}

export async function readImgShow(conn: ImgReadConnection, q: ImgShowQuery): Promise<ImgReadResult> {
  const started = Date.now();
  const ctx = newCtx();
  const notes: string[] = [];
  const docs: ImgDocRow[] = [];
  const objects: ImgObjectRow[] = [];
  const tables: ImgTableRow[] = [];

  const H = {
    activity: fld("imgActivity", "activity"),
    cActivity: fld("imgActivity", "cActivity"),
    docId: fld("imgActivity", "docId"),
  };

  const headerResult = await issue(conn, ctx, buildActivityHeaderQuery(q.activity), 1, tbl("imgActivity"));
  notes.push(...serverNotes(headerResult.rs));
  if (headerResult.rs.records.length === 0) {
    throw new AbapError("NOT_FOUND", `No ${tbl("imgActivity")} row for activity "${q.activity}".`, { activity: q.activity });
  }
  const header = headerResult.rs.records[0]!;
  const cActivity = requireColumn(header, H.cActivity);
  const docId = requireColumn(header, H.docId);

  const titleResult = await issue(conn, ctx, buildActivityTitlesQuery([q.activity], q.language), 1, tbl("imgActivityText"));
  notes.push(...serverNotes(titleResult.rs));
  const title = titleResult.rs.records[0] ? requireColumn(titleResult.rs.records[0]!, fld("imgActivityText", "text")) : "";
  if (titleResult.rs.records.length === 0) {
    notes.push(`No ${tbl("imgActivityText")} title for activity "${q.activity}" in language "${q.language}".`);
  }

  const { path, mountedNodes } = await walkImgPath(conn, ctx, notes, q.activity, title, q.language);

  if (docId.trim() !== "") {
    docs.push({ activity: q.activity, docId });
  } else {
    notes.push(`Activity "${q.activity}" has no ${H.docId} value — no documentation entry.`);
  }

  let objectRows: readonly PreviewRecord[] = [];
  if (cActivity.trim() === "") {
    notes.push(`Activity "${q.activity}" has no ${H.cActivity} value — cannot resolve its customizing objects.`);
  } else {
    const actHeaderResult = await issue(conn, ctx, buildActivityHeadersByIdQuery([cActivity]), 1, tbl("cusActivityHeader"));
    notes.push(...serverNotes(actHeaderResult.rs));
    if (actHeaderResult.rs.records.length === 0) {
      notes.push(`No ${tbl("cusActivityHeader")} row for ACT_ID "${cActivity}" — cannot resolve this activity's customizing objects.`);
    } else {
      const objResult = await issue(conn, ctx, buildActivityObjectsQuery([cActivity]), IMG_READ_ROW_CAP, tbl("imgActivityObject"));
      notes.push(...serverNotes(objResult.rs));
      objectRows = objResult.rs.records;
    }
  }

  const OO = {
    objectType: fld("imgActivityObject", "objectType"),
    object: fld("imgActivityObject", "object"),
  };
  for (const r of objectRows) {
    objects.push({ kind: "unknown", objectType: requireColumn(r, OO.objectType), name: requireColumn(r, OO.object), title: "" });
  }

  const uniqueObjNames = [...new Set(objectRows.map((r) => requireColumn(r, OO.object)))];
  if (uniqueObjNames.length > 0) {
    const OT = {
      object: fld("cusObjectTable", "object"),
      table: fld("cusObjectTable", "table"),
    };
    const objTableRows: PreviewRecord[] = [];
    for (const group of chunk(uniqueObjNames, MAX_IN_LIST)) {
      const objTablesResult = await issue(conn, ctx, buildObjectTablesQuery(group), IMG_READ_ROW_CAP, tbl("cusObjectTable"));
      notes.push(...serverNotes(objTablesResult.rs));
      objTableRows.push(...objTablesResult.rs.records);
    }

    const tableNames = [...new Set(objTableRows.map((r) => requireColumn(r, OT.table)))];
    const dcByTable = new Map<string, { clientDependent: boolean; deliveryClass: string }>();
    const DT = {
      table: fld("ddicTable", "table"),
      clientDependent: fld("ddicTable", "clientDependent"),
      deliveryClass: fld("ddicTable", "deliveryClass"),
    };
    for (const group of chunk(tableNames, MAX_IN_LIST)) {
      const dcResult = await issue(conn, ctx, buildTableDeliveryClassQuery(group), group.length, tbl("ddicTable"));
      notes.push(...serverNotes(dcResult.rs));
      for (const r of dcResult.rs.records) {
        dcByTable.set(requireColumn(r, DT.table), {
          clientDependent: requireColumn(r, DT.clientDependent) === "X",
          deliveryClass: requireColumn(r, DT.deliveryClass),
        });
      }
    }

    for (const r of objTableRows) {
      const object = requireColumn(r, OT.object);
      const table = requireColumn(r, OT.table);
      const dc = dcByTable.get(table);
      if (dc === undefined) {
        notes.push(`No active ${tbl("ddicTable")} row for table "${table}" (via object "${object}").`);
      }
      tables.push({
        object,
        table,
        clientDependent: dc?.clientDependent ?? false,
        deliveryClass: dc?.deliveryClass ?? "",
        via: tbl("ddicTable"),
        title: "",
      });
    }
  }

  return {
    query: q,
    statementsIssued: ctx.statementsIssued,
    tablesQueried: [...ctx.tablesQueried],
    durationMs: Date.now() - started,
    transcript: {
      totalRows: null,
      page: null,
      treeId: null,
      activities: [{ activity: q.activity, title, objects: objectRows.length, nodes: mountedNodes }],
      path,
      nodes: [],
      objects,
      tables,
      fields: [],
      docs,
      notes,
      errors: [],
      raw: ctx.rawParts.join("\n"),
    },
  };
}

// ====================================================================== tree ===

/** One TNODEIMG row as returned by `buildTreeChildrenQuery`/`buildTreeNodeQuery`, before display ordering. */
export interface ImgTreeSibling {
  nodeId: string;
  nodeType: string;
  parentId: string;
  /** Names this sibling's PREVIOUS sibling; "" for the first child. See `orderImgTreeSiblings`. */
  brotherId: string;
  refTreeId: string;
  refNodeId: string;
  text: string;
}

/**
 * Reconstructs TNODEIMG display order from the BROTHER_ID chain.
 *
 * Read this twice: BROTHER_ID names a node's PREVIOUS sibling, not its next
 * one. The child whose own BROTHER_ID is blank is the FIRST child; walking
 * forward means repeatedly finding the sibling whose BROTHER_ID equals the
 * id currently on. Getting this backwards renders the entire IMG upside
 * down (`img-catalog.ts`'s `imgTreeNode` note is the authoritative source —
 * some of this repo's own earlier discovery-run prose states the opposite
 * and is wrong).
 *
 * The chain is not a clean linked list on a real system: more than one
 * sibling under a real parent has been seen sharing one BROTHER_ID value,
 * and a BROTHER_ID has been seen naming a node that isn't among that
 * parent's children at all. This walker tolerates both: it starts at the
 * blank-BROTHER_ID node, stops the instant it would revisit an already-
 * emitted node (which also stops a cycle formed entirely from bad pointers),
 * and appends every sibling the walk never reached, in the order `siblings`
 * was given, rather than dropping them. Every input row appears in the
 * output exactly once.
 */
export function orderImgTreeSiblings(siblings: readonly ImgTreeSibling[]): ImgTreeSibling[] {
  const byPreviousSibling = new Map<string, ImgTreeSibling[]>();
  for (const s of siblings) {
    const list = byPreviousSibling.get(s.brotherId);
    if (list) list.push(s);
    else byPreviousSibling.set(s.brotherId, [s]);
  }

  const visited = new Set<string>();
  const ordered: ImgTreeSibling[] = [];
  let current = (byPreviousSibling.get("") ?? [])[0];
  while (current !== undefined && !visited.has(current.nodeId)) {
    visited.add(current.nodeId);
    ordered.push(current);
    const candidates = byPreviousSibling.get(current.nodeId) ?? [];
    current = candidates.find((c) => !visited.has(c.nodeId));
  }

  for (const s of siblings) {
    if (!visited.has(s.nodeId)) {
      visited.add(s.nodeId);
      ordered.push(s);
    }
  }
  return ordered;
}

function nodeKind(nodeType: string, notes: string[]): ImgNodeKind {
  if (nodeType === "IMG0") return "folder";
  if (nodeType === "IMG") return "activity";
  if (nodeType === "REF") return "ref";
  notes.push(`Unrecognised TNODEIMG.NODE_TYPE "${nodeType}" — rendered as folder.`);
  return "folder";
}

function toTreeSibling(r: PreviewRecord): ImgTreeSibling {
  const F = IMG_CATALOG.imgTreeNode.fields;
  const textF = fld("imgTreeNodeText", "text");
  return {
    nodeId: requireColumn(r, F.nodeId),
    nodeType: requireColumn(r, F.nodeType),
    parentId: requireColumn(r, F.parentId),
    brotherId: requireColumn(r, F.brotherId),
    refTreeId: requireColumn(r, F.refTreeId),
    refNodeId: requireColumn(r, F.refNodeId),
    text: requireColumn(r, textF),
  };
}

interface TreeLocation {
  treeId: string;
  parentId: string;
}

/**
 * Resolves a caller-supplied node before listing its children: if it is a
 * REF mount, follow REFTREE_ID/REFNODE_ID (or, when REFNODE_ID is blank,
 * that tree's own `TTREE.NODE_ID` root) so the children query runs against
 * the tree the node actually mounts, not the tree it was found in.
 */
async function resolveRefMount(
  conn: ImgReadConnection,
  ctx: ReadCtx,
  notes: string[],
  loc: TreeLocation,
  language: string,
): Promise<TreeLocation> {
  const nodeResult = await issue(conn, ctx, buildTreeNodeQuery(loc.treeId, loc.parentId, language), 1, [
    tbl("imgTreeNode"),
    tbl("imgTreeNodeText"),
  ]);
  notes.push(...serverNotes(nodeResult.rs));
  if (nodeResult.rs.records.length === 0) {
    // Let the subsequent children query answer (correctly, emptily) rather than guessing here.
    return loc;
  }
  const rec = nodeResult.rs.records[0]!;
  const F = IMG_CATALOG.imgTreeNode.fields;
  if (requireColumn(rec, F.nodeType) !== "REF") return loc;

  const refTreeId = requireColumn(rec, F.refTreeId);
  const refNodeId = requireColumn(rec, F.refNodeId);
  if (refNodeId.trim() !== "") {
    return { treeId: refTreeId, parentId: refNodeId };
  }

  const dirResult = await issue(conn, ctx, buildTreeDirectoryQuery([refTreeId]), 1, tbl("treeDirectory"));
  notes.push(...serverNotes(dirResult.rs));
  if (dirResult.rs.records.length === 0) {
    throw new AbapError("NOT_FOUND", `REF node "${loc.parentId}" mounts tree "${refTreeId}", which has no ${tbl("treeDirectory")} entry.`, {
      node: loc.parentId,
      refTreeId,
    });
  }
  const rootNodeId = requireColumn(dirResult.rs.records[0]!, fld("treeDirectory", "rootNodeId"));
  notes.push(
    `Node "${loc.parentId}" is a REF mount with a blank REFNODE_ID; entered mounted tree "${refTreeId}" at its ${tbl("treeDirectory")}.${fld("treeDirectory", "rootNodeId")} root "${rootNodeId}" instead.`,
  );
  return { treeId: refTreeId, parentId: rootNodeId };
}

function emptyTreeResult(q: ImgTreeQuery, ctx: ReadCtx, notes: string[], started: number): ImgReadResult {
  return {
    query: q,
    statementsIssued: ctx.statementsIssued,
    tablesQueried: [...ctx.tablesQueried],
    durationMs: Date.now() - started,
    transcript: {
      totalRows: null,
      page: { after: q.after, limit: assertLimit(q.limit), more: false },
      treeId: null,
      activities: [],
      path: [],
      nodes: [],
      objects: [],
      tables: [],
      fields: [],
      docs: [],
      notes,
      errors: [],
      raw: ctx.rawParts.join("\n"),
    },
  };
}

export async function readImgTree(conn: ImgReadConnection, q: ImgTreeQuery): Promise<ImgReadResult> {
  const started = Date.now();
  const limit = assertLimit(q.limit);
  const ctx = newCtx();
  const notes: string[] = [];

  let treeId = q.treeId;
  let parentId = q.node;

  if (treeId === undefined) {
    const probeResult = await issue(conn, ctx, buildTreeRootProbeQuery(q.language), 5, tbl("imgTreeNodeText"));
    notes.push(...serverNotes(probeResult.rs));
    if (probeResult.rs.records.length === 0) {
      notes.push(
        `No reference-IMG root found by title probe in language "${q.language}". The probe matches ` +
          `${tbl("imgTreeNodeText")}.${fld("imgTreeNodeText", "text")} against the English phrase ` +
          `"SAP Customizing Implementation*" regardless of the requested language, so a system whose ` +
          `customizing texts are not installed in English will never match here — this is an ` +
          `explained empty result, not a failure. Pass an explicit treeId to bypass the probe.`,
      );
      return emptyTreeResult(q, ctx, notes, started);
    }
    const rec = probeResult.rs.records[0]!;
    treeId = requireColumn(rec, fld("imgTreeNodeText", "treeId"));
    if (parentId === undefined) parentId = requireColumn(rec, fld("imgTreeNodeText", "nodeId"));
  }

  if (parentId === undefined) {
    const dirResult = await issue(conn, ctx, buildTreeDirectoryQuery([treeId]), 1, tbl("treeDirectory"));
    notes.push(...serverNotes(dirResult.rs));
    if (dirResult.rs.records.length === 0) {
      throw new AbapError("NOT_FOUND", `No ${tbl("treeDirectory")} entry for tree "${treeId}".`, { treeId });
    }
    parentId = requireColumn(dirResult.rs.records[0]!, fld("treeDirectory", "rootNodeId"));
  } else if (q.node !== undefined) {
    const resolved = await resolveRefMount(conn, ctx, notes, { treeId, parentId }, q.language);
    treeId = resolved.treeId;
    parentId = resolved.parentId;
  }

  const childrenResult = await issue(conn, ctx, buildTreeChildrenQuery(treeId, parentId, q.language), TREE_CHILDREN_FETCH_CAP, [
    tbl("imgTreeNode"),
    tbl("imgTreeNodeText"),
  ]);
  notes.push(...serverNotes(childrenResult.rs));
  const rawSiblings = childrenResult.rs.records.map(toTreeSibling);
  if (childrenResult.totalRows !== undefined && childrenResult.totalRows > rawSiblings.length) {
    notes.push(
      `Parent "${parentId}" reports ${childrenResult.totalRows} total children but only ${rawSiblings.length} were ` +
        `fetched (internal fetch cap ${TREE_CHILDREN_FETCH_CAP}) — BROTHER_ID ordering past the fetched set cannot be trusted.`,
    );
  }

  const ordered = orderImgTreeSiblings(rawSiblings);

  let startIdx = 0;
  if (q.after !== undefined) {
    const idx = ordered.findIndex((s) => s.nodeId === q.after);
    if (idx === -1) {
      throw new AbapError("BAD_INPUT", `after cursor "${q.after}" is not one of parent "${parentId}"'s children.`, {
        after: q.after,
        parentId,
      });
    }
    startIdx = idx + 1;
  }
  const pageSiblings = ordered.slice(startIdx, startIdx + limit);
  const more = startIdx + limit < ordered.length;
  const next = more ? pageSiblings[pageSiblings.length - 1]?.nodeId : undefined;

  // Activity leaves (NODE_TYPE IMG) get their title from CUS_IMGACT via the
  // node's COBJ reference — never from TNODEIMGT, and never via an ACTI
  // reference the same node may also carry (see module docs).
  const leafNodeIds = [...new Set(pageSiblings.filter((s) => s.nodeType === "IMG").map((s) => s.nodeId))];
  const activityByNode = new Map<string, string>();
  const titleByActivity = new Map<string, string>();
  if (leafNodeIds.length > 0) {
    const RF = {
      nodeId: fld("imgTreeNodeRef", "nodeId"),
      refType: fld("imgTreeNodeRef", "refType"),
      refObject: fld("imgTreeNodeRef", "refObject"),
    };
    for (const group of chunk(leafNodeIds, MAX_IN_LIST)) {
      const refsResult = await issue(conn, ctx, buildNodeRefsQuery(group), IMG_READ_ROW_CAP, tbl("imgTreeNodeRef"));
      notes.push(...serverNotes(refsResult.rs));
      for (const r of refsResult.rs.records) {
        // Defence in depth: buildNodeRefsQuery already filters REF_TYPE=COBJ
        // server-side, so this is never expected to drop a row — but a node
        // commonly carries BOTH a COBJ and an ACTI reference, and the ACTI
        // one is explicitly not the title source, so this stays a real
        // (tested) guard rather than dead code.
        if (requireColumn(r, RF.refType) !== IMG_ACTIVITY_REF_TYPE) continue;
        activityByNode.set(requireColumn(r, RF.nodeId), requireColumn(r, RF.refObject));
      }
    }
    const activities = [...new Set(activityByNode.values())];
    for (const group of chunk(activities, MAX_IN_LIST)) {
      const titlesResult = await issue(conn, ctx, buildActivityTitlesQuery(group, q.language), group.length, tbl("imgActivityText"));
      notes.push(...serverNotes(titlesResult.rs));
      for (const r of titlesResult.rs.records) {
        titleByActivity.set(requireColumn(r, fld("imgActivityText", "activity")), requireColumn(r, fld("imgActivityText", "text")));
      }
    }
  }

  const nodes: ImgNodeRow[] = pageSiblings.map((s) => {
    const kind = nodeKind(s.nodeType, notes);
    const activity = kind === "activity" ? (activityByNode.get(s.nodeId) ?? "") : "";
    const title = kind === "activity" ? (activity ? (titleByActivity.get(activity) ?? "") : "") : s.text;
    return { node: s.nodeId, parent: s.parentId, kind, activity, title, children: null };
  });

  return {
    query: q,
    statementsIssued: ctx.statementsIssued,
    tablesQueried: [...ctx.tablesQueried],
    durationMs: Date.now() - started,
    transcript: {
      totalRows: childrenResult.totalRows ?? null,
      page: { after: q.after, next, limit, more },
      treeId,
      activities: [],
      path: [],
      nodes,
      objects: [],
      tables: [],
      fields: [],
      docs: [],
      notes,
      errors: [],
      raw: ctx.rawParts.join("\n"),
    },
  };
}

// =================================================================== objects ===

interface ObjectsBuild {
  objects: ImgObjectRow[];
  tables: ImgTableRow[];
  fields: ImgFieldRow[];
}

async function fillTable(conn: ImgReadConnection, ctx: ReadCtx, notes: string[], object: string, language: string): Promise<ObjectsBuild | undefined> {
  const dcResult = await issue(conn, ctx, buildTableDeliveryClassQuery([object]), 1, tbl("ddicTable"));
  notes.push(...serverNotes(dcResult.rs));
  const dcRow = dcResult.rs.records[0];
  if (dcRow === undefined) return undefined;

  const DT = {
    clientDependent: fld("ddicTable", "clientDependent"),
    deliveryClass: fld("ddicTable", "deliveryClass"),
  };
  const clientDependent = requireColumn(dcRow, DT.clientDependent) === "X";
  const deliveryClass = requireColumn(dcRow, DT.deliveryClass);

  const textResult = await issue(conn, ctx, buildTableTextsQuery([object], language), 1, tbl("ddicTableText"));
  notes.push(...serverNotes(textResult.rs));
  const title = textResult.rs.records[0] ? requireColumn(textResult.rs.records[0]!, fld("ddicTableText", "text")) : "";
  if (textResult.rs.records.length === 0) notes.push(`No ${tbl("ddicTableText")} title for table "${object}" in language "${language}".`);

  const fieldsResult = await issue(conn, ctx, buildTableFieldsQuery([object]), IMG_READ_ROW_CAP, tbl("ddicField"));
  notes.push(...serverNotes(fieldsResult.rs));
  const FF = {
    table: fld("ddicField", "table"),
    field: fld("ddicField", "field"),
    keyFlag: fld("ddicField", "keyFlag"),
    position: fld("ddicField", "position"),
    dataType: fld("ddicField", "dataType"),
    length: fld("ddicField", "length"),
    dataElement: fld("ddicField", "dataElement"),
  };
  const fields: ImgFieldRow[] = fieldsResult.rs.records.map((r) => ({
    table: requireColumn(r, FF.table),
    field: requireColumn(r, FF.field),
    key: requireColumn(r, FF.keyFlag) === "X",
    position: Number.parseInt(requireColumn(r, FF.position), 10),
    dataType: requireColumn(r, FF.dataType),
    length: requireColumn(r, FF.length),
    dataElement: requireColumn(r, FF.dataElement),
  }));
  if (fields.length === 0) notes.push(`No active ${tbl("ddicField")} fields for table "${object}".`);

  return {
    objects: [{ kind: "table", objectType: "", name: object, title }],
    tables: [{ object: "", table: object, clientDependent, deliveryClass, via: tbl("ddicTable"), title }],
    fields,
  };
}

async function fillView(conn: ImgReadConnection, ctx: ReadCtx, notes: string[], object: string, language: string): Promise<ObjectsBuild | undefined> {
  const headerResult = await issue(conn, ctx, buildViewHeaderQuery([object]), 1, tbl("viewHeader"));
  notes.push(...serverNotes(headerResult.rs));
  if (headerResult.rs.records.length === 0) return undefined;

  const textResult = await issue(conn, ctx, buildViewTextQuery([object], language), 1, tbl("viewText"));
  notes.push(...serverNotes(textResult.rs));
  const title = textResult.rs.records[0] ? requireColumn(textResult.rs.records[0]!, fld("viewText", "text")) : "";

  const baseTablesResult = await issue(conn, ctx, buildViewBaseTablesQuery([object]), IMG_READ_ROW_CAP, tbl("viewBaseTable"));
  notes.push(...serverNotes(baseTablesResult.rs));
  const baseTableNames = baseTablesResult.rs.records.map((r) => requireColumn(r, fld("viewBaseTable", "table")));

  const tables: ImgTableRow[] = [];
  if (baseTableNames.length > 0) {
    const dcByTable = new Map<string, { clientDependent: boolean; deliveryClass: string }>();
    for (const group of chunk([...new Set(baseTableNames)], MAX_IN_LIST)) {
      const dcResult = await issue(conn, ctx, buildTableDeliveryClassQuery(group), group.length, tbl("ddicTable"));
      notes.push(...serverNotes(dcResult.rs));
      for (const r of dcResult.rs.records) {
        dcByTable.set(requireColumn(r, fld("ddicTable", "table")), {
          clientDependent: requireColumn(r, fld("ddicTable", "clientDependent")) === "X",
          deliveryClass: requireColumn(r, fld("ddicTable", "deliveryClass")),
        });
      }
    }
    for (const table of baseTableNames) {
      const dc = dcByTable.get(table);
      if (dc === undefined) {
        notes.push(
          `No ${tbl("ddicTable")} row for base table "${table}" of view "${object}": clientDependent and ` +
            `deliveryClass below are unknown, not measured.`,
        );
      }
      tables.push({ object, table, clientDependent: dc?.clientDependent ?? false, deliveryClass: dc?.deliveryClass ?? "", via: tbl("ddicTable"), title: "" });
    }
  }

  const fieldsResult = await issue(conn, ctx, buildViewFieldsQuery([object]), IMG_READ_ROW_CAP, tbl("viewField"));
  notes.push(...serverNotes(fieldsResult.rs));
  const VF = {
    table: fld("viewField", "table"),
    field: fld("viewField", "field"),
    position: fld("viewField", "position"),
  };
  const fields: ImgFieldRow[] = fieldsResult.rs.records.map((r) => ({
    table: requireColumn(r, VF.table),
    field: requireColumn(r, VF.field),
    key: false,
    position: Number.parseInt(requireColumn(r, VF.position), 10),
    dataType: "",
    length: "",
    dataElement: "",
  }));

  return { objects: [{ kind: "view", objectType: "", name: object, title }], tables, fields };
}

async function fillCluster(conn: ImgReadConnection, ctx: ReadCtx, notes: string[], object: string, language: string): Promise<ObjectsBuild | undefined> {
  const headerResult = await issue(conn, ctx, buildViewClusterQuery([object]), 1, tbl("viewCluster"));
  notes.push(...serverNotes(headerResult.rs));
  if (headerResult.rs.records.length === 0) return undefined;

  const textResult = await issue(conn, ctx, buildViewClusterTextQuery([object], language), 1, tbl("viewClusterText"));
  notes.push(...serverNotes(textResult.rs));
  const title = textResult.rs.records[0] ? requireColumn(textResult.rs.records[0]!, fld("viewClusterText", "text")) : "";

  const membersResult = await issue(conn, ctx, buildViewClusterMembersQuery([object]), IMG_READ_ROW_CAP, tbl("viewClusterMember"));
  notes.push(...serverNotes(membersResult.rs));
  const objects: ImgObjectRow[] = [{ kind: "cluster", objectType: "", name: object, title }];
  for (const r of membersResult.rs.records) {
    objects.push({ kind: "cluster", objectType: "", name: requireColumn(r, fld("viewClusterMember", "object")), title: "" });
  }

  return { objects, tables: [], fields: [] };
}

async function fillTransaction(conn: ImgReadConnection, ctx: ReadCtx, notes: string[], object: string, language: string): Promise<ObjectsBuild | undefined> {
  const headerResult = await issue(conn, ctx, buildTransactionsQuery([object]), 1, tbl("transaction"));
  notes.push(...serverNotes(headerResult.rs));
  if (headerResult.rs.records.length === 0) return undefined;

  const textResult = await issue(conn, ctx, buildTransactionTextsQuery([object], language), 1, tbl("transactionText"));
  notes.push(...serverNotes(textResult.rs));
  const title = textResult.rs.records[0] ? requireColumn(textResult.rs.records[0]!, fld("transactionText", "text")) : "";

  return { objects: [{ kind: "transaction", objectType: "", name: object, title }], tables: [], fields: [] };
}

async function fillCustomizingObject(
  conn: ImgReadConnection,
  ctx: ReadCtx,
  notes: string[],
  object: string,
  language: string,
): Promise<ObjectsBuild | undefined> {
  const headerResult = await issue(conn, ctx, buildObjectHeadersQuery([object]), 1, tbl("cusObjectHeader"));
  notes.push(...serverNotes(headerResult.rs));
  const headerRow = headerResult.rs.records[0];
  if (headerRow === undefined) return undefined;
  const objectType = requireColumn(headerRow, fld("cusObjectHeader", "objectType"));

  const textResult = await issue(conn, ctx, buildObjectTextsQuery([object], language), 1, tbl("cusObjectText"));
  notes.push(...serverNotes(textResult.rs));
  const title = textResult.rs.records[0] ? requireColumn(textResult.rs.records[0]!, fld("cusObjectText", "text")) : "";

  const tablesResult = await issue(conn, ctx, buildObjectTablesQuery([object]), IMG_READ_ROW_CAP, tbl("cusObjectTable"));
  notes.push(...serverNotes(tablesResult.rs));
  const tableNames = tablesResult.rs.records.map((r) => requireColumn(r, fld("cusObjectTable", "table")));

  const tables: ImgTableRow[] = [];
  if (tableNames.length > 0) {
    const dcByTable = new Map<string, { clientDependent: boolean; deliveryClass: string }>();
    for (const group of chunk([...new Set(tableNames)], MAX_IN_LIST)) {
      const dcResult = await issue(conn, ctx, buildTableDeliveryClassQuery(group), group.length, tbl("ddicTable"));
      notes.push(...serverNotes(dcResult.rs));
      for (const r of dcResult.rs.records) {
        dcByTable.set(requireColumn(r, fld("ddicTable", "table")), {
          clientDependent: requireColumn(r, fld("ddicTable", "clientDependent")) === "X",
          deliveryClass: requireColumn(r, fld("ddicTable", "deliveryClass")),
        });
      }
    }
    for (const table of tableNames) {
      const dc = dcByTable.get(table);
      if (dc === undefined) {
        notes.push(
          `No ${tbl("ddicTable")} row for table "${table}" of customizing object "${object}": clientDependent ` +
            `and deliveryClass below are unknown, not measured.`,
        );
      }
      tables.push({ object, table, clientDependent: dc?.clientDependent ?? false, deliveryClass: dc?.deliveryClass ?? "", via: tbl("ddicTable"), title: "" });
    }
  }

  return { objects: [{ kind: "customizing_object", objectType, name: object, title }], tables, fields: [] };
}

export async function readImgObjects(conn: ImgReadConnection, q: ImgObjectsQuery): Promise<ImgReadResult> {
  const started = Date.now();
  const ctx = newCtx();
  const notes: string[] = [];

  let build: ObjectsBuild | undefined;
  const probeOrder: readonly [ImgObjectKind, typeof fillTable][] = [
    ["table", fillTable],
    ["view", fillView],
    ["cluster", fillCluster],
    ["transaction", fillTransaction],
    ["customizing_object", fillCustomizingObject],
  ];

  if (q.kind === "report") {
    // No catalog table backs ABAP report/program objects in this pass
    // (`IMG_CATALOG` has no entry for one) — reported as a plain named
    // object with an explicit note rather than a silent empty result.
    notes.push(`No catalog lookup exists for kind "report" in this module — reporting "${q.object}" by name only.`);
    build = { objects: [{ kind: "report", objectType: "", name: q.object, title: "" }], tables: [], fields: [] };
  } else if (q.kind !== undefined && q.kind !== "unknown") {
    const fn = probeOrder.find(([k]) => k === q.kind)?.[1];
    build = fn ? await fn(conn, ctx, notes, q.object, q.language) : undefined;
    if (build === undefined) {
      notes.push(`Object "${q.object}" was not found as a "${q.kind}".`);
    }
  } else {
    for (const [, fn] of probeOrder) {
      build = await fn(conn, ctx, notes, q.object, q.language);
      if (build !== undefined) break;
    }
    if (build === undefined) {
      notes.push(
        `Object "${q.object}" was not found in any catalog table this module checks ` +
          `(${tbl("ddicTable")}, ${tbl("viewHeader")}, ${tbl("viewCluster")}, ${tbl("transaction")}, ${tbl("cusObjectHeader")}).`,
      );
    }
  }

  const objects = build?.objects ?? [{ kind: "unknown", objectType: "", name: q.object, title: "" }];
  const tables = build?.tables ?? [];
  const fields = build?.fields ?? [];

  return {
    query: q,
    statementsIssued: ctx.statementsIssued,
    tablesQueried: [...ctx.tablesQueried],
    durationMs: Date.now() - started,
    transcript: {
      totalRows: null,
      page: null,
      treeId: null,
      activities: [],
      path: [],
      nodes: [],
      objects,
      tables,
      fields,
      docs: [],
      notes,
      errors: [],
      raw: ctx.rawParts.join("\n"),
    },
  };
}

// =================================================================== dispatch ===

export async function readImg(conn: ImgReadConnection, query: ImgQuery): Promise<ImgReadResult> {
  switch (query.mode) {
    case "search":
      return readImgSearch(conn, query);
    case "show":
      return readImgShow(conn, query);
    case "tree":
      return readImgTree(conn, query);
    case "objects":
      return readImgObjects(conn, query);
  }
}
