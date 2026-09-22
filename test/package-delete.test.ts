/**
 * `DEVC/K` (package) delete — offline, against the fluid `classic` tool.
 * Mirrors `test/package-create.test.ts`'s fixture/gate/route style, itself
 * mirroring `test/tran-create.test.ts` / `test/index-create.test.ts`.
 *
 * `abap-package.ts`'s `delete_package` method reads every value at RUNTIME
 * via `s('path')`, so the deployed body class is a fixed, argument-independent
 * string — as with every other classic action in this rewrite. The old
 * per-call `packageDeleteFragment` generator and its dedicated
 * `subrcGuardFragment`/`subrcCheckFragment` helpers no longer exist: the
 * `IF sy-subrc <> 0. fail(...). RETURN. ENDIF.` guard shape they used to
 * assemble is now written directly into the static template. Those
 * generator-level unit tests are replaced by structural scans of
 * `packagePart.source`'s `delete_package` slice; the tests that exercised
 * actual runtime BEHAVIOUR (`deletePackageViaBridge`'s `beforeAssert`,
 * `parsePackageContents`, the SET_CHANGEABLE_STEP lock-shaped hint) port
 * essentially unchanged, since none of that logic moved.
 *
 * One structural fact worth calling out: unlike `create_package`'s single
 * unconditional `lo_package->save` (transport always known, since
 * `assertCorrNr` requires it), `delete_package`'s `save` is a compiled-in
 * `IF lv_corr_nr IS INITIAL. ... ELSE. ... ENDIF.` pair — a local (`$`)
 * package's delete really does skip `i_transport_request` entirely, decided
 * at runtime by whatever the caller's `corr_nr` argument resolves to.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate, type EvaluateOptions, type Operation, type SafetyTarget } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { DDIC_ERR_PREFIX, parseDdicTranscript } from "../src/adt/ddic-transcript.js";
import {
  PKG_CONTENT_PREFIX,
  SET_CHANGEABLE_STEP,
  deletePackageViaBridge,
  parsePackageContents,
  type PackageDeleteParams,
} from "../src/adt/package-delete.js";
import { packagePart } from "../src/adt/fluid/builtin/classic/abap-package.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { canonicalArgsJson } from "../src/adt/fluid/invoke.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import { classicFake, useFluidState } from "./helpers/fluid-classic-fake.js";

// ---------------------------------------------------------------------------
// Fake transport — same shape as test/package-create.test.ts
// ---------------------------------------------------------------------------

const fluidState = useFluidState();

type Route = (o: HttpClientOptions) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
  readonly calls: HttpClientOptions[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    const res = this.route(o);
    if (!res) throw new Error(`FakeAdt: unrouted request ${(o.method ?? "GET").toUpperCase()} ${o.url}`);
    return res;
  }
}

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

function baseRoute(o: HttpClientOptions): HttpClientResponse | undefined {
  if (o.url.includes("/compatibility/graph")) {
    return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
  }
  if (o.url.endsWith("/discovery")) return resp(200, "<service/>", { "content-type": "application/xml" });
  if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
  return undefined;
}

function cfg(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    readOnly: false,
    fluidApi: true,
    stateDir: fluidState.dir(),
    ...overrides,
  });
}

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

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!e || !isAbapError(e)) throw new Error(`expected an AbapError, got ${String(e)}`);
  return e;
};

beforeEach(() => {
  resetFluidEnsureState();
  resetFluidPackageMemo();
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

const PKG = "ZTM_TESTPKG";

/** Allows both the fluid deploy package and the package's own name (its container for a delete). */
const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [FLUID_PACKAGE, PKG],
    allowNamePrefixes: ["*"],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

/** Allows only the fluid tool's own deploy package — the domain gate must refuse first. */
const bridgeOnlyGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [FLUID_PACKAGE],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRANSPORT_PARAMS: PackageDeleteParams = { packageName: PKG, corrNr: "A4HK900123" };
const LOCAL_PARAMS: PackageDeleteParams = { packageName: PKG, corrNr: "" };

const objRow = (n: string) => `${PKG_CONTENT_PREFIX} KIND=OBJECT PGMID=R3TR OBJECT=CLAS NAME=${n}`;
const subpkgRow = (n: string) => `${PKG_CONTENT_PREFIX} KIND=SUBPKG PGMID=R3TR OBJECT=DEVC NAME=${n}`;

const DELETE_METHOD = packagePart.source.slice(
  packagePart.source.indexOf("METHOD delete_package."),
);

// ---------------------------------------------------------------------------
// 1 — parsePackageContents, pure/offline (unchanged by the rewire)
// ---------------------------------------------------------------------------

describe("parsePackageContents", () => {
  it("parses several content lines, both OBJECT and SUBPKG kinds, in order", () => {
    const raw = [objRow("ZCL_FOO"), subpkgRow("ZTM_CHILD"), objRow("ZCL_BAR")].join("\n");
    expect(parsePackageContents(raw)).toEqual({
      contents: [
        { kind: "OBJECT", pgmid: "R3TR", object: "CLAS", name: "ZCL_FOO" },
        { kind: "SUBPKG", pgmid: "R3TR", object: "DEVC", name: "ZTM_CHILD" },
        { kind: "OBJECT", pgmid: "R3TR", object: "CLAS", name: "ZCL_BAR" },
      ],
    });
  });

  it("ignores unrelated transcript lines", () => {
    const raw = ["PKG-EMPTY", objRow("ZCL_FOO"), "PKG-DELETED", "PKG-GONE"].join("\n");
    expect(parsePackageContents(raw).contents).toEqual([
      { kind: "OBJECT", pgmid: "R3TR", object: "CLAS", name: "ZCL_FOO" },
    ]);
  });

  it("parses well past the old 20-row cap with no loss — every row comes back", () => {
    const names = Array.from({ length: 37 }, (_, i) => `ZCL_FOO${i}`);
    const raw = names.map(objRow).join("\n");
    const { contents } = parsePackageContents(raw);
    expect(contents).toHaveLength(37);
    expect(contents.map((c) => c.name)).toEqual(names);
  });

  it("empty input gives { contents: [] }", () => {
    expect(parsePackageContents("")).toEqual({ contents: [] });
  });

  it("DELFLAG=X with TRKORR and TASK present parses as deleted, with both trkorr and task", () => {
    const raw = `${PKG_CONTENT_PREFIX} KIND=OBJECT PGMID=R3TR OBJECT=CLAS NAME=ZCL_FOO DELFLAG=X TRKORR=A4HK900346 TASK=A4HK900347`;
    expect(parsePackageContents(raw).contents).toEqual([
      { kind: "OBJECT", pgmid: "R3TR", object: "CLAS", name: "ZCL_FOO", deleted: true, trkorr: "A4HK900346", task: "A4HK900347" },
    ]);
  });

  it("DELFLAG/TRKORR/TASK all empty parses as a plain live row — no deleted, trkorr or task key at all", () => {
    const raw = `${PKG_CONTENT_PREFIX} KIND=OBJECT PGMID=R3TR OBJECT=CLAS NAME=ZCL_FOO DELFLAG= TRKORR= TASK=`;
    expect(parsePackageContents(raw).contents).toEqual([{ kind: "OBJECT", pgmid: "R3TR", object: "CLAS", name: "ZCL_FOO" }]);
  });

  it("DELFLAG=X with empty TRKORR/TASK parses as deleted with no trkorr and no task key", () => {
    const raw = `${PKG_CONTENT_PREFIX} KIND=OBJECT PGMID=R3TR OBJECT=CLAS NAME=ZCL_FOO DELFLAG=X TRKORR= TASK=`;
    expect(parsePackageContents(raw).contents).toEqual([
      { kind: "OBJECT", pgmid: "R3TR", object: "CLAS", name: "ZCL_FOO", deleted: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2 — regression guard: static ABAP source structure (closed template)
// ---------------------------------------------------------------------------

describe("abap-package.ts's delete_package method (closed template — regression guard)", () => {
  it("every CALL METHOD carries an EXCEPTIONS ... OTHERS clause", () => {
    const lines = DELETE_METHOD.split("\n");
    const callIdxs = lines.reduce<number[]>((acc, l, i) => {
      if (l.trim().startsWith("CALL METHOD")) acc.push(i);
      return acc;
    }, []);
    // load_package, set_changeable, delete, save(local branch), save(transport branch).
    expect(callIdxs.length).toBe(5);
    for (const start of callIdxs) {
      const end = lines.findIndex((l, i) => i >= start && l.trim().endsWith("."));
      const stmt = lines.slice(start, end + 1).join("\n");
      expect(stmt).toContain("EXCEPTIONS");
      expect(stmt).toContain("OTHERS");
    }
  });

  it("no unguarded functional-call syntax survives for load_package/set_changeable/delete/save", () => {
    const codeOnly = DELETE_METHOD.split("\n")
      .filter((l) => !l.trim().startsWith('"'))
      .join("\n");
    for (const call of [
      "cl_package_factory=>load_package(",
      "lo_package->set_changeable(",
      "lo_package->delete(",
      "lo_package->save(",
    ]) {
      expect(codeOnly).not.toContain(call);
    }
    expect(DELETE_METHOD).not.toContain("if_package~");
  });

  it("the save call branches on lv_corr_nr IS INITIAL — only the ELSE branch carries i_transport_request", () => {
    const guardIdx = DELETE_METHOD.indexOf("IF lv_corr_nr IS INITIAL.");
    const elseIdx = DELETE_METHOD.indexOf("ELSE.", guardIdx);
    const endIdx = DELETE_METHOD.indexOf("ENDIF.", elseIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    const ifBranch = DELETE_METHOD.slice(guardIdx, elseIdx);
    const elseBranch = DELETE_METHOD.slice(elseIdx, endIdx);
    expect(ifBranch).not.toContain("i_transport_request");
    expect(elseBranch).toContain("i_transport_request = lv_corr_nr");
    // exactly one save call is a functional-call-free CALL METHOD in each branch
    expect(ifBranch).toContain("CALL METHOD lo_package->save");
    expect(elseBranch).toContain("CALL METHOD lo_package->save");
  });

  it("emits PKG-EMPTY, PKG-DELETED, PKG-GONE, in that source order", () => {
    const tags = [...DELETE_METHOD.matchAll(/line\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]!);
    expect(tags).toEqual(["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"]);
  });

  it("re-reads TDEVC strictly AFTER COMMIT WORK, and fails if the row still exists — the only proof delete happened", () => {
    const commitIdx = DELETE_METHOD.indexOf("COMMIT WORK.");
    const deletedTagIdx = DELETE_METHOD.indexOf("line( 'PKG-DELETED' )");
    const reselectIdx = DELETE_METHOD.indexOf("SELECT SINGLE * FROM tdevc", deletedTagIdx);
    const errIdx = DELETE_METHOD.indexOf("still exists");
    const goneIdx = DELETE_METHOD.indexOf("line( 'PKG-GONE' )");
    expect(commitIdx).toBeGreaterThan(-1);
    expect(deletedTagIdx).toBeGreaterThan(commitIdx);
    expect(reselectIdx).toBeGreaterThan(deletedTagIdx);
    expect(errIdx).toBeGreaterThan(reselectIdx);
    expect(goneIdx).toBeGreaterThan(errIdx);
  });

  it("a non-empty package's content query stops BEFORE cl_package_factory is ever touched", () => {
    const guardIdx = DELETE_METHOD.indexOf("IF lv_content_count > 0.");
    const returnIdx = DELETE_METHOD.indexOf("RETURN.", guardIdx);
    const loadIdx = DELETE_METHOD.indexOf("CALL METHOD cl_package_factory=>load_package");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeGreaterThan(guardIdx);
    expect(loadIdx).toBeGreaterThan(returnIdx);
  });

  it("the package's own R3TR DEVC row in TADIR is excluded from the content evidence, but a same-named object is not otherwise special-cased", () => {
    expect(DELETE_METHOD).toContain("ls_tadir-pgmid = 'R3TR' AND ls_tadir-object = 'DEVC' AND ls_tadir-obj_name = lv_package");
  });

  it('every comment line uses " — never a *-style comment', () => {
    const starComments = DELETE_METHOD.split("\n").filter((l) => l.trim().startsWith("*"));
    expect(starComments).toEqual([]);
    expect(DELETE_METHOD.split("\n").some((l) => l.trim().startsWith('"'))).toBe(true);
  });

  it("is pure ASCII", () => {
    expect(/[^\x00-\x7F]/.test(DELETE_METHOD)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3 — wire-content: the invoker's JSON payload carries the caller's args unmangled
// ---------------------------------------------------------------------------

describe("the invoker's JSON payload carries the caller's exact package_name/corr_nr", () => {
  it("transportable delete", async () => {
    const fake = classicFake({ action: "delete_package", lines: () => ["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"] });
    const { conn } = await connected(fake.route);
    await deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS);
    const src = fake.sourceOf(fake.invoker()!);
    const payload = [...src!.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join("");
    expect(payload).toBe(canonicalArgsJson({ package_name: PKG, corr_nr: "A4HK900123" }));
  });

  it("local delete (corr_nr empty string)", async () => {
    const fake = classicFake({ action: "delete_package", lines: () => ["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"] });
    const { conn } = await connected(fake.route);
    await deletePackageViaBridge(conn, allowingGate(), LOCAL_PARAMS);
    const src = fake.sourceOf(fake.invoker()!);
    const payload = [...src!.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join("");
    expect(payload).toBe(canonicalArgsJson({ package_name: PKG, corr_nr: "" }));
  });
});

// ---------------------------------------------------------------------------
// 4 — input validation, refused before any network call
// ---------------------------------------------------------------------------

describe("input validation is refused before any network call", () => {
  const offline = null as unknown as AbapConnection;

  it("a bad package name is refused", async () => {
    const err = await catchErr(deletePackageViaBridge(offline, allowingGate(), { packageName: "1BAD", corrNr: "" }));
    expect(err.code).toBe("BAD_INPUT");
  });

  it("a package name longer than 30 characters is refused", async () => {
    const tooLong = `Z${"A".repeat(30)}`;
    const err = await catchErr(deletePackageViaBridge(offline, allowingGate(), { packageName: tooLong, corrNr: "" }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("30");
  });

  it("refuses a package name containing a quote, period, or embedded newline — the ABAP-injection guard", async () => {
    for (const bad of ["ZTM'FOO", "ZTM.FOO", "ZTM\nFOO"]) {
      const err = await catchErr(deletePackageViaBridge(offline, allowingGate(), { packageName: bad, corrNr: "" }));
      expect(err.code).toBe("BAD_INPUT");
    }
  });

  it("still refuses a bare $ or $$-prefixed name — allowLocal strips only ONE leading $", async () => {
    for (const bad of ["$", "$$", "$$X"]) {
      const err = await catchErr(deletePackageViaBridge(offline, allowingGate(), { packageName: bad, corrNr: "" }));
      expect(err.code).toBe("BAD_INPUT");
    }
  });

  it("a malformed corr_nr is refused, and the message names corr_nr", async () => {
    const err = await catchErr(
      deletePackageViaBridge(offline, allowingGate(), { packageName: PKG, corrNr: "not-a-trkorr" }),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("corr_nr");
  });

  it('corrNr: "" is legal (local delete, no transport) — validation alone does not throw for it', async () => {
    const err = await catchErr(deletePackageViaBridge(offline, allowingGate(), { packageName: "1BAD", corrNr: "" }));
    // still throws — but for the package name, not for corrNr; confirm corrNr "" alone survives assertOptionalCorrNr.
    expect(err.message).not.toContain("corr_nr");
  });
});

// ---------------------------------------------------------------------------
// 5 — safety gate: asserted as "delete" on the domain object, zero-network
// ---------------------------------------------------------------------------

describe("safety gate — asserted as a delete on the domain object, and runs FIRST (zero-network)", () => {
  it("gate.assert sees op 'delete' with type DEVC/K and the package's own name", async () => {
    const seen: string[] = [];
    class RecordingGate extends SafetyGate {
      override assert(op: Operation, obj?: SafetyTarget, opts?: EvaluateOptions): void {
        if (obj?.type === "DEVC/K" && obj.name === PKG) seen.push(op);
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
    const fake = classicFake({ action: "delete_package", lines: () => ["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"] });
    const { conn } = await connected(fake.route);
    await deletePackageViaBridge(conn, gate, TRANSPORT_PARAMS);
    expect(seen).toEqual(["delete"]);
  });

  it("a gate that refuses the package name refuses the whole call with ZERO HTTP requests", async () => {
    const fake = classicFake({ action: "delete_package", lines: () => ["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"] });
    const { conn, adt } = await connected(fake.route);
    const err = await catchErr(deletePackageViaBridge(conn, bridgeOnlyGate(), TRANSPORT_PARAMS));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(adt.calls.length).toBe(0);
  });

  it("a readOnly gate refuses too, zero requests made", async () => {
    const fake = classicFake({ action: "delete_package", lines: () => ["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"] });
    const { conn, adt } = await connected(fake.route);
    const readOnly = new SafetyGate({ readOnly: true, allowPackages: [FLUID_PACKAGE, PKG], writesLockedOut: false });
    const err = await catchErr(deletePackageViaBridge(conn, readOnly, TRANSPORT_PARAMS));
    expect(err).toBeTruthy();
    expect(adt.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6 — happy path, transportable and LOCAL
// ---------------------------------------------------------------------------

describe("deletePackageViaBridge happy path", () => {
  it("transportable: PKG-EMPTY, PKG-DELETED, PKG-GONE resolves, contents is empty", async () => {
    const fake = classicFake({ action: "delete_package", lines: () => ["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"] });
    const { conn, adt } = await connected(fake.route);
    const { transcript, contents } = await deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS);
    expect(transcript.tags).toEqual(["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"]);
    expect(transcript.errorLine).toBeUndefined();
    expect(contents).toEqual([]);
    expect(adt.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
  });

  it("LOCAL (corrNr: ''): also resolves", async () => {
    const fake = classicFake({ action: "delete_package", lines: () => ["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"] });
    const { conn } = await connected(fake.route);
    const { contents } = await deletePackageViaBridge(conn, allowingGate(), LOCAL_PARAMS);
    expect(contents).toEqual([]);
  });

  it("an identical repeat call issues no second invoker PUT", async () => {
    const fake = classicFake({ action: "delete_package", lines: () => ["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"] });
    const { conn, adt } = await connected(fake.route);
    await deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS);
    const before = adt.calls.length;
    await deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS);
    const putsAfterSecond = adt.calls.slice(before).filter((c) => (c.method ?? "").toUpperCase() === "PUT");
    expect(putsAfterSecond).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7 — non-empty refusal: the most important behavioural test
// ---------------------------------------------------------------------------

describe("a non-empty package is refused, naming what it still contains — not a generic missing-tag error", () => {
  it("a transcript reporting contents (never reaching PKG-EMPTY) throws CHECK_FAILED naming the objects found", async () => {
    const fake = classicFake({ action: "delete_package", lines: () => [objRow("ZCL_KEPT"), subpkgRow("ZTM_CHILD")] });
    const { conn } = await connected(fake.route);
    const err = await catchErr(deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("ZCL_KEPT");
    expect(err.message).toContain("ZTM_CHILD");
  });

  it("a package with more than 20 objects lists every one of them, with no 'capped' text", async () => {
    const names = Array.from({ length: 25 }, (_, i) => `ZCL_KEPT${i}`);
    const fake = classicFake({ action: "delete_package", lines: () => names.map(objRow) });
    const { conn } = await connected(fake.route);
    const err = await catchErr(deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    for (const name of names) {
      expect(err.message).toContain(name);
    }
    expect(err.message).not.toContain("capped");
    expect((err.details as { contents?: unknown[] } | undefined)?.contents).toHaveLength(25);
  });
});

// ---------------------------------------------------------------------------
// 7b — beforeAssert / TRANSPORT_PENDING: contents already deleted (DELFLAG=X)
// but still awaiting a transport release (issue #185)
// ---------------------------------------------------------------------------

function deletedObjRow(n: string, trkorr?: string, task?: string): string {
  const trkorrPart = trkorr !== undefined ? `TRKORR=${trkorr} ` : "";
  const taskPart = task !== undefined ? `TASK=${task} ` : "";
  return `${PKG_CONTENT_PREFIX} KIND=OBJECT PGMID=R3TR OBJECT=CLAS NAME=${n} DELFLAG=X ${trkorrPart}${taskPart}`.trimEnd();
}

describe("a package whose contents are already deleted but pending a transport release (#185)", () => {
  it("every remaining row is pending, on the same request: TRANSPORT_PENDING, names the request, dedupes pendingRequests", async () => {
    const fake = classicFake({
      action: "delete_package",
      lines: () => [deletedObjRow("ZCL_ONE", "A4HK900346", "A4HK900347"), deletedObjRow("ZCL_TWO", "A4HK900346", "A4HK900347")],
    });
    const { conn } = await connected(fake.route);
    const err = await catchErr(deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS));
    expect(err.code).toBe("TRANSPORT_PENDING");
    expect(err.message).toContain("everything left in it is already deleted and waits for a transport release");
    expect(err.message).toContain("ZCL_ONE");
    expect(err.message).toContain("ZCL_TWO");
    expect(err.message).toContain("awaiting release of request A4HK900346, task A4HK900347");
    expect(err.message).toContain("Releasing A4HK900346 will make the package deletable");
    expect(err.message).toContain("abap_transport_release");
    expect((err.details as { pendingRequests?: string[] }).pendingRequests).toEqual(["A4HK900346"]);
  });

  it("a pending object whose request could not be found from E071: no trkorr, pendingRequests is empty", async () => {
    const fake = classicFake({ action: "delete_package", lines: () => [deletedObjRow("ZCL_ORPHAN")] });
    const { conn } = await connected(fake.route);
    const err = await catchErr(deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS));
    expect(err.code).toBe("TRANSPORT_PENDING");
    expect(err.message).toContain("could not be found from E071");
    expect(err.message).toContain("no open E071 row");
    expect(err.message).toContain("abap_transport check");
    expect((err.details as { pendingRequests?: string[] }).pendingRequests).toEqual([]);
  });

  it("a mix of a still-live object and a pending one: CHECK_FAILED, names both the live and the pending object", async () => {
    const fake = classicFake({
      action: "delete_package",
      lines: () => [objRow("ZCL_KEPT"), deletedObjRow("ZCL_GONE", "A4HK900346")],
    });
    const { conn } = await connected(fake.route);
    const err = await catchErr(deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("It still contains: object R3TR CLAS ZCL_KEPT");
    expect(err.message).toContain("Also pending release: object R3TR CLAS ZCL_GONE");
    expect(err.message).toContain("awaiting release of request A4HK900346");
    expect(err.message).not.toContain("was NOT deleted: everything left in it is already deleted");
  });

  it("no delete request is sent in any of these three refusal cases", async () => {
    for (const lines of [
      [deletedObjRow("ZCL_ONE", "A4HK900346")],
      [deletedObjRow("ZCL_ORPHAN")],
      [objRow("ZCL_KEPT"), deletedObjRow("ZCL_GONE", "A4HK900346")],
    ]) {
      const fake = classicFake({ action: "delete_package", lines: () => lines });
      const { conn, adt } = await connected(fake.route);
      await catchErr(deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS));
      expect(adt.calls.some((c) => (c.method ?? "").toUpperCase() === "DELETE")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 8 — ZMCP-DDIC-ERR> propagation
// ---------------------------------------------------------------------------

describe("ZMCP-DDIC-ERR> lines propagate as errors carrying the ABAP-side message", () => {
  it("the package does not exist", async () => {
    const fake = classicFake({ action: "delete_package", lines: () => [`${DDIC_ERR_PREFIX} package ${PKG} does not exist`] });
    const { conn } = await connected(fake.route);
    const err = await catchErr(deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain(`package ${PKG} does not exist`);
  });

  it("the post-COMMIT TDEVC row survives", async () => {
    const fake = classicFake({
      action: "delete_package",
      lines: () => ["PKG-EMPTY", "PKG-DELETED", `${DDIC_ERR_PREFIX} delete of ${PKG} reported no error but the TDEVC row still exists`],
    });
    const { conn } = await connected(fake.route);
    const err = await catchErr(deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("TDEVC row still exists");
  });
});

// ---------------------------------------------------------------------------
// 9 — classic-exception regression: a locked package's classic exception must NOT dump
// ---------------------------------------------------------------------------

describe("a classic exception on set_changeable no longer short-dumps and destroys the transcript", () => {
  it("a synthetic transcript with PKG-EMPTY then a set_changeable ZMCP-DDIC-ERR> line parses as a clean failure that STILL carries the PKG-EMPTY evidence — the regression test for the dump that destroyed it live", () => {
    const raw = ["PKG-EMPTY", `${DDIC_ERR_PREFIX} ${SET_CHANGEABLE_STEP} failed, sy-subrc=1, `].join("\n");
    const transcript = parseDdicTranscript(raw);
    expect(transcript.tags).toContain("PKG-EMPTY");
    expect(transcript.errorLine).toContain(`${SET_CHANGEABLE_STEP} failed`);
    expect(transcript.raw).toContain("PKG-EMPTY");
  });

  it("deletePackageViaBridge's beforeAssert turns exactly that transcript into a CHECK_FAILED naming the lock as a LIKELY (not confirmed) cause, and echoes the raw ABAP-side detail", async () => {
    const raw = ["PKG-EMPTY", `${DDIC_ERR_PREFIX} ${SET_CHANGEABLE_STEP} failed, sy-subrc=1, `];
    const fake = classicFake({ action: "delete_package", lines: () => raw });
    const { conn } = await connected(fake.route);
    const err = await catchErr(deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toMatch(/likely|not confirmed/i);
    expect(err.message).toContain("SM12");
    expect(err.message).toContain(PKG);
    expect(err.message).toContain(`${SET_CHANGEABLE_STEP} failed`);
  });

  it("a classic exception on a DIFFERENT step (not set_changeable) still surfaces as a plain CHECK_FAILED, not the lock-specific message", async () => {
    const raw = ["PKG-EMPTY", `${DDIC_ERR_PREFIX} Deleting package failed, sy-subrc=1, `];
    const fake = classicFake({ action: "delete_package", lines: () => raw });
    const { conn } = await connected(fake.route);
    const err = await catchErr(deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).not.toContain("SM12");
    expect(err.message).toContain("Deleting package failed");
  });
});
