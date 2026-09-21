/**
 * Issue #150, item 1 — the compact renderers behind `abap_ui mode=screen`'s
 * default `detail:"compact"` (src/tools/ui-compact.ts), exercised directly
 * on the synthetic D021S rows and flow logic of test/helpers/ui-screen-fixture.ts.
 * Pure functions, no connection. The tool-level shape (header, notes,
 * `detail:"full"` byte-identity with the pre-#150 dump) is pinned in
 * test/ui-screen-compact-tool.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  classifyScreenField,
  compactFieldAttrs,
  compactScreenNote,
  renderCompactFields,
  renderCompactFlow,
} from "../src/tools/ui-compact.js";
import { SCREEN_FIELDS, SCREEN_FLOW, SCREEN_FLOW_GENERATED } from "./helpers/ui-screen-fixture.js";

const byName = (name: string): Record<string, string> => {
  const row = SCREEN_FIELDS.find((r) => r.fnam === name);
  if (!row) throw new Error(`fixture has no field ${name}`);
  return row;
};

describe("classifyScreenField — one word per element, same rule as the LAYOUT renderer", () => {
  it.each([
    ["%_P_KUNNR_%_APP_%-TEXT", "label"], // grp3=TXT
    ["T_USER", "io"], // stxt all `_`, flg1=80
    ["%_USER_%_APP_%-OPTI_PUSH", "out"], // stxt all `_`, flg1=81 → (flg1 & 0x21) === 0x01
    ["P_SELSHW", "checkbox"], // fill C
    ["%_SUBSCREEN_TAB", "subscreen"], // fill B
    ["%_ZAS_HEADLINE", "text"], // flg1 bit 0x80 clear
    ["P_RAD1", "radio"], // fill A
    ["%_ZAS_ICON", "button"], // fill P
    ["SSCRFIELDS-UCOMM", "okcode"], // line FF
  ])("%s → %s", (name, kind) => {
    expect(classifyScreenField(byName(name))).toBe(kind);
  });

  it("names an unknown fill code instead of guessing, and survives a malformed row", () => {
    expect(classifyScreenField({ fill: "Q", line: "01" })).toBe("fill=Q");
    expect(classifyScreenField({})).toBe("text"); // flg1 absent → bit 0x80 clear
    expect(classifyScreenField({ line: "zz", flg1: "not-hex" })).toBe("text"); // malformed hex decodes to 0
    expect(classifyScreenField({ flg1: "80" })).toBe("label"); // present, no grp3, no stxt
  });
});

describe("compactFieldAttrs — only what differs from a plain element", () => {
  it("drops empty columns, all-zero RAW columns and flg1=80; keeps the rest in D021S order", () => {
    expect(compactFieldAttrs(byName("T_USER"))).toBe("grp3=COF");
    expect(compactFieldAttrs(byName("%_USER_%_APP_%-OPTI_PUSH"))).toBe("flg1=81 grp3=OPU");
    expect(compactFieldAttrs(byName("P_RAD1"))).toBe("grp3=PAR grp4=RB1");
    expect(compactFieldAttrs(byName("%_SUBSCREEN_TAB"))).toBe("lblk=0A");
    expect(compactFieldAttrs(byName("SSCRFIELDS-UCOMM"))).toBe("ltyp=O didx=0012");
  });

  it("shows a real screen text decoded (`_` → space) as text=\"...\", but never an I/O mask", () => {
    expect(compactFieldAttrs(byName("%_ZAS_HEADLINE"))).toBe('text="Selection criteria" flg1=20');
    expect(compactFieldAttrs(byName("%_P_KUNNR_%_APP_%-TEXT"))).toBe("grp3=TXT");
    expect(compactFieldAttrs(byName("P_SELSHW"))).toBe("grp3=PAR");
  });

  it("strips the @NN@ icon prefix and trailing padding from a button text", () => {
    expect(compactFieldAttrs(byName("%_ZAS_ICON"))).toBe('text="Run"');
  });

  it("never repeats a column that has its own table column (name/fill/line/coln/leng/stxt)", () => {
    for (const row of SCREEN_FIELDS) {
      const attrs = compactFieldAttrs(row);
      for (const own of ["name=", "fnam=", "fill=", "line=", "coln=", "leng=", "stxt="]) {
        expect(attrs).not.toContain(own);
      }
    }
  });
});

describe("renderCompactFields — one line per field, `name  type  len  pos  attrs`", () => {
  it("renders the fixture as a header plus nine rows with decimal len and line,col", () => {
    const text = renderCompactFields(SCREEN_FIELDS);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^name\s+type\s+len\s+pos\s+attrs$/);
    expect(lines[1]).toMatch(/^-+\s+-+\s+-+\s+-+\s+-+$/);
    expect(lines).toHaveLength(2 + SCREEN_FIELDS.length);
    // leng 1B hex → 27, line 02 / coln 04 → 2,4
    expect(text).toMatch(/^T_USER\s+io\s+27\s+2,4\s+grp3=COF$/m);
    // leng 28 hex → 40; flg1=81 kept because it is not the default 80
    expect(text).toMatch(/^%_USER_%_APP_%-OPTI_PUSH\s+out\s+40\s+2,32\s+flg1=81 grp3=OPU$/m);
    // line FF → 255
    expect(text).toMatch(/^SSCRFIELDS-UCOMM\s+okcode\s+20\s+255,1\s+ltyp=O didx=0012$/m);
    expect(text).toMatch(/^%_ZAS_HEADLINE\s+text\s+20\s+1,2\s+text="Selection criteria" flg1=20$/m);
  });

  it("is a fraction of the raw key=[value] dump for the same rows", () => {
    const raw = SCREEN_FIELDS.map((r) =>
      Object.entries(r)
        .map(([k, v]) => `${k}=[${v}]`)
        .join(" "),
    ).join("\n");
    const compact = renderCompactFields(SCREEN_FIELDS);
    // Nine rows only, so the padded table header weighs in; on a live selection
    // screen with ~100 elements the ratio is far below this.
    expect(compact.length).toBeLessThan(raw.length / 2);
    // and no `=[` anywhere: the compact form is not the dump with fewer keys.
    expect(compact).not.toContain("=[");
  });

  it("says (none) for no rows, like the full renderer", () => {
    expect(renderCompactFields([])).toBe("(none)");
  });
});

describe("renderCompactFlow — generated %_ lines collapse into counted markers, user lines stay", () => {
  it("folds the fixture's four runs and reports the total omitted", () => {
    const { text, omitted } = renderCompactFlow(SCREEN_FLOW);
    expect(omitted).toBe(SCREEN_FLOW_GENERATED);
    expect(text.split("\n")).toEqual([
      "PROCESS BEFORE OUTPUT.",
      "  (3 generated %_ flow-logic lines omitted)",
      "  MODULE status_1000.",
      "PROCESS AFTER INPUT.",
      "  (6 generated %_ flow-logic lines omitted)",
      "  CHAIN.",
      "    FIELD P_SELSHW.",
      "    MODULE check_selshw ON CHAIN-REQUEST.",
      "  ENDCHAIN.",
      "  (1 generated %_ flow-logic line omitted)",
      "  MODULE user_command_1000.",
      "  (1 generated %_ flow-logic line omitted)",
    ]);
  });

  it("keeps every user-written line verbatim and drops every %_ line", () => {
    const { text } = renderCompactFlow(SCREEN_FLOW);
    expect(text).toContain("MODULE status_1000.");
    expect(text).toContain("MODULE user_command_1000.");
    expect(text).toContain("MODULE check_selshw ON CHAIN-REQUEST.");
    expect(text).not.toMatch(/^\s*(MODULE|FIELD) %_/m);
  });

  it("keeps a CHAIN block that has any user-written line, folding only the generated lines inside it", () => {
    const rows = [
      "PROCESS AFTER INPUT.",
      "  CHAIN.",
      "    FIELD %_P_X_%_APP_%-LOW.",
      "    FIELD P_Y.",
      "    MODULE %_P_X_%_APP_%-VALU_PUSH ON REQUEST.",
      "  ENDCHAIN.",
    ].map((line) => ({ line }));
    const { text, omitted } = renderCompactFlow(rows);
    expect(omitted).toBe(2);
    expect(text.split("\n")).toEqual([
      "PROCESS AFTER INPUT.",
      "  CHAIN.",
      "    (1 generated %_ flow-logic line omitted)",
      "    FIELD P_Y.",
      "    (1 generated %_ flow-logic line omitted)",
      "  ENDCHAIN.",
    ]);
  });

  it("is the identity (omitted 0) on flow logic with no generated lines", () => {
    const rows = ["PROCESS BEFORE OUTPUT.", "  MODULE status_0100.", "PROCESS AFTER INPUT.", "  MODULE user_command_0100."].map(
      (line) => ({ line }),
    );
    const { text, omitted } = renderCompactFlow(rows);
    expect(omitted).toBe(0);
    expect(text).toBe(rows.map((r) => r.line).join("\n"));
  });

  it("says (none) for no rows and does not fold an unterminated CHAIN", () => {
    expect(renderCompactFlow([])).toEqual({ text: "(none)", omitted: 0 });
    const { text, omitted } = renderCompactFlow([{ line: "  CHAIN." }, { line: "    FIELD %_A." }]);
    expect(omitted).toBe(1);
    expect(text).toBe("  CHAIN.\n    (1 generated %_ flow-logic line omitted)");
  });
});

describe("compactScreenNote", () => {
  it("names the default, the count folded, and the way back", () => {
    const note = compactScreenNote(SCREEN_FLOW_GENERATED);
    expect(note).toContain('detail:"compact", the default');
    expect(note).toContain(`${SCREEN_FLOW_GENERATED} generated %_ flow-logic lines collapsed`);
    expect(note).toContain('detail:"full" restores the raw key=[value] dump');
    expect(compactScreenNote(0)).toContain("no generated %_ flow-logic lines to collapse");
    expect(compactScreenNote(1)).toContain("1 generated %_ flow-logic line collapsed");
  });
});
