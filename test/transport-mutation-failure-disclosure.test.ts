/**
 * B6/B7 mutation-failure disclosure:
 *  - `src/adt/transports.ts` `trDelete` re-probes on a DELETE throw ONLY when
 *    the delete may have landed anyway — a session death, or a response lost
 *    before any status was seen. A real refusal (SAP answering "no" with an
 *    actual HTTP response) is left exactly as before: no re-probe, no
 *    disclosure, same call count.
 *  - `src/tools/transport.ts` `opAddUser`/`opSetOwner` file an `unproven`
 *    journal entry when the POST/PUT response is lost to a session death or a
 *    genuinely lost response, without disturbing the existing plain-refusal
 *    trade-off (no entry, error untouched).
 *
 * Session-death throws use the `rawThrowFromResponse` idiom from
 * `test/tool-errors-session-death.test.ts` (real `HttpClientException` +
 * abap-adt-api's own `fromException`) rather than `fakeCtsConnection`'s
 * threw-fixture path — that path calls `fromResponse` with no surrounding
 * try/catch, which throws a raw `TypeError` on an HTML body instead of
 * classifying it.
 */
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { fromException, fromResponse } from "abap-adt-api/build/AdtException.js";
import { HttpClientException, type HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";

import { AbapError } from "../src/adt/errors.js";
import type { AbapConnection, RawResponse } from "../src/adt/connection.js";
import { authorizeCeiling, trDelete, type CeilingGate } from "../src/adt/transports.js";
import { Journal, type JournalConfig, type JournalEntry } from "../src/journal.js";
import { SafetyGate } from "../src/safety.js";
import { abapTransport, type TransportInput, type TransportJournalDeps } from "../src/tools/transport.js";
import { fakeCtsConnection, loadCtsFixture, type LoadedCtsFixture } from "./helpers/cts-fixtures.js";
import { sessionTimedOut400 } from "./helpers/fake-adt.js";

const MAX_CHARS = 60_000;

const alwaysAllow: CeilingGate = {
  evaluate: () => ({ allowed: true, reason: "test: always allowed" }),
};
const deleteProof = authorizeCeiling(alwaysAllow, "transport");

function openGate(): SafetyGate {
  return new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransportRelease: true });
}

function transportInput(partial: Partial<TransportInput> & { operation: TransportInput["operation"] }): TransportInput {
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

/** Same idiom as `test/tool-errors-session-death.test.ts`: a real vendor exception, not a hand-rolled shape. */
function rawThrowFromResponse(res: HttpClientResponse): unknown {
  const httpErr = new HttpClientException(
    `Request failed with status code ${res.status}`,
    "ERR_BAD_REQUEST",
    res.status,
    {},
    {},
    res,
    undefined,
  );
  try {
    throw fromException(httpErr, {});
  } catch (e) {
    return e;
  }
}

/** A single-call connection whose one method throws (or resolves) exactly what's given — for the one POST/PUT `opAddUser`/`opSetOwner` make. */
function scriptedConn(outcome: { throw: unknown } | { resolve: RawResponse }): AbapConnection {
  const handle = async (): Promise<RawResponse> => {
    if ("throw" in outcome) throw outcome.throw;
    return outcome.resolve;
  };
  return {
    cfg: { sid: "A4H" },
    get: handle,
    post: handle,
    put: handle,
    del: handle,
  } as unknown as AbapConnection;
}

/**
 * A multi-call connection driven by an ordered queue, each step either a raw
 * throw/resolve (for a session-death-shaped exception, which is not
 * `exc:exception` XML) or a captured fixture, replayed the same way
 * `fakeCtsConnection` does. Needed for `trDelete`'s before-probe / DELETE /
 * re-probe sequence when one of those three calls is a session death.
 */
type MultiStep = { throw: unknown } | { resolve: RawResponse } | LoadedCtsFixture;

function isLoadedFixture(step: MultiStep): step is LoadedCtsFixture {
  return typeof step === "object" && step !== null && "meta" in step;
}

function multiStepConn(steps: MultiStep[]): { conn: AbapConnection; calls: unknown[] } {
  const queue = steps.slice();
  const calls: unknown[] = [];
  const handle = async (): Promise<RawResponse> => {
    calls.push(undefined);
    const step = queue.shift();
    if (!step) throw new Error(`multiStepConn: no scripted response left (call #${calls.length})`);
    if ("throw" in step) throw step.throw;
    if ("resolve" in step) return step.resolve;
    if (isLoadedFixture(step)) {
      const { meta, body } = step;
      if (meta.threw) {
        throw fromResponse(body, {
          status: meta.status,
          statusText: meta.statusText,
          headers: meta.responseHeaders,
          body,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
      }
      return { body, status: meta.status, headers: meta.responseHeaders };
    }
    throw new Error("multiStepConn: unreachable step shape");
  };
  return {
    conn: { cfg: { sid: "A4H" }, get: handle, post: handle, put: handle, del: handle } as unknown as AbapConnection,
    calls,
  };
}

// ---------------------------------------------------------------------------
// B6 — trDelete re-probes on a DELETE throw
// ---------------------------------------------------------------------------

describe("B6: trDelete discloses a post-failure probe on the DELETE throw path", () => {
  it("session death on DELETE, re-probe finds the request gone: code/message unchanged, hint discloses the delete may have landed", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const reprobe = loadCtsFixture("transport-details-nonexistent-error");
    const { conn, calls } = multiStepConn([before, { throw: rawThrowFromResponse(sessionTimedOut400()) }, reprobe]);

    const caught = (await trDelete(conn, "A4HK900117", deleteProof).catch((e: unknown) => e)) as AbapError;

    expect(caught).toBeInstanceOf(AbapError);
    expect(caught.code).toBe("SESSION_DEAD");
    expect(caught.hint).toMatch(/may have landed despite the failure/);
    expect(caught.hint).toMatch(/do not retry blindly/i);
    expect(caught.details.postFailureProbe).toBe("gone");
    // before-GET, failing DELETE, re-probe GET.
    expect(calls).toHaveLength(3);
  });

  it("session death on DELETE, re-probe still finds the request: hint says nothing was deleted", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const reprobe = loadCtsFixture("transport-details-with-objects");
    const { conn, calls } = multiStepConn([before, { throw: rawThrowFromResponse(sessionTimedOut400()) }, reprobe]);

    const caught = (await trDelete(conn, "A4HK900117", deleteProof).catch((e: unknown) => e)) as AbapError;

    expect(caught.code).toBe("SESSION_DEAD");
    expect(caught.hint).toMatch(/still present.*nothing was deleted|nothing was deleted/i);
    expect(caught.details.postFailureProbe).toBe("present");
    expect(calls).toHaveLength(3);
  });

  it("session death on DELETE, re-probe itself fails: hint says the outcome could not be settled, original error still propagates", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    // Reused for its shape only — a genuine thrown, non-GONE failure on the re-probe.
    const reprobe = loadCtsFixture("transport-delete-error-locked-objects");
    const { conn, calls } = multiStepConn([before, { throw: rawThrowFromResponse(sessionTimedOut400()) }, reprobe]);

    const caught = (await trDelete(conn, "A4HK900117", deleteProof).catch((e: unknown) => e)) as AbapError;

    // The re-probe's own failure never replaces the original DELETE error.
    expect(caught.code).toBe("SESSION_DEAD");
    expect(caught.hint).toMatch(/could not be verified/i);
    expect(caught.details.postFailureProbe).toBe("failed");
    expect(calls).toHaveLength(3);
  });

  it("a plain refusal (SAP said no) gets no re-probe and no disclosure — code/hint/call count unchanged", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const del = loadCtsFixture("transport-delete-error-already-released");
    const { conn, calls } = fakeCtsConnection([before, del]);

    const caught = (await trDelete(conn, "A4HK900117", deleteProof).catch((e: unknown) => e)) as AbapError;

    expect(caught.code).toBe("TRANSPORT_ERROR");
    expect(caught.message).toContain("already released");
    expect(caught.hint ?? "").not.toMatch(/post-failure check/i);
    expect(caught.details.postFailureProbe).toBeUndefined();
    // before-GET, failing DELETE — no re-probe GET.
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// B7 — opAddUser / opSetOwner unproven-journal-entry path
// ---------------------------------------------------------------------------

describe("B7: opAddUser/opSetOwner file an unproven journal entry when the POST/PUT response is lost", () => {
  let tmp: string;
  let warn: ReturnType<typeof vi.fn>;

  const jcfg = (dir: string): JournalConfig => ({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 });
  const FAKE_CFG = { sid: "A4H", url: "http://a4h.example:50000", client: "001" };

  async function setup(): Promise<{ deps: TransportJournalDeps; written: () => Promise<JournalEntry[]> }> {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "abapsmith-mutation-disclosure-"));
    warn = vi.fn();
    const journal = new Journal(jcfg(tmp), "A4H");
    return {
      deps: { journal, cfg: FAKE_CFG, warn: warn as unknown as (msg: string) => void },
      written: async () => new Journal(jcfg(tmp), "A4H").list(),
    };
  }

  it("addUser: a session death on the POST leaves a pending journal entry and warns, never absent, never failed", async () => {
    const { deps, written } = await setup();
    const conn = scriptedConn({ throw: rawThrowFromResponse(sessionTimedOut400()) });

    const caught = (await abapTransport(
      conn,
      transportInput({ operation: "addUser", transport: "A4HK900117", user: "developer" }),
      MAX_CHARS,
      openGate(),
      deps,
    ).catch((e: unknown) => e)) as AbapError;

    expect(caught).toBeInstanceOf(AbapError);
    expect(caught.code).toBe("SESSION_DEAD");

    const entries = await written();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe("pending");
    expect(entries[0]!.operation).toBe("transport-add-user");
    expect(entries[0]!.object.name).toBe("A4HK900117");

    const warnings = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warnings).toMatch(/stays `pending` on purpose/);
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("setOwner: a session death on the PUT leaves a pending journal entry and warns, never absent, never failed", async () => {
    const { deps, written } = await setup();
    const conn = scriptedConn({ throw: rawThrowFromResponse(sessionTimedOut400()) });

    const caught = (await abapTransport(
      conn,
      transportInput({ operation: "setOwner", transport: "A4HK900117", user: "developer" }),
      MAX_CHARS,
      openGate(),
      deps,
    ).catch((e: unknown) => e)) as AbapError;

    expect(caught).toBeInstanceOf(AbapError);
    expect(caught.code).toBe("SESSION_DEAD");

    const entries = await written();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe("pending");
    expect(entries[0]!.operation).toBe("transport-set-owner");
    expect(entries[0]!.object.name).toBe("A4HK900117");

    const warnings = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warnings).toMatch(/stays `pending` on purpose/);
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("addUser: a plain refusal (SAP answered no) writes NO journal entry and leaves the error untouched — the accepted trade-off is unchanged", async () => {
    const { deps, written } = await setup();
    // A real exc:exception refusal, safe through fakeCtsConnection's threw path (not HTML).
    const { conn } = fakeCtsConnection([loadCtsFixture("transport-details-nonexistent-error")]);

    const caught = (await abapTransport(
      conn,
      transportInput({ operation: "addUser", transport: "A4HK900119", user: "developer" }),
      MAX_CHARS,
      openGate(),
      deps,
    ).catch((e: unknown) => e)) as AbapError;

    expect(caught).toBeInstanceOf(AbapError);
    expect(caught.code).toBe("TRANSPORT_GONE");
    expect(caught.message).toContain("does not exist");
    // No disclosure appended — this path is untouched by the B7 change.
    expect(caught.hint ?? "").not.toMatch(/response was lost/);

    expect(await written()).toHaveLength(0);
    await fsp.rm(tmp, { recursive: true, force: true });
  });
});
