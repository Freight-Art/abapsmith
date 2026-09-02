/**
 * `src/adt/enhancement-write.ts` — the LOCK -> PUT -> UNLOCK
 * (-> activate) choreography for EXISTING `ENHO/XH`, `ENHO/XHH` and
 * `ENHS/XS` objects.
 *
 * Offline only, exactly like test/write.test.ts and test/write-toctou.test.ts
 * (both templates for this file): a fake `HttpClient` is injected through
 * `ConnectionOptions.httpClient` and nothing here touches a real SAP system.
 * The `FakeAdt`/`resp`/`cfg`/`connected`/`catchErr` idiom is copied in
 * verbatim from those files rather than imported, per this codebase's
 * one-small-copy-per-test-file convention (see write-toctou.test.ts's own
 * header comment on why: so the two are never silently coupled).
 *
 * Fixtures: every GET-response body used below is copied byte-for-byte from
 * a real capture under test/fixtures/enhancement/ (138's embedded PUT
 * request body for ENHO/XHH, 354 for ENHO/XH, 343 for ENHS/XS, 405/203 for
 * the two LOCK response flavours, 273 for the ICMENOSESSION dead-session
 * signature) — never a synthetic string. `ACTIVATION_ERRORS` is copied from
 * test/activate.test.ts, per the same convention.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement, TrRequest } from "../src/adt/transports.js";
import {
  writeEnhancementDescription,
  writeAndActivateEnhancementDescription,
  deleteEnhancementObject,
  setBadiImplementationActive,
} from "../src/adt/enhancement-write.js";
import {
  patchBadiImplementationActive,
  patchEnhancementRootAttribute,
  hasEnhancementRootDescription,
} from "../src/adt/enhancement-xml.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Copied from test/write.test.ts / test/write-toctou.test.ts — see those
// files for the full rationale on each piece. Only what this file uses.
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement");
const fixture = (name: string): string => readFileSync(join(FIXTURES_DIR, name), "utf8");

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
/*
 * `DATAPREVIEW_XML` and `T000_NONPRODUCTIVE` come from
 * ./helpers/system-role-fake.js. Client 001 reads "C" (non-productive) in that
 * real captured T000 row (fixture 087).
 */

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
  headers?: Record<string, unknown>;
}

type Route = (r: Recorded) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body, headers: o.headers as Record<string, unknown> | undefined };
    this.calls.push(rec);
    const res = this.route(rec);
    // Loud on purpose (same reasoning as write-toctou.test.ts's copy): a
    // catch-all 200 would let this fake silently absorb a request production
    // never issues, hiding exactly the "does it skip the LOCK on a no-op"
    // proofs this file exists to make.
    if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
    return res;
  }
  get labels(): string[] {
    return this.calls.map((c) => c.label);
  }
  get verbs(): string[] {
    return this.calls.map((c) => (c.qs._action ? c.qs._action : c.method));
  }
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

/** Real A4H discovery capture (Enhancements workspace) — needed so
 *  `conn.discovery` reports "loaded" with enhoxh/enhoxhh/enhsxs present;
 *  otherwise the new `assertEnhancementCapable` gate in
 *  `writeEnhancementDescription` would refuse every write below as
 *  discovery-unknown. See test/fixtures/enhancement/discovery-enhancements.xml. */
const DISCOVERY_ENHANCEMENTS_XML = fixture("discovery-enhancements.xml");

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, DISCOVERY_ENHANCEMENTS_XML, OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

async function connected(route: Route, config: Config = cfg()): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(config, {
    httpClient: adt,
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
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

// ---------------------------------------------------------------------------
// This file's own fixtures.
// ---------------------------------------------------------------------------

const ENHOXHH_URI = "/sap/bc/adt/enhancements/enhoxhh/ZMCP_ENH_B";
const ENHOXH_URI = "/sap/bc/adt/enhancements/enhoxh/ZMCP_ENH_BADI";
const ENHSXS_URI = "/sap/bc/adt/enhancements/enhsxs/ZMCP_SPOT";

/**
 * ENHO/XHH document, verbatim from the request body embedded in the real PUT
 * capture test/fixtures/enhancement/138-put-wholedoc-success.meta.json —
 * name=ZMCP_ENH_B, package=$TMP, masterSystem=A4H,
 * description="ZMCP recon hook impl", enhanced object ZMCP_BADI_HOST. This
 * is the ONLY collection with a captured live PUT 200 (`putVerifiedBy` is
 * set for it in the production registry), so it is the natural choice for
 * the "verified type" happy path.
 */
const ENHOXHH_XML = (
  JSON.parse(readFileSync(join(FIXTURES_DIR, "138-put-wholedoc-success.meta.json"), "utf8")) as {
    requestBody: string;
  }
).requestBody;

/**
 * ENHO/XH document, verbatim from test/fixtures/enhancement/354-enhoxh-no-filter.xml
 * — name=ZMCP_ENH_BADI, package=$TMP, masterSystem=A4H. Deliberately has NO
 * `adtcore:description` attribute (absent, not empty) — this collection is
 * UNVERIFIED for PUT (`putVerifiedBy: undefined` in the registry), and using
 * a description-less document exercises `patchEnhancementRootAttribute`'s
 * append branch rather than its replace branch, for variety against the
 * ENHO/XHH happy path below.
 */
const ENHOXH_XML = fixture("354-enhoxh-no-filter.xml");

/**
 * Same real capture, with ONE byte-level substitution: the nested
 * `<enho:badiImplementation enho:name="...">` entry's own name is rewritten
 * to equal the document's own `adtcore:name` ("ZMCP_ENH_BADI"). In the real,
 * unmodified fixture these two names differ (container "ZMCP_ENH_BADI" vs.
 * entry "ZMCP_BADI_I1") — see the `setBadiImplementationActive — NOT_FOUND`
 * describe block below for why that distinction matters and is a real
 * defect, not a test-fixture inconvenience. This synthetic variant exists
 * ONLY to isolate the wire mechanics (LOCK/PUT/UNLOCK choreography, no-op
 * short-circuit, etag handling, retry-on-failure) from that naming defect,
 * by using a document shape where both of `target.name`'s two incompatible
 * jobs (URI segment AND entry lookup key) happen to resolve to the same
 * string.
 */
const ENHOXH_SYNTHETIC_XML = ENHOXH_XML.replace(
  'enho:name="ZMCP_BADI_I1"',
  'enho:name="ZMCP_ENH_BADI"',
);

/**
 * A second, synthetic-by-necessity document with TWO `<enho:badiImplementation>`
 * entries — no real capture on file has more than one (every fixture under
 * test/fixtures/enhancement/ has exactly one), so there is no way to exercise
 * `resolveBadiImplementationEntry`'s ambiguous-entry / explicit-implName paths
 * against a byte-for-byte real capture. Built by duplicating the ONE real
 * entry from fixture 354 verbatim and renaming only the copy's own `enho:name` —
 * every other byte, including the original entry, is untouched real capture
 * data. Both entries start `enho:isActive="true"`, matching the real fixture.
 */
const BADI_IMPL_BLOCK_RE = /<enho:badiImplementation\b[\s\S]*?<\/enho:badiImplementation>/;
const ENHOXH_SINGLE_IMPL_BLOCK = ENHOXH_XML.match(BADI_IMPL_BLOCK_RE)![0];
const ENHOXH_SECOND_IMPL_BLOCK = ENHOXH_SINGLE_IMPL_BLOCK.replace(
  'enho:name="ZMCP_BADI_I1"',
  'enho:name="ZMCP_BADI_I2"',
);
const ENHOXH_TWO_IMPLS_XML = ENHOXH_XML.replace(
  ENHOXH_SINGLE_IMPL_BLOCK,
  ENHOXH_SINGLE_IMPL_BLOCK + ENHOXH_SECOND_IMPL_BLOCK,
);

/**
 * Same three ENHO/XH documents as above, with ONE synthetic addition each: a
 * root `adtcore:description` attribute, inserted via
 * `patchEnhancementRootAttribute` itself (not a hand-rolled string edit) so
 * the insertion shape matches exactly what production code would produce.
 * Real `ENHO/XH` objects genuinely can have no description at all (see
 * `ENHOXH_XML`'s own doc comment) — but several tests below exist
 * to prove something UNRELATED to description handling (LOCK/PUT
 * choreography, ETAG comparison, retry-on-failure), and reusing the
 * description-less documents for those would now trip the new pre-lock
 * `ENHANCEMENT_DESCRIPTION_REQUIRED` guard (`assertDescriptionWillBePresent`,
 * added for the SWB_TOOL19 fix) on tests that were never about it. The
 * description-presence guard itself gets its own dedicated describe block
 * further below, which deliberately keeps using the description-LESS
 * documents.
 */
const ENHOXH_DESCRIPTION = "ZMCP recon BAdI implementation";
const ENHOXH_XML_WITH_DESC = patchEnhancementRootAttribute(ENHOXH_XML, "description", ENHOXH_DESCRIPTION);
const ENHOXH_SYNTHETIC_WITH_DESC = patchEnhancementRootAttribute(ENHOXH_SYNTHETIC_XML, "description", ENHOXH_DESCRIPTION);
const ENHOXH_TWO_IMPLS_WITH_DESC = patchEnhancementRootAttribute(ENHOXH_TWO_IMPLS_XML, "description", ENHOXH_DESCRIPTION);

/**
 * ENHS/XS document, verbatim from test/fixtures/enhancement/343-enhsxs-no-filters.xml
 * — name=ZMCP_SPOT, package=$TMP, masterSystem=A4H. Also UNVERIFIED for PUT.
 */
const ENHSXS_XML = fixture("343-enhsxs-no-filters.xml");

/** Real captured LOCK response shapes (405 = local, 203 = transport-flavoured). */
const LOCK_LOCAL_XML =
  `<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">` +
  `<asx:values><DATA><LOCK_HANDLE>84895B18717205C738BE52DAB00DC12609C1821F</LOCK_HANDLE><CORRNR/>` +
  `<CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/>` +
  `<MODIFICATION_SUPPORT>NoModification</MODIFICATION_SUPPORT><SCOPE_MESSAGES/></DATA></asx:values></asx:abap>`;

const LOCK_TRANSPORT_XML = (corrNr = "A4HK900160") =>
  `<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">` +
  `<asx:values><DATA><LOCK_HANDLE>145F86F08B50A4BFBD38B17BA7E13F0CEFA05EFD</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR>` +
  `<CORRUSER>DEVELOPER</CORRUSER><CORRTEXT>ZMCP BAdI live recon</CORRTEXT><IS_LOCAL/><IS_LINK_UP/>` +
  `<MODIFICATION_SUPPORT/><SCOPE_MESSAGES/></DATA></asx:values></asx:abap>`;

/** The ICM's own dead-session answer — see test/fixtures/enhancement/273-session-death-400-timeout.meta.json
 *  (real capture: GET .../enhancements/enhsxs/zmcp_spot -> 400 "Session timed out",
 *  these exact headers, 45-byte HTML body) and write-toctou.test.ts's identical constant
 *  for the fuller write-up of why this is NOT a parsed `exc:exception` envelope. */
const ICMENOSESSION_HEADERS = {
  "content-type": "text/html",
  "x-sap-icm-err-id": "ICMENOSESSION",
  "sap-err-id": "ICMENOSESSION",
};
const ICMENOSESSION_BODY =
  "<html><head><title>Application Server Error</title></head>" +
  "<body>Session timed out</body></html>";

/**
 * Copied verbatim from test/activate.test.ts — a real captured
 * `<chkl:messages>` envelope with two
 * `type="E"` `<msg>` elements, which `activateObject` turns into
 * `activated: false` without throwing.
 */
const ACTIVATION_ERRORS = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Program ZMCP_PROBE_REP" type="E" line="1"
       href="/sap/bc/adt/programs/programs/zmcp_probe_rep/source/main#start=4,0"
       forceSupported="true">
    <shortText><txt>Incomplete expression: Operand (e.g. field) missing at end of statement.</txt></shortText>
  </msg>
  <msg objDescr="Program ZMCP_PROBE_REP" type="E" line="2"
       href="/sap/bc/adt/programs/programs/zmcp_probe_rep/source/main#start=5,0"
       forceSupported="true">
    <shortText><txt>The statement "WRIT" is not expected. A correct similar statement is "WRITE".</txt></shortText>
  </msg>
</chkl:messages>`;

/**
 * A permissive gate config for the happy-path tests: allows the write's own
 * package ($TMP), enables enhancement authoring, opts into "customer"-owned
 * targets, and names A4H as an origin system (both the enhancement's own
 * masterSystem AND the affected object's masterSystem are A4H in every
 * fixture above, so ownership resolves to "customer" -> ALLOWED
 * unconditionally — see safety.ts's `enhancementRules` step 7).
 */
const gate = (extra: Partial<ConstructorParameters<typeof SafetyGate>[0]> = {}): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP"],
    allowEnhancements: true,
    enhanceTargets: "customer",
    originSystems: ["A4H"],
    ...extra,
  });

/** The object every ENHO/XHH fixture above says it hooks. */
const AFFECTS_HOOK = { name: "ZMCP_BADI_HOST", packageName: "$TMP", masterSystem: "A4H" };
/** A plausible "affects" for the ENHO/XH and ENHS/XS fixtures (their own spot/definition name). */
const AFFECTS_SPOT = { name: "ZMCP_SPOT", packageName: "$TMP", masterSystem: "A4H", spotName: "ZMCP_SPOT" };

// ===========================================================================

describe("writeEnhancementDescription — no-op short-circuit", () => {
  it("an identical description costs one GET, takes no lock, sends no PUT", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      // No LOCK/PUT/UNLOCK routed at all — a no-op must never reach them.
      return undefined;
    });

    const res = await writeEnhancementDescription(
      conn,
      gate(),
      { type: "ENHO/XHH", name: "ZMCP_ENH_B", description: "ZMCP recon hook impl" },
      { affects: AFFECTS_HOOK },
    );

    expect(res.changed).toBe(false);
    expect(res.putVerified).toBe(true); // spec.putVerifiedBy is set for ENHO/XHH regardless of the no-op
    expect(res.transport).toMatchObject({ status: "not-determined", required: false });
    expect(adt.calls).toHaveLength(1);
    expect(adt.verbs).toEqual(["GET"]);
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("PUT");
    expect(adt.verbs).not.toContain("UNLOCK");
  });
});

describe("writeEnhancementDescription — happy path, ENHO/XHH (PUT-verified type)", () => {
  it("GET -> LOCK -> GET(reread) -> PUT -> UNLOCK, in exact order, changed:true, putVerified:true", async () => {
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") {
        sourceReads += 1;
        return resp(200, ENHOXHH_XML, OK_XML);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXHH_URI && r.method === "PUT") return resp(200, "", { etag: "NEWETAG123=" });
      return undefined;
    });

    const res = await writeEnhancementDescription(
      conn,
      gate(),
      { type: "ENHO/XHH", name: "ZMCP_ENH_B", description: "a new description" },
      { affects: AFFECTS_HOOK },
    );

    expect(res.changed).toBe(true);
    expect(res.putVerified).toBe(true);
    expect(sourceReads).toBe(2); // pre-lock GET + post-lock reread, never more

    // Exact choreography, exact order — the whole point of this module.
    expect(adt.labels).toEqual([
      `GET ${ENHOXHH_URI}`,
      `LOCK ${ENHOXHH_URI}`,
      `GET ${ENHOXHH_URI}`,
      `PUT ${ENHOXHH_URI}`,
      `UNLOCK ${ENHOXHH_URI}`,
    ]);

    // Local object (IS_LOCAL=X in the LOCK response, no preflight transport
    // manager was even supplied) -> qs carries ONLY lockHandle, no corrNr key
    // at all (not `corrNr: ""`, not `corrNr: undefined` — see the corrNr-shape
    // tests below for the mechanical proof of this).
    const put = adt.calls.find((c) => c.method === "PUT")!;
    expect(put.qs).toEqual({ lockHandle: "84895B18717205C738BE52DAB00DC12609C1821F" });
    expect(put.body).toContain('adtcore:description="a new description"');
    expect(put.body).not.toContain('adtcore:description="ZMCP recon hook impl"');

    expect(res.transport).toMatchObject({ status: "local", required: false });
    expect(res.previousXml).toBe(ENHOXHH_XML);

    // Regression: the LOCK call must NOT send the document's own media type
    // (application/vnd.sap.adt.enh.enhoxhh.v2+xml) as its Accept header — a
    // live capture proved that gets a real 406 Not Acceptable, every time,
    // every enhancement type.
    // No override at all (falling through to the session's own default) is
    // what a live LOCK actually accepts (200 OK).
    const lock = adt.calls.find((c) => c.qs._action === "LOCK")!;
    expect(lock.headers?.Accept).not.toBe("application/vnd.sap.adt.enh.enhoxhh.v2+xml");
    // No lockAccept override ⇒ the vendor's own default LOCK Accept header
    // (abap-adt-api's objectcontents.js `lock()`) — exactly the header fixture
    // 703 captured getting a live 200.
    expect(lock.headers?.Accept).toBe(
      "application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result",
    );
  });
});

describe("writeEnhancementDescription — happy path, ENHO/XH (unverified type)", () => {
  it("same choreography, but putVerified:false on the result — the flag surfaces, PUT is NOT skipped", async () => {
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") {
        sourceReads += 1;
        return resp(200, ENHOXH_XML, OK_XML);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXH_URI && r.method === "PUT") return resp(200, "", { etag: "XHETAG=" });
      return undefined;
    });

    const res = await writeEnhancementDescription(
      conn,
      gate(),
      { type: "ENHO/XH", name: "ZMCP_ENH_BADI", description: "first description ever" },
      { affects: AFFECTS_SPOT },
    );

    // The mechanics are identical to the verified type...
    expect(res.changed).toBe(true);
    expect(sourceReads).toBe(2);
    expect(adt.labels).toEqual([
      `GET ${ENHOXH_URI}`,
      `LOCK ${ENHOXH_URI}`,
      `GET ${ENHOXH_URI}`,
      `PUT ${ENHOXH_URI}`,
      `UNLOCK ${ENHOXH_URI}`,
    ]);
    // ...but this collection's one observed live PUT 200 (see
    // enhancement-write.ts's module header "PUT verification matrix") has no
    // citation file in this repo to point putVerifiedBy at, so the result
    // still says unverified. This is the load-bearing assertion of this test
    // — NOT that the PUT happened (that's proven above), but that the
    // codebase does not silently overclaim it is verified without a citation.
    expect(res.putVerified).toBe(false);

    // The source document had no adtcore:description attribute at all before
    // this write (fixture 354's own real shape) — proves the append branch
    // of patchEnhancementRootAttribute, not just the replace branch already
    // exercised by the ENHO/XHH test above.
    const put = adt.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toContain('adtcore:description="first description ever"');
  });
});

describe("writeEnhancementDescription — SafetyGate denial", () => {
  it("a gate that does not allow this package's write refuses SAFETY_DENIED before any LOCK", async () => {
    let getCount = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") {
        getCount += 1;
        return resp(200, ENHOXHH_XML, OK_XML);
      }
      // No LOCK/PUT/UNLOCK routed: a denied intent must never reach them.
      return undefined;
    });

    // allowPackages does not contain "$TMP" (the enhancement's own package,
    // per every fixture above) — this trips the ORDINARY artefact-level
    // allowlist check inside evaluate(), which runs BEFORE the
    // enhancement/intent block ever calls enhancementRules(). Chosen
    // deliberately over e.g. allowEnhancements:false so the test proves the
    // gate's overall check ORDER, not just that "some" refusal exists.
    const deniedGate = gate({ allowPackages: ["ZOTHER"] });

    const e = await catchErr(
      writeEnhancementDescription(
        conn,
        deniedGate,
        { type: "ENHO/XHH", name: "ZMCP_ENH_B", description: "a new description" },
        { affects: AFFECTS_HOOK },
      ),
    );

    expect(e.code).toBe("SAFETY_DENIED");
    // Exactly one GET happened — the resolve read (spec.read) runs BEFORE
    // gate.assertIntent, so the gate cannot prevent that one request. But
    // nothing beyond it: the denial fires immediately after, before the
    // no-op comparison, before any lock.
    expect(getCount).toBe(1);
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("PUT");
    expect(adt.verbs).not.toContain("UNLOCK");
  });
});

describe("writeEnhancementDescription — NOT_FOUND (never creates)", () => {
  it("spec.read() 404ing throws NOT_FOUND, proving this module has no create path", async () => {
    const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
      <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
      <message lang="EN">ZMCP_ENH_B does not exist</message><properties/></exc:exception>`;

    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      return undefined;
    });

    const e = await catchErr(
      writeEnhancementDescription(
        conn,
        gate(),
        { type: "ENHO/XHH", name: "ZMCP_ENH_B", description: "anything" },
        { affects: AFFECTS_HOOK },
      ),
    );

    expect(e.code).toBe("NOT_FOUND");
    expect(adt.calls).toHaveLength(1); // the one failed resolve GET, nothing else
  });
});

describe("writeEnhancementDescription — post-lock ETAG_CONFLICT", () => {
  it("the whole document changed between the pre-lock GET and the lock: refuses, releases the lock, sends no PUT", async () => {
    // A concurrent editor renamed the description between our pre-lock read
    // and the lock — a genuinely different document, not a canonicalisation
    // quirk (canonicalEtag hashes the whole XML text here, unlike write.ts's
    // source-only canonicalisation, so ANY byte difference trips this).
    const CHANGED_XML = ENHOXHH_XML.replace(
      'adtcore:description="ZMCP recon hook impl"',
      'adtcore:description="someone else changed this"',
    );
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") {
        sourceReads += 1;
        return resp(200, sourceReads === 1 ? ENHOXHH_XML : CHANGED_XML, OK_XML);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      // No PUT route: catching this before the PUT is the whole point.
      return undefined;
    });

    const e = await catchErr(
      writeEnhancementDescription(
        conn,
        gate(),
        { type: "ENHO/XHH", name: "ZMCP_ENH_B", description: "my own new description" },
        { affects: AFFECTS_HOOK },
      ),
    );

    expect(e.code).toBe("ETAG_CONFLICT");
    expect(e.details.phase).toBe("post-lock");
    expect(adt.verbs).not.toContain("PUT");
    // The lock WAS taken and WAS released.
    expect(adt.labels).toEqual([
      `GET ${ENHOXHH_URI}`,
      `LOCK ${ENHOXHH_URI}`,
      `GET ${ENHOXHH_URI}`,
      `UNLOCK ${ENHOXHH_URI}`,
    ]);
  });
});

describe("writeEnhancementDescription — expectEtag pre-lock mismatch", () => {
  it("a caller-supplied expectEtag that disagrees with the pre-lock read refuses before any LOCK", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      // No LOCK/PUT/UNLOCK routed: the cheap pre-lock check must catch this
      // before an enqueue is ever taken.
      return undefined;
    });

    const e = await catchErr(
      writeEnhancementDescription(
        conn,
        gate(),
        { type: "ENHO/XHH", name: "ZMCP_ENH_B", description: "irrelevant, never reached" },
        { affects: AFFECTS_HOOK, expectEtag: "not-the-real-hash" },
      ),
    );

    expect(e.code).toBe("ETAG_CONFLICT");
    // No `phase` key on the pre-lock refusal — mirrors write.ts's own
    // `assertEtagMatches` shape, distinguishing it from the post-lock one.
    expect(e.details.phase).toBeUndefined();
    expect(adt.verbs.filter((v) => v === "LOCK")).toHaveLength(0);
    expect(adt.verbs).not.toContain("PUT");
  });
});

// ===========================================================================
// corrNr-shape / corrNr-fabrication-impossibility tests.
// The production comment at enhancement-write.ts's `attempt`
// closure names this file explicitly: "a literal two-shape switch... there is
// no code path here that can construct qs: { lockHandle, corrNr: "" } or
// qs: { lockHandle, corrNr: undefined }". These tests are the mechanical
// proof of that claim, driving BOTH shapes and asserting the EXACT qs object
// the fake HTTP client received.
// ===========================================================================

describe("writeEnhancementDescription — corrNr qs shape", () => {
  it("preflight local (no opts.transport at all) but the lock reports transport required: TRANSPORT_ERROR, lock released, no PUT", async () => {
    // No `opts.transport` supplied at all -> `preflightCorr` unconditionally
    // returns `undefined` (write.ts:1049, `if (opts.transport === undefined)
    // return undefined;`) -> `corrForMutation(undefined, lockTransport)`
    // evaluates to `undefined` whenever the LOCK response reports
    // `required: true` (a non-empty CORRNR, empty IS_LOCAL) -> the refusal
    // path fires. This is scenario (a) of the corrNr matrix, and needs no
    // SessionTransport construction at all — the simplest possible way to
    // reach "preflight said local, the lock disagrees".
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_TRANSPORT_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      // No PUT route: refused before it.
      return undefined;
    });

    const e = await catchErr(
      writeEnhancementDescription(
        conn,
        gate(),
        { type: "ENHO/XHH", name: "ZMCP_ENH_B", description: "wants a transport" },
        { affects: AFFECTS_HOOK }, // no `transport`/`gate` on opts -> the "local" arm of EnhancementTransportOptions
      ),
    );

    expect(e.code).toBe("TRANSPORT_ERROR");
    expect(adt.verbs).not.toContain("PUT");
    // Lock taken, then released — this is a refusal AFTER the enqueue.
    expect(adt.labels).toEqual([
      `GET ${ENHOXHH_URI}`,
      `LOCK ${ENHOXHH_URI}`,
      `GET ${ENHOXHH_URI}`,
      `UNLOCK ${ENHOXHH_URI}`,
    ]);
  });

  it("both transport-flavoured: preflight resolves a real corrNr, the PUT qs carries exactly {lockHandle, corrNr}", async () => {
    const CORRNR = "A4HK900160";

    // Fake CTS overrides — signatures matched exactly against src/adt/transports.ts.
    // `trRequirement` reports the object as needing a transport (not local,
    // not auto-created — the caller must name one, which opts.corrNr below does).
    const trRequirement = vi.fn(
      async (): Promise<TrRequirement> => ({
        kind: "transport-required",
        mustSupplyCorrNr: true,
        serverWouldFabricate: false,
        uri: ENHOXHH_URI,
        operation: "U",
        devclass: "$TMP",
        candidates: [],
        locks: [],
        messages: [],
        checkFailed: false,
        raw: { result: "E", korrflag: "X", recording: "" },
      }),
    );
    // `trShow` reports the caller-named request as modifiable — the
    // `#checkUsable` gate `SessionTransport.resolve` runs on a caller-named
    // corrNr (session-transport.ts's `#checkUsable`, calling this).
    const trShow = vi.fn(
      async (): Promise<TrRequest> => ({
        trkorr: CORRNR,
        kind: "workbench",
        kindRaw: "K",
        status: "modifiable",
        statusRaw: "D",
        owner: "DEVELOPER",
        description: "ZMCP BAdI live recon",
        tasks: [],
        objects: [],
      }),
    );

    const transport = new SessionTransport({
      allowTransports: ["*"], // wildcard: #callerMayName(CORRNR) is true
      cts: { trRequirement, trShow },
    });

    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_TRANSPORT_XML(CORRNR), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXHH_URI && r.method === "PUT") return resp(200, "", { etag: "TRETAG=" });
      return undefined;
    });

    const res = await writeEnhancementDescription(
      conn,
      gate(),
      { type: "ENHO/XHH", name: "ZMCP_ENH_B", description: "transport-flavoured write" },
      { affects: AFFECTS_HOOK, transport, gate: gate(), corrNr: CORRNR },
    );

    expect(res.changed).toBe(true);
    expect(trRequirement).toHaveBeenCalledTimes(1);
    expect(trShow).toHaveBeenCalledTimes(1);

    const put = adt.calls.find((c) => c.method === "PUT")!;
    // The exact two-shape switch: a real `string` corrNr, never "" or missing.
    expect(put.qs).toEqual({
      lockHandle: "145F86F08B50A4BFBD38B17BA7E13F0CEFA05EFD",
      corrNr: CORRNR,
    });
    expect(res.transport).toMatchObject({ status: "transport", required: true, corrNr: CORRNR });
  });

  it("corrNr divergence: preflight names one request, the lock reports a DIFFERENT one -> TRANSPORT_ERROR, lock released, no PUT", async () => {
    const NAMED_CORRNR = "A4HK900160";
    const LOCK_CORRNR = "A4HK900199"; // a different, real-shaped TRKORR

    const trRequirement = vi.fn(
      async (): Promise<TrRequirement> => ({
        kind: "transport-required",
        mustSupplyCorrNr: true,
        serverWouldFabricate: false,
        uri: ENHOXHH_URI,
        operation: "U",
        devclass: "$TMP",
        candidates: [],
        locks: [],
        messages: [],
        checkFailed: false,
        raw: { result: "E", korrflag: "X", recording: "" },
      }),
    );
    const trShow = vi.fn(
      async (): Promise<TrRequest> => ({
        trkorr: NAMED_CORRNR,
        kind: "workbench",
        kindRaw: "K",
        status: "modifiable",
        statusRaw: "D",
        owner: "DEVELOPER",
        description: "ZMCP BAdI live recon",
        tasks: [],
        objects: [],
      }),
    );
    const transport = new SessionTransport({
      allowTransports: ["*"],
      cts: { trRequirement, trShow },
    });

    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      // The LOCK reports a DIFFERENT transport than the one the gate judged.
      if (r.qs._action === "LOCK") return resp(200, LOCK_TRANSPORT_XML(LOCK_CORRNR), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      // No PUT route: divergence must be refused before it.
      return undefined;
    });

    const e = await catchErr(
      writeEnhancementDescription(
        conn,
        gate(),
        { type: "ENHO/XHH", name: "ZMCP_ENH_B", description: "divergent transport" },
        { affects: AFFECTS_HOOK, transport, gate: gate(), corrNr: NAMED_CORRNR },
      ),
    );

    expect(e.code).toBe("TRANSPORT_ERROR");
    expect(e.details.gatedCorrNr).toBe(NAMED_CORRNR);
    expect(e.details.serverCorrNr).toBe(LOCK_CORRNR);
    expect(adt.verbs).not.toContain("PUT");
    expect(adt.labels).toEqual([
      `GET ${ENHOXHH_URI}`,
      `LOCK ${ENHOXHH_URI}`,
      `GET ${ENHOXHH_URI}`,
      `UNLOCK ${ENHOXHH_URI}`,
    ]);
  });
});

describe("writeEnhancementDescription — SESSION_DEAD mid-choreography", () => {
  it("a session that died between LOCK and the post-lock reread propagates as SESSION_DEAD, and sends NO UNLOCK", async () => {
    // VERIFIED against src/adt/relock.ts's withRelockRetry: on a SESSION_DEAD
    // classified error, step 5 (its own numbering) calls
    // `session.forgetLock(uri)` and rethrows WITHOUT calling `session.unlock`
    // at all — checked BEFORE the general retryable branch that does
    // unlock-then-forgetLock. So the fake below deliberately has no UNLOCK
    // route: if a regression reintroduced one, `FakeAdt`'s loud unrouted
    // fallback (or a stray label in `adt.verbs`) would catch it either way.
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHSXS_URI && r.method === "GET") {
        sourceReads += 1;
        if (sourceReads === 1) return resp(200, ENHSXS_XML, OK_XML);
        return resp(400, ICMENOSESSION_BODY, ICMENOSESSION_HEADERS);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      // No UNLOCK route, no PUT route, deliberately.
      return undefined;
    });

    const e = await catchErr(
      writeEnhancementDescription(
        conn,
        gate(),
        { type: "ENHS/XS", name: "ZMCP_SPOT", description: "never gets written" },
        { affects: AFFECTS_SPOT },
      ),
    );

    expect(e.code).toBe("SESSION_DEAD");
    expect(adt.verbs).not.toContain("PUT");
    expect(adt.verbs).not.toContain("UNLOCK");
    // Exactly: resolve GET, LOCK, the fatal post-lock GET. Nothing after it.
    expect(adt.labels).toEqual([
      `GET ${ENHSXS_URI}`,
      `LOCK ${ENHSXS_URI}`,
      `GET ${ENHSXS_URI}`,
    ]);
  });
});

// ===========================================================================
// writeAndActivateEnhancementDescription
// ===========================================================================

describe("writeAndActivateEnhancementDescription", () => {
  it("a no-op write (changed:false) triggers NO activation call at all", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      // No LOCK/PUT/UNLOCK/activation routed.
      return undefined;
    });

    const res = await writeAndActivateEnhancementDescription(
      conn,
      gate(),
      { type: "ENHO/XHH", name: "ZMCP_ENH_B", description: "ZMCP recon hook impl" }, // identical -> no-op
      { affects: AFFECTS_HOOK },
    );

    expect(res.write.changed).toBe(false);
    expect(res.activation).toBeUndefined();
    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(false);
  });

  it("a real change invokes activateObject with {name, uri} after the write completes", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXHH_URI && r.method === "PUT") return resp(200, "", { etag: "ACTETAG=" });
      if (r.url.includes("/activation"))
        return resp(
          200,
          `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`,
          OK_XML,
        );
      return undefined;
    });

    const res = await writeAndActivateEnhancementDescription(
      conn,
      gate(),
      { type: "ENHO/XHH", name: "ZMCP_ENH_B", description: "activate me" },
      { affects: AFFECTS_HOOK },
    );

    expect(res.write.changed).toBe(true);
    expect(res.activation).toBeDefined();
    expect(res.activation!.activated).toBe(true);
    // The write's own UNLOCK happens strictly BEFORE the activation POST
    // (activating while the lock is still held is a 403).
    const unlockIdx = adt.calls.findIndex((c) => c.qs._action === "UNLOCK");
    const activateIdx = adt.calls.findIndex((c) => c.url.includes("/activation"));
    expect(unlockIdx).toBeGreaterThanOrEqual(0);
    expect(activateIdx).toBeGreaterThan(unlockIdx);
  });

  it("a failed activation (real captured 382/455-shaped error checklist) reports activated:false without throwing", async () => {
    const { conn } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXHH_URI && r.method === "PUT") return resp(200, "", { etag: "FAILETAG=" });
      if (r.url.includes("/activation")) return resp(200, ACTIVATION_ERRORS, OK_XML);
      return undefined;
    });

    const res = await writeAndActivateEnhancementDescription(
      conn,
      gate(),
      { type: "ENHO/XHH", name: "ZMCP_ENH_B", description: "activation will fail" },
      { affects: AFFECTS_HOOK },
    );

    // The write itself succeeded — only activation reported problems.
    expect(res.write.changed).toBe(true);
    expect(res.activation).toBeDefined();
    expect(res.activation!.activated).toBe(false);
    expect(res.activation!.messages?.length ?? 0).toBeGreaterThan(0);
  });
});

// ===========================================================================
// deleteEnhancementObject — H8 (active BAdI implementation) fires even when
// the config-level gate is OPEN, including via the `AbapModeUnlocks` unlock
// (`ABAP_ALLOW_ENHANCEMENT_DELETE` under `ABAP_MODE=edit` — src/mode.ts).
// This is the specific proof this project's H8 doc comments promise: the
// unconditional refusal has NO override, and turning the config gate on (by
// whatever mechanism) does not even brush against it. `354-enhoxh-no-filter.xml`
// has exactly one `badiImplementation`, `isActive="true"` — see the constant
// above. Only a GET is routed below: `deleteEnhancementObject`'s own step
// ordering (module source, "---- H8" comment block) runs this check
// immediately after the one GET (step 1) and strictly before
// `gate.authorizeIntent` (step 2), the etag check (step 3), transport
// preflight (step 4) and `onBeforeImage` (step 5) — so a LOCK/DELETE route,
// or an `onBeforeImage` call, would mean this test's premise (H8 pre-empts
// everything downstream) is false. `FakeAdt` throws loudly on any unrouted
// request, so a regression that moved H8 below the lock would fail this test
// via that trip-wire, not silently pass.
// ===========================================================================

describe("deleteEnhancementObject — H8 fires with the config gate open (flag/unlock granted)", () => {
  const onBeforeImage = vi.fn(async () => {});

  it("config gate via legacy flag alone (no ABAP_MODE) still hits H8", async () => {
    onBeforeImage.mockClear();
    const { conn } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_XML, OK_XML);
      return undefined;
    });

    const err = await catchErr(
      deleteEnhancementObject(
        conn,
        gate(),
        { type: "ENHO/XH", name: "ZMCP_ENH_BADI" },
        { affects: AFFECTS_SPOT, allowEnhancementDelete: true, onBeforeImage },
      ),
    );

    expect(err.code).toBe("ENHANCEMENT_ACTIVE_IMPLEMENTATION");
    expect(err.message).toContain("ZMCP_BADI_I1");
    expect(err.message).toContain("H8");
    expect(onBeforeImage).not.toHaveBeenCalled();
  });

  it("config gate via the ABAP_MODE=edit unlock (ABAP_ALLOW_ENHANCEMENT_DELETE under edit) still hits H8", async () => {
    onBeforeImage.mockClear();
    const { conn } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_XML, OK_XML);
      return undefined;
    });

    // `allowEnhancementDelete: true` here stands in for what
    // `capabilitiesForMode("edit", {}, {}, { allowEnhancementDelete: true })`
    // actually produces once ABAP_ALLOW_ENHANCEMENT_DELETE is set under
    // ABAP_MODE=edit (test/mode.test.ts proves that mapping directly) — this
    // module never reads env vars or ABAP_MODE itself (see
    // `DeleteEnhancementObjectOptions.allowEnhancementDelete`'s doc comment),
    // so passing the already-resolved boolean plus `abapMode: "edit"` is the
    // correct way to exercise "the unlock granted it" at this layer.
    const err = await catchErr(
      deleteEnhancementObject(
        conn,
        gate(),
        { type: "ENHO/XH", name: "ZMCP_ENH_BADI" },
        { affects: AFFECTS_SPOT, allowEnhancementDelete: true, abapMode: "edit", onBeforeImage },
      ),
    );

    expect(err.code).toBe("ENHANCEMENT_ACTIVE_IMPLEMENTATION");
    expect(err.message).toContain("ZMCP_BADI_I1");
    expect(err.message).toContain("H8");
    // H8's own message DOES name this flag — but only to say it has no power
    // here ("This refusal has NO override: not ABAP_ALLOW_ENHANCEMENT_DELETE,
    // not any other flag"), which is the opposite claim from the stale
    // "ABAP_MODE overrides the flag" message this whole change fixes
    // elsewhere. Asserting the exact sanctioned sentence, not just absence.
    expect(err.message).toContain(
      "This refusal has NO override: not ABAP_ALLOW_ENHANCEMENT_DELETE, not any other flag.",
    );
    expect(onBeforeImage).not.toHaveBeenCalled();
  });

  it("admin (outright grant, no flag at all) also still hits H8", async () => {
    onBeforeImage.mockClear();
    const { conn } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_XML, OK_XML);
      return undefined;
    });

    const err = await catchErr(
      deleteEnhancementObject(
        conn,
        gate(),
        { type: "ENHO/XH", name: "ZMCP_ENH_BADI" },
        { affects: AFFECTS_SPOT, allowEnhancementDelete: true, abapMode: "admin", onBeforeImage },
      ),
    );

    expect(err.code).toBe("ENHANCEMENT_ACTIVE_IMPLEMENTATION");
    expect(onBeforeImage).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// setBadiImplementationActive (set_impl_active) — flips a single named
// <enho:badiImplementation>'s own `isActive` via the same whole-document
// LOCK -> reread -> rebuild -> PUT -> UNLOCK choreography
// writeEnhancementDescription already uses for ENHO/XH (same `putVerified:
// false`, same withRelockRetry, same enhancementRetryable policy). `onBeforeImage`
// is REQUIRED on this function's options (unlike writeEnhancementDescription's
// optional one) — every call below supplies a `vi.fn`.
// ===========================================================================

describe("setBadiImplementationActive — no-op short-circuit", () => {
  it("isActive already matches the requested value: one GET, no LOCK/PUT/UNLOCK", async () => {
    const onBeforeImage = vi.fn(async () => {});
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_SYNTHETIC_XML, OK_XML);
      // No LOCK/PUT/UNLOCK routed at all — a no-op must never reach them.
      return undefined;
    });

    const res = await setBadiImplementationActive(
      conn,
      gate(),
      { name: "ZMCP_ENH_BADI", active: true }, // already true in the fixture
      { affects: AFFECTS_SPOT, onBeforeImage },
    );

    expect(res.changed).toBe(false);
    expect(res.putVerified).toBe(false); // ENHO/XH is unverified, same as writeEnhancementDescription
    expect(res.transport).toMatchObject({ status: "not-determined", required: false });
    expect(adt.calls).toHaveLength(1);
    expect(adt.verbs).toEqual(["GET"]);
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("PUT");
    expect(adt.verbs).not.toContain("UNLOCK");
    expect(onBeforeImage).not.toHaveBeenCalled();
  });
});

describe("setBadiImplementationActive — happy path", () => {
  it("GET -> LOCK -> GET(reread) -> PUT -> UNLOCK, in exact order, changed:true, the PUT body carries the flipped attribute", async () => {
    // Uses the WITH_DESC variant (see its own doc comment above) — this test
    // is about the LOCK/PUT choreography, not about description handling, so
    // it deliberately avoids tripping the new pre-lock description guard.
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") {
        sourceReads += 1;
        return resp(200, ENHOXH_SYNTHETIC_WITH_DESC, OK_XML);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXH_URI && r.method === "PUT") return resp(200, "", { etag: "ACTIVEETAG=" });
      return undefined;
    });

    const onBeforeImage = vi.fn(async () => {});
    const res = await setBadiImplementationActive(
      conn,
      gate(),
      { name: "ZMCP_ENH_BADI", active: false }, // flips true -> false
      { affects: AFFECTS_SPOT, onBeforeImage },
    );

    expect(res.changed).toBe(true);
    expect(res.putVerified).toBe(false);
    expect(sourceReads).toBe(2); // pre-lock GET + post-lock reread, never more
    expect(onBeforeImage).toHaveBeenCalledTimes(1);

    // Exact choreography, exact order.
    expect(adt.labels).toEqual([
      `GET ${ENHOXH_URI}`,
      `LOCK ${ENHOXH_URI}`,
      `GET ${ENHOXH_URI}`,
      `PUT ${ENHOXH_URI}`,
      `UNLOCK ${ENHOXH_URI}`,
    ]);

    const put = adt.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toContain('enho:name="ZMCP_ENH_BADI" enho:shortText="" enho:isExample="false" enho:isDefault="false" enho:isActive="false"');
    // Only the target attribute changed — the rest of the document (e.g. the
    // implementingClass/badiDefinition children) is byte-identical, proving
    // this went through the byte-preserving patch, not a rebuild.
    expect(put.body).toBe(ENHOXH_SYNTHETIC_WITH_DESC.replace('enho:isActive="true"', 'enho:isActive="false"'));

    expect(res.transport).toMatchObject({ status: "local", required: false });
    expect(res.previousXml).toBe(ENHOXH_SYNTHETIC_WITH_DESC);
  });
});

describe("setBadiImplementationActive — REGRESSION: the container-name/entry-name conflation defect is fixed", () => {
  it("the real, unmodified fixture 354 (container ZMCP_ENH_BADI, entry ZMCP_BADI_I1 — genuinely different strings) resolves and flips with spec.implName omitted", async () => {
    // This is THE regression test for the defect: `name` = the CONTAINER's
    // own adtcore:name (the schema-documented contract for write_description/
    // delete/set_impl_active alike), against the REAL, unmodified fixture
    // 354 — no byte substitution anywhere in this test. `implName` is
    // omitted entirely: the document has exactly one <enho:badiImplementation>
    // entry, so `resolveBadiImplementationEntry` resolves it unambiguously.
    //
    // Before the fix, `setBadiImplementationActive` used `target.name` (the
    // container's name, "ZMCP_ENH_BADI") to search for an entry whose own
    // `enho:name` equalled it — but the entry's own name is "ZMCP_BADI_I1",
    // a different string, so the lookup always failed with NOT_FOUND before
    // any lock was ever taken. Confirmed red against the pre-fix code before
    // this test was finalized (see the task's own verification instructions).
    //
    // Uses ENHOXH_XML_WITH_DESC (see its doc comment above), not the raw
    // description-less ENHOXH_XML — this test is about the container/entry
    // name resolution defect, not about description handling, so it
    // deliberately avoids tripping the new pre-lock description guard.
    const onBeforeImage = vi.fn(async () => {});
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_XML_WITH_DESC, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXH_URI && r.method === "PUT") return resp(200, "", { etag: "REALFIXETAG=" });
      return undefined;
    });

    const res = await setBadiImplementationActive(
      conn,
      gate(),
      { name: "ZMCP_ENH_BADI", active: false }, // container name only — implName omitted
      { affects: AFFECTS_SPOT, onBeforeImage },
    );

    expect(res.changed).toBe(true);
    // The RESOLVED entry's own name is reported — never silently equal to
    // the container's name (they genuinely differ in this document).
    expect(res.target.name).toBe("ZMCP_ENH_BADI");
    expect(res.target.implName).toBe("ZMCP_BADI_I1");
    expect(adt.verbs).toEqual(["GET", "LOCK", "GET", "PUT", "UNLOCK"]);
    const put = adt.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toBe(patchBadiImplementationActive(ENHOXH_XML_WITH_DESC, "ZMCP_BADI_I1", false));
    expect(put.body).toContain('enho:name="ZMCP_BADI_I1"');
    expect(put.body).toContain('enho:isActive="false"');
    expect(onBeforeImage).toHaveBeenCalledTimes(1);
  });

  it("calling with the entry's own name as `name` (the OLD, now-corrected H8 hint contract) still cannot resolve a URI for a real object — `name` is always the container", async () => {
    // `deleteEnhancementObject`'s H8 refusal hint USED TO say (verbatim):
    // '(name: the entry\'s own name, spec.active: false)' — that text has
    // been corrected (see the H8 refusal test below) to say `name` is the
    // object being deleted and `spec.implName` is the entry's own name. This
    // test guards that `name` never secretly means "the entry" — passing an
    // entry's own name as `name` builds a URI for an object that does not
    // exist (no real ENHO/XH document is ever named after one of its own
    // nested implementation entries), routed here as a 404.
    const onBeforeImage = vi.fn(async () => {});
    const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
      <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
      <message lang="EN">ZMCP_BADI_I1 does not exist</message><properties/></exc:exception>`;
    const { conn, adt } = await connected((r) => {
      if (r.url === "/sap/bc/adt/enhancements/enhoxh/ZMCP_BADI_I1" && r.method === "GET") {
        return resp(404, NOT_FOUND_XML, OK_XML);
      }
      return undefined;
    });

    const e = await catchErr(
      setBadiImplementationActive(
        conn,
        gate(),
        { name: "ZMCP_BADI_I1", active: false }, // wrong: an entry's own name is never a valid `name`
        { affects: AFFECTS_SPOT, onBeforeImage },
      ),
    );

    expect(e.code).toBe("NOT_FOUND");
    expect(adt.calls).toHaveLength(1);
    expect(onBeforeImage).not.toHaveBeenCalled();
  });
});

describe("setBadiImplementationActive — ambiguous entry resolution (more than one <enho:badiImplementation> entry)", () => {
  it("implName omitted with two entries: BAD_INPUT naming both, no lock ever taken", async () => {
    const onBeforeImage = vi.fn(async () => {});
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_TWO_IMPLS_XML, OK_XML);
      // No LOCK/PUT/UNLOCK routed — an ambiguous request must never guess.
      return undefined;
    });

    const e = await catchErr(
      setBadiImplementationActive(
        conn,
        gate(),
        { name: "ZMCP_ENH_BADI", active: false },
        { affects: AFFECTS_SPOT, onBeforeImage },
      ),
    );

    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toContain("ZMCP_BADI_I1");
    expect(e.message).toContain("ZMCP_BADI_I2");
    expect(e.details.knownEntries).toEqual(["ZMCP_BADI_I1", "ZMCP_BADI_I2"]);
    expect(adt.calls).toHaveLength(1);
    expect(adt.verbs).toEqual(["GET"]);
    expect(onBeforeImage).not.toHaveBeenCalled();
  });

  it("explicit implName selecting the second of several entries flips only that one — the first entry's own bytes are unchanged", async () => {
    // Uses ENHOXH_TWO_IMPLS_WITH_DESC (see the WITH_DESC doc comment above) —
    // this test is about entry resolution/byte preservation, not description
    // handling, so it deliberately avoids tripping the new pre-lock guard.
    const onBeforeImage = vi.fn(async () => {});
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_TWO_IMPLS_WITH_DESC, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXH_URI && r.method === "PUT") return resp(200, "", { etag: "SECONDETAG=" });
      return undefined;
    });

    const res = await setBadiImplementationActive(
      conn,
      gate(),
      { name: "ZMCP_ENH_BADI", active: false, implName: "ZMCP_BADI_I2" },
      { affects: AFFECTS_SPOT, onBeforeImage },
    );

    expect(res.changed).toBe(true);
    expect(res.target.implName).toBe("ZMCP_BADI_I2");
    const put = adt.calls.find((c) => c.method === "PUT")!;
    // Byte-preserving patch on ONLY the second entry — comparing against the
    // same production patcher applied directly proves nothing else moved,
    // including the first entry's own (untouched) `enho:isActive="true"`.
    expect(put.body).toBe(patchBadiImplementationActive(ENHOXH_TWO_IMPLS_WITH_DESC, "ZMCP_BADI_I2", false));
    expect(put.body).toContain('enho:name="ZMCP_BADI_I1"');
    expect(put.body.match(/enho:isActive="true"/g)).toHaveLength(1); // only the first entry's, still true
    expect(put.body.match(/enho:isActive="false"/g)).toHaveLength(1); // only the second entry's, now false
  });

  it("implName naming a nonexistent entry: NOT_FOUND listing the real ones", async () => {
    const onBeforeImage = vi.fn(async () => {});
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_TWO_IMPLS_XML, OK_XML);
      return undefined;
    });

    const e = await catchErr(
      setBadiImplementationActive(
        conn,
        gate(),
        { name: "ZMCP_ENH_BADI", active: false, implName: "ZMCP_BADI_NOPE" },
        { affects: AFFECTS_SPOT, onBeforeImage },
      ),
    );

    expect(e.code).toBe("NOT_FOUND");
    expect(e.details.knownEntries).toEqual(["ZMCP_BADI_I1", "ZMCP_BADI_I2"]);
    expect(adt.calls).toHaveLength(1);
    expect(onBeforeImage).not.toHaveBeenCalled();
  });
});

describe("setBadiImplementationActive — expectEtag pre-lock mismatch", () => {
  it("a deliberately WRONG expectEtag refuses as ETAG_CONFLICT before any LOCK — proves the guard actually compares, not just accepts", async () => {
    // Uses ENHOXH_SYNTHETIC_WITH_DESC — a description-less document here
    // would trip the (also pre-lock, but earlier at step 3.5) description
    // guard first, masking the etag-mismatch behaviour this test is actually
    // about (etag compare is step 4, strictly after the description guard).
    const onBeforeImage = vi.fn(async () => {});
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_SYNTHETIC_WITH_DESC, OK_XML);
      // No LOCK/PUT/UNLOCK routed: the cheap pre-lock check must catch this
      // before an enqueue is ever taken.
      return undefined;
    });

    const e = await catchErr(
      setBadiImplementationActive(
        conn,
        gate(),
        { name: "ZMCP_ENH_BADI", active: false },
        { affects: AFFECTS_SPOT, onBeforeImage, expectEtag: "deliberately-wrong-etag-not-the-real-hash" },
      ),
    );

    expect(e.code).toBe("ETAG_CONFLICT");
    expect(e.details.phase).toBeUndefined(); // pre-lock shape, distinct from the post-lock one
    expect(adt.verbs.filter((v) => v === "LOCK")).toHaveLength(0);
    expect(adt.verbs).not.toContain("PUT");
    expect(onBeforeImage).not.toHaveBeenCalled();
  });
});

describe("setBadiImplementationActive — unlock still happens even when every PUT fails", () => {
  it("a generic (non-ADT-exception-shaped) PUT 500 classifies as retryable ADT_ERROR: withRelockRetry burns both attempts, UNLOCK fires after EACH failed PUT, then the last error is rethrown", async () => {
    // VERIFIED against src/adt/session.ts's translateAdtError: a plain 500
    // with no recognizable lock-conflict/invalid-lock-handle/session-death/
    // 404 shape falls through to the generic "ADT_ERROR" code, which is NOT
    // in enhancement-write.ts's own NON_RETRYABLE_CODES set — so relock.ts's
    // withRelockRetry treats it as retryable and takes its step-6 branch:
    // best-effort unlock, forgetLock, then retry with a FRESH lock — twice
    // (maxAttempts defaults to 2), matching test/bopf-client.test.ts's own
    // "exhausts retries" proof of the same shared law for BOPF. Uses
    // ENHOXH_SYNTHETIC_WITH_DESC — this test is about retry/unlock mechanics,
    // not description handling.
    let sourceReads = 0;
    let lockCount = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") {
        sourceReads += 1;
        return resp(200, ENHOXH_SYNTHETIC_WITH_DESC, OK_XML);
      }
      if (r.qs._action === "LOCK") {
        lockCount += 1;
        return resp(200, LOCK_LOCAL_XML, OK_XML);
      }
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXH_URI && r.method === "PUT") return resp(500, "<exc:exception/>", OK_XML);
      return undefined;
    });

    const onBeforeImage = vi.fn(async () => {});
    const e = await catchErr(
      setBadiImplementationActive(
        conn,
        gate(),
        { name: "ZMCP_ENH_BADI", active: false },
        { affects: AFFECTS_SPOT, onBeforeImage },
      ),
    );

    expect(e.code).toBe("ADT_ERROR");
    expect(e.details.attempts).toBe(2);
    expect(lockCount).toBe(2);
    // The assertion that matters: UNLOCK fired on BOTH attempts, not zero.
    // A failed PUT must never strand an enqueue that only dies with the
    // session (same law test/write.test.ts's "unlocks even when the PUT
    // fails" proves for writeObject, and test/bopf-client.test.ts's
    // "re-lock-after-failure" describe block proves for BOPF).
    expect(adt.verbs.filter((v) => v === "UNLOCK")).toHaveLength(2);
    expect(adt.verbs.filter((v) => v === "PUT")).toHaveLength(2);
    // 1 resolve read + 2 rereads (one per attempt) = 3 GETs total.
    expect(sourceReads).toBe(3);
    expect(onBeforeImage).toHaveBeenCalledTimes(1); // fired once, pre-lock, before either attempt
  });
});

// ===========================================================================
// ENHANCEMENT_DESCRIPTION_REQUIRED (SWB_TOOL19 fix) — a real ENHO/XH object
// can legitimately have NO root `adtcore:description` at all (confirmed
// live), but SAP's own PUT
// handler for enhoxh/enhoxhh/enhsxs rejects EVERY write against such a
// document unconditionally — HTTP 400 ExceptionInvalidData, SWB_TOOL19 /
// scr_prop_no_decr, "The description is missing" — even one that only
// flips `isActive` and never touches the description at all
// (observed live).
// `assertDescriptionWillBePresent` (pre-lock) and `putEnhancementDocument`
// (defence-in-depth, on the actual outgoing bytes) are the two enforcement
// points; this block proves both the refusal shape and the two escape
// hatches (`write_description` first, or `spec.description` inline).
//
// RED-BEFORE-FIX, CONFIRMED: the first test below
// ("a descriptionless object refuses BEFORE any lock...") was run once with
// the `assertDescriptionWillBePresent(...)` call at the top of step 3.5 in
// `setBadiImplementationActive` (src/adt/enhancement-write.ts) temporarily
// commented out via the Edit tool (no git). Result: RED, but for the right
// reason — `e.code` came back `"ADT_ERROR"` (`expected 'ADT_ERROR' to be
// 'ENHANCEMENT_DESCRIPTION_REQUIRED'`), because with the guard gone the call
// no longer stops at step 3.5 and instead proceeds toward step 4/LOCK, which
// this test's route intentionally leaves unmocked (by design — it exists to
// prove nothing past the resolve GET happens once the fix is in place). In
// production, an unneutered LOCK would succeed and the flow would reach the
// real PUT, which is exactly the live SWB_TOOL19 400 this whole fix exists
// to prevent. The guard was then restored (Edit tool) and this file re-run
// to confirm all tests green again before proceeding.
// ===========================================================================

describe("setBadiImplementationActive — ENHANCEMENT_DESCRIPTION_REQUIRED (SWB_TOOL19 regression)", () => {
  it("a descriptionless object refuses BEFORE any lock, with the actionable message — zero LOCK, zero PUT, zero UNLOCK calls", async () => {
    // ENHOXH_XML (fixture 354, unmodified, real capture) genuinely has no
    // root adtcore:description — see its own doc comment above. Only a GET
    // is routed: if this guard fired anywhere other than pre-lock, the
    // FakeAdt's "throw on unrouted request" trip-wire would catch it, same
    // as every other pre-lock-refusal test in this file.
    const onBeforeImage = vi.fn(async () => {});
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_XML, OK_XML);
      return undefined;
    });

    const e = await catchErr(
      setBadiImplementationActive(
        conn,
        gate(),
        { name: "ZMCP_ENH_BADI", active: false }, // flips true -> false; NOT a no-op
        { affects: AFFECTS_SPOT, onBeforeImage },
      ),
    );

    expect(e.code).toBe("ENHANCEMENT_DESCRIPTION_REQUIRED");
    expect(e.message).toBe(
      'ENHO/XH ZMCP_ENH_BADI: this write would leave the root adtcore:description missing or empty. ' +
        "SAP's enhancement PUT handler rejects that unconditionally (HTTP 400 ExceptionInvalidData, " +
        'SWB_TOOL19 / scr_prop_no_decr, "The description is missing") — even a write that has nothing ' +
        "to do with the description, like set_impl_active, is refused if the object has none. Nothing " +
        "was locked or written.",
    );
    expect(e.hint).toBe(
      "ZMCP_ENH_BADI has no description of its own, and set_impl_active does not invent one. Call " +
        'abap_enh operation:"write_description" (name:"ZMCP_ENH_BADI", type:"ENHO/XH") first, then retry ' +
        "— or pass spec.description in this same call (only accepted when the object currently has " +
        "none, as it does now).",
    );

    // The load-bearing assertions: not merely "an error was thrown", but
    // that NOTHING beyond the one resolve GET ever happened.
    expect(adt.calls).toHaveLength(1);
    expect(adt.verbs).toEqual(["GET"]);
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("PUT");
    expect(adt.verbs).not.toContain("UNLOCK");
    expect(onBeforeImage).not.toHaveBeenCalled();
  });

  it("an object WITH an existing description round-trips it byte-exactly (preserve-case)", async () => {
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") {
        sourceReads += 1;
        return resp(200, ENHOXH_XML_WITH_DESC, OK_XML);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXH_URI && r.method === "PUT") return resp(200, "", { etag: "PRESERVEETAG=" });
      return undefined;
    });

    const onBeforeImage = vi.fn(async () => {});
    const res = await setBadiImplementationActive(
      conn,
      gate(),
      { name: "ZMCP_ENH_BADI", active: false }, // implName omitted — one entry
      { affects: AFFECTS_SPOT, onBeforeImage },
    );

    expect(res.changed).toBe(true);
    expect(sourceReads).toBe(2);
    const put = adt.calls.find((c) => c.method === "PUT")!;
    // Byte-exact except isActive — the description this document already
    // had is neither dropped nor rewritten.
    expect(put.body).toBe(ENHOXH_XML_WITH_DESC.replace('enho:isActive="true"', 'enho:isActive="false"'));
    expect(put.body).toContain(`adtcore:description="${ENHOXH_DESCRIPTION}"`);
    expect(hasEnhancementRootDescription(put.body)).toBe(true);
  });

  it("spec.description on a descriptionless object: PUT proceeds and carries exactly that value", async () => {
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") {
        sourceReads += 1;
        return resp(200, ENHOXH_XML, OK_XML); // genuinely no description
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXH_URI && r.method === "PUT") return resp(200, "", { etag: "INJECTEDETAG=" });
      return undefined;
    });

    const onBeforeImage = vi.fn(async () => {});
    const res = await setBadiImplementationActive(
      conn,
      gate(),
      { name: "ZMCP_ENH_BADI", active: false, description: "injected via escape hatch" },
      { affects: AFFECTS_SPOT, onBeforeImage },
    );

    expect(res.changed).toBe(true);
    expect(sourceReads).toBe(2);
    const put = adt.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toContain('adtcore:description="injected via escape hatch"');
    // Exactly the escape-hatch's patch composed with the isActive patch —
    // nothing else moved.
    expect(put.body).toBe(
      patchEnhancementRootAttribute(
        patchBadiImplementationActive(ENHOXH_XML, "ZMCP_BADI_I1", false),
        "description",
        "injected via escape hatch",
      ),
    );
  });

  it("spec.description conflicting with an existing, DIFFERENT description: BAD_INPUT, no write, no lock", async () => {
    const onBeforeImage = vi.fn(async () => {});
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_XML_WITH_DESC, OK_XML);
      // No LOCK/PUT/UNLOCK routed — a conflicting escape-hatch value must
      // never silently overwrite an existing description.
      return undefined;
    });

    const e = await catchErr(
      setBadiImplementationActive(
        conn,
        gate(),
        { name: "ZMCP_ENH_BADI", active: false, description: "a completely different description" },
        { affects: AFFECTS_SPOT, onBeforeImage },
      ),
    );

    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toContain(ENHOXH_DESCRIPTION); // names the existing value
    expect(e.message).toContain("a completely different description"); // and the conflicting one
    expect(e.details).toMatchObject({
      existingDescription: ENHOXH_DESCRIPTION,
      suppliedDescription: "a completely different description",
    });
    expect(adt.calls).toHaveLength(1);
    expect(adt.verbs).toEqual(["GET"]);
    expect(onBeforeImage).not.toHaveBeenCalled();
  });

  it("spec.description equal to the existing description: accepted as a harmless confirmation, write proceeds, document unchanged except isActive (design decision — a differing value conflicts, an identical one does not)", async () => {
    const onBeforeImage = vi.fn(async () => {});
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_XML_WITH_DESC, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXH_URI && r.method === "PUT") return resp(200, "", { etag: "CONFIRMETAG=" });
      return undefined;
    });

    const res = await setBadiImplementationActive(
      conn,
      gate(),
      { name: "ZMCP_ENH_BADI", active: false, description: ENHOXH_DESCRIPTION }, // matches exactly
      { affects: AFFECTS_SPOT, onBeforeImage },
    );

    expect(res.changed).toBe(true);
    const put = adt.calls.find((c) => c.method === "PUT")!;
    // Byte-identical to the WITH_DESC preserve-case test above: supplying
    // the SAME value the object already has injects nothing new (the
    // `injectingDescription` flag only fires when the object had none).
    expect(put.body).toBe(ENHOXH_XML_WITH_DESC.replace('enho:isActive="true"', 'enho:isActive="false"'));
    expect(adt.verbs).toEqual(["GET", "LOCK", "GET", "PUT", "UNLOCK"]);
  });

  it("a filter tree survives the PUT byte-exactly (fixture 470, real filterTree content)", async () => {
    // test/fixtures/enhancement/470-enhoxh-with-filter.xml is also
    // description-less (same fixture family as 354) — WITH_DESC-ify it the
    // same way as the other synthetic constants, via the production patcher
    // itself, so the filter-preservation proof isn't entangled with the
    // description fix.
    const filterXml = fixture("470-enhoxh-with-filter.xml");
    const filterXmlWithDesc = patchEnhancementRootAttribute(filterXml, "description", ENHOXH_DESCRIPTION);
    expect(filterXmlWithDesc).toContain("<enho:filterTree>");

    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") {
        sourceReads += 1;
        return resp(200, filterXmlWithDesc, OK_XML);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXH_URI && r.method === "PUT") return resp(200, "", { etag: "FILTERETAG=" });
      return undefined;
    });

    const onBeforeImage = vi.fn(async () => {});
    const res = await setBadiImplementationActive(
      conn,
      gate(),
      { name: "ZMCP_ENH_BADI", active: false },
      { affects: AFFECTS_SPOT, onBeforeImage },
    );

    expect(res.changed).toBe(true);
    expect(sourceReads).toBe(2);
    const put = adt.calls.find((c) => c.method === "PUT")!;
    // Byte-exact except isActive — the filterTree (enho:or/enho:and/enho:filter
    // nesting, FLT/=/ALPHA) is untouched, proving the byte-preserving patch
    // never round-trips through a parse/rebuild that could drop or reorder it.
    expect(put.body).toBe(filterXmlWithDesc.replace('enho:isActive="true"', 'enho:isActive="false"'));
    expect(put.body).toContain(
      '<enho:filterTree><enho:or><enho:and><enho:or><enho:filter enho:filterName="FLT" ' +
        'enho:filterType="C" enho:comparator1="=" enho:value1="ALPHA"/></enho:or></enho:and></enho:or></enho:filterTree>',
    );
  });
});

// ===========================================================================
// REGRESSION — spec.description validation must not depend on whether
// spec.active happens to be a no-op.
//
// Before this fix, `setBadiImplementationActive`'s no-op short-circuit
// (`entry.isActive === target.active`) returned BEFORE the spec.description
// escape-hatch validation (step 3.5) ever ran. So a call whose `active` value
// happened to already match the object's current isActive would report
// success without ever checking whether the supplied `spec.description`
// conflicted with an existing, different description — the identical call
// with `active` flipped correctly refused BAD_INPUT. Confirmed RED against
// the unfixed code (see this block's own tests for the exact failure each one
// produced) before the fix reordered validation ahead of the short-circuit.
// ===========================================================================

describe("setBadiImplementationActive — REGRESSION: spec.description validation runs before the isActive no-op short-circuit", () => {
  it("active already matches current isActive AND spec.description conflicts with the existing description: BAD_INPUT, zero LOCK/PUT/UNLOCK (the headline defect)", async () => {
    // ENHOXH_XML_WITH_DESC already has isActive="true" and description
    // ENHOXH_DESCRIPTION. Requesting active:true (a no-op for isActive) with
    // a DIFFERENT description must still refuse — exactly like the
    // active:false case already proven above ("spec.description conflicting
    // with an existing, DIFFERENT description"), which is NOT a no-op for
    // isActive. Before the fix, this call short-circuited to success instead.
    const onBeforeImage = vi.fn(async () => {});
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_XML_WITH_DESC, OK_XML);
      // No LOCK/PUT/UNLOCK routed — a conflicting escape-hatch value must
      // never silently overwrite an existing description, no-op or not.
      return undefined;
    });

    const e = await catchErr(
      setBadiImplementationActive(
        conn,
        gate(),
        { name: "ZMCP_ENH_BADI", active: true, description: "a completely different description" }, // active:true IS a no-op by itself
        { affects: AFFECTS_SPOT, onBeforeImage },
      ),
    );

    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toContain(ENHOXH_DESCRIPTION);
    expect(e.message).toContain("a completely different description");
    expect(e.details).toMatchObject({
      existingDescription: ENHOXH_DESCRIPTION,
      suppliedDescription: "a completely different description",
    });
    expect(adt.calls).toHaveLength(1);
    expect(adt.verbs).toEqual(["GET"]);
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("PUT");
    expect(adt.verbs).not.toContain("UNLOCK");
    expect(onBeforeImage).not.toHaveBeenCalled();
  });

  it("active already matches current isActive AND spec.description is omitted: still a true no-op — one GET only, no LOCK/PUT/UNLOCK (the optimisation survives the reordering)", async () => {
    // The fix must not turn every isActive-matches call into a write: when
    // there is no spec.description at all, there is nothing to validate and
    // nothing new to inject, so this must remain exactly as cheap as before.
    const onBeforeImage = vi.fn(async () => {});
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_XML_WITH_DESC, OK_XML);
      // No LOCK/PUT/UNLOCK routed at all — asserting their absence, not just
      // the return value, is the load-bearing part of this test.
      return undefined;
    });

    const res = await setBadiImplementationActive(
      conn,
      gate(),
      { name: "ZMCP_ENH_BADI", active: true }, // matches ENHOXH_XML_WITH_DESC's isActive="true"; no description supplied
      { affects: AFFECTS_SPOT, onBeforeImage },
    );

    expect(res.changed).toBe(false);
    expect(adt.calls).toHaveLength(1);
    expect(adt.verbs).toEqual(["GET"]);
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("PUT");
    expect(adt.verbs).not.toContain("UNLOCK");
    expect(onBeforeImage).not.toHaveBeenCalled();
  });

  it("DECISION: a descriptionless object, spec.description supplied, and active already matching current isActive is NOT a no-op — the write still happens, injecting the description, because skipping it would leave the object permanently unwritable while reporting success", async () => {
    // ENHOXH_XML has NO root description and isActive="true" (see its own
    // doc comment above). Requesting active:true (already true — a no-op for
    // isActive alone) together with spec.description on this descriptionless
    // object must still go through LOCK -> reread -> PUT -> UNLOCK: the
    // escape hatch's entire purpose is making an otherwise-unwritable object
    // (SWB_TOOL19 — no root description, PUT always refused) writable again,
    // and the requested activation state being already satisfied does not
    // change that the document itself still needs the description written.
    // Before the fix, `entry.isActive === target.active` short-circuited
    // this to `changed:false` with no write at all — the exact SWB_TOOL19-
    // broken state the caller was trying to fix, reported as success.
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") {
        sourceReads += 1;
        return resp(200, ENHOXH_XML, OK_XML); // genuinely no description
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXH_URI && r.method === "PUT") return resp(200, "", { etag: "NOOPACTIVE-INJECT=" });
      return undefined;
    });

    const onBeforeImage = vi.fn(async () => {});
    const res = await setBadiImplementationActive(
      conn,
      gate(),
      { name: "ZMCP_ENH_BADI", active: true, description: "injected despite isActive no-op" }, // active:true matches current
      { affects: AFFECTS_SPOT, onBeforeImage },
    );

    expect(res.changed).toBe(true);
    expect(sourceReads).toBe(2);
    expect(adt.verbs).toEqual(["GET", "LOCK", "GET", "PUT", "UNLOCK"]);
    expect(onBeforeImage).toHaveBeenCalledTimes(1);

    const put = adt.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toContain('adtcore:description="injected despite isActive no-op"');
    // isActive itself is untouched (still "true"): only the description was
    // ever actually different between the request and the current document.
    expect(put.body).toBe(
      patchEnhancementRootAttribute(
        patchBadiImplementationActive(ENHOXH_XML, "ZMCP_BADI_I1", true),
        "description",
        "injected despite isActive no-op",
      ),
    );
  });
});

describe("writeEnhancementDescription — empty-string description now refused pre-lock (ENHANCEMENT_DESCRIPTION_REQUIRED)", () => {
  it("description:'' against an object that currently has a DIFFERENT description (a real change, not a no-op) refuses before any lock — SAP accepts neither an absent nor an empty root description", async () => {
    // Previously documented (but never live-tested) as "an empty string
    // clears the description" — closed as a latent SWB_TOOL19-affected path:
    // there is no live evidence SAP's validation treats an explicit empty
    // value any differently from an absent attribute (both observed as the
    // identical wire error), so this operation now refuses rather than
    // attempting a write that would fail live.
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      // No LOCK/PUT/UNLOCK routed — must refuse pre-lock.
      return undefined;
    });

    const e = await catchErr(
      writeEnhancementDescription(
        conn,
        gate(),
        { type: "ENHO/XHH", name: "ZMCP_ENH_B", description: "" },
        { affects: AFFECTS_HOOK },
      ),
    );

    expect(e.code).toBe("ENHANCEMENT_DESCRIPTION_REQUIRED");
    expect(adt.calls).toHaveLength(1); // the one resolve GET only
    expect(adt.verbs).toEqual(["GET"]);
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("PUT");
  });

  it("description:'' when the object ALREADY has no description (or already reads '') is a no-op — the no-op short-circuit (step 3) runs BEFORE the description guard (step 3.5), so this is unaffected by the new refusal", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_XML, OK_XML); // no description
      return undefined;
    });

    const res = await writeEnhancementDescription(
      conn,
      gate(),
      { type: "ENHO/XH", name: "ZMCP_ENH_BADI", description: "" }, // "" === current.data.description ?? ""
      { affects: AFFECTS_SPOT },
    );

    expect(res.changed).toBe(false);
    expect(adt.calls).toHaveLength(1);
    expect(adt.verbs).toEqual(["GET"]);
  });
});

// ===========================================================================
// adjustmentStatus hint (UNCONFIRMED HYPOTHESIS) — see
// `hintAdjustmentStatusIfLikelyCause`'s own doc comment in
// src/adt/enhancement-write.ts for the live failure this is built from. This is deliberately NOT a
// pre-write refusal: it only ever enriches a write that has ALREADY failed
// as a generic ADT_ERROR, and only when the object's own adjustmentStatus
// (read before the write, from BadiImplementationRead) was already known to
// be something other than "adjusted". ENHOXH_SYNTHETIC_WITH_DESC is derived
// from fixture 354, whose own enho:adjustmentStatus is "" (empty) — see
// ENHOXH_XML's own doc comment above. Fixture 470
// (test/fixtures/enhancement/470-enhoxh-with-filter.xml, same
// ZMCP_ENH_BADI/ZMCP_BADI_I1 container/entry pair) has
// enho:adjustmentStatus="adjusted" — the ONE case this hint must never fire.
// ===========================================================================
describe("setBadiImplementationActive — adjustmentStatus hint (UNCONFIRMED HYPOTHESIS)", () => {
  it('hint fires: generic ADT_ERROR PUT failure + adjustmentStatus="" appends an UNCONFIRMED-HYPOTHESIS hint, never replacing the real message', async () => {
    const { conn } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_SYNTHETIC_WITH_DESC, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXH_URI && r.method === "PUT") return resp(500, "<exc:exception/>", OK_XML);
      return undefined;
    });

    const e = await catchErr(
      setBadiImplementationActive(
        conn,
        gate(),
        { name: "ZMCP_ENH_BADI", active: false },
        { affects: AFFECTS_SPOT },
      ),
    );

    expect(e.code).toBe("ADT_ERROR");
    // The real error is untouched — only `hint` gained the new text.
    expect(e.message).not.toContain("UNCONFIRMED HYPOTHESIS");
    expect(e.hint).toContain("UNCONFIRMED HYPOTHESIS");
    expect(e.hint).toContain("ZMCP_ENH_BADI");
    expect(e.hint).toContain("adjustmentStatus is empty");
    expect(e.hint).toContain("not confirmed");
    expect(e.hint).toContain("SPAU/SPDD");
    // Never a claim this tool will fix it by writing adjustmentStatus itself.
    expect(e.hint).toContain("will not set adjustmentStatus itself");
  });

  it('hint does NOT fire when adjustmentStatus is already "adjusted" (required negative case)', async () => {
    const ADJUSTED_XML = fixture("470-enhoxh-with-filter.xml").replace(
      'enho:name="ZMCP_BADI_I1"',
      'enho:name="ZMCP_ENH_BADI"',
    );
    const ADJUSTED_WITH_DESC = patchEnhancementRootAttribute(ADJUSTED_XML, "description", ENHOXH_DESCRIPTION);

    const { conn } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ADJUSTED_WITH_DESC, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXH_URI && r.method === "PUT") return resp(500, "<exc:exception/>", OK_XML);
      return undefined;
    });

    const e = await catchErr(
      setBadiImplementationActive(
        conn,
        gate(),
        { name: "ZMCP_ENH_BADI", active: false },
        { affects: AFFECTS_SPOT },
      ),
    );

    expect(e.code).toBe("ADT_ERROR");
    // This used to assert `e.hint` was undefined, using "no hint at all" as a
    // proxy for "the adjustmentStatus hint did not misfire". A generic
    // fallback hint was later added to every unclassified ADT_ERROR, so the proxy no
    // longer holds — but the thing it was actually guarding does. Assert the
    // targeted hint specifically, so this still fails if the
    // adjustmentStatus/UNCONFIRMED-HYPOTHESIS branch fires on an object whose
    // status is already "adjusted".
    expect(e.hint).not.toMatch(/UNCONFIRMED HYPOTHESIS/);
    expect(e.hint).not.toMatch(/ZMCP_ENH_BADI/);
  });

  it("hint does NOT fire on an unrelated error code (ETAG_CONFLICT), even with adjustmentStatus empty", async () => {
    // Same ENHOXH_SYNTHETIC_WITH_DESC (adjustmentStatus="") as the positive
    // case above, but the REREAD (inside the lock) returns byte-different
    // content from the pre-lock read, so this fails post-lock as
    // ETAG_CONFLICT — a code `hintAdjustmentStatusIfLikelyCause` must never
    // touch, proving the guard checks `e.code === "ADT_ERROR"` and not just
    // "any failure while adjustmentStatus is not adjusted".
    let getCount = 0;
    const CHANGED_XML = ENHOXH_SYNTHETIC_WITH_DESC.replace(ENHOXH_DESCRIPTION, `${ENHOXH_DESCRIPTION} CHANGED`);
    const { conn } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") {
        getCount += 1;
        return resp(200, getCount === 1 ? ENHOXH_SYNTHETIC_WITH_DESC : CHANGED_XML, OK_XML);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      return undefined;
    });

    const e = await catchErr(
      setBadiImplementationActive(
        conn,
        gate(),
        { name: "ZMCP_ENH_BADI", active: false },
        { affects: AFFECTS_SPOT },
      ),
    );

    expect(e.code).toBe("ETAG_CONFLICT");
    expect(e.hint).not.toContain("UNCONFIRMED HYPOTHESIS");
  });
});

describe("putEnhancementDocument — single conn.put call site (structural guard)", () => {
  it("enhancement-write.ts calls conn.put from exactly ONE place", () => {
    // The honest limit of this guard, stated plainly (see
    // putEnhancementDocument's own doc comment in src/adt/enhancement-write.ts
    // for the fuller version): this proves there is currently exactly one
    // `conn.put(` call site in this module, so a reviewer/CI catches a
    // SECOND one being added — accidentally bypassing the description guard
    // — as a FAILING TEST, not silently. It does NOT prove that call site is
    // reached only via putEnhancementDocument (that's enforced by TypeScript
    // — putEnhancementDocument is the only function in this module holding a
    // reference to `conn.put` at all, since it's not re-exported), and it
    // does NOT cover some hypothetical THIRD module elsewhere in the tree
    // that imports `AbapConnection` directly and calls `.put()` on it,
    // bypassing this module entirely — that is a real, acknowledged gap
    // (see this test's own file-header task report), not something a
    // grep-count in ONE file can close.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "adt", "enhancement-write.ts"),
      "utf8",
    );
    const matches = src.match(/\bconn\.put\(/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("that one call site is inside putEnhancementDocument, not inlined into either write function", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "adt", "enhancement-write.ts"),
      "utf8",
    );
    const fnStart = src.indexOf("async function putEnhancementDocument(");
    const fnEnd = src.indexOf("\n}\n", fnStart);
    expect(fnStart).toBeGreaterThan(0);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const putIndex = src.indexOf("conn.put(");
    expect(putIndex).toBeGreaterThan(fnStart);
    expect(putIndex).toBeLessThan(fnEnd);
  });
});
