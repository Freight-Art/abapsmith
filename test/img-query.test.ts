/**
 * Tests for `src/adt/img-query.ts` — SQL builders and the freestyle-preview
 * response mapper for `abap_img`'s catalog reads.
 *
 * Pure-function tests only: no connection/HTTP fake, no live call. Every
 * builder is asserted against its exact SQL string — this is the module
 * where a stray character becomes a server-side syntax error.
 */
import { describe, expect, it } from "vitest";

import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { IMG_CATALOG } from "../src/adt/img-catalog.js";
import {
  IMG_SQL_LINE_MAX,
  MAX_IN_LIST,
  assertInList,
  assertSqlValue,
  buildActivityHeaderQuery,
  buildActivityHeadersByIdQuery,
  buildActivityIdSearchQuery,
  buildActivityObjectsQuery,
  buildActivityTitleSearchQuery,
  buildActivityTitlesQuery,
  buildObjectHeadersQuery,
  buildObjectTablesQuery,
  buildObjectTextsQuery,
  buildTableDeliveryClassQuery,
  buildNodeRefsQuery,
  buildNodesByRefObjectQuery,
  buildTableFieldsQuery,
  buildTableTextsQuery,
  buildTransactionsQuery,
  buildTransactionTextsQuery,
  buildSelect,
  buildTreeChildrenQuery,
  buildTreeDirectoryQuery,
  buildTreeNodeByIdQuery,
  buildTreeNodeQuery,
  buildTreeRootProbeQuery,
  buildViewBaseTablesQuery,
  buildViewClusterMembersQuery,
  buildViewClusterQuery,
  buildViewClusterTextQuery,
  buildViewDirectoryQuery,
  buildViewFieldsQuery,
  buildViewHeaderQuery,
  buildViewTextQuery,
  imgLikePattern,
  requireColumn,
  sqlLiteral,
  toRecordSet,
} from "../src/adt/img-query.js";

function expectBadInput(fn: () => unknown): AbapError {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) {
      expect(e.code).toBe("BAD_INPUT");
      return e;
    }
    throw e;
  }
  throw new Error("expected fn() to throw a BAD_INPUT AbapError");
}

// ------------------------------------------------------------- builders ---

describe("SQL builders — exact strings", () => {
  it("buildActivityIdSearchQuery: no after", () => {
    expect(buildActivityIdSearchQuery("IWBEP")).toBe(
      "SELECT ACTIVITY\nFROM CUS_IMGACH\nWHERE ACTIVITY LIKE '%IWBEP%' ESCAPE '#'\nORDER BY ACTIVITY",
    );
  });

  it("buildActivityIdSearchQuery: with after", () => {
    expect(buildActivityIdSearchQuery("IWBEP", "AAA")).toBe(
      "SELECT ACTIVITY\nFROM CUS_IMGACH\nWHERE ACTIVITY LIKE '%IWBEP%' ESCAPE '#'\n  AND ACTIVITY > 'AAA'\nORDER BY ACTIVITY",
    );
  });

  it("buildActivityIdSearchQuery: wildcard pattern maps '*' to '%', no substring wrap", () => {
    expect(buildActivityIdSearchQuery("FOO*")).toBe(
      "SELECT ACTIVITY\nFROM CUS_IMGACH\nWHERE ACTIVITY LIKE 'FOO%' ESCAPE '#'\nORDER BY ACTIVITY",
    );
  });

  it("buildActivityTitleSearchQuery: no after", () => {
    expect(buildActivityTitleSearchQuery("batch", "EN")).toBe(
      "SELECT ACTIVITY, TEXT\nFROM CUS_IMGACT\nWHERE SPRAS = 'EN'\n  AND TEXT LIKE '%batch%' ESCAPE '#'\nORDER BY ACTIVITY",
    );
  });

  it("buildActivityTitleSearchQuery: language is upper-cased, after is appended last", () => {
    expect(buildActivityTitleSearchQuery("batch", "en", "AAA")).toBe(
      "SELECT ACTIVITY, TEXT\nFROM CUS_IMGACT\nWHERE SPRAS = 'EN'\n  AND TEXT LIKE '%batch%' ESCAPE '#'\n  AND ACTIVITY > 'AAA'\nORDER BY ACTIVITY",
    );
  });

  it("buildActivityHeaderQuery", () => {
    expect(buildActivityHeaderQuery("/IWBEP/BATCH_CONFIG")).toBe(
      "SELECT ACTIVITY, C_ACTIVITY, DOCU_ID, ATTRIBUTES\nFROM CUS_IMGACH\nWHERE ACTIVITY = '/IWBEP/BATCH_CONFIG'",
    );
  });

  it("buildActivityTitlesQuery", () => {
    expect(buildActivityTitlesQuery(["A1", "A2"], "EN")).toBe(
      "SELECT ACTIVITY, TEXT\nFROM CUS_IMGACT\nWHERE SPRAS = 'EN'\n  AND ACTIVITY IN ('A1', 'A2')",
    );
  });

  it("buildActivityHeadersByIdQuery", () => {
    expect(buildActivityHeadersByIdQuery(["X1", "X2"])).toBe("SELECT ACT_ID\nFROM CUS_ACTH\nWHERE ACT_ID IN ('X1', 'X2')");
  });

  it("buildActivityObjectsQuery", () => {
    expect(buildActivityObjectsQuery(["X1", "X2"])).toBe(
      "SELECT ACT_ID, OBJECTTYPE, OBJECTNAME, TCODE, SUBOBJNAME\nFROM CUS_ACTOBJ\nWHERE ACT_ID IN ('X1', 'X2')",
    );
  });

  it("buildObjectHeadersQuery", () => {
    expect(buildObjectHeadersQuery(["/IWBEP/C_CCMS", "IMGDUMMY"])).toBe(
      "SELECT OBJECTNAME, OBJECTTYPE\nFROM OBJH\nWHERE OBJECTNAME IN ('/IWBEP/C_CCMS', 'IMGDUMMY')",
    );
  });

  it("buildObjectTablesQuery", () => {
    expect(buildObjectTablesQuery(["/IWBEP/C_CCMS"])).toBe(
      "SELECT OBJECTNAME, OBJECTTYPE, TABNAME\nFROM OBJS\nWHERE OBJECTNAME IN ('/IWBEP/C_CCMS')",
    );
  });

  it("buildObjectTextsQuery", () => {
    expect(buildObjectTextsQuery(["/IWBEP/C_CCMS"], "EN")).toBe(
      "SELECT OBJECTNAME, OBJECTTYPE, DDTEXT\nFROM OBJT\nWHERE LANGUAGE = 'EN'\n  AND OBJECTNAME IN ('/IWBEP/C_CCMS')",
    );
  });

  it("buildTableDeliveryClassQuery: AS4LOCAL = 'A' filter is always first", () => {
    expect(buildTableDeliveryClassQuery(["DD02L", "CUS_IMGACH"])).toBe(
      "SELECT TABNAME, CONTFLAG, CLIDEP\nFROM DD02L\nWHERE AS4LOCAL = 'A'\n  AND TABNAME IN ('DD02L', 'CUS_IMGACH')",
    );
  });

  it("buildViewDirectoryQuery", () => {
    expect(buildViewDirectoryQuery(["V_T001"])).toBe(
      "SELECT TABNAME, AREA, TYPE, BASTAB, FLAG\nFROM TVDIR\nWHERE TABNAME IN ('V_T001')",
    );
  });

  it("buildViewClusterQuery", () => {
    expect(buildViewClusterQuery(["VC_TEST"])).toBe("SELECT VCLNAME\nFROM VCLDIR\nWHERE VCLNAME IN ('VC_TEST')");
  });

  it("buildViewClusterTextQuery", () => {
    expect(buildViewClusterTextQuery(["VC_TEST"], "EN")).toBe(
      "SELECT VCLNAME, TEXT\nFROM VCLDIRT\nWHERE SPRAS = 'EN'\n  AND VCLNAME IN ('VC_TEST')",
    );
  });

  it("buildViewClusterMembersQuery: ordered by cluster then position", () => {
    expect(buildViewClusterMembersQuery(["VC_TEST"])).toBe(
      "SELECT VCLNAME, OBJECT, OBJPOS, OBJLEVEL\nFROM VCLSTRUC\nWHERE VCLNAME IN ('VC_TEST')\nORDER BY VCLNAME, OBJPOS",
    );
  });

  it("buildTableFieldsQuery: active version only, ordered by table then position", () => {
    expect(buildTableFieldsQuery(["DD02L", "CUS_IMGACH"])).toBe(
      "SELECT TABNAME, FIELDNAME, POSITION, KEYFLAG, DATATYPE, LENG, ROLLNAME\nFROM DD03L\nWHERE AS4LOCAL = 'A'\n" +
        "  AND TABNAME IN ('DD02L', 'CUS_IMGACH')\nORDER BY TABNAME, POSITION",
    );
  });

  it("buildTableTextsQuery", () => {
    expect(buildTableTextsQuery(["DD02L", "CUS_IMGACH"], "EN")).toBe(
      "SELECT TABNAME, DDTEXT\nFROM DD02T\nWHERE AS4LOCAL = 'A'\n  AND DDLANGUAGE = 'EN'\n  AND TABNAME IN ('DD02L', 'CUS_IMGACH')",
    );
  });

  it("buildViewHeaderQuery", () => {
    expect(buildViewHeaderQuery(["V_T001"])).toBe(
      "SELECT VIEWNAME, AGGTYPE, ROOTTAB\nFROM DD25L\nWHERE AS4LOCAL = 'A'\n  AND VIEWNAME IN ('V_T001')",
    );
  });

  it("buildViewTextQuery", () => {
    expect(buildViewTextQuery(["V_T001"], "EN")).toBe(
      "SELECT VIEWNAME, DDTEXT\nFROM DD25T\nWHERE AS4LOCAL = 'A'\n  AND DDLANGUAGE = 'EN'\n  AND VIEWNAME IN ('V_T001')",
    );
  });

  it("buildViewBaseTablesQuery: ordered by view then position", () => {
    expect(buildViewBaseTablesQuery(["V_T001"])).toBe(
      "SELECT VIEWNAME, TABNAME, TABPOS\nFROM DD26S\nWHERE AS4LOCAL = 'A'\n  AND VIEWNAME IN ('V_T001')\nORDER BY VIEWNAME, TABPOS",
    );
  });

  it("buildViewFieldsQuery: ordered by view then position", () => {
    expect(buildViewFieldsQuery(["V_T001"])).toBe(
      "SELECT VIEWNAME, VIEWFIELD, TABNAME, FIELDNAME, OBJPOS\nFROM DD27S\nWHERE AS4LOCAL = 'A'\n" +
        "  AND VIEWNAME IN ('V_T001')\nORDER BY VIEWNAME, OBJPOS",
    );
  });

  it("buildTransactionsQuery", () => {
    expect(buildTransactionsQuery(["SE38", "SM30"])).toBe("SELECT TCODE, PGMNA, DYPNO\nFROM TSTC\nWHERE TCODE IN ('SE38', 'SM30')");
  });

  it("buildTransactionTextsQuery", () => {
    expect(buildTransactionTextsQuery(["SE38", "SM30"], "EN")).toBe(
      "SELECT TCODE, TTEXT\nFROM TSTCT\nWHERE SPRSL = 'EN'\n  AND TCODE IN ('SE38', 'SM30')",
    );
  });

  it("a long IN (…) list wraps across lines, comma-terminated except the last", () => {
    const sql = buildActivityTitlesQuery(["A1", "A2", "A3", "A4", "A5", "A6"], "EN");
    expect(sql).toBe(
      "SELECT ACTIVITY, TEXT\nFROM CUS_IMGACT\nWHERE SPRAS = 'EN'\n  AND ACTIVITY IN (\n" +
        "  'A1', 'A2', 'A3', 'A4', 'A5',\n" +
        "  'A6'\n)",
    );
  });

  it("buildTreeRootProbeQuery: probe text is a fixed English prefix, wildcard-suffixed", () => {
    expect(buildTreeRootProbeQuery("E")).toBe(
      "SELECT TREE_ID, NODE_ID, SPRAS, TEXT\nFROM TNODEIMGT\nWHERE SPRAS = 'E'\n" +
        "  AND TEXT LIKE 'SAP Customizing Implementation%' ESCAPE '#'",
    );
  });

  it("buildTreeChildrenQuery: no after -> no keyset predicate, ORDER BY is GUID/key order not display order", () => {
    expect(buildTreeChildrenQuery("TREE1", "PARENT1", "E")).toBe(
      "SELECT n~NODE_ID, n~NODE_TYPE, n~PARENT_ID, n~BROTHER_ID, n~REFTREE_ID, n~REFNODE_ID, t~TEXT\n" +
        "FROM TNODEIMG AS n\n" +
        "LEFT OUTER JOIN TNODEIMGT AS t ON t~TREE_ID = n~TREE_ID\n" +
        "  AND t~NODE_ID = n~NODE_ID AND t~SPRAS = 'E'\n" +
        "WHERE n~TREE_ID = 'TREE1'\n" +
        "  AND n~PARENT_ID = 'PARENT1'\n" +
        "ORDER BY n~NODE_ID",
    );
  });

  it("buildTreeChildrenQuery: with after -> keyset predicate appended last, before ORDER BY", () => {
    expect(buildTreeChildrenQuery("TREE1", "PARENT1", "E", "NODEAFTER1")).toBe(
      "SELECT n~NODE_ID, n~NODE_TYPE, n~PARENT_ID, n~BROTHER_ID, n~REFTREE_ID, n~REFNODE_ID, t~TEXT\n" +
        "FROM TNODEIMG AS n\n" +
        "LEFT OUTER JOIN TNODEIMGT AS t ON t~TREE_ID = n~TREE_ID\n" +
        "  AND t~NODE_ID = n~NODE_ID AND t~SPRAS = 'E'\n" +
        "WHERE n~TREE_ID = 'TREE1'\n" +
        "  AND n~PARENT_ID = 'PARENT1'\n" +
        "  AND n~NODE_ID > 'NODEAFTER1'\n" +
        "ORDER BY n~NODE_ID",
    );
  });

  it("buildTreeNodeQuery: same column set as buildTreeChildrenQuery, no ORDER BY (single node)", () => {
    expect(buildTreeNodeQuery("TREE1", "NODE1", "E")).toBe(
      "SELECT n~NODE_ID, n~NODE_TYPE, n~PARENT_ID, n~BROTHER_ID, n~REFTREE_ID, n~REFNODE_ID, t~TEXT\n" +
        "FROM TNODEIMG AS n\n" +
        "LEFT OUTER JOIN TNODEIMGT AS t ON t~TREE_ID = n~TREE_ID\n" +
        "  AND t~NODE_ID = n~NODE_ID AND t~SPRAS = 'E'\n" +
        "WHERE n~TREE_ID = 'TREE1'\n" +
        "  AND n~NODE_ID = 'NODE1'",
    );
  });

  it("buildTreeChildrenQuery / buildTreeNodeQuery: identical SELECT column sets, no leftover W_SUBNODES, REFNODE_ID present", () => {
    const childrenSelect = buildTreeChildrenQuery("TREE1", "PARENT1", "E").split("\n")[0];
    const nodeSelect = buildTreeNodeQuery("TREE1", "NODE1", "E").split("\n")[0];
    expect(childrenSelect).toBe(nodeSelect);
    expect(childrenSelect).toContain("n~REFNODE_ID");
    expect(childrenSelect).toContain("n~REFTREE_ID");
    expect(childrenSelect).not.toContain("W_SUBNODES");
    // REFTREE_ID before REFNODE_ID, per the sibling-mount doc comment.
    expect(childrenSelect!.indexOf("REFTREE_ID")).toBeLessThan(childrenSelect!.indexOf("REFNODE_ID"));
  });

  it("buildNodeRefsQuery: restricted to the COBJ reference type", () => {
    expect(buildNodeRefsQuery(["NODE1", "NODE2"])).toBe(
      "SELECT NODE_ID, EXT_KEY, REF_TYPE, REF_OBJECT\nFROM TNODEIMGR\nWHERE REF_TYPE = 'COBJ'\n  AND NODE_ID IN ('NODE1', 'NODE2')",
    );
  });

  it("buildTreeDirectoryQuery", () => {
    expect(buildTreeDirectoryQuery(["TREE1", "TREE2"])).toBe(
      "SELECT ID, TYPE, NODE_ID\nFROM TTREE\nWHERE ID IN ('TREE1', 'TREE2')",
    );
  });

  it("buildNodesByRefObjectQuery: inverse of buildNodeRefsQuery, keyed by REF_OBJECT + REF_TYPE, ordered by NODE_ID", () => {
    expect(buildNodesByRefObjectQuery("/IWBEP/BATCH_CONFIG", "COBJ")).toBe(
      "SELECT NODE_ID, REF_TYPE, REF_OBJECT\nFROM TNODEIMGR\n" +
        "WHERE REF_OBJECT = '/IWBEP/BATCH_CONFIG'\n  AND REF_TYPE = 'COBJ'\nORDER BY NODE_ID",
    );
  });

  it("buildTreeNodeByIdQuery: same JOIN shape as buildTreeNodeQuery, scoped by NODE_ID alone, TREE_ID added to SELECT", () => {
    expect(buildTreeNodeByIdQuery("NODE1", "E")).toBe(
      "SELECT n~TREE_ID, n~NODE_ID, n~NODE_TYPE, n~PARENT_ID, n~BROTHER_ID, n~REFTREE_ID, n~REFNODE_ID, t~TEXT\n" +
        "FROM TNODEIMG AS n\n" +
        "LEFT OUTER JOIN TNODEIMGT AS t ON t~TREE_ID = n~TREE_ID\n" +
        "  AND t~NODE_ID = n~NODE_ID AND t~SPRAS = 'E'\n" +
        "WHERE n~NODE_ID = 'NODE1'\n" +
        "ORDER BY n~TREE_ID",
    );
  });

  it("buildTreeNodeByIdQuery: no TREE_ID predicate in WHERE (that is the whole point of this builder)", () => {
    const where = buildTreeNodeByIdQuery("NODE1", "E").split("\nWHERE ")[1]!.split("\nORDER")[0]!;
    expect(where).not.toContain("TREE_ID");
  });

  it("no test value anywhere above is a 32-character hex GUID (tree ids/node ids are opaque test strings)", () => {
    const guidLike = /\b[0-9A-Fa-f]{32}\b/;
    expect(guidLike.test("TREE1")).toBe(false);
    expect(guidLike.test("PARENT1")).toBe(false);
    expect(guidLike.test("NODE1")).toBe(false);
  });
});

// ------------------------------------------------------- sweep properties ---

const ALL_TABLES = new Set(Object.values(IMG_CATALOG).map((t) => t.table.toUpperCase()));

/** One representative, valid invocation per exported builder that does not use a JOIN. */
function noJoinBuilderOutputs(): { name: string; sql: string }[] {
  return [
    { name: "buildActivityIdSearchQuery", sql: buildActivityIdSearchQuery("IWBEP", "AAA") },
    { name: "buildActivityTitleSearchQuery", sql: buildActivityTitleSearchQuery("batch", "EN", "AAA") },
    { name: "buildActivityHeaderQuery", sql: buildActivityHeaderQuery("/IWBEP/BATCH_CONFIG") },
    { name: "buildActivityTitlesQuery", sql: buildActivityTitlesQuery(["A1", "A2"], "EN") },
    { name: "buildActivityHeadersByIdQuery", sql: buildActivityHeadersByIdQuery(["X1", "X2"]) },
    { name: "buildActivityObjectsQuery", sql: buildActivityObjectsQuery(["X1", "X2"]) },
    { name: "buildObjectHeadersQuery", sql: buildObjectHeadersQuery(["/IWBEP/C_CCMS", "IMGDUMMY"]) },
    { name: "buildObjectTablesQuery", sql: buildObjectTablesQuery(["/IWBEP/C_CCMS"]) },
    { name: "buildObjectTextsQuery", sql: buildObjectTextsQuery(["/IWBEP/C_CCMS"], "EN") },
    { name: "buildTableDeliveryClassQuery", sql: buildTableDeliveryClassQuery(["DD02L", "CUS_IMGACH"]) },
    { name: "buildViewDirectoryQuery", sql: buildViewDirectoryQuery(["V_T001"]) },
    { name: "buildViewClusterQuery", sql: buildViewClusterQuery(["VC_TEST"]) },
    { name: "buildViewClusterTextQuery", sql: buildViewClusterTextQuery(["VC_TEST"], "EN") },
    { name: "buildViewClusterMembersQuery", sql: buildViewClusterMembersQuery(["VC_TEST"]) },
    { name: "buildTableFieldsQuery", sql: buildTableFieldsQuery(["DD02L", "CUS_IMGACH"]) },
    { name: "buildTableTextsQuery", sql: buildTableTextsQuery(["DD02L", "CUS_IMGACH"], "EN") },
    { name: "buildViewHeaderQuery", sql: buildViewHeaderQuery(["V_T001"]) },
    { name: "buildViewTextQuery", sql: buildViewTextQuery(["V_T001"], "EN") },
    { name: "buildViewBaseTablesQuery", sql: buildViewBaseTablesQuery(["V_T001"]) },
    { name: "buildViewFieldsQuery", sql: buildViewFieldsQuery(["V_T001"]) },
    { name: "buildTransactionsQuery", sql: buildTransactionsQuery(["SE38", "SM30"]) },
    { name: "buildTransactionTextsQuery", sql: buildTransactionTextsQuery(["SE38", "SM30"], "EN") },
    // Worst case for line-length: the 50-value cap, at the longest permitted entity name (30 chars).
    {
      name: "buildObjectHeadersQuery (max IN list, max-length names)",
      sql: buildObjectHeadersQuery(Array.from({ length: MAX_IN_LIST }, (_, i) => `N${i}`.padEnd(30, "X"))),
    },
    { name: "buildTreeRootProbeQuery", sql: buildTreeRootProbeQuery("E") },
    { name: "buildNodeRefsQuery", sql: buildNodeRefsQuery(["NODE1", "NODE2"]) },
    { name: "buildNodesByRefObjectQuery", sql: buildNodesByRefObjectQuery("/IWBEP/BATCH_CONFIG", "COBJ") },
    { name: "buildTreeDirectoryQuery", sql: buildTreeDirectoryQuery(["TREE1", "TREE2"]) },
    // Worst case for line-length among the tree-key builders: the 50-value cap, at
    // the longest permitted tree-key length (32 chars, assertTreeKeyValue's CHAR
    // 32 domain) — this is the case IN_LIST_ITEMS_PER_LINE's comment does the
    // 182-char arithmetic for.
    {
      name: "buildTreeDirectoryQuery (max IN list, max-length tree ids)",
      sql: buildTreeDirectoryQuery(Array.from({ length: MAX_IN_LIST }, (_, i) => `T${i}`.padEnd(32, "X"))),
    },
  ];
}

/**
 * The two tree-walk builders that deliberately DO join TNODEIMG to
 * TNODEIMGT (see the module header comment) — kept out of the no-JOIN sweep
 * on purpose, not because they were forgotten.
 */
function joinBuilderOutputs(): { name: string; sql: string }[] {
  return [
    { name: "buildTreeChildrenQuery", sql: buildTreeChildrenQuery("TREE1", "PARENT1", "E", "NODEAFTER1") },
    { name: "buildTreeNodeQuery", sql: buildTreeNodeQuery("TREE1", "NODE1", "E") },
    { name: "buildTreeNodeByIdQuery", sql: buildTreeNodeByIdQuery("NODE1", "E") },
  ];
}

describe("every builder — SELECT-only, no ';', no in-text UP TO, catalog-only tables, line length", () => {
  const outputs = [...noJoinBuilderOutputs(), ...joinBuilderOutputs()];

  it.each(outputs)("$name starts with SELECT", ({ sql }) => {
    expect(sql.startsWith("SELECT ")).toBe(true);
  });

  it.each(outputs)("$name contains no ';'", ({ sql }) => {
    expect(sql.includes(";")).toBe(false);
  });

  it.each(outputs)("$name contains no in-text UP TO", ({ sql }) => {
    expect(/\bUP\s+TO\b/i.test(sql)).toBe(false);
  });

  it.each(outputs)("$name names only tables present in IMG_CATALOG", ({ sql }) => {
    // Pick up every table named after FROM or JOIN, not just the first (a join builder names two).
    const matches = [...sql.matchAll(/\b(?:FROM|JOIN)\s+(\S+)/g)];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(ALL_TABLES.has(m[1]!.toUpperCase())).toBe(true);
    }
  });

  it.each(outputs)("$name has no line over 200 characters", ({ sql }) => {
    const longest = Math.max(...sql.split("\n").map((l) => l.length));
    expect(longest).toBeLessThanOrEqual(200);
  });
});

describe("buildSelect's line-length guard (IMG_SQL_LINE_MAX)", () => {
  it("real builders, including the max-IN-list/max-length-key worst case, stay within IMG_SQL_LINE_MAX", () => {
    const outputs = [...noJoinBuilderOutputs(), ...joinBuilderOutputs()];
    for (const { name, sql } of outputs) {
      for (const line of sql.split("\n")) {
        expect(line.length, `${name}: line "${line}"`).toBeLessThanOrEqual(IMG_SQL_LINE_MAX);
      }
    }
  });

  // No current public builder's own validators allow constructing a line long enough to
  // trip this guard (the widest cap in the file, assertTreeKeyValue's 32 chars, tops out
  // at a 182-char IN-list line — see IN_LIST_ITEMS_PER_LINE's comment). This test pins the
  // guard against a future builder or a looser validator, not a path reachable today — it
  // calls the exported `buildSelect` directly with a synthetic over-long line rather than
  // through any of the 27 public builders.
  it("pins buildSelect's guard against a future builder: a synthetic over-long line throws CHECK_FAILED naming its length and the ceiling (not reachable via any current public builder)", () => {
    const longValue = "X".repeat(IMG_SQL_LINE_MAX + 1);
    const expectedLineLength = "SELECT ".length + longValue.length;
    let thrown: unknown;
    try {
      buildSelect(longValue, "SOME_TABLE", []);
    } catch (e) {
      thrown = e;
    }
    if (!isAbapError(thrown)) throw new Error("expected buildSelect to throw a CHECK_FAILED AbapError");
    expect(thrown.code).toBe("CHECK_FAILED");
    expect(thrown.message).toContain(`${expectedLineLength}`);
    expect(thrown.message).toContain(`${IMG_SQL_LINE_MAX}`);
    expect(thrown.message).toContain("line 1");
    expect(thrown.details).toMatchObject({ line: 1, length: expectedLineLength });
  });
});

describe("no-JOIN sweep — scoped to the builders that do not need one", () => {
  it.each(noJoinBuilderOutputs())("$name contains no JOIN", ({ sql }) => {
    expect(/\bJOIN\b/i.test(sql)).toBe(false);
  });
});

describe("tree-walk builders are the documented JOIN exception, not an oversight", () => {
  it.each(joinBuilderOutputs())("$name contains exactly one JOIN, LEFT OUTER, ~-qualified not dotted", ({ sql }) => {
    const joinCount = (sql.match(/\bJOIN\b/gi) ?? []).length;
    expect(joinCount).toBe(1);
    expect(sql.includes("LEFT OUTER JOIN")).toBe(true);
    expect(sql.includes("n~")).toBe(true);
    expect(sql.includes("t~")).toBe(true);
    expect(/\bn\.\w|\bt\.\w/.test(sql)).toBe(false);
  });
});

// ------------------------------------------------------------- escaping ---

describe("sqlLiteral / assertSqlValue", () => {
  it("doubles an embedded single quote", () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
  });

  it("assertSqlValue refuses a newline", () => {
    expectBadInput(() => assertSqlValue("line1\nline2", "x"));
  });

  it("assertSqlValue refuses a control character", () => {
    expectBadInput(() => assertSqlValue("bad\x07value", "x"));
  });

  it("assertSqlValue refuses a value over maxLen", () => {
    expectBadInput(() => assertSqlValue("A".repeat(61), "x", 60));
  });

  it("assertSqlValue accepts a value at exactly maxLen", () => {
    expect(assertSqlValue("A".repeat(60), "x", 60)).toBe("A".repeat(60));
  });
});

describe("imgLikePattern", () => {
  it("escapes '%'-shaped input by refusing raw '%' (not a legal input character)", () => {
    expect(() => imgLikePattern("50%")).toThrow();
  });

  it("escapes '_' as '#_' and wraps as a substring match", () => {
    expect(imgLikePattern("A_B")).toEqual({ literal: "%A#_B%", escapeChar: "#" });
  });

  it("doubles a literal '#' before using '#' to escape '_'", () => {
    expect(imgLikePattern("A#B")).toEqual({ literal: "%A##B%", escapeChar: "#" });
  });

  it("maps '*' to '%' and does not substring-wrap a wildcard pattern", () => {
    expect(imgLikePattern("FOO*BAR")).toEqual({ literal: "FOO%BAR", escapeChar: "#" });
  });

  it("refuses an empty pattern", () => {
    expectBadInput(() => imgLikePattern("   "));
  });

  it("refuses a pattern over 40 characters", () => {
    expectBadInput(() => imgLikePattern("A".repeat(41)));
  });
});

describe("transaction code validation (via buildTransactionsQuery)", () => {
  it("upper-cases a lower-case tcode", () => {
    expect(buildTransactionsQuery(["se38"])).toBe("SELECT TCODE, PGMNA, DYPNO\nFROM TSTC\nWHERE TCODE IN ('SE38')");
  });

  it("refuses a tcode with a disallowed character", () => {
    expectBadInput(() => buildTransactionsQuery(["SE 38"]));
  });

  it("refuses a tcode over 20 characters", () => {
    expectBadInput(() => buildTransactionsQuery(["A".repeat(21)]));
  });
});

describe("buildNodesByRefObjectQuery validation", () => {
  it("refuses a refObject with a disallowed character (injection attempt via embedded quote)", () => {
    expectBadInput(() => buildNodesByRefObjectQuery("A' OR '1'='1", "COBJ"));
  });

  it("refuses a refObject over 20 characters", () => {
    expectBadInput(() => buildNodesByRefObjectQuery("A".repeat(21), "COBJ"));
  });

  it("refuses a refType over 10 characters", () => {
    expectBadInput(() => buildNodesByRefObjectQuery("ACT1", "A".repeat(11)));
  });

  it("refuses a refType containing a newline (assertSqlValue's control-character gate)", () => {
    expectBadInput(() => buildNodesByRefObjectQuery("ACT1", "COBJ\nDROP"));
  });
});

describe("buildTreeNodeByIdQuery validation", () => {
  it("refuses a nodeId over 32 characters (assertTreeKeyValue's CHAR 32 domain)", () => {
    expectBadInput(() => buildTreeNodeByIdQuery("N".repeat(33), "E"));
  });

  it("escapes rather than rejects an embedded quote (assertTreeKeyValue has no charset check, per its own doc comment — sqlLiteral is the safety net)", () => {
    const sql = buildTreeNodeByIdQuery("N1' OR '1'='1", "E");
    expect(sql).toContain("n~NODE_ID = 'N1'' OR ''1''=''1'");
  });

  it("refuses a nodeId containing a newline (assertSqlValue's control-character gate)", () => {
    expectBadInput(() => buildTreeNodeByIdQuery("N1\nDROP", "E"));
  });

  it("refuses a malformed language", () => {
    expectBadInput(() => buildTreeNodeByIdQuery("NODE1", "ENG"));
  });
});

describe("assertInList", () => {
  it("refuses an empty list", () => {
    expectBadInput(() => assertInList([], "x"));
  });

  it("accepts a list at exactly the cap", () => {
    const values = Array.from({ length: MAX_IN_LIST }, (_, i) => `v${i}`);
    expect(assertInList(values, "x")).toEqual(values);
  });

  it("refuses a list one over the cap", () => {
    const values = Array.from({ length: MAX_IN_LIST + 1 }, (_, i) => `v${i}`);
    expectBadInput(() => assertInList(values, "x"));
  });
});

// --------------------------------------------------------------- paging ---

describe("keyset paging", () => {
  it("no after -> no '>' predicate, ORDER BY still present", () => {
    const sql = buildActivityIdSearchQuery("IWBEP");
    expect(sql.includes(">")).toBe(false);
    expect(sql.includes("ORDER BY ACTIVITY")).toBe(true);
  });

  it("with after -> '>' predicate present, ORDER BY still present", () => {
    const sql = buildActivityIdSearchQuery("IWBEP", "AAA");
    expect(sql.includes("ACTIVITY > 'AAA'")).toBe(true);
    expect(sql.includes("ORDER BY ACTIVITY")).toBe(true);
  });
});

// --------------------------------------------------------------- mapper ---

const SAMPLE_BODY =
  '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
  "<dataPreview:totalRows>2</dataPreview:totalRows>" +
  "<dataPreview:columns>" +
  '<dataPreview:metadata dataPreview:name="ACTIVITY" dataPreview:type="C" dataPreview:description="ACTIVITY" dataPreview:keyAttribute="true" dataPreview:colType="" dataPreview:isKeyFigure="false"/>' +
  "<dataPreview:dataSet><dataPreview:data>/IWBEP/BATCH_CONFIG</dataPreview:data><dataPreview:data>/AIF/ACTIONS</dataPreview:data></dataPreview:dataSet>" +
  "</dataPreview:columns>" +
  "<dataPreview:columns>" +
  '<dataPreview:metadata dataPreview:name="TEXT" dataPreview:type="C" dataPreview:description="TEXT" dataPreview:keyAttribute="false" dataPreview:colType="" dataPreview:isKeyFigure="false"/>' +
  "<dataPreview:dataSet><dataPreview:data>Batch Configuration</dataPreview:data><dataPreview:data>AIF Actions</dataPreview:data></dataPreview:dataSet>" +
  "</dataPreview:columns>" +
  "</dataPreview:tableData>";

const MESSAGE_BODY =
  '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
  "<dataPreview:totalRows>0</dataPreview:totalRows>" +
  '<dataPreview:message dataPreview:severity="I" dataPreview:text="Query is not supported"/>' +
  "</dataPreview:tableData>";

const ZERO_ROW_WITH_COLUMNS_BODY =
  '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
  "<dataPreview:totalRows>0</dataPreview:totalRows>" +
  "<dataPreview:columns>" +
  '<dataPreview:metadata dataPreview:name="TABNAME" dataPreview:type="C" dataPreview:description="TABNAME" dataPreview:keyAttribute="true" dataPreview:colType="" dataPreview:isKeyFigure="false"/>' +
  "<dataPreview:dataSet/>" +
  "</dataPreview:columns>" +
  "</dataPreview:tableData>";

describe("toRecordSet / requireColumn", () => {
  it("maps a realistic two-column body to name-keyed records", () => {
    const { columns, records, messages } = toRecordSet(SAMPLE_BODY);
    expect(columns).toEqual(["ACTIVITY", "TEXT"]);
    expect(records).toEqual([
      { ACTIVITY: "/IWBEP/BATCH_CONFIG", TEXT: "Batch Configuration" },
      { ACTIVITY: "/AIF/ACTIONS", TEXT: "AIF Actions" },
    ]);
    expect(messages).toEqual([]);
  });

  it("requireColumn returns the value for a present column", () => {
    const { records } = toRecordSet(SAMPLE_BODY);
    expect(requireColumn(records[0]!, "ACTIVITY")).toBe("/IWBEP/BATCH_CONFIG");
  });

  it("requireColumn throws, naming the missing column, rather than returning undefined", () => {
    const { records } = toRecordSet(SAMPLE_BODY);
    try {
      requireColumn(records[0]!, "DOCU_ID");
      throw new Error("expected requireColumn to throw");
    } catch (e) {
      expect(isAbapError(e)).toBe(true);
      expect((e as AbapError).message).toContain("DOCU_ID");
    }
  });

  it("an in-band message survives even with zero rows", () => {
    const { records, columns, messages } = toRecordSet(MESSAGE_BODY);
    expect(records).toEqual([]);
    expect(columns).toEqual([]);
    expect(messages).toEqual([{ text: "Query is not supported", severity: "I" }]);
  });

  it("zero rows with columns is distinguishable from zero rows with no columns", () => {
    const withColumns = toRecordSet(ZERO_ROW_WITH_COLUMNS_BODY);
    const messageOnly = toRecordSet(MESSAGE_BODY);
    expect(withColumns.records).toEqual([]);
    expect(withColumns.columns).toEqual(["TABNAME"]);
    expect(messageOnly.records).toEqual([]);
    expect(messageOnly.columns).toEqual([]);
  });
});
