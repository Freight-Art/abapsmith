/**
 * Live-usage follow-up: the two ways `abap_write` told a caller nothing
 * it could act on.
 *
 * Across one observed run there were 312 `abap_write` calls. Exactly 4 used
 * the `edit` or `method` shapes and all 4 failed, all against CLAS/OC
 * ZTM_CL_HWOOP_VIEW_WRITE:
 *
 *  1. `edit` passed as a JSON *string* rather than an object. The tool
 *     diagnosed it as a MISSING `source` and then recommended
 *     `{edit:{old_string,new_string}}` — the exact shape it had just discarded.
 *     A caller told to do the thing it is already doing cannot recover.
 *  2. `{object, method, source}` with no `type` — recoverable, and recovered.
 *  3. `{object, type, method, source}` with a BARE method body
 *     → ADT_ERROR "The statement IF is unexpected", t100 OO_SOURCE_BASED/38.
 *  4. the same call with the body wrapped in its own METHOD/ENDMETHOD
 *     → ADT_ERROR "The statement METHOD ... . is unexpected", same t100.
 *
 * 3 and 4 are the important pair: the caller tried BOTH readings of what
 * `source` means under `method` and got a raw ABAP parser token complaint each
 * time. There is no third reading available, so it was hard-stuck on an error
 * that never stated the contract it was failing.
 *
 * Two invariants fall out, and this file pins both:
 *  - a string-valued `edit` is diagnosed AS a wrong-typed `edit`, never as a
 *    missing `source`;
 *  - an "unexpected statement" rejection carries the shape THIS tool expects,
 *    for the write form the caller actually used.
 *
 * Everything here is offline and pure — no connection, no fake HTTP, no A4H.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AbapError } from "../src/adt/errors.js";
import {
  isUnexpectedStatementRejection,
  rethrowWithSourceShapeHint,
  sourceShapeGuidance,
  writeInputSchema,
} from "../src/tools/write.js";

const shape = z.object(writeInputSchema);

describe("a string-valued `edit` is diagnosed as `edit`, not as a missing `source`", () => {
  // The verbatim argument object from the first observed failing call.
  const ARGS = {
    object: "ZTM_CL_HWOOP_VIEW_WRITE",
    edit: '{"old_string": "No transport orders found for the given selection.", "new_string": "No transport orders match the given selection."}',
  };

  it("rejects it at the schema, pointing at `edit` and naming both types", () => {
    const res = shape.safeParse(ARGS);
    expect(res.success).toBe(false);
    if (res.success) return;
    const issue = res.error.issues.find((i) => i.path[0] === "edit");
    expect(issue, "the failure must be attributed to `edit`").toBeDefined();
    expect(issue?.code).toBe("invalid_type");
    // Names what was wanted AND what arrived — enough to fix in one step.
    expect(issue?.message).toMatch(/object/i);
    expect(issue?.message).toMatch(/string/i);
  });

  it("never reaches the generic `source` is required branch", () => {
    const res = shape.safeParse(ARGS);
    expect(res.success).toBe(false);
    if (res.success) return;
    // The regression itself: `edit` undeclared meant zod stripped it, the call
    // parsed CLEANLY as {object}, and resolveWriteSource fell through to
    // "`source` is required for mode=write." Validation failing here is what
    // makes that fall-through unreachable for a wrong-typed `edit`.
    const combined = res.error.issues.map((i) => i.message).join(" ");
    expect(combined).not.toMatch(/source. is required/i);
    expect(res.error.issues.some((i) => i.path[0] === "source")).toBe(false);
  });

  it("accepts the object form the hint actually recommends", () => {
    const res = shape.safeParse({
      object: "ZTM_CL_HWOOP_VIEW_WRITE",
      edit: {
        old_string: "No transport orders found for the given selection.",
        new_string: "No transport orders match the given selection.",
      },
    });
    expect(res.success).toBe(true);
    // The advertised recovery must be a real one — this is the pairing the
    // observed failure broke: hint said X, schema rejected X.
    if (res.success) expect(res.data.edit).toEqual({
      old_string: "No transport orders found for the given selection.",
      new_string: "No transport orders match the given selection.",
    });
  });
});

describe("isUnexpectedStatementRejection — keyed on the T100, not on prose", () => {
  const err = (details: Record<string, unknown>, message = "Something failed"): AbapError =>
    new AbapError("ADT_ERROR", message, details);

  it("matches the raw T100KEY properties shape (src/adt/session.ts)", () => {
    expect(
      isUnexpectedStatementRejection(
        err({ t100: { "T100KEY-ID": "OO_SOURCE_BASED", "T100KEY-NO": "038" } }),
      ),
    ).toBe(true);
  });

  it("matches the normalised {id,no} shape (src/tool-errors.ts)", () => {
    expect(isUnexpectedStatementRejection(err({ t100: { id: "OO_SOURCE_BASED", no: "038" } }))).toBe(
      true,
    );
  });

  it("treats 38 and 038 as the same message number", () => {
    expect(isUnexpectedStatementRejection(err({ t100: { id: "OO_SOURCE_BASED", no: "38" } }))).toBe(
      true,
    );
  });

  it("finds the key when it is nested deeper in the envelope", () => {
    expect(
      isUnexpectedStatementRejection(
        err({ adt: { properties: { "T100KEY-ID": "OO_SOURCE_BASED", "T100KEY-NO": "038" } } }),
      ),
    ).toBe(true);
  });

  it("falls back to the message text when the key was lost in transit", () => {
    expect(isUnexpectedStatementRejection(err({}, "The statement METHOD ... . is unexpected"))).toBe(
      true,
    );
    expect(isUnexpectedStatementRejection(err({}, "The statement IF is unexpected"))).toBe(true);
  });

  it("does not fire on an unrelated failure", () => {
    expect(isUnexpectedStatementRejection(err({ t100: { id: "CTS_WBO_API", no: "037" } }))).toBe(
      false,
    );
    expect(isUnexpectedStatementRejection(err({}, "Object is locked by another session"))).toBe(
      false,
    );
    expect(isUnexpectedStatementRejection(new Error("plain"))).toBe(false);
    expect(isUnexpectedStatementRejection(undefined)).toBe(false);
  });
});

describe("sourceShapeGuidance — names the shape for the form actually used", () => {
  it("for a `method` write, requires the full METHOD ... ENDMETHOD. block and names the method", () => {
    const g = sourceShapeGuidance({ method: "ZTM_IF_HWOOP_VIEW~ON_SHOW_DATA" });
    expect(g).toContain("ZTM_IF_HWOOP_VIEW~ON_SHOW_DATA");
    expect(g).toMatch(/METHOD .* ENDMETHOD\./);
    // Campaign call 3 sent a bare body; the guidance must close that reading off
    // explicitly rather than leaving it as a third thing to guess at.
    expect(g).toMatch(/body alone is not accepted|never auto-wrapped/);
  });

  it("for a whole-object write of a class, demands the full CLASS scaffolding", () => {
    const g = sourceShapeGuidance({}, "CLAS/OC");
    expect(g).toMatch(/REPLACES THE WHOLE OBJECT/);
    expect(g).toContain("ENDCLASS.");
    // and points at the two cheaper forms, which is what the stuck caller needed
    expect(g).toContain("method");
    expect(g).toContain("edit");
  });

  it("for a whole-object write of a non-class, stays generic rather than guessing", () => {
    const g = sourceShapeGuidance({}, "PROG/P");
    expect(g).toMatch(/COMPLETE source/i);
    expect(g).not.toContain("ENDCLASS.");
  });

  it("for an `edit` write, blames the splice boundary rather than the object shape", () => {
    const g = sourceShapeGuidance({ edit: { old_string: "a", new_string: "b" } });
    expect(g).toMatch(/statement boundary/);
    expect(g).not.toMatch(/REPLACES THE WHOLE OBJECT/);
  });
});

describe("rethrowWithSourceShapeHint — appends the contract, never rewrites the cause", () => {
  const rejection = new AbapError(
    "ADT_ERROR",
    "The statement METHOD ... . is unexpected",
    { t100: { "T100KEY-ID": "OO_SOURCE_BASED", "T100KEY-NO": "038" }, object: "ZTM_CL_HWOOP_VIEW_WRITE" },
    "Check the syntax.",
  );

  it("keeps SAP's own message verbatim", () => {
    try {
      rethrowWithSourceShapeHint(rejection, { method: "ZTM_IF_HWOOP_VIEW~ON_SHOW_DATA" }, "CLAS/OC");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AbapError);
      const err = e as AbapError;
      // The server's words are evidence. They are not ours to reword.
      expect(err.message).toBe("The statement METHOD ... . is unexpected");
      expect(err.code).toBe("ADT_ERROR");
    }
  });

  it("adds the expected shape to both the hint and the details", () => {
    try {
      rethrowWithSourceShapeHint(rejection, { method: "ZTM_IF_HWOOP_VIEW~ON_SHOW_DATA" }, "CLAS/OC");
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as AbapError;
      expect(err.hint).toContain("Check the syntax.");
      expect(err.hint).toMatch(/METHOD .* ENDMETHOD\./);
      expect(err.details.expectedSourceShape).toMatch(/METHOD .* ENDMETHOD\./);
      // preserves what was already there
      expect(err.details.object).toBe("ZTM_CL_HWOOP_VIEW_WRITE");
    }
  });

  it("tells the whole-object caller the thing that would have unstuck it", () => {
    // This is the third/fourth observed call as the caller actually
    // experienced it: `method` had been stripped, so this was a whole-object
    // write of a bare block.
    try {
      rethrowWithSourceShapeHint(
        new AbapError("ADT_ERROR", "The statement IF is unexpected", {
          t100: { id: "OO_SOURCE_BASED", no: "038" },
        }),
        {},
        "CLAS/OC",
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as AbapError;
      expect(err.hint).toMatch(/REPLACES THE WHOLE OBJECT/);
      expect(err.hint).toContain("ENDCLASS.");
    }
  });

  it("passes an unrelated error through completely untouched", () => {
    const other = new AbapError("LOCKED", "Object is locked", { blockingUser: "DEVELOPER" }, "Wait.");
    try {
      rethrowWithSourceShapeHint(other, { method: "M" }, "CLAS/OC");
      expect.unreachable("should have thrown");
    } catch (e) {
      // Identity, not equality: nothing may be rebuilt on a path that is not ours.
      expect(e).toBe(other);
      expect((e as AbapError).hint).toBe("Wait.");
      expect((e as AbapError).details.expectedSourceShape).toBeUndefined();
    }
  });

  it("rethrows a non-AbapError as-is", () => {
    const boom = new Error("socket hang up");
    expect(() => rethrowWithSourceShapeHint(boom, {}, "CLAS/OC")).toThrow(boom);
  });
});
