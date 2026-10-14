/**
 * Offline checks for #238: `core.call_fm` fills a structured parameter from
 * a JSON object keyed by component name, and `core.describe_fm` lists the
 * components. Same idiom as fluid-core-tool.test.ts: assertions on the
 * generated ABAP text and the TS-side args shaping. Behaviour of the ABAP
 * itself needs a live system.
 */
import { describe, expect, it } from "vitest";
import { coreManifest, coreSources, normalizeCallFmArgs } from "../src/adt/fluid/builtin/core.js";
import { reviewFluidAbap } from "../src/adt/fluid/static-review.js";

const joined = [...coreSources.values()].join("\n");

describe("core.call_fm structured parameters — generated ABAP", () => {
  it("fills a structure parameter through fill_struct instead of raw assignment only", () => {
    expect(joined).toContain("fill_struct( EXPORTING iv_json = lv_trim");
    expect(joined).toContain("lo_desc->kind = cl_abap_typedescr=>kind_struct AND lv_trim CP '{*'");
  });

  it("keeps the plain string assignment for non-JSON input", () => {
    expect(joined).toContain("<lv_any> = lv_val.");
  });

  it("converts per RTTI type kind: char, numc, date, time, packed, int, raw", () => {
    for (const kind of [
      "typekind_char",
      "typekind_num",
      "typekind_date",
      "typekind_time",
      "typekind_packed",
      "typekind_int",
      "typekind_hex",
    ]) {
      expect(joined).toContain(`cl_abap_typedescr=>${kind}`);
    }
  });

  it("reports unknown component names instead of ignoring them", () => {
    expect(joined).toContain("unknown component(s)");
    expect(joined).toContain("READ TABLE lo_struct->components TRANSPORTING NO FIELDS WITH KEY name = lv_top");
  });

  it("refuses deeper nesting, tables and references with a message", () => {
    expect(joined).toContain("nested deeper than core.call_fm supports");
    expect(joined).toContain("is a table or reference, which core.call_fm cannot fill from JSON");
  });

  it("rejects values that would be silently truncated or rounded", () => {
    expect(joined).toContain("has more than { lo_elem->decimals } decimals");
    expect(joined).toContain("the component holds { lv_len }");
  });

  it("swaps gt_arg back after the private scan", () => {
    expect(joined).toContain("lt_save = gt_arg.");
    expect(joined).toContain("gt_arg = lt_save.");
  });

  it("does not need the INT8 type-kind constant", () => {
    expect(joined).not.toContain("typekind_int8");
  });

  it("passes reviewFluidAbap with no findings", () => {
    for (const [name, source] of coreSources) {
      expect(reviewFluidAbap(name, source), name).toEqual([]);
    }
  });
});

describe("core.describe_fm — component list in params_schema", () => {
  it("emits components with name, type, length and decimals for structure parameters", () => {
    expect(joined).toContain("lv_comps = comp_json( ls_par-typename ).");
    expect(joined).toContain('"components":{ lv_comps }');
    expect(joined).toContain('"type":["object","string"]');
    expect(joined).toContain('"length":{ lv_len },');
    expect(joined).toContain('"decimals":{ ls_comp-decimals }');
  });

  it("keeps the old string schema for non-structure parameters", () => {
    expect(joined).toContain('{"type":"string","description":"{ lv_kind }, type');
  });
});

describe("normalizeCallFmArgs", () => {
  it("serialises object-valued params to JSON text and leaves strings alone", () => {
    const out = normalizeCallFmArgs({
      name: "BAPI_X",
      commit: false,
      params: { HDR: { DOC_TYPE: "TA", NET: 12.5 }, PLAIN: "abc" },
    });
    expect(out).toEqual({
      name: "BAPI_X",
      commit: false,
      params: { HDR: '{"DOC_TYPE":"TA","NET":"12.5"}', PLAIN: "abc" },
    });
  });

  it("compacts a JSON object given as text (the bridge scanner needs no blanks)", () => {
    const out = normalizeCallFmArgs({
      name: "X",
      params: { S: '{"A": "1", "B": 2}', FIXED: "0000000001", BROKEN: "{not json" },
    }) as { params: Record<string, string> };
    expect(out.params).toEqual({ S: '{"A":"1","B":"2"}', FIXED: "0000000001", BROKEN: "{not json" });
  });

  it("returns args unchanged when there is no params object", () => {
    const a = { name: "X" };
    expect(normalizeCallFmArgs(a)).toBe(a);
    expect(normalizeCallFmArgs(undefined)).toBeUndefined();
  });

  it("params schema description mentions the JSON object form", () => {
    const call = coreManifest.actions.find((a) => a.name === "call_fm")!;
    const props = (call.input as { properties: Record<string, { description?: string }> }).properties;
    expect(props["params"]?.description).toContain("JSON object keyed by component name");
  });
});
