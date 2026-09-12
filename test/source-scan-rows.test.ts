/**
 * Pure unit tests for `mapScanRows` (src/adt/source-scan.ts) — the function
 * that turns the raw row array `dispatch()` hands back for the `scan.source`
 * fluid action into a typed `{ hits, summary }` pair. No AbapConnection, no
 * dispatch(), no fluid runtime: every case here is constructed by hand to
 * pin exactly which malformed shapes are rejected (and with which error
 * code) versus which are accepted.
 */
import { describe, expect, it } from "vitest";
import { mapScanRows } from "../src/adt/source-scan.js";
import { AbapError } from "../src/adt/errors.js";

function hitRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: "hit",
    obj_type: "PROG",
    obj_name: "ZFOO",
    include: "ZFOO",
    line: 12,
    text: "DATA: lv_foo TYPE string.",
    ...overrides,
  };
}

function summaryRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: "summary",
    objects_total: 1,
    objects_scanned: 1,
    includes_scanned: 1,
    includes_skipped: 0,
    hits: 1,
    truncated: "",
    ...overrides,
  };
}

function expectProtocolError(fn: () => unknown): AbapError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AbapError);
    const err = e as AbapError;
    expect(err.code).toBe("FLUID_PROTOCOL_ERROR");
    return err;
  }
  throw new Error("expected mapScanRows to throw, but it did not");
}

describe("mapScanRows: happy paths", () => {
  it("maps two hit rows plus a trailing summary row into typed hits and summary", () => {
    const rows = [
      hitRow({ obj_name: "ZFOO", line: 12, text: "DATA: lv_foo TYPE string." }),
      hitRow({ obj_type: "CLAS", obj_name: "ZCL_FOO", include: "ZCL_FOO===========CCIMP", line: 40, text: "lv_bar = 1." }),
      summaryRow({ objects_total: 2, objects_scanned: 2, includes_scanned: 3, includes_skipped: 1, hits: 2, truncated: "" }),
    ];

    const { hits, summary } = mapScanRows(rows);

    expect(hits).toEqual([
      { objType: "PROG", objName: "ZFOO", include: "ZFOO", line: 12, text: "DATA: lv_foo TYPE string." },
      {
        objType: "CLAS",
        objName: "ZCL_FOO",
        include: "ZCL_FOO===========CCIMP",
        line: 40,
        text: "lv_bar = 1.",
      },
    ]);
    expect(summary).toEqual({
      objectsTotal: 2,
      objectsScanned: 2,
      includesScanned: 3,
      includesSkipped: 1,
      hits: 2,
      truncated: "",
    });
  });

  it("maps a zero-hit scan (summary row only) into an empty hits array plus the summary", () => {
    const rows = [summaryRow({ objects_total: 5, objects_scanned: 5, includes_scanned: 5, includes_skipped: 0, hits: 0 })];

    const { hits, summary } = mapScanRows(rows);

    expect(hits).toEqual([]);
    expect(summary).toEqual({
      objectsTotal: 5,
      objectsScanned: 5,
      includesScanned: 5,
      includesSkipped: 0,
      hits: 0,
      truncated: "",
    });
  });

  it.each(["", "hits", "objects"] as const)('round-trips summary.truncated = %j', (truncated) => {
    const rows = [summaryRow({ truncated })];
    const { summary } = mapScanRows(rows);
    expect(summary.truncated).toBe(truncated);
  });
});

describe("mapScanRows: rejects malformed shapes with FLUID_PROTOCOL_ERROR", () => {
  it("throws when the top-level result is not an array", () => {
    expectProtocolError(() => mapScanRows({ not: "an array" }));
  });

  it("throws when a row is not an object (e.g. a bare string)", () => {
    expectProtocolError(() => mapScanRows(["not an object", summaryRow()]));
  });

  it('throws when a row has an unknown "kind"', () => {
    expectProtocolError(() => mapScanRows([{ kind: "bogus" }, summaryRow()]));
  });

  it("throws when a hit row is missing a required field", () => {
    const bad = hitRow();
    delete bad.text;
    expectProtocolError(() => mapScanRows([bad, summaryRow()]));
  });

  it("throws when a hit row has a wrong-typed field", () => {
    expectProtocolError(() => mapScanRows([hitRow({ line: "12" }), summaryRow()]));
  });

  it("throws when a hit row appears after the summary row", () => {
    // Note: given mapScanRows' own check order, any summary row that is not
    // the array's last element is rejected as "not last" at the moment the
    // summary row itself is processed — before a later hit row is ever
    // reached. So the only array shape that puts a hit row after a summary
    // row necessarily also is "summary not last"; both scenarios are pinned
    // against this one construction, and both assert on code only.
    expectProtocolError(() => mapScanRows([summaryRow(), hitRow()]));
  });

  it("throws when more than one summary row is returned", () => {
    expectProtocolError(() => mapScanRows([summaryRow(), summaryRow()]));
  });

  it("throws when the summary row is present but is not the last element", () => {
    expectProtocolError(() => mapScanRows([summaryRow(), hitRow()]));
  });

  it("throws when no summary row is returned at all", () => {
    expectProtocolError(() => mapScanRows([hitRow()]));
  });

  it("throws when a summary row is missing a required field", () => {
    const bad = summaryRow();
    delete bad.hits;
    expectProtocolError(() => mapScanRows([bad]));
  });

  it("throws when a summary row has a wrong-typed field", () => {
    expectProtocolError(() => mapScanRows([summaryRow({ truncated: "nope" })]));
  });

  it('includes "scan.source" in the error message so callers can tell this apart from other FLUID_PROTOCOL_ERROR sources', () => {
    const err = expectProtocolError(() => mapScanRows("not an array" as unknown));
    expect(err.message).toContain("scan.source");
  });
});
