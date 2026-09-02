/**
 * `parseObjectRef`'s `PARENT/NAME` split used `lastIndexOf("/")`,
 * which cannot tell a namespace separator from a parent separator.
 * `ZFG//DMO/FM` used to silently resolve to parent `ZFG//DMO`, name `FM` —
 * a different object than the caller named, reported as success.
 */
import { describe, expect, it } from "vitest";
import { parseObjectRef } from "../src/adt/resolve.js";
import { specForType } from "../src/adt/types.js";
import { isAbapError } from "../src/adt/errors.js";

const FF = specForType("FUGR/FF");

const expectBadInput = (fn: () => unknown) => {
  try {
    fn();
    expect.unreachable("expected a BAD_INPUT throw");
  } catch (e) {
    expect(isAbapError(e)).toBe(true);
    expect((e as { code: string }).code).toBe("BAD_INPUT");
  }
};

describe("parseObjectRef — PARENT/NAME split", () => {
  it("splits a plain parent/name pair", () => {
    const r = parseObjectRef("ZFG/ZFM", FF);
    expect(r.parent).toBe("ZFG");
    expect(r.name).toBe("ZFM");
  });

  it("regression guard: a bare /NAMESPACE/NAME is never split into parent+name — the whole fix depends on this staying true", () => {
    const r = parseObjectRef("/DMO/FOO", FF);
    expect(r.parent).toBeUndefined();
    expect(r.name).toBe("/DMO/FOO");
  });

  it("splits a namespaced parent from a namespaced name with one separator", () => {
    const r = parseObjectRef("/DMO/FG//DMO/FM", FF);
    expect(r.parent).toBe("/DMO/FG");
    expect(r.name).toBe("/DMO/FM");
  });

  it("splits a namespaced parent from a plain name", () => {
    const r = parseObjectRef("/DMO/FG/ZFM", FF);
    expect(r.parent).toBe("/DMO/FG");
    expect(r.name).toBe("ZFM");
  });

  it("splits a plain parent from a namespaced name, not the child's own trailing slash", () => {
    const r = parseObjectRef("ZFG//DMO/FM", FF);
    expect(r.parent).toBe("ZFG");
    expect(r.name).toBe("/DMO/FM");
  });

  it("does not split without a parent-aware hint — ZFG/ZFM is refused, not guessed", () => {
    expectBadInput(() => parseObjectRef("ZFG/ZFM"));
  });

  it("does not split when the hint's spec has no parentPath", () => {
    expectBadInput(() => parseObjectRef("ZFG/ZFM", specForType("CLAS/OC")));
  });

  it("refuses an ambiguous/unsplittable multi-slash form rather than guessing", () => {
    expectBadInput(() => parseObjectRef("A/B/C/D", FF));
  });
});

describe('parseObjectRef — "NAME in GROUP" validates the container', () => {
  it("throws BAD_INPUT naming the malformed container", () => {
    try {
      parseObjectRef("ZFM in ZFG//DMO", FF);
      expect.unreachable("expected a BAD_INPUT throw");
    } catch (e) {
      expect(isAbapError(e)).toBe(true);
      expect((e as { code: string }).code).toBe("BAD_INPUT");
      expect(String((e as { message: string }).message)).toMatch(/ZFG\/\/DMO/);
    }
  });

  it("still resolves a well-formed container", () => {
    const r = parseObjectRef("ZFM in ZFG", FF);
    expect(r.parent).toBe("ZFG");
    expect(r.name).toBe("ZFM");
  });
});
