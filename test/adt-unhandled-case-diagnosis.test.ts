/**
 * `CX_SY_CASE_NOT_FOUND` ("Unexpected Case in Branch") reaching ADT.
 * Before this file's fix, `translateAdtError` had no rule for this
 * shape and it fell through to the generic UNCLASSIFIED tail, which told the
 * caller "nothing about it has actually been diagnosed" even though the
 * condition is entirely recognisable: the ABAP handler hit a CASE with no
 * matching WHEN and no WHEN OTHERS, almost always because a coded/enum field
 * in the request carried a value the object model doesn't accept — in BOPF,
 * `/BOBF/CL_CONF_MODEL_API_MAP` failing to map a model attribute.
 *
 * Pure unit — no `AbapConnection`, no network. Modelled on
 * `test/lock-conflict-ux.test.ts`'s idiom: build an ADT exception XML string,
 * turn it into a throwable with the real vendor parser (`fromException`), and
 * call `translateAdtError` directly.
 */
import { describe, expect, it } from "vitest";
import { fromException } from "abap-adt-api/build/AdtException.js";
import { translateAdtError } from "../src/adt/session.js";

const OK_XML = { "content-type": "application/xml" };

/** Replay a hand-built body through the REAL abap-adt-api error path — mirrors test/lock-conflict-ux.test.ts. */
function thrownByLibrary(status: number, statusText: string, headers: object, body: string) {
  try {
    throw fromException({ status, statusText, headers, body }, {});
  } catch (e) {
    return e;
  }
}

/**
 * Live shape reported for `add_alternative_key` (four
 * occurrences) and echoed by `test/bopf-trigger-fixes.test.ts:234`'s
 * determination-category case: a 400 `ExceptionInvalidData` whose
 * `<message>` is exactly "Unexpected Case in Branch".
 */
const UNHANDLED_CASE_XML = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionInvalidData"/>
  <message lang="EN">Unexpected Case in Branch</message>
  <localizedMessage lang="EN">Unexpected Case in Branch</localizedMessage>
  <properties/>
</exc:exception>`;

/**
 * An unrelated exception with an ordinary message and a type id that is
 * neither a lock-conflict tier (`LOCK_CONFLICT_TYPE_IDS`) nor
 * `INVALID_LOCK_HANDLE_TYPE_IDS` — must NOT be caught by the new rule.
 */
const UNRELATED_XML = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionInternalError"/>
  <message lang="EN">Division by zero in program ZFOO</message>
  <localizedMessage lang="EN">Division by zero in program ZFOO</localizedMessage>
  <properties/>
</exc:exception>`;

const ctx = { operation: "bopf-write" };

describe("CX_SY_CASE_NOT_FOUND ('Unexpected Case in Branch') gets a named diagnosis", () => {
  it("a 400 ExceptionInvalidData 'Unexpected Case in Branch' is ADT_ERROR with details.reason === UNHANDLED_CASE, not the generic unclassified hint", () => {
    const e = thrownByLibrary(400, "Bad Request", OK_XML, UNHANDLED_CASE_XML);
    const err = translateAdtError(e, ctx);

    expect(err.code).toBe("ADT_ERROR");
    expect(err.details.reason).toBe("UNHANDLED_CASE");
    expect(err.hint ?? "").not.toMatch(/was not recognised by any specific rule here/);
  });

  it("the hint names CX_SY_CASE_NOT_FOUND and tells the caller retrying cannot help", () => {
    const e = thrownByLibrary(400, "Bad Request", OK_XML, UNHANDLED_CASE_XML);
    const err = translateAdtError(e, ctx);
    const hint = err.hint ?? "";

    expect(hint).toMatch(/CX_SY_CASE_NOT_FOUND/);
    expect(hint).toMatch(/retrying the identical request cannot change the answer/i);
    expect(hint).toMatch(/\/BOBF\/CL_CONF_MODEL_API_MAP/);
  });

  it("details.status and details.adtExceptionType still survive onto the error — nothing the unclassified tail used to provide was lost", () => {
    const e = thrownByLibrary(400, "Bad Request", OK_XML, UNHANDLED_CASE_XML);
    const err = translateAdtError(e, ctx);

    expect(err.details.status).toBe(400);
    expect(err.details.adtExceptionType).toBe("ExceptionInvalidData");
  });

  it("NEGATIVE: an unrelated ADT exception (ExceptionResourceNoAccess, ordinary message) still falls through to the unclassified tail", () => {
    const e = thrownByLibrary(403, "Forbidden", OK_XML, UNRELATED_XML);
    const err = translateAdtError(e, ctx);

    expect(err.code).toBe("ADT_ERROR");
    expect(err.details.reason).toBeUndefined();
    expect(err.hint ?? "").toMatch(/was not recognised by any specific rule here/);
  });

  it("ORDERING: a response that is BOTH a session death and carries this message is still classified SESSION_DEAD, not ADT_ERROR", () => {
    // Mirrors test/session-death-oracle.test.ts's `throwFor`: an
    // AdtErrorException-shaped throw whose `.response` is what
    // `classifySessionFailure` (run FIRST in translateAdtError) actually
    // reads — a 500 whose body carries the structural short-dump marker
    // `class="errorTextHeader"` (see DUMP_STRUCTURAL_MARKERS in
    // src/adt/session.ts). `fromException` cannot be made to carry a
    // `.response` for this shape, so the throwable is built by hand instead.
    const body = `<html><body><span class="errorTextHeader">Unexpected Case in Branch</span></body></html>`;
    const e = Object.assign(new Error("Unexpected Case in Branch"), {
      err: 500,
      type: "ExceptionInvalidData",
      properties: {},
      response: {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "content-type": "text/html" },
        body,
      },
    });

    const err = translateAdtError(e, ctx);
    expect(err.code).toBe("SESSION_DEAD");
    expect(err.details.reason).not.toBe("UNHANDLED_CASE");
  });
});
