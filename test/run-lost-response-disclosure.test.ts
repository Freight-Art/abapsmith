/**
 * `runClass` is the choke point for every classrun bridge (BOPF/DDIC/
 * enhancement/FPM/UI runtime, all mutating). When the failure means the POST
 * may already have reached and run on the server — session death, or a
 * transport failure with no HTTP response at all — the thrown error's hint
 * must say so without changing its code. A plain 4xx that arrived before
 * execution (the class never ran) must not get that disclosure.
 *
 * Offline only, same seam as test/run.test.ts: the transport is faked
 * through `ConnectionOptions.httpClient`.
 */
import { describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError } from "../src/adt/errors.js";
import { runClass } from "../src/adt/run.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
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

const responder =
  (classrun: (o: HttpClientOptions) => HttpClientResponse) =>
  (o: HttpClientOptions): HttpClientResponse => {
    if (o.url.startsWith(CLASSRUN)) return classrun(o);
    if (o.url.includes(SESSION_URL)) {
      return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
    }
    return resp(200, "<ok/>", { "content-type": "application/xml" });
  };

async function connected(
  classrun: (o: HttpClientOptions) => HttpClientResponse,
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(responder(classrun));
  const conn = new AbapConnection(cfg(), {
    httpClient: routeSystemRoleProbe(inner, { answer: "nonproductive" }),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner };
}

/** Same hand-modelled 400 page as test/run.test.ts's SESSION_TIMEOUT_PAGE. */
const SESSION_TIMEOUT_PAGE =
  `<!DOCTYPE html><html><head><title>Session Timed Out</title></head><body>` +
  `<h1>400 Session Timed Out</h1><p>Session no longer exists</p>` +
  `${"<p>&nbsp;</p>".repeat(200)}</body></html>`;

const DISCLOSURE = /may already have executed and committed/;

describe("runClass mutation-risk disclosure", () => {
  it("appends the may-have-executed disclosure to a SESSION_DEAD hint, code unchanged", async () => {
    const { conn } = await connected(() =>
      resp(400, SESSION_TIMEOUT_PAGE, { "content-type": "text/html" }, "Bad Request"),
    );

    const err = await runClass(conn, "ZCL_ZMCP_PROBE").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    if (!isAbapError(err)) return;
    expect(err.code).toBe("SESSION_DEAD");
    expect(err.hint).toMatch(DISCLOSURE);
    expect(err.hint).toMatch(/do not blindly retry a mutating bridge/);
    expect(err.hint).toMatch(/re-read the object/i);
    expect(err.details.mayHaveExecuted).toBe(true);
  });

  it("appends the same disclosure when the transport loses the response entirely (no HTTP response at all)", async () => {
    const inner = new RecordingClient(responder(() => resp(200, "unused")));
    const throwing: HttpClient = {
      request: async (o) => {
        if (o.url.startsWith(CLASSRUN)) throw new Error("socket hang up");
        return inner.request(o);
      },
    };
    const conn = new AbapConnection(cfg(), {
      httpClient: routeSystemRoleProbe(throwing, { answer: "nonproductive" }),
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    await conn.connect();

    const err = await runClass(conn, "ZCL_ZMCP_PROBE").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    if (!isAbapError(err)) return;
    expect(err.hint).toMatch(DISCLOSURE);
    expect(err.hint).toMatch(/do not blindly retry a mutating bridge/);
    expect(err.details.mayHaveExecuted).toBe(true);
  });

  it("does not disclose mutation risk for a plain 4xx that arrived before execution (class never ran)", async () => {
    const inner = new RecordingClient(responder(() => resp(200, "unused")));
    const throwing: HttpClient = {
      request: async (o) => {
        if (o.url.startsWith(CLASSRUN)) {
          const r = resp(404, "not found");
          throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
        }
        return inner.request(o);
      },
    };
    const conn = new AbapConnection(cfg(), {
      httpClient: routeSystemRoleProbe(throwing, { answer: "nonproductive" }),
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    await conn.connect();

    const err = await runClass(conn, "ZCL_ZMCP_PROBE").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    if (!isAbapError(err)) return;
    expect(err.code).not.toBe("SESSION_DEAD");
    expect(err.hint ?? "").not.toMatch(DISCLOSURE);
    expect(err.details.mayHaveExecuted).toBeUndefined();
  });

  it("leaves the RUNTIME_DUMP hint untouched, still within the 550-char budget", async () => {
    const dumpPage = (shortText = "Division by zero"): string =>
      `<!DOCTYPE html><html><head><title>Application Server Error</title>
<style type="text/css">${"body{font-family:Arial;} .err{color:#c00;} ".repeat(400)}</style>
</head><body>
<div class="err"><h1>500 Internal Server Error</h1>
<p>Error: ${shortText} (termination: RABAX_STATE)</p>
<p class="detailText"><span id="msgText">Server time:
<script>
var d = "20260731";
var t = "130257";
document.write(d.slice(0,4)+"-"+d.slice(4,6)+"-"+d.slice(6,8)+" "+t.slice(0,2)+":"+t.slice(2,4)+":"+t.slice(4,6));
</script>
</span></p>
<p>What has happened? The URL http://sapa4h:50000/sap/bc/adt/oo/classrun/ZCL_ZMCP_PROBE
was not called due to an error.</p>
<p>Please contact your system administrator.</p>
</div></body></html>`;
    const { conn } = await connected(() =>
      resp(500, dumpPage(), { "content-type": "text/html; charset=utf-8", connection: "close" }),
    );

    const err = await runClass(conn, "ZCL_ZMCP_PROBE").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    if (!isAbapError(err)) return;
    expect(err.code).toBe("RUNTIME_DUMP");
    expect(err.hint ?? "").not.toMatch(DISCLOSURE);
    expect(err.hint!.length).toBeLessThanOrEqual(550);
  });
});
