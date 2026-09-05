/**
 * Regression tests: `abap_bopf_edit` had `remove_node` and
 * `remove_association` and no removal for anything else. Re-calling
 * `add_determination` (or add_action/add_validation/add_query/
 * add_alternative_key) with an existing name used to not replace the
 * element — it added a SECOND one with the same name, the BO then failed
 * activation permanently, and nothing could undo it short of deleting and
 * rebuilding the whole business object. `add_*` now refuses that re-add
 * outright (`refuseDuplicateChild`, src/tools/bopf.ts) before it ever
 * reaches the wire, but a duplicate can still land on the model some other
 * way, and once it has, `remove_*` is what gets it back out.
 *
 * `remove_action`/`remove_determination`/`remove_validation`/`remove_query`/
 * `remove_alternative_key` close that gap: each takes node + name, removes
 * the FIRST matching element in document order (so calling twice unwinds a
 * duplicate), and — like `add_node`/`add_alternative_key` before them —
 * re-reads the model after the PUT and fails `CHECK_FAILED` rather than
 * report a removal the server silently discarded (a BOPF PUT answers 200
 * whether or not it kept what was sent).
 *
 * Harness: identical to `test/bopf-tools.test.ts` and
 * `test/bopf-add-node-verify.test.ts` — a real `AbapConnection` against a
 * `FakeAdtServer`, a real `SafetyGate`, real `errorResult`. Only the HTTP
 * socket and `SessionPool` are fake. `bopfStore` retains PUT bodies, which is
 * what makes a real add-then-remove sequence testable end to end without a
 * live SAP system.
 *
 * The alternativeKey case's `keyElements: ["FIELD1"]` names a property that
 * does not exist on `FX_JUST_CREATED`'s ROOT, so its add now needs
 * `allow_dangling_ref: true` to clear `alternativeKeyPreflight` — this file
 * isn't testing that check, add/remove-count is.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  EMPTY_200,
  FakeAdtServer,
  __resetFakeAdtCounters,
  activationRoute,
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
import { Journal } from "../src/journal.js";
import { registerBopfTools, type BopfToolDeps } from "../src/tools/bopf.js";
/**
 * The five child kinds this file adds/removes. Deliberately not imported from
 * `src/adt/bopf-xml.ts` — `countChildren` below reads the wire XML directly,
 * independent of the production parser it is meant to be checking on.
 */
type RemovableKind = "action" | "determination" | "validation" | "query" | "alternativeKey";

// --------------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/**
 * ZBOPF_PRB1, inactive, one node (ROOT). Despite the filename, ROOT is not
 * childless: it already carries two queries (SELECT_ALL, SELECT_BY_ELEMENTS)
 * and one action (LOCK_ROOT) from creation — no associations, determinations,
 * validations, or alternative keys. Tests below that need a kind with
 * genuinely zero pre-existing members use determination/validation/
 * alternativeKey, not action/query.
 */
const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");

// ----------------------------------------------------------------------- harness ---
// Copied verbatim from test/bopf-tools.test.ts's harness section.

const systemRoleRoute: FakeRoute = (r) =>
  r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined;

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

async function wired(
  options: { routes?: readonly FakeRoute[]; catchAll?: FakeRoute } = {},
): Promise<{ conn: AbapConnection; server: FakeAdtServer }> {
  const server = new FakeAdtServer({
    transportErrors: "throw",
    routes: [systemRoleRoute, ...(options.routes ?? [])],
    ...(options.catchAll ? { catchAll: options.catchAll } : {}),
  });
  const client = server.client("s1");
  const conn = new AbapConnection(cfg(), {
    httpClient: client,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  openConnections.push(conn);
  await conn.connect();
  return { conn, server };
}

function callsAfterConnect(server: FakeAdtServer): number {
  return server.calls.length;
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

function fakeMcp(): { mcp: McpServer; tools: Map<string, { config: unknown; handler: (args: unknown) => Promise<CallToolResult> }> } {
  const tools = new Map<string, { config: unknown; handler: (args: unknown) => Promise<CallToolResult> }>();
  const mcp = {
    registerTool: (name: string, config: unknown, handler: (args: unknown) => Promise<CallToolResult>) => {
      tools.set(name, { config, handler });
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

function errorPayload(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBe(true);
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return JSON.parse(text.text) as Record<string, unknown>;
}

const openGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowTransportRelease: true,
    allowCascadeDelete: true,
  });

const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({
    kind: "transport",
    required: true,
    mustSupplyCorrNr: true,
    serverWouldFabricate: false,
    ...overrides,
  }) as unknown as TrRequirement;

const localTransport = (): SessionTransport =>
  new SessionTransport({
    allowTransports: ["auto"],
    cts: { trRequirement: async () => fakeReq({ kind: "local" }) },
  });

function depsFor(
  conn: AbapConnection,
  opts: { safety?: SafetyGate; transport?: SessionTransport; journal?: Journal } = {},
): BopfToolDeps {
  return {
    pool: fakePool(conn),
    safety: opts.safety ?? openGate(),
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 30_000 },
    transport: opts.transport ?? localTransport(),
    registerWrite: true,
    ...(opts.journal ? { journal: opts.journal } : {}),
  };
}

async function registered(
  conn: AbapConnection,
  opts: { safety?: SafetyGate; transport?: SessionTransport; journal?: Journal } = {},
): Promise<{ tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>; deps: BopfToolDeps }> {
  const { mcp, tools } = fakeMcp();
  const deps = depsFor(conn, opts);
  registerBopfTools(mcp, deps);
  return { tools, deps };
}

/** Same idiom as bopf-add-node-verify.test.ts's `withTempJournal` — a real Journal against a temp dir, for the one test that needs a genuine journalEntryId. */
async function withTempJournal<T>(fn: (journal: Journal) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "abapsmith-bopf-remove-ops-"));
  try {
    return await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const CHILD_TAG: Readonly<Record<RemovableKind, string>> = {
  action: "bo:actions",
  determination: "bo:determinations",
  validation: "bo:validations",
  query: "bo:queries",
  alternativeKey: "bo:alternativeKeys",
};

/**
 * Count of children named `name` of `kind` on `node`, read straight off the
 * wire XML by string search — deliberately not routed through the production
 * `scanModel`/`listChildNames` parser this file exists to put through its
 * paces. Scoped to the named `<bo:nodes>` element's span (open tag through
 * its matching `</bo:nodes>`); every fixture and PUT body this file exercises
 * has exactly one node, so a plain `indexOf` for the close tag is safe.
 * Matches both wire forms a child element can take: self-closing (no
 * children, e.g. a bare action or query) and open/close (has children, e.g.
 * an alternative key with a dataTypeRef and key elements).
 */
function countChildren(xml: string, node: string, kind: RemovableKind, name: string): number {
  const openMatch = new RegExp(`<bo:nodes\\b[^>]*\\bbo:name="${node}"[^>]*>`).exec(xml);
  if (!openMatch) return 0;
  const bodyStart = openMatch.index + openMatch[0].length;
  const closeAt = xml.indexOf("</bo:nodes>", bodyStart);
  const body = closeAt === -1 ? xml.slice(bodyStart) : xml.slice(bodyStart, closeAt);
  const tag = CHILD_TAG[kind];
  const childRe = new RegExp(`<${tag}\\b[^>]*\\bbo:name="${name}"[^>]*(?:/>|>[\\s\\S]*?</${tag}>)`, "g");
  return (body.match(childRe) ?? []).length;
}

/**
 * Duplicates the first `kind` child named `name` on `node`, inserting a
 * byte-identical copy immediately after it. `add_*` now refuses to create a
 * duplicate itself (`refuseDuplicateChild`, src/tools/bopf.ts), so this is
 * how the tests below still get one onto the model — standing in for
 * whatever real-world route (a migrated BO, a race) puts one there. Matches
 * `countChildren`'s two wire forms. Gives the copy a distinct `bo:nodeID`
 * (suffixed `_DUP`) when the original has one, so the seed looks like two
 * elements the server actually holds rather than one pasted twice.
 */
function duplicateChild(xml: string, node: string, kind: RemovableKind, name: string): string {
  const openMatch = new RegExp(`<bo:nodes\\b[^>]*\\bbo:name="${node}"[^>]*>`).exec(xml);
  if (!openMatch) throw new Error(`duplicateChild: node "${node}" not found`);
  const bodyStart = openMatch.index + openMatch[0].length;
  const closeAt = xml.indexOf("</bo:nodes>", bodyStart);
  const bodyEnd = closeAt === -1 ? xml.length : closeAt;
  const tag = CHILD_TAG[kind];
  const childRe = new RegExp(`<${tag}\\b[^>]*\\bbo:name="${name}"[^>]*(?:/>|>[\\s\\S]*?</${tag}>)`);
  const match = childRe.exec(xml.slice(bodyStart, bodyEnd));
  if (!match) throw new Error(`duplicateChild: no ${kind} named "${name}" on node "${node}"`);
  const original = match[0];
  const insertAt = bodyStart + match.index + original.length;
  const idMatch = /bo:nodeID="([^"]*)"/.exec(original);
  const copy = idMatch ? original.replace(idMatch[0], `bo:nodeID="${idMatch[1]}_DUP"`) : original;
  return xml.slice(0, insertAt) + copy + xml.slice(insertAt);
}

// ===========================================================================

describe("remove_determination: add_* refuses a re-add under an existing name; a duplicate reaching the model some other way still unwinds one call at a time", () => {
  it("add_determination refuses a second call under an existing name (BAD_INPUT, model untouched); remove_determination still unwinds a duplicate seeded directly on the model", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const addDetermination = () =>
      invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "add_determination",
        node: "ROOT",
        name: "DET_DUP",
        spec: { category: "reactDuringSave" },
      });
    const count = (xml: string) => countChildren(xml, "ROOT", "determination", "DET_DUP");

    expect((await addDetermination()).isError).toBeFalsy();
    const afterFirstAdd = store.get("zbopf_prb1")!;
    expect(count(afterFirstAdd)).toBe(1);

    const refused = await addDetermination();
    expect(errorPayload(refused).error).toBe("BAD_INPUT");
    expect(store.get("zbopf_prb1")).toBe(afterFirstAdd); // refused before the splice — no PUT, model untouched

    const duplicated = duplicateChild(afterFirstAdd, "ROOT", "determination", "DET_DUP");
    expect(count(duplicated)).toBe(2);

    const removeStore = bopfStore({ zbopf_prb1: duplicated });
    const { conn: removeConn } = await wired({ routes: [removeStore.route] });
    const { tools: removeTools } = await registered(removeConn);

    const remove1 = await invoke(removeTools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "remove_determination",
      node: "ROOT",
      name: "DET_DUP",
    });
    expect(remove1.isError).toBeFalsy();
    expect(count(removeStore.get("zbopf_prb1")!)).toBe(1);

    const remove2 = await invoke(removeTools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "remove_determination",
      node: "ROOT",
      name: "DET_DUP",
    });
    expect(remove2.isError).toBeFalsy();
    expect(count(removeStore.get("zbopf_prb1")!)).toBe(0);
  });
});

// ===========================================================================

interface RemovalCase {
  readonly kind: RemovableKind;
  readonly addOperation: string;
  readonly removeOperation: string;
  readonly name: string;
  readonly spec: Record<string, unknown>;
}

const REMOVAL_TABLE: readonly RemovalCase[] = [
  { kind: "action", addOperation: "add_action", removeOperation: "remove_action", name: "MY_ACTION", spec: {} },
  {
    kind: "determination",
    addOperation: "add_determination",
    removeOperation: "remove_determination",
    name: "MY_DET",
    spec: { category: "reactDuringSave" },
  },
  {
    kind: "validation",
    addOperation: "add_validation",
    removeOperation: "remove_validation",
    name: "MY_VAL",
    spec: { category: "consistencyCheck" },
  },
  { kind: "query", addOperation: "add_query", removeOperation: "remove_query", name: "MY_QUERY", spec: { category: "selectAll" } },
  {
    kind: "alternativeKey",
    addOperation: "add_alternative_key",
    removeOperation: "remove_alternative_key",
    name: "MY_ALTKEY",
    spec: {
      uniqueness: "unique",
      dataTypeRef: { name: "ZSORDER_ID", type: "TABL/DS" },
      dataTableTypeRef: { name: "ZTORDER_ID", type: "TTYP/DA" },
      keyElements: ["FIELD1"],
    },
  },
];

describe("each of the five new remove_* operations actually removes its kind", () => {
  it.each(REMOVAL_TABLE.map((c) => [c.kind, c] as const))("%s: add then remove leaves the count at 0", async (_kind, c) => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const addArgs: Record<string, unknown> = {
      bo: "ZBOPF_PRB1",
      operation: c.addOperation,
      node: "ROOT",
      name: c.name,
      spec: c.spec,
    };
    if (c.addOperation === "add_alternative_key") {
      addArgs.i_know_this_may_not_activate = true;
      addArgs.allow_dangling_ref = true;
    }

    const addResult = await invoke(tools, "abap_bopf_edit", addArgs);
    expect(addResult.isError).toBeFalsy();
    expect(countChildren(store.get("zbopf_prb1")!, "ROOT", c.kind, c.name)).toBe(1);

    const removeResult = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: c.removeOperation,
      node: "ROOT",
      name: c.name,
    });
    expect(removeResult.isError).toBeFalsy();
    expect(countChildren(store.get("zbopf_prb1")!, "ROOT", c.kind, c.name)).toBe(0);
  });
});

// ===========================================================================

describe("remove_determination: a discarded removal is CHECK_FAILED, not success", () => {
  it("returns CHECK_FAILED when the server accepts the PUT (200) but keeps nothing — with countBefore/countAfter/journalEntryId, and sends no activation request even with activate: true", async () => {
    // Seed a node that genuinely has a determination to remove, via a real
    // add first (a separate connection/server — only the resulting XML is
    // carried over as the seed for the discarding one below).
    const seedStore = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn: seedConn } = await wired({ routes: [seedStore.route] });
    const { tools: seedTools } = await registered(seedConn);
    const seeded = await invoke(seedTools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "DET1",
      spec: { category: "reactDuringSave" },
    });
    expect(seeded.isError).toBeFalsy();
    const seededXml = seedStore.get("zbopf_prb1")!;
    expect(countChildren(seededXml, "ROOT", "determination", "DET1")).toBe(1);

    await withTempJournal(async (journal) => {
      // BOPF's own documented lie: 200 on a PUT it silently
      // discarded. Routed BEFORE store.route so the PUT never actually lands
      // in the backing map — the subsequent re-read GET (putModel's own)
      // serves back the untouched, pre-removal XML.
      const discardPutRoute: FakeRoute = (r) =>
        r.method === "PUT" && r.path === `${BOPF_COLLECTION_PATH}/zbopf_prb1` ? EMPTY_200() : undefined;

      // A real (counted, matching) activation route — not a bare absence of
      // one. Without this, an operation that wrongly reaches activation
      // would hit no route at all and blow up as an unrouted-request
      // protocol error, which happens to also fail this test but for the
      // wrong reason: a crash of that shape doesn't distinguish "activation
      // was attempted" from "some unrelated stray request went astray".
      // With a route that actually answers activation POSTs, the zero-calls
      // assertion below is a direct read of the server's request log, not
      // an inference drawn from how the failure happened to look.
      const store = bopfStore({ zbopf_prb1: seededXml });
      const { conn, server } = await wired({ routes: [discardPutRoute, store.route, activationRoute({})] });
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "remove_determination",
        node: "ROOT",
        name: "DET1",
        activate: true,
      });

      const payload = errorPayload(result);
      expect(payload.error).toBe("CHECK_FAILED");
      const details = payload.details as Record<string, unknown>;
      expect(details.countBefore).toBe(1);
      expect(details.countAfter).toBe(1);
      expect(typeof details.journalEntryId).toBe("string");
      expect(details.journalEntryId).toBeTruthy();

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.id).toBe(details.journalEntryId);

      expect(store.get("zbopf_prb1")).toBe(seededXml); // discarded, as BOPF actually did

      const activationCalls = server.calls.filter((r) => r.method === "POST" && r.path.includes("/sap/bc/adt/activation"));
      expect(activationCalls).toHaveLength(0);
    });
  });
});

// ===========================================================================

describe("remove_*: NOT_FOUND names what is actually present on the node", () => {
  it("lists existing validations, including a duplicated name TWICE (not deduplicated), when the requested name is not among them", async () => {
    const seedStore = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn: seedConn } = await wired({ routes: [seedStore.route] });
    const { tools: seedTools } = await registered(seedConn);

    for (const name of ["DUP", "OTHER"]) {
      const r = await invoke(seedTools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "add_validation",
        node: "ROOT",
        name,
        spec: { category: "consistencyCheck" },
      });
      expect(r.isError).toBeFalsy();
    }

    // add_validation refuses a same-name repeat now, so DUP's second copy is seeded by string
    // surgery on the stored model rather than a second add_validation call — see duplicateChild.
    const duplicated = duplicateChild(seedStore.get("zbopf_prb1")!, "ROOT", "validation", "DUP");
    expect(countChildren(duplicated, "ROOT", "validation", "DUP")).toBe(2);

    const store = bopfStore({ zbopf_prb1: duplicated });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "remove_validation",
      node: "ROOT",
      name: "MISSING",
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("NOT_FOUND");
    expect(String(payload.message)).toContain("DUP");
    expect(String(payload.message)).toContain("OTHER");

    const details = payload.details as Record<string, unknown>;
    const existing = details.existing as string[];
    expect(existing.filter((n) => n === "DUP")).toHaveLength(2);
    expect(existing.filter((n) => n === "OTHER")).toHaveLength(1);
    expect(existing).toHaveLength(3);
  });

  it('says "none" (in both message and details.existing) when the node has no elements of that kind', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "remove_determination",
      node: "ROOT",
      name: "MISSING",
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("NOT_FOUND");
    expect(String(payload.message)).toContain("none");
    const details = payload.details as Record<string, unknown>;
    expect(details.existing).toEqual([]);
  });
});

// ===========================================================================

describe("remove_determination: node and name are both required", () => {
  it("omitting node refuses BAD_INPUT, with zero network calls after connect", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "remove_determination",
      name: "DET1",
    });

    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(callsAfterConnect(server)).toBe(before);
  });

  it("omitting name refuses BAD_INPUT, with zero network calls after connect", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "remove_determination",
      node: "ROOT",
    });

    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(callsAfterConnect(server)).toBe(before);
  });
});
