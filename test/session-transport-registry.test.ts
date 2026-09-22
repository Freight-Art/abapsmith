/**
 * #174/#175: the session-created registry (`noteCreated()`/`createdThisSession()`)
 * must out-rank both a fresh create and an older abapsmith-attributed request,
 * even when CTS's own candidate list never surfaces it — see the "Registry
 * consult" block in `#resolveAuto`, src/adt/session-transport.ts.
 *
 * Offline, same idiom as test/session-transport-package-candidates.test.ts:
 * `cts` is an injected fake, no appliance involved.
 */
import { describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrHeader, TrRequest, TrRequirement } from "../src/adt/transports.js";
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

const header = (trkorr: string, overrides: Partial<TrHeader> = {}): TrHeader => ({
  trkorr,
  kind: "workbench",
  kindRaw: "K",
  status: "modifiable",
  statusRaw: "D",
  owner: "DEVELOPER",
  description: "a request CTS offered",
  ...overrides,
});

const abapsmithCandidate = (overrides: Partial<TrHeader> = {}): TrHeader =>
  header("A4HK900131", { description: "abapsmith session 2026-08-20", ...overrides });

const trShowResult = (overrides: Partial<TrRequest> = {}): TrRequest => ({
  trkorr: "A4HK900200",
  kind: "workbench",
  kindRaw: "K",
  status: "modifiable",
  statusRaw: "D",
  owner: "DEVELOPER",
  description: "session request",
  tasks: [],
  objects: [],
  ...overrides,
});

const mgrWith = (cts: Record<string, unknown>, allow = ["auto"]) =>
  new SessionTransport({
    allowTransports: allow,
    authorizeCreate,
    whoami: () => "DEVELOPER",
    cts: cts as never,
  });

describe("session-transport registry consult (#174, #175)", () => {
  it("#174: a request registered with noteCreated() that CTS does not list is adopted for a bridge create — confirmed by trShow, nothing created", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const trRequirement = vi.fn(async () => packageReq({ candidates: [] }));
    const trShow = vi.fn(async () => trShowResult({ trkorr: "A4HK900200" }));
    const mgr = mgrWith({ trRequirement, trCreate, trShow });
    mgr.noteCreated("A4HK900200");

    const res = await mgr.resolveForNewTransportable(conn, target);
    if (res.outcome !== "transport") throw new Error("expected a transport");
    expect(res.corrNr).toBe("A4HK900200");
    expect(res.source).toBe("session-adopted");
    expect(trCreate).not.toHaveBeenCalled();
    expect(trShow).toHaveBeenCalledTimes(1);
    expect(trShow.mock.calls[0]?.[1]).toBe("A4HK900200");
    expect(mgr.lastAutoDecision?.reason).toMatch(/THIS SESSION created/);
    expect(mgr.lastAutoDecision?.reason).toMatch(/CTS did not list it/);
  });

  it("#174: the registry is consulted even when the package check is pinned or fails (candidates dropped)", async () => {
    const trShow = vi.fn(async () => trShowResult({ trkorr: "A4HK900200" }));

    const trCreateA = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const trRequirementA = vi.fn(async () => packageReq({ pinnedTo: "A4HK900999", pinnedOwner: "DEVELOPER" }));
    const mgrA = mgrWith({ trRequirement: trRequirementA, trCreate: trCreateA, trShow });
    mgrA.noteCreated("A4HK900200");
    const resA = await mgrA.resolveForNewTransportable(conn, target);
    if (resA.outcome !== "transport") throw new Error("expected a transport");
    expect(resA.corrNr).toBe("A4HK900200");
    expect(trCreateA).not.toHaveBeenCalled();

    const trCreateB = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const trRequirementB = vi.fn(async () => {
      throw new Error("CTS unreachable");
    });
    const mgrB = mgrWith({ trRequirement: trRequirementB, trCreate: trCreateB, trShow });
    mgrB.noteCreated("A4HK900200");
    const resB = await mgrB.resolveForNewTransportable(conn, target);
    if (resB.outcome !== "transport") throw new Error("expected a transport");
    expect(resB.corrNr).toBe("A4HK900200");
    expect(trCreateB).not.toHaveBeenCalled();
  });

  it("#174: a registered request that trShow reports released is skipped and a fresh one is created", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900321", path: "/x/A4HK900321" }));
    const trRequirement = vi.fn(async () => packageReq({ candidates: [] }));
    const trShow = vi.fn(async () =>
      trShowResult({ trkorr: "A4HK900200", status: "released", statusRaw: "R" }),
    );
    const mgr = mgrWith({ trRequirement, trCreate, trShow });
    mgr.noteCreated("A4HK900200");

    const res = await mgr.resolveForNewTransportable(conn, target);
    if (res.outcome !== "transport") throw new Error("expected a transport");
    expect(trCreate).toHaveBeenCalledTimes(1);
    expect(res.corrNr).toBe("A4HK900321");
    expect(res.reason).toMatch(/^Created request/);
  });

  it("#175: the session-created request wins over an older abapsmith-described request CTS lists", async () => {
    const older = abapsmithCandidate({ trkorr: "A4HK900100", owner: "DEVELOPER" });
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const trRequirement = vi.fn(async () => packageReq({ candidates: [older] }));
    const trShow = vi.fn(async () => trShowResult({ trkorr: "A4HK900200" }));
    const mgr = mgrWith({ trRequirement, trCreate, trShow });
    mgr.noteCreated("A4HK900200");

    const res = await mgr.resolveForNewTransportable(conn, target);
    if (res.outcome !== "transport") throw new Error("expected a transport");
    expect(res.corrNr).toBe("A4HK900200");
    expect(trCreate).not.toHaveBeenCalled();
  });

  it("#175: an older abapsmith-described request is adopted only when the session has none, and the reason says so", async () => {
    const older = abapsmithCandidate({ trkorr: "A4HK900100", owner: "DEVELOPER" });
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const trRequirement = vi.fn(async () => packageReq({ candidates: [older] }));
    const mgr = mgrWith({ trRequirement, trCreate });

    const res = await mgr.resolveForNewTransportable(conn, target);
    if (res.outcome !== "transport") throw new Error("expected a transport");
    expect(res.corrNr).toBe("A4HK900100");
    expect(res.reason).toMatch(
      /Resolver preferred A4HK900100 \(created by this server on 2026-08-20, description "abapsmith session 2026-08-20"\)/,
    );
    expect(res.reason).toMatch(/because this session has no request of its own/);
    expect(res.reason).toMatch(/THIS SESSION DID NOT CREATE IT/);
  });

  it("#175: a cached older request is pre-empted by a request registered later in the session", async () => {
    const older = abapsmithCandidate({ trkorr: "A4HK900100", owner: "DEVELOPER" });
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const trRequirement = vi.fn(async () => packageReq({ candidates: [older] }));
    const trShow = vi.fn(async () => trShowResult({ trkorr: "A4HK900200" }));
    const mgr = mgrWith({ trRequirement, trCreate, trShow });

    const first = await mgr.resolveForNewTransportable(conn, target);
    if (first.outcome !== "transport") throw new Error("expected a transport");
    expect(first.corrNr).toBe("A4HK900100");

    mgr.noteCreated("A4HK900200");
    const second = await mgr.resolveForNewTransportable(conn, target);
    if (second.outcome !== "transport") throw new Error("expected a transport");
    expect(second.corrNr).toBe("A4HK900200");
    expect(second.reason).toMatch(/Switched from A4HK900100/);
  });

  it("#175: a cached session-created request costs no trShow on the next resolve", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const trRequirement = vi.fn(async () => packageReq({ candidates: [] }));
    const trShow = vi.fn(async () => trShowResult({ trkorr: "A4HK900200" }));
    const mgr = mgrWith({ trRequirement, trCreate, trShow });
    mgr.noteCreated("A4HK900200");

    const first = await mgr.resolveForNewTransportable(conn, target);
    if (first.outcome !== "transport") throw new Error("expected a transport");
    expect(first.corrNr).toBe("A4HK900200");
    expect(trShow).toHaveBeenCalledTimes(1);

    const second = await mgr.resolveForNewTransportable(conn, { ...target, devclass: PKG });
    if (second.outcome !== "transport") throw new Error("expected a transport");
    expect(second.corrNr).toBe("A4HK900200");
    expect(second.source).toBe("session-cached");
    expect(trShow).toHaveBeenCalledTimes(1);
  });

  it("#175: a server pin is recorded in lastAutoDecision naming the lock object and the session's request", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900321", path: "/x/A4HK900321" }));
    const pinnedTarget = { uri: "/sap/bc/adt/ddic/tables/zmcp_t", name: "ZMCP_T", type: "TABL/DT", devclass: PKG };
    let call = 0;
    const trRequirement = vi.fn(async () => {
      call++;
      if (call === 1) return packageReq({ candidates: [] });
      return {
        uri: pinnedTarget.uri,
        operation: "U",
        devclass: PKG,
        candidates: [],
        locks: [
          {
            object: { pgmid: "R3TR", type: "TABL", name: "ZMCP_T" },
            request: header("A4HK900300"),
            tasks: [],
          },
        ],
        pinnedTo: "A4HK900300",
        pinnedOwner: "DEVELOPER",
        messages: [],
        checkFailed: false,
        raw: { result: "S", korrflag: "X", recording: "" },
        kind: "transport-required",
        mustSupplyCorrNr: true,
        serverWouldFabricate: false,
      } as unknown as TrRequirement;
    });
    const mgr = mgrWith({ trRequirement, trCreate });

    const created = await mgr.resolveForNewTransportable(conn, target);
    if (created.outcome !== "transport") throw new Error("expected a transport");
    expect(created.corrNr).toBe("A4HK900321");

    const pinned = await mgr.resolve(conn, pinnedTarget);
    if (pinned.outcome !== "transport") throw new Error("expected a transport");
    expect(pinned.corrNr).toBe("A4HK900300");
    expect(pinned.source).toBe("server-pin");
    expect(mgr.lastAutoDecision).toEqual({
      trkorr: "A4HK900300",
      source: "server-pin",
      reason: expect.stringMatching(
        /^Server pinned ZMCP_T to A4HK900300 \(it holds the lock for R3TR TABL ZMCP_T\), not the session's request A4HK900321\.$/,
      ),
    });
  });
});
