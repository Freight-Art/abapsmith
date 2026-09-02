/**
 * Safety gate. Dormant at first but tested now, so the day writes are
 * switched on the gate is already trustworthy.
 */
import { describe, expect, it } from "vitest";
import {
  SafetyGate,
  extractSqlViewName,
  isEnhancementType,
  isInvocationTarget,
  isSapPackage,
  isUnrestrictedPrefixList,
  isValidAbapIdentifier,
  packagePattern,
  type EnhancementIntent,
} from "../src/safety.js";

const obj = (name: string, packageName?: string) => ({ name, packageName, type: "CLAS/OC" });

describe("packagePattern", () => {
  it("supports wildcards and is case-insensitive", () => {
    expect(packagePattern("Z*").test("ZFOO")).toBe(true);
    expect(packagePattern("Z*").test("zfoo")).toBe(true);
    expect(packagePattern("Z*").test("SAPBC")).toBe(false);
    expect(packagePattern("ZFOO_*").test("ZFOO_BAR")).toBe(true);
    expect(packagePattern("ZFOO_*").test("ZFOOBAR")).toBe(false);
    expect(packagePattern("$TMP").test("$TMP")).toBe(true);
    expect(packagePattern("$TMP").test("$TMPX")).toBe(false);
  });
});

describe("isSapPackage", () => {
  it("treats Z/Y and $-local packages as customer-owned", () => {
    expect(isSapPackage("ZFOO")).toBe(false);
    expect(isSapPackage("YBAR")).toBe(false);
    expect(isSapPackage("$TMP")).toBe(false);
    expect(isSapPackage("$DEMO_SOI_DRAFT")).toBe(false);
  });

  it("treats SAP application and namespace packages as SAP-owned", () => {
    expect(isSapPackage("SAPBC_DATAMODEL")).toBe(true);
    expect(isSapPackage("BF")).toBe(true);
    expect(isSapPackage("/DMO/FLIGHT")).toBe(true);
  });

  /**
   * The regression this file did not have.
   *
   * `SAP_PACKAGE_PREFIXES` shipped as A,B,C,E,F,G,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,
   * W,X — `D` and `H` were missing, so `isSapPackage("DEVELOPMENT")` and
   * `isSapPackage("HRTIM")` both answered *false* and the SAP-owner refusal never
   * fired for two whole letters of SAP standard content. Every prior test here
   * checked a handful of examples, and every one of those examples happened to
   * start with a letter that was present.
   *
   * So this asserts the RANGE, not examples: every letter A–X is SAP-owned and
   * only Y/Z (customer) and `$` (local) are not. A future edit that drops a
   * letter fails here regardless of which letter it is, which is the only way
   * an enumeration stays honest.
   */
  it("treats every non-customer letter A-X as SAP-owned, including D and H", () => {
    const sapOwned = [...Array(26).keys()]
      .map((i) => String.fromCharCode(65 + i))
      .filter((letter) => !["Y", "Z"].includes(letter));
    const missed = sapOwned.filter((letter) => !isSapPackage(`${letter}FOO_PKG`));
    expect(
      missed,
      `these package letters are not recognised as SAP-owned, so the SAP-owner rule never refuses them: ${missed.join(", ")}`,
    ).toEqual([]);

    // Named explicitly, so the two letters that were actually missing are
    // visible in the diff of any change that removes them again.
    expect(isSapPackage("DEVELOPMENT_TOOLS")).toBe(true);
    expect(isSapPackage("HRTIM")).toBe(true);

    // And the customer letters are still customer letters — the fix widens the
    // denylist, it must not swallow Z/Y or $-local.
    expect(isSapPackage("ZFOO")).toBe(false);
    expect(isSapPackage("YFOO")).toBe(false);
    expect(isSapPackage("$TMP")).toBe(false);
  });
});

describe("SafetyGate", () => {
  it("always allows reads", () => {
    const g = new SafetyGate({ readOnly: true, allowPackages: [] });
    expect(g.evaluate("read", obj("ZCL_FOO", "$TMP")).allowed).toBe(true);
    expect(() => g.assert("read")).not.toThrow();
  });

  it("blocks every mutating operation while read-only", () => {
    const g = new SafetyGate({ readOnly: true, allowPackages: ["Z*"] });
    for (const op of ["write", "activate", "delete", "execute", "transport"] as const) {
      const d = g.evaluate(op, obj("ZCL_FOO", "ZFOO"));
      expect(d.allowed).toBe(false);
      expect(d.rule).toMatch(/read-only/);
    }
    expect(() => g.assert("write", obj("ZCL_FOO", "ZFOO"))).toThrow(/read-only/i);
  });

  it("forces read-only on a productive system with no override", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["Z*", "$TMP"],
      productive: true,
    });
    const d = g.evaluate("write", obj("ZCL_FOO", "ZFOO"));
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/productive/);
  });

  it("denies the SAP namespace outright even when writes are enabled", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
    expect(g.evaluate("write", obj("/DMO/CL_FLIGHT", "$TMP")).rule).toMatch(/namespace/);
    expect(g.evaluate("write", obj("CL_ABAP_TYPEDESCR", "SABP_TYPES")).rule).toMatch(/namespace/);
  });

  it("requires a non-empty allowlist even when writes are enabled", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: [] });
    const d = g.evaluate("write", obj("ZCL_FOO", "ZFOO"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/allowlist/i);
  });

  it("allows a write only into an allowlisted customer package", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP", "ZFOO_*"] });
    expect(g.evaluate("write", obj("ZCL_A", "$TMP")).allowed).toBe(true);
    expect(g.evaluate("write", obj("ZCL_A", "ZFOO_BAR")).allowed).toBe(true);
    expect(g.evaluate("write", obj("ZCL_A", "ZOTHER")).allowed).toBe(false);
    expect(g.evaluate("write", obj("ZCL_A", undefined)).allowed).toBe(false);
  });

  /**
   * The default was changed to `["*"]` but `[]` still means deny-all —
   * `READ_CAPABILITIES` in src/mode.ts depends on that sentinel.
   */
  it("[] is still deny-all: refuses an otherwise-fine write, attributed to the missing allowlist", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: [] });
    const d = g.evaluate("write", obj("ZCL_A", "ZFOO"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/No package allowlist is configured/);
    expect(d.code).toBe("SAFETY_DENIED");
  });

  it('["*"] — the new default — permits writes into any customer package, not just $TMP', () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
    // packagePattern("*") expands to /.*/i.
    expect(g.evaluate("write", obj("ZCL_A", "$TMP")).allowed).toBe(true);
    expect(g.evaluate("write", obj("ZCL_A", "ZFOO_BAR")).allowed).toBe(true);
  });

  it('["*"] does not lift the SAP-owner or name-prefix rules — only the package allowlist', () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
    // SABP_TYPES: SAP-owned package fixture; isSapPackage runs ahead of the allowlist.
    const byPackage = g.evaluate("write", obj("ZCL_A", "SABP_TYPES"));
    expect(byPackage.allowed).toBe(false);
    expect(byPackage.rule).toMatch(/SAP namespace denied/);
    const byName = g.evaluate("write", obj("CL_ABAP_TYPEDESCR", "$TMP"));
    expect(byName.allowed).toBe(false);
    expect(byName.rule).toMatch(/object-name allowlist/);
  });

  // ---- the gate stops being dormant ------------------------------------------

  it("refuses a name outside the customer namespace, after the package rules", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    // Package is fine, name is not: this is the rule that stops the agent
    // dropping a Z-package copy of an SAP object name into $TMP.
    const d = g.evaluate("write", obj("CL_ABAP_TYPEDESCR", "$TMP"));
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/object-name allowlist/);
    expect(g.evaluate("write", obj("ZCL_A", "$TMP")).allowed).toBe(true);
    expect(g.evaluate("write", obj("YCL_A", "$TMP")).allowed).toBe(true);
  });

  it("honours a custom name-prefix allowlist", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      allowNamePrefixes: ["ZMCP_"],
    });
    expect(g.evaluate("write", obj("ZMCP_DEMO", "$TMP")).allowed).toBe(true);
    expect(g.evaluate("write", obj("ZOTHER_DEMO", "$TMP")).allowed).toBe(false);
    expect(g.namePrefixes).toEqual(["ZMCP_"]);
  });

  it("checks the name allowlist only after namespace and package (existing rules win)", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    // Both the package rule and the name rule would deny; the package rule must
    // be the one that reports, or the operator gets a misleading reason.
    expect(g.evaluate("write", obj("CL_ABAP_TYPEDESCR", "SABP_TYPES")).rule).toMatch(/namespace/);
    expect(g.evaluate("write", obj("CL_FOO", "ZOTHER")).rule).toMatch(/package allowlist/);
  });

  /**
   * The per-type name-prefix override (`Capability.namePrefixes`).
   *
   * This is not a policy preference: SAP itself refuses `POST` of a lock object
   * named `ZRECON_MLK1` with `400 ExceptionResourceCreationFailure` — *"Test
   * objects cannot be created in foreign namespaces"* — and accepts
   * `EZRECON_MLK1` (both halves captured live). Honouring the server's own rule locally turns a doomed
   * round trip into an immediate, explainable refusal.
   *
   * The thing that must not happen is the fix leaking: the global list stays
   * `["Z", "Y"]` for the other types, so `E…` is still refused everywhere else.
   */
  const typed = (name: string, type: string) => ({ name, packageName: "$TMP", type });

  it("judges ENQU/DL names against its own [EZ, EY] list, not the global one", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    expect(g.evaluate("write", typed("EZPROPW_LOCK", "ENQU/DL")).allowed).toBe(true);
    expect(g.evaluate("write", typed("EYPROPW_LOCK", "ENQU/DL")).allowed).toBe(true);
  });

  it("still refuses a bare Z… lock-object name — the name SAP itself rejects", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const d = g.evaluate("write", typed("ZPROPW_LOCK", "ENQU/DL"));
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/object-name allowlist/);
    // The refusal has to say WHOSE rule this is, or the operator goes looking
    // for a misconfigured ABAP_ALLOW_NAME_PREFIXES that is working correctly.
    expect(d.reason).toMatch(/ENQU\/DL/);
    expect(d.reason).toMatch(/EZ, EY/);
  });

  it("does not leak the override to any other type: E… is still refused for a class or a domain", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    for (const type of ["CLAS/OC", "PROG/P", "DOMA/DD", "TTYP/DA", "MSAG/N"]) {
      expect(g.evaluate("write", typed("EZ_SOMETHING", type)).allowed).toBe(false);
      expect(g.evaluate("write", typed("Z_SOMETHING", type)).allowed).toBe(true);
    }
    // …and an object with no type at all falls back to the global list.
    expect(g.evaluate("write", { name: "EZ_X", packageName: "$TMP" }).allowed).toBe(false);
    expect(g.evaluate("write", { name: "Z_X", packageName: "$TMP" }).allowed).toBe(true);
  });

  it("applies the per-type list even when the operator configured a custom global one", () => {
    // A per-type list states what the SERVER accepts, so an operator's global
    // list cannot make `ZMCP_LOCK` work — nor can it be what a lock object is
    // judged against.
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      allowNamePrefixes: ["ZMCP_"],
    });
    expect(g.evaluate("write", typed("ZMCP_LOCK", "ENQU/DL")).allowed).toBe(false);
    expect(g.evaluate("write", typed("EZMCP_LOCK", "ENQU/DL")).allowed).toBe(true);
    // Unchanged for everything else.
    expect(g.evaluate("write", typed("ZMCP_DEMO", "CLAS/OC")).allowed).toBe(true);
    expect(g.namePrefixes).toEqual(["ZMCP_"]);
  });

  /**
   * `ABAP_ALLOW_NAME_PREFIXES=*` — the name rule as a preference, not a law.
   *
   * Plenty of installations keep customer code outside `Z`/`Y` (a reserved
   * `/NSP/` namespace, an inherited `A…`/`B…` convention). For them the
   * name check refuses everything they own, and the only escape was to enumerate
   * prefixes. The wildcard turns the rule off — and must turn off nothing else,
   * which is what the next two tests exist to pin.
   */
  const wild = () =>
    new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], allowNamePrefixes: ["*"] });

  it("permits a name outside Z/Y under the wildcard", () => {
    const g = wild();
    expect(g.evaluate("write", obj("ACME_THING", "$TMP")).allowed).toBe(true);
    expect(g.evaluate("write", obj("CL_ABAP_TYPEDESCR", "$TMP")).allowed).toBe(true);
    // …and does not stop permitting the ordinary ones.
    expect(g.evaluate("write", obj("ZCL_A", "$TMP")).allowed).toBe(true);
    // A registered `/NS/` name is still refused: that is `isSapNamespace`, a
    // rule the wildcard is not allowed to reach (next test).
    expect(g.evaluate("write", obj("/ACME/THING", "$TMP")).allowed).toBe(false);
  });

  it("does NOT let the wildcard reach the SAP-owner denial", () => {
    // The whole point of a carve-out: "my customer objects are not called Z*"
    // is not "let me edit SAP's". Both halves of the SAP rule must survive —
    // the reserved-namespace name and the SAP-owned package.
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP", "SABP_TYPES"],
      allowNamePrefixes: ["*"],
    });
    const byName = g.evaluate("write", obj("/SAPAPO/THING", "$TMP"));
    expect(byName.allowed).toBe(false);
    expect(byName.rule).toMatch(/SAP namespace denied/);
    const byPackage = g.evaluate("write", obj("ACME_THING", "SABP_TYPES"));
    expect(byPackage.allowed).toBe(false);
    expect(byPackage.rule).toMatch(/SAP namespace denied/);
  });

  it("still applies ENQU/DL's per-type list under the wildcard", () => {
    // `["EZ","EY"]` is the SERVER's rule, not this installation's convention,
    // so a wildcard — which only says "stop applying MY convention" — cannot
    // lift it. Honouring it locally saves a round trip that would come back
    // `ExceptionResourceCreationFailure` regardless.
    const g = wild();
    const d = g.evaluate("write", typed("ACME_LOCK", "ENQU/DL"));
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/object-name allowlist/);
    expect(d.reason).toMatch(/EZ, EY/);
    expect(g.evaluate("write", typed("EZACME_LOCK", "ENQU/DL")).allowed).toBe(true);
    // Every type WITHOUT an override is unrestricted, as asked.
    for (const type of ["CLAS/OC", "PROG/P", "DOMA/DD", "TTYP/DA", "MSAG/N"]) {
      expect(g.evaluate("write", typed("ACME_THING", type)).allowed).toBe(true);
    }
  });

  it("recognises exactly the wildcard as unrestricted, and nothing that merely looks like it", () => {
    // The predicate `src/config.ts` shares for its startup banner. `Z*` is a
    // prefix that happens to contain a star, not a wildcard: `ABAP_ALLOW_PACKAGES`
    // takes `*` as a glob mid-string and this flag never has, so a list entry
    // is only unrestricted when it IS the token.
    expect(isUnrestrictedPrefixList(["*"])).toBe(true);
    expect(isUnrestrictedPrefixList([" * "])).toBe(true);
    expect(isUnrestrictedPrefixList(["Z", "*"])).toBe(true);
    expect(isUnrestrictedPrefixList(["Z", "Y"])).toBe(false);
    expect(isUnrestrictedPrefixList([])).toBe(false);
    expect(isUnrestrictedPrefixList(["Z*"])).toBe(false);
    expect(isUnrestrictedPrefixList(["**"])).toBe(false);
  });

  it("treats a wildcard mixed into a list as unrestricted", () => {
    // `["Z", "*"]` cannot coherently mean anything narrower than "*".
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      allowNamePrefixes: ["Z", "*"],
    });
    expect(g.evaluate("write", obj("ACME_THING", "$TMP")).allowed).toBe(true);
  });

  it("tells a caller who hits the name gate that the wildcard exists", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const d = g.evaluate("write", obj("ACME_THING", "$TMP"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/ABAP_ALLOW_NAME_PREFIXES/);
    expect(d.reason).toContain("*");
  });

  it("keeps an undetermined system role read-only unless the operator opted in", () => {
    // PHASE0-STATUS.md: ato/settings names no role on this release, so
    // `unknown` is the *normal* answer, not an anomaly.
    const locked = new SafetyGate({ readOnly: true, allowPackages: ["$TMP"], systemRole: "unknown" });
    const d = locked.evaluate("write", obj("ZCL_A", "$TMP"));
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("READ_ONLY");

    const optedIn = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      systemRole: "unknown",
    });
    expect(optedIn.evaluate("write", obj("ZCL_A", "$TMP")).allowed).toBe(true);
  });

  it("treats a productive systemRole as a hard stop even with writes enabled", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      systemRole: "productive",
    });
    const d = g.evaluate("write", obj("ZCL_A", "$TMP"));
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/productive/);
  });

  it("defers only the package rules in the pre-flight phase", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const pre = { phase: "preflight" } as const;

    // Package unknown at pre-flight time → allowed through to the final check.
    expect(g.evaluate("write", obj("ZCL_A", undefined), pre).allowed).toBe(true);
    // …but everything else is still decided without a connection.
    expect(g.evaluate("write", obj("/DMO/CL_X", undefined), pre).rule).toMatch(/namespace/);
    expect(g.evaluate("write", obj("CL_ABAP_TYPEDESCR", undefined), pre).rule).toMatch(/object-name/);
    expect(g.evaluate("write", obj("ZCL_A", "ZOTHER"), pre).rule).toMatch(/package allowlist/);
    // Read-only still short-circuits everything.
    const ro = new SafetyGate({ readOnly: true, allowPackages: ["$TMP"] });
    expect(ro.evaluate("write", obj("ZCL_A", undefined), pre).allowed).toBe(false);
  });

  it("throws READ_ONLY for the read-only rules and SAFETY_DENIED for the rest", () => {
    const ro = new SafetyGate({ readOnly: true, allowPackages: ["$TMP"] });
    expect(() => ro.assert("write", obj("ZCL_A", "$TMP"))).toThrow(
      expect.objectContaining({ code: "READ_ONLY" }),
    );
    const open = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    expect(() => open.assert("write", obj("ZCL_A", "ZOTHER"))).toThrow(
      expect.objectContaining({ code: "SAFETY_DENIED" }),
    );
  });

  it("can be flipped to productive at runtime after the connect probe", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    expect(g.evaluate("write", obj("ZCL_A", "$TMP")).allowed).toBe(true);
    g.update({ productive: true });
    expect(g.evaluate("write", obj("ZCL_A", "$TMP")).allowed).toBe(false);
  });

  /**
   * A write lockout must be un-forgettable.
   *
   * `src/server.ts` copies the connection's probe verdict onto the gate after
   * EVERY successful primary logon, and the primary connection is re-seatable:
   * when the pool replaces a dead primary, the fresh `AbapConnection` starts
   * with an empty detection cache and re-probes from scratch. So the gate can
   * genuinely be handed `writesLockedOut: true` and then, minutes later,
   * `writesLockedOut: false` for what is nominally the same system.
   *
   * Detection is not what is on trial here — an inconclusive re-probe already
   * locks writes rather than opening them. What is on trial is whether the GATE
   * can forget a lockout it was already told about. It must not: the cost of
   * staying wrongly locked is operator inconvenience, the cost of wrongly
   * unlocking is an unauthorised write to a production system.
   *
   * Written against `evaluate()` rather than against `config`, because what
   * matters is that the write is still refused, however the flag is stored.
   */
  it("never forgets a write lockout: update() cannot re-open writes", () => {
    const productiveProbe = 'T000-CCCATEGORY = "P" for logon client 000.';
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      productive: true,
      systemRole: "productive",
      writesLockedOut: true,
      lockoutReason: productiveProbe,
    });
    expect(g.evaluate("write", obj("ZCL_A", "$TMP")).allowed).toBe(false);

    // A re-seated primary re-probes and this time decides the system is a
    // sandbox. The whole verdict arrives at once, exactly as server.ts sends it.
    g.update({
      productive: false,
      systemRole: "test",
      writesLockedOut: false,
      lockoutReason: 'T000-CCCATEGORY = "C" (not "P") for logon client 001.',
    });

    const d = g.evaluate("write", obj("ZCL_A", "$TMP"));
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("READ_ONLY");
    // The lockout kept its own evidence too: a latched refusal quoting the
    // contradicting probe would argue against itself.
    expect(g.config.writesLockedOut).toBe(true);
    expect(g.config.lockoutReason).toBe(productiveProbe);
    expect(d.reason).not.toMatch(/not "P"/);

    // Unrelated fields still merge normally, and a lockout survives a patch
    // that says nothing about it at all.
    g.update({ allowPackages: ["ZFOO_*"] });
    expect(g.config.allowPackages).toEqual(["ZFOO_*"]);
    expect(g.evaluate("write", obj("ZFOO_A", "ZFOO_PKG")).allowed).toBe(false);
  });

  it("only the deliberate escape hatch clears a lockout, and it demands a reason", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      writesLockedOut: true,
      lockoutReason: "probe returned 403.",
    });
    expect(() => g.resetWriteLockout("  ")).toThrow(/non-empty reason/);
    expect(g.evaluate("write", obj("ZCL_A", "$TMP")).allowed).toBe(false);

    g.resetWriteLockout("operator confirmed A4H sandbox out of band");
    expect(g.evaluate("write", obj("ZCL_A", "$TMP")).allowed).toBe(true);
    expect(g.writeLockoutResets).toEqual(["operator confirmed A4H sandbox out of band"]);

    // The reset is not permission for the future: the next probe verdict
    // re-locks, and latches again.
    g.update({ writesLockedOut: true, lockoutReason: "probe returned 403." });
    g.update({ writesLockedOut: false, lockoutReason: "sandbox" });
    expect(g.evaluate("write", obj("ZCL_A", "$TMP")).allowed).toBe(false);
  });

  it("resetWriteLockout does not clear a proven-productive verdict", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      productive: true,
      writesLockedOut: true,
      lockoutReason: 'T000-CCCATEGORY = "P".',
    });
    g.resetWriteLockout("operator insists this is a sandbox");
    const d = g.evaluate("write", obj("ZCL_A", "$TMP"));
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe("productive → read-only");
  });

  /**
   * A refusal must never assert something the evidence it is carrying
   * contradicts.
   *
   * `escalateIfAtoSaysProductive` (src/adt/connection.ts) can produce exactly
   * that trap. When the T000 probe concludes NON-productive but `ato/settings`
   * then reports `isProductionSystem="X"`, it builds a fresh detection with
   * `role: "productive"` while carrying the T000 verdict verbatim into a
   * composite reason. Because `src/server.ts` copies that string into
   * `lockoutReason` and sets `writesLockedOut` at the same time,
   * `writesLockedOut: true` genuinely arrives alongside CONCLUSIVE
   * non-productive evidence.
   *
   * The `writesLockedOut` refusal opens "This system could not be proven
   * non-productive" and then quotes `lockoutReason`. Fired on this config it
   * would print a sentence and immediately quote its own refutation —
   * `CCCATEGORY = "C" (not "P")` is precisely a proof of non-productiveness.
   * The user would be told the probe was inconclusive while reading the
   * conclusive result.
   *
   * Nothing but branch ORDER prevents that: the productive check sits first and
   * never interpolates `lockoutReason`. Today's behaviour is correct; this test
   * exists so it stays correct, and is written against the invariant (which
   * refusal wins, and what it must not claim) rather than against the wording,
   * so that reordering the two branches turns it red.
   */
  it("prefers the productive refusal when lockout evidence proves the opposite", () => {
    const t000SaysNotProductive = 'T000-CCCATEGORY = "C" (not "P") for logon client 001.';
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      // Exactly the shape `escalateIfAtoSaysProductive` + the connect probe
      // hand to the gate: productive AND locked out AND holding proof of
      // non-productiveness, all at once.
      productive: true,
      writesLockedOut: true,
      lockoutReason: `ato/settings reports isProductionSystem="X". (T000 probe said: ${t000SaysNotProductive})`,
    });

    const d = g.evaluate("write", obj("ZCL_A", "$TMP"));
    expect(d.allowed).toBe(false);

    // The invariant proper, asserted FIRST so that a branch reorder is caught
    // by the semantic claim rather than merely by a changed rule string: the
    // refusal must not tell the user the system could not be proven
    // non-productive, and must not quote the evidence that refutes that.
    expect(d.reason).not.toMatch(/could not be proven non-productive/i);
    expect(d.reason).not.toContain(t000SaysNotProductive);
    expect(d.reason).not.toMatch(/not "P"/);

    // And the productive branch is the one that must have answered.
    expect(d.rule).toBe("productive → read-only");
    expect(d.rule).not.toMatch(/unproven/);
  });

  describe("package creation: own name gates the SAP-owner/prefix rules, superpackage gates the allowlist", () => {
    it("COURSES is still SAP-owned — the heuristic is unweakened", () => {
      expect(isSapPackage("COURSES")).toBe(true);
      expect(isSapPackage("ZSD_ORDER")).toBe(false);
      expect(isSapPackage("$TMP")).toBe(false);
    });

    /**
     * THE regression test for the bug this whole describe block exists to
     * pin: a `DEVC/K` create's `packageRef` is itself, so the package
     * allowlist — "which container may this write land in" — has nothing to
     * judge on `packageName` for a create. It must consult `superPackage`
     * instead. Before the fix this target was refused unconditionally: no
     * finite allowlist could ever contain a not-yet-created package's own
     * name, so `ZSD_ORDER` failed here even with `allowPackages: ["Z*"]`
     * covering it by name, because the ROOT-package branch fired first.
     */
    it("approves a Z package created beneath an allowlisted SAP-prefixed superpackage", () => {
      const g = new SafetyGate({ readOnly: false, allowPackages: ["COURSES"] });
      // COURSES is the real hierarchy parent (`superPackage`), present here
      // exactly as `preflight()`/`resolveWriteTarget()` produce it. The own
      // name stays `packageName`, per the design pinned in
      // test/write-package.test.ts's "gives a new package its OWN name…" test.
      const target = {
        name: "ZSD_ORDER",
        packageName: "ZSD_ORDER",
        type: "DEVC/K",
        superPackage: "COURSES",
      };
      const d = g.evaluate("write", target);
      expect(d.allowed).toBe(true);
      // The reason names the SUPERpackage, not the own name — proof the
      // right thing was actually checked, not merely a correct verdict for
      // the wrong reason.
      expect(d.reason).toContain("COURSES");
    });

    it("still refuses a package outright if COURSES itself is targeted (the SAP-owner check judges the OWN name)", () => {
      const g = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
      const target = {
        name: "COURSES",
        packageName: "COURSES",
        type: "DEVC/K",
        superPackage: "SOME_ROOT",
      };
      const d = g.evaluate("write", target);
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/SAP-owned/);
    });

    it("refuses a non-Z own name even when the superpackage is allowlisted", () => {
      const g = new SafetyGate({ readOnly: false, allowPackages: ["COURSES", "$TMP"] });
      const target = {
        name: "SD_ORDER",
        packageName: "SD_ORDER",
        type: "DEVC/K",
        superPackage: "COURSES",
      };
      // "SD_ORDER" is judged on its own name and starts with "S" — one of
      // SAP_PACKAGE_PREFIXES — so isSapPackage() flags it as SAP-owned before
      // the (allowlisted) superpackage is ever consulted. Proves the fix did
      // not widen the SAP-owner rule.
      const d = g.evaluate("write", target);
      expect(d.allowed).toBe(false);
      expect(d.code).toBe("SAFETY_DENIED");
      expect(d.reason).toMatch(/SAP-owned/);
    });

    it("refuses a package create whose superpackage is outside the allowlist, and names the SUPERPACKAGE", () => {
      const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP", "ZFOO_*"] });
      const target = {
        name: "ZSD_ORDER",
        packageName: "ZSD_ORDER",
        type: "DEVC/K",
        superPackage: "COURSES",
      };
      const d = g.evaluate("write", target);
      expect(d.allowed).toBe(false);
      expect(d.code).toBe("SAFETY_DENIED");
      expect(d.rule).toMatch(/package allowlist/);
      // The load-bearing assertion: the message names the container that was
      // actually judged (COURSES), not the package's own name (ZSD_ORDER) —
      // which is in no allowlist here either, but is not what was checked.
      expect(d.reason).toContain("COURSES");
      expect(d.reason).not.toContain("ZSD_ORDER is not in the allowlist");
    });

    /**
     * The relaxation: `allowPackages: ["*"]`'s literal `*` entry means "any
     * container, including none, is fine" — this used to be refused
     * unconditionally; the tests below pin how narrowly this is scoped.
     */
    it("allows a root package create under a wildcard allowlist", () => {
      const g = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
      const target = { name: "ZSD_ORDER", packageName: "ZSD_ORDER", type: "DEVC/K" };
      const d = g.evaluate("write", target);
      expect(d.allowed).toBe(true);
    });

    /**
     * An approval must cost ZERO network requests, just like a refusal: the
     * superpackage is known synchronously from raw args, so nothing is
     * deferred to a resolve GET — this must fire in the pre-flight phase too.
     */
    it("the root-package wildcard approval fires at pre-flight too — it is never deferred", () => {
      const g = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
      const target = { name: "ZSD_ORDER", packageName: "ZSD_ORDER", type: "DEVC/K" };
      const pre = g.evaluate("write", target, { phase: "preflight" });
      expect(pre.allowed).toBe(true);
    });

    /**
     * A NAMED allowlist without the literal `*` entry is exactly the case
     * the relaxation must NOT touch: `COURSES` and `$TMP` are container
     * names, and "no container" cannot match either of them. This is the
     * refusal that fired before the fix too — unchanged.
     */
    it("still refuses a root package create under a named (non-wildcard) allowlist", () => {
      const g = new SafetyGate({ readOnly: false, allowPackages: ["COURSES", "$TMP"] });
      const target = { name: "ZSD_ORDER", packageName: "ZSD_ORDER", type: "DEVC/K" };
      const d = g.evaluate("write", target);
      expect(d.allowed).toBe(false);
      expect(d.code).toBe("SAFETY_DENIED");
      expect(d.rule).toBe("package allowlist");
      expect(d.reason).toMatch(/ROOT package/);
    });

    /**
     * The refusal above is not just correct, it must be actionable: an
     * operator who hits it should not have to go spelunking in source to
     * learn that `*` is the escape hatch. The reason names the exact env var
     * and syntax that would fix it.
     */
    it("the root-package refusal names the remedy: ABAP_ALLOW_PACKAGES='*'", () => {
      const g = new SafetyGate({ readOnly: false, allowPackages: ["COURSES", "$TMP"] });
      const target = { name: "ZSD_ORDER", packageName: "ZSD_ORDER", type: "DEVC/K" };
      const d = g.evaluate("write", target);
      expect(d.allowed).toBe(false);
      expect(d.reason).toContain("ABAP_ALLOW_PACKAGES='*'");
    });

    /**
     * `Z*` is a PATTERN, not the wildcard token: `packagePattern("Z*")` is
     * `/^Z.*$/`, which matches real names but not "no container at all."
     * Only the literal `*` list entry means "no container is fine too."
     */
    it("does not treat a `Z*` pattern entry as the wildcard: a root create is still refused", () => {
      const g = new SafetyGate({ readOnly: false, allowPackages: ["Z*"] });
      const target = { name: "ZSD_ORDER", packageName: "ZSD_ORDER", type: "DEVC/K" };
      const d = g.evaluate("write", target);
      expect(d.allowed).toBe(false);
      expect(d.code).toBe("SAFETY_DENIED");
      expect(d.reason).toMatch(/ROOT package/);
    });

    /**
     * The trap: an allowlist entry of `""` compiles via `packagePattern` to
     * `/^$/`, which WOULD match a root create's empty container string. Only
     * the literal `*` entry may open the root door — never an accident of
     * what an empty pattern happens to match.
     */
    it("does not let an empty-string allowlist entry act as the wildcard via its `/^$/` pattern", () => {
      const g = new SafetyGate({ readOnly: false, allowPackages: [""] });
      const target = { name: "ZSD_ORDER", packageName: "ZSD_ORDER", type: "DEVC/K" };
      const d = g.evaluate("write", target);
      expect(d.allowed).toBe(false);
      expect(d.code).toBe("SAFETY_DENIED");
      expect(d.reason).toMatch(/ROOT package/);
    });

    /**
     * An empty allowlist refuses everything before the root-package check is
     * reached — "no allowlist configured" and "no matching container" are
     * different failures and must not be conflated in the operator-facing
     * message.
     */
    it("an empty allowlist refuses a root package create with its own message, not the ROOT-package one", () => {
      const g = new SafetyGate({ readOnly: false, allowPackages: [] });
      const target = { name: "ZSD_ORDER", packageName: "ZSD_ORDER", type: "DEVC/K" };
      const d = g.evaluate("write", target);
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/No package allowlist is configured/);
      expect(d.reason).not.toMatch(/ROOT package/);
    });

    /**
     * The wildcard relaxes the CONTAINER rule only; later checks (here, the
     * customer-namespace prefix rule against the package's OWN name) still
     * apply in full — `$TMP` isn't SAP-owned but also isn't `Z`/`Y`-prefixed,
     * so it's refused by a different, later rule. Not a blanket pass.
     */
    it("under a wildcard allowlist, a root create is still refused if its OWN name fails a later rule", () => {
      const g = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
      const target = { name: "$TMP", packageName: "$TMP", type: "DEVC/K" };
      const d = g.evaluate("write", target);
      expect(d.allowed).toBe(false);
      expect(d.code).toBe("SAFETY_DENIED");
      expect(d.rule).toBe("object-name allowlist");
    });

    /**
     * Pre-flight and final phase must reach the SAME verdict for a package
     * create — allowed, refused-by-superpackage, and refused-by-own-name all
     * need to agree, or a refusal that only the final phase catches spends
     * exactly the network request the pre-flight phase exists to forbid.
     */
    it("pre-flight and final phase agree on every package-create verdict above", () => {
      const cases: Array<{ g: SafetyGate; target: Record<string, unknown> }> = [
        {
          g: new SafetyGate({ readOnly: false, allowPackages: ["COURSES"] }),
          target: { name: "ZSD_ORDER", packageName: "ZSD_ORDER", type: "DEVC/K", superPackage: "COURSES" },
        },
        {
          g: new SafetyGate({ readOnly: false, allowPackages: ["$TMP", "ZFOO_*"] }),
          target: { name: "ZSD_ORDER", packageName: "ZSD_ORDER", type: "DEVC/K", superPackage: "COURSES" },
        },
        {
          g: new SafetyGate({ readOnly: false, allowPackages: ["*"] }),
          target: { name: "ZSD_ORDER", packageName: "ZSD_ORDER", type: "DEVC/K" },
        },
        {
          g: new SafetyGate({ readOnly: false, allowPackages: ["COURSES", "$TMP"] }),
          target: { name: "SD_ORDER", packageName: "SD_ORDER", type: "DEVC/K", superPackage: "COURSES" },
        },
      ];
      for (const { g, target } of cases) {
        const pre = g.evaluate("write", target, { phase: "preflight" });
        const fin = g.evaluate("write", target);
        expect(fin.allowed, JSON.stringify(target)).toBe(pre.allowed);
        expect(fin.rule, JSON.stringify(target)).toBe(pre.rule);
      }
    });

    /**
     * An EXISTING package (`exists: true`, e.g. `writeObject`/`deleteObject`
     * probing an already-created one before refusing for other reasons) is
     * judged the old way: its own name IS its container, exactly like every
     * non-package object. `isPackageCreate` is `exists !== true` for exactly
     * this reason.
     */
    it("an EXISTING package is still gated on its own name, not a superpackage", () => {
      const g = new SafetyGate({ readOnly: false, allowPackages: ["ZSD_ORDER"] });
      const target = {
        name: "ZSD_ORDER",
        packageName: "ZSD_ORDER",
        type: "DEVC/K",
        exists: true,
        // A hostile/irrelevant superpackage that is NOT allowlisted — if this
        // were consulted instead of packageName the write would be refused.
        superPackage: "COURSES",
      };
      const d = g.evaluate("write", target);
      expect(d.allowed).toBe(true);
    });

    /**
     * `superPackage` is meaningful for `DEVC/K` creates only. Any other type
     * carrying it (which no real caller does, but the gate must not be
     * fooled by one that did) must still be judged on `packageName` — proof
     * the new field cannot be used to smuggle a write past the allowlist for
     * an ordinary object.
     */
    it("a non-DEVC/K object ignores superPackage entirely", () => {
      const g = new SafetyGate({ readOnly: false, allowPackages: ["ZSD_ORDER"] });
      const target = {
        name: "ZCL_FOO",
        packageName: "ZSD_ORDER",
        type: "CLAS/OC",
        // Not in the allowlist. If this were consulted the write would be
        // refused; it must not be — packageName is what governs here.
        superPackage: "COURSES",
      };
      const d = g.evaluate("write", target);
      expect(d.allowed).toBe(true);
      expect(d.reason).not.toContain("Superpackage");
    });

    it("refuses a package create outright on a productive system", () => {
      const g = new SafetyGate({
        readOnly: false,
        allowPackages: ["COURSES", "$TMP"],
        productive: true,
      });
      const target = {
        name: "ZSD_ORDER",
        packageName: "ZSD_ORDER",
        type: "DEVC/K",
        superPackage: "COURSES",
      };
      const d = g.evaluate("write", target);
      expect(d.allowed).toBe(false);
      expect(d.rule).toMatch(/productive/);
    });
  });
});

describe("isValidAbapIdentifier", () => {
  it("accepts ABAP object names and nothing else", () => {
    expect(isValidAbapIdentifier("ZCL_FOO")).toBe(true);
    expect(isValidAbapIdentifier("Z9")).toBe(true);
    expect(isValidAbapIdentifier("a_b_9")).toBe(true);
    // Must start with a letter.
    expect(isValidAbapIdentifier("9ZCL")).toBe(false);
    expect(isValidAbapIdentifier("_ZCL")).toBe(false);
    expect(isValidAbapIdentifier("")).toBe(false);
    // 30 is ENHNAME's width; the 31st character is refused.
    expect(isValidAbapIdentifier("Z".repeat(30))).toBe(true);
    expect(isValidAbapIdentifier("Z".repeat(31))).toBe(false);
    expect(isValidAbapIdentifier("Z".repeat(31), { maxLength: 40 })).toBe(true);
  });

  /**
   * The whole reason this predicate lives in the safety module. Identifiers are
   * substituted verbatim into ABAP that this server then activates and
   * executes, and the gate cannot read generated source — so a period, a quote
   * or a newline in a name is not a bad name, it is arbitrary code execution.
   */
  it("refuses the characters that would end an ABAP literal or statement", () => {
    const injections = [
      "ZCL.FOO",
      "ZCL_FOO.",
      "ZCL'FOO",
      "ZCL_FOO. DELETE FROM t",
      "ZCL_FOO\nDELETE FROM t",
      "ZCL_FOO\r",
      "ZCL_FOO\t",
      "ZCL FOO",
      " ZCL_FOO",
      "ZCL_FOO ",
      "ZCL-FOO",
      "ZCL_FOO)",
      "ZCL_FOO|",
      "ZCL_FOO{ x }",
      "ZCL_FOO;",
    ];
    for (const bad of injections) {
      expect(isValidAbapIdentifier(bad), `${JSON.stringify(bad)} must be refused`).toBe(false);
      expect(isValidAbapIdentifier(bad, { allowNamespace: true, allowLocal: true })).toBe(false);
    }
  });

  it("admits namespaces and $-local packages only when asked", () => {
    expect(isValidAbapIdentifier("/DMO/CL_FLIGHT")).toBe(false);
    expect(isValidAbapIdentifier("/DMO/CL_FLIGHT", { allowNamespace: true })).toBe(true);
    expect(isValidAbapIdentifier("$TMP")).toBe(false);
    expect(isValidAbapIdentifier("$TMP", { allowLocal: true })).toBe(true);
    // A slash that is not a well-formed namespace stays refused.
    expect(isValidAbapIdentifier("/CL_FLIGHT", { allowNamespace: true })).toBe(false);
    expect(isValidAbapIdentifier("A/B", { allowNamespace: true })).toBe(false);
  });
});

describe("isEnhancementType", () => {
  it("matches the whole enhancement family on the head of the type code", () => {
    for (const t of ["ENHO/XHH", "ENHS/XSB", "ENHC/XCB", "ENHP", "enho/xhh"]) {
      expect(isEnhancementType(t), t).toBe(true);
    }
    for (const t of ["CLAS/OC", "PROG/P", "DEVC/K", "DDLS/DF", undefined, ""]) {
      expect(isEnhancementType(t), String(t)).toBe(false);
    }
  });
});

describe("isInvocationTarget", () => {
  it("matches only TCODE, case-insensitively", () => {
    expect(isInvocationTarget("TCODE")).toBe(true);
    expect(isInvocationTarget("tcode")).toBe(true);
    expect(isInvocationTarget(" TCODE ")).toBe(true);
    for (const t of ["CLAS/OC", "PROG/P", "DEVC/K", "ENHO/XHH", "DDLS/DF", undefined, ""]) {
      expect(isInvocationTarget(t), String(t)).toBe(false);
    }
  });
});

/**
 * The live-reproduced SE16 defect: `press`'s target is a transaction code
 * (`type: "TCODE"`), not a repository object, so the customer-namespace
 * name-prefix rule ("must start with Z/Y") is categorically inapplicable —
 * `SE16` can never be renamed to satisfy it. `evaluate()` now carves invocation
 * targets (`isInvocationTarget`) out of that rule, the package allowlist, and
 * the transport allowlist, while leaving every ceiling ABOVE those rules
 * — productive lockout, `writesLockedOut`, the read-only/mode default, and the
 * SAP-namespace check — fully in force. Every test below pins one half of that
 * split: the SE16 case that used to be impossible to satisfy, and the four
 * ways the carve-out must NOT punch a hole all the way through.
 */
describe("SafetyGate: invocation targets (TCODE) skip repository-object rules", () => {
  const tcode = (name: string) => ({ name, type: "TCODE" });

  it("allows execute on a standard tcode (SE16) at admin mode with default ABAP_ALLOW_NAME_PREFIXES — the exact live regression", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["Z*"] });
    const d = g.evaluate("execute", tcode("SE16"));
    expect(d.allowed).toBe(true);
    expect(d.reason).toMatch(/invocation target/);
    expect(() => g.assert("execute", tcode("SE16"), { phase: "preflight" })).not.toThrow();
  });

  it("still refuses SE16 on a productive system — the carve-out does not punch through the productive ceiling", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["Z*"], productive: true });
    const d = g.evaluate("execute", tcode("SE16"));
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/productive/);
    expect(d.code).toBe("READ_ONLY");
  });

  it("still refuses SE16 when writes are locked out (system not proven non-productive)", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["Z*"],
      writesLockedOut: true,
      lockoutReason: "T000 probe returned no usable evidence.",
    });
    const d = g.evaluate("execute", tcode("SE16"));
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/unproven/);
    expect(d.code).toBe("READ_ONLY");
  });

  it("still refuses SE16 when the server is read-only (non-admin mode) — the carve-out is not a mode bypass", () => {
    const g = new SafetyGate({ readOnly: true, allowPackages: ["Z*"] });
    const d = g.evaluate("execute", tcode("SE16"));
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/read-only/);
    expect(d.code).toBe("READ_ONLY");
  });

  it("still refuses an SAP-namespace tcode (/BOFU/XYZ)", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["Z*"] });
    const d = g.evaluate("execute", tcode("/BOFU/XYZ"));
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/namespace/);
    expect(d.code).toBe("SAFETY_DENIED");
  });

  /**
   * The guard that the carve-out is keyed on `isInvocationTarget(obj.type)`
   * and did not disable the name-prefix rule generally: a plain repository
   * object reached through `execute` (e.g. `abap_run`'s execute mode) must
   * still be refused for sitting outside Z/Y, exactly as before this change.
   */
  it("regression: a repository-object execute target is still refused outside Z/Y", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["ZFOO"] });
    const d = g.evaluate("execute", { name: "SE16_PROG", packageName: "ZFOO", type: "PROG/P" });
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/object-name allowlist/);
    expect(d.code).toBe("SAFETY_DENIED");
  });

  it("regression: a repository-object execute target outside the package allowlist is still refused", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["ZFOO"] });
    const d = g.evaluate("execute", { name: "ZSE16_PROG", packageName: "ZOTHER", type: "PROG/P" });
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/package allowlist/);
    expect(d.code).toBe("SAFETY_DENIED");
  });
});

/**
 * The enhancement intent gate.
 *
 * These exist because of a specific hole: creating a BAdI spot/definition/
 * implementation cannot be done over ADT REST, so the feature generates a
 * throwaway `IF_OO_ADT_CLASSRUN` class and POSTs it to the classrun endpoint.
 * The only object with a URI on that route is the `$TMP` helper, which passes
 * every URI-shaped rule trivially; the enhancement, its spot and the SAP object
 * being intercepted are strings inside generated ABAP. Everything below is
 * about judging those strings BEFORE the ABAP exists.
 */
describe("SafetyGate.evaluateIntent", () => {
  /** A well-formed intent against a local customer object. */
  const intent = (patch: Partial<EnhancementIntent> = {}): EnhancementIntent => ({
    enhancementName: "ZENH_ORDER",
    enhancementPackage: "$TMP",
    spotName: "ZSPOT_ORDER",
    targetName: "ZCL_ORDER",
    targetPackage: "ZSD",
    targetMasterSystem: "A4H",
    ...patch,
  });

  /** Writes on, packages open, enhancements on, this system's own SID known. */
  const openGate = (patch: Record<string, unknown> = {}) =>
    new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP", "Z*"],
      allowEnhancements: true,
      enhanceTargets: "customer",
      originSystems: ["A4H"],
      ...patch,
    });

  it("refuses by default: writes enabled is not enhancements enabled", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP", "Z*"] });
    const d = g.evaluateIntent(intent());
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/enhancements need an explicit flag/);
    expect(d.reason).toMatch(/ABAP_ALLOW_ENHANCEMENTS/);
    // And it names the flag that is missing rather than the one that is set.
    expect(d.reason).toMatch(/ABAP_ALLOW_WRITE=true does not imply it/);
  });

  it("refuses when ABAP_ENHANCE_TARGETS is unset, even with the master switch on", () => {
    const g = openGate({ enhanceTargets: undefined });
    const d = g.evaluateIntent(intent());
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/enhancement target class/);
    expect(d.reason).toMatch(/ABAP_ENHANCE_TARGETS/);
  });

  it("allows a locally-originated customer target once both switches are on", () => {
    const d = openGate().evaluateIntent(intent());
    expect(d.allowed).toBe(true);
  });

  /**
   * `masterSystem` is a SID string, not a boolean, and "SAP" is merely the name
   * of SAP's own development system. Reading `masterSystem !== "SAP"` as
   * "customer content" waves every partner and third-party original through as
   * if it were local — the set of things that are not yours is open, the set of
   * things that are yours is closed and short.
   */
  it("does not treat a non-SAP SID as customer content", () => {
    const g = openGate();
    // A partner SID under ABAP_ENHANCE_TARGETS=customer is refused, exactly
    // like SAP content would be. `!== "SAP"` would have allowed it.
    const partner = g.evaluateIntent(intent({ targetMasterSystem: "PRT", targetPackage: "ZPARTNER" }));
    expect(partner.allowed).toBe(false);
    expect(partner.rule).toMatch(/outside ABAP_ENHANCE_TARGETS/);
    expect(partner.reason).toMatch(/partner or third-party/);
    expect(partner.reason).toMatch(/PRT/);
  });

  /**
   * Origin gate test matrix (isLocalOrigin's three-way test). These four
   * cases are the ones the fix for the previously-unsatisfiable
   * ABAP_ORIGIN_SYSTEMS default had to get right, in order:
   *   (a) absent masterSystem,
   *   (b) masterSystem equal to this system's own SID (ABAP_SID),
   *   (c) a genuinely foreign masterSystem with an empty allowlist — must
   *       STILL be refused, not swept in by the fix, and
   *   (d) a foreign masterSystem that IS allowlisted.
   * See {@link SafetyGate.isLocalOrigin} in src/safety.ts for the predicate
   * these exercise.
   */
  describe("origin gate: isLocalOrigin three-way test", () => {
    it("(a) treats an absent target masterSystem as local, not as a refusal", () => {
      // A never-transported $TMP object has no adtcore:masterSystem at all —
      // this is the single most common case, and used to be an outright,
      // un-overridable refusal ("origin unknown") no allowlist could open.
      const d = openGate().evaluateIntent(intent({ targetMasterSystem: undefined }));
      expect(d.allowed).toBe(true);
      expect(d.reason).toMatch(/locally-originated/);
    });

    it("(b) treats a target masterSystem equal to this system's own SID as local, even with an empty ABAP_ORIGIN_SYSTEMS", () => {
      // The server should know its own identity without being told: ABAP_SID
      // alone is enough, ABAP_ORIGIN_SYSTEMS need not repeat it.
      const g = openGate({ sid: "A4H", originSystems: [] });
      const d = g.evaluateIntent(intent({ targetMasterSystem: "A4H" }));
      expect(d.allowed).toBe(true);
      expect(d.reason).toMatch(/locally-originated/);
    });

    it("(c) still refuses a genuinely foreign target masterSystem with an empty ABAP_ORIGIN_SYSTEMS and no matching own SID", () => {
      // An empty allowlist must not mean "deny all" (that was the bug), but it
      // must also not be over-corrected into "allow all" — a real foreign
      // system is still refused.
      const g = openGate({ sid: "A4H", originSystems: [] });
      const d = g.evaluateIntent(intent({ targetMasterSystem: "PRT", targetPackage: "ZPARTNER" }));
      expect(d.allowed).toBe(false);
      expect(d.rule).toMatch(/outside ABAP_ENHANCE_TARGETS/);
      expect(d.reason).toMatch(/PRT/);
    });

    it("(d) allows a foreign target masterSystem once it is named in ABAP_ORIGIN_SYSTEMS, without needing ABAP_ENHANCE_TARGETS=sap", () => {
      // ABAP_ORIGIN_SYSTEMS WIDENS locality — a former SID of this same
      // system counts as local, and a local target under
      // ABAP_ENHANCE_TARGETS=customer is allowed directly, unlike genuinely
      // partner/SAP content which additionally needs the sap-target ceiling.
      const g = openGate({ sid: "A4H", originSystems: ["OLDSID"] });
      const d = g.evaluateIntent(intent({ targetMasterSystem: "OLDSID" }));
      expect(d.allowed).toBe(true);
      expect(d.reason).toMatch(/locally-originated/);
    });
  });

  it("refuses an unresolved target instead of guessing", () => {
    const d = openGate().evaluateIntent(intent({ targetName: "ZCL_ORDER", targetPackage: "" }));
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/unresolved/);
  });

  it("requires BOTH targets=sap and a target-package entry for SAP content", () => {
    const sapTarget = intent({
      targetName: "CL_ABAP_TYPEDESCR",
      targetPackage: "SABP_TYPES",
      targetMasterSystem: "SAP",
    });
    // targets=customer: refused, and the refusal names both missing knobs.
    const asCustomer = openGate().evaluateIntent(sapTarget);
    expect(asCustomer.allowed).toBe(false);
    expect(asCustomer.reason).toMatch(/ABAP_ENHANCE_TARGETS=sap/);
    expect(asCustomer.reason).toMatch(/ABAP_ENHANCE_TARGET_PACKAGES/);

    // targets=sap alone: still refused — an empty package list is a deny-all,
    // not an absence of configuration.
    const half = openGate({ enhanceTargets: "sap" }).evaluateIntent(sapTarget);
    expect(half.allowed).toBe(false);
    expect(half.rule).toMatch(/enhanced-package allowlist \(fail closed\)/);

    // A list that does not name it: refused on the allowlist proper.
    const wrongPkg = openGate({
      enhanceTargets: "sap",
      enhanceTargetPackages: ["SFLIGHT*"],
    }).evaluateIntent(sapTarget);
    expect(wrongPkg.allowed).toBe(false);
    expect(wrongPkg.rule).toMatch(/enhanced-package allowlist/);

    // Both, and it passes.
    const both = openGate({
      enhanceTargets: "sap",
      enhanceTargetPackages: ["SABP_*"],
    }).evaluateIntent(sapTarget);
    expect(both.allowed).toBe(true);
  });

  it("names the origin system when it opts into partner content", () => {
    const d = openGate({
      enhanceTargets: "sap",
      enhanceTargetPackages: ["ZPARTNER"],
    }).evaluateIntent(intent({ targetMasterSystem: "PRT", targetPackage: "ZPARTNER" }));
    expect(d.allowed).toBe(true);
    // This is the case `!== "SAP"` would have silently called "customer": the
    // operator must be able to see which foreign system they just admitted.
    expect(d.reason).toMatch(/PRT/);
  });

  /**
   * The two knobs are independent in both directions (the transport allowlist's
   * rule, applied to the enhancement gate): a permissive enhance-target
   * allowlist must never let the artefact land in a package
   * `ABAP_ALLOW_PACKAGES` does not name.
   */
  it("does not let ABAP_ENHANCE_TARGET_PACKAGES widen ABAP_ALLOW_PACKAGES", () => {
    const g = openGate({
      allowPackages: ["$TMP"],
      enhanceTargets: "sap",
      enhanceTargetPackages: ["*"],
    });
    const d = g.evaluateIntent(intent({ enhancementPackage: "ZSOMEWHERE_ELSE" }));
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/package allowlist/);
  });

  it("keeps the un-overridable system ceilings above every enhancement flag", () => {
    const productive = openGate({ productive: true }).evaluateIntent(intent());
    expect(productive.allowed).toBe(false);
    expect(productive.rule).toBe("productive → read-only");

    const unproven = openGate({
      writesLockedOut: true,
      lockoutReason: "probe returned 403.",
    }).evaluateIntent(intent());
    expect(unproven.allowed).toBe(false);
    expect(unproven.rule).toMatch(/unproven/);
  });

  /**
   * An enhancement whose own master system is not ours is somebody else's
   * original, and changing it is a repair. No flag opens that.
   */
  it("refuses a repair of a foreign original with no override", () => {
    const g = openGate({
      enhanceTargets: "sap",
      enhanceTargetPackages: ["*"],
    });
    const d = g.evaluateIntent(intent({ enhancementMasterSystem: "SAP" }));
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/origin ceiling/);
    expect(d.reason).toMatch(/ABAP_ORIGIN_SYSTEMS/);
    // Own-SID artefacts are unaffected.
    expect(g.evaluateIntent(intent({ enhancementMasterSystem: "A4H" })).allowed).toBe(true);
  });

  /**
   * Round 2 message-bug fix (FIX-NOTES.md): `ownership === "sap"` is reached
   * via TWO disjoint paths in `enhancementRules()` — (1) a genuinely foreign
   * `targetMasterSystem` (always defined there — see the origin-gate matrix
   * above, "absent ⇒ local" means a foreign classification never has an
   * absent `targetMasterSystem`), and (2) a LOCALLY-originated object that is
   * merely SAP-NAMED (registered namespace, or an SAP-owned package by
   * prefix), where `targetMasterSystem` can be entirely absent. The old code
   * interpolated `targetOrigin` into "adding X to ABAP_ORIGIN_SYSTEMS is the
   * correct fix instead" unconditionally, which rendered literally as
   * "adding undefined to ABAP_ORIGIN_SYSTEMS" for path (2) — and was
   * actionable nonsense besides: the object is already local by
   * `isLocalOrigin`, so there is no foreign SID to register.
   */
  it("an SAP-named but LOCALLY-originated target (no targetMasterSystem) never says 'adding undefined to ABAP_ORIGIN_SYSTEMS'", () => {
    const g = openGate({ enhanceTargets: "customer" });
    const d = g.evaluateIntent(
      intent({
        targetName: "ZCL_LOCAL_BUT_SAP_NAMED",
        targetPackage: "SABC_PKG", // "S..." prefix: isSapPackage() true.
        targetMasterSystem: undefined, // never recorded — the absent case.
      }),
    );
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("ENHANCEMENT_TARGET_DENIED");
    expect(d.reason).not.toMatch(/\bundefined\b/);
    expect(d.reason).toMatch(/already locally-originated/);
    // The genuinely-foreign path (targetMasterSystem always defined there)
    // is unaffected and keeps its real remediation sentence.
    const foreign = g.evaluateIntent(
      intent({ targetName: "ZCL_FOREIGN", targetPackage: "SFOREIGN_PKG", targetMasterSystem: "PRT" }),
    );
    expect(foreign.allowed).toBe(false);
    expect(foreign.reason).toMatch(/adding PRT to ABAP_ORIGIN_SYSTEMS/);
  });

  /**
   * The identifiers in an intent are substituted verbatim into generated ABAP,
   * and this refusal happens before the master switch is even consulted — an
   * injection is refused whether or not enhancements are enabled.
   */
  it("refuses an identifier that would inject ABAP, ahead of every allowlist", () => {
    const g = openGate();
    const patches: Partial<EnhancementIntent>[] = [
      { enhancementName: "ZENH. DELETE FROM sflight. DATA x" },
      { spotName: "ZSPOT'" },
      { targetName: "ZCL_ORDER\nSUBMIT rsusr000" },
      { targetPackage: "ZSD'" },
      { enhancementPackage: "$TMP." },
    ];
    for (const patch of patches) {
      const d = g.evaluateIntent(intent(patch));
      expect(d.allowed, JSON.stringify(patch)).toBe(false);
      expect(d.rule).toMatch(/ABAP identifier grammar/);
    }
    // Legitimately namespaced and $-local values are not collateral damage.
    expect(
      openGate({ enhanceTargets: "sap", enhanceTargetPackages: ["/DMO/*"] }).evaluateIntent(
        intent({ targetName: "/DMO/CL_FLIGHT", targetPackage: "/DMO/FLIGHT", targetMasterSystem: "SAP" }),
      ).allowed,
    ).toBe(true);
  });

  it("refuses a non-mutating operation rather than short-circuiting past the rules", () => {
    // `evaluate()` returns early for read/analyze. Accepting one here would
    // answer "allowed" to an intent nobody judged — and the runtime
    // verification of an enhancement executes generated ABAP just like its
    // creation does, so there is no read-only classrun.
    for (const op of ["read", "analyze"] as const) {
      const d = openGate().evaluateIntent(intent(), { op });
      expect(d.allowed, op).toBe(false);
      expect(d.rule).toMatch(/no read-only classrun exemption/);
    }
    expect(openGate().evaluateIntent(intent(), { op: "execute" }).allowed).toBe(true);
  });

  it("assertIntent throws carrying BOTH the artefact and what it affects", () => {
    const g = openGate();
    const bad = intent({
      targetName: "CL_ABAP_TYPEDESCR",
      targetPackage: "SABP_TYPES",
      targetMasterSystem: "SAP",
    });
    expect(() => g.assertIntent(bad)).toThrow(
      expect.objectContaining({
        // SAP-named target under enhanceTargets=customer is an allowlist
        // (target-class) miss, not the generic SAFETY_DENIED.
        code: "ENHANCEMENT_TARGET_DENIED",
        details: expect.objectContaining({
          artefact: expect.objectContaining({ name: "ZENH_ORDER", package: "$TMP" }),
          affects: expect.objectContaining({
            name: "CL_ABAP_TYPEDESCR",
            package: "SABP_TYPES",
            masterSystem: "SAP",
            resolvedFrom: "spot",
          }),
        }),
      }),
    );
    expect(() => g.assertIntent(intent())).not.toThrow();
  });
});

/**
 * `SafetyTarget.type` was declared, passed by every caller, and read by nothing
 * in the decision path. The gate answered "may this name, in this package, be
 * written?" and never "what does this change?" — which is satisfied by
 * construction for any object class whose blast radius is not its own URI. The
 * enhancement family is exactly that class.
 */
/**
 * A follow-up to the abap_activate enhancement-target fix: the STRUCTURAL
 * mechanism, tested directly against `evaluate()`/`assert()` rather than
 * through any one call site. `abapActivate()` (`src/tools/activate.ts`)
 * used to re-consult the gate on an enhancement-type target with a bare
 * `{name, packageName, type}` and no `intent` at all, unconditionally
 * repeating the "supply `affects`" refusal regardless of what the caller
 * actually supplied. The fix is not one more patched call site: `evaluate()`
 * itself now treats "enhancement type + no intent + `phase: \"final\"`" as a
 * DISTINCT, internal-error-shaped outcome (`INTERNAL_GATE_MISUSE`) rather
 * than the ordinary user-facing refusal — so a FUTURE call site that
 * resolves an enhancement target, declares `phase: \"final\"`, and forgets
 * to build the intent gets an unmistakable internal error instead of a
 * refusal that looks like normal, correct behaviour. `phase` absent or
 * `\"preflight\"` is untouched — a caller legitimately reaching the gate
 * before resolution, with genuinely no `affects` yet, still gets the
 * ordinary `SAFETY_DENIED` "supply affects" wording, unchanged from before.
 */
describe("SafetyGate: INTERNAL_GATE_MISUSE — phase:\"final\" enhancement target with no intent", () => {
  const gate = () =>
    new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      allowEnhancements: true,
      enhanceTargets: "customer",
      originSystems: ["A4H"],
    });
  const target = { name: "ZENH_BADI", packageName: "$TMP", type: "ENHO/XH" as const };
  const AFFECTS = { name: "ZTARGET_CLS", packageName: "ZTARGET_PKG", masterSystem: "A4H" };

  it('phase:"final" + enhancement type + no intent is INTERNAL_GATE_MISUSE, not the ordinary refusal', () => {
    const d = gate().evaluate("activate", target, { phase: "final" });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("INTERNAL_GATE_MISUSE");
    expect(d.rule).toMatch(/gate self-defence/);
    expect(d.reason).toMatch(/wiring defect in abapsmith's own code/);
    // Distinct from, never confusable with, the ordinary "you forgot
    // affects" wording — this is not a decision about the request.
    expect(d.reason).not.toMatch(/supply `affects`/);
  });

  it('C3-with-intent: phase:"final" + a correctly-built intent is judged normally and can be allowed', () => {
    // Same shape `enhancementIntentFor()` (src/adt/write.ts) builds from
    // `target`/`affects` — built by hand here so this test pins the CONTRACT
    // (what `evaluate()` needs), not that helper's internals.
    const d = gate().evaluate("activate", target, {
      phase: "final",
      intent: {
        enhancementName: target.name,
        enhancementPackage: target.packageName,
        enhancementType: target.type,
        targetName: AFFECTS.name,
        targetPackage: AFFECTS.packageName,
        targetMasterSystem: AFFECTS.masterSystem,
      },
    });
    expect(d.code).not.toBe("INTERNAL_GATE_MISUSE");
    expect(d.allowed).toBe(true);
  });

  it('assert() throws INTERNAL_GATE_MISUSE as a real AbapError for the without-intent case (not a silent pass)', () => {
    expect(() => gate().assert("activate", target, { phase: "final" })).toThrow(
      expect.objectContaining({ code: "INTERNAL_GATE_MISUSE" }),
    );
  });

  it('an ordinary preflight call (no `phase`, or phase:"preflight") with no intent keeps the UNCHANGED, ordinary SAFETY_DENIED wording — this mechanism adds no new false positive there', () => {
    for (const phase of [undefined, "preflight" as const]) {
      const d = gate().evaluate("activate", target, phase === undefined ? {} : { phase });
      expect(d.allowed, String(phase)).toBe(false);
      expect(d.code, String(phase)).toBe("SAFETY_DENIED");
      expect(d.reason, String(phase)).toMatch(/supply `affects`/);
    }
  });

  it("a non-enhancement type at phase:\"final\" with no intent is completely unaffected (the branch never applies)", () => {
    const d = gate().evaluate(
      "activate",
      { name: "ZCL_FOO", packageName: "$TMP", type: "CLAS/OC" },
      { phase: "final" },
    );
    expect(d.code).not.toBe("INTERNAL_GATE_MISUSE");
  });
});

describe("SafetyGate: SafetyTarget.type participates in the decision", () => {
  const enh = { name: "ZENH_ORDER", packageName: "$TMP", type: "ENHO/XHH" };
  const enhGate = () =>
    new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      allowEnhancements: true,
      enhanceTargets: "customer",
      originSystems: ["A4H"],
    });

  it("refuses an enhancement write that arrives without an intent", () => {
    const g = enhGate();
    // By name and package this is the most harmless object the gate can be
    // shown, and under the old rules it was simply allowed.
    const d = g.evaluate("write", enh);
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/enhancement write needs an intent/);
    expect(d.code).toBe("SAFETY_DENIED");

    // Same name and package, ordinary type: still allowed. The refusal above
    // came from `type` and from nothing else.
    expect(g.evaluate("write", { ...enh, type: "CLAS/OC" }).allowed).toBe(true);
  });

  it("refuses an intent that describes a different artefact than the write", () => {
    const d = enhGate().evaluate("write", enh, {
      intent: {
        enhancementName: "ZENH_SOMETHING_ELSE",
        enhancementPackage: "$TMP",
        targetName: "ZCL_ORDER",
        targetPackage: "ZSD",
        targetMasterSystem: "A4H",
      },
    });
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/intent\/artefact mismatch/);
  });

  it("cannot be side-stepped by declaring a non-enhancement type on the intent", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      allowEnhancements: true,
      enhanceTargets: "customer",
      originSystems: [],
    });
    // originSystems is empty, so "A4H" is not local and targets=customer must
    // refuse. A caller claiming the artefact is a plain class must not route
    // the intent away from the enhancement gate's rules.
    const d = g.evaluateIntent({
      enhancementName: "ZENH_ORDER",
      enhancementPackage: "$TMP",
      enhancementType: "CLAS/OC",
      targetName: "ZCL_ORDER",
      targetPackage: "ZSD",
      targetMasterSystem: "A4H",
    });
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/outside ABAP_ENHANCE_TARGETS/);
  });

  it("carries type and package into the thrown refusal's details", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["ZFOO_*"] });
    expect(() => g.assert("write", { name: "ZCL_A", packageName: "ZBAR", type: "CLAS/OC" })).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ type: "CLAS/OC", package: "ZBAR" }),
      }),
    );
  });
});

/**
 * Tier-2 dump reads — `evaluateDumpVariables` / `assertDumpVariables`.
 *
 * The pair exists for the reason `evaluateDataPreview` exists: `evaluate()`
 * answers `allowed: true` on its first line for every non-mutating op, so a
 * dump routed through the ordinary read lane would never reach this flag at
 * all. These tests pin both halves — that plain reads stay ungated, and that
 * the variable tier is refused unless the operator opted in.
 */
describe("SafetyGate.evaluateDumpVariables", () => {
  it("refuses when the flag is unset — a hand-built SafetyConfig fails CLOSED", () => {
    const g = new SafetyGate({ readOnly: true, allowPackages: [] });
    const d = g.evaluateDumpVariables();
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("DUMP_VARIABLES_DISABLED");
  });

  it("refuses when the flag is explicitly false", () => {
    const g = new SafetyGate({ readOnly: true, allowPackages: [], allowDumpVariables: false });
    expect(g.evaluateDumpVariables().allowed).toBe(false);
  });

  it("allows when the flag is on", () => {
    const g = new SafetyGate({ readOnly: true, allowPackages: [], allowDumpVariables: true });
    const d = g.evaluateDumpVariables();
    expect(d.allowed).toBe(true);
    expect(d.code).toBeUndefined();
  });

  it("ORTHOGONALITY: read-only plus the flag allows; writes-enabled without the flag refuses", () => {
    // The gate-level half of the property `test/config-abap-mode.test.ts`
    // asserts at capability level. Reading a dump is a read, so `readOnly` must
    // not appear anywhere in this decision — in either direction.
    const readOnlyGranted = new SafetyGate({
      readOnly: true,
      allowPackages: [],
      allowDumpVariables: true,
    });
    expect(readOnlyGranted.evaluateDumpVariables().allowed).toBe(true);

    const writableUngranted = new SafetyGate({ readOnly: false, allowPackages: ["Z*"] });
    expect(writableUngranted.evaluateDumpVariables().allowed).toBe(false);
  });

  it("the refusal names the env var, says WHY, and does not read like a bug", () => {
    const g = new SafetyGate({ readOnly: true, allowPackages: [] });
    const { reason } = g.evaluateDumpVariables();
    // Names the exact variable an operator must set — the one actionable fact.
    expect(reason).toContain("ABAP_ALLOW_DUMP_VARIABLES=true");
    // States WHAT is withheld and WHY, so a model does not report a malfunction.
    expect(reason).toMatch(/withheld/i);
    expect(reason).toMatch(/personal data|customer records|bank details|salary/i);
    // Says what IS still available, so tier 1 is not abandoned as unreachable.
    expect(reason).toMatch(/call stack/i);
    // Not a fault, not unfinished, and not worth retrying. (The words "error"
    // and "failed" DO appear — in "error class" and "what failed and where",
    // describing the tier that is still available — so the assertion is on the
    // disclaimer being present, not on those words being absent.)
    expect(reason).toMatch(/not a fault/i);
    expect(reason).toMatch(/not an unfinished feature/i);
    expect(reason).toMatch(/will not change it/i);
    // Points at nothing that would send the operator to the wrong flag.
    expect(reason).not.toContain("ABAP_ALLOW_WRITE");
    expect(reason).not.toContain("ABAP_MODE");
  });

  it("plain reads are still ungated — tier 1 gains no gate from any of this", () => {
    const g = new SafetyGate({ readOnly: true, allowPackages: [] });
    expect(g.evaluate("read", obj("ZCL_FOO", "$TMP")).allowed).toBe(true);
    // ...and the read lane is exactly why the dedicated entry point exists:
    // it cannot answer the tier-2 question, so it must not be asked it.
    expect(g.evaluateDumpVariables().allowed).toBe(false);
  });
});

describe("SafetyGate.assertDumpVariables", () => {
  it("does not throw when the flag is on", () => {
    const g = new SafetyGate({ readOnly: true, allowPackages: [], allowDumpVariables: true });
    expect(() => g.assertDumpVariables()).not.toThrow();
  });

  it("throws DUMP_VARIABLES_DISABLED naming the env var in message and hint", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["Z*"] });
    expect(() => g.assertDumpVariables()).toThrow(
      expect.objectContaining({
        code: "DUMP_VARIABLES_DISABLED",
        message: expect.stringContaining("ABAP_ALLOW_DUMP_VARIABLES=true"),
        hint: expect.stringContaining("ABAP_ALLOW_DUMP_VARIABLES=true"),
        details: expect.objectContaining({ operation: "read", tier: "variables" }),
      }),
    );
  });

  it("the hint rules out the two flags an operator would otherwise reach for", () => {
    const g = new SafetyGate({ readOnly: true, allowPackages: [] });
    try {
      g.assertDumpVariables();
      throw new Error("expected assertDumpVariables to throw, but it allowed the read");
    } catch (e) {
      const hint = (e as { hint?: string }).hint ?? "";
      expect(hint).toContain("ABAP_ALLOW_WRITE");
      expect(hint).toContain("ABAP_MODE=admin");
    }
  });
});

/**
 * A classic DDIC-based CDS view (`DDLS/DF`) names the database
 * view its activation creates with its OWN `@AbapCatalog.sqlViewName`
 * annotation — a value that lives inside the source text, independent of the
 * DDLS object's own name. Without this, a `Z`-named DDLS could carry a
 * `sqlViewName` pointing activation at a database view outside the customer
 * namespace: the guard checked the door and ignored the window.
 *
 * `extractSqlViewName` is the parser; `SafetyGate.evaluateDdlsSqlViewName`
 * turns its result into the same namespace verdict `evaluate()`'s own
 * name-allowlist block would reach for an ordinary object name.
 */
describe("extractSqlViewName", () => {
  it("reports absent when there is no @AbapCatalog annotation at all (define view entity, 7.55+)", () => {
    const source = "define view entity ZI_FLIGHT as select from spfli {\n  key carrid,\n  key connid\n}";
    expect(extractSqlViewName(source)).toEqual({ kind: "absent" });
  });

  it("reports absent when @AbapCatalog is present but carries no sqlViewName", () => {
    const source =
      "@AbapCatalog.compiler.compareFilter: true\n" +
      "@AccessControl.authorizationCheck: #NOT_REQUIRED\n" +
      "define view ZDUMMY as select from t000 { key mandt }";
    expect(extractSqlViewName(source)).toEqual({ kind: "absent" });
  });

  it("extracts the dotted form", () => {
    const source = "@AbapCatalog.sqlViewName: 'ZV_FLIGHT'\ndefine view ZI_FLIGHT as select from spfli { key carrid }";
    expect(extractSqlViewName(source)).toEqual({ kind: "found", value: "ZV_FLIGHT" });
  });

  it("is case-insensitive on both the annotation and the key", () => {
    const source = "@abapcatalog.SQLVIEWNAME: 'ZV_X'\ndefine view ZI_X as select from t000 { key mandt }";
    expect(extractSqlViewName(source)).toEqual({ kind: "found", value: "ZV_X" });
  });

  it("tolerates arbitrary whitespace around the dot and colon, including newlines", () => {
    const source =
      "@AbapCatalog\n  .\n  sqlViewName\n  :\n  'ZV_SPACED'\n" +
      "define view ZI_SPACED as select from t000 { key mandt }";
    expect(extractSqlViewName(source)).toEqual({ kind: "found", value: "ZV_SPACED" });
  });

  it("extracts the nested/structured brace form", () => {
    const source =
      "@AbapCatalog: { sqlViewName: 'ZV_NEST', compiler.compareFilter: true }\n" +
      "define view ZI_NEST as select from t000 { key mandt }";
    expect(extractSqlViewName(source)).toEqual({ kind: "found", value: "ZV_NEST" });
  });

  it("extracts the nested form split across lines, with sqlViewName not the first key", () => {
    const source =
      "@AbapCatalog:\n{\n  compiler.compareFilter: true,\n  sqlViewName: 'ZV_MULTI'\n}\n" +
      "define view ZI_MULTI as select from t000 { key mandt }";
    expect(extractSqlViewName(source)).toEqual({ kind: "found", value: "ZV_MULTI" });
  });

  it("ignores a line-comment (--) decoy and still finds the real annotation", () => {
    const source =
      "-- @AbapCatalog.sqlViewName: 'SFLIGHT_DECOY'\n" +
      "@AbapCatalog.sqlViewName: 'ZV_REAL'\n" +
      "define view ZI_REAL as select from t000 { key mandt }";
    expect(extractSqlViewName(source)).toEqual({ kind: "found", value: "ZV_REAL" });
  });

  it("ignores a block-comment (/* */) decoy and still finds the real annotation", () => {
    const source =
      "/* @AbapCatalog.sqlViewName: 'SFLIGHT_DECOY' */\n" +
      "@AbapCatalog.sqlViewName: 'ZV_REAL2'\n" +
      "define view ZI_REAL2 as select from t000 { key mandt }";
    expect(extractSqlViewName(source)).toEqual({ kind: "found", value: "ZV_REAL2" });
  });

  it("does not let a real annotation be hidden by a nearby line comment on the line above", () => {
    const source =
      "-- unrelated remark, not the annotation\n" +
      "@AbapCatalog.sqlViewName: 'ZV_AFTERCOMMENT'\n" +
      "define view ZI_X as select from t000 { key mandt }";
    expect(extractSqlViewName(source)).toEqual({ kind: "found", value: "ZV_AFTERCOMMENT" });
  });

  it("unescapes the CDS '' literal-quote escape inside the value", () => {
    // Contrived (a real view name cannot contain a quote), but exercises the
    // escape-handling path: after unescaping, the char-class check refuses
    // the leftover quote rather than silently keeping it.
    const source = "@AbapCatalog.sqlViewName: 'ZV''X'\ndefine view ZI_X as select from t000 { key mandt }";
    const result = extractSqlViewName(source);
    expect(result.kind).toBe("unparseable");
  });

  it("does not mistake the substring \"sqlViewName\" inside an UNRELATED string literal for the annotation", () => {
    const source =
      "@EndUserText.label: 'mentions sqlViewName in a caption, not as a key'\n" +
      "define view ZI_LABEL as select from t000 { key mandt }";
    expect(extractSqlViewName(source)).toEqual({ kind: "absent" });
  });

  it("refuses (ambiguous) when sqlViewName is set twice", () => {
    const source =
      "@AbapCatalog.sqlViewName: 'ZV_ONE'\n" +
      "@AbapCatalog.sqlViewName: 'ZV_TWO'\n" +
      "define view ZI_DUP as select from t000 { key mandt }";
    const result = extractSqlViewName(source);
    expect(result.kind).toBe("ambiguous");
  });

  it("refuses (unparseable) an unterminated string literal rather than guessing", () => {
    const source = "@AbapCatalog.sqlViewName: 'ZV_UNTERMINATED\ndefine view ZI_X as select from t000 { key mandt }";
    const result = extractSqlViewName(source);
    expect(result.kind).toBe("unparseable");
  });

  it("refuses (unparseable) an unterminated nested brace block", () => {
    const source = "@AbapCatalog: { sqlViewName: 'ZV_X'\ndefine view ZI_X as select from t000 { key mandt }";
    const result = extractSqlViewName(source);
    expect(result.kind).toBe("unparseable");
  });

  it("refuses (unparseable) a value containing characters outside A-Z0-9_/", () => {
    const source = "@AbapCatalog.sqlViewName: 'ZV X!'\ndefine view ZI_X as select from t000 { key mandt }";
    const result = extractSqlViewName(source);
    expect(result.kind).toBe("unparseable");
  });

  it("refuses (unparseable) an empty sqlViewName value", () => {
    const source = "@AbapCatalog.sqlViewName: ''\ndefine view ZI_X as select from t000 { key mandt }";
    const result = extractSqlViewName(source);
    expect(result.kind).toBe("unparseable");
  });

  it("accepts a view name containing a registered-namespace slash, syntactically (namespace policy is judged by the gate, not the parser)", () => {
    const source = "@AbapCatalog.sqlViewName: '/SFLIGHT/ZV_X'\ndefine view ZI_X as select from t000 { key mandt }";
    expect(extractSqlViewName(source)).toEqual({ kind: "found", value: "/SFLIGHT/ZV_X" });
  });

  it("matches the exact live-exercised pattern from a manual write harness (not shipped in this release)", () => {
    // ZV${name.slice(1)} where name = ZDL1_ABCDE → sqlViewName = ZVDL1_ABCDE.
    const source =
      "@AbapCatalog.sqlViewName: 'ZVDL1_ABCDE'\n" +
      "@AbapCatalog.compiler.compareFilter: true\n" +
      "@AccessControl.authorizationCheck: #NOT_REQUIRED\n" +
      "@EndUserText.label: 'bench'\n" +
      "define view ZDL1_ABCDE as select from t000 {\n" +
      "  key mandt as Client,\n      mtext as ClientName\n}\n";
    expect(extractSqlViewName(source)).toEqual({ kind: "found", value: "ZVDL1_ABCDE" });
  });
});

describe("SafetyGate.evaluateDdlsSqlViewName / assertDdlsSqlViewName", () => {
  const ddls = (name: string) => ({ name, type: "DDLS/DF" });

  it("allows a Z-named DDLS whose sqlViewName is also inside the customer namespace", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const source = "@AbapCatalog.sqlViewName: 'ZV_FLIGHT'\ndefine view ZI_FLIGHT as select from spfli { key carrid }";
    const d = g.evaluateDdlsSqlViewName(source, ddls("ZI_FLIGHT"));
    expect(d.allowed).toBe(true);
  });

  it("allows a DDLS source with no sqlViewName annotation at all", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const source = "define view entity ZI_FLIGHT as select from spfli { key carrid }";
    const d = g.evaluateDdlsSqlViewName(source, ddls("ZI_FLIGHT"));
    expect(d.allowed).toBe(true);
  });

  // ---- The adversarial case: sqlViewName pointing outside the namespace ----
  it("REFUSES a Z-named DDLS whose sqlViewName points at an SAP-owned name, and names the reason", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const source = "@AbapCatalog.sqlViewName: 'SFLIGHT_X'\ndefine view ZI_FLIGHT as select from spfli { key carrid }";
    const d = g.evaluateDdlsSqlViewName(source, ddls("ZI_FLIGHT"));
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("SAFETY_DENIED");
    expect(d.reason).toMatch(/SFLIGHT_X/);
    expect(d.reason).toMatch(/outside the customer namespace/);
    expect(d.rule).toMatch(/sqlViewName/);
  });

  it("REFUSES a Z-named DDLS whose sqlViewName is in a registered SAP namespace (/NS/...)", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const source = "@AbapCatalog.sqlViewName: '/SAPNS/ZV_X'\ndefine view ZI_X as select from t000 { key mandt }";
    const d = g.evaluateDdlsSqlViewName(source, ddls("ZI_X"));
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("SAFETY_DENIED");
    expect(d.reason).toMatch(/reserved SAP namespace/);
    expect(d.rule).toMatch(/SAP namespace denied/);
  });

  it("assertDdlsSqlViewName throws with the object name/type in details and a hint naming ABAP_ALLOW_NAME_PREFIXES", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const source = "@AbapCatalog.sqlViewName: 'SFLIGHT_X'\ndefine view ZI_FLIGHT as select from spfli { key carrid }";
    expect(() => g.assertDdlsSqlViewName(source, ddls("ZI_FLIGHT"))).toThrow(
      expect.objectContaining({
        code: "SAFETY_DENIED",
        message: expect.stringContaining("SFLIGHT_X"),
        hint: expect.stringContaining("ABAP_ALLOW_NAME_PREFIXES"),
        details: expect.objectContaining({ operation: "write", object: "ZI_FLIGHT", type: "DDLS/DF" }),
      }),
    );
  });

  it("REFUSES (does not silently allow) when the sqlViewName annotation is ambiguous", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const source =
      "@AbapCatalog.sqlViewName: 'ZV_ONE'\n@AbapCatalog.sqlViewName: 'ZV_TWO'\n" +
      "define view ZI_DUP as select from t000 { key mandt }";
    const d = g.evaluateDdlsSqlViewName(source, ddls("ZI_DUP"));
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("SAFETY_DENIED");
    expect(d.rule).toMatch(/ambiguous/);
    expect(d.reason).toMatch(/could not be judged safely/);
  });

  it("REFUSES (does not silently allow) when the sqlViewName annotation is unparseable", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const source = "@AbapCatalog.sqlViewName: 'ZV_UNTERMINATED\ndefine view ZI_X as select from t000 { key mandt }";
    const d = g.evaluateDdlsSqlViewName(source, ddls("ZI_X"));
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("SAFETY_DENIED");
    expect(d.rule).toMatch(/unparseable/);
  });

  it("still allows an SAP-owned name for a caller who set ABAP_ALLOW_NAME_PREFIXES=* (documented, explicit override)", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], allowNamePrefixes: ["*"] });
    const source = "@AbapCatalog.sqlViewName: 'SFLIGHT_X'\ndefine view ZI_FLIGHT as select from spfli { key carrid }";
    // The wildcard switches off the PREFIX rule but not the un-overridable
    // reserved-namespace rule — mirrors `evaluate()`'s own object-name check.
    const d = g.evaluateDdlsSqlViewName(source, ddls("ZI_FLIGHT"));
    expect(d.allowed).toBe(true);
  });

  it("the reserved-namespace rule is NOT lifted by ABAP_ALLOW_NAME_PREFIXES=*", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], allowNamePrefixes: ["*"] });
    const source = "@AbapCatalog.sqlViewName: '/SAPNS/ZV_X'\ndefine view ZI_X as select from t000 { key mandt }";
    const d = g.evaluateDdlsSqlViewName(source, ddls("ZI_X"));
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/SAP namespace denied/);
  });

  it("honours a custom allowlist the same way the object-name check does", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      allowNamePrefixes: ["ZMCP_"],
    });
    const okSource = "@AbapCatalog.sqlViewName: 'ZMCP_V_X'\ndefine view ZMCP_X as select from t000 { key mandt }";
    expect(g.evaluateDdlsSqlViewName(okSource, ddls("ZMCP_X")).allowed).toBe(true);
    const badSource = "@AbapCatalog.sqlViewName: 'ZOTHER_V_X'\ndefine view ZMCP_X as select from t000 { key mandt }";
    expect(g.evaluateDdlsSqlViewName(badSource, ddls("ZMCP_X")).allowed).toBe(false);
  });

  it("matches the live-exercised pattern from a manual write harness and is allowed (not shipped in this release)", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const source =
      "@AbapCatalog.sqlViewName: 'ZVDL1_ABCDE'\n" +
      "@AbapCatalog.compiler.compareFilter: true\n" +
      "@AccessControl.authorizationCheck: #NOT_REQUIRED\n" +
      "@EndUserText.label: 'bench'\n" +
      "define view ZDL1_ABCDE as select from t000 {\n" +
      "  key mandt as Client,\n      mtext as ClientName\n}\n";
    const d = g.evaluateDdlsSqlViewName(source, ddls("ZDL1_ABCDE"));
    expect(d.allowed).toBe(true);
  });
});
