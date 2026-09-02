/**
 * A REFUSAL MUST NOT MISATTRIBUTE A DROPPED CONNECTION AS A POLICY VERDICT.
 *
 * ## The defect class this closes
 *
 * `probeT000()` puts exactly one POST at `/sap/bc/adt/datapreview/freestyle`
 * to read `T000-CCCATEGORY` and decide whether the connected system is
 * productive. Two very different outcomes used to collapse into one refusal:
 *
 *   (a) the probe GOT an answer — HTTP 200/403/406/500, junk XML, an unknown
 *       logon client — and that answer did not prove the system
 *       non-productive; or
 *   (b) the probe NEVER GOT an answer at all — socket hang up, ECONNRESET, a
 *       timeout below HTTP.
 *
 * Both are `role: "inconclusive"` and both correctly fail closed. But (b) was
 * reported to the caller exactly like (a): `READ_ONLY`, "This system could
 * not be proven non-productive", with a hint pointing at
 * `ABAP_DATA_PREVIEW_DENY_TABLES` and the deny-list. That is remediation for
 * a table the operator never asked about, on a system whose role was never
 * even evaluated. This was observed live once, on an A4H
 * appliance, in 13 cold starts — the transport dropped before the probe's
 * single POST completed, and the tool call that followed was told to go
 * fix a deny-list.
 *
 * The fix threads a `probeFailure` string from `detectSystemRole()` down
 * through `SafetyConfig.roleProbeFailure` and out as `code:
 * "ROLE_PROBE_FAILED"` with a hint that names a restart, not a flag. This
 * file pins that path end to end: detection tells the two cases apart,
 * `SafetyGate` reports them differently, the refusal still refuses, the
 * ordinary policy refusal is untouched, and the one-way latch that makes a
 * restart (not a retry) the correct advice actually holds.
 *
 * ## What this deliberately does NOT cover
 *
 * The socket hang up itself is not reproduced here — there is no fake
 * transport in this file that actually drops a connection mid-request. Every
 * case below is a `SystemRoleProbes`/`probeT000` collaborator that rejects
 * synchronously with the error shape a dropped connection would leave
 * behind, or a `SafetyGate` constructed to already be in the state such a
 * probe would leave it in. This file pins how such a failure is REPORTED
 * once it has happened, not the transport fault that causes one. The wire
 * mechanics of a socket hang up belong to `test/system-role-detection.test.ts`
 * and the live captures under `test/fixtures/live-captured`, neither of which
 * this file touches.
 */
import { describe, expect, it } from "vitest";
import { AbapError } from "../src/adt/errors.js";
import { detectSystemRole, type SystemRoleProbes } from "../src/adt/system-role.js";
import { SafetyGate, type SafetyConfig } from "../src/safety.js";

// ---------------------------------------------------------- detectSystemRole ---

/**
 * A `SystemRoleProbes` double with every collaborator wired to something that
 * cannot silently pass a real test: unanswered calls throw loudly rather than
 * resolving to a default that would make a failing assertion look like a
 * probe that never ran.
 */
function fakeProbes(overrides: Partial<SystemRoleProbes> = {}): SystemRoleProbes {
  return {
    probeT000: async () => {
      throw new Error("fakeProbes: probeT000 was not stubbed for this test");
    },
    getAtoSettings: async () => {
      throw new Error("fakeProbes: getAtoSettings was not stubbed for this test");
    },
    cookies: () => null,
    assertBreakerClosed: () => {},
    log: () => {},
    ...overrides,
  };
}

/**
 * `AdtHttpException`'s shape for a fault below HTTP: `status` is exactly 0 —
 * the transport's own marker that `httpclient.request()` never resolved to a
 * response at all — and there is no `.response` because nothing was ever
 * received to build one from.
 */
const socketHangUp = () => Object.assign(new Error("socket hang up"), { status: 0, code: "ECONNRESET" });

/** An axios-style rejection for an HTTP error response — a fault the server DID answer. */
function axiosError(status: number, data: string): Error {
  const e = new Error(`Request failed with status code ${status}`);
  return Object.assign(e, { response: { status, data } });
}

/**
 * `AdtCsrfException`/`AdtErrorException`'s shape when SAP answers with an
 * error body (403 CSRF, 406 Accept trap, an unparseable 500): `AdtHTTP`
 * throws these off a resolved response, but the exception itself carries
 * neither `.response` nor a numeric `.status`. Still an answer, not a
 * dropped connection.
 */
function answeredNoStatus(message: string): Error {
  return new Error(message);
}

/**
 * `AdtHttpException`'s shape for an answered non-2xx that DOES carry a
 * `.status` (a genuine 401) but never a `.response`. Also an answer, not a
 * dropped connection — the distinguishing fact is `status === 0`, not the
 * presence of `.response`.
 */
function answeredWithStatus(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("detectSystemRole tells a dropped connection apart from an answer it did not like", () => {
  it("a rejection reporting HTTP status 0 (the transport never resolved) sets probeFailure with the raw cause", async () => {
    const probes = fakeProbes({
      probeT000: async () => {
        throw socketHangUp();
      },
      // Escalation must not fire and must not paper over the probe failure —
      // rejecting it keeps this test about probeT000 alone.
      getAtoSettings: async () => {
        throw new Error("ato/settings unreachable too");
      },
    });

    const detection = await detectSystemRole(probes, { client: "001" });

    expect(detection.role).toBe("inconclusive");
    expect(detection.probeFailure).toBe("socket hang up");
  });

  it("a 403 the probe did not like is NOT a probe failure — probeFailure stays undefined", async () => {
    const probes = fakeProbes({
      probeT000: async () => {
        throw axiosError(403, "<csrf failure>");
      },
      getAtoSettings: async () => {
        throw new Error("ato/settings unreachable too");
      },
    });

    const detection = await detectSystemRole(probes, { client: "001" });

    expect(detection.role).toBe("inconclusive");
    expect(detection.probeFailure).toBeUndefined();
  });

  it("a 200 with a body the parser rejects is NOT a probe failure — probeFailure stays undefined", async () => {
    const probes = fakeProbes({
      probeT000: async () => ({ status: 200, body: "<not a tableData doc>", headers: {} }),
      getAtoSettings: async () => {
        throw new Error("ato/settings unreachable too");
      },
    });

    const detection = await detectSystemRole(probes, { client: "001" });

    expect(detection.role).toBe("inconclusive");
    expect(detection.probeFailure).toBeUndefined();
  });

  it("a 403-CSRF-shaped exception (no .response, no .status) is NOT a probe failure — probeFailure stays undefined", async () => {
    const probes = fakeProbes({
      probeT000: async () => {
        throw answeredNoStatus("CSRF token validation failed");
      },
      getAtoSettings: async () => {
        throw new Error("ato/settings unreachable too");
      },
    });

    const detection = await detectSystemRole(probes, { client: "001" });

    expect(detection.role).toBe("inconclusive");
    expect(detection.probeFailure).toBeUndefined();
  });

  it("a 406-Accept-trap-shaped exception (no .response, no .status) is NOT a probe failure — probeFailure stays undefined", async () => {
    const probes = fakeProbes({
      probeT000: async () => {
        throw answeredNoStatus("exc:exception in response body");
      },
      getAtoSettings: async () => {
        throw new Error("ato/settings unreachable too");
      },
    });

    const detection = await detectSystemRole(probes, { client: "001" });

    expect(detection.role).toBe("inconclusive");
    expect(detection.probeFailure).toBeUndefined();
  });

  it("a 401 exception (status: 401, no .response) is NOT a probe failure — 401 is an answer, not a dropped connection", async () => {
    const probes = fakeProbes({
      probeT000: async () => {
        throw answeredWithStatus(401, "Request failed with status code 401");
      },
      getAtoSettings: async () => {
        throw new Error("ato/settings unreachable too");
      },
    });

    const detection = await detectSystemRole(probes, { client: "001" });

    expect(detection.role).toBe("inconclusive");
    expect(detection.probeFailure).toBeUndefined();
  });
});

// -------------------------------------------------------------- SafetyGate ---

const target = { name: "ZCL_ORDER", packageName: "ZSD", type: "CLAS/OC" };

/** The evidence a dropped-probe lockout actually carries, from test 1 above. */
const DROPPED_PROBE_REASON = "T000 data-preview probe failed: socket hang up";
const DROPPED_PROBE_CAUSE = "socket hang up";

/** A gate standing for the live dropped-transport specimen: writes locked out by a probe that never answered. */
function probeFailureGate(over: Partial<SafetyConfig> = {}): SafetyGate {
  return new SafetyGate({
    readOnly: true,
    allowPackages: ["$TMP", "Z*"],
    writesLockedOut: true,
    lockoutReason: DROPPED_PROBE_REASON,
    roleProbeFailure: DROPPED_PROBE_CAUSE,
    ...over,
  });
}

/** A gate standing for the ordinary policy lockout: an answer that did not prove non-productive. */
function unprovenAnswerGate(over: Partial<SafetyConfig> = {}): SafetyGate {
  return new SafetyGate({
    readOnly: true,
    allowPackages: ["$TMP", "Z*"],
    writesLockedOut: true,
    lockoutReason: 'T000-CCCATEGORY = "S" (not "P") for logon client 000, but ato/settings could not be reached.',
    ...over,
  });
}

function thrown(fn: () => void): AbapError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AbapError) return e;
    throw e;
  }
  throw new Error("expected the gate to throw, but it allowed the call");
}

describe("a dropped probe does not get the deny-list hint written for an unproven answer", () => {
  it("assertDataPreview throws ROLE_PROBE_FAILED, names the real cause, and carries no deny-list remediation", () => {
    const err = thrown(() => probeFailureGate().assertDataPreview("T000"));

    expect(err.code).toBe("ROLE_PROBE_FAILED");
    expect(err.hint).not.toMatch(/ABAP_DATA_PREVIEW_DENY_TABLES/);
    expect(err.hint).not.toMatch(/deny-list/i);
    expect(err.message).toMatch(/socket hang up/);

    const combined = `${err.message} ${err.hint ?? ""}`;
    expect(combined).not.toMatch(/could not be proven non-productive/i);
  });

  it("the preview is still refused — this fix changes only how the refusal is explained, not whether", () => {
    const decision = probeFailureGate().evaluateDataPreview("T000");
    expect(decision.allowed).toBe(false);
  });
});

describe("the ordinary policy refusal (an answer that did not prove non-productive) is untouched", () => {
  it("assertDataPreview still throws READ_ONLY with the deny-list hint and the 'could not be proven' wording", () => {
    const err = thrown(() => unprovenAnswerGate().assertDataPreview("T000"));

    expect(err.code).toBe("READ_ONLY");
    expect(err.hint).toMatch(/ABAP_DATA_PREVIEW_DENY_TABLES/);
    expect(err.message).toMatch(/could not be proven non-productive/);
  });

  it("a productive system still gets the productive refusal, unchanged", () => {
    const gate = new SafetyGate({
      readOnly: true,
      allowPackages: ["$TMP", "Z*"],
      productive: true,
      writesLockedOut: true,
    });
    const err = thrown(() => gate.assertDataPreview("T000"));
    expect(err.code).toBe("READ_ONLY");
    expect(err.message).toMatch(/productive/i);
  });
});

describe("the write path gets the same treatment", () => {
  it("evaluate('write', ...) is refused with ROLE_PROBE_FAILED when roleProbeFailure is set", () => {
    const decision = probeFailureGate().evaluate("write", target);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("ROLE_PROBE_FAILED");
  });

  it("assert('write', ...) throws a hint that does not instruct the operator to set a write flag or allowlist", () => {
    const err = thrown(() => probeFailureGate().assert("write", target));
    expect(err.code).toBe("ROLE_PROBE_FAILED");
    // The hint DOES name ABAP_MODE and "allowlist" — to rule them out ("no
    // flag, allowlist or ABAP_MODE value is involved"), which is honest and
    // useful. What it must never do is instruct the operator to set one, the
    // way the ordinary READ_ONLY hint below does.
    expect(err.hint).not.toMatch(/Set ABAP_ALLOW_WRITE/);
    expect(err.hint).not.toMatch(/ABAP_ALLOW_PACKAGES/);
    expect(err.hint).toMatch(/restart/i);
  });

  it("without roleProbeFailure, the write path keeps its existing READ_ONLY refusal and ABAP_ALLOW_WRITE hint", () => {
    const err = thrown(() => unprovenAnswerGate().assert("write", target));
    expect(err.code).toBe("READ_ONLY");
    expect(err.hint).toMatch(/ABAP_ALLOW_WRITE/);
    expect(err.hint).toMatch(/ABAP_ALLOW_PACKAGES/);
  });
});

describe("the hint's central claim: a probe-failure lockout is a one-way latch, so restarting (not retrying) is the correct advice", () => {
  it("a later update() carrying a clean, nonproductive verdict does not lift the lockout", () => {
    const gate = probeFailureGate();
    expect(gate.evaluateDataPreview("T000").allowed).toBe(false);

    // The exact shape of a retried tool call succeeding on its second attempt:
    // the pool re-connects, the probe answers cleanly this time, and
    // `server.ts` transcribes a verdict that would, on its own, open writes.
    gate.update({
      writesLockedOut: false,
      lockoutReason: 'T000-CCCATEGORY = "C" (not "P") for logon client 001.',
      roleProbeFailure: undefined,
      systemRole: "nonproductive",
    });

    expect(gate.evaluateDataPreview("T000").allowed).toBe(false);
    expect(gate.evaluate("write", target).allowed).toBe(false);
  });
});

describe("lockoutReason and roleProbeFailure latch as a single unit", () => {
  it("a later update() with a different lockoutReason and no roleProbeFailure does not desynchronise the pair", () => {
    const gate = probeFailureGate();

    gate.update({
      writesLockedOut: false,
      lockoutReason: "a completely different verdict's reason",
      roleProbeFailure: undefined,
    });

    const cfg = gate.config;
    // The pair must stay coherent: whichever verdict's reason is quoted, its
    // matching probeFailure travels with it. Here the latch keeps the ORIGINAL
    // probe-failure verdict, so its cause must still be the one attached.
    if (cfg.lockoutReason === DROPPED_PROBE_REASON) {
      expect(cfg.roleProbeFailure).toBe(DROPPED_PROBE_CAUSE);
    } else {
      // If the latch ever changes shape, the pair must still not straddle two
      // different verdicts: a reason with no matching failure, or vice versa,
      // is the exact defect this test exists to catch.
      expect(cfg.lockoutReason === DROPPED_PROBE_REASON).toBe(
        cfg.roleProbeFailure === DROPPED_PROBE_CAUSE,
      );
    }
  });
});
