/**
 * `instructionsFor`'s write-scope clause.
 *
 * Both branches used to assert, as a hardcoded constant, that the write
 * package allowlist "defaults to $TMP". `EDIT_PACKAGE_DEFAULT` (src/mode.ts)
 * is actually `["*"]` and has been for a while — the string was simply
 * wrong. The fix renders the clause from the resolved `readOnly`/
 * `allowPackages` config instead of asserting a constant, so it cannot drift
 * from the real default again. This file is deliberately NOT a grep for a
 * literal `*` in the output: it re-derives the expected sentence from
 * `capabilitiesForMode` independently of `instructionsFor`'s own
 * implementation, so a future change to `EDIT_PACKAGE_DEFAULT` that isn't
 * reflected in the rendered text fails here.
 */
import { describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { capabilitiesForMode } from "../src/mode.js";
import { createServer, instructionsFor, type AbapsmithServer } from "../src/server.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

const BASE_ENV = {
  ABAP_URL: "http://sap.invalid:50000",
  ABAP_USER: "U",
  ABAP_PASSWORD: "p",
  ABAP_CLIENT: "001",
};

const env = (over: Record<string, string> = {}): Record<string, string> => ({ ...BASE_ENV, ...over });

const load = (over: Record<string, string> = {}) =>
  loadConfig({ env: env(over), warn: () => {}, skipDotenv: true });

/** A transport that must never be reached — building the server and reading
 * `instructions` off the initialize handshake costs zero ADT requests. */
class ForbiddenClient implements Partial<HttpClient> {
  request(_o: HttpClientOptions): Promise<HttpClientResponse> {
    throw new Error("NETWORK CALL LEAKED: reading server instructions must not touch the wire");
  }
}

const TOOL_SURFACES = ["v1", "v2"] as const;

/**
 * The claim under test: whichever branch of `packageScopeSentence` a
 * config resolves to, its sentence mentions all THREE states, not just the
 * one that happens to be in force — that is what "defaults to `*`" alone
 * lost. The two refusal phrasings ("X refuses every write" vs. "every write
 * is refused") both occur across the real arms, so both are accepted here.
 */
function assertMentionsAllThreeStates(text: string): void {
  expect(text).toMatch(/every customer package/i);
  expect(text).toMatch(/only those/i);
  expect(text).toMatch(/(refuses every write|every write is refused)/i);
}

describe("instructionsFor: end-to-end over a real MCP handshake (edit mode, packages unset)", () => {
  it("a connected client receives instructions describing the resolved allowlist, not a hardcoded default", async () => {
    const cfg = load({ ABAP_MODE: "edit" });
    expect(cfg.abapMode).toBe("edit");
    expect(cfg.readOnly).toBe(false);

    const srv: AbapsmithServer = createServer(cfg, {
      // Never connects, but the config is otherwise ordinary, so answer the
      // system-role probe like every connection-capable suite must.
      httpClient: routeSystemRoleProbe(new ForbiddenClient() as unknown as HttpClient, {
        answer: "nonproductive",
      }),
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);

    const instructions = client.getInstructions();
    expect(instructions).toBeDefined();

    // Re-derived independently of instructionsFor/packageScopeSentence: if
    // EDIT_PACKAGE_DEFAULT ever changes (e.g. back to ["$TMP"]), this
    // expectation moves with the real default and the test below fails
    // unless the shipped sentence also changed to match.
    const resolved = capabilitiesForMode("edit").allowPackages;
    expect(cfg.allowPackages).toEqual(resolved);
    const expectedSentence = resolved.includes("*")
      ? "ABAP_ALLOW_PACKAGES resolves to `*` here (its default when unset), so every customer " +
        "package is writable; a list allows only those, and an empty value refuses every write."
      : `ABAP_ALLOW_PACKAGES is [${resolved.join(", ")}] here, so only those packages are ` +
        "writable; unset allows every customer package, and an empty value refuses every write.";

    expect(instructions).toContain(expectedSentence);
    expect(instructions).not.toContain("default $TMP");

    await client.close();
  });
});

describe("instructionsFor: tri-state coverage over ABAP_ALLOW_PACKAGES, both tool surfaces", () => {
  for (const toolSurface of TOOL_SURFACES) {
    describe(`toolSurface=${toolSurface}`, () => {
      it("unset ABAP_ALLOW_PACKAGES describes every customer package as writable, and mentions the other two states", () => {
        const cfg = load({ ABAP_MODE: "edit" });
        const text = instructionsFor(toolSurface, cfg.abapMode, cfg.readOnly, cfg.allowPackages);
        expect(text).toMatch(/every customer package/i);
        assertMentionsAllThreeStates(text);
      });

      it("ABAP_ALLOW_PACKAGES=$TMP,ZFOO names both packages and says only those are writable", () => {
        const cfg = load({ ABAP_MODE: "edit", ABAP_ALLOW_PACKAGES: "$TMP,ZFOO" });
        expect(cfg.allowPackages).toEqual(["$TMP", "ZFOO"]);
        const text = instructionsFor(toolSurface, cfg.abapMode, cfg.readOnly, cfg.allowPackages);
        expect(text).toContain("$TMP");
        expect(text).toContain("ZFOO");
        expect(text).toMatch(/only those/i);
        assertMentionsAllThreeStates(text);
      });

      it("ABAP_ALLOW_PACKAGES= (explicitly empty) says every write is refused, and mentions the other two states", () => {
        const cfg = load({ ABAP_MODE: "edit", ABAP_ALLOW_PACKAGES: "" });
        expect(cfg.allowPackages).toEqual([]);
        const text = instructionsFor(toolSurface, cfg.abapMode, cfg.readOnly, cfg.allowPackages);
        expect(text).toMatch(/every write is refused/i);
        assertMentionsAllThreeStates(text);
      });
    });
  }
});

describe("instructionsFor: read mode does not blame the allowlist for its own refusal", () => {
  for (const toolSurface of TOOL_SURFACES) {
    it(`toolSurface=${toolSurface}: ABAP_MODE=read does not say the allowlist is empty`, () => {
      const cfg = load({ ABAP_MODE: "read" });
      expect(cfg.readOnly).toBe(true);
      expect(cfg.allowPackages).toEqual([]);
      const text = instructionsFor(toolSurface, cfg.abapMode, cfg.readOnly, cfg.allowPackages);
      expect(text).not.toContain("is empty here");
      // It's the MODE refusing, not the allowlist — say so.
      expect(text).toMatch(/ABAP_MODE is edit or admin/);
    });
  }
});

describe("instructionsFor: regression pin for the write-scope clause", () => {
  it('never claims the write allowlist "default $TMP", in any configuration or tool surface', () => {
    const configs = [
      load({ ABAP_MODE: "edit" }),
      load({ ABAP_MODE: "edit", ABAP_ALLOW_PACKAGES: "$TMP,ZFOO" }),
      load({ ABAP_MODE: "edit", ABAP_ALLOW_PACKAGES: "" }),
      load({ ABAP_MODE: "read" }),
      load({ ABAP_MODE: "admin" }),
      load({ ABAP_ALLOW_WRITE: "true" }),
      load(),
    ];
    for (const cfg of configs) {
      for (const toolSurface of TOOL_SURFACES) {
        const text = instructionsFor(toolSurface, cfg.abapMode, cfg.readOnly, cfg.allowPackages);
        expect(text).not.toContain("default $TMP");
      }
    }
  });
});
