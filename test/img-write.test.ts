/**
 * Tests for `src/adt/img-write.ts` — the deploy-then-execute orchestration
 * over the apply bridge (`img-write-bridge.ts`) and the customizing-request
 * bridge (`customizing-request.ts`), plus the read-only probe, which now
 * runs as the fluid `img` tool's `preview` action (`fluid/dispatch.ts`)
 * instead of deploying its own generated bridge class.
 *
 * Same harness shape as `test/img-tool.test.ts` (a `RecordingClient`
 * implementing `HttpClient` directly, `bridgeHappyPath`-style routing), with
 * one addition: every call here also goes through the package-existence
 * check first, so every route below also answers a GET on `FLUID_PACKAGE`'s
 * package URI (modelled on `test/helper-package.test.ts`'s `existingRoute` —
 * the package already exists, so no create POST is ever needed to reach the
 * bridge deploy). The probe describe block additionally needs a fresh
 * per-test `stateDir` and reset fluid caches (`resetFluidEnsureState`/
 * `resetFluidPackageMemo`) — `dispatch()`'s deploy/activate wiring is
 * memoized across calls, and a stale cache would silently short-circuit the
 * very network calls these tests assert on. `test/helpers/fluid-img-fake.ts`
 * carries the transcript-framing and class-lifecycle fake shared with
 * img-edit-tool.test.ts — see that file's header for the frame grammar.
 *
 * Plan validation, ABAP fragment generation and transcript parsing are
 * already covered in `test/img-write-bridge.test.ts` and
 * `test/customizing-request.test.ts` (not modified here) — this file only
 * exercises what is unique to the orchestration layer: the deploy/activate/
 * execute wiring, the FLUID_PACKAGE target, and each function's own
 * bespoke activation-failure hint (the apply/request bridges still have
 * one; the probe's fluid path only ever surfaces activate.ts's generic hint,
 * since neither `ensure.ts` nor `dispatch()` passes it a bespoke one).
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
import { IMGW_BRIDGE_CLASS, type ImgApplyPlan, type ImgProbePlan } from "../src/adt/img-write-bridge.js";
import { CUSTOMIZING_REQUEST_CLASS, type CustomizingRequestPlan } from "../src/adt/customizing-request.js";
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

/** Full write -> activate -> classrun happy path for `className`, landing in `FLUID_PACKAGE`. */
function bridgeHappyPath(
  className: string,
  classrun: (o: HttpClientOptions) => HttpClientResponse,
): (o: HttpClientOptions) => HttpClientResponse {
  const classUri = `/sap/bc/adt/oo/classes/${className.toLowerCase()}`;
  const sourceUri = `${classUri}/source/main`;
  return (o: HttpClientOptions) => {
    const base = baseRoute(o);
    if (base) return base;
    const qs = (o.qs ?? {}) as Record<string, string>;
    const method = (o.method ?? "GET").toUpperCase();

    if (o.url.startsWith("/sap/bc/adt/oo/classrun/")) return classrun(o);
    if (o.url === classUri && method === "GET" && !qs._action) {
      const r = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
      throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
    }
    if (o.url === "/sap/bc/adt/oo/classes" && method === "POST") return resp(200, "", {});
    if (qs._action === "LOCK") return resp(200, LOCK_XML(), { "content-type": "application/xml" });
    if (qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (o.url === sourceUri && method === "PUT") return resp(200, "", { "content-type": "text/plain" });
    if (o.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return resp(200, "<ok/>", { "content-type": "application/xml" });
  };
}

/** Bridge class write succeeds, but the activation POST itself reports a real compile error — same fixture shape as `test/run.test.ts`'s `runReport — activation refusal` describe block. */
function bridgeActivationRefused(className: string): (o: HttpClientOptions) => HttpClientResponse {
  const classUri = `/sap/bc/adt/oo/classes/${className.toLowerCase()}`;
  const ACTIVATION_ERROR = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Class ${className}" type="E" line="1"
       href="${classUri}/source/main#start=12,4" forceSupported="true">
    <shortText><txt>Field "LV_UNDEFINED" is unknown. It is neither in one of the specified tables nor defined by a "DATA" statement.</txt></shortText>
  </msg>
</chkl:messages>`;
  return (o: HttpClientOptions) => {
    const base = baseRoute(o);
    if (base) return base;
    const qs = (o.qs ?? {}) as Record<string, string>;
    const method = (o.method ?? "GET").toUpperCase();

    if (o.url.startsWith("/sap/bc/adt/oo/classrun/")) {
      throw new Error(`unrouted classrun call for ${className} — activation should have refused first`);
    }
    if (o.url === classUri && method === "GET" && !qs._action) {
      const r = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
      throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
    }
    if (o.url === "/sap/bc/adt/oo/classes" && method === "POST") return resp(200, "", {});
    if (qs._action === "LOCK") return resp(200, LOCK_XML(), { "content-type": "application/xml" });
    if (qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (o.url === `${classUri}/source/main` && method === "PUT") return resp(200, "", { "content-type": "text/plain" });
    if (o.url.includes("/sap/bc/adt/activation")) return resp(200, ACTIVATION_ERROR, { "content-type": "application/xml" });
    return resp(200, "<ok/>", { "content-type": "application/xml" });
  };
}

/**
 * Bridge class write succeeds, but activation reports a DUPLICATE DECLARATION —
 * the exact live shape from the 2026-09-06 round-6 armed upsert against a
 * two-key customizing table: `E line 58 col 13  "LV_KEY_FLAG" was already
 * declared.` A generator defect, never a caller-input mistake.
 */
function bridgeActivationDuplicateDeclaration(className: string): (o: HttpClientOptions) => HttpClientResponse {
  const classUri = `/sap/bc/adt/oo/classes/${className.toLowerCase()}`;
  const ACTIVATION_ERROR = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Class ${className}" type="E" line="58"
       href="${classUri}/source/main#start=58,13" forceSupported="true">
    <shortText><txt>"LV_KEY_FLAG" was already declared.</txt></shortText>
  </msg>
</chkl:messages>`;
  return (o: HttpClientOptions) => {
    const base = baseRoute(o);
    if (base) return base;
    const qs = (o.qs ?? {}) as Record<string, string>;
    const method = (o.method ?? "GET").toUpperCase();

    if (o.url.startsWith("/sap/bc/adt/oo/classrun/")) {
      throw new Error(`unrouted classrun call for ${className} — activation should have refused first`);
    }
    if (o.url === classUri && method === "GET" && !qs._action) {
      const r = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
      throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
    }
    if (o.url === "/sap/bc/adt/oo/classes" && method === "POST") return resp(200, "", {});
    if (qs._action === "LOCK") return resp(200, LOCK_XML(), { "content-type": "application/xml" });
    if (qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (o.url === `${classUri}/source/main` && method === "PUT") return resp(200, "", { "content-type": "text/plain" });
    if (o.url.includes("/sap/bc/adt/activation")) return resp(200, ACTIVATION_ERROR, { "content-type": "application/xml" });
    return resp(200, "<ok/>", { "content-type": "application/xml" });
  };
}

/** A classrun POST that 500s — a scaffold-level failure below activation, with activation itself already having succeeded. */
function bridgeClassrunBlowsUp(className: string): (o: HttpClientOptions) => HttpClientResponse {
  return bridgeHappyPath(className, (o) => {
    const r = resp(500, "<exc:exception/>", { "content-type": "application/xml" });
    throw new HttpClientException("Request failed with status code 500", "500", 500, undefined, o, r);
  });
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
    return (o) => baseRoute(o) ?? fluidRoute(o) ?? resp(200, "<ok/>", { "content-type": "application/xml" });
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
    return (o) => baseRoute(o) ?? fluidRoute(o) ?? resp(200, "<ok/>", { "content-type": "application/xml" });
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
    return (o) => baseRoute(o) ?? fluidRoute(o) ?? resp(200, "<ok/>", { "content-type": "application/xml" });
  }

  it("deploys the fluid img body class and returns the parsed transcript", async () => {
    const { conn, inner, cfg: usedCfg } = await connected(probeHappyPath(TRANSCRIPT));

    const result = await runImgProbe(conn, openGate(), PROBE_PLAN, usedCfg);

    expect(result.bridgeClass).toBe(imgManifest.entry);
    expect(result.bridgeRefreshed).toBe(true);
    expect(result.transcript.probed).toBe(true);
    expect(result.transcript.table).toEqual({ table: "ztest_imgw", deliveryClass: "C", clientDependent: true });
    expect(result.transcript.before).toEqual([{ row: 0, field: "ZKEY", len: 1, value: "A" }]);
    expect(probeRan(inner)).toBe(true);

    const create = inner.calls.find((c) => c.url === "/sap/bc/adt/oo/classes" && (c.method ?? "GET").toUpperCase() === "POST");
    expect(create?.body).toContain(`adtcore:name="${imgManifest.entry}"`);
  });

  it("BAD_INPUT from validateProbePlan is thrown before any network call", async () => {
    const { conn, inner, cfg: usedCfg } = await connected(probeHappyPath(TRANSCRIPT));

    const badPlan: ImgProbePlan = { ...PROBE_PLAN, keyFields: [] };
    const err = await runImgProbe(conn, openGate(), badPlan, usedCfg).catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("BAD_INPUT");
    expect(inner.calls).toHaveLength(0);
    expect(probeRan(inner)).toBe(false);
  });

  it("an activation refusal surfaces as CHECK_FAILED carrying activate.ts's generic hint, and never reaches classrun", async () => {
    const { conn, inner, cfg: usedCfg } = await connected(probeActivationRefused());

    const err = await runImgProbe(conn, openGate(), PROBE_PLAN, usedCfg).catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("CHECK_FAILED");
    const hint = (err as { hint?: string }).hint ?? "";
    // The probe no longer carries its own bespoke hint (PROBE_HINT is gone — img-write.ts's
    // header says so) — ensure.ts's writeAndActivateOnce passes assertNoErrors no custom hint,
    // so this is activate.ts's checkFailedError default, verbatim.
    expect(hint).toBe(
      "Fix the reported lines and write again. Line numbers come from the ADT href fragment, " +
        "not from the message ordinal, so they are the real source lines.",
    );
    expect(inner.calls.some((c) => c.url.includes("/oo/classrun/"))).toBe(false);
  });

  it("a scaffold-level failure below activation (classrun itself 500s) surfaces as an error, not a silent empty result", async () => {
    const { conn, inner, cfg: usedCfg } = await connected(probeClassrunBlowsUp());

    const outcome = await runImgProbe(conn, openGate(), PROBE_PLAN, usedCfg).then(
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

  it("deploys ZCL_ZMCP_IMG_WAPPLY into FLUID_PACKAGE and returns the parsed transcript", async () => {
    const { conn, inner } = await connected(bridgeHappyPath(IMGW_BRIDGE_CLASS.apply, () => resp(200, TRANSCRIPT)));

    const result = await runImgApply(conn, openGate(), APPLY_PLAN);

    expect(result.bridgeClass).toBe(IMGW_BRIDGE_CLASS.apply);
    expect(result.transcript.applied).toBe(1);
    expect(result.transcript.trkeys).toEqual([{ row: 0, trkorr: "A4HK900001", len: 10, value: "A4HK900001" }]);

    const create = inner.calls.find((c) => c.url === "/sap/bc/adt/oo/classes" && (c.method ?? "GET").toUpperCase() === "POST");
    expect(create?.body).toContain(`adtcore:name="${FLUID_PACKAGE}"`);
  });

  it("BAD_INPUT from validateApplyPlan (op missing a valid value) is thrown before any network call", async () => {
    const { conn, inner } = await connected(bridgeHappyPath(IMGW_BRIDGE_CLASS.apply, () => resp(200, TRANSCRIPT)));

    const badPlan = { ...APPLY_PLAN, op: "wipe" } as unknown as ImgApplyPlan;
    const err = await runImgApply(conn, openGate(), badPlan).catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("BAD_INPUT");
    expect(inner.calls).toHaveLength(0);
  });

  it("an activation refusal surfaces as CHECK_FAILED carrying the apply bridge's own bespoke hint (distinct from the probe's), and never reaches classrun", async () => {
    const { conn, inner } = await connected(bridgeActivationRefused(IMGW_BRIDGE_CLASS.apply));

    const err = await runImgApply(conn, openGate(), APPLY_PLAN).catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("CHECK_FAILED");
    const hint = (err as { hint?: string }).hint ?? "";
    expect(hint).toContain("MODIFYs/DELETEs the target table directly");
    expect(hint).toContain("TR_OBJECTS_CHECK/TR_OBJECTS_INSERT");
    expect(hint).not.toContain("SELECTs the target table plus"); // not the probe's hint
    // Defect B correction: the ADT syntax check does catch an ordinary ABAP type error in
    // the generated body (proven live 2026-09-06 in the sibling request bridge) — this
    // hint must no longer imply an FM-interface guess is the only explanation.
    expect(hint).toMatch(/DOES validate ordinary ABAP statements/);
    expect(inner.calls.some((c) => c.url.includes("/oo/classrun/"))).toBe(false);
  });

  it("a scaffold-level failure below activation (classrun itself 500s) surfaces as an error, not a silent empty result", async () => {
    const { conn } = await connected(bridgeClassrunBlowsUp(IMGW_BRIDGE_CLASS.apply));

    const outcome = await runImgApply(conn, openGate(), APPLY_PLAN).then(
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

  it("deploys ZCL_ZMCP_CTS_WREQ into FLUID_PACKAGE and returns the parsed request/task numbers", async () => {
    const { conn, inner } = await connected(bridgeHappyPath(CUSTOMIZING_REQUEST_CLASS, () => resp(200, TRANSCRIPT)));

    const result = await runCreateCustomizingRequest(conn, openGate(), REQUEST_PLAN);

    expect(result.bridgeClass).toBe(CUSTOMIZING_REQUEST_CLASS);
    expect(result.transcript.request).toBe("A4HK900002");
    expect(result.transcript.task).toBe("A4HK900003");

    const create = inner.calls.find((c) => c.url === "/sap/bc/adt/oo/classes" && (c.method ?? "GET").toUpperCase() === "POST");
    expect(create?.body).toContain(`adtcore:name="${FLUID_PACKAGE}"`);
  });

  it("BAD_INPUT from validateCustomizingRequestPlan (empty description) is thrown before any network call", async () => {
    const { conn, inner } = await connected(bridgeHappyPath(CUSTOMIZING_REQUEST_CLASS, () => resp(200, TRANSCRIPT)));

    const err = await runCreateCustomizingRequest(conn, openGate(), { description: "  " }).catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("BAD_INPUT");
    expect(inner.calls).toHaveLength(0);
  });

  it("an activation refusal surfaces as CHECK_FAILED carrying the request bridge's own bespoke hint (distinct from probe/apply), and never reaches classrun", async () => {
    const { conn, inner } = await connected(bridgeActivationRefused(CUSTOMIZING_REQUEST_CLASS));

    const err = await runCreateCustomizingRequest(conn, openGate(), REQUEST_PLAN).catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("CHECK_FAILED");
    const hint = (err as { hint?: string }).hint ?? "";
    expect(hint).toContain("TR_INSERT_REQUEST_WITH_TASKS");
    expect(hint).not.toContain("SELECTs the target table plus");
    expect(hint).not.toContain("MODIFYs/DELETEs the target table directly");
    expect(inner.calls.some((c) => c.url.includes("/oo/classrun/"))).toBe(false);
  });

  it("the request bridge's hint gives the exact delete command for the left-behind class, and no longer blames the FM's parameter names as the leading explanation", async () => {
    const { conn } = await connected(bridgeActivationRefused(CUSTOMIZING_REQUEST_CLASS));

    const err = await runCreateCustomizingRequest(conn, openGate(), REQUEST_PLAN).catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    const hint = (err as { hint?: string }).hint ?? "";
    // Defect B, live 2026-09-06: the false claim this replaces said a syntax error here
    // "most likely means that FM's parameter names are wrong" — falsified by an ordinary
    // ABAP type error inside the generated body, nothing to do with the FM interface.
    expect(hint).not.toContain("most likely means that FM's parameter names are wrong");
    // Substance that must now be present: the check does validate ordinary ABAP
    // statements in the generated body, and the exact command to clean up the
    // left-behind, never-activated bridge class.
    expect(hint).toMatch(/DOES validate ordinary ABAP statements/);
    expect(hint).toContain(`abap_write {"object":"class ${CUSTOMIZING_REQUEST_CLASS}","mode":"delete"}`);
    // discloseBridgeResidue (./run.ts) already appends its own generic "safe to delete"
    // sentence naming the class and package — the bespoke hint must not repeat that
    // sentence verbatim, only add the delete command it doesn't give.
    expect(hint).toContain(`Bridge class ${CUSTOMIZING_REQUEST_CLASS}`);
    expect((hint.match(/safe to delete/g) ?? []).length).toBe(1);
  });

  it("a scaffold-level failure below activation (classrun itself 500s) surfaces as an error, not a silent empty result", async () => {
    const { conn } = await connected(bridgeClassrunBlowsUp(CUSTOMIZING_REQUEST_CLASS));

    const outcome = await runCreateCustomizingRequest(conn, openGate(), REQUEST_PLAN).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(isAbapError(outcome.e) || outcome.e instanceof Error).toBe(true);
  });
});

// ===========================================================================
// Task 1 — an "already declared" activation failure is a generator defect,
// never a caller-input mistake, and must not be reported as one.
// ===========================================================================

describe("duplicate-declaration activation failures get a corrected hint", () => {
  // The probe now runs through the fluid img.preview path, whose dispatch/ensure wiring
  // never applies a per-bridge hint rewrite or bridge-residue disclosure; only the apply
  // and request bridges still go through the code paths this describe block covers.

  it("apply bridge: 'already declared' activation failure reports a generator defect, not a drifted table structure or FM interface", async () => {
    const { conn } = await connected(bridgeActivationDuplicateDeclaration(IMGW_BRIDGE_CLASS.apply));

    const err = await runImgApply(conn, openGate(), APPLY_PLAN).catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("CHECK_FAILED");
    const hint = (err as { hint?: string }).hint ?? "";
    expect(hint).toContain("defect in abapsmith's own code generator");
    // The old apply-bridge hint's structure-drift/FM-interface theory must NOT survive.
    expect(hint).not.toContain("table's real structure having");
    expect(hint).not.toContain("TR_OBJECTS_CHECK");
  });

  it("request bridge: 'already declared' activation failure reports a generator defect too — the fix is shared, not per-bridge", async () => {
    const { conn } = await connected(bridgeActivationDuplicateDeclaration(CUSTOMIZING_REQUEST_CLASS));

    const err = await runCreateCustomizingRequest(conn, openGate(), REQUEST_PLAN).catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    const hint = (err as { hint?: string }).hint ?? "";
    expect(hint).toContain("defect in abapsmith's own code generator");
    expect(hint).not.toContain("TR_INSERT_REQUEST_WITH_TASKS");
  });

});
