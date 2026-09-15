/**
 * `abap_read`'s new `view="lineage"`/`view="footprint"` wiring (issues
 * #106/#107) — `src/tools/read.ts`. Pure input-validation: every test here
 * uses a stub connection whose every method throws a distinctive sentinel
 * error, so a test only passes if the refusal fires BEFORE any network
 * call — proving the check is a parameter check, not a response to a
 * failed fetch.
 */
import { describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import { isAbapError } from "../src/adt/errors.js";

const stub = { object: {} as ResolvedObject };

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => stub.object,
}));

const { abapRead } = await import("../src/tools/read.js");
const { LINEAGE_MAX_DEPTH } = await import("../src/adt/cds-lineage.js");

const NEVER_CALLED = new Error("SENTINEL: connection method called — refusal did not fire before the network call");

function neverConn(): AbapConnection {
  return {
    cfg: { sid: "A4H" },
    get: async () => {
      throw NEVER_CALLED;
    },
    post: async () => {
      throw NEVER_CALLED;
    },
  } as unknown as AbapConnection;
}

function resolved(over: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "DDLS/DF",
    kind: "DDLS",
    label: "CDS view",
    name: "ZDEMO_C_SalesOrder_TP_D",
    uri: "/sap/bc/adt/ddic/ddl/sources/zdemo_c_salesorder_tp_d",
    sourceUri: "/sap/bc/adt/ddic/ddl/sources/zdemo_c_salesorder_tp_d/source/main",
    mode: "source",
    activation: "unknown",
    spec: {},
    ...over,
  } as unknown as ResolvedObject;
}

async function catchAbapAsync(p: Promise<unknown>): Promise<import("../src/adt/errors.js").AbapError> {
  try {
    await p;
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected an AbapError, but the call resolved normally");
}

describe("view=\"lineage\" is refused for non-CDS types", () => {
  it("a CLAS/OC object with view=\"lineage\" is refused UNSUPPORTED, never reaching the connection", async () => {
    stub.object = resolved({ type: "CLAS/OC", name: "ZCL_FOO" });
    const err = await catchAbapAsync(
      abapRead(neverConn(), { object: "ZCL_FOO", view: "lineage" }, 20_000),
    );
    expect(err.code).toBe("UNSUPPORTED");
  });
});

describe("view=\"footprint\" is refused for unsupported types, listing the four supported types", () => {
  it("a DDLS/DF object with view=\"footprint\" is refused UNSUPPORTED naming PROG/P, CLAS/OC, FUGR/F, FUGR/FF", async () => {
    stub.object = resolved({ type: "DDLS/DF", name: "ZDEMO_C_SalesOrder_TP_D" });
    const err = await catchAbapAsync(
      abapRead(neverConn(), { object: "ZDEMO_C_SalesOrder_TP_D", view: "footprint" }, 20_000),
    );
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).toContain("PROG/P");
    expect(err.message).toContain("CLAS/OC");
    expect(err.message).toContain("FUGR/F");
    expect(err.message).toContain("FUGR/FF");
  });
});

describe("field is refused outside view=\"lineage\" via two different code paths", () => {
  it("field with a non-lineage view (definition) is refused BAD_INPUT by assertViewCompatible", async () => {
    stub.object = resolved({ type: "CLAS/OC", name: "ZCL_FOO", sourceUri: "/x/source/main" });
    const err = await catchAbapAsync(
      abapRead(neverConn(), { object: "ZCL_FOO", view: "definition", line: 1, field: "Foo" }, 20_000),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("field with NO view at all is refused BAD_INPUT by the separate post-dispatch field check", async () => {
    stub.object = resolved({ type: "CLAS/OC", name: "ZCL_FOO" });
    const err = await catchAbapAsync(
      abapRead(neverConn(), { object: "ZCL_FOO", field: "Foo" }, 20_000),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toMatch(/view="lineage"/);
  });
});

describe("depth is refused for every view except lineage", () => {
  it.each(["footprint", "history", "diff", "definition"] as const)(
    "depth with view=\"%s\" is refused BAD_INPUT",
    async (view) => {
      stub.object = resolved({ type: "PROG/P", name: "Z_FOO", sourceUri: "/x/source/main" });
      const input: Record<string, unknown> = { object: "Z_FOO", view, depth: 2 };
      if (view === "definition") input.line = 1;
      const err = await catchAbapAsync(abapRead(neverConn(), input as never, 20_000));
      expect(err.code).toBe("BAD_INPUT");
    },
  );
});

describe("view=\"lineage\" depth bound", () => {
  it(`depth > LINEAGE_MAX_DEPTH (${LINEAGE_MAX_DEPTH}) is refused BAD_INPUT naming the max`, async () => {
    stub.object = resolved({ type: "DDLS/DF", name: "ZDEMO_C_SalesOrder_TP_D" });
    const err = await catchAbapAsync(
      abapRead(neverConn(), { object: "ZDEMO_C_SalesOrder_TP_D", view: "lineage", depth: LINEAGE_MAX_DEPTH + 1 }, 20_000),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain(String(LINEAGE_MAX_DEPTH));
  });
});

describe("DEVC/K depth bound is still enforced even though zod's .max(3) was removed from the schema", () => {
  it("DEVC/K with depth above 3 is refused BAD_INPUT (behaviour-change guard for the schema edit)", async () => {
    stub.object = resolved({ type: "DEVC/K", kind: "DEVC", name: "ZI105", uri: "/sap/bc/adt/packages/zi105", mode: "ddic" });
    const err = await catchAbapAsync(
      abapRead(neverConn(), { object: "ZI105", depth: 4 }, 20_000),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("DEVC/K with depth:2 and no view is NOT refused (ordinary package path) — it proceeds at least to the connection", async () => {
    stub.object = resolved({ type: "DEVC/K", kind: "DEVC", name: "ZI105", uri: "/sap/bc/adt/packages/zi105", mode: "ddic" });
    // The package-read path (readPackage -> fetchPackageNodes/
    // fetchPackageHeader) deliberately treats a connection failure with no
    // numeric HTTP status as "empty/no data" rather than rethrowing it — see
    // the "tolerant of the zero-byte-200 shape" comment above
    // fetchPackageNodes in src/adt/ddic.ts — so a thrown sentinel can't be
    // observed as a rejection here the way it can for the other views.
    // Proof that no parameter refusal fired before the connection is instead
    // that `conn.adt.nodeContents` (the actual call `readPackage` makes) was
    // reached at all, and the call resolves without a BAD_INPUT/UNSUPPORTED
    // error despite going through the depth-bound-enforcing package path.
    let nodeContentsCalled = false;
    const conn = {
      cfg: { sid: "A4H" },
      get: async () => {
        throw NEVER_CALLED;
      },
      post: async () => {
        throw NEVER_CALLED;
      },
      adt: {
        nodeContents: async () => {
          nodeContentsCalled = true;
          throw NEVER_CALLED;
        },
      },
    } as unknown as AbapConnection;

    await abapRead(conn, { object: "ZI105", depth: 2 }, 20_000);
    expect(nodeContentsCalled).toBe(true);
  });
});

describe("a sample of refused parameters for the new views", () => {
  it("format with view=\"lineage\" is refused UNSUPPORTED naming view=\"lineage\"", async () => {
    stub.object = resolved({ type: "DDLS/DF", name: "ZDEMO_C_SalesOrder_TP_D" });
    const err = await catchAbapAsync(
      abapRead(neverConn(), { object: "ZDEMO_C_SalesOrder_TP_D", view: "lineage", format: "raw" }, 20_000),
    );
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).toMatch(/view="lineage"/);
  });

  it("outline with view=\"footprint\" is refused UNSUPPORTED", async () => {
    stub.object = resolved({ type: "PROG/P", name: "Z_I107_FOOTPRINT", sourceUri: "/x/source/main" });
    const err = await catchAbapAsync(
      abapRead(neverConn(), { object: "Z_I107_FOOTPRINT", view: "footprint", outline: true }, 20_000),
    );
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).toMatch(/view="footprint"/);
  });

  it("method with view=\"lineage\" is refused UNSUPPORTED", async () => {
    stub.object = resolved({ type: "DDLS/DF", name: "ZDEMO_C_SalesOrder_TP_D" });
    const err = await catchAbapAsync(
      abapRead(neverConn(), { object: "ZDEMO_C_SalesOrder_TP_D", view: "lineage", method: "FOO" }, 20_000),
    );
    expect(err.code).toBe("UNSUPPORTED");
  });

  it("types with view=\"lineage\" is refused UNSUPPORTED (types is a DEVC/K-only parameter, and lineage is a separate axis besides)", async () => {
    stub.object = resolved({ type: "DDLS/DF", name: "ZDEMO_C_SalesOrder_TP_D" });
    const err = await catchAbapAsync(
      abapRead(neverConn(), { object: "ZDEMO_C_SalesOrder_TP_D", view: "lineage", types: "DDLS" }, 20_000),
    );
    expect(err.code).toBe("UNSUPPORTED");
  });

  it("offset/limit with view=\"footprint\" is refused UNSUPPORTED", async () => {
    stub.object = resolved({ type: "PROG/P", name: "Z_I107_FOOTPRINT", sourceUri: "/x/source/main" });
    const err = await catchAbapAsync(
      abapRead(neverConn(), { object: "Z_I107_FOOTPRINT", view: "footprint", offset: 1, limit: 10 }, 20_000),
    );
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).toMatch(/view="footprint"/);
  });

  it("include with view=\"footprint\" against a CLAS/OC is refused UNSUPPORTED — footprint scans ALL includes by design", async () => {
    stub.object = resolved({ type: "CLAS/OC", name: "ZCL_FOO", sourceUri: "/x/source/main" });
    const err = await catchAbapAsync(
      abapRead(neverConn(), { object: "ZCL_FOO", view: "footprint", include: "testclasses" }, 20_000),
    );
    expect(err.code).toBe("UNSUPPORTED");
  });
});
