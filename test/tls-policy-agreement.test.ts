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
import { buildInsecureHttpsAgent, GuardedHttpClient } from "../src/adt/http-guard.js";
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
