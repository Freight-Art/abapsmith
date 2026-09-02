/**
 * `src/tools/bopf-test.ts` — the `abap_bopf_test` half of the silent-unknown-
 * key defect: an unrecognised key inside `scenario` (or a `scenario.nodes[i]` entry) used to
 * vanish silently, because `bopfTestInputSchema`'s `scenario`/node-entry
 * objects were plain `z.object`s and zod's default "strip" behaviour drops
 * unknown keys before the handler ever runs. The reported case:
 * `scenario.actions` produced a normal successful test run in which the
 * actions simply never executed.
 *
 * `validateBopfTestScenario` is the fix's single entry point (called first
 * thing in `runBopfTest`, before any network access) — exercised directly for
 * the naming/acceptance assertions, matching `test/bopf-spec-key-validation.
 * test.ts`'s idiom for the sibling `abap_bopf_edit` half of the same issue.
 * The `runBopfTest` tests additionally prove the refusal is wired into the
 * real handler and happens before any deps (pool/readModel/safety) are ever
 * touched — those are stubbed to throw if called at all.
 */
import { describe, expect, it } from "vitest";
import { isAbapError } from "../src/adt/errors.js";
import type { SafetyGate } from "../src/safety.js";
import type { SessionPool } from "../src/adt/pool.js";
import {
  bopfTestInputSchema,
  runBopfTest,
  validateBopfTestScenario,
  type BopfTestDeps,
  type BopfTestInput,
} from "../src/tools/bopf-test.js";

function expectBadInput(fn: () => unknown): Error & { code?: string } {
  let threw: unknown;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeDefined();
  expect(isAbapError(threw)).toBe(true);
  if (isAbapError(threw)) expect(threw.code).toBe("BAD_INPUT");
  return threw as Error & { code?: string };
}

/** A `BopfTestDeps` where every deps call throws — proves a refusal happens before any of them run. */
function throwingDeps(): BopfTestDeps {
  const boom = (label: string) => () => {
    throw new Error(`unexpected call reached deps.${label}`);
  };
  return {
    pool: {
      withWrite: boom("pool.withWrite"),
      withRead: boom("pool.withRead"),
      reserveDebug: boom("pool.reserveDebug"),
    } as unknown as SessionPool,
    safety: { assert: boom("safety.assert") } as unknown as SafetyGate,
    ensureConnected: boom("ensureConnected") as unknown as () => Promise<void>,
    errorResult: (e) => {
      throw e;
    },
    cfg: { maxResponseChars: 20000 },
    readModel: boom("readModel") as unknown as BopfTestDeps["readModel"],
  };
}

const ROOT_ROW = { node: "ROOT", fields: { ORDER_ID: "MCP0001" } };
const ITEM_ROW = { node: "ITEM", parentNode: "ROOT", fields: { ITEM_NO: "0010" } };

describe("scenario.actions — the live-reported silently-dropped-actions case", () => {
  it("runBopfTest refuses a scenario carrying actions, naming actions, before touching any dep", async () => {
    await expect(
      runBopfTest(throwingDeps(), {
        bo: "ZBOPF_ORDER",
        scenario: { nodes: [ROOT_ROW], actions: [{ name: "DO_SOMETHING" }] },
      }),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
  });

  it("names the key, says where it belongs, and says actions specifically cannot be run this way", () => {
    const e = expectBadInput(() =>
      validateBopfTestScenario({ nodes: [ROOT_ROW], actions: [{ name: "DO_SOMETHING" }] } as BopfTestInput["scenario"]),
    );
    expect(e.message).toContain("scenario");
    expect(e.message).toContain('"actions"');
    expect(e.message).toContain("nodes");
    expect(e.message).toContain("cleanup");
    // The bridge genuinely never invokes a BOPF action (src/adt/bopf-runtime.ts) — say so, not just "unknown key".
    expect(e.message.toLowerCase()).toContain("never invokes a bopf action");
  });
});

describe("scenario.nodes[i] — an unrecognised key on one row", () => {
  it("refuses, naming the key and the entry's index", () => {
    const badRow = { ...ITEM_ROW, actionCode: "CREATE" };
    const e = expectBadInput(() => validateBopfTestScenario({ nodes: [ROOT_ROW, badRow] } as BopfTestInput["scenario"]));
    expect(e.message).toContain("scenario.nodes[1]");
    expect(e.message).toContain('"actionCode"');
    expect(e.message).toContain("node");
    expect(e.message).toContain("parentNode");
    expect(e.message).toContain("fields");
  });

  it("index is 0 for a bad root row, not 1", () => {
    const badRoot = { ...ROOT_ROW, extra: true };
    const e = expectBadInput(() => validateBopfTestScenario({ nodes: [badRoot] } as BopfTestInput["scenario"]));
    expect(e.message).toContain("scenario.nodes[0]");
    expect(e.message).toContain('"extra"');
  });
});

describe("a legitimate scenario is still accepted — regression guard", () => {
  it("root row + child row with parentNode + cleanup passes validateBopfTestScenario", () => {
    expect(() =>
      validateBopfTestScenario({ nodes: [ROOT_ROW, ITEM_ROW], cleanup: true } as BopfTestInput["scenario"]),
    ).not.toThrow();
  });

  it("cleanup omitted (optional) still passes", () => {
    expect(() => validateBopfTestScenario({ nodes: [ROOT_ROW] } as BopfTestInput["scenario"])).not.toThrow();
  });

  it("the same shape parses cleanly through the real zod schema (passthrough didn't break the happy path)", () => {
    const schema = bopfTestInputSchema.scenario;
    const r = schema.safeParse({ nodes: [ROOT_ROW, ITEM_ROW], cleanup: true });
    expect(r.success).toBe(true);
  });
});

describe("fields still accepts arbitrary field names", () => {
  it("an odd/unrecognised-looking field name inside fields is not treated as an unrecognised scenario key", () => {
    const row = { node: "ROOT", fields: { Z_CUSTOM_FIELD_1: "x", anything_at_all: "y", "3RD_PARTY_ID": "z" } };
    expect(() => validateBopfTestScenario({ nodes: [row] } as BopfTestInput["scenario"])).not.toThrow();
  });

  it("survives the real zod schema too", () => {
    const schema = bopfTestInputSchema.scenario;
    const row = { node: "ROOT", fields: { WHATEVER_NAME: "x" } };
    const r = schema.safeParse({ nodes: [row] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.nodes[0]?.fields).toEqual({ WHATEVER_NAME: "x" });
  });
});
