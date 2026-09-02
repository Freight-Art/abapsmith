/**
 * Guard: the two manifests that make this repo installable as a Claude Code
 * plugin marketplace (`/plugin marketplace add Freight-Art/abapsmith`, then
 * `/plugin install abapsmith@abapsmith`) are only ever exercised by a real
 * install, so nothing else in this suite would notice them going wrong. The
 * failure that matters most is a manifest pointing at a file that isn't in the
 * repo: `bundle/index.js` is a build output that is committed on purpose, and
 * if it were ever gitignored or forgotten the plugin would install cleanly and
 * then fail to launch on the user's machine, where no test runs. So the
 * `${CLAUDE_PLUGIN_ROOT}` path is resolved against the repo root and checked
 * on disk here. The rest are drift guards between the three manifests, which
 * duplicate a name and a version between them.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

function readJson(...segments: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, ...segments), "utf8")) as Record<string, unknown>;
}

const marketplace = readJson(".claude-plugin", "marketplace.json");
const plugin = readJson(".claude-plugin", "plugin.json");
const pkg = readJson("package.json");

describe(".claude-plugin/marketplace.json", () => {
  it("declares a kebab-case name, an owner and a plugins array", () => {
    expect(marketplace.name).toBe("abapsmith");
    expect(marketplace.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(marketplace.owner).toMatchObject({ name: expect.any(String) });
    expect(Array.isArray(marketplace.plugins)).toBe(true);
  });

  it("has exactly one plugin entry, sourced from the repo root", () => {
    const plugins = marketplace.plugins as Record<string, unknown>[];
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.source).toBe("./");
  });

  it("names the same plugin plugin.json does", () => {
    const plugins = marketplace.plugins as Record<string, unknown>[];
    expect(
      plugins[0]!.name,
      "the marketplace entry and .claude-plugin/plugin.json must name the same plugin — " +
        "`/plugin install <entry>@abapsmith` resolves against the entry name.",
    ).toBe(plugin.name);
  });
});

describe(".claude-plugin/plugin.json", () => {
  it("declares the MCP server under the key the tool names derive from", () => {
    const servers = plugin.mcpServers as Record<string, unknown>;
    expect(
      Object.keys(servers),
      "the server key becomes the `mcp__<key>__*` tool-name prefix the skills and docs assume.",
    ).toEqual(["abap"]);
  });

  it("launches a bundle path that exists in the repo", () => {
    const server = (plugin.mcpServers as Record<string, Record<string, unknown>>).abap!;
    const argv = [server.command as string, ...(server.args as string[])];
    const referenced = argv.filter((a) => a.includes("${CLAUDE_PLUGIN_ROOT}"));
    expect(
      referenced,
      "the launch path must be anchored to ${CLAUDE_PLUGIN_ROOT} — a bare relative path " +
        "resolves against the user's cwd, not the installed plugin directory.",
    ).not.toEqual([]);
    for (const arg of referenced) {
      const resolved = arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", repoRoot);
      expect(
        existsSync(resolved),
        `${arg} resolves to ${resolved}, which is not in the repo. A fresh clone would ` +
          "install this plugin and then fail to launch it — rebuild the bundle and commit it.",
      ).toBe(true);
    }
  });

  it("carries the same version as package.json", () => {
    expect(plugin.version).toBe(pkg.version);
  });
});
