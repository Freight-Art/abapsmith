/**
 * `VIEW/DV` / `TRAN/T` bridge CRUD — offline, with a fake
 * `HttpClient` injected through `ConnectionOptions.httpClient`. Nothing here
 * touches a real SAP system. Same harness idiom as test/write.test.ts and
 * test/write-package.test.ts: REAL production code drives a fake socket.
 *
 * Scope: `abapCreateViaBridge`'s `corr_nr`/`package` pairing for VIEW/DV
 * (RS_CORR_INSERT now registers a view for every package, so the create
 * reaches the bridge for a transportable package WITH corr_nr, for $TMP, and
 * for an omitted `package`; a corr_nr on a $ package is still refused
 * zero-network, and a transportable package with no corr_nr now resolves a
 * request through the wired `SessionTransport` instead of being refused up
 * front — it is refused only when the resolver itself declines, e.g.
 * transports disabled or a caller-named request outside the allowlist), and
 * the new `abapDeleteViaBridge` dispatch — most load-bearingly, that a
 * delete's package is judged against a SERVER-confirmed value via
 * `verifyViaVitBridge`, never a caller-supplied `package`. Neither delete
 * bridge module (`src/adt/view-delete.ts`, `src/adt/tran-delete.ts`) can look
 * its object's own package up itself, so a caller who names a permissive
 * package must not be able to slip a delete past `assertBridgeMutation`'s
 * allowlist — see src/tools/write-bridge.ts's `abapDeleteViaBridge` doc comment for
 * the full argument. If that check is ever weakened back to trusting the
 * caller's `package`, the test below named "does NOT let a caller's
 * disagreeing `package` reach the delete bridge" must fail with a thrown
 * `BAD_INPUT` never appearing (an `AssertionError`), not an import error.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import { CLASSIC_BODY_CLASS, CLASSIC_TOOL_ID } from "../src/adt/fluid/builtin/classic.js";
import { FLUID_CONTRACT } from "../src/adt/fluid/manifest.js";
import { invokerName } from "../src/adt/fluid/invoke.js";
import { vitBridgeUri } from "../src/adt/write-verify.js";
import { Journal } from "../src/journal.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { searchResultsXml } from "./helpers/fake-adt.js";
import { classicFake, useFluidState } from "./helpers/fluid-classic-fake.js";
import { isTstcSelect, tstcSelectResponse, type TstcRow } from "./helpers/tstc-select-fake.js";

const MAX = 20_000;

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

const NOT_FOUND_XML = (name: string): string =>
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">${name} does not exist</message><properties/></exc:exception>`;

const LOCK_XML = (handle = "H1", isLocal = "X", corrNr = "") =>
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
}

/**
 * One registry for the whole file, matching the real system's own
 * cold-cache-once behavior: whichever test dispatches the classic tool
 * first pays for the `ZCL_ZMCP_FLUID_RT`/`ZCL_ZMCP_FLUID_CLASSIC` deploy,
 * every later test in this file reuses it, and only the per-call invoker
 * class is deployed fresh each time.
 */
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
  const conn = new AbapConnection(cfg(), {
    httpClient: adt,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

/** `isTstcSelect`-matched requests answered from `rows`; every other request falls to `route`. */
const withTstc = (rows: readonly TstcRow[], route: Route): Route => (r) =>
  isTstcSelect(r) ? tstcSelectResponse(rows) : route(r);

/**
 * Like `withTstc`, but the FIRST `isTstcSelect` match answers `rows` and every
 * later one answers empty — models a delete's own pre-check (row present) then
 * post-delete `verifyTransactionDeleted` cross-check (row now gone) for a single
 * object touched exactly twice.
 */
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

/**
 * `connected()` checks `baseRoute` BEFORE the caller's own route, and `baseRoute`
 * unconditionally answers every `/datapreview/freestyle` request with the T000
 * system-role body — which would swallow a TSTC select before `withTstc` above ever
 * saw it. This variant checks the caller's route first, the same ordering
 * test/batch-delete-session-per-entry.test.ts's own `connected()` uses.
 */
async function connectedTstcFirst(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => route(r) ?? baseRoute(r));
  const conn = new AbapConnection(cfg(), { httpClient: adt, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const ABSENT_ROUTE: Route = () => resp(404, NOT_FOUND_XML("?"), OK_XML);

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

/** The VIT-bridge stub GET — used both for pre-delete package resolution and post-create/-delete verification. */
const vitRoute =
  (
    mode: "confirmed" | "absent" | "indeterminate",
    vitType: string,
    name: string,
    type: string,
    packageName = "ZTM",
  ): Route =>
  (r) => {
    const uri = vitBridgeUri(vitType, name);
    if (r.url !== uri) return undefined;
    if (mode === "absent") return resp(404, NOT_FOUND_XML(name), OK_XML);
    const rich =
      mode === "confirmed" ? `<adtcore:packageRef adtcore:name="${packageName}"/>` : "";
    return resp(
      200,
      `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" ` +
        `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:type="${type}" ` +
        `adtcore:name="${name}">${rich}</vit:properties>`,
      OK_XML,
    );
  };

/** The resolution GET `abapCreateViaBridge` makes for a TRAN/T's `program` — a real, existing PROG/P. */
const programRoute =
  (name: string): Route =>
  (r) =>
    r.method === "GET" && !r.qs._action && r.url === `/sap/bc/adt/programs/programs/${name.toLowerCase()}`
      ? resp(
          200,
          `<?xml version="1.0" encoding="utf-8"?>` +
            `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
            `adtcore:name="${name}" adtcore:type="PROG/P">` +
            `<adtcore:packageRef adtcore:name="$TMP"/></adtcore:objectMetadata>`,
          OK_XML,
        )
      : undefined;

/** `/repository/informationsystem/search` — the tie-breaker `verifyObjectDeleted` falls through to on a `200`/failed read-back. */
const searchRoute =
  (rows: readonly { name: string; type: string; uri: string }[]): Route =>
  (r) =>
    r.url.endsWith("/repository/informationsystem/search")
      ? resp(200, searchResultsXml(rows), OK_XML)
      : undefined;

const both =
  (...routes: Route[]): Route =>
  (r) => {
    for (const route of routes) {
      const hit = route(r);
      if (hit) return hit;
    }
    return undefined;
  };

// TRAN/T is the only type whose bridge create still runs, so every assertion
// about `abapCreateViaBridge`'s shared post-create notes is made on it.
const TCODE = "ZMCPT01";
const PROGRAM = "ZMCP_CARRIER_LIST";
const TRAN_INPUT = {
  object: TCODE,
  type: "TRAN/T",
  package: "$TMP",
  description: "Carrier list",
  program: PROGRAM,
} as const;

// ---------------------------------------------------------------------------
// Task 1: corr_nr narrowing on create
// ---------------------------------------------------------------------------

describe("abapCreateViaBridge — corr_nr/package pairing, now that the VIEW/DV create runs for every package", () => {
  const VIEW = "ZMCP_V_CARRIER";
  const validInput = {
    object: VIEW,
    type: "VIEW/DV",
    description: "Carriers",
    base_table: "ZMCP_CARRIER",
    view_fields: ["CARRIER_ID", "NAME"],
  };

  /** The exact `create_view` args `view-create.ts` sends — content-addresses the invoker class, so this is the strongest proof a given corr_nr reached the ABAP. */
  const viewArgs = (packageName: string, corrNr = ""): Record<string, unknown> => ({
    view_name: VIEW,
    base_table: "ZMCP_CARRIER",
    fields: ["CARRIER_ID", "NAME"],
    description: "Carriers",
    package_name: packageName,
    corr_nr: corrNr,
  });
  const viewInvoker = (packageName: string, corrNr = ""): string =>
    invokerName(CLASSIC_TOOL_ID, "create_view", viewArgs(packageName, corrNr), FLUID_CONTRACT);

  /**
   * A `SessionTransport` that only validates a caller-NAMED request (Step 5's
   * `#checkUsable`, which calls `trShow`) — never CTS's classification
   * pre-flight, which `resolveForNewTransportable` never runs. Same fake
   * `trShow` shape as test/session-transport-adopt.test.ts.
   */
  function namedTransport(): { transport: SessionTransport; trShow: ReturnType<typeof vi.fn> } {
    const trShow = vi.fn(async () => ({
      trkorr: "A4HK900117",
      kind: "workbench" as const,
      kindRaw: "K",
      status: "modifiable" as const,
      statusRaw: "D",
      owner: "DEVELOPER",
      description: "abapsmith session 2026-09-05",
      tasks: [],
      objects: [],
    }));
    return { transport: new SessionTransport({ allowTransports: ["*"], cts: { trShow } as never }), trShow };
  }

  /**
   * A `SessionTransport` in auto mode — no caller-named request, so
   * `#resolveAuto` first asks CTS for the package's modifiable candidates
   * (`trRequirement`, anchored on the PACKAGE because the object does not exist
   * yet — issue #141) and, finding none it may adopt, creates one via `trCreate`.
   */
  function autoTransport(): {
    transport: SessionTransport;
    trCreate: ReturnType<typeof vi.fn>;
    trRequirement: ReturnType<typeof vi.fn>;
  } {
    const devClass = "ZTM";
    const authorizeCreate = () =>
      new SafetyGate({ readOnly: false, allowPackages: ["*"] }).authorize(
        "transport",
        { name: devClass, packageName: devClass },
        { corr: { kind: "unresolved" } },
      );
    const trCreate = vi.fn(async () => ({
      trkorr: "A4HK900321",
      path: "/com.sap.cts/object_record/A4HK900321",
    }));
    const trRequirement = vi.fn(async (_conn: unknown, uri: string) => ({
      uri,
      operation: "I",
      candidates: [],
      locks: [],
      messages: [],
      checkFailed: false,
      raw: { result: "S", korrflag: "X", recording: "" },
      kind: "transport-required",
      mustSupplyCorrNr: true,
      serverWouldFabricate: false,
    }));
    return {
      transport: new SessionTransport({
        allowTransports: ["auto"],
        authorizeCreate,
        cts: { trCreate, trRequirement } as never,
      }),
      trCreate,
      trRequirement,
    };
  }

  it("a transportable package WITH a valid corr_nr reaches the bridge and the create succeeds", async () => {
    const classic = classicFake({ action: "create_view", lines: () => ["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"] });
    const vit = vitRoute("confirmed", "viewdv", VIEW, "VIEW/DV", "ZTM");
    const { conn, adt } = await connected(both(classic.route, vit));
    const { transport, trShow } = namedTransport();
    const result = await abapWrite(
      conn,
      { ...validInput, package: "ZTM", corr_nr: "A4HK900117" },
      MAX,
      gate(),
      undefined,
      transport,
    );
    expect(result.text).toMatch(/created: true/);
    expect(result.text).toMatch(/verified: true/);
    expect(result.text).toMatch(new RegExp(CLASSIC_BODY_CLASS));
    expect(result.text).toMatch(/transport: A4HK900117/);
    expect(trShow).toHaveBeenCalledTimes(1);
    expect(classic.invoker()).toBe(viewInvoker("ZTM", "A4HK900117"));
    expect(adt.calls.length).toBeGreaterThan(0);
  });

  it("a transportable package with no corr_nr and an explicitly empty ABAP_ALLOW_TRANSPORTS is refused with the resolver's own TRANSPORT_ERROR, before any network call", async () => {
    const offline = null as unknown as AbapConnection;
    const transport = new SessionTransport({ allowTransports: [] });
    const e = await catchErr(
      abapWrite(offline, { ...validInput, package: "ZTM" }, MAX, gate(), undefined, transport),
    );
    expect(e.code).toBe("TRANSPORT_ERROR");
    expect(String(e.message)).toMatch(/ABAP_ALLOW_TRANSPORTS/);
  });

  it("a transportable package with NO corr_nr under the auto policy resolves a request and the bridge receives it", async () => {
    const classic = classicFake({ action: "create_view", lines: () => ["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"] });
    const vit = vitRoute("confirmed", "viewdv", VIEW, "VIEW/DV", "ZTM");
    const { conn, adt } = await connected(both(classic.route, vit));
    const { transport, trCreate, trRequirement } = autoTransport();
    const result = await abapWrite(
      conn,
      { ...validInput, package: "ZTM" },
      MAX,
      gate(),
      undefined,
      transport,
    );
    expect(result.text).toMatch(/created: true/);
    expect(result.text).toMatch(/transport: A4HK900321/);
    expect(trCreate).toHaveBeenCalledTimes(1);
    expect(classic.invoker()).toBe(viewInvoker("ZTM", "A4HK900321"));
    // The not-yet-existing view is never classified by CTS — the one candidate
    // look-up is anchored on the PACKAGE (issue #141: the same adopt-else-create
    // route the ADT-lock types take), and the fake CTS above answered it, so the
    // synthesized view URI never reaches the wire as a transportchecks call.
    expect(trRequirement).toHaveBeenCalledTimes(1);
    expect(String(trRequirement.mock.calls[0]?.[1])).toBe("/sap/bc/adt/packages/ztm");
    expect(adt.calls.some((c) => c.url.includes("transportchecks"))).toBe(false);
  });

  it("a resolver refusal (a caller-named corr_nr outside a pinned allowlist) stops the write before the bridge is deployed", async () => {
    const classic = classicFake({ action: "create_view", lines: () => ["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"] });
    const vit = vitRoute("confirmed", "viewdv", VIEW, "VIEW/DV", "ZTM");
    const { conn } = await connected(both(classic.route, vit));
    const transport = new SessionTransport({ allowTransports: ["A4HK900117"] });
    const e = await catchErr(
      abapWrite(
        conn,
        { ...validInput, package: "ZTM", corr_nr: "A4HK900999" },
        MAX,
        gate(),
        undefined,
        transport,
      ),
    );
    expect(e.code).toBe("TRANSPORT_ERROR");
    expect(String(e.message)).toMatch(/not permitted by ABAP_ALLOW_TRANSPORTS/);
    // The resolver refuses before dispatch ever runs — nothing the classic tool
    // owns (RT, CLASSIC body, or an invoker) was ever created in the fake.
    expect(classic.deployed().length).toBe(0);
  });

  it("$TMP reaches the bridge too — RS_CORR_INSERT registers it with korrnum = space, not a refusal", async () => {
    const classic = classicFake({ action: "create_view", lines: () => ["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"] });
    const vit = vitRoute("confirmed", "viewdv", VIEW, "VIEW/DV", "$TMP");
    const { conn, adt } = await connected(both(classic.route, vit));
    const result = await abapWrite(conn, { ...validInput, package: "$TMP" }, MAX, gate());
    expect(result.text).toMatch(/created: true/);
    expect(result.text).toMatch(/package: \$TMP/);
    expect(adt.calls.length).toBeGreaterThan(0);
  });

  it("an OMITTED `package` defaults to $TMP inside abapCreateViaBridge and reaches the bridge just the same", async () => {
    const classic = classicFake({ action: "create_view", lines: () => ["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"] });
    const vit = vitRoute("confirmed", "viewdv", VIEW, "VIEW/DV", "$TMP");
    const { conn, adt } = await connected(both(classic.route, vit));
    const result = await abapWrite(conn, { ...validInput }, MAX, gate());
    expect(result.text).toMatch(/created: true/);
    expect(result.text).toMatch(/package: \$TMP/);
    expect(adt.calls.length).toBeGreaterThan(0);
  });

  it("a $ package WITH a corr_nr is refused BAD_INPUT before any network call", async () => {
    const offline = null as unknown as AbapConnection;
    const e = await catchErr(
      abapWrite(offline, { ...validInput, package: "$TMP", corr_nr: "TR1K900123" }, MAX, gate()),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/corr_nr/);
    expect(String(e.message)).toMatch(/\$TMP/);
  });

  it("TRAN/T into a transportable package with NO corr_nr and NO transport manager wired is refused TRANSPORT_ERROR as a wiring failure, before the bridge is deployed", async () => {
    // Issue #141: an omitted corr_nr is no longer a caller mistake for a bridge
    // type — it is resolved by the session manager. Without one wired (this
    // harness shape) nothing can resolve it, and the refusal says so instead of
    // sending the caller off to name a request the gate would then refuse.
    const classic = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
    const { conn } = await connected(both(programRoute(PROGRAM), classic.route));
    const e = await catchErr(abapWrite(conn, { ...TRAN_INPUT, package: "ZTM" }, MAX, gate()));
    expect(e.code).toBe("TRANSPORT_ERROR");
    expect(String(e.message)).toMatch(/no transport manager is wired/);
    expect(String(e.message)).toMatch(/not a mistake in the request/);
    expect(String(e.message)).not.toMatch(/pass corr_nr/);
    expect(classic.deployed().length).toBe(0);
  });

  it("TRAN/T into $TMP WITH a corr_nr is refused BAD_INPUT before any network call", async () => {
    const offline = null as unknown as AbapConnection;
    const e = await catchErr(
      abapWrite(
        offline,
        {
          object: "ZMCPT01",
          type: "TRAN/T",
          package: "$TMP",
          description: "Carrier list",
          program: "ZMCP_CARRIER_LIST",
          corr_nr: "TR1K900123",
        },
        MAX,
        gate(),
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/corr_nr/);
    expect(String(e.message)).toMatch(/\$TMP/);
  });

  it("TRAN/T into a transportable package WITH a corr_nr reaches the bridge and the create succeeds", async () => {
    const classic = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
    const vit = vitRoute("confirmed", "trant", TCODE, "TRAN/T", "ZTM");
    const { conn, adt } = await connected(both(programRoute(PROGRAM), classic.route, vit));
    const result = await abapWrite(
      conn,
      { ...TRAN_INPUT, package: "ZTM", corr_nr: "TR1K900123" },
      MAX,
      gate(),
    );
    expect(result.text).toMatch(/created: true/);
    expect(adt.calls.length).toBeGreaterThan(0);
  });

  // `bridgeReversalNote` (src/tools/write-bridge-common.ts) is shared by both bridge-create
  // types — asserted here on TRAN/T; the describe above covers VIEW/DV's
  // create running for every package, not this note's exact wording.
  it("the create-response closing note states abapsmith can REACH this type via bridge (not that delete is proven), and that create is still not journalled", async () => {
    const classic = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
    const vit = vitRoute("confirmed", "trant", TCODE, "TRAN/T", "$TMP");
    const { conn } = await connected(both(programRoute(PROGRAM), classic.route, vit));
    const result = await abapWrite(conn, TRAN_INPUT, MAX, gate());
    expect(result.text).toMatch(/can reach/);
    expect(result.text).toMatch(/see the limits note above/);
    expect(result.text).toMatch(/mode="delete"/);
    expect(result.text).toMatch(/abap_journal mode=undo will not reverse it/);
    // Narrowed: reachability, not a success guarantee — must not overclaim.
    expect(result.text).not.toMatch(/CAN delete/);
  });

  it("entryId===undefined (not journalled) + unregistered: the reachability claim is dropped when this create's own read-back found it unregistered, not made unconditionally", async () => {
    const classic = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
    // No packageRef, but an enriched attribute (changedBy) so vitStubShowsExistence
    // still calls it `confirmed` — the same orphan shape live-observed on VIEW/DV;
    // TRAN/T's create runs the identical reachability logic over it.
    const vit: Route = (r) =>
      r.url === vitBridgeUri("trant", TCODE)
        ? resp(
            200,
            `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" ` +
              `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:type="TRAN/T" ` +
              `adtcore:name="${TCODE}" adtcore:changedBy="DEVELOPER"></vit:properties>`,
            OK_XML,
          )
        : undefined;
    const { conn } = await connected(both(programRoute(PROGRAM), classic.route, vit));
    const result = await abapWrite(conn, TRAN_INPUT, MAX, gate());
    expect(result.text).not.toMatch(/CAN delete/);
    expect(result.text).not.toMatch(/can reach/);
    expect(result.text).toMatch(/no <adtcore:packageRef>/);
    expect(result.text).toMatch(/SAFETY_DENIED \/ PACKAGE_UNKNOWN/);
    expect(result.text).toMatch(/SE11\/SE14/);
  });
});

// ---------------------------------------------------------------------------
// Issue #209: a create with no `description` used to be refused BAD_INPUT
// zero-network; it now defaults to the object's own name (upper-cased) and
// the create proceeds, with the response notes saying so.
// ---------------------------------------------------------------------------

describe("abapCreateViaBridge — description defaulting (issue #209)", () => {
  it("a VIEW/DV with no `description` defaults it to the view's own name and creates successfully", async () => {
    const classic = classicFake({ action: "create_view", lines: () => ["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"] });
    const vit = vitRoute("confirmed", "viewdv", "ZMCP_V_CARRIER", "VIEW/DV", "$TMP");
    const { conn } = await connected(both(classic.route, vit));
    const result = await abapWrite(
      conn,
      {
        object: "ZMCP_V_CARRIER",
        type: "VIEW/DV",
        package: "$TMP",
        base_table: "ZMCP_CARRIER",
        view_fields: ["CARRIER_ID", "NAME"],
      },
      MAX,
      gate(),
    );
    expect(result.text).toMatch(/created: true/);
    expect(result.text).toMatch(/description defaulted to "ZMCP_V_CARRIER" \(none was given\)\./);
  });

  it("a TRAN/T with no `description` defaults it to the tcode's own name and creates successfully", async () => {
    const classic = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
    const vit = vitRoute("confirmed", "trant", TCODE, "TRAN/T", "$TMP");
    const { conn } = await connected(both(programRoute(PROGRAM), classic.route, vit));
    const result = await abapWrite(
      conn,
      { object: TCODE, type: "TRAN/T", package: "$TMP", program: PROGRAM },
      MAX,
      gate(),
    );
    expect(result.text).toMatch(/created: true/);
    expect(result.text).toMatch(new RegExp(`description defaulted to "${TCODE}" \\(none was given\\)\\.`));
  });

  it("a create WITH an explicit `description` does not emit the defaulting note", async () => {
    const classic = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
    const vit = vitRoute("confirmed", "trant", TCODE, "TRAN/T", "$TMP");
    const { conn } = await connected(both(programRoute(PROGRAM), classic.route, vit));
    const result = await abapWrite(conn, TRAN_INPUT, MAX, gate());
    expect(result.text).toMatch(/created: true/);
    expect(result.text).not.toMatch(/description defaulted to/);
  });
});

// ---------------------------------------------------------------------------
// Issue #201: the VIT bridge's own stub can answer 200 for a TRAN/T TSTC has
// no row for at all — a stale/generic stub response, not evidence of a real
// transaction. This only runs when the journal is on (the pre-create VIT
// probe only happens then), so every test below passes one.
// ---------------------------------------------------------------------------

describe("abapCreateViaBridge — TSTC cross-check on a VIT-confirmed TRAN/T (issue #201)", () => {
  const withJournal = async (fn: (journal: Journal) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "abapsmith-bridge-tstc-journal-"));
    try {
      await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it("TSTC has no row for it: treated as absent, created, and the response notes the stale VIT stub (issue #201)", async () => {
    await withJournal(async (journal) => {
      const vit = vitRoute("confirmed", "trant", TCODE, "TRAN/T", "$TMP");
      const classic = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
      const { conn } = await connectedTstcFirst(withTstc([], both(programRoute(PROGRAM), classic.route, vit)));
      const result = await abapWrite(conn, TRAN_INPUT, MAX, gate(), journal);
      expect(result.text).toMatch(/created: true/);
      expect(result.text).toMatch(
        new RegExp(`The VIT bridge answered 200 for ${TCODE}.*TSTC has no row for it.*treated as absent and created \\(issue #201\\)`),
      );
    });
  });

  it("TSTC confirms a row: refused CHECK_FAILED naming the existing program, zero bridge classes deployed", async () => {
    await withJournal(async (journal) => {
      const vit = vitRoute("confirmed", "trant", TCODE, "TRAN/T", "$TMP");
      const classic = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
      const rows: TstcRow[] = [{ TCODE, PGMNA: "ZMCP_OLD_PROGRAM", DYPNO: "1000", CINFO: "80" }];
      const { conn } = await connectedTstcFirst(withTstc(rows, both(programRoute(PROGRAM), classic.route, vit)));
      const err = await catchErr(abapWrite(conn, TRAN_INPUT, MAX, gate(), journal));
      expect(err.code).toBe("CHECK_FAILED");
      expect(String(err.message)).toMatch(/already exists/);
      expect(String(err.message)).toMatch(/TSTC confirms a row \(program ZMCP_OLD_PROGRAM\)/);
      expect(classic.deployed().length).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Task 3: the create-response's reversal note reflects THIS create's
// own registration read-back — registered / unregistered / unknown — never
// a blanket "undo can delete it" promise. An object can land active but
// unregistered in TADIR; this only stops the note from claiming a guarantee
// that shape disproves.
// ---------------------------------------------------------------------------

describe("abapCreateViaBridge — reversal note keyed on this create's own registration read-back", () => {
  const withJournal = async (fn: (journal: Journal) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "abapsmith-bridge-reversal-journal-"));
    try {
      await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  /** First hit on the object's VIT URI answers the pre-create existence check as absent (so beforeCapture="confirmed-absent"); every later hit answers with `stubBody`. */
  const vitOnceAbsentThen = (vitType: string, name: string, stubBody: string): Route => {
    const uri = vitBridgeUri(vitType, name);
    let calls = 0;
    return (r) => {
      if (r.url !== uri) return undefined;
      calls += 1;
      if (calls === 1) return resp(404, NOT_FOUND_XML(name), OK_XML);
      return resp(200, stubBody, OK_XML);
    };
  };

  const createInput = TRAN_INPUT;

  /** bridge deploy + program resolution + classrun, shared by all three cases below. */
  const around = (vit: Route): Route =>
    both(
      programRoute(PROGRAM),
      classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] }).route,
      vit,
    );

  it("registered: read-back names a package — undo can REACH it through the same bridge (reachability, not a delete-success guarantee), and the note names THIS object's package, not a general type claim", async () => {
    await withJournal(async (journal) => {
      const vit = vitOnceAbsentThen(
        "trant",
        TCODE,
        `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" ` +
          `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:type="TRAN/T" ` +
          `adtcore:name="${TCODE}"><adtcore:packageRef adtcore:name="$TMP"/></vit:properties>`,
      );
      const { conn } = await connected(around(vit));
      const result = await abapWrite(conn, createInput, MAX, gate(), journal);
      expect(result.text).toMatch(/read-back found it registered in package \$TMP/);
      expect(result.text).toMatch(/abap_journal mode=undo entry=/);
      expect(result.text).toMatch(/undo can reach it through the same classrun bridge abap_write mode="delete" uses/);
      expect(result.text).toMatch(/see the limits note above for whether that bridge's delete is itself proven/);
      // Narrowed: reachability, not an assertion that the delete itself succeeds.
      expect(result.text).not.toMatch(/deletes it via the same classrun bridge/);
    });
  });

  it("unregistered (the live-observed orphan): confirmed present via the VIT bridge but no <adtcore:packageRef> — the note says delete AND undo both refuse it, not that undo can reverse it", async () => {
    await withJournal(async (journal) => {
      // Enriched attribute (changedBy), no packageRef — confirmed present,
      // unregistered in TADIR, exactly the orphan shape measured on VIEW/DV.
      const vit = vitOnceAbsentThen(
        "trant",
        TCODE,
        `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" ` +
          `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:type="TRAN/T" ` +
          `adtcore:name="${TCODE}" adtcore:changedBy="DEVELOPER"></vit:properties>`,
      );
      const { conn } = await connected(around(vit));
      const result = await abapWrite(conn, createInput, MAX, gate(), journal);
      expect(result.text).toMatch(/no <adtcore:packageRef>/);
      expect(result.text).toMatch(/active and unregistered in TADIR/);
      expect(result.text).toMatch(/SAFETY_DENIED \/ PACKAGE_UNKNOWN/);
      expect(result.text).toMatch(/non-overridably/);
      expect(result.text).toMatch(/SE11\/SE14/);
      // Must NOT still claim undo can reverse it — the false guarantee this fixes.
      expect(result.text).not.toMatch(/deletes it via the same classrun bridge abap_write mode="delete" uses\./);
    });
  });

  it("unknown: neither probe settled a package for it — the note is conditional and names the failure mode (SAFETY_DENIED / PACKAGE_UNKNOWN), not a bare hedge", async () => {
    await withJournal(async (journal) => {
      // A stub that does NOT echo back the requested name — genuinely
      // indeterminate under `echoesTarget` (write-verify.ts) — and the
      // repository-search fallback has no route, so it stays indeterminate too.
      const vit = vitOnceAbsentThen(
        "trant",
        TCODE,
        `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" ` +
          `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:type="TRAN/T" ` +
          `adtcore:name="ZSOME_OTHER_OBJECT"></vit:properties>`,
      );
      const { conn } = await connected(around(vit));
      const result = await abapWrite(conn, createInput, MAX, gate(), journal);
      expect(result.text).toMatch(/can reach it through the same classrun bridge/);
      expect(result.text).toMatch(/if it is registered/);
      expect(result.text).toMatch(/did not establish a package for it/);
      expect(result.text).toMatch(/SAFETY_DENIED \/ PACKAGE_UNKNOWN/);
    });
  });
});

// ---------------------------------------------------------------------------
// Task 2: delete dispatch
// ---------------------------------------------------------------------------

describe("abapDeleteViaBridge — dispatch and create-only-field refusals", () => {
  it("mode:'delete' on VIEW/DV no longer throws UNSUPPORTED — it dispatches to the view delete bridge and makes real requests", async () => {
    const found = vitRoute("confirmed", "viewdv", "ZMCP_V_CARRIER", "VIEW/DV", "ZTM");
    const gone = vitRoute("absent", "viewdv", "ZMCP_V_CARRIER", "VIEW/DV");
    const classic = classicFake({ action: "delete_view", lines: () => ["VIEW-DELETED", "VIEW-GONE"] });
    const { conn, adt } = await connected(both(classic.route, (r) => found(r) ?? gone(r)));
    const result = await abapWrite(
      conn,
      { object: "ZMCP_V_CARRIER", type: "VIEW/DV", mode: "delete" },
      MAX,
      gate(),
    );
    expect(result.text).toMatch(/deleted:\s*true/);
    expect(adt.calls.length).toBeGreaterThan(0);
  });

  it("mode:'delete' on TRAN/T dispatches to the transaction delete bridge, not the view one", async () => {
    // $TMP: dispatch routing, not transport resolution, is under test here.
    const found = vitRoute("confirmed", "trant", "ZMCPT01", "TRAN/T", "$TMP");
    const gone = vitRoute("absent", "trant", "ZMCPT01", "TRAN/T");
    const classic = classicFake({ action: "delete_transaction", lines: () => ["TRAN-DELETED", "TRAN-GONE"] });
    const rows: TstcRow[] = [{ TCODE: "ZMCPT01", PGMNA: PROGRAM, DYPNO: "1000", CINFO: "00" }];
    const { conn } = await connectedTstcFirst(
      withTstcThenGone(rows, both(classic.route, (r) => found(r) ?? gone(r))),
    );
    const result = await abapWrite(
      conn,
      { object: "ZMCPT01", type: "TRAN/T", mode: "delete" },
      MAX,
      gate(),
    );
    expect(result.text).toMatch(/deleted:\s*true/);
    expect(result.text).toMatch(new RegExp(CLASSIC_BODY_CLASS));
  });

  it("a VIEW/DV delete carrying a create-only field (base_table) is refused BAD_INPUT with ZERO requests on the wire", async () => {
    const offline = null as unknown as AbapConnection;
    const e = await catchErr(
      abapWrite(
        offline,
        { object: "ZMCP_V_CARRIER", type: "VIEW/DV", mode: "delete", base_table: "ZMCP_CARRIER" },
        MAX,
        gate(),
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/base_table/);
  });

  it("a VIEW/DV delete carrying corr_nr is refused BAD_INPUT zero-network — the view delete bridge takes no transport parameter", async () => {
    const offline = null as unknown as AbapConnection;
    const e = await catchErr(
      abapWrite(
        offline,
        { object: "ZMCP_V_CARRIER", type: "VIEW/DV", mode: "delete", corr_nr: "TR1K900123" },
        MAX,
        gate(),
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/corr_nr/);
  });

  // Issue #202: a TRAN/T delete's corr_nr can no longer be refused zero-network the way
  // VIEW/DV's still is — it is resolved AFTER the object's real package is read back via
  // the VIT bridge (deleteTransactionViaBridge itself refuses a corr_nr for a local
  // package, same rule as its create-side sibling), so this needs a connected fake.
  it("a TRAN/T delete of an object confirmed in $TMP carrying corr_nr is refused BAD_INPUT — a local package takes no transport", async () => {
    const found = vitRoute("confirmed", "trant", "ZMCPT01", "TRAN/T", "$TMP");
    const classic = classicFake({ action: "delete_transaction", lines: () => ["TRAN-DELETED", "TRAN-GONE"] });
    const rows: TstcRow[] = [{ TCODE: "ZMCPT01", PGMNA: PROGRAM, DYPNO: "1000", CINFO: "00" }];
    const { conn } = await connectedTstcFirst(withTstc(rows, both(classic.route, found)));
    const e = await catchErr(
      abapWrite(
        conn,
        { object: "ZMCPT01", type: "TRAN/T", mode: "delete", corr_nr: "TR1K900123" },
        MAX,
        gate(),
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/corr_nr/);
    expect(classic.deployed().length).toBe(0);
  });

  it("a TRAN/T delete of an object confirmed in a transportable package, WITH a corr_nr, reaches the bridge and succeeds", async () => {
    const found = vitRoute("confirmed", "trant", "ZMCPT01", "TRAN/T", "ZTM");
    const gone = vitRoute("absent", "trant", "ZMCPT01", "TRAN/T");
    const classic = classicFake({ action: "delete_transaction", lines: () => ["TRAN-REGISTERED", "TRAN-DELETED", "TRAN-GONE"] });
    const rows: TstcRow[] = [{ TCODE: "ZMCPT01", PGMNA: PROGRAM, DYPNO: "1000", CINFO: "00" }];
    const { conn } = await connectedTstcFirst(
      withTstcThenGone(rows, both(classic.route, (r) => found(r) ?? gone(r))),
    );
    const result = await abapWrite(
      conn,
      { object: "ZMCPT01", type: "TRAN/T", mode: "delete", corr_nr: "TR1K900123" },
      MAX,
      gate(),
    );
    expect(result.text).toMatch(/deleted:\s*true/);
    expect(result.text).toMatch(/transport: TR1K900123/);
  });

  it("a delete whose read-back and search both CONFIRM the object still present is reported as CHECK_FAILED, never as a successful delete", async () => {
    const found = vitRoute("confirmed", "viewdv", "ZMCP_V_CARRIER", "VIEW/DV", "ZTM");
    // Post-delete verifyObjectDeleted: the SAME vit URI now still answers
    // 200 (still there) — the classrun claimed success but the object
    // persists — and the repository-search tie-breaker agrees it's present.
    const stillThere = vitRoute("confirmed", "viewdv", "ZMCP_V_CARRIER", "VIEW/DV", "ZTM");
    const search = searchRoute([
      { name: "ZMCP_V_CARRIER", type: "VIEW/DV", uri: vitBridgeUri("viewdv", "ZMCP_V_CARRIER") },
    ]);
    const classic = classicFake({ action: "delete_view", lines: () => ["VIEW-DELETED", "VIEW-GONE"] });
    const { conn } = await connected(both(classic.route, found, stillThere, search));
    const e = await catchErr(
      abapWrite(conn, { object: "ZMCP_V_CARRIER", type: "VIEW/DV", mode: "delete" }, MAX, gate()),
    );
    expect(e.code).toBe("CHECK_FAILED");
    expect(String(e.message)).toMatch(/STILL confirmed present/);
  });

  it("the delete-response notes no longer claim there is no delete endpoint for this type", async () => {
    // $TMP: response-text shape, not transport resolution, is under test here.
    const found = vitRoute("confirmed", "trant", "ZMCPT01", "TRAN/T", "$TMP");
    const gone = vitRoute("absent", "trant", "ZMCPT01", "TRAN/T");
    const classic = classicFake({ action: "delete_transaction", lines: () => ["TRAN-DELETED", "TRAN-GONE"] });
    const rows: TstcRow[] = [{ TCODE: "ZMCPT01", PGMNA: PROGRAM, DYPNO: "1000", CINFO: "00" }];
    const { conn } = await connectedTstcFirst(
      withTstcThenGone(rows, both(classic.route, (r) => found(r) ?? gone(r))),
    );
    const result = await abapWrite(
      conn,
      { object: "ZMCPT01", type: "TRAN/T", mode: "delete" },
      MAX,
      gate(),
    );
    expect(result.text).not.toMatch(/cannot be deleted/i);
    expect(result.text).not.toMatch(/UNSUPPORTED/);
  });
});

// ---------------------------------------------------------------------------
// Safety-gate-bypass fix: package is resolved from the SERVER, never trusted
// from the caller, before a delete bridge is ever invoked.
// ---------------------------------------------------------------------------

describe("abapDeleteViaBridge — package resolved from the server, not the caller (safety-gate-bypass fix)", () => {
  it("confirmed-absent (the object never existed) is refused NOT_FOUND, before any bridge class is deployed", async () => {
    const gone = vitRoute("absent", "viewdv", "ZMCP_GHOST_VIEW", "VIEW/DV");
    const { conn, adt } = await connected(gone);
    const e = await catchErr(
      abapWrite(conn, { object: "ZMCP_GHOST_VIEW", type: "VIEW/DV", mode: "delete" }, MAX, gate()),
    );
    expect(e.code).toBe("NOT_FOUND");
    // Exactly the one VIT-bridge GET — no bridge class GET/POST/LOCK/PUT/UNLOCK.
    expect(adt.calls.length).toBe(1);
  });

  it("a thin VIT stub that echoes the target but shows no existence (200, no packageRef, no enriched attrs) is refused NOT_FOUND, same as a 404 — confirmed-absent, not indeterminate", async () => {
    // Under the echoesTarget + vitStubShowsExistence split, a
    // stub that echoes the requested type/name but carries none of
    // vitStubShowsExistence's signals is `confirmed-absent`, not
    // `indeterminate` — this used to be the "indeterminate (VIT bridge
    // answers too sparsely to trust)" case (mode "indeterminate" below
    // just reuses vitRoute's sparse-body shape); this was later reclassified.
    const sparse = vitRoute("indeterminate", "viewdv", "ZMCP_V_CARRIER", "VIEW/DV");
    const { conn, adt } = await connected(sparse);
    const e = await catchErr(
      abapWrite(conn, { object: "ZMCP_V_CARRIER", type: "VIEW/DV", mode: "delete" }, MAX, gate()),
    );
    expect(e.code).toBe("NOT_FOUND");
    expect(adt.calls.length).toBe(1);
  });

  it("a VIT stub that does NOT echo the requested name (genuinely indeterminate) is refused SAFETY_DENIED / PACKAGE_UNKNOWN, carrying the reason, not a silent fall-through", async () => {
    // Genuine indeterminacy is narrower than it used to
    // be: only a stub that fails to echo back the requested type/name at
    // all (not merely "sparse") stays indeterminate — see write-verify.ts's
    // `echoesTarget`.
    const route: Route = (r) => {
      const uri = vitBridgeUri("viewdv", "ZMCP_V_CARRIER");
      if (r.url !== uri) return undefined;
      return resp(
        200,
        `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" ` +
          `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:type="VIEW/DV" ` +
          `adtcore:name="ZSOME_OTHER_OBJECT"></vit:properties>`,
        OK_XML,
      );
    };
    const { conn, adt } = await connected(route);
    const e = await catchErr(
      abapWrite(conn, { object: "ZMCP_V_CARRIER", type: "VIEW/DV", mode: "delete" }, MAX, gate()),
    );
    expect(e.code).toBe("SAFETY_DENIED");
    expect(e.details.reason).toBe("PACKAGE_UNKNOWN");
    expect(String(e.details.cause ?? "")).toMatch(/did not echo back/);
    expect(adt.calls.length).toBe(1);
    // existence could not be confirmed, not denied — a healthy connection resolves it
    expect(e.retryable).toBe(true);
  });

  it("confirmed but no <adtcore:packageRef> in the VIT stub is refused SAFETY_DENIED / PACKAGE_UNKNOWN, never defaulted to $TMP or the caller's value", async () => {
    // A hand-built stub carrying no packageRef and no enriched attributes
    // would actually be classified `confirmed-absent` by
    // `vitStubShowsExistence` (see write-verify.ts) — so this exercises the
    // OTHER path to `packageName === undefined`: a VIT stub that IS rich
    // enough to be `confirmed` (an empty but present packageRef element
    // satisfies `vitStubShowsRegistration`, matching type/name) but whose
    // packageRef element itself carries no usable name for
    // `packageRefName` to extract.
    const route: Route = (r) => {
      const uri = vitBridgeUri("viewdv", "ZMCP_V_CARRIER");
      if (r.url !== uri) return undefined;
      return resp(
        200,
        `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" ` +
          `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:type="VIEW/DV" ` +
          // A space before the self-close matters: `vitStubShowsRegistration`
          // (write-verify.ts) requires whitespace or `>` immediately after
          // `packageRef` — kept byte-identical to the earlier test it was carried over from —
          // so a bare `<adtcore:packageRef/>` with no preceding space would
          // NOT satisfy it, and this stub would fall through to
          // `confirmed-absent` instead of the `confirmed`-with-no-package
          // case this test means to exercise.
          `adtcore:name="ZMCP_V_CARRIER"><adtcore:packageRef /></vit:properties>`,
        OK_XML,
      );
    };
    const { conn } = await connected(route);
    const e = await catchErr(
      abapWrite(conn, { object: "ZMCP_V_CARRIER", type: "VIEW/DV", mode: "delete" }, MAX, gate()),
    );
    expect(e.code).toBe("SAFETY_DENIED");
    expect(e.details.reason).toBe("PACKAGE_UNKNOWN");
    expect(String(e.message)).toMatch(/no <adtcore:packageRef> element/);
    // Hint routes the caller to SE11/SE14 and names the known orphan outcome
    // (active but unregistered in TADIR), same vocabulary as bridgeReversalNote's
    // "unregistered" branch — catches a later rewrite that drops either
    // without weakening the gate.
    expect(String(e.hint)).toMatch(/known orphan outcome/);
    expect(String(e.hint)).toMatch(/unregistered in\s+TADIR/);
    expect(String(e.hint)).toMatch(/SE11\/SE14/);
  });

  it("a caller's `package` that AGREES with the server is accepted and reaches the delete bridge", async () => {
    const found = vitRoute("confirmed", "viewdv", "ZMCP_V_CARRIER", "VIEW/DV", "ZTM");
    const gone = vitRoute("absent", "viewdv", "ZMCP_V_CARRIER", "VIEW/DV");
    const classic = classicFake({ action: "delete_view", lines: () => ["VIEW-DELETED", "VIEW-GONE"] });
    const { conn } = await connected(both(classic.route, (r) => found(r) ?? gone(r)));
    const result = await abapWrite(
      conn,
      { object: "ZMCP_V_CARRIER", type: "VIEW/DV", mode: "delete", package: "ZTM" },
      MAX,
      gate(),
    );
    expect(result.text).toMatch(/deleted:\s*true/);
  });

  it("does NOT let a caller's disagreeing `package` reach the delete bridge — refused BAD_INPUT, and the gate is never even asked (THE core regression guard)", async () => {
    // The server says ZTM; the caller claims $TMP (or any other permissive
    // package the gate's allowlist would have approved). If the fix in
    // abapDeleteViaBridge is ever reverted to trusting `target.packageName`
    // outright, this reaches `assertBridgeMutation`/`deleteClassicViewViaBridge`
    // with the caller's package unchecked, the fake server answers the
    // delete happily, and this assertion fails — an AssertionError on
    // `e.code`, never an import error, so a revert cannot hide behind "the
    // test didn't even run".
    const found = vitRoute("confirmed", "viewdv", "ZMCP_V_CARRIER", "VIEW/DV", "ZTM");
    const classic = classicFake({ action: "delete_view", lines: () => ["VIEW-DELETED", "VIEW-GONE"] });
    const { conn, adt } = await connected(both(classic.route, found));
    const e = await catchErr(
      abapWrite(
        conn,
        { object: "ZMCP_V_CARRIER", type: "VIEW/DV", mode: "delete", package: "$TMP" },
        MAX,
        gate(),
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/ZTM/);
    expect(String(e.message)).toMatch(/\$TMP/);
    expect(String(e.message)).toMatch(/does not move objects between packages/);
    // Exactly the one VIT-bridge resolution GET — no bridge-class deploy, no
    // classrun execution: the mismatch is caught before any of that.
    expect(adt.calls.length).toBe(1);
  });
});
