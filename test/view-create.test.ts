/**
 * Classic-view (`VIEW/DV`) create bridge — offline. Nothing here touches SAP;
 * the transport is faked through `ConnectionOptions.httpClient`, repeating
 * `test/enhancement-bridge.test.ts`'s `RecordingClient`/`resp`/`connected`/
 * `objectHappyPath` harness (that file's own header explains why each suite
 * keeps its own small copy rather than sharing one heavier fake).
 *
 * What these tests are FOR, in the order the module's risks run:
 *
 *  1. generator/parser drift — every tag the fragment writes is a tag
 *     `parseDdicTranscript` knows, asserted as a SET so a rename on either
 *     side fails;
 *  2. the closed-template defence — a quote, a period, a newline or a space in
 *     any identifier is refused, and no source is produced at all (not
 *     escaped, not stripped);
 *  3. the create refusal, and that it runs FIRST — before the safety gate,
 *     before validation, and proven by the fake server seeing zero requests
 *     rather than merely by the throw;
 *  4. the `sy-subrc` guard between the `DDIF_VIEW_PUT` call and its success
 *     tag — these FMs report failure through classic EXCEPTIONS, which no
 *     `CATCH cx_root` sees, so a tag written unconditionally would report
 *     success for a call that did nothing;
 *  5. a failing transcript (empty output, or a `ZMCP-DDIC-ERR>` line) is a
 *     failure, not a success with nothing to say;
 *  6. `$TMP` vs a real package — `RS_CORR_INSERT`/`VIEW-REGISTERED` appear for
 *     one and not the other, and `expectTags` follows the fragment in both;
 *  7. the source the bridge would deploy, with the captured parameter names
 *     in it.
 *
 * There is no happy path left to test: `createClassicView` refuses every
 * package, `$TMP` included, so nothing past the refusal is reachable. What
 * remains reachable — the fragment, the generated source, the tag set, the
 * refusal itself — is what these tests assert against.
 */
import { describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate, type Operation, type SafetyTarget, type EvaluateOptions } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import {
  DDIC_BRIDGE_CLASS,
  DDIC_ERR_PREFIX,
  DDIC_TAGS,
  assertDdicTranscript,
  ddicBridgeSource,
  parseDdicTranscript,
  type DdicTag,
} from "../src/adt/ddic-bridge.js";
import {
  VIEW_DATA_LINES,
  assertClassicViewCreateSupported,
  classicViewFragment,
  createClassicView,
  type ClassicViewParams,
} from "../src/adt/view-create.js";
import { isLocalPackageName } from "../src/adt/transports.js";
import { TERMINAL_REFUSAL_NOTE } from "../src/adt/capabilities.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Fake transport — same shape as test/enhancement-bridge.test.ts
// ---------------------------------------------------------------------------

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    readOnly: false,
  });

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
  statusText = String(status),
): HttpClientResponse => ({ status, statusText, body, headers }) as unknown as HttpClientResponse;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

const SESSION_URL = "/sap/bc/adt/compatibility/graph";
const CLASS_COLLECTION = "/sap/bc/adt/oo/classes";

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

/** GET-404 → POST-create → LOCK → PUT → UNLOCK for the generated bridge class. */
function objectHappyPath(
  collectionUrl: string,
  name: string,
): (o: HttpClientOptions) => HttpClientResponse | undefined {
  const objUrl = `${collectionUrl}/${name.toLowerCase()}`;
  const sourceUri = `${objUrl}/source/main`;
  return (o: HttpClientOptions) => {
    const qs = (o.qs ?? {}) as Record<string, string>;
    const method = (o.method ?? "GET").toUpperCase();
    if (o.url === objUrl && method === "GET" && !qs._action) {
      const r = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
      throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
    }
    if (o.url === collectionUrl && method === "POST") return resp(200, "", {});
    if (o.url === objUrl && qs._action === "LOCK") return resp(200, LOCK_XML(), { "content-type": "application/xml" });
    if (o.url === objUrl && qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (o.url === sourceUri && method === "PUT") return resp(200, "", { "content-type": "text/plain" });
    return undefined;
  };
}

/** Session/discovery/activation/classrun plumbing shared by every test below. */
function sharedRoute(
  classrun: (o: HttpClientOptions) => HttpClientResponse | undefined,
): (o: HttpClientOptions) => HttpClientResponse | undefined {
  return (o: HttpClientOptions) => {
    if (o.url.startsWith("/sap/bc/adt/oo/classrun/")) return classrun(o);
    if (o.url.includes(SESSION_URL)) {
      return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
    }
    if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
    if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
    if (o.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return undefined;
  };
}

function combine(
  ...routes: Array<(o: HttpClientOptions) => HttpClientResponse | undefined>
): (o: HttpClientOptions) => HttpClientResponse {
  return (o: HttpClientOptions) => {
    for (const r of routes) {
      const hit = r(o);
      if (hit) return hit;
    }
    throw new Error(`unrouted request: ${(o.method ?? "GET").toUpperCase()} ${o.url}`);
  };
}

async function connected(
  route: (o: HttpClientOptions) => HttpClientResponse,
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(route);
  const conn = new AbapConnection(cfg(), {
    httpClient: inner,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner };
}

/**
 * `out->write('TAG')` lines are the whole line, unprefixed — `runClass` hands
 * back raw classrun stdout with only newline normalisation. See
 * test/enhancement-bridge.test.ts's `classrunOutput` comment for the "LIST> "
 * prefix mistake this shape exists to avoid repeating.
 */
function classrunOutput(lines: readonly string[]): (o: HttpClientOptions) => HttpClientResponse {
  const body = lines.join("\n");
  return () => resp(200, body, { "content-type": "text/plain" });
}

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!e || !isAbapError(e)) throw new Error(`expected an AbapError, got ${String(e)}`);
  return e;
};

const catchSync = (fn: () => unknown): AbapError => {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected an AbapError to be thrown");
};

/**
 * Allows both packages this suite writes into: `$TMP` for the generated bridge
 * class (`DDIC_BRIDGE_PACKAGE`) and `ZTM` for the view itself. Both are needed
 * — the two gates judge two different objects, which is the whole point of
 * `assertBridgeMutation` existing.
 *
 * `allowTransports` keeps the default `"auto"` entry (other tests in this
 * suite still rely on it) and adds `CORR_NR` literally — `source: "named"`
 * never matches the `"auto"` entry, mirroring `test/package-create.test.ts`.
 */
const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP", "ZTM"],
    allowTransports: ["auto", CORR_NR],
    writesLockedOut: false,
  });

/**
 * Denies `VIEW/DV` and nothing else. `$TMP` — the only package
 * createClassicView ever reaches — is allowlisted for everything else, so
 * this can only be refusing the view itself, not `deployBridge`'s own gate
 * on the bridge class.
 */
class ViewDenyingGate extends SafetyGate {
  override assert(op: Operation, obj?: SafetyTarget, opts: EvaluateOptions = {}): void {
    if (obj?.type === "VIEW/DV") {
      throw new AbapError("SAFETY_DENIED", "VIEW/DV denied by test gate", { operation: op });
    }
    super.assert(op, obj, opts);
  }
}

const viewDenyingGate = (): SafetyGate =>
  new ViewDenyingGate({ readOnly: false, allowPackages: ["$TMP"], writesLockedOut: false });

/**
 * A null connection IS the assertion: any code path that reaches the wire
 * before refusing throws a TypeError instead of the `BAD_INPUT` these tests
 * expect. Same device, and same reasoning, as `test/write.test.ts`'s `offline`.
 */
const offline = null as unknown as AbapConnection;

/** A syntactically valid TRKORR — the shape `isTrkorr` (src/adt/transports.ts) accepts. */
const CORR_NR = "A4HK900121";

const VIEW: ClassicViewParams = {
  viewName: "ZTM_V_CARRIER",
  baseTable: "SCARR",
  fields: ["MANDT", "CARRID", "CARRNAME"],
  description: "Carrier projection",
  packageName: "ZTM",
  corrNr: CORR_NR,
};

const LOCAL_VIEW: ClassicViewParams = { ...VIEW, packageName: "$TMP", corrNr: undefined };

/** Every `out->write( 'TAG' )` the fragment emits, in emission order. */
function emittedTags(lines: readonly string[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    const m = /^out->write\( '([^']*)' \)\.$/.exec(line.trim());
    if (m?.[1] !== undefined) found.push(m[1]);
  }
  return found;
}

// ---------------------------------------------------------------------------
// 1 — generator/parser drift
// ---------------------------------------------------------------------------

describe("generator/parser drift", () => {
  it("emits exactly the tag SET createClassicView expects, for a transportable package", () => {
    const tags = emittedTags(classicViewFragment(VIEW));
    expect(new Set(tags)).toEqual(new Set(["VIEW-PUT", "VIEW-REGISTERED", "VIEW-ACTIVATED"]));
    expect(tags).toEqual(["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"]);
  });

  it("emits exactly the tag SET createClassicView expects, for $TMP (round 5: RS_CORR_INSERT/VIEW-REGISTERED skipped again)", () => {
    const tags = emittedTags(classicViewFragment(LOCAL_VIEW));
    expect(new Set(tags)).toEqual(new Set(["VIEW-PUT", "VIEW-ACTIVATED"]));
  });

  it("every tag the fragment writes is one parseDdicTranscript recognises", () => {
    for (const params of [VIEW, LOCAL_VIEW]) {
      const tags = emittedTags(classicViewFragment(params));
      expect(tags.length).toBeGreaterThan(0);
      // The parser is the arbiter, not a copy of the tag list in this file:
      // feed the generator's own tags through it and require it to return
      // them all. A tag renamed on either side drops out here.
      const parsed = parseDdicTranscript(tags.join("\n"));
      expect(parsed.tags).toEqual(tags);
      expect(parsed.errorLine).toBeUndefined();
      for (const tag of tags) expect(DDIC_TAGS).toContain(tag as DdicTag);
    }
  });

  it("assertDdicTranscript is satisfied by the fragment's own success output", () => {
    const ztm = emittedTags(classicViewFragment(VIEW));
    expect(() =>
      assertDdicTranscript(parseDdicTranscript(ztm.join("\n")), ztm as DdicTag[], "Creating classic view"),
    ).not.toThrow();

    const tmp = emittedTags(classicViewFragment(LOCAL_VIEW));
    expect(() =>
      assertDdicTranscript(parseDdicTranscript(tmp.join("\n")), tmp as DdicTag[], "Creating classic view"),
    ).not.toThrow();
  });

  it("the fragment's own sy-subrc error lines parse as an error, not as a tag", () => {
    // subrcCheckFragment writes `out->write( |ZMCP-DDIC-ERR> ...| )`. The
    // interpolated form cannot be evaluated here, but its literal prefix is
    // what the parser keys on — prove the prefix the generator uses is the
    // prefix the parser strips.
    const errLine = classicViewFragment(VIEW).find((l) => l.includes(DDIC_ERR_PREFIX));
    expect(errLine).toBeTruthy();
    const parsed = parseDdicTranscript(`${DDIC_ERR_PREFIX} DDIF_VIEW_PUT failed, sy-subrc=4`);
    expect(parsed.tags).toEqual([]);
    expect(parsed.errorLine).toContain("DDIF_VIEW_PUT failed");
  });
});

// ---------------------------------------------------------------------------
// 2 — closed template / injection
// ---------------------------------------------------------------------------

describe("closed template — an injection is refused, never escaped", () => {
  const bad = ["bad'name", "bad.name", "bad\nname", "bad name"];

  // Asserted at the fragment level, not through createClassicView: the create
  // is now refused for every package before validate() ever runs, so a
  // createClassicView call would report UNSUPPORTED for an input this suite is
  // about the SHAPE of. The fragment is where an injection would have to
  // survive to reach a bridge class, so it is the load-bearing check.
  for (const value of bad) {
    it(`refuses viewName ${JSON.stringify(value)} with BAD_INPUT, and produces no fragment at all`, () => {
      expect(catchSync(() => classicViewFragment({ ...LOCAL_VIEW, viewName: value })).code).toBe("BAD_INPUT");
    });

    it(`refuses baseTable ${JSON.stringify(value)} with BAD_INPUT, and produces no fragment at all`, () => {
      expect(catchSync(() => classicViewFragment({ ...LOCAL_VIEW, baseTable: value })).code).toBe("BAD_INPUT");
    });

    it(`refuses a field ${JSON.stringify(value)} with BAD_INPUT, and produces no fragment at all`, () => {
      const params = { ...LOCAL_VIEW, fields: ["CARRID", value] };
      expect(catchSync(() => classicViewFragment(params)).code).toBe("BAD_INPUT");
    });
  }

  it("refuses a description containing a newline — refused, not stripped", () => {
    const err = catchSync(() => classicViewFragment({ ...LOCAL_VIEW, description: "line1\nline2" }));
    expect(err.code).toBe("BAD_INPUT");
  });

  it("still escapes a legitimate quote in the description (free text, not an identifier)", () => {
    const line = classicViewFragment({ ...VIEW, description: "Fritz's view" }).find((l) =>
      l.startsWith("ls_dd25v-ddtext"),
    );
    expect(line).toBe("ls_dd25v-ddtext     = 'Fritz''s view'.");
  });

  it("refuses an empty field list with BAD_INPUT", () => {
    expect(catchSync(() => classicViewFragment({ ...LOCAL_VIEW, fields: [] })).code).toBe("BAD_INPUT");
  });

  it("refuses more fields than DD27P-OBJPOS's 4-character position can carry", () => {
    const fields = Array.from({ length: 250 }, (_, i) => `F${i}`);
    const err = catchSync(() => classicViewFragment({ ...LOCAL_VIEW, fields }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("OBJPOS");
  });

  it("createClassicView refuses the PACKAGE before it ever inspects an identifier — UNSUPPORTED, not BAD_INPUT, with no connection to reach", async () => {
    const err = await catchErr(createClassicView(offline, allowingGate(), { ...LOCAL_VIEW, viewName: "bad'name" }));
    expect(err.code).toBe("UNSUPPORTED");
  });

  it("refuses an injected packageName with BAD_INPUT, at the fragment level (embedded raw in RS_CORR_INSERT)", () => {
    for (const value of bad) {
      expect(() => classicViewFragment({ ...VIEW, packageName: value })).toThrow(AbapError);
    }
  });

  it("zero-pads every generated OBJPOS to four characters, in caller order", () => {
    const lines = classicViewFragment({ ...VIEW, fields: ["A", "B", "C"] });
    const positions = lines.filter((l) => l.startsWith("ls_dd27p-objpos"));
    expect(positions).toEqual([
      "ls_dd27p-objpos    = '0001'.",
      "ls_dd27p-objpos    = '0002'.",
      "ls_dd27p-objpos    = '0003'.",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3 — the second gate runs, and runs FIRST
// ---------------------------------------------------------------------------

describe("the create refusal runs before the gate, and before anything reaches the wire", () => {
  // These two used to prove `assertBridgeMutation` ran, and ran first. The
  // create is now refused for every package ahead of it, so the strongest
  // statement left is the one that matters to a caller: not one byte leaves
  // the process, whatever the gate would have said.
  it("refuses with UNSUPPORTED and ZERO requests on the wire, even with a gate that would deny VIEW/DV anyway", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, DDIC_BRIDGE_CLASS.createView),
      sharedRoute(classrunOutput(["VIEW-PUT", "VIEW-ACTIVATED"])),
    );
    const { conn, inner } = await connected(route);
    const err = await catchErr(createClassicView(conn, viewDenyingGate(), LOCAL_VIEW));
    expect(err.code).toBe("UNSUPPORTED");
    expect(inner.calls.length).toBe(0);
  });

  it("never asks the gate about the view at all — the refusal is not a gate decision a permissive gate could reverse", async () => {
    const seen: Operation[] = [];
    class RecordingGate extends SafetyGate {
      override assert(op: Operation, obj?: SafetyTarget, opts: EvaluateOptions = {}): void {
        if (obj?.type === "VIEW/DV") seen.push(op);
        super.assert(op, obj, opts);
      }
    }
    const gate = new RecordingGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      writesLockedOut: false,
    });
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, DDIC_BRIDGE_CLASS.createView),
      sharedRoute(classrunOutput(["VIEW-PUT", "VIEW-ACTIVATED"])),
    );
    const { conn, inner } = await connected(route);
    const err = await catchErr(createClassicView(conn, gate, LOCAL_VIEW));
    expect(err.code).toBe("UNSUPPORTED");
    expect(seen).toEqual([]);
    expect(inner.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4 — the sy-subrc guard
// ---------------------------------------------------------------------------

describe("the sy-subrc guard — a classic EXCEPTIONS failure is never tagged as success", () => {
  const sourceFor = (params: ClassicViewParams): string =>
    ddicBridgeSource(DDIC_BRIDGE_CLASS.createView, VIEW_DATA_LINES, classicViewFragment(params));

  it("puts an `IF sy-subrc <> 0.` guard between the DDIF_VIEW_PUT call and its success tag", () => {
    const lines = sourceFor(VIEW).split("\n").map((l) => l.trim());
    const callIdx = lines.indexOf("CALL FUNCTION 'DDIF_VIEW_PUT'");
    const tagIdx = lines.indexOf("out->write( 'VIEW-PUT' ).");
    expect(callIdx).toBeGreaterThanOrEqual(0);
    expect(tagIdx).toBeGreaterThan(callIdx);
    const between = lines.slice(callIdx, tagIdx);
    expect(between).toContain("IF sy-subrc <> 0.");
    // And the guard RETURNs, so a failed PUT can never fall through into the
    // activation step that follows. Registration (RS_CORR_INSERT) already ran
    // before this call, so this guard has nothing before it left to protect.
    expect(between).toContain("RETURN.");
    expect(between.some((l) => l.startsWith(`out->write( |${DDIC_ERR_PREFIX}`))).toBe(true);
  });

  it("guards RS_CORR_INSERT and DDIF_VIEW_ACTIVATE the same way", () => {
    const lines = sourceFor(VIEW).split("\n").map((l) => l.trim());
    for (const [call, tag] of [
      ["CALL FUNCTION 'RS_CORR_INSERT'", "out->write( 'VIEW-REGISTERED' )."],
      ["CALL FUNCTION 'DDIF_VIEW_ACTIVATE'", "out->write( 'VIEW-ACTIVATED' )."],
    ] as const) {
      const callIdx = lines.indexOf(call);
      const tagIdx = lines.indexOf(tag);
      expect(callIdx).toBeGreaterThanOrEqual(0);
      expect(tagIdx).toBeGreaterThan(callIdx);
      expect(lines.slice(callIdx, tagIdx)).toContain("IF sy-subrc <> 0.");
    }
  });

  it("folds DDIF_VIEW_ACTIVATE's rc into sy-subrc — rc > 4 is a failure the guard must see", () => {
    const lines = sourceFor(VIEW).split("\n").map((l) => l.trim());
    const rcIdx = lines.indexOf("IF sy-subrc = 0 AND lv_rc > 4. sy-subrc = lv_rc. ENDIF.");
    const callIdx = lines.indexOf("CALL FUNCTION 'DDIF_VIEW_ACTIVATE'");
    const tagIdx = lines.indexOf("out->write( 'VIEW-ACTIVATED' ).");
    expect(rcIdx).toBeGreaterThan(callIdx);
    expect(rcIdx).toBeLessThan(tagIdx);
  });
});

// ---------------------------------------------------------------------------
// 5 — a failing transcript is a failure
// ---------------------------------------------------------------------------

// Asserted against `assertDdicTranscript` with the view's own expected tags
// rather than through `createClassicView`: no transcript can reach that
// function any more, since it refuses every package before it deploys
// anything. The tag SET is the fragment's own (see the drift suite above), so
// a rename still fails here.
describe("a failing transcript is a failure, not a silent success", () => {
  const TMP_TAGS = ["VIEW-PUT", "VIEW-ACTIVATED"] as DdicTag[];
  const check = (output: string): AbapError =>
    catchSync(() => assertDdicTranscript(parseDdicTranscript(output), TMP_TAGS, "Creating classic view"));

  it("throws CHECK_FAILED on empty classrun output", () => {
    const err = check("");
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("did not report success");
  });

  it("throws CHECK_FAILED on a ZMCP-DDIC-ERR> line", () => {
    const err = check(`${DDIC_ERR_PREFIX} DDIF_VIEW_PUT failed, sy-subrc=5, DO123`);
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("DDIF_VIEW_PUT failed");
  });

  it("throws CHECK_FAILED when the PUT tag arrives but the activation tag does not", () => {
    const err = check("VIEW-PUT");
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("VIEW-ACTIVATED");
  });
});

// ---------------------------------------------------------------------------
// 6 — $TMP skips RS_CORR_INSERT/VIEW-REGISTERED; a transportable package
//     gets both (round 5: restored after round 3's unconditional-call
//     regression)
// ---------------------------------------------------------------------------

/**
 * ROUND 3 removed the `$TMP` skip and called `RS_CORR_INSERT`
 * unconditionally, reasoning by (unproven) analogy from `tran-create.ts` that
 * skipping TADIR registration was the leading suspect for a `$TMP` view
 * reproducing live as wholly absent. ROUND 5 (2026-08-14) reverted that after
 * a live run of the unconditional version reproduced something WORSE, not
 * better: `CHECK_FAILED`, "Sending of dynpro SAPLSTRD 0352 not possible: No
 * window system type specified", with the transcript showing `VIEW-PUT`
 * succeeding and the error coming from the very next generated statement
 * (`COMMIT WORK.` then `CALL FUNCTION 'RS_CORR_INSERT'`) — i.e.
 * `RS_CORR_INSERT` itself throwing up an interactive transport-request-
 * selection popup that `IF_OO_ADT_CLASSRUN` cannot display, aborting before
 * `DDIF_VIEW_ACTIVATE` ever ran. The original reasoning this codebase had —
 * "a `$TMP` object needs no TADIR / transport registration" — was right, not
 * merely unrefuted. See `src/adt/view-create.ts`'s `LOCAL_PACKAGE` doc
 * comment for the full account, including why the `tran-create.ts` analogy
 * did not transfer (that module never generates a direct `RS_CORR_INSERT`
 * call at all — see test/tran-create.test.ts and tran-create.ts itself).
 */
describe("$TMP skips RS_CORR_INSERT/VIEW-REGISTERED; a transportable package gets both (round 5)", () => {
  it("generates RS_CORR_INSERT and the VIEW-REGISTERED tag for ZTM (transportable)", () => {
    const lines = classicViewFragment(VIEW);
    expect(lines).toContain("CALL FUNCTION 'RS_CORR_INSERT'");
    expect(lines).toContain("            devclass = 'ZTM'");
    expect(lines).toContain("            object_class = 'DICT'");
    expect(lines).toContain("out->write( 'VIEW-REGISTERED' ).");
  });

  it("emits NO RS_CORR_INSERT and NO VIEW-REGISTERED tag for $TMP", () => {
    const lines = classicViewFragment(LOCAL_VIEW);
    expect(lines).not.toContain("CALL FUNCTION 'RS_CORR_INSERT'");
    expect(lines.some((l) => l.includes("RS_CORR_INSERT"))).toBe(false);
    expect(lines).not.toContain("out->write( 'VIEW-REGISTERED' ).");
    // The PUT and the activation are unaffected — only registration is skipped.
    expect(lines).toContain("CALL FUNCTION 'DDIF_VIEW_PUT'");
    expect(lines).toContain("CALL FUNCTION 'DDIF_VIEW_ACTIVATE'");
  });

  it("treats lower-case $tmp exactly the same as $TMP — case-insensitive, same package to the server", () => {
    const lines = classicViewFragment({ ...VIEW, packageName: "$tmp", corrNr: undefined });
    expect(lines).not.toContain("CALL FUNCTION 'RS_CORR_INSERT'");
    expect(lines).not.toContain("out->write( 'VIEW-REGISTERED' ).");
    expect(lines).toContain("CALL FUNCTION 'DDIF_VIEW_PUT'");
    expect(lines).toContain("CALL FUNCTION 'DDIF_VIEW_ACTIVATE'");
  });

  it("treats ANY $-prefixed package as local, not just $TMP — no RS_CORR_INSERT for $FOO either (matches safety.ts's $-prefix rule)", () => {
    const lines = classicViewFragment({ ...VIEW, packageName: "$FOO", corrNr: undefined });
    expect(lines).not.toContain("CALL FUNCTION 'RS_CORR_INSERT'");
    expect(lines.some((l) => l.includes("RS_CORR_INSERT"))).toBe(false);
    expect(lines).not.toContain("out->write( 'VIEW-REGISTERED' ).");
  });

  it("both COMMIT WORK statements are present in the $TMP shape (unaffected by the RS_CORR_INSERT skip)", () => {
    const lines = classicViewFragment(LOCAL_VIEW);
    const commitCount = lines.filter((l) => l === "COMMIT WORK.").length;
    expect(commitCount).toBe(2);
    // One right after DDIF_VIEW_PUT's success tag, one at the very end (after
    // DDIF_VIEW_ACTIVATE's success tag) — same relative placement as the
    // transportable shape, just with no RS_CORR_INSERT block in between.
    // A blank separator line sits between the tag and the COMMIT (same
    // one-blank-line-then-statement style every block in this fragment uses).
    const putTagIdx = lines.indexOf("out->write( 'VIEW-PUT' ).");
    const activateTagIdx = lines.indexOf("out->write( 'VIEW-ACTIVATED' ).");
    expect(lines[putTagIdx + 1]).toBe("");
    expect(lines[putTagIdx + 2]).toBe("COMMIT WORK.");
    expect(lines[lines.length - 1]).toBe("COMMIT WORK.");
    expect(activateTagIdx).toBeLessThan(lines.length - 1);
  });

  it("both COMMIT WORK statements are present in the transportable-package shape too", () => {
    const lines = classicViewFragment(VIEW);
    const commitCount = lines.filter((l) => l === "COMMIT WORK.").length;
    expect(commitCount).toBe(2);
    const putTagIdx = lines.indexOf("out->write( 'VIEW-PUT' ).");
    expect(lines[putTagIdx + 1]).toBe("");
    expect(lines[putTagIdx + 2]).toBe("COMMIT WORK.");
    expect(lines[lines.length - 1]).toBe("COMMIT WORK.");
  });

  it("the $TMP fragment emits exactly VIEW-PUT/VIEW-ACTIVATED — VIEW-REGISTERED is UNEXPECTED, and a two-tag transcript is accepted", () => {
    const tags = emittedTags(classicViewFragment(LOCAL_VIEW));
    expect(tags).toEqual(["VIEW-PUT", "VIEW-ACTIVATED"]);
    expect(() =>
      assertDdicTranscript(parseDdicTranscript(tags.join("\n")), tags as DdicTag[], "Creating classic view"),
    ).not.toThrow();
  });

  // "expectTags still requires VIEW-REGISTERED for ZTM" (createClassicView,
  // non-$TMP) deleted: that path is now unreachable, createClassicView
  // forces $TMP before it ever runs. The underlying invariant — RS_CORR_INSERT
  // and VIEW-REGISTERED rise and fall together — is pinned at the fragment
  // level below ("expectTags for a non-$TMP create still requires
  // VIEW-REGISTERED...").
});

// ---------------------------------------------------------------------------
// 8 — corrNr / RS_CORR_INSERT's KORRNUM
// ---------------------------------------------------------------------------
//
// RS_CORR_INSERT with no request number opens CTS's own request-
// selection dynpro (SAPLSTRD 0352), which IF_OO_ADT_CLASSRUN cannot render —
// CHECK_FAILED, "No window system type specified", 100% of the time for any
// non-$TMP package. The fix threads a caller-supplied, already gate-judged
// TRKORR through as KORRNUM, mirroring package-create.ts's corrNr discipline.

describe("corrNr threaded into RS_CORR_INSERT's KORRNUM", () => {
  it("emits korrnum carrying the exact corrNr, quoted like every other emitted value", () => {
    const lines = classicViewFragment(VIEW);
    expect(lines).toContain(`            korrnum = '${CORR_NR}'`);
    // Inside the RS_CORR_INSERT call specifically, not merely present somewhere in the fragment.
    const callIdx = lines.indexOf("CALL FUNCTION 'RS_CORR_INSERT'");
    const excIdx = lines.findIndex(
      (l, i) => i > callIdx && l.startsWith("  EXCEPTIONS cancelled = 1"),
    );
    const korrnumIdx = lines.indexOf(`            korrnum = '${CORR_NR}'`);
    expect(korrnumIdx).toBeGreaterThan(callIdx);
    expect(korrnumIdx).toBeLessThan(excIdx);
  });

  it("emits suppress_dialog = 'X' immediately after korrnum, inside the RS_CORR_INSERT call — korrnum alone did not suppress the dialog live", () => {
    const lines = classicViewFragment(VIEW);
    const callIdx = lines.indexOf("CALL FUNCTION 'RS_CORR_INSERT'");
    const excIdx = lines.findIndex(
      (l, i) => i > callIdx && l.startsWith("  EXCEPTIONS cancelled = 1"),
    );
    const korrnumIdx = lines.indexOf(`            korrnum = '${CORR_NR}'`);
    const suppressIdx = lines.indexOf("            suppress_dialog = 'X'");
    expect(korrnumIdx).toBeGreaterThan(callIdx);
    expect(korrnumIdx).toBeLessThan(excIdx);
    expect(suppressIdx).toBeGreaterThan(callIdx);
    expect(suppressIdx).toBeLessThan(excIdx);
    // Additive, not a replacement: korrnum must still be there alongside it.
    expect(suppressIdx).toBe(korrnumIdx + 1);
  });

  it("validate() still refuses a non-$TMP view with no corrNr as TRANSPORT_ERROR, via classicViewFragment", () => {
    const { corrNr: _drop, ...withoutCorr } = VIEW;
    const err = catchSync(() => classicViewFragment(withoutCorr as ClassicViewParams));
    expect(err.code).toBe("TRANSPORT_ERROR");
    expect(err.message).toContain("corr_nr");
    expect(err.message).toContain("transport request");
  });

  it("createClassicView refuses a non-$TMP view with no corrNr as UNSUPPORTED, never TRANSPORT_ERROR — the guard runs before validate()", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, DDIC_BRIDGE_CLASS.createView),
      sharedRoute(classrunOutput(["VIEW-PUT", "VIEW-REGISTERED", "VIEW-ACTIVATED"])),
    );
    const { conn, inner } = await connected(route);
    const { corrNr: _drop, ...withoutCorr } = VIEW;
    const err = await catchErr(createClassicView(conn, allowingGate(), withoutCorr as ClassicViewParams));
    expect(err.code).toBe("UNSUPPORTED");
    expect(inner.calls.length).toBe(0);
  });

  it("a $TMP fragment emits no RS_CORR_INSERT, no korrnum and no suppress_dialog, and expects only VIEW-PUT/VIEW-ACTIVATED", () => {
    const lines = classicViewFragment(LOCAL_VIEW);
    expect(lines.some((l) => l.includes("RS_CORR_INSERT"))).toBe(false);
    expect(lines.some((l) => l.includes("korrnum"))).toBe(false);
    // No RS_CORR_INSERT call means no dialog to suppress in the first place.
    expect(lines.some((l) => l.includes("suppress_dialog"))).toBe(false);
    expect(emittedTags(lines)).toEqual(["VIEW-PUT", "VIEW-ACTIVATED"]);
  });

  it("a $TMP fragment WITH a corrNr is refused BAD_INPUT — a $TMP view is never registered in CTS", () => {
    const params: ClassicViewParams = { ...LOCAL_VIEW, corrNr: CORR_NR };
    const err = catchSync(() => classicViewFragment(params));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("$TMP");
  });

  it("validate() still refuses a malformed corrNr as BAD_INPUT, via classicViewFragment", () => {
    const params: ClassicViewParams = { ...VIEW, corrNr: "not-a-request" };
    const err = catchSync(() => classicViewFragment(params));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("not-a-request");
  });

  it("expectTags for a non-$TMP create still requires VIEW-REGISTERED, and the fragment still contains RS_CORR_INSERT — asserted together so the two can't drift", () => {
    const lines = classicViewFragment(VIEW);
    const hasCorrInsert = lines.some((l) => l.includes("RS_CORR_INSERT"));
    const tags = emittedTags(lines);
    expect(hasCorrInsert).toBe(true);
    expect(tags).toContain("VIEW-REGISTERED");
  });
});

describe("assertClassicViewCreateSupported", () => {
  it("refuses a non-$TMP view, zero-network, message names the TK103 object-key rejection and the unregistered-in-TADIR strand risk, hint does not route to $TMP as a fix", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, DDIC_BRIDGE_CLASS.createView),
      sharedRoute(classrunOutput(["VIEW-PUT", "VIEW-REGISTERED", "VIEW-ACTIVATED"])),
    );
    const { conn, inner } = await connected(route);
    const err = await catchErr(createClassicView(conn, allowingGate(), VIEW));
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).toContain("This syntax cannot be used for an object name");
    expect(err.message).toContain("TK103");
    expect(err.message).toContain("unregistered in TADIR");
    expect(err.hint).toContain("stranded view");
    expect(err.hint).toContain("SE11/SE14");
    expect(err.hint).not.toContain("into $TMP instead");
    expect(inner.calls.length).toBe(0);
  });

  it("leads with a terminal, imperative refusal naming SE11/SE14 as the alternative, and ends with TERMINAL_REFUSAL_NOTE", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, DDIC_BRIDGE_CLASS.createView),
      sharedRoute(classrunOutput(["VIEW-PUT", "VIEW-REGISTERED", "VIEW-ACTIVATED"])),
    );
    const { conn } = await connected(route);
    const err = await catchErr(createClassicView(conn, allowingGate(), VIEW));
    expect(err.message.endsWith(TERMINAL_REFUSAL_NOTE)).toBe(true);
    const firstSentence = err.message.split(". ")[0];
    expect(firstSentence).toContain("No retry will succeed");
    expect(firstSentence).toContain("SE11/SE14");
    expect(firstSentence.toLowerCase()).not.toContain("try again");
  });

  // The defect this closes: the opening sentence claimed no package works
  // while $TMP was let through, and an omitted `package` resolves to $TMP —
  // so the shortest possible call disproved the first thing the caller read.
  it("throws UNSUPPORTED for $TMP too, in every casing isLocalPackage accepts", () => {
    for (const value of ["$TMP", "$tmp", "$Tmp"]) {
      const err = catchSync(() => assertClassicViewCreateSupported(value));
      expect(err.code).toBe("UNSUPPORTED");
      expect(err.message).toContain("unregistered in TADIR");
    }
  });

  it("$TMP's refusal says why it is refused — the create SUCCEEDS and mints an object delete and undo then both refuse", () => {
    const err = catchSync(() => assertClassicViewCreateSupported("$TMP"));
    expect(err.message).toContain("$TMP is not the exception");
    expect(err.message).toContain("omitting `package`");
    expect(err.message).toContain("PACKAGE_UNKNOWN");
    expect(err.message).toContain("non-overridably");
    expect(err.message.endsWith(TERMINAL_REFUSAL_NOTE)).toBe(true);
    expect(err.hint).toContain("SE11/SE14");
    expect(err.hint).toContain("DDLS/DF");
  });

  // The opening sentence is one shared string, so it cannot be true for one
  // package and false for another — which is exactly how the defect arose.
  it("every package gets the same opening claim, and every package is refused", () => {
    for (const value of ["$TMP", "$MYLOCAL", "ZTM"]) {
      const err = catchSync(() => assertClassicViewCreateSupported(value));
      expect(err.code).toBe("UNSUPPORTED");
      expect(err.message).toContain(
        `No retry will succeed for package ${JSON.stringify(value)} or any other: abapsmith cannot ` +
          "create a classic view for any package, so create it in SE11/SE14 by hand instead.",
      );
    }
  });

  it("throws UNSUPPORTED for a transportable package", () => {
    expect(catchSync(() => assertClassicViewCreateSupported("ZTM")).code).toBe("UNSUPPORTED");
  });

  it("throws UNSUPPORTED for $MYLOCAL — still not $TMP, but for the evidence reason (no package is known to produce a working create), not because it's considered transportable", () => {
    const err = catchSync(() => assertClassicViewCreateSupported("$MYLOCAL"));
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).not.toContain("RS_CORR_INSERT");
    expect(err.message).not.toContain("TK103");
    expect(err.message).toContain(
      "abapsmith cannot create a classic view for any package, so create it in SE11/SE14 by hand",
    );
  });

  it("$MYLOCAL's refusal also leads with the terminal claim and ends with TERMINAL_REFUSAL_NOTE", () => {
    const err = catchSync(() => assertClassicViewCreateSupported("$MYLOCAL"));
    expect(err.message.endsWith(TERMINAL_REFUSAL_NOTE)).toBe(true);
    const firstSentence = err.message.split(". ")[0];
    expect(firstSentence).toContain("No retry will succeed");
    expect(firstSentence).toContain("SE11/SE14");
    expect(firstSentence.toLowerCase()).not.toContain("try again");
  });

  it("assertClassicViewCreateSupported('ZTM') still mentions the TK103 object-key obstacle", () => {
    const err = catchSync(() => assertClassicViewCreateSupported("ZTM"));
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).toContain("TK103");
  });

  it("throws BAD_INPUT, not UNSUPPORTED, for a malformed package name", () => {
    for (const value of ["bad'name", "bad.name", "bad\nname", "bad name"]) {
      expect(catchSync(() => assertClassicViewCreateSupported(value)).code).toBe("BAD_INPUT");
    }
  });
});

describe("isLocalPackageName", () => {
  it("agrees with the $-prefix rule for local packages", () => {
    for (const value of ["$TMP", "$tmp", "$MYLOCAL", " $Foo "]) {
      expect(isLocalPackageName(value)).toBe(true);
    }
  });

  it("disagrees for transportable/empty names", () => {
    for (const value of ["ZTM", ""]) {
      expect(isLocalPackageName(value)).toBe(false);
    }
  });
});

describe("$MYLOCAL — local but not the attempted package", () => {
  it("classicViewFragment emits NO RS_CORR_INSERT line for $MYLOCAL", () => {
    const lines = classicViewFragment({ ...VIEW, packageName: "$MYLOCAL", corrNr: undefined });
    expect(lines.some((l) => l.includes("RS_CORR_INSERT"))).toBe(false);
  });

  it("classicViewFragment with $MYLOCAL and a valid corrNr throws BAD_INPUT, not TRANSPORT_ERROR — a local package has nothing for a request to attach to", () => {
    const err = catchSync(() =>
      classicViewFragment({ ...VIEW, packageName: "$MYLOCAL", corrNr: CORR_NR }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });
});

// ---------------------------------------------------------------------------
// 7 — the generated source (no happy path: every package is refused)
// ---------------------------------------------------------------------------

// Nothing is ever put on the wire for a view any more, so this asserts the
// source `createClassicView` would deploy — built from the same three inputs
// it passes to `ddicBridgeSource` — rather than a captured PUT body. The
// bridge stays in the tree as the record of the recon; this keeps that record
// from rotting while it is unreachable.
describe("the source the create bridge would deploy", () => {
  it("carries the captured DDIF_VIEW_PUT/ACTIVATE parameter names and the generated DATA section", () => {
    const body = ddicBridgeSource(
      DDIC_BRIDGE_CLASS.createView,
      VIEW_DATA_LINES,
      classicViewFragment(LOCAL_VIEW),
    );

    // The captured parameter names (R-BOUNDARY-RECHECK.md §D-L07-L08), in the
    // source — not a paraphrase of them.
    expect(body).toContain("CALL FUNCTION 'DDIF_VIEW_PUT'");
    expect(body).toContain("EXPORTING name = 'ZTM_V_CARRIER'");
    expect(body).toContain("dd25v_wa = ls_dd25v");
    expect(body).toContain("TABLES    dd26v_tab = lt_dd26v");
    expect(body).toContain("dd27p_tab = lt_dd27p");
    expect(body).toContain(
      "EXCEPTIONS view_not_found = 1 name_inconsistent = 2 view_inconsistent = 3",
    );
    expect(body).toContain("put_failure = 4 put_refused = 5 OTHERS = 6.");
    expect(body).toContain("CALL FUNCTION 'DDIF_VIEW_ACTIVATE'");
    expect(body).toContain("IMPORTING rc = lv_rc");
    expect(body).toContain("EXCEPTIONS not_found = 1 put_failure = 2 OTHERS = 3.");

    // The DATA section carries the `DATA` keyword this file never puts in
    // VIEW_DATA_LINES itself — ddicBridgeSource prepends it.
    expect(body).toContain("DATA ls_dd25v TYPE dd25v.");
    expect(body).toContain("DATA lt_dd27p TYPE STANDARD TABLE OF dd27p.");

    // $TMP: no RS_CORR_INSERT/korrnum in the source at all.
    expect(body).not.toContain("RS_CORR_INSERT");
    expect(body).not.toContain("korrnum");

    // Explicitly out of scope, and it must stay out: no SE54 wizard call is
    // ever generated here.
    expect(body).not.toContain("VIEW_MAINTENANCE_GENERATE");
    expect(body).not.toContain("SE55");
  });

  it("projects the caller's fields, in order, into DD27P rows", () => {
    const lines = classicViewFragment(VIEW);
    const viewFields = lines
      .filter((l) => l.startsWith("ls_dd27p-viewfield"))
      .map((l) => l.split("=")[1]?.trim());
    expect(viewFields).toEqual(["'MANDT'.", "'CARRID'.", "'CARRNAME'."]);
    // Base table into DD26V, projected fields into DD27P — the DDIC reading of
    // the TABLES parameters. See classicViewFragment's ASSUMPTION block: the
    // capture's own inline comments read the other way round and appear
    // shifted by one; only this payload split, never the parameter names,
    // depends on which reading is right.
    expect(lines).toContain("ls_dd26v-tabname  = 'SCARR'.");
    expect(lines).toContain("ls_dd26v-tabpos   = '0001'.");
    expect(lines.filter((l) => l.startsWith("ls_dd26v-tabname")).length).toBe(1);
  });
});
