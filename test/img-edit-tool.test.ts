/**
 * Tests for `src/tools/img-edit.ts` — the MCP tool layer (`abap_img_edit`)
 * over `src/adt/img-write.ts`'s three orchestration functions and
 * `src/adt/img-write-policy.ts`'s pure `evaluateImgWrite`.
 *
 * Same harness shape as `test/img-write.test.ts` (a `RecordingClient`
 * implementing `HttpClient` directly, `FLUID_PACKAGE` already existing so no
 * package-create POST is ever needed), with one addition: an armed
 * `upsert`/`delete` call dispatches TWO fluid `img` actions in one connected
 * session — `preview` (the probe) and then `apply` — each through
 * `fluid/dispatch.ts` against the one shared body class (`imgManifest.entry`)
 * plus its own content-hash invoker class (`ZCL_ZMCP_I_` + 8 hex), so the
 * wire fake here has to answer per action, not per bridge class (there is no
 * per-action class any more: `ZCL_ZMCP_IMG_WAPPLY`/`ZCL_ZMCP_CTS_WREQ` are
 * retired). See `multiBridgeHappyPath` below: it keys its classrun answers by
 * action name and recovers each invoker's action from the `iv_action = '...'`
 * literal `fluid/invoke.ts` bakes into the invoker's source PUT, since the
 * invoker's name is only a content hash over tool/action/args.
 * `test/helpers/fluid-img-fake.ts` carries the fluid transcript-framing and
 * class-lifecycle fake shared with `img-write.test.ts` — see that file's
 * header for the frame grammar.
 *
 * Plan validation, ABAP fragment generation, transcript parsing and the
 * deploy/activate/execute wiring itself are already covered in
 * `test/img-write-bridge.test.ts`, `test/customizing-request.test.ts` and
 * `test/img-write.test.ts` (none modified here) — this file only exercises
 * what is unique to the tool layer: argument parsing, the two-phase policy
 * evaluation (`preflightPolicyCheck` then the real `evaluateImgWrite` call),
 * rendering (including the SM30-bypass disclosure appearing on armed output
 * and nowhere in `preview`), and post-hoc journalling of the before-image.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  HttpClientException,
  type HttpClient,
  type HttpClientOptions,
  type HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import type { SessionPool } from "../src/adt/pool.js";
import { errorResult } from "../src/server.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { imgManifest } from "../src/adt/fluid/builtin/img.js";
import { FLUID_RUNTIME_CLASS } from "../src/adt/fluid/abap/runtime.js";
import { Journal } from "../src/journal.js";
import { registerImgEditTools, type ImgEditToolDeps } from "../src/tools/img-edit.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { dynamicImgFluidRoute, imgProbeConsole } from "./helpers/fluid-img-fake.js";

// ----------------------------------------------------------------------- harness ---

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "abapsmith-img-edit-"));
  resetFluidEnsureState();
  resetFluidPackageMemo();
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const cfg = (opts: { maxResponseChars?: number; language?: string } = {}): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    readOnly: false,
    fluidApi: true,
    stateDir: tmp,
    maxResponseChars: opts.maxResponseChars ?? 30_000,
    language: opts.language ?? "",
  });

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse => ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

type ImgAction = "preview" | "apply" | "create_request";
type ClassrunHandler = (o: HttpClientOptions) => HttpClientResponse;

const CLASSRUN_PATH = "/sap/bc/adt/oo/classrun/";
const INVOKER_SOURCE_URL_RE = /^\/sap\/bc\/adt\/oo\/classes\/(zcl_zmcp_i_[0-9a-f]{8})\/source\/main$/i;

/** The action a generated invoker class was written for — `fluid/invoke.ts` bakes it into the invoker's source as `iv_action = '<action>'`; the class name itself is only a content hash over tool/action/args, so it cannot be told apart by name. */
function invokerActionOf(body: unknown): string | undefined {
  return /iv_action = '([a-z_]+)'/.exec(typeof body === "string" ? body : "")?.[1];
}

/** The invoker's args JSON, reassembled from the backtick-literal chunks `fluid/invoke.ts` splits it into (a chunk boundary can land anywhere, so no single source line is guaranteed to hold a whole key/value pair). */
function invokerArgsJson(source: string): string {
  return [...source.matchAll(/lv_json = lv_json && `((?:[^`]|``)*)`\./g)].map((m) => m[1]!.replace(/``/g, "`")).join("");
}

/** Name of the invoker class this session wrote for `action`, if any — from its source PUT. */
function invokerFor(inner: RecordingClient, action: ImgAction): string | undefined {
  for (const c of inner.calls) {
    if ((c.method ?? "GET").toUpperCase() !== "PUT") continue;
    const m = INVOKER_SOURCE_URL_RE.exec(c.url);
    if (m && invokerActionOf(c.body) === action) return m[1]!.toUpperCase();
  }
  return undefined;
}

/** "Did img.<action> run?" means its invoker was both written and classrun — all three actions deploy the same body class (imgManifest.entry), so that class's presence on the wire says nothing about which action reached execution. */
function actionRan(inner: RecordingClient, action: ImgAction): boolean {
  const name = invokerFor(inner, action);
  return name !== undefined && inner.calls.some((c) => c.url.toUpperCase() === `${CLASSRUN_PATH}${name}`.toUpperCase());
}

function probeRan(inner: RecordingClient): boolean {
  return actionRan(inner, "preview");
}

const SESSION_URL = "/sap/bc/adt/compatibility/graph";
const PKG_URI = "/sap/bc/adt/packages/%24abapsmith_fluid_api";

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const PACKAGE_XML = (name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" adtcore:type="DEVC/K">` +
  `<adtcore:packageRef adtcore:name="${name}" adtcore:type="DEVC/K"/>` +
  `<pak:superPackage adtcore:name="$TMP"/>` +
  `</pak:package>`;

/** Builds one column's `<dataPreview:columns>` block — same shape `test/img-read.test.ts` uses, duplicated here (not exported there) for `src/adt/img-read.ts`'s own SQL reads, which `resolveViaActivity`/`resolveTableFromObjectName` (src/tools/img-edit.ts) issue over the SAME connection as the bridge deploys below. */
function columnXml(name: string, values: readonly string[]): string {
  const data = values.map((v) => `<dataPreview:data>${v}</dataPreview:data>`).join("");
  return (
    `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="C" dataPreview:keyAttribute="false"/>` +
    `<dataPreview:dataSet>${data}</dataPreview:dataSet></dataPreview:columns>`
  );
}

/** A hand-built freestyle response body: `cols` maps column name -> that column's values (column-major, matching the real wire shape). */
function body(cols: Record<string, readonly string[]>): string {
  const names = Object.keys(cols);
  const rowCount = names.length === 0 ? 0 : cols[names[0]!]!.length;
  for (const n of names) {
    if (cols[n]!.length !== rowCount) throw new Error(`test fixture bug: column "${n}" has a different row count than "${names[0]}"`);
  }
  const colsXml = names.map((n) => columnXml(n, cols[n]!)).join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
    `${colsXml}</dataPreview:tableData>`
  );
}

/** An empty result set — no rows, no columns. */
function emptyBody(): string {
  return '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview"></dataPreview:tableData>';
}

/** Base routes every test needs regardless of which bridge class(es) are being deployed: login, the FLUID_PACKAGE existence GET (already there — no create needed), and the connect-time probes `AbapConnection.connect()` itself makes. */
function baseRoute(o: HttpClientOptions): HttpClientResponse | undefined {
  if (o.url.includes(SESSION_URL)) {
    return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
  }
  if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
  if (o.url === PKG_URI && (o.method ?? "GET").toUpperCase() === "GET") {
    return resp(200, PACKAGE_XML(FLUID_PACKAGE), { "content-type": "application/xml" });
  }
  return undefined;
}

/**
 * `dynamicImgFluidRoute` (test/helpers/fluid-img-fake.ts) only recognizes the
 * fluid img body class (`imgManifest.entry`) and its content-hash invoker —
 * it predates `img.ts` declaring the shared runtime class
 * (`FLUID_RUNTIME_CLASS`) as a manifest object of its own, deployed FIRST,
 * ahead of the body class (see `src/adt/fluid/ensure.ts`'s in-order deploy).
 * Left unhandled, every request for the runtime class's own lifecycle
 * (existence GET, create, LOCK/PUT/UNLOCK, activation) falls through
 * `dynamicImgFluidRoute` to whatever catch-all a route composes it with —
 * here a bare `resp(200, "<ok/>", ...)`, which lacks an
 * `<adtcore:packageRef>`, so `resolveWriteTarget` (src/adt/write.ts) throws
 * `packageUnknown` on the very first classify pass, before the body class
 * deploy is ever reached. This is the same auto-vivifying per-name state-
 * store idiom `test/helpers/fluid-classic-fake.ts`'s (ungated) `classicFake`
 * already uses successfully for the identical runtime-class-first shape in
 * the `classic` builtin's manifest — scoped here to just the one class name,
 * duplicated locally (and duplicated again in `test/img-write.test.ts`)
 * since `fluid-img-fake.ts` itself is out of scope to change.
 */
function runtimeClassRoute(packageName: string): (o: HttpClientOptions) => HttpClientResponse | undefined {
  const classUri = `/sap/bc/adt/oo/classes/${FLUID_RUNTIME_CLASS.toLowerCase()}`;
  const srcUri = `${classUri}/source/main`;
  const st: { exists: boolean; source?: string; active: boolean } = { exists: false, active: false };

  const notFoundXml = () =>
    `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
    `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
    `<message lang="EN">${FLUID_RUNTIME_CLASS} does not exist</message><properties/></exc:exception>`;

  const classDocXml = () => {
    const main = st.active ? "active" : "inactive";
    const inc = (type: string, version: string) =>
      `<class:include class:includeType="${type}" ` +
      `abapsource:sourceUri="${type === "main" ? "source/main" : `includes/${type}`}" ` +
      `adtcore:name="" adtcore:type="CLAS/I" adtcore:version="${version}"/>`;
    return (
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<class:abapClass adtcore:name="${FLUID_RUNTIME_CLASS}" adtcore:type="CLAS/OC" adtcore:version="active" ` +
      `xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core" ` +
      `xmlns:abapsource="http://www.sap.com/adt/abapsource">` +
      `<adtcore:packageRef adtcore:name="${packageName}"/>` +
      inc("definitions", "active") +
      inc("implementations", "active") +
      inc("macros", "active") +
      inc("main", main) +
      `</class:abapClass>`
    );
  };

  return (o: HttpClientOptions) => {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;

    if (o.url === "/sap/bc/adt/oo/classes" && method === "POST") {
      if (!(o.body ?? "").includes(`adtcore:name="${FLUID_RUNTIME_CLASS}"`)) return undefined;
      st.exists = true;
      st.active = false;
      return resp(200, "", { "content-type": "text/plain" });
    }
    if (o.url === "/sap/bc/adt/activation" && method === "POST") {
      if (!(typeof o.body === "string" && o.body.includes(FLUID_RUNTIME_CLASS))) return undefined;
      st.active = true;
      return resp(200, "", { "content-length": "0" });
    }
    if (o.url === classUri && method === "GET" && !qs._action) {
      if (!st.exists) {
        const r = resp(404, notFoundXml(), { "content-type": "application/xml" });
        throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
      }
      return resp(200, classDocXml(), { "content-type": "application/xml" });
    }
    if (o.url === srcUri && method === "GET") {
      if (!st.exists || st.source === undefined) {
        const r = resp(404, notFoundXml(), { "content-type": "application/xml" });
        throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
      }
      return resp(200, st.source, { "content-type": "text/plain" });
    }
    if (o.url === classUri && qs._action === "LOCK") return resp(200, LOCK_XML(), { "content-type": "application/xml" });
    if (o.url === classUri && qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (o.url === srcUri && method === "PUT") {
      st.source = o.body ?? "";
      st.exists = true;
      st.active = false;
      return resp(200, "", { "content-type": "text/plain" });
    }
    return undefined;
  };
}

/** A real compile error from an activation POST, in the shape `abap-adt-api`'s `activate()` hands back — same fixture as `test/img-write.test.ts`'s activation-refusal routes, parameterised over which class is being refused. */
function activationErrorXml(className: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Class ${className}" type="E" line="1"
       href="/sap/bc/adt/oo/classes/${className.toLowerCase()}/source/main#start=12,4" forceSupported="true">
    <shortText><txt>Field "LV_UNDEFINED" is unknown. It is neither in one of the specified tables nor defined by a "DATA" statement.</txt></shortText>
  </msg>
</chkl:messages>`;
}

/**
 * Full write -> activate -> classrun happy path, generalised over as many
 * fluid `img` actions as `actionRuns` names — an armed `upsert`/`delete`
 * call dispatches `preview` and then `apply` within one connected session,
 * both against the same body class, each through its own content-hash
 * invoker. Every invoker's source PUT is watched for the `iv_action` literal
 * so that, by the time its classrun (and its activation) arrives, the route
 * knows which action that class stands for. A classrun for an action not
 * present in `actionRuns` throws loudly rather than falling through to a
 * generic 200 — the whole point of several tests below is that an action is
 * or is NOT reached. `refuseActivationOf` answers that one action's invoker
 * activation with a real compile error instead, leaving the body class and
 * every other invoker activating cleanly.
 */
function multiBridgeHappyPath(
  actionRuns: Partial<Record<ImgAction, ClassrunHandler>>,
  opts: { refuseActivationOf?: ImgAction } = {},
): ClassrunHandler {
  const invokerActions = new Map<string, string>();
  const fluidRoute = dynamicImgFluidRoute({
    // Classrun for a fluid img class is routed per action below (never through this branch), since
    // dynamicImgFluidRoute's own classrun interception is name-unfiltered and one transcript
    // cannot answer both the probe and the apply of one armed session.
    transcript: () => {
      throw new Error("unreachable: fluid classrun is intercepted before dynamicImgFluidRoute sees it");
    },
    packageName: FLUID_PACKAGE,
    ...(opts.refuseActivationOf === undefined
      ? {}
      : {
          activationError: {
            matches: (name: string) => invokerActions.get(name) === opts.refuseActivationOf,
            xml: activationErrorXml,
          },
        }),
  });
  const runtimeRoute = runtimeClassRoute(FLUID_PACKAGE);

  return (o: HttpClientOptions) => {
    const base = baseRoute(o);
    if (base) return base;
    const qs = (o.qs ?? {}) as Record<string, string>;
    const method = (o.method ?? "GET").toUpperCase();

    const sourcePut = INVOKER_SOURCE_URL_RE.exec(o.url);
    if (sourcePut && method === "PUT") {
      const action = invokerActionOf(o.body);
      if (action !== undefined) invokerActions.set(sourcePut[1]!.toUpperCase(), action);
    }

    if (o.url.startsWith(CLASSRUN_PATH)) {
      const name = o.url.slice(CLASSRUN_PATH.length).toUpperCase();
      const action = invokerActions.get(name);
      const handler = action === undefined ? undefined : actionRuns[action as ImgAction];
      if (!handler) {
        throw new Error(
          `unrouted classrun call for ${name} (img.${action ?? "<unknown action>"}) — this test did not expect it to be reached`,
        );
      }
      const r = handler(o);
      if (r.status !== 200) return r;
      return resp(200, imgProbeConsole(String(r.body), { action }), { "content-type": "text/plain" });
    }

    const fluid = fluidRoute(o);
    if (fluid) return fluid;

    const runtime = runtimeRoute(o);
    if (runtime) return runtime;

    if (o.url === "/sap/bc/adt/oo/classes" && method === "POST") return resp(200, "", {});
    if (qs._action === "LOCK") return resp(200, LOCK_XML(), { "content-type": "application/xml" });
    if (qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (o.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return resp(200, "<ok/>", { "content-type": "application/xml" });
  };
}

/**
 * Same wire routing as `multiBridgeHappyPath`, plus a queue of freestyle
 * (`/datapreview/freestyle`) response bodies for `src/adt/img-read.ts`'s own
 * SQL reads — the resolution step `activity`/`object` selectors trigger
 * before any bridge is ever deployed.
 *
 * The FIRST freestyle call on the wire is always `AbapConnection.connect()`'s
 * own `detectSystemRole()` productive-check (see
 * `test/helpers/system-role-fake.ts`) — that one always answers
 * `T000_NONPRODUCTIVE` regardless of `imgBodies`. Every subsequent freestyle
 * call dequeues the next body from `imgBodies`, in the exact order
 * `img-read.ts`'s `issue()` helper issues them — so `imgBodies` must be
 * ordered to match the resolution path a given test actually takes
 * (`readImgShow`'s 7-call sequence, `resolveTableFromObjectName`'s 3- or
 * 6-call sequence, etc.). A freestyle call past the end of the queue throws a
 * descriptive error rather than falling through to some default body, so a
 * fixture that is short by one call fails loudly instead of silently
 * misreading a later column set as an earlier one.
 */
function resolutionRoute(
  imgBodies: readonly string[],
  actionRuns: Partial<Record<ImgAction, ClassrunHandler>> = {},
): ClassrunHandler {
  let freestyleCalls = 0;
  const queue = [...imgBodies];
  const rest = multiBridgeHappyPath(actionRuns);
  return (o: HttpClientOptions) => {
    if (o.url.includes("/datapreview/freestyle")) {
      freestyleCalls += 1;
      if (freestyleCalls === 1) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(
          `resolutionRoute: freestyle call #${freestyleCalls} has no queued body left — the resolution ` +
            "code issued more SQL reads than this fixture anticipated.",
        );
      }
      return resp(200, next, { "content-type": "application/xml" });
    }
    return rest(o);
  };
}

/** A classrun POST that 500s — a scaffold-level failure below activation, activation itself already having succeeded. */
function classrunBlowsUp(o: HttpClientOptions): HttpClientResponse {
  const r = resp(500, "<exc:exception/>", { "content-type": "application/xml" });
  throw new HttpClientException("Request failed with status code 500", "500", 500, undefined, o, r);
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

/** `writesLockedOut: false` is load-bearing — `evaluateImgWrite`'s own rule 2 treats an UNSET lockout as "not yet proven safe" and refuses, stricter than `SafetyGate` itself (see img-write-policy.ts). */
const openGate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"], writesLockedOut: false });

/** `readOnly: true` trips `evaluateImgWrite`'s rule 3 from the config-only pre-check, before any I/O. */
const readOnlyGate = (): SafetyGate =>
  new SafetyGate({ readOnly: true, allowPackages: [], writesLockedOut: false });

/** A `SessionPool` that just forwards straight onto one wired connection — this repo has no reusable fake pool. */
function fakePool(conn: AbapConnection): SessionPool {
  return {
    withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    withWrite: <T,>(_op: string, _objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    reserveDebug: () => {
      throw new Error("reserveDebug: not used by abap_img_edit, and not implemented in this fake.");
    },
  } as unknown as SessionPool;
}

/** Captures `registerTool` calls into a `Map<name, {config, handler}>` instead of talking to a real MCP client. */
function fakeMcp(): {
  mcp: McpServer;
  tools: Map<string, { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }>;
} {
  const tools = new Map<string, { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }>();
  const mcp = {
    registerTool: (name: string, config: Record<string, unknown>, handler: (args: unknown) => Promise<CallToolResult>) => {
      tools.set(name, { config, handler });
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

function errorPayload(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBe(true);
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return JSON.parse(text.text) as Record<string, unknown>;
}

function okText(result: CallToolResult): string {
  expect(result.isError).toBeFalsy();
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return text.text;
}

/**
 * Slices out just the `--- TRANSPORT ENTRY RECORDED ---` section (up to the next section header or
 * end of text), so assertions on its contents cannot be satisfied by the header block above it
 * (which already prints `table:`/`view:`/`masterType:`). Fails loudly if the section is missing.
 *
 * The next-section boundary is matched as a whole line of the shape `--- TITLE ---` (`^--- .+
 * ---$`), NOT merely a line starting with `---` — `textTable`'s own underline row (e.g. `---
 * ------  ----------  ...`) also starts with `---`, and a naive `indexOf("\n---")` cutoff would
 * truncate the section right after its own header, before ever reaching the data rows below the
 * underline.
 */
function transportSection(text: string): string {
  const idx = text.indexOf("--- TRANSPORT ENTRY RECORDED ---");
  expect(idx).toBeGreaterThanOrEqual(0);
  const lines = text.slice(idx).split("\n");
  const nextHeaderIdx = lines.findIndex((l, i) => i > 0 && /^--- .+ ---$/.test(l));
  return (nextHeaderIdx === -1 ? lines : lines.slice(0, nextHeaderIdx)).join("\n");
}

/** A `Journal` that never touches disk — `enabled: false` is modelled inside `Journal` itself; used by every test that does not inspect journal entries. */
const disabledJournal = new Journal({ dir: join(tmpdir(), "abapsmith-img-edit-unused"), enabled: false, maxEntries: 1, maxAgeDays: 1 }, "TST");

/** A real `Journal` on a temp directory — needed by any test that reads an entry back off disk, same idiom as `test/activate.test.ts`'s `withJournal`. */
async function withJournal(fn: (j: Journal) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abapsmith-img-edit-journal-"));
  try {
    await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "TST"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * `language: ""` (not "EN"): an empty config language is what "operator did not set ABAP_LANGUAGE"
 * looks like on the real `Config` — `assertImgLanguage` then falls back to `IMG_DEFAULT_LANGUAGE`
 * ("E"), same as every other test in this file that never passes `language` at all. Individual tests
 * that need to pin `cfg.language` to something else (e.g. the rejected "EN" case) pass
 * `opts.language` explicitly.
 */
function depsFor(
  conn: AbapConnection,
  opts: {
    safety?: SafetyGate;
    maxResponseChars?: number;
    journal?: Journal;
    language?: string;
    ensureConnected?: () => Promise<void>;
    transport?: ImgEditToolDeps["transport"];
  } = {},
): ImgEditToolDeps {
  return {
    pool: fakePool(conn),
    safety: opts.safety ?? openGate(),
    ensureConnected: opts.ensureConnected ?? (async () => {}),
    errorResult,
    cfg: cfg({ maxResponseChars: opts.maxResponseChars, language: opts.language }),
    journal: opts.journal ?? disabledJournal,
    ...(opts.transport !== undefined ? { transport: opts.transport } : {}),
  };
}

async function registered(
  conn: AbapConnection,
  opts: {
    safety?: SafetyGate;
    maxResponseChars?: number;
    journal?: Journal;
    language?: string;
    ensureConnected?: () => Promise<void>;
    transport?: ImgEditToolDeps["transport"];
  } = {},
): Promise<{
  tools: Map<string, { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }>;
  deps: ImgEditToolDeps;
}> {
  const { mcp, tools } = fakeMcp();
  const deps = depsFor(conn, opts);
  registerImgEditTools(mcp, deps);
  return { tools, deps };
}

/**
 * Minimal `SessionTrOwner` fake for issue #176's auto-resolve path: `created` tracks the trkorrs
 * this "session" itself minted (via `abap_img_edit create_request` or `abap_transport create`),
 * `createdThisSession` answers whether a given trkorr is one of them, and `trkorr` is the general
 * session transport `previewSessionCorrNr`/`resolveSessionCorrNr` fall back to for a workbench
 * request when nothing has been cached under the "workbench" kind yet — undefined here since these
 * tests exercise the img-edit-specific cache (`sessionImgRequests`), not that fallback.
 */
function fakeTransport(trkorr?: string): ImgEditToolDeps["transport"] {
  const created = new Set<string>();
  return {
    trkorr,
    createdThisSession: (t: string) => created.has(t.toUpperCase()),
    noteCreated: (t: string) => {
      created.add(t.toUpperCase());
    },
  };
}

/** `allowTransports: ["auto"]` — the config surface `transportAllowlistHasAuto` reads. */
const autoGate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"], writesLockedOut: false, allowTransports: ["auto"] });

/** `allowTransports: []` — deny-all, never counts as "auto" even with a session transport present. */
const denyAllTransportsGate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"], writesLockedOut: false, allowTransports: [] });

// ----------------------------------------------------------------------- fixtures ---

/** A row `ZKEY=A` that already exists, `ZDESC="Old"`, on a writable (delivery class C, client-dependent) table — the fixture every happy-path test below shares, same naming convention as `test/img-write.test.ts` (table `ZTEST_IMGW`, key `ZKEY`). */
const PROBE_TRANSCRIPT_EXISTING =
  `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
  `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
  `IMGW> FLD table=[ztest_imgw] field=[ZKEY] key=[X] type=[CHAR] len=[10] rollname=[ZKEY]\n` +
  `IMGW> FLD table=[ztest_imgw] field=[ZDESC] key=[] type=[CHAR] len=[40] rollname=[ZDESC]\n` +
  `IMGW> BVAL row=[1] field=[ZKEY] len=[1] value=[A]\n` +
  `IMGW> BVAL row=[1] field=[ZDESC] len=[3] value=[Old]\n` +
  `IMGW> PROBED rows=[1]\n`;

const APPLY_TRANSCRIPT_UPSERT =
  `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
  `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
  `IMGW> BVAL row=[1] field=[ZDESC] len=[3] value=[Old]\n` +
  `IMGW> TRKEY row=[1] trkorr=[A4HK900001] len=[10] value=[A4HK900001]\n` +
  `IMGW> AVAL row=[1] field=[ZDESC] len=[3] value=[New]\n` +
  `IMGW> APPLIED rows=[1]\n`;

const APPLY_TRANSCRIPT_DELETE =
  `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
  `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
  `IMGW> BVAL row=[1] field=[ZDESC] len=[3] value=[Old]\n` +
  `IMGW> TRKEY row=[1] trkorr=[A4HK900001] len=[10] value=[A4HK900001]\n` +
  `IMGW> AABSENT row=[1]\n` +
  `IMGW> APPLIED rows=[1]\n`;

/**
 * A probe that confirms the single row is absent — the fixture the live 2026-09-06 defect actually
 * hit before the apply ever ran (see `beforeImageFor`, src/tools/img-edit.ts: this is what makes
 * the journal say `existedBefore: false`/`confirmed-absent`).
 */
const PROBE_TRANSCRIPT_ABSENT =
  `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
  `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
  `IMGW> FLD table=[ztest_imgw] field=[ZKEY] key=[X] type=[CHAR] len=[10] rollname=[ZKEY]\n` +
  `IMGW> FLD table=[ztest_imgw] field=[ZDESC] key=[] type=[CHAR] len=[40] rollname=[ZDESC]\n` +
  `IMGW> BABSENT row=[1]\n` +
  `IMGW> PROBED rows=[1]\n`;

/**
 * Defect fixture — a `delete` apply transcript for a row that never existed: `BABSENT`/`AABSENT`
 * on both sides, no `TRKEY` line and no `WROTE` line (both sit inside the before-image `SELECT`'s
 * `ELSE` in the `apply` action's delete branch, src/adt/fluid/builtin/img.ts, so an absent row emits
 * neither). Live symptom this reproduces: an armed delete of a nonexistent row answered
 * `[ok] applied: 1` with a `ROWS DELETED` body carrying no `changed`/`result` column at all — a
 * caller reading that response could only conclude the row was deleted, which was false.
 */
const APPLY_TRANSCRIPT_DELETE_ABSENT =
  `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
  `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
  `IMGW> BABSENT row=[1]\n` +
  `IMGW> AABSENT row=[1]\n` +
  `IMGW> APPLIED rows=[1]\n`;

/** Probe confirming two rows: `ZKEY=A` present, `ZKEY=B` absent — feeds the mixed delete test below. */
const PROBE_TRANSCRIPT_MIXED =
  `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
  `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
  `IMGW> FLD table=[ztest_imgw] field=[ZKEY] key=[X] type=[CHAR] len=[10] rollname=[ZKEY]\n` +
  `IMGW> FLD table=[ztest_imgw] field=[ZDESC] key=[] type=[CHAR] len=[40] rollname=[ZDESC]\n` +
  `IMGW> BVAL row=[1] field=[ZKEY] len=[1] value=[A]\n` +
  `IMGW> BVAL row=[1] field=[ZDESC] len=[3] value=[Old]\n` +
  `IMGW> BABSENT row=[2]\n` +
  `IMGW> PROBED rows=[2]\n`;

/**
 * Mixed apply transcript: row 1 (`ZKEY=A`) existed and is deleted (carries `TRKEY`), row 2
 * (`ZKEY=B`) never existed (no `TRKEY`, `BABSENT`/`AABSENT` only) — each row must be classified
 * independently by `rowDeleteSummaries`.
 */
const APPLY_TRANSCRIPT_DELETE_MIXED =
  `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
  `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
  `IMGW> BVAL row=[1] field=[ZDESC] len=[3] value=[Old]\n` +
  `IMGW> TRKEY row=[1] trkorr=[A4HK900001] len=[10] value=[A4HK900001]\n` +
  `IMGW> AABSENT row=[1]\n` +
  `IMGW> BABSENT row=[2]\n` +
  `IMGW> AABSENT row=[2]\n` +
  `IMGW> APPLIED rows=[2]\n`;

/**
 * Same shape as `APPLY_TRANSCRIPT_UPSERT`, but with a `TRKEY` value that is
 * deliberately NOT the trkorr text (`ZTMD`, 4 chars) — the real generated
 * ABAP's `IMGW> TRKEY ... value=[{ <key_c> }]` is the table key cast to a
 * character string, which the trkorr-shaped fixtures above obscure. This is
 * the fixture the client-prefix tests below actually need: SAP stores
 * `ls_e071k-tabkey = sy-mandt && <key_c>` (client `001` + this value), which
 * the `IMGW> TRKEY` line itself never carries.
 */
const APPLY_TRANSCRIPT_UPSERT_TABKEY =
  `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
  `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
  `IMGW> BVAL row=[1] field=[ZDESC] len=[3] value=[Old]\n` +
  `IMGW> TRKEY row=[1] trkorr=[A4HK900001] len=[4] value=[ZTMD]\n` +
  `IMGW> AVAL row=[1] field=[ZDESC] len=[3] value=[New]\n` +
  `IMGW> APPLIED rows=[1]\n`;

/** Same as `APPLY_TRANSCRIPT_UPSERT_TABKEY`, but with no `IMGW> CLIENT` line at all — the fallback case where the client cannot be sourced to reconstruct the stored TABKEY. */
const APPLY_TRANSCRIPT_UPSERT_TABKEY_NO_CLIENT =
  `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
  `IMGW> BVAL row=[1] field=[ZDESC] len=[3] value=[Old]\n` +
  `IMGW> TRKEY row=[1] trkorr=[A4HK900001] len=[4] value=[ZTMD]\n` +
  `IMGW> AVAL row=[1] field=[ZDESC] len=[3] value=[New]\n` +
  `IMGW> APPLIED rows=[1]\n`;

/** Delete-side counterpart of `APPLY_TRANSCRIPT_UPSERT_TABKEY` — confirms the identity/tabkey disclosure is not upsert-only (deletes record a CTS entry too — see the `apply` action's delete branch in `src/adt/fluid/builtin/img.ts`). */
const APPLY_TRANSCRIPT_DELETE_TABKEY =
  `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
  `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
  `IMGW> BVAL row=[1] field=[ZDESC] len=[3] value=[Old]\n` +
  `IMGW> TRKEY row=[1] trkorr=[A4HK900001] len=[6] value=[DELKEY]\n` +
  `IMGW> AABSENT row=[1]\n` +
  `IMGW> APPLIED rows=[1]\n`;

const CREATE_REQUEST_TRANSCRIPT = `CTSW> REQUEST len=[10] value=[A4HK900002]\nCTSW> TASK len=[10] value=[A4HK900003]\n`;

/** Same request/task as `CREATE_REQUEST_TRANSCRIPT`, plus the task's `TASKTYPE` (`ls_task_header-trfunction`) bridge line. */
const CREATE_REQUEST_TRANSCRIPT_WITH_TASKTYPE =
  `CTSW> REQUEST len=[10] value=[A4HK900002]\nCTSW> TASK len=[10] value=[A4HK900003]\nCTSW> TASKTYPE len=[1] value=[K]\n`;

/** `NO_TASK` reported as an `ERROR` line with no `REQUEST` line at all — the bridge reported failure and no number came back. */
const NO_TASK_ERROR_NO_NUMBER_TRANSCRIPT = `CTSW> ERROR exception=[NO_TASK] len=[0] value=[]\n`;

/** A `REQUEST` line followed by a scaffold-level failure (`ERR_LINE_PREFIX`, not `CTSW> `) — a number came back, but the bridge run was not otherwise clean. */
const REQUEST_PLUS_SCAFFOLD_ERROR_TRANSCRIPT = `CTSW> REQUEST len=[10] value=[A4HK900002]\nZMCP-ERR> unexpected exception CX_ROOT during bridge execution\n`;

/** The `NO_TASK` *warning* path (current `customizing-request.ts` behaviour): a number always comes back, and a missing task is reported as a `WARN` line rather than aborting the transcript. */
const REQUEST_PLUS_NO_TASK_WARNING_TRANSCRIPT = `CTSW> REQUEST len=[10] value=[A4HK900002]\nCTSW> WARN code=[NO_TASK] len=[10] value=[A4HK900002]\n`;

/**
 * Same table/row shape as `PROBE_TRANSCRIPT_EXISTING`, but `cccoractiv=[1]` (auto-record ON) instead
 * of blank — `classifyCccoractiv` then reads this as NOT proven off, so `evaluateImgWrite`'s
 * `corrRequired` is true even though the table is client-dependent (img-write-policy.ts: `corrRequired
 * = !(clientDependent === true && recordingProvenOff)`). This is the fixture issue #176's auto-resolve
 * tests need: a corr_nr genuinely required, on an otherwise ordinary writable table.
 */
const PROBE_TRANSCRIPT_CORR_REQUIRED =
  `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[1]\n` +
  `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
  `IMGW> FLD table=[ztest_imgw] field=[ZKEY] key=[X] type=[CHAR] len=[10] rollname=[ZKEY]\n` +
  `IMGW> FLD table=[ztest_imgw] field=[ZDESC] key=[] type=[CHAR] len=[40] rollname=[ZDESC]\n` +
  `IMGW> BVAL row=[1] field=[ZKEY] len=[1] value=[A]\n` +
  `IMGW> BVAL row=[1] field=[ZDESC] len=[3] value=[Old]\n` +
  `IMGW> PROBED rows=[1]\n`;

/** A minted request/task, distinct numbers from `CREATE_REQUEST_TRANSCRIPT` so a test can tell which create call answered which invocation if both run in the same test. */
const CREATE_REQUEST_TRANSCRIPT_SESSION = `CTSW> REQUEST len=[10] value=[A4HK900050]\nCTSW> TASK len=[10] value=[A4HK900051]\n`;

/**
 * Client-independent table (`clidep=[]`), fixture for the tabkey-rendering sibling test: the
 * generated ABAP only prefixes TABKEY with `sy-mandt` for a client-dependent table (`lv_has_client`),
 * so this must render unprefixed even though the apply transcript below carries a full `IMGW> CLIENT`
 * line.
 */
const PROBE_TRANSCRIPT_CLIENT_INDEP =
  `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
  `IMGW> TABLE table=[zcind] delclass=[C] clidep=[]\n` +
  `IMGW> FLD table=[zcind] field=[ZKEY] key=[X] type=[CHAR] len=[10] rollname=[ZKEY]\n` +
  `IMGW> FLD table=[zcind] field=[ZDESC] key=[] type=[CHAR] len=[40] rollname=[ZDESC]\n` +
  `IMGW> BVAL row=[1] field=[ZKEY] len=[1] value=[A]\n` +
  `IMGW> BVAL row=[1] field=[ZDESC] len=[3] value=[Old]\n` +
  `IMGW> PROBED rows=[1]\n`;

const APPLY_TRANSCRIPT_CLIENT_INDEP_TABKEY =
  `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
  `IMGW> TABLE table=[zcind] delclass=[C] clidep=[]\n` +
  `IMGW> BVAL row=[1] field=[ZDESC] len=[3] value=[Old]\n` +
  `IMGW> TRKEY row=[1] trkorr=[A4HK900001] len=[4] value=[ZTMD]\n` +
  `IMGW> AVAL row=[1] field=[ZDESC] len=[3] value=[New]\n` +
  `IMGW> APPLIED rows=[1]\n`;

const BASE_ARGS = {
  table: "ZTEST_IMGW",
  key_fields: ["ZKEY"],
  view: "ZTEST_IMGW_V",
  master_type: "VDAT" as const,
  corr_nr: "A4HK900001",
};

/** `BASE_ARGS` without `corr_nr` — issue #176's auto-resolve tests need the field genuinely omitted, not merely overridden, so corr_nr resolution runs. */
const BASE_ARGS_NO_CORR = {
  table: "ZTEST_IMGW",
  key_fields: ["ZKEY"],
  view: "ZTEST_IMGW_V",
  master_type: "VDAT" as const,
};

// ===========================================================================

describe("abap_img_edit — mode: preview", () => {
  it("renders current vs. prospective rows and a descriptive transport-entry line, never deploying the apply bridge, and omits the SM30-bypass disclosure", async () => {
    const { conn, inner } = await connected(
      multiBridgeHappyPath({ preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING) }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      ...BASE_ARGS,
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });
    const text = okText(result);

    expect(text).toContain("mode: preview");
    // Header and confirm-note both name the base table exactly as SAP would show it, uppercased,
    // even though PROBE_TRANSCRIPT_EXISTING's own TABLE line names it lowercase ("ztest_imgw").
    expect(text).toContain("table: ZTEST_IMGW");
    expect(text).toContain('confirm: "ZTEST_IMGW"');
    expect(text).toContain("--- CURRENT ROWS ---");
    expect(text).toContain("exists");
    expect(text).toContain("ZDESC=Old");
    expect(text).toContain("--- TRANSPORT ENTRY (DESCRIPTIVE ONLY) ---");
    // OLD (wrong) behavior this replaces: the fixture names the table lowercase
    // ("table=[ztest_imgw]"), and this assertion used to check for `TABU ztest_imgw`, with a
    // comment justifying the lowercase echo as intentional ("not re-uppercased"). SAP itself is
    // case-insensitive about table names, so echoing back whatever case the DDIC read happened to
    // return was a real bug (see `policyTableFromProbe`, src/tools/img-edit.ts) — the resolved
    // table name is now normalised to upper case wherever it is rendered.
    expect(text).toContain("TABU ZTEST_IMGW");
    expect(text).not.toContain("ztest_imgw");
    expect(text).toContain("PROSPECTIVE CHANGE");
    expect(text).toContain("SET ZDESC=New");
    // The SM30-bypass note is seeded on every allowed verdict, including preview — but nothing has
    // been written yet, so this module deliberately filters it out of preview's own rendering.
    expect(text).not.toContain("table-maintenance-generator events");

    expect(probeRan(inner)).toBe(true);
    expect(actionRan(inner, "apply")).toBe(false);
  });

  it("a single-row preview labels the same row 0 in CURRENT ROWS and PROSPECTIVE CHANGE, even though the transcript's own row numbers are 1-based", async () => {
    // PROBE_TRANSCRIPT_EXISTING carries transcript row 1 (`BVAL row=[1] ...`), matching the real
    // bridge's `rowNo = i + 1` (img-write-bridge.ts). Both tables must still label args.rows[0] as
    // row 0 — the caller's own array index — never the raw transcript number, and never two
    // different numbers for the same row in the same response.
    const { conn } = await connected(
      multiBridgeHappyPath({ preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING) }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      ...BASE_ARGS,
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });
    const text = okText(result);
    const lines = text.split("\n");

    const currentRowsTitle = lines.findIndex((l) => l.includes("--- CURRENT ROWS ---"));
    const prospectiveTitle = lines.findIndex((l) => l.includes("--- PROSPECTIVE CHANGE ---"));
    expect(currentRowsTitle).toBeGreaterThanOrEqual(0);
    expect(prospectiveTitle).toBeGreaterThanOrEqual(0);

    // title, header, separator, then the first (only) data row.
    const currentDataRow = lines[currentRowsTitle + 3]!;
    const prospectiveDataRow = lines[prospectiveTitle + 3]!;
    expect(currentDataRow.trim().split(/\s+/)[0]).toBe("0");
    expect(prospectiveDataRow.trim().split(/\s+/)[0]).toBe("0");
    expect(currentDataRow).toContain("ZDESC=Old");
    expect(prospectiveDataRow).toContain("SET ZDESC=New");
  });

  it("a row that does not exist yet is shown as such, not conflated with an existing one", async () => {
    const TRANSCRIPT =
      `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
      `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
      `IMGW> FLD table=[ztest_imgw] field=[ZKEY] key=[X] type=[CHAR] len=[10] rollname=[ZKEY]\n` +
      `IMGW> FLD table=[ztest_imgw] field=[ZDESC] key=[] type=[CHAR] len=[40] rollname=[ZDESC]\n` +
      `IMGW> BABSENT row=[1]\n` +
      `IMGW> PROBED rows=[1]\n`;
    const { conn } = await connected(multiBridgeHappyPath({ preview: () => resp(200, TRANSCRIPT) }));
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      ...BASE_ARGS,
      rows: [{ key: { ZKEY: "B" }, values: { ZDESC: "New" } }],
    });
    const text = okText(result);

    expect(text).toContain("does not exist yet");
  });
});

// ===========================================================================

describe("abap_img_edit — mode: upsert (armed)", () => {
  it("happy path: deploys probe then apply, discloses the SM30 bypass, and journals a before-image captured from the probe", async () => {
    await withJournal(async (journal) => {
      const { conn, inner } = await connected(
        multiBridgeHappyPath({
          preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING),
          apply: () => resp(200, APPLY_TRANSCRIPT_UPSERT),
        }),
      );
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "upsert",
        ...BASE_ARGS,
        confirm: "ZTEST_IMGW",
        rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
      });
      const text = okText(result);

      expect(text).toContain("mode: upsert");
      expect(text).toContain("ROWS WRITTEN");
      expect(text).toContain("--- TRANSPORT ENTRY RECORDED ---");
      expect(text).toContain("A4HK900001");
      expect(text).toContain("table-maintenance-generator events");
      expect(text).toMatch(/Journalled as entry/);

      expect(probeRan(inner)).toBe(true);
      expect(actionRan(inner, "apply")).toBe(true);

      const entries = await journal.list({});
      expect(entries).toHaveLength(1);
      const e = entries[0]!;
      expect(e.operation).toBe("update");
      expect(e.object.name).toBe("ZTEST_IMGW");
      expect(e.existedBefore).toBe(true);
      expect(e.beforeCapture).toBe("captured");
      expect(e.outcome).toBe("succeeded");
      const before = await journal.beforeImage(e);
      expect(before).toBeDefined();
      expect(before ?? "").toContain("Old");
    });
  });

  it("delete: journals as a `delete` operation, renders ROWS DELETED", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(
        multiBridgeHappyPath({
          preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING),
          apply: () => resp(200, APPLY_TRANSCRIPT_DELETE),
        }),
      );
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "delete",
        ...BASE_ARGS,
        confirm: "ZTEST_IMGW",
        rows: [{ key: { ZKEY: "A" } }],
      });
      const text = okText(result);

      expect(text).toContain("ROWS DELETED");

      const entries = await journal.list({});
      expect(entries).toHaveLength(1);
      expect(entries[0]!.operation).toBe("delete");
      expect(entries[0]!.existedBefore).toBe(true);
    });
  });

  it("confirm-mismatch refuses after the probe already ran but before the apply bridge is ever deployed", async () => {
    const { conn, inner } = await connected(
      multiBridgeHappyPath({ preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING) }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "upsert",
      ...BASE_ARGS,
      confirm: "SOME_OTHER_NAME",
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });

    expect(errorPayload(result).error).toBe("SAFETY_DENIED");
    expect(probeRan(inner)).toBe(true);
    expect(actionRan(inner, "apply")).toBe(false);
  });

  it("a BAD_INPUT argument error (missing rows) is thrown before any network call", async () => {
    const { conn, inner } = await connected(
      multiBridgeHappyPath({ preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING) }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "upsert",
      ...BASE_ARGS,
      confirm: "ZTEST_IMGW",
      rows: [],
    });

    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(inner.calls).toHaveLength(0);
  });
});

// ===========================================================================
// Live symptom, 2026-09-06: an armed `delete` of a row that does NOT exist
// answered `[ok] applied: 1` with a `ROWS DELETED` body carrying only
// row/key/change (the PROSPECTIVE echo of what was requested) — no `changed`
// column, no `result` column. The journal correctly recorded
// existedBefore/confirmed-absent; the rendered response did not say so, so a
// caller reading only the response text would conclude the row was deleted.
// These pin the fix: `ROWS DELETED` now carries `changed`/`result` per row
// (via `rowDeleteSummaries`/`armedDeleteRowsTable`, mirroring the upsert
// side), and an absent row gets an explicit note.
// ===========================================================================

describe("abap_img_edit — armed delete: per-row changed/result disclosure", () => {
  it("a row that does not exist is reported as changed: no / absent, not as a claimed deletion", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(
        multiBridgeHappyPath({
          preview: () => resp(200, PROBE_TRANSCRIPT_ABSENT),
          apply: () => resp(200, APPLY_TRANSCRIPT_DELETE_ABSENT),
        }),
      );
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "delete",
        ...BASE_ARGS,
        confirm: "ZTEST_IMGW",
        rows: [{ key: { ZKEY: "A" } }],
      });
      const text = okText(result);

      expect(text).toContain("ROWS DELETED");
      const lines = text.split("\n");
      const bodyTitle = lines.findIndex((l) => l.includes("--- ROWS DELETED ---"));
      expect(bodyTitle).toBeGreaterThanOrEqual(0);
      const header = lines[bodyTitle + 1]!;
      const dataRow = lines[bodyTitle + 3]!;
      expect(header).toContain("changed");
      expect(header).toContain("result");
      const cells = dataRow.trim().split(/\s+/);
      expect(cells[0]).toBe("0");
      expect(dataRow).toContain("no");
      expect(dataRow).toContain("absent");

      // No transport entry was recorded for this row (no IMGW> TRKEY line at all in the transcript).
      expect(text).not.toContain("TRANSPORT ENTRY RECORDED");

      // The note must say the row did not exist, nothing was deleted, and no transport entry was
      // recorded — plainly enough that a caller cannot mistake it for a confirmed deletion.
      expect(text).toMatch(/row\(s\) 0\b/i);
      expect(text).toMatch(/did not exist|absent/i);
      expect(text).toMatch(/nothing was deleted|no transport entry/i);

      const entries = await journal.list({});
      expect(entries[0]!.existedBefore).toBe(false);
      expect(entries[0]!.beforeCapture).toBe("confirmed-absent");
    });
  });

  it("a row that DID exist is still reported as changed: yes / deleted, with the transport entry disclosure intact", async () => {
    const { conn } = await connected(
      multiBridgeHappyPath({
        preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING),
        apply: () => resp(200, APPLY_TRANSCRIPT_DELETE),
      }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "delete",
      ...BASE_ARGS,
      confirm: "ZTEST_IMGW",
      rows: [{ key: { ZKEY: "A" } }],
    });
    const text = okText(result);

    expect(text).toContain("ROWS DELETED");
    const lines = text.split("\n");
    const bodyTitle = lines.findIndex((l) => l.includes("--- ROWS DELETED ---"));
    const dataRow = lines[bodyTitle + 3]!;
    expect(dataRow).toContain("yes");
    expect(dataRow).toContain("deleted");

    expect(text).toContain("--- TRANSPORT ENTRY RECORDED ---");
    expect(text).toContain("A4HK900001");
  });

  it("a mixed delete (one existing row, one absent row) classifies each row independently and names only the absent one in the note", async () => {
    const { conn } = await connected(
      multiBridgeHappyPath({
        preview: () => resp(200, PROBE_TRANSCRIPT_MIXED),
        apply: () => resp(200, APPLY_TRANSCRIPT_DELETE_MIXED),
      }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "delete",
      ...BASE_ARGS,
      confirm: "ZTEST_IMGW",
      rows: [{ key: { ZKEY: "A" } }, { key: { ZKEY: "B" } }],
    });
    const text = okText(result);

    const lines = text.split("\n");
    const bodyTitle = lines.findIndex((l) => l.includes("--- ROWS DELETED ---"));
    const row0 = lines[bodyTitle + 3]!;
    const row1 = lines[bodyTitle + 4]!;
    expect(row0).toContain("yes");
    expect(row0).toContain("deleted");
    expect(row1).toContain("no");
    expect(row1).toContain("absent");

    // The transport entry section carries exactly one row (the one that existed) — no entry is
    // fabricated for the absent row, which emitted no IMGW> TRKEY line at all.
    const section = transportSection(text);
    expect(section).toContain("A4HK900001");
    const sectionRowCells = section
      .split("\n")
      .filter((l) => /^\s*\d/.test(l))
      .map((l) => l.trim().split(/\s+/)[0]);
    expect(sectionRowCells).toHaveLength(1);

    // The note names only row 1 (0-based, args.rows index) as absent, never row 0.
    const noteLine = lines.find((l) => /did not exist|absent/i.test(l) && !l.includes("---"));
    expect(noteLine).toBeDefined();
    expect(noteLine).toMatch(/row\(s\) 1\b/i);
    expect(noteLine).not.toMatch(/row\(s\) 0\b/i);
  });
});

// ===========================================================================
// The armed success response's own "TRANSPORT ENTRY RECORDED" section used to
// show only trkorr/recorded_order/recorded_task — a caller who needed to
// confirm what was actually filed (pgmid/object/objname/mastertype/
// mastername, and the TABKEY as SAP actually stored it) had to read E071K
// raw. These pin the fix: the identity fields render once above the per-row
// table (constant across every row of one call), and the per-row TABKEY is
// reconstructed as client + the bridge's bare key value — never fabricating
// a client the transcript never reported.
// ===========================================================================

describe("abap_img_edit — armed transport entry identity disclosure", () => {
  it("armed upsert discloses pgmid/object/objname/mastertype/mastername above the per-row table, with the plan's real values", async () => {
    const { conn } = await connected(
      multiBridgeHappyPath({
        preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING),
        apply: () => resp(200, APPLY_TRANSCRIPT_UPSERT),
      }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "upsert",
      ...BASE_ARGS,
      confirm: "ZTEST_IMGW",
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });
    const section = transportSection(okText(result));

    // R3TR/TABU are generator constants (see ctsRecordFragment in img-write-bridge.ts); ZTEST_IMGW
    // (objname) is args.table, VDAT/ZTEST_IMGW_V (mastertype/mastername) are args.masterType/
    // args.view — none of these are parsed off the TRKEY transcript line, which carries none of
    // them.
    expect(section).toContain("R3TR TABU ZTEST_IMGW (master VDAT ZTEST_IMGW_V)");
  });

  it("the rendered tabkey is client-prefixed: mandt 001 + a TRKEY value of ZTMD renders 001ZTMD, matching what SAP actually stored", async () => {
    const { conn } = await connected(
      multiBridgeHappyPath({
        preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING),
        apply: () => resp(200, APPLY_TRANSCRIPT_UPSERT_TABKEY),
      }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "upsert",
      ...BASE_ARGS,
      confirm: "ZTEST_IMGW",
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });
    const section = transportSection(okText(result));
    const tokens = section.split(/\s+/).filter(Boolean);

    // The generated ABAP stores `ls_e071k-tabkey = sy-mandt && <key_c>` — client "001" concatenated
    // with the key — but the IMGW> TRKEY line's own value=[...] is the bare key ("ZTMD") with no
    // client. A cell showing the bare "ZTMD" instead of "001ZTMD" would be the exact mistake this
    // pins against.
    expect(tokens).toContain("001ZTMD");
    expect(tokens).not.toContain("ZTMD");
  });

  it("without an IMGW> CLIENT line, no client prefix is fabricated — the key renders unprefixed and the response says so", async () => {
    const { conn } = await connected(
      multiBridgeHappyPath({
        preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING),
        apply: () => resp(200, APPLY_TRANSCRIPT_UPSERT_TABKEY_NO_CLIENT),
      }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "upsert",
      ...BASE_ARGS,
      confirm: "ZTEST_IMGW",
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });
    const text = okText(result);
    const section = transportSection(text);
    const tokens = section.split(/\s+/).filter(Boolean);

    expect(tokens).toContain("ZTMD");
    expect(tokens).not.toContain("001ZTMD");
    expect(text).toContain("key portion only");
  });

  it("a client-independent table's tabkey renders unprefixed even with an IMGW> CLIENT line present (issue #176)", async () => {
    const { conn } = await connected(
      multiBridgeHappyPath({
        preview: () => resp(200, PROBE_TRANSCRIPT_CLIENT_INDEP),
        apply: () => resp(200, APPLY_TRANSCRIPT_CLIENT_INDEP_TABKEY),
      }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "upsert",
      table: "ZCIND",
      key_fields: ["ZKEY"],
      view: "ZCIND_V",
      master_type: "VDAT",
      allow_cross_client: true,
      corr_nr: "A4HK900001",
      confirm: "ZCIND",
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });
    const section = transportSection(okText(result));
    const tokens = section.split(/\s+/).filter(Boolean);

    // Unlike the client-dependent ZTMD case above, the generated ABAP only prefixes TABKEY with
    // sy-mandt when lv_has_client is true (renderArmed: `clientDependent && mandt !== undefined`) —
    // a client-independent table's transport entry key stays bare even though the transcript below
    // still carries a full IMGW> CLIENT line.
    expect(tokens).toContain("ZTMD");
    expect(tokens).not.toContain("001ZTMD");
  });

  it("a delete also records a CTS entry, and the section renders the same identity/tabkey disclosure", async () => {
    const { conn } = await connected(
      multiBridgeHappyPath({
        preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING),
        apply: () => resp(200, APPLY_TRANSCRIPT_DELETE_TABKEY),
      }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "delete",
      ...BASE_ARGS,
      confirm: "ZTEST_IMGW",
      rows: [{ key: { ZKEY: "A" } }],
    });
    const section = transportSection(okText(result));
    const tokens = section.split(/\s+/).filter(Boolean);

    expect(section).toContain("R3TR TABU ZTEST_IMGW (master VDAT ZTEST_IMGW_V)");
    expect(tokens).toContain("001DELKEY");
  });
});

// ===========================================================================
// Defect G: a live round on 2026-09-05 hit a runtime exception in the apply
// bridge; it printed error lines and wrote nothing, but `abap_img_edit`
// nevertheless answered `ok` with a rows table saying `changed: unknown`, no
// error code, no `mayHaveExecuted`. These pin the fix: no path may answer
// `ok` with an unaccounted-for row, and any apply transcript carrying error
// lines (or missing after-images) must make the tool throw `CHECK_FAILED`.
// ===========================================================================

/** The real apply bridge always emits a runtime exception as an `ERROR` line (see img-write-bridge.ts's `parseImgWriteTranscript`); this one interrupts before any row write is even attempted. */
const APPLY_TRANSCRIPT_ERROR_BEFORE_WRITE =
  `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
  `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
  `IMGW> BVAL row=[1] field=[ZDESC] len=[3] value=[Old]\n` +
  `IMGW> ERROR class=[CX_SY_DYN_CALL_ILLEGAL_TYPE] len=[19] value=[bad table type here]\n`;

/** Same exception, but a `WROTE` marker for row 1 is already on the wire — the row's own MODIFY/DELETE returned `sy-subrc 0` before the bridge blew up (e.g. on a later row, or before COMMIT). */
const APPLY_TRANSCRIPT_ERROR_AFTER_WRITE =
  `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
  `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
  `IMGW> BVAL row=[1] field=[ZDESC] len=[3] value=[Old]\n` +
  `IMGW> WROTE row=[1]\n` +
  `IMGW> ERROR class=[CX_SY_DYN_CALL_ILLEGAL_TYPE] len=[19] value=[bad table type here]\n`;

/** No `ERROR` line at all, and `APPLIED` is reported — but row 1 never got an `AVAL`/`AABSENT` after-image line, so it cannot be classified. Not something the real bridge should ever produce (it dumps an after-image for every row before `APPLIED`), but exactly the shape a truncated/lost response would have. */
const APPLY_TRANSCRIPT_MISSING_AFTER_IMAGE =
  `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
  `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
  `IMGW> BVAL row=[1] field=[ZDESC] len=[3] value=[Old]\n` +
  `IMGW> WROTE row=[1]\n` +
  `IMGW> APPLIED rows=[1]\n`;

/** The (fluid) probe runs cleanly, then the apply invoker's own activation POST reports a real compile error — the fluid-era shape of `test/img-write.test.ts`'s activation-refusal fixture: the body class is shared by both actions and activates fine, so the only per-action activation left to refuse is the apply invoker's. */
function probeOkApplyActivationRefused(): ClassrunHandler {
  return multiBridgeHappyPath(
    { preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING) },
    { refuseActivationOf: "apply" },
  );
}

describe("abap_img_edit — armed apply cannot be silently unaccounted-for (Defect G)", () => {
  it("the apply bridge's own activation refusal propagates unchanged — CHECK_FAILED, bridgeLeftBehind visible, not swallowed or reworded by the tool layer", async () => {
    const { conn, inner } = await connected(probeOkApplyActivationRefused());
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "upsert",
      ...BASE_ARGS,
      confirm: "ZTEST_IMGW",
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });

    const err = errorPayload(result);
    expect(err.error).toBe("CHECK_FAILED");
    expect((err.details as Record<string, unknown> | undefined)?.bridgeLeftBehind).toBe(true);
    // The class left behind is the apply invoker, not the shared body class the probe already ran through.
    expect((err.details as Record<string, unknown> | undefined)?.bridgeClass).toBe(invokerFor(inner, "apply"));
    expect(probeRan(inner)).toBe(true);
    expect(actionRan(inner, "apply")).toBe(false);
  });

  it("a runtime exception before any row write throws CHECK_FAILED with mayHaveExecuted false, and journals the mutation as failed", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(
        multiBridgeHappyPath({
          preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING),
          apply: () => resp(200, APPLY_TRANSCRIPT_ERROR_BEFORE_WRITE),
        }),
      );
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "upsert",
        ...BASE_ARGS,
        confirm: "ZTEST_IMGW",
        rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
      });

      const err = errorPayload(result);
      expect(err.error).toBe("CHECK_FAILED");
      expect((err.details as Record<string, unknown>).mayHaveExecuted).toBe(false);
      expect((err.details as Record<string, unknown>).errors).toEqual(["CX_SY_DYN_CALL_ILLEGAL_TYPE: bad table type here"]);

      const entries = await journal.list({});
      expect(entries).toHaveLength(1);
      expect(entries[0]!.outcome).toBe("failed");
    });
  });

  it("a runtime exception after a row write throws CHECK_FAILED with mayHaveExecuted true (a WROTE marker is on the wire)", async () => {
    const { conn } = await connected(
      multiBridgeHappyPath({
        preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING),
        apply: () => resp(200, APPLY_TRANSCRIPT_ERROR_AFTER_WRITE),
      }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "upsert",
      ...BASE_ARGS,
      confirm: "ZTEST_IMGW",
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });

    const err = errorPayload(result);
    expect(err.error).toBe("CHECK_FAILED");
    expect((err.details as Record<string, unknown>).mayHaveExecuted).toBe(true);
  });

  it("no bridge error line, but a row missing its after-image, still throws CHECK_FAILED rather than answering ok with an unaccounted-for row", async () => {
    const { conn } = await connected(
      multiBridgeHappyPath({
        preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING),
        apply: () => resp(200, APPLY_TRANSCRIPT_MISSING_AFTER_IMAGE),
      }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "upsert",
      ...BASE_ARGS,
      confirm: "ZTEST_IMGW",
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });

    expect(result.isError).toBe(true);
    const err = errorPayload(result);
    expect(err.error).toBe("CHECK_FAILED");
    expect((err.details as Record<string, unknown>).errors).toEqual([]);
  });

  // A normal, fully-accounted-for upsert and delete must still answer `ok` and never throw under
  // this stricter logic — already exercised by "mode: upsert (armed)"'s "happy path" and "delete"
  // tests above (APPLY_TRANSCRIPT_UPSERT / APPLY_TRANSCRIPT_DELETE), which both assert `okText`
  // (implying `isError` is falsy) and remain green under `applyFailure`. Not duplicated here.
});

// ===========================================================================
// Key-only rows (zero value fields): SM30 itself accepts a row on a table
// whose every non-key column is optional (e.g. TB004, key BPKIND, seven
// optional FELDSTLSTn field-status lists) — a live bug once had preview
// silently rendering an empty "SET" for such a row while the identical row
// armed as upsert was refused BAD_INPUT by validateApplyPlan. Preview and
// apply must never disagree again: both now build the SAME ImgApplyPlan and
// run it through the SAME validateApplyPlan before either renders anything.
// ===========================================================================

describe("abap_img_edit — key-only upsert rows (zero value fields is a legal upsert)", () => {
  it("preview shows the new key-only wording, never a dangling empty SET", async () => {
    const { conn } = await connected(
      multiBridgeHappyPath({ preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING) }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      ...BASE_ARGS,
      rows: [{ key: { ZKEY: "A" } }], // no `values` at all — a key-only row
    });
    const text = okText(result);

    expect(text).toContain("key-only row (no value fields); insert if absent, otherwise no change");
    // OLD (buggy) rendering emitted a dangling "SET " with nothing after it for this exact row.
    expect(text).not.toContain("SET");
  });

  it("preview and the armed upsert call refuse the SAME plan-level defect with the SAME BAD_INPUT message", async () => {
    // A value field the probe's own FLD list never declared (ZBOGUS) — a plan-level defect
    // validateApplyPlan has always caught, on both paths. Before this fix, preview never ran
    // validateApplyPlan at all and would have rendered this row instead of refusing it.
    const badRows = [{ key: { ZKEY: "A" }, values: { ZBOGUS: "x" } }];

    const previewConn = await connected(
      multiBridgeHappyPath({ preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING) }),
    );
    const { tools: previewTools } = await registered(previewConn.conn);
    const previewResult = await invoke(previewTools, "abap_img_edit", {
      mode: "preview",
      ...BASE_ARGS,
      rows: badRows,
    });
    const previewErr = errorPayload(previewResult);

    const armedConn = await connected(
      multiBridgeHappyPath({ preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING) }),
    );
    const { tools: armedTools } = await registered(armedConn.conn);
    const armedResult = await invoke(armedTools, "abap_img_edit", {
      mode: "upsert",
      ...BASE_ARGS,
      confirm: "ZTEST_IMGW",
      rows: badRows,
    });
    const armedErr = errorPayload(armedResult);

    expect(previewErr.error).toBe("BAD_INPUT");
    expect(armedErr.error).toBe("BAD_INPUT");
    expect(String(previewErr.message)).toContain("ZBOGUS");
    expect(String(previewErr.message)).toBe(String(armedErr.message));
    // Refused before the apply bridge was ever deployed — the armed call never got past shared
    // validation to reach it either.
    expect(actionRan(armedConn.inner, "apply")).toBe(false);
  });

  it("armed upsert: an absent-before key-only row is reported inserted/changed yes; a present-before key-only row is changed no with 'row exists, no value fields to write'", async () => {
    const APPLY_TRANSCRIPT_KEY_ONLY_MIXED =
      `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
      `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
      `IMGW> BABSENT row=[1]\n` +
      `IMGW> BVAL row=[2] field=[ZKEY] len=[2] value=[A2]\n` +
      `IMGW> BVAL row=[2] field=[ZDESC] len=[3] value=[Old]\n` +
      `IMGW> AVAL row=[1] field=[ZKEY] len=[2] value=[A1]\n` +
      `IMGW> AVAL row=[1] field=[ZDESC] len=[0] value=[]\n` +
      `IMGW> AVAL row=[2] field=[ZKEY] len=[2] value=[A2]\n` +
      `IMGW> AVAL row=[2] field=[ZDESC] len=[3] value=[Old]\n` +
      `IMGW> APPLIED rows=[2]\n`;

    const { conn } = await connected(
      multiBridgeHappyPath({
        preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING),
        apply: () => resp(200, APPLY_TRANSCRIPT_KEY_ONLY_MIXED),
      }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "upsert",
      ...BASE_ARGS,
      confirm: "ZTEST_IMGW",
      rows: [{ key: { ZKEY: "A1" } }, { key: { ZKEY: "A2" } }],
    });
    const text = okText(result);

    // OLD (prior-round) assertions this replaces, before the armed table was widened to also carry
    // the requested change:
    //   expect(text).toContain("changed");
    //   expect(text).toContain("description");
    //   ... row0/row1 checks only asserted "yes"/"inserted" and "no"/"row exists..." — never the
    //   requested-change text itself, so the armed response could say what happened without also
    //   saying what was asked for.
    expect(text).toContain("ROWS WRITTEN");
    expect(text).toContain("changed");
    expect(text).toContain("result");
    expect(text).toContain("inserted");
    expect(text).toContain("row exists, no value fields to write");
    // Both rows are key-only upserts — the requested-change column must carry the same wording
    // prospectiveRowsTable would show in preview (via the shared requestedChangeCell), not just
    // the measured outcome.
    const keyOnlyWording = "key-only row (no value fields); insert if absent, otherwise no change";
    expect(text).toContain(keyOnlyWording);

    // Row 0 (absent before, present after): requested change + changed yes / inserted, together.
    const row0 = text.split("\n").find((l) => l.trim().startsWith("0 "));
    expect(row0).toBeDefined();
    expect(row0).toContain(keyOnlyWording);
    expect(row0).toContain("yes");
    expect(row0).toContain("inserted");

    // Row 1 (present before and after, identical, key-only): requested change + changed no / row
    // exists text, together.
    const row1 = text.split("\n").find((l) => l.trim().startsWith("1 "));
    expect(row1).toBeDefined();
    expect(row1).toContain(keyOnlyWording);
    expect(row1).toContain("no");
    expect(row1).toContain("row exists, no value fields to write");
  });
});

describe("abap_img_edit — before-image row numbering (transcript is 1-based; the journal's row field is not)", () => {
  it("a mixed probe (row 1 present with values, row 2 absent) journals row 0 as existing with those values and row 1 as absent", async () => {
    // img-write-bridge.ts numbers transcript rows 1-based (`rowNo = i + 1`) on both the probe and
    // apply paths. beforeImageFor must look rows up by that 1-based number but still write 0-based
    // `row` values into the journal, matching args.rows[]'s own index (the same convention
    // BAD_INPUT's details.row uses). This pins that against the off-by-one this replaced, which
    // looked BABSENT/BVAL up by the 0-based array index instead and so mis-recorded row 1 (absent)
    // as if it were row 0 (present).
    const MIXED_PROBE_TRANSCRIPT =
      `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
      `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
      `IMGW> FLD table=[ztest_imgw] field=[ZKEY] key=[X] type=[CHAR] len=[10] rollname=[ZKEY]\n` +
      `IMGW> FLD table=[ztest_imgw] field=[ZDESC] key=[] type=[CHAR] len=[40] rollname=[ZDESC]\n` +
      `IMGW> BVAL row=[1] field=[ZKEY] len=[1] value=[A]\n` +
      `IMGW> BVAL row=[1] field=[ZDESC] len=[3] value=[Old]\n` +
      `IMGW> BABSENT row=[2]\n` +
      `IMGW> PROBED rows=[2]\n`;
    const MIXED_APPLY_TRANSCRIPT =
      `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
      `IMGW> TABLE table=[ztest_imgw] delclass=[C] clidep=[X]\n` +
      // The real `apply` action always dumps a before-image (BVAL/BABSENT) for
      // each row before its MODIFY/DELETE — matching the probe's before-state here (row 1
      // present, row 2 absent), since nothing else wrote between the probe and the apply.
      `IMGW> BVAL row=[1] field=[ZKEY] len=[1] value=[A]\n` +
      `IMGW> BVAL row=[1] field=[ZDESC] len=[3] value=[Old]\n` +
      `IMGW> BABSENT row=[2]\n` +
      `IMGW> AVAL row=[1] field=[ZKEY] len=[1] value=[A]\n` +
      `IMGW> AVAL row=[1] field=[ZDESC] len=[3] value=[Old]\n` +
      `IMGW> AVAL row=[2] field=[ZKEY] len=[1] value=[B]\n` +
      `IMGW> AVAL row=[2] field=[ZDESC] len=[3] value=[New]\n` +
      `IMGW> APPLIED rows=[2]\n`;

    await withJournal(async (journal) => {
      const { conn } = await connected(
        multiBridgeHappyPath({
          preview: () => resp(200, MIXED_PROBE_TRANSCRIPT),
          apply: () => resp(200, MIXED_APPLY_TRANSCRIPT),
        }),
      );
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "upsert",
        ...BASE_ARGS,
        confirm: "ZTEST_IMGW",
        rows: [
          { key: { ZKEY: "A" }, values: { ZDESC: "Old" } },
          { key: { ZKEY: "B" }, values: { ZDESC: "New" } },
        ],
      });
      okText(result);

      const entries = await journal.list({});
      expect(entries).toHaveLength(1);
      const e = entries[0]!;
      expect(e.existedBefore).toBe(true);
      expect(e.beforeCapture).toBe("captured");

      const before = await journal.beforeImage(e);
      expect(before).toBeDefined();
      const parsed = JSON.parse(before ?? "{}") as { table: string; rows: Array<Record<string, unknown>> };
      expect(parsed.rows).toEqual([
        { row: 0, existed: true, values: { ZKEY: "A", ZDESC: "Old" } },
        { row: 1, existed: false },
      ]);
    });
  });
});

// ===========================================================================

describe("abap_img_edit — policy refusal short-circuits before any deploy", () => {
  it("a read-only safety gate refuses at the config-only pre-check, before ensureConnected or any network call", async () => {
    const { conn, inner } = await connected(
      multiBridgeHappyPath({ preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING) }),
    );
    const { tools } = await registered(conn, { safety: readOnlyGate() });

    const result = await invoke(tools, "abap_img_edit", {
      mode: "upsert",
      ...BASE_ARGS,
      confirm: "ZTEST_IMGW",
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });

    expect(errorPayload(result).error).toBe("SAFETY_DENIED");
    expect(inner.calls).toHaveLength(0);
  });

  it("the same short-circuit applies to preview, not only to armed modes", async () => {
    const { conn, inner } = await connected(
      multiBridgeHappyPath({ preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING) }),
    );
    const { tools } = await registered(conn, { safety: readOnlyGate() });

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      ...BASE_ARGS,
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });

    expect(errorPayload(result).error).toBe("SAFETY_DENIED");
    expect(inner.calls).toHaveLength(0);
  });
});

// ===========================================================================

describe("abap_img_edit — scaffold-level failure", () => {
  it("the probe bridge's classrun POST 500ing surfaces as an error, not a silent empty preview", async () => {
    const { conn } = await connected(multiBridgeHappyPath({ preview: classrunBlowsUp }));
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      ...BASE_ARGS,
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });

    expect(result.isError).toBe(true);
  });
});

// ===========================================================================

describe("abap_img_edit — mode: create_request", () => {
  it("mints a customizing request, returns its number, and journals it as `transport-create`", async () => {
    await withJournal(async (journal) => {
      const { conn, inner } = await connected(
        multiBridgeHappyPath({ create_request: () => resp(200, CREATE_REQUEST_TRANSCRIPT) }),
      );
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "create_request",
        description: "Test customizing request",
        owner: "TESTUSER",
      });
      const text = okText(result);

      expect(text).toContain("mode: create_request");
      expect(text).toContain("A4HK900002");
      expect(text).toContain("A4HK900003");
      expect(actionRan(inner, "create_request")).toBe(true);

      const entries = await journal.list({});
      expect(entries).toHaveLength(1);
      expect(entries[0]!.operation).toBe("transport-create");
      expect(entries[0]!.object.name).toBe("A4HK900002");
      expect(entries[0]!.existedBefore).toBe(false);
      expect(entries[0]!.beforeCapture).toBe("confirmed-absent");
      expect(entries[0]!.outcome).toBe("succeeded");
    });
  });

  it("renders the created task's type (A3) when the transcript carries a TASKTYPE line", async () => {
    const { conn } = await connected(
      multiBridgeHappyPath({ create_request: () => resp(200, CREATE_REQUEST_TRANSCRIPT_WITH_TASKTYPE) }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "create_request",
      description: "Task-type description",
    });
    const text = okText(result);

    expect(text).toContain("A4HK900003");
    expect(text).toContain("taskType: K");
    expect(text).toContain("(task A4HK900003, type K)");
  });

  it("omits the task type cleanly (A3) when the transcript carries no TASKTYPE line", async () => {
    const { conn } = await connected(
      multiBridgeHappyPath({ create_request: () => resp(200, CREATE_REQUEST_TRANSCRIPT) }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "create_request",
      description: "No-task-type description",
    });
    const text = okText(result);

    expect(text).toContain("(task A4HK900003)");
    expect(text).not.toContain("taskType:");
    expect(text).not.toContain(", type");
  });

  it("rejects a row-edit-only field (table) with BAD_INPUT before any network call", async () => {
    const { conn, inner } = await connected(
      multiBridgeHappyPath({ create_request: () => resp(200, CREATE_REQUEST_TRANSCRIPT) }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "create_request",
      description: "x",
      table: "ZTEST_IMGW",
    });

    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(inner.calls).toHaveLength(0);
  });

  it("a transcript with no request number is CHECK_FAILED, names the description, and points at abap_transport list", async () => {
    const { conn } = await connected(
      multiBridgeHappyPath({ create_request: () => resp(200, NO_TASK_ERROR_NO_NUMBER_TRANSCRIPT) }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "create_request",
      description: "Orphan-check description",
    });
    const err = errorPayload(result);

    expect(err.error).toBe("CHECK_FAILED");
    const message = String(err.message);
    expect(message).toContain("Orphan-check description");
    expect(message).toContain("may nonetheless have been created");
    expect(message).toContain("abap_transport list");
    expect((err.details as Record<string, unknown> | undefined)?.description).toBe("Orphan-check description");
  });

  it("journals a suspected-orphan entry (failed, non-numeric placeholder name) when no request number came back", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(
        multiBridgeHappyPath({ create_request: () => resp(200, NO_TASK_ERROR_NO_NUMBER_TRANSCRIPT) }),
      );
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "create_request",
        description: "Orphan-journal description",
      });
      expect(errorPayload(result).error).toBe("CHECK_FAILED");

      const entries = await journal.list({});
      expect(entries).toHaveLength(1);
      expect(entries[0]!.operation).toBe("transport-create");
      expect(entries[0]!.outcome).toBe("failed");
      expect(entries[0]!.object.description).toBe("Orphan-journal description");
      // Deliberately non-numeric/non-transport-shaped: never mistakable for a real trkorr.
      expect(entries[0]!.object.name).toBe("(unknown)");
      expect(entries[0]!.object.name).not.toMatch(/^[A-Z0-9]{3}K?\d{6}$/);
    });
  });

  it("any bridge error line is CHECK_FAILED even alongside a parsed request number", async () => {
    const { conn } = await connected(
      multiBridgeHappyPath({ create_request: () => resp(200, REQUEST_PLUS_SCAFFOLD_ERROR_TRANSCRIPT) }),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "create_request",
      description: "Scaffold-error description",
    });

    expect(errorPayload(result).error).toBe("CHECK_FAILED");
  });

  it("the NO_TASK *warning* path succeeds, surfaces the request number, and journals it as succeeded", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(
        multiBridgeHappyPath({ create_request: () => resp(200, REQUEST_PLUS_NO_TASK_WARNING_TRANSCRIPT) }),
      );
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "create_request",
        description: "Warning-path description",
      });
      const text = okText(result);

      expect(text).toContain("A4HK900002");
      expect(text.toLowerCase()).toContain("task");

      const entries = await journal.list({});
      expect(entries).toHaveLength(1);
      expect(entries[0]!.operation).toBe("transport-create");
      expect(entries[0]!.outcome).toBe("succeeded");
      expect(entries[0]!.object.name).toBe("A4HK900002");
    });
  });
});

// ===========================================================================
// ABAP_ALLOW_TRANSPORTS=auto (issue #176): under `auto`, abap_img_edit may accept a caller-named
// corr_nr this session itself created (via create_request or abap_transport create), and — when
// corr_nr is omitted and a transport is genuinely required — resolve one itself: reuse a request
// this session already minted for the same kind (customizing for a client-dependent table,
// workbench for a client-independent one), or mint a new one through the same create_request
// bridge. Deny-all (`allowTransports: []`) and an explicit non-"auto" allowlist are unchanged by any
// of this — see the existing corr-nr-required/corr-nr-not-allowed tests elsewhere in this file.
// ===========================================================================

describe("abap_img_edit — ABAP_ALLOW_TRANSPORTS=auto (issue #176)", () => {
  describe("create_request: request_type", () => {
    it('request_type: "workbench" sends requestType K, renders it, and notes the session created the request', async () => {
      const { conn, inner } = await connected(
        multiBridgeHappyPath({ create_request: () => resp(200, CREATE_REQUEST_TRANSCRIPT_SESSION) }),
      );
      const transport = fakeTransport();
      const { tools } = await registered(conn, { transport });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "create_request",
        description: "Workbench request",
        request_type: "workbench",
      });
      const text = okText(result);

      expect(text).toContain("requestType: workbench");
      expect(text).toContain("A4HK900050");

      const put = inner.calls.find(
        (c) =>
          (c.method ?? "GET").toUpperCase() === "PUT" &&
          INVOKER_SOURCE_URL_RE.test(c.url) &&
          invokerActionOf(c.body) === "create_request",
      );
      expect(put).toBeDefined();
      const args = JSON.parse(invokerArgsJson(String(put!.body))) as { request_type?: string };
      expect(args.request_type).toBe("K");

      expect(transport!.createdThisSession("A4HK900050")).toBe(true);
    });

    it("default (no request_type) sends requestType W, and still notes the session created the request", async () => {
      const { conn, inner } = await connected(
        multiBridgeHappyPath({ create_request: () => resp(200, CREATE_REQUEST_TRANSCRIPT) }),
      );
      const transport = fakeTransport();
      const { tools } = await registered(conn, { transport });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "create_request",
        description: "Default request",
      });
      const text = okText(result);

      expect(text).toContain("requestType: customizing");

      const put = inner.calls.find(
        (c) =>
          (c.method ?? "GET").toUpperCase() === "PUT" &&
          INVOKER_SOURCE_URL_RE.test(c.url) &&
          invokerActionOf(c.body) === "create_request",
      );
      const args = JSON.parse(invokerArgsJson(String(put!.body))) as { request_type?: string };
      expect(args.request_type).toBe("W");

      expect(transport!.createdThisSession("A4HK900002")).toBe(true);
    });

    it("rejects request_type on a row-edit mode (upsert) with BAD_INPUT before any network call", async () => {
      const { conn, inner } = await connected(
        multiBridgeHappyPath({
          preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING),
          apply: () => resp(200, APPLY_TRANSCRIPT_UPSERT),
        }),
      );
      const { tools } = await registered(conn);

      const result = await invoke(tools, "abap_img_edit", {
        mode: "upsert",
        ...BASE_ARGS,
        confirm: "ZTEST_IMGW",
        rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
        request_type: "workbench",
      });

      expect(errorPayload(result).error).toBe("BAD_INPUT");
      expect(inner.calls).toHaveLength(0);
    });
  });

  describe("armed upsert, corr_nr omitted, recording required: this session resolves one", () => {
    const today = new Date().toISOString().slice(0, 10);

    it("client-dependent table (CCCORACTIV=1): mints a customizing request, applies, and discloses session-created", async () => {
      await withJournal(async (journal) => {
        const { conn, inner } = await connected(
          multiBridgeHappyPath({
            preview: () => resp(200, PROBE_TRANSCRIPT_CORR_REQUIRED),
            create_request: () => resp(200, CREATE_REQUEST_TRANSCRIPT_SESSION),
            apply: () => resp(200, APPLY_TRANSCRIPT_UPSERT),
          }),
        );
        const transport = fakeTransport();
        const { tools } = await registered(conn, { safety: autoGate(), transport, journal });

        const result = await invoke(tools, "abap_img_edit", {
          mode: "upsert",
          ...BASE_ARGS_NO_CORR,
          confirm: "ZTEST_IMGW",
          rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
        });
        const text = okText(result);

        expect(text).toContain(
          "corr_nr was not supplied; this session recorded on A4HK900050 (customizing request created now).",
        );
        expect(text).toContain("corrNrSource: session-created");
        expect(transport!.createdThisSession("A4HK900050")).toBe(true);

        const createPut = inner.calls.find(
          (c) =>
            (c.method ?? "GET").toUpperCase() === "PUT" &&
            INVOKER_SOURCE_URL_RE.test(c.url) &&
            invokerActionOf(c.body) === "create_request",
        );
        expect(createPut).toBeDefined();
        const createArgs = JSON.parse(invokerArgsJson(String(createPut!.body))) as {
          description?: string;
          request_type?: string;
        };
        expect(createArgs.description).toBe(`abapsmith customizing request ${today}`);
        expect(createArgs.request_type).toBe("W");

        const entries = await journal.list({});
        const rowEntry = entries.find((e) => e.operation === "update");
        expect(rowEntry).toBeDefined();
        expect(rowEntry!.trSource).toBe("session-created");
      });
    });

    it("client-independent table: mints a workbench request, applies, and discloses session-created", async () => {
      const { conn, inner } = await connected(
        multiBridgeHappyPath({
          preview: () => resp(200, PROBE_TRANSCRIPT_CLIENT_INDEP),
          create_request: () => resp(200, CREATE_REQUEST_TRANSCRIPT_SESSION),
          apply: () => resp(200, APPLY_TRANSCRIPT_CLIENT_INDEP_TABKEY),
        }),
      );
      const transport = fakeTransport();
      const { tools } = await registered(conn, { safety: autoGate(), transport });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "upsert",
        table: "ZCIND",
        key_fields: ["ZKEY"],
        view: "ZCIND_V",
        master_type: "VDAT",
        allow_cross_client: true,
        confirm: "ZCIND",
        rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
      });
      const text = okText(result);

      expect(text).toContain(
        "corr_nr was not supplied; this session recorded on A4HK900050 (workbench request created now).",
      );
      expect(text).toContain("corrNrSource: session-created");
      expect(transport!.createdThisSession("A4HK900050")).toBe(true);

      const createPut = inner.calls.find(
        (c) =>
          (c.method ?? "GET").toUpperCase() === "PUT" &&
          INVOKER_SOURCE_URL_RE.test(c.url) &&
          invokerActionOf(c.body) === "create_request",
      );
      const createArgs = JSON.parse(invokerArgsJson(String(createPut!.body))) as {
        description?: string;
        request_type?: string;
      };
      expect(createArgs.description).toBe(`abapsmith workbench request ${today}`);
      expect(createArgs.request_type).toBe("K");
    });

    it("a request already cached from an earlier create_request call in this session is reused, not recreated", async () => {
      const { conn, inner } = await connected(
        multiBridgeHappyPath({
          create_request: () => resp(200, CREATE_REQUEST_TRANSCRIPT_SESSION),
          preview: () => resp(200, PROBE_TRANSCRIPT_CORR_REQUIRED),
          apply: () => resp(200, APPLY_TRANSCRIPT_UPSERT),
        }),
      );
      const transport = fakeTransport();
      const { tools } = await registered(conn, { safety: autoGate(), transport });

      const createResult = await invoke(tools, "abap_img_edit", {
        mode: "create_request",
        description: "Pre-minted customizing request",
      });
      okText(createResult);

      const createRequestPuts = () =>
        inner.calls.filter(
          (c) =>
            (c.method ?? "GET").toUpperCase() === "PUT" &&
            INVOKER_SOURCE_URL_RE.test(c.url) &&
            invokerActionOf(c.body) === "create_request",
        ).length;
      expect(createRequestPuts()).toBe(1);

      const result = await invoke(tools, "abap_img_edit", {
        mode: "upsert",
        ...BASE_ARGS_NO_CORR,
        confirm: "ZTEST_IMGW",
        rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
      });
      const text = okText(result);

      expect(text).toContain(
        "corr_nr was not supplied; this session recorded on A4HK900050 (customizing request created earlier in this session).",
      );
      expect(text).toContain("corrNrSource: session-cached");
      // No second create_request invoker was ever written — the cache short-circuited resolution.
      expect(createRequestPuts()).toBe(1);
    });
  });

  describe("named corr_nr under auto", () => {
    it("a named corr_nr this session created is accepted, applies, and shows corrNrSource caller", async () => {
      const { conn, inner } = await connected(
        multiBridgeHappyPath({
          preview: () => resp(200, PROBE_TRANSCRIPT_CORR_REQUIRED),
          apply: () => resp(200, APPLY_TRANSCRIPT_UPSERT),
        }),
      );
      const transport = fakeTransport();
      transport!.noteCreated("A4HK900077");
      const { tools } = await registered(conn, { safety: autoGate(), transport });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "upsert",
        ...BASE_ARGS_NO_CORR,
        corr_nr: "A4HK900077",
        confirm: "ZTEST_IMGW",
        rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
      });
      const text = okText(result);

      expect(text).toContain("corrNrSource: caller");
      expect(text).toContain("A4HK900077");
      expect(actionRan(inner, "apply")).toBe(true);
    });

    it("a named corr_nr this session does not know is refused SAFETY_DENIED/corr-nr-not-allowed, before any apply deploy", async () => {
      const { conn, inner } = await connected(
        multiBridgeHappyPath({
          preview: () => resp(200, PROBE_TRANSCRIPT_CORR_REQUIRED),
          apply: () => resp(200, APPLY_TRANSCRIPT_UPSERT),
        }),
      );
      const transport = fakeTransport();
      const { tools } = await registered(conn, { safety: autoGate(), transport });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "upsert",
        ...BASE_ARGS_NO_CORR,
        corr_nr: "A4HK900099",
        confirm: "ZTEST_IMGW",
        rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
      });
      const err = errorPayload(result);

      expect(err.error).toBe("SAFETY_DENIED");
      expect((err.details as Record<string, unknown>).rule).toBe("corr-nr-not-allowed");
      expect(actionRan(inner, "apply")).toBe(false);
    });
  });

  describe("preview under auto, corr_nr omitted", () => {
    it("no cached request: says a new request would be created, and creates nothing", async () => {
      const { conn, inner } = await connected(
        multiBridgeHappyPath({ preview: () => resp(200, PROBE_TRANSCRIPT_CORR_REQUIRED) }),
      );
      const transport = fakeTransport();
      const { tools } = await registered(conn, { safety: autoGate(), transport });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "preview",
        ...BASE_ARGS_NO_CORR,
        rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
      });
      const text = okText(result);

      expect(text).toContain("Applying this change would create a new customizing request");
      expect(actionRan(inner, "create_request")).toBe(false);
    });

    it("a cached request: names it instead of promising a new one", async () => {
      const { conn, inner } = await connected(
        multiBridgeHappyPath({
          create_request: () => resp(200, CREATE_REQUEST_TRANSCRIPT_SESSION),
          preview: () => resp(200, PROBE_TRANSCRIPT_CORR_REQUIRED),
        }),
      );
      const transport = fakeTransport();
      const { tools } = await registered(conn, { safety: autoGate(), transport });

      const createResult = await invoke(tools, "abap_img_edit", {
        mode: "create_request",
        description: "Pre-minted for preview",
      });
      okText(createResult);

      const result = await invoke(tools, "abap_img_edit", {
        mode: "preview",
        ...BASE_ARGS_NO_CORR,
        rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
      });
      const text = okText(result);

      expect(text).toContain(
        "Applying this change would record on A4HK900050 (customizing request known to this session).",
      );
      expect(actionRan(inner, "apply")).toBe(false);
    });
  });

  it("deny-all (allowTransports []) with corr_nr omitted and required: refused corr-nr-required, no transport calls", async () => {
    const { conn, inner } = await connected(
      multiBridgeHappyPath({ preview: () => resp(200, PROBE_TRANSCRIPT_CORR_REQUIRED) }),
    );
    const transport = fakeTransport();
    const { tools } = await registered(conn, { safety: denyAllTransportsGate(), transport });

    const result = await invoke(tools, "abap_img_edit", {
      mode: "upsert",
      ...BASE_ARGS_NO_CORR,
      confirm: "ZTEST_IMGW",
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });
    const err = errorPayload(result);

    expect(err.error).toBe("SAFETY_DENIED");
    expect((err.details as Record<string, unknown>).rule).toBe("corr-nr-required");
    expect(actionRan(inner, "create_request")).toBe(false);
    expect(actionRan(inner, "apply")).toBe(false);
  });
});

// ===========================================================================
// Language default/validation (A1): the catalog SPRAS columns this tool
// eventually reads through are one character wide — a 2-letter ISO code
// like "EN" is rejected by `assertImgLanguage`, not silently accepted or
// mapped. `runImgEditTool` casts its raw args without ever running the zod
// schema (see registerImgEditTools's own handler), so a schema-only fix
// would not actually protect a real call — these tests pin the
// `assertImgLanguage` call inside `parseRowEditArgs` itself.
// ===========================================================================

describe("abap_img_edit — language default and validation", () => {
  it('rejects `language: "EN"` with BAD_INPUT, before any network call — pins assertImgLanguage, not just the zod schema', async () => {
    const { conn, inner } = await connected(multiBridgeHappyPath({}));
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      ...BASE_ARGS,
      language: "EN",
      rows: [{ key: { ZKEY: "A" } }],
    });
    const err = errorPayload(result);

    expect(err.error).toBe("BAD_INPUT");
    expect(String(err.message)).toContain("EN");
    expect(String(err.message)).toContain("SPRAS");
    expect(inner.calls).toHaveLength(0);
  });

  it('rejects `cfg.language = "EN"` (e.g. an operator-set ABAP_LANGUAGE=EN) with BAD_INPUT even with no `language` input at all', async () => {
    const { conn, inner } = await connected(multiBridgeHappyPath({}));
    const { tools } = await registered(conn, { language: "EN" });

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      ...BASE_ARGS,
      rows: [{ key: { ZKEY: "A" } }],
    });
    const err = errorPayload(result);

    expect(err.error).toBe("BAD_INPUT");
    expect(String(err.message)).toContain("EN");
    expect(inner.calls).toHaveLength(0);
  });
});

// ===========================================================================
// Cold-process role verdict before the gate (A2): `ensureRoleVerdict` mirrors
// `abap_write`'s ordering (preflight() then ensureConnected()) so a fresh
// process's first call is not refused by the fail-closed `undefined` state
// of `writesLockedOut` — see `ensureRoleVerdict`'s own doc comment in
// src/tools/img-edit.ts.
// ===========================================================================

describe("abap_img_edit — cold-process role verdict runs before the write-lockout gate", () => {
  it("writesLockedOut UNSET: a preview calls ensureConnected BEFORE the policy verdict is taken, and is not refused", async () => {
    const { conn } = await connected(
      multiBridgeHappyPath({ preview: () => resp(200, PROBE_TRANSCRIPT_EXISTING) }),
    );
    // Deliberately omits `writesLockedOut` — the exact state a fresh process's SafetyGate starts in
    // before any call has ever connected.
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"] });
    expect(gate.config.writesLockedOut).toBeUndefined();

    let ensureConnectedCalls = 0;
    const { tools } = await registered(conn, {
      safety: gate,
      ensureConnected: async () => {
        ensureConnectedCalls += 1;
        // Stand-in for server.ts's real ensureConnected: transcribes a T000 role-probe verdict
        // proving the system non-productive.
        gate.update({ writesLockedOut: false, productive: false, systemRole: "development" });
      },
    });

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      ...BASE_ARGS,
      rows: [{ key: { ZKEY: "A" }, values: { ZDESC: "New" } }],
    });

    expect(ensureConnectedCalls).toBeGreaterThan(0);
    const text = okText(result);
    expect(text).toContain("mode: preview");
  });

  it("writesLockedOut already TRUE: ensureConnected is NOT called, and the refusal still happens with rule write-lockout", async () => {
    const { conn, inner } = await connected(multiBridgeHappyPath({}));
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["*"],
      allowNamePrefixes: ["*"],
      writesLockedOut: true,
      lockoutReason: "test: this system was already proven productive",
    });

    let ensureConnectedCalls = 0;
    const { tools } = await registered(conn, {
      safety: gate,
      ensureConnected: async () => {
        ensureConnectedCalls += 1;
      },
    });

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      ...BASE_ARGS,
      rows: [{ key: { ZKEY: "A" } }],
    });
    const err = errorPayload(result);

    expect(err.error).toBe("SAFETY_DENIED");
    expect((err.details as Record<string, unknown>).rule).toBe("write-lockout");
    expect(ensureConnectedCalls).toBe(0);
    // Refused before the probe bridge was ever deployed.
    expect(inner.calls).toHaveLength(0);
  });
});

// ===========================================================================
// Consultant-facing selectors: `activity` / `object` resolution (Task 1).
// ===========================================================================

describe("abap_img_edit — target selection (activity / object / table)", () => {
  it("rejects when none of activity/object/table is given, naming all three, before any network call", async () => {
    const { conn, inner } = await connected(multiBridgeHappyPath({}));
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      rows: [{ key: { ZKEY: "A" } }],
    });
    const err = errorPayload(result);

    expect(err.error).toBe("BAD_INPUT");
    expect(String(err.message)).toContain("activity");
    expect(String(err.message)).toContain("object");
    expect(String(err.message)).toContain("table");
    expect(inner.calls).toHaveLength(0);
  });

  it("rejects when more than one of activity/object/table is given, naming which, before any network call", async () => {
    const { conn, inner } = await connected(multiBridgeHappyPath({}));
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      object: "TB004",
      table: "ZTEST_IMGW",
      rows: [{ key: { ZKEY: "A" } }],
    });
    const err = errorPayload(result);

    expect(err.error).toBe("BAD_INPUT");
    expect(String(err.message)).toContain("object");
    expect(String(err.message)).toContain("table");
    expect(inner.calls).toHaveLength(0);
  });

  it("`key_fields` conflicts with `activity` — key fields are derived, not supplied — before any network call", async () => {
    const { conn, inner } = await connected(multiBridgeHappyPath({}));
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      activity: "ZACT1",
      key_fields: ["ZKEY"],
      rows: [{ key: { ZKEY: "A" } }],
    });
    const err = errorPayload(result);

    expect(err.error).toBe("BAD_INPUT");
    expect(String(err.message)).toContain("key_fields");
    expect(String(err.message)).toContain("activity");
    expect(inner.calls).toHaveLength(0);
  });

  it("`client_field` conflicts with `object` — the client field is derived, not supplied — before any network call", async () => {
    const { conn, inner } = await connected(multiBridgeHappyPath({}));
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      object: "TB004",
      client_field: "MANDT",
      rows: [{ key: { ZKEY: "A" } }],
    });
    const err = errorPayload(result);

    expect(err.error).toBe("BAD_INPUT");
    expect(String(err.message)).toContain("client_field");
    expect(String(err.message)).toContain("object");
    expect(inner.calls).toHaveLength(0);
  });

  it("a read-only safety gate refuses the activity/object path before the resolution read is ever issued", async () => {
    const { conn, inner } = await connected(multiBridgeHappyPath({}));
    const { tools } = await registered(conn, { safety: readOnlyGate() });

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      activity: "ZACT1",
      rows: [{ key: { ZFLD: "A" } }],
    });
    const err = errorPayload(result);

    expect(err.error).toBe("SAFETY_DENIED");
    // Not one single freestyle/classrun call was made — the config-only check ran before
    // deps.ensureConnected() and before the pool.withRead() resolution callback.
    expect(inner.calls).toHaveLength(0);
  });

  describe("resolving from `object` (TB004-shaped: a CLIENT field that is not literally named MANDT)", () => {
    // DD02L: delivery-class query. Minimal columns, same shape the existing img-read.test.ts fixtures use.
    const tb004DcBody = body({ TABNAME: ["TB004"], CONTFLAG: ["C"], CLIDEP: ["X"] });
    const tb004TextBody = body({ TABNAME: ["TB004"], DDTEXT: ["Sequence number ranges"] });
    // The client key field is named CLIENT, not MANDT — splitClientField must pick it out by
    // DATATYPE=CLNT, never by a hardcoded field name.
    const tb004FieldsBody = body({
      TABNAME: ["TB004", "TB004", "TB004"],
      FIELDNAME: ["CLIENT", "SEQNR", "TEXT1"],
      POSITION: ["0001", "0002", "0003"],
      KEYFLAG: ["X", "X", ""],
      DATATYPE: ["CLNT", "NUMC", "CHAR"],
      LENG: ["000003", "000003", "000040"],
      ROLLNAME: ["MANDT", "TB004_SEQNR", "TEXT40"],
    });
    // fillTable succeeds fully in 3 calls; resolveTableFromObjectName then unconditionally re-reads
    // the same table a second time (the only fillX that returns real per-field key/type data) — 6 total.
    const TB004_IMG_BODIES = [tb004DcBody, tb004TextBody, tb004FieldsBody, tb004DcBody, tb004TextBody, tb004FieldsBody];

    const PROBE_TRANSCRIPT_TB004 =
      `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
      `IMGW> TABLE table=[TB004] delclass=[C] clidep=[X]\n` +
      `IMGW> FLD table=[TB004] field=[SEQNR] key=[X] type=[NUMC] len=[3] rollname=[TB004_SEQNR]\n` +
      `IMGW> FLD table=[TB004] field=[TEXT1] key=[] type=[CHAR] len=[40] rollname=[TEXT40]\n` +
      `IMGW> BVAL row=[1] field=[SEQNR] len=[3] value=[001]\n` +
      `IMGW> BVAL row=[1] field=[TEXT1] len=[3] value=[Old]\n` +
      `IMGW> PROBED rows=[1]\n`;

    it("resolves `object` + `kind: table` to TB004, derives CLIENT (not MANDT) as the client field, and renders a RESOLVED section naming the base table", async () => {
      const route = resolutionRoute(TB004_IMG_BODIES, { preview: () => resp(200, PROBE_TRANSCRIPT_TB004) });
      const { conn, inner } = await connected(route);
      const { tools } = await registered(conn);

      const result = await invoke(tools, "abap_img_edit", {
        mode: "preview",
        object: "TB004",
        kind: "table",
        rows: [{ key: { SEQNR: "001" }, values: { TEXT1: "New" } }],
      });
      const text = okText(result);

      expect(text).toContain("--- RESOLVED ---");
      expect(text).toContain('Input: object "TB004"');
      expect(text).toContain("Object: TB004 (table)");
      expect(text).toContain("Base table: TB004");
      expect(text).toContain("Key fields (in order): SEQNR");
      expect(text).toContain("Client field: CLIENT");
      // Preview's arming line plainly names the resolved base table.
      expect(text).toContain("TABU TB004");

      expect(probeRan(inner)).toBe(true);
      expect(actionRan(inner, "apply")).toBe(false);
    });

    it('with no `language` input and `cfg.language` = "", the DD02T text read embeds the default SAP key "E" (never the rejected ISO code "EN"), and the rendered header echoes it', async () => {
      const route = resolutionRoute(TB004_IMG_BODIES, { preview: () => resp(200, PROBE_TRANSCRIPT_TB004) });
      const { conn, inner } = await connected(route);
      const { tools } = await registered(conn, { language: "" });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "preview",
        object: "TB004",
        kind: "table",
        rows: [{ key: { SEQNR: "001" }, values: { TEXT1: "New" } }],
      });
      const text = okText(result);

      // What the tool actually rendered, not an internal variable.
      expect(text).toContain("language: E");

      // What actually went out on the wire: the DD02T table-text read (buildTableTextsQuery)
      // embeds DDLANGUAGE as a SQL literal — this is the query that answered `HTTP 400 'EN' is
      // not a valid value for C(1,0)` live when the caller/default was "EN".
      const textQuery = inner.calls.find((c) => typeof c.body === "string" && c.body.includes("FROM DD02T"));
      expect(textQuery).toBeDefined();
      expect(String(textQuery!.body)).toContain("DDLANGUAGE = 'E'");
      expect(String(textQuery!.body)).not.toContain("DDLANGUAGE = 'EN'");
    });

    it("an object/kind combination that does not resolve at all throws NOT_FOUND pointing at abap_img search/objects", async () => {
      // DD02L comes back empty — TB999 is not a real table.
      const route = resolutionRoute([emptyBody()], {});
      const { conn, inner } = await connected(route);
      const { tools } = await registered(conn);

      const result = await invoke(tools, "abap_img_edit", {
        mode: "preview",
        object: "TB999",
        kind: "table",
        rows: [{ key: { SEQNR: "001" } }],
      });
      const err = errorPayload(result);

      expect(err.error).toBe("NOT_FOUND");
      expect(String(err.message)).toContain("abap_img search");
      expect(probeRan(inner)).toBe(false);
    });

    it("an object resolving to zero base tables (an empty view cluster) reaches evaluateImgWrite rule 4 as ambiguous-target", async () => {
      const clusterHeaderBody = body({ VCLNAME: ["ZVCL1"] });
      const clusterTextBody = body({ VCLNAME: ["ZVCL1"], TEXT: ["Empty Cluster"] });
      const clusterMembersBody = emptyBody();
      const route = resolutionRoute([clusterHeaderBody, clusterTextBody, clusterMembersBody], {});
      const { conn, inner } = await connected(route);
      const { tools } = await registered(conn);

      const result = await invoke(tools, "abap_img_edit", {
        mode: "preview",
        object: "ZVCL1",
        kind: "cluster",
        rows: [{ key: { ZKEY: "A" } }],
      });
      const err = errorPayload(result);

      expect(err.error).toBe("SAFETY_DENIED");
      expect((err.details as Record<string, unknown>).rule).toBe("ambiguous-target");
      expect(String(err.message)).toContain("no known base table");
      expect(probeRan(inner)).toBe(false);
    });

    it("an object resolving to more than one base table reaches evaluateImgWrite rule 4 as ambiguous-target", async () => {
      const viewHeaderBody = body({ VIEWNAME: ["ZVIEW2"], AGGTYPE: [""], ROOTTAB: [""] });
      const viewTextBody = body({ VIEWNAME: ["ZVIEW2"], DDTEXT: ["View spanning two tables"] });
      const viewBaseTablesBody = body({ VIEWNAME: ["ZVIEW2", "ZVIEW2"], TABNAME: ["ZTABA", "ZTABB"], TABPOS: ["0001", "0002"] });
      const viewDcBody = body({ TABNAME: ["ZTABA", "ZTABB"], CONTFLAG: ["C", "C"], CLIDEP: ["X", "X"] });
      const viewFieldsBody = emptyBody();
      const route = resolutionRoute([viewHeaderBody, viewTextBody, viewBaseTablesBody, viewDcBody, viewFieldsBody], {});
      const { conn, inner } = await connected(route);
      const { tools } = await registered(conn);

      const result = await invoke(tools, "abap_img_edit", {
        mode: "preview",
        object: "ZVIEW2",
        kind: "view",
        rows: [{ key: { ZKEY: "A" } }],
      });
      const err = errorPayload(result);

      expect(err.error).toBe("SAFETY_DENIED");
      expect((err.details as Record<string, unknown>).rule).toBe("ambiguous-target");
      expect(String(err.message)).toContain("spans 2 base tables");
      expect(String(err.message)).toMatch(/ZTABA/);
      expect(String(err.message)).toMatch(/ZTABB/);
      expect(probeRan(inner)).toBe(false);
    });

    // issue #176: splitClientField's CLNT-typed-field derivation has no field to find on a table
    // with no CLNT component at all. For a client-independent table that is not a refusal — there is
    // no client to strip, so the bridge writes with a MANDT placeholder and every key field stays a
    // key field. For a client-dependent table it is still BAD_INPUT: DD02L says the table needs a
    // client, but nothing in the field list says which one that is.
    const zcitDcBody = body({ TABNAME: ["ZCIT"], CONTFLAG: ["C"], CLIDEP: [""] });
    const zcitTextBody = body({ TABNAME: ["ZCIT"], DDTEXT: ["Client-independent, no CLNT field"] });
    const zcitFieldsBody = body({
      TABNAME: ["ZCIT", "ZCIT"],
      FIELDNAME: ["ZKEY", "ZDESC"],
      POSITION: ["0001", "0002"],
      KEYFLAG: ["X", ""],
      DATATYPE: ["CHAR", "CHAR"],
      LENG: ["000010", "000040"],
      ROLLNAME: ["ZKEY", "ZDESC"],
    });
    const ZCIT_IMG_BODIES = [zcitDcBody, zcitTextBody, zcitFieldsBody, zcitDcBody, zcitTextBody, zcitFieldsBody];

    const PROBE_TRANSCRIPT_ZCIT =
      `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
      `IMGW> TABLE table=[ZCIT] delclass=[C] clidep=[]\n` +
      `IMGW> FLD table=[ZCIT] field=[ZKEY] key=[X] type=[CHAR] len=[10] rollname=[ZKEY]\n` +
      `IMGW> FLD table=[ZCIT] field=[ZDESC] key=[] type=[CHAR] len=[40] rollname=[ZDESC]\n` +
      `IMGW> BVAL row=[1] field=[ZKEY] len=[1] value=[A]\n` +
      `IMGW> BVAL row=[1] field=[ZDESC] len=[3] value=[Old]\n` +
      `IMGW> PROBED rows=[1]\n`;

    it("object -> client-independent table, no CLNT-typed field: allow_cross_client lets the preview proceed with Client field MANDT and every key field as a key field (issue #176)", async () => {
      const route = resolutionRoute(ZCIT_IMG_BODIES, { preview: () => resp(200, PROBE_TRANSCRIPT_ZCIT) });
      const { conn, inner } = await connected(route);
      const { tools } = await registered(conn);

      const result = await invoke(tools, "abap_img_edit", {
        mode: "preview",
        object: "ZCIT",
        kind: "table",
        allow_cross_client: true,
        rows: [{ key: { ZKEY: "A" } }],
      });
      const text = okText(result);

      expect(text).toContain("Client field: MANDT");
      expect(text).toContain("Key fields (in order): ZKEY");
      expect(probeRan(inner)).toBe(true);
    });

    const zcdtDcBody = body({ TABNAME: ["ZCDT"], CONTFLAG: ["C"], CLIDEP: ["X"] });
    const zcdtTextBody = body({ TABNAME: ["ZCDT"], DDTEXT: ["Client-dependent, no CLNT field"] });
    const zcdtFieldsBody = body({
      TABNAME: ["ZCDT", "ZCDT"],
      FIELDNAME: ["ZKEY", "ZDESC"],
      POSITION: ["0001", "0002"],
      KEYFLAG: ["X", ""],
      DATATYPE: ["CHAR", "CHAR"],
      LENG: ["000010", "000040"],
      ROLLNAME: ["ZKEY", "ZDESC"],
    });
    const ZCDT_IMG_BODIES = [zcdtDcBody, zcdtTextBody, zcdtFieldsBody, zcdtDcBody, zcdtTextBody, zcdtFieldsBody];

    it("object -> client-dependent table, no CLNT-typed field: still refuses BAD_INPUT naming DD02L, even with allow_cross_client (issue #176)", async () => {
      const route = resolutionRoute(ZCDT_IMG_BODIES, {});
      const { conn, inner } = await connected(route);
      const { tools } = await registered(conn);

      const result = await invoke(tools, "abap_img_edit", {
        mode: "preview",
        object: "ZCDT",
        kind: "table",
        allow_cross_client: true,
        rows: [{ key: { ZKEY: "A" } }],
      });
      const err = errorPayload(result);

      expect(err.error).toBe("BAD_INPUT");
      expect(String(err.message)).toContain("DD02L marks client-dependent");
      expect(probeRan(inner)).toBe(false);
    });
  });

  describe("resolving from `activity`", () => {
    const headerBody = body({ ACTIVITY: ["ZACT1"], C_ACTIVITY: ["CACT1"], DOCU_ID: [""], ATTRIBUTES: [""] });
    const titleBody = body({ ACTIVITY: ["ZACT1"], TEXT: ["Maintain Z Table"] });
    const refsBody = emptyBody();
    const actHeaderBody = body({ ACT_ID: ["CACT1"] });
    // The linked object shares its name with its own base table, so fillTable succeeds on the very
    // first probe attempt inside resolveTableFromObjectName (no wasted table->view fallback).
    const objBody = body({ ACT_ID: ["CACT1"], OBJECTTYPE: ["D"], OBJECTNAME: ["ZTAB1"], TCODE: [""], SUBOBJNAME: [""] });
    const objTablesBody = body({ OBJECTNAME: ["ZTAB1"], OBJECTTYPE: ["D"], TABNAME: ["ZTAB1"] });
    const showDcBody = body({ TABNAME: ["ZTAB1"], CONTFLAG: ["C"], CLIDEP: ["X"] });

    const ztab1DcBody = body({ TABNAME: ["ZTAB1"], CONTFLAG: ["C"], CLIDEP: ["X"] });
    const ztab1TextBody = body({ TABNAME: ["ZTAB1"], DDTEXT: ["Z Table"] });
    const ztab1FieldsBody = body({
      TABNAME: ["ZTAB1", "ZTAB1", "ZTAB1"],
      FIELDNAME: ["MANDT", "ZFLD", "ZVAL"],
      POSITION: ["0001", "0002", "0003"],
      KEYFLAG: ["X", "X", ""],
      DATATYPE: ["CLNT", "CHAR", "CHAR"],
      LENG: ["000003", "000010", "000040"],
      ROLLNAME: ["MANDT", "ZFLD", "ZVAL"],
    });

    // readImgShow's own 7-call sequence, then resolveTableFromObjectName's 6-call sequence (3 to
    // find the table via probeOrder, 3 more for the unconditional per-field follow-up).
    const ACTIVITY_IMG_BODIES = [
      headerBody,
      titleBody,
      refsBody,
      actHeaderBody,
      objBody,
      objTablesBody,
      showDcBody,
      ztab1DcBody,
      ztab1TextBody,
      ztab1FieldsBody,
      ztab1DcBody,
      ztab1TextBody,
      ztab1FieldsBody,
    ];

    const PROBE_TRANSCRIPT_ZTAB1 =
      `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
      `IMGW> TABLE table=[ZTAB1] delclass=[C] clidep=[X]\n` +
      `IMGW> FLD table=[ZTAB1] field=[ZFLD] key=[X] type=[CHAR] len=[10] rollname=[ZFLD]\n` +
      `IMGW> FLD table=[ZTAB1] field=[ZVAL] key=[] type=[CHAR] len=[40] rollname=[ZVAL]\n` +
      `IMGW> BVAL row=[1] field=[ZFLD] len=[1] value=[A]\n` +
      `IMGW> BVAL row=[1] field=[ZVAL] len=[3] value=[Old]\n` +
      `IMGW> PROBED rows=[1]\n`;

    const APPLY_TRANSCRIPT_ZTAB1 =
      `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
      `IMGW> TABLE table=[ZTAB1] delclass=[C] clidep=[X]\n` +
      `IMGW> BVAL row=[1] field=[ZVAL] len=[3] value=[Old]\n` +
      `IMGW> TRKEY row=[1] trkorr=[A4HK900010] len=[10] value=[A4HK900010]\n` +
      `IMGW> AVAL row=[1] field=[ZVAL] len=[3] value=[New]\n` +
      `IMGW> APPLIED rows=[1]\n`;

    it("resolves `activity` to its linked table, and an armed upsert renders RESOLVED (with the activity title) ahead of the write", async () => {
      await withJournal(async (journal) => {
        const route = resolutionRoute(ACTIVITY_IMG_BODIES, {
          preview: () => resp(200, PROBE_TRANSCRIPT_ZTAB1),
          apply: () => resp(200, APPLY_TRANSCRIPT_ZTAB1),
        });
        const { conn, inner } = await connected(route);
        const { tools } = await registered(conn, { journal });

        const result = await invoke(tools, "abap_img_edit", {
          mode: "upsert",
          activity: "ZACT1",
          corr_nr: "A4HK900010",
          confirm: "ZTAB1",
          rows: [{ key: { ZFLD: "A" }, values: { ZVAL: "New" } }],
        });
        const text = okText(result);

        expect(text).toContain("--- RESOLVED ---");
        expect(text).toContain('Input: activity "ZACT1"');
        expect(text).toContain('(title: "Maintain Z Table")');
        expect(text).toContain("Object: ZTAB1 (table)");
        expect(text).toContain("Base table: ZTAB1");
        expect(text).toContain("Key fields (in order): ZFLD");
        expect(text).toContain("Client field: MANDT");
        expect(text).toContain("mode: upsert");
        expect(text).toContain("ROWS WRITTEN");
        expect(text).toContain("table-maintenance-generator events");

        expect(probeRan(inner)).toBe(true);
        expect(actionRan(inner, "apply")).toBe(true);

        const entries = await journal.list({});
        expect(entries).toHaveLength(1);
        expect(entries[0]!.object.name).toBe("ZTAB1");
      });
    });

    it("an explicit `view` on an activity-resolved upsert overrides the computed default and reaches the transport entry", async () => {
      await withJournal(async (journal) => {
        const route = resolutionRoute(ACTIVITY_IMG_BODIES, {
          preview: () => resp(200, PROBE_TRANSCRIPT_ZTAB1),
          apply: () => resp(200, APPLY_TRANSCRIPT_ZTAB1),
        });
        const { conn, inner } = await connected(route);
        const { tools } = await registered(conn, { journal });

        const result = await invoke(tools, "abap_img_edit", {
          mode: "upsert",
          activity: "ZACT1",
          view: "ZCUSTOM_VIEW",
          corr_nr: "A4HK900010",
          confirm: "ZTAB1",
          rows: [{ key: { ZFLD: "A" }, values: { ZVAL: "New" } }],
        });
        const text = okText(result);

        // The computed default (ZTAB1, the resolved base table — this activity's object kind is
        // "table") must be displaced by the explicitly supplied view, not merely coexist with it.
        expect(text).toContain("view: ZCUSTOM_VIEW");
        expect(text).not.toContain("view: ZTAB1");

        // The apply invoker's args JSON is what actually carries `view` to the ABAP side (img.ts reads
        // it into E071K-MASTERNAME/-VIEWNAME) — the real "transport entry" this override has to reach,
        // not just the rendered text above.
        const sourcePut = inner.calls.find(
          (c) =>
            (c.method ?? "GET").toUpperCase() === "PUT" &&
            INVOKER_SOURCE_URL_RE.test(c.url) &&
            invokerActionOf(c.body) === "apply",
        );
        expect(sourcePut).toBeDefined();
        const args = JSON.parse(invokerArgsJson(String(sourcePut!.body))) as { view?: string };
        expect(args.view).toBe("ZCUSTOM_VIEW");
      });
    });

    it("an activity resolving to more than one linked object reaches evaluateImgWrite rule 4 as ambiguous-target, without ever probing a table", async () => {
      const twoObjHeaderBody = body({ ACTIVITY: ["ZACT2"], C_ACTIVITY: ["CACT2"], DOCU_ID: [""], ATTRIBUTES: [""] });
      const twoObjTitleBody = body({ ACTIVITY: ["ZACT2"], TEXT: ["Two Objects"] });
      const twoObjRefsBody = emptyBody();
      const twoObjActHeaderBody = body({ ACT_ID: ["CACT2"] });
      const twoObjObjBody = body({
        ACT_ID: ["CACT2", "CACT2"],
        OBJECTTYPE: ["D", "D"],
        OBJECTNAME: ["ZOBJA", "ZOBJB"],
        TCODE: ["", ""],
        SUBOBJNAME: ["", ""],
      });
      const twoObjTablesBody = body({ OBJECTNAME: ["ZOBJA", "ZOBJB"], OBJECTTYPE: ["D", "D"], TABNAME: ["ZTABA", "ZTABB"] });
      const twoObjDcBody = body({ TABNAME: ["ZTABA", "ZTABB"], CONTFLAG: ["C", "C"], CLIDEP: ["X", "X"] });

      const route = resolutionRoute(
        [twoObjHeaderBody, twoObjTitleBody, twoObjRefsBody, twoObjActHeaderBody, twoObjObjBody, twoObjTablesBody, twoObjDcBody],
        {},
      );
      const { conn, inner } = await connected(route);
      const { tools } = await registered(conn);

      const result = await invoke(tools, "abap_img_edit", {
        mode: "preview",
        activity: "ZACT2",
        rows: [{ key: { ZKEY: "A" } }],
      });
      const err = errorPayload(result);

      expect(err.error).toBe("SAFETY_DENIED");
      expect((err.details as Record<string, unknown>).rule).toBe("ambiguous-target");
      expect(String(err.message)).toMatch(/ZOBJA/);
      expect(String(err.message)).toMatch(/ZOBJB/);
      expect(probeRan(inner)).toBe(false);
    });
  });
});

// ===========================================================================
// CHECKS NOT RUN disclosure (issue #62): abap_img_edit writes the base table
// directly, so none of the maintenance view's own checks (TVIMF event
// routines, DD03L check tables, DD07L fixed values) ever run. `readImgChecks`
// (src/adt/img-checks.ts) is a read-only diagnostic side-read of the same
// DDIC catalog a human maintaining the view through SM30 would implicitly
// rely on; `readChecksSafely`/`checksSection`/`checksNotesFor` (src/tools/
// img-edit.ts) fold its result into a "CHECKS NOT RUN" section on both
// preview and armed responses. These fixtures reproduce the *live*
// 2026-09-12-measured DDIC shape for TB003/V_TB003 (see this module's git
// history / the issue for the actual SAP read): a TB003 row copied from
// BUP001 carried STND_ROLECAT=X, which SM30 refuses via V_TB003's
// maintenance event routine V_TB003_CHECK_DEFAULT — `preview` said nothing
// about it before this feature existed.
// ===========================================================================

describe("abap_img_edit — CHECKS NOT RUN disclosure (issue #62, TB003/V_TB003)", () => {
  const TB003_ARGS = {
    table: "TB003",
    key_fields: ["ROLE"],
    view: "V_TB003",
    master_type: "VDAT" as const,
    corr_nr: "A4HK900001",
  };

  /** `buildViewsOverTableQuery(["TB003"])` — DD26S root views over TB003, live-measured. */
  const TB003_VIEWS_OVER_TABLE_BODY = body({
    VIEWNAME: ["H_TB003", "IBPROLE", "V_TB003"],
    TABNAME: ["TB003", "TB003", "TB003"],
    TABPOS: ["0001", "0001", "0001"],
  });

  /**
   * `buildViewMaintenanceEventsQuery(["V_TB003", "TB003", "H_TB003", "IBPROLE"])` — TVIMF,
   * live-measured: only V_TB003 has registered event routines.
   */
  const TB003_MAINTENANCE_EVENTS_BODY = body({
    TABNAME: ["V_TB003", "V_TB003"],
    EVENT: ["01", "13"],
    FORMNAME: ["V_TB003_CHECK_DEFAULT", "V_TB003_RESET_DFLT"],
  });

  /** `buildDomainValueTextsQuery(["MAINTEVENT"], "E")` — DD07T, live-measured (only the 2 codes this fixture's events use). */
  const TB003_MAINTEVENT_TEXTS_BODY = body({
    DOMNAME: ["MAINTEVENT", "MAINTEVENT"],
    DOMVALUE_L: ["01", "13"],
    DDTEXT: ["Before saving the data in the database", "Exit editing (exit main function module)"],
  });

  /** `buildTableFieldChecksQuery(["TB003"])` — DD03L, live-measured, all 8 fields. */
  const TB003_FIELD_CHECKS_BODY = body({
    TABNAME: Array(8).fill("TB003"),
    FIELDNAME: ["CLIENT", "ROLE", "ROLECATEGORY", "STND_ROLECAT", ".INCLUDE", "BPVIEW", "XSUPPRESS", "POSNR"],
    POSITION: ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008"],
    CHECKTABLE: ["T000", "", "TB003A", "", "", "TBZ0", "", ""],
    DOMNAME: ["MANDT", "BU_ROLE", "BU_ROLECAT", "XFELD", "", "BU_RLTYP", "XFELD", "NUM3"],
  });

  /**
   * `buildDomainFixedValuesQuery(["BU_ROLECAT", "XFELD"])` — live-measured: BU_ROLECAT has NO
   * DD07L rows at all (a domain with no fixed values is not an error — see img-catalog.ts's own
   * note on `domainValue`), so only XFELD's 2 rows come back.
   */
  const TB003_FIXED_VALUES_BODY = body({
    DOMNAME: ["XFELD", "XFELD"],
    VALPOS: ["0001", "0002"],
    DOMVALUE_L: ["X", ""],
    DOMVALUE_H: ["", ""],
    APPVAL: ["", ""],
  });

  /** The 5-call queue `readImgChecks` issues, in exact step order, when `checkValues` is true. */
  const TB003_CHECK_BODIES = [
    TB003_VIEWS_OVER_TABLE_BODY,
    TB003_MAINTENANCE_EVENTS_BODY,
    TB003_MAINTEVENT_TEXTS_BODY,
    TB003_FIELD_CHECKS_BODY,
    TB003_FIXED_VALUES_BODY,
  ];

  /** Existing row: ROLE=BUP001, ROLECATEGORY=01, STND_ROLECAT blank (not yet the "standard" role category). */
  const PROBE_TRANSCRIPT_TB003 =
    `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
    `IMGW> TABLE table=[tb003] delclass=[C] clidep=[X]\n` +
    `IMGW> FLD table=[tb003] field=[ROLE] key=[X] type=[CHAR] len=[12] rollname=[BU_ROLE]\n` +
    `IMGW> FLD table=[tb003] field=[ROLECATEGORY] key=[] type=[CHAR] len=[2] rollname=[BU_ROLECAT]\n` +
    `IMGW> FLD table=[tb003] field=[STND_ROLECAT] key=[] type=[CHAR] len=[1] rollname=[XFELD]\n` +
    `IMGW> BVAL row=[1] field=[ROLE] len=[6] value=[BUP001]\n` +
    `IMGW> BVAL row=[1] field=[ROLECATEGORY] len=[2] value=[01]\n` +
    `IMGW> BVAL row=[1] field=[STND_ROLECAT] len=[0] value=[]\n` +
    `IMGW> PROBED rows=[1]\n`;

  /** Live defect: the copied row's STND_ROLECAT is set to "X" (a legal XFELD fixed value — the maintenance-event routine, not a domain fixed-value check, is what SM30 would have refused). */
  const APPLY_TRANSCRIPT_TB003_UPSERT =
    `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
    `IMGW> TABLE table=[tb003] delclass=[C] clidep=[X]\n` +
    `IMGW> BVAL row=[1] field=[ROLECATEGORY] len=[2] value=[01]\n` +
    `IMGW> BVAL row=[1] field=[STND_ROLECAT] len=[0] value=[]\n` +
    `IMGW> TRKEY row=[1] trkorr=[A4HK900001] len=[6] value=[BUP001]\n` +
    `IMGW> AVAL row=[1] field=[ROLECATEGORY] len=[2] value=[01]\n` +
    `IMGW> AVAL row=[1] field=[STND_ROLECAT] len=[1] value=[X]\n` +
    `IMGW> APPLIED rows=[1]\n`;

  it("preview discloses the TB003/V_TB003 maintenance-event routine and check table a plain MODIFY skips", async () => {
    const route = resolutionRoute(TB003_CHECK_BODIES, { preview: () => resp(200, PROBE_TRANSCRIPT_TB003) });
    const { conn, inner } = await connected(route);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      ...TB003_ARGS,
      rows: [{ key: { ROLE: "BUP001" }, values: { ROLECATEGORY: "01", STND_ROLECAT: "X" } }],
    });
    const text = okText(result);

    expect(text).toContain("--- CHECKS NOT RUN ---");
    expect(text).toContain("This tool writes the base table directly.");
    // The maintenance event routine SM30 would have run for this write, and what its "01" event
    // code means — this is the exact live gap issue #62 is about.
    expect(text).toContain("V_TB003_CHECK_DEFAULT");
    expect(text).toContain("Before saving the data in the database");
    // The check table for ROLECATEGORY (a field this write also sets) — a foreign-key check a
    // plain MODIFY never verifies.
    expect(text).toContain("TB003A");

    expect(probeRan(inner)).toBe(true);
    expect(actionRan(inner, "apply")).toBe(false);
  });

  it("an armed upsert renders the same CHECKS NOT RUN section as preview, in addition to the SM30-bypass note", async () => {
    await withJournal(async (journal) => {
      const route = resolutionRoute(TB003_CHECK_BODIES, {
        preview: () => resp(200, PROBE_TRANSCRIPT_TB003),
        apply: () => resp(200, APPLY_TRANSCRIPT_TB003_UPSERT),
      });
      const { conn, inner } = await connected(route);
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_img_edit", {
        mode: "upsert",
        ...TB003_ARGS,
        confirm: "TB003",
        rows: [{ key: { ROLE: "BUP001" }, values: { ROLECATEGORY: "01", STND_ROLECAT: "X" } }],
      });
      const text = okText(result);

      expect(text).toContain("--- CHECKS NOT RUN ---");
      expect(text).toContain("V_TB003_CHECK_DEFAULT");
      expect(text).toContain("Before saving the data in the database");
      expect(text).toContain("TB003A");
      // The pre-existing SM30-bypass note still fires on an armed write — the new disclosure is
      // additive, not a replacement.
      expect(text).toContain("table-maintenance-generator events");

      expect(probeRan(inner)).toBe(true);
      expect(actionRan(inner, "apply")).toBe(true);
    });
  });

  it('a check-metadata read that throws (a transport failure, not a malformed row) still renders a normal preview, naming the failure as "The check metadata could not be read ("', async () => {
    let freestyleCalls = 0;
    const rest = multiBridgeHappyPath({ preview: () => resp(200, PROBE_TRANSCRIPT_TB003) });
    const route = (o: HttpClientOptions): HttpClientResponse => {
      if (o.url.includes("/datapreview/freestyle")) {
        freestyleCalls += 1;
        if (freestyleCalls === 1) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
        // The very first check query (DD26S) blows up — a genuine transport-level failure, which
        // `readImgChecks`'s own contract says must propagate (it is `readChecksSafely`, not
        // `readImgChecks` itself, that is responsible for turning this into a short failure
        // string instead of throwing out of the tool call).
        const r = resp(500, "<exc:exception/>", { "content-type": "application/xml" });
        throw new HttpClientException("Request failed with status code 500", "500", 500, undefined, o, r);
      }
      return rest(o);
    };
    const { conn, inner } = await connected(route);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      ...TB003_ARGS,
      rows: [{ key: { ROLE: "BUP001" }, values: { ROLECATEGORY: "01", STND_ROLECAT: "X" } }],
    });
    const text = okText(result);

    // The preview itself is unaffected — CURRENT ROWS/PROSPECTIVE CHANGE still render normally.
    expect(text).toContain("--- CURRENT ROWS ---");
    expect(text).toContain("--- CHECKS NOT RUN ---");
    expect(text).toContain("The check metadata could not be read (");
    expect(text).toContain("Request failed with status code 500");
    expect(text).not.toContain("V_TB003_CHECK_DEFAULT");

    expect(probeRan(inner)).toBe(true);
    expect(actionRan(inner, "apply")).toBe(false);
  });

  it("mode: delete does not check written values, so it never issues the DD07L fixed-values read", async () => {
    const PROBE_TRANSCRIPT_TB003_DELETE =
      `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
      `IMGW> TABLE table=[tb003] delclass=[C] clidep=[X]\n` +
      `IMGW> FLD table=[tb003] field=[ROLE] key=[X] type=[CHAR] len=[12] rollname=[BU_ROLE]\n` +
      `IMGW> BVAL row=[1] field=[ROLE] len=[6] value=[BUP001]\n` +
      `IMGW> PROBED rows=[1]\n`;
    const APPLY_TRANSCRIPT_TB003_DELETE =
      `IMGW> CLIENT mandt=[001] cccategory=[] cccoractiv=[]\n` +
      `IMGW> TABLE table=[tb003] delclass=[C] clidep=[X]\n` +
      `IMGW> TRKEY row=[1] trkorr=[A4HK900001] len=[6] value=[BUP001]\n` +
      `IMGW> AABSENT row=[1]\n` +
      `IMGW> APPLIED rows=[1]\n`;
    // Only 4 bodies: DD26S, TVIMF, DD07T, DD03L — no DD07L, since `checkValues: mode !== "delete"`
    // makes `valueFields` (and therefore `valueFieldsWithDomain`) empty regardless of what DD03L
    // reports. `resolutionRoute` throws loudly on any freestyle call past this queue's end, so an
    // unexpected 5th (DD07L) call fails the test outright rather than silently passing.
    const route = resolutionRoute(
      [TB003_VIEWS_OVER_TABLE_BODY, TB003_MAINTENANCE_EVENTS_BODY, TB003_MAINTEVENT_TEXTS_BODY, TB003_FIELD_CHECKS_BODY],
      { preview: () => resp(200, PROBE_TRANSCRIPT_TB003_DELETE), apply: () => resp(200, APPLY_TRANSCRIPT_TB003_DELETE) },
    );
    const { conn, inner } = await connected(route);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "delete",
      ...TB003_ARGS,
      confirm: "TB003",
      rows: [{ key: { ROLE: "BUP001" } }],
    });
    const text = okText(result);

    expect(text).toContain("--- CHECKS NOT RUN ---");
    expect(text).toContain("V_TB003_CHECK_DEFAULT");
    const domainValuesQuery = inner.calls.find((c) => typeof c.body === "string" && c.body.includes("FROM DD07L"));
    expect(domainValuesQuery).toBeUndefined();

    expect(probeRan(inner)).toBe(true);
    expect(actionRan(inner, "apply")).toBe(true);
  });

  it("checksNotesFor's two note types render with exact wording: the maintenance-event note and the fixed-value note", async () => {
    // Same TB003/V_TB003 catalog shape, but STND_ROLECAT is written as "Q" — not a fixed value of
    // domain XFELD ("X" or "" per TB003_FIXED_VALUES_BODY) — so both note types fire together.
    const route = resolutionRoute(TB003_CHECK_BODIES, { preview: () => resp(200, PROBE_TRANSCRIPT_TB003) });
    const { conn } = await connected(route);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_img_edit", {
      mode: "preview",
      ...TB003_ARGS,
      rows: [{ key: { ROLE: "BUP001" }, values: { ROLECATEGORY: "01", STND_ROLECAT: "Q" } }],
    });
    const text = okText(result);

    // Verbatim per `checksNotesFor` (src/tools/img-edit.ts): 2 events registered for V_TB003.
    expect(text).toContain(
      "2 maintenance event routine(s) registered for V_TB003 will not run: " +
        "V_TB003_CHECK_DEFAULT, V_TB003_RESET_DFLT. See CHECKS NOT RUN.",
    );
    // Verbatim per `checksNotesFor`: STND_ROLECAT="Q" is not one of XFELD's fixed values ("X", "").
    expect(text).toContain(
      'Field STND_ROLECAT: value "Q" is not one of domain XFELD\'s fixed values (X, ). ' +
        "SM30 would have rejected this input; this tool does not.",
    );
  });
});
