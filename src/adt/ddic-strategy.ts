// This table has zero imports on purpose. `capabilities.ts` calls
// `ddicStrategy` while computing top-level `const`s (`NON_READABLE_TYPES`) at
// module-initialisation time, and `resolve.ts` needs it too; pulling it in
// from `ddic.ts` used to close a runtime import cycle
// `capabilities.ts` -> `ddic.ts` -> `catalog-read.ts` -> `datapreview.ts` ->
// `connection.ts` -> `config.ts` -> `safety.ts` -> `capabilities.ts`. Under
// ESM that left `FREESTYLE_BANNED_KEYWORDS` undefined at module-init and
// crashed `datapreview-filter.ts` at load. Keeping this module importless
// guarantees it can never participate in a cycle.

/** The two live-captured groups, kept as data rather than a per-type flag. */
export const DDIC_SOURCE_BASED = ["TABL", "STRU"] as const;
export const DDIC_XML_ONLY = ["DTEL", "DOMA", "TTYP"] as const;
/**
 * Kinds with no source and no XML descriptor either, read through plain-text
 * catalog SELECTs on the freestyle data-preview endpoint instead — see
 * `catalog-read.ts`'s file header for why that route was chosen over the
 * DDIF_SHLP_GET / DDIF_VIEW_GET / RPY_TRANSACTION_READ function modules.
 */
export const DDIC_CATALOG_BASED = ["SHLP", "VIEW", "TRAN"] as const;

export type DdicStrategy = "source" | "xml" | "package" | "catalog" | "unsupported";

/** How this kind is actually read on this release. Verified, not guessed. */
export function ddicStrategy(kind: string): DdicStrategy {
  const k = kind.toUpperCase();
  if ((DDIC_SOURCE_BASED as readonly string[]).includes(k)) return "source";
  if ((DDIC_XML_ONLY as readonly string[]).includes(k)) return "xml";
  if ((DDIC_CATALOG_BASED as readonly string[]).includes(k)) return "catalog";
  if (k === "DEVC") return "package";
  return "unsupported";
}
