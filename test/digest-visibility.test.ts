/**
 * Issue #108 defect 6: `summarisePublicApi` (src/adt/digest.ts) bucketed
 * every non-public `ClassMember` into `hiddenCounts` by visibility alone,
 * with no regard for its component kind. `classComponents` (via
 * `flattenComponents`) returns declarative sub-objects `renderOutline` never
 * shows a human — a `TYPES` statement is real ADT type code `CLAS/OT` (see
 * test/fixtures/live-captured/954-i91-elementinfo-type.xml) — so a private
 * `TYPES` line inflated the "N private component(s) not listed" count past
 * what `abap_read {outline:true}` shows as private.
 *
 * Reproduced live against a $TMP class on system A4H with exactly the
 * reported shape: one public method, one private method, one interface
 * method implementation, plus a private `TYPES` line. Before the fix,
 * `view=digest` reported "2 private component(s) not listed"; outline showed
 * one private component (the method). This test pins the fixed count using
 * the same member shapes `flattenComponents` would produce for that class,
 * without needing a live connection.
 *
 * This is a new file, not an addition to test/digest.test.ts (owned by
 * another concurrent agent) — that file's own `summarisePublicApi` fixture
 * uses non-ADT-realistic type strings ("Method"/"Attribute") for every
 * member, public and private alike, so it never exercises real ADT type
 * codes at all and is unaffected by this fix either way.
 */
import { describe, expect, it } from "vitest";
import type { ClassMember } from "../src/adt/source.js";
import { summarisePublicApi } from "../src/adt/digest.js";

describe("summarisePublicApi: TYPES declarations do not inflate the hidden count (issue #108 defect 6)", () => {
  it("excludes a private CLAS/OT (TYPES) member from both rows and hiddenCounts", () => {
    const members: ClassMember[] = [
      { name: "DO_PUBLIC", type: "CLAS/OM", visibility: "public", level: "instance" },
      { name: "DO_PRIVATE", type: "CLAS/OM", visibility: "private", level: "instance" },
      {
        name: "IF_OO_ADT_CLASSRUN~MAIN",
        type: "CLAS/OM",
        visibility: "public",
        level: "instance",
      },
      { name: "TY_X", type: "CLAS/OT", visibility: "private" },
    ];

    const api = summarisePublicApi(members);

    expect(api.rows.map((r) => r.name)).toEqual(["DO_PUBLIC", "IF_OO_ADT_CLASSRUN~MAIN"]);
    // Matches outline's count exactly: DO_PRIVATE only, not DO_PRIVATE + TY_X.
    expect(api.hiddenCounts).toEqual([{ visibility: "private", count: 1 }]);
  });

  it("still counts a private CLAS/OM or CLAS/OA member normally", () => {
    const members: ClassMember[] = [
      { name: "DO_PRIVATE", type: "CLAS/OM", visibility: "private", level: "instance" },
      { name: "MV_STATE", type: "CLAS/OA", visibility: "private" },
    ];

    expect(summarisePublicApi(members).hiddenCounts).toEqual([{ visibility: "private", count: 2 }]);
  });

  it("excludes a public CLAS/OT (TYPES) member from the listed rows too", () => {
    // A public TYPES line isn't part of the API surface outline shows either
    // — it should not appear as a row any more than it inflates the hidden
    // count on the private side.
    const members: ClassMember[] = [
      { name: "DO_PUBLIC", type: "CLAS/OM", visibility: "public", level: "instance" },
      { name: "TY_PUBLIC", type: "CLAS/OT", visibility: "public" },
    ];

    const api = summarisePublicApi(members);
    expect(api.rows.map((r) => r.name)).toEqual(["DO_PUBLIC"]);
  });
});
