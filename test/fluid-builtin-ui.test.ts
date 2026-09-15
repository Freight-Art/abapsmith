// builtin/index.ts is off limits to this slice (a separate orchestrator appends to it), so this
// tool is never covered by fluid-builtin-manifests.test.ts's iteration over BUILTIN_FLUID_TOOLS.
// This file replicates that test's five checks directly against uiManifest/uiSources, plus
// substantive assertions specific to the ui body class's contents.
import { describe, expect, it } from "vitest";
import { uiManifest, uiSources } from "../src/adt/fluid/builtin/ui.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeSources } from "../src/adt/fluid/abap/runtime.js";
import { FluidManifestSchema, validateAgainstSchema } from "../src/adt/fluid/manifest.js";
import { FLUID_ABAP_LINE_MAX, reviewFluidAbap } from "../src/adt/fluid/static-review.js";
import { parseFluidConsole } from "../src/adt/fluid/protocol.js";

const UI_BODY_CLASS = "ZCL_ZMCP_FLUID_UI";

function bodySource(): string {
  const src = uiSources.get(UI_BODY_CLASS);
  if (src === undefined) throw new Error(`uiSources has no entry for ${UI_BODY_CLASS}`);
  return src;
}

// Mirrors ZCL_ZMCP_FLUID_RT's esc() exactly (see src/adt/fluid/abap/runtime.ts, METHOD esc):
// backslash, quote, CRLF/LF, CR, tab — in that order.
function escAbap(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function extractBalancedArgs(s: string, openParenIdx: number): string {
  let depth = 0;
  for (let i = openParenIdx; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return s.slice(openParenIdx + 1, i);
    }
  }
  throw new Error("unbalanced parens starting at " + openParenIdx);
}

describe("uiManifest / uiSources", () => {
  it("passes FluidManifestSchema.safeParse", () => {
    const result = FluidManifestSchema.safeParse(uiManifest);
    expect(result.success, JSON.stringify(result.success ? undefined : result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it("every manifest object has a source, and every source has a manifest object", () => {
    const objectNames = uiManifest.objects.map((o) => o.name);
    for (const name of objectNames) {
      expect(uiSources.has(name), `missing source for "${name}"`).toBe(true);
    }
    for (const name of uiSources.keys()) {
      expect(objectNames.includes(name), `source "${name}" has no manifest object`).toBe(true);
    }
    expect(uiSources.size).toBe(uiManifest.objects.length);
  });

  it("every manifest object description is at most 60 characters", () => {
    for (const obj of uiManifest.objects) {
      expect(
        obj.description.length,
        `"${obj.name}" description is ${obj.description.length} chars: ${obj.description}`,
      ).toBeLessThanOrEqual(60);
    }
  });

  it("every ABAP source line is at most FLUID_ABAP_LINE_MAX characters", () => {
    for (const obj of uiManifest.objects) {
      const source = uiSources.get(obj.name) ?? "";
      const lines = source.split(/\r\n|\r|\n/);
      lines.forEach((line, i) => {
        expect(
          line.length,
          `"${obj.name}" line ${i + 1} is ${line.length} chars: ${line}`,
        ).toBeLessThanOrEqual(FLUID_ABAP_LINE_MAX);
      });
    }
  });

  it("every source passes reviewFluidAbap with no findings", () => {
    for (const obj of uiManifest.objects) {
      const source = uiSources.get(obj.name) ?? "";
      const findings = reviewFluidAbap(obj.name, source);
      expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
    }
  });

  it("objects[0] is the shared runtime class, byte-identical to fluidRuntimeSources's entry", () => {
    expect(uiManifest.objects[0]?.name).toBe(FLUID_RUNTIME_CLASS);
    const rtSource = uiSources.get(FLUID_RUNTIME_CLASS);
    expect(rtSource).toBe(fluidRuntimeSources.get(FLUID_RUNTIME_CLASS));
  });

  it("entry is ZCL_ZMCP_FLUID_UI, whose public section declares run(iv_action, iv_json) and nothing else", () => {
    expect(uiManifest.entry).toBe(UI_BODY_CLASS);
    const body = bodySource();
    const pubStart = body.indexOf("PUBLIC SECTION.");
    const privStart = body.indexOf("PRIVATE SECTION.");
    expect(pubStart).toBeGreaterThan(-1);
    expect(privStart).toBeGreaterThan(pubStart);
    const pubSection = body.slice(pubStart, privStart);

    expect((pubSection.match(/CLASS-METHODS/g) ?? []).length).toBe(1);
    expect(pubSection).toContain("CLASS-METHODS run");
    expect(pubSection).toContain("iv_action TYPE string");
    expect(pubSection).toContain("iv_json");
    expect((pubSection.match(/TYPE string/g) ?? []).length).toBe(2);
  });

  it("reads every declared input property via s(), and never uses FIND REGEX", () => {
    const body = bodySource();
    expect(body).not.toMatch(/FIND\s+REGEX/i);

    for (const actionName of ["screen", "fcode"]) {
      const action = uiManifest.actions.find((a) => a.name === actionName);
      expect(action, `no manifest action named "${actionName}"`).toBeDefined();
      const props = Object.keys(action?.input.properties ?? {});
      expect(props.length).toBeGreaterThan(0);
      for (const prop of props) {
        const needle = `zcl_zmcp_fluid_rt=>s( '${prop}' )`;
        expect(
          body.includes(needle),
          `body does not read "${actionName}" action's declared input property "${prop}" via s()`,
        ).toBe(true);
      }
    }
  });

  it("fcode is a distinct manifest action, dispatched from METHOD run, with array output", () => {
    const fcodeAction = uiManifest.actions.find((a) => a.name === "fcode");
    expect(fcodeAction).toBeDefined();
    // dispatch() treats "array" output as "hand back every OUT frame", unlike screen's "object"
    // output ("hand back the one required OUT frame verbatim") — ui-fcode-tool.test.ts and
    // test/helpers/fluid-ui-fake.ts's uiFcodeConsole both depend on this being "array".
    expect(fcodeAction?.output.type).toBe("array");
    expect(fcodeAction?.category).toBe("read");

    const body = bodySource();
    const runIdx = body.indexOf("METHOD run.");
    expect(runIdx).toBeGreaterThan(-1);
    const runEndIdx = body.indexOf("ENDMETHOD.", runIdx);
    const runBody = body.slice(runIdx, runEndIdx);
    // CASE iv_action dispatches "screen" and "fcode" to same-named private methods, and falls
    // through anything else to err() rather than silently doing nothing.
    expect(runBody).toContain("WHEN 'screen'.");
    expect(runBody).toContain("WHEN 'fcode'.");
    expect(runBody).toContain("fcode( ).");
    expect(runBody).toContain("WHEN OTHERS.");
    expect(runBody).toContain("unknown action");
  });

  it("the ABAP body never runs CALL TRANSACTION / LEAVE TO TRANSACTION / BDCDATA itself", () => {
    // fcode only reads flow logic, CUA, and includes - it must never execute a transaction, unlike
    // the separate `press` bridge (src/adt/ui-runtime.ts's runUiPressBridge), which is a real BDC
    // CALL TRANSACTION ... USING run. This only inspects this class's own ABAP body text - it does
    // not (and cannot, offline) prove that the *read* source of some other program never contains
    // these words; the fixtures under test/fixtures/ui-fcode/ genuinely do contain "CALL
    // TRANSACTION" as plain data, which is fine because that text is only ever read and reported
    // on, never re-executed by this class.
    const body = bodySource();
    expect(body).not.toContain("CALL TRANSACTION");
    expect(body).not.toContain("LEAVE TO TRANSACTION");
    expect(body).not.toContain("BDCDATA");
  });

  it("every end(1) is reachable only alongside an err() call, and METHOD run's outermost CATCH cx_root always calls err() so the post-TRY failed() gate reaches it", () => {
    const body = bodySource();
    // Named-parameter ABAP call style (`end( iv_rc = 1 )`), not positional `end( 1 )` - the body
    // switched to named parameters at some point after this check was first written; the
    // regex tracks that style rather than the older positional one.
    const end1Count = (body.match(/zcl_zmcp_fluid_rt=>end\( iv_rc = 1 \)/g) ?? []).length;
    const errCount = (body.match(/zcl_zmcp_fluid_rt=>err\(/g) ?? []).length;
    expect(end1Count).toBeGreaterThan(0);
    // Structural, not flow-sensitive: proves err() appears at least as often as end(1) in the
    // source text. It does NOT prove every individual end(1) call site is reached only when
    // err() ran, nor does it execute the ABAP to confirm run time behaviour.
    expect(errCount).toBeGreaterThanOrEqual(end1Count);

    // Unlike an earlier body revision, end(1) is no longer called directly inside a CATCH block:
    // every CATCH arm now just calls err(), and METHOD run gates a single end(1)/end(0) choice on
    // failed() once, after its outermost TRY/ENDTRY. This checks that shape - CATCH cx_root calls
    // err(), and the failed()-gate that follows the matching ENDTRY does call end(1) - without
    // (and this cannot, statically) proving failed() actually evaluates true whenever err() ran.
    const catchIdx = body.indexOf("CATCH cx_root");
    expect(catchIdx).toBeGreaterThan(-1);
    const endTryIdx = body.indexOf("ENDTRY.", catchIdx);
    expect(endTryIdx).toBeGreaterThan(catchIdx);
    const catchBlock = body.slice(catchIdx, endTryIdx);
    expect(catchBlock).toContain("zcl_zmcp_fluid_rt=>err(");
    expect(catchBlock).not.toContain("zcl_zmcp_fluid_rt=>end(");

    const gateIdx = body.indexOf("failed( ) = abap_true", endTryIdx);
    expect(gateIdx).toBeGreaterThan(endTryIdx);
    const gateEndIdx = body.indexOf("ENDIF.", gateIdx);
    expect(gateEndIdx).toBeGreaterThan(gateIdx);
    expect(body.slice(gateIdx, gateEndIdx)).toContain("zcl_zmcp_fluid_rt=>end( iv_rc = 1 )");
  });

  // fcode's flow/include/module/src frames interpolate a handful of bare, non-text values
  // directly (loop indices, line numbers, sy-subrc, a fixed 'true'/'false' literal, and a
  // pre-built JSON fragment returned by cua_json(), which already escapes its own text fields).
  // None of these can carry a stray quote or backslash, so esc() would be a no-op for them.
  // Listed by exact expression text so a *new* bare interpolation of an actual text variable
  // still fails this check - only these specific, already-verified-safe expressions are exempt.
  const KNOWN_SAFE_NON_TEXT_INTERPOLATIONS = new Set([
    "lv_flow_idx",
    "lv_cua",
    "sy-subrc",
    "lv_lines",
    "lv_mod_from",
    "lv_lno",
    "lv_last",
    "lv_j",
  ]);

  it("every out() call escapes every raw interpolation it makes directly", () => {
    const body = bodySource();
    const callRe = /zcl_zmcp_fluid_rt=>out\(/g;
    let match: RegExpExecArray | null;
    let callCount = 0;
    while ((match = callRe.exec(body)) !== null) {
      callCount++;
      const openParenIdx = match.index + match[0].length - 1;
      const args = extractBalancedArgs(body, openParenIdx);
      if (args.includes("|")) {
        const interpRe = /\{([^{}]*)\}/g;
        let interp: RegExpExecArray | null;
        while ((interp = interpRe.exec(args)) !== null) {
          const inner = interp[1]?.trim() ?? "";
          expect(
            inner.includes("=>esc(") || inner.startsWith("esc(") || KNOWN_SAFE_NON_TEXT_INTERPOLATIONS.has(inner),
            `out() call interpolates "${inner}" without esc(): ${args}`,
          ).toBe(true);
        }
      }
    }
    expect(callCount).toBeGreaterThan(0);
    // This only inspects the literal text passed to out(...) at its call site. In this body,
    // out() is always called with a plain variable (lv_out) that was assembled beforehand via
    // && concatenation elsewhere (each piece escaped there) — this check does not trace that
    // assembly, so it does not prove the variable's contents are safe, only that the call site
    // itself introduces no unescaped interpolation.
  });

  it("round-trips a representative screen OUT payload through parseFluidConsole and the declared output schema", () => {
    const screenAction = uiManifest.actions.find((a) => a.name === "screen");
    expect(screenAction).toBeDefined();
    if (!screenAction) return;

    const program = 'SAPMV45A "quote';
    const dynpro = "0100";
    const fieldRows: ReadonlyArray<Record<string, string>> = [
      { name: "KUNNR", fnam: "KUNNR", ftyp: "C" },
      { name: "NAME1\\slash", fnam: "NAME1\\slash", ftyp: "C" },
    ];

    const fieldsJson = fieldRows
      .map((row) => {
        const parts = Object.entries(row).map(([k, v]) => `"${k}":"${escAbap(v)}"`).join(",");
        return `{${parts}}`;
      })
      .join(",");
    const outPayload = `{"program":"${escAbap(program)}","dynpro":"${escAbap(dynpro)}","fields":[${fieldsJson}]}`;

    const beginPayload = JSON.stringify({ id: "ui", ver: "abcd1234", action: "screen", contract: "1.0" });
    const endPayload = JSON.stringify({ rc: 0, outBytes: outPayload.length, truncated: false, ms: 3 });

    const transcriptText = [
      `ZMCP-H>BEGIN ${beginPayload}`,
      `ZMCP-H>OUT ${outPayload}`,
      `ZMCP-H>END ${endPayload}`,
    ].join("\n");

    const transcript = parseFluidConsole(transcriptText);
    expect(transcript.errors).toEqual([]);
    expect(transcript.stray).toEqual([]);
    expect(transcript.dropped).toEqual([]);
    expect(transcript.begin?.id).toBe("ui");
    expect(transcript.begin?.action).toBe("screen");
    expect(transcript.end?.rc).toBe(0);
    expect(transcript.values.length).toBe(1);

    const result = transcript.values[0];
    expect(result).toEqual({
      program,
      dynpro,
      fields: fieldRows,
    });

    const schemaErrors = validateAgainstSchema(result, screenAction.output, "result");
    expect(schemaErrors).toEqual([]);
  });

  it("round-trips a representative fcode transcript through parseFluidConsole and the declared output schema", () => {
    const fcodeAction = uiManifest.actions.find((a) => a.name === "fcode");
    expect(fcodeAction).toBeDefined();
    if (!fcodeAction) return;

    // One frame of each kind METHOD fcode/scan_modules/emit_src ever emit (src/adt/fluid/builtin/ui.ts).
    const frames: readonly unknown[] = [
      { kind: "target", program: "SAPMSVMA", dynpro: "0100", fcode_filter: "" },
      { kind: "flow", index: 1, line: "PROCESS AFTER INPUT." },
      { kind: "pai_module", index: 1, name: "EXIT_COMMAND", at_exit: true, flow_line: 2 },
      { kind: "cua" },
      { kind: "include", name: "SAPMSVMA", lines: 220 },
      { kind: "module", name: "EXIT_COMMAND", include: "SAPMSVMA", line_from: 453, line_to: 458 },
      // emit_src's ABAP emits "line" quoted (`"line":"{ lv_j }"`), same as every other frame's
      // "line" field, so this fixture uses a string here to match the real wire shape.
      { kind: "src", include: "SAPMSVMA", line: "454", text: "set screen 0." },
      { kind: "summary", program: "SAPMSVMA", dynpro: "0100", includes: 1, includes_failed: 0, modules: 1, pai_modules: 1, src_lines: 1, truncated: "" },
    ];

    const beginPayload = JSON.stringify({ id: "ui", ver: "abcd1234", action: "fcode", contract: "1.0" });
    const outLines = frames.map((f) => `ZMCP-H>OUT ${JSON.stringify(f)}`);
    const endPayload = JSON.stringify({ rc: 0, outBytes: 0, truncated: false, ms: 3 });
    const transcriptText = [`ZMCP-H>BEGIN ${beginPayload}`, ...outLines, `ZMCP-H>END ${endPayload}`].join("\n");

    const transcript = parseFluidConsole(transcriptText);
    expect(transcript.errors).toEqual([]);
    expect(transcript.stray).toEqual([]);
    expect(transcript.dropped).toEqual([]);
    expect(transcript.begin?.action).toBe("fcode");
    expect(transcript.values.length).toBe(frames.length);
    expect(transcript.values).toEqual(frames);

    const schemaErrors = validateAgainstSchema(transcript.values, fcodeAction.output, "result");
    // Every frame kind validates cleanly against fcodeAction.output.items, including "src":
    // emit_src now quotes "line" the same way every other frame does, so the declared
    // `{ type: "string" }` schema and the real wire format agree.
    expect(schemaErrors).toEqual([]);
  });
});
