/**
 * `src/debug/xml-response.ts` — offline red/green loop against the seven captured fixtures
 * in `test/fixtures/debugger/` (see that directory's README for provenance) plus the adversarial
 * cases below. Zero live calls — every test here
 * reads a local fixture file or an inline string literal.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEBUGGEE_ENDED_CLASS,
  DEBUG_SESSION_ENDED_CLASS,
  DebugXmlParseError,
  alignRequestedVariables,
  classifyDebugSessionFailure,
  collectExceptionClassNames,
  decodeHexValue,
  formatAbapNumeric,
  indexVariablesById,
  isComplexType,
  isConflict,
  isDebuggeeEnded,
  isNoSessionAttached,
  isSessionExpired,
  parseAbapNumeric,
  parseAdtError,
  parseAttachResponse,
  parseBatchResponse,
  parseBreakpointsResponse,
  parseChildVariablesResponse,
  parseDebuggeeResponse,
  parseSettingsAttrs,
  parseSettingsResponse,
  parseStackResponse,
  parseStepResponse,
  parseVariablesResponse,
  xBool,
} from "../src/debug/xml-response.js";
import { isTruncated } from "../src/truncate.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "debugger");
const fixture = (name: string) => readFileSync(join(FIXTURE_DIR, name), "utf8");

/**
 * The 2026-07 appliance captures. Read STRAIGHT FROM `test/fixtures/live-captured/` rather than
 * copied into `fixtures/debugger/` on purpose: these files are the evidence, and a copy is a
 * second source of truth that can silently drift from the bytes it claims to reproduce. Every
 * assertion in the "LIVE BYTES" blocks below is a byte the server actually sent.
 */
const LIVE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const live = (name: string) => readFileSync(join(LIVE_DIR, name), "utf8");

// ---------------------------------------------------------------------------
// dbg: family — attach / step / stack
// ---------------------------------------------------------------------------

describe("parseAttachResponse (attach.xml)", () => {
  const result = parseAttachResponse(fixture("attach.xml"));

  it("parses camelCase dbg: attributes with true/false booleans", () => {
    expect(result.isRfc).toBe(false);
    expect(result.isSameSystem).toBe(true);
    expect(result.serverName).toBe("A4HSANDBOX_A4H_01");
    expect(result.debugSessionId).toBe("session123");
    expect(result.processId).toBe(42);
    expect(result.isPostMortem).toBe(false);
    expect(result.isUserAuthorizedForChanges).toBe(true);
    expect(result.debuggeeSessionId).toBe("debuggee456");
    expect(result.abapTraceState).toBe("OFF");
    expect(result.canAdvancedTableFeatures).toBe(true);
    expect(result.guiEditorGuid).toBe("");
    expect(result.sessionTitle).toBe("TESTUSER");
    expect(result.isSteppingPossible).toBe(true);
    expect(result.isTerminationPossible).toBe(true);
  });

  it("parses the actions list (multiple entries)", () => {
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]).toMatchObject({ name: "stepInto", style: "push", group: "stepping", title: "Step Into" });
    expect(result.actions[1]).toMatchObject({ name: "stepOver" });
  });

  it("parses reachedBreakpoints (single entry, not wrapped as an array on the wire)", () => {
    expect(result.reachedBreakpoints).toHaveLength(1);
    expect(result.reachedBreakpoints[0]).toMatchObject({ id: "BP001", kind: "line" });
  });

  it("throws DebugXmlParseError on the wrong root element", () => {
    expect(() => parseAttachResponse("<dbg:step/>")).toThrow(DebugXmlParseError);
  });
});

describe("parseStepResponse (step.xml)", () => {
  const result = parseStepResponse(fixture("step.xml"));

  it("parses the step-specific fields and nested settings", () => {
    expect(result.isDebuggeeChanged).toBe(false);
    expect(result.settings).toEqual({
      systemDebugging: false,
      createExceptionObject: false,
      backgroundRFC: false,
      sharedObjectDebugging: false,
      showDataAging: false,
      updateDebugging: false,
    });
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ name: "stepOver" });
  });

  it("survives an empty <dbg:reachedBreakpoints/> as [] rather than dropping the field", () => {
    // step.xml's own reachedBreakpoints is empty (no breakpoint was hit on this step) — that is
    // itself meaningful and distinct from abap-adt-api's bug (and others), which never even reads the
    // field. [] here is correct; see the adversarial test below
    // for proof that non-empty content is not silently dropped.
    expect(result.reachedBreakpoints).toEqual([]);
  });

  it("defaults DebugSessionState fields the step.xml fixture omits, rather than throwing", () => {
    // step.xml has no isPostMortem/isUserAuthorizedForChanges/debuggeeSessionId/abapTraceState/
    // canAdvancedTableFeatures/isNonExclusive/isNonExclusiveToggled/guiEditorGuid/sessionTitle,
    // though DebugSessionState declares all of them required. This fixture gap needs live
    // confirmation; documented here so a future reader isn't surprised by the defaults.
    expect(result.isPostMortem).toBe(false);
    expect(result.debuggeeSessionId).toBe("");
    expect(result.sessionTitle).toBe("");
  });

  it("ADVERSARIAL: a populated <dbg:reachedBreakpoints> on a step response is not dropped (§5.7 item 1)", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<dbg:step xmlns:dbg="http://www.sap.com/adt/debugger" isRfc="false" isSameSystem="true" serverName="s" debugSessionId="s1" processId="1" isDebuggeeChanged="true" isSteppingPossible="true" isTerminationPossible="true">
  <dbg:settings systemDebugging="false" createExceptionObject="false" backgroundRFC="false" sharedObjectDebugging="false" showDataAging="false" updateDebugging="false"/>
  <dbg:actions/>
  <dbg:reachedBreakpoints>
    <dbg:breakpoint id="BP042" kind="line" unresolvableCondition="lv_x > 10" unresolvableConditionErrorOffset="3"/>
  </dbg:reachedBreakpoints>
</dbg:step>`;
    const parsed = parseStepResponse(xml);
    expect(parsed.reachedBreakpoints).toHaveLength(1);
    expect(parsed.reachedBreakpoints[0]).toMatchObject({
      id: "BP042",
      kind: "line",
      unresolvableCondition: "lv_x > 10",
      unresolvableConditionErrorOffset: "3",
    });
  });

  it("throws DebugXmlParseError on the wrong root element", () => {
    expect(() => parseStepResponse("<dbg:attach/>")).toThrow(DebugXmlParseError);
  });
});

describe("parseSettingsResponse — the setDebuggerSettings POST's own response body", () => {
  const KEYS = [
    "systemDebugging",
    "createExceptionObject",
    "backgroundRFC",
    "sharedObjectDebugging",
    "showDataAging",
    "updateDebugging",
  ] as const;

  const settingsXml = (attrs: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><dbg:settings xmlns:dbg="http://www.sap.com/adt/debugger" ${attrs}/>`;

  it("round-trips every one of the six booleans, true and false, independently", () => {
    // One case per key: that key true, the other five false. Catches a copy/paste
    // mis-wiring (e.g. showDataAging reading backgroundRFC's attribute) that a
    // uniform all-true fixture would sail straight past.
    for (const key of KEYS) {
      const attrs = KEYS.map((k) => `${k}="${k === key ? "true" : "false"}"`).join(" ");
      const parsed = parseSettingsResponse(settingsXml(attrs));
      for (const k of KEYS) {
        expect({ key, k, value: parsed[k] }).toEqual({ key, k, value: k === key });
      }
    }
  });

  it("uses the dbg: family's true/false convention — an attribute is never the ABAP 'X' flag", () => {
    // RETITLED (was "…never the asx:abap X/'' one"): the old title implied asx:abap is uniformly
    // X-flagged, which the live corpus disproves (STPDA_DEBUGGEE sends "true"/"false"). The claim
    // that survives contact with the bytes is narrower and stronger: NO XML ATTRIBUTE anywhere in
    // the 96-capture corpus carries the value "X". So an attribute reader must never accept it.
    const parsed = parseSettingsResponse(settingsXml(KEYS.map((k) => `${k}="X"`).join(" ")));
    for (const k of KEYS) expect(parsed[k]).toBe(false);
  });

  it("treats absent attributes as false", () => {
    const parsed = parseSettingsResponse(settingsXml(`showDataAging="true"`));
    expect(parsed.showDataAging).toBe(true);
    expect(parsed.systemDebugging).toBe(false);
    expect(parsed.updateDebugging).toBe(false);
  });

  it("rejects a body whose root is not <dbg:settings>", () => {
    expect(() => parseSettingsResponse("<dbg:step/>")).toThrow(DebugXmlParseError);
    expect(() => parseSettingsResponse("")).toThrow(DebugXmlParseError);
  });

  it("is the SAME implementation parseStepResponse uses for its nested snapshot", () => {
    // One parser, two carriers: the step response's nested element and the POST's root
    // element must never drift apart.
    const attrs = `systemDebugging="true" showDataAging="true" updateDebugging="true"`;
    const fromPost = parseSettingsResponse(settingsXml(attrs));
    const fromStep = parseStepResponse(
      `<?xml version="1.0" encoding="UTF-8"?><dbg:step xmlns:dbg="http://www.sap.com/adt/debugger" isDebuggeeChanged="false">` +
        `<dbg:settings ${attrs}/></dbg:step>`,
    ).settings;
    expect(fromStep).toEqual(fromPost);
  });

  it("parseSettingsAttrs defaults an absent node to all-false", () => {
    expect(parseSettingsAttrs(undefined)).toEqual({
      systemDebugging: false,
      createExceptionObject: false,
      backgroundRFC: false,
      sharedObjectDebugging: false,
      showDataAging: false,
      updateDebugging: false,
    });
  });
});

describe("parseStackResponse (stack.xml)", () => {
  const result = parseStackResponse(fixture("stack.xml"));

  it("parses both stack frames with 1-based stackPosition", () => {
    expect(result.frames).toHaveLength(2);
    expect(result.frames[0]).toMatchObject({
      stackPosition: 1,
      stackType: "ABAP",
      programName: "ZTEST_MCP_CRUD",
      includeName: "ZTEST_MCP_CRUD",
      line: 15,
      eventType: "REPORT",
      systemProgram: false,
      uri: "/sap/bc/adt/programs/programs/ZTEST_MCP_CRUD/source/main#start=15",
    });
    expect(result.frames[1]).toMatchObject({
      stackPosition: 2,
      programName: "CL_ADT_RES_UNIT_TEST_RUN",
      eventType: "METHOD",
      eventName: "POST",
      systemProgram: true,
    });
  });

  it("leaves uri undefined on a frame that doesn't carry one (second frame)", () => {
    expect(result.frames[1]!.uri).toBeUndefined();
  });

  it("parses the root debugCursorStackIndex", () => {
    expect(result.debugCursorStackIndex).toBe(1);
  });

  it("ADVERSARIAL: stackPosition is 1-based, not the zero-based array index (§12.4 item 8)", () => {
    // The fixture's frames happen to be in order, so array index + 1 === stackPosition here —
    // this test pins that stackPosition is read from the wire attribute, not derived from the
    // array position, by checking the field survives an out-of-order / gapped listing.
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<dbg:stack xmlns:dbg="http://www.sap.com/adt/debugger" isRfc="false" isSameSystem="true" serverName="s">
  <dbg:stackEntry stackPosition="3" stackType="ABAP" stackUri="u3" programName="P3" includeName="P3" line="1" eventType="E" eventName="N" sourceType="ABAP" systemProgram="false" isVit="false"/>
  <dbg:stackEntry stackPosition="1" stackType="ABAP" stackUri="u1" programName="P1" includeName="P1" line="1" eventType="E" eventName="N" sourceType="ABAP" systemProgram="false" isVit="false"/>
</dbg:stack>`;
    const parsed = parseStackResponse(xml);
    // Array index 0 has stackPosition 3, not 1 — proves the field is read verbatim.
    expect(parsed.frames[0]!.stackPosition).toBe(3);
    expect(parsed.frames[1]!.stackPosition).toBe(1);
  });

  it("throws DebugXmlParseError on the wrong root element", () => {
    expect(() => parseStackResponse("<dbg:attach/>")).toThrow(DebugXmlParseError);
  });
});

describe("ADVERSARIAL: namespace-strip must not corrupt a value containing the literal 'dbg:' (§12.4 item 6)", () => {
  it("preserves 'dbg:' inside an attribute value on a dbg: family response", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<dbg:attach xmlns:dbg="http://www.sap.com/adt/debugger" isRfc="false" isSameSystem="true" serverName="dbg:not-a-namespace-prefix" debugSessionId="s" processId="1" isPostMortem="false" isUserAuthorizedForChanges="true" debuggeeSessionId="d" abapTraceState="OFF" canAdvancedTableFeatures="true" isNonExclusive="false" isNonExclusiveToggled="false" guiEditorGuid="" sessionTitle="T" isSteppingPossible="true" isTerminationPossible="true">
  <dbg:actions/>
  <dbg:reachedBreakpoints/>
</dbg:attach>`;
    // A naive strings.ReplaceAll(xml, "dbg:", "") would turn this into "not-a-namespace-prefix".
    expect(parseAttachResponse(xml).serverName).toBe("dbg:not-a-namespace-prefix");
  });

  it("preserves 'dbg:' inside an asx:abap VALUE child element", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
    <DATA>
      <STPDA_ADT_VARIABLE>
        <ID>LV_S</ID>
        <NAME>LV_S</NAME>
        <DECLARED_TYPE_NAME>STRING</DECLARED_TYPE_NAME>
        <ACTUAL_TYPE_NAME>STRING</ACTUAL_TYPE_NAME>
        <KIND>LOCAL</KIND>
        <META_TYPE>string</META_TYPE>
        <VALUE>dbg:foo</VALUE>
        <READ_ONLY></READ_ONLY>
        <TECHNICAL_TYPE>C</TECHNICAL_TYPE>
        <LENGTH>7</LENGTH>
      </STPDA_ADT_VARIABLE>
    </DATA>
  </asx:values>
</asx:abap>`;
    const vars = parseVariablesResponse(xml);
    expect(vars).toHaveLength(1);
    // A naive strings.ReplaceAll(xml, "dbg:", "") would turn this into "foo".
    expect(vars[0]!.value).toBe("dbg:foo");
  });
});

// ---------------------------------------------------------------------------
// asx:abap family — variables / child variables / debuggee
// ---------------------------------------------------------------------------

describe("parseVariablesResponse (variables.xml) — getVariables, DATA.STPDA_ADT_VARIABLE directly", () => {
  const result = parseVariablesResponse(fixture("variables.xml"));

  it("parses both rows with SCREAMING_SNAKE fields and X/'' booleans", () => {
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: "LV_COUNT",
      name: "LV_COUNT",
      declaredTypeName: "I",
      actualTypeName: "I",
      kind: "LOCAL",
      metaType: "simple",
      value: "42",
      hexValue: "0000002A",
      readOnly: false,
      technicalType: "I",
      length: 4,
      tableLines: 0,
      isValueIncomplete: false,
      isException: false,
    });
    expect(result[1]).toMatchObject({
      id: "LS_DATA",
      metaType: "structure",
      isValueIncomplete: true, // IS_VALUE_INCOMPLETE = "X"
    });
  });

  it("normalises the flag columns to real booleans — never lets a raw 'X' escape", () => {
    // REWRITTEN. The old title/body claimed a single `X`/`''` convention for the whole asx:abap
    // family and tested only `xBool`. Live bytes disprove the premise: `READ_ONLY` really is
    // `X`/self-closing (`033-vars-parameters-scope.xml`), but `STPDA_DEBUGGEE` in the SAME
    // envelope family sends `true`/`false`. `IS_VALUE_INCOMPLETE`/`IS_EXCEPTION` are truthy in
    // ZERO captures, so their family is unproven and they go through the tolerant `abapFlag`.
    // What is still guaranteed, and all this test now asserts, is the output type.
    expect(xBool("X")).toBe(true);
    expect(xBool("")).toBe(false);
    expect(xBool(undefined)).toBe(false);
    expect(xBool("true")).toBe(false); // xBool is the X-family reader ONLY — see abapFlag.
    for (const v of result) {
      expect(typeof v.readOnly).toBe("boolean");
      expect(typeof v.isValueIncomplete).toBe("boolean");
      expect(typeof v.isException).toBe("boolean");
    }
  });

  it("throws DebugXmlParseError when the asx:abap envelope is absent", () => {
    expect(() => parseVariablesResponse("<not-abap/>")).toThrow(DebugXmlParseError);
  });
});

describe("parseVariablesResponse — TABLE_LINES / tableLines via optNum()", () => {
  function variableXmlWith(tableLinesElement: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
    <DATA>
      <STPDA_ADT_VARIABLE>
        <ID>LV_TAB</ID>
        <NAME>LV_TAB</NAME>
        <DECLARED_TYPE_NAME>TY_TAB</DECLARED_TYPE_NAME>
        <ACTUAL_TYPE_NAME>TY_TAB</ACTUAL_TYPE_NAME>
        <KIND>LOCAL</KIND>
        <META_TYPE>table</META_TYPE>
        <VALUE></VALUE>
        <READ_ONLY></READ_ONLY>
        <TECHNICAL_TYPE>h</TECHNICAL_TYPE>
        <LENGTH>0</LENGTH>
        ${tableLinesElement}
      </STPDA_ADT_VARIABLE>
    </DATA>
  </asx:values>
</asx:abap>`;
  }

  it("parses a numeric TABLE_LINES into a real number", () => {
    const vars = parseVariablesResponse(variableXmlWith("<TABLE_LINES>42</TABLE_LINES>"));
    expect(vars[0]!.tableLines).toBe(42);
    expect(typeof vars[0]!.tableLines).toBe("number");
  });

  it("defaults to undefined when TABLE_LINES is absent entirely", () => {
    const vars = parseVariablesResponse(variableXmlWith(""));
    expect(vars[0]!.tableLines).toBeUndefined();
  });

  it("defaults to undefined when TABLE_LINES is an empty element", () => {
    const vars = parseVariablesResponse(variableXmlWith("<TABLE_LINES></TABLE_LINES>"));
    expect(vars[0]!.tableLines).toBeUndefined();
  });

  it("defaults to undefined when TABLE_LINES is non-numeric", () => {
    const vars = parseVariablesResponse(variableXmlWith("<TABLE_LINES>abc</TABLE_LINES>"));
    expect(vars[0]!.tableLines).toBeUndefined();
  });
});

describe("parseChildVariablesResponse (child-variables.xml) — getChildVariables, one level deeper", () => {
  const result = parseChildVariablesResponse(fixture("child-variables.xml"));

  it("parses the hierarchy edges", () => {
    expect(result.hierarchies).toHaveLength(2);
    expect(result.hierarchies[0]).toEqual({ parentId: "@ROOT", childId: "LV_COUNT", childName: "LV_COUNT" });
    expect(result.hierarchies[1]).toEqual({ parentId: "@ROOT", childId: "LS_DATA", childName: "LS_DATA" });
  });

  it("parses the variables nested under DATA.VARIABLES, not DATA directly", () => {
    expect(result.variables).toHaveLength(2);
    expect(result.variables[0]).toMatchObject({ id: "LV_COUNT", metaType: "simple", value: "42" });
    expect(result.variables[1]).toMatchObject({ id: "LS_DATA", metaType: "structure" });
  });

  it("defaults fields the sparse child rows omit (declaredTypeName, length, ...) rather than throwing", () => {
    expect(result.variables[1]!.declaredTypeName).toBe("");
    expect(result.variables[1]!.length).toBe(0);
    expect(result.variables[1]!.readOnly).toBe(false);
  });
});

describe("ADVERSARIAL (§12.5): the envelope-depth trap between getVariables and getChildVariables", () => {
  it("parseVariablesResponse against variables.xml returns non-empty (regression pin for the shallow shape)", () => {
    expect(parseVariablesResponse(fixture("variables.xml")).length).toBeGreaterThan(0);
  });

  it("parseChildVariablesResponse against child-variables.xml returns non-empty variables AND hierarchies " +
    "(a generic parser reading the shallow DATA.STPDA_ADT_VARIABLE shape against this fixture would see " +
    "no such element and silently return [] for variables — this is exactly the failure this split-parser " +
    "design prevents)", () => {
    const r = parseChildVariablesResponse(fixture("child-variables.xml"));
    expect(r.variables.length).toBeGreaterThan(0);
    expect(r.hierarchies.length).toBeGreaterThan(0);
  });
});

// Regression lock: before this fix, parseVariablesResponse and parseChildVariablesResponse
// silently returned an empty result ([] / { variables: [], hierarchies: [] }) when handed a
// differently-shaped asx:abap document instead of throwing — e.g. getVariables() called against
// a debuggee.xml-shaped body just came back reporting "this structure has no fields", the worst
// possible failure mode for a debugger command that actually failed for a structural reason. The
// full cross-product below pins that every one of the four asx:abap fixtures, fed to each of the
// three asx:abap parsers it does NOT belong to, now throws DebugXmlParseError naming the specific
// top-level element the parser expected but did not find.
type MismatchCase = {
  fixtureFile: string;
  parserName: string;
  parserFn: (xml: string) => unknown;
  expectedElement: string;
};

const MISMATCHED_PAIRINGS: MismatchCase[] = [
  { fixtureFile: "variables.xml", parserName: "parseChildVariablesResponse", parserFn: parseChildVariablesResponse, expectedElement: "VARIABLES" },
  { fixtureFile: "variables.xml", parserName: "parseDebuggeeResponse", parserFn: parseDebuggeeResponse, expectedElement: "STPDA_DEBUGGEE" },
  { fixtureFile: "child-variables.xml", parserName: "parseVariablesResponse", parserFn: parseVariablesResponse, expectedElement: "STPDA_ADT_VARIABLE" },
  { fixtureFile: "child-variables.xml", parserName: "parseDebuggeeResponse", parserFn: parseDebuggeeResponse, expectedElement: "STPDA_DEBUGGEE" },
  { fixtureFile: "debuggee.xml", parserName: "parseVariablesResponse", parserFn: parseVariablesResponse, expectedElement: "STPDA_ADT_VARIABLE" },
  { fixtureFile: "debuggee.xml", parserName: "parseChildVariablesResponse", parserFn: parseChildVariablesResponse, expectedElement: "VARIABLES" },
  { fixtureFile: "debuggee-postmortem.xml", parserName: "parseVariablesResponse", parserFn: parseVariablesResponse, expectedElement: "STPDA_ADT_VARIABLE" },
  { fixtureFile: "debuggee-postmortem.xml", parserName: "parseChildVariablesResponse", parserFn: parseChildVariablesResponse, expectedElement: "VARIABLES" },
];

describe("ADVERSARIAL: cross-product — every asx:abap fixture fed to every parser it does NOT belong to", () => {
  it.each(MISMATCHED_PAIRINGS)(
    "$fixtureFile -> $parserName throws DebugXmlParseError naming the missing element",
    ({ fixtureFile, parserFn, expectedElement }) => {
      const xml = fixture(fixtureFile);
      let caught: unknown;
      try {
        parserFn(xml);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DebugXmlParseError);
      expect((caught as Error).message).toContain(expectedElement);
    },
  );
});

describe("parseDebuggeeResponse (debuggee.xml) — live, attachable debuggee", () => {
  const result = parseDebuggeeResponse(fixture("debuggee.xml"));

  it("parses the DDIC field map", () => {
    expect(result).toMatchObject({
      id: "ABC123",
      kind: "debuggee",
      client: 1,
      terminalId: "vsp-12345678",
      ideId: "vsp",
      user: "TESTUSER",
      program: "ZTEST_MCP_CRUD",
      include: "ZTEST_MCP_CRUD",
      line: 15,
      applServer: "A4HSANDBOX",
      sysId: "A4H",
      sysNr: 0,
      timestamp: 20251205123456,
      instanceName: "A4H_01",
    });
  });

  it("inverts an empty IS_ATTACH_IMPOSSIBLE to isAttachable=true", () => {
    // RETITLED (was "inverts IS_ATTACH_IMPOSSIBLE='' to isAttachable=true"). debuggee.xml is
    // hand-authored and its `<IS_ATTACH_IMPOSSIBLE></IS_ATTACH_IMPOSSIBLE>` is NOT the wire
    // spelling: the live listener answer sends the literal string `false` (see the
    // "STPDA_DEBUGGEE booleans (live bytes)" block near the bottom of this file). Both spellings
    // must land on isAttachable=true, which is why the parser uses `abapFlag`, not `xBool`.
    expect(result.isAttachable).toBe(true);
  });

  it("parses a truthy IS_SAME_SERVER to isSameServer=true", () => {
    // RETITLED (was "parses IS_SAME_SERVER='X' to isSameServer=true"). The old title asserted a
    // convention the server does not use — every live capture sends `<IS_SAME_SERVER>true</…>`,
    // and with the old `xBool` implementation that produced `false` on every real hit while this
    // fixture-only test stayed green. The fixture's `X` is kept as a second accepted spelling.
    expect(result.isSameServer).toBe(true);
  });
});

describe("parseDebuggeeResponse (debuggee-postmortem.xml) — caught short dump", () => {
  const result = parseDebuggeeResponse(fixture("debuggee-postmortem.xml"));

  it("parses the postmortem-specific dump fields", () => {
    expect(result.kind).toBe("postmortem");
    expect(result).toMatchObject({
      id: "DUMP123",
      user: "TESTUSER",
      program: "ZTEST_MCP_CRUD",
      line: 20,
      dumpId: "20251205_123456_TESTUSER",
      dumpDate: "20251205",
      dumpTime: "123456",
      dumpHost: "A4HSANDBOX",
      dumpUser: "TESTUSER",
      dumpClient: "001",
      dumpUri: "/sap/bc/adt/runtime/dumps/123456",
    });
  });

  it("ADVERSARIAL: inverts a truthy IS_ATTACH_IMPOSSIBLE to isAttachable=false (both directions of the inversion tested)", () => {
    // RETITLED (was "…IS_ATTACH_IMPOSSIBLE='X'…"). Together with the debuggee.xml test above this
    // still pins the inversion in BOTH directions — a naive (un-inverted) reading would pass one
    // of these two and fail the other — but it no longer claims `X` is the wire spelling. This
    // fixture has no live counterpart at all (no post-mortem debuggee was ever captured), so its
    // `X` is an invention; the live `false`/`true` spelling is covered separately below.
    expect(result.isAttachable).toBe(false);
  });

  it("defaults terminalId/ideId/include the postmortem fixture omits, rather than throwing", () => {
    // Debuggee declares these required; debuggee-postmortem.xml has none of TERMINAL_ID, IDE_ID or
    // INCL_CURR. Needs live confirmation this is real server behaviour and not fixture trimming.
    expect(result.terminalId).toBe("");
    expect(result.ideId).toBe("");
    expect(result.include).toBe("");
  });

  it("throws DebugXmlParseError on an unrecognised DBGEE_KIND", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values><DATA><STPDA_DEBUGGEE><DEBUGGEE_ID>X</DEBUGGEE_ID><DBGEE_KIND>SOMETHING_NEW</DBGEE_KIND></STPDA_DEBUGGEE></DATA></asx:values>
</asx:abap>`;
    expect(() => parseDebuggeeResponse(xml)).toThrow(DebugXmlParseError);
  });
});

// ---------------------------------------------------------------------------
// IsComplexType / DebugMetaType
// ---------------------------------------------------------------------------

describe("isComplexType", () => {
  it("treats the declared scalar-like types as NOT complex", () => {
    for (const t of ["simple", "string", "boxedcomp", "anonymcomp", "unknown"]) {
      expect(isComplexType(t)).toBe(false);
    }
  });

  it("treats structure/table/dataref/objectref/class/object/boxref as complex", () => {
    for (const t of ["structure", "table", "dataref", "objectref", "class", "object", "boxref"]) {
      expect(isComplexType(t)).toBe(true);
    }
  });

  it("treats an unrecognised future META_TYPE as complex rather than throwing (open-ended by design)", () => {
    expect(() => isComplexType("some_new_type_sap_invents_later")).not.toThrow();
    expect(isComplexType("some_new_type_sap_invents_later")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// <exc:exception> envelope + discrimination predicates
// ---------------------------------------------------------------------------

describe("parseAdtError", () => {
  const NO_SESSION_XML = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationFramework">
  <namespace id="com.sap.adt"/>
  <type id="AdiFailed"/>
  <message lang="EN">No session attached, note the literal dbg:not-a-namespace inside this message</message>
  <localizedMessage lang="EN">No session attached</localizedMessage>
  <properties>
    <entry key="com.sap.adt.communicationFramework.subType">noSessionAttached</entry>
    <entry key="T100KEY-ID">SY</entry>
    <entry key="T100KEY-NO">530</entry>
  </properties>
</exc:exception>`;

  it("parses status/subtype/abapType/message/path and keeps a bounded bodyExcerpt", () => {
    const err = parseAdtError(NO_SESSION_XML, 500, "/sap/bc/adt/debugger/stack");
    expect(err.status).toBe(500);
    expect(err.subtype).toBe("noSessionAttached");
    expect(err.abapType).toBe("AdiFailed");
    expect(err.path).toBe("/sap/bc/adt/debugger/stack");
    expect(err.message).toContain("No session attached");
    expect(err.bodyExcerpt.length).toBeLessThanOrEqual(NO_SESSION_XML.length + 20);
  });

  it("ADVERSARIAL: does not corrupt a 'dbg:' literal inside the <message> text", () => {
    const err = parseAdtError(NO_SESSION_XML, 500, "/x");
    expect(err.message).toContain("dbg:not-a-namespace");
  });

  it("never lets .message alone be the basis for discrimination — isNoSessionAttached uses subtype", () => {
    const err = parseAdtError(NO_SESSION_XML, 500, "/x");
    expect(isNoSessionAttached(err)).toBe(true);
    expect(isConflict(err)).toBe(false);
  });

  it("truncates a huge body rather than embedding it whole (bodyExcerpt is bounded)", () => {
    const huge = `<x>${"A".repeat(200_000)}</x>`;
    const err = parseAdtError(huge, 500, "/x");
    expect(err.bodyExcerpt.length).toBeLessThan(20100);
    expect(isTruncated(err.bodyExcerpt)).toBe(true);
  });

  it("returns a typed AdtError (not a throw) for a non-exception, non-XML body", () => {
    const err = parseAdtError("Internal Server Error", 500, "/x");
    expect(err.status).toBe(500);
    expect(err.subtype).toBeUndefined();
  });

  it("handles an empty body", () => {
    const err = parseAdtError("", 401, "/x");
    expect(err.status).toBe(401);
    expect(err.message).toContain("401");
  });

  describe("ADVERSARIAL: a message body containing the digits of the HTTP status must not false-positive substring matching", () => {
    it("a 'conflictDetected' subtype with the string '404' inside the message is still a conflict, not confused with 404", () => {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationFramework">
  <type id="ExceptionConflict"/>
  <message lang="EN">Conflict on line 404 of the report — nothing to do with an HTTP 404</message>
  <properties>
    <entry key="com.sap.adt.communicationFramework.subType">conflictDetected</entry>
    <entry key="conflictText">Another user is debugging this session</entry>
    <entry key="ideUser">OTHERUSER</entry>
  </properties>
</exc:exception>`;
      const err = parseAdtError(xml, 200, "/sap/bc/adt/debugger/listeners");
      expect(isConflict(err)).toBe(true);
      expect(isNoSessionAttached(err)).toBe(false);
      // Discrimination is status/subtype only — the presence of "404" text must not matter.
      expect(err.status).toBe(200);
    });
  });
});

describe("discrimination predicates", () => {
  // This predicate used to be defined twice — a pure
  // `status === 401` check here, and a separate copy in transport.ts reusing
  // `isSessionDeath` from `src/adt/session.ts` (short dump / "Session Timed Out"). The two
  // encode genuinely different, non-overlapping real-world events, and `translateDebugError`
  // (transport.ts) checks `isSessionExpired` BEFORE its own literal `status === 401` branch —
  // so a 401-based `isSessionExpired` would swallow every 401 as SESSION_DEAD and make the
  // AUTH_FAILED branch beneath it unreachable. The `isSessionDeath`-based definition won and
  // now lives here as the single implementation; a bare 401 is deliberately NOT "session
  // expired" in this module's vocabulary — it is handled separately, as AUTH_FAILED.
  it("isSessionExpired recognises a destroyed ABAP session (short dump / explicit timeout), not a bare 401", () => {
    expect(
      isSessionExpired({
        status: 400,
        message: "Session Timed Out",
        path: "/x",
        bodyExcerpt: "400 Session Timed Out",
      }),
    ).toBe(true);
    expect(
      isSessionExpired({
        status: 500,
        message: "dump",
        path: "/x",
        bodyExcerpt: "<html>Application Server Error</html>",
      }),
    ).toBe(true);
    // A bare 401 (credentials rejected, session never destroyed) is NOT a session-death —
    // translateDebugError's separate literal 401 check maps it to AUTH_FAILED instead.
    expect(isSessionExpired({ status: 401, message: "m", path: "/x", bodyExcerpt: "" })).toBe(false);
    // Body text alone (no matching status) must not trigger it either — status AND a
    // body/content-type marker must agree (session.ts's own "deliberately conservative" rule).
    expect(
      isSessionExpired({
        status: 200,
        message: "Session timed out somewhere in this text",
        path: "/x",
        bodyExcerpt: "Session timed out somewhere in this text",
      }),
    ).toBe(false);
  });

  it("isConflict keys on subtype only, both known conflict subtypes", () => {
    expect(isConflict({ status: 200, subtype: "conflictDetected", message: "m", path: "/x", bodyExcerpt: "" })).toBe(true);
    expect(isConflict({ status: 200, subtype: "conflictNotification", message: "m", path: "/x", bodyExcerpt: "" })).toBe(true);
    expect(isConflict({ status: 200, subtype: "debuggeeEnded", message: "m", path: "/x", bodyExcerpt: "" })).toBe(false);
  });

  it("isNoSessionAttached keys on subtype only", () => {
    expect(isNoSessionAttached({ status: 500, subtype: "noSessionAttached", message: "m", path: "/x", bodyExcerpt: "" })).toBe(true);
    expect(isNoSessionAttached({ status: 500, subtype: "autoAttachTimeout", message: "m", path: "/x", bodyExcerpt: "" })).toBe(false);
  });

  // ARCH-09 §5.5/P6 — live: `debug.step.continue-to-end` answered with `subtype: "debuggeeEnded"`,
  // `abapType: "AdiFailed"`. `isSessionExpired` already treats that as gone; `isDebuggeeEnded`
  // exists so the WORDING can distinguish "the program finished" from "the session died".
  it("isDebuggeeEnded keys on subtype only, like isNoSessionAttached", () => {
    expect(
      isDebuggeeEnded({ status: 500, subtype: "debuggeeEnded", abapType: "AdiFailed", message: "m", path: "/x", bodyExcerpt: "" }),
    ).toBe(true);
    expect(
      isDebuggeeEnded({ status: 500, subtype: "noSessionAttached", abapType: "AdiFailed", message: "m", path: "/x", bodyExcerpt: "" }),
    ).toBe(false);
  });

  it("classifyDebugSessionFailure reports debuggeeEnded as gone, not unknown", () => {
    expect(
      classifyDebugSessionFailure({ status: 500, abapType: "AdiFailed", subtype: "debuggeeEnded" }),
    ).toBe("gone");
    // An unrecognised AdiFailed subtype must stay "unknown" — debuggeeEnded is not a licence to
    // assume every other subtype on this layer also means "gone".
    expect(
      classifyDebugSessionFailure({ status: 500, abapType: "AdiFailed", subtype: "someOtherSubtype" }),
    ).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// The dead DEBUG session — live acceptance run 5, idle-timeout case.
//
// SAP released the debug session on `rdisp/max_debug_lazy_time`; the next
// `getStack` correctly rejected, but as a generic ADT_ERROR, so a caller could
// not tell "re-attach" from "something unknown broke". The wire shape is
// HTTP 500, `<type id="AdiFailed"/>`, subType = the
// method you called, and the ONLY thing that actually names the condition —
// `CX_TPDA_SYS_COMM_DBGSESSIONEND` — sitting in a `…ExceptionClassName`
// property. `isSessionDeath` cannot see it (its 500 branch demands an HTML ICM
// page), so the class name is now carried structurally and matched here.
// ---------------------------------------------------------------------------

const NO_SESSION_XML_FOR_FALSE_POSITIVES = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationFramework">
  <type id="AdiFailed"/>
  <message lang="EN">No session attached</message>
  <properties>
    <entry key="com.sap.adt.communicationFramework.subType">noSessionAttached</entry>
  </properties>
</exc:exception>`;

describe("dead debug session → SESSION_DEAD (regression: live run 5, idle timeout)", () => {
  const deadSessionXml = (opts: { pad?: number; message?: string } = {}) =>
    `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationFramework">
  <namespace id="com.sap.adt"/>
  <type id="AdiFailed"/>
  <message lang="EN">${opts.message ?? "An exception was raised"}</message>
  <properties>
    <entry key="com.sap.adt.communicationFramework.subType">getStack</entry>
${opts.pad ? `    <entry key="LONGTEXT">${"P".repeat(opts.pad)}</entry>\n` : ""}    <entry key="previous2ExceptionClassName">CX_TPDA_SYS_COMM_DBGSESSIONEND</entry>
    <entry key="T100KEY-ID">SY</entry>
    <entry key="T100KEY-NO">530</entry>
  </properties>
</exc:exception>`;

  it("classifies the released-session getStack answer as session-expired", () => {
    const err = parseAdtError(deadSessionXml(), 500, "/sap/bc/adt/debugger/stack");
    expect(err.status).toBe(500);
    expect(err.abapType).toBe("AdiFailed");
    expect(err.exceptionClassNames).toContain(DEBUG_SESSION_ENDED_CLASS);
    expect(isSessionExpired(err)).toBe(true);
    // …and is NOT mistaken for the never-attached state or a conflict.
    expect(isNoSessionAttached(err)).toBe(false);
    expect(isConflict(err)).toBe(false);
  });

  it("REGRESSION: still classifies when the marker sits BEYOND the truncation boundary", () => {
    // 40 KB of padding ahead of the class-name entry, i.e. twice DIAGNOSTIC_BODY_MAX, so the
    // one identifying marker is nowhere in `bodyExcerpt`. Matching the excerpt (rather than the
    // parsed full body) would silently answer "not expired" here — that was the hypothesis for
    // the live failure, and this test pins the answer regardless of which limit anyone changes.
    const body = deadSessionXml({ pad: 40_000 });
    const err = parseAdtError(body, 500, "/sap/bc/adt/debugger/stack");
    expect(isTruncated(err.bodyExcerpt)).toBe(true);
    expect(err.bodyExcerpt).not.toContain(DEBUG_SESSION_ENDED_CLASS);
    expect(err.exceptionClassNames).toContain(DEBUG_SESSION_ENDED_CLASS);
    expect(isSessionExpired(err)).toBe(true);
  });

  it("is LANGUAGE-INDEPENDENT: a German-language body classifies identically", () => {
    // The appliance answers in the logon language ("Anmeldung fehlgeschlagen" elsewhere in this
    // project). Every English prose marker in `session.ts` — "Session Timed Out", "Application
    // Server Error" — is worthless against this body. The ABAP class name is not translated.
    const err = parseAdtError(
      deadSessionXml({ message: "Es wurde eine Ausnahme ausgelöst" }),
      500,
      "/sap/bc/adt/debugger/stack",
    );
    expect(err.message).toBe("Es wurde eine Ausnahme ausgelöst");
    expect(isSessionExpired(err)).toBe(true);
  });

  it("NO FALSE POSITIVES: unrelated debugger errors are not session-expired", () => {
    const noSession = parseAdtError(NO_SESSION_XML_FOR_FALSE_POSITIVES, 500, "/x");
    expect(noSession.exceptionClassNames).toBeUndefined();
    expect(isSessionExpired(noSession)).toBe(false);

    // A DIFFERENT ABAP exception class must not match — the predicate is an exact class
    // comparison, not "starts with CX_TPDA". NOTE ON THE CHOSEN NAME: CX_TPDA_SYS_COMM_TIMEOUT
    // occurs in ZERO of the 96 live captures; it is used here purely as a negative control (a
    // plausible-looking sibling name), never as evidence that the server sends it.
    const otherClass = parseAdtError(
      `<exc:exception><type id="AdiFailed"/><message>x</message><properties>` +
        `<entry key="previousExceptionClassName">CX_TPDA_SYS_COMM_TIMEOUT</entry></properties></exc:exception>`,
      500,
      "/x",
    );
    expect(otherClass.exceptionClassNames).toEqual(["CX_TPDA_SYS_COMM_TIMEOUT"]);
    expect(isSessionExpired(otherClass)).toBe(false);

    // The class name appearing as PROSE inside the message (not as a class-name property) is
    // not evidence of anything — nothing substring-matches the body.
    const prose = parseAdtError(
      `<exc:exception><type id="AdiFailed"/><message>Report mentions CX_TPDA_SYS_COMM_DBGSESSIONEND</message>` +
        `<properties><entry key="com.sap.adt.communicationFramework.subType">getStack</entry></properties></exc:exception>`,
      500,
      "/x",
    );
    expect(prose.exceptionClassNames).toBeUndefined();
    expect(isSessionExpired(prose)).toBe(false);

    // And a plain 404 stays a 404.
    expect(isSessionExpired(parseAdtError("", 404, "/x"))).toBe(false);
  });

  it("collectExceptionClassNames stays bounded — no body text can ride in on it", () => {
    expect(collectExceptionClassNames(undefined)).toEqual([]);
    expect(collectExceptionClassNames({ "T100KEY-ID": "SY" })).toEqual([]);
    // Every `…ExceptionClassName` variant, de-duplicated and upper-cased.
    expect(
      collectExceptionClassNames({
        exceptionClassName: "cx_tpda_sys_comm_dbgsessionend",
        previousExceptionClassName: "CX_TPDA_SYS_COMM_DBGSESSIONEND",
        previous2ExceptionClassName: "CX_SY_ITAB_LINE_NOT_FOUND",
      }),
    ).toEqual(["CX_TPDA_SYS_COMM_DBGSESSIONEND", "CX_SY_ITAB_LINE_NOT_FOUND"]);
    // A value that is not an ABAP class name is dropped outright, however long.
    expect(
      collectExceptionClassNames({ previousExceptionClassName: "<html>" + "A".repeat(200_000) }),
    ).toEqual([]);
    // Hard cap on how many are retained.
    const many: Record<string, string> = {};
    for (let i = 0; i < 40; i++) many[`previous${i}ExceptionClassName`] = `CX_CLASS_${i}`;
    expect(collectExceptionClassNames(many).length).toBe(8);
  });
});

describe("stepContinue into an unhandled ABAP exception → SESSION_DEAD, not a bare throw (regression: live run, 2026-08-12, ZDBGFIX_EXC)", () => {
  // Live-captured shape (see xml-response.ts's doc comment on the `debuggeeEnded` clause of
  // `isSessionExpired`): a `stepContinue` issued into an unhandled runtime exception (here,
  // CX_SY_ZERODIVIDE) answers 500 AdiFailed with subType=debuggeeEnded and — unlike the getStack
  // "session ended" shape above — NO `…ExceptionClassName` property at all. Before the
  // `debuggeeEnded` clause existed, this fell through every existing death signature (no matching
  // status/body pair, no exception class name) and `isSessionExpired` answered false, so
  // `translateDebugError` produced a bare `ADT_ERROR` instead of the documented clean
  // `status:"dead"`, and the now-dead debuggee was never released server-side.
  const debuggeeEndedXml = (message = "An exception was raised") =>
    `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationFramework">
  <namespace id="com.sap.adt"/>
  <type id="AdiFailed"/>
  <message lang="EN">${message}</message>
  <properties>
    <entry key="com.sap.adt.communicationFramework.subType">debuggeeEnded</entry>
  </properties>
</exc:exception>`;

  it("classifies the stepContinue/debuggeeEnded answer as session-expired even with no exception class names", () => {
    const err = parseAdtError(debuggeeEndedXml(), 500, "/sap/bc/adt/debugger/stepContinue");
    expect(err.status).toBe(500);
    expect(err.abapType).toBe("AdiFailed");
    expect(err.subtype).toBe("debuggeeEnded");
    // The defining property of this shape: no exception-class-name signal is present at all, so
    // any fix that (re-)relies on `exceptionClassNames` alone would regress silently.
    expect(err.exceptionClassNames).toBeUndefined();
    expect(isSessionExpired(err)).toBe(true);
    // …and is not misclassified as the unrelated never-attached or lock-conflict states.
    expect(isNoSessionAttached(err)).toBe(false);
    expect(isConflict(err)).toBe(false);
  });

  it("is LANGUAGE-INDEPENDENT: a German-language body classifies identically", () => {
    const err = parseAdtError(
      debuggeeEndedXml("Es wurde eine Ausnahme ausgelöst"),
      500,
      "/sap/bc/adt/debugger/stepContinue",
    );
    expect(isSessionExpired(err)).toBe(true);
  });

  it("NO FALSE POSITIVES: a bare AdiFailed with a DIFFERENT subtype is not treated as debuggeeEnded", () => {
    const err = parseAdtError(
      `<exc:exception><type id="AdiFailed"/><message>x</message><properties>` +
        `<entry key="com.sap.adt.communicationFramework.subType">noSessionAttached</entry></properties></exc:exception>`,
      500,
      "/x",
    );
    expect(isSessionExpired(err)).toBe(false);
    expect(isNoSessionAttached(err)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The batch endpoint — no captured fixture exists; synthetic, matching the documented shape
// (multipart/mixed, each part Content-Type: application/http wrapping an
// embedded HTTP response). Needs live confirmation against a real /debugger/batch response.
// ---------------------------------------------------------------------------

describe("parseBatchResponse", () => {
  const BOUNDARY = "batch_20cd4567-f577-4fb5-85b0-6bf534444d04";

  it("splits a well-formed batch of successful sub-responses", () => {
    const raw =
      `--${BOUNDARY}\r\n` +
      `Content-Type: application/http\r\n` +
      `content-transfer-encoding: binary\r\n\r\n` +
      `HTTP/1.1 200 OK\r\n` +
      `Content-Type: application/xml\r\n\r\n` +
      `<dbg:step xmlns:dbg="http://www.sap.com/adt/debugger" isRfc="false"/>\r\n` +
      `--${BOUNDARY}\r\n` +
      `Content-Type: application/http\r\n` +
      `content-transfer-encoding: binary\r\n\r\n` +
      `HTTP/1.1 200 OK\r\n` +
      `Content-Type: application/xml\r\n\r\n` +
      `<dbg:stack xmlns:dbg="http://www.sap.com/adt/debugger" isRfc="false"/>\r\n` +
      `--${BOUNDARY}--\r\n`;

    const results = parseBatchResponse(raw);
    expect(results).toHaveLength(2);
    expect(results[0]!.status).toBe(200);
    expect(results[0]!.contentType).toBe("application/xml");
    expect(results[0]!.body).toContain("dbg:step");
    expect(results[1]!.body).toContain("dbg:stack");
  });

  it("ADVERSARIAL: reports a failing sub-request's real status, not a hardcoded 200 (§12.4 item 4)", () => {
    const raw =
      `--${BOUNDARY}\r\n` +
      `Content-Type: application/http\r\n` +
      `content-transfer-encoding: binary\r\n\r\n` +
      `HTTP/1.1 200 OK\r\n` +
      `Content-Type: application/xml\r\n\r\n` +
      `<dbg:step xmlns:dbg="http://www.sap.com/adt/debugger" isRfc="false"/>\r\n` +
      `--${BOUNDARY}\r\n` +
      `Content-Type: application/http\r\n` +
      `content-transfer-encoding: binary\r\n\r\n` +
      `HTTP/1.1 500 Internal Server Error\r\n` +
      `Content-Type: application/xml\r\n\r\n` +
      `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationFramework"><type id="AdiFailed"/><message>No session attached</message><properties><entry key="com.sap.adt.communicationFramework.subType">noSessionAttached</entry></properties></exc:exception>\r\n` +
      `--${BOUNDARY}--\r\n`;

    const results = parseBatchResponse(raw);
    expect(results).toHaveLength(2);
    expect(results[0]!.status).toBe(200);
    expect(results[1]!.status).toBe(500); // NOT hardcoded 200
    const err = parseAdtError(results[1]!.body, results[1]!.status, "/sap/bc/adt/debugger?method=getStack");
    expect(isNoSessionAttached(err)).toBe(true);
  });

  it("ADVERSARIAL: does not truncate a body when the header/body separator is the 2-byte '\\n\\n' form (§12.4 item 4)", () => {
    // An earlier parser hardcodes a 4-byte ("\r\n\r\n") advance even when it matched the shorter 2-byte
    // ("\n\n") separator, silently eating the first two bytes of the body that follows.
    const raw =
      `--${BOUNDARY}\n` +
      `Content-Type: application/http\n` +
      `content-transfer-encoding: binary\n\n` +
      `HTTP/1.1 200 OK\n` +
      `Content-Type: application/xml\n\n` +
      `<dbg:step foo="bar"/>\n` +
      `--${BOUNDARY}--\n`;

    const results = parseBatchResponse(raw);
    expect(results).toHaveLength(1);
    // A truncation bug would drop the leading "<d" and leave "bg:step foo=\"bar\"/>".
    expect(results[0]!.body.startsWith("<dbg:step")).toBe(true);
  });

  it("throws DebugXmlParseError when no boundary can be found", () => {
    expect(() => parseBatchResponse("not a multipart body at all")).toThrow(DebugXmlParseError);
  });
});

// ---------------------------------------------------------------------------
// Breakpoints-set response — no captured fixture; ported from the documented shape.
// Needs live confirmation.
// ---------------------------------------------------------------------------

describe("parseBreakpointsResponse", () => {
  it("parses a created line breakpoint", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger">
  <breakpoint id="BP1" kind="line" uri="/sap/bc/adt/programs/programs/ZFOO/source/main#start=10"/>
</dbg:breakpoints>`;
    const result = parseBreakpointsResponse(xml);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "BP1", kind: "line", uri: "/sap/bc/adt/programs/programs/ZFOO/source/main#start=10" });
  });

  it("ADVERSARIAL: surfaces a breakpoint SAP refused, via errorMessage, instead of dropping the row (§12.4 item 5)", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger">
  <breakpoint id="BP1" kind="line" uri="/sap/bc/adt/programs/programs/ZFOO/source/main#start=10"/>
  <breakpoint kind="line" clientId="my-corr-id" errorMessage="Line 10 is not executable"/>
</dbg:breakpoints>`;
    const result = parseBreakpointsResponse(xml);
    expect(result).toHaveLength(2);
    expect(result[0]).not.toHaveProperty("errorMessage");
    expect(result[1]).toEqual({ kind: "line", clientId: "my-corr-id", errorMessage: "Line 10 is not executable" });
  });

  it("throws DebugXmlParseError on the wrong root element", () => {
    expect(() => parseBreakpointsResponse("<dbg:attach/>")).toThrow(DebugXmlParseError);
  });

  it("parses a line, an exception and a statement breakpoint together, in order", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger">
  <breakpoint id="BP1" kind="line" uri="/sap/bc/adt/programs/programs/ZFOO/source/main#start=10"/>
  <breakpoint id="BP2" kind="exception" exceptionClass="CX_SY_ZERODIVIDE"/>
  <breakpoint id="BP3" kind="statement" statement="RAISE"/>
</dbg:breakpoints>`;
    const result = parseBreakpointsResponse(xml);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ id: "BP1", kind: "line" });
    expect(result[1]).toMatchObject({ id: "BP2", kind: "exception", exceptionClass: "CX_SY_ZERODIVIDE" });
    expect(result[2]).toMatchObject({ id: "BP3", kind: "statement", statement: "RAISE" });
  });

  it("parses a zero-byte body as an empty list, not an error", () => {
    expect(parseBreakpointsResponse("")).toEqual([]);
  });

  it("parses a self-closing root as an empty list", () => {
    expect(parseBreakpointsResponse(`<dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger"/>`)).toEqual([]);
  });

  it("parses a whitespace-only body as an empty list", () => {
    expect(parseBreakpointsResponse("   \n\t  ")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The RAW-BODY path (long-poll) must classify the same live-captured envelope
// identically to the abap-adt-api path — one condition, two transports.
// ---------------------------------------------------------------------------
describe("CX_TPDA_SYS_COMM_SLAVENOTCONN — the getStack face of a dead session", () => {
  const captured = (previous2: string, subType: string) => `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="AdiFailed"/>
  <message lang="EN">An exception was raised</message>
  <properties>
    <entry key="previous1ExceptionClassName">CX_TPDAPI_FAILURE</entry>
    <entry key="previous2ExceptionClassName">${previous2}</entry>
    <entry key="com.sap.adt.communicationFramework.subType">${subType}</entry>
    <entry key="T100KEY-ID">SY</entry>
    <entry key="T100KEY-NO">530</entry>
  </properties>
</exc:exception>`;

  it("classifies the captured getStack envelope as session-expired", () => {
    const err = parseAdtError(
      captured("CX_TPDA_SYS_COMM_SLAVENOTCONN", "getStack"),
      500,
      "/sap/bc/adt/debugger/stack",
    );
    expect(err.exceptionClassNames).toEqual(["CX_TPDAPI_FAILURE", "CX_TPDA_SYS_COMM_SLAVENOTCONN"]);
    expect(isSessionExpired(err)).toBe(true);
    expect(isNoSessionAttached(err)).toBe(false);
    expect(isConflict(err)).toBe(false);
  });

  it("classifies the captured terminateDebuggee envelope as session-expired too", () => {
    const err = parseAdtError(
      captured(DEBUG_SESSION_ENDED_CLASS, "terminateDebuggee"),
      500,
      "/sap/bc/adt/debugger",
    );
    expect(isSessionExpired(err)).toBe(true);
  });

  it("the same envelope with any OTHER class name stays unclassified", () => {
    const err = parseAdtError(
      captured("CX_TPDA_SYS_COMM_TIMEOUT", "getStack"),
      500,
      "/sap/bc/adt/debugger/stack",
    );
    expect(err.abapType).toBe("AdiFailed");
    expect(err.status).toBe(500);
    expect(isSessionExpired(err)).toBe(false);
  });

  it("BOUNDS: both captured previousNExceptionClassName entries survive key+value filtering", () => {
    // Verified empirically rather than argued: the keys must match /exceptionclassname$/i and the
    // values must match /^[A-Z0-9_\/]{1,60}$/ (29 chars, all legal) to be retained at all.
    expect(
      collectExceptionClassNames({
        previous1ExceptionClassName: "CX_TPDAPI_FAILURE",
        previous2ExceptionClassName: "CX_TPDA_SYS_COMM_SLAVENOTCONN",
        previous1Text: "An exception was raised",
        previous1SourcePositionProgram: "CL_TPDAPI_SESSION============CP",
        "T100KEY-ID": "SY",
        "T100KEY-NO": "530",
        "com.sap.adt.communicationFramework.subType": "getStack",
      }),
    ).toEqual(["CX_TPDAPI_FAILURE", "CX_TPDA_SYS_COMM_SLAVENOTCONN"]);
    expect("CX_TPDA_SYS_COMM_SLAVENOTCONN".length).toBeLessThanOrEqual(60);
  });
});

// ===========================================================================
// LIVE BYTES
//
// The blocks below are the ones this file's banner (top of file) promises:
// every assertion is a byte the 2026-07 appliance actually sent, read through
// the `live()` loader straight out of `test/fixtures/live-captured/`. Nothing
// here is hand-authored and nothing here is built on `fixtures/debugger/` —
// several of those files are proven to CONTRADICT the wire, most sharply
// `variables.xml`, whose `I` `HEX_VALUE` `0000002A` is BIG-endian while the
// captured `I` `D6FFFFFF` is little-endian. They cannot both be right, and the
// capture is the one with a provenance record (`*.meta.json`).
//
// Three facts are settled by these captures and are pinned here:
//   A. `HEX_VALUE` endianness is PER TECHNICAL_TYPE, not uniform.
//   B. The sign lives in a TRAILING COLUMN, and only for `P`/`I`.
//   C. `getVariables` omits rows silently — callers must key off `ID`.
// ===========================================================================

/** A row exactly as `parseVariablesResponse` produces it — no restated shape to drift. */
type LiveVariable = ReturnType<typeof parseVariablesResponse>[number];

/**
 * Every live capture carrying `STPDA_ADT_VARIABLE` rows, parsed with whichever of the two envelope
 * parsers its body matches. The list is DISCOVERED from the directory rather than hardcoded, so a
 * capture added later is covered automatically and cannot quietly sit outside the sweeps below.
 *
 * Choosing the parser by try/fallback is safe precisely because each of the two THROWS on the
 * other's shape rather than returning `[]` — the cross-product block earlier in this file is what
 * makes that dispatch trustworthy.
 */
function liveVariableCaptures(): { file: string; rows: LiveVariable[] }[] {
  const out: { file: string; rows: LiveVariable[] }[] = [];
  for (const file of readdirSync(LIVE_DIR).filter((f) => f.endsWith(".xml")).sort()) {
    const xml = live(file);
    if (!xml.includes("<STPDA_ADT_VARIABLE>")) continue;
    try {
      out.push({ file, rows: parseVariablesResponse(xml) });
    } catch {
      out.push({ file, rows: parseChildVariablesResponse(xml).variables });
    }
  }
  return out;
}

/** Every captured variable row, tagged with the capture it came from so failures name a file. */
const LIVE_ROWS: { file: string; row: LiveVariable }[] = liveVariableCaptures().flatMap(({ file, rows }) =>
  rows.map((row) => ({ file, row })),
);

const LIVE_NUMERIC = LIVE_ROWS.filter(({ row }) => row.technicalType === "P" || row.technicalType === "I");
const LIVE_CHARLIKE = LIVE_ROWS.filter(({ row }) => row.technicalType === "C" || row.technicalType === "D");

/** The single row with this `ID` in this capture. Fails loudly rather than testing `undefined`. */
function liveRow(file: string, id: string): LiveVariable {
  const hits = LIVE_ROWS.filter((r) => r.file === file && r.row.id === id);
  expect(hits, `${file} should carry exactly one row with ID ${id}`).toHaveLength(1);
  return hits[0]!.row;
}

/** The ids the client actually asked for, read out of the capture's own recorded request body. */
function requestedIds(metaFile: string): string[] {
  const meta = JSON.parse(live(metaFile)) as { requestBody: string };
  return [...meta.requestBody.matchAll(/<ID>([^<]*)<\/ID>/g)].map((m) => m[1]!);
}

// ---------------------------------------------------------------------------
// A. HEX_VALUE endianness is PER TYPE
// ---------------------------------------------------------------------------

describe("LIVE BYTES: HEX_VALUE endianness is per TECHNICAL_TYPE, never uniform (decodeHexValue)", () => {
  it("corpus guard: the captures carry exactly the four decodable TECHNICAL_TYPEs, in known counts", () => {
    // If this fails, a capture was added or changed and every sweep below is now measuring a
    // different corpus than the one these facts were settled against.
    const counts: Record<string, number> = {};
    for (const { row } of LIVE_ROWS) counts[row.technicalType] = (counts[row.technicalType] ?? 0) + 1;
    expect({ C: counts.C, P: counts.P, I: counts.I, D: counts.D }).toEqual({ C: 38, P: 25, I: 10, D: 4 });
  });

  it("I is 4-byte LITTLE-endian two's complement — 223's D6FFFFFF is -42, not -687865857", () => {
    const v = liveRow("223-np-vars-negative.xml", "LV_ZMCP_NEGI");
    expect([v.technicalType, v.length, v.value, v.hexValue]).toEqual(["I", 4, "42-", "D6FFFFFF"]);
    expect(decodeHexValue(v.hexValue, v.technicalType, v.length)).toEqual({ technicalType: "I", number: -42 });

    // Read BIG-endian the SAME four bytes are 0xD6FFFFFF = -687865857. This one captured negative
    // is the ONLY row in the corpus that can tell the two readings apart: every captured positive
    // `I` is small enough that only its first byte is non-zero, so a big-endian reader produces a
    // plausible-looking wrong number (0F000000 → 251658240) instead of an obviously broken one.
    expect(decodeHexValue(v.hexValue, "I", 4)).not.toEqual({ technicalType: "I", number: -687865857 });
  });

  it("I positives confirm the same LE reading — 0F000000 is 15, not 251658240", () => {
    const q = liveRow("025-vars-table-rows-full.xml", "LT_ITEMS[1]-QUANTITY");
    expect([q.technicalType, q.length, q.value, q.hexValue]).toEqual(["I", 4, "15 ", "0F000000"]);
    expect(decodeHexValue(q.hexValue, "I", 4)).toEqual({ technicalType: "I", number: 15 });
    expect(decodeHexValue(q.hexValue, "I", 4)).not.toEqual({ technicalType: "I", number: 251658240 });
  });

  it("SWEEP: every captured I row decodes LE to exactly the number its VALUE column spells", () => {
    expect(LIVE_ROWS.filter(({ row }) => row.technicalType === "I")).toHaveLength(10);
    for (const { file, row } of LIVE_ROWS.filter(({ row }) => row.technicalType === "I")) {
      // Two independent readers of the same row — the hex decoder and the VALUE parser — must
      // land on the same number, on every real row, or one of them is wrong.
      expect(decodeHexValue(row.hexValue, row.technicalType, row.length), `${file} ${row.id}`).toEqual({
        technicalType: "I",
        number: parseAbapNumeric(row.value),
      });
    }
  });

  it("P is BIG-endian packed BCD with the sign NIBBLE last: C = positive, D = negative", () => {
    const neg = liveRow("223-np-vars-negative.xml", "LV_ZMCP_NEG");
    expect([neg.technicalType, neg.length, neg.value, neg.hexValue]).toEqual([
      "P",
      8,
      "123.45-",
      "000000000012345D",
    ]);
    // UNSCALED: the BCD carries 12345 and nothing else. The ".45" exists ONLY in VALUE.
    expect(decodeHexValue(neg.hexValue, "P", 8)).toEqual({ technicalType: "P", digits: "12345", negative: true });

    const zero = liveRow("223-np-vars-negative.xml", "LV_GRAND_TOTAL");
    expect([zero.length, zero.value, zero.hexValue]).toEqual([8, "0.00 ", "000000000000000C"]);
    expect(decodeHexValue(zero.hexValue, "P", 8)).toEqual({ technicalType: "P", digits: "0", negative: false });

    const price = liveRow("223-np-vars-negative.xml", "LT_ITEMS[1]-UNIT_PRICE");
    expect([price.length, price.value, price.hexValue]).toEqual([5, "12.50 ", "000001250C"]);
    expect(decodeHexValue(price.hexValue, "P", 5)).toEqual({ technicalType: "P", digits: "1250", negative: false });

    // The nibble is the LAST one, not the first: the two captures differ in exactly that nibble
    // (…12345**D** vs …0000**C**) and in nothing else structural.
    expect(neg.hexValue.endsWith("D")).toBe(true);
    expect(zero.hexValue.endsWith("C")).toBe(true);
  });

  it("P byte count equals LENGTH on every captured row (the invariant decodeHexValue enforces)", () => {
    for (const { file, row } of LIVE_ROWS.filter(({ row }) => row.technicalType === "P")) {
      expect(row.hexValue.length / 2, `${file} ${row.id} HEX=[${row.hexValue}]`).toBe(row.length);
      expect(decodeHexValue(row.hexValue, "P", row.length), `${file} ${row.id}`).toBeDefined();
      // A LENGTH that disagrees with the byte count is refused outright, never half-decoded.
      expect(decodeHexValue(row.hexValue, "P", row.length + 1), `${file} ${row.id}`).toBeUndefined();
    }
  });

  it("the P hex CANNOT supply scale: LV_GRAND_TOTAL and LV_AVERAGE share one HEX_VALUE, not one VALUE", () => {
    const total = liveRow("027-vars-char-and-packed.xml", "LV_GRAND_TOTAL");
    const avg = liveRow("027-vars-char-and-packed.xml", "LV_AVERAGE");
    expect([total.hexValue, total.length]).toEqual([avg.hexValue, avg.length]);
    expect([total.value, avg.value]).toEqual(["0.00 ", "0.0000 "]);
    expect(decodeHexValue(total.hexValue, "P", 8)).toEqual(decodeHexValue(avg.hexValue, "P", 8));
    // Only the VALUE column keeps them apart, which is why the display path reads VALUE.
    expect([formatAbapNumeric(total.value), formatAbapNumeric(avg.value)]).toEqual(["0.00", "0.0000"]);
  });

  it("C is UTF-16 LITTLE-endian: 4100 is 'A' only as LE (023's LT_ITEMS[1]-ITEM_ID)", () => {
    const v = liveRow("023-vars-row-components.xml", "LT_ITEMS[1]-ITEM_ID");
    expect([v.technicalType, v.length, v.value]).toEqual(["C", 10, "A001      "]);
    expect(v.hexValue).toBe("4100300030003100200020002000200020002000");
    expect(decodeHexValue(v.hexValue, "C", 10)).toEqual({ technicalType: "C", text: "A001      " });

    // The whole endianness question in two lines: the first code unit is 0x4100 read big-endian
    // and 0x0041 read little-endian, and only one of those is the 'A' the server put in VALUE.
    expect(String.fromCharCode(0x0041)).toBe("A");
    expect(String.fromCharCode(0x4100)).not.toBe("A");
  });

  it("DOC IS WRONG — INDEX.md line 123 claims UTF-16BE for C and is contradicted by its own capture", () => {
    // `test/fixtures/live-captured/INDEX.md:123` — the row describing 027-vars-char-and-packed.xml
    // — ends with "`HEX_VALUE` is UTF-16BE for C and BCD for P". The **BE** half of that sentence
    // is WRONG. This test decodes the very row that INDEX.md row describes, both ways, from the
    // capture it names. Do NOT "fix" src/debug/xml-response.ts to match the doc: the doc is the
    // thing that is out of step with the bytes, and this test exists so that discovery is not
    // made a second time.
    const v = liveRow("027-vars-char-and-packed.xml", "LT_ITEMS[1]-ITEM_ID");
    expect(v.hexValue).toBe("4100300030003100200020002000200020002000");

    const bytes = (v.hexValue.match(/../g) ?? []).map((b) => Number.parseInt(b, 16));
    let bigEndian = "";
    for (let i = 0; i < bytes.length; i += 2) bigEndian += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);

    // LE reproduces the VALUE column byte-for-byte; BE does not reproduce it at all.
    expect(decodeHexValue(v.hexValue, "C", 10)).toEqual({ technicalType: "C", text: v.value });
    expect(bigEndian).not.toBe(v.value);
    expect(bigEndian.charCodeAt(0)).toBe(0x4100);
  });

  it("D goes through the same LE UTF-16 branch — POSTING_DATE, LENGTH=8, VALUE=20260111", () => {
    for (const file of ["023-vars-row-components.xml", "025-vars-table-rows-full.xml"]) {
      const v = liveRow(file, "LT_ITEMS[1]-POSTING_DATE");
      expect([v.technicalType, v.length, v.value], file).toEqual(["D", 8, "20260111"]);
      expect(v.hexValue, file).toBe("32003000320036003000310031003100");
      expect(decodeHexValue(v.hexValue, "D", 8), file).toEqual({ technicalType: "D", text: "20260111" });
    }
  });

  it("SWEEP: all 42 captured C and D rows decode LE to their VALUE byte-for-byte, padding included", () => {
    expect(LIVE_CHARLIKE).toHaveLength(42);
    for (const { file, row } of LIVE_CHARLIKE) {
      expect(decodeHexValue(row.hexValue, row.technicalType, row.length), `${file} ${row.id}`).toEqual({
        technicalType: row.technicalType,
        text: row.value,
      });
      // 2 bytes per character, exactly LENGTH characters.
      expect(row.hexValue.length, `${file} ${row.id}`).toBe(row.length * 4);
    }
  });

  it("refuses every TECHNICAL_TYPE no capture proves, rather than guessing an encoding", () => {
    // The corpus also contains `Standard Table` and `Structure: flat, not charlike` rows; their
    // HEX_VALUE (empty in every case) is not decoded, and neither are the never-observed types.
    for (const { file, row } of LIVE_ROWS.filter(
      ({ row }) => !["C", "D", "I", "P"].includes(row.technicalType),
    )) {
      expect(decodeHexValue(row.hexValue, row.technicalType, row.length), `${file} ${row.id}`).toBeUndefined();
    }
    for (const t of ["N", "T", "F", "INT8", "b", "s", "X", "string", "xstring", "decfloat34"]) {
      expect(decodeHexValue("0000002A", t, 4), t).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// B. The trailing sign column
// ---------------------------------------------------------------------------

describe("LIVE BYTES: the sign is a TRAILING COLUMN and only P/I have one (parseAbapNumeric / formatAbapNumeric)", () => {
  it("every captured P/I VALUE ends in 0x20 (positive) or 0x2D (negative), and never begins with '-'", () => {
    expect(LIVE_NUMERIC).toHaveLength(35);
    for (const { file, row } of LIVE_NUMERIC) {
      const last = row.value.charCodeAt(row.value.length - 1);
      expect([0x20, 0x2d], `${file} ${row.id} VALUE=[${row.value}]`).toContain(last);
      expect(row.value.startsWith("-"), `${file} ${row.id} VALUE=[${row.value}]`).toBe(false);
    }
  });

  it("the two captured negatives: P '123.45-' and I '42-' (223-np-vars-negative.xml)", () => {
    const p = liveRow("223-np-vars-negative.xml", "LV_ZMCP_NEG");
    expect(p.value).toBe("123.45-");
    expect(p.value.charCodeAt(p.value.length - 1)).toBe(0x2d); // hyphen-minus, not U+2212
    expect(parseAbapNumeric(p.value)).toBe(-123.45);
    expect(formatAbapNumeric(p.value)).toBe("-123.45");

    const i = liveRow("223-np-vars-negative.xml", "LV_ZMCP_NEGI");
    expect(i.value).toBe("42-");
    expect(parseAbapNumeric(i.value)).toBe(-42);
    expect(formatAbapNumeric(i.value)).toBe("-42");

    // The exact bug these helpers exist to prevent, demonstrated on the real byte string: the two
    // obvious conversions either DELETE the sign or refuse the value entirely.
    expect(Number.parseFloat(p.value)).toBe(123.45);
    expect(Number(p.value)).toBeNaN();
  });

  it("positives carry a trailing SPACE in that same column — dropped without touching a digit", () => {
    const total = liveRow("223-np-vars-negative.xml", "LV_GRAND_TOTAL");
    expect(total.value).toBe("0.00 ");
    expect(formatAbapNumeric(total.value)).toBe("0.00");
    expect(parseAbapNumeric(total.value)).toBe(0);

    const price = liveRow("027-vars-char-and-packed.xml", "LT_ITEMS[1]-UNIT_PRICE");
    expect(price.value).toBe("12.50 ");
    expect(formatAbapNumeric(price.value)).toBe("12.50");
    expect(parseAbapNumeric(price.value)).toBe(12.5);

    const counter = liveRow("027-vars-char-and-packed.xml", "LV_COUNTER");
    expect(counter.value).toBe("0 ");
    expect(formatAbapNumeric(counter.value)).toBe("0");
    expect(parseAbapNumeric(counter.value)).toBe(0);

    // Scale is preserved verbatim — `Number` would flatten "0.0000" to 0 and lose it.
    const avg = liveRow("027-vars-char-and-packed.xml", "LV_AVERAGE");
    expect(avg.value).toBe("0.0000 ");
    expect(formatAbapNumeric(avg.value)).toBe("0.0000");
  });

  it("SWEEP: formatAbapNumeric accepts all 35 numeric rows and only ever moves the sign", () => {
    for (const { file, row } of LIVE_NUMERIC) {
      const negative = row.value.trimEnd().endsWith("-");
      expect(formatAbapNumeric(row.value), `${file} ${row.id} VALUE=[${row.value}]`).toBe(
        (negative ? "-" : "") + row.value.replace(/[-\s]+$/, ""),
      );
      expect(parseAbapNumeric(row.value), `${file} ${row.id}`).toBeTypeOf("number");
    }
  });

  it("C and D have NO sign column: len(VALUE) === LENGTH on all 42 rows — the padding IS the value", () => {
    expect(LIVE_CHARLIKE).toHaveLength(42);
    for (const { file, row } of LIVE_CHARLIKE) {
      expect(row.value.length, `${file} ${row.id} VALUE=[${row.value}]`).toBe(row.length);
      expect(row.value.trimEnd().endsWith("-"), `${file} ${row.id}`).toBe(false);
    }
    // …so the parser must not trim: a blank CHAR(10) is ten spaces, not the empty string.
    expect(liveRow("027-vars-char-and-packed.xml", "LV_TOP_CATEGORY").value).toBe(" ".repeat(10));
    expect(liveRow("027-vars-char-and-packed.xml", "LT_ITEMS[1]-ITEM_ID").value).toBe("A001      ");
    expect(liveRow("027-vars-char-and-packed.xml", "LS_ITEM-MATERIAL").value).toBe(" ".repeat(30));
  });

  it("the sign rewrite must be gated on TECHNICAL_TYPE, never on how the string LOOKS", () => {
    // A `D` date and a `C` client both parse as numbers if you only inspect the characters — the
    // type gate is the only thing keeping them off the numeric path.
    const date = liveRow("025-vars-table-rows-full.xml", "LT_ITEMS[1]-POSTING_DATE");
    expect(date.technicalType).toBe("D");
    expect(formatAbapNumeric(date.value)).toBe("20260111"); // numeric-LOOKING, not a number

    const client = liveRow("025-vars-table-rows-full.xml", "LT_ITEMS[1]-CLIENT");
    expect(client.technicalType).toBe("C");
    expect(client.value).toBe("001");
    expect(formatAbapNumeric(client.value)).toBe("001"); // leading zeros are DATA here

    // A padded CHAR is refused outright, so a caller cannot accidentally numify it.
    expect(formatAbapNumeric(liveRow("027-vars-char-and-packed.xml", "LT_ITEMS[1]-ITEM_ID").value)).toBeUndefined();
    expect(parseAbapNumeric(liveRow("027-vars-char-and-packed.xml", "LV_TOP_CATEGORY").value)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C. getVariables omits rows silently — key off ID
// ---------------------------------------------------------------------------

describe("LIVE BYTES: getVariables omits unresolvable rows silently (indexVariablesById / alignRequestedVariables)", () => {
  it("102: 4 ids requested, 2 rows returned, HTTP 200, no error element anywhere", () => {
    const meta = JSON.parse(live("102-np-vars-negative.meta.json")) as { responseStatus: number };
    expect(meta.responseStatus).toBe(200);

    const ids = requestedIds("102-np-vars-negative.meta.json");
    expect(ids).toEqual(["LV_ZMCP_NEG", "LV_ZMCP_NEGI", "LV_GRAND_TOTAL", "LT_ITEMS[1]-UNIT_PRICE"]);

    const body = live("102-np-vars-negative.xml");
    const rows = parseVariablesResponse(body);
    expect(rows).toHaveLength(2);
    // Not an exception, not an empty placeholder element: the two ids are simply ABSENT.
    expect(body).not.toContain("exception");
    expect(body).not.toContain("LV_ZMCP_NEG");

    const aligned = alignRequestedVariables(ids, rows);
    expect(aligned.resolved.map((r) => r.id)).toEqual(["LV_GRAND_TOTAL", "LT_ITEMS[1]-UNIT_PRICE"]);
    expect(aligned.missing).toEqual(["LV_ZMCP_NEG", "LV_ZMCP_NEGI"]); // the silent omission, made loud
    expect(aligned.unexpected).toEqual([]);
  });

  it("POSITIONAL ALIGNMENT IS A BUG: zipping 102's request onto its response mislabels BOTH rows", () => {
    const ids = requestedIds("102-np-vars-negative.meta.json");
    const rows = parseVariablesResponse(live("102-np-vars-negative.xml"));
    // What index-based matching would conclude…
    expect(rows.map((_, i) => ids[i])).toEqual(["LV_ZMCP_NEG", "LV_ZMCP_NEGI"]);
    // …versus the ID the server echoed inside each row. Every single one is wrong, and both
    // wrong answers are real variable names, so nothing downstream would look suspicious.
    expect(rows.map((r) => r.id)).toEqual(["LV_GRAND_TOTAL", "LT_ITEMS[1]-UNIT_PRICE"]);
  });

  it("223 proves the omission is the SERVER's answer, not a malformed request: identical 4 ids came back complete", () => {
    const ids = requestedIds("223-np-vars-negative.meta.json");
    expect(ids).toEqual(requestedIds("102-np-vars-negative.meta.json"));
    expect((JSON.parse(live("223-np-vars-negative.meta.json")) as { responseStatus: number }).responseStatus).toBe(200);

    const aligned = alignRequestedVariables(ids, parseVariablesResponse(live("223-np-vars-negative.xml")));
    expect(aligned.missing).toEqual([]);
    expect(aligned.resolved.map((r) => r.id)).toEqual(ids);
    expect(aligned.unexpected).toEqual([]);
  });

  it("ARRAY POSITION is not an identity either — the same ID sits at different indices across captures", () => {
    const at = (file: string, id: string) => parseVariablesResponse(live(file)).findIndex((r) => r.id === id);
    expect(at("102-np-vars-negative.xml", "LV_GRAND_TOTAL")).toBe(0);
    expect(at("223-np-vars-negative.xml", "LV_GRAND_TOTAL")).toBe(2);
  });

  it("NAME is NOT unique: 025 carries three rows named CLIENT, and their VALUEs are identical too", () => {
    const rows = parseChildVariablesResponse(live("025-vars-table-rows-full.xml")).variables;
    expect(rows).toHaveLength(21); // 3 parent rows × 7 components

    const clients = rows.filter((r) => r.name === "CLIENT");
    expect(clients).toHaveLength(3);
    expect(clients.map((r) => r.id)).toEqual(["LT_ITEMS[1]-CLIENT", "LT_ITEMS[2]-CLIENT", "LT_ITEMS[3]-CLIENT"]);
    // All three are `001`, so a NAME-keyed map does not even LOOK wrong when it silently keeps one.
    expect(new Set(clients.map((r) => r.value))).toEqual(new Set(["001"]));

    // ID separates all 21; NAME collapses them to the 7 component names.
    expect(indexVariablesById(rows).size).toBe(21);
    expect(new Set(rows.map((r) => r.name)).size).toBe(7);
    expect(indexVariablesById(rows).get("LT_ITEMS[2]-CLIENT")).toBe(clients[1]);
  });

  it("SWEEP: ID is unique inside every capture, so indexVariablesById never drops a row", () => {
    for (const { file, rows } of liveVariableCaptures()) {
      expect(indexVariablesById(rows).size, `${file} has a duplicate ID`).toBe(rows.length);
    }
  });

  it("a row the caller did not ask for is surfaced as `unexpected`, never dropped", () => {
    // Never observed on the wire; exercised here with REAL rows and a narrowed request list,
    // because dropping such a row is precisely how a positional bug would hide itself.
    const rows = parseVariablesResponse(live("223-np-vars-negative.xml"));
    const aligned = alignRequestedVariables(["LV_ZMCP_NEG"], rows);
    expect(aligned.resolved.map((r) => r.id)).toEqual(["LV_ZMCP_NEG"]);
    expect(aligned.missing).toEqual([]);
    expect(aligned.unexpected.map((r) => r.id)).toEqual([
      "LV_ZMCP_NEGI",
      "LV_GRAND_TOTAL",
      "LT_ITEMS[1]-UNIT_PRICE",
    ]);
  });

  it("UNSETTLEABLE, recorded not invented: IS_VALUE_INCOMPLETE and IS_EXCEPTION are empty in ALL 87 rows", () => {
    // Zero truthy samples anywhere in the corpus, so their flag family (`X`/`''` vs `true`/`false`)
    // CANNOT be settled from these bytes and no pin is invented for it. What is asserted is only
    // what the captures actually show: every row is self-closing-empty and parses to `false`.
    expect(LIVE_ROWS).toHaveLength(87);
    for (const { file, row } of LIVE_ROWS) {
      expect(row.isValueIncomplete, `${file} ${row.id}`).toBe(false);
      expect(row.isException, `${file} ${row.id}`).toBe(false);
    }
    const truthy = readdirSync(LIVE_DIR)
      .filter((f) => f.endsWith(".xml"))
      .filter((f) => /<IS_(?:VALUE_INCOMPLETE|EXCEPTION)>[^<]/.test(live(f)));
    expect(truthy).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// STPDA_DEBUGGEE booleans (live bytes)
//
// This is the block the two `parseDebuggeeResponse (debuggee.xml)` tests above
// point at ("see the 'STPDA_DEBUGGEE booleans (live bytes)' block near the
// bottom of this file"). Those tests were RETITLED off the `X`/`''` claim
// because the hand-authored `fixtures/debugger/debuggee.xml` spells these flags
// in a convention the server does not use; here are the bytes that settle it.
// ---------------------------------------------------------------------------

describe("LIVE BYTES: STPDA_DEBUGGEE booleans are the literal strings 'true'/'false', never 'X'", () => {
  const DEBUGGEE_CAPTURES = ["015-listener-hit.xml", "099-np-listener-hit.xml", "220-np-listener-hit.xml"];

  it("corpus guard: exactly these three captures carry a STPDA_DEBUGGEE listener answer", () => {
    const found = readdirSync(LIVE_DIR)
      .filter((f) => f.endsWith(".xml"))
      .filter((f) => live(f).includes("<STPDA_DEBUGGEE>"))
      .sort();
    expect(found).toEqual(DEBUGGEE_CAPTURES);
  });

  it.each(DEBUGGEE_CAPTURES)(
    "%s sends <IS_ATTACH_IMPOSSIBLE>false</…> and <IS_SAME_SERVER>true</…> — the inversion still lands on isAttachable=true",
    (file) => {
      const xml = live(file);
      // The raw bytes first, so this cannot pass on a parser that invents them.
      expect(xml).toContain("<IS_ATTACH_IMPOSSIBLE>false</IS_ATTACH_IMPOSSIBLE>");
      expect(xml).toContain("<IS_SAME_SERVER>true</IS_SAME_SERVER>");
      expect(xml).not.toContain("<IS_ATTACH_IMPOSSIBLE>X</IS_ATTACH_IMPOSSIBLE>");
      expect(xml).not.toContain("<IS_SAME_SERVER>X</IS_SAME_SERVER>");

      const d = parseDebuggeeResponse(xml);
      // `abapFlag`, not `xBool`: the strict X-family reader answers false to the literal "true",
      // which would have made isSameServer wrong on EVERY real listener hit while the
      // fixture-only test stayed green.
      expect(d.isAttachable).toBe(true);
      expect(d.isSameServer).toBe(true);
      expect(xBool("true")).toBe(false); // …which is why xBool alone is not enough here.
      expect(d.kind).toBe("debuggee");
    },
  );

  it("no XML ATTRIBUTE anywhere in the captured corpus carries the value 'X'", () => {
    // The narrower, stronger claim the `parseSettingsResponse` test above rests on, checked
    // against the bytes rather than argued: the `X` convention is an ELEMENT-text convention
    // (`<READ_ONLY>X</READ_ONLY>`), never an attribute one.
    const offenders = readdirSync(LIVE_DIR)
      .filter((f) => f.endsWith(".xml"))
      .filter((f) => /=\s*"X"/.test(live(f)));
    expect(offenders).toEqual([]);
  });
});
