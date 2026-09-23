/**
 * Issue #216: BOPF create/update/delete on a TRANSPORTABLE package (not just
 * `$TMP`-style local packages), through the tool layer (`runBopfEdit`/
 * `runBopfDelete`, `src/tools/bopf.ts`).
 *
 * Harness copied from `test/bopf-transport-gate.test.ts`: a real `bopf.ts`/
 * `tools/bopf.ts` driven against a `FakeAdtServer`, with `SessionTransport`'s
 * real resolution logic exercised by mocking only its `CtsClient` (`cts:
 * {trRequirement, trShow}`) — the same idiom `test/delete-corr-nr-honoured.test.ts`
 * uses, never a hand-wired `/sap/bc/adt/cts/transportchecks` HTTP route.
 *
 * Fake TRKORR values below are placeholders, not real transport numbers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  FakeAdtServer,
  __resetFakeAdtCounters,
  bopfStore,
  bopfLockTransportRoute,
  BOPF_COLLECTION_PATH,
  type FakeRoute,
} from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import type { SessionPool } from "../src/adt/pool.js";
import { SafetyGate } from "../src/safety.js";
import { runBopfEdit, runBopfDelete, type BopfRunDeps } from "../src/tools/bopf.js";

// ----------------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");
/** ZBOPF_PRB1, inactive, root-node-only, package $TMP in the real capture — see `withPackage`. */
const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");

/** Non-$ transportable package name used throughout this file. */
const PKG = "ZBOPF_PKG";

/** Substitutes the real capture's `<adtcore:packageRef/>` for a non-$ (or any) package — an honest patch of a real capture, not a fabrication. */
function withPackage(xml: string, packageName: string): string {
  return xml.replace(/<adtcore:packageRef[^>]*\/>/, `<adtcore:packageRef adtcore:type="DEVC/K" adtcore:name="${packageName}"/>`);
}

/**
 * Generalises `test/bopf-create-root-name.test.ts`'s `bodyWithRootNode` with
 * a package name. `rootName: ""` models an unnamed (unusable) root node;
 * omits `bo:constantsInterfaceRef` so no second cascade-delete route is needed.
 */
function bodyWithRootNode(name: string, packageName: string, rootName: string | undefined): string {
  const upper = name.toUpperCase();
  const nodesXml =
    rootName === undefined
      ? ""
      : `<bo:nodes bo:name="${rootName}" bo:nodeID="Um9vdA==" bo:xmlName="${rootName || "Root"}" ` +
        `bo:objectModelGenerated="false" bo:authorizationCheck="false" bo:isExtensible="false" ` +
        `bo:isDependentObjectNode="false" bo:textNode="false" bo:createEnabled="true" ` +
        `bo:updateEnabled="true" bo:deleteEnabled="true" bo:rootNode="true" bo:objectModelObsolete="false"/>`;
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<bo:businessObject xmlns:bo="http://www.sap.com/bopf/bo/BusinessObject" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${upper}" adtcore:type="BOBF" ` +
    `adtcore:version="inactive" adtcore:description="test fixture">` +
    `<adtcore:packageRef adtcore:name="${packageName}"/>` +
    nodesXml +
    `</bo:businessObject>`
  );
}

// ----------------------------------------------------------------------- harness ---

const systemRoleRoute: FakeRoute = (r) =>
  r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined;

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

const openConnections: AbapConnection[] = [];

beforeEach(() => {
  __resetFakeAdtCounters();
});

afterEach(() => {
  for (const conn of openConnections.splice(0)) conn.dispose();
});

async function wired(routes: readonly FakeRoute[] = []): Promise<{ conn: AbapConnection; server: FakeAdtServer }> {
  const server = new FakeAdtServer({ transportErrors: "throw", routes: [systemRoleRoute, ...routes] });
  const client = server.client("s1");
  const conn = new AbapConnection(cfg(), { httpClient: client, log: () => {}, breaker: new AuthCircuitBreaker() });
  openConnections.push(conn);
  await conn.connect();
  return { conn, server };
}

function fakePool(conn: AbapConnection): SessionPool {
  return {
    withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    withWrite: <T,>(_op: string, _objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    reserveDebug: () => {
      throw new Error("reserveDebug: not used by any BOPF tool, and not implemented in this fake.");
    },
  } as unknown as SessionPool;
}

function depsFor(conn: AbapConnection, safety: SafetyGate, transport: SessionTransport): BopfRunDeps {
  return {
    pool: fakePool(conn),
    safety,
    ensureConnected: async () => {},
    cfg: { maxResponseChars: 30_000 },
    transport,
  } as BopfRunDeps;
}

const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({
    uri: "",
    operation: "U",
    devclass: PKG,
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

/** A real `SessionTransport` that grants exactly `corrNr` to a caller who names it (Step 5, `#checkUsable` via `trShow`). */
function grantingTransport(corrNr: string): SessionTransport {
  return new SessionTransport({
    allowTransports: [corrNr],
    whoami: () => "DEVELOPER",
    cts: {
      trRequirement: vi.fn(async () => fakeReq({})),
      trShow: vi.fn(async () => ({
        trkorr: corrNr,
        kind: "workbench",
        kindRaw: "K",
        status: "modifiable",
        statusRaw: "D",
        owner: "DEVELOPER",
        description: "",
        tasks: [],
        objects: [],
      })),
    },
  });
}

/** A `$TMP`-shaped local package: `resolve()` is a no-HTTP `not-needed`. */
const localTransport = (): SessionTransport =>
  new SessionTransport({
    allowTransports: ["auto"],
    cts: { trRequirement: vi.fn(async () => fakeReq({ kind: "local" })) },
  });

function okText(result: CallToolResult): string {
  expect(result.isError).toBeFalsy();
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return text.text;
}

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

// ===========================================================================

describe("BOPF create/update/delete on a transportable package (issue #216)", () => {
  it("update on a transportable package: the PUT carries corrNr, response reports the transport", async () => {
    const corrNr = "ZTMK900555";
    const store = bopfStore({ zbopf_prb1: withPackage(FX_JUST_CREATED, PKG) });
    const { conn, server } = await wired([store.route]);
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: [corrNr] });
    const deps = depsFor(conn, gate, grantingTransport(corrNr));

    const result = await runBopfEdit(deps, {
      bo: "ZBOPF_PRB1",
      operation: "set_node_flags",
      node: "ROOT",
      spec: { updateEnabled: false },
      corr_nr: corrNr,
    });

    expect(okText(result)).toContain(`transport: ${corrNr}`);
    const puts = server.callsFor((r) => r.method === "PUT" && r.path.includes(BOPF_COLLECTION_PATH));
    expect(puts).toHaveLength(1);
    expect(puts[0]?.qs.corrNr).toBe(corrNr);
  });

  it("delete on a transportable package: the DELETE carries corrNr, response reports transport and boDeleted", async () => {
    const corrNr = "ZTMK900556";
    const store = bopfStore({ zbopf_prb1: withPackage(FX_JUST_CREATED, PKG) });
    const { conn, server } = await wired([store.route]);
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: [corrNr] });
    const deps = depsFor(conn, gate, grantingTransport(corrNr));

    const result = await runBopfDelete(deps, {
      bo: "ZBOPF_PRB1",
      dry_run: false,
      confirm: "ZBOPF_PRB1",
      corr_nr: corrNr,
    });

    const text = okText(result);
    expect(text).toContain(`transport: ${corrNr}`);
    expect(text).toContain("boDeleted: true");
    const deletes = server.callsFor((r) => r.method === "DELETE" && r.path.includes(BOPF_COLLECTION_PATH));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.qs.corrNr).toBe(corrNr);
  });

  it("a lock naming a different transport than the resolved one refuses the write, with zero PUT/DELETE", async () => {
    const authorized = "ZTMK900555";
    const lockHeld = "ZTMK900556";
    const store = bopfStore({ zbopf_prb1: withPackage(FX_JUST_CREATED, PKG) });
    const lockRoute = bopfLockTransportRoute({ name: "ZBOPF_PRB1", corrNr: lockHeld });
    const { conn, server } = await wired([lockRoute, store.route]);
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: [authorized] });
    const deps = depsFor(conn, gate, grantingTransport(authorized));

    const err = await catchErr(
      runBopfEdit(deps, {
        bo: "ZBOPF_PRB1",
        operation: "set_node_flags",
        node: "ROOT",
        spec: { updateEnabled: false },
        corr_nr: authorized,
      }),
    );

    expect(err.code).toBe("TRANSPORT_ERROR");
    expect(err.message).toContain(lockHeld);
    expect(server.callsFor((r) => r.method === "POST" && r.qs["_action"] === "LOCK")).toHaveLength(1);
    expect(server.callsFor((r) => r.method === "PUT" && r.path.includes(BOPF_COLLECTION_PATH))).toHaveLength(0);
    expect(server.callsFor((r) => r.method === "DELETE" && r.path.includes(BOPF_COLLECTION_PATH))).toHaveLength(0);
  });

  it("create_bo in a transportable package: the POST carries corrNr, response reports the transport", async () => {
    const corrNr = "ZTMK900555";
    const store = bopfStore();
    const { conn, server } = await wired([store.route]);
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: [corrNr] });
    const deps = depsFor(conn, gate, grantingTransport(corrNr));

    const result = await runBopfEdit(deps, {
      bo: "ZBOPF_NEW10",
      operation: "create_bo",
      package: PKG,
      corr_nr: corrNr,
    });

    expect(okText(result)).toContain(`transport: ${corrNr}`);
    const posts = server.callsFor((r) => r.method === "POST" && r.path === BOPF_COLLECTION_PATH);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.qs.corrNr).toBe(corrNr);
  });

  it("create_bo POST fails but a complete object is found on re-read: recovered, kept, with a warnings line naming the transport", async () => {
    const corrNr = "ZTMK900555";
    const name = "ZBOPF_NEW11";
    const store = bopfStore({ [name.toLowerCase()]: bodyWithRootNode(name, PKG, "ROOT") });
    store.failNextCreates(1);
    const { conn, server } = await wired([store.route]);
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: [corrNr] });
    const deps = depsFor(conn, gate, grantingTransport(corrNr));

    const result = await runBopfEdit(deps, {
      bo: name,
      operation: "create_bo",
      package: PKG,
      corr_nr: corrNr,
    });

    const text = okText(result);
    expect(text).toContain(`transport: ${corrNr}`);
    expect(text).toContain("warnings:");
    expect(text).toContain(`create POST failed but the object was found complete on re-read and kept (transport request ${corrNr})`);
    expect(server.callsFor((r) => r.method === "DELETE")).toHaveLength(0);
  });

  it("create_bo POST fails and re-read finds an unusable root node: a transportable package cleans up via DELETE, a local ($TMP) package does not", async () => {
    const corrNr = "ZTMK900555";

    const tName = "ZBOPF_NEW12";
    const tStore = bopfStore({ [tName.toLowerCase()]: bodyWithRootNode(tName, PKG, "") });
    tStore.failNextCreates(1);
    const { conn: tConn, server: tServer } = await wired([tStore.route]);
    const tGate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: [corrNr] });
    const tDeps = depsFor(tConn, tGate, grantingTransport(corrNr));

    const tErr = await catchErr(runBopfEdit(tDeps, { bo: tName, operation: "create_bo", package: PKG, corr_nr: corrNr }));
    expect(tErr.code).toBe("BOPF_CREATE_UNUSABLE");
    expect(tErr.details.partialCleanup).toMatchObject({ deleted: true });
    const tDeletes = tServer.callsFor((r) => r.method === "DELETE" && r.path.includes(BOPF_COLLECTION_PATH));
    expect(tDeletes).toHaveLength(1);
    expect(tDeletes[0]?.qs.corrNr).toBe(corrNr);

    const lName = "ZBOPF_NEW13";
    const lStore = bopfStore({ [lName.toLowerCase()]: bodyWithRootNode(lName, "$TMP", "") });
    lStore.failNextCreates(1);
    const { conn: lConn, server: lServer } = await wired([lStore.route]);
    const lGate = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
    const lDeps = depsFor(lConn, lGate, localTransport());

    const lErr = await catchErr(runBopfEdit(lDeps, { bo: lName, operation: "create_bo", package: "$TMP" }));
    expect(lErr.code).toBe("BOPF_CREATE_UNUSABLE");
    expect(lErr.details.partialCleanup).toBeUndefined();
    expect(lServer.callsFor((r) => r.method === "DELETE" && r.path.includes(BOPF_COLLECTION_PATH))).toHaveLength(0);
  });

  it("a deny-all allowTransports refuses create, update and delete in a transportable package, with zero POST/PUT/DELETE/LOCK", async () => {
    const store = bopfStore({ zbopf_prb1: withPackage(FX_JUST_CREATED, PKG) });
    const { conn, server } = await wired([store.route]);
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: [] });
    const deps = depsFor(conn, gate, grantingTransport("ZTMK900999"));

    const createErr = await catchErr(runBopfEdit(deps, { bo: "ZBOPF_NEW14", operation: "create_bo", package: PKG }));
    const updateErr = await catchErr(
      runBopfEdit(deps, { bo: "ZBOPF_PRB1", operation: "set_node_flags", node: "ROOT", spec: { updateEnabled: false } }),
    );
    const deleteErr = await catchErr(runBopfDelete(deps, { bo: "ZBOPF_PRB1", dry_run: false, confirm: "ZBOPF_PRB1" }));

    for (const err of [createErr, updateErr, deleteErr]) {
      expect(err.code).toBe("SAFETY_DENIED");
      expect(err.details.rule).toBe("transport allowlist (fail closed)");
    }
    expect(server.callsFor((r) => r.method === "POST" && r.path === BOPF_COLLECTION_PATH)).toHaveLength(0);
    expect(server.callsFor((r) => r.method === "PUT")).toHaveLength(0);
    expect(server.callsFor((r) => r.method === "DELETE")).toHaveLength(0);
    expect(server.callsFor((r) => r.qs["_action"] === "LOCK")).toHaveLength(0);
  });
});
