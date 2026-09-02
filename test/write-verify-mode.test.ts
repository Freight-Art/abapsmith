/**
 * `ABAP_VERIFY_WRITES` / per-call `verify` — offline, with a fake `HttpClient`
 * injected through `ConnectionOptions.httpClient`. Nothing here touches a
 * real SAP system.
 *
 * Harness follows `test/write.test.ts`'s conventions (`FakeAdt`/`connected`/
 * `resp`), rebuilt locally since that file keeps its helpers private to
 * itself.
 *
 * What this file pins:
 *  - `speculative` (the default) issues NO extra read-back after a
 *    successful write.
 *  - `verified` (server-configured, or a per-call `verify:true`) issues
 *    exactly one extra read-back and reports what it found.
 *  - The mode is raise-only: `verify:false` cannot lower a server
 *    configured `"verified"` back to `"speculative"`.
 *  - A `verified` read-back that cannot confirm the object does NOT retract
 *    the reported success — it only adds a warning note.
 *  - `verify` alongside `objects` (batch delete) is a stray top-level field,
 *    same as every other single-object field.
 */
import { describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { objectMetadataXml, searchResultsXml } from "./helpers/fake-adt.js";

const REPORT = "ZMCP_VERIFY_TEST_REP";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_verify_test_rep";
const REPORT_SRC = `${REPORT_URI}/source/main`;

const SOURCE_A = "REPORT zmcp_verify_test_rep.\nWRITE: / 'a'.\n";
const SOURCE_B = "REPORT zmcp_verify_test_rep.\nWRITE: / 'b'.\n";

const LOCK_XML = `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/>` +
  `<MODIFICATION_SUPPORT/></DATA></asx:values></asx:abap>`;

const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">${REPORT} does not exist</message><properties/></exc:exception>`;

const CLEAN_CHECKRUN = `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`;

interface Recorded {
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

type Route = (r: Recorded) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
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

/** Everything `connect()` needs, including the T000 non-productive probe. */
function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
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

const DEFAULT_GATE = new SafetyGate({ readOnly: false, allowPackages: ["*"] });

/**
 * A full write+checkrun+activation cycle for an EXISTING report, with an
 * optional post-activation confirm/deny of the read-back
 * `verifyObjectPresent` issues in verified mode.
 *
 *  - `confirm: true` (default) — the source GET keeps answering with the
 *    current content forever, so any read-back (including the extra one
 *    verified mode adds) finds the object.
 *  - `confirm: false` — once the ACTIVATE POST has been seen, the source GET
 *    starts 404ing instead. This lands only on requests AFTER activation:
 *    the pre-activation content-gate re-read (src/tools/write.ts) still
 *    sees the real content, so the write itself is unaffected — only a
 *    verify read-back issued after activation is the one that goes dark.
 *    The repository-search fallback `verifyObjectPresent` then tries is
 *    routed to a clean zero-hit miss.
 */
function existingReportRoute(initial: string, opts: { confirm?: boolean } = {}): Route {
  const confirm = opts.confirm ?? true;
  let current = initial;
  let activated = false;
  return (r) => {
    if (r.url === REPORT_URI && r.method === "GET")
      return resp(200, objectMetadataXml({ name: REPORT, type: "PROG/P" }), OK_XML);
    if (r.url === REPORT_SRC && r.method === "GET") {
      if (!confirm && activated) return resp(404, NOT_FOUND_XML, OK_XML);
      return resp(200, current, OK_TEXT);
    }
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === REPORT_SRC && r.method === "PUT") {
      current = r.body ?? "";
      return resp(200, "", OK_TEXT);
    }
    if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
    if (r.url.includes("/activation")) {
      activated = true;
      return resp(200, "", OK_TEXT);
    }
    if (r.url.endsWith("/repository/informationsystem/search")) return resp(200, searchResultsXml([]), OK_XML);
    return undefined;
  };
}

const sourceGets = (adt: FakeAdt): number =>
  adt.calls.filter((c) => c.url === REPORT_SRC && c.method === "GET").length;

describe("abap_write verify mode — 7th abapWrite argument / per-call `verify`", () => {
  it("DEFAULT (verifyWrites omitted): no extra read-back GET, header/notes say speculative", async () => {
    const { conn, adt } = await connected(existingReportRoute(SOURCE_A));
    const result = await abapWrite(
      conn,
      { object: REPORT, type: "PROG/P", source: SOURCE_B },
      20_000,
      DEFAULT_GATE,
    );
    expect(result.text).toMatch(/changed:\s*true/);
    // Still speculative — the verify feature read nothing back for the caller —
    // but this write is CONCLUSIVE, so the header may not say "not read back":
    // the pre-activation content gate did read it, and the note says so.
    expect(result.text).toMatch(/verify:\s*speculative — /);
    expect(result.text).not.toContain("speculative (not read back)");
    // The CONCLUSIVE note supersedes the speculative one — both at once said
    // the same thing twice with opposite framing.
    expect(result.text).toContain("CONCLUSIVE:");
    expect(result.text).not.toMatch(/NOTE: verify: speculative/);
    const baselineGets = sourceGets(adt);

    // Re-run under verified mode against a fresh connection to get the delta
    // in GETs one extra read-back adds, without assuming a fixed absolute count.
    const { conn: conn2, adt: adt2 } = await connected(existingReportRoute(SOURCE_A));
    await abapWrite(
      conn2,
      { object: REPORT, type: "PROG/P", source: SOURCE_B },
      20_000,
      DEFAULT_GATE,
      undefined,
      undefined,
      "verified",
    );
    expect(sourceGets(adt2)).toBe(baselineGets + 1);
  });

  it('verifyWrites: "verified" (7th arg): header says confirmed present, and the read-back GET was issued', async () => {
    const { conn, adt } = await connected(existingReportRoute(SOURCE_A));
    const result = await abapWrite(
      conn,
      { object: REPORT, type: "PROG/P", source: SOURCE_B },
      20_000,
      DEFAULT_GATE,
      undefined,
      undefined,
      "verified",
    );
    expect(result.text).toMatch(/verify:\s*verified — confirmed present via read-back/);
    expect(result.text).toMatch(/NOTE: verify: verified — .*confirmed present/);
    expect(sourceGets(adt)).toBeGreaterThanOrEqual(2);
  });

  it("raise-only, upward: verifyWrites=speculative but input.verify:true still reads back", async () => {
    const { conn } = await connected(existingReportRoute(SOURCE_A));
    const result = await abapWrite(
      conn,
      { object: REPORT, type: "PROG/P", source: SOURCE_B, verify: true },
      20_000,
      DEFAULT_GATE,
      undefined,
      undefined,
      "speculative",
    );
    expect(result.text).toMatch(/verify:\s*verified — confirmed present via read-back/);
  });

  it("raise-only, downward blocked: verifyWrites=verified with input.verify:false still reads back", async () => {
    const { conn } = await connected(existingReportRoute(SOURCE_A));
    const result = await abapWrite(
      conn,
      { object: REPORT, type: "PROG/P", source: SOURCE_B, verify: false },
      20_000,
      DEFAULT_GATE,
      undefined,
      undefined,
      "verified",
    );
    // A server operator's stricter posture (ABAP_VERIFY_WRITES=verified) is
    // not something one caller's verify:false can opt back out of.
    expect(result.text).toMatch(/verify:\s*verified — confirmed present via read-back/);
  });

  it("verified mode, unconfirmable read-back: success is NOT retracted, and the NOT-confirmed note is present", async () => {
    const { conn } = await connected(existingReportRoute(SOURCE_A, { confirm: false }));
    const result = await abapWrite(
      conn,
      { object: REPORT, type: "PROG/P", source: SOURCE_B },
      20_000,
      DEFAULT_GATE,
      undefined,
      undefined,
      "verified",
    );
    // Success is not retracted: this must NOT have thrown, and must still
    // report the write as changed/activated.
    expect(result.text).toMatch(/changed:\s*true/);
    expect(result.text).toMatch(/activated:\s*true/);
    expect(result.text).toMatch(/verify:\s*verified — NOT confirmed \(see NOTE\)/);
    expect(result.text).toMatch(/NOTE: verify: verified — the write reported success, but the read-back did NOT confirm/);
  });

  it("`verify` alongside `objects` (batch delete) is rejected as a stray field", async () => {
    const { conn, adt } = await connected(() => undefined);
    const e = await catchErr(
      abapWrite(
        conn,
        { objects: [{ object: "ZMCP_VERIFY_DEL" }], mode: "delete", verify: true } as never,
        100_000,
        DEFAULT_GATE,
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toContain("does not combine with top-level");
    expect(e.message).toContain("`verify`");
    expect(adt.calls).toHaveLength(0);
  });
});
