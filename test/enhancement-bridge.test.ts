/**
 * T15 create bridge — offline. Nothing here touches SAP; the transport is
 * faked through `ConnectionOptions.httpClient`, repeating `test/bopf-runtime.test.ts`'s
 * self-contained `RecordingClient`/`resp`/`connected`/`bridgeHappyPath`
 * pattern (that file's own header explains why each suite keeps its own
 * small copy rather than sharing one with `test/enhancement-write.test.ts`'s
 * heavier `FakeAdt`).
 *
 * The five mutating operations (`createEnhancementSpot`, `addBadiDefinition`,
 * `addFilterDefinition`, `createBadiImplementation`, `setFilterValues`) no
 * longer generate and deploy a per-call `ZCL_ZMCP_ENH_*` bridge class — their
 * ABAP-side work now runs through `dispatch()` against the static fluid body
 * `ZCL_ZMCP_FLUID_ENH` (see `runEnhAction` in `../src/adt/enhancement-bridge.ts`).
 * Wire-level coverage for those five uses `./helpers/fluid-enh-fake.ts`'s
 * `dynamicEnhFluidRoute`/`enhProbeConsole` instead of `objectHappyPath` +
 * `classrunOutput`. `exerciseBadi` (bridge class `ZCL_ZMCP_ENH_EXEC`) is
 * unaffected by the reroute and keeps using `objectHappyPath`/`classrunOutput`
 * exactly as before.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import {
  BRIDGE_CLASS,
  ENH_BRIDGE_PACKAGE,
  ENH_CREATE_PACKAGE,
  bridgeSource,
  parseEnhancementTranscript,
  createEnhancementSpot,
  addBadiDefinition,
  addFilterDefinition,
  createBadiImplementation,
  setFilterValues,
  exerciseBadi,
  activateSpotAndImplementation,
} from "../src/adt/enhancement-bridge.js";
import { exerciseFragment } from "../src/adt/enhancement-templates.js";
import { enhancementIntentFor } from "../src/adt/write.js";
import { enhManifest } from "../src/adt/fluid/builtin/enh.js";
import { invokerName } from "../src/adt/fluid/invoke.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import {
  dynamicEnhFluidRoute,
  enhProbeConsole,
  type EnhFluidRouteOptions,
} from "./helpers/fluid-enh-fake.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Fake transport — same shape as test/bopf-runtime.test.ts
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-enh-bridge-"));
  resetFluidEnsureState();
  resetFluidPackageMemo();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    readOnly: false,
    fluidApi: true,
    stateDir: tmp,
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

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

/**
 * Real captured T000 non-productive proof (fixture 087, client 001 ->
 * CCCATEGORY "C") — read off disk, same as every other test file in this
 * suite (test/write.test.ts, test/enhancement-write.test.ts,
 * test/bopf-runtime.test.ts, ...). An earlier hand-rolled inline XML string
 * here used the wrong element name (`dataPreview:rows`/`dataPreview:data`
 * instead of the real `dataPreview:dataSet`) and was silently missing MANDT,
 * so `classifyT000Response` refused it as inconclusive and every stateful-
 * session test failed with READ_ONLY. Use the real bytes instead of
 * re-deriving the schema by hand.
 */
/* `DATAPREVIEW_XML` and `T000_NONPRODUCTIVE` (fixture 087) come from ./helpers/system-role-fake.js. */

/**
 * Generic GET-404 → POST-create → LOCK → PUT → UNLOCK → activate happy path
 * for ONE repository object (class or interface) — `test/bopf-runtime.test.ts`'s
 * `bridgeHappyPath`, generalised over the collection URL so it can serve
 * BOTH the marker interface (`INTF/OI`) and the bridge class (`CLAS/OC`) in
 * the same combined router (`addBadiDefinition`/`addFilterDefinition` write
 * both, in sequence).
 */
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

const CLASS_COLLECTION = "/sap/bc/adt/oo/classes";
const INTF_COLLECTION = "/sap/bc/adt/oo/interfaces";

const FLUID_PKG_URI = "/sap/bc/adt/packages/%24abapsmith_fluid_api";

const FLUID_PACKAGE_XML =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${ENH_BRIDGE_PACKAGE}" adtcore:type="DEVC/K">` +
  `<adtcore:packageRef adtcore:name="${ENH_BRIDGE_PACKAGE}" adtcore:type="DEVC/K"/>` +
  `<pak:superPackage/>` +
  `</pak:package>`;

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
    // ensureFluidPackage's package-existence probe (run.ts's deployBridge,
    // cold path only): already exists, so this is the whole round trip —
    // no create POST follows. Memoized per process per system, so only the
    // first cold bridge deploy in this file actually reaches it.
    if (o.url === FLUID_PKG_URI && (o.method ?? "GET").toUpperCase() === "GET") {
      return resp(200, FLUID_PACKAGE_XML, { "content-type": "application/xml" });
    }
    // Both the ordinary single-object activate (bridge class, marker
    // interface) and activateSpotAndImplementation's array-form joint
    // activate land here — an empty 200 body means "clean, no messages" for
    // either shape.
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
 * A permissive gate config for the happy-path tests — mirrors
 * `test/enhancement-write.test.ts`'s own `gate()`: allows the create
 * package ($TMP), enables enhancement authoring (`ABAP_ALLOW_ENHANCEMENTS`),
 * opts into "customer"-owned targets, and names TST (this suite's `cfg().sid`)
 * as an origin system so ownership resolves to "customer" unconditionally.
 */
const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [ENH_CREATE_PACKAGE, ENH_BRIDGE_PACKAGE],
    // $ is outside the default Z/Y customer namespace, same as
    // ensureHelperPackage's ALLOW_GATE (test/helper-package.test.ts) and
    // test/fluid-package.test.ts's own gate() — ensureFluidPackage's own
    // create call names the package itself, $ABAPSMITH_FLUID_API.
    allowNamePrefixes: ["*"],
    writesLockedOut: false,
    allowEnhancements: true,
    enhanceTargets: "customer",
    originSystems: ["TST"],
  });

const AFFECTS = { name: "ZCL_TARGET", packageName: "ZTARGET_PKG", masterSystem: "TST" };

/**
 * `setFilterValues` REQUIRES an `onJointActivation` hook: the H23
 * joint POST mutates the spot as well as the implementation, and the tool layer
 * journals the spot from this hook. It is deliberately not optional, so that a
 * new call site cannot reach that POST without deciding what to record — which
 * is exactly why every call below had to be touched.
 *
 * These are `src/adt/`-level tests: this module does not journal (the tool layer
 * owns the entry), so the correct value HERE is a no-op. The behaviour the hook
 * actually guarantees — entry on disk before the POST, and an aborted POST when
 * the hook throws — is asserted in test/enh-joint-activation-journal.test.ts,
 * which drives the real tool. Note that `npm run typecheck` cannot catch a
 * missing hook here at all: tsconfig.json excludes `test`, so the suite is the
 * only thing that fails. That is how these five sites were found.
 */
const noJournalHook = async (): Promise<void> => {};

// `ExecuteDenyingGate`/`executeDenyingGate` and the "execute is gated on its
// own, after write+activate succeed" describe block that used them were
// deleted here: that regression harness proved a standalone
// `gate.authorize("execute", ...)` check ran immediately before `runClass`
// in the old `writeActivateRunBridge` path. The five dispatch()-routed
// operations no longer call `writeActivateRunBridge` at all — `dispatch()`
// gates its mutate actions on `"write"` only (see `runEnhAction`'s doc
// comment in enhancement-bridge.ts), so there is no standalone `op:"execute"`
// check left on these five call sites for a test to isolate. `exerciseBadi`,
// the sixth operation, is unaffected (still `writeActivateRunBridge` +
// `gate.assertIntent(intent, { op: "execute" })`) and keeps its own
// "is refused outright under a readOnly gate" coverage above.

/**
 * `activateSpotAndImplementation` now requires a real `AuthorizedTarget`
 * — this mints one the same way `setFilterValues`
 * does internally. A plain `gate.authorize("activate", ...)` is not enough:
 * `ENHO/XH`'s effect is on an object outside its own name/package/URI, so
 * the gate demands `authorizeIntent`/`evaluateIntent` for it (same reason
 * production code uses `enhancementIntentFor` + `authorizeIntent` here) —
 * this mints via that same path, for tests that call the joint-activation
 * helper directly rather than through `setFilterValues`.
 */
const authorizeActivate = (gate: SafetyGate, name: string) =>
  gate.authorizeIntent(
    "activate",
    enhancementIntentFor({ name, type: "ENHO/XH", packageName: ENH_CREATE_PACKAGE }, AFFECTS),
    { name, packageName: ENH_CREATE_PACKAGE, type: "ENHO/XH" },
  );

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!e || !isAbapError(e)) throw new Error(`expected an AbapError, got ${String(e)}`);
  return e;
};

/**
 * classrun response body for a plain `IF_OO_ADT_CLASSRUN` bridge. Unlike
 * `runReport`'s generated SUBMIT-and-capture bridge (run.ts), which re-emits
 * captured list output with an explicit `LIST_LINE_PREFIX` ("LIST> ") so its
 * own diagnostics can be told apart from re-played list content,
 * `enhancement-bridge.ts`'s bridges call `out->write('TAG')` directly — the
 * tag text is the entire line, unprefixed. `runClass` (run.ts) hands back
 * that raw stdout with only newline normalisation, no header-stripping. So
 * the fake response here must NOT add a "LIST> " prefix — an earlier draft
 * did, copying run.ts's report-bridge wire shape by analogy without checking
 * it does not apply to a bare classrun class, and every happy-path test
 * failed with "did not report success" as a result.
 */
function classrunOutput(lines: readonly string[]): (o: HttpClientOptions) => HttpClientResponse {
  const body = lines.join("\n");
  return () => resp(200, body, { "content-type": "text/plain" });
}

/**
 * The two routes every dispatch()-routed `enh` action test needs, in the
 * order `combine` must try them: `dynamicEnhFluidRoute` first (deploys and
 * activates both manifest objects — `FLUID_RUNTIME_CLASS`, `ZCL_ZMCP_FLUID_ENH`
 * — plus the content-hashed invoker, and answers the invoker's classrun
 * with one `enhProbeConsole` transcript carrying `result`), `sharedRoute`
 * last (session/discovery/ato/datapreview/package-probe, plus any genuine
 * TS-side `activateObject` call against a spot/impl/interface name, which
 * is never a fluid class name so `dynamicEnhFluidRoute` leaves it
 * unrouted). `sharedRoute`'s own classrun branch is unreachable here
 * (shadowed) but harmless. Returned as an array, not a single combined
 * function, so a test that needs to intercept one specific call (e.g. a
 * spot activation failure) can splice its own route in between the two.
 */
function enhFluidRoutes(
  action: string,
  result: Record<string, unknown>,
  opts: { activationError?: EnhFluidRouteOptions["activationError"] } = {},
): Array<(o: HttpClientOptions) => HttpClientResponse | undefined> {
  return [
    dynamicEnhFluidRoute({
      transcript: () => enhProbeConsole(action, result),
      packageName: ENH_BRIDGE_PACKAGE,
      activationError: opts.activationError,
    }),
    sharedRoute(classrunOutput([])),
  ];
}

/**
 * The invoker class name `dispatch()` will compute for this exact
 * `(action, args)` pair — proof that a captured POST creating a class with
 * this name means the production code sent exactly this action and exactly
 * these args (any difference, including a missing `corr_nr: ""`, hashes to
 * a different, unrecognized name).
 */
function expectedInvokerName(action: string, args: Record<string, unknown>): string {
  return invokerName(enhManifest.id, action, args, enhManifest.contract);
}

function createdInvoker(inner: RecordingClient, name: string): boolean {
  return inner.calls.some(
    (c) =>
      (c.method ?? "").toUpperCase() === "POST" &&
      c.url === "/sap/bc/adt/oo/classes" &&
      String(c.body).includes(`adtcore:name="${name}"`),
  );
}

// ---------------------------------------------------------------------------
// H50 — a period, a quote, or a newline is refused outright, before any I/O
// ---------------------------------------------------------------------------

describe("H50 — identifier validation refuses before any network call", () => {
  const badNames = ["bad.name", "bad'name", "bad\nname"];

  for (const bad of badNames) {
    it(`createEnhancementSpot refuses spotName ${JSON.stringify(bad)}`, async () => {
      const { conn, inner } = await connected(combine(sharedRoute(classrunOutput([]))));
      const err = await catchErr(
        createEnhancementSpot(conn, allowingGate(), { spotName: bad, description: "A spot", affects: AFFECTS }),
      );
      expect(err.code).toBe("BAD_INPUT");
      expect(inner.calls.length).toBe(0);
    });

    it(`exerciseBadi refuses badiName ${JSON.stringify(bad)}`, async () => {
      const { conn, inner } = await connected(combine(sharedRoute(classrunOutput([]))));
      const err = await catchErr(
        exerciseBadi(conn, allowingGate(), {
          badiName: bad,
          methodName: "RUN",
          params: [],
          affects: AFFECTS,
        }),
      );
      expect(err.code).toBe("BAD_INPUT");
      expect(inner.calls.length).toBe(0);
    });

    // A per-iteration `value`-control-character check used to live here:
    // before the reroute, `setFilterValuesFragment` spliced `params.value`
    // literally into generated ABAP source (a string literal), so a raw
    // newline had to be refused as BAD_INPUT before any network call, same
    // as an identifier. `value` now travels as one field of the JSON `args`
    // object handed to `dispatch()` — the static fluid body assigns it to an
    // ABAP variable, never splices it into source text — so a control
    // character in free text is no longer a source-injection hazard and
    // `setFilterValues` does not (and no longer needs to) reject it
    // up front. Confirmed via a direct call: with a real fluid route wired
    // up, `value: "bad\nname"` reaches `dispatch()` and is not refused
    // before I/O; the removed assertion was `expect(err.code).toBe(
    // "BAD_INPUT")` + `expect(inner.calls.length).toBe(0)`, verified stale by
    // running it against the current source (it now fails only because the
    // OLD-style, non-fluid `sharedRoute` fixture used here leaves
    // ZCL_ZMCP_FLUID_RT unrouted, which surfaces as SAFETY_DENIED /
    // PACKAGE_UNKNOWN — a fixture artifact, not evidence of any surviving
    // client-side control-character check).
  }
});

// ---------------------------------------------------------------------------
// createSpotFragment/createImplFragment: deleted along with the generators
// they tested. The five mutating operations no longer build ABAP source
// fragments in TypeScript -- spot/impl description handling now lives
// inside the static fluid body ZCL_ZMCP_FLUID_ENH (see runEnhAction).
// Confirmed via grep before deletion: no remaining non-test caller of
// createSpotFragment/createImplFragment/addBadiDefFragment/
// addFilterDefFragment/setFilterValuesFragment in src/ or test/ (see the
// final report for the exact grep evidence and the corresponding
// deletions in enhancement-templates.ts).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Generator/parser drift — mirrors bopf-runtime.test.ts's convention
// ---------------------------------------------------------------------------

describe("bridgeSource DATA section", () => {
  // Regression for a live-confirmed bug: dataLines entries (DATA_COMMON etc.
  // in enhancement-bridge.ts) are bare declarations like
  // "lv_pkg TYPE devclass VALUE '$TMP'." with no leading `DATA` keyword.
  // bridgeSource's own `data` line-mapping used to emit them verbatim, which
  // is not valid ABAP on its own — a real live activation failed with this
  // exact statement (captured live:
  // "The statement \"LV_PKG\" is invalid. Check the spelling." at line 1,
  // col 4 of ZCL_ZMCP_ENH_CSPOT's main method — precisely where lv_pkg's
  // declaration is emitted). The fix prepends `DATA ` at the single
  // assembly point rather than editing each of the five data-line arrays.
  it("prepends DATA to every data-section line", () => {
    const source = bridgeSource(
      // Any bridge-shaped class name works here — bridgeSource is generic
      // and unrelated to which specific class name is passed. BRIDGE_CLASS
      // now only names "exercise" (the five mutating operations no longer
      // deploy a per-call bridge), so this uses a literal placeholder.
      "ZCL_ZMCP_ENH_TEST",
      ["lv_pkg TYPE devclass VALUE '$TMP'.", "lv_trkorr TYPE trkorr."],
      ['out->write( \'X\' ).'],
    );
    expect(source).toContain("    DATA lv_pkg TYPE devclass VALUE '$TMP'.");
    expect(source).toContain("    DATA lv_trkorr TYPE trkorr.");
    // Guard against the exact bug: a bare, un-prefixed declaration line.
    expect(source).not.toMatch(/\n {4}lv_pkg TYPE devclass/);
    expect(source).not.toMatch(/\n {4}lv_trkorr TYPE trkorr/);
  });

  it("emits no data-declaration line at all when dataLines is empty", () => {
    const source = bridgeSource(BRIDGE_CLASS.exercise, [], ['out->write( \'X\' ).']);
    // No `DATA <name> TYPE ...` declaration line — only the (unrelated)
    // `CATCH cx_root INTO DATA(lx_err)` inline declaration the skeleton
    // always emits.
    expect(source).not.toMatch(/^ {4}DATA /m);
  });
});

describe("parseEnhancementTranscript", () => {
  it("captures a ZMCP-ENH-ERR> line and reports no tags", () => {
    const result = parseEnhancementTranscript("ZMCP-ENH-ERR> Something broke");
    expect(result.tags).toEqual([]);
    expect(result.errorLine).toBe("Something broke");
  });

  it("handles empty input", () => {
    const result = parseEnhancementTranscript("");
    expect(result.tags).toEqual([]);
    expect(result.errorLine).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// exerciseFragment — CHANGING parameter handling
// ---------------------------------------------------------------------------

describe("exerciseFragment", () => {
  // `CALL BADI` NEVER supports the
  // parenthesized functional-call short form (`obj->method( ... )`), unlike
  // ordinary 7.40+ method calls — confirmed against the ABAP keyword
  // documentation and a verified live capture. Every shape below asserts the classic
  // non-parenthesized keyword form: `CALL BADI ref->method [EXPORTING ...]
  // [CHANGING ...].`.
  it("emits EXPORTING keyword form (no parens) for importing-only params", () => {
    const lines = exerciseFragment({
      badiName: "ZMCP_BADI",
      methodName: "RUN",
      params: [{ name: "IV_ARG", value: "hello" }],
    });
    const call = lines.find((l) => l.includes("CALL BADI"));
    // The exact-match assertion above is itself the no-parens proof for the
    // CALL BADI statement — a separate whole-source "no parens anywhere"
    // check would be wrong: out->write( 'EXERCISED' ) is an ordinary
    // functional call and legitimately uses parens.
    expect(call?.trim()).toBe("CALL BADI lo_badi->RUN EXPORTING IV_ARG = 'hello'.");
    expect(call).not.toContain("(");
  });

  // A CHANGING parameter must be passed as a real
  // local variable, never a literal — ABAP refuses a literal as the actual
  // parameter for a modifiable formal parameter (live evidence: `CALL BADI
  // lo_badi->M_CHG CHANGING CV_TXT = 'CHG-PROBE-1'.` failed activation with
  // a "field cannot be modified" error). See `test/enhancement-exercise.
  // test.ts` for exhaustive coverage of this fix (all four `kind`s, the
  // declare/seed/pass/read-back mechanism, and every refusal path) — the
  // two tests below are kept here only because they were already pinning
  // the (formerly buggy, now fixed) CALL BADI clause shape for this file's
  // own no-parens coverage.
  it("emits CHANGING keyword form (no parens) for a changing-only param, passing a VARIABLE not a literal", () => {
    const lines = exerciseFragment({
      badiName: "ZMCP_BADI",
      methodName: "RUN",
      params: [{ name: "CT_DATA", value: "hello", kind: "changing", type: "STRING" }],
    });
    const call = lines.find((l) => l.includes("CALL BADI"));
    expect(call?.trim()).toBe("CALL BADI lo_badi->RUN CHANGING CT_DATA = lv_ct_data.");
    expect(call).not.toContain("EXPORTING");
    expect(call).not.toContain("(");
    expect(lines).toContain("DATA lv_ct_data TYPE STRING.");
    expect(lines).toContain("lv_ct_data = 'hello'.");
  });

  it("emits EXPORTING ... CHANGING ... (no parens) for a mix of importing and changing params, changing arg is a VARIABLE", () => {
    const lines = exerciseFragment({
      badiName: "ZMCP_BADI",
      methodName: "RUN",
      params: [
        { name: "IV_ARG", value: "hello" },
        { name: "CT_DATA", value: "world", kind: "changing", type: "STRING" },
      ],
    });
    const call = lines.find((l) => l.includes("CALL BADI"));
    expect(call?.trim()).toBe("CALL BADI lo_badi->RUN EXPORTING IV_ARG = 'hello' CHANGING CT_DATA = lv_ct_data.");
    expect(call).not.toContain("(");
  });

  it("emits a bare no-parens call when there are no params at all", () => {
    const lines = exerciseFragment({ badiName: "ZMCP_BADI", methodName: "RUN", params: [] });
    const call = lines.find((l) => l.includes("CALL BADI"));
    expect(call?.trim()).toBe("CALL BADI lo_badi->RUN.");
    expect(call).not.toContain("(");
  });

  // Defect 1(a) — root cause was a missing parameter, not a substitution
  // bug: the old code always emitted the literal placeholder `flt` in
  // `GET BADI ... FILTERS flt = ...` because there was no field to
  // substitute a real filter name into. `filterName`/`filterValue` close
  // that gap.
  it("substitutes the real filter name into GET BADI ... FILTERS (no more literal `flt` placeholder)", () => {
    const lines = exerciseFragment({
      badiName: "ZMCP_BADI",
      methodName: "RUN",
      filterName: "CARRID",
      filterValue: "LH",
      params: [],
    });
    const getBadi = lines.find((l) => l.includes("GET BADI"));
    expect(getBadi?.trim()).toBe("GET BADI lo_badi FILTERS CARRID = 'LH'.");
    expect(lines.join("\n")).not.toMatch(/FILTERS\s+flt\s*=/);
  });

  it("emits plain GET BADI (no FILTERS clause) when filterName/filterValue are both omitted", () => {
    const lines = exerciseFragment({ badiName: "ZMCP_BADI", methodName: "RUN", params: [] });
    const getBadi = lines.find((l) => l.includes("GET BADI"));
    expect(getBadi?.trim()).toBe("GET BADI lo_badi.");
  });

  it("rejects filterName given without filterValue (pairing rule)", () => {
    expect(() =>
      exerciseFragment({ badiName: "ZMCP_BADI", methodName: "RUN", filterName: "CARRID", params: [] }),
    ).toThrow(/filterName and filterValue must be given together/);
  });

  it("rejects filterValue given without filterName (pairing rule)", () => {
    expect(() =>
      exerciseFragment({ badiName: "ZMCP_BADI", methodName: "RUN", filterValue: "LH", params: [] }),
    ).toThrow(/filterName and filterValue must be given together/);
  });

  it("always wraps the call in IF lo_badi IS BOUND ... ELSE out->write( 'NOT-BOUND' ) ENDIF", () => {
    const lines = exerciseFragment({
      badiName: "ZMCP_BADI",
      methodName: "RUN",
      params: [{ name: "IV_ARG", value: "hello" }],
    });
    const source = lines.join("\n");
    expect(source).toContain("IF lo_badi IS BOUND.");
    expect(source).toContain("out->write( 'EXERCISED' ).");
    expect(source).toContain("ELSE.");
    expect(source).toContain("out->write( 'NOT-BOUND' ).");
    expect(source).toContain("ENDIF.");
    // The call itself must be inside the BOUND branch, not before the IF.
    const ifIdx = lines.indexOf("IF lo_badi IS BOUND.");
    const callIdx = lines.findIndex((l) => l.includes("CALL BADI"));
    expect(callIdx).toBeGreaterThan(ifIdx);
  });
});

// ---------------------------------------------------------------------------
// createEnhancementSpot — full write → activate → run happy path
// ---------------------------------------------------------------------------

describe("createEnhancementSpot", () => {
  it("dispatches create_spot through the fluid enh body and reports SPOT-OBJECT-CREATED", async () => {
    const { conn, inner } = await connected(combine(...enhFluidRoutes("create_spot", { created: true })));
    const { transcript } = await createEnhancementSpot(conn, allowingGate(), {
      spotName: "ZMCP_SPOT",
      description: "A spot",
      affects: AFFECTS,
    });
    expect(transcript.tags).toEqual(["SPOT-OBJECT-CREATED"]);
    const methods = inner.calls.map((c) => (c.method ?? "GET").toUpperCase());
    expect(methods).toContain("PUT");
    expect(inner.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
  });

  it("dispatches create_spot with the exact args, including corr_nr and activate", async () => {
    const args = {
      spot_name: "ZMCP_SPOT",
      description: "A spot",
      package_name: ENH_CREATE_PACKAGE,
      corr_nr: "",
      activate: true,
    };
    const { conn, inner } = await connected(combine(...enhFluidRoutes("create_spot", { created: true })));
    await createEnhancementSpot(conn, allowingGate(), {
      spotName: "ZMCP_SPOT",
      description: "A spot",
      affects: AFFECTS,
    });
    expect(createdInvoker(inner, expectedInvokerName("create_spot", args))).toBe(true);
  });

  // Same defect class as createBadiImplementation's L17/ZTM_HW011B_IMPL
  // regression (see this module's header, "isActive-vs-adtcore:version"):
  // createEnhancementSpot's epilogue is inline-ABAP-side only. This proves a
  // separate, genuine POST /sap/bc/adt/activation now fires against the
  // newly created spot itself, not just the fluid deploy/invoke path.
  it("also performs a separate, genuine activation of the newly created spot — not just the inline epilogue (isActive-vs-adtcore:version regression)", async () => {
    const activationCalls: HttpClientOptions[] = [];
    const route = combine(
      (o: HttpClientOptions) => {
        if (o.url.includes("/sap/bc/adt/activation")) activationCalls.push(o);
        return undefined;
      },
      ...enhFluidRoutes("create_spot", { created: true }),
    );
    const { conn } = await connected(route);
    const result = await createEnhancementSpot(conn, allowingGate(), {
      spotName: "ZMCP_SPOT",
      description: "A spot",
      affects: AFFECTS,
    });
    expect(result.transcript.tags).toEqual(["SPOT-OBJECT-CREATED"]);
    expect(result.activation).toBeDefined();
    expect(result.activation.activated).toBe(true);
    expect(result.activation.errors).toBe(0);
    // The fluid deploy path activates FLUID_RUNTIME_CLASS, ZCL_ZMCP_FLUID_ENH,
    // and the per-call invoker (3), plus the explicit post-create activation
    // of the spot itself (1) = 4 distinct /sap/bc/adt/activation calls.
    expect(activationCalls.length).toBe(4);
    const spotActivation = activationCalls.find((c) => String(c.body).toLowerCase().includes("zmcp_spot"));
    expect(spotActivation).toBeTruthy();
  });

  it("reports created + activation.activated:false (does not throw) when the post-create spot activation fails", async () => {
    const errorBody = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement", "455-activate-failure-syntax-error.xml"),
      "utf8",
    );
    let sawSpotActivation = false;
    const route = combine(
      (o: HttpClientOptions) => {
        if (o.url.includes("/sap/bc/adt/activation") && String(o.body).toLowerCase().includes("zmcp_spot")) {
          sawSpotActivation = true;
          return resp(200, errorBody, { "content-type": "application/xml" });
        }
        return undefined;
      },
      ...enhFluidRoutes("create_spot", { created: true }),
    );
    const { conn } = await connected(route);
    const result = await createEnhancementSpot(conn, allowingGate(), {
      spotName: "ZMCP_SPOT",
      description: "A spot",
      affects: AFFECTS,
    });
    expect(sawSpotActivation).toBe(true);
    expect(result.transcript.tags).toEqual(["SPOT-OBJECT-CREATED"]);
    expect(result.activation.activated).toBe(false);
    expect(result.activation.errors).toBe(1);
  });

  it("throws CHECK_FAILED when the fluid result's created flag is false", async () => {
    const { conn } = await connected(combine(...enhFluidRoutes("create_spot", { created: false })));
    const err = await catchErr(
      createEnhancementSpot(conn, allowingGate(), { spotName: "ZMCP_SPOT", description: "A spot", affects: AFFECTS }),
    );
    expect(err.code).toBe("CHECK_FAILED");
  });

  it("throws when readOnly gate refuses the write, before any network call", async () => {
    const { conn, inner } = await connected(combine(...enhFluidRoutes("create_spot", { created: true })));
    const readOnlyGate = new SafetyGate({ readOnly: true, allowPackages: [ENH_CREATE_PACKAGE], writesLockedOut: false });
    const err = await catchErr(
      createEnhancementSpot(conn, readOnlyGate, { spotName: "ZMCP_SPOT", description: "A spot", affects: AFFECTS }),
    );
    expect(err).toBeTruthy();
    expect(inner.calls.length).toBe(0);
  });

  it("activate:false sends activate:false to the fluid body, skips the spot activation and returns no activation", async () => {
    const activationCalls: HttpClientOptions[] = [];
    const route = combine(
      (o: HttpClientOptions) => {
        if (o.url.includes("/sap/bc/adt/activation")) activationCalls.push(o);
        return undefined;
      },
      ...enhFluidRoutes("create_spot", { created: true }),
    );
    const { conn, inner } = await connected(route);
    const result = await createEnhancementSpot(conn, allowingGate(), {
      spotName: "ZMCP_SPOT",
      description: "A spot",
      affects: AFFECTS,
      activate: false,
    });
    expect(result.transcript.tags).toEqual(["SPOT-OBJECT-CREATED"]);
    expect(result.activation).toBeUndefined();
    // Fluid deploy path only (runtime class + body + invoker) — no explicit spot activation.
    expect(activationCalls.length).toBe(3);
    const args = {
      spot_name: "ZMCP_SPOT",
      description: "A spot",
      package_name: ENH_CREATE_PACKAGE,
      corr_nr: "",
      activate: false,
    };
    expect(createdInvoker(inner, expectedInvokerName("create_spot", args))).toBe(true);
  });

  it("a transportable packageName resolves the request through the session transport and reports it", async () => {
    const CREATED = "A4HK900123";
    const PKG = "ZMCP_PKG";
    const trCreate = vi.fn(async () => ({ trkorr: CREATED, path: `/com.sap.cts/object_record/${CREATED}` }));
    const trRequirement = vi.fn(async (_conn: unknown, uri: string, devclass: string) => ({
      uri,
      operation: "I",
      devclass,
      candidates: [],
      locks: [],
      messages: [],
      checkFailed: false,
      raw: { result: "S", korrflag: "X", recording: "" },
      kind: "transport-required",
      mustSupplyCorrNr: true,
      serverWouldFabricate: false,
    }));
    const transport = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate: () =>
        new SafetyGate({ readOnly: false, allowPackages: ["*"] }).authorize("transport", { name: PKG, packageName: PKG }, { corr: { kind: "unresolved" } }),
      whoami: () => "DEVELOPER",
      cts: { trCreate, trRequirement } as never,
    });
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: [ENH_CREATE_PACKAGE, ENH_BRIDGE_PACKAGE, PKG],
      allowNamePrefixes: ["*"],
      writesLockedOut: false,
      allowEnhancements: true,
      enhanceTargets: "customer",
      originSystems: ["TST"],
      allowTransports: ["auto"],
    });
    const { conn, inner } = await connected(combine(...enhFluidRoutes("create_spot", { created: true })));
    const result = await createEnhancementSpot(conn, gate, {
      spotName: "ZMCP_SPOT",
      description: "A spot",
      affects: AFFECTS,
      packageName: PKG,
      transport,
    });
    expect(trCreate).toHaveBeenCalledTimes(1);
    expect(result.corr).toEqual({ corrNr: CREATED, source: "auto" });
    const args = {
      spot_name: "ZMCP_SPOT",
      description: "A spot",
      package_name: PKG,
      corr_nr: CREATED,
      activate: true,
    };
    expect(createdInvoker(inner, expectedInvokerName("create_spot", args))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// addBadiDefinition — exercises the H21 marker-interface-ensure step
// ---------------------------------------------------------------------------

describe("addBadiDefinition", () => {
  it("creates the marker interface (H21) before dispatching add_badi_def", async () => {
    const route = combine(objectHappyPath(INTF_COLLECTION, "ZIF_MCP_BADI"), ...enhFluidRoutes("add_badi_def", { added: true }));
    const { conn, inner } = await connected(route);
    const { transcript } = await addBadiDefinition(conn, allowingGate(), {
      spotName: "ZMCP_SPOT",
      badiName: "ZMCP_BADI",
      interfaceName: "ZIF_MCP_BADI",
      singleUse: true,
      shortText: "Test BAdI",
      affects: AFFECTS,
    });
    expect(transcript.tags).toEqual(["BADI-DEF-ADDED"]);
    const interfacePut = inner.calls.find(
      (c) => c.url === `${INTF_COLLECTION}/zif_mcp_badi/source/main` && (c.method ?? "").toUpperCase() === "PUT",
    );
    expect(interfacePut).toBeTruthy();
    expect(String(interfacePut?.body)).toContain("INTERFACES if_badi_interface.");
  });

  it("dispatches add_badi_def with the exact args, including corr_nr and activate", async () => {
    const args = {
      spot_name: "ZMCP_SPOT",
      badi_name: "ZMCP_BADI",
      interface_name: "ZIF_MCP_BADI",
      single_use: true,
      short_text: "Test BAdI",
      package_name: ENH_CREATE_PACKAGE,
      corr_nr: "",
      activate: true,
    };
    const route = combine(objectHappyPath(INTF_COLLECTION, "ZIF_MCP_BADI"), ...enhFluidRoutes("add_badi_def", { added: true }));
    const { conn, inner } = await connected(route);
    await addBadiDefinition(conn, allowingGate(), {
      spotName: "ZMCP_SPOT",
      badiName: "ZMCP_BADI",
      interfaceName: "ZIF_MCP_BADI",
      singleUse: true,
      shortText: "Test BAdI",
      affects: AFFECTS,
    });
    expect(createdInvoker(inner, expectedInvokerName("add_badi_def", args))).toBe(true);
  });

  it("a transportable packageName is gated against the BAdI the intent names, not the spot CTS records", async () => {
    const CREATED = "A4HK900123";
    const PKG = "ZMCP_PKG";
    const trCreate = vi.fn(async () => ({ trkorr: CREATED, path: `/com.sap.cts/object_record/${CREATED}` }));
    const trRequirement = vi.fn(async (_conn: unknown, uri: string, devclass: string) => ({
      uri,
      operation: "I",
      devclass,
      candidates: [],
      locks: [],
      messages: [],
      checkFailed: false,
      raw: { result: "S", korrflag: "X", recording: "" },
      kind: "transport-required",
      mustSupplyCorrNr: true,
      serverWouldFabricate: false,
    }));
    const transport = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate: () =>
        new SafetyGate({ readOnly: false, allowPackages: ["*"] }).authorize("transport", { name: PKG, packageName: PKG }, { corr: { kind: "unresolved" } }),
      whoami: () => "DEVELOPER",
      cts: { trCreate, trRequirement } as never,
    });
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: [ENH_CREATE_PACKAGE, ENH_BRIDGE_PACKAGE, PKG],
      allowNamePrefixes: ["*"],
      writesLockedOut: false,
      allowEnhancements: true,
      enhanceTargets: "customer",
      originSystems: ["TST"],
      allowTransports: ["auto"],
    });
    const route = combine(objectHappyPath(INTF_COLLECTION, "ZIF_MCP_BADI"), ...enhFluidRoutes("add_badi_def", { added: true }));
    const { conn, inner } = await connected(route);
    const result = await addBadiDefinition(conn, gate, {
      spotName: "ZMCP_SPOT",
      badiName: "ZMCP_BADI",
      interfaceName: "ZIF_MCP_BADI",
      singleUse: true,
      shortText: "Test BAdI",
      affects: { ...AFFECTS, packageName: PKG },
      packageName: PKG,
      transport,
    });
    expect(result.corr).toEqual({ corrNr: CREATED, source: "auto" });
    // One request for the spot; the marker interface write reuses it (no second trCreate).
    expect(trCreate).toHaveBeenCalledTimes(1);
    expect(trRequirement.mock.calls.map((c) => c[2])).toEqual([PKG, PKG]);
    expect(
      inner.calls.some((c) => c.url === `${INTF_COLLECTION}/zif_mcp_badi/source/main` && (c.method ?? "").toUpperCase() === "PUT"),
    ).toBe(true);
    const args = {
      spot_name: "ZMCP_SPOT",
      badi_name: "ZMCP_BADI",
      interface_name: "ZIF_MCP_BADI",
      single_use: true,
      short_text: "Test BAdI",
      package_name: PKG,
      corr_nr: CREATED,
      activate: true,
    };
    expect(createdInvoker(inner, expectedInvokerName("add_badi_def", args))).toBe(true);
  });

  // Same defect class as createBadiImplementation's L17/ZTM_HW011B_IMPL
  // regression (see enhancement-bridge.ts's module header,
  // "isActive-vs-adtcore:version"): addBadiDefinition's epilogue re-saves the
  // SPOT inline, ABAP-side, only. This proves a separate, genuine POST
  // /sap/bc/adt/activation now fires against the SPOT (not badiName, which
  // has no ADT object/URI of its own — it is an entry within the spot's
  // document).
  it("also performs a separate, genuine activation of the spot after adding the definition — not just the inline epilogue (isActive-vs-adtcore:version regression)", async () => {
    const activationCalls: HttpClientOptions[] = [];
    const route = combine(
      (o: HttpClientOptions) => {
        if (o.url.includes("/sap/bc/adt/activation")) activationCalls.push(o);
        return undefined;
      },
      objectHappyPath(INTF_COLLECTION, "ZIF_MCP_BADI"),
      ...enhFluidRoutes("add_badi_def", { added: true }),
    );
    const { conn } = await connected(route);
    const result = await addBadiDefinition(conn, allowingGate(), {
      spotName: "ZMCP_SPOT",
      badiName: "ZMCP_BADI",
      interfaceName: "ZIF_MCP_BADI",
      singleUse: true,
      shortText: "Test BAdI",
      affects: AFFECTS,
    });
    expect(result.transcript.tags).toEqual(["BADI-DEF-ADDED"]);
    expect(result.activation).toBeDefined();
    expect(result.activation.activated).toBe(true);
    expect(result.activation.errors).toBe(0);
    // H21 marker-interface activation (1) + the fluid deploy path's three
    // activations (FLUID_RUNTIME_CLASS, ZCL_ZMCP_FLUID_ENH, invoker) +
    // the explicit post-write activation of the spot itself (1) = 5.
    expect(activationCalls.length).toBe(5);
    const spotActivation = activationCalls.find((c) => String(c.body).toLowerCase().includes("zmcp_spot"));
    expect(spotActivation).toBeTruthy();
  });

  it("reports added + activation.activated:false (does not throw) when the post-write spot activation fails", async () => {
    const errorBody = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement", "455-activate-failure-syntax-error.xml"),
      "utf8",
    );
    let sawSpotActivation = false;
    const route = combine(
      (o: HttpClientOptions) => {
        if (o.url.includes("/sap/bc/adt/activation") && String(o.body).toLowerCase().includes("zmcp_spot")) {
          sawSpotActivation = true;
          return resp(200, errorBody, { "content-type": "application/xml" });
        }
        return undefined;
      },
      objectHappyPath(INTF_COLLECTION, "ZIF_MCP_BADI"),
      ...enhFluidRoutes("add_badi_def", { added: true }),
    );
    const { conn } = await connected(route);
    const result = await addBadiDefinition(conn, allowingGate(), {
      spotName: "ZMCP_SPOT",
      badiName: "ZMCP_BADI",
      interfaceName: "ZIF_MCP_BADI",
      singleUse: true,
      shortText: "Test BAdI",
      affects: AFFECTS,
    });
    expect(sawSpotActivation).toBe(true);
    expect(result.transcript.tags).toEqual(["BADI-DEF-ADDED"]);
    expect(result.activation.activated).toBe(false);
    expect(result.activation.errors).toBe(1);
  });

  it("throws CHECK_FAILED when the fluid result's added flag is false", async () => {
    const route = combine(objectHappyPath(INTF_COLLECTION, "ZIF_MCP_BADI"), ...enhFluidRoutes("add_badi_def", { added: false }));
    const { conn } = await connected(route);
    const err = await catchErr(
      addBadiDefinition(conn, allowingGate(), {
        spotName: "ZMCP_SPOT",
        badiName: "ZMCP_BADI",
        interfaceName: "ZIF_MCP_BADI",
        singleUse: true,
        shortText: "Test BAdI",
        affects: AFFECTS,
      }),
    );
    expect(err.code).toBe("CHECK_FAILED");
  });

  it("skips writing the marker interface when one already exists (never overwrites)", async () => {
    const intfUrl = `${INTF_COLLECTION}/zif_mcp_badi`;
    const route = combine(
      (o: HttpClientOptions) =>
        o.url === intfUrl && (o.method ?? "GET").toUpperCase() === "GET"
          ? resp(
              200,
              `<intf:abapInterface xmlns:intf="http://www.sap.com/adt/oo/interfaces" ` +
                `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZIF_MCP_BADI" ` +
                `adtcore:type="INTF/OI"><adtcore:packageRef adtcore:name="$TMP"/></intf:abapInterface>`,
              { "content-type": "application/xml" },
            )
          : undefined,
      ...enhFluidRoutes("add_badi_def", { added: true }),
    );
    const { conn, inner } = await connected(route);
    await addBadiDefinition(conn, allowingGate(), {
      spotName: "ZMCP_SPOT",
      badiName: "ZMCP_BADI",
      interfaceName: "ZIF_MCP_BADI",
      singleUse: true,
      shortText: "Test BAdI",
      affects: AFFECTS,
    });
    const interfacePut = inner.calls.find(
      (c) => c.url === `${intfUrl}/source/main` && (c.method ?? "").toUpperCase() === "PUT",
    );
    expect(interfacePut).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createBadiImplementation
// ---------------------------------------------------------------------------

describe("createBadiImplementation", () => {
  it("dispatches create_impl through the fluid enh body; reports both success tags", async () => {
    const route = combine(...enhFluidRoutes("create_impl", { created: true, impl_added: true, filter_check: "no_filters" }));
    const { conn } = await connected(route);
    const { transcript } = await createBadiImplementation(conn, allowingGate(), {
      enhName: "ZMCP_ENH_BADI",
      spotName: "ZMCP_SPOT",
      badiName: "ZMCP_BADI",
      implName: "ZMCP_IMPL",
      implClass: "ZCL_MCP_IMPL",
      description: "Test implementation",
      active: true,
      affects: AFFECTS,
    });
    expect(transcript.tags).toEqual(["ENHO-OBJECT-CREATED", "IMPL-ADDED", "BADI-NO-FILTERS"]);
  });

  it("dispatches create_impl with the exact args, including corr_nr and activate", async () => {
    const args = {
      enh_name: "ZMCP_ENH_BADI",
      spot_name: "ZMCP_SPOT",
      badi_name: "ZMCP_BADI",
      impl_name: "ZMCP_IMPL",
      impl_class: "ZCL_MCP_IMPL",
      active: true,
      description: "Test implementation",
      package_name: ENH_CREATE_PACKAGE,
      corr_nr: "",
      activate: true,
    };
    const route = combine(...enhFluidRoutes("create_impl", { created: true, impl_added: true, filter_check: "no_filters" }));
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
    expect(createdInvoker(inner, expectedInvokerName("create_impl", args))).toBe(true);
  });

  it("throws CHECK_FAILED when the fluid result's created flag is false", async () => {
    const { conn } = await connected(combine(...enhFluidRoutes("create_impl", { created: false, impl_added: false, filter_check: "no_filters" })));
    const err = await catchErr(
      createBadiImplementation(conn, allowingGate(), {
        enhName: "ZMCP_ENH_BADI",
        spotName: "ZMCP_SPOT",
        badiName: "ZMCP_BADI",
        implName: "ZMCP_IMPL",
        implClass: "ZCL_MCP_IMPL",
        description: "Test implementation",
        active: true,
        affects: AFFECTS,
      }),
    );
    expect(err.code).toBe("CHECK_FAILED");
  });

  // Regression for the L17/ZTM_HW011B_IMPL field report: a caller called
  // create_impl with active:true, then read the object back and found
  // activationStatus:'inactive' despite enho:isActive='true' — the epilogue's
  // inline ABAP-side activate() (SAVE/ACTIVATE/UNLOCK, run inside the
  // classrun) sets the runtime dispatch flag but does not reliably promote
  // adtcore:version. The only working fix available at the time was to call
  // write_description(activate:true) with a fabricated, unrelated description
  // change purely to reach that function's own separate `activateObject`
  // call. This test proves createBadiImplementation now performs that same
  // genuine, separate `POST /sap/bc/adt/activation` itself — real fixture
  // 391 (test/fixtures/enhancement/391-activate-success-enhoxh.meta.json)
  // independently captured this exact request/response shape working live
  // against an enhoxh object ("does ADT activation work on a BAdI
  // implementation?" -> yes, 200/empty body).
  it("also performs a separate, genuine activation of the newly created implementation — not just the inline epilogue (field-evidence regression)", async () => {
    const activationCalls: HttpClientOptions[] = [];
    const route = combine(
      (o: HttpClientOptions) => {
        if (o.url.includes("/sap/bc/adt/activation")) activationCalls.push(o);
        return undefined;
      },
      ...enhFluidRoutes("create_impl", { created: true, impl_added: true, filter_check: "no_filters" }),
    );
    const { conn } = await connected(route);
    const result = await createBadiImplementation(conn, allowingGate(), {
      enhName: "ZMCP_ENH_BADI",
      spotName: "ZMCP_SPOT",
      badiName: "ZMCP_BADI",
      implName: "ZMCP_IMPL",
      implClass: "ZCL_MCP_IMPL",
      description: "Test implementation",
      active: true,
      affects: AFFECTS,
    });
    expect(result.transcript.tags).toEqual(["ENHO-OBJECT-CREATED", "IMPL-ADDED", "BADI-NO-FILTERS"]);
    expect(result.activation).toBeDefined();
    expect(result.activation.activated).toBe(true);
    expect(result.activation.errors).toBe(0);
    // The fluid deploy path's own three activations (FLUID_RUNTIME_CLASS,
    // ZCL_ZMCP_FLUID_ENH, and the content-hash invoker) + the explicit
    // post-create activation of the created ENHO/XH implementation itself
    // (1) = 4 distinct /sap/bc/adt/activation calls. Before the fix this was
    // 1: only the bridge class was ever activated, never the object
    // create_impl actually creates.
    expect(activationCalls.length).toBe(4);
    const implActivation = activationCalls.find((c) => String(c.body).toLowerCase().includes("zmcp_enh_badi"));
    expect(implActivation).toBeTruthy();
  });

  // create_impl must distinguish "created but not activated" from "not
  // created": a caller's next move differs completely (retry activation,
  // e.g. via abap_activate, vs. investigate why creation itself failed). The
  // classrun already succeeded (ENHO-OBJECT-CREATED + IMPL-ADDED both
  // present) by the time the new activation call below runs, so a failure
  // there must be reported, not thrown as if nothing was created. Uses the
  // same real captured error body (fixture 455) the H23 joint-activation
  // tests below use for the identical assertion on a different call site.
  it("reports created + activation.activated:false (does not throw) when the post-create activation fails", async () => {
    const errorBody = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement", "455-activate-failure-syntax-error.xml"),
      "utf8",
    );
    let sawImplActivation = false;
    const route = combine(
      (o: HttpClientOptions) => {
        if (o.url.includes("/sap/bc/adt/activation") && String(o.body).toLowerCase().includes("zmcp_enh_badi")) {
          sawImplActivation = true;
          return resp(200, errorBody, { "content-type": "application/xml" });
        }
        return undefined;
      },
      ...enhFluidRoutes("create_impl", { created: true, impl_added: true, filter_check: "no_filters" }),
    );
    const { conn } = await connected(route);
    const result = await createBadiImplementation(conn, allowingGate(), {
      enhName: "ZMCP_ENH_BADI",
      spotName: "ZMCP_SPOT",
      badiName: "ZMCP_BADI",
      implName: "ZMCP_IMPL",
      implClass: "ZCL_MCP_IMPL",
      description: "Test implementation",
      active: true,
      affects: AFFECTS,
    });
    expect(sawImplActivation).toBe(true);
    // Creation is reported regardless — this must not throw.
    expect(result.transcript.tags).toEqual(["ENHO-OBJECT-CREATED", "IMPL-ADDED", "BADI-NO-FILTERS"]);
    expect(result.activation.activated).toBe(false);
    expect(result.activation.errors).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// setFilterValues — H23: inline activate + separate joint activation
// ---------------------------------------------------------------------------

describe("setFilterValues", () => {
  it("performs the inline epilogue AND a separate joint spot+impl activation", async () => {
    const activationCalls: HttpClientOptions[] = [];
    const route = combine(
      (o: HttpClientOptions) => {
        if (o.url.includes("/sap/bc/adt/activation")) activationCalls.push(o);
        return undefined;
      },
      ...enhFluidRoutes("set_filter_values", { replaced: true }),
    );
    const { conn } = await connected(route);
    // This is the ONE call site here that actually reaches the joint POST, so
    // rather than the shared no-op it records when the hook fired — proving the
    // seam is real and ordered, not merely a parameter that is accepted and
    // dropped. `activationCalls.length` at the moment of the hook must be 3:
    // the fluid deploy path's three activations (FLUID_RUNTIME_CLASS,
    // ZCL_ZMCP_FLUID_ENH, invoker) have happened, the joint POST has not.
    let hookFiredAfterNActivations: number | undefined;
    const { transcript, jointActivation } = await setFilterValues(conn, allowingGate(), {
      enhName: "ZMCP_ENH_BADI",
      spotName: "ZMCP_SPOT",
      implName: "ZMCP_IMPL",
      filterName: "FLT",
      filterType: "C",
      compare: "=",
      value: "ALPHA",
      affects: AFFECTS,
      onJointActivation: async () => {
        hookFiredAfterNActivations = activationCalls.length;
      },
    });
    expect(transcript.tags).toEqual(["IMPL-REPLACED"]);
    expect(jointActivation.activated).toBe(true);
    expect(jointActivation.errors).toBe(0);
    // The fluid deploy path's own three activations (FLUID_RUNTIME_CLASS,
    // ZCL_ZMCP_FLUID_ENH, invoker) + the joint spot/impl activation (1) = 4
    // distinct /sap/bc/adt/activation calls, proving H23's second activation
    // actually fired.
    expect(activationCalls.length).toBe(4);
    expect(hookFiredAfterNActivations, "onJointActivation must fire BEFORE the joint POST, after the fluid deploy path's own activations").toBe(3);
  });

  it("dispatches set_filter_values with the exact args, including corr_nr and activate", async () => {
    const args = {
      enh_name: "ZMCP_ENH_BADI",
      impl_name: "ZMCP_IMPL",
      filter_name: "FLT",
      filter_type: "C",
      compare: "=",
      value: "ALPHA",
      package_name: ENH_CREATE_PACKAGE,
      corr_nr: "",
      activate: true,
    };
    const { conn, inner } = await connected(combine(...enhFluidRoutes("set_filter_values", { replaced: true })));
    await setFilterValues(conn, allowingGate(), {
      enhName: "ZMCP_ENH_BADI",
      spotName: "ZMCP_SPOT",
      implName: "ZMCP_IMPL",
      filterName: "FLT",
      filterType: "C",
      compare: "=",
      value: "ALPHA",
      affects: AFFECTS,
      onJointActivation: noJournalHook,
    });
    expect(createdInvoker(inner, expectedInvokerName("set_filter_values", args))).toBe(true);
  });

  it("throws CHECK_FAILED when the fluid result's replaced flag is false", async () => {
    const { conn } = await connected(combine(...enhFluidRoutes("set_filter_values", { replaced: false })));
    const err = await catchErr(
      setFilterValues(conn, allowingGate(), {
        enhName: "ZMCP_ENH_BADI",
        spotName: "ZMCP_SPOT",
        implName: "ZMCP_IMPL",
        filterName: "FLT",
        filterType: "C",
        compare: "=",
        value: "ALPHA",
        affects: AFFECTS,
        onJointActivation: noJournalHook,
      }),
    );
    expect(err.code).toBe("CHECK_FAILED");
  });

  it("activateSpotAndImplementation posts both object references in one call, matching fixture 491's exact shape — regression guard for the fixture-1119 400", async () => {
    const activationRequests: HttpClientOptions[] = [];
    const route = combine((o: HttpClientOptions) => {
      if (o.url.includes("/sap/bc/adt/activation")) {
        activationRequests.push(o);
        return resp(200, "", { "content-length": "0" });
      }
      return sharedRoute(classrunOutput([]))(o);
    });
    const { conn } = await connected(route);
    const outcome = await activateSpotAndImplementation(conn, authorizeActivate(allowingGate(), "ZMCP_ENH_BADI"), [
      { name: "ZMCP_SPOT", uri: "/sap/bc/adt/enhancements/enhsxs/zmcp_spot" },
      { name: "ZMCP_ENH_BADI", uri: "/sap/bc/adt/enhancements/enhoxh/zmcp_enh_badi" },
    ], noJournalHook);
    expect(outcome.activated).toBe(true);
    expect(activationRequests.length).toBe(1);
    const req = activationRequests[0];
    const body = String(req.body);
    expect(body).toContain("zmcp_spot");
    expect(body).toContain("zmcp_enh_badi");
    // Fixture 1119 proved the vendor array-form's adtcore:type=""/
    // adtcore:parentUri="" attributes are NOT harmless — SAP hard-400s on
    // them ("Check of condition failed"). The hand-rolled body must never
    // carry either attribute again.
    expect(body).not.toContain("adtcore:type");
    expect(body).not.toContain("adtcore:parentUri");
    // Byte-for-byte fixture 491's request shape: only uri+name, no separator
    // between the two <adtcore:objectReference> elements.
    expect(body).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">` +
        `<adtcore:objectReference adtcore:uri="/sap/bc/adt/enhancements/enhsxs/zmcp_spot" adtcore:name="ZMCP_SPOT"/>` +
        `<adtcore:objectReference adtcore:uri="/sap/bc/adt/enhancements/enhoxh/zmcp_enh_badi" adtcore:name="ZMCP_ENH_BADI"/>` +
        `</adtcore:objectReferences>`,
    );
    expect((req.qs as Record<string, string> | undefined)?.method).toBe("activate");
    expect((req.qs as Record<string, string> | undefined)?.preauditRequested).toBe("true");
  });

  it("hand-parses a chkl:messages error response (real captured bytes, fixture 455) into a NOT-activated outcome", async () => {
    const errorBody = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement", "455-activate-failure-syntax-error.xml"),
      "utf8",
    );
    const route = combine((o: HttpClientOptions) => {
      if (o.url.includes("/sap/bc/adt/activation")) {
        return resp(200, errorBody, { "content-type": "application/xml" });
      }
      return sharedRoute(classrunOutput([]))(o);
    });
    const { conn } = await connected(route);
    const outcome = await activateSpotAndImplementation(conn, authorizeActivate(allowingGate(), "ZMCP_ENH_BADI"), [
      { name: "ZMCP_SPOT", uri: "/sap/bc/adt/enhancements/enhsxs/zmcp_spot" },
      { name: "ZMCP_ENH_BADI", uri: "/sap/bc/adt/enhancements/enhoxh/zmcp_enh_badi" },
    ], noJournalHook);
    expect(outcome.activated).toBe(false);
    expect(outcome.errors).toBe(1);
    expect(outcome.messages).toHaveLength(1);
    expect(outcome.messages[0].severity).toBe("E");
    expect(outcome.messages[0].text).toContain("cannot be converted to a character-like value");
    // The real position lives in the href fragment (#start=26,49), not the
    // message ordinal (@line="1") — mapActivationMessages must have read it
    // through parseStartFragment, same as every other activation path.
    expect(outcome.messages[0].line).toBe(26);
    expect(outcome.messages[0].col).toBe(49);
  });

  it("wraps a thrown 400 (fixture 1119's captured exception body) into an ADT_ERROR, same as the pre-fix try/catch did", async () => {
    const exceptionBody = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "fixtures",
        "enhancement",
        "badi",
        "1119-post-activation-activate.xml",
      ),
      "utf8",
    );
    const route = combine((o: HttpClientOptions) => {
      if (o.url.includes("/sap/bc/adt/activation")) {
        const r = resp(400, exceptionBody, { "content-type": "application/xml" }, "Bad Request");
        throw new HttpClientException("Request failed with status code 400", "ERR_BAD_REQUEST", 400, undefined, o, r);
      }
      return sharedRoute(classrunOutput([]))(o);
    });
    const { conn } = await connected(route);
    const err = await catchErr(
      activateSpotAndImplementation(conn, authorizeActivate(allowingGate(), "ZMCP_DFX_ENHO"), [
        { name: "ZMCP_DFX_SPOT", uri: "/sap/bc/adt/enhancements/enhsxs/zmcp_dfx_spot" },
        { name: "ZMCP_DFX_ENHO", uri: "/sap/bc/adt/enhancements/enhoxh/zmcp_dfx_enho" },
      ], noJournalHook),
    );
    expect(err.code).toBe("ADT_ERROR");
    expect(err.message).toContain("ZMCP_DFX_SPOT");
    expect(err.message).toContain("ZMCP_DFX_ENHO");
  });

  it("hand-parses an <ioc:inactiveObjects> response (vendor shape, never independently captured — see module header) into inactive dependents", async () => {
    const inactiveBody =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects">` +
      `<ioc:entry><ioc:object ioc:deleted="false" ioc:user="TESTUSER">` +
      `<ioc:ref xmlns:adtcore="http://www.sap.com/adt/core" adtcore:uri="/sap/bc/adt/oo/classes/zcl_dep" ` +
      `adtcore:type="CLAS/OC" adtcore:name="ZCL_DEP" adtcore:parentUri=""/>` +
      `</ioc:object></ioc:entry></ioc:inactiveObjects>`;
    const route = combine((o: HttpClientOptions) => {
      if (o.url.includes("/sap/bc/adt/activation")) {
        return resp(200, inactiveBody, { "content-type": "application/xml" });
      }
      return sharedRoute(classrunOutput([]))(o);
    });
    const { conn } = await connected(route);
    const outcome = await activateSpotAndImplementation(conn, authorizeActivate(allowingGate(), "ZMCP_ENH_BADI"), [
      { name: "ZMCP_SPOT", uri: "/sap/bc/adt/enhancements/enhsxs/zmcp_spot" },
      { name: "ZMCP_ENH_BADI", uri: "/sap/bc/adt/enhancements/enhoxh/zmcp_enh_badi" },
    ], noJournalHook);
    expect(outcome.activated).toBe(false);
    expect(outcome.inactive).toEqual([
      { name: "ZCL_DEP", type: "CLAS/OC", uri: "/sap/bc/adt/oo/classes/zcl_dep" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// exerciseBadi — gated as "execute", not waved through as read-only
// ---------------------------------------------------------------------------

describe("exerciseBadi", () => {
  it("writes and activates the bridge class even though its ABAP never mutates an enhancement object", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.exercise),
      sharedRoute(classrunOutput(["EXERCISED"])),
    );
    const { conn, inner } = await connected(route);
    const { transcript } = await exerciseBadi(conn, allowingGate(), {
      badiName: "ZMCP_BADI",
      methodName: "RUN",
      params: [{ name: "IV_ARG", value: "hello" }],
      affects: AFFECTS,
    });
    expect(transcript.tags).toEqual(["EXERCISED"]);
    expect(inner.calls.some((c) => (c.method ?? "").toUpperCase() === "PUT")).toBe(true);
  });

  it("is refused outright under a readOnly gate — execute is not a read-only exemption", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.exercise),
      sharedRoute(classrunOutput(["EXERCISED"])),
    );
    const { conn, inner } = await connected(route);
    const readOnlyGate = new SafetyGate({ readOnly: true, allowPackages: [ENH_CREATE_PACKAGE], writesLockedOut: false });
    const err = await catchErr(
      exerciseBadi(conn, readOnlyGate, {
        badiName: "ZMCP_BADI",
        methodName: "RUN",
        params: [],
        affects: AFFECTS,
      }),
    );
    expect(err).toBeTruthy();
    expect(inner.calls.length).toBe(0);
  });

  // Regression (SAP Note 944559, ENH_BADI_REFRESH_BUFFER): a NOT-BOUND
  // transcript tag (GET BADI left the handle unbound; CALL BADI was never
  // attempted, per exerciseFragment's own IS BOUND guard) must produce a
  // named ENHANCEMENT_NOT_DISPATCHING diagnosis, not the generic "expected
  // marker EXERCISED, got: ..." message assertEnhTranscript would otherwise
  // emit for any other missing-tag case.
  it("throws ENHANCEMENT_NOT_DISPATCHING (not a generic missing-tag error) when the transcript says NOT-BOUND", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.exercise),
      sharedRoute(classrunOutput(["NOT-BOUND"])),
    );
    const { conn } = await connected(route);
    const err = await catchErr(
      exerciseBadi(conn, allowingGate(), {
        badiName: "ZMCP_BADI",
        methodName: "RUN",
        params: [{ name: "IV_ARG", value: "hello" }],
        affects: AFFECTS,
      }),
    );
    expect(err.code).toBe("ENHANCEMENT_NOT_DISPATCHING");
    expect(err.message).toMatch(/GET BADI produced no implementation reference/);
    expect(err.message).toMatch(/944559/);
    expect(err.message).toMatch(/ENH_BADI_REFRESH_BUFFER/);
    expect(err.message).toContain("RUN was never called");
  });
});

// ---------------------------------------------------------------------------
// addFilterDefinition — smoke test for the last of the six operations
// ---------------------------------------------------------------------------

describe("addFilterDefinition", () => {
  it("dispatches add_filter_def through the fluid enh body and reports FILTER-DEF-ADDED", async () => {
    const { conn } = await connected(combine(...enhFluidRoutes("add_filter_def", { added: true })));
    const { transcript } = await addFilterDefinition(conn, allowingGate(), {
      spotName: "ZMCP_SPOT",
      badiName: "ZMCP_BADI",
      filterName: "FLT",
      filterType: "C",
      filterText: "A filter",
      affects: AFFECTS,
    });
    expect(transcript.tags).toEqual(["FILTER-DEF-ADDED"]);
  });

  it("dispatches add_filter_def with the exact args, including corr_nr and activate", async () => {
    const args = {
      spot_name: "ZMCP_SPOT",
      badi_name: "ZMCP_BADI",
      filter_name: "FLT",
      filter_type: "C",
      filter_text: "A filter",
      package_name: ENH_CREATE_PACKAGE,
      corr_nr: "",
      activate: true,
    };
    const { conn, inner } = await connected(combine(...enhFluidRoutes("add_filter_def", { added: true })));
    await addFilterDefinition(conn, allowingGate(), {
      spotName: "ZMCP_SPOT",
      badiName: "ZMCP_BADI",
      filterName: "FLT",
      filterType: "C",
      filterText: "A filter",
      affects: AFFECTS,
    });
    expect(createdInvoker(inner, expectedInvokerName("add_filter_def", args))).toBe(true);
  });

  it("throws CHECK_FAILED when the fluid result's added flag is false", async () => {
    const { conn } = await connected(combine(...enhFluidRoutes("add_filter_def", { added: false })));
    const err = await catchErr(
      addFilterDefinition(conn, allowingGate(), {
        spotName: "ZMCP_SPOT",
        badiName: "ZMCP_BADI",
        filterName: "FLT",
        filterType: "C",
        filterText: "A filter",
        affects: AFFECTS,
      }),
    );
    expect(err.code).toBe("CHECK_FAILED");
  });

  // Same defect class as createBadiImplementation's L17/ZTM_HW011B_IMPL
  // regression (see enhancement-bridge.ts's module header,
  // "isActive-vs-adtcore:version"): addFilterDefinition's epilogue re-saves
  // the SPOT inline, ABAP-side, only. This proves a separate, genuine POST
  // /sap/bc/adt/activation now fires against the SPOT.
  it("also performs a separate, genuine activation of the spot after adding the filter — not just the inline epilogue (isActive-vs-adtcore:version regression)", async () => {
    const activationCalls: HttpClientOptions[] = [];
    const route = combine(
      (o: HttpClientOptions) => {
        if (o.url.includes("/sap/bc/adt/activation")) activationCalls.push(o);
        return undefined;
      },
      ...enhFluidRoutes("add_filter_def", { added: true }),
    );
    const { conn } = await connected(route);
    const result = await addFilterDefinition(conn, allowingGate(), {
      spotName: "ZMCP_SPOT",
      badiName: "ZMCP_BADI",
      filterName: "FLT",
      filterType: "C",
      filterText: "A filter",
      affects: AFFECTS,
    });
    expect(result.transcript.tags).toEqual(["FILTER-DEF-ADDED"]);
    expect(result.activation).toBeDefined();
    expect(result.activation.activated).toBe(true);
    expect(result.activation.errors).toBe(0);
    // The fluid deploy path's own three activations (FLUID_RUNTIME_CLASS,
    // ZCL_ZMCP_FLUID_ENH, invoker) + the explicit post-write activation of
    // the spot itself (1) = 4. Before the fix this was 1.
    expect(activationCalls.length).toBe(4);
    const spotActivation = activationCalls.find((c) => String(c.body).toLowerCase().includes("zmcp_spot"));
    expect(spotActivation).toBeTruthy();
  });

  // Coordinator-flagged judgment call, worked out rather than assumed: does
  // adding a filter DEFINITION need H23's JOINT spot+implementation
  // activation, the way setFilterValues (which sets filter VALUES on an
  // IMPLEMENTATION) does? No — proven here by shape, not just asserted in a
  // comment. `activateObject`'s single-object wire form (vendor
  // `conn.adt.activate(name, uri, ...)`, the "isString" branch of
  // node_modules/abap-adt-api/build/api/activate.js) emits exactly ONE
  // `<adtcore:objectReference>` element with no `adtcore:type`/`adtcore:parentUri`
  // attributes; `activateSpotAndImplementation`'s hand-rolled H23 joint body
  // (`buildJointActivationBody`) always emits exactly TWO. This asserts the
  // activation call addFilterDefinition makes has the single-object shape —
  // if a future change accidentally routed this through the joint helper
  // instead (plausible: both involve "filter"), this test would catch it.
  it("activates the spot with a single-object call, NOT H23's joint spot+implementation form", async () => {
    const activationCalls: HttpClientOptions[] = [];
    const route = combine(
      (o: HttpClientOptions) => {
        if (o.url.includes("/sap/bc/adt/activation")) activationCalls.push(o);
        return undefined;
      },
      ...enhFluidRoutes("add_filter_def", { added: true }),
    );
    const { conn } = await connected(route);
    await addFilterDefinition(conn, allowingGate(), {
      spotName: "ZMCP_SPOT",
      badiName: "ZMCP_BADI",
      filterName: "FLT",
      filterType: "C",
      filterText: "A filter",
      affects: AFFECTS,
    });
    const spotActivation = activationCalls.find((c) => String(c.body).toLowerCase().includes("zmcp_spot"));
    expect(spotActivation).toBeTruthy();
    // Note: match on `<adtcore:objectReference ` (trailing space) not just
    // `<adtcore:objectReference` — the latter also matches the plural wrapper
    // element `<adtcore:objectReferences>` itself (it's a string prefix),
    // which silently double-counted a single-object body as 2.
    const refCount = (String(spotActivation?.body).match(/<adtcore:objectReference /g) ?? []).length;
    expect(refCount).toBe(1);
    expect(String(spotActivation?.body)).not.toContain("adtcore:type=");
  });

  it("reports added + activation.activated:false (does not throw) when the post-write spot activation fails", async () => {
    const errorBody = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement", "455-activate-failure-syntax-error.xml"),
      "utf8",
    );
    let sawSpotActivation = false;
    const route = combine(
      (o: HttpClientOptions) => {
        if (o.url.includes("/sap/bc/adt/activation") && String(o.body).toLowerCase().includes("zmcp_spot")) {
          sawSpotActivation = true;
          return resp(200, errorBody, { "content-type": "application/xml" });
        }
        return undefined;
      },
      ...enhFluidRoutes("add_filter_def", { added: true }),
    );
    const { conn } = await connected(route);
    const result = await addFilterDefinition(conn, allowingGate(), {
      spotName: "ZMCP_SPOT",
      badiName: "ZMCP_BADI",
      filterName: "FLT",
      filterType: "C",
      filterText: "A filter",
      affects: AFFECTS,
    });
    expect(sawSpotActivation).toBe(true);
    expect(result.transcript.tags).toEqual(["FILTER-DEF-ADDED"]);
    expect(result.activation.activated).toBe(false);
    expect(result.activation.errors).toBe(1);
  });
});

// The "execute is gated on its own, after write+activate succeed" describe
// block that lived here was deleted along with `ExecuteDenyingGate` above —
// see that deletion's comment for why the behavior it proved no longer
// exists for these five operations under the fluid dispatch() reroute.
