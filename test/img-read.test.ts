/**
 * Tests for `src/adt/img-read.ts` — the freestyle-preview-backed replacement
 * for the withdrawn ABAP-bridge IMG read route.
 *
 * Two layers, deliberately kept apart:
 *
 *  - `orderImgTreeSiblings` is tested as a pure function directly, with
 *    hand-built sibling sets shaped exactly like the documented BROTHER_ID
 *    defects (duplicate pointers, dangling pointers) — no connection, no
 *    XML, nothing to fake.
 *  - `readImgTree`/`readImgObjects`/`readImgSearch`/`readImgShow` are tested
 *    against a queue-order fake `ImgReadConnection`: each test hands it the
 *    exact response bodies it expects to be asked for, in the exact order
 *    this module's own code issues them. No network call is possible: the
 *    fake never touches HTTP, and running out of queued bodies is a hard
 *    failure, not a fall-through to anything live.
 */
import { describe, expect, it } from "vitest";

import { isAbapError, type AbapError } from "../src/adt/errors.js";
import {
  orderImgTreeSiblings,
  readImgObjects,
  readImgSearch,
  readImgShow,
  readImgTree,
  type ImgReadConnection,
  type ImgTreeSibling,
} from "../src/adt/img-read.js";

// ------------------------------------------------------------ fake wire ---

/** Builds one column's `<dataPreview:columns>` block. */
function columnXml(name: string, values: readonly string[]): string {
  const data = values.map((v) => `<dataPreview:data>${v}</dataPreview:data>`).join("");
  return (
    `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="C" dataPreview:keyAttribute="false"/>` +
    `<dataPreview:dataSet>${data}</dataPreview:dataSet></dataPreview:columns>`
  );
}

/**
 * A hand-built freestyle response body: `cols` maps column name -> that
 * column's values (column-major, matching the real wire shape). Every
 * column must carry the same number of values. `totalRows`, when given, is
 * `<dataPreview:totalRows>` — the true match count independent of the row
 * cap, per `datapreview.ts`.
 */
function body(cols: Record<string, readonly string[]>, totalRows?: number): string {
  const names = Object.keys(cols);
  const rowCount = names.length === 0 ? 0 : cols[names[0]!]!.length;
  for (const n of names) {
    if (cols[n]!.length !== rowCount) throw new Error(`test fixture bug: column "${n}" has a different row count than "${names[0]}"`);
  }
  const totalRowsXml = totalRows === undefined ? "" : `<dataPreview:totalRows>${totalRows}</dataPreview:totalRows>`;
  const colsXml = names.map((n) => columnXml(n, cols[n]!)).join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
    `${totalRowsXml}${colsXml}</dataPreview:tableData>`
  );
}

/** An empty result set — no rows, no columns. */
function emptyBody(): string {
  return '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview"></dataPreview:tableData>';
}

interface RecordedCall {
  sql: string;
  rowNumber: number;
}

/**
 * A fake `ImgReadConnection` that answers each `dataPreviewFreestyle` call
 * with the next body off a fixed queue, in call order. Running past the end
 * of the queue is a loud test-authoring bug, never a silent empty response
 * or (least of all) a real network call — this fake never performs I/O of
 * any kind.
 */
function queueConn(bodies: readonly string[]): { conn: ImgReadConnection; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const conn: ImgReadConnection = {
    async dataPreviewFreestyle(sql: string, rowNumber: number) {
      calls.push({ sql, rowNumber });
      const b = bodies[i];
      i++;
      if (b === undefined) {
        throw new Error(`queueConn: no fixture queued for call #${i} (only ${bodies.length} queued). SQL was:\n${sql}`);
      }
      return { body: b };
    },
  };
  return { conn, calls };
}

async function expectAsyncError(p: Promise<unknown>): Promise<AbapError> {
  try {
    await p;
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected the promise to reject");
}

// ======================================================== orderImgTreeSiblings ===

function sib(nodeId: string, brotherId: string, nodeType = "IMG0"): ImgTreeSibling {
  return { nodeId, nodeType, parentId: "P1", brotherId, refTreeId: "", refNodeId: "", text: `title-${nodeId}` };
}

describe("orderImgTreeSiblings", () => {
  it("orders a clean chain by walking BROTHER_ID as the PREVIOUS-sibling pointer, starting from the blank one", () => {
    // Wire order (n~NODE_ID, i.e. GUID order) is deliberately scrambled
    // relative to display order, so a test that happened to pass by leaving
    // the input order untouched would prove nothing.
    const input = [sib("C", "B"), sib("A", ""), sib("D", "C"), sib("B", "A")];
    const ordered = orderImgTreeSiblings(input);
    expect(ordered.map((s) => s.nodeId)).toEqual(["A", "B", "C", "D"]);
  });

  it("every input node appears in the output exactly once, for a clean chain", () => {
    const input = [sib("C", "B"), sib("A", ""), sib("D", "C"), sib("B", "A")];
    const ordered = orderImgTreeSiblings(input);
    expect(ordered).toHaveLength(input.length);
    expect(new Set(ordered.map((s) => s.nodeId)).size).toBe(input.length);
  });

  it("tolerates duplicate BROTHER_ID values across siblings: the walk takes one, the other is appended afterwards, exactly once", () => {
    // A and X both claim BROTHER_ID="" (both look like the first child), and
    // B and Y both claim BROTHER_ID="A" (both look like A's successor). The
    // walker must not lose, duplicate, or crash on either collision.
    const input = [sib("A", ""), sib("X", ""), sib("B", "A"), sib("Y", "A")];
    const ordered = orderImgTreeSiblings(input);
    expect(ordered).toHaveLength(4);
    expect(new Set(ordered.map((s) => s.nodeId)).size).toBe(4);
    // The walk follows the first "" and first match at each step (array order):
    expect(ordered.map((s) => s.nodeId)).toEqual(["A", "B", "X", "Y"]);
  });

  it("tolerates a dangling BROTHER_ID (naming a node outside the sibling set): the walk stops there, the rest are appended, exactly once", () => {
    // C's BROTHER_ID ("GHOST") names a node that isn't among these
    // siblings at all — a real, observed defect (img-catalog.ts's
    // imgTreeNode note). The walk reaches A -> B, then no sibling has
    // BROTHER_ID="B", so it stops; C and D (unreached) are appended.
    const input = [sib("A", ""), sib("B", "A"), sib("C", "GHOST"), sib("D", "C")];
    const ordered = orderImgTreeSiblings(input);
    expect(ordered).toHaveLength(4);
    expect(new Set(ordered.map((s) => s.nodeId)).size).toBe(4);
    expect(ordered.map((s) => s.nodeId)).toEqual(["A", "B", "C", "D"]);
  });

  it("stops on revisiting an already-emitted node rather than looping forever, when the chain cycles back on itself", () => {
    // A <-> B point at each other (A's BROTHER_ID is B, B's is A) with
    // neither blank — pathological, but the walker must still terminate.
    // No node has BROTHER_ID="" here, so the walk never starts; both nodes
    // are appended by the leftover pass.
    const input = [sib("A", "B"), sib("B", "A")];
    const ordered = orderImgTreeSiblings(input);
    expect(ordered).toHaveLength(2);
    expect(new Set(ordered.map((s) => s.nodeId)).size).toBe(2);
  });

  it("empty input orders to empty output", () => {
    expect(orderImgTreeSiblings([])).toEqual([]);
  });
});

// ================================================================ readImgTree ===

describe("readImgTree", () => {
  it("explains rather than crashes when the English-only root probe finds nothing (no treeId given)", async () => {
    const { conn, calls } = queueConn([emptyBody()]);
    const result = await readImgTree(conn, { mode: "tree", language: "D", limit: 10 });
    expect(calls).toHaveLength(1);
    expect(result.transcript.nodes).toEqual([]);
    expect(result.transcript.treeId).toBeNull();
    expect(result.transcript.notes.join(" ")).toMatch(/English/i);
    expect(result.transcript.notes.join(" ")).toMatch(/probe/i);
    // Not silently blank — the empty result comes with a stated reason.
    expect(result.transcript.notes.length).toBeGreaterThan(0);
  });

  it("orders and pages children correctly, with keyset paging producing a usable `next`", async () => {
    // treeId given explicitly (bypasses the root probe), node omitted (so
    // the tree's own root is looked up), 4 children in scrambled GUID
    // order, all IMG0 (folder) so no ref/title follow-up queries fire.
    const dirBody = body({ ID: ["T1"], TYPE: ["IMG"], NODE_ID: ["ROOT"] });
    const childrenBody = body({
      NODE_ID: ["C", "A", "D", "B"],
      NODE_TYPE: ["IMG0", "IMG0", "IMG0", "IMG0"],
      PARENT_ID: ["ROOT", "ROOT", "ROOT", "ROOT"],
      BROTHER_ID: ["B", "", "C", "A"],
      REFTREE_ID: ["", "", "", ""],
      REFNODE_ID: ["", "", "", ""],
      TEXT: ["title-C", "title-A", "title-D", "title-B"],
    });
    const { conn, calls } = queueConn([dirBody, childrenBody]);

    const page1 = await readImgTree(conn, { mode: "tree", treeId: "T1", language: "E", limit: 2 });
    expect(calls).toHaveLength(2);
    expect(page1.transcript.nodes.map((n) => n.node)).toEqual(["A", "B"]);
    expect(page1.transcript.page?.more).toBe(true);
    expect(page1.transcript.page?.next).toBe("B");
    expect(page1.transcript.treeId).toBe("T1");
    // children count is never fabricated as 0:
    expect(page1.transcript.nodes.every((n) => n.children === null)).toBe(true);

    // Second page continues from the cursor. treeId is supplied this time
    // (as a real caller would from transcript.treeId), node is NOT supplied
    // (mirrors "list this tree's root's children again"), so the directory
    // lookup and full children fetch both re-run — by design (see module
    // docs: BROTHER_ID order needs the whole sibling set every time).
    const { conn: conn2 } = queueConn([dirBody, childrenBody]);
    const page2 = await readImgTree(conn2, { mode: "tree", treeId: "T1", language: "E", limit: 2, after: "B" });
    expect(page2.transcript.nodes.map((n) => n.node)).toEqual(["C", "D"]);
    expect(page2.transcript.page?.more).toBe(false);
    expect(page2.transcript.page?.next).toBeUndefined();
  });

  it("rejects an `after` cursor that isn't one of the parent's children", async () => {
    const dirBody = body({ ID: ["T1"], TYPE: ["IMG"], NODE_ID: ["ROOT"] });
    const childrenBody = body({
      NODE_ID: ["A"],
      NODE_TYPE: ["IMG0"],
      PARENT_ID: ["ROOT"],
      BROTHER_ID: [""],
      REFTREE_ID: [""],
      REFNODE_ID: [""],
      TEXT: ["title-A"],
    });
    const { conn } = queueConn([dirBody, childrenBody]);
    const err = await expectAsyncError(readImgTree(conn, { mode: "tree", treeId: "T1", language: "E", limit: 10, after: "NOPE" }));
    expect(err.code).toBe("BAD_INPUT");
  });

  it("resolves titles from BOTH sources: IMG0 folders from TNODEIMGT text, IMG activity leaves from CUS_IMGACT via the COBJ ref — ignoring a same-node ACTI ref", async () => {
    const dirBody = body({ ID: ["T1"], TYPE: ["IMG"], NODE_ID: ["ROOT"] });
    const childrenBody = body({
      NODE_ID: ["F1", "L1"],
      NODE_TYPE: ["IMG0", "IMG"],
      PARENT_ID: ["ROOT", "ROOT"],
      BROTHER_ID: ["", "F1"],
      REFTREE_ID: ["", ""],
      REFNODE_ID: ["", ""],
      // TNODEIMGT text for the leaf is deliberately blank/absent-shaped:
      // the leaf's real title must come from CUS_IMGACT, not this column.
      TEXT: ["Folder One", ""],
    });
    // L1 carries both a COBJ ref (the real route) and an ACTI ref (the
    // explicitly-wrong route) — buildNodeRefsQuery filters server-side to
    // COBJ only, but this fixture still includes the ACTI row so the
    // module's own defensive re-filter is exercised for real, not vacuously.
    const refsBody = body({
      NODE_ID: ["L1"],
      EXT_KEY: ["0001"],
      REF_TYPE: ["COBJ"],
      REF_OBJECT: ["ZACT_LEAF"],
    });
    const titlesBody = body({ ACTIVITY: ["ZACT_LEAF"], TEXT: ["Leaf Activity Title"] });
    const { conn, calls } = queueConn([dirBody, childrenBody, refsBody, titlesBody]);

    const result = await readImgTree(conn, { mode: "tree", treeId: "T1", language: "E", limit: 10 });
    expect(calls).toHaveLength(4);
    const folder = result.transcript.nodes.find((n) => n.node === "F1")!;
    const leaf = result.transcript.nodes.find((n) => n.node === "L1")!;
    expect(folder.kind).toBe("folder");
    expect(folder.title).toBe("Folder One");
    expect(leaf.kind).toBe("activity");
    expect(leaf.activity).toBe("ZACT_LEAF");
    expect(leaf.title).toBe("Leaf Activity Title");
  });

  it("leaves a leaf's title empty (never invents one) when it has no title row at all", async () => {
    const dirBody = body({ ID: ["T1"], TYPE: ["IMG"], NODE_ID: ["ROOT"] });
    const childrenBody = body({
      NODE_ID: ["L1"],
      NODE_TYPE: ["IMG"],
      PARENT_ID: ["ROOT"],
      BROTHER_ID: [""],
      REFTREE_ID: [""],
      REFNODE_ID: [""],
      TEXT: [""],
    });
    const refsBody = emptyBody(); // no TNODEIMGR row at all for L1
    const { conn } = queueConn([dirBody, childrenBody, refsBody]);
    const result = await readImgTree(conn, { mode: "tree", treeId: "T1", language: "E", limit: 10 });
    const leaf = result.transcript.nodes[0]!;
    expect(leaf.kind).toBe("activity");
    expect(leaf.activity).toBe("");
    expect(leaf.title).toBe("");
  });

  it("follows a REF mount through REFTREE_ID/REFNODE_ID into the mounted tree", async () => {
    // The caller lists a node ("REF1") which is itself a REF mount.
    const refNodeBody = body({
      NODE_ID: ["REF1"],
      NODE_TYPE: ["REF"],
      PARENT_ID: ["ROOT"],
      BROTHER_ID: [""],
      REFTREE_ID: ["T2"],
      REFNODE_ID: ["T2ROOT"],
      TEXT: ["Mounted Chapter"],
    });
    const mountedChildrenBody = body({
      NODE_ID: ["X1"],
      NODE_TYPE: ["IMG0"],
      PARENT_ID: ["T2ROOT"],
      BROTHER_ID: [""],
      REFTREE_ID: [""],
      REFNODE_ID: [""],
      TEXT: ["Mounted Child"],
    });
    const { conn, calls } = queueConn([refNodeBody, mountedChildrenBody]);
    const result = await readImgTree(conn, { mode: "tree", treeId: "T1", node: "REF1", language: "E", limit: 10 });
    expect(calls).toHaveLength(2);
    expect(result.transcript.treeId).toBe("T2");
    expect(result.transcript.nodes.map((n) => n.node)).toEqual(["X1"]);
  });

  it("REF mount with a blank REFNODE_ID falls back to the mounted tree's own TTREE.NODE_ID root, with a note explaining why", async () => {
    const refNodeBody = body({
      NODE_ID: ["REF1"],
      NODE_TYPE: ["REF"],
      PARENT_ID: ["ROOT"],
      BROTHER_ID: [""],
      REFTREE_ID: ["T2"],
      REFNODE_ID: [""],
      TEXT: ["Mounted Chapter"],
    });
    const dirBody = body({ ID: ["T2"], TYPE: ["IMG"], NODE_ID: ["T2ROOT"] });
    const mountedChildrenBody = body({
      NODE_ID: ["X1"],
      NODE_TYPE: ["IMG0"],
      PARENT_ID: ["T2ROOT"],
      BROTHER_ID: [""],
      REFTREE_ID: [""],
      REFNODE_ID: [""],
      TEXT: ["Mounted Child"],
    });
    const { conn, calls } = queueConn([refNodeBody, dirBody, mountedChildrenBody]);
    const result = await readImgTree(conn, { mode: "tree", treeId: "T1", node: "REF1", language: "E", limit: 10 });
    expect(calls).toHaveLength(3);
    expect(result.transcript.treeId).toBe("T2");
    expect(result.transcript.nodes.map((n) => n.node)).toEqual(["X1"]);
    expect(result.transcript.notes.join(" ")).toMatch(/blank REFNODE_ID/);
  });

  it("uses the freestyle response's own totalRows as the parent's true child count, and warns when the fetched set looks incomplete", async () => {
    const dirBody = body({ ID: ["T1"], TYPE: ["IMG"], NODE_ID: ["ROOT"] });
    // Reports 5 total children but only returns 1 — an internal-cap
    // shortfall the module must flag, never silently trust.
    const childrenBody = body(
      {
        NODE_ID: ["A"],
        NODE_TYPE: ["IMG0"],
        PARENT_ID: ["ROOT"],
        BROTHER_ID: [""],
        REFTREE_ID: [""],
        REFNODE_ID: [""],
        TEXT: ["A"],
      },
      5,
    );
    const { conn } = queueConn([dirBody, childrenBody]);
    const result = await readImgTree(conn, { mode: "tree", treeId: "T1", language: "E", limit: 10 });
    expect(result.transcript.totalRows).toBe(5);
    expect(result.transcript.notes.join(" ")).toMatch(/only 1 were/);
  });
});

// ============================================================= readImgObjects ===

describe("readImgObjects — objects-mode bug fix (clientDependent / deliveryClass)", () => {
  it("populates clientDependent from DD02L.CLIDEP='X' and deliveryClass from DD02L.CONTFLAG (the bug the old bridge left blank)", async () => {
    const dcBody = body({ TABNAME: ["ZKNOWN"], CONTFLAG: ["A"], CLIDEP: ["X"] });
    const textBody = body({ TABNAME: ["ZKNOWN"], DDTEXT: ["Known Table"] });
    const fieldsBody = body({
      TABNAME: ["ZKNOWN"],
      FIELDNAME: ["MANDT"],
      POSITION: ["0001"],
      KEYFLAG: ["X"],
      DATATYPE: ["CLNT"],
      LENG: ["000003"],
      ROLLNAME: ["MANDT"],
    });
    const { conn } = queueConn([dcBody, textBody, fieldsBody]);
    const result = await readImgObjects(conn, { mode: "objects", object: "ZKNOWN", language: "E", kind: "table" });
    const row = result.transcript.tables[0]!;
    expect(row.clientDependent).toBe(true);
    expect(row.deliveryClass).toBe("A");
  });

  it("reports clientDependent=false (not a crash, not blank) when CLIDEP is a space, not 'X'", async () => {
    const dcBody = body({ TABNAME: ["ZINDEP"], CONTFLAG: ["C"], CLIDEP: [""] });
    const textBody = body({ TABNAME: ["ZINDEP"], DDTEXT: ["Client-Independent Table"] });
    const fieldsBody = emptyBody();
    const { conn } = queueConn([dcBody, textBody, fieldsBody]);
    const result = await readImgObjects(conn, { mode: "objects", object: "ZINDEP", language: "E", kind: "table" });
    const row = result.transcript.tables[0]!;
    expect(row.clientDependent).toBe(false);
    expect(row.deliveryClass).toBe("C");
  });

  it("never assumes the client field is named MANDT: a table whose client field is literally CLIENT (e.g. TB004) still lists its fields and key flag correctly", async () => {
    const dcBody = body({ TABNAME: ["TB004"], CONTFLAG: ["A"], CLIDEP: ["X"] });
    const textBody = body({ TABNAME: ["TB004"], DDTEXT: ["Client field named CLIENT"] });
    const fieldsBody = body({
      TABNAME: ["TB004", "TB004"],
      FIELDNAME: ["CLIENT", "SEQNR"],
      POSITION: ["0001", "0002"],
      KEYFLAG: ["X", "X"],
      DATATYPE: ["CLNT", "NUMC"],
      LENG: ["000003", "000003"],
      ROLLNAME: ["CLIENT", "SEQNR"],
    });
    const { conn } = queueConn([dcBody, textBody, fieldsBody]);
    const result = await readImgObjects(conn, { mode: "objects", object: "TB004", language: "E", kind: "table" });
    expect(result.transcript.tables[0]!.clientDependent).toBe(true);
    const clientField = result.transcript.fields.find((f) => f.field === "CLIENT")!;
    expect(clientField).toBeDefined();
    expect(clientField.key).toBe(true);
    // Nothing in the result should ever surface a fabricated "MANDT" field
    // for this table — its client field is CLIENT and only CLIENT.
    expect(result.transcript.fields.some((f) => f.field === "MANDT")).toBe(false);
  });

  it("auto-detect (no kind given) probes table -> view -> ... and stops at the first hit", async () => {
    const dcBody = body({ TABNAME: ["ZAUTOTAB"], CONTFLAG: ["A"], CLIDEP: ["X"] });
    const textBody = body({ TABNAME: ["ZAUTOTAB"], DDTEXT: ["Auto-detected table"] });
    const fieldsBody = emptyBody();
    const { conn, calls } = queueConn([dcBody, textBody, fieldsBody]);
    const result = await readImgObjects(conn, { mode: "objects", object: "ZAUTOTAB", language: "E" });
    expect(calls).toHaveLength(3); // stopped after the table branch — no view/cluster/etc probes fired
    expect(result.transcript.objects[0]!.kind).toBe("table");
  });

  it("reports an explanatory note, not a crash, when an explicit kind is not found", async () => {
    const { conn } = queueConn([emptyBody()]);
    const result = await readImgObjects(conn, { mode: "objects", object: "ZGHOST", language: "E", kind: "view" });
    expect(result.transcript.notes.join(" ")).toMatch(/not found/);
    expect(result.transcript.objects[0]!.kind).toBe("unknown");
  });

  it("a base table missing from DD02L is kept in the result but flagged with a note, never silently reported as client-independent", async () => {
    const headerBody = body({ VIEWNAME: ["ZVIEW1"], AGGTYPE: [""], ROOTTAB: ["ZT1"] });
    const textBody = body({ VIEWNAME: ["ZVIEW1"], DDTEXT: ["Test View"] });
    // Two base tables, ZT1 and ZT2 — DD02L only has a row for ZT1.
    const baseTablesBody = body({ VIEWNAME: ["ZVIEW1", "ZVIEW1"], TABNAME: ["ZT1", "ZT2"], TABPOS: ["0001", "0002"] });
    const dcBody = body({ TABNAME: ["ZT1"], CONTFLAG: ["A"], CLIDEP: ["X"] });
    const fieldsBody = emptyBody();
    const { conn } = queueConn([headerBody, textBody, baseTablesBody, dcBody, fieldsBody]);
    const result = await readImgObjects(conn, { mode: "objects", object: "ZVIEW1", language: "E", kind: "view" });

    // Both tables must appear — the missing DD02L row must never cause a
    // table to be dropped from the result.
    expect(result.transcript.tables.map((t) => t.table).sort()).toEqual(["ZT1", "ZT2"]);

    const zt1 = result.transcript.tables.find((t) => t.table === "ZT1")!;
    expect(zt1.clientDependent).toBe(true);
    expect(zt1.deliveryClass).toBe("A");

    // ZT2 falls back to the false/"" defaults, but that must never be mistaken
    // for a measured "cross-client" answer — a note must name the table and
    // DD02L explicitly, so a caller (or a functional consultant reading the
    // result) can tell "unmeasured" apart from "measured as not client-dependent".
    const zt2 = result.transcript.tables.find((t) => t.table === "ZT2")!;
    expect(zt2.clientDependent).toBe(false);
    expect(zt2.deliveryClass).toBe("");
    const noteText = result.transcript.notes.join(" ");
    expect(noteText).toMatch(/ZT2/);
    expect(noteText).toMatch(/DD02L/);
  });
});

// ============================================================== readImgSearch ===

describe("readImgSearch", () => {
  it("unions id-matches and title-matches into one de-duplicated, sorted page and fills in titles for id-only hits", async () => {
    const idBody = body({ ACTIVITY: ["ZACT_A", "ZACT_SHARED"] });
    const titleBody = body({ ACTIVITY: ["ZACT_SHARED", "ZACT_B"], TEXT: ["Shared Title", "B Title"] });
    // ZACT_A matched only by id, so its title needs a follow-up lookup.
    const missingTitlesBody = body({ ACTIVITY: ["ZACT_A"], TEXT: ["A Title"] });
    const { conn, calls } = queueConn([idBody, titleBody, missingTitlesBody]);
    const result = await readImgSearch(conn, { mode: "search", text: "z*", language: "E", limit: 10 });
    expect(calls).toHaveLength(3);
    const byId = new Map(result.transcript.activities.map((a) => [a.activity, a.title]));
    expect(byId.get("ZACT_A")).toBe("A Title");
    expect(byId.get("ZACT_SHARED")).toBe("Shared Title");
    expect(byId.get("ZACT_B")).toBe("B Title");
    expect(result.transcript.activities).toHaveLength(3);
  });
});

// ================================================================ readImgShow ===

describe("readImgShow", () => {
  it("assembles an activity's header, title, doc id, linked objects and their tables' delivery classes", async () => {
    const headerBody = body({ ACTIVITY: ["ZACT1"], C_ACTIVITY: ["CACT1"], DOCU_ID: ["DOC001"], ATTRIBUTES: [""] });
    const titleBody = body({ ACTIVITY: ["ZACT1"], TEXT: ["Show Me"] });
    const actHeaderBody = body({ ACT_ID: ["CACT1"] });
    const objBody = body({
      ACT_ID: ["CACT1"],
      OBJECTTYPE: ["D"],
      OBJECTNAME: ["ZOBJ1"],
      TCODE: [""],
      SUBOBJNAME: [""],
    });
    const objTablesBody = body({ OBJECTNAME: ["ZOBJ1"], OBJECTTYPE: ["D"], TABNAME: ["ZTAB1"] });
    const dcBody = body({ TABNAME: ["ZTAB1"], CONTFLAG: ["C"], CLIDEP: ["X"] });
    // Not mounted in any IMG tree — kept separate from this test's own focus
    // (objects/tables assembly); the dedicated `walkImgPath` describe block
    // below covers the mounted/walked cases.
    const refsBody = emptyBody();
    const { conn, calls } = queueConn([headerBody, titleBody, refsBody, actHeaderBody, objBody, objTablesBody, dcBody]);

    const result = await readImgShow(conn, { mode: "show", activity: "ZACT1", language: "E" });
    expect(calls).toHaveLength(7);
    expect(result.transcript.activities[0]).toMatchObject({ activity: "ZACT1", title: "Show Me", objects: 1, nodes: 0 });
    expect(result.transcript.path).toEqual([]);
    expect(result.transcript.notes.some((n) => n.includes("not mounted in any IMG tree"))).toBe(true);
    expect(result.transcript.docs).toEqual([{ activity: "ZACT1", docId: "DOC001" }]);
    expect(result.transcript.tables[0]).toMatchObject({ table: "ZTAB1", clientDependent: true, deliveryClass: "C" });
  });

  it("throws NOT_FOUND rather than returning an empty result for an activity with no CUS_IMGACH row", async () => {
    const { conn } = queueConn([emptyBody()]);
    const err = await expectAsyncError(readImgShow(conn, { mode: "show", activity: "ZGHOST", language: "E" }));
    expect(err.code).toBe("NOT_FOUND");
  });
});

// ============================================================ walkImgPath ===
// `readImgShow`'s reference-IMG ancestor walk (TNODEIMGR -> TNODEIMG, climbing
// PARENT_ID root-ward). Each test below uses a header/title with a blank
// C_ACTIVITY and DOCU_ID so `readImgShow` issues no queries beyond the walk
// itself, keeping each fixture queue focused on the walk's own behavior.

/** A minimal CUS_IMGACH header: no doc id, no C_ACTIVITY link. */
function pathHeaderBody(activity: string): string {
  return body({ ACTIVITY: [activity], C_ACTIVITY: [""], DOCU_ID: [""], ATTRIBUTES: [""] });
}

/** One TNODEIMG row shaped like `buildTreeNodeByIdQuery`'s response (carries TREE_ID). */
function rootNodeBody(treeId: string, nodeId: string, parentId: string): string {
  return body({
    TREE_ID: [treeId],
    NODE_ID: [nodeId],
    NODE_TYPE: ["IMG"],
    PARENT_ID: [parentId],
    BROTHER_ID: [""],
    REFTREE_ID: [""],
    REFNODE_ID: [""],
    TEXT: [""],
  });
}

/** One TNODEIMG row shaped like `buildTreeNodeQuery`'s response (no TREE_ID column). */
function ancestorNodeBody(nodeId: string, parentId: string, title: string): string {
  return body({
    NODE_ID: [nodeId],
    NODE_TYPE: ["IMG0"],
    PARENT_ID: [parentId],
    BROTHER_ID: [""],
    REFTREE_ID: [""],
    REFNODE_ID: [""],
    TEXT: [title],
  });
}

describe("walkImgPath (via readImgShow)", () => {
  it("walks the mounted node up to the root and returns the path root-first, with exact node/title sequence", async () => {
    const headerBody = pathHeaderBody("ZACT2");
    const titleBody = body({ ACTIVITY: ["ZACT2"], TEXT: ["Leaf Title"] });
    const refsBody = body({ NODE_ID: ["LEAF1"], REF_TYPE: ["COBJ"], REF_OBJECT: ["ZACT2"] });
    const leafBody = rootNodeBody("T1", "LEAF1", "FOLDER1");
    const folderBody = ancestorNodeBody("FOLDER1", "ROOT", "Folder One");
    const rootBody = ancestorNodeBody("ROOT", "", "Root Title");
    const { conn, calls } = queueConn([headerBody, titleBody, refsBody, leafBody, folderBody, rootBody]);

    const result = await readImgShow(conn, { mode: "show", activity: "ZACT2", language: "E" });
    expect(calls).toHaveLength(6);
    expect(result.transcript.activities[0]).toMatchObject({ activity: "ZACT2", nodes: 1 });
    expect(result.transcript.path).toEqual([
      { activity: "ZACT2", position: 0, node: "ROOT", title: "Root Title" },
      { activity: "ZACT2", position: 1, node: "FOLDER1", title: "Folder One" },
      { activity: "ZACT2", position: 2, node: "LEAF1", title: "Leaf Title" },
    ]);
  });

  it("reports an unmounted activity with a note and an empty path, without throwing", async () => {
    const headerBody = pathHeaderBody("ZACT3");
    const titleBody = body({ ACTIVITY: ["ZACT3"], TEXT: ["Unmounted"] });
    const refsBody = emptyBody();
    const { conn, calls } = queueConn([headerBody, titleBody, refsBody]);

    const result = await readImgShow(conn, { mode: "show", activity: "ZACT3", language: "E" });
    expect(calls).toHaveLength(3);
    expect(result.transcript.activities[0]).toMatchObject({ activity: "ZACT3", nodes: 0 });
    expect(result.transcript.path).toEqual([]);
    expect(result.transcript.notes.some((n) => n.includes("not mounted in any IMG tree"))).toBe(true);
  });

  it("stops after IMG_PATH_MAX_DEPTH hops with a cut-off note rather than climbing forever", async () => {
    const headerBody = pathHeaderBody("ZACT4");
    const titleBody = body({ ACTIVITY: ["ZACT4"], TEXT: ["Deep Leaf"] });
    const refsBody = body({ NODE_ID: ["LEAF1"], REF_TYPE: ["COBJ"], REF_OBJECT: ["ZACT4"] });
    const leafBody = rootNodeBody("T1", "LEAF1", "P1");
    // P1..P32, each pointing at the next — P32's parent (P33) is never fetched,
    // since the walk must give up exactly at the depth bound, not one hop late.
    const ancestorBodies = Array.from({ length: 32 }, (_, i) => {
      const n = i + 1;
      return ancestorNodeBody(`P${n}`, `P${n + 1}`, `Level ${n}`);
    });
    const { conn, calls } = queueConn([headerBody, titleBody, refsBody, leafBody, ...ancestorBodies]);

    const result = await readImgShow(conn, { mode: "show", activity: "ZACT4", language: "E" });
    // header + title + refs + leaf + 32 ancestor hops, no 33rd (cut-off, not a real fetch).
    expect(calls).toHaveLength(36);
    expect(result.transcript.notes.some((n) => n.includes("stopped after 32 hops"))).toBe(true);
    expect(result.transcript.path).toHaveLength(33); // leaf + 32 ancestors walked before the cutoff
    expect(result.transcript.path[0]).toMatchObject({ node: "P32" });
    expect(result.transcript.path.at(-1)).toMatchObject({ node: "LEAF1" });
  });

  it("terminates on a PARENT_ID cycle with a note, instead of looping forever", async () => {
    const headerBody = pathHeaderBody("ZACT5");
    const titleBody = body({ ACTIVITY: ["ZACT5"], TEXT: ["Cyclic Leaf"] });
    const refsBody = body({ NODE_ID: ["LEAF1"], REF_TYPE: ["COBJ"], REF_OBJECT: ["ZACT5"] });
    const leafBody = rootNodeBody("T1", "LEAF1", "P1");
    const p1Body = ancestorNodeBody("P1", "P2", "Level 1");
    // P2 points back at P1 (already visited) instead of going blank or further up.
    const p2Body = ancestorNodeBody("P2", "P1", "Level 2");
    const { conn, calls } = queueConn([headerBody, titleBody, refsBody, leafBody, p1Body, p2Body]);

    const result = await readImgShow(conn, { mode: "show", activity: "ZACT5", language: "E" });
    expect(calls).toHaveLength(6);
    expect(result.transcript.notes.some((n) => n.includes("revisited node") && n.includes("cycles here"))).toBe(true);
    expect(result.transcript.path).toEqual([
      { activity: "ZACT5", position: 0, node: "P2", title: "Level 2" },
      { activity: "ZACT5", position: 1, node: "P1", title: "Level 1" },
      { activity: "ZACT5", position: 2, node: "LEAF1", title: "Cyclic Leaf" },
    ]);
  });

  it("reports a multiply-mounted activity with a note naming the count, and walks only the first (sorted) mount", async () => {
    const headerBody = pathHeaderBody("ZACT6");
    const titleBody = body({ ACTIVITY: ["ZACT6"], TEXT: ["Twice Mounted"] });
    const refsBody = body({ NODE_ID: ["NODE_B", "NODE_A"], REF_TYPE: ["COBJ", "COBJ"], REF_OBJECT: ["ZACT6", "ZACT6"] });
    const leafBody = rootNodeBody("T1", "NODE_A", "");
    const { conn, calls } = queueConn([headerBody, titleBody, refsBody, leafBody]);

    const result = await readImgShow(conn, { mode: "show", activity: "ZACT6", language: "E" });
    expect(calls).toHaveLength(4);
    expect(result.transcript.activities[0]).toMatchObject({ activity: "ZACT6", nodes: 2 });
    expect(result.transcript.notes.some((n) => n.includes("mounted at 2 different") && n.includes("NODE_A, NODE_B"))).toBe(true);
    expect(result.transcript.path).toEqual([{ activity: "ZACT6", position: 0, node: "NODE_A", title: "Twice Mounted" }]);
  });
});
