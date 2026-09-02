/**
 * Two DDIC-ref-guidance defects that don't fit `bopf-create-activatability
 * .test.ts` (create_bo-only) or `bopf-delete-reporting.test.ts` (owned by
 * another agent):
 *
 *  - `add_node`'s PUT (`buildNodeFields`) maps caller-supplied
 *    `spec.persistentTableRef`/`spec.persistentStructureRef` straight
 *    through, unlike create_bo's POST (no DDIC refs at all). So the note
 *    `addNodeAutoAssignedRefsNote` (`src/tools/bopf.ts`) fires must compare
 *    the post-write node against `input.spec`, not just against presence —
 *    a caller-supplied ref must never be reported as BOPF's own defaulting.
 *    `bopfStore`'s PUT handler only echoes the raw request body back (no
 *    server-side auto-assignment simulation), so the positive case here
 *    intercepts the PUT itself (same `discardPutRoute`-before-`store.route`
 *    idiom as `bopf-add-node-verify.test.ts`) and injects the captured
 *    post-PUT shape, `03-after-put-item-node-and-assoc.v4.xml` — whose
 *    ITEM ref slots, including the `persistentTableRef` this test asserts
 *    on, predate `add_node` and don't reflect its current behaviour
 *    (resolved live: a bare `add_node` gives a child no ref slots at
 *    all), used here only as a fixed captured shape, not as evidence about
 *    `add_node` (see `test/fixtures/bopf/README.md`).
 *
 *  - (tool-surface half): the armed `cascade_ddic: false` delete path
 *    used to pass only the `generated` half of `collectDdicCascadeCandidates`
 *    (as `leftBehind`) into `buildDeleteResultResponse`, dropping the
 *    `referenced` half (`persistentTableRef`/`persistentStructureRef`)
 *    entirely — unlike the dry-run path, which already receives both. Fixed
 *    by threading `referenced` through as `spared`, rendered under the same
 *    "DDIC SPARED" section/`ddicSparedReason` wording the cascade-true case
 *    already uses.
 *
 * Harness copied verbatim from `bopf-create-activatability.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  EMPTY_200,
  FakeAdtServer,
  __resetFakeAdtCounters,
  bopfStore,
  BOPF_COLLECTION_PATH,
  type FakeRoute,
} from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
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
/** ZBOPF_PRB1 with ITEM node and ROOT->ITEM association added — captured shape: ITEM has persistentTableRef ZBOPF_D_ITEM, no persistentStructureRef. Predates add_node; doesn't reflect its current behaviour (resolved — see test/fixtures/bopf/README.md). */
const FX_AFTER_ADD_NODE = fixture("03-after-put-item-node-and-assoc.v4.xml");
/** ZBOPF_PRB1 active — real captured shape, root has BOTH persistentStructureRef and persistentTableRef set. */
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
  dir = await mkdtemp(join(tmpdir(), "abapsmith-bopf-node-ddic-guidance-"));
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

describe("abap_bopf_edit add_node — auto-assigned DDIC ref note", () => {
  it("names an auto-assigned persistentTableRef the caller's spec did not set", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_ROOT_ONLY });
      // `bopfStore`'s own PUT handler just echoes the request body back — it
      // doesn't simulate BOPF's server-side ref auto-assignment. Intercepting
      // the PUT before `store.route` and swapping in a real captured
      // post-write shape (same idiom as `bopf-add-node-verify.test.ts`'s
      // `discardPutRoute`) is how this test gets a realistic post-add_node
      // model without hand-authoring one.
      const injectAfterPut: FakeRoute = (r) => {
        if (r.method !== "PUT" || r.path !== `${BOPF_COLLECTION_PATH}/zbopf_prb1`) return undefined;
        store.set("zbopf_prb1", FX_AFTER_ADD_NODE);
        return EMPTY_200();
      };
      const { conn } = await wired({ routes: [injectAfterPut, store.route] });
      const { tools } = await registeredTools(conn, journal);

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "add_node",
        name: "ITEM",
        spec: { parent: "ROOT" },
      });

      const text = okText(result);
      expect(text).toContain('spec didn\'t set persistentTableRef ZBOPF_D_ITEM on node "ITEM"');
      expect(text).toContain("came from BOPF's own defaulting, not from this call");
      expect(text).toContain("cascade_ddic never deletes a persistentTableRef or persistentStructureRef");
    });
  });

  it("does NOT report a ref the caller's own spec explicitly set (the honest-vs-blanket-warning case)", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_ROOT_ONLY });
      // The injected post-write shape (03) carries persistentTableRef
      // regardless of what this call's spec supplies — the note must
      // suppress it purely because THIS call's spec supplied it, not
      // because the model lacks it.
      const injectAfterPut: FakeRoute = (r) => {
        if (r.method !== "PUT" || r.path !== `${BOPF_COLLECTION_PATH}/zbopf_prb1`) return undefined;
        store.set("zbopf_prb1", FX_AFTER_ADD_NODE);
        return EMPTY_200();
      };
      const { conn } = await wired({ routes: [injectAfterPut, store.route] });
      const { tools } = await registeredTools(conn, journal);

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "add_node",
        name: "ITEM",
        spec: {
          parent: "ROOT",
          persistentTableRef: { name: "ZBOPF_D_ITEM", type: "TABL/DT" },
        },
      });

      const text = okText(result);
      expect(text).not.toContain("spec didn't set");
      expect(text).not.toContain("BOPF's own defaulting");
    });
  });

  it("an operation other than add_node produces no such note", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_ROOT_ONLY });
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registeredTools(conn, journal);

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "add_query",
        node: "ROOT",
        name: "SELECT_BY_KEY",
        spec: { category: "selectByElements" },
      });

      const text = okText(result);
      expect(text).not.toContain("spec didn't set");
      expect(text).not.toContain("BOPF's own defaulting");
    });
  });
});

describe("abap_bopf_delete armed, cascade_ddic false — DDIC SPARED section for the referenced half", () => {
  it("names the root's persistentStructureRef/persistentTableRef under DDIC SPARED, with the shared ddicSparedReason wording", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_ACTIVE_STRUCTURES });
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registeredTools(conn, journal);

      const result = await invoke(tools, "abap_bopf_delete", {
        bo: "ZBOPF_PRB1",
        dry_run: false,
        confirm: "ZBOPF_PRB1",
      });

      const text = okText(result);
      expect(text).toMatch(/boDeleted: true/);
      expect(text).toMatch(/cascadeDdic: false/);
      expect(text).toContain("DDIC SPARED (provenance unknown — never deleted)");
      expect(text).toContain("ZBOPF_D_ROOT");
      expect(text).toContain("/BOBF/S_DEMO_SALES_ORDER_HDR");
      expect(text).toContain("referenced via persistentTableRef");
      expect(text).toContain("referenced via persistentStructureRef");
      // No new header count — ddicSparedCount already means "spared by a
      // cascade" elsewhere in this same response shape.
      expect(text).not.toContain("ddicSparedCount");

      // Exactly one DDIC SPARED section, not a duplicate.
      const occurrences = text.split("DDIC SPARED (provenance unknown — never deleted)").length - 1;
      expect(occurrences).toBe(1);
    });
  });

  it("cascade_ddic: true does not duplicate the DDIC SPARED section", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_ACTIVE_STRUCTURES });
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registeredTools(conn, journal);

      const result = await invoke(tools, "abap_bopf_delete", {
        bo: "ZBOPF_PRB1",
        dry_run: false,
        confirm: "ZBOPF_PRB1",
        cascade_ddic: true,
        confirm_cascade: "ZBOPF_PRB1",
      });

      const text = okText(result);
      expect(text).toMatch(/cascadeDdic: true/);
      const occurrences = text.split("DDIC SPARED (provenance unknown — never deleted)").length - 1;
      expect(occurrences).toBe(1);
    });
  });
});
