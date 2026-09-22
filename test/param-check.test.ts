/**
 * `src/param-check.ts` — "did you mean" suggestions for unknown tool
 * parameters and bad enum values (`suggestParam`, `suggestEnumValue`,
 * `checkToolArgs`), plus end-to-end coverage that `installParamCheck` is
 * wired into `createMcpServer`/`createServer` so a bad call is refused at
 * the transport boundary, before any tool handler (and therefore before any
 * network request) runs.
 *
 * The end-to-end harness is copied from `test/tools.test.ts`
 * (`harness`/`call`/`errorOf`/`forbiddenClient`/`openCfg`), not imported —
 * those are private to that file.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { createServer, type AbapsmithServer } from "../src/server.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { Journal } from "../src/journal.js";
import { suggestParam, suggestEnumValue, checkToolArgs } from "../src/param-check.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// suggestParam / suggestEnumValue (pure functions)
// ---------------------------------------------------------------------------

describe("suggestParam", () => {
  it("an alias hit wins over everything else", () => {
    expect(suggestParam("id", ["mode", "entry", "object"], { id: "entry" })).toBe("entry");
  });

  it("case-insensitive exact match", () => {
    expect(suggestParam("ENTRY", ["mode", "entry"])).toBe("entry");
  });

  it("a unique prefix (>= 2 chars) matches", () => {
    expect(suggestParam("ent", ["mode", "entry"])).toBe("entry");
    expect(suggestParam("entryx", ["mode", "entry"])).toBe("entry");
  });

  it("a Levenshtein-close typo matches", () => {
    expect(suggestParam("entyr", ["mode", "entry"])).toBe("entry");
    expect(suggestParam("opertion", ["operation", "transport"])).toBe("operation");
  });

  it("an ambiguous input returns undefined", () => {
    expect(suggestParam("x", ["ab", "cd"])).toBeUndefined();
  });

  it("a far input returns undefined", () => {
    expect(suggestParam("zzzzzz", ["entry"])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkToolArgs (pure function, small standalone zod shape)
// ---------------------------------------------------------------------------

describe("checkToolArgs", () => {
  const shape = {
    mode: z.enum(["list", "show"]).optional(),
    entry: z.string().optional(),
  };

  it("an unknown key returns BAD_INPUT with a Did-you-mean and the accepted-parameters list", () => {
    const err = checkToolArgs("abap_journal", shape, { id: "abc" }, { id: "entry" });
    expect(err).toBeDefined();
    expect(err!.code).toBe("BAD_INPUT");
    expect(err!.message).toContain('does not accept parameter "id"');
    expect(err!.message).toContain('Did you mean "entry"?');
    expect(err!.message).toContain("Accepted parameters: mode, entry");
    expect(err!.details.unknown).toEqual(["id"]);
  });

  it("an invalid enum value returns BAD_INPUT naming the valid values", () => {
    const err = checkToolArgs("abap_journal", shape, { mode: "history" });
    expect(err).toBeDefined();
    expect(err!.code).toBe("BAD_INPUT");
    expect(err!.message).toContain('mode "history" is not valid');
    expect(err!.message).toContain("Valid values: list, show");
  });

  it("valid args return undefined", () => {
    expect(checkToolArgs("abap_journal", shape, { mode: "show", entry: "abc" })).toBeUndefined();
  });

  it("non-object args return undefined", () => {
    expect(checkToolArgs("abap_journal", shape, undefined)).toBeUndefined();
    expect(checkToolArgs("abap_journal", shape, null)).toBeUndefined();
    expect(checkToolArgs("abap_journal", shape, "nope")).toBeUndefined();
  });

  it("an enum wrapped in .optional().default(...) is still checked", () => {
    const wrapped = {
      mode: z.enum(["list", "show"]).optional().default("list"),
      entry: z.string().optional(),
    };
    const err = checkToolArgs("abap_journal", wrapped, { mode: "history" });
    expect(err).toBeDefined();
    expect(err!.code).toBe("BAD_INPUT");
    expect(err!.message).toContain('mode "history" is not valid');
  });
});

// ---------------------------------------------------------------------------
// Installed in the server (end to end, zero wire requests)
// ---------------------------------------------------------------------------

class CountingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

// A refused call never opens a connection, so the system-role probe is never
// sent; routing it anyway means a leaked call fails on the throw below rather
// than on an inconclusive-system lockout.
const forbiddenClient = () =>
  routeSystemRoleProbe(
    new CountingClient(() => {
      throw new Error("NETWORK CALL LEAKED: a BAD_INPUT call reached the transport");
    }),
    { answer: "nonproductive" },
  );

const cfg = (over: Partial<Config> = {}): Config => ({
  ...ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    allowTransports: ["*"],
  }),
  ...over,
});

const openCfg = (over: Partial<Config> = {}): Config =>
  cfg({
    readOnly: false,
    allowPackages: ["*"],
    allowNamePrefixes: ["Z", "Y"],
    allowTransportRelease: true,
    allowEnhancements: true,
    enhanceTargets: "sap",
    enhanceTargetPackages: ["*"],
    ...over,
  });

interface Harness {
  srv: AbapsmithServer;
  client: Client;
  http: CountingClient;
}

let journalDir = "";
beforeEach(async () => {
  journalDir = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-param-check-"));
});
afterEach(async () => {
  await fs.rm(journalDir, { recursive: true, force: true });
});

async function harness(config: Config, http = forbiddenClient()): Promise<Harness> {
  const srv = createServer(config, {
    httpClient: http,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
    journal: new Journal({ dir: journalDir, enabled: true, maxEntries: 100, maxAgeDays: 30 }, config.sid),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);
  return { srv, client, http };
}

interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

const call = async (h: Harness, name: string, args: Record<string, unknown>) =>
  (await h.client.callTool({ name, arguments: args })) as unknown as ToolCallResult;

const errorOf = (res: ToolCallResult): Record<string, unknown> => {
  expect(res.isError).toBe(true);
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
};

describe("installed in the server (end to end, zero wire requests)", () => {
  it("abap_journal: an unknown key ('id') is refused with a Did-you-mean toward 'entry'", async () => {
    const h = await harness(openCfg());
    const res = await call(h, "abap_journal", { mode: "show", id: "abc" });
    const err = errorOf(res);
    expect(err.error).toBe("BAD_INPUT");
    expect(err.message as string).toContain('"id"');
    expect(err.message as string).toContain('Did you mean "entry"?');
    expect(err.hint as string).toContain("entry=");
    expect(h.http.calls).toHaveLength(0);
  });

  it("abap_journal: an invalid mode value names the valid values", async () => {
    const h = await harness(openCfg());
    const res = await call(h, "abap_journal", { mode: "history" });
    const err = errorOf(res);
    expect(err.error).toBe("BAD_INPUT");
    expect(err.message as string).toContain("Valid values: list, show, undo, reconcile");
    expect(h.http.calls).toHaveLength(0);
  });

  it('abap_transport: an unknown key ("action") is refused with a Did-you-mean toward "operation"', async () => {
    const h = await harness(openCfg());
    const res = await call(h, "abap_transport", { action: "show", transport: "A4HK900001" });
    const err = errorOf(res);
    expect(err.error).toBe("BAD_INPUT");
    expect(err.message as string).toContain('Did you mean "operation"?');
    expect(h.http.calls).toHaveLength(0);
  });

  it('abap_bopf: an unknown key ("object") is refused with a Did-you-mean toward "bo"', async () => {
    const h = await harness(openCfg());
    const res = await call(h, "abap_bopf", { object: "ZBO" });
    const err = errorOf(res);
    expect(err.error).toBe("BAD_INPUT");
    expect(err.message as string).toContain('Did you mean "bo"?');
    expect(h.http.calls).toHaveLength(0);
  });

  it('abap_bopf_edit: an unknown key ("object") is refused with a Did-you-mean toward "bo"', async () => {
    const h = await harness(openCfg());
    const res = await call(h, "abap_bopf_edit", { operation: "add_node", object: "ZBO", name: "CHILD" });
    const err = errorOf(res);
    expect(err.error).toBe("BAD_INPUT");
    expect(err.message as string).toContain('Did you mean "bo"?');
    expect(h.http.calls).toHaveLength(0);
  });

  it('abap_bopf_edit: an invalid operation ("add_nodes") is refused with a Did-you-mean toward "add_node"', async () => {
    const h = await harness(openCfg());
    const res = await call(h, "abap_bopf_edit", { operation: "add_nodes", bo: "ZBO", name: "CHILD" });
    const err = errorOf(res);
    expect(err.error).toBe("BAD_INPUT");
    expect(err.message as string).toContain('operation "add_nodes" is not valid');
    expect(err.message as string).toContain('Did you mean "add_node"?');
    expect(h.http.calls).toHaveLength(0);
  });

  it("the advertised schema is unchanged", async () => {
    const h = await harness(openCfg());
    const { tools } = await h.client.listTools();
    const journalTool = tools.find((t) => t.name === "abap_journal");
    expect(journalTool).toBeDefined();
    const schema = journalTool!.inputSchema as {
      properties?: Record<string, { enum?: string[] }>;
      additionalProperties?: unknown;
    };
    expect(schema.properties?.entry).toBeDefined();
    expect(schema.properties?.mode?.enum).toEqual(["list", "show", "undo", "reconcile"]);
    expect(schema.additionalProperties ?? false).toBe(false);
  });

  it("a valid call still reaches the handler: abap_journal mode=list is not an error", async () => {
    const h = await harness(openCfg());
    const res = await call(h, "abap_journal", { mode: "list" });
    expect(res.isError).not.toBe(true);
    expect(h.http.calls).toHaveLength(0);
  });
});
