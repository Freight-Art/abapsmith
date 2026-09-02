/**
 * Package creation (`DEVC/K`) — offline, with a fake `HttpClient` injected
 * through `ConnectionOptions.httpClient`. Nothing here touches a real SAP
 * system. Same harness idiom as test/write.test.ts: REAL production code and
 * the REAL vendor library drive a fake socket, so the request bytes asserted
 * below are the bytes abapsmith would actually put on the wire.
 *
 * WHAT IS REAL AND WHAT IS INVENTED — read this before trusting any assertion:
 *
 *   REAL     The REQUEST. The create body is produced in-process by
 *            `abap-adt-api`'s own `objectcreator`, driven by our real
 *            `createPackage`. Asserting on it is meaningful: it is exactly
 *            what SAP would receive.
 *
 *   INVENTED The RESPONSE. `POST /sap/bc/adt/packages` has NEVER been
 *            captured from A4H — no fixture for it exists anywhere in this
 *            repo. The `resp(200, "", {})` answers below are a GUESS,
 *            modelled on how PROG/CLAS creates answer (200, content-length 0,
 *            no body, no Location).
 *            If the real server answers differently — a body, a 201, a
 *            Location header — these tests will not have caught it. That is
 *            the first thing the live agent should check.
 *
 * Nothing here asserts that a created package is transportable, or that SAP
 * honoured any field we sent. Those are live questions and this file has no
 * standing to answer them.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, RETRYABILITY, isAbapError } from "../src/adt/errors.js";
import { Journal } from "../src/journal.js";
import {
  authorizeMutation,
  createPackage,
  deleteObject,
  resolveWriteTarget,
  writeObject,
  type WriteTarget,
} from "../src/adt/write.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { DDIC_BRIDGE_CLASS, DDIC_BRIDGE_PACKAGE } from "../src/adt/ddic-bridge.js";
import { PKG_CONTENT_PREFIX } from "../src/adt/package-delete.js";

const PKG = "ZSD_ORDER";
const PKG_URI = "/sap/bc/adt/packages/zsd_order";
const PACKAGES = "/sap/bc/adt/packages";
/** The appliance's real superpackage. `isSapPackage("COURSES")` is TRUE. */
const PARENT = "COURSES";

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
/*
 * `DATAPREVIEW_XML` and `T000_NONPRODUCTIVE` come from
 * ./helpers/system-role-fake.js. The latter proves the fake system is
 * NON-productive, or every write fails closed.
 */

const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">${PKG} does not exist</message><properties/></exc:exception>`;

/**
 * A package's own metadata, shaped after the REAL captured
 * A live package-detail capture shows `adtcore:packageRef` names the package
 * ITSELF, with the hierarchy parent in a separate `<pak:superPackage>`.
 */
const PACKAGE_XML = (name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" adtcore:type="DEVC/K">` +
  `<adtcore:packageRef adtcore:name="${name}" adtcore:type="DEVC/K"/>` +
  `<pak:superPackage/>` +
  `</pak:package>`;

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
  /** Every POST to the package collection — the thing a refusal must never make. */
  get creates(): Recorded[] {
    return this.calls.filter((c) => c.method === "POST" && c.url === PACKAGES);
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

const pinnedTo = (trkorr: string): SessionTransport =>
  new SessionTransport({
    allowTransports: [trkorr],
    cts: { trRequirement: vi.fn(async () => fakeReq({ pinnedTo: trkorr })) },
  });

// The allowlist here is `PARENT` ("COURSES"), not `PKG` — for a `DEVC/K`
// create the gate's allowlist question ("which container may this write land
// in") is answered by the SUPERpackage, never the new package's own name (a
// package being created is by definition not already an allowlisted
// package). `PKG` itself is still judged, but only by the SAP-owner and
// Z/Y-prefix rules, which stay pinned to the own name — see the "gives a new
// package its OWN name as packageName and the caller's package as
// superPackage" test below and src/safety.ts.
const gateFor = (trkorr: string): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: [PARENT], allowTransports: [trkorr] });

/**
 * `createPackage`/`writeObject`/`deleteObject` now require a real gate-minted
 * `AuthorizedTarget`. `allowPackages: ["*"]` matches everything (see
 * `packagePattern` in src/safety.ts), so this never
 * masks an authorization decision the way the old `WriteTarget |
 * AuthorizedTarget` escape hatch did — it just gets the mechanics-only call
 * sites in this file past the type. Tests that ARE about the gate build and
 * pass their own (`gateFor`), exactly as before.
 */
const DEFAULT_GATE = new SafetyGate({ readOnly: false, allowPackages: ["*"] });

const authWrite = (conn: AbapConnection, target: WriteTarget, gate: SafetyGate = DEFAULT_GATE) =>
  authorizeMutation(conn, gate, "write", target);

const authDelete = (conn: AbapConnection, target: WriteTarget, gate: SafetyGate = DEFAULT_GATE) =>
  authorizeMutation(conn, gate, "delete", target);

/** The package does not exist (404 ⇒ create) and the POST succeeds. */
const createRoute: Route = (r) => {
  if (r.url === PKG_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
  // INVENTED RESPONSE — see the file header. Modelled on PROG/CLAS creates.
  if (r.url === PACKAGES && r.method === "POST") return resp(200, "", {});
  return undefined;
};

describe("createPackage — DEVC/K (request bytes are real; the SERVER RESPONSE SHAPE IS SYNTHETIC — never captured from A4H)", () => {
  it("creates a package: GET(404) → POST /sap/bc/adt/packages", async () => {
    const { conn, adt } = await connected(createRoute);

    const gate = gateFor("A4HK900123");
    const res = await createPackage(
      conn,
      await authWrite(conn, { type: "DEVC/K", name: PKG, packageName: PARENT, description: "Sales order training" }, gate),
      {
        softwareComponent: "HOME",
        transport: pinnedTo("A4HK900123"),
        gate,
        corrNr: "A4HK900123",
      },
    );

    expect(res.created).toBe(true);
    expect(res.superPackage).toBe(PARENT);
    expect(res.softwareComponent).toBe("HOME");
    expect(adt.labels).toEqual([`GET ${PKG_URI}`, `POST ${PACKAGES}`]);

    const create = adt.creates[0]!;
    // The transport number rides the create itself — without it SAP answers
    // 200 and fabricates a request behind the gate's back.
    expect(create.qs.corrNr).toBe("A4HK900123");

    const body = create.body!;
    expect(body).toContain(`adtcore:name="${PKG}"`);
    expect(body).toContain(`<pak:superPackage adtcore:name="${PARENT}"`);
    expect(body).toContain(`pak:name="HOME"`);
    expect(body).toContain("development");
  });

  /**
   * KNOWN UPSTREAM DEFECT — abap-adt-api 8.4.1,
   * node_modules/abap-adt-api/build/api/objectcreator.js line 42: the DEVC/K
   * body template hardcodes `<adtcore:packageRef adtcore:name="YMU_RAP"/>`
   * into EVERY package create, ignoring the caller's options entirely.
   * YMU_RAP is some package from the library author's own system.
   *
   * This test pins what genuinely goes on the wire today. It is emphatically
   * NOT an endorsement, and it asserts nothing about the consequences:
   * whether SAP honours, ignores or rejects that field is UNVERIFIED and is
   * live-check #1 for this feature. If the live agent finds SAP honours it,
   * this is a correctness bug and the body must be built by hand instead.
   */
  it("KNOWN VENDOR DEFECT: the create body hardcodes packageRef YMU_RAP", async () => {
    const { conn, adt } = await connected(createRoute);

    const gate = gateFor("A4HK900123");
    await createPackage(
      conn,
      await authWrite(conn, { type: "DEVC/K", name: PKG, packageName: PARENT }, gate),
      {
        softwareComponent: "HOME",
        transport: pinnedTo("A4HK900123"),
        gate,
        corrNr: "A4HK900123",
      },
    );

    const body = adt.creates[0]!.body!;
    expect(body).toContain("YMU_RAP");
    // …and it is the packageRef specifically, not an accident of some other field.
    expect(body).toMatch(/<adtcore:packageRef\s+adtcore:name="YMU_RAP"\s*\/>/);
  });

  it("refuses a transportable package create with no transport, and sends NOTHING", async () => {
    const { conn, adt } = await connected(createRoute);

    const err = await catchErr(
      createPackage(
        conn,
        await authWrite(conn, { type: "DEVC/K", name: PKG, packageName: PARENT }),
        { softwareComponent: "HOME" },
      ),
    );

    expect(err.code).toBe("TRANSPORT_ERROR");
    // `createPackage` creates LOCAL packages only, so
    // reaching this guard with non-LOCAL means src/tools/write.ts failed to
    // route to the classrun bridge — an internal routing failure, not
    // something the caller can fix.
    expect(err.message).toMatch(/creates LOCAL packages only/);
    expect(err.message).toMatch(/internal routing failure/);
    // The load-bearing half: the refusal happened BEFORE the wire.
    expect(adt.creates).toHaveLength(0);
  });

  /**
   * CTS reports `kind: "local"` for any not-yet-existing package regardless
   * of `corrNr` — this fakes that verdict with a real-shaped corrNr to prove
   * it's never consulted. The OLD hint told callers to pass corr_nr, which
   * this path discards; that regression is what this test guards against.
   */
  it("fails even with a valid corrNr, because CTS reports the not-yet-existing package as local — and says so, not 'pass corr_nr'", async () => {
    const { conn, adt } = await connected(createRoute);

    const trkorr = "A4HK900123";
    const alwaysLocal = new SessionTransport({
      allowTransports: [trkorr],
      cts: { trRequirement: vi.fn(async () => fakeReq({ kind: "local", required: false })) },
    });

    const err = await catchErr(
      createPackage(
        conn,
        await authWrite(conn, { type: "DEVC/K", name: PKG, packageName: PARENT }, gateFor(trkorr)),
        {
          softwareComponent: "HOME",
          transport: alwaysLocal,
          gate: gateFor(trkorr),
          corrNr: trkorr,
        },
      ),
    );

    expect(err.code).toBe("TRANSPORT_ERROR");
    expect(err.message).toMatch(/CTS answers "local"/);
    // This throw was reworded again: now that a non-LOCAL create routes
    // to the classrun bridge before `createPackage` is ever reached, hitting
    // this guard means the router in src/tools/write.ts failed to send it
    // there — an internal routing defect, not something caller-fixable.
    expect(err.message).toMatch(/internal routing failure/);
    // Regression guard: the OLD hint told the caller to pass corr_nr —
    // precisely the value this code path throws away. Must never come back.
    expect(err.hint).not.toContain("corr_nr");
    expect(err.hint).toMatch(/internal routing defect/);
    expect(err.hint).toMatch(/not caused by, and cannot be worked around with, any argument/);
    expect(err.hint).toMatch(/Report it rather than retrying/);
    // The ABAP-recipe guards move to test/package-create.test.ts on this
    // branch: the recipe is no longer prose for the caller to type, it is the
    // ABAP this PR generates, so it is pinned where it is emitted.
    expect(err.hint.toLowerCase()).not.toContain("if_package~");
    // The load-bearing half: the refusal happened BEFORE the wire, corrNr notwithstanding.
    expect(adt.creates).toHaveLength(0);
  });

  it("a LOCAL package needs no transport", async () => {
    const { conn, adt } = await connected(createRoute);

    const res = await createPackage(
      conn,
      await authWrite(conn, { type: "DEVC/K", name: PKG, packageName: PARENT }),
      { softwareComponent: "LOCAL" },
    );

    expect(res.created).toBe(true);
    expect(adt.creates).toHaveLength(1);
    expect(adt.creates[0]!.qs.corrNr).toBeUndefined();
  });

  it("defaults packageType to development and never renders the string 'undefined'", async () => {
    const { conn, adt } = await connected(createRoute);

    const res = await createPackage(
      conn,
      await authWrite(conn, { type: "DEVC/K", name: PKG, packageName: PARENT }),
      { softwareComponent: "LOCAL" },
    );

    expect(res.packageType).toBe("development");
    expect(res.transportLayer).toBe("");

    const body = adt.creates[0]!.body!;
    expect(body).toContain("development");
    // An omitted transport layer must render as an empty attribute. The real
    // transportable package on this appliance carries pak:name="" too
    // (per a live package-detail capture), so "" is not a placeholder.
    expect(body).toContain(`<pak:transportLayer pak:name=""`);
    // The failure mode this guards: template interpolation of an absent value.
    expect(body).not.toContain("undefined");
  });

  it("refuses when the package already exists, and sends NOTHING", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === PKG_URI && r.method === "GET") return resp(200, PACKAGE_XML(PKG), OK_XML);
      if (r.url === PACKAGES && r.method === "POST") return resp(200, "", {});
      return undefined;
    });

    const err = await catchErr(
      createPackage(
        conn,
        await authWrite(conn, { type: "DEVC/K", name: PKG }),
        { softwareComponent: "LOCAL" },
      ),
    );

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain(PKG);
    expect(adt.creates).toHaveLength(0);
  });

  /**
   * The `software_component` guard's OWN hint must not send the caller into
   * the same TR/462 wall the corrNr hint above was fixed to warn about: LOCAL
   * only works for a $-named package, and abapsmith's default Z- and
   * Y-prefixed names (PKG here is "ZSD_ORDER") are never eligible. Pinning
   * on both TR/462 (a stable SAP message code, unlikely to be reworded) and
   * "$-named" (the plain-English reason, already the established pin for
   * this hint class in the corrNr test above) catches a regression to either
   * the old bare "LOCAL for a local one" text or a rewrite that drops the
   * caveat while keeping the message code.
   */
  it("empty software_component: hint does not send the caller into the TR/462 wall", async () => {
    const { conn, adt } = await connected(createRoute);

    const err = await catchErr(
      createPackage(
        conn,
        await authWrite(conn, { type: "DEVC/K", name: PKG, packageName: PARENT }),
        { softwareComponent: "" },
      ),
    );

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toMatch(/software_component/);
    expect(err.hint).toMatch(/HOME/);
    expect(err.hint).toMatch(/TR\/462/);
    expect(err.hint).toMatch(/\$-named/);
    // Regression guard: the old hint told the caller "LOCAL for a local
    // one" with no caveat — a route that SAP refuses for every Z*/Y*-named
    // package abapsmith creates by default.
    expect(err.hint).not.toMatch(/LOCAL for a local one/);
    expect(adt.creates).toHaveLength(0);
  });

  it("refuses a non-package type", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === "/sap/bc/adt/programs/programs/zmcp_rep" && r.method === "GET")
        return resp(404, NOT_FOUND_XML, OK_XML);
      return undefined;
    });

    const err = await catchErr(
      createPackage(
        conn,
        await authWrite(conn, { type: "PROG/P", name: "ZMCP_REP", packageName: "ZPKG" }),
        { softwareComponent: "LOCAL" },
      ),
    );

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toMatch(/only creates DEVC\/K/);
    expect(adt.creates).toHaveLength(0);
  });

  it("writeObject refuses a package — a package has no source", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === PKG_URI && r.method === "GET") return resp(200, PACKAGE_XML(PKG), OK_XML);
      return undefined;
    });

    const err = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "DEVC/K", name: PKG }), { source: "anything" }),
    );

    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).toMatch(/no source/);
    // No PUT, no POST, no lock.
    expect(adt.calls.filter((c) => c.method === "PUT" || c.method === "POST")).toHaveLength(0);
    expect(adt.calls.filter((c) => c.qs._action === "LOCK")).toHaveLength(0);
  });

  // `deleteObject` no longer refuses packages outright — a package IS
  // deletable, through the classrun bridge, when a gate is wired
  // (`opts.gate ?? opts.bridgeGate`). Calling it with `{}` supplies neither,
  // which is now a caller wiring bug (BAD_INPUT), not a policy about
  // packages. See the "via the classrun bridge" describe block below for the
  // gated case.
  it("deleteObject with no gate wired refuses a package delete as a caller wiring bug, before any request", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === PKG_URI && r.method === "GET") return resp(200, PACKAGE_XML(PKG), OK_XML);
      return undefined;
    });

    const target = await authDelete(conn, { type: "DEVC/K", name: PKG });
    const callsBeforeDelete = adt.calls.length;

    const err = await catchErr(deleteObject(conn, target, {}));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toMatch(/opts\.bridgeGate/);
    // This is a caller wiring bug, not a caller-fixable argument — the 5th
    // AbapError argument overrides BAD_INPUT's retryable:true default to false.
    expect(RETRYABILITY["BAD_INPUT"]).toBe("retryable");
    expect(err.retryable).toBe(false);
    // Zero requests of any kind past what resolving the target already
    // cost — the refusal stays entirely pre-network, not just "no LOCK, no
    // DELETE" (the property the original obsoleted test protected).
    expect(adt.calls).toHaveLength(callsBeforeDelete);
    expect(adt.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect(adt.calls.filter((c) => c.qs._action === "LOCK")).toHaveLength(0);
  });

  /**
   * THE design decision of this feature, pinned.
   *
   * A package's package is ITSELF: ADT reports `adtcore:packageRef` = the
   * package itself, with the hierarchy parent in a separate
   * `<pak:superPackage>` element (real captured bytes:
   * per a live package-detail capture). So the caller's `package` argument is
   * the SUPERpackage, and the safety gate — which judges the package an
   * object LANDS IN — must be handed the new package's own name, never its
   * parent's. Gating a package create on its parent would judge the wrong
   * object entirely.
   *
   * This also makes the create branch agree with what `resolveWriteTarget`
   * already returned for an EXISTING package via `parsePackageRef`; before
   * this change only the 404 branch disagreed.
   */
  it("gives a new package its OWN name as packageName and the caller's package as superPackage", async () => {
    const { conn } = await connected((r) => {
      if (r.url === PKG_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      return undefined;
    });

    const t = await resolveWriteTarget(conn, { type: "DEVC/K", name: PKG, packageName: PARENT });

    expect(t.exists).toBe(false);
    expect(t.packageName).toBe(PKG);
    expect(t.superPackage).toBe(PARENT);
    // Not the parent — that is the whole point.
    expect(t.packageName).not.toBe(PARENT);
  });
});

/**
 * `abap_write`'s empty-`software_component` guard is DUPLICATED at the tool
 * layer (`abapCreatePackage` in src/tools/write.ts), ahead of
 * `authorizeMutation`, so it can refuse with zero network requests. That
 * duplicate guard used to carry its own, older hint text — a caller going
 * through the real MCP entry point (`abapWrite`) never saw the corrNr fix
 * above, because `createPackage` was never reached. Every test above this
 * point calls `createPackage` directly and cannot see that: it bypasses the
 * exact layer the shadowing bug lived in. This block calls `abapWrite`
 * instead, the same function the server dispatches `abap_write` to.
 */
describe("abap_write (tool layer) — DEVC/K software_component guard", () => {
  it("empty software_component: refuses with zero requests, and the hint matches createPackage's", async () => {
    const { conn, adt } = await connected(createRoute);

    const err = await catchErr(
      abapWrite(conn, { object: PKG, type: "DEVC/K", package: PARENT }, 20_000, DEFAULT_GATE),
    );

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toMatch(/software_component/);
    expect(err.hint).toMatch(/HOME/);
    expect(err.hint).toMatch(/TR\/462/);
    expect(err.hint).toMatch(/\$-named/);
    // Regression guard: this is the text the tool layer used to carry
    // instead — no TR/462 caveat, and a LOCAL suggestion that fails for
    // every Z*/Y*-named package abapsmith creates by default.
    expect(err.hint).not.toMatch(/Use HOME for a transportable package, LOCAL for a local one\./);
    // The load-bearing half: zero-network refusal, same property the
    // guard has always had — only the wording was wrong.
    expect(adt.creates).toHaveLength(0);
    expect(adt.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deleteObject — DEVC/K via the classrun bridge
// ---------------------------------------------------------------------------
// Reimplements test/package-create.test.ts's bridge-faking pattern locally
// (deploy the generated class, then classrun it) rather than importing it —
// this file may only touch write-package.test.ts.

const DELETE_BRIDGE_CLASS = DDIC_BRIDGE_CLASS.deletePackage;
const CLASSES_COLLECTION = "/sap/bc/adt/oo/classes";
const DELETE_BRIDGE_URI = `${CLASSES_COLLECTION}/${DELETE_BRIDGE_CLASS.toLowerCase()}`;
const DELETE_BRIDGE_SOURCE_URI = `${DELETE_BRIDGE_URI}/source/main`;
const DELETE_BRIDGE_CLASSRUN_URI = `/sap/bc/adt/oo/classrun/${DELETE_BRIDGE_CLASS}`;

const BRIDGE_LOCK_XML =
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

/** The package resolve GET that every deleteObject call pays first. */
const packageExistsRoute: Route = (r) => {
  if (r.url === PKG_URI && r.method === "GET") return resp(200, PACKAGE_XML(PKG), OK_XML);
  return undefined;
};

/** GET-404 → POST-create → LOCK → PUT → UNLOCK → activate for the bridge class itself. */
const bridgeDeployRoute: Route = (r) => {
  if (r.url === DELETE_BRIDGE_URI && r.method === "GET" && !r.qs._action)
    return resp(404, NOT_FOUND_XML, OK_XML);
  if (r.url === CLASSES_COLLECTION && r.method === "POST") return resp(200, "", {});
  if (r.url === DELETE_BRIDGE_URI && r.qs._action === "LOCK") return resp(200, BRIDGE_LOCK_XML, OK_XML);
  if (r.url === DELETE_BRIDGE_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
  if (r.url === DELETE_BRIDGE_SOURCE_URI && r.method === "PUT") return resp(200, "", OK_TEXT);
  if (r.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
  return undefined;
};

/** Classrun executes the deployed bridge class and answers with a transcript body. */
const bridgeClassrunRoute =
  (transcript: string): Route =>
  (r) => {
    if (r.url === DELETE_BRIDGE_CLASSRUN_URI) return resp(200, transcript, OK_TEXT);
    return undefined;
  };

function combineRoutes(...routes: Route[]): Route {
  return (r) => {
    for (const route of routes) {
      const hit = route(r);
      if (hit) return hit;
    }
    return undefined;
  };
}

const SUCCESS_TRANSCRIPT = ["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"].join("\n");

/** Allows both the bridge class's home ($TMP) and the package actually being deleted. */
const bridgeGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [DDIC_BRIDGE_PACKAGE, PKG],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

describe("deleteObject — DEVC/K via the classrun bridge", () => {
  it("deletes an empty package through the bridge, never locking or DELETEing the package's own URI", async () => {
    const gate = bridgeGate();
    const { conn, adt } = await connected(
      combineRoutes(packageExistsRoute, bridgeDeployRoute, bridgeClassrunRoute(SUCCESS_TRANSCRIPT)),
    );

    const res = await deleteObject(conn, await authDelete(conn, { type: "DEVC/K", name: PKG }, gate), {
      onBeforeImage: async () => {},
      bridgeGate: gate,
    });

    expect(res.deleted).toBe(true);
    // A package has no REST delete endpoint and must never be locked — scoped
    // to the package's OWN uri, since deploying the bridge class legitimately
    // locks/PUTs/activates ITSELF as part of the choreography.
    expect(adt.calls.filter((c) => c.url === PKG_URI && c.method === "DELETE")).toHaveLength(0);
    expect(adt.calls.filter((c) => c.url === PKG_URI && c.qs._action === "LOCK")).toHaveLength(0);
    // The classrun bridge endpoints WERE hit.
    expect(adt.calls.some((c) => c.url === DELETE_BRIDGE_CLASSRUN_URI)).toBe(true);
    expect(adt.calls.some((c) => c.url === DELETE_BRIDGE_SOURCE_URI && c.method === "PUT")).toBe(true);
  });

  // The whole reason `bridgeGate` exists (see its doc comment on
  // `DeleteOptions`): a LOCAL package delete and the undo path have no
  // `SessionTransport`, so `TransportOptions.gate` is `undefined` by
  // construction. Pin that `{ onBeforeImage, bridgeGate }` alone — no
  // transport, no `opts.gate` — is sufficient for the delete to go through.
  it("bridgeGate alone is sufficient with no transport manager wired", async () => {
    const gate = bridgeGate();
    const { conn, adt } = await connected(
      combineRoutes(packageExistsRoute, bridgeDeployRoute, bridgeClassrunRoute(SUCCESS_TRANSCRIPT)),
    );

    const target = await authDelete(conn, { type: "DEVC/K", name: PKG }, gate);
    const res = await deleteObject(conn, target, { onBeforeImage: async () => {}, bridgeGate: gate });

    expect(res.deleted).toBe(true);
    expect(adt.calls.some((c) => c.url === DELETE_BRIDGE_CLASSRUN_URI)).toBe(true);
  });

  it("records an honest before-image: fires before any bridge request, reports the package as having existed", async () => {
    const gate = bridgeGate();
    const { conn, adt } = await connected(
      combineRoutes(packageExistsRoute, bridgeDeployRoute, bridgeClassrunRoute(SUCCESS_TRANSCRIPT)),
    );

    let firedAtCallCount = -1;
    let seenExisted: boolean | undefined;
    const onBeforeImage = async (img: { existed: boolean }): Promise<void> => {
      firedAtCallCount = adt.calls.length;
      seenExisted = img.existed;
    };

    await deleteObject(conn, await authDelete(conn, { type: "DEVC/K", name: PKG }, gate), {
      onBeforeImage,
      bridgeGate: gate,
    });

    expect(seenExisted).toBe(true);
    expect(firedAtCallCount).toBeGreaterThanOrEqual(0);
    // Nothing bridge-related was requested yet at the moment the hook ran.
    const beforeHook = adt.calls.slice(0, firedAtCallCount);
    expect(beforeHook.some((c) => c.url.startsWith(CLASSES_COLLECTION))).toBe(false);
    expect(beforeHook.some((c) => c.url === DELETE_BRIDGE_CLASSRUN_URI)).toBe(false);
  });

  it("a non-empty package's refusal reaches deleteObject's caller unwrapped, naming its contents", async () => {
    const gate = bridgeGate();
    const contentTranscript = `${PKG_CONTENT_PREFIX} KIND=OBJECT PGMID=R3TR OBJECT=PROG NAME=ZFOO`;
    const { conn } = await connected(
      combineRoutes(packageExistsRoute, bridgeDeployRoute, bridgeClassrunRoute(contentTranscript)),
    );

    const err = await catchErr(
      deleteObject(conn, await authDelete(conn, { type: "DEVC/K", name: PKG }, gate), {
        onBeforeImage: async () => {},
        bridgeGate: gate,
      }),
    );

    // The bridge's own CHECK_FAILED, not something deleteObject re-wraps.
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toMatch(/is not empty and was NOT deleted/);
    expect(err.message).toContain("ZFOO");
  });

  it("a refusing bridgeGate refuses a package delete with ZERO requests", async () => {
    // The narrow gate below is passed ONLY as bridgeGate — authDelete uses
    // the wide one to resolve/authorize normally. Isolates what's under
    // test: deleteObject's DEVC/K branch must consult bridgeGate before any
    // network call.
    const { conn, adt } = await connected(packageExistsRoute);
    const target = await authDelete(conn, { type: "DEVC/K", name: PKG }, bridgeGate());
    const callsAfterResolve = adt.calls.length;

    // Allowlist covers the bridge's own home, deliberately NOT the package
    // being deleted — the whole point being tested.
    const refusingGate = new SafetyGate({
      readOnly: false,
      allowPackages: [DDIC_BRIDGE_PACKAGE],
      allowTransports: ["*"],
      writesLockedOut: false,
    });

    // A refusal must leave no trace: no CTS transportchecks round trip, no
    // bridge class deployed into $TMP. Nothing else is routed above, so any
    // stray request would throw "unrouted", not silently succeed.
    const err = await catchErr(
      deleteObject(conn, target, { onBeforeImage: async () => {}, bridgeGate: refusingGate }),
    );

    expect(err.code).toBe("SAFETY_DENIED");
    expect(adt.calls.length).toBe(callsAfterResolve);
  });

  it("judges the delete as a \"delete\", not a \"write\" — a read-only bridgeGate refuses it too, with ZERO requests", async () => {
    const { conn, adt } = await connected(packageExistsRoute);
    const target = await authDelete(conn, { type: "DEVC/K", name: PKG }, bridgeGate());
    const callsAfterResolve = adt.calls.length;

    const readOnlyGate = new SafetyGate({ readOnly: true, allowPackages: ["*"] });

    const err = await catchErr(
      deleteObject(conn, target, { onBeforeImage: async () => {}, bridgeGate: readOnlyGate }),
    );

    // READ_ONLY not SAFETY_DENIED — readOnly short-circuits before the
    // allowlist check (src/safety.ts's own taxonomy). The real pin is
    // `details.operation === "delete"`: proof assertBridgeMutation's op
    // reached the gate instead of silently defaulting to "write".
    expect(err.code).toBe("READ_ONLY");
    expect(err.details?.operation).toBe("delete");
    expect(adt.calls.length).toBe(callsAfterResolve);
  });

  // Live finding: with ABAP_ALLOW_TRANSPORTS='A4HK900230' and an
  // explicit corr_nr:"A4HK900230" the delete was refused with
  // "Transport auto is not permitted by ABAP_ALLOW_TRANSPORTS [A4HK900230]"
  // — the pre-resolution gate at src/adt/write.ts's DEVC/K delete branch
  // passed no `corr`, so safety.ts synthesised its own default
  // `{kind:"transport", corrNr:"auto"}` and judged the literal placeholder
  // instead of the transport the caller actually named. The fix threads
  // `corr: {kind:"unresolved"}` so that gate defers to the real check
  // (preflightCorr's own gate.assert, and deletePackageViaBridge's second
  // gate) instead of guessing. This test would have thrown SAFETY_DENIED
  // ("Transport auto...") before the fix.
  it("a DEVC/K delete with an explicit corr_nr matching ABAP_ALLOW_TRANSPORTS is not refused by the pre-resolution gate", async () => {
    const trkorr = "A4HK900230";
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: [PKG, DDIC_BRIDGE_PACKAGE],
      allowTransports: [trkorr],
    });
    const { conn, adt } = await connected(
      combineRoutes(packageExistsRoute, bridgeDeployRoute, bridgeClassrunRoute(SUCCESS_TRANSCRIPT)),
    );

    const target = await authDelete(conn, { type: "DEVC/K", name: PKG }, gate);
    const res = await deleteObject(conn, target, {
      onBeforeImage: async () => {},
      transport: pinnedTo(trkorr),
      gate,
      corrNr: trkorr,
    });

    expect(res.deleted).toBe(true);
    expect(adt.calls.some((c) => c.url === DELETE_BRIDGE_CLASSRUN_URI)).toBe(true);
  });

  // Regression guard for the property that must NOT be lost while fixing the
  // above: a deny-all allowlist is decidable with no corr at all, so it must
  // still refuse the pre-resolution gate before any request — this is the
  // zero-network fail-closed behaviour `corr: {kind:"unresolved"}` must
  // preserve (src/safety.ts step 10, `allowTransports.length === 0`).
  it("regression: an EMPTY ABAP_ALLOW_TRANSPORTS still refuses a DEVC/K delete's pre-resolution gate, with ZERO network requests", async () => {
    const { conn, adt } = await connected(packageExistsRoute);
    const target = await authDelete(conn, { type: "DEVC/K", name: PKG }, bridgeGate());
    const callsAfterResolve = adt.calls.length;

    const denyAllGate = new SafetyGate({
      readOnly: false,
      allowPackages: [PKG],
      allowTransports: [],
    });

    const err = await catchErr(
      deleteObject(conn, target, { onBeforeImage: async () => {}, bridgeGate: denyAllGate }),
    );

    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toMatch(/ABAP_ALLOW_TRANSPORTS is explicitly empty/);
    expect(adt.calls.length).toBe(callsAfterResolve);
  });

  // A package has no source, so `captureOf` (src/tools/write.ts)
  // records `beforeCapture: "failed"` for it — the delete response must not
  // then claim `abap_journal mode=undo` "re-creates the object from it". This
  // pins WHICH note is emitted for beforeCapture="failed"; it asserts nothing
  // about whether an undo would actually work (that is undo's own test suite).
  it("a DEVC/K delete's note says the journal entry cannot restore it, not that undo re-creates the object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abapsmith-pkg-delete-journal-"));
    try {
      const journal = new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H");
      const gate = bridgeGate();
      const { conn } = await connected(
        combineRoutes(packageExistsRoute, bridgeDeployRoute, bridgeClassrunRoute(SUCCESS_TRANSCRIPT)),
      );

      const res = await abapWrite(conn, { object: PKG, type: "DEVC/K", mode: "delete" }, 20_000, gate, journal);

      expect(res.text).toMatch(/^deleted: true$/m);
      expect(res.text).toContain("CANNOT restore it from this entry");
      expect(res.text).not.toContain("re-creates the object from it");

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.beforeCapture).toBe("failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // `deleteObject` used to discard the resolved transport —
  // the response carried no `transport:` line at all, and gave no signal
  // that a live A4H delete naming a transport was NOT actually recorded into
  // it. This pins the header text AND the honesty note's wording for a
  // resolved transport; it asserts nothing about whether CTS recording
  // "really" works — only which string this code emits when the gate
  // resolves `status: "transport"` for a package delete.
  it("a transportable DEVC/K delete's header names the resolved corrNr, and the note warns it was NOT observed to be recorded there", async () => {
    const trkorr = "A4HK900230";
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: [PKG, DDIC_BRIDGE_PACKAGE],
      allowTransports: [trkorr],
    });
    const { conn } = await connected(
      combineRoutes(packageExistsRoute, bridgeDeployRoute, bridgeClassrunRoute(SUCCESS_TRANSCRIPT)),
    );

    const res = await abapWrite(
      conn,
      { object: PKG, type: "DEVC/K", mode: "delete", corr_nr: trkorr },
      20_000,
      gate,
      undefined,
      pinnedTo(trkorr),
    );

    expect(res.text).toMatch(/^deleted: true$/m);
    expect(res.text).toMatch(new RegExp(`^transport: ${trkorr}$`, "m"));
    expect(res.text).toContain(`observed to NOT record the deletion into ${trkorr}`);
    // Never claim the opposite while making this claim.
    expect(res.text).not.toContain("abapsmith did NOT re-read the request to confirm");
  });

  // Same defect, the other status `deleteObject` can now report: CTS says
  // the package delete is local (no transport at all), which must render the
  // ordinary local header/note, NOT the package-specific "was not recorded"
  // warning — that warning is only true of a REAL resolved transport.
  it("a LOCAL DEVC/K delete's header says none, and does NOT carry the transport-not-recorded warning", async () => {
    const alwaysLocal = new SessionTransport({
      allowTransports: ["*"],
      cts: { trRequirement: vi.fn(async () => fakeReq({ kind: "local", required: false })) },
    });
    const gate = bridgeGate();
    const { conn } = await connected(
      combineRoutes(packageExistsRoute, bridgeDeployRoute, bridgeClassrunRoute(SUCCESS_TRANSCRIPT)),
    );

    const res = await abapWrite(
      conn,
      { object: PKG, type: "DEVC/K", mode: "delete" },
      20_000,
      gate,
      undefined,
      alwaysLocal,
    );

    expect(res.text).toMatch(/^deleted: true$/m);
    expect(res.text).toMatch(/^transport: none \(\$TMP\/local\)$/m);
    expect(res.text).not.toContain("was NOT record");
    expect(res.text).not.toContain("observed to NOT record");
  });

  // A successful package delete used to carry no `markers:` line at
  // all, so PKG-EMPTY/PKG-DELETED/PKG-GONE were only recoverable from a raw
  // transcript on failure. `deleteObject` now threads `bridgeRes.transcript
  // .tags` through, and this pins the header line in the same
  // `markers: <tag> <tag> ...` shape the package-create response already
  // uses (src/tools/write.ts ~line 2254).
  it("a successful DEVC/K delete's response carries a markers line naming the transcript tags", async () => {
    const gate = bridgeGate();
    const { conn } = await connected(
      combineRoutes(packageExistsRoute, bridgeDeployRoute, bridgeClassrunRoute(SUCCESS_TRANSCRIPT)),
    );

    const res = await abapWrite(conn, { object: PKG, type: "DEVC/K", mode: "delete" }, 20_000, gate);

    expect(res.text).toMatch(/^deleted: true$/m);
    expect(res.text).toMatch(/^markers: PKG-EMPTY PKG-DELETED PKG-GONE$/m);
  });

  // The markers line alone doesn't tell the operator that `deleted:
  // true` on THIS route is evidenced by PKG-GONE, not a hardcoded literal
  // like the ordinary REST delete — the note ties the two together.
  it("the delete note ties `deleted: true` to PKG-GONE, not just a clean return", async () => {
    const gate = bridgeGate();
    const { conn } = await connected(
      combineRoutes(packageExistsRoute, bridgeDeployRoute, bridgeClassrunRoute(SUCCESS_TRANSCRIPT)),
    );

    const res = await abapWrite(conn, { object: PKG, type: "DEVC/K", mode: "delete" }, 20_000, gate);

    expect(res.text).toMatch(/^deleted: true$/m);
    expect(res.text).toMatch(/^markers: PKG-EMPTY PKG-DELETED PKG-GONE$/m);
    expect(res.text).toContain("backed by PKG-GONE");
  });

  // Negative case: `markers` exists only for the classrun-bridge package
  // route — an ordinary delete must carry none; pins it off other types.
  it("negative case: deleteObject's return for a non-package (PROG/P) delete has markers undefined", async () => {
    const uri = "/sap/bc/adt/programs/programs/zmcp_rep";
    const src = `${uri}/source/main`;
    const objectXml =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
      `adtcore:name="ZMCP_REP" adtcore:type="PROG/P">` +
      `<adtcore:packageRef adtcore:name="$TMP"/>` +
      `</adtcore:objectMetadata>`;
    const { conn } = await connected((r) => {
      if (r.url === uri && r.method === "GET") return resp(200, objectXml, OK_XML);
      if (r.url === src && r.method === "GET") return resp(200, "REPORT zmcp_rep.", OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, BRIDGE_LOCK_XML, OK_XML);
      if (r.method === "DELETE") return resp(200, "", {});
      return undefined;
    });

    const res = await deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: "ZMCP_REP" }));

    // deleted is tri-state, not this test's subject: this static
    // fixture can't settle either verification probe, so it's "unverified".
    expect(res.deleted).toBe("unverified");
    expect(res.markers).toBeUndefined();
  });
});
