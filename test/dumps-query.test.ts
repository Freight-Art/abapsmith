/**
 * FQL builder + client-side validator for the ABAP runtime-dumps feed
 * (`src/adt/dumps-query.ts`).
 *
 * Every expectation here is anchored to a behaviour captured on A4H. The
 * suite is organised around the traps, not around the functions, because the
 * traps are what make this module necessary:
 *
 *   - an unrecognised parameter is answered 200 with the FULL feed;
 *   - `$top=0` means unlimited;
 *   - a rejected `$query` yields one 372-byte body for every kind of mistake
 *     — pinned below against the committed fixture, so the day someone
 *     proposes "just forward the server's error" the test says what that would
 *     forward.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AbapError, isAbapError } from "../src/adt/errors.js";
import { parseFeedsCatalog, type FeedExtendedData } from "../src/adt/dumps-xml.js";
import {
  DUMPS_ASSUMED_QUERY_DEPTH,
  DUMPS_CONTRACT_AS_CAPTURED,
  DUMPS_FEED_PARAMS,
  DUMPS_FEED_PATH,
  DUMPS_MAX_ROWS,
  DUMPS_RESIDENCE_WINDOW_DAYS,
  FQL_OPERATORS,
  assertRecognisedFeedParam,
  assertValidFqlQuery,
  buildDumpsFeedUrl,
  buildFqlQuery,
  buildQueryCheckUrl,
  isRecognisedFeedParam,
  isValidTimestamp14,
  normaliseTimestamp,
  parseFqlQuery,
  residenceWindowStart,
  toDumpsQueryContract,
  validateFqlQuery,
  type DumpsFeedRequest,
  type DumpsQueryContract,
  type FqlQuery,
  type FqlViolationCode,
} from "../src/adt/dumps-query.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "dumps");

/** `and ( equals ( user , DEVELOPER ) )` in structured form. */
const userIsDeveloper: FqlQuery = {
  junction: "and",
  predicates: [{ attribute: "user", operator: "equals", operands: ["DEVELOPER"] }],
};

const codes = (query: string | FqlQuery, contract?: DumpsQueryContract): FqlViolationCode[] =>
  validateFqlQuery(query, contract).violations.map((v) => v.code);

/** The one message the caller will ever see, joined. */
const messages = (query: string | FqlQuery): string =>
  validateFqlQuery(query).violations.map((v) => v.message).join(" ");

const caught = (fn: () => unknown): AbapError => {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected an AbapError, none was thrown");
};

// ------------------------------------------------------- the canonical form ---

describe("buildFqlQuery — canonical output", () => {
  it("emits the spaced canonical form for a single-predicate user filter", () => {
    // Byte-for-byte the shape the server itself publishes in its default
    // feed:queryVariant ("Runtime Errors caused by me (DEVELOPER)").
    expect(buildFqlQuery(userIsDeveloper)).toBe("and ( equals ( user , DEVELOPER ) )");
  });

  it("joins multiple predicates with ' , ' inside one wrapper (still depth 2)", () => {
    expect(
      buildFqlQuery({
        junction: "and",
        predicates: [
          { attribute: "user", operator: "equals", operands: ["DEVELOPER"] },
          { attribute: "objectName", operator: "contains", operands: ["ZCL"] },
        ],
      }),
    ).toBe("and ( equals ( user , DEVELOPER ) , contains ( objectName , ZCL ) )");
  });

  it("emits both operands of between, unquoted, as 14-digit literals", () => {
    expect(
      buildFqlQuery({
        junction: "or",
        predicates: [
          {
            attribute: "datetime",
            operator: "between",
            operands: ["20260804000000", "20260811235959"],
          },
        ],
      }),
    ).toBe("or ( between ( datetime , 20260804000000 , 20260811235959 ) )");
  });

  it("re-emits a valid hand-written query in canonical spacing", () => {
    const result = validateFqlQuery("and(equals(user,DEVELOPER))");
    expect(result.ok).toBe(true);
    expect(result.canonical).toBe("and ( equals ( user , DEVELOPER ) )");
  });

  it("treats whitespace as insignificant — 5 spacings collapse to one canonical string", () => {
    // Five spacings were sent to A4H and returned identical results.
    const spacings = [
      "and(equals(user,DEVELOPER))",
      "and ( equals ( user , DEVELOPER ) )",
      "and (equals(user, DEVELOPER))",
      "  and  (  equals  (  user  ,  DEVELOPER  )  )  ",
      "and(\tequals(\nuser\n,\nDEVELOPER\n)\n)",
    ];
    const canonicals = new Set(spacings.map((s) => validateFqlQuery(s).canonical));
    expect(canonicals).toEqual(new Set(["and ( equals ( user , DEVELOPER ) )"]));
  });

  it("re-emits the contract's own spelling, never the caller's casing", () => {
    // A query that leaves the validator is one we assembled from the served
    // contract — the caller's text is never spliced through.
    expect(validateFqlQuery("AND ( EQUALS ( objectname , ZCL_FOO ) )").canonical).toBe(
      "and ( equals ( objectName , ZCL_FOO ) )",
    );
  });
});

// -------------------------------------------------------- the missing wrapper ---

describe("the mandatory and(…)/or(…) wrapper", () => {
  it("rejects a bare predicate — the commonest hand-written-client mistake", () => {
    const result = validateFqlQuery("equals ( user , DEVELOPER )");
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("MISSING_WRAPPER");
    expect(result.canonical).toBeUndefined();
  });

  it("says how to fix it, naming the operator and attribute", () => {
    const message = messages("equals ( user , DEVELOPER )");
    expect(message).toContain("and ( equals ( user , … ) )");
    expect(message).toMatch(/MANDATORY/);
  });

  it("accepts a single predicate once it is wrapped", () => {
    expect(validateFqlQuery("and ( equals ( user , DEVELOPER ) )").ok).toBe(true);
    expect(validateFqlQuery("or ( equals ( user , DEVELOPER ) )").ok).toBe(true);
  });

  it("rejects an empty wrapper rather than sending 'and ( )'", () => {
    expect(codes("and ( )")).toEqual(["EMPTY_QUERY"]);
  });

  it("rejects a structured query whose junction is not and/or", () => {
    const bogus = { junction: "not", predicates: userIsDeveloper.predicates } as unknown as FqlQuery;
    expect(codes(bogus)).toContain("MISSING_WRAPPER");
    expect(caught(() => buildFqlQuery(bogus)).code).toBe("BAD_INPUT");
  });

  it("rejects a junction used where a predicate belongs", () => {
    // `and ( or ( … ) )` is depth 3, not a two-junction query.
    expect(codes("and ( or ( equals ( user , X ) ) )")).toContain("EXCESS_DEPTH");
  });
});

// ------------------------------------------------------------------- depth ---

describe("queryDepth is 2 and the server enforces it", () => {
  it("accepts wrapper + predicate (depth 2)", () => {
    expect(validateFqlQuery("and ( equals ( user , DEVELOPER ) )").ok).toBe(true);
  });

  it("accepts wrapper + several predicates (still depth 2)", () => {
    expect(
      validateFqlQuery("and ( equals ( user , DEVELOPER ) , contains ( objectName , ZCL ) )").ok,
    ).toBe(true);
  });

  it("rejects a nested junction (depth 3), which the server answers 400", () => {
    const result = validateFqlQuery("and ( and ( equals ( user , DEVELOPER ) ) )");
    expect(result.violations.map((v) => v.code)).toContain("EXCESS_DEPTH");
    expect(result.violations.find((v) => v.code === "EXCESS_DEPTH")?.message).toContain(
      "nests 3 levels deep",
    );
  });

  it("rejects the triple nest from the recon capture (depth 4)", () => {
    expect(codes("and ( and ( and ( equals ( user , DEVELOPER ) ) ) )")).toContain("EXCESS_DEPTH");
  });

  it("honours a contract that advertises a different queryDepth", () => {
    // The Gateway error-log feed in the same catalog serves queryDepth 1.
    const depth1: DumpsQueryContract = { ...DUMPS_CONTRACT_AS_CAPTURED, queryDepth: 1 };
    expect(codes("and ( equals ( user , DEVELOPER ) )", depth1)).toContain("EXCESS_DEPTH");
  });

  it("makes depth-3 unrepresentable in the structured builder input", () => {
    // FqlQuery has predicates, not children: a nested junction cannot be typed.
    expect(Object.keys(userIsDeveloper)).toEqual(["junction", "predicates"]);
  });
});

// ------------------------------------------------- per-attribute operator lists ---

describe("operators are per-attribute, not per-dataType", () => {
  it("rejects contains(user, …) — user permits only equals/notEquals", () => {
    const result = validateFqlQuery("and ( contains ( user , DEV ) )");
    expect(result.ok).toBe(false);
    const violation = result.violations.find((v) => v.code === "OPERATOR_NOT_PERMITTED");
    expect(violation).toBeDefined();
    expect(violation?.attribute).toBe("user");
    expect(violation?.operator).toBe("contains");
    expect(violation?.message).toContain("'contains' is not permitted for attribute 'user'");
    expect(violation?.message).toContain("equals, notEquals");
  });

  it("accepts contains(component, …) — the same dataType, a different list", () => {
    expect(validateFqlQuery("and ( contains ( component , BC-DWB ) )").ok).toBe(true);
  });

  it("accepts equals/notEquals on user", () => {
    expect(validateFqlQuery("and ( equals ( user , DEVELOPER ) )").ok).toBe(true);
    expect(validateFqlQuery("and ( notEquals ( user , DEVELOPER ) )").ok).toBe(true);
  });

  it("explains the asymmetry, because it is not derivable from the dataType", () => {
    expect(messages("and ( notContains ( user , X ) )")).toContain(
      "not derivable from the dataType",
    );
  });

  it("rejects a string operator on the dateTime attribute", () => {
    expect(codes("and ( contains ( datetime , 2026 ) )")).toEqual(["OPERATOR_NOT_PERMITTED"]);
  });

  it("accepts the ordering operators only on datetime", () => {
    expect(validateFqlQuery("and ( greaterOrEquals ( datetime , 20260804000000 ) )").ok).toBe(true);
    expect(codes("and ( greaterOrEquals ( objectName , ZCL ) )")).toEqual([
      "OPERATOR_NOT_PERMITTED",
    ]);
  });
});

// ---------------------------------------------------------------- attributes ---

describe("attributes must come from the served contract", () => {
  it("serves exactly the 11 filterable attributes captured from feed:extendedData", () => {
    expect(DUMPS_CONTRACT_AS_CAPTURED.attributes.map((a) => a.id)).toEqual([
      "package",
      "packageHierarchy",
      "packageResponsible",
      "objectResponsible",
      "responsible",
      "objectName",
      "component",
      "user",
      "runtimeError",
      "exception",
      "datetime",
    ]);
    expect(DUMPS_CONTRACT_AS_CAPTURED.queryDepth).toBe(2);
  });

  it("rejects an unknown attribute and lists the ones that exist", () => {
    const violation = validateFqlQuery("and ( equals ( bogusAttr , X ) )").violations[0];
    expect(violation?.code).toBe("UNKNOWN_ATTRIBUTE");
    expect(violation?.attribute).toBe("bogusAttr");
    expect(violation?.message).toContain("objectName");
    expect(violation?.message).toContain("runtimeError");
  });

  it("rejects an unknown operator and lists the ten that exist", () => {
    const violation = validateFqlQuery("and ( startsWith ( objectName , ZCL ) )").violations[0];
    expect(violation?.code).toBe("UNKNOWN_OPERATOR");
    expect(violation?.message).toContain("between, notBetween");
  });

  it("allows package/packageHierarchy — accepted by the server, semantics unproven", () => {
    expect(validateFqlQuery("and ( equals ( package , $TMP ) )").ok).toBe(true);
    expect(validateFqlQuery("and ( equals ( packageHierarchy , SABP ) )").ok).toBe(true);
  });

  it("validates against a caller-supplied contract, not a remembered one", () => {
    const narrowed: DumpsQueryContract = {
      queryDepth: 2,
      attributes: [{ id: "user", dataType: "string", operators: ["equals"] }],
    };
    expect(codes("and ( equals ( objectName , ZCL ) )", narrowed)).toEqual(["UNKNOWN_ATTRIBUTE"]);
    expect(codes("and ( notEquals ( user , X ) )", narrowed)).toEqual(["OPERATOR_NOT_PERMITTED"]);
  });
});

// ------------------------------------------------------------ operand counts ---

describe("operand counts — between/notBetween take two", () => {
  it("declares the arity of all ten operators", () => {
    expect(FQL_OPERATORS.between).toBe(2);
    expect(FQL_OPERATORS.notBetween).toBe(2);
    expect(Object.values(FQL_OPERATORS).filter((n) => n === 1)).toHaveLength(8);
  });

  it("rejects between with a single operand", () => {
    const violation = validateFqlQuery("and ( between ( datetime , 20260804000000 ) )")
      .violations[0];
    expect(violation?.code).toBe("OPERAND_COUNT");
    expect(violation?.message).toContain("takes 2 operands");
    expect(violation?.message).toContain("between ( datetime , <low> , <high> )");
  });

  it("rejects notBetween with three operands", () => {
    expect(codes("and ( notBetween ( datetime , 20260804000000 , 20260805000000 , 3 ) )")).toEqual([
      "OPERAND_COUNT",
    ]);
  });

  it("rejects equals with two operands", () => {
    const violation = validateFqlQuery("and ( equals ( user , A , B ) )").violations[0];
    expect(violation?.code).toBe("OPERAND_COUNT");
    expect(violation?.message).toContain("takes 1 operand,");
  });

  it("rejects a predicate with no operand at all", () => {
    expect(codes("and ( equals ( user ) )")).toEqual(["OPERAND_COUNT"]);
  });

  it("accepts between with exactly two", () => {
    expect(
      validateFqlQuery("and ( between ( datetime , 20260804000000 , 20260811235959 ) )").ok,
    ).toBe(true);
  });
});

// -------------------------------------------------------------- value literals ---

describe("values are unquoted, and datetime literals are 14 digits", () => {
  it("rejects a malformed datetime literal", () => {
    const violation = validateFqlQuery("and ( equals ( datetime , yesterday ) )").violations[0];
    expect(violation?.code).toBe("MALFORMED_DATETIME");
    expect(violation?.message).toContain("YYYYMMDDHHMMSS");
  });

  it("rejects an ISO-8601 literal inside $query, where only from/to accept it", () => {
    const violation = validateFqlQuery("and ( equals ( datetime , 2026-08-04T00:00:00Z ) )")
      .violations[0];
    expect(violation?.code).toBe("MALFORMED_DATETIME");
    expect(violation?.message).toContain("ISO-8601 is accepted by from/to, but NOT inside $query");
  });

  it("rejects 14 digits that are not a real instant", () => {
    expect(codes("and ( equals ( datetime , 20260231000000 ) )")).toEqual(["MALFORMED_DATETIME"]);
    expect(codes("and ( equals ( datetime , 20261301000000 ) )")).toEqual(["MALFORMED_DATETIME"]);
    expect(codes("and ( equals ( datetime , 20260804250000 ) )")).toEqual(["MALFORMED_DATETIME"]);
  });

  it("rejects a quoted value and shows the unquoted form", () => {
    const violation = validateFqlQuery("and ( equals ( user , 'DEVELOPER' ) )").violations[0];
    expect(violation?.code).toBe("INVALID_VALUE");
    expect(violation?.message).toContain("equals ( user , DEVELOPER )");
  });

  it("rejects a value containing whitespace — the grammar has no quoting", () => {
    expect(codes("and ( contains ( objectName , ZCL FOO ) )")).toEqual(["INVALID_VALUE"]);
  });

  it("does not mistake a datetime check for a string check", () => {
    // objectName is a string: 'yesterday' is a perfectly good value for it.
    expect(validateFqlQuery("and ( contains ( objectName , yesterday ) )").ok).toBe(true);
  });
});

// -------------------------------------------------------- multiple violations ---

describe("every violation is reported at once", () => {
  it("names each problem in one pass, since the server names none", () => {
    const result = validateFqlQuery(
      "and ( and ( contains ( user , DEV ) , equals ( bogusAttr , X ) , between ( datetime , 20260804000000 ) ) )",
    );
    expect(result.ok).toBe(false);
    expect(new Set(result.violations.map((v) => v.code))).toEqual(
      new Set(["EXCESS_DEPTH", "OPERATOR_NOT_PERMITTED", "UNKNOWN_ATTRIBUTE", "OPERAND_COUNT"]),
    );
  });

  it("reports unparseable text as SYNTAX with an offset", () => {
    const result = validateFqlQuery("and ( equals ( user , DEVELOPER )");
    expect(result.violations[0]?.code).toBe("SYNTAX");
    expect(result.violations[0]?.message).toContain("and ( equals ( user , DEVELOPER ) )");
  });

  it("rejects trailing input after the top-level wrapper", () => {
    expect(codes("and ( equals ( user , X ) ) or ( equals ( user , Y ) )")).toEqual(["SYNTAX"]);
  });

  it("parses without judging, so the validator can see the whole tree", () => {
    const parsed = parseFqlQuery("equals ( user , DEVELOPER )");
    expect(parsed.error).toBeUndefined();
    expect(parsed.node?.kind).toBe("predicate");
  });
});

// --------------------------------------------------------------- throwing form ---

describe("assertValidFqlQuery / buildFqlQuery throw BAD_INPUT", () => {
  it("uses the BAD_INPUT code, consistent with the data-preview tool", () => {
    const err = caught(() => assertValidFqlQuery("equals ( user , DEVELOPER )"));
    expect(err.code).toBe("BAD_INPUT");
    expect(err).toBeInstanceOf(AbapError);
  });

  it("carries every violation in details for a caller that wants structure", () => {
    const err = caught(() => buildFqlQuery({ junction: "and", predicates: [] }));
    expect(Array.isArray(err.details.violations)).toBe(true);
  });

  it("explains in the hint why the server could not have told us", () => {
    const err = caught(() => assertValidFqlQuery("and ( equals ( nope , X ) )"));
    expect(err.hint).toContain("372-byte");
    expect(err.hint).toContain("byte-identical");
  });
});

// ------------------------------------------------------------- parameter names ---

describe("the six recognised parameters, and the silent-ignore trap", () => {
  it("hardcodes exactly the six names read from IF_ADT_FEED_PROVIDER", () => {
    expect([...DUMPS_FEED_PARAMS]).toEqual([
      "$query",
      "from",
      "to",
      "$top",
      "$queryCheck",
      "$inlinecount",
    ]);
    expect(Object.isFrozen(DUMPS_FEED_PARAMS)).toBe(true);
  });

  it.each(["$skip", "$filter", "query", "queryString", "variant", "user", "maxHits", "zzzNotAParam"])(
    "refuses '%s', which the server answers 200 with the full unfiltered feed",
    (name) => {
      expect(isRecognisedFeedParam(name)).toBe(false);
      const err = caught(() => assertRecognisedFeedParam(name));
      expect(err.code).toBe("BAD_INPUT");
      expect(err.hint).toContain("silently ignores unrecognised parameters");
    },
  );

  it("calls out `query` (no $) specifically — the near-miss that cost the most time", () => {
    expect(caught(() => assertRecognisedFeedParam("query")).hint).toContain(
      "The parameter is `$query`, with the dollar sign",
    );
  });

  it("rejects an unknown key on the request object with the same message", () => {
    const err = caught(() =>
      buildDumpsFeedUrl({ $skip: 2 } as unknown as DumpsFeedRequest),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details.parameter).toBe("$skip");
  });

  it("never offers $inlinecount, which is recognised but inert", () => {
    expect(isRecognisedFeedParam("$inlinecount")).toBe(true);
    const err = caught(() =>
      buildDumpsFeedUrl({ $inlinecount: "allpages" } as unknown as DumpsFeedRequest),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.hint).toContain("INERT");
    // And it is absent from a fully-populated URL.
    const built = buildDumpsFeedUrl({ $query: userIsDeveloper, $top: 3, from: "20260804000000" });
    expect(built.url).not.toContain("inlinecount");
  });
});

// -------------------------------------------------------------------- $top ---

describe("$top", () => {
  it("rejects 0, because 0 means UNLIMITED on this endpoint", () => {
    const err = caught(() => buildDumpsFeedUrl({ $top: 0 }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.hint).toContain("UNLIMITED");
    // Not re-defaulted to something polite, either.
    expect(err.message).toContain("positive integer");
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", (top) => {
    expect(caught(() => buildDumpsFeedUrl({ $top: top })).code).toBe("BAD_INPUT");
  });

  it("rejects a non-numeric $top before the server's one honest 400", () => {
    const err = caught(() => buildDumpsFeedUrl({ $top: "abc" as unknown as number }));
    expect(err.code).toBe("BAD_INPUT");
  });

  it("sends a positive integer percent-encoded as %24top", () => {
    expect(buildDumpsFeedUrl({ $top: 3 }).url).toBe(`${DUMPS_FEED_PATH}?%24top=3`);
  });

  it("notes, but does not refuse, a $top above the server's C_MAX_DUMPS", () => {
    const built = buildDumpsFeedUrl({ $top: DUMPS_MAX_ROWS + 1 });
    expect(built.notes.join(" ")).toContain("C_MAX_DUMPS = 1000");
    expect(built.url).toContain("%24top=1001");
  });
});

// ----------------------------------------------------------------- from / to ---

describe("from/to normalisation", () => {
  it("accepts the 14-digit form unchanged", () => {
    expect(normaliseTimestamp("20260810000000")).toBe("20260810000000");
  });

  it("normalises ISO-8601 Z input to the 14-digit canonical form", () => {
    // Both are accepted by the server and give byte-identical results;
    // we emit the form the server's own cursors use.
    expect(normaliseTimestamp("2026-08-10T00:00:00Z")).toBe("20260810000000");
    const built = buildDumpsFeedUrl({ from: "2026-08-10T00:00:00Z" });
    expect(built.url).toBe(`${DUMPS_FEED_PATH}?from=20260810000000`);
    expect(built.notes.join(" ")).toContain("normalised to the canonical 14-digit form");
  });

  it("accepts a Date, in UTC", () => {
    expect(normaliseTimestamp(new Date(Date.UTC(2026, 7, 10, 12, 34, 56)))).toBe("20260810123456");
  });

  it("refuses a numeric UTC offset rather than silently shifting the range", () => {
    expect(normaliseTimestamp("2026-08-10T00:00:00+02:00")).toBeUndefined();
  });

  it.each(["NOTADATE", "", "2026-08-10", "20260810", "20260231000000", "202608100000000"])(
    "refuses '%s', which the server would silently ignore and answer with everything",
    (value) => {
      expect(normaliseTimestamp(value)).toBeUndefined();
      const err = caught(() => buildDumpsFeedUrl({ from: value }));
      expect(err.code).toBe("BAD_INPUT");
      expect(err.hint).toContain("SILENTLY IGNORED");
    },
  );

  it("validates 14-digit literals as real instants", () => {
    expect(isValidTimestamp14("20260811082300")).toBe(true);
    expect(isValidTimestamp14("20260229000000")).toBe(false); // 2026 is not a leap year
    expect(isValidTimestamp14("20240229000000")).toBe(true);
  });

  it("emits an inclusive range in canonical parameter order", () => {
    expect(buildDumpsFeedUrl({ from: "20260810000000", to: "20260811000000" }).url).toBe(
      `${DUMPS_FEED_PATH}?from=20260810000000&to=20260811000000`,
    );
  });

  it("notes an inverted range, which can only come back empty", () => {
    const built = buildDumpsFeedUrl(
      { from: "20260811000000", to: "20260810000000" },
      { now: new Date(Date.UTC(2026, 7, 11)) },
    );
    expect(built.notes.join(" ")).toContain("is later than");
  });
});

// -------------------------------------------------------- the 8-day window ---

describe("the residence window, which no parameter widens", () => {
  it("computes sy-datum - 8 + 1", () => {
    expect(DUMPS_RESIDENCE_WINDOW_DAYS).toBe(8);
    expect(residenceWindowStart(new Date(Date.UTC(2026, 7, 11, 12, 0, 0)))).toBe("20260804000000");
  });

  it("tells the caller when `from` predates it — the server will not", () => {
    const built = buildDumpsFeedUrl(
      { from: "20200101000000" },
      { now: new Date(Date.UTC(2026, 7, 11, 12, 0, 0)) },
    );
    // The parameter is still sent: it is legal and it narrows correctly.
    expect(built.url).toContain("from=20200101000000");
    const note = built.notes.join(" ");
    expect(note).toContain("predates the dump residence window");
    expect(note).toContain("does NOT widen");
    expect(built.residenceWindowStart).toBe("20260804000000");
  });

  it("says a wholly-historic range will be empty", () => {
    const built = buildDumpsFeedUrl(
      { from: "20200101000000", to: "20200201000000" },
      { now: new Date(Date.UTC(2026, 7, 11, 12, 0, 0)) },
    );
    expect(built.notes.join(" ")).toContain("entirely outside what ADT can see");
  });

  it("stays quiet when the range is inside the window", () => {
    const built = buildDumpsFeedUrl(
      { from: "20260810000000" },
      { now: new Date(Date.UTC(2026, 7, 11, 12, 0, 0)) },
    );
    expect(built.notes).toEqual([]);
  });

  it("always exposes the window start, so an empty feed can be explained", () => {
    expect(
      buildDumpsFeedUrl({}, { now: new Date(Date.UTC(2026, 7, 11)) }).residenceWindowStart,
    ).toBe("20260804000000");
  });
});

// ---------------------------------------------------------------- URL shape ---

describe("buildDumpsFeedUrl", () => {
  it("percent-encodes the literal $ as %24, as the server's own hrefs do", () => {
    const built = buildDumpsFeedUrl({ $query: userIsDeveloper, $top: 3 });
    expect(built.url).toBe(
      `${DUMPS_FEED_PATH}` +
        "?%24query=and%20(%20equals%20(%20user%20%2C%20DEVELOPER%20)%20)" +
        "&%24top=3",
    );
  });

  it("emits parameters in the canonical order regardless of key order", () => {
    const built = buildDumpsFeedUrl({
      $top: 5,
      to: "20260811000000",
      from: "20260810000000",
      $query: userIsDeveloper,
    });
    expect(built.params.map(([name]) => name)).toEqual(["$query", "from", "to", "$top"]);
  });

  it("returns the unencoded pairs alongside the URL, for logging", () => {
    expect(buildDumpsFeedUrl({ $query: userIsDeveloper }).params).toEqual([
      ["$query", "and ( equals ( user , DEVELOPER ) )"],
    ]);
  });

  it("returns the bare path when nothing is filtered", () => {
    expect(buildDumpsFeedUrl({}).url).toBe(DUMPS_FEED_PATH);
  });

  it("refuses to build a URL around an invalid query", () => {
    const err = caught(() => buildDumpsFeedUrl({ $query: "equals ( user , DEVELOPER )" }));
    expect(err.code).toBe("BAD_INPUT");
  });

  it("accepts an alternative base path without re-deriving it", () => {
    expect(buildDumpsFeedUrl({ $top: 1 }, { basePath: "/sap/bc/adt/runtime/dumps" }).url).toBe(
      "/sap/bc/adt/runtime/dumps?%24top=1",
    );
  });
});

// ------------------------------------------------------------ $queryCheck ---

describe("the $queryCheck pre-flight", () => {
  it("sends only the query and the check flag — no rows are read", () => {
    const built = buildQueryCheckUrl(userIsDeveloper);
    expect(built.params.map(([name]) => name)).toEqual(["$query", "$queryCheck"]);
    expect(built.url).toBe(
      `${DUMPS_FEED_PATH}` +
        "?%24query=and%20(%20equals%20(%20user%20%2C%20DEVELOPER%20)%20)" +
        "&%24queryCheck=true",
    );
  });

  it("validates client-side first — a pre-flight for a query we know is bad is a wasted trip", () => {
    expect(caught(() => buildQueryCheckUrl("and ( contains ( user , DEV ) )")).code).toBe(
      "BAD_INPUT",
    );
  });

  it("accepts a hand-written string and canonicalises it", () => {
    expect(buildQueryCheckUrl("and(equals(user,DEVELOPER))").params[0]?.[1]).toBe(
      "and ( equals ( user , DEVELOPER ) )",
    );
  });
});

// ------------------------------------------- why this module exists, in bytes ---

describe("the server's own rejection carries nothing to forward", () => {
  const invalid = readFileSync(join(FIXTURES, "querycheck-invalid.xml"), "utf8");
  const valid = readFileSync(join(FIXTURES, "querycheck-valid.xml"), "utf8");

  it("is 372 bytes of ExceptionInvalidData with an EMPTY properties element", () => {
    expect(Buffer.byteLength(invalid, "utf8")).toBe(372);
    expect(invalid).toContain('<type id="ExceptionInvalidData"/>');
    expect(invalid).toContain("<properties/>");
    expect(invalid).toContain("Data is invalid and could not be converted");
  });

  it("names nothing: not the attribute, not the operator, not the position", () => {
    // This is the assertion that justifies the whole module. Four unrelated
    // mistakes produce this one body; if it named any of these tokens, a
    // server-side error could have been translated instead.
    //
    // `and` is deliberately not in the list: the body's prose contains the
    // English conjunction in "invalid and could not be converted", which is
    // itself the point — the only occurrence of an FQL keyword in these 372
    // bytes is a coincidence of grammar.
    for (const token of [
      "user",
      "bogusAttr",
      "contains",
      "depth",
      "wrapper",
      "syntax",
      "attribute",
      "operator",
      "query",
    ]) {
      expect(invalid.toLowerCase()).not.toContain(token.toLowerCase());
    }
  });

  it("is what four different mistakes would each have produced", () => {
    // Each of these is refused here, with a message the server never gives.
    const mistakes: Array<[string, FqlViolationCode]> = [
      ["and ( equals ( bogusAttr , X ) )", "UNKNOWN_ATTRIBUTE"],
      ["and ( equals ( user , ", "SYNTAX"],
      ["equals ( user , DEVELOPER )", "MISSING_WRAPPER"],
      ["and ( and ( and ( equals ( user , X ) ) ) )", "EXCESS_DEPTH"],
    ];
    for (const [query, code] of mistakes) {
      const result = validateFqlQuery(query);
      expect(result.ok).toBe(false);
      expect(result.violations.map((v) => v.code)).toContain(code);
      // …and each message says something the 372 bytes above do not.
      expect(result.violations.map((v) => v.message).join(" ").length).toBeGreaterThan(40);
    }
  });

  it("answers a VALID query with 91 bytes and a self-closing feed", () => {
    expect(Buffer.byteLength(valid, "utf8")).toBe(91);
    expect(valid.trimEnd().endsWith("/>")).toBe(true);
    expect(valid).not.toContain("<atom:entry");
  });
});

// -------------------------------- the seam: parsed contract → validator shape ---

/**
 * `dumps-xml.ts` and `dumps-query.ts` were written independently and drifted:
 * the parser says `dataTypeId`/`operatorIds` and serves the operator table as
 * an array, the validator wants `dataType`/`operators` and an arity map, and
 * `queryDepth` is optional on one side and required on the other. The DATA
 * always agreed; only the shapes did not, so nothing failed until someone tried
 * to pass one to the other. `toDumpsQueryContract` is the single conversion,
 * and the tests below are what would have caught the drift on the day it
 * appeared.
 */
describe("toDumpsQueryContract bridges the parsed catalog to the validator", () => {
  const catalog = parseFeedsCatalog(readFileSync(join(FIXTURES, "feeds-catalog.xml"), "utf8"));
  const dumpsEntry = catalog.entries.find((e) => e.id === DUMPS_FEED_PATH);
  const dumpsExtended = dumpsEntry?.extendedData as FeedExtendedData;

  it("finds the dumps entry and its extendedData in the captured catalog", () => {
    expect(dumpsExtended).toBeDefined();
    expect(dumpsExtended.attributes).toHaveLength(11);
    expect(dumpsExtended.queryDepth).toBe(2);
  });

  it("reproduces DUMPS_CONTRACT_AS_CAPTURED exactly from the fixture bytes", () => {
    // The regression. The hardcoded fallback and the parser must not be able to
    // disagree about the contract silently — if the fixture is re-captured and
    // the server's answer has changed, this fails and the constant gets
    // updated deliberately rather than rotting.
    expect(toDumpsQueryContract(dumpsExtended)).toEqual(DUMPS_CONTRACT_AS_CAPTURED);
  });

  it("renames the wire's fields rather than passing them through", () => {
    const contract = toDumpsQueryContract(dumpsExtended);
    const user = contract.attributes.find((a) => a.id === "user");
    // The exact drift, pinned from both sides: the wire spells these
    // dataTypeId/operatorIds and the validator reads dataType/operators.
    expect(user).toEqual({ id: "user", dataType: "string", operators: ["equals", "notEquals"] });
    expect(user).not.toHaveProperty("dataTypeId");
    expect(user).not.toHaveProperty("operatorIds");
  });

  it("turns the FeedOperatorDef array into an id → arity map, keeping between = 2", () => {
    const contract = toDumpsQueryContract(dumpsExtended);
    expect(contract.operators).toEqual(FQL_OPERATORS);
    expect(contract.operators?.between).toBe(2);
    expect(contract.operators?.equals).toBe(1);
    expect(Array.isArray(contract.operators)).toBe(false);
  });

  it("marks a served queryDepth as served, not assumed", () => {
    expect(toDumpsQueryContract(dumpsExtended).queryDepthAssumed).toBeUndefined();
  });

  it("carries a per-feed queryDepth across, not a constant", () => {
    // Same catalog, three different caps: 1 for the Gateway error log, 2 for
    // dumps, 4 for ATC findings. A hardcoded 2 would pass the dumps assertion
    // above and still be wrong for everyone else.
    const depths = catalog.entries
      .filter((e) => e.extendedData?.queryDepth !== undefined)
      .map((e) => [e.id, toDumpsQueryContract(e.extendedData as FeedExtendedData).queryDepth]);
    expect(depths).toEqual([
      ["/sap/bc/adt/gw/errorlog", 1],
      [DUMPS_FEED_PATH, 2],
      ["/sap/bc/adt/atc/feeds/verdicts", 4],
    ]);
  });
});

describe("a missing feed:queryDepth is assumed, and says so", () => {
  const catalog = parseFeedsCatalog(readFileSync(join(FIXTURES, "feeds-catalog.xml"), "utf8"));
  // Not a hand-written object: the captured catalog really does contain
  // entries whose extendedData has no queryDepth (and no filter contract at
  // all) — the URI-mapper and system-messages feeds.
  const withoutDepth = catalog.entries.filter(
    (e) => e.extendedData !== undefined && e.extendedData.queryDepth === undefined,
  );

  it("is a real case in the captured catalog, not a hypothetical", () => {
    expect(withoutDepth.map((e) => e.id)).toEqual([
      "/sap/bc/adt/error/urimapper?user=DEVELOPER",
      "/sap/bc/adt/runtime/systemmessages",
    ]);
  });

  it("substitutes DUMPS_ASSUMED_QUERY_DEPTH and flags the substitution", () => {
    for (const entry of withoutDepth) {
      const contract = toDumpsQueryContract(entry.extendedData as FeedExtendedData);
      expect(contract.queryDepth).toBe(DUMPS_ASSUMED_QUERY_DEPTH);
      expect(contract.queryDepth).toBe(2);
      // The whole point of the flag: "we assumed 2" is distinguishable from
      // "the server said 2", which is indistinguishable under a bare `?? 2`.
      expect(contract.queryDepthAssumed).toBe(true);
    }
  });

  it("omits the operator map when the feed served no operator table", () => {
    // Absent, not empty: an empty map would read as "no operator has an arity"
    // and is a different claim from "the feed described none".
    const contract = toDumpsQueryContract(withoutDepth[0]?.extendedData as FeedExtendedData);
    expect(contract.operators).toBeUndefined();
    expect(contract.attributes).toEqual([]);
  });

  it("says ASSUMED in the EXCESS_DEPTH message, and does not when it is served", () => {
    const assumed: DumpsQueryContract = {
      ...DUMPS_CONTRACT_AS_CAPTURED,
      queryDepth: 1,
      queryDepthAssumed: true,
    };
    const assumedMessage = validateFqlQuery("and ( equals ( user , DEVELOPER ) )", assumed)
      .violations.map((v) => v.message)
      .join(" ");
    expect(assumedMessage).toContain("served no queryDepth");
    expect(assumedMessage).toContain("ASSUMED");
    expect(assumedMessage).toContain("this client's, not the server's");

    const served: DumpsQueryContract = { ...DUMPS_CONTRACT_AS_CAPTURED, queryDepth: 1 };
    const servedMessage = validateFqlQuery("and ( equals ( user , DEVELOPER ) )", served)
      .violations.map((v) => v.message)
      .join(" ");
    expect(servedMessage).toContain("advertises queryDepth 1 and ENFORCES it");
    expect(servedMessage).not.toContain("ASSUMED");
  });
});

describe("a parser-derived contract drives validation end to end", () => {
  const catalog = parseFeedsCatalog(readFileSync(join(FIXTURES, "feeds-catalog.xml"), "utf8"));
  const contract = toDumpsQueryContract(
    catalog.entries.find((e) => e.id === DUMPS_FEED_PATH)?.extendedData as FeedExtendedData,
  );

  it("still refuses contains(user, …) when the contract came from the wire", () => {
    // The sharpest signal that per-attribute operator lists survived the
    // adapter: `user` is a `string`, and a contract rebuilt from dataTypes
    // instead of from `feed:attribute/feed:operators` would accept this.
    const result = validateFqlQuery("and ( contains ( user , DEV ) )", contract);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(["OPERATOR_NOT_PERMITTED"]);
    expect(result.violations[0]?.message).toContain("equals, notEquals");
  });

  it("still accepts contains(component, …) — same dataType, wider operator list", () => {
    const result = validateFqlQuery("and ( contains ( component , BC ) )", contract);
    expect(result.violations).toEqual([]);
    expect(result.canonical).toBe("and ( contains ( component , BC ) )");
  });

  it("enforces the wire's between-takes-2 arity from the derived map", () => {
    expect(
      codes("and ( between ( datetime , 20260804000000 ) )", contract),
    ).toEqual(["OPERAND_COUNT"]);
    expect(
      validateFqlQuery(
        "and ( between ( datetime , 20260804000000 , 20260811000000 ) )",
        contract,
      ).ok,
    ).toBe(true);
  });

  it("builds a URL from the served contract identically to the fallback", () => {
    const fromWire = buildDumpsFeedUrl({ $query: userIsDeveloper, $top: 5 }, { contract });
    const fromFallback = buildDumpsFeedUrl({ $query: userIsDeveloper, $top: 5 });
    expect(fromWire.url).toBe(fromFallback.url);
  });
});
