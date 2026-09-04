/**
 * Per-group unit tests for
 * `src/tools/v2/handlers/do/activation.ts` (activate/run/test/undo) and
 * `execution.ts` (check) — the two group modules that both import
 * `abapActivate` from `src/tools/activate.js`.
 *
 * Pattern: mock only the top-level v1 orchestration function each handler
 * calls (`abapActivate`/`abapRun`/`abapTest`/`abapJournal`), keeping every
 * real helper (`preflight`, `writeGateKey`, `undoPreflightTarget`, the real
 * `SafetyGate`) in play, and assert the v1 function was called with the
 * exact v1 input shape the `object`/`args` bag should produce — this is
 * `test/tools.test.ts`'s `importOriginal`-spread pattern, applied to the v2
 * dispatch layer instead of the v1 registrars.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltResponse } from "../src/compact.js";
import { fakeDoDeps } from "./helpers/do-deps-fake.js";

vi.mock("../src/tools/activate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/activate.js")>()),
  abapActivate: vi.fn(),
}));
vi.mock("../src/tools/run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/run.js")>()),
  abapRun: vi.fn(),
}));
vi.mock("../src/tools/test.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/test.js")>()),
  abapTest: vi.fn(),
}));
vi.mock("../src/tools/journal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/journal.js")>()),
  abapJournal: vi.fn(),
}));

const okResponse = (text = "ok"): BuiltResponse => ({ text, truncated: false, estimatedTokens: 1 });

describe("abap_do activation group (activate/run/test/undo)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("activate: object maps to v1 `object`, mode forced to \"activate\"", async () => {
    const { abapActivate } = await import("../src/tools/activate.js");
    vi.mocked(abapActivate).mockResolvedValue(okResponse());
    const { ACTIVATION_HANDLERS } = await import("../src/tools/v2/handlers/do/activation.js");
    const deps = fakeDoDeps();

    await ACTIVATION_HANDLERS.get("activate")!(
      { action: "activate", object: "ZCL_FOO", args: {} },
      deps,
    );

    expect(abapActivate).toHaveBeenCalledTimes(1);
    const [, input] = vi.mocked(abapActivate).mock.calls[0]!;
    expect(input).toMatchObject({ object: "ZCL_FOO", mode: "activate" });
  });

  it("activate: object and args.object disagreeing throws BAD_INPUT, never silently picks a winner", async () => {
    const { ACTIVATION_HANDLERS } = await import("../src/tools/v2/handlers/do/activation.js");
    const deps = fakeDoDeps();

    await expect(
      ACTIVATION_HANDLERS.get("activate")!(
        { action: "activate", object: "ZCL_FOO", args: { object: "ZCL_BAR" } },
        deps,
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
  });

  it("run: uses a WRITE pool slot, not a read slot", async () => {
    const { abapRun } = await import("../src/tools/run.js");
    vi.mocked(abapRun).mockResolvedValue(okResponse());
    const { ACTIVATION_HANDLERS } = await import("../src/tools/v2/handlers/do/activation.js");

    const withRead = vi.fn();
    const withWrite = vi.fn((_op: string, _uri: unknown, fn: (c: unknown) => unknown) => fn({}));
    const deps = fakeDoDeps({ pool: { withRead, withWrite, primary: () => ({}), reserveDebug: async () => ({}) } as never });

    await ACTIVATION_HANDLERS.get("run")!({ action: "run", object: "ZCL_FOO", args: {} }, deps);

    expect(withWrite).toHaveBeenCalledTimes(1);
    expect(withWrite).toHaveBeenCalledWith("abap_run", undefined, expect.any(Function));
    expect(withRead).not.toHaveBeenCalled();
    expect(abapRun).toHaveBeenCalledTimes(1);
    const [, input] = vi.mocked(abapRun).mock.calls[0]!;
    expect(input).toMatchObject({ object: "ZCL_FOO" });
  });

  it("test: uses a WRITE pool slot and maps object -> v1 object", async () => {
    const { abapTest } = await import("../src/tools/test.js");
    vi.mocked(abapTest).mockResolvedValue(okResponse());
    const { ACTIVATION_HANDLERS } = await import("../src/tools/v2/handlers/do/activation.js");

    const withRead = vi.fn();
    const withWrite = vi.fn((_op: string, _uri: unknown, fn: (c: unknown) => unknown) => fn({}));
    const deps = fakeDoDeps({ pool: { withRead, withWrite, primary: () => ({}), reserveDebug: async () => ({}) } as never });

    await ACTIVATION_HANDLERS.get("test")!({ action: "test", object: "ZCL_FOO", args: { risk_level: "harmless" } }, deps);

    expect(withWrite).toHaveBeenCalledTimes(1);
    expect(withWrite).toHaveBeenCalledWith("abap_test", undefined, expect.any(Function));
    expect(withRead).not.toHaveBeenCalled();
    const [, input] = vi.mocked(abapTest).mock.calls[0]!;
    expect(input).toMatchObject({ object: "ZCL_FOO", risk_level: "harmless" });
  });

  it("undo: object maps to v1 `object`, mode forced to \"undo\"", async () => {
    const { abapJournal } = await import("../src/tools/journal.js");
    vi.mocked(abapJournal).mockResolvedValue(okResponse());
    const { ACTIVATION_HANDLERS } = await import("../src/tools/v2/handlers/do/activation.js");
    const deps = fakeDoDeps();

    // No matching journal entry exists (the journal is disabled/empty in this
    // fake), so undoPreflightTarget resolves nothing and the preflight gate
    // check falls back to `{ name: input.object ?? "" }` — a customer-namespace
    // name is required for that fallback to clear the gate.
    await ACTIVATION_HANDLERS.get("undo")!({ action: "undo", object: "ZCL_FOO", args: {} }, deps);

    expect(abapJournal).toHaveBeenCalledTimes(1);
    const [, input] = vi.mocked(abapJournal).mock.calls[0]!;
    expect(input).toMatchObject({ object: "ZCL_FOO", mode: "undo" });
  });
});

/**
 * `parseV1`'s unknown-key guard (src/tools/v2/handlers/do/shared.ts) — the
 * defect fix for silently-stripped `args` keys. Driven through the activation
 * group because `abap_do`'s `args` is an open record: a misspelled key clears
 * the tool schema, reaches the handler, and (before the fix) was dropped by
 * zod's stripping `z.object`, leaving an untransported activation reporting
 * `ok: true`. The guard is one diff against the v1 schema's own shape inside
 * `parseV1`, so it covers all 45 actions, not just this one.
 */
describe("abap_do args unknown-key rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an unrecognised args key, naming it and the accepted keys, and never calls v1", async () => {
    const { abapActivate } = await import("../src/tools/activate.js");
    vi.mocked(abapActivate).mockResolvedValue(okResponse());
    const { ACTIVATION_HANDLERS } = await import("../src/tools/v2/handlers/do/activation.js");
    const deps = fakeDoDeps();

    // `corr` instead of `corr_nr`: the transport assignment used to vanish.
    await expect(
      ACTIVATION_HANDLERS.get("activate")!(
        { action: "activate", object: "ZCL_FOO", args: { corr: "A4HK900123" } },
        deps,
      ),
    ).rejects.toMatchObject({
      code: "BAD_INPUT",
      message: expect.stringContaining('"corr"') as unknown as string,
    });

    await expect(
      ACTIVATION_HANDLERS.get("activate")!(
        { action: "activate", object: "ZCL_FOO", args: { corr: "A4HK900123" } },
        deps,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("corr_nr") as unknown as string,
    });

    expect(abapActivate).not.toHaveBeenCalled();
  });

  it("still accepts every key the v1 schema declares", async () => {
    const { abapActivate } = await import("../src/tools/activate.js");
    vi.mocked(abapActivate).mockResolvedValue(okResponse());
    const { ACTIVATION_HANDLERS } = await import("../src/tools/v2/handlers/do/activation.js");
    const deps = fakeDoDeps();

    await ACTIVATION_HANDLERS.get("activate")!(
      { action: "activate", object: "ZCL_FOO", args: { corr_nr: "A4HK900123", type: "CLAS/OC" } },
      deps,
    );

    const [, input] = vi.mocked(abapActivate).mock.calls[0]!;
    expect(input).toMatchObject({ object: "ZCL_FOO", mode: "activate", corr_nr: "A4HK900123", type: "CLAS/OC" });
  });
});

describe("abap_do execution group (check)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("check: uses a READ pool slot (checkruns write nothing), mode forced to \"check\"", async () => {
    const { abapActivate } = await import("../src/tools/activate.js");
    vi.mocked(abapActivate).mockResolvedValue(okResponse());
    const { EXECUTION_HANDLERS } = await import("../src/tools/v2/handlers/do/execution.js");

    const withRead = vi.fn((_op: string, fn: (c: unknown) => unknown) => fn({}));
    const withWrite = vi.fn();
    const deps = fakeDoDeps({ pool: { withRead, withWrite, primary: () => ({}), reserveDebug: async () => ({}) } as never });

    await EXECUTION_HANDLERS.get("check")!({ action: "check", object: "ZCL_FOO", args: {} }, deps);

    expect(withRead).toHaveBeenCalledTimes(1);
    expect(withWrite).not.toHaveBeenCalled();
    const [, input] = vi.mocked(abapActivate).mock.calls[0]!;
    expect(input).toMatchObject({ object: "ZCL_FOO", mode: "check" });
  });

  it("check: available even under a read-only SafetyGate (classified \"analyze\", not \"activate\")", async () => {
    const { abapActivate } = await import("../src/tools/activate.js");
    vi.mocked(abapActivate).mockResolvedValue(okResponse());
    const { EXECUTION_HANDLERS } = await import("../src/tools/v2/handlers/do/execution.js");
    const { closedDoGate } = await import("./helpers/do-deps-fake.js");

    // closedDoGate() is readOnly + allowPackages:[] — "analyze" ops are still
    // permitted under read-only per src/safety.ts's own op classification;
    // this asserts execution.ts really does classify `check` that way rather
    // than as a write, which would refuse under this gate.
    const deps = fakeDoDeps({ safety: closedDoGate() });

    await expect(
      EXECUTION_HANDLERS.get("check")!({ action: "check", object: "ZCL_FOO", args: {} }, deps),
    ).resolves.toBeDefined();
  });
});
