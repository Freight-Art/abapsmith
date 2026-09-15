/**
 * Offline validation for the built-in "fpm" fluid tool
 * (src/adt/fluid/builtin/fpm.ts), which reimplements the read path of
 * src/adt/fpm-runtime.ts (findBody/outlineBody/appBody) as one statically
 * deployed body class. Mirrors fluid-builtin-manifests.test.ts's baseline
 * assertions directly against fpmManifest/fpmSources (builtin/index.ts,
 * where BUILTIN_FLUID_TOOLS is assembled, is out of scope here), plus
 * assertions specific to the fpm body class's structure and protocol
 * behaviour. No FakeAdtServer, no network, no filesystem, no
 * AbapConnection.
 */
import { describe, expect, it } from "vitest";
import { fpmManifest, fpmSources } from "../src/adt/fluid/builtin/fpm.js";
import { FluidManifestSchema, validateAgainstSchema } from "../src/adt/fluid/manifest.js";
import { FLUID_ABAP_LINE_MAX, reviewFluidAbap } from "../src/adt/fluid/static-review.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeSources } from "../src/adt/fluid/abap/runtime.js";
import { parseFluidConsole } from "../src/adt/fluid/protocol.js";

const FPM_CLASS = "ZCL_ZMCP_FLUID_FPM";
const FPM_SOURCE = fpmSources.get(FPM_CLASS) ?? "";

describe("fpm manifest baseline", () => {
  it("manifest passes FluidManifestSchema.safeParse", () => {
    const result = FluidManifestSchema.safeParse(fpmManifest);
    expect(result.success, JSON.stringify(result.success ? undefined : result.error.issues, null, 2)).toBe(true);
  });

  it("every manifest object has a source", () => {
    for (const obj of fpmManifest.objects) {
      expect(fpmSources.has(obj.name), `missing source for "${obj.name}"`).toBe(true);
    }
  });

  it("has no fpmSources entry the manifest does not declare", () => {
    const declared = new Set(fpmManifest.objects.map((o) => o.name));
    for (const key of fpmSources.keys()) {
      expect(declared.has(key), `fpmSources has orphan entry "${key}"`).toBe(true);
    }
  });

  it("every manifest object description is at most 60 characters", () => {
    for (const obj of fpmManifest.objects) {
      expect(
        obj.description.length,
        `"${obj.name}" description is ${obj.description.length} chars: ${obj.description}`,
      ).toBeLessThanOrEqual(60);
    }
  });

  it("every ABAP source line is at most FLUID_ABAP_LINE_MAX characters", () => {
    for (const obj of fpmManifest.objects) {
      const source = fpmSources.get(obj.name) ?? "";
      const lines = source.split(/\r\n|\r|\n/);
      lines.forEach((line, i) => {
        expect(line.length, `"${obj.name}" line ${i + 1} is ${line.length} chars: ${line}`).toBeLessThanOrEqual(
          FLUID_ABAP_LINE_MAX,
        );
      });
    }
  });

  it("every source passes reviewFluidAbap with no findings", () => {
    for (const obj of fpmManifest.objects) {
      const source = fpmSources.get(obj.name) ?? "";
      const findings = reviewFluidAbap(obj.name, source);
      expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
    }
  });
});

describe("fpmManifest.objects / fpmSources — ZCL_ZMCP_FLUID_RT wiring", () => {
  it("declares ZCL_ZMCP_FLUID_RT first so it is deployed before ZCL_ZMCP_FLUID_FPM", () => {
    expect(fpmManifest.objects[0]?.name).toBe(FLUID_RUNTIME_CLASS);
    expect(fpmManifest.objects[1]?.name).toBe(FPM_CLASS);
  });

  it("keeps ZCL_ZMCP_FLUID_FPM as the entry class", () => {
    expect(fpmManifest.entry).toBe(FPM_CLASS);
  });

  it("ships the exact same ZCL_ZMCP_FLUID_RT source as the rt tool, not a copy", () => {
    const rtSource = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS);
    expect(rtSource).toBeDefined();
    expect(fpmSources.get(FLUID_RUNTIME_CLASS)).toBe(rtSource);
  });
});

describe("fpm action names", () => {
  it("declares exactly find/outline/app/events, each category read", () => {
    const names = fpmManifest.actions.map((a) => a.name).sort();
    expect(names).toEqual(["app", "events", "find", "outline"]);
    for (const action of fpmManifest.actions) {
      expect(action.category, `action "${action.name}"`).toBe("read");
    }
  });

  it.each(fpmManifest.actions.map((a) => [a.name, a] as const))(
    "action %s: input schema is flat (scalar or string-array properties only)",
    (_name, action) => {
      const props = action.input.properties ?? {};
      for (const [key, propSchema] of Object.entries(props)) {
        if (propSchema.type === "array") {
          expect(propSchema.items?.type, `${action.name}.${key}`).toBe("string");
        } else {
          expect(["string", "number", "integer", "boolean"], `${action.name}.${key}`).toContain(propSchema.type);
        }
      }
    },
  );
});

describe("fpm body class structure", () => {
  it("has exactly one CASE iv_action, one WHEN arm per action, and a WHEN OTHERS", () => {
    const caseMatches = FPM_SOURCE.match(/\bCASE iv_action\./g) ?? [];
    expect(caseMatches.length).toBe(1);
    for (const action of fpmManifest.actions) {
      const whenRe = new RegExp(`WHEN '${action.name}'\\.`);
      expect(whenRe.test(FPM_SOURCE), `no WHEN '${action.name}'. arm found`).toBe(true);
    }
    expect(/\bWHEN OTHERS\./.test(FPM_SOURCE)).toBe(true);
  });

  it("declares exactly one CLASS-METHODS run in the public section, taking iv_action/iv_json strings", () => {
    const [publicSection] = FPM_SOURCE.split("PRIVATE SECTION.");
    expect(publicSection).toContain("CLASS-METHODS run");
    expect(publicSection).toMatch(/iv_action\s+TYPE\s+string/);
    expect(publicSection).toMatch(/iv_json\s+TYPE\s+string/);
  });

  it("contains no FIND REGEX anywhere", () => {
    expect(FPM_SOURCE).not.toMatch(/FIND\s+REGEX/i);
  });

  it("never uses dynamic method dispatch (->( or =>( ) outside of prose", () => {
    const withoutBacktickLiterals = FPM_SOURCE.replace(/`[^`]*`/g, "");
    expect(/(?:->|=>)\s*\(/.test(withoutBacktickLiterals)).toBe(false);
  });

  it.each(fpmManifest.actions.map((a) => [a.name, a] as const))(
    "action %s: every flat input property is read via a matching s()/b()/n() call",
    (_name, action) => {
      const props = action.input.properties ?? {};
      for (const [key, propSchema] of Object.entries(props)) {
        const fn = propSchema.type === "boolean" ? "b" : propSchema.type === "array" ? "n" : "s";
        const re = new RegExp(`zcl_zmcp_fluid_rt=>${fn}\\(\\s*'${key}'\\s*\\)`);
        expect(re.test(FPM_SOURCE), `expected a ${fn}( '${key}' ) call for action "${action.name}"`).toBe(true);
      }
    },
  );

  it("has no path that ends the action without calling err() first (fail-without-err)", () => {
    const lines = FPM_SOURCE.split("\n");
    const returnLines = lines.map((line, i) => ({ line, i })).filter(({ line }) => /^\s*RETURN\.\s*$/.test(line));
    expect(returnLines.length).toBeGreaterThan(0);
    for (const { i } of returnLines) {
      const before = lines.slice(Math.max(0, i - 6), i).join("\n");
      expect(before, `RETURN at line ${i + 1} has no err( ) immediately before it:\n${before}`).toMatch(/err\(/);
    }
  });

  it("the CATCH cx_root arm in run() calls err() before falling through to end()", () => {
    const catchIdx = FPM_SOURCE.indexOf("CATCH cx_root INTO DATA(lx_err).");
    expect(catchIdx).toBeGreaterThan(-1);
    const endtryIdx = FPM_SOURCE.indexOf("ENDTRY.", catchIdx);
    expect(endtryIdx).toBeGreaterThan(catchIdx);
    const catchBody = FPM_SOURCE.slice(catchIdx, endtryIdx);
    expect(catchBody).toMatch(/zcl_zmcp_fluid_rt=>err\(/);
  });

  it("ends the action via failed() -> end(1)/end(0), never a bare end(1) not gated on failed()", () => {
    expect(FPM_SOURCE).toContain("IF zcl_zmcp_fluid_rt=>failed( ) = abap_true.");
    expect(FPM_SOURCE).toContain("zcl_zmcp_fluid_rt=>end( 1 ).");
    expect(FPM_SOURCE).toContain("zcl_zmcp_fluid_rt=>end( 0 ).");
  });

  it("every JSON string-valued field emitted goes through esc(), never a raw interpolation", () => {
    const re = /"[a-zA-Z_]+":"\{([^}]*)\}"/g;
    let match: RegExpExecArray | null;
    let count = 0;
    while ((match = re.exec(FPM_SOURCE)) !== null) {
      count++;
      const expr = (match[1] ?? "").trim();
      expect(expr.startsWith("zcl_zmcp_fluid_rt=>esc("), `raw interpolation found: "${match[0]}"`).toBe(true);
    }
    expect(count).toBeGreaterThan(0);
  });

  it("builds the LIKE pattern from the ABAP side (query arg), not baked into the SELECT as a literal", () => {
    expect(FPM_SOURCE).toMatch(/REPLACE ALL OCCURRENCES OF '_' IN lv_pattern WITH '#_'\./);
    expect(FPM_SOURCE).toMatch(/REPLACE ALL OCCURRENCES OF '\*' IN lv_pattern WITH '%'\./);
    expect(FPM_SOURCE).toMatch(/LIKE @lv_pattern ESCAPE '#'/);
  });

  it("streams outline's XML via out_chunk/out(''), not the legacy tag dialect", () => {
    expect(FPM_SOURCE).toContain("zcl_zmcp_fluid_rt=>out_chunk( lv_json ).");
    expect(FPM_SOURCE).toContain("zcl_zmcp_fluid_rt=>out( '' ).");
  });

  it("never emits the legacy FPM_LINE_PREFIX / tag-chunk transcript dialect", () => {
    expect(FPM_SOURCE.includes("FPM> ")).toBe(false);
    expect(FPM_SOURCE.includes("_BEGIN")).toBe(false);
    expect(FPM_SOURCE.includes("_END")).toBe(false);
  });
});

function beginFrame(action: string): string {
  return `ZMCP-H>BEGIN ${JSON.stringify({ id: "fpm", ver: "1", action, contract: "1.0" })}`;
}

function endFrame(rc: number): string {
  return `ZMCP-H>END ${JSON.stringify({ rc, outBytes: 0, truncated: false, ms: 1 })}`;
}

describe("fpm action output round-trips through parseFluidConsole", () => {
  it("find: two OUT frames validate as an array of matching items", () => {
    const spec = fpmManifest.actions.find((a) => a.name === "find");
    expect(spec).toBeDefined();
    const rows = [
      {
        config_id: "Z_TEST_CFG",
        config_type: "00",
        config_var: "STD",
        component: "ZCOMP",
        description: 'has a "quote" and a \\backslash',
        devclass: "ZDEVCLASS",
      },
      {
        config_id: "Z_TEST_CFG2",
        config_type: "00",
        config_var: "",
        component: "",
        description: "",
        devclass: "",
      },
    ];
    const transcript = parseFluidConsole(
      [beginFrame("find"), ...rows.map((r) => `ZMCP-H>OUT ${JSON.stringify(r)}`), endFrame(0)].join("\n"),
    );
    expect(transcript.errors).toEqual([]);
    expect(transcript.end?.rc).toBe(0);
    expect(transcript.values).toEqual(rows);
    for (const value of transcript.values) {
      const problems = validateAgainstSchema(value, spec!.output.items!, "find[]");
      expect(problems).toEqual([]);
    }
  });

  it("outline: an OUTC/OUTC/OUTE run split inside the xml string reassembles into one value", () => {
    const spec = fpmManifest.actions.find((a) => a.name === "outline");
    expect(spec).toBeDefined();
    const payload = {
      config_id: "Z_TEST_CFG",
      config_type: "00",
      config_var: "STD",
      xml: "<CONFIG><NODE attr=\"value with a break here\">payload</NODE></CONFIG>",
      meta: {
        config_idpar: "Z_TEST_CFG",
        config_typepar: "00",
        config_varpar: "STD",
        component: "ZCOMP",
        devclass: "ZDEVCLASS",
      },
    };
    const full = JSON.stringify(payload);
    // Split mid-way through the xml string value itself, proving reassembly
    // does not depend on a chunk boundary landing on a JSON structural character.
    const splitAt = full.indexOf("break here") + 3;
    const part1 = full.slice(0, splitAt);
    const part2 = full.slice(splitAt);
    const transcript = parseFluidConsole(
      [beginFrame("outline"), `ZMCP-H>OUTC ${part1}`, `ZMCP-H>OUTC ${part2}`, `ZMCP-H>OUTE `, endFrame(0)].join(
        "\n",
      ),
    );
    expect(transcript.errors).toEqual([]);
    expect(transcript.end?.rc).toBe(0);
    expect(transcript.values).toEqual([payload]);
    const problems = validateAgainstSchema(transcript.values[0], spec!.output, "outline");
    expect(problems).toEqual([]);
  });

  it("outline: a not-found config_id is a genuine ERR-only failure (rc=1)", () => {
    const transcript = parseFluidConsole(
      [
        beginFrame("outline"),
        `ZMCP-H>ERR ${JSON.stringify({
          kind: "subrc",
          step: "select",
          subrc: 4,
          text: "wdy_config_appl: no matching row for the given key",
        })}`,
        endFrame(1),
      ].join("\n"),
    );
    expect(transcript.errors.length).toBe(1);
    expect(transcript.errors[0]?.kind).toBe("subrc");
    expect(transcript.end?.rc).toBe(1);
    expect(transcript.values).toEqual([]);
  });

  it("app: an OUTC/OUTC/OUTE run split inside a node's own string field reassembles into one value", () => {
    const spec = fpmManifest.actions.find((a) => a.name === "app");
    expect(spec).toBeDefined();
    const node = {
      node_path: "ROOT/NODE1",
      parent_path: "ROOT",
      is_top_node: false,
      node_name: "NODE1",
      description: "a node description with a break point right here for splitting",
      component_name: "ZCOMP",
      interface_view: "IV1",
      config_id: "Z_TEST_CFG",
      config_type: "02",
      config_var: "STD",
      target_config_id: "",
      is_configurable: true,
      is_customized: false,
      is_enhanced: false,
      is_freestyle_uibb: false,
      is_leaf: true,
      resolved: {
        xml_len: 123,
        feeder_hint: true,
        bopf_hint: false,
        excerpt: "<CONFIG/>",
      },
    };
    const full = JSON.stringify(node);
    const splitAt = full.indexOf("break point") + 5;
    const part1 = full.slice(0, splitAt);
    const part2 = full.slice(splitAt);
    // app's own ABAP emits one whole OUT line per node; this exercises the
    // same protocol-level OUTC/OUTE reassembly generically for a value of
    // app's shape, independent of which call in the class happens to chunk.
    const transcript = parseFluidConsole(
      [beginFrame("app"), `ZMCP-H>OUTC ${part1}`, `ZMCP-H>OUTE ${part2}`, endFrame(0)].join("\n"),
    );
    expect(transcript.errors).toEqual([]);
    expect(transcript.values).toEqual([node]);
    const problems = validateAgainstSchema(transcript.values[0], spec!.output.items!, "app[]");
    expect(problems).toEqual([]);
  });

  it("app: a per-node resolve failure is captured as resolve_error, not an ERR frame, so the tree walk keeps going", () => {
    const spec = fpmManifest.actions.find((a) => a.name === "app");
    expect(spec).toBeDefined();
    const nodeOk = {
      node_path: "ROOT",
      parent_path: "",
      is_top_node: true,
      node_name: "ROOT",
      description: "",
      component_name: "",
      interface_view: "",
      config_id: "Z_TEST_CFG",
      config_type: "02",
      config_var: "STD",
      target_config_id: "",
      is_configurable: false,
      is_customized: false,
      is_enhanced: false,
      is_freestyle_uibb: false,
      is_leaf: false,
    };
    const nodeFailed = {
      ...nodeOk,
      node_path: "ROOT/NODE2",
      node_name: "NODE2",
      is_configurable: true,
      is_leaf: true,
      resolve_error: "READ_COMP_CONFIG_FROM_DB raised CX_WDY_CONFIG",
    };
    const transcript = parseFluidConsole(
      [
        beginFrame("app"),
        `ZMCP-H>OUT ${JSON.stringify(nodeOk)}`,
        `ZMCP-H>OUT ${JSON.stringify(nodeFailed)}`,
        endFrame(0),
      ].join("\n"),
    );
    expect(transcript.errors).toEqual([]);
    expect(transcript.end?.rc).toBe(0);
    expect(transcript.values).toEqual([nodeOk, nodeFailed]);
    for (const value of transcript.values) {
      const problems = validateAgainstSchema(value, spec!.output.items!, "app[]");
      expect(problems).toEqual([]);
    }
  });
});
