/**
 * The one local package the fluid API deploys its own generated objects
 * into. Distinct from `HELPER_PACKAGE` (`$ZMCP_HELPERS`, `src/adt/helper-package.ts`),
 * which the older bridge families still use. Created on first use, never
 * assumed to exist.
 */

import type { AbapConnection } from "../connection.js";
import type { SafetyGate } from "../../safety.js";
import { systemKey } from "../../journal.js";
import { authorizeMutation, createPackage, NO_JOURNAL } from "../write.js";

/** `$`-prefixed, so it is local by construction — `isSapPackage` and the transport allowlist both key off that prefix, not the literal name. */
export const FLUID_PACKAGE = "$ABAPSMITH_FLUID_API";

/** `SCOMPKDTLN-CTEXT` (CHAR60) for {@link FLUID_PACKAGE} when it is created. */
export const FLUID_PACKAGE_DESCRIPTION = "abapsmith fluid API generated objects";

/** Older packages fluid-generated objects may still live in, from before {@link FLUID_PACKAGE} existed. */
export const LEGACY_FLUID_PACKAGES: readonly string[] = ["$ZMCP_HELPERS", "$TMP"];

/** Object-name prefixes reserved for fluid-generated objects. */
export const RESERVED_OBJECT_PREFIXES: readonly string[] = ["ZCL_ZMCP_", "ZIF_ZMCP_"];

/**
 * One half of the relocation condition: an object is only ever relocated
 * (deleted from its old package and recreated in {@link FLUID_PACKAGE}) when
 * it is BOTH under a reserved prefix AND in one of {@link LEGACY_FLUID_PACKAGES}.
 */
export function isReservedFluidName(name: string): boolean {
  const n = name.trim().toUpperCase();
  return RESERVED_OBJECT_PREFIXES.some((prefix) => n.startsWith(prefix));
}

const memo = new Map<string, Promise<void>>();

async function createFluidPackage(conn: AbapConnection, gate: SafetyGate): Promise<void> {
  const authorized = await authorizeMutation(conn, gate, "write", {
    type: "DEVC/K",
    name: FLUID_PACKAGE,
    description: FLUID_PACKAGE_DESCRIPTION,
    packageName: "$TMP",
  });

  if (authorized.target.exists) return;

  await createPackage(conn, authorized, {
    softwareComponent: "LOCAL",
    // NO_JOURNAL: abapsmith's own generated scaffolding, not user content — same idiom as ensureHelperPackage/deployBridge.
    onBeforeImage: NO_JOURNAL,
  });
}

/**
 * Create {@link FLUID_PACKAGE} on first use, or confirm it already exists.
 * Memoized per process per system: concurrent callers on the same system
 * share one in-flight round trip, and a rejected attempt is dropped from the
 * memo (not cached as permanent) so the next call retries for real.
 */
export function ensureFluidPackage(conn: AbapConnection, gate: SafetyGate): Promise<void> {
  const key = systemKey(conn.cfg);
  const existing = memo.get(key);
  if (existing) return existing;

  const attempt = createFluidPackage(conn, gate);
  memo.set(key, attempt);
  attempt.catch(() => {
    memo.delete(key);
  });
  return attempt;
}

/** Test seam: clears the per-process memo so the next `ensureFluidPackage` call re-probes. */
export function resetFluidPackageMemo(): void {
  memo.clear();
}
