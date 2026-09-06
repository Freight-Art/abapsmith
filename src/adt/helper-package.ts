/**
 * The one local package abapsmith deploys its own generated bridge/helper
 * classes into — owner rule 2026-09-05. Distinct from `BRIDGE_PACKAGE`
 * (`$TMP`, `src/adt/run.ts`), which other bridge families still use until
 * they migrate; new bridge work (starting with the IMG write bridge) lands
 * here instead. Created on first use, never assumed to exist.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError, isAbapError, describeUnknownError } from "./errors.js";
import type { SafetyGate } from "../safety.js";
import { authorizeMutation, createPackage, NO_JOURNAL } from "./write.js";

/**
 * Renameable here and only here — a `$`-prefixed local package, non-transportable by construction.
 * The `$` only trips `ABAP_ALLOW_NAME_PREFIXES` under a deliberate `["Z","Y"]` lockdown (a
 * hand-built `SafetyGate`/`ConfigSchema.parse`) — `loadConfig()` resolves an unset setting to
 * `["*"]` (`src/config.ts`), so a normal install never refuses this; widen the setting if it does,
 * rather than renaming to a `Z`/`Y` name (which would make it transportable).
 */
export const HELPER_PACKAGE = "$ZMCP_HELPERS";

/** `SCOMPKDTLN-CTEXT` (CHAR60) for {@link HELPER_PACKAGE} when it is created. */
export const HELPER_PACKAGE_DESCRIPTION = "abapsmith generated helper classes";

// $TMP is $ZMCP_HELPERS's super package (parent), not a landing spot — generated classes still go into $ZMCP_HELPERS, never into $TMP itself.
const NO_TMP_FALLBACK_HINT =
  `abapsmith does not fall back to $TMP for bridge/helper classes — if ${HELPER_PACKAGE} cannot ` +
  "be created or used, this is a hard refusal. Create it by hand (SE21, LOCAL software component) " +
  "or fix whatever the underlying error names, then retry.";

/**
 * SAFETY_DENIED-specific hint: names the two gate settings a `$ZMCP_HELPERS`
 * create can be refused by, since neither is obvious from the generic
 * refusal above. Not folded into `NO_TMP_FALLBACK_HINT` itself — this extra
 * sentence is noise on a non-safety failure (e.g. an HTTP error from the
 * create POST), so it's added only when `code === "SAFETY_DENIED"`.
 */
const SAFETY_DENIED_HINT =
  `${NO_TMP_FALLBACK_HINT} Creating it also needs ABAP_ALLOW_NAME_PREFIXES to cover "$" (or be ` +
  '"*") — the default Z/Y list refuses a $-named object — and, separately, ABAP_ALLOW_PACKAGES ' +
  "to permit $TMP, its super package (a package create's allowlist question is answered by the " +
  "superpackage, not the package's own name); both apply only to the first call that creates it.";

/** Which hint applies: the name-prefix/package sentences are noise on anything but a gate refusal. */
function fallbackHintFor(code: string): string {
  return code === "SAFETY_DENIED" ? SAFETY_DENIED_HINT : NO_TMP_FALLBACK_HINT;
}

/**
 * Create {@link HELPER_PACKAGE} on first use, or confirm it already exists.
 * Never writes to `$TMP` — a refused or failed create is a hard refusal, not
 * a silent fallback.
 */
export async function ensureHelperPackage(
  conn: AbapConnection,
  gate: SafetyGate,
): Promise<{ package: string; created: boolean; superPackage?: string }> {
  try {
    const authorized = await authorizeMutation(conn, gate, "write", {
      type: "DEVC/K",
      name: HELPER_PACKAGE,
      description: HELPER_PACKAGE_DESCRIPTION,
      // Super package for the create — verified live on 2026-09-05: SAP
      // accepted $ZMCP_HELPERS under $TMP and read back
      // pak:superPackage adtcore:name="$TMP". Not a guess.
      packageName: "$TMP",
    });

    // Pre-check rather than letting createPackage throw its own "already
    // exists" BAD_INPUT: authorizeMutation's resolveWriteTarget already did
    // the live GET, so `exists` costs no extra request here.
    if (authorized.target.exists) {
      return { package: HELPER_PACKAGE, created: false };
    }

    const created = await createPackage(conn, authorized, {
      softwareComponent: "LOCAL",
      // NO_JOURNAL: a generated helper package, not a user object — same idiom as deployBridge.
      onBeforeImage: NO_JOURNAL,
    });

    return { package: HELPER_PACKAGE, created: true, superPackage: created.superPackage };
  } catch (e) {
    if (isAbapError(e)) {
      const fallback = fallbackHintFor(e.code);
      throw new AbapError(
        e.code,
        e.message,
        e.details,
        e.hint ? `${e.hint} ${fallback}` : fallback,
        { retryable: e.retryable }, // re-wrap, not an override — no site reachable here overrides RETRYABILITY today
        // carries the caught error's retryable across instead of recomputing it, so that stays true if one ever does
      );
    }
    throw new AbapError(
      "ADT_ERROR",
      `Could not create or verify the local helper package ${HELPER_PACKAGE}: ${describeUnknownError(e)}.`,
      { cause: describeUnknownError(e) },
      NO_TMP_FALLBACK_HINT,
    );
  }
}
