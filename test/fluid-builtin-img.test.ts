/**
 * Offline validation for the built-in "img" fluid tool
 * (src/adt/fluid/builtin/img.ts). This suite imports the manifest and
 * sources straight from the module, not the barrel, so a typo in the
 * manifest or a source/manifest mismatch is caught regardless of whether
 * anything else has registered the tool. No FakeAdtServer, no network, no
 * filesystem.
 */
import { describe, expect, it } from "vitest";
import { imgManifest, imgSources } from "../src/adt/fluid/builtin/img.js";
import { FLUID_CONTRACT, FluidManifestSchema, validateFluidSchema } from "../src/adt/fluid/manifest.js";
import { reviewFluidAbap } from "../src/adt/fluid/static-review.js";

describe("imgManifest — schema", () => {
  it("parses cleanly through FluidManifestSchema", () => {
    const result = FluidManifestSchema.safeParse(imgManifest);
    expect(result.success, JSON.stringify(result.success ? undefined : result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it("declares the current FLUID_CONTRACT", () => {
    expect(imgManifest.contract).toBe(FLUID_CONTRACT);
  });
});

describe("imgManifest / imgSources — object <-> source correspondence", () => {
  const objectNames = imgManifest.objects.map((o) => o.name);

  it("has an imgSources entry for every declared object", () => {
    for (const name of objectNames) {
      expect(imgSources.has(name), `imgSources is missing "${name}"`).toBe(true);
    }
  });

  it("has no imgSources entry the manifest does not declare", () => {
    const declared = new Set(objectNames);
    for (const key of imgSources.keys()) {
      expect(declared.has(key), `imgSources has orphan entry "${key}"`).toBe(true);
    }
  });

  it("has the same object count both ways", () => {
    expect(imgSources.size).toBe(objectNames.length);
  });

  it("declares the entry class among its objects", () => {
    expect(objectNames).toContain(imgManifest.entry);
  });
});

describe("imgManifest — actions", () => {
  it("has at least one action", () => {
    expect(imgManifest.actions.length).toBeGreaterThan(0);
  });

  it.each(imgManifest.actions.map((a) => [a.name, a] as const))(
    "action %s: input schema has no validateFluidSchema issues",
    (name, action) => {
      const issues = validateFluidSchema(action.input, `actions.${name}.input`);
      expect(issues, issues.join("\n")).toEqual([]);
    },
  );

  it.each(imgManifest.actions.map((a) => [a.name, a] as const))(
    "action %s: output schema has no validateFluidSchema issues",
    (name, action) => {
      const issues = validateFluidSchema(action.output, `actions.${name}.output`);
      expect(issues, issues.join("\n")).toEqual([]);
    },
  );
});

describe("imgSources — ABAP source content", () => {
  it.each(imgManifest.objects.map((o) => [o.name, o] as const))(
    "%s: source declares that class name and is non-trivial",
    (name) => {
      const source = imgSources.get(name);
      expect(source).toBeDefined();
      if (source === undefined) return;

      expect(source.length).toBeGreaterThan(200);

      const lower = name.toLowerCase();
      expect(new RegExp(`CLASS\\s+${lower}\\s+DEFINITION`, "i").test(source)).toBe(true);
      expect(new RegExp(`CLASS\\s+${lower}\\s+IMPLEMENTATION`, "i").test(source)).toBe(true);
    },
  );

  it.each(imgManifest.objects.map((o) => [o.name, o] as const))(
    "%s: passes the static ABAP reviewer with no findings",
    (name) => {
      const source = imgSources.get(name);
      expect(source).toBeDefined();
      if (source === undefined) return;

      const findings = reviewFluidAbap(name, source);
      expect(findings).toEqual([]);
    },
  );
});

// Regression guard for a real reachability gap found by review, not a live incident: the expert
// escape hatch (`table`/`key_fields`/`client_field` given directly, bypassing `splitClientField`'s
// CLNT-typed-field derivation) plus `allow_cross_client: true` can name a genuinely
// client-independent table, which `img-write-policy.ts`'s cross-client rule (rule 7) only refuses
// when `allowCrossClient !== true` — it never checks whether the declared client field actually
// exists on the table. Before this guard, `apply`'s ABAP body silently no-opped an absent client
// field (`ASSIGN COMPONENT ... IF sy-subrc = 0. <fs_val> = sy-mandt. ENDIF.`) and fell straight
// through to a real MODIFY/DELETE — reaching a live write the documented guarantee ("this tool
// cannot write a client-independent table at all") said was impossible. There is no ABAP
// interpreter here to execute `apply` and observe the refusal directly, so this pins the guard's
// presence and position in the shipped source text instead: it must exist, it must run before
// either MODIFY or DELETE (never after), and it must actually refuse (report an error, clear
// rv_ok, and return) rather than merely look up the field.
describe("ZCL_ZMCP_FLUID_IMG's apply refuses a client field absent from the table before writing", () => {
  it("checks the client field is a real component, before MODIFY/DELETE, and actually refuses when it isn't", () => {
    const source = imgSources.get("ZCL_ZMCP_FLUID_IMG");
    expect(source).toBeDefined();
    if (source === undefined) return;

    const applyStart = source.indexOf("METHOD apply.");
    expect(applyStart, "METHOD apply. not found").toBeGreaterThan(-1);
    const applyEnd = source.indexOf("ENDMETHOD.", applyStart);
    expect(applyEnd, "ENDMETHOD. after METHOD apply. not found").toBeGreaterThan(applyStart);
    const body = source.slice(applyStart, applyEnd);

    const guardIdx = body.indexOf(
      "READ TABLE lt_comp INTO ls_comp WITH KEY name = to_upper( iv_client_field )",
    );
    expect(guardIdx, "apply must look up iv_client_field as a real component of the table").toBeGreaterThan(-1);

    const modifyIdx = body.indexOf("MODIFY (lv_table_upper)");
    const deleteIdx = body.indexOf("DELETE (lv_table_upper)");
    expect(modifyIdx, "MODIFY (lv_table_upper) not found").toBeGreaterThan(-1);
    expect(deleteIdx, "DELETE (lv_table_upper) not found").toBeGreaterThan(-1);
    expect(guardIdx, "client-field guard must run before MODIFY").toBeLessThan(modifyIdx);
    expect(guardIdx, "client-field guard must run before DELETE").toBeLessThan(deleteIdx);

    const guardBlockEnd = body.indexOf("ENDIF.", guardIdx);
    expect(guardBlockEnd, "no ENDIF. closing the client-field guard").toBeGreaterThan(guardIdx);
    const guardBlock = body.slice(guardIdx, guardBlockEnd);
    expect(guardBlock, "guard must actually report a refusal").toContain("zcl_zmcp_fluid_rt=>err(");
    expect(guardBlock, "guard must clear rv_ok").toContain("rv_ok = abap_false");
    expect(guardBlock, "guard must RETURN, not merely record the refusal").toContain("RETURN.");
  });
});
