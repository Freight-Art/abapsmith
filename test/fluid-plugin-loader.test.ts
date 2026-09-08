import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadFluidTools,
  type FluidLoaderConfig,
  type FluidBuiltinSource,
} from "../src/adt/fluid/plugin-loader.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fluid-plugins");
const HELLO_DIR = join(FIXTURES, "hello");
const BAD_NAMESPACE_DIR = join(FIXTURES, "bad-namespace");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "abapsmith-fluid-plugin-loader-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const cfg = (roots: readonly string[], allow = true): FluidLoaderConfig => ({
  fluidPlugins: [...roots],
  allowFluidPlugins: allow,
});

const HELLO_MANIFEST = {
  contract: "1.0",
  id: "hello",
  title: "Hello fluid plugin",
  description: "temp plugin",
  objects: [
    {
      name: "ZCL_ZMCP_X_HELLO",
      type: "CLAS/OC",
      description: "fluid: hello body",
      source: { file: "abap/zcl_zmcp_x_hello.abap" },
    },
  ],
  entry: "ZCL_ZMCP_X_HELLO",
  actions: [
    {
      name: "ping",
      category: "read",
      description: "Replies with a fixed string.",
      input: { type: "object" },
      output: { type: "object", required: ["reply"], properties: { reply: { type: "string" } } },
    },
  ],
};

const CLEAN_BODY = [
  "CLASS zcl_zmcp_x_temp DEFINITION PUBLIC FINAL CREATE PUBLIC.",
  "  PUBLIC SECTION.",
  "    CLASS-METHODS run IMPORTING iv_action TYPE string",
  "                                iv_json   TYPE string.",
  "ENDCLASS.",
  "",
  "CLASS zcl_zmcp_x_temp IMPLEMENTATION.",
  "  METHOD run.",
  "    zcl_zmcp_fluid_rt=>out( '{}' ).",
  "  ENDMETHOD.",
  "ENDCLASS.",
  "",
].join("\n");

async function writePlugin(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  body = CLEAN_BODY,
): Promise<string> {
  const pluginDir = join(root, name);
  await mkdir(join(pluginDir, "abap"), { recursive: true });
  await writeFile(join(pluginDir, "fluid-plugin.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(pluginDir, "abap", "body.abap"), body);
  return pluginDir;
}

function manifestWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...HELLO_MANIFEST, ...overrides };
}

function pluginManifest(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const upper = id.toUpperCase();
  return manifestWith({
    id,
    objects: [
      { name: `ZCL_ZMCP_X_${upper}`, type: "CLAS/OC", description: "d", source: { file: "abap/body.abap" } },
    ],
    entry: `ZCL_ZMCP_X_${upper}`,
    ...overrides,
  });
}

// A configured root whose only immediate subdirectory is a symlink to an
// already-committed fixture, so a single fixture can be loaded (or refused)
// on its own without the sibling fixture under the same shared parent
// directory joining the same discovery pass. This suite needs a filesystem
// that supports symlinks: this helper creates one unconditionally, so a
// filesystem that refuses them fails most of the suite outright, not just
// the "symlink escape" and "symlinked plugin directory" tests below.
async function isolatedRoot(childName: string, target: string): Promise<string> {
  const root = join(dir, `root-${childName}`);
  await mkdir(root, { recursive: true });
  await symlink(target, join(root, childName), "dir");
  return root;
}

const builtin = (id: string): FluidBuiltinSource => ({
  manifest: {
    contract: "1.0",
    id,
    title: `${id} builtin`,
    description: "builtin fixture",
    objects: [{ name: `ZCL_ZMCP_FLUID_${id.toUpperCase()}`, type: "CLAS/OC", description: "d", source: { text: "CLASS x." } }],
    entry: `ZCL_ZMCP_FLUID_${id.toUpperCase()}`,
    actions: [
      {
        name: "ping",
        category: "read",
        description: "d",
        input: { type: "object" },
        output: { type: "object" },
      },
    ],
  },
  sources: new Map([[`ZCL_ZMCP_FLUID_${id.toUpperCase()}`, "CLASS x."]]),
});

describe("hello fixture", () => {
  it("loads as a single plugin tool", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("hello", HELLO_DIR)]));
    expect(result.refused).toEqual([]);
    expect(result.tools.size).toBe(1);
    const tool = result.tools.get("hello");
    if (!tool) throw new Error("unreachable");
    expect(tool.origin).toBe("plugin");
    expect(tool.dir).toBe(HELLO_DIR);
    const realSource = await readFile(join(HELLO_DIR, "abap", "zcl_zmcp_x_hello.abap"), "utf8");
    expect(tool.sources.get("ZCL_ZMCP_X_HELLO")).toBe(realSource);
    expect(tool.version).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("bad-namespace fixture", () => {
  it("refuses for exactly the namespace violation, naming the offending object", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("bad-namespace", BAD_NAMESPACE_DIR)]));
    expect(result.tools.size).toBe(0);
    expect(result.refused).toHaveLength(1);
    const refusal = result.refused[0];
    if (!refusal) throw new Error("unreachable");
    expect(refusal.code).toBe("FLUID_MANIFEST_INVALID");
    expect(refusal.id).toBe("badns");
    expect(refusal.path).toBe(BAD_NAMESPACE_DIR);
    expect(refusal.reason).toMatch(/ZCL_BADNS_BODY/);
    expect(refusal.reason).not.toMatch(/cannot be resolved|could not be read|ENOENT/i);
  });
});

describe("a root holding both fixtures", () => {
  it("loads a good plugin and refuses a bad one from the same call", async () => {
    const result = await loadFluidTools(cfg([FIXTURES]));
    expect(result.tools.size).toBe(1);
    expect(result.tools.has("hello")).toBe(true);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.id).toBe("badns");
  });
});

describe("contract version", () => {
  it("refuses an unknown contract major", async () => {
    const pluginDir = await writePlugin(dir, "futuremajor", pluginManifest("futuremajor", { contract: "2.0" }));
    const result = await loadFluidTools(cfg([dir]));
    expect(result.tools.size).toBe(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.path).toBe(pluginDir);
    expect(result.refused[0]?.reason).toMatch(/contract/i);
  });

  it("loads an unknown minor with a warning naming the plugin and both versions", async () => {
    await writePlugin(dir, "futureminor", pluginManifest("futureminor", { contract: "1.7" }));
    const result = await loadFluidTools(cfg([dir]));
    expect(result.refused).toEqual([]);
    expect(result.tools.has("futureminor")).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/futureminor/);
    expect(result.warnings[0]).toMatch(/1\.7/);
    expect(result.warnings[0]).toMatch(/1\.0/);
  });
});

describe("id collision", () => {
  it("keeps the built-in and refuses the colliding plugin", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("hello", HELLO_DIR)]), [builtin("hello")]);
    expect(result.tools.size).toBe(1);
    const tool = result.tools.get("hello");
    expect(tool?.origin).toBe("builtin");
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.id).toBe("hello");
    expect(result.refused[0]?.reason).toMatch(/collid/i);
  });
});

describe("allowFluidPlugins: false", () => {
  it("still loads built-ins but reports the plugin directory as disabled", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("hello", HELLO_DIR)], false), [builtin("other")]);
    expect(result.tools.size).toBe(1);
    expect(result.tools.get("other")?.origin).toBe("builtin");
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toEqual(
      expect.objectContaining({ path: HELLO_DIR, code: "FLUID_PLUGINS_DISABLED" }),
    );
  });
});

describe("path escape", () => {
  it("refuses a source.file with a .. segment", async () => {
    const pluginDir = join(dir, "escape");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(dir, "outside.abap"), CLEAN_BODY);
    await writeFile(
      join(pluginDir, "fluid-plugin.json"),
      JSON.stringify(manifestWith({ id: "escape", objects: [
        { name: "ZCL_ZMCP_X_ESCAPE", type: "CLAS/OC", description: "d", source: { file: "../outside.abap" } },
      ], entry: "ZCL_ZMCP_X_ESCAPE" })),
    );
    const result = await loadFluidTools(cfg([dir]));
    expect(result.tools.size).toBe(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.reason).toMatch(/\.\./);
  });

  it("refuses a source.file that is an absolute path", async () => {
    const pluginDir = join(dir, "absolute");
    await mkdir(pluginDir, { recursive: true });
    const absoluteTarget = join(dir, "abs-target.abap");
    await writeFile(absoluteTarget, CLEAN_BODY);
    await writeFile(
      join(pluginDir, "fluid-plugin.json"),
      JSON.stringify(manifestWith({ id: "absolute", objects: [
        { name: "ZCL_ZMCP_X_ABSOLUTE", type: "CLAS/OC", description: "d", source: { file: absoluteTarget } },
      ], entry: "ZCL_ZMCP_X_ABSOLUTE" })),
    );
    const result = await loadFluidTools(cfg([dir]));
    expect(result.tools.size).toBe(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.reason).toMatch(/absolute/i);
  });
});

describe("text source not allowed for a plugin", () => {
  it('refuses an object whose source is {"text": ...} instead of {"file": ...}', async () => {
    const pluginDir = join(dir, "texty");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "fluid-plugin.json"),
      JSON.stringify(manifestWith({ id: "texty", objects: [
        { name: "ZCL_ZMCP_X_TEXTY", type: "CLAS/OC", description: "d", source: { text: "CLASS x." } },
      ], entry: "ZCL_ZMCP_X_TEXTY" })),
    );
    const result = await loadFluidTools(cfg([dir]));
    expect(result.tools.size).toBe(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.code).toBe("FLUID_MANIFEST_INVALID");
    expect(result.refused[0]?.reason).toMatch(/"text"/);
    expect(result.refused[0]?.reason).toMatch(/"file"/);
  });
});

describe("id collision between two plugins", () => {
  it("keeps the first-discovered plugin and refuses the second for the same id", async () => {
    const firstDir = await writePlugin(dir, "aaa-first", pluginManifest("dupe"));
    const secondDir = await writePlugin(dir, "zzz-second", pluginManifest("dupe"));
    const result = await loadFluidTools(cfg([dir]));
    expect(result.tools.size).toBe(1);
    const tool = result.tools.get("dupe");
    if (!tool) throw new Error("unreachable");
    expect(tool.origin).toBe("plugin");
    expect(tool.dir).toBe(firstDir);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.path).toBe(secondDir);
    expect(result.refused[0]?.id).toBe("dupe");
    expect(result.refused[0]?.reason).toMatch(/collid/i);
  });
});

describe("symlink escape", () => {
  it("refuses a source.file that is a symlink escaping the plugin directory", async (ctx) => {
    const pluginDir = join(dir, "symlinked");
    await mkdir(join(pluginDir, "abap"), { recursive: true });
    const outsideFile = join(dir, "outside-real.abap");
    await writeFile(outsideFile, CLEAN_BODY);
    const linkPath = join(pluginDir, "abap", "body.abap");
    try {
      await symlink(outsideFile, linkPath);
    } catch {
      // A filesystem that refuses symlinks should show up as skipped, not
      // as a silent pass: this suite already depends on symlink support
      // elsewhere (see isolatedRoot above), so such a run is not viable.
      ctx.skip();
      return;
    }
    await writeFile(
      join(pluginDir, "fluid-plugin.json"),
      JSON.stringify(manifestWith({ id: "symlinked", objects: [
        { name: "ZCL_ZMCP_X_SYMLINKED", type: "CLAS/OC", description: "d", source: { file: "abap/body.abap" } },
      ], entry: "ZCL_ZMCP_X_SYMLINKED" })),
    );
    const result = await loadFluidTools(cfg([dir]));
    expect(result.tools.size).toBe(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.reason).toMatch(/outside the plugin directory/i);
  });
});

describe("symlinked plugin directory", () => {
  it("discovers a plugin reached through a symlinked directory and reports dir as the resolved real path", async (ctx) => {
    const realTarget = join(dir, "actual-plugin");
    await mkdir(join(realTarget, "abap"), { recursive: true });
    await writeFile(join(realTarget, "fluid-plugin.json"), JSON.stringify(pluginManifest("linked")));
    await writeFile(join(realTarget, "abap", "body.abap"), CLEAN_BODY);

    const rootDir = join(dir, "linkroot");
    await mkdir(rootDir, { recursive: true });
    const linkPath = join(rootDir, "linked-child");
    try {
      await symlink(realTarget, linkPath, "dir");
    } catch {
      // Same rationale as the "symlink escape" test above: skip rather
      // than silently pass on a filesystem that refuses symlinks.
      ctx.skip();
      return;
    }

    const result = await loadFluidTools(cfg([rootDir]));
    expect(result.refused).toEqual([]);
    const tool = result.tools.get("linked");
    if (!tool) throw new Error("unreachable");
    expect(tool.dir).toBe(realTarget);
    expect(tool.dir).not.toBe(linkPath);
  });
});

describe("static review refusal", () => {
  it("refuses a plugin whose ABAP fails the static review, naming object, line and rule", async () => {
    const badBody = [
      "CLASS zcl_zmcp_x_dirty DEFINITION PUBLIC FINAL CREATE PUBLIC.",
      "  PUBLIC SECTION.",
      "    CLASS-METHODS run IMPORTING iv_action TYPE string",
      "                                iv_json   TYPE string.",
      "ENDCLASS.",
      "",
      "CLASS zcl_zmcp_x_dirty IMPLEMENTATION.",
      "  METHOD run.",
      "    EXEC SQL.",
      "    ENDEXEC.",
      "  ENDMETHOD.",
      "ENDCLASS.",
      "",
    ].join("\n");
    await writePlugin(dir, "dirty", manifestWith({ id: "dirty", objects: [
      { name: "ZCL_ZMCP_X_DIRTY", type: "CLAS/OC", description: "d", source: { file: "abap/body.abap" } },
    ], entry: "ZCL_ZMCP_X_DIRTY" }), badBody);
    const result = await loadFluidTools(cfg([dir]));
    expect(result.tools.size).toBe(0);
    expect(result.refused).toHaveLength(1);
    const reason = result.refused[0]?.reason ?? "";
    expect(reason).toMatch(/ZCL_ZMCP_X_DIRTY/);
    expect(reason).toMatch(/line 9/);
    expect(reason).toMatch(/exec-sql/);
  });
});

describe("malformed manifests", () => {
  it("refuses malformed JSON with a reason that makes the parse failure obvious", async () => {
    const pluginDir = join(dir, "malformed");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "fluid-plugin.json"), "{ this is not json");
    const result = await loadFluidTools(cfg([dir]));
    expect(result.tools.size).toBe(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.reason).toMatch(/JSON/i);
  });

  it("refuses a manifest missing a required field with the zod issues in the reason", async () => {
    const { title, ...withoutTitle } = HELLO_MANIFEST;
    void title;
    const pluginDir = join(dir, "notitle");
    await mkdir(join(pluginDir, "abap"), { recursive: true });
    await writeFile(join(pluginDir, "fluid-plugin.json"), JSON.stringify(withoutTitle));
    await writeFile(join(pluginDir, "abap", "zcl_zmcp_x_hello.abap"), CLEAN_BODY);
    const result = await loadFluidTools(cfg([dir]));
    expect(result.tools.size).toBe(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.reason).toMatch(/title/i);
  });
});

describe("root discovery", () => {
  it("reports a nonexistent root instead of silently dropping it", async () => {
    const missingRoot = join(dir, "does-not-exist");
    const result = await loadFluidTools(cfg([missingRoot]));
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.path).toBe(missingRoot);
    expect(result.refused[0]?.code).toBe("FLUID_MANIFEST_INVALID");
    expect(result.tools.size).toBe(0);
  });

  it("does not report a subdirectory without a fluid-plugin.json", async () => {
    await mkdir(join(dir, "not-a-plugin"), { recursive: true });
    await writeFile(join(dir, "not-a-plugin", "readme.txt"), "nothing to see here");
    const result = await loadFluidTools(cfg([dir]));
    expect(result.tools.size).toBe(0);
    expect(result.refused).toEqual([]);
  });
});

describe("empty configuration", () => {
  it("returns exactly the passed-in built-ins with no refusals or warnings", async () => {
    const result = await loadFluidTools(cfg([]), [builtin("alpha"), builtin("beta")]);
    expect(result.tools.size).toBe(2);
    expect(result.tools.get("alpha")?.origin).toBe("builtin");
    expect(result.tools.get("beta")?.origin).toBe("builtin");
    expect(result.refused).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});
