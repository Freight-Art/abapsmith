/**
 * The adjacent half of the container-name defect: the object NAME in `resolveWriteTarget` is
 * validated against `isAddressableAbapObjectName`, but the CONTAINER name
 * fell straight through into `buildUri`'s `encodeURIComponent`, so a
 * malformed container silently addressed a different (nonexistent) object
 * instead of failing. This pins the refusal.
 */
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { resolveWriteTarget } from "../src/adt/write.js";

const offline = null as unknown as AbapConnection;

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

// For inputs that must clear our check: whatever comes back (typically a
// raw TypeError off the null connection) must not be our BAD_INPUT.
const catchAny = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (err: unknown) => err,
  );

describe("resolveWriteTarget refuses a malformed container name", () => {
  it("rejects a container with an embedded slash, naming it in the message", async () => {
    const e = await catchErr(
      resolveWriteTarget(offline, { type: "FUGR/FF", name: "ZFM", containerName: "ZFG//DMO" }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toContain("ZFG//DMO");
    expect(e.message).toMatch(/not a valid ABAP object name/);
  });

  it("rejects a container with a trailing slash", async () => {
    const e = await catchErr(
      resolveWriteTarget(offline, { type: "FUGR/FF", name: "ZFM", containerName: "ZFG/" }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toContain("ZFG/");
    expect(e.message).toMatch(/not a valid ABAP object name/);
  });

  it("rejects a container with an embedded space", async () => {
    const e = await catchErr(
      resolveWriteTarget(offline, { type: "FUGR/FF", name: "ZFM", containerName: "ZFG DMO" }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toContain("ZFG DMO");
    expect(e.message).toMatch(/not a valid ABAP object name/);
  });

  it("rejects a container starting with a digit", async () => {
    const e = await catchErr(
      resolveWriteTarget(offline, { type: "FUGR/FF", name: "ZFM", containerName: "1ZFG" }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toContain("1ZFG");
    expect(e.message).toMatch(/not a valid ABAP object name/);
  });

  it("the hint explains the URI consequence, not just the refusal", async () => {
    const e = await catchErr(
      resolveWriteTarget(offline, { type: "FUGR/FF", name: "ZFM", containerName: "ZFG//DMO" }),
    );
    expect(e.hint).toBeDefined();
    expect(e.hint).toMatch(/uri/i);
  });

  it("details carry the container, the object name and the type", async () => {
    const e = await catchErr(
      resolveWriteTarget(offline, { type: "FUGR/FF", name: "ZFM", containerName: "ZFG//DMO" }),
    );
    expect(e.details.containerName ?? e.details.container).toBe("ZFG//DMO");
    expect(e.details.name).toBe("ZFM");
    expect(e.details.type).toBe("FUGR/FF");
  });

  it("a well-formed plain container gets past this check and on to the (null) connection", async () => {
    const e = await catchAny(
      resolveWriteTarget(offline, { type: "FUGR/FF", name: "ZFM", containerName: "ZFG" }),
    );
    expect(e).toBeDefined();
    if (isAbapError(e)) {
      expect(e.message).not.toMatch(/not a valid ABAP object name/);
    }
  });

  it("a well-formed namespaced container (/DMO/FG) gets past this check too", async () => {
    const e = await catchAny(
      resolveWriteTarget(offline, { type: "FUGR/FF", name: "ZFM", containerName: "/DMO/FG" }),
    );
    expect(e).toBeDefined();
    if (isAbapError(e)) {
      expect(e.message).not.toMatch(/not a valid ABAP object name/);
    }
  });

  it("a lower-case container is accepted, upper-cased before the check runs", async () => {
    const e = await catchAny(
      resolveWriteTarget(offline, { type: "FUGR/FF", name: "ZFM", containerName: "zfg" }),
    );
    expect(e).toBeDefined();
    if (isAbapError(e)) {
      expect(e.message).not.toMatch(/not a valid ABAP object name/);
    }
  });
});
