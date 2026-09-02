/**
 * THE COMPILE-TIME HALF OF THE `ServerPackage` BRAND (F1, classrun-bridge
 * safety-gate bypass closure).
 *
 * Nothing here runs. `mustNotCompile()` is exported and never called; the
 * assertions are the `@ts-expect-error` directives below, and the thing
 * under test is whether `tsc` agrees with them.
 *
 * WHY A SEPARATE FILE AND PROJECT. Same reason as
 * `breaker-required.fixture.ts` beside this one: the root tsconfig excludes
 * `test/`, so `npm run typecheck` never looks at this file. This gets its
 * own project (`test/types/tsconfig.resolved-package.json`) rather than
 * riding in `../../test/types/tsconfig.json` alongside the breaker fixture —
 * a failure in one brand's compile-time law should not block or mask a
 * failure in the other's; each is driven by its own vitest wrapper
 * (`test/resolved-package-types.test.ts`).
 *
 * WHAT IT LOCKS. `src/adt/resolved-package.ts`'s `ServerPackage` is
 * constructable only via `serverPackage()`, because its brand is a
 * module-private `Symbol` that no other file can name. Each directive below
 * marks a construction that would compile if that brand were ever weakened
 * (the symbol exported, the interface loosened to a string discriminant, or
 * dropped altogether) — the exact hole this module exists to close in
 * `view-delete.ts`/`tran-delete.ts`'s `packageName: string` parameter. If
 * any of these starts compiling, `tsc` reports "Unused '@ts-expect-error'
 * directive" and the vitest wrapper goes red.
 */
import { serverPackage, type ServerPackage } from "../../src/adt/resolved-package.js";
import type { VerifyOutcome } from "../../src/adt/write-verify.js";
// The most likely real-world weakening: someone exports the brand symbol
// itself ("just for this one test", "for debugging"). Verified empirically
// (scratch harness) that this import fails with TS2459 today, AND that a
// subsequent forged object built from the (illegally) imported binding
// fails independently with TS2741 — two tripwires, not one, so exporting
// the symbol trips this file even if a future refactor makes only one of
// the two lines below legal.
// @ts-expect-error -- SERVER_RESOLVED is not, and must not become, an exported member.
import { SERVER_RESOLVED as exportedBrand } from "../../src/adt/resolved-package.js";

export function mustNotCompile(): void {
  // @ts-expect-error -- a bare string is not a ServerPackage: it carries no brand at all.
  const asString: ServerPackage = "ZLOCAL";
  void asString;

  // @ts-expect-error -- shape matches `name` but has no brand; this is exactly the
  // `{ name, source: "server" }`-style escape hatch the module doc rejects.
  const asPlainObject: ServerPackage = { name: "ZEVIL" };
  void asPlainObject;

  // The real brand symbol is never exported, so the best a caller can do is mint a
  // look-alike with the same description. Symbols are unique by identity, not
  // description, so a self-minted one is still not the real key.
  const lookalikeBrand = Symbol("abapsmith.server-resolved-package");
  // @ts-expect-error -- spelling the brand's description does not spell the brand.
  const asForgedBrand: ServerPackage = { name: "ZEVIL", [lookalikeBrand]: true };
  void asForgedBrand;

  // @ts-expect-error -- only compiles if the illegal import above ever becomes legal
  // (the brand symbol got exported) AND is then used to build the property directly.
  const asImportedBrand: ServerPackage = { name: "ZEVIL", [exportedBrand]: true };
  void asImportedBrand;
}

/**
 * The positive control. Without this, the file would still "pass" if
 * `serverPackage`'s return type had been broken in some unrelated way that
 * rejects everything (e.g. changed to `never`).
 */
export function positiveControlCompiles(): void {
  const outcome: VerifyOutcome = {
    status: "confirmed",
    uri: "test:type-check-only",
    via: "vit-bridge",
    packageName: "ZLOCAL",
  };
  const genuine = serverPackage(outcome);
  const requiresServerPackage = (p: ServerPackage): string => p.name;
  if (genuine) requiresServerPackage(genuine);
}
