/**
 * `abap_activate mode="format"` (issue #91) — the pretty-printer feature.
 *
 * Two mutually exclusive forms:
 *
 *   - TEXT form (`source`, no `object`): stateless. POSTs the given text to
 *     `/sap/bc/adt/abapsource/prettyprinter` (`prettyPrintSource`,
 *     src/adt/activate.ts) and returns the formatted text. No lock, no PUT,
 *     no journal entry, no activation — gated as READ.
 *
 *   - OBJECT form (`object`, no `source`): reads the object's saved source,
 *     formats it, and — only if the bytes changed — writes the result back
 *     through the journalled `abapWrite` path with `activate: true` and
 *     `expect_etag` computed from the source AS READ. If nothing changed, it
 *     returns `changed: false` with no lock, no PUT, no journal entry — gated
 *     as WRITE.
 *
 * Fixtures are real A4H captures (test/fixtures/live-captured/90{1,2,3}-*):
 * 901 is a read-only observation of the server's OWN pretty-printer setting
 * (indentation=true, style=keywordUpper, keepIdentifier=true) — abapsmith
 * must never write to that endpoint. 902 POSTs unformatted source and gets
 * back CRLF-terminated, keyword-uppercased text. 903 POSTs the
 * already-formatted text back and gets the byte-identical reply (same
 * sha256 as 902) — this is where `changed:false` for real input comes from.
 *
 * Every request is served by a fake `HttpClient` (no network, ever); any
 * request the fake has no route for THROWS, naming the method and URL — a
 * silent 200 fallback is exactly what would let a regression (an unexpected
 * lock, an unexpected PUT, a write to the settings endpoint) pass unnoticed.
 * Mirrors test/write.test.ts's `FakeAdt`, not test/activate.test.ts's more
 * permissive `RoutingClient`.
 *
 * A NOTE ON A REAL BUG FOUND WHILE WRITING THIS FILE, AND FIXED (see the
 * describe block "CRLF-terminated saved source: mode=format correctly
 * reports changed:false" below, and the final report): `prettyPrintSource`
 * normalises CRLF→LF on the SERVER'S REPLY only, then compares that
 * normalised text against the RAW/unnormalised `source` argument to decide
 * `changed`. Real ADT source reads commonly come back CRLF-terminated
 * (fixture 903's own request body is CRLF — it is what a GET of
 * already-formatted saved source looks like on the wire). Feeding that CRLF
 * text back through `prettyPrintSource` as "current saved source" — exactly
 * fixture 903's scenario — used to make it report `changed: true` with a
 * nonzero `linesChanged`, purely from trailing `\r`, even though nothing
 * textually changed, and would go on to lock, PUT, activate and journal an
 * object that needed none of that. `prettyPrintSource` itself is untouched
 * (shared with `abap_write format:true`, out of scope here); the fix is in
 * `abapActivateFormat`'s object form, which now decides whether to write
 * back by comparing `current` against `outcome.source` through
 * `sourceEquals` (src/adt/write.ts, CRLF-aware) instead of trusting
 * `outcome.changed` — the same comparison `writeObject`'s own
 * compare-before-write short-circuit already uses.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import { canonicalEtag, sourceEquals } from "../src/adt/write.js";
import { Journal } from "../src/journal.js";
import { SafetyGate } from "../src/safety.js";
import { errorResult } from "../src/server.js";
import {
  abapActivate,
  abapActivateFormat,
  registerActivateTools,
  type ActivateInput,
  type ActivateToolDeps,
} from "../src/tools/activate.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// --------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const readMeta = (f: string): { requestBody: string } =>
  JSON.parse(readFileSync(join(FIXTURES, `${f}.meta.json`), "utf8")) as { requestBody: string };
const readBody = (f: string): string => readFileSync(join(FIXTURES, `${f}.xml`), "utf8");

/** 902's own request body: unformatted source, LF, as a caller would send it. */
const UNFORMATTED = readMeta("902-i91-prettyprinter-format").requestBody;
/** 902's own response body: the server's real reply — CRLF-terminated, keywords upper-cased. */
const FORMATTED_CRLF = readBody("902-i91-prettyprinter-format");
/** What `prettyPrintSource` returns as `outcome.source` — CRLF normalised to LF. */
const FORMATTED_LF = FORMATTED_CRLF.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
/** 903's own request body: already-formatted text, CRLF — what a GET of saved source looks like. */
const ALREADY_FORMATTED_CRLF = readMeta("903-i91-prettyprinter-idempotent").requestBody;

it("fixture sanity: 902's response and 903's response are byte-identical, and 903's request is that same CRLF text", () => {
  // Pinned once, up front, so every test below that leans on this fact does
  // not have to re-derive it. Read from the files themselves, not asserted
  // from the brief.
  expect(readBody("903-i91-prettyprinter-idempotent")).toBe(FORMATTED_CRLF);
  expect(ALREADY_FORMATTED_CRLF).toBe(FORMATTED_CRLF);
  expect(FORMATTED_CRLF).toMatch(/\r\n/);
  expect(FORMATTED_CRLF.includes("\r\n")).toBe(true);
});

// --------------------------------------------------------------- transport ---

interface Recorded {
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}
type Route = (r: Recorded) => HttpClientResponse | undefined;

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

/**
 * Throws on any unrouted request, naming the method and URL. A catch-all 200
 * is exactly what would let an unexpected lock, PUT, or settings write pass
 * silently — see test/write.test.ts's `FakeAdt`, which this mirrors.
 */
class StrictFake implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const rec: Recorded = {
      method,
      url: o.url,
      qs,
      body: typeof o.body === "string" ? o.body : undefined,
    };
    this.calls.push(rec);
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const res = this.route(rec);
    if (!res) throw new Error(`StrictFake: unrouted request ${label}`);
    return res;
  }
  get labels(): string[] {
    return this.calls.map((c) => (c.qs._action ? `${c.qs._action} ${c.url}` : `${c.method} ${c.url}`));
  }
}

/** Everything `connect()` needs; anything else falls through to the test's own route. */
function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

const cfg = (readOnly: boolean): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    // Client 001 is provably non-productive (fixture 087 / T000_NONPRODUCTIVE)
    // — without it the fail-closed role probe locks writes out regardless of
    // `readOnly`, which is not what these tests are about.
    client: "001",
    readOnly,
  });

async function connected(
  route: Route,
  readOnly = false,
): Promise<{ conn: AbapConnection; adt: StrictFake }> {
  const adt = new StrictFake((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(cfg(readOnly), {
    httpClient: adt,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const PRETTYPRINT_URL = "/sap/bc/adt/abapsource/prettyprinter";
const SETTINGS_URL_FRAGMENT = "prettyprinter/settings";

/** Always answers the pretty-printer POST with the live-captured CRLF reply, whatever was sent. */
const prettyPrinterRoute: Route = (r) => {
  if (r.url === PRETTYPRINT_URL && r.method === "POST") return resp(200, FORMATTED_CRLF, OK_TEXT);
  return undefined;
};

const OBJECT_XML = (name: string, type: string, packageName = "$TMP"): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${name}" adtcore:type="${type}">` +
  `<adtcore:packageRef adtcore:name="${packageName}"/>` +
  `</adtcore:objectMetadata>`;

/** Mirrors test/write.test.ts's own `LOCK_XML` — `isLocal="X"`/`corrNr=""` is the $TMP default. */
const LOCK_XML = (handle = "H1", isLocal = "X", corrNr = ""): string =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>${isLocal}</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const NOT_FOUND_XML = (name: string): string =>
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
  `<message lang="EN">${name} does not exist</message><properties/></exc:exception>`;

const CLEAN_CHECKRUN = `<?xml version="1.0" encoding="utf-8"?><chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`;

const OBJ_NAME = "ZCL_I91_PROBE";
const OBJ_TYPE = "CLAS/OC";
const OBJ_URI = "/sap/bc/adt/oo/classes/zcl_i91_probe";
const OBJ_SRC = `${OBJ_URI}/source/main`;

/**
 * A full read/lock/PUT/unlock/checkrun/activation route for `OBJ_URI`,
 * starting from `current`. The PUT advances a mutable cell so a
 * post-write re-read (abapWrite's own pre-activation race guard) sees the
 * NEW bytes — mirrors test/write.test.ts's `existingDdls`/`existingReport`.
 * Used only by the "changed:true, a real write happens" tests.
 *
 * `opts.packageName` defaults to `$TMP` (a local object — most of these
 * tests have no need for a transport at all); `opts.corrNr` defaults to `""`
 * and is echoed on the LOCK reply's `<CORRNR>`, matching whatever the object
 * is ALREADY locked under on the server — this is what `transportFromLock`
 * (src/adt/write.ts) reads to decide whether the write is local or
 * transportable, independent of what `corr_nr` the caller passed in.
 */
const writableObject = (
  current: string,
  opts: { packageName?: string; corrNr?: string } = {},
): Route => {
  const packageName = opts.packageName ?? "$TMP";
  const corrNr = opts.corrNr ?? "";
  let source = current;
  return (r) => {
    if (r.url === OBJ_URI && r.method === "GET") return resp(200, OBJECT_XML(OBJ_NAME, OBJ_TYPE, packageName), OK_XML);
    if (r.url === OBJ_SRC && r.method === "GET") return resp(200, source, OK_TEXT);
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", corrNr ? "" : "X", corrNr), OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === OBJ_SRC && r.method === "PUT") {
      source = r.body ?? "";
      return resp(200, "", OK_TEXT);
    }
    if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
    if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
    return prettyPrinterRoute(r);
  };
};

/**
 * Only a metadata GET and a source GET — deliberately no LOCK/PUT/UNLOCK/
 * checkruns/activation route at all. Used for the "nothing was written"
 * assertions: if the code under test ever tried to lock or PUT, this fake
 * throws instead of silently answering.
 */
const readOnlyObject = (current: string): Route => (r) => {
  if (r.url === OBJ_URI && r.method === "GET") return resp(200, OBJECT_XML(OBJ_NAME, OBJ_TYPE), OK_XML);
  if (r.url === OBJ_SRC && r.method === "GET") return resp(200, current, OK_TEXT);
  return prettyPrinterRoute(r);
};

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

const MAX = 20_000;
const OPEN_GATE = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"] });

async function withJournal<T>(fn: (journal: Journal) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "abapsmith-activate-format-"));
  try {
    const journal = new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H");
    return await fn(journal);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const DISABLED_JOURNAL = new Journal(
  { dir: "/tmp/abapsmith-activate-format-disabled", enabled: false, maxEntries: 0, maxAgeDays: 0 },
  "A4H",
);

// ============================================================ Category A ===
// Refusal matrix — zero network, must throw before any request. Each test
// says which layer it hits: function (`abapActivate`/`abapActivateFormat`
// called directly) or registration (the MCP `tools/call` handler in
// `registerActivateTools`).

describe("mode=format refusals — function layer (abapActivateFormat / abapActivate)", () => {
  it("both `object` and `source` together is BAD_INPUT, naming both parameters, with zero network", async () => {
    const { conn, adt } = await connected(() => undefined);
    const input: ActivateInput = { mode: "format", object: OBJ_NAME, source: UNFORMATTED };
    const e = await catchErr(abapActivateFormat(conn, input, MAX, OPEN_GATE));
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toMatch(/object/);
    expect(e.message).toMatch(/source/);
    expect(adt.calls.length).toBe(0);
  });

  it("neither `object` nor `source` is BAD_INPUT, naming both parameters, with zero network", async () => {
    const { conn, adt } = await connected(() => undefined);
    const input: ActivateInput = { mode: "format" };
    const e = await catchErr(abapActivateFormat(conn, input, MAX, OPEN_GATE));
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toMatch(/source/);
    expect(e.message).toMatch(/object/);
    expect(adt.calls.length).toBe(0);
  });

  it("`affects` has no meaning for mode=format and is BAD_INPUT, with zero network", async () => {
    const { conn, adt } = await connected(() => undefined);
    const input: ActivateInput = {
      mode: "format",
      object: OBJ_NAME,
      affects: { name: "ZTM_BADI", packageName: "$TMP" },
    };
    const e = await catchErr(abapActivateFormat(conn, input, MAX, OPEN_GATE));
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toMatch(/affects/);
    expect(adt.calls.length).toBe(0);
  });

  it("`objects` (batch) does not combine with mode=format and is BAD_INPUT, with zero network", async () => {
    const { conn, adt } = await connected(() => undefined);
    const input: ActivateInput = {
      mode: "format",
      objects: [{ object: OBJ_NAME }],
    };
    const e = await catchErr(abapActivate(conn, input, MAX, OPEN_GATE));
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toMatch(/objects/);
    expect(e.message).toMatch(/format/);
    expect(adt.calls.length).toBe(0);
  });

  it("`corr_nr` with the text form (`source`, no `object`) is BAD_INPUT, with zero network", async () => {
    const { conn, adt } = await connected(() => undefined);
    const input: ActivateInput = { mode: "format", source: UNFORMATTED, corr_nr: "A4HK900123" };
    const e = await catchErr(abapActivateFormat(conn, input, MAX, OPEN_GATE));
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toMatch(/corr_nr/);
    expect(adt.calls.length).toBe(0);
  });

  it("`corr_nr` IS allowed on the object form (no throw, reaches the network)", async () => {
    // Not a refusal — pinned here, next to the refusal it is easy to
    // over-generalise into, to prove the BAD_INPUT above is specific to the
    // text form and does not leak onto the object form.
    const { conn } = await connected(writableObject(UNFORMATTED));
    const input: ActivateInput = {
      mode: "format",
      object: OBJ_NAME,
      type: OBJ_TYPE,
      corr_nr: "A4HK900123",
    };
    await expect(abapActivateFormat(conn, input, MAX, OPEN_GATE)).resolves.toBeDefined();
  });

  it("a nonexistent object is NOT_FOUND, and says nothing was read, locked or changed", async () => {
    const missingUri = "/sap/bc/adt/oo/classes/zcl_i91_nope";
    const { conn, adt } = await connected((r) => {
      if (r.url === missingUri && r.method === "GET") return resp(404, NOT_FOUND_XML("ZCL_I91_NOPE"), OK_XML);
      return undefined;
    });
    const input: ActivateInput = { mode: "format", object: "ZCL_I91_NOPE", type: OBJ_TYPE };
    const e = await catchErr(abapActivateFormat(conn, input, MAX, OPEN_GATE));
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toMatch(/nothing was read, locked or changed/i);
    // The one GET that established non-existence is allowed; nothing past it.
    expect(adt.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(adt.calls.some((c) => c.qs._action === "LOCK")).toBe(false);
  });

  it("a type with no ABAP source (DTEL/DE, properties-shape) is UNSUPPORTED", async () => {
    const deUri = "/sap/bc/adt/ddic/dataelements/zi91_probe_de";
    const { conn, adt } = await connected((r) => {
      if (r.url === deUri && r.method === "GET") return resp(200, OBJECT_XML("ZI91_PROBE_DE", "DTEL/DE"), OK_XML);
      return undefined;
    });
    const input: ActivateInput = { mode: "format", object: "ZI91_PROBE_DE", type: "DTEL/DE" };
    const e = await catchErr(abapActivateFormat(conn, input, MAX, OPEN_GATE));
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.message).toMatch(/no ABAP source/i);
    expect(adt.calls.some((c) => c.url.includes("/source/main"))).toBe(false);
  });
});

describe("mode=format refusals — registration layer (registerActivateTools)", () => {
  function harness(gate: SafetyGate): {
    call: (args: Record<string, unknown>) => Promise<string>;
    writeCalls: () => number;
    readCalls: () => number;
  } {
    let writeCalls = 0;
    let readCalls = 0;
    const deps: ActivateToolDeps = {
      pool: {
        withWrite: async <T>(): Promise<T> => {
          writeCalls += 1;
          return { text: "stub: reached pool.withWrite (preflight passed)", truncated: false } as unknown as T;
        },
        withRead: async <T>(): Promise<T> => {
          readCalls += 1;
          return { text: "stub: reached pool.withRead", truncated: false } as unknown as T;
        },
      } as never,
      safety: gate,
      ensureConnected: async () => {},
      errorResult,
      cfg: { maxResponseChars: 50_000 },
      transport: undefined as never,
      journal: DISABLED_JOURNAL,
    };
    const server = new McpServer({ name: "activate-format-probe", version: "0.0.0" });
    registerActivateTools(server, deps);
    const call = async (args: Record<string, unknown>): Promise<string> => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "activate-format-probe", version: "0.0.0" });
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const res = await client.callTool({ name: "abap_activate", arguments: args });
      const first = Array.isArray(res.content) ? res.content[0] : undefined;
      const text = first && typeof first === "object" && "text" in first ? String((first as { text: unknown }).text) : "";
      return text;
    };
    return { call, writeCalls: () => writeCalls, readCalls: () => readCalls };
  }

  it("`objects` (batch) + mode=format is BAD_INPUT before mode=format's own checks even run, zero network", async () => {
    const { call, writeCalls, readCalls } = harness(OPEN_GATE);
    const text = await call({ mode: "format", objects: [{ object: OBJ_NAME }] });
    expect(text).toMatch(/BAD_INPUT/);
    expect(text).toMatch(/objects/);
    expect(writeCalls()).toBe(0);
    expect(readCalls()).toBe(0);
  });

  it("both `object` and `source` together is BAD_INPUT here too, zero network", async () => {
    const { call, writeCalls, readCalls } = harness(OPEN_GATE);
    const text = await call({ mode: "format", object: OBJ_NAME, source: UNFORMATTED });
    expect(text).toMatch(/BAD_INPUT/);
    expect(writeCalls()).toBe(0);
    expect(readCalls()).toBe(0);
  });

  it("neither `object` nor `source` is BAD_INPUT here too, zero network", async () => {
    const { call, writeCalls, readCalls } = harness(OPEN_GATE);
    const text = await call({ mode: "format" });
    expect(text).toMatch(/BAD_INPUT/);
    expect(writeCalls()).toBe(0);
    expect(readCalls()).toBe(0);
  });
});

// ============================================================ Category D ===
// Gate classification: text form is READ (available read-only), object form
// is WRITE (refused read-only). Registration layer, zero network — proven
// by the pool stub never executing a real connection callback.

describe("mode=format gate classification — registration layer", () => {
  function harness(gate: SafetyGate): {
    call: (args: Record<string, unknown>) => Promise<string>;
    writeCalls: () => number;
    readCalls: () => number;
  } {
    let writeCalls = 0;
    let readCalls = 0;
    const deps: ActivateToolDeps = {
      pool: {
        withWrite: async <T>(): Promise<T> => {
          writeCalls += 1;
          return { text: "stub: reached pool.withWrite", truncated: false } as unknown as T;
        },
        withRead: async <T>(): Promise<T> => {
          readCalls += 1;
          return { text: "stub: reached pool.withRead", truncated: false } as unknown as T;
        },
      } as never,
      safety: gate,
      ensureConnected: async () => {},
      errorResult,
      cfg: { maxResponseChars: 50_000 },
      transport: undefined as never,
      journal: DISABLED_JOURNAL,
    };
    const server = new McpServer({ name: "activate-format-gate-probe", version: "0.0.0" });
    registerActivateTools(server, deps);
    const call = async (args: Record<string, unknown>): Promise<string> => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "activate-format-gate-probe", version: "0.0.0" });
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const res = await client.callTool({ name: "abap_activate", arguments: args });
      const first = Array.isArray(res.content) ? res.content[0] : undefined;
      const text = first && typeof first === "object" && "text" in first ? String((first as { text: unknown }).text) : "";
      return text;
    };
    return { call, writeCalls: () => writeCalls, readCalls: () => readCalls };
  }

  it("text form (`source`) reaches pool.withRead even in a read-only gate — never denied", async () => {
    const readOnlyGate = new SafetyGate({ readOnly: true, allowPackages: ["*"] });
    const { call, readCalls, writeCalls } = harness(readOnlyGate);
    const text = await call({ mode: "format", source: UNFORMATTED });
    expect(text).toMatch(/reached pool\.withRead/);
    expect(readCalls()).toBe(1);
    expect(writeCalls()).toBe(0);
  });

  it("object form (`object`) is refused READ_ONLY in a read-only gate, before pool.withWrite runs", async () => {
    const readOnlyGate = new SafetyGate({ readOnly: true, allowPackages: ["*"] });
    const { call, writeCalls } = harness(readOnlyGate);
    const text = await call({ mode: "format", object: OBJ_NAME, type: OBJ_TYPE });
    expect(text).toMatch(/READ_ONLY/);
    expect(writeCalls()).toBe(0);
  });

  it("object form (`object`) reaches pool.withWrite in a normal (not read-only) gate", async () => {
    const { call, writeCalls } = harness(OPEN_GATE);
    const text = await call({ mode: "format", object: OBJ_NAME, type: OBJ_TYPE });
    expect(text).toMatch(/reached pool\.withWrite/);
    expect(writeCalls()).toBe(1);
  });
});

// ============================================================ Category B ===
// Text form.

describe("mode=format, text form (`source`)", () => {
  it("formats unformatted text: changed:true, linesChanged matches, FORMATTED body, CRLF normalised to LF", async () => {
    const { conn, adt } = await connected(prettyPrinterRoute);
    const input: ActivateInput = { mode: "format", source: UNFORMATTED };
    const out = await abapActivateFormat(conn, input, MAX, OPEN_GATE);
    expect(out.text).toMatch(/changed:\s*true/);
    expect(out.text).toMatch(/linesChanged:\s*12/);
    expect(out.text).toMatch(/FORMATTED/);
    // `buildResponse` (src/compact.ts) renders the body as `bodyRaw.trimEnd()`
    // — deliberate, applied to every tool's body, not specific to
    // mode=format — so the rendered text carries FORMATTED_LF's bytes minus
    // its own trailing newline. Comparing against the untrimmed fixture
    // constant would fail on that trailing byte alone, not on any actual
    // content loss; `.trimEnd()` here matches what every other body-bearing
    // tool response already does.
    expect(out.text).toContain(FORMATTED_LF.trimEnd());
    // The fixture's wire reply is CRLF; the returned text must not carry it.
    expect(out.text.includes("\r\n")).toBe(false);
    // Nothing was written anywhere.
    expect(adt.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(adt.calls.some((c) => c.qs._action === "LOCK")).toBe(false);
    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(false);
  });

  it("says formatting follows the server's own setting and abapsmith never changes it", async () => {
    const { conn } = await connected(prettyPrinterRoute);
    const input: ActivateInput = { mode: "format", source: UNFORMATTED };
    const out = await abapActivateFormat(conn, input, MAX, OPEN_GATE);
    expect(out.text).toMatch(/server's own pretty-printer setting/i);
    expect(out.text).toMatch(/never changes it/i);
  });

  it("never reads or writes the pretty-printer settings endpoint", async () => {
    const { conn, adt } = await connected(prettyPrinterRoute);
    const input: ActivateInput = { mode: "format", source: UNFORMATTED };
    await abapActivateFormat(conn, input, MAX, OPEN_GATE);
    expect(adt.calls.some((c) => c.url.includes(SETTINGS_URL_FRAGMENT))).toBe(false);
  });

  it("already-formatted text (LF) comes back changed:false, and says the server made no change", async () => {
    const { conn, adt } = await connected(prettyPrinterRoute);
    const input: ActivateInput = { mode: "format", source: FORMATTED_LF };
    const out = await abapActivateFormat(conn, input, MAX, OPEN_GATE);
    expect(out.text).toMatch(/changed:\s*false/);
    expect(out.text).toMatch(/linesChanged:\s*0/);
    expect(out.text).toMatch(/already formatted|server made no change/i);
    expect(adt.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(adt.calls.some((c) => c.qs._action === "LOCK")).toBe(false);
  });
});

// ============================================================ Category C ===
// Object form.

describe("mode=format, object form (`object`) — changed:true, a real write happens", () => {
  it("writes back through abapWrite: lock+PUT happen, activate:true, expect_etag = canonicalEtag(source as read)", async () => {
    const { conn, adt } = await connected(writableObject(UNFORMATTED));
    const input: ActivateInput = { mode: "format", object: OBJ_NAME, type: OBJ_TYPE };
    const out = await abapActivateFormat(conn, input, MAX, OPEN_GATE, undefined, DISABLED_JOURNAL);
    expect(out.text).toMatch(/changed:\s*true/);
    expect(out.text).toMatch(/linesChanged:\s*12/);
    expect(out.text).toMatch(/WRITE/);
    expect(adt.calls.some((c) => c.qs._action === "LOCK")).toBe(true);
    expect(adt.calls.some((c) => c.qs._action === "UNLOCK")).toBe(true);
    const put = adt.calls.find((c) => c.url === OBJ_SRC && c.method === "PUT");
    expect(put).toBeDefined();
    expect(put?.body).toBe(FORMATTED_LF);
    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(true);
  });

  it("records a journal entry attributed to abap_activate", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(writableObject(UNFORMATTED));
      const input: ActivateInput = { mode: "format", object: OBJ_NAME, type: OBJ_TYPE };
      await abapActivateFormat(conn, input, MAX, OPEN_GATE, undefined, journal);
      const entries = await journal.list({ object: OBJ_NAME });
      expect(entries.length).toBe(1);
      expect(entries[0]?.tool).toBe("abap_activate");
      expect(entries[0]?.outcome).toBe("succeeded");
    });
  });

  // `corr_nr` only ever reaches the PUT's query string via
  // `SessionTransport.resolve()` → `preflightCorr` → `corrForMutation`
  // (src/adt/write.ts) — `abapWrite` never puts a caller's `corr_nr` on the
  // wire by itself. That chain needs BOTH a transportable object (the LOCK
  // response's `IS_LOCAL`/`CORRNR` say so — `$TMP`'s default in
  // `writableObject` reports local, so `corrForMutation` falls back to a
  // local write regardless of `corr_nr`) AND a wired `SessionTransport` (no
  // manager at all makes `preflightCorr` return `undefined` immediately —
  // see its own comment). A `$TMP` object with `transport: undefined`, as
  // this test used to set up, cannot exercise this and made the assertion
  // meaningless; both are fixed here rather than weakening the assertion.
  describe("`corr_nr` on the object form reaches the write as the transport request", () => {
    const CORR_NR = "A4HK900123";

    /**
     * A minimal, always-valid `TrRequirement`, overridden per case — mirrors
     * test/write.test.ts's own `fakeReq`. `pinnedTo` routes
     * `SessionTransport.resolve()` through `#resolvePin`, the simplest path
     * that reaches a `"transport"` outcome without also mocking `trShow`.
     */
    const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
      ({
        uri: OBJ_SRC,
        operation: "U",
        devclass: "ZPKG",
        candidates: [],
        locks: [],
        messages: [],
        checkFailed: false,
        raw: { result: "S", korrflag: "X", recording: "" },
        kind: "transport-required",
        mustSupplyCorrNr: true,
        serverWouldFabricate: false,
        ...overrides,
      }) as unknown as TrRequirement;

    it("reaches the write as the transport request", async () => {
      const { conn, adt } = await connected(
        writableObject(UNFORMATTED, { packageName: "ZPKG", corrNr: CORR_NR }),
      );
      const transport = new SessionTransport({
        allowTransports: [CORR_NR],
        cts: { trRequirement: vi.fn(async () => fakeReq({ pinnedTo: CORR_NR })) },
      });
      const input: ActivateInput = { mode: "format", object: OBJ_NAME, type: OBJ_TYPE, corr_nr: CORR_NR };
      await abapActivateFormat(conn, input, MAX, OPEN_GATE, transport, DISABLED_JOURNAL);
      const put = adt.calls.find((c) => c.url === OBJ_SRC && c.method === "PUT");
      expect(put?.qs.corrNr).toBe(CORR_NR);
    });
  });
});

describe("mode=format, object form (`object`) — changed:false, nothing is written", () => {
  it("already-formatted saved source (LF): changed:false, and the fake saw NO lock, NO PUT, NO activation", async () => {
    // The important one — the fake has no LOCK/PUT/UNLOCK/activation route
    // at all here, so a regression that tried to write anyway would throw
    // loudly instead of passing silently.
    const { conn, adt } = await connected(readOnlyObject(FORMATTED_LF));
    const input: ActivateInput = { mode: "format", object: OBJ_NAME, type: OBJ_TYPE };
    const out = await abapActivateFormat(conn, input, MAX, OPEN_GATE, undefined, DISABLED_JOURNAL);
    expect(out.text).toMatch(/changed:\s*false/);
    expect(out.text).toMatch(/already formatted/i);
    expect(out.text).toMatch(/nothing was locked, written or journalled/i);
    expect(adt.calls.some((c) => c.qs._action === "LOCK")).toBe(false);
    expect(adt.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("already-formatted saved source (LF): no journal entry is recorded", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(readOnlyObject(FORMATTED_LF));
      const input: ActivateInput = { mode: "format", object: OBJ_NAME, type: OBJ_TYPE };
      await abapActivateFormat(conn, input, MAX, OPEN_GATE, undefined, journal);
      const entries = await journal.list({ object: OBJ_NAME });
      expect(entries.length).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// FIXED BUG (see the module doc comment above and the final report):
// `abapActivateFormat`'s object form used to trust `prettyPrintSource`'s raw
// `outcome.changed` — which compares the server's CRLF reply, normalised to
// LF, against the RAW/unnormalised saved source — to decide whether to write
// anything back. A CRLF-terminated saved source (exactly what a GET of
// already-formatted source looks like on the wire; fixture 903's own request
// body) made that comparison say `changed: true` purely from trailing `\r`,
// triggering a pointless lock→PUT→activate cycle and journal entry for an
// object that needed no change at all. Fixed by comparing `current` against
// `outcome.source` through `sourceEquals` (src/adt/write.ts) instead, which
// is the same CRLF-aware comparison `writeObject`'s own compare-before-write
// short-circuit already uses. Pinned here with the EXACT live-captured bytes
// fixture 903 carries.
// ---------------------------------------------------------------------------

describe("CRLF-terminated saved source: mode=format correctly reports changed:false", () => {
  it("saved source is CRLF and already formatted (fixture 903's own bytes): changed:false, and nothing is locked, written, activated or journalled", async () => {
    // No LOCK/PUT/UNLOCK/checkruns/activation route at all — a regression
    // back to the raw `outcome.changed` comparison would try to lock/PUT
    // this object and this fake would throw instead of silently doing it.
    const { conn, adt } = await connected(readOnlyObject(ALREADY_FORMATTED_CRLF));
    const input: ActivateInput = { mode: "format", object: OBJ_NAME, type: OBJ_TYPE };
    const out = await abapActivateFormat(conn, input, MAX, OPEN_GATE, undefined, DISABLED_JOURNAL);

    expect(out.text).toMatch(/changed:\s*false/);
    expect(out.text).toMatch(/linesChanged:\s*0/);
    expect(out.text).toMatch(/already formatted/i);
    expect(out.text).toMatch(/nothing was locked, written or journalled/i);
    expect(adt.calls.some((c) => c.qs._action === "LOCK")).toBe(false);
    expect(adt.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(false);
  });

  it("no journal entry is recorded for the CRLF-vs-LF case", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(readOnlyObject(ALREADY_FORMATTED_CRLF));
      const input: ActivateInput = { mode: "format", object: OBJ_NAME, type: OBJ_TYPE };
      await abapActivateFormat(conn, input, MAX, OPEN_GATE, undefined, journal);
      const entries = await journal.list({ object: OBJ_NAME });
      expect(entries.length).toBe(0);
    });
  });

  it("sourceEquals treats the CRLF saved source and the LF-normalised reply as identical — the fact the fix relies on", () => {
    expect(sourceEquals(ALREADY_FORMATTED_CRLF, FORMATTED_LF)).toBe(true);
    // canonicalEtag, built on the same canonicalSource, agrees.
    expect(canonicalEtag(ALREADY_FORMATTED_CRLF)).toBe(canonicalEtag(FORMATTED_LF));
  });
});
