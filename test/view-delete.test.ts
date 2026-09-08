/**
 * `VIEW/DV` (classic database view) delete bridge — offline; mirrors
 * `test/view-create.test.ts`'s fixture/gate/route style (see that file's
 * header for the S3 rewire background: one static `ZCL_ZMCP_FLUID_CLASSIC`
 * body class now serves `delete_view` too, deployed through
 * `test/helpers/fluid-classic-fake.ts`'s shared `classicFake`, in place of
 * this file's own former `objectHappyPath`/`classrunOutput` routing and the
 * generated-per-call `viewDeleteFragment`/`VIEW_DELETE_DATA_LINES` this file
 * used to import directly from `../src/adt/view-delete.js`.
 *
 * `deleteClassicViewViaBridge` itself (`../src/adt/view-delete.ts`) is
 * UNCHANGED by the S3 rewire — it still validates, gates `VIEW/DV` as a
 * `delete`, and calls through to the classic tool, now via `runClassicAction`
 * instead of the old `ddicBridgeSource`/`runDdicBridge` path. What changed is
 * `delete_view`'s ABAP: it is now one static method inside `viewPart`
 * (`../src/adt/fluid/builtin/classic/abap-view.ts`), reading `view_name` at
 * ABAP runtime via `s()` rather than having its literal baked in per call —
 * so a caller's specific view name is no longer visible in generated text,
 * and structural assertions replace the old per-call literal comparisons
 * (each one called out in place, with a short "why").
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate, type Operation, type SafetyTarget, type EvaluateOptions } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import {
  DDIC_ERR_PREFIX,
  DDIC_TAGS,
  assertDdicTranscript,
  parseDdicTranscript,
  type DdicTag,
} from "../src/adt/ddic-transcript.js";
import { deleteClassicViewViaBridge, type ViewDeleteParams } from "../src/adt/view-delete.js";
import { viewPart } from "../src/adt/fluid/builtin/classic/abap-view.js";
import { CLASSIC_BODY_CLASS, CLASSIC_TOOL_ID } from "../src/adt/fluid/builtin/classic.js";
import { serverPackage, type ServerPackage } from "../src/adt/resolved-package.js";
import type { VerifyOutcome } from "../src/adt/write-verify.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { forgetManifest } from "../src/adt/fluid/registry.js";
import { systemKey } from "../src/journal.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { classicFake, useFluidState } from "./helpers/fluid-classic-fake.js";

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

const fluidState = useFluidState();

beforeEach(async () => {
  resetFluidEnsureState();
  resetFluidPackageMemo();
  // The fluid registry is an on-disk cache keyed by stateDir, and every test
  // in this file shares one stateDir (useFluidState() memoizes it per file).
  // Without this, the first test's deploy leaves a "classic is already at
  // this version" cache entry that makes every later test's own (empty,
  // per-test) classicFake skip the deploy entirely.
  await forgetManifest(cfg(), systemKey(cfg()), CLASSIC_TOOL_ID);
});

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    readOnly: false,
    fluidApi: true,
    stateDir: fluidState.dir(),
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

/** Session/discovery plumbing shared by every test below — deploy/classrun routing is `classicFake`'s job. */
const sharedRoute = (o: HttpClientOptions): HttpClientResponse | undefined => {
  if (o.url.includes(SESSION_URL)) {
    return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
  }
  if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
  return undefined;
};

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

/** A fresh classicFake wired for delete_view, answering with the given tags. */
const deleteFake = (tags: readonly string[] = ["VIEW-DELETED", "VIEW-GONE"]) =>
  classicFake({ action: "delete_view", lines: () => tags });

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!e || !isAbapError(e)) throw new Error(`expected an AbapError, got ${String(e)}`);
  return e;
};

const offline = null as unknown as AbapConnection;

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

const VIEW = "ZTM_TESTVIEW";
const PKG = "ZTM_TESTPKG";

/** Allows both the fluid tool's own deploy package and the view's own package. */
const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [FLUID_PACKAGE, PKG],
    allowNamePrefixes: ["*"],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

/** Allows the fluid deploy package only — the domain gate must refuse the view delete before anything reaches the wire. */
const fluidOnlyGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [FLUID_PACKAGE],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

/** Mirrors test/resolved-package.test.ts's `confirmed` helper — the only legitimate way to mint a `ServerPackage`. */
const confirmedOutcome = (packageName: string | undefined): VerifyOutcome => ({
  status: "confirmed",
  uri: "/sap/bc/adt/vit/wb/object_type/viewdv/object_name/ZTM_TESTVIEW",
  via: "vit-bridge",
  packageName,
});

const SERVER_PKG: ServerPackage = serverPackage(confirmedOutcome(PKG))!;

const PARAMS: ViewDeleteParams = { viewName: VIEW, packageName: SERVER_PKG };

// `delete_view`'s method body, sliced out of the static class source once —
// every structural assertion below reads this slice, not a per-call
// generated fragment (see this file's header). `viewPart.source` ends right
// after delete_view's own ENDMETHOD, so the slice runs to the array's end.
const allSourceLines = viewPart.source.split("\n");
const deleteIdx = allSourceLines.findIndex((l) => l.trim() === "METHOD delete_view.");
const deleteLines = allSourceLines.slice(deleteIdx);
const deleteTrim = deleteLines.map((l) => l.trim());

/** Every `line( 'TAG' )` call in delete_view's source, in emission order. */
function emittedTags(lines: readonly string[]): string[] {
  const found: string[] = [];
  for (const l of lines) {
    const m = /^line\( '([^']*)' \)\.$/.exec(l.trim());
    if (m?.[1] !== undefined) found.push(m[1]);
  }
  return found;
}

// ---------------------------------------------------------------------------
// 1 - every tag delete_view writes is a tag the shared parser knows
// ---------------------------------------------------------------------------

describe("delete_view only ever writes tags DDIC_TAGS declares", () => {
  it("VIEW-DELETED and VIEW-GONE, and nothing else — asserted as a set, in emission order", () => {
    const tags = emittedTags(deleteLines);
    expect(new Set(tags)).toEqual(new Set(["VIEW-DELETED", "VIEW-GONE"]));
    expect(tags).toEqual(["VIEW-DELETED", "VIEW-GONE"]);
    for (const tag of tags) expect(DDIC_TAGS as readonly string[]).toContain(tag);
  });

  it("every tag delete_view writes is one parseDdicTranscript recognises", () => {
    const tags = emittedTags(deleteLines);
    const parsed = parseDdicTranscript(tags.join("\n"));
    expect(parsed.tags).toEqual(tags);
    expect(parsed.errorLine).toBeUndefined();
    expect(() =>
      assertDdicTranscript(parsed, tags as DdicTag[], "Deleting classic view"),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2 - input validation, refused before any network call
// ---------------------------------------------------------------------------

describe("a malformed view name is refused before any network call", () => {
  const bad = ["Z'FOO", "Z.FOO", "Z\nFOO", "Z FOO"];

  it.each(bad)("%s is refused with BAD_INPUT, not escaped or stripped", async (viewName) => {
    const err = await catchErr(
      deleteClassicViewViaBridge(offline, allowingGate(), { viewName, packageName: SERVER_PKG }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("zero requests reach the fake server for any of these", async () => {
    const { conn, inner } = await connected(combine(deleteFake().route, sharedRoute));
    for (const viewName of bad) {
      await catchErr(deleteClassicViewViaBridge(conn, allowingGate(), { viewName, packageName: SERVER_PKG }));
    }
    expect(inner.calls.length).toBe(0);
  });

  it("a view name longer than 30 characters is refused", async () => {
    const tooLong = `Z${"A".repeat(30)}`;
    const err = await catchErr(
      deleteClassicViewViaBridge(offline, allowingGate(), { viewName: tooLong, packageName: SERVER_PKG }),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("30");
  });
});

// ---------------------------------------------------------------------------
// 3 - safety gate runs first, zero-network, and sees op "delete"
// ---------------------------------------------------------------------------

describe("safety gate — asserted as a delete on the domain object, and runs FIRST (zero-network)", () => {
  it("gate.assert sees op 'delete' with type VIEW/DV and the view's own name, not 'write'", async () => {
    const seen: Array<{ op: string; type?: string; name?: string }> = [];
    class RecordingGate extends SafetyGate {
      override assert(op: Operation, obj?: SafetyTarget, opts: EvaluateOptions = {}): void {
        if (obj?.type === "VIEW/DV") seen.push({ op, type: obj.type, name: obj.name });
        super.assert(op, obj, opts);
      }
    }
    const gate = new RecordingGate({
      readOnly: false,
      allowPackages: [FLUID_PACKAGE, PKG],
      allowNamePrefixes: ["*"],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const { conn } = await connected(combine(deleteFake().route, sharedRoute));
    await deleteClassicViewViaBridge(conn, gate, PARAMS);
    expect(seen).toEqual([{ op: "delete", type: "VIEW/DV", name: VIEW }]);
  });

  it("a gate that refuses the view's package refuses the whole call with ZERO HTTP requests", async () => {
    const { conn, inner } = await connected(combine(deleteFake().route, sharedRoute));
    const err = await catchErr(deleteClassicViewViaBridge(conn, fluidOnlyGate(), PARAMS));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(inner.calls.length).toBe(0);
  });

  it("a readOnly gate refuses too, zero requests made", async () => {
    const { conn, inner } = await connected(combine(deleteFake().route, sharedRoute));
    const readOnly = new SafetyGate({
      readOnly: true,
      allowPackages: [FLUID_PACKAGE, PKG],
      writesLockedOut: false,
    });
    const err = await catchErr(deleteClassicViewViaBridge(conn, readOnly, PARAMS));
    expect(err).toBeTruthy();
    expect(inner.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3b - a caller-claimed (unbranded) package is refused before the gate is
//      even consulted — a doc comment cannot enforce this, only the type +
//      runtime assertion can (see src/adt/resolved-package.ts)
// ---------------------------------------------------------------------------

describe("packageName must be a genuine server-resolved ServerPackage, not a caller-claimed string", () => {
  it("a value forced through `as unknown as ServerPackage` (how a real bypass looks) is refused SAFETY_DENIED/PACKAGE_UNKNOWN, the gate is NEVER consulted, and no ABAP is generated", async () => {
    let gateCalls = 0;
    class RecordingGate extends SafetyGate {
      override assert(...args: Parameters<SafetyGate["assert"]>): void {
        gateCalls++;
        super.assert(...args);
      }
    }
    const gate = new RecordingGate({
      readOnly: false,
      allowPackages: [FLUID_PACKAGE, PKG],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const { conn, inner } = await connected(combine(deleteFake().route, sharedRoute));
    const forged = PKG as unknown as ServerPackage;
    const err = await catchErr(deleteClassicViewViaBridge(conn, gate, { viewName: VIEW, packageName: forged }));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details.reason).toBe("PACKAGE_UNKNOWN");
    // The load-bearing assertions: not just "it threw", but that it threw
    // BEFORE the gate saw anything and before any HTTP request was made.
    expect(gateCalls).toBe(0);
    expect(inner.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4 - the static source delete_view deploys (closed template — regression
//     guard)
// ---------------------------------------------------------------------------

describe("delete_view's static source (closed template — regression guard)", () => {
  it("DD_OBJ_DEL ('A') call, THEN an IF sy-subrc <> 0 guard, THEN the VIEW-DELETED tag — in that order", () => {
    const callIdx = deleteTrim.indexOf("CALL FUNCTION 'DD_OBJ_DEL'");
    const guardIdx = deleteTrim.findIndex((l, i) => i > callIdx && l === "IF sy-subrc <> 0.");
    const tagIdx = deleteTrim.findIndex((l, i) => i > guardIdx && l === "line( 'VIEW-DELETED' ).");
    expect(callIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeGreaterThan(callIdx);
    expect(tagIdx).toBeGreaterThan(guardIdx);
  });

  // The old generator wrote `object_name = '<VIEW>'.` as a per-call literal,
  // so a caller's specific view name was visible in the generated text.
  // That's gone: delete_view is one static source, and object_name is read
  // from lv_view (itself s('view_name') at ABAP runtime) — there is no
  // TS-side subject left to compare a caller's literal view name against.
  // What remains provable is the call shape itself.
  it("the active-version ('A') call carries object_name = lv_view, object_type/del_state/prid, and EXCEPTIONS OTHERS = 1 — never a per-call baked view-name literal", () => {
    const start = deleteTrim.indexOf("CALL FUNCTION 'DD_OBJ_DEL'");
    expect(start).toBeGreaterThanOrEqual(0);
    const stmt = deleteTrim.slice(start, start + 8);
    expect(stmt).toContain("object_name = lv_view");
    expect(stmt).toContain("object_type = 'VIEW'");
    expect(stmt).toContain("del_state   = 'A'");
    expect(stmt).toContain("prid        = -1");
    expect(stmt).toContain("OTHERS      = 1.");
    expect(deleteTrim).toContain("lv_view = s( 'view_name' ).");
  });

  it("a SECOND DD_OBJ_DEL call clears the inactive version with del_state = 'N', and is NOT subrc-guarded", () => {
    const calls = deleteTrim
      .map((l, i) => (l === "CALL FUNCTION 'DD_OBJ_DEL'" ? i : -1))
      .filter((i) => i >= 0);
    expect(calls.length).toBe(2);
    const [firstIdx, secondIdx] = calls;
    expect(deleteTrim.slice(firstIdx, firstIdx + 8)).toContain("del_state   = 'A'");
    expect(deleteTrim.slice(secondIdx, secondIdx + 8)).toContain("del_state   = 'N'");
    // The second call's own statement block has no "IF sy-subrc <> 0." guard
    // immediately after it — that pattern only follows the FIRST call.
    expect(deleteTrim.slice(secondIdx, secondIdx + 11)).not.toContain("IF sy-subrc <> 0.");
  });

  it("TR_TADIR_INTERFACE is generated with wi_test_modus = space AND wi_delete_tadir_entry = 'X' (the silent-no-op trap), wi_tadir_obj_name = lv_view — never a per-call baked view-name literal", () => {
    const start = deleteTrim.indexOf("CALL FUNCTION 'TR_TADIR_INTERFACE'");
    expect(start).toBeGreaterThanOrEqual(0);
    const stmt = deleteTrim.slice(start, start + 8);
    expect(stmt).toContain("wi_test_modus         = space");
    expect(stmt).toContain("wi_tadir_pgmid        = 'R3TR'");
    expect(stmt).toContain("wi_tadir_object       = 'VIEW'");
    expect(stmt).toContain("wi_tadir_obj_name     = lv_view");
    expect(stmt).toContain("wi_delete_tadir_entry = 'X'");
  });

  it("the TADIR residue re-read is emitted BEFORE the VIEW-GONE tag", () => {
    const tadirSelectIdx = deleteTrim.indexOf("SELECT COUNT( * ) FROM tadir INTO @lv_tadir_count");
    const goneIdx = deleteTrim.indexOf("line( 'VIEW-GONE' ).");
    expect(tadirSelectIdx).toBeGreaterThanOrEqual(0);
    expect(goneIdx).toBeGreaterThan(tadirSelectIdx);
  });

  it("a surviving TADIR row produces a fail() naming TR022 that does not claim nothing was deleted", () => {
    const body = deleteLines.join("\n");
    expect(body).toContain("TR022");
    expect(body).not.toContain("the delete did nothing");
    expect(body).toContain("the DD25L delete worked");
  });

  it("RS_DD_DELETE_OBJ and DDIF_VIEW_DELETE appear nowhere in delete_view's source", () => {
    const body = deleteLines.join("\n");
    expect(body).not.toContain("RS_DD_DELETE_OBJ");
    expect(body).not.toContain("DDIF_VIEW_DELETE");
  });

  it("is pure ASCII — no em-dash or other non-ASCII character", () => {
    const body = deleteLines.join("\n");
    expect(body).not.toMatch(/—/);
    expect(/[^\x00-\x7F]/.test(body)).toBe(false);
  });

  it('every comment uses " — never a *-style comment', () => {
    expect(deleteTrim.filter((l) => l.startsWith("*"))).toEqual([]);
    expect(deleteTrim.some((l) => l.startsWith('"'))).toBe(true);
  });

  // The old VIEW_DELETE_DATA_LINES export is gone — delete_view now declares
  // its own locals inline, pinned here directly against the static source.
  it("declares the locals the method relies on", () => {
    expect(deleteTrim).toContain("DATA ls_dd25l TYPE dd25l.");
    expect(deleteTrim).toContain("DATA lv_dd25l_count TYPE i.");
    expect(deleteTrim).toContain("DATA lv_tadir_count TYPE i.");
  });
});

// ---------------------------------------------------------------------------
// 5 - partial delete: VIEW-DELETED without VIEW-GONE is a failure
//     (the most important test in this file)
// ---------------------------------------------------------------------------

describe("VIEW-DELETED without VIEW-GONE is a failure, not a partial success", () => {
  it("a transcript that stops after VIEW-DELETED (e.g. a default STATE that only deleted the inactive version) throws CHECK_FAILED naming the missing VIEW-GONE marker", async () => {
    const { conn } = await connected(combine(deleteFake(["VIEW-DELETED"]).route, sharedRoute));
    const err = await catchErr(deleteClassicViewViaBridge(conn, allowingGate(), PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("VIEW-GONE");
  });
});

// ---------------------------------------------------------------------------
// 6 - non-existent view: named refusal, not a generic missing-tag error
// ---------------------------------------------------------------------------

describe("a non-existent view produces a named refusal from beforeAssert, not a generic missing-tag CHECK_FAILED", () => {
  it("says the view does not exist, and carries the raw ABAP-side detail", async () => {
    const { conn } = await connected(
      combine(deleteFake([`${DDIC_ERR_PREFIX} view ${VIEW} does not exist`]).route, sharedRoute),
    );
    const err = await catchErr(deleteClassicViewViaBridge(conn, allowingGate(), PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain(`${VIEW} does not exist`);
  });
});

// ---------------------------------------------------------------------------
// 7 - empty transcript, and a ZMCP-DDIC-ERR> transcript, are both failures
// ---------------------------------------------------------------------------

describe("empty and ZMCP-DDIC-ERR> transcripts are both failures", () => {
  it("an empty transcript (no tags at all) throws CHECK_FAILED, not a silent success", async () => {
    const { conn } = await connected(combine(deleteFake([]).route, sharedRoute));
    const err = await catchErr(deleteClassicViewViaBridge(conn, allowingGate(), PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
  });

  it("the post-COMMIT DD25L row survives: still tagged an error, not swallowed", async () => {
    const { conn } = await connected(
      combine(
        deleteFake([
          "VIEW-DELETED",
          `${DDIC_ERR_PREFIX} delete of ${VIEW} reported no error but DD25L still has a row`,
        ]).route,
        sharedRoute,
      ),
    );
    const err = await catchErr(deleteClassicViewViaBridge(conn, allowingGate(), PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("DD25L still has a row");
  });
});

// ---------------------------------------------------------------------------
// 8 - happy path
// ---------------------------------------------------------------------------

describe("deleteClassicViewViaBridge happy path", () => {
  it("VIEW-DELETED, VIEW-GONE resolves; the deployed static body's source carries DD_OBJ_DEL, TR_TADIR_INTERFACE, COMMIT WORK, and the DD25L/TADIR re-reads in that order", async () => {
    const fake = deleteFake();
    const { conn } = await connected(combine(fake.route, sharedRoute));
    const { transcript } = await deleteClassicViewViaBridge(conn, allowingGate(), PARAMS);
    expect(transcript.tags).toEqual(["VIEW-DELETED", "VIEW-GONE"]);
    expect(transcript.errorLine).toBeUndefined();

    const invoker = fake.invoker();
    expect(invoker).toBeTruthy();
    const fullBody = fake.sourceOf(CLASSIC_BODY_CLASS) ?? "";
    // The static body carries both create_view and delete_view; scope every
    // indexOf to delete_view's own method so a create_view occurrence
    // earlier in the same source can never satisfy these order checks.
    const methodIdx = fullBody.indexOf("METHOD delete_view.");
    expect(methodIdx).toBeGreaterThanOrEqual(0);
    const body = fullBody.slice(methodIdx);
    const deleteCallIdx = body.indexOf("CALL FUNCTION 'DD_OBJ_DEL'");
    const tadirCallIdx = body.indexOf("CALL FUNCTION 'TR_TADIR_INTERFACE'");
    const commitIdx = body.indexOf("COMMIT WORK.");
    const reselectIdx = body.indexOf("SELECT COUNT( * ) FROM dd25l INTO @lv_dd25l_count");
    const tadirReselectIdx = body.indexOf("SELECT COUNT( * ) FROM tadir");
    expect(deleteCallIdx).toBeGreaterThanOrEqual(0);
    expect(tadirCallIdx).toBeGreaterThan(deleteCallIdx);
    expect(commitIdx).toBeGreaterThan(tadirCallIdx);
    expect(reselectIdx).toBeGreaterThan(commitIdx);
    expect(tadirReselectIdx).toBeGreaterThan(reselectIdx);
  });

  // The old fixed bridge-class-name assertion (ZCL_ZMCP_DDIC_DVIEW) has no
  // subject left: there is no more per-operation bridge class, only one
  // content-hashed invoker shared by every classic action. What replaces
  // "gates against the correct bridge class" is proving the RIGHT static
  // body actually deployed and ran — its source carries both create_view
  // and delete_view, the same invoker view-create.test.ts's own happy path
  // proves deploys for create.
  it("deploys a content-hashed invoker calling into the static body, whose source carries delete_view (and create_view, from the same static body)", async () => {
    const fake = deleteFake();
    const { conn } = await connected(combine(fake.route, sharedRoute));
    await deleteClassicViewViaBridge(conn, allowingGate(), PARAMS);
    const invoker = fake.invoker();
    expect(invoker).toBeTruthy();
    expect(fake.sourceOf(invoker!)).toContain("zcl_zmcp_fluid_classic=>run( iv_action = 'delete_view'");
    const source = fake.sourceOf(CLASSIC_BODY_CLASS);
    expect(source).toBeTruthy();
    expect(source).toContain("METHOD delete_view.");
    expect(source).toContain("METHOD create_view.");
  });
});
