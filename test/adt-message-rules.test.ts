/**
 * Coverage for `src/adt/adt-message-rules.ts` and its wiring into
 * `translateAdtError`'s (`src/adt/session.ts`) UNCLASSIFIED tail.
 *
 * The defect this closes: a package create returned a correct, specific SAP
 * message ("Package <name> may not be assigned to software component LOCAL",
 * T100 TR/462) but it reached the caller as a generic `ADT_ERROR` whose own
 * hint admitted the message "was not recognised by any specific rule here".
 * `classifyAdtMessage` gives that one shape its own hint; everything else
 * must fall through unchanged, plus two new `details` keys for counting how
 * often the unclassified branch fires.
 */
import { describe, expect, it } from "vitest";
import { fromException } from "abap-adt-api/build/AdtException.js";
import {
  ADT_MESSAGE_RULES,
  classifyAdtMessage,
  unclassifiedMessageKey,
} from "../src/adt/adt-message-rules.js";
import { translateAdtError } from "../src/adt/session.js";

const OK_XML = { "content-type": "application/xml" };

/** Replay a captured body through the REAL abap-adt-api error path — same
 * helper shape as test/session.test.ts's `thrownByLibrary`. */
function thrownByLibrary(status: number, statusText: string, headers: object, body: string) {
  try {
    throw fromException({ status, statusText, headers, body }, {});
  } catch (e) {
    return e;
  }
}

const PACKAGE_NAME = "ZMCP_FOO";
const TR462_MESSAGE = `Package ${PACKAGE_NAME} may not be assigned to software component LOCAL`;

/** T100 TR/462 present alongside the matching prose. */
const TR462_WITH_T100_XML = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionInvalidData"/>
  <message lang="EN">${TR462_MESSAGE}</message>
  <localizedMessage lang="EN">${TR462_MESSAGE}</localizedMessage>
  <properties>
    <entry key="T100KEY-ID">TR</entry>
    <entry key="T100KEY-NO">462</entry>
  </properties>
</exc:exception>`;

/** Same prose, but no T100 key at all — the "older release" shape. */
const TR462_PROSE_ONLY_XML = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionInvalidData"/>
  <message lang="EN">${TR462_MESSAGE}</message>
  <localizedMessage lang="EN">${TR462_MESSAGE}</localizedMessage>
  <properties/>
</exc:exception>`;

/** A T100 key that happens to share the same message class number space but
 * is not TR/462, paired with unrelated prose — must not match either tier. */
const UNRELATED_XML = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionInternalError"/>
  <message lang="EN">Division by zero in program ZFOO</message>
  <localizedMessage lang="EN">Division by zero in program ZFOO</localizedMessage>
  <properties>
    <entry key="T100KEY-ID">SY</entry>
    <entry key="T100KEY-NO">530</entry>
  </properties>
</exc:exception>`;

/** Live A4H capture, 2026-09-04: `PROG/I ZTMD_INC_01` delete refused while
 * `PROG/P ZTMD_INC_PROG` still had `INCLUDE ztmd_inc_01.` — no T100 key sent. */
const DELETE_STILL_REFERENCED_MESSAGE = "Program ZTMD_INC_01 is referenced in other programs";
const DELETE_STILL_REFERENCED_XML = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceDeletionFailure"/>
  <message lang="EN">${DELETE_STILL_REFERENCED_MESSAGE}</message>
  <localizedMessage lang="EN">${DELETE_STILL_REFERENCED_MESSAGE}</localizedMessage>
  <properties/>
</exc:exception>`;

/** Live A4H capture, 2026-09-04: `FUGR/I ZTMD_FG_01/LZTMD_FG_01F01` create
 * refused because `ZTMD_FG_01` did not exist yet — no T100 key sent. */
const CONTAINER_PARENT_MISSING_MESSAGE =
  "Object R3TR FUGR ZTMD_FG_01 cannot be created without a package";
const CONTAINER_PARENT_MISSING_XML = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceCreationFailure"/>
  <message lang="EN">${CONTAINER_PARENT_MISSING_MESSAGE}</message>
  <localizedMessage lang="EN">${CONTAINER_PARENT_MISSING_MESSAGE}</localizedMessage>
  <properties/>
</exc:exception>`;

const ctx = { operation: "create" };

/** A rule's own `match` regex, by id — throws loudly (not `?.`) so a renamed
 * id fails the test instead of silently no-op'ing. */
function matchOf(id: string): RegExp {
  const rule = ADT_MESSAGE_RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`no rule with id "${id}"`);
  if (!rule.match) throw new Error(`rule "${id}" has no prose match`);
  return rule.match;
}

describe("classifyAdtMessage — unit", () => {
  it("matches on T100 TR/462 alone", () => {
    const rule = classifyAdtMessage("some unrelated wording entirely", {
      "T100KEY-ID": "TR",
      "T100KEY-NO": "462",
    });
    expect(rule?.id).toBe("package-software-component-refused");
  });

  it("matches on prose alone when no T100 key is sent", () => {
    const rule = classifyAdtMessage(TR462_MESSAGE, {});
    expect(rule?.id).toBe("package-software-component-refused");
  });

  it("a wrong T100 key with non-matching prose does not match", () => {
    const rule = classifyAdtMessage("Division by zero in program ZFOO", {
      "T100KEY-ID": "SY",
      "T100KEY-NO": "530",
    });
    expect(rule).toBeUndefined();
  });

  it("a T100 id match with the wrong number, and non-matching prose, does not match", () => {
    const rule = classifyAdtMessage("Division by zero in program ZFOO", {
      "T100KEY-ID": "TR",
      "T100KEY-NO": "999",
    });
    expect(rule).toBeUndefined();
  });

  it("every rule declares at least one match form (load-time invariant, re-asserted here)", () => {
    for (const rule of ADT_MESSAGE_RULES) {
      expect(rule.t100Id !== undefined || rule.t100No !== undefined || rule.match !== undefined).toBe(
        true,
      );
    }
  });

  it("matches delete-refused-still-referenced verbatim on the live A4H message", () => {
    const rule = classifyAdtMessage(DELETE_STILL_REFERENCED_MESSAGE, {});
    expect(rule?.id).toBe("delete-refused-still-referenced");
  });

  it("matches container-parent-missing verbatim on the live A4H message", () => {
    const rule = classifyAdtMessage(CONTAINER_PARENT_MISSING_MESSAGE, {});
    expect(rule?.id).toBe("container-parent-missing");
  });

  it("delete-refused-still-referenced's own matcher does not match the container-parent-missing message", () => {
    expect(matchOf("delete-refused-still-referenced").test(CONTAINER_PARENT_MISSING_MESSAGE)).toBe(false);
  });

  it("container-parent-missing's own matcher does not match the delete-refused-still-referenced message", () => {
    expect(matchOf("container-parent-missing").test(DELETE_STILL_REFERENCED_MESSAGE)).toBe(false);
  });

  it("neither new rule's matcher matches the TR/462 message, and TR/462 still resolves via classifyAdtMessage to package-software-component-refused", () => {
    expect(matchOf("delete-refused-still-referenced").test(TR462_MESSAGE)).toBe(false);
    expect(matchOf("container-parent-missing").test(TR462_MESSAGE)).toBe(false);
    const rule = classifyAdtMessage(TR462_MESSAGE, {});
    expect(rule?.id).toBe("package-software-component-refused");
  });

  it("rule ids are unique across ADT_MESSAGE_RULES", () => {
    const ids = ADT_MESSAGE_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("unclassifiedMessageKey", () => {
  it("renders id/no when both T100 parts are present", () => {
    expect(unclassifiedMessageKey({ "T100KEY-ID": "TR", "T100KEY-NO": "462" })).toBe("TR/462");
  });

  it("is 'none' when no T100 key is present", () => {
    expect(unclassifiedMessageKey({})).toBe("none");
  });

  it("is 'none' when only one half of the T100 key is present", () => {
    expect(unclassifiedMessageKey({ "T100KEY-ID": "TR" })).toBe("none");
  });
});

describe("translateAdtError — package/software-component rule wired into the UNCLASSIFIED tail", () => {
  it("a T100 TR/462 response is classified, not the generic fallback", () => {
    const e = thrownByLibrary(400, "Bad Request", OK_XML, TR462_WITH_T100_XML);
    const err = translateAdtError(e, ctx);

    expect(err.code).toBe("ADT_ERROR");
    expect(err.message).toBe(TR462_MESSAGE);
    expect(err.details.classifiedBy).toBe("package-software-component-refused");
    expect(err.hint).toMatch(/software_component: "HOME"/);
    expect(err.hint).toMatch(/corr_nr/);
    expect(err.hint).not.toMatch(/was not recognised by any specific rule here/);
    // The unclassified-tail instrumentation must NOT appear on a classified error.
    expect(err.details.unclassified).toBeUndefined();
    expect(err.details.unclassifiedKey).toBeUndefined();
  });

  it("the same message with no T100 key at all is still classified, via prose", () => {
    const e = thrownByLibrary(400, "Bad Request", OK_XML, TR462_PROSE_ONLY_XML);
    const err = translateAdtError(e, ctx);

    expect(err.code).toBe("ADT_ERROR");
    expect(err.details.classifiedBy).toBe("package-software-component-refused");
    expect(err.hint).toMatch(/software_component: "HOME"/);
  });

  it("a classified error does not claim retryable, even though its hint states a retry cannot succeed", () => {
    const e = thrownByLibrary(400, "Bad Request", OK_XML, TR462_WITH_T100_XML);
    const err = translateAdtError(e, ctx);

    // `retryable: false` is reserved for "UNSUPPORTED" capability-registry
    // refusals (test/refusal-terminality.test.ts) — a rule table entry states
    // permanence in its hint prose instead.
    expect(err.retryable).toBeUndefined();
    expect(err.hint).toMatch(/Retrying this call unchanged cannot succeed/);
  });

  it("an unrelated ADT exception keeps the generic hint and gains unclassified instrumentation", () => {
    const e = thrownByLibrary(500, "Internal Server Error", OK_XML, UNRELATED_XML);
    const err = translateAdtError(e, ctx);

    expect(err.code).toBe("ADT_ERROR");
    expect(err.hint).toMatch(/was not recognised by any specific rule here/);
    expect(err.details.classifiedBy).toBeUndefined();
    expect(err.details.unclassified).toBe(true);
    expect(err.details.unclassifiedKey).toBe("SY/530");
  });

  it("an unclassified error with no T100 key at all gets unclassifiedKey 'none'", () => {
    const e = thrownByLibrary(
      500,
      "Internal Server Error",
      OK_XML,
      `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionInternalError"/>
  <message lang="EN">Something else entirely went wrong</message>
  <localizedMessage lang="EN">Something else entirely went wrong</localizedMessage>
  <properties/>
</exc:exception>`,
    );
    const err = translateAdtError(e, ctx);

    expect(err.code).toBe("ADT_ERROR");
    expect(err.details.unclassified).toBe(true);
    expect(err.details.unclassifiedKey).toBe("none");
  });
});

describe("translateAdtError — delete-refused-still-referenced wired into the UNCLASSIFIED tail", () => {
  it("a 403 ExceptionResourceDeletionFailure 'referenced in other programs' response is classified, not the generic fallback", () => {
    const e = thrownByLibrary(403, "Forbidden", OK_XML, DELETE_STILL_REFERENCED_XML);
    const err = translateAdtError(e, ctx);

    expect(err.code).toBe("ADT_ERROR");
    expect(err.message).toBe(DELETE_STILL_REFERENCED_MESSAGE);
    expect(err.details.classifiedBy).toBe("delete-refused-still-referenced");
    expect(err.details.unclassified).toBeUndefined();
    expect(err.details.unclassifiedKey).toBeUndefined();
    expect(err.details.properties).toBeUndefined();
    expect(err.details.adtExceptionType).toBe("ExceptionResourceDeletionFailure");
    expect(err.details.status).toBe(403);
    expect(err.hint).not.toMatch(/was not recognised by any specific rule here/);
    expect(err.hint).toMatch(/mode: "where_used"/);
  });
});

describe("translateAdtError — container-parent-missing wired into the UNCLASSIFIED tail", () => {
  it("a 500 ExceptionResourceCreationFailure 'cannot be created without a package' response is classified, not the generic fallback", () => {
    const e = thrownByLibrary(500, "Internal Server Error", OK_XML, CONTAINER_PARENT_MISSING_XML);
    const err = translateAdtError(e, ctx);

    expect(err.code).toBe("ADT_ERROR");
    expect(err.message).toBe(CONTAINER_PARENT_MISSING_MESSAGE);
    expect(err.details.classifiedBy).toBe("container-parent-missing");
    expect(err.details.unclassified).toBeUndefined();
    expect(err.details.unclassifiedKey).toBeUndefined();
    expect(err.details.properties).toBeUndefined();
    expect(err.details.adtExceptionType).toBe("ExceptionResourceCreationFailure");
    expect(err.details.status).toBe(500);
    expect(err.hint).not.toMatch(/was not recognised by any specific rule here/);
    expect(err.hint).toMatch(/FUNCTION-POOL/);
  });
});
