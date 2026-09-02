/**
 * `ServerPackage` guarantees a package name came from a server read-back,
 * never from caller input, a default, or a guess. A plain `string` can't
 * make that promise — any caller can hand one in. Neither can a
 * self-declared `{ name, source: "server" | "requested" }` union — a caller
 * satisfies that by simply writing `source: "server"` over a value it made
 * up. The brand here is a module-private `Symbol`: since it is never
 * exported, no object literal outside this file can carry it, so the only
 * way to obtain a `ServerPackage` is through {@link serverPackage} below.
 * `assertServerPackage` is the runtime half, for the callers TypeScript
 * can't reach (plain JS, an `as any` cast).
 */
import type { VerifyOutcome } from "./write-verify.js";
import { AbapError } from "./errors.js";

const SERVER_RESOLVED = Symbol("abapsmith.server-resolved-package");

export interface ServerPackage {
  readonly name: string;
  readonly [SERVER_RESOLVED]: true;
}

function isServerPackage(value: unknown): value is ServerPackage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[SERVER_RESOLVED] === true &&
    typeof (value as { name?: unknown }).name === "string" &&
    (value as { name: string }).name.trim().length > 0
  );
}

/**
 * The only constructor. `confirmed` with no `packageName` (element present,
 * nameless — see `verifyViaVitBridge`'s doc comment) and every other status
 * collapse to `undefined` alike; never throws, so the caller decides how to
 * refuse. Package names are case-insensitive server-side, so the result is
 * always uppercased.
 */
export function serverPackage(outcome: VerifyOutcome): ServerPackage | undefined {
  if (outcome.status !== "confirmed") return undefined;
  const name = outcome.packageName?.trim();
  if (!name) return undefined;
  return { name: name.toUpperCase(), [SERVER_RESOLVED]: true };
}

/**
 * Fail-closed half of the brand — see module doc. Mirrors `packageUnknown`
 * in `src/adt/write.ts`: same code, same `details.reason`, so a caller-side
 * `PACKAGE_UNKNOWN` handler covers both.
 */
export function assertServerPackage(value: unknown, context: string): asserts value is ServerPackage {
  if (isServerPackage(value)) return;
  throw new AbapError(
    "SAFETY_DENIED",
    `abapsmith could not determine which package ${context} belongs to, so it refuses the ` +
      "operation (the value was not confirmed by a server read-back).",
    { reason: "PACKAGE_UNKNOWN", context },
    "Every write, delete and activation is judged against the object's real package. Rather " +
      "than trust a caller-supplied or guessed value, abapsmith stops here. Resolve the " +
      "package from the server, then retry.",
    { retryable: true }, // a failure to determine the package, not a policy verdict — a healthy connection resolves it
  );
}
