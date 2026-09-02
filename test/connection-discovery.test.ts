/**
 * Discovery-probe degradation on connect — regression tests.
 *
 * The defect: `connect()` ran the discovery probe as
 * `await this.discovery.load().catch(log)`. The rejection was swallowed, and
 * nothing above the connection could tell that it had happened. The capability
 * map is then EMPTY — and an empty map read without its state does not make the
 * server say "I could not determine this system's capabilities", it makes the
 * server say, confidently, "unsupported". A wrong confident answer is worse
 * than an error.
 *
 * What is pinned here:
 *  1. a failed probe is still NON-FATAL — `connect()` completes (turning a soft
 *     degradation into a hard connect failure is its own regression);
 *  2. "empty because the probe failed" and "empty because the system listed no
 *     collections" are DISTINGUISHABLE at runtime — both report
 *     `discoveryCollections: 0`, so the count alone can never be the answer;
 *  3. the underlying error text reaches the log, together with what it costs;
 *  4. a capability question answers `"unknown"`, never `"unsupported"`.
 *
 * All offline: a fake `HttpClient` is injected via `ConnectionOptions.httpClient`
 * (the pattern from test/connection-signals.test.ts and
 * test/system-role-detection.test.ts). Nothing here touches a real system.
 */
import { afterEach, describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const OK_XML = { "content-type": "application/xml" };

/** The transport error the probe dies on — its text must survive to the log. */
const PROBE_ERROR = "socket hang up while reading /sap/bc/adt/discovery";

/**
 * Logs on normally, then either rejects the `/discovery` GET or answers it with
 * a well-formed but collection-less service document. Everything else answers
 * 200 so `connect()` can run to completion.
 */
class FakeAdt implements HttpClient {
  constructor(private readonly discoveryMode: "reject" | "empty") {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const url = o.url;
    if (url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
    if (url.endsWith("/discovery")) {
      if (this.discoveryMode === "reject") throw new Error(PROBE_ERROR);
      return resp(200, "<service/>", OK_XML);
    }
    return resp(200, "<settings/>", OK_XML);
  }
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
  });

const live: AbapConnection[] = [];

async function connect(mode: "reject" | "empty") {
  const logs: string[] = [];
  const conn = new AbapConnection(cfg(), {
    httpClient: new FakeAdt(mode),
    log: (m) => logs.push(m),
    exit: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  live.push(conn);
  const info = await conn.connect();
  return { conn, info, logs };
}

afterEach(() => {
  while (live.length) live.pop()!.dispose();
});

describe("connect() when the discovery probe rejects", () => {
  it("still connects — a missing capability map is a degradation, not a failure", async () => {
    const { conn, info } = await connect("reject");

    expect(conn.isConnected).toBe(true);
    expect(info.connected).toBe(true);
    // connect() ran past the probe: role detection happened.
    expect(info.roleDetection.reason).not.toMatch(/Not connected yet/);
    // ...and the failure is on the record rather than swallowed.
    expect(info.discoveryState).toBe("failed");
  });

  it("reports the failure and its cause through info()", async () => {
    const { info } = await connect("reject");

    expect(info.discoveryState).toBe("failed");
    expect(info.discoveryError).toContain(PROBE_ERROR);
  });

  it("does not look like a system that simply has no collections", async () => {
    const failed = await connect("reject");
    const empty = await connect("empty");

    // The count is identical — which is exactly why it cannot be the answer.
    expect(failed.info.discoveryCollections).toBe(0);
    expect(empty.info.discoveryCollections).toBe(0);
    expect(failed.info.discoveryCollections).toBe(empty.info.discoveryCollections);

    // The state is not.
    expect(failed.info.discoveryState).toBe("failed");
    expect(empty.info.discoveryState).not.toBe("failed");
    expect(failed.info.discoveryState).not.toBe(empty.info.discoveryState);

    // And only the failed one carries an error.
    expect(failed.info.discoveryError).toBeTruthy();
    expect(empty.info.discoveryError).toBeUndefined();
  });

  it("logs the underlying error text AND what the failure costs", async () => {
    const { logs } = await connect("reject");

    const line = logs.find((l) => l.includes("discovery"));
    expect(line, "no discovery line was logged at all").toBeTruthy();
    // The cause must be in there verbatim...
    expect(line).toContain(PROBE_ERROR);
    // ...and the log must not read as "handled, nothing to see here": the
    // consequence (no capability inventory) is the operator-relevant part.
    expect(line!.toLowerCase()).toMatch(/unavailable|unknown/);
  });

  it("answers capability questions with 'unknown', never 'unsupported'", async () => {
    const { conn, info } = await connect("reject");

    expect(conn.discovery.capability("atc")).toBe("unknown");
    // Fail-open gate: an unloadable inventory must not block an attempt.
    expect(conn.discovery.maySupport("atc")).toBe(true);
    expect(() => conn.discovery.assertSupported("atc")).not.toThrow();
    // The definitive accessor refuses to guess.
    expect(() => conn.discovery.supports("atc")).toThrow(/discovery probe/i);

    // ...and a caller holding only the ConnectionInfo can reach the same
    // conclusion, which is the part that used to be impossible.
    expect(info.discoveryState).toBe("failed");
    expect(conn.discoveryState).toBe("failed");
  });
});

describe("connect() when the discovery probe succeeds but lists nothing", () => {
  it("records 'empty' with no error — the probe answered, we just do not believe it", async () => {
    const { conn, info } = await connect("empty");

    expect(info.connected).toBe(true);
    expect(info.discoveryState).toBe("empty");
    expect(info.discoveryError).toBeUndefined();
    // An unbelievable inventory is still not evidence of absence.
    expect(conn.discovery.capability("atc")).toBe("unknown");
  });
});
