/**
 * Issues #141 / #142: the bridge-based creates (VIEW/DV, TRAN/T, SHLP/DH and
 * TABL/DI) under `ABAP_ALLOW_TRANSPORTS=auto`.
 *
 * Before: every one of them demanded a caller-NAMED `corr_nr` for a
 * transportable package, and the safety gate then refused that named request
 * under `auto` (only `source: "auto"` passes step 10) — a loop no argument
 * change could leave. VIEW/DV additionally resolved (and so could CREATE) a
 * request BEFORE the gate verdict, leaking an empty request on refusal.
 *
 * After: all four share `resolveBridgeCreateCorr` (src/tools/write.ts) →
 * `preflightPackageCorr` (src/adt/write.ts): a zero-network gate verdict on
 * the caller's own arguments first, then the session resolver's
 * adopt-else-create route (the one the ADT-lock types take) anchored on the
 * PACKAGE, since the object does not exist yet, and the resolved number in
 * the response's `transport:` line. A request created and then refused is
 * reported in `details.createdTransport` and the hint.
 *
 * Entirely offline: a real `AbapConnection` over a fake `HttpClient`, the real
 * fluid `classic`-tool deploy/classrun fake, and an injected fake CTS client on
 * `SessionTransport` — the request-create call is a `vi.fn`, so "no request
 * was created" is `trCreate` never having been called. Same harness idiom as
 * test/write-bridge-crud.test.ts.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrHeader } from "../src/adt/transports.js";
import { CLASSIC_TOOL_ID } from "../src/adt/fluid/builtin/classic.js";
import { FLUID_CONTRACT } from "../src/adt/fluid/manifest.js";
import { invokerName } from "../src/adt/fluid/invoke.js";
import { vitBridgeUri } from "../src/adt/write-verify.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { classicFake, useFluidState, type ClassicFake } from "./helpers/fluid-classic-fake.js";

const MAX = 20_000;
const PKG = "ZTM";
const CREATED = "A4HK900321";
const NAMED = "A4HK900117";

// ------------------------------------------------------------ fake wire ---

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

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

/**
 * `conn.connect()`'s own requests, including its one-time system-role
 * `/datapreview/freestyle` probe — answered ONLY during connect, so a test's
 * own freestyle fixtures (SHLP/DH's catalog probe, TABL/DI's DD12V/DD17S
 * re-read) are never shadowed afterwards.
 */
async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  let duringConnect = true;
  const adt = new FakeAdt((r) => {
    if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
    if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
    if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
    if (duringConnect && r.url.includes("/datapreview/freestyle")) {
      return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
    }
    return route(r);
  });
  const conn = new AbapConnection(cfg(), { httpClient: adt, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  duringConnect = false;
  adt.calls.length = 0;
  return { conn, adt };
}

const both =
  (...routes: Route[]): Route =>
  (r) => {
    for (const route of routes) {
      const hit = route(r);
      if (hit) return hit;
    }
    return undefined;
  };

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

const OBJECT_XML = (name: string, type: string, packageName: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${name}" adtcore:type="${type}">` +
  `<adtcore:packageRef adtcore:name="${packageName}"/>` +
  `</adtcore:objectMetadata>`;

/** A plain object-metadata GET (no `_action`, not a source read) for `uri`. */
const metaRoute =
  (uri: string, name: string, type: string, packageName: string): Route =>
  (r) =>
    r.method === "GET" && !r.qs._action && r.url === uri ? resp(200, OBJECT_XML(name, type, packageName), OK_XML) : undefined;

/** The VIT-bridge stub GET `verifyObjectCreated` reads a VIEW/DV or TRAN/T back through. */
const vitRoute =
  (vitType: string, name: string, type: string): Route =>
  (r) =>
    r.url === vitBridgeUri(vitType, name)
      ? resp(
          200,
          `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" ` +
            `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:type="${type}" ` +
            `adtcore:name="${name}"><adtcore:packageRef adtcore:name="${PKG}"/></vit:properties>`,
          OK_XML,
        )
      : undefined;

/** One `<dataPreview:columns>` block, the wire shape every freestyle fixture here uses. */
function columnXml(name: string, values: readonly string[]): string {
  const data = values.map((v) => `<dataPreview:data>${v}</dataPreview:data>`).join("");
  return (
    `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="C" dataPreview:keyAttribute="false"/>` +
    `<dataPreview:dataSet>${data}</dataPreview:dataSet></dataPreview:columns>`
  );
}
function tableBody(cols: Record<string, readonly string[]>): string {
  const colsXml = Object.keys(cols)
    .map((n) => columnXml(n, cols[n]!))
    .join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
    `${colsXml}</dataPreview:tableData>`
  );
}
const emptyResult = (): string =>
  '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview"></dataPreview:tableData>';

/** Every `/datapreview/freestyle` call answered from `bodies`, in order. */
function freestyleQueueRoute(bodies: readonly string[]): Route {
  let n = 0;
  return (r) => {
    if (!r.url.includes("/datapreview/freestyle")) return undefined;
    const entry = bodies[n++];
    if (entry === undefined) throw new Error(`freestyleQueueRoute: no fixture queued for call #${n}`);
    return resp(200, entry, DATAPREVIEW_XML);
  };
}

// ------------------------------------------------------------ fixtures ---

const gateWith = (allowTransports: string[], allowPackages: string[] = ["*"]): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages,
    allowNamePrefixes: ["*"],
    allowTransports,
    writesLockedOut: false,
  });

const candidate = (trkorr: string, overrides: Partial<TrHeader> = {}): TrHeader => ({
  trkorr,
  kind: "workbench",
  kindRaw: "K",
  status: "modifiable",
  statusRaw: "D",
  owner: "DEVELOPER",
  description: "a request CTS offered",
  ...overrides,
});

/**
 * A `SessionTransport` in auto mode over an injected fake CTS client:
 * `trRequirement` answers the package-anchored candidate look-up with
 * `candidates`, `trCreate` mints `A4HK900321`. Both are spies, so a test can
 * prove a request was — or was NOT — created.
 */
function autoMgr(candidates: readonly TrHeader[] = []): {
  mgr: SessionTransport;
  trCreate: ReturnType<typeof vi.fn>;
  trRequirement: ReturnType<typeof vi.fn>;
} {
  const authorizeCreate = () =>
    new SafetyGate({ readOnly: false, allowPackages: ["*"] }).authorize(
      "transport",
      { name: PKG, packageName: PKG },
      { corr: { kind: "unresolved" } },
    );
  const trCreate = vi.fn(async () => ({ trkorr: CREATED, path: `/com.sap.cts/object_record/${CREATED}` }));
  const trRequirement = vi.fn(async (_conn: unknown, uri: string, devClass: string) => ({
    uri,
    operation: "I",
    devclass: devClass,
    candidates: [...candidates],
    locks: [],
    messages: [],
    checkFailed: false,
    raw: { result: "S", korrflag: "X", recording: "" },
    kind: "transport-required",
    mustSupplyCorrNr: true,
    serverWouldFabricate: false,
  }));
  const mgr = new SessionTransport({
    allowTransports: ["auto"],
    authorizeCreate,
    whoami: () => "DEVELOPER",
    cts: { trCreate, trRequirement } as never,
  });
  return { mgr, trCreate, trRequirement };
}

// One create per bridge type: the abap_write input, the fake-wire routes it
// needs to run END TO END (create + read-back), and the classic action whose
// fake classrun answers it.
const VIEW = "ZMCP_V_AUTO";
const TCODE = "ZMCPTAUTO";
const PROGRAM = "ZMCP_CARRIER_LIST";
const SHLP = "ZMCP_SH_AUTO";
const TABLE = "ZMCP_TEST_TAB";
const INDEX = "Z01";

interface BridgeCase {
  readonly type: "VIEW/DV" | "TRAN/T" | "SHLP/DH" | "TABL/DI";
  readonly input: Record<string, unknown>;
  /** Wire routes besides the classic-tool fake. */
  readonly routes: () => Route;
  readonly classic: () => ClassicFake;
  /** The invoker class name the bridge deploys when it sends `corrNr` — content-addressed on its args, so the strongest proof a request reached the ABAP. Absent where the args are built deep inside the module. */
  readonly invoker?: (corrNr: string) => string;
}

const CASES: readonly BridgeCase[] = [
  {
    type: "VIEW/DV",
    input: { object: VIEW, type: "VIEW/DV", package: PKG, description: "Carriers", base_table: "ZMCP_CARRIER", view_fields: ["CARRIER_ID", "NAME"] },
    routes: () => vitRoute("viewdv", VIEW, "VIEW/DV"),
    classic: () => classicFake({ action: "create_view", lines: () => ["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"] }),
    invoker: (corrNr) =>
      invokerName(
        CLASSIC_TOOL_ID,
        "create_view",
        { view_name: VIEW, base_table: "ZMCP_CARRIER", fields: ["CARRIER_ID", "NAME"], description: "Carriers", package_name: PKG, corr_nr: corrNr },
        FLUID_CONTRACT,
      ),
  },
  {
    type: "TRAN/T",
    input: { object: TCODE, type: "TRAN/T", package: PKG, description: "Carrier list", program: PROGRAM },
    routes: () =>
      both(
        metaRoute(`/sap/bc/adt/programs/programs/${PROGRAM.toLowerCase()}`, PROGRAM, "PROG/P", "$TMP"),
        vitRoute("trant", TCODE, "TRAN/T"),
      ),
    classic: () => classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] }),
    invoker: (corrNr) =>
      invokerName(
        CLASSIC_TOOL_ID,
        "create_transaction",
        { tcode: TCODE, program: PROGRAM, description: "Carrier list", package_name: PKG, corr_nr: corrNr },
        FLUID_CONTRACT,
      ),
  },
  {
    type: "SHLP/DH",
    input: {
      object: SHLP,
      type: "SHLP/DH",
      package: PKG,
      description: "Auto search help",
      shlp: { elementary: false, fields: [], includes: [{ name: "ZMCP_SH_SUB" }] },
    },
    routes: () =>
      both(
        // `resolveShlpPackage` confirms a transportable package exists on the server.
        metaRoute(`/sap/bc/adt/packages/${PKG.toLowerCase()}`, PKG, "DEVC/K", PKG),
        // Post-create catalog probe: one active-header query, found.
        freestyleQueueRoute([
          tableBody({ SHLPNAME: [SHLP] }),
          emptyResult(),
          emptyResult(),
          emptyResult(),
          emptyResult(),
          emptyResult(),
          emptyResult(),
        ]),
      ),
    classic: () => classicFake({ action: "create_search_help", lines: () => ["SHLP-REGISTERED", "SHLP-PUT", "SHLP-ACTIVATED"] }),
  },
  {
    type: "TABL/DI",
    input: { object: INDEX, type: "TABL/DI", description: "probe idx", base_table: TABLE, index_fields: ["CARRIER"] },
    routes: () =>
      both(
        // `resolveIndexOwner`: the package comes from the base table, never the caller.
        metaRoute(`/sap/bc/adt/ddic/tables/${TABLE.toLowerCase()}`, TABLE, "TABL/DT", PKG),
        // Post-create DD12V/DD17S re-read, routed by SQL body.
        (r) => {
          if (!r.url.includes("/datapreview/freestyle")) return undefined;
          const sql = String(r.body ?? "").toLowerCase();
          if (sql.includes("dd12v")) {
            return resp(
              200,
              tableBody({ SQLTAB: [TABLE], INDEXNAME: [INDEX], DDLANGUAGE: ["E"], UNIQUEFLAG: [""], AS4LOCAL: ["A"], DBSTATE: ["ACT"], DDTEXT: ["probe idx"] }),
              DATAPREVIEW_XML,
            );
          }
          if (sql.includes("dd17s")) {
            return resp(200, tableBody({ SQLTAB: [TABLE], INDEXNAME: [INDEX], POSITION: ["0001"], FIELDNAME: ["CARRIER"] }), DATAPREVIEW_XML);
          }
          return undefined;
        },
      ),
    classic: () => classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] }),
  },
];

/** Did any request body the bridge deployed carry `corrNr` — the invoker class bakes its argument JSON into its source. */
const deployedWith = (adt: FakeAdt, corrNr: string): boolean =>
  adt.calls.some((c) => (c.method === "POST" || c.method === "PUT") && String(c.body ?? "").includes(corrNr));

// ------------------------------------------------------------- tests ---

describe("issue #141: under ABAP_ALLOW_TRANSPORTS=auto every bridge create resolves its own request (omit corr_nr) and names it in the response", () => {
  for (const c of CASES) {
    it(`${c.type}: omitted corr_nr → a request is created for the package, handed to the bridge, and reported as transport:`, async () => {
      const classic = c.classic();
      const { conn, adt } = await connected(both(classic.route, c.routes()));
      const { mgr, trCreate, trRequirement } = autoMgr();

      const result = await abapWrite(conn, c.input as never, MAX, gateWith(["auto"]), undefined, mgr);

      expect(result.text).toMatch(/created:\s*true/);
      expect(result.text).toMatch(new RegExp(`transport:\\s*${CREATED}`));
      expect(trCreate).toHaveBeenCalledTimes(1);
      // The candidate look-up is anchored on the PACKAGE — the object does not exist yet.
      expect(trRequirement).toHaveBeenCalledTimes(1);
      expect(String(trRequirement.mock.calls[0]?.[1])).toBe(`/sap/bc/adt/packages/${PKG.toLowerCase()}`);
      expect(deployedWith(adt, CREATED)).toBe(true);
      if (c.invoker) expect(classic.invoker()).toBe(c.invoker(CREATED));
      // The resolver's own account of the decision is quoted, like the ADT-lock types do.
      expect(result.text).toMatch(new RegExp(`Created .*${CREATED}|${CREATED}.*created`, "i"));
    });
  }

  it("VIEW/DV: a modifiable request this session created for the package is ADOPTED — no new request (the ADT-lock types' own route)", async () => {
    const c = CASES[0]!;
    const classic = c.classic();
    const { conn } = await connected(both(classic.route, c.routes()));
    const { mgr, trCreate } = autoMgr([candidate("A4HK900200", { description: "abapsmith session 2026-09-16" })]);
    // The caller's own open request, e.g. from abap_transport operation=create.
    mgr.noteCreated("A4HK900200");

    const result = await abapWrite(conn, c.input as never, MAX, gateWith(["auto"]), undefined, mgr);

    expect(result.text).toMatch(/transport:\s*A4HK900200/);
    expect(trCreate).not.toHaveBeenCalled();
    expect(classic.invoker()).toBe(c.invoker!("A4HK900200"));
  });

  it("a NAMED corr_nr under auto is still refused (the gate is not widened) — but the refusal says to omit it, is terminal, and costs zero wire requests and zero requests created", async () => {
    for (const c of CASES) {
      const classic = c.classic();
      const { conn, adt } = await connected(both(classic.route, c.routes()));
      const { mgr, trCreate } = autoMgr();

      const e = await catchErr(
        abapWrite(conn, { ...c.input, corr_nr: NAMED } as never, MAX, gateWith(["auto"]), undefined, mgr),
      );

      expect(e.code, c.type).toBe("SAFETY_DENIED");
      expect(e.details.rule, c.type).toBe("transport allowlist");
      expect(e.retryable, c.type).toBe(false);
      expect(e.hint, c.type).toMatch(/Omit corr_nr/);
      expect(e.hint, c.type).toMatch(/refused regardless of which request/);
      expect(e.hint, c.type).toMatch(/terminal/);
      expect(trCreate, c.type).not.toHaveBeenCalled();
      expect(classic.deployed().length, c.type).toBe(0);
      // TABL/DI must read its base table to learn the package it is judged
      // against; the other three are refused before a single request leaves.
      if (c.type !== "TABL/DI") expect(adt.calls.length, c.type).toBe(0);
      else expect(adt.calls.every((r) => r.method === "GET"), c.type).toBe(true);
    }
  });
});

describe("issue #142: the gate verdict comes BEFORE any request is created, and one created-then-refused is reported", () => {
  it("a package the gate refuses (omitted corr_nr, auto) → SAFETY_DENIED with ZERO trCreate calls and zero wire requests; the manager is untouched", async () => {
    for (const c of CASES.filter((x) => x.type !== "TABL/DI")) {
      const classic = c.classic();
      const { conn, adt } = await connected(both(classic.route, c.routes()));
      const { mgr, trCreate, trRequirement } = autoMgr();

      const e = await catchErr(
        abapWrite(conn, c.input as never, MAX, gateWith(["auto"], ["ZOTHER"]), undefined, mgr),
      );

      expect(e.code, c.type).toBe("SAFETY_DENIED");
      expect(e.details.rule, c.type).toBe("package allowlist");
      expect(trCreate, c.type).not.toHaveBeenCalled();
      expect(trRequirement, c.type).not.toHaveBeenCalled();
      expect(adt.calls.length, c.type).toBe(0);
      expect(mgr.state.kind, c.type).toBe("idle");
    }
  });

  it("regression: a refused VIEW/DV leaves no new request behind, and the NEXT write in the same session lands on the caller's own open request", async () => {
    const view = CASES[0]!;
    const { mgr, trCreate } = autoMgr([candidate(NAMED, { description: "abapsmith session 2026-09-16" })]);
    mgr.noteCreated(NAMED); // the caller's request, e.g. from abap_transport operation=create

    // 1. Denied: the package is outside the allowlist. Nothing is created.
    {
      const classic = view.classic();
      const { conn } = await connected(both(classic.route, view.routes()));
      const e = await catchErr(
        abapWrite(conn, view.input as never, MAX, gateWith(["auto"], ["ZOTHER"]), undefined, mgr),
      );
      expect(e.code).toBe("SAFETY_DENIED");
      expect(trCreate).not.toHaveBeenCalled();
    }
    // 2. The next transportable write in the permitted package adopts the
    //    caller's request instead of creating a stranger next to it.
    {
      const classic = view.classic();
      const { conn } = await connected(both(classic.route, view.routes()));
      const result = await abapWrite(conn, view.input as never, MAX, gateWith(["auto"]), undefined, mgr);
      expect(result.text).toMatch(new RegExp(`transport:\\s*${NAMED}`));
      expect(trCreate).not.toHaveBeenCalled();
      expect(classic.invoker()).toBe(view.invoker!(NAMED));
    }
  });

  it("a request the resolver created that the gate then refuses is named in details.createdTransport and the hint, and the bridge is never deployed", async () => {
    // A resolver in auto mode paired with a gate pinned to one request: the
    // pre-resolution verdict passes (nothing named), the resolver creates
    // A4HK900321, and the post-resolution verdict refuses it. Synthetic —
    // in production both read the same ABAP_ALLOW_TRANSPORTS — but it is the
    // one shape that exercises the leak report.
    const view = CASES[0]!;
    const classic = view.classic();
    const { conn } = await connected(both(classic.route, view.routes()));
    const { mgr, trCreate } = autoMgr();

    const e = await catchErr(abapWrite(conn, view.input as never, MAX, gateWith([NAMED]), undefined, mgr));

    expect(e.code).toBe("SAFETY_DENIED");
    expect(trCreate).toHaveBeenCalledTimes(1);
    expect(e.details.createdTransport).toBe(CREATED);
    expect(e.hint).toMatch(new RegExp(`Transport request ${CREATED} was created by this call before the refusal`));
    expect(e.hint).toMatch(new RegExp(`abap_transport operation=delete corr_nr=${CREATED}`));
    expect(e.hint).toMatch(/journalled as transport-create/);
    expect(e.retryable).toBe(false);
    expect(classic.deployed().length).toBe(0);
    // The manager knows it created it, so abap_transport can find it.
    expect(mgr.createdThisSession(CREATED)).toBe(true);
  });
});
