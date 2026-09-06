import { describe, expect, it } from "vitest";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { ERR_LINE_PREFIX } from "../src/adt/run.js";
import { ABAP_SOURCE_LINE_MAX, DDIC_ERR_PREFIX } from "../src/adt/ddic-bridge.js";
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
  imgProbeSource,
  imgApplySource,
  parseImgWriteTranscript,
} from "../src/adt/img-write-bridge.js";

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

function maxLineLength(source: string): number {
  return Math.max(...source.split("\n").map((l) => l.length));
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
    expect(CTS_INSERT_FM.insertFm).toBe("TR_OBJECTS_INSERT");
    expect(CTS_INSERT_FM.params.objects).toBe("wt_ko200");
    expect(CTS_INSERT_FM.exceptions.cancelEditOtherError).not.toBe(CTS_INSERT_FM.exceptions.showOnlyOtherError);
  });

  it("CTS_INSERT_FM's note says plainly, near the front, that both FMs have been called successfully from here, and still names what's unproven", () => {
    const upfront = CTS_INSERT_FM.note.slice(0, 80).toUpperCase();
    expect(upfront).toContain("PROVEN");
    expect(upfront).not.toContain("UNPROVEN");
    expect(CTS_INSERT_FM.note).toContain(
      "TR_OBJECTS_CHECK and TR_OBJECTS_INSERT were both called from this server",
    );
    expect(CTS_INSERT_FM.note).toContain("STILL UNPROVEN FROM HERE");
    expect(CTS_INSERT_FM.params.weOrder).toBe("we_order");
    expect(CTS_INSERT_FM.params.weTask).toBe("we_task");
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

describe("imgProbeSource", () => {
  it("generates a class body for the fixed probe class name", () => {
    const src = imgProbeSource(baseProbe());
    expect(src).toContain("ztest01_local".slice(0, 0)); // no-op guard against accidental literal drift
    expect(src.toLowerCase()).toContain("zcl_zmcp_img_wprobe");
    expect(src).toContain(`SELECT SINGLE * FROM ${TABLE.toLowerCase()} INTO @ls_wa`);
  });

  it("stays within ABAP_SOURCE_LINE_MAX at longest legal input", () => {
    const table = "Z" + "A".repeat(29);
    const keyField = "K".repeat(30);
    const rows: ImgWriteRow[] = Array.from({ length: IMGW_MAX_ROWS }, (_, i) => ({
      key: { [keyField]: `V${i}` },
      values: {},
    }));
    const src = imgProbeSource({ table, clientField: CLIENT_FIELD, keyFields: [keyField], rows, language: "E" });
    expect(maxLineLength(src)).toBeLessThanOrEqual(ABAP_SOURCE_LINE_MAX);
  });

  // Core regression for the live 2026-09-06 TB004T finding: the probe's only IMGW> FLD emission
  // used to sit inside the per-key-field loop, so it reported KEY FIELDS ONLY — an apply plan
  // built from that probe could never legally name a value column. The fix reads every column of
  // the base table once and reports each of them.
  it("reads every column of the base table, not just the key fields", () => {
    const src = imgProbeSource(
      baseProbe({ keyFields: [KEY_FIELD, "ZKEY2"], rows: [{ key: { [KEY_FIELD]: "A1", ZKEY2: "B2" }, values: {} }] }),
    );
    // Exactly one DD03L read, regardless of key count.
    expect(src.split("FROM dd03l").length - 1).toBe(1);
    // Never restricted to a particular fieldname — every column comes back, not just the keys.
    expect(src).not.toContain("fieldname = '");
    // position is selected purely so ORDER BY position cannot trip the strict-SQL check.
    expect(src).toContain("ORDER BY position.");
    // The .INCLUDE/.APPEND marker-row guard.
    expect(src).toContain("IF ls_fld-fieldname(1) = '.'.");
    expect(src).toContain("CONTINUE.");
    // The FLD line is written from inside the LOOP AT lt_fld, not the old per-key-field loop.
    const loopIdx = src.indexOf("LOOP AT lt_fld INTO ls_fld.");
    const endloopIdx = src.indexOf("ENDLOOP.");
    const fldIdx = src.indexOf(`${IMGW_LINE_PREFIX}FLD table=`);
    expect(loopIdx).toBeGreaterThan(-1);
    expect(endloopIdx).toBeGreaterThan(loopIdx);
    expect(fldIdx).toBeGreaterThan(loopIdx);
    expect(fldIdx).toBeLessThan(endloopIdx);
  });

  // Rewritten Defect-H (duplicate declaration) regression, replacing the two tests this replaces
  // ("hoists the four DD03L lookup variables exactly once for a two-/three-key table..."): those
  // pinned the per-key-field SELECT shape being deleted here (one SELECT per key field, four
  // hoisted lv_key_* variables). The new shape structurally cannot repeat the "LV_KEY_FLAG was
  // already declared" failure measured live 2026-09-06, because the DD03L read is emitted exactly
  // once no matter how many key fields (or columns) the table has — this pins that the FROM dd03l
  // count stays at 1 as key count grows, and that no inline @DATA(...) survives anywhere in the
  // generated probe source.
  it("emits exactly one FROM dd03l regardless of key count, and never redeclares the same inline @DATA(name) twice, for both a two-key and a three-key table", () => {
    const twoKey = imgProbeSource(
      baseProbe({ keyFields: [KEY_FIELD, "ZKEY2"], rows: [{ key: { [KEY_FIELD]: "A1", ZKEY2: "B2" }, values: {} }] }),
    );
    const threeKey = imgProbeSource(
      baseProbe({
        keyFields: [KEY_FIELD, "ZKEY2", "ZKEY3"],
        rows: [{ key: { [KEY_FIELD]: "A1", ZKEY2: "B2", ZKEY3: "C3" }, values: {} }],
      }),
    );
    expect(twoKey.split("FROM dd03l").length - 1).toBe(1);
    expect(threeKey.split("FROM dd03l").length - 1).toBe(1);
    // Neither the two-key-specific "lv_key_flag" etc. shape this replaces, nor any duplicate of
    // the same inline @DATA(name) survives as key count grows — the DD03L read (and its
    // lt_fld/ls_fld declarations, now hoisted plain DATA statements, not inline) is emitted
    // exactly once regardless of how many key fields the table has.
    for (const src of [twoKey, threeKey]) {
      expect(src).not.toContain("lv_key_flag");
      const names = [...src.matchAll(/@DATA\(([a-zA-Z_][a-zA-Z0-9_]*)\)/g)].map((m) => m[1]!);
      const counts = new Map<string, number>();
      for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
      const dupes = [...counts.entries()].filter(([, c]) => c > 1);
      expect(dupes).toEqual([]);
    }
  });

  // Generator/parser drift check: the FLD line the generator actually emits, with concrete runtime
  // values substituted for the { ls_fld-... } placeholders, must round-trip through the transcript
  // parser as a VALUE (non-key) column — this is the pin that the probe's new value-column output
  // is actually consumable by the rest of this module, not just present as text in the source.
  it("the generated FLD line, with runtime values substituted, parses as a non-key value column", () => {
    const src = imgProbeSource(baseProbe());
    const fldLineStart = src.indexOf(`out->write( |${IMGW_LINE_PREFIX}FLD table=`);
    expect(fldLineStart).toBeGreaterThan(-1);
    const fldLineEnd = src.indexOf(").", fldLineStart);
    const generatedTemplate = src.slice(fldLineStart, fldLineEnd);

    // Pull out the two |...| string-literal segments the generator concatenates with && and join
    // them exactly as ABAP would, then substitute concrete runtime values for the five
    // { ls_fld-... } placeholders — this reconstructs the literal transcript line the generated
    // ABAP would actually emit for a non-key CHAR(40) column named TEXT40.
    const segments = [...generatedTemplate.matchAll(/\|([^|]*)\|/g)].map((m) => m[1]!);
    expect(segments.length).toBe(2);
    const literalLine = segments
      .join("")
      .replace("{ ls_fld-fieldname }", "TEXT40")
      .replace("{ ls_fld-keyflag }", "")
      .replace("{ ls_fld-datatype }", "CHAR")
      .replace("{ ls_fld-leng }", "40")
      .replace("{ ls_fld-rollname }", "TEXT40");
    expect(literalLine).toBe(`${IMGW_LINE_PREFIX}FLD table=[${TABLE.toLowerCase()}] field=[TEXT40] key=[] type=[CHAR] len=[40] rollname=[TEXT40]`);

    const t = parseImgWriteTranscript(literalLine);
    expect(t.droppedLines).toBe(0);
    expect(t.fields).toEqual([
      { table: TABLE.toLowerCase(), field: "TEXT40", key: false, dataType: "CHAR", length: "40", dataElement: "TEXT40" },
    ]);
  });
});

describe("imgApplySource: field preservation (upsert)", () => {
  it("reads the row before writing it, and assigns only named non-key fields", () => {
    const plan = baseApply({
      rows: [{ key: { [KEY_FIELD]: "A1" }, values: { [VAL_FIELD]: "Hello" } }],
    });
    const src = imgApplySource(plan);
    expect(src).toContain(`SELECT SINGLE * FROM ${TABLE.toLowerCase()} INTO @ls_wa WHERE`);
    // the named field is assigned...
    expect(src).toContain(`ls_wa-${VAL_FIELD.toLowerCase()} = 'Hello'.`);
    // ...but the other declared, unnamed field is never assigned anywhere in this plan's source.
    expect(src).not.toContain(`ls_wa-${VAL_FIELD2.toLowerCase()} =`);
  });

  it("builds the work area from the before-image read, never from named fields alone", () => {
    // The red-proof for this property lives in the scratchpad break-test; this asserts the
    // healthy generator's own load-bearing statement is present and precedes the assignment.
    const src = imgApplySource(baseApply());
    const selectIdx = src.indexOf("SELECT SINGLE * FROM");
    const assignIdx = src.indexOf(`ls_wa-${VAL_FIELD.toLowerCase()} = 'Hello'.`);
    expect(selectIdx).toBeGreaterThan(-1);
    expect(assignIdx).toBeGreaterThan(selectIdx);
  });

  it("never wipes ls_wa between the before-image read and the MODIFY", () => {
    // A CLEAR ls_wa (or any rebuild-from-scratch) inserted after the successful SELECT and
    // before the field assignments would silently drop every preserved, unnamed field — the
    // read-then-assign text pattern alone does not rule that out, so this checks the segment
    // between them directly.
    const src = imgApplySource(baseApply());
    const endifIdx = src.indexOf("ENDIF.", src.indexOf("BABSENT"));
    const modifyIdx = src.indexOf(`MODIFY ${TABLE.toLowerCase()} FROM ls_wa.`);
    expect(endifIdx).toBeGreaterThan(-1);
    expect(modifyIdx).toBeGreaterThan(endifIdx);
    const segment = src.slice(endifIdx, modifyIdx);
    expect(segment).not.toContain("CLEAR ls_wa");
  });
});

describe("imgApplySource: key-only upsert row", () => {
  it("generates a CLEAR/key/client/MODIFY sequence with no ls_wa field assignment, all lines under the line cap", () => {
    const plan = baseApply({ rows: [{ key: { [KEY_FIELD]: "A1" }, values: {} }] });
    const src = imgApplySource(plan);
    const lower = TABLE.toLowerCase();
    const key = KEY_FIELD.toLowerCase();
    const client = CLIENT_FIELD.toLowerCase();

    expect(src).toContain("CLEAR ls_key.");
    expect(src).toContain(`ls_key-${key} = 'A1'.`);
    expect(src).toContain("CLEAR ls_wa.");
    expect(src).toContain(`SELECT SINGLE * FROM ${lower} INTO @ls_wa WHERE ${key} = 'A1'.`);
    expect(src).toContain(`  out->write( |${IMGW_LINE_PREFIX}BABSENT row=[1]| ).`);
    expect(src).toContain(`  ls_wa-${key} = ls_key-${key}.`);
    expect(src).toContain(`ls_wa-${client} = sy-mandt.`);
    expect(src).toContain(`MODIFY ${lower} FROM ls_wa.`);

    // No value field the row didn't name is ever assigned — this is exactly what makes a
    // key-only row a no-op MODIFY when the row already exists (before-image preserved) and a
    // key+client-only insert when it does not.
    expect(src).not.toContain(`ls_wa-${VAL_FIELD.toLowerCase()} =`);
    expect(src).not.toContain(`ls_wa-${VAL_FIELD2.toLowerCase()} =`);

    expect(maxLineLength(src)).toBeLessThan(255);
  });
});

describe("imgApplySource: no open key (delete)", () => {
  it("never emits DELETE ... WHERE, only DELETE ... FROM a fully keyed work area", () => {
    const plan = baseApply({ op: "delete", rows: [{ key: { [KEY_FIELD]: "A1" }, values: {} }] });
    const src = imgApplySource(plan);
    expect(src).toMatch(new RegExp(`DELETE ${TABLE.toLowerCase()} FROM ls_wa\\.`));
    for (const line of src.split("\n")) {
      if (/\bDELETE\b/i.test(line)) {
        expect(line.toUpperCase()).not.toContain("WHERE");
      }
    }
  });

  it("populates every key field on the delete work area from the caller's key, never partially", () => {
    const plan = baseApply({
      keyFields: [KEY_FIELD, "ZKEY2"],
      op: "delete",
      fields: [...baseFields(), { field: "ZKEY2", key: true, dataType: "CHAR" }],
      rows: [{ key: { [KEY_FIELD]: "A1", ZKEY2: "B2" }, values: {} }],
    });
    const src = imgApplySource(plan);
    expect(src).toContain(`ls_wa-${KEY_FIELD.toLowerCase()} = ls_key-${KEY_FIELD.toLowerCase()}.`);
    expect(src).toContain(`ls_wa-zkey2 = ls_key-zkey2.`);
  });
});

describe("imgApplySource: client field", () => {
  it("always sources the client field from sy-mandt, upsert", () => {
    const src = imgApplySource(baseApply());
    expect(src).toContain(`ls_wa-${CLIENT_FIELD.toLowerCase()} = sy-mandt.`);
    expect(src).not.toMatch(new RegExp(`ls_wa-${CLIENT_FIELD.toLowerCase()} = '`));
  });

  it("always sources the client field from sy-mandt, delete", () => {
    const src = imgApplySource(baseApply({ op: "delete", rows: [{ key: { [KEY_FIELD]: "A1" }, values: {} }] }));
    expect(src).toContain(`ls_wa-${CLIENT_FIELD.toLowerCase()} = sy-mandt.`);
  });
});

describe("imgApplySource: CTS ordering", () => {
  it("calls TR_OBJECTS_CHECK before TR_OBJECTS_INSERT, both before the MODIFY on an upsert row", () => {
    const src = imgApplySource(baseApply());
    const checkIdx = src.indexOf(`CALL FUNCTION '${CTS_INSERT_FM.checkFm}'`);
    const insertIdx = src.indexOf(`CALL FUNCTION '${CTS_INSERT_FM.insertFm}'`);
    const modifyIdx = src.indexOf(`MODIFY ${TABLE.toLowerCase()} FROM ls_wa.`);
    expect(checkIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(checkIdx);
    expect(modifyIdx).toBeGreaterThan(insertIdx);
  });

  it("calls TR_OBJECTS_CHECK before TR_OBJECTS_INSERT, both before the DELETE on a delete row", () => {
    const src = imgApplySource(baseApply({ op: "delete", rows: [{ key: { [KEY_FIELD]: "A1" }, values: {} }] }));
    const checkIdx = src.indexOf(`CALL FUNCTION '${CTS_INSERT_FM.checkFm}'`);
    const insertIdx = src.indexOf(`CALL FUNCTION '${CTS_INSERT_FM.insertFm}'`);
    const deleteIdx = src.indexOf(`DELETE ${TABLE.toLowerCase()} FROM ls_wa.`);
    expect(checkIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(checkIdx);
    expect(deleteIdx).toBeGreaterThan(insertIdx);
  });

  it("skips CTS bookkeeping entirely when no corrNr is given", () => {
    const plan = baseApply({ corrNr: undefined });
    const src = imgApplySource(plan);
    expect(src).not.toContain(`CALL FUNCTION '${CTS_INSERT_FM.checkFm}'`);
    expect(src).not.toContain(`CALL FUNCTION '${CTS_INSERT_FM.insertFm}'`);
  });
});

describe("imgApplySource: CTS record shape", () => {
  it("emits a KO200 header row typed VDAT with the view name and OBJFUNC K", () => {
    const src = imgApplySource(baseApply());
    expect(src).toContain("ls_ko200-pgmid = 'R3TR'.");
    expect(src).toContain(`ls_ko200-object = 'VDAT'.`);
    expect(src).toContain(`ls_ko200-obj_name = '${VIEW}'.`);
    expect(src).toContain("ls_ko200-objfunc = 'K'.");
  });

  it("emits a KO200 header row typed CDAT when masterType is CDAT", () => {
    const src = imgApplySource(baseApply({ masterType: "CDAT" }));
    expect(src).toContain(`ls_ko200-object = 'CDAT'.`);
    expect(src).not.toContain(`ls_ko200-object = 'VDAT'.`);
  });

  it("emits one E071K row per written row with all fields, MASTERNAME and VIEWNAME both the view", () => {
    const src = imgApplySource(baseApply());
    expect(src).toContain("ls_e071k-pgmid = 'R3TR'.");
    expect(src).toContain("ls_e071k-object = 'TABU'.");
    expect(src).toContain(`ls_e071k-objname = '${TABLE}'.`);
    expect(src).toContain(`ls_e071k-mastertype = 'VDAT'.`);
    expect(src).toContain(`ls_e071k-mastername = '${VIEW}'.`);
    expect(src).toContain(`ls_e071k-viewname = '${VIEW}'.`);
    expect(src).toContain("ls_e071k-objfunc = ' '.");
    expect(src).toContain("ls_e071k-tabkey = |{ sy-mandt }{ <key_c> }|.");
  });

  it("spells the E071K object-name component OBJNAME, not the KO200/E071 OBJ_NAME spelling", () => {
    // Live DD03L read of E071K (active version) returned OBJNAME (no underscore),
    // 14 fields in position order. SAP rejected the generated ABAP when this
    // fragment used the underscored OBJ_NAME spelling instead.
    const src = imgApplySource(baseApply());
    expect(src).toContain(`ls_e071k-objname = '${TABLE}'.`);
    expect(src).not.toContain("ls_e071k-obj_name");
  });

  it("emits exactly these eight E071K components, spelled as the live DD03L listing spells them", () => {
    // The order below is the generator's own assignment order and carries no
    // meaning by itself — ABAP does not care what order structure components
    // are assigned in. Only the set of names and their spelling matter here.
    // If the fragment is ever reordered, this expectation should simply be
    // reordered to match; that is a free change, not a regression.
    //
    // Checked by eye against a live DD03L read of E071K (active version),
    // all 14 fields in position order:
    //   TRKORR PGMID OBJECT OBJNAME AS4POS MASTERTYPE MASTERNAME VIEWNAME
    //   OBJFUNC TABKEY SORTFLAG FLAG LANG ACTIVITY
    // TRKORR and AS4POS are deliberately not assigned here, on the
    // assumption that TR_OBJECTS_INSERT fills them itself — that assumption
    // is unverified. The remaining six fields not in the eight below
    // (TRKORR, AS4POS, SORTFLAG, FLAG, LANG, ACTIVITY) are not claimed to be
    // irrelevant; they simply aren't assigned by this fragment.
    const src = imgApplySource(baseApply());
    const components = [...src.matchAll(/ls_e071k-(\w+) =/g)].map((m) => m[1]);
    expect(components).toEqual([
      "pgmid",
      "object",
      "objname",
      "mastertype",
      "mastername",
      "viewname",
      "objfunc",
      "tabkey",
    ]);
  });

  it("passes both suppressor flags as 'X' on both TR_OBJECTS_CHECK and TR_OBJECTS_INSERT", () => {
    const src = imgApplySource(baseApply());
    const checkIdx = src.indexOf(`CALL FUNCTION '${CTS_INSERT_FM.checkFm}'`);
    const insertIdx = src.indexOf(`CALL FUNCTION '${CTS_INSERT_FM.insertFm}'`);
    const afterInsertIdx = src.indexOf("ENDIF.", insertIdx);
    const checkBlock = src.slice(checkIdx, insertIdx);
    const insertBlock = src.slice(insertIdx, afterInsertIdx);
    for (const block of [checkBlock, insertBlock]) {
      expect(block).toContain("iv_no_standard_editor = 'X'");
      expect(block).toContain("iv_no_show_option     = 'X'");
    }
  });

  it("names both exceptions with distinct sy-subrc values on both calls, and emits sy-msgid/sy-msgv1 on failure", () => {
    const src = imgApplySource(baseApply());
    expect(src).toContain("cancel_edit_other_error = 1");
    expect(src).toContain("show_only_other_error   = 2");
    expect(src).toContain("msgid=[{ sy-msgid }]");
    expect(src).toContain("msgv1=[{ sy-msgv1 }]");
    // failed on both FMs, not just one:
    expect(src).toContain(`${CTS_INSERT_FM.checkFm} failed for row`);
    expect(src).toContain(`${CTS_INSERT_FM.insertFm} failed for row`);
  });

  it("types the CTS objects table KO200, not a STANDARD TABLE OF e071", () => {
    // Was pinned as "... WITH EMPTY KEY." before the live round-5 finding: a TABLES formal
    // (wt_ko200/wt_e071k) is a standard table with the DEFAULT key, and an EMPTY KEY actual is a
    // runtime CX_SY_DYN_CALL_ILLEGAL_TYPE the ADT activation syntax check never catches. Updated
    // to WITH DEFAULT KEY — see "declares lt_ko200/lt_e071k WITH DEFAULT KEY" below for the
    // blanket regression guard.
    const src = imgApplySource(baseApply());
    expect(src).toContain("DATA lt_ko200 TYPE STANDARD TABLE OF ko200 WITH DEFAULT KEY.");
    expect(src).not.toMatch(/TYPE STANDARD TABLE OF e071\b/);
  });

  it("captures WE_ORDER/WE_TASK from TR_OBJECTS_INSERT and reports both on the TRKEY line, alongside the requested trkorr", () => {
    const src = imgApplySource(baseApply());
    expect(src).toContain("DATA lv_we_order TYPE trkorr.");
    expect(src).toContain("DATA lv_we_task TYPE trkorr.");
    const insertIdx = src.indexOf(`CALL FUNCTION '${CTS_INSERT_FM.insertFm}'`);
    const tablesIdx = src.indexOf("TABLES", insertIdx);
    const importingBlock = src.slice(insertIdx, tablesIdx);
    expect(importingBlock).toContain("IMPORTING");
    expect(importingBlock).toContain(`${CTS_INSERT_FM.params.weOrder} = lv_we_order`);
    expect(importingBlock).toContain(`${CTS_INSERT_FM.params.weTask} = lv_we_task`);
    expect(src).toContain("trkorr=[XXXK900001]");
    expect(src).toContain("order_len=[{ strlen( lv_we_order ) }] order=[{ lv_we_order }]");
    expect(src).toContain("task_len=[{ strlen( lv_we_task ) }] task=[{ lv_we_task }]");
  });
});

describe("imgApplySource: TABLES actual key type", () => {
  it("declares lt_ko200/lt_e071k WITH DEFAULT KEY, and never emits WITH EMPTY KEY anywhere", () => {
    // Blanket negative assertion, not just a check on these two names: it is the one that would
    // catch a future regression anywhere in this generator, the way the old, narrower
    // "types the CTS objects table KO200" test above did not — that test pinned the exact bug.
    const src = imgApplySource(baseApply());
    expect(src).toContain("DATA lt_ko200 TYPE STANDARD TABLE OF ko200 WITH DEFAULT KEY.");
    expect(src).toContain("DATA lt_e071k TYPE STANDARD TABLE OF e071k WITH DEFAULT KEY.");
    expect(src).not.toContain("WITH EMPTY KEY");
  });
});

describe("imgApplySource: CTS runtime failure handling", () => {
  it("wraps the CTS calls in TRY / CATCH cx_sy_dyn_call_illegal_type cx_sy_dyn_call_param_missing / CATCH cx_root / ENDTRY, declares lx_cts exactly once across a 2-row plan, and emits the IMGW> ERROR line in both handlers", () => {
    const plan = baseApply({
      rows: [
        { key: { [KEY_FIELD]: "A1" }, values: { [VAL_FIELD]: "Hello" } },
        { key: { [KEY_FIELD]: "A2" }, values: { [VAL_FIELD]: "World" } },
      ],
    });
    const src = imgApplySource(plan);

    expect(src).toContain("TRY.");
    expect(src).toContain("CATCH cx_sy_dyn_call_illegal_type cx_sy_dyn_call_param_missing INTO lx_cts.");
    expect(src).toContain("CATCH cx_root INTO lx_cts.");
    expect(src).toContain("ENDTRY.");

    // Declared once in the body's DATA block, even though the plan has two rows (two
    // ctsRecordFragment emissions) — an inline CATCH ... INTO DATA(lx) would duplicate-declare.
    const declCount = (src.match(/DATA lx_cts TYPE REF TO cx_root\./g) ?? []).length;
    expect(declCount).toBe(1);

    // But the CATCH block itself, and the ERROR write inside it, are emitted once per row.
    const catchCount = (
      src.match(/CATCH cx_sy_dyn_call_illegal_type cx_sy_dyn_call_param_missing INTO lx_cts\./g) ?? []
    ).length;
    expect(catchCount).toBe(2);
    const errorWriteCount = (src.match(/ERROR class=\[\{ lv_exc_class \}\]/g) ?? []).length;
    expect(errorWriteCount).toBe(4); // 2 rows x 2 CATCH branches each

    expect(src).toContain(
      `out->write( |${IMGW_LINE_PREFIX}ERROR class=[{ lv_exc_class }] len=[{ strlen( lv_exc_text ) }] | &&`,
    );
    expect(src).toContain("|value=[{ lv_exc_text }]| ).");
  });

  it("keeps the CALL FUNCTION statements and their sy-subrc checks textually inside the inner (CTS-specific) TRY, ending at its own ENDTRY — not merely ddicBridgeSource's outer TRY/ENDTRY", () => {
    // ddicBridgeSource already wraps the whole method body in its own outer TRY ... ENDTRY, so a
    // plain src.indexOf("TRY.") / src.indexOf("ENDTRY.") would find that outer wrap and pass even
    // if the inner CTS-specific TRY/CATCH were missing entirely. To actually prove the inner TRY
    // exists, anchor on the CTS-specific CATCH line and require an inner TRY strictly after the
    // outer one, and an ENDTRY between the CATCH and the rest of the method.
    const src = imgApplySource(baseApply());
    const outerTryIdx = src.indexOf("TRY.");
    const checkIdx = src.indexOf(`CALL FUNCTION '${CTS_INSERT_FM.checkFm}'`);
    const insertIdx = src.indexOf(`CALL FUNCTION '${CTS_INSERT_FM.insertFm}'`);
    const catchIdx = src.indexOf(
      "CATCH cx_sy_dyn_call_illegal_type cx_sy_dyn_call_param_missing INTO lx_cts.",
    );
    const innerTryIdx = src.lastIndexOf("TRY.", checkIdx);
    const innerEndtryIdx = src.indexOf("ENDTRY.", catchIdx);

    expect(outerTryIdx).toBeGreaterThan(-1);
    expect(innerTryIdx).toBeGreaterThan(outerTryIdx);
    expect(checkIdx).toBeGreaterThan(innerTryIdx);
    expect(insertIdx).toBeGreaterThan(checkIdx);
    expect(catchIdx).toBeGreaterThan(insertIdx);
    expect(innerEndtryIdx).toBeGreaterThan(catchIdx);
    // The existing sy-subrc/sy-msg* error blocks must still be present, unchanged, inside the TRY.
    expect(src).toContain(`${CTS_INSERT_FM.checkFm} failed for row`);
    expect(src).toContain(`${CTS_INSERT_FM.insertFm} failed for row`);
  });
});

describe("imgApplySource: WROTE marker", () => {
  it("emits IMGW> WROTE row=[1] immediately after a successful MODIFY on upsert", () => {
    const src = imgApplySource(baseApply());
    const modifyIdx = src.indexOf(`MODIFY ${TABLE.toLowerCase()} FROM ls_wa.`);
    const wroteIdx = src.indexOf(`out->write( |${IMGW_LINE_PREFIX}WROTE row=[1]| ).`);
    expect(modifyIdx).toBeGreaterThan(-1);
    expect(wroteIdx).toBeGreaterThan(modifyIdx);
  });

  it("emits IMGW> WROTE row=[1] immediately after a successful DELETE on delete", () => {
    const plan = baseApply({ op: "delete", rows: [{ key: { [KEY_FIELD]: "A1" }, values: {} }] });
    const src = imgApplySource(plan);
    const deleteIdx = src.indexOf(`DELETE ${TABLE.toLowerCase()} FROM ls_wa.`);
    const wroteIdx = src.indexOf(`out->write( |${IMGW_LINE_PREFIX}WROTE row=[1]| ).`);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(wroteIdx).toBeGreaterThan(deleteIdx);
  });
});

describe("imgApplySource: commit and after-image", () => {
  it("commits after all row writes and re-reads the after-image", () => {
    const src = imgApplySource(baseApply());
    const commitIdx = src.indexOf("COMMIT WORK AND WAIT.");
    const modifyIdx = src.indexOf(`MODIFY ${TABLE.toLowerCase()} FROM ls_wa.`);
    expect(commitIdx).toBeGreaterThan(modifyIdx);
    expect(src.indexOf("AVAL", commitIdx)).toBeGreaterThan(-1);
  });
});

describe("imgApplySource: line length", () => {
  it("stays within ABAP_SOURCE_LINE_MAX at longest legal input, upsert", () => {
    const table = "Z" + "A".repeat(29);
    const keyField = "K".repeat(30);
    const valField = "V".repeat(30);
    const rows: ImgWriteRow[] = Array.from({ length: IMGW_MAX_ROWS }, (_, i) => ({
      key: { [keyField]: `A${i}` },
      values: { [valField]: `x${i}` },
    }));
    const plan: ImgApplyPlan = {
      table,
      clientField: CLIENT_FIELD,
      keyFields: [keyField],
      rows,
      language: "E",
      op: "upsert",
      fields: [
        { field: keyField, key: true, dataType: "CHAR" },
        { field: valField, key: false, dataType: "CHAR" },
      ],
      corrNr: "AAAK900050",
      expectedDeliveryClass: "C",
      expectedClientDependent: true,
      view: "V" + "B".repeat(29),
      masterType: "VDAT",
    };
    expect(maxLineLength(imgApplySource(plan))).toBeLessThanOrEqual(ABAP_SOURCE_LINE_MAX);
  });

  it("stays within ABAP_SOURCE_LINE_MAX at longest legal input, delete", () => {
    const table = "Z" + "A".repeat(29);
    const keyField = "K".repeat(30);
    const rows: ImgWriteRow[] = Array.from({ length: IMGW_MAX_ROWS }, (_, i) => ({
      key: { [keyField]: `A${i}` },
      values: {},
    }));
    const plan: ImgApplyPlan = {
      table,
      clientField: CLIENT_FIELD,
      keyFields: [keyField],
      rows,
      language: "E",
      op: "delete",
      fields: [{ field: keyField, key: true, dataType: "CHAR" }],
      corrNr: "AAAK900050",
      expectedDeliveryClass: "C",
      expectedClientDependent: true,
      view: "V" + "B".repeat(29),
      masterType: "CDAT",
    };
    expect(maxLineLength(imgApplySource(plan))).toBeLessThanOrEqual(ABAP_SOURCE_LINE_MAX);
  });
});

describe("no generated source declares the same inline @DATA(name) twice", () => {
  // Collects every @DATA(name) occurrence (with repeats) so a name appearing more than once is
  // visible, not just a yes/no verdict — an inline @DATA(...) is only legal the first time a name
  // is bound in a scope; a second occurrence anywhere in the same generated method is the exact
  // "already declared" activation failure measured live against TB004T (round 6).
  function collectInlineDataNames(source: string): string[] {
    const names: string[] = [];
    const re = /@DATA\(([a-zA-Z_][a-zA-Z0-9_]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      names.push(m[1]!);
    }
    return names;
  }

  function assertNoDuplicateInlineData(label: string, source: string): void {
    const names = collectInlineDataNames(source);
    const counts = new Map<string, number>();
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
    const dupes = [...counts.entries()].filter(([, c]) => c > 1);
    expect(dupes, `${label}: duplicate inline @DATA(...) declaration(s): ${dupes
      .map(([n, c]) => `${n} (x${c})`)
      .join(", ")}`).toEqual([]);
  }

  it("holds across a representative set: one-key probe, two-key probe, three-key probe, multi-row multi-key apply upsert, apply delete", () => {
    const oneKeyProbe = imgProbeSource(baseProbe());
    const twoKeyProbe = imgProbeSource(
      baseProbe({ keyFields: [KEY_FIELD, "ZKEY2"], rows: [{ key: { [KEY_FIELD]: "A1", ZKEY2: "B2" }, values: {} }] }),
    );
    const threeKeyProbe = imgProbeSource(
      baseProbe({
        keyFields: [KEY_FIELD, "ZKEY2", "ZKEY3"],
        rows: [{ key: { [KEY_FIELD]: "A1", ZKEY2: "B2", ZKEY3: "C3" }, values: {} }],
      }),
    );
    const multiRowMultiKeyUpsert = imgApplySource(
      baseApply({
        keyFields: [KEY_FIELD, "ZKEY2", "ZKEY3"],
        fields: [...baseFields(), { field: "ZKEY2", key: true, dataType: "CHAR" }, { field: "ZKEY3", key: true, dataType: "CHAR" }],
        rows: [
          { key: { [KEY_FIELD]: "A1", ZKEY2: "B2", ZKEY3: "C3" }, values: { [VAL_FIELD]: "Hello" } },
          { key: { [KEY_FIELD]: "A2", ZKEY2: "B3", ZKEY3: "C4" }, values: { [VAL_FIELD]: "World" } },
          { key: { [KEY_FIELD]: "A3", ZKEY2: "B4", ZKEY3: "C5" }, values: {} },
        ],
      }),
    );
    const applyDelete = imgApplySource(
      baseApply({
        op: "delete",
        keyFields: [KEY_FIELD, "ZKEY2"],
        fields: [...baseFields(), { field: "ZKEY2", key: true, dataType: "CHAR" }],
        rows: [
          { key: { [KEY_FIELD]: "A1", ZKEY2: "B2" }, values: {} },
          { key: { [KEY_FIELD]: "A2", ZKEY2: "B3" }, values: {} },
        ],
      }),
    );

    assertNoDuplicateInlineData("one-key probe", oneKeyProbe);
    assertNoDuplicateInlineData("two-key probe", twoKeyProbe);
    assertNoDuplicateInlineData("three-key probe", threeKeyProbe);
    assertNoDuplicateInlineData("multi-row multi-key apply upsert", multiRowMultiKeyUpsert);
    assertNoDuplicateInlineData("apply delete", applyDelete);
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
