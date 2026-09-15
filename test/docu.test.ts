/**
 * Pure unit tests for `src/adt/docu.ts` — the resolution logic behind
 * `core.docu` (issue #109): ADT-type -> documentation-id mapping, message
 * reference parsing, IMG activity targets, and pulling one method's ABAP
 * Doc block out of a class definition source. No AbapConnection, no
 * `core.docu` dispatch — everything here is pure and synchronous.
 */
import { describe, expect, it } from "vitest";
import {
  DOCU_ID_BY_TYPE,
  DOCU_EMPTY_TEXT,
  DOCU_FLATTEN_NOTE,
  docuEmptyText,
  extractAbapDoc,
  imgDocuTarget,
  parseMessageObject,
  resolveDocuTarget,
} from "../src/adt/docu.js";
import { AbapError } from "../src/adt/errors.js";

// ---------------------------------------------------------------------------
// DOCU_ID_BY_TYPE
// ---------------------------------------------------------------------------

describe("DOCU_ID_BY_TYPE", () => {
  it.each([
    ["DTEL", "DE"],
    ["DOMA", "DO"],
    ["TABL", "TB"],
    ["CLAS", "CL"],
    ["INTF", "IF"],
    ["FUNC", "FU"],
    ["FUGR", "FU"],
    ["PROG", "RE"],
    ["MSAG", "NA"],
  ] as const)("%s -> %s", (type, id) => {
    expect(DOCU_ID_BY_TYPE.get(type)).toBe(id);
  });

  it("has exactly these nine keys", () => {
    expect([...DOCU_ID_BY_TYPE.keys()].sort()).toEqual(
      ["CLAS", "DOMA", "DTEL", "FUGR", "FUNC", "INTF", "MSAG", "PROG", "TABL"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// parseMessageObject
// ---------------------------------------------------------------------------

describe("parseMessageObject", () => {
  it('accepts the spaced form "ZSD 042" and produces the unpadded-looking merged key "ZSD042"', () => {
    expect(parseMessageObject("ZSD 042")).toBe("ZSD042");
  });

  it('accepts the already-merged form "ZSD042" and produces the same key', () => {
    expect(parseMessageObject("ZSD042")).toBe("ZSD042");
  });

  it('pads a short spaced number: "ZSD 42" -> "ZSD042"', () => {
    expect(parseMessageObject("ZSD 42")).toBe("ZSD042");
  });

  it("both spaced and merged forms of the same reference resolve identically", () => {
    expect(parseMessageObject("ZSD 042")).toBe(parseMessageObject("ZSD042"));
  });

  it("uppercases a lower-case message id", () => {
    expect(parseMessageObject("zsd 042")).toBe("ZSD042");
  });

  it("handles a namespaced message id with the spaced form", () => {
    expect(parseMessageObject("/UI2/FIOCONT 001")).toBe("/UI2/FIOCONT001");
  });

  it("handles a namespaced message id with the merged form", () => {
    expect(parseMessageObject("/UI2/FIOCONT001")).toBe("/UI2/FIOCONT001");
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseMessageObject("  ZSD 042  ")).toBe("ZSD042");
  });

  it("throws BAD_INPUT for a reference with no recognisable number (e.g. just an id)", () => {
    expect(() => parseMessageObject("ZSD")).toThrow(AbapError);
    try {
      parseMessageObject("ZSD");
      throw new Error("expected parseMessageObject to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AbapError);
      expect((e as AbapError).code).toBe("BAD_INPUT");
      expect((e as AbapError).message).toContain("ZSD");
      expect((e as AbapError).message).toContain("not a recognisable message reference");
    }
  });

  it("throws BAD_INPUT for a spaced number longer than 3 digits", () => {
    expect(() => parseMessageObject("ZSD 1234")).toThrow(AbapError);
  });

  it("throws BAD_INPUT for an empty string", () => {
    expect(() => parseMessageObject("")).toThrow(AbapError);
  });
});

// ---------------------------------------------------------------------------
// imgDocuTarget
// ---------------------------------------------------------------------------

describe("imgDocuTarget", () => {
  it('resolves to { id:"HY", object:"SIMG"+activity } — verified live: SIMG is 4 chars, putting the activity at OBJECT+4', () => {
    expect(imgDocuTarget("SPRO_ACTIVITY")).toEqual({
      id: "HY",
      object: "SIMGSPRO_ACTIVITY",
      kind: "IMG activity",
    });
  });

  it("SIMG is exactly 4 characters, matching OBJECT+4 with no explicit padding", () => {
    const target = imgDocuTarget("X");
    expect(target.object.slice(0, 4)).toBe("SIMG");
    expect(target.object.slice(4)).toBe("X");
  });
});

// ---------------------------------------------------------------------------
// resolveDocuTarget
// ---------------------------------------------------------------------------

describe("resolveDocuTarget", () => {
  it.each([
    ["DTEL", "DE", "data element"],
    ["DOMA", "DO", "domain"],
    ["TABL", "TB", "table"],
    ["CLAS", "CL", "class"],
    ["INTF", "IF", "interface"],
    ["FUNC", "FU", "function module"],
    ["FUGR", "FU", "function group"],
    ["PROG", "RE", "program"],
  ] as const)("%s -> id %s, kind %s, object upper-cased", (type, id, kind) => {
    expect(resolveDocuTarget({ type, object: "mandt" })).toEqual({ id, object: "MANDT", kind });
  });

  it("MSAG routes through parseMessageObject instead of a plain uppercase", () => {
    expect(resolveDocuTarget({ type: "MSAG", object: "ZSD 042" })).toEqual({
      id: "NA",
      object: "ZSD042",
      kind: "message",
    });
  });

  it("accepts a slashed ADT type (e.g. CLAS/OC), using only the part before the slash", () => {
    expect(resolveDocuTarget({ type: "CLAS/OC", object: "zcl_foo" })).toEqual({
      id: "CL",
      object: "ZCL_FOO",
      kind: "class",
    });
  });

  it("is case-insensitive on the type", () => {
    expect(resolveDocuTarget({ type: "clas", object: "zcl_foo" }).id).toBe("CL");
  });

  it("throws BAD_INPUT for an unsupported type, naming the supported types", () => {
    try {
      resolveDocuTarget({ type: "DDLS", object: "Z_FOO" });
      throw new Error("expected resolveDocuTarget to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AbapError);
      expect((e as AbapError).code).toBe("BAD_INPUT");
      expect((e as AbapError).message).toContain("DDLS");
      expect((e as AbapError).message).toContain("DTEL");
      expect((e as AbapError).message).toContain("MSAG");
    }
  });

  it("throws BAD_INPUT when no type is given at all", () => {
    try {
      resolveDocuTarget({ object: "Z_FOO" });
      throw new Error("expected resolveDocuTarget to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AbapError);
      expect((e as AbapError).code).toBe("BAD_INPUT");
      expect((e as AbapError).message).toContain("(none)");
    }
  });
});

// ---------------------------------------------------------------------------
// extractAbapDoc — over a literal captured ABAP class definition source.
// ---------------------------------------------------------------------------

const CLASS_SOURCE = `CLASS zcl_i109_probe DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    "! <p class="shorttext synchronized">Adds two integers together</p>
    "!
    "! @parameter iv_a | First addend
    "! @parameter iv_b | Second addend
    "! @parameter rv_sum | Sum of both addends
    METHODS add
      IMPORTING
        iv_a          TYPE i
        iv_b          TYPE i
      RETURNING
        VALUE(rv_sum) TYPE i.

    METHODS subtract
      IMPORTING
        iv_a           TYPE i
        iv_b           TYPE i
      RETURNING
        VALUE(rv_diff) TYPE i.

  PROTECTED SECTION.
ENDCLASS.


CLASS zcl_i109_probe IMPLEMENTATION.

  METHOD add.
    rv_sum = iv_a + iv_b.
  ENDMETHOD.

  METHOD subtract.
    rv_diff = iv_a - iv_b.
  ENDMETHOD.

ENDCLASS.
`;

describe("extractAbapDoc", () => {
  it("returns only the target method's doc, marker and one leading space stripped, in order", () => {
    expect(extractAbapDoc(CLASS_SOURCE, "add")).toEqual([
      '<p class="shorttext synchronized">Adds two integers together</p>',
      "",
      "@parameter iv_a | First addend",
      "@parameter iv_b | Second addend",
      "@parameter rv_sum | Sum of both addends",
    ]);
  });

  it("is case-insensitive on the method name", () => {
    expect(extractAbapDoc(CLASS_SOURCE, "ADD")).toEqual(extractAbapDoc(CLASS_SOURCE, "add"));
  });

  it("returns an empty array for a method with no ABAP Doc block above it", () => {
    expect(extractAbapDoc(CLASS_SOURCE, "subtract")).toEqual([]);
  });

  it("returns an empty array for a method name that does not exist in the source", () => {
    expect(extractAbapDoc(CLASS_SOURCE, "multiply")).toEqual([]);
  });

  it("does not pick up a METHODS mention inside a string literal or comment", () => {
    const tricky = `CLASS zcl_tricky DEFINITION.
  PUBLIC SECTION.
    " a comment that says METHODS bogus, not a real declaration
    DATA lv_text TYPE string VALUE 'contains the word METHODS bogus too'.
    "! Real doc for the real method
    METHODS bogus.
ENDCLASS.
`;
    expect(extractAbapDoc(tricky, "bogus")).toEqual(["Real doc for the real method"]);
  });
});

// ---------------------------------------------------------------------------
// DOCU_EMPTY_TEXT / docuEmptyText
// ---------------------------------------------------------------------------

describe("docuEmptyText / DOCU_EMPTY_TEXT", () => {
  it('DOCU_EMPTY_TEXT is exactly "(no documentation in DE or EN)"', () => {
    expect(DOCU_EMPTY_TEXT).toBe("(no documentation in DE or EN)");
  });

  it('docuEmptyText(["DE", "EN"]) reproduces DOCU_EMPTY_TEXT exactly', () => {
    expect(docuEmptyText(["DE", "EN"])).toBe(DOCU_EMPTY_TEXT);
  });

  it("joins an arbitrary language list with \" or \"", () => {
    expect(docuEmptyText(["DE", "EN", "FR"])).toBe("(no documentation in DE or EN or FR)");
  });

  it("handles a single-language list", () => {
    expect(docuEmptyText(["EN"])).toBe("(no documentation in EN)");
  });
});

// ---------------------------------------------------------------------------
// Flattened ITF text — `src/adt/docu.ts` has no flattening function of its
// own (see the module header comment: `CONVERT_ITF_TO_ASCII` runs entirely
// on the ABAP side, in src/adt/fluid/builtin/core/abap-docu.ts). There is
// nothing in this TS module to feed a literal ITF-vs-ASCII fixture through,
// so per the task's fallback instruction this instead pins DOCU_FLATTEN_NOTE
// itself: it must say plainly that the text handed back is flattened, not
// verbatim ITF source, so a caller reading core.docu's response text is told
// the same thing this test suite had to discover by reading the ABAP side.
// ---------------------------------------------------------------------------

describe("DOCU_FLATTEN_NOTE — documents that docu text is flattened, not verbatim ITF", () => {
  it("names CONVERT_ITF_TO_ASCII as the flattening step", () => {
    expect(DOCU_FLATTEN_NOTE).toContain("CONVERT_ITF_TO_ASCII");
  });

  it("states plainly that the text is not the verbatim ITF source", () => {
    expect(DOCU_FLATTEN_NOTE).toContain("not the verbatim ITF source");
  });

  it("mentions symbol resolution, formatting-tag removal and INCLUDE expansion — the three concrete transforms verified live", () => {
    expect(DOCU_FLATTEN_NOTE).toMatch(/symbols resolved/i);
    expect(DOCU_FLATTEN_NOTE).toMatch(/formatting tags removed/i);
    expect(DOCU_FLATTEN_NOTE).toMatch(/INCLUDE directives expanded/i);
  });
});
