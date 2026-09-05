/**
 * Tests for `src/tools/img-edit.ts` — the MCP tool layer (`abap_img_edit`)
 * over `src/adt/img-write.ts`'s three orchestration functions and
 * `src/adt/img-write-policy.ts`'s pure `evaluateImgWrite`.
 *
 * Same harness shape as `test/img-write.test.ts` (a `RecordingClient`
 * implementing `HttpClient` directly, `$ZMCP_HELPERS` already existing so no
 * package-create POST is ever needed, `bridgeHappyPath`-style routing), with
 * one addition: an armed `upsert`/`delete` call deploys and executes TWO
 * bridge classes in one connected session (the probe, then the apply) — see
 * `multiBridgeHappyPath` below, a generalisation of `img-write.test.ts`'s
 * own single-class `bridgeHappyPath` keyed by class name instead of closed
 * over one.
 *
 * Plan validation, ABAP fragment generation, transcript parsing and the
 * deploy/activate/execute wiring itself are already covered in
 * `test/img-write-bridge.test.ts`, `test/customizing-request.test.ts` and
 * `test/img-write.test.ts` (none modified here) — this file only exercises
 * what is unique to the tool layer: argument parsing, the two-phase policy
 * evaluation (`preflightPolicyCheck` then the real `evaluateImgWrite` call),
 * rendering (including the SM30-bypass disclosure appearing on armed output
 * and nowhere in `preview`), and post-hoc journalling of the before-image.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  HttpClientException,
  type HttpClient,
  type HttpClientOptions,
  type HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import type { SessionPool } from "../src/adt/pool.js";
import { errorResult } from "../src/server.js";
import { HELPER_PACKAGE } from "../src/adt/helper-package.js";
import { IMGW_BRIDGE_CLASS } from "../src/adt/img-write-bridge.js";
import { CUSTOMIZING_REQUEST_CLASS } from "../src/adt/customizing-request.js";
import { Journal } from "../src/journal.js";
import { registerImgEditTools, type ImgEditToolDeps } from "../src/tools/img-edit.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ----------------------------------------------------------------------- harness ---

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
): HttpClientResponse => ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

const SESSION_URL = "/sap/bc/adt/compatibility/graph";
const PKG_URI = "/sap/bc/adt/packages/%24zmcp_helpers";

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const PACKAGE_XML = (name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
  `xmlns:adtcore:name="${name}" adtcore:type="DEVC/K">` +
  `<adtcore:packageRef adtcore:name="${name}" adtcore:type="DEVC/K"/>` +
  `<pak:superPackage adtcore:name="$TMP"/>` +
  `</pak:package>`;

/** Base routes every test needs regardless of which bridge class(es) are being deployed: login, the $ZMCP_HELPERS existence GET (already there — no create needed), and the connect-time probes `AbapConnection.connect()` itself makes. */
function baseRoute(o: HttpClientOptions): HttpClientResponse | undefined {
  if (o.url.includes(SESSION_URL)) {
    return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
  }
  if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
  if (o.url === PKG_URI && (o.method ?? "GET").toUpperCase() === "GET") {
    return resp(200, PACKAGE_XML(HELPER_PACKAGE), { "content-type": "application/xml" });
  }
  return undefined;
}

/**
 * Full write -> activate -> classrun happy path, generalised over as many
 * bridge classes as `classRuns` names — unlike `img-write.test.ts`'s own
 * single-class `bridgeHappyPath`, an armed `upsert`/`delete` call here
 * deploys and executes BOTH `IMGW_BRIDGE_CLASS.probe` and `.apply` within
 * one connected session, so the routing has to know both class names at
 * once. A classrun POST for a class name not present in `classRuns` throws
 * loudly rather than falling through to a generic 200 — the whole point of
 * several tests below is that a bridge is or is NOT reached.
 */
function multiBridgeHappyPath(
  classRuns: Record<string, (o: HttpClientOptions) => HttpClientResponse>,
): (o: HttpClientOptions) => HttpClientResponse {
  return (o: HttpClientOptions) => {
    const base = baseRoute(o);
    if (base) return base;
    const qs = (o.qs ?? {}) as Record<string, string>;
    const method = (o.method ?? "GET").toUpperCase();

    if (o.url.startsWith("/sap/bc/adt/oo/classrun/")) {
      const name = o.url.slice("/sap/bc/adt/oo/classrun/".length);
      const handler = classRuns[name];
      if (!handler) {
        throw new Error(`unrouted classrun call for ${name} — this test did not expect it to be reached`);
      }
      return handler(o);
    }
    for (const name of Object.keys(classRuns)) {
      const classUri = `/sap/bc/adt/oo/classes/${name.toLowerCase()}`;
      if (o.url === classUri && method === "GET" && !qs._action) {
        const r = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
        throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
      }
      if (o.url === `${classUri}/source/main` && method === "PUT") {
        return resp(200, "", { "content-type": "text/plain" });
      }
    }
    if (o.url === "/sap/bc/adt/oo/classes" && method === "POST") return resp(200, "", {});
    if (qs._action === "LOCK") return resp(200, LOCK_XML(), { "content-type": "application/xml" });
    if (qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (o.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return resp(200, "<ok/>", { "content-type": "application/xml" });
  };
}

/** A classrun POST that 500s — a scaffold-level failure below activation, activation itself already having succeeded. */
function classrunBlowsUp(o: HttpClientOptions): HttpClientResponse {
  const r = resp(500, "<exc:exception/>", { "content-type": "application/xml" });
  throw new HttpClientException("Request failed with status code 500", "500", 500, undefined, o, r);
}

async function connected(
  route: (o: HttpClientOptions) => HttpClientResponse,
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(route);
  const conn = new AbapConnection(cfg(), { httpClient: inner, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner };
}

/** `writesLockedOut: false` is load-bearing — `evaluateImgWrite`'s own rule 2 treats an UNSET lockout as "not yet proven safe" and refuses, stricter than `SafetyGate` itself (see img-write-policy.ts). */
const openGate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"], writesLockedOut: false });

/** `readOnly: true` trips `evaluateImgWrite`'s rule 3 from the config-only pre-check, before any I/O. */
const readOnlyGate = (): SafetyGate =>
  new SafetyGate({ readOnly: true, allowPackages: [], writesLockedOut: false });

/** A `SessionPool` that just forwards straight onto one wired connection — this repo has no reusable fake pool. */
function fakePool(conn: AbapConnection): SessionPool {
  return {
    withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    withWrite: <T,>(_op: string, _objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    reserveDebug: () => {
      throw new Error("reserveDebug: not used by abap_img_edit, and not implemented in this fake.");
    },
  } as unknown as SessionPool;
}

/** Captures `registerTool` calls into a `Map<name, {config, handler}>` instead of talking to a real MCP client. */
function fakeMcp(): {
  mcp: McpServer;
  tools: Map<string, { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }>;
} {
  const tools = new Map<string, { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }>();
  const mcp = {
    registerTool: (name: string, config: Record<string, unknown>, handler: (args: unknown) => Promise<CallToolResult>) => {
      tools.set(name, { config, handler });
      return {} as unknown;
    },
  } as unknown as McpServer;
  return { mcp, tools };
}

async function invoke(
  tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>,
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  const entry = tools.get(name);
  if (!entry) throw new Error(`tool "${name}" was never registered`);
  return entry.handler(args);
}

function errorPayload(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBe(true);
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return JSON.parse(text.text) as Record<string, unknown>;
}

function okText(result: CallToolResult): string {
  expect(result.isError).toBeFalsy();
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return text.text;
}

/** A `Journal` that never touches disk — `enabled: false` is modelled inside `Journal` itself; used by every test that does not inspect journal entries. */
const disabledJournal = new Journal({ dir: join(tmpdir(), "abapsmith-img-edit-unused"), enabled: false, maxEntries: 1, maxAgeDays: 1 }, "TST");

/** A real `Journal` on a temp directory — needed by any test that reads an entry back off disk, same idiom as `test/activate.test.ts`'s `withJournal`. */
async function withJournal(fn: (j: Journal) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abapsmith-img-edit-journal-"));
  try {
    await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "TST"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function depsFor(
  conn: AbapConnection,
  opts: { safety?: SafetyGate; maxResponseChars?: number; journal?: Journal } = {},
): ImgEditToolDeps {
  const c = cfg();
  return {
    pool: fakePool(conn),
    safety: opts.safety ?? openGate(),
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: opts.maxResponseChars ?? 30_000, language: "EN", sid: c.sid, url: c.url, client: c.client },
    journal: opts.journal ?? disabledJournal,
  };
}

async function registered(
  conn: AbapConnection,
  opts: { safety?: SafetyGate; maxResponseChars?: number; journal?: Journal } = {},
): Promise<{
  tools: Map<string, { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }>;
  deps: ImgEditToolDeps;
}> {
  const { mcp, tools } = fakeMcp();
  const deps = depsFor(conn, opts);
  registerImgEditTools(mcp, deps);
  return { tools, deps };
}

// ----------------------------------------------------------------------- fixtures ---

/** A row `ZKEY=A` that already exists, `ZDESC="Old"`, on a writable (delivery class C, client-dependent) table — the fixture every happy-path test below shares, same naming convention as `test/img-write.test.ts` (table `ZTEST_IMGW`, key `ZKEY`). */
const PROBE_TRANSCRIPT_EXISTING =
  `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
  `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
  `IMGW> FLD table=[ztest_imgw] field=[ZKEY] key=[X] type=[CHAR] len=[10] rollname=[ZKEY]\n` +
  `IMGW> FLD table=[ztest_imgw] field=[ZDESC] key=[] type=[CHAR] len=[40] rollname=[ZDESC]\n` +
  `IMGW> BVAL row=[0] field=[ZKEY] len=[1] value=[A]\n` +
  `IMGW> BVAL row=[0] field=[ZDESC] len=[3] value=[Old]\n` +
  `IMGW> PROBED rows=[1]\n`;

const APPLY_TRANSCRIPT_UPSERT =
  `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
  `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
  `IMGW> BVAL row=[0] field=[ZDESC] len=[3] value=[Old]\n` +
  `IMGW> TRKEY row=[0] trkorr=[A4HK900001] len=[10] value=[A4HK900001]\n` +
  `IMGW> AVAL row=[0] field=[ZDESC] len=[3] value=[New]\n` +
  `IMGW> APPLIED rows=[1]\n`;

const APPLY_TRANSCRIPT_DELETE =
  `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
  `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
  `IMGW> BVAL row=[0] field=[ZDESC] len=[3] value=[Old]\n` +
  `IMGW> TRKEY row=[0] trkorr=[A4HK900001] len=[10] value=[A4HK900001]\n` +
  `IMGW> AABSENT row=[0]\n` +
  `IMGW> APPLIED rows=[1]\n`;

const CREATE_REQUEST_TRANSCRIPT = `CTSW> REQUEST len=[10] value=[A4HK900002]\nCTSW> TASK len=[10] value=[A4HK900003]\n`;

const BASE_ARGS = {
  table: "ZTEST_IMGW",
  key_fields: ["ZKEY"],
  view: "ZTEST_IMGW_V",
  master_type: "VDAT" as const,
  corr_nr: "A4HK900001",
};

// ===========================================================================

describe("abap_img_edit — mode: preview", () => {
  it("renders current vs. prospective rows and a descriptive transport-entry line, never deploying the apply bridge, and omits the SM30-bypass disclosure", async () => {
    const { conn, inner } = await connected(
      multiBridgeHappyPath({ [IMGW_BRIDGE_CLASS.probe]: () => resp(200, PROBE_TRANSCRIPT_EXISTING) }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      ...BASE_ARGS,
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });
    const text = okText(result);

    expect(text).toContain("mode: preview");
    expect(text).toContain("--- CURRENT ROWS ---");
    expect(text).toContain("exists");
    expect(text).toContain("ZDESC=Old");
    expect(text).toContain("--- TRANSPORT ENTRY (DESCRIPTIVE ONLY) ---");
    // Echoed as the probe transcript actually named it (lowercase in this fixture), not re-uppercased.
    expect(text).toContain("TABU ztest_imgw");
    expect(text).toContain("PROSPECTIVE CHANGE");
    expect(text).toContain("SET ZDESC=New");
    // The SM30-bypass note is seeded on every allowed verdict, including preview — but nothing has
    // been written yet, so this module deliberately filters it out of preview's own rendering.
    expect(text).not.toContain("table-maintenance event modules");

    expect(inner.calls.some((c) => c.url.includes(IMGW_BRIDGE_CLASS.probe.toLowerCase()))).toBe(true);
    expect(inner.calls.some((c) => c.url.toLowerCase().includes(IMGW_BRIDGE_CLASS.apply.toLowerCase()))).toBe(false);
  });

  it("a row that does not exist yet is shown as such, not conflated with an existing one", async () => {
    const TRANSCRIPT =
      `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
      `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
      `IMGW> FLD table=[ztest_imgw] field=[ZKEY] key=[X] type=[CHAR] len=[10] rollname=[ZKEY]\n` +
      `IMGW> FLD table=[ztest_imgw] field=[ZDESC] key=[] type=[CHAR] len=[40] rollname=[ZDESC]\n` +
      `IMGW> BABSENT row=[0]\n` +
      `IMGW> PROBED rows=[1]\n`;
    const { conn } = await connected(multiBridgeHappyPath({ [IMGW_BRIDGE_CLASS.probe]: () => resp(200, TRANSCRIPT) }));
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      ...BASE_ARGS,
      rows: [{ key: { ZKEY: "B" }, values: { ZDESC: "New" } }],
    });
    const text = okText(result);

    expect(text).toContain("does not exist yet");
  });
});

// ===========================================================================

describe("abap_img_edit — mode: upsert (armed)", () => {
  it("happy path: deploys probe then apply, discloses the SM30 bypass, and journals a before-image captured from the probe", async () => {
    await withJournal(async (journal) => {
      const { conn, inner } = await connected(
        multiBridgeHappyPath({
          [IMGW_BRIDGE_CLASS.probe]: () => resp(200, PROBE_TRANSCRIPT_EXISTING),
          [IMGW_BRIDGE_CLASS.apply]: () => resp(200, APPLY_TRANSCRIPT_UPSERT),
        }),
      );
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "upsert",
        ...BASE_ARGS,
        confirm: "ZTEST_IMGW",
        rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
      });
      const text = okText(result);

      expect(text).toContain("mode: upsert");
      expect(text).toContain("ROWS WRITTEN");
      expect(text).toContain("--- TRANSPORT ENTRY RECORDED ---");
      expect(text).toContain("A4HK900001");
      expect(text).toContain("table-maintenance event modules");
      expect(text).toMatch(/Journalled as entry/);

      expect(inner.calls.some((c) => c.url.includes(IMGW_BRIDGE_CLASS.probe.toLowerCase()))).toBe(true);
      expect(inner.calls.some((c) => c.url.includes(IMGW_BRIDGE_CLASS.apply.toLowerCase()))).toBe(true);

      const entries = await journal.list({});
      expect(entries).toHaveLength(1);
      const e = entries[0]!;
      expect(e.operation).toBe("update");
      expect(e.object.name).toBe("ZTEST_IMGW");
      expect(e.existedBefore).toBe(true);
      expect(e.beforeCapture).toBe("captured");
      expect(e.outcome).toBe("succeeded");
      const before = await journal.beforeImage(e);
      expect(before).toBeDefined();
      expect(before ?? "").toContain("Old");
    });
  });

  it("delete: journals as a `delete` operation, renders ROWS DELETED", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(
        multiBridgeHappyPath({
          [IMGW_BRIDGE_CLASS.probe]: () => resp(200, PROBE_TRANSCRIPT_EXISTING),
          [IMGW_BRIDGE_CLASS.apply]: () => resp(200, APPLY_TRANSCRIPT_DELETE),
        }),
      );
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "delete",
        ...BASE_ARGS,
        confirm: "ZTEST_IMGW",
        rows: [{ key: { ZKEY: "A" } }],
      });
      const text = okText(result);

      expect(text).toContain("ROWS DELETED");

      const entries = await journal.list({});
      expect(entries).toHaveLength(1);
      expect(entries[0]!.operation).toBe("delete");
      expect(entries[0]!.existedBefore).toBe(true);
    });
  });

  it("confirm-mismatch refuses after the probe already ran but before the apply bridge is ever deployed", async () => {
    const { conn, inner } = await connected(
      multiBridgeHappyPath({ [IMGW_BRIDGE_CLASS.probe]: () => resp(200, PROBE_TRANSCRIPT_EXISTING) }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "upsert",
      ...BASE_ARGS,
      confirm: "SOME_OTHER_NAME",
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });

    expect(errorPayload(result).error).toBe("SAFETY_DENIED");
    expect(inner.calls.some((c) => c.url.includes(IMGW_BRIDGE_CLASS.probe.toLowerCase()))).toBe(true);
    expect(inner.calls.some((c) => c.url.toLowerCase().includes(IMGW_BRIDGE_CLASS.apply.toLowerCase()))).toBe(false);
  });

  it("a BAD_INPUT argument error (missing rows) is thrown before any network call", async () => {
    const { conn, inner } = await connected(
      multiBridgeHappyPath({ [IMGW_BRIDGE_CLASS.probe]: () => resp(200, PROBE_TRANSCRIPT_EXISTING) }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "upsert",
      ...BASE_ARGS,
      confirm: "ZTEST_IMGW",
      rows: [],
    });

    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(inner.calls).toHaveLength(0);
  });
});

// ===========================================================================

describe("abap_img_edit — policy refusal short-circuits before any deploy", () => {
  it("a read-only safety gate refuses at the config-only pre-check, before ensureConnected or any network call", async () => {
    const { conn, inner } = await connected(
      multiBridgeHappyPath({ [IMGW_BRIDGE_CLASS.probe]: () => resp(200, PROBE_TRANSCRIPT_EXISTING) }),
    );
    const { tools } = await registered(conn, { safety: readOnlyGate() });

    const result = await invoke(tools, "abap_img_edit", {
      mode: "upsert",
      ...BASE_ARGS,
      confirm: "ZTEST_IMGW",
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });

    expect(errorPayload(result).error).toBe("SAFETY_DENIED");
    expect(inner.calls).toHaveLength(0);
  });

  it("the same short-circuit applies to preview, not only to armed modes", async () => {
    const { conn, inner } = await connected(
      multiBridgeHappyPath({ [IMGW_BRIDGE_CLASS.probe]: () => resp(200, PROBE_TRANSCRIPT_EXISTING) }),
    );
    const { tools } = await registered(conn, { safety: readOnlyGate() });

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      ...BASE_ARGS,
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });

    expect(errorPayload(result).error).toBe("SAFETY_DENIED");
    expect(inner.calls).toHaveLength(0);
  });
});

// ===========================================================================

describe("abap_img_edit — scaffold-level failure", () => {
  it("the probe bridge's classrun POST 500ing surfaces as an error, not a silent empty preview", async () => {
    const { conn } = await connected(multiBridgeHappyPath({ [IMGW_BRIDGE_CLASS.probe]: classrunBlowsUp }));
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      ...BASE_ARGS,
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });

    expect(result.isError).toBe(true);
  });
});

// ===========================================================================

describe("abap_img_edit — mode: create_request", () => {
  it("mints a customizing request, returns its number, and journals it as `transport-create`", async () => {
    await withJournal(async (journal) => {
      const { conn, inner } = await connected(
        multiBridgeHappyPath({ [CUSTOMIZING_REQUEST_CLASS]: () => resp(200, CREATE_REQUEST_TRANSCRIPT) }),
      );
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "create_request",
        description: "Test customizing request",
        owner: "TESTUSER",
      });
      const text = okText(result);

      expect(text).toContain("mode: create_request");
      expect(text).toContain("A4HK900002");
      expect(text).toContain("A4HK900003");
      expect(inner.calls.some((c) => c.url.includes(CUSTOMIZING_REQUEST_CLASS.toLowerCase()))).toBe(true);

      const entries = await journal.list({});
      expect(entries).toHaveLength(1);
      expect(entries[0]!.operation).toBe("transport-create");
      expect(entries[0]!.object.name).toBe("A4HK900002");
      expect(entries[0]!.existedBefore).toBe(false);
      expect(entries[0]!.beforeCapture).toBe("confirmed-absent");
    });
  });

  it("rejects a row-edit-only field (table) with BAD_INPUT before any network call", async () => {
    const { conn, inner } = await connected(
      multiBridgeHappyPath({ [CUSTOMIZING_REQUEST_CLASS]: () => resp(200, CREATE_REQUEST_TRANSCRIPT) }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "create_request",
      description: "x",
      table: "ZTEST_IMGW",
    });

    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(inner.calls).toHaveLength(0);
  });
});
