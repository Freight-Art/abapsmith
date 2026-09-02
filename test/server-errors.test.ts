/**
 * Error envelope, safety lockout and URL redaction — offline/pure only. No
 * network, no .env. Mirrors the style of test/safety.test.ts.
 */
import { describe, expect, it } from "vitest";
import { buildErrorPayload, errorResult } from "../src/server.js";
import { AbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import { stripUrlCredentials } from "../src/config.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Parse the JSON envelope out of a CallToolResult's text content. */
function envelope(res: CallToolResult): Record<string, any> {
  const text = (res.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

const rawText = (res: CallToolResult): string => (res.content[0] as { type: "text"; text: string }).text;

describe("errorResult — raw ADT throws", () => {
  it("classifies a raw lock conflict as LOCKED and structures the T100 key", () => {
    const e = Object.assign(new Error("Resource is being edited"), {
      err: 403,
      type: "ExceptionResourceNoAccess",
      properties: {
        "T100KEY-ID": "EU",
        "T100KEY-NO": "510",
        "T100KEY-V1": "DEVELOPER",
        "T100KEY-V2": "ZMCP_DBG_DEMO",
      },
    });
    const res = errorResult(e);
    expect(res.isError).toBe(true);
    const body = envelope(res);
    expect(body.error).toBe("LOCKED");
    expect(body.adt.status).toBe(403);
    expect(body.adt.exceptionType).toBe("ExceptionResourceNoAccess");
    expect(body.adt.t100.id).toBe("EU");
    expect(body.adt.t100.no).toBe("510");
    expect(body.adt.t100.variables.v1).toBe("DEVELOPER");
    expect(typeof body.summary).toBe("string");
    expect(body.summary).toContain("403");
    expect(body.summary).toContain("EU510");
  });

  it("classifies a raw 404 as NOT_FOUND", () => {
    const e = Object.assign(new Error("Object not found"), {
      err: 404,
      type: "ExceptionResourceNotFound",
    });
    const res = errorResult(e);
    const body = envelope(res);
    expect(body.error).toBe("NOT_FOUND");
    expect(body.adt.status).toBe(404);
  });

  // ---------------------------------------------------------------------
  // This is the raw-throw branch of buildErrorPayload,
  // "the path this whole rewrite exists for" per its own doc comment. It
  // used to build `payload` with no `hint` key in the object literal at
  // all, so LOCKED/NOT_FOUND/ADT_ERROR all reached the caller hint-free
  // here even though the AbapError branch right above it carries good hint
  // text for the same three codes.
  // ---------------------------------------------------------------------
  it("a raw lock conflict (LOCKED) gets a hint here too, forbidding the retry loop", () => {
    const e = Object.assign(new Error("Resource is being edited"), {
      err: 403,
      type: "ExceptionResourceNoAccess",
      properties: { "T100KEY-ID": "EU", "T100KEY-NO": "510" },
    });
    const body = envelope(errorResult(e));
    expect(body.error).toBe("LOCKED");
    expect(body.hint).toBeTruthy();
    expect(body.hint).toMatch(/do not retry in a loop/i);
    expect(body.hint).toMatch(/no lock timeout/i);
    // Honest about provenance: this branch never extracted a blocking user,
    // so its hint must not claim one exists to name.
    expect(body.hint).not.toMatch(/blockingUser|blocked by|held by a session logged on as/i);
  });

  it("a raw 404 (NOT_FOUND) gets the same hint the translated NOT_FOUND path carries", () => {
    const e = Object.assign(new Error("Object not found"), {
      err: 404,
      type: "ExceptionResourceNotFound",
    });
    const body = envelope(errorResult(e));
    expect(body.error).toBe("NOT_FOUND");
    expect(body.hint).toBe("Check the name with abap_search, or create the object first.");
  });

  it("a raw, unclassified throw (ADT_ERROR) gets a hint naming the adt block and forbidding an unchanged retry", () => {
    const e = Object.assign(new Error("Something ADT did not name"), {
      err: 500,
      type: "SomeOtherException",
    });
    const body = envelope(errorResult(e));
    expect(body.error).toBe("ADT_ERROR");
    expect(body.hint).toBeTruthy();
    expect(body.hint).toMatch(/adt\.localizedMessage/);
    expect(body.hint).toMatch(/adt\.t100/);
    expect(body.hint).toMatch(/do not retry unchanged/i);
    // Honest about provenance, without naming the internal classifier function.
    expect(body.hint).toMatch(/never classified beyond a generic HTTP\/exception shape/i);
  });

  it("names no internal function in a caller-facing hint", () => {
    const locked = Object.assign(new Error("Resource is being edited"), {
      err: 403,
      type: "ExceptionResourceNoAccess",
      properties: { "T100KEY-ID": "EU", "T100KEY-NO": "510" },
    });
    const lockedBody = envelope(errorResult(locked));
    expect(lockedBody.error).toBe("LOCKED");
    expect(lockedBody.message).not.toMatch(/translateAdtError/);
    expect(lockedBody.hint).not.toMatch(/translateAdtError/);

    const generic = Object.assign(new Error("Something ADT did not name"), {
      err: 500,
      type: "SomeOtherException",
    });
    const genericBody = envelope(errorResult(generic));
    expect(genericBody.error).toBe("ADT_ERROR");
    expect(genericBody.message).not.toMatch(/translateAdtError/);
    expect(genericBody.hint).not.toMatch(/translateAdtError/);
  });

  it("promotes the communicationFramework subType, keeps previousNText, drops previousNLongText", () => {
    const e = Object.assign(new Error("Debugger exception"), {
      err: 500,
      properties: {
        "com.sap.adt.communicationFramework.subType": "getStack",
        previous1Text: "An exception was raised",
        previous1LongText: "<html><body>a long text blob nobody needs</body></html>",
      },
    });
    const res = errorResult(e);
    const body = envelope(res);
    expect(body.adt.subType).toBe("getStack");
    expect(body.adt.properties.previous1Text).toBe("An exception was raised");
    expect(body.adt.properties.previous1LongText).toBeUndefined();
    expect(rawText(res)).not.toContain("long text blob");
  });

  it("promotes ideUser/conflictText to adt.lock and names the holder in the summary", () => {
    const e = Object.assign(new Error("Resource is being edited"), {
      err: 403,
      properties: {
        ideUser: "DEVELOPER",
        conflictText: "Locked by user DEVELOPER since 10:15:00",
      },
    });
    const res = errorResult(e);
    const body = envelope(res);
    expect(body.adt.lock.ideUser).toBe("DEVELOPER");
    expect(body.adt.lock.conflictText).toBe("Locked by user DEVELOPER since 10:15:00");
    expect(body.summary).toContain("DEVELOPER");
  });

  it('drops the literal string "undefined" produced by empty ADT entry elements', () => {
    const e = Object.assign(new Error("Something failed"), {
      err: 500,
      properties: {
        previous2LongText: "undefined",
        someKey: "undefined",
        realKey: "a real value",
      },
    });
    const res = errorResult(e);
    const body = envelope(res);
    expect(body.adt.properties?.previous2LongText).toBeUndefined();
    expect(body.adt.properties?.someKey).toBeUndefined();
    expect(body.adt.properties?.realKey).toBe("a real value");
  });
});

describe("errorResult — AbapError path", () => {
  it("keeps code/hint and re-gathers structure under adt, without duplicating it into details", () => {
    const e = new AbapError(
      "LOCKED",
      "msg",
      {
        operation: "write",
        status: 403,
        adtExceptionType: "ExceptionResourceNoAccess",
        blockingUser: "DEVELOPER",
        t100: { "T100KEY-ID": "EU", "T100KEY-NO": "510" },
      },
      "a hint",
    );
    const res = errorResult(e);
    const body = envelope(res);
    expect(body.error).toBe("LOCKED");
    expect(body.hint).toBe("a hint");
    expect(body.adt.status).toBe(403);
    expect(body.adt.lock.blockingUser).toBe("DEVELOPER");
    expect(body.adt.t100.id).toBe("EU");
    expect(body.details.operation).toBe("write");
    expect(body.details.status).toBeUndefined();
    expect(body.details.adtExceptionType).toBeUndefined();
    expect(body.details.blockingUser).toBeUndefined();
    expect(body.details.t100).toBeUndefined();
  });
});

describe("errorResult — no raw body, ever", () => {
  it("never leaks a raw HTTP body even when the throw carries one in response or parent.response", () => {
    const SENTINEL = "SENTINEL_SHORT_DUMP_BODY";
    const BIG = SENTINEL + "x".repeat(165_000);
    const e = Object.assign(new Error("Short dump"), {
      err: 500,
      response: { status: 500, body: BIG },
      parent: { response: { status: 500, body: BIG } },
    });
    const res = errorResult(e);
    const text = rawText(res);
    expect(text).not.toContain(SENTINEL);
    expect(text.length).toBeLessThanOrEqual(4100);
  });

  it("sheds the residual property bag under budget pressure while keeping named fields", () => {
    const properties: Record<string, string> = {};
    for (let i = 0; i < 200; i++) {
      properties[`prop${i}`] = "y".repeat(400);
    }
    const e = Object.assign(new Error("many properties"), {
      err: 500,
      properties,
    });
    const res = errorResult(e);
    const text = rawText(res);
    expect(text.length).toBeLessThanOrEqual(4100);
    const body = envelope(res);
    expect(typeof body.error).toBe("string");
    expect(typeof body.message).toBe("string");
    expect(body.adt.status).toBe(500);
    expect(typeof body.adt.omitted).toBe("string");
  });
});

describe("errorResult — unknown junk", () => {
  it("does not throw and produces a usable envelope for a plain string", () => {
    const res = errorResult("just a string");
    expect(res.isError).toBe(true);
    const body = envelope(res);
    expect(typeof body.error).toBe("string");
  });

  it("does not throw and produces a usable envelope for undefined", () => {
    const res = errorResult(undefined);
    expect(res.isError).toBe(true);
    const body = envelope(res);
    expect(typeof body.error).toBe("string");
  });
});

describe("buildErrorPayload — pure envelope construction", () => {
  it("matches errorResult's parsed body for the AbapError branch", () => {
    const e = new AbapError("LOCKED", "msg", { operation: "write", status: 403 }, "a hint");
    const payload = buildErrorPayload(e);
    const fromWrapper = envelope(errorResult(e));
    expect(payload).toEqual(fromWrapper);
    expect(payload.error).toBe("LOCKED");
    expect(payload.hint).toBe("a hint");
  });

  it("matches errorResult's parsed body for a raw/unknown throw", () => {
    const e = Object.assign(new Error("Object not found"), { err: 404, type: "ExceptionResourceNotFound" });
    const payload = buildErrorPayload(e);
    const fromWrapper = envelope(errorResult(e));
    expect(payload).toEqual(fromWrapper);
    expect(payload.error).toBe("NOT_FOUND");
  });
});

describe("SafetyGate — writesLockedOut", () => {
  const target = { name: "ZFOO", packageName: "$TMP", type: "CLAS/OC" };

  it("blocks a write with READ_ONLY even when writes were explicitly opted into", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      writesLockedOut: true,
      lockoutReason: "T000 probe returned 403 Forbidden",
    });
    const d = g.evaluate("write", target);
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("READ_ONLY");
    expect(d.reason).toContain("T000 probe returned 403 Forbidden");
  });

  it("allows the same write once writesLockedOut is false", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      writesLockedOut: false,
    });
    expect(g.evaluate("write", target).allowed).toBe(true);
  });

  it("does not block reads", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      writesLockedOut: true,
      lockoutReason: "unreachable probe",
    });
    expect(g.evaluate("read").allowed).toBe(true);
  });

  it("uses lockout wording, distinct from the productive wording", () => {
    const locked = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      writesLockedOut: true,
      lockoutReason: "no evidence",
    });
    const lockedReason = locked.evaluate("write", target).reason;
    expect(lockedReason).not.toContain("reports itself as productive");

    const productive = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      productive: true,
    });
    const productiveReason = productive.evaluate("write", target).reason;
    expect(productiveReason).toContain("reports itself as productive");
  });

  it("assert() throws an AbapError with code READ_ONLY", () => {
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      writesLockedOut: true,
      lockoutReason: "no evidence",
    });
    expect(() => g.assert("write", target)).toThrow(
      expect.objectContaining({ code: "READ_ONLY" }),
    );
  });
});

describe("stripUrlCredentials", () => {
  it("strips a userinfo password but keeps the user and host", () => {
    const out = stripUrlCredentials("http://DEVELOPER:s3cr3t@host:50000");
    expect(out).not.toContain("s3cr3t");
    expect(out).toContain("DEVELOPER");
    expect(out).toContain("host:50000");
  });

  it("returns a credential-free URL unchanged", () => {
    expect(stripUrlCredentials("http://host:50000")).toBe("http://host:50000");
  });

  it("falls back to a regex redaction for a value that new URL() rejects, without leaking the password", () => {
    // A space in the host makes this reject the WHATWG URL parser while still
    // carrying real userinfo — exactly the case the regex fallback exists for.
    const malformed = "http://user:s3cr3t@ho st:50000";
    expect(() => stripUrlCredentials(malformed)).not.toThrow();
    const out = stripUrlCredentials(malformed);
    expect(out).not.toContain("s3cr3t");
  });

  it("does not throw on an empty string", () => {
    expect(() => stripUrlCredentials("")).not.toThrow();
    expect(stripUrlCredentials("")).toBe("");
  });

  // The old name (`redactUrl`) advertised host-safety it never had — the host
  // is the thing that actually leaks, and this function was never meant to
  // remove it. `describeUrlWithoutHost` exists for callers that need that.
  it("leaves the host fully intact — this function only ever redacted credentials, never the host", () => {
    const out = stripUrlCredentials("http://host:50000");
    expect(out).toContain("host:50000");
  });
});
