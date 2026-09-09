/**
 * Regression pin for the import cycle `src/adt/bridge-mutation.ts` documents
 * in its own header: `run.ts` imports `./write.js`, `write.ts` imported
 * `assertBridgeMutation` from `./ddic-bridge.js`, and `ddic-bridge.ts`
 * imports `./run.js` — `import("dist/adt/run.js")` as an entry point threw
 * `Cannot access 'BRIDGE_PACKAGE' before initialization`. The fix was
 * extracting `assertBridgeMutation` into `bridge-mutation.ts` so `write.ts`
 * no longer needs `ddic-bridge.ts` at all. This file imports `run.ts` FIRST,
 * before anything else from `src/adt`, so a reintroduced cycle would fail it
 * the same way it failed before the fix.
 *
 * The dist case spawns a plain `node` child process to do the dynamic
 * import: Vitest's module runner linearises the cycle differently from real
 * Node ESM and never hits the TDZ, so importing through Vitest's loader
 * would not reproduce the failure.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { BRIDGE_PACKAGE } from "../src/adt/run.js";

describe("fluid import cycle — run.ts as entry", () => {
  it("importing run.ts first, at the source level, does not throw a TDZ error", () => {
    expect(typeof BRIDGE_PACKAGE).toBe("string");
    expect(BRIDGE_PACKAGE.length).toBeGreaterThan(0);
  });

  it("the compiled dist entry point reproduces the historical failure mode if the cycle returns", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const distRun = path.join(here, "..", "dist", "adt", "run.js");
    if (!existsSync(distRun)) {
      // No build present (e.g. a fresh checkout before `npm run build`) — the
      // source-level test above is the only guard that can run right now.
      return;
    }
    const distRunUrl = pathToFileURL(distRun).href;
    const script = `import(${JSON.stringify(distRunUrl)}).then(m => { process.stdout.write(String(typeof m.BRIDGE_PACKAGE)); }).catch(e => { console.error(e.stack); process.exit(1); });`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("string");
  });

  it("entering the graph at dist/adt/fluid/package.js resolves BRIDGE_PACKAGE and ENH_BRIDGE_PACKAGE as live re-exports, not TDZ-undefined aliases", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const distPackage = path.join(here, "..", "dist", "adt", "fluid", "package.js");
    if (!existsSync(distPackage)) return;
    const distPackageUrl = pathToFileURL(distPackage).href;
    const distRunUrl = pathToFileURL(path.join(here, "..", "dist", "adt", "run.js")).href;
    const distEnhUrl = pathToFileURL(path.join(here, "..", "dist", "adt", "enhancement-bridge.js")).href;
    const script =
      `import(${JSON.stringify(distPackageUrl)})` +
      `.then((pkg) => Promise.all([pkg, import(${JSON.stringify(distRunUrl)}), import(${JSON.stringify(distEnhUrl)})]))` +
      `.then(([pkg, run, enh]) => { process.stdout.write(JSON.stringify({ fluid: pkg.FLUID_PACKAGE, bridge: run.BRIDGE_PACKAGE, enhBridge: enh.ENH_BRIDGE_PACKAGE })); })` +
      `.catch((e) => { console.error(e.stack); process.exit(1); });`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      fluid: "$ABAPSMITH_FLUID_API",
      bridge: "$ABAPSMITH_FLUID_API",
      enhBridge: "$ABAPSMITH_FLUID_API",
    });
  });

  it("entering the graph at dist/adt/enhancement-bridge.js resolves ENH_BRIDGE_PACKAGE", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const distEnh = path.join(here, "..", "dist", "adt", "enhancement-bridge.js");
    if (!existsSync(distEnh)) return;
    const distEnhUrl = pathToFileURL(distEnh).href;
    const script = `import(${JSON.stringify(distEnhUrl)}).then(m => { process.stdout.write(JSON.stringify({ enhBridge: m.ENH_BRIDGE_PACKAGE })); }).catch(e => { console.error(e.stack); process.exit(1); });`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ enhBridge: "$ABAPSMITH_FLUID_API" });
  });
});
