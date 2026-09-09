/**
 * Pure schema/validation tests for src/adt/fluid/manifest.ts — no
 * FakeAdtServer, no network, no filesystem. Covers the manifest schema, the
 * hand-written JSON-Schema-subset walker, the runtime value validator, and
 * the manifestVersion hash (which must reuse canonicalEtag, not re-spell it,
 * so a CRLF/whitespace-only diff never triggers a redeploy).
 */
import { describe, expect, it } from "vitest";
import {
  FLUID_CONTRACT,
  FLUID_CONTRACT_MAJOR,
  FluidManifestSchema,
  type FluidManifest,
  manifestVersion,
  validateAgainstSchema,
  validateFluidSchema,
} from "../src/adt/fluid/manifest.js";

function minimalManifest(overrides: Partial<FluidManifest> = {}): FluidManifest {
  return {
    contract: FLUID_CONTRACT,
    id: "demo",
    title: "Demo tool",
    description: "A minimal demo fluid tool.",
    objects: [
      {
        name: "ZCL_DEMO",
        type: "CLAS/OC",
        description: "demo class",
        source: { text: "CLASS zcl_demo DEFINITION PUBLIC.\nENDCLASS." },
      },
    ],
    entry: "ZCL_DEMO",
    actions: [
      {
        name: "run",
        category: "execute",
        description: "runs the demo",
        input: { type: "object", properties: { x: { type: "string" } } },
        output: { type: "object" },
      },
    ],
    ...overrides,
  };
}

describe("FLUID_CONTRACT", () => {
  it("is 1.0, matching FLUID_CONTRACT_MAJOR's major", () => {
    expect(FLUID_CONTRACT).toBe("1.0");
    expect(FLUID_CONTRACT_MAJOR).toBe(1);
  });
});

describe("FluidManifestSchema — acceptance", () => {
  it("parses a minimal valid manifest and round-trips its fields", () => {
    const input = minimalManifest();
    const result = FluidManifestSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.id).toBe("demo");
    expect(result.data.entry).toBe("ZCL_DEMO");
    expect(result.data.objects).toHaveLength(1);
    expect(result.data.objects[0]?.name).toBe("ZCL_DEMO");
    expect(result.data.actions[0]?.name).toBe("run");
    expect(result.data.actions[0]?.category).toBe("execute");
  });
});

describe("FluidManifestSchema — internal field (additive, optional)", () => {
  it("parses a manifest with internal: true and round-trips it", () => {
    const result = FluidManifestSchema.safeParse(minimalManifest({ internal: true }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.internal).toBe(true);
  });

  it("leaves internal absent (not defaulted to false) when the manifest never declares it", () => {
    const result = FluidManifestSchema.safeParse(minimalManifest());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.internal).toBeUndefined();
  });
});

describe("FluidManifestSchema — rejections", () => {
  it("rejects a malformed contract string", () => {
    const result = FluidManifestSchema.safeParse(minimalManifest({ contract: "v1" }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((iss) => iss.path.join(".") === "contract")).toBe(true);
  });

  it("rejects an uppercase id", () => {
    const result = FluidManifestSchema.safeParse(minimalManifest({ id: "DEMO" }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((iss) => iss.path.join(".") === "id")).toBe(true);
  });

  it("rejects an id starting with a digit", () => {
    const result = FluidManifestSchema.safeParse(minimalManifest({ id: "1demo" }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((iss) => iss.path.join(".") === "id")).toBe(true);
  });

  it("rejects a 13-character id (limit is 12)", () => {
    const id = "a".repeat(13);
    expect(id).toHaveLength(13);
    const result = FluidManifestSchema.safeParse(minimalManifest({ id }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((iss) => iss.path.join(".") === "id")).toBe(true);
  });

  it("rejects an entry not present in objects", () => {
    const result = FluidManifestSchema.safeParse(minimalManifest({ entry: "ZCL_MISSING" }));
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((iss) => iss.path.join(".") === "entry");
    expect(issue?.message).toContain("ZCL_MISSING");
  });

  it("rejects duplicate object names", () => {
    const one = minimalManifest().objects[0]!;
    const result = FluidManifestSchema.safeParse(
      minimalManifest({ objects: [one, one] }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((iss) => iss.path.join(".") === "objects");
    expect(issue?.message).toContain("duplicate");
  });

  it("rejects an empty objects array", () => {
    const result = FluidManifestSchema.safeParse(minimalManifest({ objects: [] }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((iss) => iss.path[0] === "objects")).toBe(true);
  });

  it("rejects an empty actions array", () => {
    const result = FluidManifestSchema.safeParse(minimalManifest({ actions: [] }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((iss) => iss.path[0] === "actions")).toBe(true);
  });

  it("rejects an object description over 60 chars", () => {
    const base = minimalManifest();
    const objects = [{ ...base.objects[0]!, description: "x".repeat(61) }];
    const result = FluidManifestSchema.safeParse(minimalManifest({ objects }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((iss) => iss.path.join(".") === "objects.0.description"),
    ).toBe(true);
  });

  it("rejects an object name over 30 chars", () => {
    const base = minimalManifest();
    const longName = "Z".repeat(31);
    const objects = [{ ...base.objects[0]!, name: longName }];
    const result = FluidManifestSchema.safeParse(minimalManifest({ objects, entry: longName }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((iss) => iss.path.join(".") === "objects.0.name")).toBe(true);
  });

  it("rejects a bad action.category", () => {
    const base = minimalManifest();
    const actions = [{ ...base.actions[0]!, category: "delete" as unknown as "read" }];
    const result = FluidManifestSchema.safeParse(minimalManifest({ actions }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((iss) => iss.path.join(".") === "actions.0.category"),
    ).toBe(true);
  });
});

describe("validateFluidSchema — acceptance", () => {
  it("accepts the documented subset with nesting: object -> properties -> array -> items -> string with maxLength", () => {
    const schema = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string", maxLength: 10 },
        },
      },
      required: ["tags"],
    };
    expect(validateFluidSchema(schema, "root")).toEqual([]);
  });

  it("ignores an unknown keyword", () => {
    const schema = { type: "string", $comment: "x", examples: ["a"] };
    expect(validateFluidSchema(schema, "root")).toEqual([]);
  });
});

describe("validateFluidSchema — per-keyword rejections", () => {
  it("reports a bad type value with the where path", () => {
    const messages = validateFluidSchema({ type: "float" }, "actions[0].input");
    expect(messages.some((m) => m.startsWith("actions[0].input.type"))).toBe(true);
  });

  it("reports required not an array of strings, with the where path", () => {
    const messages = validateFluidSchema({ type: "object", required: "x" }, "actions[0].input");
    expect(messages.some((m) => m.startsWith("actions[0].input.required"))).toBe(true);
  });

  it("reports an empty enum, with the where path", () => {
    const messages = validateFluidSchema({ enum: [] }, "actions[0].input");
    expect(messages.some((m) => m.startsWith("actions[0].input.enum"))).toBe(true);
  });

  it("reports a negative maxLength, with the where path", () => {
    const messages = validateFluidSchema({ type: "string", maxLength: -1 }, "actions[0].input");
    expect(messages.some((m) => m.startsWith("actions[0].input.maxLength"))).toBe(true);
  });

  it("reports properties not an object, with the where path", () => {
    const messages = validateFluidSchema({ type: "object", properties: "x" }, "actions[0].input");
    expect(messages.some((m) => m.startsWith("actions[0].input.properties"))).toBe(true);
  });
});

describe("validateAgainstSchema", () => {
  const nestedSchema = {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 5 },
      count: { type: "integer", minimum: 0, maximum: 10 },
      tags: { type: "array", items: { type: "string" } },
      kind: { enum: ["a", "b"] },
    },
    required: ["name", "count"],
  } as const;

  it("accepts a value satisfying a nested schema", () => {
    const value = { name: "ab", count: 3, tags: ["x", "y"], kind: "a" };
    expect(validateAgainstSchema(value, nestedSchema, "root")).toEqual([]);
  });

  it("reports a missing required key, naming the path", () => {
    const value = { count: 3 };
    const messages = validateAgainstSchema(value, nestedSchema, "root");
    expect(messages).toContain("root.name: required");
  });

  it("reports a wrong element type inside an array, naming the path", () => {
    const value = { name: "ab", count: 1, tags: ["x", 5] };
    const messages = validateAgainstSchema(value, nestedSchema, "root");
    expect(messages.some((m) => m.startsWith("root.tags[1]"))).toBe(true);
  });

  it("reports an over-maxLength string, naming the path", () => {
    const value = { name: "toolong", count: 1 };
    const messages = validateAgainstSchema(value, nestedSchema, "root");
    expect(messages.some((m) => m.startsWith("root.name"))).toBe(true);
  });

  it("reports an out-of-range integer, naming the path", () => {
    const value = { name: "ab", count: 99 };
    const messages = validateAgainstSchema(value, nestedSchema, "root");
    expect(messages.some((m) => m.startsWith("root.count"))).toBe(true);
  });

  it("reports a non-member of an enum, naming the path", () => {
    const value = { name: "ab", count: 1, kind: "z" };
    const messages = validateAgainstSchema(value, nestedSchema, "root");
    expect(messages.some((m) => m.startsWith("root.kind"))).toBe(true);
  });

  it("accepts an extra property not named in properties", () => {
    const value = { name: "ab", count: 1, extra: "unlisted" };
    expect(validateAgainstSchema(value, nestedSchema, "root")).toEqual([]);
  });
});

describe("manifestVersion", () => {
  const manifest = minimalManifest();
  const sources = new Map([["ZCL_DEMO", "CLASS zcl_demo DEFINITION PUBLIC.\nENDCLASS."]]);

  it("returns 8 lowercase hex characters", () => {
    const version = manifestVersion(manifest, sources);
    expect(version).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is stable across calls", () => {
    expect(manifestVersion(manifest, sources)).toBe(manifestVersion(manifest, sources));
  });

  it("is unchanged when a source differs only by CRLF endings and trailing whitespace", () => {
    const crlfSources = new Map([
      ["ZCL_DEMO", "CLASS zcl_demo DEFINITION PUBLIC.  \r\nENDCLASS.   \r\n\r\n"],
    ]);
    expect(manifestVersion(manifest, crlfSources)).toBe(manifestVersion(manifest, sources));
  });

  it("changes when an object's source text changes", () => {
    const changed = new Map([["ZCL_DEMO", "CLASS zcl_demo DEFINITION PUBLIC.\nENDCLASS. \" x"]]);
    expect(manifestVersion(manifest, changed)).not.toBe(manifestVersion(manifest, sources));
  });

  it("changes when an object is renamed", () => {
    const renamed: FluidManifest = {
      ...manifest,
      objects: [{ ...manifest.objects[0]!, name: "ZCL_DEMO2" }],
      entry: "ZCL_DEMO2",
    };
    const renamedSources = new Map([
      ["ZCL_DEMO2", "CLASS zcl_demo DEFINITION PUBLIC.\nENDCLASS."],
    ]);
    expect(manifestVersion(renamed, renamedSources)).not.toBe(manifestVersion(manifest, sources));
  });

  it("changes when the object array is reordered", () => {
    const second = {
      name: "ZCL_DEMO_B",
      type: "CLAS/OC" as const,
      description: "second class",
      source: { text: "CLASS zcl_demo_b DEFINITION PUBLIC.\nENDCLASS." },
    };
    const twoObjects: FluidManifest = {
      ...manifest,
      objects: [manifest.objects[0]!, second],
    };
    const reordered: FluidManifest = {
      ...manifest,
      objects: [second, manifest.objects[0]!],
    };
    const twoSources = new Map([
      ["ZCL_DEMO", "CLASS zcl_demo DEFINITION PUBLIC.\nENDCLASS."],
      ["ZCL_DEMO_B", "CLASS zcl_demo_b DEFINITION PUBLIC.\nENDCLASS."],
    ]);
    expect(manifestVersion(reordered, twoSources)).not.toBe(manifestVersion(twoObjects, twoSources));
  });

  it("is unchanged when only manifest.title changes", () => {
    const retitled: FluidManifest = { ...manifest, title: "A completely different title" };
    expect(manifestVersion(retitled, sources)).toBe(manifestVersion(manifest, sources));
  });

  // Not a red-proof — manifestVersion never read `internal` (it doesn't exist
  // as a field it walks at all, additive or otherwise) — but this pins the
  // deploy-hash-stability claim `internal` is documented to make.
  it("is unchanged when internal is set, since manifestVersion never reads it", () => {
    const flagged: FluidManifest = { ...manifest, internal: true };
    expect(manifestVersion(flagged, sources)).toBe(manifestVersion(manifest, sources));
  });

  // A source text that spells out the separator can otherwise forge an
  // object boundary and collide two different manifests onto one version;
  // fails against a plain-separator (non-length-prefixed) join.
  it("does not let a source's content forge an object boundary", () => {
    const m1: FluidManifest = {
      ...manifest,
      objects: [
        { name: "ZA", type: "CLAS/OC", description: "a", source: { text: "line1" } },
        { name: "ZB", type: "CLAS/OC", description: "b", source: { text: "line2" } },
      ],
      entry: "ZA",
    };
    const s1 = new Map([
      ["ZA", "line1"],
      ["ZB", "line2"],
    ]);

    const m2: FluidManifest = {
      ...manifest,
      objects: [
        {
          name: "ZA",
          type: "CLAS/OC",
          description: "a",
          source: { text: "line1\n \nCLAS/OC\n \nZB\n \nline2" },
        },
      ],
      entry: "ZA",
    };
    const s2 = new Map([["ZA", "line1\n \nCLAS/OC\n \nZB\n \nline2"]]);

    expect(manifestVersion(m1, s1)).not.toBe(manifestVersion(m2, s2));
  });
});
