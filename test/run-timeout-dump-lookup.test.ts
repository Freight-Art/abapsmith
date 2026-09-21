/**
 * Issue #149: `runClass` classifies a transport timeout on the classrun POST
 * as AbapError code TIMEOUT (retryable: true), and for TIMEOUT or a 200 whose
 * body is not console output, asks the dumps feed for a recent dump of this
 * user/program and folds the verdict into the thrown error. Covers request
 * sequencing/URL content, matched/no-match/failed-lookup outcomes, cross-user
 * non-attribution, `options.dumpPrograms` bridging, and the pure helpers.
 *
 * Offline only: the transport is faked through `ConnectionOptions.httpClient`,
 * same seam as test/run-lost-response-disclosure.test.ts.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError } from "../src/adt/errors.js";
import { runClass, buildDumpCorrelation } from "../src/adt/run.js";
import { classPoolName, programMatches } from "../src/adt/run-dump-lookup.js";
import { parseDumpFeed } from "../src/adt/dumps-xml.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "dumps");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const FEED_TOP3_XML = fixture("feed-top3-next.xml");
const FEED_EMPTY_XML = fixture("feed-empty.xml");
const DUMP_DETAIL_XML = fixture("dump-detail-v1.xml");
const FEED_TOP3 = parseDumpFeed(FEED_TOP3_XML);
const [ROW_SQL, ROW_ITAB, ROW_CONVT] = FEED_TOP3.entries;

const cfg = (user = "DEVELOPER"): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user,
    password: "secret",
    sid: "TST",
    client: "001",
  });

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
  statusText = String(status),
): HttpClientResponse => ({ status, statusText, body, headers }) as unknown as HttpClientResponse;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

const SESSION_URL = "/sap/bc/adt/compatibility/graph";
const CLASSRUN = "/sap/bc/adt/oo/classrun/";
const DUMPS_FEED = "/sap/bc/adt/runtime/dumps";
const DUMPS_DETAIL = "/sap/bc/adt/runtime/dump/";

type Route = (o: HttpClientOptions) => HttpClientResponse;

const feedOk: Route = () => resp(200, FEED_TOP3_XML, { "content-type": "application/atom+xml" });
const feedEmpty: Route = () => resp(200, FEED_EMPTY_XML, { "content-type": "application/atom+xml" });
const detailOk: Route = () => resp(200, DUMP_DETAIL_XML, { "content-type": "application/xml" });

const responder =
  (classrun: Route, feed: Route = feedEmpty, detail: Route = detailOk): Route =>
  (o) => {
    if (o.url.startsWith(CLASSRUN)) return classrun(o);
    if (o.url.startsWith(DUMPS_FEED)) return feed(o);
    if (o.url.startsWith(DUMPS_DETAIL)) return detail(o);
    if (o.url.includes(SESSION_URL)) {
      return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
    }
    return resp(200, "<ok/>", { "content-type": "application/xml" });
  };

async function connected(
  classrun: Route,
  opts: { feed?: Route; detail?: Route; user?: string } = {},
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(responder(classrun, opts.feed, opts.detail));
  const conn = new AbapConnection(cfg(opts.user), {
    httpClient: routeSystemRoleProbe(inner, { answer: "nonproductive" }),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner };
}

const timeout: Route = () => {
  throw Object.assign(new Error("timeout of 60000ms exceeded"), { code: "ECONNABORTED" });
};

const SESSION_TIMEOUT_PAGE =
  `<!DOCTYPE html><html><head><title>Session Timed Out</title></head><body>` +
  `<h1>400 Session Timed Out</h1><p>Session no longer exists</p>` +
  `${"<p>&nbsp;</p>".repeat(200)}</body></html>`;

const ADT_EXCEPTION_BODY = `<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework"><message>Internal error</message></exc:exception>`;

describe("runClass TIMEOUT classification and dump lookup sequencing", () => {
  it("classifies a transport timeout on the classrun POST as AbapError TIMEOUT, retryable true, mayHaveExecuted disclosed", async () => {
    const { conn } = await connected(timeout, { feed: feedEmpty });

    const err = await runClass(conn, "ZCL_ZMCP_PROBE").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    if (!isAbapError(err)) return;
    expect(err.code).toBe("TIMEOUT");
    expect(err.retryable).toBe(true);
    expect(err.details.mayHaveExecuted).toBe(true);
    expect(err.hint).toMatch(/may already have executed and committed/);
  });

  it("queries the dumps feed then fetches dump detail, in that order, when a match is found", async () => {
    const { conn, inner } = await connected(timeout, { feed: feedOk, detail: detailOk });

    await runClass(conn, "ZCL_ZMCP_DMP_SQL").catch((e: unknown) => e);

    const urls = inner.calls.map((c) => c.url);
    const classrunIndex = urls.findIndex((u) => u.startsWith(CLASSRUN));
    const feedIndex = urls.findIndex((u) => u.startsWith(DUMPS_FEED));
    const detailIndex = urls.findIndex((u) => u.startsWith(DUMPS_DETAIL));
    expect(classrunIndex).toBeGreaterThanOrEqual(0);
    expect(feedIndex).toBeGreaterThan(classrunIndex);
    expect(detailIndex).toBeGreaterThan(feedIndex);
    expect(urls[detailIndex]).toBe(`${DUMPS_DETAIL}${ROW_SQL!.key}`);
  });

  it("the feed request URL carries %24top=20, decoded $query 'and ( equals ( user , DEVELOPER ) )', and 14-digit UTC from/to bounds", async () => {
    const { conn, inner } = await connected(timeout, { feed: feedEmpty });

    await runClass(conn, "ZCL_ZMCP_PROBE").catch((e: unknown) => e);

    const feedCall = inner.calls.find((c) => c.url.startsWith(DUMPS_FEED));
    expect(feedCall).toBeDefined();
    const url = feedCall!.url;
    expect(url).toMatch(/%24top=20/);
    const queryMatch = /%24query=([^&]+)/.exec(url);
    expect(queryMatch).not.toBeNull();
    expect(decodeURIComponent(queryMatch![1]!)).toBe("and ( equals ( user , DEVELOPER ) )");
    const fromMatch = /(?:^|&)from=(\d{14})/.exec(url);
    const toMatch = /(?:^|&)to=(\d{14})/.exec(url);
    expect(fromMatch).not.toBeNull();
    expect(toMatch).not.toBeNull();
    expect(fromMatch![1]!.length).toBe(14);
    expect(toMatch![1]!.length).toBe(14);
    // window spans lookback (60s) + 2s slack on each side
    const from = fromMatch![1]!;
    const to = toMatch![1]!;
    const asDate = (t: string): number =>
      Date.UTC(
        Number(t.slice(0, 4)),
        Number(t.slice(4, 6)) - 1,
        Number(t.slice(6, 8)),
        Number(t.slice(8, 10)),
        Number(t.slice(10, 12)),
        Number(t.slice(12, 14)),
      );
    expect(asDate(to) - asDate(from)).toBe(64_000);
  });
});

describe("recent-dump lookup outcomes folded into the TIMEOUT error", () => {
  it("a matched dump makes the error terminal: retryable false, details.dump populated, hint points at abap_dumps mode=show", async () => {
    const { conn } = await connected(timeout, { feed: feedOk, detail: detailOk });

    const err = await runClass(conn, "ZCL_ZMCP_DMP_SQL").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    if (!isAbapError(err)) return;
    expect(err.code).toBe("TIMEOUT");
    expect(err.retryable).toBe(false);
    const dump = err.details.dump as Record<string, unknown>;
    expect(dump.key).toBe(ROW_SQL!.key);
    expect(dump.runtimeError).toBe("SAPSQL_PARSE_ERROR");
    expect(dump.exception).toBe("CX_SY_DYNAMIC_OSQL_SEMANTICS");
    expect(dump.shortText).toBe(ROW_SQL!.title);
    expect(dump.program).toBe(ROW_SQL!.terminatedProgram);
    expect(err.hint).toContain(`abap_dumps ${JSON.stringify({ mode: "show", key: ROW_SQL!.key })}`);
    expect(err.hint).toMatch(/Do not retry unchanged/);
    const lookup = err.details.dumpLookup as Record<string, unknown>;
    expect(lookup.matched).toBe(true);
  });

  it("no matching program keeps TIMEOUT retryable true and records candidates/matched:false", async () => {
    const { conn } = await connected(timeout, { feed: feedOk, detail: detailOk });

    const err = await runClass(conn, "ZCL_ZMCP_PROBE").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    if (!isAbapError(err)) return;
    expect(err.code).toBe("TIMEOUT");
    expect(err.retryable).toBe(true);
    expect(err.details.dump).toBeUndefined();
    const lookup = err.details.dumpLookup as Record<string, unknown>;
    expect(lookup.matched).toBe(false);
    expect(lookup.candidates).toBe(3);
  });

  it("a dump recorded under a different user is not attributed to this run", async () => {
    const { conn } = await connected(timeout, { feed: feedOk, detail: detailOk, user: "TESTUSER" });

    const err = await runClass(conn, "ZCL_ZMCP_DMP_SQL").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    if (!isAbapError(err)) return;
    expect(err.details.dump).toBeUndefined();
    const lookup = err.details.dumpLookup as Record<string, unknown>;
    expect(lookup.candidates).toBe(0);
    expect(lookup.matched).toBe(false);
    expect(err.retryable).toBe(true);
  });

  it("a dumps-feed failure withdraws the retry verdict (retryable undefined) instead of guessing", async () => {
    const failingFeed: Route = () => {
      throw new Error("feed unavailable");
    };
    const { conn, inner } = await connected(timeout, { feed: failingFeed });

    const err = await runClass(conn, "ZCL_ZMCP_PROBE").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    if (!isAbapError(err)) return;
    expect(err.retryable).toBeUndefined();
    const lookup = err.details.dumpLookup as Record<string, unknown>;
    expect(lookup.failure).toContain("feed unavailable");
    expect(err.hint).toMatch(/UNKNOWN/);
    expect(inner.calls.some((c) => c.url.startsWith(DUMPS_DETAIL))).toBe(false);
  });

  it("a failed dump-detail fetch still records the match, just without an exception, and does not throw itself", async () => {
    const failingDetail: Route = () => {
      throw new Error("detail unavailable");
    };
    const { conn, inner } = await connected(timeout, { feed: feedOk, detail: failingDetail });

    const err = await runClass(conn, "ZCL_ZMCP_DMP_SQL").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    if (!isAbapError(err)) return;
    expect(err.retryable).toBe(false);
    const dump = err.details.dump as Record<string, unknown>;
    expect(dump.key).toBe(ROW_SQL!.key);
    expect(dump.exception).toBeUndefined();
    expect(inner.calls.some((c) => c.url.startsWith(DUMPS_DETAIL))).toBe(true);
  });
});

describe("options.dumpPrograms bridging and the 200 non-console-output path", () => {
  it("options.dumpPrograms lets a SUBMITted report's dump be attributed to the run, not just the class pool", async () => {
    const { conn } = await connected(timeout, { feed: feedOk, detail: detailOk });

    const err = await runClass(conn, "ZCL_ZMCP_PROBE", {
      dumpPrograms: [ROW_ITAB!.terminatedProgram.toLowerCase()],
    }).catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    if (!isAbapError(err)) return;
    expect(err.retryable).toBe(false);
    const dump = err.details.dump as Record<string, unknown>;
    expect(dump.key).toBe(ROW_ITAB!.key);
    expect(dump.runtimeError).toBe("ITAB_LINE_NOT_FOUND");
    expect(dump.program).toBe(ROW_ITAB!.terminatedProgram);
  });

  it("a 200 whose body is an ADT exception envelope is ADT_ERROR/noConsoleOutput; a matched dump makes it terminal", async () => {
    const classrun200: Route = () => resp(200, ADT_EXCEPTION_BODY, { "content-type": "text/plain" });
    const { conn } = await connected(classrun200, { feed: feedOk, detail: detailOk });

    const err = await runClass(conn, "ZCL_ZMCP_DMP_SQL").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    if (!isAbapError(err)) return;
    expect(err.code).toBe("ADT_ERROR");
    expect(err.details.noConsoleOutput).toBe(true);
    expect(err.retryable).toBe(false);
    const dump = err.details.dump as Record<string, unknown>;
    expect(dump.key).toBe(ROW_SQL!.key);
  });

  it("the same non-console-output path with no matching dump leaves retryable undefined (no default retry claim)", async () => {
    const classrun200: Route = () => resp(200, ADT_EXCEPTION_BODY, { "content-type": "text/plain" });
    const { conn } = await connected(classrun200, { feed: feedEmpty });

    const err = await runClass(conn, "ZCL_ZMCP_PROBE").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    if (!isAbapError(err)) return;
    expect(err.code).toBe("ADT_ERROR");
    expect(err.details.noConsoleOutput).toBe(true);
    expect(err.retryable).toBeUndefined();
    const lookup = err.details.dumpLookup as Record<string, unknown>;
    expect(lookup.matched).toBe(false);
    expect(lookup.candidates).toBe(0);
  });
});

describe("non-timeout errors never touch the dumps feed; pure helpers", () => {
  it("a SESSION_DEAD failure never queries the dumps feed", async () => {
    const { conn, inner } = await connected(() =>
      resp(400, SESSION_TIMEOUT_PAGE, { "content-type": "text/html" }, "Bad Request"),
    );

    const err = await runClass(conn, "ZCL_ZMCP_PROBE").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    if (!isAbapError(err)) return;
    expect(err.code).toBe("SESSION_DEAD");
    expect(inner.calls.some((c) => c.url.startsWith(DUMPS_FEED))).toBe(false);
    expect(inner.calls.some((c) => c.url.startsWith(DUMPS_DETAIL))).toBe(false);
  });

  it("a non-timeout thrown transport error becomes a plain ADT_ERROR and never queries the dumps feed", async () => {
    const { conn, inner } = await connected(() => {
      throw new Error("socket hang up");
    });

    const err = await runClass(conn, "ZCL_ZMCP_PROBE").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    if (!isAbapError(err)) return;
    expect(err.code).toBe("ADT_ERROR");
    expect(err.details.noConsoleOutput).toBeUndefined();
    expect(inner.calls.some((c) => c.url.startsWith(DUMPS_FEED))).toBe(false);
    expect(inner.calls.some((c) => c.url.startsWith(DUMPS_DETAIL))).toBe(false);
  });

  it("classPoolName pads to 30 chars with '=' then appends CP; programMatches is a case-insensitive trimmed membership test", () => {
    expect(classPoolName("ZCL_FOO")).toBe(`ZCL_FOO${"=".repeat(23)}CP`);
    expect(classPoolName("ZCL_FOO").length).toBe(32);
    expect(programMatches(" zcl_foo=====================cp ", ["ZCL_FOO=====================CP"])).toBe(true);
    expect(programMatches("ZCL_BAR=====================CP", ["ZCL_FOO=====================CP"])).toBe(false);
    expect(programMatches("", ["ZCL_FOO=====================CP"])).toBe(false);
  });

  it("buildDumpCorrelation computes 14-digit UTC from/to bounds with the slack, widened by lookbackSeconds, and renders the user FQL predicate", () => {
    const withLookback = buildDumpCorrelation("20260811123447", "developer", { lookbackSeconds: 60 });
    expect(withLookback).toBeDefined();
    expect(withLookback!.from).toBe("20260811123345");
    expect(withLookback!.to).toBe("20260811123449");
    expect(withLookback!.user).toBe("DEVELOPER");
    expect(withLookback!.query).toBe("and ( equals ( user , DEVELOPER ) )");

    const withoutLookback = buildDumpCorrelation("20260811123447", "developer");
    expect(withoutLookback!.from).toBe("20260811123445");
    expect(withoutLookback!.to).toBe("20260811123449");

    expect(buildDumpCorrelation(undefined, "developer")).toBeUndefined();
  });
});
