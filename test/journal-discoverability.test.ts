/**
 * #183: `abap_journal` parameter discoverability — new aliases
 * (operation/action/op -> mode, target -> object), the tool description,
 * and the abapsmith-orient router row that points at it.
 *
 * The end-to-end harness is copied from test/param-check.test.ts (itself
 * copied from test/tools.test.ts), not imported — those are private to
 * that file.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { createServer, type AbapsmithServer } from "../src/server.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { Journal } from "../src/journal.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Harness (copied, see file doc comment above)
// ---------------------------------------------------------------------------

class CountingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

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
  journalDir = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-journal-discoverability-"));
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

// ---------------------------------------------------------------------------
// New abap_journal aliases (#183)
// ---------------------------------------------------------------------------

describe("abap_journal: new parameter aliases are discoverable", () => {
  const ACCEPTED =
    "Accepted parameters: mode, entry, detail, object, limit, session, force, activate, outcome, reason.";

  it.each([
    ["operation", "mode"],
    ["action", "mode"],
    ["op", "mode"],
    ["target", "object"],
  ])('an unknown key "%s" is refused with a Did-you-mean toward "%s"', async (bad, canon) => {
    const h = await harness(openCfg());
    const res = await call(h, "abap_journal", { mode: "list", [bad]: "x" });
    const err = errorOf(res);
    expect(err.error).toBe("BAD_INPUT");
    expect(err.message as string).toContain(`does not accept parameter "${bad}"`);
    expect(err.message as string).toContain(`Did you mean "${canon}"?`);
    expect(err.message as string).toContain(ACCEPTED);
    expect(h.http.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tool description text (#183)
// ---------------------------------------------------------------------------

describe("abap_journal: tool description names its parameters and common calls", () => {
  it("advertises the exact contract text", async () => {
    const h = await harness(openCfg());
    const { tools } = await h.client.listTools();
    const journalTool = tools.find((t) => t.name === "abap_journal");
    expect(journalTool).toBeDefined();
    const description = journalTool!.description as string;
    expect(description).toContain(
      "History and undo for writes abapsmith made. Parameters: mode (list|show|undo|reconcile, " +
        "default list), entry, object, detail, limit, session, force, activate, outcome, reason.",
    );
    expect(description).toContain("mode=list (recent writes with entry ids)");
    expect(description).toContain(
      "mode=show entry=<id> (one entry with its before-image; detail=full for the complete images)",
    );
    expect(description).toContain(
      "mode=undo entry=<id> activate=true (revert it — refuses on drift, delete-gate, or an " +
        "enhancement object; see abapsmith-recover-a-bad-write)",
    );
    expect(description).toContain(
      "mode=reconcile entry=<id> outcome=<succeeded|failed> reason=<text> (close a stranded " +
        "`pending` entry — journal bookkeeping only, nothing is sent to SAP)",
    );
  });
});

// ---------------------------------------------------------------------------
// skills/abapsmith-orient/SKILL.md router row (#183)
// ---------------------------------------------------------------------------

describe("skills/abapsmith-orient/SKILL.md: the History and undo row names abap_journal's common calls", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..");
  const skillPath = join(repoRoot, "skills", "abapsmith-orient", "SKILL.md");
  const content = readFileSync(skillPath, "utf8");

  it("contains the updated row text", () => {
    expect(content).toContain(
      "| History and undo | `abap_journal` — `mode=list`, `mode=show entry=<id>`, " +
        "`mode=undo entry=<id> activate=true` |",
    );
  });

  it("stays under the 6144-byte router budget", () => {
    expect(Buffer.byteLength(content, "utf8")).toBeLessThan(6144);
  });
});
