/**
 * Coverage-focused tests for src/adt/footprint.ts, beyond the primary
 * live-fixture suite in test/footprint.test.ts: classifyStatement shapes not
 * exercised by fixture 983 (EXEC SQL, ADBC, BOPF, dynamic UPDATE/DELETE/MODIFY/
 * INSERT INTO...VALUES/SUBMIT), the tokenizer's odd-input handling,
 * buildReadCall's per-type include tagging, buildFootprint's include
 * resolution for every FOOTPRINT_TYPES member (including catch paths and
 * maxLines truncation), and renderFootprint's remaining branches.
 */
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapError } from "../src/adt/errors.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import {
  buildFootprint,
  renderFootprint,
  scanFootprint,
  type FootprintOccurrence,
  type FootprintResult,
} from "../src/adt/footprint.js";
import { buildUri, classIncludeUri, CLASS_INCLUDES, specForType, type TypeSpec } from "../src/adt/types.js";

const OBJ_983 = { name: "Z_I107_FOOTPRINT", type: "PROG/P" };

// ---------------------------------------------------------------------------
// classifyStatement shapes not in fixture 983
// ---------------------------------------------------------------------------

describe("scanFootprint: EXPORT/DELETE ... TO/FROM DATABASE", () => {
  it("DELETE FROM DATABASE <area> ID '...' is kind=\"export to database\" targeting that area", () => {
    const [o] = scanFootprint("DELETE FROM DATABASE ZTAB1 ID 'AB'.", "main", OBJ_983);
    expect(o?.kind).toBe("export to database");
    expect(o?.table).toBe("ZTAB1");
    expect(o?.detail).toBe("ZTAB1");
  });
});

describe("scanFootprint: BOPF modify", () => {
  it("/BOBF/IF_TRA_SERVICE_MANAGER->MODIFY( ... ) is kind=\"bopf modify\" and discloses no live ground truth", () => {
    const [o] = scanFootprint(
      "lo_svc->/BOBF/IF_TRA_SERVICE_MANAGER->MODIFY( it_change = lt_change ).",
      "main",
      OBJ_983,
    );
    expect(o?.kind).toBe("bopf modify");
    expect(o?.detail).toBe("/BOBF/IF_TRA_SERVICE_MANAGER->MODIFY (no live ground truth)");
  });
});

describe("scanFootprint: EXEC SQL ... ENDEXEC", () => {
  it("resolves the table from an embedded INSERT INTO", () => {
    const source = ["EXEC SQL", "  INSERT INTO ZTAB (COL1) VALUES (:A)", "ENDEXEC."].join("\n");
    const [o] = scanFootprint(source, "main", OBJ_983);
    expect(o?.kind).toBe("native sql");
    expect(o?.table).toBe("ZTAB");
  });

  it("falls back to unresolved when no INSERT/UPDATE/FROM/INTO appears in the block", () => {
    const source = ["EXEC SQL", "  COMMIT", "ENDEXEC."].join("\n");
    const [o] = scanFootprint(source, "main", OBJ_983);
    expect(o?.kind).toBe("native sql");
    expect(o?.unresolved).toBe("table not statically resolved from EXEC SQL block");
    expect(o?.table).toBeUndefined();
  });

  it("resolves the table from an embedded UPDATE when there is no INSERT INTO", () => {
    const source = ["EXEC SQL", "  UPDATE ZTAB2 SET COL = 1", "ENDEXEC."].join("\n");
    const [o] = scanFootprint(source, "main", OBJ_983);
    expect(o?.table).toBe("ZTAB2");
  });

  it("resolves the table from an embedded FROM when there is no INSERT/UPDATE", () => {
    const source = ["EXEC SQL", "  SELECT COL FROM ZTAB3", "ENDEXEC."].join("\n");
    const [o] = scanFootprint(source, "main", OBJ_983);
    expect(o?.table).toBe("ZTAB3");
  });

  it("resolves the target from an embedded INTO when nothing else matches", () => {
    const source = ["EXEC SQL", "  FETCH CURSOR C1 INTO WA", "ENDEXEC."].join("\n");
    const [o] = scanFootprint(source, "main", OBJ_983);
    expect(o?.table).toBe("WA");
  });
});

describe("scanFootprint: ADBC (cl_sql_statement / cl_sql_connection)", () => {
  it("resolves the table from an embedded UPDATE string", () => {
    const [o] = scanFootprint("cl_sql_statement->execute_update( 'UPDATE ZTAB SET X = 1' ).", "main", OBJ_983);
    expect(o?.kind).toBe("adbc");
    expect(o?.table).toBe("ZTAB");
  });

  it("falls back to unresolved when the embedded string has no INSERT/UPDATE/DELETE", () => {
    const [o] = scanFootprint("cl_sql_connection->execute_ddl( 'CREATE TABLE ZFOO' ).", "main", OBJ_983);
    expect(o?.kind).toBe("adbc");
    expect(o?.unresolved).toBe("table not statically resolved from embedded SQL string");
  });
});

describe("scanFootprint: dynamic SUBMIT", () => {
  it("SUBMIT (dynamic report) is kind=\"submit\" with an unresolved marker, not a detail", () => {
    const [o] = scanFootprint("SUBMIT (GV_REPORT).", "main", OBJ_983);
    expect(o?.kind).toBe("submit");
    expect(o?.unresolved).toBe("(GV_REPORT)");
    expect(o?.detail).toBeUndefined();
  });
});

describe("scanFootprint: Open SQL shapes not in fixture 983", () => {
  it("INSERT INTO <tab> VALUES ... is a DB write, dynamic table sets unresolved", () => {
    const [o] = scanFootprint("INSERT INTO (GV_TAB) VALUES WA.", "main", OBJ_983);
    expect(o?.kind).toBe("insert");
    expect(o?.unresolved).toBe("(GV_TAB)");
  });

  it("MODIFY TABLE <itab> FROM <wa> is excluded (itab operation, TABLE right after MODIFY)", () => {
    const occurrences = scanFootprint("MODIFY TABLE GT_TAB FROM WA.", "main", OBJ_983);
    expect(occurrences).toHaveLength(0);
  });

  it("MODIFY (dynamic tab) FROM <wa> is a DB write with unresolved set", () => {
    const [o] = scanFootprint("MODIFY (GV_TAB) FROM WA.", "main", OBJ_983);
    expect(o?.kind).toBe("modify");
    expect(o?.unresolved).toBe("(GV_TAB)");
  });

  it("UPDATE (dynamic tab) SET ... is a DB write with unresolved set", () => {
    const [o] = scanFootprint("UPDATE (GV_TAB) SET X = 1.", "main", OBJ_983);
    expect(o?.kind).toBe("update");
    expect(o?.unresolved).toBe("(GV_TAB)");
  });

  it("DELETE FROM (dynamic tab) WHERE ... is a DB write with unresolved set", () => {
    const [o] = scanFootprint("DELETE FROM (GV_TAB) WHERE X = 1.", "main", OBJ_983);
    expect(o?.kind).toBe("delete");
    expect(o?.unresolved).toBe("(GV_TAB)");
  });

  it("DELETE (dynamic tab) FROM <wa> is a DB write with unresolved set", () => {
    const [o] = scanFootprint("DELETE (GV_TAB) FROM WA.", "main", OBJ_983);
    expect(o?.kind).toBe("delete");
    expect(o?.unresolved).toBe("(GV_TAB)");
  });

  it("UPDATE (dynamic tab) FROM <wa> is a DB write with unresolved set", () => {
    const [o] = scanFootprint("UPDATE (GV_TAB) FROM WA.", "main", OBJ_983);
    expect(o?.kind).toBe("update");
    expect(o?.unresolved).toBe("(GV_TAB)");
  });

  it("UPDATE (dynamic tab) FROM TABLE <itab> is a DB write", () => {
    const [o] = scanFootprint("UPDATE (GV_TAB) FROM TABLE GT_ROWS.", "main", OBJ_983);
    expect(o?.kind).toBe("update");
    expect(o?.unresolved).toBe("(GV_TAB)");
  });

  it("DELETE FROM (dynamic tab) with nothing after the table is a DB write", () => {
    const [o] = scanFootprint("DELETE FROM (GV_TAB).", "main", OBJ_983);
    expect(o?.kind).toBe("delete");
    expect(o?.unresolved).toBe("(GV_TAB)");
  });

  it("lower-case dynamic UPDATE and DELETE FROM are uppercased in unresolved", () => {
    const source = "update (gv_tab) set x = 1.\ndelete from (gv_tab) where x = 1.";
    const occurrences = scanFootprint(source, "main", OBJ_983);
    expect(occurrences.map((o) => o.kind)).toEqual(["update", "delete"]);
    expect(occurrences[0]?.unresolved).toBe("(GV_TAB)");
    expect(occurrences[1]?.unresolved).toBe("(GV_TAB)");
  });

  it("dynamic UPDATE split across lines is still one DB write", () => {
    const source = ["UPDATE", "  (GV_TAB)", "  SET X = 1."].join("\n");
    const occurrences = scanFootprint(source, "main", OBJ_983);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.kind).toBe("update");
    expect(occurrences[0]?.unresolved).toBe("(GV_TAB)");
    expect(occurrences[0]?.line).toBe(1);
  });

  it.each([
    ["UPDATE (LS_CFG-TABNAME) SET X = 1.", "update", "(LS_CFG-TABNAME)"],
    ["DELETE FROM (<LV_TAB>) WHERE X = 1.", "delete", "(<LV_TAB>)"],
    ["MODIFY (ME->MV_TAB) FROM WA.", "modify", "(ME->MV_TAB)"],
    ["INSERT (LS_CFG-TABNAME) FROM TABLE GT_ROWS.", "insert", "(LS_CFG-TABNAME)"],
    ["INSERT INTO (<LV_TAB>) VALUES WA.", "insert", "(<LV_TAB>)"],
    ["DELETE (LS_CFG-TABNAME) FROM WA.", "delete", "(LS_CFG-TABNAME)"],
  ])("a dynamic token naming a structure component, field symbol or attribute is unresolved: %s", (src, kind, unresolved) => {
    const [o] = scanFootprint(src, "main", OBJ_983);
    expect(o?.kind).toBe(kind);
    expect(o?.unresolved).toBe(unresolved);
    expect(o?.table).toBeUndefined();
  });

  it("static UPDATE and DELETE FROM still resolve the table name", () => {
    const [u] = scanFootprint("UPDATE ZTAB1 SET X = 1.", "main", OBJ_983);
    expect(u?.kind).toBe("update");
    expect(u?.table).toBe("ZTAB1");
    expect(u?.unresolved).toBeUndefined();

    const [d] = scanFootprint("DELETE FROM /ABC/TAB WHERE X = 1.", "main", OBJ_983);
    expect(d?.kind).toBe("delete");
    expect(d?.table).toBe("/ABC/TAB");
    expect(d?.unresolved).toBeUndefined();
  });

  it("UPDATE TASK is not a database write", () => {
    expect(scanFootprint("UPDATE TASK LOCAL.", "main", OBJ_983)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tokenizer edge cases (splitStatements, exercised only through scanFootprint)
// ---------------------------------------------------------------------------

describe("scanFootprint: tokenizer edge cases", () => {
  it("a decimal point mid-statement is not mistaken for a terminator", () => {
    const source = ["WRITE 3.14.", "COMMIT WORK."].join("\n");
    const occurrences = scanFootprint(source, "main", OBJ_983);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.kind).toBe("commit");
    expect(occurrences[0]?.line).toBe(2);
  });

  it("two statements on one line are split correctly, and a trailing fragment carries its startLine to the next line", () => {
    const source = ["COMMIT WORK. ROLLBACK", "    WORK."].join("\n");
    const occurrences = scanFootprint(source, "main", OBJ_983);
    expect(occurrences.map((o) => o.kind)).toEqual(["commit", "rollback"]);
    expect(occurrences[0]?.line).toBe(1);
    expect(occurrences[1]?.line).toBe(1);
  });

  it("a line containing only a lone terminating period yields no phantom statement", () => {
    const source = ["COMMIT WORK.", ".", "ROLLBACK WORK."].join("\n");
    const occurrences = scanFootprint(source, "main", OBJ_983);
    expect(occurrences.map((o) => o.kind)).toEqual(["commit", "rollback"]);
    expect(occurrences[1]?.line).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// buildReadCall (only reachable via scanFootprint's occurrence.readCall)
// ---------------------------------------------------------------------------

describe("scanFootprint: readCall synthesis per include/objectRef.type combination", () => {
  const stmt = "INSERT ZTAB FROM WA.";

  it("include=\"main\" always names objectRef directly, regardless of type", () => {
    const [o] = scanFootprint(stmt, "main", { name: "Z_ANY", type: "FUGR/FF" });
    expect(o?.readCall).toBe(JSON.stringify({ object: "Z_ANY", type: "FUGR/FF" }));
  });

  it("CLAS/OC + a real class include tags the include on the class object", () => {
    const [o] = scanFootprint(stmt, "definitions", { name: "ZCL_FOO", type: "CLAS/OC" });
    expect(o?.readCall).toBe(JSON.stringify({ object: "ZCL_FOO", type: "CLAS/OC", include: "definitions" }));
  });

  it("an include tag already containing \"/\" is treated as a complete FUGR/I object name", () => {
    const [o] = scanFootprint(stmt, "ZGRP1/LZGRP1TOP", { name: "Z_MODULE", type: "FUGR/FF" });
    expect(o?.readCall).toBe(JSON.stringify({ object: "ZGRP1/LZGRP1TOP", type: "FUGR/I" }));
  });

  it("PROG/P + a plain include name tags it as a PROG/I", () => {
    const [o] = scanFootprint(stmt, "ZINC1", { name: "Z_REPORT", type: "PROG/P" });
    expect(o?.readCall).toBe(JSON.stringify({ object: "ZINC1", type: "PROG/I" }));
  });

  it("PROG/I objectRef type also tags a plain include name as PROG/I", () => {
    const [o] = scanFootprint(stmt, "ZINC1", { name: "ZINC0", type: "PROG/I" });
    expect(o?.readCall).toBe(JSON.stringify({ object: "ZINC1", type: "PROG/I" }));
  });

  it("FUGR/F + a plain include name qualifies it under the group name", () => {
    const [o] = scanFootprint(stmt, "LGRPINC", { name: "ZGRP1", type: "FUGR/F" });
    expect(o?.readCall).toBe(JSON.stringify({ object: "ZGRP1/LGRPINC", type: "FUGR/I" }));
  });

  it("FUGR/FF + a plain, un-prequalified include tag falls back to a labelled FUGR/I", () => {
    const [o] = scanFootprint(stmt, "SOMETAG", { name: "Z_MODULE", type: "FUGR/FF" });
    expect(o?.readCall).toBe(JSON.stringify({ object: "SOMETAG", type: "FUGR/I" }));
  });
});

// ---------------------------------------------------------------------------
// buildFootprint: fake connection helper
// ---------------------------------------------------------------------------

type Route = string | "FAIL";

function fakeConn(routes: Record<string, Route>): AbapConnection {
  return {
    cfg: { sid: "T01" },
    get: async (uri: string) => {
      const hit = routes[uri];
      if (hit === undefined || hit === "FAIL") {
        throw new AbapError("NOT_FOUND", `fake: no route for ${uri}`);
      }
      return { body: hit, headers: {} };
    },
  } as unknown as AbapConnection;
}

function makeObj(type: string, name: string, opts: { parent?: string } = {}): ResolvedObject {
  const spec = specForType(type) as TypeSpec;
  const uri = buildUri(spec, name, opts.parent);
  return {
    system: "T01",
    type,
    kind: spec.kind,
    label: spec.label,
    name,
    uri,
    sourceUri: `${uri}/source/main`,
    mode: spec.mode,
    activation: "unknown",
    spec,
    ...(opts.parent !== undefined ? { parent: opts.parent } : {}),
  };
}

function progIncludeUri(name: string): string {
  return buildUri(specForType("PROG/I") as TypeSpec, name);
}

function fugrIncludeUri(name: string, parent: string): string {
  return buildUri(specForType("FUGR/I") as TypeSpec, name, parent);
}

// ---------------------------------------------------------------------------
// buildFootprint: unsupported type guard
// ---------------------------------------------------------------------------

describe("buildFootprint: unsupported object type", () => {
  it("rejects with UNSUPPORTED, naming the object's actual type and the supported list", async () => {
    const obj = makeObj("INTF/OI", "ZIF_FOO");
    await expect(buildFootprint(fakeConn({}), obj)).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("INTF/OI"),
    });
  });
});

// ---------------------------------------------------------------------------
// buildFootprint: PROG/P include resolution
// ---------------------------------------------------------------------------

describe("buildFootprint: PROG/P resolves its INCLUDE statements one level deep", () => {
  it("reads main plus each named include, and marks an unreadable include without scanning it", async () => {
    const obj = makeObj("PROG/P", "Z_REPORT");
    const mainSource = ["REPORT z_report.", "INCLUDE zinc_ok.", "INCLUDE zinc_bad.", "COMMIT WORK."].join("\n");
    const conn = fakeConn({
      [obj.sourceUri as string]: mainSource,
      [`${progIncludeUri("ZINC_OK")}/source/main`]: "INSERT ZTAB1 FROM WA1.",
      [`${progIncludeUri("ZINC_BAD")}/source/main`]: "FAIL",
    });

    const result = await buildFootprint(conn, obj);
    expect(result.includes).toEqual(["main", "ZINC_OK", "ZINC_BAD (unreadable)"]);
    expect(result.occurrences.map((o) => o.kind)).toEqual(["commit", "insert"]);
    expect(result.occurrences.find((o) => o.kind === "insert")?.include).toBe("ZINC_OK");
  });
});

// ---------------------------------------------------------------------------
// buildFootprint: CLAS/OC resolves all five class includes
// ---------------------------------------------------------------------------

describe("buildFootprint: CLAS/OC reads every class include, absent ones are (not found)", () => {
  it("scans found includes and leaves absent ones out of occurrences", async () => {
    const obj = makeObj("CLAS/OC", "ZCL_FOO");
    const implSource = [
      "CLASS zcl_foo IMPLEMENTATION.",
      "  METHOD do_write.",
      "    INSERT ZTAB FROM WA.",
      "  ENDMETHOD.",
      "ENDCLASS.",
    ].join("\n");
    const conn = fakeConn({
      [obj.sourceUri as string]: "CLASS zcl_foo DEFINITION DEFERRED.",
      [classIncludeUri(obj.uri, "definitions")]: "CLASS zcl_foo DEFINITION.\nENDCLASS.",
      [classIncludeUri(obj.uri, "implementations")]: implSource,
      [classIncludeUri(obj.uri, "macros")]: "FAIL",
      [classIncludeUri(obj.uri, "testclasses")]: "FAIL",
    });

    const result = await buildFootprint(conn, obj);
    expect(result.includes).toEqual([
      "main",
      "definitions",
      "implementations",
      "macros (not found)",
      "testclasses (not found)",
    ]);
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]?.include).toBe("implementations");
    expect(result.occurrences[0]?.readCall).toBe(
      JSON.stringify({ object: "ZCL_FOO", type: "CLAS/OC", include: "implementations" }),
    );

    const rendered = renderFootprint(result);
    expect(rendered.hints.some((h) => h.includes('"macros (not found)"'))).toBe(true);
    expect(rendered.hints.some((h) => h.includes('"testclasses (not found)"'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildFootprint: FUGR/F two-level BFS over INCLUDE statements
// ---------------------------------------------------------------------------

describe("buildFootprint: FUGR/F walks two levels of INCLUDE, dedupes, and marks unreadable ones", () => {
  it("resolves TOP/UXX at level 1 and the per-module includes at level 2, skipping an already-seen name", async () => {
    const obj = makeObj("FUGR/F", "ZGRP1");
    const mainSource = ["INCLUDE LZGRP1TOP.", "INCLUDE LZGRP1UXX.", "INCLUDE LZGRP1BAD."].join("\n");
    const uxxSource = ["INCLUDE LZGRP1U01.", "INCLUDE LZGRP1U02.", "INCLUDE LZGRP1TOP."].join("\n");
    const u01Source = ["FORM ENTRY.", "  INSERT ZTAB FROM WA.", "ENDFORM."].join("\n");

    const conn = fakeConn({
      [obj.sourceUri as string]: mainSource,
      [`${fugrIncludeUri("LZGRP1TOP", "ZGRP1")}/source/main`]: "DATA: gv_flag TYPE c.",
      [`${fugrIncludeUri("LZGRP1UXX", "ZGRP1")}/source/main`]: uxxSource,
      [`${fugrIncludeUri("LZGRP1BAD", "ZGRP1")}/source/main`]: "FAIL",
      [`${fugrIncludeUri("LZGRP1U01", "ZGRP1")}/source/main`]: u01Source,
      [`${fugrIncludeUri("LZGRP1U02", "ZGRP1")}/source/main`]: "FAIL",
    });

    const result = await buildFootprint(conn, obj);
    expect(result.includes).toEqual([
      "main",
      "LZGRP1TOP",
      "LZGRP1UXX",
      "LZGRP1BAD (unreadable)",
      "LZGRP1U01",
      "LZGRP1U02 (unreadable)",
    ]);
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]?.kind).toBe("insert");
    expect(result.occurrences[0]?.include).toBe("LZGRP1U01");
    expect(result.occurrences[0]?.line).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildFootprint: FUGR/FF (function module) + its group's TOP include
// ---------------------------------------------------------------------------

describe("buildFootprint: FUGR/FF resolves its own body plus the group's TOP include", () => {
  it("with no parent group, records an unreadable group-top marker and scans only the module body", async () => {
    const obj = makeObj("FUGR/FF", "Z_MODULE");
    const conn = fakeConn({ [obj.sourceUri as string]: "INSERT ZTAB FROM WA." });

    const result = await buildFootprint(conn, obj);
    expect(result.includes).toEqual(["main", "group's TOP include (unreadable: object has no parent group)"]);
    expect(result.occurrences).toHaveLength(1);
  });

  it("when the group's own main source cannot be read, records the outer-catch marker", async () => {
    const obj = makeObj("FUGR/FF", "Z_MODULE", { parent: "ZGRP2" });
    const conn = fakeConn({
      [obj.sourceUri as string]: "INSERT ZTAB FROM WA.",
      // No route for the group's main source -> FAIL.
      [buildUri(specForType("FUGR/F") as TypeSpec, "ZGRP2") + "/source/main"]: "FAIL",
    });

    const result = await buildFootprint(conn, obj);
    expect(result.includes).toEqual([
      "main",
      "group's TOP include (unreadable: could not read group main source)",
    ]);
  });

  it("when the group has no include ending in TOP, no group-top entry is added at all", async () => {
    const obj = makeObj("FUGR/FF", "Z_MODULE", { parent: "ZGRP3" });
    const conn = fakeConn({
      [obj.sourceUri as string]: "INSERT ZTAB FROM WA.",
      [buildUri(specForType("FUGR/F") as TypeSpec, "ZGRP3") + "/source/main"]: "INCLUDE LZGRP3UXX.",
    });

    const result = await buildFootprint(conn, obj);
    expect(result.includes).toEqual(["main"]);
  });

  it("when the TOP include itself cannot be read, records the qualified unreadable marker", async () => {
    const obj = makeObj("FUGR/FF", "Z_MODULE", { parent: "ZGRP4" });
    const conn = fakeConn({
      [obj.sourceUri as string]: "INSERT ZTAB FROM WA.",
      [buildUri(specForType("FUGR/F") as TypeSpec, "ZGRP4") + "/source/main"]: "INCLUDE LZGRP4TOP.",
      [`${fugrIncludeUri("LZGRP4TOP", "ZGRP4")}/source/main`]: "FAIL",
    });

    const result = await buildFootprint(conn, obj);
    expect(result.includes).toEqual(["main", "ZGRP4/LZGRP4TOP (unreadable)"]);
  });

  it("on full success, scans the qualified group/TOP include and tags its readCall as a FUGR/I", async () => {
    const obj = makeObj("FUGR/FF", "Z_MODULE", { parent: "ZGRP5" });
    const conn = fakeConn({
      [obj.sourceUri as string]: "COMMIT WORK.",
      [buildUri(specForType("FUGR/F") as TypeSpec, "ZGRP5") + "/source/main"]: "INCLUDE LZGRP5TOP.",
      [`${fugrIncludeUri("LZGRP5TOP", "ZGRP5")}/source/main`]: "INSERT ZTAB FROM WA.",
    });

    const result = await buildFootprint(conn, obj);
    expect(result.includes).toEqual(["main", "ZGRP5/LZGRP5TOP"]);
    const insert = result.occurrences.find((o) => o.kind === "insert");
    expect(insert?.include).toBe("ZGRP5/LZGRP5TOP");
    expect(insert?.readCall).toBe(JSON.stringify({ object: "ZGRP5/LZGRP5TOP", type: "FUGR/I" }));
  });
});

// ---------------------------------------------------------------------------
// buildFootprint: maxLines truncation
// ---------------------------------------------------------------------------

describe("buildFootprint: maxLines truncation", () => {
  it("scans what fits, marks truncatedAt, and skips any include reached after the budget is spent", async () => {
    const obj = makeObj("PROG/P", "Z_TRUNC");
    const mainSource = ["REPORT z_trunc.", "INCLUDE zinc1.", "INCLUDE zinc2.", "COMMIT WORK."].join("\n");
    const zinc1Source = [
      "INSERT ZTAB1 FROM WA1.",
      "WRITE 'l2'.",
      "WRITE 'l3'.",
      "WRITE 'l4'.",
      "WRITE 'l5'.",
      "INSERT ZTAB2 FROM WA2.",
      "WRITE 'l7'.",
    ].join("\n");
    const conn = fakeConn({
      [obj.sourceUri as string]: mainSource,
      [`${progIncludeUri("ZINC1")}/source/main`]: zinc1Source,
      [`${progIncludeUri("ZINC2")}/source/main`]: "INSERT ZTAB3 FROM WA3.",
    });

    const result = await buildFootprint(conn, obj, { maxLines: 7 });
    expect(result.linesScanned).toBe(7);
    expect(result.truncatedAt).toEqual({ include: "ZINC1", line: 4 });
    // main's own COMMIT WORK was scanned fully; ZINC1 only up to the budget;
    // ZINC2 was never reached at all despite appearing in `includes`.
    expect(result.occurrences.map((o) => `${o.kind}:${o.include}`)).toEqual(["commit:main", "insert:ZINC1"]);
    expect(result.includes).toEqual(["main", "ZINC1", "ZINC2"]);

    const rendered = renderFootprint(result);
    expect(rendered.header.truncated).toBe("ZINC1:4");
    expect(rendered.body).toContain("--- TRUNCATED ---");
    expect(rendered.hints.some((h) => h.includes("ZINC1:4"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildFootprint: writesOnlyViaUpdateTask heuristic
// ---------------------------------------------------------------------------

describe("buildFootprint: writesOnlyViaUpdateTask heuristic", () => {
  it("is true when every write sits inside a FORM/ENDFORM block alongside an update-task call", async () => {
    const obj = makeObj("PROG/P", "Z_FORM_WRITE");
    const mainSource = [
      "REPORT z_form_write.",
      "START-OF-SELECTION.",
      "  PERFORM do_write.",
      "FORM do_write.",
      "  INSERT ZTAB FROM WA.",
      "  CALL FUNCTION 'ZFM_ASYNC' IN UPDATE TASK.",
      "ENDFORM.",
    ].join("\n");
    const conn = fakeConn({ [obj.sourceUri as string]: mainSource });

    const result = await buildFootprint(conn, obj);
    expect(result.writesOnlyViaUpdateTask).toBe(true);

    const rendered = renderFootprint(result);
    expect(rendered.body).toMatch(/consistent with \(but not proof of\) writes/);
  });

  it("is true when every write sits inside a METHOD/ENDMETHOD block alongside an update-task call", async () => {
    const obj = makeObj("CLAS/OC", "ZCL_ASYNC_WRITE");
    const implSource = [
      "CLASS zcl_async_write IMPLEMENTATION.",
      "  METHOD do_write.",
      "    INSERT ZTAB FROM WA.",
      "    CALL FUNCTION 'ZFM_ASYNC' IN UPDATE TASK.",
      "  ENDMETHOD.",
      "ENDCLASS.",
    ].join("\n");
    const conn = fakeConn({
      [obj.sourceUri as string]: "CLASS zcl_async_write DEFINITION DEFERRED.",
      [classIncludeUri(obj.uri, "definitions")]: "FAIL",
      [classIncludeUri(obj.uri, "implementations")]: implSource,
      [classIncludeUri(obj.uri, "macros")]: "FAIL",
      [classIncludeUri(obj.uri, "testclasses")]: "FAIL",
    });

    const result = await buildFootprint(conn, obj);
    expect(result.writesOnlyViaUpdateTask).toBe(true);
  });

  it("is vacuously true when an update-task call is present but there are no writes at all", async () => {
    const obj = makeObj("PROG/P", "Z_TASK_ONLY");
    const conn = fakeConn({
      [obj.sourceUri as string]: "CALL FUNCTION 'ZFM_ASYNC' IN UPDATE TASK.",
    });

    const result = await buildFootprint(conn, obj);
    expect(result.writesOnlyViaUpdateTask).toBe(true);
    expect(result.occurrences).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// renderFootprint: remaining branches (constructed FootprintResult, no network)
// ---------------------------------------------------------------------------

function occ(partial: Partial<FootprintOccurrence> & Pick<FootprintOccurrence, "kind">): FootprintOccurrence {
  return {
    include: "main",
    line: 1,
    statement: "STMT.",
    readCall: JSON.stringify({ object: "Z_X", type: "PROG/P" }),
    ...partial,
  };
}

function result(partial: Partial<FootprintResult>): FootprintResult {
  return {
    object: "PROG/P Z_X",
    includes: ["main"],
    occurrences: [],
    linesScanned: 1,
    commitFound: false,
    writesOnlyViaUpdateTask: false,
    ...partial,
  };
}

describe("renderFootprint: summary sentence branches", () => {
  it("reports no findings when there are zero occurrences", () => {
    const r = renderFootprint(result({ occurrences: [] }));
    expect(r.header.occurrences).toBe(0);
    expect(r.header.truncated).toBeUndefined();
    expect(r.body).toContain("(none found in the scanned includes)");
    expect(r.body).toContain("No write, commit, or write-adjacent statement was found");
  });

  it("reports the update-task caveat when writesOnlyViaUpdateTask is true", () => {
    const r = renderFootprint(
      result({
        occurrences: [occ({ kind: "insert", table: "ZTAB" }), occ({ kind: "update task", detail: "ZFM" })],
        writesOnlyViaUpdateTask: true,
      }),
    );
    expect(r.body).toMatch(/consistent with \(but not proof of\) writes/);
  });

  it("reports the direct-write-no-commit sentence when neither commitFound nor writesOnlyViaUpdateTask holds", () => {
    const r = renderFootprint(result({ occurrences: [occ({ kind: "insert", table: "ZTAB" })] }));
    expect(r.body).toMatch(/a caller's COMMIT WORK governs/);
  });
});

describe("renderFootprint: truncation and unreadable-include hints", () => {
  it("renders the truncated header, body marker, and hint when truncatedAt is set", () => {
    const r = renderFootprint(
      result({
        occurrences: [occ({ kind: "insert", table: "ZTAB" })],
        truncatedAt: { include: "ZINC1", line: 42 },
      }),
    );
    expect(r.header.truncated).toBe("ZINC1:42");
    expect(r.body).toContain("--- TRUNCATED --- scan stopped at ZINC1:42");
    expect(r.hints.some((h) => h.includes("Scan stopped at ZINC1:42"))).toBe(true);
  });

  it("adds a hint for every include marked unreadable or not found, and none otherwise", () => {
    const r = renderFootprint(
      result({ includes: ["main", "ZINC1 (unreadable)", "macros (not found)"], occurrences: [] }),
    );
    expect(r.hints).toHaveLength(2);
    expect(r.hints.some((h) => h.includes('"ZINC1 (unreadable)"'))).toBe(true);
    expect(r.hints.some((h) => h.includes('"macros (not found)"'))).toBe(true);
  });
});

describe("renderFootprint: per-table summary sorting", () => {
  it("sorts named tables alphabetically and always pushes \"(n/a)\" last", () => {
    const r = renderFootprint(
      result({
        occurrences: [
          occ({ kind: "insert", table: "BBB_TAB" }),
          occ({ kind: "update", table: "AAA_TAB" }),
          occ({ kind: "call transaction", table: undefined, detail: "SE16" }),
        ],
      }),
    );
    const idxAaa = r.body.indexOf("AAA_TAB");
    const idxBbb = r.body.indexOf("BBB_TAB");
    const idxNa = r.body.indexOf("(n/a)");
    expect(idxAaa).toBeGreaterThan(-1);
    expect(idxBbb).toBeGreaterThan(idxAaa);
    expect(idxNa).toBeGreaterThan(idxBbb);
  });
});
