/**
 * `src/adt/transport-entry-remove.ts` (the `TREN` DDIC bridge) plus the two
 * layers around it: `trFindEntryHolder` (`src/adt/transports.ts`) and
 * `abap_transport` operation `removeObject` (`src/tools/transport.ts`).
 * Offline throughout — no network, no live appliance.
 *
 * Bridge deploy/execute mechanics are exercised via the fake-`HttpClient`
 * harness from `test/view-delete.test.ts`; `trFindEntryHolder` and the tool
 * layer's cheap refusals are exercised via `fakeCtsConnection` and the
 * already-captured `transport-details-with-objects` fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import {
  ABAP_SOURCE_LINE_MAX,
  DDIC_BRIDGE_CLASS,
  DDIC_ERR_PREFIX,
  DDIC_TAGS,
  ddicBridgeSource,
  parseDdicTranscript,
} from "../src/adt/ddic-bridge.js";
import {
  TRANSPORT_ENTRY_REMOVE_DATA_LINES,
  removeTransportEntryViaBridge,
  transportEntryRemoveFragment,
  type TransportEntryRemoveParams,
} from "../src/adt/transport-entry-remove.js";
import { authorizeCeiling, trFindEntryHolder, type CeilingGate } from "../src/adt/transports.js";
import { abapTransport, type TransportInput, type TransportJournalDeps } from "../src/tools/transport.js";
import { Journal, type JournalConfig, type JournalEntry } from "../src/journal.js";
import { fakeCtsConnection, loadCtsFixture } from "./helpers/cts-fixtures.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const MAX_CHARS = 60_000;

// ---------------------------------------------------------------------------
// A `TransportCeilingProof`, minted the only legal way, for direct calls to
// `removeTransportEntryViaBridge` — mirrors test/transports-verify.test.ts.
// ---------------------------------------------------------------------------

const alwaysAllow: CeilingGate = { evaluate: () => ({ allowed: true, reason: "test: always allowed" }) };
const proof = authorizeCeiling(alwaysAllow, "transport");

// ---------------------------------------------------------------------------
// Fake HttpClient harness for the classrun bridge — same shape as
// test/view-delete.test.ts / test/package-delete.test.ts.
// ---------------------------------------------------------------------------

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    readOnly: false,
  });

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
  statusText = String(status),
): HttpClientResponse => ({ status, statusText, body, headers }) as unknown as HttpClientResponse;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

const SESSION_URL = "/sap/bc/adt/compatibility/graph";
const CLASS_COLLECTION = "/sap/bc/adt/oo/classes";
const TRANSPORT_REQUESTS = "/sap/bc/adt/cts/transportrequests";
const BRIDGE = DDIC_BRIDGE_CLASS.removeTransportEntry;

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

/** GET-404 -> POST-create -> LOCK -> PUT -> UNLOCK for the bridge class itself. */
function objectHappyPath(collectionUrl: string, name: string): (o: HttpClientOptions) => HttpClientResponse | undefined {
  const objUrl = `${collectionUrl}/${name.toLowerCase()}`;
  const sourceUri = `${objUrl}/source/main`;
  return (o: HttpClientOptions) => {
    const qs = (o.qs ?? {}) as Record<string, string>;
    const method = (o.method ?? "GET").toUpperCase();
    if (o.url === objUrl && method === "GET" && !qs._action) {
      const r = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
      throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
    }
    if (o.url === collectionUrl && method === "POST") return resp(200, "", {});
    if (o.url === objUrl && qs._action === "LOCK") return resp(200, LOCK_XML(), { "content-type": "application/xml" });
    if (o.url === objUrl && qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (o.url === sourceUri && method === "PUT") return resp(200, "", { "content-type": "text/plain" });
    return undefined;
  };
}

/** Session/discovery/activation/classrun plumbing shared by every bridge test below. */
function sharedRoute(
  classrun: (o: HttpClientOptions) => HttpClientResponse | undefined,
): (o: HttpClientOptions) => HttpClientResponse | undefined {
  return (o: HttpClientOptions) => {
    if (o.url.startsWith("/sap/bc/adt/oo/classrun/")) return classrun(o);
    if (o.url.includes(SESSION_URL)) {
      return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
    }
    if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
    if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
    if (o.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return undefined;
  };
}

/** A GET of one specific transport request, answered with a real captured fixture body. */
function trShowRoute(trkorr: string, fixtureName: string): (o: HttpClientOptions) => HttpClientResponse | undefined {
  const fixture = loadCtsFixture(fixtureName);
  const url = `${TRANSPORT_REQUESTS}/${trkorr}`;
  return (o: HttpClientOptions) => {
    const method = (o.method ?? "GET").toUpperCase();
    if (o.url === url && method === "GET") return resp(fixture.meta.status, fixture.body, fixture.meta.responseHeaders);
    return undefined;
  };
}

const INFO_SEARCH_URL = "/sap/bc/adt/repository/informationsystem/search";

/**
 * Fakes `searchExact`'s `informationsystem/search` quickSearch, for
 * `probeObjectOnSystem`. "hit" answers with one exact-name match, "empty"
 * with none, and "fail" throws (a network error), same shape as
 * objectHappyPath's 404 above.
 */
function quickSearchRoute(mode: "hit" | "empty" | "fail"): (o: HttpClientOptions) => HttpClientResponse | undefined {
  return (o: HttpClientOptions) => {
    if (o.url !== INFO_SEARCH_URL) return undefined;
    if (mode === "fail") {
      const r = resp(500, "<exc:exception/>", { "content-type": "application/xml" });
      throw new HttpClientException("Request failed with status code 500", "500", 500, undefined, o, r);
    }
    const ref =
      mode === "hit"
        ? `<adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/programs/zmcp_cts_probe" ` +
          `adtcore:type="PROG/P" adtcore:name="ZMCP_CTS_PROBE" adtcore:packageName="$TMP"/>`
        : "";
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">${ref}</adtcore:objectReferences>`;
    return resp(200, body, { "content-type": "application/xml" });
  };
}

function combine(
  ...routes: Array<(o: HttpClientOptions) => HttpClientResponse | undefined>
): (o: HttpClientOptions) => HttpClientResponse {
  return (o: HttpClientOptions) => {
    for (const r of routes) {
      const hit = r(o);
      if (hit) return hit;
    }
    throw new Error(`unrouted request: ${(o.method ?? "GET").toUpperCase()} ${o.url}`);
  };
}

async function connected(
  route: (o: HttpClientOptions) => HttpClientResponse,
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(route);
  const conn = new AbapConnection(cfg(), {
    httpClient: inner,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner };
}

/** A bare classrun body — see test/package-delete.test.ts's identical helper. */
function classrunOutput(lines: readonly string[]): (o: HttpClientOptions) => HttpClientResponse {
  const body = lines.join("\n");
  return () => resp(200, body, { "content-type": "text/plain" });
}

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!e || !isAbapError(e)) throw new Error(`expected an AbapError, got ${String(e)}`);
  return e;
};

function catchSync(fn: () => unknown): AbapError {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected to throw");
}

/** Wide open: write, delete-ceiling and the bridge's own package all permitted. */
const bridgeAdminGate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransportDelete: true });

const PARAMS: TransportEntryRemoveParams = { trkorr: "A4HK900545", objectName: "ZTMD_I26_P1" };

// ---------------------------------------------------------------------------
// Minimal local TransportInput builder (transport-tools.test.ts's own helper
// is not exported — re-declared here rather than imported).
// ---------------------------------------------------------------------------

function transportInput(
  partial: Partial<TransportInput> & { operation: TransportInput["operation"] },
): TransportInput {
  return {
    transport: undefined,
    user: undefined,
    object: undefined,
    package: undefined,
    description: undefined,
    confirm: undefined,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// 1 - fragment content: the two mandatory FMs, in the right shape
// ---------------------------------------------------------------------------

describe("transportEntryRemoveFragment ABAP shape", () => {
  it("calls TRINT_READ_REQUEST to resolve the holder and TR_DELETE_COMM_OBJECT_KEYS to remove the row", () => {
    const joined = transportEntryRemoveFragment(PARAMS).join("\n");
    expect(joined).toContain("CALL FUNCTION 'TRINT_READ_REQUEST'");
    expect(joined).toContain("CALL FUNCTION 'TR_DELETE_COMM_OBJECT_KEYS'");
    expect(joined).toContain("is_e071_delete");
    expect(joined).toContain("iv_dialog_flag = space");
    expect(joined).toContain("'A4HK900545'");
    expect(joined).toContain("'ZTMD_I26_P1'");
  });

  it("is_e071_delete and cs_request are passed on the SAME statement as TR_DELETE_COMM_OBJECT_KEYS — either missing short-dumps on the server", () => {
    const lines = transportEntryRemoveFragment(PARAMS);
    const callIdx = lines.findIndex((l) => l.includes("CALL FUNCTION 'TR_DELETE_COMM_OBJECT_KEYS'"));
    expect(callIdx).toBeGreaterThanOrEqual(0);
    const stmtEnd = lines.findIndex((l, i) => i >= callIdx && l.trim().endsWith("."));
    const stmt = lines.slice(callIdx, stmtEnd + 1).join("\n");
    expect(stmt).toContain("iv_dialog_flag = space");
    expect(stmt).toContain("is_e071_delete = ls_e071");
    expect(stmt).toContain("cs_request = ls_req");
  });

  it("a COMMIT WORK follows the delete loop, not the other way around", () => {
    const lines = transportEntryRemoveFragment(PARAMS);
    const callIdx = lines.findIndex((l) => l.includes("CALL FUNCTION 'TR_DELETE_COMM_OBJECT_KEYS'"));
    const commitIdx = lines.findIndex((l) => l.trim() === "COMMIT WORK AND WAIT.");
    expect(callIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(callIdx);
  });

  it("TRANSPORT_ENTRY_REMOVE_DATA_LINES declares the locals the fragment relies on", () => {
    expect(TRANSPORT_ENTRY_REMOVE_DATA_LINES).toContain("ls_e071 TYPE e071.");
    expect(TRANSPORT_ENTRY_REMOVE_DATA_LINES).toContain("lv_holder TYPE trkorr.");
  });

  it("TRANSPORT_ENTRY_REMOVE_DATA_LINES also declares lv_subrc/ls_msg/lv_msgtext/lv_readerr", () => {
    expect(TRANSPORT_ENTRY_REMOVE_DATA_LINES).toContain("lv_subrc TYPE sy-subrc.");
    expect(TRANSPORT_ENTRY_REMOVE_DATA_LINES).toContain("ls_msg TYPE symsg.");
    expect(TRANSPORT_ENTRY_REMOVE_DATA_LINES).toContain("lv_msgtext TYPE string.");
    expect(TRANSPORT_ENTRY_REMOVE_DATA_LINES).toContain("lv_readerr TYPE string.");
  });

  it("lv_subrc = sy-subrc. and MOVE-CORRESPONDING sy TO ls_msg. are the two lines immediately after BOTH 'EXCEPTIONS OTHERS = 1.' lines — out->write or anything else in between would clobber sy-* first", () => {
    const lines = transportEntryRemoveFragment(PARAMS);
    const exceptionsIdx = lines
      .map((l, i) => (l === "    EXCEPTIONS OTHERS = 1." ? i : -1))
      .filter((i) => i >= 0);
    // One per CALL FUNCTION site: TRINT_READ_REQUEST and TR_DELETE_COMM_OBJECT_KEYS.
    expect(exceptionsIdx).toHaveLength(2);
    for (const idx of exceptionsIdx) {
      expect(lines[idx + 1]).toBe("  lv_subrc = sy-subrc.");
      expect(lines[idx + 2]).toBe("  MOVE-CORRESPONDING sy TO ls_msg.");
    }
  });

  it("no 'IF sy-subrc <> 0.' guard remains on either CALL FUNCTION — both guards read lv_subrc instead", () => {
    const joined = transportEntryRemoveFragment(PARAMS).join("\n");
    expect(joined).not.toContain("IF sy-subrc <> 0.");
    expect(joined).toContain("IF lv_subrc <> 0.");
  });

  it("step 4's failure write reads lv_subrc and lv_msgtext, never the (by-then-clobbered) sy-subrc", () => {
    const lines = transportEntryRemoveFragment(PARAMS);
    const line = lines.find((l) => l.includes("TR_DELETE_COMM_OBJECT_KEYS failed for"));
    expect(line).toBeDefined();
    expect(line).toContain("sy-subrc={ lv_subrc }");
    expect(line).toContain("msg={ lv_msgtext }");
    expect(line).not.toContain("sy-subrc={ sy-subrc }");
  });

  it("both step 2 refusal branches produce an errorLine that satisfies beforeAssert's own startsWith(\"no entry for\") predicate", () => {
    const lines = transportEntryRemoveFragment(PARAMS);
    const writeLines = lines.filter((l) => l.includes("out->write( |ZMCP-DDIC-ERR> no entry for"));
    expect(writeLines).toHaveLength(2); // the IF branch and the ELSE branch
    for (const line of writeLines) {
      const literal = /\|(.*)\|/.exec(line)?.[1];
      if (literal === undefined) throw new Error(`no |...| string literal found in: ${line}`);
      expect(literal.startsWith(DDIC_ERR_PREFIX)).toBe(true);
      // Run the exact same parser removeTransportEntryViaBridge's beforeAssert reads errorLine from.
      const { errorLine } = parseDdicTranscript(literal);
      expect(errorLine?.startsWith("no entry for")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2 - tag drift: every tag the fragment writes is a tag DDIC_TAGS declares
// ---------------------------------------------------------------------------

describe("transportEntryRemoveFragment only ever writes tags DDIC_TAGS declares", () => {
  it("TREN-REMOVED and TREN-GONE, and nothing else — asserted as a set", () => {
    const lines = transportEntryRemoveFragment(PARAMS);
    const written = new Set(
      lines
        .map((l) => /out->write\(\s*'([A-Z-]+)'\s*\)/.exec(l)?.[1])
        .filter((t): t is string => t !== undefined),
    );
    expect(written).toEqual(new Set(["TREN-REMOVED", "TREN-GONE"]));
    for (const tag of written) {
      expect(DDIC_TAGS as readonly string[]).toContain(tag);
    }
  });
});

// ---------------------------------------------------------------------------
// 3 - zero-network input refusals
// ---------------------------------------------------------------------------

describe("a malformed or injection-y trkorr/objectName is refused before any network call", () => {
  const badTrkorrs = ["not-a-trkorr", "A4HK900545'; DELETE", "A4HK900545\nFOO", ""];
  const badObjects = ["Z'FOO", "Z.FOO", "Z\nFOO", "Z FOO"];

  it.each(badTrkorrs)("transportEntryRemoveFragment refuses trkorr=%s with BAD_INPUT", (trkorr) => {
    const err = catchSync(() => transportEntryRemoveFragment({ trkorr, objectName: "ZTMD_I26_P1" }));
    expect(err.code).toBe("BAD_INPUT");
  });

  it.each(badObjects)("transportEntryRemoveFragment refuses objectName=%s with BAD_INPUT", (objectName) => {
    const err = catchSync(() => transportEntryRemoveFragment({ trkorr: "A4HK900545", objectName }));
    expect(err.code).toBe("BAD_INPUT");
  });

  it("removeTransportEntryViaBridge refuses the same bad values with BAD_INPUT and zero HTTP requests", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["TREN-REMOVED", "TREN-GONE"])),
    );
    const { conn, inner } = await connected(route);
    for (const trkorr of badTrkorrs) {
      const err = await catchErr(
        removeTransportEntryViaBridge(conn, bridgeAdminGate(), { trkorr, objectName: "ZTMD_I26_P1" }, proof),
      );
      expect(err.code).toBe("BAD_INPUT");
    }
    for (const objectName of badObjects) {
      const err = await catchErr(
        removeTransportEntryViaBridge(conn, bridgeAdminGate(), { trkorr: "A4HK900545", objectName }, proof),
      );
      expect(err.code).toBe("BAD_INPUT");
    }
    expect(inner.calls.length).toBe(0);
  });

  it("trFindEntryHolder refuses a malformed trkorr with BAD_INPUT and zero requests", async () => {
    const { conn, calls } = fakeCtsConnection([]);
    for (const trkorr of badTrkorrs) {
      const err = await catchErr(trFindEntryHolder(conn, trkorr, "ZMCP_CTS_PROBE"));
      expect(err.code).toBe("BAD_INPUT");
    }
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4 - request-vs-task resolution: the whole point of trFindEntryHolder
// ---------------------------------------------------------------------------

describe("trFindEntryHolder resolves to the TASK that actually carries the entry, not the request", () => {
  it("A4HK900117 carries ZMCP_CTS_PROBE only via its task A4HK900118 — the holder returned is the task", async () => {
    const fixture = loadCtsFixture("transport-details-with-objects");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const holder = await trFindEntryHolder(conn, "A4HK900117", "ZMCP_CTS_PROBE");

    expect(holder.trkorr).toBe("A4HK900118");
    expect(holder.onTask).toBe(true);
    expect(holder.requested).toBe("A4HK900117");
    expect(holder.rows.length).toBeGreaterThan(0);
    expect(holder.rows.every((r) => r.name.toUpperCase() === "ZMCP_CTS_PROBE")).toBe(true);
    expect(calls).toHaveLength(1); // trShow does exactly ONE network call
  });
});

// ---------------------------------------------------------------------------
// 5 - row not found
// ---------------------------------------------------------------------------

describe("trFindEntryHolder throws NOT_FOUND when neither the request nor any of its tasks carry the entry", () => {
  it("names both the transport and the object in the error", async () => {
    const fixture = loadCtsFixture("transport-details-with-objects");
    const { conn } = fakeCtsConnection([fixture]);

    const err = await catchErr(trFindEntryHolder(conn, "A4HK900117", "ZNOPE_DOES_NOT_EXIST"));

    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain("A4HK900117");
    expect(err.message).toContain("ZNOPE_DOES_NOT_EXIST");
  });
});

// ---------------------------------------------------------------------------
// 6 - tool-level refusals cost zero requests
// ---------------------------------------------------------------------------

describe("abap_transport operation: removeObject refuses cheaply, before any network call", () => {
  it("no confirm -> BAD_INPUT, zero requests", async () => {
    const { conn, calls } = fakeCtsConnection([]);
    await expect(
      abapTransport(
        conn,
        transportInput({ operation: "removeObject", transport: "A4HK900117", object: "ZMCP_CTS_PROBE" }),
        MAX_CHARS,
        bridgeAdminGate(),
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(calls).toHaveLength(0);
  });

  it("a mismatched confirm is BAD_INPUT, zero requests", async () => {
    const { conn, calls } = fakeCtsConnection([]);
    await expect(
      abapTransport(
        conn,
        transportInput({
          operation: "removeObject",
          transport: "A4HK900117",
          object: "ZMCP_CTS_PROBE",
          confirm: "A4HK900118",
        }),
        MAX_CHARS,
        bridgeAdminGate(),
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(calls).toHaveLength(0);
  });

  it("a read-only gate refuses with READ_ONLY, zero requests, even with a matching confirm", async () => {
    const gate = new SafetyGate({ readOnly: true, allowPackages: [] });
    const { conn, calls } = fakeCtsConnection([]);
    await expect(
      abapTransport(
        conn,
        transportInput({
          operation: "removeObject",
          transport: "A4HK900117",
          object: "ZMCP_CTS_PROBE",
          confirm: "A4HK900117",
        }),
        MAX_CHARS,
        gate,
      ),
    ).rejects.toMatchObject({ code: "READ_ONLY" });
    expect(calls).toHaveLength(0);
  });

  it("ordinary write access without the admin-only allowTransportDelete ceiling refuses with READ_ONLY, zero requests", async () => {
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
    const { conn, calls } = fakeCtsConnection([]);
    await expect(
      abapTransport(
        conn,
        transportInput({
          operation: "removeObject",
          transport: "A4HK900117",
          object: "ZMCP_CTS_PROBE",
          confirm: "A4HK900117",
        }),
        MAX_CHARS,
        gate,
      ),
    ).rejects.toMatchObject({ code: "READ_ONLY" });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7 - bridge happy path (removeTransportEntryViaBridge directly)
// ---------------------------------------------------------------------------

describe("removeTransportEntryViaBridge happy path", () => {
  it("TREN-REMOVED, TREN-GONE resolves; holder and removed rows are parsed out of the transcript", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(
        classrunOutput([
          "ZMCP-TREN-HOLDER A4HK900546",
          "ZMCP-TREN-ROW R3TR PROG ZTMD_I26_P1",
          "TREN-REMOVED",
          "TREN-GONE",
        ]),
      ),
    );
    const { conn, inner } = await connected(route);

    const result = await removeTransportEntryViaBridge(conn, bridgeAdminGate(), PARAMS, proof);

    expect(result.transcript.tags).toEqual(["TREN-REMOVED", "TREN-GONE"]);
    expect(result.transcript.errorLine).toBeUndefined();
    expect(result.holder).toBe("A4HK900546");
    expect(result.removed).toEqual([{ pgmid: "R3TR", object: "PROG", name: "ZTMD_I26_P1" }]);

    const sourceUri = `${CLASS_COLLECTION}/${BRIDGE.toLowerCase()}/source/main`;
    const put = inner.calls.find((c) => (c.method ?? "").toUpperCase() === "PUT" && c.url === sourceUri);
    expect(String(put?.body).toUpperCase()).toContain(BRIDGE);
  });

  it("without a ZMCP-TREN-HOLDER line, the holder falls back to the requested trkorr", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["TREN-REMOVED", "TREN-GONE"])),
    );
    const { conn } = await connected(route);

    const result = await removeTransportEntryViaBridge(conn, bridgeAdminGate(), PARAMS, proof);

    expect(result.holder).toBe(PARAMS.trkorr);
    expect(result.removed).toEqual([]);
  });

  it("the ABAP-side 'no entry for' refusal becomes a named NOT_FOUND, not a generic missing-tag CHECK_FAILED", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(
        classrunOutput([`ZMCP-DDIC-ERR> no entry for ${PARAMS.objectName} on ${PARAMS.trkorr} or its tasks`]),
      ),
    );
    const { conn } = await connected(route);

    const err = await catchErr(removeTransportEntryViaBridge(conn, bridgeAdminGate(), PARAMS, proof));

    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain(PARAMS.objectName);
    expect(err.message).toContain(PARAMS.trkorr);
  });
});

// ---------------------------------------------------------------------------
// 8 - end-to-end: abap_transport removeObject drives trFindEntryHolder THEN
//     the bridge, and reports the resolved (task) holder, not the request
//     the caller named.
// ---------------------------------------------------------------------------

describe("abap_transport removeObject end-to-end happy path", () => {
  it("resolves A4HK900117 -> task A4HK900118 via trFindEntryHolder, then removes via the bridge", async () => {
    const route = combine(
      trShowRoute("A4HK900117", "transport-details-with-objects"),
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(
        classrunOutput([
          "ZMCP-TREN-HOLDER A4HK900118",
          "ZMCP-TREN-ROW R3TR PROG ZMCP_CTS_PROBE",
          "TREN-REMOVED",
          "TREN-GONE",
        ]),
      ),
    );
    const { conn, inner } = await connected(route);

    const res = await abapTransport(
      conn,
      transportInput({
        operation: "removeObject",
        transport: "A4HK900117",
        object: "ZMCP_CTS_PROBE",
        confirm: "A4HK900117",
      }),
      MAX_CHARS,
      bridgeAdminGate(),
    );

    expect(res.text).toContain("holder: A4HK900118");
    expect(res.text).toContain("transport: A4HK900117");
    expect(res.text).toContain("removedCount: 1");
    expect(res.text).toContain("gone: true");
    expect(res.text).toMatch(/task/);

    const getCall = inner.calls.find((c) => (c.method ?? "").toUpperCase() === "GET" && c.url === `${TRANSPORT_REQUESTS}/A4HK900117`);
    expect(getCall).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 9 - journalling: the resolved holder, not the caller's number, is what
//     gets journalled, and the before-image is a captured record of the
//     removed row(s) rather than "unknown".
// ---------------------------------------------------------------------------

describe("abap_transport removeObject journalling", () => {
  let tmp: string;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "abapsmith-tren-journal-"));
    warn = vi.fn();
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  const jcfg = (): JournalConfig => ({
    dir: tmp,
    enabled: true,
    maxEntries: 200,
    maxAgeDays: 30,
  });

  const deps = (): TransportJournalDeps => ({
    journal: new Journal(jcfg(), "A4H"),
    cfg: { sid: "A4H", url: "http://a4h.example:50000", client: "001" },
    warn: warn as unknown as (msg: string) => void,
  });

  const written = async (): Promise<JournalEntry[]> => new Journal(jcfg(), "A4H").list();

  it("a successful removeObject journals one entry under the RESOLVED holder (a task), not the request the caller passed, with a captured before-image naming the removed row", async () => {
    const route = combine(
      trShowRoute("A4HK900117", "transport-details-with-objects"),
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(
        classrunOutput([
          "ZMCP-TREN-HOLDER A4HK900118",
          "ZMCP-TREN-ROW R3TR PROG ZMCP_CTS_PROBE",
          "TREN-REMOVED",
          "TREN-GONE",
        ]),
      ),
    );
    const { conn } = await connected(route);

    const res = await abapTransport(
      conn,
      transportInput({
        operation: "removeObject",
        transport: "A4HK900117",
        object: "ZMCP_CTS_PROBE",
        confirm: "A4HK900117",
      }),
      MAX_CHARS,
      bridgeAdminGate(),
      deps(),
    );
    // No informationsystem/search route is scripted here, so the existence probe fails
    // closed to "unknown" — journalling must still complete normally either way.
    expect(res.text).toContain("objectOnSystem: unknown");

    const entries = await written();
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.operation).toBe("transport-remove-object");
    // The holder is a TASK of A4HK900117, not the request itself — the entry
    // must be filed under the task, never the number the caller passed.
    expect(e.object.name).toBe("A4HK900118");
    expect(e.corrNr).toBe("A4HK900118");
    expect(e.object.name).not.toBe("A4HK900117");
    expect(e.outcome).toBe("succeeded");
    expect(e.beforeCapture).toBe("captured");

    const before = await new Journal(jcfg(), "A4H").beforeImage(e);
    expect(before).toBeTruthy();
    expect(before).toContain("ZMCP_CTS_PROBE");
  });

  it("when the bridge throws, the entry is still recorded and stays pending (unproven) — never succeeded — and the original error still reaches the caller", async () => {
    const route = combine(
      trShowRoute("A4HK900117", "transport-details-with-objects"),
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(
        classrunOutput(["ZMCP-DDIC-ERR> no entry for ZMCP_CTS_PROBE on A4HK900118 or its tasks"]),
      ),
    );
    const { conn } = await connected(route);

    const err = await catchErr(
      abapTransport(
        conn,
        transportInput({
          operation: "removeObject",
          transport: "A4HK900117",
          object: "ZMCP_CTS_PROBE",
          confirm: "A4HK900117",
        }),
        MAX_CHARS,
        bridgeAdminGate(),
        deps(),
      ),
    );
    expect(err.code).toBe("NOT_FOUND");
    // NOT_FOUND is not the TR_DELETE_COMM_OBJECT_KEYS refusal enrichCommObjectKeysRefusal
    // targets — it must reach the caller with no objectOnSystem grafted onto it.
    expect(err.details.objectOnSystem).toBeUndefined();

    const entries = await written();
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.operation).toBe("transport-remove-object");
    expect(e.object.name).toBe("A4HK900118");
    expect(e.outcome).toBe("pending");
    expect(e.error).toBeUndefined();
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/stays `pending` on purpose/);

    const before = await new Journal(jcfg(), "A4H").beforeImage(e);
    expect(before).toBeTruthy();
    expect(before).toContain("ZMCP_CTS_PROBE");
  });
});

// ---------------------------------------------------------------------------
// 10 - worst-case assembled-source line length, through ddicBridgeSource (it
//      prepends 4 spaces on top of the fragment's own indentation).
// ---------------------------------------------------------------------------

describe("worst-case assembled-source line length stays within ABAP_SOURCE_LINE_MAX", () => {
  function offendingLines(source: string): Array<{ line: number; length: number }> {
    return source
      .split("\n")
      .map((text, i) => ({ line: i + 1, length: text.length }))
      .filter((l) => l.length > ABAP_SOURCE_LINE_MAX);
  }

  it("transportEntryRemoveFragment, through ddicBridgeSource, at the longest legal object name (40 chars) and trkorr (fixed at 10 chars)", () => {
    const worstCase: TransportEntryRemoveParams = {
      trkorr: PARAMS.trkorr, // TRKORR_RE fixes the shape at 10 chars — there is no "longer" one
      objectName: "Z" + "A".repeat(39), // assertEnhIdentifier's cap for this call is maxLength: 40
    };
    const source = ddicBridgeSource(
      DDIC_BRIDGE_CLASS.removeTransportEntry,
      TRANSPORT_ENTRY_REMOVE_DATA_LINES,
      transportEntryRemoveFragment(worstCase),
    );
    expect(offendingLines(source)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 11 - the removeObject tool layer's objectOnSystem probe: does the object
//      an E071 entry names still exist, settled BEFORE the bridge runs, and
//      never allowed to block the removal itself.
// ---------------------------------------------------------------------------

describe("abap_transport removeObject — objectOnSystem probe", () => {
  const removeInput = transportInput({
    operation: "removeObject",
    transport: "A4HK900117",
    object: "ZMCP_CTS_PROBE",
    confirm: "A4HK900117",
  });

  const bridgeSuccess = () =>
    classrunOutput([
      "ZMCP-TREN-HOLDER A4HK900118",
      "ZMCP-TREN-ROW R3TR PROG ZMCP_CTS_PROBE",
      "TREN-REMOVED",
      "TREN-GONE",
    ]);

  it('the search fake reports a hit -> objectOnSystem: "present", plus the live-object note', async () => {
    const route = combine(
      trShowRoute("A4HK900117", "transport-details-with-objects"),
      quickSearchRoute("hit"),
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(bridgeSuccess()),
    );
    const { conn } = await connected(route);

    const res = await abapTransport(conn, removeInput, MAX_CHARS, bridgeAdminGate());

    expect(res.text).toContain("objectOnSystem: present");
    expect(res.text).toContain("still exists on the system — removing this entry stripped CTS's lock");
  });

  it('the search fake reports no hit -> objectOnSystem: "absent", and no extra note', async () => {
    const route = combine(
      trShowRoute("A4HK900117", "transport-details-with-objects"),
      quickSearchRoute("empty"),
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(bridgeSuccess()),
    );
    const { conn } = await connected(route);

    const res = await abapTransport(conn, removeInput, MAX_CHARS, bridgeAdminGate());

    expect(res.text).toContain("objectOnSystem: absent");
    expect(res.text).not.toMatch(/still exists on the system/);
    expect(res.text).not.toMatch(/Could not settle whether/);
  });

  it('the search fake throws -> the removal still succeeds (the probe never blocks it), and objectOnSystem: "unknown" carries the caution note', async () => {
    const route = combine(
      trShowRoute("A4HK900117", "transport-details-with-objects"),
      quickSearchRoute("fail"),
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(bridgeSuccess()),
    );
    const { conn } = await connected(route);

    const res = await abapTransport(conn, removeInput, MAX_CHARS, bridgeAdminGate());

    expect(res.text).toContain("removedCount: 1"); // the removal itself is unaffected by the probe failing
    expect(res.text).toContain("objectOnSystem: unknown");
    expect(res.text).toContain(
      'Could not settle whether ZMCP_CTS_PROBE still exists on the system — do not read this as "gone".',
    );
  });
});

// ---------------------------------------------------------------------------
// 12 - TR_DELETE_COMM_OBJECT_KEYS refusal enrichment: the tool layer names
//      SE03/SE09/SE10 and threads objectOnSystem onto that ONE specific
//      CHECK_FAILED shape, and leaves every other error byte for byte.
// ---------------------------------------------------------------------------

describe("abap_transport removeObject — TR_DELETE_COMM_OBJECT_KEYS refusal enrichment", () => {
  const REFUSAL_LINE =
    "ZMCP-DDIC-ERR> TR_DELETE_COMM_OBJECT_KEYS failed for R3TR TABL ZMCP_CTS_PROBE, sy-subrc=1, msg=E1CTS042 v1=A4HK900118 v2= v3= v4=";

  const removeInput = transportInput({
    operation: "removeObject",
    transport: "A4HK900117",
    object: "ZMCP_CTS_PROBE",
    confirm: "A4HK900117",
  });

  it("is enriched with details.objectOnSystem and a hint naming SE03 Unlock Objects (Expert Tool) and SE09/SE10 — the message stays byte for byte", async () => {
    const route = combine(
      trShowRoute("A4HK900117", "transport-details-with-objects"),
      quickSearchRoute("hit"),
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["ZMCP-TREN-HOLDER A4HK900118", REFUSAL_LINE])),
    );
    const { conn } = await connected(route);

    const err = await catchErr(abapTransport(conn, removeInput, MAX_CHARS, bridgeAdminGate()));

    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("msg=E1CTS042");
    expect(err.details.objectOnSystem).toBe("present");
    expect(err.hint).toContain("SE03");
    expect(err.hint).toContain("Unlock Objects (Expert Tool)");
    expect(err.hint).toMatch(/SE09\/SE10/);
  });

  it("a NOT_FOUND refusal (the pre-existing 'no entry for' path) is rethrown byte for byte — no SE03 text, no objectOnSystem grafted on", async () => {
    const route = combine(
      trShowRoute("A4HK900117", "transport-details-with-objects"),
      quickSearchRoute("hit"),
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(
        classrunOutput(["ZMCP-DDIC-ERR> no entry for ZMCP_CTS_PROBE on A4HK900118 or its tasks"]),
      ),
    );
    const { conn } = await connected(route);

    const err = await catchErr(abapTransport(conn, removeInput, MAX_CHARS, bridgeAdminGate()));

    expect(err.code).toBe("NOT_FOUND");
    expect(err.hint).toBeUndefined();
    expect(err.details.objectOnSystem).toBeUndefined();
  });

  it("a CHECK_FAILED that does not name TR_DELETE_COMM_OBJECT_KEYS is also rethrown untouched — pins the enrichment's narrowness on the message check, not just the code", async () => {
    const route = combine(
      trShowRoute("A4HK900117", "transport-details-with-objects"),
      quickSearchRoute("hit"),
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["ZMCP-TREN-HOLDER A4HK900118"])), // no success tags, no error line
    );
    const { conn } = await connected(route);

    const err = await catchErr(abapTransport(conn, removeInput, MAX_CHARS, bridgeAdminGate()));

    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).not.toContain("TR_DELETE_COMM_OBJECT_KEYS");
    expect(err.hint).toBeUndefined();
    expect(err.details.objectOnSystem).toBeUndefined();
  });
});
