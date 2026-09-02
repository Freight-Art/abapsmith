/**
 * The systemKey half of a journal fix. `src/journal.ts:1152`'s `begin()` writes the
 * field CONDITIONALLY:
 *
 *     ...(input.systemKey ? { systemKey: input.systemKey } : {}),
 *
 * so a call site that passes `systemKey: ""` (or any other falsy value)
 * satisfies a static "does this call site mention systemKey" check — the
 * kind `test/journal-systemkey.test.ts` runs — and STILL PERSISTS NOTHING.
 * That static tripwire says so itself: it can prove a call site LOOKS right,
 * not that the byte lands on disk.
 *
 * This file is the behavioural half `write-system-key.test.ts` already is
 * for `abap_write`, applied to `abap_enh`: drive the REAL tool handler over
 * a REAL `AbapConnection` and a REAL `Journal`, then read the PERSISTED
 * `index.jsonl` off disk and parse it — not `journal.list()` (which is fed
 * by the same `readAll()` this file deliberately does not call), not the
 * rendered response text. Two shapes are covered — a `create`-flavoured
 * operation (`create_spot`, no prior GET) and an `update`-flavoured one
 * (`write_description`, the ordinary single-object path) — because
 * `src/tools/enh.ts` has nine independent `begin()` call sites and this is
 * not meant to re-prove the one-line `systemKey: systemKey(conn.cfg)`
 * expression nine times; see write-system-key.test.ts's own header for the
 * identical reasoning applied to abap_write's three call sites.
 *
 * A third, non-`abap_enh` test at the bottom exercises `Journal.begin()`
 * directly with `systemKey: ""` to prove, independently of any tool-layer
 * code, that this suite's assertions (non-empty AND `"systemKey" in entry`)
 * are exactly what catches the conditional-spread trap — not just what a
 * correct call site happens to satisfy.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import type { SessionPool } from "../src/adt/pool.js";
import { errorResult } from "../src/server.js";
import { registerEnhancementTools, type EnhToolDeps } from "../src/tools/enh.js";
import { Journal, systemKey } from "../src/journal.js";
import { BRIDGE_CLASS } from "../src/adt/enhancement-bridge.js";
import { T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Harness — a trimmed, independent copy of test/enhancement-tools.test.ts's
// own (itself copied from enhancement-write.test.ts / fpm-tools.test.ts per
// this codebase's one-small-copy-per-test-file convention). Only what this
// file needs.
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement");
const fixture = (name: string): string => readFileSync(join(FIXTURES_DIR, name), "utf8");

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

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

const DISCOVERY_ENHANCEMENTS_XML = fixture("discovery-enhancements.xml");

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, DISCOVERY_ENHANCEMENTS_XML, OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, OK_XML);
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

const ENHOXHH_URI = "/sap/bc/adt/enhancements/enhoxhh/ZMCP_ENH_B";
const ENHOXHH_XML = (
  JSON.parse(readFileSync(join(FIXTURES_DIR, "138-put-wholedoc-success.meta.json"), "utf8")) as {
    requestBody: string;
  }
).requestBody;

const LOCK_LOCAL_XML =
  `<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">` +
  `<asx:values><DATA><LOCK_HANDLE>84895B18717205C738BE52DAB00DC12609C1821F</LOCK_HANDLE><CORRNR/>` +
  `<CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/>` +
  `<MODIFICATION_SUPPORT>NoModification</MODIFICATION_SUPPORT><SCOPE_MESSAGES/></DATA></asx:values></asx:abap>`;

const LOCK_LOCAL_XML_H =
  `<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">` +
  `<asx:values><DATA><LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/>` +
  `<CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/>` +
  `<MODIFICATION_SUPPORT>NoModification</MODIFICATION_SUPPORT><SCOPE_MESSAGES/></DATA></asx:values></asx:abap>`;

const gate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP"],
    allowEnhancements: true,
    enhanceTargets: "customer",
    originSystems: ["A4H"],
  });

const AFFECTS_HOOK = { name: "ZMCP_BADI_HOST", packageName: "$TMP", masterSystem: "A4H" };
const AFFECTS_SPOT = { name: "ZMCP_SPOT", packageName: "$TMP", masterSystem: "A4H", spotName: "ZMCP_SPOT" };

function fakePool(conn: AbapConnection): SessionPool {
  return {
    withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    withWrite: <T,>(_op: string, _objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    reserveDebug: () => {
      throw new Error("reserveDebug: not used by abap_enh, and not implemented in this fake.");
    },
  } as unknown as SessionPool;
}

function fakeMcp(): {
  mcp: McpServer;
  tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>;
} {
  const tools = new Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>();
  const mcp = {
    registerTool: (name: string, _config: Record<string, unknown>, handler: (args: unknown) => Promise<CallToolResult>) => {
      tools.set(name, { handler });
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

function okText(result: CallToolResult): string {
  expect(result.isError).toBeFalsy();
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return text.text;
}

function localTransport(): SessionTransport {
  const trRequirement = async (
    _conn: AbapConnection,
    uri: string,
    devclass?: string,
  ): Promise<TrRequirement> => ({
    kind: "local",
    mustSupplyCorrNr: false,
    serverWouldFabricate: false,
    uri,
    operation: "U",
    devclass,
    candidates: [],
    locks: [],
    messages: [],
    checkFailed: false,
    raw: { result: "S", korrflag: "", recording: "" },
  });
  return new SessionTransport({ allowTransports: ["*"], cts: { trRequirement } });
}

async function registered(
  conn: AbapConnection,
  journal: Journal,
): Promise<Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>> {
  const { mcp, tools } = fakeMcp();
  const deps: EnhToolDeps = {
    pool: fakePool(conn),
    safety: gate(),
    ensureConnected: async () => {},
    errorResult,
    cfg: {
      maxResponseChars: 30_000,
      user: "DEVELOPER",
      allowEnhancements: true,
      allowSourcePlugins: false,
      allowEnhancementDelete: false,
      abapMode: undefined,
    },
    transport: localTransport(),
    journal,
  };
  registerEnhancementTools(mcp, deps);
  return tools;
}

/** create_spot's classrun bridge choreography — GET-404 -> POST-create -> LOCK -> PUT source ->
 *  UNLOCK -> classrun -> activation. Same shape as enhancement-tools.test.ts's own
 *  `createSpotBridgeRoute`, kept as its own copy per this file's header. */
const CLASS_COLLECTION = "/sap/bc/adt/oo/classes";
function createSpotBridgeRoute(): Route {
  const objUrl = `${CLASS_COLLECTION}/${BRIDGE_CLASS.createSpot.toLowerCase()}`;
  const sourceUri = `${objUrl}/source/main`;
  return (r: Recorded) => {
    if (r.url === objUrl && r.method === "GET" && !r.qs._action) {
      const res = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
      throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, r as unknown as HttpClientOptions, res);
    }
    if (r.url === CLASS_COLLECTION && r.method === "POST") return resp(200, "", {});
    if (r.url === objUrl && r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML_H, OK_XML);
    if (r.url === objUrl && r.qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (r.url === sourceUri && r.method === "PUT") return resp(200, "", { "content-type": "text/plain" });
    if (r.url.startsWith("/sap/bc/adt/oo/classrun/")) return resp(200, "SPOT-OBJECT-CREATED", { "content-type": "text/plain" });
    if (r.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// Reading the PERSISTED bytes — no journal.list(), no readAll(). Every
// `begin()`/`finish()` call appends one JSONL line; later lines for the same
// id override earlier keys (the same rule src/journal.ts's own readAll()
// documents), reproduced independently here rather than delegated to it —
// that independence is the point of a behavioural test over the disk format.
// ---------------------------------------------------------------------------

async function readPersistedEntries(dir: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(dir, "index.jsonl"), "utf8");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  const merged = new Map<string, Record<string, unknown>>();
  for (const line of lines) {
    const id = line.id;
    if (typeof id !== "string" || id === "") continue;
    merged.set(id, { ...(merged.get(id) ?? {}), ...line });
  }
  return [...merged.values()];
}

// ===========================================================================

describe("abap_enh sets systemKey on the journal entries it persists", () => {
  it("create_spot (operation:'create', no prior GET) — the persisted entry carries systemKey(conn.cfg)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abap-enh-syskey-"));
    try {
      const journal = new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H");
      const { conn } = await connected(createSpotBridgeRoute());
      const tools = await registered(conn, journal);

      okText(
        await invoke(tools, "abap_enh", {
          operation: "create_spot",
          name: "ZMCP_SPOT",
          spec: { description: "A spot" },
          affects: AFFECTS_SPOT,
        }),
      );

      const entries = await readPersistedEntries(dir);
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;

      // The trap this exists to catch: `journal.ts:1152` spreads `systemKey`
      // in ONLY when it is truthy, so `systemKey: ""` at the call site
      // produces an entry with NO `systemKey` KEY AT ALL — `.toBeUndefined()`
      // would pass on that pathological entry just as happily as on a
      // correct one. `"systemKey" in entry` fails on the pathological entry
      // and only the pathological entry, which is why it is asserted
      // separately from the value check below.
      expect("systemKey" in entry).toBe(true);
      expect(entry.systemKey).toBeTypeOf("string");
      expect(entry.systemKey).not.toBe("");
      expect(entry.systemKey).toBe(systemKey(conn.cfg));

      expect(entry.system).toBe("A4H");
      expect(entry.operation).toBe("create");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("write_description (operation-less, 'update' path) — the persisted entry carries systemKey(conn.cfg)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abap-enh-syskey-"));
    try {
      const journal = new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H");
      const { conn } = await connected((r) => {
        if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
        if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
        if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
        if (r.url === ENHOXHH_URI && r.method === "PUT") return resp(200, "", { etag: "NEWETAG123=" });
        return undefined;
      });
      const tools = await registered(conn, journal);

      okText(
        await invoke(tools, "abap_enh", {
          type: "ENHO/XHH",
          name: "ZMCP_ENH_B",
          description: "a new description",
          affects: AFFECTS_HOOK,
        }),
      );

      const entries = await readPersistedEntries(dir);
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;

      expect("systemKey" in entry).toBe(true);
      expect(entry.systemKey).toBeTypeOf("string");
      expect(entry.systemKey).not.toBe("");
      expect(entry.systemKey).toBe(systemKey(conn.cfg));

      expect(entry.system).toBe("A4H");
      expect(entry.operation).toBe("update");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Not abap_enh — a direct, tool-layer-free proof that the assertions above
  // are shaped correctly. If any `begin()` caller (in enh.ts or anywhere
  // else) ever regresses to `systemKey: ""`, this is what that looks like on
  // disk: no exception, no falsy-but-present value — the KEY ITSELF is
  // missing, because journal.ts:1152 never spreads it in. A bare
  // `expect(entry.systemKey).toBeFalsy()`-style guard would not catch this
  // (both "field absent" and "field present but empty" are falsy); the `"systemKey"
  // in entry` check above is what distinguishes them, and this test proves
  // why that distinction is necessary.
  it("reproduces the journal.ts:1152 trap directly: Journal.begin() with systemKey:\"\" persists no systemKey key at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abap-enh-syskey-trap-"));
    try {
      const journal = new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H");
      await journal.begin({
        operation: "update",
        object: { name: "ZTRAP", type: "ENHO/XHH", uri: "/sap/bc/adt/enhancements/enhoxhh/ZTRAP", package: "$TMP" },
        existedBefore: false,
        systemKey: "", // the exact defect this file exists to catch
      });

      const entries = await readPersistedEntries(dir);
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;

      // This IS the trap: the field is entirely absent, not present-and-empty.
      expect("systemKey" in entry).toBe(false);
      expect(entry.systemKey).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
