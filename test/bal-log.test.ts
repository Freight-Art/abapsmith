/**
 * Pure unit tests for `src/adt/bal-log.ts`, the TypeScript side of
 * `abap_fluid run tool:"log" action:"read"` (issue #108): dispatch-arg
 * building, row mapping, text rendering and the audit line. No
 * AbapConnection, no dispatch(), no fluid runtime — every row below is
 * constructed by hand against the wire contract the module's own header
 * comment documents (mirrors test/source-scan-rows.test.ts's approach for
 * the sibling `scan` tool).
 */
import { describe, expect, it } from "vitest";
import {
  LOG_TOOLS,
  DEFAULT_LOG_MAX,
  DEFAULT_LOG_WINDOW_SECONDS,
  logDispatchArgs,
  mapLogRows,
  renderLogRead,
  auditLogRead,
  type BalLogQuery,
  type BalLogResult,
} from "../src/adt/bal-log.js";
import { AbapError } from "../src/adt/errors.js";

// ---------------------------------------------------------------------------
// Fixture: two logs under BUPA/GENERAL, one under CHANGEDOCU, a handful of
// S/W/E messages — the literal row shape the ABAP side (log.ts) emits.
// ---------------------------------------------------------------------------

function headerRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: "log",
    lognumber: "0000000000123456789012345678901234567890",
    object: "BUPA",
    subobject: "GENERAL",
    extnumber: "BP-4711",
    aldate: "20260910",
    altime: "091500",
    aluser: "MUELLER",
    alprog: "SAPMF02D",
    altcode: "BP",
    almode: "D",
    probclass: "2",
    msg_total: 3,
    msg_abort: 0,
    msg_error: 1,
    msg_warning: 1,
    msg_info: 1,
    msg_success: 0,
    ...overrides,
  };
}

function msgRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: "msg",
    lognumber: "0000000000123456789012345678901234567890",
    msgnumber: 1,
    msgty: "E",
    msgid: "BUPA_GEN",
    msgno: "001",
    msgv1: "0000001000",
    msgv2: "",
    msgv3: "",
    msgv4: "",
    text: "Business partner 0000001000 could not be saved",
    detlevel: 1,
    probclass: "2",
    context_tabname: "BUS_EI_BUPA",
    ...overrides,
  };
}

function summaryRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: "summary",
    logs_returned: 2,
    messages_returned: 4,
    truncated: false,
    detail: "messages",
    since: "20260910083000",
    until: "20260910093000",
    user: "MUELLER",
    max: 20,
    server_time: "20260910093012",
    ...overrides,
  };
}

/** The realistic three-log fixture described in the task: BUPA/GENERAL x2, CHANGEDOCU x1. */
const CAPTURED_ROWS: Record<string, unknown>[] = [
  headerRow({
    lognumber: "0000000000000000000000000000000000000001",
    object: "BUPA",
    subobject: "GENERAL",
    extnumber: "BP-4711",
    msg_total: 2,
    msg_error: 1,
    msg_warning: 1,
    msg_info: 0,
    msg_success: 0,
  }),
  msgRow({
    lognumber: "0000000000000000000000000000000000000001",
    msgnumber: 1,
    msgty: "E",
    msgid: "BUPA_GEN",
    msgno: "001",
    text: "Business partner 0000001000 could not be saved",
  }),
  msgRow({
    lognumber: "0000000000000000000000000000000000000001",
    msgnumber: 2,
    msgty: "W",
    msgid: "BUPA_GEN",
    msgno: "014",
    msgv1: "0000001000",
    text: "Address data is incomplete for business partner 0000001000",
    detlevel: 2,
    context_tabname: "",
  }),
  headerRow({
    lognumber: "0000000000000000000000000000000000000002",
    object: "BUPA",
    subobject: "GENERAL",
    extnumber: "BP-4712",
    msg_total: 1,
    msg_error: 0,
    msg_warning: 0,
    msg_info: 1,
    msg_success: 0,
  }),
  msgRow({
    lognumber: "0000000000000000000000000000000000000002",
    msgnumber: 1,
    msgty: "I",
    msgid: "BUPA_GEN",
    msgno: "100",
    text: "Business partner 0000002000 saved",
    detlevel: 1,
    context_tabname: "",
  }),
  headerRow({
    lognumber: "0000000000000000000000000000000000000003",
    object: "CHANGEDOCU",
    subobject: "",
    extnumber: "",
    alprog: "RSCDOK99",
    altcode: "",
    msg_total: 1,
    msg_error: 0,
    msg_warning: 0,
    msg_info: 0,
    msg_success: 1,
  }),
  msgRow({
    lognumber: "0000000000000000000000000000000000000003",
    msgnumber: 1,
    msgty: "S",
    msgid: "CHANGEDOCU",
    msgno: "001",
    text: "Change document object CDHDR/CDPOS archived",
    detlevel: 1,
    probclass: "3",
    context_tabname: "",
  }),
  summaryRow({
    logs_returned: 3,
    messages_returned: 4,
    truncated: false,
    detail: "messages",
    since: "20260910083000",
    until: "20260910093000",
    user: "MUELLER",
    max: 20,
    server_time: "20260910093012",
  }),
];

// ---------------------------------------------------------------------------
// logDispatchArgs
// ---------------------------------------------------------------------------

describe("logDispatchArgs", () => {
  it("maps every BalLogQuery field to its wire arg name", () => {
    const q: BalLogQuery = {
      object: "BUPA",
      subobject: "GENERAL",
      extnumber: "BP-4711",
      user: "MUELLER",
      since: "20260910083000",
      until: "20260910093000",
      tcode: "BP",
      program: "SAPMF02D",
      max: 50,
      detail: "messages",
    };
    expect(logDispatchArgs(q)).toEqual({
      object: "BUPA",
      subobject: "GENERAL",
      extnumber: "BP-4711",
      user: "MUELLER",
      since: "20260910083000",
      until: "20260910093000",
      tcode: "BP",
      program: "SAPMF02D",
      max: 50,
      detail: "messages",
    });
  });

  it("maps lastSeconds to last_seconds", () => {
    const args = logDispatchArgs({ lastSeconds: 900 });
    expect(args["last_seconds"]).toBe(900);
  });

  it("omits absent/undefined optional fields entirely (no empty-string or undefined keys)", () => {
    const args = logDispatchArgs({});
    expect(Object.keys(args).sort()).toEqual(["last_seconds", "max"]);
  });

  it("omits empty-string optional fields (treated as absent)", () => {
    const args = logDispatchArgs({ object: "", subobject: "", extnumber: "", user: "", tcode: "", program: "" });
    expect(Object.keys(args).sort()).toEqual(["last_seconds", "max"]);
  });

  it("defaults max to DEFAULT_LOG_MAX when omitted", () => {
    const args = logDispatchArgs({});
    expect(args["max"]).toBe(DEFAULT_LOG_MAX);
  });

  it("passes through an explicit max, including 0", () => {
    expect(logDispatchArgs({ max: 5 })["max"]).toBe(5);
    expect(logDispatchArgs({ max: 0 })["max"]).toBe(0);
  });

  it("applies DEFAULT_LOG_WINDOW_SECONDS as last_seconds when no window is pinned at all", () => {
    const args = logDispatchArgs({});
    expect(args["last_seconds"]).toBe(DEFAULT_LOG_WINDOW_SECONDS);
  });

  it("does not apply the default window when since is pinned", () => {
    const args = logDispatchArgs({ since: "20260910083000" });
    expect(args["last_seconds"]).toBeUndefined();
    expect(args["since"]).toBe("20260910083000");
  });

  it("does not apply the default window when until is pinned", () => {
    const args = logDispatchArgs({ until: "20260910093000" });
    expect(args["last_seconds"]).toBeUndefined();
    expect(args["until"]).toBe("20260910093000");
  });

  it("does not apply the default window when lastSeconds is pinned explicitly", () => {
    const args = logDispatchArgs({ lastSeconds: 120 });
    expect(args["last_seconds"]).toBe(120);
  });

  it("omits detail when not given (no default applied here — that lives on the ABAP side)", () => {
    const args = logDispatchArgs({});
    expect("detail" in args).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapLogRows
// ---------------------------------------------------------------------------

function expectProtocolError(fn: () => unknown): AbapError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AbapError);
    const err = e as AbapError;
    expect(err.code).toBe("FLUID_PROTOCOL_ERROR");
    return err;
  }
  throw new Error("expected mapLogRows to throw, but it did not");
}

describe("mapLogRows: happy paths", () => {
  it("groups message rows under the right header by lognumber, preserving order", () => {
    const { logs, summary } = mapLogRows(CAPTURED_ROWS);

    expect(logs).toHaveLength(3);
    expect(logs[0]?.lognumber).toBe("0000000000000000000000000000000000000001");
    expect(logs[0]?.object).toBe("BUPA");
    expect(logs[0]?.subobject).toBe("GENERAL");
    expect(logs[0]?.messages).toHaveLength(2);
    expect(logs[0]?.messages[0]?.msgty).toBe("E");
    expect(logs[0]?.messages[1]?.msgty).toBe("W");

    expect(logs[1]?.lognumber).toBe("0000000000000000000000000000000000000002");
    expect(logs[1]?.messages).toHaveLength(1);
    expect(logs[1]?.messages[0]?.msgty).toBe("I");

    expect(logs[2]?.object).toBe("CHANGEDOCU");
    expect(logs[2]?.messages).toHaveLength(1);
    expect(logs[2]?.messages[0]?.msgty).toBe("S");

    expect(summary).toEqual({
      logs_returned: 3,
      messages_returned: 4,
      truncated: false,
      detail: "messages",
      since: "20260910083000",
      until: "20260910093000",
      user: "MUELLER",
      max: 20,
      server_time: "20260910093012",
    });
  });

  it("maps a headers-only result (no msg rows) into logs with empty messages arrays", () => {
    const rows = [
      headerRow({ lognumber: "L1" }),
      headerRow({ lognumber: "L2", object: "CHANGEDOCU", subobject: "" }),
      summaryRow({ logs_returned: 2, messages_returned: 0, detail: "headers" }),
    ];
    const { logs } = mapLogRows(rows);
    expect(logs).toHaveLength(2);
    expect(logs[0]?.messages).toEqual([]);
    expect(logs[1]?.messages).toEqual([]);
  });

  it("maps a zero-log result (summary row only) into an empty logs array", () => {
    const rows = [summaryRow({ logs_returned: 0, messages_returned: 0 })];
    const { logs, summary } = mapLogRows(rows);
    expect(logs).toEqual([]);
    expect(summary.logs_returned).toBe(0);
  });
});

describe("mapLogRows: rejects malformed shapes with FLUID_PROTOCOL_ERROR (asserting only real behaviour)", () => {
  it("throws when the top-level result is not an array", () => {
    expectProtocolError(() => mapLogRows({ not: "an array" } as unknown as unknown[]));
  });

  it("throws when a row is not an object", () => {
    expectProtocolError(() => mapLogRows(["not an object", summaryRow()]));
  });

  it('throws when a row has an unknown "kind" (unknown kind values are rejected, not skipped)', () => {
    expectProtocolError(() => mapLogRows([{ kind: "bogus" }, summaryRow()]));
  });

  it("throws when no summary row is returned at all (a missing summary is rejected, not defaulted)", () => {
    expectProtocolError(() => mapLogRows([headerRow()]));
  });

  it("throws when a msg row appears before any log row", () => {
    expectProtocolError(() => mapLogRows([msgRow(), summaryRow()]));
  });

  it("throws when a row follows the trailing summary row", () => {
    expectProtocolError(() => mapLogRows([summaryRow(), headerRow()]));
  });

  it("throws when more than one summary row is returned", () => {
    expectProtocolError(() => mapLogRows([summaryRow(), summaryRow()]));
  });

  it("throws when a log row is missing a required field", () => {
    const bad = headerRow();
    delete bad.msg_total;
    expectProtocolError(() => mapLogRows([bad, summaryRow()]));
  });

  it("throws when a msg row is missing a required field (e.g. no context_value field is expected either)", () => {
    const bad = msgRow();
    delete bad.detlevel;
    expectProtocolError(() => mapLogRows([headerRow(), bad, summaryRow()]));
  });

  it("throws when a summary row is missing a required field", () => {
    const bad = summaryRow();
    delete bad.truncated;
    expectProtocolError(() => mapLogRows([bad]));
  });

  it('includes "log.read" in the error message so callers can tell this apart from other FLUID_PROTOCOL_ERROR sources', () => {
    const err = expectProtocolError(() => mapLogRows("not an array" as unknown as unknown[]));
    expect(err.message).toContain("log.read");
  });
});

// ---------------------------------------------------------------------------
// renderLogRead
// ---------------------------------------------------------------------------

describe("renderLogRead", () => {
  const headersResult: BalLogResult = mapLogRows([
    headerRow({ lognumber: "L1", object: "BUPA", subobject: "GENERAL" }),
    headerRow({ lognumber: "L2", object: "CHANGEDOCU", subobject: "" }),
    summaryRow({ logs_returned: 2, messages_returned: 0, detail: "headers" }),
  ]);

  it("detail:headers emits one section per log with the header table and NO message table", () => {
    const { text } = renderLogRead(headersResult, { maxChars: 20_000 });
    expect(text).toContain("--- LOG L1 BUPA/GENERAL ---");
    expect(text).toContain("--- LOG L2 CHANGEDOCU ---");
    expect(text).toContain("extnumber");
    expect(text).toContain("total");
    expect(text).not.toContain("msgty");
    expect(text).not.toMatch(/\btext\b/);
    // No message table means no business-data note either.
    expect(text).not.toContain("Message text and its variables");
  });

  it("detail:messages emits the message table too and a business-data warning note", () => {
    const messagesResult: BalLogResult = mapLogRows(CAPTURED_ROWS);
    const { text } = renderLogRead(messagesResult, { maxChars: 20_000 });

    expect(text).toContain("--- LOG 0000000000000000000000000000000000000001 BUPA/GENERAL ---");
    expect(text).toContain("--- LOG 0000000000000000000000000000000000000003 CHANGEDOCU ---");
    // Message table columns.
    expect(text).toContain("type");
    expect(text).toContain("BUPA_GEN001");
    expect(text).toContain("Business partner 0000001000 could not be saved");
    expect(text).toContain(
      "NOTE: Message text and its variables (msgv1..msgv4) are application data written by the " +
        "logging program, not abapsmith's own output, and may contain business data.",
    );
  });

  it("marks truncation and emits a note when summary.truncated is true", () => {
    const truncated: BalLogResult = mapLogRows([
      headerRow({ lognumber: "L1" }),
      summaryRow({ logs_returned: 1, messages_returned: 0, truncated: true, detail: "headers", max: 1 }),
    ]);
    const { text, truncated: truncatedFlag } = renderLogRead(truncated, { maxChars: 20_000 });
    expect(truncatedFlag).toBe(false); // buildResponse's own truncated flag tracks byte-cap windowing, not this
    expect(text).toContain("truncated: true");
    expect(text).toMatch(/Not every matching log was returned \(max=1\)/);
  });

  it("emits no truncation hint when summary.truncated is false", () => {
    const { text } = renderLogRead(headersResult, { maxChars: 20_000 });
    expect(text).not.toContain("Not every matching log was returned");
  });

  it("emits NO paging parameter — this view has no offset axis", () => {
    // Force the WINDOW/TRUNCATED notice path by giving a tiny maxChars, and
    // confirm the "no offset/paging parameter" wording buildResponse emits
    // when no pagingParam was supplied, never a `Fetch the next chunk with
    // offset=` hint.
    const big: BalLogResult = mapLogRows(CAPTURED_ROWS);
    const { text } = renderLogRead(big, { maxChars: 400 });
    expect(text).not.toMatch(/Fetch the next chunk with \w+=/);
  });
});

// ---------------------------------------------------------------------------
// auditLogRead
// ---------------------------------------------------------------------------

describe("auditLogRead", () => {
  it("writes exactly one line of the documented shape, naming object/subobject/logs/messages", () => {
    const result = mapLogRows(CAPTURED_ROWS);
    const lines: string[] = [];
    auditLogRead(result, { object: "BUPA", subobject: "GENERAL" }, (m) => lines.push(m));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      "[abapsmith] audit: abap_fluid log.read object=BUPA subobject=GENERAL logs=3 messages=4",
    );
  });

  it("uses * for object/subobject when the query didn't pin them", () => {
    const result = mapLogRows(CAPTURED_ROWS);
    const lines: string[] = [];
    auditLogRead(result, {}, (m) => lines.push(m));
    expect(lines[0]).toBe("[abapsmith] audit: abap_fluid log.read object=* subobject=* logs=3 messages=4");
  });

  it("never includes any message text from the fixture in the audit line", () => {
    const result = mapLogRows(CAPTURED_ROWS);
    const lines: string[] = [];
    auditLogRead(result, { object: "BUPA", subobject: "GENERAL" }, (m) => lines.push(m));

    const line = lines[0]!;
    const allMessageTexts = result.logs.flatMap((l) => l.messages.map((m) => m.text));
    expect(allMessageTexts.length).toBeGreaterThan(0);
    for (const text of allMessageTexts) {
      expect(line).not.toContain(text);
    }
    // Explicitly pin the point of this test against one concrete string.
    expect(line).not.toContain("Business partner 0000001000 could not be saved");
  });
});

// ---------------------------------------------------------------------------
// LOG_TOOLS
// ---------------------------------------------------------------------------

describe("LOG_TOOLS", () => {
  it("contains the log tool with a read action of category read", () => {
    const tool = LOG_TOOLS.get("log");
    expect(tool).toBeDefined();
    const action = tool?.manifest.actions.find((a) => a.name === "read");
    expect(action).toBeDefined();
    expect(action?.category).toBe("read");
  });
});
