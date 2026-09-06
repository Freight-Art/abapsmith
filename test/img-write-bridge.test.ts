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

  it("CTS_INSERT_FM's note says plainly, near the front, that this server has never itself called either FM", () => {
    const upfront = CTS_INSERT_FM.note.slice(0, 80).toUpperCase();
    expect(upfront).toContain("UNPROVEN");
    expect(CTS_INSERT_FM.note).toContain("this server has never itself called either one");
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
    expect(src).toContain(`ls_e071k-obj_name = '${TABLE}'.`);
    expect(src).toContain(`ls_e071k-mastertype = 'VDAT'.`);
    expect(src).toContain(`ls_e071k-mastername = '${VIEW}'.`);
    expect(src).toContain(`ls_e071k-viewname = '${VIEW}'.`);
    expect(src).toContain("ls_e071k-objfunc = ' '.");
    expect(src).toContain("ls_e071k-tabkey = |{ sy-mandt }{ <key_c> }|.");
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
    const src = imgApplySource(baseApply());
    expect(src).toContain("DATA lt_ko200 TYPE STANDARD TABLE OF ko200 WITH EMPTY KEY.");
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
});
