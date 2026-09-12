/**
 * `src/tools/transport.ts` — the session-ownership contract: the
 * `createdByAbapsmith` header field on `show` and a release dry run, and the
 * release-time refusal for a request this abapsmith server process did not
 * create.
 *
 * Split out from test/transport-tools.test.ts because that file is
 * deliberately silent on ownership — every call there either omits the 6th
 * `ownership` argument or exercises operations ownership never touches — so
 * its assertions never had to know `SessionTrOwner` exists. This file is the
 * opposite: every test here either supplies a stub or explicitly proves that
 * omitting one leaves the pre-existing behaviour untouched (case 3, case 10).
 * Same offline harness as that file: `fakeCtsConnection`/`loadCtsFixture`
 * against real wire fixtures, no network, no live appliance.
 *
 * "the journal outlives the server process (issue #67)" below adds the
 * second evidence source: `createdByAbapsmith` doesn't only ask THIS
 * process's in-memory `SessionTrOwner` — it also consults the on-disk
 * journal for a `transport-create` entry filed on this system, so a caller
 * that reconnects in a fresh process can still learn a request is one
 * abapsmith made earlier, distinct from "this process made it".
 */
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SafetyGate } from "../src/safety.js";
import { Journal, systemKey, type JournalConfig } from "../src/journal.js";
import {
  abapTransport,
  abapTransportRelease,
  type TransportInput,
  type TransportJournalDeps,
} from "../src/tools/transport.js";
import type { SessionTrOwner } from "../src/adt/session-transport.js";
import type { CtsScriptStep } from "./helpers/cts-fixtures.js";
import {
  fakeCtsConnection,
  loadCtsFixture,
  trListRequest,
  trListWorkbenchBody,
} from "./helpers/cts-fixtures.js";

const MAX_CHARS = 60_000;

/** A wide-open gate: write and release are both permitted, nothing else in play. */
function openGate(): SafetyGate {
  return new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowTransportRelease: true,
  });
}

/** Minimal `TransportInput`; callers override only the fields the op needs. */
function transportInput(
  partial: Partial<TransportInput> & { operation: TransportInput["operation"] },
): TransportInput {
  return {
    transport: undefined,
    user: undefined,
    object: undefined,
    package: undefined,
    description: undefined,
    confirm: undefined,
    ...partial,
  };
}

/**
 * A minimal `SessionTrOwner`, normalising the same way `SessionTransport`
 * itself does (`.trim().toUpperCase()` — see `createdThisSession`/
 * `noteCreated` in src/adt/session-transport.ts). `created` is exposed so a
 * test can both pre-seed it and inspect it after a call.
 */
function ownershipStub(...owned: string[]): SessionTrOwner & { created: Set<string> } {
  const created = new Set(owned.map((t) => t.trim().toUpperCase()));
  return {
    created,
    createdThisSession(trkorr: string): boolean {
      return created.has(trkorr.trim().toUpperCase());
    },
    noteCreated(trkorr: string): void {
      created.add(trkorr.trim().toUpperCase());
    },
  };
}

// ---------------------------------------------------------------------------
// abap_transport operation: show — createdByAbapsmith header + note
// ---------------------------------------------------------------------------

describe("abap_transport operation: show — createdByAbapsmith", () => {
  it("an ownership stub that knows nothing, with no journal deps, renders createdByAbapsmith: unknown — no journal was supplied to this call", async () => {
    const fixture = loadCtsFixture("transport-details-with-objects");
    const { conn } = fakeCtsConnection([fixture]);
    const ownership = ownershipStub(); // knows nothing

    const res = await abapTransport(
      conn,
      transportInput({ operation: "show", transport: "A4HK900117" }),
      MAX_CHARS,
      openGate(),
      undefined,
      ownership,
    );

    expect(res.text).toMatch(/^createdByAbapsmith: unknown — no journal was supplied to this call$/m);
    expect(res.text).toContain(
      "A4HK900117 was not created by this server process, and no journal was supplied to this " +
        "call — so abapsmith cannot tell whether an earlier process created it.",
    );
  });

  it("an ownership stub that knows this request renders createdByAbapsmith: yes (this server process), with no such note", async () => {
    const fixture = loadCtsFixture("transport-details-with-objects");
    const { conn } = fakeCtsConnection([fixture]);
    const ownership = ownershipStub("A4HK900117");

    const res = await abapTransport(
      conn,
      transportInput({ operation: "show", transport: "A4HK900117" }),
      MAX_CHARS,
      openGate(),
      undefined,
      ownership,
    );

    expect(res.text).toMatch(/^createdByAbapsmith: yes \(this server process\)$/m);
    expect(res.text).not.toMatch(/was NOT created by abapsmith/);
    expect(res.text).not.toMatch(/was not created by this server process/);
  });

  it("no ownership object at all: the header field is absent entirely (never rendered as 'no'), and no note — pre-existing direct/test callers are unaffected", async () => {
    const fixture = loadCtsFixture("transport-details-with-objects");
    const { conn } = fakeCtsConnection([fixture]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "show", transport: "A4HK900117" }),
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).not.toMatch(/createdByAbapsmith/);
    expect(res.text).not.toMatch(/was NOT created by abapsmith/);
  });
});

// ---------------------------------------------------------------------------
// De-duped object counts: opShow and the release dry run share `unionedObjects`
// (src/tools/transport.ts) so they can't drift. Ground truth (fixture
// transport-details-with-objects): A4HK900117's tm:all_objects and its task
// A4HK900118 both carry the SAME R3TR PROG ZMCP_CTS_PROBE entry — one real
// lock, recorded twice on the wire.
// ---------------------------------------------------------------------------

describe("abap_transport_release dry run: de-duped object count (regression guard)", () => {
  it("reports the de-duped union, not a naive concat that double-counts an object recorded under both the request and a task", async () => {
    const fixture = loadCtsFixture("transport-details-with-objects");
    const { conn } = fakeCtsConnection([fixture]);

    const res = await abapTransportRelease(conn, { transport: "A4HK900117" }, MAX_CHARS, openGate());

    expect(res.text).toMatch(/^objects: 1$/m);
    const objectLines = res.text.split("\n").filter((line) => line.includes("ZMCP_CTS_PROBE"));
    expect(objectLines).toHaveLength(1);
  });

  it("show and a release dry run agree on the object count for the same fixture", async () => {
    const showFixture = loadCtsFixture("transport-details-with-objects");
    const { conn: showConn } = fakeCtsConnection([showFixture]);
    const showRes = await abapTransport(
      showConn,
      transportInput({ operation: "show", transport: "A4HK900117" }),
      MAX_CHARS,
    );

    const dryRunFixture = loadCtsFixture("transport-details-with-objects");
    const { conn: releaseConn } = fakeCtsConnection([dryRunFixture]);
    const dryRunRes = await abapTransportRelease(
      releaseConn,
      { transport: "A4HK900117" },
      MAX_CHARS,
      openGate(),
    );

    const showCount = showRes.text.match(/^objects: (\d+)$/m)?.[1];
    const dryRunCount = dryRunRes.text.match(/^objects: (\d+)$/m)?.[1];
    expect(showCount).toBeDefined();
    expect(showCount).toBe(dryRunCount);
  });
});

// ---------------------------------------------------------------------------
// abap_transport_release dry run: createdByAbapsmith header + note
// ---------------------------------------------------------------------------

describe("abap_transport_release dry run — createdByAbapsmith", () => {
  it("an unowned request's dry run, with no journal deps, renders createdByAbapsmith: unknown and warns an armed release will refuse without confirm_unowned", async () => {
    const fixture = loadCtsFixture("transport-details-with-objects");
    const { conn } = fakeCtsConnection([fixture]);
    const ownership = ownershipStub(); // knows nothing

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117" },
      MAX_CHARS,
      openGate(),
      undefined,
      ownership,
    );

    expect(res.text).toMatch(/^createdByAbapsmith: unknown — no journal was supplied to this call$/m);
    expect(res.text).toContain(
      "A4HK900117 was not created by this server process, and no journal was supplied to this " +
        "call — so abapsmith cannot tell whether an earlier process created it. Releasing it " +
        "would also transport whatever earlier work left in it",
    );
    expect(res.text).toContain('confirm_unowned: "A4HK900117"');
  });
});

// ---------------------------------------------------------------------------
// abap_transport_release, armed: the ownership gate
// ---------------------------------------------------------------------------

describe("abap_transport_release: the ownership gate on an armed release", () => {
  it("an armed release of a request this session did not create is refused (BAD_INPUT), before any POST — only the pre-read GET happens", async () => {
    const fixture = loadCtsFixture("transport-details-with-objects");
    const { conn, calls } = fakeCtsConnection([fixture]);
    const ownership = ownershipStub(); // knows nothing

    const err = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
      undefined,
      ownership,
    ).catch((e: unknown) => e as { code?: string; message?: string });

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("A4HK900117 was not created by this abapsmith server process");
    expect(err.message).toContain('confirm_unowned: "A4HK900117"');
    // The object it would carry, so the caller can judge the override without a second call.
    expect(err.message).toContain("ZMCP_CTS_PROBE");
    // The important assertion: no release POST was ever issued.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
  });

  it("confirm_unowned lets an armed release of an unowned request through, and the POST is issued", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const release = loadCtsFixture("transport-release-success");
    const after = loadCtsFixture("transport-details-released");
    const { conn, calls } = fakeCtsConnection([before, release, after]);
    const ownership = ownershipStub(); // knows nothing

    await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117", confirm_unowned: "A4HK900117" },
      MAX_CHARS,
      openGate(),
      undefined,
      ownership,
    );

    expect(calls.some((c) => c.method === "POST")).toBe(true);
  });

  it("a request the session itself created needs no confirm_unowned override — the POST is issued", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const release = loadCtsFixture("transport-release-success");
    const after = loadCtsFixture("transport-details-released");
    const { conn, calls } = fakeCtsConnection([before, release, after]);
    const ownership = ownershipStub("A4HK900117");

    await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
      undefined,
      ownership,
    );

    expect(calls.some((c) => c.method === "POST")).toBe(true);
  });

  it("no ownership object at all: the gate is opt-in — an armed release proceeds exactly as before, POST included", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const release = loadCtsFixture("transport-release-success");
    const after = loadCtsFixture("transport-details-released");
    const { conn, calls } = fakeCtsConnection([before, release, after]);

    await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
    );

    expect(calls.some((c) => c.method === "POST")).toBe(true);
  });

  it("confirm_unowned must echo the transport number exactly — a mismatch is BAD_INPUT before any network call", async () => {
    const { conn, calls } = fakeCtsConnection([]);

    await expect(
      abapTransportRelease(
        conn,
        { transport: "A4HK900117", confirm: "A4HK900117", confirm_unowned: "A4HK900999" },
        MAX_CHARS,
        openGate(),
      ),
    ).rejects.toMatchObject({
      code: "BAD_INPUT",
      message: "confirm_unowned must echo the transport number exactly",
    });
    expect(calls).toHaveLength(0);
  });

  it("confirm_unowned on an already-owned request is ignored, not an error — the release still succeeds", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const release = loadCtsFixture("transport-release-success");
    const after = loadCtsFixture("transport-details-released");
    const { conn, calls } = fakeCtsConnection([before, release, after]);
    const ownership = ownershipStub("A4HK900117");

    await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117", confirm_unowned: "A4HK900117" },
      MAX_CHARS,
      openGate(),
      undefined,
      ownership,
    );

    expect(calls.some((c) => c.method === "POST")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// abap_transport operation: create — records ownership
// ---------------------------------------------------------------------------

describe("abap_transport operation: create — records ownership", () => {
  it("a created request is recorded via ownership.noteCreated, so a later createdThisSession check on it returns true", async () => {
    const fixture = loadCtsFixture("create-transport-response");
    const { conn } = fakeCtsConnection([fixture]);
    const ownership = ownershipStub();

    const res = await abapTransport(
      conn,
      transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "test" }),
      MAX_CHARS,
      openGate(),
      undefined,
      ownership,
    );

    expect(res.text).toContain("A4HK900121");
    expect(ownership.createdThisSession("A4HK900121")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// abap_transport operation: create — ownership on the RECOVERY path
// ---------------------------------------------------------------------------
//
// A create whose response is lost after the server already acted is recovered by
// `recoverPossiblyCreated` (see test/transport-tools.test.ts for the recovery error itself).
// Ownership has to be recorded there too, and BEFORE the throw — nothing after it runs.
// But the recovery match is only user + modifiable + workbench + exact description, so it
// can return several requests of which at most one is really ours. The line drawn: note an
// unambiguous recovery, leave an ambiguous one unowned rather than spend the
// confirm_unowned guarantee on requests this session cannot show it created.

describe("abap_transport operation: create — ownership when a failed create is recovered", () => {
  const failedCreate = loadCtsFixture("create-object-error-corrnr-not-found");

  it("a single recovered candidate is noted, so releasing it later does not demand confirm_unowned", async () => {
    const list = trListWorkbenchBody(trListRequest({ trkorr: "A4HK900200", desc: "test" }));
    const { conn } = fakeCtsConnection([failedCreate, list]);
    const ownership = ownershipStub();

    await expect(
      abapTransport(
        conn,
        transportInput({
          operation: "create",
          package: "Z_FLIGHT_ADDITIONAL",
          description: "test",
        }),
        MAX_CHARS,
        openGate(),
        undefined,
        ownership,
      ),
    ).rejects.toMatchObject({ details: expect.objectContaining({ possiblyCreated: ["A4HK900200"] }) });

    // The whole point: the request the server may well have created for us is ours.
    expect(ownership.createdThisSession("A4HK900200")).toBe(true);
    expect([...ownership.created]).toEqual(["A4HK900200"]);
  });

  it("several recovered candidates are left unowned — at most one is ours and we cannot say which", async () => {
    const list = trListWorkbenchBody(
      trListRequest({ trkorr: "A4HK900200", desc: "test" }) +
        trListRequest({ trkorr: "A4HK900201", desc: "test" }),
    );
    const { conn } = fakeCtsConnection([failedCreate, list]);
    const ownership = ownershipStub();

    await expect(
      abapTransport(
        conn,
        transportInput({
          operation: "create",
          package: "Z_FLIGHT_ADDITIONAL",
          description: "test",
        }),
        MAX_CHARS,
        openGate(),
        undefined,
        ownership,
      ),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ possiblyCreated: ["A4HK900200", "A4HK900201"] }),
    });

    // Neither — not even the first. Both are still named to the caller by the error above;
    // an armed release of either will simply ask for confirm_unowned, which is the intended
    // speed bump in front of an irreversible action.
    expect(ownership.createdThisSession("A4HK900200")).toBe(false);
    expect(ownership.createdThisSession("A4HK900201")).toBe(false);
    expect(ownership.created.size).toBe(0);
  });

  it("a recovery that finds nothing notes nothing and leaves the original failure unchanged", async () => {
    const { conn } = fakeCtsConnection([failedCreate, trListWorkbenchBody("")]);
    const ownership = ownershipStub();

    await expect(
      abapTransport(
        conn,
        transportInput({
          operation: "create",
          package: "Z_FLIGHT_ADDITIONAL",
          description: "test",
        }),
        MAX_CHARS,
        openGate(),
        undefined,
        ownership,
      ),
    ).rejects.toMatchObject({ details: expect.not.objectContaining({ possiblyCreated: expect.anything() }) });

    expect(ownership.created.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ownership follows subject substitution: `createdThisSession` (the module
// helper in src/tools/transport.ts) ORs the asked number and the answered
// one, so a task under a request this session created still reads as owned.
// Fixture ground truth (transport-details-task-resolves-to-parent): a GET of
// task A4HK900132 answers about its PARENT request A4HK900131.
// ---------------------------------------------------------------------------

describe("abap_transport operation: show — ownership follows subject substitution", () => {
  it("asking about a TASK whose PARENT this session created still renders createdByAbapsmith: yes (this server process)", async () => {
    const fixture = loadCtsFixture("transport-details-task-resolves-to-parent");
    const { conn } = fakeCtsConnection([fixture]);
    const ownership = ownershipStub("A4HK900131"); // knows only the PARENT

    const res = await abapTransport(
      conn,
      transportInput({ operation: "show", transport: "A4HK900132" }),
      MAX_CHARS,
      openGate(),
      undefined,
      ownership,
    );

    expect(res.text).toMatch(/answeredAbout: A4HK900131/);
    expect(res.text).toMatch(/^createdByAbapsmith: yes \(this server process\)$/m);
  });
});

// ---------------------------------------------------------------------------
// The journal outlives the server process (issue #67): `createdByAbapsmith`
// consults the on-disk journal for a `transport-create` entry, so a caller
// that reconnects in a fresh process can still learn abapsmith made a
// request earlier. This is a SECOND evidence source alongside the in-memory
// `SessionTrOwner` exercised above — every case here uses a real, on-disk
// `Journal`, same idiom as the journalling describe block in
// test/transport-tools.test.ts (`fsp.mkdtemp` per test, a `jcfg()` helper, a
// `deps()` helper building `TransportJournalDeps`).
// ---------------------------------------------------------------------------

describe("the journal outlives the server process (issue #67)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "abapsmith-tr-ownership-journal-"));
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  const jcfg = (dir: string, over: Partial<JournalConfig> = {}): JournalConfig => ({
    dir,
    enabled: true,
    maxEntries: 200,
    maxAgeDays: 30,
    ...over,
  });

  const FAKE_CFG = { sid: "A4H", url: "http://a4h.example:50000", client: "001" };

  const deps = (journal?: Journal, cfg = FAKE_CFG): TransportJournalDeps => ({
    journal: journal ?? new Journal(jcfg(tmp), "A4H"),
    cfg,
    warn: vi.fn() as unknown as (msg: string) => void,
  });

  /**
   * Seed a `transport-create` journal entry shaped exactly like the ones
   * `src/tools/transport.ts`'s `opCreate` writes (see its `trRef`/`beginInput`),
   * settled to the given outcome, without going through `abapTransport` at all
   * — used by the cases that need a FAILED or otherwise-shaped entry no real
   * create call would leave behind.
   */
  async function seedTransportCreateEntry(
    journal: Journal,
    trkorr: string,
    outcome: "succeeded" | "failed",
  ): Promise<void> {
    const entry = await journal.begin({
      operation: "transport-create",
      object: {
        name: trkorr,
        type: "CTS/TR",
        uri: `/sap/bc/adt/cts/transportrequests/${trkorr}`,
        package: "",
        description: "test",
      },
      existedBefore: false,
      systemKey: systemKey(FAKE_CFG),
      corrNr: trkorr,
      trSource: "caller",
      tool: "abap_transport create",
    });
    expect(entry, "journal.begin must actually write an entry").toBeDefined();
    await journal.settle(
      entry!.id,
      outcome === "failed" ? { outcome: "failed", error: "simulated failure" } : { outcome: "succeeded" },
    );
  }

  it("a: create (this process) then show from a FRESH process finds the journal entry (the issue's exact scenario)", async () => {
    const createFixture = loadCtsFixture("create-transport-response"); // returns A4HK900121
    // No captured details fixture exists for A4HK900121 (the number the create fixture
    // returns), so the "with-objects" details fixture is replayed with every occurrence of
    // its own request number rewritten to A4HK900121 — same real shape, different number.
    const detailsFixture = loadCtsFixture("transport-details-with-objects");
    const detailsStep: CtsScriptStep = {
      status: detailsFixture.meta.status,
      body: detailsFixture.body.replaceAll("A4HK900117", "A4HK900121"),
    };
    const { conn } = fakeCtsConnection([createFixture, detailsStep]);
    const journalDeps = deps();
    const ownershipA = ownershipStub(); // server process A

    const createRes = await abapTransport(
      conn,
      transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "test" }),
      MAX_CHARS,
      openGate(),
      journalDeps,
      ownershipA,
    );
    expect(createRes.text).toContain("A4HK900121");

    const ownershipB = ownershipStub(); // a FRESH server process — knows nothing in memory

    const showRes = await abapTransport(
      conn,
      transportInput({ operation: "show", transport: "A4HK900121" }),
      MAX_CHARS,
      openGate(),
      journalDeps,
      ownershipB,
    );

    expect(showRes.text).toMatch(/^createdByAbapsmith: yes \(journal entry .+\)$/m);
    expect(showRes.text).toContain("was created by abapsmith earlier");
  });

  it("b: journal enabled but holding nothing for this request renders createdByAbapsmith: no", async () => {
    const fixture = loadCtsFixture("transport-details-with-objects");
    const { conn } = fakeCtsConnection([fixture]);
    const journalDeps = deps();
    const ownership = ownershipStub();

    const res = await abapTransport(
      conn,
      transportInput({ operation: "show", transport: "A4HK900117" }),
      MAX_CHARS,
      openGate(),
      journalDeps,
      ownership,
    );

    expect(res.text).toMatch(/^createdByAbapsmith: no \(not this process; no journal entry on A4H\)$/m);
    expect(res.text).toContain("A4HK900117 was NOT created by abapsmith");
  });

  it("c: a journal deliberately switched off renders createdByAbapsmith: unknown — the journal is off", async () => {
    const fixture = loadCtsFixture("transport-details-with-objects");
    const { conn } = fakeCtsConnection([fixture]);
    const off = new Journal(jcfg(tmp, { enabled: false }), "A4H");
    const journalDeps = deps(off);
    const ownership = ownershipStub();

    const res = await abapTransport(
      conn,
      transportInput({ operation: "show", transport: "A4HK900117" }),
      MAX_CHARS,
      openGate(),
      journalDeps,
      ownership,
    );

    expect(res.text).toMatch(/^createdByAbapsmith: unknown — the journal is off$/m);
  });

  it("d: an entry recorded against a DIFFERENT system (same journal directory) does not count — journal dirs are namespaced per SID only", async () => {
    const createFixture = loadCtsFixture("create-transport-response"); // returns A4HK900121
    const { conn: createConn } = fakeCtsConnection([createFixture]);
    const otherBoxCfg = { sid: "A4H", url: "http://other.example:50000", client: "002" };
    // Same directory (`tmp`/SID "A4H") as every other case here, but a DIFFERENT
    // url/client — same box's journal file, different system's identity.
    const otherBoxDeps = deps(new Journal(jcfg(tmp), "A4H"), otherBoxCfg);
    await abapTransport(
      createConn,
      transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "test" }),
      MAX_CHARS,
      openGate(),
      otherBoxDeps,
      ownershipStub(),
    );

    const detailsFixture = loadCtsFixture("transport-details-with-objects");
    const detailsStep: CtsScriptStep = {
      status: detailsFixture.meta.status,
      body: detailsFixture.body.replaceAll("A4HK900117", "A4HK900121"),
    };
    const { conn: showConn } = fakeCtsConnection([detailsStep]);
    const normalDeps = deps(new Journal(jcfg(tmp), "A4H")); // FAKE_CFG — this box's identity

    const res = await abapTransport(
      showConn,
      transportInput({ operation: "show", transport: "A4HK900121" }),
      MAX_CHARS,
      openGate(),
      normalDeps,
      ownershipStub(),
    );

    expect(res.text).toMatch(/^createdByAbapsmith: no \(not this process; no journal entry on A4H\)$/m);
  });

  it("e: a FAILED transport-create entry does not count as ownership evidence", async () => {
    const journal = new Journal(jcfg(tmp), "A4H");
    await seedTransportCreateEntry(journal, "A4HK900117", "failed");

    const fixture = loadCtsFixture("transport-details-with-objects");
    const { conn } = fakeCtsConnection([fixture]);
    const journalDeps = deps(journal);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "show", transport: "A4HK900117" }),
      MAX_CHARS,
      openGate(),
      journalDeps,
      ownershipStub(),
    );

    expect(res.text).toMatch(/^createdByAbapsmith: no \(not this process; no journal entry on A4H\)$/m);
  });

  it("f: a release DRY RUN reports journal evidence for a SUCCEEDED transport-create entry", async () => {
    const journal = new Journal(jcfg(tmp), "A4H");
    await seedTransportCreateEntry(journal, "A4HK900117", "succeeded");

    const fixture = loadCtsFixture("transport-details-with-objects");
    const { conn } = fakeCtsConnection([fixture]);
    const journalDeps = deps(journal);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117" },
      MAX_CHARS,
      openGate(),
      journalDeps,
      ownershipStub(), // a fresh process — knows nothing in memory
    );

    expect(res.text).toMatch(/^createdByAbapsmith: yes \(journal entry .+\)$/m);
    expect(res.text).toContain("was created by abapsmith earlier");
    expect(res.text).toContain('confirm_unowned: "A4HK900117"');
  });

  it("g: the armed-release guard is unchanged — journal evidence alone does not let an armed release through without confirm_unowned", async () => {
    // Same journal-evidenced request as (f): journal evidence is reported to the
    // caller, but the irreversible act still wants the explicit override, because
    // this SERVER PROCESS still did not create it — only an earlier one did.
    const journal = new Journal(jcfg(tmp), "A4H");
    await seedTransportCreateEntry(journal, "A4HK900117", "succeeded");

    const fixture = loadCtsFixture("transport-details-with-objects");
    const { conn, calls } = fakeCtsConnection([fixture]);
    const journalDeps = deps(journal);

    const err = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
      journalDeps,
      ownershipStub(), // empty: a fresh process
    ).catch((e: unknown) => e as { code?: string; message?: string });

    expect(err.code).toBe("BAD_INPUT");
    // The important assertion: no release POST was ever issued — only the pre-read GET.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
  });
});
