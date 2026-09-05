/**
 * The two caller-facing `format="raw"` strings (the `format` zod description
 * and the properties-shape refusal messages) are derived from the registry
 * (`PROPERTIES_SHAPE_TYPES`) so they cannot drift from the runtime gate
 * (`capabilitiesFor(obj.type)?.write?.shape !== "properties"`), which admits
 * six types while the strings used to name five (missing SRVB/SVB and
 * saying "DDIC" even though SRVB/SVB is not DDIC).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import type { AbapError } from "../src/adt/errors.js";
import { REGISTRY, PROPERTIES_SHAPE_TYPES } from "../src/adt/capabilities.js";
import type { ResolvedObject } from "../src/adt/resolve.js";

// Computed independently from REGISTRY itself, not from the export under test.
const shaped = Object.entries(REGISTRY)
  .filter(([, c]) => c.write?.shape === "properties")
  .map(([code]) => code);

const stub = { object: {} as ResolvedObject };

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => stub.object,
}));

const { abapRead, readInputSchema } = await import("../src/tools/read.js");

function resolved(over: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "CLAS/OC",
    kind: "CLAS",
    label: "class",
    name: "ZCL_BIG",
    uri: "/sap/bc/adt/oo/classes/zcl_big",
    mode: "source",
    activation: "unknown",
    spec: {},
    ...over,
  } as unknown as ResolvedObject;
}

const conn = { cfg: { sid: "A4H" } } as unknown as AbapConnection;

beforeEach(() => {
  stub.object = resolved();
});

describe('format="raw"\'s caller-facing type list is derived from the registry, not hand-maintained', () => {
  it("REGISTRY has not collapsed to an empty properties-shape set", () => {
    expect(shaped.length).toBeGreaterThanOrEqual(6);
    expect(shaped).toContain("SRVB/SVB");
  });

  it("PROPERTIES_SHAPE_TYPES matches the independently-derived set exactly", () => {
    expect([...PROPERTIES_SHAPE_TYPES].sort()).toEqual([...shaped].sort());
  });

  it('readInputSchema.format.description names every properties-shape type and drops "DDIC"', () => {
    const description = readInputSchema.format.description;
    expect(description).toBeDefined();
    for (const code of shaped) expect(description).toContain(code);
    expect(description).not.toContain("DDIC");
  });

  it('format="raw" refusal for a source-shape type names every properties-shape type and drops "DDIC"', async () => {
    stub.object = resolved({ type: "CLAS/OC", kind: "CLAS", name: "ZCL_BIG" });
    let caught: AbapError | undefined;
    try {
      await abapRead(conn, { object: "ZCL_BIG", format: "raw" } as never, 20_000);
    } catch (e) {
      caught = e as AbapError;
    }
    expect(caught?.code).toBe("UNSUPPORTED");
    for (const code of shaped) expect(caught?.message).toContain(code);
    expect(caught?.message).not.toContain("DDIC");
  });

  it('format="raw" + include="testclasses" clash on a class names every properties-shape type and drops "DDIC"', async () => {
    stub.object = resolved({ type: "CLAS/OC", kind: "CLAS", name: "ZCL_BIG" });
    let caught: AbapError | undefined;
    try {
      await abapRead(
        conn,
        { object: "ZCL_BIG", format: "raw", include: "testclasses" } as never,
        20_000,
      );
    } catch (e) {
      caught = e as AbapError;
    }
    expect(caught?.code).toBe("UNSUPPORTED");
    // Pins the clash message itself firing, not the properties-shape refusal it shares a code with.
    expect(caught?.message).toContain('cannot be combined with include="testclasses"');
    for (const code of shaped) expect(caught?.message).toContain(code);
    expect(caught?.message).not.toContain("DDIC");
  });
});
