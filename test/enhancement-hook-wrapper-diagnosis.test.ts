/**
 * Defect 2: an `abap_write` of an ENHO/XHH body without its
 * `ENHANCEMENT <n>. ... ENDENHANCEMENT.` wrapper is rejected by SAP with
 * `ExceptionResourceScanDuringSaveFailure` and a generic "Scan of resource
 * failed" envelope that names no real problem: an ENHO/XHH `/source/main`
 * body is not a program at all, and the REPORT/PROGRAM wording a caller
 * eventually sees comes from the separate checkrun run alongside the PUT,
 * not from the PUT response itself.
 *
 * `missingEnhancementWrapperError` (src/adt/enhancement-refusals.ts) inspects
 * the source the caller sent and, when it is missing the wrapper, replaces
 * that unhelpful envelope with one that names the real thing that's missing.
 *
 * Unit tests below are pure — no connection, no fake HTTP — same idiom as
 * test/write-method-splice.test.ts. The one integration test at the bottom
 * drives `writeObject` end to end against a fake `HttpClient` to prove what a
 * caller actually sees when SAP rejects the PUT.
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
import { SafetyGate } from "../src/safety.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { authorizeMutation, writeObject } from "../src/adt/write.js";
import { missingEnhancementWrapperError } from "../src/adt/enhancement-refusals.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const TARGET = {
  name: "ZENH_FOO",
  type: "ENHO/XHH",
  uri: "/sap/bc/adt/enhancements/enhoxhh/zenh_foo",
};

// The generic envelope the PUT itself returns for
// ExceptionResourceScanDuringSaveFailure — every capture held here carries
// this text, not the REPORT/PROGRAM wording. That wording is the checkrun's,
// a separate call (see CHECK_MESSAGE below and the integration test).
const SCAN_MESSAGE = "Scan of resource failed";
const CHECK_MESSAGE =
  "The REPORT/PROGRAM statement is missing, or the program type is INCLUDE.";
const BARE_BODY = "WRITE 'hello'.";

describe("missingEnhancementWrapperError", () => {
  it("leaves a non-ENHO/XHH write to the ordinary syntax diagnosis, given the identical bare body", () => {
    expect(
      missingEnhancementWrapperError({ ...TARGET, type: "CLAS/OC" }, BARE_BODY, SCAN_MESSAGE),
    ).toBeUndefined();
  });

  it("does not fire when the wrapper is already present, server number and no name", () => {
    const wrapped = "ENHANCEMENT 1  .\n  WRITE 'hello'.\nENDENHANCEMENT.";
    expect(missingEnhancementWrapperError(TARGET, wrapped, SCAN_MESSAGE)).toBeUndefined();
  });

  it("recognizes a lowercase endenhancement. wrapper even when the header carries a name — detection is name-agnostic", () => {
    const wrapped = "ENHANCEMENT 1 ZENH_FOO.\n  WRITE 'hello'.\nendenhancement.";
    expect(missingEnhancementWrapperError(TARGET, wrapped, SCAN_MESSAGE)).toBeUndefined();
  });

  it("recognizes an indented ENDENHANCEMENT. as the wrapper", () => {
    const wrapped = "ENHANCEMENT 1  .\n  WRITE 'hello'.\n  ENDENHANCEMENT.";
    expect(missingEnhancementWrapperError(TARGET, wrapped, SCAN_MESSAGE)).toBeUndefined();
  });

  it("returns a CHECK_FAILED error naming ENHANCEMENT and ENDENHANCEMENT for a bare statement body", () => {
    const e = missingEnhancementWrapperError(TARGET, BARE_BODY, SCAN_MESSAGE);
    expect(e).toBeInstanceOf(AbapError);
    expect(e!.code).toBe("CHECK_FAILED");
    expect(e!.message).toMatch(/ENHANCEMENT/);
    expect(e!.message).toMatch(/ENDENHANCEMENT/);
  });

  it("points the hint at abap_read and warns against inventing the enhancement number", () => {
    const e = missingEnhancementWrapperError(TARGET, BARE_BODY, SCAN_MESSAGE)!;
    expect(e.hint ?? "").toContain("abap_read");
    expect(e.hint ?? "").toMatch(/do not invent/i);
  });

  it("documents the number-only header the server accepts, never the named form it rejects", () => {
    const e = missingEnhancementWrapperError(TARGET, BARE_BODY, SCAN_MESSAGE)!;
    const text = `${e.message}\n${e.hint ?? ""}`;
    expect(text).toContain("ENHANCEMENT <n>.");
    // `ENHANCEMENT <n> <name>.` is a 400 on this resource — probe 135 vs 147.
    expect(text).not.toMatch(/ENHANCEMENT\s+<n>\s+<\w+>/);
    expect(text).toMatch(/do not add an enhancement name/i);
  });

  it("still counts the wrapper as missing when ENDENHANCEMENT appears only inside comments", () => {
    const commentOnly = [
      "WRITE 'hello'.",
      "* ENDENHANCEMENT.",
      `WRITE 'again'. " ENDENHANCEMENT.`,
    ].join("\n");
    const e = missingEnhancementWrapperError(TARGET, commentOnly, SCAN_MESSAGE);
    expect(e).toBeInstanceOf(AbapError);
    expect(e!.code).toBe("CHECK_FAILED");
  });

  it("pins the PUT envelope (SCAN_MESSAGE) as details.originalMessage, unaltered", () => {
    const e = missingEnhancementWrapperError(TARGET, BARE_BODY, SCAN_MESSAGE)!;
    expect(e.message).toContain(SCAN_MESSAGE);
    expect(e.details.originalMessage).toBe(SCAN_MESSAGE);
  });

  describe("the check parameter", () => {
    const CHECK = {
      summary: "1 error",
      messages: `E line 1 col 0  ${CHECK_MESSAGE}`,
      raw: [{ severity: "E", text: CHECK_MESSAGE }],
    };

    it("folds the checkrun outcome into the message and details when supplied", () => {
      const e = missingEnhancementWrapperError(TARGET, BARE_BODY, SCAN_MESSAGE, CHECK)!;
      expect(e.message).toContain(CHECK.summary);
      expect(e.details.summary).toBe(CHECK.summary);
      expect(e.details.messages).toBe(CHECK.messages);
      expect(e.details.raw).toBe(CHECK.raw);
    });

    it("carries no summary/messages/raw keys in details when omitted", () => {
      const e = missingEnhancementWrapperError(TARGET, BARE_BODY, SCAN_MESSAGE)!;
      expect(e.details).not.toHaveProperty("summary");
      expect(e.details).not.toHaveProperty("messages");
      expect(e.details).not.toHaveProperty("raw");
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: writeObject, end to end, against a fake HttpClient.
//
// No fixture in test/fixtures/ or test/cassettes/ carries an
// ExceptionResourceScanDuringSaveFailure body (checked via
// `grep -rl ExceptionResourceScanDuringSaveFailure test/` before writing
// this) — the body below is built inline from the documented T100 message
// text, not a real capture.
// ---------------------------------------------------------------------------

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

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

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };
const OK_TEXT = { "content-type": "text/plain" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

const LOCK_XML = `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/></DATA></asx:values></asx:abap>`;

const ENH_URI = "/sap/bc/adt/enhancements/enhoxhh/zenh_foo";
const ENH_SRC = `${ENH_URI}/source/main`;

const ENH_XML = `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="ZENH_FOO" adtcore:type="ENHO/XHH" adtcore:masterSystem="A4H">` +
  `<adtcore:packageRef adtcore:name="$TMP"/></adtcore:objectMetadata>`;

/** The exact SAP rejection this fix exists for — see the module doc comment above. */
const SCAN_FAILURE_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceScanDuringSaveFailure"/>
  <message lang="EN">${SCAN_MESSAGE}</message><properties/></exc:exception>`;

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const config: Config = ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(config, { httpClient: adt, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  return { conn, adt };
}

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(() => undefined, (err: unknown) => err);
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

describe("writeObject — the caller-visible message for a wrapper-less ENHO/XHH PUT", () => {
  it("names ENHANCEMENT/ENDENHANCEMENT, folds in the checkrun's REPORT/PROGRAM diagnosis, and still shows SAP's PUT envelope", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === ENH_URI && r.method === "GET" && !r.qs._action) return resp(200, ENH_XML, OK_XML);
      if (r.url === ENH_SRC && r.method === "GET") {
        return resp(200, "ENHANCEMENT 1  .\nENDENHANCEMENT.\n", OK_TEXT);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === ENH_SRC && r.method === "PUT") return resp(400, SCAN_FAILURE_XML, OK_XML);
      if (r.url.includes("/checkruns")) {
        return resp(
          200,
          `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun">` +
            `<chkrun:checkReport><chkrun:checkMessageList>` +
            `<chkrun:checkMessage chkrun:uri="${ENH_SRC}#start=1,0" chkrun:type="E" ` +
            `chkrun:shortText="${CHECK_MESSAGE}"/>` +
            `</chkrun:checkMessageList></chkrun:checkReport></chkrun:checkRunReports>`,
          OK_XML,
        );
      }
      return undefined;
    });
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      allowEnhancements: true,
      enhanceTargets: "customer",
      originSystems: ["A4H"],
    });

    const e = await catchErr(
      writeObject(
        conn,
        await authorizeMutation(conn, gate, "write", {
          type: "ENHO/XHH",
          name: "zenh_foo",
          affects: { name: "ZTARGET_CLS", packageName: "ZTARGET_PKG", masterSystem: "A4H", spotName: "ZSPOT_FOO" },
        }),
        { source: BARE_BODY },
      ),
    );

    expect(e.code).toBe("CHECK_FAILED");
    expect(e.message).toMatch(/ENHANCEMENT/);
    expect(e.message).toMatch(/ENDENHANCEMENT/);
    // SAP's PUT envelope is not hidden, just no longer the ONLY diagnosis.
    expect(e.message).toContain(SCAN_MESSAGE);
    // The checkrun's real diagnostic survives in details, not just a summary.
    const details = JSON.stringify(e.details);
    expect(details).toContain(CHECK_MESSAGE);
    // Pins route 1: the checkrun actually ran, not skipped.
    expect(adt.calls.some((c) => c.url.includes("/checkruns"))).toBe(true);
  });
});
