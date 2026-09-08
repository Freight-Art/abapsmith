import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  reviewFluidAbap,
  FLUID_ABAP_LINE_MAX,
  FLUID_SHIPPED_PROHIBITIONS,
} from "../src/adt/fluid/static-review.js";
import { ECHO_LINE_MAX, isTruncated } from "../src/truncate.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fluid-plugins");
const OBJ = "ZCL_ZMCP_X_TEST";

describe("FLUID_SHIPPED_PROHIBITIONS", () => {
  it("names all seven shipped rules, in order", () => {
    expect(FLUID_SHIPPED_PROHIBITIONS).toEqual([
      "call-system",
      "exec-sql",
      "insert-report",
      "generate-subroutine-pool",
      "call-function-destination",
      "submit-via-job",
      "dynamic-call-method",
    ]);
  });
});

describe("call-system", () => {
  it("fires on CALL 'SYSTEM'", () => {
    const findings = reviewFluidAbap(OBJ, "CALL 'SYSTEM'.");
    expect(findings).toEqual([
      { object: OBJ, line: 1, rule: "call-system", text: "CALL 'SYSTEM'" },
    ]);
  });

  it("does not fire on an identifier that merely contains call and system", () => {
    const findings = reviewFluidAbap(OBJ, "DATA lv_call_system TYPE string.");
    expect(findings).toEqual([]);
  });
});

describe("exec-sql", () => {
  it("fires on EXEC SQL", () => {
    const findings = reviewFluidAbap(OBJ, "EXEC SQL.");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("exec-sql");
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.text).toContain("EXEC SQL");
  });

  it("does not fire on a variable named lv_exec_sql", () => {
    const findings = reviewFluidAbap(OBJ, "DATA lv_exec_sql TYPE string.");
    expect(findings).toEqual([]);
  });
});

describe("insert-report", () => {
  it("fires on INSERT REPORT", () => {
    const findings = reviewFluidAbap(OBJ, "INSERT REPORT lv_name FROM lt_source.");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("insert-report");
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.text).toContain("INSERT REPORT");
  });

  it("does not fire on a plain INSERT", () => {
    const findings = reviewFluidAbap(OBJ, "INSERT ztable FROM TABLE lt_data.");
    expect(findings).toEqual([]);
  });
});

describe("generate-subroutine-pool", () => {
  it("fires on GENERATE SUBROUTINE POOL", () => {
    const findings = reviewFluidAbap(OBJ, "GENERATE SUBROUTINE POOL lt_source NAME lv_name.");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("generate-subroutine-pool");
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.text).toContain("GENERATE SUBROUTINE POOL");
  });

  it("does not fire on an identifier that merely contains the phrase", () => {
    const findings = reviewFluidAbap(OBJ, "DATA lv_generate_subroutine_pool TYPE string.");
    expect(findings).toEqual([]);
  });
});

describe("call-function-destination", () => {
  it("fires on a CALL FUNCTION statement that also carries DESTINATION", () => {
    const findings = reviewFluidAbap(OBJ, "CALL FUNCTION 'Z_RFC' DESTINATION 'RFC_DEST'.");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("call-function-destination");
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.text).toContain("DESTINATION");
  });

  it("does not fire on a plain CALL FUNCTION", () => {
    const findings = reviewFluidAbap(OBJ, "CALL FUNCTION 'Z_RFC'.");
    expect(findings).toEqual([]);
  });

  it("catches DESTINATION on the line after CALL FUNCTION, reporting the statement's first line", () => {
    const source = "CALL FUNCTION 'Z_RFC'\n  DESTINATION 'RFC_DEST'.";
    const findings = reviewFluidAbap(OBJ, source);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("call-function-destination");
    expect(findings[0]?.line).toBe(1);
  });
});

describe("submit-via-job", () => {
  it("fires on a SUBMIT statement that also carries VIA JOB", () => {
    const findings = reviewFluidAbap(OBJ, "SUBMIT zprogram VIA JOB 'JOBNAME' NUMBER lv_jobcount.");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("submit-via-job");
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.text).toContain("VIA JOB");
  });

  it("does not fire on a plain SUBMIT, nor on an identifier like MY_SUBMIT", () => {
    const findings = reviewFluidAbap(OBJ, "SUBMIT zprogram.\nDATA lv_my_submit TYPE string.");
    expect(findings).toEqual([]);
  });

  it("catches VIA JOB on the line after SUBMIT, reporting the statement's first line", () => {
    const source = "SUBMIT zprogram\n  VIA JOB 'JOBNAME' NUMBER lv_jobcount.";
    const findings = reviewFluidAbap(OBJ, source);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("submit-via-job");
    expect(findings[0]?.line).toBe(1);
  });
});

describe("dynamic-call-method", () => {
  it("fires on CALL METHOD (...)=>(...) and on CALL METHOD ref->(...)", () => {
    const direct = reviewFluidAbap(OBJ, "CALL METHOD (lv_class)=>(lv_meth).");
    expect(direct).toHaveLength(1);
    expect(direct[0]?.rule).toBe("dynamic-call-method");
    expect(direct[0]?.line).toBe(1);

    const viaRef = reviewFluidAbap(OBJ, "CALL METHOD lo_ref->(lv_meth).");
    expect(viaRef).toHaveLength(1);
    expect(viaRef[0]?.rule).toBe("dynamic-call-method");
    expect(viaRef[0]?.line).toBe(1);
  });

  it("does not fire on an ordinary static method call", () => {
    const findings = reviewFluidAbap(OBJ, "CALL METHOD go_obj->do_something( iv_x = 1 ).");
    expect(findings).toEqual([]);
  });
});

describe("line-length", () => {
  it("does not flag a line of exactly the maximum length", () => {
    expect(FLUID_ABAP_LINE_MAX).toBe(255);
    const line = "A".repeat(FLUID_ABAP_LINE_MAX);
    const findings = reviewFluidAbap(OBJ, line);
    expect(findings).toEqual([]);
  });

  it("flags a line one character over the maximum, exactly once, with the right line number", () => {
    const line = "A".repeat(FLUID_ABAP_LINE_MAX + 1);
    const findings = reviewFluidAbap(OBJ, line);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("line-length");
    expect(findings[0]?.line).toBe(1);
    // The line (256 chars) exceeds ECHO_LINE_MAX (160), so the excerpt
    // itself is truncated by the shared, disclosed helper.
    expect(isTruncated(findings[0]?.text ?? "")).toBe(true);
    expect(findings[0]?.text.startsWith("A".repeat(ECHO_LINE_MAX))).toBe(true);
    expect(findings[0]?.text).toContain(`${ECHO_LINE_MAX} of ${line.length} chars shown`);
  });
});

describe("excerpt truncation (src/truncate.ts)", () => {
  it("an excerpt under ECHO_LINE_MAX comes back untruncated and unmarked", () => {
    const findings = reviewFluidAbap(OBJ, "EXEC SQL.");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.text).toBe("EXEC SQL");
    expect(isTruncated(findings[0]?.text ?? "")).toBe(false);
  });

  it("an excerpt over ECHO_LINE_MAX is truncated with a disclosed marker naming the real total length", () => {
    const tail = "A".repeat(ECHO_LINE_MAX + 50);
    const statement = `DATA(lv_x) = 'exec sql ${tail}'`;
    const findings = reviewFluidAbap(OBJ, `${statement}.`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("exec-sql");
    const normalized = statement.replace(/\s+/g, " ").trim();
    expect(findings[0]?.text.startsWith(normalized.slice(0, ECHO_LINE_MAX))).toBe(true);
    expect(isTruncated(findings[0]?.text ?? "")).toBe(true);
    expect(findings[0]?.text).toContain(`${ECHO_LINE_MAX} of ${normalized.length} chars shown`);
  });
});

describe("comment handling", () => {
  it("a full-line * comment mentioning a prohibited phrase produces no prohibition finding", () => {
    const findings = reviewFluidAbap(OBJ, "* this comment mentions EXEC SQL");
    expect(findings).toEqual([]);
  });

  it("a full-line \" comment mentioning a prohibited phrase produces no prohibition finding", () => {
    const findings = reviewFluidAbap(OBJ, '  " this comment mentions EXEC SQL');
    expect(findings).toEqual([]);
  });

  it("a 300-character full-line comment is still blanked for prohibitions but still trips line-length", () => {
    const line = "*" + "A".repeat(300);
    const findings = reviewFluidAbap(OBJ, line);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("line-length");
    expect(findings[0]?.line).toBe(1);
  });
});

describe("statement splitting across a string literal", () => {
  // The splitter correctly treats this as ONE statement (a period inside a
  // '...' literal never ends it early) — proven below by the reported text
  // spanning the whole statement, not just the fragment around EXEC SQL.
  // The literal's own text still contains "EXEC SQL", though, so exec-sql
  // still fires: this is the documented over-approximation of a lint that
  // does not parse ABAP string content, not a splitter bug.
  it("keeps the statement whole, but still matches the literal keyword text inside it (known over-approximation)", () => {
    const findings = reviewFluidAbap(OBJ, "DATA(lv_x) = 'a. EXEC SQL. b'.");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("exec-sql");
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.text).toContain("DATA(lv_x)");
    expect(findings[0]?.text).toContain("b'");
  });
});

describe("extraProhibitions", () => {
  it("is additive: an operator phrase and a shipped rule both fire on the same source", () => {
    const source = "COMMIT WORK.\nEXEC SQL.";
    const findings = reviewFluidAbap(OBJ, source, ["COMMIT WORK"]);
    expect(findings).toEqual([
      { object: OBJ, line: 1, rule: "extra:COMMIT WORK", text: "COMMIT WORK" },
      { object: OBJ, line: 2, rule: "exec-sql", text: "EXEC SQL" },
    ]);
  });

  it("cannot disable a shipped rule by naming it as an extra phrase", () => {
    const findings = reviewFluidAbap(OBJ, "EXEC SQL.", ["exec-sql"]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("exec-sql");
    expect(findings[0]?.line).toBe(1);
  });
});

describe("hello fixture", () => {
  it("reviews clean — the documented body-class skeleton is not itself rejected", async () => {
    const source = await readFile(join(FIXTURES, "hello", "abap", "zcl_zmcp_x_hello.abap"), "utf8");
    const findings = reviewFluidAbap("ZCL_ZMCP_X_HELLO", source);
    expect(findings).toEqual([]);
  });
});

describe("trailing comments", () => {
  it("an apostrophe inside a trailing \" comment does not swallow the rest of the file", () => {
    const source = "DATA lv_x TYPE i. \" it's fine\nEXEC SQL.";
    const findings = reviewFluidAbap(OBJ, source);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("exec-sql");
    expect(findings[0]?.line).toBe(2);
  });

  it("a trailing comment that merely mentions a prohibited phrase produces no finding", () => {
    const source = "DATA lv_x TYPE i. \" see EXEC SQL docs";
    const findings = reviewFluidAbap(OBJ, source);
    expect(findings).toEqual([]);
  });

  it("an apostrophe inside a string template does not open an unterminated string literal", () => {
    const source = "DATA(lv_msg) = |it's { lv_x }|.\nEXEC SQL.";
    const findings = reviewFluidAbap(OBJ, source);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("exec-sql");
    expect(findings[0]?.line).toBe(2);
  });

  it("a double quote inside a '...' string literal is data, not a comment start", () => {
    const source = "zcl_zmcp_fluid_rt=>out( '{\"reply\":\"pong\"}' ).\nEXEC SQL.";
    const findings = reviewFluidAbap(OBJ, source);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("exec-sql");
    expect(findings[0]?.line).toBe(2);
  });
});

describe("ordering", () => {
  it("returns findings in ascending line order even when a later line is scanned first", () => {
    const source = "EXEC SQL.\n" + "A".repeat(FLUID_ABAP_LINE_MAX + 1);
    const findings = reviewFluidAbap(OBJ, source);
    expect(findings).toHaveLength(2);
    expect(findings[0]?.rule).toBe("exec-sql");
    expect(findings[0]?.line).toBe(1);
    expect(findings[1]?.rule).toBe("line-length");
    expect(findings[1]?.line).toBe(2);
  });
});
