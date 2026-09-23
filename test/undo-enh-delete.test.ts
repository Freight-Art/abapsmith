/**
 * Issue #200 — undo items 5 and 8 from the tests-undo.md scratchpad:
 *
 *   5. enh-delete undo (create_spot/create_impl/create_hook): deletes the
 *      object when where-used is empty; refuses naming another referencing
 *      object; refuses fail-closed when the where-used check itself fails;
 *      noop when the object is already gone; ENHANCEMENT_DISABLED before
 *      any mutation when the config flag is off; refuses naming an active
 *      BAdI implementation.
 *   8. Preflight: registerJournalTools' mode=undo branch runs an
 *      enhancement undo through `assertIntent` built from
 *      `entry.object.affects`; a missing `affects` is BAD_INPUT, zero
 *      network.
 *
 * Harness copied verbatim (FakeAdt/resp/cfg/connected/catchErr/baseRoute,
 * gate()) from test/enhancement-write.test.ts; localTransport() from
 * test/enh-joint-activation-journal.test.ts; usageReferencesXml() from
 * test/search-where-used-cost.test.ts (the file that exercises
 * fetchUsageReferences); the registerJournalTools MCP wiring from
 * test/journal-undo-registrar.test.ts. Per this codebase's
 * one-small-copy-per-test-file convention, all of it is copied in rather
 * than imported.
 *
 * Fixtures: test/fixtures/enhancement/343-enhsxs-no-filters.xml (ENHS/XS,
 * name ZMCP_SPOT, package $TMP, masterSystem A4H) and
 * .../354-enhoxh-no-filter.xml (ENHO/XH, name ZMCP_ENH_BADI, one
 * badiImplementation entry ZMCP_BADI_I1, isActive="true") — both real
 * captures, byte-for-byte, same as enhancement-write.test.ts.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import { USAGE_REFERENCES_URL } from "../src/adt/element-info.js";
import { performUndo, type UndoOptions } from "../src/adt/undo.js";
import { registerJournalTools, type JournalToolDeps } from "../src/tools/journal.js";
import { Journal, type JournalConfig, type JournalObjectRef, type JournalEnhancedObjectRef } from "../src/journal.js";
import { errorResult } from "../src/server.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Copied from test/enhancement-write.test.ts.
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement");
const fixture = (name: string): string => readFileSync(join(FIXTURES_DIR, name), "utf8");

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
  headers?: Record<string, unknown>;
}

type Route = (r: Recorded) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body, headers: o.headers as Record<string, unknown> | undefined };
    this.calls.push(rec);
    const res = this.route(rec);
    // Loud on purpose: a catch-all 200 would hide exactly the "does a
    // refusal skip the mutating calls" proofs this file exists to make.
    if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
    return res;
  }
  get labels(): string[] {
    return this.calls.map((c) => c.label);
  }
  get verbs(): string[] {
    return this.calls.map((c) => (c.qs._action ? c.qs._action : c.method));
  }
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

/** Real A4H discovery capture — needed so `conn.discovery` reports enhancements
 *  supported/capable; otherwise every reader/deleteEnhancementObject call
 *  below would refuse UNSUPPORTED before this file's own behaviour runs. */
const DISCOVERY_ENHANCEMENTS_XML = fixture("discovery-enhancements.xml");

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, DISCOVERY_ENHANCEMENTS_XML, OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

async function connected(route: Route, config: Config = cfg()): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(config, {
    httpClient: adt,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

/** Same permissive gate config as enhancement-write.test.ts's own gate() —
 *  allows $TMP, opts into enhancement authoring, treats the A4H-mastered
 *  fixtures below as customer-owned. */
const gate = (extra: Partial<ConstructorParameters<typeof SafetyGate>[0]> = {}): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP"],
    allowEnhancements: true,
    enhanceTargets: "customer",
    originSystems: ["A4H"],
    ...extra,
  });

const ENHSXS_URI = "/sap/bc/adt/enhancements/enhsxs/ZMCP_SPOT";
const ENHOXH_URI = "/sap/bc/adt/enhancements/enhoxh/ZMCP_ENH_BADI";
const ENHSXS_XML = fixture("343-enhsxs-no-filters.xml");
const ENHOXH_XML = fixture("354-enhoxh-no-filter.xml");

/** Copied from test/write.test.ts — a 404 body that translateAdtError maps to
 *  AbapError code NOT_FOUND. */
const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">ZMCP_SPOT does not exist</message><properties/></exc:exception>`;

const LOCK_LOCAL_XML =
  `<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">` +
  `<asx:values><DATA><LOCK_HANDLE>84895B18717205C738BE52DAB00DC12609C1821F</LOCK_HANDLE><CORRNR/>` +
  `<CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/>` +
  `<MODIFICATION_SUPPORT>NoModification</MODIFICATION_SUPPORT><SCOPE_MESSAGES/></DATA></asx:values></asx:abap>`;

/** A plausible "affects" for both fixtures (their own spot name). */
const AFFECTS_SPOT: JournalEnhancedObjectRef = { name: "ZMCP_SPOT", packageName: "$TMP", masterSystem: "A4H", spotName: "ZMCP_SPOT" };

/** Copied from test/enh-joint-activation-journal.test.ts — a SessionTransport
 *  whose `trRequirement` answers "local" with no network call at all. */
function localTransport(): SessionTransport {
  const trRequirement = async (
    _conn: AbapConnection,
    uri: string,
    devclass?: string,
  ): Promise<TrRequirement> => ({
    kind: "local",
    mustSupplyCorrNr: false,
    serverWouldFabricate: false,
    uri,
    operation: "U",
    devclass,
    candidates: [],
    locks: [],
    messages: [],
    checkFailed: false,
    raw: { result: "S", korrflag: "", recording: "" },
  });
  return new SessionTransport({ allowTransports: ["*"], cts: { trRequirement } });
}

/** Copied from test/search-where-used-cost.test.ts — the fake covering
 *  fetchUsageReferences' own POST body shape. */
function usageReferencesXml(rows: readonly Record<string, unknown>[]): string {
  const objects = rows
    .map((r, i) => {
      const name = typeof r["adtcore:name"] === "string" ? r["adtcore:name"] : undefined;
      const type = typeof r["adtcore:type"] === "string" ? r["adtcore:type"] : undefined;
      const packageRef = r["packageRef"] as Record<string, unknown> | undefined;
      const pkgName = typeof packageRef?.["adtcore:name"] === "string" ? packageRef["adtcore:name"] : undefined;
      return (
        `<usagereferences:referencedObject uri="/generated/${i}">` +
        `<usagereferences:adtObject${name !== undefined ? ` adtcore:name="${name}"` : ""}` +
        `${type !== undefined ? ` adtcore:type="${type}"` : ""} xmlns:adtcore="http://www.sap.com/adt/core">` +
        `<adtcore:packageRef${pkgName !== undefined ? ` adtcore:name="${pkgName}"` : ""}/>` +
        `</usagereferences:adtObject>` +
        `</usagereferences:referencedObject>`
      );
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="utf-8"?><usagereferences:usageReferenceResult numberOfResults="${rows.length}" ` +
    `xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences"><usagereferences:referencedObjects>` +
    `${objects}</usagereferences:referencedObjects></usagereferences:usageReferenceResult>`
  );
}

// ---------------------------------------------------------------------------
// Real Journal in a throwaway tmp dir, same pattern as test/undo.test.ts and
// test/journal-undo-registrar.test.ts.
// ---------------------------------------------------------------------------

let dir: string;
let journal: Journal;

const jcfg = (over: Partial<JournalConfig> = {}): JournalConfig => ({
  dir,
  enabled: true,
  maxEntries: 200,
  maxAgeDays: 30,
  ...over,
});

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), "abap-undo-enh-delete-"));
  journal = new Journal(jcfg(), "A4H");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A create-shaped journal entry: undo of this resolves to specialUndoKind
 *  "enh-delete" (src/adt/undo-special.ts's specialUndoKind). */
async function beginCreateEntry(object: JournalObjectRef) {
  const e = await journal.begin({
    operation: "create",
    object,
    existedBefore: false,
    beforeCapture: "confirmed-absent",
  });
  expect(e).toBeDefined();
  await journal.finish(e!.id, { outcome: "succeeded" });
  return (await journal.get(e!.id))!;
}

const enhsXsObject = (): JournalObjectRef => ({
  name: "ZMCP_SPOT",
  type: "ENHS/XS",
  uri: ENHSXS_URI,
  package: "$TMP",
  affects: AFFECTS_SPOT,
});

const enhoXhObject = (): JournalObjectRef => ({
  name: "ZMCP_ENH_BADI",
  type: "ENHO/XH",
  uri: ENHOXH_URI,
  package: "$TMP",
  affects: AFFECTS_SPOT,
});

/** Minimal opts for the refusal cases below: the plan is blocked before
 *  `opts.enhancement`/`opts.transport` are ever consulted, so only the
 *  top-level `assertAllowed`/`gate` typecheck-required fields matter. */
const PLAN_ONLY: UndoOptions = {
  assertAllowed: (action, target) => gate().authorize(action === "delete" ? "delete" : "write", target),
  gate: gate(),
};

// ===========================================================================
// Item 5 — enh-delete undo
// ===========================================================================

describe("performUndo — enh-delete (undo of create_spot/create_impl/create_hook)", () => {
  it("deletes the object when where-used is empty", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHSXS_URI && r.method === "GET") return resp(200, ENHSXS_XML, OK_XML);
      if (r.url === USAGE_REFERENCES_URL && r.method === "POST") return resp(200, usageReferencesXml([]), OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.url === ENHSXS_URI && r.method === "DELETE") return resp(200, "", OK_XML);
      return undefined;
    });
    const entry = await beginCreateEntry(enhsXsObject());

    const opts: UndoOptions = {
      assertAllowed: (action, target) => gate().authorize(action === "delete" ? "delete" : "write", target),
      gate: gate(),
      enhancement: { allowEnhancementDelete: true },
      transport: localTransport(),
    };
    const res = await performUndo(conn, journal, entry, opts);

    expect(res.performed).toBe(true);
    // plan-time reader GET + where-used POST, then deleteEnhancementObject's
    // own resolve GET, LOCK, reread GET, DELETE — no UNLOCK (the object and
    // its enqueue are both gone).
    expect(adt.labels).toEqual([
      `GET ${ENHSXS_URI}`,
      `POST ${USAGE_REFERENCES_URL}`,
      `GET ${ENHSXS_URI}`,
      `LOCK ${ENHSXS_URI}`,
      `GET ${ENHSXS_URI}`,
      `DELETE ${ENHSXS_URI}`,
    ]);
    const del = adt.calls.find((c) => c.method === "DELETE")!;
    expect(del.qs).toEqual({ lockHandle: "84895B18717205C738BE52DAB00DC12609C1821F" });
  });

  it("where-used returns another object: refused naming it, zero mutating requests", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHSXS_URI && r.method === "GET") return resp(200, ENHSXS_XML, OK_XML);
      if (r.url === USAGE_REFERENCES_URL && r.method === "POST")
        return resp(200, usageReferencesXml([{ "adtcore:name": "ZCL_USER", "adtcore:type": "CLAS/OC" }]), OK_XML);
      return undefined;
    });
    const entry = await beginCreateEntry(enhsXsObject());

    const err = await catchErr(performUndo(conn, journal, entry, PLAN_ONLY));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("ZCL_USER");
    expect(err.message).toContain("refusing to delete something in use");
    expect(adt.calls).toHaveLength(2);
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("DELETE");
  });

  it("where-used request fails: refused fail-closed, zero mutating requests", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHSXS_URI && r.method === "GET") return resp(200, ENHSXS_XML, OK_XML);
      if (r.url === USAGE_REFERENCES_URL && r.method === "POST") return resp(500, "<error/>", OK_XML);
      return undefined;
    });
    const entry = await beginCreateEntry(enhsXsObject());

    const err = await catchErr(performUndo(conn, journal, entry, PLAN_ONLY));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("the dependency check (where-used) failed");
    expect(err.message).toContain("refusing rather than deleting blind");
    expect(adt.calls).toHaveLength(2);
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("DELETE");
  });

  it("object already gone: noop, zero LOCK/DELETE requests", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHSXS_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      return undefined;
    });
    const entry = await beginCreateEntry(enhsXsObject());

    const res = await performUndo(conn, journal, entry, PLAN_ONLY);

    expect(res.performed).toBe(false);
    expect(res.plan.action).toBe("noop");
    expect(res.plan.drift.reason).toContain("no longer exists");
    expect(adt.calls).toHaveLength(1);
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("DELETE");
  });

  it("allowEnhancementDelete off: ENHANCEMENT_DISABLED before any mutation", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHSXS_URI && r.method === "GET") return resp(200, ENHSXS_XML, OK_XML);
      if (r.url === USAGE_REFERENCES_URL && r.method === "POST") return resp(200, usageReferencesXml([]), OK_XML);
      return undefined;
    });
    const entry = await beginCreateEntry(enhsXsObject());

    const opts: UndoOptions = {
      assertAllowed: (action, target) => gate().authorize(action === "delete" ? "delete" : "write", target),
      gate: gate(),
      enhancement: { allowEnhancementDelete: false },
      transport: localTransport(),
    };
    const err = await catchErr(performUndo(conn, journal, entry, opts));

    expect(err.code).toBe("ENHANCEMENT_DISABLED");
    // The plan phase's own reader GET + where-used POST already ran (that is
    // "before any MUTATION", not before any request) — but no LOCK/DELETE.
    expect(adt.calls).toHaveLength(2);
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("DELETE");
  });

  it("active BAdI implementation: refused naming the implementation", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXH_URI && r.method === "GET") return resp(200, ENHOXH_XML, OK_XML);
      if (r.url === USAGE_REFERENCES_URL && r.method === "POST") return resp(200, usageReferencesXml([]), OK_XML);
      return undefined;
    });
    const entry = await beginCreateEntry(enhoXhObject());

    const err = await catchErr(performUndo(conn, journal, entry, PLAN_ONLY));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("ZMCP_BADI_I1");
    expect(err.message).toContain("active BAdI implementation");
    expect(err.message).toContain("refusing to delete an active implementation");
    expect(adt.calls).toHaveLength(2);
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("DELETE");
  });
});

// ===========================================================================
// Item 8 — Preflight: enhancement undo goes through assertIntent with
// entry.object.affects; missing affects -> BAD_INPUT.
// ===========================================================================

/** Same shape as test/journal-undo-registrar.test.ts's harnessWithCounter:
 *  pool.withWrite never runs its callback, only counts whether the gate
 *  sequence let the call reach it. */
function harnessWithCounter(safety: SafetyGate) {
  let poolCalls = 0;
  const deps: JournalToolDeps = {
    pool: {
      withWrite: async <T>(): Promise<T> => {
        poolCalls += 1;
        return { text: "stub: reached pool.withWrite (gate sequence passed)", truncated: false } as unknown as T;
      },
      withRead: async <T>(): Promise<T> => {
        throw new Error("not exercised (mode=undo only in this file)");
      },
      primary: () => {
        throw new Error("not exercised (mode=undo only in this file)");
      },
    } as never,
    safety,
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 50_000, allowEnhancementDelete: true },
    journal,
  };
  const server = new McpServer({ name: "undo-enh-delete-probe", version: "0.0.0" });
  registerJournalTools(server, deps);
  const call = async (args: Record<string, unknown>): Promise<string> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "undo-enh-delete-probe", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const res = await client.callTool({ name: "abap_journal", arguments: args });
    const first = Array.isArray(res.content) ? res.content[0] : undefined;
    return first && typeof first === "object" && "text" in first ? String((first as { text: unknown }).text) : "";
  };
  return { call, calls: () => poolCalls };
}

describe("registerJournalTools mode=undo — enh-delete preflight goes through assertIntent", () => {
  it("missing entry.object.affects: BAD_INPUT, zero pool calls", async () => {
    const entry = await beginCreateEntry({
      name: "ZMCP_SPOT",
      type: "ENHS/XS",
      uri: ENHSXS_URI,
      package: "$TMP",
      // no `affects` at all
    });
    const { call, calls } = harnessWithCounter(gate());

    const text = await call({ mode: "undo", entry: entry.id });

    // Tool output is a JSON string, so a literal `"` in the message is
    // escaped as `\"` in the returned text — match tolerant of that.
    expect(text).toMatch(/BAD_INPUT/);
    expect(text).toMatch(/has no recorded \\?"affects\\?" target/);
    expect(text).toMatch(/There is no override/);
    expect(calls()).toBe(0);
  });

  it("affects present: assertIntent is called with an intent built from it, then the request proceeds past preflight", async () => {
    const g = gate();
    const spy = vi.spyOn(g, "assertIntent");
    const entry = await beginCreateEntry(enhsXsObject());
    const { call, calls } = harnessWithCounter(g);

    const text = await call({ mode: "undo", entry: entry.id });

    expect(spy).toHaveBeenCalledTimes(1);
    const [intentArg, optsArg] = spy.mock.calls[0]!;
    expect(intentArg).toMatchObject({
      enhancementName: "ZMCP_SPOT",
      enhancementType: "ENHS/XS",
      enhancementPackage: "$TMP",
      spotName: "ZMCP_SPOT",
      targetName: "ZMCP_SPOT",
      targetPackage: "$TMP",
      targetMasterSystem: "A4H",
    });
    expect(optsArg).toMatchObject({ op: "delete", phase: "preflight" });
    // Preflight passed: control reached pool.withWrite (via ensureConnected).
    expect(text).toBe("stub: reached pool.withWrite (gate sequence passed)");
    expect(calls()).toBe(1);
  });
});
