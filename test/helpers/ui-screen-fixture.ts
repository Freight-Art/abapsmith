/**
 * One `ui.screen` OUT payload for the abap_ui screen-mode tests (issue #150).
 *
 * NOT a live capture. The field rows are shaped after the live D021S rows
 * quoted in test/ui-layout.test.ts (rsusr002-1000.txt: `T_USER`,
 * `%_USER_%_APP_%-OPTI_PUSH`, `P_SELSHW`, `%_P_KUNNR_%_APP_%-TEXT`,
 * `SSCRFIELDS-UCOMM`), with the RAW(1) columns as the uppercase hex strings
 * the ABAP `|{ <fs> }|` template emits and blank/zero columns as the bridge
 * really sends them (`""`, `"00"`, `"0000"`). The flow logic is shaped after
 * SAP's generated selection-screen flow (`%_INIT_PBO`, `%_PBO`,
 * `%_<par>_%_APP_%-VALU_PUSH`, CHAIN blocks) with two user-written modules
 * mixed in so a test can prove they survive the collapse. The payload is
 * used both to pin `detail:"full"` byte-for-byte against the golden text in
 * test/fixtures/ui-screen/detail-full.golden.txt (rendered by the pre-#150
 * renderer, see that file's header) and to exercise the compact renderer.
 */

const HEX_ZERO = "00";

/** Every D021S column the bridge's RTTI dump emits, in component order, at its blank/zero value. */
function d021s(overrides: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {
    fnam: "",
    fill: "",
    line: HEX_ZERO,
    coln: HEX_ZERO,
    leng: HEX_ZERO,
    ltyp: "",
    lblk: HEX_ZERO,
    lrep: HEX_ZERO,
    flg1: HEX_ZERO,
    flg2: HEX_ZERO,
    flg3: HEX_ZERO,
    fmb1: HEX_ZERO,
    fmb2: HEX_ZERO,
    lanf: HEX_ZERO,
    didx: "0000",
    stxt: "",
    aglt: HEX_ZERO,
    adez: HEX_ZERO,
    grp1: "",
    grp2: "",
    grp3: "",
    grp4: "",
  };
  const row = { ...base, ...overrides };
  // The bridge's row_json() puts "name" (= FNAM) first, then every component lowercased.
  return { name: row.fnam, ...row };
}

export const SCREEN_FIELDS: readonly Record<string, string>[] = [
  d021s({ fnam: "%_P_KUNNR_%_APP_%-TEXT", leng: "1F", line: "02", coln: "01", flg1: "80", grp3: "TXT", stxt: "_______________________________" }),
  d021s({ fnam: "T_USER", leng: "1B", line: "02", coln: "04", flg1: "80", grp3: "COF", stxt: "___________________________" }),
  d021s({ fnam: "%_USER_%_APP_%-OPTI_PUSH", leng: "28", line: "02", coln: "20", flg1: "81", grp3: "OPU", stxt: "________________________________________" }),
  d021s({ fnam: "P_SELSHW", fill: "C", leng: "01", line: "25", coln: "04", flg1: "80", grp3: "PAR", stxt: "_" }),
  d021s({ fnam: "%_SUBSCREEN_TAB", fill: "B", leng: "70", line: "03", coln: "02", flg1: "80", lblk: "0A" }),
  d021s({ fnam: "%_ZAS_HEADLINE", leng: "14", line: "01", coln: "02", flg1: "20", stxt: "Selection_criteria" }),
  d021s({ fnam: "P_RAD1", fill: "A", leng: "01", line: "05", coln: "04", flg1: "80", grp3: "PAR", grp4: "RB1", stxt: "_" }),
  d021s({ fnam: "%_ZAS_ICON", fill: "P", leng: "0C", line: "07", coln: "04", flg1: "80", stxt: "@0A@Run_________" }),
  d021s({ fnam: "SSCRFIELDS-UCOMM", leng: "14", line: "FF", coln: "01", ltyp: "O", flg1: "80", didx: "0012" }),
];

export const SCREEN_FLOW: readonly Record<string, string>[] = [
  "PROCESS BEFORE OUTPUT.",
  "  MODULE %_INIT_PBO.",
  "  MODULE %_PBO.",
  "  MODULE %_P_KUNNR_%_APP_%-TEXT_%_PBO.",
  "  MODULE status_1000.",
  "PROCESS AFTER INPUT.",
  "  MODULE %_INIT_PAI.",
  "  CHAIN.",
  "    FIELD %_USER_%_APP_%-LOW.",
  "    FIELD %_USER_%_APP_%-HIGH.",
  "    MODULE %_USER_%_APP_%-VALU_PUSH ON REQUEST.",
  "  ENDCHAIN.",
  "  CHAIN.",
  "    FIELD P_SELSHW.",
  "    MODULE check_selshw ON CHAIN-REQUEST.",
  "  ENDCHAIN.",
  "  MODULE %_PAI.",
  "  MODULE user_command_1000.",
  "  MODULE %_EXIT_PAI AT EXIT-COMMAND.",
].map((line) => ({ line }));

/** The nine `%_` lines in SCREEN_FLOW plus the CHAIN./ENDCHAIN. pair whose whole body is generated (lines 8-12): four runs of 3, 6, 1, 1. */
export const SCREEN_FLOW_GENERATED = 11;

export const SCREEN_PAYLOAD: Record<string, unknown> = {
  tcode: {
    tcode: "ZAS_GOLD",
    program: "ZAS_GOLD",
    dynpro: "1000",
    cinfo: "00",
    kind: "dialog transaction (classic dynpro; batch input / press applies)",
    bdcApplies: true,
  },
  program: "ZAS_GOLD",
  dynpro: "1000",
  header: { prog: "ZAS_GOLD", dnum: "1000", type: "S", lines: "200", columns: "120", nline: "01", ncol: "01" },
  fields: SCREEN_FIELDS,
  flowCount: SCREEN_FLOW.length,
  flow: SCREEN_FLOW,
  statusCount: 1,
  statusList: [{ status: "%_00", modal: "" }],
  functionsCount: 2,
  functions: [
    { code: "ONLI", text: "Execute", type: "" },
    { code: "SJOB", text: "Execute in background", type: "" },
  ],
  fkeysCount: 1,
  fkeys: [{ status: "%_00", code: "ONLI", text: "Execute", quickinfo: "Execute (F8)" }],
};
