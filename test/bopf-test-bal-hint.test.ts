/**
 * Defect 4 (issue #108): `runBopfTest` (src/tools/bopf-test.ts) used to push
 * the BAL correlation line onto `buildResponse`'s `hints` array. `hints` is
 * only rendered by compact.ts inside a TRUNCATED/WINDOW notice — on an
 * ordinary, well-under-budget response (the common case) the line was
 * silently dropped. It must now come back as a `notes` entry, which
 * compact.ts always renders.
 *
 * The bridge run itself (`adt/bopf-runtime.js`'s `runBopfTest`, imported
 * here as `runBopfTestBridge` matching src/tools/bopf-test.ts's own alias)
 * is stubbed via a partial vi.mock so this test never touches the network
 * and controls `durationMs` deterministically. `deps.pool.withWrite` and
 * `deps.readModel` are hand-rolled fakes, the same shape the tool itself
 * declares as injectable (`BopfTestDeps`).
 */
import { describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import type { BopfTestResult } from "../src/adt/bopf-runtime.js";
import type { SessionPool } from "../src/adt/pool.js";
import { SafetyGate } from "../src/safety.js";

const bridgeStub = { result: {} as BopfTestResult };

vi.mock("../src/adt/bopf-runtime.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/bopf-runtime.js")>()),
  runBopfTest: async () => bridgeStub.result,
}));

const { runBopfTest } = await import("../src/tools/bopf-test.js");

function permissiveGate(): SafetyGate {
  return new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowNamePrefixes: ["*"],
    writesLockedOut: false,
  });
}

function fakePool(conn: AbapConnection): Pick<SessionPool, "withWrite"> {
  return {
    withWrite: async (_op, _objectUri, fn) => fn(conn),
  };
}

describe("runBopfTest: the BAL correlation line always reaches the caller (defect 4)", () => {
  it("appears in the rendered text on the normal, non-truncated fast path — not only when truncated", async () => {
    bridgeStub.result = {
      bo: "ZBOPF_ORDER",
      version: "active",
      bridgeClass: "ZFLUID_BOPF_TEST_BRIDGE",
      bridgeRefreshed: false,
      constantsInterface: "ZIF_BOPF_ORDER_C",
      durationMs: 1234,
      generateOnly: false,
      rejected: false,
      errors: 0,
      warnings: 0,
      rowsWritten: 0,
      outputComplete: true,
    };
    const conn = {} as AbapConnection;
    const deps = {
      pool: fakePool(conn) as SessionPool,
      safety: permissiveGate(),
      ensureConnected: async () => {},
      errorResult: (e: unknown) => {
        throw e;
      },
      cfg: { maxResponseChars: 50_000 },
      readModel: async () => ({
        name: "ZBOPF_ORDER",
        type: "BOBF",
        version: "active",
        nodes: [],
      }),
    };

    const res = await runBopfTest(deps as Parameters<typeof runBopfTest>[0], {
      bo: "ZBOPF_ORDER",
      scenario: { nodes: [{ node: "ROOT", fields: {} }] },
    });

    const text = (res.content[0] as { type: "text"; text: string }).text;
    // durationMs 1234ms rounds up to 2s, plus 5s slack (see the WHY comment
    // above `logLastSeconds` in bopf-test.ts) = 7.
    expect(text).toContain("Application log (BAL) entries this execution may have written");
    expect(text).toContain(
      '{"tool":"log","action":"read","args":{"last_seconds":7,"detail":"messages"}}',
    );
  });
});
