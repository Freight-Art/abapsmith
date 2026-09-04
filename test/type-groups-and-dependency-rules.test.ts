/**
 * Pinning test for two ADT object types added 2026-09-04 from live A4H
 * recon: TYPE/DG "Type group" and DRUL/DRL "Dependency rule". Both are
 * read+write only — `create` is undefined (ENHANCEABLE_TYPES member) and
 * `delete` is `"unverified"`, never attempted against the live system.
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
  headers?: Record<string, unknown>;
}

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">does not exist</message><properties/></exc:exception>`;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: (r: Recorded) => HttpClientResponse | undefined) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const rec: Recorded = {
      method: (o.method ?? "GET").toUpperCase(),
      url: o.url,
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
  it("TYPE/DG capabilities: source write, activatable, delete unverified, no create", () => {
    const cap = capabilitiesFor("TYPE/DG");
    expect(cap?.label).toBe("Type group");
    expect(cap?.write?.shape).toBe("source");
    expect(cap?.activate).toBe(true);
    expect(cap?.delete).toBe("unverified");
    expect(cap?.mediaType).toBe("application/vnd.sap.adt.ddic.typegroups.v2+xml");
    expect(cap?.create).toBeUndefined();
  });

  it("DRUL/DRL capabilities: source write, activatable, delete unverified, no create", () => {
    const cap = capabilitiesFor("DRUL/DRL");
    expect(cap?.label).toBe("Dependency rule");
    expect(cap?.write?.shape).toBe("source");
    expect(cap?.activate).toBe(true);
    expect(cap?.delete).toBe("unverified");
    expect(cap?.mediaType).toBe("application/vnd.sap.adt.ddic.drul.v1+xml");
    expect(cap?.create).toBeUndefined();
  });
});

describe("TYPE/DG and DRUL/DRL: create is refused", () => {
  it("neither type is in CREATABLE_TYPES or VERIFIED_CREATABLE_TYPES", () => {
    expect(CREATABLE_TYPES).not.toContain("TYPE/DG");
    expect(CREATABLE_TYPES).not.toContain("DRUL/DRL");
    expect(VERIFIED_CREATABLE_TYPES).not.toContain("TYPE/DG");
    expect(VERIFIED_CREATABLE_TYPES).not.toContain("DRUL/DRL");
  });

  it("writeObject on an absent TYPE/DG object throws UNSUPPORTED after exactly one non-mutating GET", async () => {
    const { conn, adt } = await connected(ABSENT_ROUTE);
    // Z-prefixed name: SafetyGate's customer-namespace check runs before
    // resolveWriteTarget's existence GET, and would otherwise refuse first.
    const target = await authorizeMutation(conn, DEFAULT_GATE, "write", { type: "TYPE/DG", name: "ZTREXC1" });
    // resolveWriteTarget's existence-check GET (404, exists:false) is the
    // only network call before writeObject's own create gate fires;
    // readCurrentSource is zero-cost when !t.exists.
    const e = await catchErr(
      writeObject(conn, target, { source: "TYPE-POOL ztrexc1. CONSTANTS: c1 TYPE i VALUE 1." }),
    );
    expect(isAbapError(e)).toBe(true);
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/TYPE\/DG/);
    expect(adt.calls).toHaveLength(1);
    expect(adt.calls[0].method).toBe("GET");
  });

  it("writeObject on an absent DRUL/DRL object throws UNSUPPORTED after exactly one non-mutating GET", async () => {
    const { conn, adt } = await connected(ABSENT_ROUTE);
    const target = await authorizeMutation(conn, DEFAULT_GATE, "write", { type: "DRUL/DRL", name: "ZDEMO_DRUL_1" });
    const e = await catchErr(
      writeObject(conn, target, { source: "DEFINE FILTER DEPENDENCY RULE zdemo_drul_1 ON demo_parts_1" }),
    );
    expect(isAbapError(e)).toBe(true);
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/DRUL\/DRL/);
    expect(adt.calls).toHaveLength(1);
    expect(adt.calls[0].method).toBe("GET");
  });
});

describe("TYPE/DG and DRUL/DRL: op \"delete\" is refused offline", () => {
  const offline = null as unknown as AbapConnection;

  it("TYPE/DG delete throws UNSUPPORTED naming the label and type code, zero requests", async () => {
    const e = await catchErr(resolveWriteTarget(offline, { type: "TYPE/DG", name: "TREXC" }, "delete"));
    expect(isAbapError(e)).toBe(true);
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/Type group/);
    expect(String(e.message)).toMatch(/TYPE\/DG/);
  });

  it("DRUL/DRL delete throws UNSUPPORTED naming the label and type code, zero requests", async () => {
    const e = await catchErr(resolveWriteTarget(offline, { type: "DRUL/DRL", name: "DEMO_DRUL_1" }, "delete"));
    expect(isAbapError(e)).toBe(true);
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/Dependency rule/);
    expect(String(e.message)).toMatch(/DRUL\/DRL/);
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
  it("both are ENHANCEABLE_TYPES and ABAP_WRITE_TYPES", () => {
    expect(ENHANCEABLE_TYPES).toContain("TYPE/DG");
    expect(ENHANCEABLE_TYPES).toContain("DRUL/DRL");
    expect(ABAP_WRITE_TYPES).toContain("TYPE/DG");
    expect(ABAP_WRITE_TYPES).toContain("DRUL/DRL");
  });

  it("neither is WRITABLE_TYPES, CREATABLE_TYPES, VERIFIED_CREATABLE_TYPES, or DELETABLE_TYPES", () => {
    for (const type of ["TYPE/DG", "DRUL/DRL"] as const) {
      expect(WRITABLE_TYPES, type).not.toContain(type);
      expect(CREATABLE_TYPES, type).not.toContain(type);
      expect(VERIFIED_CREATABLE_TYPES, type).not.toContain(type);
      expect(DELETABLE_TYPES, type).not.toContain(type);
    }
  });

  it("neither is NON_READABLE_TYPES or NON_WRITABLE_TYPES — both are readable and writable", () => {
    for (const type of ["TYPE/DG", "DRUL/DRL"] as const) {
      expect(NON_READABLE_TYPES, type).not.toContain(type);
      expect(NON_WRITABLE_TYPES, type).not.toContain(type);
    }
  });
});
