/**
 * Issue #141: `dispatch()`'s own targets gate (`assertTargetsAgainstGate`,
 * src/adt/fluid/dispatch.ts) used to judge whatever request an action's
 * `targets.transport` pointer resolved to as caller-NAMED — so under
 * `ABAP_ALLOW_TRANSPORTS=auto` a request abapsmith's own session resolver had
 * just picked for a classic-bridge create was refused right there, after the
 * tool layer had already passed it as auto-selected.
 *
 * `FluidRunRequest.corrSource: "auto"` now carries that provenance through —
 * for a BUILTIN tool only. A plugin cannot declare it, and omitting it keeps
 * the stricter "named" reading, so the change only ever lets through what the
 * gate already permits for the ADT-lock types.
 *
 * Offline and zero-wire: `gate.assert` is spied to record what `dispatch()`
 * hands it and then stops the call with a sentinel, so no connection is ever
 * touched — the gate is the first thing after argument validation.
 */
import { describe, expect, it, vi } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError } from "../src/adt/errors.js";
import { SafetyGate, type EvaluateOptions } from "../src/safety.js";
import { dispatch, type FluidDeps, type FluidRunRequest } from "../src/adt/fluid/dispatch.js";
import { manifestVersion, type FluidActionSpec, type FluidManifest, type LoadedFluidTool } from "../src/adt/fluid/manifest.js";

const CORR = "A4HK900321";

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
    fluidApi: true,
    allowFluidPlugins: true,
    allowFluidPluginMutate: true,
  });

/**
 * Every request is a test failure: the gate is reached before any wire call,
 * so the connection is built (with the mandatory system-role probe routed)
 * but never connected and never asked for anything.
 */
class SilentAdt implements HttpClient {
  readonly calls: string[] = [];
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(`${(o.method ?? "GET").toUpperCase()} ${o.url}`);
    throw new Error(`corr-source test: unexpected wire request ${o.url}`);
  }
}

function neverConnected(): { conn: AbapConnection; adt: SilentAdt } {
  const adt = new SilentAdt();
  const conn = new AbapConnection(cfg(), {
    httpClient: routeSystemRoleProbe(adt, { answer: "nonproductive" }),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  return { conn, adt };
}

const CREATE_ACTION: FluidActionSpec = {
  name: "create_thing",
  category: "mutate",
  description: "creates a transportable thing",
  input: {
    type: "object",
    properties: { name: { type: "string" }, package_name: { type: "string" }, corr_nr: { type: "string" } },
    required: ["name", "package_name", "corr_nr"],
  },
  output: { type: "object" },
  targets: { object: "/name", package: "/package_name", transport: "/corr_nr" },
};

function toolOf(origin: "builtin" | "plugin"): LoadedFluidTool {
  const className = "ZCL_CORR_SOURCE_FIXTURE";
  const source = `CLASS ${className} DEFINITION PUBLIC.\nENDCLASS.\nCLASS ${className} IMPLEMENTATION.\nENDCLASS.`;
  const manifest: FluidManifest = {
    contract: "1.0",
    id: "corrsrc",
    title: "corr-source fixture",
    description: "fluid-dispatch-corr-source.test.ts fixture",
    objects: [{ name: className, type: "CLAS/OC", description: "obj", source: { text: source } }],
    entry: className,
    actions: [CREATE_ACTION],
  };
  const sources = new Map([[className, source]]);
  return { manifest, origin, sources, version: manifestVersion(manifest, sources) };
}

const SENTINEL = "corr-source-test: gate reached";

/** Runs `dispatch()` up to its targets gate; returns the gate's verdict on the action's own targets and what it was handed. */
async function verdict(
  origin: "builtin" | "plugin",
  allowTransports: string[],
  corrSource: FluidRunRequest["corrSource"],
): Promise<{ allowed: boolean; error?: AbapError; opts?: EvaluateOptions }> {
  const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"], allowTransports });
  const tool = toolOf(origin);
  let seen: EvaluateOptions | undefined;
  let refusal: AbapError | undefined;
  const original = gate.assert.bind(gate);
  vi.spyOn(gate, "assert").mockImplementation((...args: Parameters<SafetyGate["assert"]>) => {
    seen = args[2];
    try {
      original(...args);
    } catch (e) {
      refusal = e as AbapError;
      throw e;
    }
    throw new AbapError("INTERNAL_GATE_MISUSE", SENTINEL);
  });
  const { conn, adt } = neverConnected(); // never touched: the gate stops the call first
  const deps: FluidDeps = {
    conn,
    cfg: cfg(),
    gate,
    tools: new Map([[tool.manifest.id, tool]]),
  };
  const req: FluidRunRequest = {
    tool: tool.manifest.id,
    action: CREATE_ACTION.name,
    args: { name: "ZMCP_THING", package_name: "ZTM", corr_nr: CORR },
    confirm: `${tool.manifest.id}.${CREATE_ACTION.name}`,
    ...(corrSource !== undefined ? { corrSource } : {}),
  };
  try {
    await dispatch(deps, req);
    throw new Error("unreachable: the spy always throws");
  } catch (e) {
    expect(adt.calls).toEqual([]);
    if (e instanceof AbapError && e.message === SENTINEL) return { allowed: true, ...(seen ? { opts: seen } : {}) };
    if (e instanceof AbapError && e.code === "SAFETY_DENIED") return { allowed: false, error: e, ...(seen ? { opts: seen } : {}) };
    throw e;
  }
}

describe("dispatch — targets gate honours corrSource: 'auto' for a builtin tool only", () => {
  it("builtin + corrSource 'auto' under ['auto']: the resolved request passes as auto-selected, zero wire", async () => {
    const v = await verdict("builtin", ["auto"], "auto");
    expect(v.allowed).toBe(true);
    expect(v.opts?.corr).toEqual({ kind: "transport", corrNr: CORR, source: "auto" });
  });

  it("builtin with NO corrSource under ['auto']: the same request is judged caller-named and refused (unchanged)", async () => {
    const v = await verdict("builtin", ["auto"], undefined);
    expect(v.allowed).toBe(false);
    expect(v.error?.details.rule).toBe("transport allowlist");
    expect(v.opts?.corr).toBeUndefined();
    expect(v.opts?.corrNr).toBe(CORR);
  });

  it("builtin + corrSource 'named' under ['auto']: refused (the stricter reading is the default and the explicit one)", async () => {
    const v = await verdict("builtin", ["auto"], "named");
    expect(v.allowed).toBe(false);
    expect(v.opts?.corr).toBeUndefined();
  });

  it("PLUGIN + corrSource 'auto' under ['auto']: not honoured — a plugin cannot declare its way past the allowlist", async () => {
    const v = await verdict("plugin", ["auto"], "auto");
    expect(v.allowed).toBe(false);
    expect(v.error?.details.rule).toBe("transport allowlist");
    expect(v.opts?.corr).toBeUndefined();
  });

  it("builtin + corrSource 'auto' under a PINNED list: still refused — auto-selection never satisfies a vetted list", async () => {
    const v = await verdict("builtin", ["A4HK900117"], "auto");
    expect(v.allowed).toBe(false);
    expect(v.error?.details.rule).toBe("transport allowlist");
    expect(v.error?.hint).toMatch(/Only these requests are permitted: A4HK900117/);
  });

  it("builtin + corrSource 'auto' under an EMPTY list: fail closed", async () => {
    const v = await verdict("builtin", [], "auto");
    expect(v.allowed).toBe(false);
    expect(v.error?.details.rule).toBe("transport allowlist (fail closed)");
  });
});
