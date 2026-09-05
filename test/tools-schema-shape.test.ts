/**
 * Item-typing of array-valued tool parameters, over the real `tools/list`
 * schema (not the zod source) — a bare `{"type":"array"}` with no `items`
 * sub-schema leaves a client guessing whether the array holds strings,
 * numbers, or objects.
 *
 * Harness copied from `test/tools-v2-budget.test.ts` (real MCP `Client` +
 * `InMemoryTransport` + `createServer()`).
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

class ForbiddenClient implements HttpClient {
  async request(_o: HttpClientOptions): Promise<HttpClientResponse> {
    throw new Error("NETWORK CALL LEAKED: this suite only ever calls listTools()");
  }
}

function fullyOpenV1Config(): Config {
  return {
    ...ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "TESTUSER",
      password: "secret",
      sid: "TST",
      client: "001",
      toolSurface: "v1",
      readOnly: false,
      allowPackages: ["*"],
      allowNamePrefixes: ["Z", "Y"],
    }),
  };
}

function v2Config(abapMode: AbapMode): Config {
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
  const client = new Client({ name: "test-schema-shape", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);
  return { srv, client };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonSchema = Record<string, any>;

async function schemaOf(h: Harness, toolName: string): Promise<JsonSchema> {
  const { tools } = await h.client.listTools();
  const tool = tools.find((t) => t.name === toolName);
  expect(tool, `${toolName} not found in tools/list`).toBeDefined();
  return tool!.inputSchema as JsonSchema;
}

/** Asserts `schema.properties[field]` is declared as an array with an `items` sub-schema. */
function expectTypedArray(schema: JsonSchema, field: string, toolName: string): void {
  const prop = schema.properties?.[field];
  expect(prop, `${toolName}'s schema has no "${field}" property`).toBeDefined();
  expect(prop.type, `${toolName}.${field} is not declared as an array`).toBe("array");
  expect(prop.items, `${toolName}.${field} is an array with no "items" sub-schema`).toBeDefined();
}

describe("tool schema — array parameters declare item types", () => {
  it("v1 abap_debug: breakpoints is an array of typed items", async () => {
    const h = await harness(fullyOpenV1Config());
    const schema = await schemaOf(h, "abap_debug");
    expectTypedArray(schema, "breakpoints", "abap_debug (v1)");
  });

  it("v1 abap_write: view_fields and objects are arrays of typed items", async () => {
    const h = await harness(fullyOpenV1Config());
    const schema = await schemaOf(h, "abap_write");
    expectTypedArray(schema, "view_fields", "abap_write (v1)");
    expect(schema.properties.view_fields.items.type, "abap_write (v1) view_fields items").toBe("string");

    expectTypedArray(schema, "objects", "abap_write (v1)");
    expect(schema.properties.objects.items.type, "abap_write (v1) objects items").toBe("object");
  });

  it("v2 abap_debug: breakpoints is an array of typed items", async () => {
    const h = await harness(v2Config("admin"));
    const schema = await schemaOf(h, "abap_debug");
    expectTypedArray(schema, "breakpoints", "abap_debug (v2)");
    expect(schema.properties.breakpoints.items.type, "abap_debug (v2) breakpoints items").toBe("string");
  });
});

/**
 * `z.discriminatedUnion` lowers to a two-branch `oneOf` with no `$ref` dedup,
 * so every shared field between the branches is serialized twice per session
 * of every client. This guards the wire size of `abap_debug`'s `breakpoints`
 * property against that regressing, and separately guards that trimming
 * descriptions to fix it never trims an enforced validator.
 */
describe("tool schema — abap_debug breakpoints stays small without losing validators", () => {
  it("v1 abap_debug: breakpoints property serializes under the byte ceiling", async () => {
    const h = await harness(fullyOpenV1Config());
    const schema = await schemaOf(h, "abap_debug");
    const bytes = Buffer.byteLength(JSON.stringify(schema.properties.breakpoints), "utf8");
    expect(
      bytes,
      `abap_debug breakpoints serialized to ${bytes} bytes, over the 1250 ceiling. ` +
        "z.discriminatedUnion inlines both the line and exception branches with no $ref " +
        "dedup, so anything written into condition/skipCount is paid TWICE per session by " +
        "every client — shared-field guidance belongs in the array-level description, not " +
        "on condition/skipCount themselves.",
    ).toBeLessThanOrEqual(1250);
  });

  it("v1 abap_debug: breakpoints branches keep every validator after the description trim", async () => {
    const h = await harness(fullyOpenV1Config());
    const schema = await schemaOf(h, "abap_debug");
    const oneOf = schema.properties.breakpoints.items.oneOf as JsonSchema[];
    expect(oneOf, "abap_debug breakpoints items should be a 2-branch oneOf").toHaveLength(2);

    const lineBranch = oneOf.find((b) => b.properties?.kind?.const === "line");
    const exceptionBranch = oneOf.find((b) => b.properties?.kind?.const === "exception");
    expect(lineBranch, "no breakpoints branch with kind.const === \"line\"").toBeDefined();
    expect(exceptionBranch, "no breakpoints branch with kind.const === \"exception\"").toBeDefined();

    expect(lineBranch!.required, "line branch required fields").toEqual(
      expect.arrayContaining(["kind", "object", "line"]),
    );
    expect(exceptionBranch!.required, "exception branch required fields").toEqual(
      expect.arrayContaining(["kind", "exceptionClass"]),
    );

    for (const [name, branch] of [
      ["line", lineBranch!],
      ["exception", exceptionBranch!],
    ] as const) {
      expect(branch.properties.condition, `${name} branch condition schema`).toMatchObject({
        type: "string",
        minLength: 1,
        maxLength: 255,
      });
      expect(branch.properties.skipCount, `${name} branch skipCount schema`).toMatchObject({
        type: "integer",
        minimum: 0,
        maximum: 1_000_000,
      });
    }

    expect(lineBranch!.properties.line, "line branch line schema").toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 999_999,
    });
  });
});
