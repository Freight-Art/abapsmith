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

const ctx = { operation: "create" };

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
