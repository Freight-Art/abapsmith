/**
 * `ABAP_MCP_TRANSPORT` / `ABAP_MCP_HTTP_HOST` / `ABAP_MCP_HTTP_PORT` /
 * `ABAP_MCP_HTTP_PATH` / `ABAP_MCP_HTTP_TOKEN` — issue #81's remote
 * (Streamable HTTP) MCP transport, wired through `loadConfig`
 * (src/config.ts) alongside the existing stdio-only defaults.
 *
 * The defect this pins ahead of time: a Streamable HTTP listener is a
 * network-reachable endpoint. Left to default to "bind everything, trust
 * everyone", the first operator who sets `ABAP_MCP_TRANSPORT=http` to reach
 * their SAP system from a second machine, without reading past the first
 * line of the README, exposes write access to their SAP system to their
 * whole LAN (or worse) with zero authentication. `loadConfig` is the one
 * place that can refuse this BEFORE the listener ever binds — a refusal
 * inside `src/mcp-http.ts` would be too late (the socket would already be
 * open for the instant between bind and the first request). So the
 * combination "non-loopback host, http transport, no token" must throw
 * here, unconditionally, and every other combination must load.
 *
 * `redactConfigSecrets` is covered too: `mcpHttpTokens` must expose token
 * NAMES (useful for an operator confirming which token is configured) and a
 * count, but never a token VALUE — the same rule password/token/oauth
 * secrets already follow in that function.
 */
import { describe, expect, it } from "vitest";

import { loadConfig, redactConfigSecrets } from "../src/config.js";

const env = (over: Record<string, string> = {}): Record<string, string> => ({
  ABAP_URL: "http://sap.invalid:50000",
  ABAP_USER: "U",
  ABAP_PASSWORD: "pw",
  ...over,
});

function messageOf(fn: () => unknown): string {
  try {
    fn();
    throw new Error("expected loadConfig to throw");
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const load = (over: Record<string, string> = {}, warn: (m: string) => void = () => {}) =>
  loadConfig({ env: env(over), warn, skipDotenv: true });

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe("mcp transport config: defaults", () => {
  it("with no ABAP_MCP_* set, the transport is stdio and http fields hold their documented defaults", () => {
    const cfg = load();
    expect(cfg.mcpTransport).toBe("stdio");
    expect(cfg.mcpHttpHost).toBe("127.0.0.1");
    expect(cfg.mcpHttpPort).toBe(3000);
    expect(cfg.mcpHttpPath).toBe("/mcp");
    expect(cfg.mcpHttpTokens).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ABAP_MCP_TRANSPORT
// ---------------------------------------------------------------------------

describe("mcp transport config: ABAP_MCP_TRANSPORT", () => {
  it("http with the default loopback host and no token loads fine — the operator-friendly local case", () => {
    const cfg = load({ ABAP_MCP_TRANSPORT: "http" });
    expect(cfg.mcpTransport).toBe("http");
    expect(cfg.mcpHttpHost).toBe("127.0.0.1");
  });

  it("is case-insensitive and trims surrounding whitespace, normalising to lowercase 'http'", () => {
    const cfg = load({ ABAP_MCP_TRANSPORT: "  HTTP  " });
    expect(cfg.mcpTransport).toBe("http");
  });

  it("an unrecognised value throws, naming ABAP_MCP_TRANSPORT and both valid values", () => {
    const msg = messageOf(() => load({ ABAP_MCP_TRANSPORT: "sse" }));
    expect(msg).toContain("ABAP_MCP_TRANSPORT");
    expect(msg).toContain("stdio");
    expect(msg).toContain("http");
  });
});

// ---------------------------------------------------------------------------
// The core issue #81 requirement: refuse unauthenticated non-loopback binds
// ---------------------------------------------------------------------------

describe("mcp transport config: refuses to start unauthenticated on a non-loopback address", () => {
  it.each([
    ["a wildcard bind", "0.0.0.0"],
    ["a routable private address", "192.168.1.10"],
    ["the IPv6 wildcard bind", "::"],
  ])("%s (%s) with the http transport and no token throws, naming ABAP_MCP_HTTP_TOKEN and the loopback rule", (_label, host) => {
    const msg = messageOf(() => load({ ABAP_MCP_TRANSPORT: "http", ABAP_MCP_HTTP_HOST: host }));
    expect(msg).toContain("ABAP_MCP_HTTP_TOKEN");
    expect(msg.toLowerCase()).toContain("loopback");
  });

  it("the SAME non-loopback host with a token configured loads, and cfg.mcpHttpTokens carries it", () => {
    const cfg = load({
      ABAP_MCP_TRANSPORT: "http",
      ABAP_MCP_HTTP_HOST: "0.0.0.0",
      ABAP_MCP_HTTP_TOKEN: "team=s3cr3t",
    });
    expect(cfg.mcpTransport).toBe("http");
    expect(cfg.mcpHttpHost).toBe("0.0.0.0");
    expect(cfg.mcpHttpTokens).toEqual([{ name: "team", value: "s3cr3t" }]);
  });

  it("ABAP_MCP_HTTP_HOST=0.0.0.0 with the transport left at its stdio default and no token loads fine — the refusal is about the http transport, not the host variable on its own", () => {
    const cfg = load({ ABAP_MCP_HTTP_HOST: "0.0.0.0" });
    expect(cfg.mcpTransport).toBe("stdio");
    expect(cfg.mcpHttpHost).toBe("0.0.0.0");
  });
});

// ---------------------------------------------------------------------------
// ABAP_MCP_HTTP_PORT
// ---------------------------------------------------------------------------

describe("mcp transport config: ABAP_MCP_HTTP_PORT", () => {
  it("0 loads — it means 'OS-chosen free port', not 'unset'", () => {
    const cfg = load({ ABAP_MCP_HTTP_PORT: "0" });
    expect(cfg.mcpHttpPort).toBe(0);
  });

  it.each(["70000", "-1", "abc"])("%s throws — out of range or not a number", (value) => {
    expect(() => load({ ABAP_MCP_HTTP_PORT: value })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ABAP_MCP_HTTP_PATH
// ---------------------------------------------------------------------------

describe("mcp transport config: ABAP_MCP_HTTP_PATH", () => {
  it("a value without a leading slash throws, naming ABAP_MCP_HTTP_PATH", () => {
    const msg = messageOf(() => load({ ABAP_MCP_HTTP_PATH: "mcp" }));
    expect(msg).toContain("ABAP_MCP_HTTP_PATH");
  });
});

// ---------------------------------------------------------------------------
// ABAP_MCP_HTTP_TOKEN set while the transport is stdio
// ---------------------------------------------------------------------------

describe("mcp transport config: ABAP_MCP_HTTP_TOKEN with the stdio transport", () => {
  it("loads fine, and warns that the token is set but ignored", () => {
    const warnings: string[] = [];
    const cfg = load({ ABAP_MCP_HTTP_TOKEN: "s3cr3t" }, (m) => warnings.push(m));
    expect(cfg.mcpTransport).toBe("stdio");
    expect(
      warnings.some((w) => w.includes("ABAP_MCP_HTTP_TOKEN") && /ignored/i.test(w)),
      `no ignored-token warning in: ${JSON.stringify(warnings)}`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// redactConfigSecrets
// ---------------------------------------------------------------------------

describe("mcp transport config: redactConfigSecrets never leaks token values", () => {
  it("reports token names and a count, but neither secret value ever appears in the serialised output", () => {
    const cfg = load({
      ABAP_MCP_TRANSPORT: "http",
      ABAP_MCP_HTTP_TOKEN: "alice=s3cr3t-do-not-log,plain-token-do-not-log",
    });
    const redacted = redactConfigSecrets(cfg);
    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain("s3cr3t-do-not-log");
    expect(serialised).not.toContain("plain-token-do-not-log");
    expect(serialised).toContain("alice");
    const mcpHttpTokens = redacted.mcpHttpTokens as { count: number; names: string[] };
    expect(mcpHttpTokens.count).toBe(2);
  });

  it("mcpTransport / mcpHttpHost / mcpHttpPort / mcpHttpPath pass through verbatim — none of them are secrets", () => {
    const cfg = load({
      ABAP_MCP_TRANSPORT: "http",
      ABAP_MCP_HTTP_HOST: "127.0.0.1",
      ABAP_MCP_HTTP_PORT: "4000",
      ABAP_MCP_HTTP_PATH: "/custom-mcp",
    });
    const redacted = redactConfigSecrets(cfg);
    expect(redacted.mcpTransport).toBe("http");
    expect(redacted.mcpHttpHost).toBe("127.0.0.1");
    expect(redacted.mcpHttpPort).toBe(4000);
    expect(redacted.mcpHttpPath).toBe("/custom-mcp");
  });

  it("with no ABAP_MCP_HTTP_TOKEN set, mcpHttpTokens renders '(not set)', not a zero-count object implying one was considered", () => {
    const cfg = load();
    expect(redactConfigSecrets(cfg).mcpHttpTokens).toBe("(not set)");
  });
});
