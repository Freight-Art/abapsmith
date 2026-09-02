/**
 * `abap_data_preview` failed with "CSRF token validation failed"
 * on the very first call of a fresh session, and reported it as an
 * unrecognised, non-retryable `ADT_ERROR`. Two independent defects, fixed
 * separately:
 *
 *  - half one (routing) — `AbapConnection.dataPreviewDdic()` sent its POST
 *    through `noRetryTransport()._request()`, the transport with no autologin
 *    and no CSRF retry, instead of the shared `request()` every other POST
 *    uses. Pinned in the "half one" group below via a `RecordingAdt` fake,
 *    the same harness `csrf-duplicate-delivery.test.ts` uses.
 *  - half two (classification) — `AdtCsrfException` carries only `message`/
 *    `parent`, so `adtExceptionInfo()` returned undefined for it and
 *    `translateAdtError()` fell through to the generic "Do not retry
 *    unchanged" tail, which is backwards: the CSRF gate refuses the request
 *    before the ABAP handler runs, so a single unchanged retry is the correct
 *    recovery. Pinned in the "half two" group below.
 *
 * The "vacuity guard" group below exists because if the captured fixture
 * ever stopped being recognised as CSRF by `isCsrfError`, every assertion
 * after it would still pass for the wrong reason.
 */
import { describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { fromException, isCsrfError } from "abap-adt-api/build/AdtException.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { translateAdtError } from "../src/adt/session.js";
import { classifyPreviewFailure } from "../src/adt/datapreview.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { captured, DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

/** `src/adt/connection.ts`'s `DATA_PREVIEW_DDIC` — the ddic endpoint, not the freestyle probe path. */
const DDIC_URL = "/sap/bc/adt/datapreview/ddic";
const LOGON_URL = "/sap/bc/adt/compatibility/graph";
const DISCOVERY_URL = "/sap/bc/adt/discovery";

/** Real 403 body, 28 bytes, captured off A4H — `test/csrf-duplicate-delivery.test.ts` uses the same fixture. */
const CSRF_403_BODY = captured("078-p3-datapreview-t000.txt");
const CSRF_403_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "x-csrf-token": "Required",
};

const LOGIN_TOKEN = "TOKEN123";
const REFRESHED_TOKEN = "TOKEN-AFTER-REFRESH";
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": LOGIN_TOKEN };
const DISCOVERY_HEADERS = { "content-type": "application/xml", "x-csrf-token": REFRESHED_TOKEN };
const OK_XML = { "content-type": "application/xml" };

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

/** The CSRF rejection exactly as `AxiosHttpClient` surfaces it — see `csrf-duplicate-delivery.test.ts`. */
function csrfRejection(o: HttpClientOptions): HttpClientException {
  return new HttpClientException(
    "Request failed with status code 403",
    "ERR_BAD_REQUEST",
    403,
    undefined,
    o,
    {
      body: CSRF_403_BODY,
      status: 403,
      statusText: "Forbidden",
      headers: CSRF_403_HEADERS,
    } as unknown as HttpClientResponse,
    undefined,
  );
}

// ---------------------------------------------------------- vacuity guard ---

describe("vacuity guard: the fixture is genuinely CSRF, by the library's own predicate", () => {
  it("the captured 403 body reads as a CSRF rejection", () => {
    expect(CSRF_403_BODY).toMatch(/CSRF/);
  });

  it("isCsrfError recognises the exception built from that fixture", () => {
    // If this ever goes false, every assertion in the "half two" group below
    // is vacuous: `translateAdtError`'s `isCsrfError(e)` branch never fires.
    const exc = csrfRejection({ url: DDIC_URL, method: "POST" } as HttpClientOptions);
    expect(isCsrfError(fromException(exc, {}))).toBe(true);
  });
});

// ---------------------------------------------- half two — classification ---

describe("half two — a CSRF 403 classifies as retryable, not unrecognised", () => {
  const ctx = { operation: "read", name: "T000", type: "TABL/DT" };
  const csrfError = () =>
    fromException(csrfRejection({ url: DDIC_URL, method: "POST" } as HttpClientOptions), {});

  it("translateAdtError returns ADT_ERROR / csrf-token-rejected", () => {
    const err = translateAdtError(csrfError(), ctx);
    expect(err.code).toBe("ADT_ERROR");
    expect(err.details.reason).toBe("csrf-token-rejected");
    // A status of 403 here would make classifyPreviewFailure promote this to
    // AUTH_FAILED, mislabelling a stale token as a missing S_TABU_DIS grant.
    expect(err.details.status).toBeUndefined();
  });

  it("the message names the CSRF condition", () => {
    const err = translateAdtError(csrfError(), ctx);
    expect(err.message).toMatch(/CSRF token validation failed/);
  });

  it("the hint advises retrying, and drops the old wrong-way advice", () => {
    const err = translateAdtError(csrfError(), ctx);
    expect(err.hint ?? "").toMatch(/retry/i);
    // The exact strings the defect produced — asserted negatively so a
    // regression back to the generic tail is caught even if it also mentions "retry".
    expect(err.hint ?? "").not.toMatch(/Do not retry unchanged/);
    expect(err.hint ?? "").not.toMatch(/unrecognised response/);
  });

  it("classifyPreviewFailure leaves it ADT_ERROR, never relabels it AUTH_FAILED", () => {
    const err = classifyPreviewFailure(csrfError(), ctx);
    expect(err.code).not.toBe("AUTH_FAILED");
    expect(err.code).toBe("ADT_ERROR");
  });
});

// ----------------------------------------------------- half one — routing ---

interface Delivery {
  method: string;
  url: string;
}

/** Minimal `RecordingAdt` — the fake `HttpClient` pattern from `csrf-duplicate-delivery.test.ts`, trimmed to what this file needs. */
class RecordingAdt implements HttpClient {
  readonly deliveries: Delivery[] = [];
  private rejections = 0;

  constructor(
    private readonly route: (d: Delivery) => HttpClientResponse | undefined,
    private readonly reject: (d: Delivery) => boolean,
    private readonly maxRejections = 1,
  ) {}

  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const d: Delivery = { method: (o.method ?? "GET").toUpperCase(), url: o.url };
    this.deliveries.push(d);

    if (this.rejections < this.maxRejections && this.reject(d)) {
      this.rejections++;
      throw csrfRejection(o);
    }

    const res = this.route(d);
    if (!res) throw new Error(`RecordingAdt: unrouted ${d.method} ${d.url}`);
    return res;
  }

  /** `login()` is the only thing that requests `/compatibility/graph`. */
  get logons(): number {
    return this.deliveries.filter((d) => d.url.includes(LOGON_URL)).length;
  }

  get trace(): string[] {
    return this.deliveries.map((d) => `${d.method} ${d.url}`);
  }
}

/** Everything `connect()` needs; the T000 answer proves the system non-productive. */
const baseRoute = (d: Delivery): HttpClientResponse | undefined => {
  if (d.url.includes(LOGON_URL)) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (d.url.endsWith("/discovery")) return resp(200, "<service/>", DISCOVERY_HEADERS);
  if (d.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (d.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  if (d.url === DDIC_URL && d.method === "POST") return resp(200, "<tableData/>", DATAPREVIEW_XML);
  return undefined;
};

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

async function connected(
  reject: (d: Delivery) => boolean,
  maxRejections = 1,
): Promise<{ conn: AbapConnection; adt: RecordingAdt }> {
  const adt = new RecordingAdt(baseRoute, reject, maxRejections);
  const conn = new AbapConnection(cfg(), {
    httpClient: adt,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.deliveries.length = 0; // connect() is not under test
  return { conn, adt };
}

const isDdicPost = (d: Delivery) => d.method === "POST" && d.url === DDIC_URL;

describe("half one — dataPreviewDdic routes through the shared retrying request()", () => {
  it("resolves after a CSRF 403: refreshes the token and resends once", async () => {
    // Before the fix, dataPreviewDdic() went through noRetryTransport()._request,
    // so this rejection would have propagated with no refresh and no resend.
    const { conn, adt } = await connected(isDdicPost);

    await expect(conn.dataPreviewDdic("T000", 20)).resolves.toBeDefined();

    expect(adt.trace).toEqual([`POST ${DDIC_URL}`, `GET ${DISCOVERY_URL}`, `POST ${DDIC_URL}`]);
    expect(adt.logons).toBe(0);
    conn.dispose();
  });

  it("logs on before the POST on a genuinely fresh session — the reported symptom", async () => {
    const { conn, adt } = await connected(() => false);
    conn.adt.httpClient.csrfToken = "fetch"; // `loggedin` is `csrfToken !== "fetch"`

    await expect(conn.dataPreviewDdic("T000", 20)).resolves.toBeDefined();

    // Before the fix this trace was the bare POST with no preceding token
    // fetch — that omission was the whole defect.
    expect(adt.trace).toEqual([`GET ${LOGON_URL}`, `POST ${DDIC_URL}`]);
    conn.dispose();
  });
});
