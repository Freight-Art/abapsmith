/**
 * `abap_quick_fix` — the MCP handler in `registerQuickFixTools`, not the
 * `abapQuickFix` core (that's test/quickfix-tool.test.ts, which never runs
 * the handler). Pins `explainReadOnlyRefusal` (src/tools/quickfix.ts): it
 * augments a READ_ONLY refusal with a sentence about mode="list" also
 * POSTing the whole object source, and must leave every other code alone.
 * Also pins the handler's own zero-network unknown-arg refusal and its
 * mode-to-pool-slot routing. Same harness idiom as test/tools-atc.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorResult } from "../src/server.js";
import { SafetyGate } from "../src/safety.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type { SessionPool } from "../src/adt/pool.js";
import type { Journal } from "../src/journal.js";
import type { SessionTransport } from "../src/adt/session-transport.js";
import { registerQuickFixTools, type QuickFixToolDeps } from "../src/tools/quickfix.js";

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

function harness(safety: SafetyGate): Harness {
  const poolCalls: string[] = [];
  let connected = false;

  const conn = {
    discovery: { assertSupported: () => {} },
    async get() {
      throw new Error("NETWORK CALL LEAKED: this harness has no quick-fix responses");
    },
    async post() {
      throw new Error("NETWORK CALL LEAKED: this harness has no quick-fix responses");
    },
  } as unknown as AbapConnection;

  const pool = {
    withRead: <T,>(op: string, fn: (c: AbapConnection) => Promise<T>) => {
      poolCalls.push(`READ:${op}`);
      return fn(conn);
    },
    withWrite: <T,>(op: string, _key: unknown, fn: (c: AbapConnection) => Promise<T>) => {
      poolCalls.push(`WRITE:${op}`);
      return fn(conn);
    },
  } as unknown as SessionPool;

  const deps: QuickFixToolDeps = {
    pool,
    safety,
    ensureConnected: async () => {
      connected = true;
    },
    errorResult,
    cfg: { maxResponseChars: 60_000, verifyWrites: "speculative" },
    journal: {} as unknown as Journal,
    transport: {} as unknown as SessionTransport,
  };

  const { mcp, tools } = fakeMcp();
  registerQuickFixTools(mcp, deps);
  const entry = tools.get("abap_quick_fix");
  if (!entry) throw new Error("abap_quick_fix was never registered");
  return { invoke: entry.handler, poolCalls, connected: () => connected };
}

const errorPayload = (res: CallToolResult): Record<string, unknown> => {
  expect(res.isError).toBe(true);
  const part = res.content[0];
  if (!part || part.type !== "text") throw new Error("expected a text content part");
  return JSON.parse(part.text) as Record<string, unknown>;
};

/** Distinctive fragment of the sentence `explainReadOnlyRefusal` appends. */
const APPENDED_QF_SENTENCE = 'even mode="list" POSTs the';

describe("abap_quick_fix handler: explainReadOnlyRefusal", () => {
  it("productive system, mode=list: gate reason plus the quick-fix POST sentence", async () => {
    const h = harness(
      new SafetyGate({ readOnly: false, productive: true, allowPackages: ["$TMP"], writesLockedOut: false }),
    );
    const payload = errorPayload(await h.invoke({ mode: "list", object: "ZCL_X", line: 1 }));
    expect(payload.error).toBe("READ_ONLY");
    const msg = String(payload.message);
    expect(msg).toContain("writes are forced off with no override");
    expect(msg).toContain(APPENDED_QF_SENTENCE);
    expect(h.connected()).toBe(false);
    expect(h.poolCalls).toEqual([]);
  });

  it("productive system, mode=apply: same refusal — append is not mode-conditional", async () => {
    // Preflight assert throws before pool dispatch is reached, so this and the
    // previous test both exercise the preflight wrap; this adds that the
    // append isn't conditional on mode. The pool-dispatch wrap is defensive:
    // a READ_ONLY verdict here doesn't depend on the resolved package.
    const h = harness(
      new SafetyGate({ readOnly: false, productive: true, allowPackages: ["$TMP"], writesLockedOut: false }),
    );
    const payload = errorPayload(await h.invoke({ mode: "apply", object: "ZCL_X", line: 1, proposal: "P1" }));
    expect(payload.error).toBe("READ_ONLY");
    const msg = String(payload.message);
    expect(msg).toContain("writes are forced off with no override");
    expect(msg).toContain(APPENDED_QF_SENTENCE);
    expect(h.connected()).toBe(false);
    expect(h.poolCalls).toEqual([]);
  });

  it("writesLockedOut (unprovable non-productive): READ_ONLY, sentence appended", async () => {
    // src/safety.ts evaluate(): writesLockedOut with no roleProbeFailure falls
    // through to the "unproven -> read-only (fail closed)" branch, code READ_ONLY.
    const h = harness(new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], writesLockedOut: true }));
    const payload = errorPayload(await h.invoke({ mode: "list", object: "ZCL_X", line: 1 }));
    expect(payload.error).toBe("READ_ONLY");
    const msg = String(payload.message);
    expect(msg).toContain("could not be proven non-productive");
    expect(msg).toContain(APPENDED_QF_SENTENCE);
    expect(h.connected()).toBe(false);
    expect(h.poolCalls).toEqual([]);
  });

  it("writesLockedOut + roleProbeFailure: ROLE_PROBE_FAILED, sentence absent", async () => {
    // src/safety.ts evaluate(): when roleProbeFailure is set, writesLockedOut
    // takes the OTHER branch — code ROLE_PROBE_FAILED, not READ_ONLY.
    // explainReadOnlyRefusal only augments e.code === "READ_ONLY", so this
    // code must pass through with no appended sentence.
    const h = harness(
      new SafetyGate({
        readOnly: false,
        allowPackages: ["$TMP"],
        writesLockedOut: true,
        roleProbeFailure: "connection reset",
      }),
    );
    const payload = errorPayload(await h.invoke({ mode: "list", object: "ZCL_X", line: 1 }));
    expect(payload.error).toBe("ROLE_PROBE_FAILED");
    expect(String(payload.message)).not.toContain(APPENDED_QF_SENTENCE);
    expect(h.connected()).toBe(false);
    expect(h.poolCalls).toEqual([]);
  });

  it("SAFETY_DENIED (name-prefix allowlist miss) passes through unchanged", async () => {
    // Preflight only knows the name, not the package (see preflight.ts), so
    // this hits the object-name allowlist branch in evaluate() — code
    // SAFETY_DENIED, distinct from READ_ONLY — same object src/tools-atc.test.ts
    // uses for its equivalent case.
    const h = harness(new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], writesLockedOut: false }));
    const payload = errorPayload(await h.invoke({ mode: "list", object: "CL_GUI_FRONTEND_SERVICES", line: 1 }));
    expect(payload.error).toBe("SAFETY_DENIED");
    expect(String(payload.message)).not.toContain(APPENDED_QF_SENTENCE);
    expect(h.connected()).toBe(false);
    expect(h.poolCalls).toEqual([]);
  });
});

describe("abap_quick_fix handler: pool slot routing", () => {
  const permissive = () =>
    new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], writesLockedOut: false });

  it("mode=list takes the READ slot", async () => {
    const h = harness(permissive());
    // Resolution fails on the leaked-network guard past the gate; what matters
    // here is which slot was taken on the way there, so the rejection is swallowed.
    await h.invoke({ mode: "list", object: "ZCL_X", line: 1 }).catch(() => {});
    expect(h.poolCalls).toEqual(["READ:abap_quick_fix"]);
    expect(h.connected()).toBe(true);
  });

  it("mode=apply takes the WRITE slot", async () => {
    const h = harness(permissive());
    await h.invoke({ mode: "apply", object: "ZCL_X", line: 1, proposal: "P1" }).catch(() => {});
    expect(h.poolCalls).toEqual(["WRITE:abap_quick_fix"]);
    expect(h.connected()).toBe(true);
  });
});

describe("abap_quick_fix handler: unknown arguments", () => {
  it("refuses an argument it does not have, naming it, before any gate or connection", async () => {
    const h = harness(new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], writesLockedOut: false }));
    const payload = errorPayload(await h.invoke({ mode: "list", object: "ZCL_X", line: 1, bogus: true }));
    expect(payload.error).toBe("BAD_INPUT");
    expect(JSON.stringify(payload)).toContain("bogus");
    expect(h.connected()).toBe(false);
    expect(h.poolCalls).toEqual([]);
  });
});
