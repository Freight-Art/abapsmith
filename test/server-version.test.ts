/**
 * Pins `SERVER_VERSION` (src/version.ts) to package.json's `version` field so
 * the two can never drift again — that drift is exactly what let a stale
 * `0.3.0` leak into the MCP `initialize` response and every fluid provenance
 * marker while the package was already at `0.4.0`. Reads package.json
 * independently (readFileSync + JSON.parse), not through src/version.ts's own
 * code path, so this test can't be fooled by a bug shared between the two.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SERVER_VERSION } from "../src/version.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("SERVER_VERSION", () => {
  it("strictly equals package.json's version field", () => {
    const pkg: unknown = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    );
    if (
      typeof pkg !== "object" ||
      pkg === null ||
      !("version" in pkg) ||
      typeof (pkg as { version: unknown }).version !== "string"
    ) {
      throw new Error("package.json has no string \"version\" field");
    }

    expect(SERVER_VERSION).toBe((pkg as { version: string }).version);
  });
});
