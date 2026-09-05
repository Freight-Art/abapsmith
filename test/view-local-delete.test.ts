/**
 * Pins the LOCAL-package (`$TMP`) shape of the VIEW/DV bridge delete/undo
 * round trip. `abapDeleteViaBridge` (src/tools/write.ts) and
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
import { Journal, type JournalConfig } from "../src/journal.js";
import { abapWrite } from "../src/tools/write.js";
import { planUndo, performUndo, type UndoOptions } from "../src/adt/undo.js";
import { SafetyGate } from "../src/safety.js";
import { DDIC_BRIDGE_CLASS } from "../src/adt/ddic-bridge.js";
import { vitBridgeUri } from "../src/adt/write-verify.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const MAX = 20_000;

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

type Route = (r: Recorded) => HttpClientResponse | undefined;

const OK_TEXT = { "content-type": "text/plain" };
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

const LOCK_XML =
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

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

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
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
const VIEW_BRIDGE = DDIC_BRIDGE_CLASS.deleteView;
const VIT_URI = vitBridgeUri("viewdv", VIEW);
const BRIDGE_COLLECTION = "/sap/bc/adt/oo/classes";
const BRIDGE_OBJ_URI = `${BRIDGE_COLLECTION}/${VIEW_BRIDGE.toLowerCase()}`;
const BRIDGE_SRC_URI = `${BRIDGE_OBJ_URI}/source/main`;

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
 * The allowlist names only `$TMP` — both the view's own package and
 * (`BRIDGE_PACKAGE`, src/adt/run.ts:231) the package the generated bridge
 * class is deployed into. `allowNamePrefixes` is left at the strict default
 * (`["Z","Y"]`, src/safety.ts) — ZTMD_V_LOCAL starts with Z, so it still
 * passes. The point is that this is not a wildcard admitting everything.
 */
const localGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP"],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

/** Deploy -> run the delete bridge; toggles `state.exists` so the post-delete VIT read reflects it. */
const bridgeServer = (pkg: string | null, classrunLines: string[]) => {
  const state = { exists: true };
  const route = (r: Recorded): HttpClientResponse | undefined => {
    if (r.url === VIT_URI && r.method === "GET") {
      return state.exists ? resp(200, vitXml(pkg), OK_XML) : resp(404, NOT_FOUND_XML(VIEW), OK_XML);
    }
    if (r.url === BRIDGE_OBJ_URI && r.method === "GET" && !r.qs._action) {
      return resp(404, NOT_FOUND_XML(VIEW_BRIDGE), OK_XML);
    }
    if (r.url === BRIDGE_COLLECTION && r.method === "POST") return resp(200, "", OK_TEXT);
    if (r.url === BRIDGE_OBJ_URI && r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
    if (r.url === BRIDGE_OBJ_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === BRIDGE_SRC_URI && r.method === "PUT") return resp(200, "", OK_TEXT);
    if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
    if (r.url.startsWith("/sap/bc/adt/oo/classrun/")) {
      state.exists = false;
      return resp(200, classrunLines.join("\n"), OK_TEXT);
    }
    return undefined;
  };
  return { state, route };
};

let dir: string;
let journal: Journal;

const jcfg = (): JournalConfig => ({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "abap-view-local-delete-"));
  journal = new Journal(jcfg(), "A4H");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("VIEW/DV bridge delete: server-resolved package is the LOCAL $TMP", () => {
  it("(A) deletes through the classrun bridge, header names package $TMP, and no DELETE verb is ever sent", async () => {
    const gate = localGate();
    const { route } = bridgeServer("$TMP", ["VIEW-DELETED", "VIEW-GONE"]);
    const { conn, adt } = await connected(route);

    const result = await abapWrite(conn, { object: VIEW, type: "VIEW/DV", mode: "delete" }, MAX, gate);

    expect(result.text).toMatch(/deleted:\s*true/);
    expect(result.text).toMatch(/package: \$TMP/);
    expect(result.text).toMatch(/VIEW-DELETED VIEW-GONE/);
    expect(adt.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
    expect(adt.calls.some((c) => c.url === BRIDGE_SRC_URI && c.method === "PUT")).toBe(true);
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
