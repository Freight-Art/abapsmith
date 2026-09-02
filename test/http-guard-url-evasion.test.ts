/**
 * URL-evasion audit of the transport-release denial in `GuardedHttpClient`
 * — the matcher itself, probed from the outside.
 *
 * `test/http-guard-transport-release-policy.test.ts` proves the POLICY (the
 * two endpoints are denied, no config re-enables them, nothing reaches the
 * network). This file attacks the MATCHER: every way the same resource can be
 * spelled differently, and every way an innocent URL could be wrongly refused.
 *
 * The rule under test (see the policy block above `assertHttpPathAllowed` in
 * `src/adt/http-guard.ts`) has two halves:
 *   A. terminal path SEGMENT is `relwithignlock` / `relobjigchkatc`
 *   B. a query parameter NAMED `ignoreLocks` / `ignoreATC` exists
 *
 * Every "denied" case is proven twice, as in the policy file: the thrown
 * `code`, AND the spy's call count staying at 0 — a test that only checked the
 * throw would pass even if the guard dispatched first and threw afterwards.
 *
 * Entirely offline. Probes 1–6 use an injected `inner: HttpClient` spy and never
 * a packet. Probe 7 additionally binds ONE `node:http` server on 127.0.0.1 whose
 * only job is to COUNT connections it must never receive — the only way to prove
 * "no socket was opened" about a code path whose whole point is that it opens
 * sockets itself. Nothing here addresses a SAP system, real or faked.
 *
 * NOTE: deliberately does not import `loadConfig`/build an `AbapConnection`,
 * for the same reason the policy file does not — `test/system-role-probe-guard.test.ts`
 * treats such a suite as a "connection builder" that must route the
 * system-role probe or be allow-listed, and that allow-list is at its cap.
 * Nothing here connects to anything, real or faked.
 */
import http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { GuardedHttpClient, assertHttpPathAllowed } from "../src/adt/http-guard.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import {
  ACQUIRE_NO_SESSION_LEASE,
  DebugLongPollClient,
  defaultRawHttpRequest,
  fetchCsrfToken,
  type RawHttpRequestFn,
} from "../src/debug/transport.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";

// ---------------------------------------------------------------- fixtures ---

class SpyClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return {
      status: 200,
      statusText: "200",
      body: "ok",
      headers: { "content-type": "text/plain" },
    } as unknown as HttpClientResponse;
  }
}

const TR = "NPLK900123";
const BASE = `/sap/bc/adt/cts/transportrequests/${TR}`;

/** Sends `options` through a fresh guard. Returns the thrown code (or null) and the spy. */
async function attempt(
  options: Partial<HttpClientOptions>,
): Promise<{ code: AbapError["code"] | null; calls: number; error: AbapError | null }> {
  const inner = new SpyClient();
  const guard = new GuardedHttpClient({ baseURL: "http://x", inner }, new AuthCircuitBreaker());
  const outcome = await guard
    .request({ method: "POST", ...options } as HttpClientOptions)
    .then(() => null)
    .catch((e: AbapError) => e);
  return {
    code: outcome ? outcome.code : null,
    calls: inner.calls.length,
    error: outcome,
  };
}

/** Asserts the URL is refused, pre-network. */
async function expectDenied(options: Partial<HttpClientOptions>): Promise<void> {
  const r = await attempt(options);
  expect(r.code, `expected HTTP_PATH_DENIED for ${JSON.stringify(options)}`).toBe(
    "HTTP_PATH_DENIED",
  );
  expect(r.calls, `nothing may reach the network for ${JSON.stringify(options)}`).toBe(0);
}

/** Asserts the URL is allowed through to the (spy) network. */
async function expectAllowed(options: Partial<HttpClientOptions>): Promise<void> {
  const r = await attempt(options);
  expect(r.code, `expected no denial for ${JSON.stringify(options)}`).toBe(null);
  expect(r.calls, `expected a dispatch for ${JSON.stringify(options)}`).toBe(1);
}

// ------------------------------- PROBE 1: segment, not substring -------------

describe("probe 1 — the match is on a path SEGMENT, not a bare substring", () => {
  it("denies the bare endpoint under both spellings", async () => {
    await expectDenied({ url: `${BASE}/relwithignlock` });
    await expectDenied({ url: `${BASE}/relobjigchkatc` });
  });

  it("denies it as the terminal segment of a relative URL with no leading slash", async () => {
    // `AdtHTTP` composes against a baseURL; a relative path is a perfectly
    // ordinary way for one to arrive, and it must not read as "no segments".
    await expectDenied({ url: `cts/transportrequests/${TR}/relwithignlock` });
    await expectDenied({ url: "relwithignlock" });
  });

  it("denies it behind a safe-looking earlier segment (no allow rule can shadow it)", async () => {
    await expectDenied({ url: `${BASE}/newreleasejobs/relwithignlock` });
  });

  it("does NOT deny a longer segment that merely CONTAINS the token", async () => {
    // A bare substring matcher would refuse both of these. They are different
    // resources, and a false denial is a bug.
    await expectAllowed({ url: `${BASE}/relwithignlockdisabled` });
    await expectAllowed({ url: `${BASE}/notrelwithignlock` });
  });

  it("does NOT deny when the token is a non-terminal segment with a real segment after it", async () => {
    // Not the dangerous endpoint at all — abap-adt-api never produces this
    // shape, and only a substring matcher could refuse it.
    await expectAllowed({ url: `${BASE}/relwithignlock/somethingelse` });
  });

  it("does NOT deny the normal release endpoint", async () => {
    await expectAllowed({ url: `${BASE}/newreleasejobs` });
  });
});

// ------------------------------------ PROBE 2: percent-encoding --------------

describe("probe 2 — percent-encoded and double-encoded variants", () => {
  it("denies a single-character-encoded spelling", async () => {
    await expectDenied({ url: `${BASE}/%72elwithignlock` }); // %72 = r
    await expectDenied({ url: `${BASE}/rel%77ithignlock` }); // %77 = w
    await expectDenied({ url: `${BASE}/RELWITHIGN%4COCK` }); // %4C = L, plus case
    await expectDenied({ url: `${BASE}/%72%65%6c%77%69%74%68%69%67%6e%6c%6f%63%6b` });
  });

  it("denies an encoded slash used to hide the segment boundary", async () => {
    await expectDenied({ url: `${BASE}%2Frelwithignlock` });
    await expectDenied({ url: `${BASE}%2frelwithignlock` });
  });

  it("denies a DOUBLE-encoded spelling (a decode-twice backend would reach it)", async () => {
    // `%2572` -> `%72` -> `r`. Whether this reaches the endpoint depends on how
    // many times the stack in front of ICF decodes; the guard denies on the
    // ambiguity rather than betting on one answer.
    await expectDenied({ url: `${BASE}/%2572elwithignlock` });
    await expectDenied({ url: `${BASE}%252Frelwithignlock` });
  });

  it("denies an encoded '?' that would re-open as a query delimiter after decoding", async () => {
    // Raw, there is no `?`, so a split-on-`?` done before decoding leaves the
    // whole thing as one segment. After decoding, `relwithignlock` is terminal.
    await expectDenied({ url: `${BASE}/relwithignlock%3Fx=1` });
    await expectDenied({ url: `${BASE}/relwithignlock%23frag` });
  });

  it("denies despite a MALFORMED percent-escape rather than failing open", async () => {
    // `decodeURIComponent` THROWS on these, so a matcher that merely stops
    // decoding leaves the broken text in place, the segment reads
    // `relwithignlock%`, and the request sails through. That was a real
    // fail-open; the malformed escape is now repaired and matched too.
    await expectDenied({ url: `${BASE}/relwithignlock%` }); // stray % at the end
    await expectDenied({ url: `${BASE}/relwithignlock%A` }); // truncated escape
    await expectDenied({ url: `${BASE}/relwithignlock%ZZ` }); // non-hex escape
    await expectDenied({ url: `${BASE}/relwithign%lock` }); // % inside the token
    await expectDenied({ url: `${BASE}/rel%withign%lock` }); // several of them
    await expectDenied({ url: `${BASE}/relobjigchkatc%` });
  });

  it("denies a malformed escape in a query parameter NAME too", async () => {
    await expectDenied({ url: `${BASE}/newreleasejobs?ignoreLocks%=true` });
    await expectDenied({ url: `${BASE}/newreleasejobs?ignore%Locks=true` });
  });

  it("does not crash on a malformed escape, and does not over-deny because of one", async () => {
    // The repair must not turn a stray `%` into a blanket denial: these are
    // ordinary endpoints that merely carry a broken escape.
    await expectAllowed({ url: `${BASE}/newreleasejobs%` });
    await expectAllowed({ url: `${BASE}/newreleasejobs%ZZ` });
    await expectAllowed({ url: `${BASE}/newreleasejobs?note=100%` });
  });
});

// ------------------------------------------------- PROBE 3: case -------------

describe("probe 3 — case-insensitivity (ADT spells these inconsistently)", () => {
  it("denies every casing of the path segment", async () => {
    for (const s of [
      "RelWithIgnLock",
      "RELWITHIGNLOCK",
      "relWithIgnLock",
      "relObjigchkatc", // abap-adt-api's own spelling, note the capital O
      "RELOBJIGCHKATC",
      "RelObjIgChkAtc",
    ]) {
      await expectDenied({ url: `${BASE}/${s}` });
    }
  });

  it("denies every casing of the query parameter name", async () => {
    for (const p of ["ignoreLocks", "IGNORELOCKS", "IgnoreLocks", "ignorelocks"]) {
      await expectDenied({ url: `${BASE}/newreleasejobs?${p}=true` });
    }
    for (const p of ["IgnoreATC", "ignoreAtc", "IGNOREATC", "ignoreatc"]) {
      await expectDenied({ url: `${BASE}/newreleasejobs?${p}=true` });
    }
  });
});

// ------------------------------- PROBE 4: query-parameter position -----------

describe("probe 4 — the ignore flags as query parameters, in every position", () => {
  it("denies a lone ignoreLocks parameter", async () => {
    await expectDenied({ url: `${BASE}/newreleasejobs?ignoreLocks=true` });
  });

  it("denies it in second and later position", async () => {
    await expectDenied({ url: `${BASE}/newreleasejobs?foo=1&ignoreLocks=true` });
    await expectDenied({ url: `${BASE}/newreleasejobs?a=1&b=2&c=3&IgnoreATC=X` });
  });

  it("denies a REPEATED parameter regardless of which value a parser would win with", async () => {
    // `?ignoreLocks=false&ignoreLocks=true` is the classic smuggle: a guard
    // that reads "the value" reads the first and sees `false`. The match is on
    // the NAME, so both orderings die.
    await expectDenied({ url: `${BASE}/newreleasejobs?ignoreLocks=false&ignoreLocks=true` });
    await expectDenied({ url: `${BASE}/newreleasejobs?ignoreLocks=true&ignoreLocks=false` });
  });

  it("denies it regardless of the value — including a falsy or absent one", async () => {
    await expectDenied({ url: `${BASE}/newreleasejobs?ignoreLocks=false` });
    await expectDenied({ url: `${BASE}/newreleasejobs?ignoreLocks=` });
    await expectDenied({ url: `${BASE}/newreleasejobs?ignoreLocks` });
  });

  it("denies it behind a ';' separator", async () => {
    await expectDenied({ url: `${BASE}/newreleasejobs?foo=1;ignoreLocks=true` });
  });

  it("denies a percent-encoded parameter NAME", async () => {
    await expectDenied({ url: `${BASE}/newreleasejobs?%69gnoreLocks=true` });
  });

  it("denies it when it arrives as an `options.qs` key rather than in the URL", async () => {
    // `qs` is a structurally separate field that axios appends downstream of
    // the guard — checking `url` alone would miss it entirely.
    await expectDenied({ url: `${BASE}/newreleasejobs`, qs: { ignoreLocks: "true" } });
    await expectDenied({ url: `${BASE}/newreleasejobs`, qs: { trkorr: TR, IgnoreATC: true } });
  });

  it("does NOT deny an innocent parameter whose VALUE happens to be the token", async () => {
    // Values are caller data — an ABAP name, a comment, a search term. Only
    // names decide. A substring matcher over the raw URL would refuse these.
    await expectAllowed({ url: `${BASE}/newreleasejobs?note=relwithignlock` });
    await expectAllowed({ url: `${BASE}/newreleasejobs?note=ignoreLocks` });
    await expectAllowed({ url: `${BASE}/newreleasejobs`, qs: { evil: "relwithignlock", trkorr: TR } });
    await expectAllowed({ url: `${BASE}/newreleasejobs`, qs: { note: "ignoreLocks" } });
  });

  it("does NOT deny a differently-named parameter that merely contains the token", async () => {
    await expectAllowed({ url: `${BASE}/newreleasejobs?doNotIgnoreLocks=true` });
    await expectAllowed({ url: `${BASE}/newreleasejobs?ignoreLocksHint=true` });
  });
});

// --------------------------- PROBE 5: alternative URL constructions ----------

describe("probe 5 — building the same URL a different way", () => {
  it("denies a TRAILING SLASH variant", async () => {
    // RFC 3986: the empty last segment is not the resource. Before the fix
    // this slipped through an `endsWith('/relwithignlock')` test.
    await expectDenied({ url: `${BASE}/relwithignlock/` });
    await expectDenied({ url: `${BASE}/relobjigchkatc/` });
  });

  it("denies duplicate-slash noise", async () => {
    await expectDenied({ url: `${BASE}//relwithignlock` });
    await expectDenied({ url: `${BASE}/relwithignlock//` });
    await expectDenied({ url: `//sap//bc//adt//cts//transportrequests//${TR}//relwithignlock` });
  });

  it("denies a '.' dot-segment tail, which normalizes to the same resource", async () => {
    await expectDenied({ url: `${BASE}/relwithignlock/.` });
    await expectDenied({ url: `${BASE}/relwithignlock/./` });
    await expectDenied({ url: `${BASE}/relwithignlock/././.` });
  });

  it("denies a '..' walk that LANDS on the endpoint", async () => {
    await expectDenied({ url: `${BASE}/newreleasejobs/../relwithignlock` });
    await expectDenied({ url: `${BASE}/x/y/../../relwithignlock` });
    await expectDenied({ url: `${BASE}/x/..%2Frelwithignlock` });
  });

  it("denies trailing-whitespace and trailing-dot padding", async () => {
    await expectDenied({ url: `${BASE}/relwithignlock%20` });
    await expectDenied({ url: `${BASE}/relwithignlock.` });
    await expectDenied({ url: `${BASE}/relwithignlock%09` });
  });

  it("denies a backslash used as a separator", async () => {
    await expectDenied({ url: `${BASE}\\relwithignlock` });
  });

  it("denies a fragment appended after the endpoint", async () => {
    await expectDenied({ url: `${BASE}/relwithignlock#anything` });
  });

  it("denies an absolute URL, not just a path", async () => {
    await expectDenied({ url: `https://a4h.example:44300${BASE}/relwithignlock` });
  });

  it("does NOT deny a '..' walk that lands somewhere ELSE", async () => {
    // Under either reading — server resolves dot segments or it does not —
    // this is not the dangerous endpoint, so refusing it would be a false
    // denial. Asserting the truth, not something stronger.
    await expectAllowed({ url: `${BASE}/relwithignlock/..` });
    await expectAllowed({ url: `${BASE}/relwithignlock/../newreleasejobs` });
  });

  it("does NOT inspect the request BODY — and must not", async () => {
    // REALITY, asserted deliberately: `body` carries ABAP source. Denying on a
    // body substring would refuse to save a report that merely mentions
    // `ignoreLocks` in a comment — a false denial on ordinary developer text.
    // ADT encodes the ignore choice in the PATH, never in a body, so there is
    // nothing here to catch and a great deal to break.
    await expectAllowed({
      url: `${BASE}/newreleasejobs`,
      body: "* TODO: never use ignoreLocks / relwithignlock here\nWRITE 'x'.",
    });
  });
});

// --------------------------------- PROBE 6: coverage of every exit -----------

describe("probe 6 — is the denial on every outbound path?", () => {
  it("is exported, so a non-axios sink can be held to the same rule", () => {
    // The invariant is the RULE, not the class. Keeping the assert private
    // made it structurally impossible for any other sink to honour it.
    expect(typeof assertHttpPathAllowed).toBe("function");
    expect(() => assertHttpPathAllowed("POST", `${BASE}/relwithignlock`)).toThrow(
      /HTTP_PATH_DENIED|structurally/,
    );
    expect(() => assertHttpPathAllowed("POST", `${BASE}/newreleasejobs`)).not.toThrow();
    expect(() =>
      assertHttpPathAllowed("POST", `${BASE}/newreleasejobs`, { ignoreLocks: "true" }),
    ).toThrow();
  });

  it("CANARY: across ALL of src/, exactly three modules can open a socket", () => {
    // Detects the CAPABILITY to open a socket, not a call shape: a module that
    // imports `node:http`/`node:https`/`node:net`/`node:tls`, constructs an
    // `AxiosHttpClient`, or reaches for `axios`/`fetch`. An earlier version of
    // this test also matched `transport.request(`, which wrongly flagged
    // `src/debug/client.ts` — that is a call INTO our own `debug/transport.ts`
    // module, not a socket. `debug/client.ts` has no `net`, `tls`, `Socket`,
    // `axios`, `fetch` or `createConnection`; it is a caller, not a sink, and
    // encoding it here would have blunted this canary permanently.
    //
    // Scans every .ts under src/ rather than a hand-kept file list, so a THIRD
    // sink cannot appear in a file nobody remembered to enumerate. Whoever adds
    // one has to come here and decide consciously whether the denial applies.
    //
    // `debug/proxy.ts` was added for the HTTP_PROXY/HTTPS_PROXY/NO_PROXY half and IS one of
    // the three, decided consciously: it imports `node:http`/`node:https` to
    // type and hand back `typeof http | typeof https` plus (for an HTTPS
    // target) a `CONNECT`-tunnelling `Agent`, but it never itself calls
    // `.request()`/`.connect()`/`.get()`/`fetch()` — grep it, there is none.
    // It is a plan-builder, not a dialer: its one caller,
    // `createRawHttpRequestFn` in `debug/transport.ts`, invokes
    // `assertHttpPathAllowed(req.method, req.url)` FIRST and only reaches
    // `planProxyRequest` afterwards (see that file, ~line 230 vs ~253), so a
    // URL the guard would deny never reaches this module at all. It cannot be
    // used to open a socket the denial didn't already clear.
    const root = fileURLToPath(new URL("../src/", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".ts")) files.push(full.slice(root.length));
      }
    };
    walk(root.replace(/\/$/, ""));
    expect(files.length).toBeGreaterThan(20); // the walk actually found the tree

    const SINK = [
      /from\s+"node:(?:http|https|net|tls)"/,
      /\bnew AxiosHttpClient\b/,
      /(^|[^.\w])fetch\s*\(/,
      /from\s+"axios"/,
      /\baxios\.\w/,
    ];
    const sinks = files.filter((rel) => {
      // Block/line comments name these constantly; only real code counts.
      const lines = readFileSync(root + rel, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
      return SINK.some((re) => lines.some((l) => re.test(l)));
    });
    expect(sinks.sort()).toEqual(["adt/http-guard.ts", "debug/proxy.ts", "debug/transport.ts"]);
  });

  it("CANARY: the debugger's raw-socket egress IS behind the denial", () => {
    // The substantive probe-6 answer. This test used to assert the OPPOSITE —
    // it pinned, as a finding, that `src/debug/transport.ts` imported
    // `circuitOpenError`/`transientOpenError` from the guard module and
    // hand-rolled the breaker gates while never importing or calling
    // `assertHttpPathAllowed`, leaving its raw `node:http`/`node:https` egress
    // (the debugger long poll and that poll's CSRF `HEAD`) outside the
    // structural denial. It was written to go red the day someone closed that
    // hole. It has been flipped, not deleted: same three imports probed, one
    // expectation inverted, plus the two things the old shape could not check.
    //
    // The other egress class in that file was always covered:
    // `DebugTransport.request()` -> `dispatch()` -> `this.connection.get/post()`
    // -> `AbapConnection` -> this guard.
    //
    // Static, deliberately. `test/http-guard-url-evasion.test.ts` probe 7 below
    // proves the BEHAVIOUR (denied URL refused, zero sockets); this proves the
    // WIRING is still where the behaviour comes from — one shared rule imported
    // from `src/adt/http-guard.ts`, never a second copy of the matcher grown
    // locally in the debugger module, which would drift.
    const src = readFileSync(fileURLToPath(new URL("../src/debug/transport.ts", import.meta.url)), "utf8");
    const guardImport = src.match(/import\s*{([^}]*)}\s*from\s*"\.\.\/adt\/http-guard\.js"/);
    expect(guardImport, "debug/transport.ts should still import from http-guard").not.toBeNull();
    const imported = (guardImport?.[1] ?? "").split(",").map((s) => s.trim());
    expect(imported).toContain("circuitOpenError");
    expect(imported).toContain("transientOpenError");
    expect(imported).toContain("assertHttpPathAllowed");

    // An import is not a call. `requestFn` is injectable at BOTH raw egress
    // sites, so guarding only `defaultRawHttpRequest` would leave every
    // substituted implementation outside the denial: there must be an assert at
    // the two CALL SITES as well as in the default sink. Three call sites, all
    // in real code (comment lines stripped, as in the sink scan above).
    const codeLines = src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
    const callSites = codeLines.filter((l) => /\bassertHttpPathAllowed\(/.test(l));
    expect(
      callSites.length,
      "expected assertHttpPathAllowed at defaultRawHttpRequest, fetchCsrfToken and the long poll",
    ).toBeGreaterThanOrEqual(3);

    // ORDER, as source position — the cheap half of the ordering claim; probe 7
    // proves the half that actually matters (a denied URL is refused even when
    // the breaker would have refused it first). In both raw egress functions the
    // denial must precede the hand-rolled breaker gates, exactly as
    // `assertHttpPathAllowed` precedes them in `GuardedHttpClient.request()`.
    const code = codeLines.join("\n");
    /** Source of one function, so "before" is measured inside it and not across the file. */
    const bodyFrom = (marker: string, end?: string): string => {
      const start = code.indexOf(marker);
      expect(start, `${marker} not found in src/debug/transport.ts`).toBeGreaterThan(-1);
      const rest = code.slice(start);
      const stop = end ? rest.indexOf(end) : -1;
      return stop > 0 ? rest.slice(0, stop) : rest;
    };
    for (const [what, body, assertion] of [
      ["fetchCsrfToken", bodyFrom("export async function fetchCsrfToken", "\nexport "), 'assertHttpPathAllowed("HEAD"'],
      ["the long poll", bodyFrom("private async run("), 'assertHttpPathAllowed("POST"'],
    ] as const) {
      const denial = body.indexOf(assertion);
      const gate = body.indexOf("breaker.isTripped");
      expect(denial, `${what} must assert the denial on its own url`).toBeGreaterThan(-1);
      expect(gate, `${what} should still gate on the breaker`).toBeGreaterThan(-1);
      expect(denial, `${what}: the denial must precede the breaker gate`).toBeLessThan(gate);
    }
  });
});

// -------- PROBE 7: the debugger's raw node:http egress, end to end -----------

/**
 * Probe 6's canary proves the WIRING. This proves the BEHAVIOUR, from the
 * outside, on the second socket sink in the process.
 *
 * `src/debug/transport.ts` opens `node:http`/`node:https` sockets of its own for
 * the debugger long poll and for that poll's CSRF `HEAD`, because neither can use
 * `AbapConnection`'s guarded client (it bakes in a fixed timeout the poll must not
 * have). Both now call the SAME exported `assertHttpPathAllowed`.
 *
 * Every denial here is proven twice, as everywhere else in this file: the thrown
 * `code`, AND the absence of any dispatch. For the injected-`requestFn` cases that
 * means a spy whose call list stays empty; for the DEFAULT sink — the one that
 * really opens a socket — it means a loopback server that never sees a connection.
 *
 * The negative cases are load-bearing: a real debugger long poll must still go
 * through, query string and all. Over-denial here would silently break attach.
 */
describe("probe 7 — the same denial on the debugger's raw-socket egress", () => {
  const LISTENERS = "/sap/bc/adt/debugger/listeners";
  /** A realistic listener query, as `src/debug/endpoints.ts` composes it. */
  const LISTENER_QS = {
    debuggingMode: "user",
    terminalId: "ABCDEF0123456789ABCDEF0123456789",
    ideId: "1DE1DE1DE1DE1DE1DE1DE1DE1DE1DE01",
    requestUser: "DEVELOPER",
    timeout: "60",
    checkConflict: "true",
    isNotifiedOnConflict: "true",
  };
  const IGNORE_LOCK_ENDPOINT = `/sap/bc/adt/cts/transportrequests/${TR}/relwithignlock`;

  /** Records every request it is asked to issue, and answers 200 with a token. */
  function spy(): { calls: { method: string; url: string }[]; fn: RawHttpRequestFn } {
    const calls: { method: string; url: string }[] = [];
    const fn: RawHttpRequestFn = async (req) => {
      calls.push({ method: req.method, url: req.url });
      return { status: 200, headers: { "x-csrf-token": "FRESH" }, body: "" };
    };
    return { calls, fn };
  }

  function longPoll(o: {
    requestFn?: RawHttpRequestFn;
    breaker?: AuthCircuitBreaker;
    baseUrl?: string;
  }): DebugLongPollClient {
    return new DebugLongPollClient({
      baseUrl: o.baseUrl ?? "http://sap.invalid",
      breaker: o.breaker ?? new AuthCircuitBreaker(),
      auth: {
        cookieHeader: () => "SAP_SESSIONID=x",
        csrfToken: () => "TOKEN",
        acquireSession: ACQUIRE_NO_SESSION_LEASE,
      },
      requestFn: o.requestFn,
    });
  }

  const codeOf = (e: unknown): string | null => (isAbapError(e) ? e.code : null);

  it("denies a transport-release ignore ENDPOINT driven through the long poll", async () => {
    const { calls, fn } = spy();
    const handle = longPoll({ requestFn: fn }).listen(IGNORE_LOCK_ENDPOINT);
    // The `finally` backstop must still settle `armed`, or a consumer awaiting it
    // hangs forever on a URL we refused.
    await handle.armed;
    const e = await handle.result.then(() => null).catch((err: unknown) => err);
    expect(codeOf(e)).toBe("HTTP_PATH_DENIED");
    expect(calls, "nothing may be dispatched for a denied long-poll URL").toEqual([]);
  });

  it("denies an ignoreLocks/ignoreATC PARAMETER, whether it arrives via qs or in the path", async () => {
    const cases: [string, { qs?: Record<string, string> }][] = [
      [LISTENERS, { qs: { ...LISTENER_QS, ignoreLocks: "true" } }],
      [LISTENERS, { qs: { IgnoreATC: "false" } }],
      [`${LISTENERS}?timeout=60&ignoreLocks=false`, {}],
    ];
    for (const [path, opts] of cases) {
      // `listen()` folds `qs` into the URL before the guard sees it, and a raw
      // request has no separate `qs` field — so the whole URL is what gets
      // checked, and the parameter rule applies to both spellings.
      const { calls, fn } = spy();
      const e = await longPoll({ requestFn: fn })
        .listen(path, opts)
        .result.then(() => null)
        .catch((err: unknown) => err);
      expect(codeOf(e), `${path} ${JSON.stringify(opts)}`).toBe("HTTP_PATH_DENIED");
      expect(calls).toEqual([]);
    }
  });

  it("an INJECTED requestFn cannot escape the denial", async () => {
    // The reason the assert is at the CALL SITE and not only inside
    // `defaultRawHttpRequest`: `requestFn` is caller-supplied. If the guard lived
    // only in the default sink, this substituted implementation would be outside
    // the denial entirely and would happily dispatch.
    let reached = false;
    const rogue: RawHttpRequestFn = async () => {
      reached = true;
      return { status: 200, headers: {}, body: "" };
    };
    const e = await longPoll({ requestFn: rogue })
      .listen(IGNORE_LOCK_ENDPOINT)
      .result.then(() => null)
      .catch((err: unknown) => err);
    expect(codeOf(e)).toBe("HTTP_PATH_DENIED");
    expect(reached, "an injected requestFn must never be reached for a denied URL").toBe(false);
  });

  it("refuses a denied URL WITHOUT consulting the breaker — either verdict", async () => {
    // Ordering, asserted as behaviour rather than as source position: the denial
    // must not depend on breaker state. A tripped breaker would otherwise answer
    // first with AUTH_CIRCUIT_OPEN, and the URL would be refused for a reason that
    // disappears the moment the breaker resets.
    const tripped = new AuthCircuitBreaker();
    tripped.inspect({ status: 401, headers: {}, body: "Unauthorized" }, "http://sap.invalid/x");
    expect(tripped.isTripped, "fixture precondition: the breaker is latched").toBe(true);

    const { calls, fn } = spy();
    const e = await longPoll({ requestFn: fn, breaker: tripped })
      .listen(IGNORE_LOCK_ENDPOINT)
      .result.then(() => null)
      .catch((err: unknown) => err);
    expect(codeOf(e)).toBe("HTTP_PATH_DENIED");
    expect(calls).toEqual([]);
  });

  it("leaves the client and the breaker usable — a denial is not a failure of theirs", async () => {
    const breaker = new AuthCircuitBreaker();
    const { calls, fn } = spy();
    const client = longPoll({ requestFn: fn, breaker });

    const e = await client
      .listen(IGNORE_LOCK_ENDPOINT)
      .result.then(() => null)
      .catch((err: unknown) => err);
    expect(codeOf(e)).toBe("HTTP_PATH_DENIED");
    // Not counted as a transient failure, not a claimed half-open probe slot, and
    // — because the denial lands inside `run()`'s try — `inFlight` was released.
    expect(breaker.isTripped).toBe(false);
    expect(breaker.state).toBe("closed");

    const ok = await client.listen(LISTENERS, { qs: LISTENER_QS }).result;
    expect(ok.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("denies through the CSRF HEAD path too", async () => {
    // `fetchCsrfToken` always builds `<baseUrl>/sap/bc/adt/core/discovery`, so the
    // only way to reach the rule today is a hostile or malformed `baseUrl`. That
    // is the point: the guard is a property of the egress path, not of what the
    // current call sites happen to compose.
    const { calls, fn } = spy();
    const e = await fetchCsrfToken({
      baseUrl: "http://sap.invalid?ignoreLocks=true",
      requestFn: fn,
      breaker: new AuthCircuitBreaker(),
    })
      .then(() => null)
      .catch((err: unknown) => err);
    expect(codeOf(e)).toBe("HTTP_PATH_DENIED");
    expect(calls).toEqual([]);
  });

  // ---------------------------------------------- no over-denial ------------

  it("does NOT deny an ordinary long poll, query string and all", async () => {
    const { calls, fn } = spy();
    const resp = await longPoll({ requestFn: fn }).listen(LISTENERS, { qs: LISTENER_QS }).result;
    expect(resp.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/sap/bc/adt/debugger/listeners?");
    expect(calls[0]?.url).toContain("debuggingMode=user");
    expect(calls[0]?.url).toContain("isNotifiedOnConflict=true");
  });

  it("does NOT deny an ordinary CSRF HEAD", async () => {
    const { calls, fn } = spy();
    const token = await fetchCsrfToken({
      baseUrl: "http://sap.invalid",
      requestFn: fn,
      breaker: new AuthCircuitBreaker(),
    });
    expect(token).toBe("FRESH");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://sap.invalid/sap/bc/adt/core/discovery");
  });

  it("does NOT deny debugger paths that merely resemble the denied ones", async () => {
    for (const path of [
      `${LISTENERS}?terminalId=relwithignlock`, // the token as a VALUE
      "/sap/bc/adt/debugger/relwithignlockdisabled", // a longer segment
      "/sap/bc/adt/debugger/breakpoints?doNotIgnoreLocks=true", // a different name
    ]) {
      const { calls, fn } = spy();
      const resp = await longPoll({ requestFn: fn }).listen(path).result;
      expect(resp.status, `${path} must not be refused`).toBe(200);
      expect(calls).toHaveLength(1);
    }
  });

  // ------------------------------- the DEFAULT sink, on a real socket -------

  describe("the default sink — proven against a socket that must never be opened", () => {
    let server: http.Server;
    let base = "";
    let connections = 0;
    let requests = 0;

    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        requests += 1;
        res.writeHead(200, { "content-type": "text/plain", "x-csrf-token": "FRESH" });
        res.end("ok");
      });
      server.on("connection", () => {
        connections += 1;
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("refuses a denied URL before a socket exists (no requestFn injected at all)", async () => {
      connections = 0;
      requests = 0;
      // No `requestFn` — this is `defaultRawHttpRequest`, the real node:http sink.
      const e = await longPoll({ baseUrl: base })
        .listen(IGNORE_LOCK_ENDPOINT)
        .result.then(() => null)
        .catch((err: unknown) => err);
      expect(codeOf(e)).toBe("HTTP_PATH_DENIED");
      expect(connections, "a denied URL must not open a socket").toBe(0);
      expect(requests).toBe(0);
    });

    it("refuses a denied URL handed straight to defaultRawHttpRequest", async () => {
      connections = 0;
      requests = 0;
      for (const url of [
        `${base}${IGNORE_LOCK_ENDPOINT}`,
        `${base}/sap/bc/adt/cts/transportrequests/${TR}/relobjigchkatc`,
        `${base}${LISTENERS}?ignoreLocks=true`,
      ]) {
        const e = await defaultRawHttpRequest({ method: "POST", url })
          .then(() => null)
          .catch((err: unknown) => err);
        expect(codeOf(e), url).toBe("HTTP_PATH_DENIED");
      }
      expect(connections, "the last line of defence must also be pre-socket").toBe(0);
      expect(requests).toBe(0);
    });

    it("still lets a real long poll reach the wire", async () => {
      connections = 0;
      requests = 0;
      const resp = await longPoll({ baseUrl: base }).listen(LISTENERS, { qs: LISTENER_QS }).result;
      expect(resp.status).toBe(200);
      expect(requests, "the guard must not break legitimate debugger traffic").toBe(1);
      expect(connections).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------- error hygiene ----------

describe("the denial never echoes caller data back", () => {
  it("names the parameter without leaking the query string it came from", async () => {
    const r = await attempt({
      url: `${BASE}/newreleasejobs?ignoreLocks=SECRETVALUE&sap-password=hunter2`,
    });
    expect(r.code).toBe("HTTP_PATH_DENIED");
    const dump = `${r.error?.message} ${JSON.stringify(r.error?.details ?? {})}`;
    expect(dump).toContain("ignorelocks");
    expect(dump).not.toContain("SECRETVALUE");
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("?");
  });

  it("does not leak a qs value either", async () => {
    const r = await attempt({
      url: `${BASE}/newreleasejobs`,
      qs: { ignoreLocks: "hunter2" },
    });
    expect(r.code).toBe("HTTP_PATH_DENIED");
    const dump = `${r.error?.message} ${JSON.stringify(r.error?.details ?? {})}`;
    expect(dump).not.toContain("hunter2");
  });

  it("does not leak a fragment", async () => {
    const r = await attempt({ url: `${BASE}/relwithignlock#hunter2` });
    expect(r.code).toBe("HTTP_PATH_DENIED");
    const dump = `${r.error?.message} ${JSON.stringify(r.error?.details ?? {})}`;
    expect(dump).not.toContain("hunter2");
  });
});
