/**
 * The live-write collection gate every "…write path" / "live write" describe
 * block in `test/integration*.test.ts` must use.
 *
 * Mirrors `src/config.ts`'s own `readOnly` derivation
 * (`modeCapabilities ? !modeCapabilities.allowWrite : !allowWrite`, ~line
 * 896): `ABAP_MODE`, when set and parseable, is the sole source of truth
 * (`ABAP_ALLOW_WRITE` is dead in that case); only when `ABAP_MODE` is unset
 * does the legacy `ABAP_ALLOW_WRITE` fallback apply.
 *
 * Deliberately NOT `loadConfig()`: that throws on a missing/invalid
 * `ABAP_URL`/credentials, which would abort collection instead of skipping it.
 */
import { capabilitiesForMode, parseAbapMode } from "../../src/mode.js";

/** Is this process configured such that live writes would be permitted? */
export function liveWriteConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ABAP_MODE;
  if (raw !== undefined && raw.trim() !== "") {
    try {
      // parseAbapMode is typed to allow `undefined` back out; it never
      // actually does for a defined, non-empty `raw` — narrowed below rather
      // than asserted.
      const mode = parseAbapMode(raw);
      if (mode !== undefined) return capabilitiesForMode(mode).allowWrite;
    } catch {
      // Invalid ABAP_MODE: loadConfig() refuses to start for this too (it
      // throws "Invalid abapsmith configuration", src/config.ts ~line 985),
      // so the fallback below is unreachable in practice — it only keeps
      // this predicate total.
    }
  }
  return ["1", "true", "yes", "on"].includes((env.ABAP_ALLOW_WRITE ?? "").trim().toLowerCase());
}
