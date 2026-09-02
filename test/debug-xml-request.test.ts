/**
 * `src/debug/xml-request.ts` request-body builders — offline, no live SAP calls.
 *
 * Every "got this wrong elsewhere" note below is testing the
 * specific correction, not just the happy path.
 */
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { AbapError } from "../src/adt/errors.js";
import {
  buildBreakpointsRequestXml,
  buildGetChildVariablesXml,
  buildGetVariablesXml,
  buildLineBreakpointUri,
  escapeXml,
} from "../src/debug/xml-request.js";
import type { Breakpoint, BreakpointsRequest } from "../src/debug/types.js";

function parse(xml: string) {
  const validity = XMLValidator.validate(xml);
  expect(validity, `not well-formed: ${JSON.stringify(validity)}\n${xml}`).toBe(true);
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(xml);
}

const USER_CTX = { debuggingMode: "user" as const, requestUser: "DEVELOPER" };
const TERM_CTX = { debuggingMode: "terminal" as const, terminalId: "T".repeat(32), ideId: "ZMCP" };

// ---------------------------------------------------------------------------
// escapeXml
// ---------------------------------------------------------------------------

describe("escapeXml", () => {
  it("escapes all five XML special characters", () => {
    expect(escapeXml("&")).toBe("&amp;");
    expect(escapeXml("<")).toBe("&lt;");
    expect(escapeXml(">")).toBe("&gt;");
    expect(escapeXml('"')).toBe("&quot;");
    expect(escapeXml("'")).toBe("&apos;");
  });

  it("escapes the exact conditional-breakpoint condition from the brief", () => {
    const condition = "lv_i > 10 AND lv_s = 'a&b'";
    const escaped = escapeXml(condition);
    expect(escaped).toBe("lv_i &gt; 10 AND lv_s = &apos;a&amp;b&apos;");
    // and round-tripping it through a real XML attribute must be well-formed
    const xml = `<x a="${escaped}"/>`;
    expect(XMLValidator.validate(xml)).toBe(true);
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(xml);
    expect(parsed.x["@_a"]).toBe(condition);
  });

  it("re-escapes a value that already contains a literal entity (treats input as raw text, not pre-encoded)", () => {
    const raw = "a&amp;b"; // literal ampersand followed by the six characters a m p ;
    expect(escapeXml(raw)).toBe("a&amp;amp;b");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeXml("ZCL_FOO=>BAR( )")).toBe("ZCL_FOO=&gt;BAR( )");
  });
});

// ---------------------------------------------------------------------------
// buildLineBreakpointUri — requirement 5
// ---------------------------------------------------------------------------

describe("buildLineBreakpointUri", () => {
  it("appends a #start=N fragment, nothing more", () => {
    const uri = buildLineBreakpointUri("/sap/bc/adt/programs/programs/zfoo/source/main", 42);
    expect(uri).toBe("/sap/bc/adt/programs/programs/zfoo/source/main#start=42");
  });

  it("rejects an objectUri that already carries a fragment", () => {
    expect(() => buildLineBreakpointUri("/sap/bc/adt/programs/programs/zfoo/source/main#start=1", 42)).toThrow(
      AbapError,
    );
  });

  it("rejects a non-positive or non-integer line", () => {
    expect(() => buildLineBreakpointUri("/foo", 0)).toThrow(AbapError);
    expect(() => buildLineBreakpointUri("/foo", -1)).toThrow(AbapError);
    expect(() => buildLineBreakpointUri("/foo", 1.5)).toThrow(AbapError);
  });

  it("rejects an empty objectUri", () => {
    expect(() => buildLineBreakpointUri("", 1)).toThrow(AbapError);
  });
});

// ---------------------------------------------------------------------------
// buildBreakpointsRequestXml — every kind
// ---------------------------------------------------------------------------

describe("buildBreakpointsRequestXml — every supported kind", () => {
  it("line breakpoint: root prefixed dbg:, child bare <breakpoint>, adtcore:uri carries the fragment", () => {
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      breakpoints: [
        { kind: "line", uri: "/sap/bc/adt/programs/programs/zfoo/source/main#start=42", clientId: "c1", skipCount: 0 },
      ],
    };
    const xml = buildBreakpointsRequestXml(req);
    expect(xml).toContain('<dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger"');
    expect(xml).toContain('xmlns:adtcore="http://www.sap.com/adt/core"');
    // bare <breakpoint>, not <dbg:breakpoint> — the exact bug shipped elsewhere
    expect(xml).toMatch(/<breakpoint[ >]/);
    expect(xml).not.toContain("<dbg:breakpoint ");
    expect(xml).not.toContain("<dbg:breakpoint/>");

    const parsed = parse(xml);
    const bp = parsed["dbg:breakpoints"].breakpoint;
    expect(bp["@_kind"]).toBe("line");
    expect(bp["@_adtcore:uri"]).toBe("/sap/bc/adt/programs/programs/zfoo/source/main#start=42");
    expect(bp["@_clientId"]).toBe("c1");
    expect(bp["@_skipCount"]).toBe("0");
  });

  it("exception breakpoint", () => {
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      breakpoints: [{ kind: "exception", exceptionClass: "CX_SY_ZERODIVIDE" }],
    };
    const parsed = parse(buildBreakpointsRequestXml(req));
    const bp = parsed["dbg:breakpoints"].breakpoint;
    expect(bp["@_kind"]).toBe("exception");
    expect(bp["@_exceptionClass"]).toBe("CX_SY_ZERODIVIDE");
  });

  it("statement breakpoint", () => {
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      breakpoints: [{ kind: "statement", statement: "WRITE" }],
    };
    const parsed = parse(buildBreakpointsRequestXml(req));
    const bp = parsed["dbg:breakpoints"].breakpoint;
    expect(bp["@_kind"]).toBe("statement");
    expect(bp["@_statement"]).toBe("WRITE");
  });

  it("message breakpoint serialises msgId, msgNo AND msgTy (omitted elsewhere)", () => {
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      breakpoints: [{ kind: "message", msgId: "00", msgNo: "001", msgTy: "E" }],
    };
    const parsed = parse(buildBreakpointsRequestXml(req));
    const bp = parsed["dbg:breakpoints"].breakpoint;
    expect(bp["@_msgId"]).toBe("00");
    expect(bp["@_msgNo"]).toBe("001");
    expect(bp["@_msgTy"]).toBe("E");
  });
});

// ---------------------------------------------------------------------------
// Corrections vs. an earlier implementation: no `enabled`, skipCount and clientId actually serialised
// ---------------------------------------------------------------------------

describe("corrections vs. an earlier implementation", () => {
  it("never emits the invented enabled attribute", () => {
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      breakpoints: [{ kind: "line", uri: "/foo#start=1" }],
    };
    expect(buildBreakpointsRequestXml(req)).not.toContain("enabled");
  });

  it("serialises skipCount=0 (a meaningful value, not omittable as falsy)", () => {
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      breakpoints: [{ kind: "line", uri: "/foo#start=1", skipCount: 0 }],
    };
    expect(buildBreakpointsRequestXml(req)).toContain('skipCount="0"');
  });

  it("serialises skipCount=5 and clientId (declared both elsewhere, never wrote them)", () => {
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      breakpoints: [{ kind: "line", uri: "/foo#start=1", skipCount: 5, clientId: "abc-123" }],
    };
    const xml = buildBreakpointsRequestXml(req);
    expect(xml).toContain('skipCount="5"');
    expect(xml).toContain('clientId="abc-123"');
  });

  it("omits skipCount and clientId when not given", () => {
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      breakpoints: [{ kind: "line", uri: "/foo#start=1" }],
    };
    const xml = buildBreakpointsRequestXml(req);
    expect(xml).not.toContain("skipCount");
    expect(xml).not.toContain("clientId");
  });
});

// ---------------------------------------------------------------------------
// validationOnly — requirement 4
// ---------------------------------------------------------------------------

describe("validationOnly", () => {
  it('emits validationOnly="true" (lowercase string, not an XML boolean) when true', () => {
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      breakpoints: [{ kind: "line", uri: "/foo#start=1", validationOnly: true }],
    };
    const xml = buildBreakpointsRequestXml(req);
    expect(xml).toContain('validationOnly="true"');
  });

  it("omits validationOnly when false or undefined", () => {
    const reqFalse: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      breakpoints: [{ kind: "line", uri: "/foo#start=1", validationOnly: false }],
    };
    const reqUndef: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      breakpoints: [{ kind: "line", uri: "/foo#start=1" }],
    };
    expect(buildBreakpointsRequestXml(reqFalse)).not.toContain("validationOnly");
    expect(buildBreakpointsRequestXml(reqUndef)).not.toContain("validationOnly");
  });
});

// ---------------------------------------------------------------------------
// systemDebugging / deactivated — root-level flags, same trueAttr mechanism
// ---------------------------------------------------------------------------

describe("systemDebugging / deactivated root flags", () => {
  it('emits both as "true" when both are set', () => {
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      systemDebugging: true,
      deactivated: true,
      breakpoints: [{ kind: "line", uri: "/foo#start=1" }],
    };
    const xml = buildBreakpointsRequestXml(req);
    expect(xml).toContain('systemDebugging="true"');
    expect(xml).toContain('deactivated="true"');
  });

  it("omits both attribute names entirely when neither is set", () => {
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      breakpoints: [{ kind: "line", uri: "/foo#start=1" }],
    };
    const xml = buildBreakpointsRequestXml(req);
    expect(xml).not.toContain("systemDebugging");
    expect(xml).not.toContain("deactivated");
  });

  it("omits both when explicitly false (false is implicit, not spelled out)", () => {
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      systemDebugging: false,
      deactivated: false,
      breakpoints: [{ kind: "line", uri: "/foo#start=1" }],
    };
    const xml = buildBreakpointsRequestXml(req);
    expect(xml).not.toContain("systemDebugging");
    expect(xml).not.toContain("deactivated");
  });
});

// ---------------------------------------------------------------------------
// Escaping inside a real breakpoint request — requirement 1
// ---------------------------------------------------------------------------

describe("escaping inside a full breakpoint request", () => {
  it("escapes a condition containing > and & so the XML stays well-formed and round-trips", () => {
    const condition = "lv_i > 10 AND lv_s = 'a&b'";
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      breakpoints: [{ kind: "line", uri: "/foo#start=1", condition }],
    };
    const xml = buildBreakpointsRequestXml(req);
    // must be well-formed (this is exactly what breaks in abap-adt-api and elsewhere)
    const parsed = parse(xml);
    const bp = parsed["dbg:breakpoints"].breakpoint;
    expect(bp["@_condition"]).toBe(condition);
  });
});

// ---------------------------------------------------------------------------
// syncScope — requirement 6
// ---------------------------------------------------------------------------

describe("syncScope", () => {
  it("is omitted entirely by default (the non-destructive default)", () => {
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      breakpoints: [{ kind: "line", uri: "/foo#start=1" }],
    };
    expect(buildBreakpointsRequestXml(req)).not.toContain("syncScope");
  });

  it('mode="full" with no objectUri produces <syncScope mode="full"/> with no child', () => {
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      syncScope: { mode: "full" },
      breakpoints: [],
    };
    const xml = buildBreakpointsRequestXml(req);
    const parsed = parse(xml);
    expect(parsed["dbg:breakpoints"].syncScope["@_mode"]).toBe("full");
    expect(parsed["dbg:breakpoints"].syncScope["adtcore:objectReference"]).toBeUndefined();
  });

  it('mode="partial" with an objectUri emits the adtcore:objectReference child', () => {
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      syncScope: { mode: "partial", objectUri: "/sap/bc/adt/programs/programs/zfoo/source/main" },
      breakpoints: [],
    };
    const xml = buildBreakpointsRequestXml(req);
    const parsed = parse(xml);
    expect(parsed["dbg:breakpoints"].syncScope["@_mode"]).toBe("partial");
    expect(parsed["dbg:breakpoints"].syncScope["adtcore:objectReference"]["@_adtcore:uri"]).toBe(
      "/sap/bc/adt/programs/programs/zfoo/source/main",
    );
  });

  it("allows zero breakpoints when only syncScope is used (the only enumeration mechanism)", () => {
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      syncScope: { mode: "full" },
      breakpoints: [],
    };
    expect(() => buildBreakpointsRequestXml(req)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Mandatory-field enforcement — requirement 7
// ---------------------------------------------------------------------------

describe("mandatory-field enforcement", () => {
  it("rejects terminal mode missing terminalId", () => {
    const req: BreakpointsRequest = {
      debuggingMode: "terminal",
      ideId: "ZMCP",
      scope: "external",
      breakpoints: [{ kind: "line", uri: "/foo#start=1" }],
    };
    expect(() => buildBreakpointsRequestXml(req)).toThrow(AbapError);
  });

  it("rejects terminal mode missing ideId", () => {
    const req: BreakpointsRequest = {
      debuggingMode: "terminal",
      terminalId: "T".repeat(32),
      scope: "external",
      breakpoints: [{ kind: "line", uri: "/foo#start=1" }],
    };
    expect(() => buildBreakpointsRequestXml(req)).toThrow(AbapError);
  });

  it("accepts terminal mode with both terminalId and ideId", () => {
    const req: BreakpointsRequest = {
      ...TERM_CTX,
      scope: "external",
      breakpoints: [{ kind: "line", uri: "/foo#start=1" }],
    };
    expect(() => buildBreakpointsRequestXml(req)).not.toThrow();
  });

  it("rejects user mode missing requestUser", () => {
    const req: BreakpointsRequest = {
      debuggingMode: "user",
      scope: "external",
      breakpoints: [{ kind: "line", uri: "/foo#start=1" }],
    };
    expect(() => buildBreakpointsRequestXml(req)).toThrow(AbapError);
  });

  it("accepts user mode without ideId (RECON: ideId is not checked in user mode)", () => {
    const req: BreakpointsRequest = {
      debuggingMode: "user",
      requestUser: "DEVELOPER",
      scope: "external",
      breakpoints: [{ kind: "line", uri: "/foo#start=1" }],
    };
    expect(() => buildBreakpointsRequestXml(req)).not.toThrow();
  });

  it("rejects a breakpoint missing kind", () => {
    const req = {
      ...USER_CTX,
      scope: "external",
      breakpoints: [{ uri: "/foo#start=1" } as unknown as Breakpoint],
    } as BreakpointsRequest;
    expect(() => buildBreakpointsRequestXml(req)).toThrow(AbapError);
  });

  it("rejects a line breakpoint with an empty uri", () => {
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      breakpoints: [{ kind: "line", uri: "" }],
    };
    expect(() => buildBreakpointsRequestXml(req)).toThrow(AbapError);
  });

  it("rejects a message breakpoint missing msgNo", () => {
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      breakpoints: [{ kind: "message", msgId: "00", msgNo: "", msgTy: "E" }],
    };
    expect(() => buildBreakpointsRequestXml(req)).toThrow(AbapError);
  });
});

// ---------------------------------------------------------------------------
// The negative test: an unsupported kind must NOT produce an empty-but-valid
// body. This is the exact failure mode shipped elsewhere four times over
// (badi/enhancement/watchpoint/method) — SAP accepted the empty
// <dbg:breakpoints/> and the caller was told it succeeded.
// ---------------------------------------------------------------------------

describe("unsupported breakpoint kind — requirement 2, the exact failure mode we engineer against", () => {
  it("throws rather than silently producing an empty <dbg:breakpoints/>", () => {
    const bogus = { kind: "watchpoint", variableName: "LT_FOO" } as unknown as Breakpoint;
    const req: BreakpointsRequest = {
      ...USER_CTX,
      scope: "external",
      breakpoints: [bogus],
    };

    let thrown: unknown;
    let result: string | undefined;
    try {
      result = buildBreakpointsRequestXml(req);
    } catch (e) {
      thrown = e;
    }

    expect(result, "must not return a body at all — an empty-but-valid body is the exact bug being prevented").toBeUndefined();
    expect(thrown).toBeInstanceOf(AbapError);
    expect((thrown as AbapError).message).toContain("watchpoint");
  });

  it("also rejects the other three kinds declared elsewhere but never implemented", () => {
    for (const kind of ["badi", "enhancement", "method"]) {
      const bogus = { kind } as unknown as Breakpoint;
      const req: BreakpointsRequest = { ...USER_CTX, scope: "external", breakpoints: [bogus] };
      expect(() => buildBreakpointsRequestXml(req), `kind=${kind} should throw`).toThrow(AbapError);
    }
  });
});

// ---------------------------------------------------------------------------
// asx:abap variable-call bodies
// ---------------------------------------------------------------------------

describe("buildGetVariablesXml", () => {
  it("produces the flat asx:abap envelope with SCREAMING_SNAKE elements", () => {
    const xml = buildGetVariablesXml(["SY-SUBRC"]);
    const parsed = parse(xml);
    expect(parsed["asx:abap"]["@_version"]).toBe("1.0");
    const row = parsed["asx:abap"]["asx:values"].DATA.STPDA_ADT_VARIABLE;
    expect(row.ID).toBe("SY-SUBRC");
  });

  it("batches multiple ids as sibling rows", () => {
    const xml = buildGetVariablesXml(["SY-SUBRC", "LT_ITEMS[3]-MATNR"]);
    const parsed = parse(xml);
    const rows = parsed["asx:abap"]["asx:values"].DATA.STPDA_ADT_VARIABLE;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.map((r: { ID: string }) => r.ID)).toEqual(["SY-SUBRC", "LT_ITEMS[3]-MATNR"]);
  });

  it("escapes a variable id containing XML-special characters", () => {
    const xml = buildGetVariablesXml(["LS_HDR-COND(A&B)"]);
    const parsed = parse(xml);
    expect(parsed["asx:abap"]["asx:values"].DATA.STPDA_ADT_VARIABLE.ID).toBe("LS_HDR-COND(A&B)");
  });

  it("rejects an empty id list", () => {
    expect(() => buildGetVariablesXml([])).toThrow(AbapError);
  });
});

describe("buildGetChildVariablesXml", () => {
  it("produces the nested HIERARCHIES envelope — one level deeper than getVariables", () => {
    const xml = buildGetChildVariablesXml(["@ROOT"]);
    const parsed = parse(xml);
    const row = parsed["asx:abap"]["asx:values"].DATA.HIERARCHIES.STPDA_ADT_VARIABLE_HIERARCHY;
    expect(row.PARENT_ID).toBe("@ROOT");
  });

  it("batches multiple parent ids", () => {
    const xml = buildGetChildVariablesXml(["@ROOT", "@DATAAGING"]);
    const parsed = parse(xml);
    const rows = parsed["asx:abap"]["asx:values"].DATA.HIERARCHIES.STPDA_ADT_VARIABLE_HIERARCHY;
    expect(rows.map((r: { PARENT_ID: string }) => r.PARENT_ID)).toEqual(["@ROOT", "@DATAAGING"]);
  });

  it("rejects an empty parent id list", () => {
    expect(() => buildGetChildVariablesXml([])).toThrow(AbapError);
  });
});

// ===========================================================================
// Guard-family coverage added after the silent-success review wave.
//
// The tests above exercised `""` for a mandatory field but NEVER `undefined`,
// never an omitted property and never `null` — which is exactly how a
// `{kind:"exception"}` with no exceptionClass survived: it serialised to a
// well-formed EMPTY `<breakpoint kind="exception"/>`, SAP answered 200, and
// nothing was registered. Everything below is generated as a cross-product so
// the coverage is provably complete rather than hand-listed.
// ===========================================================================

/**
 * Independent re-implementation of XML escaping. Deliberately does NOT call the
 * production `escapeXml`: asserting a builder's output against the very escaper
 * it uses is a tautology that a `String(value)`/no-escaping regression would
 * still pass.
 */
function expectedEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Every one of the five XML metacharacters in a single payload. */
const NASTY = `a&b<c>d"e'f`;

/** Only the `@_`-prefixed keys of a parsed element, i.e. the attributes actually emitted. */
function attrsOf(node: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(node).filter(([k]) => k.startsWith("@_")));
}

/**
 * Asserts a raw value reached the wire ESCAPED: the escaped form is present,
 * the raw form appears nowhere, the document is well-formed, and it re-parses
 * back to the original unescaped value.
 */
function expectEscapedRoundTrip(xml: string, raw: string, readBack: (parsed: Record<string, unknown>) => unknown): void {
  expect(xml, "raw payload must not appear unescaped anywhere in the body").not.toContain(raw);
  expect(xml).toContain(expectedEscape(raw));
  expect(readBack(parse(xml))).toBe(raw);
}

// ---------------------------------------------------------------------------
// (A) Mandatory breakpoint fields: FULL kind x field x bad-value cross-product
// ---------------------------------------------------------------------------

const VALID_BY_KIND: Record<string, Record<string, unknown>> = {
  line: { kind: "line", uri: "/sap/bc/adt/programs/programs/zfoo/source/main#start=42" },
  exception: { kind: "exception", exceptionClass: "CX_SY_ZERODIVIDE" },
  statement: { kind: "statement", statement: "WRITE" },
  message: { kind: "message", msgId: "00", msgNo: "001", msgTy: "E" },
};

/** The six (kind, mandatory field) slots the wire protocol actually has. */
const REQUIRED_SLOTS: ReadonlyArray<readonly [string, string]> = [
  ["line", "uri"],
  ["exception", "exceptionClass"],
  ["statement", "statement"],
  ["message", "msgId"],
  ["message", "msgNo"],
  ["message", "msgTy"],
];

const BAD_VALUE_MODES: ReadonlyArray<readonly [string, (base: Record<string, unknown>, field: string) => Record<string, unknown>]> = [
  ["explicitly undefined", (base, field) => ({ ...base, [field]: undefined })],
  [
    "property omitted",
    (base, field) => {
      const copy = { ...base };
      delete copy[field];
      return copy;
    },
  ],
  ["null", (base, field) => ({ ...base, [field]: null })],
  ["empty string", (base, field) => ({ ...base, [field]: "" })],
];

const REJECTION_CASES: Array<{ kind: string; field: string; label: string; bp: Record<string, unknown> }> = [];
for (const [kind, field] of REQUIRED_SLOTS) {
  for (const [label, mutate] of BAD_VALUE_MODES) {
    REJECTION_CASES.push({ kind, field, label, bp: mutate(VALID_BY_KIND[kind] as Record<string, unknown>, field) });
  }
}

function requestWith(bp: unknown): BreakpointsRequest {
  return { ...USER_CTX, scope: "external", breakpoints: [bp as Breakpoint] } as BreakpointsRequest;
}

describe("mandatory breakpoint fields — full kind x field x bad-value cross-product", () => {
  it("the generated matrix is complete (6 slots x 4 bad-value shapes) and every valid baseline builds", () => {
    expect(REQUIRED_SLOTS).toHaveLength(6);
    expect(BAD_VALUE_MODES).toHaveLength(4);
    expect(REJECTION_CASES).toHaveLength(24);
    // Baseline sanity: each unmutated kind builds, so a rejection below can only
    // be attributable to the one mutated field.
    for (const kind of Object.keys(VALID_BY_KIND)) {
      expect(() => buildBreakpointsRequestXml(requestWith(VALID_BY_KIND[kind])), `valid ${kind} must build`).not.toThrow();
    }
  });

  it.each(REJECTION_CASES)("kind $kind, field $field = $label -> BAD_INPUT naming both", ({ kind, field, bp }) => {
    let thrown: unknown;
    let result: string | undefined;
    try {
      result = buildBreakpointsRequestXml(requestWith(bp));
    } catch (e) {
      thrown = e;
    }

    expect(
      result,
      "returning a body here IS the bug: SAP answers 200 to an empty element and registers nothing",
    ).toBeUndefined();
    expect(thrown).toBeInstanceOf(AbapError);
    const err = thrown as AbapError;
    expect(err.code).toBe("BAD_INPUT");
    // A caller must be able to fix the call from the message alone: it has to
    // name WHICH field, and on WHICH kind.
    expect(err.message).toContain(`field "${field}"`);
    expect(err.message).toContain(`kind "${kind}"`);
  });
});

// ---------------------------------------------------------------------------
// (B) The headline regression — the exact shape that shipped silently.
// ---------------------------------------------------------------------------

describe('headline regression: bare {kind:"exception"} must never serialise', () => {
  it('throws instead of emitting an empty <breakpoint kind="exception"/> that SAP 200s and ignores', () => {
    let thrown: unknown;
    let result: string | undefined;
    try {
      result = buildBreakpointsRequestXml(requestWith({ kind: "exception" }));
    } catch (e) {
      thrown = e;
    }

    expect(result, "an empty-but-well-formed breakpoint element is silent success — the worst bug shape here").toBeUndefined();
    expect(thrown).toBeInstanceOf(AbapError);
    const err = thrown as AbapError;
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("exceptionClass");
    expect(err.message).toContain('kind "exception"');
  });
});

// ---------------------------------------------------------------------------
// (C) Root-element attribute emission — parsed attributes, not substrings.
// ---------------------------------------------------------------------------

describe("root element attributes (parsed, exact set)", () => {
  it("buildBreakpointsRequestXml emits exactly the dbg/adtcore namespaces plus the user-mode context", () => {
    const parsed = parse(buildBreakpointsRequestXml(requestWith({ kind: "line", uri: "/foo#start=1" })));
    expect(attrsOf(parsed["dbg:breakpoints"])).toEqual({
      "@_xmlns:dbg": "http://www.sap.com/adt/debugger",
      "@_xmlns:adtcore": "http://www.sap.com/adt/core",
      "@_debuggingMode": "user",
      "@_scope": "external",
      "@_requestUser": "DEVELOPER",
    });
  });

  it("buildBreakpointsRequestXml emits terminalId/ideId (and no requestUser) in terminal mode", () => {
    const req: BreakpointsRequest = {
      ...TERM_CTX,
      scope: "debugger",
      breakpoints: [{ kind: "line", uri: "/foo#start=1" }],
    };
    expect(attrsOf(parse(buildBreakpointsRequestXml(req))["dbg:breakpoints"])).toEqual({
      "@_xmlns:dbg": "http://www.sap.com/adt/debugger",
      "@_xmlns:adtcore": "http://www.sap.com/adt/core",
      "@_debuggingMode": "terminal",
      "@_scope": "debugger",
      "@_terminalId": "T".repeat(32),
      "@_ideId": "ZMCP",
    });
  });

  it("buildGetVariablesXml emits exactly xmlns:asx and version on asx:abap", () => {
    expect(attrsOf(parse(buildGetVariablesXml(["SY-SUBRC"]))["asx:abap"])).toEqual({
      "@_xmlns:asx": "http://www.sap.com/abapxml",
      "@_version": "1.0",
    });
  });

  it("buildGetChildVariablesXml emits exactly xmlns:asx and version on asx:abap", () => {
    expect(attrsOf(parse(buildGetChildVariablesXml(["@ROOT"]))["asx:abap"])).toEqual({
      "@_xmlns:asx": "http://www.sap.com/abapxml",
      "@_version": "1.0",
    });
  });

  it("the adtcore namespace is re-declared on the syncScope objectReference child", () => {
    const req = {
      ...USER_CTX,
      scope: "external",
      syncScope: { mode: "partial", objectUri: "/sap/bc/adt/programs/programs/zfoo/source/main" },
      breakpoints: [],
    } as BreakpointsRequest;
    const ref = parse(buildBreakpointsRequestXml(req))["dbg:breakpoints"].syncScope["adtcore:objectReference"];
    expect(attrsOf(ref)).toEqual({
      "@_xmlns:adtcore": "http://www.sap.com/adt/core",
      "@_adtcore:uri": "/sap/bc/adt/programs/programs/zfoo/source/main",
    });
  });
});

// ---------------------------------------------------------------------------
// (D) Escaping at EVERY hand-rolled interpolation site.
//
// Sites found by grepping the source for `${escapeXml(`:
//   1. strAttr()                      — every string attribute (both families)
//   2. numAttr()                      — String(n), no metacharacters possible
//   3. breakpoint adtcore:uri         — template literal, line kind
//   4. syncScope <syncScope mode=…>   — template literal
//   5. syncScope objectReference uri  — template literal
//   6. <ID> text node                 — buildGetVariablesXml
//   7. <PARENT_ID> text node          — buildGetChildVariablesXml
// ---------------------------------------------------------------------------

describe("escaping at every hand-rolled interpolation site", () => {
  it("site 1a: strAttr on a breakpoint attribute (condition, clientId)", () => {
    const xml = buildBreakpointsRequestXml(requestWith({ kind: "line", uri: "/foo#start=1", condition: NASTY, clientId: NASTY }));
    expectEscapedRoundTrip(xml, NASTY, (p) => (p as any)["dbg:breakpoints"].breakpoint["@_condition"]);
    expect(parse(xml)["dbg:breakpoints"].breakpoint["@_clientId"]).toBe(NASTY);
  });

  it("site 1b: strAttr on a root attribute (requestUser)", () => {
    const req = { debuggingMode: "user", requestUser: NASTY, scope: "external", breakpoints: [] } as BreakpointsRequest;
    expectEscapedRoundTrip(buildBreakpointsRequestXml(req), NASTY, (p) => (p as any)["dbg:breakpoints"]["@_requestUser"]);
  });

  it("site 1c: strAttr on the payload attributes of exception / statement / message kinds", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ kind: "exception", exceptionClass: NASTY }, "@_exceptionClass"],
      [{ kind: "statement", statement: NASTY }, "@_statement"],
      [{ kind: "message", msgId: NASTY, msgNo: "001", msgTy: "E" }, "@_msgId"],
      [{ kind: "message", msgId: "00", msgNo: NASTY, msgTy: "E" }, "@_msgNo"],
      [{ kind: "message", msgId: "00", msgNo: "001", msgTy: NASTY }, "@_msgTy"],
    ];
    for (const [bp, attr] of cases) {
      expectEscapedRoundTrip(buildBreakpointsRequestXml(requestWith(bp)), NASTY, (p) => (p as any)["dbg:breakpoints"].breakpoint[attr]);
    }
  });

  it("site 3: the breakpoint adtcore:uri template literal", () => {
    const uri = `/sap/bc/adt/programs/programs/${NASTY}/source/main#start=42`;
    expectEscapedRoundTrip(
      buildBreakpointsRequestXml(requestWith({ kind: "line", uri })),
      uri,
      (p) => (p as any)["dbg:breakpoints"].breakpoint["@_adtcore:uri"],
    );
  });

  it("site 4: the <syncScope mode=…> template literal", () => {
    const req = {
      ...USER_CTX,
      scope: "external",
      syncScope: { mode: NASTY as unknown as "full" },
      breakpoints: [],
    } as BreakpointsRequest;
    expectEscapedRoundTrip(buildBreakpointsRequestXml(req), NASTY, (p) => (p as any)["dbg:breakpoints"].syncScope["@_mode"]);
  });

  it("site 5: the syncScope adtcore:objectReference uri template literal", () => {
    const objectUri = `/sap/bc/adt/programs/programs/${NASTY}/source/main`;
    const req = {
      ...USER_CTX,
      scope: "external",
      syncScope: { mode: "full", objectUri },
      breakpoints: [],
    } as BreakpointsRequest;
    expectEscapedRoundTrip(
      buildBreakpointsRequestXml(req),
      objectUri,
      (p) => (p as any)["dbg:breakpoints"].syncScope["adtcore:objectReference"]["@_adtcore:uri"],
    );
  });

  it("site 6: the <ID> text node in buildGetVariablesXml", () => {
    expectEscapedRoundTrip(
      buildGetVariablesXml([NASTY]),
      NASTY,
      (p) => (p as any)["asx:abap"]["asx:values"].DATA.STPDA_ADT_VARIABLE.ID,
    );
  });

  it("site 7: the <PARENT_ID> text node in buildGetChildVariablesXml", () => {
    expectEscapedRoundTrip(
      buildGetChildVariablesXml([NASTY]),
      NASTY,
      (p) => (p as any)["asx:abap"]["asx:values"].DATA.HIERARCHIES.STPDA_ADT_VARIABLE_HIERARCHY.PARENT_ID,
    );
  });
});

// ---------------------------------------------------------------------------
// (E) escapeXml's non-string guard — and proof it did not break the numeric path.
// ---------------------------------------------------------------------------

describe("escapeXml non-string guard", () => {
  const BAD_INPUTS: ReadonlyArray<readonly [string, unknown, string]> = [
    ["number", 42, "number"],
    ["null", null, "object"],
    ["undefined", undefined, "undefined"],
    ["object", { uri: "/foo" }, "object"],
    ["array", ["/foo"], "object"],
    ["boolean", true, "boolean"],
  ];

  it.each(BAD_INPUTS)("rejects a %s with BAD_INPUT naming the typeof", (_label, value, expectedTypeof) => {
    let thrown: unknown;
    let result: string | undefined;
    try {
      result = escapeXml(value as string);
    } catch (e) {
      thrown = e;
    }
    expect(result, "coercing here is how `[object Object]` reaches SAP as an ADT uri").toBeUndefined();
    expect(thrown).toBeInstanceOf(AbapError);
    expect((thrown as AbapError).code).toBe("BAD_INPUT");
    expect((thrown as AbapError).message).toContain(`typeof "${expectedTypeof}"`);
  });

  it("still escapes ordinary strings, including the empty string", () => {
    expect(escapeXml("")).toBe("");
    expect(escapeXml(NASTY)).toBe(expectedEscape(NASTY));
  });

  it("does not break the numeric attribute path — skipCount is stringified before escaping", () => {
    for (const [skipCount, expected] of [
      [0, "0"],
      [5, "5"],
      [4294967295, "4294967295"],
    ] as Array<[number, string]>) {
      const parsed = parse(buildBreakpointsRequestXml(requestWith({ kind: "line", uri: "/foo#start=1", skipCount })));
      expect(parsed["dbg:breakpoints"].breakpoint["@_skipCount"]).toBe(expected);
    }
  });
});
