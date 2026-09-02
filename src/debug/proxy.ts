/**
 * Proxy awareness for the debug transport's raw `node:http`/`node:https`
 * requests (the proxy half of a two-part feature — the TLS half landed
 * separately via `buildInsecureHttpsAgent`, `src/adt/http-guard.ts`).
 *
 * The ADT path (`abap-adt-api`'s `AxiosHttpClient`, under `src/adt/http-guard.ts`)
 * gets `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` support for free:
 * axios resolves the proxy for a request via the `proxy-from-env` package's
 * `getProxyForUrl` (see `node_modules/axios/lib/adapters/http.js`'s
 * `setProxy`). This module imports that SAME package rather than
 * reimplementing `NO_PROXY` matching, so the debug transport cannot silently
 * disagree with the rest of the tool about what `NO_PROXY` means — wildcard
 * leading-dot suffixes, port-scoped entries, `*` meaning "never proxy", and
 * the lower/upper-case env var fallback are all `proxy-from-env`'s rules
 * (`node_modules/proxy-from-env/index.js`), not reinvented here.
 */
import http from "node:http";
import https from "node:https";
import createHttpsProxyAgent from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";

/**
 * Resolves the proxy URL (if any) that should carry a request to `targetUrl`,
 * honouring `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` (both cases) —
 * the exact same resolution axios performs for the ADT path (see this file's
 * header). `undefined` means "no proxy applies": either no `*_PROXY` env var
 * is set, or `NO_PROXY` covers this host/port.
 */
export function resolveProxyUrl(targetUrl: string): string | undefined {
  return getProxyForUrl(targetUrl) || undefined;
}

/**
 * Strips a `user:pass@` (or `user@`) userinfo segment out of a proxy URL
 * string for safe inclusion in an error message. String-level, not
 * `URL`-based: the one caller needs this on a value that FAILED to parse as a
 * URL, so a real `URL` object isn't available to pull `.username`/`.password`
 * off. `HTTP_PROXY=http://user:pass@proxy.example:8080` is a supported way to
 * authenticate to a corporate proxy (see the `Proxy-Authorization` handling
 * below), so the raw env value must never reach a log line, a thrown error,
 * or an MCP tool response verbatim.
 */
function redactProxyCredentials(raw: string): string {
  return raw.replace(/\/\/[^/@\s]*@/, "//<redacted>@");
}

/**
 * What proxying a given request requires: the `node:http`/`node:https`
 * module to dial (the PROXY's own scheme, not the target's — an
 * `https://`-listening proxy is dialled over TLS even to relay a plain HTTP
 * target), per-request `http.RequestOptions` overrides, and — only for an
 * HTTPS target tunnelled via `CONNECT` — a dedicated agent.
 *
 * `agent`, when present, is ALWAYS a fresh instance built by THIS call to
 * `planProxyRequest` — never cached or shared across requests (see
 * `planProxyRequest`'s doc comment for why that's what actually preserves
 * the long-poll's `agent: false` carve-out, not the literal absence of an
 * Agent object).
 */
export interface ProxyRequestPlan {
  transport: typeof http | typeof https;
  options: http.RequestOptions;
  agent?: https.Agent;
}

/**
 * Builds a `ProxyRequestPlan` for `url`, or `undefined` if no proxy applies
 * (see `resolveProxyUrl`). Two distinct modes, chosen by the TARGET's scheme:
 *
 *  - **HTTPS target**: tunnelled via `CONNECT` — the only way a client can
 *    reach a TLS origin through a middlebox — using `https-proxy-agent`'s
 *    `HttpsProxyAgent`. Built FRESH on every call, never cached or reused:
 *    that's what keeps this compatible with `RawHttpRequest.longPoll`'s
 *    `agent: false` carve-out in transport.ts. That carve-out exists because
 *    a stale pooled socket can carry an inherited `socket.setTimeout()` into
 *    an unrelated later request (wire-confirmed ECONNRESET, see the doc
 *    comment there); an Agent object is unavoidable for a CONNECT tunnel
 *    (only a custom `Agent.connect()` can route a socket through one), but
 *    an instance that is used for exactly one request and then discarded has
 *    no pool to carry stale state — the actual property `agent: false`
 *    protects, not the literal absence of an `Agent`. (`agent-base`, which
 *    `HttpsProxyAgent` v5 extends, documents "No pooling/keep-alive... by
 *    default" regardless, so this is belt AND braces, not a bet on that.)
 *  - **HTTP target**: classic forward-proxying — no `CONNECT`, no tunnel. The
 *    request line carries the target's absolute URL and the proxy relays it,
 *    exactly as `abap-adt-api`'s axios stack does for plaintext HTTP (see
 *    `node_modules/axios/lib/adapters/http.js`'s "Forward-proxy mode for
 *    plaintext HTTP targets" branch). No Agent needed at all — this only
 *    retargets `hostname`/`port`/`path` at the proxy, so `agent: false` for
 *    the long-poll case is untouched, exactly as it was pre-proxy-support.
 */
export function planProxyRequest(
  url: URL,
  headers: Record<string, string> | undefined,
): ProxyRequestPlan | undefined {
  const proxyUrlString = resolveProxyUrl(url.toString());
  if (!proxyUrlString) return undefined;

  let proxyUrl: URL;
  try {
    proxyUrl = new URL(proxyUrlString);
  } catch {
    // A malformed *_PROXY value is an operator configuration error, not a
    // reason to silently fall back to a direct connection that skips the
    // proxy the operator asked for. Redact any embedded `user:pass@` first —
    // this message reaches the MCP tool caller (an LLM's context) via
    // `translateDebugError`/`tool-errors.ts`, not just a local log, so a
    // credential embedded in `HTTP_PROXY`/`HTTPS_PROXY` (a supported, if
    // unusual, way to authenticate to a corporate proxy) must never appear in
    // it verbatim — string-level, deliberately, since the whole point is this
    // value did NOT parse as a URL.
    throw new Error(
      `Invalid proxy URL from HTTP_PROXY/HTTPS_PROXY/ALL_PROXY ("${redactProxyCredentials(proxyUrlString)}"): cannot be parsed.`,
    );
  }

  const proxyIsHttps = proxyUrl.protocol === "https:";
  const dialTransport = proxyIsHttps ? https : http;

  if (url.protocol === "https:") {
    // CONNECT-tunnel mode. `createHttpsProxyAgent` accepts the proxy URL
    // string directly (it parses host/port/userinfo itself); `agent-base`'s
    // `Agent` doesn't nominally extend `http.Agent` but is structurally
    // compatible with what Node's http/https core needs from `options.agent`
    // (`addRequest`, `options`, socket bookkeeping fields) — the same shape
    // axios relies on for its own tunnelling agent.
    const agent = createHttpsProxyAgent(proxyUrlString) as unknown as https.Agent;
    return { transport: https, options: {}, agent };
  }

  // Forward-proxy mode (HTTP target). Point the connection at the proxy, put
  // the target's absolute URL on the request line, and preserve/default the
  // Host header to the ORIGINAL target so the proxy (and the origin, once
  // relayed) still see the right virtual host.
  const outHeaders: Record<string, string> = { ...(headers ?? {}) };
  const hasHostHeader = Object.keys(outHeaders).some((k) => k.toLowerCase() === "host");
  if (!hasHostHeader) outHeaders.host = url.host;
  if (proxyUrl.username || proxyUrl.password) {
    const auth = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
    outHeaders["Proxy-Authorization"] = `Basic ${Buffer.from(auth, "utf8").toString("base64")}`;
  }
  return {
    transport: dialTransport,
    options: {
      hostname: proxyUrl.hostname,
      port: proxyUrl.port || (proxyIsHttps ? 443 : 80),
      path: url.toString(),
      headers: outHeaders,
    },
  };
}
