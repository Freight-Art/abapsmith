/**
 * The journal records no actor identity.
 *
 * Before this, `JournalEntry.tool` was the only provenance a journal entry
 * carried, and every entry this codebase's own journal ever produced reads
 * `tool: "abap_write"` regardless of who or what drove it — zero bits of
 * "who did this". These tests pin the fix:
 *
 *  1. **Precedence**: `ABAP_ACTOR` (`JournalConfig.actor`, via
 *     `journalConfigFromEnv()`) beats the MCP client's `clientInfo.name`
 *     (`Journal.setClientActor()`), which beats absence. Absence is
 *     `undefined`, never a placeholder string — a field always populated
 *     with a placeholder is the exact defect being fixed.
 *  2. **Timing**: unlike `config.actor`, the client identity is not known at
 *     `Journal` construction (`src/server.ts` builds the journal before
 *     `connect()`), so it alone must be resolved lazily, via
 *     `setClientActor()` after the fact, not read at `begin()` from anywhere
 *     that could have been known earlier.
 *  3. **Rendering**: `abap_journal mode=list` must not widen/shift its
 *     columns for a page where nothing has an actor.
 *  4. **Backward compatibility**: an index line written before this field
 *     existed (no `actor` key at all) stays readable and undo's planning
 *     logic treats it identically to one that has an actor.
 *  5. **Reachability**: `clientInfo.name` really does reach `Journal`
 *     through the real MCP handshake, end to end — not just in a unit test
 *     of `setClientActor()` in isolation.
 *
 * Entirely offline throughout.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import type { AbapConnection } from "../src/adt/connection.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { plannedAction, deleteEvidenceBlocker } from "../src/adt/undo.js";
import { createServer } from "../src/server.js";
import { loadCtsFixture } from "./helpers/cts-fixtures.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import {
  Journal,
  journalConfigFromEnv,
  type JournalBeginInput,
  type JournalConfig,
  type JournalEntry,
  type JournalObjectRef,
} from "../src/journal.js";
import { abapJournal } from "../src/tools/journal.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-journal-actor-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const cfg = (dir: string, over: Partial<JournalConfig> = {}): JournalConfig => ({
  dir,
  enabled: true,
  maxEntries: 200,
  maxAgeDays: 30,
  ...over,
});

const objectRef = (name = "ZMCP_DEMO"): JournalObjectRef => ({
  name,
  type: "PROG/P",
  uri: `/sap/bc/adt/programs/programs/${name.toLowerCase()}`,
  sourceUri: `/sap/bc/adt/programs/programs/${name.toLowerCase()}/source/main`,
  package: "$TMP",
  description: "journal actor test",
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

/** `mode=list`/`mode=show` never read anything off `conn` but `cfg.sid`. */
const fakeConn = { cfg: { sid: "A4H" } } as unknown as AbapConnection;

// ---------------------------------------------------------------------------
// 1. Precedence: ABAP_ACTOR > client identity > absent
// ---------------------------------------------------------------------------

describe("actor precedence", () => {
  it("is absent when neither config.actor nor a client identity is set", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);
    expect(entry.actor).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(entry, "actor")).toBe(false);
  });

  it("uses config.actor (ABAP_ACTOR) when set, with no client identity", async () => {
    const j = new Journal(cfg(tmp, { actor: "test-actor" }), "A4H");
    const entry = await begun(j);
    expect(entry.actor).toBe("test-actor");
  });

  it("falls back to the MCP client identity when config.actor is unset", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    j.setClientActor("test-mcp-client");
    const entry = await begun(j);
    expect(entry.actor).toBe("test-mcp-client");
  });

  it("prefers config.actor over a client identity that is ALSO set", async () => {
    const j = new Journal(cfg(tmp, { actor: "test-actor" }), "A4H");
    j.setClientActor("test-mcp-client");
    const entry = await begun(j);
    expect(entry.actor).toBe("test-actor");
  });

  it("setClientActor() applies to every begin() call made after it, even though config.actor is fixed at construction", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const before = await begun(j);
    expect(before.actor).toBeUndefined();

    j.setClientActor("test-mcp-client");
    const after = await begun(j);
    expect(after.actor).toBe("test-mcp-client");
  });

  it("setClientActor(undefined) clears a previously set client identity", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    j.setClientActor("test-mcp-client");
    j.setClientActor(undefined);
    const entry = await begun(j);
    expect(entry.actor).toBeUndefined();
  });
});

describe("journalConfigFromEnv reads ABAP_ACTOR", () => {
  it("leaves config.actor unset when ABAP_ACTOR is unset", () => {
    const c = journalConfigFromEnv({}, "A4H", tmp);
    expect(c.actor).toBeUndefined();
  });

  it("trims and carries ABAP_ACTOR into config.actor", () => {
    const c = journalConfigFromEnv({ ABAP_ACTOR: "  test-actor  " }, "A4H", tmp);
    expect(c.actor).toBe("test-actor");
  });

  it("treats a blank ABAP_ACTOR as unset, not as an empty actor", () => {
    const c = journalConfigFromEnv({ ABAP_ACTOR: "   " }, "A4H", tmp);
    expect(c.actor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Rendering: abap_journal mode=list must not widen for actor-less pages
// ---------------------------------------------------------------------------

describe("abap_journal mode=list rendering", () => {
  it("omits the actor column entirely when no entry on the page has one", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    await begun(j, { object: objectRef("ZMCP_ONE") });
    await begun(j, { object: objectRef("ZMCP_TWO") });

    const res = await abapJournal(fakeConn, { mode: "list" }, 60_000, j);
    const lines = res.text.split("\n");
    const header = lines.find((l) => l.startsWith("id "));
    expect(header, `no table header found in:\n${res.text}`).toBeDefined();
    expect(header).not.toMatch(/\bactor\b/);
    expect(res.text).not.toMatch(/\bZMCP_ONE\b.*\btest-/);
  });

  it("shows a populated actor column when every entry on the page has one", async () => {
    const j = new Journal(cfg(tmp, { actor: "test-actor" }), "A4H");
    await begun(j, { object: objectRef("ZMCP_ONE") });
    await begun(j, { object: objectRef("ZMCP_TWO") });

    const res = await abapJournal(fakeConn, { mode: "list" }, 60_000, j);
    const lines = res.text.split("\n");
    const header = lines.find((l) => l.startsWith("id "));
    expect(header).toMatch(/\bactor\b/);
    const dataLines = lines.filter((l) => l.includes("ZMCP_ONE") || l.includes("ZMCP_TWO"));
    expect(dataLines).toHaveLength(2);
    for (const l of dataLines) expect(l).toMatch(/test-actor/);
  });

  it("shows the actor column with a blank cell for entries lacking one, in a mixed page", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    await begun(j, { object: objectRef("ZMCP_NOACTOR") }); // no client identity set yet
    j.setClientActor("test-actor");
    await begun(j, { object: objectRef("ZMCP_WITHACTOR") });

    const res = await abapJournal(fakeConn, { mode: "list" }, 60_000, j);
    const lines = res.text.split("\n");
    const header = lines.find((l) => l.startsWith("id "));
    expect(header).toMatch(/\bactor\b/);
    const actorCol = header!.indexOf("actor");

    const withoutLine = lines.find((l) => l.includes("ZMCP_NOACTOR"));
    const withLine = lines.find((l) => l.includes("ZMCP_WITHACTOR"));
    expect(withoutLine, res.text).toBeDefined();
    expect(withLine, res.text).toBeDefined();
    // The actor cell for the actor-less entry is blank, not "unknown"/"-"/etc.
    const cell = withoutLine!.slice(actorCol, actorCol + "test-actor".length).trim();
    expect(cell).toBe("");
    expect(withLine).toMatch(/test-actor/);
  });

  it("literal before/after: no entries have an actor", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const e = await begun(j, { object: objectRef("ZMCP_DEMO") });
    const res = await abapJournal(fakeConn, { mode: "list" }, 60_000, j);
    const tableStart = res.text.indexOf("id ");
    const tableEnd = res.text.indexOf("\n\n", tableStart);
    const table = res.text.slice(tableStart, tableEnd === -1 ? undefined : tableEnd);
    expect(table).toBe(
      [
        "id                          when                  op      object            existed  capture   outcome  flags",
        "--------------------------  --------------------  ------  ----------------  -------  --------  -------  -----",
        `${e.id}  ${e.ts.replace("T", " ").replace(/\.\d+Z$/, "Z")}  update  PROG/P ZMCP_DEMO  yes      captured  pending`,
      ].join("\n"),
    );
  });

  it("literal before/after: every entry has an actor", async () => {
    const j = new Journal(cfg(tmp, { actor: "test-actor" }), "A4H");
    const e = await begun(j, { object: objectRef("ZMCP_DEMO") });
    const res = await abapJournal(fakeConn, { mode: "list" }, 60_000, j);
    const tableStart = res.text.indexOf("id ");
    const tableEnd = res.text.indexOf("\n\n", tableStart);
    const table = res.text.slice(tableStart, tableEnd === -1 ? undefined : tableEnd);
    expect(table).toBe(
      [
        "id                          when                  op      object            existed  capture   outcome  actor       flags",
        "--------------------------  --------------------  ------  ----------------  -------  --------  -------  ----------  -----",
        `${e.id}  ${e.ts.replace("T", " ").replace(/\.\d+Z$/, "Z")}  update  PROG/P ZMCP_DEMO  yes      captured  pending  test-actor`,
      ].join("\n"),
    );
  });

  it("abap_journal mode=show includes an actor line only when the entry has one", async () => {
    const jNoActor = new Journal(cfg(tmp, { dir: path.join(tmp, "no-actor") }), "A4H");
    const withoutActor = await begun(jNoActor, { object: objectRef("ZMCP_NOACTOR") });
    const resWithout = await abapJournal(
      fakeConn,
      { mode: "show", entry: withoutActor.id },
      60_000,
      jNoActor,
    );
    expect(resWithout.text).not.toMatch(/^actor:/m);

    const jWithActor = new Journal(
      cfg(tmp, { dir: path.join(tmp, "with-actor"), actor: "test-actor" }),
      "A4H",
    );
    const withActor = await begun(jWithActor, { object: objectRef("ZMCP_WITHACTOR") });
    const resWith = await abapJournal(fakeConn, { mode: "show", entry: withActor.id }, 60_000, jWithActor);
    expect(resWith.text).toMatch(/^actor: test-actor$/m);
  });
});

// ---------------------------------------------------------------------------
// 3. Historical (actor-less) entries stay readable and undoable
// ---------------------------------------------------------------------------

describe("entries written before this field existed", () => {
  it("reads back fine and undo's planning logic treats it identically to one with an actor", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    // Simulate an entry written before this field existed: hand-write an entry with NO `actor` key
    // at all, not merely `actor: undefined` (JSON.stringify would drop that
    // too, but this is explicit about what a real historical line looks like).
    const historical: Omit<JournalEntry, "actor"> = {
      id: "20250101T000000000Z-aaaaaa",
      ts: "2025-01-01T00:00:00.000Z",
      system: "A4H",
      operation: "update",
      object: objectRef("ZMCP_HISTORICAL"),
      existedBefore: true,
      beforeCapture: "captured",
      outcome: "succeeded",
      tool: "abap_write",
    };
    await fs.mkdir(tmp, { recursive: true });
    await fs.appendFile(path.join(tmp, "index.jsonl"), JSON.stringify(historical) + "\n", "utf8");

    const reread = await j.get(historical.id);
    expect(reread).toBeDefined();
    expect(reread!.actor).toBeUndefined();

    // Readable through the tool surface too — `show` must not crash on a
    // record missing a field that did not exist when it was written.
    const shown = await abapJournal(fakeConn, { mode: "show", entry: historical.id }, 60_000, j);
    expect(shown.text).toContain("ZMCP_HISTORICAL");
    expect(shown.text).not.toMatch(/^actor:/m);

    // Undo's planning decision (src/adt/undo.ts) is pure and does not
    // consult `actor` at all — pin that an actor-less entry and an
    // otherwise-identical entry WITH an actor plan the same action and the
    // same delete-evidence verdict. Concrete expected values too, so this
    // fails loudly if the fixture ever stops exercising a real branch
    // instead of two calls that both happen to return `undefined`.
    expect(plannedAction(reread!)).toBe("restore");
    expect(deleteEvidenceBlocker(reread!)).toBeUndefined();

    const withActor: JournalEntry = { ...reread!, actor: "test-actor" };
    expect(plannedAction(withActor)).toBe(plannedAction(reread!));
    expect(deleteEvidenceBlocker(withActor)).toBe(deleteEvidenceBlocker(reread!));
  });
});

// ---------------------------------------------------------------------------
// 4. Reachability: clientInfo.name really does reach Journal end to end
// ---------------------------------------------------------------------------

describe("MCP client identity reaches the journal through a real handshake", () => {
  const writeCfg = (): Config =>
    ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "TESTUSER",
      password: "secret",
      sid: "TST",
      client: "001",
      readOnly: false,
      allowPackages: ["Z_FLIGHT_ADDITIONAL"],
      allowTransports: ["*"],
    });

  const ctsHttp = (): { http: HttpClient; posts: HttpClientOptions[] } => {
    const fixture = loadCtsFixture("create-transport-response");
    const posts: HttpClientOptions[] = [];
    const inner = {
      request: async (o: HttpClientOptions): Promise<HttpClientResponse> => {
        if (typeof o.url === "string" && o.url.includes(fixture.meta.url)) {
          posts.push(o);
          return {
            status: fixture.meta.status,
            statusText: fixture.meta.statusText,
            body: fixture.body,
            headers: fixture.meta.responseHeaders,
          } as unknown as HttpClientResponse;
        }
        return {
          status: 200,
          statusText: "OK",
          body: "ok",
          headers: { "content-type": "text/plain", "x-csrf-token": "TOKEN" },
        } as unknown as HttpClientResponse;
      },
    } as unknown as HttpClient;
    return { http: routeSystemRoleProbe(inner, { answer: "nonproductive" }), posts };
  };

  it("a write made by a real MCP client is journalled with that client's name as actor", async () => {
    const journal = new Journal(cfg(tmp), "TST");
    const { http } = ctsHttp();
    const srv = createServer(writeCfg(), {
      journal,
      httpClient: http as never,
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    try {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      // A deliberately synthetic name — see leak-hygiene note in src/journal.ts:
      // this must never look like a real hostname/username.
      const client = new Client({ name: "test-mcp-client", version: "0.0.0" });
      await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);

      const res = (await client.callTool({
        name: "abap_transport",
        arguments: {
          operation: "create",
          package: "Z_FLIGHT_ADDITIONAL",
          description: "abapsmith journal actor wiring",
        },
      })) as unknown as { isError?: boolean; content: Array<{ type: string; text: string }> };
      expect(res.isError ?? false, res.content[0]?.text ?? "(no content)").toBe(false);

      const entries = await new Journal(cfg(tmp), "TST").list();
      expect(entries).toHaveLength(1);
      expect(
        entries[0]!.actor,
        "clientInfo.name from the real MCP initialize handshake did not reach the journal " +
          "entry — either oninitialized never fired, getClientVersion() returned nothing at " +
          "begin() time, or Journal.resolveActor() is not consulting it",
      ).toBe("test-mcp-client");
    } finally {
      srv.connection.dispose();
    }
  });

  it("config.actor (ABAP_ACTOR) still wins over a real, reachable client identity", async () => {
    const journal = new Journal(cfg(tmp, { actor: "test-actor" }), "TST");
    const { http } = ctsHttp();
    const srv = createServer(writeCfg(), {
      journal,
      httpClient: http as never,
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    try {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-mcp-client", version: "0.0.0" });
      await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);

      await client.callTool({
        name: "abap_transport",
        arguments: {
          operation: "create",
          package: "Z_FLIGHT_ADDITIONAL",
          description: "abapsmith journal actor wiring",
        },
      });

      const entries = await new Journal(cfg(tmp), "TST").list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.actor).toBe("test-actor");
    } finally {
      srv.connection.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. sessionId: "which conversation", distinct from `actor` ("who")
// ---------------------------------------------------------------------------

describe("session id", () => {
  it("is absent when setClientSession() was never called", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const entry = await begun(j);
    expect(entry.sessionId).toBeUndefined();
    expect(entry.sessionIdSource).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(entry, "sessionId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(entry, "sessionIdSource")).toBe(false);
  });

  it('carries sessionId + sessionIdSource:"process" once set, applying to every begin() after — same lazy-timing shape as setClientActor()', async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const before = await begun(j, { object: objectRef("ZMCP_BEFORE_SESSION") });
    expect(before.sessionId).toBeUndefined();

    j.setClientSession("11111111-1111-1111-1111-111111111111", "process");
    const after = await begun(j, { object: objectRef("ZMCP_AFTER_SESSION") });
    expect(after.sessionId).toBe("11111111-1111-1111-1111-111111111111");
    expect(after.sessionIdSource).toBe("process");
  });

  it('carries sessionIdSource:"transport" when told the id came from the transport', async () => {
    const j = new Journal(cfg(tmp), "A4H");
    j.setClientSession("transport-supplied-id", "transport");
    const entry = await begun(j);
    expect(entry.sessionId).toBe("transport-supplied-id");
    expect(entry.sessionIdSource).toBe("transport");
  });

  it("is stable across multiple entries within one process — not minted per entry", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    j.setClientSession("stable-id", "process");
    const a = await begun(j, { object: objectRef("ZMCP_SESSION_A") });
    const b = await begun(j, { object: objectRef("ZMCP_SESSION_B") });
    const c = await begun(j, { object: objectRef("ZMCP_SESSION_C") });
    expect(a.sessionId).toBe("stable-id");
    expect(b.sessionId).toBe("stable-id");
    expect(c.sessionId).toBe("stable-id");
  });

  it("setClientSession(undefined, ...) clears a previously set session id", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    j.setClientSession("some-id", "process");
    j.setClientSession(undefined, "process");
    const entry = await begun(j);
    expect(entry.sessionId).toBeUndefined();
    expect(entry.sessionIdSource).toBeUndefined();
  });

  it("Journal.sessionId reflects the id that would be spliced onto the NEXT begin(), for session=current to resolve", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    expect(j.sessionId).toBeUndefined();
    j.setClientSession("live-id", "process");
    expect(j.sessionId).toBe("live-id");
  });

  it("historical entries with no sessionId key at all stay readable — absent, not a placeholder", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    const historical: Omit<JournalEntry, "sessionId" | "sessionIdSource"> = {
      id: "20250101T000000000Z-bbbbbb",
      ts: "2025-01-01T00:00:00.000Z",
      system: "A4H",
      operation: "update",
      object: objectRef("ZMCP_HIST_SESSION"),
      existedBefore: true,
      beforeCapture: "captured",
      outcome: "succeeded",
      tool: "abap_write",
    };
    await fs.mkdir(tmp, { recursive: true });
    await fs.appendFile(path.join(tmp, "index.jsonl"), JSON.stringify(historical) + "\n", "utf8");

    const reread = await j.get(historical.id);
    expect(reread).toBeDefined();
    expect(reread!.sessionId).toBeUndefined();
    expect(reread!.sessionIdSource).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. abap_journal mode=list session filter, incl. session="current"
// ---------------------------------------------------------------------------

describe("abap_journal mode=list session filter", () => {
  it("session=<id> filters to only entries carrying that sessionId", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    j.setClientSession("session-one", "process");
    await begun(j, { object: objectRef("ZMCP_FILTER_ONE") });
    j.setClientSession("session-two", "process");
    await begun(j, { object: objectRef("ZMCP_FILTER_TWO") });

    const res = await abapJournal(fakeConn, { mode: "list", session: "session-one" }, 60_000, j);
    expect(res.text).toContain("ZMCP_FILTER_ONE");
    expect(res.text).not.toContain("ZMCP_FILTER_TWO");
    expect(res.text).toMatch(/session: session-one/);
  });

  it('session="current" resolves to this running process\'s own session id and echoes the resolved id in the header', async () => {
    const j = new Journal(cfg(tmp), "A4H");
    j.setClientSession("other-process-id", "process");
    await begun(j, { object: objectRef("ZMCP_NOT_MINE") });
    j.setClientSession("this-process-id", "process");
    await begun(j, { object: objectRef("ZMCP_MINE") });

    const res = await abapJournal(fakeConn, { mode: "list", session: "current" }, 60_000, j);
    expect(res.text).toContain("ZMCP_MINE");
    expect(res.text).not.toContain("ZMCP_NOT_MINE");
    expect(res.text).toMatch(/session: this-process-id/);
  });

  it('session="current" fails clearly, rather than silently returning everything, when no session id has been set yet', async () => {
    const j = new Journal(cfg(tmp), "A4H");
    await begun(j);
    await expect(
      abapJournal(fakeConn, { mode: "list", session: "current" }, 60_000, j),
    ).rejects.toThrow(/no session id/);
  });

  it("does not add a session column to the list table — it stays a filter, not width", async () => {
    const j = new Journal(cfg(tmp), "A4H");
    j.setClientSession("col-check-id", "process");
    await begun(j, { object: objectRef("ZMCP_COLCHECK") });

    const res = await abapJournal(fakeConn, { mode: "list" }, 60_000, j);
    const lines = res.text.split("\n");
    const header = lines.find((l) => l.startsWith("id "));
    expect(header, `no table header found in:\n${res.text}`).toBeDefined();
    expect(header).not.toMatch(/\bsession\b/);
  });
});

// ---------------------------------------------------------------------------
// 7. abap_journal mode=show surfaces sessionId alongside actor
// ---------------------------------------------------------------------------

describe("abap_journal mode=show session line", () => {
  it("includes a sessionId line only when the entry has one", async () => {
    const jNoSession = new Journal(cfg(tmp, { dir: path.join(tmp, "no-session") }), "A4H");
    const withoutSession = await begun(jNoSession, { object: objectRef("ZMCP_NOSESSION") });
    const resWithout = await abapJournal(
      fakeConn,
      { mode: "show", entry: withoutSession.id },
      60_000,
      jNoSession,
    );
    expect(resWithout.text).not.toMatch(/^sessionId:/m);

    const jWithSession = new Journal(cfg(tmp, { dir: path.join(tmp, "with-session") }), "A4H");
    jWithSession.setClientSession("shown-session-id", "process");
    const withSession = await begun(jWithSession, { object: objectRef("ZMCP_WITHSESSION") });
    const resWith = await abapJournal(fakeConn, { mode: "show", entry: withSession.id }, 60_000, jWithSession);
    expect(resWith.text).toMatch(/^sessionId: shown-session-id$/m);
    expect(resWith.text).toMatch(/^sessionIdSource: process$/m);
  });
});

// ---------------------------------------------------------------------------
// 8. Reachability: the real MCP handshake wires a process session id too
// ---------------------------------------------------------------------------

describe("MCP handshake wires a session id, end to end", () => {
  const writeCfg = (): Config =>
    ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "TESTUSER",
      password: "secret",
      sid: "TST",
      client: "001",
      readOnly: false,
      allowPackages: ["Z_FLIGHT_ADDITIONAL"],
      allowTransports: ["*"],
    });

  const ctsHttp = (): { http: HttpClient } => {
    const fixture = loadCtsFixture("create-transport-response");
    const inner = {
      request: async (o: HttpClientOptions): Promise<HttpClientResponse> => {
        if (typeof o.url === "string" && o.url.includes(fixture.meta.url)) {
          return {
            status: fixture.meta.status,
            statusText: fixture.meta.statusText,
            body: fixture.body,
            headers: fixture.meta.responseHeaders,
          } as unknown as HttpClientResponse;
        }
        return {
          status: 200,
          statusText: "OK",
          body: "ok",
          headers: { "content-type": "text/plain", "x-csrf-token": "TOKEN" },
        } as unknown as HttpClientResponse;
      },
    } as unknown as HttpClient;
    return { http: routeSystemRoleProbe(inner, { answer: "nonproductive" }) };
  };

  it('a write over a real (stdio-shaped) MCP connection is journalled with sessionIdSource:"process" — StdioServerTransport supplies no transport session id', async () => {
    const journal = new Journal(cfg(tmp), "TST");
    const { http } = ctsHttp();
    const srv = createServer(writeCfg(), {
      journal,
      httpClient: http as never,
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    try {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-mcp-client", version: "0.0.0" });
      await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);

      const res = (await client.callTool({
        name: "abap_transport",
        arguments: {
          operation: "create",
          package: "Z_FLIGHT_ADDITIONAL",
          description: "abapsmith journal session wiring",
        },
      })) as unknown as { isError?: boolean; content: Array<{ type: string; text: string }> };
      expect(res.isError ?? false, res.content[0]?.text ?? "(no content)").toBe(false);

      const entries = await new Journal(cfg(tmp), "TST").list();
      expect(entries).toHaveLength(1);
      expect(
        entries[0]!.sessionId,
        "oninitialized never set a session id on the journal, or it isn't reaching begin()",
      ).toBeDefined();
      expect(entries[0]!.sessionIdSource).toBe("process");
    } finally {
      srv.connection.dispose();
    }
  });
});
