/**
 * Regression tests for two live-verified defects in `abap_read` (issue #108):
 *
 * Defect 2 — `view="docu"` WITH `method=` was refused with UNSUPPORTED
 * ("...needs a SafetyGate to judge; none was supplied...") even though that
 * branch (`readDocu` in src/tools/read.ts) never dispatches `core.docu`: it
 * is a pure source scan (`readSource` + `extractAbapDoc`). `requireDocuGate`
 * used to run unconditionally in `abapRead` before `readDocu` got a chance
 * to take its method branch. Fixed by moving the `requireDocuGate` call
 * inside `readDocu`'s object-based (no `method=`) path, right before the
 * `core.docu` dispatch it actually guards.
 *
 * Defect 3 — a bare `type="FUGR"` with `view="digest"` silently resolved to
 * FUGR/F (the function group) instead of being refused as ambiguous between
 * FUGR/F and FUGR/FF (a single function module), because `resolveObject`
 * normalises the bare type before `readDigest`'s `isDigestType` check (which
 * already refuses a bare FUGR — see digest.ts) ever saw the caller's raw
 * type. Fixed by checking the raw `input.type` in `abapRead`, before
 * `resolveObject` runs.
 *
 * Harness style copied from test/empty-source-read.test.ts: `resolveObject`
 * and `readSource` mocked, `abapRead` driven directly against a minimal fake
 * `AbapConnection` — no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";

const stub = {
  object: {} as ResolvedObject,
  source: "",
  /** Set to make the mocked resolveObject throw instead of resolving — used to prove a code path DID reach resolveObject (the ambiguity guard must run before it). */
  resolveError: undefined as Error | undefined,
};

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => {
    if (stub.resolveError) throw stub.resolveError;
    return stub.object;
  },
}));

vi.mock("../src/adt/source.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/source.js")>()),
  readSource: async () => ({ source: stub.source, sourceUri: "" }),
}));

const { abapRead } = await import("../src/tools/read.js");

function resolvedClass(over: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "CLAS/OC",
    kind: "CLAS",
    label: "class",
    name: "CL_ABAP_TSTMP",
    uri: "/sap/bc/adt/oo/classes/cl_abap_tstmp",
    sourceUri: "/sap/bc/adt/oo/classes/cl_abap_tstmp/source/main",
    mode: "source",
    activation: "unknown",
    spec: {},
    ...over,
  } as unknown as ResolvedObject;
}

const conn = { cfg: { sid: "A4H" } } as unknown as AbapConnection;

beforeEach(() => {
  stub.object = resolvedClass();
  stub.source = "";
  stub.resolveError = undefined;
});

const METHOD_SOURCE = [
  "CLASS cl_abap_tstmp DEFINITION PUBLIC.",
  "  PUBLIC SECTION.",
  '    "! Adds a duration to a timestamp.',
  '    "! @parameter iv_stamp | timestamp to add to',
  '    "! @parameter rv_result | resulting timestamp',
  "    CLASS-METHODS add",
  "      IMPORTING iv_stamp TYPE tzntstmps",
  "      RETURNING VALUE(rv_result) TYPE tzntstmps.",
  "ENDCLASS.",
].join("\n");

describe("view=\"docu\" method= reads ABAP Doc from source, no gate needed (defect 2)", () => {
  it("succeeds with no gate supplied and returns the ABAP Doc text", async () => {
    stub.source = METHOD_SOURCE;
    const r = await abapRead(
      conn,
      { object: "CL_ABAP_TSTMP", type: "CLAS/OC", method: "ADD", view: "docu" },
      20_000,
      // no gate argument
    );
    expect(r.text).toContain("Adds a duration to a timestamp.");
    expect(r.text).not.toContain("UNSUPPORTED");
    expect(r.text).not.toContain("SafetyGate");
  });

  it("does not throw UNSUPPORTED / need a SafetyGate for the method branch", async () => {
    stub.source = METHOD_SOURCE;
    await expect(
      abapRead(conn, { object: "CL_ABAP_TSTMP", type: "CLAS/OC", method: "ADD", view: "docu" }, 20_000),
    ).resolves.not.toThrow();
  });
});

describe("view=\"docu\" WITHOUT method= still requires a gate (control — must not regress)", () => {
  it("throws UNSUPPORTED naming SafetyGate when no gate is supplied", async () => {
    await expect(
      abapRead(conn, { object: "CL_ABAP_TSTMP", type: "CLAS/OC", view: "docu" }, 20_000),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("SafetyGate"),
    });
  });
});

describe('view="digest" refuses a bare type="FUGR" as ambiguous (defect 3)', () => {
  it('refuses uppercase "FUGR" before ever calling resolveObject', async () => {
    stub.resolveError = new Error("SENTINEL_RESOLVE_CALLED");
    await expect(
      abapRead(conn, { object: "STRING_CONVERSIONS", type: "FUGR", view: "digest" }, 20_000),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("FUGR/F"),
    });
    await expect(
      abapRead(conn, { object: "STRING_CONVERSIONS", type: "FUGR", view: "digest" }, 20_000),
    ).rejects.toMatchObject({
      message: expect.stringContaining("FUGR/FF"),
    });
  });

  it('refuses lowercase "fugr" the same way, case-insensitively', async () => {
    stub.resolveError = new Error("SENTINEL_RESOLVE_CALLED");
    await expect(
      abapRead(conn, { object: "STRING_CONVERSIONS", type: "fugr", view: "digest" }, 20_000),
    ).rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("FUGR/F") });
  });

  it("tolerates surrounding whitespace around the bare type", async () => {
    stub.resolveError = new Error("SENTINEL_RESOLVE_CALLED");
    await expect(
      abapRead(conn, { object: "STRING_CONVERSIONS", type: "  FUGR  ", view: "digest" }, 20_000),
    ).rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("FUGR/F") });
  });

  it("never reaches resolveObject for the ambiguous bare form (no sentinel leaks through)", async () => {
    stub.resolveError = new Error("SENTINEL_RESOLVE_CALLED");
    await expect(
      abapRead(conn, { object: "STRING_CONVERSIONS", type: "FUGR", view: "digest" }, 20_000),
    ).rejects.not.toMatchObject({ message: "SENTINEL_RESOLVE_CALLED" });
  });

  it('leaves type="FUGR/F" unaffected — reaches resolveObject as before', async () => {
    stub.resolveError = new Error("SENTINEL_RESOLVE_CALLED");
    await expect(
      abapRead(conn, { object: "STRING_CONVERSIONS", type: "FUGR/F", view: "digest" }, 20_000),
    ).rejects.toThrow("SENTINEL_RESOLVE_CALLED");
  });

  it('leaves type="FUGR/FF" unaffected — reaches resolveObject as before', async () => {
    stub.resolveError = new Error("SENTINEL_RESOLVE_CALLED");
    await expect(
      abapRead(conn, { object: "STRING_CONVERSIONS", type: "FUGR/FF", view: "digest" }, 20_000),
    ).rejects.toThrow("SENTINEL_RESOLVE_CALLED");
  });

  it('leaves a bare "FUGR" unaffected for a view other than "digest"', async () => {
    // No view="digest" here, so the ambiguity guard must not fire; the call
    // proceeds to resolveObject like any ordinary read.
    stub.resolveError = new Error("SENTINEL_RESOLVE_CALLED");
    await expect(
      abapRead(conn, { object: "STRING_CONVERSIONS", type: "FUGR" }, 20_000),
    ).rejects.toThrow("SENTINEL_RESOLVE_CALLED");
  });
});
