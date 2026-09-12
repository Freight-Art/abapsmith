/**
 * `TABL/DI` (secondary DDIC index) create/delete — offline, against the
 * fluid `classic` tool. Nothing here touches SAP; the transport is faked
 * through `ConnectionOptions.httpClient`, using the shared
 * `test/helpers/fluid-classic-fake.ts` fake (which routes the fluid
 * package/RT/body-class cold-deploy plumbing plus one per-call
 * content-hashed invoker class), combined with a small local harness for the
 * session/discovery/system-role plumbing every suite needs — same idiom as
 * `test/tran-create.test.ts` / `test/tran-delete.test.ts`.
 *
 * Since `abap-index.ts`'s `create_index`/`delete_index` methods read every
 * value at RUNTIME via `s('path')`/`b('path')`/`n('path')` off the JSON
 * argument string (rather than having a caller's values baked into a
 * freshly generated, per-call ABAP fragment the way the old per-operation
 * bridge class did), the deployed class body is a fixed, argument-independent
 * string. Tests that used to inspect a generated fragment for a caller value
 * now either scan `indexPart.source` (the static body) for structure — guard
 * ordering, exception list, the `fields` array decode loop — or, where a
 * caller value's presence on the wire actually matters, inspect the
 * classicFake invoker's stored JSON-carrying source via `fake.sourceOf`.
 *
 * Two old concerns from the pre-rewrite suite have NO analogue under this
 * architecture and are deliberately dropped, not mechanically converted:
 *
 *   - "stale bridge body gets re-PUT on next call": the old per-operation
 *     bridge was a single mutable class re-deployed in place; whether a
 *     stale body got refreshed was this module's own concern. Under fluid,
 *     the classic body class is content-hash versioned by
 *     `src/adt/fluid/ensure.ts` (generic, shared by every fluid tool, not
 *     index-specific) and each call's INVOKER is a separate class named by
 *     a hash of its own arguments — identical arguments always produce the
 *     identical invoker name and thus no second PUT (see the "happy path"
 *     sections below, which assert exactly that), while a body-content
 *     change produces a DIFFERENT class name rather than an in-place
 *     overwrite. The old test's premise (one fixed-name class, mutable body,
 *     diffed-and-re-PUT) does not exist any more; its generic replacement
 *     — deploy freshness of the shared classic body class — belongs to
 *     `test/fluid-dispatch.test.ts`, not this domain-specific suite.
 *   - "worst-case caller values keep the generated line under 255 chars":
 *     the old bridge generated ABAP literally containing the caller's
 *     values, so a long index/table/field name could overflow a source
 *     line. Since `abap-index.ts`'s source is now static (argument values
 *     never appear in it — they travel only in the invoker's JSON payload,
 *     chunked by `src/adt/fluid/invoke.ts`'s `abapArgumentChunks`), this
 *     failure mode is gone from this module entirely; the generic
 *     replacement (chunking correctness for a worst-case argument) is
 *     `invoke.ts`'s own concern and is covered generically, not per-domain.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate, type EvaluateOptions, type Operation, type SafetyTarget } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import {
  DDIC_ERR_PREFIX,
  DDIC_NOTE_PREFIX,
  assertDdicTranscript,
  parseDdicTranscript,
} from "../src/adt/ddic-transcript.js";
import {
  DD_INDEX_EXCEPTIONS,
  INDEX_FIELD_NAME_MAX,
  INDEX_NAME_MAX,
  MAX_INDEX_FIELDS,
  assertSecondaryIndexTarget,
  createSecondaryIndex,
  deleteSecondaryIndexViaBridge,
  indexBridgeErrorHook,
  indexGateName,
  resolveIndexOwner,
  type IndexDeleteParams,
  type SecondaryIndexParams,
} from "../src/adt/index-create.js";
import { indexPart } from "../src/adt/fluid/builtin/classic/abap-index.js";
import { serverPackage, type ServerPackage } from "../src/adt/resolved-package.js";
import { buildUri, specForType } from "../src/adt/types.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { canonicalArgsJson } from "../src/adt/fluid/invoke.js";
import { routeSystemRoleProbe, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { classicFake, useFluidState } from "./helpers/fluid-classic-fake.js";

// ---------------------------------------------------------------------------
// Fake transport — same shape as test/tran-create.test.ts / tran-delete.test.ts
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

/** Allows the fluid classic tool's own deploy package plus both index packages used below. */
const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [FLUID_PACKAGE, "ZTM", "$TMP"],
    allowNamePrefixes: ["*"],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

/** Allows the fluid classic tool's own deploy package only — the domain gate must refuse first. */
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

const CORR_NR = "A4HK900121";
const BASE_TABLE = "ZTMD_I28_T";

/** Mints a genuine `ServerPackage`, mirroring test/resolved-package.test.ts's `confirmed` fixture. */
const pkg = (name: string): ServerPackage => {
  const p = serverPackage({
    status: "confirmed",
    uri: `/sap/bc/adt/ddic/tables/${BASE_TABLE.toLowerCase()}`,
    via: "read-back",
    packageName: name,
  });
  if (!p) throw new Error("test fixture: serverPackage(...) unexpectedly undefined");
  return p;
};

const INDEX: SecondaryIndexParams = {
  indexName: "Z01",
  baseTable: BASE_TABLE,
  fields: ["CARRIER"],
  description: "probe idx",
  packageName: pkg("ZTM"),
  corrNr: CORR_NR,
};

const LOCAL_INDEX: SecondaryIndexParams = {
  ...INDEX,
  packageName: pkg("$TMP"),
  corrNr: undefined,
};

const DELETE_INDEX: IndexDeleteParams = {
  indexName: "Z01",
  baseTable: BASE_TABLE,
  packageName: pkg("ZTM"),
  corrNr: CORR_NR,
};

const LOCAL_DELETE_INDEX: IndexDeleteParams = {
  ...DELETE_INDEX,
  packageName: pkg("$TMP"),
  corrNr: undefined,
};

/** Isolates one method's text out of `indexPart.source`, which holds both `create_index` and `delete_index`. */
const CREATE_METHOD = indexPart.source.slice(
  indexPart.source.indexOf("METHOD create_index."),
  indexPart.source.indexOf("METHOD delete_index."),
);
const DELETE_METHOD = indexPart.source.slice(indexPart.source.indexOf("METHOD delete_index."));

/**
 * Derives the code-controlled `"DD_INDEX_INTERFACE insert"` / `"...delete"`
 * step-name text straight from the deployed ABAP's own `fail(...)` line,
 * rather than hand-typing a copy — so this test breaks if `abap-index.ts`'s
 * wording and `index-create.ts`'s internal `CREATE_FM_WHAT`/`DELETE_FM_WHAT`
 * constants (used by `indexBridgeErrorHook`, not exported) ever drift apart.
 */
function fmWhatFromMethod(method: string): string {
  const m = /\|(.+?) failed, sy-subrc=\{ sy-subrc \}/.exec(method);
  if (!m) throw new Error("test fixture: could not find the sy-subrc fail() line in the method source");
  return m[1]!;
}
const CREATE_FM_WHAT = fmWhatFromMethod(CREATE_METHOD);
const DELETE_FM_WHAT = fmWhatFromMethod(DELETE_METHOD);

// ---------------------------------------------------------------------------
// 1 — the classic body's own transcript vocabulary
// ---------------------------------------------------------------------------

describe("abap-index.ts's transcript vocabulary", () => {
  it("create_index emits exactly INDEX-CREATED, INDEX-ACTIVE, INDEX-FIELDS, each recognised by parseDdicTranscript", () => {
    const tags = [...CREATE_METHOD.matchAll(/line\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]!);
    expect(new Set(tags)).toEqual(new Set(["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"]));
    const parsed = parseDdicTranscript(tags.join("\n"));
    expect(new Set(parsed.tags)).toEqual(new Set(tags));
    expect(parsed.errorLine).toBeUndefined();
  });

  it("delete_index emits exactly INDEX-DELETED-ACTFAILED, INDEX-DELETED, INDEX-GONE as LITERAL tag lines", () => {
    const tags = [...DELETE_METHOD.matchAll(/line\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]!);
    expect(new Set(tags)).toEqual(new Set(["INDEX-DELETED-ACTFAILED", "INDEX-DELETED", "INDEX-GONE"]));
    const parsed = parseDdicTranscript(tags.join("\n"));
    expect(new Set(parsed.tags)).toEqual(new Set(tags));
  });

  it("assertDdicTranscript is satisfied by each method's own plain success output", () => {
    expect(() =>
      assertDdicTranscript(
        parseDdicTranscript("INDEX-CREATED\nINDEX-ACTIVE\nINDEX-FIELDS"),
        ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"],
        "Creating secondary index",
      ),
    ).not.toThrow();
    expect(() =>
      assertDdicTranscript(
        parseDdicTranscript("INDEX-DELETED\nINDEX-GONE"),
        ["INDEX-DELETED", "INDEX-GONE"],
        "Deleting secondary index",
      ),
    ).not.toThrow();
  });

  it("the failure branches write lines parseDdicTranscript reads as errors, not tags", () => {
    const parsed = parseDdicTranscript(`${DDIC_ERR_PREFIX} DD_INDEX_INTERFACE insert failed, sy-subrc=3, AU000`);
    expect(parsed.tags).toEqual([]);
    expect(parsed.errorLine).toContain("sy-subrc=3");
  });

  it("the ACTFAILED-tolerant note line carries DDIC_NOTE_PREFIX, so it never becomes errorLine", () => {
    const parsed = parseDdicTranscript(
      `${DDIC_NOTE_PREFIX} DD_INDEX_INTERFACE delete reported ACTFAILED = 'X' for Z01 on ${BASE_TABLE}, but gone anyway\nINDEX-DELETED-ACTFAILED\nINDEX-DELETED\nINDEX-GONE`,
    );
    expect(parsed.errorLine).toBeUndefined();
    expect(parsed.tags).toEqual(["INDEX-DELETED-ACTFAILED", "INDEX-DELETED", "INDEX-GONE"]);
  });
});

// ---------------------------------------------------------------------------
// 2 — closed template / injection / limits: refused before any network call
// ---------------------------------------------------------------------------

describe("closed template — caller strings and shapes are refused, not escaped, before any network call", () => {
  const offline = null as unknown as AbapConnection;

  it(`refuses an indexName over ${INDEX_NAME_MAX} chars (DD12V-INDEXNAME is CHAR3) with BAD_INPUT`, async () => {
    const err = await catchErr(
      createSecondaryIndex(offline, allowingGate(), { ...INDEX, indexName: "Z001" }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("refuses an indexName carrying an injection attempt with BAD_INPUT", async () => {
    const err = await catchErr(
      createSecondaryIndex(offline, allowingGate(), { ...INDEX, indexName: "Z'." }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("refuses a baseTable over 30 chars with BAD_INPUT", async () => {
    const err = await catchErr(
      createSecondaryIndex(offline, allowingGate(), { ...INDEX, baseTable: "Z" + "A".repeat(30) }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("refuses an empty fields list with BAD_INPUT", async () => {
    const err = await catchErr(createSecondaryIndex(offline, allowingGate(), { ...INDEX, fields: [] }));
    expect(err.code).toBe("BAD_INPUT");
  });

  it("refuses a non-array fields value with BAD_INPUT rather than coercing it", async () => {
    const err = await catchErr(
      createSecondaryIndex(offline, allowingGate(), { ...INDEX, fields: "CARRIER" as unknown as string[] }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it(`refuses more than ${MAX_INDEX_FIELDS} fields with BAD_INPUT`, async () => {
    const fields = Array.from({ length: MAX_INDEX_FIELDS + 1 }, (_, i) => `F${i}`);
    const err = await catchErr(createSecondaryIndex(offline, allowingGate(), { ...INDEX, fields }));
    expect(err.code).toBe("BAD_INPUT");
  });

  it(`refuses a field name over ${INDEX_FIELD_NAME_MAX} chars with BAD_INPUT`, async () => {
    const err = await catchErr(
      createSecondaryIndex(offline, allowingGate(), { ...INDEX, fields: ["A".repeat(31)] }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("refuses a description over 60 chars with BAD_INPUT", async () => {
    const err = await catchErr(
      createSecondaryIndex(offline, allowingGate(), { ...INDEX, description: "x".repeat(61) }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("refuses a corr_nr supplied for a local ($) package with BAD_INPUT", async () => {
    const err = await catchErr(
      createSecondaryIndex(offline, allowingGate(), { ...LOCAL_INDEX, corrNr: CORR_NR }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("refuses a non-local package with no corr_nr at all with TRANSPORT_ERROR", async () => {
    const err = await catchErr(createSecondaryIndex(offline, allowingGate(), { ...INDEX, corrNr: undefined }));
    expect(err.code).toBe("TRANSPORT_ERROR");
  });

  it("refuses a corr_nr that isn't TRKORR-shaped with BAD_INPUT", async () => {
    const err = await catchErr(createSecondaryIndex(offline, allowingGate(), { ...INDEX, corrNr: "not-a-trkorr" }));
    expect(err.code).toBe("BAD_INPUT");
  });

  it("the delete path validates indexName/baseTable/package/corr the same way, before any network call", async () => {
    const err = await catchErr(
      deleteSecondaryIndexViaBridge(offline, allowingGate(), { ...DELETE_INDEX, indexName: "Z001" }),
    );
    expect(err.code).toBe("BAD_INPUT");
    const err2 = await catchErr(
      deleteSecondaryIndexViaBridge(offline, allowingGate(), { ...LOCAL_DELETE_INDEX, corrNr: CORR_NR }),
    );
    expect(err2.code).toBe("BAD_INPUT");
    const err3 = await catchErr(
      deleteSecondaryIndexViaBridge(offline, allowingGate(), { ...DELETE_INDEX, corrNr: undefined }),
    );
    expect(err3.code).toBe("TRANSPORT_ERROR");
  });
});

// ---------------------------------------------------------------------------
// 2b — the ServerPackage brand: a caller-claimed package never reaches the gate
// ---------------------------------------------------------------------------

describe("the ServerPackage brand — a forged packageName is refused before the gate or any dispatch", () => {
  it("create: a packageName forced in via `as unknown as ServerPackage` throws SAFETY_DENIED/PACKAGE_UNKNOWN, zero requests", async () => {
    const fake = classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] });
    const { conn, adt } = await connected(fake.route);
    const forged = "ZTM" as unknown as ServerPackage;
    const err = await catchErr(createSecondaryIndex(conn, allowingGate(), { ...INDEX, packageName: forged }));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details.reason).toBe("PACKAGE_UNKNOWN");
    expect(adt.calls.length).toBe(0);
  });

  it("delete: same forged-package brand check, zero requests", async () => {
    const fake = classicFake({ action: "delete_index", lines: () => ["INDEX-DELETED", "INDEX-GONE"] });
    const { conn, adt } = await connected(fake.route);
    const forged = "ZTM" as unknown as ServerPackage;
    const err = await catchErr(
      deleteSecondaryIndexViaBridge(conn, allowingGate(), { ...DELETE_INDEX, packageName: forged }),
    );
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details.reason).toBe("PACKAGE_UNKNOWN");
    expect(adt.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3 — assertSecondaryIndexTarget, pure and zero-network
// ---------------------------------------------------------------------------

describe("assertSecondaryIndexTarget — local vs transportable package/corr_nr pairing", () => {
  it("a local ($) package with no corr_nr returns \"\"", () => {
    expect(assertSecondaryIndexTarget("$TMP", undefined)).toBe("");
  });

  it("a local ($) package WITH a corr_nr is BAD_INPUT", () => {
    expect(() => assertSecondaryIndexTarget("$TMP", CORR_NR)).toThrow();
    try {
      assertSecondaryIndexTarget("$TMP", CORR_NR);
    } catch (e) {
      expect((e as AbapError).code).toBe("BAD_INPUT");
    }
  });

  it("a transportable package with NO corr_nr is TRANSPORT_ERROR", () => {
    try {
      assertSecondaryIndexTarget("ZTM", undefined);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as AbapError).code).toBe("TRANSPORT_ERROR");
    }
  });

  it("a transportable package with a valid corr_nr returns it trimmed and uppercased", () => {
    expect(assertSecondaryIndexTarget("ZTM", ` ${CORR_NR.toLowerCase()} `)).toBe(CORR_NR);
  });
});

// ---------------------------------------------------------------------------
// 4 — indexGateName, pure
// ---------------------------------------------------------------------------

describe("indexGateName", () => {
  it("embeds the base table so the gate's namespace allowlist has an owner-namespace signal", () => {
    expect(indexGateName(BASE_TABLE, "Z01")).toBe(`${BASE_TABLE}-Z01`);
  });
});

// ---------------------------------------------------------------------------
// 5 — the domain gate: op, type, name, activate, corr threading
// ---------------------------------------------------------------------------

describe("the domain gate — asserted before any dispatch, zero-network on refusal", () => {
  it("create: gate.assert sees TWO calls — op 'write' then op 'activate' — both TABL/DI, both named baseTable-indexName", async () => {
    const seen: Array<{ op: string; type?: string; name?: string }> = [];
    class RecordingGate extends SafetyGate {
      override assert(
        op: Parameters<SafetyGate["assert"]>[0],
        obj?: Parameters<SafetyGate["assert"]>[1],
        opts?: Parameters<SafetyGate["assert"]>[2],
      ): void {
        if (obj?.type === "TABL/DI") seen.push({ op, type: obj.type, name: obj.name });
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
    const fake = classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] });
    const { conn } = await connected(fake.route);
    await createSecondaryIndex(conn, gate, INDEX);
    expect(seen).toEqual([
      { op: "write", type: "TABL/DI", name: `${BASE_TABLE}-Z01` },
      { op: "activate", type: "TABL/DI", name: `${BASE_TABLE}-Z01` },
    ]);
  });

  it("delete: gate.assert sees op 'delete' then op 'activate' (never 'write')", async () => {
    const seen: Array<{ op: string; type?: string; name?: string }> = [];
    class RecordingGate extends SafetyGate {
      override assert(
        op: Parameters<SafetyGate["assert"]>[0],
        obj?: Parameters<SafetyGate["assert"]>[1],
        opts?: Parameters<SafetyGate["assert"]>[2],
      ): void {
        if (obj?.type === "TABL/DI") seen.push({ op, type: obj.type, name: obj.name });
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
    const fake = classicFake({ action: "delete_index", lines: () => ["INDEX-DELETED", "INDEX-GONE"] });
    const { conn } = await connected(fake.route);
    await deleteSecondaryIndexViaBridge(conn, gate, DELETE_INDEX);
    expect(seen).toEqual([
      { op: "delete", type: "TABL/DI", name: `${BASE_TABLE}-Z01` },
      { op: "activate", type: "TABL/DI", name: `${BASE_TABLE}-Z01` },
    ]);
  });

  it("a transportable package threads { corr: { kind: 'transport', corrNr, source: 'named' } } to BOTH gate.assert calls", async () => {
    const seen: Array<EvaluateOptions> = [];
    class RecordingGate extends SafetyGate {
      override assert(op: Operation, obj?: SafetyTarget, opts: EvaluateOptions = {}): void {
        if (obj?.type === "TABL/DI") seen.push(opts);
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
    const fake = classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] });
    const { conn } = await connected(fake.route);
    await createSecondaryIndex(conn, gate, INDEX);
    expect(seen).toEqual([
      { corr: { kind: "transport", corrNr: CORR_NR, source: "named" } },
      { corr: { kind: "transport", corrNr: CORR_NR, source: "named" } },
    ]);
  });

  it("a local package threads NO corr option at all (not a synthesised local corr) to either gate.assert call", async () => {
    const seen: Array<EvaluateOptions> = [];
    class RecordingGate extends SafetyGate {
      override assert(op: Operation, obj?: SafetyTarget, opts: EvaluateOptions = {}): void {
        if (obj?.type === "TABL/DI") seen.push(opts);
        super.assert(op, obj, opts);
      }
    }
    const gate = new RecordingGate({
      readOnly: false,
      allowPackages: [FLUID_PACKAGE, "$TMP"],
      allowNamePrefixes: ["*"],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const fake = classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] });
    const { conn } = await connected(fake.route);
    await createSecondaryIndex(conn, gate, LOCAL_INDEX);
    expect(seen).toEqual([{}, {}]);
  });

  it("a gate that refuses the index's own package refuses the whole call with ZERO requests (create)", async () => {
    const fake = classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] });
    const { conn, adt } = await connected(fake.route);
    const err = await catchErr(createSecondaryIndex(conn, bridgeOnlyGate(), INDEX));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(adt.calls.length).toBe(0);
  });

  it("a gate that refuses the index's own package refuses the whole call with ZERO requests (delete)", async () => {
    const fake = classicFake({ action: "delete_index", lines: () => ["INDEX-DELETED", "INDEX-GONE"] });
    const { conn, adt } = await connected(fake.route);
    const err = await catchErr(deleteSecondaryIndexViaBridge(conn, bridgeOnlyGate(), DELETE_INDEX));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(adt.calls.length).toBe(0);
  });

  it("a readOnly gate refuses too, zero requests made", async () => {
    const fake = classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] });
    const { conn, adt } = await connected(fake.route);
    const readOnly = new SafetyGate({ readOnly: true, allowPackages: [FLUID_PACKAGE, "ZTM"], writesLockedOut: false });
    const err = await catchErr(createSecondaryIndex(conn, readOnly, INDEX));
    expect(err).toBeTruthy();
    expect(adt.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6 — the fields array: n('fields') count + s('fields/{i}') decode loop
// ---------------------------------------------------------------------------

describe("the fields array — n()/s() decode loop", () => {
  it("create_index reads the count via n('fields') then loops s( |fields/{ lv_i - 1 }| ) into lt_fields", () => {
    expect(CREATE_METHOD).toContain("n( 'fields' )");
    expect(CREATE_METHOD).toContain("DO lv_field_count TIMES.");
    expect(CREATE_METHOD).toContain("s( |fields/{ lv_i - 1 }| )");
  });

  it("the invoker's JSON payload carries a multi-field fields array, flattened and reconstructed byte-for-byte", async () => {
    const many = { ...INDEX, fields: ["CARRIER", "CONNID", "FLDATE"] };
    const fake = classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] });
    const { conn } = await connected(fake.route);
    await createSecondaryIndex(conn, allowingGate(), many);

    const invoker = fake.invoker();
    expect(invoker).toBeTruthy();
    const src = fake.sourceOf(invoker!);
    const chunks = [...src!.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
    const payload = chunks.join("");
    expect(payload).toBe(
      canonicalArgsJson({
        index_name: "Z01",
        base_table: BASE_TABLE,
        fields: ["CARRIER", "CONNID", "FLDATE"],
        description: "probe idx",
        package_name: "ZTM",
        corr_nr: CORR_NR,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 7 — the unique flag: b('unique') at runtime, present on the wire only when the caller explicitly set it
// ---------------------------------------------------------------------------

describe("the unique flag", () => {
  it("create_index reads it via b( 'unique' )", () => {
    expect(CREATE_METHOD).toContain("DATA(lv_unique) = b( 'unique' ).");
  });

  it("caller omitting `unique` entirely omits the key from the wire JSON altogether", async () => {
    const fake = classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] });
    const { conn } = await connected(fake.route);
    await createSecondaryIndex(conn, allowingGate(), INDEX);
    const src = fake.sourceOf(fake.invoker()!);
    const payload = [...src!.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join("");
    expect(payload).not.toContain('"unique"');
  });

  it("caller passing unique: true puts \"unique\":true on the wire", async () => {
    const fake = classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] });
    const { conn } = await connected(fake.route);
    await createSecondaryIndex(conn, allowingGate(), { ...INDEX, unique: true });
    const src = fake.sourceOf(fake.invoker()!);
    const payload = [...src!.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join("");
    expect(payload).toContain('"unique":true');
  });

  it("caller passing unique: false EXPLICITLY still puts \"unique\":false on the wire (not omitted)", async () => {
    const fake = classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] });
    const { conn } = await connected(fake.route);
    await createSecondaryIndex(conn, allowingGate(), { ...INDEX, unique: false });
    const src = fake.sourceOf(fake.invoker()!);
    const payload = [...src!.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join("");
    expect(payload).toContain('"unique":false');
  });
});

// ---------------------------------------------------------------------------
// 8 — the unique-index client-field guard: structural + full round trip
// ---------------------------------------------------------------------------

describe("the unique-index client-field guard", () => {
  it("is compiled in unconditionally but gated at RUNTIME by IF lv_unique = abap_true", () => {
    const guardStart = CREATE_METHOD.indexOf("IF lv_unique = abap_true.");
    const clntSelect = CREATE_METHOD.indexOf("datatype = 'CLNT'", guardStart);
    const failCall = CREATE_METHOD.indexOf("omits the client field", clntSelect);
    const endif = CREATE_METHOD.indexOf("ENDIF.", failCall);
    expect(guardStart).toBeGreaterThanOrEqual(0);
    expect(clntSelect).toBeGreaterThan(guardStart);
    expect(failCall).toBeGreaterThan(clntSelect);
    expect(endif).toBeGreaterThan(failCall);
    // sits before the CALL FUNCTION, so a bad unique index never reaches DD_INDEX_INTERFACE at all
    expect(CREATE_METHOD.indexOf("CALL FUNCTION 'DD_INDEX_INTERFACE'")).toBeGreaterThan(endif);
  });

  it("a unique index whose fields omit the client field is refused with BAD_INPUT, full round trip via classicFake", async () => {
    const fake = classicFake({
      action: "create_index",
      lines: () => [`${DDIC_ERR_PREFIX} unique index Z01 on ${BASE_TABLE} omits the client field MANDT`],
    });
    const { conn } = await connected(fake.route);
    const err = await catchErr(createSecondaryIndex(conn, allowingGate(), { ...INDEX, unique: true }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("client field");
  });
});

// ---------------------------------------------------------------------------
// 9 — DD_INDEX_INTERFACE call structure: EXCEPTIONS clause, TABLES clause, guard ordering
// ---------------------------------------------------------------------------

describe("DD_INDEX_INTERFACE call structure", () => {
  it("both methods declare the EXACT same 8 EXCEPTIONS, in the same subrc order DD_INDEX_EXCEPTIONS mirrors", () => {
    const expected = DD_INDEX_EXCEPTIONS.map((e) => `${e.name} = ${e.subrc}`);
    for (const method of [CREATE_METHOD, DELETE_METHOD]) {
      const excBlock = method.slice(method.indexOf("EXCEPTIONS"), method.indexOf("OTHERS = 8.") + "OTHERS = 8.".length);
      for (const line of expected.slice(0, -1)) {
        expect(excBlock).toContain(line);
      }
      expect(excBlock).toContain("OTHERS = 8");
    }
  });

  it("create_index passes TABLES index_fields = lt_fields, populated from the fields array", () => {
    expect(CREATE_METHOD).toMatch(/TABLES\s+index_fields\s*=\s*lt_fields/);
  });

  it("delete_index ALSO passes TABLES index_fields = lt_fields — required even though it sends none (live 2026-09-05 bug)", () => {
    expect(DELETE_METHOD).toMatch(/TABLES\s+index_fields\s*=\s*lt_fields/);
    expect(DELETE_METHOD).toContain("mandatory parameter INDEX_FIELDS was not filled");
  });

  it("create_index: the sy-subrc guard sits BETWEEN the CALL FUNCTION and INDEX-CREATED, and RETURNs first", () => {
    const call = CREATE_METHOD.indexOf("CALL FUNCTION 'DD_INDEX_INTERFACE'");
    const guard = CREATE_METHOD.indexOf("IF sy-subrc <> 0.", call);
    const tag = CREATE_METHOD.indexOf("line( 'INDEX-CREATED' )");
    expect(call).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(call);
    expect(tag).toBeGreaterThan(guard);
  });

  it("delete_index: the sy-subrc guard sits BETWEEN the CALL FUNCTION and the unconditional COMMIT WORK", () => {
    const call = DELETE_METHOD.indexOf("CALL FUNCTION 'DD_INDEX_INTERFACE'");
    const guard = DELETE_METHOD.indexOf("IF sy-subrc <> 0.", call);
    const commit = DELETE_METHOD.indexOf("COMMIT WORK.", guard);
    expect(call).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(call);
    expect(commit).toBeGreaterThan(guard);
  });
});

// ---------------------------------------------------------------------------
// 10 — indexBridgeErrorHook / DD_INDEX_EXCEPTIONS mapping
// ---------------------------------------------------------------------------

describe("indexBridgeErrorHook maps every DD_INDEX_INTERFACE exception through DD_INDEX_EXCEPTIONS", () => {
  for (const entry of DD_INDEX_EXCEPTIONS) {
    it(`insert: subrc ${entry.subrc} (${entry.name}) -> ${entry.code}`, () => {
      const hook = indexBridgeErrorHook("insert", "Z01", BASE_TABLE);
      const transcript = parseDdicTranscript(`${DDIC_ERR_PREFIX} ${CREATE_FM_WHAT} failed, sy-subrc=${entry.subrc}, AU000`);
      let caught: AbapError | undefined;
      try {
        hook(transcript);
      } catch (e) {
        caught = e as AbapError;
      }
      expect(caught?.code).toBe(entry.code);
    });

    it(`delete: subrc ${entry.subrc} (${entry.name}) -> ${entry.code}`, () => {
      const hook = indexBridgeErrorHook("delete", "Z01", BASE_TABLE);
      const transcript = parseDdicTranscript(`${DDIC_ERR_PREFIX} ${DELETE_FM_WHAT} failed, sy-subrc=${entry.subrc}, AU000`);
      let caught: AbapError | undefined;
      try {
        hook(transcript);
      } catch (e) {
        caught = e as AbapError;
      }
      expect(caught?.code).toBe(entry.code);
    });
  }

  it("delete: the pre-check \"does not exist\" line (never reaches DD_INDEX_INTERFACE) maps to NOT_FOUND", () => {
    const hook = indexBridgeErrorHook("delete", "Z01", BASE_TABLE);
    const transcript = parseDdicTranscript(`${DDIC_ERR_PREFIX} index Z01 on ${BASE_TABLE} does not exist`);
    let caught: AbapError | undefined;
    try {
      hook(transcript);
    } catch (e) {
      caught = e as AbapError;
    }
    expect(caught?.code).toBe("NOT_FOUND");
  });

  it("create: the client-field guard line maps to BAD_INPUT", () => {
    const hook = indexBridgeErrorHook("insert", "Z01", BASE_TABLE);
    const transcript = parseDdicTranscript(`${DDIC_ERR_PREFIX} unique index Z01 on ${BASE_TABLE} omits the client field MANDT`);
    let caught: AbapError | undefined;
    try {
      hook(transcript);
    } catch (e) {
      caught = e as AbapError;
    }
    expect(caught?.code).toBe("BAD_INPUT");
  });

  it("an unrelated error line is left alone (returns without throwing) — assertDdicTranscript handles it generically", () => {
    const hook = indexBridgeErrorHook("insert", "Z01", BASE_TABLE);
    const transcript = parseDdicTranscript(`${DDIC_ERR_PREFIX} something else entirely`);
    expect(() => hook(transcript)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 11 — ACTFAILED on CREATE: fails before INDEX-CREATED ever fires (no partial success)
// ---------------------------------------------------------------------------

describe("create: ACTFAILED = 'X' is a hard failure with NO tags fired yet", () => {
  it("the ACTFAILED check sits AFTER the sy-subrc guard but BEFORE line('INDEX-CREATED')", () => {
    const guard = CREATE_METHOD.indexOf("IF sy-subrc <> 0.");
    const actfailed = CREATE_METHOD.indexOf("IF lv_actfailed = 'X'.");
    const tag = CREATE_METHOD.indexOf("line( 'INDEX-CREATED' )");
    expect(actfailed).toBeGreaterThan(guard);
    expect(tag).toBeGreaterThan(actfailed);
  });

  it("full round trip: ACTFAILED disclosure is CHECK_FAILED with the DD12V row count, and reports NO partial success (INDEX-CREATED never fired)", async () => {
    const fake = classicFake({
      action: "create_index",
      lines: () => [
        `${DDIC_ERR_PREFIX} DD_INDEX_INTERFACE insert reported ACTFAILED = 'X' for Z01 on ${BASE_TABLE}; DD12V rows for this pair after the failure, any AS4LOCAL: 0`,
      ],
    });
    const { conn } = await connected(fake.route);
    const err = await catchErr(createSecondaryIndex(conn, allowingGate(), INDEX));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("ACTFAILED");
    expect(err.message).not.toContain("PARTIAL SUCCESS");
  });
});

// ---------------------------------------------------------------------------
// 12 — partial success on a LATER create-side failure
// ---------------------------------------------------------------------------

describe("create: a failure AFTER INDEX-CREATED already fired is reported as partial success, not a plain no-op failure", () => {
  it("INDEX-CREATED fired then the DD12V active re-check fails -> CHECK_FAILED names INDEX-CREATED's already-committed effect", async () => {
    const fake = classicFake({
      action: "create_index",
      lines: () => [
        "INDEX-CREATED",
        `${DDIC_ERR_PREFIX} Z01 on ${BASE_TABLE} not found active (AS4LOCAL = 'A') in DD12V after commit`,
      ],
    });
    const { conn } = await connected(fake.route);
    const err = await catchErr(createSecondaryIndex(conn, allowingGate(), INDEX));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("PARTIAL SUCCESS");
    expect(err.message).toContain("DD_INDEX_INTERFACE (action='I') created");
    expect(err.hint).toContain('mode="delete"');
  });

  it("INDEX-CREATED and INDEX-ACTIVE both fired, then DD17S count is short -> both completed sentences are named", async () => {
    const fake = classicFake({
      action: "create_index",
      lines: () => [
        "INDEX-CREATED",
        "INDEX-ACTIVE",
        `${DDIC_ERR_PREFIX} expected at least 1 DD17S field row(s) for Z01 on ${BASE_TABLE}, got 0`,
      ],
    });
    const { conn } = await connected(fake.route);
    const err = await catchErr(createSecondaryIndex(conn, allowingGate(), INDEX));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("PARTIAL SUCCESS");
    expect(err.message).toContain("DD_INDEX_INTERFACE (action='I') created");
    expect(err.message).toContain("was found active");
  });

  it("a plain missing-tag failure with NO error line at all is the ordinary (non-partial) CHECK_FAILED wording", async () => {
    const fake = classicFake({ action: "create_index", lines: () => ["INDEX-CREATED"] });
    const { conn } = await connected(fake.route);
    const err = await catchErr(createSecondaryIndex(conn, allowingGate(), INDEX));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).not.toContain("PARTIAL SUCCESS");
    expect(err.message).toContain("INDEX-ACTIVE");
  });
});

// ---------------------------------------------------------------------------
// 13 — ACTFAILED-tolerant delete read-back
// ---------------------------------------------------------------------------

describe("delete: the read-back decides, not ACTFAILED", () => {
  it("COMMIT WORK runs unconditionally, BEFORE the post-commit read-back — even when ACTFAILED = 'X'", () => {
    const call = DELETE_METHOD.indexOf("CALL FUNCTION 'DD_INDEX_INTERFACE'");
    const commit = DELETE_METHOD.indexOf("COMMIT WORK.", call);
    const readback = DELETE_METHOD.indexOf("SELECT COUNT( * ) FROM dd12v", commit);
    expect(commit).toBeGreaterThan(call);
    expect(readback).toBeGreaterThan(commit);
    // No "IF lv_actfailed" gate stands between CALL FUNCTION and COMMIT WORK.
    const actfailedGate = DELETE_METHOD.indexOf("IF lv_actfailed = 'X'.");
    expect(actfailedGate).toBeGreaterThan(commit);
  });

  it("all three counters non-zero (or any one of them) -> fail, never INDEX-DELETED/INDEX-GONE", () => {
    const readback = DELETE_METHOD.indexOf("IF lv_dd12v_count <> 0 OR lv_dd12v_active <> 0 OR lv_dd17s_count <> 0.");
    const fail = DELETE_METHOD.indexOf("fail( lv_msg )", readback);
    const ret = DELETE_METHOD.indexOf("RETURN.", fail);
    const deletedTag = DELETE_METHOD.indexOf("line( 'INDEX-DELETED' )");
    expect(readback).toBeGreaterThanOrEqual(0);
    expect(fail).toBeGreaterThan(readback);
    expect(ret).toBeGreaterThan(fail);
    expect(deletedTag).toBeGreaterThan(ret);
  });

  it("full round trip: rows surviving after commit is CHECK_FAILED naming all three counts and the ACTFAILED value", async () => {
    const fake = classicFake({
      action: "delete_index",
      lines: () => [
        `${DDIC_ERR_PREFIX} delete of Z01 on ${BASE_TABLE} left rows behind after commit (DD12V any: 1, DD12V active: 0, DD17S: 2); DD_INDEX_INTERFACE delete ACTFAILED = ' '`,
      ],
    });
    const { conn } = await connected(fake.route);
    const err = await catchErr(deleteSecondaryIndexViaBridge(conn, allowingGate(), DELETE_INDEX));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("left rows behind after commit");
    expect(err.message).toContain("DD12V any: 1");
  });

  it("full round trip: ACTFAILED = 'X' with an ALL-ZERO read-back is treated as success — INDEX-DELETED-ACTFAILED plus the ordinary tags", async () => {
    const fake = classicFake({
      action: "delete_index",
      lines: () => [
        `${DDIC_NOTE_PREFIX} DD_INDEX_INTERFACE delete reported ACTFAILED = 'X' for Z01 on ${BASE_TABLE}, but the post-commit read-back found it gone (DD12V any: 0, DD12V active: 0, DD17S: 0) — treating as deleted`,
        "INDEX-DELETED-ACTFAILED",
        "INDEX-DELETED",
        "INDEX-GONE",
      ],
    });
    const { conn } = await connected(fake.route);
    const { transcript } = await deleteSecondaryIndexViaBridge(conn, allowingGate(), DELETE_INDEX);
    expect(transcript.tags).toEqual(["INDEX-DELETED-ACTFAILED", "INDEX-DELETED", "INDEX-GONE"]);
    expect(transcript.errorLine).toBeUndefined();
  });

  it("a non-existent index is refused by name via the pre-check, before DD_INDEX_INTERFACE is ever called", async () => {
    const fake = classicFake({
      action: "delete_index",
      lines: () => [`${DDIC_ERR_PREFIX} index Z01 on ${BASE_TABLE} does not exist`],
    });
    const { conn } = await connected(fake.route);
    const err = await catchErr(deleteSecondaryIndexViaBridge(conn, allowingGate(), DELETE_INDEX));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain("does not exist");
  });
});

// ---------------------------------------------------------------------------
// 14 — happy path
// ---------------------------------------------------------------------------

describe("createSecondaryIndex happy path", () => {
  it("deploys, activates and runs the classic tool; reports all three tags", async () => {
    const fake = classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] });
    const { conn, adt } = await connected(fake.route);

    const { transcript, run } = await createSecondaryIndex(conn, allowingGate(), INDEX);
    expect(transcript.tags).toEqual(["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"]);
    expect(transcript.errorLine).toBeUndefined();
    expect(run.output).toContain("INDEX-FIELDS");

    const methods = adt.calls.map((c) => (c.method ?? "GET").toUpperCase());
    expect(methods).toContain("PUT");
    expect(adt.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
  });

  it("the invoker's JSON payload carries every argument, unmangled, including an empty corr_nr for a local package", async () => {
    const fake = classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] });
    const { conn } = await connected(fake.route);
    await createSecondaryIndex(conn, allowingGate(), LOCAL_INDEX);
    const src = fake.sourceOf(fake.invoker()!);
    const payload = [...src!.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join("");
    expect(payload).toBe(
      canonicalArgsJson({
        index_name: "Z01",
        base_table: BASE_TABLE,
        fields: ["CARRIER"],
        description: "probe idx",
        package_name: "$TMP",
        corr_nr: "",
      }),
    );
    expect(src).toContain("create_index");
  });

  it("an identical repeat call issues no second invoker PUT", async () => {
    const fake = classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] });
    const { conn, adt } = await connected(fake.route);
    await createSecondaryIndex(conn, allowingGate(), INDEX);
    const before = adt.calls.length;
    await createSecondaryIndex(conn, allowingGate(), INDEX);
    const putsAfterSecond = adt.calls.slice(before).filter((c) => (c.method ?? "").toUpperCase() === "PUT");
    expect(putsAfterSecond).toEqual([]);
  });
});

describe("deleteSecondaryIndexViaBridge happy path", () => {
  it("deploys, activates and runs the classic tool; reports both INDEX-DELETED and INDEX-GONE", async () => {
    const fake = classicFake({ action: "delete_index", lines: () => ["INDEX-DELETED", "INDEX-GONE"] });
    const { conn, adt } = await connected(fake.route);

    const { transcript, run } = await deleteSecondaryIndexViaBridge(conn, allowingGate(), DELETE_INDEX);
    expect(transcript.tags).toEqual(["INDEX-DELETED", "INDEX-GONE"]);
    expect(transcript.errorLine).toBeUndefined();
    expect(run.output).toContain("INDEX-GONE");

    const methods = adt.calls.map((c) => (c.method ?? "GET").toUpperCase());
    expect(methods).toContain("PUT");
  });

  it("the invoker's JSON payload carries the caller's index_name/base_table/package_name/corr_nr, unmangled", async () => {
    const fake = classicFake({ action: "delete_index", lines: () => ["INDEX-DELETED", "INDEX-GONE"] });
    const { conn } = await connected(fake.route);
    await deleteSecondaryIndexViaBridge(conn, allowingGate(), DELETE_INDEX);
    const src = fake.sourceOf(fake.invoker()!);
    const payload = [...src!.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join("");
    expect(payload).toBe(
      canonicalArgsJson({ index_name: "Z01", base_table: BASE_TABLE, package_name: "ZTM", corr_nr: CORR_NR }),
    );
  });

  it("an identical repeat call issues no second invoker PUT", async () => {
    const fake = classicFake({ action: "delete_index", lines: () => ["INDEX-DELETED", "INDEX-GONE"] });
    const { conn, adt } = await connected(fake.route);
    await deleteSecondaryIndexViaBridge(conn, allowingGate(), DELETE_INDEX);
    const before = adt.calls.length;
    await deleteSecondaryIndexViaBridge(conn, allowingGate(), DELETE_INDEX);
    const putsAfterSecond = adt.calls.slice(before).filter((c) => (c.method ?? "").toUpperCase() === "PUT");
    expect(putsAfterSecond).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 15 — resolveIndexOwner: the ONLY constructor of a ServerPackage on this path
// ---------------------------------------------------------------------------

describe("resolveIndexOwner — reads the base table's real package, never trusts a caller-supplied one", () => {
  const TABLE_URI = buildUri(specForType("TABL/DT")!, BASE_TABLE);

  const tableXml = (packageName: string): string =>
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<tabl:table xmlns:tabl="http://www.sap.com/wbobj/dictionary/tabl" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:name="${BASE_TABLE}" adtcore:type="TABL/DT"><adtcore:packageRef adtcore:name="${packageName}"/></tabl:table>`;

  it("a table with a real packageRef resolves to a genuine ServerPackage carrying that name", async () => {
    const adt = new FakeAdt((o) => {
      const base = baseRoute(o);
      if (base) return base;
      if (o.url === TABLE_URI && (o.method ?? "GET").toUpperCase() === "GET") {
        return resp(200, tableXml("ZTM"), { "content-type": "application/xml" });
      }
      return undefined;
    });
    const conn = new AbapConnection(cfg(), {
      httpClient: routeSystemRoleProbe(adt, { answer: "nonproductive" }),
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    await conn.connect();
    const { packageName, uri } = await resolveIndexOwner(conn, BASE_TABLE);
    expect(packageName.name).toBe("ZTM");
    expect(uri).toBe(TABLE_URI);
  });

  it("a 404 on the base table throws NOT_FOUND, naming the table", async () => {
    const adt = new FakeAdt((o) => {
      const base = baseRoute(o);
      if (base) return base;
      if (o.url === TABLE_URI && (o.method ?? "GET").toUpperCase() === "GET") {
        const notFoundXml =
          `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
          `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
          `<message lang="EN">${BASE_TABLE} does not exist</message><properties/></exc:exception>`;
        const r = resp(404, notFoundXml, { "content-type": "application/xml" });
        throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
      }
      return undefined;
    });
    const conn = new AbapConnection(cfg(), {
      httpClient: routeSystemRoleProbe(adt, { answer: "nonproductive" }),
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    await conn.connect();
    const err = await catchErr(resolveIndexOwner(conn, BASE_TABLE));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain(BASE_TABLE);
  });

  it("a table XML with no usable packageRef throws SAFETY_DENIED/PACKAGE_UNKNOWN rather than defaulting to $TMP or trusting a guess", async () => {
    const adt = new FakeAdt((o) => {
      const base = baseRoute(o);
      if (base) return base;
      if (o.url === TABLE_URI && (o.method ?? "GET").toUpperCase() === "GET") {
        return resp(
          200,
          `<?xml version="1.0" encoding="utf-8"?><tabl:table xmlns:tabl="http://www.sap.com/wbobj/dictionary/tabl" adtcore:name="${BASE_TABLE}"/>`,
          { "content-type": "application/xml" },
        );
      }
      return undefined;
    });
    const conn = new AbapConnection(cfg(), {
      httpClient: routeSystemRoleProbe(adt, { answer: "nonproductive" }),
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    await conn.connect();
    const err = await catchErr(resolveIndexOwner(conn, BASE_TABLE));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details.reason).toBe("PACKAGE_UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// 16 — issue #86: the independent DD12V/DD17S re-read verdict, on top of the
// bridge's own transcript. `createSecondaryIndex`/`deleteSecondaryIndexViaBridge`
// each run one more, genuinely independent `dataPreviewFreestyle` read
// (`verifySecondaryIndex`, `src/adt/index-read.ts`) right after the fluid
// bridge itself reports success — routed here over the SAME `FakeAdt` the
// bridge deploy/invoke traffic already uses (`/sap/bc/adt/datapreview/
// freestyle`), distinguished by which catalog table the generated SQL names.
// None of the tests above this section ever routes this request at all — it
// falls through as "unrouted" (`FakeAdt` throws), which `verifySecondaryIndex`
// swallows into `verified: false` and neither `assertCreateVerdictAgrees` nor
// `deleteSecondaryIndexViaBridge` treats as fatal — so the "happy path" tests
// above pass without ever actually confirming the independent re-read agreed.
// These tests close that gap: they route DD12V/DD17S explicitly, to a
// deliberately chosen answer, and check `verdict` — which the tests above
// never inspect at all.
// ---------------------------------------------------------------------------

function indexColumnXml(name: string, values: readonly string[]): string {
  const data = values.map((v) => `<dataPreview:data>${v}</dataPreview:data>`).join("");
  return (
    `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="C" dataPreview:keyAttribute="false"/>` +
    `<dataPreview:dataSet>${data}</dataPreview:dataSet></dataPreview:columns>`
  );
}

function indexTableBody(cols: Record<string, readonly string[]>): string {
  const names = Object.keys(cols);
  const colsXml = names.map((n) => indexColumnXml(n, cols[n]!)).join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
    `${colsXml}</dataPreview:tableData>`
  );
}

function indexEmptyBody(): string {
  return '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview"></dataPreview:tableData>';
}

/** DD12V/DD17S rows describing Z01 on BASE_TABLE as present, in the given AS4LOCAL activation state. */
function dd12vRow(activation: "A" | "I"): string {
  return indexTableBody({
    SQLTAB: [BASE_TABLE],
    INDEXNAME: ["Z01"],
    DDLANGUAGE: ["E"],
    UNIQUEFLAG: [""],
    AS4LOCAL: [activation],
    DBSTATE: ["ACT"],
    DDTEXT: ["probe idx"],
  });
}

function dd17sRow(): string {
  return indexTableBody({
    SQLTAB: [BASE_TABLE],
    INDEXNAME: ["Z01"],
    POSITION: ["0001"],
    FIELDNAME: ["CARRIER"],
  });
}

/**
 * `connected()` above wraps its fake in `routeSystemRoleProbe`, which
 * intercepts EVERY `/sap/bc/adt/datapreview/freestyle` POST by URL alone
 * (see `isSystemRoleProbe` in `test/helpers/system-role-fake.ts`) and always
 * answers with the T000 probe body — fine for every test above this section,
 * none of which issues a second freestyle call, but wrong here: `issue #86`'s
 * independent re-read (`verifySecondaryIndex`) is a SECOND freestyle caller,
 * and the blanket proxy would swallow it too, answering DD12V/DD17S queries
 * with T000's columns instead (confirmed live while drafting this — the
 * re-read failed with "expected column INDEXNAME is missing (columns
 * present: MANDT, CCCATEGORY, CCCORACTIV)", T000's own columns). So this
 * connects WITHOUT that proxy and answers the system-role probe itself, by
 * body content (the fixed, code-controlled `T000_QUERY` from
 * `src/adt/system-role.ts`), before falling through to DD12V/DD17S routing.
 */
async function connectedWithCatalogReread(
  fake: ReturnType<typeof classicFake>,
  catalog: { dd12v: string; dd17s: string } | "unrouted",
): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const route: Route = (o) => {
    const bridge = fake.route(o);
    if (bridge) return bridge;
    if (o.url.includes("/sap/bc/adt/datapreview/freestyle")) {
      const sql = String(o.body ?? "").toLowerCase();
      if (sql.includes("from t000")) return resp(200, T000_NONPRODUCTIVE, { "content-type": "application/xml" });
      if (catalog !== "unrouted") {
        if (sql.includes("dd12v")) return resp(200, catalog.dd12v, { "content-type": "application/xml" });
        if (sql.includes("dd17s")) return resp(200, catalog.dd17s, { "content-type": "application/xml" });
      }
    }
    return undefined;
  };
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(cfg(), { httpClient: adt, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

describe("createSecondaryIndex — the independent catalog re-read AGREES (present, active)", () => {
  it("verdict.verified/present/active are all true, and neither run.output nor verdict.statement ever mentions ACTFAILED", async () => {
    const fake = classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] });
    const { conn } = await connectedWithCatalogReread(fake, { dd12v: dd12vRow("A"), dd17s: dd17sRow() });

    const { run, verdict } = await createSecondaryIndex(conn, allowingGate(), INDEX);
    expect(verdict.verified).toBe(true);
    expect(verdict.present).toBe(true);
    expect(verdict.active).toBe(true);
    expect(run.output).not.toContain("ACTFAILED");
    expect(verdict.statement).not.toContain("ACTFAILED");
  });
});

describe("createSecondaryIndex — the independent catalog re-read DISAGREES with the bridge's own transcript", () => {
  it("re-read finds it inactive -> CHECK_FAILED, PARTIAL SUCCESS wording, verdict carried in details", async () => {
    const fake = classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] });
    const { conn } = await connectedWithCatalogReread(fake, { dd12v: dd12vRow("I"), dd17s: dd17sRow() });

    const err = await catchErr(createSecondaryIndex(conn, allowingGate(), INDEX));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("PARTIAL SUCCESS, NOT A NO-OP");
    expect(err.message).toContain("DD_INDEX_INTERFACE (action='I') created");
    const details = err.details as { verdict?: { verified: boolean; present: boolean; active: boolean } };
    expect(details.verdict?.verified).toBe(true);
    expect(details.verdict?.active).toBe(false);
  });

  it("re-read finds it entirely absent -> CHECK_FAILED naming the disagreement", async () => {
    const fake = classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] });
    const { conn } = await connectedWithCatalogReread(fake, { dd12v: indexEmptyBody(), dd17s: indexEmptyBody() });

    const err = await catchErr(createSecondaryIndex(conn, allowingGate(), INDEX));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("is absent from DD12V");
  });
});

describe("createSecondaryIndex — the independent catalog re-read itself FAILS", () => {
  it("an unroutable re-read never throws: it resolves with verdict.verified=false and a reason, not a CHECK_FAILED", async () => {
    const fake = classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] });
    const { conn } = await connectedWithCatalogReread(fake, "unrouted");

    const { verdict } = await createSecondaryIndex(conn, allowingGate(), INDEX);
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toBeDefined();
    expect(verdict.statement).toContain("the DD12V/DD17S re-read itself failed");
  });
});

describe("deleteSecondaryIndexViaBridge — a disagreeing catalog re-read is carried out, never thrown", () => {
  it("bridge reports deleted, but DD12V still shows the row present -> resolves normally with verdict.present=true", async () => {
    const fake = classicFake({ action: "delete_index", lines: () => ["INDEX-DELETED", "INDEX-GONE"] });
    const { conn } = await connectedWithCatalogReread(fake, { dd12v: dd12vRow("A"), dd17s: dd17sRow() });

    const { transcript, verdict } = await deleteSecondaryIndexViaBridge(conn, allowingGate(), DELETE_INDEX);
    expect(transcript.tags).toEqual(["INDEX-DELETED", "INDEX-GONE"]);
    expect(verdict.verified).toBe(true);
    expect(verdict.present).toBe(true);
    expect(verdict.statement).toContain("expected absent, but the catalog still shows it");
  });

  it("bridge and re-read agree the index is gone -> verdict.present=false", async () => {
    const fake = classicFake({ action: "delete_index", lines: () => ["INDEX-DELETED", "INDEX-GONE"] });
    const { conn } = await connectedWithCatalogReread(fake, { dd12v: indexEmptyBody(), dd17s: indexEmptyBody() });

    const { verdict } = await deleteSecondaryIndexViaBridge(conn, allowingGate(), DELETE_INDEX);
    expect(verdict.verified).toBe(true);
    expect(verdict.present).toBe(false);
  });
});
