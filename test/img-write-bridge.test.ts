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

function baseProbe(overrides: Partial<ImgProbePlan> = {}): ImgProbePlan {
  return {
    table: TABLE,
    clientField: CLIENT_FIELD,
    keyFields: [KEY_FIELD],
    rows: [{ key: { [KEY_FIELD]: "A1" }, values: {} }],
    language: "EN",
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

  it("CTS_INSERT_FM is marked low confidence with a note", () => {
    expect(CTS_INSERT_FM.confidence).toBe("low");
    expect(CTS_INSERT_FM.note.length).toBeGreaterThan(0);
    expect(CTS_INSERT_FM.fm).toBe("TR_OBJECTS_INSERT");
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

  it("rejects zero value fields on an upsert row", () => {
    expectBadInput(() => validateApplyPlan(baseApply({ rows: [{ key: { [KEY_FIELD]: "A1" }, values: {} }] })));
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
    const src = imgProbeSource({ table, clientField: CLIENT_FIELD, keyFields: [keyField], rows, language: "EN" });
    expect(maxLineLength(src)).toBeLessThanOrEqual(ABAP_SOURCE_LINE_MAX);
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
  it("records the CTS key before the MODIFY on an upsert row", () => {
    const src = imgApplySource(baseApply());
    const ctsIdx = src.indexOf(`CALL FUNCTION '${CTS_INSERT_FM.fm}'`);
    const modifyIdx = src.indexOf(`MODIFY ${TABLE.toLowerCase()} FROM ls_wa.`);
    expect(ctsIdx).toBeGreaterThan(-1);
    expect(modifyIdx).toBeGreaterThan(ctsIdx);
  });

  it("records the CTS key before the DELETE on a delete row", () => {
    const src = imgApplySource(baseApply({ op: "delete", rows: [{ key: { [KEY_FIELD]: "A1" }, values: {} }] }));
    const ctsIdx = src.indexOf(`CALL FUNCTION '${CTS_INSERT_FM.fm}'`);
    const deleteIdx = src.indexOf(`DELETE ${TABLE.toLowerCase()} FROM ls_wa.`);
    expect(ctsIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(ctsIdx);
  });

  it("skips CTS bookkeeping entirely when no corrNr is given", () => {
    const plan = baseApply({ corrNr: undefined });
    const src = imgApplySource(plan);
    expect(src).not.toContain(`CALL FUNCTION '${CTS_INSERT_FM.fm}'`);
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
      language: "EN",
      op: "upsert",
      fields: [
        { field: keyField, key: true, dataType: "CHAR" },
        { field: valField, key: false, dataType: "CHAR" },
      ],
      corrNr: "AAAK900050",
      expectedDeliveryClass: "C",
      expectedClientDependent: true,
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
      language: "EN",
      op: "delete",
      fields: [{ field: keyField, key: true, dataType: "CHAR" }],
      corrNr: "AAAK900050",
      expectedDeliveryClass: "C",
      expectedClientDependent: true,
    };
    expect(maxLineLength(imgApplySource(plan))).toBeLessThanOrEqual(ABAP_SOURCE_LINE_MAX);
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
});
