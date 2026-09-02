/**
 * `assertBridgeMutation` — the two-gate contradiction.
 *
 * Before this fix, a bridge object with an `activate` step (e.g. a `VIEW/DV`
 * create) made TWO separate `gate.assert` calls against ONE
 * `ABAP_ALLOW_TRANSPORTS` setting: the `write` assert got the caller's real
 * `corr`, but the `activate` assert always got an empty `EvaluateOptions`, so
 * `safety.ts` fabricated a literal `corrNr: "auto"` for it. No single
 * `ABAP_ALLOW_TRANSPORTS` value could satisfy both gates for a pinned
 * transport unless it also listed `"auto"` (or was `"*"`).
 *
 * These tests drive `assertBridgeMutation` directly, not through
 * `abap_write`/`abap_do`: on this branch's base, `src/adt/view-create.ts`
 * still calls `assertBridgeMutation` with no `corr` at all (the caller-side
 * pin lands separately, in a change not merged here), so the end-to-end
 * `VIEW/DV` reproduction from the issue is not reachable offline on this
 * base. `assertBridgeMutation` itself is a pure, zero-network function, so
 * this is the real unit under fix — it does not prove `view-create.ts`
 * passes a `corr` today, only that `assertBridgeMutation` threads one
 * correctly to both gates when given one.
 *
 * Fake TRKORR values below (`ZTMK9000xx`) are placeholders, not the real
 * transport named in the live incident.
 */
import { describe, expect, it } from "vitest";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import type { EvaluateOptions, Operation, SafetyCorr } from "../src/safety.js";
import { SafetyGate } from "../src/safety.js";
import { assertBridgeMutation, type BridgeMutationTarget } from "../src/adt/ddic-bridge.js";

const target: BridgeMutationTarget = {
  type: "VIEW/DV",
  name: "ZTMK_TEST_VIEW",
  packageName: "ZFOO_BAR",
};

const pinnedCorr: SafetyCorr = { kind: "transport", corrNr: "ZTMK900001", source: "named" };
const wrongCorr: SafetyCorr = { kind: "transport", corrNr: "ZTMK900099", source: "named" };

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

function catchErr(fn: () => void): AbapError {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected assertBridgeMutation to throw");
}

describe("assertBridgeMutation: the same corr reaches BOTH the write and activate gates", () => {
  it("threads one caller-named corr to both recorded EvaluateOptions", () => {
    const gate = new RecordingGate({ readOnly: false, allowPackages: ["ZFOO_*"], allowTransports: ["*"] });
    assertBridgeMutation(gate, target, { activate: true, corr: pinnedCorr });
    const ops = gate.seen.map((s) => s.op);
    expect(ops).toEqual(["write", "activate"]);
    expect(gate.seen[0]?.opts?.corr).toEqual(pinnedCorr);
    expect(gate.seen[1]?.opts?.corr).toEqual(pinnedCorr);
  });

  it("before/after: a transport allowlist pinned to exactly that corr now passes BOTH gates", () => {
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransports: ["ZTMK900001"],
    });
    expect(() => assertBridgeMutation(gate, target, { activate: true, corr: pinnedCorr })).not.toThrow();
  });

  it("does not weaken the allowlist: a corr NOT on the list is still refused SAFETY_DENIED at the write gate", () => {
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransports: ["ZTMK900001"],
    });
    const err = catchErr(() => assertBridgeMutation(gate, target, { activate: true, corr: wrongCorr }));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toContain("ZTMK900099");
    expect(err.message).not.toMatch(/Transport auto/);
  });

  it("does not weaken the allowlist: the SAME not-on-the-list corr is independently refused at the activate gate too", () => {
    // assertBridgeMutation's write assert throws first, so it never reaches its
    // own activate assert for this corr — proving the activate half by calling
    // the gate exactly the way assertBridgeMutation would, in isolation.
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"],
      allowTransports: ["ZTMK900001"],
    });
    const err = catchErr(() => gate.assert("activate", target, { corr: wrongCorr }));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toContain("ZTMK900099");
  });

  it("callers with no transport to offer (VIEW/DV/TRAN/T today) still work: omitting corr falls back to the gate's own default at both gates", () => {
    const gate = new RecordingGate({ readOnly: false, allowPackages: ["ZFOO_*"], allowTransports: ["*"] });
    assertBridgeMutation(gate, target, { activate: true });
    expect(gate.seen[0]?.opts?.corr).toBeUndefined();
    expect(gate.seen[1]?.opts?.corr).toBeUndefined();
  });
});

describe("assertBridgeMutation: ABAP_ALLOW_TRANSPORTS default semantics", () => {
  it("unset allowTransports now permits a caller-named pinned corr at both gates", () => {
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["ZFOO_*"] });
    expect(() => assertBridgeMutation(gate, target, { activate: true, corr: pinnedCorr })).not.toThrow();
  });

  it("explicitly empty allowTransports is UNCHANGED: still deny-all for a transportable write", () => {
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["ZFOO_*"], allowTransports: [] });
    const err = catchErr(() => assertBridgeMutation(gate, target, { activate: true, corr: pinnedCorr }));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toMatch(/explicitly empty/);
  });

  it('explicit allowTransports:["auto"] is UNCHANGED: still refuses a caller-named pin at both gates', () => {
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["ZFOO_*"], allowTransports: ["auto"] });
    const err = catchErr(() => assertBridgeMutation(gate, target, { activate: true, corr: pinnedCorr }));
    expect(err.code).toBe("SAFETY_DENIED");
    // The write gate refused first; confirm the activate gate independently
    // refuses the identical corr too, the same way the prior test proved it
    // for a pinned (non-"auto") allowlist.
    const activateErr = catchErr(() => gate.assert("activate", target, { corr: pinnedCorr }));
    expect(activateErr.code).toBe("SAFETY_DENIED");
  });
});
