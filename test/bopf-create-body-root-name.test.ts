/**
 * Pins for the invariant that actually protects the generated constants
 * interface: `POST /sap/bc/adt/bopf/businessobjects` (`createBusinessObject`,
 * `src/adt/bopf.ts`) is the SINGLE moment the server derives `Z*_C` from the
 * root node name, and it never regenerates it afterward. So the create body
 * built by `buildCreateBody` must never carry an empty `bo:name` on its root
 * `bo:nodes` element, and no recovery path may re-send that body.
 *
 * Harness idiom copied from `test/bopf-create-root-name.test.ts`: a real
 * `bopf.ts` driven against a `FakeAdtServer` session, only the HTTP socket
 * faked. These tests read `server.calls` directly rather than only
 * inspecting `createBusinessObject`'s return value, since the invariant is
 * about what went out on the wire, once, not about what came back.
 *
 * Expected to PASS unmodified — by-construction pins, not red-proof tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAdtServer, __resetFakeAdtCounters, bopfStore, BOPF_COLLECTION_PATH, type FakeRoute } from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import { SafetyGate } from "../src/safety.js";
import { createBusinessObject, effectiveRootNodeName } from "../src/adt/bopf.js";

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

async function wired(options: { routes?: readonly FakeRoute[] } = {}): Promise<{ conn: AbapConnection; server: FakeAdtServer }> {
  const server = new FakeAdtServer({ transportErrors: "throw", routes: [systemRoleRoute, ...(options.routes ?? [])] });
  const client = server.client("s1");
  const conn = new AbapConnection(cfg(), { httpClient: client, log: () => {}, breaker: new AuthCircuitBreaker() });
  openConnections.push(conn);
  await conn.connect();
  return { conn, server };
}

const openGate = (): SafetyGate => new SafetyGate({ readOnly: false, allowPackages: ["*"] });

/** Mints a fresh `AuthorizedTarget<"write">` — package defaults to `$TMP` to match this file's fixtures. */
const authWrite = (name: string, packageName = "$TMP") => openGate().authorize("write", { name, packageName, type: "BOBF" });

const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({ kind: "local", required: false, mustSupplyCorrNr: false, serverWouldFabricate: false, ...overrides }) as unknown as TrRequirement;

/** A `$TMP`-shaped local package: `resolve()` is a no-HTTP `not-needed`. */
const localTransport = (): SessionTransport =>
  new SessionTransport({ allowTransports: ["auto"], cts: { trRequirement: vi.fn(async () => fakeReq()) } });

// ===========================================================================

describe("createBusinessObject: create body always names the root node", () => {
  const cases: ReadonlyArray<{ name: string; rootNodeName?: string; expected: string; label: string }> = [
    { name: "ZBOPF_RN1", rootNodeName: undefined, expected: "ROOT", label: "omitted -> ROOT" },
    { name: "ZBOPF_RN2", rootNodeName: "ITEM", expected: "ITEM", label: '"ITEM" -> ITEM' },
    { name: "ZBOPF_RN3", rootNodeName: "", expected: "ROOT", label: '"" -> ROOT' },
    { name: "ZBOPF_RN4", rootNodeName: "   ", expected: "ROOT", label: '"   " -> ROOT' },
    { name: "ZBOPF_RN5", rootNodeName: "  item  ", expected: "item", label: '"  item  " -> item (trimmed verbatim, not upper-cased)' },
  ];

  it.each(cases)("$label", async ({ name, rootNodeName, expected }) => {
    const store = bopfStore();
    const { conn, server } = await wired({ routes: [store.route] });

    await createBusinessObject(conn, localTransport(), { name, packageName: "$TMP", rootNodeName }, authWrite(name));

    const posts = server.calls.filter((c) => c.method === "POST" && c.path === BOPF_COLLECTION_PATH);
    expect(posts.length).toBe(1);
    const body = posts[0]?.body ?? "";

    const nameMatch = /bo:name="([^"]*)"/.exec(body);
    const xmlNameMatch = /bo:xmlName="([^"]*)"/.exec(body);
    expect(nameMatch?.[1]).toBe(expected);
    expect(xmlNameMatch?.[1]).toBe(expected);
    expect(body).not.toContain('bo:name=""');
  });
});

describe("effectiveRootNodeName: never yields an empty string", () => {
  const cases: ReadonlyArray<{ input?: string; expected: string; label: string }> = [
    { input: undefined, expected: "ROOT", label: "undefined -> ROOT" },
    { input: "", expected: "ROOT", label: '"" -> ROOT' },
    { input: "   ", expected: "ROOT", label: '"   " -> ROOT' },
    { input: "\t\n", expected: "ROOT", label: '"\\t\\n" -> ROOT' },
    { input: "ITEM", expected: "ITEM", label: '"ITEM" -> ITEM' },
    { input: " item ", expected: "item", label: '" item " -> item' },
  ];

  it.each(cases)("$label", ({ input, expected }) => {
    const result = effectiveRootNodeName({ name: "ZBOPF_X", packageName: "$TMP", rootNodeName: input });
    expect(result).toBe(expected);
    expect(result).not.toBe("");
  });
});

describe("createBusinessObject: non-atomic-create recovery never re-sends the body", () => {
  it("failNextCreates(1), object lands: exactly one POST to the collection, followed by a GET on the entry", async () => {
    const store = bopfStore();
    store.failNextCreates(1);
    const { conn, server } = await wired({ routes: [store.route] });

    const result = await createBusinessObject(
      conn,
      localTransport(),
      { name: "ZBOPF_RC1", packageName: "$TMP", rootNodeName: "ITEM" },
      authWrite("ZBOPF_RC1"),
    );

    expect(result.recovered).toBe(true);

    const posts = server.calls.filter((c) => c.method === "POST" && c.path === BOPF_COLLECTION_PATH);
    expect(posts.length).toBe(1);

    const post = posts[0];
    const postIndex = server.calls.findIndex((c) => c.seq === post?.seq);
    const next = server.calls[postIndex + 1];
    expect(next).toBeDefined();
    expect(next?.method).toBe("GET");
    expect(next?.path).toBe(`${BOPF_COLLECTION_PATH}/zbopf_rc1`);
  });
});

describe("createBusinessObject: the named element is the root node", () => {
  it("the create POST's bo:nodes element carries bo:rootNode=\"true\" alongside the non-empty bo:name", async () => {
    const store = bopfStore();
    const { conn, server } = await wired({ routes: [store.route] });

    await createBusinessObject(conn, localTransport(), { name: "ZBOPF_RN6", packageName: "$TMP" }, authWrite("ZBOPF_RN6"));

    const posts = server.calls.filter((c) => c.method === "POST" && c.path === BOPF_COLLECTION_PATH);
    expect(posts.length).toBe(1);
    const body = posts[0]?.body ?? "";

    const nodeMatch = /<bo:nodes\b[^>]*\/>/.exec(body);
    expect(nodeMatch).not.toBeNull();
    const node = nodeMatch?.[0] ?? "";
    expect(node).toContain('bo:name="ROOT"');
    expect(node).toContain('bo:rootNode="true"');
  });
});
