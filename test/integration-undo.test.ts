/**
 * Live integration test for the write journal and undo.
 * Skipped unless ABAP_URL is set **and** write access is configured
 * (`ABAP_MODE=edit`/`admin`, or the legacy `ABAP_ALLOW_WRITE=true` if
 * `ABAP_MODE` is unset — see `test/helpers/live-write-gate.ts`).
 *
 * Deliberately a SEPARATE file from `integration.test.ts`. We learned the
 * hard way that `.env` supplies `ABAP_URL`, so a bare `npx vitest run` fires the
 * whole live suite (~38 requests). Keeping the write-and-undo probes in their
 * own file makes them individually runnable:
 *
 *     npx vitest run test/integration-undo.test.ts
 *
 * Budget: ~14 requests for the PROG/P block below, plus ~10 more for the
 * DOMA/DD-undo block at the end of the file. Two objects total: `ZMCP_UNDO_LIVE`
 * (PROG/P, source-shape) and `ZMCP_UNDO_DOMA221` (DOMA/DD, properties-shape).
 * Both are in `$TMP` and both are deleted again before the file exits.
 *
 * SAFETY: every test aborts if the circuit breaker tripped, so a bad password
 * costs one logon attempt, not one per test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { loadConfig, loadEnvFile, type Config } from "../src/config.js";
import { authorizeMutation, deleteObject, sourceEquals } from "../src/adt/write.js";
import { Journal, sourceFingerprint } from "../src/journal.js";
import { performUndo, planUndo, type UndoOptions } from "../src/adt/undo.js";
import { abapWrite } from "../src/tools/write.js";
import { abapJournal } from "../src/tools/journal.js";
import { abapSearch } from "../src/tools/search.js";
import { isAbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import { liveSuiteSkipReason, skipForApplianceState } from "./live-appliance-state.js";

loadEnvFile();
const notRun = liveSuiteSkipReason({ write: true });
const d = notRun === undefined ? describe : describe.skip;
// A collection-time skip is counted but never says why; state the reason once, greppably.
if (notRun !== undefined) it("live journal + undo: suite not run", (ctx) => skipForApplianceState(ctx, notRun));

const NAME = "ZMCP_UNDO_LIVE";
const V1 = `REPORT zmcp_undo_live.\nWRITE: / 'version one'.\n`;
const V2 = `REPORT zmcp_undo_live.\nWRITE: / 'version two'.\n`;
const V3 = `REPORT zmcp_undo_live.\nWRITE: / 'version three'.\n`;
const MAX = 60_000;

/**
 * `abapWrite` takes a mandatory gate. This file writes exactly one object,
 * `ZMCP_UNDO_LIVE` in `$TMP` (see the file header), so the gate permits
 * precisely that and nothing wider.
 */
const GATE = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], allowNamePrefixes: ["ZMCP_"] });

/**
 * `performUndo` REQUIRES an authorisation hook (see `UndoOptions.assertAllowed`
 * in `src/adt/undo.ts`) that returns the `AuthorizedTarget` proof
 * `writeObject`/`deleteObject` require to run at all — a caller with no gate
 * has to say so in the source rather than get
 * an unchecked mutation by omission. Routes through the same `GATE` every
 * other write in this file uses, so it is a real, greppable authorisation and
 * not a rubber stamp. Matches the convention in `test/undo.test.ts`.
 */
const ALLOW: UndoOptions = {
  assertAllowed: (action, target) => GATE.authorize(action === "delete" ? "delete" : "write", target),
};

let conn: AbapConnection;
let cfg: Config;
let journal: Journal;
let dir: string;

const assertUsable = () => {
  if (conn.breaker.isTripped) {
    throw new Error(`circuit breaker tripped: ${conn.breaker.info?.message}`);
  }
};

const write = (source: string, extra: Record<string, unknown> = {}) =>
  abapWrite(conn, { object: NAME, type: "PROG/P", source, package: "$TMP", ...extra } as never, MAX, GATE, journal);

const readSource = async (): Promise<string | undefined> => {
  try {
    const r = await conn.get(`/sap/bc/adt/programs/programs/zmcp_undo_live/source/main`, {
      headers: { Accept: "text/plain" },
    });
    return r.body;
  } catch {
    return undefined;
  }
};

d("live journal + undo against A4H", () => {
  beforeAll(async () => {
    cfg = loadConfig();
    conn = new AbapConnection(cfg, { log: () => {}, breaker: new AuthCircuitBreaker() });
    await conn.connect();
    dir = await mkdtemp(join(tmpdir(), "abap-journal-live-"));
    journal = new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, cfg.sid);
  }, 90_000);

  afterAll(async () => {
    // Leave nothing behind. `deleteObject` is idempotent enough here: if the
    // object is already gone the resolve+lock 404s and we swallow it.
    try {
      if (conn?.isConnected && !conn.breaker.isTripped) {
        const authorized = await authorizeMutation(conn, GATE, "delete", { name: NAME, type: "PROG/P" });
        await deleteObject(conn, authorized);
      }
    } catch {
      /* already gone */
    }
    await conn?.shutdown("test-end");
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 90_000);

  it("journals a real creation with existedBefore=false", async () => {
    assertUsable();
    await write(V1);
    const entries = await journal.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.existedBefore).toBe(false);
    expect(entries[0]!.outcome).toBe("succeeded");
    expect(entries[0]!.activation?.activated).toBe(true);
    expect(await journal.beforeImage(entries[0]!)).toBeUndefined();
  }, 120_000);

  it("captures the live before-image on the next write", async () => {
    assertUsable();
    await write(V2);
    const e = (await journal.list())[0]!;
    expect(e.operation).toBe("update");
    expect(e.existedBefore).toBe(true);
    const before = await journal.beforeImage(e);
    // The server hands back CRLF with the trailing newline stripped, so this is
    // an equality test only `sourceEquals` can make.
    expect(before).toBeDefined();
    expect(sourceEquals(before!, V1)).toBe(true);
    expect(before).not.toBe(V1); // …and it really is the server's bytes
  }, 120_000);

  it("sees no drift when nothing else touched the object", async () => {
    assertUsable();
    const e = (await journal.list())[0]!;
    const plan = await planUndo(conn, journal, e);
    expect(plan.drift.drifted).toBe(false);
    expect(plan.action).toBe("restore");
  }, 60_000);

  it("REFUSES an undo once the object has moved on, and succeeds with force", async () => {
    assertUsable();
    const stale = (await journal.list())[0]!; // the V1→V2 entry
    await write(V3); // the object moves on

    const err = await performUndo(conn, journal, stale, ALLOW).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("ETAG_CONFLICT");
    expect(sourceEquals((await readSource())!, V3)).toBe(true); // untouched

    const forced = await performUndo(conn, journal, stale, { ...ALLOW, force: true });
    expect(forced.performed).toBe(true);
    expect(sourceEquals((await readSource())!, V1)).toBe(true);
  }, 180_000);

  it("undo of the creation entry DELETES the object", async () => {
    assertUsable();
    const all = await journal.list({ limit: 50 });
    const creation = all.find((e) => !e.existedBefore && e.operation === "create")!;
    expect(creation).toBeDefined();

    // The object currently holds V1 (restored above), which is exactly what the
    // creation entry left behind — so there is no drift and the delete proceeds.
    expect(creation.after?.fingerprint).toBe(sourceFingerprint(V1));
    const res = await performUndo(conn, journal, creation, ALLOW);
    expect(res.plan.action).toBe("delete");
    expect(await readSource()).toBeUndefined();
  }, 180_000);
});

/**
 * Live regression test for the properties-shape undo-of-create false-drift
 * bug — the exact reproduction that first exposed it.
 *
 * `PROG/P` (above) is source-shape: its etag/fingerprint hash bare source
 * text, which activation does not rewrite, so undo-of-create never showed
 * this bug for it. `DOMA/DD` is properties-shape: `canonicalEtag`/
 * `sourceFingerprint` hash the WHOLE XML descriptor, and activation flips
 * `adtcore:version` inside that descriptor — so before the fix, the
 * journal's after-image (captured from the pre-activation PUT echo) never
 * matched a post-activation probe, and `abap_journal mode=undo` refused a
 * clean undo-of-create with a false `ETAG_CONFLICT` naming Eclipse/SE38/
 * "another agent" as the culprit. Nobody had touched the object.
 *
 * This drives the real MCP tool functions (`abapWrite`, `abapJournal`), not
 * the internal `performUndo`/`planUndo` primitives directly — the same path
 * the original live reproduction walked — so a fix that only worked one
 * layer down would not be caught here.
 *
 * A SEPARATE describe block (own connection, own journal dir, own object) so
 * it is independently runnable and its failure cannot be blamed on the
 * PROG/P block leaving something behind:
 *
 *     npx vitest run test/integration-undo.test.ts -t "false drift"
 *
 * Budget: ~10 requests. Exactly one object, `ZMCP_UNDO_DOMA221` in `$TMP`,
 * deleted by the undo itself and confirmed gone twice — once by `abap_read`,
 * once by `abap_search` — with an unconditional `afterAll` safety net.
 */
d("live: undo of a DOMA/DD create is not refused as false drift", () => {
  const NAME_221 = "ZMCP_UNDO_DOMA221";
  const URI_221 = "/sap/bc/adt/ddic/domains/zmcp_undo_doma221";

  // Properties-shape create: the PUT body is the complete ADT XML descriptor,
  // caller-composed — abapsmith has no XML emitter for these
  // five types. Shape lifted from a manual write harness's (not shipped in
  // this release) `domaXml`, which is itself lifted from this repo's own DDIC fixtures.
  const domaXml = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" xmlns:adtcore="http://www.sap.com/adt/core"` +
    ` adtcore:name="${NAME_221}" adtcore:type="DOMA/DD" adtcore:description="undo-of-create drift probe">` +
    `<adtcore:packageRef adtcore:name="$TMP"/>` +
    `<doma:content>` +
    `<doma:typeInformation><doma:datatype>CHAR</doma:datatype><doma:length>10</doma:length><doma:decimals>0</doma:decimals></doma:typeInformation>` +
    `<doma:outputInformation><doma:length>10</doma:length><doma:lowercase>false</doma:lowercase><doma:signExists>false</doma:signExists></doma:outputInformation>` +
    `</doma:content></doma:domain>`;

  let conn221: AbapConnection;
  let cfg221: Config;
  let journal221: Journal;
  let dir221: string;
  let createEntryId: string | undefined;

  const assertUsable221 = () => {
    if (conn221.breaker.isTripped) {
      throw new Error(`circuit breaker tripped: ${conn221.breaker.info?.message}`);
    }
  };

  const readSource221 = async (): Promise<string | undefined> => {
    try {
      const r = await conn221.get(URI_221, { headers: { Accept: "application/*" } });
      return r.body;
    } catch {
      return undefined;
    }
  };

  const GATE_221 = new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP"],
    allowNamePrefixes: ["ZMCP_"],
  });

  beforeAll(async () => {
    cfg221 = loadConfig();
    conn221 = new AbapConnection(cfg221, { log: () => {}, breaker: new AuthCircuitBreaker() });
    await conn221.connect();
    dir221 = await mkdtemp(join(tmpdir(), "abap-journal-live-221-"));
    journal221 = new Journal({ dir: dir221, enabled: true, maxEntries: 200, maxAgeDays: 30 }, cfg221.sid);
  }, 90_000);

  afterAll(async () => {
    // Unconditional safety net: if any assertion above threw before the undo
    // ran, do not leave ZMCP_UNDO_DOMA221 behind on a shared appliance.
    try {
      if (conn221?.isConnected && !conn221.breaker.isTripped) {
        const authorized = await authorizeMutation(conn221, GATE_221, "delete", {
          name: NAME_221,
          type: "DOMA/DD",
        });
        await deleteObject(conn221, authorized);
      }
    } catch {
      /* already gone, or never created */
    }
    await conn221?.shutdown("test-end");
    if (dir221) await rm(dir221, { recursive: true, force: true });
  }, 90_000);

  it("abap_search confirms the probe name does not already exist", async () => {
    assertUsable221();
    const res = await abapSearch(conn221, { query: NAME_221, type: "DOMA/DD" }, 4000);
    expect(res.text).toMatch(/matches: 0/);
  }, 60_000);

  it("creates and activates ZMCP_UNDO_DOMA221 via abap_write", async () => {
    assertUsable221();
    const res = await abapWrite(
      conn221,
      { object: NAME_221, type: "DOMA/DD", source: domaXml } as never,
      60_000,
      GATE_221,
      journal221,
    );
    expect(res.text).toMatch(/created: true/);
    expect(res.text).toMatch(/activated: true/);
    expect(res.text).not.toMatch(/ETAG_CONFLICT/);

    const entries = await journal221.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.existedBefore).toBe(false);
    expect(entries[0]!.outcome).toBe("succeeded");
    expect(entries[0]!.activation?.activated).toBe(true);
    createEntryId = entries[0]!.id;

    // Confirmed live and active on the server before undo is even attempted.
    const live = await readSource221();
    expect(live).toBeDefined();
    expect(live).toContain('adtcore:version="active"');
  }, 120_000);

  it("undoes the create WITHOUT force — action: delete, performed: true, driftDetected: false, no ETAG_CONFLICT", async () => {
    assertUsable221();
    expect(createEntryId).toBeDefined();

    const res = await abapJournal(
      conn221,
      { mode: "undo", entry: createEntryId } as never,
      60_000,
      journal221,
      GATE_221,
    );

    // THE FALSE-DRIFT ASSERTION. Pre-fix this threw ETAG_CONFLICT, naming
    // Eclipse/SE38/"another agent" as having touched an object nobody but
    // this test had ever written.
    expect(res.isError).not.toBe(true);
    expect(res.text).not.toMatch(/ETAG_CONFLICT/);
    expect(res.text).not.toMatch(/Somebody else edited this object/);
    expect(res.text).toMatch(/action: delete/);
    expect(res.text).toMatch(/performed: true/);
    expect(res.text).not.toMatch(/driftDetected: true/);

    // And the object is actually gone — the probe, the delete and the
    // journal were never in question; only the drift verdict was.
    expect(await readSource221()).toBeUndefined();
  }, 120_000);

  it("abap_search confirms cleanup — 0 matches, nothing left behind", async () => {
    assertUsable221();
    const res = await abapSearch(conn221, { query: NAME_221, type: "DOMA/DD" }, 4000);
    expect(res.text).toMatch(/matches: 0/);
  }, 60_000);
});
