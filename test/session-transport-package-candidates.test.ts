/**
 * Issue #141: `resolveForNewTransportable` — the route every not-yet-existing
 * object takes (the classic-bridge creates: VIEW/DV, TRAN/T, SHLP/DH, TABL/DI,
 * DEVC/K) — used to skip `#resolveAuto`'s adoption tiers entirely, because it
 * had no CTS candidate list: the object cannot be classified before it
 * exists. It now asks CTS for the modifiable requests of the PACKAGE and
 * hands those to the same adopt-else-create decision the ADT-lock types get,
 * so a caller's own open request for the package is reused rather than a
 * stranger created next to it.
 *
 * Entirely offline; the CTS client is an injected fake. Same idiom as
 * test/session-transport-adopt.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrHeader, TrRequirement } from "../src/adt/transports.js";
import { SafetyGate } from "../src/safety.js";

const conn = {} as AbapConnection;
const PKG = "ZTM";
const target = { uri: "/sap/bc/adt/ddic/views/zmcp_v_new", name: "ZMCP_V_NEW", type: "VIEW/DV", devclass: PKG };

const authorizeCreate = () =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"] }).authorize(
    "transport",
    { name: PKG, packageName: PKG },
    { corr: { kind: "unresolved" } },
  );

const packageReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({
    uri: `/sap/bc/adt/packages/${PKG.toLowerCase()}`,
    operation: "I",
    devclass: PKG,
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

const mgrWith = (trRequirement: ReturnType<typeof vi.fn>, trCreate: ReturnType<typeof vi.fn>, allow = ["auto"]) =>
  new SessionTransport({
    allowTransports: allow,
    authorizeCreate,
    whoami: () => "DEVELOPER",
    cts: { trRequirement, trCreate } as never,
  });

describe("resolveForNewTransportable — package-anchored candidates feed the adopt-else-create route", () => {
  it("asks CTS about the PACKAGE (never the not-yet-existing object) and adopts the request this session created", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const mine = candidate({ trkorr: "A4HK900200", description: "abapsmith session 2026-09-16" });
    const trRequirement = vi.fn(async () => packageReq({ candidates: [mine] }));
    const mgr = mgrWith(trRequirement, trCreate);
    mgr.noteCreated("A4HK900200"); // e.g. abap_transport operation=create earlier this session

    const res = await mgr.resolveForNewTransportable(conn, target);

    if (res.outcome !== "transport") throw new Error("expected a transport");
    expect(res.corrNr).toBe("A4HK900200");
    expect(res.created).toBe(false);
    expect(trCreate).not.toHaveBeenCalled();
    expect(trRequirement).toHaveBeenCalledTimes(1);
    expect(trRequirement.mock.calls[0]?.[1]).toBe(`/sap/bc/adt/packages/${PKG.toLowerCase()}`);
    expect(trRequirement.mock.calls[0]?.[2]).toBe(PKG);
    expect(mgr.lastAutoDecision?.trkorr).toBe("A4HK900200");
  });

  it("adopts an attributed candidate (owner + abapsmith description) it did not create, exactly as resolve() does", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const attributed = candidate({ trkorr: "A4HK900142", description: "abapsmith session 2026-09-10" });
    const trRequirement = vi.fn(async () => packageReq({ candidates: [attributed] }));
    const mgr = mgrWith(trRequirement, trCreate);

    const res = await mgr.resolveForNewTransportable(conn, target);

    if (res.outcome !== "transport") throw new Error("expected a transport");
    expect(res.corrNr).toBe("A4HK900142");
    expect(res.source).toBe("session-adopted");
    expect(trCreate).not.toHaveBeenCalled();
  });

  it("creates when the package's candidates are none of abapsmith's own — adoption never widens to a stranger's request", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const stranger = candidate({ trkorr: "A4HK900150", owner: "OTHERUSER", description: "someone else's" });
    const trRequirement = vi.fn(async () => packageReq({ candidates: [stranger] }));
    const mgr = mgrWith(trRequirement, trCreate);

    const res = await mgr.resolveForNewTransportable(conn, target);

    if (res.outcome !== "transport") throw new Error("expected a transport");
    expect(res.corrNr).toBe("A4HK900999");
    expect(res.created).toBe(true);
    expect(trCreate).toHaveBeenCalledTimes(1);
  });

  it("a failed or throwing candidate look-up degrades to creating — adoption is an optimisation, never a gate", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const trRequirement = vi.fn(async () => {
      throw new Error("CTS unreachable");
    });
    const mgr = mgrWith(trRequirement, trCreate);

    const res = await mgr.resolveForNewTransportable(conn, target);

    if (res.outcome !== "transport") throw new Error("expected a transport");
    expect(res.corrNr).toBe("A4HK900999");
    expect(trCreate).toHaveBeenCalledTimes(1);
  });

  it("never asks CTS when the caller NAMED a request or the list is pinned — no auto route, no candidate look-up", async () => {
    const trCreate = vi.fn();
    const trRequirement = vi.fn(async () => packageReq());
    const trShow = vi.fn(async () => ({ ...candidate({ trkorr: "A4HK900117" }), tasks: [], objects: [] }));

    const pinned = new SessionTransport({
      allowTransports: ["A4HK900117"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate, trShow } as never,
    });
    const res = await pinned.resolveForNewTransportable(conn, target);
    if (res.outcome !== "transport") throw new Error("expected a transport");
    expect(res.corrNr).toBe("A4HK900117");
    expect(trRequirement).not.toHaveBeenCalled();
    expect(trCreate).not.toHaveBeenCalled();
  });
});
