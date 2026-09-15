/**
 * Offline validation for the "events" action added to the built-in "fpm"
 * fluid tool (src/adt/fluid/builtin/fpm.ts), for issue #101 (FPM event
 * tracing / abap_fpm_read mode=events).
 *
 * Why a separate file rather than extending an existing one:
 *  - test/fluid-builtin-manifests.test.ts iterates BUILTIN_FLUID_TOOLS, but
 *    fpm is registered through its own orchestrator wiring that file does
 *    not cover (see fluid-builtin-fpm.test.ts's own header) — same reason
 *    applies here.
 *  - test/fluid-builtin-fpm.test.ts already exists and already covers the
 *    fpm body class as a whole. Its whole-source scans (fail-without-err,
 *    CATCH cx_root before end(1), end(1)/end(0) gated on failed(), every
 *    JSON string field escaped via esc(), no legacy transcript dialect, no
 *    FIND REGEX / dynamic dispatch) scan the *entire* FPM_SOURCE text, so
 *    they already exercise the "events" METHOD's body too — this file does
 *    not repeat them. Its two `it.each(fpmManifest.actions...)` loops
 *    (input-schema flatness, every flat input property read via a matching
 *    s()/b()/n() call) iterate the manifest directly, so "events" is
 *    already covered by those as well. Its per-source line-length check and
 *    its `reviewFluidAbap` check also iterate `fpmManifest.objects`
 *    directly, so the "events" method's lines are already included in that
 *    coverage too — this file does NOT repeat either of those two checks.
 *  - What that file does NOT cover, because "events" did not exist when it
 *    was written: the "events" action's specific manifest shape (array
 *    output, "kind" required), and a parseFluidConsole round-trip for a
 *    multi-frame "events" transcript. Those are this file's reason to
 *    exist.
 *
 * No FakeAdtServer, no network, no filesystem, no AbapConnection.
 */
import { describe, expect, it } from "vitest";
import { fpmManifest, fpmSources } from "../src/adt/fluid/builtin/fpm.js";
import { FluidManifestSchema, validateAgainstSchema } from "../src/adt/fluid/manifest.js";
import { parseFluidConsole } from "../src/adt/fluid/protocol.js";

const FPM_CLASS = "ZCL_ZMCP_FLUID_FPM";
const FPM_SOURCE = fpmSources.get(FPM_CLASS) ?? "";

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

describe("fpmManifest / fpmSources — events action", () => {
  it("manifest passes FluidManifestSchema.safeParse", () => {
    const result = FluidManifestSchema.safeParse(fpmManifest);
    expect(result.success, JSON.stringify(result.success ? undefined : result.error.issues, null, 2)).toBe(true);
  });

  it('declares an "events" action with array output whose items require "kind"', () => {
    const eventsAction = fpmManifest.actions.find((a) => a.name === "events");
    expect(eventsAction, "no action named events in fpmManifest.actions").toBeDefined();
    if (!eventsAction) return;
    // dispatch() (src/adt/fluid/dispatch.ts) sets res.result = transcript.values
    // (every OUT/OUTE frame) only when the action's declared output.type is
    // "array". With output.type "object" it instead requires exactly one OUT
    // frame and throws FLUID_PROTOCOL_ERROR otherwise. The events method
    // legitimately emits many frames per run (one config, N children, N
    // fpm_event catalogue rows, N bopf rows, one summary) — declaring
    // anything other than array output here would make dispatch() throw on
    // the very first real invocation.
    expect(eventsAction.output.type).toBe("array");
    expect(eventsAction.output.items?.required).toContain("kind");
  });

  it("events: every flat input property is read via a matching s()/b() call", () => {
    const eventsAction = fpmManifest.actions.find((a) => a.name === "events");
    expect(eventsAction).toBeDefined();
    if (!eventsAction) return;
    const props = eventsAction.input.properties ?? {};
    expect(Object.keys(props).length).toBeGreaterThan(0);
    for (const [key, propSchema] of Object.entries(props)) {
      const fn = propSchema.type === "boolean" ? "b" : "s";
      const re = new RegExp(`zcl_zmcp_fluid_rt=>${fn}\\(\\s*'${key}'\\s*\\)`);
      expect(re.test(FPM_SOURCE), `expected a ${fn}( '${key}' ) call for action "events", property "${key}"`).toBe(
        true,
      );
    }
  });

  // Structural, not flow-sensitive: this counts occurrences of the two call
  // shapes textually. It does not prove every err() is followed by end(1) on
  // the same code path, only that the two counts are consistent with the
  // "every failure calls err() at least once before end(1)" invariant across
  // the whole class body (find/outline/app/events all share one run()/end()
  // gate). See the CATCH cx_root arm below for the one place both are
  // guaranteed to appear together.
  it("err( ) call count is at least end( 1 ) call count", () => {
    const errCount = (FPM_SOURCE.match(/\berr\(/g) ?? []).length;
    const end1Count = (FPM_SOURCE.match(/\bend\(\s*1\s*\)/g) ?? []).length;
    expect(errCount).toBeGreaterThanOrEqual(end1Count);
  });

  it("the CATCH cx_root arm calls both err() and end(1)-via-failed()", () => {
    const catchIdx = FPM_SOURCE.indexOf("CATCH cx_root INTO DATA(lx_err).");
    expect(catchIdx, "no CATCH cx_root INTO DATA(lx_err). in FPM_SOURCE").toBeGreaterThanOrEqual(0);
    const after = FPM_SOURCE.slice(catchIdx, catchIdx + 400);
    expect(after).toMatch(/err\(/);
    expect(after).toMatch(/end\(\s*1\s*\)|failed\(\s*\)/);
  });

  it('an "events" run round-trips a multi-frame transcript through parseFluidConsole and the declared schema', () => {
    const eventsAction = fpmManifest.actions.find((a) => a.name === "events");
    expect(eventsAction).toBeDefined();
    if (!eventsAction) return;

    const rootConfigId = '/BOFU/TEST"QUOTE_OVP';
    const configFrame = {
      kind: "config",
      role: "root",
      config_id: rootConfigId,
      config_type: "00",
      config_var: "",
      component: "FPM_OVP_COMPONENT",
      devclass: "$TMP",
      xml: `<Component Name="X">back\\slash</Component>`,
    };
    const fpmEventFrame = { kind: "fpm_event", name: "GC_EVENT_SAVE", event_id: "FPM_SAVE" };
    const bopfActionFrame = {
      kind: "bopf_action",
      bo: "/BOFU/TEST_SALES_ORDER",
      act_name: "DELIVER",
      act_key: "801CC4EFFE841DEE83C203E4238B4AD7",
      node_key: "801CC4EFFE841DDE83C203E4254D53AF",
      act_class: "/BOBF/CL_DEMO_SAM_SALES_ORDER",
      act_cat: "0",
    };
    const summaryFrame = {
      kind: "summary",
      configs_read: 1,
      configs_failed: 0,
      configs_skipped: 0,
      bopf_nodes: 0,
      bopf_actions: 1,
      fpm_events: 1,
      truncated: "",
    };

    const outPayloads = [configFrame, fpmEventFrame, bopfActionFrame, summaryFrame].map((v) => {
      // Only the config frame carries a value containing a quote/backslash;
      // escape it the same way ZCL_ZMCP_FLUID_RT's esc() would, matching the
      // manual JSON construction the ABAP `events` method actually performs
      // (it does not run values through JSON.stringify).
      if (v.kind === "config") {
        return (
          `{"kind":"config","role":"root","config_id":"${escAbap(rootConfigId)}",` +
          `"config_type":"00","config_var":"","component":"FPM_OVP_COMPONENT","devclass":"$TMP",` +
          `"xml":"${escAbap(configFrame.xml)}"}`
        );
      }
      return JSON.stringify(v);
    });

    const beginPayload = JSON.stringify({ id: "fpm", ver: "abcd1234", action: "events", contract: "1.0" });
    const endPayload = JSON.stringify({ rc: 0, outBytes: 0, truncated: false, ms: 4 });

    const transcriptLines = [
      `ZMCP-H>BEGIN ${beginPayload}`,
      ...outPayloads.map((p) => `ZMCP-H>OUT ${p}`),
      `ZMCP-H>END ${endPayload}`,
    ];
    const transcript = parseFluidConsole(transcriptLines.join("\n"));
    expect(transcript.errors).toEqual([]);
    expect(transcript.stray).toEqual([]);
    expect(transcript.dropped).toEqual([]);
    expect(transcript.values.length).toBe(outPayloads.length);

    const itemsSchema = eventsAction.output.items;
    expect(itemsSchema, "events action output.items must be defined for array output").toBeDefined();
    if (!itemsSchema) return;
    for (const value of transcript.values) {
      const schemaErrors = validateAgainstSchema(value, itemsSchema, "result[i]");
      expect(schemaErrors, JSON.stringify(value)).toEqual([]);
    }

    expect((transcript.values[0] as Record<string, unknown>).config_id).toBe(rootConfigId);
  });
});
