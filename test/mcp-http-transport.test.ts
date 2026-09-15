/**
 * The Streamable HTTP MCP transport end to end (issue #81):
 * `AbapsmithServer.start()`/`stop()` binding a real loopback socket, a real
 * `@modelcontextprotocol/sdk` `Client` talking `StreamableHTTPClientTransport`
 * to it, and raw `fetch` probes of the auth/path/method edges `src/mcp-http.ts`
 * is responsible for.
 *
 * ## Why this file exists, beyond `test/mcp-http-auth.test.ts`
 *
 * That file proves the bearer-check FUNCTION is correct in isolation. It
 * proves nothing about whether the function is actually wired into the HTTP
 * request path, whether `stdio` stays the untouched default, whether one
 * process really can serve several independent MCP sessions sharing one
 * ADT pool/journal, or whether the listener genuinely stops accepting
 * connections when `stop()` is called. Those are exactly the ways "the unit
 * works" and "the feature works" can diverge, so this file drives the real
 * `createServer` + real `start()`/`stop()` against a real loopback socket,
 * modelled on `test/server-startup-probe.test.ts`'s idiom for that (`cfg()`,
 * `scaffold()`, `build()`, the `warn`-collecting `log` function, a
 * `mkdtempSync` journal dir).
 *
 * Every server built anywhere in this file is `stop()`-ped in `afterEach`,
 * and every MCP client connected is `close()`-d before the test ends (or in
 * `afterEach`), so no test here leaves a listening socket, a session
 * timer/heartbeat, or a process listener behind — see the HARD RULES this
 * suite was commissioned under.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { createServer, type AbapsmithServer } from "../src/server.js";
import { Journal } from "../src/journal.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { FakeAdtServer, __resetFakeAdtCounters, type FakeRoute } from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, routeSystemRoleProbe, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { loadCtsFixture } from "./helpers/cts-fixtures.js";

// ---------------------------------------------------------------------------
// Shared fixtures — same shape as test/server-startup-probe.test.ts
// ---------------------------------------------------------------------------

const systemRoleRoute: FakeRoute = (r) =>
  r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined;

const cfg = (over: Partial<Config> = {}): Config => ({
  ...ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "hunter2",
    sid: "TST",
    client: "001",
  }),
  // Keeps the fake's request count out of these assertions — this suite is
  // about the HTTP transport, not the startup probe (already covered by
  // test/server-startup-probe.test.ts).
  startupProbe: false,
  ...over,
});

const scaffold = (before: FakeRoute[] = []): FakeAdtServer =>
  new FakeAdtServer({ routes: [...before, systemRoleRoute] });

let openServers: AbapsmithServer[] = [];
let openClients: Client[] = [];
let journalDir = "";
let warnings: string[] = [];

function log(m: string): void {
  warnings.push(m);
}

async function build(config: Config, server: FakeAdtServer, extra: Record<string, unknown> = {}): Promise<AbapsmithServer> {
  const srv = createServer(config, {
    breaker: new AuthCircuitBreaker(),
    ...extra,
    httpClient: (extra.httpClient as HttpClient | undefined) ?? server.client(),
    log,
    journal: new Journal({ dir: journalDir, enabled: true, maxEntries: 100, maxAgeDays: 30 }, config.sid),
  });
  openServers.push(srv);
  return srv;
}

/** Connects a real MCP client over Streamable HTTP; tracked for afterEach cleanup. */
async function connectClient(port: number, path: string, token?: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}${path}`),
    token !== undefined ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : undefined,
  );
  const client = new Client({ name: "test-http-mcp-client", version: "0.0.0" });
  await client.connect(transport);
  openClients.push(client);
  return { client, transport };
}

beforeEach(() => {
  __resetFakeAdtCounters();
  openServers = [];
  openClients = [];
  warnings = [];
  journalDir = mkdtempSync(join(tmpdir(), "abapsmith-mcp-http-transport-"));
});

afterEach(async () => {
  for (const client of openClients) {
    await client.close().catch(() => {});
  }
  openClients = [];
  for (const srv of openServers) {
    await srv.stop().catch(() => {});
  }
  openServers = [];
  rmSync(journalDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. stdio stays the default
// ---------------------------------------------------------------------------

describe("stdio remains the default transport", () => {
  it("a server built without mcpTransport: 'http' has no http address after start(), and zero mcp sessions", async () => {
    const server = scaffold();
    const srv = await build(cfg(), server);

    await srv.start();

    expect(srv.httpAddress).toBeUndefined();
    expect(srv.mcpSessionCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. One binary, one env var: http transport binds and announces itself
// ---------------------------------------------------------------------------

describe("ABAP_MCP_TRANSPORT=http binds a real loopback listener", () => {
  it("start() binds a real port and the ready banner names it, the SID, and the user", async () => {
    const server = scaffold();
    const srv = await build(cfg({ mcpTransport: "http", mcpHttpHost: "127.0.0.1", mcpHttpPort: 0 }), server);

    await srv.start();

    expect(srv.httpAddress).toBeDefined();
    expect(srv.httpAddress!.port).toBeGreaterThan(0);
    const readyLine = warnings.find((w) => w.includes("ready on http://127.0.0.1:") && w.includes("/mcp"));
    expect(readyLine, `no http-ready banner in: ${JSON.stringify(warnings)}`).toBeDefined();
    expect(readyLine).toContain(String(srv.httpAddress!.port));
    expect(readyLine).toContain("TST");
    expect(readyLine).toContain("TESTUSER");
  });
});

// ---------------------------------------------------------------------------
// 3. Tool surface parity
// ---------------------------------------------------------------------------

describe("a connected HTTP session sees the full tool surface", () => {
  it("listTools() includes abap_read and abap_search, not a reduced set", async () => {
    const server = scaffold();
    const srv = await build(cfg({ mcpTransport: "http", mcpHttpHost: "127.0.0.1", mcpHttpPort: 0 }), server);
    await srv.start();

    const { client } = await connectClient(srv.httpAddress!.port, "/mcp");
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("abap_read");
    expect(names).toContain("abap_search");
  });
});

// ---------------------------------------------------------------------------
// 4. Several MCP sessions, one process
// ---------------------------------------------------------------------------

describe("one process serves several concurrent MCP sessions", () => {
  it("two connected clients each list tools, get distinct session ids, and mcpSessionCount is 2 while both are open", async () => {
    const server = scaffold();
    const srv = await build(cfg({ mcpTransport: "http", mcpHttpHost: "127.0.0.1", mcpHttpPort: 0 }), server);
    await srv.start();
    const port = srv.httpAddress!.port;

    const a = await connectClient(port, "/mcp");
    const b = await connectClient(port, "/mcp");

    await expect(a.client.listTools()).resolves.toBeDefined();
    await expect(b.client.listTools()).resolves.toBeDefined();

    expect(a.transport.sessionId, "session A got no transport session id").toBeDefined();
    expect(b.transport.sessionId, "session B got no transport session id").toBeDefined();
    expect(a.transport.sessionId).not.toBe(b.transport.sessionId);

    expect(srv.mcpSessionCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. Auth required
// ---------------------------------------------------------------------------

describe("bearer auth guards the HTTP transport when tokens are configured", () => {
  it("a client with no Authorization header cannot connect", async () => {
    const server = scaffold();
    const srv = await build(
      cfg({
        mcpTransport: "http",
        mcpHttpHost: "127.0.0.1",
        mcpHttpPort: 0,
        mcpHttpTokens: [{ name: "alice", value: "s3cr3t" }],
      }),
      server,
    );
    await srv.start();

    await expect(connectClient(srv.httpAddress!.port, "/mcp")).rejects.toBeDefined();
  });

  it("a raw fetch POST with no Authorization header gets 401, a Bearer challenge, and a body without the token value", async () => {
    const server = scaffold();
    const srv = await build(
      cfg({
        mcpTransport: "http",
        mcpHttpHost: "127.0.0.1",
        mcpHttpPort: 0,
        mcpHttpTokens: [{ name: "alice", value: "s3cr3t" }],
      }),
      server,
    );
    await srv.start();
    const { host, port } = srv.httpAddress!;

    const res = await fetch(`http://${host}:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    const body = await res.text();
    expect(body).not.toContain("s3cr3t");
  });

  it("a client presenting the correct Bearer token connects and lists tools", async () => {
    const server = scaffold();
    const srv = await build(
      cfg({
        mcpTransport: "http",
        mcpHttpHost: "127.0.0.1",
        mcpHttpPort: 0,
        mcpHttpTokens: [{ name: "alice", value: "s3cr3t" }],
      }),
      server,
    );
    await srv.start();

    const { client } = await connectClient(srv.httpAddress!.port, "/mcp", "s3cr3t");
    await expect(client.listTools()).resolves.toBeDefined();
  });

  it("a raw fetch with the wrong Bearer token gets 401", async () => {
    const server = scaffold();
    const srv = await build(
      cfg({
        mcpTransport: "http",
        mcpHttpHost: "127.0.0.1",
        mcpHttpPort: 0,
        mcpHttpTokens: [{ name: "alice", value: "s3cr3t" }],
      }),
      server,
    );
    await srv.start();
    const { host, port } = srv.httpAddress!;

    const res = await fetch(`http://${host}:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 6. Wrong path
// ---------------------------------------------------------------------------

describe("a request to any path other than the configured one is not found", () => {
  it("a raw fetch to /nope returns 404", async () => {
    const server = scaffold();
    const srv = await build(cfg({ mcpTransport: "http", mcpHttpHost: "127.0.0.1", mcpHttpPort: 0 }), server);
    await srv.start();
    const { host, port } = srv.httpAddress!;

    const res = await fetch(`http://${host}:${port}/nope`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 7. Method not allowed
// ---------------------------------------------------------------------------

describe("an unsupported HTTP method on the MCP path is rejected", () => {
  it("a raw fetch with method PUT returns 405 with an allow header", async () => {
    const server = scaffold();
    const srv = await build(cfg({ mcpTransport: "http", mcpHttpHost: "127.0.0.1", mcpHttpPort: 0 }), server);
    await srv.start();
    const { host, port } = srv.httpAddress!;

    const res = await fetch(`http://${host}:${port}/mcp`, { method: "PUT" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 8. Session teardown: DELETE, not disconnect
// ---------------------------------------------------------------------------

describe("a Streamable HTTP session ends on DELETE, not when the client disconnects", () => {
  it("client.close() alone leaves the session live — a dropped connection is not a session termination", async () => {
    const server = scaffold();
    const srv = await build(cfg({ mcpTransport: "http", mcpHttpHost: "127.0.0.1", mcpHttpPort: 0 }), server);
    await srv.start();

    const { client } = await connectClient(srv.httpAddress!.port, "/mcp");
    await client.listTools();
    expect(srv.mcpSessionCount).toBe(1);

    // client.close() only drops the client's end of the HTTP connection; it
    // does not send DELETE. Only StreamableHTTPClientTransport.terminateSession()
    // does that (its doc comment: "sending a DELETE request to the server" /
    // "HTTP DELETE to the MCP endpoint with the Mcp-Session-Id header to
    // explicitly terminate the session" — streamableHttp.d.ts). Per the
    // Streamable HTTP spec, session state is server-side and keyed by
    // Mcp-Session-Id, so it correctly outlives a merely-disconnected client.
    await client.close();
    openClients = openClients.filter((c) => c !== client);

    // No polling here on purpose: nothing async is expected to change this
    // count, so we assert the state immediately rather than waiting for a
    // drop that closing alone should never produce.
    expect(srv.mcpSessionCount, "close() alone must not terminate the server-side session").toBe(1);
  });

  it("transport.terminateSession() sends the DELETE that ends the session, and the dead session id is then rejected", async () => {
    const server = scaffold();
    const srv = await build(cfg({ mcpTransport: "http", mcpHttpHost: "127.0.0.1", mcpHttpPort: 0 }), server);
    await srv.start();
    const { host, port } = srv.httpAddress!;

    const { client, transport } = await connectClient(port, "/mcp");
    await client.listTools();
    expect(srv.mcpSessionCount).toBe(1);
    const deadSessionId = transport.sessionId;
    expect(deadSessionId).toBeDefined();

    await transport.terminateSession();

    let count = srv.mcpSessionCount;
    for (let i = 0; i < 50 && count !== 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      count = srv.mcpSessionCount;
    }
    expect(count, "mcpSessionCount did not drop back to 0 after terminateSession()").toBe(0);

    // client.close() in afterEach must still be safe to call after
    // terminateSession() already tore the session down server-side — the
    // SDK's close() only tears down the client's own local state, so this
    // is not a double-DELETE, just a normal local cleanup.
    await client.close();
    openClients = openClients.filter((c) => c !== client);

    // A POST carrying a dead/unknown mcp-session-id is NOT looked up and
    // delegated (that only happens for a session still in the live map);
    // src/mcp-http.ts's POST branch then checks isInitializeRequest(body) —
    // false here — and falls through to a 400 "no valid MCP session id, and
    // this is not an initialize request", not a 404. 404 on this path is
    // reserved for GET/DELETE against an unrecognised session (see the
    // "method === GET || method === DELETE" branch); a POST with a body
    // that isn't a session-continuation or an initialize is a malformed
    // request from this endpoint's point of view, which 400 fits better.
    const res = await fetch(`http://${host}:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": deadSessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
    });
    expect(res.status).toBe(400);
  });

  it("a GET against a dead/unknown mcp-session-id is rejected with 404", async () => {
    const server = scaffold();
    const srv = await build(cfg({ mcpTransport: "http", mcpHttpHost: "127.0.0.1", mcpHttpPort: 0 }), server);
    await srv.start();
    const { host, port } = srv.httpAddress!;

    const res = await fetch(`http://${host}:${port}/mcp`, {
      method: "GET",
      headers: { accept: "text/event-stream", "mcp-session-id": "not-a-real-session-id" },
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 9. Journal attribution across sessions — the point of the issue
// ---------------------------------------------------------------------------

describe("each HTTP session's journalled action is attributed to its own authenticated caller", () => {
  const writeCfg = (): Config =>
    cfg({
      readOnly: false,
      allowPackages: ["Z_FLIGHT_ADDITIONAL"],
      allowTransports: ["*"],
      mcpTransport: "http",
      mcpHttpHost: "127.0.0.1",
      mcpHttpPort: 0,
      mcpHttpTokens: [
        { name: "alice", value: "a-secret" },
        { name: "bob", value: "b-secret" },
      ],
    });

  /** Same CTS-create fixture wiring as test/journal-actor.test.ts's ctsHttp() — the cheapest journalled action this codebase's fixtures support. */
  const ctsHttp = (): HttpClient => {
    const fixture = loadCtsFixture("create-transport-response");
    const inner = {
      request: async (o: HttpClientOptions): Promise<HttpClientResponse> => {
        if (typeof o.url === "string" && o.url.includes(fixture.meta.url)) {
          return {
            status: fixture.meta.status,
            statusText: fixture.meta.statusText,
            body: fixture.body,
            headers: fixture.meta.responseHeaders,
          } as unknown as HttpClientResponse;
        }
        return {
          status: 200,
          statusText: "OK",
          body: "ok",
          headers: { "content-type": "text/plain", "x-csrf-token": "TOKEN" },
        } as unknown as HttpClientResponse;
      },
    } as unknown as HttpClient;
    return routeSystemRoleProbe(inner, { answer: "nonproductive" });
  };

  it("two sessions authenticated with different tokens each journal their own transport-create action under their own name", async () => {
    const server = scaffold();
    const srv = await build(writeCfg(), server, { httpClient: ctsHttp() });
    await srv.start();
    const port = srv.httpAddress!.port;

    const alice = await connectClient(port, "/mcp", "a-secret");
    const bob = await connectClient(port, "/mcp", "b-secret");

    const call = (client: Client, description: string) =>
      client.callTool({
        name: "abap_transport",
        arguments: { operation: "create", package: "Z_FLIGHT_ADDITIONAL", description },
      }) as unknown as Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;

    const [aliceRes, bobRes] = await Promise.all([
      call(alice.client, "abapsmith http transport journal wiring — alice"),
      call(bob.client, "abapsmith http transport journal wiring — bob"),
    ]);
    expect(aliceRes.isError ?? false, aliceRes.content[0]?.text ?? "(no content)").toBe(false);
    expect(bobRes.isError ?? false, bobRes.content[0]?.text ?? "(no content)").toBe(false);

    const entries = await srv.journal.list();
    expect(entries).toHaveLength(2);
    const actors = entries.map((e) => e.actor).sort();
    expect(actors).toEqual(["alice", "bob"]);
  });
});

// ---------------------------------------------------------------------------
// 10. stop() closes the listener
// ---------------------------------------------------------------------------

describe("stop() closes the HTTP listener", () => {
  it("after stop(), the port refuses connections and mcpSessionCount is 0", async () => {
    const server = scaffold();
    const srv = await build(cfg({ mcpTransport: "http", mcpHttpHost: "127.0.0.1", mcpHttpPort: 0 }), server);
    await srv.start();
    const { host, port } = srv.httpAddress!;

    await srv.stop();
    openServers = openServers.filter((s) => s !== srv);

    let threw = false;
    try {
      await fetch(`http://${host}:${port}/mcp`, { method: "POST" });
    } catch {
      threw = true;
    }
    expect(threw, "fetch to a stopped listener's port should have rejected").toBe(true);
    expect(srv.mcpSessionCount).toBe(0);
  });
});
