/**
 * `assertLockObjectRoot` (src/adt/write.ts) is the guard that fixes the real,
 * long-standing cause of every historical ENQU/DL create failure: the wire
 * XML's root element has to be lowercase `enqu:lockobject` in namespace
 * `http://www.sap.com/adt/ddic/enqu`. Every earlier attempt sent camelCase
 * `enqu:lockObject` in the plausible-looking but wrong namespace
 * `http://www.sap.com/dictionary/lockobject`, and the appliance rejected the
 * ROOT element itself (`ExceptionInvalidData`) before looking at anything
 * nested — live-confirmed on A4H 2026-09-05, where the corrected root got a
 * plain `201`.
 *
 * This file is a focused unit test for the guard alone: refusal of the
 * historical wrong document (before any wire call beyond the resolution
 * GET), acceptance of the corrected document end-to-end through
 * `writeObject`, that the guard is scoped to ENQU/DL only (it must never
 * fire for any other type), and that it checks the resolved namespace —
 * not the literal prefix spelling — of the root element.
 *
 * Self-contained rather than importing helpers from `write.test.ts`: that
 * file exports nothing, by design (see its own header), so the small set of
 * fakes needed here (a fake `HttpClient`, `connected()`, `resp()`, ...) are
 * duplicated in miniature rather than the two files being wired together.
 */
import { describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import {
  assertLockObjectRoot,
  authorizeMutation,
  resolveWriteTarget,
  writeObject,
  type ResolvedTarget,
  type WriteTarget,
} from "../src/adt/write.js";
import { SafetyGate } from "../src/safety.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const DEFAULT_GATE = new SafetyGate({ readOnly: false, allowPackages: ["*"] });

const authWrite = (conn: AbapConnection, target: WriteTarget, gate: SafetyGate = DEFAULT_GATE) =>
  authorizeMutation(conn, gate, "write", target);

const LOCK_XML = (handle = "H1", isLocal = "X", corrNr = "") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>${isLocal}</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">object does not exist</message><properties/></exc:exception>`;

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

const OBJECT_XML = (name: string, type: string, packageName = "$TMP"): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${name}" adtcore:type="${type}">` +
  `<adtcore:packageRef adtcore:name="${packageName}"/>` +
  `</adtcore:objectMetadata>`;

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

/** Everything `connect()` needs, including the T000 role probe. */
function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

async function connected(
  route: Route,
  config: Config = cfg(),
): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
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

const ENQU_URI = "/sap/bc/adt/ddic/lockobjects/sources/ez_root_x";
const TTYP_URI = "/sap/bc/adt/ddic/tabletypes/z_root_x_ta";

/** The historical, wrong document: camelCase root in the wrong namespace. */
const WRONG_ROOT_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<enqu:lockObject xmlns:enqu="http://www.sap.com/dictionary/lockobject" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="EZ_ROOT_X" ` +
  `adtcore:type="ENQU/DL"><adtcore:packageRef adtcore:name="$TMP"/>` +
  `<enqu:content><enqu:primaryTable><enqu:tableName>ZTAB1</enqu:tableName>` +
  `<enqu:lockMode>E</enqu:lockMode></enqu:primaryTable></enqu:content></enqu:lockObject>`;

/** The corrected document: lowercase root in the correct namespace. */
const CORRECT_ROOT_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<enqu:lockobject xmlns:enqu="http://www.sap.com/adt/ddic/enqu" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="EZ_ROOT_X" ` +
  `adtcore:type="ENQU/DL"><adtcore:packageRef adtcore:name="$TMP"/>` +
  `<enqu:content><enqu:primaryTable><enqu:tableName>ZTAB1</enqu:tableName>` +
  `<enqu:lockMode>E</enqu:lockMode></enqu:primaryTable></enqu:content></enqu:lockobject>`;

describe("assertLockObjectRoot", () => {
  it("refuses the historical camelCase/wrong-namespace document BAD_INPUT, before any wire call beyond the resolution GET", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === ENQU_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      // These WOULD have answered success — proving refusal is the guard,
      // not a lucky mock miss.
      if (r.url === "/sap/bc/adt/ddic/lockobjects/sources" && r.method === "POST")
        return resp(201, WRONG_ROOT_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === ENQU_URI && r.method === "PUT") return resp(200, WRONG_ROOT_XML, OK_XML);
      return undefined;
    });
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "ENQU/DL", name: "EZ_ROOT_X" }), {
        source: WRONG_ROOT_XML,
      }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/lockobject/);
    expect(String(e.message)).toMatch(/http:\/\/www\.sap\.com\/adt\/ddic\/enqu/);
    // Only the resolution GET — refused before the create POST, before any
    // lock, before anything else on the wire.
    expect(adt.labels).toEqual([`GET ${ENQU_URI}`]);
  });

  it("accepts the corrected lowercase document end-to-end, POSTing the caller's bytes verbatim", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === ENQU_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/ddic/lockobjects/sources" && r.method === "POST")
        return resp(201, CORRECT_ROOT_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === ENQU_URI && r.method === "PUT") return resp(200, CORRECT_ROOT_XML, OK_XML);
      return undefined;
    });
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "ENQU/DL", name: "EZ_ROOT_X" }),
      { source: CORRECT_ROOT_XML },
    );
    expect(res.created).toBe(true);
    expect(adt.labels).toEqual([
      `GET ${ENQU_URI}`,
      "POST /sap/bc/adt/ddic/lockobjects/sources",
      `LOCK ${ENQU_URI}`,
      `PUT ${ENQU_URI}`,
      `UNLOCK ${ENQU_URI}`,
    ]);
    expect(
      adt.calls.find((c) => c.method === "POST" && c.url.endsWith("lockobjects/sources"))!.body,
    ).toBe(CORRECT_ROOT_XML);
    expect(adt.calls.find((c) => c.method === "PUT")!.body).toBe(CORRECT_ROOT_XML);
  });

  it("is scoped to ENQU/DL only — calling it directly against a TTYP/DA target never throws, whatever the XML", async () => {
    const { conn } = await connected((r) => {
      if (r.url === TTYP_URI && r.method === "GET")
        return resp(200, OBJECT_XML("Z_ROOT_X_TA", "TTYP/DA"), OK_XML);
      return undefined;
    });
    const target: ResolvedTarget = await resolveWriteTarget(conn, {
      type: "TTYP/DA",
      name: "Z_ROOT_X_TA",
    });
    // Not just "no lockobject root" — content that would ALSO fail the
    // ENQU-specific check for an unrelated reason (empty string, garbage,
    // even literally the wrong-root ENQU document) must still no-op here,
    // because the very first line of the guard is `if (t.type !== "ENQU/DL") return;`.
    expect(() => assertLockObjectRoot(target, "")).not.toThrow();
    expect(() => assertLockObjectRoot(target, "not xml at all")).not.toThrow();
    expect(() => assertLockObjectRoot(target, WRONG_ROOT_XML)).not.toThrow();
    expect(() => assertLockObjectRoot(target, CORRECT_ROOT_XML)).not.toThrow();
  });

  it("checks the resolved namespace, not the prefix spelling: right root/wrong namespace is refused, right namespace/different prefix is accepted", async () => {
    const { conn } = await connected((r) => {
      if (r.url === ENQU_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      return undefined;
    });
    const target: ResolvedTarget = await resolveWriteTarget(conn, {
      type: "ENQU/DL",
      name: "EZ_ROOT_X",
    });

    // Correct local name `lockobject`, correct prefix spelling `enqu`, but
    // bound to the WRONG namespace — must still refuse. The guard resolves
    // the prefix against its own `xmlns:` declaration; it does not trust the
    // prefix string on faith.
    const rightLocalNameWrongNamespace =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<enqu:lockobject xmlns:enqu="http://www.sap.com/dictionary/lockobject" ` +
      `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="EZ_ROOT_X" ` +
      `adtcore:type="ENQU/DL"><adtcore:packageRef adtcore:name="$TMP"/>` +
      `<enqu:content><enqu:primaryTable><enqu:tableName>ZTAB1</enqu:tableName>` +
      `<enqu:lockMode>E</enqu:lockMode></enqu:primaryTable></enqu:content></enqu:lockobject>`;
    expect(() => assertLockObjectRoot(target, rightLocalNameWrongNamespace)).toThrow(AbapError);
    expect(() => assertLockObjectRoot(target, rightLocalNameWrongNamespace)).toThrow(/BAD_INPUT|lockobject/i);

    // Different prefix spelling entirely (`lo:` instead of `enqu:`), bound to
    // the CORRECT namespace via its own `xmlns:lo=` declaration — must be
    // accepted, because the guard is namespace-resolved, not prefix-literal.
    const rightNamespaceDifferentPrefix =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<lo:lockobject xmlns:lo="http://www.sap.com/adt/ddic/enqu" ` +
      `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="EZ_ROOT_X" ` +
      `adtcore:type="ENQU/DL"><adtcore:packageRef adtcore:name="$TMP"/>` +
      `<lo:content><lo:primaryTable><lo:tableName>ZTAB1</lo:tableName>` +
      `<lo:lockMode>E</lo:lockMode></lo:primaryTable></lo:content></lo:lockobject>`;
    expect(() => assertLockObjectRoot(target, rightNamespaceDifferentPrefix)).not.toThrow();

    // And a bare, unprefixed root under a default `xmlns=` bound to the same
    // correct namespace must also be accepted (the guard's `nsAttrRe` falls
    // back to a bare `xmlns=` when the root carries no prefix at all).
    const rightNamespaceNoPrefix =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<lockobject xmlns="http://www.sap.com/adt/ddic/enqu" ` +
      `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="EZ_ROOT_X" ` +
      `adtcore:type="ENQU/DL"><adtcore:packageRef adtcore:name="$TMP"/>` +
      `<content><primaryTable><tableName>ZTAB1</tableName>` +
      `<lockMode>E</lockMode></primaryTable></content></lockobject>`;
    expect(() => assertLockObjectRoot(target, rightNamespaceNoPrefix)).not.toThrow();
  });
});
