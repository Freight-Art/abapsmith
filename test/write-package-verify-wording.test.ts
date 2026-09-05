/**
 * `DEVC/K` create-via-classrun-bridge's post-create verification wording
 * (src/tools/write.ts, the `verifyViaRepositorySearch` call right after
 * `createPackageViaBridge` succeeds). Offline, with a fake `HttpClient`
 * injected through `ConnectionOptions.httpClient` — same harness idiom as
 * test/write-package.test.ts, reimplemented locally (self-contained) rather
 * than imported, since that file may be touched by other work concurrently.
 *
 * Drives the REAL `abapWrite` entry point all the way through the create
 * bridge (GET-404 on the package's own URI, then the
 * ZCL_ZMCP_DDIC_CPKG deploy/classrun choreography), then the repository
 * search that decides whether the create is trusted.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import { DDIC_BRIDGE_CLASS, DDIC_BRIDGE_PACKAGE } from "../src/adt/ddic-bridge.js";
import { verifyViaRepositorySearch } from "../src/adt/write-verify.js";
import { searchResultsXml } from "./helpers/fake-adt.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const PKG = "ZTM_TESTPKG";
const PKG_URI = "/sap/bc/adt/packages/ztm_testpkg";
const PARENT = "ZTM";
const TRKORR = "A4HK900123";

const CREATE_BRIDGE_CLASS = DDIC_BRIDGE_CLASS.createPackage;
const CLASSES_COLLECTION = "/sap/bc/adt/oo/classes";
const CREATE_BRIDGE_URI = `${CLASSES_COLLECTION}/${CREATE_BRIDGE_CLASS.toLowerCase()}`;
const CREATE_BRIDGE_SOURCE_URI = `${CREATE_BRIDGE_URI}/source/main`;
const CREATE_BRIDGE_CLASSRUN_URI = `/sap/bc/adt/oo/classrun/${CREATE_BRIDGE_CLASS}`;

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
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">${PKG} does not exist</message><properties/></exc:exception>`;

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
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(cfg(), {
    httpClient: adt,
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

const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({
    kind: "transport",
    required: true,
    mustSupplyCorrNr: true,
    serverWouldFabricate: false,
    ...overrides,
  }) as unknown as TrRequirement;

/**
 * `resolveForNewTransportable()` (used for a not-yet-existing DEVC/K) never
 * consults `trRequirement` — CTS cannot classify an object that doesn't
 * exist — but it does call `trShow` to check the caller-named request is
 * still modifiable and owned by us, so both need a fake.
 */
const pinnedTo = (trkorr: string): SessionTransport =>
  new SessionTransport({
    allowTransports: [trkorr],
    cts: {
      trRequirement: vi.fn(async () => fakeReq({ pinnedTo: trkorr })),
      trShow: vi.fn(async () => ({
        trkorr,
        kind: "workbench" as const,
        kindRaw: "K",
        status: "modifiable" as const,
        statusRaw: "D",
        owner: "DEVELOPER",
        description: "abapsmith session 2026-09-05",
        tasks: [],
        objects: [],
      })),
    } as never,
  });

/** Allows the bridge class's home ($TMP) and the new package's superpackage. */
const gate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [DDIC_BRIDGE_PACKAGE, PARENT],
    allowTransports: [TRKORR],
    writesLockedOut: false,
  });

const BRIDGE_LOCK_XML =
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

/** The package does not exist yet: authorizeMutation's own GET on its URI. */
const packageMissingRoute: Route = (r) =>
  r.url === PKG_URI && r.method === "GET" ? resp(404, NOT_FOUND_XML, OK_XML) : undefined;

/** GET-404 -> POST-create -> LOCK -> PUT -> UNLOCK -> activate for the CREATE bridge class itself. */
const bridgeDeployRoute: Route = (r) => {
  if (r.url === CREATE_BRIDGE_URI && r.method === "GET" && !r.qs._action)
    return resp(404, NOT_FOUND_XML, OK_XML);
  if (r.url === CLASSES_COLLECTION && r.method === "POST") return resp(200, "", {});
  if (r.url === CREATE_BRIDGE_URI && r.qs._action === "LOCK") return resp(200, BRIDGE_LOCK_XML, OK_XML);
  if (r.url === CREATE_BRIDGE_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
  if (r.url === CREATE_BRIDGE_SOURCE_URI && r.method === "PUT") return resp(200, "", OK_TEXT);
  if (r.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
  return undefined;
};

/** Classrun executes the deployed bridge class and answers with a transcript body. */
const bridgeClassrunRoute =
  (transcript: string): Route =>
  (r) =>
    r.url === CREATE_BRIDGE_CLASSRUN_URI ? resp(200, transcript, OK_TEXT) : undefined;

function combineRoutes(...routes: Route[]): Route {
  return (r) => {
    for (const route of routes) {
      const hit = route(r);
      if (hit) return hit;
    }
    return undefined;
  };
}

// A super package is passed (PARENT), so all three tags are expected — see
// createPackageViaBridge in src/adt/package-create.ts.
const SUCCESS_TRANSCRIPT = ["PKG-CREATED", "PKG-PARENT-SET", "PKG-CONFIRMED"].join("\n");

const searchRoute =
  (hits: readonly { name: string; type: string; uri: string }[]): Route =>
  (r) =>
    r.url.endsWith("/repository/informationsystem/search")
      ? resp(200, searchResultsXml(hits), OK_XML)
      : undefined;

const searchMiss = searchRoute([]);
const searchHit = searchRoute([{ name: PKG, type: "DEVC/K", uri: PKG_URI }]);

const fullRoute = (search: Route): Route =>
  combineRoutes(packageMissingRoute, bridgeDeployRoute, bridgeClassrunRoute(SUCCESS_TRANSCRIPT), search);

const createInput = {
  object: PKG,
  type: "DEVC/K" as const,
  package: PARENT,
  software_component: "HOME",
  corr_nr: TRKORR,
};

describe("DEVC/K create bridge — post-create repository-search verification wording", () => {
  it("a search miss still raises CHECK_FAILED, details unchanged in shape", async () => {
    const { conn } = await connected(fullRoute(searchMiss));

    const err = await catchErr(
      abapWrite(conn, createInput, 20_000, gate(), undefined, pinnedTo(TRKORR)),
    );

    expect(err.code).toBe("CHECK_FAILED");
    expect(err.details?.object).toBe(PKG);
    expect(err.details?.type).toBe("DEVC/K");
    expect(err.details?.markers).toBe("PKG-CREATED PKG-PARENT-SET PKG-CONFIRMED");
  });

  it("the message no longer overclaims proof of absence, and cites the live calibration", async () => {
    const { conn } = await connected(fullRoute(searchMiss));

    const err = await catchErr(
      abapWrite(conn, createInput, 20_000, gate(), undefined, pinnedTo(TRKORR)),
    );

    expect(err.message).not.toContain("can prove the package is not there");
    expect(err.message).not.toContain("will not report a package create as successful");
    expect(err.message).toMatch(/evidence, not proof of absence/);
    expect(err.message).toMatch(/calibrated for packages/);
    expect(err.message).toMatch(/local/);
    expect(err.message).toMatch(/transportable/);
  });

  it("the hint names abap_search, the DEVC search type, and TDEVC as ways to confirm", async () => {
    const { conn } = await connected(fullRoute(searchMiss));

    const err = await catchErr(
      abapWrite(conn, createInput, 20_000, gate(), undefined, pinnedTo(TRKORR)),
    );

    expect(err.hint).toMatch(/abap_search/);
    expect(err.hint).toMatch(/DEVC/);
    expect(err.hint).toMatch(/TDEVC/);
  });

  // Behavioural pin, since SEARCH_BLIND_TYPES is module-private: a live
  // probe (2026-09-05) found packages ARE search-calibrated — a package
  // present in TDEVC was found by the repository search both as a local
  // ($TMP-parented) and as a transportable package (0 hits before the
  // create, 1 after, in both halves) — so flipping this to "indeterminate"
  // means reversing that finding.
  it("DEVC/K is NOT search-blind: a zero-hit search is confirmed-absent, not indeterminate", async () => {
    const { conn } = await connected(searchMiss);

    const outcome = await verifyViaRepositorySearch(conn, PKG, "DEVC/K");

    expect(outcome.status).toBe("confirmed-absent");
  });

  // Mirror-image control: FUGR/FF IS search-blind (the repository search
  // does not index function modules by name at all), so the same zero-hit
  // fake must still downgrade to indeterminate for it — proving the DEVC/K
  // assertion above is about DEVC/K specifically, not about the fake
  // returning nothing useful.
  it("control: FUGR/FF stays indeterminate on the same zero-hit fake", async () => {
    const { conn } = await connected(searchMiss);

    const outcome = await verifyViaRepositorySearch(conn, "ZFOO", "FUGR/FF");

    expect(outcome.status).toBe("indeterminate");
  });

  it("the already-working case is unchanged: a search hit resolves successfully and reports created+verified", async () => {
    const { conn } = await connected(fullRoute(searchHit));

    const res = await abapWrite(conn, createInput, 20_000, gate(), undefined, pinnedTo(TRKORR));

    expect(res.text).toMatch(/^created: true$/m);
    expect(res.text).toMatch(/^verified: true$/m);
    expect(res.text).toContain("Read back and confirmed present at");
  });
});
