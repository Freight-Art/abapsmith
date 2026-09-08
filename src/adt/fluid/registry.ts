/**
 * On-disk cache of what fluid tools were deployed, per SAP system: a hint for
 * "do we need to redeploy this tool", never an authority on what actually
 * exists server-side. A content compare and the wire protocol's own version
 * frame are what actually decide that at run time — this file only saves a
 * round trip on the common case. Deleting the state directory must never be
 * able to corrupt an ABAP system, so every read failure degrades to a cache
 * miss (an empty map) and every write failure is swallowed.
 *
 * Path layout: `<stateDir>/fluid/<safeSegment(sid)>/registry.json`, keyed
 * inside by `systemKey` and then `toolId`. Keying on `systemKey` (not just
 * SID) matters: the same SID reached through two URLs or two clients is two
 * different systems and must not share cache entries.
 */
import * as path from "node:path";
import { readFileSync } from "node:fs";
import type { Config } from "../../config.js";
import { safeSegment } from "../../journal.js";
import { atomicWriteFileSync, hardenFileModeSync, withFileLock } from "../../state-dir.js";

/** Everything the registry reads. A full `Config` satisfies it. */
export type FluidRegistryConfig = Pick<Config, "stateDir" | "sid">;

export interface FluidRegistryEntry {
  readonly toolId: string;
  readonly contract: string;
  readonly version: string;
  readonly objects: readonly string[];
  readonly deployedAt: string;
}

const REGISTRY_VERSION = 1;
const REGISTRY_FILE = "registry.json";

interface RegistryFile {
  version: number;
  systems: Record<string, Record<string, FluidRegistryEntry>>;
}

export function fluidRegistryPath(cfg: FluidRegistryConfig): string {
  return path.join(path.resolve(cfg.stateDir), "fluid", safeSegment(cfg.sid), REGISTRY_FILE);
}

function coerceEntry(value: unknown): FluidRegistryEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const e = value as Partial<FluidRegistryEntry>;
  if (
    typeof e.toolId !== "string" ||
    typeof e.contract !== "string" ||
    typeof e.version !== "string" ||
    typeof e.deployedAt !== "string" ||
    !Array.isArray(e.objects) ||
    !e.objects.every((o) => typeof o === "string")
  ) {
    return undefined;
  }
  return {
    toolId: e.toolId,
    contract: e.contract,
    version: e.version,
    objects: [...e.objects],
    deployedAt: e.deployedAt,
  };
}

function coerceFile(parsed: unknown): RegistryFile | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const raw = parsed as Partial<RegistryFile>;
  if (raw.version !== REGISTRY_VERSION) return undefined;
  if (typeof raw.systems !== "object" || raw.systems === null) return undefined;
  const systems: Record<string, Record<string, FluidRegistryEntry>> = {};
  for (const [sysKey, toolsRaw] of Object.entries(raw.systems as Record<string, unknown>)) {
    if (typeof toolsRaw !== "object" || toolsRaw === null) continue;
    const tools: Record<string, FluidRegistryEntry> = {};
    for (const [toolId, entryRaw] of Object.entries(toolsRaw as Record<string, unknown>)) {
      const entry = coerceEntry(entryRaw);
      if (entry) tools[toolId] = entry;
    }
    systems[sysKey] = tools;
  }
  return { version: REGISTRY_VERSION, systems };
}

// A corrupt or unreadable cache must degrade to a cache miss, not an outage:
// the registry is never the source of truth for what is deployed.
function readRegistryFile(registryPath: string): RegistryFile | undefined {
  try {
    // Best-effort: hardens a file left permissive by a version that wrote it
    // before this call existed. Never lets a chmod failure block a read.
    try {
      hardenFileModeSync(registryPath);
    } catch {
      /* the read below still succeeds or fails on its own merits */
    }
    return coerceFile(JSON.parse(readFileSync(registryPath, "utf8")));
  } catch {
    return undefined;
  }
}

// Async lock, not the sync form: this is written from the MCP stdio hot
// path, and a sync lock would stall the whole event loop for the wait budget
// on every fluid tool call.
async function mutateRegistryFile(registryPath: string, mutate: (file: RegistryFile) => void): Promise<void> {
  await withFileLock(registryPath + ".lock", async () => {
    const current = readRegistryFile(registryPath) ?? { version: REGISTRY_VERSION, systems: {} };
    mutate(current);
    atomicWriteFileSync(registryPath, JSON.stringify(current, null, 2) + "\n");
  });
}

// A read needs no lock (one small readFileSync), so this stays synchronous
// work wrapped in `async` — for its caller and interface, not for any real
// asynchrony here. `recordManifest`/`forgetManifest` below do await for real.

export async function readFluidRegistry(
  cfg: FluidRegistryConfig,
  systemKey: string,
): Promise<ReadonlyMap<string, FluidRegistryEntry>> {
  const file = readRegistryFile(fluidRegistryPath(cfg));
  const tools = file?.systems[systemKey];
  if (!tools) return new Map();
  return new Map(Object.entries(tools));
}

/** Called ONLY after activation has been verified. */
export async function recordManifest(
  cfg: FluidRegistryConfig,
  systemKey: string,
  entry: FluidRegistryEntry,
): Promise<void> {
  try {
    await mutateRegistryFile(fluidRegistryPath(cfg), (file) => {
      const tools = file.systems[systemKey] ?? {};
      tools[entry.toolId] = entry;
      file.systems[systemKey] = tools;
    });
  } catch {
    // A cache that fails to write is a cache miss next time; failing an
    // already-verified, already-activated deployment over it would be worse.
  }
}

export async function forgetManifest(cfg: FluidRegistryConfig, systemKey: string, toolId: string): Promise<void> {
  try {
    await mutateRegistryFile(fluidRegistryPath(cfg), (file) => {
      const tools = file.systems[systemKey];
      if (!tools || tools[toolId] === undefined) return;
      delete tools[toolId];
    });
  } catch {
    // Same rationale as recordManifest: a write failure here must not
    // propagate — worst case the tool is redeployed next time.
  }
}
