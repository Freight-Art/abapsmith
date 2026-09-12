/**
 * Mode-locked refusal stubs (`src/tools/locked.ts`) — the fix for issue #63.
 *
 * Before this landed, a read-only v1 server (`ABAP_MODE=read`, or legacy
 * read-only config) simply never registered the mutating tools, so a call to
 * `abap_write` came back as `MCP error -32602: Tool abap_write not found` —
 * indistinguishable from a typo'd tool name. `registerLockedTools` now
 * advertises those tools under their real names with a refusal-only handler
 * that holds no pool/safety/connection dependency, so it is structurally
 * incapable of reaching SAP.
 *
 * Harness copied from `test/tools-schema-shape.test.ts` (real MCP `Client` +
 * `InMemoryTransport` + `createServer()`, plus a `ForbiddenClient` that
 * throws on any HTTP request — the thing that proves a locked call sends
 * nothing to SAP). Configs are built via `loadConfig()` off a fake env
 * (like `test/data-preview-gates.test.ts`) rather than hand-assembled via
 * `ConfigSchema.parse()` + manual field overrides, so `readOnly`/
 * `allowPackages`/`allowTransportRelease`/etc. are threaded through
 * `capabilitiesForMode()` exactly the way production does — the same
 * concern `test/tools-v2-budget.test.ts`'s `cfg()` helper flags but doesn't
 * fully solve for a writable v1 config (its `abapMode` is spread on AFTER
 * `ConfigSchema.parse()`, so `readOnly` stays at the schema default unless
 * also set by hand).
 */
import { describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type Config } from "../src/config.js";
import { createServer, type AbapsmithServer } from "../src/server.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import type { AbapMode } from "../src/mode.js";
import { lockedToolsFor } from "../src/tools/locked.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------- fixtures ---

/** A transport that must never be reached — proves a locked call touches no wire. */
class ForbiddenClient implements HttpClient {
  async request(_o: HttpClientOptions): Promise<HttpClientResponse> {
    throw new Error("NETWORK CALL LEAKED: a mode-locked stub must never open a connection");
  }
}

const BASE_ENV: Record<string, string> = {
  ABAP_URL: "http://sap.invalid:50000",
  ABAP_USER: "TESTUSER",
  ABAP_PASSWORD: "secret",
  ABAP_SID: "TST",
  // The logon client the T000 system-role probe judges (see `system-role-fake.ts`).
  ABAP_CLIENT: "001",
};

/** A real, internally-consistent v1 `Config` for `mode`, built via `loadConfig()` off a fake env. */
function v1Config(mode: AbapMode, over: Record<string, string> = {}): Config {
  return loadConfig({
    env: { ...BASE_ENV, ABAP_TOOL_SURFACE: "v1", ABAP_MODE: mode, ...over },
    warn: () => {},
    skipDotenv: true,
  });
}

function v2Config(mode: AbapMode, over: Record<string, string> = {}): Config {
  return loadConfig({
    env: { ...BASE_ENV, ABAP_TOOL_SURFACE: "v2", ABAP_MODE: mode, ...over },
    warn: () => {},
    skipDotenv: true,
  });
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
  const client = new Client({ name: "test-mode-locked-tools", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);
  return { srv, client };
}

async function toolNames(config: Config): Promise<Set<string>> {
  const { client } = await harness(config);
  const { tools } = await client.listTools();
  await client.close();
  return new Set(tools.map((t) => t.name));
}

type CallToolReturn = Awaited<ReturnType<Client["callTool"]>>;

const isErr = (res: CallToolReturn): boolean => "isError" in res && res.isError === true;

const textOf = (res: CallToolReturn): string => {
  if (!("content" in res)) return "";
  return res.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
};

/** The locked stub's refusal is `errorResult(AbapError)` — a JSON envelope, unlike the SDK's own plain-text "not found". */
const jsonOf = (res: CallToolReturn): Record<string, unknown> => JSON.parse(textOf(res)) as Record<string, unknown>;

/**
 * The 12 base stub names — every mutating v1 tool whose registration used to
 * be skipped outright on a read-only server. `abap_fluid` is separate
 * (13th) because it carries the extra `cfg.fluidApi` precondition.
 */
const BASE_LOCKED_NAMES = [
  "abap_write",
  "abap_run",
  "abap_test",
  "abap_atc",
  "abap_quick_fix",
  "abap_ui",
  "abap_fpm_read",
  "abap_img_edit",
  "abap_bopf_test",
  "abap_bopf_edit",
  "abap_bopf_delete",
  "abap_transport_release",
];

// ============================================================================
// 1. read mode lists every locked tool
// ============================================================================

describe("mode-locked tools — registration on a read-only v1 server", () => {
  it("lists all 12 base locked names, plus abap_fluid (13th) since fluidApi defaults on", async () => {
    // `fluidApi` (ABAP_FLUID_API) defaults to `true` (src/config.ts), so the
    // plain read-mode config here already satisfies abap_fluid's
    // `availableWhen`.
    const names = await toolNames(v1Config("read"));
    for (const name of BASE_LOCKED_NAMES) {
      expect(names.has(name), `read-mode tools/list is missing locked stub ${name}`).toBe(true);
    }
    expect(names.has("abap_fluid")).toBe(true);
  });

  it("drops abap_fluid from the locked set when ABAP_FLUID_API is explicitly off", async () => {
    const names = await toolNames(v1Config("read", { ABAP_FLUID_API: "false" }));
    for (const name of BASE_LOCKED_NAMES) {
      expect(names.has(name), `read-mode tools/list is missing locked stub ${name}`).toBe(true);
    }
    expect(names.has("abap_fluid")).toBe(false);
  });
});

// ============================================================================
// 2. calling a locked tool refuses instead of erroring "not found"
// ============================================================================

describe("mode-locked tools — calling one refuses, it does not 404", () => {
  it("abap_write resolves isError:true with a READ_ONLY refusal, not an MCP -32602", async () => {
    const { client } = await harness(v1Config("read"));
    const res = await client.callTool({
      name: "abap_write",
      arguments: { object: "ZCL_X", source: "CLASS zcl_x DEFINITION. ENDCLASS." },
    });

    expect(isErr(res)).toBe(true);
    const payload = jsonOf(res);
    expect(payload.error).toBe("READ_ONLY");
    expect(String(payload.message)).toContain("abap_write");
    expect(String(payload.message)).toContain("locked");
    expect(String(payload.message)).toContain("Nothing was sent to the SAP system.");
    // hint carries the remediation.
    expect(String(payload.hint)).toContain("ABAP_MODE=edit");
    // The ForbiddenClient above proves this: had the handler reached the
    // pool/connection, `harness()`'s httpClient would have thrown on
    // anything but the routed system-role probe, and this call never even
    // opens a connection, so it never runs the probe either.
  });
});

// ============================================================================
// 3. unknown tools still 404
// ============================================================================

describe("mode-locked tools — unrelated typo'd tool names are unaffected", () => {
  it("a genuinely unknown tool name still comes back as an MCP 'not found' error, not a refusal", async () => {
    const { client } = await harness(v1Config("read"));
    const res = await client.callTool({ name: "abap_not_a_tool", arguments: {} });

    expect(isErr(res)).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/not found/i);
    expect(text).toMatch(/abap_not_a_tool/);
    // Distinguishes this from a locked-tool refusal: not a JSON envelope,
    // and definitely not `READ_ONLY` — the fix must not turn every typo
    // into a refusal.
    expect(() => JSON.parse(text)).toThrow();
  });
});

// ============================================================================
// 4. abap_transport_release names admin
// ============================================================================

describe("mode-locked tools — abap_transport_release needs admin, not just edit", () => {
  it("its refusal remediation points at ABAP_MODE=admin and details name both capabilities", async () => {
    const { client } = await harness(v1Config("read"));
    const res = await client.callTool({ name: "abap_transport_release", arguments: { transport: "TST0001234" } });

    expect(isErr(res)).toBe(true);
    const payload = jsonOf(res);
    expect(payload.error).toBe("READ_ONLY");
    expect(String(payload.hint)).toContain("ABAP_MODE=admin");
    const details = payload.details as { capabilities?: unknown; requiresMode?: unknown; abapMode?: unknown };
    expect(details.capabilities).toEqual(expect.arrayContaining(["allowWrite", "allowTransportRelease"]));
    expect(details.requiresMode).toBe("admin");
    expect(details.abapMode).toBe("read");
  });
});

// ============================================================================
// 5. locked tools take arbitrary arguments without a schema error
// ============================================================================

describe("mode-locked tools — no input schema, so any arguments are accepted then refused", () => {
  it("a nonsense argument object still comes back as a READ_ONLY refusal, not a validation error", async () => {
    const { client } = await harness(v1Config("read"));
    const res = await client.callTool({
      name: "abap_bopf_edit",
      arguments: { totally: "unexpected", nested: { shape: [1, 2, 3] }, op: 42 },
    });

    expect(isErr(res)).toBe(true);
    const payload = jsonOf(res);
    expect(payload.error).toBe("READ_ONLY");
    expect(payload.error).not.toBe("BAD_INPUT");
  });
});

// ============================================================================
// 6. no stubs on a writable server
// ============================================================================

describe("mode-locked tools — absent again once the server is actually writable", () => {
  it("lockedToolsFor(cfg) is empty and abap_write is the real tool, with a real schema", async () => {
    const cfg = v1Config("admin");
    expect(lockedToolsFor(cfg)).toEqual([]);

    const { client } = await harness(cfg);
    const { tools } = await client.listTools();
    const write = tools.find((t) => t.name === "abap_write");
    expect(write, "abap_write missing from an admin-mode tools/list").toBeDefined();
    // The stub registers with NO inputSchema (empty-object schema); the real
    // tool has real properties. This is the shape difference the rest of
    // this suite leans on.
    const properties = (write!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(properties).length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 7. no stubs on the v2 surface
// ============================================================================

describe("mode-locked tools — v2 answers this through abap_do's minMode instead", () => {
  it("lockedToolsFor is [] for v2, and abap_write stays absent from a read-mode v2 tools/list", async () => {
    const cfg = v2Config("read");
    expect(lockedToolsFor(cfg)).toEqual([]);

    const { client } = await harness(cfg);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("abap_write");

    // Same "not found, not a refusal" shape test/tools-v2-budget.test.ts
    // already pins for v2 — reasserted here so this file alone proves v2 is
    // untouched by src/tools/locked.ts.
    const res = await client.callTool({ name: "abap_write", arguments: {} });
    expect(isErr(res)).toBe(true);
    expect(textOf(res)).toMatch(/not found/i);
  });
});

// ============================================================================
// 8. DRIFT GUARD — the important one
// ============================================================================

describe("mode-locked tools — DRIFT GUARD: read and admin advertise the identical tool-name set", () => {
  it("two v1 configs differing ONLY in abapMode (read vs admin) list exactly the same tool names", async () => {
    // Identical out-of-band flags on both sides: allowDataPreview and
    // allowDumpVariables are NOT mode-governed (src/mode.ts's doc comment on
    // AbapCapabilities.allowDataPreview), and fluidApi is the same literal
    // value both times — so any difference in the resulting name sets can
    // only come from how read vs admin registers/stubs the MODE-governed
    // tools, which is exactly what this guard exists to pin.
    const sharedOverrides = {
      ABAP_ALLOW_DATA_PREVIEW: "true",
      ABAP_ALLOW_DUMP_VARIABLES: "true",
      ABAP_FLUID_API: "true",
    };
    const readNames = await toolNames(v1Config("read", sharedOverrides));
    const adminNames = await toolNames(v1Config("admin", sharedOverrides));

    expect(
      [...readNames].sort(),
      "read-mode and admin-mode tools/list no longer advertise the same NAMES. " +
        "If you just added a new write-gated v1 tool (a registration gated on " +
        "toolCapabilities.canWrite or similar), it must ALSO be added as an entry in " +
        "MODE_LOCKED_TOOLS (src/tools/locked.ts) — otherwise it silently stops being " +
        "advertised at all on a read-only server, which is exactly issue #63 " +
        "regressing: a caller gets 'tool not found' instead of a locked refusal that " +
        "explains what unlocks it.",
    ).toEqual([...adminNames].sort());
  });
});

// ============================================================================
// 9. locked descriptions are self-explaining
// ============================================================================

describe("mode-locked tools — descriptions explain themselves without a call", () => {
  it("every locked tool's description mentions LOCKED and names the mode that unlocks it", async () => {
    const { client } = await harness(v1Config("read"));
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const name of [...BASE_LOCKED_NAMES, "abap_fluid"]) {
      const tool = byName.get(name);
      expect(tool, `${name} missing from read-mode tools/list`).toBeDefined();
      const description = String(tool!.description ?? "");
      expect(description, `${name}'s description does not say LOCKED`).toContain("LOCKED");
      // Every base tool needs only `allowWrite` (lowest granting mode:
      // "edit"); abap_transport_release additionally needs
      // allowTransportRelease, whose default is admin-only, so its combined
      // remediation names "admin" instead.
      const unlockMode = name === "abap_transport_release" ? "admin" : "edit";
      expect(
        description,
        `${name}'s description does not name ABAP_MODE=${unlockMode} as what unlocks it`,
      ).toContain(`ABAP_MODE=${unlockMode}`);
    }
  });
});

// ============================================================================
// 10. byte hygiene
// ============================================================================

describe("mode-locked tools — stubs are far cheaper than real schemas", () => {
  it("the read-mode tools/list JSON is strictly smaller than the admin-mode one", async () => {
    const readTools = (await (await harness(v1Config("read"))).client.listTools()).tools;
    const adminTools = (await (await harness(v1Config("admin"))).client.listTools()).tools;

    expect(JSON.stringify(readTools).length).toBeLessThan(JSON.stringify(adminTools).length);
  });
});
