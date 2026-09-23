/**
 * Issue #143: every transport-allowlist refusal names its rule and a remedy
 * the CALLER can act on (change or omit `corr_nr`, or ask the operator) —
 * never an environment edit, which an agent cannot make and which sent it in
 * circles — and is signalled terminal (`retryable: false`).
 *
 * Covers both places a refusal is minted: the safety gate's step 10 (the
 * `transport allowlist` rules in src/safety.ts, via `transportAllowlistHint`)
 * and the session resolver's own denials (src/adt/session-transport.ts).
 * Entirely offline; the resolver's CTS client is an injected fake.
 */
import { describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import { SafetyGate, transportAllowlistHint } from "../src/safety.js";

const PIN_A = "A4HK900117";
const PIN_B = "A4HK900118";
const OTHER = "A4HK900999";

/** Wording that tells the caller to change the server's environment — an agent can never do that. */
const ENVIRONMENT_EDIT = /set ABAP_ALLOW_TRANSPORTS|export ABAP_|add .* to ABAP_ALLOW_TRANSPORTS|use "\*"|ABAP_ALLOW_TRANSPORTS=\*|restart the server|edit (the )?(env|\.env|config)/i;

const gateWith = (allowTransports: string[]): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"], allowTransports });

const TARGET = { name: "ZMCP_V_X", type: "VIEW/DV", packageName: "ZTM", exists: false } as const;

const catchGate = (fn: () => void): AbapError => {
  try {
    fn();
  } catch (e) {
    expect(isAbapError(e)).toBe(true);
    return e as AbapError;
  }
  throw new Error("expected the gate to refuse");
};

describe("transportAllowlistHint — one rule-specific, caller-side, terminal hint per allowlist shape", () => {
  it("auto only: omit corr_nr; naming a request is accepted only for one this session created", () => {
    const h = transportAllowlistHint(["auto"]);
    expect(h).toMatch(/ABAP_ALLOW_TRANSPORTS=auto/);
    expect(h).toMatch(/Omit corr_nr/);
    expect(h).toMatch(/accepted only when it is a request this session created/);
    expect(h).toMatch(/terminal/);
    expect(h).not.toMatch(ENVIRONMENT_EDIT);
  });

  it("pinned list: only those requests; pass one, or omit corr_nr; ask the operator to extend the list", () => {
    const h = transportAllowlistHint([PIN_A, PIN_B]);
    expect(h).toMatch(new RegExp(`Only these requests are permitted: ${PIN_A}, ${PIN_B}`));
    expect(h).toMatch(/Pass one of them as corr_nr/);
    expect(h).toMatch(/omit corr_nr/);
    expect(h).toMatch(/No other request number passes/);
    expect(h).toMatch(/ask the operator to extend the list/);
    expect(h).toMatch(/terminal/);
    expect(h).not.toMatch(ENVIRONMENT_EDIT);
  });

  it("explicitly empty: nothing transportable can succeed; only local packages; ask the operator", () => {
    const h = transportAllowlistHint([]);
    expect(h).toMatch(/No transportable write can succeed in this session/);
    expect(h).toMatch(/explicitly empty/);
    expect(h).toMatch(/\$TMP/);
    expect(h).toMatch(/Ask the operator/);
    expect(h).not.toMatch(ENVIRONMENT_EDIT);
  });

  it("wildcard: any modifiable request the user owns, or omit corr_nr", () => {
    const h = transportAllowlistHint(["*"]);
    expect(h).toMatch(/modifiable request/);
    expect(h).toMatch(/omit corr_nr/);
    expect(h).not.toMatch(ENVIRONMENT_EDIT);
  });
});

describe("SafetyGate step 10 — each denial rule carries its own hint and is terminal", () => {
  it("rule 'transport allowlist' under ['auto'] with a NAMED request: omit corr_nr", () => {
    const e = catchGate(() =>
      gateWith(["auto"]).assert("write", TARGET, {
        corr: { kind: "transport", corrNr: OTHER, source: "named" },
      }),
    );
    expect(e.code).toBe("SAFETY_DENIED");
    expect(e.details.rule).toBe("transport allowlist");
    expect(e.message).toMatch(new RegExp(`Transport ${OTHER} is not permitted`));
    expect(e.hint).toMatch(/Omit corr_nr/);
    expect(e.hint).toMatch(/accepted only when it is a request this session created/);
    expect(e.retryable).toBe(false);
    expect(e.hint).not.toMatch(ENVIRONMENT_EDIT);
  });

  it("rule 'transport allowlist' under a pinned list with a request outside it: the list, and the operator", () => {
    const e = catchGate(() =>
      gateWith([PIN_A, PIN_B]).assert("write", TARGET, {
        corr: { kind: "transport", corrNr: OTHER, source: "named" },
      }),
    );
    expect(e.code).toBe("SAFETY_DENIED");
    expect(e.details.rule).toBe("transport allowlist");
    expect(e.hint).toMatch(new RegExp(`Only these requests are permitted: ${PIN_A}, ${PIN_B}`));
    expect(e.hint).toMatch(/ask the operator to extend the list/);
    expect(e.retryable).toBe(false);
    expect(e.hint).not.toMatch(ENVIRONMENT_EDIT);
  });

  it("rule 'transport allowlist' under a MIXED list (auto plus a pin) with a request outside it", () => {
    const e = catchGate(() =>
      gateWith(["auto", PIN_A]).assert("write", TARGET, {
        corr: { kind: "transport", corrNr: OTHER, source: "named" },
      }),
    );
    expect(e.details.rule).toBe("transport allowlist");
    expect(e.hint).toMatch(new RegExp(PIN_A));
    expect(e.hint).toMatch(/corr_nr/);
    expect(e.retryable).toBe(false);
    expect(e.hint).not.toMatch(ENVIRONMENT_EDIT);
  });

  it("rule 'transport allowlist (fail closed)' under an explicitly empty list fires even UNRESOLVED — before any request could be created", () => {
    const e = catchGate(() => gateWith([]).assert("write", TARGET, { corr: { kind: "unresolved" }, phase: "preflight" }));
    expect(e.code).toBe("SAFETY_DENIED");
    expect(e.details.rule).toBe("transport allowlist (fail closed)");
    expect(e.hint).toMatch(/No transportable write can succeed/);
    expect(e.hint).toMatch(/Ask the operator/);
    expect(e.retryable).toBe(false);
    expect(e.hint).not.toMatch(ENVIRONMENT_EDIT);
  });

  it("the ONE thing the gate does accept under ['auto'] is a request abapsmith itself resolved (source: auto) — unchanged", () => {
    expect(() =>
      gateWith(["auto"]).assert("write", TARGET, { corr: { kind: "transport", corrNr: OTHER, source: "auto" } }),
    ).not.toThrow();
    // ...and never under a pinned list, whatever the source.
    expect(() =>
      gateWith([PIN_A]).assert("write", TARGET, { corr: { kind: "transport", corrNr: OTHER, source: "auto" } }),
    ).toThrow();
  });
});

describe("SessionTransport denials — the resolver's own hints are caller-side and name the rule", () => {
  const conn = {} as AbapConnection;
  const target = { uri: "/sap/bc/adt/packages/ztm", name: "ZTM", type: "DEVC/K", devclass: "ZTM" };
  const authorizeCreate = () =>
    new SafetyGate({ readOnly: false, allowPackages: ["*"] }).authorize(
      "transport",
      { name: "ZTM", packageName: "ZTM" },
      { corr: { kind: "unresolved" } },
    );
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
  const releasedShow = (trkorr: string) =>
    vi.fn(async () => ({
      trkorr,
      kind: "workbench" as const,
      kindRaw: "K",
      status: "released" as const,
      statusRaw: "R",
      owner: "DEVELOPER",
      description: "old",
      tasks: [],
      objects: [],
    }));

  it("transports-disabled: no request can be resolved; only local packages; ask the operator", async () => {
    const trCreate = vi.fn();
    const mgr = new SessionTransport({ allowTransports: [], authorizeCreate, cts: { trCreate } as never });
    const res = await mgr.resolveForNewTransportable(conn, target);
    if (res.outcome !== "denied") throw new Error("expected a denial");
    expect(res.denial).toBe("transports-disabled");
    expect(res.hint).toMatch(/No transportable write can succeed/);
    expect(res.hint).toMatch(/Ask the operator/);
    expect(res.hint).not.toMatch(ENVIRONMENT_EDIT);
    expect(trCreate).not.toHaveBeenCalled();
  });

  it("not-allowlisted: a NAMED request outside a pinned list names the list and the operator, and creates nothing", async () => {
    const trCreate = vi.fn();
    const mgr = new SessionTransport({
      allowTransports: [PIN_A],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trCreate, trShow: modifiableShow(OTHER) } as never,
    });
    const res = await mgr.resolveForNewTransportable(conn, target, { corrNr: OTHER });
    if (res.outcome !== "denied") throw new Error("expected a denial");
    expect(res.denial).toBe("not-allowlisted");
    expect(res.hint).toMatch(new RegExp(`Only these requests are permitted: ${PIN_A}`));
    expect(res.hint).toMatch(/corr_nr/);
    expect(res.hint).not.toMatch(ENVIRONMENT_EDIT);
    expect(trCreate).not.toHaveBeenCalled();
  });

  it("not-allowlisted: a NAMED request under ['auto'] says to omit corr_nr, and creates nothing", async () => {
    const trCreate = vi.fn();
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trCreate, trShow: modifiableShow(OTHER) } as never,
    });
    const res = await mgr.resolveForNewTransportable(conn, target, { corrNr: OTHER });
    if (res.outcome !== "denied") throw new Error("expected a denial");
    expect(res.denial).toBe("not-allowlisted");
    expect(res.hint).toMatch(/Omit corr_nr/);
    expect(res.hint).not.toMatch(ENVIRONMENT_EDIT);
    expect(trCreate).not.toHaveBeenCalled();
  });

  it("no-usable-pin: every pinned request is released — pinned mode never creates; ask the operator to reopen or list one", async () => {
    const trCreate = vi.fn();
    const mgr = new SessionTransport({
      allowTransports: [PIN_A],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trCreate, trShow: releasedShow(PIN_A) } as never,
    });
    const res = await mgr.resolveForNewTransportable(conn, target);
    if (res.outcome !== "denied") throw new Error("expected a denial");
    expect(res.denial).toBe("no-usable-pin");
    expect(res.hint).toMatch(/Pinned mode never creates a request/);
    expect(res.hint).toMatch(new RegExp(PIN_A));
    expect(res.hint).toMatch(/ask the operator/);
    expect(res.hint).toMatch(/No corr_nr value outside that list passes/);
    expect(res.hint).not.toMatch(ENVIRONMENT_EDIT);
    expect(trCreate).not.toHaveBeenCalled();
  });
});
