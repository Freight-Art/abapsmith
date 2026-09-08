// Append-only barrel: imports and one array, entries sorted by tool id. Later
// slices append their own entries; keep it trivial so concurrent appends merge.

import { fluidRuntimeManifest, fluidRuntimeSources } from "../abap/runtime.js";
import type { FluidManifest } from "../manifest.js";
import { imgManifest, imgSources } from "./img.js";
import { runManifest, runSources } from "./run.js";

export interface BuiltinFluidTool {
  readonly manifest: FluidManifest;
  readonly sources: ReadonlyMap<string, string>;
}

export const BUILTIN_FLUID_TOOLS: readonly BuiltinFluidTool[] = [
  { manifest: imgManifest, sources: imgSources },
  { manifest: fluidRuntimeManifest, sources: fluidRuntimeSources },
  { manifest: runManifest, sources: runSources },
];
