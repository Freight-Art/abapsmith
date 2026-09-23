/**
 * Issue #208: under `ABAP_ALLOW_TRANSPORTS=auto`, a NAMED `corr_nr` is
 * accepted only when it is a request THIS session created — never merely
 * because it looks like a valid TRKORR. Two places implement this, and both
 * are covered here, offline:
 *
 *   - `SafetyGate` step 10 (src/safety.ts): consults `SafetyGateHooks
 *     .sessionCreatedRequests()` to decide whether a named transport passes
 *     under `["auto"]`. Wording of the resulting hint/reason is covered by
 *     test/transport-denial-hints.test.ts; this file is about the ALLOW/DENY
 *     decision itself, under different hook states.
 *   - `SessionTransport.resolve()` Step 5 (src/adt/session-transport.ts):
 *     its OWN `#created` registry (`noteCreated()`/`sessionCreatedRequests()`)
 *     drives the identical carve-out independently — this is the source the
 *     gate's hook is meant to be wired to in production, but the two are
 *     tested separately here since nothing forces that wiring at the type
 *     level.
 *
 * Entirely offline; `SessionTransport`'s CTS client is an injected fake.
 */
import { describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrHeader, TrRequirement } from "../src/adt/transports.js";
import { SafetyGate } from "../src/safety.js";

const SELF_A = "A4HK900201";
const SELF_B = "A4HK900202";
const OTHER = "A4HK900299";

// ---------------------------------------------------------------------------
// Part 1 — SafetyGate step 10 + SafetyGateHooks
// ---------------------------------------------------------------------------

const TARGET = { name: "ZMCP_V_X", type: "VIEW/DV", packageName: "ZTM", exists: false } as const;

const gateWith = (allowTransports: string[], sessionCreatedRequests?: () => readonly string[]): SafetyGate =>
  new SafetyGate(
    { readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"], allowTransports },
    sessionCreatedRequests ? { sessionCreatedRequests } : {},
  );

const catchGate = (fn: () => void): AbapError => {
  try {
    fn();
  } catch (e) {
    expect(isAbapError(e)).toBe(true);
    return e as AbapError;
  }
  throw new Error("expected the gate to refuse");
};

const named = (corrNr: string) => ({ corr: { kind: "transport" as const, corrNr, source: "named" as const } });
const autoSourced = (corrNr: string) => ({ corr: { kind: "transport" as const, corrNr, source: "auto" as const } });

describe("SafetyGate step 10 + SafetyGateHooks — the auto-allowlist's session-created carve-out (#208)", () => {
  it("under ['auto'], a NAMED request the hook reports this session created is accepted", () => {
    const gate = gateWith(["auto"], () => [SELF_A]);
    expect(() => gate.assert("write", TARGET, named(SELF_A))).not.toThrow();
  });

  it("under ['auto'], a NAMED request the hook does NOT report is refused", () => {
    const gate = gateWith(["auto"], () => [SELF_A]);
    const e = catchGate(() => gate.assert("write", TARGET, named(OTHER)));
    expect(e.code).toBe("SAFETY_DENIED");
    expect(e.details.rule).toBe("transport allowlist");
    expect(e.retryable).toBe(false);
  });

  it("the hook match is case-insensitive and trims whitespace", () => {
    const gate = gateWith(["auto"], () => [` ${SELF_A.toLowerCase()} `]);
    expect(() => gate.assert("write", TARGET, named(SELF_A))).not.toThrow();
  });

  it("with no hooks object at all, a named request behaves as if the registry were empty — refused", () => {
    // The second SafetyGate constructor argument is optional; its default
    // (`{}`) must leave `sessionCreatedRequests` reading as "none created",
    // not throw and not silently allow.
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"], allowTransports: ["auto"] });
    const e = catchGate(() => gate.assert("write", TARGET, named(SELF_A)));
    expect(e.code).toBe("SAFETY_DENIED");
    expect(e.message).toMatch(/session has created none yet/);
  });

  it("under a pinned list, the hook creates no carve-out — a request it reports is still refused", () => {
    const gate = gateWith([SELF_B], () => [SELF_A]);
    const e = catchGate(() => gate.assert("write", TARGET, named(SELF_A)));
    expect(e.code).toBe("SAFETY_DENIED");
    expect(e.details.rule).toBe("transport allowlist");
  });

  it("under a wildcard list, every named request already passes — irrespective of the hook", () => {
    const gate = gateWith(["*"], () => []);
    expect(() => gate.assert("write", TARGET, named(OTHER))).not.toThrow();
  });

  it("an 'auto'-sourced corr passes under ['auto'] whether or not the hook reports it — the carve-out only ever applies to a NAMED corr", () => {
    const gate = gateWith(["auto"], () => []);
    expect(() => gate.assert("write", TARGET, autoSourced(OTHER))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Part 2 — SessionTransport.resolve() Step 5
// ---------------------------------------------------------------------------

const conn = {} as AbapConnection;

const target = { uri: "/sap/bc/adt/oo/classes/zi208_cl/source/main", devclass: "ZTM", name: "ZI208_CL", type: "CLAS/OC" };

const baseRequirement = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({
    kind: "transport-required",
    mustSupplyCorrNr: true,
    serverWouldFabricate: false,
    uri: target.uri,
    operation: "I",
    devclass: "ZTM",
    candidates: [],
    locks: [],
    messages: [],
    checkFailed: false,
    raw: { result: "S", korrflag: "X", recording: "" },
    ...overrides,
  }) as TrRequirement;

const workbenchHeader = (overrides: Partial<TrHeader> = {}): TrHeader => ({
  trkorr: SELF_A,
  kind: "workbench",
  kindRaw: "K",
  status: "modifiable",
  statusRaw: "D",
  owner: "DEVELOPER",
  description: "mine",
  ...overrides,
});

const modifiableShow = (trkorr: string) =>
  vi.fn(async () => ({
    trkorr,
    kind: "workbench" as const,
    kindRaw: "K",
    status: "modifiable" as const,
    statusRaw: "D",
    owner: "DEVELOPER",
    description: "mine",
    tasks: [],
    objects: [],
  }));

describe("SessionTransport.resolve() Step 5 — the session's OWN #created registry drives the same carve-out (#208)", () => {
  it("a caller naming a TRKORR this session created earlier is granted source:'session-created', created:true, with no trCreate call", async () => {
    const trCreate = vi.fn();
    const trRequirement = vi.fn(async () => baseRequirement());
    const trShow = modifiableShow(SELF_A);
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate, trShow } as never,
    });
    mgr.noteCreated(SELF_A);

    const res = await mgr.resolve(conn, target, "I", { corrNr: SELF_A });

    if (res.outcome !== "transport") throw new Error("expected a grant");
    expect(res.source).toBe("session-created");
    expect(res.created).toBe(true);
    expect(res.corrNr).toBe(SELF_A);
    expect(trCreate).not.toHaveBeenCalled();
    expect(trShow).toHaveBeenCalledTimes(1);
    expect(mgr.state).toMatchObject({ kind: "active", trkorr: SELF_A });
  });

  it("a caller naming a TRKORR this session has NOT created and that isn't attributed is denied not-allowlisted, listing none created yet", async () => {
    const trCreate = vi.fn();
    const trRequirement = vi.fn(async () => baseRequirement());
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate, trShow: modifiableShow(OTHER) } as never,
    });

    const res = await mgr.resolve(conn, target, "I", { corrNr: OTHER });

    if (res.outcome !== "denied") throw new Error("expected a denial");
    expect(res.denial).toBe("not-allowlisted");
    expect(res.reason).toMatch(/this session did not create it/);
    expect(res.reason).toMatch(/none yet — omit corr_nr to have one created/);
    expect(trCreate).not.toHaveBeenCalled();
  });

  it("a caller naming a TRKORR this session did NOT create, but attributed to it via a modifiable workbench candidate, is granted source:'session-adopted', created:false", async () => {
    const now = () => new Date("2026-09-23T00:00:00.000Z");
    const attributed = workbenchHeader({ trkorr: OTHER, description: "abapsmith session 2026-09-23" });
    const trRequirement = vi.fn(async () => baseRequirement({ candidates: [attributed] }));
    const trCreate = vi.fn();
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      whoami: () => "DEVELOPER",
      now,
      cts: { trRequirement, trCreate, trShow: modifiableShow(OTHER) } as never,
    });

    const res = await mgr.resolve(conn, target, "I", { corrNr: OTHER });

    if (res.outcome !== "transport") throw new Error("expected a grant");
    expect(res.source).toBe("session-adopted");
    expect(res.created).toBe(false);
    expect(res.corrNr).toBe(OTHER);
    expect(trCreate).not.toHaveBeenCalled();
  });

  it("when this session has created more than one request, the denial names all of them, in creation order", async () => {
    const trRequirement = vi.fn(async () => baseRequirement());
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate: vi.fn(), trShow: modifiableShow(OTHER) } as never,
    });
    mgr.noteCreated(SELF_A);
    mgr.noteCreated(SELF_B);

    const res = await mgr.resolve(conn, target, "I", { corrNr: OTHER });

    if (res.outcome !== "denied") throw new Error("expected a denial");
    expect(res.reason).toMatch(new RegExp(`Acceptable: ${SELF_A}, ${SELF_B}\\.`));
  });

  it("under a genuinely pinned list, naming a TRKORR this session created is NOT enough — still denied", async () => {
    const trRequirement = vi.fn(async () => baseRequirement());
    const trCreate = vi.fn();
    const mgr = new SessionTransport({
      allowTransports: [SELF_B],
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate, trShow: modifiableShow(SELF_A) } as never,
    });
    mgr.noteCreated(SELF_A);

    const res = await mgr.resolve(conn, target, "I", { corrNr: SELF_A });

    if (res.outcome !== "denied") throw new Error("expected a denial");
    expect(res.denial).toBe("not-allowlisted");
    // Pinned-mode wording names the pinned list, not "auto" — the session's
    // own creation of SELF_A is simply irrelevant here.
    expect(res.reason).toMatch(new RegExp(`\\[${SELF_B}\\]`));
    expect(res.reason).not.toMatch(/this session did not create it/);
    expect(trCreate).not.toHaveBeenCalled();
  });
});
