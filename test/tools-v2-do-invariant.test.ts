/**
 * Mandatory keyset-equality invariant:
 * `DO_HANDLERS`'s keys (`src/tools/v2/handlers/do/index.ts`) must exactly
 * equal `ABAP_DO_ACTIONS`'s action names (`src/tools/v2/catalogue.ts`) —
 * neither a catalogue entry with no handler (a hidden crash waiting for a
 * caller in the right mode) nor a handler with no catalogue entry (a dead,
 * unreachable action) is acceptable. Checked both directions explicitly
 * rather than via a single set-equality helper, so a failure message says
 * which side is missing what.
 */
import { describe, expect, it } from "vitest";
import { ABAP_DO_ACTIONS } from "../src/tools/v2/catalogue.js";
import { DO_HANDLERS } from "../src/tools/v2/handlers/do/index.js";

describe("abap_do dispatch table <-> catalogue keyset equality", () => {
  const catalogueActions = new Set(ABAP_DO_ACTIONS.map((e) => e.action));
  const handlerActions = new Set(DO_HANDLERS.keys());

  it("has exactly 52 catalogue actions", () => {
    expect(ABAP_DO_ACTIONS.length).toBe(52);
    expect(catalogueActions.size).toBe(52);
  });

  it("every catalogue action has a handler", () => {
    const missing = [...catalogueActions].filter((a) => !handlerActions.has(a));
    expect(missing).toEqual([]);
  });

  it("every handler corresponds to a catalogue action", () => {
    const orphaned = [...handlerActions].filter((a) => !catalogueActions.has(a));
    expect(orphaned).toEqual([]);
  });

  it("the two keysets are identical", () => {
    expect(handlerActions).toEqual(catalogueActions);
  });

  it("ABAP_DO_ACTIONS has no duplicate action names", () => {
    expect(ABAP_DO_ACTIONS.length).toBe(catalogueActions.size);
  });
});
