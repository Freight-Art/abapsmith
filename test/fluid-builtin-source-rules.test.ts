/**
 * Static-source regression test for every built-in fluid tool's generated
 * ABAP.
 *
 * Live evidence (A4H, 2026-09-15): a doc comment sitting between an
 * `ENDMETHOD.` and the next `METHOD ...` inside a `CLASS ... IMPLEMENTATION`
 * block makes ADT refuse to store the class outright:
 *
 *   ADT_ERROR HTTP 400 ExceptionResourceBadRequest
 *   t100 id=OO_SOURCE_BASED no=12
 *   "The class contains unknown comments which can't be stored."
 *
 * The identical comment, moved to the first lines INSIDE the method body,
 * was accepted and activated clean. No prior unit test caught the original
 * placement (in `src/adt/fluid/builtin/authtrace.ts`) because the TS test
 * suite never puts the generated ABAP near a compiler/ADT — this test
 * statically enforces the placement rule for every built-in fluid tool's
 * generated source, so a regression fails fast in CI instead of failing a
 * real deploy.
 */
import { describe, expect, it } from "vitest";

import { BUILTIN_FLUID_TOOLS } from "../src/adt/fluid/builtin/index.js";

function findCommentsOutsideMethodBodies(source: string): string[] {
  const lines = source.split("\n");
  const violations: string[] = [];
  let inImplementation = false;
  let inMethod = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();

    if (/^CLASS\s+\S+\s+IMPLEMENTATION\s*\.$/i.test(trimmed)) {
      inImplementation = true;
      inMethod = false;
      continue;
    }
    if (!inImplementation) {
      continue;
    }
    if (/^ENDCLASS\s*\.$/i.test(trimmed)) {
      inImplementation = false;
      inMethod = false;
      continue;
    }
    if (/^METHOD\s+\S+\s*\.$/i.test(trimmed)) {
      inMethod = true;
      continue;
    }
    if (/^ENDMETHOD\s*\.$/i.test(trimmed)) {
      inMethod = false;
      continue;
    }
    if (!inMethod && (trimmed.startsWith('"') || trimmed.startsWith("*"))) {
      violations.push(`line ${i + 1}: ${raw}`);
    }
  }

  return violations;
}

describe("built-in fluid ABAP sources have no comments outside method bodies", () => {
  for (const tool of BUILTIN_FLUID_TOOLS) {
    for (const [className, source] of tool.sources) {
      it(`${tool.manifest.id}: ${className}`, () => {
        expect(findCommentsOutsideMethodBodies(source)).toEqual([]);
      });
    }
  }
});

describe("findCommentsOutsideMethodBodies (self-test)", () => {
  it("flags a comment between ENDMETHOD. and the next METHOD ... as a violation", () => {
    const source = [
      "CLASS zcl_x IMPLEMENTATION.",
      "  METHOD a.",
      "  ENDMETHOD.",
      '  " this is exactly the pattern ADT rejected on A4H',
      "  METHOD b.",
      "  ENDMETHOD.",
      "ENDCLASS.",
    ].join("\n");
    expect(findCommentsOutsideMethodBodies(source)).toHaveLength(1);
  });

  it("allows the identical comment moved inside the method body", () => {
    const source = [
      "CLASS zcl_x IMPLEMENTATION.",
      "  METHOD a.",
      "  ENDMETHOD.",
      "  METHOD b.",
      '    " this is fine, it is inside the method body',
      "  ENDMETHOD.",
      "ENDCLASS.",
    ].join("\n");
    expect(findCommentsOutsideMethodBodies(source)).toEqual([]);
  });

  it("ignores comments in the DEFINITION section (outside any IMPLEMENTATION block)", () => {
    const source = [
      "CLASS zcl_x DEFINITION.",
      '  " a comment in the definition section is not covered by this rule',
      "  PUBLIC SECTION.",
      "ENDCLASS.",
      "CLASS zcl_x IMPLEMENTATION.",
      "  METHOD a.",
      "  ENDMETHOD.",
      "ENDCLASS.",
    ].join("\n");
    expect(findCommentsOutsideMethodBodies(source)).toEqual([]);
  });
});
