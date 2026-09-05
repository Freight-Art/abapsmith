/**
 * `bridgeSource`'s single TRY wraps the fragment body and `epilogueFragment`'s
 * SAVE/ACTIVATE/UNLOCK, so a CATCH firing after some tags landed means SAVE may
 * have committed while UNLOCK never ran. `assertEnhTranscript` is exercised
 * directly — a hand-built `EnhTranscriptResult` is all its contract needs, no
 * fake ADT connection required.
 */
import { describe, expect, it } from "vitest";
import { assertEnhTranscript, parseEnhancementTranscript, type EnhTag } from "../src/adt/enhancement-bridge.js";
import { isAbapError } from "../src/adt/errors.js";

describe("assertEnhTranscript epilogue residue disclosure", () => {
  it("names the landed work and the stranded-lock risk when tags preceded the failure", () => {
    const raw = ["SPOT-OBJECT-CREATED", "ZMCP-ENH-ERR> CX_ENH_ACTIVATION raised at ACTIVATE"].join("\n");
    const result = parseEnhancementTranscript(raw);
    expect(result.tags).toEqual(["SPOT-OBJECT-CREATED"]);
    expect(result.errorLine).toBeTruthy();

    let thrown: unknown;
    try {
      assertEnhTranscript(result, ["SPOT-OBJECT-CREATED"] as EnhTag[], "create_enhancement_spot");
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown)).toBe(true);
    if (!isAbapError(thrown)) throw new Error("expected AbapError");
    expect(thrown.code).toBe("CHECK_FAILED");
    expect(thrown.details?.landedTags).toEqual(["SPOT-OBJECT-CREATED"]);
    expect(thrown.hint).toContain("SPOT-OBJECT-CREATED");
    expect(thrown.hint).toMatch(/SAVE/);
    expect(thrown.hint).toMatch(/lock/i);
    expect(thrown.hint).toMatch(/SM12/);
    expect(thrown.hint).toMatch(/re-read/i);
  });

  it("does not claim a save landed when no progress marker was written", () => {
    const raw = "ZMCP-ENH-ERR> CX_ENH_SPOT_ALREADY_EXISTS raised before anything ran";
    const result = parseEnhancementTranscript(raw);
    expect(result.tags).toEqual([]);
    expect(result.errorLine).toBeTruthy();

    let thrown: unknown;
    try {
      assertEnhTranscript(result, ["SPOT-OBJECT-CREATED"] as EnhTag[], "create_enhancement_spot");
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown)).toBe(true);
    if (!isAbapError(thrown)) throw new Error("expected AbapError");
    expect(thrown.code).toBe("CHECK_FAILED");
    expect(thrown.details?.landedTags).toBeUndefined();
    expect(thrown.hint).not.toMatch(/SAVE may have/i);
    expect(thrown.hint).not.toMatch(/enqueue lock/i);
    expect(thrown.hint).toMatch(/read the object/i);
  });

  it("leaves the missing-tag (no exception, just wrong output) path untouched", () => {
    const raw = "SPOT-OBJECT-CREATED";
    const result = parseEnhancementTranscript(raw);
    let thrown: unknown;
    try {
      assertEnhTranscript(result, ["SPOT-OBJECT-CREATED", "IMPL-ADDED"] as EnhTag[], "create_badi_implementation");
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown)).toBe(true);
    if (!isAbapError(thrown)) throw new Error("expected AbapError");
    expect(thrown.code).toBe("CHECK_FAILED");
    expect(thrown.details?.missing).toEqual(["IMPL-ADDED"]);
    expect(thrown.hint).toBeUndefined();
  });
});
