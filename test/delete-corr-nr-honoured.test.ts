/**
 * Issue #65: a `deleteObject` call that names one transport request
 * (`corrNr`) can be defeated by a lock that already belongs to a DIFFERENT
 * request — CTS always records a change on the request holding the lock,
 * never on the one the caller named. Before this fix `deleteObject` sent
 * the caller's `corrNr` regardless, so the DELETE landed silently on the
 * wrong request (or, worse, on nobody's — see `A4HK900117`/`A4HK900222`
 * below, one lock-held request and one caller-named request that can never
 * be reconciled).
 *
 * The fix adds two pieces to `src/adt/write.ts`:
 *
 *   - `divergentLockCorrNr(corr, lock)` — a pure truth-table function: does
 *     the lock's request disagree with the corr about to be sent? (case
 *     insensitive; a lock with no request, or one that agrees, is not
 *     divergent).
 *   - `corrNrNotHonoured(t, named, lockCorrNr)` — the `TRANSPORT_ERROR`
 *     `deleteObject` throws when a NAMED corr (a human, or a
 *     pinned/allowlisted config, chose it) diverges from the lock: the lock
 *     is released and nothing is deleted. An AUTO-resolved corr that
 *     diverges is different — nobody chose it, so `deleteObject` instead
 *     re-judges the lock's own request through the gate and proceeds.
 *
 * `deleteObject`'s result also gains `corrNrSent` (what actually went on
 * the wire) and `corrNrHonoured` (`false` when it diverged from the lock,
 * `true` when it agreed, absent when the lock named no request to compare
 * against at all).
 *
 * Harness idiom: the hand-rolled `FakeAdt implements HttpClient` fake used by
 * `test/write.test.ts` and `test/delete-verification.test.ts`'s `deleteObject`
 * tests (`connected()`/`resp()`/`baseRoute()`/`OBJECT_XML()`/`LOCK_XML()`,
 * `authDelete()`/`DEFAULT_GATE`, `catchErr()`) — copied here deliberately
 * duplicated rather than imported, per this suite's convention that each
 * test file's harness stays isolated so two files sharing one fake cannot
 * drift on something both need without either noticing. Unlike those other
 * files' synthetic `LOCK_XML`, the T1-held transportable lock response used
 * by the divergence tests below is the real captured wire from
 * `test/fixtures/cts/lock-transportable-object.xml`, loaded through
 * `loadCtsFixture` (`test/helpers/cts-fixtures.ts`) — its `CORRNR` is exactly
 * `T1`. `LOCK_XML` (with a `corrNr` parameter, as `test/write.test.ts`'s own
 * has) remains for the shapes the capture cannot serve: the LOCAL lock, and
 * any lock held by a request other than `T1`.
 *
 * `SessionTransport`'s policy/resolution logic is driven for real (not
 * hand-waved) by mocking only its underlying `CtsClient` — `cts:
 * {trRequirement, trCreate, trShow}` as `vi.fn()`s returning fabricated
 * `TrRequirement`/`TrRequest`/`TrCreated` values — exactly the idiom
 * `test/write.test.ts`'s "the gate judges the RESOLVED transport, not the
 * literal 'auto'" and "preflightCorr: narrowed PreflightTarget and affects"
 * blocks use. This drives `preflightCorr` → `SessionTransport.resolve()` for
 * real without wiring a fake `/sap/bc/adt/cts/transportchecks` HTTP route.
 */
import { describe, expect, it, vi } from "vitest";
import { afterAll } from "vitest";
import { rm } from "node:fs/promises";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import {
  authorizeMutation,
  deleteObject,
  divergentLockCorrNr,
  NO_JOURNAL,
  type TransportInfo,
  type WriteCorr,
  type WriteTarget,
} from "../src/adt/write.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { useFluidState } from "./helpers/fluid-classic-fake.js";
import { loadCtsFixture } from "./helpers/cts-fixtures.js";

// ---------------------------------------------------------------------------
// Section 1 — divergentLockCorrNr: pure truth table, no HTTP at all.
// ---------------------------------------------------------------------------

/** The fixture's own captured lock-held request (`test/fixtures/cts/lock-transportable-object.xml`). */
const T1 = "A4HK900117";
/** A second, caller-named request that the lock above cannot honour. */
const T2 = "A4HK900222";
/** A third request, standing in for an auto-resolved number in the divergence tests below. */
const T3 = "A4HK900333";

/** The real captured LOCK response body for a transportable object — its `CORRNR` is `T1`. */
const LOCK_TRANSPORTABLE = loadCtsFixture("lock-transportable-object").body;

const transportLock = (corrNr: string | undefined): TransportInfo =>
  corrNr === undefined
    ? { status: "transport", required: true, corrNr: undefined, corrUser: undefined, corrText: undefined }
    : { status: "transport", required: true, corrNr, corrUser: "DEVELOPER", corrText: "Generated Request" };

const localLock: TransportInfo = { status: "local", required: false };

const namedCorr = (corrNr: string): WriteCorr => ({ kind: "transport", corrNr });
const localCorr: WriteCorr = { kind: "local" };

describe("divergentLockCorrNr", () => {
  it("reports the lock's request when it names a DIFFERENT request than the corr about to be sent", () => {
    expect(divergentLockCorrNr(namedCorr(T2), transportLock(T1))).toBe(T1);
  });

  it("is case-insensitive — a lock and a corr that agree modulo case are not divergent", () => {
    expect(divergentLockCorrNr(namedCorr(T1.toLowerCase()), transportLock(T1.toUpperCase()))).toBe(undefined);
  });

  it("is not divergent when the lock names the SAME request as the corr", () => {
    expect(divergentLockCorrNr(namedCorr(T1), transportLock(T1))).toBe(undefined);
  });

  it("is not divergent when the lock's CORRNR is undefined — nothing to compare against", () => {
    expect(divergentLockCorrNr(namedCorr(T2), transportLock(undefined))).toBe(undefined);
  });

  it("is not divergent when the lock's CORRNR is the empty string", () => {
    expect(divergentLockCorrNr(namedCorr(T2), transportLock(""))).toBe(undefined);
  });

  it("is not divergent against a LOCAL lock — `lock.required` is false, so the comparison never runs", () => {
    expect(divergentLockCorrNr(namedCorr(T2), localLock)).toBe(undefined);
  });

  it("is not divergent for a local corr, whatever the lock says — only a transport corr can diverge", () => {
    expect(divergentLockCorrNr(localCorr, transportLock(T2))).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// Section 2 — deleteObject end-to-end, hand-rolled FakeAdt (same idiom as
// test/write.test.ts and test/delete-verification.test.ts's Section B).
// ---------------------------------------------------------------------------

const REPORT = "ZMCP_TEST_REP";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_test_rep";
const REPORT_SRC = `${REPORT_URI}/source/main`;
const SOURCE = "REPORT zmcp_test_rep.\nWRITE: / 'a'.\n";
const SOURCE_CRLF = SOURCE.replace(/\n/g, "\r\n");

const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">${REPORT} does not exist</message><properties/></exc:exception>`;

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

/** Same shape as `test/write.test.ts`'s own `OBJECT_XML`. */
const OBJECT_XML = (name: string, type: string, packageName = "ZPKG"): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${name}" adtcore:type="${type}">` +
  `<adtcore:packageRef adtcore:name="${packageName}"/>` +
  `</adtcore:objectMetadata>`;

/**
 * `test/write.test.ts`'s own `LOCK_XML`, unchanged in shape. The divergence
 * tests below use the real captured `LOCK_TRANSPORTABLE` (above) instead of
 * this for the T1-held case, so this helper now only serves the shapes that
 * capture doesn't cover: `isLocal="X"`+empty `corrNr` reproduces
 * `lockSuccessXml`'s LOCAL variant (`test/helpers/fake-adt.ts`), and an
 * empty `isLocal`+populated `corrNr` other than `T1` stands in for a lock
 * held by some other request.
 */
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

async function connected(route: Route, config: Config = cfg()): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(config, { httpClient: adt, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

/**
 * A transportable ($ZPKG) report already locked by request `heldBy` (or
 * unlocked-local when `heldBy` is undefined), whose source read/write/delete
 * routes never change across the divergence tests — only `heldBy` and
 * whether the DELETE actually lands differ between them. When `heldBy` is
 * `T1`, the LOCK response is the real captured `LOCK_TRANSPORTABLE` wire
 * rather than a synthetic body.
 */
const transportableReport = (heldBy: string | undefined, extra: Route = () => undefined): Route => {
  let deleted = false;
  return (r) => {
    if (r.url === REPORT_URI && r.method === "GET")
      return deleted ? resp(404, NOT_FOUND_XML, OK_XML) : resp(200, OBJECT_XML(REPORT, "PROG/P", "ZPKG"), OK_XML);
    if (r.url === REPORT_SRC && r.method === "GET")
      return deleted ? resp(404, NOT_FOUND_XML, OK_XML) : resp(200, SOURCE_CRLF, OK_TEXT);
    if (r.qs._action === "LOCK")
      return heldBy === undefined
        ? resp(200, LOCK_XML("H1", "X", ""), OK_XML)
        : resp(200, heldBy === T1 ? LOCK_TRANSPORTABLE : LOCK_XML("H1", "", heldBy), OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.method === "DELETE") {
      deleted = true;
      return resp(200, "", {});
    }
    return extra(r);
  };
};

const DEFAULT_GATE = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
const authDelete = (conn: AbapConnection, target: WriteTarget, gate: SafetyGate = DEFAULT_GATE) =>
  authorizeMutation(conn, gate, "delete", target);

const authorizeCreate = (devClass: string) =>
  DEFAULT_GATE.authorize("transport", { name: devClass, packageName: devClass }, { corr: { kind: "unresolved" } });

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

/** Same shape as `test/write.test.ts`'s own `fakeReq`, defaulted to a plain transportable write/delete. */
const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({
    uri: REPORT_SRC,
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

describe("deleteObject: a NAMED corr_nr that diverges from the lock is refused before any DELETE", () => {
  /**
   * The issue's exact live scenario: the caller names T2, but the object is
   * already locked under T1 (the real captured fixture number) — CTS would
   * record the deletion on T1 regardless of what this call sends, so
   * `corrNrNotHonoured` refuses outright rather than silently mis-recording
   * the change or ignoring the caller's request.
   */
  it("refuses with CORR_NR_NOT_HONOURED, names both requests, issues no DELETE, and releases the lock", async () => {
    const { conn, adt } = await connected(transportableReport(T1));
    const transport = new SessionTransport({
      allowTransports: ["*"],
      whoami: () => "DEVELOPER",
      cts: {
        trRequirement: vi.fn(async () => fakeReq({})),
        trShow: vi.fn(async () => ({
          trkorr: T2,
          kind: "workbench",
          kindRaw: "K",
          status: "modifiable",
          statusRaw: "D",
          owner: "DEVELOPER",
          description: "",
          tasks: [],
          objects: [],
        })),
      },
    });
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: ["*"] });

    const e = await catchErr(
      deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: REPORT }, gate), {
        onBeforeImage: NO_JOURNAL,
        transport,
        gate,
        corrNr: T2,
      }),
    );

    expect(e.code).toBe("TRANSPORT_ERROR");
    expect(e.details.reason).toBe("CORR_NR_NOT_HONOURED");
    expect(e.details.corrNrHonoured).toBe(false);
    expect(e.details.lockCorrNr).toBe(T1);
    expect(e.details.corrNr).toBe(T2);
    expect(e.details.deleted).toBe(false);
    expect(e.message).toContain(T1);
    expect(e.message).toContain(T2);

    // No DELETE was ever issued, and the lock taken to discover the
    // divergence was released.
    expect(adt.verbs).not.toContain("DELETE");
    expect(adt.verbs).toContain("LOCK");
    expect(adt.verbs).toContain("UNLOCK");
    expect(adt.verbs.indexOf("UNLOCK")).toBeGreaterThan(adt.verbs.indexOf("LOCK"));
  });
});

describe("deleteObject: an AUTO-resolved request diverging from the lock proceeds, re-judged", () => {
  /**
   * Nobody named T3 — `SessionTransport` auto-resolved it — so
   * `deleteObject` does not refuse; it re-judges the LOCK's own request
   * (T1) through the gate (mirroring `preflightCorr`'s own `gate.assert`,
   * under `{ corr: { kind: "transport", corrNr: T1, source: "auto" } }`)
   * and, since `allowTransports: ["auto"]` accepts any number under
   * `source: "auto"`, proceeds. The DELETE that reaches the wire still
   * carries the AUTO-RESOLVED number (T3, `corr.corrNr` — `deleteObject`
   * never substitutes the lock's request into the outgoing `corrNr`
   * parameter), but CTS is going to record the deletion against the lock's
   * request (T1) regardless of what was sent — that mismatch is exactly
   * what `corrNrHonoured: false` and `transport.corrNr === T1` report.
   */
  it("sends the auto-resolved corrNr on the wire, but reports it as NOT honoured against the lock's request", async () => {
    const { conn, adt } = await connected(transportableReport(T1));
    const transport = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      cts: {
        trRequirement: vi.fn(async () => fakeReq({})),
        trCreate: vi.fn(async () => ({ trkorr: T3, path: `/com.sap.cts/object_record/${T3}` })),
      },
    });
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: ["auto"] });

    const res = await deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: REPORT }, gate), {
      onBeforeImage: NO_JOURNAL,
      transport,
      gate,
    });

    expect(res.deleted).toBe(true);
    expect(res.corrNrSent).toBe(T3);
    expect(res.corrNrHonoured).toBe(false);
    expect(res.transport).toMatchObject({ status: "transport", required: true, corrNr: T1 });

    // The DELETE that actually landed carried the auto-resolved T3, not T1 —
    // `corrNrHonoured: false` is what says CTS will record it under T1 anyway.
    const del = adt.calls.find((c) => c.method === "DELETE")!;
    expect(del.qs.corrNr).toBe(T3);
    expect(adt.verbs).not.toContain("UNLOCK");
  });
});

describe("deleteObject: no divergence — the caller names the same request the lock already holds", () => {
  it("proceeds normally, sends that request, and reports corrNrHonoured: true", async () => {
    const { conn, adt } = await connected(transportableReport(T1));
    const transport = new SessionTransport({
      allowTransports: ["*"],
      whoami: () => "DEVELOPER",
      cts: {
        trRequirement: vi.fn(async () => fakeReq({})),
        trShow: vi.fn(async () => ({
          trkorr: T1,
          kind: "workbench",
          kindRaw: "K",
          status: "modifiable",
          statusRaw: "D",
          owner: "DEVELOPER",
          description: "",
          tasks: [],
          objects: [],
        })),
      },
    });
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: ["*"] });

    const res = await deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: REPORT }, gate), {
      onBeforeImage: NO_JOURNAL,
      transport,
      gate,
      corrNr: T1,
    });

    expect(res.deleted).toBe(true);
    expect(res.corrNrSent).toBe(T1);
    expect(res.corrNrHonoured).toBe(true);
    const del = adt.calls.find((c) => c.method === "DELETE")!;
    expect(del.qs.corrNr).toBe(T1);
  });
});

describe("deleteObject: a LOCAL lock is untouched by any of this", () => {
  /**
   * `IS_LOCAL=X` with an empty `CORRNR` — the LOCAL lock shape
   * (`test/helpers/fake-adt.ts`'s `lockSuccessXml`, reproduced here by
   * `LOCK_XML`'s own `isLocal`/`corrNr` defaults) never reaches
   * `divergentLockCorrNr`'s comparison at all (`lock.required` is `false`),
   * so a `$TMP` delete with no transport manager wired must succeed exactly
   * as before this fix, with neither `corrNrSent` nor `corrNrHonoured`
   * present on the result.
   */
  it("deletes a $TMP object with no corrNrSent/corrNrHonoured on the result", async () => {
    let deleted = false;
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_URI && r.method === "GET")
        return deleted ? resp(404, NOT_FOUND_XML, OK_XML) : resp(200, OBJECT_XML(REPORT, "PROG/P", "$TMP"), OK_XML);
      if (r.url === REPORT_SRC && r.method === "GET")
        return deleted ? resp(404, NOT_FOUND_XML, OK_XML) : resp(200, SOURCE_CRLF, OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", "X", ""), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.method === "DELETE") {
        deleted = true;
        return resp(200, "", {});
      }
      return undefined;
    });

    const res = await deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: REPORT }), {
      onBeforeImage: NO_JOURNAL,
    });

    expect(res.deleted).toBe(true);
    expect(res.transport).toEqual({ status: "local", required: false });
    expect(res.corrNrSent).toBeUndefined();
    expect(res.corrNrHonoured).toBeUndefined();
    expect("corrNrSent" in res).toBe(false);
    expect("corrNrHonoured" in res).toBe(false);
    // No lockHandle-only DELETE gained a stray corrNr either.
    const del = adt.calls.find((c) => c.method === "DELETE")!;
    expect(del.qs.corrNr).toBeUndefined();
    expect(adt.verbs).not.toContain("UNLOCK");
  });
});
