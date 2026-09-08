/**
 * Offline validation for the built-in "run" fluid tool
 * (src/adt/fluid/builtin/run.ts). The module is not yet wired into the
 * builtin registry, so nothing else exercises it — this suite is what would
 * catch a typo in the manifest or a source/manifest mismatch before either
 * ships. No FakeAdtServer, no network, no filesystem.
 */
import { describe, expect, it } from "vitest";
import { runManifest, runSources } from "../src/adt/fluid/builtin/run.js";
import { FLUID_CONTRACT, FluidManifestSchema, validateFluidSchema } from "../src/adt/fluid/manifest.js";

describe("runManifest — schema", () => {
  it("parses cleanly through FluidManifestSchema", () => {
    const result = FluidManifestSchema.safeParse(runManifest);
    expect(result.success, JSON.stringify(result.success ? undefined : result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it("declares the current FLUID_CONTRACT", () => {
    expect(runManifest.contract).toBe(FLUID_CONTRACT);
  });
});

describe("runManifest / runSources — object <-> source correspondence", () => {
  const objectNames = runManifest.objects.map((o) => o.name);

  it("has a runSources entry for every declared object", () => {
    for (const name of objectNames) {
      expect(runSources.has(name), `runSources is missing "${name}"`).toBe(true);
    }
  });

  it("has no runSources entry the manifest does not declare", () => {
    const declared = new Set(objectNames);
    for (const key of runSources.keys()) {
      expect(declared.has(key), `runSources has orphan entry "${key}"`).toBe(true);
    }
  });

  it("has the same object count both ways", () => {
    expect(runSources.size).toBe(objectNames.length);
  });
});

describe("runManifest — actions", () => {
  it("has at least one action", () => {
    expect(runManifest.actions.length).toBeGreaterThan(0);
  });

  it.each(runManifest.actions.map((a) => [a.name, a] as const))(
    "action %s: input schema has no validateFluidSchema issues",
    (name, action) => {
      const issues = validateFluidSchema(action.input, `actions.${name}.input`);
      expect(issues, issues.join("\n")).toEqual([]);
    },
  );

  it.each(runManifest.actions.map((a) => [a.name, a] as const))(
    "action %s: output schema has no validateFluidSchema issues",
    (name, action) => {
      const issues = validateFluidSchema(action.output, `actions.${name}.output`);
      expect(issues, issues.join("\n")).toEqual([]);
    },
  );
});

describe("runSources — ABAP source content", () => {
  it.each(runManifest.objects.map((o) => [o.name, o] as const))(
    "%s: source declares that class name and is non-trivial",
    (name) => {
      const source = runSources.get(name);
      expect(source).toBeDefined();
      if (source === undefined) return;

      expect(source.length).toBeGreaterThan(200);

      const lower = name.toLowerCase();
      expect(new RegExp(`CLASS\\s+${lower}\\s+DEFINITION`, "i").test(source)).toBe(true);
      expect(new RegExp(`CLASS\\s+${lower}\\s+IMPLEMENTATION`, "i").test(source)).toBe(true);
    },
  );
});
