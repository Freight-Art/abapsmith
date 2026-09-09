// FluidManifestSchema is only invoked from plugin-loader.ts, so builtin manifests are otherwise never validated.
import { describe, expect, it } from "vitest";
import { BUILTIN_FLUID_TOOLS } from "../src/adt/fluid/builtin/index.js";
import { CLASSIC_BODY_CLASS, CLASSIC_TOOL_ID } from "../src/adt/fluid/builtin/classic.js";
import { packagePart } from "../src/adt/fluid/builtin/classic/abap-package.js";
import { FluidManifestSchema } from "../src/adt/fluid/manifest.js";
import { FLUID_ABAP_LINE_MAX, reviewFluidAbap } from "../src/adt/fluid/static-review.js";
import { UI_FKEY_ROW_CAP, UI_STATUS_LOOP_CAP } from "../src/adt/ui-runtime.js";

const tools = BUILTIN_FLUID_TOOLS.map((tool) => [tool.manifest.id, tool] as const);

// FluidObjectSpecSchema (manifest.ts) isn't exported, and its `description: z.string().max(60)`
// check has no named constant of its own — 60 is a bare literal there. The real constraint is the
// ABAP server's own object short-text limit: writeAndActivateOnce (ensure.ts:247-252) forwards
// `obj.description` straight into createObject (write.ts:3211), and a too-long description comes
// back from the server as a bare ADT_ERROR at deploy time — see the AbapError trace this test
// guards against. (The max is technically recoverable at runtime by reaching into
// FluidManifestSchema's zod internals — `.def.shape.objects.def.element.def.shape.description
// .def.checks[].def.maximum` — but that walks undocumented `_zod` internals that zod does not
// promise to keep stable, so a bare literal kept in sync by hand is the safer bet.) Keep this in
// sync with manifest.ts if that schema's max ever changes.
const FLUID_OBJECT_DESCRIPTION_MAX = 60;

/**
 * Would ADT accept `description` as an object's short text? Returns a problem string if not,
 * `undefined` if it's fine. Factored out of the it.each below so the "has teeth" tests further
 * down can drive it directly with synthetic input, proving the check itself is capable of failing
 * and not just vacuously true against today's compliant builtins.
 */
function describeDescriptionProblem(description: string): string | undefined {
  if (description.length === 0) {
    return "description is empty";
  }
  if (description.length > FLUID_OBJECT_DESCRIPTION_MAX) {
    return `description is ${description.length} chars (max ${FLUID_OBJECT_DESCRIPTION_MAX}): ${description}`;
  }
  return undefined;
}

describe("BUILTIN_FLUID_TOOLS manifests", () => {
  // it.each over an empty array runs zero tests rather than failing, so every check below would
  // silently pass-by-not-existing if BUILTIN_FLUID_TOOLS were ever empty. Guard that explicitly.
  it("enumerates at least one builtin tool", () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  it.each(tools)("%s: manifest passes FluidManifestSchema.safeParse", (_id, tool) => {
    const result = FluidManifestSchema.safeParse(tool.manifest);
    expect(result.success, JSON.stringify(result.success ? undefined : result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it.each(tools)("%s: every manifest object has a source", (_id, tool) => {
    for (const obj of tool.manifest.objects) {
      expect(tool.sources.has(obj.name), `missing source for "${obj.name}"`).toBe(true);
    }
  });

  it.each(tools)(
    "%s: every manifest object description is non-empty and at most 60 characters",
    (_id, tool) => {
      // Belt-and-suspenders alongside the enumeration guard above: an empty `objects` array here
      // would also make this loop assert nothing for that tool.
      expect(tool.manifest.objects.length, `${_id} has no objects`).toBeGreaterThan(0);
      for (const obj of tool.manifest.objects) {
        const problem = describeDescriptionProblem(obj.description);
        expect(problem, `"${obj.name}": ${problem}`).toBeUndefined();
      }
    },
  );

  it.each(tools)("%s: every ABAP source line is at most FLUID_ABAP_LINE_MAX characters", (_id, tool) => {
    for (const obj of tool.manifest.objects) {
      const source = tool.sources.get(obj.name) ?? "";
      const lines = source.split(/\r\n|\r|\n/);
      lines.forEach((line, i) => {
        expect(
          line.length,
          `"${obj.name}" line ${i + 1} is ${line.length} chars: ${line}`,
        ).toBeLessThanOrEqual(FLUID_ABAP_LINE_MAX);
      });
    }
  });

  it.each(tools)("%s: every source passes reviewFluidAbap with no findings", (_id, tool) => {
    for (const obj of tool.manifest.objects) {
      const source = tool.sources.get(obj.name) ?? "";
      const findings = reviewFluidAbap(obj.name, source);
      expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
    }
  });

  it.each(tools)("%s: any source referencing zcl_zmcp_fluid_rt declares the runtime object", (id, tool) => {
    // rt is the runtime itself: its own source names its own class, not a dependency on a separate object.
    if (id === "rt") {
      return;
    }
    const referencesRuntime = [...tool.sources.values()].some((source) =>
      /zcl_zmcp_fluid_rt/i.test(source),
    );
    if (!referencesRuntime) {
      return;
    }
    expect(tool.manifest.objects.some((obj) => obj.name === "ZCL_ZMCP_FLUID_RT")).toBe(true);
    expect(tool.sources.has("ZCL_ZMCP_FLUID_RT")).toBe(true);
  });
});

// "No caps of any kind" is a project rule, so no builtin's generated ABAP may silently truncate a
// result set the caller asked for. Two shapes of that violation are pinned here: a literal
// `UP TO <n> ROWS` (a dynamic `UP TO @lv_max ROWS`, where the caller's own argument controls the
// bound and 0 means unlimited per ABAP's own rule for that construct — see core/abap-select.ts —
// is not this), and a `c_max_rows`-style constant declared to enforce one in ABAP.
//
// classic/abap-package.ts's own `UP TO 21 ROWS` selects are the one legitimate exception: that
// code is not returning a result set the caller asked for, it is proving whether a package is
// EMPTY so it can refuse to delete a non-empty one — one row is sufficient to reach that yes/no
// decision, at most 20 are listed as human-readable evidence, and it emits an explicit
// `ZMCP-PKG-CONTENT-TRUNCATED>` marker when it stopped early. Removing that bound would mean
// selecting every TADIR row in a large package to answer a yes/no question: strictly worse
// behaviour, not better. The exemption below is keyed to that file's own exported source (so a
// changed row count there still self-exempts) and to the specific object it compiles into, not to
// the literal string "UP TO 21 ROWS" — a broad string exemption would let a genuine cap slip back
// into that same file later without tripping this pin.
const HARDCODED_ROWS_CAP_RE = /\bUP TO\s+\d+\s+ROWS\b/gi;
const MAX_ROWS_CONSTANT_RE = /\bCONSTANTS\b(?:(?!\.).){0,120}?\bMAX\b(?:(?!\.).){0,120}?\bROWS?\b/gis;

const PACKAGE_EMPTINESS_ROW_CAPS = new Set(
  [...packagePart.source.matchAll(HARDCODED_ROWS_CAP_RE)].map((m) => m[0]),
);

function isExemptRowCap(toolId: string, objName: string, match: string): boolean {
  return toolId === CLASSIC_TOOL_ID && objName === CLASSIC_BODY_CLASS && PACKAGE_EMPTINESS_ROW_CAPS.has(match);
}

describe("BUILTIN_FLUID_TOOLS manifests: no hardcoded row caps", () => {
  it.each(tools)('%s: no source hardcodes a row cap via "UP TO <n> ROWS"', (id, tool) => {
    for (const obj of tool.manifest.objects) {
      const source = tool.sources.get(obj.name) ?? "";
      const matches = [...source.matchAll(HARDCODED_ROWS_CAP_RE)].map((m) => m[0]);
      const unexempted = matches.filter((m) => !isExemptRowCap(id, obj.name, m));
      expect(unexempted, `"${obj.name}" hardcodes a row cap: ${JSON.stringify(unexempted)}`).toEqual([]);
    }
  });

  it.each(tools)("%s: no source declares a c_max_rows-style constant", (_id, tool) => {
    for (const obj of tool.manifest.objects) {
      const source = tool.sources.get(obj.name) ?? "";
      const matches = source.match(MAX_ROWS_CONSTANT_RE) ?? [];
      expect(matches, `"${obj.name}" declares a row-cap constant: ${JSON.stringify(matches)}`).toEqual([]);
    }
  });
});

// The two regexes above catch the SQL-shaped cap (`UP TO n ROWS`) and a constant declared to
// enforce one. Neither catches the third shape: a bare numeric guard on a running counter inside an
// ABAP loop, which truncates just as silently — `IF lv_total < 350. ... ELSE. lv_capped = abap_true.`
// The `ui` body carries exactly two of those, ported verbatim from the pre-fluid `ui-runtime.ts`
// generator, and they are the only ones in any builtin.
//
// They are deliberately kept rather than removed, and each earns its keep differently: the status
// bound limits how many `RS_CUA_GET_STATUS` calls one screen read makes (a call-count guard, not an
// output cap — ~32ms warm each), and the FKEY bound stops the row set from silently losing its tail
// to `buildResponse`'s character budget further downstream (SAPLSVIM reported 778 rows and
// delivered 442 before it existed). Both disclose themselves in the result via a `capped` flag, so
// no caller is told a truncated list is complete.
//
// What was NOT safe was leaving them as bare literals. `UI_STATUS_LOOP_CAP`/`UI_FKEY_ROW_CAP` are
// still exported from `ui-runtime.ts` and still drive the caller-facing disclosure text in
// `tools/ui.ts` and the budget invariant in `ui-runtime.test.ts`, but after the reroute the ABAP
// that actually enforces the bound hardcodes the numbers instead of interpolating them. Nothing
// tied the two together, so lowering `UI_FKEY_ROW_CAP` would have changed every message about the
// cap while the deployed body kept truncating at 350 — a disclosure that lies about its own bound.
// These two assertions are that tie. A third `_capped` flag appearing in any builtin fails the
// count check below rather than slipping in unpinned.
const UI_BODY_CLASS = "ZCL_ZMCP_FLUID_UI";

describe("BUILTIN_FLUID_TOOLS: emitted-output caps mirror their named constant", () => {
  const uiTool = BUILTIN_FLUID_TOOLS.find((t) => t.manifest.id === "ui");
  const uiSource = uiTool?.sources.get(UI_BODY_CLASS) ?? "";

  it("the ui body is present and readable, or every assertion below is vacuous", () => {
    expect(uiTool, "no builtin fluid tool with id 'ui'").toBeDefined();
    expect(uiSource.length, `${UI_BODY_CLASS} source is empty`).toBeGreaterThan(0);
  });

  it(`the per-status RS_CUA_GET_STATUS loop bound in ABAP is UI_STATUS_LOOP_CAP (${UI_STATUS_LOOP_CAP})`, () => {
    expect(
      uiSource,
      `${UI_BODY_CLASS} must bound its status loop at UI_STATUS_LOOP_CAP; if that constant changed, change the ABAP too`,
    ).toContain(`lv_status_done >= ${UI_STATUS_LOOP_CAP}`);
  });

  it(`the FKEY row bound in ABAP is UI_FKEY_ROW_CAP (${UI_FKEY_ROW_CAP})`, () => {
    expect(
      uiSource,
      `${UI_BODY_CLASS} must bound its FKEY emission at UI_FKEY_ROW_CAP; tools/ui.ts discloses that number to the caller`,
    ).toContain(`lv_fkeys_total < ${UI_FKEY_ROW_CAP}`);
  });

  // The two assertions above tie the ABAP that enforces each bound to its named constant. They do
  // not cover the third place the number appears: the manifest's own output-schema `description`
  // strings, which are what `abap_fluid describe` shows an agent deciding whether a result is
  // complete. `ui`'s `fkeys` description says "across up to 30 statuses" as a bare literal, so
  // lowering UI_STATUS_LOOP_CAP would leave the manifest advertising a bound the body no longer
  // has — the same class of lie the ABAP assertions exist to prevent, one layer up. Scanning every
  // builtin manifest for the phrasing (rather than reaching into `ui`'s fkeys node by path) means a
  // second action that repeats the sentence is pinned too. The expectation is an exact list, in the
  // style of the `_capped` check below, so that a rewording which drops the sentence fails loudly
  // here instead of quietly turning this assertion vacuous.
  it(`the manifest descriptions that quote a status bound quote UI_STATUS_LOOP_CAP (${UI_STATUS_LOOP_CAP})`, () => {
    const quoted: string[] = [];
    for (const tool of BUILTIN_FLUID_TOOLS) {
      for (const m of JSON.stringify(tool.manifest).matchAll(/up to (\d+) statuses/g)) {
        quoted.push(`${tool.manifest.id}: ${m[1]}`);
      }
    }
    expect(
      quoted.sort(),
      "a manifest description names a status bound that is not UI_STATUS_LOOP_CAP; change the description, or the constant and the ABAP with it",
    ).toEqual([`ui: ${UI_STATUS_LOOP_CAP}`]);
  });

  it("no builtin's ABAP raises a truncation flag that is not one of the two pinned above", () => {
    const found: string[] = [];
    for (const tool of BUILTIN_FLUID_TOOLS) {
      for (const obj of tool.manifest.objects) {
        const source = tool.sources.get(obj.name) ?? "";
        // Anchored to the start of a statement and required to end in `.` so this counts
        // ASSIGNMENTS that raise the flag, not the `IF lv_x_capped = abap_true.` comparisons
        // that later read it back when rendering the JSON.
        for (const m of source.matchAll(/^[ \t]*(\w*_capped)\s*=\s*abap_true\s*\./gim)) {
          found.push(`${tool.manifest.id}/${obj.name}: ${m[1]}`);
        }
      }
    }
    expect(found.sort()).toEqual([
      `ui/${UI_BODY_CLASS}: lv_fkeys_capped`,
      `ui/${UI_BODY_CLASS}: lv_status_capped`,
    ]);
  });
});

// Only `obj.description` (FluidObjectSpec.description, per manifest object) ever reaches ADT: it
// is forwarded verbatim by writeAndActivateOnce (ensure.ts:247-252) into the `spec` handed to
// authorizeMutation / createObject (write.ts:3211) as the object's short text. Manifest-level
// FluidManifest.description and per-action FluidActionSpec.description are never read on that
// path — a grep of src/adt/fluid for `.description` turns up exactly one call site outside
// manifest.ts's own schema and the builtin definition files that populate these manifests:
// ensure.ts:251's `description: obj.description`. So only the per-object field needs this guard.
describe("BUILTIN_FLUID_TOOLS manifests: object description guard has teeth", () => {
  it("accepts a 60-character description", () => {
    expect(describeDescriptionProblem("x".repeat(60))).toBeUndefined();
  });

  it("rejects a 61-character description", () => {
    expect(describeDescriptionProblem("x".repeat(61))).toBeDefined();
  });

  it("rejects an empty description", () => {
    expect(describeDescriptionProblem("")).toBeDefined();
  });
});
