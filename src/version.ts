/**
 * abapsmith's own release version. A leaf module — no imports from elsewhere
 * in `src/` (only Node built-ins), importable from anywhere (including deep
 * inside `adt/fluid/`) without dragging in the MCP server or anything
 * network-facing. `src/server.ts` re-exports this constant so every existing
 * `SERVER_VERSION` import keeps working.
 *
 * Read from `package.json` at runtime instead of being duplicated as a
 * string literal, so it can never drift from the published package version
 * again (see CHANGELOG.md's `[Unreleased]` "Fixed" entry — that drift is
 * exactly what put a stale `0.3.0` into every fluid provenance marker while
 * the package was already at `0.4.0`).
 *
 * `src/version.ts` sits directly under `src/` and compiles to `dist/version.js`
 * directly under `dist/` (see tsconfig.json's `rootDir`/`outDir`), so the
 * same `../package.json` relative path resolves to the repo root correctly
 * both from source (as run under vitest) and from the compiled output.
 */
import { readFileSync } from "node:fs";

function readPackageVersion(raw: unknown): string {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("version" in raw) ||
    typeof (raw as { version: unknown }).version !== "string"
  ) {
    throw new Error(
      "src/version.ts: package.json has no string \"version\" field",
    );
  }
  return (raw as { version: string }).version;
}

const packageJson: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const SERVER_VERSION: string = readPackageVersion(packageJson);
