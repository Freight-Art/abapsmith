/**
 * Tests for `core.eval` (issue #118): the built-in fluid action reached as
 * `abap_fluid {"tool":"core","action":"eval","args":{"lines":[...],"out":[...]},"confirm":"core.eval"}`,
 * gated behind `ABAP_ALLOW_FLUID_EVAL` (off by default, independent of
 * `ABAP_ALLOW_FLUID_PLUGINS`/`ABAP_ALLOW_FLUID_PLUGIN_MUTATE`).
 *
 * Six slices:
 *  - gating: the flag, the catalogue, the confirm echo, and their ordering.
 *  - argument validation: `lines`/`out` shape checks in `guardCoreAction`.
 *  - static review: the shipped-rule lint over the caller's own `lines`.
 *  - capability scan: db-write/commit-rollback (ABAP_ALLOW_FLUID_PLUGIN_MUTATE)
 *    and call-function (ABAP_ALLOW_FLUID_CALL_FM), independently gated.
 *  - generated source: `invokerSource`'s `evalBody` shape (verbatim caller
 *    lines, no `=>run(`/`lv_json`, one `lv_zmcp_out` declaration).
 *  - journalling: `journalFluidEval` (unexported) driven indirectly through
 *    the real, exported `dispatch()` — see that describe block's own header
 *    comment for why.
 *
 * The first four slices use a hand-built, cast `FluidDeps` — same lightweight
 * house style as fluid-core-call-fm-gate.test.ts — since `guardCoreAction`'s
 * eval branch never touches `deps.gate` or `deps.conn`, only `deps.cfg`.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { Journal } from "../src/journal.js";
import { dispatch, type FluidDeps, type FluidRunRequest } from "../src/adt/fluid/dispatch.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import {
  CORE_EVAL_ACTION,
  CORE_EVAL_CONFIRM,
  CORE_TOOL_ID,
  EVAL_OUT_NAME_RE,
  coreTool,
  guardCoreAction,
} from "../src/adt/fluid/builtin/core.js";
import { FLUID_ABAP_LINE_MAX } from "../src/adt/fluid/static-review.js";
import { invokerName, invokerSource, type InvokerSourceArgs } from "../src/adt/fluid/invoke.js";
import { catalogueToolSet } from "../src/tools/fluid.js";
import { buildFluidDescription } from "../src/adt/fluid/describe.js";
import type { FluidToolSet } from "../src/adt/fluid/plugin-loader.js";
import {
  manifestVersion,
  type FluidActionSpec,
  type FluidManifest,
  type LoadedFluidTool,
} from "../src/adt/fluid/manifest.js";

// ---------------------------------------------------------------- shared ---

async function catchErr(p: Promise<unknown>): Promise<AbapError> {
  try {
    await p;
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected a rejection");
}

/**
 * Only `cfg` is ever read by `guardCoreAction`'s eval branch — `gate`/`conn`
 * are cast away, same idiom as fluid-core-call-fm-gate.test.ts's `makeDeps`.
 */
function makeDeps(
  opts: {
    allowFluidEval?: boolean;
    allowFluidPluginMutate?: boolean;
    allowFluidCallFm?: boolean;
  } = {},
): FluidDeps {
  return {
    cfg: {
      allowFluidEval: opts.allowFluidEval ?? true,
      allowFluidPluginMutate: opts.allowFluidPluginMutate ?? false,
      allowFluidCallFm: opts.allowFluidCallFm ?? false,
    },
    gate: {},
  } as unknown as FluidDeps;
}

function evalReq(overrides: Partial<FluidRunRequest> = {}): FluidRunRequest {
  return {
    tool: CORE_TOOL_ID,
    action: CORE_EVAL_ACTION,
    args: { lines: ["DATA(lv_zmcp_test) = 1."] },
    confirm: CORE_EVAL_CONFIRM,
    ...overrides,
  };
}

// ------------------------------------------------------------------ 1&2 ---

describe("core.eval gating", () => {
  it("FLUID_EVAL_DISABLED when ABAP_ALLOW_FLUID_EVAL is off, checked before confirm or args", async () => {
    const deps = makeDeps({ allowFluidEval: false });
    // No confirm, no args at all — the flag check runs before either is looked at.
    const req: FluidRunRequest = { tool: CORE_TOOL_ID, action: CORE_EVAL_ACTION, args: undefined };

    const err = await catchErr(guardCoreAction(deps, req));

    expect(err.code).toBe("FLUID_EVAL_DISABLED");
    expect(err.message).toMatch(/ABAP_ALLOW_FLUID_EVAL/);
    expect(err.details["rule"]).toBe("ABAP_ALLOW_FLUID_EVAL");
  });

  it("catalogueToolSet hides eval from the catalogue when the flag is off, shows it when on", () => {
    const toolSet: FluidToolSet = { tools: new Map([[CORE_TOOL_ID, coreTool]]), refused: [], warnings: [] };
    const offCfg = { allowFluidEval: false } as unknown as Config;
    const onCfg = { allowFluidEval: true } as unknown as Config;

    const offDesc = buildFluidDescription(catalogueToolSet(toolSet, offCfg));
    const onDesc = buildFluidDescription(catalogueToolSet(toolSet, onCfg));

    expect(offDesc).not.toMatch(/\beval\b/);
    expect(onDesc).toMatch(/\beval\b/);
  });

  it("BAD_INPUT naming core.eval when confirm is missing", async () => {
    const deps = makeDeps({ allowFluidEval: true });
    const req = evalReq({ confirm: undefined });

    const err = await catchErr(guardCoreAction(deps, req));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("core.eval");
    expect(err.details["field"]).toBe("confirm");
    expect(err.details["expected"]).toBe(CORE_EVAL_CONFIRM);
    expect(err.details["got"]).toBeUndefined();
  });

  it("BAD_INPUT naming core.eval when confirm is wrong", async () => {
    const deps = makeDeps({ allowFluidEval: true });
    const req = evalReq({ confirm: "nope" });

    const err = await catchErr(guardCoreAction(deps, req));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("core.eval");
    expect(err.details["field"]).toBe("confirm");
    expect(err.details["got"]).toBe("nope");
  });

  it("flag is checked before confirm: FLUID_EVAL_DISABLED wins even with a wrong confirm", async () => {
    const deps = makeDeps({ allowFluidEval: false });
    const req = evalReq({ confirm: "nope" });

    const err = await catchErr(guardCoreAction(deps, req));

    expect(err.code).toBe("FLUID_EVAL_DISABLED");
  });
});

describe("core.eval argument validation", () => {
  it("accepts a line exactly FLUID_ABAP_LINE_MAX characters long", async () => {
    const deps = makeDeps();
    const line = "A".repeat(FLUID_ABAP_LINE_MAX);
    await expect(guardCoreAction(deps, evalReq({ args: { lines: [line] } }))).resolves.toBeUndefined();
  });

  it("BAD_INPUT naming the line number and FLUID_ABAP_LINE_MAX for a line one character over", async () => {
    const deps = makeDeps();
    const line = "A".repeat(FLUID_ABAP_LINE_MAX + 1);
    const req = evalReq({ args: { lines: ["DATA(lv_ok) = 1.", line] } });

    const err = await catchErr(guardCoreAction(deps, req));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toMatch(/line 2/);
    expect(err.message).toContain(String(FLUID_ABAP_LINE_MAX));
    expect(err.details["field"]).toBe("lines");
    expect(err.details["line"]).toBe(2);
    expect(err.details["length"]).toBe(FLUID_ABAP_LINE_MAX + 1);
  });

  it("BAD_INPUT on an empty lines array", async () => {
    const deps = makeDeps();
    const err = await catchErr(guardCoreAction(deps, evalReq({ args: { lines: [] } })));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.details["field"]).toBe("lines");
  });

  it("BAD_INPUT when lines is not an array at all", async () => {
    const deps = makeDeps();
    const err = await catchErr(guardCoreAction(deps, evalReq({ args: { lines: "DATA(lv_x) = 1." } })));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.details["field"]).toBe("lines");
  });

  it("BAD_INPUT when lines contains a non-string element", async () => {
    const deps = makeDeps();
    const err = await catchErr(
      guardCoreAction(deps, evalReq({ args: { lines: ["DATA(lv_ok) = 1.", 123] } })),
    );

    expect(err.code).toBe("BAD_INPUT");
    expect(err.details["field"]).toBe("lines");
  });

  // A caller-supplied `out` name is spliced verbatim into generated ABAP source
  // (see invoke.ts's `evalOutEmitter`) — EVAL_OUT_NAME_RE (a plain identifier
  // shape, no quotes/parens/whitespace) is what makes that safe without further
  // escaping. A name starting with a digit is not a legal ABAP identifier and
  // must be rejected here, not discovered as a syntax error after deployment.
  it("BAD_INPUT naming EVAL_OUT_NAME_RE for an out name starting with a digit", async () => {
    const deps = makeDeps();
    const req = evalReq({ args: { lines: ["DATA(lv_1) = 1."], out: ["1lv"] } });

    const err = await catchErr(guardCoreAction(deps, req));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.details["field"]).toBe("out");
    expect(err.details["value"]).toBe("1lv");
    expect(err.message).toContain(EVAL_OUT_NAME_RE.toString());
  });

  it("an absent out list is accepted", async () => {
    const deps = makeDeps();
    await expect(
      guardCoreAction(deps, evalReq({ args: { lines: ["DATA(lv_ok) = 1."] } })),
    ).resolves.toBeUndefined();
  });

  it("an empty out list is accepted", async () => {
    const deps = makeDeps();
    await expect(
      guardCoreAction(deps, evalReq({ args: { lines: ["DATA(lv_ok) = 1."], out: [] } })),
    ).resolves.toBeUndefined();
  });
});

// -------------------------------------------------------------------- 3 ---

describe("core.eval static review", () => {
  it("FLUID_MANIFEST_INVALID naming the line and the exec-sql rule for EXEC SQL", async () => {
    const deps = makeDeps();
    const req = evalReq({ args: { lines: ["DATA(lv_ok) = 1.", "EXEC SQL."] } });

    const err = await catchErr(guardCoreAction(deps, req));

    expect(err.code).toBe("FLUID_MANIFEST_INVALID");
    expect(err.message).toMatch(/line 2/);
    expect(err.message).toContain("exec-sql");
    expect(err.details["line"]).toBe(2);
    expect(err.details["rule"]).toBe("exec-sql");
  });

  it("a snippet with no prohibited construct passes static review", async () => {
    const deps = makeDeps();
    await expect(
      guardCoreAction(deps, evalReq({ args: { lines: ["DATA(lv_ok) = 1.", "lv_ok = lv_ok + 1."] } })),
    ).resolves.toBeUndefined();
  });
});

// -------------------------------------------------------------------- 4 ---

describe("core.eval capability scan", () => {
  it("db-write (UPDATE) is refused as FLUID_PLUGIN_MUTATE_DISABLED when allowFluidPluginMutate is off", async () => {
    const deps = makeDeps({ allowFluidPluginMutate: false });
    const req = evalReq({ args: { lines: ["UPDATE zfoo SET field = 1."] } });

    const err = await catchErr(guardCoreAction(deps, req));

    expect(err.code).toBe("FLUID_PLUGIN_MUTATE_DISABLED");
    expect(err.details["rule"]).toBe("ABAP_ALLOW_FLUID_PLUGIN_MUTATE");
    expect(err.details["line"]).toBe(1);
  });

  it("db-write (UPDATE) is allowed once allowFluidPluginMutate is on", async () => {
    const deps = makeDeps({ allowFluidPluginMutate: true });
    await expect(
      guardCoreAction(deps, evalReq({ args: { lines: ["UPDATE zfoo SET field = 1."] } })),
    ).resolves.toBeUndefined();
  });

  it("COMMIT WORK is refused as FLUID_PLUGIN_MUTATE_DISABLED when allowFluidPluginMutate is off", async () => {
    const deps = makeDeps({ allowFluidPluginMutate: false });
    const err = await catchErr(guardCoreAction(deps, evalReq({ args: { lines: ["COMMIT WORK."] } })));

    expect(err.code).toBe("FLUID_PLUGIN_MUTATE_DISABLED");
    expect(err.details["rule"]).toBe("ABAP_ALLOW_FLUID_PLUGIN_MUTATE");
  });

  it("ROLLBACK WORK is refused as FLUID_PLUGIN_MUTATE_DISABLED when allowFluidPluginMutate is off", async () => {
    const deps = makeDeps({ allowFluidPluginMutate: false });
    const err = await catchErr(guardCoreAction(deps, evalReq({ args: { lines: ["ROLLBACK WORK."] } })));

    expect(err.code).toBe("FLUID_PLUGIN_MUTATE_DISABLED");
    expect(err.details["rule"]).toBe("ABAP_ALLOW_FLUID_PLUGIN_MUTATE");
  });

  it("CALL FUNCTION is refused as SAFETY_DENIED naming ABAP_ALLOW_FLUID_CALL_FM when it is off", async () => {
    const deps = makeDeps({ allowFluidCallFm: false });
    const req = evalReq({ args: { lines: ["CALL FUNCTION 'ZFOO'."] } });

    const err = await catchErr(guardCoreAction(deps, req));

    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details["rule"]).toBe("ABAP_ALLOW_FLUID_CALL_FM");
    expect(err.details["line"]).toBe(1);
  });

  it("CALL FUNCTION is allowed once allowFluidCallFm is on", async () => {
    const deps = makeDeps({ allowFluidCallFm: true });
    await expect(
      guardCoreAction(deps, evalReq({ args: { lines: ["CALL FUNCTION 'ZFOO'."] } })),
    ).resolves.toBeUndefined();
  });

  // The two capability flags are independent: allowFluidPluginMutate does not
  // unlock CALL FUNCTION, matching guardCoreAction's two separate `if`s over
  // `mutateHit`/`callFmHit` (src/adt/fluid/builtin/core.ts).
  it("allowFluidPluginMutate: true does not unlock CALL FUNCTION", async () => {
    const deps = makeDeps({ allowFluidPluginMutate: true, allowFluidCallFm: false });
    const req = evalReq({ args: { lines: ["CALL FUNCTION 'ZFOO'."] } });

    const err = await catchErr(guardCoreAction(deps, req));

    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details["rule"]).toBe("ABAP_ALLOW_FLUID_CALL_FM");
  });

  it("names the actual offending line (3) when it is not the first", async () => {
    const deps = makeDeps({ allowFluidCallFm: false });
    const req = evalReq({
      args: {
        lines: ["DATA(lv_a) = 1.", "DATA(lv_b) = 2.", "CALL FUNCTION 'ZFOO'."],
      },
    });

    const err = await catchErr(guardCoreAction(deps, req));

    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details["line"]).toBe(3);
  });
});

// -------------------------------------------------------------------- 5 ---

const INVOKER_VERSION = "deadbeef";
const INVOKER_CONTRACT = "1.0";

function evalInvokerArgs(overrides: { lines?: readonly string[]; out?: readonly string[] } = {}): InvokerSourceArgs {
  const lines = overrides.lines ?? ["lv_x = 1."];
  const out = overrides.out ?? [];
  const toolId = CORE_TOOL_ID;
  const action = CORE_EVAL_ACTION;
  const wireArgs = { lines, out };
  return {
    name: invokerName(toolId, action, wireArgs, INVOKER_CONTRACT),
    entry: "ZCL_ZMCP_FLUID_CORE",
    toolId,
    action,
    argsJson: "{}", // ignored by the eval shape (see invoke.ts's doc comment on `invokerSource`)
    version: INVOKER_VERSION,
    contract: INVOKER_CONTRACT,
    commit: false,
    evalBody: { lines, out },
  };
}

function nonEvalInvokerArgs(): InvokerSourceArgs {
  const toolId = "demo_tool";
  const action = "run_it";
  const argsJson = '{"a":1}';
  return {
    name: invokerName(toolId, action, argsJson, INVOKER_CONTRACT),
    entry: "ZCL_DEMO_ENTRY",
    toolId,
    action,
    argsJson,
    version: INVOKER_VERSION,
    contract: INVOKER_CONTRACT,
    commit: false,
  };
}

describe("core.eval generated source", () => {
  it("emits the caller's lines verbatim, unindented, at column 0", () => {
    const source = invokerSource(evalInvokerArgs({ lines: ["lv_x = 1.", "lv_y = 2."] }));

    expect(source).toMatch(/^lv_x = 1\.$/m);
    expect(source).toMatch(/^lv_y = 2\.$/m);
  });

  it("declares lv_zmcp_out exactly once, regardless of how many out names are requested", () => {
    const source = invokerSource(
      evalInvokerArgs({ lines: ["lv_a = 1.", "lv_b = 2."], out: ["lv_a", "lv_b"] }),
    );

    const matches = source.match(/DATA lv_zmcp_out TYPE string\./g);
    expect(matches).toHaveLength(1);
  });

  it("the eval shape contains no =>run( dispatch and no lv_json variable", () => {
    const source = invokerSource(evalInvokerArgs());

    expect(source).not.toContain("=>run(");
    expect(source).not.toContain("lv_json");
  });

  // Contrast case: the ordinary (non-eval) shape DOES build lv_json and DOES
  // dispatch through entry=>run(...) — proving the assertion above actually
  // distinguishes the two shapes rather than being vacuously true of both.
  it("the non-eval shape, by contrast, does contain =>run( and lv_json", () => {
    const source = invokerSource(nonEvalInvokerArgs());

    expect(source).toContain("=>run(");
    expect(source).toContain("lv_json");
  });

  it("distinct snippets produce distinct invoker names", () => {
    const nameA = invokerName(CORE_TOOL_ID, CORE_EVAL_ACTION, { lines: ["lv_a = 1."], out: [] }, INVOKER_CONTRACT);
    const nameB = invokerName(CORE_TOOL_ID, CORE_EVAL_ACTION, { lines: ["lv_b = 2."], out: [] }, INVOKER_CONTRACT);

    expect(nameA).not.toBe(nameB);
  });
});

// -------------------------------------------------------------------- 6 ---

/**
 * `journalFluidEval`, `isCoreEval`, and `JOURNAL_ARGS_MAX` are all
 * module-private in src/adt/fluid/dispatch.ts (no `export` keyword) — only
 * `FluidDeps`/`FluidRunRequest`/`FluidRunResult`/`dispatchDisabledError`/
 * `dispatch` are exported. Per the brief's own fallback instruction, this is
 * NOT edited into an export; instead `journalFluidEval` is driven indirectly
 * through the real, exported `dispatch()`, using the same offline
 * FakeAdt/dynamicFluidRoute/real-Journal harness idiom
 * test/fluid-dispatch.test.ts's own "dispatch — journal" describe block
 * uses for exactly this kind of test.
 *
 * `JOURNAL_ARGS_MAX = 500` (dispatch.ts:211) cannot be imported either, so it
 * is duplicated here, by hand, with this comment as the tripwire if the two
 * ever drift.
 */
const JOURNAL_ARGS_MAX = 500;

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

type Route = (r: Recorded) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body };
    this.calls.push(rec);
    const res = this.route(rec);
    if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
    return res;
  }
}

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  return undefined;
}

const notFoundXml = (name: string): string =>
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
  `<message lang="EN">${name} does not exist</message><properties/></exc:exception>`;

const CHECKRUN_CLEAN_XML =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:atom="http://www.w3.org/2005/Atom"/>`;

const PACKAGE_XML = (name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" adtcore:type="DEVC/K">` +
  `<adtcore:packageRef adtcore:name="${name}" adtcore:type="DEVC/K"/>` +
  `<pak:superPackage/>` +
  `</pak:package>`;

function classDocXml(
  className: string,
  opts: { rootVersion?: string; mainVersion?: string; packageName?: string } = {},
): string {
  const root = opts.rootVersion ?? "active";
  const main = opts.mainVersion ?? root;
  const pkg = opts.packageName ?? "$TMP";
  const ver = (v: string) => ` adtcore:version="${v}"`;
  const inc = (type: string, version: string) =>
    `<class:include class:includeType="${type}" ` +
    `abapsource:sourceUri="${type === "main" ? "source/main" : `includes/${type}`}" ` +
    `adtcore:name="" adtcore:type="CLAS/I"${ver(version)}/>`;
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<class:abapClass adtcore:name="${className}" adtcore:type="CLAS/OC"${ver(root)} ` +
    `xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `xmlns:abapsource="http://www.sap.com/adt/abapsource">` +
    `<adtcore:packageRef adtcore:name="${pkg}"/>` +
    inc("definitions", "active") +
    inc("implementations", "active") +
    inc("macros", "active") +
    inc("main", main) +
    `</class:abapClass>`
  );
}

interface ObjState {
  exists: boolean;
  packageName: string;
  source?: string;
  active: boolean;
}

const CLS_COLLECTION = "/sap/bc/adt/oo/classes";
const PKG_URI = "/sap/bc/adt/packages/%24abapsmith_fluid_api";
const PACKAGES = "/sap/bc/adt/packages";
const CLASSRUN_BASE = "/sap/bc/adt/oo/classrun/";

function nameFromClassUrl(url: string): string | undefined {
  const prefix = "/sap/bc/adt/oo/classes/";
  if (!url.startsWith(prefix)) return undefined;
  const rest = url.slice(prefix.length);
  if (rest.endsWith("/source/main")) return rest.slice(0, -"/source/main".length).toUpperCase();
  if (rest.includes("/")) return undefined;
  return rest.toUpperCase();
}

/** Same auto-vivifying class store as fluid-dispatch.test.ts's `dynamicFluidRoute`, trimmed to just what journalling needs. */
function dynamicFluidRoute(opts: { transcript: () => string }): { route: Route; store: Map<string, ObjState> } {
  const store = new Map<string, ObjState>();
  const at = (name: string): ObjState => {
    let st = store.get(name);
    if (!st) {
      st = { exists: false, packageName: "$TMP", active: false };
      store.set(name, st);
    }
    return st;
  };

  const route: Route = (r) => {
    if (r.url === PKG_URI && r.method === "GET") return resp(200, PACKAGE_XML(FLUID_PACKAGE), OK_XML);
    if (r.url === PACKAGES && r.method === "POST") return resp(200, "", OK_TEXT);
    if (r.url.startsWith("/sap/bc/adt/checkruns") && r.method === "POST") return resp(200, CHECKRUN_CLEAN_XML, OK_XML);

    if (r.url === CLS_COLLECTION && r.method === "POST") {
      const m = /adtcore:name="([^"]+)"/.exec(r.body ?? "");
      const name = (m?.[1] ?? "").toUpperCase();
      const prior = store.get(name);
      store.set(name, { exists: true, packageName: FLUID_PACKAGE, source: prior?.source, active: false });
      return resp(200, "", OK_TEXT);
    }

    if (r.url === "/sap/bc/adt/activation" && r.method === "POST") {
      const m = /adtcore:name="([^"]+)"/.exec(r.body ?? "");
      const name = (m?.[1] ?? "").toUpperCase();
      const st = store.get(name);
      if (st) st.active = true;
      return resp(200, "", OK_TEXT);
    }

    if (r.url.startsWith(CLASSRUN_BASE) && r.method === "POST") {
      return resp(200, opts.transcript(), OK_TEXT);
    }

    const name = nameFromClassUrl(r.url);
    if (name !== undefined) {
      const st = at(name);
      const isSrc = r.url.endsWith("/source/main");
      if (!isSrc && r.method === "GET" && !r.qs._action) {
        if (!st.exists) return resp(404, notFoundXml(name), OK_XML);
        return resp(
          200,
          classDocXml(name, { packageName: st.packageName, mainVersion: st.active ? "active" : "inactive" }),
          OK_XML,
        );
      }
      if (isSrc && r.method === "GET") {
        if (!st.exists || st.source === undefined) return resp(404, notFoundXml(name), OK_XML);
        return resp(200, st.source, OK_TEXT);
      }
      if (!isSrc && r.qs._action === "LOCK") {
        return resp(
          200,
          `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
            `<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
            `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
            `</DATA></asx:values></asx:abap>`,
          OK_XML,
        );
      }
      if (!isSrc && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (isSrc && r.method === "PUT") {
        st.source = r.body ?? "";
        st.exists = true;
        st.active = false;
        return resp(200, "", OK_TEXT);
      }
    }
    return undefined;
  };

  return { route, store };
}

function frameLine(name: string, payload: unknown): string {
  return `ZMCP-H>${name} ${JSON.stringify(payload)}`;
}

function buildTranscript(opts: {
  id?: string;
  ver: string;
  action: string;
  outs?: readonly unknown[];
  errs?: readonly { kind: "subrc" | "exception" | "message"; step: string; text: string }[];
  end?: { rc?: number; outBytes?: number; truncated?: boolean; ms?: number } | null;
}): string {
  const lines: string[] = [];
  lines.push(frameLine("BEGIN", { id: opts.id ?? "t", ver: opts.ver, action: opts.action, contract: "1.0" }));
  for (const v of opts.outs ?? []) lines.push(frameLine("OUT", v));
  for (const e of opts.errs ?? []) lines.push(frameLine("ERR", e));
  if (opts.end !== null) {
    const end = { rc: 0, outBytes: 0, truncated: false, ms: 1, ...(opts.end ?? {}) };
    lines.push(frameLine("END", end));
  }
  return lines.join("\n") + "\n";
}

const CORE_EVAL_LIKE_ACTION: FluidActionSpec = {
  name: CORE_EVAL_ACTION,
  category: "execute",
  description: "test fixture mirroring core.eval's real action shape",
  input: {
    type: "object",
    required: ["lines"],
    properties: {
      lines: { type: "array", items: { type: "string", maxLength: FLUID_ABAP_LINE_MAX } },
      out: { type: "array", items: { type: "string", maxLength: 30 } },
    },
  },
  output: { type: "array", items: { type: "object" } },
};

function makeCoreEvalTool(): LoadedFluidTool {
  const className = "ZCL_ZMCP_FLUID_CORE";
  const cls = className.toLowerCase();
  const source = `CLASS ${cls} DEFINITION PUBLIC.\nENDCLASS.\nCLASS ${cls} IMPLEMENTATION.\nENDCLASS.`;
  const manifest: FluidManifest = {
    contract: "1.0",
    id: CORE_TOOL_ID,
    title: "test core tool (eval only)",
    description: "fluid-eval.test.ts fixture mirroring the real core tool's eval action",
    objects: [{ name: className, type: "CLAS/OC", description: "obj", source: { text: source } }],
    entry: className,
    actions: [CORE_EVAL_LIKE_ACTION],
  };
  const sources = new Map([[className, source]]);
  return { manifest, origin: "builtin", sources, version: manifestVersion(manifest, sources) };
}

function depsFor(
  conn: AbapConnection,
  g: SafetyGate,
  tool: LoadedFluidTool,
  overrides: Partial<Pick<FluidDeps, "cfg" | "journal" | "warn">> = {},
): FluidDeps {
  return {
    conn,
    cfg: overrides.cfg ?? cfg(),
    gate: g,
    tools: new Map([[tool.manifest.id, tool]]),
    ...(overrides.journal ? { journal: overrides.journal } : {}),
    ...(overrides.warn ? { warn: overrides.warn } : {}),
  };
}

let tmp: string;

async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(cfg(), {
    httpClient: routeSystemRoleProbe(adt, { answer: "nonproductive" }),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

function cfg(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
    fluidApi: true,
    stateDir: tmp,
    allowFluidEval: true,
    ...overrides,
  });
}

const gate = (): SafetyGate => new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"] });

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-fluid-eval-"));
  resetFluidEnsureState();
  resetFluidPackageMemo();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("core.eval journalling", () => {
  it("journals the full snippet untruncated, past JOURNAL_ARGS_MAX, and marks the entry not undoable", async () => {
    const tool = makeCoreEvalTool();
    // Comfortably over JOURNAL_ARGS_MAX (500) once joined — the marker line at
    // the end proves the WHOLE snippet made it into the journal, not just the
    // first JOURNAL_ARGS_MAX characters of it.
    const fillerLines = Array.from({ length: 30 }, (_, i) => `DATA(lv_zmcp_eval_filler_${i}) = ${i}.`);
    const markerLine = "DATA(lv_zmcp_eval_marker_zzz_end_of_snippet) = 999888777.";
    const lines = [...fillerLines, markerLine];
    expect(lines.join("\n").length).toBeGreaterThan(JOURNAL_ARGS_MAX);

    const { route } = dynamicFluidRoute({
      transcript: () =>
        buildTranscript({ id: tool.manifest.id, ver: tool.version, action: CORE_EVAL_ACTION, outs: [{}] }),
    });
    const { conn } = await connected(route);
    const journal = new Journal(
      { dir: path.join(tmp, "journal"), enabled: true, maxEntries: 200, maxAgeDays: 30 },
      "A4H",
    );
    const d = depsFor(conn, gate(), tool, { journal });

    await dispatch(d, {
      tool: CORE_TOOL_ID,
      action: CORE_EVAL_ACTION,
      args: { lines, out: [] },
      confirm: CORE_EVAL_CONFIRM,
    });

    const entries = await journal.list({ object: `${CORE_TOOL_ID}.${CORE_EVAL_ACTION}` });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.outcome).toBe("succeeded");
    expect(entry?.irreversible).toBe(true);
    expect(entry?.beforeCapture).toBe("unknown");
    const description = entry?.object.description ?? "";
    expect(description.length).toBeGreaterThan(JOURNAL_ARGS_MAX);
    // Every filler line and the trailing marker line survive untruncated.
    for (const line of lines) {
      expect(description).toContain(line);
    }
  });

  // Mirrors fluid-dispatch.test.ts's "a builtin mutate action with an ERR frame is never
  // journalled": journalFluidEval is only reached after assertTranscriptIdentity has confirmed no
  // ERR frame, so a snippet whose own TRY/CATCH surfaces as ERR must never be journalled either.
  it("a core.eval call whose transcript carries an ERR frame is never journalled", async () => {
    const tool = makeCoreEvalTool();
    const { route } = dynamicFluidRoute({
      transcript: () =>
        buildTranscript({
          id: tool.manifest.id,
          ver: tool.version,
          action: CORE_EVAL_ACTION,
          errs: [{ kind: "exception", step: CORE_EVAL_ACTION, text: "boom" }],
          end: { rc: 8 },
        }),
    });
    const { conn } = await connected(route);
    const journal = new Journal(
      { dir: path.join(tmp, "journal"), enabled: true, maxEntries: 200, maxAgeDays: 30 },
      "A4H",
    );
    const d = depsFor(conn, gate(), tool, { journal });

    const err = await catchErr(
      dispatch(d, {
        tool: CORE_TOOL_ID,
        action: CORE_EVAL_ACTION,
        args: { lines: ["DATA(lv_zmcp_once) = 1."], out: [] },
        confirm: CORE_EVAL_CONFIRM,
      }),
    );

    expect(err.code).toBe("FLUID_ACTION_FAILED");
    const entries = await journal.list({ object: `${CORE_TOOL_ID}.${CORE_EVAL_ACTION}` });
    expect(entries).toHaveLength(0);
  });
});
