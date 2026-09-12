/**
 * RFC 6749 §4.4 (OAuth 2.0 Client Credentials Grant) access-token acquisition
 * and caching, for `authMethod: "oauth"`. `GuardedHttpClient` (`http-guard.ts`)
 * calls `getToken()` to mint the `Authorization: Bearer` header on outbound
 * ADT requests (step 2d) and `forceRefresh()` exactly once, from step 2f,
 * after a bearer draws a 401 — never more than once per request, and never
 * before the breaker's `inspect()` has seen a genuine credential failure for
 * every other auth mode.
 *
 * UNVERIFIED: this has never been exercised against a real OAuth token
 * endpoint (SAP BTP's UAA or otherwise) — see the "unverified" note in
 * doc/LIMITATIONS/authentication.md. The token-endpoint response shape
 * assumed here (`access_token`, `expires_in`, `token_type`) is the RFC 6749
 * §5.1 baseline; UAA-specific extensions, if any, are not accounted for.
 *
 * Secrecy: `settings.clientSecret` and any minted `access_token` are held in
 * memory only. Nothing in this file calls `console.*` or
 * `process.stderr.write` — a caught error's `message`/`details` are built
 * from the HTTP status and a credential-stripped URL only, never from the
 * response body (which could echo back request parameters).
 */

import type { OAuthSettings } from "../auth/service-key.js";
import { stripUrlCredentials } from "../config.js";
import { AbapError } from "./errors.js";
import { postFormUrlEncoded } from "./http-guard.js";

/** RFC 6749 §5.1 success shape, restricted to the fields this file reads. */
export interface TokenResponse {
  readonly access_token: string;
  readonly expires_in?: number;
  readonly token_type?: string;
}

/**
 * Seam for tests: swap out the network call without touching global `fetch`.
 * Must not throw for an HTTP-level failure (4xx/5xx) — only for a genuine
 * transport failure (DNS, TCP, TLS). `body` is the raw response text; the
 * caller parses it as JSON.
 */
export type TokenEndpointFetch = (
  tokenUrl: string,
  body: URLSearchParams,
) => Promise<{ status: number; body: string }>;

export interface OAuthTokenProviderOptions {
  readonly settings: OAuthSettings;
  readonly fetchToken?: TokenEndpointFetch;
  readonly now?: () => number;
  /** How long before real expiry a cached token is treated as already expired. Default 60s. */
  readonly refreshSkewMs?: number;
  /** How long a failed refresh is remembered before another network attempt is allowed. Default 30s. */
  readonly failureCooldownMs?: number;
}

const DEFAULT_REFRESH_SKEW_MS = 60_000;
const DEFAULT_FAILURE_COOLDOWN_MS = 30_000;
/** UAA's documented default lifetime, assumed when a success response omits `expires_in`. */
const ASSUMED_EXPIRES_IN_SECONDS = 3600;

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

interface LastFailure {
  readonly message: string;
  readonly atMs: number;
}

/**
 * Delegates the actual dial to `http-guard.ts`'s `postFormUrlEncoded` rather
 * than calling `fetch` here directly: `test/http-guard-url-evasion.test.ts`
 * runs a CANARY asserting exactly three files in `src/` are allowed to open a
 * socket (`http-guard.ts`, `debug/proxy.ts`, `debug/transport.ts`), precisely
 * so a fourth dialer can't appear without someone consciously updating that
 * list. This file has no need to be that fourth file — `http-guard.ts` is
 * already one of the three, and reusing it keeps the sink surface unchanged.
 */
const defaultFetchToken: TokenEndpointFetch = postFormUrlEncoded;

/**
 * Client-credentials token cache with single-flight refresh. One instance
 * per configured OAuth credential (see wherever `Config.oauth` is wired up);
 * never shared across distinct client_id/tokenUrl pairs.
 */
export class OAuthTokenProvider {
  private readonly settings: OAuthSettings;
  private readonly fetchToken: TokenEndpointFetch;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;
  private readonly failureCooldownMs: number;
  private readonly safeTokenUrl: string;

  private cached: CachedToken | undefined;
  private inFlight: Promise<string> | undefined;
  private lastFailure: LastFailure | undefined;

  constructor(opts: OAuthTokenProviderOptions) {
    this.settings = opts.settings;
    this.fetchToken = opts.fetchToken ?? defaultFetchToken;
    this.now = opts.now ?? (() => Date.now());
    this.refreshSkewMs =
      typeof opts.refreshSkewMs === "number" && opts.refreshSkewMs >= 0
        ? opts.refreshSkewMs
        : DEFAULT_REFRESH_SKEW_MS;
    this.failureCooldownMs =
      typeof opts.failureCooldownMs === "number" && opts.failureCooldownMs >= 0
        ? opts.failureCooldownMs
        : DEFAULT_FAILURE_COOLDOWN_MS;
    this.safeTokenUrl = stripUrlCredentials(this.settings.tokenUrl);
  }

  /**
   * Returns a currently-valid access token, minting or refreshing one as
   * needed. Concurrent callers during a refresh share the single in-flight
   * request rather than each firing their own.
   */
  async getToken(): Promise<string> {
    const cached = this.cached;
    if (cached && cached.expiresAtMs - this.refreshSkewMs > this.now()) {
      return cached.token;
    }
    return this.refresh();
  }

  /**
   * Discards any cached token and forces a fresh network round trip. Used by
   * `GuardedHttpClient` exactly once per request, after a bearer draws a 401
   * (see step 2f in `http-guard.ts`) — a merely-expired token should not
   * trip the auth latch.
   */
  async forceRefresh(): Promise<string> {
    this.cached = undefined;
    return this.refresh();
  }

  /** Diagnostic snapshot. Never includes the token or client secret. */
  status(): {
    hasToken: boolean;
    expiresInMs?: number;
    inCooldown: boolean;
    lastFailure?: string;
  } {
    const cached = this.cached;
    const inCooldown = this.inCooldownNow();
    const result: {
      hasToken: boolean;
      expiresInMs?: number;
      inCooldown: boolean;
      lastFailure?: string;
    } = {
      hasToken: cached !== undefined,
      inCooldown,
    };
    if (cached) {
      result.expiresInMs = Math.max(0, cached.expiresAtMs - this.now());
    }
    if (this.lastFailure) {
      result.lastFailure = this.lastFailure.message;
    }
    return result;
  }

  private inCooldownNow(): boolean {
    const failure = this.lastFailure;
    if (!failure) return false;
    return this.now() < failure.atMs + this.failureCooldownMs;
  }

  private refresh(): Promise<string> {
    if (this.inFlight) return this.inFlight;

    if (this.inCooldownNow()) {
      // Fail immediately, without a network attempt, until the cooldown lapses.
      throw this.cooldownError();
    }

    const attempt = this.performRefresh().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = attempt;
    return attempt;
  }

  private async performRefresh(): Promise<string> {
    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    body.set("client_id", this.settings.clientId);
    body.set("client_secret", this.settings.clientSecret);
    if (this.settings.scope) body.set("scope", this.settings.scope);

    let status: number;
    let text: string;
    try {
      const res = await this.fetchToken(this.settings.tokenUrl, body);
      status = res.status;
      text = res.body;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw this.refreshFailedError(undefined, `network error contacting the token endpoint: ${reason}`);
    }

    if (status !== 200) {
      throw this.refreshFailedError(status);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw this.refreshFailedError(status, "the token endpoint's response was not valid JSON");
    }

    const token = (parsed as { access_token?: unknown } | null)?.access_token;
    if (typeof token !== "string" || token.length === 0) {
      throw this.refreshFailedError(status, "the token endpoint's response had no access_token");
    }

    const rawExpiresIn = (parsed as { expires_in?: unknown }).expires_in;
    const expiresInSeconds =
      typeof rawExpiresIn === "number" && Number.isFinite(rawExpiresIn) && rawExpiresIn > 0
        ? rawExpiresIn
        : ASSUMED_EXPIRES_IN_SECONDS;

    this.lastFailure = undefined;
    this.cached = { token, expiresAtMs: this.now() + expiresInSeconds * 1000 };
    return token;
  }

  /**
   * Builds the structured `AUTH_TOKEN_REFRESH_FAILED` error and records the
   * failure for the cooldown window. `details` carries only the redacted URL
   * and, when known, the HTTP status — never the response body, which could
   * echo back request parameters (including the client secret, on some
   * misconfigured servers).
   */
  private refreshFailedError(status: number | undefined, extra?: string): AbapError {
    const statusPart = status !== undefined ? `HTTP ${status}` : "no response";
    const message = extra
      ? `OAuth token refresh against ${this.safeTokenUrl} failed: ${extra} (${statusPart}).`
      : `OAuth token refresh against ${this.safeTokenUrl} failed (${statusPart}).`;
    const details: Record<string, unknown> = { tokenUrl: this.safeTokenUrl };
    if (status !== undefined) details.status = status;
    const hint = this.remedyHint();
    this.lastFailure = { message, atMs: this.now() };
    return new AbapError("AUTH_TOKEN_REFRESH_FAILED", message, details, hint);
  }

  /**
   * Thrown when a call arrives while a prior failure's cooldown is still in
   * effect — no network attempt is made, and the cooldown clock is not
   * restarted (only a real attempt, successful or not, moves `lastFailure`).
   */
  private cooldownError(): AbapError {
    const message = `OAuth token refresh against ${this.safeTokenUrl} is in cooldown after a recent failure.`;
    const details: Record<string, unknown> = { tokenUrl: this.safeTokenUrl };
    return new AbapError("AUTH_TOKEN_REFRESH_FAILED", message, details, this.remedyHint());
  }

  private remedyHint(): string {
    const cooldownSeconds = Math.round(this.failureCooldownMs / 1000);
    return (
      `Verify ABAP_OAUTH_CLIENT_ID/ABAP_OAUTH_CLIENT_SECRET (or the service key) and that the ` +
      `token endpoint is reachable. Another attempt will not be made for ${cooldownSeconds}s.`
    );
  }
}
