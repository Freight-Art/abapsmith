/**
 * `view="footprint"` (issue #107) — `src/adt/footprint.ts`: `scanFootprint`
 * (pure statement classifier) and `renderFootprint` (rendering) against the
 * live-captured source test/fixtures/live-captured/983-i107-source-z-i107-
 * footprint.txt (a REPORT with one of every recognised write/commit/
 * write-adjacent statement, plus two commented-out writes that must not
 * be reported).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { buildFootprint, renderFootprint, scanFootprint } from "../src/adt/footprint.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const SRC_983 = readFileSync(join(FIXTURES, "983-i107-source-z-i107-footprint.txt"), "utf8");

const OBJ_983 = { name: "Z_I107_FOOTPRINT", type: "PROG/P" };

describe("scanFootprint (983): finds exactly 14 occurrences with the right kind/target for each", () => {
  const occurrences = scanFootprint(SRC_983, "main", OBJ_983);

  it("finds exactly 14 occurrences total", () => {
    expect(occurrences).toHaveLength(14);
  });

  it("the four plain Open SQL writes are insert/update/modify/delete on ZDEMO_SOH", () => {
    const plain = occurrences.filter((o) => ["insert", "update", "modify", "delete"].includes(o.kind) && o.table !== undefined);
    expect(plain.map((o) => `${o.kind}:${o.table}`)).toEqual([
      "insert:ZDEMO_SOH",
      "update:ZDEMO_SOH",
      "modify:ZDEMO_SOH",
      "delete:ZDEMO_SOH",
    ]);
  });

  it("the dynamic INSERT (gv_tab) FROM gs_soh sets the unresolved marker and leaves table unset", () => {
    const dyn = occurrences.find((o) => o.kind === "insert" && o.table === undefined);
    expect(dyn).toBeDefined();
    expect(dyn?.unresolved).toBe("(GV_TAB)");
    expect(dyn?.table).toBeUndefined();
  });

  it("update task and background task calls are their own kinds, each detailing the RFC name", () => {
    const updateTask = occurrences.find((o) => o.kind === "update task");
    const backgroundTask = occurrences.find((o) => o.kind === "background task");
    expect(updateTask?.detail).toBe("RFC_SYSTEM_INFO");
    expect(backgroundTask?.detail).toBe("RFC_SYSTEM_INFO");
  });

  it("a multi-line CALL FUNCTION ... IN BACKGROUND TASK DESTINATION 'NONE' (statement spans lines 22-23) is ONE occurrence, not two", () => {
    const backgroundTasks = occurrences.filter((o) => o.kind === "background task");
    expect(backgroundTasks).toHaveLength(1);
    expect(backgroundTasks[0]?.line).toBe(22);
  });

  it("COMMIT WORK / ROLLBACK WORK with no named BAPI have no detail; the named BAPI_TRANSACTION_COMMIT/ROLLBACK calls do", () => {
    const commits = occurrences.filter((o) => o.kind === "commit");
    const rollbacks = occurrences.filter((o) => o.kind === "rollback");
    expect(commits).toHaveLength(2);
    expect(rollbacks).toHaveLength(2);
    expect(commits.find((o) => o.detail === undefined)).toBeDefined();
    expect(commits.find((o) => o.detail === "BAPI_TRANSACTION_COMMIT")).toBeDefined();
    expect(rollbacks.find((o) => o.detail === undefined)).toBeDefined();
    expect(rollbacks.find((o) => o.detail === "BAPI_TRANSACTION_ROLLBACK")).toBeDefined();
  });

  it("EXPORT ... TO DATABASE indx(zz) is kind=\"export to database\" targeting table INDX with a detail naming the area", () => {
    const exp = occurrences.find((o) => o.kind === "export to database");
    expect(exp?.table).toBe("INDX");
    expect(exp?.detail).toMatch(/indx\(zz\)/i);
  });

  it("CALL TRANSACTION 'SE16' and SUBMIT RSUSR002 are their own kinds, detailing the target", () => {
    const callTxn = occurrences.find((o) => o.kind === "call transaction");
    const submit = occurrences.find((o) => o.kind === "submit");
    expect(callTxn?.detail).toBe("SE16");
    expect(submit?.detail).toBe("RSUSR002");
  });

  it("neither commented-out write (line 39's full-line * comment, line 40's trailing \" comment) appears anywhere in the result", () => {
    const anyNearEnd = occurrences.filter((o) => o.line >= 38);
    expect(anyNearEnd).toHaveLength(0);
    // Belt and suspenders: no occurrence at all references ZDEMO_SOH_D, the
    // table named only inside the commented-out line 39.
    expect(occurrences.some((o) => o.table === "ZDEMO_SOH_D")).toBe(false);
  });
});

describe("scanFootprint: hand-written internal-table operations yield zero occurrences", () => {
  it("MODIFY itab INDEX / MODIFY itab TRANSPORTING / INSERT wa INTO itab / DELETE itab INDEX are not database writes", () => {
    const source = [
      "MODIFY gt_tab FROM gs_wa INDEX 1.",
      "MODIFY gt_tab FROM gs_wa TRANSPORTING field1.",
      "INSERT gs_wa INTO gt_tab INDEX 1.",
      "DELETE gt_tab INDEX 1.",
      "DELETE TABLE gt_tab FROM gs_wa.",
      "DELETE ADJACENT DUPLICATES FROM gt_tab.",
      "INSERT INITIAL LINE INTO gt_tab.",
    ].join("\n");
    const occurrences = scanFootprint(source, "main", OBJ_983);
    expect(occurrences).toHaveLength(0);
  });
});

describe("renderFootprint over the full 983 capture", () => {
  function fakeConn(): AbapConnection {
    return {
      cfg: { sid: "A4H" },
      get: async () => ({ body: SRC_983, headers: {} }),
    } as unknown as AbapConnection;
  }

  it("commitFound is \"yes\", writesOnlyViaUpdateTask is \"no\" (writes sit directly in START-OF-SELECTION, not only behind the update-task call)", async () => {
    const result = await buildFootprint(fakeConn(), {
      name: "Z_I107_FOOTPRINT",
      type: "PROG/P",
      uri: "/sap/bc/adt/programs/programs/z_i107_footprint",
      sourceUri: "/sap/bc/adt/programs/programs/z_i107_footprint/source/main",
    } as never);
    expect(result.commitFound).toBe(true);
    expect(result.writesOnlyViaUpdateTask).toBe(false);

    const rendered = renderFootprint(result);
    expect(rendered.header.commitFound).toBe("yes");
    expect(rendered.header.writesOnlyViaUpdateTask).toBe("no");
    expect(rendered.header.occurrences).toBe(14);

    // The unresolved/non-table row (the dynamic INSERT) is grouped last,
    // after every real table's occurrences.
    const unresolvedIdx = rendered.body.indexOf("(unresolved / non-table):");
    const lastTableSectionIdx = rendered.body.indexOf("ZDEMO_SOH:");
    expect(unresolvedIdx).toBeGreaterThan(-1);
    expect(unresolvedIdx).toBeGreaterThan(lastTableSectionIdx);

    // Static blind-spot notes are always present.
    expect(rendered.notes.join("\n")).toMatch(/static pattern matching/i);
    expect(rendered.notes.join("\n")).toMatch(/keyword-position heuristic|TABLE\/INDEX/i);
  });
});
