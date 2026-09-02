/**
 * Tests for `src/adt/ui-runtime.ts` — the classrun/BDC bridge behind the
 * `abap_ui` tool (headless classic dynpro driving via batch input).
 *
 * Pure offline, no network: every function under test here is a pure string
 * transform (validators, ABAP source generation, transcript parsing). No
 * `AbapConnection`/`SafetyGate`/HTTP fake is used or needed — `runUiBridge`
 * (the only function in the module that touches the wire) is orchestration
 * glue over `deployBridge`/`executeBridge`, already covered end-to-end by
 * `test/fpm-runtime.test.ts` and `test/bopf-runtime.test.ts` for the shared
 * choreography; this file's job is the domain logic specific to
 * `ui-runtime.ts` itself.
 *
 * Structure mirrors `test/fpm-runtime.test.ts`: an `expectBadInput` helper,
 * one `describe` per exported validator/generator, injection-shaped payloads
 * driven through the REAL generation path (not just the validators in
 * isolation) wherever the module's own doc comments call out a security
 * invariant.
 *
 * Wire format for the 00/344 "ran out of scripted screens" stall (read
 * straight off `pressBody` in ui-runtime.ts, not guessed):
 *
 *   UI> SUBRC 1001
 *   UI> ROWCOUNT <n>
 *   UI> MSG msgtyp=[S] msgid=[00] msgnr=[344] msgv1=[<program>] msgv2=[<dynpro>] msgv3=[] msgv4=[] text=[<decoded text>]
 *
 * i.e. `UI_LINE_PREFIX` ("UI> ") + a head token + `parseBracketFields`-style
 * `key=[value]` pairs, exactly like `fpm-runtime.ts`'s own transcript
 * protocol (both share `parseBracketFields` from run.ts). The real captured
 * SAP message shape given in the task —
 *   `TAG=MSG type=S id=00 nr=344 dyname=SAPLSETB dynumb=0230 text=No batch
 *   input data for dynpro SAPLSETB 0230`
 * — maps onto this module's own field names as msgtyp=type, msgid=id,
 * msgnr=nr, msgv1=dyname (the stalled program), msgv2=dynumb (the stalled
 * dynpro): confirmed by `pressBody`'s `MESSAGE ID ... WITH ls_msg-msgv1
 * ls_msg-msgv2 ...` call and the module header's own statement that MSGV1/
 * MSGV2 carry the stalled program/dynpro for this specific message.
 */
import { describe, expect, it } from "vitest";

import { isAbapError, type AbapError } from "../src/adt/errors.js";
import {
  abapLiteralAssignmentLines,
  assertDynpro,
  assertFieldName,
  assertFieldValue,
  assertOkCode,
  assertProgramName,
  assertTcode,
  escapeAbapLiteral,
  FIELD_NAME_MAX,
  FIELD_VALUE_MAX,
  parseUiTranscript,
  PROGRAM_MAX,
  TCODE_MAX,
  UI_BRIDGE_CLASS_PREFIX,
  UI_FKEY_ROW_CAP,
  UI_LINE_PREFIX,
  UI_STATUS_LOOP_CAP,
  uiBridgeClassName,
  uiBridgeSource,
  type UiPressQuery,
  type UiScreenQuery,
} from "../src/adt/ui-runtime.js";

function expectBadInput(fn: () => unknown): AbapError {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) {
      expect(e.code).toBe("BAD_INPUT");
      return e;
    }
    throw e;
  }
  throw new Error("expected fn() to throw a BAD_INPUT AbapError");
}

// ---------------------------------------------------------------------------
// 1. escapeAbapLiteral — doubles every embedded `'`
// ---------------------------------------------------------------------------

describe("escapeAbapLiteral", () => {
  it("doubles a single embedded quote", () => {
    expect(escapeAbapLiteral("a'b")).toBe("a''b");
  });

  it("doubles multiple, non-adjacent quotes", () => {
    expect(escapeAbapLiteral("a'b'c'd")).toBe("a''b''c''d");
  });

  it("doubles a leading quote", () => {
    expect(escapeAbapLiteral("'abc")).toBe("''abc");
  });

  it("doubles a trailing quote", () => {
    expect(escapeAbapLiteral("abc'")).toBe("abc''");
  });

  it("doubles consecutive quotes (each one independently, not the pair as a unit)", () => {
    expect(escapeAbapLiteral("a''b")).toBe("a''''b"); // 2 quotes in -> 4 quotes out
    expect(escapeAbapLiteral("'''")).toBe("''''''"); // 3 in -> 6 out
  });

  it("the empty string is a no-op", () => {
    expect(escapeAbapLiteral("")).toBe("");
  });

  it("a string with no quotes at all is unchanged", () => {
    expect(escapeAbapLiteral("O_BRIEN 123")).toBe("O_BRIEN 123");
  });

  it("a value that is only quotes", () => {
    expect(escapeAbapLiteral("'''''")).toBe("''''''''''"); // 5 -> 10
  });
});

// ---------------------------------------------------------------------------
// 5. abapLiteralAssignmentLines — chunking never splits a doubled `''` pair
// ---------------------------------------------------------------------------

describe("abapLiteralAssignmentLines — long-literal chunking never splits a doubled '' pair", () => {
  it("chunks on the RAW value (documented chunk size 90), not the escaped one: a 95-quote value straddling the boundary produces two chunks with exact, independently-verified doubling", () => {
    const RAW = "'".repeat(95); // 90 (chunk 1) + 5 (chunk 2) — straddles the boundary
    const lines = abapLiteralAssignmentLines("lv_x", RAW);

    expect(lines[0]).toBe("    CLEAR lv_x.");
    expect(lines).toHaveLength(3); // CLEAR + 2 assignment chunks

    // Pinned independently of escapeAbapLiteral: chunk 1 is 90 raw quotes,
    // which MUST double to exactly 180 quote characters, never 179 or 181
    // (which is what a split-mid-pair regression would produce).
    expect(lines[1]).toBe(`    lv_x = lv_x && '${"'".repeat(180)}'.`);
    // Chunk 2 is the 5-quote remainder, doubling to exactly 10.
    expect(lines[2]).toBe(`    lv_x = lv_x && '${"'".repeat(10)}'.`);

    // Every generated statement's quote count must be even — an odd count on
    // ANY line is exactly the signature of a doubled pair having been split
    // across a chunk boundary (leaving one lone `'` dangling in a chunk).
    for (const line of lines.slice(1)) {
      const quoteCount = (line.match(/'/g) ?? []).length;
      expect(quoteCount % 2).toBe(0);
      expect(line.length).toBeLessThanOrEqual(255);
    }
  });

  it("a value exactly at the chunk boundary (90 quotes) produces exactly one assignment chunk", () => {
    const RAW = "'".repeat(90);
    const lines = abapLiteralAssignmentLines("lv_x", RAW);
    expect(lines).toHaveLength(2); // CLEAR + 1 chunk
    expect(lines[1]).toBe(`    lv_x = lv_x && '${"'".repeat(180)}'.`);
  });

  it("a value one character past the boundary (91 quotes) produces two chunks, the second holding exactly one (doubled) quote", () => {
    const RAW = "'".repeat(91);
    const lines = abapLiteralAssignmentLines("lv_x", RAW);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(`    lv_x = lv_x && '${"''"}'.`);
  });

  it("an empty raw value emits only the CLEAR statement (legitimate: clears a field)", () => {
    expect(abapLiteralAssignmentLines("lv_x", "")).toEqual(["    CLEAR lv_x."]);
  });

  it("respects a custom indent", () => {
    expect(abapLiteralAssignmentLines("lv_x", "ab", "  ")).toEqual(["  CLEAR lv_x.", "  lv_x = lv_x && 'ab'."]);
  });
});

// ---------------------------------------------------------------------------
// 10. assertTcode / assertProgramName — allowlist charset, injection-shaped rejects
// ---------------------------------------------------------------------------

describe("assertTcode", () => {
  it("accepts a plain tcode", () => {
    expect(assertTcode("SE38")).toBe("SE38");
  });

  it("accepts a legitimate namespaced tcode", () => {
    expect(assertTcode("/SAPAPO/SNP94")).toBe("/SAPAPO/SNP94");
  });

  it("trims surrounding whitespace", () => {
    expect(assertTcode("  SE38  ")).toBe("SE38");
  });

  it("accepts a tcode at exactly TCODE_MAX (20) chars", () => {
    const t = "A".repeat(TCODE_MAX);
    expect(assertTcode(t)).toBe(t);
  });

  it("rejects a tcode over TCODE_MAX (20) chars, even though it is otherwise plain (passes the 40-char generic name regex)", () => {
    const e = expectBadInput(() => assertTcode("A".repeat(TCODE_MAX + 1)));
    expect(e.message).toMatch(/CHAR20/);
  });

  it("rejects a tcode containing a quote", () => {
    expectBadInput(() => assertTcode("SE3'8"));
  });

  it("rejects a tcode containing a space", () => {
    expectBadInput(() => assertTcode("SE 38"));
  });

  for (const bad of ["SE38;DROP", "SE38.", "SE38`x`", "SE38<script>", "SE38\nX", "SE38-X"]) {
    it(`rejects injection-shaped tcode: ${JSON.stringify(bad)}`, () => {
      expectBadInput(() => assertTcode(bad));
    });
  }

  it("rejects the empty string", () => {
    expectBadInput(() => assertTcode(""));
  });
});

describe("assertProgramName", () => {
  it("accepts a plain program name", () => {
    expect(assertProgramName("SAPMSSY0")).toBe("SAPMSSY0");
  });

  it("accepts a namespaced program name", () => {
    expect(assertProgramName("/DMO/FLIGHT_PROGRAM")).toBe("/DMO/FLIGHT_PROGRAM");
  });

  it("accepts a program name at exactly PROGRAM_MAX (40) chars", () => {
    const p = "A".repeat(PROGRAM_MAX);
    expect(assertProgramName(p)).toBe(p);
  });

  it("rejects a program name over PROGRAM_MAX (40) chars", () => {
    expectBadInput(() => assertProgramName("A".repeat(PROGRAM_MAX + 1)));
  });

  for (const bad of ["A'B", "A;B", "A B", "A\nB", "A.B", "`whoami`"]) {
    it(`rejects injection-shaped program name: ${JSON.stringify(bad)}`, () => {
      expectBadInput(() => assertProgramName(bad));
    });
  }
});

// ---------------------------------------------------------------------------
// 6. assertDynpro — "100" -> "0100" normalisation, the authoring trap
// ---------------------------------------------------------------------------

describe("assertDynpro", () => {
  it('normalises an unpadded number: "100" -> "0100"', () => {
    expect(assertDynpro("100")).toBe("0100");
  });

  it("leaves an already-4-digit number unchanged", () => {
    expect(assertDynpro("0100")).toBe("0100");
  });

  it("pads a 1- and 2-digit number", () => {
    expect(assertDynpro("1")).toBe("0001");
    expect(assertDynpro("55")).toBe("0055");
  });

  it("trims surrounding whitespace before validating/padding", () => {
    expect(assertDynpro("  55  ")).toBe("0055");
  });

  it("rejects an empty string", () => {
    expectBadInput(() => assertDynpro(""));
  });

  it("rejects non-numeric input", () => {
    expectBadInput(() => assertDynpro("abcd"));
    expectBadInput(() => assertDynpro("10a"));
  });

  it("rejects more than 4 digits", () => {
    expectBadInput(() => assertDynpro("99999"));
  });

  it("rejects a decimal / punctuated value", () => {
    expectBadInput(() => assertDynpro("12.3"));
    expectBadInput(() => assertDynpro("100'"));
  });
});

// ---------------------------------------------------------------------------
// assertFieldName
// ---------------------------------------------------------------------------

describe("assertFieldName", () => {
  it("accepts a plain field name", () => {
    expect(assertFieldName("BDC_OKCODE")).toBe("BDC_OKCODE");
  });

  it("accepts a structure-component field name", () => {
    expect(assertFieldName("SAPMV45A-KUNNR")).toBe("SAPMV45A-KUNNR");
  });

  it("accepts a namespaced field name", () => {
    expect(assertFieldName("/DMO/FIELD")).toBe("/DMO/FIELD");
  });

  it("accepts a table-control row-index qualifier", () => {
    expect(assertFieldName("SAPLKKBL_MASSN-KUNNR(01)")).toBe("SAPLKKBL_MASSN-KUNNR(01)");
  });

  it("accepts a field name at exactly FIELD_NAME_MAX (132) chars", () => {
    const f = "A".repeat(FIELD_NAME_MAX);
    expect(assertFieldName(f)).toBe(f);
  });

  it("rejects a field name over FIELD_NAME_MAX (132) chars", () => {
    expectBadInput(() => assertFieldName("A".repeat(FIELD_NAME_MAX + 1)));
  });

  it("rejects the empty string", () => {
    expectBadInput(() => assertFieldName(""));
  });

  for (const bad of ["A'B", "A B", "A\nB", "A;B", "A`B", "A\"B"]) {
    it(`rejects injection-shaped field name: ${JSON.stringify(bad)}`, () => {
      expectBadInput(() => assertFieldName(bad));
    });
  }
});

// ---------------------------------------------------------------------------
// 3. assertFieldValue / assertOkCode — control-character guard
// ---------------------------------------------------------------------------

const C0_AND_DEL = ["\n", "\r", "\x00", "\x01", "\x08", "\x1b", "\x1f", "\x7f"];

describe("assertFieldValue — control character guard", () => {
  for (const ch of C0_AND_DEL) {
    it(`throws BAD_INPUT for a value containing 0x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`, () => {
      const e = expectBadInput(() => assertFieldValue(`before${ch}after`));
      expect(e.code).toBe("BAD_INPUT");
      expect(e.message).toMatch(/control character/);
    });
  }

  it("does NOT throw for ordinary business text containing an apostrophe (O'BRIEN must keep working)", () => {
    expect(() => assertFieldValue("O'BRIEN")).not.toThrow();
    expect(assertFieldValue("O'BRIEN")).toBe("O'BRIEN");
  });

  it("does NOT throw for other punctuation-heavy but control-char-free text", () => {
    expect(() => assertFieldValue(`Müller & Söhne — "Best" price: $1,000.00; qty>=3`)).not.toThrow();
  });

  it("an empty value is legitimate (clears a field)", () => {
    expect(assertFieldValue("")).toBe("");
  });

  it("accepts a value at exactly FIELD_VALUE_MAX (132) chars", () => {
    const v = "A".repeat(FIELD_VALUE_MAX);
    expect(assertFieldValue(v)).toBe(v);
  });

  it("rejects a value over FIELD_VALUE_MAX (132) chars", () => {
    const e = expectBadInput(() => assertFieldValue("A".repeat(FIELD_VALUE_MAX + 1)));
    expect(e.message).toMatch(/CHAR132/);
  });
});

describe("assertOkCode — control character guard", () => {
  for (const ch of C0_AND_DEL) {
    it(`throws BAD_INPUT for an OK-code containing 0x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`, () => {
      const e = expectBadInput(() => assertOkCode(`=A${ch}B`));
      expect(e.code).toBe("BAD_INPUT");
    });
  }

  it("does NOT throw for an OK-code (or any field value) containing an apostrophe", () => {
    expect(() => assertOkCode("=O'BRIEN")).not.toThrow();
  });

  it("rejects an empty or whitespace-only OK-code (must not be empty)", () => {
    expectBadInput(() => assertOkCode(""));
    expectBadInput(() => assertOkCode("   "));
  });

  it("trims surrounding whitespace", () => {
    expect(assertOkCode("  =SAVE  ")).toBe("=SAVE");
  });

  it("accepts a conventional function-code OK-code", () => {
    expect(assertOkCode("=WB_EXEC")).toBe("=WB_EXEC");
    expect(assertOkCode("/00")).toBe("/00");
  });

  it("rejects an OK-code over FIELD_VALUE_MAX (132) chars", () => {
    const e = expectBadInput(() => assertOkCode("A".repeat(FIELD_VALUE_MAX + 1)));
    expect(e.message).toMatch(/CHAR132/);
  });
});

// ---------------------------------------------------------------------------
// uiBridgeClassName — deterministic naming, length ceiling, validation-first
// ---------------------------------------------------------------------------

describe("uiBridgeClassName", () => {
  const screenByTcode: UiScreenQuery = { mode: "screen", target: { by: "tcode", tcode: "SE38" } };
  const screenByProgram: UiScreenQuery = {
    mode: "screen",
    target: { by: "program", program: "SAPMSSY0", dynpro: "0100" },
  };
  const press: UiPressQuery = {
    mode: "press",
    tcode: "SE38",
    screens: [{ program: "SAPMSSY0", dynpro: "0100", fields: [] }],
  };

  it("is deterministic: the exact same query (freshly reconstructed) produces the exact same class name", () => {
    expect(uiBridgeClassName(screenByTcode)).toBe(uiBridgeClassName({ ...screenByTcode }));
    expect(uiBridgeClassName(press)).toBe(uiBridgeClassName({ ...press, screens: [...press.screens] }));
  });

  it("differs for queries that differ in mode or target kind", () => {
    const names = [screenByTcode, screenByProgram, press].map(uiBridgeClassName);
    expect(new Set(names).size).toBe(3);
  });

  it("differs for a press query that differs only in one field's value", () => {
    const a = uiBridgeClassName(press);
    const b = uiBridgeClassName({
      ...press,
      screens: [{ ...press.screens[0]!, fields: [{ fieldName: "X", value: "1" }] }],
    });
    expect(a).not.toBe(b);
  });

  it("never exceeds ABAP's 30-char object-name limit and always starts with the fixed prefix", () => {
    for (const q of [screenByTcode, screenByProgram, press]) {
      const name = uiBridgeClassName(q);
      expect(name.length).toBeLessThanOrEqual(30);
      expect(name.startsWith(UI_BRIDGE_CLASS_PREFIX)).toBe(true);
      expect(name).toMatch(/^[A-Z0-9_]+$/);
    }
  });

  it("throws BAD_INPUT for a malformed query (validation runs before hashing)", () => {
    expectBadInput(() => uiBridgeClassName({ mode: "screen", target: { by: "tcode", tcode: "SE3'8" } }));
    expectBadInput(() =>
      uiBridgeClassName({ mode: "screen", target: { by: "program", program: "X", dynpro: "abcd" } }),
    );
  });

  it("throws BAD_INPUT for a press query with zero screens", () => {
    const e = expectBadInput(() => uiBridgeClassName({ mode: "press", tcode: "SE38", screens: [] }));
    expect(e.message).toMatch(/at least one screen/);
  });
});

// ---------------------------------------------------------------------------
// 2. Quote injection cannot break out of its literal — THE load-bearing test
// ---------------------------------------------------------------------------

describe("uiBridgeSource — press mode: quote injection cannot break out of its literal (SECURITY CRITICAL)", () => {
  it("a field value crafted to look like an escape/injection attempt is neutralised end-to-end through the real generation path", () => {
    // Deliberately shaped like an attempt to close the literal, insert a
    // fresh ABAP statement, and reopen a literal to keep the surrounding
    // syntax looking balanced to a naive eye.
    const PAYLOAD = "x' . SOMETHING. lv = '";
    const q: UiPressQuery = {
      mode: "press",
      tcode: "SE38",
      screens: [
        {
          program: "SAPMSSY0",
          dynpro: "0100",
          fields: [{ fieldName: "RS38M-PROGRAMM", value: PAYLOAD }],
        },
      ],
    };
    const className = uiBridgeClassName(q);
    const src = uiBridgeSource(q, className);

    // (a) The whole generated source has a balanced (even) count of `'`
    // characters — the strongest global invariant: every quote in valid
    // generated ABAP is either a literal delimiter pair or half of a doubled
    // escape pair, both of which contribute an even count.
    const totalQuotes = (src.match(/'/g) ?? []).length;
    expect(totalQuotes % 2).toBe(0);

    // (b) The payload's marker text appears EXACTLY ONCE in the source — if
    // it had broken out of its literal and been re-parsed as ABAP, nothing
    // here promises a single occurrence, and a successful injection could
    // duplicate/relocate it via generated control flow. One occurrence, in
    // the one line that builds lv_fval, is the honest baseline.
    const occurrences = src.split("SOMETHING").length - 1;
    expect(occurrences).toBe(1);

    // (c) That one occurrence sits on a `lv_fval = lv_fval && '...'.`
    // assignment line whose own quote count is even (i.e. the literal it
    // opens is the same literal it closes, on the same physical line).
    const line = src.split("\n").find((l) => l.includes("SOMETHING"));
    expect(line).toBeDefined();
    expect(line).toMatch(/^\s+lv_fval = lv_fval && '.*'\.$/);
    const lineQuotes = (line!.match(/'/g) ?? []).length;
    expect(lineQuotes % 2).toBe(0);

    // (d) Exact pin: the escaped literal is precisely the payload with every
    // `'` doubled, wrapped once — not "close early, statement, reopen".
    expect(line).toBe(`    lv_fval = lv_fval && '${escapeAbapLiteral(PAYLOAD)}'.`);
    expect(line).toBe(`    lv_fval = lv_fval && 'x'' . SOMETHING. lv = '''.`);

    // (e) The generated CALL TRANSACTION statement is still exactly one
    // statement — an injected `.` that actually terminated a statement would
    // either produce a second CALL TRANSACTION-shaped fragment or leave a
    // syntactically broken tail; neither happened. Match the actual
    // statement shape (`CALL TRANSACTION '...'`), not the bare phrase — the
    // generator's own explanatory comments mention "CALL TRANSACTION" twice
    // more in prose (e.g. "a bare CALL TRANSACTION (no MESSAGES...") and
    // would otherwise inflate this count without indicating any problem.
    expect((src.match(/CALL TRANSACTION '/g) ?? []).length).toBe(1);
    expect(src).toContain(`CALL TRANSACTION 'SE38' USING lt_bdc MODE 'N' UPDATE 'S'`);

    // (f) No line in the whole generated source exceeds ADT's 255-char limit
    // (uiBridgeSource would have thrown via assertNoOverlongLines otherwise —
    // reaching this point at all is already evidence, but check explicitly).
    for (const l of src.split("\n")) expect(l.length).toBeLessThanOrEqual(255);
  });

  it("a value that is ONLY a single quote is still safely embedded (minimal case of the same property)", () => {
    const q: UiPressQuery = {
      mode: "press",
      tcode: "SE38",
      screens: [{ program: "SAPMSSY0", dynpro: "0100", fields: [{ fieldName: "F", value: "'" }] }],
    };
    const src = uiBridgeSource(q, uiBridgeClassName(q));
    expect(src).toContain(`lv_fval = lv_fval && '${"''"}'.`);
    expect((src.match(/'/g) ?? []).length % 2).toBe(0);
  });

  it("a value containing a backtick, semicolon and comment-marker together does not alter the statement count", () => {
    const q: UiPressQuery = {
      mode: "press",
      tcode: "SE38",
      screens: [
        {
          program: "SAPMSSY0",
          dynpro: "0100",
          fields: [{ fieldName: "F", value: "`; DELETE FROM t99. \" comment" }],
        },
      ],
    };
    const src = uiBridgeSource(q, uiBridgeClassName(q));
    expect(src).toContain("DELETE FROM t99"); // present as inert literal text
    expect((src.match(/DELETE FROM t99/g) ?? []).length).toBe(1);
    expect((src.match(/'/g) ?? []).length % 2).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. No generated line exceeds 255 chars, worst-case field-value width
// ---------------------------------------------------------------------------

describe("uiBridgeSource — press mode: no generated line exceeds 255 chars at max field-value width", () => {
  it("a FIELD_VALUE_MAX-length (132) value of all single quotes — the worst case, since escaping doubles it — generates only in-bound lines", () => {
    const wideValue = "'".repeat(FIELD_VALUE_MAX);
    const q: UiPressQuery = {
      mode: "press",
      tcode: "SE38",
      screens: [{ program: "SAPMSSY0", dynpro: "0100", fields: [{ fieldName: "RS38M-PROGRAMM", value: wideValue }] }],
    };
    const className = uiBridgeClassName(q);

    // uiBridgeSource itself throws (via assertNoOverlongLines) if any
    // generated line is over 255 chars — this must not throw.
    let src = "";
    expect(() => {
      src = uiBridgeSource(q, className);
    }).not.toThrow();

    const lines = src.split("\n");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(255);
    // Sanity: this genuinely exercised multi-chunk generation, not a no-op.
    expect(lines.some((l) => l.includes("lv_fval = lv_fval && '"))).toBe(true);
  });

  it("the same worst case across every screen field simultaneously (OK-code, cursor field, and a plain field all at max width)", () => {
    const wideValue = "'".repeat(FIELD_VALUE_MAX);
    const q: UiPressQuery = {
      mode: "press",
      tcode: "SE38",
      screens: [
        {
          program: "SAPMSSY0",
          dynpro: "0100",
          cursorField: "RS38M-PROGRAMM",
          okCode: "'".repeat(FIELD_VALUE_MAX),
          fields: [
            { fieldName: "F1", value: wideValue },
            { fieldName: "F2", value: wideValue },
          ],
        },
      ],
    };
    const src = uiBridgeSource(q, uiBridgeClassName(q));
    for (const line of src.split("\n")) expect(line.length).toBeLessThanOrEqual(255);
  });
});

// ---------------------------------------------------------------------------
// 7. BDCDATA row well-formedness — screen-start vs field rows never mix
// ---------------------------------------------------------------------------

describe("uiBridgeSource — press mode: BDCDATA row well-formedness", () => {
  it("every screen-start row carries dynbegin='X' with program/dynpro and NO fnam/fval; every field row carries fnam/fval and NEVER dynbegin", () => {
    const q: UiPressQuery = {
      mode: "press",
      tcode: "SE38",
      screens: [
        {
          program: "SAPMSSY0",
          dynpro: "0100",
          cursorField: "RS38M-PROGRAMM",
          fields: [
            { fieldName: "RS38M-PROGRAMM", value: "ZTEST_REPORT" },
            { fieldName: "RS38M-SUBRC", value: "" },
          ],
          okCode: "=WB_EXEC",
        },
        {
          // A minimal second screen: only an OK-code, no cursor/fields.
          program: "SAPMSSY1",
          dynpro: "0200",
          fields: [],
          okCode: "=BACK",
        },
      ],
    };
    const src = uiBridgeSource(q, uiBridgeClassName(q));

    const appendLines = src.split("\n").filter((l) => l.includes("APPEND VALUE #(") && l.includes("TO lt_bdc."));
    // 2 screen-start rows + (cursor + 2 fields + okcode) + (okcode) = 2 + 4 + 1 = 7
    expect(appendLines).toHaveLength(7);

    let screenStartRows = 0;
    let fieldRows = 0;
    for (const line of appendLines) {
      const isScreenStart = line.includes("dynbegin = 'X'");
      if (isScreenStart) {
        screenStartRows++;
        expect(line).toMatch(/program = '[^']*'/);
        expect(line).toMatch(/dynpro = '[^']*'/);
        expect(line).not.toContain("fnam");
        expect(line).not.toContain("fval");
      } else {
        fieldRows++;
        expect(line).toMatch(/fnam = '[^']*'/);
        expect(line).toContain("fval = lv_fval");
        // The load-bearing negative: a field row must NEVER mention dynbegin
        // at all (not even `dynbegin = ' '`) — see bdcFieldLines's doc
        // comment: DYNBEGIN is left at its constructor-default, never spelled.
        expect(line).not.toContain("dynbegin");
        expect(line).not.toContain("program");
        expect(line).not.toContain("dynpro");
      }
    }
    expect(screenStartRows).toBe(2);
    expect(fieldRows).toBe(5);
  });

  it("a screen with no cursor field, no fields and no OK-code emits only its single screen-start row", () => {
    const q: UiPressQuery = {
      mode: "press",
      tcode: "SE38",
      screens: [{ program: "SAPMSSY0", dynpro: "0100", fields: [] }],
    };
    const src = uiBridgeSource(q, uiBridgeClassName(q));
    const appendLines = src.split("\n").filter((l) => l.includes("APPEND VALUE #(") && l.includes("TO lt_bdc."));
    expect(appendLines).toHaveLength(1);
    expect(appendLines[0]).toContain("dynbegin = 'X'");
  });
});

// ---------------------------------------------------------------------------
// 8. WITHOUT AUTHORITY-CHECK never appears as an active clause
// ---------------------------------------------------------------------------

describe("uiBridgeSource — press mode: WITHOUT AUTHORITY-CHECK never appears as an active clause", () => {
  it("the deliberate warning COMMENT above CALL TRANSACTION is present (sanity: we're testing real content)", () => {
    const q: UiPressQuery = {
      mode: "press",
      tcode: "SE38",
      screens: [{ program: "SAPMSSY0", dynpro: "0100", fields: [] }],
    };
    const src = uiBridgeSource(q, uiBridgeClassName(q));
    expect(src).toContain("NEVER add WITHOUT AUTHORITY-CHECK here");
  });

  it("no NON-COMMENT line contains WITHOUT AUTHORITY-CHECK — only the comment line may", () => {
    const q: UiPressQuery = {
      mode: "press",
      tcode: "SE38",
      screens: [{ program: "SAPMSSY0", dynpro: "0100", fields: [{ fieldName: "F", value: "x" }], okCode: "=SAVE" }],
    };
    const src = uiBridgeSource(q, uiBridgeClassName(q));
    const lines = src.split("\n");
    const nonCommentLines = lines.filter((l) => !l.trim().startsWith('"'));
    const commentLines = lines.filter((l) => l.trim().startsWith('"'));

    // The comment carrying the warning text must exist...
    expect(commentLines.some((l) => l.includes("WITHOUT AUTHORITY-CHECK"))).toBe(true);
    // ...but it must never appear on a non-comment (active ABAP) line.
    for (const l of nonCommentLines) {
      expect(l).not.toContain("WITHOUT AUTHORITY-CHECK");
    }
  });

  it("the actual CALL TRANSACTION statement (the two physical lines it spans) carries no such clause", () => {
    const q: UiPressQuery = {
      mode: "press",
      tcode: "SE38",
      screens: [{ program: "SAPMSSY0", dynpro: "0100", fields: [] }],
    };
    const src = uiBridgeSource(q, uiBridgeClassName(q));
    const lines = src.split("\n");
    const callIdx = lines.findIndex((l) => l.includes("CALL TRANSACTION"));
    expect(callIdx).toBeGreaterThanOrEqual(0);
    // The statement continues onto the very next line (`MESSAGES INTO ...`).
    const statement = `${lines[callIdx]}\n${lines[callIdx + 1]}`;
    expect(statement).toContain("MESSAGES INTO lt_msgcoll.");
    expect(statement).not.toContain("WITHOUT AUTHORITY-CHECK");
    expect(statement).toMatch(/^\s+CALL TRANSACTION '[^']*' USING lt_bdc MODE 'N' UPDATE 'S'/);
  });
});

// ---------------------------------------------------------------------------
// uiBridgeSource — general shape / screen mode / empty edge inputs
// ---------------------------------------------------------------------------

describe("uiBridgeSource — general shape", () => {
  it("is byte-stable across repeated calls with freshly reconstructed value-equal queries", () => {
    const q: UiPressQuery = {
      mode: "press",
      tcode: "SE38",
      screens: [{ program: "SAPMSSY0", dynpro: "0100", fields: [{ fieldName: "F", value: "v" }] }],
    };
    const cls = uiBridgeClassName(q);
    const a = uiBridgeSource(q, cls);
    const b = uiBridgeSource({ ...q, screens: [...q.screens] }, cls);
    expect(a).toBe(b);
  });

  it("starts with the class definition and ends with ENDCLASS., and contains the classrun interface wiring", () => {
    const q: UiPressQuery = { mode: "press", tcode: "SE38", screens: [{ program: "X", dynpro: "0100", fields: [] }] };
    const src = uiBridgeSource(q, uiBridgeClassName(q));
    expect(src).toMatch(/^CLASS .* DEFINITION PUBLIC FINAL CREATE PUBLIC\./);
    expect(src).toContain("INTERFACES if_oo_adt_classrun.");
    expect(src).toContain("METHOD if_oo_adt_classrun~main.");
    expect(src.trimEnd().endsWith("ENDCLASS.")).toBe(true);
  });
});

describe("uiBridgeSource — screen mode", () => {
  it("by tcode: resolves via TSTC and classifies cinfo, reads RPY_DYNPRO_READ and RS_CUA_GET_STATUS", () => {
    const q: UiScreenQuery = { mode: "screen", target: { by: "tcode", tcode: "SE38" } };
    const src = uiBridgeSource(q, uiBridgeClassName(q));
    expect(src).toContain("FROM tstc");
    expect(src).toContain("WHERE tcode = 'SE38'");
    expect(src).toContain("CALL FUNCTION 'RPY_DYNPRO_READ'");
    expect(src).toContain("CALL FUNCTION 'RS_CUA_GET_STATUS'");
    expect(src).toContain(`${UI_LINE_PREFIX}TCODE tcode=[SE38]`);
  });

  it("GUI status: fetches via RS_CUA_INTERNAL_FETCH (not a blank-STATUS RS_CUA_GET_STATUS call), then loops RS_CUA_GET_STATUS once per enumerated status with an explicit STATUS", () => {
    const q: UiScreenQuery = { mode: "screen", target: { by: "tcode", tcode: "SE38" } };
    const src = uiBridgeSource(q, uiBridgeClassName(q));

    expect(src).toContain("CALL FUNCTION 'RS_CUA_INTERNAL_FETCH'");
    // The RS_CUA_INTERNAL_FETCH call must not itself carry a STATUS parameter
    // — that FM enumerates every status via its `sta` TABLES output instead.
    const fetchCallIdx = src.indexOf("CALL FUNCTION 'RS_CUA_INTERNAL_FETCH'");
    const fetchCallEnd = src.indexOf(".\n", src.indexOf("OTHERS", fetchCallIdx));
    const fetchCallBlock = src.slice(fetchCallIdx, fetchCallEnd);
    expect(fetchCallBlock).not.toMatch(/\bstatus\s*=/i);

    // The per-status RS_CUA_GET_STATUS call must bind an explicit STATUS —
    // this is the exact defect being fixed: a blank STATUS returns
    // sy-subrc=2 (NOT_FOUND_STATUS) on every real transaction tested live.
    expect(src).toMatch(/status\s*=\s*lv_status/);
    // The live-validated block goes through an intermediate GUI_STATUS
    // variable rather than passing RSMPE_STAT-CODE (CHAR40) directly:
    // RS_CUA_GET_STATUS's STATUS parameter is untyped (TYPE ANY), so the
    // formal type the caller passes is what the FM actually sees, and only
    // the GUI_STATUS form has been executed against a live system.
    expect(src).toContain("DATA lv_status TYPE gui_status.");
    expect(src).toContain("lv_status = ls_sta-code.");
    // Enumeration count gates the loop.
    expect(src).toContain(`IF lv_status_done >= ${UI_STATUS_LOOP_CAP}.`);
  });

  it("FUNCTION/FKEY lines use a fixed narrow projection, NOT flatten_any (a full RTTI dump of these two high-volume tables measured ~600 rows / ~7,000 key=[value] pairs on a real program)", () => {
    const q: UiScreenQuery = { mode: "screen", target: { by: "tcode", tcode: "SE38" } };
    const src = uiBridgeSource(q, uiBridgeClassName(q));

    expect(src).toContain(
      `mo_out->write( |${UI_LINE_PREFIX}FUNCTION code=[{ ls_fun-code }] text=[{ ls_fun-fun_text }] type=[{ ls_fun-type }]| ).`,
    );
    expect(src).not.toContain(`FUNCTION { flatten_any( ls_fun ) }`);

    expect(src).toContain(
      `mo_out->write( |${UI_LINE_PREFIX}FKEY status=[{ lv_status }] code=[{ ls_fkey-code }] text=[{ ls_fkey-text }] quickinfo=[{ ls_fkey-quickinfo }]| ).`,
    );
    expect(src).not.toContain(`FKEY { flatten_any( ls_fkey ) }`);

    // STATUS/HEADER/FIELD/FLOW stay full flatten_any dumps — low volume, and
    // the exact component names for those rows were never independently
    // confirmed, so the bridge still reports whatever the ABAP system gives.
    expect(src).toContain(`STATUS { flatten_any( ls_sta ) }`);
  });

  it("drops FKEY rows with an empty function code (unassigned function-key slots are pure noise)", () => {
    const q: UiScreenQuery = { mode: "screen", target: { by: "tcode", tcode: "SE38" } };
    const src = uiBridgeSource(q, uiBridgeClassName(q));
    expect(src).toContain("IF ls_fkey-code IS NOT INITIAL.");
    // The write + counter increment must be inside that guard, not before it.
    const guardIdx = src.indexOf("IF ls_fkey-code IS NOT INITIAL.");
    const afterGuard = src.slice(guardIdx, guardIdx + 400);
    expect(afterGuard).toContain("FKEY status=[{ lv_status }]");
    expect(afterGuard).toContain("lv_fkeys_total = lv_fkeys_total + 1.");
  });

  it("caps total FKEY emission at UI_FKEY_ROW_CAP and reports emitted/capped via FKEY_CAP — the fix for SAPLSVIM's header-said-778-body-had-442 defect", () => {
    const q: UiScreenQuery = { mode: "screen", target: { by: "tcode", tcode: "SE38" } };
    const src = uiBridgeSource(q, uiBridgeClassName(q));

    expect(src).toContain("DATA lv_fkeys_capped TYPE abap_bool VALUE abap_false.");
    expect(src).toContain(`IF lv_fkeys_total < ${UI_FKEY_ROW_CAP}.`);
    expect(src).toContain("lv_fkeys_capped = abap_true.");
    expect(src).toContain(
      `mo_out->write( |${UI_LINE_PREFIX}FKEY_CAP emitted=[{ lv_fkeys_total }] capped=[{ lv_fkeys_capped }]| ).`,
    );

    // COUNT_FKEYS must come from the SAME lv_fkeys_total that FKEY_CAP
    // reports as `emitted` — the whole point of this cap is that the header
    // count can never again overstate the body (SAPLSVIM: header said
    // fkeysCount=778, body actually delivered 442 FKEY rows).
    expect(src).toContain(`mo_out->write( |${UI_LINE_PREFIX}COUNT_FKEYS { lv_fkeys_total }| ).`);

    // lv_fkeys_total must only increment on an actual emit (inside the cap
    // guard's THEN branch), never in the ELSE branch where the cap fires —
    // otherwise COUNT_FKEYS would count encountered rows, not emitted ones.
    const elseIdx = src.indexOf("ELSE.\n                  lv_fkeys_capped = abap_true.");
    expect(elseIdx).toBeGreaterThan(-1);
    const elseBlock = src.slice(elseIdx, src.indexOf("ENDIF.", elseIdx));
    expect(elseBlock).not.toContain("lv_fkeys_total = lv_fkeys_total + 1.");
  });

  it("UI_FKEY_ROW_CAP is small enough to actually serve its purpose: worst-case FKEY emission must fit well inside the response budget (INVARIANT)", () => {
    // Every other cap test interpolates UI_FKEY_ROW_CAP into its own
    // expectation, so they all pass for ANY value — including a value large
    // enough that the cap does nothing. They verify the wiring; this verifies
    // the cap is worth having. Raising UI_FKEY_ROW_CAP to a number that
    // defeats it must fail HERE, loudly, rather than sail through green.
    //
    // The numbers are the ones in UI_FKEY_ROW_CAP's own doc comment, so the
    // documented rationale and the enforced invariant cannot drift apart:
    //   - an emitted FKEY line runs ~80 characters, measured from real output
    //     (`UI> FKEY status=[LISTE_ALV] code=[ONLI] text=[...] quickinfo=[...]`)
    //   - the response budget is cfg.maxResponseChars, default 60,000
    //     (src/config.ts — `ABAP_MAX_RESPONSE_CHARS ?? 60_000`)
    //   - FIELDS, FLOW LOGIC and FUNCTION CODES share that same budget, and
    //     FUNCTION CODES alone measured 176 rows live on SAPLSETB, so FKEYS
    //     must stay under HALF of it or it will crowd them out — which is the
    //     exact live defect this cap exists to prevent (SAPLSVIM: header
    //     reported fkeysCount=778, body delivered 442, tail silently dropped).
    const FKEY_LINE_CHARS = 80;
    const DEFAULT_MAX_RESPONSE_CHARS = 60_000;
    const worstCase = UI_FKEY_ROW_CAP * FKEY_LINE_CHARS;

    expect(worstCase).toBeLessThanOrEqual(DEFAULT_MAX_RESPONSE_CHARS / 2);
  });

  it("does NOT abandon the status loop when the FKEY row cap fires — STATUS_LOOP's done/total keep describing statuses walked, a fact independent of rows emitted", () => {
    const q: UiScreenQuery = { mode: "screen", target: { by: "tcode", tcode: "SE38" } };
    const src = uiBridgeSource(q, uiBridgeClassName(q));

    // The ONLY `EXIT.` inside the per-status LOOP AT lt_sta is the one
    // guarded by the UI_STATUS_LOOP_CAP check — the FKEY row cap sets its
    // own flag (lv_fkeys_capped) and continues, it never EXITs the outer
    // status loop. This is the deliberate choice documented on
    // UI_FKEY_ROW_CAP / lv_fkeys_capped: "statuses walked" and "rows
    // emitted" are kept as two separate, independently honest facts.
    const loopStart = src.indexOf("LOOP AT lt_sta INTO ls_sta.");
    const loopEnd = src.indexOf("ENDLOOP.", src.indexOf("STATUS_LOOP done="));
    const loopBody = src.slice(loopStart, loopEnd);
    const exitCount = (loopBody.match(/\bEXIT\.\n/g) ?? []).length;
    expect(exitCount).toBe(1);
    expect(src).toContain(`IF lv_status_done >= ${UI_STATUS_LOOP_CAP}.\n            lv_status_capped = abap_true.\n            EXIT.`);
  });

  it("treats RS_CUA_INTERNAL_FETCH sy-subrc=1 (NOT_FOUND) as a normal outcome, not an error: it is routed through UI_LINE_PREFIX, never ERR_LINE_PREFIX", () => {
    const q: UiScreenQuery = { mode: "screen", target: { by: "tcode", tcode: "SE38" } };
    const src = uiBridgeSource(q, uiBridgeClassName(q));
    expect(src).toContain("IF sy-subrc = 1.");
    expect(src).toContain(`${UI_LINE_PREFIX}NOCUA program=[{ lv_program }]`);
  });

  it("by program/dynpro: sets lv_program/lv_dynpro directly, no TSTC lookup", () => {
    const q: UiScreenQuery = { mode: "screen", target: { by: "program", program: "SAPMSSY0", dynpro: "100" } };
    const src = uiBridgeSource(q, uiBridgeClassName(q));
    expect(src).not.toContain("FROM tstc");
    expect(src).toContain("lv_program = 'SAPMSSY0'.");
    // dynpro "100" must have been normalised to "0100" before interpolation.
    expect(src).toContain("lv_dynpro = '0100'.");
  });

  it("never emits BDCDATA/CALL TRANSACTION machinery (read-only mode)", () => {
    const q: UiScreenQuery = { mode: "screen", target: { by: "tcode", tcode: "SE38" } };
    const src = uiBridgeSource(q, uiBridgeClassName(q));
    expect(src).not.toContain("CALL TRANSACTION");
    expect(src).not.toContain("BDCDATA");
  });
});

// ---------------------------------------------------------------------------
// 9. parseUiTranscript — the 00/344 stall decoding, the tool's core discovery loop
// ---------------------------------------------------------------------------

describe("parseUiTranscript — press mode: 00/344 stall decoding", () => {
  it("decodes sy-subrc=1001 + message 00/344 into a structured stalled{program,dynpro,hint}", () => {
    const raw =
      `${UI_LINE_PREFIX}SUBRC 1001\n` +
      `${UI_LINE_PREFIX}ROWCOUNT 12\n` +
      `${UI_LINE_PREFIX}MSG msgtyp=[S] msgid=[00] msgnr=[344] msgv1=[SAPLSETB] msgv2=[0230] msgv3=[] msgv4=[] text=[No batch input data for dynpro SAPLSETB 0230]\n`;

    const result = parseUiTranscript(raw);

    expect(result.press).toBeDefined();
    expect(result.press!.subrc).toBe(1001);
    expect(result.press!.rowCount).toBe(12);
    expect(result.press!.messages).toHaveLength(1);
    expect(result.press!.messages[0]).toEqual({
      msgType: "S",
      msgId: "00",
      msgNumber: "344",
      msgv1: "SAPLSETB",
      msgv2: "0230",
      msgv3: "",
      msgv4: "",
      text: "No batch input data for dynpro SAPLSETB 0230",
    });
    expect(result.press!.stalled).toEqual({
      program: "SAPLSETB",
      dynpro: "0230",
      hint:
        "Ran out of scripted screens at program=SAPLSETB dynpro=0230. " +
        'Call abap_ui with mode="screen", program="SAPLSETB", dynpro="0230" ' +
        "to learn that screen's fields and buttons, then extend the screens array and press again.",
    });
  });

  it("a clean run (sy-subrc=0) does NOT report a stall, even with other messages present", () => {
    const raw =
      `${UI_LINE_PREFIX}SUBRC 0\n` +
      `${UI_LINE_PREFIX}ROWCOUNT 3\n` +
      `${UI_LINE_PREFIX}MSG msgtyp=[S] msgid=[00] msgnr=[001] msgv1=[X] msgv2=[Y] msgv3=[] msgv4=[] text=[Some info message]\n`;

    const result = parseUiTranscript(raw);
    expect(result.press).toBeDefined();
    expect(result.press!.subrc).toBe(0);
    expect(result.press!.stalled).toBeUndefined();
  });

  it("sy-subrc=1001 WITHOUT a matching 00/344 message does not fabricate a stall", () => {
    const raw = `${UI_LINE_PREFIX}SUBRC 1001\n${UI_LINE_PREFIX}ROWCOUNT 1\n`;
    const result = parseUiTranscript(raw);
    expect(result.press!.subrc).toBe(1001);
    expect(result.press!.stalled).toBeUndefined();
  });

  it("a 00/344 message present but sy-subrc is NOT 1001 does not report a stall (the code, not the message alone, is the signal)", () => {
    const raw =
      `${UI_LINE_PREFIX}SUBRC 4\n` +
      `${UI_LINE_PREFIX}MSG msgtyp=[E] msgid=[00] msgnr=[344] msgv1=[SOMEPROG] msgv2=[9999] msgv3=[] msgv4=[] text=[irrelevant here]\n`;
    const result = parseUiTranscript(raw);
    expect(result.press!.subrc).toBe(4);
    expect(result.press!.stalled).toBeUndefined();
  });

  it("a screen-mode-only transcript (no SUBRC line at all) has no press result", () => {
    const raw = `${UI_LINE_PREFIX}RESOLVED program=[SAPMSSY0] dynpro=[0100]\n`;
    expect(parseUiTranscript(raw).press).toBeUndefined();
  });
});

describe("parseUiTranscript — screen mode TCODE line / bdcApplies mapping", () => {
  it("cinfo '00' (classic dialog) maps to bdcApplies: true", () => {
    const raw = `${UI_LINE_PREFIX}TCODE tcode=[SE38] program=[SAPMSEU5] dynpro=[1000] cinfo=[00] kind=[dialog transaction]\n`;
    expect(parseUiTranscript(raw).tcode?.bdcApplies).toBe(true);
  });

  it("cinfo '80' (report/SUBMIT) maps to bdcApplies: false", () => {
    const raw = `${UI_LINE_PREFIX}TCODE tcode=[SE38] program=[SAPMSEU5] dynpro=[1000] cinfo=[80] kind=[report transaction]\n`;
    expect(parseUiTranscript(raw).tcode?.bdcApplies).toBe(false);
  });

  it("any other cinfo maps to bdcApplies: undefined (mechanism not confirmed) rather than a guess", () => {
    const raw = `${UI_LINE_PREFIX}TCODE tcode=[SE38] program=[SAPMSEU5] dynpro=[1000] cinfo=[40] kind=[unrecognised]\n`;
    const result = parseUiTranscript(raw);
    expect(result.tcode?.cinfo).toBe("40");
    expect(result.tcode?.bdcApplies).toBeUndefined();
  });
});

describe("parseUiTranscript — diagnostics and dropped lines", () => {
  it("ERR_LINE_PREFIX lines land in diagnostics, not in press/tcode/fields", () => {
    const raw = `ZMCP-ERR> RPY_DYNPRO_READ failed, sy-subrc=2 (1=cancelled 2=not_found 3=permission_error 4=other)\n`;
    const result = parseUiTranscript(raw);
    expect(result.diagnostics).toEqual([
      "ZMCP-ERR> RPY_DYNPRO_READ failed, sy-subrc=2 (1=cancelled 2=not_found 3=permission_error 4=other)",
    ]);
    expect(result.press).toBeUndefined();
  });

  it("a genuinely unprefixed line is counted in droppedLines and does not corrupt surrounding valid lines", () => {
    const raw =
      `${UI_LINE_PREFIX}SUBRC 0\n` + `some ADT/HTTP framing noise that is neither UI> nor ZMCP-ERR>\n` + `${UI_LINE_PREFIX}ROWCOUNT 1\n`;
    const result = parseUiTranscript(raw);
    expect(result.droppedLines).toBe(1);
    expect(result.press!.subrc).toBe(0);
    expect(result.press!.rowCount).toBe(1);
  });

  it("blank unprefixed lines are NOT counted as dropped (ADT/HTTP framing noise)", () => {
    const raw = `${UI_LINE_PREFIX}SUBRC 0\n\n\n`;
    expect(parseUiTranscript(raw).droppedLines).toBe(0);
  });

  it("handles empty input without throwing", () => {
    const result = parseUiTranscript("");
    expect(result.press).toBeUndefined();
    expect(result.tcode).toBeUndefined();
    expect(result.fields).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });
});

describe("parseUiTranscript — screen mode FIELD/FLOW/STATUS/FKEY rows and counts", () => {
  it("parses FIELD rows and their COUNT_FIELDS line independently", () => {
    const raw =
      `${UI_LINE_PREFIX}COUNT_FIELDS 2\n` +
      `${UI_LINE_PREFIX}FIELD FNAM=[RS38M-PROGRAMM] FTYP=[C]\n` +
      `${UI_LINE_PREFIX}FIELD FNAM=[RS38M-SUBRC] FTYP=[C]\n`;
    const result = parseUiTranscript(raw);
    expect(result.fieldsCount).toBe(2);
    expect(result.fields).toHaveLength(2);
    expect(result.fields[0]).toEqual({ FNAM: "RS38M-PROGRAMM", FTYP: "C" });
  });

  it("parses STATUS rows (flatten_any dump) and FKEY rows (fixed status/code/text/quickinfo projection) with their counts", () => {
    const raw =
      `${UI_LINE_PREFIX}COUNT_STATUS 1\n` +
      `${UI_LINE_PREFIX}STATUS CODE=[SAVE] TEXT=[Save]\n` +
      `${UI_LINE_PREFIX}COUNT_FKEYS 1\n` +
      `${UI_LINE_PREFIX}FKEY status=[SAVE] code=[F3] text=[Back] quickinfo=[Back to previous screen]\n`;
    const result = parseUiTranscript(raw);
    expect(result.statusCount).toBe(1);
    expect(result.statusList).toEqual([{ CODE: "SAVE", TEXT: "Save" }]);
    expect(result.fkeysCount).toBe(1);
    // Fixed key set — a deliberate projection off RSEUL_KEYS, not a
    // flatten_any dump. If a future change alters this projection, this
    // exact-keys assertion should force the change to be deliberate.
    expect(result.fkeys).toEqual([{ status: "SAVE", code: "F3", text: "Back", quickinfo: "Back to previous screen" }]);
  });

  it("parses FUNCTION rows and their COUNT_FUNCTIONS line (program-wide function codes from RS_CUA_INTERNAL_FETCH's fun table, fixed code/text/type projection)", () => {
    const raw =
      `${UI_LINE_PREFIX}COUNT_FUNCTIONS 2\n` +
      `${UI_LINE_PREFIX}FUNCTION code=[SAVE] text=[Save] type=[E]\n` +
      `${UI_LINE_PREFIX}FUNCTION code=[BACK] text=[Back] type=[E]\n`;
    const result = parseUiTranscript(raw);
    expect(result.functionsCount).toBe(2);
    // Fixed key set — a deliberate projection off RSMPE_FUNT (14 components
    // in the raw structure), not a flatten_any dump.
    expect(result.functions).toEqual([
      { code: "SAVE", text: "Save", type: "E" },
      { code: "BACK", text: "Back", type: "E" },
    ]);
  });

  it("FKEY rows from different statuses are distinguishable via the status key — the union-across-statuses format still answers 'which okcode for THIS status'", () => {
    const raw =
      `${UI_LINE_PREFIX}COUNT_FKEYS 3\n` +
      `${UI_LINE_PREFIX}FKEY status=[STATUS_A] code=[SAVE] text=[Save] quickinfo=[Save entry]\n` +
      `${UI_LINE_PREFIX}FKEY status=[STATUS_A] code=[BACK] text=[Back] quickinfo=[Go back]\n` +
      `${UI_LINE_PREFIX}FKEY status=[STATUS_B] code=[CANC] text=[Cancel] quickinfo=[Cancel entry]\n`;
    const result = parseUiTranscript(raw);
    expect(result.fkeys).toHaveLength(3);
    const byStatus = (s: string) => result.fkeys.filter((r) => r.status === s).map((r) => r.code);
    expect(byStatus("STATUS_A").sort()).toEqual(["BACK", "SAVE"]);
    expect(byStatus("STATUS_B")).toEqual(["CANC"]);
  });

  it("parses STATUS_LOOP into a structured {done,total,capped}, uncapped case", () => {
    const raw = `${UI_LINE_PREFIX}STATUS_LOOP done=[3] total=[3] capped=[ ]\n`;
    const result = parseUiTranscript(raw);
    expect(result.statusLoop).toEqual({ done: 3, total: 3, capped: false });
  });

  it("parses STATUS_LOOP with capped=[X] as capped: true — the tool must be able to detect and disclose truncation", () => {
    const raw = `${UI_LINE_PREFIX}STATUS_LOOP done=[${UI_STATUS_LOOP_CAP}] total=[45] capped=[X]\n`;
    const result = parseUiTranscript(raw);
    expect(result.statusLoop).toEqual({ done: UI_STATUS_LOOP_CAP, total: 45, capped: true });
  });

  it("parses FKEY_CAP into a structured {emitted,capped}, uncapped case", () => {
    const raw = `${UI_LINE_PREFIX}FKEY_CAP emitted=[3] capped=[ ]\n`;
    const result = parseUiTranscript(raw);
    expect(result.fkeyCap).toEqual({ emitted: 3, capped: false });
  });

  it("parses FKEY_CAP with capped=[X] as capped: true — the tool must be able to detect and disclose row truncation the same way it does for STATUS_LOOP", () => {
    const raw = `${UI_LINE_PREFIX}FKEY_CAP emitted=[${UI_FKEY_ROW_CAP}] capped=[X]\n`;
    const result = parseUiTranscript(raw);
    expect(result.fkeyCap).toEqual({ emitted: UI_FKEY_ROW_CAP, capped: true });
  });

  it("fkeysCount (from COUNT_FKEYS) equals fkeyCap.emitted and the actual number of FKEY rows parsed — the header can never again overstate the body", () => {
    const raw =
      `${UI_LINE_PREFIX}COUNT_FKEYS 2\n` +
      `${UI_LINE_PREFIX}FKEY status=[SAVE] code=[F3] text=[Back] quickinfo=[Back to previous screen]\n` +
      `${UI_LINE_PREFIX}FKEY status=[SAVE] code=[F15] text=[Exit] quickinfo=[Exit]\n` +
      `${UI_LINE_PREFIX}FKEY_CAP emitted=[2] capped=[ ]\n`;
    const result = parseUiTranscript(raw);
    expect(result.fkeysCount).toBe(2);
    expect(result.fkeyCap).toEqual({ emitted: 2, capped: false });
    expect(result.fkeys).toHaveLength(result.fkeysCount as number);
    expect(result.fkeys).toHaveLength(result.fkeyCap!.emitted);
  });

  it("both STATUS_LOOP and FKEY_CAP can be capped on the same transcript (SAPLSVIM trips both live) — the two facts are independent and both must survive parsing", () => {
    const raw =
      `${UI_LINE_PREFIX}COUNT_FKEYS ${UI_FKEY_ROW_CAP}\n` +
      `${UI_LINE_PREFIX}FKEY_CAP emitted=[${UI_FKEY_ROW_CAP}] capped=[X]\n` +
      `${UI_LINE_PREFIX}STATUS_LOOP done=[${UI_STATUS_LOOP_CAP}] total=[59] capped=[X]\n`;
    const result = parseUiTranscript(raw);
    expect(result.statusLoop).toEqual({ done: UI_STATUS_LOOP_CAP, total: 59, capped: true });
    expect(result.fkeyCap).toEqual({ emitted: UI_FKEY_ROW_CAP, capped: true });
    expect(result.fkeysCount).toBe(UI_FKEY_ROW_CAP);
  });

  it("a transcript with more FKEY rows than UI_FKEY_ROW_CAP is handled coherently (defensive: the generator should never produce this by construction, but the parser must not choke or silently misreport if it ever did)", () => {
    const overCapCount = UI_FKEY_ROW_CAP + 5;
    const fkeyLines = Array.from(
      { length: overCapCount },
      (_, i) => `${UI_LINE_PREFIX}FKEY status=[SAVE] code=[F${i}] text=[t${i}] quickinfo=[q${i}]\n`,
    ).join("");
    const raw = `${UI_LINE_PREFIX}COUNT_FKEYS ${overCapCount}\n${fkeyLines}${UI_LINE_PREFIX}FKEY_CAP emitted=[${overCapCount}] capped=[ ]\n`;
    const result = parseUiTranscript(raw);
    // The parser itself never enforces the cap — it faithfully reports
    // whatever the transcript actually contains, so a caller can tell
    // "the ABAP-side guarantee held" (fkeysCount === fkeys.length) from
    // "the header disagrees with the body" (the SAPLSVIM defect this whole
    // fix exists to prevent) rather than one of those facts going missing.
    expect(result.fkeys).toHaveLength(overCapCount);
    expect(result.fkeysCount).toBe(overCapCount);
    expect(result.fkeyCap).toEqual({ emitted: overCapCount, capped: false });
    expect(result.fkeysCount).toBe(result.fkeys.length);
  });

  it("parses NOCUA as a normal outcome (no GUI status defined), separate from statusList/functions/fkeys which stay empty", () => {
    const raw = `${UI_LINE_PREFIX}NOCUA program=[ZMCP_NO_CUA_TEST] note=[no GUI status defined for this program]\n`;
    const result = parseUiTranscript(raw);
    expect(result.noCua).toEqual({
      program: "ZMCP_NO_CUA_TEST",
      note: "no GUI status defined for this program",
    });
    expect(result.statusList).toEqual([]);
    expect(result.functions).toEqual([]);
    expect(result.fkeys).toEqual([]);
    // NOCUA must never be routed through diagnostics — it is not an error.
    expect(result.diagnostics).toEqual([]);
  });
});

/**
 * INVARIANT: every variable bound to a TABLES parameter in the generated ABAP
 * must be declared as an internal table.
 *
 * This exists because of a shipped defect, and the defect is worth stating so
 * the next reader understands what the test is really buying. `lt_flow_logic`
 * was declared `TYPE rpy_dyflow` — a bare STRUCTURE — and passed to
 * `RPY_DYNPRO_READ`'s `FLOW_LOGIC` TABLES parameter. Every single `screen`-mode
 * call failed ABAP activation with "LT_FLOW_LOGIC is not an internal table"
 * (four errors, from the TABLES binding plus the `lines()` and `LOOP AT` uses
 * below it). `screen` is the read-only, ungated half of `abap_ui`, so the tool
 * was unusable in its safe mode for every caller, in every mode, on every
 * transaction. It reached a live system before anything caught it.
 *
 * The trap is that a TABLES parameter declared `LIKE <struct>` in the function
 * signature types the ROW, not the table. `FLOW_LOGIC LIKE RPY_DYFLOW` and
 * `FIELDS_LIST LIKE D021S` read as if a plain structure would do; both need
 * `TYPE TABLE OF`. One of the two was written correctly and the other was not,
 * on adjacent lines, which is exactly how this class of bug survives review.
 *
 * The 119 tests already in this file did not catch it because they assert on
 * the TEXT of the generated source — and the generated text was precisely what
 * the author intended. Only the ABAP compiler disagreed. This test closes that
 * gap structurally: it parses the generated source the way the compiler reads
 * it, pairing every TABLES binding with its DATA declaration, so no future
 * TABLES parameter can ship mis-declared regardless of which function module
 * it belongs to.
 */
describe("uiBridgeSource — every TABLES-bound variable is declared as an internal table (INVARIANT)", () => {
  /**
   * Extracts (parameter, variable) pairs from every `TABLES` section of every
   * `CALL FUNCTION` in the source, and every `DATA <name> TYPE <type>.`
   * declaration. Deliberately line-based and dumb: it mirrors how the ABAP
   * compiler sees the file rather than trusting how the generator built it.
   */
  const analyse = (src: string) => {
    const lines = src.split("\n");
    const declarations = new Map<string, string>();
    const tablesBindings: { param: string; variable: string; fn: string }[] = [];

    let currentFn = "<unknown>";
    // Which block of a CALL FUNCTION we are inside. TABLES bindings are only
    // the ones between `TABLES` and the next section keyword.
    let section: "none" | "tables" | "other" = "none";

    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith('"') || line === "") continue;

      const decl = /^DATA\s+(\w+)\s+TYPE\s+(.+?)\.$/i.exec(line);
      if (decl) {
        declarations.set(decl[1].toUpperCase(), decl[2].trim());
        continue;
      }

      const call = /^CALL FUNCTION\s+'([^']+)'/i.exec(line);
      if (call) {
        currentFn = call[1];
        section = "other";
        continue;
      }
      if (/^TABLES\s*$/i.test(line)) {
        section = "tables";
        continue;
      }
      if (/^(EXPORTING|IMPORTING|CHANGING|EXCEPTIONS)\s*$/i.test(line)) {
        section = "other";
        continue;
      }

      if (section === "tables") {
        const bind = /^(\w+)\s*=\s*(\w+)\s*\.?$/.exec(line);
        if (bind) {
          tablesBindings.push({ param: bind[1], variable: bind[2], fn: currentFn });
        }
        // A line ending the statement drops us out of the call entirely.
        if (line.endsWith(".")) section = "none";
      }
    }

    return { declarations, tablesBindings };
  };

  const isInternalTable = (declaredType: string) =>
    /\bTABLE\s+OF\b/i.test(declaredType) || /_TAB$/i.test(declaredType);

  const queries = [
    { label: "screen by tcode", q: { mode: "screen", target: { by: "tcode", tcode: "SE16" } } },
    {
      label: "screen by program/dynpro",
      q: { mode: "screen", target: { by: "program", program: "SAPLSETB", dynpro: "0230" } },
    },
    {
      label: "press",
      q: {
        mode: "press",
        tcode: "SE16",
        screens: [
          {
            program: "SAPLSETB",
            dynpro: "0230",
            okCode: "=SHOW",
            fields: [{ fieldName: "DATABROWSE-TABLENAME", value: "T000" }],
          },
        ],
      },
    },
  ] as const;

  for (const { label, q } of queries) {
    it(`${label}: every TABLES binding resolves to a declared internal table`, () => {
      const src = uiBridgeSource(q as never, "ZCL_ZMCP_UI_TEST");
      const { declarations, tablesBindings } = analyse(src);

      for (const { param, variable, fn } of tablesBindings) {
        const declaredType = declarations.get(variable.toUpperCase());
        expect(
          declaredType,
          `${fn} binds TABLES parameter ${param} to '${variable}', which has no DATA declaration in the ` +
            "generated source. A TABLES parameter must be bound to a declared internal table.",
        ).toBeDefined();
        expect(
          isInternalTable(declaredType as string),
          `${fn} binds TABLES parameter ${param} to '${variable}', declared 'TYPE ${declaredType}' — that ` +
            "is a STRUCTURE, not an internal table, and ABAP activation will fail with \"" +
            variable.toUpperCase() +
            ' is not an internal table". A TABLES parameter declared `LIKE <struct>` in the function ' +
            "signature types the ROW; the caller still needs `TYPE TABLE OF <struct>`.",
        ).toBe(true);
      }
    });
  }

  it("actually finds TABLES bindings to check (a guard that silently checks nothing is worse than none)", () => {
    const src = uiBridgeSource(
      { mode: "screen", target: { by: "tcode", tcode: "SE16" } } as never,
      "ZCL_ZMCP_UI_TEST",
    );
    const { tablesBindings } = analyse(src);
    // RPY_DYNPRO_READ contributes flow_logic + fields_list. RS_CUA_INTERNAL_FETCH
    // contributes sta/fun/men/mtx/act/but/pfk/set/doc/tit/biv (every TABLES
    // parameter in its signature except BIV is required — see the module
    // header on why a blank-STATUS RS_CUA_GET_STATUS call was replaced by
    // this two-step fetch). The per-status RS_CUA_GET_STATUS loop contributes
    // fkeys (status_list is gone: enumeration now comes from `sta`, not from
    // a blank-STATUS RS_CUA_GET_STATUS call). If the generator stops emitting
    // these, this test must fail rather than quietly pass over an empty list.
    expect(tablesBindings.map((b) => b.variable.toLowerCase()).sort()).toEqual([
      "lt_act",
      "lt_biv",
      "lt_but",
      "lt_doc",
      "lt_fields_list",
      "lt_fkeys",
      "lt_flow_logic",
      "lt_fun",
      "lt_men",
      "lt_mtx",
      "lt_pfk",
      "lt_set",
      "lt_sta",
      "lt_tit",
    ]);
  });

  it("every RS_CUA_INTERNAL_FETCH TABLES variable is declared TYPE STANDARD TABLE OF its RTTI-confirmed row structure (RSMPE_*)", () => {
    const src = uiBridgeSource(
      { mode: "screen", target: { by: "tcode", tcode: "SE16" } } as never,
      "ZCL_ZMCP_UI_TEST",
    );
    const { declarations } = analyse(src);
    const expected: Record<string, string> = {
      LT_STA: "rsmpe_stat",
      LT_FUN: "rsmpe_funt",
      LT_MEN: "rsmpe_men",
      LT_MTX: "rsmpe_mnlt",
      LT_ACT: "rsmpe_act",
      LT_BUT: "rsmpe_but",
      LT_PFK: "rsmpe_pfk",
      LT_SET: "rsmpe_staf",
      LT_DOC: "rsmpe_atrt",
      LT_TIT: "rsmpe_titt",
      LT_BIV: "rsmpe_buts",
    };
    for (const [variable, struct] of Object.entries(expected)) {
      const declaredType = declarations.get(variable);
      expect(declaredType, `${variable} must have a DATA declaration`).toBeDefined();
      expect(
        declaredType,
        `${variable} must be declared 'TYPE STANDARD TABLE OF ${struct}' — a bare 'TYPE ${struct}' would be ` +
          "the exact TABLES-types-the-row-not-the-table trap that already broke this module once.",
      ).toMatch(new RegExp(`^STANDARD TABLE OF ${struct}$`, "i"));
    }
  });

  it("caps the per-status RS_CUA_GET_STATUS loop at UI_STATUS_LOOP_CAP and reports done/total/capped via STATUS_LOOP", () => {
    const src = uiBridgeSource(
      { mode: "screen", target: { by: "tcode", tcode: "SE16" } } as never,
      "ZCL_ZMCP_UI_TEST",
    );
    expect(src).toContain(`IF lv_status_done >= ${UI_STATUS_LOOP_CAP}.`);
    expect(src).toContain("lv_status_capped = abap_true.");
    expect(src).toContain(
      `mo_out->write( |${UI_LINE_PREFIX}STATUS_LOOP done=[{ lv_status_done }] total=[{ lines( lt_sta ) }] capped=[{ lv_status_capped }]| ).`,
    );
  });

  it("the analyser rejects a structure bound to TABLES (negative control on the test itself)", () => {
    // Proves the invariant above would actually have caught the shipped bug,
    // rather than passing because the analyser found nothing to object to.
    const bad = [
      "    DATA lt_flow_logic TYPE rpy_dyflow.",
      "    CALL FUNCTION 'RPY_DYNPRO_READ'",
      "      TABLES",
      "        flow_logic = lt_flow_logic",
      "      EXCEPTIONS",
      "        OTHERS = 4.",
    ].join("\n");
    const { declarations, tablesBindings } = analyse(bad);
    expect(tablesBindings).toHaveLength(1);
    expect(isInternalTable(declarations.get("LT_FLOW_LOGIC") as string)).toBe(false);
  });
});
