/**
 * Five tool paths still deploy one generated ABAP bridge class per call
 * because there is no fixed manifest to run — the ABAP has to be built fresh
 * from the caller's own input every time. They cannot move to the fluid
 * API's manifest+invoker model, so their bridge classes land in
 * `FLUID_PACKAGE` alongside everything else and are otherwise invisible to
 * `abap_fluid status`/`remove`.
 *
 * This list is static and closed, same spirit as `RETIRED_BRIDGE_CLASSES`
 * (`./retired.ts`): abapsmith never invents a new dynamic-bridge family by
 * pattern-guessing a package listing, it only recognizes the five prefixes
 * (four hashed, one a fixed one-name map) each of these modules already
 * commits to in its own bridge-naming code. Unlike `retired.ts`, the
 * listing itself is not a fixed name list — a per-call bridge's suffix is a
 * content hash of its target, so the only way to find them is
 * `conn.adt.nodeContents("DEVC/K", FLUID_PACKAGE)`, the same node listing
 * `listInvokerClasses` (`./invokers.ts`) and `removeTargets`
 * (`../../tools/fluid.ts`) already use.
 */
import type { AbapConnection } from "../connection.js";
import { FLUID_PACKAGE } from "./package.js";
import { INVOKER_NAME_RE } from "./invokers.js";
import { UI_BRIDGE_CLASS_PREFIX } from "../ui-runtime.js";
import { FPM_LOCK_BRIDGE_CLASS_PREFIX } from "../fpm-lock.js";
import { BRIDGE_CLASS_PREFIX as RUN_BRIDGE_CLASS_PREFIX } from "../run.js";
import { BOPF_BRIDGE_CLASS_PREFIX } from "../bopf-runtime.js";
import { BRIDGE_CLASS as ENH_BRIDGE_CLASS } from "../enhancement-bridge.js";

export interface DynamicBridgeFamily {
  readonly label: string;
  /** The tool path (and, where relevant, the mode/operation) whose per-call ABAP this class backs. */
  readonly tool: string;
  /** Set for a hashed-suffix family (BOPF/UI/FPM-lock/run). */
  readonly prefix?: string;
  /** Set for the enhancement family, whose one bridge class is a fixed name, not a hashed prefix. */
  readonly names?: readonly string[];
}

/**
 * Ordered longest-prefix-first so a future family whose prefix happens to be
 * a leading substring of another's can never swallow it; today none of the
 * four prefixes nests inside another, so this ordering is a safety margin,
 * not a currently load-bearing distinction.
 */
export const DYNAMIC_BRIDGE_FAMILIES: readonly DynamicBridgeFamily[] = [
  { label: "BOPF test bridges", tool: "abap_bopf_test", prefix: BOPF_BRIDGE_CLASS_PREFIX },
  { label: "UI press bridges", tool: 'abap_ui (mode: "press")', prefix: UI_BRIDGE_CLASS_PREFIX },
  {
    label: "Enhancement exercise bridges",
    tool: 'abap_enh (operation: "exercise")',
    names: Object.values(ENH_BRIDGE_CLASS),
  },
  { label: "FPM lock-mode bridges", tool: 'abap_fpm_read (mode: "locks")', prefix: FPM_LOCK_BRIDGE_CLASS_PREFIX },
  { label: "Run report bridges", tool: "abap_run (report bridge)", prefix: RUN_BRIDGE_CLASS_PREFIX },
].sort((a, b) => (b.prefix?.length ?? 1000) - (a.prefix?.length ?? 1000));

function familyMatches(family: DynamicBridgeFamily, name: string): boolean {
  if (family.prefix !== undefined && name.startsWith(family.prefix)) return true;
  if (family.names !== undefined && family.names.includes(name)) return true;
  return false;
}

/**
 * `undefined` for anything that is not one of the five families above —
 * most importantly a fluid invoker (`ZCL_ZMCP_I_[0-9A-F]{8}`) or a static
 * fluid body/runtime class (`ZCL_ZMCP_FLUID_*`, e.g. `ZCL_ZMCP_FLUID_CORE`).
 * Neither actually collides with any of the five prefixes/names today, but
 * both are excluded explicitly rather than left to rely on that — a
 * class abapsmith did not generate per-call must never be swept as one.
 */
export function classifyDynamicBridgeName(name: string): DynamicBridgeFamily | undefined {
  const n = name.trim().toUpperCase();
  if (INVOKER_NAME_RE.test(n)) return undefined;
  for (const family of DYNAMIC_BRIDGE_FAMILIES) {
    if (familyMatches(family, n)) return family;
  }
  return undefined;
}

export function isDynamicBridgeName(name: string): boolean {
  return classifyDynamicBridgeName(name) !== undefined;
}

export interface DynamicBridgeClass {
  readonly name: string;
  readonly label: string;
  readonly tool: string;
}

/**
 * `CLAS/OC` members of `FLUID_PACKAGE` that classify into one of the five
 * dynamic-bridge families, minus anything named in `exclude` — the caller
 * passes every loaded fluid tool's own manifest object names (its static
 * body/runtime classes), so a class that is legitimately part of the fluid
 * API's own manifest is never reported as a dynamic bridge even if some
 * future prefix were to overlap. Not wrapped in a try/catch: like
 * `listInvokerClasses`, a `nodeContents` failure propagates to the caller,
 * which degrades its own rendering (see `renderStatus` in
 * `src/tools/fluid.ts`) rather than this module inventing its own error
 * shape.
 */
export async function listDynamicBridges(
  conn: AbapConnection,
  exclude: ReadonlySet<string> = new Set(),
): Promise<readonly DynamicBridgeClass[]> {
  const listed = await conn.adt.nodeContents("DEVC/K", FLUID_PACKAGE);
  const results: DynamicBridgeClass[] = [];
  for (const n of listed.nodes ?? []) {
    const name = n.OBJECT_NAME ?? "";
    const type = n.OBJECT_TYPE ?? "";
    if (!name || type !== "CLAS/OC") continue;
    const upper = name.trim().toUpperCase();
    if (exclude.has(upper)) continue;
    const family = classifyDynamicBridgeName(upper);
    if (!family) continue;
    results.push({ name, label: family.label, tool: family.tool });
  }
  return results;
}
