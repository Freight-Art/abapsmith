import { describe, expect, it } from "vitest";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { ERR_LINE_PREFIX } from "../src/adt/run.js";
import { DDIC_ERR_PREFIX } from "../src/adt/ddic-bridge.js";
import {
  IMGW_LINE_PREFIX,
  IMGW_BRIDGE_CLASS,
  IMGW_MAX_ROWS,
  CTS_INSERT_FM,
  type ImgWriteField,
  type ImgWriteRow,
  type ImgProbePlan,
  type ImgApplyPlan,
  validateProbePlan,
  validateApplyPlan,
  parseImgWriteTranscript,
} from "../src/adt/img-write-bridge.js";
import { imgSources } from "../src/adt/fluid/builtin/img.js";

const TABLE = "ZTEST01";
const CLIENT_FIELD = "MANDT";
const KEY_FIELD = "ZKEY";
const VAL_FIELD = "ZTEXT";
const VAL_FIELD2 = "ZFLAG";
const VIEW = "V_ZTEST01";

function baseProbe(overrides: Partial<ImgProbePlan> = {}): ImgProbePlan {
  return {
    table: TABLE,
    clientField: CLIENT_FIELD,
    keyFields: [KEY_FIELD],
    rows: [{ key: { [KEY_FIELD]: "A1" }, values: {} }],
    language: "E",
    ...overrides,
  };
}

function baseFields(): ImgWriteField[] {
  return [
    { field: KEY_FIELD, key: true, dataType: "CHAR" },
    { field: VAL_FIELD, key: false, dataType: "CHAR" },
    { field: VAL_FIELD2, key: false, dataType: "CHAR" },
  ];
}

function baseApply(overrides: Partial<ImgApplyPlan> = {}): ImgApplyPlan {
  return {
    ...baseProbe(),
    op: "upsert",
    fields: baseFields(),
    corrNr: "XXXK900001",
    expectedDeliveryClass: "C",
    expectedClientDependent: true,
    view: VIEW,
    masterType: "VDAT",
    rows: [{ key: { [KEY_FIELD]: "A1" }, values: { [VAL_FIELD]: "Hello" } }],
    ...overrides,
  };
}

function expectBadInput(fn: () => unknown): void {
  try {
    fn();
    throw new Error("expected to throw");
  } catch (e) {
    if (!isAbapError(e)) throw e;
    expect((e as AbapError).code).toBe("BAD_INPUT");
  }
}

// ---------------------------------------------------------------------------
// Static shape
// ---------------------------------------------------------------------------

describe("static exports", () => {
  it("bridge class names are fixed", () => {
    expect(IMGW_BRIDGE_CLASS.probe).toBe("ZCL_ZMCP_IMG_WPROBE");
    expect(IMGW_BRIDGE_CLASS.apply).toBe("ZCL_ZMCP_IMG_WAPPLY");
  });

  it("CTS_INSERT_FM is marked high confidence with a note, naming both FMs", () => {
    expect(CTS_INSERT_FM.confidence).toBe("high");
    expect(CTS_INSERT_FM.note.length).toBeGreaterThan(0);
    expect(CTS_INSERT_FM.checkFm).toBe("TR_OBJECTS_CHECK");
    expect(CTS_INSERT_FM.insertFm).toBe("TRINT_OBJECTS_CHECK_AND_INSERT");
    expect(CTS_INSERT_FM.params.objects).toBe("ct_ko200");
    expect(CTS_INSERT_FM.params.keys).toBe("ct_e071k");
    expect(CTS_INSERT_FM.params.order).toBe("iv_order");
    expect(CTS_INSERT_FM.params.withDialog).toBe("iv_with_dialog");
    expect(CTS_INSERT_FM.exceptions.cancelEditOtherError).not.toBe(CTS_INSERT_FM.exceptions.showOnlyOtherError);
  });

  it("CTS_INSERT_FM's note says plainly, near the front, that TRINT_OBJECTS_CHECK_AND_INSERT with 'D' is proven, and still names what's unproven", () => {
    const upfront = CTS_INSERT_FM.note.slice(0, 80).toUpperCase();
    expect(upfront).toContain("PROVEN");
    expect(upfront).not.toContain("UNPROVEN");
    expect(CTS_INSERT_FM.note).toContain("TRINT_OBJECTS_CHECK_AND_INSERT");
    expect(CTS_INSERT_FM.note).toContain("'D'");
    expect(CTS_INSERT_FM.note).toContain("space is check-only");
    expect(CTS_INSERT_FM.note).toContain("Still unproven");
    expect(CTS_INSERT_FM.params.weOrder).toBe("ev_order");
    expect(CTS_INSERT_FM.params.weTask).toBe("ev_task");
  });

  it("IMGW_MAX_ROWS is 50", () => {
    expect(IMGW_MAX_ROWS).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

describe("validateProbePlan", () => {
  it("accepts a minimal valid plan", () => {
    expect(() => validateProbePlan(baseProbe())).not.toThrow();
  });

  it("rejects a table name that fails the identifier grammar", () => {
    expectBadInput(() => validateProbePlan(baseProbe({ table: "bad name!" })));
  });

  it("rejects a field name over 30 characters", () => {
    expectBadInput(() => validateProbePlan(baseProbe({ keyFields: ["A".repeat(31)] })));
  });

  it("rejects a plan with no key fields", () => {
    expectBadInput(() => validateProbePlan(baseProbe({ keyFields: [] })));
  });

  it("rejects keyFields that include the client field", () => {
    expectBadInput(() => validateProbePlan(baseProbe({ keyFields: [KEY_FIELD, CLIENT_FIELD] })));
  });

  it("rejects duplicate key fields", () => {
    expectBadInput(() => validateProbePlan(baseProbe({ keyFields: [KEY_FIELD, KEY_FIELD] })));
  });

  it("rejects a row missing a declared key field", () => {
    expectBadInput(() =>
      validateProbePlan(
        baseProbe({ keyFields: [KEY_FIELD, "ZKEY2"], rows: [{ key: { [KEY_FIELD]: "A1" }, values: {} }] }),
      ),
    );
  });

  it("rejects a row naming a key field not in keyFields", () => {
    expectBadInput(() =>
      validateProbePlan(baseProbe({ rows: [{ key: { [KEY_FIELD]: "A1", ZBOGUS: "x" }, values: {} }] })),
    );
  });

  it("rejects a caller-supplied value for the client field in a row key", () => {
    expectBadInput(() =>
      validateProbePlan(baseProbe({ rows: [{ key: { [KEY_FIELD]: "A1", [CLIENT_FIELD]: "100" }, values: {} }] })),
    );
  });

  it("rejects more than IMGW_MAX_ROWS rows", () => {
    const rows: ImgWriteRow[] = Array.from({ length: IMGW_MAX_ROWS + 1 }, (_, i) => ({
      key: { [KEY_FIELD]: `A${i}` },
      values: {},
    }));
    expectBadInput(() => validateProbePlan(baseProbe({ rows })));
  });

  it("accepts exactly IMGW_MAX_ROWS rows", () => {
    const rows: ImgWriteRow[] = Array.from({ length: IMGW_MAX_ROWS }, (_, i) => ({
      key: { [KEY_FIELD]: `A${i}` },
      values: {},
    }));
    expect(() => validateProbePlan(baseProbe({ rows }))).not.toThrow();
  });

  it("rejects a key value with an embedded control character", () => {
    expectBadInput(() =>
      validateProbePlan(baseProbe({ rows: [{ key: { [KEY_FIELD]: "A1\nB2" }, values: {} }] })),
    );
  });

  it("rejects a key value over the length cap", () => {
    expectBadInput(() =>
      validateProbePlan(baseProbe({ rows: [{ key: { [KEY_FIELD]: "A".repeat(300) }, values: {} }] })),
    );
  });

  // Regression pin for the live round-2 finding: SAP's catalog language columns
  // (SPRAS/DDLANGUAGE/SPRSL/LANGUAGE) are all C(1,0) — a two-character ISO code
  // like "EN" gets HTTP 400 'EN' is not a valid value for C(1,0)'. This module
  // used to carry its own looser copy (assertWriteLanguage, 1-2 letters) instead
  // of the shared img-query.ts validator (assertImgLanguage, exactly 1 letter) —
  // that divergence is exactly what let a two-character key reach a live run.
  it("rejects a two-character language key", () => {
    expectBadInput(() => validateProbePlan(baseProbe({ language: "EN" })));
  });

  it("accepts a single-character language key", () => {
    expect(() => validateProbePlan(baseProbe({ language: "E" }))).not.toThrow();
  });
});

describe("validateApplyPlan", () => {
  it("accepts a minimal valid upsert plan", () => {
    expect(() => validateApplyPlan(baseApply())).not.toThrow();
  });

  it("accepts a minimal valid delete plan", () => {
    expect(() =>
      validateApplyPlan(baseApply({ op: "delete", rows: [{ key: { [KEY_FIELD]: "A1" }, values: {} }] })),
    ).not.toThrow();
  });

  it("rejects an op other than upsert/delete", () => {
    expectBadInput(() => validateApplyPlan(baseApply({ op: "bogus" as never })));
  });

  it("rejects a field declared as the client field", () => {
    expectBadInput(() =>
      validateApplyPlan(baseApply({ fields: [...baseFields(), { field: CLIENT_FIELD, key: false, dataType: "CLNT" }] })),
    );
  });

  // OLD (wrong) behavior this replaces: "rejects zero value fields on an upsert row" —
  //   expectBadInput(() => validateApplyPlan(baseApply({ rows: [{ key: { [KEY_FIELD]: "A1" }, values: {} }] })));
  // A key-only row IS a legal upsert: SM30 itself accepts a row on a table (e.g. TB004, key
  // BPKIND) whose every non-key column is optional — inserted with just the key/client set if
  // absent, a no-op if already present. Preview already rendered this row with an empty SET
  // and no error; only the apply-side validator disagreed. They must not disagree.
  it("accepts zero value fields on an upsert row (a key-only row is a legal upsert)", () => {
    expect(() =>
      validateApplyPlan(baseApply({ rows: [{ key: { [KEY_FIELD]: "A1" }, values: {} }] })),
    ).not.toThrow();
  });

  it("allows zero value fields on a delete row", () => {
    expect(() =>
      validateApplyPlan(baseApply({ op: "delete", rows: [{ key: { [KEY_FIELD]: "A1" }, values: {} }] })),
    ).not.toThrow();
  });

  it("rejects a caller-supplied value for the client field", () => {
    expectBadInput(() =>
      validateApplyPlan(
        baseApply({ rows: [{ key: { [KEY_FIELD]: "A1" }, values: { [VAL_FIELD]: "x", [CLIENT_FIELD]: "100" } }] }),
      ),
    );
  });

  it("rejects a value field not declared in fields", () => {
    expectBadInput(() =>
      validateApplyPlan(baseApply({ rows: [{ key: { [KEY_FIELD]: "A1" }, values: { ZUNDECLARED: "x" } }] })),
    );
  });

  it("accepts a row naming a declared non-key column", () => {
    expect(() =>
      validateApplyPlan(baseApply({ rows: [{ key: { [KEY_FIELD]: "A1" }, values: { [VAL_FIELD]: "Hello" } }] })),
    ).not.toThrow();
  });

  // Better refusal for an unknown value name: name what IS writable, both in the message and in
  // details.valueFields, rather than the old bare "not declared in this plan's fields."
  it("names the declared value columns in the refusal message and in details.valueFields", () => {
    try {
      validateApplyPlan(baseApply({ rows: [{ key: { [KEY_FIELD]: "A1" }, values: { ZUNDECLARED: "x" } }] }));
      throw new Error("expected to throw");
    } catch (e) {
      if (!isAbapError(e)) throw e;
      const err = e as AbapError;
      expect(err.code).toBe("BAD_INPUT");
      expect(err.message).toContain(VAL_FIELD);
      expect(err.message).toContain(VAL_FIELD2);
      expect(err.message).toContain(TABLE);
      expect((err.details as { valueFields?: string[] }).valueFields).toEqual([VAL_FIELD, VAL_FIELD2]);
      expect((err.details as { row?: number; field?: string }).row).toBe(0);
      expect((err.details as { row?: number; field?: string }).field).toBe("ZUNDECLARED");
    }
  });

  it("says explicitly that the probe reported no non-key columns when the plan declares none", () => {
    try {
      validateApplyPlan(
        baseApply({
          fields: [{ field: KEY_FIELD, key: true, dataType: "CHAR" }],
          rows: [{ key: { [KEY_FIELD]: "A1" }, values: { ZUNDECLARED: "x" } }],
        }),
      );
      throw new Error("expected to throw");
    } catch (e) {
      if (!isAbapError(e)) throw e;
      const err = e as AbapError;
      expect(err.message).toContain("no non-key columns");
      expect((err.details as { valueFields?: string[] }).valueFields).toEqual([]);
    }
  });

  // The exact live regression measured 2026-09-06: an armed upsert on TB004T (keys SPRAS +
  // BPKIND, value column TEXT40) was refused before any wire call with "row 0 names value field
  // TEXT40, which is not declared in this plan's fields." — because the probe only ever emitted
  // key fields, so TEXT40 could never appear in a plan's fields no matter how the plan was built.
  it("accepts an upsert row naming TEXT40 on a table keyed SPRAS + BPKIND", () => {
    const plan: ImgApplyPlan = {
      table: "TB004T",
      clientField: "MANDT",
      keyFields: ["SPRAS", "BPKIND"],
      language: "E",
      op: "upsert",
      fields: [
        { field: "SPRAS", key: true, dataType: "LANG" },
        { field: "BPKIND", key: true, dataType: "CHAR" },
        { field: "TEXT40", key: false, dataType: "CHAR" },
      ],
      corrNr: "XXXK900001",
      expectedDeliveryClass: "C",
      expectedClientDependent: true,
      view: "V_TB004T",
      masterType: "VDAT",
      rows: [{ key: { SPRAS: "E", BPKIND: "01" }, values: { TEXT40: "Some description" } }],
    };
    expect(() => validateApplyPlan(plan)).not.toThrow();
  });

  it("rejects a malformed corrNr", () => {
    expectBadInput(() => validateApplyPlan(baseApply({ corrNr: "not-a-transport" })));
  });

  it("accepts the mandated fake transport shape", () => {
    expect(() => validateApplyPlan(baseApply({ corrNr: "XXXK900001" }))).not.toThrow();
  });

  it("rejects a value with an embedded control character", () => {
    expectBadInput(() =>
      validateApplyPlan(baseApply({ rows: [{ key: { [KEY_FIELD]: "A1" }, values: { [VAL_FIELD]: "a\nb" } }] })),
    );
  });

  it("rejects a missing view", () => {
    expectBadInput(() => validateApplyPlan(baseApply({ view: "" })));
  });

  it("rejects a malformed view name", () => {
    expectBadInput(() => validateApplyPlan(baseApply({ view: "bad view!" })));
  });

  it("accepts a masterType of CDAT", () => {
    expect(() => validateApplyPlan(baseApply({ masterType: "CDAT" }))).not.toThrow();
  });

  it("rejects a masterType that is not VDAT or CDAT", () => {
    expectBadInput(() => validateApplyPlan(baseApply({ masterType: "BOGUS" as never })));
  });
});

// ---------------------------------------------------------------------------
// Generation properties
// ---------------------------------------------------------------------------
//
// The per-call `imgProbeSource` generator this section used to test (one
// `IF_OO_ADT_CLASSRUN` class body regenerated per call, parameterized by key
// count) has been deleted outright: `img.preview`'s live ABAP body was ported
// into the single, generic, content-addressed `ZCL_ZMCP_FLUID_IMG` class
// (`src/adt/fluid/builtin/img.ts`), which is shipped once and reused across
// every call rather than regenerated per call, and nothing in `src/` called
// `imgProbeSource` any more once that port was done. Its dedicated tests are
// gone with it; the "reads every column, not just the keys" and "FLD line
// round-trips through the parser" properties they pinned are now covered
// against the shipped class's actual runtime behavior in
// `test/img-edit-tool.test.ts` / `test/integration-fluid-img.test.ts`, not
// against generated source text.

// Regression pin for the live incident measured 2026-09-06: an armed upsert
// on a multi-key table (TB004T, keyed SPRAS + BPKIND) failed activation with
// `"LV_KEY_FLAG" was already declared` — the retired per-call
// `imgProbeSource` generator ran one SELECT per key field, each binding its
// four result variables with inline `@DATA(...)`, which is only legal the
// first time a name is bound in a scope. That failure mode was a property of
// *generating* a class body as a function of key count: more keys meant more
// copies of the same inline binding in the same method.
//
// `ZCL_ZMCP_FLUID_IMG` structurally cannot repeat it, but not because some
// generator was fixed — there is no longer a generator. The class is typed
// generically (`ASSIGN COMPONENT ... OF STRUCTURE`, dynamic `SELECT`) and
// ships as one static, hand-written body regardless of table/key shape, so
// there is no per-call parameterization left to regress. The guarantee this
// block pins is therefore no longer "the generator can't produce this shape
// for any key count" (that generator is gone) but "the shipped source itself
// never contains a duplicate inline `@DATA(name)` binding within the same
// method" — a source-text invariant on the one static body that ships,
// rather than a property re-derived per call. It is still a real regression
// guard: it fails the moment anyone reintroduces an inline `@DATA(...)` into
// `IMG_SOURCE` that collides with another in the same method, which is
// exactly the shape of bug that caused the original incident.
describe("ZCL_ZMCP_FLUID_IMG's shipped source never declares the same inline @DATA(name) twice in one method", () => {
  const IMG_CLASS = "ZCL_ZMCP_FLUID_IMG";

  function shippedSource(): string {
    const src = imgSources.get(IMG_CLASS);
    if (src === undefined) throw new Error(`imgSources has no entry for ${IMG_CLASS}`);
    return src;
  }

  // Splits the class body into per-METHOD segments (ABAP scopes an inline
  // `@DATA(name)` binding to its enclosing method, not to the whole class),
  // so a name reused across two different methods is not a false positive.
  function methodSegments(source: string): { name: string; body: string }[] {
    const lines = source.split("\n");
    const segments: { name: string; body: string }[] = [];
    let current: { name: string; lines: string[] } | null = null;
    const methodStart = /^\s*METHOD\s+(\w+)\s*\.\s*$/i;
    const methodEnd = /^\s*ENDMETHOD\s*\.\s*$/i;
    for (const line of lines) {
      const start = methodStart.exec(line);
      if (start) {
        current = { name: start[1]!, lines: [] };
        continue;
      }
      if (methodEnd.test(line)) {
        if (current) segments.push({ name: current.name, body: current.lines.join("\n") });
        current = null;
        continue;
      }
      if (current) current.lines.push(line);
    }
    return segments;
  }

  function duplicateInlineDataNames(body: string): string[] {
    const names = [...body.matchAll(/@DATA\(([a-zA-Z_][a-zA-Z0-9_]*)\)/g)].map((m) => m[1]!);
    const counts = new Map<string, number>();
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
    return [...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n);
  }

  it("has at least one METHOD to check (the scan below isn't vacuously scanning nothing)", () => {
    const segments = methodSegments(shippedSource());
    expect(segments.length).toBeGreaterThan(0);
  });

  it("declares no inline @DATA(name) twice within any single method", () => {
    const segments = methodSegments(shippedSource());
    for (const { name, body } of segments) {
      const dupes = duplicateInlineDataNames(body);
      expect(dupes, `METHOD ${name}: duplicate inline @DATA(...) declaration(s): ${dupes.join(", ")}`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

describe("parseImgWriteTranscript", () => {
  it("parses every tag", () => {
    const text = [
      `${IMGW_LINE_PREFIX}CLIENT mandt=[100] cccategory=[] cccoractiv=[]`,
      `${IMGW_LINE_PREFIX}TABLE table=[${TABLE}] delclass=[C] clidep=[X]`,
      `${IMGW_LINE_PREFIX}FLD table=[${TABLE}] field=[${KEY_FIELD}] key=[X] type=[CHAR] len=[10] rollname=[ZKEY_DE]`,
      `${IMGW_LINE_PREFIX}BVAL row=[1] field=[${VAL_FIELD}] len=[5] value=[Hello]`,
      `${IMGW_LINE_PREFIX}BABSENT row=[2]`,
      `${IMGW_LINE_PREFIX}TRKEY row=[1] trkorr=[XXXK900001] len=[7] value=[A1     ]`,
      `${IMGW_LINE_PREFIX}AVAL row=[1] field=[${VAL_FIELD}] len=[2] value=[Hi]`,
      `${IMGW_LINE_PREFIX}AABSENT row=[2]`,
      `${IMGW_LINE_PREFIX}NOTE text=[something happened]`,
      `${IMGW_LINE_PREFIX}PROBED rows=[2]`,
      `${IMGW_LINE_PREFIX}APPLIED rows=[2]`,
    ].join("\n");

    const t = parseImgWriteTranscript(text);

    expect(t.client).toEqual({ mandt: "100", cccategory: "", cccoractiv: "" });
    expect(t.table).toEqual({ table: TABLE, deliveryClass: "C", clientDependent: true });
    expect(t.fields).toEqual([
      { table: TABLE, field: KEY_FIELD, key: true, dataType: "CHAR", length: "10", dataElement: "ZKEY_DE" },
    ]);
    expect(t.before).toEqual([{ row: 1, field: VAL_FIELD, len: 5, value: "Hello" }]);
    expect(t.beforeAbsent).toEqual([{ row: 2 }]);
    expect(t.trkeys).toEqual([{ row: 1, trkorr: "XXXK900001", len: 7, value: "A1     " }]);
    expect(t.after).toEqual([{ row: 1, field: VAL_FIELD, len: 2, value: "Hi" }]);
    expect(t.afterAbsent).toEqual([{ row: 2 }]);
    expect(t.notes).toEqual(["something happened"]);
    expect(t.probed).toBe(true);
    expect(t.applied).toBe(2);
    expect(t.droppedLines).toBe(0);
    expect(t.errors).toEqual([]);
  });

  it("recovers a BVAL value that itself contains a closing bracket", () => {
    const text = `${IMGW_LINE_PREFIX}BVAL row=[1] field=[${VAL_FIELD}] len=[3] value=[A]B]`;
    const t = parseImgWriteTranscript(text);
    expect(t.before).toEqual([{ row: 1, field: VAL_FIELD, len: 3, value: "A]B" }]);
    expect(t.droppedLines).toBe(0);
  });

  it("recovers significant trailing blanks stripped before the closing bracket", () => {
    // len=[4] declares "Hi  " (two trailing spaces) but the line as received only shows "Hi".
    const text = `${IMGW_LINE_PREFIX}BVAL row=[1] field=[${VAL_FIELD}] len=[4] value=[Hi]`;
    const t = parseImgWriteTranscript(text);
    expect(t.before).toEqual([{ row: 1, field: VAL_FIELD, len: 4, value: "Hi  " }]);
  });

  it("parses a TRKEY line where the recorded task differs from the requested request, reporting both", () => {
    const text = `${IMGW_LINE_PREFIX}TRKEY row=[1] trkorr=[XXXK900001] order_len=[10] order=[XXXK900001] task_len=[10] task=[XXXK900002] len=[7] value=[A1     ]`;
    const t = parseImgWriteTranscript(text);
    expect(t.droppedLines).toBe(0);
    expect(t.trkeys).toEqual([
      {
        row: 1,
        trkorr: "XXXK900001",
        len: 7,
        value: "A1     ",
        recordedOrder: "XXXK900001",
        recordedTask: "XXXK900002",
      },
    ]);
    // the point of carrying both: the recorded task is not the requested request.
    expect(t.trkeys[0]!.recordedTask).not.toBe(t.trkeys[0]!.trkorr);
  });

  it("still parses a TRKEY line missing the order/task fields (older-shaped line), leaving them undefined", () => {
    const text = `${IMGW_LINE_PREFIX}TRKEY row=[1] trkorr=[XXXK900001] len=[7] value=[A1     ]`;
    const t = parseImgWriteTranscript(text);
    expect(t.droppedLines).toBe(0);
    expect(t.trkeys).toEqual([{ row: 1, trkorr: "XXXK900001", len: 7, value: "A1     " }]);
    expect(t.trkeys[0]!.recordedOrder).toBeUndefined();
    expect(t.trkeys[0]!.recordedTask).toBeUndefined();
  });

  it("counts an unrecognized tag as a dropped line", () => {
    const text = `${IMGW_LINE_PREFIX}BOGUS foo=[bar]`;
    const t = parseImgWriteTranscript(text);
    expect(t.droppedLines).toBe(1);
  });

  it("counts a line with the prefix but no matching field as dropped", () => {
    const text = `${IMGW_LINE_PREFIX}CLIENT mandt=[100]`; // missing cccategory/cccoractiv
    const t = parseImgWriteTranscript(text);
    expect(t.droppedLines).toBe(1);
    expect(t.client).toBeNull();
  });

  it("counts an unrelated non-prefixed, non-blank line as dropped", () => {
    const text = "this is not a transcript line";
    const t = parseImgWriteTranscript(text);
    expect(t.droppedLines).toBe(1);
  });

  it("ignores blank lines without dropping them", () => {
    const text = `${IMGW_LINE_PREFIX}NOTE text=[x]\n\n\n`;
    const t = parseImgWriteTranscript(text);
    expect(t.droppedLines).toBe(0);
  });

  it("routes DDIC_ERR_PREFIX lines to errors", () => {
    const text = `${DDIC_ERR_PREFIX} something went wrong`;
    const t = parseImgWriteTranscript(text);
    expect(t.errors).toEqual(["something went wrong"]);
  });

  it("routes ERR_LINE_PREFIX lines to errors", () => {
    const text = `${ERR_LINE_PREFIX}unhandled exception text`;
    const t = parseImgWriteTranscript(text);
    expect(t.errors).toEqual(["unhandled exception text"]);
  });

  it("maps an IMGW> ERROR line into errors with the exception class name visible", () => {
    const text = `${IMGW_LINE_PREFIX}ERROR class=[CX_SY_DYN_CALL_ILLEGAL_TYPE] len=[19] value=[bad table type here]`;
    const t = parseImgWriteTranscript(text);
    expect(t.droppedLines).toBe(0);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0]).toContain("CX_SY_DYN_CALL_ILLEGAL_TYPE");
    expect(t.errors[0]).toContain("bad table type here");
  });

  it("recovers an ERROR value that itself contains a closing bracket", () => {
    // get_text( ) is free text and can contain "]" — same rationale as BVAL/AVAL/TRKEY.
    const text = `${IMGW_LINE_PREFIX}ERROR class=[CX_SY_DYN_CALL_ILLEGAL_TYPE] len=[3] value=[A]B]`;
    const t = parseImgWriteTranscript(text);
    expect(t.droppedLines).toBe(0);
    expect(t.errors).toEqual([`CX_SY_DYN_CALL_ILLEGAL_TYPE: A]B`]);
  });

  it("counts a malformed ERROR line (missing len/value) as dropped, never silently ignored", () => {
    const text = `${IMGW_LINE_PREFIX}ERROR class=[CX_SY_DYN_CALL_ILLEGAL_TYPE]`;
    const t = parseImgWriteTranscript(text);
    expect(t.droppedLines).toBe(1);
    expect(t.errors).toEqual([]);
  });

  it("fills wrote with the row numbers seen on IMGW> WROTE lines", () => {
    const text = [`${IMGW_LINE_PREFIX}WROTE row=[1]`, `${IMGW_LINE_PREFIX}WROTE row=[2]`].join("\n");
    const t = parseImgWriteTranscript(text);
    expect(t.wrote).toEqual([1, 2]);
    expect(t.droppedLines).toBe(0);
  });

  it("counts a malformed WROTE line as dropped, never silently ignored", () => {
    const text = `${IMGW_LINE_PREFIX}WROTE rowX=[1]`;
    const t = parseImgWriteTranscript(text);
    expect(t.droppedLines).toBe(1);
    expect(t.wrote).toEqual([]);
  });
});
