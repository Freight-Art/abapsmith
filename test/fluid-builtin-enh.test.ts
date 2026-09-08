// Mirrors fluid-builtin-manifests.test.ts's 5 baseline assertions against enhManifest/enhSources
// directly, since builtin/index.ts (where BUILTIN_FLUID_TOOLS is assembled) is out of scope here,
// plus assertions specific to the enh body class's structure and protocol behaviour.
import { describe, expect, it } from "vitest";
import { enhManifest, enhSources } from "../src/adt/fluid/builtin/enh.js";
import { BRIDGE_CLASS } from "../src/adt/enhancement-bridge.js";
import { FluidManifestSchema, validateAgainstSchema } from "../src/adt/fluid/manifest.js";
import { FLUID_ABAP_LINE_MAX, reviewFluidAbap } from "../src/adt/fluid/static-review.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeSources } from "../src/adt/fluid/abap/runtime.js";
import { parseFluidConsole } from "../src/adt/fluid/protocol.js";

const ENH_CLASS = "ZCL_ZMCP_FLUID_ENH";
const ENH_SOURCE = enhSources.get(ENH_CLASS) ?? "";

describe("enh manifest baseline", () => {
  it("manifest passes FluidManifestSchema.safeParse", () => {
    const result = FluidManifestSchema.safeParse(enhManifest);
    expect(result.success, JSON.stringify(result.success ? undefined : result.error.issues, null, 2)).toBe(true);
  });

  it("every manifest object has a source", () => {
    for (const obj of enhManifest.objects) {
      expect(enhSources.has(obj.name), `missing source for "${obj.name}"`).toBe(true);
    }
  });

  it("every manifest object description is at most 60 characters", () => {
    for (const obj of enhManifest.objects) {
      expect(
        obj.description.length,
        `"${obj.name}" description is ${obj.description.length} chars: ${obj.description}`,
      ).toBeLessThanOrEqual(60);
    }
  });

  it("every ABAP source line is at most FLUID_ABAP_LINE_MAX characters", () => {
    for (const obj of enhManifest.objects) {
      const source = enhSources.get(obj.name) ?? "";
      const lines = source.split(/\r\n|\r|\n/);
      lines.forEach((line, i) => {
        expect(line.length, `"${obj.name}" line ${i + 1} is ${line.length} chars: ${line}`).toBeLessThanOrEqual(
          FLUID_ABAP_LINE_MAX,
        );
      });
    }
  });

  it("every source passes reviewFluidAbap with no findings", () => {
    for (const obj of enhManifest.objects) {
      const source = enhSources.get(obj.name) ?? "";
      const findings = reviewFluidAbap(obj.name, source);
      expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
    }
  });
});

describe("enh action names track BRIDGE_CLASS", () => {
  it("has exactly one action per BRIDGE_CLASS key, camelCase to snake_case", () => {
    const expected = Object.keys(BRIDGE_CLASS)
      .map((k) => k.replace(/([A-Z])/g, "_$1").toLowerCase())
      .sort();
    const actual = enhManifest.actions.map((a) => a.name).sort();
    expect(actual).toEqual(expected);
  });
});

describe("enh body class structure", () => {
  it("has one CASE arm per action plus WHEN OTHERS, and a single CASE iv_action", () => {
    const caseMatches = ENH_SOURCE.match(/\bCASE iv_action\./g) ?? [];
    expect(caseMatches.length).toBe(1);
    for (const action of enhManifest.actions) {
      const whenRe = new RegExp(`WHEN '${action.name}'\\.`);
      expect(whenRe.test(ENH_SOURCE), `no WHEN '${action.name}'. arm found`).toBe(true);
    }
    expect(/\bWHEN OTHERS\./.test(ENH_SOURCE)).toBe(true);
  });

  it("never emits the legacy ZMCP-ENH-ERR> tag", () => {
    expect(ENH_SOURCE.includes("ZMCP-ENH-ERR>")).toBe(false);
  });

  it("has no path that ends the action without calling err() first (fail-without-err)", () => {
    // Every RETURN inside the CASE (other than the shared CATCH block) must be immediately
    // preceded, within the same statement group, by an err( ... ) call feeding an end( 1 ).
    const lines = ENH_SOURCE.split("\n");
    const returnLines = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /^\s*RETURN\.\s*$/.test(line));
    expect(returnLines.length).toBeGreaterThan(0);
    for (const { i } of returnLines) {
      const before = lines.slice(Math.max(0, i - 6), i).join("\n");
      expect(before, `RETURN at line ${i + 1} has no err( )/end( 1 ) immediately before it:\n${before}`).toMatch(
        /err\(/,
      );
      expect(before, `RETURN at line ${i + 1} has no end\\( 1 \\) immediately before it:\n${before}`).toMatch(
        /end\(\s*1\s*\)/,
      );
    }
  });

  it("never uses dynamic method dispatch (->( or =>( ) outside of prose", () => {
    // The exercise arm's err() message documents the forbidden ->( )/=>( ) escape hatch as
    // prose inside a backtick literal; strip backtick spans before scanning for real code.
    const withoutBacktickLiterals = ENH_SOURCE.replace(/`[^`]*`/g, "");
    expect(/(?:->|=>)\s*\(/.test(withoutBacktickLiterals)).toBe(false);
  });

  it("reuses ZCL_ZMCP_FLUID_RT byte-identical to the shared runtime source", () => {
    const rtSource = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS);
    expect(rtSource).toBeDefined();
    expect(enhSources.get(FLUID_RUNTIME_CLASS)).toBe(rtSource);
    const rtObj = enhManifest.objects.find((o) => o.name === FLUID_RUNTIME_CLASS);
    expect(rtObj).toBeDefined();
    expect(enhManifest.objects[0]?.name).toBe(FLUID_RUNTIME_CLASS);
    expect(enhManifest.entry).toBe(ENH_CLASS);
    expect(enhManifest.objects[1]?.name).toBe(ENH_CLASS);
  });
});

function beginFrame(action: string): string {
  return `ZMCP-H>BEGIN ${JSON.stringify({ id: "enh", ver: "1", action, contract: "1.0" })}`;
}

function endFrame(rc: number): string {
  return `ZMCP-H>END ${JSON.stringify({ rc, outBytes: 0, truncated: false, ms: 1 })}`;
}

describe("enh action output round-trips through parseFluidConsole", () => {
  const cases: ReadonlyArray<{ action: string; out: unknown }> = [
    { action: "create_spot", out: { created: true } },
    { action: "add_badi_def", out: { added: true } },
    { action: "add_filter_def", out: { added: true } },
    { action: "create_impl", out: { created: true, impl_added: true, filter_check: "has_filters" } },
    { action: "set_filter_values", out: { replaced: true } },
  ];

  it.each(cases)("$action: OUT payload validates against its output schema", ({ action, out }) => {
    const spec = enhManifest.actions.find((a) => a.name === action);
    expect(spec, `no action spec for "${action}"`).toBeDefined();
    const transcript = parseFluidConsole(
      [beginFrame(action), `ZMCP-H>OUT ${JSON.stringify(out)}`, endFrame(0)].join("\n"),
    );
    expect(transcript.errors).toEqual([]);
    expect(transcript.end?.rc).toBe(0);
    expect(transcript.values).toEqual([out]);
    const problems = validateAgainstSchema(transcript.values[0], spec!.output, action);
    expect(problems).toEqual([]);
  });

  it("exercise: documented ERR-only path (rc=1, no OUT frame) round-trips", () => {
    const transcript = parseFluidConsole(
      [
        beginFrame("exercise"),
        `ZMCP-H>ERR ${JSON.stringify({
          kind: "exception",
          step: "dispatch",
          text: "exercise cannot run on this shared, once-deployed body class: see docs",
        })}`,
        endFrame(1),
      ].join("\n"),
    );
    expect(transcript.values).toEqual([]);
    expect(transcript.errors).toHaveLength(1);
    expect(transcript.errors[0]?.kind).toBe("exception");
    expect(transcript.end?.rc).toBe(1);
  });

  it("a failure transcript (args error, no OUT) round-trips with rc=1 and one ERR frame", () => {
    const transcript = parseFluidConsole(
      [
        beginFrame("create_spot"),
        `ZMCP-H>ERR ${JSON.stringify({
          kind: "exception",
          step: "args",
          text: "spot_name and description are required",
        })}`,
        endFrame(1),
      ].join("\n"),
    );
    expect(transcript.begin?.action).toBe("create_spot");
    expect(transcript.values).toEqual([]);
    expect(transcript.errors).toHaveLength(1);
    expect(transcript.errors[0]?.step).toBe("args");
    expect(transcript.end?.rc).toBe(1);
  });
});
