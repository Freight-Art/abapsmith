// FluidManifestSchema is only invoked from plugin-loader.ts, so builtin manifests are otherwise never validated.
import { describe, expect, it } from "vitest";
import { BUILTIN_FLUID_TOOLS } from "../src/adt/fluid/builtin/index.js";
import { FluidManifestSchema } from "../src/adt/fluid/manifest.js";
import { FLUID_ABAP_LINE_MAX, reviewFluidAbap } from "../src/adt/fluid/static-review.js";

const tools = BUILTIN_FLUID_TOOLS.map((tool) => [tool.manifest.id, tool] as const);

// FluidObjectSpecSchema (manifest.ts) isn't exported, and its `description: z.string().max(60)`
// check has no named constant of its own — 60 is a bare literal there. The real constraint is the
// ABAP server's own object short-text limit: writeAndActivateOnce (ensure.ts:247-252) forwards
// `obj.description` straight into createObject (write.ts:3211), and a too-long description comes
// back from the server as a bare ADT_ERROR at deploy time — see the AbapError trace this test
// guards against. (The max is technically recoverable at runtime by reaching into
// FluidManifestSchema's zod internals — `.def.shape.objects.def.element.def.shape.description
// .def.checks[].def.maximum` — but that walks undocumented `_zod` internals that zod does not
// promise to keep stable, so a bare literal kept in sync by hand is the safer bet.) Keep this in
// sync with manifest.ts if that schema's max ever changes.
const FLUID_OBJECT_DESCRIPTION_MAX = 60;

/**
 * Would ADT accept `description` as an object's short text? Returns a problem string if not,
 * `undefined` if it's fine. Factored out of the it.each below so the "has teeth" tests further
 * down can drive it directly with synthetic input, proving the check itself is capable of failing
 * and not just vacuously true against today's compliant builtins.
 */
function describeDescriptionProblem(description: string): string | undefined {
  if (description.length === 0) {
    return "description is empty";
  }
  if (description.length > FLUID_OBJECT_DESCRIPTION_MAX) {
    return `description is ${description.length} chars (max ${FLUID_OBJECT_DESCRIPTION_MAX}): ${description}`;
  }
  return undefined;
}

describe("BUILTIN_FLUID_TOOLS manifests", () => {
  // it.each over an empty array runs zero tests rather than failing, so every check below would
  // silently pass-by-not-existing if BUILTIN_FLUID_TOOLS were ever empty. Guard that explicitly.
  it("enumerates at least one builtin tool", () => {
    expect(tools.length).toBeGreaterThan(0);
  });

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

  it.each(tools)(
    "%s: every manifest object description is non-empty and at most 60 characters",
    (_id, tool) => {
      // Belt-and-suspenders alongside the enumeration guard above: an empty `objects` array here
      // would also make this loop assert nothing for that tool.
      expect(tool.manifest.objects.length, `${_id} has no objects`).toBeGreaterThan(0);
      for (const obj of tool.manifest.objects) {
        const problem = describeDescriptionProblem(obj.description);
        expect(problem, `"${obj.name}": ${problem}`).toBeUndefined();
      }
    },
  );

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

// Only `obj.description` (FluidObjectSpec.description, per manifest object) ever reaches ADT: it
// is forwarded verbatim by writeAndActivateOnce (ensure.ts:247-252) into the `spec` handed to
// authorizeMutation / createObject (write.ts:3211) as the object's short text. Manifest-level
// FluidManifest.description and per-action FluidActionSpec.description are never read on that
// path — a grep of src/adt/fluid for `.description` turns up exactly one call site outside
// manifest.ts's own schema and the builtin definition files that populate these manifests:
// ensure.ts:251's `description: obj.description`. So only the per-object field needs this guard.
describe("BUILTIN_FLUID_TOOLS manifests: object description guard has teeth", () => {
  it("accepts a 60-character description", () => {
    expect(describeDescriptionProblem("x".repeat(60))).toBeUndefined();
  });

  it("rejects a 61-character description", () => {
    expect(describeDescriptionProblem("x".repeat(61))).toBeDefined();
  });

  it("rejects an empty description", () => {
    expect(describeDescriptionProblem("")).toBeDefined();
  });
});
