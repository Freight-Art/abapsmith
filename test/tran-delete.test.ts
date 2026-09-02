/**
 * `TRAN/T` delete bridge — offline; mirrors `test/package-delete.test.ts` and
 * `test/tran-create.test.ts`'s fixture/gate/route style.
 *
 * `RPY_TRANSACTION_DELETE`'s signature is inferred, not pasted from a
 * capture (see `../src/adt/tran-delete.ts`'s module doc) — these tests
 * cannot prove the call is right, only that it is the one this module
 * intends to make, that no caller string can change its shape, and that a
 * failure is never reported as a success.
 */
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
  TRAN_DELETE_DATA_LINES,
  deleteTransactionViaBridge,
  transactionDeleteFragment,
  type TransactionDeleteBridgeParams,
  type TransactionDeleteParams,
} from "../src/adt/tran-delete.js";
import { serverPackage, type ServerPackage } from "../src/adt/resolved-package.js";
import type { VerifyOutcome } from "../src/adt/write-verify.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Fake transport — same shape as test/package-delete.test.ts / test/tran-create.test.ts
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
const BRIDGE = DDIC_BRIDGE_CLASS.deleteTransaction;
const BRIDGE_SOURCE_URI = `${CLASS_COLLECTION}/${BRIDGE.toLowerCase()}/source/main`;

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

/** GET-404 -> POST-create -> LOCK -> PUT -> UNLOCK for the bridge class itself. */
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

/** A bare classrun body — see test/package-create.test.ts's identical helper. */
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
// Gates
// ---------------------------------------------------------------------------

const TCODE = "ZTM_CARRIERS";
const PKG = "ZTM";

/** Allows both the bridge class ($TMP) and the transaction's own package. */
const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [DDIC_BRIDGE_PACKAGE, PKG],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

/** Allows the bridge class only — the domain gate must refuse the delete before anything reaches the wire. */
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

/** Mints a genuine `ServerPackage`, mirroring test/resolved-package.test.ts's `confirmed` fixture. */
const confirmed = (packageName: string): VerifyOutcome => ({
  status: "confirmed",
  uri: `/sap/bc/adt/vit/wb/object_type/tran/object_name/${TCODE}`,
  via: "vit-bridge",
  packageName,
});

const SERVER_PKG: ServerPackage = (() => {
  const p = serverPackage(confirmed(PKG));
  if (!p) throw new Error("test fixture: serverPackage(confirmed(PKG)) unexpectedly undefined");
  return p;
})();

const FRAGMENT_PARAMS: TransactionDeleteParams = { tcode: TCODE };
const BRIDGE_PARAMS: TransactionDeleteBridgeParams = { tcode: TCODE, packageName: SERVER_PKG };

const sourceFor = (p: TransactionDeleteParams = FRAGMENT_PARAMS): string =>
  ddicBridgeSource(BRIDGE, TRAN_DELETE_DATA_LINES, transactionDeleteFragment(p));

// ---------------------------------------------------------------------------
// 1 — generator/parser drift: every tag is one parseDdicTranscript knows
// ---------------------------------------------------------------------------

describe("generator/parser drift", () => {
  it("every tag transactionDeleteFragment emits is one parseDdicTranscript recognises — asserted as a SET", () => {
    const tags = emittedTags(transactionDeleteFragment(FRAGMENT_PARAMS));
    expect(new Set(tags)).toEqual(new Set(["TRAN-DELETED", "TRAN-GONE"]));
    const parsed = parseDdicTranscript(tags.join("\n"));
    expect(new Set(parsed.tags)).toEqual(new Set(tags));
    expect(parsed.errorLine).toBeUndefined();
  });

  it("assertDdicTranscript is satisfied by the fragment's own success output", () => {
    const tags = emittedTags(transactionDeleteFragment(FRAGMENT_PARAMS));
    expect(() =>
      assertDdicTranscript(parseDdicTranscript(tags.join("\n")), ["TRAN-DELETED", "TRAN-GONE"], "Deleting transaction"),
    ).not.toThrow();
  });

  it("the fragment's failure branches write lines parseDdicTranscript reads as errors, not tags", () => {
    const errLines = transactionDeleteFragment(FRAGMENT_PARAMS).filter((l) => l.includes(DDIC_ERR_PREFIX));
    expect(errLines.length).toBeGreaterThan(0);
    const parsed = parseDdicTranscript(`${DDIC_ERR_PREFIX} RPY_TRANSACTION_DELETE failed, sy-subrc=1`);
    expect(parsed.tags).toEqual([]);
    expect(parsed.errorLine).toContain("sy-subrc=1");
  });
});

// ---------------------------------------------------------------------------
// 2 — closed template / injection: refused before any network call, zero source
// ---------------------------------------------------------------------------

describe("closed template — caller strings are refused, not escaped, before any network call", () => {
  const offline = null as unknown as AbapConnection;

  const bad = ["ZX'INJECT", "ZX.INJECT", "ZX\nINJECT", "ZX INJECT", `Z${"A".repeat(20)}`];

  for (const value of bad) {
    it(`refuses tcode ${JSON.stringify(value)} with BAD_INPUT, before any network call, no source produced`, async () => {
      const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["TRAN-DELETED", "TRAN-GONE"])));
      const { conn, inner } = await connected(route);
      const err = await catchErr(deleteTransactionViaBridge(conn, allowingGate(), { ...BRIDGE_PARAMS, tcode: value }));
      expect(err.code).toBe("BAD_INPUT");
      expect(inner.calls.length).toBe(0);

      let generated: string | undefined;
      try {
        generated = sourceFor({ tcode: value });
      } catch {
        generated = undefined;
      }
      expect(generated).toBeUndefined();
    });
  }

  it("refuses a tcode that would close the literal and append a statement — and produces no source at all", async () => {
    const evil = `ZX'. LEAVE PROGRAM. "`;
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["TRAN-DELETED", "TRAN-GONE"])));
    const { conn, inner } = await connected(route);
    const err = await catchErr(deleteTransactionViaBridge(conn, allowingGate(), { ...BRIDGE_PARAMS, tcode: evil }));
    expect(err.code).toBe("BAD_INPUT");
    expect(inner.calls.length).toBe(0);
    expect(sourceFor()).not.toContain("LEAVE PROGRAM");
  });

  it("refuses a non-string tcode rather than stringifying it, zero requests", async () => {
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["TRAN-DELETED", "TRAN-GONE"])));
    const { conn, inner } = await connected(route);
    const err = await catchErr(
      deleteTransactionViaBridge(conn, allowingGate(), { ...BRIDGE_PARAMS, tcode: 42 as unknown as string }),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(inner.calls.length).toBe(0);
  });

  it("refuses a badly-formatted packageName before any network call — a genuine ServerPackage can still fail the identifier grammar", async () => {
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["TRAN-DELETED", "TRAN-GONE"])));
    const { conn, inner } = await connected(route);
    const badPkg = serverPackage(confirmed("1BAD"));
    if (!badPkg) throw new Error("test fixture: expected a ServerPackage");
    const err = await catchErr(
      deleteTransactionViaBridge(conn, allowingGate(), { ...BRIDGE_PARAMS, packageName: badPkg }),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(inner.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2b — the ServerPackage brand: a caller-claimed package never reaches the gate
// ---------------------------------------------------------------------------

describe("the ServerPackage brand — a forged packageName is refused before the gate or any ABAP", () => {
  it("a packageName forced in via `as unknown as ServerPackage` throws SAFETY_DENIED/PACKAGE_UNKNOWN, the gate is never consulted, and zero requests are made", async () => {
    const gateCalls: unknown[] = [];
    class RecordingGate extends SafetyGate {
      override assert(...args: Parameters<SafetyGate["assert"]>): void {
        gateCalls.push(args);
        super.assert(...args);
      }
    }
    const gate = new RecordingGate({
      readOnly: false,
      allowPackages: [DDIC_BRIDGE_PACKAGE, PKG],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["TRAN-DELETED", "TRAN-GONE"])));
    const { conn, inner } = await connected(route);

    // The bypass this test exists to catch: a caller (plain JS, or an `as
    // unknown as ServerPackage` cast around TypeScript) handing in a package
    // name it invented or was told, never one this module or the gate
    // verified against the server.
    const forged = PKG as unknown as ServerPackage;
    const err = await catchErr(deleteTransactionViaBridge(conn, gate, { tcode: TCODE, packageName: forged }));

    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details.reason).toBe("PACKAGE_UNKNOWN");
    expect(gateCalls.length).toBe(0);
    expect(inner.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3 — the domain gate runs FIRST, zero-network, and as a "delete"
// ---------------------------------------------------------------------------

describe("the domain gate — asserted as a delete, before any ABAP is generated, zero-network", () => {
  it("gate.assert sees op 'delete' (never 'write') with type TRAN/T and the tcode", async () => {
    const seen: Array<{ op: string; type?: string; name?: string }> = [];
    class RecordingGate extends SafetyGate {
      override assert(
        op: Parameters<SafetyGate["assert"]>[0],
        obj?: Parameters<SafetyGate["assert"]>[1],
        opts?: Parameters<SafetyGate["assert"]>[2],
      ): void {
        if (obj?.type === "TRAN/T") seen.push({ op, type: obj.type, name: obj.name });
        super.assert(op, obj, opts);
      }
    }
    const gate = new RecordingGate({
      readOnly: false,
      allowPackages: [DDIC_BRIDGE_PACKAGE, PKG],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["TRAN-DELETED", "TRAN-GONE"])));
    const { conn } = await connected(route);
    await deleteTransactionViaBridge(conn, gate, BRIDGE_PARAMS);
    expect(seen).toEqual([{ op: "delete", type: "TRAN/T", name: TCODE }]);
  });

  it("a gate that refuses the transaction's package refuses the whole call with ZERO HTTP requests", async () => {
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["TRAN-DELETED", "TRAN-GONE"])));
    const { conn, inner } = await connected(route);
    const err = await catchErr(deleteTransactionViaBridge(conn, bridgeOnlyGate(), BRIDGE_PARAMS));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(inner.calls.length).toBe(0);
  });

  it("a readOnly gate refuses too, zero requests made", async () => {
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["TRAN-DELETED", "TRAN-GONE"])));
    const { conn, inner } = await connected(route);
    const readOnly = new SafetyGate({
      readOnly: true,
      allowPackages: [DDIC_BRIDGE_PACKAGE, PKG],
      writesLockedOut: false,
    });
    const err = await catchErr(deleteTransactionViaBridge(conn, readOnly, BRIDGE_PARAMS));
    expect(err).toBeTruthy();
    expect(inner.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4 — the sy-subrc guard sits BETWEEN the CALL FUNCTION and TRAN-DELETED
// ---------------------------------------------------------------------------

describe("the sy-subrc guard", () => {
  it("generates `IF sy-subrc <> 0.` BETWEEN the CALL FUNCTION and the TRAN-DELETED tag", () => {
    const source = sourceFor();
    const call = source.indexOf("CALL FUNCTION 'RPY_TRANSACTION_DELETE'");
    const guardIdxs = [...source.matchAll(/sy-subrc <> 0/g)].map((m) => m.index ?? -1);
    const guard = guardIdxs.find((i) => i > call);
    const tag = source.indexOf("out->write( 'TRAN-DELETED' )");
    expect(call).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(call);
    expect(tag).toBeGreaterThan(guard as number);
  });

  it("the guard RETURNs before the tag, and reports sy-subrc in the error line", () => {
    const lines = transactionDeleteFragment(FRAGMENT_PARAMS);
    const callIdx = lines.findIndex((l) => l.includes("CALL FUNCTION 'RPY_TRANSACTION_DELETE'"));
    const guardIdx = lines.findIndex((l, i) => i > callIdx && l.includes("sy-subrc <> 0"));
    const returnIdx = lines.findIndex((l, i) => i > guardIdx && l.trim() === "RETURN.");
    const tagIdx = lines.findIndex((l) => l.includes("out->write( 'TRAN-DELETED' )"));
    expect(guardIdx).toBeGreaterThan(callIdx);
    expect(returnIdx).toBeGreaterThan(guardIdx);
    expect(tagIdx).toBeGreaterThan(returnIdx);
    expect(lines.some((l) => l.includes(DDIC_ERR_PREFIX) && l.includes("sy-subrc"))).toBe(true);
  });

  it("only EXCEPTIONS OTHERS = 1 is declared — no named exception risking a syntax error on an unverified signature", () => {
    const source = sourceFor();
    expect(source).toContain("EXCEPTIONS OTHERS = 1.");
  });
});

// ---------------------------------------------------------------------------
// 5 — TRAN-DELETED without TRAN-GONE is a failure (the most important test)
// ---------------------------------------------------------------------------

describe("TRAN-DELETED without TRAN-GONE is a failure, not a success", () => {
  it("a transcript carrying TRAN-DELETED but missing TRAN-GONE throws CHECK_FAILED naming the missing tag", async () => {
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["TRAN-DELETED"])));
    const { conn } = await connected(route);
    const err = await catchErr(deleteTransactionViaBridge(conn, allowingGate(), BRIDGE_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("TRAN-GONE");
  });

  it("the reverse (TRAN-GONE without TRAN-DELETED, a shape the fragment itself never emits) is ALSO a failure — the assertion checks both tags independently", async () => {
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["TRAN-GONE"])));
    const { conn } = await connected(route);
    const err = await catchErr(deleteTransactionViaBridge(conn, allowingGate(), BRIDGE_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("TRAN-DELETED");
  });
});

// ---------------------------------------------------------------------------
// 6 — non-existent transaction produces the named beforeAssert refusal
// ---------------------------------------------------------------------------

describe("a non-existent transaction is refused by name, not by generic missing-tag error", () => {
  it("the beforeAssert hook turns the does-not-exist transcript into a named CHECK_FAILED", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput([`${DDIC_ERR_PREFIX} transaction ${TCODE} does not exist`])),
    );
    const { conn } = await connected(route);
    const err = await catchErr(deleteTransactionViaBridge(conn, allowingGate(), BRIDGE_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain(`${TCODE} does not exist`);
    expect(err.message).toContain("NOT deleted");
  });
});

// ---------------------------------------------------------------------------
// 7 — empty transcript and ZMCP-DDIC-ERR> transcripts are both failures
// ---------------------------------------------------------------------------

describe("a failing transcript is a failure", () => {
  it("HTTP 200 with EMPTY classrun output throws CHECK_FAILED", async () => {
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput([])));
    const { conn } = await connected(route);
    const err = await catchErr(deleteTransactionViaBridge(conn, allowingGate(), BRIDGE_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
  });

  it("a ZMCP-DDIC-ERR> line (post-COMMIT TSTC row survives) throws CHECK_FAILED, quoting the server's own text", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(
        classrunOutput([
          "TRAN-DELETED",
          `${DDIC_ERR_PREFIX} delete of ${TCODE} reported no error but the TSTC row still exists`,
        ]),
      ),
    );
    const { conn } = await connected(route);
    const err = await catchErr(deleteTransactionViaBridge(conn, allowingGate(), BRIDGE_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("TSTC row still exists");
  });

  it("output carrying some OTHER, unrelated tag is not success either", async () => {
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["PKG-EMPTY"])));
    const { conn } = await connected(route);
    const err = await catchErr(deleteTransactionViaBridge(conn, allowingGate(), BRIDGE_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
  });
});

// ---------------------------------------------------------------------------
// 8 — happy path
// ---------------------------------------------------------------------------

describe("deleteTransactionViaBridge happy path", () => {
  it("writes, activates and runs the bridge; reports both TRAN-DELETED and TRAN-GONE", async () => {
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["TRAN-DELETED", "TRAN-GONE"])));
    const { conn, inner } = await connected(route);

    const { transcript, run } = await deleteTransactionViaBridge(conn, allowingGate(), BRIDGE_PARAMS);
    expect(transcript.tags).toEqual(["TRAN-DELETED", "TRAN-GONE"]);
    expect(transcript.errorLine).toBeUndefined();
    expect(run.output).toContain("TRAN-DELETED");
    expect(run.output).toContain("TRAN-GONE");

    const methods = inner.calls.map((c) => (c.method ?? "GET").toUpperCase());
    expect(methods).toContain("PUT");
    expect(inner.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
  });

  it("the source actually PUT over the wire contains RPY_TRANSACTION_DELETE, COMMIT WORK and the TSTC re-read, in that order", async () => {
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["TRAN-DELETED", "TRAN-GONE"])));
    const { conn, inner } = await connected(route);
    await deleteTransactionViaBridge(conn, allowingGate(), BRIDGE_PARAMS);

    const put = inner.calls.find((c) => (c.method ?? "").toUpperCase() === "PUT" && c.url === BRIDGE_SOURCE_URI);
    const body = String(put?.body);
    const deleteIdx = body.indexOf("CALL FUNCTION 'RPY_TRANSACTION_DELETE'");
    const commitIdx = body.indexOf("COMMIT WORK.");
    const reselectIdx = body.indexOf("SELECT SINGLE * FROM tstc", commitIdx);
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(deleteIdx);
    expect(reselectIdx).toBeGreaterThan(commitIdx);
    expect(body).toContain(`EXPORTING transaction = '${TCODE}'`);
  });

  it("TRAN_DELETE_DATA_LINES declares the local the fragment relies on", () => {
    expect(TRAN_DELETE_DATA_LINES).toContain("ls_tstc TYPE tstc.");
  });

  it("does not emit any transport/RS_CORR_INSERT handling — this bridge takes no corr_nr", () => {
    const source = sourceFor();
    expect(source.toUpperCase()).not.toContain("RS_CORR_INSERT");
    expect(source.toLowerCase()).not.toContain("corr_nr");
  });
});
