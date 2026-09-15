/**
 * A drift test for the SHLP/DH classic-bridge wire format — issue #83's
 * live `CHECK_FAILED: a search help needs at least one import and one
 * export parameter` was caused by exactly this: `shlp-create.ts`'s
 * `buildArgs()` emitted `fields`/`includes`/`assignments` as genuine nested
 * JSON arrays of objects, while `scan()` (`src/adt/fluid/builtin/classic/
 * abap-core.ts`) is a flat, single-pass reader that never recurses into an
 * object — it understands only a scalar string, a bare scalar (number/
 * boolean), or an array of STRINGS. The two sides silently disagreed on the
 * wire format and every per-field property read back empty.
 *
 * The fix is a strict separation of concerns: `buildArgs` emits the honest,
 * NESTED shape the `classic` manifest declares (and validates against);
 * the dispatcher (`src/adt/fluid/dispatch.ts`) then flattens it into the
 * scalar `path -> value` shape `abap-shlp.ts` actually reads, via
 * `flattenScanArgs` (`src/adt/fluid/flat-args.ts`), because the `classic`
 * manifest sets `flatArgs: true`. A PRIOR attempt pre-flattened inside
 * `buildArgs` itself — that broke schema validation instead (see step 2
 * below for the exact error it produced). This file drives the REAL
 * pipeline end to end — validate() -> buildArgs() -> schema validation ->
 * flattenScanArgs() -> canonicalArgsJson() — reading the REAL
 * `abap-shlp.ts` source text and the REAL emitted JSON rather than
 * hand-listing expected keys, so a future change to any link in that chain
 * that breaks the correspondence fails a test instead of shipping a live
 * `CHECK_FAILED`.
 */
import { describe, expect, it } from "vitest";
import { shlpPart } from "../src/adt/fluid/builtin/classic/abap-shlp.js";
import { canonicalArgsJson } from "../src/adt/fluid/invoke.js";
import { flattenScanArgs } from "../src/adt/fluid/flat-args.js";
import { classicManifest } from "../src/adt/fluid/builtin/classic.js";
import { validateAgainstSchema } from "../src/adt/fluid/manifest.js";
import { validate, buildArgs, type SearchHelpParams, type SearchHelpField } from "../src/adt/shlp-create.js";
import { serverPackage, type ServerPackage } from "../src/adt/resolved-package.js";
import type { VerifyOutcome } from "../src/adt/write-verify.js";

// ---------------------------------------------------------------------------
// Step 1: extract every argument path abap-shlp.ts reads, straight from its
// own source text.
// ---------------------------------------------------------------------------

/**
 * Scans `source` for every `s( 'x' )` / `b( 'x' )` / `n( 'x' )` (a literal
 * quoted path) and every `s( |x/{ ... }/y| )` / `b( |x/{ ... }/y| )` (an
 * interpolated path whose loop-index expression, e.g. `{ lv_i - 1 }`, is
 * normalised to the concrete index `0`) — the exact two shapes
 * `abap-shlp.ts` uses to read `gt_arg`. Returns the set of concrete paths a
 * one-element definition would need.
 */
function extractAbapArgPaths(source: string): Set<string> {
  const paths = new Set<string>();
  for (const m of source.matchAll(/\b[snb]\( '([^']+)' \)/g)) {
    paths.add(m[1]!);
  }
  for (const m of source.matchAll(/\b[snb]\( \|([^|]+)\| \)/g)) {
    paths.add(m[1]!.replace(/\{[^}]*\}/g, "0"));
  }
  return paths;
}

const ABAP_PATHS = extractAbapArgPaths(shlpPart.source);

// `confirm_in_use` is read only by delete_search_help (b( 'confirm_in_use' )
// in abap-shlp.ts) — it has no place in create_search_help/update_search_help
// or in buildArgs's output, which this file drives exclusively through the
// create/update path. Excluded by name, not by a broad filter, per this
// test's own brief.
const NOT_ON_CREATE_UPDATE_PATH = new Set(["confirm_in_use"]);

describe("extractAbapArgPaths sanity", () => {
  it("found a non-trivial set of paths, including at least one of each shape", () => {
    expect(ABAP_PATHS.size).toBeGreaterThan(15);
    expect(ABAP_PATHS.has("shlp_name")).toBe(true); // literal scalar
    expect(ABAP_PATHS.has("fields")).toBe(true); // literal, read via n()
    expect(ABAP_PATHS.has("fields/0/name")).toBe(true); // interpolated, index normalised
    expect(ABAP_PATHS.has("confirm_in_use")).toBe(true); // present in the raw extraction...
  });
});

// ---------------------------------------------------------------------------
// Step 2: drive the REAL create entry point far enough to obtain the REAL
// (nested) `args` object, prove it validates against the manifest's
// declared schema, THEN flatten it and serialise with the REAL
// canonicalArgsJson.
// ---------------------------------------------------------------------------

const createAction = classicManifest.actions.find((a) => a.name === "create_search_help");
const updateAction = classicManifest.actions.find((a) => a.name === "update_search_help");
if (createAction === undefined) throw new Error("test fixture: classicManifest has no create_search_help action");
if (updateAction === undefined) throw new Error("test fixture: classicManifest has no update_search_help action");

/** Mints a genuine `VerifyOutcome` — same fixture as `test/shlp-create.test.ts`'s `confirmed`. */
const confirmed = (packageName: string | undefined): VerifyOutcome => ({
  status: "confirmed",
  uri: "/sap/bc/adt/vit/wb/object_type/shlp/object_name/ZTM_SH",
  via: "vit-bridge",
  packageName,
});

const pkg = (name: string): ServerPackage => {
  const p = serverPackage(confirmed(name));
  if (!p) throw new Error(`test fixture: serverPackage(confirmed(${JSON.stringify(name)})) unexpectedly undefined`);
  return p;
};

// Field 0 deliberately carries BOTH "marked import and export" AND a
// default value: the drift-test's own normalisation (step 1) always maps a
// loop-indexed path to index 0, so `fields/0/default_value` — not
// `fields/1/default_value` — is the concrete path that must exist for the
// "every extracted path is present" assertion below to mean anything.
// Field 1 is the export-only field with its own default value, covering
// the same combination the other way round.
const FIELDS: readonly SearchHelpField[] = [
  { name: "CARRID", dataElement: "ZTM_CARRID", import: true, export: true, defaultValue: "LH" },
  { name: "CARRNAME", dataElement: "ZTM_CARRNAME", export: true, defaultValue: "Lufthansa" },
];

const PARAMS: SearchHelpParams = {
  shlpName: "ZTM_SH_CARRIER",
  description: "Carrier search help",
  packageName: pkg("$TMP"),
  selectionMethod: "ZTM_CARRIERS",
  selectionMethodType: "T",
  dialogType: "D",
  textTable: "ZTM_CARRIERS_T",
  hotKey: "C",
  elementary: true,
  fields: FIELDS,
  includes: [{ name: "ZTM_SH_OTHER" }],
  assignments: [{ field: "CARRID", includedHelp: "ZTM_SH_OTHER", includedField: "CARRID", direction: "I" }],
};

// The real validate() -> buildArgs() sequence createSearchHelp/
// updateSearchHelp run before dispatch — see the export comment on
// `validate` in shlp-create.ts for why this is exposed for this test
// instead of standing up a fake ABAP connection all the way through
// dispatch().
const NESTED_ARGS = buildArgs(validate(PARAMS.packageName.name, PARAMS));

describe("buildArgs's output validates against the manifest's declared (nested) schema", () => {
  // THIS is the assertion that would have caught the live CHECK_FAILED: the
  // reverted, pre-flattening attempt at buildArgs emitted `fields` as a bare
  // element count (a number) instead of an array, and the dispatcher
  // validates `args` against this exact schema BEFORE any flattening runs
  // (`validateAgainstSchema` in `src/adt/fluid/dispatch.ts`) — that shape
  // failed with "args.fields: must be an array". A round trip that only
  // exercised the flattened wire shape, as this file's earlier revision
  // did, could never have caught that: it would have kept "succeeding" on a
  // value the real dispatcher would refuse before it ever reached
  // `flattenScanArgs`.
  it("create_search_help: [] (no validation errors)", () => {
    expect(validateAgainstSchema(NESTED_ARGS, createAction.input, "args")).toEqual([]);
  });
});

// The flat wire shape actually sent over the wire — what the dispatcher
// computes as `wireArgs` and hands to `invokerName`/`canonicalArgsJson`.
const ARGS = flattenScanArgs(NESTED_ARGS) as Record<string, unknown>;
const CANONICAL_JSON = canonicalArgsJson(ARGS);
const PARSED = JSON.parse(CANONICAL_JSON) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Step 3: every ABAP-read path (bar the delete-only one) must be a key of
// the real emitted JSON.
// ---------------------------------------------------------------------------

describe("every path abap-shlp.ts reads (create/update) is present in the flattened, emitted JSON", () => {
  const checked = [...ABAP_PATHS].filter((p) => !NOT_ON_CREATE_UPDATE_PATH.has(p));

  it("covers at least one of every conditional path this sample was built to exercise", () => {
    // Sanity on the sample itself, not on the drift assertion below: if one
    // of these went missing from ABAP_PATHS (e.g. a rename in abap-shlp.ts
    // changed 'default_value' to something else), the drift assertion below
    // would trivially pass by omission. Pinning these down here means a
    // rename shows up as a failure here, not as silence.
    for (const p of ["fields/0/default_value", "dialog_type", "text_table", "hot_key"]) {
      expect(ABAP_PATHS.has(p)).toBe(true);
    }
  });

  it.each(checked)("the flattened output has key %s", (path) => {
    expect(Object.prototype.hasOwnProperty.call(PARSED, path)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step 4: model scan()'s OWN path rules over the emitted JSON (top-level
// keys only; string -> one row; array-of-strings -> key/{i} rows; bare
// scalar -> one row) and prove the round trip — this is the test that would
// have caught the live CHECK_FAILED on the wire-format side.
// ---------------------------------------------------------------------------

/**
 * A JS model of `scan()`'s row-production rules — top-level keys only, no
 * recursion into nested arrays/objects (scan() cannot do that either): a
 * string value produces one `path -> value` row; an array of strings
 * produces one `path/i -> value` row per element; any other (bare) scalar
 * produces one `path -> String(value)` row, mirroring `s()`'s raw-substring
 * capture of a JSON number/boolean literal.
 */
function scanRows(parsed: Record<string, unknown>): Map<string, string> {
  const rows = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      rows.set(key, value);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (typeof v === "string") rows.set(`${key}/${i}`, v);
      });
    } else {
      rows.set(key, String(value));
    }
  }
  return rows;
}

describe("scan()-shaped round trip over the real emitted JSON", () => {
  const rows = scanRows(PARSED);

  it("produces the exact rows the live CHECK_FAILED bug depended on being wrong", () => {
    expect(rows.get("fields")).toBe("2");
    expect(rows.get("fields/0/name")).toBeTruthy();
    expect(rows.get("fields/0/data_element")).toBeTruthy();
    expect(rows.get("fields/0/import")).toBe("true");
    expect(rows.get("fields/0/export")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Step 5: the wire contract, stated directly — no nested array or object
// value anywhere in the emitted JSON.
// ---------------------------------------------------------------------------

describe("wire contract: the flattened output is flat", () => {
  it("every top-level value is a string, number or boolean — never an array or object", () => {
    for (const [key, value] of Object.entries(PARSED)) {
      const isScalar = typeof value === "string" || typeof value === "number" || typeof value === "boolean";
      expect(isScalar, `key ${JSON.stringify(key)} has a non-scalar value: ${JSON.stringify(value)}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Step 6: model n()'s two-branch counting rule and prove it picks the right
// branch for both wire shapes that flow through the real dispatcher.
//
// n( iv_path ) in abap-core.ts must return the ELEMENT COUNT of a caller's
// array, not the number of gt_arg rows that array produced. Those coincide
// for a plain string array (one row per element) but NOT for a flattened
// array of objects (several rows per element) — for that second shape,
// `flattenScanArgs` states the element count as a plain number at the bare
// path, and n() must read that instead of counting rows, or abap-shlp.ts's
// `DO lv_field_count TIMES` loop walks off the end of the real fields and
// dies on its own "not a field of selection method" check before
// RS_CORR_INSERT ever runs.
// ---------------------------------------------------------------------------

/**
 * A JS model of `n()`'s two-branch rule, built on top of `scanRows`'s
 * row model: prefer an exact digits-only value sitting at the bare `path`
 * (the flattened-array-of-objects shape's self-stated element count),
 * falling back to counting `path/*` rows (the plain-string-array shape,
 * which never has a row at the bare path) otherwise. Mirrors the ABAP
 * exactly: `IF lv_exact IS NOT INITIAL AND lv_exact CO '0123456789'` before
 * ever assigning it into an integer, so a non-numeric bare-path value falls
 * through to the row count rather than blowing up.
 */
function nModel(rows: Map<string, string>, path: string): number {
  const exact = rows.get(path);
  if (exact !== undefined && exact !== "" && /^[0-9]+$/.test(exact)) {
    return Number(exact);
  }
  const prefix = `${path}/`;
  let count = 0;
  for (const key of rows.keys()) {
    if (key.startsWith(prefix)) count++;
  }
  return count;
}

describe("n() picks the exact-count branch for a flattened array of objects", () => {
  const rows = scanRows(PARSED);

  it("counts elements (2 fields, 1 assignment), not gt_arg rows", () => {
    // With the old wildcard-only rule this sample's row counts would have
    // been 10 (5 properties * 2 fields) and 4 (4 properties * 1
    // assignment) respectively — both wrong, and both larger than the
    // element counts asserted below, which is exactly the bug issue #83
    // reported (abap-shlp.ts's DO lv_field_count TIMES loop reading past
    // the real fields).
    expect(nModel(rows, "fields")).toBe(2);
    expect(nModel(rows, "assignments")).toBe(1);
  });
});

describe("n() falls back to the wildcard count for a plain string array", () => {
  it("counts path/{i} rows when there is no bare-path row (abap-view.ts / abap-index.ts's fields: string[])", () => {
    // Shaped like view-create.ts's / index-create.ts's validated args:
    // `fields` is a genuine string[]. flattenScanArgs leaves this shape
    // untouched (see the dedicated describe block below), so
    // canonicalArgsJson emits it as a real JSON array — scan() (and this
    // model of it) produces path/0, path/1, ... rows and NO row at the
    // bare "fields" key.
    const viewLikeArgs = { fields: ["MANDT", "CARRID", "CONNID"] };
    const parsed = JSON.parse(canonicalArgsJson(flattenScanArgs(viewLikeArgs))) as Record<string, unknown>;
    const rows = scanRows(parsed);
    expect(rows.has("fields")).toBe(false);
    expect(nModel(rows, "fields")).toBe(viewLikeArgs.fields.length);
  });
});

describe("n()'s exact-count branch guards against a non-digits bare-path value", () => {
  it("falls back to the wildcard count instead of throwing when the bare-path value isn't digits-only", () => {
    // A value that could never legitimately arrive this way (n()'s callers
    // always pair a numeric bare path with their own array), but the guard
    // must hold regardless: a non-numeric string at the bare path must not
    // reach an integer assignment (ABAP: CX_SY_CONVERSION_NO_NUMBER) and
    // must not be trusted as a count either.
    const badArgs = {
      assignments: "not-a-number",
      "assignments/0/field": "CARRID",
      "assignments/0/included_help": "ZTM_SH_OTHER",
    };
    const parsed = JSON.parse(canonicalArgsJson(badArgs)) as Record<string, unknown>;
    const rows = scanRows(parsed);
    expect(rows.get("assignments")).toBe("not-a-number");
    expect(() => nModel(rows, "assignments")).not.toThrow();
    expect(nModel(rows, "assignments")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Step 7: the same round trip for UPDATE, against its own declared schema —
// update_search_help shares create_search_help's fields/includes/
// assignments shape, but is its own manifest action with its own schema
// object, so this is not implied by the create-side assertions above.
// ---------------------------------------------------------------------------

describe("update_search_help: the same validate -> buildArgs -> schema -> flatten round trip", () => {
  const updateParams: SearchHelpParams = { ...PARAMS, description: "Carrier search help, replaced" };
  const nestedUpdateArgs = buildArgs(validate(updateParams.packageName.name, updateParams));

  it("buildArgs's nested output validates against update_search_help's declared schema", () => {
    expect(validateAgainstSchema(nestedUpdateArgs, updateAction.input, "args")).toEqual([]);
  });

  it("flattens to the same wire shape every path abap-shlp.ts reads for update", () => {
    const flat = flattenScanArgs(nestedUpdateArgs) as Record<string, unknown>;
    const parsed = JSON.parse(canonicalArgsJson(flat)) as Record<string, unknown>;
    for (const p of [...ABAP_PATHS].filter((path) => !NOT_ON_CREATE_UPDATE_PATH.has(path))) {
      expect(Object.prototype.hasOwnProperty.call(parsed, p)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Step 8: flattenScanArgs must leave abap-view.ts's / abap-index.ts's
// string-array `fields` shape byte-identical — those classic actions never
// pre-flattened anything, and their invoker names are content-addressed off
// the exact wire args, so any change here would move them.
// ---------------------------------------------------------------------------

describe("flattenScanArgs leaves the classic view/index string-array shape untouched", () => {
  it("deep-equals its input for a view-like {view_name, fields: string[]} args object", () => {
    const viewArgs = { view_name: "Z", fields: ["A", "B"] };
    expect(flattenScanArgs(viewArgs)).toEqual(viewArgs);
  });
});
