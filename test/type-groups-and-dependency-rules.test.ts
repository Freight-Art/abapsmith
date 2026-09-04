/**
 * Pinning test for two ADT object types added 2026-09-04 from live A4H
 * recon: TYPE/DG "Type group" and DRUL/DRL "Dependency rule". Both carry a
 * hand-built `create` skeleton (`vendor: false`) — neither has a
 * `CreatableTypes` row in abap-adt-api. The full create → write → activate
 * → read-back → delete cycle ran live through abapsmith's own tool surface
 * on A4H 2026-09-04 ($TMP: ZTMDY for TYPE/DG, ZTMD_DRUL_02 for DRUL/DRL) and
 * worked end to end, so `create.verified` and `delete` are both `true` and
 * both types are VERIFIED_CREATABLE_TYPES/CREATABLE_TYPES/DELETABLE_TYPES
 * members — `writeObject`'s create gate lets them through pre-flight.
 *
 * One behavior below is pinned as discovered, not as the background spec
 * assumed: `specForKeyword("type")` alone resolves to TYPE/DG, via
 * `specForType`'s kind-code fallback (TYPE/DG's `kind` is "TYPE"). That is
 * genuine pre-existing behavior, unrelated to these two new types' keywords.
 *
 * `parseObjectRef`'s explicit-type-code branch used to match the bare word
 * "type" (4 letters) before the keyword-prefix loop ever tried "type group "/
 * "type pool ", throwing on those two inputs. Fixed in `resolve.ts`: a
 * registered keyword strictly longer than the matched code now wins.
 */
import { describe, expect, it } from "vitest";
import { specForKeyword, specForType, specFromUri, buildUri, KEYWORDS_BY_LENGTH } from "../src/adt/types.js";
import { parseObjectRef } from "../src/adt/resolve.js";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { readSource } from "../src/adt/source.js";
import { authorizeMutation, resolveWriteTarget, writeObject } from "../src/adt/write.js";
import { isAbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import {
  capabilitiesFor,
  WRITABLE_TYPES,
  CREATABLE_TYPES,
  VERIFIED_CREATABLE_TYPES,
  DELETABLE_TYPES,
  ENHANCEABLE_TYPES,
  ABAP_WRITE_TYPES,
  NON_READABLE_TYPES,
  NON_WRITABLE_TYPES,
} from "../src/adt/capabilities.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

interface Recorded {
  method: string;
  url: string;
  qs?: Record<string, string>;
  body?: string;
  headers?: Record<string, unknown>;
}

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };
const OK_TEXT = { "content-type": "text/plain" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">does not exist</message><properties/></exc:exception>`;
const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR></CORRNR><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: (r: Recorded) => HttpClientResponse | undefined) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const rec: Recorded = {
      method: (o.method ?? "GET").toUpperCase(),
      url: o.url,
      qs: o.qs as Record<string, string> | undefined,
      body: o.body,
      headers: o.headers as Record<string, unknown> | undefined,
    };
    this.calls.push(rec);
    const res = this.route(rec);
    if (!res) throw new Error(`FakeAdt: unrouted request ${rec.method} ${rec.url}`);
    return res;
  }
}

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

async function connected(route: (r: Recorded) => HttpClientResponse | undefined) {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const config: Config = ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });
  const conn = new AbapConnection(config, {
    httpClient: adt,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const catchErr = async (p: Promise<unknown>) => p.then(() => undefined, (err) => err);

const ABSENT_ROUTE = (r: Recorded) =>
  r.method === "GET" ? resp(404, NOT_FOUND_XML, OK_XML) : undefined;

const DEFAULT_GATE = new SafetyGate({ readOnly: false, allowPackages: ["*"] });

const TYPE_DG = () => specForType("TYPE/DG")!;
const DRUL_DRL = () => specForType("DRUL/DRL")!;
const typeGroupUri = () => buildUri(TYPE_DG(), "TREXC");
const drulUri = () => buildUri(DRUL_DRL(), "DEMO_DRUL_1");

describe("TYPE/DG and DRUL/DRL: registered at all", () => {
  it("both type codes are registered in the type registry — canary for the lazy accessors below", () => {
    expect(specForType("TYPE/DG")?.type).toBe("TYPE/DG");
    expect(specForType("DRUL/DRL")?.type).toBe("DRUL/DRL");
  });
});

describe("TYPE/DG and DRUL/DRL URI construction", () => {
  it("TYPE/DG: buildUri(TREXC) is the lowercased ddic/typegroups path", () => {
    expect(typeGroupUri()).toBe("/sap/bc/adt/ddic/typegroups/trexc");
  });

  it("DRUL/DRL: buildUri(DEMO_DRUL_1) is the lowercased ddic/drul/sources path", () => {
    expect(drulUri()).toBe("/sap/bc/adt/ddic/drul/sources/demo_drul_1");
  });
});

describe("TYPE/DG and DRUL/DRL specFromUri round-trip", () => {
  it("TYPE/DG: plain object URI resolves back to TYPE/DG TREXC", () => {
    expect(specFromUri(typeGroupUri())).toEqual({ spec: TYPE_DG(), name: "TREXC" });
  });

  it("TYPE/DG: /source/main URI resolves back to TYPE/DG TREXC", () => {
    expect(specFromUri(`${typeGroupUri()}/source/main`)).toEqual({ spec: TYPE_DG(), name: "TREXC" });
  });

  it("DRUL/DRL: plain object URI resolves back to DRUL/DRL DEMO_DRUL_1", () => {
    expect(specFromUri(drulUri())).toEqual({ spec: DRUL_DRL(), name: "DEMO_DRUL_1" });
  });

  it("DRUL/DRL: /source/main URI resolves back to DRUL/DRL DEMO_DRUL_1", () => {
    expect(specFromUri(`${drulUri()}/source/main`)).toEqual({ spec: DRUL_DRL(), name: "DEMO_DRUL_1" });
  });
});

describe("TYPE/DG and DRUL/DRL type-code resolution", () => {
  it("specForType(\"TYPE/DG\") === specForType(\"TYPE\") — kind-code fallback", () => {
    expect(specForType("TYPE")).toBe(TYPE_DG());
    expect(specForType("TYPE/DG")).toBe(TYPE_DG());
  });

  it("specForType(\"DRUL/DRL\") === specForType(\"DRUL\") — kind-code fallback", () => {
    expect(specForType("DRUL")).toBe(DRUL_DRL());
    expect(specForType("DRUL/DRL")).toBe(DRUL_DRL());
  });
});

describe("TYPE/DG and DRUL/DRL keyword resolution", () => {
  it("every declared TYPE/DG keyword resolves to TYPE/DG", () => {
    for (const kw of ["type group", "type pool", "typegroup", "type-pool"]) {
      expect(specForKeyword(kw), kw).toBe(TYPE_DG());
    }
  });

  it("every declared DRUL/DRL keyword resolves to DRUL/DRL", () => {
    for (const kw of ["dependency rule", "drul"]) {
      expect(specForKeyword(kw), kw).toBe(DRUL_DRL());
    }
  });

  it("does not steal a neighboring keyword: \"table type\" still resolves TTYP/DA", () => {
    expect(specForKeyword("table type")?.type).toBe("TTYP/DA");
  });

  it("the bare word \"type\" (no keyword match) falls through to TYPE/DG via kind-code fallback", () => {
    // specForKeyword tries an exact keyword match first, then falls back to
    // specForType(word.toUpperCase()) — "TYPE" hits TYPE/DG's kind code.
    expect(specForKeyword("type")).toBe(TYPE_DG());
  });
});

describe("TYPE/DG and DRUL/DRL fuzzy resolution via parseObjectRef", () => {
  it("\"typegroup trexc\" resolves to TYPE/DG TREXC", () => {
    const p = parseObjectRef("typegroup trexc");
    expect(p.spec?.type).toBe("TYPE/DG");
    expect(p.name).toBe("TREXC");
  });

  it("\"type-pool trexc\" resolves to TYPE/DG TREXC", () => {
    const p = parseObjectRef("type-pool trexc");
    expect(p.spec?.type).toBe("TYPE/DG");
    expect(p.name).toBe("TREXC");
  });

  it("\"TYPE/DG trexc\" (explicit type code) resolves to TYPE/DG TREXC", () => {
    const p = parseObjectRef("TYPE/DG trexc");
    expect(p.spec?.type).toBe("TYPE/DG");
    expect(p.name).toBe("TREXC");
  });

  it("\"dependency rule demo_drul_1\" resolves to DRUL/DRL DEMO_DRUL_1", () => {
    const p = parseObjectRef("dependency rule demo_drul_1");
    expect(p.spec?.type).toBe("DRUL/DRL");
    expect(p.name).toBe("DEMO_DRUL_1");
  });

  it("\"drul demo_drul_1\" resolves to DRUL/DRL DEMO_DRUL_1", () => {
    const p = parseObjectRef("drul demo_drul_1");
    expect(p.spec?.type).toBe("DRUL/DRL");
    expect(p.name).toBe("DEMO_DRUL_1");
  });

  it("\"type group trexc\" resolves to TYPE/DG TREXC — multi-word keyword wins over the bare 4-letter code", () => {
    const p = parseObjectRef("type group trexc");
    expect(p.spec?.type).toBe("TYPE/DG");
    expect(p.name).toBe("TREXC");
  });

  it("\"type pool trexc\" resolves to TYPE/DG TREXC", () => {
    const p = parseObjectRef("type pool trexc");
    expect(p.spec?.type).toBe("TYPE/DG");
    expect(p.name).toBe("TREXC");
  });

  it("regression guard: an equal-length code/keyword pair (\"prog\") is untouched by the longer-keyword rule", () => {
    // "prog" is both PROG/P's kind code and one of its own keywords — same
    // length, so the fix must not touch this path.
    const p = parseObjectRef("prog zfoo");
    expect(p.spec?.type).toBe("PROG/P");
    expect(p.name).toBe("ZFOO");
    expect(p.via).toBe("typecode");
  });
});

describe("TYPE/DG and DRUL/DRL: read path (FakeAdt)", () => {
  it("readSource(TYPE/DG) GETs exactly the /source/main URL with Accept: text/plain", async () => {
    const { conn, adt } = await connected((r) =>
      r.url === `${typeGroupUri()}/source/main` && r.method === "GET"
        ? resp(200, "TYPE-POOL trexc. CONSTANTS: c1 TYPE i VALUE 1.", OK_XML)
        : undefined,
    );
    const src = await readSource(conn, {
      system: "A4H",
      type: "TYPE/DG",
      kind: "TYPE",
      label: "Type group",
      name: "TREXC",
      uri: typeGroupUri(),
      sourceUri: `${typeGroupUri()}/source/main`,
      mode: "source",
      activation: "unknown",
      spec: TYPE_DG(),
    });
    expect(src.source).toBe("TYPE-POOL trexc. CONSTANTS: c1 TYPE i VALUE 1.");
    expect(adt.calls).toHaveLength(1);
    expect(adt.calls[0].method).toBe("GET");
    expect(adt.calls[0].url).toBe(`${typeGroupUri()}/source/main`);
    expect(adt.calls[0].headers?.Accept).toBe("text/plain");
  });

  it("readSource(DRUL/DRL) GETs exactly the /source/main URL with Accept: text/plain", async () => {
    const { conn, adt } = await connected((r) =>
      r.url === `${drulUri()}/source/main` && r.method === "GET"
        ? resp(200, "DEFINE FILTER DEPENDENCY RULE demo_drul_1 ON demo_parts_1", OK_XML)
        : undefined,
    );
    const src = await readSource(conn, {
      system: "A4H",
      type: "DRUL/DRL",
      kind: "DRUL",
      label: "Dependency rule",
      name: "DEMO_DRUL_1",
      uri: drulUri(),
      sourceUri: `${drulUri()}/source/main`,
      mode: "source",
      activation: "unknown",
      spec: DRUL_DRL(),
    });
    expect(src.source).toBe("DEFINE FILTER DEPENDENCY RULE demo_drul_1 ON demo_parts_1");
    expect(adt.calls).toHaveLength(1);
    expect(adt.calls[0].method).toBe("GET");
    expect(adt.calls[0].url).toBe(`${drulUri()}/source/main`);
    expect(adt.calls[0].headers?.Accept).toBe("text/plain");
  });
});

describe("TYPE/DG and DRUL/DRL registry: write, create, activate, media type", () => {
  it("TYPE/DG capabilities: source write, activatable, deletable, verified create", () => {
    const cap = capabilitiesFor("TYPE/DG");
    expect(cap?.label).toBe("Type group");
    expect(cap?.write?.shape).toBe("source");
    expect(cap?.activate).toBe(true);
    expect(cap?.delete).toBe(true);
    expect(cap?.mediaType).toBe("application/vnd.sap.adt.ddic.typegroups.v2+xml");
    expect(cap?.create?.vendor).toBe(false);
    expect(cap?.create?.verified).toBe(true);
  });

  it("DRUL/DRL capabilities: source write, activatable, deletable, verified create", () => {
    const cap = capabilitiesFor("DRUL/DRL");
    expect(cap?.label).toBe("Dependency rule");
    expect(cap?.write?.shape).toBe("source");
    expect(cap?.activate).toBe(true);
    expect(cap?.delete).toBe(true);
    expect(cap?.mediaType).toBe("application/vnd.sap.adt.ddic.drul.v1+xml");
    expect(cap?.create?.vendor).toBe(false);
    expect(cap?.create?.verified).toBe(true);
  });

  /**
   * `create.skeleton` pinned exactly, mirroring the BDEF/BDO precedent
   * (test/write.test.ts, "is registered as source-shape, no-vendor, with
   * the blueSource skeleton"). Both shapes were captured from the raw ADT
   * POSTs used before abapsmith's own choreography ran a full cycle
   * (2026-09-04); the full cycle then confirmed them live through
   * `abap_write` itself — see the describe block below and each type's
   * REGISTRY comment in capabilities.ts.
   */
  it("TYPE/DG and DRUL/DRL create skeletons are pinned exactly", () => {
    expect(capabilitiesFor("TYPE/DG")?.create).toEqual({
      vendor: false,
      skeleton: {
        rootName: "atypgr:abapTypeGroup",
        namespace: 'xmlns:atypgr="http://www.sap.com/adt/ddic/typegroups"',
        contentType: "application/vnd.sap.adt.ddic.typegroups.v2+xml",
      },
      verified: true,
    });
    expect(capabilitiesFor("DRUL/DRL")?.create).toEqual({
      vendor: false,
      skeleton: {
        rootName: "blue:blueSource",
        namespace: 'xmlns:blue="http://www.sap.com/wbobj/blue"',
        contentType: "application/vnd.sap.adt.ddic.drul.v1+xml",
      },
      verified: true,
    });
  });

  /**
   * `createByXml` (src/adt/write.ts) derives the POST collection URI from
   * `spec.path.replace(/\/\{name\}$/, "")` — the object-path template minus
   * its trailing `/{name}` segment. Pinning the result against the exact
   * collection URLs the raw captures above actually POSTed to means that
   * derivation can't silently drift onto some other collection.
   */
  it("createByXml's collection derivation matches the captured POST URLs", () => {
    expect(specForType("TYPE/DG")!.path.replace(/\/\{name\}$/, "")).toBe(
      "/sap/bc/adt/ddic/typegroups",
    );
    expect(specForType("DRUL/DRL")!.path.replace(/\/\{name\}$/, "")).toBe(
      "/sap/bc/adt/ddic/drul/sources",
    );
  });
});

describe("TYPE/DG and DRUL/DRL: create is verified — writeObject lets it through pre-flight", () => {
  it("both types are in CREATABLE_TYPES AND VERIFIED_CREATABLE_TYPES", () => {
    expect(CREATABLE_TYPES).toContain("TYPE/DG");
    expect(CREATABLE_TYPES).toContain("DRUL/DRL");
    expect(VERIFIED_CREATABLE_TYPES).toContain("TYPE/DG");
    expect(VERIFIED_CREATABLE_TYPES).toContain("DRUL/DRL");
  });

  /**
   * Full create flow via a fake ADT, mirroring XSLT/VT's own skeleton-create
   * test (test/write.test.ts, "XSLT/VT — skeleton create carries
   * rootAttributes"): skeleton POST to the typegroups collection, then a
   * LOCK/PUT/UNLOCK cycle puts the caller's source on `/source/main`. This
   * is the same choreography that ran live against A4H on ZTMDY
   * 2026-09-04 (created: true, check clean, activated: true).
   */
  it("creates a missing TYPE/DG object with the atypgr:abapTypeGroup skeleton", async () => {
    const TG_URI = "/sap/bc/adt/ddic/typegroups/ztmdy";
    const TG_SRC = `${TG_URI}/source/main`;
    const TG_COLLECTION = "/sap/bc/adt/ddic/typegroups";
    const SOURCE = "TYPE-POOL ztmdy.";

    const { conn, adt } = await connected((r) => {
      if (r.url === TG_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === TG_COLLECTION && r.method === "POST") return resp(200, "", {});
      if (r.qs?._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs?._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === TG_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    });

    const target = await authorizeMutation(conn, DEFAULT_GATE, "write", { type: "TYPE/DG", name: "ZTMDY" });
    const res = await writeObject(conn, target, { source: SOURCE });
    expect(res.created).toBe(true);

    const create = adt.calls.find((c) => c.url === TG_COLLECTION && c.method === "POST")!;
    expect(create.body).toBe(
      '<atypgr:abapTypeGroup xmlns:atypgr="http://www.sap.com/adt/ddic/typegroups" ' +
        'xmlns:adtcore="http://www.sap.com/adt/core" ' +
        'adtcore:description="Type group ZTMDY" ' +
        'adtcore:name="ZTMDY" adtcore:type="TYPE/DG" ' +
        'adtcore:language="EN" adtcore:masterLanguage="EN" ' +
        'adtcore:responsible="DEVELOPER">' +
        '<adtcore:packageRef adtcore:name="$TMP"/>' +
        "</atypgr:abapTypeGroup>",
    );
    expect(create.headers?.["Content-Type"]).toBe("application/vnd.sap.adt.ddic.typegroups.v2+xml");

    const put = adt.calls.find((c) => c.url === TG_SRC && c.method === "PUT")!;
    expect(put.body).toBe(SOURCE);
  });

  /** Same shape as the TYPE/DG test above, mirroring ZTMD_DRUL_02's live cycle 2026-09-04. */
  it("creates a missing DRUL/DRL object with the blue:blueSource skeleton", async () => {
    const DRUL_URI = "/sap/bc/adt/ddic/drul/sources/ztmd_drul_02";
    const DRUL_SRC = `${DRUL_URI}/source/main`;
    const DRUL_COLLECTION = "/sap/bc/adt/ddic/drul/sources";
    const SOURCE = "DEFINE FILTER DEPENDENCY RULE ztmd_drul_02 ON demo_parts_1";

    const { conn, adt } = await connected((r) => {
      if (r.url === DRUL_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === DRUL_COLLECTION && r.method === "POST") return resp(201, "", {});
      if (r.qs?._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs?._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === DRUL_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    });

    const target = await authorizeMutation(conn, DEFAULT_GATE, "write", { type: "DRUL/DRL", name: "ZTMD_DRUL_02" });
    const res = await writeObject(conn, target, { source: SOURCE });
    expect(res.created).toBe(true);

    const create = adt.calls.find((c) => c.url === DRUL_COLLECTION && c.method === "POST")!;
    expect(create.body).toBe(
      '<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue" ' +
        'xmlns:adtcore="http://www.sap.com/adt/core" ' +
        'adtcore:description="Dependency rule ZTMD_DRUL_02" ' +
        'adtcore:name="ZTMD_DRUL_02" adtcore:type="DRUL/DRL" ' +
        'adtcore:language="EN" adtcore:masterLanguage="EN" ' +
        'adtcore:responsible="DEVELOPER">' +
        '<adtcore:packageRef adtcore:name="$TMP"/>' +
        "</blue:blueSource>",
    );
    expect(create.headers?.["Content-Type"]).toBe("application/vnd.sap.adt.ddic.drul.v1+xml");

    const put = adt.calls.find((c) => c.url === DRUL_SRC && c.method === "PUT")!;
    expect(put.body).toBe(SOURCE);
  });
});

/**
 * `resolveWriteTarget`'s TYPE/DG-only pre-flight name guards (src/adt/
 * write.ts, immediately before `maxNameLength`'s length check) — added
 * after live A4H recon 2026-09-04: a type-group create with an underscore
 * in the name 403s "Do not use underscores in type group names", and
 * TYPE-POOL names cap at 5 characters. Both checks sit before
 * `resolveWriteTarget`'s one existence GET, so a name that fails either
 * costs zero wire requests — verified below via the FakeAdt call log,
 * the same harness the "exactly one non-mutating GET" tests above use.
 */
describe("TYPE/DG name guards: underscore and length, both zero-cost", () => {
  it("ZTM_X (legal length, illegal underscore) is refused BAD_INPUT before any request", async () => {
    const { conn, adt } = await connected(ABSENT_ROUTE);
    const e = await catchErr(
      authorizeMutation(conn, DEFAULT_GATE, "write", { type: "TYPE/DG", name: "ZTM_X" }),
    );
    expect(isAbapError(e)).toBe(true);
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/underscore/i);
    expect(adt.calls).toHaveLength(0);
  });

  it("ZTMDXY (legal characters, 6 > the 5-character limit) is refused BAD_INPUT before any request", async () => {
    const { conn, adt } = await connected(ABSENT_ROUTE);
    const e = await catchErr(
      authorizeMutation(conn, DEFAULT_GATE, "write", { type: "TYPE/DG", name: "ZTMDXY" }),
    );
    expect(isAbapError(e)).toBe(true);
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/\b5\b/);
    expect(adt.calls).toHaveLength(0);
  });

  it("ZTMD_TG_01 (the naive pick — breaks BOTH rules) gets the underscore message, not the length one", async () => {
    // ZTMD_TG_01 is 10 characters (over the 5-character cap) AND contains
    // underscores. resolveWriteTarget checks the underscore rule first
    // (write.ts comment: "so the more actionable rule wins when a name
    // breaks both") — the caller needs to know WHICH rule to fix first,
    // and "drop the underscores" is the fix that also shortens the name
    // enough to matter, so it is the one surfaced.
    const { conn, adt } = await connected(ABSENT_ROUTE);
    const e = await catchErr(
      authorizeMutation(conn, DEFAULT_GATE, "write", { type: "TYPE/DG", name: "ZTMD_TG_01" }),
    );
    expect(isAbapError(e)).toBe(true);
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/underscore/i);
    expect(String(e.message)).not.toMatch(/\b5\b/);
    expect(adt.calls).toHaveLength(0);
  });

  it("a DRUL/DRL write is not subject to the TYPE/DG underscore guard — it reaches the existence GET", async () => {
    // ZTMD_DRUL_02 would trip the TYPE/DG underscore check if that guard
    // were type-blind; it is DRUL/DRL here, so it must sail past it and
    // reach the same one-GET resolution every other writable type gets.
    const { conn, adt } = await connected(ABSENT_ROUTE);
    const t = await resolveWriteTarget(conn, { type: "DRUL/DRL", name: "ZTMD_DRUL_02" }, "write");
    expect(t.type).toBe("DRUL/DRL");
    expect(t.exists).toBe(false);
    expect(adt.calls).toHaveLength(1);
    expect(adt.calls[0].method).toBe("GET");
  });
});

describe("TYPE/DG and DRUL/DRL: op \"delete\" is not refused pre-flight", () => {
  it("both types are DELETABLE_TYPES members", () => {
    expect(DELETABLE_TYPES).toContain("TYPE/DG");
    expect(DELETABLE_TYPES).toContain("DRUL/DRL");
  });

  it("TYPE/DG delete resolves instead of throwing UNSUPPORTED at the pre-flight gate", async () => {
    // ABSENT_ROUTE 404s the existence GET; with an explicit `type` (so
    // specSource === "caller") resolveWriteTarget resolves with exists:false
    // rather than throwing. Resolving at all (not rejecting UNSUPPORTED)
    // proves the op:"delete" gate let TYPE/DG through.
    const { conn } = await connected(ABSENT_ROUTE);
    const resolved = await resolveWriteTarget(conn, { type: "TYPE/DG", name: "TREXC" }, "delete");
    expect(resolved.type).toBe("TYPE/DG");
    expect(resolved.exists).toBe(false);
  });

  it("DRUL/DRL delete resolves instead of throwing UNSUPPORTED at the pre-flight gate", async () => {
    const { conn } = await connected(ABSENT_ROUTE);
    const resolved = await resolveWriteTarget(conn, { type: "DRUL/DRL", name: "DEMO_DRUL_1" }, "delete");
    expect(resolved.type).toBe("DRUL/DRL");
    expect(resolved.exists).toBe(false);
  });
});

describe("TYPE/DG and DRUL/DRL: op \"write\" is allowed", () => {
  it("resolveWriteTarget(write) on an existing TYPE/DG object resolves with its real package", async () => {
    const { conn, adt } = await connected((r) =>
      r.url === typeGroupUri() && r.method === "GET"
        ? resp(
            200,
            `<atypgr:abapTypeGroup xmlns:atypgr="x" xmlns:adtcore="y" adtcore:type="TYPE/DG" adtcore:name="TREXC"><adtcore:packageRef adtcore:name="$TMP"/></atypgr:abapTypeGroup>`,
            OK_XML,
          )
        : undefined,
    );
    const t = await resolveWriteTarget(conn, { type: "TYPE/DG", name: "TREXC" }, "write");
    expect(t.exists).toBe(true);
    expect(t.packageName).toBe("$TMP");
    expect(t.type).toBe("TYPE/DG");
    expect(adt.calls).toHaveLength(1);
    expect(adt.calls[0].method).toBe("GET");
    expect(adt.calls[0].url).toBe(typeGroupUri());
    expect(adt.calls[0].headers?.Accept).toBe("application/vnd.sap.adt.ddic.typegroups.v2+xml");
  });

  it("resolveWriteTarget(write) on an existing DRUL/DRL object resolves with its real package", async () => {
    const { conn, adt } = await connected((r) =>
      r.url === drulUri() && r.method === "GET"
        ? resp(
            200,
            `<adrul:abapDependencyRule xmlns:adrul="x" xmlns:adtcore="y" adtcore:type="DRUL/DRL" adtcore:name="DEMO_DRUL_1"><adtcore:packageRef adtcore:name="$TMP"/></adrul:abapDependencyRule>`,
            OK_XML,
          )
        : undefined,
    );
    const t = await resolveWriteTarget(conn, { type: "DRUL/DRL", name: "DEMO_DRUL_1" }, "write");
    expect(t.exists).toBe(true);
    expect(t.packageName).toBe("$TMP");
    expect(t.type).toBe("DRUL/DRL");
    expect(adt.calls).toHaveLength(1);
    expect(adt.calls[0].method).toBe("GET");
    expect(adt.calls[0].url).toBe(drulUri());
    expect(adt.calls[0].headers?.Accept).toBe("application/vnd.sap.adt.ddic.drul.v1+xml");
  });
});

describe("TYPE/DG and DRUL/DRL derived-set membership", () => {
  it("neither is ENHANCEABLE_TYPES any more — both are ABAP_WRITE_TYPES", () => {
    // ENHANCEABLE_TYPES = codesWith(write defined AND create undefined).
    // Gaining a `create` skeleton moved both types out of it (membership
    // never looks at `verified`) — ENHANCEABLE_TYPES is now `["ENHO/XHH"]`
    // alone.
    // ABAP_WRITE_TYPES (the union of CREATABLE_TYPES, BRIDGE_ONLY_CREATE_TYPES
    // and ENHANCEABLE_TYPES) still contains both, now via CREATABLE_TYPES
    // membership rather than ENHANCEABLE_TYPES.
    expect(ENHANCEABLE_TYPES).not.toContain("TYPE/DG");
    expect(ENHANCEABLE_TYPES).not.toContain("DRUL/DRL");
    expect(ENHANCEABLE_TYPES).toEqual(["ENHO/XHH"]);
    expect(ABAP_WRITE_TYPES).toContain("TYPE/DG");
    expect(ABAP_WRITE_TYPES).toContain("DRUL/DRL");
  });

  it("both are WRITABLE_TYPES, CREATABLE_TYPES and VERIFIED_CREATABLE_TYPES, and stay DELETABLE_TYPES", () => {
    for (const type of ["TYPE/DG", "DRUL/DRL"] as const) {
      expect(WRITABLE_TYPES, type).toContain(type);
      expect(CREATABLE_TYPES, type).toContain(type);
      expect(VERIFIED_CREATABLE_TYPES, type).toContain(type);
      expect(DELETABLE_TYPES, type).toContain(type);
    }
  });

  it("neither is NON_READABLE_TYPES or NON_WRITABLE_TYPES — both are readable and writable", () => {
    for (const type of ["TYPE/DG", "DRUL/DRL"] as const) {
      expect(NON_READABLE_TYPES, type).not.toContain(type);
      expect(NON_WRITABLE_TYPES, type).not.toContain(type);
    }
  });
});
