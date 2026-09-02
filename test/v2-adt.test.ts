/**
 * `abap_adt`'s pre-network validation chain.
 *
 * Every test in this file uses `ForbiddenClient` — a fake `HttpClient` that
 * throws on ANY request — so a passing refusal test is proof the refusal is
 * genuinely pre-network, not merely "the mock happened to return an error".
 * This deliberately mirrors `test/tools-v2-budget.test.ts`'s harness (copied
 * and extended locally rather than importing it — that file's own header
 * explains why: no shared knob for `abapMode`/`toolSurface` exists to import).
 *
 * What is NOT here: a successful GET. `abap_adt` ships GET-only by design,
 * and the real call is verified live against the A4H appliance (standing
 * project rule — offline green never substitutes for wire verification), not
 * simulated with a fake response here.
 */
import { describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { createServer, type AbapsmithServer } from "../src/server.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import type { AbapMode } from "../src/mode.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------- fixtures ---

/**
 * Throws "NETWORK CALL LEAKED" on any request. Wrapped by
 * `routeSystemRoleProbe` below purely to declare this suite's intent to
 * `test/system-role-probe-guard.test.ts`'s sweep — none of the tests here
 * actually reach `ensureConnected()`/`connect()` (every one is a pre-network
 * refusal), so the probe route is never really exercised, but the guard scans
 * source text, not runtime behaviour.
 */
class ForbiddenClient implements HttpClient {
  async request(_o: HttpClientOptions): Promise<HttpClientResponse> {
    throw new Error("NETWORK CALL LEAKED: abap_adt's pre-network validation chain must refuse before the wire");
  }
}

function cfg(abapMode: AbapMode): Config {
  return {
    ...ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "TESTUSER",
      password: "secret",
      sid: "TST",
      client: "001",
      toolSurface: "v2",
    }),
    abapMode,
  };
}

interface Harness {
  srv: AbapsmithServer;
  client: Client;
}

async function harness(config: Config): Promise<Harness> {
  const srv = createServer(config, {
    httpClient: routeSystemRoleProbe(new ForbiddenClient(), { answer: "nonproductive" }),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-v2-adt", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);
  return { srv, client };
}

type CallToolReturn = Awaited<ReturnType<Client["callTool"]>>;

const call = (h: Harness, args: Record<string, unknown>): Promise<CallToolReturn> =>
  h.client.callTool({ name: "abap_adt", arguments: args });

const isErr = (res: CallToolReturn): boolean => "isError" in res && res.isError === true;

const textOf = (res: CallToolReturn): string => {
  if (!("content" in res)) return "";
  return res.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
};

const EXAMPLE_PATH = "/sap/bc/adt/repository/nodestructure";

// ---------------------------------------------------------------------------

describe("abap_adt pre-network validation chain", () => {
  it("bare call self-describes (Rule 2) and never touches the network", async () => {
    const h = await harness(cfg("read"));
    const res = await call(h, {});
    expect(isErr(res)).toBe(false);
    const text = textOf(res);
    expect(text).not.toContain("NETWORK CALL LEAKED");
    expect(text).toContain("raw ADT REST escape hatch");
    expect(text).toContain("NEXT:");
  });

  it("ordering fix: a call that is otherwise bare wins over path validation, even with an empty (invalid) path", async () => {
    // `path: ""` is simultaneously (a) invalid per validateAdtPath (empty path
    // is refused) and (b) bare per isBareCall's own rule (empty string counts
    // as bare). This is the one case that actually distinguishes
    // "bare-check first" from "validate-then-bare-check" — if path
    // validation ran first, this would be a BAD_INPUT error instead.
    const h = await harness(cfg("read"));
    const res = await call(h, { path: "" });
    expect(isErr(res)).toBe(false);
    const text = textOf(res);
    expect(text).not.toContain("NETWORK CALL LEAKED");
    expect(text).toContain("raw ADT REST escape hatch");
    expect(text).not.toContain("BAD_INPUT");
  });

  it("rejects an absolute URL path", async () => {
    const h = await harness(cfg("read"));
    const res = await call(h, { path: "http://evil.example/sap/bc/adt/repository/nodestructure" });
    expect(isErr(res)).toBe(true);
    const text = textOf(res);
    expect(text).not.toContain("NETWORK CALL LEAKED");
    expect(text).toContain("BAD_INPUT");
    expect(text).toContain("absolute URL");
    expect(text).toContain("retryable: true"); // a different path would work
  });

  it("rejects a protocol-relative (leading //) path", async () => {
    const h = await harness(cfg("read"));
    const res = await call(h, { path: "//evil.example/sap/bc/adt/repository/nodestructure" });
    expect(isErr(res)).toBe(true);
    const text = textOf(res);
    expect(text).not.toContain("NETWORK CALL LEAKED");
    expect(text).toContain("BAD_INPUT");
    expect(text).toContain("protocol-relative");
  });

  it('rejects a path containing a ".." segment', async () => {
    const h = await harness(cfg("read"));
    const res = await call(h, { path: "/sap/bc/adt/repository/../../../etc/passwd" });
    expect(isErr(res)).toBe(true);
    const text = textOf(res);
    expect(text).not.toContain("NETWORK CALL LEAKED");
    expect(text).toContain("BAD_INPUT");
    expect(text).toContain('".."');
  });

  it('rejects a path missing the "/sap/bc/adt/" prefix', async () => {
    const h = await harness(cfg("read"));
    const res = await call(h, { path: "/not/an/adt/path" });
    expect(isErr(res)).toBe(true);
    const text = textOf(res);
    expect(text).not.toContain("NETWORK CALL LEAKED");
    expect(text).toContain("BAD_INPUT");
    expect(text).toContain("/sap/bc/adt/");
  });

  describe("header deny-list", () => {
    const denied = ["authorization", "cookie", "set-cookie", "x-csrf-token", "host", "content-length", "connection"];

    for (const key of denied) {
      it(`refuses the whole call when headers carries "${key}"`, async () => {
        const h = await harness(cfg("read"));
        const res = await call(h, { path: EXAMPLE_PATH, headers: { [key]: "whatever" } });
        expect(isErr(res)).toBe(true);
        const text = textOf(res);
        expect(text).not.toContain("NETWORK CALL LEAKED");
        expect(text).toContain("BAD_INPUT");
        expect(text.toLowerCase()).toContain(key);
      });
    }

    it("is case-insensitive (Authorization, mixed case)", async () => {
      const h = await harness(cfg("read"));
      const res = await call(h, { path: EXAMPLE_PATH, headers: { Authorization: "Bearer xyz" } });
      expect(isErr(res)).toBe(true);
      const text = textOf(res);
      expect(text).not.toContain("NETWORK CALL LEAKED");
      expect(text).toContain("BAD_INPUT");
    });

    it("does not refuse a header that is not on the deny-list", async () => {
      // This call still reaches the real GET (Accept is not denied), which
      // ForbiddenClient then refuses at the network layer — proving the
      // header check itself let it through rather than refusing locally.
      const h = await harness(cfg("read"));
      const res = await call(h, { path: EXAMPLE_PATH, headers: { Accept: "application/xml" } });
      expect(isErr(res)).toBe(true);
      const text = textOf(res);
      expect(text).toContain("NETWORK CALL LEAKED");
    });
  });

  it("non-GET is refused under non-admin mode (READ_ONLY) without touching the network", async () => {
    const h = await harness(cfg("read"));
    const res = await call(h, { method: "POST", path: EXAMPLE_PATH });
    expect(isErr(res)).toBe(true);
    const text = textOf(res);
    expect(text).not.toContain("NETWORK CALL LEAKED");
    expect(text).toContain("READ_ONLY");
    expect(text).toContain("retryable: true"); // GET (or admin mode) would work
  });

  it("non-GET is refused under edit mode too (READ_ONLY) — GET-only is not admin-specific", async () => {
    const h = await harness(cfg("edit"));
    const res = await call(h, { method: "PUT", path: EXAMPLE_PATH, body: "x" });
    expect(isErr(res)).toBe(true);
    const text = textOf(res);
    expect(text).not.toContain("NETWORK CALL LEAKED");
    expect(text).toContain("READ_ONLY");
  });

  it("non-GET under admin mode is STILL refused (structural blocker, not a mode ceiling) — NOT_IMPLEMENTED, not silently functional", async () => {
    const h = await harness(cfg("admin"));
    const res = await call(h, { method: "POST", path: EXAMPLE_PATH, body: "x" });
    expect(isErr(res)).toBe(true);
    const text = textOf(res);
    expect(text).not.toContain("NETWORK CALL LEAKED");
    expect(text).toContain("NOT_IMPLEMENTED");
    // notImplemented is a deliberate design decision: no retry of this exact
    // call can ever succeed, and the message reads as terminal, not merely
    // descriptive.
    expect(text).toContain("retryable: false");
    expect(text).toMatch(/no retry.*will (ever )?succeed/i);
  });

  it("method is case-normalized (lowercase get is treated as GET, not refused)", async () => {
    // Reaches the real GET (proving normalization happened before the
    // allowlist check), which ForbiddenClient then refuses at the network
    // layer — that is the expected outcome for a validly-shaped GET in this
    // offline suite.
    const h = await harness(cfg("read"));
    const res = await call(h, { method: "get", path: EXAMPLE_PATH });
    expect(isErr(res)).toBe(true);
    const text = textOf(res);
    expect(text).toContain("NETWORK CALL LEAKED");
  });

  it("every response — success or refusal — carries a non-empty NEXT block (Rule 3)", async () => {
    const h = await harness(cfg("read"));
    const cases: Record<string, unknown>[] = [
      {},
      { path: "" },
      { path: "http://evil.example/x" },
      { path: "/not/adt" },
      { method: "DELETE", path: EXAMPLE_PATH },
    ];
    for (const args of cases) {
      const res = await call(h, args);
      const text = textOf(res);
      expect(text, `abap_adt(${JSON.stringify(args)}) missing NEXT: block`).toContain("NEXT:");
      expect(text, `abap_adt(${JSON.stringify(args)}) NEXT: block is empty`).not.toContain("NEXT:\n(none)");
    }
  });
});
