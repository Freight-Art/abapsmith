/**
 * Issue #150, item 1 at the tool level: `abap_ui mode=screen` renders
 * compact by default, `detail:"full"` is the pre-#150 dump byte for byte,
 * and `layout:true` is the same picture in both.
 *
 * The golden text test/fixtures/ui-screen/detail-full.golden.txt was
 * rendered by src/tools/ui.ts as of origin/main 5b17194 (v0.6.8, before any
 * #150 change) for exactly this call — `abap_ui {mode:"screen",
 * tcode:"ZAS_GOLD"}` over `SCREEN_PAYLOAD` through `uiRoute` — and
 * committed unmodified (a raw text fixture cannot carry a header comment
 * without changing the bytes, so its provenance lives here). One edit was
 * made to the captured text afterwards: the fixture's `%_ZAS_HEADLINE`
 * stxt was corrected from `Selection__criteria` to `Selection_criteria`
 * (D021S stores one blank as one underscore), and the same substitution
 * was applied to the golden's `stxt=[...]` cell — the full renderer copies
 * every value verbatim (`renderRecordRows`, `${k}=[${v}]`), so the result is
 * what that renderer produces for the corrected fixture. If a later change
 * means to alter the full dump on purpose, re-render and say so.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SCREEN_FIELDS, SCREEN_FLOW, SCREEN_FLOW_GENERATED, SCREEN_PAYLOAD } from "./helpers/ui-screen-fixture.js";
import { connected, invoke, okText, registered, uiRoute } from "./helpers/ui-tool-harness.js";

const GOLDEN = readFileSync(fileURLToPath(new URL("./fixtures/ui-screen/detail-full.golden.txt", import.meta.url)), "utf8");

const TSTC = [{ TCODE: "ZAS_GOLD", PGMNA: "ZAS_GOLD", DYPNO: "1000", CINFO: "00" }];

async function screen(args: Record<string, unknown>): Promise<string> {
  const { conn } = await connected(uiRoute({ payload: SCREEN_PAYLOAD, tstc: TSTC }));
  const tools = registered(conn);
  return okText(await invoke(tools, "abap_ui", { mode: "screen", tcode: "ZAS_GOLD", ...args }));
}

const section = (text: string, title: string): string => {
  const start = text.indexOf(`--- ${title} ---`);
  if (start < 0) throw new Error(`no section ${title}`);
  const rest = text.slice(start + `--- ${title} ---`.length);
  const end = rest.search(/\n--- [A-Z]/);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
};

describe("abap_ui screen: detail defaults to compact", () => {
  it("renders FIELDS one line per element and folds the generated flow logic, with the same counts in the header", async () => {
    const text = await screen({});
    expect(text).toContain("detail: compact");
    expect(text).toContain(`fieldsCount: ${SCREEN_FIELDS.length}`);
    expect(text).toContain(`flowCount: ${SCREEN_FLOW.length}`);
    expect(text).toContain(`flowOmitted: ${SCREEN_FLOW_GENERATED}`);

    const fields = section(text, "FIELDS");
    expect(fields.split("\n")).toHaveLength(2 + SCREEN_FIELDS.length);
    expect(fields).toMatch(/^name\s+type\s+len\s+pos\s+attrs$/m);
    expect(fields).toMatch(/^T_USER\s+io\s+27\s+2,4\s+grp3=COF$/m);
    expect(fields).not.toContain("=[");

    const flow = section(text, "FLOW LOGIC");
    expect(flow).toContain("(3 generated %_ flow-logic lines omitted)");
    expect(flow).toContain("MODULE user_command_1000.");
    expect(flow).not.toContain("%_INIT_PBO");
    expect(flow).not.toContain("line=[");

    expect(text).toContain('NOTE: Compact output (detail:"compact", the default)');
    expect(text).toContain(`${SCREEN_FLOW_GENERATED} generated %_ flow-logic lines collapsed into counted markers`);
  });

  it('detail:"compact" spelled out is the same text as the default', async () => {
    expect(await screen({ detail: "compact" })).toBe(await screen({}));
  });

  it("shrinks the FIELDS and FLOW LOGIC sections; the rest of the response is untouched", async () => {
    const compact = await screen({});
    expect(section(compact, "FIELDS").length).toBeLessThan(section(GOLDEN, "FIELDS").length / 2);
    expect(section(compact, "FLOW LOGIC").length).toBeLessThan(section(GOLDEN, "FLOW LOGIC").length);
  });

  it("leaves the HEADER, GUI STATUSES, FUNCTION CODES and FUNCTION KEYS sections exactly as in full", async () => {
    const compact = await screen({});
    for (const title of ["HEADER (RPY_DYNPRO_READ)", "GUI STATUSES (names)", "FUNCTION CODES (program-wide)", "FUNCTION KEYS"]) {
      expect(section(compact, title)).toBe(section(GOLDEN, title));
    }
  });
});

describe('abap_ui screen: detail:"full" is the pre-#150 dump', () => {
  it("matches the golden rendered by the unmodified renderer byte for byte", async () => {
    const full = await screen({ detail: "full" });
    expect(full).toBe(GOLDEN);
    // Belt and braces on what the golden must contain, so a mistaken re-render is noticed.
    expect(GOLDEN).not.toContain("flowOmitted");
    expect(GOLDEN).not.toContain("detail:");
    expect(GOLDEN).toContain("line=[  MODULE %_INIT_PBO.]");
    expect(GOLDEN).toMatch(/^name=\[T_USER\] fnam=\[T_USER\] fill=\[\] line=\[02\]/m);
  });
});

describe("abap_ui screen: layout:true is independent of detail", () => {
  it("renders the same LAYOUT section under compact and full", async () => {
    const compact = await screen({ layout: true });
    const full = await screen({ layout: true, detail: "full" });
    expect(section(compact, "LAYOUT (design-time)")).toBe(section(full, "LAYOUT (design-time)"));
    expect(section(compact, "LAYOUT (design-time)")).toContain("P_SELSHW");
    // and full+layout is the golden with only the LAYOUT section and its note added
    expect(section(full, "FIELDS")).toBe(section(GOLDEN, "FIELDS"));
    expect(section(full, "FLOW LOGIC")).toBe(section(GOLDEN, "FLOW LOGIC"));
  });
});
