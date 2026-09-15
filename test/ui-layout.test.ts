/**
 * Tests for `src/tools/ui-layout.ts` — the `abap_ui mode=screen layout:true`
 * monospace design-time picture, rendered client-side from the `FIELD` rows
 * `abap_ui screen` already read.
 *
 * Every fixture below is transcribed BY HAND from one of three verbatim
 * `abap_ui mode=screen` captures taken live against A4H (client 001, user
 * DEVELOPER, 2026-09-15), saved at:
 *   - /tmp/i113-captures/rsusr002-1000.txt   (RSUSR002 1000 — a classic
 *     selection screen: frames, checkboxes, select-options, a tabstrip, a
 *     subscreen area, an OK-code pseudo-field)
 *   - /tmp/i113-captures/sapmsyst-0020.txt   (SAPMSYST 0020 — the standard
 *     logon screen: a real design-time STATIC TEXT label and, in the SNC
 *     multi-user picker, the only live TABLE CONTROL among the three
 *     captures)
 *   - /tmp/i113-captures/zui_i113_probe-1000.txt (a purpose-built probe
 *     screen: frames, a checkbox, two radio buttons, pushbuttons — but, on
 *     inspection, no fill=T table control and no fill=B subscreen area; see
 *     the per-fixture comments below for where each element kind actually
 *     came from)
 *
 * Per D021S, RAW(1)/RAW(2) columns (LINE, COLN, LENG, FLG1, FLG2, FLG3,
 * FMB1, FMB2, LANF, LBLK, LREP, AGLT, ADEZ, DIDX) arrive as UPPERCASE HEX
 * STRINGS; RPY_DYHEAD's `lines`/`columns` are DECIMAL strings. Every
 * fixture row below is copied verbatim (the hex strings as captured); every
 * expected grid position is computed from those hex values in a comment
 * next to the fixture, base 16, exactly as `src/tools/ui-layout.ts` itself
 * decodes them.
 *
 * Grid indexing: 1-based `line`/`coln` -> 0-based grid index via
 * `idx(n) = n === 0 ? 0 : n - 1` (see ui-layout.ts's own `idx`). All row/col
 * indices in comments below are already 0-based grid coordinates.
 *
 * `noUncheckedIndexedAccess` is on, so every line lookup goes through
 * `lines[i] ?? ""` — an out-of-range index then fails the assertion instead
 * of the type check.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { renderScreenLayout, LAYOUT_FIDELITY_NOTE, type ScreenLayoutInput, type ScreenFieldRow } from "../src/tools/ui-layout.js";
import { uiInputSchema } from "../src/tools/ui.js";

function lineAt(result: string, i: number): string {
  return result.split("\n")[i] ?? "";
}

// ---------------------------------------------------------------------------
// Selection screen — rsusr002-1000.txt (RSUSR002 1000)
// ---------------------------------------------------------------------------

describe("renderScreenLayout: selection screen", () => {
  // rsusr002-1000.txt, "--- HEADER (RPY_DYNPRO_READ) ---":
  //   lines=[200] columns=[120]  (RPY_DYHEAD decimal fields)
  const RSUSR002_HEADER: Readonly<Record<string, string>> = { lines: "200", columns: "120" };

  // rsusr002-1000.txt FIELDS: name=[T_USER] ... fill=[] leng=[1B] line=[02]
  // coln=[04] ... flg1=[80] grp3=[COF] stxt=[___________________________]
  // (27 underscores). leng 0x1B = 27; line 0x02 = 2 -> row idx 1; coln
  // 0x04 = 4 -> col idx 3. flg1 0x80: bit 0x80 IS set (branch 1 — STATIC
  // TEXT — does not apply); grp3 "COF" is not in {TXT,COM,TOT} (branch 2
  // does not apply); stxt is present and all "_" (branch 3 applies) ->
  // an I/O field mask, (flg1 & 0x21) = (0x80 & 0x21) = 0 -> editable, "_".
  const T_USER: ScreenFieldRow = {
    fnam: "T_USER",
    fill: "",
    leng: "1B",
    line: "02",
    coln: "04",
    flg1: "80",
    grp3: "COF",
    stxt: "___________________________",
  };

  it("renders an I/O field as a run of underscores as wide as leng, and reports a grid line count between the largest drawn line and RPY_DYHEAD.lines", () => {
    const input: ScreenLayoutInput = { header: RSUSR002_HEADER, fields: [T_USER], fkeys: [] };
    const result = renderScreenLayout(input);
    const row1 = lineAt(result, 1); // 0x02 -> idx 1
    expect(row1.slice(3, 3 + 27)).toBe("_".repeat(27));

    // The grid section is everything before the blank/"Buttons"/blank
    // separator ui-layout.ts appends; with no fkeys that separator starts
    // at "Buttons: (no GUI status buttons)". T_USER is the only drawn
    // element (line 2, 1-based) and there's nothing past it, so trailing
    // blank rows (including row 0) up to line 2 are NOT trimmed (only
    // TRAILING blanks are popped) — the grid section is exactly 2 rows.
    const buttonsLineIdx = result.split("\n").findIndex((l) => l.startsWith("Buttons"));
    const gridLineCount = buttonsLineIdx - 1; // drop the blank separator line right before "Buttons"
    expect(gridLineCount).toBeLessThanOrEqual(200); // <= RPY_DYHEAD.lines
    expect(gridLineCount).toBeGreaterThanOrEqual(2); // >= the largest drawn line (T_USER, line 2)
  });

  // rsusr002-1000.txt FIELDS:
  // name=[%_USER_%_APP_%-OPTI_PUSH] fill=[] leng=[28] line=[02] coln=[20]
  // flg1=[81] grp3=[OPU] stxt=[40 underscores]
  // leng 0x28 = 40; line 0x02 = 2 -> row idx 1; coln 0x20 = 32 -> col idx 31.
  // flg1 0x81 & 0x21 = 0x01 (bit 0x20 set, bit 0x01 clear) -> "output-only,
  // input clear" -> dots, not underscores. This is a LIVE row, not
  // synthesised: rsusr002-1000.txt genuinely contains an output-only field.
  const OPTI_PUSH: ScreenFieldRow = {
    fnam: "%_USER_%_APP_%-OPTI_PUSH",
    fill: "",
    leng: "28",
    line: "02",
    coln: "20",
    flg1: "81",
    grp3: "OPU",
    stxt: "________________________________________",
  };

  it("renders an output-only field as a run of dots as wide as leng (live row: rsusr002-1000.txt, %_USER_%_APP_%-OPTI_PUSH)", () => {
    const input: ScreenLayoutInput = { header: RSUSR002_HEADER, fields: [OPTI_PUSH], fkeys: [] };
    const result = renderScreenLayout(input);
    const row1 = lineAt(result, 1); // 0x02 -> idx 1
    expect(row1.slice(31, 31 + 40)).toBe(".".repeat(40));
  });

  // rsusr002-1000.txt FIELDS: name=[P_SELSHW] fill=[C] line=[25] coln=[04]
  // line 0x25 = 37 -> row idx 36; coln 0x04 = 4 -> col idx 3.
  const P_SELSHW: ScreenFieldRow = {
    fnam: "P_SELSHW",
    fill: "C",
    leng: "01",
    line: "25",
    coln: "04",
    flg1: "80",
    grp3: "PAR",
    stxt: "_",
  };

  it("renders a checkbox as `[ ]` followed by its decoded label (live row: rsusr002-1000.txt, P_SELSHW — stxt is a single `_`, which decodeStxt reduces to \"\", so the label falls back to fnam)", () => {
    const input: ScreenLayoutInput = { header: RSUSR002_HEADER, fields: [P_SELSHW], fkeys: [] };
    const result = renderScreenLayout(input);
    const row = lineAt(result, 36); // 0x25 -> idx 36
    expect(row.slice(3, 3 + "[ ] P_SELSHW".length)).toBe("[ ] P_SELSHW");
  });

  // SYNTHESISED: rsusr002-1000.txt has no fill=A row at all (grep of its
  // FIELDS section confirms — this selection screen has checkboxes and
  // select-options but no radio-button group). Shaped after the live P_R1/
  // P_R2 rows in zui_i113_probe-1000.txt (fill=[A] leng=[01]), placed at an
  // otherwise-unused line/coln so this single-row fixture can't collide
  // with anything.
  const SYNTH_RADIO: ScreenFieldRow = {
    fnam: "ZSYNTH_RADIO",
    fill: "A",
    leng: "01",
    line: "0A", // 0x0A = 10 -> row idx 9
    coln: "04", // 0x04 = 4 -> col idx 3
    flg1: "80",
    grp3: "PAR",
    stxt: "_",
  };

  it("renders a radio button as `( )` followed by its decoded label (synthesised row: rsusr002-1000.txt has no live fill=A row; shaped after zui_i113_probe-1000.txt's P_R1/P_R2 — stxt is a single `_`, which decodeStxt reduces to \"\", so the label falls back to fnam)", () => {
    const input: ScreenLayoutInput = { header: RSUSR002_HEADER, fields: [SYNTH_RADIO], fkeys: [] };
    const result = renderScreenLayout(input);
    const row = lineAt(result, 9); // 0x0A -> idx 9
    expect(row.slice(3, 3 + "( ) ZSYNTH_RADIO".length)).toBe("( ) ZSYNTH_RADIO");
  });

  // fill=C with no decoded label text at all (empty stxt, not even "_"
  // padding) — must fall back to fnam, mirroring the `P` branch's
  // `t || fnam` convention.
  const NO_LABEL_CHECKBOX: ScreenFieldRow = {
    fnam: "ZNO_LABEL_CB",
    fill: "C",
    leng: "01",
    line: "0B", // 0x0B = 11 -> row idx 10
    coln: "04",
    flg1: "80",
    grp3: "PAR",
    stxt: "",
  };

  it("falls back to the field name when a checkbox has no label text", () => {
    const input: ScreenLayoutInput = { header: RSUSR002_HEADER, fields: [NO_LABEL_CHECKBOX], fkeys: [] };
    const result = renderScreenLayout(input);
    const row = lineAt(result, 10); // 0x0B -> idx 10
    expect(row.slice(3, 3 + "[ ] ZNO_LABEL_CB".length)).toBe("[ ] ZNO_LABEL_CB");
  });

  // rsusr002-1000.txt FIELDS:
  // name=[T_STAND] fill=[R] leng=[76] line=[01] coln=[02] stxt=[118 "_"]
  // name=[T_BCR]   fill=[R] leng=[76] line=[06] coln=[02] stxt=[118 "_"]
  // leng 0x76 = 118 for both. T_STAND: line 0x01 = 1 -> row idx 0, coln
  // 0x02 = 2 -> col idx 1. T_BCR: line 0x06 = 6.
  // Both frames' stxt is entirely "_" so decodeStxt(stxt) === "" and the
  // title falls back to `fnam` (frameBox: `decodeStxt(...) || fnam`) — so
  // T_STAND's box title is literally "T_STAND".
  // resolveFrameBottom(topLine=1, frameLines=[1,6], maxDrawnLine=6): the
  // next frame line > 1 is 6, so T_STAND's bottom = 6 - 1 = 5 -> interior
  // rows are grid lines idx(2)..idx(4) = rows 1,2,3 (loop `l` from
  // topLine+1=2 to bottomLine=5 exclusive).
  const T_STAND: ScreenFieldRow = {
    fnam: "T_STAND",
    fill: "R",
    leng: "76",
    line: "01",
    coln: "02",
    flg1: "80",
    grp3: "BLK",
    stxt: "_".repeat(118),
  };
  const T_BCR: ScreenFieldRow = {
    fnam: "T_BCR",
    fill: "R",
    leng: "76",
    line: "06",
    coln: "02",
    flg1: "80",
    grp3: "BLK",
    stxt: "_".repeat(118),
  };

  it("draws a frame as a box of +/-/| with the title on the top edge, and a | at the frame's left column on an interior line (live rows: rsusr002-1000.txt, T_STAND + T_BCR)", () => {
    const input: ScreenLayoutInput = { header: RSUSR002_HEADER, fields: [T_STAND, T_BCR], fkeys: [] };
    const result = renderScreenLayout(input);
    const topEdge = lineAt(result, 0); // 0x01 -> idx 0
    // The box's left edge sits at the frame's own column (coln=2 -> idx 1,
    // per the module's real left-edge placement), not at absolute column
    // 0 of the line — column 0 is left blank. Asserted here against that
    // offset rather than a `^` anchor.
    expect(topEdge[1]).toBe("+");
    expect(topEdge.slice(1)).toMatch(/^\+-.*-\+$/);
    expect(topEdge).toContain("T_STAND");

    const interior = lineAt(result, 1); // one of rows 1..3, all interior
    expect(interior[1]).toBe("|"); // left column, idx(coln=2) = 1
  });

  // Live row again: rsusr002-1000.txt, name=[%_17SNS0000581068_%_%_%_%_%_%_]
  // fill=[] flg1=[00] grp3=[] line=[29] coln=[02] stxt=[-]. flg1 0x00 & 0x80
  // = 0 -> branch 1 (STATIC TEXT) applies; decodeStxt("-") = "-" (no
  // leading "@", no trailing "_", no embedded "_") — a genuine non-empty
  // design-time literal. It's the ONLY row in this capture that hits
  // branch 1 with non-empty text: every other empty-fill row here either
  // has flg1 bit 0x80 set (falls through to the I/O-field/output-only
  // branches, both already covered above) or is itself all "_"; real
  // selection-screen prose labels (grp3 TXT/COM/TOT) are filled at PBO and
  // are blank in D021S (see the "never drops" test below). So the only
  // honest "real text label" this capture offers is this decorative
  // separator dash — used here rather than invented.
  // line 0x29 = 41 -> row idx 40; coln 0x02 = 2 -> col idx 1.
  const DASH_LABEL: ScreenFieldRow = {
    fnam: "%_17SNS0000581068_%_%_%_%_%_%_",
    fill: "",
    leng: "01",
    line: "29",
    coln: "02",
    flg1: "00",
    grp3: "",
    stxt: "-",
  };

  it("places a static-text label at its 1-based line/column (live row: rsusr002-1000.txt, %_17SNS0000581068_%_%_%_%_%_%_, decoded text '-')", () => {
    const input: ScreenLayoutInput = { header: RSUSR002_HEADER, fields: [DASH_LABEL], fkeys: [] };
    const result = renderScreenLayout(input);
    const row = lineAt(result, 40); // 0x29 -> idx 40
    expect(row.slice(1, 2)).toBe("-"); // coln 0x02 -> idx 1
  });

  // Live row, but from zui_i113_probe-1000.txt, not rsusr002: grepping
  // rsusr002-1000.txt's FIELDS section for a row that (a) has flg1 bit
  // 0x80 SET (so branch 1, STATIC TEXT, does not fire) and (b) has grp3
  // outside {TXT,COM,TOT} is-not-all-"_" (so it doesn't fall into the I/O/
  // output-only mask branches) and decodes to empty text turns up nothing
  // — this selection screen's own "TXT" rows don't exist and its blank
  // rows are all underscore masks. The probe capture DOES have exactly
  // this shape: name=[%_P_KUNNR_%_APP_%-TEXT] flg1=[80] grp3=[TXT]
  // stxt=[30 "_"] — a selection-screen label whose real text is filled at
  // PBO from the text pool (see ui-layout.ts's own module doc), blank here.
  // decodeStxt of 30 "_" strips the whole trailing run -> "" -> falls back
  // to `?<fnam>?`. line=[02] -> hex 2 -> row idx 1; coln=[04] -> hex 4 ->
  // col idx 3.
  const PROBE_BLANK_TXT: ScreenFieldRow = {
    fnam: "%_P_KUNNR_%_APP_%-TEXT",
    fill: "",
    leng: "1E",
    line: "02",
    coln: "04",
    flg1: "80",
    grp3: "TXT",
    stxt: "_".repeat(30),
  };

  it("never drops an element: a row whose decoded text is empty renders as ?<fnam>? (live row from zui_i113_probe-1000.txt, not rsusr002 — see comment: rsusr002's own FIELDS have no row that hits this exact path)", () => {
    const input: ScreenLayoutInput = { header: RSUSR002_HEADER, fields: [PROBE_BLANK_TXT], fkeys: [] };
    const result = renderScreenLayout(input);
    expect(result).toContain("?%_P_KUNNR_%_APP_%-TEXT?");
  });

  // rsusr002-1000.txt FIELDS: name=[SSCRFIELDS-UCOMM] line=[FF] coln=[01]
  // ltyp=[O] — the OK-code pseudo-field. hex("FF") = 255.
  const OK_CODE: ScreenFieldRow = {
    fnam: "SSCRFIELDS-UCOMM",
    fill: "",
    leng: "14",
    line: "FF",
    coln: "01",
    flg1: "A0",
    grp3: "",
    stxt: "_".repeat(20),
  };

  it("excludes the OK-code pseudo-field (line=FF) from the grid entirely (live row: rsusr002-1000.txt, SSCRFIELDS-UCOMM)", () => {
    const input: ScreenLayoutInput = { header: RSUSR002_HEADER, fields: [T_USER, OK_CODE], fkeys: [] };
    const result = renderScreenLayout(input);
    expect(result).not.toContain("SSCRFIELDS-UCOMM");
  });
});

// ---------------------------------------------------------------------------
// Table control — sapmsyst-0020.txt (SAPMSYST 0020), the only live fill=T
// among the three captures (rsusr002-1000.txt and zui_i113_probe-1000.txt
// both have none — checked directly against their FIELDS sections).
// ---------------------------------------------------------------------------

describe("renderScreenLayout: table control", () => {
  // sapmsyst-0020.txt HEADER: lines=[023] columns=[091] (decimal).
  const SAPMSYST_HEADER: Readonly<Record<string, string>> = { lines: "023", columns: "091" };

  // sapmsyst-0020.txt FIELDS:
  // name=[TC_IUSRACL] fill=[T] leng=[1F] line=[09] coln=[03] lanf=[66]
  // line 0x09 = 9 -> row idx 8; coln 0x03 = 3 -> col idx 2; leng 0x1F = 31;
  // lanf 0x66 = 102 (the anchor for every member row below, which all
  // share lanf=[66]).
  const TC_ANCHOR: ScreenFieldRow = {
    fnam: "TC_IUSRACL",
    fill: "T",
    leng: "1F",
    line: "09",
    coln: "03",
    lanf: "66",
    flg1: "20",
  };
  // name=[%TC_IUSRACL] fmb2=[40] lanf=[66] stxt=[Auswahl_SAP-Benutzer______]
  // fmb2 0x40 -> the title member. decodeStxt strips only the TRAILING "_"
  // run (6 chars) -> "Auswahl_SAP-Benutzer", then all remaining "_" -> " "
  // -> "Auswahl SAP-Benutzer".
  const TC_TITLE_MEMBER: ScreenFieldRow = {
    fnam: "%TC_IUSRACL",
    fill: "",
    lanf: "66",
    fmb2: "40",
    stxt: "Auswahl_SAP-Benutzer______",
  };
  // name=[%IUSRACL-MANDT] fmb2=[80] coln=[01] stxt=[Mandant_____] -> "Mandant"
  const TC_HEADER_MANDT: ScreenFieldRow = {
    fnam: "%IUSRACL-MANDT",
    fill: "",
    lanf: "66",
    fmb2: "80",
    coln: "01",
    stxt: "Mandant_____",
  };
  // name=[%IUSRACL-BNAME] fmb2=[80] coln=[02] stxt=[Benutzer________] -> "Benutzer"
  const TC_HEADER_BNAME: ScreenFieldRow = {
    fnam: "%IUSRACL-BNAME",
    fill: "",
    lanf: "66",
    fmb2: "80",
    coln: "02",
    stxt: "Benutzer________",
  };
  // name=[IUSRACL-MANDT] fill=[P] lanf=[66] — a cell member, no "%" prefix,
  // so tableControlBox's title/header filters (which require a "%" prefix)
  // skip it; it must also never be drawn as its own top-level element.
  const TC_CELL_MANDT: ScreenFieldRow = {
    fnam: "IUSRACL-MANDT",
    fill: "P",
    lanf: "66",
    leng: "03",
    stxt: "___",
  };
  const TC_CELL_BNAME: ScreenFieldRow = {
    fnam: "IUSRACL-BNAME",
    fill: "P",
    lanf: "66",
    leng: "0C",
    stxt: "____________",
  };

  const tcInput: ScreenLayoutInput = {
    header: SAPMSYST_HEADER,
    fields: [TC_ANCHOR, TC_TITLE_MEMBER, TC_HEADER_MANDT, TC_HEADER_BNAME, TC_CELL_MANDT, TC_CELL_BNAME],
    fkeys: [],
  };

  it("draws a labelled box for the table control (live rows: sapmsyst-0020.txt, TC_IUSRACL)", () => {
    const result = renderScreenLayout(tcInput);
    const topRow = lineAt(result, 8); // 0x09 -> idx 8
    expect(topRow).toContain("table control: TC_IUSRACL");
  });

  it("includes one header row of column names inside the box, in coln order (live rows: sapmsyst-0020.txt, %IUSRACL-MANDT/%IUSRACL-BNAME)", () => {
    const result = renderScreenLayout(tcInput);
    const headerRow = lineAt(result, 9); // box row 1 -> grid row 8 + 1 = 9
    const mandtIdx = headerRow.indexOf("Mandant");
    const bnameIdx = headerRow.indexOf("Benutzer");
    expect(mandtIdx).toBeGreaterThanOrEqual(0);
    expect(bnameIdx).toBeGreaterThan(mandtIdx);
  });

  it("does not draw the table control's own member fields as separate top-level elements (live rows: sapmsyst-0020.txt, IUSRACL-MANDT/IUSRACL-BNAME cells)", () => {
    const result = renderScreenLayout(tcInput);
    // Members are only ever consumed by tableControlBox (title/header text
    // decoded above); their own fnam is never drawn anywhere, top-level or
    // otherwise.
    expect(result).not.toContain("IUSRACL-MANDT");
    expect(result).not.toContain("IUSRACL-BNAME");
    expect(result).not.toContain("%TC_IUSRACL"); // the title member's own fnam, too
  });
});

// ---------------------------------------------------------------------------
// Subscreen area — rsusr002-1000.txt (RSUSR002 1000), the only live fill=B
// among the three captures (zui_i113_probe-1000.txt has none — checked
// directly against its FIELDS section).
// ---------------------------------------------------------------------------

describe("renderScreenLayout: subscreen area", () => {
  const RSUSR002_HEADER: Readonly<Record<string, string>> = { lines: "200", columns: "120" };

  // rsusr002-1000.txt FIELDS: name=[%_SUBSCREEN_TAB] fill=[B] leng=[70]
  // line=[09] coln=[05]. line 0x09 = 9 -> row idx 8; coln 0x05 = 5 -> col
  // idx 4; leng 0x70 = 112 -> width = max(112, 20) = 112.
  const SUBSCREEN: ScreenFieldRow = {
    fnam: "%_SUBSCREEN_TAB",
    fill: "B",
    leng: "70",
    line: "09",
    coln: "05",
    flg1: "00",
  };

  it("draws a labelled box with the subscreen's D021S width (live row: rsusr002-1000.txt, %_SUBSCREEN_TAB)", () => {
    const input: ScreenLayoutInput = { header: RSUSR002_HEADER, fields: [SUBSCREEN], fkeys: [] };
    const result = renderScreenLayout(input);
    const topRow = lineAt(result, 8); // 0x09 -> idx 8
    expect(topRow).toContain("subscreen: %_SUBSCREEN_TAB (112 cols)");
    const interiorRow = lineAt(result, 9);
    expect(interiorRow[4]).toBe("|"); // left edge at coln idx 4
    const bottomRow = lineAt(result, 10);
    // As with the frame box above, the box's left edge sits at the
    // subscreen's own column (coln=5 -> idx 4), not absolute column 0;
    // columns 0-3 of this line are left blank. Asserted against that
    // offset rather than a `^` anchor.
    expect(bottomRow[4]).toBe("+");
    expect(bottomRow.slice(4)).toMatch(/^\+-+\+/);
  });
});

// ---------------------------------------------------------------------------
// Buttons — rsusr002-1000.txt (RSUSR002 1000), "--- FUNCTION KEYS ---"
// ---------------------------------------------------------------------------

describe("renderScreenLayout: buttons", () => {
  // rsusr002-1000.txt FUNCTION KEYS (verbatim rows, status=[SELECT]):
  //   status=[SELECT] code=[MYPI] text=[@3R@] quickinfo=[Details anzeigen]
  //   status=[SELECT] code=[TAKE] text=[Übernehmen...] quickinfo=[Übernehmen...]
  // and status=[TREE], where P-- genuinely repeats twice in the capture
  // with identical text (a live duplicate, not manufactured for this test):
  //   status=[TREE] code=[P--] text=[@2Y@ Erste Seite] quickinfo=[Erste Seite]
  //   status=[TREE] code=[P-]  text=[@2Z@ Vorige Seite] quickinfo=[Vorige Seite]
  //   ... (P+, P++, %SC, ... omitted — not needed for these assertions) ...
  //   status=[TREE] code=[P--] text=[@2Y@ Erste Seite] quickinfo=[Erste Seite]  <- dup
  const FKEYS: readonly ScreenFieldRow[] = [
    { status: "SELECT", code: "MYPI", text: "@3R@" },
    { status: "SELECT", code: "TAKE", text: "Übernehmen..." },
    { status: "TREE", code: "P--", text: "@2Y@ Erste Seite" },
    { status: "TREE", code: "P-", text: "@2Z@ Vorige Seite" },
    { status: "TREE", code: "P--", text: "@2Y@ Erste Seite" }, // duplicate code within TREE
  ];

  it("lists GUI status buttons grouped by status, in renderButtons' real format (live rows: rsusr002-1000.txt FUNCTION KEYS)", () => {
    const input: ScreenLayoutInput = { fields: [], fkeys: FKEYS };
    const result = renderScreenLayout(input);
    expect(result).toContain("Buttons (SELECT): @3R@ (MYPI), Übernehmen... (TAKE)");
    expect(result).toContain("Buttons (TREE): @2Y@ Erste Seite (P--), @2Z@ Vorige Seite (P-)");
  });

  it("deduplicates a code repeated within one status, keeping the first occurrence (live duplicate: rsusr002-1000.txt, status=[TREE] code=[P--] appears twice)", () => {
    const input: ScreenLayoutInput = { fields: [], fkeys: FKEYS };
    const result = renderScreenLayout(input);
    const treeLine = result.split("\n").find((l) => l.startsWith("Buttons (TREE)")) ?? "";
    const occurrences = treeLine.split("(P--)").length - 1;
    expect(occurrences).toBe(1);
  });

  it("skips a row with an empty code (synthesised row — no live example of an empty fkeys code was found in any capture)", () => {
    const fkeys: readonly ScreenFieldRow[] = [
      { status: "X", code: "", text: "should not appear" },
      { status: "X", code: "Y", text: "kept" },
    ];
    const input: ScreenLayoutInput = { fields: [], fkeys };
    const result = renderScreenLayout(input);
    expect(result).toContain("Buttons (X): kept (Y)");
    expect(result).not.toContain("should not appear");
  });

  it("says so plainly when there are no fkeys at all", () => {
    const input: ScreenLayoutInput = { fields: [], fkeys: [] };
    const result = renderScreenLayout(input);
    expect(result).toContain("Buttons: (no GUI status buttons)");
  });
});

// ---------------------------------------------------------------------------
// Truncation and robustness
// ---------------------------------------------------------------------------

describe("renderScreenLayout: truncation and robustness", () => {
  it("marks the grid when RPY_DYHEAD.lines exceeds the 300-row cap", () => {
    const input: ScreenLayoutInput = { header: { lines: "400" }, fields: [], fkeys: [] };
    const result = renderScreenLayout(input);
    // Not literally the last line of the whole response (the blank/Buttons/
    // blank/NOTE tail follows it) — it is the last line of the GRID
    // section specifically. Asserted here by substring, not `endsWith`.
    expect(result).toContain("(grid cut to 300 rows; RPY_DYHEAD reports 400)");
  });

  it("repeats the fidelity disclosure next to the picture", () => {
    const input: ScreenLayoutInput = { header: { lines: "10", columns: "40" }, fields: [], fkeys: [] };
    const result = renderScreenLayout(input);
    expect(result).toContain(`NOTE: ${LAYOUT_FIDELITY_NOTE}`);
  });

  it("degrades instead of throwing on non-hex D021S values", () => {
    const fields: readonly ScreenFieldRow[] = [{ fnam: "BAD", fill: "", line: "ZZ", coln: "QQ", leng: "GG" }];
    let result = "";
    expect(() => {
      result = renderScreenLayout({ fields, fkeys: [] });
    }).not.toThrow();
    expect(typeof result).toBe("string");
  });

  it("degrades instead of throwing with a missing header", () => {
    let result = "";
    expect(() => {
      result = renderScreenLayout({ fields: [{ fnam: "X", fill: "", line: "01", coln: "01" }], fkeys: [] });
    }).not.toThrow();
    expect(typeof result).toBe("string");
  });

  it("degrades instead of throwing on an empty fields array", () => {
    let result = "";
    expect(() => {
      result = renderScreenLayout({ header: { lines: "5", columns: "40" }, fields: [], fkeys: [] });
    }).not.toThrow();
    expect(typeof result).toBe("string");
  });

  it("degrades instead of throwing on a row with no fnam", () => {
    const fields: readonly ScreenFieldRow[] = [{ line: "01", coln: "01", fill: "" }];
    let result = "";
    expect(() => {
      result = renderScreenLayout({ fields, fkeys: [] });
    }).not.toThrow();
    expect(typeof result).toBe("string");
  });

  it("handles a completely empty screen with no throw", () => {
    // ScreenLayoutInput's `fields`/`fkeys` are required by the type (only
    // `header` is optional) — renderScreenLayoutInner nonetheless does
    // `input.fields ?? []` / `input.fkeys ?? []`, defending a shape the
    // type itself doesn't allow a well-typed caller to produce. Exercising
    // that defense deliberately requires stepping outside the type via a
    // cast (not `any`) rather than a mock.
    let result = "";
    expect(() => {
      result = renderScreenLayout({} as ScreenLayoutInput);
    }).not.toThrow();
    expect(typeof result).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// abap_ui screen: layout parameter — thin schema surface test
// ---------------------------------------------------------------------------

describe("abap_ui screen: layout parameter", () => {
  // Precedent: test/run-parameters.test.ts inspects zod schema shapes
  // directly (`runInputSchema.parameters.unwrap().element.shape.ranges`)
  // rather than mocking a tool call — followed here for `uiInputSchema`.
  it("registers `layout` as an optional boolean", () => {
    const layoutField = uiInputSchema.layout;
    expect(layoutField).toBeInstanceOf(z.ZodOptional);
    expect(layoutField.isOptional()).toBe(true);
    expect(layoutField.unwrap()).toBeInstanceOf(z.ZodBoolean);
  });
});
