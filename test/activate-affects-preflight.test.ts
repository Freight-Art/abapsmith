/**
 * `abap_activate` refusing a well-formed `affects` identically to omitting it
 * (live-confirmed against A4H, 2026-08-12/13): a caller supplying
 * `{name, packageName}` — with or without the optional `spotName`/
 * `masterSystem` — against an ENHS/XS spot or an ENHO/XH implementation got
 * back the EXACT SAME §10.5 "supply `affects`" refusal as supplying nothing
 * at all. Net effect: `abap_activate`'s own doc-string ("Required to activate
 * ENHO/XH or ENHS/XS") advertised an unblock path that did not work — neither
 * type could be activated through this tool.
 *
 * Root cause, traced (not assumed): `registerActivateTools`'s handler
 * (src/tools/activate.ts) ran its zero-network preflight gate call —
 *
 *   deps.safety.assert("activate", preflight(a), { phase: "preflight", corr: {...} })
 *
 * — with NO `intent` field, ever, and its own `args` cast type didn't even
 * include `affects`. Since `isEnhancementType()` matches ENHO/XH and ENHS/XS,
 * safety.ts's §10.5 "no intent" branch (src/safety.ts ~line 1719) fired
 * unconditionally for those types, BEFORE `ensureConnected()` and BEFORE
 * `abapActivate()` ever ran — and `abapActivate()`'s own internals (which DO
 * correctly thread `input.affects` through `authorizeMutation` /
 * `enhancementIntentFor`, see src/adt/write.ts) never got a chance to prove
 * or disprove that plumbing, because the call never got that far. This is
 * the third instance of the "argument accepted by the schema, then silently
 * ignored before the gate ever sees it" defect class documented in
 * test/write.test.ts and as the "third instance" describe block later in
 * test/activate.test.ts (which fixed the SCHEMA gap and the FINAL-phase
 * plumbing, but not this — the PREFLIGHT gap in the registrar itself).
 *
 * The fix mirrors `registerWriteTools`'s already-correct pattern
 * (src/tools/write.ts): build an `EnhancementIntent` from the same
 * `preflight()` output via `enhancementPreflightIntent` (moved to
 * src/tools/preflight.ts so every registrar that imports `preflight()` for
 * its gate call sees this helper sitting right next to it) and pass it
 * alongside. The identical bug, and the identical fix, is also pinned here
 * for `abap_do action=activate` (src/tools/v2/handlers/do/activation.ts),
 * a second, independently-maintained call site wrapping the same
 * `abapActivate` core and the same `ActivateInput` schema.
 *
 * Everything in this file is a code-level claim about what the gate/registrar
 * do with given inputs — none of it has been re-verified against a live A4H
 * system. What remains a hypothesis is real ADT backend behaviour —
 * specifically: whether a correctly-plumbed intent that clears this
 * preflight gate then also clears `enhancementRules()`'s deeper checks and a
 * real `activateObject()` call against a real ENHO/XH or ENHS/XS object.
 */
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerActivateTools, type ActivateToolDeps } from "../src/tools/activate.js";
import { Journal } from "../src/journal.js";
import { enhancementPreflightIntent } from "../src/tools/preflight.js";
import { errorResult } from "../src/server.js";
import { SafetyGate } from "../src/safety.js";
import { fakeDoDeps, openDoGate } from "./helpers/do-deps-fake.js";

// --------------------------------------------------------- v1 registrar ---

/**
 * `deps.pool.withWrite` never calls the `fn` it is handed — it only counts
 * how many times it was reached, which is exactly the question under test:
 * did the zero-network preflight gate let the call through to the point
 * where a real connection would be opened? Nothing past that line is under
 * test in this describe block. Mirrors test/write.test.ts's
 * `harnessWithCounter` exactly.
 */
function harnessWithCounter(gate: SafetyGate) {
  let poolCalls = 0;
  const deps: ActivateToolDeps = {
    pool: {
      withWrite: async <T>(): Promise<T> => {
        poolCalls += 1;
        return { text: "stub: reached pool.withWrite (preflight passed)", truncated: false } as unknown as T;
      },
      withRead: async <T>(): Promise<T> => {
        throw new Error("not exercised by this describe block (mode=activate only)");
      },
    } as never,
    safety: gate,
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 50_000 },
    transport: undefined as never,
    // A DISABLED journal, not `undefined as never` like `transport` above:
    // `ActivateToolDeps.journal` is required and "journalling is
    // off" is modelled inside `Journal` itself, so this is what a real
    // read-only-journal deployment hands the registrar. Nothing in this
    // describe block reaches it — `pool.withWrite` never calls its callback —
    // but the harness stays honest about what the composition root passes.
    journal: new Journal({ dir: "/tmp/abapsmith-activate-preflight", enabled: false, maxEntries: 0, maxAgeDays: 0 }, "A4H"),
  };
  const server = new McpServer({ name: "activate-preflight-probe", version: "0.0.0" });
  registerActivateTools(server, deps);
  const call = async (args: Record<string, unknown>): Promise<string> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "activate-preflight-probe", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const res = await client.callTool({ name: "abap_activate", arguments: args });
    const first = Array.isArray(res.content) ? res.content[0] : undefined;
    const text = first && typeof first === "object" && "text" in first ? String((first as { text: unknown }).text) : "";
    return text;
  };
  return { call, calls: () => poolCalls };
}

const permissiveGate = () =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP"],
    allowEnhancements: true,
    enhanceTargets: "customer",
    originSystems: ["A4H"],
  });

const AFFECTS = { name: "ZTM_HW011_BADI", packageName: "$TMP", spotName: "ZTM_ES_HW011B_EP" };

describe("registerActivateTools: the tool's own preflight needs affects too", () => {
  it("refuses an ENHS/XS activate with no affects, naming the parameter — not an internal function", async () => {
    const { call, calls } = harnessWithCounter(permissiveGate());
    const text = await call({ object: "ZTM_ES_HW011B_EP", type: "ENHS/XS" });
    expect(text).toMatch(/SAFETY_DENIED/);
    expect(text).toMatch(/affects/);
    expect(text).not.toMatch(/SafetyGate\.evaluateIntent/);
    expect(calls()).toBe(0);
  });

  it("refuses an ENHO/XH activate with no affects, naming the parameter", async () => {
    const { call, calls } = harnessWithCounter(permissiveGate());
    const text = await call({ object: "ZTM_HW011_BADI_IMPL", type: "ENHO/XH" });
    expect(text).toMatch(/SAFETY_DENIED/);
    expect(text).toMatch(/affects/);
    expect(calls()).toBe(0);
  });

  it("passes preflight and reaches pool.withWrite for ENHS/XS once affects is supplied and the gate allows it", async () => {
    const { call, calls } = harnessWithCounter(permissiveGate());
    const text = await call({ object: "ZTM_ES_HW011B_EP", type: "ENHS/XS", affects: AFFECTS });
    expect(text).toBe("stub: reached pool.withWrite (preflight passed)");
    expect(calls()).toBe(1);
  });

  it("passes preflight and reaches pool.withWrite for ENHO/XH once affects is supplied and the gate allows it", async () => {
    const { call, calls } = harnessWithCounter(permissiveGate());
    const text = await call({ object: "ZTM_HW011_BADI_IMPL", type: "ENHO/XH", affects: AFFECTS });
    expect(text).toBe("stub: reached pool.withWrite (preflight passed)");
    expect(calls()).toBe(1);
  });

  it("also passes with only the required affects sub-fields (no spotName/masterSystem)", async () => {
    const { call, calls } = harnessWithCounter(permissiveGate());
    const text = await call({
      object: "ZTM_ES_HW011B_EP",
      type: "ENHS/XS",
      affects: { name: "ZTM_HW011_BADI", packageName: "$TMP" },
    });
    expect(text).toBe("stub: reached pool.withWrite (preflight passed)");
    expect(calls()).toBe(1);
  });

  /**
   * THE regression pin: same object, same type, same gate — the only
   * difference between these two calls is the presence of `affects`. Before
   * the fix, both calls produced the byte-identical refusal (the exact bug
   * report symptom); this proves supplying it now changes the outcome.
   */
  it("regression: supplying affects flips the outcome for an otherwise-identical call", async () => {
    const withoutAffects = harnessWithCounter(permissiveGate());
    const refused = await withoutAffects.call({ object: "ZTM_ES_HW011B_EP", type: "ENHS/XS" });

    const withAffects = harnessWithCounter(permissiveGate());
    const allowed = await withAffects.call({ object: "ZTM_ES_HW011B_EP", type: "ENHS/XS", affects: AFFECTS });

    expect(refused).toMatch(/SAFETY_DENIED/);
    expect(allowed).not.toMatch(/SAFETY_DENIED/);
    expect(refused).not.toBe(allowed);
  });

  it("still refuses when the gate's enhancement rules reject it, even with affects supplied — a DIFFERENT message than 'no affects'", async () => {
    // allowEnhancements unset — affects alone must not bypass the master switch.
    // This proves the intent actually REACHES enhancementRules() rather than
    // being silently dropped a second, different way: the refusal text is
    // the master-switch wording, not the "supply `affects`" wording.
    const closedGate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const { call, calls } = harnessWithCounter(closedGate);
    const text = await call({ object: "ZTM_ES_HW011B_EP", type: "ENHS/XS", affects: AFFECTS });
    expect(text).toMatch(/ENHANCEMENT_DISABLED|SAFETY_DENIED/);
    expect(text).not.toMatch(/cannot judge it from the artefact alone/);
    expect(calls()).toBe(0);
  });

  it("a non-enhancement activate is unaffected by any of this (no affects needed, no intent built)", async () => {
    const { call, calls } = harnessWithCounter(permissiveGate());
    const text = await call({ object: "ZCL_FOO", type: "CLAS/OC" });
    expect(text).not.toMatch(/SAFETY_DENIED/);
    expect(calls()).toBe(1);
  });

  it("mode=check is untouched by this fix: no affects needed even for an enhancement type (analyze is not a MUTATING_OP)", async () => {
    const { call, calls } = harnessWithCounter(permissiveGate());
    const text = await call({
      object: "ZTM_ES_HW011B_EP",
      type: "ENHS/XS",
      mode: "check",
      source: "ENHANCEMENT-SPOT ZTM_ES_HW011B_EP.\nENDENHANCEMENT-SPOT.",
    });
    expect(text).not.toMatch(/SAFETY_DENIED/);
    // mode=check runs on a READ slot, never withWrite.
    expect(calls()).toBe(0);
  });
});

/**
 * The §10.5 "no intent" vs "intent supplied but the artefact it names
 * doesn't match" distinction, pinned directly against `SafetyGate.evaluate()`
 * / `evaluateIntent()` so the wording is proven independent of any one call
 * site — mirrors test/write.test.ts's dedicated describe block for the first
 * message. `enhancementPreflightIntent` always names the SAME artefact it was
 * built for (its `name` comes from the same `preflight()` output the gate
 * call itself uses), so the "intent/artefact mismatch" branch is not
 * reachable through the registrar with a legitimate call — it exists to
 * catch a DIFFERENT bug (an intent authorising one artefact being reused to
 * write another), so it is pinned here directly against the gate instead.
 */
describe("SafetyGate §10.5: 'no intent' and 'intent names a different artefact' are distinct refusals", () => {
  const gate = () =>
    new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      allowEnhancements: true,
      enhanceTargets: "customer",
      originSystems: ["A4H"],
    });

  it("no intent at all: names `affects`, not an internal function", () => {
    const d = gate().evaluate("activate", { name: "ZENH_FOO", packageName: "$TMP", type: "ENHS/XS" });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("SAFETY_DENIED");
    expect(d.reason).toMatch(/affects/);
    expect(d.reason).not.toMatch(/SafetyGate\.evaluateIntent/);
    expect(d.rule).toBe("enhancement write needs an intent");
  });

  it("intent supplied but naming a DIFFERENT artefact than the one targeted: a distinctly different reason and rule", () => {
    const intent = enhancementPreflightIntent({ name: "ZENH_OTHER", type: "ENHS/XS", affects: AFFECTS });
    const d = gate().evaluate("activate", { name: "ZENH_FOO", packageName: "$TMP", type: "ENHS/XS" }, { intent });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("SAFETY_DENIED");
    expect(d.reason).toMatch(/ZENH_OTHER/);
    expect(d.reason).toMatch(/ZENH_FOO/);
    expect(d.reason).not.toMatch(/supply `affects`/);
    expect(d.rule).toBe("intent/artefact mismatch");
  });

  it("intent supplied, names the right artefact, gate allows it: reaches enhancementRules and is allowed", () => {
    const intent = enhancementPreflightIntent({ name: "ZENH_FOO", type: "ENHS/XS", affects: AFFECTS });
    const d = gate().evaluate("activate", { name: "ZENH_FOO", packageName: "$TMP", type: "ENHS/XS" }, { intent });
    expect(d.allowed).toBe(true);
  });
});

// ------------------------------------------------- v2 `abap_do action=activate` ---

/**
 * The second confirmed instance of the identical bug: `abap_do
 * action=activate` (src/tools/v2/handlers/do/activation.ts) wraps the same
 * v1 `abapActivate` core and the same v1 `ActivateInput` zod schema (which
 * DOES carry `affects`) but had its own, separately-maintained preflight
 * `assert()` call that never built an intent either. `abapActivate` itself
 * is mocked here (as tools-v2-do-activation.test.ts already does for this
 * module) purely so an ALLOWED case doesn't attempt a real network call —
 * the thing under test is whether the handler's preflight gate call reaches
 * (or refuses before reaching) that mocked core.
 */
vi.mock("../src/tools/activate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/activate.js")>()),
  abapActivate: vi.fn(async () => ({ text: "activated: true", truncated: false, estimatedTokens: 1 })),
}));

describe("abap_do action=activate: the handler's own preflight needs affects too", () => {
  it("refuses an ENHS/XS activate with no affects, and never calls abapActivate", async () => {
    const { abapActivate } = await import("../src/tools/activate.js");
    vi.mocked(abapActivate).mockClear();
    const { ACTIVATION_HANDLERS } = await import("../src/tools/v2/handlers/do/activation.js");
    const deps = fakeDoDeps({ safety: openDoGate() });

    await expect(
      ACTIVATION_HANDLERS.get("activate")!(
        { action: "activate", object: "ZTM_ES_HW011B_EP", args: { type: "ENHS/XS" } },
        deps,
      ),
    ).rejects.toMatchObject({ code: "SAFETY_DENIED" });
    expect(abapActivate).not.toHaveBeenCalled();
  });

  it("passes preflight and calls abapActivate once affects is supplied and the gate allows it", async () => {
    const { abapActivate } = await import("../src/tools/activate.js");
    vi.mocked(abapActivate).mockClear();
    const { ACTIVATION_HANDLERS } = await import("../src/tools/v2/handlers/do/activation.js");
    const deps = fakeDoDeps({ safety: openDoGate() });

    const result = await ACTIVATION_HANDLERS.get("activate")!(
      { action: "activate", object: "ZTM_ES_HW011B_EP", args: { type: "ENHS/XS", affects: AFFECTS } },
      deps,
    );

    expect(abapActivate).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("regression: same object/type/gate, only affects differs, and that alone flips the outcome", async () => {
    const { abapActivate } = await import("../src/tools/activate.js");
    vi.mocked(abapActivate).mockClear();
    const { ACTIVATION_HANDLERS } = await import("../src/tools/v2/handlers/do/activation.js");

    await expect(
      ACTIVATION_HANDLERS.get("activate")!(
        { action: "activate", object: "ZTM_HW011_BADI_IMPL", args: { type: "ENHO/XH" } },
        fakeDoDeps({ safety: openDoGate() }),
      ),
    ).rejects.toMatchObject({ code: "SAFETY_DENIED" });

    await expect(
      ACTIVATION_HANDLERS.get("activate")!(
        { action: "activate", object: "ZTM_HW011_BADI_IMPL", args: { type: "ENHO/XH", affects: AFFECTS } },
        fakeDoDeps({ safety: openDoGate() }),
      ),
    ).resolves.toMatchObject({ ok: true });
  });
});
