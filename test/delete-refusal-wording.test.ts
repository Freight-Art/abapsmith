/**
 * Wording pins for the delete gate in `resolveWriteTarget`: a delete
 * refusal names `abap_write` as the limited party, not the object. Every
 * case here uses `offline` — a null `AbapConnection` — as the proof of
 * "ZERO requests on the wire": any HTTP attempt on a null connection throws
 * a plain `TypeError`, so asserting the thrown error is a real `UNSUPPORTED`
 * `AbapError` (not a `TypeError`) IS the proof no request was ever made.
 */
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { resolveWriteTarget } from "../src/adt/write.js";
import {
  BRIDGE_DELETABLE_TYPES,
  CREATABLE_TYPES,
  DELETABLE_TYPES,
  ENHANCEABLE_TYPES,
  REGISTRY,
} from "../src/adt/capabilities.js";

const offline = null as unknown as AbapConnection;

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

/**
 * Registry codes that can be created or enhanced, yet have no REST delete
 * route (`DELETABLE_TYPES`) and no bridge delete route
 * (`BRIDGE_DELETABLE_TYPES`) either — the group that reaches the dedicated
 * delete gate in `resolveWriteTarget`. Derived, not hardcoded, so a future
 * type lands in this test automatically. Today: DDLA/ADF, BDEF/BDO,
 * ENHO/XHH, ENQU/DL.
 */
const candidateTypes = Array.from(new Set([...CREATABLE_TYPES, ...ENHANCEABLE_TYPES]));
const deleteGateGroup = candidateTypes.filter(
  (t) => !DELETABLE_TYPES.includes(t) && !BRIDGE_DELETABLE_TYPES.includes(t),
);

describe("delete refusal wording — coverage-gap framing, not object framing", () => {
  it("the derived delete-gate group is non-empty (this test can never silently cover nothing)", () => {
    expect(deleteGateGroup.length).toBeGreaterThan(0);
  });

  it.each(deleteGateGroup)("%s: refused as an abap_write coverage gap, not as an unremovable object", async (type) => {
    const e = await catchErr(resolveWriteTarget(offline, { type, name: "ZTMD_X" }, "delete"));
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/abap_write does not implement delete/);
    expect(String(e.message)).toContain(type);
    expect(String(e.message)).not.toMatch(/cannot be deleted/i);
    expect(String(e.message)).not.toMatch(/unremovable|cannot be removed|can never be removed/i);
    expect(typeof e.hint).toBe("string");
    expect((e.hint ?? "").length).toBeGreaterThan(0);
    expect(e.hint ?? "").not.toMatch(/unremovable|cannot be removed|can never be removed/i);
  });

  it("does not regress a genuinely deletable type: CLAS/OC is deletable and outside the derived refusal group (control)", () => {
    expect(DELETABLE_TYPES).toContain("CLAS/OC");
    expect(deleteGateGroup).not.toContain("CLAS/OC");
  });

  it("REGISTRY still has an entry for every type this test touches (sanity)", () => {
    for (const t of [...deleteGateGroup, "CLAS/OC"]) {
      expect(Object.prototype.hasOwnProperty.call(REGISTRY, t)).toBe(true);
    }
  });
});
