import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readFluidRegistry,
  recordManifest,
  forgetManifest,
  fluidRegistryPath,
  type FluidRegistryConfig,
  type FluidRegistryEntry,
} from "../src/adt/fluid/registry.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "abapsmith-fluid-registry-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const cfg = (): FluidRegistryConfig => ({
  sid: "A4H",
  stateDir: dir,
});

const entry = (overrides: Partial<FluidRegistryEntry> = {}): FluidRegistryEntry => ({
  toolId: "zcl_widget_reader",
  contract: "1.0",
  version: "abc123",
  objects: ["ZCL_ZMCP_WIDGET_READER"],
  deployedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const SYS_A = "A4H|http://sap.invalid:50000|001";
const SYS_B = "A4H|http://other.invalid:50000|002";

describe("readFluidRegistry", () => {
  it("returns an empty map and creates no file when nothing was ever written", async () => {
    const c = cfg();
    const result = await readFluidRegistry(c, SYS_A);
    expect(result.size).toBe(0);
    await expect(readFile(fluidRegistryPath(c), "utf8")).rejects.toThrow();
  });
});

describe("recordManifest / readFluidRegistry round trip", () => {
  it("round-trips every field of the entry exactly", async () => {
    const c = cfg();
    const e = entry();
    await recordManifest(c, SYS_A, e);
    const result = await readFluidRegistry(c, SYS_A);
    expect(result.size).toBe(1);
    expect(result.get(e.toolId)).toEqual(e);
  });

  it("keeps two different toolIds side by side", async () => {
    const c = cfg();
    const first = entry({ toolId: "tool-one" });
    const second = entry({ toolId: "tool-two", version: "def456" });
    await recordManifest(c, SYS_A, first);
    await recordManifest(c, SYS_A, second);
    const result = await readFluidRegistry(c, SYS_A);
    expect(result.size).toBe(2);
    expect(result.get("tool-one")).toEqual(first);
    expect(result.get("tool-two")).toEqual(second);
  });

  it("replaces an entry recorded twice under the same toolId", async () => {
    const c = cfg();
    await recordManifest(c, SYS_A, entry({ version: "v1" }));
    await recordManifest(c, SYS_A, entry({ version: "v2" }));
    const result = await readFluidRegistry(c, SYS_A);
    expect(result.size).toBe(1);
    expect(result.get("zcl_widget_reader")?.version).toBe("v2");
  });
});

describe("forgetManifest", () => {
  it("removes only the named tool and leaves its siblings", async () => {
    const c = cfg();
    await recordManifest(c, SYS_A, entry({ toolId: "keep-me" }));
    await recordManifest(c, SYS_A, entry({ toolId: "drop-me" }));
    await forgetManifest(c, SYS_A, "drop-me");
    const result = await readFluidRegistry(c, SYS_A);
    expect(result.size).toBe(1);
    expect(result.has("keep-me")).toBe(true);
    expect(result.has("drop-me")).toBe(false);
  });

  it("is a no-op for a tool that was never recorded", async () => {
    const c = cfg();
    await recordManifest(c, SYS_A, entry({ toolId: "keep-me" }));
    await expect(forgetManifest(c, SYS_A, "never-existed")).resolves.toBeUndefined();
    const result = await readFluidRegistry(c, SYS_A);
    expect(result.size).toBe(1);
    expect(result.has("keep-me")).toBe(true);
  });
});

describe("systemKey isolation", () => {
  it("does not let two different systemKeys see each other's entries", async () => {
    const c = cfg();
    await recordManifest(c, SYS_A, entry({ toolId: "only-in-a" }));
    await recordManifest(c, SYS_B, entry({ toolId: "only-in-b" }));

    const resultA = await readFluidRegistry(c, SYS_A);
    const resultB = await readFluidRegistry(c, SYS_B);

    expect(resultA.size).toBe(1);
    expect(resultA.has("only-in-a")).toBe(true);
    expect(resultA.has("only-in-b")).toBe(false);

    expect(resultB.size).toBe(1);
    expect(resultB.has("only-in-b")).toBe(true);
    expect(resultB.has("only-in-a")).toBe(false);
  });
});

describe("corruption handling", () => {
  it("degrades a corrupt file to an empty map, then replaces it on next write", async () => {
    const c = cfg();
    const registryPath = fluidRegistryPath(c);
    await mkdir(join(registryPath, ".."), { recursive: true });
    await writeFile(registryPath, "{ not json");

    const first = await readFluidRegistry(c, SYS_A);
    expect(first.size).toBe(0);

    await recordManifest(c, SYS_A, entry());
    const second = await readFluidRegistry(c, SYS_A);
    expect(second.size).toBe(1);
    expect(second.get("zcl_widget_reader")).toEqual(entry());

    const raw = await readFile(registryPath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("treats a wrong schema version as a miss", async () => {
    const c = cfg();
    const registryPath = fluidRegistryPath(c);
    await mkdir(join(registryPath, ".."), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({ version: 999, systems: { [SYS_A]: { x: entry() } } }),
    );
    const result = await readFluidRegistry(c, SYS_A);
    expect(result.size).toBe(0);
  });

  it("drops a malformed individual entry and keeps its valid sibling", async () => {
    const c = cfg();
    const registryPath = fluidRegistryPath(c);
    await mkdir(join(registryPath, ".."), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        systems: {
          [SYS_A]: {
            good: entry({ toolId: "good" }),
            bad: { ...entry({ toolId: "bad" }), objects: "not-an-array" },
          },
        },
      }),
    );
    const result = await readFluidRegistry(c, SYS_A);
    expect(result.size).toBe(1);
    expect(result.has("good")).toBe(true);
    expect(result.has("bad")).toBe(false);
  });
});

describe("write failure resilience", () => {
  it("does not reject when the registry's parent directory cannot be created", async () => {
    const c = cfg();
    const registryPath = fluidRegistryPath(c);
    // A plain file sitting where the SID directory must go: mkdir(dirname)
    // inside the lock/write path fails, exercising the write-failure swallow.
    await mkdir(join(registryPath, "..", ".."), { recursive: true });
    await writeFile(join(registryPath, ".."), "not a directory");

    await expect(recordManifest(c, SYS_A, entry())).resolves.toBeUndefined();
    await expect(forgetManifest(c, SYS_A, entry().toolId)).resolves.toBeUndefined();
    await expect(readFluidRegistry(c, SYS_A)).resolves.toEqual(new Map());
  });
});

describe("state directory removal", () => {
  it("yields an empty map with no throw when the whole state directory is deleted", async () => {
    const c = cfg();
    await recordManifest(c, SYS_A, entry());
    await rm(dir, { recursive: true, force: true });
    await expect(readFluidRegistry(c, SYS_A)).resolves.toEqual(new Map());
  });
});

describe("on-disk shape", () => {
  it("lives at the documented path with the documented top-level shape", async () => {
    const c = cfg();
    await recordManifest(c, SYS_A, entry());
    const registryPath = fluidRegistryPath(c);
    expect(registryPath).toBe(join(dir, "fluid", "A4H", "registry.json"));

    const raw = await readFile(registryPath, "utf8");
    const parsed = JSON.parse(raw) as { version: number; systems: Record<string, unknown> };
    expect(parsed.version).toBe(1);
    expect(parsed.systems[SYS_A]).toEqual({ zcl_widget_reader: entry() });
  });
});
