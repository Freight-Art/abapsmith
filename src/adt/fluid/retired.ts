/**
 * Before the fluid API existed, abapsmith installed one throwaway bridge
 * class per DDIC/CTS operation into `$TMP`, plus one IMG write-probe class
 * into the old helper package. Those families are now served by the
 * built-in `classic` and `img` fluid tools out of `$ABAPSMITH_FLUID_API`, so
 * the classes below are dead code sitting in customer systems.
 *
 * This list is static and closed: abapsmith never discovers retired classes
 * by scanning a package, because a `ZCL_ZMCP_`-prefixed class it did not
 * write must never be deleted. `probeRetiredBridges` and
 * `reapRetiredBridges` only ever look at these ten names.
 */
import type { AbapConnection } from "../connection.js";
import type { SafetyGate } from "../../safety.js";
import { isAbapError, describeUnknownError } from "../errors.js";
import { resolveWriteTarget } from "../write.js";
import { LEGACY_FLUID_PACKAGES } from "./package.js";
import { deleteOneFluidObject } from "./delete.js";

const TMP_PACKAGE = "$TMP";
// The other LEGACY_FLUID_PACKAGES entry — the retired helper package, whose
// literal name is pinned to package.ts by test/legacy-helper-package-retired.test.ts.
const LEGACY_HELPER_PACKAGE = LEGACY_FLUID_PACKAGES.find((p) => p !== TMP_PACKAGE);
if (LEGACY_HELPER_PACKAGE === undefined) {
  throw new Error("LEGACY_FLUID_PACKAGES no longer names the retired helper package");
}

export interface RetiredBridgeClass {
  readonly name: string;
  readonly type: "CLAS/OC";
  /** The legacy package this class was installed into. Always a LEGACY_FLUID_PACKAGES entry. */
  readonly packageName: string;
  /** The built-in fluid tool that replaced it. */
  readonly supersededBy: string;
}

export const RETIRED_BRIDGE_CLASSES: readonly RetiredBridgeClass[] = [
  { name: "ZCL_ZMCP_DDIC_CVIEW", type: "CLAS/OC", packageName: TMP_PACKAGE, supersededBy: "classic" },
  { name: "ZCL_ZMCP_DDIC_DVIEW", type: "CLAS/OC", packageName: TMP_PACKAGE, supersededBy: "classic" },
  { name: "ZCL_ZMCP_DDIC_CTRAN", type: "CLAS/OC", packageName: TMP_PACKAGE, supersededBy: "classic" },
  { name: "ZCL_ZMCP_DDIC_DTRAN", type: "CLAS/OC", packageName: TMP_PACKAGE, supersededBy: "classic" },
  { name: "ZCL_ZMCP_DDIC_CINDX", type: "CLAS/OC", packageName: TMP_PACKAGE, supersededBy: "classic" },
  { name: "ZCL_ZMCP_DDIC_DINDX", type: "CLAS/OC", packageName: TMP_PACKAGE, supersededBy: "classic" },
  { name: "ZCL_ZMCP_DDIC_CPKG", type: "CLAS/OC", packageName: TMP_PACKAGE, supersededBy: "classic" },
  { name: "ZCL_ZMCP_DDIC_DPKG", type: "CLAS/OC", packageName: TMP_PACKAGE, supersededBy: "classic" },
  { name: "ZCL_ZMCP_DDIC_TREN", type: "CLAS/OC", packageName: TMP_PACKAGE, supersededBy: "classic" },
  { name: "ZCL_ZMCP_IMG_WPROBE", type: "CLAS/OC", packageName: LEGACY_HELPER_PACKAGE, supersededBy: "img" },
];

export type RetiredBridgeState = "present" | "absent" | "moved" | "unknown";

export interface RetiredBridgeProbe {
  readonly name: string;
  readonly expectedPackage: string;
  readonly supersededBy: string;
  readonly state: RetiredBridgeState;
  /** The package the server actually reported, when it differs or is worth showing. */
  readonly foundIn?: string;
  /** Set only for state "unknown". */
  readonly error?: string;
}

/**
 * Read-only, never throws: one unreadable name must not blind the whole
 * probe, so a resolve failure is reported as `"unknown"` on that entry
 * rather than aborting the loop.
 */
export async function probeRetiredBridges(conn: AbapConnection): Promise<readonly RetiredBridgeProbe[]> {
  const probes: RetiredBridgeProbe[] = [];
  for (const entry of RETIRED_BRIDGE_CLASSES) {
    const base = { name: entry.name, expectedPackage: entry.packageName, supersededBy: entry.supersededBy };
    try {
      const resolved = await resolveWriteTarget(conn, { type: entry.type, name: entry.name }, "delete");
      if (!resolved.exists) {
        probes.push({ ...base, state: "absent" });
        continue;
      }
      // Compared against LEGACY_FLUID_PACKAGES as a whole, not against this
      // entry's own packageName: a class installed into $TMP on one system
      // and into the old helper package on another is still abapsmith's own
      // leftover either way.
      const pkgNormalized = resolved.packageName.trim().toUpperCase();
      if (LEGACY_FLUID_PACKAGES.includes(pkgNormalized)) {
        probes.push({ ...base, state: "present", foundIn: resolved.packageName });
      } else {
        // Relocated into a package abapsmith does not own — reported and
        // never deleted, same rule as "foreign" in classifyFluidTool.
        probes.push({ ...base, state: "moved", foundIn: resolved.packageName });
      }
    } catch (e) {
      probes.push({ ...base, state: "unknown", error: describeUnknownError(e) });
    }
  }
  return probes;
}

export interface RetiredBridgeReap {
  readonly name: string;
  readonly outcome: "deleted" | "already-absent" | "left-alone" | "unknown" | "failed";
  readonly foundIn?: string;
  readonly error?: string;
}

/**
 * Deletes every retired bridge class this probe finds `"present"`.
 *
 * Probes everything up front, before any delete: a delete kills the ADT
 * session, so probing after one would need a revive of its own, and doing
 * all reads first avoids that entirely.
 */
export async function reapRetiredBridges(
  conn: AbapConnection,
  gate: SafetyGate,
): Promise<readonly RetiredBridgeReap[]> {
  const probes = await probeRetiredBridges(conn);

  const results: RetiredBridgeReap[] = [];
  let reviveOnDeadSession = false;
  for (const probe of probes) {
    if (probe.state === "absent") {
      results.push({ name: probe.name, outcome: "already-absent" });
      continue;
    }
    if (probe.state === "moved") {
      results.push({ name: probe.name, outcome: "left-alone", foundIn: probe.foundIn });
      continue;
    }
    if (probe.state === "unknown") {
      results.push({ name: probe.name, outcome: "unknown", error: probe.error });
      continue;
    }

    try {
      const del = await deleteOneFluidObject(conn, gate, { type: "CLAS/OC", name: probe.name }, reviveOnDeadSession);
      reviveOnDeadSession = true; // a delete just happened; the NEXT request on this session may hit SESSION_DEAD
      results.push({ name: probe.name, outcome: del.deleted === false ? "failed" : "deleted" });
    } catch (e) {
      if (isAbapError(e) && e.code === "NOT_FOUND") {
        results.push({ name: probe.name, outcome: "already-absent" });
      } else {
        results.push({ name: probe.name, outcome: "failed", error: describeUnknownError(e) });
      }
      reviveOnDeadSession = false; // no delete was actually sent — nothing to revive from
    }
  }
  return results;
}
