/**
 * `abap_data_preview` — the THREE controls, and nothing else.
 *
 * The acceptance bar is "all three or ship nothing", so this
 * file is organised by control rather than by module:
 *
 *   1. OFF BY DEFAULT — `canPreviewData` is false with no env set, is not
 *      bought by `ABAP_ALLOW_WRITE`, is not taken away by `ABAP_MODE=read`,
 *      and when off the tool is ABSENT from `tools/list` rather than present
 *      and refusing (`src/server.ts`, guarded by `toolCapabilities.canPreviewData`).
 *   2. THE ROW CEILING — `max_rows: 0` is REFUSED, never silently
 *      re-defaulted; the clamp is downward only and is DISCLOSED; and a
 *      config value outside 1..1000 fails startup instead of being coerced.
 *   3. THE DENY-LIST — exact + prefix rules, case/whitespace/namespace
 *      normalisation, additive-only operator entries, a frozen default list,
 *      the check running BEFORE the read is issued, and the deliberate
 *      READ_ONLY-vs-SAFETY_DENIED code split.
 *
 * Control 3 closes with an HONEST test: a DDIC view over a denied table is
 * NOT denied. That behaviour is asserted as-is, so nobody reads a green suite
 * here as proof the deny-list is airtight — it is documented as fail-open in
 * `src/safety.ts`, and it is a speed bump, not a boundary.
 *
 * Two harnesses are used deliberately:
 *
 *   - the REAL server (`createServer` + an in-memory MCP client), for the
 *     registration question — "is the tool there at all?" can only be
 *     answered by the thing that registers it (same mechanism as
 *     `test/tools.test.ts`); and
 *   - a capturing fake `McpServer` (the `test/fpm-tools.test.ts` pattern) for
 *     the handler, because the row-ceiling guard is live code BELOW zod: the schema
 *     is `.int()` and deliberately NOT `.positive()` so that the refusal of
 *     `0` comes from the handler with its own message. Invoking the captured
 *     handler directly is the only way to exercise that branch — and the only
 *     way to reach it with the values (`null`, `NaN`) a future refactor to
 *     `??` would mishandle.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import {
  ConfigSchema,
  loadConfig,
  resolveStaticCapabilities,
  type Config,
} from "../src/config.js";
import { capabilitiesForMode } from "../src/mode.js";
import { createServer, errorResult, type AbapsmithServer } from "../src/server.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { AbapError } from "../src/adt/errors.js";
import {
  DEFAULT_PREVIEW_DENY_TABLES,
  SafetyGate,
  isPreviewTableDenied,
  type PreviewDenyRule,
  type SafetyConfig,
} from "../src/safety.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type { SessionPool } from "../src/adt/pool.js";
import type { PreviewResult } from "../src/adt/datapreview.js";
import { previewDdicEntity } from "../src/adt/datapreview.js";
import { registerDataPreviewTools, type DataPreviewToolDeps } from "../src/tools/data-preview.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

// `previewDdicEntity` is the network. Mocked so the handler's own three steps
// (connect → gate → clamp) can be exercised without a wire, and so the exact
// `maxRows` the clamp produced is observable as an argument rather than being
// inferred from rendered text. `importOriginal` is spread so every other
// export of the module stays real.
vi.mock("../src/adt/datapreview.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/adt/datapreview.js")>();
  return { ...actual, previewDdicEntity: vi.fn() };
});

const previewMock = vi.mocked(previewDdicEntity);

// ---------------------------------------------------------------- fixtures ---

const BASE_ENV = {
  ABAP_URL: "http://sap.invalid:50000",
  ABAP_USER: "U",
  ABAP_PASSWORD: "p",
};

const env = (over: Record<string, string> = {}): Record<string, string> => ({ ...BASE_ENV, ...over });

const load = (over: Record<string, string> = {}): Config =>
  loadConfig({ env: env(over), warn: () => {}, skipDotenv: true });

/** Same shape as `test/tools.test.ts`: client 001 so the system-role T000 probe has a client to judge. */
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

async function toolNames(config: Config): Promise<Set<string>> {
  const srv: AbapsmithServer = createServer(config, {
    // Registering tools costs zero requests (ForbiddenClient still
    // throws on anything that does leak), but the config it is built from is
    // otherwise an ordinary connection-capable one, so declare what system it
    // stands for like every other suite does. client "001" (see `cfg` above)
    // is the captured non-productive customising client these bytes answer for.
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
  return new Set(tools.map((t) => t.name));
}

/** Captures `registerTool` into a map instead of talking to an MCP client (`test/fpm-tools.test.ts`). */
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

const FAKE_CONN = {} as AbapConnection;

interface Harness {
  invoke: (args: unknown) => Promise<CallToolResult>;
  /** Every `pool.withRead` this handler made. Empty means the read was never issued. */
  poolCalls: string[];
  audit: string[];
  description: string;
}

interface HarnessOpts {
  ceiling?: number;
  safety?: SafetyGate;
  /** When true, `pool.withRead` throws instead of forwarding — proves the gate ran first. */
  poolIsBooby?: boolean;
  ensureConnected?: () => Promise<void>;
}

/** A gate that allows previews: non-productive, and the system-role verdict already transcribed. */
const openPreviewGate = (over: Partial<SafetyConfig> = {}): SafetyGate =>
  new SafetyGate({ readOnly: true, allowPackages: [], writesLockedOut: false, ...over });

function harness(opts: HarnessOpts = {}): Harness {
  const poolCalls: string[] = [];
  const audit: string[] = [];
  const pool = {
    withRead: <T,>(op: string, fn: (c: AbapConnection) => Promise<T>) => {
      poolCalls.push(op);
      if (opts.poolIsBooby) throw new Error("READ LEAKED: a refused preview reached the pool");
      return fn(FAKE_CONN);
    },
  } as unknown as SessionPool;

  const deps: DataPreviewToolDeps = {
    pool,
    safety: opts.safety ?? openPreviewGate(),
    ensureConnected: opts.ensureConnected ?? (async () => {}),
    errorResult,
    cfg: { maxResponseChars: 60_000, dataPreviewMaxRows: opts.ceiling ?? 100 },
    log: (m) => void audit.push(m),
  };

  const { mcp, tools } = fakeMcp();
  registerDataPreviewTools(mcp, deps);
  const entry = tools.get("abap_data_preview");
  if (!entry) throw new Error("abap_data_preview was never registered");
  return {
    invoke: entry.handler,
    poolCalls,
    audit,
    description: String(entry.config.description ?? ""),
  };
}

const previewResult = (over: Partial<PreviewResult> = {}): PreviewResult => ({
  table: "T000",
  columns: [{ name: "MANDT", type: "C", length: 3, key: true }],
  rows: [["000"], ["001"]],
  rowsRequested: 100,
  moreRowsExist: false,
  // An ordinary read carries no in-band `<dataPreview:message>`. Present and
  // empty rather than absent: `messages` is a required part of `PreviewResult`,
  // and a double that omits it is a double the real renderer would not accept.
  messages: [],
  ...over,
});

const errorPayload = (res: CallToolResult): Record<string, unknown> => {
  expect(res.isError).toBe(true);
  const part = res.content[0];
  if (!part || part.type !== "text") throw new Error("expected a text content part");
  return JSON.parse(part.text) as Record<string, unknown>;
};

const okText = (res: CallToolResult): string => {
  expect(res.isError).toBeFalsy();
  const part = res.content[0];
  if (!part || part.type !== "text") throw new Error("expected a text content part");
  return part.text;
};

/** `assertDataPreview` throws — this is the code it threw with. */
function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AbapError) return e.code;
    throw e;
  }
  throw new Error("expected assertDataPreview to throw, but it allowed the preview");
}

beforeEach(() => {
  previewMock.mockReset();
  previewMock.mockImplementation(async (_conn, input) =>
    previewResult({ table: input.table.toUpperCase(), rowsRequested: input.maxRows }),
  );
});

// ============================================================================
// CONTROL 1 — off by default
// ============================================================================

describe("control 1: off by default", () => {
  it("canPreviewData is false with no data-preview env set at all", () => {
    const c = load();
    expect(c.allowDataPreview).toBe(false);
    expect(resolveStaticCapabilities(c).canPreviewData).toBe(false);
  });

  it("ABAP_ALLOW_WRITE=true alone does NOT enable data preview", () => {
    // The two knobs are orthogonal on purpose: `canPreviewData` is set from
    // `allowDataPreview` alone and is deliberately NOT `&& canWrite`
    // (src/config.ts). Enabling writes must never hand out row reads.
    const c = load({ ABAP_ALLOW_WRITE: "true" });
    const caps = resolveStaticCapabilities(c);
    expect(caps.canWrite).toBe(true);
    expect(caps.canPreviewData).toBe(false);
    expect(c.allowDataPreview).toBe(false);
  });

  it("ABAP_ALLOW_DATA_PREVIEW=true alone does NOT enable writes", () => {
    const c = load({ ABAP_ALLOW_DATA_PREVIEW: "true" });
    const caps = resolveStaticCapabilities(c);
    expect(caps.canPreviewData).toBe(true);
    expect(caps.canWrite).toBe(false);
    expect(c.readOnly).toBe(true);
  });

  it("ABAP_MODE=read does NOT force the grant off when it is present", () => {
    // Mode never implies preview, and `read` must not withhold it —
    // a read-only server is exactly where reading rows belongs.
    const c = load({ ABAP_MODE: "read", ABAP_ALLOW_DATA_PREVIEW: "true" });
    expect(c.abapMode).toBe("read");
    expect(c.readOnly).toBe(true);
    expect(c.allowDataPreview).toBe(true);
    expect(resolveStaticCapabilities(c).canPreviewData).toBe(true);
  });

  it("ABAP_MODE=read without the grant still leaves it off", () => {
    const c = load({ ABAP_MODE: "read" });
    expect(c.allowDataPreview).toBe(false);
    expect(resolveStaticCapabilities(c).canPreviewData).toBe(false);
  });

  it("capabilitiesForMode honours AbapModeGrants.allowDataPreview in read mode, and grants nothing else", () => {
    // READ_CAPABILITIES_WITH_PREVIEW is a spread of the all-deny literal with
    // exactly one boolean flipped — assert that literally.
    const plain = capabilitiesForMode("read");
    const granted = capabilitiesForMode("read", {}, { allowDataPreview: true });
    expect(plain.allowDataPreview).toBe(false);
    expect(granted.allowDataPreview).toBe(true);
    expect({ ...granted, allowDataPreview: false }).toEqual({ ...plain });
    expect(granted.allowWrite).toBe(false);
    expect(granted.allowActivate).toBe(false);
    expect(granted.allowTransportRelease).toBe(false);
  });

  it("edit/admin modes do not imply the grant either", () => {
    expect(capabilitiesForMode("edit").allowDataPreview).toBe(false);
    expect(capabilitiesForMode("admin").allowDataPreview).toBe(false);
    expect(capabilitiesForMode("admin", {}, { allowDataPreview: true }).allowDataPreview).toBe(true);
  });

  it("the tool is ABSENT from tools/list when off — not present and refusing", async () => {
    const names = await toolNames(cfg());
    expect(names.has("abap_data_preview")).toBe(false);
    // Sanity: this server did register its ordinary read tools, so absence is
    // about the capability and not about an empty server.
    expect(names.has("abap_read")).toBe(true);
  });

  it("the tool is still ABSENT on a fully-open write server without the grant", async () => {
    const names = await toolNames(
      cfg({
        readOnly: false,
        allowPackages: ["*"],
        allowNamePrefixes: ["Z", "Y"],
        allowTransportRelease: true,
        allowEnhancements: true,
        enhanceTargets: "sap",
        enhanceTargetPackages: ["*"],
      }),
    );
    expect(names.has("abap_write")).toBe(true);
    expect(names.has("abap_transport_release")).toBe(true);
    expect(names.has("abap_data_preview")).toBe(false);
  });

  it("the tool IS present on a read-only server once the grant is on", async () => {
    const names = await toolNames(cfg({ allowDataPreview: true }));
    expect(names.has("abap_data_preview")).toBe(true);
    expect(names.has("abap_write")).toBe(false);
  });
});

// ============================================================================
// CONTROL 2 — the row ceiling
// ============================================================================

describe("control 2: the row ceiling", () => {
  it("max_rows: 0 is REFUSED with BAD_INPUT and never becomes the default", async () => {
    // THE bug this guards against: prior art's `args.max_rows || 100` turned an
    // explicit 0 into 100. Reintroducing `||` makes this test fail twice over
    // — no error is returned, and the pool IS reached. `0` is also not "no
    // rows" on this endpoint: `rowNumber=0` means UNLIMITED, so forwarding it
    // would dump the table. Refused, in both directions.
    const h = harness({ ceiling: 100 });
    const res = await h.invoke({ table: "T000", max_rows: 0 });
    const err = errorPayload(res);
    expect(err.error).toBe("BAD_INPUT");
    expect(String(err.message)).toMatch(/at least 1/i);
    expect(h.poolCalls).toEqual([]);
    expect(previewMock).not.toHaveBeenCalled();
  });

  it("the refusal of 0 explains that 0 means unlimited, not 'no rows'", async () => {
    const h = harness({ ceiling: 100 });
    const err = errorPayload(await h.invoke({ table: "T000", max_rows: 0 }));
    expect(String(err.hint)).toMatch(/unlimited/i);
  });

  it("max_rows: null is REFUSED too — `??` would silently re-default it", async () => {
    // `a.max_rows === undefined ? ceiling : a.max_rows` and `a.max_rows ??
    // ceiling` differ on exactly one value: null. This is the assertion that
    // fails if someone "simplifies" the ternary to `??`. (`||` is caught by
    // the `0` test above; `??` is caught here.)
    const h = harness({ ceiling: 100 });
    const err = errorPayload(await h.invoke({ table: "T000", max_rows: null }));
    expect(err.error).toBe("BAD_INPUT");
    expect(h.poolCalls).toEqual([]);
    expect(previewMock).not.toHaveBeenCalled();
  });

  it.each([
    ["negative", -1],
    ["negative beyond the ceiling", -500],
    ["non-integer", 2.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("max_rows %s → BAD_INPUT, with no read issued", async (_label, value) => {
    const h = harness({ ceiling: 100 });
    const err = errorPayload(await h.invoke({ table: "T000", max_rows: value }));
    expect(err.error).toBe("BAD_INPUT");
    expect(h.poolCalls).toEqual([]);
    expect(previewMock).not.toHaveBeenCalled();
  });

  it("max_rows above the ceiling is clamped DOWN to the ceiling", async () => {
    const h = harness({ ceiling: 5 });
    const res = await h.invoke({ table: "T000", max_rows: 5000 });
    okText(res);
    expect(previewMock).toHaveBeenCalledTimes(1);
    expect(previewMock.mock.calls[0]![1]).toEqual({ table: "T000", maxRows: 5 });
  });

  it("the clamp is DISCLOSED in the response text, naming both numbers and the env var", async () => {
    const h = harness({ ceiling: 5 });
    const text = okText(await h.invoke({ table: "T000", max_rows: 5000 }));
    expect(text).toMatch(/CLAMPED/);
    expect(text).toContain("5000");
    expect(text).toContain("ABAP_DATA_PREVIEW_MAX_ROWS");
    expect(text).toMatch(/no argument raises it/i);
  });

  it("a request at or below the ceiling is passed through unchanged and NOT announced as clamped", async () => {
    const h = harness({ ceiling: 100 });
    const text = okText(await h.invoke({ table: "T000", max_rows: 7 }));
    expect(previewMock.mock.calls[0]![1]).toEqual({ table: "T000", maxRows: 7 });
    expect(text).not.toMatch(/CLAMPED/);
  });

  it("omitted max_rows uses the configured ceiling, not a hard-coded 100", async () => {
    const h = harness({ ceiling: 42 });
    const text = okText(await h.invoke({ table: "T000" }));
    expect(previewMock.mock.calls[0]![1]).toEqual({ table: "T000", maxRows: 42 });
    // Nothing was clamped: requested === ceiling, so no CLAMPED note.
    expect(text).not.toMatch(/CLAMPED/);
  });

  it("the ceiling reported in the tool description is the configured one", () => {
    expect(harness({ ceiling: 7 }).description).toContain("currently 7");
  });

  it("the audit line records requested and effective separately", async () => {
    const h = harness({ ceiling: 5 });
    await h.invoke({ table: "T000", max_rows: 5000 });
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]!).toContain("requested=5000");
    expect(h.audit[0]!).toContain("effective=5");
    expect(h.audit[0]!).toContain("table=T000");
  });

  it("boundary: max_rows exactly 1 and exactly the ceiling are both accepted", async () => {
    const h = harness({ ceiling: 10 });
    okText(await h.invoke({ table: "T000", max_rows: 1 }));
    expect(previewMock.mock.calls[0]![1]).toEqual({ table: "T000", maxRows: 1 });
    okText(await h.invoke({ table: "T000", max_rows: 10 }));
    expect(previewMock.mock.calls[1]![1]).toEqual({ table: "T000", maxRows: 10 });
  });

  it("no JSON-Schema `default:` is advertised for max_rows — the SDK would not apply it", () => {
    // A `default: 100` in the schema is a lie a model reads and the server
    // never honours; the handler's ternary is the only default.
    const { mcp, tools } = fakeMcp();
    registerDataPreviewTools(mcp, {
      pool: {} as unknown as SessionPool,
      safety: openPreviewGate(),
      ensureConnected: async () => {},
      errorResult,
      cfg: { maxResponseChars: 60_000, dataPreviewMaxRows: 100 },
    });
    const schema = tools.get("abap_data_preview")!.config.inputSchema as Record<string, unknown>;
    expect(Object.keys(schema).sort()).toEqual(["max_rows", "object", "table"]);
    expect(JSON.stringify(schema)).not.toContain('"default"');
  });

  // --- startup: the ceiling is an operator setting, validated at load time ---

  it("the default ceiling is 100 when ABAP_DATA_PREVIEW_MAX_ROWS is unset", () => {
    expect(load().dataPreviewMaxRows).toBe(100);
  });

  it.each(["1", "100", "1000"])("ABAP_DATA_PREVIEW_MAX_ROWS=%s is accepted", (v) => {
    expect(load({ ABAP_DATA_PREVIEW_MAX_ROWS: v }).dataPreviewMaxRows).toBe(Number(v));
  });

  it.each([
    ["zero", "0"],
    ["negative", "-1"],
    ["above the 1000 ceiling", "1001"],
    ["far above the ceiling", "100000"],
    ["non-integer", "10.5"],
    ["not a number", "lots"],
    ["empty", ""],
  ])("a config ceiling that is %s fails STARTUP rather than being coerced", (_label, value) => {
    // The `ABAP_MAX_SESSIONS` style, deliberately not the silent-fallback
    // style: an out-of-range operator setting must reach the startup error
    // list.
    expect(() => load({ ABAP_DATA_PREVIEW_MAX_ROWS: value })).toThrow(
      /Invalid abapsmith configuration/,
    );
    expect(() => load({ ABAP_DATA_PREVIEW_MAX_ROWS: value })).toThrow(/dataPreviewMaxRows/);
  });
});

// ============================================================================
// `object` — a bare alias for `table`, the house convention every other tool
// uses for an object reference (defect: this tool used to accept only
// `table`, so a caller holding an object reference had to reshape it, and a
// caller guessing `object` — the convention everywhere else in this server —
// got a validation error).
// ============================================================================

describe("object: an alias for table", () => {
  it("accepts `object` in place of `table`", async () => {
    const h = harness({ ceiling: 100 });
    const text = okText(await h.invoke({ object: "T000", max_rows: 5 }));
    expect(previewMock.mock.calls[0]![1]).toEqual({ table: "T000", maxRows: 5 });
    expect(text).toContain("T000");
  });

  it("prefers `table` when both `table` and `object` are given", async () => {
    const h = harness({ ceiling: 100 });
    await h.invoke({ table: "T000", object: "USR02", max_rows: 5 });
    expect(previewMock.mock.calls[0]![1]).toMatchObject({ table: "T000" });
  });

  it("is refused with BAD_INPUT, no read issued, when neither is given", async () => {
    const h = harness({ ceiling: 100 });
    const err = errorPayload(await h.invoke({ max_rows: 5 }));
    expect(err.error).toBe("BAD_INPUT");
    expect(previewMock).not.toHaveBeenCalled();
  });

  it("resolving the alias does not mutate the caller's frozen args object", async () => {
    const h = harness({ ceiling: 100 });
    const args = Object.freeze({ object: "T000", max_rows: 5 });
    const text = okText(await h.invoke(args));
    expect(text).toContain("T000");
    expect(args).toEqual({ object: "T000", max_rows: 5 });
  });
});

// ============================================================================
// CONTROL 3 — the deny-list
// ============================================================================

describe("control 3: the deny-list", () => {
  it("ships non-empty and frozen, with both rule kinds", () => {
    expect(DEFAULT_PREVIEW_DENY_TABLES.length).toBeGreaterThan(0);
    expect(Object.isFrozen(DEFAULT_PREVIEW_DENY_TABLES)).toBe(true);
    expect(DEFAULT_PREVIEW_DENY_TABLES.every((r) => Object.isFrozen(r))).toBe(true);
    expect(DEFAULT_PREVIEW_DENY_TABLES.some((r) => r.kind === "exact")).toBe(true);
    expect(DEFAULT_PREVIEW_DENY_TABLES.some((r) => r.kind === "prefix")).toBe(true);
    // Every rule carries a reason — the refusal has to be legible to a model.
    expect(DEFAULT_PREVIEW_DENY_TABLES.every((r) => r.reason.length > 0)).toBe(true);
  });

  it("an exact rule denies (USR02)", () => {
    const hit = isPreviewTableDenied("USR02");
    expect(hit.denied).toBe(true);
    expect(hit.rule).toMatchObject({ kind: "exact", value: "USR02" });
  });

  it("a prefix rule denies (PA0008 via PA0)", () => {
    const hit = isPreviewTableDenied("PA0008");
    expect(hit.denied).toBe(true);
    expect(hit.rule).toMatchObject({ kind: "prefix", value: "PA0" });
  });

  it("matching is case-insensitive and trims whitespace", () => {
    for (const name of ["usr02", "  USR02  ", "\tUsR02\n", " pa0008 "]) {
      expect(isPreviewTableDenied(name).denied).toBe(true);
    }
  });

  it("the segment after the last slash is matched too, so namespaced copies do not fail open", () => {
    // Without this, `/ACME/PA0008` reads the same payroll bytes under a name
    // no prefix rule sees.
    expect(isPreviewTableDenied("/ACME/PA0008").denied).toBe(true);
    expect(isPreviewTableDenied("/acme/usr02").denied).toBe(true);
  });

  it("an unlisted table is allowed — this list fails OPEN by design", () => {
    expect(isPreviewTableDenied("T000").denied).toBe(false);
    expect(isPreviewTableDenied("DD02L").denied).toBe(false);
    expect(isPreviewTableDenied("").denied).toBe(false);
  });

  it("deliberate non-entries stay non-entries (T5* customizing, CDHDR/CDPOS, bare PAT01)", () => {
    // Recorded as deliberate decisions, so a later "tightening" that
    // breaks routine development fails here first and has to argue with the doc.
    for (const name of ["T512W", "T549Q", "CDHDR", "CDPOS", "PAT01", "PAT03"]) {
      expect(isPreviewTableDenied(name).denied).toBe(false);
    }
  });

  // --- additive-only ---

  it("operator extras ADD rules (exact and, via a trailing *, prefix)", () => {
    expect(isPreviewTableDenied("ZSECRET").denied).toBe(false);
    expect(isPreviewTableDenied("ZSECRET", ["ZSECRET"]).denied).toBe(true);
    expect(isPreviewTableDenied("ZPAYROLL_2026", ["ZPAY*"])).toMatchObject({
      denied: true,
      rule: { kind: "prefix", value: "ZPAY" },
    });
  });

  it("there is NO extras value that removes a built-in rule", () => {
    // There is no negation syntax, so the closest a hostile/confused operator
    // can get is passing the built-in's own name, or something that looks like
    // a negation. All of it only ever ADDS.
    const attempts: readonly string[][] = [
      ["USR02"],
      ["!USR02"],
      ["-USR02"],
      ["USR02:allow"],
      ["USR02=false"],
      ["~USR02"],
      [""],
      ["*"],
    ];
    for (const extra of attempts) {
      expect(isPreviewTableDenied("USR02", extra).denied).toBe(true);
      expect(isPreviewTableDenied("PA0008", extra).denied).toBe(true);
    }
    // ...and the built-ins survive an extras list of every built-in value
    // rendered as a would-be "override" too.
    const shouty = DEFAULT_PREVIEW_DENY_TABLES.map((r) => `!${r.value}`);
    expect(isPreviewTableDenied("USR02", shouty).denied).toBe(true);
    expect(isPreviewTableDenied("BSEG", shouty).denied).toBe(true);
  });

  it("`*` as an extra does not disable anything — it is a prefix rule matching everything", () => {
    // Asserted so the behaviour is on the record: a lone `*` is the maximally
    // RESTRICTIVE setting, never an allow-all.
    expect(isPreviewTableDenied("T000", ["*"]).denied).toBe(true);
  });

  it("the frozen default list cannot be mutated at runtime", () => {
    const before = DEFAULT_PREVIEW_DENY_TABLES.length;
    const firstRule = DEFAULT_PREVIEW_DENY_TABLES[0]!;
    const originalValue = firstRule.value;
    const originalKind = firstRule.kind;

    // Attempted in a swallow-then-assert-no-effect shape rather than
    // `expect(...).toThrow()`: the point is that the mutation DOES NOT TAKE,
    // which must hold whether or not the runtime chooses to throw.
    const mutable = DEFAULT_PREVIEW_DENY_TABLES as PreviewDenyRule[];
    try {
      mutable.push({ kind: "exact", value: "ZINJECTED", reason: "should never land" });
    } catch {
      /* strict mode throws on a frozen array — either way, nothing is added */
    }
    try {
      mutable.length = 0;
    } catch {
      /* ditto */
    }
    try {
      (firstRule as { value: string }).value = "ZOVERWRITTEN";
    } catch {
      /* ditto */
    }
    try {
      (firstRule as { kind: string }).kind = "prefix";
    } catch {
      /* ditto */
    }

    expect(DEFAULT_PREVIEW_DENY_TABLES.length).toBe(before);
    expect(DEFAULT_PREVIEW_DENY_TABLES.some((r) => r.value === "ZINJECTED")).toBe(false);
    expect(DEFAULT_PREVIEW_DENY_TABLES[0]!.value).toBe(originalValue);
    expect(DEFAULT_PREVIEW_DENY_TABLES[0]!.kind).toBe(originalKind);
    // And the poisoning attempt did not change what the checker decides.
    expect(isPreviewTableDenied("USR02").denied).toBe(true);
    expect(isPreviewTableDenied("ZINJECTED").denied).toBe(false);
  });

  it("an extras array does not leak into subsequent calls", () => {
    expect(isPreviewTableDenied("ZSECRET", ["ZSECRET"]).denied).toBe(true);
    expect(isPreviewTableDenied("ZSECRET").denied).toBe(false);
  });

  // --- the gate ---

  it("evaluateDataPreview denies a listed table with SAFETY_DENIED, naming the rule and its reason", () => {
    const gate = openPreviewGate();
    const d = gate.evaluateDataPreview("USR02");
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("SAFETY_DENIED");
    expect(d.reason).toMatch(/USR02/);
    expect(d.reason).toMatch(/deny-list/i);
    expect(d.reason).toMatch(/policy refusal/i);
    expect(codeOf(() => gate.assertDataPreview("USR02"))).toBe("SAFETY_DENIED");
    expect(codeOf(() => gate.assertDataPreview("  pa0008 "))).toBe("SAFETY_DENIED");
  });

  it("evaluateDataPreview allows an unlisted table on a proven-nonproductive system", () => {
    const d = openPreviewGate().evaluateDataPreview("T000");
    expect(d.allowed).toBe(true);
    expect(() => openPreviewGate().assertDataPreview("T000")).not.toThrow();
  });

  it("dataPreviewDenyTables on the gate config is consulted, additively", () => {
    const gate = openPreviewGate({ dataPreviewDenyTables: ["ZSECRET", "ZPAY*"] });
    expect(codeOf(() => gate.assertDataPreview("ZSECRET"))).toBe("SAFETY_DENIED");
    expect(codeOf(() => gate.assertDataPreview("ZPAY_RESULTS"))).toBe("SAFETY_DENIED");
    expect(codeOf(() => gate.assertDataPreview("USR02"))).toBe("SAFETY_DENIED"); // built-in survives
    expect(() => gate.assertDataPreview("T000")).not.toThrow();
  });

  it("ABAP_MODE=read does NOT make the gate refuse a preview — a preview is a read", () => {
    // `readOnly: true` is the default in `openPreviewGate`; asserted
    // explicitly so nobody adds a `readOnly` check to `evaluateDataPreview`.
    const gate = new SafetyGate({ readOnly: true, allowPackages: [], writesLockedOut: false });
    expect(gate.evaluateDataPreview("T000").allowed).toBe(true);
  });

  it("an empty table name is refused with SAFETY_DENIED, before any system-role question", () => {
    const gate = new SafetyGate({ readOnly: true, allowPackages: [] }); // writesLockedOut undefined
    const d = gate.evaluateDataPreview("   ");
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("SAFETY_DENIED");
  });

  // --- READ_ONLY vs SAFETY_DENIED: different codes on purpose ---

  it("a productive system denies with READ_ONLY, not SAFETY_DENIED", () => {
    // The taxonomy split (src/safety.ts): READ_ONLY = a capability switch is
    // off (write flag, productive role, lockout); SAFETY_DENIED = an allowlist
    // did not match a TARGET. Consumers branch on exactly this, so collapsing
    // the two would invite a target-less caller to skip the ceiling.
    for (const over of [
      { productive: true },
      { systemRole: "productive" as const },
    ]) {
      const gate = openPreviewGate(over);
      expect(gate.evaluateDataPreview("T000").code).toBe("READ_ONLY");
      expect(codeOf(() => gate.assertDataPreview("T000"))).toBe("READ_ONLY");
    }
  });

  it("an UNPROVEN system denies with READ_ONLY — fail closed, both flavours", () => {
    const lockedOut = new SafetyGate({
      readOnly: true,
      allowPackages: [],
      writesLockedOut: true,
      lockoutReason: "probe returned 406",
    });
    expect(codeOf(() => lockedOut.assertDataPreview("T000"))).toBe("READ_ONLY");
    expect(lockedOut.evaluateDataPreview("T000").reason).toMatch(/probe returned 406/);

    // No probe has run yet on this connection: `writesLockedOut === undefined`.
    const undecided = new SafetyGate({ readOnly: true, allowPackages: [] });
    expect(undecided.evaluateDataPreview("T000").allowed).toBe(false);
    expect(codeOf(() => undecided.assertDataPreview("T000"))).toBe("READ_ONLY");
  });

  it("the productive ceiling is not overridable by the preview flag", () => {
    const gate = openPreviewGate({ productive: true });
    expect(gate.evaluateDataPreview("T000").reason).toMatch(/ABAP_ALLOW_DATA_PREVIEW/);
    expect(gate.evaluateDataPreview("T000").reason).toMatch(/no override|does not override/i);
  });

  it("the productive ceiling is judged BEFORE the deny-list, so a listed table on a productive system is READ_ONLY", () => {
    // Order matters for the taxonomy: the system-wide refusal is the stronger
    // statement and must not be masked by a table-specific one.
    const gate = openPreviewGate({ productive: true });
    expect(gate.evaluateDataPreview("USR02").code).toBe("READ_ONLY");
  });

  // --- the check runs BEFORE the read is issued ---

  it("a denied table costs ZERO reads — the gate runs before the pool is touched", async () => {
    // The refusal must not itself be the thing that reads the rows. The pool
    // here is booby-trapped: any `withRead` at all throws. What this pins is
    // the READ, not the whole process's network silence — `ensureConnected`
    // below is expected to have run, and on a cold session it connects
    // (VERIFIED live 2026-08-11).
    const ensureConnected = vi.fn(async () => {});
    const h = harness({ poolIsBooby: true, ensureConnected });
    const err = errorPayload(await h.invoke({ table: "USR02", max_rows: 1 }));
    expect(err.error).toBe("SAFETY_DENIED");
    expect(h.poolCalls).toEqual([]);
    expect(previewMock).not.toHaveBeenCalled();
    // `ensureConnected` DOES run first, by design: the system-role verdict has to be
    // transcribed onto the gate before it can judge anything.
    expect(ensureConnected).toHaveBeenCalledTimes(1);
  });

  it("the deny is judged before the clamp, so a denied table with a bad max_rows still reports SAFETY_DENIED", async () => {
    const h = harness({ poolIsBooby: true });
    expect(errorPayload(await h.invoke({ table: "USR02", max_rows: 0 })).error).toBe("SAFETY_DENIED");
  });

  it("a productive system costs zero reads too, and reports READ_ONLY through the tool", async () => {
    const h = harness({ poolIsBooby: true, safety: openPreviewGate({ productive: true }) });
    const err = errorPayload(await h.invoke({ table: "T000" }));
    expect(err.error).toBe("READ_ONLY");
    expect(h.poolCalls).toEqual([]);
    expect(previewMock).not.toHaveBeenCalled();
  });

  it("the refusal states it is final, without overclaiming coverage of every other name", async () => {
    const h = harness({ poolIsBooby: true });
    const err = errorPayload(await h.invoke({ table: "usr02" }));
    expect(String(err.message)).toMatch(/retrying will not change it/i);
    expect(String(err.hint)).toMatch(/can only ADD|no setting\s+removes one/i);
    // The old wording claimed "reaching the same rows under another name is
    // the same refusal" — false for a differently-named view. The message
    // must state only what the matcher actually does: the name as given,
    // case-insensitively, plus the segment after the last slash.
    expect(String(err.message)).not.toMatch(/under another name/i);
    expect(String(err.message)).toMatch(/case-insensitively/i);
    expect(String(err.message)).toMatch(/segment after the.*last slash/i);
    expect(String(err.message)).toMatch(/does not resolve a view to what it selects from/i);
  });

  // ------------------------------------------------------------------------
  // THE HONEST TEST — what this control does NOT do.
  // ------------------------------------------------------------------------

  it("FAIL-OPEN, DOCUMENTED: a DDIC view over a denied table is NOT denied", async () => {
    // This is the largest hole in control 3, and it is intended, not a bug:
    //
    //   - the deny-list is a NAME list. A DDIC or CDS view over USR02 has a
    //     different name and reads the same bytes, so no name-based list can
    //     close this. `src/safety.ts` says so at the constant ("the largest
    //     hole, which no name-based list can close").
    //   - the same rows are reachable through `oo/classrun` and the debugger's
    //     variable inspection, neither of which consults a table list at all.
    //   - the REAL boundary is the technical user's S_TABU_DIS / S_TABU_NAM
    //     authorisations. This list is a speed bump with a label on it: it
    //     makes the catastrophic ACCIDENT structurally impossible and produces
    //     a named refusal a model can reason about. It is NOT a security
    //     control and the README must not describe it as one.
    //
    // Asserted as current behaviour on purpose, so that a green run of this
    // file is never mistaken for "the deny-list is airtight". If someone later
    // makes view resolution work, this test SHOULD fail — and the fix is to
    // rewrite it with the new guarantee, not to delete the honesty.
    expect(isPreviewTableDenied("V_USR02").denied).toBe(false);
    expect(isPreviewTableDenied("ZV_PAYROLL_EXPORT").denied).toBe(false);
    expect(isPreviewTableDenied("ZUSR02_COPY").denied).toBe(false);

    const h = harness();
    const text = okText(await h.invoke({ table: "V_USR02", max_rows: 1 }));
    expect(text).toContain("V_USR02");
    expect(previewMock).toHaveBeenCalledTimes(1);
  });

  it("FAIL-OPEN, DOCUMENTED: a Z* copy of payroll data is NOT denied", () => {
    // Same reasoning: `ZPA0008` does not start with `PA0`, and no rule catches
    // a local copy. Recorded, not fixed — see the note above.
    expect(isPreviewTableDenied("ZPA0008").denied).toBe(false);
    expect(isPreviewTableDenied("YBSEG_ARCHIVE").denied).toBe(false);
  });
});

// ============================================ the in-band message channel ===

/**
 * The tool-level half of the silent-empty fix. `test/data-preview.test.ts`
 * drives the parser and `renderPreview` from the captured `DEMO_CDS_PARA`
 * bytes; this asserts the same fact through the REGISTERED HANDLER, so the
 * text a model actually receives is what is being checked — not an internal
 * function that the handler could stop calling.
 */
describe("in-band dataPreview:message reaches the caller", () => {
  const MESSAGE_TEXT = "Data preview not supported for view with parameters";

  it("never calls a parameterised CDS view a genuinely empty result", async () => {
    previewMock.mockResolvedValueOnce(
      previewResult({
        table: "DEMO_CDS_PARA",
        columns: [],
        rows: [],
        rowsRequested: 5,
        messages: [{ text: MESSAGE_TEXT, severity: "I" }],
      }),
    );
    const h = harness();
    const text = okText(await h.invoke({ table: "DEMO_CDS_PARA", max_rows: 5 }));

    // The two halves of the sentence the defect emitted.
    expect(text).not.toContain("was read successfully");
    expect(text).not.toContain("genuinely empty result");
    // What it says instead: the server's own words, and a refusal to conclude.
    expect(text).toContain(MESSAGE_TEXT);
    expect(text).toContain("SERVER NOTICE");
    expect(text).toContain("NOT READ");
  });

  it("still reports a real empty entity as empty", async () => {
    // The guard on the fix: no rows AND no message is genuinely empty, and the
    // tool must keep saying so rather than hedging everything.
    previewMock.mockResolvedValueOnce(
      previewResult({ table: "ZEMPTY", columns: [], rows: [], rowsRequested: 5 }),
    );
    const h = harness();
    const text = okText(await h.invoke({ table: "ZEMPTY", max_rows: 5 }));
    expect(text).toContain("EMPTY: ZEMPTY");
    expect(text).toContain("genuinely empty result");
    expect(text).not.toContain("NOT READ");
  });

  it("is not an error result: severity is reported, not thrown", async () => {
    // Documented decision (see the return site in src/adt/datapreview.ts): even
    // "E" comes back as a note on a successful call, because the response is
    // HTTP 200 and can carry rows alongside the message.
    previewMock.mockResolvedValueOnce(
      previewResult({ messages: [{ text: "something went wrong", severity: "E" }] }),
    );
    const h = harness();
    const res = await h.invoke({ table: "T000", max_rows: 5 });
    expect(res.isError).toBeFalsy();
    const text = okText(res);
    expect(text).toContain("SERVER ERROR");
    expect(text).toContain("something went wrong");
    // And the rows the server did return survive.
    expect(text).toContain("000");
  });
});
