/**
 * Productive-system detection must be TRI-STATE and fail CLOSED.
 *
 * The defect these tests exist to keep dead: `detectSystemRole()` returned
 * "unknown" for every system it could not classify, and `applyReadOnlyPolicy()`
 * then let `ABAP_ALLOW_WRITE` turn "unknown" into writes-ON. So the one case
 * where the server had no idea whether it was talking to production was the
 * case it granted write access to. Every "cannot tell" path — 403, the 406
 * Accept trap, junk XML, unknown logon client, no T000 row — must now end in
 * `inconclusive`, and `inconclusive` must be as write-locked as `productive`.
 *
 * Everything here is OFFLINE and driven off the REAL captured wire bytes in
 * test/fixtures/live-captured (087 = HTTP 200 success, 082 = 406 Accept trap,
 * 078 = 403 CSRF). The only synthetic bytes are a one-value mutation of the 087
 * capture (CCCATEGORY "C" -> "P"), because no productive system was available
 * to capture — the document shape is still the real one.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import {
  AbapConnection,
  classifyT000Response,
  isAbapTrue,
  logonClientFromCookies,
  toLegacySystemRole,
} from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";

const LIVE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const captured = (name: string): string => readFileSync(join(LIVE, name), "utf8");

/** HTTP 200, 1581 bytes: MANDT 000 -> "S", MANDT 001 -> "C". */
const T000_OK = captured("087-p3b-datapreview-t000.xml");
/** HTTP 406 body — what `Accept: application/xml` really answers. */
const T000_406 = captured("082-p3b-datapreview-t000.xml");
/** HTTP 403 body — `CSRF token validation failed`. */
const T000_403 = captured("078-p3-datapreview-t000.txt");
/** The `sap-usercontext` cookie VALUE as captured: literally `sap-client=001`. */
const USERCONTEXT = captured("p3b-sap-usercontext.txt").trim();

/** Same real document, with client 001's CCCATEGORY flipped to "P". */
const t000WithCategory = (value: string): string =>
  T000_OK.replace(
    "<dataPreview:data>C</dataPreview:data>",
    `<dataPreview:data>${value}</dataPreview:data>`,
  );

const ok = (body: string) => ({ status: 200, body });

// ---------------------------------------------------------------- parsing ---

describe("classifyT000Response — column-major T000 preview (fixture 087)", () => {
  it("zips the column-major response back into rows and picks the LOGON client", () => {
    // Client 001 is category "C" (customizing) and client 000 is "S": the two
    // rows must not be confused, which is the whole risk of a column-major
    // payload.
    const d001 = classifyT000Response(ok(T000_OK), "001");
    expect(d001).toMatchObject({ role: "nonproductive", client: "001", ccCategory: "C" });
    expect(d001.reason).toMatch(/CCCATEGORY = "C"/);

    const d000 = classifyT000Response(ok(T000_OK), "000");
    expect(d000).toMatchObject({ role: "nonproductive", ccCategory: "S" });
  });

  it('classifies CCCATEGORY "P" as productive, padded or lower-cased', () => {
    for (const raw of ["P", "P ", " p"]) {
      const d = classifyT000Response(ok(t000WithCategory(raw)), "001");
      expect(d.role).toBe("productive");
      expect(d.reason).toMatch(/production/i);
    }
  });

  it("treats a numeric-looking client as a 3-char key, not a number", () => {
    // `parseTagValue: false` in the parser: "001" must never become 1.
    expect(classifyT000Response(ok(T000_OK), "1").ccCategory).toBe("C");
    expect(classifyT000Response(ok(T000_OK), "0").ccCategory).toBe("S");
  });

  it("is inconclusive when the logon client has no row in T000", () => {
    const d = classifyT000Response(ok(T000_OK), "100");
    expect(d.role).toBe("inconclusive");
    expect(d.reason).toMatch(/no row for the logon client 100/);
  });

  it("is inconclusive when the logon client is unknown", () => {
    const d = classifyT000Response(ok(T000_OK), null);
    expect(d.role).toBe("inconclusive");
    expect(d.reason).toMatch(/logon client could not be determined/i);
  });

  it("is inconclusive on an empty CCCATEGORY", () => {
    const d = classifyT000Response(ok(t000WithCategory("  ")), "001");
    expect(d.role).toBe("inconclusive");
    expect(d.reason).toMatch(/empty/i);
  });

  // `classifyT000Response` used to treat `cc !== "P"` as proof of
  // non-productivity — any unrecognised value unlocked writes. It must now be
  // an allowlist: recognised non-productive values -> `nonproductive`,
  // anything else -> `inconclusive` (fail closed, like every other unknown
  // case in this function).
  it.each(["T", "C", "D", "E", "S"])(
    'classifies CCCATEGORY "%s" as nonproductive (recognised client role)',
    (value) => {
      const d = classifyT000Response(ok(t000WithCategory(value)), "001");
      expect(d.role).toBe("nonproductive");
      expect(d.ccCategory).toBe(value);
      expect(d.reason).toMatch(new RegExp(`CCCATEGORY = "${value}"`));
    },
  );

  it('classifies CCCATEGORY "S" as nonproductive even lower-cased/padded, matching the "P" handling', () => {
    for (const raw of ["s", "S ", " s"]) {
      const d = classifyT000Response(ok(t000WithCategory(raw)), "001");
      expect(d.role).toBe("nonproductive");
    }
  });

  // CONSTRUCTED, not observed: no live system has been seen with a CCCATEGORY
  // outside P/T/C/D/E/S. This is the allowlist regression case — an unrecognised
  // value must NOT be treated as non-productive.
  it.each([
    ["Z (a made-up single-char value, never observed live)", "Z"],
    ["ZZ (a made-up multi-char customer value, never observed live)", "ZZ"],
  ])("is inconclusive, NOT nonproductive, on a constructed unrecognised CCCATEGORY — %s", (_label, value) => {
    const d = classifyT000Response(ok(t000WithCategory(value)), "001");
    expect(d.role).toBe("inconclusive");
    expect(d.role).not.toBe("nonproductive");
    expect(d.ccCategory).toBe(value);
    expect(d.reason).toMatch(/not a recognised client role/i);
    expect(d.reason).not.toMatch(/is (non-?)?productive/i);
    expect(toLegacySystemRole(d)).toBe("unknown");
  });

  // AxiosHttpClient rejects any answered 4xx/5xx before AdtHTTP's status check
  // runs, so these statuses reach classifyT000Response only when handed directly.
  it("maps a 406 status handed directly (fixture 082 body) to inconclusive", () => {
    const d = classifyT000Response({ status: 406, body: T000_406 }, "001");
    expect(d.role).toBe("inconclusive");
    expect(d.reason).toMatch(/HTTP 406/);
    expect(d.reason).toMatch(/could not be proven non-productive/);
  });

  it("maps a 403 status handed directly (fixture 078 body) to inconclusive", () => {
    const d = classifyT000Response({ status: 403, body: T000_403 }, "001");
    expect(d.role).toBe("inconclusive");
    expect(d.reason).toMatch(/HTTP 403/);
    expect(d.reason).toMatch(/CSRF token validation failed/);
  });

  it("is inconclusive on a 2xx that isn't 200 (HTTP 204)", () => {
    const d = classifyT000Response({ status: 204, body: "" }, "001");
    expect(d.role).toBe("inconclusive");
    expect(d.reason).toMatch(/HTTP 204/);
  });

  it("is inconclusive on junk, on HTML, and on an empty body", () => {
    for (const body of ["", "not xml at all", "<html><body>Session Timed Out</body></html>", "<x/>"]) {
      expect(classifyT000Response(ok(body), "001").role).toBe("inconclusive");
    }
  });

  it("is inconclusive when the response has no CCCATEGORY column", () => {
    const noCat = T000_OK.replace(/dataPreview:name="CCCATEGORY"/, 'dataPreview:name="ZZZ"');
    const d = classifyT000Response(ok(noCat), "001");
    expect(d.role).toBe("inconclusive");
    expect(d.reason).toMatch(/missing MANDT and\/or CCCATEGORY/);
  });

  it("maps to the legacy SystemRole union the rest of the codebase compiles against", () => {
    expect(toLegacySystemRole(classifyT000Response(ok(T000_OK), "001"))).toBe("development");
    expect(toLegacySystemRole(classifyT000Response(ok(t000WithCategory("P")), "001"))).toBe(
      "productive",
    );
    expect(toLegacySystemRole(classifyT000Response(ok(T000_OK), null))).toBe("unknown");
  });
});

describe("logonClientFromCookies", () => {
  it("reads the captured sap-usercontext value", () => {
    expect(USERCONTEXT).toBe("sap-client=001");
    expect(logonClientFromCookies(`sap-usercontext=${USERCONTEXT}`)).toBe("001");
  });

  it("finds it inside a full cookie header", () => {
    const jar =
      "SAP_SESSIONID_A4H_001=abcDEF123==; sap-usercontext=sap-client=001; " +
      "saplb_*=(J2EE1234)1234550";
    expect(logonClientFromCookies(jar)).toBe("001");
  });

  it("returns null rather than guessing", () => {
    expect(logonClientFromCookies("")).toBeNull();
    expect(logonClientFromCookies(undefined)).toBeNull();
    expect(logonClientFromCookies("SAP_SESSIONID_A4H_001=abc; saplb_*=(J2EE1)1")).toBeNull();
  });
});

describe("isAbapTrue — the space-padded CHAR1 flags the old regex missed", () => {
  it('accepts "X " (space-padded), "1" and "abap_true"', () => {
    // /^(true|x|yes)$/i rejected every one of these.
    for (const v of ["X ", " x", "1", "abap_true", "ABAP_TRUE", "true", "TRUE", "yes", "y", "on"]) {
      expect(isAbapTrue(v), v).toBe(true);
    }
  });

  it("rejects everything else, including empty and null", () => {
    for (const v of ["", "  ", "false", "0", "no", "n", "off", "-", "P", "xx"]) {
      expect(isAbapTrue(v), v).toBe(false);
    }
    expect(isAbapTrue(null)).toBe(false);
    expect(isAbapTrue(undefined)).toBe(false);
  });
});

// ------------------------------------------------------- wire + write gate ---

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const OK_XML = { "content-type": "application/xml" };
const DP_XML = {
  "content-type": "application/vnd.sap.adt.datapreview.table.v1+xml; charset=utf-8",
};
const DATA_PREVIEW_ACCEPT = "application/vnd.sap.adt.datapreview.table.v1+xml";

interface Recorded {
  method: string;
  url: string;
  qs: Record<string, string>;
  headers: Record<string, string>;
  body?: string;
}

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: (r: Recorded) => HttpClientResponse | undefined) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const rec: Recorded = {
      method: (o.method ?? "GET").toUpperCase(),
      url: o.url,
      qs: (o.qs ?? {}) as Record<string, string>,
      headers: (o.headers ?? {}) as Record<string, string>,
      body: o.body,
    };
    this.calls.push(rec);
    if (rec.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
    if (rec.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
    return this.route(rec) ?? resp(200, "<settings/>", OK_XML);
  }
  get preview(): Recorded | undefined {
    return this.calls.find((c) => c.url.includes("/datapreview/freestyle"));
  }
}

/**
 * `FakeAdt` RESOLVES every status, including >= 400 — not what
 * `AxiosHttpClient` does. Its default `validateStatus` is 200-299, so an
 * answered 4xx/5xx REJECTS with a `HttpClientException`, built exactly as
 * `AxiosHttpClient.request()`'s own catch block builds it. Below 400 this
 * behaves like `FakeAdt`; at or above 400 it throws instead of resolving.
 */
class RejectingFakeAdt implements HttpClient {
  constructor(private readonly route: (r: Recorded) => HttpClientResponse | undefined) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const rec: Recorded = {
      method: (o.method ?? "GET").toUpperCase(),
      url: o.url,
      qs: (o.qs ?? {}) as Record<string, string>,
      headers: (o.headers ?? {}) as Record<string, string>,
      body: o.body,
    };
    if (rec.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
    if (rec.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
    const r = this.route(rec) ?? resp(200, "<settings/>", OK_XML);
    if (r.status < 400) return r;
    throw new HttpClientException(
      `Request failed with status code ${r.status}`,
      undefined,
      r.status,
      undefined,
      o,
      { body: r.body, status: r.status, statusText: String(r.status), headers: r.headers } as HttpClientResponse,
      undefined,
    );
  }
}

const cfg = (over: Partial<Config> = {}): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    ...over,
  });

/** `ABAP_ALLOW_WRITE=1`. */
const writableCfg = (over: Partial<Config> = {}): Config => cfg({ readOnly: false, ...over });

async function connectWith(
  adt: HttpClient,
  c: Config,
): Promise<{ conn: AbapConnection; logs: string[] }> {
  const logs: string[] = [];
  const conn = new AbapConnection(c, {
    httpClient: adt,
    log: (m) => logs.push(m),
    breaker: new AuthCircuitBreaker(),
  });
  try {
    await conn.connect();
    return { conn, logs };
  } finally {
    conn.dispose();
  }
}

async function connect(
  route: (r: Recorded) => HttpClientResponse | undefined,
  c: Config = writableCfg(),
): Promise<{ conn: AbapConnection; adt: FakeAdt; logs: string[] }> {
  const adt = new FakeAdt(route);
  const { conn, logs } = await connectWith(adt, c);
  return { conn, adt, logs };
}

/** Same as `connect()`, over the transport double that REJECTS an answered 4xx/5xx. */
async function connectRejecting(
  route: (r: Recorded) => HttpClientResponse | undefined,
  c: Config = writableCfg(),
): Promise<{ conn: AbapConnection; adt: RejectingFakeAdt; logs: string[] }> {
  const adt = new RejectingFakeAdt(route);
  const { conn, logs } = await connectWith(adt, c);
  return { conn, adt, logs };
}

/**
 * A fake that behaves like the REAL server did on the wire: the data preview
 * answers 406 for every Accept value except the one live-proven to work.
 * If the production header constant ever drifts, this goes red instead of
 * silently degrading to "inconclusive" (i.e. to a permanently read-only server
 * that looks like it is merely being careful).
 */
const pickyServer = (r: Recorded): HttpClientResponse | undefined => {
  if (!r.url.includes("/datapreview/freestyle")) return undefined;
  const accept = r.headers["Accept"] ?? r.headers["accept"] ?? "";
  if (accept !== DATA_PREVIEW_ACCEPT) return resp(406, T000_406, OK_XML);
  return resp(200, T000_OK, DP_XML);
};

describe("the T000 probe on the wire", () => {
  it("sends exactly the request the live capture proves works", async () => {
    const { conn, adt } = await connect(pickyServer);
    const req = adt.preview;
    expect(req).toBeDefined();
    expect(req!.method).toBe("POST");
    expect(req!.url).toBe("/sap/bc/adt/datapreview/freestyle");
    expect(req!.qs).toEqual({ rowNumber: "20" });
    // ⚠️ live-proven: `application/xml` is a 406 (fixture 082).
    expect(req!.headers["Accept"]).toBe(DATA_PREVIEW_ACCEPT);
    expect(req!.headers["Content-Type"]).toBe("text/plain");
    expect(req!.body).toBe("SELECT mandt, cccategory, cccoractiv FROM t000");
    // …and the picky server accepted it, so the system was actually classified.
    expect(conn.roleDetection.role).toBe("nonproductive");
  });

  /**
   * ONE is a decided number, not an observed one.
   *
   * This assertion once read 1 and the code did 4: two retry layers that did
   * not know about each other (`AbapConnection.request()`'s CSRF replay, and
   * `abap-adt-api`'s own re-logon-and-resend on a CSRF 403, which counts as an
   * `isLoginError`) multiplied 2 x 2. Three surplus logons came with them.
   *
   * The number was NOT relaxed to 4 to make this green, because every one of
   * those extra attempts was worthless HERE: the only fault a retry can repair
   * is a stale CSRF token, and this probe runs milliseconds after `login()`
   * captured a fresh one. A 403 on a just-issued token is structural, not
   * transient — it IS the verdict, and the verdict is `inconclusive`. Re-asking
   * only spends a dialog work process (roughly 7 on the appliance, and that
   * figure is merely inferred from the RZ10 profile, never confirmed against
   * SM50) and a logon attempt (5-attempt user lock) at the exact moment the
   * system is least willing to talk. See `probeT000` in src/adt/connection.ts.
   *
   * Asking once cannot weaken the gate: fewer attempts only ever move the
   * answer towards `inconclusive`, which is the locked-out side. The tail of
   * this test pins that the verdict and the lockout are unchanged.
   */
  it("costs a single POST — no retry loop when the answer is inconclusive", async () => {
    const { conn, adt } = await connect((r) =>
      r.url.includes("/datapreview/freestyle") ? resp(403, T000_403, {}) : undefined,
    );
    expect(adt.calls.filter((c) => c.url.includes("/datapreview/freestyle"))).toHaveLength(1);

    // …and it does not smuggle the cost in as logons either. `connect()`
    // promises "exactly ONE logon attempt is ever made"; the retry layers used
    // to break that promise three times over on this single 403.
    expect(adt.calls.filter((c) => c.url.includes("/compatibility/graph"))).toHaveLength(1);

    // The verdict and the gate are byte-for-byte what they were at 4 POSTs.
    expect(conn.roleDetection.role).toBe("inconclusive");
    expect(conn.readOnly).toBe(true);
    expect(conn.writesLockedOut).toBe(true);
  });

  it("does not probe /sap/bc/adt/runtime/workprocesses (405 on both verbs, live-proven)", async () => {
    const { adt } = await connect(pickyServer);
    expect(adt.calls.some((c) => c.url.includes("workprocesses"))).toBe(false);
  });

  it("reaches classifyT000Response's non-200 branch for real: a 204 resolves through axios", async () => {
    // AxiosHttpClient's default validateStatus is 200-299, so a 204 RESOLVES,
    // unlike an answered 4xx/5xx, which rejects before AdtHTTP's status check runs.
    const { conn } = await connect((r) =>
      r.url.includes("/datapreview/freestyle") ? resp(204, "", {}) : undefined,
    );
    expect(conn.roleDetection.role).toBe("inconclusive");
    expect(conn.roleDetection.reason).toMatch(/HTTP 204/);
    expect(conn.readOnly).toBe(true);
    expect(conn.writesLockedOut).toBe(true);
  });
});

/**
 * An answered 403/406 arrives at probeT000 as a rejection carrying the
 * library's own message, not as a status probeT000 can read.
 */
describe("the T000 probe on the wire — an answered 403/406 rejects, it does not resolve", () => {
  it("403 (fixture 078, CSRF) reports the CSRF message, not a fabricated HTTP 403", async () => {
    const { conn } = await connectRejecting((r) =>
      r.url.includes("/datapreview/freestyle") ? resp(403, T000_403, {}) : undefined,
    );
    expect(conn.roleDetection.role).toBe("inconclusive");
    expect(conn.roleDetection.reason).toMatch(/T000 data-preview probe failed/);
    expect(conn.roleDetection.reason).toMatch(/CSRF token validation failed/);
    expect(conn.roleDetection.reason).not.toMatch(/HTTP 403/);
    // Not a dropped probe (that's the `probeFailure` boundary) — this
    // one got answered, just with a rejection instead of the 403 status.
    expect(conn.roleDetection.probeFailure).toBeUndefined();
    expect(conn.readOnly).toBe(true);
    expect(conn.writesLockedOut).toBe(true);
  });

  it("406 (fixture 082, Accept trap) reports the library's own message, not a fabricated HTTP 406", async () => {
    const { conn } = await connectRejecting((r) =>
      r.url.includes("/datapreview/freestyle") ? resp(406, T000_406, OK_XML) : undefined,
    );
    expect(conn.roleDetection.role).toBe("inconclusive");
    expect(conn.roleDetection.reason).toMatch(/T000 data-preview probe failed/);
    expect(conn.roleDetection.reason).toMatch(/not acceptable/i);
    expect(conn.roleDetection.reason).not.toMatch(/HTTP 406/);
    expect(conn.roleDetection.probeFailure).toBeUndefined();
    expect(conn.readOnly).toBe(true);
    expect(conn.writesLockedOut).toBe(true);
  });
});

/**
 * A 500 with a body that is not ADT exception XML: the generic
 * probe-failure reason must be reported, not a fabricated HTTP-500 message.
 */
describe("the T000 probe on the wire — a 500 with a non-XML body", () => {
  it("500 with a non-XML body (<html>dump</html>) reports the generic probe-failure reason, not a fabricated HTTP 500 message", async () => {
    const { conn } = await connect((r) =>
      r.url.includes("/datapreview/freestyle") ? resp(500, "<html>dump</html>", {}) : undefined,
    );
    expect(conn.roleDetection.role).toBe("inconclusive");
    expect(conn.roleDetection.reason).toMatch(/T000 data-preview probe failed/);
    expect(conn.roleDetection.reason).not.toMatch(/returned HTTP 500/);
    expect(conn.readOnly).toBe(true);
    expect(conn.writesLockedOut).toBe(true);
  });
});

describe("the write gate is fail-CLOSED", () => {
  it("locks writes out on a productive system, opt-in or not", async () => {
    const { conn, logs } = await connect((r) =>
      r.url.includes("/datapreview/freestyle")
        ? resp(200, t000WithCategory("P"), DP_XML)
        : undefined,
    );
    expect(conn.roleDetection.role).toBe("productive");
    expect(conn.systemRole).toBe("productive");
    expect(conn.readOnly).toBe(true);
    expect(conn.writesLockedOut).toBe(true);
    expect(conn.info().writesLockedOut).toBe(true);
    expect(logs.join("\n")).toMatch(/PRODUCTIVE/);
  });

  it.each([
    ["403 CSRF (fixture 078)", () => resp(403, T000_403, {})],
    ["406 Accept trap (fixture 082)", () => resp(406, T000_406, OK_XML)],
    ["500", () => resp(500, "<html>dump</html>", {})],
    ["200 with junk", () => resp(200, "not xml", DP_XML)],
    ["200 with no row for this client", () => resp(200, T000_OK, DP_XML)],
  ])(
    "REFUSES writes when detection is inconclusive — %s — even with ABAP_ALLOW_WRITE",
    async (_label, make) => {
      // client 900 has no T000 row, which also covers the last case above.
      const { conn } = await connect(
        (r) => (r.url.includes("/datapreview/freestyle") ? make() : undefined),
        writableCfg({ client: "900" }),
      );
      expect(conn.roleDetection.role).toBe("inconclusive");
      expect(conn.systemRole).toBe("unknown");
      // THE regression: pre-fix this was `false` — an unclassifiable system
      // with an opt-in got write access.
      expect(conn.readOnly).toBe(true);
      expect(conn.writesLockedOut).toBe(true);
      expect(conn.readOnlyReason).toMatch(/ABAP_ALLOW_WRITE cannot override/);
    },
  );

  it("honours the opt-in only on a system PROVEN non-productive", async () => {
    const { conn } = await connect(pickyServer);
    expect(conn.roleDetection).toMatchObject({
      role: "nonproductive",
      client: "001",
      ccCategory: "C",
    });
    expect(conn.readOnly).toBe(false);
    expect(conn.writesLockedOut).toBe(false);
    expect(conn.info().roleDetection.ccCategory).toBe("C");
  });

  it("still refuses writes on a proven non-productive system without the opt-in", async () => {
    const { conn } = await connect(pickyServer, cfg());
    expect(conn.roleDetection.role).toBe("nonproductive");
    expect(conn.readOnly).toBe(true);
    // …but not because it is locked out — the operator simply did not ask.
    expect(conn.writesLockedOut).toBe(false);
  });

  it("escalates to productive when ato/settings says so, even space-padded", async () => {
    // A one-way ratchet: T000 says "C", ato/settings says production. The
    // conflict resolves towards productive, and `isProductionSystem="X "` (the
    // space-padded CHAR1 the old /^(true|x|yes)$/ missed) must count.
    const { conn } = await connect((r) => {
      if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_OK, DP_XML);
      if (r.url.includes("/ato/settings"))
        return resp(200, `<settings isProductionSystem="X "/>`, OK_XML);
      return undefined;
    });
    expect(conn.roleDetection.role).toBe("productive");
    expect(conn.readOnly).toBe(true);
    expect(conn.writesLockedOut).toBe(true);
  });

  it("never downgrades: a silent ato/settings leaves the T000 verdict alone", async () => {
    const { conn } = await connect((r) => {
      if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_OK, DP_XML);
      if (r.url.includes("/ato/settings"))
        return resp(200, `<settings isExtendedInboundServices="true"/>`, OK_XML);
      return undefined;
    });
    expect(conn.roleDetection.role).toBe("nonproductive");
    expect(conn.readOnly).toBe(false);
  });
});

/**
 * Structural tripwire on the extraction itself, in the same spirit as
 * `test/pool.test.ts`'s block on `src/adt/pool.ts`.
 *
 * When system-role detection was lifted out of `connection.ts`, the four
 * helpers both halves need (`DATA_PREVIEW_ACCEPT`, `isAbapTrue`,
 * `normaliseClient`, `logonClientFromCookies`) briefly stayed behind, which
 * made `connection.ts` and `system-role.ts` import EACH OTHER. That cycle was
 * benign under Node16 ESM — hoisted function declarations, type-only surface —
 * but `src/adt` had none before, and "benign until someone adds a top-level
 * side effect" is not a property worth inheriting. The four moved down into
 * `wire-values.ts`, which imports nothing.
 *
 * Behaviour cannot detect the cycle coming back; source text can.
 */
describe("structural invariants of the system-role extraction", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../src/adt/${rel}`, import.meta.url)), "utf8");

  it("system-role.ts does not import connection.ts", () => {
    expect(read("system-role.ts")).not.toMatch(/from\s+"\.\/connection\.js"/);
  });

  it("wire-values.ts is a leaf — it imports nothing at all", () => {
    // The whole point of the file. One import here and it can start a new cycle.
    expect(read("wire-values.ts")).not.toMatch(/^\s*import\s/m);
  });

  it("connection.ts still re-exports the four, so import sites keep resolving", () => {
    const src = read("connection.ts");
    for (const name of [
      "DATA_PREVIEW_ACCEPT",
      "isAbapTrue",
      "normaliseClient",
      "logonClientFromCookies",
    ]) {
      expect(src, `${name} must stay reachable from connection.js`).toContain(name);
    }
    expect(src).toMatch(/export\s*{[^}]*}\s*from\s*"\.\/wire-values\.js"/s);
  });
});
