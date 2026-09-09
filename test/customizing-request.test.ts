import { describe, expect, it } from "vitest";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { DDIC_ERR_PREFIX } from "../src/adt/ddic-bridge.js";
import { ERR_LINE_PREFIX } from "../src/adt/run.js";
import {
  CUSTOMIZING_REQUEST_CLASS,
  CUSTREQ_LINE_PREFIX,
  CUSTOMIZING_REQUEST_FM,
  CUSTREQ_DESCRIPTION_MAX,
  type CustomizingRequestPlan,
  validateCustomizingRequestPlan,
  parseCustomizingRequestTranscript,
} from "../src/adt/customizing-request.js";

function basePlan(overrides: Partial<CustomizingRequestPlan> = {}): CustomizingRequestPlan {
  return {
    description: "A customizing request",
    ...overrides,
  };
}

function expectBadInput(fn: () => unknown): void {
  try {
    fn();
    throw new Error("expected to throw");
  } catch (e) {
    if (!isAbapError(e)) throw e;
    expect((e as AbapError).code).toBe("BAD_INPUT");
  }
}

// ---------------------------------------------------------------------------
// Static shape
// ---------------------------------------------------------------------------

describe("static exports", () => {
  it("class name and line prefix are fixed", () => {
    expect(CUSTOMIZING_REQUEST_CLASS).toBe("ZCL_ZMCP_CTS_WREQ");
    expect(CUSTREQ_LINE_PREFIX).toBe("CTSW> ");
  });

  it("CUSTOMIZING_REQUEST_FM names the FM, function group and used params/exceptions", () => {
    expect(CUSTOMIZING_REQUEST_FM.fm).toBe("TR_INSERT_REQUEST_WITH_TASKS");
    expect(CUSTOMIZING_REQUEST_FM.functionGroup).toBe("SAPLSTR8");
    expect(CUSTOMIZING_REQUEST_FM.params.type).toBe("iv_type");
    expect(CUSTOMIZING_REQUEST_FM.params.text).toBe("iv_text");
    expect(CUSTOMIZING_REQUEST_FM.params.owner).toBe("iv_owner");
    expect(CUSTOMIZING_REQUEST_FM.params.requestHeader).toBe("es_request_header");
    expect(CUSTOMIZING_REQUEST_FM.params.taskHeaders).toBe("et_task_headers");
    expect(CUSTOMIZING_REQUEST_FM.exceptions.insertFailed).toBe("insert_failed");
    expect(CUSTOMIZING_REQUEST_FM.exceptions.enqueueFailed).toBe("enqueue_failed");
  });

  it("CUSTREQ_DESCRIPTION_MAX is 60 (AS4TEXT CHAR60)", () => {
    expect(CUSTREQ_DESCRIPTION_MAX).toBe(60);
  });

  it("CUSTOMIZING_REQUEST_FM passes IT_USERS, and the note documents the task-less finding rather than calling IT_USERS unset", () => {
    expect(CUSTOMIZING_REQUEST_FM.params.users).toBe("it_users");
    expect(CUSTOMIZING_REQUEST_FM.note).not.toMatch(/IT_USERS[^.]*(left unset|deliberately left unset)/);
    expect(CUSTOMIZING_REQUEST_FM.note).toContain(
      "created a request with no task when it was omitted",
    );
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateCustomizingRequestPlan", () => {
  it("accepts a minimal valid plan", () => {
    expect(() => validateCustomizingRequestPlan(basePlan())).not.toThrow();
  });

  it("rejects an empty description", () => {
    expectBadInput(() => validateCustomizingRequestPlan(basePlan({ description: "" })));
  });

  it("rejects a whitespace-only description", () => {
    expectBadInput(() => validateCustomizingRequestPlan(basePlan({ description: "   " })));
  });

  it("rejects a description over 60 characters", () => {
    expectBadInput(() => validateCustomizingRequestPlan(basePlan({ description: "A".repeat(61) })));
  });

  it("accepts a description of exactly 60 characters", () => {
    expect(() =>
      validateCustomizingRequestPlan(basePlan({ description: "A".repeat(60) })),
    ).not.toThrow();
  });

  it("rejects a description containing a newline", () => {
    expectBadInput(() => validateCustomizingRequestPlan(basePlan({ description: "a\nb" })));
  });

  it("rejects a description containing a carriage return", () => {
    expectBadInput(() => validateCustomizingRequestPlan(basePlan({ description: "a\rb" })));
  });

  it("rejects a description containing a tab", () => {
    expectBadInput(() => validateCustomizingRequestPlan(basePlan({ description: "a\tb" })));
  });

  it("rejects a description containing an arbitrary control character", () => {
    expectBadInput(() => validateCustomizingRequestPlan(basePlan({ description: "a\x01b" })));
  });

  it("accepts a description containing a single quote", () => {
    expect(() =>
      validateCustomizingRequestPlan(basePlan({ description: "caller's request" })),
    ).not.toThrow();
  });

  it("accepts a well-formed owner", () => {
    expect(() => validateCustomizingRequestPlan(basePlan({ owner: "DEVELOPER1" }))).not.toThrow();
  });

  it("rejects a lowercase owner", () => {
    expectBadInput(() => validateCustomizingRequestPlan(basePlan({ owner: "developer1" })));
  });

  it("rejects an owner over 12 characters", () => {
    expectBadInput(() => validateCustomizingRequestPlan(basePlan({ owner: "A".repeat(13) })));
  });

  it("rejects an owner with characters outside the allowed set", () => {
    expectBadInput(() => validateCustomizingRequestPlan(basePlan({ owner: "BAD-NAME!" })));
  });

  it("rejects an empty owner", () => {
    expectBadInput(() => validateCustomizingRequestPlan(basePlan({ owner: "" })));
  });
});

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

describe("parseCustomizingRequestTranscript", () => {
  it("parses a well-formed success transcript into request and task, with no errors", () => {
    const text = [
      `${CUSTREQ_LINE_PREFIX}REQUEST len=[10] value=[AAAK900050]`,
      `${CUSTREQ_LINE_PREFIX}TASK len=[10] value=[AAAK900051]`,
    ].join("\n");
    const t = parseCustomizingRequestTranscript(text);
    expect(t.request).toBe("AAAK900050");
    expect(t.task).toBe("AAAK900051");
    expect(t.errors).toEqual([]);
  });

  it("parses an error transcript into the exception name and message text, with no request", () => {
    const msg = "object already locked";
    const text = `${CUSTREQ_LINE_PREFIX}ERROR exception=[INSERT_FAILED] len=[${msg.length}] value=[${msg}]`;
    const t = parseCustomizingRequestTranscript(text);
    expect(t.request).toBeUndefined();
    expect(t.task).toBeUndefined();
    expect(t.errors).toEqual(["INSERT_FAILED: object already locked"]);
  });

  it("parses ENQUEUE_FAILED distinctly from INSERT_FAILED", () => {
    const text = `${CUSTREQ_LINE_PREFIX}ERROR exception=[ENQUEUE_FAILED] len=[9] value=[locked by]`;
    const t = parseCustomizingRequestTranscript(text);
    expect(t.errors).toEqual(["ENQUEUE_FAILED: locked by"]);
  });

  it("round-trips a value containing a closing bracket intact", () => {
    const msg = "a]b] c]d";
    const text = `${CUSTREQ_LINE_PREFIX}ERROR exception=[OTHERS] len=[${msg.length}] value=[${msg}]`;
    const t = parseCustomizingRequestTranscript(text);
    expect(t.errors).toEqual(["OTHERS: a]b] c]d"]);
  });

  it("recovers significant trailing blanks stripped before the closing bracket", () => {
    const text = `${CUSTREQ_LINE_PREFIX}REQUEST len=[12] value=[AAAK900050]`;
    const t = parseCustomizingRequestTranscript(text);
    expect(t.request).toBe("AAAK900050  ");
  });

  it("ignores an unrecognized CTSW> tag without throwing", () => {
    const text = `${CUSTREQ_LINE_PREFIX}BOGUS foo=[bar]`;
    expect(() => parseCustomizingRequestTranscript(text)).not.toThrow();
    const t = parseCustomizingRequestTranscript(text);
    expect(t.request).toBeUndefined();
    expect(t.errors).toEqual([]);
  });

  it("ignores a line without the CTSW> prefix without throwing", () => {
    const text = "this is not a transcript line";
    expect(() => parseCustomizingRequestTranscript(text)).not.toThrow();
    expect(parseCustomizingRequestTranscript(text)).toEqual({ errors: [], warnings: [] });
  });

  it("returns empty results for garbage input without throwing", () => {
    const text = "\x00\x01 garbage [[[ ]]] === not even close\n\n";
    expect(() => parseCustomizingRequestTranscript(text)).not.toThrow();
    const t = parseCustomizingRequestTranscript(text);
    expect(t.request).toBeUndefined();
    expect(t.task).toBeUndefined();
    expect(t.errors).toEqual([]);
  });

  it("does not throw and drops a malformed ERROR line missing its value bracket", () => {
    const text = `${CUSTREQ_LINE_PREFIX}ERROR exception=[INSERT_FAILED] len=[5]`;
    expect(() => parseCustomizingRequestTranscript(text)).not.toThrow();
    const t = parseCustomizingRequestTranscript(text);
    expect(t.errors).toEqual([]);
  });

  it("routes a bare scaffold DDIC error line into errors, with no request", () => {
    const text = `${DDIC_ERR_PREFIX} T000 read failed for client 001`;
    const t = parseCustomizingRequestTranscript(text);
    expect(t.request).toBeUndefined();
    expect(t.task).toBeUndefined();
    expect(t.errors).toEqual(["T000 read failed for client 001"]);
  });

  it("routes a bare scaffold ERR_LINE_PREFIX line into errors, with no request", () => {
    const text = `${ERR_LINE_PREFIX}EXCEPTION CX_SY_ZERODIVIDE: division by zero`;
    const t = parseCustomizingRequestTranscript(text);
    expect(t.request).toBeUndefined();
    expect(t.errors).toEqual(["EXCEPTION CX_SY_ZERODIVIDE: division by zero"]);
  });

  it("reports a scaffold error and a CTSW> ERROR both, in wire order", () => {
    const text = [
      `${DDIC_ERR_PREFIX} something failed before the FM call`,
      `${CUSTREQ_LINE_PREFIX}ERROR exception=[INSERT_FAILED] len=[6] value=[locked]`,
    ].join("\n");
    const t = parseCustomizingRequestTranscript(text);
    expect(t.request).toBeUndefined();
    expect(t.errors).toEqual(["something failed before the FM call", "INSERT_FAILED: locked"]);
  });

  it("parses a REQUEST followed by a WARN NO_TASK line into request set, task undefined, and warnings populated", () => {
    const text = [
      `${CUSTREQ_LINE_PREFIX}REQUEST len=[10] value=[A4HK900002]`,
      `${CUSTREQ_LINE_PREFIX}WARN code=[NO_TASK] len=[10] value=[A4HK900002]`,
    ].join("\n");
    const t = parseCustomizingRequestTranscript(text);
    expect(t.request).toBe("A4HK900002");
    expect(t.task).toBeUndefined();
    expect(t.warnings).toEqual(["NO_TASK: A4HK900002"]);
    expect(t.errors).toEqual([]);
  });

  it("parses a REQUEST followed by a TASK line with an empty warnings array", () => {
    const text = [
      `${CUSTREQ_LINE_PREFIX}REQUEST len=[10] value=[AAAK900050]`,
      `${CUSTREQ_LINE_PREFIX}TASK len=[10] value=[AAAK900051]`,
    ].join("\n");
    const t = parseCustomizingRequestTranscript(text);
    expect(t.task).toBe("AAAK900051");
    expect(t.warnings).toEqual([]);
  });

  it("parses REQUEST + TASK + TASKTYPE into request/task/taskType all set", () => {
    const text = [
      `${CUSTREQ_LINE_PREFIX}REQUEST len=[10] value=[AAAK900050]`,
      `${CUSTREQ_LINE_PREFIX}TASK len=[10] value=[AAAK900051]`,
      `${CUSTREQ_LINE_PREFIX}TASKTYPE len=[1] value=[Q]`,
    ].join("\n");
    const t = parseCustomizingRequestTranscript(text);
    expect(t.request).toBe("AAAK900050");
    expect(t.task).toBe("AAAK900051");
    expect(t.taskType).toBe("Q");
    expect(t.errors).toEqual([]);
  });

  it("leaves taskType undefined when a transcript carries TASK but no TASKTYPE line", () => {
    const text = [
      `${CUSTREQ_LINE_PREFIX}REQUEST len=[10] value=[AAAK900050]`,
      `${CUSTREQ_LINE_PREFIX}TASK len=[10] value=[AAAK900051]`,
    ].join("\n");
    const t = parseCustomizingRequestTranscript(text);
    expect(t.task).toBe("AAAK900051");
    expect(t.taskType).toBeUndefined();
  });

  it("recovers a TASKTYPE value's significant trailing blanks stripped before the closing bracket, same as TASK's recovery path", () => {
    const text = `${CUSTREQ_LINE_PREFIX}TASKTYPE len=[3] value=[Q]`;
    const t = parseCustomizingRequestTranscript(text);
    // len=[3] but the bracketed value is only "Q" (1 char) — the parser pads to len,
    // exactly the same recovery `extractCustReqValue` performs for TASK/REQUEST when
    // trailing blanks were stripped before the closing bracket reached this parser.
    expect(t.taskType).toBe("Q  ");
  });

  it("does not throw and drops a malformed TASKTYPE line missing its value bracket", () => {
    const text = `${CUSTREQ_LINE_PREFIX}TASKTYPE len=[1]`;
    expect(() => parseCustomizingRequestTranscript(text)).not.toThrow();
    const t = parseCustomizingRequestTranscript(text);
    expect(t.taskType).toBeUndefined();
  });
});
