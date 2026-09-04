/**
 * PROG/I (program include) and FUGR/I (function-group include) went from bare
 * `{ label }` registry stubs to full entries, live-probed on A4H 2026-09-04:
 * `GET /sap/bc/adt/functions/groups/sabp_unit_sbox/includes/lsabp_unit_sboxtop`
 * → 200, `adtcore:name="LSABP_UNIT_SBOXTOP"` and
 * `<adtcore:containerRef adtcore:type="FUGR/F" adtcore:name="SABP_UNIT_SBOX">`
 * — the URI segment and the object name are the FULL include name, not a
 * 3-char suffix. `POST .../functions/validation?objtype=FUGR/I&fugrname=
 * SABP_UNIT_SBOX&objname=F01` → SEVERITY ERROR ("Include F01 will not be
 * created in function group SABP_UNIT_SBOX"); the same call with
 * `objname=LSABP_UNIT_SBOXF01` → SEVERITY OK — so the vendor CreatableTypes
 * `maxLen: 3` row is a client-side hint the server itself contradicts, corrected by
 * `NAME_LIMIT_OVERRIDES` in `src/adt/write.ts`.
 * `POST /sap/bc/adt/includes/validation?objtype=PROG/I&objname=ZTMD_INC_01&
 * packagename=$TMP` → CHECK_RESULT X: a program include is package-parented
 * and free-named, nothing ties it to a host program in the create body.
 * `GET /sap/bc/adt/programs/includes/lsabp_unit_sboxtop` → 200 with a generic
 * `Accept: application/*`, so neither type needs a `mediaType` override.
 * Create/delete were NOT run live for either type — both stay "unverified".
 */
import { describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import {
  CREATABLE_TYPES,
  DELETABLE_TYPES,
  VERIFIED_CREATABLE_TYPES,
  WRITABLE_TYPES,
  capabilitiesFor,
} from "../src/adt/capabilities.js";
import { buildUri, specForType, specFromUri } from "../src/adt/types.js";
import { resolveWriteTarget, type WriteTarget } from "../src/adt/write.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

describe("PROG/I and FUGR/I URI shape", () => {
  it("PROG/I builds against /programs/includes/, package-scoped", () => {
    const uri = buildUri(specForType("PROG/I")!, "ZTMD_INC_01");
    expect(uri).toBe("/sap/bc/adt/programs/includes/ztmd_inc_01");
  });

  it("FUGR/I builds against the GROUP's own /includes/ sub-collection", () => {
    const uri = buildUri(specForType("FUGR/I")!, "LZTMD_FG_01F01", "ZTMD_FG_01");
    expect(uri).toBe("/sap/bc/adt/functions/groups/ztmd_fg_01/includes/lztmd_fg_01f01");
  });

  it("round-trips PROG/I through specFromUri", () => {
    const uri = buildUri(specForType("PROG/I")!, "ZTMD_INC_01");
    const hit = specFromUri(uri);
    expect(hit?.spec.type).toBe("PROG/I");
    expect(hit?.name).toBe("ZTMD_INC_01");
  });

  it("round-trips FUGR/I through specFromUri, recovering both the name AND the parent group", () => {
    const uri = buildUri(specForType("FUGR/I")!, "LZTMD_FG_01F01", "ZTMD_FG_01");
    const hit = specFromUri(uri);
    expect(hit?.spec.type).toBe("FUGR/I");
    expect(hit?.name).toBe("LZTMD_FG_01F01");
    expect(hit?.parent).toBe("ZTMD_FG_01");
  });
});

// ---------------------------------------------------------------------------
// resolveWriteTarget, offline-fake: same idiom as the FUGR/FF container block
// in test/write.test.ts (`offline = null as unknown as AbapConnection` for the
// no-network refusal; a small FakeAdt for the one that does resolve).
// ---------------------------------------------------------------------------

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
  <message lang="EN">LZTMD_FG_01F01 does not exist</message><properties/></exc:exception>`;

interface Recorded {
  method: string;
  url: string;
}

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: (r: Recorded) => HttpClientResponse | undefined) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const rec: Recorded = { method: (o.method ?? "GET").toUpperCase(), url: o.url };
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

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

describe("FUGR/I create resolves against the group's /includes sub-collection", () => {
  const GROUP = "ZTMD_FG_01";
  const NAME = "LZTMD_FG_01F01";
  const GROUP_URI = "/sap/bc/adt/functions/groups/ztmd_fg_01";
  const INCLUDE_URI = `${GROUP_URI}/includes/lztmd_fg_01f01`;

  it("resolves uri and containerName against the GROUP, not the fmodules sibling", async () => {
    const { conn, adt } = await connected((r) =>
      r.url === INCLUDE_URI && r.method === "GET" ? resp(404, NOT_FOUND_XML, OK_XML) : undefined,
    );
    const t = await resolveWriteTarget(conn, { type: "FUGR/I", name: NAME, containerName: GROUP });
    expect(t.uri).toBe(INCLUDE_URI);
    expect(t.containerName).toBe(GROUP);
    expect(t.uri).not.toContain("/fmodules/");
    // The GET actually reached the includes URI — not merely computed and unused.
    expect(adt.calls.map((c) => c.url)).toContain(INCLUDE_URI);
  });

  it("refuses to resolve when no container is named — before any request", async () => {
    const offline = null as unknown as AbapConnection;
    const e = await catchErr(resolveWriteTarget(offline, { type: "FUGR/I", name: NAME }));
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toMatch(/container/i);
  });
});

// The vendor CreatableTypes row for FUGR/I says maxLen 3 — that counts only
// the suffix a GUI prompts for. abapsmith sends the full "L"+group+suffix
// name, capped at 30 (a function group name is itself capped at 26); see the
// file header's A4H functions/validation result for why 3 alone is wrong.
describe("FUGR/I name length: the 30-char override, not the vendor's 3-char suffix hint", () => {
  const GROUP = "ZTMD_FG_01";
  const NAME_30 = "LZTMD_FG_01_INCLUDE_LONGNAME30";
  const NAME_31 = "LZTMD_FG_01_INCLUDE_LONGNAME31X";
  const GROUP_URI = "/sap/bc/adt/functions/groups/ztmd_fg_01";
  const INCLUDE_URI_30 = `${GROUP_URI}/includes/${NAME_30.toLowerCase()}`;

  it("resolves a 30-character FUGR/I name", async () => {
    expect(NAME_30).toHaveLength(30);
    const { conn, adt } = await connected((r) =>
      r.url === INCLUDE_URI_30 && r.method === "GET"
        ? resp(404, NOT_FOUND_XML, OK_XML)
        : undefined,
    );
    const t = await resolveWriteTarget(conn, {
      type: "FUGR/I",
      name: NAME_30,
      containerName: GROUP,
    });
    expect(t.uri).toBe(INCLUDE_URI_30);
    expect(adt.calls.map((c) => c.url)).toContain(INCLUDE_URI_30);
  });

  it("refuses a 31-character FUGR/I name, before any request", async () => {
    expect(NAME_31).toHaveLength(31);
    const offline = null as unknown as AbapConnection;
    const e = await catchErr(
      resolveWriteTarget(offline, { type: "FUGR/I", name: NAME_31, containerName: GROUP }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect((e.details as { maxLength?: number }).maxLength).toBe(30);
  });
});

describe("PROG/I and FUGR/I registry shape", () => {
  it("both are writable as source, and activatable", () => {
    for (const type of ["PROG/I", "FUGR/I"]) {
      expect(capabilitiesFor(type)?.write?.shape).toBe("source");
      expect(capabilitiesFor(type)?.activate).toBe(true);
    }
  });

  it("both create via the vendor CreatableTypes table, with no hand-built skeleton and no mediaType override", () => {
    for (const type of ["PROG/I", "FUGR/I"]) {
      expect(capabilitiesFor(type)?.create?.vendor).toBe(true);
      expect(capabilitiesFor(type)?.create?.skeleton).toBeUndefined();
      expect(capabilitiesFor(type)?.mediaType).toBeUndefined();
    }
  });

  it("FUGR/I is container-parented (a function group); PROG/I defaults to a package parent", () => {
    expect(capabilitiesFor("FUGR/I")?.create?.parent).toBe("container");
    expect(capabilitiesFor("PROG/I")?.create?.parent).toBeUndefined();
  });
});

describe("PROG/I and FUGR/I: create and delete gates stay shut", () => {
  it("both are in WRITABLE_TYPES and CREATABLE_TYPES", () => {
    for (const type of ["PROG/I", "FUGR/I"]) {
      expect(WRITABLE_TYPES).toContain(type);
      expect(CREATABLE_TYPES).toContain(type);
    }
  });

  // Neither create nor delete was run live for these two types — only a
  // read-only ADT validation call was made (see the file header). The
  // coordinator's own live create/delete run against A4H is what would flip
  // these two gates, the same way it did for DCLS/DL.
  it("neither is in VERIFIED_CREATABLE_TYPES or DELETABLE_TYPES", () => {
    for (const type of ["PROG/I", "FUGR/I"]) {
      expect(capabilitiesFor(type)?.create?.verified).toBe("unverified");
      expect(capabilitiesFor(type)?.delete).toBe("unverified");
      expect(VERIFIED_CREATABLE_TYPES).not.toContain(type);
      expect(DELETABLE_TYPES).not.toContain(type);
    }
  });
});

describe("FUGR/I's LZ/LY name-prefix override, through the real safety gate", () => {
  it("is declared for FUGR/I only", () => {
    expect(capabilitiesFor("FUGR/I")?.namePrefixes).toEqual(["LZ", "LY"]);
    expect(capabilitiesFor("PROG/I")?.namePrefixes).toBeUndefined();
  });

  const typed = (name: string, type: string): WriteTarget & { packageName: string } => ({
    name,
    packageName: "$TMP",
    type,
  });

  it("accepts an LZ-prefixed FUGR/I include the global Z/Y list would refuse", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    expect(g.evaluate("write", typed("LZTMD_FG_01F01", "FUGR/I")).allowed).toBe(true);
  });

  it("still refuses a bare Z-prefixed FUGR/I name — the override REPLACES the global list, not adds to it", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const d = g.evaluate("write", typed("ZTMD_INC", "FUGR/I"));
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/object-name allowlist/);
  });

  it("PROG/I is judged by the global Z/Y list, not FUGR/I's override", () => {
    const g = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    expect(g.evaluate("write", typed("ZTMD_INC_01", "PROG/I")).allowed).toBe(true);
  });
});
