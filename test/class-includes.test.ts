/**
 * A global class's five source includes, end to end.
 *
 * ADT splits a global class over `main`, `definitions` (CCDEF),
 * `implementations` (CCIMP), `macros` (CCMAC) and `testclasses` (CCAU).
 * ABAP Unit test classes live in CCAU, so until the write path could address
 * an include, **abapsmith could not write an ABAP Unit test at all** — the
 * agent could write the class and not its tests.
 *
 * ## What this file is for
 *
 * The per-layer mechanics are already pinned where they live:
 *   - `test/types.test.ts`   — `classIncludeUri` / `specFromUri` URI shapes.
 *   - `test/resolve.test.ts` — the include survives `parseObjectRef` /
 *                              `resolveObject`.
 *   - `test/source.test.ts`  — `readSource` fetches the include, not main.
 *   - `test/write.test.ts`   — `resolveWriteTarget`'s include routing and its
 *                              refusals (describe: "class includes").
 *
 * This file pins the things that are only visible ACROSS those layers, and
 * that no single-layer suite can state:
 *
 *   1. **The never-silently-downgrade invariant, swept over every writable
 *      type.** Both entry points — `sourceUriFor` on the read side and
 *      `resolveWriteTarget` on the write side — must refuse an include on a
 *      non-class rather than answer with the main source. A single type that
 *      leaked through would silently overwrite a whole object with a test
 *      class, or hand a caller the class body while it believed it held the
 *      tests. This is the single most important property in the issue and the
 *      one both source files state in prose.
 *   2. The boundary between what the TYPE system can police and what only
 *      `assertClassInclude` can: the include name arrives from a tool
 *      argument, i.e. as an arbitrary string.
 *   3. The tool surface itself — see the PENDING SIBLING MERGE section at the
 *      bottom, which is expected to be RED until the schema branches land.
 *
 * Everything here is offline. Nothing in this file opens a socket: the two
 * entry points refuse before their first request, which is exactly what the
 * `null` connection below proves.
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import { parseObjectRef } from "../src/adt/resolve.js";
import { sourceUriFor } from "../src/adt/source.js";
import {
  CLASS_INCLUDES,
  assertClassInclude,
  buildUri,
  classIncludeUri,
  isClassInclude,
  specForType,
  type ClassInclude,
} from "../src/adt/types.js";
import { WRITABLE_TYPES, resolveWriteTarget } from "../src/adt/write.js";
import { WriteInput, targetFromInput, writeInputSchema } from "../src/tools/write.js";
import { readInputSchema } from "../src/tools/read.js";

const CLASS_URI = "/sap/bc/adt/oo/classes/zcl_foo";

/** The four that are NOT `main` — the ones that were unreachable before the include write path landed. */
const SUB_INCLUDES = ["definitions", "implementations", "macros", "testclasses"] as const;

/**
 * A `null` connection. Every refusal in this file has to happen before a byte
 * goes on the wire; a connection that would explode on touch is the only way
 * to prove that, rather than asserting on a request log that a lenient fake
 * might never have been asked to produce.
 */
const OFFLINE = null as unknown as AbapConnection;

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

/** A minimal read-side target, exactly as `resolveObject` would shape one. */
function readTarget(typeCode: string, name: string): ResolvedObject {
  const spec = specForType(typeCode)!;
  const uri = buildUri(spec, name, spec.parentPath ? "ZMCP_FG" : undefined);
  return {
    system: "A4H",
    type: spec.type,
    kind: spec.kind,
    label: spec.label,
    name,
    uri,
    sourceUri: spec.supportsSource ? `${uri}/source/main` : undefined,
    mode: spec.mode,
    spec,
  } as unknown as ResolvedObject;
}

// ---------------------------------------------------------------------------
// 1. The invariant, swept over every writable type
// ---------------------------------------------------------------------------

describe("an include is NEVER silently downgraded to the main source", () => {
  /**
   * Exhaustive over `WRITABLE_TYPES`, not over a hand-picked sample, and
   * deliberately so: the failure this guards against is a type-specific bypass
   * — a new type added to the registry whose branch reaches `sourceUri`
   * without passing the include check. A sample of four cannot see that; the
   * whole set can, and it fails the moment a type is added without a decision
   * having been made about it.
   */
  const NON_CLASS_WRITABLE = WRITABLE_TYPES.filter((t) => t !== "CLAS/OC");

  it("covers more than a token sample of types", () => {
    // Guards the sweeps below against silently becoming vacuous if
    // WRITABLE_TYPES is ever computed differently.
    expect(NON_CLASS_WRITABLE.length).toBeGreaterThan(10);
    expect(NON_CLASS_WRITABLE).not.toContain("CLAS/OC");
  });

  /**
   * The fixture name each type's own `resolveWriteTarget` pre-flight can
   * live with, so the include check — not a name-shape guard that runs
   * earlier — is what fires. `TYPE/DG` (type groups) is the one type with a
   * server-enforced name rule stricter than the generic 30-char length
   * check: A4H rejects an underscore in a type-group name with 403 "Do not
   * use underscores in type group names", and TYPE-POOL names cap at 5
   * characters (both checked in `resolveWriteTarget` before the include
   * check). `ZMCP_INC` trips that guard, so `TYPE/DG` needs its own
   * 5-character, underscore-free name here — every other writable type
   * keeps the shared fixture. Do not collapse this back to one constant:
   * that is exactly the "TYPE/DG's own rule was never exercised" regression
   * this sweep exists to catch.
   */
  function fixtureNameFor(type: string): string {
    return type === "TYPE/DG" ? "ZMCPI" : "ZMCP_INC";
  }

  it("write side: resolveWriteTarget refuses `include` on every non-class writable type", async () => {
    for (const type of NON_CLASS_WRITABLE) {
      const spec = specForType(type)!;
      const e = await catchErr(
        resolveWriteTarget(OFFLINE, {
          name: fixtureNameFor(type),
          type,
          include: "testclasses",
          ...(spec.parentPath ? { containerName: "ZMCP_FG" } : {}),
        }),
      );
      expect(e.code, type).toBe("BAD_INPUT");
      expect(e.message, type).toContain("testclasses");
      expect(e.details.type, type).toBe(type);
      // The refusal must not read as "we wrote main instead".
      expect(e.hint ?? "", type).toMatch(/NOT silently redirected/i);
    }
  });

  it("read side: sourceUriFor refuses `include` on every non-class writable type", () => {
    for (const type of NON_CLASS_WRITABLE) {
      const obj = readTarget(type, "ZMCP_INC");
      let threw: AbapError | undefined;
      try {
        // If this ever RETURNS, it returns the main source URI for an object
        // the caller asked a `testclasses` question about — the exact silent
        // substitution. `expect.unreachable` reports the returned value so a
        // regression names the URI it would have handed back.
        const got = sourceUriFor(obj, "testclasses");
        expect.unreachable(`${type} answered ${got} instead of refusing`);
      } catch (e) {
        if (!isAbapError(e)) throw e;
        threw = e;
      }
      expect(threw?.code, type).toBe("UNSUPPORTED");
      expect(threw?.message, type).toContain("testclasses");
      expect(threw?.hint ?? "", type).toMatch(/NOT silently answered/i);
    }
  });

  it("both sides agree on the four includes, not just on testclasses", async () => {
    for (const include of SUB_INCLUDES) {
      const write = await catchErr(
        resolveWriteTarget(OFFLINE, { name: "ZMCP_REP", type: "PROG/P", include }),
      );
      expect(write.code, include).toBe("BAD_INPUT");
      expect(write.message, include).toContain(include);

      expect(() => sourceUriFor(readTarget("PROG/P", "ZMCP_REP"), include)).toThrow(AbapError);
    }
  });

  it("`main` is the ONE include a non-class may name, because it means \"no include\"", () => {
    // Asymmetric on purpose. `main` is not a class-only concept: it is the
    // canonical source document every source-shape type has. Refusing it would
    // make `include:"main"` a type-dependent error for no gain, and it cannot
    // cause a substitution — main IS the main source.
    const prog = readTarget("PROG/P", "ZMCP_REP");
    // `buildUri` lowercases the name segment, as every ADT URI in this repo does.
    expect(sourceUriFor(prog, "main")).toBe("/sap/bc/adt/programs/programs/zmcp_rep/source/main");
    expect(sourceUriFor(prog)).toBe(sourceUriFor(prog, "main"));
  });
});

// ---------------------------------------------------------------------------
// 2. The string boundary: `assertClassInclude` vs `isClassInclude`
// ---------------------------------------------------------------------------

describe("include names arrive as arbitrary strings, and are policed as such", () => {
  it("assertClassInclude normalises case and space; isClassInclude does NOT", () => {
    // The two are not interchangeable and the difference is deliberate.
    // `isClassInclude` is a type guard over a value that is already canonical
    // (e.g. a URI segment, where `Testclasses` is a different path). Only
    // `assertClassInclude` sits on the human/tool boundary, so only it
    // normalises. Collapsing the two in either direction is a real bug: a
    // lenient guard would let `Testclasses` through into a URI that 404s.
    expect(assertClassInclude("TESTCLASSES")).toBe("testclasses");
    expect(assertClassInclude("  TestClasses  ")).toBe("testclasses");
    expect(assertClassInclude("Main")).toBe("main");
    expect(isClassInclude("TESTCLASSES")).toBe(false);
    expect(isClassInclude("  testclasses  ")).toBe(false);
    expect(isClassInclude("testclasses")).toBe(true);
  });

  it("names every supported include in the refusal, and says it did not fall back", () => {
    for (const bad of ["tests", "ccau", "CCAU", "local", "", "  ", "main2", "definition"]) {
      let err: AbapError | undefined;
      try {
        assertClassInclude(bad, CLASS_URI);
        expect.unreachable(`${JSON.stringify(bad)} was accepted`);
      } catch (e) {
        if (!isAbapError(e)) throw e;
        err = e;
      }
      expect(err?.code, bad).toBe("UNSUPPORTED");
      expect(err?.details.supported, bad).toEqual([...CLASS_INCLUDES]);
      // `ccau` is the SE24/SE80 name for testclasses and is the single most
      // likely wrong guess; the refusal has to name the ADT spelling so the
      // caller can retry without reading the source.
      expect(err?.message, bad).toContain("testclasses");
      expect(err?.hint ?? "", bad).toMatch(/NOT silently answered/i);
    }
  });

  it("keeps the requested string verbatim in the error, un-normalised", () => {
    // The caller has to be able to recognise what they typed. Reporting the
    // trimmed/lowercased form back would hide a stray character.
    const e = (() => {
      try {
        assertClassInclude(" CCAU ");
        return undefined;
      } catch (err) {
        return err as AbapError;
      }
    })();
    expect(e?.details.requested).toBe(" CCAU ");
    expect(e?.message).toContain('" CCAU "');
  });
});

// ---------------------------------------------------------------------------
// 3. `classIncludeUri` idempotence beyond what test/types.test.ts covers
// ---------------------------------------------------------------------------

describe("classIncludeUri never double-suffixes", () => {
  it("strips a suffix the input already carries, for every from/to pair", () => {
    // 6 × 5 = 30 pairs. `classBaseUri` is what makes this hold, and a
    // regression in it produces `…/includes/macros/includes/testclasses`,
    // which resolves to nothing and surfaces as a mystifying 404 rather than
    // as the URI-building bug it is.
    const inputs = [
      CLASS_URI,
      `${CLASS_URI}/source/main`,
      `${CLASS_URI}/includes/main`, // the accepted input alias for main
      ...SUB_INCLUDES.map((i) => `${CLASS_URI}/includes/${i}`),
    ];
    for (const from of inputs) {
      for (const to of CLASS_INCLUDES) {
        const got = classIncludeUri(from, to);
        expect(got, `${from} -> ${to}`).toBe(
          to === "main" ? `${CLASS_URI}/source/main` : `${CLASS_URI}/includes/${to}`,
        );
        expect(got.match(/\/includes\//g)?.length ?? 0, `${from} -> ${to}`).toBeLessThan(2);
      }
    }
  });

  it("ignores a trailing slash, a query string and a fragment", () => {
    expect(classIncludeUri(`${CLASS_URI}/`, "testclasses")).toBe(`${CLASS_URI}/includes/testclasses`);
    expect(classIncludeUri(`${CLASS_URI}/source/main?version=active`, "testclasses")).toBe(
      `${CLASS_URI}/includes/testclasses`,
    );
    expect(classIncludeUri(`${CLASS_URI}/includes/definitions#frag`, "macros")).toBe(
      `${CLASS_URI}/includes/macros`,
    );
  });

  it("is total but UNGUARDED — the type check lives at its two callers", () => {
    // Documented rather than defended here. `classIncludeUri` is a pure URI
    // builder: handed a program URI it happily builds a nonsense one. That is
    // not a defect to fix in it — `sourceUriFor` (read) and
    // `resolveWriteTarget` (write) are the only two callers and BOTH refuse a
    // non-class before calling it, which the sweeps at the top of this file
    // prove type by type. This test exists so the layering is a stated fact:
    // if a THIRD caller ever appears, it owns the same check.
    const nonsense = classIncludeUri("/sap/bc/adt/programs/programs/zmcp_rep", "testclasses");
    expect(nonsense).toContain("/includes/testclasses");
    expect(nonsense).not.toContain("/oo/classes/");
  });
});

// ---------------------------------------------------------------------------
// 4. The read route that ALREADY works — reachable today, and it must stay so
// ---------------------------------------------------------------------------

describe("an include is addressable through the object reference itself", () => {
  it("parseObjectRef keeps the include off an ADT include URI", () => {
    // This is the route `abap_read`'s own BAD_INPUT hint points callers at
    // today ("address the include through the object reference itself"). It is
    // the reason the READ half is a reachability/ergonomics gap rather
    // than a missing capability — see this file's report. It must keep working
    // after the `include` parameter is added, not be replaced by it.
    for (const include of SUB_INCLUDES) {
      expect(parseObjectRef(`${CLASS_URI}/includes/${include}`).include).toBe(include);
    }
    // Naming no include is not the same fact as naming `main`.
    expect(parseObjectRef(CLASS_URI).include).toBeUndefined();
    expect(parseObjectRef(`${CLASS_URI}/source/main`).include).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. The default: saying nothing means `main`
// ---------------------------------------------------------------------------

describe("omitting `include` means the main source, at every layer", () => {
  it("targetFromInput carries no include when none was asked for", () => {
    const t = targetFromInput(WriteInput.parse({ object: "ZCL_FOO", source: "x" }));
    // Written as a two-way assertion rather than `toBeUndefined()` on purpose:
    // whether the schema spells the default as `undefined` or as an explicit
    // `"main"` is the schema branch's choice, and both are correct. What must
    // NEVER be true is that it arrives as one of the four sub-includes.
    expect(t.include === undefined || t.include === "main").toBe(true);
  });

  it("resolveWriteTarget's own default is /source/main", async () => {
    // Pinned via the refusal path so this needs no connection: a PROG/P with
    // no include resolves without the include check firing at all.
    const e = await catchErr(resolveWriteTarget(OFFLINE, { name: "ZCL_FOO=>M" }));
    expect(e.code).toBe("BAD_INPUT"); // member refusal, i.e. we got past include handling
  });
});

// ===========================================================================
// PENDING SIBLING MERGE
// ===========================================================================
//
// EXPECTED TO FAIL until the two tool-schema branches for include support land:
//
//   * `abap_write`'s schema gaining an optional `include`
//     (src/tools/write.ts) and `targetFromInput` forwarding it.
//   * `abap_read`'s `include` being routed into the SOURCE read path rather
//     than being refused unless `view=` was also given (src/tools/read.ts).
//
// They are written against the contract those branches are specified to
// deliver, NOT weakened to pass today, and NOT skipped: a skipped test for an
// unlanded change is indistinguishable from no test at all, and this is the
// half of that gap the issue is actually about ("the agent can write the class but
// cannot write its unit tests"). Every assertion below is reachable through
// the tool surface, which is the only surface an MCP client has.
//
// The schemas are read through an index signature rather than a property
// access so this file typechecks before the fields exist; that is the only
// concession made to the merge order.
// ===========================================================================

/** `writeInputSchema` as the zod-shape record it is, so an absent key is a RUNTIME failure. */
const writeShape = writeInputSchema as unknown as Record<string, z.ZodTypeAny | undefined>;

describe("[PENDING SIBLING MERGE] abap_write exposes `include`", () => {
  it("declares an `include` field constrained to exactly the five ADT includes", () => {
    const field = writeShape.include;
    expect(field, "abap_write has no `include` field").toBeDefined();
    for (const include of CLASS_INCLUDES) {
      expect(field!.safeParse(include).success, include).toBe(true);
    }
    // The SE24/SE80 spellings and near-misses must not be accepted at the
    // schema boundary — a `z.string()` here would push the refusal all the way
    // down to a 404 from ADT.
    for (const bad of ["tests", "ccau", "CCAU", "local", "definition"]) {
      expect(field!.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("says what the parameter is FOR — the description names testclasses", () => {
    // The tool description is the only documentation an MCP client ever sees.
    // "which include to write" does not tell a model that ABAP Unit tests live
    // in `testclasses`, which is the entire point of the parameter.
    const description = writeShape.include?.description ?? "";
    expect(description).toMatch(/testclasses/i);
  });

  it("carries the include from tool input through to the WriteTarget", () => {
    // The defect this shape of test caught before (see `writeInputSchema`'s
    // own comment about `edit`/`method`): the MCP SDK hands the callback the
    // PARSED object and zod STRIPS undeclared keys, so a field that is not
    // declared here vanishes silently between the client and the write path.
    // A declared-but-unforwarded field fails the same way.
    const parsed = WriteInput.parse({
      object: "ZCL_FOO",
      source: "CLASS ltcl_foo DEFINITION FOR TESTING.",
      include: "testclasses",
    }) as unknown as Record<string, unknown>;
    expect(parsed.include, "zod stripped `include` — it is not declared").toBe("testclasses");
    expect(targetFromInput(parsed as unknown as WriteInput).include).toBe("testclasses");
  });

  it("forwards every one of the five, not just testclasses", () => {
    for (const include of CLASS_INCLUDES) {
      const parsed = WriteInput.parse({ object: "ZCL_FOO", source: "x", include });
      expect(targetFromInput(parsed).include, include).toBe(include);
    }
  });

  it("rejects an unknown include at the schema boundary, before any connection", () => {
    expect(WriteInput.safeParse({ object: "ZCL_FOO", source: "x", include: "ccau" }).success).toBe(
      false,
    );
  });
});

describe("[PENDING SIBLING MERGE] abap_read's `include` reaches the source read", () => {
  it("no longer advertises itself as `view=`-only", () => {
    // Today `include` exists on the read schema but is gated: without a
    // `view`, `abapRead` refuses it with BAD_INPUT ("include is only
    // meaningful with view=history"). Once it routes into the SOURCE path,
    // that description is false and would send callers to the version-history
    // machinery to read a test class.
    const description = (readInputSchema.include as z.ZodTypeAny).description ?? "";
    expect(description).not.toMatch(/view=\s*only/i);
    expect(description).toMatch(/testclasses/i);
  });
});
