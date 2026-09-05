/**
 * Fuzzy object resolution.
 * "The model will not reliably produce type codes and shouldn't have to."
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  activationFromVersion,
  checkActivation,
  parseObjectRef,
  resolveObject,
  resolveObjectWithActivation,
} from "../src/adt/resolve.js";
import { buildUri, specForType, specFromUri } from "../src/adt/types.js";
import { isAbapError } from "../src/adt/errors.js";
import { capabilitiesFor, REGISTRY, type TypeCode } from "../src/adt/capabilities.js";

describe("parseObjectRef — fuzzy forms", () => {
  it("takes a bare name and guesses nothing it cannot justify", () => {
    const r = parseObjectRef("ZTABLE_FOO");
    expect(r.name).toBe("ZTABLE_FOO");
    expect(r.spec).toBeUndefined();
    expect(r.via).toBe("unknown");
  });

  it("uses naming convention as a hint only", () => {
    expect(parseObjectRef("ZCL_FOO").spec?.type).toBe("CLAS/OC");
    expect(parseObjectRef("ZCL_FOO").via).toBe("convention");
    expect(parseObjectRef("ZIF_FOO").spec?.type).toBe("INTF/OI");
    expect(parseObjectRef("CL_ABAP_TYPEDESCR").spec?.type).toBe("CLAS/OC");
  });

  it("understands English keyword prefixes", () => {
    expect(parseObjectRef("class ZCL_FOO").spec?.type).toBe("CLAS/OC");
    expect(parseObjectRef("interface ZIF_BAR").spec?.type).toBe("INTF/OI");
    expect(parseObjectRef("program ZDEMO1").spec?.type).toBe("PROG/P");
    expect(parseObjectRef("report ZDEMO1").spec?.type).toBe("PROG/P");
    expect(parseObjectRef("table SFLIGHT").spec?.type).toBe("TABL/DT");
    expect(parseObjectRef("structure BAPIRET2").spec?.type).toBe("TABL/DS");
    expect(parseObjectRef("data element MATNR").spec?.type).toBe("DTEL/DE");
    expect(parseObjectRef("domain XFELD").spec?.type).toBe("DOMA/DD");
    expect(parseObjectRef("table type STRING_TABLE").spec?.type).toBe("TTYP/DA");
    expect(parseObjectRef("cds view I_SALESORDER").spec?.type).toBe("DDLS/DF");
    expect(parseObjectRef("function group ZOTH_FG_ORDER").spec?.type).toBe("FUGR/F");
    expect(parseObjectRef("class ZCL_FOO").via).toBe("keyword");
  });

  it("prefers the longest keyword: 'function module' beats 'function'", () => {
    const r = parseObjectRef("function module BAL_LOG_CREATE in SBAL");
    expect(r.spec?.type).toBe("FUGR/FF");
    expect(r.name).toBe("BAL_LOG_CREATE");
    expect(r.parent).toBe("SBAL");
  });

  it("accepts explicit ADT type codes and bare kinds", () => {
    expect(parseObjectRef("CLAS/OC ZCL_FOO").spec?.type).toBe("CLAS/OC");
    expect(parseObjectRef("CLAS ZCL_FOO").spec?.type).toBe("CLAS/OC");
    expect(parseObjectRef("DDLS/DF ZDEMO_C_SALESORDER").spec?.type).toBe("DDLS/DF");
    expect(parseObjectRef("TABL/DT SFLIGHT").via).toBe("typecode");
  });

  it("extracts a member selector", () => {
    expect(parseObjectRef("ZCL_FOO=>CALCULATE").member).toBe("CALCULATE");
    expect(parseObjectRef("ZCL_FOO->calculate").member).toBe("CALCULATE");
    expect(parseObjectRef("class ZCL_FOO=>CALCULATE").name).toBe("ZCL_FOO");
  });

  it("splits FUGR/FM shorthand", () => {
    const r = parseObjectRef("function module SBAL/BAL_LOG_CREATE");
    expect(r.parent).toBe("SBAL");
    expect(r.name).toBe("BAL_LOG_CREATE");
  });

  it("does not treat a /NAMESPACE/ object as parent/name", () => {
    const r = parseObjectRef("class /DMO/CL_FLIGHT");
    expect(r.name).toBe("/DMO/CL_FLIGHT");
    expect(r.parent).toBeUndefined();
  });

  it("uppercases and trims", () => {
    expect(parseObjectRef("  class   zcl_foo  ").name).toBe("ZCL_FOO");
  });

  it("rejects garbage with a structured error", () => {
    try {
      parseObjectRef("!!!");
      expect.unreachable();
    } catch (e) {
      expect(isAbapError(e)).toBe(true);
      expect((e as { code: string }).code).toBe("BAD_INPUT");
    }
  });
});

describe("parseObjectRef — URIs", () => {
  const cases: Array<[string, string, string]> = [
    ["/sap/bc/adt/oo/classes/zcl_foo", "CLAS/OC", "ZCL_FOO"],
    ["/sap/bc/adt/oo/classes/zcl_foo/source/main", "CLAS/OC", "ZCL_FOO"],
    ["/sap/bc/adt/oo/interfaces/zif_foo", "INTF/OI", "ZIF_FOO"],
    ["/sap/bc/adt/programs/programs/zdemo1/source/main", "PROG/P", "ZDEMO1"],
    ["/sap/bc/adt/programs/includes/zothbadicheck_inc", "PROG/I", "ZOTHBADICHECK_INC"],
    ["/sap/bc/adt/ddic/tables/sflight/source/main", "TABL/DT", "SFLIGHT"],
    ["/sap/bc/adt/ddic/structures/bapiret2", "TABL/DS", "BAPIRET2"],
    ["/sap/bc/adt/ddic/dataelements/matnr", "DTEL/DE", "MATNR"],
    ["/sap/bc/adt/ddic/domains/xfeld", "DOMA/DD", "XFELD"],
    ["/sap/bc/adt/ddic/tabletypes/string_table", "TTYP/DA", "STRING_TABLE"],
    ["/sap/bc/adt/ddic/ddl/sources/i_salesorder/source/main", "DDLS/DF", "I_SALESORDER"],
    ["/sap/bc/adt/functions/groups/sbal", "FUGR/F", "SBAL"],
    ["http://host:50000/sap/bc/adt/oo/classes/zcl_foo", "CLAS/OC", "ZCL_FOO"],
  ];

  for (const [uri, type, name] of cases) {
    it(`maps ${uri} → ${type} ${name}`, () => {
      const r = parseObjectRef(uri);
      expect(r.spec?.type).toBe(type);
      expect(r.name).toBe(name);
      expect(r.via).toBe("uri");
    });
  }

  it("handles the two-segment function-module URI", () => {
    const r = parseObjectRef("/sap/bc/adt/functions/groups/sbal/fmodules/bal_log_create/source/main");
    expect(r.spec?.type).toBe("FUGR/FF");
    expect(r.name).toBe("BAL_LOG_CREATE");
    expect(r.parent).toBe("SBAL");
    expect(r.uri).toBe("/sap/bc/adt/functions/groups/sbal/fmodules/bal_log_create");
  });

  it("derives the group regardless of letter case, but no parent from the group's own address or an unrelated kind", () => {
    const mixed = parseObjectRef(
      "/sap/bc/adt/Functions/Groups/Sbal/Fmodules/Bal_Log_Create/source/main",
    );
    expect(mixed.parent).toBe("SBAL");
    expect(mixed.name).toBe("BAL_LOG_CREATE");

    expect(parseObjectRef("/sap/bc/adt/functions/groups/sbal").parent).toBeUndefined();
    expect(parseObjectRef("/sap/bc/adt/oo/classes/zcl_foo").parent).toBeUndefined();
  });

  it("handles class include URIs", () => {
    const r = parseObjectRef("/sap/bc/adt/oo/classes/zcl_foo/includes/implementations");
    expect(r.spec?.type).toBe("CLAS/OC");
    expect(r.name).toBe("ZCL_FOO");
  });

  it("keeps the include on the parsed ref instead of dropping it", () => {
    expect(parseObjectRef("/sap/bc/adt/oo/classes/zcl_foo/includes/testclasses").include).toBe(
      "testclasses",
    );
    // No include named is NOT the same fact as "main".
    expect(parseObjectRef("/sap/bc/adt/oo/classes/zcl_foo").include).toBeUndefined();
    expect(parseObjectRef("/sap/bc/adt/oo/classes/zcl_foo/source/main").include).toBeUndefined();
  });

  it("accepts the abap:// resource form", () => {
    const r = parseObjectRef("abap://A4H/CLAS/ZCL_FOO");
    expect(r.spec?.type).toBe("CLAS/OC");
    expect(r.name).toBe("ZCL_FOO");
  });

  it("rejects an unknown ADT URI rather than guessing", () => {
    expect(() => parseObjectRef("/sap/bc/adt/nonsense/thing")).toThrow(/Unrecognised ADT URI/);
  });
});

describe("URI construction", () => {
  it("round-trips through buildUri/specFromUri", () => {
    for (const type of ["CLAS/OC", "TABL/DT", "DDLS/DF", "DOMA/DD"]) {
      const spec = specForType(type)!;
      const uri = buildUri(spec, "ZFOO");
      const back = specFromUri(uri);
      expect(back?.spec.type).toBe(type);
      expect(back?.name).toBe("ZFOO");
    }
  });

  it("builds the verified A4H URL shapes", () => {
    expect(buildUri(specForType("CLAS/OC")!, "ZCL_FOO")).toBe("/sap/bc/adt/oo/classes/zcl_foo");
    expect(buildUri(specForType("TABL/DT")!, "SFLIGHT")).toBe("/sap/bc/adt/ddic/tables/sflight");
    expect(buildUri(specForType("FUGR/FF")!, "BAL_LOG_CREATE", "SBAL")).toBe(
      "/sap/bc/adt/functions/groups/sbal/fmodules/bal_log_create",
    );
  });

  it("marks DTEL/DOMA/TTYP as not source-based (verified on A4H: 404)", () => {
    expect(specForType("DTEL/DE")!.supportsSource).toBe(false);
    expect(specForType("DOMA/DD")!.supportsSource).toBe(false);
    expect(specForType("TTYP/DA")!.supportsSource).toBe(false);
    expect(specForType("TABL/DT")!.supportsSource).toBe(true);
    expect(specForType("TABL/DS")!.supportsSource).toBe(true);
  });
});

/**
 * C5 — a function module found via repository search is only readable through
 * the `adtcore:uri` the server returned: an FM lives under
 * /sap/bc/adt/functions/groups/{group}/fmodules/{name} and that URI is the ONLY
 * carrier of its parent function group. Dropping (or refusing to use) it makes
 * every searched FM unreadable.
 */
describe("resolveObject — search results keep their adtcore:uri", () => {
  const FM_HIT = {
    "adtcore:name": "BAL_LOG_CREATE",
    "adtcore:type": "FUGR/FF",
    "adtcore:uri": "/sap/bc/adt/functions/groups/sbal/fmodules/bal_log_create",
    "adtcore:description": "Log: Create with header data",
    "adtcore:packageName": "SABP_BAL",
  };

  const CLASS_HIT = {
    "adtcore:name": "ZCL_FOO",
    "adtcore:type": "CLAS/OC",
    "adtcore:uri": "/sap/bc/adt/oo/classes/zcl_foo",
    "adtcore:description": "Demo class",
    "adtcore:packageName": "$TMP",
  };

  const connWith = (hits: unknown[]) =>
    ({
      cfg: { sid: "A4H" },
      adt: { searchObject: async () => hits },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  it("keeps the function group URI for a searched function module", async () => {
    const r = await resolveObject(connWith([FM_HIT]), "BAL_LOG_CREATE");
    expect(r.type).toBe("FUGR/FF");
    expect(r.name).toBe("BAL_LOG_CREATE");
    expect(r.uri).toBe("/sap/bc/adt/functions/groups/sbal/fmodules/bal_log_create");
    expect(r.sourceUri).toBe(
      "/sap/bc/adt/functions/groups/sbal/fmodules/bal_log_create/source/main",
    );
  });

  it("recovers the parent function group from that URI", async () => {
    const r = await resolveObject(connWith([FM_HIT]), "BAL_LOG_CREATE");
    expect(r.parent).toBe("SBAL");
  });

  it("does not demand a function group the search already answered", async () => {
    await expect(resolveObject(connWith([FM_HIT]), "BAL_LOG_CREATE")).resolves.toBeDefined();
  });

  it("strips search-result fragments but still finds the group", async () => {
    const noisy = {
      ...FM_HIT,
      "adtcore:uri": "/sap/bc/adt/functions/groups/sbal/fmodules/bal_log_create#start=1,1",
    };
    const r = await resolveObject(connWith([noisy]), "BAL_LOG_CREATE");
    expect(r.uri).toBe("/sap/bc/adt/functions/groups/sbal/fmodules/bal_log_create");
    expect(r.parent).toBe("SBAL");
  });

  it("still carries the URI for non-nested types", async () => {
    const r = await resolveObject(connWith([CLASS_HIT]), "ZCL_FOO");
    expect(r.uri).toBe("/sap/bc/adt/oo/classes/zcl_foo");
    expect(r.packageName).toBe("$TMP");
    expect(r.parent).toBeUndefined();
  });

  it("keeps the URI when the search disambiguates a multi-type name", async () => {
    const conn = connWith([FM_HIT, { ...CLASS_HIT, "adtcore:name": "BAL_LOG_CREATE" }]);
    const r = await resolveObject(conn, "BAL_LOG_CREATE", { type: "FUGR/FF" });
    expect(r.uri).toBe("/sap/bc/adt/functions/groups/sbal/fmodules/bal_log_create");
    expect(r.parent).toBe("SBAL");
  });
});

/**
 * Keyword-form (`"program ZFOO"`), URI-form, explicit
 * typecode-form, and `trustHint` refs all take the "certain" fast path in
 * `resolveObject`, which used to call `finish(conn, spec, name, parsed, {})`
 * — an empty `extra`, so `packageName` came back `undefined` no matter where
 * the object actually lived. `SafetyGate` then denied every such ref with
 * "Package (unknown) is not in the allowlist", even for objects in an
 * allowed package. The fix spends one extra search round trip
 * (`lookupPackageName`, reusing the same `searchExact` the bare-name path
 * already relies on) so the certain path also gets a real `packageName`.
 */
describe("resolveObject — packageName on the certain fast path", () => {
  const PROG_HIT = {
    "adtcore:name": "ZFOO",
    "adtcore:type": "PROG/P",
    "adtcore:uri": "/sap/bc/adt/programs/programs/zfoo",
    "adtcore:packageName": "ZLOCAL_PKG",
  };

  const connWith = (hits: unknown[]) =>
    ({
      cfg: { sid: "A4H" },
      adt: { searchObject: async () => hits },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  it("resolves a non-empty packageName for a keyword-form ref", async () => {
    const r = await resolveObject(connWith([PROG_HIT]), "program ZFOO");
    expect(r.type).toBe("PROG/P");
    expect(r.packageName).toBe("ZLOCAL_PKG");
  });

  it("resolves a non-empty packageName for a URI-form ref", async () => {
    const r = await resolveObject(connWith([PROG_HIT]), "/sap/bc/adt/programs/programs/zfoo");
    expect(r.type).toBe("PROG/P");
    expect(r.uri).toBe("/sap/bc/adt/programs/programs/zfoo");
    expect(r.packageName).toBe("ZLOCAL_PKG");
  });

  it("resolves a non-empty packageName for an explicit typecode-form ref", async () => {
    const r = await resolveObject(connWith([PROG_HIT]), "PROG/P ZFOO");
    expect(r.type).toBe("PROG/P");
    expect(r.packageName).toBe("ZLOCAL_PKG");
  });

  it("resolves a non-empty packageName when the caller passes trustHint", async () => {
    // A bare name has no type hint on its own (`via: "unknown"`), so pin the
    // type via `opts.type` the way a caller supplying `trustHint` would —
    // `certain` becomes true purely from `opts.trustHint === true`.
    const r = await resolveObject(connWith([PROG_HIT]), "ZFOO", {
      type: "PROG/P",
      trustHint: true,
    });
    expect(r.type).toBe("PROG/P");
    expect(r.packageName).toBe("ZLOCAL_PKG");
  });

  it("does NOT throw and leaves packageName undefined when the search finds nothing", async () => {
    // Residual case (diagnosability of this case is tracked
    // separately, not closed by this fix): the lookup is best-effort, so a
    // miss must degrade gracefully, exactly like the pre-fix `{}` did.
    const r = await resolveObject(connWith([]), "program ZBAR");
    expect(r.type).toBe("PROG/P");
    expect(r.packageName).toBeUndefined();
  });

  it("still resolves (packageName undefined) when the search call itself throws", async () => {
    const conn = {
      cfg: { sid: "A4H" },
      adt: {
        searchObject: async () => {
          throw new Error("network blip");
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const r = await resolveObject(conn, "program ZFOO");
    expect(r.type).toBe("PROG/P");
    expect(r.packageName).toBeUndefined();
  });
});

/**
 * The class include must survive resolution.
 *
 * `specFromUri` preserves which include was asked for, but `finish()` used to
 * hardcode `${uri}/source/main`, so the include was thrown away one layer up:
 * a caller asking for `.../includes/testclasses` was handed the MAIN class
 * body while believing it held the test class. That is the exact silent
 * substitution types.ts had just been fixed to stop.
 */
describe("resolveObject — class includes reach sourceUri", () => {
  // Resolution from a URI is `via: "uri"` ⇒ certain ⇒ no TYPE-disambiguation
  // search. It still spends one search round trip to recover `packageName`
  // (no ref shape carries package for free), so the mock
  // below must answer that call rather than reject it. An empty result is
  // fine: these tests only assert on `include`/`sourceUri`/`uri`, not
  // `packageName`, and the graceful-degradation path is covered separately.
  const conn = {
    cfg: { sid: "A4H" },
    adt: {
      searchObject: async () => [],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  it("points at the testclasses include, NOT at /source/main", async () => {
    const r = await resolveObject(conn, "/sap/bc/adt/oo/classes/zcl_foo/includes/testclasses");
    expect(r.include).toBe("testclasses");
    expect(r.sourceUri).toBe("/sap/bc/adt/oo/classes/zcl_foo/includes/testclasses");
    expect(r.sourceUri).not.toContain("/source/main");
    // The object URI itself stays the object, not the include.
    expect(r.uri).toBe("/sap/bc/adt/oo/classes/zcl_foo");
  });

  for (const include of ["definitions", "implementations", "macros", "testclasses"] as const) {
    it(`resolves the ${include} include to its own URI`, async () => {
      const r = await resolveObject(conn, `/sap/bc/adt/oo/classes/zcl_foo/includes/${include}`);
      expect(r.include).toBe(include);
      expect(r.sourceUri).toBe(`/sap/bc/adt/oo/classes/zcl_foo/includes/${include}`);
    });
  }

  it("canonicalises the `includes/main` alias to /source/main", async () => {
    const r = await resolveObject(conn, "/sap/bc/adt/oo/classes/zcl_foo/includes/main");
    expect(r.include).toBe("main");
    expect(r.sourceUri).toBe("/sap/bc/adt/oo/classes/zcl_foo/source/main");
  });

  it("leaves a plain class on /source/main, with no include claimed", async () => {
    for (const input of [
      "/sap/bc/adt/oo/classes/zcl_foo",
      "/sap/bc/adt/oo/classes/zcl_foo/source/main",
      "class ZCL_FOO",
    ]) {
      const r = await resolveObject(conn, input);
      expect(r.sourceUri).toBe("/sap/bc/adt/oo/classes/zcl_foo/source/main");
      // "no include named" is a different fact from "main was named".
      expect(r.include).toBeUndefined();
    }
  });

  it("leaves non-class objects completely unchanged", async () => {
    const prog = await resolveObject(conn, "/sap/bc/adt/programs/programs/zdemo1");
    expect(prog.sourceUri).toBe("/sap/bc/adt/programs/programs/zdemo1/source/main");
    expect(prog.include).toBeUndefined();

    const fm = await resolveObject(
      conn,
      "/sap/bc/adt/functions/groups/sbal/fmodules/bal_log_create",
    );
    expect(fm.sourceUri).toBe(
      "/sap/bc/adt/functions/groups/sbal/fmodules/bal_log_create/source/main",
    );
    expect(fm.include).toBeUndefined();

    const intf = await resolveObject(conn, "interface ZIF_FOO");
    expect(intf.sourceUri).toBe("/sap/bc/adt/oo/interfaces/zif_foo/source/main");

    // A program include literally named MAIN is an object, not a class include.
    const incl = await resolveObject(conn, "/sap/bc/adt/programs/includes/main");
    expect(incl.name).toBe("MAIN");
    expect(incl.include).toBeUndefined();
    expect(incl.sourceUri).toBe("/sap/bc/adt/programs/includes/main/source/main");

    // Not source-based at all — still undefined, not an include URI.
    const doma = await resolveObject(conn, "domain XFELD");
    expect(doma.sourceUri).toBeUndefined();
  });

  it("keeps the include through the search (ambiguous) path too", async () => {
    const searchConn = {
      cfg: { sid: "A4H" },
      adt: {
        searchObject: async () => [
          {
            "adtcore:name": "ZCL_FOO",
            "adtcore:type": "CLAS/OC",
            "adtcore:uri": "/sap/bc/adt/oo/classes/zcl_foo",
          },
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const r = await resolveObject(
      searchConn,
      "/sap/bc/adt/oo/classes/zcl_foo/includes/testclasses",
    );
    expect(r.sourceUri).toBe("/sap/bc/adt/oo/classes/zcl_foo/includes/testclasses");
  });
});

/**
 * Activation state — `abap_run` used to promise unconditionally that "the code
 * that ran is the code currently active", including when a newer INACTIVE
 * version was sitting on the server. `ResolvedObject.activation` exists so the
 * promise can be made only when it is true.
 *
 * The three states are string literals on purpose: `unknown` must be
 * impossible to render as good news by accident.
 */
describe("ResolvedObject.activation", () => {
  const conn = (extra: Record<string, unknown> = {}) =>
    ({
      cfg: { sid: "A4H" },
      adt: { searchObject: async () => [], ...extra },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  it("is 'unknown' when nothing was checked — and unknown ≠ active", async () => {
    const r = await resolveObject(conn(), "class ZCL_FOO");
    expect(r.activation).toBe("unknown");
    expect(r.activation).not.toBe("active-is-current");
    // Never absent: a consumer cannot forget to look at it.
    expect(Object.hasOwn(r, "activation")).toBe(true);
    expect(r.activation).not.toBeUndefined();
  });

  it("resolves a payload carrying an inactive marker to 'newer-inactive-exists'", async () => {
    const hit = {
      "adtcore:name": "ZCL_FOO",
      "adtcore:type": "CLAS/OC",
      "adtcore:uri": "/sap/bc/adt/oo/classes/zcl_foo",
      "adtcore:version": "inactive",
    };
    const r = await resolveObject(conn({ searchObject: async () => [hit] }), "ZCL_FOO");
    expect(r.activation).toBe("newer-inactive-exists");
    expect(r.activation).not.toBe("active-is-current");
  });

  it("resolves an active marker to 'active-is-current'", async () => {
    const hit = {
      "adtcore:name": "ZCL_FOO",
      "adtcore:type": "CLAS/OC",
      "adtcore:uri": "/sap/bc/adt/oo/classes/zcl_foo",
      "adtcore:version": "active",
    };
    const r = await resolveObject(conn({ searchObject: async () => [hit] }), "ZCL_FOO");
    expect(r.activation).toBe("active-is-current");
  });

  it("maps adtcore:version honestly, and refuses to guess", () => {
    expect(activationFromVersion("active")).toBe("active-is-current");
    expect(activationFromVersion("ACTIVE")).toBe("active-is-current");
    expect(activationFromVersion("inactive")).toBe("newer-inactive-exists");
    for (const junk of [undefined, null, "", "workingArea", "yes", 1, {}]) {
      expect(activationFromVersion(junk)).toBe("unknown");
    }
  });

  it("checkActivation reads the object metadata (one extra round trip)", async () => {
    const calls: string[] = [];
    const c = conn({
      objectStructure: async (uri: string) => {
        calls.push(uri);
        return { metaData: { "adtcore:version": "inactive" } };
      },
    });
    await expect(checkActivation(c, { uri: "/sap/bc/adt/oo/classes/zcl_foo" })).resolves.toBe(
      "newer-inactive-exists",
    );
    expect(calls).toEqual(["/sap/bc/adt/oo/classes/zcl_foo"]);
  });

  it("checkActivation reports 'unknown' when the check itself fails", async () => {
    const c = conn({
      objectStructure: async () => {
        throw new Error("500");
      },
    });
    await expect(checkActivation(c, { uri: "/sap/bc/adt/oo/classes/zcl_foo" })).resolves.toBe(
      "unknown",
    );
  });

  it("plain resolveObject spends NO round trip on activation", async () => {
    let probed = 0;
    const c = conn({
      objectStructure: async () => {
        probed += 1;
        return { metaData: { "adtcore:version": "active" } };
      },
    });
    const r = await resolveObject(c, "class ZCL_FOO");
    expect(probed).toBe(0);
    expect(r.activation).toBe("unknown");

    const withCheck = await resolveObjectWithActivation(c, "class ZCL_FOO");
    expect(probed).toBe(1);
    expect(withCheck.activation).toBe("active-is-current");
  });
});

/**
 * The mapping above is grounded in bytes this appliance actually sent, not in
 * a guess about what `adtcore:version` means (see MEMORY: offline green proves
 * nothing about the wire).
 */
describe("activation mapping vs live-captured A4H bytes", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
  const versionAttr = (file: string): string | undefined =>
    /adtcore:version="([^"]+)"/.exec(readFileSync(join(dir, file), "utf8"))?.[1];

  it("a class with unactivated changes reported adtcore:version=inactive", () => {
    // 062-class-get-check.xml — ZCL_ZMCP_STALE_PROBE, captured mid-edit.
    expect(versionAttr("062-class-get-check.xml")).toBe("inactive");
    expect(activationFromVersion(versionAttr("062-class-get-check.xml"))).toBe(
      "newer-inactive-exists",
    );
  });

  it("a clean class reported adtcore:version=active", () => {
    expect(versionAttr("074-p2-packageref-clas.xml")).toBe("active");
    expect(activationFromVersion(versionAttr("074-p2-packageref-clas.xml"))).toBe(
      "active-is-current",
    );
  });
});

describe("resolveObject — a naming convention is not evidence of existence (ARCH-09 §5.1)", () => {
  const conn = (objectStructure: (uri: string) => Promise<unknown>) =>
    ({
      cfg: { sid: "A4H" },
      adt: { searchObject: async () => [], objectStructure },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  const notFound = async () => {
    throw Object.assign(new Error("Resource not found"), { status: 404 });
  };

  it("does not invent a class just because the name starts with ZCL_", async () => {
    await expect(resolveObject(conn(notFound), "ZCL_DOES_NOT_EXIST_XYZ999")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("says the type was assumed from the name, so the caller can see the reasoning", async () => {
    const err = await resolveObject(conn(notFound), "ZCL_DOES_NOT_EXIST_XYZ999").catch((e) => e);
    expect(isAbapError(err)).toBe(true);
    expect(err.details).toMatchObject({ assumedType: "CLAS/OC", assumedFrom: "naming-convention" });
  });

  it("still resolves when the search misses but the object is really there", async () => {
    const r = await resolveObject(
      conn(async () => ({ metaData: { "adtcore:version": "active" } })),
      "ZCL_INVISIBLE_TO_SEARCH",
    );
    expect(r.type).toBe("CLAS/OC");
    expect(r.name).toBe("ZCL_INVISIBLE_TO_SEARCH");
  });

  it("costs no extra round trip when the search does find the object", async () => {
    let structureCalls = 0;
    const c = {
      cfg: { sid: "A4H" },
      adt: {
        searchObject: async () => [
          {
            "adtcore:name": "ZCL_FOO",
            "adtcore:type": "CLAS/OC",
            "adtcore:uri": "/sap/bc/adt/oo/classes/zcl_foo",
          },
        ],
        objectStructure: async () => {
          structureCalls++;
          return {};
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const r = await resolveObject(c, "ZCL_FOO");
    expect(r.type).toBe("CLAS/OC");
    expect(structureCalls).toBe(0);
  });

  it("keeps the better error for a function module missing its group", async () => {
    await expect(
      resolveObject(conn(notFound), "function module Z_NO_SUCH_FM"),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
  });
});

/**
 * An explicit `type` hint naming one of the capabilities
 * registry's `unsupported`/`bridgeCreate` codes (SHLP/DH, VIEW/DV, TRAN/T,
 * PROG/PS, PROG/PC, PROG/PT, SUSO/B, TABL/DI — none of them in `types.ts`'s
 * `TYPES` array) used to fall straight through
 * `resolveObject`'s "ambiguous → ask the server" branch: a live search, and
 * then either a generic NOT_FOUND (no
 * live system, or the object doesn't exist under that name) or an
 * under-explained "exists but its type is not a readable source object"
 * (object does exist). Neither names the real, already-known reason, and
 * both cost a network round trip abapsmith didn't need to spend — the
 * refusal was knowable from the type code alone.
 *
 * `resolveObject` now runs the same `capabilitiesFor` check
 * `resolveWriteTarget` (`write.ts`) already ran for writes, so a caller
 * asking to *read* one of these types gets the identical stated boundary,
 * offline. `conn` is deliberately `null` here: any code path that reached
 * for the connection before throwing would crash with a `TypeError` instead
 * of the expected `AbapError`, which is how these tests prove zero network
 * requests without a mock.
 */
describe("resolveObject — explicit unsupported/bridgeCreate type hints refuse offline", () => {
  const offline = null as unknown as Parameters<typeof resolveObject>[0];

  it.each([
    ["SHLP/DH", "search help"],
    ["PROG/PS", "screen"],
    ["PROG/PC", "GUI status"],
    ["PROG/PT", "GUI title"],
    ["SUSO/B", "authorization object"],
  ])("refuses a %s read with a specific UNSUPPORTED, offline, not a live search", async (type) => {
    const err = await resolveObject(offline, "ZX", { type }).catch((e) => e);
    expect(isAbapError(err)).toBe(true);
    expect(err.code).toBe("UNSUPPORTED");
    expect(String(err.message)).toMatch(/cannot be read by abapsmith/i);
    expect(String(err.message)).toMatch(new RegExp(type.replace("/", "\\/")));
  });

  it.each(["VIEW/DV", "TRAN/T", "TABL/DI"])(
    "refuses a %s read on the source-read path with UNSUPPORTED, offline, naming the ADT-collection gap",
    async (type) => {
      const err = await resolveObject(offline, "ZX", { type }).catch((e) => e);
      expect(isAbapError(err)).toBe(true);
      expect(err.code).toBe("UNSUPPORTED");
      expect(String(err.message)).toMatch(/no ADT-readable collection/i);
    },
  );

  /**
   * The read refusal's HINT used to tell a caller abapsmith could create a
   * classic view through the classrun bridge — advice `abap_write` then
   * refused, via a dedicated `bridgeCreate.createRefused` registry string.
   * RS_CORR_INSERT now registers a VIEW/DV create for every package, so that
   * refusal is gone: no REGISTRY entry declares `createRefused` any more
   * (asserted below on TRAN/T), and VIEW/DV's read hint falls back to the
   * same generic bridge-create text TRAN/T's always used.
   */
  it("VIEW/DV's read hint is the same generic bridge-create hint TRAN/T's is, now that the create is no longer refused", async () => {
    const err = await resolveObject(offline, "ZX", { type: "VIEW/DV" }).catch((e) => e);
    const hint = String(err.hint ?? "");
    expect(capabilitiesFor("VIEW/DV")?.bridgeCreate?.createRefused).toBeUndefined();
    expect(hint).toMatch(
      /abapsmith can create this type through a generated classrun bridge \(see abap_write\)/,
    );
    expect(hint).toMatch(/cannot read one back/);
  });

  /**
   * The refusal renders `bridgeCreate.adtRest` verbatim (here and on the write
   * path in `src/adt/write.ts`), so the identity assertion is what keeps the
   * two sites from drifting. The fragment used to say the views collection
   * "answers reads" inside the response refusing exactly that read.
   */
  it("VIEW/DV's read refusal carries the registry's REST finding without naming a read route the caller can take", async () => {
    const err = await resolveObject(offline, "ZX", { type: "VIEW/DV" }).catch((e) => e);
    const adtRest = capabilitiesFor("VIEW/DV")?.bridgeCreate?.adtRest ?? "";
    expect(String(err.message)).toContain(adtRest);
    expect(adtRest).not.toMatch(/answers reads/);
    expect(adtRest).toMatch(/not a route a caller can take/);
    expect(adtRest).toMatch(/abap_search rejects VIEW\/DV/);
    // The 405 recon stays: it is why this type is bridge-created at all.
    expect(adtRest).toMatch(/405/);
  });

  it("no REGISTRY entry declares bridgeCreate.createRefused any more, and TRAN/T's read hint still names the create that works", async () => {
    for (const code of Object.keys(REGISTRY) as TypeCode[]) {
      expect(REGISTRY[code].bridgeCreate?.createRefused, `${code} declares createRefused`).toBeUndefined();
    }
    const err = await resolveObject(offline, "ZX", { type: "TRAN/T" }).catch((e) => e);
    expect(String(err.hint ?? "")).toMatch(/can create this type through a generated classrun bridge/);
  });

  it("SUSO/B's read refusal names the real ADT type code, confirms it as a registered ADT type with no readable collection, and names SU21 as the alternative", async () => {
    const err = await resolveObject(offline, "S_TCODE", { type: "SUSO/B" }).catch((e) => e);
    expect(isAbapError(err)).toBe(true);
    expect(err.code).toBe("UNSUPPORTED");
    expect(String(err.message)).toMatch(/SUSO\/B/);
    expect(String(err.message)).toMatch(/authorization object/i);
    expect(String(err.hint ?? "")).toMatch(/SU21/);
  });

  /**
   * TABL/DI moved from `unsupported` (SE11-only, no ADT resource probed at
   * all) to `bridgeCreate` on 2026-09-05: REST is now confirmed absent (404
   * on every index route) and the classrun bridge creates/deletes it — see
   * the REGISTRY entry. The read refusal is now the same offline,
   * zero-network "no ADT-readable collection" shape VIEW/DV and TRAN/T
   * already get, not an SE11 pointer.
   */
  it("TABL/DI's read refusal names the real ADT type code and the generic bridge-create hint, not SE11", async () => {
    const err = await resolveObject(offline, "ZTMC_TORDER", { type: "TABL/DI" }).catch((e) => e);
    expect(isAbapError(err)).toBe(true);
    expect(err.code).toBe("UNSUPPORTED");
    expect(String(err.message)).toMatch(/TABL\/DI/);
    expect(String(err.message)).toMatch(/no ADT-readable collection/i);
    expect(String(err.hint ?? "")).toMatch(
      /abapsmith can create this type through a generated classrun bridge \(see abap_write\)/,
    );
    expect(String(err.hint ?? "")).toMatch(/cannot read one back/);
    expect(String(err.hint ?? "")).not.toMatch(/SE11/);
  });

  it("a supported type (PROG/P) is unaffected — no false-positive refusal", async () => {
    const hit = {
      "adtcore:name": "ZFOO",
      "adtcore:type": "PROG/P",
      "adtcore:uri": "/sap/bc/adt/programs/programs/zfoo",
    };
    const conn = {
      cfg: { sid: "A4H" },
      adt: { searchObject: async () => [hit] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const r = await resolveObject(conn, "ZFOO", { type: "PROG/P" });
    expect(r.type).toBe("PROG/P");
  });
});
