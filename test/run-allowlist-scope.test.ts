/**
 * Protects the disclosure that the write allowlists do not bound `abap_run`.
 * Substance-based (an "allowlist" + "not constrained/unconstrained" claim,
 * plus a naming check where naming the tool is the load-bearing part), not
 * exact-string, so rewording the sentences cannot silently break the claim.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ABAP_DO_ACTIONS } from "../src/tools/v2/catalogue.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

const DOC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "doc",
  "CONFIGURATION",
  "permissions-and-allowlists.md",
);

/** A transport that must never be reached — reading `tools/list` off the
 * initialize handshake costs zero ADT requests. */
class ForbiddenClient implements Partial<HttpClient> {
  request(_o: HttpClientOptions): Promise<HttpClientResponse> {
    throw new Error("NETWORK CALL LEAKED: reading tools/list must not touch the wire");
  }
}

/** The load-bearing claim itself: an allowlist, stated as not binding on it. */
function assertNotConstrainedClaim(text: string): void {
  expect(text).toMatch(/allowlist/i);
  expect(text).toMatch(/not constrained|unconstrained/i);
}

describe("abap_run allowlist-scope disclosure: v1 tool description", () => {
  it("the registered abap_run tool discloses it is not bound by the package/name/transport allowlists", async () => {
    const cfg = loadConfig({
      env: {
        ABAP_URL: "http://sap.invalid:50000",
        ABAP_USER: "U",
        ABAP_PASSWORD: "p",
        ABAP_CLIENT: "001",
        ABAP_MODE: "edit",
      },
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.readOnly).toBe(false);

    const srv = createServer(cfg, {
      // Never connects, but the config is otherwise ordinary, so answer the
      // system-role probe like every connection-capable suite must (see
      // test/system-role-probe-guard.test.ts).
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
    const abapRun = tools.find((t) => t.name === "abap_run");
    expect(abapRun).toBeDefined();
    const description = abapRun!.description ?? "";
    assertNotConstrainedClaim(description);
    // The sentence names all three allowlists it claims to bypass.
    expect(description).toMatch(/package/i);
    expect(description).toMatch(/name/i);
    expect(description).toMatch(/transport/i);

    await client.close();
  });
});

describe("abap_run allowlist-scope disclosure: v2 catalogue", () => {
  // Already covered by src/tools/v2/catalogue.ts's `action: "run"` summary before this change.
  it("the abap_do catalogue's run entry carries the same disclosure", () => {
    const runEntry = ABAP_DO_ACTIONS.find((e) => e.action === "run");
    expect(runEntry).toBeDefined();
    assertNotConstrainedClaim(runEntry!.summary);
  });
});

describe("abap_run allowlist-scope disclosure: configuration doc, per row", () => {
  const doc = readFileSync(DOC_PATH, "utf8");

  /** Isolates one variable's own table row so a per-row regression can't hide
   * behind the closing paragraph's collective statement. */
  function rowFor(variable: string): string {
    const line = doc.split("\n").find((l) => l.startsWith(`| \`${variable}\` `));
    expect(line, `no table row found for ${variable}`).toBeDefined();
    return line!;
  }

  for (const variable of ["ABAP_ALLOW_TRANSPORTS", "ABAP_ALLOW_PACKAGES", "ABAP_ALLOW_NAME_PREFIXES"]) {
    it(`${variable}'s row names abap_run and states it is not constrained by this allowlist`, () => {
      const row = rowFor(variable);
      // Naming the escaping tool is the point of this row-level check — a
      // generic "not constrained" claim without naming abap_run wouldn't tell
      // a reader what escapes.
      expect(row).toMatch(/abap_run/);
      assertNotConstrainedClaim(row);
    });
  }
});
