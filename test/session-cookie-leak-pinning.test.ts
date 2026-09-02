/**
 * `ABAP_SESSION_COOKIE` leak pinning across every sink that can reach
 * a log line, a file, or the model.
 *
 * A session cookie authenticates as the user with NO password — exactly as
 * sensitive as `ABAP_PASSWORD`. This is not config/transport coverage (see
 * `test/config-session-cookie.test.ts` and `test/adt-cookie-injection.test.ts`
 * for that); every test here drives a DIFFERENT downstream sink with a real
 * cookie-mode `Config` built through `loadConfig()`, and asserts the sentinel
 * cookie value cannot be found in whatever that sink produced.
 *
 * Offline throughout — no live SSO system exists to verify this against
 * (the A4H appliance does not do SSO); these are unit tests against fakes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";

import { loadConfig, redactConfigSecrets } from "../src/config.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { isAbapError, describeUnknownError } from "../src/adt/errors.js";
import { BODY_DUMP_DIR_ENV, captureErrorBody, redactUrlForCapture } from "../src/error-capture.js";
import { journalConfigFromEnv } from "../src/journal.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

const SENTINEL = "s3cr3t-do-not-log";
const PASSWORD_SENTINEL = "pw-do-not-log";

/** Minimal env for a cookie-mode config, matching config-session-cookie.test.ts's idiom. */
const env = (over: Record<string, string> = {}): Record<string, string> => ({
  ABAP_URL: "http://sap.invalid:50000",
  ABAP_USER: "DEVELOPER",
  ABAP_SESSION_COOKIE: `MYSAPSSO2=${SENTINEL}`,
  ...over,
});

/** A real cookie-mode Config, built through the real loader — never a hand-rolled object. */
const cookieModeCfg = (over: Record<string, string> = {}) =>
  loadConfig({ env: env(over), warn: () => {}, skipDotenv: true });

// ---------------------------------------------------------------------------
// Sink 1 — the startup banner (src/index.ts, ~62-64)
// ---------------------------------------------------------------------------
// `main()` in src/index.ts is not exported, is guarded from firing under a
// test runner (`invokedAsProgram()`), and does far more than print the
// banner (loads config, starts the whole server) — not practical to invoke
// directly from a unit test. Reproducing the exact banner expression against
// a real `loadConfig()`-produced cookie-mode Config below.

describe("sink 1 — startup banner (src/index.ts ~62-64)", () => {
  // Reproduces the exact banner expression against a real loadConfig()
  // cookie-mode Config (see file header for why main() itself is not called).
  it("the banner never contains the cookie value", () => {
    const cfg = cookieModeCfg();
    const banner = `[abapsmith] config (secrets redacted; host, user and SID are not): ${JSON.stringify(redactConfigSecrets(cfg))}\n`;
    expect(banner).not.toContain(SENTINEL);
    expect(banner).toContain('"sessionCookie":"***"');
  });
});

// ---------------------------------------------------------------------------
// Sink 2 — error-capture forensic dump (src/error-capture.ts), gated on
// ABAPSMITH_BODY_DUMP_DIR
// ---------------------------------------------------------------------------

describe("sink 2 — error-capture forensic dump (src/error-capture.ts)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    delete process.env[BODY_DUMP_DIR_ENV];
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const captureFiles = (dir: string): string[] =>
    readdirSync(dir).filter((f) => f.startsWith("adt-error-"));

  // Worst case: the transport echoes the guard-injected cookie header back
  // onto the exception it throws, on both .config.headers and .request.
  it("never writes the cookie from .config.headers or .request", () => {
    const dumpDir = mkdtempSync(join(tmpdir(), "abapsmith-cookie-leak-"));
    dirs.push(dumpDir);
    process.env[BODY_DUMP_DIR_ENV] = dumpDir;

    const thrown = new HttpClientException(
      "Request failed with status code 401",
      "ERR_BAD_REQUEST",
      401,
      { headers: { Cookie: `MYSAPSSO2=${SENTINEL}` } } as unknown as HttpClientOptions,
      { url: "/sap/bc/adt/compatibility/graph", headers: { Cookie: `MYSAPSSO2=${SENTINEL}` } } as unknown as HttpClientOptions,
      { status: 401, statusText: "401", body: "logon failed", headers: {} } as unknown as HttpClientResponse,
      undefined,
    );

    const written = captureErrorBody("test", "/sap/bc/adt/compatibility/graph", thrown);
    expect(written).toBeDefined();
    const files = captureFiles(dumpDir);
    expect(files).toHaveLength(1);
    const text = readFileSync(join(dumpDir, files[0]!), "utf8");
    expect(text).not.toContain(SENTINEL);
  });

  it("redacts a cookie-shaped query parameter", () => {
    const redacted = redactUrlForCapture(`/sap/bc/adt/foo?sap-session=${SENTINEL}&other=1`);
    expect(redacted).not.toContain(SENTINEL);
    expect(redacted).toContain("sap-session=[redacted]");
    expect(redacted).toContain("other=1");
  });
});

// ---------------------------------------------------------------------------
// Sink 3 — the journal (src/journal.ts)
// ---------------------------------------------------------------------------
// `JournalEntry` (and every other journal-writing interface) has no field
// capable of holding a Config or a credential — the journal records ABAP
// object write before/after images, never connection secrets. The one place
// env (which could carry ABAP_SESSION_COOKIE) flows into anything
// journal-related is `journalConfigFromEnv`; pinned narrowly below.
// Journal blob-content credential safety is already covered by
// test/transport-tools.test.ts (every blobs/ entry read back as UTF-8).

describe("sink 3 — journalConfigFromEnv (src/journal.ts)", () => {
  // ABAP_SESSION_COOKIE is present in env alongside every other journal knob.
  it("never surfaces the cookie via journalConfigFromEnv", () => {
    const cfg = journalConfigFromEnv(
      {
        ABAP_SESSION_COOKIE: `MYSAPSSO2=${SENTINEL}`,
        ABAP_JOURNAL: "on",
        ABAP_JOURNAL_DIR: "./.abapsmith/journal",
        ABAP_ACTOR: "tester",
      } as NodeJS.ProcessEnv,
      "A4H",
      "/tmp",
    );
    expect(JSON.stringify(cfg)).not.toContain(SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// Sink 4 — AbapConnection.info() / the abap://system MCP resource
// (src/adt/connection.ts ~1327-1357). The single most important test here:
// info() is serialised whole into an MCP resource that reaches the model.
// ---------------------------------------------------------------------------

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const OK_XML = { "content-type": "application/xml" };

class RecordingClient implements HttpClient {
  readonly calls: HttpClientOptions[] = [];
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    if (o.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
    if (o.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
    if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
    return resp(200, "<ok/>", OK_XML);
  }
}

describe("sink 4 — AbapConnection.info() / the abap://system MCP resource (src/adt/connection.ts)", () => {
  // Cookie-mode connect() puts the cookie on the wire (asserted below) but
  // conn.info() is serialised whole into the abap://system MCP resource.
  it("a successful connect() never leaks the cookie via info()", async () => {
    const cfg = cookieModeCfg({ ABAP_CLIENT: "001", ABAP_SID: "A4H" });
    const inner = new RecordingClient();
    const routed = routeSystemRoleProbe(inner, { answer: "nonproductive" });
    const conn = new AbapConnection(cfg, {
      httpClient: routed,
      breaker: new AuthCircuitBreaker(),
      log: () => {},
    });
    try {
      await conn.connect();

      // Proves this exercises the real cookie-mode path, not a no-op: the
      // login request really did carry the injected cookie.
      const login = inner.calls.find((c) => c.url.includes("/compatibility/graph"));
      expect((login?.headers as Record<string, string> | undefined)?.["Cookie"]).toContain(SENTINEL);

      const serialised = JSON.stringify(conn.info());
      expect(serialised).not.toContain(SENTINEL);
    } finally {
      conn.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Sink 5 — connect-failure AbapError (src/adt/connection.ts, both throw
// sites in connectUnderLock()'s catch)
// ---------------------------------------------------------------------------

describe("sink 5 — connect-failure AbapError.message / .details (src/adt/connection.ts)", () => {
  // The thrown exception echoes the cookie back on .headers, worst case.
  it("a general connect failure never leaks the cookie", async () => {
    const cfg = cookieModeCfg();
    const failing: HttpClient = {
      async request(o: HttpClientOptions): Promise<HttpClientResponse> {
        const cookieHeader = (o.headers as Record<string, string> | undefined)?.["Cookie"];
        throw new HttpClientException(
          "Request failed with status code 500",
          "ERR_BAD_REQUEST",
          500,
          { headers: { Cookie: cookieHeader } } as unknown as HttpClientOptions,
          o,
          { status: 500, statusText: "500", body: "internal error", headers: {} } as unknown as HttpClientResponse,
          undefined,
        );
      },
    };
    const conn = new AbapConnection(cfg, {
      httpClient: failing,
      breaker: new AuthCircuitBreaker(),
      log: () => {},
    });
    try {
      let caught: unknown;
      try {
        await conn.connect();
      } catch (e) {
        caught = e;
      }
      expect(isAbapError(caught)).toBe(true);
      if (isAbapError(caught)) {
        expect(caught.message).not.toContain(SENTINEL);
        expect(JSON.stringify(caught.details)).not.toContain(SENTINEL);
      }
    } finally {
      conn.dispose();
    }
  });

  it("the logon-ceiling failure never leaks the cookie", async () => {
    const cfg = cookieModeCfg();
    let n = 0;
    const failing: HttpClient = {
      async request(): Promise<HttpClientResponse> {
        n++;
        throw new Error(`synthetic transport failure #${n}`);
      },
    };
    // Threshold raised so the UNRELATED transient half of the breaker (opens
    // after 3 consecutive failures by default) does not refuse admission
    // before the 6th attempt — the thing under test is the LOCAL
    // logon-endpoint ceiling (5), not the breaker's own transient backoff.
    const conn = new AbapConnection(cfg, {
      httpClient: failing,
      breaker: new AuthCircuitBreaker({ failureThreshold: 10 }),
      log: () => {},
    });
    try {
      let last: unknown;
      for (let i = 0; i < 6; i++) {
        try {
          await conn.connect();
        } catch (e) {
          last = e;
        }
      }
      expect(isAbapError(last)).toBe(true);
      if (isAbapError(last)) {
        expect(last.details.reason).toBe("logon-ceiling-exceeded");
        expect(last.message).not.toContain(SENTINEL);
        expect(JSON.stringify(last.details)).not.toContain(SENTINEL);
      }
    } finally {
      conn.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Sink 6 — describeUnknownError (src/adt/errors.ts ~332-390)
// ---------------------------------------------------------------------------

describe("sink 6 — describeUnknownError (src/adt/errors.ts)", () => {
  // .config carries both a cookie and a password; only .message is read.
  it("an Error-shaped throw leaks only .message, not .config", () => {
    const thrown = Object.assign(new Error("logon failed"), {
      config: { headers: { Cookie: `MYSAPSSO2=${SENTINEL}` }, auth: { password: PASSWORD_SENTINEL } },
    });
    const out = describeUnknownError(thrown);
    expect(out).not.toContain(SENTINEL);
    expect(out).not.toContain(PASSWORD_SENTINEL);
    expect(out).toBe("logon failed");
  });

  // Not an assertion that the fallback is leak-free (src/adt/errors.ts
  // ~372-384 falls back to JSON.stringify(e) for a non-Error throw, and
  // separately reported as leaking). What is actually pinned here is
  // CLASSIFICATION EQUIVALENCE: whatever describeUnknownError does
  // with a thrown object, it must do the identical thing regardless of
  // which credential type sits on it — no cookie-specific carve-out and no
  // cookie-specific regression. That holds whether or not the fallback
  // leaks, so it survives a future fix to that fallback.
  it("treats a cookie-shaped throw exactly like a password-shaped throw", () => {
    const cookieThrown = { source: "connect", credential: SENTINEL };
    const passwordThrown = { source: "connect", credential: PASSWORD_SENTINEL };

    const c = describeUnknownError(cookieThrown).replaceAll(SENTINEL, "<CRED>");
    const p = describeUnknownError(passwordThrown).replaceAll(PASSWORD_SENTINEL, "<CRED>");
    expect(c).toBe(p);
  });
});

// ---------------------------------------------------------------------------
// Sink 7 — tool responses (src/tools/**)
// ---------------------------------------------------------------------------
// No tool handler under src/tools/ references systemRole, connection.info,
// conn.info, primary().info, or readOnlyReason (checked by grep across
// src/tools/); the only cfg./config. fields any tool touches are benign
// (cfg.url, cfg.sid, cfg.user, cfg.maxResponseChars, cfg.debugLockWaitMs,
// cfg.allowDebugJumpToLine, ...) — never cfg.password or cfg.sessionCookie.
// The only real sink that surfaces connection/config state to the model is
// the abap://system MCP resource, already covered as sink 4 above. No test
// is added here so as not to pin a sink that does not exist.
