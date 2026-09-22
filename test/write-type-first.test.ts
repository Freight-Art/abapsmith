/**
 * Issue #157: `abap_write` used to check `source`/`edit`/`method` presence
 * BEFORE the explicit `type` was validated, so `{object, type:"TRAN/P"}` (a
 * typo of TRAN/T) was refused with the misleading "`source` is required for
 * mode=write" instead of naming the bad type. `abapWrite` now runs
 * `refuseUnwritableType` right after resolving `target`, before the
 * `source`-required guard — all zero-network, offline.
 */
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import { abapWrite } from "../src/tools/write.js";

/** Same technique as write.test.ts's `offline`/`catchErr`: a null connection
 * proves zero network use — any attempt to reach it throws a plain
 * TypeError, not an AbapError, before `catchErr`'s assertion below runs. */
const offline = null as unknown as AbapConnection;
const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
const MAX = 20_000;

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

describe("abap_write: an explicit type is validated before the missing-source error (issue #157)", () => {
  it("an invalid type is reported before the missing-source error", async () => {
    const e = await catchErr(abapWrite(offline, { object: "ZAS_X", type: "TRAN/P" }, MAX, gate));
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toMatch(/Unknown object type "TRAN\/P"\. Did you mean TRAN\/T\?/);
    expect(e.message).not.toMatch(/`source` is required/);
  });

  it("an unsupported type is reported before the missing-source error", async () => {
    const e = await catchErr(abapWrite(offline, { object: "ZAS_X", type: "ENHO/XH" }, MAX, gate));
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.message).not.toMatch(/`source` is required/);
  });

  it("a valid type without source still gets the source error", async () => {
    const e = await catchErr(abapWrite(offline, { object: "ZAS_X", type: "CLAS/OC" }, MAX, gate));
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toMatch(/`source` is required for mode=write/);
  });

  it("mode=delete with an invalid type is refused the same way", async () => {
    const e = await catchErr(
      abapWrite(offline, { object: "ZAS_X", type: "TRAN/P", mode: "delete" }, MAX, gate),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toMatch(/Unknown object type "TRAN\/P"\. Did you mean TRAN\/T\?/);
  });
});
