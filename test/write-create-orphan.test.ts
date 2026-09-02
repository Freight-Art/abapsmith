/**
 * A LOCK (or any post-create step) that fails right after
 * `createNewObject`'s POST used to look like a clean, unremarkable failure —
 * `ADT_ERROR` / `details.operation === "lock"` — with no hint that the
 * create had already landed. A live incident (a gateway intermittently
 * answering a non-ADT HTML 400 instead of an ADT response) turned that into
 * six stranded objects: each retry under the same name created another one.
 *
 * This file pins `reportCreateOrphan` (src/adt/write.ts) and the
 * `verifyObjectPresent` probe it calls (src/adt/write-verify.ts): the create
 * POST landing, then the LOCK dying on a non-ADT HTML 400, must produce an
 * error that says whether the object is still there and must never let the
 * caller retry blind.
 *
 * Harness copied from test/write.test.ts (FakeAdt / connected / resp /
 * LOCK_XML / OBJECT_XML / authWrite / catchErr) rather than the
 * FakeAdtServer harness in test/write-verify.test.ts — that harness verifies
 * write-verify.ts's probes in isolation; this file needs a full
 * writeObject() round trip through a stateful session, which is what
 * write.test.ts's fake already drives.
 */
import { describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "../src/adt/connection.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { authorizeMutation, writeObject } from "../src/adt/write.js";
import { SafetyGate } from "../src/safety.js";
import { searchResultsXml } from "./helpers/fake-adt.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const REPORT = "ZMCP_TEST_REP";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_test_rep";
const REPORT_SRC = `${REPORT_URI}/source/main`;
const SOURCE_A = "REPORT zmcp_test_rep.\nWRITE: / 'a'.\n";

const DEFAULT_GATE = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
const authWrite = (conn: AbapConnection) =>
  authorizeMutation(conn, DEFAULT_GATE, "write", { type: "PROG/P", name: REPORT });

const LOCK_XML = (handle = "H1", isLocal = "X", corrNr = "") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>${isLocal}</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">${REPORT} does not exist</message><properties/></exc:exception>`;

/** The live incident's actual symptom: a gateway 400 that is not ADT XML at all. */
const NON_ADT_HTML_400 = "<html><body><h1>400 Bad Request</h1></body></html>";

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

const OBJECT_XML = (name: string, type: string, packageName = "$TMP"): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${name}" adtcore:type="${type}">` +
  `<adtcore:packageRef adtcore:name="${packageName}"/>` +
  `</adtcore:objectMetadata>`;

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

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

/**
 * The shared shape of the first four scenarios: an object that does not
 * exist yet, a create POST that succeeds, and a LOCK that dies on a non-ADT
 * HTML 400 — the live incident's exact wire shape. `readBack` and `search`
 * layer the read-back / repository-search answers for each scenario on top.
 */
const createThenLockFails = (readBack: Route, search: Route): Route => (r) => {
  if (r.url === REPORT_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
  if (r.url === "/sap/bc/adt/programs/programs" && r.method === "POST") return resp(200, "", {});
  if (r.qs._action === "LOCK") return resp(400, NON_ADT_HTML_400, { "content-type": "text/html" });
  return search(r) ?? readBack(r);
};

const readBack200: Route = (r) => (r.url === REPORT_SRC && r.method === "GET" ? resp(200, SOURCE_A, OK_TEXT) : undefined);
const readBack404: Route = (r) => (r.url === REPORT_SRC && r.method === "GET" ? resp(404, NOT_FOUND_XML, OK_XML) : undefined);
const readBackHtml400: Route = (r) =>
  r.url === REPORT_SRC && r.method === "GET" ? resp(400, NON_ADT_HTML_400, { "content-type": "text/html" }) : undefined;

const searchFinds = (found: boolean): Route => (r) =>
  r.url.endsWith("/repository/informationsystem/search")
    ? resp(200, searchResultsXml(found ? [{ name: REPORT, type: "PROG/P", uri: REPORT_URI }] : []), OK_XML)
    : undefined;
const searchFails: Route = (r) =>
  r.url.endsWith("/repository/informationsystem/search") ? resp(500, "<exc:exception/>", OK_XML) : undefined;

describe("writeObject — create-orphan reporting on a post-create LOCK failure", () => {
  // Scenario 1: red on base because writeObject's unguarded
  // `session.lock(lockUri(t))` just rethrows the translated LOCK error as-is
  // — on base, `details.created` does not exist at all.
  it("LOCK fails after create, read-back confirms presence: reports created + confirmed, tells caller not to retry", async () => {
    const { conn, adt } = await connected(createThenLockFails(readBack200, () => undefined));
    const e = await catchErr(writeObject(conn, await authWrite(conn), { source: SOURCE_A }));

    expect(e.details.created).toBe(true);
    expect(e.details.objectExists).toBe(true);
    const verification = e.details.verification as { status: string; via: string };
    expect(verification.status).toBe("confirmed");
    expect(verification.via).toBe("read-back");
    expect(e.message).toMatch(/do not retry/i);
    // The original LOCK failure survives underneath the new reporting.
    expect(e.code).toBe("ADT_ERROR");
    expect(e.details.operation).toBe("lock");
    expect(e.hint).toMatch(/abap_journal/);
    expect(e.hint).toMatch(/mode=undo/);

    expect(adt.labels).toContain(`GET ${REPORT_SRC}`);
  });

  // Scenario 2: two negative probes (404 read-back, zero-hit search) still
  // must not be reported as absence — a search miss is not proof either.
  it("LOCK fails after create, read-back 404 and search finds nothing: reports unverified, undo hint still offered", async () => {
    const { conn } = await connected(createThenLockFails(readBack404, searchFinds(false)));
    const e = await catchErr(writeObject(conn, await authWrite(conn), { source: SOURCE_A }));

    expect(e.details.created).toBe(true);
    expect(e.details.objectExists).toBe("unverified");
    const verification = e.details.verification as { status: string; reason: string };
    expect(verification.status).toBe("indeterminate");
    expect(verification.reason).toEqual(expect.any(String));
    expect(verification.reason.length).toBeGreaterThan(0);
    expect(verification.reason).toMatch(/search/i);
    expect(e.message).not.toMatch(/may (still |)exist/i);
    expect(e.hint).toMatch(/abap_journal/);
    expect(e.hint).toMatch(/mode=undo/);
  });

  // Scenario 3: red on base for the same reason, AND this is the exact wire
  // shape of the live incident (create landed with a skeleton, content URI
  // 404s, repository search finds the TADIR entry) — base has no way to
  // distinguish this from "nothing happened".
  it("LOCK fails after create, read-back 404 but search DOES find it: reports confirmed present via repository-search, still says do not retry", async () => {
    const { conn } = await connected(createThenLockFails(readBack404, searchFinds(true)));
    const e = await catchErr(writeObject(conn, await authWrite(conn), { source: SOURCE_A }));

    expect(e.details.created).toBe(true);
    expect(e.details.objectExists).toBe(true);
    const verification = e.details.verification as { status: string; via: string };
    expect(verification.status).toBe("confirmed");
    expect(verification.via).toBe("repository-search");
    expect(e.message).toMatch(/do not retry/i);
  });

  // Scenario 4: red on base because base has neither `details.created` nor
  // any verification attempt — and this pins that a verification failure
  // must not swallow the caller's real (original) error.
  it("LOCK fails after create, BOTH read-back and search fail: reports unverified, original error still recoverable", async () => {
    const { conn } = await connected(createThenLockFails(readBackHtml400, searchFails));
    const e = await catchErr(writeObject(conn, await authWrite(conn), { source: SOURCE_A }));

    expect(e.details.created).toBe(true);
    expect(e.details.objectExists).toBe("unverified");
    // The ORIGINAL lock failure must still be readable underneath the new
    // reporting layer, not replaced by a verification-failure message.
    expect(e.code).toBe("ADT_ERROR");
    expect(e.details.operation).toBe("lock");
  });

  // Scenario 5: green on unmodified base by construction — the update path
  // never touches the `!created` branch. It guards a regression where the
  // `throw created ? ... : e` guard fires, or adds a request, on an update.
  it("update path (object already exists): a LOCK failure passes through completely unchanged, no created key, no extra requests", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_URI && r.method === "GET") return resp(200, OBJECT_XML(REPORT, "PROG/P"), OK_XML);
      // Pre-lock source-compare read: a genuinely different source, so this
      // is not short-circuited as a no-op write before the LOCK is even tried.
      if (r.url === REPORT_SRC && r.method === "GET") return resp(200, "REPORT zmcp_test_rep.\nWRITE: / 'old'.\n", OK_TEXT);
      if (r.qs._action === "LOCK") return resp(400, NON_ADT_HTML_400, { "content-type": "text/html" });
      return undefined;
    });
    const e = await catchErr(writeObject(conn, await authWrite(conn), { source: SOURCE_A }));

    expect(e.details.created).toBeUndefined();
    expect(e.code).toBe("ADT_ERROR");
    expect(e.details.operation).toBe("lock");
    // Resolution GET, the pre-lock source-compare GET, then the failed LOCK
    // — that's writeObject's own traffic. (A background session-revival GET
    // of /compatibility/graph can trail asynchronously after the LOCK
    // failure regardless of `created` — pre-existing connection.ts
    // behaviour, unrelated to this guard — so this checks a prefix rather
    // than the full call list.) The invariant this guard must not break:
    // no content read-back, no repository search.
    expect(adt.labels.slice(0, 3)).toEqual([`GET ${REPORT_URI}`, `GET ${REPORT_SRC}`, `LOCK ${REPORT_URI}`]);
    expect(adt.labels.some((l) => l.endsWith("/repository/informationsystem/search"))).toBe(false);
    expect(adt.calls.filter((c) => c.url === REPORT_SRC).length).toBe(1);
  });

  // Scenario 6: green on unmodified base by construction — nothing on the
  // healthy path calls the new guard. It guards a regression where a
  // verification round trip leaks onto the healthy create path.
  it("fully healthy create -> lock -> PUT -> unlock: unchanged result, no verification requests issued", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/programs/programs" && r.method === "POST") return resp(200, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === REPORT_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    });

    const res = await writeObject(conn, await authWrite(conn), { source: SOURCE_A });

    expect(res.created).toBe(true);
    expect(res.changed).toBe(true);
    expect(adt.labels).toEqual([
      `GET ${REPORT_URI}`,
      "POST /sap/bc/adt/programs/programs",
      `LOCK ${REPORT_URI}`,
      `PUT ${REPORT_SRC}`,
      `UNLOCK ${REPORT_URI}`,
    ]);
    expect(adt.labels.some((l) => l.endsWith("/repository/informationsystem/search"))).toBe(false);
  });
});
