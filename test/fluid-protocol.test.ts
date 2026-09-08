/**
 * Pure unit tests for src/adt/fluid/protocol.ts — no FakeAdtServer, no
 * network, no filesystem, no connection-shaped import at all. Covers the
 * ZMCP-H> wire format: frame splitting, OUTC/OUTE reassembly, the deliberate
 * "missing BEGIN/END is not an error" contract, and every FLUID_PROTOCOL_ERROR
 * throw site.
 */
import { describe, expect, it } from "vitest";
import { AbapError } from "../src/adt/errors.js";
import {
  FLUID_FRAME_PREFIX,
  parseFluidConsole,
  type FluidErrFrame,
} from "../src/adt/fluid/protocol.js";

function expectProtocolError(fn: () => unknown, lineText: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(AbapError);
  const err = caught as AbapError;
  expect(err.code).toBe("FLUID_PROTOCOL_ERROR");
  expect(err.message).toContain(lineText);
}

describe("FLUID_FRAME_PREFIX", () => {
  it("is the literal wire prefix", () => {
    expect(FLUID_FRAME_PREFIX).toBe("ZMCP-H>");
  });
});

describe("parseFluidConsole — well-formed transcript", () => {
  it("parses BEGIN/OUT/END into the exact expected frames with empty stray", () => {
    const text = [
      `ZMCP-H>BEGIN {"id":"classic","ver":"a1b2c3d4","action":"create_view","contract":"1.0"}`,
      `ZMCP-H>OUT {"created":true,"name":"ZV_DEMO"}`,
      `ZMCP-H>END {"rc":0,"outBytes":42,"truncated":false,"ms":10}`,
    ].join("\n");

    const result = parseFluidConsole(text);

    expect(result.begin).toEqual({
      id: "classic",
      ver: "a1b2c3d4",
      action: "create_view",
      contract: "1.0",
    });
    expect(result.values).toEqual([{ created: true, name: "ZV_DEMO" }]);
    expect(result.errors).toEqual([]);
    expect(result.end).toEqual({ rc: 0, outBytes: 42, truncated: false, ms: 10 });
    expect(result.stray).toEqual([]);
  });
});

describe("parseFluidConsole — missing frames are not errors", () => {
  it("a BEGIN + OUT transcript with no END parses with end undefined and the OUT value present", () => {
    const text = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      `ZMCP-H>OUT {"ok":true}`,
    ].join("\n");

    const result = parseFluidConsole(text);

    expect(result.end).toBeUndefined();
    expect(result.begin).toEqual({ id: "x", ver: "v1", action: "a", contract: "1.0" });
    expect(result.values).toEqual([{ ok: true }]);
  });

  it("a transcript with no frames at all (a short dump before anything was printed) yields begin undefined without throwing", () => {
    const text = ["Runtime Errors         MESSAGE_TYPE_X", "Short text     A short dump occurred."].join("\n");

    const result = parseFluidConsole(text);

    expect(result.begin).toBeUndefined();
    expect(result.end).toBeUndefined();
    expect(result.values).toEqual([]);
    expect(result.stray).toEqual([
      "Runtime Errors         MESSAGE_TYPE_X",
      "Short text     A short dump occurred.",
    ]);
  });

  it("a completely empty input yields begin and end undefined, no throw", () => {
    const result = parseFluidConsole("");
    expect(result.begin).toBeUndefined();
    expect(result.end).toBeUndefined();
    expect(result.values).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.stray).toEqual([]);
  });
});

describe("parseFluidConsole — OUTC/OUTE reassembly", () => {
  it("reassembles OUTC + OUTC + OUTE, split inside a string literal and inside a number, into exactly one value", () => {
    const full = JSON.stringify({ rows: [{ a: 1 }, { b: 20261 }], label: "hello world" });
    // Break 1 lands inside the `"hello world"` string; break 2 lands inside `20261`.
    const stringBreak = full.indexOf("hello wor") + "hello wor".length;
    const numberBreak = full.indexOf("2026") + 2;
    expect(numberBreak).toBeLessThan(stringBreak);

    const part1 = full.slice(0, numberBreak);
    const part2 = full.slice(numberBreak, stringBreak);
    const part3 = full.slice(stringBreak);

    const text = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      `ZMCP-H>OUTC ${part1}`,
      `ZMCP-H>OUTC ${part2}`,
      `ZMCP-H>OUTE ${part3}`,
    ].join("\n");

    const result = parseFluidConsole(text);

    expect(result.values).toHaveLength(1);
    expect(result.values[0]).toEqual(JSON.parse(full));
  });

  it("passes a large value (5000 array elements) through whole across many OUTC lines, with truncated staying false", () => {
    const bigArray = Array.from({ length: 5000 }, (_, i) => i);
    const original = { items: bigArray };
    const full = JSON.stringify(original);

    const chunkSize = 137;
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += chunkSize) {
      chunks.push(full.slice(i, i + chunkSize));
    }

    const lines = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      ...chunks.slice(0, -1).map((c) => `ZMCP-H>OUTC ${c}`),
      `ZMCP-H>OUTE ${chunks[chunks.length - 1]}`,
      `ZMCP-H>END {"rc":0,"outBytes":${full.length},"truncated":false,"ms":5}`,
    ];

    const result = parseFluidConsole(lines.join("\n"));

    expect(result.values).toHaveLength(1);
    expect(result.values[0]).toEqual(original);
    expect(result.end?.truncated).toBe(false);
  });

  it("passes truncated: true in END through faithfully", () => {
    const text = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      `ZMCP-H>END {"rc":0,"outBytes":99,"truncated":true,"ms":1}`,
    ].join("\n");

    const result = parseFluidConsole(text);
    expect(result.end?.truncated).toBe(true);
  });

  it("preserves a leading/trailing space inside a JSON string that falls at an OUTC/OUTE boundary", () => {
    const original = { text: "  padded on both sides  " };
    const full = JSON.stringify(original);
    // Split right after the opening quote+two spaces, so part1 ends mid-string
    // with trailing spaces and part2 begins mid-string too.
    const breakAt = full.indexOf("padded");
    const part1 = full.slice(0, breakAt);
    const part2 = full.slice(breakAt);

    const text = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      `ZMCP-H>OUTC ${part1}`,
      `ZMCP-H>OUTE ${part2}`,
    ].join("\n");

    const result = parseFluidConsole(text);
    expect(result.values).toEqual([original]);
  });
});

describe("parseFluidConsole — ERR frames", () => {
  it("preserves every optional field on a fully populated ERR frame", () => {
    const text = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      `ZMCP-H>ERR {"kind":"subrc","step":"DDIF_VIEW_PUT","subrc":2,"msgid":"E1","msgno":42,"msgv":["ZV_DEMO"],"text":"failed"}`,
    ].join("\n");

    const result = parseFluidConsole(text);

    const expected: FluidErrFrame = {
      kind: "subrc",
      step: "DDIF_VIEW_PUT",
      subrc: 2,
      msgid: "E1",
      msgno: 42,
      msgv: ["ZV_DEMO"],
      text: "failed",
    };
    expect(result.errors).toEqual([expected]);
  });

  it("parses a minimal ERR frame (kind/step/text only) with optional fields absent", () => {
    const text = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      `ZMCP-H>ERR {"kind":"exception","step":"CX_SY_ZERODIVIDE","text":"division by zero"}`,
    ].join("\n");

    const result = parseFluidConsole(text);

    expect(result.errors).toEqual([
      { kind: "exception", step: "CX_SY_ZERODIVIDE", text: "division by zero" },
    ]);
    expect(result.errors[0]).not.toHaveProperty("subrc");
    expect(result.errors[0]).not.toHaveProperty("msgid");
    expect(result.errors[0]).not.toHaveProperty("msgno");
    expect(result.errors[0]).not.toHaveProperty("msgv");
  });
});

describe("parseFluidConsole — stray lines", () => {
  it("collects non-frame lines into stray, in order, and drops blank lines", () => {
    const text = [
      "some preamble the kernel printed",
      "",
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      "   ",
      "a trailer line",
      `ZMCP-H>END {"rc":0,"outBytes":0,"truncated":false,"ms":1}`,
      "final trailer",
    ].join("\n");

    const result = parseFluidConsole(text);

    expect(result.stray).toEqual(["some preamble the kernel printed", "a trailer line", "final trailer"]);
  });
});

describe("parseFluidConsole — CRLF line endings", () => {
  it("parses \\r\\n line endings identically to \\n", () => {
    const lf = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      `ZMCP-H>OUT {"ok":true}`,
      `ZMCP-H>END {"rc":0,"outBytes":1,"truncated":false,"ms":1}`,
    ].join("\n");
    const crlf = lf.replace(/\n/g, "\r\n");

    expect(parseFluidConsole(crlf)).toEqual(parseFluidConsole(lf));
  });
});

describe("parseFluidConsole — throwing cases", () => {
  it("throws on an unknown frame name", () => {
    const line = `ZMCP-H>WAT {"x":1}`;
    expectProtocolError(
      () => parseFluidConsole(`ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}\n${line}`),
      line,
    );
  });

  it("throws on invalid JSON in a BEGIN payload", () => {
    const line = `ZMCP-H>BEGIN {not json}`;
    expectProtocolError(() => parseFluidConsole(line), line);
  });

  it("throws on invalid JSON in an ERR payload", () => {
    const line = `ZMCP-H>ERR {not json}`;
    expectProtocolError(
      () => parseFluidConsole(`ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}\n${line}`),
      line,
    );
  });

  it("throws on invalid JSON in an END payload", () => {
    const line = `ZMCP-H>END {not json}`;
    expectProtocolError(
      () => parseFluidConsole(`ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}\n${line}`),
      line,
    );
  });

  it("throws when a BEGIN field is missing", () => {
    const line = `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a"}`;
    expectProtocolError(() => parseFluidConsole(line), line);
  });

  it("throws when a BEGIN field has the wrong type", () => {
    const line = `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":42}`;
    expectProtocolError(() => parseFluidConsole(line), line);
  });

  it("throws when END's rc is not a finite number", () => {
    const line = `ZMCP-H>END {"rc":"zero","outBytes":1,"truncated":false,"ms":1}`;
    expectProtocolError(
      () => parseFluidConsole(`ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}\n${line}`),
      line,
    );
  });

  it("throws when END's truncated is not a boolean", () => {
    const line = `ZMCP-H>END {"rc":0,"outBytes":1,"truncated":"no","ms":1}`;
    expectProtocolError(
      () => parseFluidConsole(`ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}\n${line}`),
      line,
    );
  });

  it("throws on OUTE with no OUTC open", () => {
    const line = `ZMCP-H>OUTE {"a":1}`;
    expectProtocolError(
      () => parseFluidConsole(`ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}\n${line}`),
      line,
    );
  });

  it("throws when an OUTC is still open at the end of input", () => {
    const line = `ZMCP-H>OUTC {"a":1`;
    expectProtocolError(
      () => parseFluidConsole(`ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}\n${line}`),
      line,
    );
  });

  it("names the FIRST OUTC of an unterminated run, not the last, so the reader finds where the value started", () => {
    const firstOutc = `ZMCP-H>OUTC {"a":1,`;
    const text = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      firstOutc,
      `ZMCP-H>OUTC "b":2,`,
      `ZMCP-H>OUTC "c":3`,
    ].join("\n");

    let caught: unknown;
    try {
      parseFluidConsole(text);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(AbapError);
    const err = caught as AbapError;
    expect(err.code).toBe("FLUID_PROTOCOL_ERROR");
    expect(err.message).toContain(firstOutc);
    expect(err.details["line"]).toBe(2);
  });

  it("throws when a frame arrives after END", () => {
    const line = `ZMCP-H>OUT {"late":true}`;
    const text = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      `ZMCP-H>END {"rc":0,"outBytes":1,"truncated":false,"ms":1}`,
      line,
    ].join("\n");
    expectProtocolError(() => parseFluidConsole(text), line);
  });

  it("throws on a second BEGIN", () => {
    const line = `ZMCP-H>BEGIN {"id":"y","ver":"v2","action":"b","contract":"1.0"}`;
    const text = [`ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`, line].join("\n");
    expectProtocolError(() => parseFluidConsole(text), line);
  });

  it("throws when a non-BEGIN frame arrives before BEGIN", () => {
    const line = `ZMCP-H>OUT {"early":true}`;
    expectProtocolError(() => parseFluidConsole(line), line);
  });

  it("throws on an ERR with an invalid kind", () => {
    const line = `ZMCP-H>ERR {"kind":"oops","step":"S","text":"t"}`;
    expectProtocolError(
      () => parseFluidConsole(`ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}\n${line}`),
      line,
    );
  });

  it("throws when ERR's optional msgv is not an array of strings", () => {
    const line = `ZMCP-H>ERR {"kind":"message","step":"S","text":"t","msgv":["ok",5]}`;
    expectProtocolError(
      () => parseFluidConsole(`ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}\n${line}`),
      line,
    );
  });
});

describe("parseFluidConsole — a mid-stream failure is an action failure, not a protocol error", () => {
  it("drops an unterminated OUTC run and surfaces the ERR instead of throwing", () => {
    const text = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      `ZMCP-H>OUTC [1,2,`,
      `ZMCP-H>ERR {"kind":"exception","step":"S","text":"database update failed"}`,
      `ZMCP-H>END {"rc":8,"outBytes":0,"truncated":false,"ms":1}`,
    ].join("\n");

    const result = parseFluidConsole(text);

    expect(result.values).toEqual([]);
    expect(result.errors).toEqual([{ kind: "exception", step: "S", text: "database update failed" }]);
    expect(result.dropped).toEqual([{ raw: "[1,2,", lineNumber: 2 }]);
    expect(result.end).toEqual({ rc: 8, outBytes: 0, truncated: false, ms: 1 });
  });

  it("still throws on an unterminated OUTC run with no ERR present, even with an END after it", () => {
    const line = `ZMCP-H>OUTC [1,2,`;
    const text = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      line,
      `ZMCP-H>END {"rc":8,"outBytes":0,"truncated":false,"ms":1}`,
    ].join("\n");

    expectProtocolError(() => parseFluidConsole(text), line);
  });

  it("drops a reassembled OUTC/OUTE run that fails to parse as JSON when an ERR is present", () => {
    const text = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      `ZMCP-H>OUTC [1,2`,
      `ZMCP-H>OUTE ,3`,
      `ZMCP-H>ERR {"kind":"exception","step":"S","text":"boom"}`,
      `ZMCP-H>END {"rc":8,"outBytes":0,"truncated":false,"ms":1}`,
    ].join("\n");

    const result = parseFluidConsole(text);

    expect(result.values).toEqual([]);
    expect(result.errors).toEqual([{ kind: "exception", step: "S", text: "boom" }]);
    expect(result.dropped).toEqual([{ raw: "[1,2,3", lineNumber: 2 }]);
  });

  it("still throws on a reassembled OUTC/OUTE run that fails to parse as JSON with no ERR present", () => {
    const line = `ZMCP-H>OUTE ,3`;
    const text = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      `ZMCP-H>OUTC [1,2`,
      line,
    ].join("\n");

    expectProtocolError(() => parseFluidConsole(text), line);
  });
});

describe("parseFluidConsole — ERR arriving after END", () => {
  it("accepts an ERR frame after END and records it in errors", () => {
    const text = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      `ZMCP-H>END {"rc":0,"outBytes":1,"truncated":false,"ms":1}`,
      `ZMCP-H>ERR {"kind":"exception","step":"S","text":"boom"}`,
    ].join("\n");

    const result = parseFluidConsole(text);

    expect(result.end).toEqual({ rc: 0, outBytes: 1, truncated: false, ms: 1 });
    expect(result.errors).toEqual([{ kind: "exception", step: "S", text: "boom" }]);
  });

  it("still throws when OUT arrives after END", () => {
    const line = `ZMCP-H>OUT {"late":true}`;
    const text = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      `ZMCP-H>END {"rc":0,"outBytes":1,"truncated":false,"ms":1}`,
      line,
    ].join("\n");
    expectProtocolError(() => parseFluidConsole(text), line);
  });

  it("still throws when OUTC arrives after END", () => {
    const line = `ZMCP-H>OUTC [1`;
    const text = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      `ZMCP-H>END {"rc":0,"outBytes":1,"truncated":false,"ms":1}`,
      line,
    ].join("\n");
    expectProtocolError(() => parseFluidConsole(text), line);
  });

  it("still throws when a second BEGIN arrives after END", () => {
    const line = `ZMCP-H>BEGIN {"id":"y","ver":"v2","action":"b","contract":"1.0"}`;
    const text = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      `ZMCP-H>END {"rc":0,"outBytes":1,"truncated":false,"ms":1}`,
      line,
    ].join("\n");
    expectProtocolError(() => parseFluidConsole(text), line);
  });

  it("still throws on a second END", () => {
    const line = `ZMCP-H>END {"rc":1,"outBytes":1,"truncated":false,"ms":1}`;
    const text = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0"}`,
      `ZMCP-H>END {"rc":0,"outBytes":1,"truncated":false,"ms":1}`,
      line,
    ].join("\n");
    expectProtocolError(() => parseFluidConsole(text), line);
  });
});

describe("parseFluidConsole — unknown extra keys are ignored", () => {
  it("does not throw on unknown extra keys in BEGIN or END payloads", () => {
    const text = [
      `ZMCP-H>BEGIN {"id":"x","ver":"v1","action":"a","contract":"1.0","futureField":"ok"}`,
      `ZMCP-H>END {"rc":0,"outBytes":1,"truncated":false,"ms":1,"anotherFutureField":123}`,
    ].join("\n");

    const result = parseFluidConsole(text);
    expect(result.begin?.id).toBe("x");
    expect(result.end?.rc).toBe(0);
  });
});
