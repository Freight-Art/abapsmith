/**
 * Regression suite for the removal of the v2 consolidated tool surface
 * (issue #76, doc/DESIGN-NOTES/tool-surface-v2.md). Before this issue,
 * `ABAP_TOOL_SURFACE` chose between two registries — the original per-object
 * tools ("v1") and six consolidated tools ("v2"). Only the first survives,
 * always registered, and `ABAP_TOOL_SURFACE` is now obsolete.
 *
 * The point of Part A is that a stale `ABAP_TOOL_SURFACE=v2` sitting in an
 * operator's MCP config from before this change must fail loudly at startup,
 * not resolve to a quietly different tool surface than the operator believes
 * they configured. An unrecognised value gets the same treatment, on the
 * theory that "we don't know what this means" is exactly as dangerous as
 * "we know it used to mean something we removed" — both must refuse rather
 * than guess. `v1` — the name of the surface that survived — is accepted
 * with a warning rather than rejected, because rejecting it would break
 * every config that predates this issue for no safety reason. Unset is the
 * fully silent, ordinary case.
 *
 * Part B is a structural check that the v2 code itself, and every path that
 * used to point at it, is actually gone from the tree — not just that
 * `loadConfig` copes with a stale env var pointing at nothing.
 *
 * Offline throughout: no network, no server, `../src/config.js` plus
 * `node:fs`/`node:path`/`node:url` only.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig, redactConfigSecrets } from "../src/config.js";

/** Minimal env that satisfies the required fields, same shape used across test/config-*.test.ts. */
const env = (over: Record<string, string> = {}): Record<string, string> => ({
  ABAP_URL: "http://sap.invalid:50000",
  ABAP_USER: "U",
  ABAP_PASSWORD: "p",
  ...over,
});

function messageOf(fn: () => unknown): string {
  try {
    fn();
    throw new Error("expected loadConfig to throw");
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe("ABAP_TOOL_SURFACE is obsolete", () => {
  it("v2: refused at startup, naming the changelog and the design note", () => {
    const msg = messageOf(() =>
      loadConfig({ env: env({ ABAP_TOOL_SURFACE: "v2" }), warn: () => {}, skipDotenv: true }),
    );
    expect(msg).toContain("Invalid abapsmith configuration");
    expect(msg).toContain("toolSurface:");
    expect(msg).toContain("ABAP_TOOL_SURFACE=v2 was removed");
    expect(msg).toContain("CHANGELOG.md");
    expect(msg).toContain("doc/DESIGN-NOTES/tool-surface-v2.md");
  });

  it("an unknown value is refused too, not silently ignored", () => {
    const msg = messageOf(() =>
      loadConfig({ env: env({ ABAP_TOOL_SURFACE: "v3" }), warn: () => {}, skipDotenv: true }),
    );
    expect(msg).toContain("is not a value this server ever accepted");
  });

  it("v1: accepted, with one obsolete-variable warning", () => {
    const warnings: string[] = [];
    expect(() =>
      loadConfig({
        env: env({ ABAP_TOOL_SURFACE: "v1" }),
        warn: (m) => warnings.push(m),
        skipDotenv: true,
      }),
    ).not.toThrow();
    const matches = warnings.filter((w) => w.includes("ABAP_TOOL_SURFACE is obsolete and ignored"));
    expect(matches).toHaveLength(1);
  });

  it("unset: silent — no warning mentions the variable", () => {
    const warnings: string[] = [];
    expect(() =>
      loadConfig({ env: env(), warn: (m) => warnings.push(m), skipDotenv: true }),
    ).not.toThrow();
    expect(warnings.some((w) => w.includes("ABAP_TOOL_SURFACE"))).toBe(false);
  });

  it("the resolved config carries no tool-surface field at all", () => {
    const cfg = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    expect(Object.keys(cfg)).not.toContain("toolSurface");
    expect(Object.keys(redactConfigSecrets(cfg))).not.toContain("toolSurface");
  });
});

/**
 * Files whose whole purpose is to record that v2 is gone, and which
 * therefore have to name the removed paths themselves. A file belongs here
 * only if it documents the removal itself — never merely because it still
 * carries a stale reference someone hasn't gotten around to fixing.
 */
const REMOVAL_RECORD_FILES = new Set([
  // The design note explaining what v2 was and why it was removed; it has
  // to name the directory it is about.
  "doc/DESIGN-NOTES/tool-surface-v2.md",
  // This file: it necessarily contains the strings it searches for.
  "test/tool-surface-removal.test.ts",
]);

describe("the v2 tool surface is gone from the tree", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  it("src/tools/v2 does not exist", () => {
    expect(existsSync(join(ROOT, "src", "tools", "v2"))).toBe(false);
  });

  /**
   * Same idiom as `test/iserror-structural-invariant.test.ts`'s `listTsFiles`
   * (`readdirSync`/`statSync` recursion), generalised to walk every file
   * (not just `.ts`) since the two banned strings can equally show up in
   * `.md` docs and skills.
   */
  function listFiles(dir: string, skipDirNames: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skipDirNames.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...listFiles(full, skipDirNames));
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
    return out;
  }

  it("no source, test, doc or skill file references src/tools/v2 or doc/TOOL-SURFACE-V2", () => {
    const skipDirNames = new Set(["node_modules", "dist", "bundle", "fixtures"]);
    const roots = ["src", "test", "doc", "skills"]
      .map((name) => join(ROOT, name))
      .filter((p) => existsSync(p) && statSync(p).isDirectory());
    expect(roots.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of listFiles(root, skipDirNames)) {
        const text = readFileSync(file, "utf8");
        if (text.includes("src/tools/v2") || text.includes("TOOL-SURFACE-V2")) {
          const rel = relative(ROOT, file);
          if (!REMOVAL_RECORD_FILES.has(rel)) offenders.push(rel);
        }
      }
    }
    expect(
      offenders,
      `these files still reference the removed v2 tool surface: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("every file exempted from the v2 sweep still exists and still mentions what it claims to document", () => {
    // The allowlist above is only safe if each entry still earns its exemption.
    // If a file no longer mentions the removed paths, the exemption is dead
    // weight and the entry must be deleted from REMOVAL_RECORD_FILES rather
    // than left behind for the sweep to silently skip.
    const stale: string[] = [];
    for (const rel of REMOVAL_RECORD_FILES) {
      const full = join(ROOT, rel);
      if (!existsSync(full)) {
        stale.push(`${rel} (does not exist — remove it from REMOVAL_RECORD_FILES)`);
        continue;
      }
      const text = readFileSync(full, "utf8");
      if (!text.includes("src/tools/v2") && !text.includes("TOOL-SURFACE-V2")) {
        stale.push(
          `${rel} (no longer mentions src/tools/v2 or TOOL-SURFACE-V2 — remove it from REMOVAL_RECORD_FILES)`,
        );
      }
    }
    expect(stale).toEqual([]);
  });
});
