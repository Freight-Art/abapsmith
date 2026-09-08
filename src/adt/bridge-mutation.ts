/**
 * The domain gate for a classrun-bridge mutation — split out of
 * `ddic-bridge.ts` so `write.ts` can import it without pulling in
 * `ddic-bridge.ts`'s own import of `./run.js`, which (via `write.ts` ->
 * `run.ts`) closed a cycle: `run.ts` imports `./write.js`, `write.ts`
 * imported `assertBridgeMutation` from `./ddic-bridge.js`, and
 * `ddic-bridge.ts` imports `./run.js` — `import("dist/adt/run.js")` as an
 * entry point threw `Cannot access 'BRIDGE_PACKAGE' before initialization`.
 * `ddic-bridge.ts` re-exports both names so existing importers are unaffected.
 */
import type { Operation, SafetyCorr, SafetyGate } from "../safety.js";

/** The domain object a bridge is about to create — the SECOND gate's subject (module header). */
export interface BridgeMutationTarget {
  /** ADT type code of the object the generated ABAP will create — `VIEW/DV`, `TRAN/T`, `DEVC/K`. */
  type: string;
  name: string;
  packageName: string;
  /**
   * `DEVC/K` create only: the parent package. `src/safety.ts` judges the
   * allowlist by SUPERPACKAGE, not by the not-yet-existing name — must
   * match what `authorizeMutation` already judged for this mutation.
   */
  superPackage?: string;
  /**
   * `DEVC/K` create only: whether the object already exists. See
   * `superPackage` — `src/safety.ts` only treats a `DEVC/K` write as a
   * create when `exists !== true`.
   */
  exists?: boolean;
}

/**
 * Gate the mutation the GENERATED CLASS will perform, before generating it.
 * `deployBridge`'s own gate only covers `ZCL_ZMCP_DDIC_*` in `$TMP` — this
 * covers the object the caller actually asked for, which is never named in
 * an HTTP request the bridge makes.
 *
 * Zero-network: the object doesn't exist yet and no ADT endpoint answers for
 * these types anyway. The package is judged exactly as the caller stated it
 * (never widened).
 *
 * `activate` is asserted separately from `write` since a view's
 * `DDIF_VIEW_ACTIVATE` is a distinct gate operation (`safety.ts`'s
 * `Operation`); callers that don't activate anything pass `activate: false`.
 *
 * `corr`, when supplied, is the transport this mutation will ACTUALLY use —
 * threaded straight to BOTH `gate.assert` calls' `EvaluateOptions.corr` (the
 * `write`/`op` assert above and the `activate` assert below) so `safety.ts`
 * judges (and, on refusal, names) the real request instead of synthesising
 * a literal `"auto"` transport nobody named. Previously,
 * only the first assert got `corr` — the activate assert always fabricated
 * `"auto"`, so `ABAP_ALLOW_TRANSPORTS=<the pinned request>` satisfied the
 * first gate and was refused by the second. Both `VIEW/DV` and `TRAN/T`
 * creates now pass `corr` for a transportable package; callers that have no
 * transport to name — a `$`-package create (its `RS_CORR_INSERT` runs with
 * `korrnum = space`) and the delete paths — omit it, unchanged; both asserts
 * then fall back to the gate's own default.
 */
export function assertBridgeMutation(
  gate: SafetyGate,
  target: BridgeMutationTarget,
  opts: { activate: boolean; op?: Operation; corr?: SafetyCorr },
): void {
  // A DEVC/K delete must be gated and audited as a delete, not a write.
  gate.assert(
    opts.op ?? "write",
    {
      type: target.type,
      name: target.name,
      packageName: target.packageName,
      // superPackage/exists must reach the gate so it judges the same
      // mutation `authorizeMutation` already did (see `BridgeMutationTarget`).
      // Spread conditionally to avoid adding `undefined` keys for existing
      // VIEW/DV/TRAN/T callers.
      ...(target.superPackage !== undefined ? { superPackage: target.superPackage } : {}),
      ...(target.exists !== undefined ? { exists: target.exists } : {}),
    },
    opts.corr !== undefined ? { corr: opts.corr } : {},
  );
  if (opts.activate) {
    gate.assert("activate", target, opts.corr !== undefined ? { corr: opts.corr } : {});
  }
}
