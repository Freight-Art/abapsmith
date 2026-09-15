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
const DB_WRITE_DIR = join(FIXTURES, "db-write");
const COMMIT_WORK_DIR = join(FIXTURES, "commit-work");
const CALL_FM_DIR = join(FIXTURES, "call-fm");
const FOO_DIR = join(FIXTURES, "foo");
const FOO_BAR_DIR = join(FIXTURES, "foo_bar");
// The shipped, operator-installable plugins live outside the fixtures tree.
const SHIPPED_PLUGINS = join(dirname(fileURLToPath(import.meta.url)), "..", "fluid-plugins");
const NR_DIR = join(SHIPPED_PLUGINS, "nr");
const JOBS_DIR = join(SHIPPED_PLUGINS, "jobs");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "abapsmith-fluid-plugin-loader-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const cfg = (
  roots: readonly string[],
  allow = true,
  allowMutate = false,
  allowCallFm = false,
): FluidLoaderConfig => ({
  fluidPlugins: [...roots],
  allowFluidPlugins: allow,
  allowFluidPluginMutate: allowMutate,
  allowFluidCallFm: allowCallFm,
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

// Same isolation as isolatedRoot above, but for tests that need several
// already-committed fixtures visible to the same loadFluidTools call (e.g.
// a cross-plugin conflict, which only shows up when both sides are
// discovered together) without pulling in every other sibling under the
// shared fixtures directory.
async function isolatedRootWith(children: readonly { readonly name: string; readonly target: string }[]): Promise<string> {
  const root = join(dir, `root-${children.map((c) => c.name).join("-")}`);
  await mkdir(root, { recursive: true });
  for (const { name, target } of children) {
    await symlink(target, join(root, name), "dir");
  }
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
    // Isolated to exactly these two fixtures (not the whole shared
    // fixtures directory) so adding further sibling fixture directories
    // under test/fixtures/fluid-plugins/ never changes what this test sees.
    const root = await isolatedRootWith([
      { name: "hello", target: HELLO_DIR },
      { name: "bad-namespace", target: BAD_NAMESPACE_DIR },
    ]);
    const result = await loadFluidTools(cfg([root]));
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
    // Not FLUID_MANIFEST_INVALID: no manifest was ever read here, the
    // configured root itself couldn't be listed. BAD_INPUT is the repo's
    // documented fallback for "no dedicated code" (see src/adt/write.ts).
    expect(result.refused[0]?.code).toBe("BAD_INPUT");
    expect(result.refused[0]?.reason).toContain(missingRoot);
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

describe("plugin mutate gate", () => {
  it("refuses a plugin whose ABAP contains a database write when ABAP_ALLOW_FLUID_PLUGIN_MUTATE is off", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("db-write", DB_WRITE_DIR)]));
    expect(result.tools.size).toBe(0);
    expect(result.refused).toHaveLength(1);
    const refusal = result.refused[0];
    if (!refusal) throw new Error("unreachable");
    expect(refusal.code).toBe("FLUID_PLUGIN_MUTATE_DISABLED");
    expect(refusal.id).toBe("dbwrite");
    expect(refusal.reason).toMatch(/ZCL_ZMCP_X_DBWRITE/);
    expect(refusal.reason).toMatch(/\.abap:9\b/);
  });

  it("loads the same plugin once ABAP_ALLOW_FLUID_PLUGIN_MUTATE is on", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("db-write", DB_WRITE_DIR)], true, true));
    expect(result.refused).toEqual([]);
    expect(result.tools.has("dbwrite")).toBe(true);
  });

  it("refuses a plugin whose ABAP contains COMMIT WORK when ABAP_ALLOW_FLUID_PLUGIN_MUTATE is off", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("commit-work", COMMIT_WORK_DIR)]));
    expect(result.tools.size).toBe(0);
    expect(result.refused).toHaveLength(1);
    const refusal = result.refused[0];
    if (!refusal) throw new Error("unreachable");
    expect(refusal.code).toBe("FLUID_PLUGIN_MUTATE_DISABLED");
    expect(refusal.id).toBe("commitwk");
    expect(refusal.reason).toMatch(/ZCL_ZMCP_X_COMMITWK/);
    expect(refusal.reason).toMatch(/\.abap:9\b/);
  });

  it("loads the COMMIT WORK plugin once ABAP_ALLOW_FLUID_PLUGIN_MUTATE is on", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("commit-work", COMMIT_WORK_DIR)], true, true));
    expect(result.refused).toEqual([]);
    expect(result.tools.has("commitwk")).toBe(true);
  });
});

describe("plugin CALL FUNCTION gate", () => {
  it("refuses a plugin whose ABAP contains a plain CALL FUNCTION when ABAP_ALLOW_FLUID_CALL_FM is off", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("call-fm", CALL_FM_DIR)]));
    expect(result.tools.size).toBe(0);
    expect(result.refused).toHaveLength(1);
    const refusal = result.refused[0];
    if (!refusal) throw new Error("unreachable");
    expect(refusal.code).toBe("SAFETY_DENIED");
    expect(refusal.rule).toBe("ABAP_ALLOW_FLUID_CALL_FM");
    expect(refusal.id).toBe("callfm");
    expect(refusal.reason).toMatch(/ZCL_ZMCP_X_CALLFM/);
    expect(refusal.reason).toMatch(/\.abap:9\b/);
  });

  it("loads the same plugin once ABAP_ALLOW_FLUID_CALL_FM is on", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("call-fm", CALL_FM_DIR)], true, false, true));
    expect(result.refused).toEqual([]);
    expect(result.tools.has("callfm")).toBe(true);
  });
});

describe("cross-plugin object-name conflict", () => {
  it("refuses the second-discovered plugin claiming an object name another loaded tool already owns, naming both tool ids", async () => {
    const root = await isolatedRootWith([
      { name: "foo", target: FOO_DIR },
      { name: "foo_bar", target: FOO_BAR_DIR },
    ]);
    const result = await loadFluidTools(cfg([root]));
    expect(result.tools.size).toBe(1);
    expect(result.tools.has("foo")).toBe(true);
    expect(result.refused).toHaveLength(1);
    const refusal = result.refused[0];
    if (!refusal) throw new Error("unreachable");
    expect(refusal.code).toBe("FLUID_OBJECT_CONFLICT");
    expect(refusal.id).toBe("foo_bar");
    expect(refusal.reason).toMatch(/ZCL_ZMCP_X_FOO_BAR/);
    expect(refusal.reason).toMatch(/foo/);
    expect(refusal.reason).toMatch(/foo_bar/);
  });

  it("refuses a plugin whose object name is already claimed by a built-in, naming both tool ids", async () => {
    const sneaky: FluidBuiltinSource = {
      manifest: {
        contract: "1.0",
        id: "sneaky",
        title: "sneaky builtin",
        description: "builtin fixture claiming the hello plugin's object name",
        objects: [{ name: "ZCL_ZMCP_X_HELLO", type: "CLAS/OC", description: "d", source: { text: "CLASS x." } }],
        entry: "ZCL_ZMCP_X_HELLO",
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
      sources: new Map([["ZCL_ZMCP_X_HELLO", "CLASS x."]]),
    };
    const result = await loadFluidTools(cfg([await isolatedRoot("hello", HELLO_DIR)]), [sneaky]);
    expect(result.tools.size).toBe(1);
    expect(result.tools.has("sneaky")).toBe(true);
    expect(result.refused).toHaveLength(1);
    const refusal = result.refused[0];
    if (!refusal) throw new Error("unreachable");
    expect(refusal.code).toBe("FLUID_OBJECT_CONFLICT");
    expect(refusal.id).toBe("hello");
    expect(refusal.reason).toMatch(/ZCL_ZMCP_X_HELLO/);
    expect(refusal.reason).toMatch(/sneaky/);
  });
});

describe("shipped plugin fluid-plugins/nr", () => {
  it("loads with every action once mutate and CALL FUNCTION are allowed", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("nr", NR_DIR)], true, true, true));
    expect(result.refused).toEqual([]);
    const tool = result.tools.get("nr");
    if (!tool) throw new Error("unreachable");
    expect(tool.origin).toBe("plugin");
    expect(tool.manifest.actions.map((a) => a.name).sort()).toEqual([
      "create",
      "delete",
      "describe",
      "get_next",
      "list",
      "set_interval",
    ]);
    expect(tool.sources.has("ZCL_ZMCP_X_NR")).toBe(true);
  });

  it("is refused while ABAP_ALLOW_FLUID_CALL_FM is off, because it calls NUMBER_RANGE_* function modules", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("nr", NR_DIR)], true, true, false));
    expect(result.tools.size).toBe(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.code).toBe("SAFETY_DENIED");
    expect(result.refused[0]?.rule).toBe("ABAP_ALLOW_FLUID_CALL_FM");
    expect(result.refused[0]?.id).toBe("nr");
  });

  it("still loads with ABAP_ALLOW_FLUID_PLUGIN_MUTATE off: it mutates through function modules, not Open SQL, so the mutate gate applies per action at dispatch", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("nr", NR_DIR)], true, false, true));
    expect(result.refused).toEqual([]);
    const tool = result.tools.get("nr");
    if (!tool) throw new Error("unreachable");
    expect(tool.manifest.actions.filter((a) => a.category === "mutate").map((a) => a.name).sort()).toEqual([
      "create",
      "delete",
      "set_interval",
    ]);
  });
});

describe("shipped plugin fluid-plugins/jobs", () => {
  it("loads with every action once mutate and CALL FUNCTION are allowed", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("jobs", JOBS_DIR)], true, true, true));
    expect(result.refused).toEqual([]);
    const tool = result.tools.get("jobs");
    if (!tool) throw new Error("unreachable");
    expect(tool.origin).toBe("plugin");
    expect(tool.manifest.actions.map((a) => a.name).sort()).toEqual([
      "cancel",
      "list",
      "schedule",
      "show",
      "spool",
    ]);
    expect(tool.sources.has("ZCL_ZMCP_X_JOBS")).toBe(true);
  });

  it("is refused while ABAP_ALLOW_FLUID_CALL_FM is off, because it schedules and cancels through the JOB_* and BP_JOB_* function modules", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("jobs", JOBS_DIR)], true, true, false));
    expect(result.tools.size).toBe(0);
    expect(result.refused).toHaveLength(1);
    const refusal = result.refused[0];
    if (!refusal) throw new Error("unreachable");
    expect(refusal.code).toBe("SAFETY_DENIED");
    expect(refusal.rule).toBe("ABAP_ALLOW_FLUID_CALL_FM");
    expect(refusal.id).toBe("jobs");
  });

  it("still loads with ABAP_ALLOW_FLUID_PLUGIN_MUTATE off: it mutates through function modules, not Open SQL, so the mutate gate applies per action at dispatch", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("jobs", JOBS_DIR)], true, false, true));
    expect(result.refused).toEqual([]);
    const tool = result.tools.get("jobs");
    if (!tool) throw new Error("unreachable");
    expect(tool.manifest.actions.filter((a) => a.category === "mutate").map((a) => a.name).sort()).toEqual([
      "cancel",
      "schedule",
    ]);
  });

  it("gates schedule on the report it will run, and declares no target for cancel, which is not a repository object", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("jobs", JOBS_DIR)], true, true, true));
    expect(result.refused).toEqual([]);
    const tool = result.tools.get("jobs");
    if (!tool) throw new Error("unreachable");
    const schedule = tool.manifest.actions.find((a) => a.name === "schedule");
    if (!schedule) throw new Error("unreachable");
    expect(schedule.targets).toEqual({ object: "/program" });
    const cancel = tool.manifest.actions.find((a) => a.name === "cancel");
    if (!cancel) throw new Error("unreachable");
    // A background job is not a repository object: it has no package and no
    // ABAP object name for the safety gate to judge. cancel is instead
    // controlled by the mutate flag, the confirm echo, and the plugin's own
    // owner check (any_owner / scheduled-by-caller).
    expect(cancel.targets).toBeUndefined();
  });

  it("takes only flat arguments, because the ABAP argument reader parses one level", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("jobs", JOBS_DIR)], true, true, true));
    expect(result.refused).toEqual([]);
    const tool = result.tools.get("jobs");
    if (!tool) throw new Error("unreachable");
    const flatTypes = ["string", "boolean", "integer", "number"];
    for (const action of tool.manifest.actions) {
      const properties = action.input.properties ?? {};
      for (const [propName, propSchema] of Object.entries(properties)) {
        expect(
          propSchema.type,
          `action "${action.name}" property "${propName}" has type ${String(propSchema.type)}, expected one of ${flatTypes.join(", ")}`,
        ).toBeDefined();
        expect(
          flatTypes,
          `action "${action.name}" property "${propName}" has type ${String(propSchema.type)}, expected one of ${flatTypes.join(", ")}`,
        ).toContain(propSchema.type);
      }
    }
  });

  it("exposes no way to schedule an OS command or an external program", async () => {
    const result = await loadFluidTools(cfg([await isolatedRoot("jobs", JOBS_DIR)], true, true, true));
    expect(result.refused).toEqual([]);
    const tool = result.tools.get("jobs");
    if (!tool) throw new Error("unreachable");
    const schedule = tool.manifest.actions.find((a) => a.name === "schedule");
    if (!schedule) throw new Error("unreachable");
    const properties = schedule.input.properties ?? {};
    for (const propName of Object.keys(properties)) {
      expect(propName).not.toMatch(/extpgm|command|opsys|external/i);
    }
    expect(schedule.description.toLowerCase()).toContain("os command");
  });
});
