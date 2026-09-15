/**
 * `src/adt/shlp-create.ts` (`SearchHelpParams` validation, `createSearchHelp`/
 * `updateSearchHelp`), plus — folded into this one file per the task that
 * produced it, since each is a small validation-only surface — the sibling
 * validation in `src/adt/shlp-delete.ts` (`deleteSearchHelpViaBridge`),
 * `src/adt/view-update.ts` (`updateClassicView`) and
 * `src/adt/tran-update.ts` (`updateTransaction`/`assertTransactionUpdateTarget`).
 *
 * All five modules share one shape this file leans on throughout: every
 * caller-string check (`validate()` in each module) runs BEFORE
 * `assertBridgeMutation`/`runClassicAction` are ever invoked, so a
 * validation-error test can call the exported top-level function with
 * `conn`/`gate` forced to `undefined` — they are never touched at runtime
 * before the throw. This is asserted once explicitly (search "never touches
 * conn or gate" below) and then relied on everywhere else without
 * re-proving it per test.
 *
 * Pure/offline: no network, no fake transport, no SafetyGate construction —
 * these are all zero-I/O validation paths.
 */
import { describe, expect, it } from "vitest";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type { SafetyGate } from "../src/safety.js";
import {
  createSearchHelp,
  updateSearchHelp,
  assertSearchHelpTarget,
  validate,
  buildArgs,
  type SearchHelpParams,
  type SearchHelpField,
} from "../src/adt/shlp-create.js";
import { deleteSearchHelpViaBridge, type SearchHelpDeleteParams } from "../src/adt/shlp-delete.js";
import { updateClassicView } from "../src/adt/view-update.js";
import type { ClassicViewParams } from "../src/adt/view-create.js";
import { updateTransaction, assertTransactionUpdateTarget, type TransactionUpdateParams } from "../src/adt/tran-update.js";
import { serverPackage, type ServerPackage } from "../src/adt/resolved-package.js";
import type { VerifyOutcome } from "../src/adt/write-verify.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Mints a genuine `VerifyOutcome`, mirroring `test/resolved-package.test.ts`'s `confirmed` fixture. */
const confirmed = (packageName: string | undefined): VerifyOutcome => ({
  status: "confirmed",
  uri: "/sap/bc/adt/vit/wb/object_type/shlp/object_name/ZTM_SH",
  via: "vit-bridge",
  packageName,
});

const pkg = (name: string): ServerPackage => {
  const p = serverPackage(confirmed(name));
  if (!p) throw new Error(`test fixture: serverPackage(confirmed(${JSON.stringify(name)})) unexpectedly undefined`);
  return p;
};

const LOCAL_PKG = pkg("$TMP");
const REAL_PKG = pkg("ZTM");
const CORR = "A4HK900121";

/** Never dereferenced: every scenario in this file throws inside `validate()`, before either argument is touched. */
const conn = undefined as unknown as AbapConnection;
const gate = undefined as unknown as SafetyGate;

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!e || !isAbapError(e)) throw new Error(`expected an AbapError, got ${String(e)}`);
  return e;
};

/** One valid elementary-field pair — the minimum `fields` needs when `elementary: true`. */
const ELEMENTARY_FIELDS: SearchHelpField[] = [
  { name: "CARRID", dataElement: "ZTM_CARRID", import: true },
  { name: "CARRNAME", dataElement: "ZTM_CARRNAME", export: true },
];

/** A fully valid, minimal `SearchHelpParams` — every test starts here and overrides one thing. */
function baseParams(overrides: Partial<SearchHelpParams> = {}): SearchHelpParams {
  return {
    shlpName: "ZTM_SH_CARRIER",
    description: "Carrier search help",
    packageName: LOCAL_PKG,
    selectionMethod: "ZTM_CARRIERS",
    selectionMethodType: "T",
    elementary: true,
    fields: ELEMENTARY_FIELDS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createSearchHelp / updateSearchHelp: shared validate() surface
// ---------------------------------------------------------------------------

describe.each([
  ["createSearchHelp", createSearchHelp],
  ["updateSearchHelp", updateSearchHelp],
] as const)("%s: validate() runs before any gate/network interaction", (name, fn) => {
  it(`${name}: never touches conn or gate on a validation error — both are left undefined and the promise still rejects with BAD_INPUT`, async () => {
    // Proves the ordering claim documented at the top of this file: passing
    // literal `undefined` for both connection and gate does not itself
    // throw a TypeError before validate() runs.
    const err = await catchErr(fn(conn, gate, baseParams({ shlpName: "1BAD" })));
    expect(err.code).toBe("BAD_INPUT");
  });

  it(`${name}: accepts a valid elementary search help through validate() (rejects only once past it, inside the untouched conn/gate)`, async () => {
    // conn/gate are `undefined`, so once validate() passes, the next thing
    // touched is assertBridgeMutation(gate, ...), which throws a plain
    // TypeError reading a property off `undefined` — that TypeError, not an
    // AbapError, is the signal that validate() itself raised nothing.
    await expect(fn(conn, gate, baseParams())).rejects.not.toSatisfy((e: unknown) => isAbapError(e));
  });

  it(`${name}: refuses shlpName over CHAR30`, async () => {
    const err = await catchErr(fn(conn, gate, baseParams({ shlpName: "Z" + "A".repeat(30) })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "shlpName" });
  });

  it(`${name}: refuses a shlpName that would close a literal and inject ABAP, rather than escaping it`, async () => {
    const err = await catchErr(fn(conn, gate, baseParams({ shlpName: `ZX'. LEAVE PROGRAM. "` })));
    expect(err.code).toBe("BAD_INPUT");
  });

  it(`${name}: refuses description over CHAR60`, async () => {
    const err = await catchErr(fn(conn, gate, baseParams({ description: "D".repeat(61) })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "description" });
  });

  it(`${name}: accepts description at exactly CHAR60`, async () => {
    await expect(fn(conn, gate, baseParams({ description: "D".repeat(60) }))).rejects.not.toSatisfy(
      (e: unknown) => isAbapError(e),
    );
  });

  it(`${name}: refuses selectionMethod over CHAR30`, async () => {
    const err = await catchErr(fn(conn, gate, baseParams({ selectionMethod: "Z" + "A".repeat(30) })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "selectionMethod" });
  });

  it(`${name}: refuses a selectionMethodType outside T/V/M, naming the offending field`, async () => {
    const err = await catchErr(fn(conn, gate, baseParams({ selectionMethodType: "X" })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "selectionMethodType", value: "X" });
    expect(err.message).toContain("must be one of T, V, M");
  });

  it.each(["T", "V", "M"])(`${name}: accepts selectionMethodType %s`, async (t) => {
    await expect(fn(conn, gate, baseParams({ selectionMethodType: t }))).rejects.not.toSatisfy((e: unknown) =>
      isAbapError(e),
    );
  });

  it(`${name}: refuses a non-string selectionMethodType rather than coercing it`, async () => {
    const err = await catchErr(fn(conn, gate, baseParams({ selectionMethodType: 1 as unknown as string })));
    expect(err.code).toBe("BAD_INPUT");
  });

  // --- issue #83: blank selectionMethod ("none") ---------------------------
  // A collective search help has no selection method at all (DD30V-SELMETHOD
  // empty), and plenty of standard SAP elementary helps have a blank one too,
  // driven by a search-help exit instead of a table/view — see the module
  // doc on `SearchHelpParams.selectionMethod`. `undefined` and `""` must
  // both mean "none" and must not be refused by `assertEnhIdentifier`.

  it.each([undefined, ""])(`${name}: accepts selectionMethod %j (omitted or blank) together with an omitted selectionMethodType`, async (sm) => {
    await expect(
      fn(
        conn,
        gate,
        baseParams({
          selectionMethod: sm,
          selectionMethodType: undefined,
          elementary: false,
          fields: [],
          includes: [{ name: "ZTM_SH_SUB" }],
          assignments: [],
        }),
      ),
    ).rejects.not.toSatisfy((e: unknown) => isAbapError(e));
  });

  it(`${name}: refuses a selectionMethodType given without a selectionMethod, naming selectionMethodType (issue #83)`, async () => {
    const err = await catchErr(
      fn(
        conn,
        gate,
        baseParams({
          selectionMethod: "",
          selectionMethodType: "T",
          elementary: false,
          fields: [],
          includes: [{ name: "ZTM_SH_SUB" }],
          assignments: [],
        }),
      ),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "selectionMethodType" });
    expect(err.message).toContain("selectionMethod");
  });

  it(`${name}: a collective search help (elementary: false, no selectionMethod) round-trips through validate()/buildArgs() with selection_method: ""`, () => {
    // Directly exercises validate() -> buildArgs(), the same pure pair
    // test/classic-bridge-wire-format.test.ts drives end to end, to pin the
    // literal emitted arg values rather than only "did not throw".
    const params = baseParams({
      selectionMethod: undefined,
      selectionMethodType: undefined,
      elementary: false,
      fields: [],
      includes: [{ name: "ZTM_SH_SUB" }],
      assignments: [],
    });
    const args = buildArgs(validate(params.packageName.name, params));
    expect(args.selection_method).toBe("");
    expect(args.selection_method_type).toBe("");
  });

  it(`${name}: refuses defaultValue over the module's DEFAULT_VALUE_MAX (132) — a conservative ceiling the source itself says was never measured live`, async () => {
    const err = await catchErr(
      fn(
        conn,
        gate,
        baseParams({
          fields: [
            { ...ELEMENTARY_FIELDS[0]!, defaultValue: "D".repeat(133) },
            ELEMENTARY_FIELDS[1]!,
          ],
        }),
      ),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "fields[0].defaultValue" });
  });

  it(`${name}: accepts defaultValue at exactly 132 characters`, async () => {
    await expect(
      fn(
        conn,
        gate,
        baseParams({
          fields: [{ ...ELEMENTARY_FIELDS[0]!, defaultValue: "D".repeat(132) }, ELEMENTARY_FIELDS[1]!],
        }),
      ),
    ).rejects.not.toSatisfy((e: unknown) => isAbapError(e));
  });

  it(`${name}: refuses a non-boolean elementary`, async () => {
    const err = await catchErr(fn(conn, gate, baseParams({ elementary: "yes" as unknown as boolean })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "elementary" });
  });

  it(`${name}: refuses a non-array fields`, async () => {
    const err = await catchErr(fn(conn, gate, baseParams({ fields: "nope" as unknown as SearchHelpField[] })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "fields" });
  });

  it(`${name}: elementary=true with an empty fields array is refused, naming DDIF_SHLP_PUT's requirement`, async () => {
    const err = await catchErr(fn(conn, gate, baseParams({ fields: [] })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("non-empty for an elementary search help");
  });

  it(`${name}: elementary=true with only import fields (no export) is refused`, async () => {
    const err = await catchErr(
      fn(conn, gate, baseParams({ fields: [{ name: "CARRID", dataElement: "ZTM_CARRID", import: true }] })),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("at least one field marked import and at least one marked export");
  });

  it(`${name}: elementary=true with only export fields (no import) is refused`, async () => {
    const err = await catchErr(
      fn(conn, gate, baseParams({ fields: [{ name: "CARRID", dataElement: "ZTM_CARRID", export: true }] })),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("at least one field marked import and at least one marked export");
  });

  it(`${name}: elementary=false tolerates a fields list with no import/export flags at all`, async () => {
    await expect(
      fn(
        conn,
        gate,
        baseParams({
          elementary: false,
          fields: [{ name: "CARRID", dataElement: "ZTM_CARRID" }],
          includes: [{ name: "ZTM_SH_SUB" }],
        }),
      ),
    ).rejects.not.toSatisfy((e: unknown) => isAbapError(e));
  });

  it(`${name}: elementary=false still refuses an empty fields array's field-name/dataElement grammar issues, but not the import/export rule`, async () => {
    // elementary: false with an EMPTY fields array is not itself refused by
    // the import/export rule (that only applies when elementary is true) —
    // pin that this genuinely reaches the untouched conn/gate.
    await expect(
      fn(conn, gate, baseParams({ elementary: false, fields: [], includes: [{ name: "ZTM_SH_SUB" }] })),
    ).rejects.not.toSatisfy((e: unknown) => isAbapError(e));
  });

  // --- issue #83, 2026-09-15 live finding: a collective with no includes -----
  // activates fine on a real system, or only warns (rc = 4, DH108) - it does
  // NOT fail the way a dangling include/assignment reference does (DH109).
  // An earlier round of this module refused this shape outright ("has
  // nothing to collect"); that refusal has been removed as no longer
  // justified by measured server behaviour.

  it(`${name}: elementary=false with an empty includes array is ACCEPTED (issue #83, 2026-09-15): a collective with no includes activates fine or only warns on the server, so this module does not refuse it`, async () => {
    await expect(
      fn(conn, gate, baseParams({ elementary: false, fields: [], includes: [] })),
    ).rejects.not.toSatisfy((e: unknown) => isAbapError(e));
  });

  it(`${name}: elementary=false with includes omitted entirely is accepted the same way as an empty array`, async () => {
    await expect(
      fn(conn, gate, baseParams({ elementary: false, fields: [], includes: undefined })),
    ).rejects.not.toSatisfy((e: unknown) => isAbapError(e));
  });

  it(`${name}: refuses a field name over CHAR30`, async () => {
    const err = await catchErr(
      fn(conn, gate, baseParams({ fields: [{ name: "A".repeat(31), dataElement: "ZTM_CARRID", import: true }, ELEMENTARY_FIELDS[1]!] })),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "fields[0].name" });
  });

  it(`${name}: refuses a field dataElement over CHAR30`, async () => {
    const err = await catchErr(
      fn(
        conn,
        gate,
        baseParams({
          fields: [{ name: "CARRID", dataElement: "A".repeat(31), import: true }, ELEMENTARY_FIELDS[1]!],
        }),
      ),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "fields[0].dataElement" });
  });

  it(`${name}: refuses an includes[] entry with a name over CHAR30`, async () => {
    const err = await catchErr(fn(conn, gate, baseParams({ includes: [{ name: "A".repeat(31) }] })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "includes[0].name" });
  });

  it(`${name}: accepts a valid includes[] entry`, async () => {
    await expect(
      fn(conn, gate, baseParams({ includes: [{ name: "ZTM_SH_SUB" }] })),
    ).rejects.not.toSatisfy((e: unknown) => isAbapError(e));
  });

  it(`${name}: refuses an assignments[i].direction outside I/E, naming the indexed field (DD33V-VALUEDIREC)`, async () => {
    const err = await catchErr(
      fn(
        conn,
        gate,
        baseParams({
          assignments: [
            { field: "CARRID", includedHelp: "ZTM_SH_SUB", includedField: "CARRID", direction: "X" },
          ],
        }),
      ),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "assignments[0].direction", value: "X" });
    expect(err.message).toContain("assignments[0].direction");
    expect(err.message).toContain("DD33V-VALUEDIREC");
  });

  it.each(["I", "E"])(`${name}: accepts assignments[i].direction %s`, async (dir) => {
    await expect(
      fn(
        conn,
        gate,
        baseParams({
          // includes must name ZTM_SH_SUB (issue #83): validate() now refuses an
          // assignment whose includedHelp is not one of this call's own includes.
          includes: [{ name: "ZTM_SH_SUB" }],
          assignments: [{ field: "CARRID", includedHelp: "ZTM_SH_SUB", includedField: "CARRID", direction: dir }],
        }),
      ),
    ).rejects.not.toSatisfy((e: unknown) => isAbapError(e));
  });

  it(`${name}: refuses an assignments[i].includedHelp over CHAR30`, async () => {
    const err = await catchErr(
      fn(
        conn,
        gate,
        baseParams({
          assignments: [
            { field: "CARRID", includedHelp: "A".repeat(31), includedField: "CARRID", direction: "I" },
          ],
        }),
      ),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "assignments[0].includedHelp" });
  });

  // --- issue #83, 2026-09-15 live finding: DH109 dangling-reference checks ---
  // A DD33V assignment whose FIELDNAME/SUBSHLP does not name one of this
  // search help's own interface parameters/includes makes DDIF_SHLP_PUT
  // succeed and DDIF_SHLP_ACTIVATE then fail with rc = 8 / DH109, stranding
  // the search help as an inactive-only object. Both are checkable without
  // a server round trip, so validate() refuses them before dispatch.

  it(`${name}: refuses an assignments[i].field that is not one of this search help's own fields[].name, naming the offending assignment (DH109)`, async () => {
    const err = await catchErr(
      fn(
        conn,
        gate,
        baseParams({
          includes: [{ name: "ZTM_SH_SUB" }],
          assignments: [
            { field: "NOT_A_FIELD", includedHelp: "ZTM_SH_SUB", includedField: "CARRID", direction: "I" },
          ],
        }),
      ),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "assignments[0].field", value: "NOT_A_FIELD" });
    expect(err.message).toContain("assignments[0].field");
    expect(err.message).toContain("interface parameters");
    expect(err.message).toContain("DH109");
  });

  it(`${name}: accepts an assignments[i].field that matches fields[].name case-insensitively`, async () => {
    await expect(
      fn(
        conn,
        gate,
        baseParams({
          includes: [{ name: "ZTM_SH_SUB" }],
          assignments: [{ field: "carrid", includedHelp: "ZTM_SH_SUB", includedField: "CARRID", direction: "I" }],
        }),
      ),
    ).rejects.not.toSatisfy((e: unknown) => isAbapError(e));
  });

  it(`${name}: refuses an assignments[i].includedHelp that is not one of this search help's own includes[].name, naming the offending assignment (DH109)`, async () => {
    const err = await catchErr(
      fn(
        conn,
        gate,
        baseParams({
          includes: [{ name: "ZTM_SH_SUB" }],
          assignments: [
            { field: "CARRID", includedHelp: "ZTM_SH_NOT_INCLUDED", includedField: "CARRID", direction: "I" },
          ],
        }),
      ),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "assignments[0].includedHelp", value: "ZTM_SH_NOT_INCLUDED" });
    expect(err.message).toContain("assignments[0].includedHelp");
    expect(err.message).toContain("does not include");
    expect(err.message).toContain("DH109");
  });

  it(`${name}: accepts an assignments[i].includedHelp that matches includes[].name case-insensitively`, async () => {
    await expect(
      fn(
        conn,
        gate,
        baseParams({
          includes: [{ name: "ZTM_SH_SUB" }],
          assignments: [{ field: "CARRID", includedHelp: "ztm_sh_sub", includedField: "CARRID", direction: "I" }],
        }),
      ),
    ).rejects.not.toSatisfy((e: unknown) => isAbapError(e));
  });

  it(`${name}: refuses a local ($) package paired with a corrNr — nothing for it to attach to`, async () => {
    const err = await catchErr(fn(conn, gate, baseParams({ packageName: LOCAL_PKG, corrNr: CORR })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("nothing here for one to attach to");
  });

  it(`${name}: refuses a non-local package with no corrNr as TRANSPORT_ERROR, hinting at the transports skill`, async () => {
    const err = await catchErr(fn(conn, gate, baseParams({ packageName: REAL_PKG })));
    expect(err.code).toBe("TRANSPORT_ERROR");
    expect(err.hint).toContain("abapsmith-put-work-on-a-transport");
  });

  it(`${name}: accepts a non-local package with a valid corrNr`, async () => {
    await expect(
      fn(conn, gate, baseParams({ packageName: REAL_PKG, corrNr: CORR })),
    ).rejects.not.toSatisfy((e: unknown) => isAbapError(e));
  });

  it(`${name}: refuses a corrNr that is not TRKORR-shaped`, async () => {
    const err = await catchErr(fn(conn, gate, baseParams({ packageName: REAL_PKG, corrNr: "not-a-trkorr" })));
    expect(err.code).toBe("BAD_INPUT");
  });

  it(`${name}: refuses a packageName forced in via \`as unknown as ServerPackage\` with SAFETY_DENIED/PACKAGE_UNKNOWN, before validate() itself ever runs`, async () => {
    const forged = "ZTM" as unknown as ServerPackage;
    const err = await catchErr(fn(conn, gate, baseParams({ packageName: forged })));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details).toMatchObject({ reason: "PACKAGE_UNKNOWN" });
  });

  it(`${name}: refuses dialogType over 1 character`, async () => {
    const err = await catchErr(fn(conn, gate, baseParams({ dialogType: "DD" })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "dialogType" });
  });

  it(`${name}: refuses hotKey over 1 character`, async () => {
    const err = await catchErr(fn(conn, gate, baseParams({ hotKey: "XY" })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "hotKey" });
  });

  it(`${name}: refuses textTable over CHAR30`, async () => {
    const err = await catchErr(fn(conn, gate, baseParams({ textTable: "A".repeat(31) })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "textTable" });
  });
});

// ---------------------------------------------------------------------------
// issue #83, 2026-09-15 live finding: the collective-search-help shapes
// measured live on A4H, pinned directly rather than only via baseParams()
// overrides above.
// ---------------------------------------------------------------------------

describe("createSearchHelp/updateSearchHelp: collective search-help shapes measured live on A4H, 2026-09-15", () => {
  /** A minimal, otherwise-valid collective (elementary: false) `SearchHelpParams`. */
  function collectiveParams(overrides: Partial<SearchHelpParams> = {}): SearchHelpParams {
    return {
      shlpName: "ZTM_SH_CARRIER",
      description: "Carrier search help",
      packageName: LOCAL_PKG,
      elementary: false,
      fields: [],
      includes: [],
      assignments: [],
      ...overrides,
    };
  }

  it("the valid collective payload from the live investigation (fields MANDT/CCCATEGORY, include ZSH_I83_EL, assignments MANDT/CCCATEGORY) passes validate()", () => {
    const params = collectiveParams({
      fields: [
        { name: "MANDT", dataElement: "MANDT" },
        { name: "CCCATEGORY", dataElement: "CCCATEGORY" },
      ],
      includes: [{ name: "ZSH_I83_EL" }],
      assignments: [
        { field: "MANDT", includedHelp: "ZSH_I83_EL", includedField: "MANDT", direction: "I" },
        { field: "CCCATEGORY", includedHelp: "ZSH_I83_EL", includedField: "CCCATEGORY", direction: "E" },
      ],
    });
    expect(() => validate(params.packageName.name, params)).not.toThrow();
  });

  it("a collective that also carries a selection method is accepted — measured live: activates fine or only warns (DH108), never DH109", () => {
    const params = collectiveParams({
      selectionMethod: "ZTM_CARRIERS",
      selectionMethodType: "T",
      includes: [{ name: "ZSH_I83_EL" }],
    });
    expect(() => validate(params.packageName.name, params)).not.toThrow();
  });

  it("a collective with no includes is accepted — measured live: activates fine or only warns (DH108), never DH109", () => {
    const params = collectiveParams({ includes: [] });
    expect(() => validate(params.packageName.name, params)).not.toThrow();
  });

  it("a collective with no interface parameters and no assignments is accepted — measured live: activates fine or only warns (DH108), never DH109", () => {
    const params = collectiveParams({ fields: [], includes: [{ name: "ZSH_I83_EL" }], assignments: [] });
    expect(() => validate(params.packageName.name, params)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertSearchHelpTarget — pure, directly testable, no dummy args needed
// ---------------------------------------------------------------------------

describe("assertSearchHelpTarget (pure package/corrNr pairing rule, no conn/gate at all)", () => {
  it("returns the validated package name for a local package with no corrNr", () => {
    expect(assertSearchHelpTarget("$TMP", undefined)).toBe("$TMP");
  });

  it("returns the validated package name for a non-local package with a valid corrNr", () => {
    expect(assertSearchHelpTarget("ZTM", CORR)).toBe("ZTM");
  });

  it("refuses a local package paired with a corrNr", () => {
    expect(() => assertSearchHelpTarget("$TMP", CORR)).toThrowError();
    try {
      assertSearchHelpTarget("$TMP", CORR);
      throw new Error("expected a throw");
    } catch (e) {
      if (!isAbapError(e)) throw e;
      expect(e.code).toBe("BAD_INPUT");
    }
  });

  it("does NOT require a corrNr for a non-local package — that invariant belongs to validate(), not this function", () => {
    expect(assertSearchHelpTarget("ZTM", undefined)).toBe("ZTM");
  });

  it("refuses a malformed package identifier", () => {
    try {
      assertSearchHelpTarget("1BAD", undefined);
      throw new Error("expected a throw");
    } catch (e) {
      if (!isAbapError(e)) throw e;
      expect(e.code).toBe("BAD_INPUT");
    }
  });
});

// ---------------------------------------------------------------------------
// shlp-delete.ts: deleteSearchHelpViaBridge's validate() — small, folded in here
// ---------------------------------------------------------------------------

describe("shlp-delete.ts: deleteSearchHelpViaBridge validation", () => {
  function baseDeleteParams(overrides: Partial<SearchHelpDeleteParams> = {}): SearchHelpDeleteParams {
    return { shlpName: "ZTM_SH_CARRIER", packageName: LOCAL_PKG, ...overrides };
  }

  it("refuses shlpName over CHAR30", async () => {
    const err = await catchErr(deleteSearchHelpViaBridge(conn, gate, baseDeleteParams({ shlpName: "A".repeat(31) })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "shlpName" });
  });

  it("refuses a shlpName that would inject ABAP rather than escaping it", async () => {
    const err = await catchErr(
      deleteSearchHelpViaBridge(conn, gate, baseDeleteParams({ shlpName: `ZX'. LEAVE PROGRAM. "` })),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("refuses a packageName forced in via `as unknown as ServerPackage` with SAFETY_DENIED/PACKAGE_UNKNOWN", async () => {
    const forged = "ZTM" as unknown as ServerPackage;
    const err = await catchErr(deleteSearchHelpViaBridge(conn, gate, baseDeleteParams({ packageName: forged })));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details).toMatchObject({ reason: "PACKAGE_UNKNOWN" });
  });

  it("does not itself validate confirmInUse's type — a non-boolean value passes validate() untouched (documents current behaviour, not a claim it is correct)", async () => {
    await expect(
      deleteSearchHelpViaBridge(conn, gate, baseDeleteParams({ confirmInUse: "yes" as unknown as boolean })),
    ).rejects.not.toSatisfy((e: unknown) => isAbapError(e));
  });

  it("accepts a valid shlpName/package pairing through validate() (rejects only once past it)", async () => {
    await expect(deleteSearchHelpViaBridge(conn, gate, baseDeleteParams())).rejects.not.toSatisfy((e: unknown) =>
      isAbapError(e),
    );
  });
});

// ---------------------------------------------------------------------------
// view-update.ts: updateClassicView's own validation — small, folded in here
// ---------------------------------------------------------------------------

describe("view-update.ts: updateClassicView validation", () => {
  function baseViewParams(overrides: Partial<ClassicViewParams> = {}): ClassicViewParams {
    return {
      viewName: "ZTM_V_CARRIER",
      baseTable: "ZTM_CARRIERS",
      fields: ["CARRID", "CARRNAME"],
      description: "Carrier view",
      packageName: "$TMP",
      ...overrides,
    };
  }

  it("refuses a non-array fields", async () => {
    const err = await catchErr(
      updateClassicView(conn, gate, baseViewParams({ fields: "nope" as unknown as readonly string[] })),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("refuses an empty fields array — an update replaces the whole projection, so empty means projecting nothing", async () => {
    const err = await catchErr(updateClassicView(conn, gate, baseViewParams({ fields: [] })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("non-empty list of base-table field names");
    expect(err.details).toMatchObject({ viewName: "ZTM_V_CARRIER", baseTable: "ZTM_CARRIERS" });
  });

  it("refuses a viewName over CHAR30", async () => {
    // updateClassicView now runs the same validation as createClassicView
    // (view-create.ts's validate()) on viewName/baseTable/fields/description,
    // via the shared assertEnhIdentifier/assertAbapText calls and the same
    // VIEW_NAME_MAX/VIEW_TEXT_MAX/MAX_VIEW_FIELDS limits — not just
    // packageName/corrNr via assertClassicViewCreateTarget. An over-length
    // viewName is refused here, before it ever reaches abap-view.ts's
    // update_view, where it would otherwise be assigned into DD25V-VIEWNAME
    // (CHAR30) and silently truncated.
    const err = await catchErr(
      updateClassicView(conn, gate, baseViewParams({ viewName: "Z" + "A".repeat(30) })),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "viewName" });
  });

  it("refuses a local package paired with a corrNr", async () => {
    const err = await catchErr(updateClassicView(conn, gate, baseViewParams({ packageName: "$TMP", corrNr: CORR })));
    expect(err.code).toBe("BAD_INPUT");
  });

  it("refuses a non-local package with no corrNr as TRANSPORT_ERROR", async () => {
    const err = await catchErr(updateClassicView(conn, gate, baseViewParams({ packageName: "ZTM" })));
    expect(err.code).toBe("TRANSPORT_ERROR");
  });

  it("accepts a non-local package with a valid corrNr through validate() (rejects only once past it)", async () => {
    await expect(
      updateClassicView(conn, gate, baseViewParams({ packageName: "ZTM", corrNr: CORR })),
    ).rejects.not.toSatisfy((e: unknown) => isAbapError(e));
  });
});

// ---------------------------------------------------------------------------
// tran-update.ts: updateTransaction's own validation — small, folded in here
// ---------------------------------------------------------------------------

describe("tran-update.ts: updateTransaction validation", () => {
  function baseTranParams(overrides: Partial<TransactionUpdateParams> = {}): TransactionUpdateParams {
    return {
      tcode: "ZTM_CARRIERS",
      program: "ZTM_CARRIERS_REPORT",
      description: "Carrier maintenance",
      packageName: LOCAL_PKG,
      ...overrides,
    };
  }

  it("refuses a tcode that is not a valid transaction code", async () => {
    const err = await catchErr(updateTransaction(conn, gate, baseTranParams({ tcode: "1BAD" })));
    expect(err.code).toBe("BAD_INPUT");
  });

  it("refuses a program over CHAR40", async () => {
    const err = await catchErr(updateTransaction(conn, gate, baseTranParams({ program: "Z" + "A".repeat(40) })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "program" });
  });

  it("refuses a description over TSTCT-TTEXT's CHAR37", async () => {
    const err = await catchErr(updateTransaction(conn, gate, baseTranParams({ description: "D".repeat(38) })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details).toMatchObject({ what: "description" });
  });

  it("accepts a description at exactly CHAR37", async () => {
    await expect(
      updateTransaction(conn, gate, baseTranParams({ description: "D".repeat(37) })),
    ).rejects.not.toSatisfy((e: unknown) => isAbapError(e));
  });

  it("refuses a packageName forced in via `as unknown as ServerPackage` with SAFETY_DENIED/PACKAGE_UNKNOWN", async () => {
    const forged = "ZTM" as unknown as ServerPackage;
    const err = await catchErr(updateTransaction(conn, gate, baseTranParams({ packageName: forged })));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details).toMatchObject({ reason: "PACKAGE_UNKNOWN" });
  });

  it("refuses a local package paired with a corrNr", async () => {
    const err = await catchErr(updateTransaction(conn, gate, baseTranParams({ packageName: LOCAL_PKG, corrNr: CORR })));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("nothing here for one to attach to");
  });

  it("refuses a non-local package with no corrNr as TRANSPORT_ERROR", async () => {
    const err = await catchErr(updateTransaction(conn, gate, baseTranParams({ packageName: REAL_PKG })));
    expect(err.code).toBe("TRANSPORT_ERROR");
    expect(err.hint).toContain("abapsmith-put-work-on-a-transport");
  });

  it("accepts a non-local package with a valid corrNr through validate() (rejects only once past it)", async () => {
    await expect(
      updateTransaction(conn, gate, baseTranParams({ packageName: REAL_PKG, corrNr: CORR })),
    ).rejects.not.toSatisfy((e: unknown) => isAbapError(e));
  });
});

describe("assertTransactionUpdateTarget (pure package/corrNr pairing rule, no conn/gate at all)", () => {
  it("returns the validated package name for a local package with no corrNr", () => {
    expect(assertTransactionUpdateTarget("$TMP", undefined)).toBe("$TMP");
  });

  it("returns the validated package name for a non-local package with a valid corrNr", () => {
    expect(assertTransactionUpdateTarget("ZTM", CORR)).toBe("ZTM");
  });

  it("refuses a local package paired with a corrNr", () => {
    try {
      assertTransactionUpdateTarget("$TMP", CORR);
      throw new Error("expected a throw");
    } catch (e) {
      if (!isAbapError(e)) throw e;
      expect(e.code).toBe("BAD_INPUT");
    }
  });

  it("refuses a non-local package with no corrNr as TRANSPORT_ERROR — unlike assertSearchHelpTarget, this one owns that invariant itself", () => {
    try {
      assertTransactionUpdateTarget("ZTM", undefined);
      throw new Error("expected a throw");
    } catch (e) {
      if (!isAbapError(e)) throw e;
      expect(e.code).toBe("TRANSPORT_ERROR");
    }
  });

  it("refuses a corrNr that is not TRKORR-shaped", () => {
    try {
      assertTransactionUpdateTarget("ZTM", "not-a-trkorr");
      throw new Error("expected a throw");
    } catch (e) {
      if (!isAbapError(e)) throw e;
      expect(e.code).toBe("BAD_INPUT");
    }
  });
});
