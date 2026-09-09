/**
 * Pure unit tests for src/adt/fluid/invoke.ts — no FakeAdtServer, no
 * network, no filesystem, no config. Covers the invoker name hash, the
 * argument chunker, the generated `IF_OO_ADT_CLASSRUN` source, and the
 * 255-char ABAP source-line guard.
 */
import { describe, expect, it } from "vitest";

import { isAbapError } from "../src/adt/errors.js";
import {
  abapArgumentChunks,
  assertAbapLineLengths,
  canonicalArgsJson,
  invokerName,
  invokerSource,
  type InvokerSourceArgs,
} from "../src/adt/fluid/invoke.js";

const VERSION = "deadbeef";
const CONTRACT = "1.0";

function baseArgs(overrides: Partial<InvokerSourceArgs> = {}): InvokerSourceArgs {
  const toolId = overrides.toolId ?? "demo_tool";
  const action = overrides.action ?? "run_it";
  const argsJson = overrides.argsJson ?? '{"a":1}';
  const contract = overrides.contract ?? CONTRACT;
  // The default name only has to be *some* valid ZCL_ZMCP_I_-shaped name;
  // it does not need to be derived from argsJson's parsed value — invoke.ts
  // never parses argsJson itself, only chunks it as an opaque string.
  const name = overrides.name ?? invokerName(toolId, action, argsJson, contract);
  return {
    entry: "ZCL_DEMO_ENTRY",
    toolId,
    action,
    argsJson,
    version: VERSION,
    contract,
    commit: false,
    ...overrides,
    name,
  };
}

function expectBadInput(fn: () => unknown): void {
  expect(fn).toThrowError();
  try {
    fn();
  } catch (e) {
    expect(isAbapError(e) && e.code).toBe("BAD_INPUT");
  }
}

describe("invokerName", () => {
  it("returns ZCL_ZMCP_I_ followed by 8 uppercase hex characters (19 chars total)", () => {
    const name = invokerName("demo_tool", "run_it", { a: 1 }, CONTRACT);
    expect(name).toMatch(/^ZCL_ZMCP_I_[0-9A-F]{8}$/);
    expect(name).toHaveLength(19);
  });

  it("is byte-stable: two calls with identical inputs produce an identical name", () => {
    const args = { a: 1, b: [1, 2, { c: "x" }] };
    const first = invokerName("demo_tool", "run_it", args, CONTRACT);
    const second = invokerName("demo_tool", "run_it", args, CONTRACT);
    expect(first).toBe(second);
  });

  it("hashes key order canonically: {a,b} and {b,a} produce the same name", () => {
    const nameAB = invokerName("demo_tool", "run_it", { a: 1, b: 2 }, CONTRACT);
    const nameBA = invokerName("demo_tool", "run_it", { b: 2, a: 1 }, CONTRACT);
    expect(nameAB).toBe(nameBA);
  });

  it("hashes key order canonically at nested depth too", () => {
    const nameOne = invokerName("demo_tool", "run_it", { outer: { a: 1, b: 2 } }, CONTRACT);
    const nameTwo = invokerName("demo_tool", "run_it", { outer: { b: 2, a: 1 } }, CONTRACT);
    expect(nameOne).toBe(nameTwo);
  });

  it("changes the name when an argument value changes", () => {
    const a = invokerName("demo_tool", "run_it", { a: 1 }, CONTRACT);
    const b = invokerName("demo_tool", "run_it", { a: 2 }, CONTRACT);
    expect(a).not.toBe(b);
  });

  it("changes the name when the action changes", () => {
    const a = invokerName("demo_tool", "run_it", { a: 1 }, CONTRACT);
    const b = invokerName("demo_tool", "run_other", { a: 1 }, CONTRACT);
    expect(a).not.toBe(b);
  });

  it("changes the name when the toolId changes", () => {
    const a = invokerName("demo_tool", "run_it", { a: 1 }, CONTRACT);
    const b = invokerName("other_tool", "run_it", { a: 1 }, CONTRACT);
    expect(a).not.toBe(b);
  });

  it("changes the name when the contract changes", () => {
    const a = invokerName("demo_tool", "run_it", { a: 1 }, "1.0");
    const b = invokerName("demo_tool", "run_it", { a: 1 }, "2.0");
    expect(a).not.toBe(b);
  });

  it("omits undefined-valued properties from the hash, matching their absence", () => {
    const withUndefined = invokerName("demo_tool", "run_it", { a: 1, b: undefined }, CONTRACT);
    const without = invokerName("demo_tool", "run_it", { a: 1 }, CONTRACT);
    expect(withUndefined).toBe(without);
  });
});

describe("canonicalArgsJson", () => {
  it("serializes objects differing only in key order, including at nested depth, identically", () => {
    const a = canonicalArgsJson({ outer: { a: 1, b: 2 }, z: 9 });
    const b = canonicalArgsJson({ z: 9, outer: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it("is exactly what invokerName consumes: equal canonicalArgsJson implies equal invokerName", () => {
    const argsOne = { outer: { a: 1, b: 2 }, z: 9 };
    const argsTwo = { z: 9, outer: { b: 2, a: 1 } };
    expect(canonicalArgsJson(argsOne)).toBe(canonicalArgsJson(argsTwo));
    expect(invokerName("demo_tool", "run_it", argsOne, CONTRACT)).toBe(
      invokerName("demo_tool", "run_it", argsTwo, CONTRACT),
    );
  });
});

describe("abapArgumentChunks", () => {
  it("returns an empty array for empty input", () => {
    expect(abapArgumentChunks("")).toEqual([]);
  });

  it("returns a single chunk for input at or under 90 characters", () => {
    const json = "x".repeat(90);
    expect(abapArgumentChunks(json)).toEqual([json]);
  });

  it("splits input over 90 characters into multiple raw chunks of at most 90 chars each", () => {
    const json = JSON.stringify({ payload: "y".repeat(500) });
    const chunks = abapArgumentChunks(json);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(90);
    }
  });

  it("concatenates chunks back to exactly the input, for arbitrary-length JSON", () => {
    const json = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => `item-${i}`) });
    const chunks = abapArgumentChunks(json);
    expect(chunks.join("")).toBe(json);
  });

  it("never lets a chunk end on a lone high surrogate", () => {
    const cases = [
      "x".repeat(88) + "\u{1F600}" + "y".repeat(20),
      "x".repeat(89) + "\u{1F600}" + "y".repeat(20),
      "x".repeat(90) + "\u{1F600}" + "y".repeat(20),
      "\u{1F600}".repeat(60),
    ];
    for (const json of cases) {
      const chunks = abapArgumentChunks(json);
      expect(chunks.join("")).toBe(json);
      for (const chunk of chunks) {
        if (chunk.length === 0) continue;
        const last = chunk.charCodeAt(chunk.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
    }
  });

  it("does not produce an empty chunk when backing off from a lone-code-unit boundary would otherwise be needed", () => {
    const json = "\u{1F600}".repeat(60);
    const chunks = abapArgumentChunks(json);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });
});

function unescapeAbapBacktickLiteral(escaped: string): string {
  return escaped.replace(/``/g, "`");
}

function rebuildFromInvokerSource(source: string): string {
  const appendLines = source
    .split("\n")
    .filter((l) => l.trim().startsWith("lv_json = lv_json && `"));
  return appendLines
    .map((l) => {
      const m = /&& `([\s\S]*)`\.$/.exec(l.trim());
      return m ? unescapeAbapBacktickLiteral(m[1]!) : "";
    })
    .join("");
}

describe("abapArgumentChunks — round-trip through invokerSource's escaping", () => {
  const cases: Record<string, string> = {
    "space exactly on a chunk boundary": `{"src":"${"x".repeat(81)} rest"}`,
    "value ending in several blanks": `{"note":"trailing blanks   "}`,
    "value that is entirely quote characters": `{"note":"${"'".repeat(120)}"}`,
    "value that is entirely backticks": `{"note":"${"`".repeat(120)}"}`,
    "astral character straddling a boundary": `{"note":"${"x".repeat(80)}\u{1F600}${"y".repeat(20)}"}`,
    "value shorter than one chunk": `{"a":1}`,
  };

  for (const [label, json] of Object.entries(cases)) {
    it(`reproduces the input exactly for: ${label}`, () => {
      const source = invokerSource(baseArgs({ argsJson: json }));
      expect(rebuildFromInvokerSource(source)).toBe(json);

      for (const chunk of abapArgumentChunks(json)) {
        if (chunk.length === 0) continue;
        const last = chunk.charCodeAt(chunk.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
    });
  }
});

describe("invokerSource — argument chunking and line-length safety", () => {
  it("keeps every generated source line at or under 255 characters for several-KB argument JSON", () => {
    const bigJson = JSON.stringify({
      rows: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `row-${i}`, note: "z".repeat(20) })),
    });
    expect(bigJson.length).toBeGreaterThan(3000);
    const source = invokerSource(baseArgs({ argsJson: bigJson }));
    for (const line of source.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(255);
    }
  });

  it("leaves single quotes inside the argument JSON unescaped in the generated source", () => {
    const json = JSON.stringify({ note: "it's a test" });
    const source = invokerSource(baseArgs({ argsJson: json }));
    expect(source).toContain("it's a test");
  });

  it("doubles backticks inside the argument JSON in the generated source", () => {
    const json = JSON.stringify({ note: "it`s a test" });
    const source = invokerSource(baseArgs({ argsJson: json }));
    expect(source).toContain("it``s a test");
  });

  it("uses backtick-quoted literals, not single-quoted ones, for the lv_json build", () => {
    const source = invokerSource(baseArgs({ argsJson: '{"a":1}' }));
    expect(source).toContain("lv_json = lv_json && `");
    expect(source).not.toMatch(/lv_json = lv_json && '/);
  });

  it("keeps every line under 255 characters when the argument JSON is entirely single quotes", () => {
    const json = "'".repeat(500);
    const source = invokerSource(baseArgs({ argsJson: json }));
    for (const line of source.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(255);
    }
  });

  it("keeps every line under 255 characters, worst case, when the argument JSON is entirely backticks", () => {
    const json = "`".repeat(500);
    const source = invokerSource(baseArgs({ argsJson: json }));
    let sawFullChunkLine = false;
    for (const line of source.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(255);
      if (line.trim().startsWith("lv_json = lv_json && `") && line.includes("`".repeat(180))) {
        sawFullChunkLine = true;
      }
    }
    expect(sawFullChunkLine).toBe(true);
  });

  it("does not silently drop a trailing space that lands on a chunk boundary", () => {
    const json = canonicalArgsJson({ src: "x".repeat(81) + " rest" });
    expect(json[89]).toBe(" ");
    const source = invokerSource(baseArgs({ argsJson: json }));
    expect(rebuildFromInvokerSource(source)).toBe(json);
  });

  it("produces a source whose lv_json build, once concatenated and unescaped, equals the input JSON", () => {
    const json = JSON.stringify({ a: "x'y`z", b: [1, 2, 3] });
    const source = invokerSource(baseArgs({ argsJson: json }));
    expect(rebuildFromInvokerSource(source)).toBe(json);
  });
});

describe("invokerSource — determinism", () => {
  it("produces byte-identical source across two calls with identical arguments", () => {
    const args = baseArgs({ argsJson: '{"a":1,"b":"two"}' });
    expect(invokerSource(args)).toBe(invokerSource(args));
  });
});

describe("invokerSource — manifest version", () => {
  it("reuses the same invoker name across two different version values, with the source differing", () => {
    const args = baseArgs({ version: "aaaaaaaa" });
    const sourceV1 = invokerSource(args);
    const sourceV2 = invokerSource({ ...args, version: "bbbbbbbb" });
    expect(sourceV1).not.toBe(sourceV2);
    expect(sourceV1).toContain("iv_ver = 'aaaaaaaa'");
    expect(sourceV2).toContain("iv_ver = 'bbbbbbbb'");
  });
});

describe("invokerSource — commit", () => {
  it("emits COMMIT WORK AND WAIT and ROLLBACK WORK when commit is true", () => {
    const source = invokerSource(baseArgs({ commit: true }));
    expect(source).toContain("COMMIT WORK AND WAIT.");
    expect(source).toContain("ROLLBACK WORK.");
  });

  it("emits neither COMMIT nor ROLLBACK when commit is false", () => {
    const source = invokerSource(baseArgs({ commit: false }));
    expect(source).not.toContain("COMMIT WORK");
    expect(source).not.toContain("ROLLBACK WORK");
  });
});

describe("invokerSource — exception wrapper", () => {
  it("wraps the body call in TRY/CATCH cx_root INTO DATA(lx_err), in that order", () => {
    const source = invokerSource(baseArgs());
    const tryIndex = source.indexOf("TRY.");
    const bodyCallIndex = source.indexOf("=>run( iv_action = ");
    const catchIndex = source.indexOf("CATCH cx_root INTO DATA(lx_err).");
    expect(tryIndex).toBeGreaterThan(-1);
    expect(bodyCallIndex).toBeGreaterThan(-1);
    expect(catchIndex).toBeGreaterThan(-1);
    expect(tryIndex).toBeLessThan(bodyCallIndex);
    expect(bodyCallIndex).toBeLessThan(catchIndex);
  });

  it("the CATCH arm emits an err( ) frame carrying lx_err->get_text( ) before end( 8 )", () => {
    const source = invokerSource(baseArgs({ action: "run_it" }));
    const catchIndex = source.indexOf("CATCH cx_root INTO DATA(lx_err).");
    const errIndex = source.indexOf(
      "zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'run_it' iv_text = lx_err->get_text( ) ).",
    );
    const end8Index = source.indexOf("zcl_zmcp_fluid_rt=>end( 8 ).");
    expect(catchIndex).toBeGreaterThan(-1);
    expect(errIndex).toBeGreaterThan(-1);
    expect(end8Index).toBeGreaterThan(-1);
    expect(catchIndex).toBeLessThan(errIndex);
    expect(errIndex).toBeLessThan(end8Index);
  });
});

describe("invokerSource — success-path END safety net", () => {
  it("emits a final end( 0 ) after the commit lines for a mutate action", () => {
    const source = invokerSource(baseArgs({ commit: true }));
    const endifIndex = source.lastIndexOf("ENDIF.");
    const finalEndIndex = source.lastIndexOf("zcl_zmcp_fluid_rt=>end( 0 ).");
    expect(endifIndex).toBeGreaterThan(-1);
    expect(finalEndIndex).toBeGreaterThan(-1);
    expect(finalEndIndex).toBeGreaterThan(endifIndex);
    const endmethodIndex = source.indexOf("ENDMETHOD.");
    expect(finalEndIndex).toBeLessThan(endmethodIndex);
  });

  it("still ends the frame with end( 0 ) for a non-mutate action", () => {
    const source = invokerSource(baseArgs({ commit: false }));
    const endtryIndex = source.lastIndexOf("ENDTRY.");
    const finalEndIndex = source.lastIndexOf("zcl_zmcp_fluid_rt=>end( 0 ).");
    expect(endtryIndex).toBeGreaterThan(-1);
    expect(finalEndIndex).toBeGreaterThan(-1);
    expect(finalEndIndex).toBeGreaterThan(endtryIndex);
  });

  it("keeps the catch arm's end( 8 ) intact alongside the success-path end( 0 )", () => {
    const source = invokerSource(baseArgs({ commit: false }));
    expect(source).toContain("zcl_zmcp_fluid_rt=>end( 8 ).");
    expect(source).toContain("zcl_zmcp_fluid_rt=>end( 0 ).");
  });
});

describe("invokerSource — dispatch shape", () => {
  it("contains the attach call with the exact version and contract passed", () => {
    const source = invokerSource(baseArgs({ version: "cafebabe", contract: "3.7" }));
    expect(source).toContain("zcl_zmcp_fluid_rt=>attach( io_out = out iv_ver = 'cafebabe' iv_contract = '3.7' ).");
  });

  it("calls <entry>=>run( with the action, entry lower-cased", () => {
    const source = invokerSource(baseArgs({ entry: "ZCL_MY_ENTRY", action: "do_thing" }));
    expect(source).toContain("zcl_my_entry=>run( iv_action = 'do_thing' iv_json = lv_json ).");
  });

  it("is a PUBLIC FINAL CREATE PUBLIC class implementing if_oo_adt_classrun", () => {
    const source = invokerSource(baseArgs());
    expect(source).toContain("PUBLIC FINAL");
    expect(source).toContain("CREATE PUBLIC.");
    expect(source).toContain("INTERFACES if_oo_adt_classrun.");
    expect(source).toContain("METHOD if_oo_adt_classrun~main.");
  });
});

describe("invokerSource — begin frame", () => {
  it("opens the frame with begin( ) before entering TRY, so a pre-TRY throw is never framed", () => {
    const source = invokerSource(baseArgs({ toolId: "demo_tool", action: "run_it" }));
    const beginIndex = source.indexOf("zcl_zmcp_fluid_rt=>begin(");
    const tryIndex = source.indexOf("TRY.");
    expect(beginIndex).toBeGreaterThan(-1);
    expect(tryIndex).toBeGreaterThan(-1);
    expect(beginIndex).toBeLessThan(tryIndex);
  });

  it("emits begin( ) ahead of the CATCH arm's err( ) call, so ERR is never sent without a BEGIN", () => {
    const source = invokerSource(baseArgs({ toolId: "demo_tool", action: "run_it" }));
    const beginIndex = source.indexOf("zcl_zmcp_fluid_rt=>begin(");
    const errIndex = source.indexOf("zcl_zmcp_fluid_rt=>err(");
    expect(beginIndex).toBeGreaterThan(-1);
    expect(errIndex).toBeGreaterThan(-1);
    expect(beginIndex).toBeLessThan(errIndex);
  });

  it("passes the toolId and action through to begin( )'s iv_id and iv_action", () => {
    const source = invokerSource(baseArgs({ toolId: "customer_lookup", action: "get_customer" }));
    expect(source).toContain("zcl_zmcp_fluid_rt=>begin( iv_id = 'customer_lookup' iv_action = 'get_customer' ).");
  });
});

describe("invokerSource — empty argsJson", () => {
  it("emits CLEAR lv_json. with no concatenation lines, still under the line limit", () => {
    const source = invokerSource(baseArgs({ argsJson: "" }));
    expect(source).toContain("CLEAR lv_json.");
    expect(source).not.toContain("lv_json = lv_json &&");
    for (const line of source.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(255);
    }
  });
});

describe("invokerSource — input validation", () => {
  it("rejects a name that is not a plain ABAP name", () => {
    expectBadInput(() => invokerSource(baseArgs({ name: "ZFOO. DELETE FROM t" })));
  });

  it("rejects a plain-ABAP-name that does not match the ZCL_ZMCP_I_-plus-8-hex shape", () => {
    expectBadInput(() => invokerSource(baseArgs({ name: "ZCL_ZMCP_I_NOTHEX1" })));
  });

  it("rejects an entry that is not a plain ABAP name", () => {
    expectBadInput(() => invokerSource(baseArgs({ entry: "ZFOO. LEAVE PROGRAM" })));
  });

  it("rejects an action containing a single quote", () => {
    expectBadInput(() => invokerSource(baseArgs({ action: "run_it'; DELETE" })));
  });

  it("rejects a toolId containing a newline", () => {
    expectBadInput(() => invokerSource(baseArgs({ toolId: "demo\ntool" })));
  });

  it("rejects a version that is not 8 lowercase hex characters", () => {
    expectBadInput(() => invokerSource(baseArgs({ version: "DEADBEEF" })));
    expectBadInput(() => invokerSource(baseArgs({ version: "abc" })));
  });

  it("rejects a contract not matching digits.digits", () => {
    expectBadInput(() => invokerSource(baseArgs({ contract: "v1.0" })));
    expectBadInput(() => invokerSource(baseArgs({ contract: "1" })));
  });
});

describe("assertAbapLineLengths", () => {
  it("throws BAD_INPUT naming the 1-based line number for a 256-char line", () => {
    const source = ["short line", "x".repeat(256), "another short line"].join("\n");
    expect(() => assertAbapLineLengths(source)).toThrowError();
    try {
      assertAbapLineLengths(source);
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("BAD_INPUT");
      expect(isAbapError(e) && e.details["line"]).toBe(2);
      expect(isAbapError(e) && e.details["length"]).toBe(256);
    }
  });

  it("passes for a 255-char line (the boundary)", () => {
    const source = ["short line", "x".repeat(255), "another short line"].join("\n");
    expect(() => assertAbapLineLengths(source)).not.toThrow();
  });
});
