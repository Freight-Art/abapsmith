/**
 * Guard: pins the `RS_CORR_INSERT` object-key construction inside
 * `create_view` (assembled classic body, `classicSources`). The `object`
 * parameter is a 44-char DICT key — a 4-char `VIEW` prefix plus a 40-char
 * padded view name — so the key variable must not be typed (or otherwise
 * bound) to anything CHAR30, which would truncate a view name over 26
 * characters and surface on the server as SAP message TK103.
 */
import { describe, expect, it } from "vitest";
import { CLASSIC_BODY_CLASS, classicSources } from "../src/adt/fluid/builtin/classic.js";

const FORBIDDEN_CHAR30_TYPES = /\b(ddobjname|sobj_name)\b/i;
const EXPLICIT_CHAR30 = /\bTYPE\s+c\s+LENGTH\s+30\b/i;

/**
 * Isolates `METHOD create_view. ... ENDMETHOD.` from the assembled body —
 * every lookup below must stay scoped to it, since other actions (e.g.
 * `delete_transport_entry`'s own, differently-typed `lv_object`) reuse the
 * same local variable name and would otherwise be matched by accident.
 */
function createViewMethodBody(source: string): string {
  const m = /METHOD\s+create_view\s*\.[\s\S]*?\bENDMETHOD\s*\./i.exec(source);
  if (!m) throw new Error("METHOD create_view. ... ENDMETHOD. not found in the classic body source");
  return m[0];
}

function corrInsertObjectVar(methodBody: string): string {
  const m = /CALL FUNCTION 'RS_CORR_INSERT'[\s\S]{0,200}?\bobject\s*=\s*(\w+)/.exec(methodBody);
  if (!m) throw new Error("RS_CORR_INSERT with an `object =` argument not found in create_view");
  return m[1];
}

function declarationClause(methodBody: string, varName: string): string | undefined {
  const re = new RegExp(`\\bDATA\\s+${varName}\\s+TYPE\\s+([^.\\n]+)\\.`, "i");
  return re.exec(methodBody)?.[1];
}

function isInlineDeclared(methodBody: string, varName: string): boolean {
  const re = new RegExp(`\\bDATA\\(${varName}\\)\\s*=`);
  return re.test(methodBody);
}

function assignmentLine(methodBody: string, varName: string): string {
  const lines = methodBody.split(/\r\n|\r|\n/);
  const line = lines.find((l) => new RegExp(`\\b${varName}\\b`).test(l) && l.includes("="));
  if (!line) throw new Error(`no assignment line found for ${varName} inside create_view`);
  return line;
}

describe("classic body — RS_CORR_INSERT DICT key width (TK103 guard)", () => {
  const bodySource = classicSources.get(CLASSIC_BODY_CLASS);
  if (bodySource === undefined) throw new Error(`classicSources has no entry for ${CLASSIC_BODY_CLASS}`);
  const methodBody = createViewMethodBody(bodySource);
  const varName = corrInsertObjectVar(methodBody);

  it("the RS_CORR_INSERT object key variable is not bound to a CHAR30 DDIC type", () => {
    const clause = declarationClause(methodBody, varName);
    if (clause !== undefined) {
      expect(clause).not.toMatch(FORBIDDEN_CHAR30_TYPES);
      expect(`TYPE ${clause}`).not.toMatch(EXPLICIT_CHAR30);
    } else {
      expect(
        isInlineDeclared(methodBody, varName),
        `${varName} has neither an explicit \`DATA ${varName} TYPE ...\` declaration nor an inline ` +
          `\`DATA(${varName}) =\` binding inside create_view — cannot confirm its type at all`,
      ).toBe(true);
    }
  });

  it("the constructed key is at least 44 characters wide for a maximum-length (30-char) view name", () => {
    const line = assignmentLine(methodBody, varName);
    const widthMatch = /WIDTH\s*=\s*(\d+)/.exec(line);
    expect(widthMatch, `no WIDTH clause found in: ${line}`).not.toBeNull();
    const width = Number(widthMatch![1]);
    const prefixMatch = /\|([A-Za-z0-9_]*)\{/.exec(line);
    expect(prefixMatch, `no literal-prefix template segment found in: ${line}`).not.toBeNull();
    const prefixLen = prefixMatch![1].length;
    expect(prefixLen + width, `prefix "${prefixMatch![1]}" (${prefixLen}) + WIDTH ${width} in: ${line}`).toBeGreaterThanOrEqual(44);
  });
});
