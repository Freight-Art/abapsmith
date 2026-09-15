/**
 * `src/adt/fluid/builtin/classic/abap-shlp.ts` — structural assertions over
 * the STATIC generated-ABAP source for the search-help (`SHLP/DH`) bridge
 * (`shlpPart`, the three methods `create_search_help`/`update_search_help`/
 * `delete_search_help` bundled into the fluid `classic` tool via
 * `src/adt/fluid/builtin/classic.ts`). Every caller value is read at RUNTIME
 * via `s()`/`b()`/`n()` against a JSON argument string — the deployed class
 * body is a single fixed, argument-independent string — so these tests scan
 * `shlpPart.source` for shape (order, table/type names, shared structure),
 * same idiom as `test/tran-create.test.ts`'s `tranPart.source` scans.
 *
 * The "no hardcoded row cap (`UP TO <n> ROWS` / `c_max_rows`-style
 * constant)" property is deliberately NOT re-checked here:
 * `test/fluid-builtin-manifests.test.ts` already asserts it across every
 * `BUILTIN_FLUID_TOOLS` entry, including `abap-shlp.ts` via the `classic`
 * tool's bundled `shlpPart` — duplicating it here would just be the same
 * regex run twice.
 */
import { describe, expect, it } from "vitest";
import { shlpPart } from "../src/adt/fluid/builtin/classic/abap-shlp.js";

const source = shlpPart.source;

/** Slices out one `METHOD <name>. ... ENDMETHOD.` body from the static source. */
function methodBody(name: string): string {
  const start = source.indexOf(`METHOD ${name}.`);
  if (start === -1) throw new Error(`method ${name} not found in shlpPart.source`);
  const end = source.indexOf("ENDMETHOD.", start);
  if (end === -1) throw new Error(`ENDMETHOD. for ${name} not found`);
  return source.slice(start, end + "ENDMETHOD.".length);
}

const createBody = methodBody("create_search_help");
const updateBody = methodBody("update_search_help");
const deleteBody = methodBody("delete_search_help");

describe("shlpPart: manifest shape", () => {
  it("declares exactly the three methods this file implements", () => {
    expect(shlpPart.methods).toEqual(["create_search_help", "update_search_help", "delete_search_help"]);
  });

  it("source contains a METHOD/ENDMETHOD pair for each declared method, in declared order", () => {
    const positions = shlpPart.methods.map((m) => source.indexOf(`METHOD ${m}.`));
    for (const p of positions) expect(p).toBeGreaterThanOrEqual(0);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe("create_search_help: existence pre-check runs BEFORE RS_CORR_INSERT", () => {
  it("checks DD30L for an existing row before RS_CORR_INSERT is ever called", () => {
    const existsCheck = createBody.indexOf("already exists");
    const corrInsert = createBody.indexOf("RS_CORR_INSERT");
    expect(existsCheck).toBeGreaterThanOrEqual(0);
    expect(corrInsert).toBeGreaterThan(existsCheck);
  });

  it("the existence pre-check RETURNs (via fail()) before falling through to RS_CORR_INSERT", () => {
    // Confirms this isn't just textual order but control-flow order: the
    // fail()/RETURN. pair sits between the SELECT COUNT and RS_CORR_INSERT,
    // not after it.
    const selectIdx = createBody.indexOf("SELECT COUNT( * ) FROM dd30l");
    const failIdx = createBody.indexOf("fail( |search help", selectIdx);
    const returnIdx = createBody.indexOf("RETURN.", failIdx);
    const corrInsertIdx = createBody.indexOf("RS_CORR_INSERT");
    expect(selectIdx).toBeGreaterThanOrEqual(0);
    expect(failIdx).toBeGreaterThan(selectIdx);
    expect(returnIdx).toBeGreaterThan(failIdx);
    expect(returnIdx).toBeLessThan(corrInsertIdx);
  });

  it('rejects an ALREADY-EXISTING search help ("already exists"), not a missing one — the existence pre-check itself, not the unrelated "selection method ... does not exist as a" validation shared by both methods', () => {
    expect(createBody).toContain("search help { lv_shlp_probe } already exists");
    expect(createBody).not.toContain("search help { lv_shlp_probe } does not exist");
  });
});

describe("update_search_help: existence pre-check runs BEFORE RS_CORR_INSERT, with the opposite polarity", () => {
  it("checks DD30L for a MISSING row before RS_CORR_INSERT is ever called", () => {
    const existsCheck = updateBody.indexOf("does not exist");
    const corrInsert = updateBody.indexOf("RS_CORR_INSERT");
    expect(existsCheck).toBeGreaterThanOrEqual(0);
    expect(corrInsert).toBeGreaterThan(existsCheck);
  });

  it('rejects a MISSING search help ("does not exist"), not an existing one', () => {
    expect(updateBody).toContain("does not exist");
    expect(updateBody).not.toContain("already exists");
  });

  it("emits a ZMCP-DDIC-NOTE warning that DDIF_SHLP_PUT replaces the whole definition — create_search_help does not, since there is nothing yet to replace", () => {
    expect(updateBody).toContain("ZMCP-DDIC-NOTE> DDIF_SHLP_PUT replaces the whole definition");
    expect(createBody).not.toContain("replaces the whole definition");
  });
});

describe("method-local table types — DD31VTAB/DD32PTAB/DD33VTAB do not exist on this release", () => {
  it("declares method-local TYPES tt_dd31v/tt_dd32p/tt_dd33v standard tables of dd31v/dd32p/dd33v", () => {
    expect(source).toContain("TYPES tt_dd31v TYPE STANDARD TABLE OF dd31v WITH DEFAULT KEY.");
    expect(source).toContain("TYPES tt_dd32p TYPE STANDARD TABLE OF dd32p WITH DEFAULT KEY.");
    expect(source).toContain("TYPES tt_dd33v TYPE STANDARD TABLE OF dd33v WITH DEFAULT KEY.");
  });

  it("never references the global table types DD31VTAB/DD32PTAB/DD33VTAB — they fail the syntax check on this release", () => {
    expect(source).not.toMatch(/\bDD31VTAB\b/i);
    expect(source).not.toMatch(/\bDD32PTAB\b/i);
    expect(source).not.toMatch(/\bDD33VTAB\b/i);
  });

  it("the DDIF_SHLP_PUT call passes the local lt_dd31v/lt_dd32p/lt_dd33v tables, not a global-typed one", () => {
    const putCall = source.indexOf("CALL FUNCTION 'DDIF_SHLP_PUT'");
    const tablesBlock = source.slice(putCall, source.indexOf("EXCEPTIONS", putCall));
    expect(tablesBlock).toContain("dd31v_tab = lt_dd31v");
    expect(tablesBlock).toContain("dd32p_tab = lt_dd32p");
    expect(tablesBlock).toContain("dd33v_tab = lt_dd33v");
  });
});

describe.each([
  ["create_search_help", createBody],
  ["update_search_help", updateBody],
] as const)("%s: call order RS_CORR_INSERT -> DDIF_SHLP_PUT -> DDIF_SHLP_ACTIVATE", (_name, body) => {
  it("RS_CORR_INSERT precedes DDIF_SHLP_PUT precedes DDIF_SHLP_ACTIVATE", () => {
    const corrInsert = body.indexOf("CALL FUNCTION 'RS_CORR_INSERT'");
    const shlpPut = body.indexOf("CALL FUNCTION 'DDIF_SHLP_PUT'");
    const shlpActivate = body.indexOf("CALL FUNCTION 'DDIF_SHLP_ACTIVATE'");
    expect(corrInsert).toBeGreaterThanOrEqual(0);
    expect(shlpPut).toBeGreaterThan(corrInsert);
    expect(shlpActivate).toBeGreaterThan(shlpPut);
  });

  it("emits SHLP-REGISTERED after RS_CORR_INSERT, SHLP-PUT after DDIF_SHLP_PUT, SHLP-ACTIVATED after DDIF_SHLP_ACTIVATE, in that order", () => {
    const tags = [...body.matchAll(/line\(\s*'(SHLP-[A-Z]+)'\s*\)/g)].map((m) => m[1]!);
    expect(tags).toEqual(["SHLP-REGISTERED", "SHLP-PUT", "SHLP-ACTIVATED"]);
  });

  it("commits work after DDIF_SHLP_PUT (before activation) and again after DDIF_SHLP_ACTIVATE — DDIF_SHLP_PUT is an uncommitted, update-task-style write", () => {
    const shlpPut = body.indexOf("CALL FUNCTION 'DDIF_SHLP_PUT'");
    const shlpActivate = body.indexOf("CALL FUNCTION 'DDIF_SHLP_ACTIVATE'");
    const firstCommit = body.indexOf("COMMIT WORK.");
    const secondCommit = body.indexOf("COMMIT WORK.", firstCommit + 1);
    expect(firstCommit).toBeGreaterThan(shlpPut);
    expect(firstCommit).toBeLessThan(shlpActivate);
    expect(secondCommit).toBeGreaterThan(shlpActivate);
  });

  it("checks sy-subrc after each of the three calls and fail()s+RETURNs rather than continuing silently", () => {
    for (const fm of ["RS_CORR_INSERT", "DDIF_SHLP_PUT", "DDIF_SHLP_ACTIVATE"]) {
      const callIdx = body.indexOf(`CALL FUNCTION '${fm}'`);
      const nextCallIdx = (() => {
        const rest = ["RS_CORR_INSERT", "DDIF_SHLP_PUT", "DDIF_SHLP_ACTIVATE"]
          .map((n) => body.indexOf(`CALL FUNCTION '${n}'`, callIdx + 1))
          .filter((i) => i >= 0);
        return rest.length > 0 ? Math.min(...rest) : body.length;
      })();
      const segment = body.slice(callIdx, nextCallIdx);
      expect(segment).toContain("sy-subrc <> 0");
      expect(segment).toContain("fail(");
      expect(segment).toContain("RETURN.");
    }
  });
});

describe.each([
  ["create_search_help", createBody],
  ["update_search_help", updateBody],
] as const)(
  "%s: include and assignment references are checked against the live catalogue before RS_CORR_INSERT (issue #83, DH109)",
  (_name, body) => {
    it("loops lt_dd31v and fails with DH109/inactive-only wording when an include's search help does not exist as active, before RS_CORR_INSERT", () => {
      const dd31Loop = body.indexOf("LOOP AT lt_dd31v INTO ls_dd31v.");
      const dd30lCheck = body.indexOf("SELECT COUNT( * ) FROM dd30l INTO @lv_ref_count", dd31Loop);
      const failIdx = body.indexOf("does not exist - ", dd30lCheck);
      const returnIdx = body.indexOf("RETURN.", failIdx);
      const endLoop = body.indexOf("ENDLOOP.", returnIdx);
      const corrInsert = body.indexOf("CALL FUNCTION 'RS_CORR_INSERT'");
      expect(dd31Loop).toBeGreaterThanOrEqual(0);
      expect(dd30lCheck).toBeGreaterThan(dd31Loop);
      expect(body.slice(dd30lCheck, dd30lCheck + 160)).toContain("as4local = 'A'");
      expect(failIdx).toBeGreaterThan(dd30lCheck);
      expect(body.slice(failIdx, failIdx + 200)).toContain("DH109");
      expect(body.slice(failIdx, failIdx + 200)).toContain("inactive-only");
      expect(returnIdx).toBeGreaterThan(failIdx);
      expect(endLoop).toBeGreaterThan(returnIdx);
      expect(corrInsert).toBeGreaterThan(endLoop);
    });

    it("loops lt_dd33v and fails with DH109 wording when an assignment's SUBFIELD is not an interface parameter of its SUBSHLP in DD32S, before RS_CORR_INSERT", () => {
      const dd33Loop = body.indexOf("LOOP AT lt_dd33v INTO ls_dd33v.");
      const dd32sCheck = body.indexOf("SELECT COUNT( * ) FROM dd32s INTO @lv_ref_count", dd33Loop);
      const failIdx = body.indexOf("is not an interface", dd32sCheck);
      const returnIdx = body.indexOf("RETURN.", failIdx);
      const endLoop = body.indexOf("ENDLOOP.", returnIdx);
      const corrInsert = body.indexOf("CALL FUNCTION 'RS_CORR_INSERT'");
      expect(dd33Loop).toBeGreaterThanOrEqual(0);
      expect(dd32sCheck).toBeGreaterThan(dd33Loop);
      const checkLine = body.slice(dd32sCheck, dd32sCheck + 200);
      expect(checkLine).toContain("shlpname = @ls_dd33v-subshlp");
      expect(checkLine).toContain("fieldname = @ls_dd33v-subfield");
      expect(checkLine).toContain("as4local = 'A'");
      expect(failIdx).toBeGreaterThan(dd32sCheck);
      expect(body.slice(failIdx, failIdx + 200)).toContain("DH109");
      expect(returnIdx).toBeGreaterThan(failIdx);
      expect(endLoop).toBeGreaterThan(returnIdx);
      expect(corrInsert).toBeGreaterThan(endLoop);
    });

    it("skips the DD32S catalogue lookup for an assignment whose SUBSHLP is the search help itself, via CONTINUE before the SELECT", () => {
      const dd33Loop = body.indexOf("LOOP AT lt_dd33v INTO ls_dd33v.");
      const selfCheck = body.indexOf("ls_dd33v-subshlp = lv_shlp", dd33Loop);
      const continueIdx = body.indexOf("CONTINUE.", selfCheck);
      const dd32sCheck = body.indexOf("SELECT COUNT( * ) FROM dd32s INTO @lv_ref_count", dd33Loop);
      expect(selfCheck).toBeGreaterThan(dd33Loop);
      expect(continueIdx).toBeGreaterThan(selfCheck);
      expect(dd32sCheck).toBeGreaterThan(continueIdx);
    });
  },
);

describe.each([
  ["create_search_help", createBody],
  ["update_search_help", updateBody],
] as const)("%s: DDIF_SHLP_ACTIVATE rc=4 (DH108, activated with warnings) is a success, but is reported, not swallowed", (_name, body) => {
  it("keeps rc=4 out of the sy-subrc escalation (only rc > 4 becomes a failure)", () => {
    expect(body).toContain("IF sy-subrc = 0 AND lv_rc > 4.");
  });

  it("emits a ZMCP-DDIC-NOTE for rc=4 between DDIF_SHLP_ACTIVATE's hard-failure check and the SHLP-ACTIVATED tag", () => {
    const activate = body.indexOf("CALL FUNCTION 'DDIF_SHLP_ACTIVATE'");
    const hardFail = body.indexOf("DDIF_SHLP_ACTIVATE failed", activate);
    const rc4Guard = body.indexOf("IF lv_rc = 4.", hardFail);
    const note = body.indexOf("ZMCP-DDIC-NOTE> DDIF_SHLP_ACTIVATE returned rc=4", rc4Guard);
    const activatedTag = body.indexOf("line( 'SHLP-ACTIVATED' )", note);
    expect(activate).toBeGreaterThanOrEqual(0);
    expect(hardFail).toBeGreaterThan(activate);
    expect(rc4Guard).toBeGreaterThan(hardFail);
    expect(note).toBeGreaterThan(rc4Guard);
    expect(activatedTag).toBeGreaterThan(note);
    expect(body.slice(note, note + 220)).toContain("activated with warnings");
  });
});

describe("create_search_help and update_search_help share the same fill/dispatch logic (a structural guarantee, not a text-duplication test)", () => {
  it("the segment from the DD30V fill through the final COMMIT WORK is identical between create and update once update's one extra ZMCP-DDIC-NOTE line and incidental blank-line spacing are normalised away", () => {
    // Both methods are built from the SAME `PUT_LOCALS`/`PUT_ACTIVATE`
    // template-string constants in abap-shlp.ts (module-private, not
    // exported) — this asserts that guarantee from the outside, without
    // assuming the module's internal factoring: strip update's one extra
    // ZMCP-DDIC-NOTE line (present only because update inserts it between
    // PUT_LOCALS and PUT_ACTIVATE) and collapse repeated blank lines in
    // both, then the two bodies' shared tail must match exactly.
    const marker = "DATA ls_dd30v TYPE dd30v.";
    const createTail = createBody.slice(createBody.indexOf(marker));
    const updateTail = updateBody.slice(updateBody.indexOf(marker));
    const stripNote = (s: string) =>
      s.replace(
        /line\( \|ZMCP-DDIC-NOTE> DDIF_SHLP_PUT replaces the whole definition:[\s\S]*?is removed\| \)\.\n?/,
        "",
      );
    const normalize = (s: string) =>
      stripNote(s)
        .replace(/[ \t]+\n/g, "\n") // trailing whitespace on an otherwise-blank line
        .replace(/\n{2,}/g, "\n")
        .trim();
    expect(createTail.length).toBeGreaterThan(500); // sanity: not comparing two empty strings
    expect(normalize(updateTail)).toBe(normalize(createTail));
  });

  it("both methods fill DD30V-ISSIMPLE from the same elementary flag and validate the same import/export rule before registering anything", () => {
    for (const body of [createBody, updateBody]) {
      expect(body).toContain("IF lv_elementary = abap_true.\n      ls_dd30v-issimple = 'X'.");
      expect(body).toContain("a search help needs at least one import and one export parameter");
      const validation = body.indexOf("a search help needs at least one import");
      const corrInsert = body.indexOf("CALL FUNCTION 'RS_CORR_INSERT'");
      expect(validation).toBeGreaterThanOrEqual(0);
      expect(validation).toBeLessThan(corrInsert);
    }
  });

  it("both methods validate the selection method and every field against the live dictionary before RS_CORR_INSERT", () => {
    for (const body of [createBody, updateBody]) {
      const selMethodCheck = body.indexOf("does not exist as a");
      const fieldCheck = body.indexOf("is not a field of selection method");
      const corrInsert = body.indexOf("CALL FUNCTION 'RS_CORR_INSERT'");
      expect(selMethodCheck).toBeGreaterThanOrEqual(0);
      expect(fieldCheck).toBeGreaterThanOrEqual(0);
      expect(selMethodCheck).toBeLessThan(corrInsert);
      expect(fieldCheck).toBeLessThan(corrInsert);
    }
  });
});

describe("delete_search_help: where-used guard runs before any deletion, and is gated by confirm_in_use", () => {
  it("checks DD04L (data elements), DD35L (field attachments) and DD31S (collective search helps), all filtered to AS4LOCAL = 'A', before DD_OBJ_DEL", () => {
    const dtel = deleteBody.indexOf("FROM dd04l");
    const att = deleteBody.indexOf("FROM dd35l");
    const inc = deleteBody.indexOf("FROM dd31s");
    const objDel = deleteBody.indexOf("CALL FUNCTION 'DD_OBJ_DEL'");
    expect(dtel).toBeGreaterThanOrEqual(0);
    expect(att).toBeGreaterThanOrEqual(0);
    expect(inc).toBeGreaterThanOrEqual(0);
    expect(objDel).toBeGreaterThan(dtel);
    expect(objDel).toBeGreaterThan(att);
    expect(objDel).toBeGreaterThan(inc);
    for (const idx of [dtel, att, inc]) {
      expect(deleteBody.slice(idx, idx + 120)).toContain("as4local = 'A'");
    }
  });

  it("refuses to delete an in-use search help unless confirm_in_use is set, before DD_OBJ_DEL runs", () => {
    const guard = deleteBody.indexOf("b( 'confirm_in_use' ) = abap_false");
    const fail = deleteBody.indexOf("is in use:", guard);
    const objDel = deleteBody.indexOf("CALL FUNCTION 'DD_OBJ_DEL'");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(fail).toBeGreaterThan(guard);
    expect(fail).toBeLessThan(objDel);
  });

  it("proves absence (re-reads DD30L and TADIR) before declaring SHLP-GONE, rather than trusting a non-error return", () => {
    const goneTag = deleteBody.indexOf("line( 'SHLP-GONE' )");
    const reread = deleteBody.lastIndexOf("SELECT COUNT( * ) FROM dd30l", goneTag);
    expect(reread).toBeGreaterThanOrEqual(0);
    expect(reread).toBeLessThan(goneTag);
  });
});

describe("delete_search_help: the DD31S in-use COUNT excludes the search help's own self-row (issue #83)", () => {
  it("adds shlpname <> @lv_shlp alongside subshlp = @lv_shlp, so an elementary help's own DD31S row never counts as in-use", () => {
    // SAP itself writes a DD31S row with SUBSHLP = SHLPNAME (SHPOSITION 0001)
    // for an elementary search help's own interface — measured live on A4H
    // 2026-09-15 across five standard SAP elementary helps (/UI2/GROUPS_SH,
    // /AIF/MESSAGE_CLID_SHLP, /UI5/PURPOSE, /BA1/F4_FX_RATETYPE,
    // /AIF/FILEDIALOG), each returning exactly one DD31S row with
    // SUBSHLP = SHLPNAME. Without excluding that self-row, every elementary
    // help this bridge creates would be reported "in use" — and hence
    // undeletable without confirm_in_use — forever.
    const countIdx = deleteBody.indexOf("SELECT COUNT( * ) FROM dd31s");
    expect(countIdx).toBeGreaterThanOrEqual(0);
    const line = deleteBody.slice(countIdx, deleteBody.indexOf("\n", countIdx));
    expect(line).toContain("subshlp = @lv_shlp");
    expect(line).toContain("shlpname <> @lv_shlp");
  });
});

describe("delete_search_help: an inactive-only object (create PUT but never activated) does not hard-fail the active-state delete (issue #83)", () => {
  it("counts DD30L's active and inactive rows separately, right after the existence check and before the where-used guard", () => {
    const existsCheck = deleteBody.indexOf("does not exist");
    const activeCount = deleteBody.indexOf("SELECT COUNT( * ) FROM dd30l INTO @lv_active_count");
    const inactiveCount = deleteBody.indexOf("SELECT COUNT( * ) FROM dd30l INTO @lv_inactive_count");
    const whereUsed = deleteBody.indexOf("FROM dd04l");
    expect(activeCount).toBeGreaterThan(existsCheck);
    expect(deleteBody.slice(activeCount, activeCount + 120)).toContain("as4local = 'A'");
    expect(inactiveCount).toBeGreaterThan(activeCount);
    expect(deleteBody.slice(inactiveCount, inactiveCount + 120)).toContain("as4local <> 'A'");
    expect(whereUsed).toBeGreaterThan(inactiveCount);
  });

  it("emits a ZMCP-DDIC-NOTE when the active count is zero but the inactive count is not, describing a create that PUT but failed to activate", () => {
    const noteIdx = deleteBody.indexOf("exists only as an inactive version");
    expect(noteIdx).toBeGreaterThanOrEqual(0);
    const guardIdx = deleteBody.lastIndexOf(
      "IF lv_active_count = 0 AND lv_inactive_count > 0.",
      noteIdx,
    );
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(noteIdx).toBeGreaterThan(guardIdx);
  });

  it("guards the del_state = 'A' DD_OBJ_DEL failure check with lv_active_count > 0 — a non-zero sy-subrc only hard-fails when an active version existed", () => {
    const delA = deleteBody.indexOf("del_state   = 'A'");
    const delN = deleteBody.indexOf("del_state   = 'N'");
    expect(delA).toBeGreaterThanOrEqual(0);
    expect(delN).toBeGreaterThan(delA);
    const segment = deleteBody.slice(delA, delN);

    // The hard fail() + RETURN. is reachable only inside an
    // "IF lv_active_count > 0." guard, not unconditionally on sy-subrc <> 0.
    const subrcIdx = segment.indexOf("IF sy-subrc <> 0.");
    const activeGuardIdx = segment.indexOf("IF lv_active_count > 0.", subrcIdx);
    const failIdx = segment.indexOf("fail( |DD_OBJ_DEL failed", activeGuardIdx);
    expect(subrcIdx).toBeGreaterThanOrEqual(0);
    expect(activeGuardIdx).toBeGreaterThan(subrcIdx);
    expect(failIdx).toBeGreaterThan(activeGuardIdx);

    // The tolerant path (no active version) records a note instead, and does
    // not RETURN — it falls through to the del_state = 'N' call.
    const toleratedNoteIdx = segment.indexOf("not treated as an error");
    expect(toleratedNoteIdx).toBeGreaterThan(failIdx);
  });

  it("still fails on a genuinely raised exception (CATCH cx_root) from the del_state = 'A' call regardless of the active count", () => {
    const delA = deleteBody.indexOf("del_state   = 'A'");
    const catchIdx = deleteBody.indexOf("CATCH cx_root INTO DATA(lx_del_a)", delA);
    const raisedFailIdx = deleteBody.indexOf("dd_obj_del_A raised", catchIdx);
    expect(catchIdx).toBeGreaterThan(delA);
    expect(raisedFailIdx).toBeGreaterThan(catchIdx);
    expect(deleteBody.slice(catchIdx, raisedFailIdx + 200)).toContain("RETURN.");
  });
});

describe("create/update: a blank selection method skips BOTH the method-existence and the field-existence checks (issue #83)", () => {
  it("IF lv_selmethod IS INITIAL exists, and the ELSE branch — not the IF branch — contains the DD02L/DD25L and DD03L/DD27S checks", () => {
    for (const body of [createBody, updateBody]) {
      const ifIdx = body.indexOf("IF lv_selmethod IS INITIAL.");
      expect(ifIdx).toBeGreaterThanOrEqual(0);
      const elseIdx = body.indexOf("ELSE.", ifIdx);
      expect(elseIdx).toBeGreaterThan(ifIdx);

      const selMethodCheckIdx = body.indexOf("does not exist as a", ifIdx);
      const fieldCheckIdx = body.indexOf("is not a field of selection method", ifIdx);
      expect(selMethodCheckIdx).toBeGreaterThan(elseIdx);
      expect(fieldCheckIdx).toBeGreaterThan(elseIdx);

      // Nothing between the IF and its ELSE names dd02l/dd25l/dd03l/dd27s —
      // the whole-branch skip is real, not just the fail() text moved down.
      const ifBranch = body.slice(ifIdx, elseIdx);
      expect(ifBranch).not.toMatch(/\bdd02l\b|\bdd25l\b|\bdd03l\b|\bdd27s\b/i);
    }
  });

  it("emits a ZMCP-DDIC-NOTE explaining a blank selection method inside the IF branch (collective help or search-help exit)", () => {
    for (const body of [createBody, updateBody]) {
      const ifIdx = body.indexOf("IF lv_selmethod IS INITIAL.");
      const elseIdx = body.indexOf("ELSE.", ifIdx);
      const noteIdx = body.indexOf("ZMCP-DDIC-NOTE> no selection method was given", ifIdx);
      expect(noteIdx).toBeGreaterThan(ifIdx);
      expect(noteIdx).toBeLessThan(elseIdx);
    }
  });

  it("still assigns ls_dd30v-selmethod unconditionally (from lv_selmethod, blank or not) after the whole IF/ELSE structure", () => {
    // Anchored on the "--- fill DD30V ---" marker rather than counting
    // ENDIF.s: the ELSE branch nests several of its own (the method-existence
    // check, the field-loop's IF, the DO...ENDDO), so naively taking "the
    // Nth ENDIF." after the IF would land inside the ELSE branch, not past
    // it.
    for (const body of [createBody, updateBody]) {
      const ifIdx = body.indexOf("IF lv_selmethod IS INITIAL.");
      const fillMarkerIdx = body.indexOf("--- fill DD30V");
      const assignIdx = body.indexOf("ls_dd30v-selmethod", fillMarkerIdx);
      expect(fillMarkerIdx).toBeGreaterThan(ifIdx);
      expect(assignIdx).toBeGreaterThan(fillMarkerIdx);
      expect(body.slice(assignIdx, assignIdx + 40)).toContain("= lv_selmethod.");
    }
  });
});

describe("scope — this bridge only ever targets SHLP objects", () => {
  it("RS_CORR_INSERT is always called with object_class = 'DICT' and an object token prefixed SHLP", () => {
    expect(createBody).toContain("object_class = 'DICT'");
    expect(createBody).toContain("|SHLP{ lv_shlp WIDTH = 40 ALIGN = LEFT }|");
  });

  it("delete_search_help only ever targets TADIR object 'SHLP', never another object type", () => {
    const objectMatches = [...deleteBody.matchAll(/wi_tadir_object\s*=\s*'([^']+)'/g)].map((m) => m[1]!);
    expect(objectMatches.length).toBeGreaterThan(0);
    expect(objectMatches.every((o) => o === "SHLP")).toBe(true);
  });
});
