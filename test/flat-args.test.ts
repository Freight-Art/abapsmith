/**
 * Unit tests for `flattenScanArgs` (`src/adt/fluid/flat-args.ts`) — the
 * dispatcher-side transform that turns nested `args` into the flat
 * `path -> scalar` rows the classic bridge's `scan()`
 * (`src/adt/fluid/builtin/classic/abap-core.ts`) reads. See
 * `test/classic-bridge-wire-format.test.ts` for the end-to-end pipeline
 * this feeds into.
 */
import { describe, expect, it } from "vitest";
import { flattenScanArgs } from "../src/adt/fluid/flat-args.js";

describe("flattenScanArgs", () => {
  it("returns non-plain-object input unchanged", () => {
    expect(flattenScanArgs("x")).toBe("x");
    expect(flattenScanArgs(42)).toBe(42);
    expect(flattenScanArgs(null)).toBe(null);
    expect(flattenScanArgs(["a", "b"])).toEqual(["a", "b"]);
  });

  it("copies scalar properties through unchanged", () => {
    expect(flattenScanArgs({ a: "x", b: 1, c: true, d: null })).toEqual({ a: "x", b: 1, c: true, d: null });
  });

  it("copies a string array through unchanged, including the empty array", () => {
    expect(flattenScanArgs({ fields: ["A", "B", "C"] })).toEqual({ fields: ["A", "B", "C"] });
    expect(flattenScanArgs({ fields: [] })).toEqual({ fields: [] });
  });

  it("flattens an array of objects into a bare count plus key/i/prop rows", () => {
    const input = { fields: [{ name: "A", import: true }, { name: "B", import: false }] };
    expect(flattenScanArgs(input)).toEqual({
      fields: 2,
      "fields/0/name": "A",
      "fields/0/import": true,
      "fields/1/name": "B",
      "fields/1/import": false,
    });
  });

  it("flattens a plain object into key/prop rows, with no bare count row", () => {
    const input = { params: { A: "1", B: "2" } };
    const out = flattenScanArgs(input) as Record<string, unknown>;
    expect(out).toEqual({ "params/A": "1", "params/B": "2" });
    expect(Object.prototype.hasOwnProperty.call(out, "params")).toBe(false);
  });

  it("recurses into an array nested inside an array element, with the right path", () => {
    const input = { rows: [{ tags: ["x", "y"] }, { tags: [{ n: "z" }] }] };
    expect(flattenScanArgs(input)).toEqual({
      rows: 2,
      "rows/0/tags": ["x", "y"],
      "rows/1/tags": 1,
      "rows/1/tags/0/n": "z",
    });
  });

  it("omits undefined values, matching canonicalArgsJson's treatment of undefined", () => {
    const input = { a: "x", b: undefined };
    const out = flattenScanArgs(input) as Record<string, unknown>;
    expect(out).toEqual({ a: "x" });
    expect(Object.prototype.hasOwnProperty.call(out, "b")).toBe(false);
  });
});
