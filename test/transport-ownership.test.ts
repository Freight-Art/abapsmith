/**
 * `src/tools/transport.ts` — the session-ownership contract: the
 * `createdThisSession` header field on `show` and a release dry run, and the
 * release-time refusal for a request this session did not create.
 *
 * Split out from test/transport-tools.test.ts because that file is
 * deliberately silent on ownership — every call there either omits the 6th
 * `ownership` argument or exercises operations ownership never touches — so
 * its assertions never had to know `SessionTrOwner` exists. This file is the
 * opposite: every test here either supplies a stub or explicitly proves that
 * omitting one leaves the pre-existing behaviour untouched (case 3, case 10).
 * Same offline harness as that file: `fakeCtsConnection`/`loadCtsFixture`
 * against real wire fixtures, no network, no live appliance.
 */
import { describe, expect, it } from "vitest";

import { SafetyGate } from "../src/safety.js";
import {
  abapTransport,
  abapTransportRelease,
  type TransportInput,
} from "../src/tools/transport.js";
import type { SessionTrOwner } from "../src/adt/session-transport.js";
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
// abap_transport operation: show — createdThisSession header + note
// ---------------------------------------------------------------------------

describe("abap_transport operation: show — createdThisSession", () => {
  it("an ownership stub that knows nothing renders createdThisSession: no, with the not-created-by-this-session note", async () => {
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

    expect(res.text).toMatch(/^createdThisSession: no$/m);
    expect(res.text).toContain(
      "A4HK900117 was NOT created by this session — it was already open when this session started",
    );
  });

  it("an ownership stub that knows this request renders createdThisSession: yes, with no such note", async () => {
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

    expect(res.text).toMatch(/^createdThisSession: yes$/m);
    expect(res.text).not.toMatch(/was NOT created by this session/);
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

    expect(res.text).not.toMatch(/createdThisSession/);
    expect(res.text).not.toMatch(/was NOT created by this session/);
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
// abap_transport_release dry run: createdThisSession header + note
// ---------------------------------------------------------------------------

describe("abap_transport_release dry run — createdThisSession", () => {
  it("an unowned request's dry run renders createdThisSession: no and warns an armed release will refuse without confirm_unowned", async () => {
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

    expect(res.text).toMatch(/^createdThisSession: no$/m);
    expect(res.text).toContain(
      "A4HK900117 was NOT created by this session — releasing it would also transport",
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
    expect(err.message).toContain("A4HK900117 was not created by this session");
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
  it("asking about a TASK whose PARENT this session created still renders createdThisSession: yes", async () => {
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
    expect(res.text).toMatch(/^createdThisSession: yes$/m);
  });
});
