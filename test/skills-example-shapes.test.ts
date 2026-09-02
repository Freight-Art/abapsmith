/**
 * Field-name validity of the worked examples in `skills/**\/SKILL.md`.
 *
 * `test/skills-tool-surface.test.ts` already guards that every `abap_*`
 * NAME mentioned in a skill is real (Check A) — but its own header is
 * explicit that this is coarse, "does this identifier appear somewhere in
 * this file's text", and does NOT validate the shape of any individual
 * worked example. This file is narrower and deeper: it parses each
 * `abap_write { ... }` / `abap_read { ... }` worked example out of the
 * skill prose and asserts every field name it names is a real key on that
 * tool's actual exported zod schema — `WriteInput`/`ReadInput` (v1,
 * `src/tools/write.ts` / `src/tools/read.ts`) unioned with
 * `abapWriteInputSchema`/`abapReadInputSchema` (v2, `src/tools/v2/
 * schemas.ts`), since a worked example does not declare which surface it
 * targets. `Object.keys(schema.shape)` (v1) / `Object.keys(schema)` (v2)
 * gives the true field set — not a hand-maintained list that could drift
 * from the real schema.
 *
 * The parser is deliberately conservative: it only matches a flat,
 * single-line `{ field, field: value, ... }` shape with no nested braces,
 * and skips (rather than guesses at) any example whose body doesn't split
 * cleanly into bare-identifier field names. That undercoverage is
 * acceptable — a false pass on a genuinely malformed example is not this
 * file's concern, test/skills-tool-surface.test.ts's Check A already covers
 * the "unknown tool name" class, and the sanity check below fails loudly if
 * the parser ever regresses to skipping everything.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WriteInput } from "../src/tools/write.js";
import { ReadInput } from "../src/tools/read.js";
import { abapWriteInputSchema, abapReadInputSchema } from "../src/tools/v2/schemas.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const skillsDir = join(repoRoot, "skills");

function listSkillFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(skillsDir, entry.name, "SKILL.md");
    try {
      readFileSync(skillFile, "utf8");
      out.push(skillFile);
    } catch {
      // No SKILL.md in this directory — not this test's concern.
    }
  }
  return out.sort();
}

const REAL_FIELDS: Record<string, Set<string>> = {
  abap_write: new Set([...Object.keys(WriteInput.shape), ...Object.keys(abapWriteInputSchema)]),
  abap_read: new Set([...Object.keys(ReadInput.shape), ...Object.keys(abapReadInputSchema)]),
};

/** Matches a flat `abap_write { ... }` / `abap_read { ... }` example — no nested braces. */
const EXAMPLE_RE = /(abap_write|abap_read)\s*\{\s*([^{}]*)\}/g;

interface ParsedExample {
  file: string;
  tool: string;
  fields: string[];
}

/**
 * Splits an example body into bare field names. Returns `undefined` (skip
 * this example) if any comma-separated entry isn't a simple `name` or
 * `name: value` shape.
 */
function parseFields(body: string): string[] | undefined {
  const fields: string[] = [];
  for (const raw of body.split(",")) {
    const token = raw.trim();
    if (token === "") continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(:.*)?$/.exec(token);
    if (!m) return undefined;
    fields.push(m[1]!);
  }
  return fields;
}

function collectExamples(): ParsedExample[] {
  const out: ParsedExample[] = [];
  for (const file of listSkillFiles()) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(EXAMPLE_RE)) {
      const tool = match[1]!;
      const fields = parseFields(match[2]!);
      if (fields === undefined) continue;
      out.push({ file, tool, fields });
    }
  }
  return out;
}

describe("skills worked examples name real fields on the real schema", () => {
  it("the parser actually found and accepted a non-trivial set of examples", () => {
    const examples = collectExamples();
    expect(
      examples.length,
      "0 examples parsed — either the skills no longer contain abap_write/abap_read " +
        "worked examples, or the conservative parser is rejecting all of them. Either way " +
        "this test's coverage claim would be vacuous.",
    ).toBeGreaterThan(0);
  });

  it("every field named in every parsed abap_write/abap_read example is a real schema key", () => {
    const examples = collectExamples();
    for (const { file, tool, fields } of examples) {
      const real = REAL_FIELDS[tool]!;
      for (const field of fields) {
        expect(real.has(field), `${file}: "${tool} { ${fields.join(", ")} }" names unknown field "${field}"`).toBe(
          true,
        );
      }
    }
  });
});
