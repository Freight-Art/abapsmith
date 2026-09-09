/**
 * Pure unit tests for the built-in fluid runtime class: no FakeAdtServer, no
 * network, no filesystem. Covers the manifest shape, the embedded ABAP
 * source's structural invariants, and the built-in registration barrel.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_FLUID_TOOLS } from "../src/adt/fluid/builtin/index.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeManifest, fluidRuntimeSources, fluidRuntimeTool } from "../src/adt/fluid/abap/runtime.js";
import { FluidManifestSchema, manifestVersion } from "../src/adt/fluid/manifest.js";

describe("fluidRuntimeManifest", () => {
  it("parses unchanged through FluidManifestSchema", () => {
    const result = FluidManifestSchema.safeParse(fluidRuntimeManifest);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual(fluidRuntimeManifest);
  });

  it("has an object description of at most 60 characters", () => {
    const description = fluidRuntimeManifest.objects[0]?.description ?? "";
    expect(description.length).toBeLessThanOrEqual(60);
  });

  it("has an id matching the fluid tool id pattern", () => {
    expect(fluidRuntimeManifest.id).toMatch(/^[a-z][a-z0-9_]{0,11}$/);
  });

  it("is marked internal: it is framework plumbing shared by generated tools, not itself a tool callers should be routed to", () => {
    expect(fluidRuntimeManifest.internal).toBe(true);
  });
});

describe("fluidRuntimeSources", () => {
  it("has exactly one entry keyed by FLUID_RUNTIME_CLASS with non-empty source", () => {
    expect(fluidRuntimeSources.size).toBe(1);
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS);
    expect(source).toBeDefined();
    expect(source ?? "").not.toHaveLength(0);
  });

  it("has no line longer than 255 characters", () => {
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    const lines = source.split("\n");
    lines.forEach((line, i) => {
      expect(line.length, `line ${i + 1} is ${line.length} chars: ${line}`).toBeLessThanOrEqual(255);
    });
  });

  it("ends with a trailing newline", () => {
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    expect(source.endsWith("\n")).toBe(true);
  });

  it("declares the class named by FLUID_RUNTIME_CLASS, case-insensitively", () => {
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    const re = new RegExp(`CLASS\\s+${FLUID_RUNTIME_CLASS}\\s+DEFINITION`, "i");
    expect(re.test(source)).toBe(true);
  });

  const requiredMethods = [
    "attach",
    "begin",
    "out",
    "out_chunk",
    "err",
    "end",
    "failed",
    "esc",
    "scan",
    "s",
    "b",
    "n",
    "run",
  ];

  it("defines every required method in both the definition and implementation halves", () => {
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    const parts = source.split("IMPLEMENTATION.");
    expect(parts).toHaveLength(2);
    const [definition, implementation] = parts as [string, string];
    for (const name of requiredMethods) {
      expect(definition.toLowerCase(), `${name} missing from definition half`).toContain(name);
      expect(implementation.toLowerCase(), `${name} missing from implementation half`).toContain(name);
    }
  });

  const frameNames = ["BEGIN", "OUT ", "OUTC", "OUTE", "ERR", "END"];

  it("emits all six frame names alongside the ZMCP-H> prefix constant", () => {
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    expect(source).toContain("ZMCP-H>");
    for (const frame of frameNames) {
      expect(source, `frame ${JSON.stringify(frame)} missing`).toContain(frame);
    }
  });

  it("never submits programs, calls transactions, or commits/rolls back work", () => {
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    expect(source).not.toMatch(/\bSUBMIT\b/);
    expect(source).not.toMatch(/\bCALL TRANSACTION\b/);
    expect(source).not.toMatch(/\bCOMMIT WORK\b/);
    expect(source).not.toMatch(/\bROLLBACK WORK\b/);
  });
});

describe("fluidRuntimeTool.origin", () => {
  it("is builtin, since it ships with abapsmith rather than a workspace plugin", () => {
    expect(fluidRuntimeTool.origin).toBe("builtin");
  });
});

describe("fluidRuntimeTool.version", () => {
  it("is 8 lowercase hex characters equal to manifestVersion(manifest, sources)", () => {
    expect(fluidRuntimeTool.version).toMatch(/^[0-9a-f]{8}$/);
    expect(fluidRuntimeTool.version).toBe(manifestVersion(fluidRuntimeManifest, fluidRuntimeSources));
  });

  // Pinned literal: a deliberate source edit changes this hash on purpose, and
  // the test must be updated deliberately alongside it — not silently pass.
  it("is pinned to the deployed runtime source's current hash", () => {
    expect(fluidRuntimeTool.version).toBe("134ccf5b");
  });
});

function methodBody(source: string, name: string): string {
  const re = new RegExp(`METHOD ${name}\\.[\\s\\S]*?ENDMETHOD\\.`);
  return source.match(re)?.[0] ?? "";
}

describe("begin() idempotency guard", () => {
  it("declares gv_begun and returns early from begin when already set", () => {
    // the invoker opens BEGIN before its TRY; the body class's own begin( )
    // must be a no-op so a pre-BEGIN throw still yields ERR after a BEGIN.
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    expect(source).toContain("CLASS-DATA gv_begun");
    expect(methodBody(source, "begin")).toMatch(/IF gv_begun = abap_true\.\s*RETURN\.\s*ENDIF\./);
  });
});

describe("split() trailing-blank guard (fix 1)", () => {
  it("backs off a fragment ending on a blank, but takes an all-blank window whole", () => {
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    const body = methodBody(source, "split");
    expect(body).toMatch(/WHILE lv_take > 1 AND substring\([\s\S]*?\) = ` `\./);
    expect(body).toMatch(/IF lv_take = 1 AND substring\([\s\S]*?\) = ` `\.\s*lv_take = lv_full\./);
  });

  // source-shape pin only: a single-quoted ' ' text-field literal compared
  // against a string operand converts to string and loses its trailing blank,
  // so the guard above would silently never fire — only a live run proves it.
  it("compares the all-blank recovery check against a backtick string literal, not a single-quoted one", () => {
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    const body = methodBody(source, "split");
    expect(body).not.toMatch(/IF lv_take = 1 AND substring\([\s\S]*?\) = ' '\./);
  });

  it("routes out_chunk through split() instead of emitting the fragment directly", () => {
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    const body = methodBody(source, "out_chunk");
    expect(body).not.toMatch(/emit\(\s*\|\{ c_prefix \}OUTC/);
    expect(body).toMatch(/split\(\s*iv_json = iv_json\s+iv_frame = 'OUTC'\s*\)\./);
  });
});

describe("esc() lone-CR escaping (fix 2)", () => {
  it("escapes a lone CR as \\r via the cr_lf constant, after the CRLF/LF/TAB replacements", () => {
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    const body = methodBody(source, "esc");
    expect(body).toContain("lv_crlf = cl_abap_char_utilities=>cr_lf.");
    expect(body).toContain("lv_cr = lv_crlf(1).");
    expect(body).toContain("WITH '\\r'.");
    const crLfIdx = body.indexOf("cl_abap_char_utilities=>cr_lf IN rv_text");
    const crIdx = body.indexOf("REPLACE ALL OCCURRENCES OF lv_cr IN rv_text WITH '\\r'.");
    const tabIdx = body.indexOf("cl_abap_char_utilities=>horizontal_tab");
    expect(crLfIdx).toBeGreaterThan(-1);
    expect(crIdx).toBeGreaterThan(crLfIdx);
    expect(tabIdx).toBeGreaterThan(crIdx);
  });

  it("never assigns a TYPE x field into a TYPE c field within esc() itself (hex-display corruption, not byte reinterpretation)", () => {
    // read_string()'s \uXXXX decoding legitimately declares a TYPE x buffer
    // (mirroring classic/abap-core.ts); esc()'s own CR fix must not.
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    expect(methodBody(source, "esc")).not.toMatch(/TYPE x LENGTH \d+/);
  });
});

describe("end() idempotency guard (fix 3)", () => {
  it("declares gv_ended and returns early on a second end() call", () => {
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    expect(source).toContain("CLASS-DATA gv_ended");
    const body = methodBody(source, "end");
    expect(body).toMatch(/IF gv_ended = abap_true\.\s*RETURN\.\s*ENDIF\./);
    expect(body).toContain("gv_ended = abap_true.");
  });

  it("leaves failed()/rollback semantics untouched: gv_errors is still incremented by err() independently of the END guard", () => {
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    expect(methodBody(source, "failed")).toContain("gv_errors > 0");
    expect(methodBody(source, "err")).toContain("gv_errors = gv_errors + 1.");
  });
});

describe("attach() re-attach safety (fix 4)", () => {
  it("only resets gv_begun/gv_ended when no frame is currently open", () => {
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    const body = methodBody(source, "attach");
    expect(body).toMatch(/IF gv_begun = abap_false OR gv_ended = abap_true\./);
    expect(body).not.toMatch(/gv_contract = iv_contract\.\s*gv_begun\s*=\s*abap_false\./);
  });

  // source-shape pin only: proves gv_errors sits inside the same conditional as
  // gv_begun/gv_ended, not that a re-attach preserves it at runtime (untestable offline).
  it("keeps all per-run resets, including gv_errors, inside the same conditional as gv_begun/gv_ended", () => {
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    const body = methodBody(source, "attach");
    const ifMatch = body.match(/IF gv_begun = abap_false OR gv_ended = abap_true\.([\s\S]*?)ENDIF\./);
    expect(ifMatch).not.toBeNull();
    const guarded = ifMatch ? ifMatch[1] : "";
    expect(guarded).toContain("gv_open");
    expect(guarded).toContain("gv_bytes");
    expect(guarded).toContain("gv_errors");
    expect(guarded).toContain("GET RUN TIME FIELD gv_t0.");
    expect(body.slice((ifMatch ? body.indexOf(ifMatch[0]) + ifMatch[0].length : 0))).not.toMatch(/gv_errors\s*=\s*0\./);
  });
});

describe("err() kind normalization (fix 5)", () => {
  it("lower-cases iv_kind and falls back to exception for an unrecognised kind", () => {
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    const body = methodBody(source, "err");
    expect(body).toMatch(/TRANSLATE lv_kind TO LOWER CASE\./);
    expect(body).toMatch(/lv_kind <> 'subrc' AND lv_kind <> 'exception' AND lv_kind <> 'message'/);
    expect(body).toContain("lv_kind = 'exception'.");
  });
});

describe("out()/out_chunk() control-channel injection guard (fix 6)", () => {
  it("refuses a payload containing CR or LF via has_break and reports it as an ERR instead", () => {
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    expect(source).toMatch(/METHOD has_break\.[\s\S]*?ENDMETHOD\./);
    const outBody = methodBody(source, "out");
    const chunkBody = methodBody(source, "out_chunk");
    expect(outBody).toMatch(/IF has_break\( iv_json \) = abap_true\./);
    expect(chunkBody).toMatch(/IF has_break\( iv_json \) = abap_true\./);
    expect(outBody).toMatch(/err\(\s*iv_kind = 'message'/);
    expect(chunkBody).toMatch(/err\(\s*iv_kind = 'message'/);
  });

  it("tests has_break against the cr_lf constant, not a locally constructed character", () => {
    const source = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    const body = methodBody(source, "has_break");
    expect(body).toContain("IF iv_json CA cl_abap_char_utilities=>cr_lf.");
  });
});

describe("BUILTIN_FLUID_TOOLS", () => {
  it("ships the framework runtime exactly once", () => {
    const runtime = BUILTIN_FLUID_TOOLS.filter((t) => t.manifest === fluidRuntimeManifest);
    expect(runtime).toHaveLength(1);
    expect(runtime[0]?.sources).toBe(fluidRuntimeSources);
  });

  it("has unique, sorted tool ids", () => {
    const ids = BUILTIN_FLUID_TOOLS.map((t) => t.manifest.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("fluidRuntimeManifest actions", () => {
  it("declares both ping and fail actions with valid names", () => {
    const names = fluidRuntimeManifest.actions.map((a) => a.name);
    expect(names).toContain("ping");
    expect(names).toContain("fail");
    for (const action of fluidRuntimeManifest.actions) {
      expect(action.name).toMatch(/^[a-z][a-z0-9_]{0,29}$/);
    }
  });

  it("ping's output schema requires pong and ver", () => {
    const ping = fluidRuntimeManifest.actions.find((a) => a.name === "ping");
    expect(ping).toBeDefined();
    expect(ping?.output.required).toEqual(expect.arrayContaining(["pong", "ver"]));
  });
});
