/**
 * Guard: `bundle/` is a committed build, and a committed build goes stale
 * silently. Claude Code runs no build step when it installs a plugin, so
 * `bundle/index.js` is the code users actually execute — an edit to `src/`
 * that never reaches it ships as a working repository running old behaviour,
 * with every other gate green. `scripts/bundle.mjs` records a digest of its
 * inputs at build time; this recomputes it and fails when the two diverge.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ENTRY_POINTS, MANIFEST_PATH, sourceDigest } from "../scripts/bundle.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(repoRoot, MANIFEST_PATH), "utf8")) as {
  sourceDigest: string;
  entryPoints: { entry: string; out: string }[];
};

describe("the committed plugin bundle matches the source it was built from", () => {
  it("BUILD-MANIFEST.json's digest still describes src/", () => {
    expect(
      manifest.sourceDigest,
      "bundle/ is stale: src/, a dependency range or the package version changed after the last build. " +
        "Run `npm run bundle` and commit the result — until you do, an installed plugin runs the old code.",
    ).toBe(sourceDigest(repoRoot));
  });

  it("every declared entry point is present and non-trivial", () => {
    for (const { out } of ENTRY_POINTS) {
      const file = join(repoRoot, out);
      expect(existsSync(file), `${out} is missing; run \`npm run bundle\``).toBe(true);
      expect(statSync(file).size, `${out} is too small to be a real bundle`).toBeGreaterThan(100_000);
    }
  });

  it("the manifest's entry points are the ones the build script declares", () => {
    expect(manifest.entryPoints).toEqual(ENTRY_POINTS);
  });

  it("each output carries the do-not-edit banner", () => {
    for (const { out } of ENTRY_POINTS) {
      const head = readFileSync(join(repoRoot, out), "utf8").slice(0, 200);
      expect(head, `${out} lost its generated-file banner`).toContain("GENERATED FILE - DO NOT EDIT");
    }
  });

  it("the server bundle does not carry @abaplint/core", () => {
    const server = readFileSync(join(repoRoot, "bundle/index.js"), "utf8");
    expect(
      server.includes("abaplint"),
      "@abaplint/core reached the server bundle. src/tools/v2/handlers/read.ts spawns the contract " +
        "reducer as a child process specifically to keep it out of the server's import graph; " +
        "something now imports it directly.",
    ).toBe(false);
  });
});
