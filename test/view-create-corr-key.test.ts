/**
 * `RS_CORR_INSERT`'s `object` key shape and emission order, for the static
 * `create_view` method inside `ZCL_ZMCP_FLUID_CLASSIC` — offline,
 * source-level only (see test/view-create.test.ts's header for why:
 * `createClassicView` refuses every package before any of this could reach
 * the wire).
 *
 * Two defects this pins:
 *  - `object` for `object_class = 'DICT'` is a 44-char key (4-char transport
 *    object type + 40-char name), not the bare view name — a bare name lands
 *    its first 4 characters in the type field (live TK103). `create_view` is
 *    now static (one source serves every call), so the key is built at ABAP
 *    runtime via a WIDTH/ALIGN string template rather than baked in per
 *    call; this file pins that template's shape structurally instead of
 *    slicing a per-call generated literal.
 *  - registration must run BEFORE `DDIF_VIEW_PUT`/its `COMMIT WORK`, so a
 *    rejected key can never strand an active, unregistered view.
 */
import { describe, expect, it } from "vitest";
import { viewPart } from "../src/adt/fluid/builtin/classic/abap-view.js";

const allLines = viewPart.source.split("\n");
const createIdx = allLines.findIndex((l) => l.trim() === "METHOD create_view.");
const deleteIdx = allLines.findIndex((l) => l.trim() === "METHOD delete_view.");
const createLines = allLines.slice(createIdx, deleteIdx);

/** Every `line( 'TAG' )` call in the given slice, in emission order. */
function emittedTags(src: readonly string[]): string[] {
  const found: string[] = [];
  for (const l of src) {
    const m = /^line\( '([^']*)' \)\.$/.exec(l.trim());
    if (m?.[1] !== undefined) found.push(m[1]);
  }
  return found;
}

describe("RS_CORR_INSERT's object key — the 44-char DICT layout", () => {
  it("lv_object is 'VIEW' + the view name left-aligned in 40 chars, built as a string so a 30-char-name view is not truncated — a 44-char DICT key, not the bare name", () => {
    expect(createLines.map((l) => l.trim())).toContain(
      "DATA(lv_object) = |VIEW{ lv_view WIDTH = 40 ALIGN = LEFT }|.",
    );
    const objectLine = createLines.find((l) => l.trim().startsWith("EXPORTING object ="));
    expect(objectLine).toBeTruthy();
    expect(objectLine!.trim()).toBe("EXPORTING object = lv_object");
  });

  it("is NOT the bare view name — RS_CORR_INSERT is never called with object = lv_view", () => {
    expect(createLines.some((l) => l.trim() === "EXPORTING object = lv_view")).toBe(false);
  });

  it("the object line sits between CALL FUNCTION 'RS_CORR_INSERT' and its EXCEPTIONS line", () => {
    const callIdx = createLines.findIndex((l) => l.trim() === "CALL FUNCTION 'RS_CORR_INSERT'");
    const objectIdx = createLines.findIndex((l) => l.trim().startsWith("EXPORTING object ="));
    const excIdx = createLines.findIndex(
      (l, i) => i > callIdx && l.trim().startsWith("EXCEPTIONS cancelled = 1"),
    );
    expect(callIdx).toBeGreaterThanOrEqual(0);
    expect(objectIdx).toBeGreaterThan(callIdx);
    expect(objectIdx).toBeLessThan(excIdx);
  });
});

describe("emission order — nothing is committed before registration", () => {
  it("RS_CORR_INSERT precedes DDIF_VIEW_PUT, which precedes the first COMMIT WORK", () => {
    const corrIdx = createLines.findIndex((l) => l.trim() === "CALL FUNCTION 'RS_CORR_INSERT'");
    const putIdx = createLines.findIndex((l) => l.trim() === "CALL FUNCTION 'DDIF_VIEW_PUT'");
    const commitIdx = createLines.findIndex((l) => l.trim() === "COMMIT WORK.");
    expect(corrIdx).toBeGreaterThanOrEqual(0);
    expect(putIdx).toBeGreaterThan(corrIdx);
    expect(commitIdx).toBeGreaterThan(putIdx);
  });

  it("emits the tags in exactly VIEW-REGISTERED, VIEW-PUT, VIEW-ACTIVATED order", () => {
    expect(emittedTags(createLines)).toEqual(["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"]);
  });
});

describe("local ($) vs transportable korrnum — one static source now, branching at ABAP runtime", () => {
  it("has no per-package fragment left to compare: create_view is one static source whose IF/ELSE picks korrnum at runtime, both branches feeding the same RS_CORR_INSERT call", () => {
    // The old fragment generator produced different generated text for a
    // `$`-prefixed package (korrnum = space) vs a transportable one
    // (korrnum = the literal corr number) — two different call sites in TS.
    // That generation step is gone: there is exactly one static
    // `create_view` source for every call now, and `lv_local` picks the
    // branch at ABAP runtime. What remains to pin here is that both
    // branches exist, both assign `lv_korrnum`, and RS_CORR_INSERT is only
    // ever called with the variable — never a per-package literal.
    const trimmed = createLines.map((l) => l.trim());
    expect(trimmed).toContain("IF lv_local = abap_true.");
    expect(trimmed).toContain("lv_korrnum = space.");
    expect(trimmed).toContain("ELSE.");
    expect(trimmed).toContain("lv_korrnum = lv_corr.");
    expect(trimmed).toContain("ENDIF.");
    expect(trimmed).toContain("object_class = 'DICT'");
    expect(trimmed).toContain("korrnum = lv_korrnum");
    expect(trimmed.some((l) => /^korrnum = '/.test(l))).toBe(false);
  });
});
