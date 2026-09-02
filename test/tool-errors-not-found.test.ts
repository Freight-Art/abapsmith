/**
 * `NOT_FOUND` message must always name the requested object — regression
 * coverage for a measured defect, not a hypothetical one.
 *
 * A 21-lesson live-SAP evaluation captured 276 real `NOT_FOUND`
 * responses. 193 named the requested object correctly (SAP's T100 text,
 * passed through verbatim by `translateAdtError` in src/adt/session.ts,
 * genuinely named it — that majority path is untouched by this fix and is
 * exercised by the first test below). The remaining 82 (29.7%) did not:
 *
 *   - 64 gave a generic message with no object name at all
 *   -  9 named a DIFFERENT object than the one requested
 *   -  9 were empty or whitespace-only
 *   -  1 other (not independently reproduced here — it did not resolve to a
 *      distinct code path from the three above; whatever shape it took, it
 *      still lacked the requested name in `message`, which is the one
 *      invariant this suite pins)
 *
 * `details.name` — set by every `NOT_FOUND` call site (`translateAdtError`,
 * `resolve.ts`, `write.ts`, …) via `ctx.name`/`parsed.name`/`t.name` — already
 * carried the correct requested name in all 82 broken cases; `message` simply
 * never consulted it. `ensureNotFoundNamesObject` (src/tool-errors.ts) is the
 * backstop applied once, in `buildErrorPayload`, for every `NOT_FOUND`
 * `AbapError` regardless of which call site produced it.
 *
 * These tests go through `buildErrorPayload`/`errorResult` directly from
 * `../src/tool-errors.js` — not via `../src/server.js` — so this file has no
 * dependency on anything outside the two files this fix owns.
 */
import { describe, expect, it } from "vitest";
import { buildErrorPayload, errorResult } from "../src/tool-errors.js";
import { AbapError } from "../src/adt/errors.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function envelope(res: CallToolResult): Record<string, any> {
  const text = (res.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

describe("NOT_FOUND — message always names the requested object", () => {
  it("shape 1: SAP's text already names the object correctly — left verbatim (the 193/276 majority path)", () => {
    const e = new AbapError(
      "NOT_FOUND",
      'Function group "ZFG_TEST" does not exist',
      { operation: "read", name: "ZFG_TEST", type: "FUGR/F" },
      "Check the name with abap_search, or create the object first.",
    );
    const body = envelope(errorResult(e));
    expect(body.error).toBe("NOT_FOUND");
    // Untouched: rewriting an already-correct message would just be a second
    // place for the wording to drift, and the majority path must not move.
    expect(body.message).toBe('Function group "ZFG_TEST" does not exist');
    expect(body.message).toContain("ZFG_TEST");
  });

  it("shape 2: SAP's text is generic, no object name at all — the server's own sentence names it (64/276)", () => {
    const e = new AbapError(
      "NOT_FOUND",
      "Object does not exist",
      { operation: "read", name: "ZCL_MISSING_CLASS", type: "CLAS/OC" },
      "Check the name with abap_search, or create the object first.",
    );
    const body = envelope(errorResult(e));
    expect(body.error).toBe("NOT_FOUND");
    expect(body.message).toContain("ZCL_MISSING_CLASS");
    expect(body.message).toBe('ZCL_MISSING_CLASS was not found. SAP said: "Object does not exist"');
    // The requested name still survives untouched in details, independent of
    // whatever happened to `message`.
    expect(body.details.name).toBe("ZCL_MISSING_CLASS");
  });

  it("shape 3: SAP's text names a DIFFERENT object — server states the real target and attributes SAP's claim separately (9/276)", () => {
    const e = new AbapError(
      "NOT_FOUND",
      'Table "ZUNRELATED_TABLE" does not exist',
      { operation: "read", name: "ZFG_REQUESTED", type: "FUGR/F" },
      "Check the name with abap_search, or create the object first.",
    );
    const body = envelope(errorResult(e));
    expect(body.error).toBe("NOT_FOUND");
    // The requested object must be named, and named first/plainly — not
    // buried behind SAP's confident-but-wrong claim.
    expect(body.message).toContain("ZFG_REQUESTED");
    expect(body.message.indexOf("ZFG_REQUESTED")).toBeLessThan(body.message.indexOf("ZUNRELATED_TABLE"));
    // SAP's (wrong) text is kept, but clearly attributed so a caller can tell
    // which part is SAP's claim and which is the server's own determination
    // — never blended into one ambiguous sentence.
    expect(body.message).toContain('SAP said: "Table "ZUNRELATED_TABLE" does not exist"');
    expect(body.message).toBe(
      'ZFG_REQUESTED was not found. SAP said: "Table "ZUNRELATED_TABLE" does not exist"',
    );
  });

  it("shape 4: SAP's text is empty/whitespace-only — server's own sentence is the whole message, no dangling attribution (9/276)", () => {
    const whitespace = new AbapError(
      "NOT_FOUND",
      "   ",
      { operation: "read", name: "ZIF_EMPTY_MSG", type: "INTF/OI" },
      "Check the name with abap_search, or create the object first.",
    );
    const body = envelope(errorResult(whitespace));
    expect(body.error).toBe("NOT_FOUND");
    expect(body.message).toBe("ZIF_EMPTY_MSG was not found.");
    expect(body.message).not.toContain("SAP said");

    const empty = new AbapError(
      "NOT_FOUND",
      "",
      { operation: "read", name: "ZIF_EMPTY_MSG2", type: "INTF/OI" },
      "Check the name with abap_search, or create the object first.",
    );
    const body2 = envelope(errorResult(empty));
    expect(body2.message).toBe("ZIF_EMPTY_MSG2 was not found.");
    expect(body2.message).not.toContain("SAP said");
  });

  it("is a no-op when no requested name is on record at all — cannot rewrite what it does not know", () => {
    // Mirrors the raw-throw / no-ctx path: an AbapError with no `details.name`.
    // There is nothing to check `message` against, so it must be left as-is
    // rather than fabricate a name or a generic substitute.
    const e = new AbapError("NOT_FOUND", "Generic ADT 404 with no context", { operation: "read" });
    const body = envelope(errorResult(e));
    expect(body.message).toBe("Generic ADT 404 with no context");
  });

  it("does not rewrite non-NOT_FOUND codes even when details.name is absent from the message", () => {
    const e = new AbapError(
      "LOCKED",
      "The enqueue is held by another session.",
      { operation: "write", name: "ZCL_LOCKED_OBJECT" },
      "hint",
    );
    const body = envelope(errorResult(e));
    // LOCKED is unaffected by this fix; only NOT_FOUND's message is guaranteed
    // to name the object here (LOCKED already names it via translateAdtError's
    // own message construction, which this fix does not touch).
    expect(body.message).toBe("The enqueue is held by another session.");
  });

  it("buildErrorPayload (pure, no MCP wrapper) matches errorResult's parsed body for all four shapes", () => {
    const cases = [
      new AbapError("NOT_FOUND", "Names ZOBJ_A correctly", { name: "ZOBJ_A" }),
      new AbapError("NOT_FOUND", "generic not found", { name: "ZOBJ_B" }),
      new AbapError("NOT_FOUND", "names ZOBJ_WRONG instead", { name: "ZOBJ_C" }),
      new AbapError("NOT_FOUND", "", { name: "ZOBJ_D" }),
    ];
    for (const e of cases) {
      const payload = buildErrorPayload(e);
      const fromWrapper = envelope(errorResult(e));
      expect(payload).toEqual(fromWrapper);
      expect(typeof payload.message).toBe("string");
      expect(payload.message as string).toContain(e.details.name as string);
    }
  });
});
