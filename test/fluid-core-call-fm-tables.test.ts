/**
 * Offline checks for #237: `core.call_fm` binds TABLES parameters from a
 * JSON array of row objects and `core.describe_fm` lists them in
 * params_schema. Same idiom as fluid-core-call-fm-struct.test.ts:
 * assertions on the generated ABAP text and the TS-side args shaping.
 */
import { describe, expect, it } from "vitest";
import { coreManifest, coreSources, normalizeCallFmArgs } from "../src/adt/fluid/builtin/core.js";
import { reviewFluidAbap } from "../src/adt/fluid/static-review.js";

const joined = [...coreSources.values()].join("\n");

describe("core.call_fm TABLES parameters — generated ABAP", () => {
  it("accepts ptype T in params and no longer calls TABLES an unknown input parameter", () => {
    expect(joined).toContain("ls_par-ptype <> 'I' AND ls_par-ptype <> 'C' AND ls_par-ptype <> 'T'");
    expect(joined).toContain("IF ls_par-ptype = 'T'.\n        \" TABLES parameter");
  });

  it("creates the table from the row type and binds it as abap_func_tables before the scalar path", () => {
    const iT = joined.indexOf("CREATE DATA lr_data TYPE STANDARD TABLE OF (lv_type).");
    const iScalar = joined.indexOf("<lv_any> = lv_val.");
    expect(iT).toBeGreaterThan(-1);
    expect(iT).toBeLessThan(iScalar);
    expect(joined).toContain("ls_ptab-kind = abap_func_tables.");
  });

  it("requires a JSON array, with a clear message", () => {
    expect(joined).toContain("NOT lv_trim CP '[*'");
    expect(joined).toContain("is a TABLES parameter; send a JSON array of row objects");
  });

  it("fills rows through fill_table / fill_struct and prefixes errors with the row number", () => {
    expect(joined).toContain("fill_table( EXPORTING iv_json = lv_trim");
    expect(joined).toContain("APPEND INITIAL LINE TO ct_data ASSIGNING <ls_line>.");
    expect(joined).toContain("ev_error = |row { lv_idx }: { lv_err }|.");
    expect(joined).toContain("elementary line type");
  });

  it("splits the array by walking strings, escapes and brace depth", () => {
    expect(joined).toContain("METHOD split_rows.");
    expect(joined).toContain("CLASS-METHODS split_rows");
    expect(joined).toContain("CLASS-METHODS fill_table");
    expect(joined).toContain("is not a JSON object|.");
  });

  it("passes reviewFluidAbap with no findings", () => {
    for (const [name, source] of coreSources) {
      expect(reviewFluidAbap(name, source), name).toEqual([]);
    }
  });
});

describe("core.describe_fm — TABLES in params_schema", () => {
  it("lists T parameters as array-or-string with row components", () => {
    expect(joined).toContain("ls_par-ptype = 'I' OR ls_par-ptype = 'C' OR ls_par-ptype = 'T'");
    expect(joined).toContain('"type":["array","string"]');
    expect(joined).toContain("Send a JSON array of row objects keyed by component name.");
    expect(joined).toContain('"items":\\{"type":"object"');
    expect(joined).toContain(',"components":{ lv_comps }');
  });
});

describe("normalizeCallFmArgs — TABLES values", () => {
  it("compacts an array of row objects with numbers as strings", () => {
    const out = normalizeCallFmArgs({
      name: "RFC_READ_TABLE",
      params: { OPTIONS: [{ TEXT: "MANDT = '001'" }, { TEXT: "AND N = 5" }], N: 3 },
    }) as { params: Record<string, unknown> };
    expect(out.params["OPTIONS"]).toBe('[{"TEXT":"MANDT = \'001\'"},{"TEXT":"AND N = 5"}]');
    expect(out.params["N"]).toBe(3);
  });

  it("compacts a JSON array given as text with blanks", () => {
    const out = normalizeCallFmArgs({
      name: "X",
      params: { T: '  [ {"A": 1, "B": "x"} , {"A": 2} ]', E: "[]" },
    }) as { params: Record<string, string> };
    expect(out.params).toEqual({ T: '[{"A":"1","B":"x"},{"A":"2"}]', E: "[]" });
  });

  it("leaves malformed text alone", () => {
    const out = normalizeCallFmArgs({ name: "X", params: { T: "[{not json", U: "[1,2" } }) as {
      params: Record<string, string>;
    };
    expect(out.params).toEqual({ T: "[{not json", U: "[1,2" });
  });

  it("keeps struct parameters working", () => {
    const out = normalizeCallFmArgs({ name: "X", params: { S: { A: 1 }, F: "plain" } }) as {
      params: Record<string, string>;
    };
    expect(out.params).toEqual({ S: '{"A":"1"}', F: "plain" });
  });

  it("round-trips quotes and backslashes inside row values", () => {
    const row = { TEXT: 'say "hi" \\ bye' };
    const out = normalizeCallFmArgs({ name: "X", params: { T: [row] } }) as { params: Record<string, string> };
    expect(JSON.parse(out.params["T"]!)).toEqual([row]);
  });

  it("params description mentions TABLES rows", () => {
    const call = coreManifest.actions.find((a) => a.name === "call_fm")!;
    const props = (call.input as { properties: Record<string, { description?: string }> }).properties;
    expect(props["params"]?.description).toContain("TABLES parameter takes a JSON array of row objects");
  });
});
