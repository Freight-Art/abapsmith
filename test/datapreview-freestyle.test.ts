/**
 * `AbapConnection.dataPreviewFreestyle()` — the freestyle sibling of
 * `dataPreviewDdic()`, newly wired up for `img-query.ts` to read the IMG
 * catalog with `WHERE`/`LIKE`/`ORDER BY`/`COUNT(*)`, none of which the DDIC
 * name-only path can express.
 *
 * Wire-level, via a fake `HttpClient` (the `RecordingClient` idiom from
 * `test/package-create.test.ts`), not the parser-level fake used by
 * `test/data-preview.test.ts`: what is under test here is the guard rail in
 * front of the wire, not response parsing.
 *
 * The system-role probe POSTs to this SAME URL
 * (`/sap/bc/adt/datapreview/freestyle`) during `connect()`, with a fixed
 * body (`SELECT mandt, cccategory, cccoractiv FROM t000`). The route below
 * tells the two apart by body content so `connect()`'s own probe traffic is
 * never mistaken for a call under test.
 */
import { describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

const FREESTYLE_URL = "/sap/bc/adt/datapreview/freestyle";
const SESSION_URL = "/sap/bc/adt/compatibility/graph";
/** The fixed body `probeT000()` (`system-role.ts`) sends — never the SQL under test. */
const PROBE_BODY = "SELECT mandt, cccategory, cccoractiv FROM t000";

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    readOnly: false,
  });

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse => ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

/** Session/discovery/role-probe plumbing every test needs to get past `connect()`. */
function sharedRoute(o: HttpClientOptions): HttpClientResponse | undefined {
  if (o.url.includes(SESSION_URL)) {
    return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
  }
  if (o.url.includes(FREESTYLE_URL) && o.body === PROBE_BODY) {
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  }
  if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
  return undefined;
}

function combine(
  ...routes: Array<(o: HttpClientOptions) => HttpClientResponse | undefined>
): (o: HttpClientOptions) => HttpClientResponse {
  return (o: HttpClientOptions) => {
    for (const r of routes) {
      const hit = r(o);
      if (hit) return hit;
    }
    throw new Error(`unrouted request: ${(o.method ?? "GET").toUpperCase()} ${o.url}`);
  };
}

/** Connects, then zeroes the call log so every test starts counting from its own call(s). */
async function connected(
  route: (o: HttpClientOptions) => HttpClientResponse | undefined,
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(combine(sharedRoute, route));
  const conn = new AbapConnection(cfg(), {
    httpClient: inner,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner };
}

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!e || !isAbapError(e)) throw new Error(`expected an AbapError, got ${String(e)}`);
  return e;
};

// ---------------------------------------------------------------------------
// The happy path — exact wire shape
// ---------------------------------------------------------------------------

describe("dataPreviewFreestyle — a well-formed SELECT reaches the wire", () => {
  it("sends the exact URL, rowNumber in the query string, text/plain, and the SQL verbatim", async () => {
    const sql = "SELECT actkeyupd, actkeytxt FROM tstc WHERE actkeytxt LIKE 'FI%' ORDER BY actkeytxt";
    const { conn, inner } = await connected(() =>
      resp(200, "<dataPreview:tableData/>", DATAPREVIEW_XML),
    );

    await conn.dataPreviewFreestyle(sql, 50);

    expect(inner.calls).toHaveLength(1);
    const call = inner.calls[0]!;
    expect(call.url).toBe(FREESTYLE_URL);
    expect((call.qs as Record<string, string>).rowNumber).toBe("50");
    expect((call.headers as Record<string, string>)["Content-Type"]).toBe("text/plain");
    expect(call.body).toBe(sql);
    conn.dispose();
  });

  it("does not refuse a legitimate column literally named CREATE_DATE (word-boundary, not includes)", async () => {
    const sql =
      "SELECT id, create_date FROM ztable_x WHERE create_date > '20260101' ORDER BY id";
    const { conn, inner } = await connected(() =>
      resp(200, "<dataPreview:tableData/>", DATAPREVIEW_XML),
    );

    await conn.dataPreviewFreestyle(sql, 100);

    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0]!.body).toBe(sql);
    conn.dispose();
  });
});

// ---------------------------------------------------------------------------
// rowNumber guard
// ---------------------------------------------------------------------------

describe("dataPreviewFreestyle — rowNumber guard", () => {
  const sql = "SELECT mandt FROM t000";

  it.each([0, -1, 1.5, NaN])("refuses rowNumber=%p with no request issued", async (bad) => {
    const { conn, inner } = await connected(() => undefined);

    const err = await catchErr(conn.dataPreviewFreestyle(sql, bad));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toMatch(/rowNumber must be a positive integer/);
    expect(err.message).toMatch(/UNLIMITED/);
    expect(inner.calls).toHaveLength(0);
    conn.dispose();
  });
});

// ---------------------------------------------------------------------------
// Statement guards
// ---------------------------------------------------------------------------

describe("dataPreviewFreestyle — statement guards", () => {
  it("refuses a statement containing ';'", async () => {
    const { conn, inner } = await connected(() => undefined);

    const err = await catchErr(conn.dataPreviewFreestyle("SELECT * FROM t000;", 10));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toMatch(/;/);
    expect(err.message).toMatch(/single statement/);
    expect(inner.calls).toHaveLength(0);
    conn.dispose();
  });

  it("refuses a statement containing a mutating/control keyword as a whole word", async () => {
    const { conn, inner } = await connected(() => undefined);

    const err = await catchErr(
      conn.dataPreviewFreestyle("SELECT tabname FROM dd02l WHERE ddtext LIKE '%DROP%'", 10),
    );

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toMatch(/DROP/);
    expect(err.message).toMatch(/read-only|only a read/i);
    expect(inner.calls).toHaveLength(0);
    conn.dispose();
  });

  it("refuses a statement that does not start with SELECT", async () => {
    const { conn, inner } = await connected(() => undefined);

    const err = await catchErr(conn.dataPreviewFreestyle("UPDATE t000 SET mandt = '001'", 10));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toMatch(/begin with SELECT/);
    expect(inner.calls).toHaveLength(0);
    conn.dispose();
  });

  it("refuses an in-text UP TO clause, naming rowNumber as the correct route", async () => {
    const { conn, inner } = await connected(() => undefined);

    const err = await catchErr(conn.dataPreviewFreestyle("SELECT * FROM t000 UP TO 10 ROWS", 10));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toMatch(/UP TO/);
    expect(err.message).toMatch(/rowNumber/);
    expect(inner.calls).toHaveLength(0);
    conn.dispose();
  });

  it("refuses an over-length statement", async () => {
    const { conn, inner } = await connected(() => undefined);
    const longSql = "SELECT " + "A".repeat(4500) + " FROM t000";

    const err = await catchErr(conn.dataPreviewFreestyle(longSql, 10));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toMatch(/longer than 4000 characters/);
    expect(inner.calls).toHaveLength(0);
    conn.dispose();
  });
});
