/**
 * Acceptance tests for `createBusinessObject`'s `rootNodeCheck`
 * (`src/adt/bopf.ts`) — the requested-vs-actual root node name comparison run
 * on EVERY create return path, clean or `recovered: true`.
 *
 * Harness idiom copied from `test/bopf-client.test.ts`: a real `bopf.ts`
 * driven against a `FakeAdtServer` session, only the HTTP socket faked.
 * `bopfStore(seed)`'s create route never overwrites an already-seeded entry
 * (`test/helpers/fake-adt.ts`), which is what lets these tests dictate
 * exactly what the post-create re-read sees — including shapes
 * `defaultBopfCreateBody` (no root node at all) can't produce.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAdtServer, __resetFakeAdtCounters, bopfStore, type FakeRoute } from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import { SafetyGate } from "../src/safety.js";
import { createBusinessObject } from "../src/adt/bopf.js";

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

async function wired(options: { routes?: readonly FakeRoute[] } = {}): Promise<{ conn: AbapConnection }> {
  const server = new FakeAdtServer({ transportErrors: "throw", routes: [systemRoleRoute, ...(options.routes ?? [])] });
  const client = server.client("s1");
  const conn = new AbapConnection(cfg(), { httpClient: client, log: () => {}, breaker: new AuthCircuitBreaker() });
  openConnections.push(conn);
  await conn.connect();
  return { conn };
}

const openGate = (): SafetyGate => new SafetyGate({ readOnly: false, allowPackages: ["*"] });

/** Mints a fresh `AuthorizedTarget<"write">` — package defaults to `$TMP` to match this file's fixtures. */
const authWrite = (name: string, packageName = "$TMP") => openGate().authorize("write", { name, packageName, type: "BOBF" });

const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({ kind: "local", required: false, mustSupplyCorrNr: false, serverWouldFabricate: false, ...overrides }) as unknown as TrRequirement;

/** A `$TMP`-shaped local package: `resolve()` is a no-HTTP `not-needed`. */
const localTransport = (): SessionTransport =>
  new SessionTransport({ allowTransports: ["auto"], cts: { trRequirement: vi.fn(async () => fakeReq()) } });

// --------------------------------------------------------------------- fixtures ---

/**
 * A minimal `bo:businessObject` create-response body carrying at most one
 * root `bo:nodes` element, `rootName` substituted verbatim into `bo:name`.
 * `rootName: undefined` omits `bo:nodes` entirely — models a model with no
 * root node at all. File-local; `test/bopf-create-recovery.test.ts` has its
 * own equivalent, not shared.
 */
function bodyWithRootNode(name: string, rootName: string | undefined): string {
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
    `<adtcore:packageRef adtcore:name="$TMP"/>` +
    nodesXml +
    `</bo:businessObject>`
  );
}

// ===========================================================================

describe("createBusinessObject: rootNodeCheck", () => {
  it("clean create, root node named exactly as requested — matches: true", async () => {
    const store = bopfStore({ zbopf_t1: bodyWithRootNode("ZBOPF_T1", "ITEM") });
    const { conn } = await wired({ routes: [store.route] });

    const result = await createBusinessObject(
      conn,
      localTransport(),
      { name: "ZBOPF_T1", packageName: "$TMP", rootNodeName: "ITEM" },
      authWrite("ZBOPF_T1"),
    );

    expect(result.recovered).toBeFalsy();
    expect(result.rootNodeCheck).toEqual({ requested: "ITEM", actual: "ITEM", matches: true });
  });

  it("clean create, root node named something else — matches: false, compared on the non-recovery path too", async () => {
    const store = bopfStore({ zbopf_t2: bodyWithRootNode("ZBOPF_T2", "HEADER") });
    const { conn } = await wired({ routes: [store.route] });

    const result = await createBusinessObject(
      conn,
      localTransport(),
      { name: "ZBOPF_T2", packageName: "$TMP", rootNodeName: "ITEM" },
      authWrite("ZBOPF_T2"),
    );

    expect(result.recovered).toBeFalsy();
    expect(result.rootNodeCheck).toEqual({ requested: "ITEM", actual: "HEADER", matches: false });
  });

  it("SESSION_DEAD-style recovery: the landed root node came back unnamed (bo:name=\"\") — recovered: true, matches: false", async () => {
    const store = bopfStore({ zbopf_t3: bodyWithRootNode("ZBOPF_T3", "") });
    store.failNextCreates(1);
    const { conn } = await wired({ routes: [store.route] });

    const result = await createBusinessObject(
      conn,
      localTransport(),
      { name: "ZBOPF_T3", packageName: "$TMP", rootNodeName: "ITEM" },
      authWrite("ZBOPF_T3"),
    );

    expect(result.recovered).toBe(true);
    expect(result.rootNodeCheck.actual).toBe("");
    expect(result.rootNodeCheck.matches).toBe(false);
  });

  it("recovery path, no false positive: the landed root node IS named as requested — recovered: true, matches: true", async () => {
    const store = bopfStore({ zbopf_t4: bodyWithRootNode("ZBOPF_T4", "ITEM") });
    store.failNextCreates(1);
    const { conn } = await wired({ routes: [store.route] });

    const result = await createBusinessObject(
      conn,
      localTransport(),
      { name: "ZBOPF_T4", packageName: "$TMP", rootNodeName: "ITEM" },
      authWrite("ZBOPF_T4"),
    );

    expect(result.recovered).toBe(true);
    expect(result.rootNodeCheck.matches).toBe(true);
  });

  it("a model with no root node at all — actual: undefined, matches: false", async () => {
    const store = bopfStore({ zbopf_t5: bodyWithRootNode("ZBOPF_T5", undefined) });
    const { conn } = await wired({ routes: [store.route] });

    const result = await createBusinessObject(
      conn,
      localTransport(),
      { name: "ZBOPF_T5", packageName: "$TMP", rootNodeName: "ITEM" },
      authWrite("ZBOPF_T5"),
    );

    expect(result.rootNodeCheck.actual).toBeUndefined();
    expect(result.rootNodeCheck.matches).toBe(false);
  });

  it("case-insensitive match and the ROOT default: no rootNodeName requested, root actually named lowercase \"root\"", async () => {
    const store = bopfStore({ zbopf_t6: bodyWithRootNode("ZBOPF_T6", "root") });
    const { conn } = await wired({ routes: [store.route] });

    const result = await createBusinessObject(
      conn,
      localTransport(),
      { name: "ZBOPF_T6", packageName: "$TMP" },
      authWrite("ZBOPF_T6"),
    );

    expect(result.rootNodeCheck.requested).toBe("ROOT");
    expect(result.rootNodeCheck.actual).toBe("root");
    expect(result.rootNodeCheck.matches).toBe(true);
  });
});
