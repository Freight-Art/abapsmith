/**
 * Type registry — class-include URI construction (C2) and the dead subtype
 * fallback in `specForType` (C8).
 */
import { describe, expect, it } from "vitest";
import { AbapError } from "../src/adt/errors.js";
import {
  CLASS_INCLUDES,
  TYPES,
  assertClassInclude,
  buildUri,
  classIncludeUri,
  isClassInclude,
  specForType,
  specFromUri,
} from "../src/adt/types.js";

const CLASS_URI = "/sap/bc/adt/oo/classes/zcl_foo";

describe("C2: class include URIs", () => {
  it("builds the ADT shape for every sub-include", () => {
    expect(classIncludeUri(CLASS_URI, "testclasses")).toBe(`${CLASS_URI}/includes/testclasses`);
    expect(classIncludeUri(CLASS_URI, "definitions")).toBe(`${CLASS_URI}/includes/definitions`);
    expect(classIncludeUri(CLASS_URI, "implementations")).toBe(
      `${CLASS_URI}/includes/implementations`,
    );
    expect(classIncludeUri(CLASS_URI, "macros")).toBe(`${CLASS_URI}/includes/macros`);
    // `main` keeps the canonical /source/main form every other type uses.
    expect(classIncludeUri(CLASS_URI, "main")).toBe(`${CLASS_URI}/source/main`);
  });

  it("is idempotent when the input already carries a suffix", () => {
    expect(classIncludeUri(`${CLASS_URI}/source/main`, "testclasses")).toBe(
      `${CLASS_URI}/includes/testclasses`,
    );
    expect(classIncludeUri(`${CLASS_URI}/includes/definitions`, "testclasses")).toBe(
      `${CLASS_URI}/includes/testclasses`,
    );
    expect(classIncludeUri(`${CLASS_URI}/includes/testclasses`, "main")).toBe(
      `${CLASS_URI}/source/main`,
    );
  });

  it("knows exactly the five includes ADT exposes", () => {
    expect([...CLASS_INCLUDES].sort()).toEqual(
      ["definitions", "implementations", "macros", "main", "testclasses"].sort(),
    );
    expect(isClassInclude("testclasses")).toBe(true);
    expect(isClassInclude("tests")).toBe(false);
  });
});

describe("C2: specFromUri preserves the requested include", () => {
  it("returns the testclasses include, NOT the main class", () => {
    const hit = specFromUri(`${CLASS_URI}/includes/testclasses`)!;
    expect(hit.spec.type).toBe("CLAS/OC");
    expect(hit.name).toBe("ZCL_FOO");
    // The C2 bug: the include was deleted and the caller silently received main.
    expect(hit.include).toBe("testclasses");
    expect(hit.sourceUri).toContain("includes/testclasses");
    expect(hit.sourceUri).not.toBe(`${CLASS_URI}/source/main`);
  });

  it("carries every sub-include through", () => {
    for (const inc of ["definitions", "implementations", "macros", "testclasses"] as const) {
      const hit = specFromUri(`${CLASS_URI}/includes/${inc}`)!;
      expect(hit.include).toBe(inc);
      expect(hit.sourceUri).toBe(`${CLASS_URI}/includes/${inc}`);
    }
    const main = specFromUri(`${CLASS_URI}/includes/main`)!;
    expect(main.include).toBe("main");
    expect(main.sourceUri).toBe(`${CLASS_URI}/source/main`);
  });

  it("leaves a plain class URI alone", () => {
    const hit = specFromUri(CLASS_URI)!;
    expect(hit.include).toBeUndefined();
    expect(hit.sourceUri).toBeUndefined();
    expect(specFromUri(`${CLASS_URI}/source/main`)!.include).toBeUndefined();
  });

  it("is LOUD about an include ADT does not have", () => {
    expect(() => specFromUri(`${CLASS_URI}/includes/tests`)).toThrow(AbapError);
    try {
      specFromUri(`${CLASS_URI}/includes/tests`);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as AbapError;
      expect(err.code).toBe("UNSUPPORTED");
      expect(err.message).toContain("tests");
      expect(err.message).toContain("testclasses");
      expect(err.details.supported).toEqual([...CLASS_INCLUDES]);
    }
    expect(() => assertClassInclude("locals")).toThrow(/Unknown class include "locals"/);
  });

  it("does not mistake a program include NAMED main/macros for a class include", () => {
    // The old strip was unscoped, so `/programs/includes/main` lost its last
    // segment and resolved to nothing.
    for (const name of ["main", "macros", "testclasses", "zfoo_top"]) {
      const hit = specFromUri(`/sap/bc/adt/programs/includes/${name}`)!;
      expect(hit.spec.type).toBe("PROG/I");
      expect(hit.name).toBe(name.toUpperCase());
      expect(hit.include).toBeUndefined();
    }
    const fugr = specFromUri("/sap/bc/adt/functions/groups/zfg/includes/main")!;
    expect(fugr.spec.type).toBe("FUGR/I");
    expect(fugr.name).toBe("MAIN");
  });
});

describe("C8: the removed BY_TYPE subtype fallback could never match", () => {
  it("proves no `<KIND>/<first two letters>` key exists in the registry", () => {
    const realTypeCodes = new Set(TYPES.map((t) => t.type));
    const candidates = new Set<string>();
    for (const t of TYPES) {
      for (const key of [t.type, t.kind]) {
        const upper = key.toUpperCase();
        candidates.add(`${upper}/${upper.slice(0, 2)}`);
      }
    }
    // Evidence for the removal: not one generated key is a registry key.
    const collisions = [...candidates].filter((c) => realTypeCodes.has(c));
    expect(collisions).toEqual([]);
    expect(candidates.has("CLAS/CL")).toBe(true); // the fallback would have built this
    expect(realTypeCodes.has("CLAS/CL")).toBe(false); // …and nothing answers to it
  });

  it("resolves every kind and type code without the fallback", () => {
    for (const t of TYPES) {
      expect(specForType(t.type)?.type).toBe(t.type);
      expect(specForType(t.kind)).toBeDefined();
      expect(specForType(t.type.toLowerCase())?.type).toBe(t.type);
    }
    expect(specForType("CLAS")?.type).toBe("CLAS/OC");
    expect(specForType("TABL")?.type).toBe("TABL/DT");
    expect(specForType("STRU")?.type).toBe("TABL/DS");
  });

  it("still returns undefined for a made-up code", () => {
    expect(specForType("CLAS/CL")).toBeUndefined();
    expect(specForType("DTEL/DT")).toBeUndefined();
    expect(specForType("ZZZZ")).toBeUndefined();
    expect(specForType(undefined)).toBeUndefined();
  });

  it("round-trips buildUri/specFromUri for every single-segment type", () => {
    for (const spec of TYPES) {
      if (spec.parentPath) continue;
      const back = specFromUri(buildUri(spec, "ZFOO"));
      expect(back?.spec.type, spec.type).toBe(spec.type);
      expect(back?.name).toBe("ZFOO");
    }
  });

  it("percent-encodes a customer-namespace name for every writable kind", () => {
    expect(buildUri(specForType("CLAS/OC")!, "/CUST/CL_FOO")).toBe(
      "/sap/bc/adt/oo/classes/%2Fcust%2Fcl_foo",
    );
    expect(buildUri(specForType("INTF/OI")!, "/CUST/IF_FOO")).toBe(
      "/sap/bc/adt/oo/interfaces/%2Fcust%2Fif_foo",
    );
    expect(buildUri(specForType("PROG/P")!, "/CUST/ZPROG")).toBe(
      "/sap/bc/adt/programs/programs/%2Fcust%2Fzprog",
    );
    expect(buildUri(specForType("FUGR/FF")!, "/CUST/Z_MODULE", "/CUST/ZGROUP")).toBe(
      "/sap/bc/adt/functions/groups/%2Fcust%2Fzgroup/fmodules/%2Fcust%2Fz_module",
    );
    expect(buildUri(specForType("DDLS/DF")!, "/CUST/ZCDS")).toBe(
      "/sap/bc/adt/ddic/ddl/sources/%2Fcust%2Fzcds",
    );
    expect(buildUri(specForType("TABL/DT")!, "/CUST/ZTAB")).toBe(
      "/sap/bc/adt/ddic/tables/%2Fcust%2Fztab",
    );
    // Plain customer names carry no separator, so nothing needs encoding.
    expect(buildUri(specForType("CLAS/OC")!, "ZCL_PLAIN")).toBe(
      "/sap/bc/adt/oo/classes/zcl_plain",
    );
  });

  it("round-trips a namespaced name through buildUri/specFromUri, slashes and case intact", () => {
    const spec = specForType("CLAS/OC")!;
    const uri = buildUri(spec, "/CUST/CL_FOO");
    expect(uri).not.toContain("//");
    expect(uri).toBe("/sap/bc/adt/oo/classes/%2Fcust%2Fcl_foo");

    const back = specFromUri(uri)!;
    expect(back.name).toBe("/CUST/CL_FOO");
    expect(back.spec.type).toBe("CLAS/OC");

    // Idempotent: feeding the recovered name back through builds the same URI.
    expect(buildUri(back.spec, back.name)).toBe(uri);

    const plain = specFromUri(buildUri(spec, "ZCL_PLAIN"))!;
    expect(plain.name).toBe("ZCL_PLAIN");
    expect(plain.spec.type).toBe("CLAS/OC");
  });
});
