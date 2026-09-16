/**
 * #151 — note-once guidance ledger and the notes-outside-the-budget rule.
 * Pure offline: the ledger is a value object; the budget rule is exercised
 * through `buildResponse` with synthetic content.
 */
import { describe, expect, it } from "vitest";
import { buildResponse } from "../src/compact.js";
import { budgetWithNotes, GuidanceLedger, type GuidanceNote } from "../src/debug/guidance.js";
import { DEBUG_MAX_CHARS } from "../src/debug/render.js";

const revisit: GuidanceNote = {
  key: "revisit",
  full: "Position revisited: long explanation of what a revisit does and does not prove.",
  brief: "Position revisited (3 times) — see the earlier NOTE.",
};
const omitted: GuidanceNote = {
  key: "omitted",
  full: "OMITTED: long explanation of what an unresolved id means.",
  brief: "OMITTED: LV_X — no row at this stop.",
};

describe("GuidanceLedger", () => {
  it("prints the full text the first time a key is seen and the brief every later time", () => {
    const ledger = new GuidanceLedger();
    expect(ledger.render([revisit])).toEqual([revisit.full]);
    expect(ledger.render([revisit])).toEqual([revisit.brief]);
    expect(ledger.render([revisit])).toEqual([revisit.brief]);
    expect(ledger.hasSeen("revisit")).toBe(true);
    expect(ledger.hasSeen("omitted")).toBe(false);
  });

  it("tracks keys independently, and two notes with the same key in ONE call print full then brief", () => {
    const ledger = new GuidanceLedger();
    expect(ledger.render([revisit, omitted])).toEqual([revisit.full, omitted.full]);
    expect(ledger.render([omitted, omitted])).toEqual([omitted.brief, omitted.brief]);
    const fresh = new GuidanceLedger();
    expect(fresh.render([omitted, omitted])).toEqual([omitted.full, omitted.brief]);
  });

  it("re-arms the full text on a state change, but only when the signature differs from the previous one", () => {
    const ledger = new GuidanceLedger();
    ledger.render([revisit]);
    expect(ledger.render([revisit])).toEqual([revisit.brief]);

    ledger.noteStateChange("bp:BP1");
    expect(ledger.render([revisit])).toEqual([revisit.full]);

    // The same breakpoint hit again (a loop under step:"continue") is not a new state.
    ledger.noteStateChange("bp:BP1");
    expect(ledger.render([revisit])).toEqual([revisit.brief]);

    // A different one is.
    ledger.noteStateChange("bp:BP2");
    expect(ledger.render([revisit])).toEqual([revisit.full]);
    expect(ledger.render([revisit])).toEqual([revisit.brief]);
  });

  it("an empty note list renders to nothing and marks nothing", () => {
    const ledger = new GuidanceLedger();
    expect(ledger.render([])).toEqual([]);
    expect(ledger.hasSeen("revisit")).toBe(false);
  });
});

describe("budgetWithNotes — notes ride outside the content budget", () => {
  it("adds exactly the rendered length of the notes (text plus the NOTE: prefix and newline each)", () => {
    expect(budgetWithNotes([], 30_000)).toBe(30_000);
    expect(budgetWithNotes(["abc"], 30_000)).toBe(30_000 + "NOTE: abc".length + 1);
    expect(budgetWithNotes(["abc", "defgh"], 100)).toBe(100 + "NOTE: abc".length + 1 + "NOTE: defgh".length + 1);
  });

  it("a body that fills DEBUG_MAX_CHARS is NOT cut to make room for a long note when the notes ride outside the budget", () => {
    const note = "x".repeat(450);
    const header = { stateId: "abcdef012345" };
    // Sized so header + body alone sit just under the budget (each line is 21
    // chars plus its newline), with no room left for a 450-char note.
    const headerText = buildResponse({ header, maxChars: DEBUG_MAX_CHARS }).text;
    const bodyLines = Math.floor((DEBUG_MAX_CHARS - headerText.length - 60) / 22);
    const body = Array.from({ length: bodyLines }, (_, i) => `LINE-${String(i).padStart(6, "0")}-XXXXXXXXX`).join("\n");

    const insideBudget = buildResponse({ header, body, bodyLabel: "VARIABLES", notes: [note], maxChars: DEBUG_MAX_CHARS });
    expect(insideBudget.truncated).toBe(true);
    expect(insideBudget.chars).toBeLessThanOrEqual(DEBUG_MAX_CHARS);

    const outsideBudget = buildResponse({
      header,
      body,
      bodyLabel: "VARIABLES",
      notes: [note],
      maxChars: budgetWithNotes([note], DEBUG_MAX_CHARS),
    });
    expect(outsideBudget.truncated).toBe(false);
    expect(outsideBudget.text).toContain(`NOTE: ${note}`);
    expect(outsideBudget.text).toContain(`LINE-${String(bodyLines - 1).padStart(6, "0")}`);
    // The excess over the content budget is bounded by the notes' own length.
    expect(outsideBudget.chars).toBeLessThanOrEqual(budgetWithNotes([note], DEBUG_MAX_CHARS));
  });
});
