/**
 * `TRAN/T` create — offline, against the fluid `classic` tool. Nothing here
 * touches SAP; the transport is faked through `ConnectionOptions.httpClient`,
 * using the shared `test/helpers/fluid-classic-fake.ts` fake (which routes
 * the fluid package/RT/body-class cold-deploy plumbing plus one per-call
 * content-hashed invoker class), combined with a small local harness for the
 * session/discovery/system-role plumbing every suite needs — same idiom as
 * `test/fluid-dispatch.test.ts`.
 *
 * What these tests are FOR, beyond coverage: every parameter name and every
 * exception in the generated `RPY_TRANSACTION_INSERT` call is an ASSUMPTION —
 * the source it came from paraphrased that signature in prose instead of
 * pasting it. So these tests cannot prove the call is RIGHT; only a live run
 * can. What they can and do prove is that the call is the one this module
 * intends to make, that no caller string can change its shape, and that a
 * failure is never reported as a success.
 *
 * Since `abap-tran.ts`'s `create_transaction`/`delete_transaction` methods
 * read every value at RUNTIME via `s('path')` off the JSON argument string
 * (rather than having a caller's values baked into a freshly generated,
 * per-call ABAP fragment the way the old per-operation bridge class did), the
 * deployed class body is now a fixed, argument-independent string. Tests that
 * used to inspect a generated fragment for a caller value now either scan
 * `tranPart.source` (the static body, argument-independent) for structure —
 * guard ordering, exception lists, the local/transport branch — or, where a
 * caller value's presence on the wire actually matters, inspect the
 * classicFake invoker's stored JSON-carrying source via `fake.sourceOf`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate, type EvaluateOptions, type Operation, type SafetyTarget } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { DDIC_ERR_PREFIX, assertDdicTranscript, parseDdicTranscript } from "../src/adt/ddic-transcript.js";
import { assertTransactionCreateTarget, createTransaction, type TransactionParams } from "../src/adt/tran-create.js";
import { tranPart } from "../src/adt/fluid/builtin/classic/abap-tran.js";
import { isLocalPackageName } from "../src/adt/transports.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { canonicalArgsJson } from "../src/adt/fluid/invoke.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import { classicFake, useFluidState } from "./helpers/fluid-classic-fake.js";

// ---------------------------------------------------------------------------
// Fake transport — same shape as test/fluid-dispatch.test.ts
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

/** Allows BOTH the fluid classic tool's own deploy package and the transaction's own package (ZTM). */
const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [FLUID_PACKAGE, "ZTM"],
    allowNamePrefixes: ["*"],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

/**
 * Allows the fluid classic tool's own deploy package and NOTHING else. This
 * is the gate that isolates the SECOND gate (`assertBridgeMutation`):
 * `dispatch`'s own checks pass under it — the classic tool's RT/body/invoker
 * classes really do belong in `FLUID_PACKAGE` — so the only thing that can
 * refuse a `TRAN/T` in package `ZTM` is the domain gate `createTransaction`
 * runs itself, before dispatching anything.
 */
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

/** A syntactically valid TRKORR — the shape `isTrkorr` (src/adt/transports.ts) accepts. */
const CORR_NR = "A4HK900121";

const PARAMS: TransactionParams = {
  tcode: "ZTM_CARRIERS",
  program: "ZTM_CARRIER_LIST",
  description: "Carrier list",
  packageName: "ZTM",
  corrNr: CORR_NR,
};

// ---------------------------------------------------------------------------
// 1 — the classic body's own transcript vocabulary
// ---------------------------------------------------------------------------

describe("abap-tran.ts's transcript vocabulary", () => {
  it("every tag create_transaction/delete_transaction emit is one parseDdicTranscript recognises", () => {
    const tags = [...tranPart.source.matchAll(/line\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]!);
    expect(tags).toEqual(["TRAN-CREATED", "TRAN-DELETED", "TRAN-GONE"]);
    const parsed = parseDdicTranscript(tags.join("\n"));
    expect(new Set(parsed.tags)).toEqual(new Set(tags));
    expect(parsed.errorLine).toBeUndefined();
  });

  it("assertDdicTranscript is satisfied by create_transaction's own success output", () => {
    expect(() =>
      assertDdicTranscript(parseDdicTranscript("TRAN-CREATED"), ["TRAN-CREATED"], "Creating transaction"),
    ).not.toThrow();
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
  // and get accepted (round-tripped through JSON, not embedded in an ABAP
  // literal at deploy time) — but a control character is refused outright
  // (assertAbapText), because the value still travels as one JSON string.
  it("refuses a description containing a newline with BAD_INPUT, before any network call", async () => {
    const err = await catchErr(
      createTransaction(offline, allowingGate(), { ...PARAMS, description: "line1\nline2" }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("accepts — does not refuse — a quote or a period in the description", async () => {
    const fake = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
    const { conn } = await connected(fake.route);
    await expect(
      createTransaction(conn, allowingGate(), { ...PARAMS, description: "Fritz's list. v2" }),
    ).resolves.toBeDefined();
  });

  it("refuses a description longer than TSTCT-TTEXT's 37 characters — refused, never truncated", async () => {
    const tooLong = "X".repeat(38);
    const err = await catchErr(createTransaction(offline, allowingGate(), { ...PARAMS, description: tooLong }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("37");
  });

  it("refuses a tcode longer than TSTC-TCODE's 20 characters", async () => {
    const err = await catchErr(
      createTransaction(offline, allowingGate(), { ...PARAMS, tcode: `Z${"A".repeat(20)}` }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("refuses a tcode that would close an ABAP literal and append a statement, with zero network calls", async () => {
    const evil = `ZX'. LEAVE PROGRAM. "`;
    const err = await catchErr(createTransaction(offline, allowingGate(), { ...PARAMS, tcode: evil }));
    expect(err.code).toBe("BAD_INPUT");
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

describe("the second gate — the domain object, before any dispatch", () => {
  it("a gate that refuses TRAN/T in package ZTM makes createTransaction throw with ZERO requests made", async () => {
    const fake = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
    const { conn, adt } = await connected(fake.route);

    const err = await catchErr(createTransaction(conn, bridgeOnlyGate(), PARAMS));
    expect(err).toBeTruthy();
    // Ordering, not just the throw: the classic tool's own deploy would have
    // been ALLOWED under this gate (FLUID_PACKAGE is in its allowlist), so a
    // single request here means the domain gate ran too late — or not at all.
    expect(adt.calls.length).toBe(0);
  });

  it("a readOnly gate refuses too, with zero requests made", async () => {
    const fake = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
    const { conn, adt } = await connected(fake.route);
    const readOnly = new SafetyGate({
      readOnly: true,
      allowPackages: [FLUID_PACKAGE, "ZTM"],
      writesLockedOut: false,
    });
    const err = await catchErr(createTransaction(conn, readOnly, PARAMS));
    expect(err).toBeTruthy();
    expect(adt.calls.length).toBe(0);
  });

  it("does NOT assert `activate` on the transaction — a transaction has no activation step", async () => {
    const seen: string[] = [];
    class RecordingGate extends SafetyGate {
      override assert(
        op: Parameters<SafetyGate["assert"]>[0],
        obj?: Parameters<SafetyGate["assert"]>[1],
        opts?: Parameters<SafetyGate["assert"]>[2],
      ): void {
        if (obj?.type === "TRAN/T") seen.push(op);
        super.assert(op, obj, opts);
      }
    }
    const gate = new RecordingGate({
      readOnly: false,
      allowPackages: [FLUID_PACKAGE, "ZTM"],
      allowNamePrefixes: ["*"],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const fake = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
    const { conn } = await connected(fake.route);
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
   * i.e. `sy-subrc` — which no `CATCH cx_root` will ever see. A body that
   * wrote TRAN-CREATED unconditionally would report success for a call that
   * did nothing. `already_exist` is the single most likely real-world outcome
   * and it is a `sy-subrc`, not a dump.
   */
  it("generates `IF sy-subrc <> 0.` BETWEEN the CALL FUNCTION and the success tag", () => {
    const source = tranPart.source;
    const call = source.indexOf("CALL FUNCTION 'RPY_TRANSACTION_INSERT'");
    const guard = source.indexOf("sy-subrc <> 0", call);
    const tag = source.indexOf("line( 'TRAN-CREATED' )", call);
    expect(call).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(call);
    expect(tag).toBeGreaterThan(guard);
  });

  it("the guard RETURNs before the tag, and reports sy-subrc in the error line", () => {
    const lines = tranPart.source.split("\n");
    const guardIdx = lines.findIndex((l) => l.includes("sy-subrc <> 0") && l.includes("RPY_TRANSACTION_INSERT failed") === false);
    const failIdx = lines.findIndex((l) => l.includes("RPY_TRANSACTION_INSERT failed"));
    const returnIdx = lines.findIndex((l, i) => i > guardIdx && l.trim() === "RETURN.");
    const tagIdx = lines.findIndex((l) => l.includes("line( 'TRAN-CREATED' )"));
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(failIdx).toBeGreaterThan(guardIdx);
    expect(returnIdx).toBeGreaterThan(failIdx);
    expect(tagIdx).toBeGreaterThan(returnIdx);
    expect(lines.some((l) => l.includes("fail(") && l.includes("sy-subrc"))).toBe(true);
  });

  it("declares every EXCEPTION the guard's sy-subrc values come from, including already_exist", () => {
    const source = tranPart.source;
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
    const fake = classicFake({ action: "create_transaction", lines: () => [] });
    const { conn } = await connected(fake.route);
    const err = await catchErr(createTransaction(conn, allowingGate(), PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
  });

  it("a ZMCP-DDIC-ERR> line throws CHECK_FAILED, quoting the server's own text", async () => {
    const fake = classicFake({
      action: "create_transaction",
      lines: () => [`${DDIC_ERR_PREFIX} RPY_TRANSACTION_INSERT failed, sy-subrc=2, `],
    });
    const { conn } = await connected(fake.route);
    const err = await catchErr(createTransaction(conn, allowingGate(), PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("sy-subrc=2");
  });

  it("output carrying some OTHER tag is not success either", async () => {
    const fake = classicFake({ action: "create_transaction", lines: () => ["VIEW-PUT"] });
    const { conn } = await connected(fake.route);
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
   * attach it to a transport — its absence confirms that call is in the FM's
   * own body. Passing it would skip that registration and leave a transaction
   * with no repository entry behind it.
   */
  it("is absent from the generated source", () => {
    const source = tranPart.source;
    expect(source.toLowerCase()).not.toContain("suppress_corr_insert");
    expect(source.toLowerCase()).not.toContain("corr_insert");
  });
});

// ---------------------------------------------------------------------------
// 7 — happy path
// ---------------------------------------------------------------------------

describe("createTransaction happy path", () => {
  it("deploys, activates and runs the classic tool; reports TRAN-CREATED", async () => {
    const fake = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
    const { conn, adt } = await connected(fake.route);

    const { transcript, run } = await createTransaction(conn, allowingGate(), PARAMS);
    expect(transcript.tags).toEqual(["TRAN-CREATED"]);
    expect(transcript.errorLine).toBeUndefined();
    expect(run.output).toContain("TRAN-CREATED");

    const methods = adt.calls.map((c) => (c.method ?? "GET").toUpperCase());
    expect(methods).toContain("PUT");
    expect(adt.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
  });

  it("the invoker class's own JSON payload carries every caller value, unmangled", async () => {
    const fake = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
    const { conn } = await connected(fake.route);
    await createTransaction(conn, allowingGate(), PARAMS);

    const invoker = fake.invoker();
    expect(invoker).toBeTruthy();
    const src = fake.sourceOf(invoker!);
    expect(src).toBeTruthy();
    // The JSON payload is chunked across `lv_json = lv_json && \`...\`.` lines
    // (abapArgumentChunks), so a value can straddle a chunk boundary —
    // reconstruct the whole payload before comparing.
    const chunks = [...src!.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
    const payload = chunks.join("");
    expect(payload).toBe(
      canonicalArgsJson({
        tcode: PARAMS.tcode,
        program: PARAMS.program,
        description: PARAMS.description,
        package_name: PARAMS.packageName,
        corr_nr: CORR_NR,
      }),
    );
    expect(src).toContain("create_transaction");
  });

  it("an identical repeat call issues no second invoker PUT", async () => {
    const fake = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
    const { conn, adt } = await connected(fake.route);

    await createTransaction(conn, allowingGate(), PARAMS);
    const before = adt.calls.length;
    await createTransaction(conn, allowingGate(), PARAMS);
    const putsAfterSecond = adt.calls.slice(before).filter((c) => (c.method ?? "").toUpperCase() === "PUT");
    expect(putsAfterSecond).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8 — no view-maintenance vocabulary anywhere
// ---------------------------------------------------------------------------

describe("scope — this module binds a transaction to a caller-supplied program", () => {
  const FORBIDDEN = /SE54|SE55|VIEW_MAINTENANCE|maintenance/i;

  it("the classic body's create/delete_transaction methods contain none of SE54 / SE55 / VIEW_MAINTENANCE / maintenance", () => {
    expect(tranPart.source).not.toMatch(FORBIDDEN);
  });

  it("the module's own text — doc comments and error messages included — never mentions it", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const module = readFileSync(join(here, "..", "src", "adt", "tran-create.ts"), "utf8");
    expect(module).not.toMatch(FORBIDDEN);
  });
});

// ---------------------------------------------------------------------------
// 9 — transport_number / assertTransactionCreateTarget
// ---------------------------------------------------------------------------
//
// RPY_TRANSACTION_INSERT's own RS_CORR_INSERT call (read verbatim live on
// A4H 2026-09-05) needs a transport request to register a transportable
// package's transaction in CTS. This threads a caller-supplied, already
// gate-judged TRKORR through as `transport_number`, mirroring
// `view-create.ts`'s `corrNr` discipline for `RS_CORR_INSERT`'s `korrnum`.

describe("transport_number threaded into RPY_TRANSACTION_INSERT", () => {
  it("threads transport_number from corr_nr for a non-local package, and space for a local one, at runtime", () => {
    const source = tranPart.source;
    expect(source).toContain("DATA(lv_local) = boolc( to_upper( lv_package ) CP '$*' )");
    expect(source).toContain("lv_transport = space");
    expect(source).toContain("lv_transport = lv_corr_nr");
    expect(source.toLowerCase()).not.toContain("suppress_corr_insert");
  });

  it("assertTransactionCreateTarget: $TMP with no corrNr returns the validated name and throws nothing", () => {
    expect(assertTransactionCreateTarget("$TMP", undefined)).toBe("$TMP");
    expect(isLocalPackageName("$TMP")).toBe(true);
  });

  it("assertTransactionCreateTarget: a transportable package with a valid corrNr likewise returns the validated name", () => {
    expect(assertTransactionCreateTarget("ZTM", CORR_NR)).toBe("ZTM");
  });

  it("a transportable package with no corr_nr is TRANSPORT_ERROR, mentions corr_nr, with ZERO network calls", async () => {
    const fake = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
    const { conn, adt } = await connected(fake.route);
    const { corrNr: _drop, ...withoutCorr } = PARAMS;
    const err = await catchErr(createTransaction(conn, allowingGate(), withoutCorr as TransactionParams));
    expect(err.code).toBe("TRANSPORT_ERROR");
    expect(err.message).toContain("corr_nr");
    expect(adt.calls.length).toBe(0);
  });

  it("a $TMP package given a corr_nr is BAD_INPUT, mentions corr_nr and the package, with ZERO network calls", async () => {
    const fake = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
    const { conn, adt } = await connected(fake.route);
    const err = await catchErr(
      createTransaction(conn, allowingGate(), { ...PARAMS, packageName: "$TMP", corrNr: CORR_NR }),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("corr_nr");
    expect(err.message).toContain("$TMP");
    expect(adt.calls.length).toBe(0);
  });

  it("a malformed corr_nr on a transportable package is BAD_INPUT", async () => {
    const err = await catchErr(
      createTransaction(null as unknown as AbapConnection, allowingGate(), { ...PARAMS, corrNr: "not-a-request" }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("createTransaction passes the corr to the safety gate as { kind: 'transport', corrNr, source: 'named' } for a transportable package", async () => {
    const seen: Array<Parameters<SafetyGate["assert"]>[2]> = [];
    class RecordingGate extends SafetyGate {
      override assert(op: Operation, obj?: SafetyTarget, opts: EvaluateOptions = {}): void {
        if (obj?.type === "TRAN/T") seen.push(opts);
        super.assert(op, obj, opts);
      }
    }
    const gate = new RecordingGate({
      readOnly: false,
      allowPackages: [FLUID_PACKAGE, "ZTM"],
      allowNamePrefixes: ["*"],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const fake = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
    const { conn } = await connected(fake.route);
    await createTransaction(conn, gate, PARAMS);
    expect(seen).toEqual([{ corr: { kind: "transport", corrNr: CORR_NR, source: "named" } }]);
  });

  it("createTransaction passes NO corr to the safety gate for a $TMP package", async () => {
    const seen: Array<Parameters<SafetyGate["assert"]>[2]> = [];
    class RecordingGate extends SafetyGate {
      override assert(op: Operation, obj?: SafetyTarget, opts: EvaluateOptions = {}): void {
        if (obj?.type === "TRAN/T") seen.push(opts);
        super.assert(op, obj, opts);
      }
    }
    const gate = new RecordingGate({
      readOnly: false,
      allowPackages: [FLUID_PACKAGE, "$TMP"],
      allowNamePrefixes: ["*"],
      writesLockedOut: false,
    });
    const fake = classicFake({ action: "create_transaction", lines: () => ["TRAN-CREATED"] });
    const { conn } = await connected(fake.route);
    await createTransaction(conn, gate, { ...PARAMS, packageName: "$TMP", corrNr: undefined });
    expect(seen).toEqual([{}]);
  });
});
