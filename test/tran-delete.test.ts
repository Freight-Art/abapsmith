/**
 * `TRAN/T` delete — offline, against the fluid `classic` tool. Nothing here
 * touches SAP; the transport is faked through `ConnectionOptions.httpClient`,
 * using the shared `test/helpers/fluid-classic-fake.ts` fake (which routes
 * the fluid package/RT/body-class cold-deploy plumbing plus one per-call
 * content-hashed invoker class), combined with a small local harness for the
 * session/discovery/system-role plumbing every suite needs — same idiom as
 * `test/tran-create.test.ts` / `test/fluid-dispatch.test.ts`.
 *
 * `RPY_TRANSACTION_DELETE`'s signature is inferred, not pasted from a
 * capture (see `../src/adt/tran-delete.ts`'s module doc) — these tests
 * cannot prove the call is right, only that it is the one this module
 * intends to make, that no caller string can change its shape, and that a
 * failure is never reported as a success.
 *
 * Since `abap-tran.ts`'s `delete_transaction` method reads every value at
 * RUNTIME via `s('path')` off the JSON argument string (rather than having a
 * caller's values baked into a freshly generated, per-call ABAP fragment the
 * way the old per-operation bridge class did), the deployed class body is a
 * fixed, argument-independent string. Tests that used to inspect a generated
 * fragment for a caller value now either scan `tranPart.source` (the static
 * body) for structure — guard ordering, exception list — or, where a
 * caller value's presence on the wire actually matters, inspect the
 * classicFake invoker's stored JSON-carrying source via `fake.sourceOf`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate, type EvaluateOptions, type Operation, type SafetyTarget } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { DDIC_ERR_PREFIX, assertDdicTranscript, parseDdicTranscript } from "../src/adt/ddic-transcript.js";
import {
  deleteTransactionViaBridge,
  type TransactionDeleteBridgeParams,
} from "../src/adt/tran-delete.js";
import { tranPart } from "../src/adt/fluid/builtin/classic/abap-tran.js";
import { serverPackage, type ServerPackage } from "../src/adt/resolved-package.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { canonicalArgsJson } from "../src/adt/fluid/invoke.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import { classicFake, useFluidState } from "./helpers/fluid-classic-fake.js";

// ---------------------------------------------------------------------------
// Fake transport — same shape as test/tran-create.test.ts
// ---------------------------------------------------------------------------

const fluidState = useFluidState();

type Route = (o: HttpClientOptions) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
  readonly calls: HttpClientOptions[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    const res = this.route(o);
    if (!res) throw new Error(`FakeAdt: unrouted request ${(o.method ?? "GET").toUpperCase()} ${o.url}`);
    return res;
  }
}

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

function baseRoute(o: HttpClientOptions): HttpClientResponse | undefined {
  if (o.url.includes("/compatibility/graph")) {
    return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
  }
  if (o.url.endsWith("/discovery")) return resp(200, "<service/>", { "content-type": "application/xml" });
  if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
  return undefined;
}

function cfg(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    readOnly: false,
    fluidApi: true,
    stateDir: fluidState.dir(),
    ...overrides,
  });
}

async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(cfg(), {
    httpClient: routeSystemRoleProbe(adt, { answer: "nonproductive" }),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!e || !isAbapError(e)) throw new Error(`expected an AbapError, got ${String(e)}`);
  return e;
};

beforeEach(() => {
  resetFluidEnsureState();
  resetFluidPackageMemo();
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/** Allows BOTH the fluid classic tool's own deploy package and the transaction's own package ($TMP). */
const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [FLUID_PACKAGE, "$TMP", "ZTM"],
    allowNamePrefixes: ["*"],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

/** Allows the fluid classic tool's own deploy package only — the domain gate must refuse the delete first. */
const bridgeOnlyGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [FLUID_PACKAGE],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TCODE = "ZTM_CARRIERS";
// Local ($-prefixed) by default: most of this file exercises behavior that is orthogonal
// to transport-awareness (guard ordering, transcript vocabulary, exceptions, gate wiring),
// and a local package needs no corr_nr — see issue #202's own describe block below for the
// transportable-package (ZTM) coverage.
const PKG = "$TMP";
const TRANSPORTABLE_PKG = "ZTM";

/** Mints a genuine `ServerPackage`, mirroring test/resolved-package.test.ts's `confirmed` fixture. */
const confirmed = (packageName: string) => ({
  status: "confirmed" as const,
  uri: `/sap/bc/adt/vit/wb/object_type/tran/object_name/${TCODE}`,
  via: "vit-bridge" as const,
  packageName,
});

const SERVER_PKG: ServerPackage = (() => {
  const p = serverPackage(confirmed(PKG));
  if (!p) throw new Error("test fixture: serverPackage(confirmed(PKG)) unexpectedly undefined");
  return p;
})();

const TRANSPORTABLE_SERVER_PKG: ServerPackage = (() => {
  const p = serverPackage(confirmed(TRANSPORTABLE_PKG));
  if (!p) throw new Error("test fixture: serverPackage(confirmed(TRANSPORTABLE_PKG)) unexpectedly undefined");
  return p;
})();

const BRIDGE_PARAMS: TransactionDeleteBridgeParams = { tcode: TCODE, packageName: SERVER_PKG };

// ---------------------------------------------------------------------------
// 1 — the classic body's own transcript vocabulary (delete_transaction only)
// ---------------------------------------------------------------------------

describe("abap-tran.ts's delete_transaction transcript vocabulary", () => {
  it("every tag delete_transaction emits is one parseDdicTranscript recognises — asserted as a SET", () => {
    const method = tranPart.source.slice(tranPart.source.indexOf("METHOD delete_transaction."));
    const tags = [...method.matchAll(/line\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]!);
    // TRAN-REGISTERED (issue #202) is emitted only on the transportable branch, before the delete
    // FM runs — a valid intermediate tag, not part of the success set deleteTransactionViaBridge
    // asserts on (that stays TRAN-DELETED + TRAN-GONE, see the happy-path describe block below).
    expect(new Set(tags)).toEqual(new Set(["TRAN-REGISTERED", "TRAN-DELETED", "TRAN-GONE"]));
    const parsed = parseDdicTranscript(tags.join("\n"));
    expect(new Set(parsed.tags)).toEqual(new Set(tags));
    expect(parsed.errorLine).toBeUndefined();
  });

  it("assertDdicTranscript is satisfied by the method's own success output", () => {
    expect(() =>
      assertDdicTranscript(
        parseDdicTranscript("TRAN-DELETED\nTRAN-GONE"),
        ["TRAN-DELETED", "TRAN-GONE"],
        "Deleting transaction",
      ),
    ).not.toThrow();
  });

  it("the failure branches write lines parseDdicTranscript reads as errors, not tags", () => {
    const parsed = parseDdicTranscript(`${DDIC_ERR_PREFIX} RPY_TRANSACTION_DELETE failed, sy-subrc=1`);
    expect(parsed.tags).toEqual([]);
    expect(parsed.errorLine).toContain("sy-subrc=1");
  });
});

// ---------------------------------------------------------------------------
// 2 — closed template / injection: refused, never escaped, before any I/O
// ---------------------------------------------------------------------------

describe("closed template — caller strings are refused, not escaped, before any network call", () => {
  const offline = null as unknown as AbapConnection;

  const bad = ["ZX'INJECT", "ZX.INJECT", "ZX\nINJECT", "ZX INJECT", `Z${"A".repeat(20)}`];

  for (const value of bad) {
    it(`refuses tcode ${JSON.stringify(value)} with BAD_INPUT, before any network call`, async () => {
      const err = await catchErr(deleteTransactionViaBridge(offline, allowingGate(), { ...BRIDGE_PARAMS, tcode: value }));
      expect(err.code).toBe("BAD_INPUT");
    });
  }

  it("refuses a tcode that would close a literal and append a statement", async () => {
    const evil = `ZX'. LEAVE PROGRAM. "`;
    const err = await catchErr(deleteTransactionViaBridge(offline, allowingGate(), { ...BRIDGE_PARAMS, tcode: evil }));
    expect(err.code).toBe("BAD_INPUT");
  });

  it("refuses a non-string tcode rather than stringifying it", async () => {
    const err = await catchErr(
      deleteTransactionViaBridge(offline, allowingGate(), { ...BRIDGE_PARAMS, tcode: 42 as unknown as string }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("refuses a badly-formatted packageName before any network call — a genuine ServerPackage can still fail the identifier grammar", async () => {
    const badPkg = serverPackage(confirmed("1BAD"));
    if (!badPkg) throw new Error("test fixture: expected a ServerPackage");
    const err = await catchErr(
      deleteTransactionViaBridge(offline, allowingGate(), { ...BRIDGE_PARAMS, packageName: badPkg }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });
});

// ---------------------------------------------------------------------------
// 2b — the ServerPackage brand: a caller-claimed package never reaches the gate
// ---------------------------------------------------------------------------

describe("the ServerPackage brand — a forged packageName is refused before the gate or any dispatch", () => {
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
      allowPackages: [FLUID_PACKAGE, PKG],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const fake = classicFake({ action: "delete_transaction", lines: () => ["TRAN-DELETED", "TRAN-GONE"] });
    const { conn, adt } = await connected(fake.route);

    // The bypass this test exists to catch: a caller (plain JS, or an `as
    // unknown as ServerPackage` cast around TypeScript) handing in a package
    // name it invented or was told, never one this module or the gate
    // verified against the server.
    const forged = PKG as unknown as ServerPackage;
    const err = await catchErr(deleteTransactionViaBridge(conn, gate, { tcode: TCODE, packageName: forged }));

    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details.reason).toBe("PACKAGE_UNKNOWN");
    expect(gateCalls.length).toBe(0);
    expect(adt.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3 — the domain gate runs FIRST, zero-network, and as a "delete"
// ---------------------------------------------------------------------------

describe("the domain gate — asserted as a delete, before any dispatch, zero-network", () => {
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
      allowPackages: [FLUID_PACKAGE, PKG],
      allowNamePrefixes: ["*"],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const fake = classicFake({ action: "delete_transaction", lines: () => ["TRAN-DELETED", "TRAN-GONE"] });
    const { conn } = await connected(fake.route);
    await deleteTransactionViaBridge(conn, gate, BRIDGE_PARAMS);
    expect(seen).toEqual([{ op: "delete", type: "TRAN/T", name: TCODE }]);
  });

  it("a gate that refuses the transaction's package refuses the whole call with ZERO requests", async () => {
    const fake = classicFake({ action: "delete_transaction", lines: () => ["TRAN-DELETED", "TRAN-GONE"] });
    const { conn, adt } = await connected(fake.route);
    const err = await catchErr(deleteTransactionViaBridge(conn, bridgeOnlyGate(), BRIDGE_PARAMS));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(adt.calls.length).toBe(0);
  });

  it("a readOnly gate refuses too, zero requests made", async () => {
    const fake = classicFake({ action: "delete_transaction", lines: () => ["TRAN-DELETED", "TRAN-GONE"] });
    const { conn, adt } = await connected(fake.route);
    const readOnly = new SafetyGate({
      readOnly: true,
      allowPackages: [FLUID_PACKAGE, PKG],
      writesLockedOut: false,
    });
    const err = await catchErr(deleteTransactionViaBridge(conn, readOnly, BRIDGE_PARAMS));
    expect(err).toBeTruthy();
    expect(adt.calls.length).toBe(0);
  });

  it("passes { corr: { kind: 'local' } } to the safety gate — no transport handling for this delete", async () => {
    const seen: Array<Parameters<SafetyGate["assert"]>[2]> = [];
    class RecordingGate extends SafetyGate {
      override assert(op: Operation, obj?: SafetyTarget, opts: EvaluateOptions = {}): void {
        if (obj?.type === "TRAN/T") seen.push(opts);
        super.assert(op, obj, opts);
      }
    }
    const gate = new RecordingGate({
      readOnly: false,
      allowPackages: [FLUID_PACKAGE, PKG],
      allowNamePrefixes: ["*"],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const fake = classicFake({ action: "delete_transaction", lines: () => ["TRAN-DELETED", "TRAN-GONE"] });
    const { conn } = await connected(fake.route);
    await deleteTransactionViaBridge(conn, gate, BRIDGE_PARAMS);
    expect(seen).toEqual([{ corr: { kind: "local" } }]);
  });
});

// ---------------------------------------------------------------------------
// 4 — the sy-subrc guard sits BETWEEN the CALL FUNCTION and TRAN-DELETED
// ---------------------------------------------------------------------------

describe("the sy-subrc guard", () => {
  it("generates `IF sy-subrc <> 0.` BETWEEN the CALL FUNCTION and the TRAN-DELETED tag", () => {
    const source = tranPart.source;
    const call = source.indexOf("CALL FUNCTION 'RPY_TRANSACTION_DELETE'");
    const guardIdxs = [...source.matchAll(/sy-subrc <> 0/g)].map((m) => m.index ?? -1);
    const guard = guardIdxs.find((i) => i > call);
    const tag = source.indexOf("line( 'TRAN-DELETED' )");
    expect(call).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(call);
    expect(tag).toBeGreaterThan(guard as number);
  });

  it("the guard RETURNs before the tag, and reports sy-subrc in the error line", () => {
    const lines = tranPart.source.split("\n");
    const callIdx = lines.findIndex((l) => l.includes("CALL FUNCTION 'RPY_TRANSACTION_DELETE'"));
    const guardIdx = lines.findIndex((l, i) => i > callIdx && l.includes("sy-subrc <> 0"));
    const returnIdx = lines.findIndex((l, i) => i > guardIdx && l.trim() === "RETURN.");
    const tagIdx = lines.findIndex((l) => l.includes("line( 'TRAN-DELETED' )"));
    expect(guardIdx).toBeGreaterThan(callIdx);
    expect(returnIdx).toBeGreaterThan(guardIdx);
    expect(tagIdx).toBeGreaterThan(returnIdx);
    expect(lines.some((l) => l.includes("fail(") && l.includes("sy-subrc"))).toBe(true);
  });

  it("both of delete_transaction's own RPY_TRANSACTION_DELETE calls (local and transportable branches) declare the same named exceptions", () => {
    const method = tranPart.source.slice(tranPart.source.indexOf("METHOD delete_transaction."));
    const calls = [...method.matchAll(/CALL FUNCTION 'RPY_TRANSACTION_DELETE'/g)].map((m) => m.index ?? -1);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const excIdx = method.indexOf("EXCEPTIONS not_excecuted = 1", call);
      expect(excIdx).toBeGreaterThan(call);
      const window = method.slice(excIdx, excIdx + 120);
      expect(window).toContain("object_not_found = 2");
      expect(window).toContain("OTHERS = 3");
    }
  });
});

// ---------------------------------------------------------------------------
// 5 — TRAN-DELETED without TRAN-GONE is a failure (the most important test)
// ---------------------------------------------------------------------------

describe("TRAN-DELETED without TRAN-GONE is a failure, not a success", () => {
  it("a transcript carrying TRAN-DELETED but missing TRAN-GONE throws CHECK_FAILED naming the missing tag", async () => {
    const fake = classicFake({ action: "delete_transaction", lines: () => ["TRAN-DELETED"] });
    const { conn } = await connected(fake.route);
    const err = await catchErr(deleteTransactionViaBridge(conn, allowingGate(), BRIDGE_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("TRAN-GONE");
  });

  it("the reverse (TRAN-GONE without TRAN-DELETED, a shape the method itself never emits) is ALSO a failure — the assertion checks both tags independently", async () => {
    const fake = classicFake({ action: "delete_transaction", lines: () => ["TRAN-GONE"] });
    const { conn } = await connected(fake.route);
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
    const fake = classicFake({
      action: "delete_transaction",
      lines: () => [`${DDIC_ERR_PREFIX} transaction ${TCODE} does not exist`],
    });
    const { conn } = await connected(fake.route);
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
    const fake = classicFake({ action: "delete_transaction", lines: () => [] });
    const { conn } = await connected(fake.route);
    const err = await catchErr(deleteTransactionViaBridge(conn, allowingGate(), BRIDGE_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
  });

  it("a ZMCP-DDIC-ERR> line (post-COMMIT TSTC row survives) throws CHECK_FAILED, quoting the server's own text", async () => {
    const fake = classicFake({
      action: "delete_transaction",
      lines: () => [
        "TRAN-DELETED",
        `${DDIC_ERR_PREFIX} delete of ${TCODE} reported no error but the TSTC row still exists`,
      ],
    });
    const { conn } = await connected(fake.route);
    const err = await catchErr(deleteTransactionViaBridge(conn, allowingGate(), BRIDGE_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("TSTC row still exists");
  });

  it("output carrying some OTHER, unrelated tag is not success either", async () => {
    const fake = classicFake({ action: "delete_transaction", lines: () => ["PKG-EMPTY"] });
    const { conn } = await connected(fake.route);
    const err = await catchErr(deleteTransactionViaBridge(conn, allowingGate(), BRIDGE_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
  });
});

// ---------------------------------------------------------------------------
// 8 — happy path
// ---------------------------------------------------------------------------

describe("deleteTransactionViaBridge happy path", () => {
  it("deploys, activates and runs the classic tool; reports both TRAN-DELETED and TRAN-GONE", async () => {
    const fake = classicFake({ action: "delete_transaction", lines: () => ["TRAN-DELETED", "TRAN-GONE"] });
    const { conn, adt } = await connected(fake.route);

    const { transcript, run } = await deleteTransactionViaBridge(conn, allowingGate(), BRIDGE_PARAMS);
    expect(transcript.tags).toEqual(["TRAN-DELETED", "TRAN-GONE"]);
    expect(transcript.errorLine).toBeUndefined();
    expect(run.output).toContain("TRAN-DELETED");
    expect(run.output).toContain("TRAN-GONE");

    const methods = adt.calls.map((c) => (c.method ?? "GET").toUpperCase());
    expect(methods).toContain("PUT");
    expect(adt.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
  });

  it("the invoker class's own JSON payload carries the caller's tcode and package_name, unmangled", async () => {
    const fake = classicFake({ action: "delete_transaction", lines: () => ["TRAN-DELETED", "TRAN-GONE"] });
    const { conn } = await connected(fake.route);
    await deleteTransactionViaBridge(conn, allowingGate(), BRIDGE_PARAMS);

    const invoker = fake.invoker();
    expect(invoker).toBeTruthy();
    const src = fake.sourceOf(invoker!);
    expect(src).toBeTruthy();
    const chunks = [...src!.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
    const payload = chunks.join("");
    expect(payload).toBe(canonicalArgsJson({ tcode: TCODE, package_name: PKG, corr_nr: "" }));
    expect(src).toContain("delete_transaction");
  });

  it("an identical repeat call issues no second invoker PUT", async () => {
    const fake = classicFake({ action: "delete_transaction", lines: () => ["TRAN-DELETED", "TRAN-GONE"] });
    const { conn, adt } = await connected(fake.route);

    await deleteTransactionViaBridge(conn, allowingGate(), BRIDGE_PARAMS);
    const before = adt.calls.length;
    await deleteTransactionViaBridge(conn, allowingGate(), BRIDGE_PARAMS);
    const putsAfterSecond = adt.calls.slice(before).filter((c) => (c.method ?? "").toUpperCase() === "PUT");
    expect(putsAfterSecond).toEqual([]);
  });

  it("emits RS_CORR_INSERT only on the transportable (lv_local = abap_false) branch, gated behind lv_local (issue #202)", () => {
    const method = tranPart.source.slice(tranPart.source.indexOf("METHOD delete_transaction."));
    expect(method).toContain("RS_CORR_INSERT");
    expect(method).toContain("lv_corr_nr) = s( 'corr_nr' )");
    const localBranch = method.indexOf("IF lv_local = abap_false.");
    const corrInsertIdx = method.indexOf("RS_CORR_INSERT");
    expect(localBranch).toBeGreaterThanOrEqual(0);
    expect(corrInsertIdx).toBeGreaterThan(localBranch);
  });
});
