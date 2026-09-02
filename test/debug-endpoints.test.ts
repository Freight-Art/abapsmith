/**
 * `src/debug/endpoints.ts` unit tests — pure URL/constant construction,
 * zero SAP access, checked against the debugger wire contract.
 *
 * Run with: npx vitest run test/debug-endpoints.test.ts (never a bare
 * `npx vitest run` — see the offline/security constraints in the task brief).
 */
import { describe, expect, it } from "vitest";
import {
  BREAKPOINTS_ACCEPT,
  BREAKPOINTS_CONTENT_TYPE,
  CANARY_VARIABLE_ID,
  DATA_AGING_VARIABLE_ID,
  DEBUGGER_BATCH_PATH,
  DEBUGGER_BREAKPOINTS_PATH,
  DEBUGGER_DISPATCH_PATH,
  DEBUGGER_ENDPOINTS,
  DEBUGGER_LISTENERS_PATH,
  DEBUGGER_STACK_PATH,
  DEBUGGING_MODE,
  DEFAULT_CHILD_VARIABLE_PARENTS,
  GET_CHILD_VARIABLES_CONTENT_TYPE,
  GET_VARIABLES_CONTENT_TYPE,
  IDE_ID_LENGTH,
  LISTENER_DEFAULT_TIMEOUT_SECONDS,
  ROOT_VARIABLE_ID,
  STACK_EMODE,
  TERMINAL_ID_LENGTH,
  VARIABLE_PART,
  assertValidIdeId,
  assertValidTerminalId,
  attachUrl,
  batchUrl,
  breakpointsPostUrl,
  buildQuery,
  buildUrl,
  deleteBreakpointUrl,
  getChildVariablesUrl,
  getStackUrl,
  getVariablesUrl,
  legacyGetStackUrl,
  listenerGetUrl,
  listenerLaunchUrl,
  listenerStopUrl,
  parseStartFragment,
  setDebuggerSettingsUrl,
  setStackPositionUrl,
  setVariableValueUrl,
  startFragment,
  stepUrl,
  terminateDebuggeeUrl,
  variableDataUrl,
  variableMaxLengthUrl,
  variablePartUrl,
  variableSubcomponentsUrl,
  variableValueStatementUrl,
  withStartFragment,
} from "../src/debug/endpoints.js";

// A 32-character stand-in terminal/ide id, matching SYSUUID_C32.
const TID = "ABCDEF0123456789ABCDEF0123456789".slice(0, 32);
// Must be uppercase hex (SYSUUID_C32) — "IDEIDE..." is NOT valid hex (I is not a hex digit).
const IDE = "1DE1DE1DE1DE1DE1DE1DE1DE1DE1DE01".slice(0, 32);

describe("buildQuery / buildUrl", () => {
  it("omits undefined values", () => {
    expect(buildQuery({ a: "1", b: undefined, c: 2 })).toBe("?a=1&c=2");
  });

  it("returns empty string for no params", () => {
    expect(buildQuery({})).toBe("");
    expect(buildUrl("/sap/bc/adt/x")).toBe("/sap/bc/adt/x");
    expect(buildUrl("/sap/bc/adt/x", {})).toBe("/sap/bc/adt/x");
  });

  it("serialises booleans as true/false strings", () => {
    expect(buildQuery({ checkConflict: true, notifyConflict: false })).toBe("?checkConflict=true&notifyConflict=false");
  });

  it("explodes array values (RFC 6570 exploded list), never comma-joins them", () => {
    const q = buildQuery({ components: ["MATNR", "WERKS"] });
    expect(q).toBe("?components=MATNR&components=WERKS");
    expect(q).not.toContain(",");
  });

  it("URL-encodes keys and values", () => {
    expect(buildQuery({ "a b": "c/d" })).toBe("?a%20b=c%2Fd");
  });

  it("never appends sap-client — refuses outright rather than silently dropping it", () => {
    expect(() => buildQuery({ "sap-client": "001" })).toThrow(/sap-client/i);
    expect(() => buildQuery({ sapClient: "001" })).toThrow(/sap-client/i);
    expect(() => buildQuery({ SAP_CLIENT: "001" })).toThrow(/sap-client/i);
  });

  it("buildUrl concatenates path and query", () => {
    expect(buildUrl("/sap/bc/adt/foo", { a: "1" })).toBe("/sap/bc/adt/foo?a=1");
  });
});

describe("terminal ID — exactly 32 chars, SYSUUID_C32", () => {
  it("accepts exactly 32 characters", () => {
    expect(TERMINAL_ID_LENGTH).toBe(32);
    expect(() => assertValidTerminalId("A".repeat(32))).not.toThrow();
  });

  it("rejects a 31-character id", () => {
    expect(() => assertValidTerminalId("A".repeat(31))).toThrow(/exactly 32/);
  });

  it("rejects a 33-character id rather than silently truncating it", () => {
    // This is the load-bearing case: the SAP server itself truncates a
    // too-long CHAR32 assignment with no error, which is exactly the silent
    // collision footgun this module must refuse to reproduce.
    const tooLong = "B".repeat(33);
    expect(() => assertValidTerminalId(tooLong)).toThrow();
    // Confirm we did NOT just truncate-and-accept: the thrown message
    // reports the actual (wrong) length, not 32.
    expect(() => assertValidTerminalId(tooLong)).toThrow(/33/);
  });

  it("two 33-char ids sharing a 32-char prefix are BOTH rejected, not silently equated", () => {
    const a = "C".repeat(32) + "X";
    const b = "C".repeat(32) + "Y";
    expect(a).not.toBe(b);
    expect(() => assertValidTerminalId(a)).toThrow();
    expect(() => assertValidTerminalId(b)).toThrow();
  });

  it("is enforced inside listener URL builders", () => {
    expect(() =>
      listenerLaunchUrl({ debuggingMode: DEBUGGING_MODE.TERMINAL, terminalId: "short", ideId: IDE }),
    ).toThrow(/exactly 32/);
  });
});

describe("#start=N fragment", () => {
  it("builds the fragment", () => {
    expect(startFragment(42)).toBe("#start=42");
  });

  it("rejects non-positive or non-integer lines", () => {
    expect(() => startFragment(0)).toThrow();
    expect(() => startFragment(-1)).toThrow();
    expect(() => startFragment(1.5)).toThrow();
  });

  it("appends to a URI", () => {
    expect(withStartFragment("/sap/bc/adt/programs/programs/ZTEST/source/main", 42)).toBe(
      "/sap/bc/adt/programs/programs/ZTEST/source/main#start=42",
    );
  });

  it("parses a line back out of a returned URI, including a server-corrected one", () => {
    expect(parseStartFragment("/sap/bc/adt/oo/classes/zcl_foo/source/main#start=44")).toBe(44);
    expect(parseStartFragment("/sap/bc/adt/oo/classes/zcl_foo/source/main")).toBeUndefined();
  });

  it("does NOT parse the L,C;end=L,C form as anything but the leading line (server discards past the comma)", () => {
    expect(parseStartFragment("...#start=42,3;end=44,1")).toBe(42);
  });
});

describe("attach — dispatches via ?method=attach, not /debugger/attach", () => {
  it("dispatches through ?method=attach on /sap/bc/adt/debugger, not /debugger/attach", () => {
    const url = attachUrl({ debuggeeId: "D1", debuggingMode: DEBUGGING_MODE.USER, requestUser: "DEVELOPER" });
    expect(url.startsWith(DEBUGGER_DISPATCH_PATH)).toBe(true);
    expect(url).not.toContain("/debugger/attach");
    expect(url).toContain("method=attach");
    expect(url).toContain("debuggeeId=D1");
    expect(url).toContain("debuggingMode=user");
    expect(url).toContain("requestUser=DEVELOPER");
  });

  it("defaults dynproDebugging to true", () => {
    const url = attachUrl({ debuggeeId: "D1", debuggingMode: DEBUGGING_MODE.USER });
    expect(url).toContain("dynproDebugging=true");
  });

  it("respects an explicit dynproDebugging override", () => {
    const url = attachUrl({ debuggeeId: "D1", debuggingMode: DEBUGGING_MODE.USER, dynproDebugging: false });
    expect(url).toContain("dynproDebugging=false");
  });
});

describe("step actions — same ?method= dispatcher as attach", () => {
  const steps = [
    "stepInto",
    "stepOver",
    "stepReturn",
    "stepContinue",
    "stepRunToLine",
    "stepJumpToLine",
    "terminateDebuggee",
  ] as const;

  it.each(steps)("encodes %s as ?method=%s on the debugger dispatch path", (step) => {
    const url = stepUrl({ step });
    expect(url).toBe(`${DEBUGGER_DISPATCH_PATH}?method=${step}`);
  });

  it("carries a #start=N uri for line-targeted steps", () => {
    const url = stepUrl({ step: "stepRunToLine", uri: withStartFragment("/sap/bc/adt/programs/programs/ZTEST/source/main", 10) });
    expect(url).toContain("method=stepRunToLine");
    expect(url).toContain(encodeURIComponent("#start=10"));
  });

  it("terminateDebuggeeUrl matches stepUrl({step:'terminateDebuggee'})", () => {
    expect(terminateDebuggeeUrl()).toBe(stepUrl({ step: "terminateDebuggee" }));
  });
});

describe("listeners — three distinct legal param sets on one path", () => {
  it("launch carries timeout/checkConflict/isNotifiedOnConflict", () => {
    const url = listenerLaunchUrl({
      debuggingMode: DEBUGGING_MODE.USER,
      terminalId: TID,
      ideId: IDE,
      requestUser: "DEVELOPER",
      timeout: 60,
      checkConflict: true,
      isNotifiedOnConflict: true,
    });
    expect(url.startsWith(DEBUGGER_LISTENERS_PATH)).toBe(true);
    expect(url).toContain("timeout=60");
    expect(url).toContain("checkConflict=true");
    expect(url).toContain("isNotifiedOnConflict=true");
  });

  it("stop carries notifyConflict, not isNotifiedOnConflict", () => {
    const url = listenerStopUrl({
      debuggingMode: DEBUGGING_MODE.USER,
      terminalId: TID,
      ideId: IDE,
      notifyConflict: true,
    });
    expect(url).toContain("notifyConflict=true");
    expect(url).not.toContain("isNotifiedOnConflict");
  });

  it("get carries only the shared context plus checkConflict", () => {
    const url = listenerGetUrl({ debuggingMode: DEBUGGING_MODE.USER, terminalId: TID, ideId: IDE, checkConflict: true });
    expect(url).toContain("checkConflict=true");
    expect(url).not.toContain("timeout");
  });

  it("server default timeout constant is 240s (CL_TPDA_ADT_RES_LISTENERS)", () => {
    expect(LISTENER_DEFAULT_TIMEOUT_SECONDS).toBe(240);
  });
});

describe("breakpoints", () => {
  it("post URL carries only checkConflict, on /debugger/breakpoints, application/xml", () => {
    const url = breakpointsPostUrl({ checkConflict: true });
    expect(url).toBe(`${DEBUGGER_BREAKPOINTS_PATH}?checkConflict=true`);
    expect(BREAKPOINTS_CONTENT_TYPE).toBe("application/xml");
    expect(BREAKPOINTS_ACCEPT).toBe("application/xml");
  });

  it("post URL omits checkConflict entirely when not given", () => {
    expect(breakpointsPostUrl()).toBe(DEBUGGER_BREAKPOINTS_PATH);
  });

  it("delete URL encodes the server-assigned id as a path segment", () => {
    const url = deleteBreakpointUrl({
      id: "KIND=0.SOURCETYPE=ABAP.MAIN_PROGRAM=ZFOO",
      scope: "external",
      debuggingMode: DEBUGGING_MODE.USER,
      requestUser: "DEVELOPER",
    });
    expect(url).toContain(encodeURIComponent("KIND=0.SOURCETYPE=ABAP.MAIN_PROGRAM=ZFOO"));
    expect(url).toContain("scope=external");
  });
});

describe("variables / getVariables / getChildVariables", () => {
  it("getVariables dispatches with the dataname content type", () => {
    expect(getVariablesUrl()).toBe(`${DEBUGGER_DISPATCH_PATH}?method=getVariables`);
    expect(GET_VARIABLES_CONTENT_TYPE).toContain("dataname=com.sap.adt.debugger.Variables");
  });

  it("getChildVariables dispatches with its own dataname content type", () => {
    expect(getChildVariablesUrl()).toBe(`${DEBUGGER_DISPATCH_PATH}?method=getChildVariables`);
    expect(GET_CHILD_VARIABLES_CONTENT_TYPE).toContain("dataname=com.sap.adt.debugger.ChildVariables");
  });

  it("setVariableValue carries variableName", () => {
    expect(setVariableValueUrl("SY-SUBRC")).toBe(`${DEBUGGER_DISPATCH_PATH}?method=setVariableValue&variableName=SY-SUBRC`);
  });

  it("setDebuggerSettings dispatches with no extra params", () => {
    expect(setDebuggerSettingsUrl()).toBe(`${DEBUGGER_DISPATCH_PATH}?method=setDebuggerSettings`);
  });

  // REGRESSION PIN: the live server rejected `…&stackType=ABAP&stackPosition=2`
  // with `Parameter position could not be found.`; abap-adt-api's
  // debuggerGoToStackOld independently sends `{ method, position }`. The exact
  // query string is pinned here so the wrong names cannot silently come back.
  it("setStackPosition carries a 1-based `position` and never `stackType`", () => {
    const url = setStackPositionUrl(2);
    expect(url).toBe(`${DEBUGGER_DISPATCH_PATH}?method=setStackPosition&position=2`);
    expect(url).not.toContain("stackType");
    expect(url).not.toContain("stackPosition=");
    expect(setStackPositionUrl(1)).toBe(`${DEBUGGER_DISPATCH_PATH}?method=setStackPosition&position=1`);
  });

  // ---------------------------------------------------------------------------
  // FORBIDDEN (live-verified): the whole
  // `/variables/{name}/{part}` family is broken or actively session-destroying
  // on this release ("data"/"valueStatement" trigger an ABAP short dump that
  // kills the HTTP session AND the attached debug session; "metadata" 400s;
  // "subcomponents" 500s). `variablePartUrl` — and therefore every wrapper
  // below, which delegates to it — now throws unconditionally rather than
  // building a URL nobody may safely call. These tests were updated in place
  // (not deleted) to pin that guard down; the verified, non-destructive
  // replacement is path-addressed getVariables/getChildVariables ids.
  // ---------------------------------------------------------------------------

  it("variableDataUrl is FORBIDDEN and throws (live short dump)", () => {
    expect(() => variableDataUrl("LT_ITEMS", { offset: 0, length: 20 })).toThrow(/FORBIDDEN/);
  });

  it("variableSubcomponentsUrl is FORBIDDEN and throws (live 500 AdiFailed)", () => {
    expect(() => variableSubcomponentsUrl("LS_HDR", { component: "GUID", line: 3 })).toThrow(/FORBIDDEN/);
  });

  it("variableValueStatementUrl is FORBIDDEN and throws (live short dump)", () => {
    expect(() => variableValueStatementUrl("LT_ITEMS", { rows: "1-10", maxTotalSize: 10_000 })).toThrow(
      /FORBIDDEN/,
    );
  });

  it("default child-variable parents are @ROOT and @DATAAGING", () => {
    expect(DEFAULT_CHILD_VARIABLE_PARENTS).toEqual([ROOT_VARIABLE_ID, DATA_AGING_VARIABLE_ID]);
  });

  it("SY-SUBRC is exported as the canary variable id", () => {
    expect(CANARY_VARIABLE_ID).toBe("SY-SUBRC");
  });
});

describe("stack", () => {
  it("modern getStackUrl hits the dedicated GET resource with emode/semanticURIs", () => {
    const url = getStackUrl({ emode: STACK_EMODE, semanticURIs: true });
    expect(url).toBe(`${DEBUGGER_STACK_PATH}?emode=_&semanticURIs=true`);
  });

  it("legacyGetStackUrl falls back to the ?method= dispatcher", () => {
    expect(legacyGetStackUrl()).toBe(`${DEBUGGER_DISPATCH_PATH}?method=getStack`);
  });
});

describe("batch", () => {
  it("batchUrl points at /sap/bc/adt/debugger/batch", () => {
    expect(batchUrl()).toBe(DEBUGGER_BATCH_PATH);
    expect(DEBUGGER_BATCH_PATH).toBe("/sap/bc/adt/debugger/batch");
  });
});

describe("modes / scopes / sync-scope enumerations", () => {
  it("debugging modes", () => {
    expect(DEBUGGING_MODE.USER).toBe("user");
    expect(DEBUGGING_MODE.TERMINAL).toBe("terminal");
  });
});

describe("DEBUGGER_ENDPOINTS — the audit table", () => {
  it("has unique names", () => {
    const names = DEBUGGER_ENDPOINTS.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every entry carries a citation", () => {
    for (const e of DEBUGGER_ENDPOINTS) {
      expect(e.citation.length).toBeGreaterThan(0);
    }
  });

  it("covers every path this module names as a required surface", () => {
    const paths = DEBUGGER_ENDPOINTS.map((e) => e.path);
    expect(paths).toContain(DEBUGGER_BREAKPOINTS_PATH);
    expect(paths).toContain(DEBUGGER_LISTENERS_PATH);
    expect(paths).toContain(DEBUGGER_STACK_PATH);
    expect(paths).toContain(DEBUGGER_BATCH_PATH);
    expect(paths.some((p) => p === DEBUGGER_DISPATCH_PATH)).toBe(true);
  });

  it("the attach entry documents that it is absent from discovery", () => {
    const attach = DEBUGGER_ENDPOINTS.find((e) => e.name === "dispatch.attach");
    expect(attach?.notes).toMatch(/discovery/i);
  });

  it("the breakpoints GET entry documents it is not a list endpoint", () => {
    const bp = DEBUGGER_ENDPOINTS.find((e) => e.name === "breakpoints.get.conditionValidator");
    expect(bp?.notes).toMatch(/not a list/i);
  });
});

describe("assertValidTerminalId / assertValidIdeId — length then charset", () => {
  it("IDE_ID_LENGTH is 32", () => {
    expect(IDE_ID_LENGTH).toBe(32);
  });

  it("accepts a valid 32-char uppercase-hex id", () => {
    expect(() => assertValidTerminalId("0123456789ABCDEF0123456789ABCDEF".slice(0, 32))).not.toThrow();
    expect(() => assertValidIdeId("0123456789ABCDEF0123456789ABCDEF".slice(0, 32))).not.toThrow();
  });

  it("rejects a 31-char id with a message mentioning 32", () => {
    expect(() => assertValidTerminalId("A".repeat(31))).toThrow(/32/);
    expect(() => assertValidIdeId("A".repeat(31))).toThrow(/32/);
  });

  it("rejects a 33-char id with a message mentioning both 32 and 33", () => {
    expect(() => assertValidTerminalId("A".repeat(33))).toThrow(/32/);
    expect(() => assertValidTerminalId("A".repeat(33))).toThrow(/33/);
    expect(() => assertValidIdeId("A".repeat(33))).toThrow(/33/);
  });

  it("rejects the same id lowercased with a message mentioning uppercase hex", () => {
    const valid = "0123456789ABCDEF0123456789ABCDEF".slice(0, 32);
    const lowered = valid.toLowerCase();
    expect(lowered).not.toBe(valid);
    expect(() => assertValidTerminalId(lowered)).toThrow(/uppercase hex/i);
    expect(() => assertValidIdeId(lowered)).toThrow(/uppercase hex/i);
  });

  it("rejects mixed-case hex", () => {
    expect(() => assertValidTerminalId("0123456789abcdEF0123456789ABCDEF".slice(0, 32))).toThrow(/uppercase hex/i);
  });

  it("rejects a 32-char value containing a non-hex letter", () => {
    expect(() => assertValidTerminalId("G".repeat(32))).toThrow(/uppercase hex/i);
  });

  it("rejects a 32-char value containing a dash", () => {
    expect(() => assertValidTerminalId("-".repeat(32))).toThrow(/uppercase hex/i);
  });

  it("assertValidIdeId's default label mentions ideId", () => {
    expect(() => assertValidIdeId("short")).toThrow(/ideId/);
  });

  it("a custom label is honoured", () => {
    expect(() => assertValidIdeId("short", "myCustomLabel")).toThrow(/myCustomLabel/);
    expect(() => assertValidTerminalId("short", "myCustomLabel")).toThrow(/myCustomLabel/);
  });
});

describe("deleteBreakpointUrl — mode-dependent mandatory params", () => {
  const validTerminal = "0123456789ABCDEF0123456789ABCDEF".slice(0, 32);
  const validIde = "FEDCBA9876543210FEDCBA9876543210".slice(0, 32);

  it("happy path in terminal mode emits all five params and the encoded id segment", () => {
    const url = deleteBreakpointUrl({
      id: "KIND=0.SOURCETYPE=ABAP.MAIN_PROGRAM=ZFOO",
      scope: "external",
      debuggingMode: DEBUGGING_MODE.TERMINAL,
      terminalId: validTerminal,
      ideId: validIde,
    });
    expect(url).toContain(encodeURIComponent("KIND=0.SOURCETYPE=ABAP.MAIN_PROGRAM=ZFOO"));
    expect(url).toContain("scope=external");
    expect(url).toContain(`debuggingMode=${DEBUGGING_MODE.TERMINAL}`);
    expect(url).toContain(`terminalId=${validTerminal}`);
    expect(url).toContain(`ideId=${validIde}`);
  });

  it("throws in terminal mode when ideId is missing, mentioning both terminalId and ideId", () => {
    expect(() =>
      deleteBreakpointUrl({
        id: "X",
        scope: "external",
        debuggingMode: DEBUGGING_MODE.TERMINAL,
        terminalId: validTerminal,
      }),
    ).toThrow(/terminalId/);
    expect(() =>
      deleteBreakpointUrl({
        id: "X",
        scope: "external",
        debuggingMode: DEBUGGING_MODE.TERMINAL,
        terminalId: validTerminal,
      }),
    ).toThrow(/ideId/);
  });

  it("throws in terminal mode when terminalId is missing", () => {
    expect(() =>
      deleteBreakpointUrl({
        id: "X",
        scope: "external",
        debuggingMode: DEBUGGING_MODE.TERMINAL,
        ideId: validIde,
      }),
    ).toThrow(/terminalId/);
  });

  it("throws in user mode with no requestUser", () => {
    expect(() =>
      deleteBreakpointUrl({
        id: "X",
        scope: "external",
        debuggingMode: DEBUGGING_MODE.USER,
      }),
    ).toThrow(/requestUser/);
  });

  it("does not throw when debuggingMode is undefined and no context params are given", () => {
    expect(() =>
      deleteBreakpointUrl({
        id: "X",
        scope: "external",
        debuggingMode: undefined as unknown as (typeof DEBUGGING_MODE)["USER"],
      }),
    ).not.toThrow();
  });

  it("propagates the uppercase-hex rejection for a lowercase ideId", () => {
    expect(() =>
      deleteBreakpointUrl({
        id: "X",
        scope: "external",
        debuggingMode: DEBUGGING_MODE.TERMINAL,
        terminalId: validTerminal,
        ideId: validIde.toLowerCase(),
      }),
    ).toThrow(/uppercase hex/i);
  });
});

describe("variableMaxLengthUrl / variablePartUrl — FORBIDDEN, never return a URL", () => {
  it("variableMaxLengthUrl throws with a FORBIDDEN message", () => {
    expect(() => variableMaxLengthUrl("LT_ITEMS", VARIABLE_PART.DATA, 100)).toThrow(/FORBIDDEN/);
  });

  it("variableMaxLengthUrl throws regardless of the part or length given", () => {
    expect(() => variableMaxLengthUrl("X", "metadata", 0)).toThrow(/FORBIDDEN/);
    expect(() => variableMaxLengthUrl("", "", -1)).toThrow(/FORBIDDEN/);
  });

  it.each(Object.values(VARIABLE_PART))("variablePartUrl throws for part %s", (part) => {
    expect(() => variablePartUrl("LT_ITEMS", part)).toThrow(/FORBIDDEN/);
  });

  it("variablePartUrl throws with no params argument at all", () => {
    expect(() => variablePartUrl("LT_ITEMS", VARIABLE_PART.DATA)).toThrow(/FORBIDDEN/);
  });

  it("variablePartUrl throws even with empty-string arguments", () => {
    expect(() => variablePartUrl("", "")).toThrow(/FORBIDDEN/);
  });

  it("variablePartUrl's message points the caller at the safe replacement", () => {
    expect(() => variablePartUrl("LT_ITEMS", VARIABLE_PART.DATA)).toThrow(/getVariablesUrl/);
    expect(() => variablePartUrl("LT_ITEMS", VARIABLE_PART.DATA)).toThrow(/getChildVariablesUrl/);
  });

  it("variableDataUrl, variableSubcomponentsUrl, variableValueStatementUrl and variableMaxLengthUrl never return a value — they only ever throw", () => {
    expect(() => variableDataUrl("X")).toThrow();
    expect(() => variableSubcomponentsUrl("X")).toThrow();
    expect(() => variableValueStatementUrl("X")).toThrow();
    expect(() => variableMaxLengthUrl("X", VARIABLE_PART.DATA, 10)).toThrow();
  });
});

describe("buildUrl — path validation and normalisation", () => {
  it("rejects an absolute URL with a scheme", () => {
    expect(() => buildUrl("https://host/sap/bc/adt/x")).toThrow(/^buildUrl: /);
    expect(() => buildUrl("https://host/sap/bc/adt/x")).toThrow(/absolute URL/);
  });

  it("rejects a protocol-relative URL", () => {
    expect(() => buildUrl("//host/sap/bc/adt")).toThrow(/absolute URL/);
  });

  it("rejects a path containing a query string", () => {
    expect(() => buildUrl("/sap/bc/adt/x?a=1")).toThrow(/^buildUrl: /);
    expect(() => buildUrl("/sap/bc/adt/x?a=1")).toThrow(/query string/);
  });

  it("rejects a path containing a fragment", () => {
    expect(() => buildUrl("/sap/bc/adt/x#start=5")).toThrow(/^buildUrl: /);
    expect(() => buildUrl("/sap/bc/adt/x#start=5")).toThrow(/fragment/);
  });

  it("rejects a path containing a space", () => {
    expect(() => buildUrl("/sap/bc/adt/x y")).toThrow(/whitespace or control/);
  });

  it("rejects a path containing a tab", () => {
    expect(() => buildUrl("/sap/bc/adt/x\ty")).toThrow(/whitespace or control/);
  });

  it("rejects a path containing a backslash", () => {
    expect(() => buildUrl("/sap/bc/adt/x\\y")).toThrow(/whitespace or control/);
  });

  it("rejects a path with a traversal segment", () => {
    expect(() => buildUrl("/sap/bc/adt/../etc")).toThrow(/^buildUrl: /);
    expect(() => buildUrl("/sap/bc/adt/../etc")).toThrow(/traversal/);
  });

  it("rejects a path outside the /sap/bc/adt root", () => {
    expect(() => buildUrl("/etc/passwd")).toThrow(/\/sap\/bc\/adt/);
    expect(() => buildUrl("/sap/bc/foo")).toThrow(/\/sap\/bc\/adt/);
  });

  it("rejects an empty or whitespace-only path", () => {
    expect(() => buildUrl("")).toThrow(/non-empty/);
    expect(() => buildUrl("   ")).toThrow(/non-empty/);
  });

  it("normalises a missing leading slash", () => {
    expect(buildUrl("sap/bc/adt/x")).toBe("/sap/bc/adt/x");
  });

  it("normalises a trailing slash", () => {
    expect(buildUrl("/sap/bc/adt/x/")).toBe("/sap/bc/adt/x");
  });

  it("accepts the bare /sap/bc/adt root", () => {
    expect(() => buildUrl("/sap/bc/adt")).not.toThrow();
  });

  it("does not reject a legitimate dot inside a path segment", () => {
    expect(() => buildUrl("/sap/bc/adt/oo/classes/ZCL_A.B")).not.toThrow();
    expect(buildUrl("/sap/bc/adt/oo/classes/ZCL_A.B")).toBe("/sap/bc/adt/oo/classes/ZCL_A.B");
  });

  it("every buildUrl error message starts with 'buildUrl: '", () => {
    const cases = ["", "https://host/sap/bc/adt/x", "/sap/bc/adt/x?a=1", "/sap/bc/adt/x#f", "/sap/bc/adt/../x", "/etc/passwd"];
    for (const c of cases) {
      expect(() => buildUrl(c)).toThrow(/^buildUrl: /);
    }
  });
});
