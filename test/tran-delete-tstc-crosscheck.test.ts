/**
 * TRAN/T delete TSTC cross-check (issue #201) — offline, fakes only.
 *
 * The VIT bridge (`GET /sap/bc/adt/vit/wb/object_type/trant/object_name/<TCODE>`)
 * answers 200 for a TCODE that TSTC has no row for at all, so a bare VIT 200 is
 * never proof a transaction exists or still exists. `verifyTransactionDeleted`
 * (src/adt/tran-delete.ts) cross-checks TSTC after a VIT-confirmed post-delete
 * read-back; `abapDeleteViaBridge`'s single-object path and
 * `abapWriteBatchDelete`'s pass-1 loop (src/tools/write-batch-delete.ts) both cross-check TSTC
 * BEFORE a delete is even attempted, so a phantom entry costs no package
 * resolution or transport request. Same harness idiom as
 * test/write-bridge-crud.test.ts: REAL production code drives a fake HttpClient.
 */
import { afterAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { abapWrite, abapWriteBatchDelete } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { vitBridgeUri } from "../src/adt/write-verify.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { classicFake, useFluidState } from "./helpers/fluid-classic-fake.js";
import { isTstcSelect, tstcSelectResponse, tstcSelectRoute, type TstcRow } from "./helpers/tstc-select-fake.js";

const MAX = 20_000;

interface Recorded {
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

type Route = (r: Recorded) => HttpClientResponse | undefined;

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const NOT_FOUND_XML = (name: string): string =>
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
  `<message lang="EN">${name} does not exist</message><properties/></exc:exception>`;

class FakeAdt {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const rec: Recorded = { method, url: o.url, qs, body: o.body };
    this.calls.push(rec);
    const res = this.route(rec);
    if (!res) throw new Error(`FakeAdt: unrouted request ${method} ${o.url}`);
    return res;
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

/** `baseRoute`'s `/datapreview/freestyle` stub would swallow a TSTC select ahead of
 * the caller's own route — every `connected()` here checks the caller's route first,
 * same ordering test/write-bridge-crud.test.ts's `connectedTstcFirst` uses. */
function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => route(r) ?? baseRoute(r));
  const conn = new AbapConnection(cfg(), {
    httpClient: adt as unknown as HttpClient,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

const gate = () =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowNamePrefixes: ["*"],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

const vitRoute =
  (mode: "confirmed" | "absent", name: string, packageName = "$TMP"): Route =>
  (r) => {
    const uri = vitBridgeUri("trant", name);
    if (r.url !== uri) return undefined;
    if (mode === "absent") return resp(404, NOT_FOUND_XML(name), OK_XML);
    return resp(
      200,
      `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" xmlns:adtcore="http://www.sap.com/adt/core" ` +
        `adtcore:type="TRAN/T" adtcore:name="${name}"><adtcore:packageRef adtcore:name="${packageName}"/></vit:properties>`,
      OK_XML,
    );
  };

const both =
  (...routes: Route[]): Route =>
  (r) => {
    for (const route of routes) {
      const hit = route(r);
      if (hit) return hit;
    }
    return undefined;
  };

/** First `isTstcSelect` match answers `rows`; every later one answers empty — models a
 * delete's own pre-check (row present) then post-delete cross-check (row now gone). */
const withTstcThenGone = (rows: readonly TstcRow[], route: Route): Route => {
  let calls = 0;
  return (r) => {
    if (isTstcSelect(r)) {
      calls++;
      return tstcSelectResponse(calls === 1 ? rows : []);
    }
    return route(r);
  };
};

/** The classrun POST prefix (src/adt/fluid/builtin/classic.ts's dispatch target). */
const CLASSRUN_BASE = "/sap/bc/adt/oo/classrun/";

/**
 * Per-tcode TSTC lifecycle for a multi-object batch: each `names[i]` reads
 * present until ITS OWN classrun delete has fired, then reads empty — tracked
 * by matching the TSTC select's SQL literal (`'<TCODE>'`) to a name, and
 * counting classrun POSTs in caller order (pass 2 deletes sequentially).
 */
function withTstcLifecycle(names: readonly string[], row: (tcode: string) => TstcRow, inner: Route): Route {
  const deleted = new Set<string>();
  let classrunSeen = 0;
  return (r) => {
    if (isTstcSelect(r)) {
      const tcode = names.find((n) => (r.body ?? "").includes(`'${n}'`));
      if (tcode === undefined) {
        throw new Error(`TSTC select body named none of ${names.join(", ")}: ${r.body}`);
      }
      return tstcSelectResponse(deleted.has(tcode) ? [] : [row(tcode)]);
    }
    const res = inner(r);
    if (res !== undefined && r.method === "POST" && r.url.startsWith(CLASSRUN_BASE)) {
      const tcode = names[classrunSeen];
      if (tcode !== undefined) deleted.add(tcode);
      classrunSeen++;
    }
    return res;
  };
}

const TCODE = "ZMCPT01";
const PROGRAM = "ZMCP_CARRIER_LIST";
const row = (tcode: string): TstcRow => ({ TCODE: tcode, PGMNA: PROGRAM, DYPNO: "1000", CINFO: "00" });

// ---------------------------------------------------------------------------
// (a) single delete: VIT confirmed, TSTC row then gone → verified:true, TSTC note.
// ---------------------------------------------------------------------------

describe("single TRAN/T delete — TSTC cross-check confirms absence (issue #201)", () => {
  it("VIT still answers 200 after delete, but TSTC now has no row: verified true, note mentions TSTC", async () => {
    const vit = vitRoute("confirmed", TCODE);
    const classic = classicFake({ action: "delete_transaction", lines: () => ["TRAN-DELETED", "TRAN-GONE"] });
    const { conn } = await connected(withTstcThenGone([row(TCODE)], both(classic.route, vit)));
    const result = await abapWrite(conn, { object: TCODE, type: "TRAN/T", mode: "delete" }, MAX, gate());
    expect(result.text).toMatch(/deleted:\s*true/);
    expect(result.text).toMatch(/verified:\s*true/);
    expect(result.text).toMatch(/TSTC has no row for ZMCPT01 — confirmed absent \(issue #201\)/);
  });

  // (b) VIT confirmed, TSTC row STAYS (never empties) → CHECK_FAILED "STILL confirmed present".
  it("TSTC still confirms a row after delete: CHECK_FAILED, never reported as a successful delete", async () => {
    const vit = vitRoute("confirmed", TCODE);
    const classic = classicFake({ action: "delete_transaction", lines: () => ["TRAN-DELETED", "TRAN-GONE"] });
    const { conn } = await connected(both(classic.route, vit, tstcSelectRoute([row(TCODE)])));
    const e = await catchErr(abapWrite(conn, { object: TCODE, type: "TRAN/T", mode: "delete" }, MAX, gate()));
    expect(e.code).toBe("CHECK_FAILED");
    expect(String(e.message)).toMatch(/STILL confirmed present/);
  });

  // (c) VIT 404/absent → NOT_FOUND, exactly one wire call, TSTC never queried.
  it("VIT answers 404: NOT_FOUND from the VIT read alone, TSTC never queried", async () => {
    const gone = vitRoute("absent", TCODE);
    const throwingTstc: Route = (r) => {
      if (isTstcSelect(r)) throw new Error("TSTC must not be queried when VIT already confirmed absence");
      return undefined;
    };
    const { conn, adt } = await connected(both(throwingTstc, gone));
    const e = await catchErr(abapWrite(conn, { object: TCODE, type: "TRAN/T", mode: "delete" }, MAX, gate()));
    expect(e.code).toBe("NOT_FOUND");
    expect(adt.calls.length).toBe(1);
  });

  // (e) [pre-check] VIT confirmed but TSTC has no row from the start → NOT_FOUND,
  // before any classrun/bridge/transport call.
  it("VIT confirmed but TSTC has no row: refused NOT_FOUND before any classrun call", async () => {
    const vit = vitRoute("confirmed", TCODE);
    const { conn, adt } = await connected(both(tstcSelectRoute([]), vit));
    const e = await catchErr(abapWrite(conn, { object: TCODE, type: "TRAN/T", mode: "delete" }, MAX, gate()));
    expect(e.code).toBe("NOT_FOUND");
    expect(String(e.message)).toMatch(/TSTC has no row for it/);
    // Only the VIT GET and the TSTC select — no classrun/deploy/transport call was
    // routed (any such call would have thrown "unrouted request" instead).
    expect(adt.calls.length).toBe(2);
    expect(adt.calls.some((c) => c.url.startsWith(CLASSRUN_BASE))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (d) batch delete of 2 TRAN/T entries: VIT confirmed for both, TSTC present
// then gone PER ENTRY → deleted: 2, no unverified/absent/failed entries.
// ---------------------------------------------------------------------------

describe("batch TRAN/T delete — TSTC cross-check per entry (issue #201)", () => {
  it("both entries exist at pre-check and are confirmed gone at post-check: deleted: 2", async () => {
    const names = ["ZMCPT01", "ZMCPT02"];
    const vit = both(...names.map((n) => vitRoute("confirmed", n)));
    const classic = classicFake({ action: "delete_transaction", lines: () => ["TRAN-DELETED", "TRAN-GONE"] });
    const { conn } = await connected(withTstcLifecycle(names, row, both(classic.route, vit)));
    const result = await abapWriteBatchDelete(
      conn,
      names.map((object) => ({ object, type: "TRAN/T" })),
      MAX,
      gate(),
      undefined,
    );
    expect(result.text).toMatch(/deleted:\s*2/);
    expect(result.text).toMatch(/failed:\s*0/);
    expect(result.text).not.toMatch(/unverified/i);
    expect(result.text).not.toMatch(/absent/i);
  });

  // (f) [pre-check] batch: VIT confirmed but TSTC empty from the start → entry
  // reported already-absent, no classrun call for it.
  it("VIT confirmed but TSTC has no row: entry reported already absent, no classrun call", async () => {
    const vit = vitRoute("confirmed", TCODE);
    const { conn, adt } = await connected(both(tstcSelectRoute([]), vit));
    const result = await abapWriteBatchDelete(
      conn,
      [{ object: TCODE, type: "TRAN/T" }],
      MAX,
      gate(),
      undefined,
    );
    expect(result.text).toMatch(/absent:\s*1/);
    expect(result.text).toMatch(new RegExp(`${TCODE}: already absent`));
    expect(adt.calls.some((c) => c.url.startsWith(CLASSRUN_BASE))).toBe(false);
  });
});
