/**
 * Classic-view (`VIEW/DV`) create bridge — offline. Nothing here touches SAP;
 * the transport is faked through `ConnectionOptions.httpClient`, using
 * `test/helpers/fluid-classic-fake.ts`'s shared `classicFake` for the fluid
 * `classic` tool's ensure/deploy/classrun cycle (see that helper's header for
 * why one fake now serves every classic-bridge suite, replacing this file's
 * own former `objectHappyPath`/`classrunOutput` routing).
 *
 * `create_view`'s ABAP is now static — `src/adt/fluid/builtin/classic/
 * abap-view.ts`'s `viewPart` serves every call, with `$TMP` vs a
 * transportable package picked by an `IF lv_local = abap_true.` branch at
 * ABAP runtime, not by generating different TS-side text per call. That
 * moves several of this file's old per-argument comparisons (a `$TMP`
 * fragment vs a `ZTM` fragment, a caller's literal field names baked into
 * `ls_dd27p-viewfield`, a description quote-escaped into a literal, ...) out
 * of reach of an offline test: those are pinned structurally against
 * `viewPart.source` instead, or — where the claim is genuinely about runtime
 * behaviour rather than generated text — proven end to end through
 * `classicFake`. Each conversion is called out in place, with a short "why".
 *
 * What these tests are FOR, in the order the module's risks run:
 *
 *  1. generator/parser drift — every tag `create_view` writes is a tag
 *     `parseDdicTranscript` knows;
 *  2. the closed-template defence — a quote, a period, a newline or a space
 *     in any identifier is refused before `createClassicView` ever reaches
 *     the wire (not escaped, not stripped);
 *  3. the safety gate on `VIEW/DV` — reached, and only reached, after
 *     `assertClassicViewCreateTarget` has already refused a bad
 *     package/corrNr pairing zero-network;
 *  4. the `sy-subrc` guard between each `CALL FUNCTION` and its success tag —
 *     these FMs report failure through classic EXCEPTIONS, which no
 *     `CATCH cx_root` sees, so an unconditional tag would report success for
 *     a call that did nothing;
 *  5. a failing transcript (empty output, or a `ZMCP-DDIC-ERR>` line) is a
 *     failure, not a success with nothing to say;
 *  6. `$TMP` and a real package now generate the SAME static source —
 *     `RS_CORR_INSERT`/`VIEW-REGISTERED` fire unconditionally, `korrnum` the
 *     only thing the local/transportable branch picks, for every package,
 *     not just `$TMP`;
 *  7. corrNr threaded into `RS_CORR_INSERT`'s KORRNUM;
 *  8. the static source itself, and the happy path proving it end to end,
 *     with the right content-hashed invoker actually deployed.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate, type Operation, type SafetyTarget, type EvaluateOptions } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import {
  DDIC_ERR_PREFIX,
  DDIC_TAGS,
  assertDdicTranscript,
  parseDdicTranscript,
  type DdicTag,
} from "../src/adt/ddic-transcript.js";
import {
  assertClassicViewCreateTarget,
  createClassicView,
  type ClassicViewParams,
} from "../src/adt/view-create.js";
import { viewPart } from "../src/adt/fluid/builtin/classic/abap-view.js";
import { CLASSIC_BODY_CLASS, CLASSIC_TOOL_ID } from "../src/adt/fluid/builtin/classic.js";
import { isLocalPackageName } from "../src/adt/transports.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { forgetManifest } from "../src/adt/fluid/registry.js";
import { systemKey } from "../src/journal.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { classicFake, useFluidState } from "./helpers/fluid-classic-fake.js";

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

const fluidState = useFluidState();

beforeEach(async () => {
  // In-memory singletons the fluid deploy path memoizes across calls within
  // one process — without this, a later test can see a stale "already
  // deployed" verdict left by an earlier test's own (separate) classicFake.
  resetFluidEnsureState();
  resetFluidPackageMemo();
  // The fluid registry is an on-disk cache keyed by stateDir, and every test
  // in this file shares one stateDir (useFluidState() memoizes it per file).
  // Without this, the first test's deploy leaves a "classic is already at
  // this version" cache entry that makes every later test's own (empty,
  // per-test) classicFake skip the deploy entirely.
  await forgetManifest(cfg(), systemKey(cfg()), CLASSIC_TOOL_ID);
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
    stateDir: fluidState.dir(),
  });

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

const SESSION_URL = "/sap/bc/adt/compatibility/graph";

/** Session/discovery plumbing shared by every test below — deploy/classrun routing is `classicFake`'s job. */
const sharedRoute = (o: HttpClientOptions): HttpClientResponse | undefined => {
  if (o.url.includes(SESSION_URL)) {
    return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
  }
  if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
  return undefined;
};

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

/** A fresh classicFake wired for create_view, answering with the given tags. */
const createFake = (tags: readonly string[] = ["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"]) =>
  classicFake({ action: "create_view", lines: () => tags });

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!e || !isAbapError(e)) throw new Error(`expected an AbapError, got ${String(e)}`);
  return e;
};

const catchSync = (fn: () => unknown): AbapError => {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected an AbapError to be thrown");
};

/**
 * Allows every package this suite writes into: `$TMP`/`ZTM` for the view
 * itself, `FLUID_PACKAGE` for the fluid tool's own deploy plumbing — two
 * different objects, judged by two different `assertBridgeMutation` calls.
 */
const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP", "ZTM", FLUID_PACKAGE],
    allowNamePrefixes: ["*"],
    allowTransports: ["auto", CORR_NR],
    writesLockedOut: false,
  });

/**
 * Denies `VIEW/DV` and nothing else. `$TMP`/`FLUID_PACKAGE` are allowlisted
 * for everything else, so this can only be refusing the view itself, not the
 * fluid tool's own deploy-plumbing gate.
 */
class ViewDenyingGate extends SafetyGate {
  override assert(op: Operation, obj?: SafetyTarget, opts: EvaluateOptions = {}): void {
    if (obj?.type === "VIEW/DV") {
      throw new AbapError("SAFETY_DENIED", "VIEW/DV denied by test gate", { operation: op });
    }
    super.assert(op, obj, opts);
  }
}

const viewDenyingGate = (): SafetyGate =>
  new ViewDenyingGate({ readOnly: false, allowPackages: ["$TMP", FLUID_PACKAGE], writesLockedOut: false });

/**
 * A null connection IS the assertion: any code path that reaches the wire
 * before refusing throws a TypeError instead of the `BAD_INPUT`/
 * `TRANSPORT_ERROR` these tests expect. Same device as `test/write.test.ts`'s
 * `offline`.
 */
const offline = null as unknown as AbapConnection;

/** A syntactically valid TRKORR — the shape `isTrkorr` (src/adt/transports.ts) accepts. */
const CORR_NR = "A4HK900121";

const VIEW: ClassicViewParams = {
  viewName: "ZTM_V_CARRIER",
  baseTable: "SCARR",
  fields: ["MANDT", "CARRID", "CARRNAME"],
  description: "Carrier projection",
  packageName: "ZTM",
  corrNr: CORR_NR,
};

const LOCAL_VIEW: ClassicViewParams = { ...VIEW, packageName: "$TMP", corrNr: undefined };

// `create_view`'s method body, sliced out of the static class source once —
// every structural assertion below reads this slice, not a per-call
// generated fragment (see this file's header).
const allSourceLines = viewPart.source.split("\n");
const createIdx = allSourceLines.findIndex((l) => l.trim() === "METHOD create_view.");
const deleteIdx = allSourceLines.findIndex((l) => l.trim() === "METHOD delete_view.");
const createLines = allSourceLines.slice(createIdx, deleteIdx);
const createTrim = createLines.map((l) => l.trim());

/** Every `line( 'TAG' )` call in create_view's source, in emission order. */
function emittedTags(lines: readonly string[]): string[] {
  const found: string[] = [];
  for (const l of lines) {
    const m = /^line\( '([^']*)' \)\.$/.exec(l.trim());
    if (m?.[1] !== undefined) found.push(m[1]);
  }
  return found;
}

// ---------------------------------------------------------------------------
// 1 — generator/parser drift
// ---------------------------------------------------------------------------

describe("generator/parser drift", () => {
  // Old: two tests, one per package, generated from two different TS-side
  // calls that could in principle diverge. New: one static source serves
  // every package, so there is only one tag set to check, for everyone —
  // folded into a single test.
  it("emits exactly the tag SET createClassicView expects, for every package", () => {
    const tags = emittedTags(createLines);
    expect(new Set(tags)).toEqual(new Set(["VIEW-PUT", "VIEW-REGISTERED", "VIEW-ACTIVATED"]));
    expect(tags).toEqual(["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"]);
  });

  it("every tag create_view writes is one parseDdicTranscript recognises", () => {
    const tags = emittedTags(createLines);
    expect(tags.length).toBeGreaterThan(0);
    // The parser is the arbiter, not a copy of the tag list in this file:
    // feed create_view's own tags through it and require it to return them
    // all. A tag renamed on either side drops out here.
    const parsed = parseDdicTranscript(tags.join("\n"));
    expect(parsed.tags).toEqual(tags);
    expect(parsed.errorLine).toBeUndefined();
    for (const tag of tags) expect(DDIC_TAGS).toContain(tag as DdicTag);
  });

  it("assertDdicTranscript is satisfied by create_view's own success output", () => {
    const tags = emittedTags(createLines);
    expect(() =>
      assertDdicTranscript(parseDdicTranscript(tags.join("\n")), tags as DdicTag[], "Creating classic view"),
    ).not.toThrow();
  });

  it("create_view's own sy-subrc error lines parse as an error, not as a tag", () => {
    // `fail()` calls `line( |ZMCP-DDIC-ERR> ...| )` — the interpolated form
    // can't be evaluated here, but its literal prefix is what the parser
    // keys on: prove the prefix `fail` uses is the prefix the parser strips.
    expect(createTrim).toContain(
      "fail( |RS_CORR_INSERT failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).",
    );
    const parsed = parseDdicTranscript(`${DDIC_ERR_PREFIX} DDIF_VIEW_PUT failed, sy-subrc=4`);
    expect(parsed.tags).toEqual([]);
    expect(parsed.errorLine).toContain("DDIF_VIEW_PUT failed");
  });
});

// ---------------------------------------------------------------------------
// 2 — closed template / injection
// ---------------------------------------------------------------------------

describe("closed template — an injection is refused, never escaped, before any request", () => {
  const bad = ["bad'name", "bad.name", "bad\nname", "bad name"];

  // Asserted through createClassicView(offline, ...): assertEnhIdentifier
  // refuses these regardless of package/corrNr, and validate() runs before
  // any network access, so a null connection is proof enough that nothing
  // reached the wire — same device section 3 below uses with a live route.
  for (const value of bad) {
    it(`refuses viewName ${JSON.stringify(value)} with BAD_INPUT, with no connection to reach`, async () => {
      const err = await catchErr(
        createClassicView(offline, allowingGate(), { ...LOCAL_VIEW, viewName: value }),
      );
      expect(err.code).toBe("BAD_INPUT");
    });

    it(`refuses baseTable ${JSON.stringify(value)} with BAD_INPUT, with no connection to reach`, async () => {
      const err = await catchErr(
        createClassicView(offline, allowingGate(), { ...LOCAL_VIEW, baseTable: value }),
      );
      expect(err.code).toBe("BAD_INPUT");
    });

    it(`refuses a field ${JSON.stringify(value)} with BAD_INPUT, with no connection to reach`, async () => {
      const params = { ...LOCAL_VIEW, fields: ["CARRID", value] };
      const err = await catchErr(createClassicView(offline, allowingGate(), params));
      expect(err.code).toBe("BAD_INPUT");
    });

    it(`refuses packageName ${JSON.stringify(value)} with BAD_INPUT, with no connection to reach`, async () => {
      const err = await catchErr(
        createClassicView(offline, allowingGate(), { ...VIEW, packageName: value }),
      );
      expect(err.code).toBe("BAD_INPUT");
    });
  }

  it("refuses a description containing a newline — refused, not stripped", async () => {
    const err = await catchErr(
      createClassicView(offline, allowingGate(), { ...LOCAL_VIEW, description: "line1\nline2" }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("refuses an empty field list with BAD_INPUT", async () => {
    const err = await catchErr(createClassicView(offline, allowingGate(), { ...LOCAL_VIEW, fields: [] }));
    expect(err.code).toBe("BAD_INPUT");
  });

  it("refuses more fields than DD27P-OBJPOS's 4-character position can carry", async () => {
    const fields = Array.from({ length: 250 }, (_, i) => `F${i}`);
    const err = await catchErr(createClassicView(offline, allowingGate(), { ...LOCAL_VIEW, fields }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("OBJPOS");
  });
});

// The old generator embedded `description` as a TS-side ABAP string literal,
// doubling embedded quotes itself (`'Fritz''s view'`), and baked each
// caller's OBJPOS as a per-call zero-padded literal — both per-call
// generated text this file used to slice and compare directly. That
// generation step is gone: create_view is one static source, and both values
// are read at ABAP runtime (`s('description')`, a `WIDTH/PAD/ALIGN` string
// template over the loop index) — there is no TS-side literal left to assert
// against for a *specific* caller's input. What survives is that both are
// runtime reads, never per-call baked literals; escaping (`esc()`, in
// abap-core.ts) now happens once, on the output side, not here.
describe("description and OBJPOS are threaded as runtime reads, never per-call baked literals", () => {
  it("ls_dd25v-ddtext is assigned from lv_desc at runtime, never a quoted string literal", () => {
    expect(createTrim).toContain("ls_dd25v-ddtext     = lv_desc.");
    expect(createTrim.some((l) => /^ls_dd25v-ddtext\s*=\s*'/.test(l))).toBe(false);
  });

  it("OBJPOS is computed at runtime (WIDTH=4 PAD='0' ALIGN=RIGHT on the loop index), never a per-call baked literal", () => {
    expect(createTrim).toContain("ls_dd27p-objpos    = |{ lv_i WIDTH = 4 PAD = '0' ALIGN = RIGHT }|.");
    expect(createTrim.some((l) => /^ls_dd27p-objpos\s*=\s*'\d{4}'\.$/.test(l))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3 — the safety gate on VIEW/DV
// ---------------------------------------------------------------------------

describe("zero-network refusals ahead of the gate; the safety gate still governs the view", () => {
  it("refuses a local package given a corrNr as BAD_INPUT, with ZERO requests reaching the fake server", async () => {
    const { conn, inner } = await connected(combine(createFake().route, sharedRoute));
    const err = await catchErr(createClassicView(conn, allowingGate(), { ...LOCAL_VIEW, corrNr: CORR_NR }));
    expect(err.code).toBe("BAD_INPUT");
    expect(inner.calls.length).toBe(0);
  });

  it("refuses a transportable package given no corrNr as TRANSPORT_ERROR, with ZERO requests reaching the fake server", async () => {
    const { conn, inner } = await connected(combine(createFake().route, sharedRoute));
    const { corrNr: _drop, ...withoutCorr } = VIEW;
    const err = await catchErr(createClassicView(conn, allowingGate(), withoutCorr as ClassicViewParams));
    expect(err.code).toBe("TRANSPORT_ERROR");
    expect(inner.calls.length).toBe(0);
  });

  it("the safety gate still governs a VIEW/DV create — a gate that denies VIEW/DV makes createClassicView throw SAFETY_DENIED, with ZERO requests reaching the fake server", async () => {
    const { conn, inner } = await connected(combine(createFake().route, sharedRoute));
    const err = await catchErr(createClassicView(conn, viewDenyingGate(), LOCAL_VIEW));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(inner.calls.length).toBe(0);
  });

  it("the gate IS asked about the view — a permissive gate lets the create proceed to the wire", async () => {
    const seen: Operation[] = [];
    class RecordingGate extends SafetyGate {
      override assert(op: Operation, obj?: SafetyTarget, opts: EvaluateOptions = {}): void {
        if (obj?.type === "VIEW/DV") seen.push(op);
        super.assert(op, obj, opts);
      }
    }
    const gate = new RecordingGate({
      readOnly: false,
      allowPackages: ["$TMP", FLUID_PACKAGE],
      allowNamePrefixes: ["*"],
      writesLockedOut: false,
    });
    const { conn, inner } = await connected(combine(createFake().route, sharedRoute));
    await createClassicView(conn, gate, LOCAL_VIEW);
    // Both write and activate are gated — DDIF_VIEW_ACTIVATE runs inside the
    // same bridge execution as the write, so the view's own create asserts both.
    expect(seen).toEqual(["write", "activate"]);
    expect(inner.calls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4 — the sy-subrc guard
// ---------------------------------------------------------------------------

describe("the sy-subrc guard — a classic EXCEPTIONS failure is never tagged as success", () => {
  it("puts an `IF sy-subrc <> 0.` guard, with a RETURN and a fail(), between the DDIF_VIEW_PUT call and its success tag", () => {
    const callIdx = createTrim.indexOf("CALL FUNCTION 'DDIF_VIEW_PUT'");
    const tagIdx = createTrim.indexOf("line( 'VIEW-PUT' ).");
    expect(callIdx).toBeGreaterThanOrEqual(0);
    expect(tagIdx).toBeGreaterThan(callIdx);
    const between = createTrim.slice(callIdx, tagIdx);
    expect(between).toContain("IF sy-subrc <> 0.");
    // And the guard RETURNs, so a failed PUT can never fall through into the
    // activation step that follows. Registration (RS_CORR_INSERT) already ran
    // before this call, so this guard has nothing before it left to protect.
    expect(between).toContain("RETURN.");
    expect(between.some((l) => l.startsWith("fail( |DDIF_VIEW_PUT failed"))).toBe(true);
  });

  it("guards RS_CORR_INSERT and DDIF_VIEW_ACTIVATE the same way", () => {
    for (const [call, tag] of [
      ["CALL FUNCTION 'RS_CORR_INSERT'", "line( 'VIEW-REGISTERED' )."],
      ["CALL FUNCTION 'DDIF_VIEW_ACTIVATE'", "line( 'VIEW-ACTIVATED' )."],
    ] as const) {
      const callIdx = createTrim.indexOf(call);
      const tagIdx = createTrim.indexOf(tag);
      expect(callIdx).toBeGreaterThanOrEqual(0);
      expect(tagIdx).toBeGreaterThan(callIdx);
      expect(createTrim.slice(callIdx, tagIdx)).toContain("IF sy-subrc <> 0.");
    }
  });

  it("folds DDIF_VIEW_ACTIVATE's rc into sy-subrc — rc > 4 is a failure the guard must see", () => {
    const rcIdx = createTrim.indexOf("IF sy-subrc = 0 AND lv_rc > 4.");
    const callIdx = createTrim.indexOf("CALL FUNCTION 'DDIF_VIEW_ACTIVATE'");
    const tagIdx = createTrim.indexOf("line( 'VIEW-ACTIVATED' ).");
    expect(rcIdx).toBeGreaterThan(callIdx);
    expect(rcIdx).toBeLessThan(tagIdx);
  });
});

// ---------------------------------------------------------------------------
// 5 — a failing transcript is a failure
// ---------------------------------------------------------------------------

describe("a failing transcript is a failure, not a silent success", () => {
  const EXPECTED_TAGS = ["VIEW-PUT", "VIEW-ACTIVATED"] as DdicTag[];
  const check = (output: string): AbapError =>
    catchSync(() => assertDdicTranscript(parseDdicTranscript(output), EXPECTED_TAGS, "Creating classic view"));

  it("throws CHECK_FAILED on empty classrun output", () => {
    const err = check("");
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("did not report success");
  });

  it("throws CHECK_FAILED on a ZMCP-DDIC-ERR> line", () => {
    const err = check(`${DDIC_ERR_PREFIX} DDIF_VIEW_PUT failed, sy-subrc=5, DO123`);
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("DDIF_VIEW_PUT failed");
  });

  it("throws CHECK_FAILED when the PUT tag arrives but the activation tag does not", () => {
    const err = check("VIEW-PUT");
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("VIEW-ACTIVATED");
  });
});

// ---------------------------------------------------------------------------
// 6 — $TMP now matches a transportable package: RS_CORR_INSERT and
//     VIEW-REGISTERED fire for every package (the create-target lift)
// ---------------------------------------------------------------------------

/**
 * Round 5 (2026-08-14) skipped RS_CORR_INSERT for $TMP after a live run of an
 * unconditional call reproduced a headless-dialog CHECK_FAILED. Two further
 * live runs prove that reasoning wrong, not right: 2026-09-04 (transportable,
 * a real corr_nr) and 2026-09-05 (local, `$ZTMD_I09`, `korrnum = space`) both
 * registered cleanly, and the local registration is what let the delete
 * bridge remove the view afterwards. See `src/adt/view-create.ts`'s
 * `isLocalPackage` doc comment for the full account.
 */
describe("$TMP now emits RS_CORR_INSERT/VIEW-REGISTERED the same as a transportable package", () => {
  it("RS_CORR_INSERT and VIEW-REGISTERED are UNCONDITIONAL — one call site, one tag, for every package; only korrnum's value varies", () => {
    expect(createTrim.filter((l) => l === "CALL FUNCTION 'RS_CORR_INSERT'").length).toBe(1);
    expect(createTrim.filter((l) => l === "line( 'VIEW-REGISTERED' ).").length).toBe(1);
  });

  it("$-detection is `to_upper( lv_package ) CP '$*'` — matches any $-prefixed package, case-insensitively, not just $TMP", () => {
    // Same reading TS-side isLocalPackageName uses
    // (`packageName.trim().toUpperCase().startsWith("$")`): a leading `$`
    // after case-folding, nothing more specific to $TMP. This is what
    // $FOO/$tmp/$MYLOCAL being treated identically to $TMP now rests on —
    // there is no per-argument generated fragment left to compare
    // package-by-package (see this file's header), but the pattern-match
    // expression itself, by construction, generalises over every $-prefixed
    // value, and the two independent implementations agree below.
    expect(createTrim).toContain("DATA(lv_local) = boolc( to_upper( lv_package ) CP '$*' ).");
    for (const value of ["$TMP", "$tmp", "$FOO", "$MYLOCAL", "ZTM", ""]) {
      expect(isLocalPackageName(value)).toBe(/^\$/.test(value.toUpperCase()));
    }
  });

  it("both COMMIT WORK statements sit in the same relative placement regardless of package — one right after VIEW-PUT, one ending the method after VIEW-ACTIVATED", () => {
    expect(createTrim.filter((l) => l === "COMMIT WORK.").length).toBe(2);
    const putTagIdx = createTrim.indexOf("line( 'VIEW-PUT' ).");
    const activateTagIdx = createTrim.indexOf("line( 'VIEW-ACTIVATED' ).");
    expect(createTrim[putTagIdx + 1]).toBe("");
    expect(createTrim[putTagIdx + 2]).toBe("COMMIT WORK.");
    expect(createTrim[activateTagIdx + 1]).toBe("");
    expect(createTrim[activateTagIdx + 2]).toBe("COMMIT WORK.");
    expect(createTrim[activateTagIdx + 3]).toBe("ENDMETHOD.");
  });

  it("emits all three tags, in VIEW-REGISTERED, VIEW-PUT, VIEW-ACTIVATED order — the same set for $TMP and for a transportable package, proven end to end", async () => {
    for (const params of [LOCAL_VIEW, VIEW]) {
      const { conn } = await connected(combine(createFake().route, sharedRoute));
      const { transcript } = await createClassicView(conn, allowingGate(), params);
      expect(transcript.tags).toEqual(["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"]);
    }
  });
});

describe("assertClassicViewCreateTarget", () => {
  it("refuses a local package given a corrNr as BAD_INPUT, naming the package — reached with a null connection, i.e. zero network", async () => {
    const err = await catchErr(createClassicView(offline, allowingGate(), { ...LOCAL_VIEW, corrNr: CORR_NR }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("$TMP");
    expect(err.message).toContain("korrnum = space");
  });

  it("refuses a transportable package given no corrNr as TRANSPORT_ERROR, naming corr_nr — reached with a null connection, i.e. zero network", async () => {
    const { corrNr: _drop, ...withoutCorr } = VIEW;
    const err = await catchErr(createClassicView(offline, allowingGate(), withoutCorr as ClassicViewParams));
    expect(err.code).toBe("TRANSPORT_ERROR");
    expect(err.message).toContain("corr_nr");
  });

  it("refuses a malformed corrNr as BAD_INPUT — reached with a null connection, i.e. zero network", async () => {
    const err = await catchErr(createClassicView(offline, allowingGate(), { ...VIEW, corrNr: "not-a-request" }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("not-a-request");
  });

  it("refuses a malformed package name as BAD_INPUT, not TRANSPORT_ERROR, even with no corrNr — reached with a null connection, i.e. zero network", async () => {
    const err = await catchErr(
      createClassicView(offline, allowingGate(), { ...LOCAL_VIEW, packageName: "bad'name", corrNr: undefined }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("$TMP with no corrNr returns the validated name and throws nothing — the lift itself, asserted directly", () => {
    expect(assertClassicViewCreateTarget("$TMP", undefined)).toBe("$TMP");
  });

  it("a transportable package with a valid corrNr likewise returns the validated name and throws nothing", () => {
    expect(assertClassicViewCreateTarget("ZTM", CORR_NR)).toBe("ZTM");
  });
});

describe("isLocalPackageName", () => {
  it("agrees with the $-prefix rule for local packages", () => {
    for (const value of ["$TMP", "$tmp", "$MYLOCAL", " $Foo "]) {
      expect(isLocalPackageName(value)).toBe(true);
    }
  });

  it("disagrees for transportable/empty names", () => {
    for (const value of ["ZTM", ""]) {
      expect(isLocalPackageName(value)).toBe(false);
    }
  });
});

describe("any $-prefixed package behaves identically — $MYLOCAL is not special", () => {
  it("assertClassicViewCreateTarget refuses $MYLOCAL given a corrNr as BAD_INPUT, not TRANSPORT_ERROR — a local package has nothing for a request to attach to", () => {
    const err = catchSync(() => assertClassicViewCreateTarget("$MYLOCAL", CORR_NR));
    expect(err.code).toBe("BAD_INPUT");
  });
});

// ---------------------------------------------------------------------------
// 7 — corrNr / RS_CORR_INSERT's KORRNUM
// ---------------------------------------------------------------------------
//
// RS_CORR_INSERT with no request number opens CTS's own request-
// selection dynpro (SAPLSTRD 0352), which IF_OO_ADT_CLASSRUN cannot render —
// CHECK_FAILED, "No window system type specified", 100% of the time for any
// non-$TMP package. The fix threads a caller-supplied, already gate-judged
// TRKORR through as KORRNUM, mirroring package-create.ts's corrNr discipline.

describe("corrNr threaded into RS_CORR_INSERT's KORRNUM", () => {
  it("lv_corr reads corr_nr at runtime, and only ever feeds korrnum through the local/transportable branch — never a per-call baked literal", () => {
    expect(createTrim).toContain("DATA(lv_corr) = s( 'corr_nr' ).");
    expect(createTrim.some((l) => /^korrnum = '/.test(l))).toBe(false);
  });

  it("emits suppress_dialog = 'X' immediately after korrnum, inside RS_CORR_INSERT — korrnum alone did not suppress the dialog live", () => {
    const korrnumIdx = createTrim.indexOf("korrnum = lv_korrnum");
    const suppressIdx = createTrim.indexOf("suppress_dialog = 'X'");
    expect(korrnumIdx).toBeGreaterThanOrEqual(0);
    expect(suppressIdx).toBe(korrnumIdx + 1);
  });

  it("assertClassicViewCreateTarget does NOT itself require a corrNr for a non-$TMP package — that invariant belongs to createClassicView's own validate(), since a caller may still resolve one after this runs", () => {
    expect(() => assertClassicViewCreateTarget("ZTM", undefined)).not.toThrow();
    expect(assertClassicViewCreateTarget("ZTM", undefined)).toBe("ZTM");
  });

  it("createClassicView refuses a non-$TMP view with no corrNr as TRANSPORT_ERROR, with zero requests reaching the fake server — the target guard runs before dispatch ever reaches the wire", async () => {
    const { conn, inner } = await connected(combine(createFake().route, sharedRoute));
    const { corrNr: _drop, ...withoutCorr } = VIEW;
    const err = await catchErr(createClassicView(conn, allowingGate(), withoutCorr as ClassicViewParams));
    expect(err.code).toBe("TRANSPORT_ERROR");
    expect(inner.calls.length).toBe(0);
  });

  it("assertClassicViewCreateTarget refuses $TMP given a corrNr as BAD_INPUT — a $TMP view registers with korrnum = space, not on a transport request", () => {
    const err = catchSync(() => assertClassicViewCreateTarget("$TMP", CORR_NR));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("$TMP");
    expect(err.message).toContain("korrnum = space");
  });

  it("assertClassicViewCreateTarget refuses a malformed corrNr as BAD_INPUT", () => {
    const err = catchSync(() => assertClassicViewCreateTarget("ZTM", "not-a-request"));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("not-a-request");
  });
});

// ---------------------------------------------------------------------------
// 8 — the static source the create bridge deploys, and the happy path
// ---------------------------------------------------------------------------

describe("the static source the create bridge deploys", () => {
  it("carries the DDIF_VIEW_PUT/ACTIVATE parameter names, the generated DATA section, and RS_CORR_INSERT's local/transportable korrnum branch", () => {
    const body = createLines.join("\n");

    expect(body).toContain("CALL FUNCTION 'DDIF_VIEW_PUT'");
    expect(body).toContain("EXPORTING name = lv_view");
    expect(body).toContain("dd25v_wa = ls_dd25v");
    expect(body).toContain("TABLES    dd26v_tab = lt_dd26v");
    expect(body).toContain("dd27p_tab = lt_dd27p");
    expect(body).toContain(
      "EXCEPTIONS view_not_found = 1 name_inconsistent = 2 view_inconsistent = 3",
    );
    expect(body).toContain("put_failure = 4 put_refused = 5 OTHERS = 6.");
    expect(body).toContain("CALL FUNCTION 'DDIF_VIEW_ACTIVATE'");
    expect(body).toContain("IMPORTING rc = lv_rc");
    expect(body).toContain("EXCEPTIONS not_found = 1 put_failure = 2 OTHERS = 3.");

    // The DATA section, local to the method (create_view is now the only
    // place these types are declared — no class-level per-call generation).
    expect(body).toContain("DATA ls_dd25v TYPE dd25v.");
    expect(body).toContain("DATA lt_dd27p TYPE STANDARD TABLE OF dd27p.");

    // RS_CORR_INSERT and the korrnum local/transportable branch — the $TMP
    // lift; see the corrNr describe block above for the full IF/ELSE pin.
    expect(body).toContain("CALL FUNCTION 'RS_CORR_INSERT'");
    expect(body).toContain("korrnum = space");
    expect(body).toContain("korrnum = lv_korrnum");

    // Explicitly out of scope, and it must stay out: no SE54 wizard call is
    // ever generated here.
    expect(body).not.toContain("VIEW_MAINTENANCE_GENERATE");
    expect(body).not.toContain("SE55");
  });

  // The old generator wrote one `ls_dd27p-viewfield = '<FIELD>'.` line per
  // caller field, so a caller's actual field names were visible in the
  // generated text. That's gone: create_view is one static source, and
  // ls_dd27p-viewfield is assigned from lv_field, read out of the
  // `fields/<i>` JSON args at ABAP runtime inside a DO loop bounded by
  // n('fields'). There is no TS-side subject left to compare a caller's
  // literal field names against — what remains provable is the loop shape:
  // it runs n('fields') times, and each iteration assigns viewfield/
  // fieldname from that one lv_field, tabname from lv_table.
  it("projects one DD27P row per caller field, at ABAP runtime, in a DO...TIMES loop over n('fields') — never a per-call baked field-name literal", () => {
    const doIdx = createTrim.indexOf("lv_n = n( 'fields' ).");
    const enddoIdx = createTrim.indexOf("ENDDO.");
    expect(doIdx).toBeGreaterThanOrEqual(0);
    expect(enddoIdx).toBeGreaterThan(doIdx);
    const body = createTrim.slice(doIdx, enddoIdx);
    expect(body).toContain("lv_field = s( |fields/{ lv_i - 1 }| ).");
    expect(body).toContain("ls_dd27p-viewfield = lv_field.");
    expect(body).toContain("ls_dd27p-fieldname = lv_field.");
    expect(body).toContain("ls_dd27p-tabname   = lv_table.");
    expect(body).toContain("APPEND ls_dd27p TO lt_dd27p.");

    // DD26V carries the base table once, into TABPOS '0001' — every caller
    // field projects against that one root table, not one row each.
    expect(createTrim).toContain("ls_dd26v-tabname  = lv_table.");
    expect(createTrim).toContain("ls_dd26v-tabpos   = '0001'.");
    expect(createTrim.filter((l) => l === "ls_dd26v-tabname  = lv_table.").length).toBe(1);
  });
});

describe("createClassicView happy path — the create-target lift proven end to end", () => {
  it("resolves for $TMP — a $TMP create is no longer refused (the lift)", async () => {
    const { conn } = await connected(combine(createFake().route, sharedRoute));
    const { transcript, run } = await createClassicView(conn, allowingGate(), LOCAL_VIEW);
    expect(transcript.tags).toEqual(["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"]);
    expect(transcript.errorLine).toBeUndefined();
    expect(run.output).toContain("VIEW-REGISTERED");
  });

  it("resolves for ZTM (transportable, with corr_nr) when the fake classrun returns all three tags", async () => {
    const { conn } = await connected(combine(createFake().route, sharedRoute));
    const { transcript } = await createClassicView(conn, allowingGate(), VIEW);
    expect(transcript.tags).toEqual(["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"]);
    expect(transcript.errorLine).toBeUndefined();
  });

  it("a transcript missing VIEW-REGISTERED is CHECK_FAILED for a $TMP create too — the whole point of the lift", async () => {
    const { conn } = await connected(combine(createFake(["VIEW-PUT", "VIEW-ACTIVATED"]).route, sharedRoute));
    const err = await catchErr(createClassicView(conn, allowingGate(), LOCAL_VIEW));
    expect(err.code).toBe("CHECK_FAILED");
  });

  it("deploys a content-hashed invoker class (thin — JSON args + a call into the static body), and the static ZCL_ZMCP_FLUID_CLASSIC body it calls carries both create_view and delete_view — the fixed-class-name check this replaces (there is no more DDIC_BRIDGE_CLASS.createView; the invoker name is content-hash derived)", async () => {
    const fake = createFake();
    const { conn } = await connected(combine(fake.route, sharedRoute));
    await createClassicView(conn, allowingGate(), VIEW);
    const invoker = fake.invoker();
    expect(invoker).toBeTruthy();
    const invokerSource = fake.sourceOf(invoker!);
    expect(invokerSource).toContain("zcl_zmcp_fluid_classic=>run( iv_action = 'create_view'");
    const body = fake.sourceOf(CLASSIC_BODY_CLASS);
    expect(body).toBeTruthy();
    expect(body).toContain("METHOD create_view.");
    expect(body).toContain("METHOD delete_view.");
  });
});
