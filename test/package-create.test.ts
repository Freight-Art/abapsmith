/**
 * `DEVC/K` (package) create bridge — offline; transport faked via
 * `ConnectionOptions.httpClient`, reusing `test/tran-create.test.ts`'s
 * `RecordingClient`/`resp`/`connected`/`objectHappyPath` harness. Per
 * `src/safety.ts` (~line 1403-1437), a ROOT package create (no
 * `superPackage`) is refused unless the allowlist has the literal wildcard
 * `*` — so the bridge is driven end to end either with `superPackage` set,
 * or root under `allowPackages: ["*"]`; "no superPackage" ABAP-shape checks
 * live at `packageFragment()` instead.
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
  PACKAGE_DATA_LINES,
  PKG_TDEVC_PREFIX,
  createPackageViaBridge,
  packageFragment,
  parseTdevcLine,
  tdevcDiscrepancies,
  type PackageBridgeParams,
  type TdevcRow,
} from "../src/adt/package-create.js";
import { preflightPackageCorr, type PreflightTarget } from "../src/adt/write.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Fake transport — same shape as test/tran-create.test.ts
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
const BRIDGE = DDIC_BRIDGE_CLASS.createPackage;
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
 * A bare classrun body — a classrun class's `out->write('TAG')` output is the
 * whole line, unprefixed. No `LIST> ` prefix here; that belongs to run.ts's
 * report bridge.
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

/** The `ZMCP-PKG-TDEVC>` evidence line the generated ABAP writes, built from a row. */
function tdevcLine(row: TdevcRow): string {
  return `${PKG_TDEVC_PREFIX} DEVCLASS=${row.devclass} PARENTCL=${row.parentcl} DLVUNIT=${row.dlvunit} KORRFLAG=${row.korrflag}`;
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/** Allows BOTH the bridge class ($TMP) and the new package's superpackage (ZTM). */
const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [DDIC_BRIDGE_PACKAGE, "ZTM"],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

/**
 * Allows the bridge class in `$TMP` and nothing else, so only the domain
 * gate `createPackageViaBridge` runs itself can refuse a `DEVC/K` in
 * superpackage `ZTM` — `deployBridge`'s own checks pass under it.
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

/** A root package (no superPackage) — see the file header: this is refused by
 * the gate under any NAMED allowlist, so most uses below stay at the
 * `packageFragment()` level; it also reaches all the way through the bridge
 * under an `allowPackages: ["*"]` gate, which is exercised explicitly. */
const ROOT_PARAMS: PackageBridgeParams = {
  packageName: "ZTM_ROOTPKG",
  description: "Root package, no parent",
  softwareComponent: "HOME",
  corrNr: "A4HK900123",
};

/** A sub-package — the only shape that reaches all the way through the gate. */
const SUB_PARAMS: PackageBridgeParams = {
  packageName: "ZTM_TESTPKG",
  description: "Test package",
  softwareComponent: "HOME",
  corrNr: "A4HK900123",
  superPackage: "ZTM",
};

const sourceFor = (p: PackageBridgeParams): string =>
  ddicBridgeSource(BRIDGE, PACKAGE_DATA_LINES, packageFragment(p));

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
  it("root package (no superPackage): emits PKG-CREATED, PKG-CONFIRMED only", () => {
    const tags = emittedTags(packageFragment(ROOT_PARAMS));
    expect(tags).toEqual(["PKG-CREATED", "PKG-CONFIRMED"]);
    const parsed = parseDdicTranscript(tags.join("\n"));
    expect(new Set(parsed.tags)).toEqual(new Set(tags));
    expect(parsed.errorLine).toBeUndefined();
  });

  it("sub-package (superPackage set): emits PKG-CREATED, PKG-PARENT-SET, PKG-CONFIRMED, in that order", () => {
    const tags = emittedTags(packageFragment(SUB_PARAMS));
    expect(tags).toEqual(["PKG-CREATED", "PKG-PARENT-SET", "PKG-CONFIRMED"]);
  });

  it("assertDdicTranscript is satisfied by the fragment's own success output, both shapes", () => {
    expect(() =>
      assertDdicTranscript(
        parseDdicTranscript(emittedTags(packageFragment(ROOT_PARAMS)).join("\n")),
        ["PKG-CREATED", "PKG-CONFIRMED"],
        "Creating package",
      ),
    ).not.toThrow();
    expect(() =>
      assertDdicTranscript(
        parseDdicTranscript(emittedTags(packageFragment(SUB_PARAMS)).join("\n")),
        ["PKG-CREATED", "PKG-PARENT-SET", "PKG-CONFIRMED"],
        "Creating package",
      ),
    ).not.toThrow();
  });

  it("the failure branch writes a DDIC_ERR_PREFIX line parseDdicTranscript reads as an error, not a tag", () => {
    const errLine = packageFragment(ROOT_PARAMS).find((l) => l.includes(DDIC_ERR_PREFIX));
    expect(errLine).toBeTruthy();
    const parsed = parseDdicTranscript(`${DDIC_ERR_PREFIX} TDEVC has no row for ZTM_ROOTPKG after create`);
    expect(parsed.tags).toEqual([]);
    expect(parsed.errorLine).toContain("TDEVC has no row");
  });
});

// ---------------------------------------------------------------------------
// well-formedness — regression guards on the closed template
// ---------------------------------------------------------------------------

describe("generated ABAP is well-formed (closed template — regression guards)", () => {
  it("sets ls_data-devclass/ctext/dlvunit/korrflag='X'/packtype='D' and calls cl_package_factory=>create_new_package", () => {
    const src = packageFragment(SUB_PARAMS).join("\n");
    expect(src).toContain("ls_data-devclass = 'ZTM_TESTPKG'.");
    expect(src).toContain("ls_data-ctext    = 'Test package'.");
    expect(src).toContain("ls_data-dlvunit  = 'HOME'.");
    expect(src).toContain("ls_data-korrflag = 'X'.");
    expect(src).toContain("ls_data-packtype = 'D'.");
    expect(src).toContain("CALL METHOD cl_package_factory=>create_new_package");
  });

  /**
   * The fragment's own comments legitimately name PDEVCLASS and
   * SUPERPACKAGE_IN_TDEVC to explain why they're unset, so the guard strips
   * lines starting with `"` (this module's comment marker) before checking.
   */
  it("NEVER sets PDEVCLASS, DEVLAYER or SUPERPACKAGE_IN_TDEVC as executable code", () => {
    for (const params of [ROOT_PARAMS, SUB_PARAMS]) {
      const codeOnly = packageFragment(params)
        .filter((line) => !line.trim().startsWith('"'))
        .join("\n")
        .toLowerCase();
      expect(codeOnly).not.toContain("pdevclass");
      expect(codeOnly).not.toContain("devlayer");
      expect(codeOnly).not.toContain("superpackage_in_tdevc");
    }
    // Confirms the filter is doing real work: the comments DO name these
    // words, so the pass above isn't vacuous.
    const withComments = packageFragment(SUB_PARAMS).join("\n").toLowerCase();
    expect(withComments).toContain("pdevclass");
    expect(withComments).toContain("superpackage_in_tdevc");
  });

  it('every comment line in the fragment uses " — never a *-style comment', () => {
    for (const params of [ROOT_PARAMS, SUB_PARAMS]) {
      const starComments = packageFragment(params).filter((l) => l.trim().startsWith("*"));
      expect(starComments).toEqual([]);
      // And there genuinely ARE comment lines to check — this isn't vacuous.
      expect(packageFragment(params).some((l) => l.trim().startsWith('"'))).toBe(true);
    }
  });

  it("is pure ASCII — no em-dash or other non-ASCII character", () => {
    for (const params of [ROOT_PARAMS, SUB_PARAMS]) {
      const src = packageFragment(params).join("\n");
      expect(src).not.toMatch(/—/);
      expect(/[^\x00-\x7F]/.test(src)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 1b — regression guard: every classic-exception call is guarded
// ---------------------------------------------------------------------------

describe("regression guard — every classic-exception call in packageFragment is CALL METHOD ... EXCEPTIONS-guarded", () => {
  it("every CALL METHOD statement carries an EXCEPTIONS ... OTHERS clause", () => {
    for (const params of [ROOT_PARAMS, SUB_PARAMS]) {
      const lines = packageFragment(params);
      const callIdxs = lines.reduce<number[]>((acc, l, i) => {
        if (l.trim().startsWith("CALL METHOD")) acc.push(i);
        return acc;
      }, []);
      expect(callIdxs.length).toBeGreaterThan(0);
      for (const start of callIdxs) {
        const end = lines.findIndex((l, i) => i >= start && l.trim().endsWith("."));
        const stmt = lines.slice(start, end + 1).join("\n");
        expect(stmt).toContain("EXCEPTIONS");
        expect(stmt).toContain("OTHERS");
      }
    }
  });

  it("no unguarded functional-call syntax survives for any of the six classic-exception methods", () => {
    for (const params of [ROOT_PARAMS, SUB_PARAMS]) {
      const src = packageFragment(params).join("\n");
      for (const call of [
        "cl_package_factory=>create_new_package(",
        "cl_package_factory=>load_package(",
        "lo_package->save(",
        "lo_package->set_changeable(",
        "lo_package->set_super_package_name(",
      ]) {
        expect(src).not.toContain(call);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2 — corr_nr threading
// ---------------------------------------------------------------------------

describe("corr_nr reaches save( i_transport_request = ... ) verbatim", () => {
  it("a given corrNr appears verbatim in the create's save call", () => {
    const src = packageFragment({ ...ROOT_PARAMS, corrNr: "A4HK900777" }).join("\n");
    expect(src).toContain("CALL METHOD lo_package->save");
    expect(src).toContain("i_transport_request = 'A4HK900777'");
  });

  it("a different corrNr produces a different save call — the value is threaded through, not hardcoded", () => {
    const a = packageFragment({ ...ROOT_PARAMS, corrNr: "A4HK900111" }).join("\n");
    const b = packageFragment({ ...ROOT_PARAMS, corrNr: "A4HK900222" }).join("\n");
    expect(a).toContain("i_transport_request = 'A4HK900111'");
    expect(b).toContain("i_transport_request = 'A4HK900222'");
    expect(a).not.toContain("A4HK900222");
    expect(b).not.toContain("A4HK900111");
  });

  it("only the CREATE's save carries i_transport_request — the parent-attach save does not", () => {
    const src = packageFragment(SUB_PARAMS).join("\n");
    const saveCalls = src.match(/CALL METHOD lo_package->save\b/g) ?? [];
    expect(saveCalls).toHaveLength(2);
    // Exactly one i_transport_request in the whole fragment, and it's the
    // CREATE's save — the parent-attach save is a bare CALL METHOD with no
    // EXPORTING at all.
    const transportOccurrences = src.match(/i_transport_request/g) ?? [];
    expect(transportOccurrences).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3 — sub-package second step, present iff superPackage is set
// ---------------------------------------------------------------------------

describe("sub-package second step fires only when superPackage is set", () => {
  it("WITH superPackage: load_package, set_super_package_name, a second save, and PKG-PARENT-SET all appear", () => {
    const lines = packageFragment(SUB_PARAMS);
    const src = lines.join("\n");
    expect(src).toContain("CALL METHOD cl_package_factory=>load_package");
    // Character-for-character: `lo_package` is `TYPE REF TO if_package` (an
    // INTERFACE reference), so `IF_PACKAGE~` prefixing this call is invalid —
    // A4H rejected it at activation ("Class IF_PACKAGE does not contain an
    // interface IF_PACKAGE"). Every other call on lo_package (save,
    // set_changeable) already omits the prefix; this pins the same shape.
    expect(src).toContain("CALL METHOD lo_package->set_super_package_name");
    expect(src).toContain("i_super_package_name = 'ZTM'");
    expect(src).not.toContain("if_package~");
    expect(src.match(/CALL METHOD lo_package->save\b/g)).toHaveLength(2);
    expect(emittedTags(lines)).toContain("PKG-PARENT-SET");
  });

  it("WITHOUT superPackage: none of load_package / set_super_package_name / a second save / PKG-PARENT-SET appear ANYWHERE", () => {
    const lines = packageFragment(ROOT_PARAMS);
    const src = lines.join("\n");
    expect(src).not.toContain("load_package");
    expect(src).not.toContain("set_super_package_name");
    expect(src.match(/CALL METHOD lo_package->save\b/g)).toHaveLength(1);
    expect(src).not.toContain("PKG-PARENT-SET");
    expect(emittedTags(lines)).not.toContain("PKG-PARENT-SET");
  });
});

// ---------------------------------------------------------------------------
// 4 — honest gate refusals: zero-network, before any ABAP is generated
// ---------------------------------------------------------------------------

describe("honest gate refusals — the second gate runs, and runs FIRST (zero-network)", () => {
  /**
   * `allowingGate()` here is the same gate the sub-package tests use and
   * would match `ZTM` fine as a superpackage — so this refusal is genuinely
   * about rootness (src/safety.ts, ~line 1437), not an unmatched container.
   */
  it("a root package (no superPackage) is refused under a named allowlist — zero requests made", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["PKG-CREATED", "PKG-CONFIRMED"])),
    );
    const { conn, inner } = await connected(route);
    const err = await catchErr(createPackageViaBridge(conn, allowingGate(), ROOT_PARAMS));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toMatch(/ROOT package/);
    expect(err.message).toContain("ABAP_ALLOW_PACKAGES='*'");
    expect(inner.calls.length).toBe(0);
  });

  /**
   * The relaxation: a literal wildcard `*` entry means "any container,
   * including none, is fine" — unlike the refusal above, this reaches the
   * bridge for real, though still entirely offline against `sap.invalid`.
   */
  it("a root package (no superPackage) IS allowed under a wildcard allowlist, and reaches the bridge", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["PKG-CREATED", "PKG-CONFIRMED"])),
    );
    const { conn, inner } = await connected(route);
    const wideOpen = new SafetyGate({
      readOnly: false,
      allowPackages: ["*"],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const { transcript } = await createPackageViaBridge(conn, wideOpen, ROOT_PARAMS);
    expect(transcript.tags).toEqual(["PKG-CREATED", "PKG-CONFIRMED"]);
    expect(transcript.tags).not.toContain("PKG-PARENT-SET");
    expect(transcript.errorLine).toBeUndefined();
    expect(inner.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
  });

  it("a superpackage NOT in the allowlist is refused, zero requests made", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["PKG-CREATED", "PKG-PARENT-SET", "PKG-CONFIRMED"])),
    );
    const { conn, inner } = await connected(route);
    const err = await catchErr(createPackageViaBridge(conn, bridgeOnlyGate(), SUB_PARAMS));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toMatch(/not in the allowlist/);
    // Ordering, not just the throw: the bridge-class deploy would have been
    // ALLOWED under this gate ($TMP is in its allowlist), so any request at
    // all here means the domain gate ran too late — or not at all.
    expect(inner.calls.length).toBe(0);
    expect(inner.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(false);
  });

  it("a readOnly gate (ABAP_MODE below edit) refuses too, zero requests made", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["PKG-CREATED", "PKG-PARENT-SET", "PKG-CONFIRMED"])),
    );
    const { conn, inner } = await connected(route);
    const readOnly = new SafetyGate({
      readOnly: true,
      allowPackages: [DDIC_BRIDGE_PACKAGE, "ZTM"],
      writesLockedOut: false,
    });
    const err = await catchErr(createPackageViaBridge(conn, readOnly, SUB_PARAMS));
    expect(err).toBeTruthy();
    expect(inner.calls.length).toBe(0);
  });

  /**
   * `createPackageViaBridge` only re-validates corrNr FORMAT; the allowlist
   * judgement lives one layer up in `preflightPackageCorr`, called by
   * `abapCreatePackage`. Its step-5 `#callerMayName` check runs synchronously
   * before touching `conn` (passed `null` here to prove it never does).
   */
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
    const seen: string[] = [];
    class RecordingGate extends SafetyGate {
      override assert(
        op: Parameters<SafetyGate["assert"]>[0],
        obj?: Parameters<SafetyGate["assert"]>[1],
        opts?: Parameters<SafetyGate["assert"]>[2],
      ): void {
        if (obj?.type === "DEVC/K") seen.push(op);
        super.assert(op, obj, opts);
      }
    }
    const gate = new RecordingGate({
      readOnly: false,
      allowPackages: [DDIC_BRIDGE_PACKAGE, "ZTM"],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const line = tdevcLine({ devclass: "ZTM_TESTPKG", parentcl: "ZTM", dlvunit: "HOME", korrflag: "X" });
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["PKG-CREATED", "PKG-PARENT-SET", line, "PKG-CONFIRMED"])),
    );
    const { conn } = await connected(route);
    await createPackageViaBridge(conn, gate, SUB_PARAMS);
    expect(seen).toEqual(["write"]);
  });
});

// ---------------------------------------------------------------------------
// 4b — the real transport reaches the second gate: EvaluateOptions
// used to be passed empty, so safety.ts synthesised a literal "auto" transport
// nobody named. See src/adt/ddic-bridge.ts's assertBridgeMutation `corr` param.
// ---------------------------------------------------------------------------

describe("the real corrNr — not a fabricated 'auto' — reaches the domain gate", () => {
  it("a caller-named corr_nr reaches the gate as that exact request, with source: 'named'", async () => {
    const seenOpts: Array<Parameters<SafetyGate["assert"]>[2]> = [];
    class RecordingGate extends SafetyGate {
      override assert(
        op: Parameters<SafetyGate["assert"]>[0],
        obj?: Parameters<SafetyGate["assert"]>[1],
        opts?: Parameters<SafetyGate["assert"]>[2],
      ): void {
        if (obj?.type === "DEVC/K") seenOpts.push(opts);
        super.assert(op, obj, opts);
      }
    }
    const gate = new RecordingGate({
      readOnly: false,
      allowPackages: [DDIC_BRIDGE_PACKAGE, "ZTM"],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const line = tdevcLine({ devclass: "ZTM_TESTPKG", parentcl: "ZTM", dlvunit: "HOME", korrflag: "X" });
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["PKG-CREATED", "PKG-PARENT-SET", line, "PKG-CONFIRMED"])),
    );
    const { conn } = await connected(route);
    await createPackageViaBridge(conn, gate, { ...SUB_PARAMS, corrNr: "A4HK900555", corrSource: "named" });
    expect(seenOpts).toHaveLength(1);
    expect(seenOpts[0]?.corr).toEqual({ kind: "transport", corrNr: "A4HK900555", source: "named" });
  });

  it("a refusal names the real request, never the literal 'auto' EvaluateOptions would otherwise synthesise", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["PKG-CREATED", "PKG-PARENT-SET", "PKG-CONFIRMED"])),
    );
    const { conn, inner } = await connected(route);
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: [DDIC_BRIDGE_PACKAGE, "ZTM"],
      // Named allowlist containing neither the literal "auto" nor the corrNr below.
      allowTransports: ["A4HK900001"],
      writesLockedOut: false,
    });
    const err = await catchErr(
      createPackageViaBridge(conn, gate, { ...SUB_PARAMS, corrNr: "A4HK900224", corrSource: "named" }),
    );
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toContain("Transport A4HK900224 is not permitted by ABAP_ALLOW_TRANSPORTS");
    expect(err.message).not.toMatch(/Transport auto/);
    expect(inner.calls.length).toBe(0);
  });

  /**
   * Reproduces the exact live incident: the caller named `corr_nr` and
   * `ABAP_ALLOW_TRANSPORTS` contained exactly that request — yet, before this
   * fix, `assertBridgeMutation` passed no `EvaluateOptions` at all, so
   * `safety.ts` synthesised `corrNr: "auto"` and refused a request the
   * allowlist actually permitted. A tester could only get past this with
   * `ABAP_ALLOW_TRANSPORTS='auto,A4HK900224'` — a workaround, not a fix.
   */
  it("a caller-named corr_nr matching a named-only allowlist is honoured (live incident)", async () => {
    const line = tdevcLine({ devclass: "ZTM_TESTPKG", parentcl: "ZTM", dlvunit: "HOME", korrflag: "X" });
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["PKG-CREATED", "PKG-PARENT-SET", line, "PKG-CONFIRMED"])),
    );
    const { conn } = await connected(route);
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: [DDIC_BRIDGE_PACKAGE, "ZTM"],
      allowTransports: ["A4HK900224"], // no literal "auto" entry
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
// 5 — input validation refused before any network call
// ---------------------------------------------------------------------------

describe("input validation is refused before any network call", () => {
  const offline = null as unknown as AbapConnection;

  it("a package name longer than 30 characters is refused, never truncated", async () => {
    const tooLong = `Z${"A".repeat(30)}`; // 31 characters
    const err = await catchErr(
      createPackageViaBridge(offline, allowingGate(), { ...SUB_PARAMS, packageName: tooLong }),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("30");
    expect(() => packageFragment({ ...SUB_PARAMS, packageName: tooLong })).toThrow();
  });

  it("a description longer than 60 characters is refused, never truncated", async () => {
    const tooLong = "X".repeat(61);
    const err = await catchErr(
      createPackageViaBridge(offline, allowingGate(), { ...SUB_PARAMS, description: tooLong }),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("60");
    expect(() => packageFragment({ ...SUB_PARAMS, description: tooLong })).toThrow();
  });

  it('software_component="LOCAL" is refused by this bridge — points the caller at ADT REST instead', async () => {
    const err = await catchErr(
      createPackageViaBridge(offline, allowingGate(), { ...SUB_PARAMS, softwareComponent: "LOCAL" }),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.hint).toMatch(/ADT REST/);
  });

  it("a malformed corr_nr is refused, and the message names corr_nr", async () => {
    const err = await catchErr(
      createPackageViaBridge(offline, allowingGate(), { ...SUB_PARAMS, corrNr: "not-a-trkorr" }),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("corr_nr");
  });

  it("an unsupported package_type is refused, and the message names package_type", async () => {
    const err = await catchErr(
      createPackageViaBridge(offline, allowingGate(), { ...SUB_PARAMS, packageType: "structure" }),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("package_type");
  });
});

// ---------------------------------------------------------------------------
// 6 — parseTdevcLine / tdevcDiscrepancies
// ---------------------------------------------------------------------------

describe("parseTdevcLine", () => {
  it("parses a well-formed line, including a blank PARENTCL (root package)", () => {
    const raw = `${PKG_TDEVC_PREFIX} DEVCLASS=ZTM_ROOTPKG PARENTCL= DLVUNIT=HOME KORRFLAG=X`;
    expect(parseTdevcLine(raw)).toEqual({
      devclass: "ZTM_ROOTPKG",
      parentcl: "",
      dlvunit: "HOME",
      korrflag: "X",
    });
  });

  it("returns undefined when the evidence line is missing entirely", () => {
    expect(parseTdevcLine("PKG-CREATED\nPKG-CONFIRMED")).toBeUndefined();
  });

  it("returns undefined for a malformed line (a KEY=VALUE pair missing)", () => {
    const raw = `${PKG_TDEVC_PREFIX} DEVCLASS=ZTM_TESTPKG PARENTCL=ZTM DLVUNIT=HOME`; // no KORRFLAG
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
    const notes = tdevcDiscrepancies(
      { ...matching, dlvunit: "OTHER" },
      { softwareComponent: "HOME", superPackage: "ZTM" },
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/DLVUNIT/);
  });

  it("names a KORRFLAG mismatch", () => {
    const notes = tdevcDiscrepancies(
      { ...matching, korrflag: "" },
      { softwareComponent: "HOME", superPackage: "ZTM" },
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/KORRFLAG/);
  });

  it("names a PARENTCL mismatch", () => {
    const notes = tdevcDiscrepancies(
      { ...matching, parentcl: "ZOTHER" },
      { softwareComponent: "HOME", superPackage: "ZTM" },
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/PARENTCL/);
  });

  it("adds a 'no evidence line' NOTE when the row is undefined — and never throws", () => {
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
// 7 — a failing transcript is a failure
// ---------------------------------------------------------------------------

describe("a failing transcript is a failure", () => {
  it("HTTP 200 with EMPTY classrun output throws CHECK_FAILED", async () => {
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput([])));
    const { conn } = await connected(route);
    const err = await catchErr(createPackageViaBridge(conn, allowingGate(), SUB_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
  });

  it("a ZMCP-DDIC-ERR> line throws CHECK_FAILED, quoting the server's own text", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput([`${DDIC_ERR_PREFIX} TDEVC has no row for ZTM_TESTPKG after create`])),
    );
    const { conn } = await connected(route);
    const err = await catchErr(createPackageViaBridge(conn, allowingGate(), SUB_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("TDEVC has no row");
  });

  it("superPackage was requested, but PKG-PARENT-SET never arrived: CHECK_FAILED, not silent success", async () => {
    const line = tdevcLine({ devclass: "ZTM_TESTPKG", parentcl: "", dlvunit: "HOME", korrflag: "X" });
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["PKG-CREATED", line, "PKG-CONFIRMED"])),
    );
    const { conn } = await connected(route);
    const err = await catchErr(createPackageViaBridge(conn, allowingGate(), SUB_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toMatch(/PKG-PARENT-SET/);
  });

  it("output carrying some OTHER tag only is not success either", async () => {
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(["VIEW-PUT"])));
    const { conn } = await connected(route);
    const err = await catchErr(createPackageViaBridge(conn, allowingGate(), SUB_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
  });
});

// ---------------------------------------------------------------------------
// 7b — partial success: PKG-CREATED fired, then a later step failed
// ---------------------------------------------------------------------------

describe("partial success — PKG-CREATED fires, then attaching the super package fails (live incident)", () => {
  it("reports the failure AND that the package already exists on the server, uninstructs a blind retry", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(
        classrunOutput(["PKG-CREATED", `${DDIC_ERR_PREFIX} Attaching super package failed, sy-subrc=1, 465`]),
      ),
    );
    const { conn } = await connected(route);
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
    expect(err.hint).toContain("Do NOT simply retry this call");
    expect(err.hint).toContain("abap_transport operation=list");
  });

  it("no PARTIAL SUCCESS wording when the very first step (create) itself fails — nothing took effect", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput([`${DDIC_ERR_PREFIX} Creating package failed, sy-subrc=1, 165`])),
    );
    const { conn } = await connected(route);
    const err = await catchErr(createPackageViaBridge(conn, allowingGate(), SUB_PARAMS));

    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toBe("Creating package ZTM_TESTPKG failed on the server: Creating package failed, sy-subrc=1, 165");
    expect(err.details.partial).toBeUndefined();
    expect(err.hint).toBeUndefined();
  });

  it("names the super package attach too when it succeeded but PKG-CONFIRMED's TDEVC re-read then fails", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(
        classrunOutput([
          "PKG-CREATED",
          "PKG-PARENT-SET",
          `${DDIC_ERR_PREFIX} TDEVC has no row for ZTM_TESTPKG after create`,
        ]),
      ),
    );
    const { conn } = await connected(route);
    const err = await catchErr(createPackageViaBridge(conn, allowingGate(), SUB_PARAMS));

    expect(err.details.completed).toEqual(["PKG-CREATED", "PKG-PARENT-SET"]);
    expect(err.message).toContain("package ZTM_TESTPKG was created and saved on TST");
    expect(err.message).toContain("was then attached to super package ZTM and saved on TST");
  });
});

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

describe("createPackageViaBridge happy path (superPackage set — the only shape that reaches all the way through the gate)", () => {
  it("writes, activates and runs the bridge; reports PKG-CREATED, PKG-PARENT-SET, PKG-CONFIRMED and parses the TDEVC evidence row", async () => {
    const line = tdevcLine({ devclass: "ZTM_TESTPKG", parentcl: "ZTM", dlvunit: "HOME", korrflag: "X" });
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["PKG-CREATED", "PKG-PARENT-SET", line, "PKG-CONFIRMED"])),
    );
    const { conn, inner } = await connected(route);

    const { transcript, run, tdevc } = await createPackageViaBridge(conn, allowingGate(), SUB_PARAMS);
    expect(transcript.tags).toEqual(["PKG-CREATED", "PKG-PARENT-SET", "PKG-CONFIRMED"]);
    expect(transcript.errorLine).toBeUndefined();
    expect(run.output).toContain("PKG-CONFIRMED");
    expect(tdevc).toEqual({ devclass: "ZTM_TESTPKG", parentcl: "ZTM", dlvunit: "HOME", korrflag: "X" });
    expect(tdevcDiscrepancies(tdevc, { softwareComponent: "HOME", superPackage: "ZTM" })).toEqual([]);

    const methods = inner.calls.map((c) => (c.method ?? "GET").toUpperCase());
    expect(methods).toContain("PUT");
    expect(inner.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
  });

  it("the source actually PUT over the wire carries the CL_PACKAGE_FACTORY call and the corrNr, spelled out", async () => {
    const line = tdevcLine({ devclass: "ZTM_TESTPKG", parentcl: "ZTM", dlvunit: "HOME", korrflag: "X" });
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["PKG-CREATED", "PKG-PARENT-SET", line, "PKG-CONFIRMED"])),
    );
    const { conn, inner } = await connected(route);
    await createPackageViaBridge(conn, allowingGate(), SUB_PARAMS);

    const put = inner.calls.find(
      (c) => (c.method ?? "").toUpperCase() === "PUT" && c.url === BRIDGE_SOURCE_URI,
    );
    const body = String(put?.body);
    expect(body).toContain("CALL METHOD cl_package_factory=>create_new_package");
    expect(body).toContain("i_transport_request = 'A4HK900123'");
    expect(body).toContain("CALL METHOD cl_package_factory=>load_package");
    // Same interface-prefix regression guard as the fragment-level test above.
    expect(body).toContain("CALL METHOD lo_package->set_super_package_name");
    expect(body).toContain("i_super_package_name = 'ZTM'");
    expect(body).not.toContain("if_package~");
  });

  it("PACKAGE_DATA_LINES declares the three locals the fragment relies on", () => {
    expect(PACKAGE_DATA_LINES).toEqual([
      "ls_data    TYPE scompkdtln.",
      "lo_package TYPE REF TO if_package.",
      "ls_tdevc   TYPE tdevc.",
    ]);
    expect(sourceFor(SUB_PARAMS)).toContain("DATA ls_data    TYPE scompkdtln.");
  });
});
