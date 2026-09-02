/**
 * The joint-activation half of the fix. `activateSpotAndImplementation`
 * (`src/adt/enhancement-bridge.ts`) POSTs ONCE to `/sap/bc/adt/activation`
 * naming TWO objects — the enhancement spot (`ENHS/XS`) and its
 * implementation (`ENHO/XH`) — in the same `<adtcore:objectReferences>` body.
 * The fix threads a REQUIRED `onBeforeActivation`/`onJointActivation` hook
 * through that call, and `src/tools/enh.ts`'s `set_filter_values` case fires a
 * SECOND, nested `withJournalledMutation` from it, so the spot's own
 * `activate` entry lands on disk before the wire POST that activates it —
 * mirroring what the outer (implementation) entry already did.
 *
 * ## Why this file exists, and not just a static tripwire
 *
 * `test/journal-contract.test.ts` runs two static checks, and BOTH are
 * structurally blind to a revert of this fix:
 *
 *   - `JOURNALLED_BY` maps each journalled OPERATION (create/update/delete/
 *     activate/...) to the SOURCE FILE(S) that are expected to call
 *     `journal.begin`/`withJournalledMutation` for it. It is granular by
 *     MODULE, not by call site. `src/tools/enh.ts` already appears in that
 *     map for `"activate"` — because `write_description`'s inline
 *     `set_impl_active` activation, and other activate-flavoured entries,
 *     already lived there before this fix. Deleting JUST the nested
 *     `withJournalledMutation` this fix added (reverting `set_filter_values`
 *     back to journalling only the implementation, not the spot) removes
 *     nothing that map is watching: the file still calls `begin()` for
 *     `"activate"` elsewhere, so the map is still satisfied. A grep-shaped
 *     check cannot see that the SAME operation is now missing at a
 *     DIFFERENT, specific call site.
 *
 *   - `PINNED_MUTATION_CENSUS` pins a COUNT of `withJournalledMutation`/
 *     `journal.begin` call sites (or a similar structural census) so that a
 *     call site cannot be silently deleted without the count moving. A count
 *     is exactly as blind as it sounds: it catches "the number of call sites
 *     changed", not "call site X still exists but no longer produces an
 *     entry for object Y". Concretely, replacing the nested
 *     `withJournalledMutation(...)` block in the `set_filter_values` case
 *     with a plain `await setFilterValues(conn, deps.safety, { ...,
 *     onJointActivation: async () => {} })` — i.e. keeping a call site with
 *     the right SHAPE but wiring the hook to a no-op — moves no census
 *     number at all, because the outer withJournalledMutation call is
 *     untouched and the inner one, if merely gutted rather than deleted,
 *     may not even change the count of `begin()`-shaped expressions in the
 *     file.
 *
 * Neither static check can express "for THIS operation, TWO entries must
 * exist, one per object named in the joint POST, and the second one must be
 * on disk before the wire call fires." That is a runtime property of the
 * REAL bridge, the REAL journal, and the REAL ordering between them — which
 * is exactly what this file drives and then inspects, off disk, the same way
 * `test/enh-system-key.test.ts` (its harness this file borrows wholesale)
 * does for the systemKey half of the same issue.
 *
 * ## Division of labour between the tests below
 *
 *   - Test 1 proves the END STATE: after a successful `set_filter_values`,
 *     BOTH the spot's `ENHS/XS activate` entry and the implementation's
 *     `ENHO/XH update` entry are on disk, and the spot entry carries
 *     `irreversible:true` and a real `systemKey`. On its own this test would
 *     still pass if the spot entry were written AFTER the POST returned —
 *     the end state looks identical either way.
 *   - Test 2 proves the ORDERING GUARANTEE the fix is actually about: the
 *     mocked `/sap/bc/adt/activation` route itself reads `index.jsonl`
 *     synchronously, at the moment it is invoked, and confirms the spot's
 *     entry is ALREADY there. This is the one assertion in this file that a
 *     "write the entry, but late" regression could not slip past.
 *   - Test 3 proves the ABORT GUARANTEE: if the journal hook itself throws
 *     (simulated via a `Journal` subclass whose `begin()` fails on its
 *     second call — the nested/spot one), the joint POST is never issued at
 *     all. An unrecorded mutation must be an unperformed one.
 *   - Test 5 proves that a failure surfacing AFTER the POST (SAP itself
 *     rejecting the joint activation) settles the SPOT's own entry to
 *     `outcome:"failed"`, not just the implementation's — the two objects
 *     named in one POST get two independently terminable records.
 *
 * A fourth, "empty systemKey" test is deliberately NOT duplicated here.
 * `test/enh-system-key.test.ts`'s last test ("reproduces the journal.ts:1152
 * trap directly") already exercises `Journal.begin({ systemKey: "" })`
 * directly, with no dependency on `abap_enh`, `set_filter_values`, or any
 * particular operation — the trap lives entirely inside `journal.ts` and is
 * already fully covered there. Test 1 below still asserts `"systemKey" in
 * entry` (not mere truthiness) specifically BECAUSE of that trap; see that
 * file's header for the full reasoning.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import type { SessionPool } from "../src/adt/pool.js";
import { errorResult } from "../src/server.js";
import { registerEnhancementTools, type EnhToolDeps } from "../src/tools/enh.js";
import {
  Journal,
  systemKey,
  type JournalBeginInput,
  type JournalConfig,
  type JournalEntry,
} from "../src/journal.js";
import { BRIDGE_CLASS } from "../src/adt/enhancement-bridge.js";
import { T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Harness — a trimmed, independent copy of test/enh-system-key.test.ts's own
// (itself copied from enhancement-tools.test.ts / enhancement-write.test.ts /
// fpm-tools.test.ts per this codebase's one-small-copy-per-test-file
// convention). Only what this file needs.
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
}

type Route = (r: Recorded) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body };
    this.calls.push(rec);
    const res = this.route(rec);
    if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
    return res;
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

const DISCOVERY_ENHANCEMENTS_XML = fixture("discovery-enhancements.xml");

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, DISCOVERY_ENHANCEMENTS_XML, OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, OK_XML);
  return undefined;
}

async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(cfg(), {
    httpClient: adt,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const LOCK_LOCAL_XML_H =
  `<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">` +
  `<asx:values><DATA><LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/>` +
  `<CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/>` +
  `<MODIFICATION_SUPPORT>NoModification</MODIFICATION_SUPPORT><SCOPE_MESSAGES/></DATA></asx:values></asx:abap>`;

const gate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP"],
    allowEnhancements: true,
    enhanceTargets: "customer",
    originSystems: ["A4H"],
  });

const AFFECTS_SPOT = { name: "ZMCP_SPOT", packageName: "$TMP", masterSystem: "A4H", spotName: "ZMCP_SPOT" };

function fakePool(conn: AbapConnection): SessionPool {
  return {
    withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    withWrite: <T,>(_op: string, _objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    reserveDebug: () => {
      throw new Error("reserveDebug: not used by abap_enh, and not implemented in this fake.");
    },
  } as unknown as SessionPool;
}

function fakeMcp(): {
  mcp: McpServer;
  tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>;
} {
  const tools = new Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>();
  const mcp = {
    registerTool: (name: string, _config: Record<string, unknown>, handler: (args: unknown) => Promise<CallToolResult>) => {
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

async function registered(
  conn: AbapConnection,
  journal: Journal,
): Promise<Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>> {
  const { mcp, tools } = fakeMcp();
  const deps: EnhToolDeps = {
    pool: fakePool(conn),
    safety: gate(),
    ensureConnected: async () => {},
    errorResult,
    cfg: {
      maxResponseChars: 30_000,
      user: "DEVELOPER",
      allowEnhancements: true,
      allowSourcePlugins: false,
      allowEnhancementDelete: false,
      abapMode: undefined,
    },
    transport: localTransport(),
    journal,
  };
  registerEnhancementTools(mcp, deps);
  return tools;
}

/**
 * `set_filter_values`'s classrun bridge choreography — GET-404 -> POST-create
 * -> LOCK -> PUT source -> UNLOCK, generalized over an arbitrary collection +
 * object name. Same shape as `test/enh-system-key.test.ts`'s own
 * `createSpotBridgeRoute` / `test/enhancement-tools.test.ts`'s
 * `objectHappyPathRoute`, kept as its own copy per this file's header.
 */
const CLASS_COLLECTION = "/sap/bc/adt/oo/classes";
function objectHappyPathRoute(collectionUrl: string, objName: string): Route {
  const objUrl = `${collectionUrl}/${objName.toLowerCase()}`;
  const sourceUri = `${objUrl}/source/main`;
  return (r: Recorded) => {
    if (r.url === objUrl && r.method === "GET" && !r.qs._action) {
      const res = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
      throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, r as unknown as HttpClientOptions, res);
    }
    if (r.url === collectionUrl && r.method === "POST") return resp(200, "", {});
    if (r.url === objUrl && r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML_H, OK_XML);
    if (r.url === objUrl && r.qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (r.url === sourceUri && r.method === "PUT") return resp(200, "", { "content-type": "text/plain" });
    return undefined;
  };
}

/** The classrun execution response — `run.output` is parsed by `parseEnhancementTranscript`. */
function classrunRoute(tags: readonly string[]): Route {
  return (r: Recorded) => {
    if (r.url.startsWith("/sap/bc/adt/oo/classrun/")) return resp(200, tags.join("\n"), { "content-type": "text/plain" });
    return undefined;
  };
}

function combineRoutes(...routes: Route[]): Route {
  return (r: Recorded) => {
    for (const route of routes) {
      const hit = route(r);
      if (hit) return hit;
    }
    return undefined;
  };
}

/**
 * SYNTHETIC — hand-written in the shape `test/activate.test.ts`'s own
 * `ACTIVATION_ERRORS` documents as a live capture (200 + `chkl:messages`
 * `type="E"`, not an HTTP error status): SAP's activation endpoint reports
 * failure IN the 200 body, not via HTTP status.
 */
const ACTIVATION_ERROR_XML = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Enhancement spot ZMCP_SPOT" type="E" line="1"
       href="/sap/bc/adt/enhancements/enhsxs/zmcp_spot#start=1,0"
       forceSupported="true">
    <shortText><txt>Joint activation failed (synthetic, test double).</txt></shortText>
  </msg>
</chkl:messages>`;

const SET_FILTER_VALUES_ARGS = {
  operation: "set_filter_values",
  name: "ZMCP_ENH_BADI",
  spec: {
    spotName: "ZMCP_SPOT",
    implName: "ZMCP_IMPL",
    filterName: "FLT",
    filterType: "C",
    compare: "EQ",
    value: "X",
  },
  affects: AFFECTS_SPOT,
};

// ---------------------------------------------------------------------------
// Reading the PERSISTED bytes — no journal.list(), no readAll(). Every
// `begin()`/`finish()` call appends one JSONL line; later lines for the same
// id override earlier keys (the same rule src/journal.ts's own readAll()
// documents), reproduced independently here rather than delegated to it —
// that independence is the point of a behavioural test over the disk format.
// A sync variant exists too, for use FROM INSIDE the mocked `/activation`
// route itself (Test 2), where the FakeAdt call chain is synchronous.
// ---------------------------------------------------------------------------

function mergeLines(raw: string): Record<string, unknown>[] {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  const merged = new Map<string, Record<string, unknown>>();
  for (const line of lines) {
    const id = line.id;
    if (typeof id !== "string" || id === "") continue;
    merged.set(id, { ...(merged.get(id) ?? {}), ...line });
  }
  return [...merged.values()];
}

async function readPersistedEntries(dir: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(dir, "index.jsonl"), "utf8");
  return mergeLines(raw);
}

/** Sync twin of {@link readPersistedEntries} — see the block comment above. */
function readPersistedEntriesSync(dir: string): Record<string, unknown>[] {
  const raw = readFileSync(join(dir, "index.jsonl"), "utf8");
  return mergeLines(raw);
}

function findByTypeOp(
  entries: Record<string, unknown>[],
  type: string,
  operation: string,
): Record<string, unknown> | undefined {
  return entries.find((e) => {
    const obj = e.object as Record<string, unknown> | undefined;
    return e.operation === operation && obj?.type === type;
  });
}

// ===========================================================================

describe("set_filter_values's H23 joint activation journals BOTH objects, in order", () => {
  it("Test 1 — after a successful call, both the spot (ENHS/XS, activate, irreversible, systemKey) and the implementation (ENHO/XH, update) entries are on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abap-enh-joint-act-"));
    try {
      const journal = new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H");
      const { conn } = await connected(
        combineRoutes(
          objectHappyPathRoute(CLASS_COLLECTION, BRIDGE_CLASS.setFilterValues),
          classrunRoute(["IMPL-REPLACED"]),
          (r) => (r.url.includes("/sap/bc/adt/activation") ? resp(200, "", { "content-length": "0" }) : undefined),
        ),
      );
      const tools = await registered(conn, journal);

      okText(await invoke(tools, "abap_enh", SET_FILTER_VALUES_ARGS));

      const entries = await readPersistedEntries(dir);
      expect(entries).toHaveLength(2);

      const spotEntry = findByTypeOp(entries, "ENHS/XS", "activate");
      const implEntry = findByTypeOp(entries, "ENHO/XH", "update");
      expect(spotEntry, "spot's own ENHS/XS activate entry must exist").toBeTruthy();
      expect(implEntry, "implementation's own ENHO/XH update entry must exist").toBeTruthy();

      const spotObj = spotEntry!.object as Record<string, unknown>;
      expect(spotObj.name).toBe("ZMCP_SPOT");
      expect(spotEntry!.irreversible).toBe(true);

      // The trap `test/enh-system-key.test.ts` documents in full: journal.ts:1152
      // spreads `systemKey` in ONLY when truthy, so an empty string persists NO
      // `systemKey` KEY AT ALL. `"systemKey" in entry` — not mere truthiness — is
      // what would catch that regression at this call site.
      expect("systemKey" in spotEntry!).toBe(true);
      expect(spotEntry!.systemKey).toBeTypeOf("string");
      expect(spotEntry!.systemKey).not.toBe("");
      expect(spotEntry!.systemKey).toBe(systemKey(conn.cfg));

      const implObj = implEntry!.object as Record<string, unknown>;
      expect(implObj.name).toBe("ZMCP_ENH_BADI");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("Test 2 — the spot's entry is on disk BEFORE the joint POST goes out, not merely by the time the tool call returns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abap-enh-joint-act-order-"));
    try {
      const journal = new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H");

      let checkedAtPostTime: boolean | undefined;
      let activationRouteHit = false;

      const { conn } = await connected(
        combineRoutes(
          objectHappyPathRoute(CLASS_COLLECTION, BRIDGE_CLASS.setFilterValues),
          classrunRoute(["IMPL-REPLACED"]),
          (r) => {
            if (!r.url.includes("/sap/bc/adt/activation")) return undefined;
            activationRouteHit = true;
            // Synchronous, deliberately: FakeAdt.request calls `route()`
            // synchronously mid-`await`, so a `readFileSync` here observes
            // exactly what is on disk at the instant the wire POST fires —
            // no later, no earlier than the real filesystem state.
            const entries = readPersistedEntriesSync(dir);
            checkedAtPostTime = findByTypeOp(entries, "ENHS/XS", "activate") !== undefined;
            return resp(200, "", { "content-length": "0" });
          },
        ),
      );
      const tools = await registered(conn, journal);

      okText(await invoke(tools, "abap_enh", SET_FILTER_VALUES_ARGS));

      expect(activationRouteHit, "the mocked /sap/bc/adt/activation route must have fired").toBe(true);
      expect(
        checkedAtPostTime,
        "the spot's ENHS/XS activate entry must already be on disk at the moment the joint POST is issued",
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("Test 3 — a journal hook that throws aborts the joint activation: the wire POST is never issued, and no spot entry is left behind", async () => {
    // Fails ONLY on its SECOND call: call #1 is the outer (implementation,
    // operation:"update") entry — required to exist so the mutation can even
    // reach the H23 joint-activation step. Call #2 is the nested (spot,
    // operation:"activate") entry — the seam this fix added, and the one
    // this test targets. A real filesystem failure inside Journal.begin()
    // would behave identically; a plain thrown Error is simpler to construct
    // and sufficient here, since `withJournalledMutation`'s ordering
    // guarantee does not care WHY begin() threw.
    // Records which entry each begin() call was for, so "the SECOND call" is
    // asserted to be the spot's rather than merely assumed. Without this, a
    // future refactor that reordered or dropped one of the two begin() calls
    // would still see this test pass for the wrong reason.
    const beginOrder: string[] = [];

    class BeginFailsOnSecondCall extends Journal {
      private calls = 0;
      async begin(input: JournalBeginInput): Promise<JournalEntry | undefined> {
        this.calls += 1;
        beginOrder.push(`${input.operation} ${input.object.type}`);
        if (this.calls === 2) {
          throw new Error("simulated Journal.begin() failure (test double, Test 3)");
        }
        return super.begin(input);
      }
    }

    const dir = await mkdtemp(join(tmpdir(), "abap-enh-joint-act-abort-"));
    try {
      const cfgJ: JournalConfig = { dir, enabled: true, maxEntries: 200, maxAgeDays: 30 };
      const journal = new BeginFailsOnSecondCall(cfgJ, "A4H");

      let activationRouteHit = false;
      const { conn } = await connected(
        combineRoutes(
          objectHappyPathRoute(CLASS_COLLECTION, BRIDGE_CLASS.setFilterValues),
          classrunRoute(["IMPL-REPLACED"]),
          (r) => {
            if (!r.url.includes("/sap/bc/adt/activation")) return undefined;
            // NOT every POST to this URL is the H23 joint activation. The
            // generated bridge CLASS is written-and-activated through the very
            // same endpoint earlier in the choreography
            // (`writeActivateRunBridge`), and that one legitimately fires
            // before the spot's journal hook is ever reached. Matching on the
            // URL alone made this assertion fail against a CORRECT
            // implementation — the flag was set by the bridge class, not by
            // the call under test. Only the joint POST carries the spot's own
            // `ENHS/XS` reference (`spotUri` -> `.../enhancements/enhsxs/...`)
            // in its body, so that is what identifies it.
            if (r.body?.includes("enhsxs")) activationRouteHit = true;
            return resp(200, "", { "content-length": "0" });
          },
        ),
      );
      const tools = await registered(conn, journal);

      const result = await invoke(tools, "abap_enh", SET_FILTER_VALUES_ARGS);
      expect(result.isError).toBe(true);

      // The implementation's entry is begun first (outer wrapper), the spot's
      // second (nested wrapper, fired from the hook) — so the begin() this
      // double failed really is the spot's, and the POST it guards is the H23
      // joint activation.
      expect(beginOrder).toEqual(["update ENHO/XH", "activate ENHS/XS"]);

      expect(activationRouteHit, "the joint POST must NEVER be issued when its journal hook throws").toBe(false);

      const entries = await readPersistedEntries(dir);
      // Only the outer (implementation) entry exists — begin() threw before
      // the nested (spot) entry's blobs/index line ever landed, so there is
      // nothing on disk naming the spot at all.
      expect(findByTypeOp(entries, "ENHS/XS", "activate")).toBeUndefined();
      const implEntry = findByTypeOp(entries, "ENHO/XH", "update");
      expect(implEntry, "the outer implementation entry must still exist, settled failed").toBeTruthy();
      expect(implEntry!.outcome).toBe("failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("Test 5 — SAP rejecting the joint activation (200 + chkl:messages type=E) settles the SPOT's own entry to outcome:failed, not just the implementation's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abap-enh-joint-act-fail-"));
    try {
      const journal = new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H");
      const { conn } = await connected(
        combineRoutes(
          objectHappyPathRoute(CLASS_COLLECTION, BRIDGE_CLASS.setFilterValues),
          classrunRoute(["IMPL-REPLACED"]),
          // Poison ONLY the H23 joint activation, identified by the spot's own
          // `ENHS/XS` reference in the request body. The generated bridge CLASS
          // is activated through this same endpoint earlier; failing that one
          // too makes `setFilterValues` throw BEFORE H23 is ever reached, so
          // the spot's hook never fires and only the implementation's entry
          // exists — the test would then "fail" against a correct
          // implementation for a reason that has nothing to do with what it
          // claims to check.
          (r) => {
            if (!r.url.includes("/sap/bc/adt/activation")) return undefined;
            return r.body?.includes("enhsxs")
              ? resp(200, ACTIVATION_ERROR_XML, OK_XML)
              : resp(200, "", { "content-length": "0" });
          },
        ),
      );
      const tools = await registered(conn, journal);

      const result = await invoke(tools, "abap_enh", SET_FILTER_VALUES_ARGS);
      expect(result.isError).toBe(true);

      const entries = await readPersistedEntries(dir);
      expect(entries).toHaveLength(2);

      const spotEntry = findByTypeOp(entries, "ENHS/XS", "activate");
      const implEntry = findByTypeOp(entries, "ENHO/XH", "update");
      expect(spotEntry, "spot entry must exist even though activation failed — begin() ran before the POST").toBeTruthy();
      expect(implEntry).toBeTruthy();

      // The point of this test: the SPOT's own entry — not just the
      // implementation's — is the one that must carry the failure.
      expect(spotEntry!.outcome).toBe("failed");
      expect(implEntry!.outcome).toBe("failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
