/**
 * `abap_write` (v2) — the mode-aware `next` block introduced alongside
 * `Config.verifyWrites` (`src/config.ts`).
 *
 * `speculative` (default): a write that reports success is treated as
 * sufficient — no `abap_read` next-call is emitted for it. `verified`: the
 * success path DOES suggest a read-back, pinned to `version:"active"` so an
 * unactivated object can't read back looking correct.
 *
 * The FAILURE path is the asymmetric case this suite exists to pin: it
 * suggests checking whether the object exists anyway in BOTH modes,
 * including the DEFAULT `speculative` one — a reported failure runs no
 * cleanup, so a create that actually landed leaves permanent residue if
 * nobody checks.
 *
 * Offline throughout: `abapWrite` (src/tools/write.ts) is stubbed, no
 * connection/journal/transport/safety-gate is real.
 */
import { describe, expect, it, vi } from "vitest";
import { AbapError } from "../src/adt/errors.js";
import { handleAbapWrite } from "../src/tools/v2/handlers/write.js";
import type { V2ToolDeps } from "../src/tools/v2/runtime.js";
import type { VerifyWritesMode } from "../src/config.js";

/**
 * Controls the stubbed `abapWrite`'s outcome per test. `vi.hoisted` because
 * `vi.mock` factories run before this file's own top-level statements.
 */
const control = vi.hoisted(() => ({ fail: false }));

vi.mock("../src/tools/write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/write.js")>();
  return {
    ...actual,
    abapWrite: async () => {
      if (control.fail) {
        throw new AbapError("CHECK_FAILED", "stub: write rejected", {});
      }
      return { text: "stub: write accepted", truncated: false };
    },
  };
});

/** Enough of `V2ToolDeps` for `handleAbapWrite` to reach the stubbed `abapWrite`. */
function stubDeps(verifyWrites: VerifyWritesMode): V2ToolDeps {
  return {
    pool: {
      withWrite: async <T>(_tool: string, _key: string, fn: (conn: unknown) => Promise<T>): Promise<T> =>
        fn({ cfg: { sid: "TST" } }),
    },
    safety: { assert: () => {} },
    ensureConnected: async () => {},
    errorResult: () => ({ content: [] }),
    journal: {},
    transport: {},
    debugDeps: {},
    warn: () => {},
    cfg: { maxResponseChars: 50_000, abapMode: "edit", verifyWrites },
  } as unknown as V2ToolDeps;
}

function textOf(res: Awaited<ReturnType<typeof handleAbapWrite>>): string {
  return (res.content[0] as { text: string }).text;
}

describe("abap_write (v2): verifyWrites-mode-aware next block", () => {
  it("speculative (default) success: does NOT suggest reading the object back", async () => {
    control.fail = false;
    const res = await handleAbapWrite({ object: "ZCL_PROBE", source: "CLASS zcl_probe DEFINITION PUBLIC.\nENDCLASS." }, stubDeps("speculative"));
    const text = textOf(res);
    expect(res.isError).toBeUndefined();
    expect(text).not.toContain("abap_read(");
    expect(text).toContain("NEXT:\n(none)");
  });

  it("verified success: DOES suggest reading the object back, pinned to the ACTIVE version", async () => {
    control.fail = false;
    const res = await handleAbapWrite({ object: "ZCL_PROBE", source: "CLASS zcl_probe DEFINITION PUBLIC.\nENDCLASS." }, stubDeps("verified"));
    const text = textOf(res);
    expect(res.isError).toBeUndefined();
    expect(text).toContain("abap_read(");
    expect(text).toContain('"object":"ZCL_PROBE"');
    expect(text).toContain('"version":"active"');
  });

  it("speculative (default) failure: DOES suggest checking whether the object exists anyway — the asymmetric case", async () => {
    control.fail = true;
    const res = await handleAbapWrite({ object: "ZCL_PROBE", source: "CLASS zcl_probe DEFINITION PUBLIC.\nENDCLASS." }, stubDeps("speculative"));
    const text = textOf(res);
    expect(res.isError).toBe(true);
    expect(text).toContain("abap_read(");
    expect(text.toLowerCase()).toContain("check whether the object exists");
    // The bare-call retry guidance must still be present, not replaced.
    expect(text).toContain("Retry with the bare call for guidance.");
  });

  it("verified failure: also suggests checking whether the object exists anyway", async () => {
    control.fail = true;
    const res = await handleAbapWrite({ object: "ZCL_PROBE", source: "CLASS zcl_probe DEFINITION PUBLIC.\nENDCLASS." }, stubDeps("verified"));
    const text = textOf(res);
    expect(res.isError).toBe(true);
    expect(text).toContain("abap_read(");
    expect(text.toLowerCase()).toContain("check whether the object exists");
  });
});
