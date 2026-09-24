/**
 * Pins the LOCAL-package (`$TMP`) shape of the VIEW/DV bridge delete/undo
 * round trip. `abapDeleteViaBridge` (src/tools/write-bridge.ts) and
 * `resolveBridgeCreateUndo`/`performBridgeCreateUndo` (src/adt/undo.ts) both
 * resolve a VIEW/DV's package by reading it back through the VIT bridge
 * (`vitBridgeUri("viewdv", name)`), never from the caller's/journal's
 * `package` argument. `test/bridge-delete-transport-note.test.ts` already
 * drives the DELETE leg end to end with a server-resolved `$TMP` (its "NO
 * leftover-entry note" case), but under `allowPackages: ["*"]`. Two things
 * are genuinely unpinned: (a) the UNDO leg — the VIEW/DV block in
 * test/undo.test.ts always uses a transportable `REAL_PKG = "ZTM"`, so
 * `resolveBridgeCreateUndo`/`performBridgeCreateUndo` have never run against
 * a server-resolved `$TMP`; and (b) the delete leg under an allowlist that
 * names only `$TMP` rather than a wildcard. This is a characterisation pin
 * for those two gaps, not a bug fix. Same fake-`HttpClient` idiom as those
 * two files.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { Journal, systemKey, type JournalConfig } from "../src/journal.js";
import { abapWrite } from "../src/tools/write.js";
import { planUndo, performUndo, type UndoOptions } from "../src/adt/undo.js";
import { SafetyGate } from "../src/safety.js";
import { vitBridgeUri } from "../src/adt/write-verify.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { classicFake, useFluidState } from "./helpers/fluid-classic-fake.js";
import { CLASSIC_BODY_CLASS, CLASSIC_TOOL_ID } from "../src/adt/fluid/builtin/classic.js";
import { forgetManifest } from "../src/adt/fluid/registry.js";

const MAX = 20_000;

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

type Route = (r: Recorded) => HttpClientResponse | undefined;

const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse => ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const NOT_FOUND_XML = (name: string): string =>
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
  `<message lang="EN">${name} does not exist</message><properties/></exc:exception>`;

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

const fluidState = useFluidState();

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
    fluidApi: true,
    stateDir: fluidState.dir(),
  });

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(cfg(), {
    httpClient: adt,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

const VIEW = "ZTMD_V_LOCAL";
const VIT_URI = vitBridgeUri("viewdv", VIEW);

/**
 * `pkg === null` renders `<adtcore:packageRef />` — a space before the
 * self-close is required: `vitStubShowsRegistration` (src/adt/write-verify.ts)
 * matches `packageRef` followed by whitespace or `>`, so a bare
 * `<adtcore:packageRef/>` would misclassify as confirmed-absent instead of
 * "registered with no package".
 */
const vitXml = (pkg: string | null): string =>
  `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:type="VIEW/DV" adtcore:name="${VIEW}">` +
  (pkg === null ? "<adtcore:packageRef />" : `<adtcore:packageRef adtcore:name="${pkg}"/>`) +
  `</vit:properties>`;

/**
 * The allowlist names only `$TMP` (the view's own package) and
 * `FLUID_PACKAGE` (`$ABAPSMITH_FLUID_API`, src/adt/fluid/package.ts) — the
 * package the generated bridge class is deployed into (`BRIDGE_PACKAGE`,
 * src/adt/run.ts). `allowNamePrefixes` is widened to `["*"]` because
 * `ensureFluidPackage`'s own write names `$ABAPSMITH_FLUID_API` itself as the
 * target, which is `$`-prefixed rather than Z/Y. The point is that this is
 * not a wildcard admitting every package.
 */
const localGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP", FLUID_PACKAGE],
    allowNamePrefixes: ["*"],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

/**
 * Deploy -> run the delete bridge, routed through the shared `classicFake`
 * (the fluid package/invoker/classrun plumbing — see
 * test/helpers/fluid-classic-fake.ts) rather than this file's own former
 * fixed-name `ZCL_ZMCP_DDIC_DVIEW` routing. Toggles `state.exists` right as
 * the classrun call lands, so the post-delete VIT read reflects it, exactly
 * as before.
 */
const bridgeServer = (pkg: string | null, classrunLines: string[]) => {
  const state = { exists: true };
  const fake = classicFake({ action: "delete_view", lines: () => classrunLines });
  const route = (r: Recorded): HttpClientResponse | undefined => {
    if (r.url === VIT_URI && r.method === "GET") {
      return state.exists ? resp(200, vitXml(pkg), OK_XML) : resp(404, NOT_FOUND_XML(VIEW), OK_XML);
    }
    if (r.url.startsWith("/sap/bc/adt/oo/classrun/") && r.method === "POST") {
      state.exists = false;
    }
    return fake.route(r as unknown as HttpClientOptions);
  };
  return { state, route, fake };
};

let dir: string;
let journal: Journal;

const jcfg = (): JournalConfig => ({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 });

beforeEach(async () => {
  resetFluidEnsureState();
  resetFluidPackageMemo();
  // The fluid registry is an on-disk cache keyed by stateDir, and every test
  // in this file shares one stateDir (useFluidState() memoizes it per file).
  // Without this, an earlier test's deploy leaves a "classic is already at
  // this version" cache entry that makes a later test's own (empty,
  // per-test) classicFake skip the deploy entirely.
  await forgetManifest(cfg(), systemKey(cfg()), CLASSIC_TOOL_ID);
  dir = await mkdtemp(join(tmpdir(), "abap-view-local-delete-"));
  journal = new Journal(jcfg(), "A4H");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("VIEW/DV bridge delete: server-resolved package is the LOCAL $TMP", () => {
  it("(A) deletes through the classrun bridge, header names package $TMP, and no DELETE verb is ever sent", async () => {
    const gate = localGate();
    const { route, fake } = bridgeServer("$TMP", ["VIEW-DELETED", "VIEW-GONE"]);
    const { conn, adt } = await connected(route);

    const result = await abapWrite(conn, { object: VIEW, type: "VIEW/DV", mode: "delete" }, MAX, gate);

    expect(result.text).toMatch(/deleted:\s*true/);
    expect(result.text).toMatch(/package: \$TMP/);
    expect(result.text).toMatch(/VIEW-DELETED VIEW-GONE/);
    expect(adt.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
    // The old fixed BRIDGE_SRC_URI ("ZCL_ZMCP_DDIC_DVIEW"'s source) has no
    // subject left: the invoker class deployed is content-hash named, and
    // delete_view itself lives in the shared static ZCL_ZMCP_FLUID_CLASSIC
    // body, not in the invoker. Prove the same thing structurally.
    const invoker = fake.invoker();
    expect(invoker).toBeTruthy();
    expect(fake.sourceOf(invoker!)).toContain("zcl_zmcp_fluid_classic=>run( iv_action = 'delete_view'");
    expect(fake.sourceOf(CLASSIC_BODY_CLASS)).toContain("METHOD delete_view.");
    expect(adt.calls.some((c) => c.url.endsWith("/source/main") && c.method === "PUT")).toBe(true);
    expect(adt.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("(B) undo of the create journal entry plans and performs the delete using the SERVER-confirmed $TMP, not the journal's stored package", async () => {
    const gate = localGate();
    const { route } = bridgeServer("$TMP", ["VIEW-DELETED", "VIEW-GONE"]);
    const { conn, adt } = await connected(route);

    // "WRONG_PKG" is not a real package — a stand-in for a stale journal
    // record, same technique test/undo.test.ts uses (STALE_JOURNAL_PKG).
    const e = await journal.begin({
      operation: "create",
      object: { name: VIEW, type: "VIEW/DV", uri: VIT_URI, package: "WRONG_PKG" },
      existedBefore: false,
      beforeCapture: "confirmed-absent",
    });
    expect(e).toBeDefined();
    await journal.finish(e!.id, { outcome: "succeeded" });

    const entry = (await journal.get(e!.id))!;
    const plan = await planUndo(conn, journal, entry);

    expect(plan.action).toBe("delete");
    expect(plan.undoable).toBe(true);
    expect(plan.blocker).toBeUndefined();
    expect(plan.target.packageName).toBe("$TMP");
    expect(plan.target.packageSource).toBe("server");
    // planUndo settles target+existence off one VIT read for this type — no probe() GET follows.
    expect(adt.calls.filter((c) => c.url === VIT_URI && c.method === "GET")).toHaveLength(1);
    expect(adt.calls.some((c) => c.url.endsWith("/source/main"))).toBe(false);

    const allow: UndoOptions = {
      assertAllowed: (action, target) => gate.authorize(action === "delete" ? "delete" : "write", target),
      gate,
    };
    const res = await performUndo(conn, journal, entry, allow);

    expect(res.performed).toBe(true);
    expect(res.plan.action).toBe("delete");
    expect(adt.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
    expect(adt.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect((await journal.get(e!.id))!.undoneBy).toBeDefined();
  });
});

describe("VIEW/DV bridge delete: fail-closed when the VIT stub carries no package at all", () => {
  it("(C1) abap_write delete is refused SAFETY_DENIED/PACKAGE_UNKNOWN, and nothing beyond the one VIT read is ever sent", async () => {
    const gate = localGate();
    const { conn, adt } = await connected((r) =>
      r.url === VIT_URI && r.method === "GET" ? resp(200, vitXml(null), OK_XML) : undefined,
    );

    const err = await catchErr(abapWrite(conn, { object: VIEW, type: "VIEW/DV", mode: "delete" }, MAX, gate));

    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details.reason).toBe("PACKAGE_UNKNOWN");
    // `PACKAGE_UNKNOWN` alone is also reachable from the bridge-class deploy
    // path (a different refusal entirely) — pin the message/hint text this
    // specific delete-path refusal produces, not just the shared code.
    expect(String(err.message)).toMatch(/VIT bridge read answered but carried no <adtcore:packageRef> element/);
    expect(String(err.hint)).toMatch(/SE11\/SE14/);
    expect(adt.calls.filter((c) => c.url === VIT_URI && c.method === "GET")).toHaveLength(1);
    expect(adt.calls).toHaveLength(1);
  });

  it("(C2) planUndo on the same journal entry is refused: undoable false, blocker names the missing packageRef", async () => {
    const { conn } = await connected((r) =>
      r.url === VIT_URI && r.method === "GET" ? resp(200, vitXml(null), OK_XML) : undefined,
    );

    const e = await journal.begin({
      operation: "create",
      object: { name: VIEW, type: "VIEW/DV", uri: VIT_URI, package: "WRONG_PKG" },
      existedBefore: false,
      beforeCapture: "confirmed-absent",
    });
    expect(e).toBeDefined();
    await journal.finish(e!.id, { outcome: "succeeded" });

    const plan = await planUndo(conn, journal, (await journal.get(e!.id))!);

    expect(plan.undoable).toBe(false);
    expect(plan.blocker).toMatch(/no <adtcore:packageRef>/);
  });
});
