/**
 * `selectImpacted` (src/adt/impacted.ts) — the pure, injectable selection
 * engine behind `abap_test`'s scope="impacted" (issue #111). Pure logic, no
 * network: `whereUsed`/`probeCarrier` are fakes here, exactly the seam the
 * module exists to provide.
 */
import { describe, expect, it } from "vitest";
import {
  PER_OBJECT_CONSUMER_CAP,
  SELECTED_CARRIER_CAP,
  selectImpacted,
  type CarrierProbe,
  type ChangedObject,
  type ConsumerRef,
  type ImpactedDeps,
} from "../src/adt/impacted.js";

/** Builds `ImpactedDeps` from plain lookup tables — the whole fake for this file. */
function deps(opts: {
  whereUsed?: Record<string, ConsumerRef[]>;
  probes?: Record<string, CarrierProbe>;
  onWhereUsed?: (name: string) => void;
  onProbe?: (name: string) => void;
}): ImpactedDeps {
  return {
    async whereUsed(obj: ChangedObject): Promise<readonly ConsumerRef[]> {
      opts.onWhereUsed?.(obj.name);
      return opts.whereUsed?.[obj.name.toUpperCase()] ?? [];
    },
    async probeCarrier(obj: ConsumerRef): Promise<CarrierProbe> {
      opts.onProbe?.(obj.name);
      return opts.probes?.[obj.name.toUpperCase()] ?? "no-tests";
    },
  };
}

const ref = (name: string, type = "CLAS/OC"): ConsumerRef => ({ name, type });
const changed = (name: string, type = "CLAS/OC"): ChangedObject => ({ name, type });

describe("selectImpacted — changed objects as candidate carriers", () => {
  it("selects a changed object directly when it has tests", async () => {
    const d = deps({ probes: { ZCL_A: "has-tests" } });
    const sel = await selectImpacted([changed("ZCL_A")], d);
    expect(sel.selected).toEqual([{ name: "ZCL_A", type: "CLAS/OC", reason: "changed directly", probe: "has-tests" }]);
    expect(sel.consumersExamined).toBe(0);
  });

  it("selects a changed object directly when its carrier status is unknown (PROG/FUGR)", async () => {
    const d = deps({ probes: { ZPROG: "unknown" } });
    const sel = await selectImpacted([changed("ZPROG", "PROG/P")], d);
    expect(sel.selected).toHaveLength(1);
    expect(sel.selected[0]?.reason).toBe("changed directly");
    expect(sel.selected[0]?.probe).toBe("unknown");
  });

  it("does not select a changed object with no tests, and does not count it as a consumer", async () => {
    const d = deps({ probes: { ZCL_A: "no-tests" } });
    const sel = await selectImpacted([changed("ZCL_A")], d);
    expect(sel.selected).toEqual([]);
    expect(sel.consumersExamined).toBe(0);
  });
});

describe("selectImpacted — consumers via where-used", () => {
  it("selects a consumer that has tests, with reason 'uses <CHANGED_NAME>'", async () => {
    const d = deps({
      probes: { ZCL_A: "no-tests", ZCL_CONSUMER: "has-tests" },
      whereUsed: { ZCL_A: [ref("ZCL_CONSUMER")] },
    });
    const sel = await selectImpacted([changed("ZCL_A")], d);
    expect(sel.selected).toEqual([
      { name: "ZCL_CONSUMER", type: "CLAS/OC", reason: "uses ZCL_A", probe: "has-tests" },
    ]);
    expect(sel.consumersExamined).toBe(1);
  });

  it("does not select a consumer with no tests, but still counts it as examined", async () => {
    const d = deps({
      probes: { ZCL_A: "no-tests", ZCL_CONSUMER: "no-tests" },
      whereUsed: { ZCL_A: [ref("ZCL_CONSUMER")] },
    });
    const sel = await selectImpacted([changed("ZCL_A")], d);
    expect(sel.selected).toEqual([]);
    expect(sel.consumersExamined).toBe(1);
  });

  it("filters where-used rows to CLAS/PROG/FUGR, case-insensitively, bare kind included", async () => {
    const d = deps({
      probes: { ZCL_A: "no-tests", ZCL_KEEP1: "has-tests", ZCL_KEEP2: "has-tests", ZCL_KEEP3: "has-tests" },
      whereUsed: {
        ZCL_A: [
          ref("ZTAB", "TABL/DS"), // wrong kind — dropped
          ref("ZCL_KEEP1", "clas/oc"), // lower-case kind — kept
          ref("ZCL_KEEP2", "CLAS"), // bare kind, no slash — kept
          ref("ZDDIC", "DDLS/DF"), // wrong kind — dropped
          ref("ZCL_KEEP3", "FUGR/FF"),
        ],
      },
    });
    const sel = await selectImpacted([changed("ZCL_A")], d);
    expect(sel.selected.map((c) => c.name).sort()).toEqual(["ZCL_KEEP1", "ZCL_KEEP2", "ZCL_KEEP3"]);
    expect(sel.consumersExamined).toBe(3);
  });

  it("drops rows naming the changed object itself or another changed object", async () => {
    const d = deps({
      probes: { ZCL_A: "no-tests", ZCL_B: "no-tests", ZCL_CONSUMER: "has-tests" },
      whereUsed: {
        ZCL_A: [ref("ZCL_A"), ref("ZCL_B"), ref("ZCL_CONSUMER")],
      },
    });
    const sel = await selectImpacted([changed("ZCL_A"), changed("ZCL_B")], d);
    expect(sel.selected.map((c) => c.name)).toEqual(["ZCL_CONSUMER"]);
    expect(sel.consumersExamined).toBe(1);
  });

  it("dedupes duplicate consumers per changed object, keeping the first occurrence", async () => {
    const probed: string[] = [];
    const d = deps({
      probes: { ZCL_A: "no-tests", ZCL_CONSUMER: "has-tests" },
      whereUsed: { ZCL_A: [ref("ZCL_CONSUMER", "CLAS/OC"), ref("zcl_consumer", "CLAS/OC")] },
      onProbe: (n) => probed.push(n),
    });
    const sel = await selectImpacted([changed("ZCL_A")], d);
    // "ZCL_A" is probed once too, as step 1's changed-directly candidate —
    // that probe is not a consumer probe and is asserted separately below.
    expect(probed).toEqual(["ZCL_A", "ZCL_CONSUMER"]);
    expect(sel.consumersExamined).toBe(1);
  });

  it("merges reasons (comma-joined) when a carrier is reached through multiple paths, without consuming another carrier slot", async () => {
    const d = deps({
      probes: { ZCL_A: "no-tests", ZCL_B: "no-tests", ZCL_CONSUMER: "has-tests" },
      whereUsed: {
        ZCL_A: [ref("ZCL_CONSUMER")],
        ZCL_B: [ref("ZCL_CONSUMER")],
      },
    });
    const sel = await selectImpacted([changed("ZCL_A"), changed("ZCL_B")], d);
    expect(sel.selected).toHaveLength(1);
    expect(sel.selected[0]?.reason).toBe("uses ZCL_A, uses ZCL_B");
    expect(sel.consumersExamined).toBe(2);
  });

  it("a changed object's own name is dropped from another changed object's where-used rows, so it is never also given a merged 'uses' reason", async () => {
    const d = deps({
      probes: { ZCL_A: "has-tests", ZCL_B: "no-tests" },
      whereUsed: { ZCL_B: [ref("ZCL_A")] },
    });
    const sel = await selectImpacted([changed("ZCL_A"), changed("ZCL_B")], d);
    expect(sel.selected).toEqual([
      { name: "ZCL_A", type: "CLAS/OC", reason: "changed directly", probe: "has-tests" },
    ]);
    // ZCL_A never reaches probeCarrier a second time as a "consumer".
    expect(sel.consumersExamined).toBe(0);
  });
});

describe("selectImpacted — caps", () => {
  it("caps consumers probed per changed object at PER_OBJECT_CONSUMER_CAP, disclosing the rest", async () => {
    const many = Array.from({ length: PER_OBJECT_CONSUMER_CAP + 5 }, (_, i) => ref(`ZCL_C${i}`));
    const probes: Record<string, CarrierProbe> = { ZCL_A: "no-tests" };
    for (const c of many) probes[c.name] = "no-tests"; // none selected — isolates the cap
    const d = deps({ probes, whereUsed: { ZCL_A: many } });

    const sel = await selectImpacted([changed("ZCL_A")], d);
    expect(sel.consumersExamined).toBe(PER_OBJECT_CONSUMER_CAP);
    expect(sel.perObjectCapped).toEqual([
      {
        object: "ZCL_A",
        notExamined: many.slice(PER_OBJECT_CONSUMER_CAP).map((c) => c.name),
      },
    ]);
    expect(sel.neverExamined).toEqual([]);
    expect(sel.carrierCapHit).toBe(false);
  });

  it("stops selecting once SELECTED_CARRIER_CAP is reached, sets carrierCapHit, and never calls whereUsed for an unreached changed object", async () => {
    // First changed object alone produces enough has-tests consumers to hit the cap.
    const abundant = Array.from({ length: SELECTED_CARRIER_CAP + 3 }, (_, i) => ref(`ZCL_C${i}`));
    const probes: Record<string, CarrierProbe> = { ZCL_A: "no-tests", ZCL_B: "no-tests" };
    for (const c of abundant) probes[c.name] = "has-tests";
    const whereUsedCalls: string[] = [];
    const d = deps({
      probes,
      whereUsed: { ZCL_A: abundant, ZCL_B: [ref("ZCL_NEVER_SEEN")] },
      onWhereUsed: (n) => whereUsedCalls.push(n),
    });

    const sel = await selectImpacted([changed("ZCL_A"), changed("ZCL_B")], d);
    expect(sel.selected).toHaveLength(SELECTED_CARRIER_CAP);
    expect(sel.carrierCapHit).toBe(true);
    expect(whereUsedCalls).toEqual(["ZCL_A"]); // ZCL_B's whereUsed was never called
    // ZCL_A's excess consumers (beyond the carrier cap) are named, not just counted.
    const totalNotExamined = sel.perObjectCapped.reduce((n, c) => n + c.notExamined.length, 0);
    expect(totalNotExamined).toBeGreaterThan(0);
    // ZCL_B's whereUsed was never even attempted — its consumer count is unknown, not zero.
    expect(sel.neverExamined).toEqual(["ZCL_B"]);
  });

  it("starts carrierCapHit true and skips whereUsed entirely when step 1 alone fills the cap", async () => {
    const names = Array.from({ length: SELECTED_CARRIER_CAP }, (_, i) => `ZCL_D${i}`);
    const probes: Record<string, CarrierProbe> = {};
    for (const n of names) probes[n] = "has-tests";
    const whereUsedCalls: string[] = [];
    const d = deps({ probes, onWhereUsed: (n) => whereUsedCalls.push(n) });

    const sel = await selectImpacted(names.map((n) => changed(n)), d);
    expect(sel.selected).toHaveLength(SELECTED_CARRIER_CAP);
    expect(sel.carrierCapHit).toBe(true);
    expect(whereUsedCalls).toEqual([]);
    expect(sel.consumersExamined).toBe(0);
    expect(sel.perObjectCapped).toEqual([]);
    // None of the changed objects ever got a whereUsed call — all of them are "never examined".
    expect(sel.neverExamined).toEqual(names);
  });
});

describe("selectImpacted — propagation of dependency failures", () => {
  it("propagates a whereUsed failure rather than swallowing it", async () => {
    const d: ImpactedDeps = {
      async whereUsed() {
        throw new Error("ADT boom");
      },
      async probeCarrier() {
        return "no-tests";
      },
    };
    await expect(selectImpacted([changed("ZCL_A")], d)).rejects.toThrow("ADT boom");
  });

  it("propagates a probeCarrier failure rather than swallowing it", async () => {
    const d: ImpactedDeps = {
      async whereUsed() {
        return [];
      },
      async probeCarrier() {
        throw new Error("probe boom");
      },
    };
    await expect(selectImpacted([changed("ZCL_A")], d)).rejects.toThrow("probe boom");
  });
});
