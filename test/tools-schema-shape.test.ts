/**
 * Item-typing of array-valued tool parameters, over the real `tools/list`
 * schema (not the zod source) — a bare `{"type":"array"}` with no `items`
 * sub-schema leaves a client guessing whether the array holds strings,
 * numbers, or objects.
 *
 * Harness: a real MCP `Client` talking to `createServer()` over an
 * `InMemoryTransport`, so the schema under test is exactly what a real
 * client sees from `tools/list` — never the zod source directly.
 */
import { describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { createServer, type AbapsmithServer } from "../src/server.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

class ForbiddenClient implements HttpClient {
  async request(_o: HttpClientOptions): Promise<HttpClientResponse> {
    throw new Error("NETWORK CALL LEAKED: this suite only ever calls listTools()");
  }
}

function fullyOpenConfig(): Config {
  return {
    ...ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "TESTUSER",
      password: "secret",
      sid: "TST",
      client: "001",
      readOnly: false,
      allowPackages: ["*"],
      allowNamePrefixes: ["Z", "Y"],
    }),
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
  it("abap_debug: breakpoints is an array of typed items", async () => {
    const h = await harness(fullyOpenConfig());
    const schema = await schemaOf(h, "abap_debug");
    expectTypedArray(schema, "breakpoints", "abap_debug");
  });

  it("abap_write: view_fields and objects are arrays of typed items", async () => {
    const h = await harness(fullyOpenConfig());
    const schema = await schemaOf(h, "abap_write");
    expectTypedArray(schema, "view_fields", "abap_write");
    expect(schema.properties.view_fields.items.type, "abap_write view_fields items").toBe("string");

    expectTypedArray(schema, "objects", "abap_write");
    expect(schema.properties.objects.items.type, "abap_write objects items").toBe("object");
  });
});

/**
 * `z.discriminatedUnion` lowers to a multi-branch `oneOf` with no `$ref`
 * dedup, so every shared field between the branches is serialized once per
 * branch per session of every client — four times since issue #89 added the
 * `statement` and `message` kinds. This guards the wire size of
 * `abap_debug`'s `breakpoints` property against that regressing, and
 * separately guards that trimming descriptions to fix it never trims an
 * enforced validator.
 */
describe("tool schema — abap_debug breakpoints stays small without losing validators", () => {
  it("abap_debug: breakpoints property serializes under the byte ceiling", async () => {
    const h = await harness(fullyOpenConfig());
    const schema = await schemaOf(h, "abap_debug");
    const bytes = Buffer.byteLength(JSON.stringify(schema.properties.breakpoints), "utf8");
    expect(
      bytes,
      `abap_debug breakpoints serialized to ${bytes} bytes, over the 2100 ceiling. ` +
        "z.discriminatedUnion inlines all four kind branches (line/exception/statement/" +
        "message) with no $ref dedup, so anything written into condition/skipCount is paid " +
        "FOUR times per session by every client — shared-field guidance belongs in the " +
        "array-level description, not on condition/skipCount themselves.",
    ).toBeLessThanOrEqual(2100);
  });

  it("abap_debug: breakpoints branches keep every validator after the description trim", async () => {
    const h = await harness(fullyOpenConfig());
    const schema = await schemaOf(h, "abap_debug");
    const oneOf = schema.properties.breakpoints.items.oneOf as JsonSchema[];
    expect(oneOf, "abap_debug breakpoints items should be a 4-branch oneOf").toHaveLength(4);

    const lineBranch = oneOf.find((b) => b.properties?.kind?.const === "line");
    const exceptionBranch = oneOf.find((b) => b.properties?.kind?.const === "exception");
    const statementBranch = oneOf.find((b) => b.properties?.kind?.const === "statement");
    const messageBranch = oneOf.find((b) => b.properties?.kind?.const === "message");
    expect(lineBranch, "no breakpoints branch with kind.const === \"line\"").toBeDefined();
    expect(exceptionBranch, "no breakpoints branch with kind.const === \"exception\"").toBeDefined();
    expect(statementBranch, "no breakpoints branch with kind.const === \"statement\"").toBeDefined();
    expect(messageBranch, "no breakpoints branch with kind.const === \"message\"").toBeDefined();

    expect(lineBranch!.required, "line branch required fields").toEqual(
      expect.arrayContaining(["kind", "object", "line"]),
    );
    expect(exceptionBranch!.required, "exception branch required fields").toEqual(
      expect.arrayContaining(["kind", "exceptionClass"]),
    );
    expect(statementBranch!.required, "statement branch required fields").toEqual(
      expect.arrayContaining(["kind", "statement"]),
    );
    expect(messageBranch!.required, "message branch required fields").toEqual(
      expect.arrayContaining(["kind", "msgId", "msgNo", "msgTy"]),
    );

    for (const [name, branch] of [
      ["line", lineBranch!],
      ["exception", exceptionBranch!],
      ["statement", statementBranch!],
      ["message", messageBranch!],
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
