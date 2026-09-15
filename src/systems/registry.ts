/**
 * Holds every configured system's {@link SystemContext} and resolves a
 * caller-supplied `system` alias (or the absence of one) to the right one.
 *
 * A single-system server still builds one of these — with exactly one
 * context in it — rather than special-casing "no registry" elsewhere. That
 * is what keeps `createServer`'s single-system path and its multi-system
 * path the same code: see `src/systems/route.ts`'s `installSystemRouting`,
 * which is a no-op precisely when `registry.size <= 1`.
 */
import { AbapError } from "../adt/errors.js";
import { currentSystemAlias } from "./current.js";
import type { SystemContext } from "./context.js";

export class SystemRegistry {
  private readonly byAlias = new Map<string, SystemContext>();
  private readonly defaultContext: SystemContext;
  private readonly orderedAliases: readonly string[];

  constructor(contexts: readonly SystemContext[]) {
    if (contexts.length === 0) {
      // Not a reachable state via `createServer` (step 1 always produces at
      // least the degenerate single-system spec) — defence in depth so a
      // future caller gets a clear failure instead of `this.default`
      // silently returning `undefined` at a type that promises it never is.
      throw new Error("SystemRegistry requires at least one SystemContext.");
    }
    let def: SystemContext | undefined;
    for (const ctx of contexts) {
      // Case-insensitive lookup key; aliases are already uppercase-only
      // (`isValidAlias`) but this keeps `resolve()` forgiving of a caller
      // that types one in lowercase.
      this.byAlias.set(ctx.alias.toUpperCase(), ctx);
      if (ctx.isDefault) def = ctx;
    }
    if (def === undefined) {
      throw new Error("SystemRegistry requires exactly one SystemContext with isDefault true.");
    }
    this.defaultContext = def;
    // Default first, then the rest in the order given — matches the order
    // `loadSystems` already sorts specs into, and is what the multi-system
    // instructions sentence and the resource loop iterate in.
    this.orderedAliases = [def.alias, ...contexts.filter((c) => !c.isDefault).map((c) => c.alias)];
  }

  get size(): number {
    return this.byAlias.size;
  }

  /** Default first, then the rest in construction order. */
  get aliases(): readonly string[] {
    return this.orderedAliases;
  }

  get default(): SystemContext {
    return this.defaultContext;
  }

  /**
   * Resolves a caller-supplied `system` argument.
   *
   * - `undefined` ⇒ the in-flight routed context if one exists (nested tool
   *   calls made from inside an already-routed handler stay on that
   *   system), else the default system.
   * - A configured alias (case-insensitive, surrounding whitespace
   *   trimmed) ⇒ that system's context.
   * - Anything else ⇒ throws `AbapError("UNKNOWN_SYSTEM", ...)` naming the
   *   alias that was requested and listing every alias this process
   *   actually knows about.
   */
  resolve(alias?: string): SystemContext {
    if (alias === undefined) return this.current();
    const key = alias.trim().toUpperCase();
    const ctx = this.byAlias.get(key);
    if (ctx !== undefined) return ctx;
    throw new AbapError(
      "UNKNOWN_SYSTEM",
      `"${alias}" is not a configured system. Configured aliases: [${this.orderedAliases.join(", ")}].`,
      { requested: alias, configured: this.orderedAliases },
      "See doc/CONFIGURATION/multi-system.md for how to add a system, or omit `system` to use " +
        `the default (${this.defaultContext.alias}).`,
    );
  }

  /** The in-flight routed context, or the default. Never throws. */
  current(): SystemContext {
    const alias = currentSystemAlias();
    if (alias === undefined) return this.defaultContext;
    return this.byAlias.get(alias.toUpperCase()) ?? this.defaultContext;
  }

  all(): readonly SystemContext[] {
    // Default first, then the rest — same order as `aliases`. Every alias in
    // `orderedAliases` was inserted into `byAlias` in the constructor, so
    // this filter can never actually drop anything; written this way rather
    // than a non-null assertion to stay honest under `noUncheckedIndexedAccess`.
    const out: SystemContext[] = [];
    for (const alias of this.orderedAliases) {
      const ctx = this.byAlias.get(alias.toUpperCase());
      if (ctx !== undefined) out.push(ctx);
    }
    return out;
  }
}
