/**
 * `create_bo`'s response notes for the state it just created.
 *
 * `buildCreateBody` (`src/adt/bopf.ts`) sends no DDIC refs, so whatever the
 * server fills into the freshly re-read root node is entirely BOPF's own
 * doing. The captured create response `test/fixtures/bopf/
 * 02-created-zbopf_prb1-root-only.v4.xml` shows the real shape: root node
 * `ROOT` comes back with `combinedStructureRef`/`combinedTableRef`/
 * `persistentTableRef` but no `persistentStructureRef`. Activating a BO in
 * that state fails with "Data structure is missing" — reported live
 * as "can never be activated" and "no operation lets a caller repair it",
 * but `set_node_flags` already accepts a `persistentStructureRef` ref on an
 * EXISTING node (see `patchNodeFlags`'s doc comment, `src/tools/bopf.ts`),
 * so the actual gap is only that `create_bo`'s own response never says any
 * of this.
 *
 * `create_bo` is also the one point in the lifecycle where "BOPF assigned
 * this ref, the caller didn't" is knowable at all — and `persistentTableRef`/
 * `persistentStructureRef` are exactly the two ref slots `abap_bopf_delete
 * cascade_ddic` spares (`collectDdicCascadeCandidates`), so an auto-assigned
 * one outlives a cascade delete unless removed by hand.
 *
 * `createBoActivatabilityNotes` (`src/tools/bopf.ts`, local to that module)
 * is a pure function of the freshly re-read `BoModel` — driven here mostly
 * through the real `abap_bopf_edit create_bo` tool call over a
 * `FakeAdtServer` (same idiom as `test/bopf-cascade-provenance.test.ts`:
 * real tool/wire-client functions, only the HTTP socket is fake), with one
 * case exercised directly via `parseModel` since it needs no wire traffic
 * at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { FakeAdtServer, __resetFakeAdtCounters, bopfStore, type FakeRoute } from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { parseModel } from "../src/adt/bopf-xml.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import type { SessionPool } from "../src/adt/pool.js";
import { errorResult } from "../src/server.js";
import { Journal, type JournalConfig } from "../src/journal.js";
import { registerBopfTools, type BopfToolDeps } from "../src/tools/bopf.js";

// --------------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/** ZBOPF_PRB1 right after create_bo — real captured shape, root has no persistentStructureRef. */
const FX_ROOT_ONLY = fixture("02-created-zbopf_prb1-root-only.v4.xml");
/** ZBOPF_PRB1 active, after its structures were authored — real captured shape, root HAS a persistentStructureRef. */
const FX_ACTIVE_STRUCTURES = fixture("04-active-after-structures.v4.xml");

// ----------------------------------------------------------------------- harness ---

const systemRoleRoute: FakeRoute = (r) => (r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined);

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

const openConnections: AbapConnection[] = [];

beforeEach(() => {
  __resetFakeAdtCounters();
});

afterEach(() => {
  for (const conn of openConnections.splice(0)) conn.dispose();
});

async function wired(options: { routes?: readonly FakeRoute[] } = {}): Promise<{ conn: AbapConnection; server: FakeAdtServer }> {
  const server = new FakeAdtServer({ transportErrors: "throw", routes: [systemRoleRoute, ...(options.routes ?? [])] });
  const client = server.client("s1");
  const conn = new AbapConnection(cfg(), { httpClient: client, log: () => {}, breaker: new AuthCircuitBreaker() });
  openConnections.push(conn);
  await conn.connect();
  return { conn, server };
}

function fakePool(conn: AbapConnection): SessionPool {
  return {
    withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    withWrite: <T,>(_op: string, _objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    reserveDebug: () => {
      throw new Error("reserveDebug: not used by any BOPF tool, and not implemented in this fake.");
    },
  } as unknown as SessionPool;
}

function fakeMcp(): { mcp: McpServer; tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> } {
  const tools = new Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>();
  const mcp = {
    registerTool: (name: string, _config: unknown, handler: (args: unknown) => Promise<CallToolResult>) => {
      tools.set(name, { handler });
      return {} as unknown;
    },
  } as unknown as McpServer;
  return { mcp, tools };
}

async function invoke(
  tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>,
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  const entry = tools.get(name);
  if (!entry) throw new Error(`tool "${name}" was never registered`);
  return entry.handler(args);
}

function okText(result: CallToolResult): string {
  expect(result.isError).toBeFalsy();
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return text.text;
}

const openGate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransportRelease: true, allowCascadeDelete: true });

const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({ kind: "local", required: false, mustSupplyCorrNr: false, serverWouldFabricate: false, ...overrides }) as unknown as TrRequirement;

const localTransport = (): SessionTransport =>
  new SessionTransport({ allowTransports: ["auto"], cts: { trRequirement: async () => fakeReq() } });

let dir: string;
const jcfg = (): JournalConfig => ({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 });

const withJournal = async (fn: (j: Journal) => Promise<void>): Promise<void> => {
  dir = await mkdtemp(join(tmpdir(), "abapsmith-bopf-create-activatability-"));
  try {
    await fn(new Journal(jcfg(), "A4H"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

function depsFor(conn: AbapConnection, journal: Journal): BopfToolDeps {
  return {
    pool: fakePool(conn),
    safety: openGate(),
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 30_000 },
    transport: localTransport(),
    registerWrite: true,
    journal,
  };
}

async function registeredTools(
  conn: AbapConnection,
  journal: Journal,
): Promise<{ tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> }> {
  const { mcp, tools } = fakeMcp();
  registerBopfTools(mcp, depsFor(conn, journal));
  return { tools };
}

// ===========================================================================

describe("abap_bopf_edit create_bo — missing persistentStructureRef note", () => {
  it("names the actual root node, the fixture's own shape, activation's failure text, and the set_node_flags repair", async () => {
    await withJournal(async (journal) => {
      // Pre-seeded so create_bo's post-create GET returns the REAL captured
      // root-only bytes instead of bopfStore's synthetic default body —
      // the POST route only fills a default when no entry already exists.
      const store = bopfStore({ zbopf_prb1: FX_ROOT_ONLY });
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registeredTools(conn, journal);

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "create_bo",
        package: "$TMP",
      });

      const text = okText(result);
      expect(text).toContain('Root node "ROOT" has no persistentStructureRef');
      expect(text).toContain("Data structure is missing");
      expect(text).toContain("set_node_flags");
      expect(text).toContain('spec.persistentStructureRef = { name, type: "TABL/DS" }');
      expect(text).toContain("point at an existing one, or create it with abap_write");
    });
  });

  it("names the auto-assigned persistentTableRef and points at the cascade_persistent opt-in to remove it", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_ROOT_ONLY });
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registeredTools(conn, journal);

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "create_bo",
        package: "$TMP",
      });

      const text = okText(result);
      expect(text).toContain("create_bo sends no DDIC refs");
      expect(text).toContain("persistentTableRef ZBOPF_D_ROOT");
      expect(text).toContain('cascade_persistent: ["ZBOPF_D_ROOT"]');

      // The cascade DOES delete combinedTableRef/combinedStructureRef/the
      // constants interface — those must not show up in this note.
      const autoNoteStart = text.indexOf("create_bo sends no DDIC refs");
      const autoNoteEnd = text.indexOf("\n", text.indexOf('cascade_persistent: ["ZBOPF_D_ROOT"]', autoNoteStart));
      const autoNote = text.slice(autoNoteStart, autoNoteEnd === -1 ? undefined : autoNoteEnd);
      expect(autoNote).not.toContain("combinedTableRef");
      expect(autoNote).not.toContain("combinedStructureRef");
      expect(autoNote).not.toContain("ZIF_BOPF_PRB1_C");
    });
  });

  it("a model whose root already has a persistentStructureRef produces no missing-structure note", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_ACTIVE_STRUCTURES });
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registeredTools(conn, journal);

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "create_bo",
        package: "$TMP",
      });

      const text = okText(result);
      expect(text).not.toContain("has no persistentStructureRef");
      expect(text).not.toContain("Data structure is missing");
    });
  });
});

describe("abap_bopf_edit create_bo — persistentStructureRef/other-refs asymmetry note", () => {
  it("states the other three ref slots must not already exist, with the live evidence and consequence", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_ROOT_ONLY });
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registeredTools(conn, journal);

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "create_bo",
        package: "$TMP",
      });

      const text = okText(result);
      expect(text).toContain(
        "persistentTableRef, combinedTableRef, combinedStructureRef — work the opposite way from " +
          "persistentStructureRef",
      );
      expect(text).toContain("must NOT already exist");
      expect(text).toContain('Data Type <NAME> already exists');
      expect(text).toContain("not a name collision to rename around, but an unactivatable object");
      expect(text).toContain("a name nothing will ever create by hand");
    });
  });

  it("states the root-only-vs-child activation requirement without asserting add_node never supplies the other refs", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_ROOT_ONLY });
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registeredTools(conn, journal);

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "create_bo",
        package: "$TMP",
      });

      const text = okText(result);
      expect(text).toContain("a root-only BO activates with just persistentStructureRef");
      expect(text).toContain('"Database table is missing" (persistentTableRef)');
      expect(text).toContain('"Combined table type is missing" (combinedTableRef)');
      expect(text).toContain('"Combined structure is missing" (combinedStructureRef)');
      // The hedge is load-bearing: fixture 03 and a live run disagree
      // on whether add_node leaves a child with these three unset, so the
      // note must not assert either way.
      expect(text).toContain("varies by observation — don't assume either way");
    });
  });

  it("does not claim combinedStructureRef/combinedTableRef were tested against a pre-existing object", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_ROOT_ONLY });
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registeredTools(conn, journal);

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "create_bo",
        package: "$TMP",
      });

      const text = okText(result);
      expect(text).toContain(
        "Whether combinedStructureRef/combinedTableRef fail the same way, or whether this rule holds on " +
          "releases other than A4H, was not tested.",
      );
    });
  });

  it("a model whose root already has a persistentStructureRef produces no asymmetry note either", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_ACTIVE_STRUCTURES });
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registeredTools(conn, journal);

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "create_bo",
        package: "$TMP",
      });

      const text = okText(result);
      expect(text).not.toContain("work the opposite way from persistentStructureRef");
      expect(text).not.toContain("Database table is missing");
    });
  });
});

describe("parseModel(04-active-after-structures.v4.xml) — direct model shape backing the no-note case above", () => {
  it("the root node genuinely carries a persistentStructureRef, so the fixture is a real negative case, not an artifact of the fake server", () => {
    const model = parseModel(FX_ACTIVE_STRUCTURES);
    const root = model.nodes.find((n) => n.rootNode);
    expect(root?.name).toBe("ROOT");
    expect(root?.persistentStructureRef?.name).toBe("/BOBF/S_DEMO_SALES_ORDER_HDR");
  });
});

describe("parseModel(02-created-zbopf_prb1-root-only.v4.xml) — direct model shape backing the notes above", () => {
  it("the root node genuinely has no persistentStructureRef but does have a persistentTableRef, confirming the notes are driven by real fixture data", () => {
    const model = parseModel(FX_ROOT_ONLY);
    const root = model.nodes.find((n) => n.rootNode);
    expect(root?.name).toBe("ROOT");
    expect(root?.persistentStructureRef).toBeUndefined();
    expect(root?.persistentTableRef?.name).toBe("ZBOPF_D_ROOT");
  });
});
