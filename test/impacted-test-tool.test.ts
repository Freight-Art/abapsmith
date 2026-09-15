/**
 * `abap_test` scope="impacted" (issue #111) — the tool-level wiring on top of
 * `selectImpacted` (src/adt/impacted.ts, exercised on its own in
 * test/impacted-selection.test.ts). Covers: every scope/parameter refusal,
 * the empty-selection response, a two-carrier SELECTION+RESULTS render, the
 * TRUNCATED disclosure line, and a journal-sourced changed set dropping an
 * object that was created and then deleted again.
 *
 * `resolveObject` and `readSource` are stubbed by name, the same idiom
 * `test/test-tool-coverage.test.ts` uses for `resolveObject` alone. AUnit
 * run XML is the live-captured bytes already used by `test/aunit.test.ts` /
 * `test/test-tool-coverage.test.ts` — no hand-invented wire XML.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { isAbapError } from "../src/adt/errors.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import { Journal, systemKey, type JournalConfig } from "../src/journal.js";
import { SafetyGate } from "../src/safety.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const read = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

const ALLPASS_XML = read("852-i75-ut-testrun-allpass.xml"); // ZCL_I75_PROBE — PASSED
const FAILING_XML = read("382-ut-testrun.xml"); // ZCL_ZMCP_UT_PROBE — FAILED

// ---------------------------------------------------------------------------
// resolveObject / readSource stubs, keyed by upper-cased object name
// ---------------------------------------------------------------------------

const resolveTable = new Map<string, ResolvedObject>();
const sourceTable = new Map<string, { source: string } | { throws: unknown }>();

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async (_conn: unknown, name: string) => {
    const r = resolveTable.get(name.trim().toUpperCase());
    if (!r) throw new Error(`test bug: resolveObject called for unscripted name "${name}"`);
    return r;
  },
}));

vi.mock("../src/adt/source.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/source.js")>()),
  readSource: async (_conn: unknown, obj: { name: string }) => {
    const r = sourceTable.get(obj.name.trim().toUpperCase());
    if (!r) throw new Error(`test bug: readSource called for unscripted name "${obj.name}"`);
    if ("throws" in r) throw r.throws;
    return { source: r.source, sourceUri: "/x" };
  },
}));

const { abapTest } = await import("../src/tools/test.js");
const { AUNIT_TESTRUNS_URL } = await import("../src/adt/aunit.js");
const { AbapError } = await import("../src/adt/errors.js");

function resolved(name: string, over: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "CLAS/OC",
    kind: "CLAS",
    label: "Class",
    name,
    uri: `/sap/bc/adt/oo/classes/${name.toLowerCase()}`,
    packageName: "$TMP",
    mode: "source",
    activation: "unknown",
    spec: {},
    ...over,
  } as unknown as ResolvedObject;
}

/** Registers a name that resolves as a CLAS with tests (probe: has-tests). */
function withTests(name: string, over: Partial<ResolvedObject> = {}): void {
  resolveTable.set(name, resolved(name, over));
  sourceTable.set(name, { source: "* has tests" });
}

/** Registers a name that resolves as a CLAS with no testclasses include (probe: no-tests). */
function noTests(name: string, over: Partial<ResolvedObject> = {}): void {
  resolveTable.set(name, resolved(name, over));
  sourceTable.set(name, {
    // Mirrors src/adt/source.ts's exact shape for a missing sub-include:
    // AbapError("NOT_FOUND", ..., { ...err.details, requested: inc }, ...).
    // `probeCarrier` (src/tools/test.ts) matches only this specific signal.
    throws: new AbapError("NOT_FOUND", `CLAS ${name} has no "testclasses" include.`, { requested: "testclasses" }, undefined),
  });
}

/** Registers a name that resolves as a CLAS whose `testclasses` read fails for a real (non-"no tests") reason. */
function brokenProbe(name: string, over: Partial<ResolvedObject> = {}): void {
  resolveTable.set(name, resolved(name, over));
  sourceTable.set(name, {
    throws: new AbapError("AUTH_FAILED", `Not authorised to read ${name}.`, { status: 403 }, undefined),
  });
}

beforeEach(() => {
  resolveTable.clear();
  sourceTable.clear();
});

function gate(): SafetyGate {
  return new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
}

interface Call {
  url: string;
  body?: string;
}

function fakeConn(opts: {
  usageReferencesByUri?: Record<string, unknown[]>;
  runByUri?: Record<string, { body: string; status?: number } | { throws: unknown }>;
} = {}): { conn: AbapConnection; calls: Call[] } {
  const calls: Call[] = [];
  const post = async (url: string, o: { headers?: Record<string, string>; body?: string } = {}) => {
    calls.push({ url, ...(o.body === undefined ? {} : { body: o.body }) });
    if (url !== AUNIT_TESTRUNS_URL) throw new Error(`unscripted POST ${url}`);
    const table = opts.runByUri ?? {};
    const uri = Object.keys(table).find((u) => o.body?.includes(`"${u}"`));
    if (!uri) throw new Error(`no scripted run matches body: ${o.body}`);
    const reply = table[uri]!;
    if ("throws" in reply) throw reply.throws;
    return { body: reply.body, status: reply.status ?? 200, headers: {} };
  };
  const conn = {
    cfg: { sid: "A4H", url: "https://a4h.example", client: "100" },
    post,
    adt: {
      usageReferences: async (uri: string) => opts.usageReferencesByUri?.[uri] ?? [],
    },
  } as unknown as AbapConnection;
  return { conn, calls };
}

/** A `Journal` with no session/entries — never touched when `changed` is explicit. */
function unusedJournal(): Journal {
  return new Journal({ dir: "/nonexistent", enabled: false, maxEntries: 200, maxAgeDays: 30 }, "A4H");
}

async function expectBadInput(p: Promise<unknown>, contains?: string): Promise<void> {
  try {
    await p;
    expect.unreachable("expected abapTest to throw BAD_INPUT");
  } catch (e) {
    expect(isAbapError(e)).toBe(true);
    if (isAbapError(e)) {
      expect(e.code).toBe("BAD_INPUT");
      if (contains) expect(e.message).toContain(contains);
    }
  }
}

// ---------------------------------------------------------------------------
// Refusals — every one raised before any request
// ---------------------------------------------------------------------------

describe("abap_test scope refusals", () => {
  it("refuses scope=\"object\" (default) with no object", async () => {
    const { conn, calls } = fakeConn();
    await expectBadInput(abapTest(conn, {}, 50_000, gate(), unusedJournal()));
    expect(calls).toHaveLength(0);
  });

  it("refuses scope=\"object\" with `changed` given", async () => {
    const { conn, calls } = fakeConn();
    await expectBadInput(
      abapTest(conn, { object: "ZCL_A", changed: ["ZCL_A"] }, 50_000, gate(), unusedJournal()),
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses scope=\"object\" with `since` given", async () => {
    const { conn, calls } = fakeConn();
    await expectBadInput(
      abapTest(conn, { object: "ZCL_A", since: "2026-01-01T00:00:00Z" }, 50_000, gate(), unusedJournal()),
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses scope=\"impacted\" with `object` given", async () => {
    const { conn, calls } = fakeConn();
    await expectBadInput(
      abapTest(conn, { scope: "impacted", object: "ZCL_A" }, 50_000, gate(), unusedJournal()),
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses scope=\"impacted\" with both `changed` and `since`", async () => {
    const { conn, calls } = fakeConn();
    await expectBadInput(
      abapTest(
        conn,
        { scope: "impacted", changed: ["ZCL_A"], since: "2026-01-01T00:00:00Z" },
        50_000,
        gate(),
        unusedJournal(),
      ),
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses scope=\"impacted\" with `coverage`", async () => {
    const { conn, calls } = fakeConn();
    await expectBadInput(
      abapTest(conn, { scope: "impacted", changed: ["ZCL_A"], coverage: true }, 50_000, gate(), unusedJournal()),
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses scope=\"impacted\" with `coverage_for`", async () => {
    const { conn, calls } = fakeConn();
    await expectBadInput(
      abapTest(
        conn,
        { scope: "impacted", changed: ["ZCL_A"], coverage_for: ["ZCL_A"] },
        50_000,
        gate(),
        unusedJournal(),
      ),
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses an unparseable `since`", async () => {
    const { conn, calls } = fakeConn();
    await expectBadInput(
      abapTest(conn, { scope: "impacted", since: "not-a-date" }, 50_000, gate(), unusedJournal()),
      "not-a-date",
    );
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Empty selection
// ---------------------------------------------------------------------------

describe("abap_test scope=\"impacted\" — empty selection", () => {
  it("reports NO CHANGED OBJECTS without making any request when `changed` is explicitly empty", async () => {
    const { conn, calls } = fakeConn();
    const res = await abapTest(conn, { scope: "impacted", changed: [] }, 50_000, gate(), unusedJournal());
    expect(calls).toHaveLength(0);
    expect(res.text).toContain("NO CHANGED OBJECTS (not a pass)");
  });

  it("reports NO IMPACTED TESTS FOUND with the exact body shape when nothing carries tests", async () => {
    noTests("ZCL_A");
    const { conn } = fakeConn({ usageReferencesByUri: {} });
    const res = await abapTest(conn, { scope: "impacted", changed: ["ZCL_A"] }, 50_000, gate(), unusedJournal());
    expect(res.text).toContain("outcome: NO IMPACTED TESTS FOUND (not a pass)");
    expect(res.text).toContain(
      "NO IMPACTED TESTS FOUND — 1 changed object(s), 0 consumer(s) examined, none carries a test class",
    );
    // Nothing was capped here: the caps header must read as untruncated, not silently absent.
    expect(res.text).toContain("caps: per-object 20, carriers 10");
    expect(res.text).not.toContain("TRUNCATED");
  });

  it("discloses unexamined consumers even when the selection ends up empty (0 selected must not read as exhaustive)", async () => {
    noTests("ZCL_A");
    // 30 consumers of the one changed object: the per-object cap (20) probes
    // the first 20 (all no-tests, so selected stays empty) and leaves the
    // remaining 10 over-cap and never probed at all.
    const refs = Array.from({ length: 30 }, (_, i) => ({
      "adtcore:type": "CLAS/OC",
      "adtcore:name": `ZCL_D${i}`,
    }));
    for (const r of refs) noTests(r["adtcore:name"]);

    const { conn } = fakeConn({ usageReferencesByUri: { "/sap/bc/adt/oo/classes/zcl_a": refs } });

    const res = await abapTest(conn, { scope: "impacted", changed: ["ZCL_A"] }, 200_000, gate(), unusedJournal());

    expect(res.text).toContain("outcome: NO IMPACTED TESTS FOUND (not a pass)");
    expect(res.text).toContain("selected: 0");
    // Required wording kept exactly as-is, only 20 were actually looked at.
    expect(res.text).toContain(
      "NO IMPACTED TESTS FOUND — 1 changed object(s), 20 consumer(s) examined, none carries a test class",
    );
    // The header must be unmissable about the truncation, not just count it.
    expect(res.text).toContain(
      "caps: per-object 20, carriers 10 — TRUNCATED: an unexamined consumer may carry a test that did not run",
    );
    // The 10 never-probed consumers (ZCL_D20..ZCL_D29) must be named, not just counted.
    expect(res.text).toContain("10 consumer(s) not examined");
    expect(res.text).toContain("ZCL_A: 10 consumer(s) not examined — ZCL_D20, ZCL_D21");
  });
});

// ---------------------------------------------------------------------------
// Two-carrier rendering
// ---------------------------------------------------------------------------

describe("abap_test scope=\"impacted\" — two-carrier run", () => {
  it("renders a SELECTION section and per-carrier RESULTS, aggregating FAILED when one carrier fails", async () => {
    noTests("ZCL_A"); // the changed object itself carries no tests
    withTests("ZCL_I75_PROBE");
    withTests("ZCL_ZMCP_UT_PROBE");

    const consumerRefs = [
      { "adtcore:type": "CLAS/OC", "adtcore:name": "ZCL_I75_PROBE" },
      { "adtcore:type": "CLAS/OC", "adtcore:name": "ZCL_ZMCP_UT_PROBE" },
    ];
    const { conn, calls } = fakeConn({
      usageReferencesByUri: { "/sap/bc/adt/oo/classes/zcl_a": consumerRefs },
      runByUri: {
        "/sap/bc/adt/oo/classes/zcl_i75_probe": { body: ALLPASS_XML },
        "/sap/bc/adt/oo/classes/zcl_zmcp_ut_probe": { body: FAILING_XML },
      },
    });

    const res = await abapTest(conn, { scope: "impacted", changed: ["ZCL_A"] }, 50_000, gate(), unusedJournal());

    expect(res.text).toContain("scope: impacted");
    expect(res.text).toContain("changed: 1");
    expect(res.text).toContain("consumersExamined: 2");
    expect(res.text).toContain("selected: 2");
    // Untruncated: the header states the caps in force, with no truncation
    // wording — neither cap fired for this two-consumer run.
    expect(res.text).toContain("caps: per-object 20, carriers 10");
    expect(res.text).not.toContain("TRUNCATED");
    expect(res.text).toContain("outcome: FAILED");

    expect(res.text).toContain("SELECTION");
    expect(res.text).toContain("ZCL_I75_PROBE (CLAS/OC) — uses ZCL_A");
    expect(res.text).toContain("ZCL_ZMCP_UT_PROBE (CLAS/OC) — uses ZCL_A");

    expect(res.text).toContain("RESULTS");
    expect(res.text).toContain("=== ZCL_I75_PROBE (CLAS/OC): PASSED ===");
    expect(res.text).toContain("=== ZCL_ZMCP_UT_PROBE (CLAS/OC): FAILED ===");
    expect(res.text).toContain("TEST_FAILS");

    // Both carriers actually ran.
    expect(calls.filter((c) => c.url === AUNIT_TESTRUNS_URL)).toHaveLength(2);
  });

  it("keeps the other carrier's verdict when one carrier's run errors", async () => {
    noTests("ZCL_A");
    withTests("ZCL_I75_PROBE");
    withTests("ZCL_BROKEN");

    const consumerRefs = [
      { "adtcore:type": "CLAS/OC", "adtcore:name": "ZCL_I75_PROBE" },
      { "adtcore:type": "CLAS/OC", "adtcore:name": "ZCL_BROKEN" },
    ];
    const { conn } = fakeConn({
      usageReferencesByUri: { "/sap/bc/adt/oo/classes/zcl_a": consumerRefs },
      runByUri: {
        "/sap/bc/adt/oo/classes/zcl_i75_probe": { body: ALLPASS_XML },
        "/sap/bc/adt/oo/classes/zcl_broken": { throws: new Error("connection reset") },
      },
    });

    const res = await abapTest(conn, { scope: "impacted", changed: ["ZCL_A"] }, 50_000, gate(), unusedJournal());

    expect(res.text).toContain("=== ZCL_I75_PROBE (CLAS/OC): PASSED ===");
    expect(res.text).toContain("ZCL_BROKEN");
    expect(res.text).toContain("connection reset");
    // One real verdict survived, so this must not collapse to UNKNOWN.
    expect(res.text).toContain("outcome: PASSED");
  });

  it("reports UNKNOWN when every selected carrier's run errors", async () => {
    noTests("ZCL_A");
    withTests("ZCL_BROKEN");

    const { conn } = fakeConn({
      usageReferencesByUri: {
        "/sap/bc/adt/oo/classes/zcl_a": [{ "adtcore:type": "CLAS/OC", "adtcore:name": "ZCL_BROKEN" }],
      },
      runByUri: { "/sap/bc/adt/oo/classes/zcl_broken": { throws: new Error("boom") } },
    });

    const res = await abapTest(conn, { scope: "impacted", changed: ["ZCL_A"] }, 50_000, gate(), unusedJournal());
    expect(res.text).toContain("outcome: UNKNOWN (not a pass)");
  });
});

// ---------------------------------------------------------------------------
// TRUNCATED disclosure
// ---------------------------------------------------------------------------

describe("abap_test scope=\"impacted\" — truncation", () => {
  it("discloses consumers not examined with a line starting '--- TRUNCATED ---', naming them", async () => {
    noTests("ZCL_A");
    // 22 consumers; only the first carries tests (isolates the per-object cap from
    // the carrier cap — only one carrier is ever selected here, well under
    // SELECTED_CARRIER_CAP, so the cap that fires is purely PER_OBJECT_CONSUMER_CAP).
    const refs = Array.from({ length: 22 }, (_, i) => ({
      "adtcore:type": "CLAS/OC",
      "adtcore:name": `ZCL_C${i}`,
    }));
    withTests(refs[0]!["adtcore:name"]);
    for (const r of refs.slice(1)) noTests(r["adtcore:name"]);

    const { conn } = fakeConn({
      usageReferencesByUri: { "/sap/bc/adt/oo/classes/zcl_a": refs },
      runByUri: { [`/sap/bc/adt/oo/classes/${refs[0]!["adtcore:name"].toLowerCase()}`]: { body: ALLPASS_XML } },
    });

    const res = await abapTest(conn, { scope: "impacted", changed: ["ZCL_A"] }, 200_000, gate(), unusedJournal());
    expect(res.text).toMatch(/^--- TRUNCATED ---/m);
    expect(res.text).toContain("2 consumer(s) not examined");
    expect(res.text).not.toContain("carrier limit reached"); // isolated to the per-object cap
    // The truncation block must NAME the unexamined consumers (ZCL_C20, ZCL_C21 — the
    // per-object cap of 20 leaves the last two of the 22 unprobed), not just count them.
    expect(res.text).toContain("ZCL_A: 2 consumer(s) not examined — ZCL_C20, ZCL_C21");
    // Truncated: the header caps field is unmissable even to a caller who
    // only reads the header, not the SELECTION section below it.
    expect(res.text).toContain(
      "caps: per-object 20, carriers 10 — TRUNCATED: an unexamined consumer may carry a test that did not run",
    );
  });

  it("names every changed object that never got a whereUsed call at all when the carrier cap is hit by earlier objects", async () => {
    // ZCL_A alone produces enough has-tests consumers to hit SELECTED_CARRIER_CAP,
    // so ZCL_B's whereUsed is never even attempted — its consumer count is unknown.
    noTests("ZCL_A");
    noTests("ZCL_B");
    const abundant = Array.from({ length: 11 }, (_, i) => ({
      "adtcore:type": "CLAS/OC",
      "adtcore:name": `ZCL_E${i}`,
    }));
    for (const r of abundant) withTests(r["adtcore:name"]);

    const { conn } = fakeConn({
      usageReferencesByUri: {
        "/sap/bc/adt/oo/classes/zcl_a": abundant,
        "/sap/bc/adt/oo/classes/zcl_b": [{ "adtcore:type": "CLAS/OC", "adtcore:name": "ZCL_NEVER_SEEN" }],
      },
      runByUri: Object.fromEntries(
        abundant.map((r) => [`/sap/bc/adt/oo/classes/${r["adtcore:name"].toLowerCase()}`, { body: ALLPASS_XML }]),
      ),
    });

    const res = await abapTest(
      conn,
      { scope: "impacted", changed: ["ZCL_A", "ZCL_B"] },
      200_000,
      gate(),
      unusedJournal(),
    );
    expect(res.text).toContain("carrier limit reached");
    expect(res.text).toContain("ZCL_B: consumers not examined at all (carrier limit reached first)");
    // ZCL_NEVER_SEEN was never named as a probed consumer — its whereUsed was never called.
    expect(res.text).not.toContain("ZCL_NEVER_SEEN");
  });
});

// ---------------------------------------------------------------------------
// probeCarrier must not relabel real failures as "no tests" (defect fix)
// ---------------------------------------------------------------------------

describe("abap_test scope=\"impacted\" — probeCarrier does not relabel real failures", () => {
  it("propagates a non-\"missing testclasses include\" AbapError from readSource instead of treating it as no-tests", async () => {
    brokenProbe("ZCL_A");
    const { conn, calls } = fakeConn({ usageReferencesByUri: {} });

    await expect(
      abapTest(conn, { scope: "impacted", changed: ["ZCL_A"] }, 50_000, gate(), unusedJournal()),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    // The failure surfaced before any carrier was selected or run.
    expect(calls.filter((c) => c.url === AUNIT_TESTRUNS_URL)).toHaveLength(0);
  });

  it("still treats the specific missing-testclasses-include NOT_FOUND as no-tests", async () => {
    noTests("ZCL_A");
    const { conn } = fakeConn({ usageReferencesByUri: {} });
    const res = await abapTest(conn, { scope: "impacted", changed: ["ZCL_A"] }, 50_000, gate(), unusedJournal());
    expect(res.text).toContain("NO IMPACTED TESTS FOUND");
  });
});

// ---------------------------------------------------------------------------
// Journal-sourced changed set: created-then-deleted is dropped
// ---------------------------------------------------------------------------

describe("abap_test scope=\"impacted\" — journal-sourced changed set", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-impacted-journal-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const cfg = (dir: string): JournalConfig => ({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 });
  const CONN_CFG = { sid: "A4H", url: "https://a4h.example", client: "100" };
  const KEY = systemKey(CONN_CFG);

  async function writeEntry(dir: string, e: Record<string, unknown> & { id: string }): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    const rec = {
      ts: "2026-01-01T00:00:00.000Z",
      systemKey: KEY,
      sessionId: "sess-1",
      operation: "update",
      outcome: "succeeded",
      object: { name: "ZCL_DEMO", type: "CLAS/OC", uri: "/x", package: "$TMP" },
      existedBefore: true,
      beforeCapture: "captured",
      ...e,
    };
    await fs.appendFile(path.join(dir, "index.jsonl"), `${JSON.stringify(rec)}\n`, "utf8");
  }

  it("drops an object whose newest journal entry is a successful delete, noting it, and reports NO CHANGED OBJECTS when it was the only one", async () => {
    await writeEntry(tmp, {
      id: "e1",
      ts: "2026-01-01T00:00:00.000Z",
      operation: "create",
      outcome: "succeeded",
      object: { name: "ZCL_SHORTLIVED", type: "CLAS/OC", uri: "/x", package: "$TMP" },
    });
    await writeEntry(tmp, {
      id: "e2",
      ts: "2026-01-02T00:00:00.000Z",
      operation: "delete",
      outcome: "succeeded",
      object: { name: "ZCL_SHORTLIVED", type: "CLAS/OC", uri: "/x", package: "$TMP" },
    });

    const journal = new Journal(cfg(tmp), "A4H");
    journal.setClientSession("sess-1", "process");

    const { conn, calls } = fakeConn();
    (conn as { cfg: typeof CONN_CFG }).cfg = CONN_CFG;

    const res = await abapTest(conn, { scope: "impacted" }, 50_000, gate(), journal);
    expect(calls).toHaveLength(0);
    expect(res.text).toContain("NO CHANGED OBJECTS (not a pass)");
    expect(res.text).toContain("created and then deleted again");
  });

  it("keeps an object created after a delete of the same name (newest entry wins)", async () => {
    await writeEntry(tmp, {
      id: "e1",
      ts: "2026-01-01T00:00:00.000Z",
      operation: "delete",
      outcome: "succeeded",
      object: { name: "ZCL_A", type: "CLAS/OC", uri: "/x", package: "$TMP" },
    });
    await writeEntry(tmp, {
      id: "e2",
      ts: "2026-01-02T00:00:00.000Z",
      operation: "create",
      outcome: "succeeded",
      object: { name: "ZCL_A", type: "CLAS/OC", uri: "/x", package: "$TMP" },
    });

    const journal = new Journal(cfg(tmp), "A4H");
    journal.setClientSession("sess-1", "process");

    noTests("ZCL_A");
    const { conn } = fakeConn();
    (conn as { cfg: typeof CONN_CFG }).cfg = CONN_CFG;

    const res = await abapTest(conn, { scope: "impacted" }, 50_000, gate(), journal);
    // Not dropped: reaches selection (and finds nothing carries tests).
    expect(res.text).toContain("NO IMPACTED TESTS FOUND");
    expect(res.text).toContain("1 changed object(s)");
  });

  it("refuses when there is no `since`, no `changed`, and no session id yet", async () => {
    const journal = new Journal(cfg(tmp), "A4H"); // setClientSession() never called
    const { conn, calls } = fakeConn();
    (conn as { cfg: typeof CONN_CFG }).cfg = CONN_CFG;
    await expectBadInput(abapTest(conn, { scope: "impacted" }, 50_000, gate(), journal));
    expect(calls).toHaveLength(0);
  });
});
