/**
 * `TRAN/T` create bridge — offline. Nothing here touches SAP; the transport is
 * faked through `ConnectionOptions.httpClient`, repeating
 * `test/enhancement-bridge.test.ts`'s self-contained `RecordingClient`/`resp`/
 * `connected`/`objectHappyPath` harness (that file's own header explains why
 * each suite keeps its own small copy rather than sharing one heavier fake).
 *
 * What these tests are FOR, beyond coverage: every parameter name and every
 * exception in the generated `RPY_TRANSACTION_INSERT` call is an ASSUMPTION —
 * the source it came from paraphrased that signature in prose instead of
 * pasting it. So these tests cannot prove
 * the call is RIGHT; only a live run can. What they can and do prove is that
 * the call is the one this module intends to make, that no caller string can
 * change its shape, and that a failure is never reported as a success.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import {
  DDIC_BRIDGE_CLASS,
  DDIC_BRIDGE_PACKAGE,
  DDIC_ERR_PREFIX,
  assertDdicTranscript,
  ddicBridgeSource,
  parseDdicTranscript,
} from "../src/adt/ddic-bridge.js";
import {
  TRAN_DATA_LINES,
  createTransaction,
  transactionFragment,
  type TransactionParams,
} from "../src/adt/tran-create.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Fake transport — same shape as test/enhancement-bridge.test.ts
// ---------------------------------------------------------------------------

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    readOnly: false,
  });

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
  statusText = String(status),
): HttpClientResponse => ({ status, statusText, body, headers }) as unknown as HttpClientResponse;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

const SESSION_URL = "/sap/bc/adt/compatibility/graph";
const CLASS_COLLECTION = "/sap/bc/adt/oo/classes";
const BRIDGE = DDIC_BRIDGE_CLASS.createTransaction;
const BRIDGE_SOURCE_URI = `${CLASS_COLLECTION}/${BRIDGE.toLowerCase()}/source/main`;

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

/** GET-404 → POST-create → LOCK → PUT → UNLOCK for the bridge class itself. */
function objectHappyPath(collectionUrl: string, name: string): (o: HttpClientOptions) => HttpClientResponse | undefined {
  const objUrl = `${collectionUrl}/${name.toLowerCase()}`;
  const sourceUri = `${objUrl}/source/main`;
  return (o: HttpClientOptions) => {
    const qs = (o.qs ?? {}) as Record<string, string>;
    const method = (o.method ?? "GET").toUpperCase();
    if (o.url === objUrl && method === "GET" && !qs._action) {
      const r = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
      throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
    }
    if (o.url === collectionUrl && method === "POST") return resp(200, "", {});
    if (o.url === objUrl && qs._action === "LOCK") return resp(200, LOCK_XML(), { "content-type": "application/xml" });
    if (o.url === objUrl && qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (o.url === sourceUri && method === "PUT") return resp(200, "", { "content-type": "text/plain" });
    return undefined;
  };
}

/** Session/discovery/activation/classrun plumbing shared by every test below. */
function sharedRoute(
  classrun: (o: HttpClientOptions) => HttpClientResponse | undefined,
): (o: HttpClientOptions) => HttpClientResponse | undefined {
  return (o: HttpClientOptions) => {
    if (o.url.startsWith("/sap/bc/adt/oo/classrun/")) return classrun(o);
    if (o.url.includes(SESSION_URL)) {
      return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
    }
    if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
    if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
    if (o.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return undefined;
  };
}

function combine(
  ...routes: Array<(o: HttpClientOptions) => HttpClientResponse | undefined>
): (o: HttpClientOptions) => HttpClientResponse {
  return (o: HttpClientOptions) => {
    for (const r of routes) {
      const hit = r(o);
      if (hit) return hit;
    }
    throw new Error(`unrouted request: ${(o.method ?? "GET").toUpperCase()} ${o.url}`);
  };
}

async function connected(
  route: (o: HttpClientOptions) => HttpClientResponse,
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(route);
  const conn = new AbapConnection(cfg(), {
    httpClient: inner,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner };
}

/**
 * A bare classrun body — see `test/enhancement-bridge.test.ts`'s own note: a
 * classrun class's `out->write('TAG')` output is the whole line, unprefixed.
 * No `LIST> ` prefix here; that belongs to run.ts's report bridge.
 */
function classrunOutput(lines: readonly string[]): (o: HttpClientOptions) => HttpClientResponse {
  const body = lines.join("\n");
  return () => resp(200, body, { "content-type": "text/plain" });
}

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!e || !isAbapError(e)) throw new Error(`expected an AbapError, got ${String(e)}`);
  return e;
};

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/** Allows BOTH the bridge class ($TMP) and the transaction's own package (ZTM). */
const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [DDIC_BRIDGE_PACKAGE, "ZTM"],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

/**
 * Allows the bridge class in `$TMP` and NOTHING else. This is the gate that
 * isolates the SECOND gate (`assertBridgeMutation`): `deployBridge`'s own
 * checks pass under it — `ZCL_ZMCP_DDIC_CTRAN` really is a `$TMP` class — so
 * the only thing that can refuse a `TRAN/T` in package `ZTM` is the domain
 * gate `createTransaction` runs itself, before generating any ABAP.
 */
const bridgeOnlyGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [DDIC_BRIDGE_PACKAGE],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PARAMS: TransactionParams = {
  tcode: "ZTM_CARRIERS",
  program: "ZTM_CARRIER_LIST",
  description: "Carrier list",
  packageName: "ZTM",
};

const sourceFor = (p: TransactionParams = PARAMS): string =>
  ddicBridgeSource(BRIDGE, TRAN_DATA_LINES, transactionFragment(p));

/** Every `out->write( 'X' )` literal the fragment emits, in emission order. */
function emittedTags(lines: readonly string[]): string[] {
  const tags: string[] = [];
  for (const line of lines) {
    const m = /out->write\(\s*'([^']*)'\s*\)/.exec(line);
    if (m?.[1]) tags.push(m[1]);
  }
  return tags;
}

// ---------------------------------------------------------------------------
// 1 — generator/parser drift
// ---------------------------------------------------------------------------

describe("generator/parser drift", () => {
  it("every tag transactionFragment emits is one parseDdicTranscript recognises — asserted as a SET", () => {
    const tags = emittedTags(transactionFragment(PARAMS));
    expect(tags).toEqual(["TRAN-CREATED"]);
    // The generator's own output, replayed as a transcript. A tag renamed on
    // EITHER side (fragment or DDIC_TAGS) breaks this.
    const parsed = parseDdicTranscript(tags.join("\n"));
    expect(parsed.tags).toEqual(["TRAN-CREATED"]);
    expect(new Set(parsed.tags)).toEqual(new Set(tags));
    expect(parsed.errorLine).toBeUndefined();
  });

  it("assertDdicTranscript is satisfied by the fragment's own success output", () => {
    const tags = emittedTags(transactionFragment(PARAMS));
    expect(() =>
      assertDdicTranscript(parseDdicTranscript(tags.join("\n")), ["TRAN-CREATED"], "Creating transaction"),
    ).not.toThrow();
  });

  it("the fragment's failure branch writes a line parseDdicTranscript reads as an error, not a tag", () => {
    const errLine = transactionFragment(PARAMS).find((l) => l.includes(DDIC_ERR_PREFIX));
    expect(errLine).toBeTruthy();
    const parsed = parseDdicTranscript(`${DDIC_ERR_PREFIX} RPY_TRANSACTION_INSERT failed, sy-subrc=2`);
    expect(parsed.tags).toEqual([]);
    expect(parsed.errorLine).toContain("sy-subrc=2");
  });
});

// ---------------------------------------------------------------------------
// 2 — closed template / injection: refused, never escaped, before any I/O
// ---------------------------------------------------------------------------

describe("closed template — caller strings are refused, not escaped", () => {
  /**
   * A null connection IS the assertion, exactly as `test/write.test.ts` uses
   * its own `offline`: any code path that reaches the wire before validating
   * throws a TypeError instead of the BAD_INPUT these tests demand.
   */
  const offline = null as unknown as AbapConnection;

  const bad = ["ZX'INJECT", "ZX.INJECT", "ZX\nINJECT", "ZX INJECT"];

  for (const value of bad) {
    it(`refuses tcode ${JSON.stringify(value)} with BAD_INPUT, before any network call`, async () => {
      const err = await catchErr(createTransaction(offline, allowingGate(), { ...PARAMS, tcode: value }));
      expect(err.code).toBe("BAD_INPUT");
    });

    it(`refuses program ${JSON.stringify(value)} with BAD_INPUT, before any network call`, async () => {
      const err = await catchErr(createTransaction(offline, allowingGate(), { ...PARAMS, program: value }));
      expect(err.code).toBe("BAD_INPUT");
    });
  }

  // A description is FREE TEXT, so a quote and a period are legitimate there
  // and get escaped/embedded, not refused — but a control character is refused
  // outright (assertAbapText), because an ABAP literal cannot span lines.
  it("refuses a description containing a newline with BAD_INPUT, before any network call", async () => {
    const err = await catchErr(
      createTransaction(offline, allowingGate(), { ...PARAMS, description: "line1\nline2" }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("escapes — does not refuse — a quote or a period in the description, and keeps the literal closed", () => {
    const source = sourceFor({ ...PARAMS, description: "Fritz's list. v2" });
    expect(source).toContain("shorttext         = 'Fritz''s list. v2'");
  });

  it("refuses a description longer than TSTCT-TTEXT's 37 characters — refused, never truncated", async () => {
    const tooLong = "X".repeat(38);
    const err = await catchErr(createTransaction(offline, allowingGate(), { ...PARAMS, description: tooLong }));
    expect(err.code).toBe("BAD_INPUT");
    // The refusal is not a silent shortening: nothing 37 characters long
    // derived from the input can appear anywhere.
    expect(err.message).toContain("37");
    expect(() => transactionFragment({ ...PARAMS, description: tooLong })).toThrow();
  });

  it("refuses a tcode longer than TSTC-TCODE's 20 characters", async () => {
    const err = await catchErr(
      createTransaction(offline, allowingGate(), { ...PARAMS, tcode: `Z${"A".repeat(20)}` }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  /**
   * The case that would be a real injection if the value were merely escaped
   * rather than refused: a tcode that closes the ABAP literal and appends a
   * statement. The proof is not just "it threw" — it is that NO SOURCE EXISTS.
   */
  it("refuses a tcode that would close the literal and append a statement — and produces no source at all", async () => {
    const evil = `ZX'. LEAVE PROGRAM. "`;
    const err = await catchErr(createTransaction(offline, allowingGate(), { ...PARAMS, tcode: evil }));
    expect(err.code).toBe("BAD_INPUT");

    let generated: string | undefined;
    try {
      generated = sourceFor({ ...PARAMS, tcode: evil });
    } catch {
      generated = undefined;
    }
    expect(generated).toBeUndefined();
    // And, belt and braces: the clean source never contains that statement.
    expect(sourceFor()).not.toContain("LEAVE PROGRAM");
  });

  it("refuses a non-string tcode rather than stringifying it", async () => {
    const err = await catchErr(
      createTransaction(offline, allowingGate(), { ...PARAMS, tcode: 42 as unknown as string }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });
});

// ---------------------------------------------------------------------------
// 3 — the SECOND gate runs, and runs FIRST (zero-network)
// ---------------------------------------------------------------------------

describe("the second gate — the domain object, before any ABAP is generated", () => {
  it("a gate that refuses TRAN/T in package ZTM makes createTransaction throw with ZERO requests made", async () => {
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["TRAN-CREATED"])));
    const { conn, inner } = await connected(route);

    const err = await catchErr(createTransaction(conn, bridgeOnlyGate(), PARAMS));
    expect(err).toBeTruthy();
    // Ordering, not just the throw: the bridge-class deploy would have been
    // ALLOWED under this gate ($TMP is in its allowlist), so a single request
    // here means the domain gate ran too late — or not at all.
    expect(inner.calls.length).toBe(0);
    expect(inner.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(false);
  });

  it("a readOnly gate refuses too, with zero requests made", async () => {
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["TRAN-CREATED"])));
    const { conn, inner } = await connected(route);
    const readOnly = new SafetyGate({
      readOnly: true,
      allowPackages: [DDIC_BRIDGE_PACKAGE, "ZTM"],
      writesLockedOut: false,
    });
    const err = await catchErr(createTransaction(conn, readOnly, PARAMS));
    expect(err).toBeTruthy();
    expect(inner.calls.length).toBe(0);
  });

  it("does NOT assert `activate` on the transaction — a transaction has no activation step", async () => {
    const seen: string[] = [];
    class RecordingGate extends SafetyGate {
      override assert(op: Parameters<SafetyGate["assert"]>[0], obj?: Parameters<SafetyGate["assert"]>[1], opts?: Parameters<SafetyGate["assert"]>[2]): void {
        if (obj?.type === "TRAN/T") seen.push(op);
        super.assert(op, obj, opts);
      }
    }
    const gate = new RecordingGate({
      readOnly: false,
      allowPackages: [DDIC_BRIDGE_PACKAGE, "ZTM"],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["TRAN-CREATED"])));
    const { conn } = await connected(route);
    await createTransaction(conn, gate, PARAMS);
    expect(seen).toEqual(["write"]);
  });
});

// ---------------------------------------------------------------------------
// 4 — the sy-subrc check is present, and BETWEEN the call and the tag
// ---------------------------------------------------------------------------

describe("the sy-subrc guard", () => {
  /**
   * RPY_TRANSACTION_INSERT reports every failure through classic `EXCEPTIONS`,
   * i.e. `sy-subrc` — which no `CATCH cx_root` in the bridge scaffold will
   * ever see. A fragment that wrote TRAN-CREATED unconditionally would report
   * success for a call that did nothing. `already_exist` is the single most
   * likely real-world outcome and it is a `sy-subrc`, not a dump.
   */
  it("generates `IF sy-subrc <> 0.` BETWEEN the CALL FUNCTION and the success tag", () => {
    const source = sourceFor();
    const call = source.indexOf("CALL FUNCTION 'RPY_TRANSACTION_INSERT'");
    const guard = source.indexOf("sy-subrc <> 0");
    const tag = source.indexOf("out->write( 'TRAN-CREATED' )");
    expect(call).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(call);
    expect(tag).toBeGreaterThan(guard);
  });

  it("the guard RETURNs before the tag, and reports sy-subrc in the error line", () => {
    const lines = transactionFragment(PARAMS);
    const guardIdx = lines.findIndex((l) => l.includes("sy-subrc <> 0"));
    const returnIdx = lines.findIndex((l) => l.trim() === "RETURN.");
    const tagIdx = lines.findIndex((l) => l.includes("out->write( 'TRAN-CREATED' )"));
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(returnIdx).toBeGreaterThan(guardIdx);
    expect(tagIdx).toBeGreaterThan(returnIdx);
    expect(lines.some((l) => l.includes(DDIC_ERR_PREFIX) && l.includes("sy-subrc"))).toBe(true);
  });

  it("declares every EXCEPTION the guard's sy-subrc values come from, including already_exist", () => {
    const source = sourceFor();
    for (const exc of [
      "cancelled = 1",
      "already_exist = 2",
      "permission_error = 3",
      "name_not_allowed = 4",
      "name_conflict = 5",
      "illegal_type = 6",
      "object_inconsistent = 7",
      "db_access_error = 8",
      "OTHERS = 9",
    ]) {
      expect(source).toContain(exc);
    }
  });
});

// ---------------------------------------------------------------------------
// 5 — a failing transcript is a failure
// ---------------------------------------------------------------------------

describe("a failing transcript is a failure", () => {
  it("HTTP 200 with EMPTY classrun output throws CHECK_FAILED", async () => {
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput([])));
    const { conn } = await connected(route);
    const err = await catchErr(createTransaction(conn, allowingGate(), PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
  });

  it("a ZMCP-DDIC-ERR> line throws CHECK_FAILED, quoting the server's own text", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput([`${DDIC_ERR_PREFIX} RPY_TRANSACTION_INSERT failed, sy-subrc=2, `])),
    );
    const { conn } = await connected(route);
    const err = await catchErr(createTransaction(conn, allowingGate(), PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("sy-subrc=2");
  });

  it("output carrying some OTHER tag is not success either", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["VIEW-PUT"])),
    );
    const { conn } = await connected(route);
    const err = await catchErr(createTransaction(conn, allowingGate(), PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
  });
});

// ---------------------------------------------------------------------------
// 6 — suppress_corr_insert is NOT passed
// ---------------------------------------------------------------------------

describe("suppress_corr_insert", () => {
  /**
   * Leaving this parameter at its default is what makes the FM call
   * `RS_CORR_INSERT` itself and register the new transaction in TADIR /
   * attach it to a transport — the capture confirms that call is in the FM's
   * own body. Passing it would skip that registration and leave a transaction
   * with no repository entry behind it.
   */
  it("is absent from the generated source", () => {
    const source = sourceFor();
    expect(source.toLowerCase()).not.toContain("suppress_corr_insert");
    // ... and nothing else smuggles the same idea in.
    expect(source.toLowerCase()).not.toContain("corr_insert");
  });
});

// ---------------------------------------------------------------------------
// 7 — happy path
// ---------------------------------------------------------------------------

describe("createTransaction happy path", () => {
  it("writes, activates and runs the bridge; reports TRAN-CREATED", async () => {
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["TRAN-CREATED"])));
    const { conn, inner } = await connected(route);

    const { transcript, run } = await createTransaction(conn, allowingGate(), PARAMS);
    expect(transcript.tags).toEqual(["TRAN-CREATED"]);
    expect(transcript.errorLine).toBeUndefined();
    expect(run.output).toContain("TRAN-CREATED");

    const methods = inner.calls.map((c) => (c.method ?? "GET").toUpperCase());
    expect(methods).toContain("PUT");
    expect(inner.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
  });

  it("the source actually PUT over the wire carries the RPY_TRANSACTION_INSERT call, every parameter spelled out", async () => {
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["TRAN-CREATED"])));
    const { conn, inner } = await connected(route);
    await createTransaction(conn, allowingGate(), PARAMS);

    const put = inner.calls.find(
      (c) => (c.method ?? "").toUpperCase() === "PUT" && c.url === BRIDGE_SOURCE_URI,
    );
    const body = String(put?.body);
    expect(body).toContain("CALL FUNCTION 'RPY_TRANSACTION_INSERT'");
    expect(body).toContain("EXPORTING transaction       = 'ZTM_CARRIERS'");
    expect(body).toContain("program           = 'ZTM_CARRIER_LIST'");
    expect(body).toContain("dynpro            = '1000'");
    expect(body).toContain("language          = sy-langu");
    expect(body).toContain("development_class = 'ZTM'");
    expect(body).toContain("transaction_type  = 'R'");
    expect(body).toContain("shorttext         = 'Carrier list'");
    expect(body).toContain("EXCEPTIONS cancelled = 1 already_exist = 2 permission_error = 3");
  });

  it("accepts a $TMP package (allowLocal) without widening anything else", () => {
    const source = sourceFor({ ...PARAMS, packageName: "$TMP" });
    expect(source).toContain("development_class = '$TMP'");
  });

  it("TRAN_DATA_LINES is empty — the fragment needs no locals", () => {
    expect(TRAN_DATA_LINES).toEqual([]);
    expect(sourceFor()).not.toContain("    DATA ");
  });
});

// ---------------------------------------------------------------------------
// 8 — no view-maintenance vocabulary anywhere
// ---------------------------------------------------------------------------

describe("scope — this module binds a transaction to a caller-supplied program", () => {
  const FORBIDDEN = /SE54|SE55|VIEW_MAINTENANCE|maintenance/i;

  it("the generated source contains none of SE54 / SE55 / VIEW_MAINTENANCE / maintenance", () => {
    expect(sourceFor()).not.toMatch(FORBIDDEN);
    expect(transactionFragment(PARAMS).join("\n")).not.toMatch(FORBIDDEN);
  });

  it("no exported string of the module carries that vocabulary either", () => {
    expect(TRAN_DATA_LINES.join("\n")).not.toMatch(FORBIDDEN);
    for (const pkg of ["ZTM", "$TMP"]) {
      expect(sourceFor({ ...PARAMS, packageName: pkg })).not.toMatch(FORBIDDEN);
    }
  });

  it("the module's own text — doc comments and error messages included — never mentions it", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const module = readFileSync(join(here, "..", "src", "adt", "tran-create.ts"), "utf8");
    expect(module).not.toMatch(FORBIDDEN);
  });
});
