// Append-only barrel: imports and one array, entries sorted by tool id. Later
// slices append their own entries; keep it trivial so concurrent appends merge.

import { fluidRuntimeManifest, fluidRuntimeSources } from "../abap/runtime.js";
import type { FluidManifest } from "../manifest.js";
import { authtraceManifest, authtraceSources } from "./authtrace.js";
import { classicManifest, classicSources } from "./classic.js";
import { coreManifest, coreSources } from "./core.js";
import { enhManifest, enhSources } from "./enh.js";
import { fpmManifest, fpmSources } from "./fpm.js";
import { imgManifest, imgSources } from "./img.js";
import { logManifest, logSources } from "./log.js";
import { runManifest, runSources } from "./run.js";
import { scanManifest, scanSources } from "./scan.js";
import { uiManifest, uiSources } from "./ui.js";

export interface BuiltinFluidTool {
  readonly manifest: FluidManifest;
  readonly sources: ReadonlyMap<string, string>;
}

export const BUILTIN_FLUID_TOOLS: readonly BuiltinFluidTool[] = [
  { manifest: authtraceManifest, sources: authtraceSources },
  { manifest: classicManifest, sources: classicSources },
  { manifest: coreManifest, sources: coreSources },
  { manifest: enhManifest, sources: enhSources },
  { manifest: fpmManifest, sources: fpmSources },
  { manifest: imgManifest, sources: imgSources },
  { manifest: logManifest, sources: logSources },
  { manifest: fluidRuntimeManifest, sources: fluidRuntimeSources },
  { manifest: runManifest, sources: runSources },
  { manifest: scanManifest, sources: scanSources },
  { manifest: uiManifest, sources: uiSources },
];
