/**
 * Offline validation for the built-in "img" fluid tool
 * (src/adt/fluid/builtin/img.ts). This suite imports the manifest and
 * sources straight from the module, not the barrel, so a typo in the
 * manifest or a source/manifest mismatch is caught regardless of whether
 * anything else has registered the tool. No FakeAdtServer, no network, no
 * filesystem.
 */
import { describe, expect, it } from "vitest";
import { imgManifest, imgSources } from "../src/adt/fluid/builtin/img.js";
import { FLUID_CONTRACT, FluidManifestSchema, validateFluidSchema } from "../src/adt/fluid/manifest.js";
import { reviewFluidAbap } from "../src/adt/fluid/static-review.js";

describe("imgManifest — schema", () => {
  it("parses cleanly through FluidManifestSchema", () => {
    const result = FluidManifestSchema.safeParse(imgManifest);
    expect(result.success, JSON.stringify(result.success ? undefined : result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it("declares the current FLUID_CONTRACT", () => {
    expect(imgManifest.contract).toBe(FLUID_CONTRACT);
  });
});

describe("imgManifest / imgSources — object <-> source correspondence", () => {
  const objectNames = imgManifest.objects.map((o) => o.name);

  it("has an imgSources entry for every declared object", () => {
    for (const name of objectNames) {
      expect(imgSources.has(name), `imgSources is missing "${name}"`).toBe(true);
    }
  });

  it("has no imgSources entry the manifest does not declare", () => {
    const declared = new Set(objectNames);
    for (const key of imgSources.keys()) {
      expect(declared.has(key), `imgSources has orphan entry "${key}"`).toBe(true);
    }
  });

  it("has the same object count both ways", () => {
    expect(imgSources.size).toBe(objectNames.length);
  });

  it("declares the entry class among its objects", () => {
    expect(objectNames).toContain(imgManifest.entry);
  });
});

describe("imgManifest — actions", () => {
  it("has at least one action", () => {
    expect(imgManifest.actions.length).toBeGreaterThan(0);
  });

  it.each(imgManifest.actions.map((a) => [a.name, a] as const))(
    "action %s: input schema has no validateFluidSchema issues",
    (name, action) => {
      const issues = validateFluidSchema(action.input, `actions.${name}.input`);
      expect(issues, issues.join("\n")).toEqual([]);
    },
  );

  it.each(imgManifest.actions.map((a) => [a.name, a] as const))(
    "action %s: output schema has no validateFluidSchema issues",
    (name, action) => {
      const issues = validateFluidSchema(action.output, `actions.${name}.output`);
      expect(issues, issues.join("\n")).toEqual([]);
    },
  );
});

describe("imgSources — ABAP source content", () => {
  it.each(imgManifest.objects.map((o) => [o.name, o] as const))(
    "%s: source declares that class name and is non-trivial",
    (name) => {
      const source = imgSources.get(name);
      expect(source).toBeDefined();
      if (source === undefined) return;

      expect(source.length).toBeGreaterThan(200);

      const lower = name.toLowerCase();
      expect(new RegExp(`CLASS\\s+${lower}\\s+DEFINITION`, "i").test(source)).toBe(true);
      expect(new RegExp(`CLASS\\s+${lower}\\s+IMPLEMENTATION`, "i").test(source)).toBe(true);
    },
  );

  it.each(imgManifest.objects.map((o) => [o.name, o] as const))(
    "%s: passes the static ABAP reviewer with no findings",
    (name) => {
      const source = imgSources.get(name);
      expect(source).toBeDefined();
      if (source === undefined) return;

      const findings = reviewFluidAbap(name, source);
      expect(findings).toEqual([]);
    },
  );
});
