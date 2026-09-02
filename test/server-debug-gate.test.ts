/**
 * `abap_debug` safety gate (server.ts wiring).
 *
 * The defect this file pins down: the gate used to be asserted only for
 * `action:"start"`, so `action:"step"` — which resumes/advances a suspended
 * debuggee on the live system, and is exactly as consequential — skipped the
 * safety check entirely. The policy now under test is an *exempt* allowlist:
 * `stack`/`status`/`keepalive`/`stop` are ungated, everything else (today
 * `start` and `step`) is gated, so a future action defaults to GATED.
 *
 * Everything here is offline: `abapDebug` itself is mocked, so no test can
 * reach a debug backend, and the refusal tests use a transport that throws if
 * it is touched at all — a refused step must cost zero requests, exactly as
 * `test/tools.test.ts` proves for a refused write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { createServer, type AbapsmithServer } from "../src/server.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// Only the driver is faked; the schema, the deps factory and every other export
// stay real, because the handler's gating runs on the *validated* arguments.
const debugTool = vi.hoisted(() => ({ abapDebug: vi.fn() }));
vi.mock("../src/tools/debug.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/debug.js")>()),
  abapDebug: debugTool.abapDebug,
}));

// ---------------------------------------------------------------- fixtures ---

class CountingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

/**
 * System-role fail-closed detection: `AbapConnection.connect()` now probes
 * `POST /sap/bc/adt/datapreview/freestyle` for T000-CCCATEGORY, and a system it
 * cannot PROVE non-productive is write-locked (`writesLockedOut`) *before* the
 * safety gate this file exercises ever runs. A fake that answers "ok" to
 * everything is therefore a fake of a system that might be production, and
 * every mutating debug action would refuse with READ_ONLY before reaching the
 * stateId→object association behaviour under test here.
 *
 * So the fake serves the REAL captured 200 bytes (fixture 087: client 000 →
 * "S", client 001 → "C"), and `cfg()` logs on as client 001 — the detection
 * then legitimately concludes "nonproductive" on its own merits. Nothing about
 * the probe is stubbed out.
 *
 * Imported, with `DATAPREVIEW_XML`, from ./helpers/system-role-fake.js.
 */

const okResponse = (o?: HttpClientOptions): HttpClientResponse => {
  if (o?.url?.includes("/datapreview/freestyle")) {
    return {
      status: 200,
      statusText: "200",
      body: T000_NONPRODUCTIVE,
      headers: { ...DATAPREVIEW_XML, "x-csrf-token": "TOKEN" },
    } as unknown as HttpClientResponse;
  }
  return {
    status: 200,
    statusText: "200",
    body: "ok",
    headers: { "content-type": "text/plain", "x-csrf-token": "TOKEN" },
  } as unknown as HttpClientResponse;
};

/** A transport that must never be reached: a refused debug action costs nothing. */
const forbiddenClient = () =>
  new CountingClient(() => {
    throw new Error("NETWORK CALL LEAKED: the safety gate let a refused debug action through");
  });

const okClient = () => new CountingClient((o) => okResponse(o));

const cfg = (over: Partial<Config> = {}): Config => ({
  ...ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    // The logon client the system-role T000 probe judges. Without it detection has no
    // client to look up and fails closed — see `okResponse` above.
    client: "001",
  }),
  ...over,
});

/** Writes enabled and $TMP allowlisted — `Z*` names pass, everything else does not. */
const writable = () => cfg({ readOnly: false, allowPackages: ["$TMP"] });

interface Harness {
  srv: AbapsmithServer;
  client: Client;
  http: CountingClient;
}

async function harness(config: Config, http: CountingClient = forbiddenClient()): Promise<Harness> {
  const srv = createServer(config, { httpClient: http, log: () => {}, breaker: new AuthCircuitBreaker() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);
  return { srv, client, http };
}

interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

const debugCall = async (h: Harness, args: Record<string, unknown>) =>
  (await h.client.callTool({ name: "abap_debug", arguments: args })) as unknown as ToolCallResult;

const errorOf = (res: ToolCallResult): Record<string, unknown> => {
  expect(res.isError).toBe(true);
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
};

/** The gate's two refusal codes — the only ones this file cares about. */
const SAFETY_CODES = ["READ_ONLY", "SAFETY_DENIED"];

/** A stop response as the real tool renders it: the header carries the stateId. */
const stopResponse = (stateId: string, action: string) => ({
  text: `action: ${action}\nstatus: suspended\nprogram: ZMCP_DEMO\nline: 12\nstateId: ${stateId}`,
  truncated: false,
  estimatedTokens: 10,
});

const START_ARGS = {
  action: "start",
  breakpoints: [{ kind: "line", object: "ZMCP_DEMO", line: 12 }],
  run: { object: "ZMCP_DEMO" },
};

const STEP_VALUES = ["into", "over", "return", "continue"] as const;
const UNGATED_ACTIONS = ["stack", "status", "keepalive", "stop"] as const;

beforeEach(() => {
  vi.clearAllMocks();
  debugTool.abapDebug.mockResolvedValue(stopResponse("S1", "start"));
});

/** Start a session against an allowed object and return its stateId. */
async function startSession(h: Harness, object = "ZMCP_DEMO"): Promise<string> {
  debugTool.abapDebug.mockResolvedValueOnce(stopResponse("S1", "start"));
  const res = await debugCall(h, { ...START_ARGS, run: { object } });
  expect(res.isError).toBeFalsy();
  return "S1";
}

// ------------------------------------------------------- gated: start ---

describe("abap_debug start stays gated", () => {
  it("refuses start under the read-only default, before the network", async () => {
    const h = await harness(cfg());
    const err = errorOf(await debugCall(h, START_ARGS));
    expect(err.error).toBe("READ_ONLY");
    expect(debugTool.abapDebug).not.toHaveBeenCalled();
    expect(h.http.calls).toHaveLength(0);
    expect(h.srv.connection.isConnected).toBe(false);
  });

  it("refuses start on an SAP-namespace object even with writes enabled", async () => {
    const h = await harness(writable());
    const err = errorOf(
      await debugCall(h, {
        ...START_ARGS,
        breakpoints: [{ kind: "line", object: "/DMO/CL_FLIGHT", line: 1 }],
        run: { object: "/DMO/CL_FLIGHT" },
      }),
    );
    expect(err.error).toBe("SAFETY_DENIED");
    expect(String(err.message)).toMatch(/namespace/i);
    expect(debugTool.abapDebug).not.toHaveBeenCalled();
    expect(h.http.calls).toHaveLength(0);
  });

  it("refuses a start with no run object rather than skipping the check", async () => {
    // The old code only asserted `if (action === "start" && a.run)`; with the
    // guard dropped, a missing object is denied by the gate itself.
    const h = await harness(writable());
    const err = errorOf(await debugCall(h, { action: "start" }));
    expect(err.error).toBe("SAFETY_DENIED");
    expect(String(err.message)).toMatch(/No object supplied/i);
    expect(debugTool.abapDebug).not.toHaveBeenCalled();
  });

  it("lets an allowed start through to the tool", async () => {
    const h = await harness(writable(), okClient());
    const res = await debugCall(h, START_ARGS);
    expect(res.isError).toBeFalsy();
    expect(debugTool.abapDebug).toHaveBeenCalledTimes(1);
  });
});

// -------------------------------------------------------- gated: step ---

describe("abap_debug step is gated (the regression this file exists for)", () => {
  for (const step of STEP_VALUES) {
    it(`refuses step:"${step}" under the read-only default, before the network`, async () => {
      const h = await harness(cfg());
      const err = errorOf(await debugCall(h, { action: "step", stateId: "S1", step }));
      expect(err.error).toBe("READ_ONLY");
      expect(debugTool.abapDebug).not.toHaveBeenCalled();
      expect(h.http.calls).toHaveLength(0);
      expect(h.srv.connection.isConnected).toBe(false);
    });
  }

  it('refuses step:"continue" for a session whose object the gate would deny', async () => {
    // Start while the gate allows it, then let the gate tighten (this is what
    // happens when the connect probe reports a productive system). The step
    // must be re-judged against the session's object, not waved through.
    const h = await harness(writable(), okClient());
    const stateId = await startSession(h);
    vi.clearAllMocks();
    h.srv.safety.update({ productive: true });

    const err = errorOf(await debugCall(h, { action: "step", stateId, step: "continue" }));
    expect(err.error).toBe("READ_ONLY");
    // Anchor on the RULE, not the word "productive". The fail-closed
    // lockout's own reason text contains the substring "non-productive", so a
    // `/productive/i` match here would pass on a refusal that means the exact
    // opposite of what this test is pinning — a system that could not be PROVEN
    // non-productive, rather than one that reported itself productive. The two
    // rule strings are disjoint, so this cannot be satisfied by the lockout.
    const rule = (err.details as Record<string, unknown> | undefined)?.rule;
    expect(rule).toBe("productive → read-only");
    expect(String(rule)).not.toMatch(/fail closed/i);
    expect(debugTool.abapDebug).not.toHaveBeenCalled();
  });

  it("refuses a step on an unknown/stale stateId instead of silently skipping the gate", async () => {
    const h = await harness(writable(), okClient());
    const err = errorOf(await debugCall(h, { action: "step", stateId: "NEVER_STARTED", step: "over" }));
    expect(err.error).toBe("SAFETY_DENIED");
    expect(String(err.message)).toMatch(/No object supplied/i);
    expect(debugTool.abapDebug).not.toHaveBeenCalled();
  });

  it("does NOT block a step whose session object the gate allows", async () => {
    const h = await harness(writable(), okClient());
    const stateId = await startSession(h, "ZMCP_DEMO");
    debugTool.abapDebug.mockResolvedValueOnce(stopResponse("S2", "step"));

    const res = await debugCall(h, { action: "step", stateId, step: "continue" });
    expect(res.content[0]!.text).not.toMatch(/READ_ONLY|SAFETY_DENIED/);
    expect(res.isError).toBeFalsy();
    expect(debugTool.abapDebug).toHaveBeenCalledTimes(2); // start + step
    expect(debugTool.abapDebug.mock.calls[1]![1]).toMatchObject({ action: "step", step: "continue" });
  });

  it("carries the association onto the stateId each step returns, and drops the old one", async () => {
    const h = await harness(writable(), okClient());
    const first = await startSession(h, "ZMCP_DEMO");
    debugTool.abapDebug.mockResolvedValueOnce(stopResponse("S2", "step"));
    await debugCall(h, { action: "step", stateId: first, step: "over" });

    // The new stateId still resolves to ZMCP_DEMO → allowed.
    debugTool.abapDebug.mockResolvedValueOnce(stopResponse("S3", "step"));
    const chained = await debugCall(h, { action: "step", stateId: "S2", step: "over" });
    expect(chained.isError).toBeFalsy();
    expect(debugTool.abapDebug).toHaveBeenCalledTimes(3);

    // The consumed stop is gone, so re-using it is denied rather than assumed.
    const stale = errorOf(await debugCall(h, { action: "step", stateId: first, step: "over" }));
    expect(stale.error).toBe("SAFETY_DENIED");
    expect(debugTool.abapDebug).toHaveBeenCalledTimes(3);
  });

  it("forgets the session on stop, so a later step cannot ride the old association", async () => {
    const h = await harness(writable(), okClient());
    const stateId = await startSession(h);
    debugTool.abapDebug.mockResolvedValueOnce({
      text: "action: stop\nstatus: dead\ndeathReason: terminated_by_caller",
      truncated: false,
      estimatedTokens: 5,
    });
    await debugCall(h, { action: "stop" });

    const err = errorOf(await debugCall(h, { action: "step", stateId, step: "continue" }));
    expect(err.error).toBe("SAFETY_DENIED");
    expect(String(err.message)).toMatch(/No object supplied/i);
  });
});

// ------------------------------------------------------------ ungated ---

describe("non-advancing abap_debug actions are not gated", () => {
  for (const action of UNGATED_ACTIONS) {
    it(`lets action="${action}" through even under a denying safety config`, async () => {
      // Read-only default AND a productive system: the strictest the gate gets.
      const h = await harness(cfg(), okClient());
      h.srv.safety.update({ productive: true });
      debugTool.abapDebug.mockResolvedValueOnce({
        text: `action: ${action}\nstatus: idle`,
        truncated: false,
        estimatedTokens: 4,
      });

      const res = await debugCall(h, { action, stateId: "S1" });
      // It reached the tool at all — which is the whole claim.
      expect(debugTool.abapDebug).toHaveBeenCalledTimes(1);
      expect(debugTool.abapDebug.mock.calls[0]![1]).toMatchObject({ action });
      expect(res.content[0]!.text).not.toMatch(/READ_ONLY|SAFETY_DENIED/);
      expect(res.isError).toBeFalsy();
    });
  }

  it("keeps abap_debug_vars/abap_debug_value on the read path", async () => {
    const h = await harness(cfg(), okClient());
    h.srv.safety.update({ productive: true });
    // Reads are always allowed, so neither is refused by the gate; they fail (or
    // not) inside their own tool, never with a safety code.
    for (const name of ["abap_debug_vars", "abap_debug_value"]) {
      const res = (await h.client.callTool({
        name,
        arguments: { stateId: "S1", path: "LV_X" },
      })) as unknown as ToolCallResult;
      expect(res.content[0]!.text).not.toMatch(/READ_ONLY|SAFETY_DENIED/);
    }
  });
});

describe("gate refusals are the documented codes", () => {
  it("uses only READ_ONLY/SAFETY_DENIED when refusing", async () => {
    const h = await harness(cfg());
    const codes = [
      errorOf(await debugCall(h, START_ARGS)).error,
      errorOf(await debugCall(h, { action: "step", stateId: "S1", step: "into" })).error,
    ];
    for (const c of codes) expect(SAFETY_CODES).toContain(c);
  });
});
