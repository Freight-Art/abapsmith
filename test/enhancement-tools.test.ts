/**
 * Tests for `src/tools/enh.ts` — the MCP tool layer (`abap_enh`) over
 * `src/adt/enhancement-write.ts` and `src/adt/enhancement-refusals.ts`
 * (this file's sibling).
 *
 * Combines two idioms this codebase already keeps as separate, deliberately
 * un-shared copies (per the one-small-copy-per-test-file convention):
 *
 *  - the ADT-layer harness from `test/enhancement-write.test.ts` (`FakeAdt`,
 *    `resp`, `cfg`, `connected`, fixture-loading, the LOCK response bodies,
 *    `gate()`, `AFFECTS_HOOK`/`AFFECTS_SPOT`) — because this file still needs
 *    a real `AbapConnection` wired to a fake `HttpClient` underneath the tool
 *    layer, exactly like that file does underneath the ADT layer;
 *  - the MCP-tool-layer harness from `test/fpm-tools.test.ts` (`fakeMcp`,
 *    `invoke`, `fakePool`, `errorPayload`, `okText`) — because this file is
 *    about the TOOL surface: input validation, two-phase gating, response
 *    rendering and refusal classification, not the LOCK/PUT/UNLOCK wire
 *    mechanics `enhancement-write.test.ts` already proves exhaustively.
 *
 * The six refusal-family fixtures (`test/fixtures/enhancement/183`,
 * `196`, `275`, `446`, `543`, `272`) are real captures of OTHER HTTP verbs
 * (mostly POST/DELETE against the create/delete surface these modules do not use) —
 * `classifyEnhancementRefusal` classifies purely on the response body's
 * `T100KEY-ID`/`T100KEY-NO`/exception-type, never on which verb produced it,
 * so replaying their exact bytes as this suite's PUT response is legitimate
 * evidence for how `abap_enh` reacts to that body, matching the reasoning
 * `enhancement-write.test.ts` itself already applies to fixture 272/273 for
 * the session-death family. See `src/adt/enhancement-refusals.ts`'s own
 * header for the fixture-to-family mapping this file exercises.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
import {
  registerEnhancementTools,
  type EnhToolDeps,
  EnhInput,
  enhInputSchema,
  ENH_CREATE_OPERATIONS,
  ENH_HOOK_OPERATIONS,
  ENH_DELETE_OPERATIONS,
  ENH_ACTIVATION_OPERATIONS,
} from "../src/tools/enh.js";
import { Journal } from "../src/journal.js";
import { BRIDGE_CLASS, ENH_CREATE_PACKAGE } from "../src/adt/enhancement-bridge.js";
import { patchBadiImplementationActive, patchEnhancementRootAttribute } from "../src/adt/enhancement-xml.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// ADT-layer harness, copied from test/enhancement-write.test.ts — see that
// file for the full rationale on each piece. Only what this file uses.
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
/* `DATAPREVIEW_XML` and `T000_NONPRODUCTIVE` come from ./helpers/system-role-fake.js. */

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

/** Real A4H discovery capture (Enhancements workspace) — needed so
 *  `conn.discovery` reports "loaded" with enhoxh/enhoxhh/enhsxs present;
 *  otherwise the new `assertEnhancementCapable` gate in
 *  `writeEnhancementDescription` would refuse every write below as
 *  discovery-unknown before the refusal-classification fixtures below
 *  ever get a chance to run. */
const DISCOVERY_ENHANCEMENTS_XML = fixture("discovery-enhancements.xml");

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, DISCOVERY_ENHANCEMENTS_XML, OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
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

const ENHOXHH_URI = "/sap/bc/adt/enhancements/enhoxhh/ZMCP_ENH_B";
const ENHOXH_URI = "/sap/bc/adt/enhancements/enhoxh/ZMCP_ENH_BADI";
const ENHSXS_URI = "/sap/bc/adt/enhancements/enhsxs/ZMCP_SPOT";

const ENHOXHH_XML = (
  JSON.parse(readFileSync(join(FIXTURES_DIR, "138-put-wholedoc-success.meta.json"), "utf8")) as {
    requestBody: string;
  }
).requestBody;
const ENHOXH_XML = fixture("354-enhoxh-no-filter.xml");
const ENHSXS_XML = fixture("343-enhsxs-no-filters.xml");

/**
 * A second, synthetic-by-necessity <enho:badiImplementation> entry appended
 * to the real fixture — same rationale and construction as
 * `enhancement-write.test.ts`'s own `ENHOXH_TWO_IMPLS_XML`: no real capture
 * on file has more than one entry, so this is the only way to exercise
 * `spec.implName` actually disambiguating between several at the TOOL layer
 * (not just the adt layer, which already has its own dedicated coverage).
 */
const ENHOXH_TWO_IMPLS_BLOCK_RE = /<enho:badiImplementation\b[\s\S]*?<\/enho:badiImplementation>/;
const ENHOXH_TWO_IMPLS_SINGLE_BLOCK = ENHOXH_XML.match(ENHOXH_TWO_IMPLS_BLOCK_RE)![0];
const ENHOXH_TWO_IMPLS_XML = ENHOXH_XML.replace(
  ENHOXH_TWO_IMPLS_SINGLE_BLOCK,
  ENHOXH_TWO_IMPLS_SINGLE_BLOCK +
    ENHOXH_TWO_IMPLS_SINGLE_BLOCK.replace('enho:name="ZMCP_BADI_I1"', 'enho:name="ZMCP_BADI_I2"'),
);

/**
 * set_impl_active now refuses pre-lock (ENHANCEMENT_DESCRIPTION_REQUIRED,
 * see enhancement-write.test.ts's own dedicated describe block for the full
 * regression coverage) against a document with no root adtcore:description
 * — real `ENHO/XH` objects can genuinely have none, but every PUT against
 * one needs one regardless of what's actually changing. The set_impl_active
 * tests below are about implName resolution/routing, not description handling, so they
 * use these WITH_DESC variants (built via the same production patcher, not
 * a hand-rolled string edit) to stay decoupled from that guard.
 */
const ENHOXH_DESCRIPTION = "ZMCP recon BAdI implementation";
const ENHOXH_XML_WITH_DESC = patchEnhancementRootAttribute(ENHOXH_XML, "description", ENHOXH_DESCRIPTION);
const ENHOXH_TWO_IMPLS_XML_WITH_DESC = patchEnhancementRootAttribute(
  ENHOXH_TWO_IMPLS_XML,
  "description",
  ENHOXH_DESCRIPTION,
);

const LOCK_LOCAL_XML =
  `<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">` +
  `<asx:values><DATA><LOCK_HANDLE>84895B18717205C738BE52DAB00DC12609C1821F</LOCK_HANDLE><CORRNR/>` +
  `<CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/>` +
  `<MODIFICATION_SUPPORT>NoModification</MODIFICATION_SUPPORT><SCOPE_MESSAGES/></DATA></asx:values></asx:abap>`;

/**
 * Copied verbatim from test/activate.test.ts (via enhancement-write.test.ts's
 * own copy) — a real captured `<chkl:messages>` envelope with two `type="E"`
 * `<msg>` elements, which `activateObject` turns into `activated: false`
 * without throwing.
 */
const ACTIVATION_ERRORS = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Program ZMCP_PROBE_REP" type="E" line="1"
       href="/sap/bc/adt/programs/programs/zmcp_probe_rep/source/main#start=4,0"
       forceSupported="true">
    <shortText><txt>Incomplete expression: Operand (e.g. field) missing at end of statement.</txt></shortText>
  </msg>
  <msg objDescr="Program ZMCP_PROBE_REP" type="E" line="2"
       href="/sap/bc/adt/programs/programs/zmcp_probe_rep/source/main#start=5,0"
       forceSupported="true">
    <shortText><txt>The statement "WRIT" is not expected. A correct similar statement is "WRITE".</txt></shortText>
  </msg>
</chkl:messages>`;

const gate = (extra: Partial<ConstructorParameters<typeof SafetyGate>[0]> = {}): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP"],
    allowEnhancements: true,
    enhanceTargets: "customer",
    originSystems: ["A4H"],
    ...extra,
  });

const AFFECTS_HOOK = { name: "ZMCP_BADI_HOST", packageName: "$TMP", masterSystem: "A4H" };
const AFFECTS_SPOT = { name: "ZMCP_SPOT", packageName: "$TMP", masterSystem: "A4H", spotName: "ZMCP_SPOT" };

// ---------------------------------------------------------------------------
// MCP-tool-layer harness, copied from test/fpm-tools.test.ts.
// ---------------------------------------------------------------------------

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

/**
 * `enh.ts` always passes `deps.transport` (the "transport-flavoured" arm of
 * `EnhancementTransportOptions`, never the "local, opts.transport===undefined"
 * arm `enhancement-write.test.ts`'s own happy-path tests use) — so
 * `preflightCorr` unconditionally calls `SessionTransport.resolve()`, which
 * calls `#cts.trRequirement()` (a real `POST .../cts/transportchecks` in
 * production). Every test below needs that faked, exactly like
 * `enhancement-write.test.ts`'s own transport-flavoured tests fake
 * `trRequirement`/`trShow` — a real network call would otherwise hit
 * `FakeAdt`'s loud unrouted-request guard. Default: every object is LOCAL
 * (`$TMP`, matching every fixture used in this file), which resolves without
 * ever calling `trShow` at all.
 */
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

function depsFor(
  conn: AbapConnection,
  opts: { safety?: SafetyGate; transport?: SessionTransport; journal?: Journal } = {},
): EnhToolDeps {
  return {
    pool: fakePool(conn),
    safety: opts.safety ?? gate(),
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 30_000 },
    transport: opts.transport ?? localTransport(),
    ...(opts.journal ? { journal: opts.journal } : {}),
  };
}

async function registered(
  conn: AbapConnection,
  opts: { safety?: SafetyGate; transport?: SessionTransport; journal?: Journal } = {},
): Promise<{
  tools: Map<string, { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }>;
  deps: EnhToolDeps;
}> {
  const { mcp, tools } = fakeMcp();
  const deps = depsFor(conn, opts);
  registerEnhancementTools(mcp, deps);
  return { tools, deps };
}

// ===========================================================================
// Registration shape
// ===========================================================================

describe("registerEnhancementTools", () => {
  it("registers exactly one tool, abap_enh, marked as a non-read-only, non-destructive write", async () => {
    const { conn } = await connected(() => undefined);
    const { tools } = await registered(conn);
    expect([...tools.keys()]).toEqual(["abap_enh"]);
    const config = tools.get("abap_enh")!.config;
    expect((config.annotations as { readOnlyHint?: boolean }).readOnlyHint).toBe(false);
    expect((config.annotations as { destructiveHint?: boolean }).destructiveHint).toBe(false);
  });
});

// ===========================================================================
// Happy paths
// ===========================================================================

describe("abap_enh — happy path, ENHO/XHH (PUT-verified type), write only", () => {
  it("writes the description, does not activate when activate is omitted, no unverified-write caveat", async () => {
    const { conn } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXHH_URI && r.method === "PUT") return resp(200, "", { etag: "NEWETAG123=" });
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      type: "ENHO/XHH",
      name: "ZMCP_ENH_B",
      description: "a new description",
      affects: AFFECTS_HOOK,
    });

    const text = okText(result);
    expect(text).toContain('type: ENHO/XHH');
    expect(text).toContain('changed: true');
    expect(text).toContain('putVerified: true');
    expect(text).not.toContain("UNVERIFIED");
    expect(text).not.toContain("Activated");
    expect(text).not.toContain('activated');
  });
});

describe("abap_enh — happy path, ENHO/XHH, write + activate", () => {
  it("activates after a changed write, and reports activated:true", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXHH_URI && r.method === "PUT") return resp(200, "", { etag: "ACTETAG=" });
      if (r.url.includes("/activation"))
        return resp(200, `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`, OK_XML);
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      type: "ENHO/XHH",
      name: "ZMCP_ENH_B",
      description: "activate me",
      affects: AFFECTS_HOOK,
      activate: true,
    });

    const text = okText(result);
    expect(text).toContain('activated: true');
    expect(text).toContain("Activated successfully.");
    // Activation happens strictly after UNLOCK (the write's own lock must be released first).
    const unlockIdx = adt.calls.findIndex((c) => c.qs._action === "UNLOCK");
    const activateIdx = adt.calls.findIndex((c) => c.url.includes("/activation"));
    expect(unlockIdx).toBeGreaterThanOrEqual(0);
    expect(activateIdx).toBeGreaterThan(unlockIdx);
  });

  it("a failed activation (real captured error checklist) reports activated:false without throwing, and surfaces activationMessages", async () => {
    const { conn } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXHH_URI && r.method === "PUT") return resp(200, "", { etag: "FAILETAG=" });
      if (r.url.includes("/activation")) return resp(200, ACTIVATION_ERRORS, OK_XML);
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      type: "ENHO/XHH",
      name: "ZMCP_ENH_B",
      description: "activation will fail",
      affects: AFFECTS_HOOK,
      activate: true,
    });

    const text = okText(result);
    expect(text).toContain('changed: true');
    expect(text).toContain('activated: false');
    expect(text).toContain("Activation did NOT succeed");
    expect(text).toContain("activationMessages");
  });
});

describe("abap_enh — happy path, ENHO/XH and ENHS/XS (unverified types)", () => {
  it("ENHO/XH: writes successfully, but the response echoes the unverified-write caveat", async () => {
    const { conn } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXH_URI && r.method === "PUT") return resp(200, "", { etag: "XHETAG=" });
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      type: "ENHO/XH",
      name: "ZMCP_ENH_BADI",
      description: "first description ever",
      affects: AFFECTS_SPOT,
    });

    const text = okText(result);
    expect(text).toContain('changed: true');
    expect(text).toContain('putVerified: false');
    expect(text).toContain("UNVERIFIED");
    expect(text).toContain("not yet corroborated to the same degree ENHO/XHH's has");
  });

  it("ENHS/XS: same caveat surfaces for the enhancement-spot collection", async () => {
    const { conn } = await connected((r) => {
      if (r.url === ENHSXS_URI && r.method === "GET") return resp(200, ENHSXS_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHSXS_URI && r.method === "PUT") return resp(200, "", { etag: "XSETAG=" });
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      type: "ENHS/XS",
      name: "ZMCP_SPOT",
      description: "spot description",
      affects: AFFECTS_SPOT,
    });

    const text = okText(result);
    expect(text).toContain('putVerified: false');
    expect(text).toContain("UNVERIFIED");
  });
});

describe("abap_enh — no-op short-circuit", () => {
  it("an identical description is never locked, written or activated, even when activate:true is requested", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      type: "ENHO/XHH",
      name: "ZMCP_ENH_B",
      description: "ZMCP recon hook impl", // identical to ENHOXHH_XML's own description
      affects: AFFECTS_HOOK,
      activate: true,
    });

    const text = okText(result);
    expect(text).toContain('changed: false');
    expect(text).toContain("No-op");
    expect(text).not.toContain("activated:");
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("PUT");
    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(false);
  });
});

// ===========================================================================
// Two-phase gating
// ===========================================================================

describe("abap_enh — SafetyGate denial", () => {
  // NOTE: `ABAP_ALLOW_PACKAGES` (`allowPackages`) governs only the
  // ENHANCEMENT's own package — which is unconditionally "" (deferred,
  // unknown) at preflight, per `enh.ts`'s own header, so it can never
  // produce a preflight denial. It also does NOT govern `affects`: the
  // affected object's package is judged by `ABAP_ENHANCE_TARGETS`/
  // `ABAP_ENHANCE_TARGET_PACKAGES` instead (`SafetyGate.enhancementRules`,
  // `src/safety.ts`), unconditionally (not phase-gated) — so THAT is the
  // rule this test exercises: an `affects` object outside the configured
  // target class is refused before any network call, exactly like a
  // package-allowlist miss would be for an ordinary write.
  it("preflight denial (affected object outside ABAP_ENHANCE_TARGETS) refuses before any network call at all", async () => {
    const { conn, adt } = await connected(() => undefined);
    const deniedGate = gate({ enhanceTargets: "none" });
    const { tools } = await registered(conn, { safety: deniedGate });

    const result = await invoke(tools, "abap_enh", {
      type: "ENHO/XHH",
      name: "ZMCP_ENH_B",
      description: "irrelevant, never reached",
      affects: AFFECTS_HOOK,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("ENHANCEMENT_DISABLED");
    expect(adt.calls).toHaveLength(0);
  });

  it("activate:true against a closed (read-only) gate refuses at preflight, before any network call", async () => {
    const { conn, adt } = await connected(() => undefined);
    const closedGate = new SafetyGate({ readOnly: true, allowPackages: [] });
    const { tools } = await registered(conn, { safety: closedGate });

    const result = await invoke(tools, "abap_enh", {
      type: "ENHO/XHH",
      name: "ZMCP_ENH_B",
      description: "irrelevant, never reached",
      affects: AFFECTS_HOOK,
      activate: true,
    });

    const payload = errorPayload(result);
    expect(["SAFETY_DENIED", "READ_ONLY"]).toContain(payload.error);
    expect(adt.calls).toHaveLength(0);
  });
});

// ===========================================================================
// Refusal classification — the six named families
// ===========================================================================

describe("abap_enh — refusal classification (the six named families)", () => {
  it("family #1: ExceptionParameterNotFound / corrNr missing -> TRANSPORT_ERROR (fixture 183)", async () => {
    const CORRNR_MISSING_XML = fixture("183-corrnr-absent-400.xml");
    const { conn } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXHH_URI && r.method === "PUT") return resp(400, CORRNR_MISSING_XML, OK_XML);
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      type: "ENHO/XHH",
      name: "ZMCP_ENH_B",
      description: "a new description",
      affects: AFFECTS_HOOK,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("TRANSPORT_ERROR");
    expect(String(payload.message)).toContain("corrNr");
  });

  it("family #2: CTS_WBO_API 037 / task named where a request is required -> TRANSPORT_ERROR (fixture 196)", async () => {
    const TASK_NOT_REQUEST_XML = fixture("196-corrnr-task-not-request-400.xml");
    const { conn } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXHH_URI && r.method === "PUT") return resp(400, TASK_NOT_REQUEST_XML, OK_XML);
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      type: "ENHO/XHH",
      name: "ZMCP_ENH_B",
      description: "a new description",
      affects: AFFECTS_HOOK,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("TRANSPORT_ERROR");
    expect(String(payload.message)).toContain("task/request hierarchy");
  });

  it("family #3: SADT_RESOURCE 010 / no create-write handler -> ENHANCEMENT_CREATE_REFUSED (fixture 275)", async () => {
    const NO_HANDLER_XML = fixture("275-sadt-resource-no-create-handler-400.xml");
    const { conn } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXHH_URI && r.method === "PUT") return resp(400, NO_HANDLER_XML, OK_XML);
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      type: "ENHO/XHH",
      name: "ZMCP_ENH_B",
      description: "a new description",
      affects: AFFECTS_HOOK,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("ENHANCEMENT_CREATE_REFUSED");
    expect(String(payload.message)).toContain("no create/write handler");
  });

  it("family #4: SEDI_ADT 015 / PUT line-length-over-255 -> BAD_INPUT (fixture 446)", async () => {
    const LINE_TOO_LONG_XML = fixture("446-put-line-too-long.xml");
    const { conn } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXHH_URI && r.method === "PUT") return resp(400, LINE_TOO_LONG_XML, OK_XML);
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      type: "ENHO/XHH",
      name: "ZMCP_ENH_B",
      description: "a new description",
      affects: AFFECTS_HOOK,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("255 characters");
  });

  it("family #5: XT 465 / tp-configuration misconfiguration -> TRANSPORT_ERROR (fixture 543)", async () => {
    const TP_CONFIG_XML = fixture("543-xt465-tp-config-delete-400.xml");
    const { conn } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXHH_URI && r.method === "PUT") return resp(400, TP_CONFIG_XML, OK_XML);
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      type: "ENHO/XHH",
      name: "ZMCP_ENH_B",
      description: "a new description",
      affects: AFFECTS_HOOK,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("TRANSPORT_ERROR");
    expect(String(payload.message)).toContain("tp (transport control program) configuration");
  });

  it("family #6: text/html session-destroying dump -> SESSION_DEAD, untouched by the refusal classifier (fixture 272)", async () => {
    const SESSION_DEATH_HTML = fixture("272-session-death-500-shortdump.xml");
    const { conn } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXHH_URI && r.method === "PUT")
        return resp(500, SESSION_DEATH_HTML, { "content-type": "text/html; charset=utf-8" });
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      type: "ENHO/XHH",
      name: "ZMCP_ENH_B",
      description: "a new description",
      affects: AFFECTS_HOOK,
    });

    const payload = errorPayload(result);
    // Already classified as SESSION_DEAD upstream by translateAdtError /
    // classifySessionFailure — classifyEnhancementRefusal only ever touches
    // ADT_ERROR-coded errors, so this must arrive completely unmodified.
    expect(payload.error).toBe("SESSION_DEAD");
  });

  it("an unrecognised ADT_ERROR fails closed: passes through unmodified, never guessed at", async () => {
    const UNKNOWN_XML =
      `<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
      `<namespace id="com.sap.adt"/><type id="ExceptionSomethingElse"/><message lang="EN">Some other refusal entirely</message>` +
      `<properties><entry key="T100KEY-ID">ZZZZ_UNKNOWN</entry><entry key="T100KEY-NO">999</entry></properties></exc:exception>`;
    const { conn } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXHH_URI && r.method === "PUT") return resp(400, UNKNOWN_XML, OK_XML);
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      type: "ENHO/XHH",
      name: "ZMCP_ENH_B",
      description: "a new description",
      affects: AFFECTS_HOOK,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("ADT_ERROR");
    expect(String(payload.message)).toContain("Some other refusal entirely");
  });
});

// ===========================================================================
// Unsupported type
// ===========================================================================

describe("abap_enh — unsupported type", () => {
  it("a type outside ENHANCEMENT_WRITE_TYPES is refused before any network call", async () => {
    const { conn, adt } = await connected(() => undefined);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      type: "ENHS/XSF",
      name: "ZMCP_SPOT",
      description: "irrelevant",
      affects: AFFECTS_SPOT,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("UNSUPPORTED");
    expect(adt.calls).toHaveLength(0);
  });

  // Omitted `type` is BAD_INPUT naming the arg, not a bare "undefined is not a type".
  it('operation:"delete" with `type` omitted is refused BAD_INPUT naming type, not the literal "undefined is not a type" wording', async () => {
    const { conn, adt } = await connected(() => undefined);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "delete",
      name: "ZMCP_SPOT",
      affects: AFFECTS_SPOT,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain('operation:"delete" requires type');
    expect(String(payload.message)).not.toMatch(/^undefined is not a type/);
    expect(adt.calls).toHaveLength(0);
  });

  it('operation:"write_description" with `type` omitted is refused BAD_INPUT naming type, not the literal "undefined is not a type" wording', async () => {
    const { conn, adt } = await connected(() => undefined);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "write_description",
      description: "irrelevant",
      affects: AFFECTS_SPOT,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain('operation:"write_description" requires type');
    expect(String(payload.message)).not.toMatch(/^undefined is not a type/);
    expect(adt.calls).toHaveLength(0);
  });
});

// ===========================================================================
// write_description regression: `description` is schema-optional now (the
// six create operations never use it), so the handler must guard its
// absence itself rather than let `undefined` reach writeEnhancementDescription's
// required `description: string` field.
// ===========================================================================

describe("abap_enh — write_description requires description", () => {
  it("refuses BAD_INPUT, before any network call, when description is omitted", async () => {
    const { conn, adt } = await connected(() => undefined);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      type: "ENHO/XHH",
      name: "ZMCP_ENH_B",
      affects: AFFECTS_HOOK,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("description");
    expect(adt.calls).toHaveLength(0);
  });
});

// ===========================================================================
// Defect 3 (MED): write_description silently 60-char-truncates on SAP's side
// with a raw t100 SWB_TOOL/18 error and no client-side guard, and the schema
// never mentioned the limit. Fixed with a client-side length guard (this
// section) AND schema documentation (see enh.ts's `description` .describe()).
// ===========================================================================

describe("abap_enh — write_description enforces the 60-character description limit client-side", () => {
  it("accepts a description at exactly 60 characters (boundary, not off-by-one)", async () => {
    const { conn } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXHH_URI && r.method === "PUT") return resp(200, "", { etag: "NEWETAG123=" });
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      type: "ENHO/XHH",
      name: "ZMCP_ENH_B",
      description: "A".repeat(60),
      affects: AFFECTS_HOOK,
    });

    const text = okText(result);
    expect(text).toContain("changed: true");
  });

  it("refuses BAD_INPUT before any network call when description is 61 characters (over SAP's CHAR60 adtcore:description limit)", async () => {
    const { conn, adt } = await connected(() => undefined);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      type: "ENHO/XHH",
      name: "ZMCP_ENH_B",
      description: "A".repeat(61),
      affects: AFFECTS_HOOK,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("60");
    // Client-side refusal, before the wire call that would otherwise fail
    // deep inside SAP with the opaque t100 SWB_TOOL/18 error this guard
    // exists to pre-empt.
    expect(adt.calls).toHaveLength(0);
  });
});

// ===========================================================================
// The six create operations (operation !== "write_description")
//
// The wire choreography each of these six dispatches to is already proven
// exhaustively offline in test/enhancement-bridge.test.ts (23 tests: H50
// identifier validation, H21 marker-interface ensure-if-missing, H23 joint
// activation, and a full happy path per operation). What is NOT covered
// there is the abap_enh TOOL layer sitting in front of it — spec-field
// extraction/validation, the operation dispatch switch, and the zero-network
// preflight gate check — so this section is deliberately narrow: one true
// end-to-end happy path (create_spot, the simplest of the six — no marker
// interface, no joint activation) to prove the wiring reaches the right
// bridge function with the right arguments, plus the tool-layer-specific
// failure modes (missing spec field, gate denial) that only exist at this
// layer.
// ===========================================================================

const CLASS_COLLECTION = "/sap/bc/adt/oo/classes";

const LOCK_LOCAL_XML_H =
  `<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">` +
  `<asx:values><DATA><LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/>` +
  `<CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/>` +
  `<MODIFICATION_SUPPORT>NoModification</MODIFICATION_SUPPORT><SCOPE_MESSAGES/></DATA></asx:values></asx:abap>`;

/**
 * GET-404 -> POST-create -> LOCK -> PUT source -> UNLOCK happy path for the
 * generated bridge class, plus its classrun run and its activation — the
 * same shape as test/enhancement-bridge.test.ts's own `objectHappyPath` +
 * `sharedRoute` + `classrunOutput`, kept as its own small copy here per this
 * file's own header (one small copy per test file, not a shared harness).
 */
function createSpotBridgeRoute(tags: readonly string[]): Route {
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
    if (r.url.startsWith("/sap/bc/adt/oo/classrun/")) return resp(200, tags.join("\n"), { "content-type": "text/plain" });
    if (r.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return undefined;
  };
}

describe("abap_enh — operation:create_spot", () => {
  it("dispatches to the classrun bridge, always activates, and reports the transcript tags", async () => {
    const { conn, adt } = await connected(createSpotBridgeRoute(["SPOT-OBJECT-CREATED"]));
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "create_spot",
      name: "ZMCP_SPOT",
      spec: { description: "A spot" },
      affects: AFFECTS_SPOT,
    });

    const text = okText(result);
    expect(text).toContain("SPOT-OBJECT-CREATED");
    expect(text).toContain(ENH_CREATE_PACKAGE);
    expect(adt.labels.some((l) => l.startsWith("POST /sap/bc/adt/oo/classrun/"))).toBe(true);
  });

  it("refuses BAD_INPUT before any network call when a required spec field is missing (add_badi_def)", async () => {
    const { conn, adt } = await connected(() => undefined);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "add_badi_def",
      name: "ZMCP_SPOT",
      spec: { interfaceName: "ZIF_MCP_BADI", singleUse: true, shortText: "test" }, // badiName missing
      affects: AFFECTS_SPOT,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("badiName");
    expect(adt.calls).toHaveLength(0);
  });

  // parseExerciseParams's `kind` field (which
  // superseded the old `changing?: boolean` field — that field recorded the
  // caller's intent faithfully but exerciseFragment still emitted a literal
  // into the CHANGING clause, which is the defect this fix corrects) must
  // be validated the same way every other spec field is — an unrecognized
  // value is refused before any network call, not coerced or silently
  // ignored.
  it('refuses BAD_INPUT before any network call when exercise spec.params[].kind is not a recognized value', async () => {
    const { conn, adt } = await connected(() => undefined);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "exercise",
      name: "ZMCP_BADI",
      spec: {
        methodName: "RUN",
        params: [{ name: "CT_DATA", value: "x", kind: "yes" }],
      },
      affects: AFFECTS_HOOK,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("kind");
    expect(adt.calls).toHaveLength(0);
  });

  // The CHANGING-clause literal defect itself,
  // pinned at the tool layer (exerciseFragment's own unit tests in
  // test/enhancement-exercise.test.ts cover the generated ABAP text in full
  // detail) — a "changing" param requires spec.params[].type, refused
  // before any network call, not silently generating ABAP that would fail
  // to compile server-side.
  it('refuses BAD_INPUT before any network call when exercise spec.params[].kind is "changing" but type is omitted', async () => {
    const { conn, adt } = await connected(() => undefined);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "exercise",
      name: "ZMCP_BADI",
      spec: {
        methodName: "RUN",
        params: [{ name: "CT_DATA", value: "x", kind: "changing" }],
      },
      affects: AFFECTS_HOOK,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("type");
    expect(adt.calls).toHaveLength(0);
  });

  // Defect 1(a) regression guard at the tool layer: filterName/filterValue
  // must be given together (both or neither) — a filter value with no field
  // name has nothing to substitute into `GET BADI ... FILTERS`, and silently
  // dropping it would resurrect the literal-`flt`-placeholder defect one
  // layer up.
  it("refuses BAD_INPUT before any network call when exercise spec.filterValue is given without spec.filterName", async () => {
    const { conn, adt } = await connected(() => undefined);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "exercise",
      name: "ZMCP_BADI",
      spec: { methodName: "RUN", filterValue: "LH", params: [] },
      affects: AFFECTS_HOOK,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("filterName");
    expect(adt.calls).toHaveLength(0);
  });

  it("refuses ENHANCEMENT_DISABLED before any network call when the gate does not allow enhancements", async () => {
    const { conn, adt } = await connected(() => undefined);
    const denyingGate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] }); // allowEnhancements absent
    const { tools } = await registered(conn, { safety: denyingGate });

    const result = await invoke(tools, "abap_enh", {
      operation: "create_spot",
      name: "ZMCP_SPOT",
      // description supplied so this test reaches the gate check it exists
      // to prove, rather than tripping the (also zero-network) missing-
      // spec.description BAD_INPUT refusal first — see the omitted-
      // description test below, which covers that case on its own.
      spec: { description: "A spot" },
      affects: AFFECTS_SPOT,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("ENHANCEMENT_DISABLED");
    expect(adt.calls).toHaveLength(0);
  });

  // Root-cause fix: create_spot's spec.description is now REQUIRED (see
  // CreateSpotParams' doc comment in enhancement-templates.ts) — without it,
  // every ENHS/XS this operation creates would come out with an empty root
  // adtcore:description and therefore be unwritable the moment it exists,
  // per enhancement-write.ts's ENHANCEMENT_DESCRIPTION_REQUIRED guard (which
  // covers enhsxs explicitly). This proves the omitted case is refused
  // BEFORE anything is created — no lock, no write, no network call at all —
  // not merely refused eventually by the PUT. Mirrors the create_impl test
  // above.
  it('refuses BAD_INPUT before any network call when create_spot spec.description is omitted', async () => {
    const { conn, adt } = await connected(() => undefined);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "create_spot",
      name: "ZMCP_SPOT",
      // spec omitted entirely — description intentionally absent
      affects: AFFECTS_SPOT,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("description");
    expect(adt.calls).toHaveLength(0);
  });

  // Root-cause fix: create_impl's spec.description is now REQUIRED (see
  // CreateImplParams' doc comment in enhancement-templates.ts) — without it,
  // every ENHO/XH this operation creates would come out with an empty root
  // adtcore:description and therefore be unwritable (including
  // un-deactivatable) the moment it exists, per enhancement-write.ts's
  // ENHANCEMENT_DESCRIPTION_REQUIRED guard. This proves the omitted case is
  // refused BEFORE anything is created — no lock, no write, no network call
  // at all — not merely refused eventually by the PUT.
  it('refuses BAD_INPUT before any network call when create_impl spec.description is omitted', async () => {
    const { conn, adt } = await connected(() => undefined);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "create_impl",
      name: "ZMCP_ENH_BADI",
      spec: {
        spotName: "ZMCP_SPOT",
        badiName: "ZMCP_BADI",
        implName: "ZMCP_IMPL",
        implClass: "ZCL_MCP_IMPL",
        active: true,
        // description intentionally omitted
      },
      affects: AFFECTS_SPOT,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("description");
    expect(adt.calls).toHaveLength(0);
  });
});

// ===========================================================================
// Defect 2 (HIGH, guard): a filter-less implementation on a filter-dependent
// multi-use BAdI dispatches for ANY filter value, silently. create_impl's
// bridge choreography now runs a diagnostic-only check (badiFilterCheckFragment,
// enhancement-bridge.ts) after the object is created, and the tool layer
// surfaces its outcome as a note in the response — never as a failure (the
// object IS created either way; this is advisory only).
// ===========================================================================

/**
 * Same shape as createSpotBridgeRoute above (GET-404 -> POST-create -> LOCK
 * -> PUT source -> UNLOCK -> classrun run -> activation), parameterized for
 * BRIDGE_CLASS.createImpl instead of createSpot — kept as its own small copy
 * per this file's own one-copy-per-file convention, not shared.
 */
function createImplBridgeRoute(tags: readonly string[]): Route {
  const objUrl = `${CLASS_COLLECTION}/${BRIDGE_CLASS.createImpl.toLowerCase()}`;
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
    if (r.url.startsWith("/sap/bc/adt/oo/classrun/")) return resp(200, tags.join("\n"), { "content-type": "text/plain" });
    if (r.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return undefined;
  };
}

const CREATE_IMPL_SPEC = {
  spotName: "ZMCP_SPOT",
  badiName: "ZMCP_BADI",
  implName: "ZMCP_IMPL",
  implClass: "ZCL_MCP_IMPL",
  active: true,
  description: "An implementation",
};

describe("abap_enh — create_impl surfaces the filter-presence diagnostic as a note, never a failure", () => {
  it("warns and names set_filter_values when the transcript reports BADI-HAS-FILTERS (the silent-dispatch-for-any-filter-value hazard)", async () => {
    const { conn } = await connected(
      createImplBridgeRoute(["ENHO-OBJECT-CREATED", "IMPL-ADDED", "BADI-HAS-FILTERS"]),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "create_impl",
      name: "ZMCP_ENH_BADI",
      spec: CREATE_IMPL_SPEC,
      affects: AFFECTS_SPOT,
    });

    const text = okText(result);
    expect(text).toContain("IMPL-ADDED");
    expect(text.toLowerCase()).toContain("set_filter_values");
  });

  it("does not warn when the transcript reports BADI-NO-FILTERS", async () => {
    const { conn } = await connected(
      createImplBridgeRoute(["ENHO-OBJECT-CREATED", "IMPL-ADDED", "BADI-NO-FILTERS"]),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "create_impl",
      name: "ZMCP_ENH_BADI",
      spec: CREATE_IMPL_SPEC,
      affects: AFFECTS_SPOT,
    });

    const text = okText(result);
    expect(text.toLowerCase()).not.toContain("set_filter_values");
  });

  it("still succeeds (object was created) with a softer note when the diagnostic itself is inconclusive", async () => {
    const { conn } = await connected(
      createImplBridgeRoute(["ENHO-OBJECT-CREATED", "IMPL-ADDED", "BADI-FILTER-CHECK-INCONCLUSIVE"]),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "create_impl",
      name: "ZMCP_ENH_BADI",
      spec: CREATE_IMPL_SPEC,
      affects: AFFECTS_SPOT,
    });

    const text = okText(result);
    expect(text).toContain("IMPL-ADDED");
  });
});

// ===========================================================================
// Journalling. `writeEnhancementDescription`'s `onBeforeImage` hook was
// optional and NEITHER caller passed one, so every description write reached a
// customer's system with no before-image and no journal entry — despite the
// implementation plan claiming the change was already journalled. These pin
// the fix.
// ===========================================================================

describe("abap_enh — the write journal", () => {
  const withJournal = async (fn: (j: Journal) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "abapsmith-enh-journal-"));
    try {
      await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  const writingServer = (): Route => (r) => {
    if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
    if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
    if (r.url === ENHOXHH_URI && r.method === "PUT") return resp(200, "", { etag: "NEWETAG123=" });
    return undefined;
  };

  it("records the change, with the whole pre-lock document as the before-image", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(writingServer());
      const { tools } = await registered(conn, { journal });

      okText(
        await invoke(tools, "abap_enh", {
          type: "ENHO/XHH",
          name: "ZMCP_ENH_B",
          description: "a new description",
          affects: AFFECTS_HOOK,
        }),
      );

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.operation).toBe("update");
      expect(entry.outcome).toBe("succeeded");
      expect(entry.object.name).toBe("ZMCP_ENH_B");
      expect(entry.object.type).toBe("ENHO/XHH");
      // The enhanced object's identity — the half of the plan's claim
      // that only this field can make true.
      expect(entry.object.affects).toEqual(AFFECTS_HOOK);
      // The WHOLE document, not just the description string: that is what a
      // before-image is, and the description alone would not let anyone
      // reconstruct the previous state.
      expect(await journal.beforeImage(entry)).toBe(ENHOXHH_XML);
      expect(entry.existedBefore).toBe(true);
      expect(entry.beforeCapture).toBe("captured");
    });
  });

  it("marks the entry irreversible — undo refuses every enhancement type, so it must not offer one", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(writingServer());
      const { tools } = await registered(conn, { journal });
      okText(
        await invoke(tools, "abap_enh", {
          type: "ENHO/XHH",
          name: "ZMCP_ENH_B",
          description: "a new description",
          affects: AFFECTS_HOOK,
        }),
      );
      // `undoBlocker()` (src/adt/undo.ts) refuses ENHO/XH, ENHO/XHH and
      // ENHS/XS unconditionally and unforceably (H7/H8/H26-H28). An entry that
      // did not say so would advertise a rollback abap_journal always declines.
      expect((await journal.list())[0]!.irreversible).toBe(true);
    });
  });

  it("writes NOTHING for a no-op — the description already matched, so nothing is undoable", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected((r) => {
        if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
        return undefined;
      });
      const { tools } = await registered(conn, { journal });
      const text = okText(
        await invoke(tools, "abap_enh", {
          type: "ENHO/XHH",
          name: "ZMCP_ENH_B",
          description: "ZMCP recon hook impl", // identical to ENHOXHH_XML's own description
          affects: AFFECTS_HOOK,
        }),
      );
      expect(text).toContain("changed: false");
      expect(await journal.list()).toHaveLength(0);
    });
  });

  it("records `failed` when the PUT is rejected — the entry outlives the failure", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected((r) => {
        if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
        if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
        if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
        if (r.url === ENHOXHH_URI && r.method === "PUT") return resp(500, "<x>nope</x>", OK_XML);
        return undefined;
      });
      const { tools } = await registered(conn, { journal });
      const result = await invoke(tools, "abap_enh", {
        type: "ENHO/XHH",
        name: "ZMCP_ENH_B",
        description: "a new description",
        affects: AFFECTS_HOOK,
      });
      expect(result.isError).toBe(true);

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.outcome).toBe("failed");
      // The before-image is still there: a failed write is exactly when the
      // record of what was there beforehand is worth the most.
      expect(await journal.beforeImage(entries[0]!)).toBe(ENHOXHH_XML);
    });
  });

  it("no journal wired (today's src/server.ts) still writes — it just records nothing", async () => {
    const { conn } = await connected(writingServer());
    const { tools } = await registered(conn);
    expect(
      okText(
        await invoke(tools, "abap_enh", {
          type: "ENHO/XHH",
          name: "ZMCP_ENH_B",
          description: "a new description",
          affects: AFFECTS_HOOK,
        }),
      ),
    ).toContain("changed: true");
  });
});

// ===========================================================================
// operation:"set_impl_active" routing, and a structural dispatch guard
// covering every operation the schema declares.
// ===========================================================================

describe('abap_enh — operation:"set_impl_active" reaches the activation handler, not create', () => {
  it("produces the GET/LOCK/GET/PUT/UNLOCK activation sequence and an activation-shaped response — never create's operation/tags/durationMs shape", async () => {
    // Uses the REAL, unmodified fixture 354 (plus a synthetic root
    // description — see ENHOXH_XML_WITH_DESC's own doc comment above; the
    // fixture itself genuinely has none, but every set_impl_active PUT now
    // requires one, and this test's concern is routing/shape, not the
    // description guard) — container "ZMCP_ENH_BADI", nested entry
    // "ZMCP_BADI_I1" (genuinely different strings) — with spec.implName
    // omitted. The document has exactly one <enho:badiImplementation>
    // entry, so it resolves unambiguously; no byte substitution needed now
    // that `name` (container) and the entry lookup are independently
    // addressable — see enhancement-write.test.ts's own regression tests
    // for the defect this used to work around.
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_XML_WITH_DESC, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXH_URI && r.method === "PUT") return resp(200, "", { etag: "SYNETAG2=" });
      // Ninth-instance fix: set_impl_active now ALWAYS activates a real
      // change, so this test's route table must stub /activation too —
      // before the fix this test never reached that URL at all, since
      // `input.activate` was omitted here and used to gate the call off.
      if (r.url.includes("/activation"))
        return resp(200, `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`, OK_XML);
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "set_impl_active",
      name: "ZMCP_ENH_BADI",
      spec: { active: false },
      affects: AFFECTS_SPOT,
    });

    const text = okText(result);
    // buildEnhActivationResponse's header carries active/changed/putVerified/
    // previousEtag/implName; buildEnhCreateResponse's carries
    // operation/tags/durationMs/outputComplete instead and never an "active:"
    // line — a create-handler misroute would fail every one of these.
    expect(text).toContain("active: false");
    expect(text).toContain("changed: true");
    expect(text).toContain("putVerified: false"); // ENHO/XH PUT success is unverified
    // The RESOLVED entry's own name is reported — distinct from the
    // container name above, proving the lookup used the entry, not the
    // container, as the write key.
    expect(text).toContain("implName: ZMCP_BADI_I1");
    expect(text).not.toContain("operation:");
    expect(text).not.toContain("durationMs");
    expect(text).not.toContain("tags:");
    expect(text).not.toContain("BRIDGE OUTPUT");
    // The ninth-instance fix itself: no `activate` input field was passed at
    // all, yet the real (changed:true) deactivation was still activated —
    // this operation no longer has a non-activating variant.
    expect(text).toContain("activated: true");
    expect(text).toContain("Activated successfully.");

    // The wire shape itself: one GET (resolve), LOCK, reread GET, PUT, UNLOCK,
    // then activation — never the classrun-bridge multi-step sequence
    // create_impl etc. use, and never a genuine content-creating POST
    // (LOCK/UNLOCK are POST-on-the-wire with a `_action` query param, already
    // distinguished by `adt.verbs` above; nothing new is being created here).
    // The activation POST strictly follows UNLOCK, same discipline as
    // write_description's own "activate after the lock is released" test.
    const unlockIdx = adt.calls.findIndex((c) => c.qs._action === "UNLOCK");
    const activateIdx = adt.calls.findIndex((c) => c.url.includes("/activation"));
    expect(unlockIdx).toBeGreaterThanOrEqual(0);
    expect(activateIdx).toBeGreaterThan(unlockIdx);
    expect(adt.calls.every((c) => c.method !== "POST" || c.qs._action || c.url.includes("/activation"))).toBe(true);
    const put = adt.calls.find((c) => c.method === "PUT" && c.url === ENHOXH_URI);
    expect(put?.body).toContain('enho:name="ZMCP_BADI_I1"');
    expect(put?.body).toContain('enho:isActive="false"');
  });

  it("activates in the OTHER direction too — reactivating (active:true) a currently-inactive implementation, with no activate input field passed", async () => {
    // Both directions matter per the task's own reasoning: the teardown flow
    // that surfaced this bug depended on active:false actually reaching the
    // runtime object, but an activation that silently no-ops is just as
    // broken as a deactivation that does. Starts from an INACTIVE fixture
    // (isActive="false", patched byte-preservingly, same production patcher
    // the ENHOXH_TWO_IMPLS_XML fixtures above already use) so `active: true`
    // is a genuine change, not a no-op.
    const inactiveXml = patchBadiImplementationActive(ENHOXH_XML_WITH_DESC, "ZMCP_BADI_I1", false);
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, inactiveXml, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXH_URI && r.method === "PUT") return resp(200, "", { etag: "REACTETAG=" });
      if (r.url.includes("/activation"))
        return resp(200, `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`, OK_XML);
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "set_impl_active",
      name: "ZMCP_ENH_BADI",
      spec: { active: true },
      affects: AFFECTS_SPOT,
    });

    const text = okText(result);
    expect(text).toContain("active: true");
    expect(text).toContain("changed: true");
    expect(text).toContain("activated: true");
    const put = adt.calls.find((c) => c.method === "PUT" && c.url === ENHOXH_URI);
    expect(put?.body).toContain('enho:isActive="true"');
    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(true);
  });

  it("a real change is STILL activated even when the caller explicitly passes activate:false — set_impl_active never reads that input field, per its own schema description", async () => {
    // Direct regression test for the fix's judgment call: `activate` is not
    // silently ignored (it is documented as ignored in the schema), but it
    // must ALSO be genuinely, functionally ignored by this operation's
    // handler — passing `activate:false` must not be able to reintroduce
    // the ninth-instance defect (an un-activated isActive flip).
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_XML_WITH_DESC, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXH_URI && r.method === "PUT") return resp(200, "", { etag: "IGNOREDACT=" });
      if (r.url.includes("/activation"))
        return resp(200, `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`, OK_XML);
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "set_impl_active",
      name: "ZMCP_ENH_BADI",
      spec: { active: false },
      affects: AFFECTS_SPOT,
      activate: false,
    });

    const text = okText(result);
    expect(text).toContain("changed: true");
    expect(text).toContain("activated: true");
    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(true);
  });

  it("a NO-OP (requested active state already matches) is never activated — matches write_description's own no-op discipline", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_XML_WITH_DESC, OK_XML);
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "set_impl_active",
      name: "ZMCP_ENH_BADI",
      spec: { active: true }, // ENHOXH_XML_WITH_DESC's ZMCP_BADI_I1 is already isActive="true"
      affects: AFFECTS_SPOT,
    });

    const text = okText(result);
    expect(text).toContain("changed: false");
    expect(text).not.toContain("activated:");
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("PUT");
    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(false);
  });

  it("a failed activation (real captured error checklist) reports activated:false without throwing, and surfaces activationMessages — set_impl_active's own copy of write_description's failure-as-data discipline", async () => {
    const { conn } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_XML_WITH_DESC, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXH_URI && r.method === "PUT") return resp(200, "", { etag: "FAILACT=" });
      if (r.url.includes("/activation")) return resp(200, ACTIVATION_ERRORS, OK_XML);
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "set_impl_active",
      name: "ZMCP_ENH_BADI",
      spec: { active: false },
      affects: AFFECTS_SPOT,
    });

    const text = okText(result);
    expect(text).toContain("changed: true");
    expect(text).toContain("activated: false");
    expect(text).toContain("Activation did NOT succeed");
    expect(text).toContain("activationMessages");
  });

  it("spec.implName plumbs end-to-end through the real MCP tool call stack — with two entries present, it selects ZMCP_BADI_I2 and leaves ZMCP_BADI_I1 untouched", async () => {
    // Full stack (schema -> runEnhSetActiveOperation -> setBadiImplementationActive)
    // against a document with TWO <enho:badiImplementation> entries, where
    // omitting spec.implName would be refused as ambiguous. This is the
    // tool-layer counterpart to enhancement-write.test.ts's adt-layer
    // "explicit implName selecting the second of several entries" test.
    // Uses the WITH_DESC variant — see ENHOXH_XML_WITH_DESC's own doc
    // comment above — since this test's concern is implName resolution,
    // not the pre-lock description guard.
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_TWO_IMPLS_XML_WITH_DESC, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === ENHOXH_URI && r.method === "PUT") return resp(200, "", { etag: "SYNETAG2=" });
      // Ninth-instance fix — see the sibling test above for why this route
      // must now be stubbed even though this test's own concern is implName
      // resolution, not activation.
      if (r.url.includes("/activation"))
        return resp(200, `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`, OK_XML);
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "set_impl_active",
      name: "ZMCP_ENH_BADI",
      spec: { active: false, implName: "ZMCP_BADI_I2" },
      affects: AFFECTS_SPOT,
    });

    const text = okText(result);
    expect(text).toContain("implName: ZMCP_BADI_I2");
    // GET (resolve), LOCK, reread GET, PUT, UNLOCK, then activation (the
    // ninth-instance fix — see the sibling describe block above) — one more
    // verb than before the fix, appended strictly after UNLOCK.
    expect(adt.verbs).toEqual(["GET", "LOCK", "GET", "PUT", "UNLOCK", "POST"]);
    expect(adt.calls.at(-1)?.url.includes("/activation")).toBe(true);
    const put = adt.calls.find((c) => c.method === "PUT" && c.url === ENHOXH_URI);
    expect(put?.body).toBe(patchBadiImplementationActive(ENHOXH_TWO_IMPLS_XML_WITH_DESC, "ZMCP_BADI_I2", false));
    // The first entry's own isActive attribute is untouched — still "true" —
    // proving the write targeted only the requested entry.
    const i1Match = put!.body.match(/enho:name="ZMCP_BADI_I1"[^>]*enho:isActive="(\w+)"/);
    const i2Match = put!.body.match(/enho:name="ZMCP_BADI_I2"[^>]*enho:isActive="(\w+)"/);
    expect(i1Match?.[1]).toBe("true");
    expect(i2Match?.[1]).toBe("false");
  });

  it("omitting spec.implName with two entries present is refused BAD_INPUT naming both — never guesses", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_TWO_IMPLS_XML, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      return undefined;
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "set_impl_active",
      name: "ZMCP_ENH_BADI",
      spec: { active: false },
      affects: AFFECTS_SPOT,
    });

    const payload = errorPayload(result);
    expect(payload["error"]).toBe("BAD_INPUT");
    const details = payload["details"] as Record<string, unknown> | undefined;
    expect(details?.["knownEntries"]).toEqual(["ZMCP_BADI_I1", "ZMCP_BADI_I2"]);
    expect(adt.calls.some((c) => c.qs._action === "LOCK")).toBe(false);
  });
});

describe("abap_enh — spec.active is genuinely declared in the registered zod schema", () => {
  it("config.inputSchema, as actually registered with the MCP SDK, is the literal object EnhInput wraps — not a hand-written lookalike", async () => {
    const { conn } = await connected(() => undefined);
    const { tools } = await registered(conn);
    // Reference identity, not structural equality: proves the schema object
    // handed to mcp.registerTool is the SAME object EnhInput (and therefore
    // `type EnhInput = z.infer<typeof EnhInput>`, the handler's own input
    // type) is built from — not a parallel, driftable copy.
    expect(tools.get("abap_enh")!.config.inputSchema).toBe(enhInputSchema);
  });

  it("EnhInput.parse (the same schema real request validation would run) accepts spec.active and preserves it exactly, not silently stripped", () => {
    const parsed = EnhInput.parse({
      operation: "set_impl_active",
      name: "ZMCP_ENH_BADI",
      spec: { active: false, decoyField: "must also survive, spec is a record" },
      affects: AFFECTS_SPOT,
    });
    expect(parsed.spec).toEqual({ active: false, decoyField: "must also survive, spec is a record" });
    expect((parsed.spec as { active: unknown }).active).toBe(false);
  });

  it("EnhInput.parse also preserves spec.implName exactly (the fix for the container-name/entry-name defect) — this is the specific field the earlier `args as never` registration cast could have silently stripped had it still been in place", () => {
    const parsed = EnhInput.parse({
      operation: "set_impl_active",
      name: "ZMCP_ENH_BADI",
      spec: { active: false, implName: "ZMCP_BADI_I2", decoyField: "must also survive, spec is a record" },
      affects: AFFECTS_SPOT,
    });
    expect(parsed.spec).toEqual({
      active: false,
      implName: "ZMCP_BADI_I2",
      decoyField: "must also survive, spec is a record",
    });
    expect((parsed.spec as { implName: unknown }).implName).toBe("ZMCP_BADI_I2");
  });

  it("EnhInput.parse also preserves spec.description exactly (create_impl's root-cause fix) — the same registration-cast bug class (`args as never`) that previously silently stripped undeclared spec fields would make this field vanish while 4,300+ other tests stayed green, so this must be proven against the REAL registered schema, not a handler-level assumption", () => {
    const parsed = EnhInput.parse({
      operation: "create_impl",
      name: "ZMCP_ENH_BADI",
      spec: {
        spotName: "ZMCP_SPOT",
        badiName: "ZMCP_BADI",
        implName: "ZMCP_IMPL",
        implClass: "ZCL_MCP_IMPL",
        active: true,
        description: "Fritz's BAdI impl.",
        decoyField: "must also survive, spec is a record",
      },
      affects: AFFECTS_SPOT,
    });
    expect(parsed.spec).toEqual({
      spotName: "ZMCP_SPOT",
      badiName: "ZMCP_BADI",
      implName: "ZMCP_IMPL",
      implClass: "ZCL_MCP_IMPL",
      active: true,
      description: "Fritz's BAdI impl.",
      decoyField: "must also survive, spec is a record",
    });
    expect((parsed.spec as { description: unknown }).description).toBe("Fritz's BAdI impl.");
  });

  it("EnhInput.parse also preserves spec.description exactly for create_spot (the ENHS/XS sibling of create_impl's root-cause fix) — same registration-cast bug class, proven against the REAL registered schema, not a handler-level assumption", () => {
    const parsed = EnhInput.parse({
      operation: "create_spot",
      name: "ZMCP_SPOT",
      spec: {
        description: "Fritz's spot.",
        decoyField: "must also survive, spec is a record",
      },
      affects: AFFECTS_SPOT,
    });
    expect(parsed.spec).toEqual({
      description: "Fritz's spot.",
      decoyField: "must also survive, spec is a record",
    });
    expect((parsed.spec as { description: unknown }).description).toBe("Fritz's spot.");
  });

  it("fakeMcp()'s invoke() bypasses zod validation entirely (unlike the real SDK) — confirmed so the two tests above, not invoke(), are what actually prove schema-level survival", async () => {
    const { conn } = await connected(() => undefined);
    const { tools } = await registered(conn);
    // Passing a value real validation would reject (active as a string, not a
    // bool) all the way through to the handler without a ZodError proves
    // fakeMcp() really does skip validation — so this file's OTHER tests that
    // invoke() with valid-looking input are not incidentally exercising real
    // schema enforcement, and the EnhInput.parse() test above is load-bearing.
    const result = await invoke(tools, "abap_enh", {
      operation: "set_impl_active",
      name: "not-a-real-object",
      spec: { active: "true" }, // wrong type: string, not boolean
      affects: AFFECTS_SPOT,
    });
    // fakeMcp()'s invoke() never runs a real zod parse, so the malformed
    // value is NOT rejected by the schema (a ZodError) — it reaches the
    // handler as-is, and only `requireSpecBool` (runtime, not zod) rejects
    // it, as a BAD_INPUT AbapError.
    const payload = errorPayload(result);
    expect(payload["error"]).toBe("BAD_INPUT");
    expect((payload["details"] as Record<string, unknown> | undefined)?.["field"]).toBe("active");
  });
});

describe("abap_enh — every operation the schema declares has its own explicit dispatch branch (structural guard)", () => {
  /**
   * Enumerated by INTROSPECTING the actual registered schema object
   * (`config.inputSchema.operation`, a `z.enum([...]).optional()`), not by
   * re-typing the operation list by hand — so this list can never silently
   * drift from what callers can actually request. `.unwrap()` peels the
   * `ZodOptional`, `.options` is zod v4's own enum-values accessor.
   */
  function declaredOperations(tools: Map<string, { config: Record<string, unknown> }>): string[] {
    const schema = (tools.get("abap_enh")!.config.inputSchema as Record<string, unknown>).operation as {
      unwrap: () => { options: string[] };
    };
    return schema.unwrap().options;
  }

  it("the introspected list exactly matches the four operation-family arrays enh.ts itself exports, union write_description — confirms the introspection technique is sound", async () => {
    const { conn } = await connected(() => undefined);
    const { tools } = await registered(conn);
    const expected = [
      "write_description",
      ...ENH_CREATE_OPERATIONS,
      ...ENH_HOOK_OPERATIONS,
      ...ENH_DELETE_OPERATIONS,
      ...ENH_ACTIVATION_OPERATIONS,
    ];
    expect(declaredOperations(tools).slice().sort()).toEqual(expected.slice().sort());
  });

  /**
   * For every operation the schema declares, invoke with the minimal input
   * that reaches THAT operation's own first runtime validation call
   * (`requireAffects`/`requireSpecStr`/`requireSpecBool`, each of which
   * embeds the literal `operation` string it was called with in both the
   * thrown message and `details.operation`) before any network call fires.
   * A misrouted operation — e.g. set_impl_active silently falling through to
   * the create catch-all, or to another create case — would surface a
   * DIFFERENT `details.operation` (or a wholly different error shape/an
   * actual network call), so this is a real behavioural fingerprint of which
   * code path handled the request, not a restatement of the dispatch code.
   */
  it.each(
    [
      "write_description",
      ...ENH_CREATE_OPERATIONS,
      ...ENH_HOOK_OPERATIONS,
      ...ENH_DELETE_OPERATIONS,
      ...ENH_ACTIVATION_OPERATIONS,
    ].map((op) => [op] as const),
  )('operation:"%s" reaches its own branch, zero network calls, before failing on its own missing input', async (op) => {
    const { conn, adt } = await connected(() => undefined);
    const { tools } = await registered(conn);

    const baseArgs: Record<string, unknown> = { name: "Z", operation: op };
    // write_description and delete both check `type` before `affects` — give
    // them a valid one so the fingerprinting requireAffects call is reached
    // rather than an earlier, differently-shaped UNSUPPORTED error.
    if (op === "write_description" || op === "delete") {
      baseArgs["type"] = "ENHO/XH";
    }
    // write_description additionally requires `description` before `affects`.
    if (op === "write_description") {
      baseArgs["description"] = "irrelevant";
    }
    // Every other operation (the six create ops, set_impl_active) reaches
    // requireAffects/requireSpecBool as its very first check with no `spec`
    // at all — EXCEPT discover_hook_anchors/create_hook, whose first check is
    // requireSpecStr(spec, "hostType", ...) inside specRequiredHost, reached
    // with no `spec` either.

    const result = await invoke(tools, "abap_enh", baseArgs);
    const payload = errorPayload(result);
    expect(payload["error"]).toBe("BAD_INPUT");
    const details = payload["details"] as Record<string, unknown> | undefined;
    expect(details?.["operation"]).toBe(op);
    // Zero network calls: every one of these fingerprints fires before
    // ensureConnected/pool.withWrite ever runs — a misroute that reached
    // real wire code (a different operation's LOCK/PUT choreography) would
    // both fail this and likely throw an unrouted-request Error instead.
    expect(adt.calls).toHaveLength(0);
  });
});

// ===========================================================================
// `create_spot`, `add_badi_def`, `add_filter_def`, `create_impl`,
// `set_filter_values`, and `create_hook` all CREATE or otherwise mutate a
// real ADT object, yet none of them referenced `deps.journal` at all — every
// one of them landed on (or changed) a server object with no journal entry,
// despite doc/JOURNAL/journal-format.md claiming enhancement writes were journalled. Only
// write_description/set_impl_active/delete were ever covered (see the
// "abap_enh — the write journal" describe block above). These pin the fix:
// one test per operation, each asserting the entry's `operation`, its
// `object` identity (name/type/uri/package), and `irreversible: true` — the
// value every one of them must carry, because `undoBlocker()`
// (src/adt/undo.ts) refuses undo unconditionally for any ENHS/XS, ENHO/XH,
// or ENHO/XHH object, regardless of which operation produced the entry. A
// record that omitted `irreversible: true` would advertise a rollback
// abap_journal will always decline — exactly the class of bug where the
// journal promises an undo it can never honor.
// ===========================================================================

describe("abap_enh — the six create/mutate operations are now journalled", () => {
  const withJournal = async (fn: (j: Journal) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "abapsmith-enh-journal2-"));
    try {
      await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  const INTF_COLLECTION = "/sap/bc/adt/oo/interfaces";

  /**
   * GET-404 -> POST-create -> LOCK -> PUT source -> UNLOCK, generalized over
   * an arbitrary collection + object name — same shape as
   * createSpotBridgeRoute/createImplBridgeRoute above (this file's own
   * one-copy-per-suite convention, not a shared harness), but parameterized
   * so it can also cover the H21 marker-interface write add_badi_def performs
   * before its own bridge class.
   */
  function objectHappyPathRoute(collectionUrl: string, objName: string): Route {
    const objUrl = `${collectionUrl}/${objName.toLowerCase()}`;
    const sourceUri = `${objUrl}/source/main`;
    return (r: Recorded) => {
      if (r.url === objUrl && r.method === "GET" && !r.qs._action) {
        const res = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
        throw new HttpClientException(
          "Request failed with status code 404",
          "404",
          404,
          undefined,
          r as unknown as HttpClientOptions,
          res,
        );
      }
      if (r.url === collectionUrl && r.method === "POST") return resp(200, "", {});
      if (r.url === objUrl && r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML_H, OK_XML);
      if (r.url === objUrl && r.qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
      if (r.url === sourceUri && r.method === "PUT") return resp(200, "", { "content-type": "text/plain" });
      return undefined;
    };
  }

  /** classrun output + the generic /activation stub every bridge call (and
   *  set_filter_values's joint spot+implementation re-activation) needs. */
  function classrunSharedRoute(tags: readonly string[]): Route {
    return (r: Recorded) => {
      if (r.url.startsWith("/sap/bc/adt/oo/classrun/")) return resp(200, tags.join("\n"), { "content-type": "text/plain" });
      if (r.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
      return undefined;
    };
  }

  function combineRoutes(...routes: Route[]): Route {
    return (r: Recorded) => {
      for (const route of routes) {
        const hit = route(r);
        if (hit) return hit;
      }
      return undefined;
    };
  }

  it("create_spot: records operation:create, object ENHS/XS at spotUri, irreversible:true", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(createSpotBridgeRoute(["SPOT-OBJECT-CREATED"]));
      const { tools } = await registered(conn, { journal });

      okText(
        await invoke(tools, "abap_enh", {
          operation: "create_spot",
          name: "ZMCP_SPOT",
          spec: { description: "A spot" },
          affects: AFFECTS_SPOT,
        }),
      );

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.operation).toBe("create");
      expect(entry.outcome).toBe("succeeded");
      expect(entry.object.name).toBe("ZMCP_SPOT");
      expect(entry.object.type).toBe("ENHS/XS");
      expect(entry.object.uri).toBe("/sap/bc/adt/enhancements/enhsxs/zmcp_spot");
      expect(entry.object.package).toBe(ENH_CREATE_PACKAGE);
      expect(entry.existedBefore).toBe(false);
      // Deliberately "unknown", not "confirmed-absent": nothing in this codebase has ever
      // captured what CL_ENH_FACTORY=>CREATE_ENHANCEMENT_SPOT does when a spot by this name
      // already exists, so this call cannot claim the stronger value (contrast create_hook's
      // own test below, whose evidence is a plain conn.post + explicit 201 check).
      expect(entry.beforeCapture).toBe("unknown");
      expect(entry.irreversible).toBe(true);
    });
  });

  it("create_spot: still records the entry, settled failed, when the bridge transcript never confirms the create — proving begin() ran before the mutating call", async () => {
    await withJournal(async (journal) => {
      // No SPOT-OBJECT-CREATED tag in the classrun output -> assertEnhTranscript
      // throws inside createEnhancementSpot, AFTER onBeforeImage(undefined) has already
      // fired. If begin() only ran once the mutation had already succeeded, a thrown
      // mutation would leave zero entries behind — it does not.
      const { conn } = await connected(createSpotBridgeRoute([]));
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_enh", {
        operation: "create_spot",
        name: "ZMCP_SPOT",
        spec: { description: "A spot" },
        affects: AFFECTS_SPOT,
      });
      expect(result.isError).toBe(true);

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.outcome).toBe("failed");
      expect(entries[0]!.irreversible).toBe(true);
    });
  });

  it("add_badi_def: records operation:update against the SPOT (not badiName), beforeCapture:failed, irreversible:true", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(
        combineRoutes(
          objectHappyPathRoute(INTF_COLLECTION, "ZIF_MCP_BADI"),
          objectHappyPathRoute(CLASS_COLLECTION, BRIDGE_CLASS.addBadiDef),
          classrunSharedRoute(["BADI-DEF-ADDED"]),
        ),
      );
      const { tools } = await registered(conn, { journal });

      okText(
        await invoke(tools, "abap_enh", {
          operation: "add_badi_def",
          name: "ZMCP_SPOT",
          spec: { badiName: "ZMCP_BADI", interfaceName: "ZIF_MCP_BADI", singleUse: true, shortText: "test" },
          affects: AFFECTS_SPOT,
        }),
      );

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.operation).toBe("update");
      expect(entry.outcome).toBe("succeeded");
      // The SPOT's identity, not badiName — badiName is an entry within the
      // spot's own document, not a separate ADT object.
      expect(entry.object.name).toBe("ZMCP_SPOT");
      expect(entry.object.type).toBe("ENHS/XS");
      expect(entry.object.uri).toBe("/sap/bc/adt/enhancements/enhsxs/zmcp_spot");
      expect(entry.existedBefore).toBe(true);
      expect(entry.beforeCapture).toBe("failed");
      expect(entry.irreversible).toBe(true);
    });
  });

  it("add_badi_def: still records the entry, settled failed, when the bridge transcript never confirms the add", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(
        combineRoutes(
          objectHappyPathRoute(INTF_COLLECTION, "ZIF_MCP_BADI"),
          objectHappyPathRoute(CLASS_COLLECTION, BRIDGE_CLASS.addBadiDef),
          classrunSharedRoute([]), // no BADI-DEF-ADDED tag -> assertEnhTranscript throws
        ),
      );
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_enh", {
        operation: "add_badi_def",
        name: "ZMCP_SPOT",
        spec: { badiName: "ZMCP_BADI", interfaceName: "ZIF_MCP_BADI", singleUse: true, shortText: "test" },
        affects: AFFECTS_SPOT,
      });
      expect(result.isError).toBe(true);

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.outcome).toBe("failed");
      expect(entries[0]!.irreversible).toBe(true);
    });
  });

  it("add_filter_def: records operation:update against the SPOT (not filterName), beforeCapture:failed, irreversible:true", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(
        combineRoutes(objectHappyPathRoute(CLASS_COLLECTION, BRIDGE_CLASS.addFilterDef), classrunSharedRoute(["FILTER-DEF-ADDED"])),
      );
      const { tools } = await registered(conn, { journal });

      okText(
        await invoke(tools, "abap_enh", {
          operation: "add_filter_def",
          name: "ZMCP_SPOT",
          spec: { badiName: "ZMCP_BADI", filterName: "FLT", filterType: "C" },
          affects: AFFECTS_SPOT,
        }),
      );

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.operation).toBe("update");
      expect(entry.object.name).toBe("ZMCP_SPOT");
      expect(entry.object.type).toBe("ENHS/XS");
      expect(entry.object.uri).toBe("/sap/bc/adt/enhancements/enhsxs/zmcp_spot");
      expect(entry.existedBefore).toBe(true);
      expect(entry.beforeCapture).toBe("failed");
      expect(entry.irreversible).toBe(true);
    });
  });

  it("add_filter_def: still records the entry, settled failed, when the bridge transcript never confirms the add", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(
        combineRoutes(
          objectHappyPathRoute(CLASS_COLLECTION, BRIDGE_CLASS.addFilterDef),
          classrunSharedRoute([]), // no FILTER-DEF-ADDED tag -> assertEnhTranscript throws
        ),
      );
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_enh", {
        operation: "add_filter_def",
        name: "ZMCP_SPOT",
        spec: { badiName: "ZMCP_BADI", filterName: "FLT", filterType: "C" },
        affects: AFFECTS_SPOT,
      });
      expect(result.isError).toBe(true);

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.outcome).toBe("failed");
      expect(entries[0]!.irreversible).toBe(true);
    });
  });

  it("create_impl: records operation:create, object ENHO/XH at implUri, irreversible:true", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(
        createImplBridgeRoute(["ENHO-OBJECT-CREATED", "IMPL-ADDED", "BADI-NO-FILTERS"]),
      );
      const { tools } = await registered(conn, { journal });

      okText(
        await invoke(tools, "abap_enh", {
          operation: "create_impl",
          name: "ZMCP_ENH_BADI",
          spec: CREATE_IMPL_SPEC,
          affects: AFFECTS_SPOT,
        }),
      );

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.operation).toBe("create");
      expect(entry.object.name).toBe("ZMCP_ENH_BADI");
      expect(entry.object.type).toBe("ENHO/XH");
      expect(entry.object.uri).toBe("/sap/bc/adt/enhancements/enhoxh/zmcp_enh_badi");
      expect(entry.existedBefore).toBe(false);
      // Same "unknown, not confirmed-absent" reasoning as create_spot's own test above:
      // classrun success is not a checked precondition on the name being free.
      expect(entry.beforeCapture).toBe("unknown");
      expect(entry.irreversible).toBe(true);
    });
  });

  it("create_impl: still records the entry, settled failed, when the bridge transcript never confirms the create", async () => {
    await withJournal(async (journal) => {
      // Missing ENHO-OBJECT-CREATED/IMPL-ADDED tags -> assertEnhTranscript throws.
      const { conn } = await connected(createImplBridgeRoute([]));
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_enh", {
        operation: "create_impl",
        name: "ZMCP_ENH_BADI",
        spec: CREATE_IMPL_SPEC,
        affects: AFFECTS_SPOT,
      });
      expect(result.isError).toBe(true);

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.outcome).toBe("failed");
      expect(entries[0]!.irreversible).toBe(true);
    });
  });

  it("set_filter_values: records operation:update against the existing ENHO/XH, beforeCapture:failed, irreversible:true", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(
        combineRoutes(objectHappyPathRoute(CLASS_COLLECTION, BRIDGE_CLASS.setFilterValues), classrunSharedRoute(["IMPL-REPLACED"])),
      );
      const { tools } = await registered(conn, { journal });

      okText(
        await invoke(tools, "abap_enh", {
          operation: "set_filter_values",
          name: "ZMCP_ENH_BADI",
          spec: {
            spotName: "ZMCP_SPOT",
            implName: "ZMCP_IMPL",
            filterName: "FLT",
            filterType: "C",
            compare: "EQ",
            value: "X",
          },
          affects: AFFECTS_SPOT,
        }),
      );

      // TWO entries, not one: set_filter_values issues an H23 *joint* activation
      // POST that mutates two distinct objects — the ENHO/XH implementation and
      // the ENHS/XS spot. doc/JOURNAL/journal-format.md's per-object rule requires one entry per
      // mutated object, so the spot gets its own `activate` entry.
      const entries = await journal.list();
      expect(entries).toHaveLength(2);

      const entry = entries.find((e) => e.object.type === "ENHO/XH")!;
      expect(entry, "the implementation's own entry must still be recorded").toBeDefined();
      expect(entry.operation).toBe("update");
      expect(entry.object.name).toBe("ZMCP_ENH_BADI");
      expect(entry.object.type).toBe("ENHO/XH");
      expect(entry.object.uri).toBe("/sap/bc/adt/enhancements/enhoxh/zmcp_enh_badi");
      expect(entry.existedBefore).toBe(true);
      expect(entry.beforeCapture).toBe("failed");
      expect(entry.irreversible).toBe(true);

      // The spot is mutated by the same POST and was previously invisible in the
      // journal — this is the entry that used to go unrecorded.
      const spot = entries.find((e) => e.object.type === "ENHS/XS")!;
      expect(spot, "the jointly-activated spot must have its own entry").toBeDefined();
      expect(spot.operation).toBe("activate");
      expect(spot.object.name).toBe("ZMCP_SPOT");
      expect(spot.object.uri).toBe("/sap/bc/adt/enhancements/enhsxs/zmcp_spot");
      expect(spot.existedBefore).toBe(true);
      expect(spot.beforeCapture).toBe("failed");
      expect(spot.irreversible).toBe(true);
      // The src/journal.ts:1152 trap: an empty systemKey silently persists nothing,
      // so assert the field is actually present and non-empty on disk.
      expect(spot.systemKey).toBeTruthy();
      expect(spot.systemKey).toBe(entry.systemKey);
    });
  });

  it("set_filter_values: still records the entry, settled failed, when the bridge transcript never confirms IMPL-REPLACED (before the H23 joint activation is ever reached)", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(
        combineRoutes(
          objectHappyPathRoute(CLASS_COLLECTION, BRIDGE_CLASS.setFilterValues),
          classrunSharedRoute([]), // no IMPL-REPLACED tag -> assertEnhTranscript throws
        ),
      );
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_enh", {
        operation: "set_filter_values",
        name: "ZMCP_ENH_BADI",
        spec: {
          spotName: "ZMCP_SPOT",
          implName: "ZMCP_IMPL",
          filterName: "FLT",
          filterType: "C",
          compare: "EQ",
          value: "X",
        },
        affects: AFFECTS_SPOT,
      });
      expect(result.isError).toBe(true);

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.outcome).toBe("failed");
      expect(entries[0]!.irreversible).toBe(true);
    });
  });

  it("create_hook: records operation:create, object ENHO/XHH at the deterministic hook URI, irreversible:true, activation.attempted:false when spec.activate is omitted", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected((r: Recorded) => {
        if (r.url === "/sap/bc/adt/enhancements/enhoxhh" && r.method === "POST") {
          return resp(201, "", {
            etag: "20260805153916000application/vnd.sap.adt.enh.enhoxhh.v2+xml",
            location: "/sap/bc/adt/enhancements/enhoxhh/zmcp_enh_b",
          });
        }
        return undefined;
      });
      // create_hook needs cfg.allowEnhancements/allowSourcePlugins/user, which
      // the shared depsFor() above intentionally does not set (no other test
      // in this file exercises create_hook end-to-end) — built by hand here
      // instead of widening depsFor's signature for a single test.
      const { mcp, tools } = fakeMcp();
      const deps: EnhToolDeps = {
        pool: fakePool(conn),
        safety: gate(),
        ensureConnected: async () => {},
        errorResult,
        cfg: {
          maxResponseChars: 30_000,
          allowEnhancements: true,
          allowSourcePlugins: true,
          allowEnhancementDelete: true,
          user: "DEVELOPER",
        },
        transport: localTransport(),
        journal,
      };
      registerEnhancementTools(mcp, deps);

      okText(
        await invoke(tools, "abap_enh", {
          operation: "create_hook",
          name: "ZMCP_ENH_B",
          description: "ZMCP recon hook impl",
          spec: {
            hostType: "PROG/P",
            hostName: "ZMCP_BADI_HOST",
            hostUri: "/sap/bc/adt/programs/programs/zmcp_badi_host",
            anchorFullName: "\\PR:ZMCP_BADI_HOST\\FO:COMPUTE\\SE:END\\EI",
            anchorFullDescription: "Form COMPUTE, End",
          },
          affects: AFFECTS_HOOK,
        }),
      );

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.operation).toBe("create");
      expect(entry.outcome).toBe("succeeded");
      expect(entry.object.name).toBe("ZMCP_ENH_B");
      expect(entry.object.type).toBe("ENHO/XHH");
      expect(entry.object.uri).toBe("/sap/bc/adt/enhancements/enhoxhh/zmcp_enh_b");
      expect(entry.existedBefore).toBe(false);
      // Unlike the classrun-backed creates (create_spot/create_impl), this call's evidence
      // IS strong enough for "confirmed-absent": createHookImplementation only returns
      // normally past its own `resp.status !== 201` check, and the transport throws on any
      // non-2xx before that — a normal return is the server having accepted this POST as a
      // CREATE, same shape createBusinessObject's own confirmed-absent relies on (bopf.ts).
      expect(entry.beforeCapture).toBe("confirmed-absent");
      expect(entry.irreversible).toBe(true);
      // create_hook's activation is OPTIONAL (spec.activate, default false) —
      // not requested here, so settle() must record attempted:false, never a
      // misleading activated:false.
      expect(entry.activation?.attempted).toBe(false);
      expect(entry.activation?.activated).toBeUndefined();
    });
  });

  it("create_hook: still records the entry, settled failed, when the POST answers something other than 201 — proving begin() ran before the mutating call", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected((r: Recorded) => {
        if (r.url === "/sap/bc/adt/enhancements/enhoxhh" && r.method === "POST") {
          // The real transport throws (rather than returning a response object) on a
          // non-2xx status — see postHookImplementation's own comment in
          // enhancement-hook.ts — so the fixture must throw here too, the same way
          // this file's other 404 routes do above, not just return a 500 value.
          const res = resp(500, "<exc:exception/>", { "content-type": "application/xml" });
          throw new HttpClientException(
            "Request failed with status code 500",
            "500",
            500,
            undefined,
            r as unknown as HttpClientOptions,
            res,
          );
        }
        return undefined;
      });
      const { mcp, tools } = fakeMcp();
      const deps: EnhToolDeps = {
        pool: fakePool(conn),
        safety: gate(),
        ensureConnected: async () => {},
        errorResult,
        cfg: {
          maxResponseChars: 30_000,
          allowEnhancements: true,
          allowSourcePlugins: true,
          allowEnhancementDelete: true,
          user: "DEVELOPER",
        },
        transport: localTransport(),
        journal,
      };
      registerEnhancementTools(mcp, deps);

      const result = await invoke(tools, "abap_enh", {
        operation: "create_hook",
        name: "ZMCP_ENH_B",
        description: "ZMCP recon hook impl",
        spec: {
          hostType: "PROG/P",
          hostName: "ZMCP_BADI_HOST",
          hostUri: "/sap/bc/adt/programs/programs/zmcp_badi_host",
          anchorFullName: "\\PR:ZMCP_BADI_HOST\\FO:COMPUTE\\SE:END\\EI",
          anchorFullDescription: "Form COMPUTE, End",
        },
        affects: AFFECTS_HOOK,
      });
      expect(result.isError).toBe(true);

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.outcome).toBe("failed");
      expect(entries[0]!.irreversible).toBe(true);
    });
  });
});

// ===========================================================================
// Defect: create_impl used to report a reference to an
// implementing class it never creates — SE19 generates that class shell,
// abapsmith does not. createBadiImplementation now probes
// GET /oo/classes/<implClass> (non-fatal) and the tool layer turns the
// outcome into a note. The probe must never turn a successful create into a
// failure: these tests pin the note text AND that the create's own tags are
// still reported in every case.
// ===========================================================================

describe("abap_enh — create_impl's implClass note reflects whether the class actually exists", () => {
  const CLASS_PROBE_URL = `${CLASS_COLLECTION}/${CREATE_IMPL_SPEC.implClass.toLowerCase()}`;

  /** Layers a class-probe answer onto createImplBridgeRoute without touching it. */
  function withClassProbe(tags: readonly string[], probe: Route): Route {
    const base = createImplBridgeRoute(tags);
    return (r) => (r.url === CLASS_PROBE_URL && r.method === "GET" && !r.qs._action ? probe(r) : base(r));
  }

  it("names implClass as DOES NOT EXIST and points at abap_write CLAS/OC when the probe 404s, without failing the create", async () => {
    const { conn } = await connected(
      withClassProbe(["ENHO-OBJECT-CREATED", "IMPL-ADDED", "BADI-NO-FILTERS"], (r) => {
        const res = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
        throw new HttpClientException(
          "Request failed with status code 404",
          "404",
          404,
          undefined,
          r as unknown as HttpClientOptions,
          res,
        );
      }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "create_impl",
      name: "ZMCP_ENH_BADI",
      spec: CREATE_IMPL_SPEC,
      affects: AFFECTS_SPOT,
    });

    const text = okText(result);
    expect(text).toContain("ENHO-OBJECT-CREATED");
    expect(text).toContain("IMPL-ADDED");
    const lower = text.toLowerCase();
    expect(lower).toContain("does not exist");
    expect(lower).toContain("abap_write");
    expect(lower).toContain("clas/oc");
  });

  it("says nothing about the class when the probe confirms it exists, and still reports the created tags", async () => {
    const { conn } = await connected(
      withClassProbe(["ENHO-OBJECT-CREATED", "IMPL-ADDED", "BADI-NO-FILTERS"], () => resp(200, "<class/>", OK_XML)),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "create_impl",
      name: "ZMCP_ENH_BADI",
      spec: CREATE_IMPL_SPEC,
      affects: AFFECTS_SPOT,
    });

    const text = okText(result);
    expect(text).toContain("ENHO-OBJECT-CREATED");
    expect(text).toContain("IMPL-ADDED");
    const lower = text.toLowerCase();
    expect(lower).not.toContain("does not exist");
    expect(lower).not.toContain("could not check");
  });

  it("reports it could not check the class and points at abap_read when the probe fails for a reason other than 404", async () => {
    const { conn } = await connected(
      withClassProbe(["ENHO-OBJECT-CREATED", "IMPL-ADDED", "BADI-NO-FILTERS"], () => {
        throw new Error("socket hang up");
      }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "create_impl",
      name: "ZMCP_ENH_BADI",
      spec: CREATE_IMPL_SPEC,
      affects: AFFECTS_SPOT,
    });

    const text = okText(result);
    expect(text).toContain("ENHO-OBJECT-CREATED");
    expect(text).toContain("IMPL-ADDED");
    const lower = text.toLowerCase();
    expect(lower).toContain("could not check");
    expect(lower).toContain("abap_read");
  });
});
