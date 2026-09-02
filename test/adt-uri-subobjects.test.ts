/**
 * A raw ADT URI addressing a sub-object of a known object
 * (`.../indexes/z01`, `.../objectstructure`, ...) used to fall through
 * `specFromUri`'s miss into the generic "Unrecognised ADT URI" BAD_INPUT —
 * same message as a genuinely unknown path. `classifyUnmatchedAdtPath`
 * now tells the two apart: a sub-object suffix is UNSUPPORTED and names
 * both the sub-object and its parent; a non-object path (a transport
 * request) is a specific BAD_INPUT pointing at the right tool.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseObjectRef } from "../src/adt/resolve.js";
import { isAbapError } from "../src/adt/errors.js";
import { registerWriteTools, type WriteToolDeps } from "../src/tools/write.js";
import { errorResult } from "../src/server.js";
import { SafetyGate } from "../src/safety.js";

const INDEX_URI = "/sap/bc/adt/ddic/tables/zt1_torder/indexes/z01";

function expectThrows(fn: () => unknown, code: string) {
  try {
    fn();
    expect.unreachable(`expected a ${code} throw`);
  } catch (e) {
    expect(isAbapError(e)).toBe(true);
    expect((e as { code: string }).code).toBe(code);
    return e as InstanceType<typeof Error> & {
      code: string;
      message: string;
      hint?: string;
      details: Record<string, unknown>;
    };
  }
}

describe("parseObjectRef — sub-object ADT URI regression guard", () => {
  it("throws UNSUPPORTED, not BAD_INPUT, and names both index and table", () => {
    const e = expectThrows(() => parseObjectRef(INDEX_URI), "UNSUPPORTED");
    expect(e.message).toContain("Z01");
    expect(e.message).toContain("ZT1_TORDER");
    expect(e.details).toMatchObject({
      uri: INDEX_URI,
      type: "TABL/DT",
      object: "ZT1_TORDER",
      subObject: "indexes",
      subName: "Z01",
    });
  });

  it("does not fall back to the generic 'Unrecognised ADT URI' message", () => {
    const e = expectThrows(() => parseObjectRef(INDEX_URI), "UNSUPPORTED");
    expect(e.message).not.toContain("Unrecognised ADT URI");
  });
});

describe("parseObjectRef — other sub-object shapes are specific, not generic", () => {
  it.each([
    {
      uri: "/sap/bc/adt/oo/classes/zcl_foo/objectstructure",
      type: "CLAS/OC",
      object: "ZCL_FOO",
      subObject: "objectstructure",
      subName: undefined,
    },
    {
      uri: "/sap/bc/adt/ddic/domains/zdom/values",
      type: "DOMA/DD",
      object: "ZDOM",
      subObject: "values",
      subName: undefined,
    },
  ])("$uri", ({ uri, type, object, subObject, subName }) => {
    const e = expectThrows(() => parseObjectRef(uri), "UNSUPPORTED");
    expect(e.message).not.toContain("Unrecognised ADT URI");
    expect(e.details).toMatchObject({ uri, type, object, subObject });
    if (subName) expect(e.details.subName).toBe(subName);
    else expect(e.details.subName).toBeUndefined();
  });
});

describe("parseObjectRef — sub-object suffix on a function-module URI", () => {
  const uri = "/sap/bc/adt/functions/groups/zfg/fmodules/z_fm/something";

  it("refuses UNSUPPORTED instead of silently resolving to the function module", () => {
    const e = expectThrows(() => parseObjectRef(uri), "UNSUPPORTED");
    expect(e.message).not.toContain("Unrecognised ADT URI");
    expect(e.details).toMatchObject({
      uri,
      type: "FUGR/FF",
      object: "Z_FM",
      subObject: "something",
    });
  });

  it("keeps the parent function group in the guidance", () => {
    const e = expectThrows(() => parseObjectRef(uri), "UNSUPPORTED");
    expect(e.hint).toContain("/sap/bc/adt/functions/groups/zfg/fmodules/z_fm");
  });
});

describe("parseObjectRef — a transport request is refused specifically, not treated as an object", () => {
  const uri = "/sap/bc/adt/cts/transportrequests/A4HK900123";

  it("throws BAD_INPUT naming it a transport request, hinting at abap_transport", () => {
    const e = expectThrows(() => parseObjectRef(uri), "BAD_INPUT");
    expect(e.message).toContain("transport request");
    expect(e.hint).toContain("abap_transport");
  });

  it("never resolves — no spec, no name, no uri on the thrown side", () => {
    expect(() => parseObjectRef(uri)).toThrow();
  });
});

describe("parseObjectRef — no widening: genuinely unknown paths stay generic", () => {
  it("still throws BAD_INPUT 'Unrecognised ADT URI' for nonsense", () => {
    const e = expectThrows(() => parseObjectRef("/sap/bc/adt/nonsense/thing"), "BAD_INPUT");
    expect(e.message).toContain("Unrecognised ADT URI");
  });

  it.each([
    ["/sap/bc/adt/ddic/tables/zt1_torder", "TABL/DT", "ZT1_TORDER"],
    ["/sap/bc/adt/oo/classes/zcl_foo", "CLAS/OC", "ZCL_FOO"],
    ["/sap/bc/adt/programs/programs/zdemo1", "PROG/P", "ZDEMO1"],
    ["/sap/bc/adt/functions/groups/zfg/fmodules/z_fm", "FUGR/FF", "Z_FM"],
  ])("plain object URI %s still resolves", (uri, type, name) => {
    const r = parseObjectRef(uri);
    expect(r.spec?.type).toBe(type);
    expect(r.name).toBe(name);
  });
});

describe("parseObjectRef — class includes are not sub-objects", () => {
  it("still resolves .../includes/testclasses with include set, not diverted to a refusal", () => {
    const r = parseObjectRef("/sap/bc/adt/oo/classes/zcl_foo/includes/testclasses");
    expect(r.spec?.type).toBe("CLAS/OC");
    expect(r.name).toBe("ZCL_FOO");
    expect(r.include).toBe("testclasses");
  });

  it("still strips a /source/main suffix cleanly", () => {
    const r = parseObjectRef("/sap/bc/adt/oo/classes/zcl_foo/source/main");
    expect(r.spec?.type).toBe("CLAS/OC");
    expect(r.name).toBe("ZCL_FOO");
    expect(r.include).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tool-boundary check: `abap_write`'s handler calls `preflight()` — which
// runs `parseObjectRef` — BEFORE `ensureConnected()`, so a bad ADT URI is
// refused with zero network I/O. That lets the improved error be observed
// through a real registered MCP tool without a fake ADT backend at all.
// ---------------------------------------------------------------------------
async function writeToolHarness() {
  let connected = false;
  const deps: WriteToolDeps = {
    pool: {
      withWrite: async () => {
        throw new Error("pool.withWrite must not be reached — preflight should refuse first");
      },
    } as never,
    safety: new SafetyGate({ readOnly: false, allowPackages: ["*"] }),
    ensureConnected: async () => {
      connected = true;
    },
    errorResult,
    cfg: { maxResponseChars: 50_000 },
    journal: undefined as never,
    transport: undefined as never,
  };
  const server = new McpServer({ name: "adt-uri-subobjects-probe", version: "0.0.0" });
  registerWriteTools(server, deps);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "adt-uri-subobjects-probe", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const call = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: "abap_write", arguments: args });
    const first = Array.isArray(res.content) ? res.content[0] : undefined;
    const text =
      first && typeof first === "object" && "text" in first
        ? String((first as { text: unknown }).text)
        : "";
    return { isError: res.isError, payload: JSON.parse(text) as Record<string, unknown> };
  };
  return { call, wasConnected: () => connected };
}

describe("abap_write — the sub-object refusal reaches the tool boundary", () => {
  it("returns the UNSUPPORTED envelope for the reported index URI, with zero network I/O", async () => {
    const { call, wasConnected } = await writeToolHarness();
    const { isError, payload } = await call({ object: INDEX_URI, source: "x" });

    expect(isError).toBe(true);
    expect(payload.error).toBe("UNSUPPORTED");
    expect(String(payload.message)).toContain("ZT1_TORDER");
    expect(String(payload.message)).not.toContain("Unrecognised ADT URI");
    expect(wasConnected()).toBe(false);
  });

  it("returns the transport-request BAD_INPUT envelope, not a resolved object", async () => {
    const { call } = await writeToolHarness();
    const { isError, payload } = await call({
      object: "/sap/bc/adt/cts/transportrequests/A4HK900123",
      source: "x",
    });

    expect(isError).toBe(true);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("transport request");
    expect(String(payload.hint)).toContain("abap_transport");
  });
});
