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
import { parseAtcRunAck, parseCheckVariantList, type AtcCheckVariant, type FlatAtcFinding } from "../src/adt/atc-xml.js";
import {
  atcObjectsLabel,
  registerAtcTools,
  renderAtcResult,
  renderCheckVariants,
  renderWorklistCleanup,
  type AtcToolDeps,
} from "../src/tools/atc.js";

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

  it("advertises the full issue #78 parameter set, none required at the schema level (issue #78)", async () => {
    // Was "exactly the six documented parameters ... object required" before
    // issue #78 (P1: ATC completeness — check variant, package/multi-object
    // runs, worklist delete). That is a deliberate, documented behaviour
    // change: `op` now selects between three key sets (run/variants/
    // delete_worklist), each with its own mutual-exclusion rules (exactly
    // one of object/objects/package for op="run"; worklist_id required for
    // op="delete_worklist") — rules a flat zod `.required()` list cannot
    // express, so they are enforced inside the handler (`validateOpArgs`)
    // instead, and every top-level field stays `.optional()` in the schema.
    const tools = await listedTools(cfg({ readOnly: false, allowPackages: ["$TMP"] }));
    const atc = tools.find((t) => t.name === "abap_atc");
    expect(atc).toBeDefined();
    const schema = atc?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "auto_cleanup",
      "include_exempted",
      "include_subpackages",
      "max_findings",
      "object",
      "objects",
      "op",
      "package",
      "severity",
      "type",
      "variant",
      "worklist_id",
    ]);
    // Every top-level field is `.optional()`, so the generated JSON Schema
    // omits `required` entirely rather than emitting an empty array.
    expect(schema.required ?? []).toEqual([]);
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

/**
 * A GET/POST/DELETE responder for {@link harness}'s fake connection. Return
 * `undefined` to say "not mine" — falls through to the leak-detecting
 * default, same convention as `test/helpers/fake-adt.ts`'s `FakeRoute`.
 */
type ConnRoute = (
  method: "GET" | "POST" | "DELETE",
  url: string,
) => { body: string; status?: number } | undefined;

function harness(
  over: {
    readonly allowPackages?: string[];
    readonly readOnly?: boolean;
    /** Scripts `conn.get`/`conn.post`/`conn.del`, for tests that need a real op=variants/delete_worklist round trip. */
    readonly route?: ConnRoute;
  } = {},
): Harness {
  const poolCalls: string[] = [];
  let connected = false;

  const leak = (method: string) => (): never => {
    throw new Error(`NETWORK CALL LEAKED: this harness has no ATC ${method} response for this URL`);
  };

  const conn = {
    discovery: { assertSupported: () => {} },
    async get(url: string) {
      const r = over.route?.("GET", url);
      if (r) return { body: r.body, status: r.status ?? 200, headers: {} };
      return leak("GET")();
    },
    async post(url: string) {
      const r = over.route?.("POST", url);
      if (r) return { body: r.body, status: r.status ?? 200, headers: {} };
      return leak("POST")();
    },
    async del(url: string) {
      const r = over.route?.("DELETE", url);
      if (r) return { body: r.body, status: r.status ?? 200, headers: {} };
      return leak("DELETE")();
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
      readOnly: over.readOnly ?? false,
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

  it('op defaults to "run" — an omitted op behaves exactly like the pre-#78 tool', async () => {
    const h = harness();
    await h.invoke({ object: "ZCL_X" });
    // Same shape as the "takes a READ slot" test above: reaching the
    // leak-detecting transport at all proves op="run" was assumed and the
    // object scope was accepted, without needing `op` in the call.
    expect(h.poolCalls).toEqual(["abap_atc"]);
  });

  it("rejects an unknown op, naming the allowed values", async () => {
    const h = harness();
    const payload = errorPayload(await h.invoke({ op: "delete", worklist_id: "X" }));
    expect(payload.error).toBe("BAD_INPUT");
    expect(JSON.stringify(payload)).toContain("run");
    expect(JSON.stringify(payload)).toContain("variants");
    expect(JSON.stringify(payload)).toContain("delete_worklist");
    expect(h.connected()).toBe(false);
  });

  it("op=run refuses none-of object/objects/package", async () => {
    const h = harness();
    const payload = errorPayload(await h.invoke({}));
    expect(payload.error).toBe("BAD_INPUT");
    expect(h.connected()).toBe(false);
  });

  it("op=run refuses more than one of object/objects/package", async () => {
    const h = harness();
    const payload = errorPayload(
      await h.invoke({ object: "ZCL_X", package: "$TMP" }),
    );
    expect(payload.error).toBe("BAD_INPUT");
    expect(JSON.stringify(payload)).toContain("object");
    expect(JSON.stringify(payload)).toContain("package");
    expect(h.connected()).toBe(false);
  });

  it("include_subpackages without package is refused", async () => {
    const h = harness();
    const payload = errorPayload(await h.invoke({ object: "ZCL_X", include_subpackages: true }));
    expect(payload.error).toBe("BAD_INPUT");
    expect(JSON.stringify(payload)).toContain("include_subpackages");
    expect(h.connected()).toBe(false);
  });

  it("objects must be a non-empty array", async () => {
    const h = harness();
    const payload = errorPayload(await h.invoke({ objects: [] }));
    expect(payload.error).toBe("BAD_INPUT");
    expect(h.connected()).toBe(false);
  });

  it("objects is capped at ATC_MAX_RUN_TARGETS", async () => {
    const h = harness();
    const tooMany = Array.from({ length: 51 }, (_, i) => `ZCL_X${i}`);
    const payload = errorPayload(await h.invoke({ objects: tooMany }));
    expect(payload.error).toBe("BAD_INPUT");
    expect(JSON.stringify(payload)).toContain("50");
    expect(h.connected()).toBe(false);
  });

  it("worklist_id is refused as irrelevant for op=run", async () => {
    const h = harness();
    const payload = errorPayload(await h.invoke({ object: "ZCL_X", worklist_id: "0A1B2C" }));
    expect(payload.error).toBe("BAD_INPUT");
    expect(JSON.stringify(payload)).toContain("worklist_id");
    expect(h.connected()).toBe(false);
  });

  it("op=delete_worklist needs worklist_id", async () => {
    const h = harness();
    const payload = errorPayload(await h.invoke({ op: "delete_worklist" }));
    expect(payload.error).toBe("BAD_INPUT");
    expect(JSON.stringify(payload)).toContain("worklist_id");
    expect(h.connected()).toBe(false);
  });

  it("op=delete_worklist refuses object/severity/etc as irrelevant", async () => {
    const h = harness();
    const payload = errorPayload(
      await h.invoke({ op: "delete_worklist", worklist_id: "0A1B2C", object: "ZCL_X" }),
    );
    expect(payload.error).toBe("BAD_INPUT");
    expect(JSON.stringify(payload)).toContain("object");
    expect(h.connected()).toBe(false);
  });

  it('op="variants" refuses any per-object or run-shaping parameter', async () => {
    const h = harness();
    const payload = errorPayload(await h.invoke({ op: "variants", severity: "error" }));
    expect(payload.error).toBe("BAD_INPUT");
    expect(JSON.stringify(payload)).toContain("severity");
    expect(h.connected()).toBe(false);
  });

  it("every element of objects is preflight-gated BEFORE connecting — one bad name refuses the whole call for zero cost", async () => {
    const h = harness({ allowPackages: ["$TMP"] });
    const payload = errorPayload(
      await h.invoke({ objects: ["ZCL_OK_LOOKING", "CL_GUI_FRONTEND_SERVICES"] }),
    );
    expect(payload.error).toBe("SAFETY_DENIED");
    expect(h.connected()).toBe(false);
    expect(h.poolCalls).toEqual([]);
  });

  it("a package run preflight-gates the package root as DEVC/K, before connecting", async () => {
    const h = harness({ allowPackages: ["$TMP"] });
    // An SAP-standard-looking package name fails the preflight gate on the
    // name alone, exactly like the single-object case — no round trip made.
    const payload = errorPayload(await h.invoke({ package: "SAP_BASIS" }));
    expect(payload.error).toBe("SAFETY_DENIED");
    expect(h.connected()).toBe(false);
    expect(h.poolCalls).toEqual([]);
  });

  it('op="delete_worklist" refuses under READ_ONLY before any HTTP (target-less capability probe)', async () => {
    const h = harness({ readOnly: true });
    const payload = errorPayload(await h.invoke({ op: "delete_worklist", worklist_id: "0A1B2C" }));
    expect(payload.error).toBe("READ_ONLY");
    expect(h.connected()).toBe(false);
    expect(h.poolCalls).toEqual([]);
  });

  it('op="delete_worklist" is allowed through the gate once writable, and takes a READ slot', async () => {
    const h = harness({ allowPackages: [] });
    // No object is ever named, so an empty allowlist must not matter — this
    // is exactly the target-less-probe behaviour `assertCanDeleteAtcWorklist`
    // documents: a target-shaped SAFETY_DENIED is undecidable here and is
    // treated as allowed.
    await h.invoke({ op: "delete_worklist", worklist_id: "0A1B2C" });
    expect(h.poolCalls).toEqual(["abap_atc"]);
    expect(h.connected()).toBe(true);
  });

  it('op="variants" needs no object allowlisted at all, and never calls the object-targeted gate', async () => {
    const h = harness({ allowPackages: [] });
    // Same reasoning as the delete_worklist test above: op="variants" names
    // no object, so an empty allowlist must not block it either.
    await h.invoke({ op: "variants" });
    expect(h.poolCalls).toEqual(["abap_atc"]);
    expect(h.connected()).toBe(true);
  });
});

// --------------------------------------------------------- op=variants / op=delete_worklist ---

describe("abap_atc op=variants and op=delete_worklist — live-captured bytes", () => {
  it('op="variants" renders the real A4H check variant list (fixture 886), marking the system default from the real customizing read (fixture 893), with no per-object authorize call', async () => {
    // 886-i78-checkvariants-quicksearch.xml: GET .../informationsystem/search
    // ?operation=quickSearch&query=*&maxResults=200&objectType=CHKV, 19
    // variants, alphabetical server order. 893-i78-atc-customizing.xml: GET
    // .../atc/customizing, A4H's systemCheckVariant is ZABAP_CLOUD_DEVELOPMENT
    // (a member of the 886 list). Both served byte-for-byte.
    const variantsBody = readLiveFixture("886-i78-checkvariants-quicksearch.xml");
    const customizingBody = readLiveFixture("893-i78-atc-customizing.xml");
    const h = harness({
      allowPackages: [],
      route: (method, url) => {
        if (method !== "GET") return undefined;
        if (url.includes("informationsystem/search")) return { body: variantsBody };
        if (url.includes("atc/customizing")) return { body: customizingBody };
        return undefined;
      },
    });
    const res = await h.invoke({ op: "variants" });
    expect(res.isError).toBeFalsy();
    const part = res.content[0];
    if (!part || part.type !== "text") throw new Error("expected a text content part");
    expect(part.text).toContain("CHECK VARIANTS");
    expect(part.text).toMatch(/variants:\s*19/);
    expect(part.text).toContain("DEFAULT");
    expect(part.text).toMatch(/DEFAULT marks "ZABAP_CLOUD_DEVELOPMENT"/);
    // The ZABAP_CLOUD_DEVELOPMENT row itself carries the mark...
    expect(part.text).toMatch(/ZABAP_CLOUD_DEVELOPMENT[^\n]*yes/);
    // ...and no other row does.
    const markedRows = part.text.split("\n").filter((line) => /\byes\s*$/.test(line));
    expect(markedRows).toHaveLength(1);
  });

  it('op="variants" still succeeds and lists every variant, without a DEFAULT mark, when the customizing read fails — and says why', async () => {
    const variantsBody = readLiveFixture("886-i78-checkvariants-quicksearch.xml");
    const h = harness({
      allowPackages: [],
      route: (method, url) => {
        if (method !== "GET") return undefined;
        if (url.includes("informationsystem/search")) return { body: variantsBody };
        if (url.includes("atc/customizing")) throw new Error("simulated customizing outage");
        return undefined;
      },
    });
    const res = await h.invoke({ op: "variants" });
    expect(res.isError).toBeFalsy();
    const part = res.content[0];
    if (!part || part.type !== "text") throw new Error("expected a text content part");
    expect(part.text).toContain("CHECK VARIANTS");
    expect(part.text).toMatch(/variants:\s*19/);
    // Some real variant NAMEs (e.g. ABAP_CLOUD_DEVELOPMENT_DEFAULT) contain
    // "DEFAULT" as a substring, so assert the absence of the DEFAULT COLUMN
    // specifically: no row is marked, and the note doesn't claim one is.
    expect(part.text).not.toMatch(/DEFAULT marks/);
    const markedRows = part.text.split("\n").filter((line) => /\byes\s*$/.test(line));
    expect(markedRows).toHaveLength(0);
    expect(part.text).toMatch(/system default could not be determined/);
  });

  it('op="delete_worklist" reports the real 405 refusal (fixture 891) as a refusal, not a success', async () => {
    // 891-i78-worklist-delete-405.xml: DELETE .../atc/worklists/<id>, status
    // 405 ExceptionMethodNotSupported. Served with the real status; the
    // client's own classification (deleted:false, status:405) is what's
    // under test here, not classifyAtcFailure's prose.
    const body = readLiveFixture("891-i78-worklist-delete-405.xml");
    const h = harness({
      allowPackages: [],
      route: (method) => (method === "DELETE" ? { body, status: 405 } : undefined),
    });
    const res = await h.invoke({
      op: "delete_worklist",
      worklist_id: "466F46C806601FE1ABD7F225A1B94069",
    });
    expect(res.isError).toBeFalsy();
    const part = res.content[0];
    if (!part || part.type !== "text") throw new Error("expected a text content part");
    expect(part.text).toMatch(/deleted:\s*false/);
    expect(part.text).toMatch(/status:\s*405/);
    expect(part.text).toMatch(/was NOT deleted — the server refused/);
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
    // Single-object run by default — matches the pre-#78 shape every
    // existing test below assumes. Multi-target tests override it directly.
    targetCount: 1,
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

  // -------------------------------------------------------- issue #78 additions ---

  it("names the 405-refused worklist deletion in its own note, not a bare 'was left behind'", () => {
    // The pre-#78 note only said a worklist was created/reused. Issue #78
    // replaced it to cite the actual, only OBSERVED server behaviour (see
    // the module header of src/adt/atc.ts): DELETE always 405s and the
    // advertised deleteFindings action is a documented no-op.
    const text = render(result());
    expect(text).toMatch(/Worklist 0A1B2C \(created\)/);
    expect(text).toMatch(/refuses to delete ATC worklists \(DELETE returns 405\)/);
    expect(text).toMatch(/deleteFindings.*no-op/);
  });

  it("groups findings by object when a run covers more than one target", () => {
    const findings = [
      finding({ objectName: "ZCL_A", objectType: "CLAS/OC" }),
      finding({ objectName: "ZCL_B", objectType: "CLAS/OC", messageTitle: "Another issue" }),
    ];
    const text = render(result({ findings, targetCount: 2 }));
    expect(text).toContain("CLAS/OC ZCL_A — 1 finding(s)");
    expect(text).toContain("CLAS/OC ZCL_B — 1 finding(s)");
    expect(text).toContain("Another issue");
  });

  it("keeps the flat table for a single-object run even with several findings", () => {
    const findings = [finding({ priority: 1 }), finding({ priority: 2, messageTitle: "A warning" })];
    const text = render(result({ findings, targetCount: 1 }));
    expect(text).not.toMatch(/CLAS\/OC ZCL_X — \d+ finding\(s\)/);
  });

  it("reports the target count in the header once a run covers more than one object", () => {
    const findings = [finding({ objectName: "ZCL_A" }), finding({ objectName: "ZCL_B" })];
    expect(render(result({ findings, targetCount: 2 }))).toMatch(/targets:\s*2/);
    expect(render(result({ targetCount: 1 }))).not.toMatch(/targets:/);
  });

  it("shows a FIX column and explains its labels when any finding advertises a quick fix", () => {
    const withFix = finding({ quickFixes: { manual: false, automatic: true, pseudo: false, aiBased: false, aiEnabled: false, any: true } });
    const text = render(result({ findings: [withFix] }));
    expect(text).toContain("FIX");
    expect(text).toMatch(/automatic/);
    expect(text).toMatch(/abap_quick_fix/);
  });

  it("says plainly that no finding advertised a quick fix, rather than showing an empty FIX column", () => {
    const text = render(result());
    expect(text).not.toContain("FIX");
    expect(text).toMatch(/ATC advertised no quick fix for any finding shown/);
    expect(text).toMatch(/abap_quick_fix has nothing to apply here/);
  });

  it("surfaces each distinct check's documentation link in a DOCS section", () => {
    const f1 = finding({ checkId: "CI_SEC", documentationUri: "/sap/bc/adt/docu/ci_sec" });
    const f2 = finding({
      checkId: "CI_SEC",
      objectName: "ZCL_B",
      documentationUri: "/sap/bc/adt/docu/ci_sec_dup",
    });
    const f3 = finding({ checkId: "CI_PERF", objectName: "ZCL_C", documentationUri: "/sap/bc/adt/docu/ci_perf" });
    const text = render(result({ findings: [f1, f2, f3], targetCount: 3 }));
    expect(text).toContain("--- DOCS ---");
    expect(text).toContain("CI_SEC: /sap/bc/adt/docu/ci_sec");
    // Deduped by checkId: the SECOND CI_SEC finding's link is not repeated.
    expect(text).not.toContain("ci_sec_dup");
    expect(text).toContain("CI_PERF: /sap/bc/adt/docu/ci_perf");
  });

  it("omits the DOCS section entirely when no finding carries a documentation link", () => {
    const text = render(result());
    expect(text).not.toContain("--- DOCS ---");
  });

  it("flags a variant it could not validate as UNVALIDATED, naming it and giving the reason as one coherent sentence", () => {
    // The reason string mirrors what resolveCheckVariant (src/adt/atc.ts)
    // actually produces: a whole sentence, not a bare name. The render site
    // must not mistake it for the variant's NAME.
    const reason =
      'The check-variant list could not be read, so "ZMY_VARIANT" was not validated before use: ' +
      "network timeout";
    const text = render(result({ checkVariant: "ZMY_VARIANT", variantUnvalidated: reason }));
    expect(text).toContain('Check variant "ZMY_VARIANT"');
    expect(text).toMatch(/UNVALIDATED/);
    expect(text).toContain(reason);
    // The old defect wrapped the WHOLE reason sentence in the outer quotes as
    // though it were the variant's name, producing a garbled nested-quote
    // artefact — assert that specific pattern is gone.
    expect(text).not.toContain('variant "The check-variant list');
  });

  it("warns of timeout risk for a package-scoped run, or a large object count, but not a small explicit one", () => {
    const small = render(result({ targetCount: 1 }));
    expect(small).not.toMatch(/TIMEOUT RISK/);

    const pkg = renderAtcResult(
      result({ targetCount: 3 }),
      { objectLabel: "package $TMP", packageScoped: true },
      60_000,
    ).text;
    expect(pkg).toMatch(/TIMEOUT RISK/);
    expect(pkg).toMatch(/package-scoped/);
    expect(pkg).toMatch(/ABAP_TIMEOUT_MS/);

    const many = render(result({ targetCount: 11 }));
    expect(many).toMatch(/TIMEOUT RISK/);
  });

  it("reports a refused auto_cleanup without losing the findings already in hand", () => {
    const text = render(
      result({
        cleanup: {
          worklistId: "0A1B2C",
          deleted: false,
          status: 405,
          reason: "ExceptionMethodNotSupported",
          cacheCleared: false,
        },
      }),
    );
    // The finding from result()'s default is still rendered...
    expect(text).toContain("Dynamic SQL without escaping");
    // ...alongside a note that cleanup was refused, distinct from the
    // worklist-persistence note.
    expect(text).toMatch(/Cleanup: worklist 0A1B2C was NOT deleted — the server refused \(HTTP 405\)/);
    expect(text).toMatch(/still-undeleted worklist/);
  });

  it("reports a successful auto_cleanup distinctly from a refused one", () => {
    const text = render(
      result({
        cleanup: { worklistId: "0A1B2C", deleted: true, status: 200, cacheCleared: true },
      }),
    );
    expect(text).toMatch(/Cleanup: worklist 0A1B2C was deleted\./);
  });
});

// ----------------------------------------------------------- atcObjectsLabel ---

describe("atcObjectsLabel", () => {
  it("spells out every name with no truncation marker at or under the cap", () => {
    const labels = ["CLAS/OC ZCL_A", "CLAS/OC ZCL_B"];
    const text = atcObjectsLabel(labels);
    expect(text).toBe("2 objects (CLAS/OC ZCL_A, CLAS/OC ZCL_B)");
    expect(text).not.toContain("truncated");
  });

  it("caps the spelled-out names and marks the truncation, but keeps the total count exact", () => {
    // objects accepts up to ATC_MAX_RUN_TARGETS (50); 15 is comfortably past
    // the display cap without being unwieldy to assert against.
    const labels = Array.from({ length: 15 }, (_, i) => `CLAS/OC ZCL_${i}`);
    const text = atcObjectsLabel(labels);
    expect(text).toMatch(/^15 objects \(/);
    expect(text).toContain("truncated");
    expect(text).toContain("10 of 15 shown");
    // The 15th name (index 14) is past the cap and must not be spelled out.
    expect(text).not.toContain("ZCL_14");
    // The first (kept) name is still there.
    expect(text).toContain("ZCL_0");
  });
});

// ------------------------------------------------------- renderCheckVariants ---

describe("renderCheckVariants", () => {
  it("lists check variants in server order with a count in the header", () => {
    const variants: AtcCheckVariant[] = [
      { name: "ZABAP_CLOUD_DEVELOPMENT", uri: "/sap/bc/adt/atc/checkvariants/zabap_cloud_development" },
      { name: "ZVARIANT_TWO", uri: "/sap/bc/adt/atc/checkvariants/zvariant_two", description: "Default" },
    ];
    const text = renderCheckVariants(variants, 60_000).text;
    expect(text).toMatch(/variants:\s*2/);
    expect(text).toContain("ZABAP_CLOUD_DEVELOPMENT");
    expect(text).toContain("ZVARIANT_TWO");
    expect(text).toContain("Default");
    // No opts given: no DEFAULT column in the TABLE (the note itself is
    // allowed to use the word "DEFAULT" when explaining why none is marked),
    // and the note says the default could not be determined rather than
    // claiming there is no cheap way to know it.
    const table = text.split("--- CHECK VARIANTS ---")[1] ?? "";
    expect(table).not.toMatch(/\bDEFAULT\b/);
    expect(text).toMatch(/system default could not be determined/);
  });

  it("marks the matching row DEFAULT when a default variant is given", () => {
    const variants: AtcCheckVariant[] = [
      { name: "ZABAP_CLOUD_DEVELOPMENT", uri: "/sap/bc/adt/atc/checkvariants/zabap_cloud_development" },
      { name: "ZDEFAULT", uri: "/sap/bc/adt/atc/checkvariants/zdefault" },
    ];
    const text = renderCheckVariants(variants, 60_000, { defaultVariant: "ZDEFAULT" }).text;
    expect(text).toContain("DEFAULT");
    expect(text).toMatch(/ZDEFAULT[^\n]*yes/);
    expect(text).not.toMatch(/ZABAP_CLOUD_DEVELOPMENT[^\n]*yes/);
    expect(text).toMatch(/DEFAULT marks "ZDEFAULT"/);
    expect(text).not.toMatch(/could not be determined/);
  });

  it("explains why the default could not be marked, without failing the listing", () => {
    const variants: AtcCheckVariant[] = [
      { name: "ZVARIANT_TWO", uri: "/sap/bc/adt/atc/checkvariants/zvariant_two" },
    ];
    const text = renderCheckVariants(variants, 60_000, {
      defaultUnavailable: "network timeout",
    }).text;
    const table = text.split("--- CHECK VARIANTS ---")[1] ?? "";
    expect(table).not.toMatch(/\bDEFAULT\b/);
    expect(text).toMatch(/system default could not be determined.*network timeout/);
  });

  it("parses and renders the real A4H check variant list (fixture 886)", () => {
    const body = readLiveFixture("886-i78-checkvariants-quicksearch.xml");
    const variants = parseCheckVariantList(body);
    expect(variants.length).toBe(19);
    const text = renderCheckVariants(variants, 60_000).text;
    expect(text).toMatch(/variants:\s*19/);
  });
});

// ----------------------------------------------------- renderWorklistCleanup ---

describe("renderWorklistCleanup", () => {
  it("reads a refusal as a refusal, naming the HTTP status", () => {
    const text = renderWorklistCleanup(
      {
        worklistId: "466F46C806601FE1ABD7F225A1B94069",
        deleted: false,
        status: 405,
        reason: "HTTP 405",
        cacheCleared: false,
      },
      60_000,
    ).text;
    expect(text).toMatch(/deleted:\s*false/);
    expect(text).toMatch(/status:\s*405/);
    expect(text).toMatch(/was NOT deleted — the server refused \(HTTP 405\): HTTP 405\./);
    expect(text).toMatch(/kept its cached worklist id.*reuses this same, still-undeleted worklist/);
  });

  it("UNVERIFIED shape: reports a successful delete distinctly (no A4H server has ever accepted DELETE)", () => {
    // No capture anywhere shows ATC DELETE succeeding — A4H's release always
    // answers 405 (see 891-i78-worklist-delete-405.xml). This exercises the
    // success branch of renderWorklistCleanup/AtcWorklistCleanup so the
    // shape is not entirely untested, but it cannot be verified against A4H.
    const text = renderWorklistCleanup(
      { worklistId: "0A1B2C", deleted: true, status: 200, cacheCleared: true },
      60_000,
    ).text;
    expect(text).toMatch(/deleted:\s*true/);
    expect(text).toMatch(/Worklist 0A1B2C was deleted\./);
  });
});
