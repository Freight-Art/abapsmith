/**
 * SIGINT/SIGTERM shutdown handling and listener lifecycle — regression tests for:
 *
 *  (A) `process.exit(0)` used to fire before cleanup settled, which could abort
 *      an in-flight debuggee terminate / lock release. Now `exit()` is only
 *      called after `shutdown()` settles, bounded by a deadline timer, and a
 *      second signal received mid-shutdown forces an immediate exit.
 *  (B) Every connected `AbapConnection` used to leak 3 process-level listeners
 *      (SIGINT/SIGTERM/beforeExit) with no way to remove them — confirmed
 *      cause of a `MaxListenersExceededWarning` in test runs. `dispose()` now
 *      removes them.
 *
 * All offline: a fake `HttpClient` is injected via `ConnectionOptions.httpClient`
 * (the pattern from test/session.test.ts), and `process.exit` is always replaced
 * with a `vi.fn()` stub via `ConnectionOptions.exit` — the real exit is never
 * reachable. Signals are fired synthetically via `process.emit`, which just
 * invokes registered listeners — it never kills this process.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection, type ConnectionOptions } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const OK_XML = { "content-type": "application/xml" };

class FakeAdt implements HttpClient {
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const url = o.url;
    if (url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
    if (url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
    if (url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
    return resp(200, "", OK_XML);
  }
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
  });

const live: AbapConnection[] = [];
// `ConnectionOptions.breaker` is now required, and threading it through every
// call site in this file would be noise — this helper owns it, and no test
// here needs to reach the breaker it silently injects. The `= {}` default
// stays valid: `Omit<ConnectionOptions, "breaker">` has no required keys.
async function makeConnected(opts: Omit<ConnectionOptions, "breaker"> = {}) {
  const conn = new AbapConnection(cfg(), {
    breaker: new AuthCircuitBreaker(),
    httpClient: new FakeAdt(),
    log: () => {},
    ...opts,
  });
  live.push(conn);
  await conn.connect();
  return conn;
}

afterEach(() => {
  while (live.length) live.pop()!.dispose();
});

describe("AbapConnection shutdown signal handling", () => {
  it("awaits cleanup before calling exit", async () => {
    const order: string[] = [];
    const exitStub = vi.fn();
    const conn = await makeConnected({ exit: exitStub });
    conn.onShutdown(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("cleanup-done");
    });

    process.emit("SIGINT");
    expect(exitStub).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(["cleanup-done"]);
    expect(exitStub).toHaveBeenCalledTimes(1);
    expect(exitStub).toHaveBeenCalledWith(0);
  });

  it("bounds a hung cleanup with the shutdown deadline", async () => {
    const exitStub = vi.fn();
    const conn = await makeConnected({ exit: exitStub, shutdownDeadlineMs: 20 });
    conn.onShutdown(() => new Promise(() => {}));

    process.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 45));

    expect(exitStub).toHaveBeenCalledWith(1);
  });

  it("forces exit on a second signal received mid-shutdown", async () => {
    const exitStub = vi.fn();
    const conn = await makeConnected({ exit: exitStub, shutdownDeadlineMs: 5000 });
    conn.onShutdown(() => new Promise(() => {}));

    process.emit("SIGINT");
    expect(exitStub).not.toHaveBeenCalled();
    process.emit("SIGINT");

    expect(exitStub).toHaveBeenCalledTimes(1);
    expect(exitStub).toHaveBeenCalledWith(1);
  });

  it("repeated create/connect/dispose cycles do not accumulate process listeners", async () => {
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeExit = process.listenerCount("beforeExit");

    for (let i = 0; i < 15; i++) {
      const conn = new AbapConnection(cfg(), {
        breaker: new AuthCircuitBreaker(),
        httpClient: new FakeAdt(),
        log: () => {},
        exit: vi.fn(),
      });
      await conn.connect();
      conn.dispose();
    }

    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    expect(process.listenerCount("beforeExit")).toBe(beforeExit);
  });
});
