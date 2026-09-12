/**
 * Regression guard: "Debugger transport ignores ABAP_INSECURE and
 * proxy env vars — raw node:https bypasses the connection policy."
 *
 * The bug: the ADT stack (`src/adt/http-guard.ts` -> axios) and the debugger's
 * raw-socket stack (`src/debug/transport.ts`, used only by the long-poll and
 * its CSRF `HEAD` — every OTHER debugger request goes through `AbapConnection`
 * and was never affected) each decided TLS certificate verification
 * independently. `ABAP_INSECURE=true` reached one and not the other.
 *
 * The fix made `buildInsecureHttpsAgent` (http-guard.ts) the single source of
 * truth: `GuardedHttpClient` calls it, and `src/debug/session.ts` calls it
 * with the SAME `conn.cfg.insecure` and hands the result to
 * `DebugLongPollClient`/`createRawHttpRequestFn`.
 *
 * This file proves the two stacks actually agree — not just that they call
 * the same function (a future edit could still special-case one of them) —
 * by driving REAL sockets against a REAL self-signed HTTPS server spun up
 * locally (127.0.0.1 only; nothing here leaves the machine, so this is fully
 * offline and safe for CI). Both stacks must reject it with verification on
 * and both must accept it with verification off.
 *
 * `openssl` is used to mint the throwaway cert (present on every CI runner
 * this repo targets, and on every dev machine capable of building the repo at
 * all). If it is ever unavailable, the `beforeAll` throws with a clear
 * message rather than silently skipping the guard.
 */
import { execFileSync } from "node:child_process";
import https from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { buildHttpsAgent, buildInsecureHttpsAgent, GuardedHttpClient } from "../src/adt/http-guard.js";
import { createRawHttpRequestFn } from "../src/debug/transport.js";

let certDir: string;
let keyPath: string;
let certPath: string;
let server: https.Server;
let port: number;

beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), "abapsmith-tls-policy-"));
  keyPath = join(certDir, "key.pem");
  certPath = join(certDir, "cert.pem");
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

  server = https.createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (_req, res) => res.end("ok"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server.listen gave no port");
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(certDir, { recursive: true, force: true });
});

const baseUrl = () => `https://127.0.0.1:${port}`;

describe("buildInsecureHttpsAgent — the single source of truth", () => {
  it("returns undefined (no override) when insecure is falsy", () => {
    expect(buildInsecureHttpsAgent(undefined)).toBeUndefined();
    expect(buildInsecureHttpsAgent(false)).toBeUndefined();
  });

  it("returns an agent with rejectUnauthorized: false when insecure is true", () => {
    const agent = buildInsecureHttpsAgent(true);
    expect(agent).toBeInstanceOf(https.Agent);
    expect(agent?.options.rejectUnauthorized).toBe(false);
  });
});

describe("ADT stack and debug transport stack agree on TLS verification", () => {
  it("BOTH reject the self-signed server when insecure is not set (verification ON, the safe default)", async () => {
    const breaker = new AuthCircuitBreaker();
    const guard = new GuardedHttpClient({ baseURL: baseUrl() }, breaker);
    await expect(guard.request({ url: "/", method: "GET" })).rejects.toBeTruthy();

    const requestFn = createRawHttpRequestFn({ httpsAgent: buildInsecureHttpsAgent(undefined) });
    await expect(requestFn({ method: "GET", url: `${baseUrl()}/` })).rejects.toBeTruthy();
    // The long-poll branch (`agent: false`) is a structurally different code
    // path inside createRawHttpRequestFn — exercise it too, not just the
    // ordinary-request branch, since the original bug lived here.
    await expect(
      requestFn({ method: "POST", url: `${baseUrl()}/`, longPoll: true }),
    ).rejects.toBeTruthy();
  });

  it("BOTH accept the self-signed server when insecure: true (ABAP_INSECURE)", async () => {
    const breaker = new AuthCircuitBreaker();
    const guard = new GuardedHttpClient({ baseURL: baseUrl(), insecure: true }, breaker);
    const guardResp = await guard.request({ url: "/", method: "GET" });
    expect(guardResp.status).toBe(200);

    const sharedAgent = buildInsecureHttpsAgent(true);
    const requestFn = createRawHttpRequestFn({ httpsAgent: sharedAgent });

    const ordinary = await requestFn({ method: "GET", url: `${baseUrl()}/` });
    expect(ordinary.status).toBe(200);

    // The long-poll branch: same agent's POLICY must survive `agent: false`
    // (see the comment on `insecureOverride` in transport.ts) — this is the
    // exact call shape `DebugLongPollClient.listen()` uses.
    const longPoll = await requestFn({ method: "POST", url: `${baseUrl()}/`, longPoll: true });
    expect(longPoll.status).toBe(200);
  });
});

/**
 * Regression guard: "X.509 client-certificate auth (issue #79) is configured
 * but never actually presented on the wire."
 *
 * Everything above proves both stacks agree on SERVER verification
 * (ABAP_INSECURE / rejectUnauthorized). This block proves the orthogonal
 * half: when the CLIENT is configured with `cert`/`key` (mutual TLS), the
 * certificate is genuinely sent during the handshake — not just accepted by
 * `https.Agent`'s constructor without error. A server here is configured
 * with `requestCert: true, rejectUnauthorized: false` (so it can still
 * complete the handshake and answer even if no cert shows up) and reports,
 * via a response header, whether `req.socket.getPeerCertificate()` actually
 * observed one. Both `GuardedHttpClient` (axios) and the debug transport's
 * raw `node:https` requests are checked — including the long-poll
 * `agent: false` branch, which builds a THROWAWAY agent per request from
 * per-request options only, so it must independently carry `cert`/`key`
 * (not just `rejectUnauthorized`) or the client certificate would silently
 * stop being presented for every long-poll request.
 */
let clientCertDir: string;
let clientKeyPath: string;
let clientCertPath: string;
let serverKeyPath: string;
let serverCertPath: string;
let clientCertServer: https.Server;
let clientCertPort: number;
let clientCertPem: string;
let clientKeyPem: string;

beforeAll(async () => {
  clientCertDir = mkdtempSync(join(tmpdir(), "abapsmith-tls-clientcert-"));
  clientKeyPath = join(clientCertDir, "client-key.pem");
  clientCertPath = join(clientCertDir, "client-cert.pem");
  serverKeyPath = join(clientCertDir, "server-key.pem");
  serverCertPath = join(clientCertDir, "server-cert.pem");

  // Mint the server's own cert (separate from the outer describe block's
  // server, since that server is scoped to a different beforeAll/afterAll
  // pair and must not be touched by this extension).
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    serverKeyPath,
    "-out",
    serverCertPath,
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=localhost",
  ]);

  // Mint a second key pair to act as the CLIENT certificate.
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    clientKeyPath,
    "-out",
    clientCertPath,
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=test-client",
  ]);

  clientCertPem = readFileSync(clientCertPath, "utf8");
  clientKeyPem = readFileSync(clientKeyPath, "utf8");

  clientCertServer = https.createServer(
    {
      key: readFileSync(serverKeyPath),
      cert: readFileSync(serverCertPath),
      requestCert: true,
      rejectUnauthorized: false,
      ca: [clientCertPem],
    },
    (req, res) => {
      const peerCert = req.socket.getPeerCertificate();
      // An empty object (no `subject`) means no client certificate was
      // actually presented during the handshake.
      const presented = !!peerCert && !!peerCert.subject;
      res.setHeader("x-client-cert-presented", presented ? "yes" : "no");
      res.end("ok");
    },
  );
  await new Promise<void>((resolve) => clientCertServer.listen(0, "127.0.0.1", resolve));
  const addr = clientCertServer.address();
  if (addr === null || typeof addr === "string") throw new Error("server.listen gave no port");
  clientCertPort = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => clientCertServer.close(() => resolve()));
  rmSync(clientCertDir, { recursive: true, force: true });
});

const clientCertBaseUrl = () => `https://127.0.0.1:${clientCertPort}`;

describe("X.509 client certificate is genuinely presented on the wire (mutual TLS)", () => {
  it("a request with no client-cert TLS options presents no certificate (control case)", async () => {
    const breaker = new AuthCircuitBreaker();
    // insecure: true only to skip server-verification noise; the point of
    // this test is the ABSENCE of a client cert, which is orthogonal.
    const guard = new GuardedHttpClient({ baseURL: clientCertBaseUrl(), insecure: true }, breaker);
    const resp = await guard.request({ url: "/", method: "GET" });
    expect(resp.status).toBe(200);
    expect(resp.headers?.["x-client-cert-presented"]).toBe("no");
  });

  it("GuardedHttpClient presents the client certificate when tls.cert/tls.key are configured", async () => {
    const breaker = new AuthCircuitBreaker();
    const guard = new GuardedHttpClient(
      {
        baseURL: clientCertBaseUrl(),
        // `insecure` must live INSIDE `tls`, not as the top-level shorthand:
        // GuardedHttpClient builds its agent from
        // `this.opts.tls ?? { insecure: opts.insecure }` — supplying `tls`
        // at all makes the top-level `insecure` shorthand dead for agent
        // construction, so a bare `insecure: true` alongside `tls` here
        // would leave server-certificate verification ON and the handshake
        // would fail before the client certificate is ever exchanged.
        tls: { insecure: true, cert: clientCertPem, key: clientKeyPem },
      },
      breaker,
    );
    const resp = await guard.request({ url: "/", method: "GET" });
    expect(resp.status).toBe(200);
    // The whole point of the test: the SERVER observed a peer certificate.
    expect(resp.headers?.["x-client-cert-presented"]).toBe("yes");
  });

  it("createRawHttpRequestFn (debug transport, ordinary branch) presents the client certificate", async () => {
    const agent = buildHttpsAgent({ insecure: true, cert: clientCertPem, key: clientKeyPem });
    const requestFn = createRawHttpRequestFn({ httpsAgent: agent });
    const resp = await requestFn({ method: "GET", url: `${clientCertBaseUrl()}/` });
    expect(resp.status).toBe(200);
    expect(resp.headers?.["x-client-cert-presented"]).toBe("yes");
  });

  it("createRawHttpRequestFn (debug transport, long-poll agent:false branch) also presents the client certificate", async () => {
    // The long-poll branch forces a fresh throwaway agent built from
    // per-request options only (Node's `agent: false` semantics) — this is
    // exactly the code path that historically only carried
    // `rejectUnauthorized` and dropped `cert`/`key`/`ca`/`pfx`/`passphrase`.
    // If that regression is present, the server will report "no" here even
    // though the same options produced "yes" in the ordinary-branch test
    // above.
    const agent = buildHttpsAgent({ insecure: true, cert: clientCertPem, key: clientKeyPem });
    const requestFn = createRawHttpRequestFn({ httpsAgent: agent });
    const resp = await requestFn({
      method: "POST",
      url: `${clientCertBaseUrl()}/`,
      longPoll: true,
    });
    expect(resp.status).toBe(200);
    expect(resp.headers?.["x-client-cert-presented"]).toBe("yes");
  });
});
