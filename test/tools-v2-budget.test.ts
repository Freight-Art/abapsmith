/**
 * Tier-1 invariants for the v2 tool surface (`ABAP_TOOL_SURFACE=v2`).
 *
 * This file deliberately does NOT import test/tools.test.ts. That file's
 * harness hardcodes its Config (no `toolSurface`/`abapMode` override knob),
 * and this suite needs to build a server with a chosen `abapMode` AND
 * `toolSurface`, so the `Client` + `InMemoryTransport` + `createServer`
 * harness pattern is copied here and extended locally instead of editing the
 * v1 file (test/tools.test.ts stays untouched, per the v1 ratchet's own
 * "never silently" rule).
 *
 * Token measurement imports `CHARS_PER_TOKEN`/`estimateTokens` from
 * src/compact.ts — the single source of truth for token estimation in this
 * repo (see that file's doc comment for the current value). No local
 * chars-per-token constant is defined here.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigSchema, loadConfig, type Config } from "../src/config.js";
import { createServer, type AbapsmithServer } from "../src/server.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import type { AbapMode } from "../src/mode.js";
import { CHARS_PER_TOKEN, estimateTokens } from "../src/compact.js";
import { ABAP_DO_GROUPS } from "../src/tools/v2/catalogue.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------- fixtures ---

/**
 * A transport that must never be reached for anything except the §10.4
 * system-role probe (routed below via `routeSystemRoleProbe`). v2's
 * handlers are stubs (src/tools/v2/register.ts's header comment: "No handler
 * here calls assertHttpPathAllowed, touches a SafetyGate, or opens a
 * connection") and the pool's primary slot connects lazily via
 * `ensureConnected()`, which nothing in a bare or stub v2 call reaches — so
 * any *other* request landing here is itself the bug. The probe route is
 * answered "nonproductive" purely so `test/system-role-probe-guard.test.ts`'s
 * intent-declaration sweep (every suite that builds a connection config must
 * either answer the probe or be justified) sees this suite make a real
 * choice, rather than accidentally relying on the §10.4 write lockout to mask
 * whatever a future v2 handler might do.
 */
class ForbiddenClient implements HttpClient {
  async request(_o: HttpClientOptions): Promise<HttpClientResponse> {
    throw new Error("NETWORK CALL LEAKED: a v2 stub handler must never open a connection");
  }
}

/**
 * Builds a `Config` with a chosen `toolSurface` and `abapMode`. `abapMode`
 * lives outside `ConfigSchema` (it's a `Config`-only field derived from
 * `ABAP_MODE`/`capabilitiesForMode()` in real `loadConfig` use — see
 * src/config.ts's doc comment on the field), so it is spread on after
 * `ConfigSchema.parse(...)` rather than passed into `.parse()`.
 */
function cfg(toolSurface: "v1" | "v2", abapMode: AbapMode): Config {
  return {
    ...ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "TESTUSER",
      password: "secret",
      sid: "TST",
      client: "001",
      toolSurface,
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
    httpClient: new ForbiddenClient(),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-v2-budget", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);
  return { srv, client };
}

/**
 * `Client#callTool`'s declared return type is a union (the ordinary
 * content-array result, or a task-based `{ toolResult }` shape used only by
 * `experimental.tasks.callToolStream()`, which nothing here calls). Narrowing
 * with an `in` check — rather than a type assertion through the top type —
 * keeps this file honest about which branch it is actually reading.
 */
type CallToolReturn = Awaited<ReturnType<Client["callTool"]>>;

const call = (h: Harness, name: string, args: Record<string, unknown>): Promise<CallToolReturn> =>
  h.client.callTool({ name, arguments: args });

const isErr = (res: CallToolReturn): boolean => "isError" in res && res.isError === true;

const textOf = (res: CallToolReturn): string => {
  if (!("content" in res)) return "";
  return res.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
};

// ---------------------------------------------------------------------------
// Rule 1 source-scan needle: built from string concatenation so this file
// (which legitimately discusses the banned construct) never itself contains
// the literal substring another source scanner in this repo might match.
// ---------------------------------------------------------------------------
const CLOSED_ENUM_NEEDLE = "z" + "." + "enum" + "(";

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const v2Dir = join(repoRoot, "src", "tools", "v2");

// ---------------------------------------------------------------------------

describe("§9.1-v2 tool surface", () => {
  it("composes the v2 surface per mode: read=5 tools, edit/admin=6 tools (abap_write mode-gated)", async () => {
    const read = await harness(cfg("v2", "read"));
    const edit = await harness(cfg("v2", "edit"));
    const admin = await harness(cfg("v2", "admin"));

    const namesOf = async (h: Harness) => (await h.client.listTools()).tools.map((t) => t.name).sort();

    expect(await namesOf(read)).toEqual(["abap_adt", "abap_debug", "abap_do", "abap_find", "abap_read"]);
    expect(await namesOf(edit)).toEqual([
      "abap_adt",
      "abap_debug",
      "abap_do",
      "abap_find",
      "abap_read",
      "abap_write",
    ]);
    expect(await namesOf(admin)).toEqual([
      "abap_adt",
      "abap_debug",
      "abap_do",
      "abap_find",
      "abap_read",
      "abap_write",
    ]);
  });

  it("is strictly monotonic across modes in both bytes and estimated tokens (§5)", async () => {
    const read = await harness(cfg("v2", "read"));
    const edit = await harness(cfg("v2", "edit"));
    const admin = await harness(cfg("v2", "admin"));

    const bytesOf = async (h: Harness) => JSON.stringify((await h.client.listTools()).tools).length;
    const textFor = async (h: Harness) => JSON.stringify((await h.client.listTools()).tools);

    const readBytes = await bytesOf(read);
    const editBytes = await bytesOf(edit);
    const adminBytes = await bytesOf(admin);

    const readTokens = estimateTokens(await textFor(read));
    const editTokens = estimateTokens(await textFor(edit));
    const adminTokens = estimateTokens(await textFor(admin));

    // read -> edit is strictly bigger in every mode: abap_write is only
    // registered from edit up (register.ts's `if (mode !== "read")`), and
    // abap_do's own description grows with actionsForMode(mode).length.
    expect(readBytes, `read=${readBytes} edit=${editBytes}`).toBeLessThan(editBytes);
    expect(readTokens, `read=${readTokens} edit=${editTokens}`).toBeLessThan(editTokens);

    // edit -> admin is §5's actual acceptance criterion ("read mode
    // strictly smaller than admin mode") restated as read -> admin below; it
    // is intentionally NOT asserted as a strict edit < admin step here.
    // `abap_adt`'s description was corrected to say what the tool actually
    // does: GET-only in every
    // mode, including admin — admin unlocks zero extra abap_adt capability,
    // because `SafetyGate.authorize` cannot mint an `AuthorizedTarget` for an
    // unresolved raw ADT path and `JournalOperation` has no raw-call variant
    // (a known, currently open gap). `abap_do`'s description text is
    // also byte-identical between edit and admin (same 6 groups both modes;
    // 48 vs 51 actions are both 2-digit numbers). With no other per-mode text
    // in the v2 surface, edit and admin are honestly TIED in tools/list bytes
    // today — forcing a strict step here would mean padding prose just to
    // manufacture a size difference admin doesn't actually have.
    expect(editBytes, `edit=${editBytes} admin=${adminBytes}`).toBeLessThanOrEqual(adminBytes);
    expect(editTokens, `edit=${editTokens} admin=${adminTokens}`).toBeLessThanOrEqual(adminTokens);

    // The criterion (§5) actually states: read strictly smaller than admin.
    expect(readBytes, `read=${readBytes} admin=${adminBytes}`).toBeLessThan(adminBytes);
    expect(readTokens, `read=${readTokens} admin=${adminTokens}`).toBeLessThan(adminTokens);
  });

  /**
   * There is deliberately no byte ceiling and no pinned byte total here any
   * more — see test/tools.test.ts's "tool surface" describe block for why
   * that apparatus was removed repo-wide: a pinned exact total (or a hard
   * ceiling) fails the build on every unrelated prose edit, and the fix
   * under time pressure is trimming good documentation to fit a number
   * instead of improving it. Per-mode tool counts and names are already
   * asserted exactly by "composes the v2 surface per mode" above, which is
   * the part of this that was a real product invariant.
   *
   * The live per-tool byte breakdown is still printed to stderr below on
   * every run, so schema size can be watched without being enforced.
   */
  it("prints the v2 per-mode schema size breakdown (informational only)", async () => {
    const read = await harness(cfg("v2", "read"));
    const edit = await harness(cfg("v2", "edit"));
    const admin = await harness(cfg("v2", "admin"));

    const measure = async (h: Harness) => {
      const { tools } = await h.client.listTools();
      const perTool = Object.fromEntries(tools.map((t) => [t.name, JSON.stringify(t).length])) as Record<
        string,
        number
      >;
      const total = JSON.stringify(tools).length;
      return { count: tools.length, total, perTool };
    };

    const readM = await measure(read);
    const editM = await measure(edit);
    const adminM = await measure(admin);

    process.stderr.write(
      `[schema-v2] read ${readM.count} tools, ${readM.total} bytes: ${JSON.stringify(readM.perTool)}\n`,
    );
    process.stderr.write(
      `[schema-v2] edit ${editM.count} tools, ${editM.total} bytes: ${JSON.stringify(editM.perTool)}\n`,
    );
    process.stderr.write(
      `[schema-v2] admin ${adminM.count} tools, ${adminM.total} bytes: ${JSON.stringify(adminM.perTool)}\n`,
    );
  });

  it("Rule 1 — no closed zod enums anywhere under src/tools/v2/", () => {
    const files = walkTsFiles(v2Dir);
    expect(files.length, "source scan found no .ts files under src/tools/v2/").toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, "utf8");
      if (contents.includes(CLOSED_ENUM_NEEDLE)) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `closed zod enum(s) found under src/tools/v2/ (§2 Rule 1 forbids them): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("Rule 2 — every v2 tool self-documents on a bare call", async () => {
    const admin = await harness(cfg("v2", "admin"));
    const { tools } = await admin.client.listTools();
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      const res = await call(admin, tool.name, {});
      expect(isErr(res), `${tool.name}({}) returned an error result: ${textOf(res)}`).toBe(false);
      const text = textOf(res);
      expect(text.length, `${tool.name}({}) returned empty text`).toBeGreaterThan(0);
    }
  });

  it("every v2 tool stays zero-network on a bare call, in every mode", async () => {
    // `ForbiddenClient` (this file's harness) throws "NETWORK CALL LEAKED" on
    // ANY request. Each handler body was split out of
    // src/tools/v2/register.ts into src/tools/v2/handlers/*.ts, and every one
    // of them must check `isBareCall` before touching `ensureConnected`,
    // `pool.*`, or `safety.*` — this pins that across all three modes (not
    // just admin, since `abap_write` only exists in edit/admin) so a future
    // work package that wires a real handler cannot silently reorder the
    // bare-call check behind a network-touching call.
    for (const mode of ["read", "edit", "admin"] as const) {
      const h = await harness(cfg("v2", mode));
      const { tools } = await h.client.listTools();
      expect(tools.length).toBeGreaterThan(0);

      for (const tool of tools) {
        const res = await call(h, tool.name, {});
        const text = textOf(res);
        expect(
          text,
          `${tool.name}({}) in ${mode} mode leaked a network call: ${text}`,
        ).not.toContain("NETWORK CALL LEAKED");
        expect(isErr(res), `${tool.name}({}) in ${mode} mode returned an error result: ${text}`).toBe(false);
      }
    }
  });

  it("abap_do({}) mentions every group name and the action count for the mode", async () => {
    const admin = await harness(cfg("v2", "admin"));
    const res = await call(admin, "abap_do", {});
    expect(isErr(res)).toBe(false);
    const text = textOf(res);

    for (const group of ABAP_DO_GROUPS) {
      expect(text, `abap_do({}) is missing group "${group}"`).toContain(group);
    }

    const { tools } = await admin.client.listTools();
    const doTool = tools.find((t) => t.name === "abap_do");
    expect(doTool, "abap_do not found in tools/list").toBeDefined();
    const description = doTool?.description ?? "";
    expect(description).toMatch(/\d+ actions available in this mode/);
  });

  it("Rule 3 — every v2 tool's response carries a NEXT block with a concrete follow-up", async () => {
    const admin = await harness(cfg("v2", "admin"));
    const { tools } = await admin.client.listTools();

    for (const tool of tools) {
      const res = await call(admin, tool.name, {});
      const text = textOf(res);
      expect(text, `${tool.name}({}) is missing a NEXT: block`).toContain("NEXT:");
      const nextBlock = text.slice(text.indexOf("NEXT:"));
      expect(
        nextBlock,
        `${tool.name}({})'s NEXT: block has no concrete follow-up call: ${nextBlock}`,
      ).toMatch(/\w+\(\{.*\)\s+—/s);
    }

    // Non-bare call.
    const readRes = await call(admin, "abap_read", { object: "ZCL_FOO" });
    const readText = textOf(readRes);
    expect(readText).toContain("NEXT:");
    expect(readText.slice(readText.indexOf("NEXT:"))).toMatch(/\w+\(\{.*\)\s+—/s);

    // The UNKNOWN_ACTION path.
    const unknownRes = await call(admin, "abap_do", { action: "activateAll" });
    const unknownText = textOf(unknownRes);
    expect(unknownText).toContain("NEXT:");
    expect(unknownText.slice(unknownText.indexOf("NEXT:"))).toMatch(/\w+\(\{.*\)\s+—/s);
  });

  it("UNKNOWN_ACTION has §2.1's exact shape", async () => {
    const admin = await harness(cfg("v2", "admin"));
    const res = await call(admin, "abap_do", { action: "activateAll" });

    expect(isErr(res)).toBe(true);
    const text = textOf(res);

    expect(text).toContain("UNKNOWN_ACTION");
    expect(text).toContain("activateAll"); // echoes the given value
    expect(text).toMatch(/closest:.*\bactivate\b/i); // nearest match offered
    expect(text).toContain("abap_do({})"); // points at the catalogue
    expect(text).toContain("abap:actions"); // names the skill (ABAP_DO_SKILL)
    expect(text).toContain("retryable: true"); // a different action string would work
  });

  it("mode gating is real: abap_write is absent from read mode's tools/list and unknown as a call", async () => {
    const read = await harness(cfg("v2", "read"));
    const { tools } = await read.client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("abap_write");

    // The MCP SDK reports a call to an unregistered tool as an error
    // CallToolResult (JSON-RPC error -32602, "Tool ... not found") rather
    // than rejecting the client-side promise — assert that shape directly
    // instead of assuming a rejection.
    const res = await call(read, "abap_write", { object: "ZCL_FOO" });
    expect(isErr(res)).toBe(true);
    expect(textOf(res)).toMatch(/abap_write/);
    expect(textOf(res)).toMatch(/not found/i);
  });

  it("the default ABAP_TOOL_SURFACE is v1 when unset", () => {
    const c = loadConfig({
      env: {
        ABAP_URL: "http://sap.invalid:50000",
        ABAP_USER: "U",
        ABAP_PASSWORD: "p",
      },
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.toolSurface).toBe("v1");
  });
});
