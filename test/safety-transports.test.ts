/**
 * Transport safety gate.
 *
 * `SafetyGate.evaluate()` step 10 (the transport allowlist, added AFTER the
 * package check at step 8 and the name-prefix check at step 9) and the
 * transport-RELEASE ceiling (`ABAP_ALLOW_TRANSPORT_RELEASE`), including their
 * ordering relative to the existing package/name-prefix/lockout checks.
 *
 * Deliberately imports nothing but `vitest` and `../src/safety.js` — no
 * `loadConfig()`/`ConfigSchema.parse()` here, so this file needs no entry on
 * `test/system-role-probe-guard.test.ts`'s PROBE_ALLOWLIST and does not
 * consume its ratchet. The `loadConfig()`
 * side of the unset-vs-explicit-empty distinction for `ABAP_ALLOW_TRANSPORTS`
 * is covered separately in `test/config-transports.test.ts`, which qualifies
 * for that guard's config-only exemption instead (imports only vitest,
 * node:* and ../src/config.js).
 */
import { describe, expect, it } from "vitest";
import { SafetyGate } from "../src/safety.js";

const obj = (name: string, packageName?: string) => ({ name, packageName, type: "CLAS/OC" });

describe("SafetyGate: transport allowlist, evaluate() step 10", () => {
  it('unset allowTransports on the config falls back to ["*"] and permits both auto-select and a caller-named transport', () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["ZFOO_*"] });
    // No corrNr named by the caller → server auto-selects → allowed under the
    // ["*"] fallback applied inside evaluate() itself.
    expect(g.evaluate("write", obj("ZCL_A", "ZFOO_BAR")).allowed).toBe(true);
    // A caller-named request is allowed too — the default is "any request",
    // not "auto-select only" (that narrower behaviour is still available via
    // an explicit ABAP_ALLOW_TRANSPORTS=auto).
    expect(
      g.evaluate("write", obj("ZCL_A", "ZFOO_BAR"), { corrNr: "A4HK900123" }).allowed,
    ).toBe(true);
  });

  it("an explicitly empty allowTransports denies every transportable write but leaves $TMP untouched", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*", "$TMP"],
      allowTransports: [],
    });
    const d = g.evaluate("write", obj("ZCL_A", "ZFOO_BAR"));
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/transport allowlist/);
    expect(d.code).toBe("SAFETY_DENIED");
    expect(d.reason).toMatch(/ABAP_ALLOW_TRANSPORTS is explicitly empty/);
    // $TMP needs no transport at all, so it is unaffected by the empty list.
    expect(g.evaluate("write", obj("ZCL_A", "$TMP")).allowed).toBe(true);
  });

  it("a pinned TRKORR permits only that request and refuses auto-select", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransports: ["A4HK900123"],
    });
    expect(
      g.evaluate("write", obj("ZCL_A", "ZFOO_BAR"), { corrNr: "A4HK900123" }).allowed,
    ).toBe(true);
    expect(
      g.evaluate("write", obj("ZCL_A", "ZFOO_BAR"), { corrNr: "A4HK900999" }).allowed,
    ).toBe(false);
    // auto-select is refused too: "auto" is no longer in the list.
    expect(g.evaluate("write", obj("ZCL_A", "ZFOO_BAR")).allowed).toBe(false);
    // Case-insensitive match on the TRKORR.
    expect(
      g.evaluate("write", obj("ZCL_A", "ZFOO_BAR"), { corrNr: "a4hk900123" }).allowed,
    ).toBe(true);
  });

  it("* widens to any caller-named transport, pinned or auto", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransports: ["*"],
    });
    expect(g.evaluate("write", obj("ZCL_A", "ZFOO_BAR")).allowed).toBe(true);
    expect(
      g.evaluate("write", obj("ZCL_A", "ZFOO_BAR"), { corrNr: "ANYTHING123" }).allowed,
    ).toBe(true);
  });

  it("ordering: a ZFOO write with allowTransports:['*'] still fails on the PACKAGE rule (step 8), not the transport rule (step 10)", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"], // ZFOO is not allowlisted
      allowTransports: ["*"], // wide open — must not rescue the write
    });
    const d = g.evaluate("write", obj("ZFOO", "ZFOO"), { corrNr: "A4HK900123" });
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/package allowlist/);
    expect(d.rule).not.toMatch(/transport/);
  });

  it("ABAP_ALLOW_TRANSPORTS never implicitly widens ABAP_ALLOW_PACKAGES", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      allowTransports: ["*"],
    });
    expect(g.evaluate("write", obj("ZCL_A", "ZOTHER")).allowed).toBe(false);
  });

  it("step 10 does not fire for an object-less transport op, and that does not weaken allowTransports:[] for the write that records an object", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransports: [], // deny every transportable write
    });
    // Listing / showing / creating a request records no object into a transport,
    // so the allowlist — which is keyed off the OBJECT's package — has nothing
    // to match and does not fire.
    expect(g.evaluate("transport", undefined, {}).allowed).toBe(true);
    // The moment an object would actually be recorded, the deny-all bites. This
    // is the property the flag exists for and it is untouched by the above.
    const d = g.evaluate("write", obj("ZCL_A", "ZFOO_BAR"), { corrNr: "A4HK900123" });
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/transport allowlist/);
  });

  it("unset allowTransports is the gate's own explicit default, not an absence of one: a pinned TRKORR is now permitted", () => {
    // A hand-built SafetyGate never passes through loadConfig(), so the class
    // applies DEFAULT_TRANSPORTS itself — stated here rather than left
    // implicit, so a hand-built config (tests, embedders) matches loadConfig()'s
    // own unset default rather than drifting from it by accident. That default
    // is "any request" (opt-in, like allowPackages/allowNamePrefixes),
    // not "auto-select only".
    const g = new SafetyGate({ readOnly: false, allowPackages: ["ZFOO_*"] });
    expect(g.transportAllowlist).toEqual(["*"]);
    expect(
      g.evaluate("write", obj("ZCL_A", "ZFOO_BAR"), { corrNr: "A4HK900123" }).allowed,
    ).toBe(true);
    // ...while an explicitly empty list stays a separate, stricter state.
    expect(new SafetyGate({ readOnly: false, allowPackages: ["ZFOO_*"], allowTransports: [] }).transportAllowlist).toEqual([]);
    // ...and an explicit "auto" narrows back down to the earlier auto-select-only
    // default, still available for an operator who wants pin-refusal.
    expect(
      new SafetyGate({ readOnly: false, allowPackages: ["ZFOO_*"], allowTransports: ["auto"] }).evaluate(
        "write",
        obj("ZCL_A", "ZFOO_BAR"),
        { corrNr: "A4HK900123" },
      ).allowed,
    ).toBe(false);
  });

  it("defers the transport check in preflight when the package is not yet known, same as the package check", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransports: [],
    });
    expect(
      g.evaluate("write", obj("ZCL_A", undefined), { phase: "preflight" }).allowed,
    ).toBe(true);
  });
});

describe("SafetyGate: transport RELEASE ceiling", () => {
  it("denied when ABAP_ALLOW_WRITE (readOnly) is off, even with ABAP_ALLOW_TRANSPORT_RELEASE set — the pre-existing read-only check fires first", () => {
    const g = new SafetyGate({
      readOnly: true,
      allowPackages: [],
      allowTransportRelease: true,
    });
    const d = g.evaluate("transport", undefined, { release: true });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("READ_ONLY");
    expect(d.rule).toMatch(/read-only/);
    // The advice must be complete, not half of it. An operator refused here has
    // TWO flags to think about, and a message naming only ABAP_ALLOW_WRITE sends
    // them round the loop a second time — set it, retry, refused again by the
    // ceiling. Both facts, in the refusal that actually fired.
    expect(d.reason).toMatch(/ABAP_ALLOW_WRITE=true/);
    expect(d.reason).toMatch(/ABAP_ALLOW_TRANSPORT_RELEASE=true/);
  });

  it("denied when ABAP_ALLOW_WRITE is on but ABAP_ALLOW_TRANSPORT_RELEASE is off — NOT implied by write", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransportRelease: false,
    });
    const d = g.evaluate("transport", undefined, { release: true });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("READ_ONLY");
    expect(d.rule).toMatch(/transport release ceiling/);
    expect(d.reason).toMatch(/ABAP_ALLOW_TRANSPORT_RELEASE=true/);
  });

  it("allowed only when BOTH ABAP_ALLOW_WRITE and ABAP_ALLOW_TRANSPORT_RELEASE are true", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransportRelease: true,
    });
    expect(g.evaluate("transport", undefined, { release: true }).allowed).toBe(true);
  });

  it("refuses release on a productive system even with both flags true — no override", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransportRelease: true,
      productive: true,
    });
    const d = g.evaluate("transport", undefined, { release: true });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("READ_ONLY");
    expect(d.rule).toMatch(/productive/);
  });

  it("refuses release on an unproven (writesLockedOut) system even with both flags true — no override", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransportRelease: true,
      writesLockedOut: true,
      lockoutReason: "T000 probe returned no usable evidence.",
    });
    const d = g.evaluate("transport", undefined, { release: true });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("READ_ONLY");
    expect(d.reason).toMatch(/does not override/);
  });

  it("a non-release transport op is unaffected by the release ceiling", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransportRelease: false,
    });
    expect(g.evaluate("transport", undefined, {}).allowed).toBe(true);
    expect(g.evaluate("transport", undefined, { release: false }).allowed).toBe(true);
  });

  it("an object-less transport op is still a mutation: refused outright while the server is read-only", () => {
    // The counterweight to evaluate() letting object-less transport ops past the
    // object rules. Creating or deleting a request changes the target system, so
    // it must still cost ABAP_ALLOW_WRITE — the exemption is from the OBJECT
    // rules only, never from the write flag or the lockout tier.
    const g = new SafetyGate({ readOnly: true, allowPackages: ["ZFOO_*"] });
    const d = g.evaluate("transport", undefined, {});
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("READ_ONLY");
  });

  it("a per-call release request only narrows: it cannot force release when the ceiling is closed, even on an otherwise fully-open gate", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["*"],
      allowTransports: ["*"],
      allowTransportRelease: false,
    });
    expect(g.evaluate("transport", undefined, { release: true }).allowed).toBe(false);
  });
});

/**
 * The DELETE ceiling closes the gap release already had a fix for —
 * `allowTransportDelete` mirrors `allowTransportRelease` exactly, so this
 * block deliberately mirrors "SafetyGate: transport RELEASE ceiling" above
 * test-for-test, substituting `deleteTransport: true` for `release: true`
 * and `allowTransportDelete` for `allowTransportRelease`.
 */
describe("SafetyGate: transport DELETE ceiling", () => {
  it("denied when ABAP_ALLOW_WRITE (readOnly) is off, even with the delete ceiling set — the pre-existing read-only check fires first", () => {
    const g = new SafetyGate({
      readOnly: true,
      allowPackages: [],
      allowTransportDelete: true,
    });
    const d = g.evaluate("transport", undefined, { deleteTransport: true });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("READ_ONLY");
    expect(d.rule).toMatch(/read-only/);
    // Both missing facts named in one refusal, same as release. allowTransportDelete
    // is mode-overridable, so the refusal names the env var, not a mode.
    expect(d.reason).toMatch(/ABAP_ALLOW_WRITE=true/);
    expect(d.reason).toMatch(/ABAP_ALLOW_TRANSPORT_DELETE=true/);
  });

  it("denied when ABAP_ALLOW_WRITE is on but allowTransportDelete is off — NOT implied by write", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransportDelete: false,
    });
    const d = g.evaluate("transport", undefined, { deleteTransport: true });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("READ_ONLY");
    expect(d.rule).toMatch(/transport delete ceiling/);
    expect(d.reason).toMatch(/ABAP_ALLOW_TRANSPORT_DELETE=true/);
  });

  it("denied when allowTransportDelete is left unset entirely — fails closed on undefined, exactly like release", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["ZFOO_*"] });
    const d = g.evaluate("transport", undefined, { deleteTransport: true });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("READ_ONLY");
  });

  it("allowed only when BOTH ABAP_ALLOW_WRITE and allowTransportDelete are true (ABAP_MODE=admin shape)", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransportDelete: true,
    });
    expect(g.evaluate("transport", undefined, { deleteTransport: true }).allowed).toBe(true);
  });

  it("refuses delete on a productive system even with both flags true — no override", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransportDelete: true,
      productive: true,
    });
    const d = g.evaluate("transport", undefined, { deleteTransport: true });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("READ_ONLY");
    expect(d.rule).toMatch(/productive/);
  });

  it("refuses delete on an unproven (writesLockedOut) system even with both flags true — no override", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransportDelete: true,
      writesLockedOut: true,
      lockoutReason: "T000 probe returned no usable evidence.",
    });
    const d = g.evaluate("transport", undefined, { deleteTransport: true });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("READ_ONLY");
    expect(d.reason).toMatch(/does not override/);
  });

  it("a non-delete transport op is unaffected by the delete ceiling", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransportDelete: false,
    });
    expect(g.evaluate("transport", undefined, {}).allowed).toBe(true);
    expect(g.evaluate("transport", undefined, { deleteTransport: false }).allowed).toBe(true);
    // Release stays independently gated too — neither ceiling implies the other.
    expect(g.evaluate("transport", undefined, { release: true }).allowed).toBe(false);
  });

  it("a per-call delete request only narrows: it cannot force delete when the ceiling is closed, even on an otherwise fully-open gate", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["*"],
      allowTransports: ["*"],
      allowTransportRelease: true,
      allowTransportDelete: false,
    });
    expect(g.evaluate("transport", undefined, { deleteTransport: true }).allowed).toBe(false);
    // Release, which IS on, is unaffected — proving the two ceilings are
    // genuinely independent rather than one silently gating the other.
    expect(g.evaluate("transport", undefined, { release: true }).allowed).toBe(true);
  });

  it("ABAP_MODE=admin (both allowTransportRelease and allowTransportDelete true) permits both release and delete", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["*"],
      allowTransports: ["*"],
      allowTransportRelease: true,
      allowTransportDelete: true,
    });
    expect(g.evaluate("transport", undefined, { release: true }).allowed).toBe(true);
    expect(g.evaluate("transport", undefined, { deleteTransport: true }).allowed).toBe(true);
  });

  it("ABAP_MODE=read shape (readOnly true, neither ceiling set) denies both release and delete", () => {
    const g = new SafetyGate({ readOnly: true, allowPackages: [] });
    expect(g.evaluate("transport", undefined, { release: true }).allowed).toBe(false);
    expect(g.evaluate("transport", undefined, { deleteTransport: true }).allowed).toBe(false);
  });
});

/**
 * An empty-string `corr_nr` used to mean three different things
 * depending on which tool received it: `abap_write` stripped it as falsy and
 * auto-selected, while `abap_activate` and `abap_enh` passed it through to a
 * gate that classified it `source:"named"` and then refused it SAFETY_DENIED
 * for matching no allowlist entry. Same field, same value, opposite outcomes,
 * and a refusal message that blamed transport permissions.
 *
 * `normalizeCorrNr` is the single spelling all four call sites now share.
 * These assertions pin the gate's half; the tools' half is that they call it.
 */
describe("SafetyGate: a blank corr_nr means auto, not a transport named \"\"", () => {
  const gate = () =>
    new SafetyGate({ readOnly: false, allowPackages: ["ZFOO_*"], allowTransports: ["auto"] });

  it("treats an empty-string corrNr exactly as an omitted one", () => {
    const g = gate();
    const omitted = g.evaluate("write", obj("ZCL_A", "ZFOO_BAR"));
    const blank = g.evaluate("write", obj("ZCL_A", "ZFOO_BAR"), { corrNr: "" });
    expect(omitted.allowed).toBe(true);
    // The bug: this used to be false, with `rule: "transport allowlist"`.
    expect(blank.allowed).toBe(true);
    expect(blank.reason).toBe(omitted.reason);
  });

  it("folds in whitespace-only values, so \" \" cannot pose as a named request", () => {
    const g = gate();
    expect(g.evaluate("write", obj("ZCL_A", "ZFOO_BAR"), { corrNr: "   " }).allowed).toBe(true);
  });

  it("still refuses a blank corrNr when the allowlist is a pinned TRKORR, because auto is not on it", () => {
    // Normalising to "auto" must not widen anything: under a pinned list,
    // auto-select is refused, and a blank value is auto-select.
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransports: ["A4HK900123"],
    });
    const d = g.evaluate("write", obj("ZCL_A", "ZFOO_BAR"), { corrNr: "" });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("SAFETY_DENIED");
  });

  it("leaves a genuinely named transport alone, trimming only the padding", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransports: ["A4HK900123"],
    });
    expect(g.evaluate("write", obj("ZCL_A", "ZFOO_BAR"), { corrNr: " A4HK900123 " }).allowed).toBe(
      true,
    );
  });

  it("does not touch $TMP, which needs no transport either way", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*", "$TMP"],
      allowTransports: ["auto"],
    });
    expect(g.evaluate("write", obj("ZCL_A", "$TMP"), { corrNr: "" }).allowed).toBe(true);
  });
});
