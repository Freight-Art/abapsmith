/**
 * The `ddic` shortcut end to end through `abapWrite` (offline), for the two
 * write-path changes #144 asked for beyond the generator itself:
 *
 *  1. `source: ""` next to `ddic` is treated as ABSENT — a client that always
 *     sends the field is not asking for two descriptors. A non-empty `source`
 *     with `ddic` is still refused zero-network.
 *  2. When the pre-activation read-back shows the server dropped ONLY
 *     language-dependent texts (DTEL field labels, DOMA fixed-value texts),
 *     the CHECK_FAILED / VALUE_DISCARDED hint names the cause —
 *     `adtcore:masterLanguage` missing on the root — instead of the generic
 *     "rework the payload". That is what happened live for `ZAS_DTEL_TEST` on
 *     A4H, 2026-09-16: labels sent, labels stored empty, no warning.
 *
 * Offline only. Harness copied from test/properties-write-fidelity.test.ts
 * (itself copied from test/write-toctou.test.ts — see that file for why it is
 * copied rather than imported); the DTEL bodies are produced by the real
 * generator, not hand-written.
 */
import { describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { buildStructuredDdicDescriptor } from "../src/adt/ddic-payload.js";
import { discardedDescriptorValues } from "../src/adt/descriptor-fidelity.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Harness, copied verbatim from test/properties-write-fidelity.test.ts.
// ---------------------------------------------------------------------------

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

const LOCK_XML = (handle = "H1", isLocal = "X", corrNr = "") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>${isLocal}</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

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
  if (r.url.endsWith("/discovery")) return resp(200, "<discovery/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
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

const gate = (): SafetyGate => new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

// ---------------------------------------------------------------------------
// This file's own fixtures.
// ---------------------------------------------------------------------------

const DTEL_NAME = "ZAS_DTEL_WP";
const DTEL_URI = "/sap/bc/adt/ddic/dataelements/zas_dtel_wp";
const DESCR = "label discard probe";

const LABELS = { shortLabel: "Status", mediumLabel: "Order status", longLabel: "Status of the order", headingLabel: "St." };

/** What the generator sends for `ddic: LABELS`. */
const generated = (): string => buildStructuredDdicDescriptor("DTEL/DE", DTEL_NAME, DESCR, "$TMP", LABELS);

/** The same document as the server stores it when it drops the labels: every `<dtel:*FieldLabel>` self-closed. */
const withLabelsDropped = (xml: string): string => xml.replace(/<dtel:(\w+FieldLabel)>[^<]*<\/dtel:\1>/g, "<dtel:$1/>");

/** Same properties-shape UPDATE read budget as test/properties-write-fidelity.test.ts: `before` serves reads 1-3, `afterWrite` 4+. */
function toolServer(before: string, afterWrite: string) {
  let reads = 0;
  const route = (r: Recorded): HttpClientResponse | undefined => {
    if (r.url === DTEL_URI && r.method === "GET") {
      reads += 1;
      return resp(200, reads <= 3 ? before : afterWrite, OK_XML);
    }
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === DTEL_URI && r.method === "PUT") return resp(200, "", OK_TEXT);
    if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
    return undefined;
  };
  return { route, reads: () => reads };
}

const writeVia = (conn: AbapConnection, input: Record<string, unknown>) =>
  abapWrite(conn, { object: DTEL_NAME, type: "DTEL/DE", package: "$TMP", description: DESCR, ...input } as never, 60_000, gate());

// ---------------------------------------------------------------------------

describe("abapWrite — `ddic` next to `source`", () => {
  it("source: \"\" is treated as absent: the ddic descriptor is what gets PUT", async () => {
    const before = buildStructuredDdicDescriptor("DTEL/DE", DTEL_NAME, "old", "$TMP", { shortLabel: "Old" });
    const srv = toolServer(before, generated());
    const { conn, adt } = await connected(srv.route);

    const result = await writeVia(conn, { source: "", ddic: LABELS });

    const put = adt.calls.find((c) => c.method === "PUT" && c.url === DTEL_URI);
    expect(put?.body).toContain("<dtel:shortFieldLabel>Status</dtel:shortFieldLabel>");
    expect(put?.body).toContain('adtcore:masterLanguage="EN"');
    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(true);
    expect(result.text).not.toMatch(/VALUE_DISCARDED/);
  });

  it("a non-empty source next to ddic is still refused before any request", async () => {
    const srv = toolServer("", "");
    const { conn, adt } = await connected(srv.route);

    const err = await catchErr(writeVia(conn, { source: "<x/>", ddic: LABELS }));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toMatch(/`source` and `ddic` cannot both be given/);
    expect(adt.calls).toHaveLength(0);
  });
});

describe("abapWrite — VALUE_DISCARDED hint names adtcore:masterLanguage when only texts were dropped (#144)", () => {
  it("via `source` without masterLanguage: tells the caller to add the attribute and resend", async () => {
    // The live reproduction: the generator's pre-fix body (no root language
    // attributes), sent as `source`, labels stored empty.
    const sent = generated().replace(' adtcore:masterLanguage="EN" adtcore:language="EN"', "");
    expect(sent).not.toContain("masterLanguage");
    const before = buildStructuredDdicDescriptor("DTEL/DE", DTEL_NAME, "old", "$TMP", { shortLabel: "Old" });
    const srv = toolServer(before, withLabelsDropped(sent));
    const { conn, adt } = await connected(srv.route);

    const err = await catchErr(writeVia(conn, { source: sent }));

    expect(err.code).toBe("CHECK_FAILED");
    expect(err.details.reason).toBe("VALUE_DISCARDED");
    expect(err.message).toContain("dtel:shortFieldLabel");
    expect(err.message).toContain("dtel:headingFieldLabel");
    expect(err.hint).toMatch(/not a rejection/i);
    expect(err.hint).toMatch(/language-dependent texts/);
    expect(err.hint).toMatch(/adtcore:masterLanguage="EN"/);
    expect(err.hint).toMatch(/send the same document again/);
    expect(err.hint).toMatch(/abap_read/);
    expect(err.hint).toMatch(/abap_activate/);
    expect(err.hint).toMatch(/write journal is off/);
    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(false);
  });

  it("via `ddic` (root already carries the attribute): says so rather than telling the caller to add it", async () => {
    const before = buildStructuredDdicDescriptor("DTEL/DE", DTEL_NAME, "old", "$TMP", { shortLabel: "Old" });
    const srv = toolServer(before, withLabelsDropped(generated()));
    const { conn } = await connected(srv.route);

    const err = await catchErr(writeVia(conn, { ddic: LABELS }));

    expect(err.code).toBe("CHECK_FAILED");
    expect(err.details.reason).toBe("VALUE_DISCARDED");
    expect(err.hint).toMatch(/language-dependent texts/);
    expect(err.hint).toMatch(/already has it/);
    expect(err.hint).not.toMatch(/Add adtcore:masterLanguage/);
  });

  it("a DOMA flag sent `true` and stored `false` is reported as a discard, with both values (#145)", () => {
    // Live, A4H, 2026-09-16: `signExists` after `lowercase` was ignored on
    // activation — stored false, no message — and the count-only rule
    // could not see it. The builder now orders the elements correctly;
    // this pins the guard that would have caught it.
    const sent = buildStructuredDdicDescriptor("DOMA/DD", "ZAS_DOMA_AMT", DESCR, "$TMP", {
      dataType: "DEC",
      length: 13,
      decimals: 3,
      signExists: true,
    });
    const stored = sent.replace("<doma:signExists>true</doma:signExists>", "<doma:signExists>false</doma:signExists>");
    expect(discardedDescriptorValues(sent, stored)).toEqual([{ element: "doma:signExists", sent: ["true"], stored: ["false"] }]);
    // The reverse flip and ordinary normalisation stay silent.
    expect(discardedDescriptorValues(stored, sent)).toEqual([]);
    expect(discardedDescriptorValues(sent, sent.replace("<doma:length>13</doma:length>", "<doma:length>000013</doma:length>"))).toEqual([]);
  });

  it("keeps the generic hint when something other than a text was dropped", async () => {
    const sent = buildStructuredDdicDescriptor("DTEL/DE", DTEL_NAME, DESCR, "$TMP", { typeKind: "domain", typeName: "ZAS_DOMA_X", ...LABELS });
    const stored = sent.replace("<dtel:typeName>ZAS_DOMA_X</dtel:typeName>", "<dtel:typeName/>");
    const before = buildStructuredDdicDescriptor("DTEL/DE", DTEL_NAME, "old", "$TMP", { shortLabel: "Old" });
    const srv = toolServer(before, stored);
    const { conn } = await connected(srv.route);

    const err = await catchErr(writeVia(conn, { source: sent }));

    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("dtel:typeName");
    expect(err.hint).not.toMatch(/masterLanguage/);
    expect(err.hint).toMatch(/rework the payload/);
  });
});
