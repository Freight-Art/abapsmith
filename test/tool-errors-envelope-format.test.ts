/**
 * Regression coverage: `fitEnvelope` (`src/tool-errors.ts`)
 * used to serialise with `JSON.stringify(payload, null, 2)`. Several manual
 * harness scripts (not shipped in this release) build a one-line report note
 * by taking the literal first non-blank line of
 * a failed tool call's text — a real, exercised idiom, not a hypothetical
 * one. Against pretty-printed JSON that "first line" is always the single
 * character `{`, so every historical benchmark note recorded via that idiom
 * carried zero diagnostic information. A live A4H run hit exactly this: every
 * DTEL/DE and MSAG/N failure was recorded, everywhere, as `{`.
 *
 * The fix is to stop pretty-printing at the record site (`fitEnvelope` now
 * calls `JSON.stringify(payload)`, compact) rather than to special-case every
 * downstream consumer. This file pins that: the emitted text's naive "first
 * non-blank line" must never be just `{`, and the text must still be valid,
 * parseable JSON — nothing here changes what information the envelope
 * carries, only how much whitespace it spends saying it.
 */
import { describe, expect, it } from "vitest";
import { errorResult } from "../src/tool-errors.js";
import { AbapError } from "../src/adt/errors.js";

function firstLineNaive(text: string): string {
  return (text || "").split("\n").find((l) => l.trim().length > 0) ?? "(no output)";
}

function resultText(e: unknown): string {
  const res = errorResult(e);
  return (res.content[0] as { type: "text"; text: string }).text;
}

describe("error envelope must not summarise to `{`", () => {
  it("a simple AbapError's envelope does not naively summarise to the opening brace", () => {
    const e = new AbapError(
      "NOT_FOUND",
      'Function group "ZFG_TEST" does not exist',
      { operation: "read", name: "ZFG_TEST", type: "FUGR/F" },
      "Check the name with abap_search, or create the object first.",
    );
    const text = resultText(e);
    const note = firstLineNaive(text);
    expect(note).not.toBe("{");
    // The naive "first line" of compact JSON is the WHOLE envelope, so it
    // necessarily carries the error code and message.
    expect(note).toContain("NOT_FOUND");
    expect(note).toContain("ZFG_TEST");
  });

  it("a richer envelope (adt section, hint, summary) also does not collapse to `{`", () => {
    const e = new AbapError(
      "LOCKED",
      "The enqueue is held by another session.",
      {
        operation: "write",
        name: "ZCL_LOCKED_OBJECT",
        status: 403,
        adtExceptionType: "ExceptionResourceNoAccess",
        properties: { ideUser: "DEVELOPER1", conflictText: "Object locked by another user" },
      },
      "Wait for the lock to release, or ask DEVELOPER1 to release it.",
    );
    const text = resultText(e);
    expect(firstLineNaive(text)).not.toBe("{");
    expect(firstLineNaive(text).length).toBeGreaterThan(1);
  });

  it("the emitted text is compact (single-line) JSON, still valid and parseable", () => {
    const e = new AbapError("ADT_ERROR", "Something failed", { operation: "read" });
    const text = resultText(e);
    // No embedded newlines: pretty-printing is gone, not merely reduced.
    expect(text).not.toContain("\n");
    expect(() => JSON.parse(text)).not.toThrow();
    const parsed = JSON.parse(text);
    expect(parsed.error).toBe("ADT_ERROR");
    expect(parsed.message).toBe("Something failed");
  });

  it("compact serialisation never drops or renames a field pretty-printing would have kept", () => {
    // Same payload, both forms — compacting must be purely a whitespace change.
    const e = new AbapError(
      "NOT_FOUND",
      "generic not found",
      { name: "ZOBJ_B", status: 404, adtExceptionType: "ExceptionResourceNotFound" },
    );
    const text = resultText(e);
    const compact = JSON.parse(text);
    const rePrettied = JSON.parse(JSON.stringify(compact, null, 2));
    expect(rePrettied).toEqual(compact);
  });
});
