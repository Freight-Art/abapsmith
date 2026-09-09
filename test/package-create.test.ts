/**
 * `DEVC/K` (package) create — offline, against the fluid `classic` tool.
 * Nothing here touches SAP; the transport is faked through
 * `ConnectionOptions.httpClient`, using the shared
 * `test/helpers/fluid-classic-fake.ts` fake plus a small local harness for
 * session/discovery/system-role plumbing — same idiom as
 * `test/tran-create.test.ts` / `test/index-create.test.ts`.
 *
 * As with the other domains rewritten onto the fluid `classic` tool,
 * `abap-package.ts`'s `create_package` method reads every value at RUNTIME
 * via `s('path')` off the JSON argument string, so the deployed class body
 * is a fixed, argument-independent string — a caller's `corrNr`,
 * `packageName`, etc. never appear IN the body source, only on the wire (the
 * invoker's chunked JSON payload). Structural tests below therefore scan
 * `packagePart.source` for ORDER and GUARD shape (the five classic-exception
 * `CALL METHOD`s all `EXCEPTIONS OTHERS = 1`-guarded, the second
 * "attach a superpackage" step compiled in unconditionally but gated at
 * runtime by `IF lv_super IS NOT INITIAL`); wire-content tests reconstruct
 * the invoker's JSON payload via `canonicalArgsJson` the same way
 * `test/index-create.test.ts` does for `fields`/`unique`. The old
 * per-corrNr "produces a different save call" test has no analogue any
 * more — the value is never IN the generated code at all — so it is
 * replaced by one canonical-JSON wire-payload check (the value reaches
 * `lv_corr_nr` at runtime regardless of what it is).
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
  PKG_TDEVC_PREFIX,
  createPackageViaBridge,
  parseTdevcLine,
  tdevcDiscrepancies,
  type PackageBridgeParams,
  type TdevcRow,
} from "../src/adt/package-create.js";
import { preflightPackageCorr, type PreflightTarget } from "../src/adt/write.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import { packagePart } from "../src/adt/fluid/builtin/classic/abap-package.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { canonicalArgsJson } from "../src/adt/fluid/invoke.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import { classicFake, useFluidState } from "./helpers/fluid-classic-fake.js";

// ---------------------------------------------------------------------------
// Fake transport — same shape as test/index-create.test.ts
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

/** Allows both the fluid deploy package and ZTM — the superpackage used below. */
const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [FLUID_PACKAGE, "ZTM"],
    allowNamePrefixes: ["*"],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

/** Allows only the fluid tool's own deploy package — the domain gate must refuse first. */
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

/** A root package (no superPackage) — refused under any NAMED allowlist (safety.ts ~line 1527). */
const ROOT_PARAMS: PackageBridgeParams = {
  packageName: "ZTM_ROOTPKG",
  description: "Root package, no parent",
  softwareComponent: "HOME",
  corrNr: "A4HK900123",
};

/** A sub-package — the only shape that reaches all the way through a named gate. */
const SUB_PARAMS: PackageBridgeParams = {
  packageName: "ZTM_TESTPKG",
  description: "Test package",
  softwareComponent: "HOME",
  corrNr: "A4HK900123",
  superPackage: "ZTM",
};

/** The `ZMCP-PKG-TDEVC>` evidence line the generated ABAP writes, built from a row. */
function tdevcLine(row: TdevcRow): string {
  return `${PKG_TDEVC_PREFIX} DEVCLASS=${row.devclass} PARENTCL=${row.parentcl} DLVUNIT=${row.dlvunit} KORRFLAG=${row.korrflag}`;
}

const CREATE_METHOD = packagePart.source.slice(
  packagePart.source.indexOf("METHOD create_package."),
  packagePart.source.indexOf("METHOD delete_package."),
);

// ---------------------------------------------------------------------------
// 1 — transcript vocabulary
// ---------------------------------------------------------------------------

describe("abap-package.ts's create_package transcript vocabulary", () => {
  it("emits exactly PKG-CREATED, PKG-PARENT-SET, PKG-CONFIRMED, in that source order", () => {
    const tags = [...CREATE_METHOD.matchAll(/line\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]!);
    expect(tags).toEqual(["PKG-CREATED", "PKG-PARENT-SET", "PKG-CONFIRMED"]);
  });

  it("PKG-PARENT-SET is compiled in unconditionally but gated at RUNTIME by IF lv_super IS NOT INITIAL", () => {
    const guard = CREATE_METHOD.indexOf("IF lv_super IS NOT INITIAL.");
    const tag = CREATE_METHOD.indexOf("line( 'PKG-PARENT-SET' )");
    const created = CREATE_METHOD.indexOf("line( 'PKG-CREATED' )");
    const confirmed = CREATE_METHOD.indexOf("line( 'PKG-CONFIRMED' )");
    expect(guard).toBeGreaterThan(created);
    expect(tag).toBeGreaterThan(guard);
    expect(confirmed).toBeGreaterThan(tag);
  });

  it("assertDdicTranscript is satisfied by the plain success output, both root and sub-package shapes", () => {
    expect(() =>
      assertDdicTranscript(
        parseDdicTranscript("PKG-CREATED\nPKG-CONFIRMED"),
        ["PKG-CREATED", "PKG-CONFIRMED"],
        "Creating package",
      ),
    ).not.toThrow();
    expect(() =>
      assertDdicTranscript(
        parseDdicTranscript("PKG-CREATED\nPKG-PARENT-SET\nPKG-CONFIRMED"),
        ["PKG-CREATED", "PKG-PARENT-SET", "PKG-CONFIRMED"],
        "Creating package",
      ),
    ).not.toThrow();
  });

  it("the failure branch writes a DDIC_ERR_PREFIX line parseDdicTranscript reads as an error, not a tag", () => {
    const parsed = parseDdicTranscript(`${DDIC_ERR_PREFIX} TDEVC has no row for ZTM_ROOTPKG after create`);
    expect(parsed.tags).toEqual([]);
    expect(parsed.errorLine).toContain("TDEVC has no row");
  });
});

// ---------------------------------------------------------------------------
// 2 — well-formedness — regression guard: every classic-exception call is guarded
// ---------------------------------------------------------------------------

describe("regression guard — every classic-exception CALL METHOD in create_package is EXCEPTIONS-guarded", () => {
  it("every CALL METHOD statement carries an EXCEPTIONS ... OTHERS clause", () => {
    const lines = CREATE_METHOD.split("\n");
    const callIdxs = lines.reduce<number[]>((acc, l, i) => {
      if (l.trim().startsWith("CALL METHOD")) acc.push(i);
      return acc;
    }, []);
    // create_new_package, save, set_changeable(false); then load_package, set_changeable(true),
    // set_super_package_name, save, set_changeable(false) for the (runtime-gated) parent-attach step.
    expect(callIdxs.length).toBe(8);
    for (const start of callIdxs) {
      const end = lines.findIndex((l, i) => i >= start && l.trim().endsWith("."));
      const stmt = lines.slice(start, end + 1).join("\n");
      expect(stmt).toContain("EXCEPTIONS");
      expect(stmt).toContain("OTHERS");
    }
  });

  it("no unguarded functional-call syntax survives for any of the five classic-exception methods", () => {
    for (const call of [
      "cl_package_factory=>create_new_package(",
      "cl_package_factory=>load_package(",
      "lo_package->save(",
      "lo_package->set_changeable(",
      "lo_package->set_super_package_name(",
    ]) {
      expect(CREATE_METHOD).not.toContain(call);
    }
  });

  it('every comment line uses " — never a *-style comment', () => {
    const starComments = CREATE_METHOD.split("\n").filter((l) => l.trim().startsWith("*"));
    expect(starComments).toEqual([]);
    expect(CREATE_METHOD.split("\n").some((l) => l.trim().startsWith('"'))).toBe(true);
  });

  it("is pure ASCII — no em-dash or other non-ASCII character", () => {
    expect(CREATE_METHOD).not.toMatch(/—/);
    expect(/[^\x00-\x7F]/.test(CREATE_METHOD)).toBe(false);
  });

  it("NEVER sets PDEVCLASS, DEVLAYER or SUPERPACKAGE_IN_TDEVC as executable code (comments may still name them)", () => {
    const codeOnly = CREATE_METHOD.split("\n")
      .filter((l) => !l.trim().startsWith('"'))
      .join("\n")
      .toLowerCase();
    expect(codeOnly).not.toContain("pdevclass");
    expect(codeOnly).not.toContain("devlayer");
    expect(codeOnly).not.toContain("superpackage_in_tdevc");
    expect(CREATE_METHOD.toLowerCase()).toContain("pdevclass");
    expect(CREATE_METHOD.toLowerCase()).toContain("superpackage_in_tdevc");
  });
});

// ---------------------------------------------------------------------------
// 3 — corr_nr threading: the CREATE's save carries i_transport_request, the parent-attach save does not
// ---------------------------------------------------------------------------

describe("i_transport_request threading — CREATE's save only, never the parent-attach save", () => {
  it("only ONE lo_package->save call, of the two, carries i_transport_request — the create's", () => {
    const saveCalls = CREATE_METHOD.match(/CALL METHOD lo_package->save\b/g) ?? [];
    expect(saveCalls).toHaveLength(2);
    const transportOccurrences = CREATE_METHOD.match(/i_transport_request/g) ?? [];
    expect(transportOccurrences).toHaveLength(1);
    // it belongs to the FIRST save, before line('PKG-CREATED')
    const transportIdx = CREATE_METHOD.indexOf("i_transport_request");
    const firstTag = CREATE_METHOD.indexOf("line( 'PKG-CREATED' )");
    expect(transportIdx).toBeLessThan(firstTag);
  });

  it("i_transport_request is set to lv_corr_nr, read at runtime via s( 'corr_nr' )", () => {
    expect(CREATE_METHOD).toContain("DATA lv_corr_nr TYPE trkorr.");
    expect(CREATE_METHOD).toContain("lv_corr_nr = s( 'corr_nr' ).");
    expect(CREATE_METHOD).toContain("i_transport_request = lv_corr_nr");
  });

  it("the invoker's JSON payload carries the caller's exact corr_nr, unmangled", async () => {
    const fake = classicFake({
      action: "create_package",
      lines: () => ["PKG-CREATED", "PKG-PARENT-SET", tdevcLine({ devclass: "ZTM_TESTPKG", parentcl: "ZTM", dlvunit: "HOME", korrflag: "X" }), "PKG-CONFIRMED"],
    });
    const { conn } = await connected(fake.route);
    await createPackageViaBridge(conn, allowingGate(), { ...SUB_PARAMS, corrNr: "A4HK900777" });
    const src = fake.sourceOf(fake.invoker()!);
    const payload = [...src!.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join("");
    expect(payload).toBe(
      canonicalArgsJson({
        package_name: "ZTM_TESTPKG",
        description: "Test package",
        software_component: "HOME",
        corr_nr: "A4HK900777",
        super_package: "ZTM",
        package_type: "",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 4 — sub-package second step, present iff superPackage is set (runtime-gated, structural)
// ---------------------------------------------------------------------------

describe("sub-package second step is compiled in unconditionally, runtime-gated by lv_super", () => {
  it("load_package, set_super_package_name and a second save all exist in the static source", () => {
    expect(CREATE_METHOD).toContain("CALL METHOD cl_package_factory=>load_package");
    // lo_package is TYPE REF TO if_package (an INTERFACE reference) — IF_PACKAGE~ prefixing
    // is invalid; A4H rejected it live ("Class IF_PACKAGE does not contain an interface IF_PACKAGE").
    expect(CREATE_METHOD).toContain("CALL METHOD lo_package->set_super_package_name");
    expect(CREATE_METHOD).toContain("i_super_package_name = lv_super");
    expect(CREATE_METHOD).not.toContain("if_package~");
  });

  it("WITH superPackage: the invoker payload's super_package is non-empty and PKG-PARENT-SET is reported", async () => {
    const line = tdevcLine({ devclass: "ZTM_TESTPKG", parentcl: "ZTM", dlvunit: "HOME", korrflag: "X" });
    const fake = classicFake({ action: "create_package", lines: () => ["PKG-CREATED", "PKG-PARENT-SET", line, "PKG-CONFIRMED"] });
    const { conn } = await connected(fake.route);
    const { transcript } = await createPackageViaBridge(conn, allowingGate(), SUB_PARAMS);
    expect(transcript.tags).toContain("PKG-PARENT-SET");
    const src = fake.sourceOf(fake.invoker()!);
    const payload = [...src!.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join("");
    expect(payload).toContain('"super_package":"ZTM"');
  });

  it("WITHOUT superPackage (wildcard gate): the invoker payload's super_package is empty and PKG-PARENT-SET is never reported", async () => {
    const fake = classicFake({ action: "create_package", lines: () => ["PKG-CREATED", "PKG-CONFIRMED"] });
    const { conn } = await connected(fake.route);
    const wideOpen = new SafetyGate({
      readOnly: false,
      allowPackages: [FLUID_PACKAGE, "*"],
      allowNamePrefixes: ["*"],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const { transcript } = await createPackageViaBridge(conn, wideOpen, ROOT_PARAMS);
    expect(transcript.tags).not.toContain("PKG-PARENT-SET");
    const src = fake.sourceOf(fake.invoker()!);
    const payload = [...src!.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join("");
    expect(payload).toContain('"super_package":""');
  });
});

// ---------------------------------------------------------------------------
// 5 — honest gate refusals: zero-network, before any dispatch
// ---------------------------------------------------------------------------

describe("honest gate refusals — the second gate runs, and runs FIRST (zero-network)", () => {
  it("a root package (no superPackage) is refused under a named allowlist — zero requests made", async () => {
    const fake = classicFake({ action: "create_package", lines: () => ["PKG-CREATED", "PKG-CONFIRMED"] });
    const { conn, adt } = await connected(fake.route);
    const err = await catchErr(createPackageViaBridge(conn, allowingGate(), ROOT_PARAMS));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toMatch(/ROOT package/);
    expect(err.message).toContain("ABAP_ALLOW_PACKAGES='*'");
    expect(adt.calls.length).toBe(0);
  });

  it("a root package IS allowed under a wildcard allowlist, and reaches the classic tool", async () => {
    const fake = classicFake({ action: "create_package", lines: () => ["PKG-CREATED", "PKG-CONFIRMED"] });
    const { conn, adt } = await connected(fake.route);
    const wideOpen = new SafetyGate({
      readOnly: false,
      allowPackages: [FLUID_PACKAGE, "*"],
      allowNamePrefixes: ["*"],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const { transcript } = await createPackageViaBridge(conn, wideOpen, ROOT_PARAMS);
    expect(transcript.tags).toEqual(["PKG-CREATED", "PKG-CONFIRMED"]);
    expect(adt.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
  });

  it("a superpackage NOT in the allowlist is refused, zero requests made", async () => {
    const fake = classicFake({ action: "create_package", lines: () => ["PKG-CREATED", "PKG-PARENT-SET", "PKG-CONFIRMED"] });
    const { conn, adt } = await connected(fake.route);
    const err = await catchErr(createPackageViaBridge(conn, bridgeOnlyGate(), SUB_PARAMS));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toMatch(/not in the allowlist/);
    expect(adt.calls.length).toBe(0);
  });

  it("a readOnly gate refuses too, zero requests made", async () => {
    const fake = classicFake({ action: "create_package", lines: () => ["PKG-CREATED", "PKG-PARENT-SET", "PKG-CONFIRMED"] });
    const { conn, adt } = await connected(fake.route);
    const readOnly = new SafetyGate({ readOnly: true, allowPackages: [FLUID_PACKAGE, "ZTM"], writesLockedOut: false });
    const err = await catchErr(createPackageViaBridge(conn, readOnly, SUB_PARAMS));
    expect(err).toBeTruthy();
    expect(adt.calls.length).toBe(0);
  });

  it("transports not allowed: preflightPackageCorr refuses a not-allowlisted corrNr with ZERO network calls", async () => {
    const offline = null as unknown as AbapConnection;
    const transport = new SessionTransport({ allowTransports: ["A4HK900001"] });
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["ZTM"], allowTransports: ["A4HK900001"] });
    const target: PreflightTarget = {
      uri: "/sap/bc/adt/packages/ztm_testpkg",
      name: "ZTM_TESTPKG",
      packageName: "ZTM",
      type: "DEVC/K",
    };
    const err = await catchErr(
      preflightPackageCorr(offline, target, { transport, gate, corrNr: "A4HK900999" }),
    );
    expect(err.code).toBe("TRANSPORT_ERROR");
    expect(err.message).toMatch(/not permitted by ABAP_ALLOW_TRANSPORTS/);
  });

  it("does NOT assert `activate` on the package — a package create has no activation step", async () => {
    // Two independent gates fire on the package object itself: the domain gate
    // (assertBridgeMutation, target carries type: "DEVC/K") and the fluid
    // dispatcher's own generic `targets`-declared gate (assertTargetsAgainstGate
    // in dispatch.ts, target carries no `type` at all — it only resolves
    // name/package from the manifest's JSON pointers). Both are "write";
    // neither is "activate" — a package create has no activation step.
    const seen: string[] = [];
    class RecordingGate extends SafetyGate {
      override assert(op: Operation, obj?: SafetyTarget, opts?: EvaluateOptions): void {
        if (obj?.name === "ZTM_TESTPKG") seen.push(op);
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
    const line = tdevcLine({ devclass: "ZTM_TESTPKG", parentcl: "ZTM", dlvunit: "HOME", korrflag: "X" });
    const fake = classicFake({ action: "create_package", lines: () => ["PKG-CREATED", "PKG-PARENT-SET", line, "PKG-CONFIRMED"] });
    const { conn } = await connected(fake.route);
    await createPackageViaBridge(conn, gate, SUB_PARAMS);
    expect(seen).toEqual(["write", "write"]);
  });
});

// ---------------------------------------------------------------------------
// 5b — the real corrNr — not a fabricated "auto" — reaches the domain gate
// ---------------------------------------------------------------------------

describe("the real corrNr reaches the domain gate, with the caller's actual corrSource", () => {
  it("a caller-named corr_nr reaches the gate as that exact request, with source: 'named'", async () => {
    const seenOpts: EvaluateOptions[] = [];
    class RecordingGate extends SafetyGate {
      override assert(op: Operation, obj?: SafetyTarget, opts: EvaluateOptions = {}): void {
        if (obj?.type === "DEVC/K" && obj.name === "ZTM_TESTPKG") seenOpts.push(opts);
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
    const line = tdevcLine({ devclass: "ZTM_TESTPKG", parentcl: "ZTM", dlvunit: "HOME", korrflag: "X" });
    const fake = classicFake({ action: "create_package", lines: () => ["PKG-CREATED", "PKG-PARENT-SET", line, "PKG-CONFIRMED"] });
    const { conn } = await connected(fake.route);
    await createPackageViaBridge(conn, gate, { ...SUB_PARAMS, corrNr: "A4HK900555", corrSource: "named" });
    expect(seenOpts).toHaveLength(1);
    expect(seenOpts[0]?.corr).toEqual({ kind: "transport", corrNr: "A4HK900555", source: "named" });
  });

  it("a refusal names the real request, never a fabricated 'auto'", async () => {
    const fake = classicFake({ action: "create_package", lines: () => ["PKG-CREATED", "PKG-PARENT-SET", "PKG-CONFIRMED"] });
    const { conn, adt } = await connected(fake.route);
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: [FLUID_PACKAGE, "ZTM"],
      allowTransports: ["A4HK900001"],
      writesLockedOut: false,
    });
    const err = await catchErr(
      createPackageViaBridge(conn, gate, { ...SUB_PARAMS, corrNr: "A4HK900224", corrSource: "named" }),
    );
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toContain("Transport A4HK900224 is not permitted by ABAP_ALLOW_TRANSPORTS");
    expect(err.message).not.toMatch(/Transport auto/);
    expect(adt.calls.length).toBe(0);
  });

  it("a caller-named corr_nr matching a named-only allowlist is honoured (live incident)", async () => {
    const line = tdevcLine({ devclass: "ZTM_TESTPKG", parentcl: "ZTM", dlvunit: "HOME", korrflag: "X" });
    const fake = classicFake({ action: "create_package", lines: () => ["PKG-CREATED", "PKG-PARENT-SET", line, "PKG-CONFIRMED"] });
    const { conn } = await connected(fake.route);
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: [FLUID_PACKAGE, "ZTM"],
      allowNamePrefixes: ["*"],
      allowTransports: ["A4HK900224"],
      writesLockedOut: false,
    });
    const { transcript } = await createPackageViaBridge(conn, gate, {
      ...SUB_PARAMS,
      corrNr: "A4HK900224",
      corrSource: "named",
    });
    expect(transcript.tags).toContain("PKG-CONFIRMED");
  });
});

// ---------------------------------------------------------------------------
// 6 — input validation refused before any network call
// ---------------------------------------------------------------------------

describe("input validation is refused before any network call", () => {
  const offline = null as unknown as AbapConnection;

  it("a package name longer than 30 characters is refused, never truncated", async () => {
    const tooLong = `Z${"A".repeat(30)}`;
    const err = await catchErr(createPackageViaBridge(offline, allowingGate(), { ...SUB_PARAMS, packageName: tooLong }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("30");
  });

  it("a description longer than 60 characters is refused, never truncated", async () => {
    const tooLong = "X".repeat(61);
    const err = await catchErr(createPackageViaBridge(offline, allowingGate(), { ...SUB_PARAMS, description: tooLong }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("60");
  });

  it('software_component="LOCAL" is refused — points the caller at ADT REST instead', async () => {
    const err = await catchErr(createPackageViaBridge(offline, allowingGate(), { ...SUB_PARAMS, softwareComponent: "LOCAL" }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.hint).toMatch(/ADT REST/);
  });

  it("a malformed corr_nr is refused, and the message names corr_nr", async () => {
    const err = await catchErr(createPackageViaBridge(offline, allowingGate(), { ...SUB_PARAMS, corrNr: "not-a-trkorr" }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("corr_nr");
  });

  it("an unsupported package_type is refused, and the message names package_type", async () => {
    const err = await catchErr(createPackageViaBridge(offline, allowingGate(), { ...SUB_PARAMS, packageType: "structure" }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("package_type");
  });
});

// ---------------------------------------------------------------------------
// 7 — parseTdevcLine / tdevcDiscrepancies (pure functions, unchanged by the rewire)
// ---------------------------------------------------------------------------

describe("parseTdevcLine", () => {
  it("parses a well-formed line, including a blank PARENTCL (root package)", () => {
    const raw = `${PKG_TDEVC_PREFIX} DEVCLASS=ZTM_ROOTPKG PARENTCL= DLVUNIT=HOME KORRFLAG=X`;
    expect(parseTdevcLine(raw)).toEqual({ devclass: "ZTM_ROOTPKG", parentcl: "", dlvunit: "HOME", korrflag: "X" });
  });

  it("returns undefined when the evidence line is missing entirely", () => {
    expect(parseTdevcLine("PKG-CREATED\nPKG-CONFIRMED")).toBeUndefined();
  });

  it("returns undefined for a malformed line (a KEY=VALUE pair missing)", () => {
    const raw = `${PKG_TDEVC_PREFIX} DEVCLASS=ZTM_TESTPKG PARENTCL=ZTM DLVUNIT=HOME`;
    expect(parseTdevcLine(raw)).toBeUndefined();
  });
});

describe("tdevcDiscrepancies", () => {
  const matching: TdevcRow = { devclass: "ZTM_TESTPKG", parentcl: "ZTM", dlvunit: "HOME", korrflag: "X" };

  it("is empty when the row matches exactly what was requested (sub-package)", () => {
    expect(tdevcDiscrepancies(matching, { softwareComponent: "HOME", superPackage: "ZTM" })).toEqual([]);
  });

  it("is empty for a matching root package (no superPackage expected, PARENTCL blank)", () => {
    const root: TdevcRow = { devclass: "ZTM_ROOTPKG", parentcl: "", dlvunit: "HOME", korrflag: "X" };
    expect(tdevcDiscrepancies(root, { softwareComponent: "HOME" })).toEqual([]);
  });

  it("names a DLVUNIT mismatch", () => {
    const notes = tdevcDiscrepancies({ ...matching, dlvunit: "OTHER" }, { softwareComponent: "HOME", superPackage: "ZTM" });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/DLVUNIT/);
  });

  it("names a KORRFLAG mismatch", () => {
    const notes = tdevcDiscrepancies({ ...matching, korrflag: "" }, { softwareComponent: "HOME", superPackage: "ZTM" });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/KORRFLAG/);
  });

  it("names a PARENTCL mismatch", () => {
    const notes = tdevcDiscrepancies({ ...matching, parentcl: "ZOTHER" }, { softwareComponent: "HOME", superPackage: "ZTM" });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/PARENTCL/);
  });

  it("adds a 'no evidence line' note when the row is undefined — and never throws", () => {
    expect(() => tdevcDiscrepancies(undefined, { softwareComponent: "HOME" })).not.toThrow();
    const notes = tdevcDiscrepancies(undefined, { softwareComponent: "HOME", superPackage: "ZTM" });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/no.*evidence line/i);
  });

  it("reports multiple discrepancies at once, not just the first", () => {
    const notes = tdevcDiscrepancies(
      { devclass: "ZTM_TESTPKG", parentcl: "ZOTHER", dlvunit: "OTHER", korrflag: "" },
      { softwareComponent: "HOME", superPackage: "ZTM" },
    );
    expect(notes).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 8 — a failing transcript is a failure
// ---------------------------------------------------------------------------

describe("a failing transcript is a failure", () => {
  it("empty classrun output throws CHECK_FAILED", async () => {
    const fake = classicFake({ action: "create_package", lines: () => [] });
    const { conn } = await connected(fake.route);
    const err = await catchErr(createPackageViaBridge(conn, allowingGate(), SUB_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
  });

  it("a ZMCP-DDIC-ERR> line throws CHECK_FAILED, quoting the server's own text", async () => {
    const fake = classicFake({ action: "create_package", lines: () => [`${DDIC_ERR_PREFIX} TDEVC has no row for ZTM_TESTPKG after create`] });
    const { conn } = await connected(fake.route);
    const err = await catchErr(createPackageViaBridge(conn, allowingGate(), SUB_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("TDEVC has no row");
  });

  it("superPackage was requested, but PKG-PARENT-SET never arrived: CHECK_FAILED, not silent success", async () => {
    const line = tdevcLine({ devclass: "ZTM_TESTPKG", parentcl: "", dlvunit: "HOME", korrflag: "X" });
    const fake = classicFake({ action: "create_package", lines: () => ["PKG-CREATED", line, "PKG-CONFIRMED"] });
    const { conn } = await connected(fake.route);
    const err = await catchErr(createPackageViaBridge(conn, allowingGate(), SUB_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toMatch(/PKG-PARENT-SET/);
  });

  it("output carrying some OTHER tag only is not success either", async () => {
    const fake = classicFake({ action: "create_package", lines: () => ["VIEW-PUT"] });
    const { conn } = await connected(fake.route);
    const err = await catchErr(createPackageViaBridge(conn, allowingGate(), SUB_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
  });
});

// ---------------------------------------------------------------------------
// 9 — partial success: PKG-CREATED fires, then a later step fails
// ---------------------------------------------------------------------------

describe("partial success — PKG-CREATED fires, then attaching the super package fails (live incident)", () => {
  it("reports the failure AND that the package already exists on the server, instructs against a blind retry", async () => {
    const fake = classicFake({
      action: "create_package",
      lines: () => ["PKG-CREATED", `${DDIC_ERR_PREFIX} Attaching super package failed, sy-subrc=1, 465`],
    });
    const { conn } = await connected(fake.route);
    const err = await catchErr(createPackageViaBridge(conn, allowingGate(), SUB_PARAMS));

    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toBe(
      "Creating package ZTM_TESTPKG failed on the server: Attaching super package failed, sy-subrc=1, 465. " +
        "PARTIAL SUCCESS, NOT A NO-OP: this is a multi-step operation and earlier steps already took " +
        "effect on the server and were NOT rolled back — package ZTM_TESTPKG was created and saved on " +
        "TST — it exists, it is NOT attached to a super package, and abapsmith did not delete it.",
    );
    expect(err.details.partial).toBe(true);
    expect(err.details.completed).toEqual(["PKG-CREATED"]);
    expect(err.hint).toContain("abap_transport operation=list");
  });

  it("no PARTIAL SUCCESS wording when the very first step (create) itself fails — nothing took effect", async () => {
    const fake = classicFake({ action: "create_package", lines: () => [`${DDIC_ERR_PREFIX} Creating package failed, sy-subrc=1, 165`] });
    const { conn } = await connected(fake.route);
    const err = await catchErr(createPackageViaBridge(conn, allowingGate(), SUB_PARAMS));

    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toBe("Creating package ZTM_TESTPKG failed on the server: Creating package failed, sy-subrc=1, 165");
    expect(err.details.partial).toBeUndefined();
    expect(err.hint).toBeUndefined();
  });

  it("names the super package attach too when it succeeded but the TDEVC re-read then fails", async () => {
    const fake = classicFake({
      action: "create_package",
      lines: () => ["PKG-CREATED", "PKG-PARENT-SET", `${DDIC_ERR_PREFIX} TDEVC has no row for ZTM_TESTPKG after create`],
    });
    const { conn } = await connected(fake.route);
    const err = await catchErr(createPackageViaBridge(conn, allowingGate(), SUB_PARAMS));

    expect(err.details.completed).toEqual(["PKG-CREATED", "PKG-PARENT-SET"]);
    expect(err.message).toContain("package ZTM_TESTPKG was created and saved on TST");
    expect(err.message).toContain("was then attached to super package ZTM and saved on TST");
  });
});

// ---------------------------------------------------------------------------
// 10 — happy path
// ---------------------------------------------------------------------------

describe("createPackageViaBridge happy path", () => {
  it("deploys, runs the classic tool; reports PKG-CREATED, PKG-PARENT-SET, PKG-CONFIRMED and parses the TDEVC row", async () => {
    const line = tdevcLine({ devclass: "ZTM_TESTPKG", parentcl: "ZTM", dlvunit: "HOME", korrflag: "X" });
    const fake = classicFake({ action: "create_package", lines: () => ["PKG-CREATED", "PKG-PARENT-SET", line, "PKG-CONFIRMED"] });
    const { conn, adt } = await connected(fake.route);

    const { transcript, run, tdevc } = await createPackageViaBridge(conn, allowingGate(), SUB_PARAMS);
    expect(transcript.tags).toEqual(["PKG-CREATED", "PKG-PARENT-SET", "PKG-CONFIRMED"]);
    expect(transcript.errorLine).toBeUndefined();
    expect(run.output).toContain("PKG-CONFIRMED");
    expect(tdevc).toEqual({ devclass: "ZTM_TESTPKG", parentcl: "ZTM", dlvunit: "HOME", korrflag: "X" });
    expect(tdevcDiscrepancies(tdevc, { softwareComponent: "HOME", superPackage: "ZTM" })).toEqual([]);

    const methods = adt.calls.map((c) => (c.method ?? "GET").toUpperCase());
    expect(methods).toContain("PUT");
    expect(adt.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
  });

  it("an identical repeat call issues no second invoker PUT", async () => {
    const line = tdevcLine({ devclass: "ZTM_TESTPKG", parentcl: "ZTM", dlvunit: "HOME", korrflag: "X" });
    const fake = classicFake({ action: "create_package", lines: () => ["PKG-CREATED", "PKG-PARENT-SET", line, "PKG-CONFIRMED"] });
    const { conn, adt } = await connected(fake.route);
    await createPackageViaBridge(conn, allowingGate(), SUB_PARAMS);
    const before = adt.calls.length;
    await createPackageViaBridge(conn, allowingGate(), SUB_PARAMS);
    const putsAfterSecond = adt.calls.slice(before).filter((c) => (c.method ?? "").toUpperCase() === "PUT");
    expect(putsAfterSecond).toEqual([]);
  });
});
