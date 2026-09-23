/** `abap_rap` tool tests: fake-io core behaviour plus mode gating through the real MCP server. */
import { describe, expect, it, vi } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type Config } from "../src/config.js";
import { createServer, type AbapsmithServer } from "../src/server.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import type { AbapMode } from "../src/mode.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import { abapRap, type RapIo } from "../src/tools/rap.js";
import { deriveRapNames } from "../src/adt/rap-generate.js";
import { AbapError } from "../src/adt/errors.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type { WriteInput } from "../src/tools/write.js";
import type { DdlField } from "../src/adt/ddic.js";
import type { BuiltResponse } from "../src/compact.js";

const TABLE = "ZAS_BOOKING197";
const PACKAGE = "ZAS_BK197_PKG";
const PREFIX = "ZAS_BK197";
const CORR_NR = "TR1K900123";
const BINDING_URL = "/sap/bc/adt/businessservices/bindings/zui_as_bk197_o4";

const FIELDS: DdlField[] = [
  { name: "MANDT", type: "abap.clnt", key: true, notNull: true },
  { name: "BOOKING_UUID", type: "sysuuid_x16", key: true, notNull: true },
  { name: "CUSTOMER_ID", type: "abap.char(10)", key: false, notNull: false },
  { name: "BOOKING_DATE", type: "abap.dats", key: false, notNull: false },
  { name: "AMOUNT", type: "abap.dec(15,2)", key: false, notNull: false },
  { name: "CURRENCY_CODE", type: "abap.cuky", key: false, notNull: false },
  { name: "STATUS", type: "abap.char(1)", key: false, notNull: false },
  { name: "LAST_CHANGED_AT", type: "timestampl", key: false, notNull: false },
];

const NAMES = deriveRapNames(PREFIX, { bindingType: "V4" });
const FAKE_CONN = null as unknown as AbapConnection;

type RapInputT = Parameters<typeof abapRap>[1];

function baseInput(overrides: Partial<RapInputT> = {}): RapInputT {
  return {
    table: TABLE,
    package: PACKAGE,
    name_prefix: PREFIX,
    flavour: "managed",
    draft: false,
    service_binding_type: "OData V4",
    include_projection: true,
    cds_form: "entity",
    dry_run: false,
    corr_nr: CORR_NR,
    activate: true,
    ...overrides,
  } as RapInputT;
}

function okWrite(): Promise<BuiltResponse> {
  return Promise.resolve({
    text: "object: X\ncreated: true\nactivated: true",
    truncated: false,
    estimatedTokens: 1,
  });
}

function fakeIo(writeArtifact = vi.fn(() => okWrite())): { io: RapIo; writeArtifact: typeof writeArtifact } {
  const io: RapIo = {
    readTableFields: async () => ({ name: TABLE, packageName: PACKAGE, fields: FIELDS }),
    writeArtifact: writeArtifact as unknown as RapIo["writeArtifact"],
    readBindingUrl: async () => BINDING_URL,
  };
  return { io, writeArtifact };
}

describe("abapRap — dry_run", () => {
  it("makes zero writeArtifact calls and reports writes: 0", async () => {
    const { io, writeArtifact } = fakeIo();
    const res = await abapRap(FAKE_CONN, baseInput({ dry_run: true }), { maxChars: 100_000 }, io);

    expect(writeArtifact).not.toHaveBeenCalled();
    expect(res.text).toContain("writes: 0");
    expect(res.text).toContain(NAMES.rootView);
    expect(res.text).toContain(NAMES.projectionView);
    expect(res.text).toContain(NAMES.behaviourClass);
    expect(res.text).toContain(NAMES.serviceDefinition);
    expect(res.text).toContain(NAMES.serviceBinding);
  });
});

describe("abapRap — full run", () => {
  it("writes all 8 artifacts in dependency order, carrying package/corr_nr/activate", async () => {
    const { io, writeArtifact } = fakeIo();
    const res = await abapRap(FAKE_CONN, baseInput(), { maxChars: 100_000 }, io);

    expect(writeArtifact).toHaveBeenCalledTimes(8);
    const calls = writeArtifact.mock.calls.map((c) => c[1] as WriteInput);
    const shapes = calls.map((c) => ({ type: c.type, object: c.object, include: c.include }));
    expect(shapes).toEqual([
      { type: "DDLS/DF", object: NAMES.rootView, include: undefined },
      { type: "BDEF/BDO", object: NAMES.rootView, include: undefined },
      { type: "DDLS/DF", object: NAMES.projectionView, include: undefined },
      { type: "BDEF/BDO", object: NAMES.projectionView, include: undefined },
      { type: "CLAS/OC", object: NAMES.behaviourClass, include: undefined },
      { type: "CLAS/OC", object: NAMES.behaviourClass, include: "implementations" },
      { type: "SRVD/SRV", object: NAMES.serviceDefinition, include: undefined },
      { type: "SRVB/SVB", object: NAMES.serviceBinding, include: undefined },
    ]);
    for (const c of calls) {
      expect(c.package).toBe(PACKAGE);
      expect(c.corr_nr).toBe(CORR_NR);
      expect(c.activate).toBe(true);
    }

    expect(res.text).toContain(BINDING_URL);
    expect((res.text.match(/activated: true/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  it("stops at the first failure and reports RAP_PARTIAL with the partial state", async () => {
    const writeArtifact = vi.fn(async () => {
      if (writeArtifact.mock.calls.length === 3) throw new Error("SIMULATED_FAILURE: lock timeout");
      return okWrite();
    });
    const { io } = fakeIo(writeArtifact);

    let caught: unknown;
    try {
      await abapRap(FAKE_CONN, baseInput(), { maxChars: 100_000 }, io);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(AbapError);
    const err = caught as AbapError;
    expect(err.code).toBe("RAP_PARTIAL");
    expect(writeArtifact).toHaveBeenCalledTimes(3);

    const artifacts = err.details.artifacts as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(8);
    expect(artifacts[0]).toMatchObject({ written: true, activated: true });
    expect(artifacts[1]).toMatchObject({ written: true, activated: true });
    expect(artifacts[2]).toMatchObject({ failed: true });
    expect(String(artifacts[2]!.error)).toContain("SIMULATED_FAILURE");
    for (const rest of artifacts.slice(3)) {
      expect(rest.status).toBe("not attempted");
    }
  });
});

// ---------------------------------------------------------- mode gating ---

/** A transport that records every request then refuses it — proves a locked/refused call touches no wire. */
class ForbiddenClient implements HttpClient {
  calls = 0;
  async request(_o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls++;
    throw new Error("NETWORK CALL LEAKED: abap_rap must refuse before opening a connection");
  }
}

const BASE_ENV: Record<string, string> = {
  ABAP_URL: "http://sap.invalid:50000",
  ABAP_USER: "TESTUSER",
  ABAP_PASSWORD: "secret",
  ABAP_SID: "TST",
  ABAP_CLIENT: "001",
};

function config(mode: AbapMode, over: Record<string, string> = {}): Config {
  return loadConfig({ env: { ...BASE_ENV, ABAP_MODE: mode, ...over }, warn: () => {}, skipDotenv: true });
}

interface Harness {
  srv: AbapsmithServer;
  client: Client;
}

async function harness(cfg: Config, httpClient: HttpClient): Promise<Harness> {
  const srv = createServer(cfg, {
    httpClient: routeSystemRoleProbe(httpClient, { answer: "nonproductive" }),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-rap-tool", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);
  return { srv, client };
}

type CallToolReturn = Awaited<ReturnType<Client["callTool"]>>;

const isErr = (res: CallToolReturn): boolean => "isError" in res && res.isError === true;

const textOf = (res: CallToolReturn): string => {
  if (!("content" in res)) return "";
  return res.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
};

const jsonOf = (res: CallToolReturn): Record<string, unknown> => JSON.parse(textOf(res)) as Record<string, unknown>;

describe("abap_rap — mode gating", () => {
  it("read mode: abap_rap is a locked stub refusing READ_ONLY, no request sent", async () => {
    const forbidden = new ForbiddenClient();
    const { client } = await harness(config("read"), forbidden);
    const res = await client.callTool({
      name: "abap_rap",
      arguments: { table: TABLE, package: "$TMP", name_prefix: PREFIX },
    });

    expect(isErr(res)).toBe(true);
    expect(jsonOf(res).error).toBe("READ_ONLY");
    expect(forbidden.calls).toBe(0);
  });

  it.each([true, false])(
    "edit mode with the package outside the allowlist refuses SAFETY_DENIED before any request (dry_run=%s)",
    async (dryRun) => {
      const forbidden = new ForbiddenClient();
      const { client } = await harness(config("edit", { ABAP_ALLOW_PACKAGES: "ZOTHER" }), forbidden);
      const res = await client.callTool({
        name: "abap_rap",
        arguments: { table: TABLE, package: "$TMP", name_prefix: PREFIX, dry_run: dryRun },
      });

      expect(isErr(res)).toBe(true);
      expect(jsonOf(res).error).toBe("SAFETY_DENIED");
      expect(forbidden.calls).toBe(0);
    },
  );

  it("edit mode with an SAP-namespace name_prefix is refused before any request", async () => {
    const forbidden = new ForbiddenClient();
    const { client } = await harness(config("edit", { ABAP_ALLOW_PACKAGES: "*" }), forbidden);
    const res = await client.callTool({
      name: "abap_rap",
      arguments: { table: TABLE, package: "$TMP", name_prefix: "/SAPBK/BK" },
    });

    expect(isErr(res)).toBe(true);
    expect(jsonOf(res).error).toBe("SAFETY_DENIED");
    expect(forbidden.calls).toBe(0);
  });
});
