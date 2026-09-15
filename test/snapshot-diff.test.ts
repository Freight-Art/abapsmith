/**
 * `diffSnapshotRows` (`src/snapshot-store.ts`) — the pure row-matching engine
 * behind `abap_data_preview`'s `mode: "diff"`. No filesystem, no network:
 * every case here is two in-memory `{ columns, rows }` shapes plus a
 * `matchOn` column list.
 */
import { describe, expect, it } from "vitest";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { diffSnapshotRows, type SnapshotColumn } from "../src/snapshot-store.js";

const COLS: readonly SnapshotColumn[] = [
  { name: "MANDT", key: true },
  { name: "NAME", key: false },
];

function side(rows: readonly (readonly string[])[], columns: readonly SnapshotColumn[] = COLS) {
  return { columns, rows };
}

describe("diffSnapshotRows", () => {
  it("reports no inserts, deletes or changes for an unchanged pair", () => {
    const rows = [
      ["100", "Alpha"],
      ["200", "Beta"],
    ];
    const diff = diffSnapshotRows(side(rows), side(rows), ["MANDT"]);
    expect(diff.inserted).toEqual([]);
    expect(diff.deleted).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.matchedOnFullKey).toBe(true);
    expect(diff.columnsAddedInAfter).toEqual([]);
    expect(diff.columnsRemovedInAfter).toEqual([]);
  });

  it("classifies a pure insert", () => {
    const before = [["100", "Alpha"]];
    const after = [
      ["100", "Alpha"],
      ["200", "Beta"],
    ];
    const diff = diffSnapshotRows(side(before), side(after), ["MANDT"]);
    expect(diff.inserted).toEqual([["200", "Beta"]]);
    expect(diff.deleted).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("classifies a pure delete", () => {
    const before = [
      ["100", "Alpha"],
      ["200", "Beta"],
    ];
    const after = [["100", "Alpha"]];
    const diff = diffSnapshotRows(side(before), side(after), ["MANDT"]);
    expect(diff.inserted).toEqual([]);
    expect(diff.deleted).toEqual([["200", "Beta"]]);
    expect(diff.changed).toEqual([]);
  });

  it("classifies a field-level change, carrying the old/new pair only for the field that moved", () => {
    const before = [["100", "Alpha"]];
    const after = [["100", "Alphaville"]];
    const diff = diffSnapshotRows(side(before), side(after), ["MANDT"]);
    expect(diff.inserted).toEqual([]);
    expect(diff.deleted).toEqual([]);
    expect(diff.changed).toEqual([
      { key: ["100"], changes: [{ column: "NAME", old: "Alpha", new: "Alphaville" }] },
    ]);
    // MANDT did not change, so it must not appear in the changes list at all.
    const changedColumns = diff.changed[0]!.changes.map((c) => c.column);
    expect(changedColumns).not.toContain("MANDT");
  });

  it("matches duplicate rows by multiplicity: removing one of three identical rows is one delete, not zero and not three", () => {
    const before = [
      ["100", "Same"],
      ["100", "Same"],
      ["100", "Same"],
    ];
    const after = [
      ["100", "Same"],
      ["100", "Same"],
    ];
    const diff = diffSnapshotRows(side(before), side(after), ["MANDT"]);
    expect(diff.deleted).toEqual([["100", "Same"]]);
    expect(diff.inserted).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("reports matchedOnFullKey truthfully when matchOn is the full DDIC key", () => {
    const rows = [["100", "Alpha"]];
    const diff = diffSnapshotRows(side(rows), side(rows), ["MANDT"]);
    expect(diff.matchedOnFullKey).toBe(true);
  });

  it("the no-full-key fallback: matching on every selected column surfaces an edited row as one delete plus one insert, never a change", () => {
    // No complete key: matchOn is every selected column, exactly the
    // fallback `diffSnapshot` (src/snapshot-run.ts) uses when
    // `!before.keyComplete`.
    const before = [["100", "Alpha"]];
    const after = [["100", "Alphaville"]];
    const matchOn = COLS.map((c) => c.name); // ["MANDT", "NAME"] — the full column set of both sides
    const diff = diffSnapshotRows(side(before), side(after), matchOn);

    expect(diff.matchedOnFullKey).toBe(false);
    expect(diff.deleted).toEqual([["100", "Alpha"]]);
    expect(diff.inserted).toEqual([["100", "Alphaville"]]);
    expect(diff.changed).toEqual([]);
  });

  it("reports columnsAddedInAfter / columnsRemovedInAfter when the two sides' column sets differ", () => {
    const beforeCols: readonly SnapshotColumn[] = [
      { name: "MANDT", key: true },
      { name: "OLD_COL", key: false },
    ];
    const afterCols: readonly SnapshotColumn[] = [
      { name: "MANDT", key: true },
      { name: "NEW_COL", key: false },
    ];
    const diff = diffSnapshotRows(
      side([["100", "x"]], beforeCols),
      side([["100", "y"]], afterCols),
      ["MANDT"],
    );
    expect(diff.columnsAddedInAfter).toEqual(["NEW_COL"]);
    expect(diff.columnsRemovedInAfter).toEqual(["OLD_COL"]);
    // The matched row shows a change for each side-only column, since there
    // is no counterpart value to compare against.
    expect(diff.changed).toEqual([
      {
        key: ["100"],
        changes: [
          { column: "OLD_COL", old: "x", new: "" },
          { column: "NEW_COL", old: "", new: "y" },
        ],
      },
    ]);
  });

  it("refuses to match on a column absent from either side", () => {
    let thrown: unknown;
    try {
      diffSnapshotRows(side([["100", "Alpha"]]), side([["100", "Alpha"]]), ["NOT_A_COLUMN"]);
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown)).toBe(true);
    expect((thrown as AbapError).code).toBe("BAD_INPUT");
  });
});
