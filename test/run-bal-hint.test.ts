/**
 * Defect 4 (issue #108): `abapRun` used to push the BAL correlation line
 * onto `buildResponse`'s `hints` array. `hints` is only rendered by
 * compact.ts inside a TRUNCATED/WINDOW notice — on an ordinary, well-under-
 * budget response (the common case) the line was silently dropped and never
 * reached the caller. It must now come back as a `notes` entry, which
 * compact.ts always renders.
 *
 * `resolveObject` is stubbed the same way test/run-enhancement-kind-check.test.ts
 * stubs it. `runClass` is stubbed the same way, via a partial mock of
 * ../src/adt/run.js, so this test never touches the network and controls
 * `durationMs` deterministically. `conn` is `{}` — `checkActivation` fails
 * closed internally (it wraps its own body in try/catch and returns
 * "unknown" on any throw), so an empty connection is sufficient here; it is
 * not what this test is about.
 */
import { describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import type { RunResult } from "../src/adt/run.js";
import { SafetyGate } from "../src/safety.js";

const resolveStub = { object: {} as ResolvedObject };

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => resolveStub.object,
}));

const runStub = { result: {} as RunResult };

vi.mock("../src/adt/run.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/run.js")>()),
  runClass: async () => runStub.result,
}));

const { abapRun } = await import("../src/tools/run.js");

function resolved(over: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "CLAS/OC",
    kind: "CLAS",
    label: "Class",
    name: "ZCL_RUNNABLE",
    uri: "/sap/bc/adt/oo/classes/zcl_runnable",
    packageName: "$TMP",
    mode: "source",
    activation: "unknown",
    spec: {},
    ...over,
  } as unknown as ResolvedObject;
}

/** Permissive: same shape as test/run.test.ts's `allowingGate`. */
function permissiveGate(): SafetyGate {
  return new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowNamePrefixes: ["*"],
    writesLockedOut: false,
  });
}

const conn = { cfg: { sid: "TST" } } as unknown as AbapConnection;

describe("abapRun: the BAL correlation line always reaches the caller (defect 4)", () => {
  it("appears in the rendered text on the normal, non-truncated fast path — not only when truncated", async () => {
    resolveStub.object = resolved();
    runStub.result = {
      mode: "class",
      object: "ZCL_RUNNABLE",
      output: "hello",
      lines: 1,
      durationMs: 1234,
      droppedLines: 0,
      bodyBytes: 5,
      outputComplete: true,
    };
    const res = await abapRun(conn, { object: "ZCL_RUNNABLE" }, 50_000, permissiveGate());
    expect(res.truncated).toBe(false);
    // durationMs 1234ms rounds up to 2s, plus 5s slack (see run.ts's WHY comment) = 7.
    expect(res.text).toContain("Application log (BAL) entries this execution may have written");
    expect(res.text).toContain(
      '{"tool":"log","action":"read","args":{"last_seconds":7,"detail":"messages"}}',
    );
    // The genuine truncation hint must still be a hint, not a note — it only
    // makes sense read alongside the truncation notice.
    expect(res.text).not.toContain("Have the code print less");
  });
});
