/**
 * Guard for a live incident where a classrun bridge emitted
 *
 *   DATA lo_package TYPE REF TO if_package.
 *   ...
 *   lo_package->if_package~save( i_transport_request = ... ).
 *
 * `lo_package->if_package~` is a SYNTAX ERROR — you cannot prefix a call on a
 * variable with the SAME interface it is declared `TYPE REF TO`. A4H
 * rejected it with `Class "IF_PACKAGE" does not contain an interface
 * "IF_PACKAGE"`, so the generated class never activated and the whole
 * feature was inert. Offline tests didn't catch it because nothing checked
 * the emitted ABAP for this shape — this file is that check.
 *
 * The SAME prefix on a DIFFERENT declared type is valid ABAP and must NOT be
 * flagged: `lo_spot->if_enh_object~unlock( )` where `lo_spot` is declared
 * `TYPE REF TO if_enh_spot_tool` (a different interface) is verified live and
 * correct (src/adt/enhancement-bridge.ts, src/adt/enhancement-templates.ts).
 * Likewise a class implementing an interface — `lo_impl->if_enh_object_docu~`
 * where `lo_impl` is `TYPE REF TO cl_enh_tool_badi_impl` — is fine; the
 * declared type there is simply never equal to the prefix.
 *
 * Two halves, because each catches what the other misses:
 *  - "emitted ABAP" calls the real generators and checks what they actually
 *    produce — the half that catches dynamically-assembled source.
 *  - "source sweep" reads every .ts file under src/ off disk and applies the
 *    same rule to ABAP embedded as string literals — the net for generators
 *    with no golden test to hook into.
 *
 * Deliberately NOT a general ABAP parser: a partial offline parser would give
 * false confidence in exactly the way that let the syntax error through
 * unnoticed — see `scanForSelfInterfaceSelector` below for the narrow,
 * structural rule this uses instead.
 */
import { readFileSync, readdirSync } from "node:fs";
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
import { packageFragment, PACKAGE_DATA_LINES, type PackageBridgeParams } from "../src/adt/package-create.js";
import { ddicBridgeSource, DDIC_BRIDGE_CLASS } from "../src/adt/ddic-bridge.js";
import { classicViewFragment, type ClassicViewParams } from "../src/adt/view-create.js";
import { transactionFragment, type TransactionParams } from "../src/adt/tran-create.js";
import { exerciseFragment, type ExerciseParams } from "../src/adt/enhancement-templates.js";
import {
  BRIDGE_CLASS,
  ENH_CREATE_PACKAGE,
  createEnhancementSpot,
  createBadiImplementation,
} from "../src/adt/enhancement-bridge.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// The check — one helper, shared by both halves
// ---------------------------------------------------------------------------

interface SelfInterfaceHit {
  variable: string;
  interfaceName: string;
  line: string;
}

interface SelfInterfaceScan {
  /** How many `<var> TYPE REF TO <iface>.`-shaped declarations were found — used to prove a scan isn't silently looking at nothing. */
  declarationCount: number;
  hits: SelfInterfaceHit[];
}

/**
 * Finds every `<var> TYPE REF TO <iface>.` declaration (the `DATA` keyword
 * is optional — several generators here build bare `<var> TYPE REF TO
 * <iface>.` lines that `ddicBridgeSource`/`bridgeSource` prepend `DATA ` to
 * later, so requiring the keyword literally would blind half the fixtures),
 * then flags any `<var>-><iface>~` occurrence where the prefix interface is
 * the SAME as the declared one, case-insensitively (ABAP identifiers are
 * case-insensitive).
 *
 * Inline `DATA(var) = ...` declarations are deliberately OUT OF SCOPE: the
 * static type isn't written down anywhere for those, so there is nothing
 * textual to compare against a later `~` prefix.
 *
 * This is intentionally not an ABAP parser. A real parser would need to
 * track scope, includes, method boundaries and inheritance to be honest
 * about what it does and doesn't understand — a deliberately narrow,
 * structural, textual rule is the whole point: a partial offline ABAP parser
 * would give false confidence, which is the exact failure mode this guard
 * exists to prevent (the live incident above shipped with zero offline
 * coverage of the emitted ABAP at all).
 */
function scanForSelfInterfaceSelector(source: string): SelfInterfaceScan {
  const declRe = /\b([A-Za-z_]\w*)\s+TYPE\s+REF\s+TO\s+([A-Za-z_][\w/]*)\s*\./gi;
  const declarations = new Map<string, string>(); // lowercase var -> declared interface, original case
  let declarationCount = 0;
  for (const m of source.matchAll(declRe)) {
    const [, variable, iface] = m;
    if (!variable || !iface) continue;
    declarationCount++;
    declarations.set(variable.toLowerCase(), iface);
  }

  const hits: SelfInterfaceHit[] = [];
  for (const [varLower, iface] of declarations) {
    const useRe = new RegExp(`\\b${varLower}\\s*->\\s*${iface}\\s*~`, "gi");
    for (const m of source.matchAll(useRe)) {
      const idx = m.index ?? 0;
      const lineStart = source.lastIndexOf("\n", idx) + 1;
      const lineEndIdx = source.indexOf("\n", idx);
      const line = source.slice(lineStart, lineEndIdx === -1 ? source.length : lineEndIdx).trim();
      hits.push({ variable: varLower, interfaceName: iface, line });
    }
  }
  return { declarationCount, hits };
}

/** Throws an actionable message (file/generator, variable, interface, the fix) when the scan finds a hit. */
function assertNoSelfInterfaceSelectorHits(source: string, label: string): void {
  const { hits } = scanForSelfInterfaceSelector(source);
  if (hits.length === 0) return;
  const details = hits
    .map(
      (h) =>
        `  - variable \`${h.variable}\` is declared TYPE REF TO ${h.interfaceName}, but is called as ` +
        `\`${h.variable}->${h.interfaceName}~...\` — this is a syntax error (same interface as the ` +
        `declared type). Fix: drop the \`${h.interfaceName}~\` prefix. Offending line: ${h.line}`,
    )
    .join("\n");
  throw new Error(`${label}: self-interface component-selector violation(s):\n${details}`);
}

// ---------------------------------------------------------------------------
// 0 — the helper itself, against synthetic ABAP (before trusting it on real
//     generator output)
// ---------------------------------------------------------------------------

describe("scanForSelfInterfaceSelector", () => {
  it("flags <var>-><iface>~ when <var> is declared TYPE REF TO that SAME <iface>", () => {
    const src = ["DATA lo_package TYPE REF TO if_package.", "lo_package->if_package~save( )."].join("\n");
    const { hits } = scanForSelfInterfaceSelector(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ variable: "lo_package", interfaceName: "if_package" });
  });

  it("is case-insensitive (ABAP identifiers are)", () => {
    const src = ["DATA LO_PACKAGE TYPE REF TO IF_PACKAGE.", "lo_package->if_package~save( )."].join("\n");
    expect(scanForSelfInterfaceSelector(src).hits).toHaveLength(1);
  });

  it("does NOT flag <var>-><otherIface>~ when the declared type DIFFERS — the real, live-verified shape", () => {
    // Exact shape from src/adt/enhancement-bridge.ts: lo_spot is TYPE REF TO
    // if_enh_spot_tool, prefixed with the DIFFERENT interface if_enh_object.
    const src = ["DATA lo_spot TYPE REF TO if_enh_spot_tool.", "lo_spot->if_enh_object~unlock( )."].join("\n");
    expect(scanForSelfInterfaceSelector(src).hits).toEqual([]);
  });

  it("does NOT flag a class implementing the prefixed interface (declared type is a class, never equal to the prefix)", () => {
    // Exact shape from src/adt/enhancement-templates.ts: lo_impl is TYPE REF
    // TO the CLASS cl_enh_tool_badi_impl, prefixed with an interface it implements.
    const src = [
      "DATA lo_impl TYPE REF TO cl_enh_tool_badi_impl.",
      "lo_impl->if_enh_object_docu~set_shorttext( 'x' ).",
    ].join("\n");
    expect(scanForSelfInterfaceSelector(src).hits).toEqual([]);
  });

  it("does NOT flag an interface IMPLEMENTATION method header (METHOD if_x~y — no `->`, unrelated shape)", () => {
    const src = ["DATA lo TYPE REF TO if_oo_adt_classrun.", "METHOD if_oo_adt_classrun~main."].join("\n");
    expect(scanForSelfInterfaceSelector(src).hits).toEqual([]);
  });

  it("does NOT flag a plain call with no `~` component selector at all", () => {
    const src = ["DATA lo_package TYPE REF TO if_package.", "lo_package->save( )."].join("\n");
    expect(scanForSelfInterfaceSelector(src).hits).toEqual([]);
  });

  it("the DATA keyword is optional — bare '<var> TYPE REF TO <iface>.' lines (pre-DATA-prepend fragments) are still caught", () => {
    const src = ["lo_package TYPE REF TO if_package.", "lo_package->if_package~save( )."].join("\n");
    expect(scanForSelfInterfaceSelector(src).hits).toHaveLength(1);
  });

  it("counts declarations even when there is nothing to flag — proves the scan isn't just returning empty because it saw nothing", () => {
    const src = "DATA lo_x TYPE REF TO if_y.\nlo_x->save( ).";
    expect(scanForSelfInterfaceSelector(src).declarationCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 1 — the emitted ABAP: call the real generators, check what they produce
// ---------------------------------------------------------------------------

const PACKAGE_ROOT: PackageBridgeParams = {
  packageName: "ZTM_ROOTPKG",
  description: "Root package",
  softwareComponent: "HOME",
  corrNr: "A4HK900123",
};

const PACKAGE_SUB: PackageBridgeParams = {
  ...PACKAGE_ROOT,
  packageName: "ZTM_SUBPKG",
  superPackage: "ZTM",
};

const VIEW_PARAMS: ClassicViewParams = {
  viewName: "ZTM_V_CARRIER",
  baseTable: "SCARR",
  fields: ["CARRID", "CARRNAME"],
  description: "Test view",
  packageName: "ZTM",
  corrNr: "A4HK900121",
};

const TRAN_PARAMS: TransactionParams = {
  tcode: "ZTM_CARRIERS",
  program: "SAPMZTM_CARRIERS",
  description: "Test transaction",
  packageName: "ZTM",
  corrNr: "A4HK900121",
};

const EXERCISE_PARAMS: ExerciseParams = {
  badiName: "ZMCP_BADI",
  methodName: "DO_SOMETHING",
  params: [{ name: "IV_FLAG", kind: "importing", value: "X" }],
};

describe("emitted ABAP — pure fragment generators, called directly (no live connection needed)", () => {
  it("packageFragment: root and sub-package shapes — the EXACT site of the live self-interface-selector bug", () => {
    // ddicBridgeSource is what actually joins PACKAGE_DATA_LINES's `DATA
    // lo_package TYPE REF TO if_package.` to packageFragment's body — the
    // same assembly `createPackageViaBridge` sends over the wire (see
    // test/package-create.test.ts's `sourceFor`). Fragment-only source has
    // no DATA declarations at all (they live in PACKAGE_DATA_LINES).
    const fullSource = (p: PackageBridgeParams): string =>
      ddicBridgeSource(DDIC_BRIDGE_CLASS.createPackage, PACKAGE_DATA_LINES, packageFragment(p));
    assertNoSelfInterfaceSelectorHits(fullSource(PACKAGE_ROOT), "packageFragment(root)");
    assertNoSelfInterfaceSelectorHits(fullSource(PACKAGE_SUB), "packageFragment(sub)");
    // Not vacuous: lo_package really is declared TYPE REF TO if_package here.
    const src = fullSource(PACKAGE_SUB);
    expect(src).toContain("TYPE REF TO if_package");
    expect(scanForSelfInterfaceSelector(src).declarationCount).toBeGreaterThan(0);
  });

  it("classicViewFragment: no TYPE REF TO in this generator at all — checked, nothing to guard", () => {
    const src = classicViewFragment(VIEW_PARAMS).join("\n");
    assertNoSelfInterfaceSelectorHits(src, "classicViewFragment");
    expect(scanForSelfInterfaceSelector(src).declarationCount).toBe(0);
  });

  it("transactionFragment: no TYPE REF TO in this generator at all — checked, nothing to guard", () => {
    const src = transactionFragment(TRAN_PARAMS).join("\n");
    assertNoSelfInterfaceSelectorHits(src, "transactionFragment");
    expect(scanForSelfInterfaceSelector(src).declarationCount).toBe(0);
  });

  it("exerciseFragment: declares lo_badi TYPE REF TO <badiName> and calls lo_badi-><method> with NO interface prefix at all", () => {
    const src = exerciseFragment(EXERCISE_PARAMS).join("\n");
    assertNoSelfInterfaceSelectorHits(src, "exerciseFragment");
    // Not vacuous: the declaration is genuinely there.
    expect(scanForSelfInterfaceSelector(src).declarationCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 1b — enhancement-bridge.ts: epilogueFragment/badiFilterCheckFragment aren't
// exported (code-controlled handle literals, never caller input — see that
// file's header), so the only way to see the REAL emitted ABAP for those is
// the actual source PUT over the wire. Same offline fake-transport harness
// test/enhancement-bridge.test.ts and test/package-create.test.ts already
// use — genuinely a live generator's real output, not a hand-copied fixture.
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

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

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

function classrunOutput(lines: readonly string[]): (o: HttpClientOptions) => HttpClientResponse {
  const body = lines.join("\n");
  return () => resp(200, body, { "content-type": "text/plain" });
}

const AFFECTS = { name: "ZCL_TARGET", packageName: "ZTARGET_PKG", masterSystem: "TST" };

const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [ENH_CREATE_PACKAGE],
    writesLockedOut: false,
    allowEnhancements: true,
    enhanceTargets: "customer",
    originSystems: ["TST"],
  });

/** Pulls the exact source string PUT over the wire for `className`'s /source/main. */
function sourcePutFor(inner: RecordingClient, className: string): string {
  const uri = `${CLASS_COLLECTION}/${className.toLowerCase()}/source/main`;
  const put = inner.calls.find((c) => (c.method ?? "").toUpperCase() === "PUT" && c.url === uri);
  return String(put?.body);
}

describe("emitted ABAP — enhancement-bridge.ts, captured off the wire (fake transport, same idiom as test/enhancement-bridge.test.ts)", () => {
  it("createEnhancementSpot: the real PUT body (lo_spot->if_enh_object~... epilogue) is clean", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.createSpot),
      sharedRoute(classrunOutput(["SPOT-OBJECT-CREATED"])),
    );
    const { conn, inner } = await connected(route);
    await createEnhancementSpot(conn, allowingGate(), {
      spotName: "ZMCP_SPOT",
      description: "A spot",
      affects: AFFECTS,
    });
    const src = sourcePutFor(inner, BRIDGE_CLASS.createSpot);
    assertNoSelfInterfaceSelectorHits(src, "createEnhancementSpot PUT body");
    // Not vacuous: the legitimate different-interface prefix really is in there.
    expect(src).toContain("lo_spot->if_enh_object~");
    expect(scanForSelfInterfaceSelector(src).declarationCount).toBeGreaterThan(0);
  });

  it("createBadiImplementation: the real PUT body (lo_enh->if_enh_object~... + lo_impl->if_enh_object_docu~... epilogues) is clean", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.createImpl),
      sharedRoute(classrunOutput(["ENHO-OBJECT-CREATED", "IMPL-ADDED"])),
    );
    const { conn, inner } = await connected(route);
    await createBadiImplementation(conn, allowingGate(), {
      enhName: "ZMCP_ENH_BADI",
      spotName: "ZMCP_SPOT",
      badiName: "ZMCP_BADI",
      implName: "ZMCP_IMPL",
      implClass: "ZCL_MCP_IMPL",
      description: "Test implementation",
      active: true,
      affects: AFFECTS,
    });
    const src = sourcePutFor(inner, BRIDGE_CLASS.createImpl);
    assertNoSelfInterfaceSelectorHits(src, "createBadiImplementation PUT body");
    // Not vacuous: TWO distinct different-interface prefixes are really in there
    // (the epilogue on lo_enh, and set_shorttext on lo_impl).
    expect(src).toContain("lo_enh->if_enh_object~");
    expect(src).toContain("lo_impl->if_enh_object_docu~");
    expect(scanForSelfInterfaceSelector(src).declarationCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2 — source sweep: read every .ts under src/ off disk, apply the same rule
//     to ABAP embedded as string/template literals. The net for generators
//     with no golden test (e.g. bopf-runtime.ts, fpm-lock.ts, fpm-runtime.ts,
//     ui-runtime.ts) that half 1 above cannot reach without a full live-style
//     harness for each one.
// ---------------------------------------------------------------------------

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("source sweep — every .ts under src/, read from disk", () => {
  const files = walkTsFiles(SRC_DIR);

  it("actually looked at something — non-vacuity guard on the sweep itself", () => {
    // A sweep that silently scans zero files (a bad path, a moved directory)
    // is worse than no guard at all: it stays green forever while asserting
    // nothing. Pin both a non-trivial file count and a non-trivial count of
    // TYPE REF TO declarations actually found across the tree.
    expect(files.length).toBeGreaterThan(50);
    let totalDeclarations = 0;
    for (const file of files) {
      totalDeclarations += scanForSelfInterfaceSelector(readFileSync(file, "utf8")).declarationCount;
    }
    expect(totalDeclarations).toBeGreaterThan(5);
  });

  it("no file under src/ contains a self-interface component-selector violation", () => {
    const failures: string[] = [];
    for (const file of files) {
      const { hits } = scanForSelfInterfaceSelector(readFileSync(file, "utf8"));
      for (const h of hits) {
        failures.push(
          `${file}: variable \`${h.variable}\` declared TYPE REF TO ${h.interfaceName}, called as ` +
            `\`${h.variable}->${h.interfaceName}~...\` — drop the \`${h.interfaceName}~\` prefix. Line: ${h.line}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it("the sweep reaches the known-legitimate sites and does NOT flag them (false-positive check)", () => {
    const enhBridge = readFileSync(join(SRC_DIR, "adt", "enhancement-bridge.ts"), "utf8");
    const enhTemplates = readFileSync(join(SRC_DIR, "adt", "enhancement-templates.ts"), "utf8");
    // Confirm the legitimate shapes are actually present in these files —
    // otherwise a "not flagged" result would be meaningless (nothing to flag).
    expect(enhBridge).toContain("lo_spot->if_enh_object~");
    expect(enhTemplates).toContain("lo_impl->if_enh_object_docu~");
    expect(scanForSelfInterfaceSelector(enhBridge).hits).toEqual([]);
    expect(scanForSelfInterfaceSelector(enhTemplates).hits).toEqual([]);
  });
});
