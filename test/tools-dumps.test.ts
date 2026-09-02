/**
 * `abap_dumps` — the tool surface over `src/adt/dumps.ts`, and the two-tier
 * PII gate that is the whole reason this tool is shaped the way it is.
 *
 * The gate is pinned in BOTH directions and at BOTH layers, because either
 * layer alone is a hole:
 *
 *   - REGISTRATION. With `canReadDumpVariables` false the `variables`
 *     property does not exist in `tools/list`, and no string anywhere in the
 *     advertised tool mentions variable values. A tool that is present and
 *     refusing can be argued with, prompt-injected into, and reported to a
 *     user as "the server said no"; a field that was never advertised cannot.
 *   - HANDLER. A schema binds only a client that read it. Both hand-crafted
 *     routes to the same bytes — `{"variables":true}` and the sideways
 *     `{"chapters":"kap10"}`, which never names the flag — are exercised
 *     against the registration that does not advertise the field, and both
 *     must be refused with the same `DUMP_VARIABLES_DISABLED` before any DUMP
 *     RESOURCE is fetched. Not "before any request": `ensureConnected()` runs
 *     first and issues SEVERAL ADT probes of its own — the logon handshake,
 *     discovery, the system-role probe, the ATO settings read — whose exact
 *     set is connect-flow implementation detail and may change. What the
 *     refusal guarantees is that the feed, the detail document and above all
 *     the ~193 KB `/formatted` body — the only carrier of variable values —
 *     are never asked for. The tests below assert that by FILTERING the
 *     transport log for `/runtime/dump…`, never by expecting an empty log,
 *     and the filter is proved to see what it is looking for by the
 *     positive control: the gate-ON show asserts the `/formatted` URL IS
 *     recorded, so `[]` on a refused call is a real absence rather than a
 *     logging blind spot. Live, a request-logging stub shows the same pair.
 *
 * THREE harnesses, and the third one is not optional. `test/tools.test.ts`
 * shows the pattern for the first two; the third exists because of a defect
 * these two could not see:
 *
 *   - `listedTools()` — the REAL server over an in-memory MCP transport. The
 *     only thing that can answer "what does `tools/list` actually say".
 *   - `harness()` — a capturing fake `McpServer`. The only thing that can
 *     invoke the handler with arguments the advertised schema would reject,
 *     and the only place `pool`/transport calls can be counted per call. It
 *     calls the handler DIRECTLY.
 *   - `sdkHarness()` — the real server AND a real MCP client, so a call goes
 *     through the SDK's own argument validation on the way in. This is the
 *     gap: the tool was registered with a raw zod shape, the SDK wrapped it in
 *     a STRIPPING `z.object`, and a hand-crafted `{"variables":true}` against
 *     a server with the capability off was DELETED before the handler ran. The
 *     `harness()` tests below stayed green throughout — they never crossed the
 *     validation layer — while the live call returned exit 0, `isError:false`
 *     and output identical to a plain tier-1 show. No bytes leaked; the
 *     contract did. Any future test of this gate must cross `sdkHarness()`.
 *
 * No network. Every response byte comes from `test/fixtures/dumps/`, captured
 * off A4H on 2026-08-11, and the transport is the house fake from
 * `test/dumps.test.ts` — recording, so a test can assert on the ABSENCE of a
 * request as well as on its arguments.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { ConfigSchema, resolveStaticCapabilities, type Config } from "../src/config.js";
import { createServer, errorResult, type AbapsmithServer } from "../src/server.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate } from "../src/safety.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type { SessionPool } from "../src/adt/pool.js";
import { DUMPS_FEED_PATH, VARIABLES_CHAPTER_NAME, parseDumpFeed } from "../src/adt/dumps-xml.js";
import { FEEDS_CATALOG_PATH } from "../src/adt/dumps.js";
import {
  registerDumpTools,
  dumpsInputShape,
  dumpsInputSchema,
  type DumpsToolDeps,
} from "../src/tools/dumps.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

// ------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "dumps");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const FEED_TOP3 = parseDumpFeed(fixture("feed-top3-next.xml"));
/** Never typed by hand: the key is taken out of the feed's own entry link. */
const KEY = FEED_TOP3.entries[0]?.key ?? "";
const DETAIL_PATH = `/sap/bc/adt/runtime/dump/${KEY}`;

// ------------------------------------------------------------ transport ---

interface Call {
  url: string;
  headers: Record<string, string>;
}

type Reply = { body: string; status?: number };

/**
 * Routes by SHAPE rather than by exact captured path: the tool composes its
 * own feed URL from `max`/`from`/`to`, so pinning the byte-exact query string
 * here would only re-assert what `test/dumps.test.ts` already checks against
 * the sidecars. What this file needs from the transport is which RESOURCE was
 * asked for, and whether it was asked for at all.
 */
function router(feedBody: string): (url: string) => Reply {
  return (url: string): Reply => {
    if (url === FEEDS_CATALOG_PATH) return { body: fixture("feeds-catalog.xml") };
    if (url.startsWith(DUMPS_FEED_PATH)) return { body: feedBody };
    if (url === `${DETAIL_PATH}/formatted`) return { body: fixture("dump-formatted.txt") };
    if (url === DETAIL_PATH) return { body: fixture("dump-detail-v1.xml") };
    throw new Error(`the fake transport was asked for an uncaptured URL: ${url}`);
  };
}

interface Harness {
  invoke: (args: unknown) => Promise<CallToolResult>;
  /** Every `pool.withRead` this handler made. Empty means no read was issued. */
  poolCalls: string[];
  /** Every URL the transport was asked for. Empty means nothing left the process. */
  urls: string[];
  audit: string[];
  toolConfig: Record<string, unknown>;
}

interface HarnessOpts {
  /** Advertise the tier-2 field? `resolveStaticCapabilities(cfg).canReadDumpVariables`. */
  registerVariables?: boolean;
  /** The runtime gate. Deliberately settable INDEPENDENTLY of the line above. */
  allowDumpVariables?: boolean;
  feed?: string;
  maxResponseChars?: number;
}

function harness(opts: HarnessOpts = {}): Harness {
  const poolCalls: string[] = [];
  const urls: string[] = [];
  const audit: string[] = [];
  const handler = router(opts.feed ?? fixture("feed-top3-next.xml"));

  const conn = {
    async get(url: string, o: { headers?: Record<string, string> } = {}) {
      urls.push(url);
      const reply = handler(url);
      return { body: reply.body, status: reply.status ?? 200, headers: {} };
    },
  } as unknown as AbapConnection;

  const pool = {
    withRead: <T,>(op: string, fn: (c: AbapConnection) => Promise<T>) => {
      poolCalls.push(op);
      return fn(conn);
    },
  } as unknown as SessionPool;

  const deps: DumpsToolDeps = {
    pool,
    safety: new SafetyGate({
      readOnly: true,
      allowPackages: [],
      writesLockedOut: false,
      ...(opts.allowDumpVariables === undefined ? {} : { allowDumpVariables: opts.allowDumpVariables }),
    }),
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: opts.maxResponseChars ?? 60_000 },
    ...(opts.registerVariables === undefined ? {} : { registerVariables: opts.registerVariables }),
    log: (m) => void audit.push(m),
  };

  const { mcp, tools } = fakeMcp();
  registerDumpTools(mcp, deps);
  const entry = tools.get("abap_dumps");
  if (!entry) throw new Error("abap_dumps was never registered");
  return { invoke: entry.handler, poolCalls, urls, audit, toolConfig: entry.config };
}

/** Captures `registerTool` into a map instead of talking to an MCP client. */
function fakeMcp(): {
  mcp: McpServer;
  tools: Map<string, { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }>;
} {
  const tools = new Map<
    string,
    { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }
  >();
  const mcp = {
    registerTool: (
      name: string,
      config: Record<string, unknown>,
      handler: (args: unknown) => Promise<CallToolResult>,
    ) => {
      tools.set(name, { config, handler });
      return {} as unknown;
    },
  } as unknown as McpServer;
  return { mcp, tools };
}

const okText = (res: CallToolResult): string => {
  expect(res.isError).toBeFalsy();
  const part = res.content[0];
  if (!part || part.type !== "text") throw new Error("expected a text content part");
  return part.text;
};

const errorPayload = (res: CallToolResult): Record<string, unknown> => {
  expect(res.isError).toBe(true);
  const part = res.content[0];
  if (!part || part.type !== "text") throw new Error("expected a text content part");
  return JSON.parse(part.text) as Record<string, unknown>;
};

// --------------------------------------------------------- real server ---

const cfg = (over: Partial<Config> = {}): Config => ({
  ...ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
  }),
  ...over,
});

/** A transport that must never be reached — `tools/list` costs zero requests. */
class ForbiddenClient implements Partial<HttpClient> {
  request(_o: HttpClientOptions): Promise<HttpClientResponse> {
    throw new Error("NETWORK CALL LEAKED: listing tools must not touch the wire");
  }
}

async function listedTools(config: Config): Promise<Tool[]> {
  const srv: AbapsmithServer = createServer(config, {
    httpClient: routeSystemRoleProbe(new ForbiddenClient() as unknown as HttpClient, {
      answer: "nonproductive",
    }),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

const dumpsTool = async (config: Config): Promise<Tool> => {
  const tool = (await listedTools(config)).find((t) => t.name === "abap_dumps");
  if (!tool) throw new Error("abap_dumps is not in tools/list");
  return tool;
};

// ------------------------------------------- real server + real MCP client ---

/**
 * Records every URL that reaches the transport and answers the dump fixtures.
 *
 * Everything it does not recognise — the logon handshake, discovery, the §10.4
 * system-role probe, the ATO settings read — gets a bare 200, because this
 * harness is not here to test the connection. Those probes DO get logged, and
 * that is the point: `urls` is never expected to be empty. It is filtered for
 * dump RESOURCES (`/runtime/dump…`) so the "nothing was fetched" claim is made
 * about the only thing it is actually true of, and the gate-ON test asserts a
 * `/formatted` URL IS present so the filter is known to be able to see one.
 */
class RecordingClient implements HttpClient {
  readonly urls: string[] = [];
  constructor(private readonly fixtureFor: (url: string) => string | undefined) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const url = String(o.url ?? "");
    this.urls.push(url);
    const body = this.fixtureFor(url);
    return {
      status: 200,
      statusText: "200",
      body: body ?? "ok",
      headers: {
        "content-type": body === undefined ? "text/plain" : "application/xml",
        "x-csrf-token": "TOKEN",
      },
    } as unknown as HttpClientResponse;
  }
}

/** The dump resources, and nothing else. `[]` means no dump was ever fetched. */
const dumpResourceUrls = (urls: readonly string[]): string[] =>
  urls.filter((u) => u.includes("/runtime/dump"));

interface SdkHarness {
  call: (args: Record<string, unknown>) => Promise<CallToolResult>;
  /** Every URL the transport saw, handshake included. */
  urls: string[];
  tool: Tool;
  close: () => Promise<void>;
}

/**
 * The real `createServer` behind a real `Client` over `InMemoryTransport` — the
 * same wiring `test/tools.test.ts` uses to obtain genuine `listTools()` output,
 * extended to `callTool()`.
 *
 * A call made through this harness is validated by the SDK against the schema
 * the tool was REGISTERED with before the handler sees it. That layer is where
 * the silent-strip defect lived, so it is the only layer that can prove the
 * fix.
 */
async function sdkHarness(config: Config): Promise<SdkHarness> {
  const routes = router(fixture("feed-top3-next.xml"));
  const http = new RecordingClient((url) => {
    try {
      return routes(url).body;
    } catch {
      return undefined; // not a dump URL: handshake, discovery, the §10.4 probe
    }
  });
  const srv: AbapsmithServer = createServer(config, {
    httpClient: routeSystemRoleProbe(http as unknown as HttpClient, { answer: "nonproductive" }),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);
  const tool = (await client.listTools()).tools.find((t) => t.name === "abap_dumps");
  if (!tool) throw new Error("abap_dumps is not in tools/list");
  return {
    call: async (args) =>
      (await client.callTool({ name: "abap_dumps", arguments: args })) as unknown as CallToolResult,
    urls: http.urls,
    tool,
    close: () => client.close(),
  };
}

/** The text of a single-part result, whatever its `isError`. */
const textOf = (res: CallToolResult): string => {
  const part = res.content[0];
  if (!part || part.type !== "text") throw new Error("expected a text content part");
  return part.text;
};

// ===========================================================================
// TIER 2, LAYER 1 — the advertised schema
// ===========================================================================

describe("the variables field is advertised only where the operator enabled it", () => {
  it("the default config does not enable it, and it is not derived from writes", () => {
    expect(cfg().allowDumpVariables).toBe(false);
    expect(resolveStaticCapabilities(cfg()).canReadDumpVariables).toBe(false);
    // The inversion this flag exists to avoid: enabling writes must not hand
    // out production field values, and a read-only server must still be able
    // to be granted them.
    expect(resolveStaticCapabilities(cfg({ readOnly: false })).canReadDumpVariables).toBe(false);
    expect(resolveStaticCapabilities(cfg({ allowDumpVariables: true })).canReadDumpVariables).toBe(true);
    expect(resolveStaticCapabilities(cfg({ allowDumpVariables: true })).canWrite).toBe(false);
  });

  it("dumpsInputShape() omits the property entirely rather than refusing it", () => {
    expect(Object.keys(dumpsInputShape())).not.toContain("variables");
    expect(Object.keys(dumpsInputShape({ variables: false }))).not.toContain("variables");
    expect(Object.keys(dumpsInputShape({ variables: true }))).toContain("variables");
  });

  it("the registered schema is LOOSE, and that is what keeps the handler gate alive", () => {
    // `registerTool` wraps a raw shape in a STRIPPING object, which deleted a
    // hand-crafted `variables:true` before the handler could refuse it. The
    // registered schema is therefore built here, explicitly, and loose.
    const off = dumpsInputSchema();
    expect(Object.keys(off.shape)).not.toContain("variables");
    // Loose = unknown keys survive validation and reach the handler.
    const parsed = off.parse({ mode: "show", key: "K", variables: true });
    expect(parsed).toMatchObject({ variables: true });
    // …and the tier-2 surface still differs from the tier-1 one by exactly the
    // one property, so "loose" has not quietly become "the same schema twice".
    expect(Object.keys(dumpsInputSchema({ variables: true }).shape)).toContain("variables");
  });

  it("the un-opted registration offers variable values NOWHERE in its advertised text", async () => {
    const tool = await dumpsTool(cfg());
    const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
    expect(Object.keys(props)).not.toContain("variables");
    // Not merely "no such field": no PARAMETER an agent could read as an offer,
    // and nothing it could quote back as "the server refused".
    const parameterText = JSON.stringify(props);
    expect(parameterText).not.toMatch(/variable/i);
    expect(parameterText).not.toMatch(/kap10/i);
    expect(parameterText).not.toMatch(/Selected Variables/i);

    // The tool DESCRIPTION does still say that dumps carry live field values
    // "in the variable chapters", and that is deliberate (§5.1): it is written
    // as a fact about ST22 dumps, true in every deployment, and it is what
    // makes the closing clause — "nothing else unless the operator enabled
    // more" — mean anything. It offers nothing: there is no field to set, no
    // value to pass, and no name for the flag.
    const description = tool.description ?? "";
    expect(description).toMatch(/nothing else unless the operator enabled more/);
    expect(description).not.toMatch(/kap10|Selected Variables|variables:|ABAP_ALLOW_DUMP_VARIABLES/);
  });

  it("the opted-in registration advertises it, and says what it costs", async () => {
    const tool = await dumpsTool(cfg({ allowDumpVariables: true }));
    const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
    expect(Object.keys(props)).toContain("variables");
    expect(props.variables?.description ?? "").toMatch(/real business data, permanently/i);
  });

  it("tier 1 is registered on a read-only server, and is not a mutating tool", async () => {
    const names = (await listedTools(cfg())).map((t) => t.name);
    expect(names).toContain("abap_dumps");
    const tool = await dumpsTool(cfg());
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.annotations?.destructiveHint).toBe(false);
  });

  it("the tool description carries the 8-day window", async () => {
    const description = (await dumpsTool(cfg())).description ?? "";
    expect(description).toMatch(/8 DAYS ONLY/);
    expect(description).toMatch(/no dumps in the last 8 days matching this filter/i);
    expect(description).toMatch(/VERBATIM/);
  });

  it("the silent-ignore trap lives in doc/TOOLS/diagnostics.md and query's own description, not the tool description", async () => {
    // §abap_dumps in doc/TOOLS/diagnostics.md already states: "The server answers an
    // unrecognized filter with HTTP 200 and the full unfiltered feed rather
    // than an error, so this tool validates filters itself before sending."
    // The tool-level description no longer repeats the why; the query
    // parameter still states the precondition a caller can act on.
    const tool = await dumpsTool(cfg());
    const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
    expect(props.query?.description ?? "").toMatch(/Validated locally before sending/);
  });
});

// ===========================================================================
// TIER 2, LAYER 2 — the handler, against a schema the client never read
// ===========================================================================

describe("the handler refuses tier 2 even when the schema never offered it", () => {
  it('a hand-crafted {"variables":true} is refused, and no request is issued', async () => {
    const h = harness({ registerVariables: false, allowDumpVariables: false });
    const res = await h.invoke({ mode: "show", key: KEY, variables: true });
    const payload = errorPayload(res);
    expect(payload.error).toBe("DUMP_VARIABLES_DISABLED");
    expect(h.poolCalls).toEqual([]);
    expect(h.urls).toEqual([]);
  });

  it("the sideways route — chapters:\"kap10\", which never names the flag — is refused too", async () => {
    const h = harness({ registerVariables: false, allowDumpVariables: false });
    const res = await h.invoke({ mode: "show", key: KEY, chapters: VARIABLES_CHAPTER_NAME });
    expect(errorPayload(res).error).toBe("DUMP_VARIABLES_DISABLED");
    expect(h.urls).toEqual([]);
  });

  it("case does not launder it: chapters:\"KAP10\" is the same request", async () => {
    const h = harness({ registerVariables: false, allowDumpVariables: false });
    const res = await h.invoke({ mode: "show", key: KEY, chapters: "kap7,KAP10" });
    expect(errorPayload(res).error).toBe("DUMP_VARIABLES_DISABLED");
    expect(h.urls).toEqual([]);
  });

  it("the refusal carries no dump key, no chapter text and no variable name", async () => {
    const h = harness({ registerVariables: false, allowDumpVariables: false });
    const res = await h.invoke({ mode: "show", key: KEY, variables: true });
    const raw = JSON.stringify(errorPayload(res));
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain(VARIABLES_CHAPTER_NAME);
  });

  it("advertising it is NOT permission: the runtime gate still decides", async () => {
    // The two flags are set from the same config in `server.ts`, so this
    // combination cannot occur there. It is asserted anyway: it is exactly
    // what a future refactor that "simplifies" one of the two layers away
    // would produce, and the surviving layer must still hold.
    const h = harness({ registerVariables: true, allowDumpVariables: false });
    const shape = (h.toolConfig.inputSchema as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape)).toContain("variables");
    const res = await h.invoke({ mode: "show", key: KEY, variables: true });
    expect(errorPayload(res).error).toBe("DUMP_VARIABLES_DISABLED");
    expect(h.urls).toEqual([]);
  });

  it("with the flag on, the variable chapter is fetched and returned", async () => {
    const h = harness({ registerVariables: true, allowDumpVariables: true });
    const text = okText(await h.invoke({ mode: "show", key: KEY, variables: true }));
    expect(text).toMatch(/chapters_shown: .*kap10/);
    expect(h.urls).toContain(DETAIL_PATH);
    expect(h.urls).toContain(`${DETAIL_PATH}/formatted`);
    expect(h.audit.join("\n")).toMatch(/variables=true/);
  });

  it("tier 1 never touches the variable chapter, and says so by name", async () => {
    const h = harness({ registerVariables: false, allowDumpVariables: false });
    const text = okText(await h.invoke({ mode: "show", key: KEY }));
    expect(text).toMatch(/chapters_shown: kap7,kap8,kap9,kap11/);
    // §5.10 — named, not a generic 404. An agent told "no such chapter"
    // concludes the dump held no variable data, which is false.
    expect(text).toMatch(/Chapter kap10 \(Selected Variables\) exists in this dump and is NOT/);
    // …and the index it is offered for selection from does not list it.
    expect(text).not.toMatch(/kap10 +\d+ +Selected Variables/);
  });
});

// ===========================================================================
// TIER 2, THROUGH THE SDK — the layer the two harnesses above cannot see
// ===========================================================================

/**
 * REGRESSION. Every test in this block failed to exist while the defect was
 * live, and every test in the block above stayed green while it was.
 *
 * The defect: `registerTool` was handed a raw zod shape, the SDK wrapped it in
 * a stripping `z.object`, and `{"variables":true}` sent to a server with the
 * capability off was deleted during validation. The handler then ran an
 * ordinary tier-1 show and answered `isError:false` with output identical, line
 * for line, to a request the caller never made. Reproduced live against the A4H
 * appliance: exit 0, no refusal, no note, nothing in the audit line to
 * distinguish it.
 *
 * Nothing leaked — the field was dropped, so no variable byte was fetched or
 * returned. What was returned was a **silent downgrade wearing a success
 * shape**, which is precisely the ADT failure mode this tool's own description
 * warns callers about ("the server silently ignores a parameter it does not
 * recognise and answers HTTP 200 with the FULL UNFILTERED feed"). A tool that
 * reproduces that in its own surface has no standing to warn about it.
 */
describe("a tier-2 request against a tier-1 server fails loudly at the SDK boundary", () => {
  it('gate OFF + {"variables":true} is refused DUMP_VARIABLES_DISABLED, not quietly downgraded', async () => {
    const h = await sdkHarness(cfg());
    const res = await h.call({ mode: "show", key: KEY, variables: true });

    // 1. Loud. The pre-fix behaviour was `isError` falsy.
    expect(res.isError).toBe(true);
    expect(JSON.parse(textOf(res)).error).toBe("DUMP_VARIABLES_DISABLED");

    // 2. Specifically NOT success-shaped. Pinned positively as well as by
    //    `isError`, because the defect's whole signature was a well-formed
    //    tier-1 answer: header, chapter index, chapter text.
    const text = textOf(res);
    expect(text).not.toMatch(/CHAPTER TEXT/);
    expect(text).not.toMatch(/chapters_shown/);

    // 3. And no dump resource was fetched — not the detail document, not the
    //    ~193 KB /formatted body that is the only carrier of variable values.
    //    (Several connect-flow probes DID go out — handshake, discovery, the
    //    §10.4 system-role probe, ATO settings; `ensureConnected()` runs
    //    first, by design, and this is the honest form of that claim. The
    //    positive control for this filter is the gate-ON show below, which
    //    asserts the /formatted URL IS recorded.)
    expect(dumpResourceUrls(h.urls)).toEqual([]);
    await h.close();
  });

  it('gate OFF + chapters:"kap10" is refused the same way — unchanged, and now consistent', async () => {
    const h = await sdkHarness(cfg());
    const res = await h.call({ mode: "show", key: KEY, chapters: VARIABLES_CHAPTER_NAME });
    expect(res.isError).toBe(true);
    expect(JSON.parse(textOf(res)).error).toBe("DUMP_VARIABLES_DISABLED");
    expect(dumpResourceUrls(h.urls)).toEqual([]);
    await h.close();
  });

  it("the two routes to the same bytes answer IDENTICALLY", async () => {
    // They did not. `chapters:"kap10"` was refused; `variables:true` succeeded
    // as a tier-1 show. Two routes to one chapter disagreeing about whether the
    // chapter is available is a bug on its own terms, independent of which
    // answer is right.
    const named = await sdkHarness(cfg());
    const sideways = await sdkHarness(cfg());
    const a = await named.call({ mode: "show", key: KEY, variables: true });
    const b = await sideways.call({ mode: "show", key: KEY, chapters: VARIABLES_CHAPTER_NAME });

    expect(a.isError).toBe(b.isError);
    const pa = JSON.parse(textOf(a)) as Record<string, unknown>;
    const pb = JSON.parse(textOf(b)) as Record<string, unknown>;
    expect(pa.error).toBe(pb.error);
    expect(pa.message).toEqual(pb.message);
    expect(dumpResourceUrls(named.urls)).toEqual(dumpResourceUrls(sideways.urls));
    await Promise.all([named.close(), sideways.close()]);
  });

  it("gate OFF: the advertised schema still has no variables property", async () => {
    // The constraint the fix was not allowed to break. Making the field always
    // present would "fix" the downgrade by handing every deployment a tier-2
    // parameter to argue about, which is the opposite of the design.
    const h = await sdkHarness(cfg());
    const props = (h.tool.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(props)).not.toContain("variables");
    expect(JSON.stringify(props)).not.toMatch(/variable|kap10/i);
    // Loose, so the handler can refuse what the schema does not advertise.
    expect(h.tool.inputSchema.additionalProperties).toEqual({});
    await h.close();
  });

  it('gate ON + {"variables":true} is ACCEPTED end to end', async () => {
    // Never exercised live — no A4H dump with a kap10 worth fetching under the
    // flag — so it is covered here at minimum. The point is narrow and real:
    // the loose schema must not have turned the happy path into a refusal.
    const h = await sdkHarness(cfg({ allowDumpVariables: true }));
    expect(Object.keys((h.tool.inputSchema.properties ?? {}) as object)).toContain("variables");
    const res = await h.call({ mode: "show", key: KEY, variables: true });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/chapters_shown: .*kap10/);
    expect(dumpResourceUrls(h.urls)).toContain(`${DETAIL_PATH}/formatted`);
    await h.close();
  });

  it("an unknown parameter is refused instead of stripped — stricter than before, not looser", async () => {
    // The cost of a loose schema, paid at the handler. Under the SDK's
    // stripping default this key vanished without a word and the call
    // succeeded; that is the same silent-ignore defect, just with a key nobody
    // was gated on.
    const h = await sdkHarness(cfg());
    const res = await h.call({ mode: "list", max: 3, nosuchparam: true });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(textOf(res)) as Record<string, unknown>;
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message ?? "")).toMatch(/no parameter nosuchparam/);
    expect(dumpResourceUrls(h.urls)).toEqual([]);
    await h.close();
  });

  it("cross-mode arguments are still BAD_INPUT through the SDK", async () => {
    // Preserved, not weakened: `key` is a KNOWN key, so it always reached the
    // handler and always will — the loose schema changes nothing here, and the
    // test exists so a future "simplification" back to a strict object (which
    // would answer this with a generic SDK validation error instead) is caught.
    const h = await sdkHarness(cfg());
    const res = await h.call({ mode: "list", key: KEY });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(textOf(res)) as Record<string, unknown>;
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message ?? "")).toMatch(/does not take key/);
    expect(dumpResourceUrls(h.urls)).toEqual([]);
    await h.close();
  });

  it("a plain tier-1 show still works, so the block above is not just refusing everything", async () => {
    const h = await sdkHarness(cfg());
    const res = await h.call({ mode: "show", key: KEY });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/chapters_shown: kap7,kap8,kap9,kap11/);
    await h.close();
  });
});

// ===========================================================================
// mode = "show"
// ===========================================================================

describe('mode="show"', () => {
  it("hands the terminated program and line to abap_read", async () => {
    const text = okText(await harness().invoke({ mode: "show", key: KEY }));
    expect(text).toMatch(/read it with abap_read object:"\/sap\/bc\/adt\//);
  });

  it("declares offset paging in the slice frame, and says which frame that is", async () => {
    const h = harness({ maxResponseChars: 1_500 });
    const text = okText(await h.invoke({ mode: "show", key: KEY }));
    expect(text).toMatch(/Fetch the next chunk with offset=/);
    expect(text).toMatch(/relative to the assembled chapter slice, NOT to the dump's/);
  });

  it("offset windows the slice rather than the whole /formatted body", async () => {
    const first = okText(await harness().invoke({ mode: "show", key: KEY, chapters: "kap8" }));
    const later = okText(await harness().invoke({ mode: "show", key: KEY, chapters: "kap8", offset: 3 }));
    // kap8 whole fits the budget, so buildResponse takes its fast path and says
    // nothing about windowing at all — silence here means "you have all of it".
    expect(first).not.toMatch(/Returned lines/);
    // offset=3 windows the CHAPTER SLICE. If it had been applied to the whole
    // 1,810-line /formatted body this would read "Returned lines 3..N" of a
    // body that starts hundreds of lines before kap8.
    expect(later).toMatch(/Returned lines 3\.\./);
    const sliceEnd = Number(/Returned lines 3\.\.(\d+) of (\d+)/.exec(later)?.[2]);
    expect(sliceEnd).toBeLessThan(1_810);
  });

  it("reports a chapter the dump does not have instead of returning silence", async () => {
    const text = okText(await harness().invoke({ mode: "show", key: KEY, chapters: "kap7,kap999" }));
    expect(text).toMatch(/Requested chapter\(s\) not present in this dump: kap999/);
  });

  it("states that slicing saves context, not bandwidth", async () => {
    const text = okText(await harness().invoke({ mode: "show", key: KEY }));
    expect(text).toMatch(/Chapter slicing saves context, not bandwidth/);
  });

  it("refuses show without a key, and never guesses one", async () => {
    const h = harness();
    const payload = errorPayload(await h.invoke({ mode: "show" }));
    expect(payload.error).toBe("BAD_INPUT");
    expect(h.urls).toEqual([]);
  });
});

// ===========================================================================
// mode = "list"
// ===========================================================================

describe('mode="list"', () => {
  it("prints the key verbatim — the one column mode=show can consume", async () => {
    const text = okText(await harness().invoke({}));
    expect(text).toContain(KEY);
    // Padding runs are part of the key. A tidied one 404s exactly like an
    // expired one, which is the failure this column exists to avoid.
    expect(KEY).toContain("%20%20");
  });

  it("an empty feed is never reported as a bare \"no dumps\"", async () => {
    const text = okText(await harness({ feed: fixture("feed-empty.xml") }).invoke({}));
    expect(text).toMatch(/No dumps in the last 8 days matching this filter\./);
    expect(text).toMatch(/C_SNAP_ADT_RESIDENCE_DAYS = 8/);
    expect(text).toMatch(/an older dump can still exist in transaction ST22/);
  });

  it("a full page is flagged as probably-incomplete, because no total exists", async () => {
    const text = okText(await harness().invoke({ max: 3 }));
    expect(text).toMatch(/EXACTLY max=3 row\(s\) came back/);
    expect(text).toMatch(/\$inlinecount is inert/);
  });

  it("names the only cursor this feed has", async () => {
    const text = okText(await harness().invoke({}));
    expect(text).toMatch(/No page cursor exists on this feed\. To see older dumps, call again with to=/);
  });

  it("does NOT advertise offset in list mode — it belongs to show", async () => {
    const text = okText(await harness({ maxResponseChars: 900 }).invoke({}));
    expect(text).toMatch(/NO offset\/paging parameter/);
    expect(text).not.toMatch(/Fetch the next chunk with offset=/);
  });

  it("a filter this client rejects never reaches the wire", async () => {
    const h = harness();
    // Missing the mandatory junction wrapper. The server would answer this
    // with an opaque 400; the point is that it is not sent at all.
    const payload = errorPayload(await h.invoke({ query: "equals ( user , DEVELOPER )" }));
    expect(payload.error).toBe("BAD_INPUT");
    expect(h.urls.filter((u) => u.startsWith(DUMPS_FEED_PATH))).toEqual([]);
  });

  it("a valid filter is sent, canonically, on the feed URL", async () => {
    const h = harness();
    okText(await h.invoke({ query: "and ( equals ( user , DEVELOPER ) )" }));
    const feedUrl = h.urls.find((u) => u.startsWith(DUMPS_FEED_PATH)) ?? "";
    expect(decodeURIComponent(feedUrl)).toContain("$query=and ( equals ( user , DEVELOPER ) )");
  });
});

// ===========================================================================
// Cross-mode arguments — §6.1 applied to this tool's own surface
// ===========================================================================

describe("a parameter belonging to the other mode is refused, never ignored", () => {
  it('mode="list" refuses show-only parameters', async () => {
    const h = harness();
    const payload = errorPayload(await h.invoke({ mode: "list", key: KEY }));
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message ?? "")).toMatch(/does not take key/);
    expect(h.urls).toEqual([]);
  });

  it('mode="show" refuses list-only parameters', async () => {
    const h = harness();
    const payload = errorPayload(await h.invoke({ mode: "show", key: KEY, max: 5 }));
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message ?? "")).toMatch(/does not take max/);
    expect(h.urls).toEqual([]);
  });
});
