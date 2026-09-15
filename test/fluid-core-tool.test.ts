/**
 * Offline validation for the built-in "core" fluid tool
 * (src/adt/fluid/builtin/core.ts): pure manifest/source assertions on
 * `coreManifest` / `coreSources`. No connection, no `guardCoreAction` — the
 * gate behaviour lives in fluid-core-select-gate.test.ts and
 * fluid-core-call-fm-gate.test.ts instead. Same idiom as
 * test/fluid-builtin-img.test.ts, the closest per-builtin manifest suite.
 */
import { describe, expect, it } from "vitest";
import { coreManifest, coreSources } from "../src/adt/fluid/builtin/core.js";
import { FLUID_CONTRACT, FluidManifestSchema } from "../src/adt/fluid/manifest.js";
import { FLUID_ABAP_LINE_MAX, reviewFluidAbap } from "../src/adt/fluid/static-review.js";

describe("coreManifest — schema", () => {
  it("parses cleanly through FluidManifestSchema", () => {
    const result = FluidManifestSchema.safeParse(coreManifest);
    expect(result.success, JSON.stringify(result.success ? undefined : result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it("declares the current FLUID_CONTRACT", () => {
    expect(coreManifest.contract).toBe(FLUID_CONTRACT);
  });
});

describe("coreManifest — action ids", () => {
  it("has exactly call_fm, describe_fm, eval, select, sorted", () => {
    const names = coreManifest.actions.map((a) => a.name).sort();
    // `eval` is unconditionally present here: manifestVersion hashes only the
    // contract and the objects, never the actions, so keeping `eval` permanently
    // in the manifest forces no redeploy when it is turned on/off. Its actual
    // gating lives in `guardCoreAction` and the catalogue, not in this manifest —
    // do not "fix" this by making the manifest conditional.
    expect(names).toEqual(["call_fm", "describe_fm", "eval", "select"]);
  });

  // `submit` was deliberately cut from this slice: `core` reads and calls
  // what already exists on the target system, it does not accept and
  // activate caller-supplied ABAP source the way a generated invoker or a
  // plugin body class does (see core.ts's module doc comment).
  it("does not declare a submit action", () => {
    expect(coreManifest.actions.map((a) => a.name)).not.toContain("submit");
  });
});

describe("coreManifest — action categories", () => {
  const byName = new Map(coreManifest.actions.map((a) => [a.name, a] as const));

  it("select is category read", () => {
    expect(byName.get("select")?.category).toBe("read");
  });

  it("describe_fm is category read", () => {
    expect(byName.get("describe_fm")?.category).toBe("read");
  });

  it("call_fm is category execute", () => {
    expect(byName.get("call_fm")?.category).toBe("execute");
  });
});

describe("coreManifest — select input schema", () => {
  const select = coreManifest.actions.find((a) => a.name === "select");
  if (select === undefined) throw new Error("coreManifest has no select action");
  const props = select.input.properties ?? {};

  it("requires table", () => {
    expect(select.input.required).toEqual(["table"]);
  });

  it("declares fields, where, max_rows as optional properties (not required)", () => {
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["fields", "where", "max_rows"]));
    for (const optional of ["fields", "where", "max_rows"]) {
      expect(select.input.required ?? []).not.toContain(optional);
    }
  });

  // No caps: max_rows has neither a default nor a ceiling. Omitted or 0
  // means no limit — abapsmith imposes no default and no ceiling (see the
  // property's own description and abap-select.ts's module doc comment).
  it("max_rows has no default key", () => {
    const maxRowsSchema = props["max_rows"] as Record<string, unknown> | undefined;
    expect(maxRowsSchema).toBeDefined();
    expect("default" in (maxRowsSchema as Record<string, unknown>)).toBe(false);
  });

  it("max_rows has no maximum key", () => {
    const maxRowsSchema = props["max_rows"] as Record<string, unknown> | undefined;
    expect(maxRowsSchema).toBeDefined();
    expect("maximum" in (maxRowsSchema as Record<string, unknown>)).toBe(false);
  });
});

describe("coreSources — no cap in the ABAP either", () => {
  // The joined source of every entry coreSources declares. This is the
  // "no caps of any kind" decision, pinned at the generated-ABAP level, not
  // just the manifest level: core.select's row limit is never defaulted or
  // clamped in ABAP, only ever passed straight through.
  const joined = [...coreSources.values()].join("\n");

  it("does not contain a numeric literal row cap (no `UP TO <digits> ROWS`)", () => {
    expect(joined).not.toMatch(/UP TO\s+\d+\s+ROWS/i);
  });

  it("contains the dynamic `UP TO @lv_max ROWS` construct — ABAP treats UP TO 0 ROWS as no restriction", () => {
    expect(joined).toContain("UP TO @lv_max ROWS");
  });

  it("never clamps lv_max to a positive default when it is 0 (no `lv_max = <positive digit>` assignment)", () => {
    expect(joined).not.toMatch(/lv_max\s*=\s*[1-9]/);
  });
});

describe("coreManifest — objects", () => {
  const names = coreManifest.objects.map((o) => o.name);

  // ZCL_ZMCP_FLUID_RT is the RT dependency: it must exist before
  // ZCL_ZMCP_FLUID_CORE is activated, so it's declared first in `objects`,
  // the same way classic.ts orders its own RT dependency.
  it("lists ZCL_ZMCP_FLUID_RT before ZCL_ZMCP_FLUID_CORE", () => {
    const rtIdx = names.indexOf("ZCL_ZMCP_FLUID_RT");
    const coreIdx = names.indexOf("ZCL_ZMCP_FLUID_CORE");
    expect(rtIdx).toBeGreaterThanOrEqual(0);
    expect(coreIdx).toBeGreaterThanOrEqual(0);
    expect(rtIdx).toBeLessThan(coreIdx);
  });

  it("has a coreSources entry for every declared object", () => {
    for (const name of names) {
      expect(coreSources.has(name), `coreSources is missing "${name}"`).toBe(true);
    }
  });

  it("has no coreSources entry the manifest does not declare", () => {
    const declared = new Set(names);
    for (const key of coreSources.keys()) {
      expect(declared.has(key), `coreSources has orphan entry "${key}"`).toBe(true);
    }
  });

  it.each(coreManifest.objects.map((o) => [o.name, o] as const))(
    "%s: description is at most 60 characters",
    (_name, obj) => {
      expect(obj.description.length, `"${obj.name}" description is ${obj.description.length} chars`).toBeLessThanOrEqual(
        60,
      );
    },
  );

  it.each(coreManifest.objects.map((o) => [o.name, o] as const))(
    "%s: every source line is at most FLUID_ABAP_LINE_MAX characters",
    (name) => {
      const source = coreSources.get(name) ?? "";
      const lines = source.split(/\r\n|\r|\n/);
      lines.forEach((line, i) => {
        expect(line.length, `"${name}" line ${i + 1} is ${line.length} chars: ${line}`).toBeLessThanOrEqual(
          FLUID_ABAP_LINE_MAX,
        );
      });
    },
  );

  it.each(coreManifest.objects.map((o) => [o.name, o] as const))(
    "%s: passes reviewFluidAbap with no findings",
    (name) => {
      const source = coreSources.get(name) ?? "";
      const findings = reviewFluidAbap(name, source);
      expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
    },
  );
});

describe("coreManifest — action targets", () => {
  const byName = new Map(coreManifest.actions.map((a) => [a.name, a] as const));

  it("call_fm declares no targets", () => {
    expect(byName.get("call_fm")?.targets).toBeUndefined();
  });

  it("select declares targets: { object: \"/table\" }", () => {
    expect(byName.get("select")?.targets).toEqual({ object: "/table" });
  });

  it("describe_fm declares targets: { object: \"/name\" }", () => {
    expect(byName.get("describe_fm")?.targets).toEqual({ object: "/name" });
  });
});
