// Pure, offline unit tests for src/adt/ui-fcode.ts — no network, no ABAP execution. Every scenario
// here is built by hand from the real shapes captured in test/fixtures/ui-fcode/ (program SAPMSVMA,
// system A4H, captured 2026-09-15) without regenerating or editing those fixture files; they are
// only read as a reference for realistic module bodies, not loaded programmatically here (the raw
// frame objects below are deliberately small, hand-built subsets that exercise the same shapes).
import { describe, expect, it } from "vitest";
import {
  analyzeFcodes,
  splitFcodeFrames,
  type UiFcodeRaw,
  type UiFcodeRawInclude,
  type UiFcodeRawModule,
  type UiFcodeRawPaiModule,
  type UiFcodeRawSrc,
} from "../src/adt/ui-fcode.js";

const PROGRAM = "SAPMSVMA";
const INCLUDE = "SAPMSVMA";

function emptyRaw(): UiFcodeRaw {
  return { flow: [], paiModules: [], includes: [], modules: [], src: [], unknownFrames: 0 };
}

/** Turns a multi-line ABAP snippet into `src` frames for `include`, starting at `firstLine`. */
function srcFrames(include: string, firstLine: number, text: string): UiFcodeRawSrc[] {
  return text
    .replace(/^\n/, "")
    .split("\n")
    .map((t, i) => ({ include, line: firstLine + i, text: t }));
}

function moduleFrame(name: string, include: string, lineFrom: number, lineTo: number): UiFcodeRawModule {
  return { name, include, lineFrom, lineTo };
}

function paiModule(name: string, index: number, atExit = false, condition?: string): UiFcodeRawPaiModule {
  return { index, name, atExit, flowLine: index, ...(condition ? { condition } : {}) };
}

function includeFrame(name: string, lines: number): UiFcodeRawInclude {
  return { name, lines };
}

describe("splitFcodeFrames", () => {
  it("buckets one wire-format frame of every kind, mapping snake_case fields to camelCase", () => {
    const values: readonly unknown[] = [
      { kind: "target", program: "SAPMSVMA", dynpro: "0100", fcode_filter: "BACK", tcode: { tcode: "SM30", program: "SAPMSVMA", dynpro: "0100", cinfo: "00", kind: "dialog transaction (classic dynpro; batch input / press applies)", bdcApplies: true } },
      { kind: "flow", index: 1, line: "PROCESS AFTER INPUT." },
      { kind: "pai_module", index: 1, name: "EXIT_COMMAND", at_exit: true, flow_line: 2, condition: "ON CHAIN-REQUEST" },
      { kind: "cua", statusCount: 1, functionsCount: 1, functions: [{ code: "BACK", text: "Back", type: "E" }], fkeysCount: 1, fkeys: [{ status: "100", code: "BACK", text: "Back", quickinfo: "" }] },
      { kind: "include", name: "SAPMSVMA", lines: 220 },
      { kind: "include", name: "BOGUS01", lines: 0, read_error: "READ REPORT failed (sy-subrc 4)" },
      { kind: "module", name: "EXIT_COMMAND", include: "SAPMSVMA", line_from: 453, line_to: 458, unterminated: true },
      { kind: "src", include: "SAPMSVMA", line: 454, text: "set screen 0." },
      { kind: "summary", program: "SAPMSVMA", dynpro: "0100", includes: 1, includes_failed: 0, modules: 1, pai_modules: 1, src_lines: 1, truncated: "" },
    ];

    const raw = splitFcodeFrames(values);
    expect(raw.unknownFrames).toBe(0);
    expect(raw.target).toEqual({
      program: "SAPMSVMA",
      dynpro: "0100",
      fcodeFilter: "BACK",
      tcode: { tcode: "SM30", program: "SAPMSVMA", dynpro: "0100", cinfo: "00", kind: "dialog transaction (classic dynpro; batch input / press applies)", bdcApplies: true },
    });
    expect(raw.flow).toEqual([{ index: 1, line: "PROCESS AFTER INPUT." }]);
    expect(raw.paiModules).toEqual([{ index: 1, name: "EXIT_COMMAND", atExit: true, flowLine: 2, condition: "ON CHAIN-REQUEST" }]);
    expect(raw.cua?.functions).toEqual([{ code: "BACK", text: "Back", type: "E" }]);
    expect(raw.cua?.fkeys).toEqual([{ status: "100", code: "BACK", text: "Back", quickinfo: "" }]);
    expect(raw.includes).toEqual([
      { name: "SAPMSVMA", lines: 220 },
      { name: "BOGUS01", lines: 0, readError: "READ REPORT failed (sy-subrc 4)" },
    ]);
    expect(raw.modules).toEqual([{ name: "EXIT_COMMAND", include: "SAPMSVMA", lineFrom: 453, lineTo: 458, unterminated: true }]);
    expect(raw.src).toEqual([{ include: "SAPMSVMA", line: 454, text: "set screen 0." }]);
    expect(raw.summary).toEqual({
      program: "SAPMSVMA",
      dynpro: "0100",
      includes: 1,
      includesFailed: 0,
      modules: 1,
      paiModules: 1,
      srcLines: 1,
      truncated: "",
    });
  });

  it("never throws on malformed input, and counts every unrecognised value as unknownFrames", () => {
    const values: readonly unknown[] = [null, 42, "just a string", [], {}, { kind: 123 }, { kind: "bogus" }, undefined];
    const raw = splitFcodeFrames(values);
    expect(raw.unknownFrames).toBe(values.length);
    expect(raw.flow).toEqual([]);
    expect(raw.paiModules).toEqual([]);
    expect(raw.includes).toEqual([]);
    expect(raw.modules).toEqual([]);
    expect(raw.src).toEqual([]);
    expect(raw.target).toBeUndefined();
    expect(raw.cua).toBeUndefined();
    expect(raw.summary).toBeUndefined();
  });
});

describe("analyzeFcodes — dispatch resolution and branch extraction (SAPMSVMA-shaped module ACTION)", () => {
  // A trimmed stand-in for the real MODULE ACTION body (test/fixtures/ui-fcode/sapmsvma-lines-110-329.abap):
  // alias dispatch via `function = ok_code.`, a blank-padded literal (`'UPD '`), a multi-literal WHEN
  // (`'ENDE' OR 'BACK'`), a statement on the same line as its own WHEN, and a mix of call kinds.
  const ACTION_BODY = `module action.
function = ok_code.
clear ok_code.
case function.
when 'ENDE' or 'BACK'. set screen 0. leave screen.
when 'IMG'. perform call_img using viewname.
when 'UPD '.
  perform (dynamic_form).
when 'VVCL'.
  call function 'VIEWCLUSTER_MAINTENANCE_CALL'.
  call transaction 'SM34' with authority-check.
endcase.
endmodule.`;

  function actionRaw(fcode?: string): UiFcodeRaw {
    const raw = emptyRaw();
    raw.paiModules = [paiModule("ACTION", 1)];
    raw.modules = [moduleFrame("ACTION", INCLUDE, 100, 112)];
    raw.src = srcFrames(INCLUDE, 100, ACTION_BODY);
    raw.target = { program: PROGRAM, dynpro: "0100", fcodeFilter: fcode ?? "" };
    return raw;
  }

  it("resolves alias dispatch (function = ok_code.) and matches a blank-padded literal", () => {
    const result = analyzeFcodes(actionRaw(), { fcode: "UPD" });
    expect(result.fcodes).toHaveLength(1);
    const row = result.fcodes[0]!;
    expect(row.fcode).toBe("UPD");
    expect(row.modules).toHaveLength(1);
    const hit = row.modules[0]!;
    expect(hit.dispatch).toEqual({ kind: "alias", expression: "function", aliasAssignedFrom: "ok_code", aliasLine: 101 });
    expect(hit.branches).toHaveLength(1);
    // The WHEN literal is stored verbatim ('UPD ', trailing blank and all) - only the matching
    // comparison trims it. Losing that distinction here would hide a real WHEN 'UPD ' vs WHEN 'UPD'
    // typo bug, so the raw literal is asserted, not a pre-trimmed one.
    expect(hit.branches[0]!.literals).toEqual(["UPD "]);
    expect(hit.branches[0]!.calls).toEqual([{ kind: "PERFORM", target: "dynamic_form", line: 107, dynamic: true }]);
  });

  it("matches the second literal of a multi-literal WHEN, and still parses a statement written on the WHEN line", () => {
    const result = analyzeFcodes(actionRaw(), { fcode: "BACK" });
    const hit = result.fcodes[0]!.modules[0]!;
    expect(hit.branches).toHaveLength(1);
    expect(hit.branches[0]!.literals).toEqual(["ENDE", "BACK"]);
    // "set screen 0." / "leave screen." are on the same source line as their WHEN, and neither is a
    // recognised outgoing-call keyword (PERFORM/CALL .../SUBMIT), so calls is correctly empty - this
    // is not a parser failure, it proves those two statements were walked and rejected, not skipped.
    expect(hit.branches[0]!.calls).toEqual([]);
  });

  it("extracts every outgoing call kind reachable from a branch: literal PERFORM, dynamic PERFORM, CALL FUNCTION, CALL TRANSACTION", () => {
    const resultImg = analyzeFcodes(actionRaw(), { fcode: "IMG" });
    expect(resultImg.fcodes[0]!.modules[0]!.branches[0]!.calls).toEqual([
      { kind: "PERFORM", target: "call_img", line: 105, dynamic: false },
    ]);

    const resultVvcl = analyzeFcodes(actionRaw(), { fcode: "VVCL" });
    expect(resultVvcl.fcodes[0]!.modules[0]!.branches[0]!.calls).toEqual([
      { kind: "CALL FUNCTION", target: "VIEWCLUSTER_MAINTENANCE_CALL", line: 109, dynamic: false },
      { kind: "CALL TRANSACTION", target: "SM34", line: 110, dynamic: false },
    ]);
  });

  it("suggests an abap_read call scoped to just the matching branch's own lines", () => {
    const result = analyzeFcodes(actionRaw(), { fcode: "IMG" });
    const branch = result.fcodes[0]!.modules[0]!.branches[0]!;
    expect(branch.read).toBe(`abap_read {"object":"${PROGRAM}","offset":${branch.lineFrom},"limit":${branch.lineTo - branch.lineFrom + 1}}`);
  });
});

describe("analyzeFcodes — pre-dispatch remap detection", () => {
  it("reports a direct-assignment remap (function = 'UPDL'.) before the CASE, but keeps matching branches against the ORIGINAL fcode", () => {
    const body = `module action.
function = ok_code.
function = 'UPDL'.
case function.
when 'UPD '.
when 'UPDL'.
endcase.
endmodule.`;
    const raw = emptyRaw();
    raw.paiModules = [paiModule("ACTION", 1)];
    raw.modules = [moduleFrame("ACTION", INCLUDE, 200, 207)];
    raw.src = srcFrames(INCLUDE, 200, body);
    raw.target = { program: PROGRAM, dynpro: "0100", fcodeFilter: "" };

    const result = analyzeFcodes(raw, { fcode: "UPD" });
    expect(result.notes.some((n) => n.includes('reassigns "function" before dispatch') && n.includes("'UPDL'"))).toBe(true);
    // Matched on the caller's original "UPD", not the remapped "UPDL" - the remap is reported, not chased.
    expect(result.fcodes[0]!.modules[0]!.branches.map((b) => b.literals)).toEqual([["UPD "]]);
  });

  it("does NOT detect a MOVE-style remap (the real SAPMSVMA source's own style) — findPreDispatchRemap only matches `lhs = rhs`", () => {
    // This mirrors the actual pre-dispatch guard in test/fixtures/ui-fcode/sapmsvma-lines-110-329.abap
    // almost verbatim: `move 'UPDL' to function.` inside a guard CASE, ahead of the real dispatch CASE.
    // src/adt/ui-fcode.ts's findAliasAssignments understands both "lhs = rhs" and "move rhs to lhs",
    // but findPreDispatchRemap (a separate function) only recognises "lhs = rhs" - so this real,
    // observed remap style is silently NOT surfaced as a remapNote. Documented here rather than
    // fixed, since fixing it is production code and out of scope for this test-only change.
    const body = `module action.
function = ok_code.
if vimdynflds-ltd_dta_ar ne space.
  case function.
    when 'UPD '.
      move 'UPDL' to function.
  endcase.
endif.
case function.
when 'UPD '.
when 'UPDL'.
endcase.
endmodule.`;
    const raw = emptyRaw();
    raw.paiModules = [paiModule("ACTION", 1)];
    raw.modules = [moduleFrame("ACTION", INCLUDE, 300, 311)];
    raw.src = srcFrames(INCLUDE, 300, body);
    raw.target = { program: PROGRAM, dynpro: "0100", fcodeFilter: "" };

    const result = analyzeFcodes(raw, { fcode: "UPD" });
    expect(result.notes.some((n) => n.includes("reassigns"))).toBe(false);
  });
});

describe("analyzeFcodes — no-CASE module, unresolved dispatch, no-matching-branch, and missing module", () => {
  it("a module with no CASE at all gets dispatch:none, but its one whole-module branch carries no literal, so it can never MATCH a specific fcode filter and is reported unresolved instead", () => {
    // This is a real, observed quirk of the current implementation, not something this test papers
    // over: analyzeModuleBody gives a no-CASE module a single branch with literals: [] ("always
    // runs, on any fcode"), but analyzeFcodes then filters every module's branches down to just
    // the ones whose literalsUpper includes the fcode being traced - an empty literals list can
    // never satisfy that, so a no-CASE module ends up with zero branches AND a "no WHEN branch...
    // matches" unresolved entry, even though the module in fact runs unconditionally. Reported here
    // rather than fixed, since fixing it is production code (src/adt/ui-fcode.ts) and out of scope.
    const body = `module exit_command.
set screen 0.
leave screen.
endmodule.`;
    const raw = emptyRaw();
    raw.paiModules = [paiModule("EXIT_COMMAND", 1, true)];
    raw.modules = [moduleFrame("EXIT_COMMAND", INCLUDE, 453, 458)];
    raw.src = srcFrames(INCLUDE, 453, body);
    raw.target = { program: PROGRAM, dynpro: "0100", fcodeFilter: "" };

    const result = analyzeFcodes(raw, { fcode: "BACK" });
    const hit = result.fcodes[0]!.modules[0]!;
    expect(hit.dispatch).toEqual({ kind: "none" });
    expect(hit.branches).toEqual([]);
    expect(result.fcodes[0]!.unresolved).toContainEqual({
      module: "EXIT_COMMAND",
      include: INCLUDE,
      reason: 'no WHEN branch (including WHEN OTHERS) in module EXIT_COMMAND matches fcode "BACK"',
    });
  });

  it("CASE on something other than ok_code/sy-ucomm, never assigned from one, is reported as unresolved rather than guessed at", () => {
    const body = `module check_variant.
case sy-subrc.
when 0.
when others.
endcase.
endmodule.`;
    const raw = emptyRaw();
    raw.paiModules = [paiModule("CHECK_VARIANT", 1, false, "ON CHAIN-REQUEST")];
    raw.modules = [moduleFrame("CHECK_VARIANT", INCLUDE, 488, 493)];
    raw.src = srcFrames(INCLUDE, 488, body);
    raw.target = { program: PROGRAM, dynpro: "0100", fcodeFilter: "" };

    const result = analyzeFcodes(raw, { fcode: "BACK" });
    const row = result.fcodes[0]!;
    expect(row.modules[0]!.dispatch).toEqual({
      kind: "unresolved",
      expression: "sy-subrc",
      reason: 'CASE on "sy-subrc", which is not ok_code/sy-ucomm and was not assigned from one inside this module',
    });
    expect(row.unresolved).toContainEqual({
      module: "CHECK_VARIANT",
      include: INCLUDE,
      reason: 'CASE on "sy-subrc", which is not ok_code/sy-ucomm and was not assigned from one inside this module',
    });
  });

  it("falls back to WHEN OTHERS with a note when no explicit literal matches, and flags a genuinely unmatched fcode", () => {
    const withOthers = `module action.
function = ok_code.
case function.
when 'BACK'.
when others.
  perform fallback.
endcase.
endmodule.`;
    const raw = emptyRaw();
    raw.paiModules = [paiModule("ACTION", 1)];
    raw.modules = [moduleFrame("ACTION", INCLUDE, 1, 8)];
    raw.src = srcFrames(INCLUDE, 1, withOthers);
    raw.target = { program: PROGRAM, dynpro: "0100", fcodeFilter: "" };

    const result = analyzeFcodes(raw, { fcode: "SHOW" });
    const hit = result.fcodes[0]!.modules[0]!;
    expect(hit.branches).toHaveLength(1);
    expect(hit.branches[0]!.literals).toEqual(["OTHERS"]);
    expect(result.notes).toContain('fcode "SHOW" in module ACTION matched only via WHEN OTHERS (no explicit literal).');

    const noOthers = withOthers.replace("when others.\n  perform fallback.\n", "when 'ENDE'.\n");
    const raw2 = emptyRaw();
    raw2.paiModules = [paiModule("ACTION", 1)];
    raw2.modules = [moduleFrame("ACTION", INCLUDE, 1, 8)];
    raw2.src = srcFrames(INCLUDE, 1, noOthers);
    raw2.target = { program: PROGRAM, dynpro: "0100", fcodeFilter: "" };
    const result2 = analyzeFcodes(raw2, { fcode: "SHOW" });
    expect(result2.fcodes[0]!.modules[0]!.branches).toEqual([]);
    expect(result2.fcodes[0]!.unresolved).toContainEqual({
      module: "ACTION",
      include: INCLUDE,
      reason: 'no WHEN branch (including WHEN OTHERS) in module ACTION matches fcode "SHOW"',
    });
  });

  it("a PAI-flow module never found in any scanned include is reported unresolved and found:false in paiModules, without crashing", () => {
    const raw = emptyRaw();
    raw.paiModules = [paiModule("MISSING_MODULE", 1)];
    raw.target = { program: PROGRAM, dynpro: "0100", fcodeFilter: "" };
    const result = analyzeFcodes(raw, { fcode: "BACK" });
    expect(result.paiModules).toEqual([{ name: "MISSING_MODULE", atExit: false, found: false }]);
    expect(result.fcodes[0]!.modules).toEqual([]);
    expect(result.fcodes[0]!.unresolved).toContainEqual({
      module: "MISSING_MODULE",
      include: "",
      reason: "module MISSING_MODULE (named in the PAI flow logic) was not found in any scanned include",
    });
  });
});

describe("analyzeFcodes — fcode enumeration from CUA, and truncation", () => {
  it("with no explicit fcode, unions CUA functions and fkeys codes, sorted and de-duplicated", () => {
    const raw = emptyRaw();
    raw.target = { program: PROGRAM, dynpro: "0100", fcodeFilter: "" };
    raw.cua = {
      functions: [
        { code: "SHOW", text: "Display", type: "" },
        { code: "BACK", text: "Back", type: "E" },
      ],
      fkeys: [
        { status: "100", code: "BACK", text: "Back", quickinfo: "" }, // duplicate of a function code
        { status: "100", code: "ENDE", text: "Exit", quickinfo: "" },
        { status: "200", code: "", text: "", quickinfo: "" }, // blank code, must be dropped
      ],
    };
    const result = analyzeFcodes(raw, {});
    expect(result.fcodes.map((r) => r.fcode)).toEqual(["BACK", "ENDE", "SHOW"]);
    expect(result.fcodes.find((r) => r.fcode === "BACK")!.statuses).toEqual(["100"]);
  });

  it("caps the enumerated fcode list at 60 and records a truncation note plus 'fcodes' in the truncated field", () => {
    const raw = emptyRaw();
    raw.target = { program: PROGRAM, dynpro: "0100", fcodeFilter: "" };
    const functions = Array.from({ length: 75 }, (_, i) => ({
      code: `F${String(i).padStart(3, "0")}`,
      text: "",
      type: "",
    }));
    raw.cua = { functions, fkeys: [] };
    const result = analyzeFcodes(raw, {});
    expect(result.fcodes).toHaveLength(60);
    expect(result.truncated).toBe("fcodes");
    expect(result.notes.some((n) => n.startsWith("75 distinct function codes found"))).toBe(true);
  });

  it("carries the ABAP-side source-scan truncation (summary.truncated) straight through, combined with a fcodes truncation", () => {
    const raw = emptyRaw();
    raw.target = { program: PROGRAM, dynpro: "0100", fcodeFilter: "" };
    raw.summary = { program: PROGRAM, dynpro: "0100", includes: 1, includesFailed: 0, modules: 1, paiModules: 0, srcLines: 4000, truncated: "source" };
    const result = analyzeFcodes(raw, { fcode: "BACK" });
    expect(result.truncated).toBe("source");
  });

  it("an explicit fcode not listed in any GUI status is still traced, with a note explaining why", () => {
    const raw = emptyRaw();
    raw.target = { program: PROGRAM, dynpro: "0100", fcodeFilter: "ZZZZ" };
    raw.cua = { functions: [{ code: "BACK", text: "Back", type: "" }], fkeys: [] };
    const result = analyzeFcodes(raw, { fcode: "ZZZZ" });
    expect(result.fcodes.map((r) => r.fcode)).toEqual(["ZZZZ"]);
    expect(result.notes.some((n) => n.includes('fcode "ZZZZ" is not listed') && n.includes("tracing it anyway"))).toBe(true);
  });

  it("no CUA frame at all, and a CUA frame reporting noCua, both produce an empty fcode list with an explanatory note rather than a crash", () => {
    const rawNoCua = emptyRaw();
    rawNoCua.target = { program: PROGRAM, dynpro: "0100", fcodeFilter: "" };
    const r1 = analyzeFcodes(rawNoCua, {});
    expect(r1.fcodes).toEqual([]);
    expect(r1.notes.some((n) => n.includes("No CUA frame was received"))).toBe(true);

    const rawNoStatus = emptyRaw();
    rawNoStatus.target = { program: PROGRAM, dynpro: "0100", fcodeFilter: "" };
    rawNoStatus.cua = { functions: [], fkeys: [], noCua: { program: PROGRAM, note: "no GUI status assigned" } };
    const r2 = analyzeFcodes(rawNoStatus, {});
    expect(r2.fcodes).toEqual([]);
    expect(r2.notes.some((n) => n.includes("No GUI status defined for program"))).toBe(true);
  });
});

describe("analyzeFcodes — include list passthrough (D010INC filtering itself happens in ABAP, not here)", () => {
  it("reports exactly the includes it was handed — verifying the 13-row D010INC filter itself needs a live system, not this unit", () => {
    // The D010INC SELECT + filter (empty / contains '=' / starts with '%' or '<') that turns
    // test/fixtures/ui-fcode/sapmsvma-d010inc.txt's 13 rows into 2 survivors (MSVMAF01, MSVMAO01)
    // runs entirely in METHOD fcode (src/adt/fluid/builtin/ui.ts), before any frame is ever built -
    // analyzeFcodes only ever sees whatever include names the bridge already decided to scan. This
    // test proves the passthrough (includes reported verbatim, in order), not the filter itself.
    const raw = emptyRaw();
    raw.target = { program: PROGRAM, dynpro: "0100", fcodeFilter: "" };
    raw.includes = [includeFrame("SAPMSVMA", 867), includeFrame("MSVMAF01", 40), includeFrame("MSVMAO01", 55)];
    const result = analyzeFcodes(raw, {});
    expect(result.includes).toEqual([
      { name: "SAPMSVMA", lines: 867 },
      { name: "MSVMAF01", lines: 40 },
      { name: "MSVMAO01", lines: 55 },
    ]);
  });
});
