/**
 * Offline validation for the built-in "scan" fluid tool
 * (src/adt/fluid/builtin/scan.ts), the source-text-search backend behind
 * `abap_search mode=source`. Mirrors fluid-builtin-fpm.test.ts's baseline
 * assertions directly against scanManifest/scanSources, plus assertions
 * specific to this tool's own protocol requirements: no literal row cap
 * (scan_lines stops on a HOST variable, gv_max_hits, not a literal), and the
 * `(?-x)` PCRE prefix regression this file exists partly to pin. No
 * FakeAdtServer, no network, no filesystem, no AbapConnection.
 */
import { describe, expect, it } from "vitest";
import {
  SCAN_TOOL_ID,
  SCAN_ACTION,
  SCAN_ENTRY_CLASS,
  scanManifest,
  scanSources,
} from "../src/adt/fluid/builtin/scan.js";
import { FLUID_CONTRACT, FluidManifestSchema } from "../src/adt/fluid/manifest.js";
import { FLUID_ABAP_LINE_MAX, reviewFluidAbap } from "../src/adt/fluid/static-review.js";
import { FLUID_RUNTIME_CLASS } from "../src/adt/fluid/abap/runtime.js";

const SCAN_SOURCE = scanSources.get(SCAN_ENTRY_CLASS) ?? "";

describe("scan manifest baseline", () => {
  it("manifest passes FluidManifestSchema.safeParse", () => {
    const result = FluidManifestSchema.safeParse(scanManifest);
    expect(result.success, JSON.stringify(result.success ? undefined : result.error.issues, null, 2)).toBe(true);
  });

  it("declares contract/id/entry as SCAN_ACTION's constants say", () => {
    expect(scanManifest.contract).toBe(FLUID_CONTRACT);
    expect(scanManifest.id).toBe("scan");
    expect(SCAN_TOOL_ID).toBe("scan");
    expect(scanManifest.entry).toBe(SCAN_ENTRY_CLASS);
    expect(SCAN_ENTRY_CLASS).toBe("ZCL_ZMCP_FLUID_SCAN");
  });

  it("declares exactly one action, named SCAN_ACTION, category read", () => {
    expect(scanManifest.actions.length).toBe(1);
    const action = scanManifest.actions[0];
    expect(action?.name).toBe(SCAN_ACTION);
    expect(SCAN_ACTION).toBe("source");
    expect(action?.category).toBe("read");
  });

  it("every manifest object has a source in scanSources", () => {
    for (const obj of scanManifest.objects) {
      expect(scanSources.has(obj.name), `missing source for "${obj.name}"`).toBe(true);
    }
  });

  it("has no scanSources entry the manifest does not declare (no orphan sources)", () => {
    const declared = new Set(scanManifest.objects.map((o) => o.name));
    for (const key of scanSources.keys()) {
      expect(declared.has(key), `scanSources has orphan entry "${key}"`).toBe(true);
    }
  });

  it("declares ZCL_ZMCP_FLUID_RT first, before the scan entry class (activation order)", () => {
    expect(scanManifest.objects[0]?.name).toBe(FLUID_RUNTIME_CLASS);
    expect(scanManifest.objects[1]?.name).toBe(SCAN_ENTRY_CLASS);
  });

  it("every manifest object description is at most 60 characters", () => {
    for (const obj of scanManifest.objects) {
      expect(
        obj.description.length,
        `"${obj.name}" description is ${obj.description.length} chars: ${obj.description}`,
      ).toBeLessThanOrEqual(60);
    }
  });

  it("every ABAP source line is at most FLUID_ABAP_LINE_MAX characters", () => {
    for (const obj of scanManifest.objects) {
      const source = scanSources.get(obj.name) ?? "";
      const lines = source.split(/\r\n|\r|\n/);
      lines.forEach((line, i) => {
        expect(line.length, `"${obj.name}" line ${i + 1} is ${line.length} chars: ${line}`).toBeLessThanOrEqual(
          FLUID_ABAP_LINE_MAX,
        );
      });
    }
  });

  it("every source passes reviewFluidAbap with no findings", () => {
    for (const obj of scanManifest.objects) {
      const source = scanSources.get(obj.name) ?? "";
      const findings = reviewFluidAbap(obj.name, source);
      expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
    }
  });
});

describe("scan body: no literal row cap", () => {
  it('does not hardcode a row cap via "UP TO <n> ROWS" — the fetch is bounded by the host variable lv_fetch', () => {
    // The scan body DOES emit `UP TO @lv_fetch ROWS`, a dynamic bound driven
    // by the caller's own max_objects argument — that is not a hardcoded cap
    // and must not trip this check.
    expect(SCAN_SOURCE).toMatch(/UP TO @lv_fetch ROWS/);
    expect(SCAN_SOURCE).not.toMatch(/\bUP TO\s+\d+\s+ROWS\b/i);
  });

  it("does not declare a c_max_rows-style constant", () => {
    expect(SCAN_SOURCE).not.toMatch(/c_max_rows/i);
  });

  it("does not raise an undisclosed `_capped = abap_true` truncation flag", () => {
    expect(SCAN_SOURCE).not.toMatch(/^[ \t]*\w*_capped\s*=\s*abap_true\s*\./im);
  });
});

describe("scan body: PCRE (?-x) prefix regression", () => {
  it(
    "prefixes every caller regex pattern with (?-x) before FIND PCRE — " +
      "ABAP's FIND PCRE compiles with the extended (x) flag ON by default (live-verified on A4H: " +
      'pattern "FUNCTION B" does NOT match "FUNCTION BRF_FLIGHT_BOOKING_ADD_SINGLE.", while ' +
      '"(?-x)FUNCTION B" does), so without this prefix a caller\'s regex containing a literal space ' +
      "would silently have that space ignored instead of matched.",
    () => {
      expect(SCAN_SOURCE).toContain("(?-x)");
      expect(SCAN_SOURCE).toMatch(/gv_pattern\s*=\s*\|\(\?-x\)\{ lv_query \}\|/);
    },
  );
});
