/**
 * `abapDeleteViaBridge` (VIEW/DV, TRAN/T) registers nothing in CTS: neither
 * delete bridge's generated code passes a request or calls RS_CORR_INSERT —
 * a claim about that generated code, not about what RPY_TRANSACTION_DELETE
 * does internally (`src/adt/capabilities.ts`'s TRAN/T `bridgeDelete` entry
 * records that as unknown). `view-delete.ts` calls DD_OBJ_DEL and
 * TR_TADIR_INTERFACE — `DDIF_VIEW_DELETE` does not exist on this system at
 * all — and `tran-delete.ts` calls RPY_TRANSACTION_DELETE. So any entry the
 * object already had on a transport request survives the delete untouched.
 * This file pins the two user-facing halves of that: the response note that
 * names `abap_transport removeObject` as the cleanup step (only for a non-$
 * package), and the `corr_nr` refusal's remediation text. Same
 * fake-`HttpClient` idiom as test/write-bridge-crud.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { DDIC_BRIDGE_CLASS } from "../src/adt/ddic-bridge.js";
import { vitBridgeUri } from "../src/adt/write-verify.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const MAX = 20_000;

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

const NOT_FOUND_XML = (name: string): string =>
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">${name} does not exist</message><properties/></exc:exception>`;

const LOCK_XML = (handle = "H1", isLocal = "X", corrNr = "") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>${isLocal}</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

type Route = (r: Recorded) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body };
    this.calls.push(rec);
    const res = this.route(rec);
    if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
    return res;
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

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(cfg(), {
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

const gate = () =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

const CLASS_COLLECTION = "/sap/bc/adt/oo/classes";

const bridgeDeployRoute = (bridgeClass: string): Route => {
  const bridgeObjUrl = `${CLASS_COLLECTION}/${bridgeClass.toLowerCase()}`;
  const bridgeSourceUri = `${bridgeObjUrl}/source/main`;
  return (r) => {
    if (r.url === bridgeObjUrl && r.method === "GET" && !r.qs._action) {
      return resp(404, NOT_FOUND_XML(bridgeClass), OK_XML);
    }
    if (r.url === CLASS_COLLECTION && r.method === "POST") return resp(200, "", OK_TEXT);
    if (r.url === bridgeObjUrl && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
    if (r.url === bridgeObjUrl && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === bridgeSourceUri && r.method === "PUT") return resp(200, "", OK_TEXT);
    return undefined;
  };
};

const classrunRoute =
  (tags: readonly string[]): Route =>
  (r) => {
    if (r.url.startsWith("/sap/bc/adt/oo/classrun/")) return resp(200, tags.join("\n"), OK_TEXT);
    if (r.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return undefined;
  };

/** The VIT-bridge stub GET — used both for pre-delete package resolution and post-delete verification. */
const vitRoute =
  (mode: "confirmed" | "absent", vitType: string, name: string, type: string, packageName = "ZTM"): Route =>
  (r) => {
    const uri = vitBridgeUri(vitType, name);
    if (r.url !== uri) return undefined;
    if (mode === "absent") return resp(404, NOT_FOUND_XML(name), OK_XML);
    return resp(
      200,
      `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" ` +
        `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:type="${type}" ` +
        `adtcore:name="${name}"><adtcore:packageRef adtcore:name="${packageName}"/></vit:properties>`,
      OK_XML,
    );
  };

const both =
  (...routes: Route[]): Route =>
  (r) => {
    for (const route of routes) {
      const hit = route(r);
      if (hit) return hit;
    }
    return undefined;
  };

const VIEW = "ZMCP_V_CARRIER";
const VIEW_BRIDGE = DDIC_BRIDGE_CLASS.deleteView;

/** VIEW/DV delete: confirmed present on the resolution read, gone on the post-delete verify read. */
const deleteView = async (packageName: string) => {
  const found = vitRoute("confirmed", "viewdv", VIEW, "VIEW/DV", packageName);
  const gone = vitRoute("absent", "viewdv", VIEW, "VIEW/DV");
  const classrun = classrunRoute(["VIEW-DELETED", "VIEW-GONE"]);
  const { conn, adt } = await connected(both(bridgeDeployRoute(VIEW_BRIDGE), classrun, (r) => found(r) ?? gone(r)));
  const result = await abapWrite(conn, { object: VIEW, type: "VIEW/DV", mode: "delete" }, MAX, gate());
  return { result, adt };
};

describe("abapDeleteViaBridge — leftover-transport-entry note", () => {
  it("pins: a transportable server-resolved package produces the leftover-entry note naming removeObject", async () => {
    const { result } = await deleteView("ZTM");
    expect(result.text).toMatch(/deleted:\s*true/);
    expect(result.text).toMatch(/transportable package ZTM, but this delete recorded nothing in CTS/);
    expect(result.text).toMatch(/Any entry it already had on a transport request survives it/);
    expect(result.text).toMatch(/removeObject/);
    expect(result.text).toMatch(/\(transport, object, confirm\), which needs ABAP_MODE=admin/);
  });

  it("pins: a $TMP server-resolved package produces NO leftover-entry note", async () => {
    const { result } = await deleteView("$TMP");
    expect(result.text).toMatch(/deleted:\s*true/);
    expect(result.text).not.toMatch(/removeObject/);
    expect(result.text).not.toMatch(/recorded nothing in CTS/);
  });
});

describe("abapDeleteViaBridge — corr_nr refusal points the caller at the real fix", () => {
  it("pins: corr_nr on a bridge delete is refused BAD_INPUT, and the message+hint send the caller to retry without it and to abap_transport removeObject", async () => {
    const offline = null as unknown as AbapConnection;
    const e = await catchErr(
      abapWrite(
        offline,
        { object: VIEW, type: "VIEW/DV", mode: "delete", corr_nr: "TR1K900123" },
        MAX,
        gate(),
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    // Why: still explains no delete bridge takes a transport parameter, and that none is needed.
    expect(String(e.message)).toMatch(/registers nothing in CTS/);
    expect(String(e.message)).toMatch(/no transport allowlist blocks it/);
    // Remediation lives in the hint: retry without corr_nr, then removeObject for the leftover entry.
    expect(String(e.hint)).toMatch(/Retry without `corr_nr`/);
    expect(String(e.hint)).toMatch(/removeObject/);
    expect(String(e.hint)).toMatch(/abap_transport/);
    expect(String(e.hint)).toMatch(/\(transport, object, confirm\) for that, which needs ABAP_MODE=admin/);
  });
});
