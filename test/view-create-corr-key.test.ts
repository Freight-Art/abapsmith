/**
 * `RS_CORR_INSERT`'s `object` key shape and emission order, for a
 * transportable classic-view create — offline, fragment-level only (see
 * test/view-create.test.ts's header for why: `createClassicView` refuses
 * every package before any of this could reach the wire).
 *
 * Two defects this pins:
 *  - `object` for `object_class = 'DICT'` is a 44-char key (4-char transport
 *    object type + 40-char name), not the bare view name — a bare name lands
 *    its first 4 characters in the type field (live TK103).
 *  - registration must run BEFORE `DDIF_VIEW_PUT`/its `COMMIT WORK`, so a
 *    rejected key can never strand an active, unregistered view.
 */
import { describe, expect, it } from "vitest";
import { classicViewFragment, type ClassicViewParams } from "../src/adt/view-create.js";

const CORR_NR = "A4HK900121";

const VIEW: ClassicViewParams = {
  viewName: "ZTM_V_CARRIER",
  baseTable: "SCARR",
  fields: ["MANDT", "CARRID", "CARRNAME"],
  description: "Carrier projection",
  packageName: "ZTM",
  corrNr: CORR_NR,
};

const LOCAL_VIEW: ClassicViewParams = { ...VIEW, packageName: "$TMP", corrNr: undefined };

/** Every `out->write( 'TAG' )` the fragment emits, in emission order. */
function emittedTags(lines: readonly string[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    const m = /^out->write\( '([^']*)' \)\.$/.exec(line.trim());
    if (m?.[1] !== undefined) found.push(m[1]);
  }
  return found;
}

describe("RS_CORR_INSERT's object key — the 44-char DICT layout", () => {
  it("carries a 44-character value: 'VIEW' then the view name padded with blanks to 40", () => {
    const lines = classicViewFragment(VIEW);
    const objectLine = lines.find((l) => l.trim().startsWith("EXPORTING object ="));
    expect(objectLine).toBeTruthy();
    // Slice the literal out of the line rather than string-comparing a
    // hand-typed constant, so this proves the actual byte layout.
    const m = /EXPORTING object = '(.*)'$/.exec(objectLine!.trim());
    expect(m).toBeTruthy();
    const key = m![1]!;
    expect(key.length).toBe(44);
    expect(key.slice(0, 4)).toBe("VIEW");
    expect(key.slice(4)).toBe(VIEW.viewName.padEnd(40));
  });

  it("is NOT the bare view name — the shape that produced live TK103", () => {
    const lines = classicViewFragment(VIEW);
    expect(lines).not.toContain(`  EXPORTING object = '${VIEW.viewName}'`);
  });

  it("the object line sits between CALL FUNCTION 'RS_CORR_INSERT' and its EXCEPTIONS line", () => {
    const lines = classicViewFragment(VIEW);
    const callIdx = lines.indexOf("CALL FUNCTION 'RS_CORR_INSERT'");
    const objectIdx = lines.findIndex((l) => l.trim().startsWith("EXPORTING object ="));
    const excIdx = lines.findIndex(
      (l, i) => i > callIdx && l.startsWith("  EXCEPTIONS cancelled = 1"),
    );
    expect(callIdx).toBeGreaterThanOrEqual(0);
    expect(objectIdx).toBeGreaterThan(callIdx);
    expect(objectIdx).toBeLessThan(excIdx);
  });
});

describe("emission order — nothing is committed before registration", () => {
  it("RS_CORR_INSERT precedes DDIF_VIEW_PUT, which precedes the first COMMIT WORK", () => {
    const lines = classicViewFragment(VIEW);
    const corrIdx = lines.indexOf("CALL FUNCTION 'RS_CORR_INSERT'");
    const putIdx = lines.indexOf("CALL FUNCTION 'DDIF_VIEW_PUT'");
    const commitIdx = lines.indexOf("COMMIT WORK.");
    expect(corrIdx).toBeGreaterThanOrEqual(0);
    expect(putIdx).toBeGreaterThan(corrIdx);
    expect(commitIdx).toBeGreaterThan(putIdx);
  });

  it("emits the tags in exactly VIEW-REGISTERED, VIEW-PUT, VIEW-ACTIVATED order for a transportable package", () => {
    const tags = emittedTags(classicViewFragment(VIEW));
    expect(tags).toEqual(["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"]);
  });
});

describe("$TMP shape is untouched by the key/ordering fix", () => {
  it("emits no RS_CORR_INSERT, no object_class, and exactly the two-tag VIEW-PUT/VIEW-ACTIVATED sequence", () => {
    const lines = classicViewFragment(LOCAL_VIEW);
    expect(lines.some((l) => l.includes("RS_CORR_INSERT"))).toBe(false);
    expect(lines.some((l) => l.includes("object_class"))).toBe(false);
    expect(emittedTags(lines)).toEqual(["VIEW-PUT", "VIEW-ACTIVATED"]);
    expect(lines.filter((l) => l === "COMMIT WORK.").length).toBe(2);
  });
});
