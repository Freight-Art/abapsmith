/**
 * `Journal.resolveActor()` / `begin()` / the `sessionId` getter, under an
 * ambient `McpSessionContext` (src/mcp-session.ts) — issue #81's remote
 * (Streamable HTTP) MCP transport.
 *
 * `Journal.setClientActor()`/`setClientSession()` are PROCESS-WIDE mutable
 * state: correct for stdio, where one process serves exactly one
 * conversation, but wrong the moment one process serves several concurrent
 * MCP sessions (the whole point of the HTTP transport) — session B's
 * `initialize` would silently overwrite session A's identity, and every
 * journal entry written for EITHER session after that point would be
 * misattributed to whichever session initialized most recently. That is the
 * defect `runInMcpSession` (an `AsyncLocalStorage`-backed ambient context)
 * exists to close: `src/mcp-http.ts` is expected to run every request that
 * belongs to one HTTP session inside `runInMcpSession(ctx, ...)`, and
 * `Journal.resolveActor()` / `begin()` / the `sessionId` getter now consult
 * that ambient context before falling back to the process-wide fields.
 *
 * These tests exercise `Journal` directly (no MCP server, no HTTP, no
 * FakeAdtServer) against a real `mkdtempSync` temp dir — same construction
 * shape as test/journal-actor.test.ts, whose read-back idiom (`begin()`
 * returns the written entry; `journal.list()` re-reads from disk) this file
 * reuses rather than inventing a new one. The one test that actually proves
 * isolation (not just "the ambient value is read") runs two sessions
 * CONCURRENTLY and checks neither's entry leaks the other's identity — a
 * process-wide field would pass every other test here and still fail that
 * one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runInMcpSession } from "../src/mcp-session.js";
import {
  Journal,
  type JournalBeginInput,
  type JournalConfig,
  type JournalEntry,
  type JournalObjectRef,
} from "../src/journal.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-mcp-session-actor-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const cfg = (over: Partial<JournalConfig> = {}): JournalConfig => ({
  dir: tmp,
  enabled: true,
  maxEntries: 200,
  maxAgeDays: 30,
  ...over,
});

const objectRef = (name = "ZMCP_SESSION_DEMO"): JournalObjectRef => ({
  name,
  type: "PROG/P",
  uri: `/sap/bc/adt/programs/programs/${name.toLowerCase()}`,
  sourceUri: `/sap/bc/adt/programs/programs/${name.toLowerCase()}/source/main`,
  package: "$TMP",
  description: "journal mcp-session actor test",
});

const beginInput = (over: Partial<JournalBeginInput> = {}): JournalBeginInput => ({
  operation: "update",
  object: objectRef(),
  existedBefore: true,
  beforeSource: "REPORT zmcp_demo.\nWRITE: / 'old'.\n",
  afterSource: "REPORT zmcp_demo.\nWRITE: / 'new'.\n",
  tool: "abap_write",
  ...over,
});

const begun = async (j: Journal, over: Partial<JournalBeginInput> = {}): Promise<JournalEntry> => {
  const entry = await j.begin(beginInput(over));
  if (!entry) throw new Error("begin() returned undefined, but this journal is enabled");
  return entry;
};

// ---------------------------------------------------------------------------
// 1. Basic ambient attribution
// ---------------------------------------------------------------------------

describe("begin() inside an ambient MCP session", () => {
  it("attributes actor to the authenticated caller, and sessionId/sessionIdSource to the ambient transport session", async () => {
    const j = new Journal(cfg(), "A4H");
    const entry = await runInMcpSession(
      { sessionId: "sess-a", caller: "alice" },
      () => begun(j, { object: objectRef("ZMCP_ONE") }),
    );
    expect(entry.actor).toBe("alice");
    expect(entry.sessionId).toBe("sess-a");
    expect(entry.sessionIdSource).toBe("transport");
  });

  it("mcpSessionActor prefers caller but falls back to client — with only client set, actor is the client name", async () => {
    const j = new Journal(cfg(), "A4H");
    const entry = await runInMcpSession(
      { sessionId: "sess-b", client: "claude-desktop" },
      () => begun(j, { object: objectRef("ZMCP_TWO") }),
    );
    expect(entry.actor).toBe("claude-desktop");
  });

  it("with neither caller nor client set, actor is ABSENT from the entry — not an empty string, not a placeholder", async () => {
    const j = new Journal(cfg(), "A4H");
    const entry = await runInMcpSession({ sessionId: "sess-c" }, () => begun(j, { object: objectRef("ZMCP_THREE") }));
    expect(entry.actor).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(entry, "actor")).toBe(false);
  });

  it("ABAP_ACTOR (JournalConfig.actor) still wins over an ambient caller — an operator override stays on top", async () => {
    const j = new Journal(cfg({ actor: "operator-override" }), "A4H");
    const entry = await runInMcpSession(
      { sessionId: "sess-d", caller: "alice" },
      () => begun(j, { object: objectRef("ZMCP_FOUR") }),
    );
    expect(entry.actor).toBe("operator-override");
  });
});

// ---------------------------------------------------------------------------
// 2. Outside any ambient session: the process-wide stdio path is unchanged
// ---------------------------------------------------------------------------

describe("begin() outside any ambient MCP session", () => {
  it("uses the process-wide setClientActor()/setClientSession() values, with sessionIdSource:'process' — the stdio path is unchanged", async () => {
    const j = new Journal(cfg(), "A4H");
    j.setClientActor("claude-code");
    j.setClientSession("proc-1", "process");

    const entry = await begun(j, { object: objectRef("ZMCP_STDIO") });
    expect(entry.actor).toBe("claude-code");
    expect(entry.sessionId).toBe("proc-1");
    expect(entry.sessionIdSource).toBe("process");
  });
});

// ---------------------------------------------------------------------------
// 3. Isolation: two concurrent sessions must not cross-contaminate
// ---------------------------------------------------------------------------

describe("concurrent MCP sessions do not leak each other's identity into the journal", () => {
  it("two runInMcpSession scopes running concurrently each attribute their own actor and sessionId to their own entry — not last-writer-wins", async () => {
    const j = new Journal(cfg(), "A4H");
    const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

    const runOne = (sessionId: string, caller: string, objectName: string) =>
      runInMcpSession({ sessionId, caller }, async () => {
        // Yield BEFORE writing, so the two scopes' begin() calls interleave
        // on the event loop instead of running back-to-back — a
        // process-wide (non-ALS) implementation would have session B's
        // ambient values stomp session A's between this yield and the
        // write below.
        await yieldToEventLoop();
        return begun(j, { object: objectRef(objectName) });
      });

    const [entryA, entryB] = await Promise.all([
      runOne("sess-concurrent-a", "alice", "ZMCP_CONCURRENT_A"),
      runOne("sess-concurrent-b", "bob", "ZMCP_CONCURRENT_B"),
    ]);

    expect(entryA.actor, "session A's entry was attributed to the wrong caller").toBe("alice");
    expect(entryA.sessionId).toBe("sess-concurrent-a");
    expect(entryB.actor, "session B's entry was attributed to the wrong caller").toBe("bob");
    expect(entryB.sessionId).toBe("sess-concurrent-b");

    // Cross-check by re-reading from disk too, not just the returned entries.
    const all = await j.list();
    const fromDiskA = all.find((e) => e.object.name === "ZMCP_CONCURRENT_A");
    const fromDiskB = all.find((e) => e.object.name === "ZMCP_CONCURRENT_B");
    expect(fromDiskA?.actor).toBe("alice");
    expect(fromDiskB?.actor).toBe("bob");
  });
});

// ---------------------------------------------------------------------------
// 4. Journal.sessionId getter
// ---------------------------------------------------------------------------

describe("Journal.sessionId getter", () => {
  it("returns the ambient session's id inside a runInMcpSession scope", () => {
    const j = new Journal(cfg(), "A4H");
    j.setClientSession("process-fallback-id", "process");
    runInMcpSession({ sessionId: "ambient-id" }, () => {
      expect(j.sessionId).toBe("ambient-id");
    });
  });

  it("returns the process-wide id outside any ambient scope", () => {
    const j = new Journal(cfg(), "A4H");
    j.setClientSession("process-fallback-id", "process");
    expect(j.sessionId).toBe("process-fallback-id");
  });
});
