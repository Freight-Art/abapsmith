/**
 * Invariant 2: "a failure must always set the MCP `isError` flag."
 * `test/iserror-envelope-contract.test.ts` drives `errorResult`/`v2Result`
 * directly across the whole error taxonomy; it cannot see (A) a stray
 * `isError` assignment anywhere else in `src/`, or (B) a real failing tool
 * call that never reaches either constructor. This file covers both.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { errorResult } from "../src/server.js";
import { registerWriteTools, type WriteToolDeps } from "../src/tools/write.js";
import { registerActivateTools, type ActivateToolDeps } from "../src/tools/activate.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// =============================================================================
// Part A — static guard: no src/ module may set isError to anything but `true`.
// =============================================================================

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Same single-pass comment stripper as `test/structured-content-contract.test.ts`
 * (and `test/journal-contract.test.ts`): comments become spaces, not nothing,
 * so offsets/line numbers stay meaningful; string and template bodies are KEPT
 * verbatim — that distinction is what stops a doc comment mentioning
 * `isError:false` from masquerading as a real assignment, without a naive
 * regex swallowing unrelated code around it.
 */
function stripComments(text: string): string {
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (mode === "code") {
      if (c === "/" && d === "*") {
        mode = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "/" && d === "/") {
        mode = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === '"') mode = "double";
      else if (c === "'") mode = "single";
      else if (c === "`") mode = "template";
      out += c;
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") mode = "code";
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && d === "/") {
        mode = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    // Inside a string or template literal: copy through, honouring escapes.
    if (c === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (
      (mode === "double" && c === '"') ||
      (mode === "single" && c === "'") ||
      (mode === "template" && c === "`")
    ) {
      mode = "code";
    }
    out += c;
    i += 1;
  }
  return out;
}

const files = listTsFiles(SRC);
const contents = new Map(files.map((f) => [f, stripComments(readFileSync(f, "utf8"))]));
const rel = (f: string) => relative(SRC, f).split("\\").join("/");

/**
 * Every `isError:` assignment site (object-literal key or type field), with
 * its RHS text. `.isError` property READS (e.g. `if (res.isError)` in
 * src/tools/v2/unknown.ts) have no colon after them and never match.
 */
const assignments = files.flatMap((f) =>
  [...contents.get(f)!.matchAll(/isError\s*:\s*([^\n,};]+)/g)].map((m) => ({
    file: f,
    value: m[1]!.trim(),
  })),
);

describe("invariant 2 — src/ never sets isError to anything but true", () => {
  it("no isError assignment anywhere in src/ has a value other than the literal `true` (this is the single most valuable line in the file)", () => {
    const bad = assignments.filter((a) => a.value !== "true");
    expect(
      bad,
      `found isError set to something other than the literal \`true\`: ${bad
        .map((a) => `${rel(a.file)} -> isError: ${a.value}`)
        .join("; ")}. isError:false / isError:undefined / any other value is exactly the defect ` +
        "this invariant guards against: a body that reports failure while the MCP envelope still claims success.",
    ).toEqual([]);
  });

  it("pins the exact file set that assigns isError at all", () => {
    const isErrorFiles = [...new Set(assignments.map((a) => rel(a.file)))].sort();
    expect(
      isErrorFiles,
      "the set of files assigning `isError` changed. If this is a deliberate new envelope " +
        "constructor, add it here on purpose and confirm it only ever sets isError:true for a " +
        "failure — do not edit this list just to turn a red run green.",
    ).toEqual(["tool-errors.ts", "tools/v2/envelope.ts"]);
  });

  it("the scan itself is non-vacuous", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(assignments.length).toBeGreaterThan(0);
  });

  it("stripComments blanks comment content but preserves string/template bodies verbatim", () => {
    const sample =
      "// isError: false\n" + "/* isError: false */\n" + 'const s = "isError: false";\n';
    const lines = stripComments(sample).split("\n");
    expect(lines[0]).not.toContain("isError");
    expect(lines[1]).not.toContain("isError");
    expect(lines[2]).toContain('"isError: false"');
  });

  it("confirms on a real file: dumps.ts's doc-comment mention of isError:false is excluded by the stripper", () => {
    // Raw-text grep hits `isError:false`/`isError:true` in doc comments at
    // src/tools/dumps.ts and src/tools/write.ts — proof the stripper, not a
    // lucky regex, is what keeps those out of `assignments` above.
    const dumpsFile = files.find((f) => rel(f) === "tools/dumps.ts");
    expect(dumpsFile, "src/tools/dumps.ts not found — has it moved?").toBeDefined();
    expect(contents.get(dumpsFile!)!).not.toMatch(/isError\s*:\s*false/);
  });

  it("errorResult (src/tool-errors.ts) sets isError:true unconditionally, not from inside a branch", () => {
    const text = contents.get(files.find((f) => rel(f) === "tool-errors.ts")!)!;
    const start = text.indexOf("export function errorResult");
    expect(start, "errorResult not found in src/tool-errors.ts").toBeGreaterThan(-1);
    // Isolate the function body with a brace counter (safe here: the body is
    // small and has no nested object literal that would confuse it), then
    // check for `if (` anywhere inside it — an unconditional function has
    // none, so `isError: true` on its `return` cannot be branch-gated.
    let depth = 0;
    let end = start;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = text.slice(start, end + 1);
    expect(body).toContain("isError: true");
    expect(body).not.toMatch(/\bif\s*\(/);
  });
});

// =============================================================================
// Part B — end to end: a genuinely failing tool call, through a real MCP
// client (not a hand-built envelope), must set isError:true with an `error`
// key in the body. Four distinct failure origins, plus one corpus check.
// =============================================================================

function bodyOf(res: CallToolResult): Record<string, unknown> {
  const text = (res.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text) as Record<string, unknown>;
}

async function call(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "iserror-e2e-probe", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const res = (await client.callTool({ name, arguments: args })) as unknown as CallToolResult;
  await client.close();
  return res;
}

/** Collected across every e2e case below for the final cross-corpus assertion. */
const eeCorpus: CallToolResult[] = [];

// ---- BAD_INPUT / SAFETY_DENIED: both refuse before ensureConnected(), so no
// fake HTTP transport is needed at all — pool/ensureConnected throw if ever
// reached, proving the refusal really is zero-network. ----

function zeroNetworkWriteServer(safety: SafetyGate): McpServer {
  const deps: WriteToolDeps = {
    pool: {
      withWrite: async () => {
        throw new Error("must not reach the network for an input/safety refusal");
      },
    } as never,
    safety,
    ensureConnected: async () => {
      throw new Error("must not reach the network for an input/safety refusal");
    },
    errorResult,
    cfg: { maxResponseChars: 50_000 },
    journal: undefined as never,
    transport: undefined as never,
  };
  const server = new McpServer({ name: "iserror-e2e-probe", version: "0.0.0" });
  registerWriteTools(server, deps);
  return server;
}

// ---- NOT_FOUND / ADT_ERROR: need a real AbapConnection, backed by a fake
// HTTP transport (same shape as test/parented-name-slash-form.test.ts). ----

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">object does not exist</message><properties/></exc:exception>`;

interface Recorded {
  method: string;
  url: string;
  qs: Record<string, string>;
}

class FakeAdt implements HttpClient {
  constructor(private readonly route: (r: Recorded) => HttpClientResponse | undefined) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const rec: Recorded = {
      method: (o.method ?? "GET").toUpperCase(),
      url: o.url,
      qs: (o.qs ?? {}) as Record<string, string>,
    };
    const res = this.route(rec);
    if (!res) throw new Error(`FakeAdt: unrouted request ${rec.method} ${rec.url}`);
    return res;
  }
}

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

async function connectFake(
  route: (r: Recorded) => HttpClientResponse | undefined,
): Promise<AbapConnection> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const config: Config = ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });
  const conn = new AbapConnection(config, {
    httpClient: adt,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  return conn;
}

const OBJECT_META = (name: string, type: string, packageName = "$TMP"): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${name}" adtcore:type="${type}">` +
  `<adtcore:packageRef adtcore:name="${packageName}"/>` +
  `</adtcore:objectMetadata>`;

describe("invariant 2 — real failing tool calls set isError:true end to end", () => {
  it("BAD_INPUT: abap_write with neither `object` nor `objects` sets isError:true", async () => {
    const server = zeroNetworkWriteServer(new SafetyGate({ readOnly: false, allowPackages: ["*"] }));
    const res = await call(server, "abap_write", {});
    eeCorpus.push(res);
    expect(res.isError).toBe(true);
    expect(bodyOf(res).error).toBe("BAD_INPUT");
  });

  it("SAFETY_DENIED: abap_write on a name outside the customer namespace sets isError:true, with zero network calls", async () => {
    // Writes enabled (so this isn't the READ_ONLY code path) but the name
    // fails the default Z/Y customer-namespace prefix rule — a preflight-only
    // check (src/safety.ts's name-prefix allowlist), so it fires before the
    // package is ever resolved and needs no fake HTTP transport at all.
    const server = zeroNetworkWriteServer(new SafetyGate({ readOnly: false, allowPackages: ["*"] }));
    const res = await call(server, "abap_write", {
      object: "MFOO_ISERR_PROBE",
      type: "PROG/P",
      source: "REPORT z_probe.",
    });
    eeCorpus.push(res);
    expect(res.isError).toBe(true);
    expect(bodyOf(res).error).toBe("SAFETY_DENIED");
  });

  it("NOT_FOUND: abap_write mode=delete on an object that does not exist on the server sets isError:true", async () => {
    const conn = await connectFake(() => resp(404, NOT_FOUND_XML, OK_XML));
    const deps: WriteToolDeps = {
      pool: {
        withWrite: async <T>(
          _tool: string,
          _key: string | undefined,
          fn: (c: AbapConnection) => Promise<T>,
        ): Promise<T> => fn(conn),
      } as never,
      safety: new SafetyGate({ readOnly: false, allowPackages: ["*"] }),
      ensureConnected: async () => {},
      errorResult,
      cfg: { maxResponseChars: 50_000 },
      journal: undefined as never,
      transport: undefined as never,
    };
    const server = new McpServer({ name: "iserror-e2e-probe", version: "0.0.0" });
    registerWriteTools(server, deps);
    const res = await call(server, "abap_write", {
      object: "ZMCP_ISERR_GHOST",
      type: "PROG/P",
      mode: "delete",
    });
    eeCorpus.push(res);
    expect(res.isError).toBe(true);
    expect(bodyOf(res).error).toBe("NOT_FOUND");
  });

  it("ADT_ERROR: abap_activate mode=check against a transport-level 500 on /checkruns sets isError:true", async () => {
    const uri = "/sap/bc/adt/programs/programs/zmcp_iserr_check";
    const conn = await connectFake((r) => {
      if (r.url === uri && r.method === "GET") {
        return resp(200, OBJECT_META("ZMCP_ISERR_CHECK", "PROG/P"), OK_XML);
      }
      if (r.url.includes("/checkruns")) {
        return resp(500, "<html>ICM</html>", { "content-type": "text/html" });
      }
      return undefined;
    });
    const deps: ActivateToolDeps = {
      pool: {
        withRead: async <T>(_tool: string, fn: (c: AbapConnection) => Promise<T>): Promise<T> => fn(conn),
        withWrite: async <T>(
          _tool: string,
          _key: string | undefined,
          fn: (c: AbapConnection) => Promise<T>,
        ): Promise<T> => fn(conn),
      } as never,
      safety: new SafetyGate({ readOnly: false, allowPackages: ["*"] }),
      ensureConnected: async () => {},
      errorResult,
      cfg: { maxResponseChars: 50_000 },
      transport: undefined as never,
      journal: undefined as never,
    };
    const server = new McpServer({ name: "iserror-e2e-probe", version: "0.0.0" });
    registerActivateTools(server, deps);
    const res = await call(server, "abap_activate", {
      object: "ZMCP_ISERR_CHECK",
      type: "PROG/P",
      mode: "check",
      source: "REPORT z_probe.",
    });
    eeCorpus.push(res);
    expect(res.isError).toBe(true);
    expect(bodyOf(res).error).toBe("ADT_ERROR");
  });

  it("across the e2e corpus collected above: every response whose body carries an `error` key also has isError:true", () => {
    expect(eeCorpus.length).toBeGreaterThanOrEqual(4);
    for (const res of eeCorpus) {
      if (Object.prototype.hasOwnProperty.call(bodyOf(res), "error")) {
        expect(res.isError).toBe(true);
      }
    }
  });
});
