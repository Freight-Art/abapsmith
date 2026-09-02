/**
 * `isValidAbapIdentifier`'s namespace-head regex required the
 * first character after the leading `/` to be a letter, so any
 * SAP-generated namespace — which begins with a digit, e.g. `/1BCDWB/`
 * (generated DB access / screen objects) and `/1CN/` — was refused as
 * `BAD_INPUT` before a request was ever made. These namespaces are real and
 * reachable on a live system (e.g. `/1CN/WS_ED_0000_CARRIER`). The fix
 * widens only the namespace-head character class to `[A-Za-z0-9]`; the
 * object-name part after the namespace still must start with a letter, and
 * `isSapNamespace` (which refuses any leading `/` for writes) is untouched.
 */
import { describe, expect, it } from "vitest";
import { parseObjectRef } from "../src/adt/resolve.js";
import {
  isAddressableAbapObjectName,
  isValidAbapIdentifier,
  SafetyGate,
} from "../src/safety.js";

const obj = (name: string, packageName?: string) => ({ name, packageName, type: "CLAS/OC" });

describe("SAP-generated namespaces beginning with a digit", () => {
  it("isValidAbapIdentifier accepts them with allowNamespace", () => {
    expect(isValidAbapIdentifier("/1BCDWB/DBZFOO", { allowNamespace: true })).toBe(true);
    expect(isValidAbapIdentifier("/1CN/WS_ED_0000_CARRIER", { allowNamespace: true })).toBe(true);
    expect(isValidAbapIdentifier("/1BCDWB/DB_SOMETHING", { allowNamespace: true })).toBe(true);
    // No regression: an ordinary letter-led namespace still passes.
    expect(isValidAbapIdentifier("/DMO/CL_FLIGHT", { allowNamespace: true })).toBe(true);
  });

  it("isAddressableAbapObjectName accepts them", () => {
    expect(isAddressableAbapObjectName("/1BCDWB/DBZFOO")).toBe(true);
    expect(isAddressableAbapObjectName("/1CN/WS_ED_0000_CARRIER")).toBe(true);
    expect(isAddressableAbapObjectName("/1BCDWB/DB_SOMETHING")).toBe(true);
    expect(isAddressableAbapObjectName("/DMO/CL_FLIGHT")).toBe(true);
  });

  it("parseObjectRef resolves them instead of throwing BAD_INPUT", () => {
    expect(() => parseObjectRef("/1BCDWB/DBZFOO")).not.toThrow();
    const parsed = parseObjectRef("/1cn/ws_ed_0000_carrier");
    expect(parsed.name).toBe("/1CN/WS_ED_0000_CARRIER");
  });

  it("still refuses an object part that does not start with a letter", () => {
    expect(isValidAbapIdentifier("/1BCDWB/9FOO", { allowNamespace: true })).toBe(false);
    expect(isAddressableAbapObjectName("/1BCDWB/9FOO")).toBe(false);
  });

  it("still refuses an empty object part", () => {
    expect(isValidAbapIdentifier("/1BCDWB/", { allowNamespace: true })).toBe(false);
    expect(isAddressableAbapObjectName("/1BCDWB/")).toBe(false);
  });

  it("still refuses a $ object part inside a digit-led namespace", () => {
    expect(isAddressableAbapObjectName("/1BCDWB/$FOO")).toBe(false);
  });

  it("does not open any other injection shape — the widening is head-only", () => {
    const stillRefused = [
      "/1CN/",
      "/CL_FLIGHT",
      "A/B",
      "/1CN/WS.X",
      "/1CN/WS X",
      "/1CN/WS'X",
      "/1CN/WS\nX",
    ];
    for (const bad of stillRefused) {
      expect(isAddressableAbapObjectName(bad), `${JSON.stringify(bad)} must be refused`).toBe(
        false,
      );
      expect(
        isValidAbapIdentifier(bad, { allowNamespace: true }),
        `${JSON.stringify(bad)} must be refused`,
      ).toBe(false);
    }
  });
});

describe("the read/write split survives the grammar widening", () => {
  // Widening isValidAbapIdentifier only changes what CAN BE NAMED / read —
  // it deliberately does not open a write path, because isSapNamespace
  // refuses any name starting with "/" independently of the grammar rule.
  // A permissive gate (write allowed, wide-open prefixes/packages) must
  // still deny a write to a digit-led SAP-generated namespace.
  const permissive = () =>
    new SafetyGate({
      readOnly: false,
      allowPackages: ["*"],
      allowNamePrefixes: ["*"],
    });

  it("denies write to /1BCDWB/DBZFOO with rule 'SAP namespace denied'", () => {
    const g = permissive();
    const decision = g.evaluate("write", obj("/1BCDWB/DBZFOO", "$TMP"));
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toMatch(/SAP namespace denied/);
  });

  it("denies write to /1CN/WS_ED_0000_CARRIER with rule 'SAP namespace denied'", () => {
    const g = permissive();
    const decision = g.evaluate("write", obj("/1CN/WS_ED_0000_CARRIER", "$TMP"));
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toMatch(/SAP namespace denied/);
  });
});
