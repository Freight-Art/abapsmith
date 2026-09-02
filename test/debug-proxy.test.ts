/**
 * Regression guard for the proxy half of a two-part fix — "raw node:https
 * bypasses proxy env vars." The TLS half (ABAP_INSECURE) already has its own guard,
 * `test/tls-policy-agreement.test.ts`; this file covers `HTTP_PROXY`/
 * `HTTPS_PROXY`/`NO_PROXY` support added to `src/debug/proxy.ts` and wired
 * into `createRawHttpRequestFn` (src/debug/transport.ts).
 *
 * Drives REAL sockets against a REAL local self-signed HTTPS server and a
 * REAL local forward-proxy double (127.0.0.1 only — fully offline, no live
 * SAP system, safe for CI):
 *
 *  - When `HTTPS_PROXY` is set, the request must route through the proxy
 *    double's `CONNECT` handler — for both the ordinary request shape and
 *    the long-poll shape (`{ longPoll: true }`), since that's the branch
 *    with the `agent: false` carve-out this fix must not reintroduce
 *    pooling into (see `planProxyRequest`'s doc comment in
 *    `src/debug/proxy.ts` for why a freshly-built-per-call Agent preserves
 *    that property even though it isn't literally `agent: false`).
 *  - When `NO_PROXY` covers the target host, the request must NOT go
 *    through the proxy — proven by pointing `HTTPS_PROXY` at an address
 *    nothing listens on: if `NO_PROXY` failed to bypass it, the request
 *    would fail/hang trying to reach that dead address instead of
 *    succeeding directly.
 *  - The classic (non-tunnelled) forward-proxy path for a plain `http:`
 *    target is covered too, since `planProxyRequest` has a second, simpler
 *    branch for it that never touches an Agent at all.
 *
 * `openssl` mints the throwaway cert, same as `test/tls-policy-agreement.test.ts`.
 */
import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildInsecureHttpsAgent } from "../src/adt/http-guard.js";
import { createRawHttpRequestFn } from "../src/debug/transport.js";
import { planProxyRequest, resolveProxyUrl } from "../src/debug/proxy.js";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of PROXY_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of PROXY_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// --- Local self-signed HTTPS target (the "ABAP system") --------------------

let certDir: string;
let httpsServer: https.Server;
let httpsPort: number;

// --- Local plain-HTTP target -------------------------------------------

let httpServer: http.Server;
let httpPort: number;

// --- Local CONNECT-capable forward-proxy double -----------------------------

interface ProxyDouble {
  server: http.Server;
  port: number;
  connectHosts: string[];
  plainRequests: { method?: string; url?: string }[];
}

function startProxyDouble(): Promise<ProxyDouble> {
  return new Promise((resolve) => {
    const connectHosts: string[] = [];
    const plainRequests: { method?: string; url?: string }[] = [];
    const server = http.createServer((req, res) => {
      // Classic forward-proxy mode: the request line carries the target's
      // absolute URL; relay it and pipe the response back verbatim.
      plainRequests.push({ method: req.method, url: req.url });
      if (!req.url) {
        res.writeHead(400).end();
        return;
      }
      const target = new URL(req.url);
      const upstream = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          method: req.method,
          headers: req.headers,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    });
    server.on("connect", (req, clientSocket, head) => {
      connectHosts.push(req.url ?? "");
      const [host, portStr] = (req.url ?? "").split(":");
      const targetSocket = net.connect(Number(portStr), host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        targetSocket.write(head);
        targetSocket.pipe(clientSocket);
        clientSocket.pipe(targetSocket);
      });
      targetSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => targetSocket.destroy());
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("proxy.listen gave no port");
      resolve({ server, port: addr.port, connectHosts, plainRequests });
    });
  });
}

let proxy: ProxyDouble;

// `Server.closeAllConnections()` doesn't reliably reach sockets handed off
// via the 'connect' event (CONNECT-tunnel sockets are detached from the
// server's normal HTTP request tracking, much like websocket upgrades) —
// track raw sockets ourselves so `afterAll` can force them closed instead of
// hanging on a graceful `server.close()` that waits for them to end on their
// own.
function trackSockets(server: http.Server | https.Server): Set<net.Socket> {
  const sockets = new Set<net.Socket>();
  server.on("connection", (s: net.Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return sockets;
}
let httpsSockets: Set<net.Socket>;
let httpSockets: Set<net.Socket>;
let proxySockets: Set<net.Socket>;

beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), "abapsmith-proxy-policy-"));
  const keyPath = join(certDir, "key.pem");
  const certPath = join(certDir, "cert.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=localhost",
  ]);

  httpsServer = https.createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (_req, res) => res.end("https-ok"),
  );
  httpsSockets = trackSockets(httpsServer);
  await new Promise<void>((resolve) => httpsServer.listen(0, "127.0.0.1", resolve));
  const httpsAddr = httpsServer.address();
  if (httpsAddr === null || typeof httpsAddr === "string") {
    throw new Error("httpsServer.listen gave no port");
  }
  httpsPort = httpsAddr.port;

  httpServer = http.createServer((_req, res) => res.end("http-ok"));
  httpSockets = trackSockets(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const httpAddr = httpServer.address();
  if (httpAddr === null || typeof httpAddr === "string") {
    throw new Error("httpServer.listen gave no port");
  }
  httpPort = httpAddr.port;

  proxy = await startProxyDouble();
  proxySockets = trackSockets(proxy.server);
});

afterAll(async () => {
  // The CONNECT-tunnel double pipes raw sockets through indefinitely once
  // established, and `Server.closeAllConnections()` doesn't reliably reach
  // sockets handed off via the 'connect' event — force-destroy every socket
  // we tracked ourselves first, or a graceful `close()` hangs waiting for
  // them to end on their own.
  for (const s of httpsSockets) s.destroy();
  for (const s of httpSockets) s.destroy();
  for (const s of proxySockets) s.destroy();
  await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await new Promise<void>((resolve) => proxy.server.close(() => resolve()));
  rmSync(certDir, { recursive: true, force: true });
});

const httpsTargetUrl = () => `https://127.0.0.1:${httpsPort}/`;
const httpTargetUrl = () => `http://127.0.0.1:${httpPort}/`;

describe("resolveProxyUrl / planProxyRequest — pure NO_PROXY / env resolution", () => {
  it("resolves to undefined with no proxy env vars set", () => {
    expect(resolveProxyUrl("https://example.com/")).toBeUndefined();
    expect(planProxyRequest(new URL("https://example.com/"), undefined)).toBeUndefined();
  });

  it("resolves HTTPS_PROXY for an https: target", () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:9999";
    expect(resolveProxyUrl("https://example.com/")).toBe("http://127.0.0.1:9999");
  });

  it("NO_PROXY covering the host suppresses the resolved proxy (matches proxy-from-env, not a local reimplementation)", () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:9999";
    process.env.NO_PROXY = "example.com";
    expect(resolveProxyUrl("https://example.com/")).toBeUndefined();
    expect(planProxyRequest(new URL("https://example.com/"), undefined)).toBeUndefined();
  });

  it("NO_PROXY leading-dot wildcard suffix matching (proxy-from-env semantics)", () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:9999";
    process.env.NO_PROXY = ".example.com";
    expect(resolveProxyUrl("https://sub.example.com/")).toBeUndefined();
    expect(resolveProxyUrl("https://example.com/")).toBe("http://127.0.0.1:9999");
  });

  it("lowercase https_proxy is honoured (common Unix convention)", () => {
    process.env.https_proxy = "http://127.0.0.1:9999";
    expect(resolveProxyUrl("https://example.com/")).toBe("http://127.0.0.1:9999");
  });

  it("a malformed *_PROXY value throws WITHOUT leaking embedded credentials into the error message", () => {
    // proxy-from-env resolves this to a non-empty string (it does no URL
    // validation itself), so `planProxyRequest`'s `new URL(...)` parse is
    // reached and fails — the credentials-redaction path under test. This
    // error's `.message` is what an MCP tool caller (an LLM) would eventually
    // see, so `secret123` must never appear in it verbatim.
    process.env.HTTPS_PROXY = "not a valid url://user:secret123@host";
    let caught: unknown;
    try {
      planProxyRequest(new URL("https://example.com/"), undefined);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : "";
    expect(message).toMatch(/Invalid proxy URL/);
    expect(message).not.toContain("secret123");
    expect(message).toContain("<redacted>");
  });
});

describe("debug transport honours HTTPS_PROXY via CONNECT tunnel", () => {
  it("routes an ordinary request through the proxy double when HTTPS_PROXY is set", async () => {
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
    const before = proxy.connectHosts.length;

    const requestFn = createRawHttpRequestFn({ httpsAgent: buildInsecureHttpsAgent(true) });
    const resp = await requestFn({ method: "GET", url: httpsTargetUrl() });
    expect(resp.status).toBe(200);
    expect(resp.body).toBe("https-ok");
    expect(proxy.connectHosts.length).toBe(before + 1);
    expect(proxy.connectHosts.at(-1)).toBe(`127.0.0.1:${httpsPort}`);
  });

  it("routes the long-poll request shape through the proxy double too (the agent:false carve-out branch)", async () => {
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
    const before = proxy.connectHosts.length;

    const requestFn = createRawHttpRequestFn({ httpsAgent: buildInsecureHttpsAgent(true) });
    // Two consecutive long-poll requests through the proxy: each must get its
    // own fresh tunnelling agent (never a shared/pooled one) and still
    // succeed — the exact property the pre-existing `agent: false` carve-out
    // protects against a pooled socket carrying stale state across requests.
    const first = await requestFn({ method: "POST", url: httpsTargetUrl(), longPoll: true });
    const second = await requestFn({ method: "POST", url: httpsTargetUrl(), longPoll: true });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(proxy.connectHosts.length).toBe(before + 2);
  });

  it("does NOT route through the proxy when NO_PROXY covers the target (bypass proven via an unreachable proxy address)", async () => {
    // Bind and immediately close a server to get a port nothing is listening
    // on. If NO_PROXY failed to bypass the (bad) proxy, the request below
    // would fail trying to reach it instead of succeeding directly.
    const deadServer = net.createServer();
    const deadPort = await new Promise<number>((resolve) => {
      deadServer.listen(0, "127.0.0.1", () => {
        const addr = deadServer.address();
        if (addr === null || typeof addr === "string") throw new Error("no port");
        resolve(addr.port);
      });
    });
    await new Promise<void>((resolve) => deadServer.close(() => resolve()));

    process.env.HTTPS_PROXY = `http://127.0.0.1:${deadPort}`;
    process.env.NO_PROXY = "127.0.0.1";
    const before = proxy.connectHosts.length;

    const requestFn = createRawHttpRequestFn({ httpsAgent: buildInsecureHttpsAgent(true) });
    const resp = await requestFn({ method: "GET", url: httpsTargetUrl() });
    expect(resp.status).toBe(200);
    expect(resp.body).toBe("https-ok");
    // The real proxy double (never referenced by env here) must have seen
    // nothing either, confirming this was a direct connection.
    expect(proxy.connectHosts.length).toBe(before);
  });
});

describe("debug transport honours HTTP_PROXY via classic forward-proxying for plain http: targets", () => {
  it("routes an http: target request through the proxy double's forward-proxy relay", async () => {
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
    const before = proxy.plainRequests.length;

    const requestFn = createRawHttpRequestFn({});
    const resp = await requestFn({ method: "GET", url: httpTargetUrl() });
    expect(resp.status).toBe(200);
    expect(resp.body).toBe("http-ok");
    expect(proxy.plainRequests.length).toBe(before + 1);
    expect(proxy.plainRequests.at(-1)?.url).toBe(httpTargetUrl());
  });

  it("does NOT route the http: target through the proxy when NO_PROXY covers it", async () => {
    const deadServer = net.createServer();
    const deadPort = await new Promise<number>((resolve) => {
      deadServer.listen(0, "127.0.0.1", () => {
        const addr = deadServer.address();
        if (addr === null || typeof addr === "string") throw new Error("no port");
        resolve(addr.port);
      });
    });
    await new Promise<void>((resolve) => deadServer.close(() => resolve()));

    process.env.HTTP_PROXY = `http://127.0.0.1:${deadPort}`;
    process.env.NO_PROXY = "127.0.0.1";
    const before = proxy.plainRequests.length;

    const requestFn = createRawHttpRequestFn({});
    const resp = await requestFn({ method: "GET", url: httpTargetUrl() });
    expect(resp.status).toBe(200);
    expect(resp.body).toBe("http-ok");
    expect(proxy.plainRequests.length).toBe(before);
  });
});
