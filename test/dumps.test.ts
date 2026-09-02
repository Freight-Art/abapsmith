/**
 * `src/adt/dumps.ts` — the ADT I/O layer for ST22 runtime-error dumps.
 *
 * Every byte in here comes from `test/fixtures/dumps/`, captured off A4H on
 * 2026-08-11, and every assertion about a *request* is checked against the
 * `.meta.json` sidecar of the capture that produced the response being
 * replayed. That is the point of the file: a fake transport will accept any
 * URL and any `Accept` header, so a test that invents its own expectations
 * proves only that the code agrees with the test. The sidecars are the wire.
 *
 * No network. The transport is the house fake (`test/data-preview.test.ts`,
 * `test/ddic.test.ts:290`): a plain object cast through `unknown`, recording
 * every call so a test can assert on the **absence** of a request as well as
 * on its arguments.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import {
  DUMPS_FEED_ACCEPT,
  DUMP_DETAIL_ACCEPT,
  DUMP_FORMATTED_ACCEPT,
  FEEDS_CATALOG_ACCEPT,
  FEEDS_CATALOG_PATH,
  assertVerbatimDumpKey,
  checkDumpsQuery,
  clearDumpsCapabilityCache,
  dedupeDumpEntries,
  dumpDetailPath,
  dumpFormattedPath,
  emptyDumpsReason,
  fetchDumpChapters,
  fetchDumpDetail,
  fetchDumpFormatted,
  fetchDumpsPage,
  fetchFeedsCatalog,
  listAllDumps,
  listDumps,
  probeDumpsFeed,
  selectDumpChapters,
} from "../src/adt/dumps.js";
import { DUMPS_FEED_PATH, parseAdtExceptionEnvelope, parseDumpFeed } from "../src/adt/dumps-xml.js";
import { isAbapError } from "../src/adt/errors.js";

// ------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "dumps");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

interface Sidecar {
  requestMethod: string;
  requestPath: string;
  requestHeaders: Record<string, string>;
  responseStatus: number;
  lineCount?: number;
}

function meta(name: string): Sidecar {
  return JSON.parse(fixture(name)) as Sidecar;
}

const SIDECAR = {
  catalog: meta("feeds-catalog.meta.json"),
  feedTop3: meta("feed-top3-next.meta.json"),
  feedEmpty: meta("feed-empty.meta.json"),
  detail: meta("dump-detail-v1.meta.json"),
  formatted: meta("dump-formatted.meta.json"),
  formattedAlt: meta("dump-formatted-alt.meta.json"),
  detail406: meta("dump-detail-406-textplain.meta.json"),
  detail404: meta("dump-detail-404-doubleenc.meta.json"),
  qcValid: meta("querycheck-valid.meta.json"),
  qcInvalid: meta("querycheck-invalid.meta.json"),
} as const;

/**
 * The dump key, taken the only legitimate way: out of the feed's own
 * `rel="self"` entry link. Nothing in this file types a key by hand.
 */
const FEED_TOP3 = parseDumpFeed(fixture("feed-top3-next.xml"));
const KEY = FEED_TOP3.entries[0]?.key ?? "";

// ------------------------------------------------------------ transport ---

interface Call {
  url: string;
  headers: Record<string, string>;
  qs?: Record<string, string>;
}

type Reply = { body: string; status?: number };
type Handler = (url: string) => Reply;

function fakeConn(handler: Handler): { conn: AbapConnection; calls: Call[] } {
  const calls: Call[] = [];
  const conn = {
    async get(url: string, opts: { headers?: Record<string, string>; qs?: Record<string, string> } = {}) {
      calls.push({ url, headers: opts.headers ?? {}, ...(opts.qs === undefined ? {} : { qs: opts.qs }) });
      const reply = handler(url);
      return { body: reply.body, status: reply.status ?? 200, headers: {} };
    },
  } as unknown as AbapConnection;
  return { conn, calls };
}

/**
 * An error shaped exactly like what `abap-adt-api` throws for a parsed
 * `<exc:exception>` envelope (`err`/`type`/`message`/`properties`, no
 * `response`) — the same convention `test/debug-transport.test.ts:943` uses.
 * The type and message are read out of the captured body rather than typed
 * here, so the classifier is tested against the server's own words.
 */
function adtThrow(fixtureName: string, status: number): unknown {
  const env = parseAdtExceptionEnvelope(fixture(fixtureName));
  return { err: status, type: env?.type, message: env?.message ?? "", properties: {} };
}

/** The routing every "happy path" test shares, keyed on captured paths. */
function captureRouter(url: string): Reply {
  if (url === SIDECAR.catalog.requestPath) return { body: fixture("feeds-catalog.xml") };
  if (url === SIDECAR.feedTop3.requestPath) return { body: fixture("feed-top3-next.xml") };
  if (url === SIDECAR.feedEmpty.requestPath) return { body: fixture("feed-empty.xml") };
  if (url === SIDECAR.detail.requestPath) return { body: fixture("dump-detail-v1.xml") };
  if (url === SIDECAR.formatted.requestPath) return { body: fixture("dump-formatted.txt") };
  if (url === SIDECAR.formattedAlt.requestPath) return { body: fixture("dump-formatted-alt.txt") };
  throw new Error(`the fake transport was asked for an uncaptured URL: ${url}`);
}

function accept(call: Call | undefined): string | undefined {
  return call?.headers.Accept;
}

// ===========================================================================

describe("dump keys and the singular detail resource", () => {
  it("the fixtures agree with each other: the feed's first rel=self key is the detail capture's key", () => {
    // If this ever fails the rest of the file is testing a fiction.
    expect(KEY).not.toBe("");
    expect(SIDECAR.detail.requestPath).toBe(`/sap/bc/adt/runtime/dump/${KEY}`);
  });

  it("a key taken verbatim from rel=self produces the captured singular-`dump` URL", () => {
    expect(dumpDetailPath(KEY)).toBe(SIDECAR.detail.requestPath);
    expect(dumpFormattedPath(KEY)).toBe(SIDECAR.formatted.requestPath);
    // The one-character difference that is the whole hazard.
    expect(dumpDetailPath(KEY).startsWith("/sap/bc/adt/runtime/dump/")).toBe(true);
    expect(dumpDetailPath(KEY).startsWith(`${DUMPS_FEED_PATH}/`)).toBe(false);
  });

  it("a re-encoded key is exactly the captured 404, and is refused before any request", async () => {
    // Proof the trap is this and nothing else: encodeURIComponent on the
    // verbatim key reproduces the double-encoded path the server 404'd.
    expect(`/sap/bc/adt/runtime/dump/${encodeURIComponent(KEY)}`).toBe(SIDECAR.detail404.requestPath);
    expect(SIDECAR.detail404.responseStatus).toBe(404);

    const { conn, calls } = fakeConn(captureRouter);
    await expect(fetchDumpDetail(conn, encodeURIComponent(KEY))).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
    // The refusal costs zero HTTP calls — a mangled key has nothing safe to send.
    expect(calls).toEqual([]);
  });

  it("refuses a decoded key, a path-traversing key and a query-grafting key", () => {
    for (const bad of [decodeURIComponent(KEY), `${KEY}/formatted`, `${KEY}?x=1`, `${KEY}#f`, "  "]) {
      expect(() => assertVerbatimDumpKey(bad)).toThrowError(/dump key/i);
    }
    expect(assertVerbatimDumpKey(KEY)).toBe(KEY);
  });
});

describe("Accept headers match the captured sidecars", () => {
  it("the feeds catalog is asked for with the header the capture used", async () => {
    const { conn, calls } = fakeConn(captureRouter);
    await fetchFeedsCatalog(conn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(SIDECAR.catalog.requestPath);
    expect(accept(calls[0])).toBe(SIDECAR.catalog.requestHeaders.Accept);
    expect(FEEDS_CATALOG_ACCEPT).toBe(SIDECAR.catalog.requestHeaders.Accept);
  });

  it("the dumps feed is asked for with the header the capture used", async () => {
    const { conn, calls } = fakeConn(captureRouter);
    await listDumps(conn, { $top: 3 }, { probe: false });
    expect(calls).toHaveLength(1);
    expect(accept(calls[0])).toBe(SIDECAR.feedTop3.requestHeaders.Accept);
    expect(DUMPS_FEED_ACCEPT).toBe(SIDECAR.feedTop3.requestHeaders.Accept);
    expect(DUMPS_FEED_ACCEPT).toBe(SIDECAR.feedEmpty.requestHeaders.Accept);
  });

  it("the detail document is asked for as vnd.sap.adt.runtime.dump.v1+xml — the 406 trap", async () => {
    const { conn, calls } = fakeConn(captureRouter);
    await fetchDumpDetail(conn, KEY);
    expect(accept(calls[0])).toBe(SIDECAR.detail.requestHeaders.Accept);
    expect(DUMP_DETAIL_ACCEPT).toBe(SIDECAR.detail.requestHeaders.Accept);
    // text/plain on this same resource is the captured 406, so the detail
    // fetch must never send it.
    expect(SIDECAR.detail406.requestHeaders.Accept).toBe("text/plain");
    expect(SIDECAR.detail406.responseStatus).toBe(406);
    expect(accept(calls[0])).not.toBe("text/plain");
  });

  it("the /formatted sub-resource is asked for as text/plain", async () => {
    const { conn, calls } = fakeConn(captureRouter);
    await fetchDumpFormatted(conn, KEY);
    expect(calls[0]?.url).toBe(SIDECAR.formatted.requestPath);
    expect(accept(calls[0])).toBe(SIDECAR.formatted.requestHeaders.Accept);
    expect(DUMP_FORMATTED_ACCEPT).toBe(SIDECAR.formatted.requestHeaders.Accept);
  });

  it("nothing is ever sent through `qs` — the query string is pre-encoded into the URL", async () => {
    const { conn, calls } = fakeConn(captureRouter);
    await listDumps(conn, { $top: 3 }, { probe: false });
    await fetchDumpDetail(conn, KEY);
    for (const call of calls) expect(call.qs).toBeUndefined();
  });
});

describe("listDumps", () => {
  it("reproduces the captured request path byte for byte", async () => {
    const { conn, calls } = fakeConn(captureRouter);
    await listDumps(conn, { $query: "and ( equals ( user , NOSUCHUSER ) )" }, { probe: false });
    expect(calls[0]?.url).toBe(SIDECAR.feedEmpty.requestPath);
  });

  it("an empty feed reports the 8-day residence window, never a bare 'no dumps'", async () => {
    const { conn } = fakeConn(captureRouter);
    const page = await listDumps(
      conn,
      { $query: "and ( equals ( user , NOSUCHUSER ) )" },
      { probe: false, now: new Date("2026-08-11T12:35:06Z") },
    );

    expect(page.entries).toEqual([]);
    expect(page.emptyReason).toBeDefined();
    expect(page.emptyReason).toContain("No dumps in the last 8 days matching this filter");
    // The window start is surfaced, not merely alluded to.
    expect(page.residenceWindowStart).toBe("20260804000000");
    expect(page.emptyReason).toContain(page.residenceWindowStart);
    expect(page.emptyReason).toMatch(/ST22/);
    expect(page.emptyReason).not.toMatch(/^No dumps\.?$/);
  });

  it("a non-empty page carries no emptyReason", async () => {
    const { conn } = fakeConn(captureRouter);
    const page = await listDumps(conn, { $top: 3 }, { probe: false });
    expect(page.entries).toHaveLength(3);
    expect(page.emptyReason).toBeUndefined();
    expect(page.hasMore).toBe(true);
    expect(page.nextHref).toBe(`${DUMPS_FEED_PATH}?%24top=3&to=20260811123445`);
    expect(page.systemId).toBe("A4H");
  });

  it("an unrecognised filter parameter is refused client-side and never reaches the transport", async () => {
    const { conn, calls } = fakeConn(captureRouter);
    // The server answers every one of these with 200 and the COMPLETE feed —
    // a wrong answer indistinguishable from a right one — so the refusal has
    // to happen here.
    for (const bad of [{ $filter: "user eq X" }, { query: "and ( equals ( user , X ) )" }, { $skip: 10 }]) {
      await expect(
        listDumps(conn, bad as unknown as Parameters<typeof listDumps>[1], { probe: false }),
      ).rejects.toMatchObject({ code: "BAD_INPUT" });
    }
    expect(calls).toEqual([]);
  });

  it("an invalid filter is refused client-side too — the server's 400 says nothing", async () => {
    const { conn, calls } = fakeConn(captureRouter);
    await expect(
      listDumps(conn, { $query: "and ( equals ( bogusAttr , X ) )" }, { probe: false }),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
    await expect(
      listDumps(conn, { $query: "contains ( user , DEV )" }, { probe: false }),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(calls).toEqual([]);
  });

  it("emptyDumpsReason distinguishes 'nothing matched' from 'nothing happened'", () => {
    expect(emptyDumpsReason("20260804000000", true)).toContain("Widening or dropping the filter");
    expect(emptyDumpsReason("20260804000000", false)).toContain("No filter was applied");
    for (const filtered of [true, false]) {
      expect(emptyDumpsReason("20260804000000", filtered)).toContain(
        "No dumps in the last 8 days matching this filter",
      );
    }
  });
});

describe("capability probe (/sap/bc/adt/feeds, never /discovery)", () => {
  it("finds the dumps feed and reads its served contract", async () => {
    const { conn } = fakeConn(captureRouter);
    const cap = await probeDumpsFeed(conn);
    expect(cap.state).toBe("supported");
    expect(cap.entry?.id).toBe(DUMPS_FEED_PATH);
    expect(cap.pageSize).toBe(50);
    expect(cap.refresh).toEqual({ value: 5, unit: "minutes" });
    expect(cap.contract?.queryDepth).toBe(2);
    // The asymmetry the served contract exists to carry: `user` is a string
    // yet permits only two operators.
    const user = cap.contract?.attributes.find((a) => a.id === "user");
    expect(user?.dataType).toBe("string");
    expect([...(user?.operators ?? [])].sort()).toEqual(["equals", "notEquals"]);
    clearDumpsCapabilityCache(conn);
  });

  it("caches the verdict per connection — one catalog fetch, not one per listing", async () => {
    const { conn, calls } = fakeConn(captureRouter);
    await listDumps(conn, { $top: 3 });
    await listDumps(conn, { $top: 3 });
    expect(calls.filter((c) => c.url === FEEDS_CATALOG_PATH)).toHaveLength(1);
    clearDumpsCapabilityCache(conn);
  });

  it("a catalog that does not list the feed is UNSUPPORTED, and says which catalog said so", async () => {
    // The real catalog names the feed three times — `atom:content/@src`,
    // `atom:id` and `rel="alternate"` — and the probe matches on the first
    // two. Renaming only one of them would leave a catalog that still
    // advertises the feed, which is not the case under test.
    const stripped = fixture("feeds-catalog.xml").replaceAll(
      DUMPS_FEED_PATH,
      "/sap/bc/adt/runtime/somethingelse",
    );
    const { conn, calls } = fakeConn((url) =>
      url === FEEDS_CATALOG_PATH ? { body: stripped } : captureRouter(url),
    );
    const cap = await probeDumpsFeed(conn);
    expect(cap.state).toBe("unsupported");

    const failure = await listDumps(conn, { $top: 3 }).catch((e: unknown) => e);
    expect(isAbapError(failure) && failure.code).toBe("UNSUPPORTED");
    if (isAbapError(failure)) {
      expect(failure.message).toContain(FEEDS_CATALOG_PATH);
      expect(`${failure.message} ${failure.hint ?? ""}`).toContain("ST22");
      // Never blamed on /discovery, and never on a bare 404.
      expect(failure.hint).toContain("/sap/bc/adt/discovery");
      expect(failure.hint).toMatch(/never lists this feed/);
    }
    // The refusal happened before the feed was touched.
    expect(calls.some((c) => c.url.startsWith(DUMPS_FEED_PATH))).toBe(false);
    clearDumpsCapabilityCache(conn);
  });

  it("an unreadable catalog is UNKNOWN and the request proceeds anyway", async () => {
    const { conn, calls } = fakeConn((url) => {
      if (url === FEEDS_CATALOG_PATH) throw adtThrow("dump-detail-406-textplain.xml", 500);
      return captureRouter(url);
    });
    const cap = await probeDumpsFeed(conn);
    expect(cap.state).toBe("unknown");

    const page = await listDumps(conn, { $top: 3 });
    expect(page.entries).toHaveLength(3);
    expect(page.notes.join(" ")).toContain(FEEDS_CATALOG_PATH);
    // An `unknown` is the probe failing, not the system answering: it must be
    // re-tried, so it is not cached.
    expect(calls.filter((c) => c.url === FEEDS_CATALOG_PATH).length).toBeGreaterThan(1);
    clearDumpsCapabilityCache(conn);
  });
});

describe("paging", () => {
  it("follows the server's own rel=next verbatim and de-duplicates the repeated boundary", async () => {
    const first = fixture("feed-top3-next.xml");
    // The cursor bound is inclusive, so page 2 legitimately re-sends the last
    // entry of page 1. Reproduced here by replaying the same page under the
    // `next` URL with its own `next` removed.
    const second = first.replace(
      /<atom:link href="[^"]*" rel="next"[^>]*\/>/,
      "",
    );
    const nextHref = `${DUMPS_FEED_PATH}?%24top=3&to=20260811123445`;
    const { conn, calls } = fakeConn((url) =>
      url === nextHref ? { body: second } : captureRouter(url),
    );

    const all = await listAllDumps(conn, { $top: 3 }, { probe: false });
    expect(calls.map((c) => c.url)).toEqual([SIDECAR.feedTop3.requestPath, nextHref]);
    expect(all.pagesFetched).toBe(2);
    expect(all.duplicatesDropped).toBe(3);
    expect(all.entries).toHaveLength(3);
    expect(new Set(all.entries.map((e) => e.key)).size).toBe(3);
  });

  it("dedupeDumpEntries keys on the whole key, not on the timestamp", () => {
    const entries = FEED_TOP3.entries;
    expect(dedupeDumpEntries([...entries, ...entries])).toHaveLength(entries.length);
    // Two of the captured dumps are one second apart and a third shares a
    // second with neither — but the counter suffix is what separates them.
    expect(new Set(entries.map((e) => e.published)).size).toBeGreaterThan(0);
  });

  it("refuses a cursor that is not a path on the dumps feed", async () => {
    const { conn, calls } = fakeConn(captureRouter);
    for (const href of [
      "https://example.invalid/sap/bc/adt/runtime/dumps?%24top=3",
      "/sap/bc/adt/runtime/dumpsX?x=1",
      "/sap/bc/adt/oo/classes/zcl_x/source/main",
    ]) {
      await expect(fetchDumpsPage(conn, href)).rejects.toMatchObject({ code: "BAD_INPUT" });
    }
    expect(calls).toEqual([]);
  });
});

describe("$queryCheck pre-flight", () => {
  it("a valid query is confirmed by the server", async () => {
    const { conn, calls } = fakeConn(() => ({ body: fixture("querycheck-valid.xml") }));
    const result = await checkDumpsQuery(conn, "and ( equals ( user , DEVELOPER ) )");
    expect(result.ok).toBe(true);
    expect(result.query).toBe("and ( equals ( user , DEVELOPER ) )");
    // Both parameters are sent, pre-encoded, with no `qs`. (Parameter ORDER
    // differs from the capture — the builder emits `$query` first and the
    // captured curl sent `$queryCheck` first — which is why this checks
    // membership rather than the whole string.)
    expect(calls[0]?.url).toContain("%24queryCheck=true");
    expect(calls[0]?.url).toContain(
      "%24query=and%20(%20equals%20(%20user%20%2C%20DEVELOPER%20)%20)",
    );
    expect(accept(calls[0])).toBe(SIDECAR.qcValid.requestHeaders.Accept);
  });

  it("a server refusal is returned as a verdict, not thrown", async () => {
    // Reaching the server at all requires a query this client considers legal,
    // so the refusal is simulated on a well-formed query — which is precisely
    // the case $queryCheck exists for: the client contract may be stale.
    const { conn } = fakeConn(() => {
      throw adtThrow("querycheck-invalid.xml", SIDECAR.qcInvalid.responseStatus);
    });
    const result = await checkDumpsQuery(conn, "and ( equals ( component , X ) )");
    expect(result.ok).toBe(false);
    expect(result.serverMessage).toBeTruthy();
  });

  it("a query this client rejects never reaches the server", async () => {
    const { conn, calls } = fakeConn(captureRouter);
    await expect(checkDumpsQuery(conn, "and ( equals ( bogusAttr , X ) )")).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
    expect(calls).toEqual([]);
  });
});

describe("detail, /formatted and chapter slicing", () => {
  it("parses the detail and follows the `contents` link for the plain-text body", async () => {
    const { conn, calls } = fakeConn(captureRouter);
    const detail = await fetchDumpDetail(conn, KEY);
    expect(detail.error).toBe("SAPSQL_PARSE_ERROR");
    expect(detail.exception).toBe("CX_SY_DYNAMIC_OSQL_SEMANTICS");
    expect(detail.chapters).toHaveLength(20);
    expect(detail.formattedPath).toBe(SIDECAR.formatted.requestPath);
    expect(detail.termination?.path).toBe("/sap/bc/adt/oo/classes/zcl_zmcp_dmp_sql/source/main");
    expect(detail.termination?.line).toBe(17);

    await fetchDumpFormatted(conn, detail);
    expect(calls.map((c) => c.url)).toEqual([
      SIDECAR.detail.requestPath,
      SIDECAR.formatted.requestPath,
    ]);
  });

  it("slices the tier-1 chapters out of the matched /formatted body and excludes kap10", async () => {
    const { conn } = fakeConn(captureRouter);
    const sel = await fetchDumpChapters(conn, KEY);
    expect(sel.totalLines).toBe(SIDECAR.formatted.lineCount);
    expect(sel.requested).toEqual(["kap7", "kap8", "kap9", "kap11"]);
    expect(sel.missing).toEqual([]);
    expect(sel.includesVariables).toBe(false);
    expect(sel.text).not.toBe("");
    // The variables chapter is ~60% of this body; the tier-1 slice is not.
    expect(sel.text.split("\n").length).toBeLessThan(sel.totalLines / 2);
  });

  it("flags a slice that carries variable contents so the caller can gate it", async () => {
    const { conn } = fakeConn(captureRouter);
    const sel = await fetchDumpChapters(conn, KEY, ["kap10"]);
    expect(sel.includesVariables).toBe(true);
    expect(sel.present).toEqual(["kap10"]);
    expect(sel.text.split("\n").length).toBeGreaterThan(1000);
  });

  it("reports chapters this release does not have instead of failing", () => {
    const detail = { chapters: [], links: [], error: "X" } as unknown as Parameters<
      typeof selectDumpChapters
    >[0];
    const sel = selectDumpChapters(detail, "a\nb\nc", ["kap7", "kap99"]);
    expect(sel.present).toEqual([]);
    expect(sel.missing).toEqual(["kap7", "kap99"]);
    expect(sel.text).toBe("");
    expect(sel.totalLines).toBe(3);
  });
});

describe("failure translation", () => {
  it("a 404 on a dump key does not send the reader to abap_search", async () => {
    const { conn } = fakeConn(() => {
      throw adtThrow("dump-detail-404-doubleenc.xml", 404);
    });
    const failure = await fetchDumpDetail(conn, KEY).catch((e: unknown) => e);
    expect(isAbapError(failure)).toBe(true);
    if (!isAbapError(failure)) return;
    expect(failure.code).toBe("NOT_FOUND");
    expect(failure.details.dumpKey).toBe(KEY);
    expect(failure.hint).toMatch(/rel="self"/);
    expect(failure.hint).toContain("8-day");
    expect(failure.hint).not.toMatch(/abap_search|create the object/);
  });

  it("a 406 is reported as the representation mistake it is, not as authorisation", async () => {
    const { conn } = fakeConn(() => {
      throw adtThrow("dump-detail-406-textplain.xml", 406);
    });
    const failure = await fetchDumpFormatted(conn, KEY).catch((e: unknown) => e);
    expect(isAbapError(failure) && failure.code).toBe("ADT_ERROR");
    if (isAbapError(failure)) {
      expect(failure.hint).toContain("/formatted");
      expect(failure.hint).toContain(DUMP_DETAIL_ACCEPT);
    }
  });

  it("a 403 names the ST22 authorisation and does not blame the key", async () => {
    const { conn } = fakeConn(() => {
      throw { err: 403, type: "ExceptionResourceNoAuthorization", message: "No authorisation", properties: {} };
    });
    const failure = await fetchDumpDetail(conn, KEY).catch((e: unknown) => e);
    expect(isAbapError(failure) && failure.code).toBe("AUTH_FAILED");
    if (isAbapError(failure)) expect(failure.hint).toMatch(/S_ADMI_FCD|S_DEVELOP/);
  });

  it("a 400 on the feed explains that the server's body is the same for every mistake", async () => {
    const { conn } = fakeConn(() => {
      throw adtThrow("querycheck-invalid.xml", 400);
    });
    const failure = await listDumps(conn, { $top: 3 }, { probe: false }).catch((e: unknown) => e);
    expect(isAbapError(failure) && failure.code).toBe("BAD_INPUT");
    if (isAbapError(failure)) {
      expect(failure.hint).toContain("372-byte");
      expect(failure.hint).toContain(FEEDS_CATALOG_PATH);
    }
  });
});
