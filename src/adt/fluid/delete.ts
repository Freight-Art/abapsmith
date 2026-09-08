/**
 * The one delete path every fluid caller uses. Lives here rather than in
 * `src/tools/fluid.ts` because the retired-bridge reaper (`./retired.ts`)
 * needs it too, and a second copy would drift from the one-shot revive idiom
 * below.
 */
import type { AbapConnection } from "../connection.js";
import type { SafetyGate } from "../../safety.js";
import { isSessionDeadFailure } from "../write-verify.js";
import { authorizeMutation, deleteObject, NO_JOURNAL } from "../write.js";
import type { FluidObjectType } from "./manifest.js";

export interface FluidDeleteTarget {
  readonly type: FluidObjectType;
  readonly name: string;
}

/**
 * Deleting an ABAP class kills the ADT session server-side (the next
 * request on it gets `400 Session Timed Out` / `ICMENOSESSION`), so every
 * delete after the first must survive that. Same one-shot
 * revive-and-retry-once idiom as `authorizeBridgeTarget` in `src/adt/run.ts`
 * and the `"legacy"`/`"broken"` branches of `ensureOneObject` in
 * `src/adt/fluid/ensure.ts` (both confirmed reference implementations) —
 * never a loop, exactly one `conn.connect()` and one retry.
 */
export async function deleteOneFluidObject(
  conn: AbapConnection,
  gate: SafetyGate,
  target: FluidDeleteTarget,
  reviveOnDeadSession: boolean,
): Promise<{ deleted: boolean | "unverified" }> {
  const attempt = async () => {
    const authorized = await authorizeMutation(conn, gate, "delete", { type: target.type, name: target.name });
    // NO_JOURNAL: abapsmith's own generated scaffolding, not user content —
    // same idiom as `ensureFluidPackage`/`deployBridge`.
    return deleteObject(conn, authorized, { onBeforeImage: NO_JOURNAL });
  };
  if (!reviveOnDeadSession) return attempt();
  try {
    return await attempt();
  } catch (e) {
    if (!isSessionDeadFailure(e)) throw e;
    await conn.connect();
    return attempt();
  }
}
