/**
 * `abap_atc` — the tool surface over `src/adt/atc.ts`.
 *
 * Two things are pinned here, and the first is the important one.
 *
 * ## 1. The registration gate
 *
 * The REAL `abap_atc` (six documented parameters, a `withRead` slot, an
 * actual ATC run) registers only when the server can write. That is stricter
 * than "static analysis is a read" intuition suggests, and the reason is in
 * the header of `src/adt/atc.ts`: running ATC **creates a persistent
 * worklist row on the server**, and `execute` is the operation that carries
 * the Z/Y-prefix and package-allowlist rules.
 *
 * A read-only deployment does NOT simply lose the tool, though — as of issue
 * #63 it gets a mode-locked refusal STUB registered under the same name
 * (`src/tools/locked.ts`), with an empty input schema and a description that
 * says outright that it is locked and what unlocks it. The old assumption
 * that "present and refusing still advertises a capability the deployment
 * does not have" turned out to be the wrong tradeoff in practice: the prior
 * behavior (registering nothing at all) made a call to `abap_atc` on a
 * read-only server indistinguishable from a typo'd tool name — `MCP error
 * -32602: Tool abap_atc not found` either way. Discoverability of the LOCKED
 * state, with a self-explaining reason, now wins over hiding the name.
 *
 * That gate is asserted in BOTH directions against the REAL server over an
 * in-memory MCP transport, which is the only thing that can answer "what does
 * `tools/list` actually say".
 *
 * ## 2. The rendering, and specifically its refusals to look clean
 *
 * A static-analysis tool that reports a truncated or stale result as a clean
 * one is worse than no tool. Three notes exist for that and each is pinned:
 * `INCOMPLETE:` when ATC stopped at the verdict cap, `UNSCOPED:` when the
 * server named no `LAST_RUN` object set and the findings may include an earlier
 * run's, and the "clean for THAT variant" wording on an empty result.
 *
 * ## No network, and no captured ATC bytes anywhere
 *
 * There are no ATC recordings in this repo, in `abap-adt-api`, or anywhere this
 * branch can reach — see the header of `test/atc.test.ts`. The `AtcRunResult`
 * values below are built directly as SYNTHETIC structs rather than parsed from
 * invented XML, so nothing here can be mistaken for a recording of what SAP
 * sends.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { createServer, errorResult, type AbapsmithServer } from "../src/server.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import { SafetyGate } from "../src/safety.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type { SessionPool } from "../src/adt/pool.js";
import type { AtcRunResult } from "../src/adt/atc.js";
import { parseAtcRunAck, type FlatAtcFinding } from "../src/adt/atc-xml.js";
import { registerAtcTools, renderAtcResult, type AtcToolDeps } from "../src/tools/atc.js";

const LIVE_FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "live-captured",
);
const readLiveFixture = (name: string): string => readFileSync(join(LIVE_FIXTURES, name), "utf8");

// ------------------------------------------------------------------ config ---

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

/**
 * Like {@link listedTools}, but leaves the `Client` open and returns it too —
 * for tests (issue #63's locked-stub gate) that need to both inspect
 * `tools/list` AND call a tool over the same in-memory connection. Callers
 * own the returned client and must `close()` it.
 */
async function connectedTools(config: Config): Promise<{ tools: Tool[]; client: Client }> {
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
  return { tools, client };
}

// ------------------------------------------------------- registration gate ---

describe("abap_atc registration gate", () => {
  it("is advertised as a locked refusal stub, not the real tool, on a read-only server (issue #63)", async () => {
    // `cfg({ readOnly: true })` is the LEGACY branch, not `ABAP_MODE=read`:
    // `cfg()` spreads `over` on top of a plain `ConfigSchema.parse()` result,
    // and `abapMode`/`capabilities` are never produced by that schema at all
    // (see the `Config` type's doc comment in src/config.ts — they're bolted
    // on only by `loadConfig()`'s env-driven resolution). So this config's
    // `abapMode` is `undefined`, and the stub's remediation must name the
    // legacy env var (`ABAP_ALLOW_WRITE`), not `ABAP_MODE=edit`.
    const { tools, client } = await connectedTools(cfg({ readOnly: true }));
    try {
      const atc = tools.find((t) => t.name === "abap_atc");
      expect(atc, "abap_atc missing from a read-only server's tool list").toBeDefined();

      // No inputSchema at all (an empty-object schema) is what distinguishes
      // the stub from the real tool, whose schema has six properties (see
      // "advertises exactly the six documented parameters" above).
      const properties = (atc?.inputSchema as { properties?: Record<string, unknown> } | undefined)
        ?.properties;
      expect(properties === undefined || Object.keys(properties).length === 0).toBe(true);
      expect(atc?.description ?? "").toContain("LOCKED");

      // Calling it must refuse structurally, not attempt a network round trip
      // (the ForbiddenClient wired into connectedTools would throw on any
      // HTTP request) — a stub handler holds no pool/connection dependency.
      const res = await client.callTool({ name: "abap_atc", arguments: { object: "ZCL_X" } });
      expect(res.isError).toBe(true);
      const part = res.content[0];
      if (!part || part.type !== "text") throw new Error("expected a text content part");
      const payload = JSON.parse(part.text) as { error?: string; message?: string; hint?: string };
      expect(payload.error).toBe("READ_ONLY");
      expect(payload.message ?? "").toContain("abap_atc");
      expect(payload.message ?? "").toContain("Nothing was sent to the SAP system.");
      expect(payload.hint ?? "").toContain("ABAP_ALLOW_WRITE=true");
    } finally {
      await client.close();
    }
  });

  it("is advertised once the server can write", async () => {
    const tools = await listedTools(cfg({ readOnly: false, allowPackages: ["$TMP"] }));
    expect(tools.map((t) => t.name)).toContain("abap_atc");
  });

  it("a read-only server's tool list DOES mention ATC — as a self-explaining locked stub (issue #63)", async () => {
    // Reversed on purpose. The old assertion here (`blob` must not match
    // /\bATC\b/) encoded the pre-#63 belief that a read-only deployment
    // should not even learn ATC exists, or "it will ask for it". Issue #63
    // is exactly the rejection of that: hiding the tool made a legitimate
    // call indistinguishable from a typo ("Tool abap_atc not found" either
    // way), so the fix registers a locked stub under the real name instead.
    // Do NOT restore the old "must not mention ATC" assertion — the stub's
    // whole point is that the tool list explains, unprompted, why abap_atc
    // is here but refuses.
    const tools = await listedTools(cfg({ readOnly: true }));
    const atc = tools.find((t) => t.name === "abap_atc");
    expect(atc, "abap_atc missing from a read-only server's tool list").toBeDefined();
    const description = atc?.description ?? "";
    expect(description).toMatch(/ATC|ABAP Test Cockpit/);
    expect(description).toContain("LOCKED");
    // Names the legacy remediation flag for this (abapMode-less) config —
    // see the previous test's comment for why it's this flag and not
    // ABAP_MODE=edit.
    expect(description).toContain("ABAP_ALLOW_WRITE=true");
  });

  it("advertises exactly the six documented parameters, all but one optional", async () => {
    const tools = await listedTools(cfg({ readOnly: false, allowPackages: ["$TMP"] }));
    const atc = tools.find((t) => t.name === "abap_atc");
    expect(atc).toBeDefined();
    const schema = atc?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "include_exempted",
      "max_findings",
      "object",
      "severity",
      "type",
      "variant",
    ]);
    expect(schema.required).toEqual(["object"]);
  });

  it("is honest in its description: headless is the only thing it adds", async () => {
    const tools = await listedTools(cfg({ readOnly: false, allowPackages: ["$TMP"] }));
    const atc = tools.find((t) => t.name === "abap_atc");
    const description = atc?.description ?? "";
    // Not an assertion about prose style — about not overselling. The
    // description must say what it does NOT do, or a model will reach for it
    // expecting analysis SAP does not already ship.
    expect(description).toMatch(/does not need an IDE|without an IDE/i);
    expect(description).toMatch(/computes nothing SAP does not already compute/i);
    // And must say the result is variant-relative rather than absolute.
    expect(description).toMatch(/FOR THAT VARIANT/);
  });

  it("declares annotations that match what a run actually does", async () => {
    const tools = await listedTools(cfg({ readOnly: false, allowPackages: ["$TMP"] }));
    const atc = tools.find((t) => t.name === "abap_atc");
    // Not read-only (it creates a worklist) but not destructive either (nothing
    // existing is touched). Getting the second one wrong in the "safe" direction
    // would teach a caller to ignore destructiveHint everywhere.
    expect(atc?.annotations?.readOnlyHint).toBe(false);
    expect(atc?.annotations?.destructiveHint).toBe(false);
    expect(atc?.annotations?.idempotentHint).toBe(false);
  });
});

// --------------------------------------------------------- handler harness ---

/** Captures `registerTool` into a map instead of talking to an MCP client. */
function fakeMcp(): {
  mcp: McpServer;
  tools: Map<
    string,
    { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }
  >;
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

interface Harness {
  invoke: (args: unknown) => Promise<CallToolResult>;
  /** Pool operations, in order. Empty means the handler never reached a slot. */
  poolCalls: string[];
  /** True once `ensureConnected` ran — i.e. the wire was going to be touched. */
  connected: () => boolean;
}

function harness(over: { readonly allowPackages?: string[] } = {}): Harness {
  const poolCalls: string[] = [];
  let connected = false;

  const conn = {
    discovery: { assertSupported: () => {} },
    async get() {
      throw new Error("NETWORK CALL LEAKED: this harness has no ATC responses");
    },
    async post() {
      throw new Error("NETWORK CALL LEAKED: this harness has no ATC responses");
    },
  } as unknown as AbapConnection;

  const pool = {
    withRead: <T,>(op: string, fn: (c: AbapConnection) => Promise<T>) => {
      poolCalls.push(op);
      return fn(conn);
    },
    // Present so a regression that reaches for the WRITE slot is visible as a
    // failure here rather than as a silent serialisation of every ATC run.
    withWrite: <T,>(op: string, _fn: (c: AbapConnection) => Promise<T>): Promise<T> => {
      poolCalls.push(`WRITE:${op}`);
      throw new Error("abap_atc must not take the write slot");
    },
  } as unknown as SessionPool;

  const deps: AtcToolDeps = {
    pool,
    safety: new SafetyGate({
      readOnly: false,
      allowPackages: over.allowPackages ?? ["$TMP"],
      writesLockedOut: false,
    }),
    ensureConnected: async () => {
      connected = true;
    },
    errorResult,
    cfg: { maxResponseChars: 60_000 },
  };

  const { mcp, tools } = fakeMcp();
  registerAtcTools(mcp, deps);
  const entry = tools.get("abap_atc");
  if (!entry) throw new Error("abap_atc was never registered");
  return { invoke: entry.handler, poolCalls, connected: () => connected };
}

const errorPayload = (res: CallToolResult): Record<string, unknown> => {
  expect(res.isError).toBe(true);
  const part = res.content[0];
  if (!part || part.type !== "text") throw new Error("expected a text content part");
  return JSON.parse(part.text) as Record<string, unknown>;
};

describe("abap_atc handler", () => {
  it("refuses an argument it does not have, naming it", async () => {
    const h = harness();
    const payload = errorPayload(await h.invoke({ object: "ZCL_X", severity_level: "error" }));
    expect(payload.error).toBe("BAD_INPUT");
    expect(JSON.stringify(payload)).toContain("severity_level");
    // And never reaches the wire.
    expect(h.connected()).toBe(false);
    expect(h.poolCalls).toEqual([]);
  });

  it("refuses a non-allowlisted object BEFORE connecting — a refusal costs zero requests", async () => {
    const h = harness({ allowPackages: ["$TMP"] });
    // An SAP-standard name fails the preflight gate on the name alone, with no
    // package known and no round trip made.
    const payload = errorPayload(await h.invoke({ object: "CL_GUI_FRONTEND_SERVICES" }));
    expect(payload.error).toBe("SAFETY_DENIED");
    expect(h.connected()).toBe(false);
    expect(h.poolCalls).toEqual([]);
  });

  it("takes a READ slot, never the write slot", async () => {
    const h = harness();
    // Resolution will fail against the leak-detecting transport; what matters is
    // WHICH slot was taken on the way there.
    await h.invoke({ object: "ZCL_X" });
    expect(h.poolCalls).toEqual(["abap_atc"]);
    expect(h.connected()).toBe(true);
  });
});

// --------------------------------------------------------------- rendering ---

/** SYNTHETIC. Not parsed from XML, so it cannot be mistaken for a capture. */
function finding(over: Partial<FlatAtcFinding> = {}): FlatAtcFinding {
  return {
    uri: "/sap/bc/adt/atc/findings/1",
    location: { uri: "/sap/bc/adt/oo/classes/zcl_x/source/main", line: 17 },
    priority: 1,
    checkId: "CI_SEC",
    checkTitle: "Security checks",
    messageId: "0001",
    messageTitle: "Dynamic SQL without escaping",
    exemptionKind: "",
    exemptionApproval: "",
    objectName: "ZCL_X",
    objectType: "CLAS/OC",
    objectUri: "/sap/bc/adt/oo/classes/zcl_x",
    ...over,
  };
}

/** SYNTHETIC. */
function result(over: Partial<AtcRunResult> = {}): AtcRunResult {
  const findings = over.findings ?? [finding()];
  return {
    checkVariant: "ZDEFAULT",
    worklistId: "0A1B2C",
    worklistReused: false,
    scopedToLastRun: true,
    objectSetIsComplete: true,
    maxVerdicts: 100,
    infos: [],
    findings,
    counts: {
      total: findings.length,
      errors: findings.filter((f) => f.priority === 1).length,
      warnings: findings.filter((f) => f.priority === 2).length,
      infos: findings.filter((f) => f.priority === 3).length,
      other: findings.filter((f) => f.priority === 0).length,
      exempted: findings.filter((f) => f.exemptionKind !== "").length,
    },
    worklist: {
      id: "0A1B2C",
      objectSetIsComplete: true,
      objectSets: [],
      objects: [],
    },
    ...over,
  };
}

const render = (r: AtcRunResult, severity?: string): string =>
  renderAtcResult(
    r,
    { objectLabel: "CLAS/OC ZCL_X", ...(severity === undefined ? {} : { severity }) },
    60_000,
  ).text;

describe("renderAtcResult", () => {
  it("lists a finding with its severity, line, check and message", () => {
    const text = render(result());
    expect(text).toContain("error");
    expect(text).toContain("ZCL_X:17");
    expect(text).toContain("Security checks");
    expect(text).toContain("Dynamic SQL without escaping");
  });

  it("says a clean result is clean FOR THAT VARIANT, not that the object is correct", () => {
    const text = render(result({ findings: [], counts: {
      total: 0, errors: 0, warnings: 0, infos: 0, other: 0, exempted: 0,
    } }));
    expect(text).toMatch(/No findings/);
    expect(text).toMatch(/THAT variant/);
    expect(text).toMatch(/not a statement that the object is correct/i);
  });

  it("marks a capped run INCOMPLETE rather than letting it read as clean", () => {
    const text = render(result({ objectSetIsComplete: false, maxVerdicts: 5 }));
    expect(text).toContain("INCOMPLETE:");
    expect(text).toContain("max_findings");
  });

  it("marks an unscoped read UNSCOPED and warns the findings may be stale", () => {
    const text = render(result({ scopedToLastRun: false }));
    expect(text).toContain("UNSCOPED:");
    expect(text).toMatch(/earlier run/i);
  });

  it("names the worklist it left behind, and whether it created it", () => {
    expect(render(result())).toMatch(/Worklist 0A1B2C \(created\)/);
    expect(render(result({ worklistReused: true }))).toMatch(/Worklist 0A1B2C \(reused\)/);
  });

  it("filters by severity cumulatively and SAYS how many it hid", () => {
    const findings = [
      finding({ priority: 1 }),
      finding({ priority: 2, messageTitle: "A warning" }),
      finding({ priority: 3, messageTitle: "A note" }),
    ];
    const r = result({ findings });

    const errorsOnly = render(r, "error");
    expect(errorsOnly).not.toContain("A warning");
    expect(errorsOnly).not.toContain("A note");
    expect(errorsOnly).toMatch(/2 finding\(s\) below severity "error" are not listed/);

    const warnings = render(r, "warning");
    expect(warnings).toContain("A warning");
    expect(warnings).not.toContain("A note");

    // info is the default and hides nothing.
    expect(render(r, "info")).toContain("A note");
    expect(render(r)).toContain("A note");
  });

  it("never filters out a finding whose severity the server did not state", () => {
    // Priority 0 means "the server did not say". Hiding it would be exactly the
    // silent omission this tool must not make.
    const r = result({
      findings: [finding({ priority: 0, messageTitle: "Unlabelled finding" })],
    });
    expect(render(r, "error")).toContain("Unlabelled finding");
  });

  it("shows the exemption column only when something is exempted", () => {
    expect(render(result())).not.toContain("EXEMPT");
    const exempt = result({ findings: [finding({ exemptionKind: "A" })] });
    expect(render(exempt)).toContain("EXEMPT");
  });

  it("passes through the server's own remarks about the run", () => {
    const text = render(
      result({ infos: [{ type: "W", description: "Some objects were skipped" }] }),
    );
    expect(text).toContain("Some objects were skipped");
  });

  it("puts the counts in the header so a caller need not tally rows", () => {
    const findings = [finding({ priority: 1 }), finding({ priority: 2 }), finding({ priority: 2 })];
    const text = render(result({ findings }));
    expect(text).toMatch(/findings[:=]\s*3/);
    expect(text).toMatch(/errors[:=]\s*1/);
    expect(text).toMatch(/warnings[:=]\s*2/);
  });

  it("dedupes a real run's duplicate <atcinfo:info> nodes to one NOTE line", () => {
    // `438-atc2-run.xml` is a real ADT capture (A4H, 2026-08-01) that
    // contains two byte-identical <atcinfo:info> nodes — the server sends the
    // duplicate, not this client. parseAtcRunAck faithfully keeps both; the
    // fix belongs at the render site, so this test runs both stages against
    // the real bytes.
    const ack = parseAtcRunAck(readLiveFixture("438-atc2-run.xml"));
    expect(ack.infos).toHaveLength(2);
    expect(ack.infos[0]).toEqual(ack.infos[1]);

    const text = render(result({ infos: ack.infos }));
    const noteLines = text.split("\n").filter((line) => line.includes("NOTE: ATC:"));
    expect(noteLines).toHaveLength(1);
    expect(noteLines[0]).toContain("0,1,0");
  });
});
