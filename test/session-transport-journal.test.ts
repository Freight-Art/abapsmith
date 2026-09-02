/**
 * Auto-created transport requests must be journalled.
 *
 * `SessionTransport` can create a **real, persistent, numbered CTS object** on
 * the ABAP system as a side effect of an ordinary write — a request a human then
 * has to release or delete by hand. abapsmith's whole safety story is that a
 * human can reconstruct afterwards what it did to their system, so a created
 * request that lands in no journal entry is the exact failure the journal exists
 * to prevent: the number exists on the appliance either way, and only the record
 * is optional.
 *
 * These tests pin four properties:
 *
 *  1. **Creation is recorded, with the TRKORR and its provenance.** Filed under
 *     the TRKORR and marked `trSource: "session-created"` — the
 *     value that separates "abapsmith caused this request to exist" from the four
 *     ways `resolve()` hands back a request that was already there.
 *  2. **The record lands before the number is handed out.** The hook is awaited,
 *     so no write path can act on a TRKORR whose journal entry is still an
 *     unresolved promise.
 *  3. **A journal failure never fails the creation, and is never silent.** The
 *     request exists whether or not we recorded it; failing the write would not
 *     remove it. So the failure is reported, naming the number a human now has
 *     to clean up.
 *  4. **Only creation is journalled.** A cached, pinned or caller-named request
 *     already existed; recording it as a creation would be a false entry.
 *
 * Entirely offline: no appliance, no fixtures on the wire. The CTS calls are
 * injected fakes and the journal is a real one in a temp directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type {
  SessionTrCreatedEvent,
  SessionTransportOptions,
  SessionTrSource,
} from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { Journal, systemKey, type JournalConfig, type JournalTrSource } from "../src/journal.js";
import { createServer, transportCreateJournalHook } from "../src/server.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate } from "../src/safety.js";
import { loadCtsFixture } from "./helpers/cts-fixtures.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

/**
 * Mints the `AuthorizedTarget` `trCreate` now requires.
 * Every `SessionTransport` in this file that can reach the real auto-create
 * path (i.e. `trRequirement` returns no `pinnedTo`) needs one wired in via
 * `authorizeCreate`, or `#doCreate` fails closed with an internal wiring
 * error before `trCreate` is ever called — this file is about the JOURNAL
 * side effect of creation, not gate policy, so a single fully-open gate is
 * enough.
 */
const authorizeCreate = (devClass: string) =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"] }).authorize(
    "transport",
    { name: devClass, packageName: devClass },
    { corr: { kind: "unresolved" } },
  );

/**
 * Every `SessionTransportOptions` object any code under test constructs a
 * manager with, in order. `createServer()` builds its manager privately, so this
 * is the only way to prove from outside that the composition root actually
 * WIRES the journal hook — a perfectly good `transportCreateJournalHook` that
 * nothing passes to `new SessionTransport()` records exactly nothing, and every
 * other test in this file would still pass.
 */
const constructedWith: SessionTransportOptions[] = [];

vi.mock("../src/adt/session-transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/adt/session-transport.js")>();
  return {
    ...actual,
    // A real `SessionTransport` in every respect — it IS one — that records the
    // options it was handed. Subclassing rather than stubbing keeps the state
    // machine under test in the tests below genuinely the production one.
    SessionTransport: class extends actual.SessionTransport {
      constructor(opts: SessionTransportOptions) {
        super(opts);
        constructedWith.push(opts);
      }
    },
  };
});

const { SessionTransport } = await import("../src/adt/session-transport.js");

// ---------------------------------------------------------------------------
// The two vocabularies must not drift
// ---------------------------------------------------------------------------

/**
 * COMPILE-TIME assertion, not a runtime one. `JournalTrSource` (src/journal.ts)
 * restates `SessionTrSource` rather than importing it, so that the on-disk
 * record format carries no dependency on the ADT layer. That restatement is only
 * safe if the two stay assignable: adding a source kind to the state machine
 * without adding it to the record format would otherwise fail at the ONE call
 * site that passes it, months later, with a confusing message.
 *
 * `tsc --noEmit` is what enforces this — there is nothing to assert at runtime,
 * and pretending otherwise with an `expect("session-created").toBe(...)` would
 * be a test that passes for reasons unrelated to what it claims to check.
 */
type _EveryStateMachineSourceIsRecordable = SessionTrSource extends JournalTrSource ? true : never;
const _sourcesAgree: _EveryStateMachineSourceIsRecordable = true;
void _sourcesAgree;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRKORR = "A4HK900117";
const OBJ_URI = "/sap/bc/adt/programs/programs/zmcp_demo/source/main";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-sess-tr-"));
  constructedWith.length = 0;
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const jcfg = (dir: string, over: Partial<JournalConfig> = {}): JournalConfig => ({
  dir,
  enabled: true,
  maxEntries: 200,
  maxAgeDays: 30,
  ...over,
});

const FAKE_CFG = { sid: "A4H", url: "http://a4h.example:50000", client: "001" };

/**
 * A minimal, always-valid transportable `TrRequirement`. Only the fields
 * `SessionTransport.resolve()` reads matter — `kind`/`checkFailed`/`devclass`
 * and the absence of `pinnedTo`; the rest exist to satisfy the type. Same idiom
 * as `fakeReq` in test/write.test.ts.
 */
const transportableReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({
    uri: OBJ_URI,
    operation: "I",
    devclass: "ZPKG",
    candidates: [],
    locks: [],
    messages: [],
    checkFailed: false,
    raw: { result: "S", korrflag: "X", recording: "" },
    kind: "transport-required",
    mustSupplyCorrNr: true,
    serverWouldFabricate: false,
    ...overrides,
  }) as unknown as TrRequirement;

const conn = {} as AbapConnection;
const target = { uri: OBJ_URI, name: "ZMCP_DEMO", type: "PROG/P" };

/** A manager that will auto-create `trkorr` on the first transportable write. */
function autoCreating(
  onCreated: (e: SessionTrCreatedEvent) => void | Promise<void>,
  opts: { trkorr?: string; req?: Partial<TrRequirement> } = {},
): { mgr: SessionTransport; trCreate: ReturnType<typeof vi.fn> } {
  const trkorr = opts.trkorr ?? TRKORR;
  const trCreate = vi.fn(async () => ({
    trkorr,
    path: `/com.sap.cts/object_record/${trkorr}`,
  }));
  const mgr = new SessionTransport({
    allowTransports: ["auto"],
    description: "abapsmith session 2026-08-01",
    authorizeCreate,
    cts: {
      trRequirement: vi.fn(async () => transportableReq(opts.req ?? {})),
      trCreate,
    } as never,
    onCreated,
  });
  return { mgr, trCreate };
}

/** Yield past a couple of macrotask boundaries. */
const settleTicks = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

// ---------------------------------------------------------------------------
// 1. Creation is recorded
// ---------------------------------------------------------------------------

describe("an auto-created transport request lands in the journal", () => {
  it("writes a transport-create entry naming the TRKORR, its package and its provenance", async () => {
    const journal = new Journal(jcfg(tmp), "A4H");
    const warn = vi.fn();
    const { mgr } = autoCreating(transportCreateJournalHook({ journal, cfg: FAKE_CFG, warn }));

    const res = await mgr.resolve(conn, target);
    expect(res.outcome).toBe("transport");
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.corrNr).toBe(TRKORR);
    expect(res.source).toBe("session-created");

    // Read through a FRESH Journal over the same directory: this is what a human
    // (or `abap_journal`) sees, not in-memory state.
    const entries = await new Journal(jcfg(tmp), "A4H").list();
    const created = entries.find((e) => e.operation === "transport-create");
    expect(
      created,
      `no transport-create journal entry for ${TRKORR}: SessionTransport created a real, ` +
        `numbered CTS request on the server and abapsmith recorded nothing about it`,
    ).toBeDefined();

    // Everything a human needs to audit or clean up the request by hand.
    expect(created!.object.name).toBe(TRKORR); // filed under the TRKORR
    expect(created!.corrNr).toBe(TRKORR);
    expect(created!.object.package).toBe("ZPKG");
    expect(created!.object.description).toBe("abapsmith session 2026-08-01");
    expect(created!.existedBefore).toBe(false);
    expect(created!.outcome).toBe("succeeded");
    // SID + origin + client, which is what `undo` compares an entry against
    // before it will replay anything — a `transport-create` recorded against the
    // wrong box is exactly as misleading as a source write recorded against it.
    expect(created!.systemKey).toBe(systemKey(FAKE_CFG));
    expect(created!.systemKey).toMatch(/^A4H\|/);
    expect(created!.tool).toMatch(/session transport/i);

    // THE provenance bit: abapsmith minted this on its own initiative.
    expect(created!.trSource).toBe("session-created");

    expect(warn).not.toHaveBeenCalled();
  });

  it("records nothing that could carry a credential, cookie or CSRF token", async () => {
    const journal = new Journal(jcfg(tmp), "A4H");
    const { mgr } = autoCreating(
      transportCreateJournalHook({ journal, cfg: FAKE_CFG, warn: vi.fn() }),
    );
    await mgr.resolve(conn, target);

    // The whole on-disk line, not just the parsed fields: a secret smuggled in
    // via a field this test does not name would still be in these bytes.
    const raw = await fs.readFile(path.join(tmp, "index.jsonl"), "utf8");
    expect(raw).not.toMatch(/sap-usercontext|MYSAPSSO2|x-csrf-token|password|Authorization/i);
  });
});

// ---------------------------------------------------------------------------
// 1b. The composition root actually wires it
// ---------------------------------------------------------------------------

describe("createServer wires the journal into the session transport manager", () => {
  const serverCfg = (): Config =>
    ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "TESTUSER",
      password: "secret",
      sid: "TST",
      client: "001",
    });

  /**
   * No network: `createServer()` connects lazily, and nothing here calls a tool
   * or opens a connection, so this stub is never actually asked to answer
   * anything. It is still routed through `routeSystemRoleProbe` (see
   * `test/system-role-probe-guard.test.ts`): this suite DOES build a
   * connection config (`serverCfg()` above, `client: "001"`), and the guard's
   * scan cannot see that `connect()` is never reached from here. Declaring
   * "nonproductive" says honestly what this fake stands FOR if that ever
   * changes, rather than leaving the probe silently unanswered. Every other
   * route stays poisoned, so a regression that connects eagerly still fails
   * loudly instead of reaching for a real socket.
   */
  const noNetwork = routeSystemRoleProbe(
    {
      request: () => {
        throw new Error("NETWORK CALL LEAKED: constructing the server must not talk to SAP");
      },
    },
    { answer: "nonproductive" },
  );

  it("passes an onCreated hook that journals the request", async () => {
    const journal = new Journal(jcfg(tmp), "TST");
    createServer(serverCfg(), {
      journal,
      httpClient: noNetwork as never,
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });

    expect(constructedWith).toHaveLength(1);
    const onCreated = constructedWith[0]!.onCreated;
    expect(
      onCreated,
      "createServer() built a SessionTransport with NO onCreated hook: it can create a " +
        "numbered CTS request on the appliance and nothing will be journalled",
    ).toBeTypeOf("function");

    // And the hook it wired is one that really writes — asserting only that a
    // function was passed would pass for `() => {}`.
    await onCreated!({
      trkorr: TRKORR,
      devclass: "ZPKG",
      description: "abapsmith session",
      createdAt: new Date().toISOString(),
      objSourceUrl: OBJ_URI,
      source: "session-created",
    });
    const entries = await new Journal(jcfg(tmp), "TST").list();
    expect(entries.map((e) => e.operation)).toEqual(["transport-create"]);
    expect(entries[0]!.corrNr).toBe(TRKORR);
    expect(entries[0]!.trSource).toBe("session-created");
  });
});

// ---------------------------------------------------------------------------
// 1c. …and into the transport TOOLS, which is the other half of the same seam
// ---------------------------------------------------------------------------

/**
 * `registerTransportTools` once took `journal` and `warn` as OPTIONAL deps, so
 * the composition root omitting them compiled cleanly and disabled every
 * transport journal entry in the shipped server: `abap_transport` creates,
 * re-owns and DELETES numbered CTS requests, `abap_transport_release`
 * irreversibly releases them, and none of it was recorded.
 * test/transport-tools.test.ts already pins the honest behaviour of the tools
 * with no journal deps (they record nothing) — that test is right, and this one
 * exists so that the CALL SITE cannot quietly go back to being the thing it
 * documents.
 *
 * `TransportToolDeps.journal` is now REQUIRED, so omitting it in `src/server.ts`
 * is a compile error rather than a silent no-op. This test is still the one
 * that matters: the type stops the field being dropped, but only an end-to-end
 * run proves the journal the composition root passes is the one entries
 * actually reach.
 *
 * This drives a real `abap_transport` create end-to-end — MCP client → the
 * server `createServer()` actually builds → `AbapConnection` → an injected
 * `HttpClient` replaying RECORDED CTS bytes — and then reads the journal back
 * from disk through a fresh `Journal`, which is what a human or `abap_journal`
 * sees. Asserting on the deps object handed to `registerTransportTools` would
 * be satisfied by wiring that is present but inert; a TRKORR that reaches the
 * journal file cannot be.
 *
 * Offline throughout: no appliance is contacted, and the one response that
 * matters is `test/fixtures/cts/create-transport-response` — bytes captured
 * from the real system, replayed, not invented.
 */
describe("createServer wires the journal into the transport tools", () => {
  /** The TRKORR the recorded response actually names. */
  const CREATED_TRKORR = "A4HK900121";

  const writeCfg = (): Config =>
    ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "TESTUSER",
      password: "secret",
      sid: "TST",
      client: "001",
      // The create has to get PAST the gate to reach the journal at all.
      // `ConfigSchema.parse` is called directly here (not `loadConfig`), so
      // the schema's own fail-closed `[]` default applies unless the caller
      // widens it — this create needs an auto-selected transport to succeed.
      readOnly: false,
      allowPackages: ["Z_FLIGHT_ADDITIONAL"],
      allowTransports: ["*"],
    });

  /**
   * An `HttpClient` that answers the one route under test with the recorded
   * bytes and everything else with a bland 200. The bland answer is enough for
   * `connect()` (see test/circuit-breaker-wiring.test.ts) and is NOT a wire
   * shape anyone should read meaning into; the system-role probe is
   * answered properly by `routeSystemRoleProbe`, because "inconclusive" would
   * lock writes out and the create would never reach the journal.
   */
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

  it("records a request created through the abap_transport tool", async () => {
    const journal = new Journal(jcfg(tmp), "TST");
    const { http, posts } = ctsHttp();
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
        name: "abap_transport",
        arguments: {
          operation: "create",
          package: "Z_FLIGHT_ADDITIONAL",
          description: "abapsmith journal wiring",
        },
      })) as unknown as { isError?: boolean; content: Array<{ type: string; text: string }> };

      // The mutation must really have happened, or "nothing was journalled"
      // would be the correct answer and this test would prove nothing.
      expect(
        res.isError ?? false,
        `abap_transport create failed, so this test cannot say anything about ` +
          `journalling: ${res.content[0]?.text ?? "(no content)"}`,
      ).toBe(false);
      expect(res.content[0]!.text).toContain(CREATED_TRKORR);
      expect(posts, "the recorded CTS create was not replayed exactly once").toHaveLength(1);

      const entries = await new Journal(jcfg(tmp), "TST").list();
      expect(
        entries.map((e) => e.operation),
        `abap_transport CREATED ${CREATED_TRKORR} on the system through the real server and ` +
          `NOTHING was journalled: createServer() registered the transport tools with a ` +
          `journal that entries do not reach. \`journal\` is required on TransportToolDeps, ` +
          `so the field cannot simply have been dropped at the registerTransportTools() call ` +
          `site in src/server.ts — look instead at WHICH journal was passed (directory, SID, ` +
          `\`enabled\`) and at whether the tools are settling entries into it.`,
      ).toEqual(["transport-create"]);
      expect(entries[0]!.corrNr).toBe(CREATED_TRKORR);
      expect(entries[0]!.object.name).toBe(CREATED_TRKORR);
    } finally {
      srv.connection.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Ordering — the record lands before the number is handed out
// ---------------------------------------------------------------------------

describe("ordering", () => {
  it("journals AFTER the server confirms creation, so the entry carries the real TRKORR", async () => {
    // The number does not exist until `trCreate` returns; an entry written
    // before the POST could not name it. This pins that the recorded number is
    // the one the server minted, not a placeholder patched in later.
    const journal = new Journal(jcfg(tmp), "A4H");
    const seen: string[] = [];
    const hook = transportCreateJournalHook({ journal, cfg: FAKE_CFG, warn: vi.fn() });
    const trCreate = vi.fn(async () => {
      seen.push("trCreate");
      return { trkorr: TRKORR, path: `/com.sap.cts/object_record/${TRKORR}` };
    });
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      cts: {
        trRequirement: vi.fn(async () => transportableReq()),
        trCreate,
      } as never,
      onCreated: async (e) => {
        seen.push("journal");
        await hook(e);
      },
    });

    await mgr.resolve(conn, target);
    expect(seen).toEqual(["trCreate", "journal"]);
    expect((await journal.list())[0]!.corrNr).toBe(TRKORR);
  });

  it("does not return the TRKORR until the journal write has completed", async () => {
    // The accepted failure is a crash in the window between trCreate returning
    // and the entry landing. Awaiting the hook is what keeps that window down to
    // the disk write itself — a fire-and-forget hook would widen it to "any time
    // before the process happens to flush", and would turn a journal I/O failure
    // into an unhandled rejection.
    let enterHook!: () => void;
    const entered = new Promise<void>((r) => (enterHook = r));
    let releaseHook!: () => void;
    const held = new Promise<void>((r) => (releaseHook = r));

    const { mgr } = autoCreating(async () => {
      enterHook();
      await held;
    });

    let done = false;
    const pending = mgr.resolve(conn, target).then((r) => {
      done = true;
      return r;
    });

    await entered;
    await settleTicks();
    expect(done, "resolve() handed out the TRKORR while the journal hook was still running").toBe(
      false,
    );

    releaseHook();
    const res = await pending;
    expect(done).toBe(true);
    expect(res.corrNr).toBe(TRKORR);
  });

  it("journals the created request exactly once even when two writes race a cold cache", async () => {
    // Single-flight: one POST, and therefore one entry. Two would claim
    // abapsmith created two requests when it created one.
    const journal = new Journal(jcfg(tmp), "A4H");
    const { mgr, trCreate } = autoCreating(
      transportCreateJournalHook({ journal, cfg: FAKE_CFG, warn: vi.fn() }),
    );

    const [a, b] = await Promise.all([mgr.resolve(conn, target), mgr.resolve(conn, target)]);
    expect(a.corrNr).toBe(TRKORR);
    expect(b.corrNr).toBe(TRKORR);
    expect(trCreate).toHaveBeenCalledTimes(1);

    const created = (await journal.list()).filter((e) => e.operation === "transport-create");
    expect(created).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. A journal failure never fails the creation, and is never silent
// ---------------------------------------------------------------------------

describe("a journal that cannot be written", () => {
  /** A journal directory that is really a file: `mkdir` fails with ENOTDIR. */
  const blockedJournal = async (): Promise<Journal> => {
    const blocked = path.join(tmp, "blocked");
    await fs.writeFile(blocked, "not a directory", "utf8");
    return new Journal(jcfg(path.join(blocked, "A4H")), "A4H");
  };

  it("does not fail the transport creation — the request exists whether or not we recorded it", async () => {
    const warn = vi.fn();
    const { mgr } = autoCreating(
      transportCreateJournalHook({ journal: await blockedJournal(), cfg: FAKE_CFG, warn }),
    );

    const res = await mgr.resolve(conn, target);
    expect(res.outcome).toBe("transport");
    expect(res.corrNr).toBe(TRKORR);
    // The state machine still holds the request: reporting a failed creation for
    // a request sitting on the appliance would be worse than not recording it.
    expect(mgr.trkorr).toBe(TRKORR);
    expect(mgr.state.kind).toBe("active");
  });

  it("surfaces the dropped entry loudly, naming the number a human now has to clean up", async () => {
    const warn = vi.fn();
    const { mgr } = autoCreating(
      transportCreateJournalHook({ journal: await blockedJournal(), cfg: FAKE_CFG, warn }),
    );
    await mgr.resolve(conn, target);

    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]![0]);
    expect(msg).toContain(TRKORR); // the number, or the warning is useless
    expect(msg).toMatch(/WAS CREATED/);
    expect(msg).toMatch(/no record|not be journalled/i);
    expect(msg).toMatch(/by hand/i);
  });

  it("falls back to stderr when the HANDLER itself throws", async () => {
    // Defence in depth for the backstop in `#doCreate`: a handler that fails
    // before it can report is the one way this failure could still go missing.
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
    try {
      const { mgr } = autoCreating(() => {
        throw new Error("handler exploded");
      });
      const res = await mgr.resolve(conn, target);
      expect(res.corrNr).toBe(TRKORR);
    } finally {
      spy.mockRestore();
    }
    const warned = writes.join("");
    expect(warned).toContain(TRKORR);
    expect(warned).toMatch(/WAS CREATED/);
    expect(warned).toContain("handler exploded");
  });

  it("reports an entry that was begun but could not be settled, and says the request is real", async () => {
    const journal = new Journal(jcfg(tmp), "A4H");
    // The narrow failure `settle()` exists to make visible: the intent line
    // landed, the outcome line did not, so the entry reads `pending` forever.
    vi.spyOn(journal, "settle").mockResolvedValue({
      settled: false,
      reason: "io-error",
      error: "ENOSPC",
    });
    const warn = vi.fn();
    const { mgr } = autoCreating(transportCreateJournalHook({ journal, cfg: FAKE_CFG, warn }));

    await mgr.resolve(conn, target);

    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]![0]);
    expect(msg).toContain(TRKORR);
    expect(msg).toMatch(/pending/);
    expect(msg).toMatch(/DOES exist/);
    // The entry itself is still on disk with the number on it — a `pending`
    // record of a real request beats no record at all.
    const entry = (await new Journal(jcfg(tmp), "A4H").list())[0]!;
    expect(entry.operation).toBe("transport-create");
    expect(entry.corrNr).toBe(TRKORR);
    expect(entry.outcome).toBe("pending");
  });

  it("stays quiet when the journal is switched off — that is an operator decision, not a failure", async () => {
    const off = new Journal(jcfg(tmp, { enabled: false }), "A4H");
    const warn = vi.fn();
    const { mgr } = autoCreating(transportCreateJournalHook({ journal: off, cfg: FAKE_CFG, warn }));

    const res = await mgr.resolve(conn, target);
    expect(res.corrNr).toBe(TRKORR);
    expect(warn).not.toHaveBeenCalled();
    expect(await off.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Only creation is journalled
// ---------------------------------------------------------------------------

describe("requests that already existed are NOT journalled as creations", () => {
  it("does not fire again when the cached session request is reused", async () => {
    const journal = new Journal(jcfg(tmp), "A4H");
    const onCreated = vi.fn(transportCreateJournalHook({ journal, cfg: FAKE_CFG, warn: vi.fn() }));
    const { mgr } = autoCreating(onCreated);

    await mgr.resolve(conn, target);
    const second = await mgr.resolve(conn, target);
    expect(second.outcome).toBe("transport");
    if (second.outcome !== "transport") throw new Error("unreachable");
    expect(second.source).toBe("session-cached");

    expect(onCreated).toHaveBeenCalledTimes(1);
    expect((await journal.list()).filter((e) => e.operation === "transport-create")).toHaveLength(1);
  });

  it("does not fire for a server-imposed pin — the object was already in that request", async () => {
    const journal = new Journal(jcfg(tmp), "A4H");
    const onCreated = vi.fn(transportCreateJournalHook({ journal, cfg: FAKE_CFG, warn: vi.fn() }));
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      cts: {
        trRequirement: vi.fn(async () => transportableReq({ pinnedTo: "A4HK900456" })),
      } as never,
      onCreated,
    });

    const res = await mgr.resolve(conn, target);
    expect(res.corrNr).toBe("A4HK900456");
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.source).toBe("server-pin");

    expect(onCreated).not.toHaveBeenCalled();
    expect(await journal.list()).toEqual([]);
  });

  it("does not fire for a caller-named request", async () => {
    const journal = new Journal(jcfg(tmp), "A4H");
    const onCreated = vi.fn(transportCreateJournalHook({ journal, cfg: FAKE_CFG, warn: vi.fn() }));
    const mgr = new SessionTransport({
      allowTransports: ["A4HK900123"],
      cts: {
        trRequirement: vi.fn(async () => transportableReq()),
        trShow: vi.fn(async () => ({
          trkorr: "A4HK900123",
          status: "modifiable",
          owner: "DEVELOPER",
          tasks: [],
        })),
      } as never,
      onCreated,
    });

    const res = await mgr.resolve(conn, target, "I", { corrNr: "A4HK900123" });
    expect(res.corrNr).toBe("A4HK900123");
    expect(onCreated).not.toHaveBeenCalled();
    expect(await journal.list()).toEqual([]);
  });
});
