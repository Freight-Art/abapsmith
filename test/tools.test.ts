/**
 * Tool surface + safety gate wiring.
 *
 * The headline test is "a refused write puts ZERO requests on the wire". The
 * gate is asserted in `server.ts` *before* `ensureConnected()`, and connecting
 * is itself a network call, so proving the refusal is cheap means proving the
 * injected transport was never touched — not merely that the tool returned an
 * error.
 *
 * Everything here is offline. `src/adt/{write,activate,run}.ts` are still
 * contract stubs (`declare function`, no runtime export), so those modules are
 * mocked; what is under test is the wiring above them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigSchema, loadConfig, redactConfigSecrets, type Config } from "../src/config.js";
import { createServer, type AbapsmithServer } from "../src/server.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { abapActivate } from "../src/tools/activate.js";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapError } from "../src/adt/errors.js";
import type { SessionTransport } from "../src/adt/session-transport.js";
import type { SafetyGate } from "../src/safety.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { NON_READABLE_TYPES, NON_WRITABLE_TYPES } from "../src/adt/capabilities.js";

const adt = vi.hoisted(() => ({
  resolveObject: vi.fn(),
  resolveWriteTarget: vi.fn(),
  writeObject: vi.fn(),
  deleteObject: vi.fn(),
  /**
   * `src/tools/{write,activate}.ts` resolve and gate in ONE step now, so the
   * fake has to do both or the gate never runs: resolve through the same
   * `resolveWriteTarget` fake these tests already program, then assert on the
   * object's REAL package.
   */
  authorizeMutation: vi.fn(
    async (
      conn: unknown,
      gate: { assert: (op: string, obj: unknown) => void },
      op: string,
      target: unknown,
    ) => {
      const t = (await adt.resolveWriteTarget(conn, target)) as {
        name: string;
        packageName: string;
        type: string;
        superPackage?: string;
        exists?: boolean;
      };
      // The REAL `authorizeMutation` (src/adt/write.ts) hands the gate the
      // FULL resolved target — no narrowing `Pick` — relying on the same
      // structural-typing passthrough this fake mirrors here: `superPackage`/
      // `exists` must reach the gate for a `DEVC/K` create, or this fake would
      // silently retest the old, already-fixed bug (a package create judged
      // on `packageName` alone) instead of the real wiring.
      gate.assert(op, {
        name: t.name,
        packageName: t.packageName,
        type: t.type,
        ...(t.superPackage !== undefined ? { superPackage: t.superPackage } : {}),
        ...(t.exists !== undefined ? { exists: t.exists } : {}),
      });
      // Real `authorizeMutation` (src/adt/write.ts) mints an `AuthorizedTarget`
      // wrapper — `{ op, target }` — not the bare resolved object.
      // `src/tools/write.ts` only ever forwards this opaquely to
      // `writeObject`/`deleteObject`/`createPackage` (also faked here), but
      // `src/tools/activate.ts` is REAL, unmocked code that reads `.target` off
      // the result directly — a bare `t` here made it crash with "Cannot read
      // properties of undefined (reading 'exists')" instead of exercising the
      // path under test.
      return { op, target: t };
    },
  ),
  /**
   * Pure predicate, so the fake is the REAL implementation rather than a
   * canned answer — mocking it to a constant would let the routing tests
   * pass while the real predicate disagreed.
   */
  isPackageType: vi.fn((type?: string) => type === "DEVC/K"),
  createPackage: vi.fn(),
  /**
   * `DEVC/K` creation is split in two: `createPackage` stays the REST
   * route for `software_component: "LOCAL"`; anything else goes through
   * `createPackageViaBridge` after `preflightPackageCorr` gate-judges the
   * transport. Both faked here — this file tests tool routing, not choreography.
   */
  preflightPackageCorr: vi.fn(),
  createPackageViaBridge: vi.fn(),
  /** Pure comparison over plain data; the real one is exercised in test/package-create.test.ts. */
  tdevcDiscrepancies: vi.fn(() => [] as string[]),
  // `objects` batch-delete form (src/tools/write.ts) — same reasoning as
  // `MAX_ACTIVATION_BATCH` below: none of the existing tests in this file
  // exercise the batch path (they're all single-`object` gate-wiring tests),
  // but the module imports both unconditionally, and `MAX_DELETE_BATCH` is
  // read at schema-build time (`.max(MAX_DELETE_BATCH)`), so it has to be the
  // real constant, not a vi.fn(), or the module throws on import.
  // `assertNoDuplicateDeleteTargets` is a real (not canned) implementation,
  // same rationale as `isPackageType` above: it is a pure predicate over
  // plain data, so faking it to a constant would let a duplicate slip past
  // routing tests that a real batch-delete test (test/write-batch-delete.test.ts)
  // would catch instead — cheaper to keep the two paths honestly identical.
  assertNoDuplicateDeleteTargets: vi.fn((targets: ReadonlyArray<{ name: string; uri: string }>) => {
    const seen = new Set<string>();
    for (const t of targets) {
      const key = t.uri || t.name.trim().toUpperCase();
      if (seen.has(key)) {
        throw new AbapError("BAD_INPUT", `duplicate object in batch: ${t.name}`, { name: t.name });
      }
      seen.add(key);
    }
  }),
  MAX_DELETE_BATCH: 10,
  // Mirrors the real constant in src/adt/write.ts — kept as a
  // literal here for the same reason MAX_DELETE_BATCH above is: this module
  // is fully mocked, so there is no live import to draw it from.
  PACKAGE_SOFTWARE_COMPONENT_HINT:
    "Use HOME (or another real software component) for a transportable package. LOCAL only " +
    "works for a $-named local package — abapsmith's default Z*/Y* names are not eligible, " +
    "and SAP refuses the assignment with TR/462.",
  /**
   * The pre-activation content gate in `src/tools/write.ts` re-reads the object
   * between the (already-released) write lock and the activation, and refuses to
   * activate bytes it did not write. Both halves of that comparison are faked
   * here, because `writeObject` in this suite is itself a fake handing back a
   * canned `etag` that no real hash could ever reproduce.
   *
   * The DEFAULT is "nobody touched it": `readCurrentSource` echoes back whatever
   * etag the currently-programmed `writeObject` resolved with, and `canonicalEtag`
   * is identity, so the gate compares `etag === etag` and stands down. That keeps
   * every pre-existing test in this file on the exact path it was written for.
   * A test that wants the race just programs `adt.readCurrentSource` with
   * somebody else's source.
   */
  readCurrentSource: vi.fn(async (): Promise<string | undefined> => {
    const last = adt.writeObject.mock.results.at(-1)?.value as Promise<{ etag?: string }> | undefined;
    return (await last)?.etag ?? "";
  }),
  /** Identity: see `readCurrentSource` above for why this is not the real hash. */
  canonicalEtag: vi.fn((s: string) => s),
  checkSource: vi.fn(),
  activateObject: vi.fn(),
  /** The tools now raise a failed activation through this; a clean one is a no-op. */
  assertNoErrors: vi.fn(),
  parseStartFragment: vi.fn(),
  renderMessages: vi.fn(() => ""),
  renderInactive: vi.fn(() => ""),
  prettyPrintSource: vi.fn(),
  // `objects` batch form (src/tools/activate.ts) — none of the existing tests
  // in this file exercise it (they're all single-`object` gate-wiring tests),
  // but the module imports these unconditionally: `MAX_ACTIVATION_BATCH` is
  // read at schema-build time (`.max(MAX_ACTIVATION_BATCH)`), so it has to be
  // the real constant, not a vi.fn(), or the module throws on import.
  activateObjects: vi.fn(),
  assertBatchActivated: vi.fn(),
  renderBatch: vi.fn(() => ""),
  MAX_ACTIVATION_BATCH: 50,
  runClass: vi.fn(),
  runReport: vi.fn(),
  bridgeClassName: vi.fn(),
  bridgeClassSource: vi.fn(),
  stripListHeader: vi.fn(),
}));

vi.mock("../src/adt/write.js", () => ({
  resolveWriteTarget: adt.resolveWriteTarget,
  authorizeMutation: adt.authorizeMutation,
  writeObject: adt.writeObject,
  deleteObject: adt.deleteObject,
  isPackageType: adt.isPackageType,
  createPackage: adt.createPackage,
  preflightPackageCorr: adt.preflightPackageCorr,
  readCurrentSource: adt.readCurrentSource,
  canonicalEtag: adt.canonicalEtag,
  assertNoDuplicateDeleteTargets: adt.assertNoDuplicateDeleteTargets,
  MAX_DELETE_BATCH: adt.MAX_DELETE_BATCH,
  // `abapCreatePackage`'s own empty-`software_component` guard (src/tools/
  // write.ts) shares this constant with `createPackage`'s rather
  // than carrying its own copy of the wording — real string, not a `vi.fn()`,
  // so a test here that ever pins the hint text sees the real thing.
  PACKAGE_SOFTWARE_COMPONENT_HINT: adt.PACKAGE_SOFTWARE_COMPONENT_HINT,
}));
// The DEVC/K classrun bridge. Faked whole: `src/tools/write.ts`
// imports both of these unconditionally at module scope, so they must exist,
// and a tool-surface test has no business driving a real bridge deploy.
vi.mock("../src/adt/package-create.js", () => ({
  createPackageViaBridge: adt.createPackageViaBridge,
  tdevcDiscrepancies: adt.tdevcDiscrepancies,
}));
vi.mock("../src/adt/activate.js", () => ({
  checkSource: adt.checkSource,
  activateObject: adt.activateObject,
  assertNoErrors: adt.assertNoErrors,
  parseStartFragment: adt.parseStartFragment,
  renderMessages: adt.renderMessages,
  renderInactive: adt.renderInactive,
  prettyPrintSource: adt.prettyPrintSource,
  activateObjects: adt.activateObjects,
  assertBatchActivated: adt.assertBatchActivated,
  renderBatch: adt.renderBatch,
  MAX_ACTIVATION_BATCH: adt.MAX_ACTIVATION_BATCH,
}));
// Only `resolveObject` is faked — `parseObjectRef` is pure and is what the
// pre-flight gate runs on, so it must stay real.
vi.mock("../src/adt/resolve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/adt/resolve.js")>()),
  resolveObject: adt.resolveObject,
}));
vi.mock("../src/adt/run.js", () => ({
  runClass: adt.runClass,
  runReport: adt.runReport,
  bridgeClassName: adt.bridgeClassName,
  bridgeClassSource: adt.bridgeClassSource,
  stripListHeader: adt.stripListHeader,
  // `abap_run` gates the generated bridge class before running a report — the
  // bridge is an object CREATED below the tool layer, so the gate has to see it
  // here or it escapes the package allowlist entirely. The tool imports this
  // constant, so the mock has to carry it.
  BRIDGE_PACKAGE: "$TMP",
}));

// ---------------------------------------------------------------- fixtures ---

/** Counts (and can refuse) every request that would leave the process. */
class CountingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

/**
 * Fail-closed system-role detection: `AbapConnection.connect()` now probes
 * `POST /sap/bc/adt/datapreview/freestyle` for T000-CCCATEGORY, and a system it
 * cannot PROVE non-productive is write-locked (`writesLockedOut`) *before* the
 * safety gate ever runs. A fake that answers "ok" to everything is therefore a
 * fake of a system that might be production, and every mutating tool refuses
 * with READ_ONLY instead of reaching the routing/gate behaviour under test here.
 *
 * So the fake serves the REAL captured 200 bytes (fixture 087: client 000 → "S",
 * client 001 → "C"), and `cfg()` logs on as client 001 — the detection then
 * legitimately concludes "nonproductive" on its own merits. Nothing about the
 * detection is stubbed out.
 *
 * Imported, with `DATAPREVIEW_XML`, from ./helpers/system-role-fake.js.
 */

const okResponse = (o?: HttpClientOptions): HttpClientResponse => {
  if (o?.url?.includes("/datapreview/freestyle")) {
    return {
      status: 200,
      statusText: "200",
      body: T000_NONPRODUCTIVE,
      headers: { ...DATAPREVIEW_XML, "x-csrf-token": "TOKEN" },
    } as unknown as HttpClientResponse;
  }
  return {
    status: 200,
    statusText: "200",
    body: "ok",
    headers: { "content-type": "text/plain", "x-csrf-token": "TOKEN" },
  } as unknown as HttpClientResponse;
};

/** A transport that must never be reached. */
const forbiddenClient = () =>
  new CountingClient(() => {
    throw new Error("NETWORK CALL LEAKED: the safety gate let a refused write through");
  });

const cfg = (over: Partial<Config> = {}): Config => ({
  ...ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    // The logon client the T000 probe judges. Without it detection has no
    // client to look up and fails closed — see `okResponse` above.
    client: "001",
    // ConfigSchema's own default is `[]` (fail-closed, like `allowPackages`)
    // — deliberately unreachable from `loadConfig`, which applies `["*"]`
    // instead. Most tests here build configs by hand via this helper,
    // bypassing `loadConfig`, so they'd otherwise inherit the fail-closed
    // schema default and have every transportable write refused for a
    // reason unrelated to what they're testing. Named here, not per test —
    // same as `allowPackages` would be if most call sites didn't already
    // name it themselves. Tests that care about the allowlist itself
    // override this via `over`.
    allowTransports: ["*"],
  }),
  ...over,
});

/**
 * Fully-open config: every static-capability ceiling
 * (`readOnly`, `allowTransportRelease`, `allowEnhancements`) is set to its
 * most permissive value, so `resolveStaticCapabilities` (src/config.ts)
 * yields `canWrite`/`canReleaseTransport`/`canEnhance` all `true` and every
 * tool this server can ever register IS registered. The whole-surface
 * byte-total tests below need this — not the read-only `cfg()` default —
 * because they exist to catch schema DRIFT on tools that a read-only server
 * no longer even advertises. `allowPackages`/`allowNamePrefixes`/
 * `enhanceTargets`/`enhanceTargetPackages` are set too, even though only
 * `readOnly`/`allowTransportRelease`/`allowEnhancements` feed registration —
 * matching the runtime gate's own "fully open" shape keeps this fixture
 * honest as a stand-in for a real permissive deployment, not just a
 * registration-only trick.
 */
const openCfg = (over: Partial<Config> = {}): Config =>
  cfg({
    readOnly: false,
    allowPackages: ["*"],
    allowNamePrefixes: ["Z", "Y"],
    allowTransportRelease: true,
    allowEnhancements: true,
    enhanceTargets: "sap",
    enhanceTargetPackages: ["*"],
    ...over,
  });

interface Harness {
  srv: AbapsmithServer;
  client: Client;
  http: CountingClient;
}

async function harness(config: Config, http = forbiddenClient()): Promise<Harness> {
  const srv = createServer(config, { httpClient: http, log: () => {}, breaker: new AuthCircuitBreaker() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);
  return { srv, client, http };
}

interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

const call = async (h: Harness, name: string, args: Record<string, unknown>) =>
  (await h.client.callTool({ name, arguments: args })) as unknown as ToolCallResult;

const errorOf = (res: ToolCallResult): Record<string, unknown> => {
  expect(res.isError).toBe(true);
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
};

beforeEach(() => {
  vi.clearAllMocks();
  adt.renderMessages.mockReturnValue("");
});

// ------------------------------------------------------------------ tests ---

describe("safety gate refuses writes before the network", () => {
  // NOTE: under the read-only default, `abap_write` is no
  // longer *registered at all* (registration-time filtering — see the
  // "registration-time filtering" suite below) — that's a separate,
  // additional layer on top of the runtime SafetyGate refusal these two
  // tests originally proved. Calling an unregistered tool through the real
  // MCP client now returns an SDK-level "MCP error ..." envelope, not our
  // own JSON error shape, so it can no longer be asserted via `errorOf`.
  // These tests therefore check both layers directly: (1) the unregistered
  // call still costs zero network bytes, and (2) the underlying gate, if
  // asked directly, still refuses with READ_ONLY and still names the flag —
  // proving registration-time filtering is additive, not a replacement for
  // the runtime gate.
  it("puts ZERO requests on the wire when a write is refused (and the tool isn't even registered)", async () => {
    const h = await harness(cfg()); // read-only default
    const res = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      type: "PROG/P",
      package: "$TMP",
      source: "REPORT zmcp_demo.\nWRITE 'hi'.",
    });

    expect(res.isError).toBeTruthy();
    // The proof: not one byte left the process — not even the logon.
    expect(h.http.calls).toHaveLength(0);
    expect(h.srv.connection.requestCount).toBe(0);
    expect(h.srv.connection.isConnected).toBe(false);
    // …and nothing in the write path was invoked either.
    expect(adt.resolveWriteTarget).not.toHaveBeenCalled();
    expect(adt.writeObject).not.toHaveBeenCalled();
  });

  it("read-only is the default: the SafetyGate itself still refuses write with READ_ONLY and names the flag", async () => {
    const h = await harness(cfg());
    const d = h.srv.safety.evaluate("write", { name: "ZMCP_DEMO", packageName: "$TMP", type: "PROG/P" });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("READ_ONLY");
    expect(d.reason).toMatch(/ABAP_ALLOW_WRITE/);
    expect(h.http.calls).toHaveLength(0);
  });

  it("refuses a write to a package outside the allowlist", async () => {
    const h = await harness(cfg({ readOnly: false, allowPackages: ["$TMP"] }));
    const err = errorOf(
      await call(h, "abap_write", { object: "ZMCP_DEMO", package: "ZOTHER", source: "x" }),
    );
    expect(err.error).toBe("SAFETY_DENIED");
    expect(String(err.message)).toMatch(/allowlist/i);
    expect(h.http.calls).toHaveLength(0);
  });

  it("refuses an SAP-namespace object even with writes enabled", async () => {
    const h = await harness(cfg({ readOnly: false, allowPackages: ["*"] }));
    const err = errorOf(
      await call(h, "abap_write", { object: "/DMO/CL_FLIGHT", package: "$TMP", source: "x" }),
    );
    expect(err.error).toBe("SAFETY_DENIED");
    expect(String(err.message)).toMatch(/namespace/i);
    expect(h.http.calls).toHaveLength(0);
  });

  it("refuses a name outside the customer namespace even with writes enabled", async () => {
    const h = await harness(cfg({ readOnly: false, allowPackages: ["$TMP"] }));
    const err = errorOf(
      await call(h, "abap_write", { object: "CL_ABAP_TYPEDESCR", package: "$TMP", source: "x" }),
    );
    expect(err.error).toBe("SAFETY_DENIED");
    expect(h.http.calls).toHaveLength(0);
  });

  it("refuses activation and execution on the same rules, also before connecting", async () => {
    const h = await harness(cfg());
    // abap_activate stays registered even read-only (mode=check is an
    // unconditional, ungated read), so it still goes
    // through the real tool call.
    expect(errorOf(await call(h, "abap_activate", { object: "ZMCP_DEMO" })).error).toBe("READ_ONLY");
    // abap_run, however, is registration-gated on canWrite and is not
    // registered under the read-only default — assert the same refusal
    // against the runtime gate directly instead (op "execute").
    const d = h.srv.safety.evaluate("execute", { name: "ZMCP_DEMO", packageName: "$TMP", type: "PROG/P" });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("READ_ONLY");
    expect(h.http.calls).toHaveLength(0);
  });

  it("still allows reads while read-only", async () => {
    // Reads are never gated — the tool fails on the fake transport, not the gate.
    const h = await harness(cfg(), new CountingClient(okResponse));
    const res = await call(h, "abap_read", { object: "ZCL_FOO" });
    const text = res.content[0]!.text;
    expect(text).not.toMatch(/READ_ONLY|SAFETY_DENIED/);
    expect(h.http.calls.length).toBeGreaterThan(0); // it got as far as the logon
  });
});

/**
 * `abap_read`'s `version` argument used to be an untyped extra property
 * that zod's default object-stripping (`z.core.$strip`) dropped silently — a
 * bogus value fell through to whatever ADT reports as current, presented as
 * if the request had been honoured. The enum
 * on `readInputSchema` now makes the MCP SDK reject anything outside
 * `"active" | "inactive"` before the tool handler ever runs — proven below by
 * asserting ZERO requests reach the wire, the same proof pattern the safety
 * gate tests above use.
 */
describe("abap_read version parameter", () => {
  const resolved = (over: Record<string, unknown> = {}) => ({
    system: "TST",
    type: "CLAS/OC",
    kind: "CLAS",
    label: "class",
    name: "ZCL_FOO",
    uri: "/sap/bc/adt/oo/classes/zcl_foo",
    packageName: "$TMP",
    mode: "source",
    spec: {} as never,
    ...over,
  });

  it("rejects an unrecognised version before touching the network, naming the accepted values", async () => {
    const h = await harness(cfg(), new CountingClient(okResponse));
    const res = await call(h, "abap_read", { object: "ZCL_FOO", version: "draft" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/active/);
    expect(res.content[0]!.text).toMatch(/inactive/);
    // Rejected at the schema boundary — never even reached ensureConnected().
    expect(h.http.calls).toHaveLength(0);
  });

  it('accepts version="active" and threads it onto the source GET as a query parameter', async () => {
    adt.resolveObject.mockResolvedValue(resolved());
    const h = await harness(cfg(), new CountingClient(okResponse));
    const res = await call(h, "abap_read", { object: "ZCL_FOO", version: "active" });
    expect(res.isError).toBeFalsy();
    const sourceCall = h.http.calls.find((c) => String(c.url).includes("/source/main"));
    expect(sourceCall?.qs).toMatchObject({ version: "active" });
  });

  it('accepts version="inactive" the same way', async () => {
    adt.resolveObject.mockResolvedValue(resolved());
    const h = await harness(cfg(), new CountingClient(okResponse));
    const res = await call(h, "abap_read", { object: "ZCL_FOO", version: "inactive" });
    expect(res.isError).toBeFalsy();
    const sourceCall = h.http.calls.find((c) => String(c.url).includes("/source/main"));
    expect(sourceCall?.qs).toMatchObject({ version: "inactive" });
  });

  it("omitting version sends no version qs param — the pre-existing default behaviour", async () => {
    adt.resolveObject.mockResolvedValue(resolved());
    const h = await harness(cfg(), new CountingClient(okResponse));
    const res = await call(h, "abap_read", { object: "ZCL_FOO" });
    expect(res.isError).toBeFalsy();
    const sourceCall = h.http.calls.find((c) => String(c.url).includes("/source/main"));
    expect(sourceCall?.qs?.version).toBeUndefined();
  });
});

describe("createServer: SafetyGate receives the FULL transport config", () => {
  // `AbapsmithServer` exposes `safety: SafetyGate` (src/server.ts), and `srv.safety.config`
  // / `srv.safety.transportAllowlist` are public (src/safety.ts). Observing the gate
  // directly — rather than through a tool call — is deliberate: it isolates Edit 1
  // (`new SafetyGate({...})` in `createServer`) from everything downstream of it.

  it("carries an explicitly empty ABAP_ALLOW_TRANSPORTS through to the gate as deny-all, not the ['auto'] default", async () => {
    const h = await harness(cfg({ readOnly: false, allowPackages: ["ZFOO_*"], allowTransports: [] }));
    expect(h.srv.safety.transportAllowlist).toEqual([]);
    const d = h.srv.safety.evaluate("write", {
      name: "ZCL_A",
      packageName: "ZFOO_BAR",
      type: "CLAS/OC",
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/ABAP_ALLOW_TRANSPORTS is explicitly empty/);
  });

  it("carries a pinned TRKORR through to the gate", async () => {
    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["ZFOO_*"], allowTransports: ["A4HK900123"] }),
    );
    expect(h.srv.safety.transportAllowlist).toEqual(["A4HK900123"]);
  });

  it("carries allowTransportRelease=true through, so the release ceiling can ever open", async () => {
    const h = await harness(cfg({ readOnly: false, allowTransportRelease: true }));
    expect(h.srv.safety.config.allowTransportRelease).toBe(true);
    expect(h.srv.safety.evaluate("transport", undefined, { release: true }).allowed).toBe(true);
  });

  it("leaves allowTransportRelease closed when the config says false", async () => {
    // PASSES TODAY, for the wrong reason (the gate never received the field at
    // all, so it read `undefined` and treated that as closed). It must keep
    // passing after the fix too — this pins the direction and proves the fix
    // didn't just flip the default open.
    const h = await harness(cfg({ readOnly: false, allowTransportRelease: false }));
    const d = h.srv.safety.evaluate("transport", undefined, { release: true });
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatch(/transport release ceiling/);
  });
});

describe("abap_write routing", () => {
  const target = {
    spec: {} as never,
    type: "PROG/P",
    name: "ZMCP_DEMO",
    uri: "/sap/bc/adt/programs/programs/zmcp_demo",
    sourceUri: "/sap/bc/adt/programs/programs/zmcp_demo/source/main",
    packageName: "$TMP",
    description: "demo",
  };

  it("routes mode=delete to deleteObject and never to writeObject", async () => {
    adt.resolveWriteTarget.mockResolvedValue(target);
    // `deleteObject` now requires `transport`; omit it and the header crashes.
    adt.deleteObject.mockResolvedValue({ target, deleted: true, transport: { status: "local", required: false } });

    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["$TMP"] }),
      new CountingClient(okResponse),
    );
    const res = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      package: "$TMP",
      mode: "delete",
    });

    expect(res.isError).toBeFalsy();
    expect(adt.deleteObject).toHaveBeenCalledTimes(1);
    // `deleteObject`'s second arg is now the `AuthorizedTarget` wrapper the
    // fake `authorizeMutation` above mints (`{ op, target }`), not the bare
    // resolved object.
    expect(adt.deleteObject.mock.calls[0]![1]).toMatchObject({
      op: "delete",
      target: { name: "ZMCP_DEMO" },
    });
    expect(adt.writeObject).not.toHaveBeenCalled();
    expect(adt.activateObject).not.toHaveBeenCalled();
    expect(res.content[0]!.text).toMatch(/deleted: true/);
  });

  it("rejects mode=write without source, after the gate and without a write call", async () => {
    adt.resolveWriteTarget.mockResolvedValue(target);
    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["$TMP"] }),
      new CountingClient(okResponse),
    );
    const err = errorOf(await call(h, "abap_write", { object: "ZMCP_DEMO", package: "$TMP" }));
    expect(err.error).toBe("BAD_INPUT");
    expect(adt.writeObject).not.toHaveBeenCalled();
  });

  it("writes, syntax-checks, then activates — and reports CHECK_FAILED, not quiet success, when the check fails", async () => {
    adt.resolveWriteTarget.mockResolvedValue(target);
    adt.writeObject.mockResolvedValue({
      target,
      created: true,
      changed: true,
      etag: "sha256:abc",
      transport: { status: "local", required: false },
    });
    adt.activateObject.mockResolvedValue({
      ok: true,
      messages: [],
      errors: 0,
      warnings: 0,
      activated: true,
      inactive: [],
    });

    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["$TMP"] }),
      new CountingClient(okResponse),
    );

    adt.checkSource.mockResolvedValue({ ok: true, messages: [], errors: 0, warnings: 0 });
    let res = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      package: "$TMP",
      source: "REPORT zmcp_demo.",
    });
    expect(adt.checkSource).toHaveBeenCalledTimes(1);
    expect(adt.activateObject).toHaveBeenCalledTimes(1);
    expect(res.content[0]!.text).toMatch(/created: true/);

    vi.clearAllMocks();
    adt.renderMessages.mockReturnValue("");
    adt.resolveWriteTarget.mockResolvedValue(target);
    adt.writeObject.mockResolvedValue({
      target,
      created: false,
      changed: true,
      etag: "sha256:def",
      transport: { status: "local", required: false },
    });
    adt.checkSource.mockResolvedValue({
      ok: false,
      messages: [{ severity: "E", text: "boom", line: 3 }],
      errors: 1,
      warnings: 0,
    });
    res = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      package: "$TMP",
      source: "REPORT zmcp_demo.",
    });
    // The save succeeded (writeObject resolved) but the syntax check found
    // real errors, so activation was (rightly) never attempted. That must not
    // collapse into a falsely-successful isError:false response — it is the
    // "saved+inactive" state, distinct from both "saved+activated" and "not
    // saved at all", and callers that only check `isError` must see it.
    expect(adt.activateObject).not.toHaveBeenCalled();
    const err = errorOf(res);
    expect(err.error).toBe("CHECK_FAILED");
    expect(err.message).toMatch(/saved INACTIVE/);
    expect(err.details).toMatchObject({ written: true, activated: false });
  });

  /**
   * F-?? — the write lock is released inside `writeObject`, and activation runs
   * outside it with no version pin (activation POSTs name+URI only; there is no
   * If-Match on this protocol, so the etag abapsmith reports is a client-side
   * content hash and pins nothing). A second writer that lands a PUT in that
   * window gets its source activated under OUR etag, with no error raised.
   *
   * These two tests pin the gate that closes it from both sides: the untouched
   * case must behave EXACTLY as before (or the fix has cost every write its
   * activation), and the moved case must refuse to activate.
   */
  it("re-reads the source before activating and activates normally when nobody touched it", async () => {
    adt.resolveWriteTarget.mockResolvedValue(target);
    adt.writeObject.mockResolvedValue({
      target,
      created: false,
      changed: true,
      etag: "sha256:mine",
      transport: { status: "local", required: false },
    });
    adt.checkSource.mockResolvedValue({ ok: true, messages: [], errors: 0, warnings: 0 });
    adt.activateObject.mockResolvedValue({
      ok: true,
      messages: [],
      errors: 0,
      warnings: 0,
      activated: true,
      inactive: [],
    });

    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["$TMP"] }),
      new CountingClient(okResponse),
    );
    const res = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      package: "$TMP",
      source: "REPORT zmcp_demo.",
    });

    // Exactly one extra GET, and only on the path that actually activates.
    expect(adt.readCurrentSource).toHaveBeenCalledTimes(1);
    // The re-read must not be able to short-circuit to `undefined` on a target
    // that was resolved as absent before the create — it is forced to `exists`.
    expect(adt.readCurrentSource.mock.calls[0]![1]).toMatchObject({ exists: true });
    expect(adt.activateObject).toHaveBeenCalledTimes(1);
    expect(res.isError ?? false).toBe(false);
    expect(res.content[0]!.text).toMatch(/activated: true/);
  });

  it("refuses to activate when the object moved between the write and the activation", async () => {
    adt.resolveWriteTarget.mockResolvedValue(target);
    adt.writeObject.mockResolvedValue({
      target,
      created: false,
      changed: true,
      etag: "sha256:mine",
      transport: { status: "local", required: false },
    });
    adt.checkSource.mockResolvedValue({ ok: true, messages: [], errors: 0, warnings: 0 });
    adt.activateObject.mockResolvedValue({
      ok: true,
      messages: [],
      errors: 0,
      warnings: 0,
      activated: true,
      inactive: [],
    });
    // The second writer: our PUT landed, then theirs did. `canonicalEtag` is
    // identity in this suite, so this string IS the etag the gate observes.
    // `…Once`, not `mockResolvedValue`: a persistent override would leak the
    // race into every later test in this file, which is exactly what it did.
    adt.readCurrentSource.mockResolvedValueOnce("sha256:theirs");

    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["$TMP"] }),
      new CountingClient(okResponse),
    );
    const res = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      package: "$TMP",
      source: "REPORT zmcp_demo.",
    });

    // The whole point: SAP is never asked to activate somebody else's source.
    expect(adt.activateObject).not.toHaveBeenCalled();

    const err = errorOf(res);
    expect(err.error).toBe("ETAG_CONFLICT");
    // Names the object, and says which of the two conflict windows this is —
    // the pre-lock guards in src/adt/write.ts use the same code and are told
    // apart by `phase`, exactly as those two already tell each other apart.
    expect(err.message).toContain("PROG/P ZMCP_DEMO");
    expect(err.message).toMatch(/NOT activated/);
    expect(err.details).toMatchObject({
      phase: "pre-activation",
      object: "PROG/P ZMCP_DEMO",
      // Unlike every other ETAG_CONFLICT, this one is raised AFTER a durable
      // PUT. A caller that only reads the code must still see that.
      written: true,
      activated: false,
      expectedEtag: "sha256:mine",
      actualEtag: "sha256:theirs",
    });
    // Retrying blindly re-runs the race AND discards the other writer silently,
    // so the hint has to say so rather than the usual "re-read and write again".
    expect(err.hint).toMatch(/DO NOT simply write again/);
  });

  it("re-checks the gate against the RESOLVED package, not the one the caller claimed", async () => {
    // The caller names no package; the resolver reports an SAP one.
    adt.resolveWriteTarget.mockResolvedValue({ ...target, packageName: "SABP_TYPES" });
    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["$TMP"] }),
      new CountingClient(okResponse),
    );
    const err = errorOf(await call(h, "abap_write", { object: "ZMCP_DEMO", source: "x" }));
    expect(err.error).toBe("SAFETY_DENIED");
    expect(adt.writeObject).not.toHaveBeenCalled();
  });
});

describe("abap_write — format (pretty-printer rider)", () => {
  const target = {
    spec: {} as never,
    type: "PROG/P",
    name: "ZMCP_DEMO",
    uri: "/sap/bc/adt/programs/programs/zmcp_demo",
    sourceUri: "/sap/bc/adt/programs/programs/zmcp_demo/source/main",
    packageName: "$TMP",
    description: "demo",
  };

  const writeOk = () => {
    adt.writeObject.mockResolvedValue({
      target,
      created: false,
      changed: true,
      etag: "sha256:abc",
      transport: { status: "local", required: false },
    });
    adt.checkSource.mockResolvedValue({ ok: true, messages: [], errors: 0, warnings: 0 });
    adt.activateObject.mockResolvedValue({
      ok: true,
      messages: [],
      errors: 0,
      warnings: 0,
      activated: true,
      inactive: [],
    });
  };

  it("format:true pretty-prints the resolved source before it reaches writeObject, and reports the line count", async () => {
    adt.resolveWriteTarget.mockResolvedValue(target);
    writeOk();
    adt.prettyPrintSource.mockResolvedValue({
      source: "REPORT zmcp_demo.\n\nWRITE 'hi'.",
      changed: true,
      linesChanged: 2,
    });

    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["$TMP"] }),
      new CountingClient(okResponse),
    );
    const res = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      package: "$TMP",
      source: "REPORT zmcp_demo.\nWRITE 'hi'.",
      format: true,
    });

    expect(res.isError).toBeFalsy();
    expect(adt.prettyPrintSource).toHaveBeenCalledTimes(1);
    expect(adt.prettyPrintSource.mock.calls[0]![1]).toBe("REPORT zmcp_demo.\nWRITE 'hi'.");
    expect(adt.writeObject.mock.calls[0]![2]).toMatchObject({
      source: "REPORT zmcp_demo.\n\nWRITE 'hi'.",
    });
    expect(res.content[0]!.text).toContain("formatted: 2 line(s)");
    expect(res.content[0]!.text).toMatch(/pretty-printed before saving/);
  });

  it("format omitted never calls prettyPrintSource, and the header says formatted: no", async () => {
    adt.resolveWriteTarget.mockResolvedValue(target);
    writeOk();

    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["$TMP"] }),
      new CountingClient(okResponse),
    );
    const res = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      package: "$TMP",
      source: "REPORT zmcp_demo.",
    });

    expect(res.isError).toBeFalsy();
    expect(adt.prettyPrintSource).not.toHaveBeenCalled();
    expect(adt.writeObject.mock.calls[0]![2]).toMatchObject({ source: "REPORT zmcp_demo." });
    expect(res.content[0]!.text).toContain("formatted: no");
  });

  it("format:false behaves exactly like format omitted", async () => {
    adt.resolveWriteTarget.mockResolvedValue(target);
    writeOk();

    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["$TMP"] }),
      new CountingClient(okResponse),
    );
    const res = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      package: "$TMP",
      source: "REPORT zmcp_demo.",
      format: false,
    });

    expect(res.isError).toBeFalsy();
    expect(adt.prettyPrintSource).not.toHaveBeenCalled();
    expect(res.content[0]!.text).toContain("formatted: no");
  });

  it("reports 'no change' when the formatter returns byte-identical source", async () => {
    adt.resolveWriteTarget.mockResolvedValue(target);
    writeOk();
    adt.prettyPrintSource.mockResolvedValue({
      source: "REPORT zmcp_demo.",
      changed: false,
      linesChanged: 0,
    });

    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["$TMP"] }),
      new CountingClient(okResponse),
    );
    const res = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      package: "$TMP",
      source: "REPORT zmcp_demo.",
      format: true,
    });

    expect(res.isError).toBeFalsy();
    expect(adt.prettyPrintSource).toHaveBeenCalledTimes(1);
    expect(res.content[0]!.text).toContain("formatted: no change");
    expect(res.content[0]!.text).not.toMatch(/pretty-printed before saving/);
  });

  it("format:true + mode:delete is refused with BAD_INPUT before any write-side-effecting call", async () => {
    adt.resolveWriteTarget.mockResolvedValue(target);

    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["$TMP"] }),
      new CountingClient(okResponse),
    );
    const err = errorOf(
      await call(h, "abap_write", {
        object: "ZMCP_DEMO",
        package: "$TMP",
        mode: "delete",
        format: true,
      }),
    );

    expect(err.error).toBe("BAD_INPUT");
    expect(adt.prettyPrintSource).not.toHaveBeenCalled();
    expect(adt.deleteObject).not.toHaveBeenCalled();
    expect(adt.authorizeMutation).not.toHaveBeenCalled();
  });

  /**
   * There is no bespoke format-refusal branch in src/tools/write.ts for a type
   * with no write capability at all: the REAL `resolveWriteTarget` already
   * refuses any write to such a type with UNSUPPORTED before `abap_write`
   * ever looks at `input.format`. Mirrored here — `resolveWriteTarget` is
   * mocked in this file — the same way the DEVC/K delete refusal above
   * mirrors its real UNSUPPORTED rejection.
   *
   * ENHO/XH (BAdI implementation) is the example: declared in the registry
   * (src/adt/capabilities.ts) with `activate: true` but no `write`/`create`
   * capability of its own. (This test used to target DDLX/EX, then XSLT/VT,
   * then PROG/I; DDLX/EX was admitted to WRITABLE_TYPES alongside SRVD/SRV in
   * the same pass DDLS/DF joined it, XSLT/VT was admitted once its
   * transformations path was corrected, and PROG/I gained its own vendor
   * write/create recipe — see capabilities.ts — so none of the three can
   * stand in for "a type this refusal actually fires for" any more. ENHO/XH
   * remains genuinely unsupported and takes over as the example.)
   */
  it("format:true against an ENHO/XH BAdI implementation target is refused with UNSUPPORTED via the pre-existing type check, not a bespoke branch", async () => {
    adt.resolveWriteTarget.mockRejectedValue(
      new AbapError(
        "UNSUPPORTED",
        "BAdI implementation ZTMD_BADI_IMPL (ENHO/XH) cannot be written by abapsmith.",
        { type: "ENHO/XH", name: "ZTMD_BADI_IMPL" },
        "Writable types are CLAS/OC, INTF/OI, PROG/P, DDLS/DF, DDLX/EX, SRVD/SRV, TABL/DT, TABL/DS.",
      ),
    );

    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["$TMP"] }),
      new CountingClient(okResponse),
    );
    const err = errorOf(
      await call(h, "abap_write", {
        object: "ZTMD_BADI_IMPL",
        package: "$TMP",
        source: "* BAdI implementation body",
        format: true,
      }),
    );

    expect(err.error).toBe("UNSUPPORTED");
    expect(String(err.message)).toMatch(/cannot be written by abapsmith/i);
    expect(adt.prettyPrintSource).not.toHaveBeenCalled();
    expect(adt.writeObject).not.toHaveBeenCalled();
  });

  it("format:true on a package create is refused with BAD_INPUT before authorizeMutation", async () => {
    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["ZCOURSES", "ZSD_ORDER"] }),
      new CountingClient(okResponse),
    );
    const err = errorOf(
      await call(h, "abap_write", {
        object: "ZSD_ORDER",
        type: "DEVC/K",
        package: "ZCOURSES",
        software_component: "HOME",
        format: true,
      }),
    );

    expect(err.error).toBe("BAD_INPUT");
    expect(String(err.message)).toMatch(/package has no source/i);
    expect(adt.prettyPrintSource).not.toHaveBeenCalled();
    expect(adt.createPackage).not.toHaveBeenCalled();
    expect(adt.authorizeMutation).not.toHaveBeenCalled();
  });
});

describe("abap_write → package creation (DEVC/K)", () => {
  /**
   * Base args for a package create: `object` is the NEW package, `package` is
   * its SUPERpackage (per the schema description on `writeInputSchema.package`
   * in src/tools/write.ts: "For a new DEVC/K this is the superpackage.").
   *
   * `software_component` is `"LOCAL"` here on purpose — it is the
   * only discriminator between the two create routes, and these tests cover
   * the REST one only; the bridge route gets its own test below.
   */
  const pkgArgs = (over: Record<string, unknown> = {}) => ({
    object: "ZSD_ORDER",
    type: "DEVC/K",
    package: "ZCOURSES",
    description: "Sales order training package",
    software_component: "LOCAL",
    corr_nr: "A4HK900123",
    ...over,
  });

  /**
   * What the REAL `resolveWriteTarget` (src/adt/write.ts, the `CREATE_ONLY`
   * 404 branch) returns for a package create: its OWN name as `packageName`
   * (a package IS its own package — ADT reports `adtcore:packageRef` = the
   * package itself) and the caller's `package` argument carried separately as
   * `superPackage`. Mirrored here rather than reused because
   * `resolveWriteTarget` is mocked in this file.
   */
  const packageTarget = (over: Record<string, unknown> = {}) => ({
    spec: {} as never,
    type: "DEVC/K",
    name: "ZSD_ORDER",
    uri: "/sap/bc/adt/packages/zsd_order",
    sourceUri: "/sap/bc/adt/packages/zsd_order/source/main",
    packageName: "ZSD_ORDER",
    packageSource: "server" as const,
    superPackage: "ZCOURSES",
    description: "Sales order training package",
    exists: false,
    ...over,
  });

  const packageCreateResult = (over: Record<string, unknown> = {}) => ({
    target: packageTarget(),
    created: true,
    superPackage: "ZCOURSES",
    softwareComponent: "LOCAL",
    packageType: "development",
    transportLayer: "",
    transport: { status: "local", required: false },
    ...over,
  });

  it("routes a DEVC/K write to createPackage, not writeObject", async () => {
    adt.resolveWriteTarget.mockResolvedValue(packageTarget());
    adt.createPackage.mockResolvedValue(packageCreateResult());

    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["ZCOURSES", "ZSD_ORDER"] }),
      new CountingClient(okResponse),
    );
    const res = await call(h, "abap_write", pkgArgs());

    expect(res.isError).toBeFalsy();
    expect(adt.createPackage).toHaveBeenCalledTimes(1);
    expect(adt.writeObject).not.toHaveBeenCalled();
    expect(res.content[0]!.text).toMatch(/created: true/);
  });

  /**
   * `targetFromInput` (src/tools/write.ts) maps the caller's `package` straight
   * onto `target.packageName` with no DEVC/K special-casing — so the OUTGOING
   * call to `authorizeMutation` still carries the superpackage under the name
   * `packageName`. What matters is what the GATE does with it once resolved:
   * `resolveWriteTarget`'s `CREATE_ONLY` branch (mirrored by `packageTarget()`
   * above) turns that into the new package's OWN name (`packageName`) plus
   * the caller's value carried separately as `superPackage`, and the gate
   * judges the allowlist against `superPackage` for a create (src/safety.ts)
   * — never `packageName`, which the SAP-owner and name-prefix rules
   * still judge on their own.
   */
  it("the superpackage is what the allowlist judges — not the new package's own name", async () => {
    adt.resolveWriteTarget.mockResolvedValue(packageTarget());
    adt.createPackage.mockResolvedValue(packageCreateResult());

    const h = await harness(
      // Only ZCOURSES (the superpackage) is allowlisted. ZSD_ORDER — the new
      // package's own name — deliberately is NOT: if any layer still judged
      // the allowlist against the own name (the bug this feature fixes), this
      // create would refuse.
      cfg({ readOnly: false, allowPackages: ["ZCOURSES"] }),
      new CountingClient(okResponse),
    );
    const assertSpy = vi.spyOn(h.srv.safety, "assert");
    const res = await call(h, "abap_write", pkgArgs());

    expect(res.isError).toBeFalsy();
    expect(adt.createPackage).toHaveBeenCalledTimes(1);
    // The options `createPackage` received (conn, target, OPTS) carry the
    // software component the caller supplied.
    expect(adt.createPackage.mock.calls[0]![2]).toMatchObject({ softwareComponent: "LOCAL" });

    // The caller's `package` really does flow through to `authorizeMutation`
    // as `packageName` — the wiring `targetFromInput` performs, unchanged.
    expect(adt.authorizeMutation.mock.calls[0]![3]).toMatchObject({ packageName: "ZCOURSES" });

    // The final gate assertion — the one `authorizeMutation`'s fake makes
    // after "resolving" through `resolveWriteTarget` — carries BOTH: the new
    // package's OWN name (what the SAP-owner/prefix rules judge) and its
    // superpackage (what the allowlist judges).
    const finalAssertCall = assertSpy.mock.calls.find(
      (c) => (c[1] as { packageName?: string } | undefined)?.packageName === "ZSD_ORDER",
    );
    expect(finalAssertCall).toBeDefined();
    expect(finalAssertCall![1] as { name?: string; superPackage?: string }).toMatchObject({
      name: "ZSD_ORDER",
      superPackage: "ZCOURSES",
    });
  });

  /**
   * The counterfactual half of the test above: allowlisting the new
   * package's OWN name is not sufficient once the superpackage is what the
   * allowlist actually judges — this is precisely the old bug (package
   * creation categorically unreachable, because a not-yet-created package's
   * own name can never already be in any finite allowlist) inverted into a
   * regression check the other direction.
   */
  it("allowlisting only the new package's own name is not enough on its own", async () => {
    adt.resolveWriteTarget.mockResolvedValue(packageTarget());

    const h = await harness(
      // ZSD_ORDER (own name) is allowlisted; ZCOURSES (the real superpackage
      // and container) is not.
      cfg({ readOnly: false, allowPackages: ["ZSD_ORDER"] }),
      new CountingClient(okResponse),
    );
    const err = errorOf(await call(h, "abap_write", pkgArgs()));

    expect(err.error).toBe("SAFETY_DENIED");
    expect(String(err.message)).toContain("ZCOURSES");
    expect(adt.createPackage).not.toHaveBeenCalled();
  });

  it("refuses a package create that carries `source`", async () => {
    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["ZCOURSES", "ZSD_ORDER"] }),
      new CountingClient(okResponse),
    );
    const err = errorOf(await call(h, "abap_write", pkgArgs({ source: "anything" })));
    expect(String(err.message)).toMatch(/package has no source/i);
    expect(adt.createPackage).not.toHaveBeenCalled();
  });

  it("refuses a package create with no software_component", async () => {
    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["ZCOURSES", "ZSD_ORDER"] }),
      new CountingClient(okResponse),
    );
    const { software_component: _drop, ...rest } = pkgArgs();
    const err = errorOf(await call(h, "abap_write", rest));
    expect(String(err.message)).toMatch(/software_component/);
    expect(adt.createPackage).not.toHaveBeenCalled();
  });

  it("refuses activate:true on a package", async () => {
    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["ZCOURSES", "ZSD_ORDER"] }),
      new CountingClient(okResponse),
    );
    const err = errorOf(await call(h, "abap_write", pkgArgs({ activate: true })));
    expect(String(err.message)).toMatch(/package cannot be activated/i);
    expect(adt.createPackage).not.toHaveBeenCalled();
  });

  // DEVC/K delete goes through the classrun bridge and IS
  // supported — a package can be refused only for cause (e.g. non-empty),
  // not categorically. This still checks the refusal propagates as-is
  // rather than being swallowed or silently rerouted to createPackage.
  it("a DEVC/K delete refusal (e.g. non-empty package) propagates from the write module, not silently routed", async () => {
    adt.resolveWriteTarget.mockResolvedValue(packageTarget({ exists: true }));
    adt.deleteObject.mockRejectedValue(
      new AbapError(
        "CHECK_FAILED",
        "Package ZSD_ORDER is not empty and was NOT deleted. It still contains: object R3TR CLAS ZCL_X.",
        { type: "DEVC/K", name: "ZSD_ORDER" },
      ),
    );

    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["ZSD_ORDER"] }),
      new CountingClient(okResponse),
    );
    const err = errorOf(
      await call(h, "abap_write", { object: "ZSD_ORDER", type: "DEVC/K", mode: "delete" }),
    );

    expect(err.error).toBe("CHECK_FAILED");
    expect(String(err.message)).toMatch(/is not empty and was NOT deleted/);
    expect(adt.createPackage).not.toHaveBeenCalled();
  });

  /**
   * THE load-bearing test for this feature, and the whole reason it exists:
   * creating a customer package beneath the appliance's REAL `COURSES`
   * superpackage.
   *
   * `isSapPackage("COURSES")` is TRUE and stays true — "C" is in
   * SAP_PACKAGE_PREFIXES and nothing here weakens it or excepts COURSES. The
   * create is allowed anyway because the SAP-owner check judges the NEW
   * package's own name (`ZSD_ORDER`), never its parent — a package's
   * `packageRef` is itself (src/safety.ts). COURSES must still be
   * ALLOWLISTED, though: it is the container the write actually lands in,
   * and that question is answered by the allowlist, not by `isSapPackage`.
   * These are two different rules judging two different things — this test
   * is the proof neither one has swallowed the other's job.
   */
  it("creates a Z package beneath the SAP-named, allowlisted COURSES — the SAP-owner rule never sees the parent", async () => {
    adt.resolveWriteTarget.mockResolvedValue(packageTarget({ superPackage: "COURSES" }));
    adt.createPackage.mockResolvedValue(packageCreateResult({ superPackage: "COURSES" }));

    const h = await harness(
      // COURSES must be allowlisted — it is the container being judged now.
      cfg({ readOnly: false, allowPackages: ["COURSES"] }),
      new CountingClient(okResponse),
    );
    const assertSpy = vi.spyOn(h.srv.safety, "assert");
    const res = await call(h, "abap_write", pkgArgs({ package: "COURSES" }));

    expect(res.isError).toBeFalsy();
    expect(adt.createPackage).toHaveBeenCalledTimes(1);

    // No gate assertion anywhere refused on COURSES's OWN SAP ownership — the
    // SAP-owner rule (`isSapPackage`) ran against ZSD_ORDER, never COURSES.
    for (const c of assertSpy.mock.calls) {
      expect((c[1] as { name?: string } | undefined)?.name).not.toBe("COURSES");
    }
    // And the parent really was carried through to the create as the superpackage.
    expect(adt.authorizeMutation.mock.calls[0]![3]).toMatchObject({ packageName: "COURSES" });
    expect(res.content[0]!.text).toMatch(/COURSES/);
  });

  /**
   * Counterpart to the test above: COURSES being SAP-owned by NAME does not
   * matter, but COURSES being ABSENT from the allowlist does — proving the
   * success above came from COURSES being allowlisted, not from the
   * allowlist being bypassed for SAP-named containers.
   */
  it("refuses the same create when COURSES is not allowlisted, even though its own name is fine", async () => {
    adt.resolveWriteTarget.mockResolvedValue(packageTarget({ superPackage: "COURSES" }));

    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["ZSD_ORDER"] }),
      new CountingClient(okResponse),
    );
    const err = errorOf(await call(h, "abap_write", pkgArgs({ package: "COURSES" })));

    expect(err.error).toBe("SAFETY_DENIED");
    expect(String(err.message)).toContain("COURSES");
    expect(adt.createPackage).not.toHaveBeenCalled();
  });

  /** The rule the own-name gating must NOT dissolve: a non-Z package is still refused. */
  it("still refuses a package whose OWN name fails the prefix rule", async () => {
    adt.resolveWriteTarget.mockResolvedValue(
      packageTarget({ name: "SD_ORDER", packageName: "SD_ORDER", superPackage: "COURSES" }),
    );

    const h = await harness(
      // COURSES is allowlisted too, so a failure here can only come from the
      // SAP-owner check on the new package's own name ("SD_ORDER" starts
      // with "S", a SAP prefix) — not from COURSES being outside the
      // allowlist. Isolates the rule under test the same way
      // test/safety.test.ts's "refuses a non-Z own name..." case does.
      cfg({ readOnly: false, allowPackages: ["Z*", "COURSES"] }),
      new CountingClient(okResponse),
    );
    const err = errorOf(
      await call(h, "abap_write", pkgArgs({ object: "SD_ORDER", package: "COURSES" })),
    );

    expect(err.error).toBe("SAFETY_DENIED");
    expect(String(err.message)).toMatch(/SAP-owned/);
    expect(adt.createPackage).not.toHaveBeenCalled();
  });

  /**
   * `software_component` is the ONLY thing deciding which create route
   * runs; this drives the `"HOME"` (bridge) path. The fake REJECTS so the
   * assertion is about routing, not the post-create verification — the
   * bridge's real success path is covered in test/package-create.test.ts.
   */
  it("a non-LOCAL software_component goes to the classrun bridge, and NEVER to the REST createPackage", async () => {
    adt.resolveWriteTarget.mockResolvedValue(packageTarget());
    adt.preflightPackageCorr.mockResolvedValue({ corrNr: "A4HK900123", source: "named" });
    adt.createPackageViaBridge.mockRejectedValue(
      new AbapError("CHECK_FAILED", "bridge reached (test marker)", { name: "ZSD_ORDER" }),
    );

    const h = await harness(
      // cfg()'s wildcard `allowTransports` — a pinned list would be
      // refused here since this file's `authorizeMutation` fake calls
      // `gate.assert` with no `corr` (read as auto-selected, safety.ts step
      // 10); the real transport judgement happens in `preflightPackageCorr`.
      cfg({ readOnly: false, allowPackages: ["ZCOURSES"] }),
      new CountingClient(okResponse),
    );
    const err = errorOf(await call(h, "abap_write", pkgArgs({ software_component: "HOME" })));

    expect(String(err.message)).toMatch(/bridge reached \(test marker\)/);
    expect(adt.createPackageViaBridge).toHaveBeenCalledTimes(1);
    expect(adt.createPackage).not.toHaveBeenCalled();
    expect(adt.writeObject).not.toHaveBeenCalled();

    // The caller's corr_nr isn't consulted directly here — it goes through
    // `preflightPackageCorr`, where the transport allowlist judges it. That
    // indirection is the point: the old path's CTS pre-flight answered
    // "local" for a package that doesn't exist yet, and threw corr_nr away.
    expect(adt.preflightPackageCorr).toHaveBeenCalledTimes(1);
    expect(adt.preflightPackageCorr.mock.calls[0]![2]).toMatchObject({ corrNr: "A4HK900123" });
    // And what the bridge was told to create is the caller's own request.
    expect(adt.createPackageViaBridge.mock.calls[0]![2]).toMatchObject({
      packageName: "ZSD_ORDER",
      superPackage: "ZCOURSES",
      softwareComponent: "HOME",
      corrNr: "A4HK900123",
    });
  });
});

describe("abap_write transport note", () => {
  const targetFor = (packageName: string) => ({
    spec: {} as never,
    type: "PROG/P",
    name: "ZMCP_DEMO",
    uri: "/sap/bc/adt/programs/programs/zmcp_demo",
    sourceUri: "/sap/bc/adt/programs/programs/zmcp_demo/source/main",
    packageName,
    description: "demo",
  });

  beforeEach(() => {
    // The global beforeEach clears all mocks; these three are the same clean
    // path every "writes, syntax-checks, then activates" test in the block
    // above programs, so the write path reaches the transport note at all.
    adt.checkSource.mockResolvedValue({ ok: true, messages: [], errors: 0, warnings: 0 });
    adt.activateObject.mockResolvedValue({
      ok: true,
      messages: [],
      errors: 0,
      warnings: 0,
      activated: true,
      inactive: [],
    });
  });

  it("a transportable write names the number it sent and does not claim abapsmith never releases", async () => {
    const target = targetFor("ZMCP");
    adt.resolveWriteTarget.mockResolvedValue(target);
    adt.writeObject.mockResolvedValue({
      target,
      created: false,
      changed: true,
      etag: "sha256:abc",
      transport: {
        status: "transport",
        required: true,
        corrNr: "A4HK900123",
        corrText: "abapsmith session 2026-08-01",
      },
    });

    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["ZMCP"] }),
      new CountingClient(okResponse),
    );
    const res = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      package: "ZMCP",
      source: "REPORT zmcp_demo.",
    });
    const text = res.content[0]!.text;

    expect(text).toContain("Transport A4HK900123");
    expect(text).toContain("abapsmith session 2026-08-01");
    expect(text).toContain("abap_write never releases a transport");
    expect(text).toContain("abap_transport_release");
    expect(text).toContain("ABAP_ALLOW_TRANSPORT_RELEASE");
    expect(text).toContain("did NOT re-read the request");

    // Both retired: `abap_transport_release` (src/tools/transport.ts) DOES
    // release a transport, via POST .../newreleasejobs, so "abapsmith never
    // releases a transport" was false. And no write path ever re-reads the
    // request to confirm the object landed in it, so "stays there until a
    // human releases it" asserted a guarantee the code never verified.
    expect(text).not.toContain("abapsmith never releases a transport");
    expect(text).not.toContain("stays there until a human releases it");
  });

  it("a byte-identical no-op is NOT reported as a local object", async () => {
    const target = targetFor("ZMCP");
    const reason =
      "the source was already identical, so this call took no lock and ran no transport " +
      "pre-check — nothing asked the ABAP system whether this object is transportable.";
    adt.resolveWriteTarget.mockResolvedValue(target);
    adt.writeObject.mockResolvedValue({
      target,
      created: false,
      changed: false,
      etag: "sha256:abc",
      previousEtag: "sha256:abc",
      transport: { status: "not-determined", required: false, reason },
    });

    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["ZMCP"] }),
      new CountingClient(okResponse),
    );
    const res = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      package: "ZMCP",
      source: "REPORT zmcp_demo.",
    });
    const text = res.content[0]!.text;

    // `writeObject` returns `status: "not-determined"` on the no-op path
    // without ever locking, so "local object" was a claim the code had no
    // evidence for — it never asked the transport question at all. The note
    // now switches on `status` directly and must report the reason verbatim.
    expect(text).not.toContain("Local object");
    expect(text).not.toContain("none ($TMP/local)");
    expect(text).toContain("Nothing was resolved");
    expect(text).toContain(reason);
    expect(text).toContain("n/a (nothing written, no transport resolved)");
  });

  it("a real local write still says so", async () => {
    const target = targetFor("$TMP");
    adt.resolveWriteTarget.mockResolvedValue(target);
    adt.writeObject.mockResolvedValue({
      target,
      created: true,
      changed: true,
      etag: "sha256:abc",
      transport: { status: "local", required: false },
    });

    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["$TMP"] }),
      new CountingClient(okResponse),
    );
    const res = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      package: "$TMP",
      source: "REPORT zmcp_demo.",
    });
    const text = res.content[0]!.text;

    expect(text).toContain("Local object ($TMP-style): the lock reported no transport");
    expect(text).toContain("none ($TMP/local)");
  });

  it("status: not-determined is never rendered as local, even when changed:true", async () => {
    // The old renderer inferred epistemic status from two proxy signals:
    // `!t.required` and the separate `changed` boolean. Only the no-op path
    // ever actually produced `{ required: false, changed: false }` together,
    // so the inference happened to be correct — but nothing in the types
    // enforced that pairing. This constructs the combination the old code
    // never saw in practice — `not-determined` (nobody asked the system)
    // together with `changed: true` (something WAS written) — to prove the
    // new renderer reads `status` directly instead of re-deriving it.
    const target = targetFor("ZMCP");
    const reason = "test-injected: nobody asked, even though the write went through.";
    adt.resolveWriteTarget.mockResolvedValue(target);
    adt.writeObject.mockResolvedValue({
      target,
      created: false,
      changed: true,
      etag: "sha256:abc",
      previousEtag: "sha256:abc",
      transport: { status: "not-determined", required: false, reason },
    });

    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["ZMCP"] }),
      new CountingClient(okResponse),
    );
    const res = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      package: "ZMCP",
      source: "REPORT zmcp_demo.",
    });
    const text = res.content[0]!.text;

    // The dangerous false claim the old two-signal code would have printed
    // here (`changed: true` used to select the "Local object" branch).
    expect(text).not.toContain("Local object");
    expect(text).not.toContain("none ($TMP/local)");
    // What the new code must say instead: nothing was resolved, and why.
    expect(text).toContain("Nothing was resolved");
    expect(text).toContain(reason);
  });
});

describe("abap_activate", () => {
  const target = {
    spec: {} as never,
    type: "CLAS/OC",
    name: "ZCL_MCP_DEMO",
    uri: "/sap/bc/adt/oo/classes/zcl_mcp_demo",
    sourceUri: "/sap/bc/adt/oo/classes/zcl_mcp_demo/source/main",
    packageName: "$TMP",
    description: "demo",
  };

  it("mode=check runs the check only, and works while read-only", async () => {
    adt.resolveWriteTarget.mockResolvedValue(target);
    adt.checkSource.mockResolvedValue({ ok: true, messages: [], errors: 0, warnings: 0 });

    const h = await harness(cfg(), new CountingClient(okResponse));
    const res = await call(h, "abap_activate", {
      object: "ZCL_MCP_DEMO",
      mode: "check",
      source: "CLASS zcl_mcp_demo DEFINITION.",
    });

    expect(res.isError).toBeFalsy();
    expect(adt.checkSource).toHaveBeenCalledTimes(1);
    expect(adt.activateObject).not.toHaveBeenCalled();
    expect(res.content[0]!.text).toMatch(/result: clean/);
  });

  it("discloses objects co-activated by the preaudit set", async () => {
    const activatableTarget = { ...target, packageSource: "server" as const, exists: true };
    adt.resolveWriteTarget.mockResolvedValue(activatableTarget);
    adt.activateObject.mockResolvedValue({
      ok: true,
      messages: [],
      errors: 0,
      warnings: 0,
      activated: true,
      inactive: [],
      preaudit: [
        {
          name: "ZCL_MCP_DEMO_HELPER",
          type: "CLAS/OC",
          uri: "/sap/bc/adt/oo/classes/zcl_mcp_demo_helper",
        },
        { name: "(unknown)", type: "(unknown)" },
      ],
    });

    const gate = { assert: vi.fn() } as unknown as SafetyGate;
    const conn = { cfg: { sid: "TST" } } as unknown as AbapConnection;

    const res = await abapActivate(conn, { object: "ZCL_MCP_DEMO" }, 100_000, gate);

    expect(res.text).toContain("# CO-ACTIVATED");
    expect(res.text).toContain("ZCL_MCP_DEMO_HELPER (CLAS/OC)");
    expect(res.text).toContain("1 more co-activated object");
    expect(res.text).not.toContain("(unknown) (unknown)");
  });
});

describe("abap_activate transport note", () => {
  // `transport.resolve()` is called directly inside `abapActivate`
  // (src/tools/activate.ts), not through a mocked `../src/adt/*`
  // function like the write path — so a real `SessionTransport`/HTTP round
  // trip isn't needed to pin this string, just a fake with the one method
  // the tool actually calls.
  const target = {
    spec: {} as never,
    type: "CLAS/OC",
    name: "ZCL_MCP_DEMO",
    uri: "/sap/bc/adt/oo/classes/zcl_mcp_demo",
    sourceUri: "/sap/bc/adt/oo/classes/zcl_mcp_demo/source/main",
    packageName: "ZMCP",
    packageSource: "server" as const,
    exists: true,
    description: "demo",
  };

  it("a transportable activation names the number it used and does not claim abapsmith never releases", async () => {
    adt.resolveWriteTarget.mockResolvedValue(target);
    // No `source` is passed to `abapActivate` below, and `mode` defaults to
    // "activate" — per the fix in src/tools/activate.ts, that combination now
    // skips `checkSource` entirely rather than feeding it a fabricated empty
    // string, so this mock is never consulted. Left unprogrammed (no
    // `mockResolvedValue`) on purpose: if the code path ever regressed to
    // calling it again, an unprogrammed mock returning `undefined` would break
    // the render step below, failing this test instead of silently passing.
    adt.activateObject.mockResolvedValue({
      ok: true,
      messages: [],
      errors: 0,
      warnings: 0,
      activated: true,
      inactive: [],
    });

    const transport: Pick<SessionTransport, "resolve"> = {
      resolve: vi.fn().mockResolvedValue({
        outcome: "transport",
        corrNr: "A4HK900123",
        created: false,
        pinned: true,
        source: "caller",
        reason: "test fixture",
      }),
    };
    const gate = { assert: vi.fn() } as unknown as SafetyGate;
    const conn = { cfg: { sid: "TST" } } as unknown as AbapConnection;

    const res = await abapActivate(
      conn,
      { object: "ZCL_MCP_DEMO" },
      100_000,
      gate,
      transport as SessionTransport,
    );
    const text = res.text;

    expect(text).toContain("activated under transport A4HK900123");
    expect(text).toContain("abap_activate never releases a transport");
    expect(text).toContain("abap_transport_release");
    expect(text).toContain("ABAP_ALLOW_TRANSPORT_RELEASE");

    // `abap_transport_release` (src/tools/transport.ts) DOES release a
    // transport, via POST .../newreleasejobs — see
    // test/http-guard-transport-release-policy.test.ts — so the old claim
    // ("abapsmith never releases a transport; it stays open until a human
    // releases it") was false for the server as a whole, not just unproven.
    expect(text).not.toContain("abapsmith never releases a transport");
    expect(text).not.toContain("it stays open until a human releases it");

    // The core assertion for the no-source fix: activating
    // with no `source` must go straight to `activateObject`, never through
    // `checkSource` — sending it `""` is what used to throw the library's
    // "mainUrl and content are required for syntax check" exception.
    expect(adt.checkSource).not.toHaveBeenCalled();
    expect(adt.activateObject).toHaveBeenCalledTimes(1);
  });
});

describe("abap_run", () => {
  const resolved = (over: Record<string, unknown> = {}) => ({
    system: "TST",
    type: "CLAS/OC",
    kind: "CLAS",
    label: "class",
    name: "ZCL_MCP_DEMO",
    uri: "/sap/bc/adt/oo/classes/zcl_mcp_demo",
    packageName: "$TMP",
    mode: "source",
    spec: {} as never,
    ...over,
  });

  it("routes a class to runClass", async () => {
    adt.resolveObject.mockResolvedValue(resolved());
    adt.runClass.mockResolvedValue({
      mode: "class",
      object: "ZCL_MCP_DEMO",
      output: "hello",
      lines: 1,
      durationMs: 42,
    });
    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["$TMP"] }),
      new CountingClient(okResponse),
    );
    const res = await call(h, "abap_run", { object: "ZCL_MCP_DEMO" });
    expect(adt.runClass).toHaveBeenCalledWith(expect.anything(), "ZCL_MCP_DEMO");
    expect(adt.runReport).not.toHaveBeenCalled();
    expect(res.content[0]!.text).toMatch(/hello/);
  });

  it("routes a report to runReport and names the bridge class", async () => {
    adt.resolveObject.mockResolvedValue(
      resolved({ type: "PROG/P", kind: "PROG", name: "ZMCP_REPORT" }),
    );
    adt.bridgeClassName.mockReturnValue("ZCL_ZMCP_RUN_ZMCP_REPORT");
    adt.runReport.mockResolvedValue({
      mode: "report",
      object: "ZMCP_REPORT",
      output: "line one",
      lines: 1,
      durationMs: 99,
      bridgeClass: "ZCL_MCP_RUN_ZMCP_REPORT",
      bridgeRefreshed: true,
    });
    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["$TMP"] }),
      new CountingClient(okResponse),
    );
    const res = await call(h, "abap_run", { object: "ZMCP_REPORT" });
    // `runReport` takes the gate as a third argument: the bridge class is a
    // real repository object created *inside* runReport, so the gate has to be
    // threaded down to it (src/adt/run.ts:689-693). Asserting it is passed is
    // stricter than the old two-argument form, not looser.
    //
    // The fourth argument is the selection-screen values. `runReport` defaults
    // it to `[]`, but the tool layer passes `input.parameters ?? []` explicitly
    // (src/tools/run.ts:151,170), so a run with no `parameters` must arrive as
    // an empty array and not as `undefined`. Pinning `[]` rather than
    // `expect.anything()` is what makes that distinction a test: `anything()`
    // does not match `undefined`, but it would also pass for a stray value, and
    // "no parameters were requested, so none were forwarded" is the claim.
    expect(adt.runReport).toHaveBeenCalledWith(
      expect.anything(),
      "ZMCP_REPORT",
      expect.anything(),
      [],
    );
    expect(res.content[0]!.text).toMatch(/ZCL_MCP_RUN_ZMCP_REPORT/);
  });

  /**
   * Running a report CREATES the bridge class, in $TMP, from inside
   * `runReport` — below the tool layer, where the safety gate is out of scope.
   * An operator who allowlisted only `ZFOO_*` would otherwise get an object
   * written to a package they never authorised.
   */
  it("refuses to run a report when the bridge class's package is not allowlisted", async () => {
    adt.resolveObject.mockResolvedValue(
      resolved({ type: "PROG/P", kind: "PROG", name: "ZFOO_REPORT", packageName: "ZFOO_PKG" }),
    );
    adt.bridgeClassName.mockReturnValue("ZCL_ZMCP_RUN_ZFOO_REPORT");
    const h = await harness(
      // The report itself is allowlisted; the bridge's $TMP is NOT.
      cfg({ readOnly: false, allowPackages: ["ZFOO_*"] }),
      new CountingClient(okResponse),
    );
    const res = await call(h, "abap_run", { object: "ZFOO_REPORT" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/\$TMP|allowlist/i);
    expect(adt.runReport).not.toHaveBeenCalled();
  });

  it("refuses a type that cannot be executed", async () => {
    adt.resolveObject.mockResolvedValue(
      resolved({ type: "TABL/DT", kind: "TABL", name: "ZMCP_TABLE", mode: "ddic" }),
    );
    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["$TMP"] }),
      new CountingClient(okResponse),
    );
    const err = errorOf(await call(h, "abap_run", { object: "ZMCP_TABLE" }));
    expect(err.error).toBe("UNSUPPORTED");
    expect(adt.runClass).not.toHaveBeenCalled();
    expect(adt.runReport).not.toHaveBeenCalled();
  });

  it("re-checks the gate against the resolved package before executing", async () => {
    adt.resolveObject.mockResolvedValue(resolved({ packageName: "SABP_TYPES" }));
    const h = await harness(
      cfg({ readOnly: false, allowPackages: ["$TMP"] }),
      new CountingClient(okResponse),
    );
    const err = errorOf(await call(h, "abap_run", { object: "ZCL_MCP_DEMO" }));
    expect(err.error).toBe("SAFETY_DENIED");
    expect(adt.runClass).not.toHaveBeenCalled();
  });
});

describe("ABAP_ALLOW_WRITE opt-in (config)", () => {
  const env = (over: Record<string, string> = {}) => ({
    ABAP_URL: "http://sap.invalid:50000",
    ABAP_USER: "U",
    ABAP_PASSWORD: "p",
    ...over,
  });

  it("stays read-only without the flag", () => {
    const c = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    expect(c.readOnly).toBe(true);
    expect(c.allowPackages).toEqual([]);
  });

  it("enables writes, defaults the allowlist to every package, and warns about both", () => {
    const warnings: string[] = [];
    const c = loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(c.readOnly).toBe(false);
    expect(c.allowPackages).toEqual(["*"]);
    // Default flipped to ["*"] — see test/config-name-prefixes.test.ts.
    expect(c.allowNamePrefixes).toEqual(["*"]);
    expect(warnings.join("\n")).toMatch(/writes.*ENABLED/i);
    expect(warnings.join("\n")).toMatch(/no ABAP_ALLOW_PACKAGES configured.*\[\*\]/);
  });

  it("keeps a configured allowlist and name prefixes", () => {
    const c = loadConfig({
      env: env({
        ABAP_ALLOW_WRITE: "1",
        ABAP_ALLOW_PACKAGES: "$TMP,ZFOO_*",
        ABAP_ALLOW_NAME_PREFIXES: "ZMCP_",
      }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.allowPackages).toEqual(["$TMP", "ZFOO_*"]);
    expect(c.allowNamePrefixes).toEqual(["ZMCP_"]);
  });

  it("never puts the password in the redacted projection", () => {
    const c = loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true", ABAP_PASSWORD: "s3cr3t-do-not-log" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(JSON.stringify(redactConfigSecrets(c))).not.toContain("s3cr3t-do-not-log");
  });
});

describe("tool surface", () => {
  /**
   * There is deliberately NO byte ceiling, no pinned schema total and no
   * per-tool byte budget here any more. All of that was removed on purpose.
   *
   * The machinery pinned an exact byte total for four config permutations, so
   * editing a single sentence in any tool description failed the build until
   * four constants were re-measured and re-pinned by hand. That cost was paid
   * on every unrelated change, and it pushed in exactly the wrong direction:
   * a description trimmed to hit a byte target moves the failure mode from
   * "test fails" to "model misuses the tool", which costs far more context,
   * over and over, than the schema bytes ever would.
   *
   * Schema size is still real — it is paid on every request of every session.
   * The live per-tool breakdown is printed to stderr below on every run, so
   * it can be watched without being enforced.
   *
   * What IS still asserted here is the surface itself, by name: which tools
   * exist, and which of them appear only behind a capability flag. Those
   * catch a tool silently entering or leaving the product, which is a real
   * defect, rather than catching prose that got one word longer.
   */
  it("registers exactly the expected tool surface, by name", async () => {
    // Fully-open config: every registration-gated tool must be present, not
    // just the read-only subset.
    const h = await harness(openCfg());
    const { tools } = await h.client.listTools();

    const size = (t: unknown) => JSON.stringify(t).length;
    const perTool = Object.fromEntries(tools.map((t) => [t.name, size(t)])) as Record<string, number>;

    // Informational only — no assertion rides on these numbers. Use it to see
    // what is actually driving schema size rather than trusting a number
    // recorded in a comment, which is always a stale snapshot.
    process.stderr.write(
      `[schema] ${tools.length} tools, total ${size(tools)} bytes: ${JSON.stringify(perTool)}\n`,
    );

    expect(tools.map((t) => t.name).sort()).toEqual([
      "abap_activate",
      "abap_atc",
      "abap_bopf",
      "abap_bopf_delete",
      "abap_bopf_edit",
      "abap_bopf_test",
      "abap_debug",
      "abap_debug_value",
      "abap_debug_vars",
      "abap_dumps",
      "abap_enh",
      "abap_fpm_read",
      "abap_journal",
      "abap_open_url",
      "abap_read",
      "abap_run",
      "abap_search",
      "abap_service",
      "abap_test",
      "abap_transport",
      "abap_transport_release",
      "abap_ui",
      "abap_write",
    ]);
  });

  /**
   * A caller had no way to learn which bridge-created types it could
   * never take back, short of reading source or hitting a live refusal.
   * DEVC/K is deletable/undoable (bridge delete, while empty). TRAN/T is
   * likewise deletable and undoable. VIEW/DV's clause is different in kind:
   * RS_CORR_INSERT now registers the view for every package, so the create
   * itself is no longer refused — the disclosure instead states the
   * corr_nr/package pairing the create enforces, plus the one limitation the
   * lift did not touch: a classic view has no ADT-readable collection, so
   * `abap_read` still can't confirm what the bridge just wrote. Asserted on
   * substance (which types + what's disclosed), not the exact sentence, so
   * rewording alone can't break this.
   */
  it("discloses TRAN/T as deletable and undoable, VIEW/DV's corr_nr/package pairing and its read-back limit, and DEVC/K as deletable only while empty", async () => {
    const h = await harness(openCfg());
    const { tools } = await h.client.listTools();
    const write = tools.find((t) => t.name === "abap_write");
    expect(write).toBeDefined();
    const desc = write!.description ?? "";

    const tranClause = desc.match(/[^.]*\bTRAN\/T\b[^.]*\./)?.[0] ?? "";
    expect(tranClause).toContain("TRAN/T");
    expect(tranClause).not.toContain("VIEW/DV");
    expect(tranClause).not.toContain("DEVC/K");
    expect(tranClause).toMatch(/deletable/i);
    expect(tranClause).toMatch(/undoable/i);

    const viewClause = desc.match(/[^.]*\bVIEW\/DV\b[^.]*\./)?.[0] ?? "";
    expect(viewClause).toContain("VIEW/DV");
    expect(viewClause).not.toContain("TRAN/T");
    expect(viewClause).not.toContain("DEVC/K");
    expect(viewClause).toMatch(/corr_nr/);
    expect(viewClause).toMatch(/transportable package/i);
    expect(viewClause).toMatch(/read back/i);
    expect(viewClause).toMatch(/abap_read/);
    // The old wording refused the create outright; the lift means no clause
    // in this tool's description gets to say that about VIEW/DV any more.
    expect(viewClause).not.toMatch(/refused/i);

    const devcClause = desc.match(/DEVC\/K[^.]*\./)?.[0] ?? "";
    expect(devcClause).toMatch(/delet/i);
    expect(devcClause).toMatch(/empty/i);
  });

  /**
   * `ABAP_ALLOW_WRITE` (or `ABAP_ALLOW_TRANSPORT_RELEASE`) named as THE
   * lever, unconditionally, is wrong advice on any `ABAP_MODE`-configured
   * deployment, where `src/config.ts` warns that variable "is set but
   * ignored" and never reads it (`ABAP_MODE` is the sole source of truth
   * there). `abap_transport`'s operation description has room to say so in
   * full (next test). `abap_test`'s and `abap_transport_release`'s
   * tool-level descriptions do not, after the slimming pass — so for those
   * two the ABAP_MODE-vs-legacy detail was moved to skills/abapsmith-orient's
   * "## Mode" section and is restated live in the refusal message itself
   * (`SafetyGate.assert`'s default hint, src/safety.ts:2352-2380, for
   * abap_test; `assertCeiling`'s release hint, src/tools/transport.ts:339
   * and :363-378, for abap_transport_release) — both name `ABAP_MODE` with
   * its live value first and fall back to the legacy flag only when
   * `ABAP_MODE` is unset. A caller who trips either gate still learns the
   * remedy for their own configuration at the moment they need it. What the
   * schema alone must keep promising is narrower, and is what these two
   * tests now pin instead.
   */
  it("describes abap_test's write gate as needing write access, leaving the ABAP_MODE-vs-legacy detail to the refusal message", async () => {
    const h = await harness(openCfg());
    const { tools } = await h.client.listTools();
    const test_ = tools.find((t) => t.name === "abap_test");
    expect(test_).toBeDefined();
    expect(test_!.description).toContain("Needs write access");
  });

  it("describes abap_transport's operation param as ABAP_MODE-first for both the write and admin-only delete ceilings", async () => {
    const h = await harness(openCfg());
    const { tools } = await h.client.listTools();
    const transport = tools.find((t) => t.name === "abap_transport");
    expect(transport).toBeDefined();
    const schema = transport?.inputSchema as
      | { properties?: Record<string, { description?: string }> }
      | undefined;
    const opDesc = schema?.properties?.operation?.description ?? "";
    expect(opDesc).toContain(
      "create/addUser/setOwner need write access (ABAP_MODE=edit or admin, or legacy " +
        "ABAP_ALLOW_WRITE=true when ABAP_MODE is unset)",
    );
    expect(opDesc).toContain(
      "delete additionally needs the admin-only transport-delete ceiling (ABAP_MODE=admin — no " +
        "legacy flag grants it)",
    );
  });

  it("states each abap_transport param's conditional requirement in its own description", async () => {
    const h = await harness(openCfg());
    const { tools } = await h.client.listTools();
    const transport = tools.find((t) => t.name === "abap_transport");
    expect(transport).toBeDefined();
    const schema = transport?.inputSchema as
      | { properties?: Record<string, { description?: string }> }
      | undefined;
    const props = schema?.properties ?? {};
    expect(props.transport?.description).toContain(
      "Required for operation=show/addUser/setOwner/delete",
    );
    expect(props.user?.description).toContain("Required for operation=addUser/setOwner");
    expect(props.object?.description).toContain("Required for operation=check");
    expect(props.package?.description).toContain("Required for operation=create");
    expect(props.description?.description).toContain("Required for operation=create");
  });

  it("states each abap_write bridge-create param's requirement in its own description", async () => {
    const h = await harness(openCfg());
    const { tools } = await h.client.listTools();
    const write = tools.find((t) => t.name === "abap_write");
    expect(write).toBeDefined();
    const schema = write?.inputSchema as
      | { properties?: Record<string, { description?: string }> }
      | undefined;
    const props = schema?.properties ?? {};
    expect(props.description?.description).toContain("Required to create a TRAN/T");
    expect(props.program?.description).toMatch(/TRAN\/T, required/);
    // The bridge create runs now (RS_CORR_INSERT registers every package), so
    // these two are plain "what to pass", pinned verbatim — no "required" or
    // "refused" framing left to assert, since neither field's absence alone
    // is what a caller gets refused for (that's corr_nr/package's job).
    expect(props.base_table?.description).toBe(
      "VIEW/DV create only: the single base table the view projects.",
    );
    expect(props.view_fields?.description).toBe(
      "VIEW/DV create only: base-table fields to project, in order.",
    );
  });

  it("derives abap_read's `type` not-readable list from the capabilities registry", async () => {
    const h = await harness(openCfg());
    const { tools } = await h.client.listTools();
    const read = tools.find((t) => t.name === "abap_read");
    expect(read).toBeDefined();
    const schema = read?.inputSchema as
      | { properties?: Record<string, { description?: string }> }
      | undefined;
    const desc = schema?.properties?.type?.description ?? "";
    for (const code of NON_READABLE_TYPES) expect(desc).toContain(code);
    expect(desc).toContain("VIEW/DV");
    expect(desc).toContain("TRAN/T");
    expect(desc).toContain("PROG/PT");
  });

  it("gives abap_read's tool description a copy-pasteable example call", async () => {
    const h = await harness(openCfg());
    const { tools } = await h.client.listTools();
    const read = tools.find((t) => t.name === "abap_read");
    expect(read).toBeDefined();
    expect(read!.description).toContain('{"object":"ZCL_FOO","type":"CLAS/OC"}');
  });

  it("derives abap_write's `type` not-writable list from the capabilities registry, excluding the activate-only types", async () => {
    const h = await harness(openCfg());
    const { tools } = await h.client.listTools();
    const write = tools.find((t) => t.name === "abap_write");
    expect(write).toBeDefined();
    const schema = write?.inputSchema as
      | { properties?: Record<string, { description?: string }> }
      | undefined;
    const desc = schema?.properties?.type?.description ?? "";
    for (const code of NON_WRITABLE_TYPES) expect(desc).toContain(code);
    expect(desc).not.toContain("ENHO/XH");
  });

  it("states abap_write's description/corr_nr/package param limits verbatim", async () => {
    const h = await harness(openCfg());
    const { tools } = await h.client.listTools();
    const write = tools.find((t) => t.name === "abap_write");
    expect(write).toBeDefined();
    const schema = write?.inputSchema as
      | { properties?: Record<string, { description?: string }> }
      | undefined;
    const props = schema?.properties ?? {};
    expect(props.description?.description).toContain("Required to create a TRAN/T");
    expect(props.description?.description).toContain("37");
    // corr_nr is now conditionally REQUIRED (a transportable VIEW/DV create)
    // as well as conditionally refused (TRAN/T create, either type's delete)
    // — pin the whole string so both halves of that contract stay honest.
    expect(props.corr_nr?.description).toBe(
      "Transport request. $TMP needs none. Required for a VIEW/DV create into a " +
        "transportable package. Refused on TRAN/T create and on VIEW/DV or TRAN/T delete.",
    );
    // package's VIEW/DV clause states the corr_nr/package pairing rule, not a
    // blanket refusal — pin it verbatim rather than substring-matching, since
    // a substring match would pass even if the rule reversed.
    expect(props.package?.description).toBe(
      "Package for a NEW object. Default $TMP. VIEW/DV: a transportable one needs corr_nr, " +
        "a $-package refuses it.",
    );
  });

  it("states abap_bopf_edit's `name` param's conditional requirement in its own description", async () => {
    const h = await harness(openCfg());
    const { tools } = await h.client.listTools();
    const bopfEdit = tools.find((t) => t.name === "abap_bopf_edit");
    expect(bopfEdit).toBeDefined();
    const schema = bopfEdit?.inputSchema as
      | { properties?: Record<string, { description?: string }> }
      | undefined;
    const props = schema?.properties ?? {};
    expect(props.name?.description).toContain(
      "Required except for create_bo/remove_node/set_node_flags/activate",
    );
  });

  it("states abap_journal's `entry` param's conditional requirement in its own description", async () => {
    const h = await harness(openCfg());
    const { tools } = await h.client.listTools();
    const journal = tools.find((t) => t.name === "abap_journal");
    expect(journal).toBeDefined();
    const schema = journal?.inputSchema as
      | { properties?: Record<string, { description?: string }> }
      | undefined;
    const props = schema?.properties ?? {};
    expect(props.entry?.description).toContain("Required for show and undo unless `object` is given");
  });

  it("states abap_dumps's `key` param's conditional requirement in its own description", async () => {
    const h = await harness(openCfg());
    const { tools } = await h.client.listTools();
    const dumps = tools.find((t) => t.name === "abap_dumps");
    expect(dumps).toBeDefined();
    const schema = dumps?.inputSchema as
      | { properties?: Record<string, { description?: string }> }
      | undefined;
    const props = schema?.properties ?? {};
    expect(props.key?.description).toMatch(/^show, required:/);
  });

  it("describes abap_transport_release's ceiling as separate from ordinary write access, leaving the ABAP_MODE-vs-legacy detail to the refusal message", async () => {
    const h = await harness(openCfg());
    const { tools } = await h.client.listTools();
    const release = tools.find((t) => t.name === "abap_transport_release");
    expect(release).toBeDefined();
    // See the comment above the abap_test write-gate test: the
    // ABAP_MODE=admin-first / ABAP_ALLOW_TRANSPORT_RELEASE-legacy-fallback
    // wording now lives in the refusal message and in abapsmith-orient's
    // "## Mode" section. What must survive here, so this still fails if
    // release is ever collapsed into ordinary write access, is that the
    // schema keeps calling out a SEPARATE ceiling.
    expect(release!.description).toContain(
      "Gated by a release ceiling separate from ordinary write access",
    );
  });

  /**
   * `abap_data_preview` reads real table rows, so it is gated at REGISTRATION
   * time on `ABAP_ALLOW_DATA_PREVIEW` — with the flag off the tool does not
   * exist on the surface at all. That gate is a safety control, not a
   * packaging detail, so it is asserted directly rather than inferred from a
   * byte count.
   */
  it("registers abap_data_preview only when ABAP_ALLOW_DATA_PREVIEW is set", async () => {
    const off = await harness(openCfg());
    expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain("abap_data_preview");

    const on = await harness(openCfg({ allowDataPreview: true }));
    expect((await on.client.listTools()).tools.map((t) => t.name)).toContain("abap_data_preview");
  });

  /**
   * `abap_dumps` has a two-tier PII gate. The flag does NOT gate the tool —
   * it gates one parameter: dump variable contents routinely hold real
   * business and personal data, so with `ABAP_ALLOW_DUMP_VARIABLES` off the
   * `variables` parameter is not advertised in the schema at all.
   *
   * That distinction used to be asserted as a byte delta (+252). It is
   * asserted directly now: the point was never that the schema grew by some
   * number, it was that an unadvertised parameter must not be advertised.
   * Checking the property by name says that, and does not drift when the
   * surrounding prose is edited.
   */
  it("advertises the abap_dumps `variables` parameter only when ABAP_ALLOW_DUMP_VARIABLES is set", async () => {
    const propsOf = async (config: Config) => {
      const h = await harness(config);
      const { tools } = await h.client.listTools();
      const dumps = tools.find((t) => t.name === "abap_dumps");
      expect(
        dumps,
        "abap_dumps must register regardless of ABAP_ALLOW_DUMP_VARIABLES — that flag widens its schema, " +
          "it does not gate the tool.",
      ).toBeDefined();
      const schema = dumps?.inputSchema as { properties?: Record<string, unknown> } | undefined;
      return Object.keys(schema?.properties ?? {});
    };

    expect(
      await propsOf(openCfg()),
      "tier-2 dump variables must NOT be advertised without the opt-in",
    ).not.toContain("variables");

    expect(
      await propsOf(openCfg({ allowDumpVariables: true })),
      "tier-2 dump variables must be advertised once the opt-in is set",
    ).toContain("variables");

    // The two flags are independent: the preview gate must not affect this one.
    expect(await propsOf(openCfg({ allowDataPreview: true, allowDumpVariables: true }))).toContain(
      "variables",
    );
  });

  /**
   * The MCP SDK hands a tool callback zod's PARSED output, and zod strips any
   * key the schema does not declare. So a field the core handler reads but the
   * registered schema omits does not fail, does not warn, and does not appear
   * anywhere in the request as received — it simply arrives `undefined`, and
   * the handler takes whatever branch `undefined` leads to.
   *
   * In `abap_write` that branch was the whole-object rewrite. `edit` and
   * `method` were both read by the core and neither was declared, so every
   * scoped edit silently became "replace the entire object with this
   * fragment". It shipped, twice, and was found by manual live testing rather
   * than by the test suite, because nothing in the type system objected:
   * the registration cast `args as never`, which is assignable to anything and
   * therefore checks nothing.
   *
   * The fix is the cast, not the schema — casting to the type DERIVED FROM the
   * registered schema (`args as ReadInput`, etc.) makes any future drift a
   * compile error at the exact call site. This test is the backstop for the
   * fix itself, since a cast is easy to weaken back under time pressure and
   * the failure it reintroduces is silent by construction. Ten registrations
   * are covered. If a new tool is added, it belongs in this list.
   */
  it("never casts tool args to `never` — that cast is what hid the abap_write splice defects", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const srcDir = fileURLToPath(new URL("../src/tools/", import.meta.url));
    const files = [
      "activate.ts",
      "debug-register.ts",
      "journal.ts",
      "read.ts",
      "run.ts",
      "search.ts",
      "test.ts",
      "write.ts",
    ];
    const offenders: string[] = [];
    for (const f of files) {
      const lines = readFileSync(srcDir + f, "utf8").split("\n");
      lines.forEach((line, i) => {
        // The literal cast, not the words in a comment explaining it.
        if (/\bargs as never\b/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      "`args as never` is banned in tool registrations: it is assignable to every parameter type, so it " +
        "silences the ONE check that catches a handler reading a field the registered zod schema does not " +
        "declare — and zod strips undeclared keys silently, so that drift has no runtime symptom either. " +
        "Cast to the schema-derived input type instead (`args as ReadInput`). See the doc comment above.",
    ).toEqual([]);
  });

  it("marks the mutating tools as not read-only", async () => {
    // Fully-open config: abap_write/abap_run are registration-gated on
    // canWrite now, so the default read-only cfg() would no longer register
    // them at all and this test would be checking `undefined` annotations
    // instead of `false` ones.
    const h = await harness(openCfg());
    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("abap_read")?.annotations?.readOnlyHint).toBe(true);
    for (const name of ["abap_write", "abap_activate", "abap_run", "abap_journal"]) {
      expect(byName.get(name)?.annotations?.readOnlyHint).toBe(false);
    }
    expect(byName.get("abap_write")?.annotations?.destructiveHint).toBe(true);
    // Activation cannot be undone (`undoBlocker` in src/adt/undo.ts refuses
    // every `activate` journal entry outright, and doc/LIMITATIONS/execution-and-undo.md says
    // the same to the operator), and it replaces whatever version was
    // previously active rather than merely adding to it — see the comment
    // on the `abap_activate` registration in src/tools/activate.ts.
    // `destructiveHint` should read `true` here for the same reason
    // it reads `true` on `abap_write`, which is strictly MORE reversible.
    expect(byName.get("abap_activate")?.annotations?.destructiveHint).toBe(true);
  });

  /**
   * Registration-time tool filtering. A read-only server must never even
   * ADVERTISE the mutating tools in `tools/list` — not just refuse them at
   * call time (that refusal is `SafetyGate`'s job, proven separately by the
   * "safety gate refuses writes before the network" suite above). This is
   * defense-in-depth on top of that: a smaller advertised surface is a
   * smaller surface an LLM can be tricked into reaching for.
   */
  describe("registration-time filtering", () => {
    const MUTATING_TOOLS = [
      "abap_write",
      "abap_run",
      "abap_test",
      "abap_fpm_read",
      "abap_bopf_test",
      "abap_bopf_edit",
      "abap_bopf_delete",
      "abap_transport_release",
    ];
    // `abap_enh` is deliberately NOT in this list: its `discover_hook_anchors`
    // submode makes no `SafetyGate` call at all (a genuinely ungated read),
    // so `src/server.ts` registers it unconditionally regardless of
    // `readOnly` — see the comment on `registerEnhancementTools` there and on
    // `resolveStaticCapabilities` in `src/config.ts`.
    const ALWAYS_REGISTERED = [
      "abap_read",
      "abap_search",
      "abap_bopf",
      "abap_debug",
      "abap_debug_vars",
      "abap_debug_value",
      "abap_activate",
      "abap_transport",
      "abap_journal",
      "abap_enh",
    ];

    it("excludes every mutating tool from tools/list on a read-only server", async () => {
      const h = await harness(cfg()); // read-only default
      const { tools } = await h.client.listTools();
      const names = new Set(tools.map((t) => t.name));

      for (const name of MUTATING_TOOLS) {
        expect(names.has(name), `read-only tools/list unexpectedly advertises ${name}`).toBe(false);
      }
      for (const name of ALWAYS_REGISTERED) {
        expect(names.has(name), `read-only tools/list is missing always-on tool ${name}`).toBe(true);
      }
    });

    it("includes every mutating tool from tools/list on a fully-open server", async () => {
      const h = await harness(openCfg());
      const { tools } = await h.client.listTools();
      const names = new Set(tools.map((t) => t.name));

      for (const name of [...MUTATING_TOOLS, ...ALWAYS_REGISTERED]) {
        expect(names.has(name), `fully-open tools/list is missing ${name}`).toBe(true);
      }
    });

    it("registers strictly fewer tools, and a strictly smaller tools/list, when read-only", async () => {
      const readOnly = await harness(cfg());
      const open = await harness(openCfg());
      const readOnlyTools = (await readOnly.client.listTools()).tools;
      const openTools = (await open.client.listTools()).tools;

      expect(readOnlyTools.length).toBeLessThan(openTools.length);
      const size = (t: unknown) => JSON.stringify(t).length;
      expect(size(readOnlyTools)).toBeLessThan(size(openTools));
    });

    it("does not register abap_transport_release when allowTransportRelease is false but writes are on", async () => {
      const h = await harness(cfg({ readOnly: false, allowTransportRelease: false }));
      const { tools } = await h.client.listTools();
      const names = new Set(tools.map((t) => t.name));
      expect(names.has("abap_transport_release")).toBe(false);
      // canWrite alone is enough for the wholesale write tools, though.
      expect(names.has("abap_write")).toBe(true);
      expect(names.has("abap_bopf_edit")).toBe(true);
    });
  });
});
