// Append-only barrel: imports and one array, entries sorted by tool id. Later
// slices append their own entries; keep it trivial so concurrent appends merge.

import { fluidRuntimeManifest, fluidRuntimeSources } from "../abap/runtime.js";
import type { FluidManifest } from "../manifest.js";

export interface BuiltinFluidTool {
  readonly manifest: FluidManifest;
  readonly sources: ReadonlyMap<string, string>;
}

export const BUILTIN_FLUID_TOOLS: readonly BuiltinFluidTool[] = [
  { manifest: fluidRuntimeManifest, sources: fluidRuntimeSources },
];
