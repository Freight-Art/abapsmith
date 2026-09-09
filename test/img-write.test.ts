/**
 * Tests for `src/adt/img-write.ts` — thin result-shaping wrappers over the
 * fluid `img` tool's three actions (`preview`, `apply`, `create_request`,
 * `fluid/builtin/img.ts`), each dispatched through `fluid/dispatch.ts`
 * against the shared `imgManifest.entry` body class. None of the three
 * deploys a per-function generated bridge class any more — the old
 * `ZCL_ZMCP_IMG_WAPPLY`/`ZCL_ZMCP_CTS_WREQ` bridges (`img-write-bridge.ts`/
 * `customizing-request.ts`) are retired; those modules now contribute only
 * plan validation and transcript parsing.
 *
 * Same harness shape as `test/img-tool.test.ts` (a `RecordingClient`
 * implementing `HttpClient` directly), with one addition: every call here
 * also goes through the package-existence check first, so every route below
 * also answers a GET on `FLUID_PACKAGE`'s package URI (modelled on
 * `test/helper-package.test.ts`'s `existingRoute` — the package already
 * exists, so no create POST is ever needed to reach the body class deploy).
 * Every describe block needs a fresh per-test `stateDir` and reset fluid
 * caches (`resetFluidEnsureState`/`resetFluidPackageMemo`) — `dispatch()`'s
 * deploy/activate wiring is memoized across calls, and a stale cache would
 * silently short-circuit the very network calls these tests assert on.
 * `test/helpers/fluid-img-fake.ts` carries the transcript-framing and
 * class-lifecycle fake shared with img-edit-tool.test.ts — see that file's
 * header for the frame grammar; `imgProbeConsole`'s `action` option picks
 * which of the three actions' BEGIN frame is being faked.
 *
 * Plan validation, ABAP fragment generation and transcript parsing are
 * already covered in `test/img-write-bridge.test.ts` and
 * `test/customizing-request.test.ts` (not modified here) — this file only
 * exercises what is unique to the orchestration layer: the deploy/activate/
 * execute wiring and the FLUID_PACKAGE target. All three actions now share
 * one body class and therefore one activation-failure hint — activate.ts's
 * generic `checkFailedError` default, via `discloseBridgeResidue` — so there
 * is no more bespoke per-bridge hint content to assert on (the retired
 * `runImgApply`/`runCreateCustomizingRequest` bridge-deploy code used to
 * rewrite that hint per bridge, including a special case recognizing an
 * "already declared" activation error as a generator defect; neither
 * `ensure.ts` nor `dispatch()` has an equivalent, so that per-error-content
 * hint rewrite is gone, not merely moved — see the activation-refusal tests
 * below).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  HttpClientException,
  type HttpClient,
  type HttpClientOptions,
  type HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { isAbapError } from "../src/adt/errors.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { imgManifest } from "../src/adt/fluid/builtin/img.js";
import { FLUID_RUNTIME_CLASS } from "../src/adt/fluid/abap/runtime.js";
import { type ImgApplyPlan, type ImgProbePlan } from "../src/adt/img-write-bridge.js";
import { type CustomizingRequestPlan } from "../src/adt/customizing-request.js";
import { runImgProbe, runImgApply, runCreateCustomizingRequest } from "../src/adt/img-write.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { dynamicImgFluidRoute, imgProbeConsole } from "./helpers/fluid-img-fake.js";

// ----------------------------------------------------------------------- harness ---

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-img-write-"));
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
): HttpClientResponse => ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

const SESSION_URL = "/sap/bc/adt/compatibility/graph";
const PKG_URI = "/sap/bc/adt/packages/%24abapsmith_fluid_api";

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const PACKAGE_XML = (name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" adtcore:type="DEVC/K">` +
  `<adtcore:packageRef adtcore:name="${name}" adtcore:type="DEVC/K"/>` +
  `<pak:superPackage adtcore:name="$TMP"/>` +
  `</pak:package>`;

/** Base routes every test needs regardless of which bridge class is being deployed: login, the FLUID_PACKAGE existence GET (already there — no create needed), and the two connect-time probes `AbapConnection.connect()` itself makes. */
function baseRoute(o: HttpClientOptions): HttpClientResponse | undefined {
  if (o.url.includes(SESSION_URL)) {
    return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
  }
  if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
  if (o.url === PKG_URI && (o.method ?? "GET").toUpperCase() === "GET") {
    return resp(200, PACKAGE_XML(FLUID_PACKAGE), { "content-type": "application/xml" });
  }
  return undefined;
}

/**
 * `dynamicImgFluidRoute` (test/helpers/fluid-img-fake.ts) only recognizes the
 * fluid img body class (`imgManifest.entry`) and its content-hash invoker —
 * it predates `img.ts` declaring the shared runtime class
 * (`FLUID_RUNTIME_CLASS`) as a manifest object of its own, deployed FIRST,
 * ahead of the body class (see `src/adt/fluid/ensure.ts`'s in-order deploy).
 * Left unhandled, every request for the runtime class's own lifecycle
 * (existence GET, create, LOCK/PUT/UNLOCK, activation) falls through
 * `dynamicImgFluidRoute` to whatever catch-all a route composes it with —
 * here a bare `resp(200, "<ok/>", ...)`, which lacks an
 * `<adtcore:packageRef>`, so `resolveWriteTarget` (src/adt/write.ts) throws
 * `packageUnknown` on the very first classify pass, before the body class
 * deploy is ever reached. This is the same auto-vivifying per-name state-
 * store idiom `test/helpers/fluid-classic-fake.ts`'s (ungated) `classicFake`
 * already uses successfully for the identical runtime-class-first shape in
 * the `classic` builtin's manifest — scoped here to just the one class name,
 * duplicated locally since `fluid-img-fake.ts` itself is out of scope to
 * change.
 */
function runtimeClassRoute(packageName: string): (o: HttpClientOptions) => HttpClientResponse | undefined {
  const classUri = `/sap/bc/adt/oo/classes/${FLUID_RUNTIME_CLASS.toLowerCase()}`;
  const srcUri = `${classUri}/source/main`;
  const st: { exists: boolean; source?: string; active: boolean } = { exists: false, active: false };

  const notFoundXml = () =>
    `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
    `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
    `<message lang="EN">${FLUID_RUNTIME_CLASS} does not exist</message><properties/></exc:exception>`;

  const classDocXml = () => {
    const main = st.active ? "active" : "inactive";
    const inc = (type: string, version: string) =>
      `<class:include class:includeType="${type}" ` +
      `abapsource:sourceUri="${type === "main" ? "source/main" : `includes/${type}`}" ` +
      `adtcore:name="" adtcore:type="CLAS/I" adtcore:version="${version}"/>`;
    return (
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<class:abapClass adtcore:name="${FLUID_RUNTIME_CLASS}" adtcore:type="CLAS/OC" adtcore:version="active" ` +
      `xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core" ` +
      `xmlns:abapsource="http://www.sap.com/adt/abapsource">` +
      `<adtcore:packageRef adtcore:name="${packageName}"/>` +
      inc("definitions", "active") +
      inc("implementations", "active") +
      inc("macros", "active") +
      inc("main", main) +
      `</class:abapClass>`
    );
  };

  return (o: HttpClientOptions) => {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;

    if (o.url === "/sap/bc/adt/oo/classes" && method === "POST") {
      if (!(o.body ?? "").includes(`adtcore:name="${FLUID_RUNTIME_CLASS}"`)) return undefined;
      st.exists = true;
      st.active = false;
      return resp(200, "", { "content-type": "text/plain" });
    }
    if (o.url === "/sap/bc/adt/activation" && method === "POST") {
      if (!(typeof o.body === "string" && o.body.includes(FLUID_RUNTIME_CLASS))) return undefined;
      st.active = true;
      return resp(200, "", { "content-length": "0" });
    }
    if (o.url === classUri && method === "GET" && !qs._action) {
      if (!st.exists) {
        const r = resp(404, notFoundXml(), { "content-type": "application/xml" });
        throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
      }
      return resp(200, classDocXml(), { "content-type": "application/xml" });
    }
    if (o.url === srcUri && method === "GET") {
      if (!st.exists || st.source === undefined) {
        const r = resp(404, notFoundXml(), { "content-type": "application/xml" });
        throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
      }
      return resp(200, st.source, { "content-type": "text/plain" });
    }
    if (o.url === classUri && qs._action === "LOCK") return resp(200, LOCK_XML(), { "content-type": "application/xml" });
    if (o.url === classUri && qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (o.url === srcUri && method === "PUT") {
      st.source = o.body ?? "";
      st.exists = true;
      st.active = false;
      return resp(200, "", { "content-type": "text/plain" });
    }
    return undefined;
  };
}

async function connected(
  route: (o: HttpClientOptions) => HttpClientResponse,
): Promise<{ conn: AbapConnection; inner: RecordingClient; cfg: Config }> {
  const usedCfg = cfg();
  const inner = new RecordingClient(route);
  const conn = new AbapConnection(usedCfg, { httpClient: inner, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner, cfg: usedCfg };
}

const openGate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"] });

// ----------------------------------------------------------------------- plans ---

const PROBE_PLAN: ImgProbePlan = {
  table: "ZTEST_IMGW",
  clientField: "MANDT",
  keyFields: ["ZKEY"],
  rows: [{ key: { ZKEY: "A" }, values: {} }],
  language: "E",
};

const APPLY_PLAN: ImgApplyPlan = {
  ...PROBE_PLAN,
  op: "upsert",
  fields: [{ field: "ZDESC", key: false, dataType: "CHAR" }],
  rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "Test row" } }],
  corrNr: "A4HK900001",
  expectedDeliveryClass: "C",
  expectedClientDependent: true,
  view: "ZTEST_IMGW_V",
  masterType: "VDAT",
};

const REQUEST_PLAN: CustomizingRequestPlan = {
  description: "Test customizing request",
  owner: "TESTUSER",
};

// ===========================================================================

describe("runImgProbe", () => {
  const TRANSCRIPT =
    `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
    `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
    `IMGW> FLD table=[ztest_imgw] field=[ZKEY] key=[X] type=[CHAR] len=[10] rollname=[ZKEY]\n` +
    `IMGW> BVAL row=[0] field=[ZKEY] len=[1] value=[A]\n` +
    `IMGW> PROBED rows=[1]\n`;

  // "Did the probe run?" now means "did the fluid img body class (imgManifest.entry) get
  // deployed through" — the probe no longer deploys IMGW_BRIDGE_CLASS.probe at all (that
  // class name is still exported but dead for this path; see img-write-bridge.ts).
  function probeRan(inner: RecordingClient): boolean {
    return inner.calls.some((c) => c.url.toLowerCase().includes(imgManifest.entry.toLowerCase()));
  }

  function probeHappyPath(rawTranscript: string): (o: HttpClientOptions) => HttpClientResponse {
    const fluidRoute = dynamicImgFluidRoute({
      transcript: () => imgProbeConsole(rawTranscript),
      packageName: FLUID_PACKAGE,
    });
    const runtimeRoute = runtimeClassRoute(FLUID_PACKAGE);
    return (o) =>
      baseRoute(o) ?? fluidRoute(o) ?? runtimeRoute(o) ?? resp(200, "<ok/>", { "content-type": "application/xml" });
  }

  function probeActivationRefused(): (o: HttpClientOptions) => HttpClientResponse {
    const ACTIVATION_ERROR = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Class ${imgManifest.entry}" type="E" line="1"
       href="/sap/bc/adt/oo/classes/${imgManifest.entry.toLowerCase()}/source/main#start=12,4" forceSupported="true">
    <shortText><txt>Field "LV_UNDEFINED" is unknown. It is neither in one of the specified tables nor defined by a "DATA" statement.</txt></shortText>
  </msg>
</chkl:messages>`;
    const fluidRoute = dynamicImgFluidRoute({
      transcript: () => {
        throw new Error("unrouted classrun call — the body class activation should have refused first");
      },
      packageName: FLUID_PACKAGE,
      activationError: { matches: (name) => name === imgManifest.entry, xml: () => ACTIVATION_ERROR },
    });
    const runtimeRoute = runtimeClassRoute(FLUID_PACKAGE);
    return (o) =>
      baseRoute(o) ?? fluidRoute(o) ?? runtimeRoute(o) ?? resp(200, "<ok/>", { "content-type": "application/xml" });
  }

  function probeClassrunBlowsUp(): (o: HttpClientOptions) => HttpClientResponse {
    const fluidRoute = dynamicImgFluidRoute({
      transcript: () => imgProbeConsole(TRANSCRIPT),
      packageName: FLUID_PACKAGE,
      classrunOverride: (o) => {
        const r = resp(500, "<exc:exception/>", { "content-type": "application/xml" });
        throw new HttpClientException("Request failed with status code 500", "500", 500, undefined, o, r);
      },
    });
    const runtimeRoute = runtimeClassRoute(FLUID_PACKAGE);
    return (o) =>
      baseRoute(o) ?? fluidRoute(o) ?? runtimeRoute(o) ?? resp(200, "<ok/>", { "content-type": "application/xml" });
  }

  it("deploys the fluid img body class and returns the parsed transcript", async () => {
    const { conn, inner, cfg: usedCfg } = await connected(probeHappyPath(TRANSCRIPT));

    const result = await runImgProbe(conn, openGate(), PROBE_PLAN, usedCfg, "preview");

    expect(result.bridgeClass).toBe(imgManifest.entry);
    expect(result.bridgeRefreshed).toBe(true);
    expect(result.transcript.probed).toBe(true);
    expect(result.transcript.table).toEqual({ table: "ztest_imgw", deliveryClass: "C", clientDependent: true });
    expect(result.transcript.before).toEqual([{ row: 0, field: "ZKEY", len: 1, value: "A" }]);
    expect(probeRan(inner)).toBe(true);

    // Located by identity (the create call whose body names the img body class), not position —
    // the fluid manifest now deploys the shared runtime class (FLUID_RUNTIME_CLASS) FIRST, so the
    // body class's own create POST is no longer necessarily the first "/oo/classes" POST on the wire.
    const create = inner.calls.find(
      (c) =>
        c.url === "/sap/bc/adt/oo/classes" &&
        (c.method ?? "GET").toUpperCase() === "POST" &&
        typeof c.body === "string" &&
        c.body.includes(`adtcore:name="${imgManifest.entry}"`),
    );
    expect(create?.body).toContain(`adtcore:name="${imgManifest.entry}"`);
  });

  it("BAD_INPUT from validateProbePlan is thrown before any network call", async () => {
    const { conn, inner, cfg: usedCfg } = await connected(probeHappyPath(TRANSCRIPT));

    const badPlan: ImgProbePlan = { ...PROBE_PLAN, keyFields: [] };
    const err = await runImgProbe(conn, openGate(), badPlan, usedCfg, "preview").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("BAD_INPUT");
    expect(inner.calls).toHaveLength(0);
    expect(probeRan(inner)).toBe(false);
  });

  it("an activation refusal surfaces as CHECK_FAILED carrying activate.ts's generic hint, and never reaches classrun", async () => {
    const { conn, inner, cfg: usedCfg } = await connected(probeActivationRefused());

    const err = await runImgProbe(conn, openGate(), PROBE_PLAN, usedCfg, "preview").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("CHECK_FAILED");
    if (isAbapError(err)) expect(err.details.bridgeLeftBehind).toBe(true);
    const hint = (err as { hint?: string }).hint ?? "";
    // The probe no longer carries its own bespoke hint (PROBE_HINT is gone — img-write.ts's
    // header says so) — ensure.ts's writeAndActivateOnce passes assertNoErrors no custom hint,
    // so the base sentence is activate.ts's checkFailedError default. It is no longer verbatim
    // by itself, though: writeAndActivateOnce now runs every fluid deploy failure through
    // discloseBridgeResidue (src/adt/bridge-residue.ts), same as the legacy bridge path
    // (src/adt/run.ts) always has, so the default is followed by the shared residue-disclosure
    // sentence naming the class and package left behind. That's still not a bespoke hint of the
    // probe's own — unlike the apply/request bridges (see their sibling tests below), which
    // supply their own hint text on top.
    expect(hint).toBe(
      "Fix the reported lines and write again. Line numbers come from the ADT href fragment, " +
        "not from the message ordinal, so they are the real source lines. " +
        `Bridge class ${imgManifest.entry} was written to ${FLUID_PACKAGE} but failed to activate; ` +
        `it is left behind there, inactive — safe to delete.`,
    );
    expect(inner.calls.some((c) => c.url.includes("/oo/classrun/"))).toBe(false);
  });

  it("a scaffold-level failure below activation (classrun itself 500s) surfaces as an error, not a silent empty result", async () => {
    const { conn, inner, cfg: usedCfg } = await connected(probeClassrunBlowsUp());

    const outcome = await runImgProbe(conn, openGate(), PROBE_PLAN, usedCfg, "preview").then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(isAbapError(outcome.e) || outcome.e instanceof Error).toBe(true);
    // The body class did activate on the way to the classrun 500 — this is a scaffold failure,
    // not an activation refusal, so the probe genuinely ran up to that point.
    expect(probeRan(inner)).toBe(true);
  });
});

// ===========================================================================

describe("runImgApply", () => {
  const TRANSCRIPT =
    `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
    `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
    `IMGW> BVAL row=[0] field=[ZDESC] len=[3] value=[Old]\n` +
    `IMGW> TRKEY row=[0] trkorr=[A4HK900001] len=[10] value=[A4HK900001]\n` +
    `IMGW> AVAL row=[0] field=[ZDESC] len=[8] value=[Test row]\n` +
    `IMGW> APPLIED rows=[1]\n`;

  function applyHappyPath(rawTranscript: string): (o: HttpClientOptions) => HttpClientResponse {
    const fluidRoute = dynamicImgFluidRoute({
      transcript: () => imgProbeConsole(rawTranscript, { action: "apply" }),
      packageName: FLUID_PACKAGE,
    });
    const runtimeRoute = runtimeClassRoute(FLUID_PACKAGE);
    return (o) =>
      baseRoute(o) ?? fluidRoute(o) ?? runtimeRoute(o) ?? resp(200, "<ok/>", { "content-type": "application/xml" });
  }

  function applyActivationRefused(): (o: HttpClientOptions) => HttpClientResponse {
    const ACTIVATION_ERROR = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Class ${imgManifest.entry}" type="E" line="1"
       href="/sap/bc/adt/oo/classes/${imgManifest.entry.toLowerCase()}/source/main#start=12,4" forceSupported="true">
    <shortText><txt>Field "LV_UNDEFINED" is unknown. It is neither in one of the specified tables nor defined by a "DATA" statement.</txt></shortText>
  </msg>
</chkl:messages>`;
    const fluidRoute = dynamicImgFluidRoute({
      transcript: () => {
        throw new Error("unrouted classrun call — the body class activation should have refused first");
      },
      packageName: FLUID_PACKAGE,
      activationError: { matches: (name) => name === imgManifest.entry, xml: () => ACTIVATION_ERROR },
    });
    const runtimeRoute = runtimeClassRoute(FLUID_PACKAGE);
    return (o) =>
      baseRoute(o) ?? fluidRoute(o) ?? runtimeRoute(o) ?? resp(200, "<ok/>", { "content-type": "application/xml" });
  }

  function applyClassrunBlowsUp(): (o: HttpClientOptions) => HttpClientResponse {
    const fluidRoute = dynamicImgFluidRoute({
      transcript: () => imgProbeConsole(TRANSCRIPT, { action: "apply" }),
      packageName: FLUID_PACKAGE,
      classrunOverride: (o) => {
        const r = resp(500, "<exc:exception/>", { "content-type": "application/xml" });
        throw new HttpClientException("Request failed with status code 500", "500", 500, undefined, o, r);
      },
    });
    const runtimeRoute = runtimeClassRoute(FLUID_PACKAGE);
    return (o) =>
      baseRoute(o) ?? fluidRoute(o) ?? runtimeRoute(o) ?? resp(200, "<ok/>", { "content-type": "application/xml" });
  }

  it("deploys the fluid img body class and returns the parsed transcript", async () => {
    const { conn, inner, cfg: usedCfg } = await connected(applyHappyPath(TRANSCRIPT));

    const result = await runImgApply(conn, openGate(), APPLY_PLAN, usedCfg, "upsert");

    expect(result.bridgeClass).toBe(imgManifest.entry);
    expect(result.transcript.applied).toBe(1);
    expect(result.transcript.trkeys).toEqual([{ row: 0, trkorr: "A4HK900001", len: 10, value: "A4HK900001" }]);

    const create = inner.calls.find(
      (c) =>
        c.url === "/sap/bc/adt/oo/classes" &&
        (c.method ?? "GET").toUpperCase() === "POST" &&
        typeof c.body === "string" &&
        c.body.includes(`adtcore:name="${imgManifest.entry}"`),
    );
    expect(create?.body).toContain(`adtcore:name="${FLUID_PACKAGE}"`);
  });

  it("BAD_INPUT from validateApplyPlan (op missing a valid value) is thrown before any network call", async () => {
    const { conn, inner, cfg: usedCfg } = await connected(applyHappyPath(TRANSCRIPT));

    const badPlan = { ...APPLY_PLAN, op: "wipe" } as unknown as ImgApplyPlan;
    const err = await runImgApply(conn, openGate(), badPlan, usedCfg, "upsert").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("BAD_INPUT");
    expect(inner.calls).toHaveLength(0);
  });

  it("an activation refusal surfaces as CHECK_FAILED carrying activate.ts's generic hint (apply's own bespoke hint is retired — see this file's header), and never reaches classrun", async () => {
    const { conn, inner, cfg: usedCfg } = await connected(applyActivationRefused());

    const err = await runImgApply(conn, openGate(), APPLY_PLAN, usedCfg, "upsert").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("CHECK_FAILED");
    const hint = (err as { hint?: string }).hint ?? "";
    // Same text the probe's own activation-refusal test asserts on (describe("runImgProbe")
    // above) — apply now shares the one body class and the one generic hint with the other
    // two actions, so there is no bridge-specific wording left to distinguish here.
    expect(hint).toBe(
      "Fix the reported lines and write again. Line numbers come from the ADT href fragment, " +
        "not from the message ordinal, so they are the real source lines. " +
        `Bridge class ${imgManifest.entry} was written to ${FLUID_PACKAGE} but failed to activate; ` +
        `it is left behind there, inactive — safe to delete.`,
    );
    expect(inner.calls.some((c) => c.url.includes("/oo/classrun/"))).toBe(false);
  });

  it("a scaffold-level failure below activation (classrun itself 500s) surfaces as an error, not a silent empty result", async () => {
    const { conn, cfg: usedCfg } = await connected(applyClassrunBlowsUp());

    const outcome = await runImgApply(conn, openGate(), APPLY_PLAN, usedCfg, "upsert").then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(isAbapError(outcome.e) || outcome.e instanceof Error).toBe(true);
  });
});

// ===========================================================================

describe("runCreateCustomizingRequest", () => {
  const TRANSCRIPT = `CTSW> REQUEST len=[10] value=[A4HK900002]\nCTSW> TASK len=[10] value=[A4HK900003]\n`;

  function requestHappyPath(rawTranscript: string): (o: HttpClientOptions) => HttpClientResponse {
    const fluidRoute = dynamicImgFluidRoute({
      transcript: () => imgProbeConsole(rawTranscript, { action: "create_request" }),
      packageName: FLUID_PACKAGE,
    });
    const runtimeRoute = runtimeClassRoute(FLUID_PACKAGE);
    return (o) =>
      baseRoute(o) ?? fluidRoute(o) ?? runtimeRoute(o) ?? resp(200, "<ok/>", { "content-type": "application/xml" });
  }

  function requestActivationRefused(): (o: HttpClientOptions) => HttpClientResponse {
    const ACTIVATION_ERROR = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Class ${imgManifest.entry}" type="E" line="1"
       href="/sap/bc/adt/oo/classes/${imgManifest.entry.toLowerCase()}/source/main#start=12,4" forceSupported="true">
    <shortText><txt>Field "LV_UNDEFINED" is unknown. It is neither in one of the specified tables nor defined by a "DATA" statement.</txt></shortText>
  </msg>
</chkl:messages>`;
    const fluidRoute = dynamicImgFluidRoute({
      transcript: () => {
        throw new Error("unrouted classrun call — the body class activation should have refused first");
      },
      packageName: FLUID_PACKAGE,
      activationError: { matches: (name) => name === imgManifest.entry, xml: () => ACTIVATION_ERROR },
    });
    const runtimeRoute = runtimeClassRoute(FLUID_PACKAGE);
    return (o) =>
      baseRoute(o) ?? fluidRoute(o) ?? runtimeRoute(o) ?? resp(200, "<ok/>", { "content-type": "application/xml" });
  }

  function requestClassrunBlowsUp(): (o: HttpClientOptions) => HttpClientResponse {
    const fluidRoute = dynamicImgFluidRoute({
      transcript: () => imgProbeConsole(TRANSCRIPT, { action: "create_request" }),
      packageName: FLUID_PACKAGE,
      classrunOverride: (o) => {
        const r = resp(500, "<exc:exception/>", { "content-type": "application/xml" });
        throw new HttpClientException("Request failed with status code 500", "500", 500, undefined, o, r);
      },
    });
    const runtimeRoute = runtimeClassRoute(FLUID_PACKAGE);
    return (o) =>
      baseRoute(o) ?? fluidRoute(o) ?? runtimeRoute(o) ?? resp(200, "<ok/>", { "content-type": "application/xml" });
  }

  it("deploys the fluid img body class and returns the parsed request/task numbers", async () => {
    const { conn, inner, cfg: usedCfg } = await connected(requestHappyPath(TRANSCRIPT));

    const result = await runCreateCustomizingRequest(conn, openGate(), REQUEST_PLAN, usedCfg);

    expect(result.bridgeClass).toBe(imgManifest.entry);
    expect(result.transcript.request).toBe("A4HK900002");
    expect(result.transcript.task).toBe("A4HK900003");

    const create = inner.calls.find(
      (c) =>
        c.url === "/sap/bc/adt/oo/classes" &&
        (c.method ?? "GET").toUpperCase() === "POST" &&
        typeof c.body === "string" &&
        c.body.includes(`adtcore:name="${imgManifest.entry}"`),
    );
    expect(create?.body).toContain(`adtcore:name="${FLUID_PACKAGE}"`);
  });

  it("BAD_INPUT from validateCustomizingRequestPlan (empty description) is thrown before any network call", async () => {
    const { conn, inner, cfg: usedCfg } = await connected(requestHappyPath(TRANSCRIPT));

    const err = await runCreateCustomizingRequest(conn, openGate(), { description: "  " }, usedCfg).catch(
      (e: unknown) => e,
    );

    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("BAD_INPUT");
    expect(inner.calls).toHaveLength(0);
  });

  it("an activation refusal surfaces as CHECK_FAILED carrying activate.ts's generic hint (the request bridge's own bespoke hint is retired — see this file's header), and never reaches classrun", async () => {
    const { conn, inner, cfg: usedCfg } = await connected(requestActivationRefused());

    const err = await runCreateCustomizingRequest(conn, openGate(), REQUEST_PLAN, usedCfg).catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("CHECK_FAILED");
    const hint = (err as { hint?: string }).hint ?? "";
    expect(hint).toBe(
      "Fix the reported lines and write again. Line numbers come from the ADT href fragment, " +
        "not from the message ordinal, so they are the real source lines. " +
        `Bridge class ${imgManifest.entry} was written to ${FLUID_PACKAGE} but failed to activate; ` +
        `it is left behind there, inactive — safe to delete.`,
    );
    expect(inner.calls.some((c) => c.url.includes("/oo/classrun/"))).toBe(false);
  });

  it("a scaffold-level failure below activation (classrun itself 500s) surfaces as an error, not a silent empty result", async () => {
    const { conn, cfg: usedCfg } = await connected(requestClassrunBlowsUp());

    const outcome = await runCreateCustomizingRequest(conn, openGate(), REQUEST_PLAN, usedCfg).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(isAbapError(outcome.e) || outcome.e instanceof Error).toBe(true);
  });
});

// ===========================================================================
// Coverage note (was: "duplicate-declaration activation failures get a
// corrected hint"). The old `runImgApply`/`runCreateCustomizingRequest`
// bridge-deploy code used to recognize an "already declared" ADT activation
// error by its message text and rewrite the thrown hint to say plainly that
// this is a generator defect, never a caller-input mistake — distinct
// per-bridge wording, asserted on by two tests that used to live in this
// spot. Neither `ensure.ts` nor `dispatch()` (the code these two functions
// now run through) has any equivalent special-casing: `assertNoErrors`
// (src/adt/activate.ts) throws the same content-independent default hint
// regardless of what the activation message says — proven by the generic-hint
// tests directly above, which use the exact same "already declared" wording
// live-verified on 2026-09-06 and still get the ordinary default hint, not a
// generator-defect one. That distinction is gone with the reroute, not moved
// elsewhere; flagged to the slice owner rather than silently dropped.
// ===========================================================================

describe("an 'already declared' activation failure is not distinguished from any other activation failure", () => {
  it("apply: reports the same generic CHECK_FAILED hint as any other activation refusal, not a generator-defect rewrite", async () => {
    const ACTIVATION_ERROR = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Class ${imgManifest.entry}" type="E" line="58"
       href="/sap/bc/adt/oo/classes/${imgManifest.entry.toLowerCase()}/source/main#start=58,13" forceSupported="true">
    <shortText><txt>"LV_KEY_FLAG" was already declared.</txt></shortText>
  </msg>
</chkl:messages>`;
    const fluidRoute = dynamicImgFluidRoute({
      transcript: () => {
        throw new Error("unrouted classrun call — activation should have refused first");
      },
      packageName: FLUID_PACKAGE,
      activationError: { matches: (name) => name === imgManifest.entry, xml: () => ACTIVATION_ERROR },
    });
    const runtimeRoute = runtimeClassRoute(FLUID_PACKAGE);
    const { conn, cfg: usedCfg } = await connected(
      (o) => baseRoute(o) ?? fluidRoute(o) ?? runtimeRoute(o) ?? resp(200, "<ok/>", { "content-type": "application/xml" }),
    );

    const err = await runImgApply(conn, openGate(), APPLY_PLAN, usedCfg, "upsert").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("CHECK_FAILED");
    const hint = (err as { hint?: string }).hint ?? "";
    expect(hint).not.toContain("defect in abapsmith's own code generator");
    expect(hint).toContain("Fix the reported lines and write again");
  });
});
