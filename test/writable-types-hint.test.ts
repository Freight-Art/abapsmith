/**
 * `abap_write`'s refusal hints under-reported the writable-type
 * inventory (missing `DEVC/K`, `VIEW/DV`, `TRAN/T`, `ENHO/XHH`). These tests
 * pin that both refusal sites advertise the full, registry-derived list.
 */
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { resolveWriteTarget } from "../src/adt/write.js";
import {
  ABAP_WRITE_TYPES,
  BRIDGE_ONLY_CREATE_TYPES,
  CREATABLE_TYPES,
  ENHANCEABLE_TYPES,
} from "../src/adt/capabilities.js";

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

/** Same reasoning as `write.test.ts`'s `offline`: a null connection is the assertion that a refusal happens before any byte goes on the wire. */
const offline = null as unknown as AbapConnection;

describe("writableTypesHint", () => {
  it("the unknown-type refusal advertises every type abap_write accepts, not just the create-and-write ones", async () => {
    const e = await catchErr(resolveWriteTarget(offline, { type: "ZZZZ/QQ", name: "ZTMD_X" }));
    expect(e.code).toBe("BAD_INPUT");
    expect(e.hint).toContain("DEVC/K");
    expect(e.hint).toContain("VIEW/DV");
    expect(e.hint).toContain("TRAN/T");
    expect(e.hint).toContain("ENHO/XHH");
  });

  it("the advertised list is derived from the registry, so it cannot go stale", async () => {
    const e = await catchErr(resolveWriteTarget(offline, { type: "ZZZZ/QQ", name: "ZTMD_X" }));
    const writable = e.details.writable;
    expect(Array.isArray(writable)).toBe(true);
    for (const code of [...CREATABLE_TYPES, ...BRIDGE_ONLY_CREATE_TYPES, ...ENHANCEABLE_TYPES]) {
      expect(e.hint).toContain(code);
      expect(writable).toContain(code);
    }
  });

  it("the same inventory backs the UNSUPPORTED refusal for a known-but-unwritable type", async () => {
    const known = await catchErr(resolveWriteTarget(offline, { type: "ZZZZ/QQ", name: "ZTMD_X" }));
    const unsupported = await catchErr(
      resolveWriteTarget(offline, { type: "PROG/I", name: "ZTMD_INC" }),
    );
    expect(unsupported.code).toBe("UNSUPPORTED");
    expect(unsupported.hint).toBe(known.hint);
    expect(unsupported.hint).toContain("DEVC/K");
  });

  it("ABAP_WRITE_TYPES is exactly the union of the creatable, bridge-only-create and enhanceable sets", () => {
    const expected = new Set([...CREATABLE_TYPES, ...BRIDGE_ONLY_CREATE_TYPES, ...ENHANCEABLE_TYPES]);
    expect(new Set(ABAP_WRITE_TYPES)).toEqual(expected);
    expect(ABAP_WRITE_TYPES.length).toBe(expected.size);
  });
});
