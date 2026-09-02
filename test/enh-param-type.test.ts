/**
 * `params[].type` (a formal parameter's ABAP TYPE reference) was
 * validated with `assertEnhIdentifier` — the object-*name* rule — which
 * refuses any namespaced or component-qualified type (`/IWBEP/IF_...`,
 * `/DMO/S_FLIGHT-CARRID`, `MARA-MATNR`), all of which are ordinary type
 * references for SAP-delivered interfaces/structures. This pins the fix:
 * `assertEnhTypeRef`, a differently-SHAPED (not looser) grammar used only at
 * that one call site, plus the `spec` schema text disclosing the new rule.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertEnhIdentifier,
  addBadiDefFragment,
  exerciseFragment,
} from "../src/adt/enhancement-templates.js";
import { isAbapError } from "../src/adt/errors.js";
import { enhInputSchema } from "../src/tools/enh.js";

function catchErr(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

function message(err: unknown): string {
  return String((err as { message: unknown }).message);
}

// ---------------------------------------------------------------------------
// Acceptances — namespaced / component-qualified type references now work.
// ---------------------------------------------------------------------------

describe("exerciseFragment — params[].type accepts a type REFERENCE grammar", () => {
  it("a namespaced interface type is accepted and substituted verbatim", () => {
    const lines = exerciseFragment({
      badiName: "ZMCP_BADI",
      methodName: "RUN",
      params: [{ name: "IV_X", kind: "exporting", type: "/IWBEP/IF_MGW_APPL_SRV_RUNTIME" }],
    });
    expect(lines).toContain("DATA lv_iv_x TYPE /IWBEP/IF_MGW_APPL_SRV_RUNTIME.");
  });

  it("a plain component-qualified type (MARA-MATNR) is accepted and substituted verbatim", () => {
    const lines = exerciseFragment({
      badiName: "ZMCP_BADI",
      methodName: "RUN",
      params: [{ name: "IV_X", kind: "exporting", type: "MARA-MATNR" }],
    });
    expect(lines).toContain("DATA lv_iv_x TYPE MARA-MATNR.");
  });

  it("a namespaced, component-qualified type (/DMO/S_FLIGHT-CARRID) is accepted and substituted verbatim", () => {
    const lines = exerciseFragment({
      badiName: "ZMCP_BADI",
      methodName: "RUN",
      params: [{ name: "IV_X", kind: "exporting", type: "/DMO/S_FLIGHT-CARRID" }],
    });
    expect(lines).toContain("DATA lv_iv_x TYPE /DMO/S_FLIGHT-CARRID.");
  });

  it('a bare type ("STRING") still works — no regression', () => {
    const lines = exerciseFragment({
      badiName: "ZMCP_BADI",
      methodName: "RUN",
      params: [{ name: "IV_X", kind: "exporting", type: "STRING" }],
    });
    expect(lines).toContain("DATA lv_iv_x TYPE STRING.");
  });
});

// ---------------------------------------------------------------------------
// Refusals — the type-reference grammar is still strict, just differently
// shaped: no compound expressions, no stray punctuation/whitespace, no
// unbounded segments.
// ---------------------------------------------------------------------------

describe("exerciseFragment — params[].type still refuses non-conforming input", () => {
  it.each([
    "A-B-C",
    "REF TO ZCL_X",
    "LINE OF ZTAB",
    "ZX.",
    "ZX'Y",
    "ZX Y",
    "ZX\nY",
    "-ZX",
    "ZX-",
    "/DMO/$X",
    "/ZX",
    "Z".repeat(31),
    "/DMO/" + "Z".repeat(31),
  ])("refuses %j as params[0].type", (badType) => {
    const err = catchErr(() =>
      exerciseFragment({
        badiName: "Z",
        methodName: "M",
        params: [{ name: "X", kind: "exporting", type: badType }],
      }),
    );
    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("BAD_INPUT");
    expect(message(err)).toContain("params[0].type");
  });
});

// ---------------------------------------------------------------------------
// The object-*name* rule is not weakened by this fix — only the one
// type-reference call site changed.
// ---------------------------------------------------------------------------

describe("the object-name rule is unchanged elsewhere", () => {
  it("params[].name is still refused when namespaced", () => {
    const err = catchErr(() =>
      exerciseFragment({
        badiName: "Z",
        methodName: "M",
        params: [{ name: "/DMO/IV_X", value: "v" }],
      }),
    );
    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("BAD_INPUT");
  });

  it("badiName is still refused when namespaced", () => {
    const err = catchErr(() =>
      addBadiDefFragment({
        badiName: "/SCMTMS/BADI_X",
        interfaceName: "IF_BADI_MARKER",
        singleUse: true,
        shortText: "test",
      }),
    );
    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("BAD_INPUT");
  });

  it("assertEnhIdentifier itself still refuses a namespaced value by default", () => {
    const err = catchErr(() => assertEnhIdentifier("/DMO/ZFOO", "someField"));
    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("BAD_INPUT");
  });
});

// ---------------------------------------------------------------------------
// Schema disclosure — params[].type's different rule must be documented in
// the tool's own describe() text, not just enforced silently.
// ---------------------------------------------------------------------------

describe("abap_enh spec schema discloses the params[].type rule", () => {
  it("describe() text names params[].type and allows a namespace for it", () => {
    // Prefer reading the live zod description value; fall back to the raw
    // source text (same fallback idiom as test/object-name-rule.test.ts) if
    // the description isn't reachable as a plain string value.
    const specDescription: unknown = (enhInputSchema.spec as { description?: unknown }).description;
    let text: string;
    if (typeof specDescription === "string" && specDescription.length > 0) {
      text = specDescription;
    } else {
      const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tools");
      text = readFileSync(join(srcDir, "enh.ts"), "utf8");
    }
    expect(text).toContain("params[].type");
    expect(text.toLowerCase()).toContain("namespace");
  });
});
