/**
 * Pins down `src/debug/identity.ts`'s two exports:
 *
 *  - `resolveDebugIdentity` must return a configured id VERBATIM (source
 *    "config") when supplied, and otherwise derive a DETERMINISTIC,
 *    uppercase-hex id from sid+user (source "derived") — and the two derived
 *    ids (terminalId vs ideId) must differ from each other even though both
 *    come from the same sid+user, because they use different seeds.
 *  - `warnIfDerivedIdentity` must warn AT MOST ONCE per process (module-level
 *    `warned` flag, no exported reset hook) and must never warn when both
 *    halves of the identity were explicitly configured.
 *
 * Pure module: no I/O, no fake HttpClient/server needed. Tests that need a
 * fresh warn-once flag use `vi.resetModules()` + a dynamic re-import, since
 * the flag has no exported reset hook.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveDebugIdentity, warnIfDerivedIdentity, type DebugIdentityConfig } from "../src/debug/identity.js";

const SID = "A4H";
const USER = "DEVELOPER";

function baseCfg(overrides: Partial<DebugIdentityConfig> = {}): DebugIdentityConfig {
  return { sid: SID, user: USER, terminalId: undefined, ideId: undefined, ...overrides };
}

describe("resolveDebugIdentity", () => {
  // A configured ideId (and separately terminalId) must come back
  // verbatim with source "config" — not silently re-derived.
  it("returns a config-supplied ideId verbatim with source config", () => {
    const configuredIdeId = "C".repeat(32);
    const id = resolveDebugIdentity(baseCfg({ ideId: configuredIdeId }));
    expect(id.ideId).toBe(configuredIdeId);
    expect(id.ideIdSource).toBe("config");
  });

  it("returns a config-supplied terminalId verbatim with source config", () => {
    const configuredTerminalId = "A".repeat(32);
    const id = resolveDebugIdentity(baseCfg({ terminalId: configuredTerminalId }));
    expect(id.terminalId).toBe(configuredTerminalId);
    expect(id.terminalIdSource).toBe("config");
  });

  // When both halves are derived, terminalId and ideId must DIFFER.
  // src/config.ts's shipped equality warning cannot see this gap: that
  // warning only fires when cfg.ideId !== undefined, so the all-derived case
  // (both undefined) never reaches it — this module is the only place the
  // terminalId === ideId collision for a fully-derived identity gets caught.
  it("with neither id configured, derived terminalId and ideId differ", () => {
    const id = resolveDebugIdentity(baseCfg());
    expect(id.terminalId).not.toBe(id.ideId);
  });

  it("derivation is deterministic for the same sid+user", () => {
    const first = resolveDebugIdentity(baseCfg());
    const second = resolveDebugIdentity(baseCfg());
    expect(second.terminalId).toBe(first.terminalId);
    expect(second.ideId).toBe(first.ideId);
  });

  it("derivation differs when sid differs", () => {
    const first = resolveDebugIdentity(baseCfg());
    const second = resolveDebugIdentity(baseCfg({ sid: "XYZ" }));
    expect(second.terminalId).not.toBe(first.terminalId);
    expect(second.ideId).not.toBe(first.ideId);
  });

  it("derivation differs when user differs", () => {
    const first = resolveDebugIdentity(baseCfg());
    const second = resolveDebugIdentity(baseCfg({ user: "OTHERUSER" }));
    expect(second.terminalId).not.toBe(first.terminalId);
    expect(second.ideId).not.toBe(first.ideId);
  });

  // SAP does not normalise case, so a lowercased id names a DIFFERENT
  // session than its uppercase counterpart — output must be strict uppercase.
  it("derived terminalId and ideId are strict 32-uppercase-hex", () => {
    const id = resolveDebugIdentity(baseCfg());
    expect(id.terminalId).toMatch(/^[0-9A-F]{32}$/);
    expect(id.ideId).toMatch(/^[0-9A-F]{32}$/);
  });

  it("configured terminalId and ideId are strict 32-uppercase-hex", () => {
    const id = resolveDebugIdentity(
      baseCfg({ terminalId: "A".repeat(32), ideId: "B".repeat(32) }),
    );
    expect(id.terminalId).toMatch(/^[0-9A-F]{32}$/);
    expect(id.ideId).toMatch(/^[0-9A-F]{32}$/);
  });

  // Source labels must reflect exactly which halves were configured —
  // all four combinations, precisely.
  describe("source labels per combination", () => {
    it("neither set: both sources are derived", () => {
      const id = resolveDebugIdentity(baseCfg());
      expect(id.terminalIdSource).toBe("derived");
      expect(id.ideIdSource).toBe("derived");
    });

    it("only terminalId set: terminalIdSource config, ideIdSource derived", () => {
      const id = resolveDebugIdentity(baseCfg({ terminalId: "A".repeat(32) }));
      expect(id.terminalIdSource).toBe("config");
      expect(id.ideIdSource).toBe("derived");
    });

    it("only ideId set: ideIdSource config, terminalIdSource derived", () => {
      const id = resolveDebugIdentity(baseCfg({ ideId: "C".repeat(32) }));
      expect(id.terminalIdSource).toBe("derived");
      expect(id.ideIdSource).toBe("config");
    });

    it("both set: both sources are config", () => {
      const id = resolveDebugIdentity(
        baseCfg({ terminalId: "A".repeat(32), ideId: "C".repeat(32) }),
      );
      expect(id.terminalIdSource).toBe("config");
      expect(id.ideIdSource).toBe("config");
    });
  });

  // Policy: a derived identity NEVER throws — it warns, it does not refuse.
  // Refusing outright would break every existing single-process user, who
  // has never set ABAP_TERMINAL_ID/ABAP_IDE_ID and relies on derivation.
  it("policy: a fully-derived identity resolves without throwing and is fully usable", () => {
    let id: ReturnType<typeof resolveDebugIdentity> | undefined;
    expect(() => {
      id = resolveDebugIdentity(baseCfg());
    }).not.toThrow();
    expect(id).toBeDefined();
    expect(id!.terminalId).toMatch(/^[0-9A-F]{32}$/);
    expect(id!.ideId).toMatch(/^[0-9A-F]{32}$/);
  });
});

describe("warnIfDerivedIdentity", () => {
  // A fully config-supplied identity must never warn.
  it("a fully config-supplied identity warns zero times and returns false", async () => {
    vi.resetModules();
    const mod = await import("../src/debug/identity.js");
    const id = mod.resolveDebugIdentity(
      baseCfg({ terminalId: "A".repeat(32), ideId: "C".repeat(32) }),
    );
    const messages: string[] = [];
    const result = mod.warnIfDerivedIdentity(id, (m) => messages.push(m));
    expect(result).toBe(false);
    expect(messages).toHaveLength(0);
  });

  // A derived identity warns exactly once per (freshly imported) module.
  it("a derived identity warns exactly once — second call is a no-op", async () => {
    vi.resetModules();
    const mod = await import("../src/debug/identity.js");
    const id = mod.resolveDebugIdentity(baseCfg());
    const messages: string[] = [];

    const first = mod.warnIfDerivedIdentity(id, (m) => messages.push(m));
    expect(first).toBe(true);
    expect(messages).toHaveLength(1);

    const second = mod.warnIfDerivedIdentity(id, (m) => messages.push(m));
    expect(second).toBe(false);
    expect(messages).toHaveLength(1); // unchanged — no new push

    // Even a different derived identity within the same process must not
    // warn again: the flag is per-process, not per-identity.
    const otherId = mod.resolveDebugIdentity(baseCfg({ sid: "XYZ" }));
    const third = mod.warnIfDerivedIdentity(otherId, (m) => messages.push(m));
    expect(third).toBe(false);
    expect(messages).toHaveLength(1);
  });

  // Policy: warnIfDerivedIdentity never throws — it warns, it does not refuse.
  it("policy: warnIfDerivedIdentity never throws for a derived identity", async () => {
    vi.resetModules();
    const mod = await import("../src/debug/identity.js");
    const id = mod.resolveDebugIdentity(baseCfg());
    expect(() => mod.warnIfDerivedIdentity(id, () => {})).not.toThrow();
  });

  // The warning text must actually carry the hazard, not just fire.
  it("warning text names the hazard and both env vars", async () => {
    vi.resetModules();
    const mod = await import("../src/debug/identity.js");
    const id = mod.resolveDebugIdentity(baseCfg());
    const messages: string[] = [];
    mod.warnIfDerivedIdentity(id, (m) => messages.push(m));

    expect(messages).toHaveLength(1);
    const text = messages[0];
    expect(text).toContain("[abapsmith] WARNING: ");
    expect(text).toContain("ABAP_TERMINAL_ID");
    expect(text).toContain("ABAP_IDE_ID");
    // Meaning, not exact wording: only explicit configuration is safe across
    // more than one process for the same SAP user.
    expect(text).toContain("provably multi-process-safe");
    expect(text).toContain("IDENTICAL pair");
  });
});
