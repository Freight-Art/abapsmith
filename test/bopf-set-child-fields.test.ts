/**
 * Regression tests for `abap_bopf_edit`'s six `set_*_fields` operations
 * (`set_association_fields`, `set_action_fields`, `set_determination_fields`,
 * `set_validation_fields`, `set_query_fields`, `set_alternative_key_fields`):
 * each patches a subset of one existing child element's fields in place, via
 * `patchOpenTagAttrs` (attribute fields, batched) and `spliceSetElementRef`
 * (ref fields, one splice per field) — see `patchChildFields` in
 * `src/tools/bopf.ts`. Distinct from remove_*+add_* because that pair mints
 * a fresh nodeId and loses anything BOPF only assigns once, at creation.
 *
 * Also covers `refuseDuplicateChild`: `add_action`/`add_determination`/
 * `add_validation`/`add_query`/`add_alternative_key`/`add_association` now
 * refuse outright, before any PUT, when an element of that kind/name already
 * exists on the node.
 *
 * Harness: identical to `test/bopf-set-node-flags-verify.test.ts` — a real
 * `AbapConnection` against a `FakeAdtServer`, a real `SafetyGate`, real
 * `errorResult`. Only the HTTP socket and `SessionPool` are fake.
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
  classSourceRoute,
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
import { scanModel, locateToken } from "../src/adt/bopf-xml.js";

// --------------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/** ZBOPF_PRB1, inactive, one node (ROOT): two queries (SELECT_ALL, SELECT_BY_ELEMENTS), one action (LOCK_ROOT), no associations/determinations/validations/alternative keys. */
const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");

/** ZBOPF_MC5, active. ROOT has action LOCK_ROOT (container, two child refs, no xmlName), action Z_ACTION (one child ref only), determination Z_DET (implementationClassRef + triggers), validation Z_VAL, query SELECT_ALL (self-closing). */
const FX_ACTIVE_MC5 = fixture("10-model-coverage-final.v4.xml");

// ----------------------------------------------------------------------- harness ---
// Copied verbatim from test/bopf-set-node-flags-verify.test.ts's harness section.

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

function okText(result: CallToolResult): string {
  expect(result.isError).toBeFalsy();
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return text.text;
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

/** Same idiom as test/bopf-journal.test.ts's `withJournal` — a real Journal against a temp dir, for the one test that needs a genuine journalEntryId. */
async function withTempJournal<T>(fn: (journal: Journal) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "abapsmith-bopf-set-child-fields-"));
  try {
    return await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ===========================================================================
// Byte-preservation: patching an attribute or a ref field touches only that
// field's own bytes — everything else in the document, including sibling
// child elements, is byte-identical to the pre-patch model. Proved the same
// way test/bopf-xml.test.ts proves it for patchOpenTagAttrs/spliceSetElementRef
// directly: locate the target element's Token in the ORIGINAL bytes, then
// anchor on the untouched prefix and the untouched suffix.

describe("set_*_fields: attribute patches touch only the open tag, nothing else", () => {
  it("replacing one attribute on LOCK_ROOT leaves its other attributes and both child refs byte-identical", async () => {
    const seed = FX_ACTIVE_MC5;
    const tokens = scanModel(seed);
    const token = locateToken(tokens, { node: "ROOT", child: "action", name: "LOCK_ROOT" });
    expect(token).toBeDefined();
    if (!token) return;

    const store = bopfStore({ zbopf_mc5: seed });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_MC5",
      operation: "set_action_fields",
      node: "ROOT",
      name: "LOCK_ROOT",
      spec: { instanceMultiplicity: "1" },
    });
    okText(result);

    const putBody = store.get("zbopf_mc5")!;
    expect(putBody.slice(0, token.openStart)).toBe(seed.slice(0, token.openStart));
    const suffix = seed.slice(token.openEnd);
    expect(putBody.endsWith(suffix)).toBe(true); // both child refs + everything after LOCK_ROOT survive byte-for-byte
    const newOpenTag = putBody.slice(token.openStart, putBody.length - suffix.length);
    expect(newOpenTag).toContain('bo:instanceMultiplicity="1"');
    expect(newOpenTag).not.toContain('bo:instanceMultiplicity="2"');
    expect(newOpenTag).toContain('bo:category="3"');
    expect(newOpenTag).toContain('bo:exportingParameterCategoryType="None"');
    expect(newOpenTag).toContain('bo:isExtensible="false"');
  });

  it("adding an attribute LOCK_ROOT never had is appended without disturbing existing attributes or children", async () => {
    const seed = FX_ACTIVE_MC5;
    const tokens = scanModel(seed);
    const token = locateToken(tokens, { node: "ROOT", child: "action", name: "LOCK_ROOT" });
    expect(token).toBeDefined();
    if (!token) return;
    expect(token.attrs.has("bo:xmlName")).toBe(false);

    const store = bopfStore({ zbopf_mc5: seed });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_MC5",
      operation: "set_action_fields",
      node: "ROOT",
      name: "LOCK_ROOT",
      spec: { xmlName: "Lock Root Op" },
    });
    okText(result);

    const putBody = store.get("zbopf_mc5")!;
    const suffix = seed.slice(token.openEnd);
    expect(putBody.endsWith(suffix)).toBe(true);
    const newOpenTag = putBody.slice(token.openStart, putBody.length - suffix.length);
    expect(newOpenTag).toContain('bo:xmlName="Lock Root Op"');
    expect(newOpenTag).toContain('bo:category="3"');
    expect(newOpenTag).toContain('bo:instanceMultiplicity="2"');
  });

  it("null clears an attribute while every other attribute on the element survives", async () => {
    const seed = FX_ACTIVE_MC5;
    const tokens = scanModel(seed);
    const token = locateToken(tokens, { node: "ROOT", child: "action", name: "LOCK_ROOT" });
    expect(token).toBeDefined();
    if (!token) return;
    expect(token.attrs.get("bo:isExtensible")).toBe("false");

    const store = bopfStore({ zbopf_mc5: seed });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_MC5",
      operation: "set_action_fields",
      node: "ROOT",
      name: "LOCK_ROOT",
      spec: { isExtensible: null },
    });
    okText(result);

    const putBody = store.get("zbopf_mc5")!;
    const suffix = seed.slice(token.openEnd);
    expect(putBody.endsWith(suffix)).toBe(true);
    const newOpenTag = putBody.slice(token.openStart, putBody.length - suffix.length);
    expect(newOpenTag).not.toContain("bo:isExtensible");
    expect(newOpenTag).toContain('bo:category="3"');
    expect(newOpenTag).toContain('bo:exportParameterLink="false"');
  });
});

describe("set_*_fields: ref patches touch only the target element, nothing before or after it", () => {
  it("adding a ref to a self-closing query promotes it to a container", async () => {
    const seed = FX_ACTIVE_MC5;
    const tokens = scanModel(seed);
    const token = locateToken(tokens, { node: "ROOT", child: "query", name: "SELECT_ALL" });
    expect(token).toBeDefined();
    if (!token) return;
    expect(token.kind).toBe("empty");

    const store = bopfStore({ zbopf_mc5: seed });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_MC5",
      operation: "set_query_fields",
      node: "ROOT",
      name: "SELECT_ALL",
      spec: { dataTypeRef: { name: "ZBOPF_S_ROOT6", type: "TABL/DS" } },
    });
    okText(result);

    const putBody = store.get("zbopf_mc5")!;
    expect(putBody.slice(0, token.openStart)).toBe(seed.slice(0, token.openStart));
    const after = seed.slice(token.closeEnd);
    expect(putBody.endsWith(after)).toBe(true); // every sibling after SELECT_ALL untouched
    const newElement = putBody.slice(token.openStart, putBody.length - after.length);
    expect(newElement).toBe(
      '<bo:queries bo:name="SELECT_ALL" bo:nodeID="1A2263E0A4E31FE1A48148ABB963F650" bo:objectModelGenerated="false" ' +
        'bo:xmlName="SELECT_ALL Query" bo:category="selectAll"><bo:dataTypeRef adtcore:type="TABL/DS" adtcore:name="ZBOPF_S_ROOT6"/></bo:queries>',
    );
  });

  it("null clears an existing ref, leaving the element's own attributes untouched", async () => {
    const seed = FX_ACTIVE_MC5;
    const tokens = scanModel(seed);
    const token = locateToken(tokens, { node: "ROOT", child: "action", name: "Z_ACTION" });
    expect(token).toBeDefined();
    if (!token) return;
    expect(seed.slice(token.openStart, token.closeEnd)).toContain("ZCL_BOPF_NOPE_ACT");

    const store = bopfStore({ zbopf_mc5: seed });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_MC5",
      operation: "set_action_fields",
      node: "ROOT",
      name: "Z_ACTION",
      spec: { implementationClassRef: null },
    });
    okText(result);

    const putBody = store.get("zbopf_mc5")!;
    expect(putBody.slice(0, token.openStart)).toBe(seed.slice(0, token.openStart));
    const after = seed.slice(token.closeEnd);
    expect(putBody.endsWith(after)).toBe(true);
    const newElement = putBody.slice(token.openStart, putBody.length - after.length);
    expect(newElement).not.toContain("implementationClassRef");
    expect(newElement).toContain('bo:xmlName="A"');
    expect(newElement).toContain('bo:category="0"');
  });
});

// ===========================================================================

describe("set_*_fields: spec.class shorthand goes through the same dangling-ref preflight as add_*", () => {
  it("renders the same CLAS/OC ref add_* would once allow_dangling_ref clears the preflight, and is refused BOPF_DANGLING_REF without it", async () => {
    const seed = FX_ACTIVE_MC5;
    const store = bopfStore({ zbopf_mc5: seed });
    const { conn, server } = await wired({
      routes: [
        classSourceRoute({ name: "ZCL_MISSING", body: undefined }),
        classSourceRoute({ name: "ZCL_NEW_DET", body: undefined }),
        store.route,
      ],
    });
    const { tools } = await registered(conn);

    const refused = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_MC5",
      operation: "set_determination_fields",
      node: "ROOT",
      name: "Z_DET",
      spec: { class: "ZCL_MISSING" },
    });
    expect(errorPayload(refused).error).toBe("BOPF_DANGLING_REF");
    expect(server.calls.filter((r) => r.method === "PUT")).toHaveLength(0);
    expect(store.get("zbopf_mc5")).toBe(seed);

    const ok = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_MC5",
      operation: "set_determination_fields",
      node: "ROOT",
      name: "Z_DET",
      spec: { class: "ZCL_NEW_DET" },
      allow_dangling_ref: true,
    });
    okText(ok);

    const putBody = store.get("zbopf_mc5")!;
    expect(putBody).toContain('<bo:implementationClassRef adtcore:type="CLAS/OC" adtcore:name="ZCL_NEW_DET"/>');
    expect(putBody).not.toContain("ZCL_BOPF_NOPE_DET");
    expect(putBody).toContain('bo:determine="false"'); // Z_DET's trigger element survives the class-ref swap
  });
});

// ===========================================================================

describe("set_*_fields: a write the server actually keeps succeeds, with the change on the wire", () => {
  it("a patch the server keeps is reported as success and is present on the re-read", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_query_fields",
      node: "ROOT",
      name: "SELECT_ALL",
      spec: { xmlName: "Updated Query Name" },
    });

    okText(result);
    expect(store.get("zbopf_prb1")).toContain('bo:xmlName="Updated Query Name"');
  });
});

describe("set_*_fields: a PUT the server discards is reported as CHECK_FAILED, not success", () => {
  it("a dropped field patch is reported per-field, with the journal's own entry id, no activation, and the model unchanged", async () => {
    // Seed a real determination via a real add first — a separate
    // connection/server — only the resulting XML is carried over as the
    // seed for the discarding one below.
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
    expect(seededXml).not.toContain('bo:xmlName="CHANGED"');

    await withTempJournal(async (journal) => {
      const discardPutRoute: FakeRoute = (r) =>
        r.method === "PUT" && r.path === `${BOPF_COLLECTION_PATH}/zbopf_prb1` ? EMPTY_200() : undefined;
      const store = bopfStore({ zbopf_prb1: seededXml });
      const { conn, server } = await wired({ routes: [discardPutRoute, store.route, activationRoute({})] });
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "set_determination_fields",
        node: "ROOT",
        name: "DET1",
        spec: { xmlName: "CHANGED" },
        activate: true,
      });

      const payload = errorPayload(result);
      expect(payload.error).toBe("CHECK_FAILED");
      expect(String(payload.message)).toContain("did not keep 1 of the field(s) sent");
      expect(String(payload.message)).toContain("xmlName: sent CHANGED, read back absent");

      const details = payload.details as Record<string, unknown>;
      expect(details.mismatches).toEqual([{ field: "xmlName", sent: "CHANGED", readBack: null }]);
      expect(details.bo).toBe("ZBOPF_PRB1");
      expect(details.node).toBe("ROOT");
      expect(details.name).toBe("DET1");

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(details.journalEntryId).toBe(entries[0]!.id);

      const activationCalls = server.calls.filter((r) => r.method === "POST" && r.path.includes("/sap/bc/adt/activation"));
      expect(activationCalls).toHaveLength(0);

      expect(store.get("zbopf_prb1")).toBe(seededXml); // discarded, as BOPF actually did
    });
  });
});

// ===========================================================================

describe("set_*_fields: NOT_FOUND names what's missing and lists what's actually there", () => {
  it("an unknown name lists the sibling that IS present; a kind with no members at all says 'none'", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const missingSibling = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_action_fields",
      node: "ROOT",
      name: "NOPE_ACTION",
      spec: { category: "3" },
    });
    const p1 = errorPayload(missingSibling);
    expect(p1.error).toBe("NOT_FOUND");
    expect(String(p1.message)).toContain('no action of that name exists');
    expect(String(p1.message)).toContain("LOCK_ROOT");
    expect((p1.details as Record<string, unknown>).existing).toEqual(["LOCK_ROOT"]);

    const missingKind = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_determination_fields",
      node: "ROOT",
      name: "NOPE_DET",
      spec: { category: "reactDuringSave" },
    });
    const p2 = errorPayload(missingKind);
    expect(p2.error).toBe("NOT_FOUND");
    expect(String(p2.message)).toContain("Determinations present on that node: none");
    expect((p2.details as Record<string, unknown>).existing).toEqual([]);
  });
});

// ===========================================================================

describe("set_*_fields: an empty or all-irrelevant spec is refused before any PUT", () => {
  it("an empty spec is refused BAD_INPUT naming the patchable fields", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_action_fields",
      node: "ROOT",
      name: "LOCK_ROOT",
      spec: {},
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("names no field to change");
    const details = payload.details as Record<string, unknown>;
    expect(details.patchable).toEqual([
      "xmlName",
      "category",
      "instanceMultiplicity",
      "exportingParameterCategoryType",
      "exportParameterLink",
      "isExtensible",
      "objectModelGenerated",
      "parameterStructureRef",
      "implementationClassRef",
    ]);
    expect(server.calls.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  it("a spec naming only a refused field (name) is rejected before it ever reaches the patchable-fields check", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_action_fields",
      node: "ROOT",
      name: "LOCK_ROOT",
      spec: { name: "RENAMED_ACTION" },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("spec.name on set_action_fields is not supported");
    expect(String(payload.message)).not.toContain("names no field to change"); // a different check than the empty-spec one
    expect(server.calls.filter((r) => r.method === "PUT")).toHaveLength(0);
  });
});

// ===========================================================================

describe("set_alternative_key_fields: requires i_know_this_may_not_activate before touching anything", () => {
  it("is refused BAD_INPUT before any HTTP request is made", async () => {
    const { server, conn } = await wired();
    const { tools } = await registered(conn);
    const before = server.calls.length; // connect() itself made some login/probe traffic

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_alternative_key_fields",
      node: "ROOT",
      name: "MY_ALTKEY",
      spec: { uniqueness: "unique" },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("requires i_know_this_may_not_activate: true");
    expect(server.calls.slice(before)).toHaveLength(0);
  });
});

// ===========================================================================

describe("add_*: refuses re-adding under an existing name before any PUT", () => {
  it("add_action refuses a second call under the same name, case-insensitively, without a second PUT", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const first = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_action",
      node: "ROOT",
      name: "MY_ACTION",
      spec: {},
    });
    expect(first.isError).toBeFalsy();
    const afterFirstAdd = store.get("zbopf_prb1")!;
    expect(afterFirstAdd).toContain('bo:name="MY_ACTION"');

    const refused = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_action",
      node: "ROOT",
      name: "my_action", // different case — must still be caught
      spec: {},
    });
    const payload = errorPayload(refused);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("a action of that name already exists there");
    expect(String(payload.message)).toContain("set_action_fields");
    expect(String(payload.message)).toContain("remove_action");
    const details = payload.details as Record<string, unknown>;
    expect(details.existing).toEqual(["LOCK_ROOT", "MY_ACTION"]); // LOCK_ROOT pre-existed; MY_ACTION is the just-added one

    expect(store.get("zbopf_prb1")).toBe(afterFirstAdd); // refused before any second PUT — model untouched
  });

  it("add_validation refuses a second call under the same name without a second PUT", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const first = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_validation",
      node: "ROOT",
      name: "MY_VAL",
      spec: { category: "consistencyCheck" },
    });
    expect(first.isError).toBeFalsy();
    const afterFirstAdd = store.get("zbopf_prb1")!;

    const refused = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_validation",
      node: "ROOT",
      name: "MY_VAL",
      spec: { category: "consistencyCheck" },
    });
    const payload = errorPayload(refused);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("a validation of that name already exists there");
    expect(String(payload.message)).toContain("remove_validation first");
    const details = payload.details as Record<string, unknown>;
    expect(details.existing).toEqual(["MY_VAL"]);

    expect(store.get("zbopf_prb1")).toBe(afterFirstAdd);
  });
});
