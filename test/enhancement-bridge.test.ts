/**
 * T15 create bridge — offline. Nothing here touches SAP; the transport is
 * faked through `ConnectionOptions.httpClient`, repeating `test/bopf-runtime.test.ts`'s
 * self-contained `RecordingClient`/`resp`/`connected`/`bridgeHappyPath`
 * pattern (that file's own header explains why each suite keeps its own
 * small copy rather than sharing one with `test/enhancement-write.test.ts`'s
 * heavier `FakeAdt`).
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
import { SafetyGate, type Operation, type SafetyTarget, type EvaluateOptions } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import {
  BRIDGE_CLASS,
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
import { createSpotFragment, exerciseFragment, createImplFragment } from "../src/adt/enhancement-templates.js";
import { enhancementIntentFor } from "../src/adt/write.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Fake transport — same shape as test/bopf-runtime.test.ts
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
    allowPackages: [ENH_CREATE_PACKAGE],
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

/**
 * Regression harness: `readOnly: true` denies `write` too,
 * so the existing `exerciseBadi` "readOnly gate" test proves execute is not
 * *exempt* from readOnly but cannot prove execute is gated *on its own* —
 * under a coarse readOnly gate the buggy pre-fix `writeActivateRunBridge`
 * (which ran the bridge class via a bare `runClass` call, with no
 * `gate.authorize("execute", ...)` at all) would still be refused, just at
 * the write step, never reaching the code path the fix touched.
 *
 * This gate isolates that: it delegates `write`/`activate` to a real,
 * permissive `SafetyGate` exactly like `allowingGate`, and denies only
 * `execute`. Under the fixed code, the write and activate calls hit the
 * wire and then `gate.authorize("execute", ...)` throws before `runClass`
 * is ever reached. Under the pre-fix code this override would never fire —
 * `runClass` would run unchecked and the classrun POST would appear in
 * `inner.calls` — so this is the one test shape that actually distinguishes
 * the two.
 */
class ExecuteDenyingGate extends SafetyGate {
  override assert(op: Operation, obj?: SafetyTarget, opts: EvaluateOptions = {}): void {
    if (op === "execute") {
      throw new AbapError("SAFETY_DENIED", "execute denied by test gate", { operation: op });
    }
    super.assert(op, obj, opts);
  }
}

const executeDenyingGate = (): SafetyGate =>
  new ExecuteDenyingGate({
    readOnly: false,
    allowPackages: [ENH_CREATE_PACKAGE],
    writesLockedOut: false,
    allowEnhancements: true,
    enhanceTargets: "customer",
    originSystems: ["TST"],
  });

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

    it(`setFilterValues refuses a parameter value containing a control character`, async () => {
      const { conn, inner } = await connected(combine(sharedRoute(classrunOutput([]))));
      const err = await catchErr(
        setFilterValues(conn, allowingGate(), {
          enhName: "ZMCP_ENH",
          spotName: "ZMCP_SPOT",
          implName: "ZMCP_IMPL",
          filterName: "FLT",
          filterType: "C",
          compare: "=",
          value: bad.includes("\n") ? bad : "ok",
          affects: AFFECTS,
          onJointActivation: noJournalHook,
        }),
      );
      // Only the newline case is guaranteed BAD_INPUT via `value`; the other
      // two bad strings are asserted through their own identifier fields
      // above. This test exists specifically for the "newline in free text"
      // half of H50 that assertEnhIdentifier's own tests do not cover.
      if (bad.includes("\n")) {
        expect(err.code).toBe("BAD_INPUT");
        expect(inner.calls.length).toBe(0);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// createSpotFragment — root-cause fix, the ENHS/XS sibling of
// createImplFragment's fix below: every enhancement spot this template
// creates must come out with a non-empty root description, or it is
// unwritable the moment it exists (enhancement-write.ts's
// assertDescriptionWillBePresent covers enhsxs explicitly). See
// CreateSpotParams' own doc comment in enhancement-templates.ts for the full
// story, including why its evidence is WEAKER than createImplFragment's own.
// ---------------------------------------------------------------------------

describe("createSpotFragment", () => {
  const BASE = { spotName: "ZMCP_SPOT" };

  it("emits if_enh_object_docu~set_shorttext with the description, right after the lo_def cast", () => {
    const lines = createSpotFragment({ ...BASE, description: "My spot" });
    const castIdx = lines.findIndex((l) => l.includes("lo_def ?= lo_spot."));
    const shortTextIdx = lines.findIndex((l) => l.includes("if_enh_object_docu~set_shorttext"));
    expect(castIdx).toBeGreaterThanOrEqual(0);
    expect(shortTextIdx).toBe(castIdx + 1);
    expect(lines[shortTextIdx]).toBe(`lo_spot->if_enh_object_docu~set_shorttext( 'My spot' ).`);
  });

  it("doubles an embedded single quote in the description (abapLiteral escaping)", () => {
    const lines = createSpotFragment({ ...BASE, description: "Fritz's spot" });
    const shortText = lines.find((l) => l.includes("if_enh_object_docu~set_shorttext"));
    expect(shortText).toBe(`lo_spot->if_enh_object_docu~set_shorttext( 'Fritz''s spot' ).`);
  });

  it("allows a period in the description — free text, not a bare identifier", () => {
    const lines = createSpotFragment({ ...BASE, description: "Handles doc. approval." });
    const shortText = lines.find((l) => l.includes("if_enh_object_docu~set_shorttext"));
    expect(shortText).toBe(`lo_spot->if_enh_object_docu~set_shorttext( 'Handles doc. approval.' ).`);
  });

  it("refuses a description containing a newline — not stripped, not silently accepted", () => {
    expect(() => createSpotFragment({ ...BASE, description: "line1\nline2" })).toThrow(AbapError);
    try {
      createSpotFragment({ ...BASE, description: "line1\nline2" });
      throw new Error("expected throw");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("BAD_INPUT");
    }
  });

  it("refuses a description containing a control character (e.g. NUL)", () => {
    try {
      createSpotFragment({ ...BASE, description: "bad desc" });
      throw new Error("expected throw");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("BAD_INPUT");
    }
  });

  it("refuses when description is omitted entirely — refused, never synthesised from spotName", () => {
    const { description: _drop, ...withoutDescription } = { ...BASE, description: "x" };
    try {
      // @ts-expect-error — intentionally omitting the required field to prove runtime refusal.
      createSpotFragment(withoutDescription);
      throw new Error("expected throw");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("BAD_INPUT");
    }
  });
});

// ---------------------------------------------------------------------------
// createImplFragment — root-cause fix: every ENHO/XH this template creates
// must come out with a non-empty root description, or it is unwritable
// (including un-deactivatable) the moment it exists. See CreateImplParams'
// own doc comment in enhancement-templates.ts for the full story.
// ---------------------------------------------------------------------------

describe("createImplFragment", () => {
  const BASE = {
    enhName: "ZMCP_ENH_BADI",
    spotName: "ZMCP_SPOT",
    badiName: "ZMCP_BADI",
    implName: "ZMCP_IMPL",
    implClass: "ZCL_MCP_IMPL",
    active: true,
  };

  it("emits if_enh_object_docu~set_shorttext with the description, right after set_spot_name", () => {
    const lines = createImplFragment({ ...BASE, description: "My BAdI impl" });
    const spotIdx = lines.findIndex((l) => l.includes("set_spot_name"));
    const shortTextIdx = lines.findIndex((l) => l.includes("if_enh_object_docu~set_shorttext"));
    expect(spotIdx).toBeGreaterThanOrEqual(0);
    expect(shortTextIdx).toBe(spotIdx + 1);
    expect(lines[shortTextIdx]).toBe(`lo_impl->if_enh_object_docu~set_shorttext( 'My BAdI impl' ).`);
    // Placed before add_implementation, matching abapGit's own ordering
    // (set_shorttext before the impl is added).
    const addImplIdx = lines.findIndex((l) => l.includes("add_implementation("));
    expect(shortTextIdx).toBeLessThan(addImplIdx);
  });

  it("doubles an embedded single quote in the description (abapLiteral escaping)", () => {
    const lines = createImplFragment({ ...BASE, description: "Fritz's BAdI" });
    const shortText = lines.find((l) => l.includes("if_enh_object_docu~set_shorttext"));
    expect(shortText).toBe(`lo_impl->if_enh_object_docu~set_shorttext( 'Fritz''s BAdI' ).`);
  });

  it("allows a period in the description — free text, not a bare identifier", () => {
    const lines = createImplFragment({ ...BASE, description: "Handles doc. approval." });
    const shortText = lines.find((l) => l.includes("if_enh_object_docu~set_shorttext"));
    expect(shortText).toBe(`lo_impl->if_enh_object_docu~set_shorttext( 'Handles doc. approval.' ).`);
  });

  it("refuses a description containing a newline — not stripped, not silently accepted", () => {
    expect(() => createImplFragment({ ...BASE, description: "line1\nline2" })).toThrow(AbapError);
    try {
      createImplFragment({ ...BASE, description: "line1\nline2" });
      throw new Error("expected throw");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("BAD_INPUT");
    }
  });

  it("refuses a description containing a control character (e.g. NUL)", () => {
    try {
      createImplFragment({ ...BASE, description: "bad desc" });
      throw new Error("expected throw");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("BAD_INPUT");
    }
  });

  it("refuses when description is omitted entirely — refused, never synthesised from enhName", () => {
    const { description: _drop, ...withoutDescription } = { ...BASE, description: "x" };
    try {
      // @ts-expect-error — intentionally omitting the required field to prove runtime refusal.
      createImplFragment(withoutDescription);
      throw new Error("expected throw");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("BAD_INPUT");
    }
  });
});

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
      BRIDGE_CLASS.createSpot,
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
  it("recognises every tag createSpotFragment's own generator emits", () => {
    const body = createSpotFragment({ spotName: "ZMCP_SPOT", description: "A spot" });
    const source = bridgeSource(BRIDGE_CLASS.createSpot, [], body);
    // The generator writes its tag via `out->write( 'SPOT-OBJECT-CREATED' ).`
    // — simulate the captured classrun transcript directly (LIST> stripped
    // upstream by run.ts before this parser ever sees it).
    expect(source).toContain("out->write( 'SPOT-OBJECT-CREATED' )");
    const result = parseEnhancementTranscript("SPOT-OBJECT-CREATED");
    expect(result.tags).toEqual(["SPOT-OBJECT-CREATED"]);
    expect(result.errorLine).toBeUndefined();
  });

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
  it("writes, activates, and runs the bridge; reports SPOT-OBJECT-CREATED", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.createSpot),
      sharedRoute(classrunOutput(["SPOT-OBJECT-CREATED"])),
    );
    const { conn, inner } = await connected(route);
    const { transcript } = await createEnhancementSpot(conn, allowingGate(), {
      spotName: "ZMCP_SPOT",
      description: "A spot",
      affects: AFFECTS,
    });
    expect(transcript.tags).toEqual(["SPOT-OBJECT-CREATED"]);
    const methods = inner.calls.map((c) => (c.method ?? "GET").toUpperCase());
    expect(methods).toContain("PUT");
    expect(inner.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
    // Regression: the generated class source actually sent over the wire
    // must declare its locals with `DATA`, not the bare declaration that
    // caused a real live syntax error, captured live.
    const sourcePut = inner.calls.find(
      (c) => (c.method ?? "").toUpperCase() === "PUT" &&
        c.url === `${CLASS_COLLECTION}/${BRIDGE_CLASS.createSpot.toLowerCase()}/source/main`,
    );
    expect(String(sourcePut?.body)).toContain("DATA lv_pkg TYPE devclass VALUE '$TMP'.");
  });

  // Same defect class as createBadiImplementation's L17/ZTM_HW011B_IMPL
  // regression (see this module's header, "isActive-vs-adtcore:version"):
  // createEnhancementSpot's epilogue is inline-ABAP-side only. This proves a
  // separate, genuine POST /sap/bc/adt/activation now fires against the
  // newly created spot itself, not just the bridge class.
  it("also performs a separate, genuine activation of the newly created spot — not just the inline epilogue (isActive-vs-adtcore:version regression)", async () => {
    const activationCalls: HttpClientOptions[] = [];
    const route = combine(
      (o: HttpClientOptions) => {
        if (o.url.includes("/sap/bc/adt/activation")) activationCalls.push(o);
        return undefined;
      },
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.createSpot),
      sharedRoute(classrunOutput(["SPOT-OBJECT-CREATED"])),
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
    // Bridge-class activation (1) + the new explicit post-create activation
    // of the spot itself (1) = 2 distinct /sap/bc/adt/activation calls.
    // Before the fix this was 1: only the bridge class was ever activated.
    expect(activationCalls.length).toBe(2);
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
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.createSpot),
      sharedRoute(classrunOutput(["SPOT-OBJECT-CREATED"])),
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

  it("throws when the transcript shows no success tag", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.createSpot),
      sharedRoute(classrunOutput(["SOMETHING-ELSE"])),
    );
    const { conn } = await connected(route);
    const err = await catchErr(
      createEnhancementSpot(conn, allowingGate(), { spotName: "ZMCP_SPOT", description: "A spot", affects: AFFECTS }),
    );
    expect(err.code).toBe("CHECK_FAILED");
  });

  it("throws when readOnly gate refuses the write, before any bridge-class network call", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.createSpot),
      sharedRoute(classrunOutput(["SPOT-OBJECT-CREATED"])),
    );
    const { conn, inner } = await connected(route);
    const readOnlyGate = new SafetyGate({ readOnly: true, allowPackages: [ENH_CREATE_PACKAGE], writesLockedOut: false });
    const err = await catchErr(
      createEnhancementSpot(conn, readOnlyGate, { spotName: "ZMCP_SPOT", description: "A spot", affects: AFFECTS }),
    );
    expect(err).toBeTruthy();
    expect(inner.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// addBadiDefinition — exercises the H21 marker-interface-ensure step
// ---------------------------------------------------------------------------

describe("addBadiDefinition", () => {
  it("creates the marker interface (H21) before writing the bridge class", async () => {
    const route = combine(
      objectHappyPath(INTF_COLLECTION, "ZIF_MCP_BADI"),
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.addBadiDef),
      sharedRoute(classrunOutput(["BADI-DEF-ADDED"])),
    );
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
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.addBadiDef),
      sharedRoute(classrunOutput(["BADI-DEF-ADDED"])),
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
    // H21 marker-interface activation (1) + bridge-class activation (1) +
    // the new explicit post-write activation of the spot itself (1) = 3.
    // Before the fix this was 2: the spot itself was never re-activated
    // out-of-band after the epilogue's inline save/activate.
    expect(activationCalls.length).toBe(3);
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
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.addBadiDef),
      sharedRoute(classrunOutput(["BADI-DEF-ADDED"])),
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

  // Regression for two bugs in the EXPORTING keyword handling, found
  // in sequence:
  //  1. The acquisition call mixed IMPORTING into a short-form call with no
  //     EXPORTING keyword, which ABAP's parser cannot disambiguate ("Unable
  //     to interpret IMPORTING", captured live). EXPORTING must be explicit
  //     whenever IMPORTING/CHANGING also appear.
  //  2. Adding EXPORTING alone was not enough: `spot` is a RETURNING
  //     parameter of `cl_enh_factory=>get_enhancement_spot`, not IMPORTING,
  //     as live fixture 893 proved once fix #1 let the source get far enough
  //     to activate ("Formal parameter \"SPOT\" is a RETURNING parameter,
  //     not a EXPORTING parameter"). The correct form is a plain functional
  //     call assigning the RETURNING value directly — matching fixture 486's
  //     independently captured source (`DATA(lo_spot) = cl_enh_factory=>
  //     get_enhancement_spot( spot_name = iv_spot ).`).
  it("acquires the spot via a functional call assigning the RETURNING value, not IMPORTING", async () => {
    const route = combine(
      objectHappyPath(INTF_COLLECTION, "ZIF_MCP_BADI"),
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.addBadiDef),
      sharedRoute(classrunOutput(["BADI-DEF-ADDED"])),
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
    const classPut = inner.calls.find(
      (c) =>
        c.url === `${CLASS_COLLECTION}/${BRIDGE_CLASS.addBadiDef.toLowerCase()}/source/main` &&
        (c.method ?? "").toUpperCase() === "PUT",
    );
    expect(classPut).toBeTruthy();
    expect(String(classPut?.body)).toContain(
      "lo_spot = cl_enh_factory=>get_enhancement_spot( spot_name = 'ZMCP_SPOT' lock = 'X' run_dark = abap_true ).",
    );
    expect(String(classPut?.body)).not.toContain("IMPORTING spot");
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
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.addBadiDef),
      sharedRoute(classrunOutput(["BADI-DEF-ADDED"])),
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
  it("writes, activates, and runs the bridge; reports both success tags", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.createImpl),
      sharedRoute(classrunOutput(["ENHO-OBJECT-CREATED", "IMPL-ADDED"])),
    );
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
    expect(transcript.tags).toEqual(["ENHO-OBJECT-CREATED", "IMPL-ADDED"]);
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
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.createImpl),
      sharedRoute(classrunOutput(["ENHO-OBJECT-CREATED", "IMPL-ADDED"])),
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
    expect(result.transcript.tags).toEqual(["ENHO-OBJECT-CREATED", "IMPL-ADDED"]);
    expect(result.activation).toBeDefined();
    expect(result.activation.activated).toBe(true);
    expect(result.activation.errors).toBe(0);
    // Bridge-class activation (1, from writeActivateRunBridge activating the
    // throwaway classrun bridge itself) + the new explicit post-create
    // activation of the created ENHO/XH implementation (1) = 2 distinct
    // /sap/bc/adt/activation calls. Before the fix this was 1: only the
    // bridge class was ever activated, never the object create_impl actually
    // creates.
    expect(activationCalls.length).toBe(2);
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
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.createImpl),
      sharedRoute(classrunOutput(["ENHO-OBJECT-CREATED", "IMPL-ADDED"])),
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
    expect(result.transcript.tags).toEqual(["ENHO-OBJECT-CREATED", "IMPL-ADDED"]);
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
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.setFilterValues),
      sharedRoute(classrunOutput(["IMPL-REPLACED"])),
    );
    const { conn } = await connected(route);
    // This is the ONE call site here that actually reaches the joint POST, so
    // rather than the shared no-op it records when the hook fired — proving the
    // seam is real and ordered, not merely a parameter that is accepted and
    // dropped. `activationCalls.length` at the moment of the hook must be 1: the
    // bridge class's own activation has happened, the joint POST has not.
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
    // Bridge-class activation (1) + joint spot/impl activation (1) = 2 distinct
    // /sap/bc/adt/activation calls, proving H23's second activation actually fired.
    expect(activationCalls.length).toBe(2);
    expect(hookFiredAfterNActivations, "onJointActivation must fire BEFORE the joint POST, after the bridge-class activation").toBe(1);
  });

  // Regression for the EXPORTING keyword bugs — see the
  // matching comment on addBadiDefinition's regression test above. `enhancement`
  // is likewise a RETURNING parameter of `cl_enh_factory=>get_enhancement`,
  // matching fixture 466's independently captured source (`lo_tool =
  // cl_enh_factory=>get_enhancement( enhancement_id = 'ZMCP_ENH_BADI'
  // lock = 'X' run_dark = abap_true ).`).
  it("acquires the enhancement via a functional call assigning the RETURNING value, not IMPORTING", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.setFilterValues),
      sharedRoute(classrunOutput(["IMPL-REPLACED"])),
    );
    const { conn, inner } = await connected(route);
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
    const classPut = inner.calls.find(
      (c) =>
        c.url === `${CLASS_COLLECTION}/${BRIDGE_CLASS.setFilterValues.toLowerCase()}/source/main` &&
        (c.method ?? "").toUpperCase() === "PUT",
    );
    expect(classPut).toBeTruthy();
    expect(String(classPut?.body)).toContain(
      "lo_tool = cl_enh_factory=>get_enhancement( enhancement_id = 'ZMCP_ENH_BADI' lock = 'X' run_dark = abap_true ).",
    );
    expect(String(classPut?.body)).not.toContain("IMPORTING enhancement");
  });

  // Regression — filter values must be deleted before re-adding: IF_ENH_TOOL_BADI_IMPL
  // has no in-place "modify filter values" — add_implementation means
  // "create new", so the existing implementation must be deleted first, or
  // add_implementation fails live with "Error while creating the enhancement
  // implementation" (reproduced identically across two fresh implementations,
  // regardless of singleUse true/false). Fixture 466's captured request body
  // is the reference sequence:
  // get_implementation, THEN delete_implementation, THEN CLEAR/populate/
  // add_implementation — this asserts the generated source matches that
  // sequence exactly, in order.
  it("deletes the existing implementation before recreating it with new filter values (fixture 466's sequence)", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.setFilterValues),
      sharedRoute(classrunOutput(["IMPL-REPLACED"])),
    );
    const { conn, inner } = await connected(route);
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
    const classPut = inner.calls.find(
      (c) =>
        c.url === `${CLASS_COLLECTION}/${BRIDGE_CLASS.setFilterValues.toLowerCase()}/source/main` &&
        (c.method ?? "").toUpperCase() === "PUT",
    );
    expect(classPut).toBeTruthy();
    const body = String(classPut?.body);
    expect(body).toContain("lo_impl->delete_implementation( impl_name = 'ZMCP_IMPL' ).");
    // Order matters: get -> delete -> clear -> ... -> add. A delete anywhere
    // else (e.g. after add_implementation) would not fix the bug.
    const getIdx = body.indexOf("ls_impl = lo_impl->get_implementation( impl_name = 'ZMCP_IMPL' ).");
    const deleteIdx = body.indexOf("lo_impl->delete_implementation( impl_name = 'ZMCP_IMPL' ).");
    const clearIdx = body.indexOf("CLEAR: ls_impl-filters, ls_impl-filter_values, ls_impl-filter_root, ls_impl-filter_tree.");
    const addIdx = body.indexOf("lo_impl->add_implementation( im_implementation = ls_impl ).");
    expect(getIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(getIdx);
    expect(clearIdx).toBeGreaterThan(deleteIdx);
    expect(addIdx).toBeGreaterThan(clearIdx);
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
  it("creates the marker interface's spot-side sibling flow and reports FILTER-DEF-ADDED", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.addFilterDef),
      sharedRoute(classrunOutput(["FILTER-DEF-ADDED"])),
    );
    const { conn } = await connected(route);
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
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.addFilterDef),
      sharedRoute(classrunOutput(["FILTER-DEF-ADDED"])),
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
    // Bridge-class activation (1) + the new explicit post-write activation of
    // the spot itself (1) = 2. Before the fix this was 1.
    expect(activationCalls.length).toBe(2);
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
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.addFilterDef),
      sharedRoute(classrunOutput(["FILTER-DEF-ADDED"])),
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
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.addFilterDef),
      sharedRoute(classrunOutput(["FILTER-DEF-ADDED"])),
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

  // Regression for the EXPORTING keyword bugs — see the
  // matching comment on addBadiDefinition's regression test above.
  it("acquires the spot via a functional call assigning the RETURNING value, not IMPORTING", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.addFilterDef),
      sharedRoute(classrunOutput(["FILTER-DEF-ADDED"])),
    );
    const { conn, inner } = await connected(route);
    await addFilterDefinition(conn, allowingGate(), {
      spotName: "ZMCP_SPOT",
      badiName: "ZMCP_BADI",
      filterName: "FLT",
      filterType: "C",
      filterText: "A filter",
      affects: AFFECTS,
    });
    const classPut = inner.calls.find(
      (c) =>
        c.url === `${CLASS_COLLECTION}/${BRIDGE_CLASS.addFilterDef.toLowerCase()}/source/main` &&
        (c.method ?? "").toUpperCase() === "PUT",
    );
    expect(classPut).toBeTruthy();
    expect(String(classPut?.body)).toContain(
      "lo_spot = cl_enh_factory=>get_enhancement_spot( spot_name = 'ZMCP_SPOT' lock = 'X' run_dark = abap_true ).",
    );
    expect(String(classPut?.body)).not.toContain("IMPORTING spot");
  });
});

// ---------------------------------------------------------------------------
// Regression — writeActivateRunBridge gates "execute"
// separately from "write"/"activate", for every function it backs
// ---------------------------------------------------------------------------

describe("execute is gated on its own, after write+activate succeed", () => {
  it("createEnhancementSpot: write and activate reach the wire, then execute is refused before classrun", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.createSpot),
      sharedRoute(classrunOutput(["SPOT-OBJECT-CREATED"])),
    );
    const { conn, inner } = await connected(route);
    const err = await catchErr(
      createEnhancementSpot(conn, executeDenyingGate(), { spotName: "ZMCP_SPOT", description: "A spot", affects: AFFECTS }),
    );
    expect(err.code).toBe("SAFETY_DENIED");
    const methods = inner.calls.map((c) => (c.method ?? "GET").toUpperCase());
    expect(methods).toContain("PUT");
    expect(inner.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(false);
  });

  it("addBadiDefinition: write and activate reach the wire, then execute is refused before classrun", async () => {
    const route = combine(
      objectHappyPath(INTF_COLLECTION, "ZIF_MCP_BADI"),
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.addBadiDef),
      sharedRoute(classrunOutput(["BADI-DEF-ADDED"])),
    );
    const { conn, inner } = await connected(route);
    const err = await catchErr(
      addBadiDefinition(conn, executeDenyingGate(), {
        spotName: "ZMCP_SPOT",
        badiName: "ZMCP_BADI",
        interfaceName: "ZIF_MCP_BADI",
        singleUse: true,
        shortText: "Test BAdI",
        affects: AFFECTS,
      }),
    );
    expect(err.code).toBe("SAFETY_DENIED");
    const methods = inner.calls.map((c) => (c.method ?? "GET").toUpperCase());
    expect(methods).toContain("PUT");
    expect(inner.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(false);
  });

  it("addFilterDefinition: write and activate reach the wire, then execute is refused before classrun", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.addFilterDef),
      sharedRoute(classrunOutput(["FILTER-DEF-ADDED"])),
    );
    const { conn, inner } = await connected(route);
    const err = await catchErr(
      addFilterDefinition(conn, executeDenyingGate(), {
        spotName: "ZMCP_SPOT",
        badiName: "ZMCP_BADI",
        filterName: "FLT",
        filterType: "C",
        filterText: "A filter",
        affects: AFFECTS,
      }),
    );
    expect(err.code).toBe("SAFETY_DENIED");
    const methods = inner.calls.map((c) => (c.method ?? "GET").toUpperCase());
    expect(methods).toContain("PUT");
    expect(inner.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(false);
  });

  it("createBadiImplementation: write and activate reach the wire, then execute is refused before classrun", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.createImpl),
      sharedRoute(classrunOutput(["ENHO-OBJECT-CREATED", "IMPL-ADDED"])),
    );
    const { conn, inner } = await connected(route);
    const err = await catchErr(
      createBadiImplementation(conn, executeDenyingGate(), {
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
    expect(err.code).toBe("SAFETY_DENIED");
    const methods = inner.calls.map((c) => (c.method ?? "GET").toUpperCase());
    expect(methods).toContain("PUT");
    expect(inner.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(false);
  });

  it("setFilterValues: write and activate reach the wire, then execute is refused before classrun", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE_CLASS.setFilterValues),
      sharedRoute(classrunOutput(["IMPL-REPLACED"])),
    );
    const { conn, inner } = await connected(route);
    const err = await catchErr(
      setFilterValues(conn, executeDenyingGate(), {
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
    expect(err.code).toBe("SAFETY_DENIED");
    const methods = inner.calls.map((c) => (c.method ?? "GET").toUpperCase());
    expect(methods).toContain("PUT");
    expect(inner.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(false);
  });
});
