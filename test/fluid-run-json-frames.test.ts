/**
 * Covers the "run" builtin's OUT-frame emission end to end: a captured list
 * line must go on the wire as a valid JSON string, since protocol.ts feeds
 * every OUT payload to JSON.parse. Also pins the ABAP source shape (no
 * FIND REGEX, calls scan()/s()/esc()) and the manifest/runSources wiring of
 * ZCL_ZMCP_FLUID_RT alongside ZCL_ZMCP_FLUID_RUN.
 */
import { describe, expect, it } from "vitest";
import { AbapError } from "../src/adt/errors.js";
import { parseFluidConsole } from "../src/adt/fluid/protocol.js";
import { runManifest, runSources } from "../src/adt/fluid/builtin/run.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeSources } from "../src/adt/fluid/abap/runtime.js";
import { FLUID_ABAP_LINE_MAX, reviewFluidAbap } from "../src/adt/fluid/static-review.js";
import { FluidManifestSchema } from "../src/adt/fluid/manifest.js";

// Mirrors ZCL_ZMCP_FLUID_RT's esc() method exactly: backslash, double quote,
// CRLF/LF, lone CR, then tab. Order matters the same way it does in ABAP.
function esc(text: string): string {
  let out = text;
  out = out.replace(/\\/g, "\\\\");
  out = out.replace(/"/g, '\\"');
  out = out.replace(/\r\n/g, "\\n");
  out = out.replace(/\n/g, "\\n");
  out = out.replace(/\r/g, "\\r");
  out = out.replace(/\t/g, "\\t");
  return out;
}

describe("run tool OUT frames carry valid JSON (esc-wrapped list lines)", () => {
  it("round-trips a captured list with a quote, a backslash and a tab through parseFluidConsole", () => {
    const listLines = [
      'ABC  100   Foo "bar"',
      "C:\\usr\\sap\\trans",
      "col1\tcol2\tcol3",
      "plain line, nothing special",
    ];

    const lines = [
      `ZMCP-H>BEGIN {"id":"run","ver":"a1b2c3d4","action":"report","contract":"1.0"}`,
      ...listLines.map((line) => `ZMCP-H>OUT "${esc(line)}"`),
      `ZMCP-H>END {"rc":0,"outBytes":1,"truncated":false,"ms":1}`,
    ];

    const transcript = parseFluidConsole(lines.join("\n"));

    expect(transcript.errors).toEqual([]);
    expect(transcript.stray).toEqual([]);
    expect(transcript.values).toEqual(listLines);
  });
});

describe("run tool ABAP source: JSON-valid OUT emission, no regex", () => {
  it("emits each list line through esc() inside a JSON string literal", () => {
    const source = runSources.get("ZCL_ZMCP_FLUID_RUN") ?? "";
    expect(source).toContain('zcl_zmcp_fluid_rt=>out( |"{ zcl_zmcp_fluid_rt=>esc( lv_line ) }"| ).');
  });

  it("contains no FIND REGEX anywhere", () => {
    const source = runSources.get("ZCL_ZMCP_FLUID_RUN") ?? "";
    expect(source).not.toMatch(/FIND\s+REGEX/i);
  });
});

describe("run tool ABAP source: JSON input scanning via ZCL_ZMCP_FLUID_RT", () => {
  it("calls scan( iv_json ) once before reading report/variant", () => {
    const source = runSources.get("ZCL_ZMCP_FLUID_RUN") ?? "";
    expect(source).toContain("zcl_zmcp_fluid_rt=>scan( iv_json ).");
    expect(source).toContain("zcl_zmcp_fluid_rt=>s( 'report' )");
    expect(source).toContain("zcl_zmcp_fluid_rt=>s( 'variant' )");
  });

  it("the deployed ZCL_ZMCP_FLUID_RT source declares scan/s/b/n in its PUBLIC SECTION", () => {
    const rtSource = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS) ?? "";
    const [publicSection] = rtSource.split("PRIVATE SECTION.");
    expect(publicSection).toContain("CLASS-METHODS scan");
    expect(publicSection).toMatch(/CLASS-METHODS s\b/);
    expect(publicSection).toMatch(/CLASS-METHODS b\b/);
    expect(publicSection).toMatch(/CLASS-METHODS n\b/);
  });
});

describe("negative: a raw unescaped list line is not valid JSON on the wire", () => {
  it("throws FLUID_PROTOCOL_ERROR when an OUT payload is a raw list line (documents why esc-wrapping is required)", () => {
    const lines = [
      `ZMCP-H>BEGIN {"id":"run","ver":"a1b2c3d4","action":"report","contract":"1.0"}`,
      `ZMCP-H>OUT ABC  100   Foo "bar"`,
      `ZMCP-H>END {"rc":0,"outBytes":1,"truncated":false,"ms":1}`,
    ];
    let caught: unknown;
    try {
      parseFluidConsole(lines.join("\n"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AbapError);
    expect((caught as AbapError).code).toBe("FLUID_PROTOCOL_ERROR");
  });
});

describe("runManifest.objects / runSources: ZCL_ZMCP_FLUID_RT wiring", () => {
  it("names ZCL_ZMCP_FLUID_RT in objects and has its source in runSources", () => {
    const names = runManifest.objects.map((o) => o.name);
    expect(names).toContain(FLUID_RUNTIME_CLASS);
    expect(runSources.has(FLUID_RUNTIME_CLASS)).toBe(true);
  });

  it("has a byte-identical ZCL_ZMCP_FLUID_RT source to fluidRuntimeSources", () => {
    expect(runSources.get(FLUID_RUNTIME_CLASS)).toBe(fluidRuntimeSources.get(FLUID_RUNTIME_CLASS));
  });
});

describe("runManifest / runSources — shared builtin-manifest invariants", () => {
  it("parses through FluidManifestSchema.safeParse", () => {
    const result = FluidManifestSchema.safeParse(runManifest);
    expect(result.success, JSON.stringify(result.success ? undefined : result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it("has a runSources entry for every declared object", () => {
    for (const obj of runManifest.objects) {
      expect(runSources.has(obj.name), `missing source for "${obj.name}"`).toBe(true);
    }
  });

  it("has every object description at most 60 characters", () => {
    for (const obj of runManifest.objects) {
      expect(
        obj.description.length,
        `"${obj.name}" description is ${obj.description.length} chars: ${obj.description}`,
      ).toBeLessThanOrEqual(60);
    }
  });

  it("has no ABAP source line over FLUID_ABAP_LINE_MAX characters", () => {
    for (const obj of runManifest.objects) {
      const source = runSources.get(obj.name) ?? "";
      const lines = source.split(/\r\n|\r|\n/);
      lines.forEach((line, i) => {
        expect(
          line.length,
          `"${obj.name}" line ${i + 1} is ${line.length} chars: ${line}`,
        ).toBeLessThanOrEqual(FLUID_ABAP_LINE_MAX);
      });
    }
  });

  it("has every source pass reviewFluidAbap with no findings", () => {
    for (const obj of runManifest.objects) {
      const source = runSources.get(obj.name) ?? "";
      const findings = reviewFluidAbap(obj.name, source);
      expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
    }
  });
});
