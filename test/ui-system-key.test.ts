/**
 * The systemKey half for `abap_ui`. `src/tools/ui.ts`'s single
 * `withJournalledMutation` call site (the `press` mode) constructed its
 * journal entry with no `systemKey` — the last of what `test/journal-systemkey.test.ts`'s
 * header calls the fourth instance of that defect. Unlike every
 * other site that defect touched, `begin`'s callback here has no `conn` in
 * scope: it fires from `onBeforeImage(query)` (src/tools/ui.ts, inside
 * `withJournalledMutation`'s second argument) BEFORE `deps.pool.withWrite`
 * ever hands one back. The fix widened `UiToolDeps.cfg` to carry
 * `sid`/`url`/`client` and builds `systemKey({ sid, url, client })` from
 * `deps.cfg` directly — the same spelling `src/tools/transport.ts` uses,
 * not the `systemKey(conn.cfg)` spelling every other site uses.
 *
 * This is the behavioural half `test/enh-system-key.test.ts` is for
 * `abap_enh` and `test/bopf-journal.test.ts` is for `abap_bopf`: drive the
 * REAL `abap_ui` press handler over a REAL `AbapConnection` (HTTP faked) and
 * a REAL `Journal`, then read the PERSISTED `index.jsonl` bytes off disk —
 * not `journal.list()`, not the rendered response text — because
 * `src/journal.ts`'s `begin()` spreads `systemKey` in ONLY when truthy, so a
 * call site that regressed to `systemKey: ""` would satisfy a naive
 * "field is present in source" check while persisting nothing.
 *
 * Note on scope (see the fix's own commit message / PR description): `press`
 * entries are `irreversible: true` (src/tools/ui.ts), so
 * `systemMismatchBlocker` in `src/adt/undo.ts` never actually reaches its
 * systemKey comparison for one — undo refuses unconditionally before that
 * check runs. This test is audit/metadata completeness, not proof of a live
 * safety hole closing.
 *
 * Harness: a trimmed, independent copy of `test/fpm-tools.test.ts`'s own
 * `bridgeHappyPath`/`connected`/`fakePool`/`fakeMcp` idiom (itself the
 * pattern this repo's `deployBridge`/`executeBridge`-backed tools share),
 * generalised to route by class-name PREFIX rather than one fixed name —
 * `press` deploys and runs TWO bridge classes in sequence (a `mode:"screen"`
 * TSTC precheck via `assertBdcApplies`, then the actual `mode:"press"`
 * BDCDATA bridge), each with a different hashed class name, so the fake
 * server distinguishes them by call order on the classrun endpoint rather
 * than by a single pinned class name.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { UI_LINE_PREFIX } from "../src/adt/ui-runtime.js";
import { registerUiTools, type UiToolDeps } from "../src/tools/ui.js";
import { Journal, systemKey } from "../src/journal.js";
import { errorResult } from "../src/server.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { dynamicUiFluidRoute, isUiFluidClass, uiScreenConsole } from "./helpers/fluid-ui-fake.js";
import { isTstcSelect, tstcSelectResponse } from "./helpers/tstc-select-fake.js";
import { FLUID_PACKAGE } from "../src/adt/fluid/package.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const SESSION_URL = "/sap/bc/adt/compatibility/graph";
const CLASS_COLLECTION = "/sap/bc/adt/oo/classes";

const LOCK_XML =
  `<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">` +
  `<asx:values><DATA><LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/>` +
  `<CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/>` +
  `<MODIFICATION_SUPPORT>NoModification</MODIFICATION_SUPPORT><SCOPE_MESSAGES/></DATA></asx:values></asx:abap>`;

const PKG_URI = "/sap/bc/adt/packages/%24abapsmith_fluid_api";
const PACKAGE_XML = (name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" adtcore:type="DEVC/K">` +
  `<adtcore:packageRef adtcore:name="${name}" adtcore:type="DEVC/K"/>` +
  `<pak:superPackage adtcore:name="$TMP"/>` +
  `</pak:package>`;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

/**
 * `press`'s full happy path: the TSTC pre-check (one catalog select,
 * issue #150 — it replaced the `mode:"screen"` bridge run `assertBdcApplies`
 * used to make for CINFO), then the `mode:"press"` BDCDATA bridge. The
 * fluid `ui.screen` routing below is kept so this harness still answers a
 * screen-mode dispatch through the fluid `ui.screen` action
 * (`src/adt/fluid/dispatch.ts`) against the fixed
 * body class `uiManifest.entry`, routed through
 * `dynamicUiFluidRoute` (test/helpers/fluid-ui-fake.ts), same idiom as
 * test/img-edit-tool.test.ts's `multiBridgeHappyPath`: classrun for a fluid
 * ui class (runtime/body/invoker, `isUiFluidClass`) is intercepted and
 * answered with `uiScreenConsole`'s TCODE payload BEFORE `fluidRoute`'s own
 * unconditional (name-unfiltered) classrun branch would otherwise swallow
 * the actual press's classrun too. The press bridge itself keeps deploying
 * and running a per-call hashed `zcl_zmcp_ui_...` class exactly as before.
 */
function pressHappyPath(tcode: string): (o: HttpClientOptions) => HttpClientResponse {
  const fluidRoute = dynamicUiFluidRoute({
    transcript: () =>
      uiScreenConsole({
        tcode: {
          tcode,
          program: "SAPMZUI1",
          dynpro: "0100",
          cinfo: "00",
          kind: "dialog transaction",
          bdcApplies: true,
        },
        program: "SAPMZUI1",
        dynpro: "0100",
        fields: [],
      }),
    packageName: FLUID_PACKAGE,
  });

  return (o: HttpClientOptions) => {
    const qs = (o.qs ?? {}) as Record<string, string>;
    const method = (o.method ?? "GET").toUpperCase();

    if (o.url.startsWith("/sap/bc/adt/oo/classrun/")) {
      const name = o.url.slice("/sap/bc/adt/oo/classrun/".length);
      if (isUiFluidClass(name)) {
        const r = fluidRoute(o);
        if (r) return r;
      }
      // The actual press: subrc 0, two BDCDATA rows submitted, no messages.
      return resp(200, `${UI_LINE_PREFIX}SUBRC 0\n${UI_LINE_PREFIX}ROWCOUNT 2\n`, {
        "content-type": "text/plain",
      });
    }
    if (o.url.includes(SESSION_URL)) return resp(200, "<graph/>", LOGIN_HEADERS);
    // Issue #150: press now learns "exists" and CINFO from one TSTC select on the read lane
    // (src/adt/ui-tstc.ts) — matched on the SQL body before the generic data-preview branch.
    if (isTstcSelect(o)) {
      return tstcSelectResponse([{ TCODE: tcode, PGMNA: "SAPMZUI1", DYPNO: "0100", CINFO: "00" }]);
    }
    if (o.url.includes(DATA_PREVIEW_PATH)) return systemRoleProbeResponse("nonproductive");
    if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
    if (o.url === PKG_URI && method === "GET") {
      return resp(200, PACKAGE_XML(FLUID_PACKAGE), { "content-type": "application/xml" });
    }

    const fluid = fluidRoute(o);
    if (fluid) return fluid;

    if (o.url.startsWith(`${CLASS_COLLECTION}/zcl_zmcp_ui_`) && method === "GET" && !qs._action) {
      const r = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
      throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
    }
    if (o.url === CLASS_COLLECTION && method === "POST") return resp(200, "", {});
    if (qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
    if (qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (o.url.startsWith(`${CLASS_COLLECTION}/zcl_zmcp_ui_`) && o.url.endsWith("/source/main") && method === "PUT") {
      return resp(200, "", { "content-type": "text/plain" });
    }
    if (o.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return resp(200, "<ok/>", { "content-type": "application/xml" });
  };
}

async function connected(
  route: (o: HttpClientOptions) => HttpClientResponse,
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(route);
  const conn = new AbapConnection(cfg(), { httpClient: inner, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner };
}

const gate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP", "$ABAPSMITH_FLUID_API"],
    // $ is outside the default Z/Y customer namespace, same as
    // test/fluid-package.test.ts's own gate() — ensureFluidPackage's own DEVC/K create needs this too.
    allowNamePrefixes: ["*"],
    writesLockedOut: false,
  });

function fakePool(conn: AbapConnection) {
  return {
    withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    withWrite: <T,>(_op: string, _objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    reserveDebug: () => {
      throw new Error("reserveDebug: not used by abap_ui, and not implemented in this fake.");
    },
  } as unknown as UiToolDeps["pool"];
}

function fakeMcp(): {
  mcp: McpServer;
  tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>;
} {
  const tools = new Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>();
  const mcp = {
    registerTool: (name: string, _config: Record<string, unknown>, handler: (args: unknown) => Promise<CallToolResult>) => {
      tools.set(name, { handler });
      return {} as unknown;
    },
  } as unknown as McpServer;
  return { mcp, tools };
}

async function invoke(
  tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>,
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  const entry = tools.get(name);
  if (!entry) throw new Error(`tool "${name}" was never registered`);
  return entry.handler(args);
}

function okText(result: CallToolResult): string {
  expect(result.isError).toBeFalsy();
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return text.text;
}

function registered(
  conn: AbapConnection,
  journal: Journal,
): Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> {
  const { mcp, tools } = fakeMcp();
  const c = cfg();
  const deps: UiToolDeps = {
    pool: fakePool(conn),
    safety: gate(),
    journal,
    ensureConnected: async () => {},
    errorResult,
    cfg: {
      maxResponseChars: 30_000,
      abapMode: "admin",
      sid: c.sid,
      url: c.url,
      client: c.client,
      allowUiPress: true,
    },
  };
  registerUiTools(mcp, deps);
  return tools;
}

// Same merge-by-id logic as `test/enh-system-key.test.ts` (its own copy of
// the same idea) — later lines for the same `id` override earlier keys, the
// rule `src/journal.ts`'s own `readAll()` documents.
async function readPersistedEntries(dir: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(dir, "index.jsonl"), "utf8");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  const merged = new Map<string, Record<string, unknown>>();
  for (const line of lines) {
    const id = line.id;
    if (typeof id !== "string" || id === "") continue;
    merged.set(id, { ...(merged.get(id) ?? {}), ...line });
  }
  return [...merged.values()];
}

// ===========================================================================

describe("abap_ui press sets systemKey on the journal entry it persists", () => {
  it("the persisted press entry carries systemKey({ sid, url, client }) verbatim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abap-ui-syskey-"));
    try {
      const journal = new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H");
      const tcode = "ZUI_TEST";
      const { conn } = await connected(pressHappyPath(tcode));
      const tools = registered(conn, journal);

      okText(
        await invoke(tools, "abap_ui", {
          mode: "press",
          tcode,
          confirm: true,
          screens: [
            {
              program: "SAPMZUI1",
              dynpro: "0100",
              okcode: "=ENTR",
              fields: [{ name: "BKPF-BLDAT", value: "20260101" }],
            },
          ],
        }),
      );

      const entries = await readPersistedEntries(dir);
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;

      expect(entry.object).toMatchObject({ name: tcode, type: "UI/PRESS" });
      expect(entry.operation).toBe("update");
      expect(entry.irreversible).toBe(true);

      // The trap `test/enh-system-key.test.ts` documents: `journal.ts`'s
      // `begin()` spreads `systemKey` in ONLY when truthy, so `"systemKey" in
      // entry` (not merely `.toBeTruthy()`/`.not.toBe("")`) is what actually
      // distinguishes "field set and persisted" from "field silently dropped".
      expect("systemKey" in entry).toBe(true);
      expect(entry.systemKey).toBeTypeOf("string");
      expect(entry.systemKey).not.toBe("");
      expect(entry.systemKey).toBe(systemKey(conn.cfg));

      expect(entry.system).toBe("A4H");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
