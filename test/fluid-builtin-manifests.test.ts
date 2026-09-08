// FluidManifestSchema is only invoked from plugin-loader.ts, so builtin manifests are otherwise never validated.
import { describe, expect, it } from "vitest";
import { BUILTIN_FLUID_TOOLS } from "../src/adt/fluid/builtin/index.js";
import { FluidManifestSchema } from "../src/adt/fluid/manifest.js";
import { FLUID_ABAP_LINE_MAX, reviewFluidAbap } from "../src/adt/fluid/static-review.js";

const tools = BUILTIN_FLUID_TOOLS.map((tool) => [tool.manifest.id, tool] as const);

describe("BUILTIN_FLUID_TOOLS manifests", () => {
  it.each(tools)("%s: manifest passes FluidManifestSchema.safeParse", (_id, tool) => {
    const result = FluidManifestSchema.safeParse(tool.manifest);
    expect(result.success, JSON.stringify(result.success ? undefined : result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it.each(tools)("%s: every manifest object has a source", (_id, tool) => {
    for (const obj of tool.manifest.objects) {
      expect(tool.sources.has(obj.name), `missing source for "${obj.name}"`).toBe(true);
    }
  });

  it.each(tools)("%s: every manifest object description is at most 60 characters", (_id, tool) => {
    for (const obj of tool.manifest.objects) {
      expect(
        obj.description.length,
        `"${obj.name}" description is ${obj.description.length} chars: ${obj.description}`,
      ).toBeLessThanOrEqual(60);
    }
  });

  it.each(tools)("%s: every ABAP source line is at most FLUID_ABAP_LINE_MAX characters", (_id, tool) => {
    for (const obj of tool.manifest.objects) {
      const source = tool.sources.get(obj.name) ?? "";
      const lines = source.split(/\r\n|\r|\n/);
      lines.forEach((line, i) => {
        expect(
          line.length,
          `"${obj.name}" line ${i + 1} is ${line.length} chars: ${line}`,
        ).toBeLessThanOrEqual(FLUID_ABAP_LINE_MAX);
      });
    }
  });

  it.each(tools)("%s: every source passes reviewFluidAbap with no findings", (_id, tool) => {
    for (const obj of tool.manifest.objects) {
      const source = tool.sources.get(obj.name) ?? "";
      const findings = reviewFluidAbap(obj.name, source);
      expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
    }
  });

  it.each(tools)("%s: any source referencing zcl_zmcp_fluid_rt declares the runtime object", (id, tool) => {
    // rt is the runtime itself: its own source names its own class, not a dependency on a separate object.
    if (id === "rt") {
      return;
    }
    const referencesRuntime = [...tool.sources.values()].some((source) =>
      /zcl_zmcp_fluid_rt/i.test(source),
    );
    if (!referencesRuntime) {
      return;
    }
    expect(tool.manifest.objects.some((obj) => obj.name === "ZCL_ZMCP_FLUID_RT")).toBe(true);
    expect(tool.sources.has("ZCL_ZMCP_FLUID_RT")).toBe(true);
  });
});
