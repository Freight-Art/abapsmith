/**
 * Pin: `$ZMCP_HELPERS` (formerly managed by src/adt/helper-package.ts,
 * deleted alongside test/helper-package.test.ts) is retired as a package the
 * fluid layer CREATES. It survives only as an entry in
 * LEGACY_FLUID_PACKAGES (src/adt/fluid/package.ts) — a package fluid
 * relocates objects OUT of, never into. If any of the checks below fail, the
 * failure names the exact file (and, for the literal scan, line) that
 * reintroduced it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const srcDir = join(repoRoot, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function toRel(absPath: string): string {
  return relative(repoRoot, absPath).split("\\").join("/");
}

const ALLOWED_FILE = "src/adt/fluid/package.ts";

describe("$ZMCP_HELPERS is retired as a package fluid creates", () => {
  const srcFiles = walk(srcDir).map(toRel).sort();

  it("scanned some files — the walk is not broken", () => {
    expect(srcFiles.length).toBeGreaterThan(20);
  });

  it("no file named helper-package.ts exists anywhere under src/", () => {
    const hits = srcFiles.filter((f) => f.split("/").pop() === "helper-package.ts");
    expect(hits, `helper-package.ts must stay deleted, found: ${hits.join(", ")}`).toEqual([]);
  });

  it("no module under src/ imports \"helper-package\"", () => {
    const importerHits: string[] = [];
    for (const relPath of srcFiles) {
      const lines = readFileSync(join(repoRoot, relPath), "utf8").split("\n");
      lines.forEach((line, idx) => {
        if (/(?:from|require\()\s*["'][^"']*helper-package[^"']*["']/.test(line)) {
          importerHits.push(`${relPath}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    expect(importerHits, importerHits.join("\n")).toEqual([]);
  });

  it("every remaining `$ZMCP_HELPERS` literal in src/ is confined to src/adt/fluid/package.ts", () => {
    const strayHits: string[] = [];
    for (const relPath of srcFiles) {
      if (relPath === ALLOWED_FILE) continue;
      const lines = readFileSync(join(repoRoot, relPath), "utf8").split("\n");
      lines.forEach((line, idx) => {
        if (line.includes("$ZMCP_HELPERS")) {
          strayHits.push(`${relPath}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      strayHits,
      `$ZMCP_HELPERS must appear only in ${ALLOWED_FILE} (as a LEGACY_FLUID_PACKAGES entry fluid relocates OUT of, never a package it creates); found elsewhere:\n${strayHits.join("\n")}`,
    ).toEqual([]);
  });

  it("the allowlisted file still actually contains the literal — otherwise the previous check is vacuous", () => {
    const text = readFileSync(join(repoRoot, ALLOWED_FILE), "utf8");
    expect(text).toContain("$ZMCP_HELPERS");
  });
});
