/**
 * Tightening `isAddressableAbapObjectName` left `parseObjectRef`'s
 * `PARENT/NAME` split reachable only when a hint carries a `parentPath` —
 * `preflight()`/`writeGateKey()` (src/tools/preflight.ts) called it with none,
 * so `abap_write({object:"ZTMD_HS386_FG/ZTMD_HS386_FM", type:"FUGR/FF"})` was
 * refused BAD_INPUT even though `resolveWriteTarget` itself handles the split
 * fine once it gets a hinted parse. No test exercised the slash form at all;
 * 6455 tests passed over the broken path. This file closes that hole.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { registerWriteTools, type WriteToolDeps } from "../src/tools/write.js";
import { preflight, writeGateKey } from "../src/tools/preflight.js";
import { errorResult } from "../src/server.js";
import { SafetyGate } from "../src/safety.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const NAME = "ZTMD_HS386_FM";
const GROUP = "ZTMD_HS386_FG";
const SLASH_FORM = `${GROUP}/${NAME}`;
const TYPE = "FUGR/FF";

// ---------------------------------------------------------------------------
// End-to-end harness: a real registered `abap_write` tool, called through
// InMemoryTransport, with `deps.pool.withWrite` recording its gate key and
// then actually invoking `fn` against a fake ADT HTTP layer — not a stub
// that only counts reachability. A unit test on `parseObjectRef` alone would
// have passed on the broken build; this would not have.
// ---------------------------------------------------------------------------

const GROUP_URI = "/sap/bc/adt/functions/groups/ztmd_hs386_fg";
const FM_URI = `${GROUP_URI}/fmodules/ztmd_hs386_fm`;

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">${NAME} does not exist</message><properties/></exc:exception>`;
const CLEAN_CHECKRUN = `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`;
const LOCK_XML = `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL>` +
  `<IS_LINK_UP/><MODIFICATION_SUPPORT/></DATA></asx:values></asx:abap>`;

interface Recorded {
  method: string;
  url: string;
  qs: Record<string, string>;
}

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: (r: Recorded) => HttpClientResponse | undefined) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const rec: Recorded = {
      method: (o.method ?? "GET").toUpperCase(),
      url: o.url,
      qs: (o.qs ?? {}) as Record<string, string>,
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
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

/** Function module does not exist yet: create-under-group path. */
function fmRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url === FM_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
  if (r.url === `${GROUP_URI}/fmodules` && r.method === "POST") return resp(200, "", {});
  if (r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
  if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
  if (r.url === `${FM_URI}/source/main` && r.method === "PUT") return resp(200, "", OK_TEXT);
  if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
  return undefined;
}

async function harness() {
  const adt = new FakeAdt((r) => baseRoute(r) ?? fmRoute(r));
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

  const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
  const assertCalls: Array<Parameters<typeof gate.assert>> = [];
  const realAssert = gate.assert.bind(gate);
  vi.spyOn(gate, "assert").mockImplementation((...args: Parameters<typeof gate.assert>) => {
    assertCalls.push(args);
    return realAssert(...args);
  });

  const gateKeys: Array<string | undefined> = [];
  const deps: WriteToolDeps = {
    pool: {
      withWrite: async <T>(
        _tool: string,
        gateKey: string | undefined,
        fn: (conn: AbapConnection) => Promise<T>,
      ): Promise<T> => {
        gateKeys.push(gateKey);
        return fn(conn);
      },
    } as never,
    safety: gate,
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 50_000 },
    journal: undefined as never,
    transport: undefined as never,
  };
  const server = new McpServer({ name: "slash-form-probe", version: "0.0.0" });
  registerWriteTools(server, deps);

  const call = async (args: Record<string, unknown>): Promise<string> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "slash-form-probe", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const res = await client.callTool({ name: "abap_write", arguments: args });
    const first = Array.isArray(res.content) ? res.content[0] : undefined;
    return first && typeof first === "object" && "text" in first
      ? String((first as { text: unknown }).text)
      : "";
  };

  return { call, adt, gateKeys, assertCalls };
}

describe("abap_write end to end: PARENT/NAME slash form for a function module", () => {
  it("is not refused BAD_INPUT, gates on the bare name, and creates under the group", async () => {
    const { call, adt, gateKeys, assertCalls } = await harness();
    const text = await call({
      object: SLASH_FORM,
      type: TYPE,
      source: "FUNCTION ztmd_hs386_fm.\nENDFUNCTION.\n",
      activate: false,
    });

    expect(text).not.toMatch(/BAD_INPUT/);
    expect(text).toMatch(/created:\s*true/);

    expect(gateKeys).toEqual([NAME]);

    expect(assertCalls.length).toBeGreaterThan(0);
    const seenNames = assertCalls.map((args) => (args[1] as { name?: string } | undefined)?.name);
    expect(seenNames.every((n) => n === NAME)).toBe(true);
    expect(seenNames).not.toContain(SLASH_FORM);

    const create = adt.calls.find((c) => c.method === "POST" && c.url.endsWith("/fmodules"));
    expect(create).toBeDefined();
    expect(adt.calls.some((c) => c.method === "PUT" && c.url === `${FM_URI}/source/main`)).toBe(
      true,
    );
  });
});

describe("preflight() on the slash form", () => {
  // This also failed on master: the gate evaluated "ZTMD_HS386_FG/ZTMD_HS386_FM"
  // (not the object's own name) because preflight() parsed the ref with no hint.
  it("resolves to the bare name, not the slash string", () => {
    expect(preflight({ object: SLASH_FORM, type: TYPE }).name).toBe(NAME);
  });
});

describe("writeGateKey() on the slash form", () => {
  it("resolves to the bare, upper-cased name", () => {
    expect(writeGateKey(SLASH_FORM, TYPE)).toBe(NAME);
  });

  it("agrees with the bare-name spelling — one module, one gate slot", () => {
    expect(writeGateKey(SLASH_FORM, TYPE)).toBe(writeGateKey("ztmd_hs386_fm", TYPE));
  });

  // Not `undefined`: parseObjectRef throws BAD_INPUT on an empty ref before
  // writeGateKey's own `name.length > 0 ? name : undefined` fallback is ever
  // reached — that fallback has no reachable caller. `undefined` gate keys
  // in practice come from the batch-delete call site passing it literally,
  // not from writeGateKey("").
  it("throws BAD_INPUT, not undefined, for a nameless input", () => {
    expect(() => writeGateKey("", TYPE)).toThrow(AbapError);
    try {
      writeGateKey("", TYPE);
      expect.unreachable();
    } catch (e) {
      expect(isAbapError(e)).toBe(true);
      expect((e as { code: string }).code).toBe("BAD_INPUT");
    }
  });
});

describe("the grammar is not re-admitted by the FUGR/FF hint", () => {
  const rejectsBadInput = (fn: () => unknown) => {
    try {
      fn();
      expect.unreachable(`expected ${fn} to throw`);
    } catch (e) {
      expect(isAbapError(e)).toBe(true);
      expect((e as { code: string }).code).toBe("BAD_INPUT");
    }
  };

  it.each(["_FOO", "ZFOO/", "/DMO/$FOO"])("rejects %j via preflight(), hinted", (name) => {
    rejectsBadInput(() => preflight({ object: name, type: TYPE }));
  });

  it.each(["_FOO", "ZFOO/", "/DMO/$FOO"])("rejects %j via writeGateKey(), hinted", (name) => {
    rejectsBadInput(() => writeGateKey(name, TYPE));
  });

  it.each(["_FOO", "/DMO/$FOO"])("rejects %j via preflight(), unhinted", (name) => {
    rejectsBadInput(() => preflight({ object: name }));
  });

  it.each(["_FOO", "/DMO/$FOO"])("rejects %j via writeGateKey(), unhinted", (name) => {
    rejectsBadInput(() => writeGateKey(name));
  });

  it("accepts $FOO, hinted and unhinted", () => {
    expect(preflight({ object: "$FOO", type: TYPE }).name).toBe("$FOO");
    expect(preflight({ object: "$FOO" }).name).toBe("$FOO");
    expect(writeGateKey("$FOO", TYPE)).toBe("$FOO");
    expect(writeGateKey("$FOO")).toBe("$FOO");
  });
});
