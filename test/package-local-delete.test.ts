/**
 * Pins the LOCAL-package wire shape (A4H, 2026-09-04): a `$`-named `DEVC/K`
 * reads back with an empty `<pak:superPackage/>` and NO `<adtcore:packageRef>`
 * element at all. `test/write-package.test.ts` and `test/undo.test.ts` both
 * build package metadata WITH a self-referencing `packageRef`, so neither
 * exercises this shape through the full delete/undo pipeline — only
 * `test/write.test.ts`'s `resolveWriteTarget`-level unit test does. This file
 * drives the real entry points (`deleteObject`, `planUndo`/`performUndo`)
 * offline, with a fake `HttpClient`, same harness idiom as those two files.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { Journal, type JournalConfig } from "../src/journal.js";
import { authorizeMutation, deleteObject, type WriteTarget } from "../src/adt/write.js";
import { planUndo, performUndo, type UndoOptions } from "../src/adt/undo.js";
import { SafetyGate } from "../src/safety.js";
import { DDIC_BRIDGE_CLASS, DDIC_BRIDGE_PACKAGE } from "../src/adt/ddic-bridge.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { searchResultsXml, type FakeObjectRef } from "./helpers/fake-adt.js";

const PKG = "$ZTMD_LOCAL_01";
const PKG_URI = "/sap/bc/adt/packages/%24ztmd_local_01";
const TAB = "ZTMD_LOCAL_TAB";
const TAB_URI = "/sap/bc/adt/ddic/tables/ztmd_local_tab";

const NOT_FOUND_XML = (name: string): string =>
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
  `<message lang="EN">${name} does not exist</message><properties/></exc:exception>`;

/**
 * The exact live shape: no `<adtcore:packageRef>` element anywhere, and an
 * EMPTY `<pak:superPackage/>` — a root local package is its own package.
 */
const PACKAGE_XML = (name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" adtcore:type="DEVC/K">` +
  `<pak:attributes packageType="development"/>` +
  `<pak:superPackage/>` +
  `</pak:package>`;

/** A non-package object whose metadata GET also carries no `adtcore:packageRef` — must stay refused. */
const OBJECT_XML_NO_PACKAGE_REF =
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${TAB}" adtcore:type="TABL/DT"/>`;

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

type Route = (r: Recorded) => HttpClientResponse | undefined;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse => ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

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

function combineRoutes(...routes: Route[]): Route {
  return (r) => {
    for (const route of routes) {
      const hit = route(r);
      if (hit) return hit;
    }
    return undefined;
  };
}

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

/**
 * `allowNamePrefixes: ["*"]` is required here — a bare `SafetyGate` defaults
 * to `DEFAULT_NAME_PREFIXES = ["Z","Y"]` (src/safety.ts), which refuses a
 * `$`-prefixed name on the object-name allowlist rule before the guard under
 * test is ever reached. Production resolves an unset `ABAP_ALLOW_NAME_PREFIXES`
 * to `["*"]`, so this is the faithful default, not a loosened one.
 */
const bridgeGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [DDIC_BRIDGE_PACKAGE, PKG],
    allowNamePrefixes: ["*"],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

const authDelete = (conn: AbapConnection, target: WriteTarget, gate: SafetyGate) =>
  authorizeMutation(conn, gate, "delete", target);

// Bridge deploy/run routes, same choreography as test/write-package.test.ts's DEVC/K bridge-delete block.

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

const SUCCESS_TRANSCRIPT = ["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"].join("\n");

/** The package resolve GET that every deleteObject/authorizeMutation call pays first. */
const packageExistsRoute: Route = (r) => {
  if (r.url === PKG_URI && r.method === "GET") return resp(200, PACKAGE_XML(PKG), OK_XML);
  return undefined;
};

/**
 * `planUndo`'s existence probe for a DEVC/K entry uses repository search, not
 * a content GET to the packages URI (see test/undo.test.ts's "undo-of-create
 * probe: DEVC/K package existence" block) — needed here for (B) so the plan
 * settles `currentlyExists: true` rather than "could not be determined".
 */
const SEARCH_PATH = "/sap/bc/adt/repository/informationsystem/search";
const pkgRef: FakeObjectRef = { name: PKG, type: "DEVC/K", uri: PKG_URI, packageName: PKG };
const searchExistsRoute: Route = (r) => {
  if (r.url === SEARCH_PATH) return resp(200, searchResultsXml([pkgRef]), OK_XML);
  return undefined;
};

/** GET-404 → POST-create → LOCK → PUT → UNLOCK → activate for the bridge class itself. */
const bridgeDeployRoute: Route = (r) => {
  if (r.url === DELETE_BRIDGE_URI && r.method === "GET" && !r.qs._action)
    return resp(404, NOT_FOUND_XML(DELETE_BRIDGE_CLASS), OK_XML);
  if (r.url === CLASSES_COLLECTION && r.method === "POST") return resp(200, "", {});
  if (r.url === DELETE_BRIDGE_URI && r.qs._action === "LOCK") return resp(200, BRIDGE_LOCK_XML, OK_XML);
  if (r.url === DELETE_BRIDGE_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
  if (r.url === DELETE_BRIDGE_SOURCE_URI && r.method === "PUT") return resp(200, "", OK_TEXT);
  if (r.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
  return undefined;
};

const bridgeClassrunRoute =
  (transcript: string): Route =>
  (r) => {
    if (r.url === DELETE_BRIDGE_CLASSRUN_URI) return resp(200, transcript, OK_TEXT);
    return undefined;
  };

let dir: string;
let journal: Journal;

const jcfg = (): JournalConfig => ({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "abap-local-pkg-delete-"));
  journal = new Journal(jcfg(), "A4H");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("local ($) DEVC/K package delete: no adtcore:packageRef at all, empty pak:superPackage", () => {
  it("(A) deletes the package through the classrun bridge, never locking or DELETEing the package's own URI", async () => {
    const gate = bridgeGate();
    const { conn, adt } = await connected(
      combineRoutes(packageExistsRoute, bridgeDeployRoute, bridgeClassrunRoute(SUCCESS_TRANSCRIPT)),
    );

    const target = await authDelete(conn, { type: "DEVC/K", name: PKG }, gate);
    const res = await deleteObject(conn, target, {
      onBeforeImage: async () => {},
      bridgeGate: gate,
    });

    expect(res.deleted).toBe(true);
    // The package's own URI is never locked or DELETEd — the whole
    // operation goes through the classrun bridge instead.
    expect(adt.calls.filter((c) => c.url === PKG_URI && c.method === "DELETE")).toHaveLength(0);
    expect(adt.calls.filter((c) => c.url === PKG_URI && c.qs._action === "LOCK")).toHaveLength(0);
    expect(adt.calls.some((c) => c.url === DELETE_BRIDGE_CLASSRUN_URI)).toBe(true);
    expect(adt.calls.some((c) => c.url === DELETE_BRIDGE_SOURCE_URI && c.method === "PUT")).toBe(true);
  });

  it("(B) undo of the create journal entry plans and performs a real delete through the bridge", async () => {
    const gate = bridgeGate();
    const { conn, adt } = await connected(
      combineRoutes(
        packageExistsRoute,
        searchExistsRoute,
        bridgeDeployRoute,
        bridgeClassrunRoute(SUCCESS_TRANSCRIPT),
      ),
    );

    const e = await journal.begin({
      operation: "create",
      object: { name: PKG, type: "DEVC/K", uri: PKG_URI, package: PKG },
      existedBefore: false,
      beforeCapture: "confirmed-absent",
      afterSource: PACKAGE_XML(PKG),
    });
    expect(e).toBeDefined();
    expect(e!.irreversible).toBeUndefined();
    await journal.finish(e!.id, { outcome: "succeeded" });

    const entry = (await journal.get(e!.id))!;
    const plan = await planUndo(conn, journal, entry);
    expect(plan.action).toBe("delete");
    expect(plan.undoable).toBe(true);
    expect(plan.blocker).toBeUndefined();

    const allow: UndoOptions = {
      assertAllowed: (action, target) => gate.authorize(action === "delete" ? "delete" : "write", target),
      gate,
    };
    const res = await performUndo(conn, journal, entry, allow);

    expect(res.performed).toBe(true);
    expect(res.plan.action).toBe("delete");
    expect(adt.calls.some((c) => c.url === DELETE_BRIDGE_CLASSRUN_URI)).toBe(true);
    expect(adt.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect((await journal.get(e!.id))!.undoneBy).toBeDefined();
  });

  it("(C) fail-closed companion: a TABL/DT with the same missing-packageRef shape is still refused, PACKAGE_UNKNOWN", async () => {
    // Proves the CREATE_ONLY carve-out (src/adt/write.ts) did not open a hole
    // for every type — only a package is its own package. Same end-to-end
    // entry point as (A): authorizeMutation -> resolveWriteTarget, which must
    // throw before any bridge/DELETE request is made.
    const gate = bridgeGate();
    const { conn, adt } = await connected((r) =>
      r.url === TAB_URI && r.method === "GET" ? resp(200, OBJECT_XML_NO_PACKAGE_REF, OK_XML) : undefined,
    );

    const err = await catchErr(authDelete(conn, { type: "TABL/DT", name: TAB }, gate));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details.reason).toBe("PACKAGE_UNKNOWN");
    expect(adt.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
