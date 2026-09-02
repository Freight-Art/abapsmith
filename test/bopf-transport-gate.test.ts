/**
 * `SafetyGate.evaluate()` step 10, and the BOPF callers that feed it.
 *
 * Before this fix, any gate call that named no `corr` (the default
 * `EvaluateOptions`) had step 10 fabricate `{kind:"transport", corrNr:"auto",
 * source:"auto"}` to judge — even for a target that would never actually use
 * a transport. Under an unset/wildcard `ABAP_ALLOW_TRANSPORTS` that fabricated
 * value is harmless (it always matches), which is exactly how the bug went
 * unnoticed: a later change flipped the unset default to `["*"]`, so every test
 * written under default config short-circuits step 10 before reaching this
 * branch at all. Every allowlist test below therefore pins `allowTransports`
 * explicitly to something other than `"*"`/`"auto"`, and every target's
 * package name is deliberately non-`$`-prefixed (`needsTransport` requires
 * both), so the tests actually exercise the branch they claim to.
 *
 * Fake TRKORR values below (`ZTMK900123`) are placeholders, not a real
 * transport number from any issue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FakeAdtServer, __resetFakeAdtCounters, bopfStore, activationRoute, type FakeRoute } from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import type { SessionPool } from "../src/adt/pool.js";
import { SafetyGate, type EvaluateOptions, type Operation } from "../src/safety.js";
import { createBusinessObject, putModel } from "../src/adt/bopf.js";
import { runBopfEdit, type BopfRunDeps } from "../src/tools/bopf.js";

// --------------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");
/** ZBOPF_PRB1, inactive, root-node-only, package $TMP — the just-created shape. */
const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");

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

/** A `SessionPool` that just forwards straight onto one wired connection — same idiom as test/bopf-tools.test.ts's fakePool. */
function fakePool(conn: AbapConnection): SessionPool {
  return {
    withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    withWrite: <T,>(_op: string, _objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    reserveDebug: () => {
      throw new Error("reserveDebug: not used by any BOPF tool, and not implemented in this fake.");
    },
  } as unknown as SessionPool;
}

function depsFor(conn: AbapConnection, safety: SafetyGate, transport: SessionTransport = localTransport()): BopfRunDeps {
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
    kind: "transport",
    required: true,
    mustSupplyCorrNr: true,
    serverWouldFabricate: false,
    ...overrides,
  }) as unknown as TrRequirement;

/** A `$TMP`-shaped local package: `trRequirement` reports `kind: "local"`, so `resolve()` is a no-HTTP `not-needed`. */
const localTransport = (): SessionTransport =>
  new SessionTransport({
    allowTransports: ["auto"],
    cts: { trRequirement: vi.fn(async () => fakeReq({ kind: "local" })) },
  });

/** Mints a fresh `AuthorizedTarget<"write">` from a fresh wide-open gate. */
const authWrite = (name: string, packageName = "$TMP") =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"] }).authorize("write", { name, packageName, type: "BOBF" });

function okText(result: CallToolResult): string {
  expect(result.isError).toBeFalsy();
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return text.text;
}

function catchErr(fn: () => void): AbapError {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected the call to throw");
}

/** Captures every `gate.assert` call — also captures `authorize()`, since `authorize()` calls `this.assert` internally. Same pattern as test/ddic-bridge-mutation.test.ts's RecordingGate. */
class RecordingGate extends SafetyGate {
  readonly seen: Array<{ op: Operation; opts: EvaluateOptions | undefined }> = [];
  override assert(
    op: Parameters<SafetyGate["assert"]>[0],
    obj?: Parameters<SafetyGate["assert"]>[1],
    opts?: Parameters<SafetyGate["assert"]>[2],
  ): void {
    this.seen.push({ op, opts });
    super.assert(op, obj, opts);
  }
}

// ===========================================================================

describe("SafetyGate step 10: no fabricated corr for a caller who names none", () => {
  const target = { name: "ZBOPF_TEST1", packageName: "ZBOPF_PKG", type: "BOBF" };

  it('ANTI-FALSE-PASS CONTROL: the pre-fix call shape (no corr at all) is refused by a pinned allowlist naming "auto" — proves this config actually reaches step 10', () => {
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["ZBOPF_*"], allowTransports: ["ZTMK900123"] });
    const err = catchErr(() => gate.assert("activate", target, {}));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toContain("auto");
    expect(err.details.rule).toBe("transport allowlist");
  });

  it('corr: {kind:"unresolved"} defers to the post-resolution check instead of judging a fabricated value', () => {
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["ZBOPF_*"], allowTransports: ["ZTMK900123"] });
    expect(() => gate.assert("activate", target, { corr: { kind: "unresolved" } })).not.toThrow();
  });

  it('corr: {kind:"local"} skips the allowlist outright', () => {
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["ZBOPF_*"], allowTransports: ["ZTMK900123"] });
    expect(() => gate.assert("activate", target, { corr: { kind: "local" } })).not.toThrow();
  });

  it('fail-closed is preserved: an explicitly empty allowlist still refuses {kind:"unresolved"}', () => {
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["ZBOPF_*"], allowTransports: [] });
    const err = catchErr(() => gate.assert("activate", target, { corr: { kind: "unresolved" } }));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details.rule).toBe("transport allowlist (fail closed)");
  });

  it("passing a real corr through does not neuter the allowlist: a named transport not on the pinned list is still refused", () => {
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["ZBOPF_*"], allowTransports: ["ZTMK900123"] });
    const err = catchErr(() =>
      gate.assert("activate", target, { corr: { kind: "transport", corrNr: "ZTMK900999", source: "named" } }),
    );
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details.rule).toBe("transport allowlist");
    expect(err.message).toContain("ZTMK900999");
  });
});

// ===========================================================================

describe("createBusinessObject/putModel resolve their own corr instead of leaving the caller to fabricate one", () => {
  it('createBusinessObject returns corr: {kind:"local"} for a local-package create', async () => {
    const store = bopfStore();
    const { conn } = await wired([store.route]);

    const created = await createBusinessObject(
      conn,
      localTransport(),
      { name: "ZBOPF_NEW1", packageName: "$TMP" },
      authWrite("ZBOPF_NEW1"),
    );
    expect(created.corr).toEqual({ kind: "local" });
  });

  it('putModel returns corr: {kind:"local"} for a local-package write', async () => {
    const store = bopfStore();
    const { conn } = await wired([store.route]);
    await createBusinessObject(conn, localTransport(), { name: "ZBOPF_NEW1", packageName: "$TMP" }, authWrite("ZBOPF_NEW1"));

    const result = await conn.withStatefulSession((session) =>
      putModel(conn, session, "ZBOPF_NEW1", (xml) => xml, authWrite("ZBOPF_NEW1")),
    );
    expect(result.corr).toEqual({ kind: "local" });
  });
});

// ===========================================================================

describe("runBopfEdit create_bo threads the corr each gate call actually resolved", () => {
  it("create_bo with activate:true: both preflight asserts and the final write authorize defer, and the final activate assert carries createBusinessObject's own resolved corr — not a fabrication", async () => {
    const store = bopfStore();
    const { conn } = await wired([store.route, activationRoute({})]);
    const gate = new RecordingGate({ readOnly: false, allowPackages: ["*"] });
    const deps = depsFor(conn, gate);

    const result = await runBopfEdit(deps, {
      bo: "ZBOPF_NEW2",
      operation: "create_bo",
      package: "$TMP",
      activate: true,
    });

    expect(result.isError).toBeFalsy();
    expect(gate.seen.map((s) => s.op)).toEqual(["write", "activate", "write", "activate"]);
    expect(gate.seen[0]?.opts).toEqual({ phase: "preflight", corr: { kind: "unresolved" } });
    expect(gate.seen[1]?.opts).toEqual({ phase: "preflight", corr: { kind: "unresolved" } });
    expect(gate.seen[2]?.opts).toEqual({ corr: { kind: "unresolved" } });
    expect(gate.seen[3]?.opts).toEqual({ corr: { kind: "local" } });
  });
});

describe("runBopfEdit edit path: the final activate corr reflects what actually resolved, including when nothing did", () => {
  it("a mutating operation with activate:true: the final activate assert carries putModel's own resolved corr", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired([store.route, activationRoute({})]);
    const gate = new RecordingGate({ readOnly: false, allowPackages: ["*"] });
    const deps = depsFor(conn, gate);

    const result = await runBopfEdit(deps, {
      bo: "ZBOPF_PRB1",
      operation: "set_node_flags",
      node: "ROOT",
      spec: { updateEnabled: false },
      activate: true,
    });

    expect(result.isError).toBeFalsy();
    expect(gate.seen.map((s) => s.op)).toEqual(["write", "activate", "write", "activate"]);
    expect(gate.seen[3]?.opts).toEqual({ corr: { kind: "local" } });
  });

  it('operation: "activate" alone resolves no transport of its own: the final activate assert stays {kind:"unresolved"} — a documented gap, not an oversight', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired([store.route, activationRoute({})]);
    const gate = new RecordingGate({ readOnly: false, allowPackages: ["*"] });
    const deps = depsFor(conn, gate);

    const result = await runBopfEdit(deps, { bo: "ZBOPF_PRB1", operation: "activate" });

    expect(result.isError).toBeFalsy();
    expect(gate.seen.map((s) => s.op)).toEqual(["write", "activate", "write", "activate"]);
    expect(gate.seen[3]?.opts).toEqual({ corr: { kind: "unresolved" } });
  });
});

// ===========================================================================

describe("end-to-end: a pinned allowlist no longer refuses create_bo over a transport it never asked for", () => {
  it("create_bo + activate:true against a non-$ package succeeds under ABAP_ALLOW_TRANSPORTS pinned to one specific transport", async () => {
    // Pre-fix, the zero-network preflight write assert at the top of
    // runBopfEdit (no corr) fabricated "auto", and this exact allowlist —
    // pinned, not containing "auto" — refused it SAFETY_DENIED before any
    // network call, even though the write was always going to resolve local.
    // Post-fix it defers instead, and the create actually proceeds.
    const store = bopfStore();
    const { conn } = await wired([store.route, activationRoute({})]);
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["ZBOPF_*"], allowTransports: ["ZTMK900123"] });
    const deps = depsFor(conn, gate);

    const result = await runBopfEdit(deps, {
      bo: "ZBOPF_NEW3",
      operation: "create_bo",
      package: "ZBOPF_PKG",
      activate: true,
    });

    expect(okText(result)).toContain("ZBOPF_NEW3");
  });
});
