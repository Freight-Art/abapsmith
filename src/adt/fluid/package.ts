/**
 * The one local package the fluid API deploys its own generated objects
 * into. Distinct from the older bridge families' packages, one of which
 * (`$ZMCP_HELPERS`) still shows up below in {@link LEGACY_FLUID_PACKAGES} —
 * an object a pre-fluid release left there is relocated into this package
 * rather than left behind. Created on first use, never assumed to exist.
 */

import type { AbapConnection } from "../connection.js";
import type { SafetyGate } from "../../safety.js";
import { systemKey } from "../../journal.js";
import { authorizeMutation, createPackage, resolveWriteTarget, NO_JOURNAL } from "../write.js";

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
  // Probe existence BEFORE asking the gate to judge anything. `SafetyGate`'s
  // name-prefix rule (`ABAP_ALLOW_NAME_PREFIXES`) is a rule about what may be
  // CREATED, but `FLUID_PACKAGE` is `$`-prefixed by construction (see its own
  // doc comment) and so never starts with an operator's Z/Y-only allowlist —
  // an operator who sets ABAP_ALLOW_NAME_PREFIXES=Z,Y (a perfectly ordinary
  // setting) would have every cold path here refused even when the package
  // already exists and nothing at all needs creating. A gate judging a name
  // we are not going to write is a false refusal, not a safety property; the
  // unauthorized resolver `resolveWriteTarget` (the same one `ensure.ts`'s
  // `classifyOne` uses) answers "does it exist" for free, with no gate
  // involved, so the common warm case costs nothing and denies nothing.
  const probe = await resolveWriteTarget(conn, { type: "DEVC/K", name: FLUID_PACKAGE }, "write");
  if (probe.exists) return;

  // Only the actual CREATE — the one operation the gate exists to police —
  // is authorized. It still carries the full gate: `authorizeMutation`
  // re-resolves and re-checks `exists` itself (belt-and-braces below) before
  // handing back a mint it alone can produce, so nothing here bypasses the
  // safety check that matters; it only stops applying it to a no-op.
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
