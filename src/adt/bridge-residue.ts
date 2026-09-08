/**
 * Leaf module shared by the legacy bridge deploy path (src/adt/run.ts) and
 * the fluid deploy path (src/adt/fluid/ensure.ts). Imports nothing but
 * `./errors.js`, so it cannot create an import cycle between those two
 * (test/fluid-cycle.test.ts guards that).
 */
import { AbapError, isAbapError } from "./errors.js";

/** Which post-write step {@link discloseBridgeResidue} caught the failure in. */
export type BridgeResidueStage = "activate-gate" | "activation" | "verify" | "content-verify";

/**
 * ARCH-09 §5.6/P9: once `writeObject` succeeds, any failure below it leaves
 * `className` behind in `packageName`. Disclosure, not deletion — deleting it
 * would destroy an artefact a developer might want to inspect — so this only
 * adds facts to the existing error; `code`/`message` stay untouched since
 * callers/tests branch on `code`.
 *
 * `stage` (not the caught error's `code`) decides the wording, since only
 * `stage` says what actually ran. Callers must only invoke this from a catch
 * that sits below a successful write, so a pre-write refusal (e.g. from
 * `authorizeMutation`) reaches the caller unchanged.
 */
export function discloseBridgeResidue(
  e: unknown,
  className: string,
  packageName: string,
  stage: BridgeResidueStage,
): unknown {
  if (!isAbapError(e)) return e; // every post-write step throws AbapError; anything else passes through untouched.
  if (e.details.bridgeLeftBehind === true) return e; // already disclosed — don't append the sentence twice.

  const outcome =
    stage === "activate-gate"
      ? "was blocked before activation could run; it is left behind there, inactive"
      : stage === "activation"
        ? "failed to activate; it is left behind there, inactive"
        : stage === "verify"
          ? "activated, then failed post-activation verification; it is left behind there"
          : "activated, then failed the source read-back that confirms what landed; it is left behind there";

  const residueHint = `Bridge class ${className} was written to ${packageName} but ${outcome} — safe to delete.`;

  const disclosed = new AbapError(
    e.code,
    e.message,
    { ...e.details, bridgeClass: className, bridgeLeftBehind: true },
    e.hint ? `${e.hint} ${residueHint}` : residueHint,
  );
  disclosed.stack = e.stack;
  disclosed.cause = e.cause;
  return disclosed;
}
