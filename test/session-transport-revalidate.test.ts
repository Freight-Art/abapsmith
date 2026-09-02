/**
 * A cached session transport request that CTS has since released must
 * not go on being handed out as if it were still alive. `SessionTransport`
 * re-checks the cached request at use time instead of trusting it until a
 * write fails — see `#resolveAuto` in src/adt/session-transport.ts.
 *
 * Entirely offline: no appliance, no fixtures on the wire. Same idiom as
 * test/session-transport-journal.test.ts — `transportableReq` builds a
 * minimal valid `TrRequirement`, `authorizeCreate` mints the gate token
 * `trCreate` requires, and the CTS client is an injected fake.
 *
 * Selection (adopting an existing candidate instead of creating) is
 * not on this branch: there is no `session-selected` source here, so a
 * non-empty candidate list that doesn't corroborate the cache still resolves
 * through create, not adoption.
 */
import { describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrHeader, TrRequirement } from "../src/adt/transports.js";
import { SafetyGate } from "../src/safety.js";

const authorizeCreate = (devClass: string) =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"] }).authorize(
    "transport",
    { name: devClass, packageName: devClass },
    { corr: { kind: "unresolved" } },
  );

const OBJ_URI = "/sap/bc/adt/programs/programs/zmcp_demo/source/main";
const conn = {} as AbapConnection;
const target = { uri: OBJ_URI, name: "ZMCP_DEMO", type: "PROG/P", devclass: "ZPKG" };

/** A minimal, always-valid transportable `TrRequirement`. Only the fields
 * `resolve()` reads matter — same idiom as `transportableReq` in
 * test/session-transport-journal.test.ts. */
const transportableReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({
    uri: OBJ_URI,
    operation: "I",
    devclass: "ZPKG",
    candidates: [],
    locks: [],
    messages: [],
    checkFailed: false,
    raw: { result: "S", korrflag: "X", recording: "" },
    kind: "transport-required",
    mustSupplyCorrNr: true,
    serverWouldFabricate: false,
    ...overrides,
  }) as unknown as TrRequirement;

/** A CTS candidate header. */
const candidate = (overrides: Partial<TrHeader> = {}): TrHeader => ({
  trkorr: "A4HK900131",
  kind: "workbench",
  kindRaw: "K",
  status: "modifiable",
  statusRaw: "D",
  owner: "DEVELOPER",
  description: "a request CTS offered",
  ...overrides,
});

/** A `trShow` fake reporting a released request. */
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

describe("use-time revalidation of a cached request", () => {
  it("probes and heals when a fresh non-empty candidate list omits the cached request, released", async () => {
    const cachedTrkorr = "A4HK900117";
    const freshTrkorr = "A4HK900199";
    let createCall = 0;
    const trCreate = vi.fn(async () => {
      createCall++;
      const trkorr = createCall === 1 ? cachedTrkorr : freshTrkorr;
      return { trkorr, path: `/x/${trkorr}` };
    });
    const trShow = releasedShow(cachedTrkorr);
    // Present in the fresh list, but not the cached request — and there is no
    // adoption path on this branch, so this candidate qualifying for nothing
    // is exactly the point: only its non-emptiness matters here.
    const otherCandidate = candidate({ trkorr: "A4HK900131", owner: "DEVELOPER" });
    let call = 0;
    const trRequirement = vi.fn(async () => {
      call++;
      return call === 1
        ? transportableReq({ candidates: [] })
        : transportableReq({ candidates: [otherCandidate] });
    });
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate, trShow } as never,
    });

    const first = await mgr.resolve(conn, target);
    if (first.outcome !== "transport") throw new Error("unreachable");
    expect(first.corrNr).toBe(cachedTrkorr);

    const second = await mgr.resolve(conn, target);
    if (second.outcome !== "transport") throw new Error("unreachable");
    expect(trShow).toHaveBeenCalledTimes(1);
    expect(second.corrNr).toBe(freshTrkorr);
    expect(second.reason).toContain(cachedTrkorr);
    expect(second.reason).toMatch(/is no longer usable \(released\)/);
    expect(second.reason).toContain(`Created request ${freshTrkorr}`);
  });

  it("does not probe when the fresh candidate list already corroborates the cached request", async () => {
    const cachedTrkorr = "A4HK900117";
    const trCreate = vi.fn(async () => ({
      trkorr: cachedTrkorr,
      path: `/x/${cachedTrkorr}`,
    }));
    const trShow = vi.fn();
    let call = 0;
    const trRequirement = vi.fn(async () => {
      call++;
      return call === 1
        ? transportableReq({ candidates: [] })
        : transportableReq({
            candidates: [candidate({ trkorr: cachedTrkorr, owner: "DEVELOPER" })],
          });
    });
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate, trShow } as never,
    });

    await mgr.resolve(conn, target);
    const second = await mgr.resolve(conn, target);
    if (second.outcome !== "transport") throw new Error("unreachable");
    expect(second.source).toBe("session-cached");
    expect(second.corrNr).toBe(cachedTrkorr);
    expect(trShow).not.toHaveBeenCalled();
  });

  it("does not probe on a cached hit when the fresh candidate list is empty — empty is not evidence", async () => {
    const cachedTrkorr = "A4HK900117";
    const trCreate = vi.fn(async () => ({
      trkorr: cachedTrkorr,
      path: `/x/${cachedTrkorr}`,
    }));
    const trShow = vi.fn();
    const trRequirement = vi.fn(async () => transportableReq({ candidates: [] }));
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate, trShow } as never,
    });

    await mgr.resolve(conn, target);
    const second = await mgr.resolve(conn, target);
    if (second.outcome !== "transport") throw new Error("unreachable");
    expect(second.source).toBe("session-cached");
    expect(trShow).not.toHaveBeenCalled();
  });

  it("heals a dead cached request within the same call when revalidate is explicit, instead of denying", async () => {
    const cachedTrkorr = "A4HK900117";
    const freshTrkorr = "A4HK900200";
    let createCall = 0;
    const trCreate = vi.fn(async () => {
      createCall++;
      const trkorr = createCall === 1 ? cachedTrkorr : freshTrkorr;
      return { trkorr, path: `/x/${trkorr}` };
    });
    const trShow = releasedShow(cachedTrkorr);
    // No candidates at all — revalidate:true must trigger the probe on its
    // own; an empty list would otherwise never be evidence enough by itself.
    const trRequirement = vi.fn(async () => transportableReq({ candidates: [] }));
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate, trShow } as never,
    });

    const first = await mgr.resolve(conn, target);
    if (first.outcome !== "transport") throw new Error("unreachable");
    expect(first.corrNr).toBe(cachedTrkorr);

    const second = await mgr.resolve(conn, target, "I", { revalidate: true });
    expect(second.outcome).not.toBe("denied");
    if (second.outcome !== "transport") throw new Error("unreachable");
    expect(second.corrNr).toBe(freshTrkorr);
    expect(trShow).toHaveBeenCalledTimes(1);
    expect(second.reason).toMatch(/is no longer usable \(released\)/);
    expect(second.reason).toContain(`Created request ${freshTrkorr}`);
  });

  it("lastAutoDecision tracks the latest resolve(), not the first", async () => {
    const trkorr = "A4HK900117";
    const trCreate = vi.fn(async () => ({ trkorr, path: `/x/${trkorr}` }));
    const trRequirement = vi.fn(async () => transportableReq({ candidates: [] }));
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });

    const first = await mgr.resolve(conn, target);
    if (first.outcome !== "transport") throw new Error("unreachable");
    expect(mgr.lastAutoDecision).toEqual({
      trkorr,
      source: "session-created",
      reason: first.reason,
    });
    expect(mgr.lastAutoDecision?.reason).toMatch(/^Created request/);

    const second = await mgr.resolve(conn, target);
    if (second.outcome !== "transport") throw new Error("unreachable");
    expect(second.source).toBe("session-cached");
    expect(mgr.lastAutoDecision).toEqual({
      trkorr,
      source: "session-cached",
      reason: second.reason,
    });
    expect(mgr.lastAutoDecision?.reason).toMatch(/^Reusing this session's request/);
  });

  it("leaves the gone branch to an external invalidate() — the heal path resets straight to idle, never to gone", async () => {
    const cachedTrkorr = "A4HK900117";
    const freshTrkorr = "A4HK900201";
    let createCall = 0;
    const trCreate = vi.fn(async () => {
      createCall++;
      const trkorr = createCall === 1 ? cachedTrkorr : freshTrkorr;
      return { trkorr, path: `/x/${trkorr}` };
    });
    const trRequirement = vi.fn(async () => transportableReq({ candidates: [] }));
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });

    const first = await mgr.resolve(conn, target);
    if (first.outcome !== "transport") throw new Error("unreachable");
    expect(first.corrNr).toBe(cachedTrkorr);

    // Invalidated from outside the resolve() cycle — e.g. abap_transport
    // after a confirmed delete — so the pre-existing "gone" branch is what
    // handles this, not the use-time heal path this file is otherwise about.
    mgr.invalidate(cachedTrkorr, "deleted");
    expect(mgr.state.kind).toBe("gone");

    const stillDenied = await mgr.resolve(conn, target);
    expect(stillDenied.outcome).toBe("denied");
    if (stillDenied.outcome !== "denied") throw new Error("unreachable");
    expect(stillDenied.denial).toBe("transport-gone");
    expect(mgr.state.kind).toBe("idle");

    const healed = await mgr.resolve(conn, target);
    if (healed.outcome !== "transport") throw new Error("unreachable");
    expect(healed.corrNr).toBe(freshTrkorr);
  });
});
