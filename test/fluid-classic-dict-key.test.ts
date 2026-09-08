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

/**
 * Guard: pins `delete_view`'s recovery from the live 2026-09-08 bug — a
 * classic view delete raised an uncaught `CX_SY_DYN_CALL_ILLEGAL_TYPE`
 * after `DD_OBJ_DEL(del_state='A')` had already durably removed the DD25L
 * row, leaving the view stuck (DD25L gone, TADIR present) with no way to
 * finish the delete. Three things must hold:
 *   1. `DD_OBJ_DEL(del_state='A')`'s `prid` stays `-1` — the proven-live
 *      call (2026-09-04) must not be perturbed by an unverified change.
 *   2. `DD_OBJ_DEL(del_state='N')`'s `prid` is `0` — DD_OBJ_DEL's own
 *      documented default, replacing the undocumented `-1` on the one call
 *      that has never been observed to succeed live.
 *   3. Each of the three post-existence-check `CALL FUNCTION`s
 *      (`DD_OBJ_DEL` x2, `TR_TADIR_INTERFACE`) is wrapped in its own
 *      `TRY...CATCH cx_root`, reporting a distinct, greppable
 *      `delete_view/...` step label — so an escaped class-based exception
 *      names its step instead of reaching `run`'s generic catch-all with
 *      only the exception's boilerplate text.
 * A revert of any one of these three would put the live failure back.
 */
function deleteViewMethodBody(source: string): string {
  const m = /METHOD\s+delete_view\s*\.[\s\S]*?\bENDMETHOD\s*\./i.exec(source);
  if (!m) throw new Error("METHOD delete_view. ... ENDMETHOD. not found in the classic body source");
  return m[0];
}

function ddObjDelPrid(methodBody: string, delState: "A" | "N"): string {
  const re = new RegExp(
    `CALL FUNCTION 'DD_OBJ_DEL'[\\s\\S]{0,300}?del_state\\s*=\\s*'${delState}'[\\s\\S]{0,150}?prid\\s*=\\s*(-?\\d+)`,
  );
  const m = re.exec(methodBody);
  if (!m) {
    throw new Error(`DD_OBJ_DEL(del_state='${delState}') with a prid = ... argument not found in delete_view`);
  }
  return m[1];
}

const DELETE_VIEW_STEP_LABELS = ["delete_view/dd_obj_del_A", "delete_view/dd_obj_del_N", "delete_view/tr_tadir_interface"];

describe("classic body — delete_view partial-delete recovery (CX_SY_DYN_CALL_ILLEGAL_TYPE guard)", () => {
  const bodySource = classicSources.get(CLASSIC_BODY_CLASS);
  if (bodySource === undefined) throw new Error(`classicSources has no entry for ${CLASSIC_BODY_CLASS}`);
  const methodBody = deleteViewMethodBody(bodySource);

  it("DD_OBJ_DEL(del_state='A') keeps prid = -1 — the proven-live call is untouched", () => {
    expect(ddObjDelPrid(methodBody, "A")).toBe("-1");
  });

  it("DD_OBJ_DEL(del_state='N') uses prid = 0, not the undocumented -1", () => {
    expect(ddObjDelPrid(methodBody, "N")).toBe("0");
  });

  it("each risky CALL FUNCTION (2x DD_OBJ_DEL, TR_TADIR_INTERFACE) is wrapped in its own TRY...CATCH cx_root", () => {
    const catchCount = (methodBody.match(/CATCH\s+cx_root\s+INTO\s+DATA\(/g) ?? []).length;
    expect(catchCount, `expected 3 local "CATCH cx_root INTO DATA(...)" blocks in delete_view, found ${catchCount}`).toBe(3);
  });

  it("each risky step reports a distinct, greppable delete_view/... label on its CATCH cx_root path", () => {
    for (const label of DELETE_VIEW_STEP_LABELS) {
      const occurrences = methodBody.split(label).length - 1;
      expect(occurrences, `expected exactly one occurrence of step label "${label}" in delete_view, found ${occurrences}`).toBe(1);
    }
  });

  it("VIEW-DELETED still fires before VIEW-GONE — the transcript tags integration tests assert stay unchanged", () => {
    const deletedIdx = methodBody.search(/line\(\s*'VIEW-DELETED'\s*\)/);
    const goneIdx = methodBody.search(/line\(\s*'VIEW-GONE'\s*\)/);
    expect(deletedIdx, "VIEW-DELETED tag not found in delete_view").toBeGreaterThanOrEqual(0);
    expect(goneIdx, "VIEW-GONE tag not found in delete_view").toBeGreaterThanOrEqual(0);
    expect(deletedIdx, "VIEW-DELETED must still fire before VIEW-GONE").toBeLessThan(goneIdx);
  });
});
