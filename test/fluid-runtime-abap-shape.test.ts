/**
 * Documentation-drift guard for the runtime ABAP's argument reader (`scan`)
 * and output escaper (`esc`), documented in
 * doc/FLUID-API/authoring.md ("What the runtime's argument reader and
 * output escaper actually parse"). That section pins two contracts as
 * plugin-author-facing limits, not implementation details:
 *
 * - `scan` parses only a top-level JSON object: string values, arrays of
 *   strings (as `path/0`, `path/1`, ...), and a bare-token else-branch for
 *   everything else (numbers, booleans, null, and — incorrectly — nested
 *   objects/arrays, which it cannot depth-track).
 * - `esc` escapes exactly six things: backslash, double quote, CRLF, a bare
 *   newline, a bare carriage return, and horizontal tab. Nothing else.
 *
 * This test asserts those branches and that exact escape set are still
 * present in the ABAP source string, at the string level, offline — no ABAP
 * runtime, no network. If a future edit to `scan` or `esc` changes what is
 * handled, this test must fail before the doc goes stale.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FLUID_RUNTIME_CLASS, fluidRuntimeSources } from "../src/adt/fluid/abap/runtime.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Loaded from disk too, independently of the module import, so a refactor
// that moves the source string out of runtime.ts without updating
// fluidRuntimeSources cannot silently make this test check the wrong thing.
function runtimeModuleText(): string {
  return readFileSync(join(repoRoot, "src", "adt", "fluid", "abap", "runtime.ts"), "utf8");
}

function runtimeAbapSource(): string {
  const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS);
  if (source === undefined) {
    throw new Error(`fluidRuntimeSources has no entry for ${FLUID_RUNTIME_CLASS}`);
  }
  return source;
}

describe("runtime ABAP scan/esc contract matches authoring.md's documented limits", () => {
  it("fluidRuntimeSources actually exports the ZCL_ZMCP_FLUID_RT source", () => {
    const abap = runtimeAbapSource();
    expect(abap).toContain("METHOD scan.");
    expect(abap).toContain("METHOD esc.");
  });

  describe("scan: top-level-object-only, string/array-of-string/bare-token branches", () => {
    it("returns immediately on a top-level closing brace (no recursion into nested objects)", () => {
      const abap = runtimeAbapSource();
      const scanMethod = abap.slice(abap.indexOf("METHOD scan."), abap.indexOf("ENDMETHOD.", abap.indexOf("METHOD scan.")));
      expect(scanMethod).toContain("IF lv_ch = '}'");
      expect(scanMethod).toContain("RETURN.");
    });

    it("reads a quoted value as a plain string", () => {
      const abap = runtimeAbapSource();
      const scanMethod = abap.slice(abap.indexOf("METHOD scan."), abap.indexOf("ENDMETHOD.", abap.indexOf("METHOD scan.")));
      expect(scanMethod).toContain("IF lv_ch = '\"'.");
      expect(scanMethod).toContain("lv_val = read_string(");
    });

    it("reads a bracketed value as an array of strings, indexed path/0, path/1, ...", () => {
      const abap = runtimeAbapSource();
      const scanMethod = abap.slice(abap.indexOf("METHOD scan."), abap.indexOf("ENDMETHOD.", abap.indexOf("METHOD scan.")));
      expect(scanMethod).toContain("ELSEIF lv_ch = '['.");
      expect(scanMethod).toContain("|{ lv_key }/{ lv_idx }|");
    });

    it("has a bare-token else-branch that copies raw text to the next top-level ',' or '}'", () => {
      const abap = runtimeAbapSource();
      const scanMethod = abap.slice(abap.indexOf("METHOD scan."), abap.indexOf("ENDMETHOD.", abap.indexOf("METHOD scan.")));
      expect(scanMethod).toContain("ELSE.");
      expect(scanMethod).toContain("IF lv_ch = ',' OR lv_ch = '}'.");
      expect(scanMethod).toContain("lv_val = substring( val = iv_json off = lv_start len = lv_off - lv_start ).");
    });
  });

  describe("esc: exactly six escapes, nothing else", () => {
    it("escapes backslash, double quote, CRLF, newline, CR, and horizontal tab, in that order", () => {
      const abap = runtimeAbapSource();
      const escMethod = abap.slice(abap.indexOf("METHOD esc."), abap.indexOf("ENDMETHOD.", abap.indexOf("METHOD esc.")));

      const replacements = [...escMethod.matchAll(/REPLACE ALL OCCURRENCES OF (\S+) IN rv_text WITH '([^']*)'/g)].map(
        (m) => ({ from: m[1], to: m[2] }),
      );

      expect(replacements).toEqual([
        { from: "'\\'", to: "\\\\" },
        { from: "'\"'", to: "\\\"" },
        { from: "cl_abap_char_utilities=>cr_lf", to: "\\n" },
        { from: "cl_abap_char_utilities=>newline", to: "\\n" },
        { from: "lv_cr", to: "\\r" },
        { from: "cl_abap_char_utilities=>horizontal_tab", to: "\\t" },
      ]);
    });

    it("names no other cl_abap_char_utilities control-character constant (e.g. backspace, form_feed) as escaped", () => {
      const abap = runtimeAbapSource();
      const escMethod = abap.slice(abap.indexOf("METHOD esc."), abap.indexOf("ENDMETHOD.", abap.indexOf("METHOD esc.")));
      expect(escMethod).not.toContain("backspace");
      expect(escMethod).not.toContain("form_feed");
    });
  });

  it("read_string (the unescaping direction) understands more escapes than esc produces — kept asymmetric on purpose", () => {
    const abap = runtimeAbapSource();
    const readStringMethod = abap.slice(
      abap.indexOf("METHOD read_string."),
      abap.indexOf("ENDMETHOD.", abap.indexOf("METHOD read_string.")),
    );
    for (const esc of ["WHEN 'b'.", "WHEN 'f'.", "WHEN 'u'."]) {
      expect(readStringMethod).toContain(esc);
    }
  });

  it("the module doc comment still frames scan/esc as a hand-rolled reader, not full JSON", () => {
    const moduleText = runtimeModuleText();
    expect(moduleText).toContain("FLUID_RUNTIME_SOURCE");
  });
});
