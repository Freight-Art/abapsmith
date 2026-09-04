/**
 * Syntax check / activation / message rendering.
 *
 * Every fixture below is either copied verbatim from a live capture off A4H
 * on 2026-07-31, or, where the capture recorded the *content* but not the
 * envelope, reconstructed from the element and attribute names the capture
 * documents — each such fixture says so.
 *
 * No network: the transport is a fake `HttpClient` injected through
 * `ConnectionOptions.httpClient`, the pattern established in
 * test/circuit-breaker.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivationResult } from "abap-adt-api/build/api/activate.js";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection, type RawRequestOptions } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import type { ResolvedTarget } from "../src/adt/write.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import {
  activateObject,
  activateObjects,
  assertBatchActivated,
  assertNoErrors,
  attributeToTarget,
  buildActivationBody,
  checkFailedError,
  checkSource,
  checkThenActivate,
  chunkActivationTargets,
  displayInactive,
  isActivationOutcome,
  isFailureSeverity,
  isFanoutProneType,
  MAX_ACTIVATION_BATCH,
  mapInactiveObjects,
  parseStartFragment,
  prettyPrintSource,
  renderBatch,
  renderInactive,
  renderMessages,
  summariseMessages,
  translateActivationError,
  type ActivationOutcome,
  type ActivationTarget,
  type BatchActivationOutcome,
  type CheckOutcome,
} from "../src/adt/activate.js";
import { isDisplayTruncated } from "../src/truncate.js";
import { Journal } from "../src/journal.js";
import { abapActivate, activateInputSchema } from "../src/tools/activate.js";
import { ACTIVATION_ONLY_TYPES, REGISTRY } from "../src/adt/capabilities.js";
import { isEnhancementType, SafetyGate } from "../src/safety.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// --------------------------------------------------------------- fixtures ---

/**
 * VERBATIM — a live capture. Two syntax errors served with **HTTP 200**.
 * `@line="1"` / `@line="2"` are the message ORDINALS; the real source lines (4
 * and 5) exist only inside `@href`'s `#start=` fragment.
 */
const ACTIVATION_ERRORS = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Program ZMCP_PROBE_REP" type="E" line="1"
       href="/sap/bc/adt/programs/programs/zmcp_probe_rep/source/main#start=4,0"
       forceSupported="true">
    <shortText><txt>Incomplete expression: Operand (e.g. field) missing at end of statement.</txt></shortText>
  </msg>
  <msg objDescr="Program ZMCP_PROBE_REP" type="E" line="2"
       href="/sap/bc/adt/programs/programs/zmcp_probe_rep/source/main#start=5,0"
       forceSupported="true">
    <shortText><txt>The statement "WRIT" is not expected. A correct similar statement is "WRITE".</txt></shortText>
  </msg>
</chkl:messages>`;

/**
 * RECONSTRUCTED — live capture could not make the *activation* endpoint emit a
 * `W` on this system. The element shape is the captured one above with
 * `type="W"`; a `W`-only result must count as activated-with-warnings.
 */
const ACTIVATION_WARNING = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Program ZMCP_PROBE_REP" type="W" line="1"
       href="/sap/bc/adt/programs/programs/zmcp_probe_rep/source/main#start=3,2"
       forceSupported="true">
    <shortText><txt>The MOVE statement is obsolete. Use "=" instead.</txt></shortText>
  </msg>
</chkl:messages>`;

/**
 * RECONSTRUCTED envelope, VERBATIM content — from a live capture. The capture
 * recorded what checkruns said about the rejected DDL:
 *
 *   E  line 6 offset 13  Mandatory annotation "AbapCatalog.enhancementCategory" …
 *   W  line 2 offset 0   Annotation "AbapCatalog.enhancement.category" is not …
 *
 * wrapped here in the `chkrun:checkRunReports / chkrun:checkReport /
 * chkrun:checkMessageList / chkrun:checkMessage` structure the capture
 * documents and `abap-adt-api`'s `parseCheckResults` walks.
 */
const CHECKRUN_DDIC = `<?xml version="1.0" encoding="utf-8"?>
<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun">
  <chkrun:checkReport chkrun:reporter="abapCheckRun" chkrun:triggeringUri="/sap/bc/adt/ddic/tables/zmcp_probe_tab" chkrun:status="processed" chkrun:statusText="">
    <chkrun:checkMessageList>
      <chkrun:checkMessage chkrun:uri="/sap/bc/adt/ddic/tables/zmcp_probe_tab/source/main#start=6,13" chkrun:type="E" chkrun:shortText="Mandatory annotation &quot;AbapCatalog.enhancementCategory&quot; for structure ZMCP_PROBE_TAB is missing"/>
      <chkrun:checkMessage chkrun:uri="/sap/bc/adt/ddic/tables/zmcp_probe_tab/source/main#start=2,0" chkrun:type="W" chkrun:shortText="Annotation &quot;AbapCatalog.enhancement.category&quot; is not a valid annotation and will disappear on save"/>
    </chkrun:checkMessageList>
  </chkrun:checkReport>
</chkrun:checkRunReports>`;

/** RECONSTRUCTED: "Clean source → 200 with a 339-byte empty envelope ([])." */
const CHECKRUN_CLEAN = `<?xml version="1.0" encoding="utf-8"?>
<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:atom="http://www.w3.org/2005/Atom"/>`;

/**
 * RECONSTRUCTED — `<ioc:inactiveObjects>`, never triggered in the live
 * capture. Shape taken from `abap-adt-api`'s `parseInactive`.
 */
const ACTIVATION_INACTIVE = `<?xml version="1.0" encoding="utf-8"?>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/oo/classes/zmcp_dep" adtcore:type="CLAS/OC" adtcore:name="ZMCP_DEP" adtcore:parentUri=""/>
    </ioc:object>
  </ioc:entry>
</ioc:inactiveObjects>`;

/**
 * RECONSTRUCTED — the same `<ioc:inactiveObjects>` envelope with the `ioc:ref`
 * child missing from one entry. `abap-adt-api`'s `toElement` (api/activate.js)
 * returns `undefined` for an `ioc:object` that carries no `ioc:ref`, so this is
 * exactly the "object node is missing" record `mapInactiveObjects` must keep as
 * `(unknown)` rather than drop: dropping it would shrink `inactive` to length 0
 * and make a refused activation look clean.
 */
const ACTIVATION_INACTIVE_MALFORMED = `<?xml version="1.0" encoding="utf-8"?>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false"/>
  </ioc:entry>
</ioc:inactiveObjects>`;

/**
 * VERBATIM — `test/fixtures/live-captured/087-p3b-datapreview-t000.xml`, the
 * real 200 body of `SELECT mandt, cccategory, cccoractiv FROM t000` captured
 * from A4H. Client 000 → `CCCATEGORY "S"`, client 001 → `"C"`. `connect()` now
 * POSTs this probe and the read-only policy is FAIL-CLOSED (an unanswered route
 * classifies as `inconclusive` and locks writes out), so the fakes here log on
 * as client 001 and are served the real captured bytes — never a hand-written
 * plausible body. Mirrors test/session.test.ts.
 *
 * Imported, with `DATAPREVIEW_XML`, from ./helpers/system-role-fake.js.
 */

/** The source the two captured activation errors belong to (lines 4 and 5). */
const PROBE_SOURCE = [
  "REPORT zmcp_probe_rep.",
  "",
  "START-OF-SELECTION.",
  "  WRITE",
  "  WRIT 'hello'.",
].join("\n");

// ------------------------------------------------------------- transport ---

interface Route {
  match: (o: HttpClientOptions) => boolean;
  reply: HttpClientResponse;
}

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const XML = { "content-type": "application/xml; charset=utf-8" };

class RoutingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly routes: Route[]) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    const hit = this.routes.find((r) => r.match(o));
    // Anything unrouted is a connect-time request (login / discovery / ato).
    return hit ? hit.reply : resp(200, "ok", { "content-type": "text/plain" });
  }
  lastBody(urlFragment: string): string {
    const call = [...this.calls].reverse().find((c) => c.url.includes(urlFragment));
    return String(call?.body ?? "");
  }
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    // Client 001 is `CCCATEGORY "C"` in fixture 087 — i.e. provably NON-productive.
    // Without it the T000 row cannot be attributed and the fail-closed policy
    // locks writes out, which is not the system these tests are about.
    client: "001",
  });

const onActivation: Route["match"] = (o) => o.url.includes("/sap/bc/adt/activation");
const onCheckruns: Route["match"] = (o) => o.url.includes("/sap/bc/adt/checkruns");
const onDataPreview: Route["match"] = (o) => o.url.includes("/sap/bc/adt/datapreview/freestyle");

/**
 * `connect()` itself POSTs the T000 data-preview probe. Appended AFTER the
 * caller's routes so a test can still override it, and served the real captured
 * bytes so the fake system classifies as non-productive rather than
 * inconclusive.
 */
const T000_ROUTE: Route = {
  match: onDataPreview,
  reply: resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML),
};

async function connect(routes: Route[]): Promise<{ conn: AbapConnection; http: RoutingClient }> {
  const http = new RoutingClient([...routes, T000_ROUTE]);
  const conn = new AbapConnection(cfg(), {
    httpClient: http,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  return { conn, http };
}

/**
 * `activateObjects` POSTs through `AbapConnection.post()` directly (the
 * hand-rolled batch body — see module header), which enforces its own
 * `readOnly`/`ABAP_ALLOW_WRITE` gate independently of `SafetyGate`, so it
 * always needs a write-enabled connection. `activateObject`'s first POST
 * goes through the vendor `conn.adt.activate()` and does not hit that gate,
 * but its second POST — sent only when the first reply is an
 * `ioc:inactiveObjects` preaudit document — goes through `AbapConnection.post()`
 * and does, which is why the `ACTIVATION_INACTIVE` tests need this helper
 * too. `cfg()`/`connect()` above (readOnly by default) remains correct for
 * every test whose activation reply isn't a preaudit document.
 */
async function connectWrite(routes: Route[]): Promise<{ conn: AbapConnection; http: RoutingClient }> {
  const http = new RoutingClient([...routes, T000_ROUTE]);
  const conn = new AbapConnection(ConfigSchema.parse({ ...cfg(), readOnly: false }), {
    httpClient: http,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  return { conn, http };
}

/**
 * Same as `connectWrite`, but lets a test override the two DDIC-fan-out chunk
 * caps (`maxDdicActivationBatch` / `maxSafeActivationBatch`) so a chunk split
 * can be exercised end-to-end without a 7+/50+ object fixture.
 */
async function connectWriteWithCaps(
  routes: Route[],
  overrides: Partial<Pick<Config, "maxDdicActivationBatch" | "maxSafeActivationBatch">>,
): Promise<{ conn: AbapConnection; http: RoutingClient }> {
  const http = new RoutingClient([...routes, T000_ROUTE]);
  const conn = new AbapConnection(ConfigSchema.parse({ ...cfg(), readOnly: false, ...overrides }), {
    httpClient: http,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  return { conn, http };
}

const PROG_TARGET: ResolvedTarget = {
  spec: { type: "PROG/P" } as ResolvedTarget["spec"],
  type: "PROG/P",
  name: "ZMCP_PROBE_REP",
  uri: "/sap/bc/adt/programs/programs/zmcp_probe_rep",
  sourceUri: "/sap/bc/adt/programs/programs/zmcp_probe_rep/source/main",
  packageName: "$TMP",
  packageSource: "server",
  exists: true,
  description: "probe",
};

const TABL_TARGET: ResolvedTarget = {
  spec: { type: "TABL/DT" } as ResolvedTarget["spec"],
  type: "TABL/DT",
  name: "ZMCP_PROBE_TAB",
  uri: "/sap/bc/adt/ddic/tables/zmcp_probe_tab",
  sourceUri: "/sap/bc/adt/ddic/tables/zmcp_probe_tab/source/main",
  packageName: "$TMP",
  packageSource: "server",
  exists: true,
  description: "probe table",
};

/** A third, distinct object — used only where a batch needs a THIRD chunk. */
const PROG2_TARGET: ResolvedTarget = {
  spec: { type: "PROG/P" } as ResolvedTarget["spec"],
  type: "PROG/P",
  name: "ZMCP_PROBE_REP2",
  uri: "/sap/bc/adt/programs/programs/zmcp_probe_rep2",
  sourceUri: "/sap/bc/adt/programs/programs/zmcp_probe_rep2/source/main",
  packageName: "$TMP",
  packageSource: "server",
  exists: true,
  description: "probe 2",
};

/**
 * `GET {objectUri}` with `Accept: application/*` — the metadata document
 * `resolveWriteTarget` (src/adt/write.ts) reads the object's package off. The
 * `abapActivate` tool (src/tools/activate.ts) calls it once directly and, for
 * `mode=activate`, once more inside `authorizeMutation` — both against this
 * same URL — before it ever reaches `checkSource`/`activateObject`, so the
 * no-source tests below (which exercise the tool end to end, not just the
 * primitives) need this route wired up. Shape matches `OBJECT_XML` in
 * test/write.test.ts.
 */
const OBJECT_META = (name: string, type: string, packageName = "$TMP"): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${name}" adtcore:type="${type}">` +
  `<adtcore:packageRef adtcore:name="${packageName}"/>` +
  `</adtcore:objectMetadata>`;

const onProgMeta: Route["match"] = (o) => o.url === PROG_TARGET.uri;

/**
 * The no-source tests below are the only ones in this file that drive
 * `abapActivate` end to end through `resolveWriteTarget`/`authorizeMutation`,
 * which means more live-looking requests past `connect()` than any other test
 * here exercises (two metadata GETs plus the activation POST, versus one call
 * for everything else in this file). Without a real `x-csrf-token` coming back
 * from `/compatibility/graph`, `AdtHTTP` never latches `loggedin`, so EVERY one
 * of those requests pays for its own fresh logon — harmless on its own (each is
 * budgeted, one logon per logical request, per `RequestBudget`), but the
 * lifetime counter behind `LOGON_ENDPOINT_LIFETIME_CEILING` climbs on every one
 * of them regardless of budget (`noteWireRequest`, src/adt/connection.ts), and
 * `activateObject`'s own logon-if-needed call is unbudgeted (a direct
 * `conn.adt.*` call — see that file's `noteWireRequest` doc comment), so it is
 * the one that eventually trips the ceiling. This mirrors `LOGIN_HEADERS` in
 * test/write.test.ts: give the fake compat/graph endpoint a real token so the
 * client latches "logged in" once, like the real server does, instead of
 * silently re-authenticating before every single request.
 */
const onLogon: Route["match"] = (o) => o.url.includes("/sap/bc/adt/compatibility/graph");
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const LOGON_ROUTE: Route = { match: onLogon, reply: resp(200, "<graph/>", LOGIN_HEADERS) };

/**
 * A not-activated activation outcome, which is the shape the old
 * `errors > 0`-only gate waved through as a success. Overrides are applied last
 * so a test states only the field it is about.
 */
const activationOutcome = (o: Partial<ActivationOutcome> = {}): ActivationOutcome => ({
  activated: false,
  ok: false,
  messages: [],
  errors: 0,
  warnings: 0,
  inactive: [],
  ...o,
});

/** Run `fn`, require an `AbapError`, hand it back for field-level assertions. */
function catchAbap(fn: () => unknown): AbapError {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected an AbapError, but the call returned normally");
}

// ----------------------------------------------------------------- tests ---

describe("parseStartFragment", () => {
  it("extracts the real position from an activation href", () => {
    expect(
      parseStartFragment("/sap/bc/adt/programs/programs/zmcp_probe_rep/source/main#start=4,0"),
    ).toEqual({ line: 4, col: 0 });
  });

  it("extracts the position from a chkrun uri with a non-zero column", () => {
    expect(
      parseStartFragment("/sap/bc/adt/ddic/tables/zmcp_probe_tab/source/main#start=6,13"),
    ).toEqual({ line: 6, col: 13 });
  });

  it("tolerates a missing column and a trailing end= segment", () => {
    expect(parseStartFragment("/x/source/main#start=12")).toEqual({ line: 12, col: 0 });
    expect(parseStartFragment("/x/source/main#start=12,4;end=12,9")).toEqual({ line: 12, col: 4 });
  });

  it("returns undefined when there is no fragment at all", () => {
    expect(parseStartFragment("/sap/bc/adt/programs/programs/z/source/main")).toBeUndefined();
    expect(parseStartFragment(undefined)).toBeUndefined();
    expect(parseStartFragment("")).toBeUndefined();
    expect(parseStartFragment("/x#start=0,0")).toBeUndefined();
  });
});

describe("severity classification", () => {
  it("treats E, A and X as failures and W/I as not", () => {
    expect(isFailureSeverity("E")).toBe(true);
    expect(isFailureSeverity("A")).toBe(true);
    expect(isFailureSeverity("X")).toBe(true);
    expect(isFailureSeverity("W")).toBe(false);
    expect(isFailureSeverity("I")).toBe(false);
    expect(isFailureSeverity(undefined)).toBe(false);
  });
});

describe("activateObject — HTTP 200 is never the success signal", () => {
  it("treats 200 + empty body as activated", async () => {
    const { conn } = await connect([
      { match: onActivation, reply: resp(200, "", { "content-length": "0" }) },
    ]);
    const out = await activateObject(conn, PROG_TARGET);
    expect(out.activated).toBe(true);
    expect(out.ok).toBe(true);
    expect(out.messages).toEqual([]);
    expect(out.errors).toBe(0);
    expect(out.inactive).toEqual([]);
  });

  it("treats 200 + a chkl:messages error body as NOT activated", async () => {
    const { conn } = await connect([
      { match: onActivation, reply: resp(200, ACTIVATION_ERRORS, XML) },
    ]);
    const out = await activateObject(conn, PROG_TARGET);
    expect(out.activated).toBe(false);
    expect(out.ok).toBe(false);
    expect(out.errors).toBe(2);
    expect(out.warnings).toBe(0);
  });

  it("re-derives line numbers from the href — never from @line (the ordinal trap)", async () => {
    const { conn } = await connect([
      { match: onActivation, reply: resp(200, ACTIVATION_ERRORS, XML) },
    ]);
    const out = await activateObject(conn, PROG_TARGET);

    // @line was 1 and 2. The source lines are 4 and 5.
    expect(out.messages.map((m) => m.line)).toEqual([4, 5]);
    expect(out.messages.map((m) => m.col)).toEqual([0, 0]);
    expect(out.messages[0]!.objDescr).toBe("Program ZMCP_PROBE_REP");
    expect(out.messages[0]!.forceSupported).toBe(true);

    const rendered = renderMessages(out.messages);
    expect(rendered).toMatch(/^E line 4 col 0 /m);
    expect(rendered).toMatch(/^E line 5 col 0 /m);
    // The whole point: the ordinals must not appear as line numbers.
    expect(rendered).not.toMatch(/line 1\b/);
    expect(rendered).not.toMatch(/line 2\b/);
  });

  it("reports a W-only result as activated WITH warnings", async () => {
    const { conn } = await connect([
      { match: onActivation, reply: resp(200, ACTIVATION_WARNING, XML) },
    ]);
    const out = await activateObject(conn, PROG_TARGET);
    expect(out.activated).toBe(true);
    expect(out.errors).toBe(0);
    expect(out.warnings).toBe(1);
    expect(out.messages[0]).toMatchObject({ severity: "W", line: 3, col: 2 });
    expect(summariseMessages(out)).toBe("1 warning");
  });

  it("detects ioc:inactiveObjects and refuses to call that activated", async () => {
    const { conn } = await connectWrite([
      { match: onActivation, reply: resp(200, ACTIVATION_INACTIVE, XML) },
    ]);
    const out = await activateObject(conn, PROG_TARGET);
    expect(out.activated).toBe(false);
    expect(out.ok).toBe(false);
    expect(out.inactive).toEqual([
      { name: "ZMCP_DEP", type: "CLAS/OC", uri: "/sap/bc/adt/oo/classes/zmcp_dep" },
    ]);
  });

  it("sends preauditRequested=true and the object reference", async () => {
    const { conn, http } = await connect([{ match: onActivation, reply: resp(200, "") }]);
    await activateObject(conn, PROG_TARGET);
    const call = [...http.calls].reverse().find((o) => o.url.includes("/activation"))!;
    expect(call.method).toBe("POST");
    expect(call.qs).toMatchObject({ method: "activate", preauditRequested: true });
    expect(String(call.body)).toContain('adtcore:name="ZMCP_PROBE_REP"');
    expect(String(call.body)).toContain(
      'adtcore:uri="/sap/bc/adt/programs/programs/zmcp_probe_rep"',
    );
    // Never append sap-client.
    expect(call.url).not.toContain("sap-client");
  });

  it("translates the activate-while-locked 403 into a LOCKED error", async () => {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceNoAccess"/>
  <message lang="EN">User DEVELOPER is currently editing ZMCP_PROBE_REP</message>
  <properties/>
</exc:exception>`;
    const { conn } = await connect([{ match: onActivation, reply: resp(403, body, XML) }]);
    await expect(activateObject(conn, PROG_TARGET)).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "LOCKED" && /unlock/i.test(e.hint ?? ""),
    );
  });

  // activateObject's parameter narrowed from ResolvedTarget to
  // ActivationTarget ({name, uri}) — the only two fields the body ever reads.
  // A ResolvedTarget still satisfies it structurally (every test above passes
  // one unchanged), but this proves the narrower shape is really enough on its
  // own, with none of ResolvedTarget's write-path fields (sourceUri,
  // packageSource, ...) fabricated — the point of narrowing in the first
  // place.
  it("accepts a bare {name, uri} — no ResolvedTarget fields required", async () => {
    const { conn } = await connect([
      { match: onActivation, reply: resp(200, "", { "content-length": "0" }) },
    ]);
    const minimal: ActivationTarget = { name: PROG_TARGET.name, uri: PROG_TARGET.uri };
    const out = await activateObject(conn, minimal);
    expect(out.activated).toBe(true);
    expect(out.ok).toBe(true);
  });
});

// translateActivationError exported (was module-private) so a later
// wave's enhancement-specific activation error handling can reuse the same
// LOCKED-vs-ADT_ERROR classification instead of duplicating it, the way
// src/adt/bopf.ts's activateBusinessObject currently has to fall back to
// translateAdtError because this was not exported.
describe("translateActivationError — exported for reuse", () => {
  const target: ActivationTarget = { name: "ZMCP_PROBE_REP", uri: PROG_TARGET.uri };

  it("classifies a 403 ResourceNoAccess as LOCKED, given only {name, uri}", () => {
    const raw = Object.assign(new Error("User DEVELOPER is currently editing ZMCP_PROBE_REP"), {
      err: 403,
      type: "ExceptionResourceNoAccess",
    });
    const e = translateActivationError(raw, target);
    expect(e.code).toBe("LOCKED");
    expect(e.message).toContain("ZMCP_PROBE_REP");
    expect(e.hint).toMatch(/unlock/i);
  });

  it("falls back to ADT_ERROR for anything else", () => {
    const raw = Object.assign(new Error("Service unavailable"), { err: 503 });
    const e = translateActivationError(raw, target);
    expect(e.code).toBe("ADT_ERROR");
    expect(e.message).toContain("ZMCP_PROBE_REP");
  });
});

describe("checkSource — the pre-flight", () => {
  it("parses @chkrun:type / @chkrun:shortText / @chkrun:uri#start= (the DDIC case)", async () => {
    const { conn } = await connect([{ match: onCheckruns, reply: resp(200, CHECKRUN_DDIC, XML) }]);
    const out = await checkSource(conn, TABL_TARGET, "define table zmcp_probe_tab {}");

    expect(out.ok).toBe(false);
    expect(out.errors).toBe(1);
    expect(out.warnings).toBe(1);
    expect(out.messages[0]).toMatchObject({
      severity: "E",
      line: 6,
      col: 13,
      text: 'Mandatory annotation "AbapCatalog.enhancementCategory" for structure ZMCP_PROBE_TAB is missing',
    });
    expect(out.messages[1]).toMatchObject({
      severity: "W",
      line: 2,
      col: 0,
      text: 'Annotation "AbapCatalog.enhancement.category" is not a valid annotation and will disappear on save',
    });
  });

  it("returns ok with zero messages for the empty envelope", async () => {
    const { conn } = await connect([{ match: onCheckruns, reply: resp(200, CHECKRUN_CLEAN, XML) }]);
    const out = await checkSource(conn, PROG_TARGET, "REPORT z.");
    expect(out).toEqual({ ok: true, messages: [], errors: 0, warnings: 0 });
  });

  it("posts the source inline as base64 with the live capture's request shape", async () => {
    const { conn, http } = await connect([
      { match: onCheckruns, reply: resp(200, CHECKRUN_CLEAN, XML) },
    ]);
    const source = "REPORT zmcp_probe_rep.\nWRITE 'x'.";
    await checkSource(conn, PROG_TARGET, source);

    const call = [...http.calls].reverse().find((o) => o.url.includes("/checkruns"))!;
    expect(call.method).toBe("POST");
    expect(call.url).toContain("reporters=abapCheckRun");
    const body = String(call.body);
    // checkObject = the object URI, artifact = the source URI.
    expect(body).toContain(
      '<chkrun:checkObject adtcore:uri="/sap/bc/adt/programs/programs/zmcp_probe_rep" chkrun:version="active">',
    );
    expect(body).toContain(
      'chkrun:uri="/sap/bc/adt/programs/programs/zmcp_probe_rep/source/main"',
    );
    expect(body).toContain(Buffer.from(source, "utf8").toString("base64"));
    // No lock, no PUT — checkruns is the only request `checkSource` makes.
    // CHANGED: this used to assert `http.calls.filter(method === "POST")` had
    // length 1. That claim is now wrong for a reason that has nothing to do with
    // checkSource: `connect()` itself POSTs the T000 data-preview probe that
    // drives the fail-closed read-only policy, so the handshake contributes a
    // POST of its own. The assertion is narrowed to post-handshake traffic,
    // which is what it was ever trying to pin.
    const posts = http.calls.filter((c) => c.method === "POST" && !onDataPreview(c));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toContain("/checkruns");
  });

  it("wraps a transport-level failure as ADT_ERROR, not as a source problem", async () => {
    const { conn } = await connect([
      { match: onCheckruns, reply: resp(500, "<html>ICM</html>", { "content-type": "text/html" }) },
    ]);
    await expect(checkSource(conn, PROG_TARGET, "REPORT z.")).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "ADT_ERROR",
    );
  });
});

describe("prettyPrintSource — the ADT pretty-printer, not the system-wide setting", () => {
  const onPrettyPrinter: Route["match"] = (o) => o.url === "/sap/bc/adt/abapsource/prettyprinter";

  it("posts the source as text/plain and reports changed:true when the server reformats it", async () => {
    const formatted = "REPORT zmcp_probe_rep.\n\nSTART-OF-SELECTION.\n  WRITE 'hello'.\n  WRIT 'hello'.";
    const { conn, http } = await connect([
      { match: onPrettyPrinter, reply: resp(200, formatted, { "content-type": "text/plain" }) },
    ]);
    const out = await prettyPrintSource(conn, PROBE_SOURCE);
    expect(out.source).toBe(formatted);
    expect(out.changed).toBe(true);
    expect(out.linesChanged).toBeGreaterThan(0);

    const call = [...http.calls].reverse().find(onPrettyPrinter)!;
    expect(call.method).toBe("POST");
    expect(call.headers).toMatchObject({ "Content-Type": "text/plain" });
    expect(String(call.body)).toBe(PROBE_SOURCE);

    // No lock, no PUT — the pretty-printer is the only request `prettyPrintSource`
    // makes. Narrowed to post-handshake traffic for the same reason as checkSource's
    // equivalent assertion above: `connect()` itself POSTs the T000 probe.
    const posts = http.calls.filter((c) => c.method === "POST" && !onDataPreview(c));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("/sap/bc/adt/abapsource/prettyprinter");
    expect(http.calls.some((c) => c.url.includes("prettyprinter/settings"))).toBe(false);
  });

  it("reports changed:false when the formatter echoes the source back unchanged", async () => {
    const { conn, http } = await connect([
      { match: onPrettyPrinter, reply: resp(200, PROBE_SOURCE, { "content-type": "text/plain" }) },
    ]);
    const out = await prettyPrintSource(conn, PROBE_SOURCE);
    expect(out.source).toBe(PROBE_SOURCE);
    expect(out.changed).toBe(false);
    expect(out.linesChanged).toBe(0);
    expect(http.calls.some((c) => c.url.includes("prettyprinter/settings"))).toBe(false);
  });

  it("never calls prettyprinter/settings (setPrettyPrinterSetting) — only the stateless format verb", async () => {
    const { conn, http } = await connect([
      { match: onPrettyPrinter, reply: resp(200, PROBE_SOURCE, { "content-type": "text/plain" }) },
    ]);
    await prettyPrintSource(conn, PROBE_SOURCE);
    const posts = http.calls.filter((c) => c.method === "POST" && !onDataPreview(c));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).not.toContain("settings");
    expect(http.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("wraps a transport-level failure as ADT_ERROR, not a source problem", async () => {
    const { conn } = await connect([
      { match: onPrettyPrinter, reply: resp(500, "<html>ICM</html>", { "content-type": "text/html" }) },
    ]);
    await expect(prettyPrintSource(conn, PROBE_SOURCE)).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "ADT_ERROR",
    );
  });

  /**
   * Captured against real A4H: the pretty-printer endpoint answers with CRLF
   * line endings no matter what was sent (live verification). Left
   * un-normalised, those CRLF bytes would persist to the server while the
   * read/display path normalises CRLF→LF for display only — masking the
   * mismatch — and would leave a subsequent plain edit's LF-only splice
   * mixed with the untouched CRLF regions. `changed`/`linesChanged` must be
   * computed against the NORMALISED text, not the raw CRLF response, so a
   * formatter that only changed line-ending style (no textual change once
   * normalised) is correctly reported as `changed: false`.
   */
  it("normalises CRLF (and bare CR) from the formatter response to LF before returning or diffing", async () => {
    const formattedCrlf = PROBE_SOURCE.replace(/\n/g, "\r\n");
    const { conn } = await connect([
      { match: onPrettyPrinter, reply: resp(200, formattedCrlf, { "content-type": "text/plain" }) },
    ]);
    const out = await prettyPrintSource(conn, PROBE_SOURCE);

    expect(out.source).not.toMatch(/\r/);
    expect(out.source).toBe(PROBE_SOURCE);
    // Once normalised, the formatter's response is byte-identical to the
    // input — only the line endings differed — so this must NOT be reported
    // as a content change.
    expect(out.changed).toBe(false);
    expect(out.linesChanged).toBe(0);
  });

  it("counts real content changes correctly even when the response is CRLF, not inflated by line-ending artifacts", async () => {
    const formatted = "REPORT zmcp_probe_rep.\n\nSTART-OF-SELECTION.\n  WRITE 'hello'.\n  WRIT 'hello'.";
    const formattedCrlf = formatted.replace(/\n/g, "\r\n");
    const { conn } = await connect([
      { match: onPrettyPrinter, reply: resp(200, formattedCrlf, { "content-type": "text/plain" }) },
    ]);
    const out = await prettyPrintSource(conn, PROBE_SOURCE);

    expect(out.source).not.toMatch(/\r/);
    expect(out.source).toBe(formatted);
    expect(out.changed).toBe(true);
    // Same line-count delta as the plain-LF equivalent test above — CRLF vs
    // LF must not change how many lines are counted as differing.
    expect(out.linesChanged).toBe(1);
  });
});

describe("renderMessages", () => {
  const msgs = [
    { severity: "E", line: 5, col: 2, text: 'The statement "WRIT" is not expected.' },
    { severity: "W", line: 2, col: 0, text: "Obsolete statement." },
    { severity: "E", line: 4, col: 0, text: "Incomplete expression." },
  ];

  it("puts errors before warnings and orders by line inside a severity", () => {
    const lines = renderMessages(msgs).split("\n");
    expect(lines).toEqual([
      "E line 4 col 0  Incomplete expression.",
      'E line 5 col 2  The statement "WRIT" is not expected.',
      "W line 2 col 0  Obsolete statement.",
    ]);
  });

  it("inlines the offending source line with a caret at the column", () => {
    const rendered = renderMessages(
      [{ severity: "E", line: 5, col: 2, text: 'The statement "WRIT" is not expected.' }],
      PROBE_SOURCE,
    );
    expect(rendered).toBe(
      [
        'E line 5 col 2  The statement "WRIT" is not expected.',
        "  5 |   WRIT 'hello'.",
        "    |   ^",
      ].join("\n"),
    );
  });

  it("echoes the correct line for each of the two captured activation errors", async () => {
    const { conn } = await connect([
      { match: onActivation, reply: resp(200, ACTIVATION_ERRORS, XML) },
    ]);
    const out = await activateObject(conn, PROG_TARGET);
    const rendered = renderMessages(out.messages, PROBE_SOURCE);
    // CHANGED: the old expectation stopped after the second caret line, i.e. it
    // claimed the rendering of this body was exactly six lines. Both captured
    // messages carry `forceSupported="true"`, and `renderMessages` now appends
    // ONE trailing line saying the system reports the activation could be forced
    // and that abapsmith does not force it. The old assertion pinned the
    // behaviour in which a model was never told that option exists (and never
    // told we refuse it). The per-message block above is unchanged byte for
    // byte — that is the part this test exists to protect.
    expect(rendered.split("\n")).toEqual([
      "E line 4 col 0  Incomplete expression: Operand (e.g. field) missing at end of statement.",
      "  4 |   WRITE",
      "    | ^",
      'E line 5 col 0  The statement "WRIT" is not expected. A correct similar statement is "WRITE".',
      "  5 |   WRIT 'hello'.",
      "    | ^",
      "The ABAP system reports that this activation could be forced; " +
        "abapsmith does not force activation.",
    ]);
  });

  it("echoes a repeated line only once", () => {
    const rendered = renderMessages(
      [
        { severity: "E", line: 5, col: 2, text: "first" },
        { severity: "E", line: 5, col: 7, text: "second" },
      ],
      PROBE_SOURCE,
    );
    expect(rendered.split("\n").filter((l) => l.includes("WRIT 'hello'"))).toHaveLength(1);
    expect(rendered).toContain("E line 5 col 7  second");
  });

  it("survives a message with no position and a line past the end of the source", () => {
    expect(renderMessages([{ severity: "E", text: "no idea where" }], PROBE_SOURCE)).toBe(
      "E (no position)  no idea where",
    );
    expect(renderMessages([{ severity: "E", line: 999, col: 0, text: "off the end" }], PROBE_SOURCE))
      .toBe("E line 999 col 0  off the end");
  });

  it("prefixes the object only when several objects are involved", () => {
    const single = renderMessages([{ severity: "E", line: 1, text: "x", objDescr: "Program ZA" }]);
    expect(single).not.toContain("[Program ZA]");
    const multi = renderMessages([
      { severity: "E", line: 1, text: "x", objDescr: "Program ZA" },
      { severity: "E", line: 2, text: "y", objDescr: "Class ZB" },
    ]);
    expect(multi).toContain("[Program ZA] x");
    expect(multi).toContain("[Class ZB] y");
  });

  it("clips an absurdly long source line instead of blowing the token budget", () => {
    const long = "a".repeat(400);
    const rendered = renderMessages([{ severity: "E", line: 1, col: 0, text: "t" }], long);
    expect(rendered).toContain("…");
    expect(rendered.length).toBeLessThan(300);

    const echoLine = rendered.split("\n")[1];
    expect(isDisplayTruncated(echoLine)).toBe(true);
    expect(echoLine).not.toContain("\n");
  });

  it("returns an empty string for no messages", () => {
    expect(renderMessages([])).toBe("");
  });

  it("is deterministic", () => {
    expect(renderMessages(msgs, PROBE_SOURCE)).toBe(renderMessages(msgs, PROBE_SOURCE));
  });

  it("appends the force-activation line only when a message carries forceSupported", () => {
    const FORCE_LINE =
      "The ABAP system reports that this activation could be forced; " +
      "abapsmith does not force activation.";

    const plain = renderMessages([{ severity: "E", line: 4, col: 0, text: "boom" }]);
    expect(plain).toBe("E line 4 col 0  boom");
    expect(plain).not.toContain("force");

    const forced = renderMessages([
      { severity: "E", line: 4, col: 0, text: "boom", forceSupported: true },
    ]);
    // Per-message rendering is byte-identical; the line is appended AFTER it.
    expect(forced.split("\n")).toEqual(["E line 4 col 0  boom", FORCE_LINE]);

    // One line for the whole block, not one per message.
    const two = renderMessages([
      { severity: "E", line: 4, col: 0, text: "a", forceSupported: true },
      { severity: "E", line: 5, col: 0, text: "b", forceSupported: true },
    ]);
    expect(two.split("\n").filter((l) => l === FORCE_LINE)).toHaveLength(1);

    // Never on an empty message list.
    expect(renderMessages([])).toBe("");
  });
});

// ------------------------------------------------- inactive dependents ---

describe("renderInactive", () => {
  it("lists one `type name` per line and says to activate them first", () => {
    const rendered = renderInactive([
      { name: "ZCL_DEP", type: "CLAS/OC" },
      { name: "ZIF_DEP", type: "INTF/OI", uri: "/sap/bc/adt/oo/interfaces/zif_dep" },
    ]);
    expect(rendered.split("\n")).toEqual([
      "2 dependent objects are still inactive:",
      "  CLAS/OC ZCL_DEP",
      "  INTF/OI ZIF_DEP",
      "Activate them first, or activate them together with this object.",
    ]);
    // Never XML, and the uri is not noise in the caller-facing text.
    expect(rendered).not.toContain("ioc:");
    expect(rendered).not.toContain("/sap/bc/adt/");
  });

  it("uses the singular for one object and an empty string for none", () => {
    expect(renderInactive([{ name: "ZCL_DEP", type: "CLAS/OC" }]).split("\n")).toEqual([
      "1 dependent object is still inactive:",
      "  CLAS/OC ZCL_DEP",
      "Activate them first, or activate them together with this object.",
    ]);
    expect(renderInactive([])).toBe("");
  });

  it("discloses the unnamed count with a trailing line when there is at least one named object", () => {
    const lines = renderInactive([
      { name: "ZCL_DEP", type: "CLAS/OC" },
      { name: "(unknown)", type: "(unknown)" },
    ]).split("\n");
    expect(lines[0]).toBe("1 dependent object is still inactive:");
    expect(lines).toContain("  CLAS/OC ZCL_DEP");
    expect(lines[lines.length - 1]).toBe(
      "1 more inactive dependent had no name/type in SAP's reply and is omitted above.",
    );
  });

  it("on an all-unnamed list still produces a sensible non-empty string and never says 0 dependent", () => {
    const rendered = renderInactive([
      { name: "(unknown)", type: "(unknown)" },
      { name: "", type: "" },
    ]);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain("0 dependent");
    expect(rendered).toContain("2 dependent objects are still inactive");
  });
});

describe("displayInactive", () => {
  it("folds the same name+type reached under two different uris into one object, keeping the first occurrence's uri", () => {
    const result = displayInactive([
      { name: "ZFOO", type: "FUGR/F", uri: "/sap/bc/adt/functions/groups/zfoo/source/main#a" },
      { name: "ZFOO", type: "FUGR/F", uri: "/sap/bc/adt/functions/groups/zfoo/source/main#b" },
    ]);
    expect(result.objects).toEqual([
      { name: "ZFOO", type: "FUGR/F", uri: "/sap/bc/adt/functions/groups/zfoo/source/main#a" },
    ]);
    expect(result.unnamed).toBe(0);
  });

  it("routes (unknown)/(unknown) to unnamed, never into objects", () => {
    const result = displayInactive([
      { name: "(unknown)", type: "(unknown)" },
      { name: "ZCL_DEP", type: "CLAS/OC" },
    ]);
    expect(result.objects).toEqual([{ name: "ZCL_DEP", type: "CLAS/OC" }]);
    expect(result.unnamed).toBe(1);
  });

  it("is case-insensitive on name and type", () => {
    const result = displayInactive([
      { name: "zfoo", type: "fugr/f" },
      { name: "ZFOO", type: "FUGR/F" },
    ]);
    expect(result.objects).toHaveLength(1);
  });
});

describe("mapInactiveObjects", () => {
  /** `abap-adt-api`'s `toElement` yields `undefined` when `ioc:ref` is absent. */
  const malformed: ActivationResult = {
    success: false,
    messages: [],
    inactive: [{ object: undefined, transport: undefined }],
  };

  it("keeps a record whose object node is missing as (unknown) instead of dropping it", () => {
    expect(mapInactiveObjects(malformed)).toEqual([{ name: "(unknown)", type: "(unknown)" }]);
  });

  it("still fails the activation for an entry it could not name", () => {
    const out: ActivationOutcome = {
      activated: false,
      ok: false,
      messages: [],
      errors: 0,
      warnings: 0,
      inactive: mapInactiveObjects(malformed),
    };
    const err = catchAbap(() => assertNoErrors(out, { what: "Activation", name: "ZMCP_PROBE_REP" }));
    expect(err.code).toBe("CHECK_FAILED");
    // The entry has no name/type, so it can no longer be named "(unknown)" —
    // but SAP's reply listing one unnamed inactive dependent must still
    // surface as a real failure, not fold away silently.
    expect(err.message).toContain(
      "SAP's reply listed 1 inactive dependent but gave no name or type for it",
    );
    expect(err.details.inactive).toHaveLength(1);
  });

  it("maps the captured-shape entry through the whole activation path", async () => {
    const { conn } = await connect([
      { match: onActivation, reply: resp(200, ACTIVATION_INACTIVE_MALFORMED, XML) },
    ]);
    const out = await activateObject(conn, PROG_TARGET);
    expect(out.inactive).toEqual([{ name: "(unknown)", type: "(unknown)" }]);
    expect(out.activated).toBe(false);
  });
});

describe("isActivationOutcome", () => {
  it("distinguishes an activation outcome from a plain check outcome", () => {
    const act: ActivationOutcome = {
      activated: true,
      ok: true,
      messages: [],
      errors: 0,
      warnings: 0,
      inactive: [],
    };
    const chk: CheckOutcome = { ok: true, messages: [], errors: 0, warnings: 0 };
    expect(isActivationOutcome(act)).toBe(true);
    expect(isActivationOutcome(chk)).toBe(false);
    // `activated: false` is still an activation outcome — the narrowing is on
    // the KEY, not its value, which is the whole point.
    expect(isActivationOutcome({ ...act, activated: false })).toBe(true);
  });
});

// ------------------------------------------- assertNoErrors regressions ---

/**
 * `assertNoErrors` used to be gated on `outcome.errors > 0` alone, so an
 * `ActivationOutcome` that was never activated — inactive dependents, or the
 * library reporting `success: false` with an empty message list — was returned
 * as a SUCCESS. `run.ts` then executed a never-activated bridge class and handed
 * back the STALE output of the previously active version as a real answer. Every
 * test in this block fails against that old gate.
 */
describe("assertNoErrors — a not-activated activation is never a success", () => {
  it("throws when dependents are left inactive, even with zero errors", () => {
    const out = activationOutcome({ inactive: [{ name: "ZCL_DEP", type: "CLAS/OC" }] });
    const err = catchAbap(() => assertNoErrors(out, { what: "Activation", name: "ZMCP_PROBE_REP" }));

    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("ZMCP_PROBE_REP was NOT activated");
    expect(err.message).toContain("CLAS/OC ZCL_DEP");
    expect(err.details.inactive).toEqual([{ name: "ZCL_DEP", type: "CLAS/OC" }]);
    expect(err.details.activated).toBe(false);
    // The caller-facing remedy, not XML.
    expect(String(err.hint)).toContain("Activate them first");
  });

  it("counts the dependents it cannot name and still names the first ten", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `ZCL_D${i}`, type: "CLAS/OC" }));
    const err = catchAbap(() =>
      assertNoErrors(activationOutcome({ inactive: many }), {
        what: "Activation",
        name: "ZMCP_PROBE_REP",
      }),
    );
    expect(err.message).toContain("12 dependent objects are still inactive");
    expect(err.message).toContain("ZCL_D9");
    expect(err.message).toContain("+2 more");
    expect(err.details.inactive).toHaveLength(12);
  });

  it("throws when activation reported failure without any message at all", () => {
    const out = activationOutcome({ activated: false, errors: 0, warnings: 0, messages: [] });
    const err = catchAbap(() => assertNoErrors(out, { what: "Activation", name: "ZMCP_PROBE_REP" }));

    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toBe("Activation of ZMCP_PROBE_REP reported failure without any message.");
    expect(err.details.activated).toBe(false);
  });

  it("throws when it is not activated but only warnings came back", () => {
    const out = activationOutcome({
      activated: false,
      warnings: 1,
      messages: [{ severity: "W", line: 3, col: 2, text: "The MOVE statement is obsolete." }],
    });
    const err = catchAbap(() => assertNoErrors(out, { what: "Activation", name: "ZMCP_PROBE_REP" }));

    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("ZMCP_PROBE_REP was NOT activated");
    // The warnings are still rendered, so the caller sees why.
    expect(String(err.details.messages)).toContain("W line 3 col 2  The MOVE statement is obsolete.");
  });

  it("returns an activated-with-warnings outcome unchanged (do not over-tighten)", () => {
    const out = activationOutcome({
      activated: true,
      ok: true,
      warnings: 2,
      inactive: [],
      messages: [
        { severity: "W", line: 3, col: 2, text: "obsolete" },
        { severity: "W", line: 9, col: 0, text: "unused" },
      ],
    });
    // Warnings are the warning channel, not a failure.
    expect(assertNoErrors(out, { what: "Activation", name: "ZMCP_PROBE_REP" })).toBe(out);
  });

  it("leaves a plain CheckOutcome behaving exactly as before", () => {
    const clean: CheckOutcome = { ok: true, messages: [], errors: 0, warnings: 0 };
    expect(assertNoErrors(clean, { what: "Syntax check" })).toBe(clean);

    // No `activated` key ⇒ the activation rule must not fire, not even when the
    // outcome looks unhappy in every other way.
    const notOk: CheckOutcome = {
      ok: false,
      messages: [{ severity: "W", line: 2, text: "w" }],
      errors: 0,
      warnings: 1,
    };
    expect(assertNoErrors(notOk, { what: "Syntax check" })).toBe(notOk);

    const bad: CheckOutcome = {
      ok: false,
      messages: [{ severity: "E", line: 2, text: "e" }],
      errors: 1,
      warnings: 0,
    };
    const err = catchAbap(() => assertNoErrors(bad, { what: "Syntax check", name: "Z" }));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("1 error");
    expect(err.details.activated).toBeUndefined();
  });

  it("rejects a real ioc:inactiveObjects activation end to end", async () => {
    const { conn } = await connectWrite([
      { match: onActivation, reply: resp(200, ACTIVATION_INACTIVE, XML) },
    ]);
    const out = await activateObject(conn, PROG_TARGET);
    expect(out.errors).toBe(0);
    expect(out.warnings).toBe(0);
    expect(out.inactive).toEqual([
      { name: "ZMCP_DEP", type: "CLAS/OC", uri: "/sap/bc/adt/oo/classes/zmcp_dep" },
    ]);

    // The old error-count gate returned this as a success and the caller ran the
    // never-activated object.
    const err = catchAbap(() => assertNoErrors(out, { what: "Activation", name: "ZMCP_PROBE_REP" }));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("ZMCP_DEP");
    expect(err.message).toContain("NOT activated");
  });
});

describe("checkThenActivate", () => {
  it("throws when a clean pre-check is followed by an activation with inactive dependents", async () => {
    const { conn } = await connectWrite([
      { match: onCheckruns, reply: resp(200, CHECKRUN_CLEAN, XML) },
      { match: onActivation, reply: resp(200, ACTIVATION_INACTIVE, XML) },
    ]);
    await expect(checkThenActivate(conn, PROG_TARGET, PROBE_SOURCE)).rejects.toSatisfy(
      (e: unknown) =>
        isAbapError(e) &&
        e.code === "CHECK_FAILED" &&
        /NOT activated/.test(e.message) &&
        /ZMCP_DEP/.test(e.message),
    );
  });

  it("throws on a failed pre-check without ever touching the activation endpoint", async () => {
    const { conn, http } = await connect([
      { match: onCheckruns, reply: resp(200, CHECKRUN_DDIC, XML) },
      { match: onActivation, reply: resp(200, "") },
    ]);
    await expect(checkThenActivate(conn, TABL_TARGET, "define table zmcp_probe_tab {}")).rejects
      .toSatisfy((e: unknown) => isAbapError(e) && e.code === "CHECK_FAILED");
    expect(http.calls.filter((c) => onActivation(c))).toHaveLength(0);
  });

  it("returns the activation outcome when both stages are clean", async () => {
    const { conn } = await connect([
      { match: onCheckruns, reply: resp(200, CHECKRUN_CLEAN, XML) },
      { match: onActivation, reply: resp(200, "", { "content-length": "0" }) },
    ]);
    const out = await checkThenActivate(conn, PROG_TARGET, PROBE_SOURCE);
    expect(out.activated).toBe(true);
    expect(out.inactive).toEqual([]);
  });
});

describe("CHECK_FAILED", () => {
  it("carries the rendered messages, never XML", async () => {
    const { conn } = await connect([
      { match: onActivation, reply: resp(200, ACTIVATION_ERRORS, XML) },
    ]);
    const out = await activateObject(conn, PROG_TARGET);
    const err = checkFailedError(out, {
      what: "Activation",
      name: "ZMCP_PROBE_REP",
      source: PROBE_SOURCE,
    });
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("2 errors");
    const messages = String(err.details.messages);
    expect(messages).toContain("E line 4 col 0");
    expect(messages).not.toContain("<msg");
    expect(messages).not.toContain("chkl:");
    expect(err.toJSON()).toMatchObject({ error: "CHECK_FAILED" });
  });

  it("assertNoErrors throws on errors and passes warnings through", () => {
    const warn = {
      ok: true,
      errors: 0,
      warnings: 1,
      messages: [{ severity: "W", line: 2, text: "w" }],
    };
    expect(assertNoErrors(warn, { what: "Syntax check" })).toBe(warn);
    const bad = { ok: false, errors: 1, warnings: 0, messages: [{ severity: "E", line: 2, text: "e" }] };
    expect(() => assertNoErrors(bad, { what: "Syntax check" })).toThrow(/failed/);
  });
});

// -------------------------------------- abap_activate with no `source` ---

/**
 * `abap_activate` used to build `input.source ??
 * ""` and feed the result to `checkSource` unconditionally, which put an empty
 * string in front of `abap-adt-api`'s `syntaxCheck` — and that library throws
 * "mainUrl and content are required for syntax check" on falsy content, for
 * every generic (non-CDS) object, BEFORE any HTTP request goes out. Confirmed
 * live 3/3 on the appliance and 19/19 in an earlier E2E report for
 * `mode=activate` on a already-saved object.
 *
 * These run the REAL `abapActivate` (src/tools/activate.ts) against a fake
 * HTTP transport — `checkSource`/`activateObject`/`resolveWriteTarget` are all
 * the genuine implementations, not mocks (unlike test/tools.test.ts, which
 * mocks `../src/adt/activate.js` wholesale and so cannot see this bug at all).
 * That is the point: a green result here means the empty-string call was never
 * made, not that a mock politely agreed it wasn't.
 */
describe("abapActivate — no `source`", () => {
  it("mode=activate with no source never calls checkSource, and activates the saved version directly", async () => {
    const { conn, http } = await connect([
      LOGON_ROUTE,
      { match: onProgMeta, reply: resp(200, OBJECT_META(PROG_TARGET.name, PROG_TARGET.type), XML) },
      { match: onActivation, reply: resp(200, "", { "content-length": "0" }) },
    ]);
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

    const res = await abapActivate(
      conn,
      { object: PROG_TARGET.name, type: PROG_TARGET.type },
      100_000,
      gate,
    );

    // Old behaviour: this line would never be reached — `checkSource` threw
    // the library's untyped exception before `abapActivate` could return.
    expect(res.text).toContain("activated: true");
    expect(res.text).toContain("mode: activate");
    expect(res.text).toContain("No `source` was supplied, so no pre-flight syntax check ran");

    // The real assertion: no request to /checkruns was ever made. Only the two
    // metadata GETs (resolveWriteTarget, then authorizeMutation's re-resolve)
    // and the activation POST should have gone out, post-connect-handshake.
    expect(http.calls.some((c) => onCheckruns(c))).toBe(false);
    expect(http.calls.some((c) => onActivation(c))).toBe(true);
  });

  // mode=check with no `source` used to refuse unconditionally
  // (BAD_INPUT) even though the object's source is sitting right there on
  // the server — the #2 source of BAD_INPUT in the v1-vs-v2 A/B sweep.
  // Now it fetches the saved source and checks THAT, at the cost of one
  // extra ADT read (`GET .../source/main`) beyond the checkruns POST that
  // would run anyway.
  const onProgSource: Route["match"] = (o) => o.url === PROG_TARGET.sourceUri;

  it("mode=check with no source fetches and checks the saved server source instead of refusing", async () => {
    const { conn, http } = await connect([
      LOGON_ROUTE,
      { match: onProgMeta, reply: resp(200, OBJECT_META(PROG_TARGET.name, PROG_TARGET.type), XML) },
      { match: onProgSource, reply: resp(200, PROBE_SOURCE, { "content-type": "text/plain" }) },
      { match: onCheckruns, reply: resp(200, CHECKRUN_CLEAN, XML) },
    ]);
    // No gate assertion is expected on this path (mode=check never reaches the
    // gate — see the module header of src/tools/activate.ts), so any config is
    // fine; read-only proves the point that this has nothing to do with the
    // write/activate safety gate at all.
    const gate = new SafetyGate({ readOnly: true, allowPackages: [] });

    const res = await abapActivate(
      conn,
      { object: PROG_TARGET.name, type: PROG_TARGET.type, mode: "check" },
      100_000,
      gate,
    );

    expect(res.text).toContain("result: clean");
    expect(res.text).toContain(
      "NOTE: No `source` was supplied, so the version already saved on the server was fetched " +
        "and checked instead",
    );

    // The fetched source actually went out to checkruns, base64-encoded —
    // not an empty string, and not the library's untyped exception.
    const checkrunsCall = http.calls.find((c) => onCheckruns(c))!;
    expect(String(checkrunsCall.body)).toContain(
      Buffer.from(PROBE_SOURCE, "utf8").toString("base64"),
    );
    expect(http.calls.some((c) => onProgSource(c))).toBe(true);
    expect(http.calls.some((c) => onActivation(c))).toBe(false);
  });

  it("mode=check with no source and no retrievable saved source (supportsSource: false) is a clean BAD_INPUT", async () => {
    // DTEL/DE: writable/creatable (so resolveWriteTarget's op=activate
    // writability gate passes and the metadata GET runs), but
    // `supportsSource: false` in src/adt/types.ts — /source/main 404s live.
    // The genuine refusal case this guards: nothing was fetched, because
    // there is nothing retrievable to fetch.
    const DTEL_URI = "/sap/bc/adt/ddic/dataelements/zmcp_probe_de";
    const { conn, http } = await connect([
      LOGON_ROUTE,
      { match: (o) => o.url === DTEL_URI, reply: resp(200, OBJECT_META("ZMCP_PROBE_DE", "DTEL/DE"), XML) },
    ]);
    const gate = new SafetyGate({ readOnly: true, allowPackages: [] });

    const err = await abapActivate(
      conn,
      { object: "ZMCP_PROBE_DE", type: "DTEL/DE", mode: "check" },
      100_000,
      gate,
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(isAbapError(err)).toBe(true);
    const e = err as AbapError;
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toContain("no retrievable");
    // Never the library's raw exception text leaking through as a "fix".
    expect(e.message).not.toContain("mainUrl and content are required");

    // No source GET, no checkruns, no activation — refused before any of
    // those requests went out.
    expect(http.calls.some((c) => c.url.includes("/source/main"))).toBe(false);
    expect(http.calls.some((c) => onCheckruns(c))).toBe(false);
    expect(http.calls.some((c) => onActivation(c))).toBe(false);
  });

  it("mode=check with no source on an object that does not exist yet is a clean BAD_INPUT (nothing saved to fetch)", async () => {
    const NOT_FOUND_XML =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">' +
      '<message lang="EN">ZMCP_PROBE_REP does not exist</message><properties/></exc:exception>';
    const { conn, http } = await connect([
      LOGON_ROUTE,
      { match: onProgMeta, reply: resp(404, NOT_FOUND_XML, XML) },
    ]);
    const gate = new SafetyGate({ readOnly: true, allowPackages: [] });

    const err = await abapActivate(
      conn,
      { object: PROG_TARGET.name, type: PROG_TARGET.type, mode: "check" },
      100_000,
      gate,
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(isAbapError(err)).toBe(true);
    const e = err as AbapError;
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toContain("does not exist");

    expect(http.calls.some((c) => onProgSource(c))).toBe(false);
    expect(http.calls.some((c) => onCheckruns(c))).toBe(false);
    expect(http.calls.some((c) => onActivation(c))).toBe(false);
  });
});

/**
 * The same defect `targetFromInput` fixed in `abap_write` (see its long comment
 * in src/tools/write.ts), still live in this tool until now: `abapActivate`
 * parsed the object ref HINTLESS and kept only `parsed.name`, so for a
 * container-parented type the group was stripped off the name and then thrown
 * away. Found on A4H while verifying the new `FUGR/F` capability:
 *
 *   abap_activate {object: "ZFGFIX_FM1 in ZFGFIX_G1", type: "FUGR/FF"}
 *     → BAD_INPUT "Function module ZFGFIX_FM1 lives inside a container object,
 *       and none was named."
 *
 * — i.e. the tool refused the exact spelling its OWN hint recommends, while
 * `"ZFGFIX_G1/ZFGFIX_FM1"` worked only by the accident that a hintless parse
 * leaves the slash form intact for `resolveWriteTarget` to re-parse WITH the
 * type. Both spellings must reach the same function-module URI.
 */
describe("abapActivate — container-parented types (FUGR/FF)", () => {
  const GROUP_URI = "/sap/bc/adt/functions/groups/zfgfix_g1";
  const FM_URI = `${GROUP_URI}/fmodules/zfgfix_fm1`;

  it.each(["ZFGFIX_G1/ZFGFIX_FM1", "ZFGFIX_FM1 in ZFGFIX_G1"])(
    "activates the module named as %s",
    async (object) => {
      const { conn, http } = await connect([
        LOGON_ROUTE,
        // A function module's own metadata document carries no packageRef;
        // resolution reads the GROUP's (see test/write.test.ts).
        {
          match: (o) => o.url === FM_URI,
          reply: resp(
            200,
            `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
              `adtcore:name="ZFGFIX_FM1" adtcore:type="FUGR/FF"/>`,
            XML,
          ),
        },
        {
          match: (o) => o.url === GROUP_URI,
          reply: resp(200, OBJECT_META("ZFGFIX_G1", "FUGR/F"), XML),
        },
        { match: onActivation, reply: resp(200, "", { "content-length": "0" }) },
      ]);
      const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

      const res = await abapActivate(conn, { object, type: "FUGR/FF" }, 100_000, gate);

      expect(res.text).toContain("activated: true");
      // The address actually resolved — not `…/groups//fmodules/…`, and not a
      // BAD_INPUT before a single request went out.
      expect(res.text).toContain(FM_URI);
      expect(http.calls.some((c) => c.url === FM_URI)).toBe(true);
    },
  );
});

/**
 * The third instance of the capability/gate/schema defect class (the first
 * was fixed for `abap_write` by adding `affects` to `writeInputSchema` — see
 * test/write.test.ts's describe blocks covering the same gap, which this
 * mirrors).
 *
 * Before this fix, `abap_activate` could not reach an EXISTING `ENHO/XH`
 * (BAdI implementation) or `ENHS/XS` (enhancement spot) at all:
 * `resolveWriteTarget` refused both with `UNSUPPORTED` BEFORE any network
 * call, because neither type was in `CREATABLE_TYPES` nor `ENHANCEABLE_TYPES`
 * — even though the low-level `activateObject` primitive (src/adt/activate.ts)
 * already works for ENHO/XH (see `391-activate-success-enhoxh.meta.json`,
 * referenced in that module) and only needs `{name, uri}`. The fix threads a
 * new `op: "write" | "delete" | "activate"` parameter through
 * `resolveWriteTarget`/`authorizeMutation` (src/adt/write.ts) so `"activate"`
 * additionally admits `ACTIVATION_ONLY_TYPES` (capabilities.ts) — and adds
 * `affects` to `activateInputSchema` so a caller can supply the
 * `EnhancementIntent` safety.ts requires, the same shape `abap_write`
 * already uses.
 */
describe("invariant: no REGISTRY type abap_activate can reach that isEnhancementType() matches lacks a schema path to affects", () => {
  it("every REGISTRY entry resolveWriteTarget(op:'activate') can resolve (create, write, or activate) that isEnhancementType() matches is reachable via a field on abap_activate's own schema", () => {
    // Mirrors the equivalent walk for abap_write (test/write.test.ts,
    // "invariant: no REGISTRY type may declare `write`…") — same class of
    // check, scoped to what `op: "activate"` admits rather than what `write`
    // admits: create OR write OR the new `activate: true` flag.
    const activatableEnhancementTypes = Object.entries(REGISTRY)
      .filter(([, c]) => c.create !== undefined || c.write !== undefined || c.activate === true)
      .map(([type]) => type)
      .filter((type) => isEnhancementType(type));
    // Sanity: if this walk found nothing, the assertion below would be
    // vacuously true and the invariant would not actually be closed. The two
    // types this task's fix was about must be among them, or this test is
    // testing nothing.
    expect(activatableEnhancementTypes).toEqual(expect.arrayContaining(["ENHO/XH", "ENHS/XS"]));
    for (const type of activatableEnhancementTypes) {
      expect(
        Object.keys(activateInputSchema),
        `capabilities.ts marks ${type} reachable for activation (create/write/activate), and ` +
          "isEnhancementType() matches it, so safety.ts's evaluate() will demand an " +
          "EnhancementIntent before this type can ever be activated — but abap_activate's " +
          "own registered schema has no `affects` field for a caller to build one from. See " +
          "src/tools/activate.ts's `affects` field.",
      ).toContain("affects");
    }
  });
});

describe("abapActivate — ENHO/XH and ENHS/XS (third instance: capability + gate + schema)", () => {
  const ENHO_URI = "/sap/bc/adt/enhancements/enhoxh/zenh_badi";
  const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
    <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
    <message lang="EN">ZENH_BADI does not exist</message><properties/></exc:exception>`;

  it("declares `affects` on activateInputSchema, mirroring abap_write's own field", () => {
    expect(Object.keys(activateInputSchema)).toContain("affects");
  });

  it("ACTIVATION_ONLY_TYPES names both ENHO/XH and ENHS/XS — the two types this fix reaches", () => {
    expect(ACTIVATION_ONLY_TYPES).toEqual(expect.arrayContaining(["ENHO/XH", "ENHS/XS"]));
  });

  it("activates an EXISTING ENHO/XH end to end once `affects` is supplied and the gate allows it — previously UNSUPPORTED before any network call", async () => {
    const { conn, http } = await connect([
      LOGON_ROUTE,
      { match: (o) => o.url === ENHO_URI, reply: resp(200, OBJECT_META("ZENH_BADI", "ENHO/XH", "$TMP"), XML) },
      { match: onActivation, reply: resp(200, "", { "content-length": "0" }) },
    ]);
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      allowEnhancements: true,
      enhanceTargets: "customer",
      originSystems: ["A4H"],
    });

    const res = await abapActivate(
      conn,
      {
        object: "ZENH_BADI",
        type: "ENHO/XH",
        affects: { name: "ZTARGET_CLS", packageName: "ZTARGET_PKG", masterSystem: "A4H" },
      },
      100_000,
      gate,
    );

    expect(res.text).toContain("activated: true");
    expect(http.calls.some((c) => c.url === ENHO_URI)).toBe(true);
    expect(http.calls.some((c) => onActivation(c))).toBe(true);
  });

  it("honestly refuses (SAFETY_DENIED, never silently allowed) when `affects` is omitted for an existing ENHO/XH", async () => {
    const { conn, http } = await connect([
      LOGON_ROUTE,
      { match: (o) => o.url === ENHO_URI, reply: resp(200, OBJECT_META("ZENH_BADI", "ENHO/XH", "$TMP"), XML) },
    ]);
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      allowEnhancements: true,
      enhanceTargets: "customer",
      originSystems: ["A4H"],
    });

    const err = await abapActivate(conn, { object: "ZENH_BADI", type: "ENHO/XH" }, 100_000, gate).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(isAbapError(err)).toBe(true);
    expect((err as AbapError).code).toBe("SAFETY_DENIED");
    // Never silently allowed — no activation request went out.
    expect(http.calls.some((c) => onActivation(c))).toBe(false);
  });

  it("still answers NOT_FOUND, not UNSUPPORTED, for an ENHO/XH that does not exist — resolution now reaches the server instead of refusing offline", async () => {
    const { conn } = await connect([
      LOGON_ROUTE,
      { match: (o) => o.url === ENHO_URI, reply: resp(404, NOT_FOUND_XML, XML) },
    ]);
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

    const err = await abapActivate(conn, { object: "ZENH_BADI", type: "ENHO/XH" }, 100_000, gate).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(isAbapError(err)).toBe(true);
    expect((err as AbapError).code).toBe("NOT_FOUND");
  });
});

/**
 * THE MOST IMPORTANT TEST IN THIS ASSIGNMENT (FIX-NOTES.md round 2).
 *
 * Every other ENHO/XH/ENHS/XS test in this file above calls `abapActivate`
 * with only 4 arguments — no `transport` — so `if (transport)` (the block
 * containing "C3", the gate re-consultation this whole round is about) never
 * runs and those tests cannot see the bug a live A4H run found: C3 built a
 * bare `{name, packageName, type}` `SafetyTarget` with no `intent` at all,
 * so it refused an activate with `SAFETY_DENIED "supply affects"` for EVERY
 * enhancement-type target, unconditionally — even though `authorizeMutation`
 * a few lines earlier had already correctly built and cleared an intent from
 * the exact same `affects` the caller supplied. `abap_activate`'s own
 * doc-string advertised `affects` as the unblock path for ENHO/XH/ENHS/XS,
 * and it did not work, for any input, ever — because this second gate call
 * dropped the value on the floor.
 *
 * These tests pass a real `SessionTransport` as the 5th argument (its `cts`
 * backend faked, no network) specifically so `if (transport)` — and C3
 * inside it — actually run, through the REAL `abapActivate` function, not a
 * mock and not a preflight call in isolation.
 */
describe("abapActivate — C3 (the post-transport-resolution gate re-consultation), full path with a real SessionTransport", () => {
  const ENHO_URI2 = "/sap/bc/adt/enhancements/enhoxh/zenh_badi2";
  const AFFECTS = { name: "ZTARGET_CLS", packageName: "ZTARGET_PKG", masterSystem: "A4H" };

  const localTrRequirement = (devclass: string): TrRequirement =>
    ({
      uri: `${ENHO_URI2}/source/main`,
      operation: "U",
      devclass,
      candidates: [],
      locks: [],
      messages: [],
      checkFailed: false,
      raw: { result: "S", korrflag: "", recording: "" },
      kind: "local",
      mustSupplyCorrNr: false,
      serverWouldFabricate: false,
    }) as unknown as TrRequirement;

  const openGate = () =>
    new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      allowEnhancements: true,
      enhanceTargets: "customer",
      originSystems: ["A4H"],
    });

  it("C3-with-intent: activates an ENHO/XH end to end through a real transport.resolve() once `affects` is supplied", async () => {
    const trRequirement = vi.fn(async () => localTrRequirement("$TMP"));
    const transport = new SessionTransport({ allowTransports: ["auto"], cts: { trRequirement } });
    const { conn, http } = await connect([
      LOGON_ROUTE,
      { match: (o) => o.url === ENHO_URI2, reply: resp(200, OBJECT_META("ZENH_BADI2", "ENHO/XH", "$TMP"), XML) },
      { match: onActivation, reply: resp(200, "", { "content-length": "0" }) },
    ]);

    const res = await abapActivate(
      conn,
      { object: "ZENH_BADI2", type: "ENHO/XH", affects: AFFECTS },
      100_000,
      openGate(),
      transport,
    );

    // `transport.resolve()` genuinely ran (proving `if (transport)`, and
    // therefore C3, actually executed) and the activation itself went out —
    // neither would happen if C3 had refused.
    expect(trRequirement).toHaveBeenCalledTimes(1);
    expect(res.text).toContain("activated: true");
    expect(http.calls.some((c) => onActivation(c))).toBe(true);
  });

  it("C3-without-intent (black-box): the same call with `affects` omitted is honestly refused, before transport.resolve() and before any activation request — never INTERNAL_GATE_MISUSE", async () => {
    const trRequirement = vi.fn(async () => localTrRequirement("$TMP"));
    const transport = new SessionTransport({ allowTransports: ["auto"], cts: { trRequirement } });
    const { conn, http } = await connect([
      LOGON_ROUTE,
      { match: (o) => o.url === ENHO_URI2, reply: resp(200, OBJECT_META("ZENH_BADI2", "ENHO/XH", "$TMP"), XML) },
    ]);

    const err = await abapActivate(
      conn,
      { object: "ZENH_BADI2", type: "ENHO/XH" },
      100_000,
      openGate(),
      transport,
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(isAbapError(err)).toBe(true);
    const e = err as AbapError;
    // `authorizeMutation` (earlier in `abapActivate`, before C3) catches this
    // first with the ordinary, user-facing "you forgot affects" refusal —
    // C3's own `activateIntent` binding is built from the SAME `input.affects`
    // authorizeMutation already judged, so C3 can never disagree with it and
    // this call never reaches C3, let alone INTERNAL_GATE_MISUSE. That is the
    // structural guarantee this round adds: it is not merely that C3 now
    // happens to pass the right intent, but that C3 CANNOT independently drop
    // it, because it never rebuilds one of its own.
    expect(e.code).toBe("SAFETY_DENIED");
    expect(e.message).toMatch(/supply `affects`/);
    // Never silently allowed, and never even reached the transport/activation.
    expect(trRequirement).not.toHaveBeenCalled();
    expect(http.calls.some((c) => onActivation(c))).toBe(false);
  });

  it("regression: same object/type/gate/transport, only `affects` differs, and that alone flips the outcome all the way through activation", async () => {
    const trRequirement = vi.fn(async () => localTrRequirement("$TMP"));

    const withoutAffects = await connect([
      LOGON_ROUTE,
      { match: (o) => o.url === ENHO_URI2, reply: resp(200, OBJECT_META("ZENH_BADI2", "ENHO/XH", "$TMP"), XML) },
    ]);
    const refused = await abapActivate(
      withoutAffects.conn,
      { object: "ZENH_BADI2", type: "ENHO/XH" },
      100_000,
      openGate(),
      new SessionTransport({ allowTransports: ["auto"], cts: { trRequirement } }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    const withAffects = await connect([
      LOGON_ROUTE,
      { match: (o) => o.url === ENHO_URI2, reply: resp(200, OBJECT_META("ZENH_BADI2", "ENHO/XH", "$TMP"), XML) },
      { match: onActivation, reply: resp(200, "", { "content-length": "0" }) },
    ]);
    const allowed = await abapActivate(
      withAffects.conn,
      { object: "ZENH_BADI2", type: "ENHO/XH", affects: AFFECTS },
      100_000,
      openGate(),
      new SessionTransport({ allowTransports: ["auto"], cts: { trRequirement } }),
    );

    expect(isAbapError(refused)).toBe(true);
    expect((refused as AbapError).code).toBe("SAFETY_DENIED");
    expect(allowed.text).toContain("activated: true");
  });
});

// ------------------------------------------------------ batch activation ---

describe("abapActivate — `objects` (batch form), schema/dispatch level", () => {
  it("`object` AND `objects` together — BAD_INPUT, no request", async () => {
    const { conn, http } = await connect([]);
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const e = await abapActivate(
      conn,
      { object: PROG_TARGET.name, objects: [{ object: TABL_TARGET.name }] },
      100_000,
      gate,
    ).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(isAbapError(e)).toBe(true);
    expect((e as AbapError).code).toBe("BAD_INPUT");
    expect((e as AbapError).message).toContain("does not combine with top-level");
    expect(http.calls.some((c) => onActivation(c))).toBe(false);
  });

  it("neither `object` nor `objects` — BAD_INPUT, no request", async () => {
    const { conn, http } = await connect([]);
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const e = await abapActivate(conn, {}, 100_000, gate).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(isAbapError(e)).toBe(true);
    expect((e as AbapError).code).toBe("BAD_INPUT");
    expect((e as AbapError).message).toContain("Pass either `object`");
    expect(http.calls.some((c) => onActivation(c))).toBe(false);
  });

  it("`objects` with mode=check — BAD_INPUT, there is no batch syntax check", async () => {
    const { conn, http } = await connect([]);
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const e = await abapActivate(
      conn,
      { objects: [{ object: PROG_TARGET.name }, { object: TABL_TARGET.name }], mode: "check" },
      100_000,
      gate,
    ).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(isAbapError(e)).toBe(true);
    expect((e as AbapError).code).toBe("BAD_INPUT");
    expect((e as AbapError).message).toContain("only supports mode=activate");
    expect(http.calls.some((c) => onActivation(c))).toBe(false);
  });

  it("`objects` with a stray top-level `corr_nr` — BAD_INPUT, no request", async () => {
    const { conn, http } = await connect([]);
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const e = await abapActivate(
      conn,
      {
        objects: [{ object: PROG_TARGET.name }, { object: TABL_TARGET.name }],
        corr_nr: "A4HK900123",
      },
      100_000,
      gate,
    ).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(isAbapError(e)).toBe(true);
    expect((e as AbapError).code).toBe("BAD_INPUT");
    expect((e as AbapError).message).toContain("does not combine with top-level");
    expect((e as AbapError).message).toContain("corr_nr");
    expect(http.calls.some((c) => onActivation(c))).toBe(false);
  });
});

describe("abapActivate — `objects` (batch form), end to end", () => {
  it("resolves, authorises and activates two real objects — PROG/P and TABL/DT are different chunk classes, so this is TWO activation requests, not one", async () => {
    const { conn, http } = await connectWrite([
      LOGON_ROUTE,
      { match: onProgMeta, reply: resp(200, OBJECT_META(PROG_TARGET.name, PROG_TARGET.type), XML) },
      {
        match: (o) => o.url === TABL_TARGET.uri,
        reply: resp(200, OBJECT_META(TABL_TARGET.name, TABL_TARGET.type), XML),
      },
      { match: onActivation, reply: resp(200, "", { "content-length": "0" }) },
    ]);
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

    const res = await abapActivate(
      conn,
      {
        objects: [
          { object: PROG_TARGET.name, type: PROG_TARGET.type },
          { object: TABL_TARGET.name, type: TABL_TARGET.type },
        ],
      },
      100_000,
      gate,
    );

    expect(res.text).toContain("activated: true");
    expect(res.text).toContain(PROG_TARGET.name);
    expect(res.text).toContain(TABL_TARGET.name);

    // PROG/P (mode "source") and TABL/DT (mode "ddic") land in different
    // chunk classes — see isFanoutProneType/chunkActivationTargets in
    // src/adt/activate.ts — so this mixed pair is chunked into two separate
    // POSTs to the activation endpoint, each naming exactly one object, even
    // though both easily fit under either class's default cap. The two
    // results are still merged into one clean `abap_activate` response
    // (asserted above), which is the whole point of chunking being invisible
    // to the caller.
    const activationCalls = http.calls.filter(onActivation);
    expect(activationCalls).toHaveLength(2);
    const bodies = activationCalls.map((c) => String(c.body ?? ""));
    expect(bodies.some((b) => b.includes(PROG_TARGET.uri))).toBe(true);
    expect(bodies.some((b) => b.includes(TABL_TARGET.uri))).toBe(true);
    // And each chunk names only ITS OWN object — that is the point of
    // splitting by type at all.
    expect(bodies.find((b) => b.includes(PROG_TARGET.uri))).not.toContain(TABL_TARGET.uri);
    expect(bodies.find((b) => b.includes(TABL_TARGET.uri))).not.toContain(PROG_TARGET.uri);
  });

  it("a mixed batch — one $TMP-allowed object, one in a package outside the allowlist — is refused AS A WHOLE, never partially activated", async () => {
    const FORBIDDEN_NAME = "ZMCP_BATCH_FORBIDDEN";
    const FORBIDDEN_URI = "/sap/bc/adt/programs/programs/zmcp_batch_forbidden";
    const onForbiddenMeta: Route["match"] = (o) => o.url === FORBIDDEN_URI;
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

    // Order 1: the forbidden object resolves/authorises SECOND — proves the
    // allowed object's successful pass-1 authorisation is never acted on.
    // `connectWrite` (not `connect`): writes are enabled here on purpose, so
    // the ONLY thing standing between this call and a real activation POST is
    // SafetyGate — not an incidental READ_ONLY refusal that would pass this
    // test for the wrong reason.
    {
      const { conn, http } = await connectWrite([
        LOGON_ROUTE,
        { match: onProgMeta, reply: resp(200, OBJECT_META(PROG_TARGET.name, PROG_TARGET.type), XML) },
        {
          match: onForbiddenMeta,
          reply: resp(200, OBJECT_META(FORBIDDEN_NAME, "PROG/P", "ZOTHER"), XML),
        },
        { match: onActivation, reply: resp(200, "", { "content-length": "0" }) },
      ]);
      const e = await abapActivate(
        conn,
        {
          objects: [
            { object: PROG_TARGET.name, type: PROG_TARGET.type },
            { object: FORBIDDEN_NAME, type: "PROG/P" },
          ],
        },
        100_000,
        gate,
      ).then(
        () => undefined,
        (x: unknown) => x,
      );
      expect(isAbapError(e)).toBe(true);
      expect((e as AbapError).code).toBe("SAFETY_DENIED");
      expect((e as AbapError).message).toContain("ZOTHER");
      expect((e as AbapError).message).toContain("not in the allowlist");
      // The whole point: neither object was ever activated, even though the
      // first one alone would have been allowed.
      expect(http.calls.some((c) => onActivation(c))).toBe(false);
    }

    // Order 2: the forbidden object resolves/authorises FIRST — proves the
    // refusal is unconditional on entry order, not just "fails fast on #1".
    {
      const { conn, http } = await connectWrite([
        LOGON_ROUTE,
        { match: onProgMeta, reply: resp(200, OBJECT_META(PROG_TARGET.name, PROG_TARGET.type), XML) },
        {
          match: onForbiddenMeta,
          reply: resp(200, OBJECT_META(FORBIDDEN_NAME, "PROG/P", "ZOTHER"), XML),
        },
        { match: onActivation, reply: resp(200, "", { "content-length": "0" }) },
      ]);
      const e = await abapActivate(
        conn,
        {
          objects: [
            { object: FORBIDDEN_NAME, type: "PROG/P" },
            { object: PROG_TARGET.name, type: PROG_TARGET.type },
          ],
        },
        100_000,
        gate,
      ).then(
        () => undefined,
        (x: unknown) => x,
      );
      expect(isAbapError(e)).toBe(true);
      expect((e as AbapError).code).toBe("SAFETY_DENIED");
      expect(http.calls.some((c) => onActivation(c))).toBe(false);
    }
  });
});

/** SYNTHETIC — same `chkl:messages` shape as `ACTIVATION_ERRORS`, `href` pointed at `TABL_TARGET` instead of `PROG_TARGET` so it attributes to TABL. */
const TABL_ACTIVATION_ERROR = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Table ZMCP_PROBE_TAB" type="E" line="1"
       href="${TABL_TARGET.uri}"
       forceSupported="true">
    <shortText><txt>Error in ZMCP_PROBE_TAB</txt></shortText>
  </msg>
</chkl:messages>`;

/**
 * Journalling.
 *
 * Before this, `abap_activate` changed which version of code the system
 * executes and left nothing on disk — while `JournalOperation` declared
 * `"activate"`, `undoBlocker()` refused it by name and three `abap_journal`
 * filters accepted it, all for entries no code path could produce.
 *
 * A real `Journal` on a temp directory, not a stub: the entry has to survive
 * being written to and read back off disk, which is the only property that
 * matters after a crash.
 */
describe("abapActivate — journalling", () => {
  const withJournal = async (fn: (j: Journal) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "abapsmith-activate-journal-"));
    try {
      await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "TST"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it("a single activation writes exactly one settled, irreversible `activate` entry", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connect([
        LOGON_ROUTE,
        { match: onProgMeta, reply: resp(200, OBJECT_META(PROG_TARGET.name, PROG_TARGET.type), XML) },
        { match: onActivation, reply: resp(200, "", { "content-length": "0" }) },
      ]);
      const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

      await abapActivate(
        conn,
        { object: PROG_TARGET.name, type: PROG_TARGET.type },
        100_000,
        gate,
        undefined,
        journal,
      );

      const entries = await journal.list({});
      expect(entries).toHaveLength(1);
      const e = entries[0]!;
      expect(e.operation).toBe("activate");
      expect(e.object.name).toBe(PROG_TARGET.name);
      expect(e.object.type).toBe(PROG_TARGET.type);
      expect(e.outcome).toBe("succeeded");
      expect(e.tool).toBe("abap_activate");
      // History, not undo. `undoBlocker()` already refuses `"activate"` by
      // name; the flag puts these entries on the same footing as
      // `transport-release` everywhere entries are DISPLAYED.
      expect(e.irreversible).toBe(true);
      // Existence is positively established (assertActivatable + a real
      // metadata GET), but no before-image is captured because activation
      // changes no source. `"unknown"` rather than the derived `"failed"`,
      // which would claim a read was attempted and failed.
      expect(e.existedBefore).toBe(true);
      expect(e.beforeCapture).toBe("unknown");
      expect(e.activation?.attempted).toBe(true);
      expect(e.activation?.activated).toBe(true);
    });
  });

  it("mode=check journals nothing — it mutates nothing", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connect([
        LOGON_ROUTE,
        { match: onProgMeta, reply: resp(200, OBJECT_META(PROG_TARGET.name, PROG_TARGET.type), XML) },
        { match: onCheckruns, reply: resp(200, CHECKRUN_CLEAN, XML) },
      ]);
      const gate = new SafetyGate({ readOnly: true, allowPackages: [] });

      await abapActivate(
        conn,
        { object: PROG_TARGET.name, type: PROG_TARGET.type, mode: "check", source: "REPORT z." },
        100_000,
        gate,
        undefined,
        journal,
      );

      expect(await journal.list({})).toHaveLength(0);
    });
  });

  it("the entry is on disk, PENDING, before the activation request goes out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abapsmith-activate-journal-order-"));
    try {
      const journal = new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "TST");
      // Read the raw JSONL index synchronously from inside the route matcher —
      // i.e. at the instant the activation POST is dispatched, before any reply
      // exists. This is the property that makes a crash mid-activation readable
      // afterwards instead of invisible, and it is the whole reason `begin()`
      // is separate from `settle()`.
      let indexAtPost: string | undefined;
      const { conn } = await connect([
        LOGON_ROUTE,
        { match: onProgMeta, reply: resp(200, OBJECT_META(PROG_TARGET.name, PROG_TARGET.type), XML) },
        {
          match: (o) => {
            if (!onActivation(o)) return false;
            indexAtPost ??= readFileSync(join(dir, "index.jsonl"), "utf8");
            return true;
          },
          reply: resp(200, "", { "content-length": "0" }),
        },
      ]);
      const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

      await abapActivate(
        conn,
        { object: PROG_TARGET.name, type: PROG_TARGET.type },
        100_000,
        gate,
        undefined,
        journal,
      );

      expect(indexAtPost, "no activation POST was observed").toBeDefined();
      const atPost = indexAtPost!
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { operation?: string; outcome?: string; object?: { name?: string } });
      expect(atPost).toHaveLength(1);
      expect(atPost[0]!.operation).toBe("activate");
      expect(atPost[0]!.object?.name).toBe(PROG_TARGET.name);
      expect(atPost[0]!.outcome).toBe("pending");

      // And the same entry is settled by the time the call returns.
      const after = await journal.list({});
      expect(after).toHaveLength(1);
      expect(after[0]!.outcome).toBe("succeeded");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a failed activation leaves a settled `failed` entry, not a pending one and not silence", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connect([
        LOGON_ROUTE,
        { match: onProgMeta, reply: resp(200, OBJECT_META(PROG_TARGET.name, PROG_TARGET.type), XML) },
        { match: onActivation, reply: resp(200, ACTIVATION_ERRORS, XML) },
      ]);
      const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

      const failed = await abapActivate(
        conn,
        { object: PROG_TARGET.name, type: PROG_TARGET.type },
        100_000,
        gate,
        undefined,
        journal,
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isAbapError(failed)).toBe(true);

      const entries = await journal.list({});
      expect(entries).toHaveLength(1);
      expect(entries[0]!.operation).toBe("activate");
      expect(entries[0]!.outcome).toBe("failed");
      expect(entries[0]!.error).toBeTruthy();
    });
  });

  it("a batch writes ONE ENTRY PER OBJECT, each findable by its own name", async () => {
    await withJournal(async (journal) => {
      const { conn, http } = await connectWrite([
        LOGON_ROUTE,
        { match: onProgMeta, reply: resp(200, OBJECT_META(PROG_TARGET.name, PROG_TARGET.type), XML) },
        {
          match: (o) => o.url === TABL_TARGET.uri,
          reply: resp(200, OBJECT_META(TABL_TARGET.name, TABL_TARGET.type), XML),
        },
        { match: onActivation, reply: resp(200, "", { "content-length": "0" }) },
      ]);
      const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

      await abapActivate(
        conn,
        {
          objects: [
            { object: PROG_TARGET.name, type: PROG_TARGET.type },
            { object: TABL_TARGET.name, type: TABL_TARGET.type },
          ],
        },
        100_000,
        gate,
        undefined,
        journal,
      );

      // PROG and TABL are different chunk classes (TABL is
      // DDIC-mass-activation-prone, PROG is not), so this batch now travels
      // as TWO sequential activation requests, not one — the entry
      // granularity below is unaffected either way; it was always a journal
      // decision, not a reflection of how many POSTs the batch took.
      expect(http.calls.filter(onActivation)).toHaveLength(2);

      const all = await journal.list({});
      expect(all).toHaveLength(2);
      expect(all.map((e) => e.object.name).sort()).toEqual([PROG_TARGET.name, TABL_TARGET.name].sort());
      for (const e of all) {
        expect(e.operation).toBe("activate");
        expect(e.outcome).toBe("succeeded");
        expect(e.irreversible).toBe(true);
      }

      // THE decisive argument for per-object entries over one entry with N
      // `parts`: `Journal.list()`'s `object=` filter matches `entry.object.name`
      // and never looks inside `parts`. Recorded as one entry, this query — the
      // one a human auditing "what changed on this system" actually runs —
      // would answer with silence for every member of the batch but the first.
      const forTabl = await journal.list({ object: TABL_TARGET.name });
      expect(forTabl).toHaveLength(1);
      expect(forTabl[0]!.object.name).toBe(TABL_TARGET.name);

      const forProg = await journal.list({ object: PROG_TARGET.name });
      expect(forProg).toHaveLength(1);
      expect(forProg[0]!.object.name).toBe(PROG_TARGET.name);
    });
  });

  it("chunk one activates clean, chunk two's POST throws — PROG settles succeeded, TABL stays pending", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connectWrite([
        LOGON_ROUTE,
        { match: onProgMeta, reply: resp(200, OBJECT_META(PROG_TARGET.name, PROG_TARGET.type), XML) },
        {
          match: (o) => o.url === TABL_TARGET.uri,
          reply: resp(200, OBJECT_META(TABL_TARGET.name, TABL_TARGET.type), XML),
        },
        {
          match: (o) => onActivation(o) && String(o.body ?? "").includes(PROG_TARGET.uri),
          reply: resp(200, "", { "content-length": "0" }),
        },
      ]);
      const realPost = conn.post.bind(conn);
      vi.spyOn(conn, "post").mockImplementation(
        async (url: string, opts?: RawRequestOptions & { body?: string }) => {
          if (url.includes("/sap/bc/adt/activation") && String(opts?.body ?? "").includes(TABL_TARGET.uri)) {
            throw new Error("socket hang up");
          }
          return realPost(url, opts);
        },
      );
      const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

      const e = await abapActivate(
        conn,
        {
          objects: [
            { object: PROG_TARGET.name, type: PROG_TARGET.type },
            { object: TABL_TARGET.name, type: TABL_TARGET.type },
          ],
        },
        100_000,
        gate,
        undefined,
        journal,
      ).then(
        () => undefined,
        (x: unknown) => x,
      );
      expect(isAbapError(e)).toBe(true);

      const all = await journal.list({});
      expect(all).toHaveLength(2);
      expect(all.every((x) => x.irreversible)).toBe(true);

      const prog = all.find((x) => x.object.name === PROG_TARGET.name)!;
      expect(prog.outcome).toBe("succeeded");
      expect(prog.activation?.attempted).toBe(true);
      expect(prog.activation?.activated).toBe(true);

      // TABL's chunk POST never answered — ADT has no deactivate, so PROG's
      // already-clean chunk stays settled, but nothing was ever observed
      // about TABL, and `pending` (not a guessed `failed`) says exactly that.
      const tabl = all.find((x) => x.object.name === TABL_TARGET.name)!;
      expect(tabl.outcome).toBe("pending");
      expect(tabl.error).toBeUndefined();
    });
  });

  it("chunk one activates clean, chunk two reports errors — PROG settles succeeded, TABL settles failed with its own error", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connectWrite([
        LOGON_ROUTE,
        { match: onProgMeta, reply: resp(200, OBJECT_META(PROG_TARGET.name, PROG_TARGET.type), XML) },
        {
          match: (o) => o.url === TABL_TARGET.uri,
          reply: resp(200, OBJECT_META(TABL_TARGET.name, TABL_TARGET.type), XML),
        },
        {
          match: (o) => onActivation(o) && String(o.body ?? "").includes(PROG_TARGET.uri),
          reply: resp(200, "", { "content-length": "0" }),
        },
        {
          match: (o) => onActivation(o) && String(o.body ?? "").includes(TABL_TARGET.uri),
          reply: resp(200, TABL_ACTIVATION_ERROR, XML),
        },
      ]);
      const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

      const e = await abapActivate(
        conn,
        {
          objects: [
            { object: PROG_TARGET.name, type: PROG_TARGET.type },
            { object: TABL_TARGET.name, type: TABL_TARGET.type },
          ],
        },
        100_000,
        gate,
        undefined,
        journal,
      ).then(
        () => undefined,
        (x: unknown) => x,
      );
      expect(isAbapError(e)).toBe(true);

      const all = await journal.list({});
      expect(all).toHaveLength(2);

      // Per-object detail, not one uniform patch: PROG's own chunk answered
      // clean, so it settles succeeded even though the batch as a whole failed.
      const prog = all.find((x) => x.object.name === PROG_TARGET.name)!;
      expect(prog.outcome).toBe("succeeded");
      expect(prog.activation?.activated).toBe(true);

      const tabl = all.find((x) => x.object.name === TABL_TARGET.name)!;
      expect(tabl.outcome).toBe("failed");
      expect(tabl.error).toBeTruthy();
    });
  });

  it("a chunk never sent because an earlier chunk threw is recorded as such, not as a guessed failure", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connectWriteWithCaps(
        [
          LOGON_ROUTE,
          { match: onProgMeta, reply: resp(200, OBJECT_META(PROG_TARGET.name, PROG_TARGET.type), XML) },
          {
            match: (o) => o.url === TABL_TARGET.uri,
            reply: resp(200, OBJECT_META(TABL_TARGET.name, TABL_TARGET.type), XML),
          },
          { match: (o) => o.url === PROG2_TARGET.uri, reply: resp(200, OBJECT_META(PROG2_TARGET.name, PROG2_TARGET.type), XML) },
          {
            match: (o) => onActivation(o) && String(o.body ?? "").includes(PROG_TARGET.uri),
            reply: resp(200, "", { "content-length": "0" }),
          },
        ],
        { maxDdicActivationBatch: 1, maxSafeActivationBatch: 1 },
      );
      // Counted at `conn.post` — the one choke point every activation chunk's
      // POST goes through — rather than at the fake wire, since the throwing
      // chunk below never gets far enough to reach it.
      let activationPosts = 0;
      const realPost = conn.post.bind(conn);
      vi.spyOn(conn, "post").mockImplementation(
        async (url: string, opts?: RawRequestOptions & { body?: string }) => {
          if (url.includes("/sap/bc/adt/activation")) activationPosts++;
          if (url.includes("/sap/bc/adt/activation") && String(opts?.body ?? "").includes(TABL_TARGET.uri)) {
            throw new Error("socket hang up");
          }
          return realPost(url, opts);
        },
      );
      const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

      const e = await abapActivate(
        conn,
        {
          objects: [
            { object: PROG_TARGET.name, type: PROG_TARGET.type },
            { object: TABL_TARGET.name, type: TABL_TARGET.type },
            { object: PROG2_TARGET.name, type: PROG2_TARGET.type },
          ],
        },
        100_000,
        gate,
        undefined,
        journal,
      ).then(
        () => undefined,
        (x: unknown) => x,
      );
      expect(isAbapError(e)).toBe(true);
      expect(activationPosts).toBe(2);

      const all = await journal.list({});
      expect(all).toHaveLength(3);
      const prog2 = all.find((x) => x.object.name === PROG2_TARGET.name)!;
      expect(prog2.outcome).toBe("failed");
      expect(prog2.error).toContain("no activation request naming");
      expect(prog2.error).toContain(PROG2_TARGET.name);
    });
  });

  it("a batch where every chunk reports errors settles EVERY object's entry failed", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connectWrite([
        LOGON_ROUTE,
        { match: onProgMeta, reply: resp(200, OBJECT_META(PROG_TARGET.name, PROG_TARGET.type), XML) },
        {
          match: (o) => o.url === TABL_TARGET.uri,
          reply: resp(200, OBJECT_META(TABL_TARGET.name, TABL_TARGET.type), XML),
        },
        { match: onActivation, reply: resp(200, ACTIVATION_ERRORS, XML) },
      ]);
      const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

      const e = await abapActivate(
        conn,
        {
          objects: [
            { object: PROG_TARGET.name, type: PROG_TARGET.type },
            { object: TABL_TARGET.name, type: TABL_TARGET.type },
          ],
        },
        100_000,
        gate,
        undefined,
        journal,
      ).then(
        () => undefined,
        (x: unknown) => x,
      );
      expect(isAbapError(e)).toBe(true);

      const all = await journal.list({});
      expect(all).toHaveLength(2);
      expect(all.every((x) => x.outcome === "failed")).toBe(true);
      expect(all.every((x) => x.error && x.error.length > 0)).toBe(true);
    });
  });

  it("no journal at all still activates — a disabled journal is not a refusal", async () => {
    await withJournal(async () => {
      const dir = await mkdtemp(join(tmpdir(), "abapsmith-activate-journal-off-"));
      try {
        const disabled = new Journal({ dir, enabled: false, maxEntries: 200, maxAgeDays: 30 }, "TST");
        const { conn, http } = await connect([
          LOGON_ROUTE,
          { match: onProgMeta, reply: resp(200, OBJECT_META(PROG_TARGET.name, PROG_TARGET.type), XML) },
          { match: onActivation, reply: resp(200, "", { "content-length": "0" }) },
        ]);
        const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

        const res = await abapActivate(
          conn,
          { object: PROG_TARGET.name, type: PROG_TARGET.type },
          100_000,
          gate,
          undefined,
          disabled,
        );
        expect(res.text).toContain("activated: true");
        expect(http.calls.some(onActivation)).toBe(true);
        expect(await disabled.list({})).toHaveLength(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("buildActivationBody", () => {
  it("emits one <adtcore:objectReference> per target, uri + name ONLY — no adtcore:type, no adtcore:parentUri", () => {
    const body = buildActivationBody([
      { name: "ZFOO", uri: "/sap/bc/adt/ddic/domains/zfoo" },
      { name: "ZBAR", uri: "/sap/bc/adt/ddic/dataelements/zbar" },
    ]);
    expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(body).toContain(
      '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">',
    );
    expect(body).toContain(
      '<adtcore:objectReference adtcore:uri="/sap/bc/adt/ddic/domains/zfoo" adtcore:name="ZFOO"/>',
    );
    expect(body).toContain(
      '<adtcore:objectReference adtcore:uri="/sap/bc/adt/ddic/dataelements/zbar" adtcore:name="ZBAR"/>',
    );
    // The one thing this whole module exists to avoid: the vendor array-form
    // `activate()` unconditionally emits these two attributes and SAP 400s on
    // them (see the function's own doc comment). Never let them creep back in.
    expect(body).not.toContain("adtcore:type");
    expect(body).not.toContain("adtcore:parentUri");
  });

  it("escapes XML-special characters in uri and name", () => {
    const body = buildActivationBody([{ name: `Z<A&B>"C"`, uri: "/x/y&z" }]);
    expect(body).toContain('adtcore:uri="/x/y&amp;z"');
    expect(body).toContain('adtcore:name="Z&lt;A&amp;B&gt;&quot;C&quot;"');
  });
});

describe("attributeToTarget", () => {
  const A: ActivationTarget = { name: "ZFOO", uri: "/sap/bc/adt/ddic/domains/zfoo" };
  const B: ActivationTarget = { name: "ZFOO_ID", uri: "/sap/bc/adt/ddic/domains/zfoo_id" };
  const GROUP: ActivationTarget = { name: "ZGRP", uri: "/sap/bc/adt/functions/groups/zgrp" };
  const MEMBER: ActivationTarget = {
    name: "ZGRP_FM",
    uri: "/sap/bc/adt/functions/groups/zgrp/fmodules/zgrp_fm",
  };

  it("attributes by href, exact match", () => {
    expect(attributeToTarget({ uri: A.uri }, [A, B])).toBe(A);
  });

  it("attributes by href, at a path-segment boundary below the target uri", () => {
    expect(attributeToTarget({ uri: `${A.uri}/source/main#start=4,0` }, [A, B])).toBe(A);
  });

  it("does NOT attribute a prefix-sharing sibling to the shorter name (ZFOO vs ZFOO_ID)", () => {
    // A plain startsWith() would wrongly match `.../zfoo_id` against `.../zfoo`
    // — this is the exact regression the segment-boundary rule in
    // src/adt/activate.ts exists to prevent.
    expect(attributeToTarget({ uri: `${B.uri}/source/main#start=1,0` }, [A, B])).toBe(B);
  });

  it("prefers the longest matching target uri — a container member over its own group", () => {
    expect(attributeToTarget({ uri: `${MEMBER.uri}/source/main#start=1,0` }, [GROUP, MEMBER])).toBe(
      MEMBER,
    );
  });

  it("falls back to objDescr, whole-word, only when no href is present", () => {
    expect(attributeToTarget({ objDescr: "Program ZFOO" }, [A, B])).toBe(A);
  });

  it("does not match objDescr as a substring (ZFOO must not match inside ZFOO_ID)", () => {
    expect(attributeToTarget({ objDescr: "Domain ZFOO_ID" }, [A, B])).toBe(B);
  });

  it("returns undefined when objDescr matches more than one target (ambiguous, never guesses)", () => {
    const A2: ActivationTarget = { name: "ZFOO", uri: "/x/1" };
    const A3: ActivationTarget = { name: "ZFOO", uri: "/x/2" };
    expect(attributeToTarget({ objDescr: "Domain ZFOO" }, [A2, A3])).toBeUndefined();
  });

  it("returns undefined when neither href nor objDescr addresses anything in the set", () => {
    expect(attributeToTarget({ uri: "/sap/bc/adt/oo/classes/zunrelated" }, [A, B])).toBeUndefined();
  });
});

/**
 * SYNTHETIC — hand-written, not a live capture. Same `<chkl:messages>` shape
 * `ACTIVATION_ERRORS` above documents as verbatim, extended to two DIFFERENT
 * objects so `activateObjects`'s per-object attribution has something real to
 * split.
 */
const BATCH_TWO_ERRORS = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Program ZMCP_BATCH_A" type="E" line="1"
       href="/sap/bc/adt/programs/programs/zmcp_batch_a/source/main#start=4,0"
       forceSupported="true">
    <shortText><txt>Error in A</txt></shortText>
  </msg>
  <msg objDescr="Program ZMCP_BATCH_B" type="E" line="1"
       href="/sap/bc/adt/programs/programs/zmcp_batch_b/source/main#start=2,0"
       forceSupported="true">
    <shortText><txt>Error in B</txt></shortText>
  </msg>
</chkl:messages>`;

/** SYNTHETIC — one message that addresses neither batch member. */
const BATCH_ONE_UNATTRIBUTED_ERROR = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Class ZMCP_UNRELATED" type="E" line="1"
       href="/sap/bc/adt/oo/classes/zmcp_unrelated/source/main#start=1,0"
       forceSupported="true">
    <shortText><txt>Something about a third, unnamed object</txt></shortText>
  </msg>
</chkl:messages>`;

describe("activateObjects", () => {
  const BATCH_A: ActivationTarget = {
    name: "ZMCP_BATCH_A",
    uri: "/sap/bc/adt/programs/programs/zmcp_batch_a",
  };
  const BATCH_B: ActivationTarget = {
    name: "ZMCP_BATCH_B",
    uri: "/sap/bc/adt/programs/programs/zmcp_batch_b",
  };

  it("refuses an empty set — BAD_INPUT, no request", async () => {
    const { conn, http } = await connect([]);
    const e = await activateObjects(conn, []).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(isAbapError(e)).toBe(true);
    expect((e as AbapError).code).toBe("BAD_INPUT");
    expect(http.calls.some((c) => onActivation(c))).toBe(false);
  });

  it(`refuses a set over MAX_ACTIVATION_BATCH (${MAX_ACTIVATION_BATCH})`, async () => {
    const { conn, http } = await connect([]);
    const targets: ActivationTarget[] = Array.from({ length: MAX_ACTIVATION_BATCH + 1 }, (_, i) => ({
      name: `ZOBJ${i}`,
      uri: `/sap/bc/adt/ddic/domains/zobj${i}`,
    }));
    const e = await activateObjects(conn, targets).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(isAbapError(e)).toBe(true);
    expect((e as AbapError).code).toBe("BAD_INPUT");
    expect((e as AbapError).message).toContain(String(MAX_ACTIVATION_BATCH));
    expect(http.calls.some((c) => onActivation(c))).toBe(false);
  });

  it("refuses a set naming the same object twice — BAD_INPUT, no request", async () => {
    const { conn, http } = await connect([]);
    const e = await activateObjects(conn, [BATCH_A, { ...BATCH_A }]).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(isAbapError(e)).toBe(true);
    expect((e as AbapError).code).toBe("BAD_INPUT");
    expect((e as AbapError).message).toContain("same object twice");
    expect(http.calls.some((c) => onActivation(c))).toBe(false);
  });

  it("posts ONE request naming both objects, and reports a clean batch as activated", async () => {
    const { conn, http } = await connectWrite([
      LOGON_ROUTE,
      { match: onActivation, reply: resp(200, "", { "content-length": "0" }) },
    ]);
    const outcome = await activateObjects(conn, [BATCH_A, BATCH_B]);

    expect(outcome.activated).toBe(true);
    expect(outcome.ok).toBe(true);
    expect(outcome.perObject).toHaveLength(2);
    expect(outcome.perObject.every((o) => o.activated && o.ok)).toBe(true);

    const activationCalls = http.calls.filter(onActivation);
    expect(activationCalls).toHaveLength(1);
    const body = String(activationCalls[0]?.body ?? "");
    expect(body).toContain(BATCH_A.uri);
    expect(body).toContain(BATCH_B.uri);
  });

  it("splits a two-object error response across the two objects, and BLAMES only the one with messages", async () => {
    const { conn } = await connectWrite([
      LOGON_ROUTE,
      { match: onActivation, reply: resp(200, BATCH_TWO_ERRORS, XML) },
    ]);
    const outcome = await activateObjects(conn, [BATCH_A, BATCH_B]);

    expect(outcome.activated).toBe(false);
    expect(outcome.errors).toBe(2);
    expect(outcome.unattributed).toHaveLength(0);

    const a = outcome.perObject.find((o) => o.target.name === "ZMCP_BATCH_A")!;
    const b = outcome.perObject.find((o) => o.target.name === "ZMCP_BATCH_B")!;
    expect(a.ok).toBe(false);
    expect(a.messages).toHaveLength(1);
    expect(a.messages[0]?.text).toBe("Error in A");
    expect(b.ok).toBe(false);
    expect(b.messages).toHaveLength(1);
    expect(b.messages[0]?.text).toBe("Error in B");
    // Neither member is ever reported activated when the batch as a whole failed.
    expect(a.activated).toBe(false);
    expect(b.activated).toBe(false);
  });

  it("reports a message that addresses neither member as unattributed, and still fails the batch", async () => {
    const { conn } = await connectWrite([
      LOGON_ROUTE,
      { match: onActivation, reply: resp(200, BATCH_ONE_UNATTRIBUTED_ERROR, XML) },
    ]);
    const outcome = await activateObjects(conn, [BATCH_A, BATCH_B]);

    expect(outcome.activated).toBe(false);
    expect(outcome.errors).toBe(1);
    expect(outcome.unattributed).toHaveLength(1);
    // Neither named object was individually blamed — the message is nobody's.
    expect(outcome.perObject.every((o) => o.ok)).toBe(true);
  });
});

describe("isFanoutProneType (DDIC-fan-out classification)", () => {
  it("classifies the incident's directly-evidenced types as fan-out-prone", () => {
    for (const type of ["DOMA/DD", "DTEL/DE", "TABL/DT", "TABL/DS"]) {
      expect(isFanoutProneType(type)).toBe(true);
    }
  });

  it("classifies TTYP/DA as fan-out-prone too — same DD-nametab generation mechanism, included conservatively", () => {
    expect(isFanoutProneType("TTYP/DA")).toBe(true);
  });

  it("classifies the rest of TypeSpec mode:\"ddic\" as fan-out-prone as well — unconfirmed is not confirmed-safe", () => {
    for (const type of ["ENHO/XH", "ENHS/XS", "MSAG/N", "ENQU/DL", "DEVC/K", "SRVB/SVB"]) {
      expect(isFanoutProneType(type)).toBe(true);
    }
  });

  it("classifies source-compiled types — including the issue's own explicit examples — as NOT fan-out-prone", () => {
    for (const type of ["CLAS/OC", "INTF/OI", "PROG/P", "PROG/I", "FUGR/F", "FUGR/FF", "FUGR/I", "ENHO/XHH"]) {
      expect(isFanoutProneType(type)).toBe(false);
    }
  });

  it("classifies CDS (DDLS/DF) as NOT fan-out-prone — DDL/SADL pipeline, not the classic DD nametab generator", () => {
    expect(isFanoutProneType("DDLS/DF")).toBe(false);
  });

  it("defaults a missing or unrecognised type to fan-out-prone — the conservative direction to be wrong in", () => {
    expect(isFanoutProneType(undefined)).toBe(true);
    expect(isFanoutProneType("")).toBe(true);
    expect(isFanoutProneType("ZZZZ/QQ")).toBe(true);
  });
});

describe("chunkActivationTargets", () => {
  const ddic = (n: string): ActivationTarget => ({
    name: n,
    uri: `/sap/bc/adt/ddic/domains/${n.toLowerCase()}`,
    type: "DOMA/DD",
  });
  const src = (n: string): ActivationTarget => ({
    name: n,
    uri: `/sap/bc/adt/programs/programs/${n.toLowerCase()}`,
    type: "PROG/P",
  });

  it("returns no chunks for an empty input", () => {
    expect(chunkActivationTargets([], { ddic: 5, safe: 50 })).toEqual([]);
  });

  it("keeps a same-class run under its cap in ONE chunk", () => {
    const targets = [ddic("A"), ddic("B"), ddic("C")];
    expect(chunkActivationTargets(targets, { ddic: 5, safe: 50 })).toEqual([targets]);
  });

  it("splits a same-class run once it exceeds the DDIC cap, and never exceeds it per chunk", () => {
    const targets = Array.from({ length: 7 }, (_, i) => ddic(`D${i}`));
    const chunks = chunkActivationTargets(targets, { ddic: 3, safe: 50 });
    expect(chunks.map((c) => c.length)).toEqual([3, 3, 1]);
    expect(chunks.every((c) => c.length <= 3)).toBe(true);
  });

  it("uses the SAFE cap, not the DDIC cap, for source-mode types", () => {
    const targets = Array.from({ length: 7 }, (_, i) => src(`P${i}`));
    const chunks = chunkActivationTargets(targets, { ddic: 3, safe: 4 });
    expect(chunks.map((c) => c.length)).toEqual([4, 3]);
  });

  it("splits at every class change even when both sides are well under cap — classes are never merged into one chunk", () => {
    const targets = [ddic("A"), ddic("B"), src("P1"), src("P2"), ddic("C")];
    const chunks = chunkActivationTargets(targets, { ddic: 5, safe: 50 });
    expect(chunks).toEqual([[ddic("A"), ddic("B")], [src("P1"), src("P2")], [ddic("C")]]);
  });

  it("never reshuffles — flattening the chunks back reproduces the original order exactly", () => {
    const targets = [src("P1"), ddic("A"), ddic("B"), src("P2"), ddic("C"), ddic("D"), ddic("E"), ddic("F")];
    const chunks = chunkActivationTargets(targets, { ddic: 2, safe: 50 });
    expect(chunks.flat()).toEqual(targets);
    // And the DDIC run C,D,E,F (cap 2) is itself split, proving order survives
    // WITHIN a class too, not just across class boundaries.
    expect(chunks.map((c) => c.map((t) => t.name))).toEqual([
      ["P1"],
      ["A", "B"],
      ["P2"],
      ["C", "D"],
      ["E", "F"],
    ]);
  });

  it("groups an untyped target with the DDIC (fan-out-prone) class, same conservative default as isFanoutProneType", () => {
    const untyped: ActivationTarget = { name: "MYSTERY", uri: "/x/mystery" };
    const targets = [untyped, ddic("A"), ddic("B")];
    const chunks = chunkActivationTargets(targets, { ddic: 5, safe: 50 });
    expect(chunks).toEqual([targets]);
  });
});

/** SYNTHETIC — one error message about ZMULTI_ERR, in the same shape as ACTIVATION_ERRORS above. */
const MULTI_CHUNK_ERROR = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Domain ZMULTI_ERR" type="E" line="1"
       href="/sap/bc/adt/ddic/domains/zmulti_err"
       forceSupported="true">
    <shortText><txt>Error in ZMULTI_ERR</txt></shortText>
  </msg>
</chkl:messages>`;

describe("activateObjects — chunking end-to-end", () => {
  const D = (n: string): ActivationTarget => ({
    name: n,
    uri: `/sap/bc/adt/ddic/domains/${n.toLowerCase()}`,
    type: "DOMA/DD",
  });

  it("splits a 7-object all-DDIC batch into three sequential POSTs under a small configured cap, and still aggregates one clean, correctly-ordered result", async () => {
    const targets = Array.from({ length: 7 }, (_, i) => D(`ZMULTI_D${i}`));
    const { conn, http } = await connectWriteWithCaps(
      [LOGON_ROUTE, { match: onActivation, reply: resp(200, "", { "content-length": "0" }) }],
      { maxDdicActivationBatch: 3, maxSafeActivationBatch: 50 },
    );

    const outcome = await activateObjects(conn, targets);

    expect(outcome.activated).toBe(true);
    expect(outcome.perObject).toHaveLength(7);
    // Result order matches the ORIGINAL targets order, not chunk-arrival order.
    expect(outcome.perObject.map((o) => o.target.name)).toEqual(targets.map((t) => t.name));
    expect(outcome.perObject.every((o) => o.activated && o.ok)).toBe(true);

    const calls = http.calls.filter(onActivation);
    expect(calls).toHaveLength(3); // 7 objects, cap 3 -> chunks of 3, 3, 1
    const refCounts = calls.map((c) => (String(c.body ?? "").match(/adtcore:objectReference /g) ?? []).length);
    expect(refCounts).toEqual([3, 3, 1]);
    // Sequential send order == original target order (first chunk has the
    // first three, last chunk has the seventh).
    expect(String(calls[0]?.body)).toContain(targets[0]!.uri);
    expect(String(calls[2]?.body)).toContain(targets[6]!.uri);
  });

  it("attributes a failure in one chunk to the right object, without corrupting the other, successfully-activated chunk's result", async () => {
    const errTarget = D("ZMULTI_ERR");
    const okTarget = D("ZMULTI_OK");
    const { conn, http } = await connectWriteWithCaps(
      [
        LOGON_ROUTE,
        { match: (o) => onActivation(o) && String(o.body ?? "").includes(errTarget.uri), reply: resp(200, MULTI_CHUNK_ERROR, XML) },
        {
          match: (o) => onActivation(o) && String(o.body ?? "").includes(okTarget.uri),
          reply: resp(200, "", { "content-length": "0" }),
        },
      ],
      { maxDdicActivationBatch: 1, maxSafeActivationBatch: 50 },
    );

    const outcome = await activateObjects(conn, [errTarget, okTarget]);

    // Two separate chunks (cap 1), sent sequentially, in target order.
    const calls = http.calls.filter(onActivation);
    expect(calls).toHaveLength(2);
    expect(String(calls[0]?.body)).toContain(errTarget.uri);
    expect(String(calls[1]?.body)).toContain(okTarget.uri);

    // The batch as a whole failed (one chunk had an [EAX] error)...
    expect(outcome.activated).toBe(false);
    expect(outcome.errors).toBe(1);

    const err = outcome.perObject.find((o) => o.target.name === errTarget.name)!;
    const ok = outcome.perObject.find((o) => o.target.name === okTarget.name)!;
    // ...the failing object is correctly blamed, by name, for its own message...
    expect(err.ok).toBe(false);
    expect(err.messages).toHaveLength(1);
    expect(err.messages[0]?.text).toBe("Error in ZMULTI_ERR");
    // ...the OTHER object's chunk came back clean, so it is individually `ok`...
    expect(ok.ok).toBe(true);
    expect(ok.messages).toHaveLength(0);
    // ...but `activated` is false for BOTH, because the batch as a whole did
    // not activate — a clean chunk does not get to claim victory on its own.
    expect(err.activated).toBe(false);
    expect(ok.activated).toBe(false);
  });
});

describe("assertBatchActivated", () => {
  const A: ActivationTarget = { name: "ZFOO", uri: "/x/zfoo" };
  const B: ActivationTarget = { name: "ZBAR", uri: "/x/zbar" };

  const outcome = (o: Partial<BatchActivationOutcome> = {}): BatchActivationOutcome => ({
    activated: true,
    ok: true,
    messages: [],
    errors: 0,
    warnings: 0,
    inactive: [],
    targets: [A, B],
    perObject: [
      { target: A, activated: true, ok: true, disposition: "activated", messages: [], errors: 0, warnings: 0, inactive: [] },
      { target: B, activated: true, ok: true, disposition: "activated", messages: [], errors: 0, warnings: 0, inactive: [] },
    ],
    unattributed: [],
    unattributedInactive: [],
    ...o,
  });

  it("passes a clean, activated batch through unchanged", () => {
    const clean = outcome();
    expect(assertBatchActivated(clean)).toBe(clean);
  });

  it("throws CHECK_FAILED naming the blamed object(s) when the batch failed", () => {
    const failed = outcome({
      activated: false,
      ok: false,
      errors: 1,
      perObject: [
        { target: A, activated: false, ok: false, disposition: "not-activated", messages: [], errors: 1, warnings: 0, inactive: [] },
        { target: B, activated: false, ok: true, disposition: "not-activated", messages: [], errors: 0, warnings: 0, inactive: [] },
      ],
    });
    const e = catchAbap(() => assertBatchActivated(failed));
    expect(e.code).toBe("CHECK_FAILED");
    expect(e.message).toContain("ZFOO");
    expect(e.message).not.toContain("was blamed, ZBAR");
    expect((e.details as { blamed?: string[] }).blamed).toEqual(["ZFOO"]);
    // Single-chunk batch: nothing is left active, so the original blanket
    // warning still applies.
    expect(e.hint).toContain("The whole set is still inactive");
  });

  it("names an earlier chunk's already-active objects in the hint instead of claiming the whole set is still inactive", () => {
    const chunked = outcome({
      activated: false,
      ok: false,
      errors: 1,
      perObject: [
        { target: A, activated: false, ok: true, disposition: "activated", messages: [], errors: 0, warnings: 0, inactive: [] },
        {
          target: B,
          activated: false,
          ok: false,
          disposition: "not-activated",
          messages: [{ severity: "E", text: "boom" }],
          errors: 1,
          warnings: 0,
          inactive: [],
        },
      ],
    });
    const e = catchAbap(() => assertBatchActivated(chunked));
    expect(e.code).toBe("CHECK_FAILED");
    expect((e.details as { blamed?: string[] }).blamed).toEqual(["ZBAR"]);
    // ZFOO is sitting there active from an earlier chunk. Telling the caller
    // the whole set is still inactive would send them looking for objects
    // that are already there.
    expect(e.hint).toContain("ZFOO");
    expect(e.hint).not.toContain("The whole set is still inactive");
    const perObject = (e.details as { perObject?: Array<{ object: string; disposition: string }> }).perObject;
    expect(perObject?.find((o) => o.object === "ZFOO")?.disposition).toBe("activated");
  });
});

describe("renderBatch", () => {
  it("gives every named object its own section, even a quiet one, and labels the blamed one", () => {
    const A: ActivationTarget = { name: "ZFOO", uri: "/x/zfoo" };
    const B: ActivationTarget = { name: "ZBAR", uri: "/x/zbar" };
    const text = renderBatch({
      activated: false,
      ok: false,
      messages: [{ severity: "E", text: "boom" }],
      errors: 1,
      warnings: 0,
      inactive: [],
      targets: [A, B],
      perObject: [
        {
          target: A,
          activated: false,
          ok: false,
          disposition: "not-activated",
          messages: [{ severity: "E", text: "boom" }],
          errors: 1,
          warnings: 0,
          inactive: [],
        },
        { target: B, activated: false, ok: true, disposition: "not-activated", messages: [], errors: 0, warnings: 0, inactive: [] },
      ],
      unattributed: [],
      unattributedInactive: [],
    });
    expect(text).toContain("## ZFOO");
    expect(text).toContain("<- BLAMED");
    expect(text).toContain("## ZBAR");
    expect(text).not.toMatch(/ZBAR.*BLAMED/);
    expect(text).toContain("boom");
  });

  it("gives unattributed messages their own labelled section, never folded into the first object", () => {
    const A: ActivationTarget = { name: "ZFOO", uri: "/x/zfoo" };
    const text = renderBatch({
      activated: false,
      ok: false,
      messages: [{ severity: "E", text: "orphan" }],
      errors: 1,
      warnings: 0,
      inactive: [],
      targets: [A],
      perObject: [
        { target: A, activated: false, ok: true, disposition: "not-activated", messages: [], errors: 0, warnings: 0, inactive: [] },
      ],
      unattributed: [{ severity: "E", text: "orphan" }],
      unattributedInactive: [],
    });
    expect(text).toContain("(unattributed)");
    expect(text).toContain("orphan");
    // Scope the check to ZFOO's OWN section (up to the next heading), not the
    // whole rendered string — "orphan" legitimately appears later, in the
    // unattributed section, and a whole-string search would pass either way.
    const zfooSection = text.slice(text.indexOf("## ZFOO"), text.indexOf("(unattributed)"));
    expect(zfooSection).not.toContain("orphan");
  });
});
