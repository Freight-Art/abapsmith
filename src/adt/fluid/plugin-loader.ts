/**
 * Discovers, validates and loads fluid plugins from `cfg.fluidPlugins` —
 * the only place operator-authored ABAP crosses from disk into a
 * `LoadedFluidTool`. Pure filesystem and `manifest.ts` schema work: no
 * network, no `AbapConnection`, called once at startup and never during a
 * request, so a plugin can never appear mid-session. Built-ins are passed
 * in structurally (`FluidBuiltinSource`), never imported from a barrel,
 * so this module stays ignorant of what abapsmith ships.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Config } from "../../config.js";
import {
  FLUID_CONTRACT,
  FLUID_CONTRACT_MAJOR,
  FluidManifestSchema,
  manifestVersion,
  type FluidManifest,
  type LoadedFluidTool,
} from "./manifest.js";
import { reviewFluidAbap } from "./static-review.js";

export interface RefusedFluidPlugin {
  readonly path: string;
  readonly id?: string;
  readonly code: "FLUID_MANIFEST_INVALID" | "FLUID_PLUGINS_DISABLED";
  readonly reason: string;
}

export interface FluidToolSet {
  readonly tools: ReadonlyMap<string, LoadedFluidTool>;
  readonly refused: readonly RefusedFluidPlugin[];
  readonly warnings: readonly string[];
}

/** Everything the loader reads. A full `Config` satisfies it. */
export type FluidLoaderConfig = Pick<Config, "fluidPlugins" | "allowFluidPlugins">;

/** A built-in tool as authored in TypeScript, before it is versioned. */
export interface FluidBuiltinSource {
  readonly manifest: FluidManifest;
  readonly sources: ReadonlyMap<string, string>;
}

const MANIFEST_FILE = "fluid-plugin.json";

function namespaceRe(pluginId: string): RegExp {
  const id = pluginId.toUpperCase();
  return new RegExp(`^(ZCL_ZMCP_X_${id}(_[A-Z0-9_]+)?|ZIF_ZMCP_X_${id})$`, "i");
}

// Resolved to a real path here, once, so every downstream refusal and
// every loaded tool's `dir` names the same path regardless of whether the
// configured root reached it through a symlinked child.
async function listPluginDirs(root: string): Promise<{ dirs: string[] } | { error: string }> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const names = entries.map((e) => e.name).sort();
  const dirs: string[] = [];
  for (const name of names) {
    const candidate = path.join(root, name);
    let real: string;
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isDirectory()) continue;
      real = await fs.realpath(candidate);
    } catch {
      continue;
    }
    try {
      await fs.access(path.join(real, MANIFEST_FILE));
      dirs.push(real);
    } catch {
      // no fluid-plugin.json: not a plugin directory, not reported at all.
    }
  }
  return { dirs };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface PluginLoadResult {
  readonly tool?: LoadedFluidTool;
  readonly refusal?: RefusedFluidPlugin;
  readonly warning?: string;
}

async function loadPlugin(dir: string, knownIds: ReadonlySet<string>): Promise<PluginLoadResult> {
  const refuse = (reason: string, id?: string): PluginLoadResult => ({
    refusal: { path: dir, id, code: "FLUID_MANIFEST_INVALID", reason },
  });

  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, MANIFEST_FILE), "utf8");
  } catch (err) {
    return refuse(`cannot read ${MANIFEST_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return refuse(`${MANIFEST_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  // superRefine on FluidManifestSchema already covers duplicate object
  // names, entry-in-objects, and every action's input/output schema — the
  // documented steps 6 and 8 are subsumed here, not reimplemented below.
  const result = FluidManifestSchema.safeParse(parsed);
  if (!result.success) {
    const declaredId = isPlainObject(parsed) && typeof parsed["id"] === "string" ? parsed["id"] : undefined;
    return refuse(
      `${MANIFEST_FILE} failed schema validation: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      declaredId,
    );
  }
  const manifest = result.data;
  const id = manifest.id;

  const [major, minor] = manifest.contract.split(".").map(Number);
  if (major !== FLUID_CONTRACT_MAJOR) {
    return refuse(`unknown contract major "${manifest.contract}" (this build supports ${FLUID_CONTRACT_MAJOR}.x)`, id);
  }
  let warning: string | undefined;
  const [, expectedMinor] = FLUID_CONTRACT.split(".").map(Number);
  if (minor !== expectedMinor) {
    warning = `plugin "${id}" declares contract ${manifest.contract}, this build ships ${FLUID_CONTRACT}`;
  }

  if (knownIds.has(id)) {
    return refuse(`id "${id}" collides with an already-loaded tool of the same id`, id);
  }

  const ns = namespaceRe(id);
  for (const obj of manifest.objects) {
    if (!ns.test(obj.name)) {
      return refuse(
        `object "${obj.name}" is outside this plugin's own namespace (expected ZCL_ZMCP_X_${id.toUpperCase()}[_SUFFIX] or ZIF_ZMCP_X_${id.toUpperCase()})`,
        id,
      );
    }
  }

  // `dir` is already a real path — resolved once, at discovery time, in
  // listPluginDirs — so no further realpath call is needed for it here.
  const sources = new Map<string, string>();
  for (const obj of manifest.objects) {
    if ("text" in obj.source) {
      return refuse(`object "${obj.name}" uses {"text": ...}, which is reserved for built-ins; a plugin must use {"file": ...}`, id);
    }
    const file = obj.source.file;
    if (path.isAbsolute(file)) {
      return refuse(`object "${obj.name}" source.file "${file}" is an absolute path, which is refused`, id);
    }
    if (file.split(/[/\\]/).includes("..")) {
      return refuse(`object "${obj.name}" source.file "${file}" contains a ".." segment, which is refused`, id);
    }
    const candidate = path.resolve(dir, file);
    let realCandidate: string;
    try {
      realCandidate = await fs.realpath(candidate);
    } catch (err) {
      return refuse(`object "${obj.name}" source.file "${file}" cannot be resolved: ${err instanceof Error ? err.message : String(err)}`, id);
    }
    const relFromDir = path.relative(dir, realCandidate);
    if (relFromDir.startsWith("..") || path.isAbsolute(relFromDir)) {
      return refuse(`object "${obj.name}" source.file "${file}" resolves outside the plugin directory`, id);
    }
    let text: string;
    try {
      text = await fs.readFile(realCandidate, "utf8");
    } catch (err) {
      return refuse(`object "${obj.name}" source.file "${file}" could not be read: ${err instanceof Error ? err.message : String(err)}`, id);
    }
    sources.set(obj.name, text);
  }

  for (const obj of manifest.objects) {
    const source = sources.get(obj.name) ?? "";
    const findings = reviewFluidAbap(obj.name, source);
    const first = findings[0];
    if (first !== undefined) {
      return refuse(
        `static review refused object "${first.object}" at line ${first.line}, rule "${first.rule}"`,
        id,
      );
    }
  }

  const tool: LoadedFluidTool = {
    manifest,
    origin: "plugin",
    dir,
    sources,
    version: manifestVersion(manifest, sources),
  };
  return warning !== undefined ? { tool, warning } : { tool };
}

export async function loadFluidTools(
  cfg: FluidLoaderConfig,
  builtins?: readonly FluidBuiltinSource[],
): Promise<FluidToolSet> {
  const tools = new Map<string, LoadedFluidTool>();
  const refused: RefusedFluidPlugin[] = [];
  const warnings: string[] = [];

  for (const builtin of builtins ?? []) {
    tools.set(builtin.manifest.id, {
      manifest: builtin.manifest,
      origin: "builtin",
      sources: builtin.sources,
      version: manifestVersion(builtin.manifest, builtin.sources),
    });
  }

  for (const rawRoot of cfg.fluidPlugins) {
    const root = path.resolve(rawRoot);
    const listed = await listPluginDirs(root);
    if ("error" in listed) {
      // FLUID_MANIFEST_INVALID is not a perfect fit for an unreadable root,
      // but the refusal union is fixed by the loader's contract and this is
      // the only non-disabled code available.
      refused.push({ path: root, code: "FLUID_MANIFEST_INVALID", reason: `cannot read plugin root: ${listed.error}` });
      continue;
    }

    for (const dir of listed.dirs) {
      if (!cfg.allowFluidPlugins) {
        refused.push({ path: dir, code: "FLUID_PLUGINS_DISABLED", reason: "ABAP_ALLOW_FLUID_PLUGINS is off" });
        continue;
      }
      const result = await loadPlugin(dir, new Set(tools.keys()));
      if (result.tool) {
        tools.set(result.tool.manifest.id, result.tool);
        if (result.warning) warnings.push(result.warning);
      } else if (result.refusal) {
        refused.push(result.refusal);
      }
    }
  }

  return { tools, refused, warnings };
}
