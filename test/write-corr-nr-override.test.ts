/**
 * Issue #65, round 2: `abap_write mode=delete` with a caller-named `corr_nr`
 * that DIFFERS from the request CTS already recorded the object in must be
 * refused — but the refusal never fired, because `SessionTransport`'s own
 * resolver silently swallowed the caller's number before `preflightCorr`
 * ever got a chance to compare it against anything.
 *
 * Root cause: `SessionTransport.#decideTransportable` (src/adt/session-transport.ts)
 * runs Step 4 (server-pin — CTS already recorded the object somewhere) BEFORE
 * Step 5 (the caller-named `corr_nr`). When both fire, `#resolvePin` used to
 * return `granted(pinnedTo, "server-pin", …)` with no trace of what the
 * caller asked for; `preflightCorr` then mapped `source: "server-pin"` to
 * `source: "auto"`, so `corr.corrNr` and the lock's request were identical by
 * construction and the old `divergentLockCorrNr` backstop — which is what
 * `test/delete-corr-nr-honoured.test.ts` and
 * `test/write-delete-corr-nr-note.test.ts` pin — could never see a
 * disagreement to report.
 *
 * The fix carries the caller's overridden number out of the resolver as
 * `SessionTrResolution.overrodeCorrNr` (only set on `source: "server-pin"`,
 * only when the caller named something different), threads it through
 * `GatedCorr`/`WriteResult` as `overrodeCorrNr`/`corrNrOverrode`, and:
 *   - refuses a DELETE pre-lock, in `preflightCorr` itself, the moment
 *     `overrodeCorrNr` is set — `corrNrNotHonoured(…, stage: "preflight")`.
 *   - lets a WRITE proceed (a PUT's request CAN be the one CTS already
 *     holds), but reports the override via `WriteResult.corrNrSent`/
 *     `corrNrOverrode`, and the tool layer surfaces `corr_nr_honoured: false`
 *     plus a dedicated note (`corrNrOverriddenWriteNote`).
 *
 * This file exists because BOTH existing regression files above drive their
 * divergence through a LOCK whose `CORRNR` disagrees with whatever corr was
 * sent — the OLD backstop, entirely orthogonal to the resolver-level bug
 * above. A `GatedCorr`/`SessionTrResolution` built by hand with
 * `source: "named"` (as those files' non-divergence cases do) never goes
 * anywhere near `#resolvePin`, so it cannot regress this bug either. Every
 * test below drives the scenario through the REAL resolver: a fake CTS
 * `trRequirement` answer reporting `pinnedTo`, so `#decideTransportable` and
 * `#resolvePin` run unmodified and for real.
 *
 * Three sections, increasingly close to the wire:
 *   1. `SessionTransport.resolve()` in isolation — no HTTP at all beyond the
 *      mocked `trRequirement`, mirroring `test/session-transport-journal.test.ts`'s
 *      `conn = {} as AbapConnection` idiom (the mocked `trRequirement` never
 *      touches `conn`).
 *   2. `deleteObject`/`writeObject` end-to-end, hand-rolled `FakeAdt`, copied
 *      (not imported — same deliberate per-file duplication convention as
 *      `test/delete-corr-nr-honoured.test.ts`'s own header explains) from
 *      that file's harness: `connected()`/`resp()`/`baseRoute()`/
 *      `OBJECT_XML()`/`LOCK_XML()`, `authorizeMutation`-backed
 *      `authWrite`/`authDelete`, `catchErr()`, and the same
 *      mock-only-`CtsClient` idiom for `SessionTransport`.
 *   3. `abapWrite` (src/tools/write.ts) — same harness, proving the header
 *      and note wiring downstream of `WriteResult.corrNrOverrode`.
 */
import { describe, expect, it, vi } from "vitest";
import { afterAll } from "vitest";
import { rm } from "node:fs/promises";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import {
  authorizeMutation,
  deleteObject,
  writeObject,
  NO_JOURNAL,
  type WriteTarget,
} from "../src/adt/write.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport, type SessionTrTarget } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { useFluidState } from "./helpers/fluid-classic-fake.js";

/** What CTS already recorded the object in — the resolver's `pinnedTo`. */
const T1 = "A4HK900117";
/** What the caller named — different from `T1`, so it gets overridden. */
const T2 = "A4HK900222";

// ---------------------------------------------------------------------------
// Section 1 — SessionTransport.resolve(), no HTTP: only `trRequirement` is
// faked, so Steps 3-7 of `#decideTransportable` (including `#resolvePin`) run
// for real. Idiom copied from test/session-transport-journal.test.ts (`conn
// = {} as AbapConnection`) and test/write.test.ts's `pinnedTo` helper.
// ---------------------------------------------------------------------------

const conn = {} as AbapConnection;
const target: SessionTrTarget = {
  uri: "/sap/bc/adt/programs/programs/zmcp_resolver_demo/source/main",
  name: "ZMCP_RESOLVER_DEMO",
  type: "PROG/P",
};

const unitFakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({
    uri: target.uri,
    operation: "U",
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

const pinnedMgr = (pinnedTo: string): SessionTransport =>
  new SessionTransport({
    allowTransports: ["*"],
    whoami: () => "DEVELOPER",
    cts: { trRequirement: vi.fn(async () => unitFakeReq({ pinnedTo })) },
  });

describe("SessionTransport.resolve(): server-pin vs caller-named corr_nr, unit level (issue #65 round 2)", () => {
  it("case 1: server pins T1, caller names DIFFERENT T2 — T1 wins, overrodeCorrNr carries T2", async () => {
    const res = await pinnedMgr(T1).resolve(conn, target, "U", { corrNr: T2 });
    expect(res.outcome).toBe("transport");
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.corrNr).toBe(T1);
    expect(res.source).toBe("server-pin");
    expect(res.pinned).toBe(true);
    expect(res.overrodeCorrNr).toBe(T2);
    expect(res.reason).toContain(`(overriding the requested ${T2})`);
  });

  it("case 2: server pins T1, caller names the SAME T1 — agreement, overrodeCorrNr absent", async () => {
    const res = await pinnedMgr(T1).resolve(conn, target, "U", { corrNr: T1 });
    expect(res.outcome).toBe("transport");
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.corrNr).toBe(T1);
    expect(res.source).toBe("server-pin");
    expect(res.overrodeCorrNr).toBeUndefined();
    expect("overrodeCorrNr" in res).toBe(false);
    expect(res.reason).not.toContain("overriding");
  });

  it("case 3: agreement is case-insensitive — lowercase caller-named t1 vs the pin T1", async () => {
    const res = await pinnedMgr(T1).resolve(conn, target, "U", { corrNr: T1.toLowerCase() });
    expect(res.outcome).toBe("transport");
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.corrNr).toBe(T1);
    expect(res.overrodeCorrNr).toBeUndefined();
    expect("overrodeCorrNr" in res).toBe(false);
  });

  it("case 4: no caller-named corr_nr at all — overrodeCorrNr absent (nothing to override)", async () => {
    const res = await pinnedMgr(T1).resolve(conn, target, "U", {});
    expect(res.outcome).toBe("transport");
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.corrNr).toBe(T1);
    expect(res.source).toBe("server-pin");
    expect(res.overrodeCorrNr).toBeUndefined();
    expect("overrodeCorrNr" in res).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sections 2-3 harness — copied from test/delete-corr-nr-honoured.test.ts,
// deliberately duplicated per that file's own stated convention (each test
// file's fake stays isolated so two files sharing one cannot drift on
// something both need without either noticing).
// ---------------------------------------------------------------------------

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse => ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

const OBJECT_XML = (name: string, type: string, packageName = "ZPKG"): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${name}" adtcore:type="${type}">` +
  `<adtcore:packageRef adtcore:name="${packageName}"/>` +
  `</adtcore:objectMetadata>`;

/** Same shape as test/write.test.ts's own `LOCK_XML`. */
const LOCK_XML = (handle = "H1", isLocal = "", corrNr = ""): string =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>${isLocal}</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

type Route = (r: Recorded) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body };
    this.calls.push(rec);
    const res = this.route(rec);
    if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
    return res;
  }
  get labels(): string[] {
    return this.calls.map((c) => c.label);
  }
  get verbs(): string[] {
    return this.calls.map((c) => (c.qs._action ? c.qs._action : c.method));
  }
}

const fluidState = useFluidState();
afterAll(async () => {
  await rm(fluidState.dir(), { recursive: true, force: true });
});

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
    stateDir: fluidState.dir(),
  });

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(cfg(), { httpClient: adt, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const DEFAULT_GATE = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: ["*"] });
const authDelete = (conn: AbapConnection, wt: WriteTarget, gate: SafetyGate = DEFAULT_GATE) =>
  authorizeMutation(conn, gate, "delete", wt);
const authWrite = (conn: AbapConnection, wt: WriteTarget, gate: SafetyGate = DEFAULT_GATE) =>
  authorizeMutation(conn, gate, "write", wt);

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

/** Same shape as test/delete-corr-nr-honoured.test.ts's own `fakeReq`. */
const fakeReq = (uri: string, overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({
    uri,
    operation: "U",
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

// ---------------------------------------------------------------------------
// Section 2 — deleteObject through the REAL resolver: pinnedTo T1, caller
// names T2.
// ---------------------------------------------------------------------------

const DEL_REPORT = "ZMCP_CORR_OVR_DEL";
const DEL_URI = "/sap/bc/adt/programs/programs/zmcp_corr_ovr_del";
const DEL_SRC = `${DEL_URI}/source/main`;
const DEL_SOURCE = "REPORT zmcp_corr_ovr_del.\nWRITE: / 'a'.\n";

/**
 * A transportable ($ZPKG) report, LOCKed by `lockCorrNr` (irrelevant to the
 * NEW mechanism under test — the refusal below fires in `preflightCorr`,
 * pre-lock — but still routed so a would-be LOCK/DELETE would succeed if
 * one were wrongly issued, rather than the fake throwing "unrouted").
 */
function deleteRoute(lockCorrNr: string): Route {
  let deleted = false;
  return (r) => {
    if (r.url === DEL_URI && r.method === "GET")
      return deleted ? resp(404, "", OK_XML) : resp(200, OBJECT_XML(DEL_REPORT, "PROG/P", "ZPKG"), OK_XML);
    if (r.url === DEL_SRC && r.method === "GET") return deleted ? resp(404, "", OK_XML) : resp(200, DEL_SOURCE, OK_TEXT);
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", "", lockCorrNr), OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.method === "DELETE") {
      deleted = true;
      return resp(200, "", {});
    }
    return undefined;
  };
}

describe("deleteObject through the real resolver: a server-pin overriding the caller's corr_nr is refused pre-lock (issue #65 round 2)", () => {
  it("case 5 (THE regression): refuses CORR_NR_NOT_HONOURED before any LOCK or DELETE is issued", async () => {
    const { conn, adt } = await connected(deleteRoute(T1));
    const transport = new SessionTransport({
      allowTransports: ["*"],
      whoami: () => "DEVELOPER",
      cts: { trRequirement: vi.fn(async () => fakeReq(DEL_SRC, { pinnedTo: T1 })) },
    });
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: ["*"] });

    const e = await catchErr(
      deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: DEL_REPORT }, gate), {
        onBeforeImage: NO_JOURNAL,
        transport,
        gate,
        corrNr: T2,
      }),
    );

    expect(e.code).toBe("TRANSPORT_ERROR");
    expect(e.details.reason).toBe("CORR_NR_NOT_HONOURED");
    expect(e.details.stage).toBe("preflight");
    expect(e.details.corrNrHonoured).toBe(false);
    expect(e.details.deleted).toBe(false);
    expect(e.details.corrNr).toBe(T2);
    expect(e.details.lockCorrNr).toBe(T1);
    expect(e.message).toContain(T1);
    expect(e.message).toContain(T2);

    // The load-bearing assertion: this is a PRE-LOCK refusal from
    // `preflightCorr`, not the old post-lock `divergentLockCorrNr` backstop.
    // A build still carrying the round-1 bug would run Step 4 (server-pin)
    // ahead of Step 5 (caller-named), silently drop T2, resolve `source:
    // "auto"`/corrNr T1 with no override recorded, and `deleteObject` would
    // sail through to a real LOCK and DELETE — so "no LOCK, no DELETE" is
    // exactly what distinguishes fixed from broken here, not just the thrown
    // error's shape.
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("UNLOCK");
    expect(adt.verbs).not.toContain("DELETE");
  });

  it("case 6: caller names the SAME request CTS already pinned — delete proceeds normally", async () => {
    const { conn, adt } = await connected(deleteRoute(T1));
    const transport = new SessionTransport({
      allowTransports: ["*"],
      whoami: () => "DEVELOPER",
      cts: { trRequirement: vi.fn(async () => fakeReq(DEL_SRC, { pinnedTo: T1 })) },
    });
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: ["*"] });

    const res = await deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: DEL_REPORT }, gate), {
      onBeforeImage: NO_JOURNAL,
      transport,
      gate,
      corrNr: T1,
    });

    expect(res.deleted).toBe(true);
    expect(res.corrNrSent).toBe(T1);
    expect(res.corrNrHonoured).toBe(true);
    expect(adt.verbs).toContain("LOCK");
    const del = adt.calls.find((c) => c.method === "DELETE")!;
    expect(del.qs.corrNr).toBe(T1);
  });

  it("case 7: a $TMP (local) object with a named corr_nr is unaffected — resolve() never reaches the pin step", async () => {
    let deleted = false;
    const { conn, adt } = await connected((r) => {
      if (r.url === DEL_URI && r.method === "GET")
        return deleted ? resp(404, "", OK_XML) : resp(200, OBJECT_XML(DEL_REPORT, "PROG/P", "$TMP"), OK_XML);
      if (r.url === DEL_SRC && r.method === "GET") return deleted ? resp(404, "", OK_XML) : resp(200, DEL_SOURCE, OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", "X", ""), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.method === "DELETE") {
        deleted = true;
        return resp(200, "", {});
      }
      return undefined;
    });
    // `kind: "local"` makes `resolve()` return `not-needed` in Step 2, before
    // `#decideTransportable`/`#resolvePin` (Steps 3-7) ever run — a `pinnedTo`
    // here would be nonsensical (CTS never pins a local object), so it is
    // deliberately left unset; what matters is that a caller-named corr_nr
    // has no effect either way.
    const transport = new SessionTransport({
      allowTransports: ["*"],
      whoami: () => "DEVELOPER",
      cts: { trRequirement: vi.fn(async () => fakeReq(DEL_SRC, { kind: "local", devclass: "$TMP", mustSupplyCorrNr: false })) },
    });
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: ["*"] });

    const res = await deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: DEL_REPORT }, gate), {
      onBeforeImage: NO_JOURNAL,
      transport,
      gate,
      corrNr: T2,
    });

    expect(res.deleted).toBe(true);
    expect(res.transport).toEqual({ status: "local", required: false });
    expect(res.corrNrSent).toBeUndefined();
    expect(res.corrNrHonoured).toBeUndefined();
    expect(adt.verbs).toContain("DELETE");
  });
});

// ---------------------------------------------------------------------------
// Section 3 — writeObject through the REAL resolver: a PUT (unlike a
// DELETE) is allowed to proceed on the server-pinned request; it just has to
// SAY it did, via corrNrSent/corrNrOverrode.
// ---------------------------------------------------------------------------

const WR_REPORT = "ZMCP_CORR_OVR_WR";
const WR_URI = "/sap/bc/adt/programs/programs/zmcp_corr_ovr_wr";
const WR_SRC = `${WR_URI}/source/main`;
const WR_SOURCE_OLD = "REPORT zmcp_corr_ovr_wr.\nWRITE: / 'old'.\n";
const WR_SOURCE_NEW = "REPORT zmcp_corr_ovr_wr.\nWRITE: / 'new'.\n";

function writeRoute(lockCorrNr: string): Route {
  return (r) => {
    if (r.url === WR_URI && r.method === "GET") return resp(200, OBJECT_XML(WR_REPORT, "PROG/P", "ZPKG"), OK_XML);
    if (r.url === WR_SRC && r.method === "GET") return resp(200, WR_SOURCE_OLD, OK_TEXT);
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", "", lockCorrNr), OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === WR_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
    return undefined;
  };
}

describe("writeObject through the real resolver: a server-pin overriding the caller's corr_nr still succeeds, and says so (issue #65 round 2)", () => {
  it("case 8: pinned T1, caller named T2 — PUT succeeds on T1, corrNrSent T1 / corrNrOverrode T2", async () => {
    const { conn, adt } = await connected(writeRoute(T1));
    const transport = new SessionTransport({
      allowTransports: ["*"],
      whoami: () => "DEVELOPER",
      cts: { trRequirement: vi.fn(async () => fakeReq(WR_SRC, { pinnedTo: T1 })) },
    });
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: ["*"] });

    const res = await writeObject(conn, await authWrite(conn, { type: "PROG/P", name: WR_REPORT }, gate), {
      source: WR_SOURCE_NEW,
      transport,
      gate,
      corrNr: T2,
    });

    expect(res.changed).toBe(true);
    expect(res.corrNrSent).toBe(T1);
    expect(res.corrNrOverrode).toBe(T2);
    expect(res.transport).toMatchObject({ status: "transport", required: true, corrNr: T1 });
    const put = adt.calls.find((c) => c.method === "PUT")!;
    expect(put.qs.corrNr).toBe(T1);
  });

  it("case 9: pinned T1, caller also named T1 — PUT succeeds, corrNrSent T1, corrNrOverrode absent", async () => {
    const { conn, adt } = await connected(writeRoute(T1));
    const transport = new SessionTransport({
      allowTransports: ["*"],
      whoami: () => "DEVELOPER",
      cts: { trRequirement: vi.fn(async () => fakeReq(WR_SRC, { pinnedTo: T1 })) },
    });
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: ["*"] });

    const res = await writeObject(conn, await authWrite(conn, { type: "PROG/P", name: WR_REPORT }, gate), {
      source: WR_SOURCE_NEW,
      transport,
      gate,
      corrNr: T1,
    });

    expect(res.changed).toBe(true);
    expect(res.corrNrSent).toBe(T1);
    expect(res.corrNrOverrode).toBeUndefined();
    expect("corrNrOverrode" in res).toBe(false);
    const put = adt.calls.find((c) => c.method === "PUT")!;
    expect(put.qs.corrNr).toBe(T1);
  });
});

// ---------------------------------------------------------------------------
// Section 4 — tool level: abapWrite (src/tools/write.ts), proving the
// header/note wiring downstream of WriteResult.corrNrOverrode.
// ---------------------------------------------------------------------------

const TOOLW_REPORT = "ZMCP_CORR_OVR_TOOLW";
const TOOLW_URI = "/sap/bc/adt/programs/programs/zmcp_corr_ovr_toolw";
const TOOLW_SRC = `${TOOLW_URI}/source/main`;
const TOOLW_SOURCE_OLD = "REPORT zmcp_corr_ovr_toolw.\nWRITE: / 'old'.\n";
const TOOLW_SOURCE_NEW = "REPORT zmcp_corr_ovr_toolw.\nWRITE: / 'new'.\n";

/** No syntax errors — same empty-report shape as test/write.test.ts's own `CLEAN_CHECKRUN`. */
const CLEAN_CHECKRUN = `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`;

function toolWriteRoute(lockCorrNr: string): Route {
  return (r) => {
    if (r.url === TOOLW_URI && r.method === "GET") return resp(200, OBJECT_XML(TOOLW_REPORT, "PROG/P", "ZPKG"), OK_XML);
    if (r.url === TOOLW_SRC && r.method === "GET") return resp(200, TOOLW_SOURCE_OLD, OK_TEXT);
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", "", lockCorrNr), OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === TOOLW_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
    if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
    return undefined;
  };
}

const TOOLD_REPORT = "ZMCP_CORR_OVR_TOOLD";
const TOOLD_URI = "/sap/bc/adt/programs/programs/zmcp_corr_ovr_toold";
const TOOLD_SRC = `${TOOLD_URI}/source/main`;
const TOOLD_SOURCE = "REPORT zmcp_corr_ovr_toold.\nWRITE: / 'a'.\n";

function toolDeleteRoute(lockCorrNr: string): Route {
  let deleted = false;
  return (r) => {
    if (r.url === TOOLD_URI && r.method === "GET")
      return deleted ? resp(404, "", OK_XML) : resp(200, OBJECT_XML(TOOLD_REPORT, "PROG/P", "ZPKG"), OK_XML);
    if (r.url === TOOLD_SRC && r.method === "GET") return deleted ? resp(404, "", OK_XML) : resp(200, TOOLD_SOURCE, OK_TEXT);
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", "", lockCorrNr), OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.method === "DELETE") {
      deleted = true;
      return resp(200, "", {});
    }
    return undefined;
  };
}

describe("abapWrite: a server-pin overriding the caller's corr_nr, at the tool layer (issue #65 round 2)", () => {
  it("case 10 (write): reports corr_nr_honoured: false, the override note, and NOT the ordinary transport note", async () => {
    const { conn } = await connected(toolWriteRoute(T1));
    const transport = new SessionTransport({
      allowTransports: ["*"],
      whoami: () => "DEVELOPER",
      cts: { trRequirement: vi.fn(async () => fakeReq(TOOLW_SRC, { pinnedTo: T1 })) },
    });
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: ["*"] });

    const res = await abapWrite(
      conn,
      { object: TOOLW_REPORT, type: "PROG/P", source: TOOLW_SOURCE_NEW, corr_nr: T2, activate: false },
      20_000,
      gate,
      undefined,
      transport,
    );

    expect(res.text).toContain("corr_nr_honoured: false");
    expect(res.text).toMatch(new RegExp(`^transport: ${T1}$`, "m"));
    expect(res.text).toContain(`corr_nr ${T2} was overridden:`);
    expect(res.text).toContain(`already recorded in transport request ${T1}`);
    expect(res.text).toContain(`the safety gate judged ${T1}, not ${T2}`);
    expect(res.text).toContain("The write itself was NOT refused");
    // The false claim this pins the absence of: the ordinary transport
    // note's clause, which would wrongly claim T2 (not T1) was sent.
    expect(res.text).not.toContain("That is the number this write sent, after the safety gate approved it");
  });

  it("case 11 (delete): still refuses, TRANSPORT_ERROR/CORR_NR_NOT_HONOURED, pre-lock", async () => {
    const { conn, adt } = await connected(toolDeleteRoute(T1));
    const transport = new SessionTransport({
      allowTransports: ["*"],
      whoami: () => "DEVELOPER",
      cts: { trRequirement: vi.fn(async () => fakeReq(TOOLD_SRC, { pinnedTo: T1 })) },
    });
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: ["*"] });

    const e = await catchErr(
      abapWrite(
        conn,
        { mode: "delete", object: TOOLD_REPORT, type: "PROG/P", corr_nr: T2 },
        20_000,
        gate,
        undefined,
        transport,
      ),
    );

    expect(e.code).toBe("TRANSPORT_ERROR");
    expect(e.details.reason).toBe("CORR_NR_NOT_HONOURED");
    expect(e.details.stage).toBe("preflight");
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
