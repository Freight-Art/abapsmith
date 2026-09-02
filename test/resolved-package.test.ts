/**
 * `src/adt/resolved-package.ts` — the brand that makes a caller-supplied
 * package string unrepresentable where a server-verified one is required.
 * Pure module, no connection/fake server needed: `serverPackage` is a plain
 * function over a `VerifyOutcome` literal.
 */
import { describe, expect, it } from "vitest";
import { assertServerPackage, serverPackage, type ServerPackage } from "../src/adt/resolved-package.js";
import type { VerifyOutcome } from "../src/adt/write-verify.js";
import { isAbapError } from "../src/adt/errors.js";

const confirmed = (packageName: string | undefined): VerifyOutcome => ({
  status: "confirmed",
  uri: "/sap/bc/adt/vit/wb/object_type/viewdv/object_name/ZTM_V_X",
  via: "vit-bridge",
  packageName,
});

describe("serverPackage", () => {
  it("brands a confirmed outcome carrying a package, uppercased", () => {
    const result = serverPackage(confirmed("zlocal"));
    expect(result).toBeDefined();
    expect(result?.name).toBe("ZLOCAL");
  });

  it("returns undefined for confirmed with packageName undefined", () => {
    expect(serverPackage(confirmed(undefined))).toBeUndefined();
  });

  it("returns undefined for confirmed with an empty-string package", () => {
    expect(serverPackage(confirmed(""))).toBeUndefined();
  });

  it("returns undefined for confirmed with a whitespace-only package", () => {
    expect(serverPackage(confirmed("   "))).toBeUndefined();
  });

  it("returns undefined for confirmed-absent", () => {
    const outcome: VerifyOutcome = {
      status: "confirmed-absent",
      uri: "/sap/bc/adt/vit/wb/object_type/viewdv/object_name/ZTM_V_X",
      via: "vit-bridge",
    };
    expect(serverPackage(outcome)).toBeUndefined();
  });

  it("returns undefined for indeterminate", () => {
    const outcome: VerifyOutcome = {
      status: "indeterminate",
      uri: "/sap/bc/adt/vit/wb/object_type/viewdv/object_name/ZTM_V_X",
      reason: "network blip",
    };
    expect(serverPackage(outcome)).toBeUndefined();
  });
});

describe("assertServerPackage", () => {
  const expectDenied = (thrower: () => void): void => {
    try {
      thrower();
      expect.unreachable("expected assertServerPackage to throw");
    } catch (e) {
      expect(isAbapError(e)).toBe(true);
      if (!isAbapError(e)) throw e;
      expect(e.code).toBe("SAFETY_DENIED");
      expect(e.details.reason).toBe("PACKAGE_UNKNOWN");
      // a failure to determine the package, not a policy verdict — retryable once the server resolves it
      expect(e.retryable).toBe(true);
    }
  };

  it("rejects a bare string", () => {
    expectDenied(() => assertServerPackage("ZLOCAL", "view ZTM_V_X"));
  });

  it("rejects a plain object shaped like the interface but unbranded", () => {
    expectDenied(() => assertServerPackage({ name: "ZLOCAL" }, "view ZTM_V_X"));
  });

  it("rejects undefined", () => {
    expectDenied(() => assertServerPackage(undefined, "view ZTM_V_X"));
  });

  it("rejects null", () => {
    expectDenied(() => assertServerPackage(null, "view ZTM_V_X"));
  });

  it("accepts a genuine ServerPackage minted by the constructor", () => {
    const branded = serverPackage(confirmed("zlocal"));
    expect(() => assertServerPackage(branded, "view ZTM_V_X")).not.toThrow();
  });
});

describe("compile-time: ServerPackage cannot be satisfied by an object literal", () => {
  it("documents the brand via @ts-expect-error", () => {
    function requiresServerPackage(p: ServerPackage): string {
      return p.name;
    }

    // @ts-expect-error -- { name: "ZEVIL" } is not a ServerPackage: it lacks
    // the module-private SERVER_RESOLVED symbol, which no code outside
    // src/adt/resolved-package.ts can name. If this stops erroring, the
    // brand has been weakened (e.g. the symbol got exported, or the
    // interface gained a string discriminant instead).
    const evil: ServerPackage = { name: "ZEVIL" };

    expect(() => requiresServerPackage(evil)).not.toThrow();
  });
});
