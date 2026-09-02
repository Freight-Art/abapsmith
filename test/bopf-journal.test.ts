/**
 * Journalling for `src/tools/bopf.ts`'s three mutations (G3/G3b).
 *
 * `doc/JOURNAL/journal-format.md` used to claim BOPF writes through a generated classrun,
 * like FPM, with no controlled bytes to record. That was wrong:
 * `createBusinessObject`/`putModel`/`deleteBusinessObject` (`src/adt/bopf.ts`)
 * are ordinary ADT REST verbs (POST/PUT/DELETE) under a lock handle, the same
 * shape as `abap_write`'s own mutations — so there IS a real before/after
 * image, and it is now recorded. These tests pin:
 *
 *  - each of the three mutations writes exactly one entry, with the right
 *    `operation`, object identity, `existedBefore`/`beforeCapture`, and
 *    `irreversible: true`;
 *  - `operation: "activate"` (no mutation of the BO's own model) and a
 *    dry-run delete write NOTHING;
 *  - no journal wired still lets the mutation land — `withJournalledMutation`
 *    records nothing rather than refusing (mirrors
 *    `test/enhancement-tools.test.ts`'s "no journal wired ... still writes"
 *    case);
 *  - `journalEntryId` NEVER reaches `CallToolResult.structuredContent` (a
 *    sibling defect: no tool in this server declares an `outputSchema`, and
 *    an MCP client that prefers `structuredContent` over `content` whenever
 *    it is present — Claude Code among them — would show the caller
 *    `{"journalEntryId": "..."}` and NONE of the result text on every
 *    journalling call). `runBopfEdit`/`runBopfDelete` (`src/tools/bopf.ts`)
 *    carry the id on an INTERNAL `BopfCallResult.journalEntryId` field
 *    instead, which their `mcp.registerTool` callbacks strip via
 *    `toMcpResult` before the result reaches this file's `invoke()` (which
 *    calls those same registered callbacks) — so it is what
 *    `src/tools/v2/handlers/do/bopf.ts`'s `journalled()` gates `journalNext()`
 *    on internally (`test/tools-v2-do-bopf.test.ts` covers that gate itself,
 *    upstream of the strip), while the id still reaches the caller of THIS
 *    file's `invoke()` in the rendered text — a `journalEntryId: <id>` header
 *    line `buildEditResponse`/`buildDeleteResultResponse` emit exactly when
 *    (and only when) an entry was actually written;
 *  - the safety mechanism `irreversible: true` documents: `undoBlocker()`'s
 *    generic catch-all (`src/adt/undo.ts`, the same one the `DEVC/K`
 *    package-create refusal uses) refuses a BOPF entry before `planUndo`
 *    ever reaches `resolveWriteTarget` — which also does not recognise a
 *    BOPF entry's `object.type` ("BOBF") but is never asked, since the
 *    catch-all wins first — before any network request.
 *
 * Harness: the same `wired()`/`fakeMcp()`/`fakePool()` idiom as
 * `test/bopf-tools.test.ts` (a real `AbapConnection` against a
 * `FakeAdtServer`, only the socket and `SessionPool` faked), plus a real
 * `Journal` against a temp directory — the same idiom
 * `test/enhancement-tools.test.ts`'s "the write journal" block uses. Kept as
 * its own small copy per this repo's one-copy-per-test-file convention,
 * rather than editing either of those files' shared harnesses.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { FakeAdtServer, __resetFakeAdtCounters, bopfStore, type FakeRoute } from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import type { SessionPool } from "../src/adt/pool.js";
import { createServer, errorResult } from "../src/server.js";
import { Journal, systemKey, type JournalConfig, type JournalEntry } from "../src/journal.js";
import { planUndo } from "../src/adt/undo.js";
import { registerBopfTools, type BopfToolDeps } from "../src/tools/bopf.js";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCtsFixture } from "./helpers/cts-fixtures.js";

// --------------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/** ZBOPF_PRB1, inactive, root-node-only — the just-created shape. */
const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");

// ----------------------------------------------------------------------- harness ---

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

async function wired(options: { routes?: readonly FakeRoute[] } = {}): Promise<{ conn: AbapConnection; server: FakeAdtServer }> {
  const server = new FakeAdtServer({
    transportErrors: "throw",
    routes: [systemRoleRoute, ...(options.routes ?? [])],
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

function depsFor(conn: AbapConnection, opts: { journal?: Journal } = {}): BopfToolDeps {
  return {
    pool: fakePool(conn),
    safety: openGate(),
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 30_000 },
    transport: localTransport(),
    registerWrite: true,
    ...(opts.journal ? { journal: opts.journal } : {}),
  };
}

async function registered(
  conn: AbapConnection,
  opts: { journal?: Journal } = {},
): Promise<{ tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> }> {
  const { mcp, tools } = fakeMcp();
  registerBopfTools(mcp, depsFor(conn, opts));
  return { tools };
}

let dir: string;
const jcfg = (): JournalConfig => ({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 });

const withJournal = async (fn: (j: Journal) => Promise<void>): Promise<void> => {
  dir = await mkdtemp(join(tmpdir(), "abapsmith-bopf-journal-"));
  try {
    await fn(new Journal(jcfg(), "A4H"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/**
 * `journalEntryId` must not ride `structuredContent` onto the wire —
 * `toMcpResult` (`src/tools/bopf.ts`) strips the internal field
 * unconditionally, so `result.structuredContent` is never set by
 * `abap_bopf_edit`/`abap_bopf_delete` regardless of whether an entry was
 * written. The id still reaches the caller, but only in the rendered text:
 * a `journalEntryId: <id>` header line the response builders emit exactly
 * when (and only when) an entry was actually written.
 */
function journalEntryIdInText(result: CallToolResult): string | undefined {
  const first = result.content[0];
  if (!first || first.type !== "text") return undefined;
  return /^journalEntryId: (\S+)$/m.exec(first.text)?.[1];
}

// ===========================================================================

describe("abap_bopf_edit create_bo — the write journal", () => {
  it("records a create entry: existedBefore false, confirmed-absent, irreversible, right identity", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore();
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_NEW1",
        operation: "create_bo",
        package: "$TMP",
        description: "test bo",
      });
      okText(result);

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.operation).toBe("create");
      expect(entry.outcome).toBe("succeeded");
      expect(entry.object.name).toBe("ZBOPF_NEW1");
      expect(entry.object.type).toBe("BOBF");
      expect(entry.object.package).toBe("$TMP");
      expect(entry.existedBefore).toBe(false);
      expect(entry.beforeCapture).toBe("confirmed-absent");
      expect(entry.irreversible).toBe(true);

      // journalEntryId regression: must not leak via structuredContent
      // (an MCP client that prefers it over content would show the caller
      // only `{"journalEntryId": "..."}`, never the result text below) — the
      // id reaches the caller in the rendered text instead.
      expect(result.structuredContent).toBeUndefined();
      expect(journalEntryIdInText(result)).toBe(entry.id);
    });
  });

  it("no journal wired still creates the BO — it just records nothing (mirrors enh.ts's own precedent)", async () => {
    const store = bopfStore();
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_NEW1",
      operation: "create_bo",
      package: "$TMP",
    });
    expect(result.isError).toBeFalsy();
    expect(store.has("zbopf_new1")).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(journalEntryIdInText(result)).toBeUndefined();
  });

  // Raw-bytes proof (the sibling of test/write-system-key.test.ts
  // and test/v2-enh-write-systemkey.test.ts): read `index.jsonl` directly
  // rather than through `journal.list()`, so a site that set `systemKey: ""`
  // — silently dropped by src/journal.ts's `...(input.systemKey ? {...} : {})`
  // truthy check — cannot hide behind a higher-level accessor. Covers the
  // create_bo call site directly; the update/putModel and delete call sites in
  // src/tools/bopf.ts use the identical `systemKey: systemKey(conn.cfg)`
  // expression (test/journal-systemkey.test.ts's static check confirms all
  // three do) — not independently re-tested here, matching
  // test/write-system-key.test.ts's own precedent for its sibling sites.
  it("the raw index.jsonl begin-line — not journal.list()'s parsed view — carries systemKey(conn.cfg) verbatim", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore();
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_NEW2",
        operation: "create_bo",
        package: "$TMP",
        description: "test bo",
      });
      okText(result);

      // Sanity via the real Journal API first, so a wrong-count failure here
      // is reported as that, not as a raw-bytes parsing bug.
      const viaList = await journal.list();
      expect(viaList).toHaveLength(1);

      // The journal is an append-only log: `begin()` appends the first line
      // (the full object, including `systemKey`), and `settle()` appends a
      // SECOND line with the same `id` carrying only outcome/after fields —
      // `Journal.list()` merges lines sharing an `id` into one logical entry.
      // Read the begin line specifically (the one with an `operation` field).
      const raw = readFileSync(join(dir, "index.jsonl"), "utf8");
      const lines = raw.trim().split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(2);
      const parsedLines = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const beginLines = parsedLines.filter((l) => l.operation !== undefined);
      expect(beginLines).toHaveLength(1);
      const persisted = beginLines[0] as { systemKey?: string; object: { name: string } };

      expect(persisted.object.name).toBe("ZBOPF_NEW2");
      expect(persisted.systemKey).toBeDefined();
      expect(persisted.systemKey).not.toBe("");
      expect(persisted.systemKey).toBe(systemKey(conn.cfg));
    });
  });
});

describe("abap_bopf_edit (general edit) — the write journal", () => {
  it("records an update entry: existedBefore true, captured, before-image is the pre-write XML, irreversible", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "add_node",
        name: "ITEM",
        spec: { parent: "ROOT", rootNode: false, createEnabled: true },
      });
      okText(result);

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.operation).toBe("update");
      expect(entry.outcome).toBe("succeeded");
      expect(entry.object.name).toBe("ZBOPF_PRB1");
      expect(entry.object.type).toBe("BOBF");
      expect(entry.existedBefore).toBe(true);
      expect(entry.beforeCapture).toBe("captured");
      expect(entry.irreversible).toBe(true);
      // The before-image is the byte-exact document that stood before this
      // write — the same document `add_node`'s own byte-exact-shape test
      // (test/bopf-tools.test.ts) proves the PUT body was spliced from.
      expect(await journal.beforeImage(entry)).toBe(FX_JUST_CREATED);

      // journalEntryId regression — see the "create_bo" block's identical assertion above.
      expect(result.structuredContent).toBeUndefined();
      expect(journalEntryIdInText(result)).toBe(entry.id);
    });
  });

  it('operation: "activate" writes NOTHING — it does not mutate the BO\'s own model', async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
      const { conn } = await wired({
        routes: [
          store.route,
          (r) => (r.path.includes("/activation") ? { status: 200, body: "", headers: { "content-type": "text/plain" } } : undefined),
        ],
      });
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_bopf_edit", { bo: "ZBOPF_PRB1", operation: "activate" });
      okText(result);

      expect(await journal.list()).toHaveLength(0);
      expect(result.structuredContent).toBeUndefined();
      expect(journalEntryIdInText(result)).toBeUndefined();
    });
  });

  it("does not double-fire onBeforeImage across a putModel retry (withJournalledMutation's at-most-once contract)", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
      // One invalid-lock-handle PUT failure forces withRelockRetry to
      // rebuild (re-run `mutate`) once before the retried PUT succeeds —
      // exactly the hazard the local `fired` flag in runBopfEdit guards
      // against (src/tools/bopf.ts).
      store.failNextPuts(1);
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "add_node",
        name: "ITEM",
        spec: { parent: "ROOT", rootNode: false, createEnabled: true },
      });
      okText(result);

      // Exactly one entry, not two — the retry did not re-fire begin().
      expect(await journal.list()).toHaveLength(1);
    });
  });
});

describe("abap_bopf_delete — the write journal", () => {
  it("records a delete entry: existedBefore true, captured, before-image is the model just read, irreversible", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_bopf_delete", {
        bo: "ZBOPF_PRB1",
        dry_run: false,
        confirm: "ZBOPF_PRB1",
      });
      okText(result);
      expect(store.has("zbopf_prb1")).toBe(false);

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.operation).toBe("delete");
      expect(entry.outcome).toBe("succeeded");
      expect(entry.object.name).toBe("ZBOPF_PRB1");
      expect(entry.object.type).toBe("BOBF");
      expect(entry.existedBefore).toBe(true);
      expect(entry.beforeCapture).toBe("captured");
      expect(entry.irreversible).toBe(true);
      expect(await journal.beforeImage(entry)).toBe(FX_JUST_CREATED);

      // journalEntryId regression — see the "create_bo" block's identical assertion above.
      expect(result.structuredContent).toBeUndefined();
      expect(journalEntryIdInText(result)).toBe(entry.id);
    });
  });

  it("a dry run writes NOTHING", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_bopf_delete", { bo: "ZBOPF_PRB1" });
      okText(result);

      expect(await journal.list()).toHaveLength(0);
      expect(result.structuredContent).toBeUndefined();
      expect(journalEntryIdInText(result)).toBeUndefined();
      expect(store.has("zbopf_prb1")).toBe(true);
    });
  });

  it("records `failed` when the DELETE is refused — the entry outlives the failure", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
      const failingDelete: FakeRoute = (r) =>
        r.method === "DELETE" && r.path.includes("zbopf_prb1")
          ? { status: 500, body: `<exc:exception><type id="ExceptionSystemError"/></exc:exception>`, headers: { "content-type": "application/xml" } }
          : undefined;
      const { conn } = await wired({ routes: [failingDelete, store.route] });
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_bopf_delete", {
        bo: "ZBOPF_PRB1",
        dry_run: false,
        confirm: "ZBOPF_PRB1",
      });
      expect(result.isError).toBe(true);

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.outcome).toBe("failed");
      expect(await journal.beforeImage(entries[0]!)).toBe(FX_JUST_CREATED);
    });
  });
});

// ===========================================================================
// The structural undo-refusal mechanism `irreversible: true` documents.
//
// This used to be BOPF's own bespoke story: `object.type` "BOBF" is not a
// type `resolveWriteTarget` (src/adt/write.ts) recognises, so `planUndo`
// threw `BAD_INPUT` synchronously when it got there. A later fix
// generalised `undoBlocker()`'s catch-all to refuse ANY `irreversible: true`
// entry with no bespoke branch of its own — the same mechanism the `DEVC/K`
// package-create refusal uses (test/undo.test.ts's "undo of a DEVC/K package
// create is refused outright") — and that catch-all now intercepts a
// BOPF entry BEFORE `planUndo` ever reaches `resolveWriteTarget`. The old
// resolveWriteTarget-throws mechanism is not wrong, exactly — it is simply
// unreachable for BOPF now, dead code from this call site's point of view,
// because every BOPF entry always sets `irreversible: true` and the generic
// check wins first. This is the regression test for the design
// `irreversible: true` relies on today: prove the refusal is real (an
// `undoable: false` plan, zero network requests), not merely asserted by the
// flag.
// ===========================================================================

describe("undo of a BOPF entry", () => {
  it("planUndo refuses locally, before any network request — the generic `irreversible: true` catch-all in undoBlocker(), not resolveWriteTarget", async () => {
    await withJournal(async (journal) => {
      // No routes at all beyond the login/system-role probe: any BOPF-specific
      // request landing on the wire would be unrouted and throw a DIFFERENT
      // error than the one under test, so an unexpected network call fails
      // this test loudly rather than passing by accident.
      const { conn, server } = await wired();
      const before = server.calls.length;

      const entry = await journal.begin({
        operation: "create",
        object: { name: "ZBOPF_NEW1", type: "BOBF", uri: "/sap/bc/adt/bopf/businessobjects/zbopf_new1", package: "$TMP" },
        existedBefore: false,
        beforeCapture: "confirmed-absent",
        irreversible: true,
        tool: "abap_bopf_edit",
      });
      expect(entry).toBeDefined();
      await journal.finish(entry!.id, { outcome: "succeeded" });
      const written = (await journal.get(entry!.id)) as JournalEntry;

      const plan = await planUndo(conn, journal, written);
      expect(plan.undoable).toBe(false);
      expect(plan.blocker).toBe(
        "This entry is marked irreversible — recorded for history only. No mechanism " +
          "can undo it, not even with force=true.",
      );
      // Not the DEVC/K-specific suffix — that branch only fires for `object.type === "DEVC/K"`.
      expect(plan.blocker).not.toMatch(/BOBF/);
      expect(plan.blockerForceable).toBeFalsy();
      expect(server.calls.length).toBe(before);
    });
  });
});

// ===========================================================================
// The composition root actually wires it — the other half of the BOPF journalling gap.
//
// Every test above builds `BopfToolDeps` directly (`depsFor`/`registered`),
// which proves the TOOL LAYER journals correctly but not that `src/server.ts`
// hands it a real `Journal` when the process actually starts. That gap is
// exactly how the BOPF journalling gap shipped in the first place: `BopfRunDeps.journal`
// was optional, `tsc` was silent, the tests here were green because they
// construct their own deps, and `registerBopfTools(mcp, { … })` in
// `src/server.ts` simply omitted the field — so `abap_bopf_edit` mutated the
// system in production and recorded nothing, while every test in this file
// kept passing. `journal` is required on `BopfRunDeps` now, which turns a
// repeat of that specific omission into a compile error (and
// `test/journal-contract.test.ts`'s "composition root wiring" block pins it
// statically), but neither of those proves entries actually reach disk
// through the real wiring — only running the real composition root does.
//
// Same idiom as `test/session-transport-journal.test.ts`'s "1c" block
// (`createServer wires the journal into the transport tools`): a real
// `createServer()`, a real MCP `Client` talking to it over an in-memory
// transport pair, a `FakeAdtServer` standing in for the appliance (the same
// harness `wired()` above uses, just handed to `createServer()`'s
// `httpClient` option instead of directly to `AbapConnection`), and the
// journal re-read from a FRESH `Journal` instance over the same directory
// afterwards — proving the entry reached disk via the actual composition
// root, not merely via an in-memory object this test happens to hold a
// reference to.
// ===========================================================================

describe("createServer wires the journal into the BOPF tools", () => {
  const writeCfg = (): Config =>
    ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "TESTUSER",
      password: "secret",
      sid: "TST",
      client: "001",
      // The create has to get PAST the gate to reach the journal at all —
      // same reasoning as writeCfg() in session-transport-journal.test.ts.
      readOnly: false,
      allowPackages: ["$TMP"],
    });

  /**
   * `createServer()` wires a REAL `SessionTransport` (`src/server.ts`, no
   * `cts` override), unlike `depsFor()`'s `localTransport()` above, which
   * fakes `trRequirement` in-process and never touches the wire. A real
   * `SessionTransport.resolve()` — which `createBusinessObject`
   * (`src/adt/bopf.ts`) calls before every create, local package or not, to
   * refuse transportable packages — issues one real
   * `POST /sap/bc/adt/cts/transportchecks` first. This route answers it with
   * `transport-info-tmp`, a live A4H capture of exactly that call for a
   * `$TMP` create (`test/fixtures/cts/transport-info-tmp.meta.json`), so the
   * package-locality check this test's `$TMP` target must pass sees a real
   * "local, no transport needed" answer instead of an unrouted 500.
   */
  const transportChecksRoute: FakeRoute = (r) => {
    if (r.method !== "POST" || !r.path.includes("/cts/transportchecks")) return undefined;
    const { meta, body } = loadCtsFixture("transport-info-tmp");
    return { status: meta.status, statusText: meta.statusText, body, headers: meta.responseHeaders };
  };

  it("records a create entry through the real abap_bopf_edit tool, end to end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abapsmith-bopf-journal-e2e-"));
    try {
      const journal = new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "TST");
      const store = bopfStore();
      const server = new FakeAdtServer({
        transportErrors: "throw",
        routes: [systemRoleRoute, transportChecksRoute, store.route],
      });
      const http = server.client("s1");

      const srv = createServer(writeCfg(), {
        journal,
        httpClient: http as never,
        log: () => {},
        breaker: new AuthCircuitBreaker(),
      });
      try {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "test", version: "0.0.0" });
        await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);

        const res = (await client.callTool({
          name: "abap_bopf_edit",
          arguments: {
            bo: "ZBOPF_E2E1",
            operation: "create_bo",
            package: "$TMP",
            description: "abapsmith journal wiring (composition root)",
          },
        })) as unknown as { isError?: boolean; content: Array<{ type: string; text: string }> };

        // The mutation must really have happened, or "nothing was journalled"
        // is the trivially correct answer and this test proves nothing.
        expect(
          res.isError ?? false,
          `abap_bopf_edit create_bo failed, so this test cannot say anything about ` +
            `journalling: ${res.content[0]?.text ?? "(no content)"}`,
        ).toBe(false);
        expect(store.has("zbopf_e2e1")).toBe(true);

        // Read through a FRESH Journal over the same directory: what a human
        // (or `abap_journal`) sees, not in-memory state this test happens to
        // still hold a reference to.
        const entries = await new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "TST").list();
        expect(
          entries.map((e) => e.operation),
          `abap_bopf_edit CREATED ZBOPF_E2E1 on the system through the real server and ` +
            `NOTHING was journalled: createServer() registered the BOPF tools with a journal ` +
            `that entries do not reach. \`journal\` is required on BopfRunDeps, so the field ` +
            `cannot simply have been dropped at the registerBopfTools() call site in ` +
            `src/server.ts — look instead at WHICH journal was passed (directory, SID, ` +
            `\`enabled\`) and at whether the tools are settling entries into it.`,
        ).toEqual(["create"]);
        const entry = entries[0]!;
        expect(entry.object.name).toBe("ZBOPF_E2E1");
        expect(entry.object.type).toBe("BOBF");
        expect(entry.object.package).toBe("$TMP");
        expect(entry.outcome).toBe("succeeded");
        expect(entry.irreversible).toBe(true);
      } finally {
        srv.connection.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
