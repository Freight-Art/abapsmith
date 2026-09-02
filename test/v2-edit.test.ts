/**
 * Offline, pure unit tests for `abap_write`'s edit primitive
 * (`src/tools/v2/edit.ts`). No ADT/network dependency at
 * all — every case here is a direct `applyEdit(...)` call.
 *
 * Per this project's standing rule ("verify ABAP claims against the
 * appliance"), this file proves the MATCHING ALGORITHM is correct; it proves
 * nothing about wire behaviour (CRLF/LF activation churn, etc.) — that is
 * covered separately by a live A4H capture.
 */
import { describe, expect, it } from "vitest";
import { applyEdit, describeEditFailure, EditInputError, type EditAmbiguous, type EditNoMatch } from "../src/tools/v2/edit.js";
import { handleAbapWrite } from "../src/tools/v2/handlers/write.js";
import type { V2ToolDeps } from "../src/tools/v2/runtime.js";

describe("applyEdit", () => {
  it("0 matches: returns a no-match result, not a throw", () => {
    const result = applyEdit("line one\nline two\nline three", "line four", "replacement");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("no-match");
  });

  it("0 matches: hints at the first line's occurrences when they exist elsewhere", () => {
    const source = "DATA: lv_foo TYPE i.\nDATA: lv_bar TYPE i.\nWRITE lv_foo.";
    // old_string's first line ("DATA: lv_foo TYPE i.") is present, but the
    // second line has drifted (source says nothing about lv_baz).
    const result = applyEdit(source, "DATA: lv_foo TYPE i.\nDATA: lv_baz TYPE i.", "* removed", false);
    expect(result.ok).toBe(false);
    const nm = result as EditNoMatch;
    expect(nm.kind).toBe("no-match");
    expect(nm.firstLineOccurrences).toEqual([1]);
  });

  it("0 matches: no hint at all when even the first line is absent", () => {
    const result = applyEdit("alpha\nbeta\ngamma", "nowhere at all\nsecond line", "x");
    expect(result.ok).toBe(false);
    const nm = result as EditNoMatch;
    expect(nm.firstLineOccurrences).toBeUndefined();
  });

  it("1 match: splices cleanly and reports ok:true", () => {
    const source = "METHOD foo.\n  DATA lv_x TYPE i.\n  lv_x = 1.\nENDMETHOD.";
    const result = applyEdit(source, "  lv_x = 1.", "  lv_x = 2.");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("METHOD foo.\n  DATA lv_x TYPE i.\n  lv_x = 2.\nENDMETHOD.");
  });

  it("N matches without replace_all: ambiguous, lists every matching line", () => {
    const source = "WRITE 'x'.\nWRITE 'x'.\nWRITE 'y'.\nWRITE 'x'.";
    const result = applyEdit(source, "WRITE 'x'.", "WRITE 'z'.");
    expect(result.ok).toBe(false);
    const amb = result as EditAmbiguous;
    expect(amb.kind).toBe("ambiguous");
    expect(amb.matchLines).toEqual([1, 2, 4]);
  });

  it("N matches with replace_all: replaces every non-overlapping occurrence", () => {
    const source = "WRITE 'x'.\nWRITE 'x'.\nWRITE 'y'.\nWRITE 'x'.";
    const result = applyEdit(source, "WRITE 'x'.", "WRITE 'z'.", true);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("WRITE 'z'.\nWRITE 'z'.\nWRITE 'y'.\nWRITE 'z'.");
  });

  it("matches are counted non-overlapping, left to right", () => {
    // "aaaa" against needle "aa" -> 2 non-overlapping matches (offsets 0, 2),
    // not 3 (which an overlapping scan would report).
    const result = applyEdit("aaaa", "aa", "b", true);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("bb");
  });

  it("empty old_string: refused as a caller error before any scan, not a 0-match result", () => {
    expect(() => applyEdit("some source", "", "x")).toThrow(EditInputError);
  });

  it("old_string === new_string: refused as a caller error, not a silent no-op", () => {
    expect(() => applyEdit("some source", "identical", "identical")).toThrow(EditInputError);
  });

  it("CRLF source: normalized to LF before matching, and the result is all-LF", () => {
    const source = "line one\r\nline two\r\nline three";
    const result = applyEdit(source, "line two", "line TWO");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("line one\nline TWO\nline three");
    expect(result.result).not.toContain("\r");
  });

  it("CRLF old_string against an LF source still matches (both sides normalized)", () => {
    const source = "line one\nline two\nline three";
    const result = applyEdit(source, "line one\r\nline two", "REPLACED");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("REPLACED\nline three");
  });

  it("line numbers in an ambiguous result are 1-based and account for multi-line needles", () => {
    const source = "A\nB\nfoo\nbar\nC\nfoo\nbar\nD";
    const result = applyEdit(source, "foo\nbar", "X");
    expect(result.ok).toBe(false);
    const amb = result as EditAmbiguous;
    expect(amb.matchLines).toEqual([3, 6]);
  });
});

describe("describeEditFailure", () => {
  it("ambiguous: names the count and every line, and suggests replace_all or narrowing", () => {
    const msg = describeEditFailure({ ok: false, kind: "ambiguous", matchLines: [12, 45, 90] });
    expect(msg).toContain("3 times");
    expect(msg).toContain("12, 45, 90");
    expect(msg).toContain("replace_all");
  });

  it("no-match with hints: points at the drifted line(s)", () => {
    const msg = describeEditFailure({ ok: false, kind: "no-match", firstLineOccurrences: [7] });
    expect(msg).toContain("line(s) 7");
    expect(msg).toContain("0 matches");
  });

  it("no-match without hints: says nothing was found at all", () => {
    const msg = describeEditFailure({ ok: false, kind: "no-match" });
    expect(msg).toContain("0 matches");
    expect(msg.toLowerCase()).toContain("not even its first line");
  });
});

/**
 * `handlers/write.ts`'s conflicting-form validation runs BEFORE
 * `deps.safety.assert`/`deps.ensureConnected` — the whole point being that a
 * malformed call costs zero requests. This stub deps object makes every
 * network-shaped member throw, so if the handler ever reached past the
 * conflict check for these two inputs, the test would fail loudly rather
 * than silently doing nothing.
 */
function unreachableDeps(): V2ToolDeps {
  const boom = (member: string) => () => {
    throw new Error(`unreachable: ${member} should not be called for a conflicting/malformed input`);
  };
  return {
    pool: { withWrite: boom("pool.withWrite") } as unknown as V2ToolDeps["pool"],
    safety: { assert: boom("safety.assert") } as unknown as V2ToolDeps["safety"],
    ensureConnected: boom("ensureConnected"),
    errorResult: boom("errorResult"),
    journal: {} as V2ToolDeps["journal"],
    transport: {} as V2ToolDeps["transport"],
    debugDeps: {} as V2ToolDeps["debugDeps"],
    warn: () => {},
    cfg: { maxResponseChars: 50_000, allowEnhancements: false, allowSourcePlugins: false, user: "test", abapMode: "admin" },
  };
}

describe("handleAbapWrite: conflicting-form validation (zero network cost)", () => {
  it("edit + source together: BAD_INPUT, never reaches safety/connect/pool", async () => {
    const res = await handleAbapWrite(
      { object: "ZCL_FOO", edit: { old_string: "a", new_string: "b" }, source: "CLASS ..." },
      unreachableDeps(),
    );
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("error: BAD_INPUT");
    expect(text.toLowerCase()).toContain("not both");
  });

  it("edit + method together: BAD_INPUT, never reaches safety/connect/pool", async () => {
    const res = await handleAbapWrite(
      { object: "ZCL_FOO", edit: { old_string: "a", new_string: "b" }, method: "CALCULATE" },
      unreachableDeps(),
    );
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("error: BAD_INPUT");
    expect(text.toLowerCase()).toContain("not both");
  });

  it("missing object: BAD_INPUT, never reaches safety/connect/pool", async () => {
    const res = await handleAbapWrite({ source: "CLASS ..." }, unreachableDeps());
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("error: BAD_INPUT");
  });

  it("bare call: self-describes instead of erroring", async () => {
    const res = await handleAbapWrite({}, unreachableDeps());
    expect(res.isError).toBeUndefined();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("ok: true");
    expect(text).toContain("unique-match splice");
  });
});
