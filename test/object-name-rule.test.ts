/**
 * The ABAP object-name rule was implemented three times —
 * `resolve.ts`'s own `NAME_RE`, `write.ts`'s own `NAME_RE`, and
 * `isValidAbapIdentifier` in `safety.ts` — free to drift apart. This pins the
 * fix: one exported predicate, `isAddressableAbapObjectName`, that both
 * `resolve.ts` and `write.ts` now defer to instead of carrying their own copy.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { parseObjectRef } from "../src/adt/resolve.js";
import { resolveWriteTarget } from "../src/adt/write.js";
import { isAddressableAbapObjectName, isValidAbapIdentifier } from "../src/safety.js";

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

const offline = null as unknown as AbapConnection;

describe("isAddressableAbapObjectName", () => {
  it.each(["ZCL_FOO", "zcl_foo", "$TMP", "$tmp", "$MCP_DEMO", "/DMO/CL_FLIGHT", "Z".repeat(42)])(
    "accepts %s",
    (name) => {
      expect(isAddressableAbapObjectName(name)).toBe(true);
    },
  );

  it.each([
    "$1FOO",
    "$",
    "Z$FOO",
    "$/DMO/FOO",
    "$TMP/SUB",
    "/DMO/$FOO",
    "_FOO",
    "ZGRP/ZFM",
    "A/B",
    "/DMO/",
    "ZFOO/",
    "",
    "ZFOO.",
    "Z FOO",
    "ZFOO\nX",
  ])("rejects %j", (name) => {
    expect(isAddressableAbapObjectName(name)).toBe(false);
  });

  it("refuses /DMO/$FOO even though a leading $ and a leading /NS/ are each fine alone", () => {
    // The $-branch and the namespace-branch are mutually exclusive by design —
    // isValidAbapIdentifier itself would accept the combination if a caller
    // asked for both at once, which is exactly why the wrapper picks one
    // branch instead of passing {allowNamespace: true, allowLocal: true}.
    expect(isAddressableAbapObjectName("/DMO/$FOO")).toBe(false);
    expect(
      isValidAbapIdentifier("/DMO/$FOO", { allowNamespace: true, allowLocal: true }),
    ).toBe(true);
  });
});

describe("the object-name rule has one home", () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "adt");
  const resolveSrc = readFileSync(join(srcDir, "resolve.ts"), "utf8");
  const writeSrc = readFileSync(join(srcDir, "write.ts"), "utf8");

  it("neither resolve.ts nor write.ts declares its own NAME_RE", () => {
    // write.ts legitimately declares PACKAGE_REF_NAME_RE, an unrelated regex
    // for scraping <adtcore:packageRef name="..."/> — must not trip on that.
    expect(resolveSrc).not.toMatch(/\bconst\s+NAME_RE\s*=/);
    expect(writeSrc).not.toMatch(/\bconst\s+NAME_RE\s*=/);
  });

  it("both defer to the shared isAddressableAbapObjectName", () => {
    expect(resolveSrc).toContain("isAddressableAbapObjectName");
    expect(writeSrc).toContain("isAddressableAbapObjectName");
  });
});

describe("write path: the per-type length message survives the shared grammar check", () => {
  it("reports the DDIC 16-character limit, not a flat grammar refusal", async () => {
    const e = await catchErr(
      resolveWriteTarget(offline, { type: "TABL/DT", name: "ZMCP_WAY_TOO_LONG_TABLE" }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toMatch(/23 characters/);
    expect(e.message).toMatch(/limited to 16/);
    expect(e.message).not.toMatch(/is not a valid ABAP object name/);
    expect(e.details.maxLength).toBe(16);
    expect(e.hint).toMatch(/DDIC table names max out at 16 characters/);
  });

  it("reports the class 30-character limit, not a flat grammar refusal", async () => {
    const name = "ZMCP_A_CLASS_NAME_OVER_THIRTY_CHARACTERS_LONG";
    const e = await catchErr(resolveWriteTarget(offline, { type: "CLAS/OC", name }));
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toMatch(new RegExp(`${name.length} characters`));
    expect(e.message).toMatch(/limited to 30/);
    expect(e.message).not.toMatch(/is not a valid ABAP object name/);
    expect(e.details.maxLength).toBe(30);
  });
});

describe("a leading underscore is refused end-to-end", () => {
  // Deliberate tightening, not a regression: a real ABAP repository object
  // name can never start with `_`, and nothing pinned the old acceptance.
  it("parseObjectRef throws BAD_INPUT for _FOO", () => {
    expect(() => parseObjectRef("_FOO")).toThrow(AbapError);
    try {
      parseObjectRef("_FOO");
      throw new Error("expected parseObjectRef to throw");
    } catch (e) {
      expect(isAbapError(e)).toBe(true);
      expect((e as AbapError).code).toBe("BAD_INPUT");
    }
  });

  it("resolveWriteTarget refuses _FOO too", async () => {
    const e = await catchErr(resolveWriteTarget(offline, { type: "CLAS/OC", name: "_FOO" }));
    expect(e.code).toBe("BAD_INPUT");
  });
});
