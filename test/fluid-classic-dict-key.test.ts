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
  const objectVar = m[1];
  if (objectVar === undefined) {
    throw new Error("RS_CORR_INSERT's `object = ...` capture group did not match in create_view");
  }
  return objectVar;
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
    if (!widthMatch) throw new Error(`no WIDTH clause found in: ${line}`);
    const widthStr = widthMatch[1];
    if (widthStr === undefined) {
      throw new Error(`WIDTH clause capture group did not match in: ${line}`);
    }
    const width = Number(widthStr);
    const prefixMatch = /\|([A-Za-z0-9_]*)\{/.exec(line);
    if (!prefixMatch) throw new Error(`no literal-prefix template segment found in: ${line}`);
    const prefix = prefixMatch[1];
    if (prefix === undefined) {
      throw new Error(`literal-prefix capture group did not match in: ${line}`);
    }
    const prefixLen = prefix.length;
    expect(prefixLen + width, `prefix "${prefix}" (${prefixLen}) + WIDTH ${width} in: ${line}`).toBeGreaterThanOrEqual(44);
  });
});

/**
 * Guard: pins `delete_view`'s recovery from the live 2026-09-08 bug — a
 * classic view delete raised an uncaught `CX_SY_DYN_CALL_ILLEGAL_TYPE`
 * after `DD_OBJ_DEL(del_state='A')` had already durably removed the DD25L
 * row, leaving the view stuck (DD25L gone, TADIR present) with no way to
 * finish the delete. The 2026-09-08 live run, with the instrumentation
 * from item 3 below in place, proved the failure was in `TR_TADIR_INTERFACE`
 * only — both `DD_OBJ_DEL` calls completed. Three things must hold:
 *   1. `DD_OBJ_DEL(del_state='A')`'s `prid` stays `-1` — the proven-live
 *      call (2026-09-04, reconfirmed 2026-09-08) must not be perturbed.
 *   2. `DD_OBJ_DEL(del_state='N')`'s `prid` is also `-1` — the live run
 *      disproved the earlier prid=0 hypothesis; both calls now agree,
 *      matching the base commit and the path proven live.
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
  const prid = m[1];
  if (prid === undefined) {
    throw new Error(`DD_OBJ_DEL(del_state='${delState}')'s prid = ... capture group did not match in delete_view`);
  }
  return prid;
}

const DELETE_VIEW_STEP_LABELS = ["delete_view/dd_obj_del_A", "delete_view/dd_obj_del_N", "delete_view/tr_tadir_interface"];

describe("classic body — delete_view partial-delete recovery (CX_SY_DYN_CALL_ILLEGAL_TYPE guard)", () => {
  const bodySource = classicSources.get(CLASSIC_BODY_CLASS);
  if (bodySource === undefined) throw new Error(`classicSources has no entry for ${CLASSIC_BODY_CLASS}`);
  const methodBody = deleteViewMethodBody(bodySource);

  it("DD_OBJ_DEL(del_state='A') keeps prid = -1 — the proven-live call is untouched", () => {
    expect(ddObjDelPrid(methodBody, "A")).toBe("-1");
  });

  it("DD_OBJ_DEL(del_state='N') keeps prid = -1 — the disproven prid=0 experiment was reverted", () => {
    expect(ddObjDelPrid(methodBody, "N")).toBe("-1");
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

/**
 * Guard: pins the fix for the 2026-09-08 live `TR_TADIR_INTERFACE` failure.
 * Live, passing `lv_view` (declared `TYPE dd25l-viewname` — not a `string`;
 * an earlier round of this fix mistakenly assumed it was inferred `string`,
 * confusing it with `create_view`'s unrelated `lv_object`) directly as
 * `WI_TADIR_OBJ_NAME` raised `CX_SY_DYN_CALL_ILLEGAL_TYPE`, even though the
 * same value passed fine to `DD_OBJ_DEL`. Why `TR_TADIR_INTERFACE` rejected
 * it — a width mismatch between `dd25l-viewname` and `tadir-obj_name`, or
 * something else about how the parameter is typed — is not established
 * from this repo alone; there is no DDIC catalogue here to check either
 * field's real width against. Four things must hold regardless:
 *   1. `lv_view` keeps its own declared type (`DD25L-VIEWNAME`) —
 *      untouched, since `create_view` depends on it staying that way.
 *   2. A separate local, typed to a real DDIC field (`TADIR-OBJ_NAME`), is
 *      declared for the TADIR call.
 *   3. `TR_TADIR_INTERFACE`'s `wi_tadir_obj_name` argument is that typed
 *      local, not `lv_view` directly.
 *   4. Before the call, the typed local is checked back against `lv_view`
 *      so any mismatch between the two (truncation or otherwise) fails
 *      loudly instead of silently deleting the wrong TADIR row — this
 *      guard is what makes the fix safe without needing to know the
 *      unresolved width question above.
 */
describe("classic body — delete_view TR_TADIR_INTERFACE typed argument (CX_SY_DYN_CALL_ILLEGAL_TYPE fix)", () => {
  const bodySource = classicSources.get(CLASSIC_BODY_CLASS);
  if (bodySource === undefined) throw new Error(`classicSources has no entry for ${CLASSIC_BODY_CLASS}`);
  const methodBody = deleteViewMethodBody(bodySource);

  it("lv_view keeps its own DD25L-VIEWNAME declaration, unperturbed by the TADIR fix", () => {
    expect(methodBody).toMatch(/\bDATA\s+lv_view\s+TYPE\s+dd25l-viewname\s*\./i);
  });

  it("a separate local is declared with a real DDIC field type for the TADIR call, not lv_view's own type", () => {
    const m = /\bDATA\s+(\w+)\s+TYPE\s+tadir-obj_name\s*\./i.exec(methodBody);
    expect(m, "no `DATA <var> TYPE tadir-obj_name.` declaration found in delete_view").not.toBeNull();
  });

  it("TR_TADIR_INTERFACE's wi_tadir_obj_name argument is the typed local, not lv_view directly", () => {
    const callMatch = /CALL FUNCTION 'TR_TADIR_INTERFACE'[\s\S]{0,400}?wi_tadir_obj_name\s*=\s*(\w+)/.exec(methodBody);
    expect(callMatch, "wi_tadir_obj_name = ... argument not found on TR_TADIR_INTERFACE").not.toBeNull();
    const argVar = callMatch![1];
    expect(argVar, "wi_tadir_obj_name must not be bound directly to lv_view").not.toBe("lv_view");
    const declMatch = new RegExp(`\\bDATA\\s+${argVar}\\s+TYPE\\s+tadir-obj_name\\s*\\.`, "i");
    expect(declMatch.test(methodBody), `${argVar} passed to wi_tadir_obj_name is not declared TYPE tadir-obj_name`).toBe(true);
  });

  it("the typed local is checked back against lv_view (a truncation guard) before the TADIR call", () => {
    const callIdx = methodBody.search(/CALL FUNCTION 'TR_TADIR_INTERFACE'/);
    expect(callIdx, "TR_TADIR_INTERFACE call not found").toBeGreaterThanOrEqual(0);
    const preamble = methodBody.slice(0, callIdx);
    const guardMatch = /IF\s+(\w+)\s*<>\s*lv_view\s*\.\s*[\s\S]{0,200}?RETURN\s*\./i.exec(preamble);
    expect(guardMatch, "no `IF <var> <> lv_view. ... RETURN.` truncation guard found before the TADIR call").not.toBeNull();
  });
});
