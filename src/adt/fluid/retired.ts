/**
 * Before the fluid API existed, abapsmith installed one throwaway bridge
 * class per DDIC/CTS operation into `$TMP`, and one IMG write-probe class
 * into the old helper package. Three later families were retired after
 * `FLUID_PACKAGE` already existed and so were never in a legacy package at
 * all: the IMG write-apply class, the customizing-request-creation class,
 * and the five fixed-name enhancement create-family bridges. Every family
 * here is now served by the built-in `classic`, `img` and `enh` fluid tools,
 * so the classes below are dead code sitting in customer systems.
 *
 * Only FIXED names belong here. The per-call bridges whose names are a
 * content hash of their target (`abap_fpm_read` find/outline/app,
 * `abap_ui screen`) cannot be listed statically and are swept by
 * `./dynamic-bridges.ts` and `abap_fluid remove` with `scope:"dynamic"`
 * instead — a listing, not a name list. `ZCL_ZMCP_ENH_EXEC` is fixed-name
 * but is deliberately NOT here: `abap_enh exercise` still generates it, so
 * it is live, not retired.
 *
 * This list is static and closed: abapsmith never discovers retired classes
 * by scanning a package, because a `ZCL_ZMCP_`-prefixed class it did not
 * write must never be deleted. `probeRetiredBridges` and
 * `reapRetiredBridges` only ever look at these seventeen names.
 */
import type { AbapConnection } from "../connection.js";
import type { SafetyGate } from "../../safety.js";
import { isAbapError, describeUnknownError } from "../errors.js";
import { resolveWriteTarget } from "../write.js";
import { LEGACY_FLUID_PACKAGES, FLUID_PACKAGE } from "./package.js";
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
  /**
   * The package this class was installed into. A LEGACY_FLUID_PACKAGES entry
   * for the ten oldest; the seven retired since `FLUID_PACKAGE` existed (the
   * IMG write-apply and customizing-request-creation bridges, and the five
   * enhancement create-family bridges) were deployed into `FLUID_PACKAGE`
   * itself. `probeRetiredBridges` treats a class found in either as
   * legitimately abapsmith's own.
   */
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
  { name: "ZCL_ZMCP_IMG_WAPPLY", type: "CLAS/OC", packageName: FLUID_PACKAGE, supersededBy: "img" },
  { name: "ZCL_ZMCP_CTS_WREQ", type: "CLAS/OC", packageName: FLUID_PACKAGE, supersededBy: "img" },
  // The five fixed-name bridges `abap_enh`'s create family generated before it moved onto
  // `ZCL_ZMCP_FLUID_ENH`. Their names are `enhancement-bridge.ts`'s own former `BRIDGE_CLASS` map,
  // which now retains only its `exercise` entry; that entry is absent here on purpose, because
  // `exercise` never moved and still generates the class every call.
  { name: "ZCL_ZMCP_ENH_CSPOT", type: "CLAS/OC", packageName: FLUID_PACKAGE, supersededBy: "enh" },
  { name: "ZCL_ZMCP_ENH_ADEF", type: "CLAS/OC", packageName: FLUID_PACKAGE, supersededBy: "enh" },
  { name: "ZCL_ZMCP_ENH_FDEF", type: "CLAS/OC", packageName: FLUID_PACKAGE, supersededBy: "enh" },
  { name: "ZCL_ZMCP_ENH_CIMPL", type: "CLAS/OC", packageName: FLUID_PACKAGE, supersededBy: "enh" },
  { name: "ZCL_ZMCP_ENH_FVAL", type: "CLAS/OC", packageName: FLUID_PACKAGE, supersededBy: "enh" },
];

// Classification widened beyond LEGACY_FLUID_PACKAGES itself (which stays closed — pinned by
// test/legacy-helper-package-retired.test.ts and package.ts's own doc comment) to also recognize
// FLUID_PACKAGE: the seven ZCL_ZMCP_IMG_WAPPLY/ZCL_ZMCP_CTS_WREQ/ZCL_ZMCP_ENH_* entries above were
// deployed there, not into a legacy package, so a class found there is exactly as much
// "abapsmith's own leftover" as one found in $TMP or the old helper package.
const OWN_FLUID_PACKAGES = [...LEGACY_FLUID_PACKAGES, FLUID_PACKAGE].map((p) => p.toUpperCase());

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
      // Compared against OWN_FLUID_PACKAGES as a whole, not against this
      // entry's own packageName: a class installed into $TMP on one system,
      // into the old helper package on another, or into FLUID_PACKAGE itself
      // (ZCL_ZMCP_IMG_WAPPLY/ZCL_ZMCP_CTS_WREQ's real home) is still
      // abapsmith's own leftover either way.
      const pkgNormalized = resolved.packageName.trim().toUpperCase();
      if (OWN_FLUID_PACKAGES.includes(pkgNormalized)) {
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
 * One short lease per unit of work, handed a live `AbapConnection` to use
 * for exactly that `fn`. Real callers pass `(op, fn) => pool.withWrite(op,
 * undefined, fn)`: every lease gets its own pool slot (a fresh logon-endpoint
 * ceiling, `AdtSessionPool`'s per-slot `AbapConnection`), and a `SESSION_DEAD`
 * inside `fn` is the pool's own concern — it retires the dead slot and
 * replays `fn` once on a freshly minted one.
 */
export type FluidLease = <T>(op: string, fn: (conn: AbapConnection) => Promise<T>) => Promise<T>;

/**
 * Deletes every retired bridge class this probe finds `"present"`.
 *
 * Probes everything up front, before any delete: a delete kills the ADT
 * session, so probing after one would need a revive of its own, and doing
 * all reads first avoids that entirely. The probe runs in one lease; every
 * delete runs in its own — a delete kills the ADT session, and reviving a
 * connection to keep deleting on it is exactly what pushed the fixed
 * `AbapConnection` logon-endpoint ceiling past ten deletes. Taking one lease
 * per delete instead means each delete gets a connection that has never been
 * revived, and the pool's own dead-slot replay covers the rest.
 */
export async function reapRetiredBridges(
  gate: SafetyGate,
  lease: FluidLease,
): Promise<readonly RetiredBridgeReap[]> {
  const probes = await lease("abap_fluid.repair.probe", (conn) => probeRetiredBridges(conn));

  const results: RetiredBridgeReap[] = [];
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
      const del = await lease("abap_fluid.repair.delete", (conn) =>
        deleteOneFluidObject(conn, gate, { type: "CLAS/OC", name: probe.name }, false),
      );
      results.push({ name: probe.name, outcome: del.deleted === false ? "failed" : "deleted" });
    } catch (e) {
      if (isAbapError(e) && e.code === "NOT_FOUND") {
        results.push({ name: probe.name, outcome: "already-absent" });
      } else {
        results.push({ name: probe.name, outcome: "failed", error: describeUnknownError(e) });
      }
    }
  }
  return results;
}
