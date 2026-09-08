/**
 * Regression test for the preflight/deploy package disagreement fixed in this
 * slice: `deployBridge` (src/adt/run.ts) has always deployed abapsmith's own
 * bridge classes into `FLUID_PACKAGE`, but the zero-network preflight in
 * ui.ts/fpm.ts/bopf-test.ts asserted a hardcoded `packageName: "$TMP"` — so a
 * gate that allowed the real target package still got refused at preflight,
 * and a gate that allowed only `$TMP` passed preflight for a write that would
 * never actually land there.
 *
 * Three things are proven, one per family (abap_ui screen, abap_fpm_read
 * find, abap_fpm_read locks, abap_bopf_test):
 *
 * (a) the TOOL-layer preflight now agrees with the real target: a gate
 *     allowing only FLUID_PACKAGE clears preflight (proven by reaching
 *     `ensureConnected`, made to throw a private marker so no network call is
 *     ever needed), while a gate allowing only "$TMP" is refused before
 *     `ensureConnected` runs, naming $ABAPSMITH_FLUID_API — not $TMP.
 * (b) `caller: {tool, action}` reaches `deployBridge` for each family, proven
 *     by driving the ADT-layer function directly on a `fluidApi: false`
 *     connection (fluidDisabledReason short-circuits deployBridge before any
 *     authorization/wire I/O — see src/adt/fluid/enabled.ts) and reading the
 *     FLUID_API_DISABLED error's details.tool/details.action.
 * (c) no `packageName: "$TMP"` literal remains near any `deps.safety.assert(
 *     "write"` preflight call in the three tool files.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { isAbapError } from "../src/adt/errors.js";
import { FLUID_PACKAGE } from "../src/adt/fluid/package.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import type { SessionPool } from "../src/adt/pool.js";
import type { Journal } from "../src/journal.js";
import { runUiTool, type UiToolDeps } from "../src/tools/ui.js";
import { runFpmReadTool, type FpmToolDeps } from "../src/tools/fpm.js";
import { runBopfTest as runBopfTestTool, type BopfTestDeps } from "../src/tools/bopf-test.js";
import { runUiBridge } from "../src/adt/ui-runtime.js";
import { runFpmRead } from "../src/adt/fpm-runtime.js";
import { runFpmLockInspect, type FpmLockInspectQuery } from "../src/adt/fpm-lock.js";
import { runBopfTest as runBopfTestBridge, type BoModel, type BopfTestScenario } from "../src/adt/bopf-runtime.js";
import type { AdtObjectRef, BoAssociation, BoNode } from "../src/adt/bopf-types.js";

// ---------------------------------------------------------------------------
// Fixtures — self-contained per this repo's convention (see
// bopf-runtime.test.ts's own header comment on why it doesn't share one).
// ---------------------------------------------------------------------------

const cfg = (over: Partial<Config> = {}): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    readOnly: false,
    ...over,
  });

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
  statusText = String(status),
): HttpClientResponse => ({ status, statusText, body, headers }) as unknown as HttpClientResponse;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

const SESSION_URL = "/sap/bc/adt/compatibility/graph";

/** Only what `conn.connect()` needs — the system-role probe is answered by `routeSystemRoleProbe` before this ever runs. */
function loginOnlyRoute(o: HttpClientOptions): HttpClientResponse {
  if (o.url.includes(SESSION_URL)) {
    return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
  }
  if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
  return resp(200, "<ok/>", { "content-type": "application/xml" });
}

/**
 * A connection whose ONLY route to FLUID_API_DISABLED is `cfg.fluidApi ===
 * false` (checked first, before the productive/systemRole/writesLockedOut
 * branches — see fluidDisabledReason). `routeSystemRoleProbe` answers the
 * probe deterministically so connect() itself never falls back to the
 * fail-closed lockout (that would also produce a refusal, but for the wrong
 * reason — see this helper's own doc comment).
 */
async function disabledConnection(): Promise<AbapConnection> {
  const inner = new RecordingClient(loginOnlyRoute);
  const client = routeSystemRoleProbe(inner, { answer: "nonproductive" });
  const conn = new AbapConnection(cfg({ fluidApi: false }), {
    httpClient: client,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  return conn;
}

const allowingGate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: [FLUID_PACKAGE], writesLockedOut: false });

type Mut<T> = { -readonly [K in keyof T]: T[K] };

const ref = (type: string, name: string): AdtObjectRef => ({ type, name });

function makeAssociation(over: Partial<BoAssociation> & { name: string }): Mut<BoAssociation> {
  return { ...over };
}

function makeNode(over: Partial<BoNode> & { name: string; rootNode: boolean }): Mut<BoNode> & { associations: Mut<BoAssociation>[] } {
  return {
    xmlName: undefined,
    doEmbeddingName: undefined,
    parentNodeId: undefined,
    parent: undefined,
    nodeId: undefined,
    textNode: false,
    isDependentObjectNode: false,
    createEnabled: true,
    updateEnabled: true,
    deleteEnabled: true,
    authorizationCheck: false,
    isExtensible: false,
    objectModelGenerated: false,
    objectModelObsolete: false,
    properties: [],
    alternativeKeys: [],
    queries: [],
    actions: [],
    determinations: [],
    validations: [],
    associations: [],
    ...over,
  };
}

const MODEL: BoModel = {
  name: "ZBOPF_ORDER",
  type: "BOBF",
  version: "active",
  constantsInterfaceRef: ref("BOPF/CI", "ZIF_BOPF_ORDER_C"),
  nodes: [
    makeNode({
      name: "ROOT",
      rootNode: true,
      persistentStructureRef: ref("DDLS/DF", "ZBOPF_S_ORDER_ROOT"),
      persistentTableRef: ref("TABL/DT", "ZBOPF_D_ORDER_ROOT"),
      associations: [makeAssociation({ name: "ITEMS", targetNodeRef: ref("BOPF/NODE", "ITEM") })],
    }),
    makeNode({
      name: "ITEM",
      rootNode: false,
      persistentStructureRef: ref("DDLS/DF", "ZBOPF_S_ORDER_ITEM"),
      persistentTableRef: ref("TABL/DT", "ZBOPF_D_ORDER_ITEM"),
    }),
  ],
};

const SCENARIO: BopfTestScenario = {
  nodes: [
    { node: "ROOT", fields: { ORDER_ID: "MCP0001", SALES_ORG: "MCP" } },
    { node: "ITEM", parentNode: "ROOT", fields: { ITEM_NO: "0010" } },
  ],
};

// ---------------------------------------------------------------------------
// Part (a) — TOOL-layer zero-network preflight now agrees with the real target.
// ---------------------------------------------------------------------------

/** Thrown by a stub `ensureConnected` — proves preflight passed without any network round trip. */
class PastPreflightMarker extends Error {
  constructor() {
    super("past preflight — ensureConnected was reached");
  }
}

const gateAllowing = (pkg: string): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: [pkg], writesLockedOut: false });

const unreachablePool = {} as unknown as SessionPool;
const unreachableJournal = {} as unknown as Journal;

async function assertPassesPreflight(run: () => Promise<unknown>): Promise<void> {
  const err = await run().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(PastPreflightMarker);
}

async function assertRefusedForPackage(run: () => Promise<unknown>): Promise<void> {
  const err = await run().catch((e: unknown) => e);
  expect(isAbapError(err)).toBe(true);
  if (!isAbapError(err)) return;
  expect(err.code).toBe("SAFETY_DENIED");
  expect(err.details.package).toBe(FLUID_PACKAGE);
  expect(err.message).toContain(FLUID_PACKAGE);
  expect(err.message).not.toContain("$TMP is not in the allowlist");
}

describe("tool-layer preflight agrees with deployBridge's real target package", () => {
  it("abap_ui screen", async () => {
    const deps = (gate: SafetyGate): UiToolDeps => ({
      pool: unreachablePool,
      safety: gate,
      journal: unreachableJournal,
      ensureConnected: async () => {
        throw new PastPreflightMarker();
      },
      errorResult: (e) => {
        throw e;
      },
      cfg: { maxResponseChars: 30_000, abapMode: undefined, sid: "TST", url: "http://sap.invalid", client: "001", allowUiPress: false },
    });
    const input = { mode: "screen", tcode: "SE80" };

    await assertPassesPreflight(() => runUiTool(deps(gateAllowing(FLUID_PACKAGE)), input));
    await assertRefusedForPackage(() => runUiTool(deps(gateAllowing("$TMP")), input));
  });

  it("abap_fpm_read find", async () => {
    const deps = (gate: SafetyGate): FpmToolDeps => ({
      pool: unreachablePool,
      safety: gate,
      ensureConnected: async () => {
        throw new PastPreflightMarker();
      },
      errorResult: (e) => {
        throw e;
      },
      cfg: { maxResponseChars: 30_000 },
    });
    const input = { mode: "find" };

    await assertPassesPreflight(() => runFpmReadTool(deps(gateAllowing(FLUID_PACKAGE)), input));
    await assertRefusedForPackage(() => runFpmReadTool(deps(gateAllowing("$TMP")), input));
  });

  it("abap_fpm_read locks", async () => {
    const deps = (gate: SafetyGate): FpmToolDeps => ({
      pool: unreachablePool,
      safety: gate,
      ensureConnected: async () => {
        throw new PastPreflightMarker();
      },
      errorResult: (e) => {
        throw e;
      },
      cfg: { maxResponseChars: 30_000 },
    });
    const input = { mode: "locks", config_id: "ZTEST_CFG" };

    await assertPassesPreflight(() => runFpmReadTool(deps(gateAllowing(FLUID_PACKAGE)), input));
    await assertRefusedForPackage(() => runFpmReadTool(deps(gateAllowing("$TMP")), input));
  });

  it("abap_bopf_test", async () => {
    const deps = (gate: SafetyGate): BopfTestDeps => ({
      pool: unreachablePool,
      safety: gate,
      ensureConnected: async () => {
        throw new PastPreflightMarker();
      },
      errorResult: (e) => {
        throw e;
      },
      cfg: { maxResponseChars: 30_000 },
      readModel: async () => {
        throw new Error("readModel: should not be reached — preflight refuses/passes before any network call");
      },
    });
    const input = {
      bo: "ZBOPF_TEST",
      scenario: { nodes: [{ node: "ROOT", fields: {} }] },
      generate_only: true,
    };

    await assertPassesPreflight(() => runBopfTestTool(deps(gateAllowing(FLUID_PACKAGE)), input));
    await assertRefusedForPackage(() => runBopfTestTool(deps(gateAllowing("$TMP")), input));
  });
});

// ---------------------------------------------------------------------------
// Part (b) — caller context reaches deployBridge, per family.
// ---------------------------------------------------------------------------

async function assertCallerReachesDeployBridge(
  run: () => Promise<unknown>,
  expected: { tool: string; action: string },
): Promise<void> {
  const err = await run().catch((e: unknown) => e);
  expect(isAbapError(err)).toBe(true);
  if (!isAbapError(err)) return;
  expect(err.code).toBe("FLUID_API_DISABLED");
  expect(err.details.tool).toBe(expected.tool);
  expect(err.details.action).toBe(expected.action);
  expect(err.message).toContain(`${expected.tool} ${expected.action}`);
}

describe("caller context reaches deployBridge", () => {
  it("abap_ui screen -> {tool: abap_ui, action: screen}", async () => {
    const conn = await disabledConnection();
    await assertCallerReachesDeployBridge(
      () => runUiBridge(conn, { mode: "screen", target: { by: "tcode", tcode: "SE80" } }, allowingGate()),
      { tool: "abap_ui", action: "screen" },
    );
  });

  it("abap_fpm_read find -> {tool: abap_fpm_read, action: find}", async () => {
    const conn = await disabledConnection();
    await assertCallerReachesDeployBridge(
      () => runFpmRead(conn, { mode: "find", configType: "00" }, allowingGate()),
      { tool: "abap_fpm_read", action: "find" },
    );
  });

  it("abap_fpm_read locks -> {tool: abap_fpm_read, action: locks}", async () => {
    const conn = await disabledConnection();
    const query: FpmLockInspectQuery = { mode: "locks", configId: "ZTEST_CFG" };
    await assertCallerReachesDeployBridge(() => runFpmLockInspect(conn, query, allowingGate()), {
      tool: "abap_fpm_read",
      action: "locks",
    });
  });

  it("abap_bopf_test -> {tool: abap_bopf_test, action: run_test}", async () => {
    const conn = await disabledConnection();
    await assertCallerReachesDeployBridge(() => runBopfTestBridge(conn, MODEL, SCENARIO, allowingGate()), {
      tool: "abap_bopf_test",
      action: "run_test",
    });
  });
});

// ---------------------------------------------------------------------------
// Part (c) — no stale "$TMP" literal survives next to a write preflight.
// ---------------------------------------------------------------------------

const TOOL_FILES = ["ui.ts", "fpm.ts", "bopf-test.ts"] as const;
const SRC_TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tools");

/**
 * Character-window guard, not a parser: finds every `deps.safety.assert(`
 * call whose next argument (allowing the "write"/{...} split across lines,
 * as fpm.ts and bopf-test.ts both do) is the literal `"write"`, then checks
 * the 300 chars after it — comfortably past the `{ name, packageName, type }`
 * target object — for a `"$TMP"` literal. Cheap and honest about what it
 * proves: it would not catch a `$TMP` reintroduced far from the assert call,
 * but that shape has no reason to exist, and matches exactly the shape the
 * bug had (the literal sat inside the assert call's own target object).
 */
function writePreflightWindows(src: string): string[] {
  const windows: string[] = [];
  const re = /deps\.safety\.assert\(\s*"write"/g;
  for (const m of src.matchAll(re)) {
    const start = m.index ?? 0;
    windows.push(src.slice(start, start + 300));
  }
  return windows;
}

describe("no stale $TMP literal survives at a write preflight", () => {
  it.each(TOOL_FILES)("%s", (file) => {
    const src = readFileSync(join(SRC_TOOLS_DIR, file), "utf8");
    const windows = writePreflightWindows(src);
    // Guards the guard: fails loudly if the file's preflight shape changes
    // enough that this test stops finding any write-preflight call at all.
    expect(windows.length).toBeGreaterThan(0);
    for (const window of windows) {
      expect(window).not.toContain('"$TMP"');
      // The source identifier, not the runtime string value — these files
      // reference the imported FLUID_PACKAGE constant, not its literal.
      expect(window).toContain("FLUID_PACKAGE");
    }
  });
});
