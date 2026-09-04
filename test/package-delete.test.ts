/**
 * `DEVC/K` (package) delete bridge — offline; mirrors
 * `test/package-create.test.ts`'s fixture/gate/route style.
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
import { SafetyGate } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import {
  DDIC_BRIDGE_CLASS,
  DDIC_BRIDGE_PACKAGE,
  DDIC_ERR_PREFIX,
  parseDdicTranscript,
  subrcCheckFragment,
  subrcGuardFragment,
} from "../src/adt/ddic-bridge.js";
import {
  PACKAGE_DELETE_DATA_LINES,
  PKG_CONTENT_PREFIX,
  SET_CHANGEABLE_STEP,
  deletePackageViaBridge,
  packageDeleteFragment,
  parsePackageContents,
  type PackageDeleteParams,
} from "../src/adt/package-delete.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Fake transport — same shape as test/package-create.test.ts
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
const BRIDGE = DDIC_BRIDGE_CLASS.deletePackage;

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

/** GET-404 -> POST-create -> LOCK -> PUT -> UNLOCK for the bridge class itself. */
function objectHappyPath(collectionUrl: string, name: string): (o: HttpClientOptions) => HttpClientResponse | undefined {
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

/** A bare classrun body — see test/package-create.test.ts's identical helper. */
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

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

const PKG = "ZTM_TESTPKG";

/** Allows both the bridge class ($TMP) and the package's own name (its container for a delete). */
const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [DDIC_BRIDGE_PACKAGE, PKG],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

/** Allows the bridge class only — the domain gate must refuse the package delete before anything reaches the wire. */
const bridgeOnlyGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [DDIC_BRIDGE_PACKAGE],
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

// ---------------------------------------------------------------------------
// 1 - parsePackageContents, pure/offline
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
      truncated: false,
    });
  });

  it("ignores unrelated transcript lines", () => {
    const raw = ["PKG-EMPTY", objRow("ZCL_FOO"), "PKG-DELETED", "PKG-GONE"].join("\n");
    expect(parsePackageContents(raw).contents).toEqual([
      { kind: "OBJECT", pgmid: "R3TR", object: "CLAS", name: "ZCL_FOO" },
    ]);
  });

  it("a ZMCP-PKG-CONTENT-TRUNCATED> marker sets truncated:true and is not itself parsed as a content row", () => {
    const raw = [objRow("ZCL_FOO"), "ZMCP-PKG-CONTENT-TRUNCATED> SOURCE=TADIR"].join("\n");
    const { contents, truncated } = parsePackageContents(raw);
    expect(truncated).toBe(true);
    expect(contents).toEqual([{ kind: "OBJECT", pgmid: "R3TR", object: "CLAS", name: "ZCL_FOO" }]);
  });

  it("empty input gives { contents: [], truncated: false }", () => {
    expect(parsePackageContents("")).toEqual({ contents: [], truncated: false });
  });
});

// ---------------------------------------------------------------------------
// 2 - packageDeleteFragment: pin the generated ABAP
// ---------------------------------------------------------------------------

describe("packageDeleteFragment generates the expected ABAP (closed template — regression guard)", () => {
  it("transportable: CALL METHOD lo_package->save carries i_transport_request = 'A4HK900123'", () => {
    const src = packageDeleteFragment(TRANSPORT_PARAMS).join("\n");
    expect(src).toContain("CALL METHOD lo_package->save");
    expect(src).toContain("i_transport_request = 'A4HK900123'");
  });

  it("LOCAL (corrNr ''): CALL METHOD lo_package->save with NO i_transport_request= anywhere", () => {
    const src = packageDeleteFragment(LOCAL_PARAMS).join("\n");
    expect(src).toContain("CALL METHOD lo_package->save");
    expect(src).not.toContain("i_transport_request =");
  });

  it("calls load_package, set_changeable( abap_true ), delete, and COMMIT WORK — every one of them via CALL METHOD ... EXCEPTIONS", () => {
    const src = packageDeleteFragment(TRANSPORT_PARAMS).join("\n");
    expect(src).toContain("CALL METHOD cl_package_factory=>load_package");
    expect(src).toContain("CALL METHOD lo_package->set_changeable");
    expect(src).toContain("i_changeable = abap_true");
    expect(src).toContain("CALL METHOD lo_package->delete");
    // A golden-string test that pinned "lo_package->if_package~delete( )."
    // reported green while the generated class failed to activate — pin the
    // invariant (no IF_PACKAGE~ prefix on an if_package reference), not only
    // the literal. Same regression guard as test/package-create.test.ts:376.
    expect(src).not.toContain("if_package~");
    expect(src).toContain("COMMIT WORK.");
  });

  it("every CALL METHOD emitted carries an EXCEPTIONS clause — the classic-exception short-dump regression guard", () => {
    for (const params of [TRANSPORT_PARAMS, LOCAL_PARAMS]) {
      const lines = packageDeleteFragment(params);
      // Every CALL METHOD statement (terminated by a lone-period line) must
      // contain an EXCEPTIONS clause before that terminator.
      const callIdxs = lines.reduce<number[]>((acc, l, i) => {
        if (l.trim().startsWith("CALL METHOD")) acc.push(i);
        return acc;
      }, []);
      expect(callIdxs.length).toBeGreaterThan(0);
      for (const start of callIdxs) {
        const end = lines.findIndex((l, i) => i >= start && l.trim().endsWith("."));
        const stmt = lines.slice(start, end + 1).join("\n");
        expect(stmt).toContain("EXCEPTIONS");
        expect(stmt).toContain("OTHERS");
      }
      // No functional-call syntax survives for the six methods this bridge
      // touches — a regression here is exactly how the classic-exception short-dump happened.
      // Comments legitimately mention the OLD functional-call shape to
      // explain why it's gone (e.g. "the old `lo_package->delete( ).`"), so
      // this checks CODE ONLY, same filter as the other well-formedness
      // tests in this file.
      const codeOnly = lines
        .filter((l) => !l.trim().startsWith('"'))
        .join("\n");
      for (const call of [
        "lo_package->set_changeable(",
        "lo_package->delete(",
        "lo_package->save(",
        "cl_package_factory=>load_package(",
      ]) {
        expect(codeOnly).not.toContain(call);
      }
    }
  });

  it("emits PKG-EMPTY, PKG-DELETED and PKG-GONE", () => {
    const lines = packageDeleteFragment(TRANSPORT_PARAMS);
    for (const tag of ["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"]) {
      expect(lines.some((l) => l.includes(`'${tag}'`))).toBe(true);
    }
  });

  it("re-reads TDEVC AFTER COMMIT WORK, and raises ZMCP-DDIC-ERR> if the row survives — the only proof delete happened", () => {
    const lines = packageDeleteFragment(TRANSPORT_PARAMS);
    const commitIdx = lines.findIndex((l) => l.trim() === "COMMIT WORK.");
    const reselectIdx = lines.findIndex(
      (l, i) => i > commitIdx && l.includes("SELECT SINGLE * FROM tdevc"),
    );
    const errIdx = lines.findIndex((l) => l.includes(DDIC_ERR_PREFIX) && l.includes("still exists"));
    const goneIdx = lines.findIndex((l) => l.includes("'PKG-GONE'"));
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(reselectIdx).toBeGreaterThan(commitIdx);
    expect(errIdx).toBeGreaterThan(reselectIdx);
    expect(goneIdx).toBeGreaterThan(errIdx);
  });

  it('every comment uses " — never a *-style comment (only legal in column 1; the generator indents)', () => {
    for (const params of [TRANSPORT_PARAMS, LOCAL_PARAMS]) {
      const lines = packageDeleteFragment(params);
      const starComments = lines.filter((l) => l.trim().startsWith("*"));
      expect(starComments).toEqual([]);
      // Not vacuous — there genuinely are comment lines to check.
      expect(lines.some((l) => l.trim().startsWith('"'))).toBe(true);
    }
  });

  it("interpolates the package name and TRKORR where expected, and nowhere else when unset", () => {
    const a = packageDeleteFragment({ packageName: "ZTM_ALPHA", corrNr: "A4HK900111" }).join("\n");
    const b = packageDeleteFragment({ packageName: "ZTM_BETA", corrNr: "A4HK900222" }).join("\n");
    expect(a).toContain("'ZTM_ALPHA'");
    expect(a).toContain("A4HK900111");
    expect(a).not.toContain("ZTM_BETA");
    expect(a).not.toContain("A4HK900222");
    expect(b).toContain("'ZTM_BETA'");
    expect(b).toContain("A4HK900222");
    const local = packageDeleteFragment(LOCAL_PARAMS).join("\n");
    expect(local).toContain(`'${PKG}'`);
  });

  it("accepts a $-prefixed local package name, quoted correctly in the generated ABAP", () => {
    const src = packageDeleteFragment({ packageName: "$ZTMD_PKG_01", corrNr: "" }).join("\n");
    expect(src).toContain("SELECT SINGLE * FROM tdevc INTO @ls_tdevc WHERE devclass = '$ZTMD_PKG_01'.");
  });
});

// ---------------------------------------------------------------------------
// 3 - input validation, refused before any network call
// ---------------------------------------------------------------------------

describe("input validation is refused before any network call", () => {
  const offline = null as unknown as AbapConnection;

  it("a bad package name is refused, zero HTTP calls implied (offline conn)", async () => {
    const err = await catchErr(
      deletePackageViaBridge(offline, allowingGate(), { packageName: "1BAD", corrNr: "" }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("a package name longer than 30 characters is refused", async () => {
    const tooLong = `Z${"A".repeat(30)}`; // 31 characters
    const err = await catchErr(
      deletePackageViaBridge(offline, allowingGate(), { packageName: tooLong, corrNr: "" }),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("30");
  });

  it("refuses a package name containing a quote, period, or embedded newline — the ABAP-injection guard", async () => {
    for (const bad of ["ZTM'FOO", "ZTM.FOO", "ZTM\nFOO"]) {
      const err = await catchErr(
        deletePackageViaBridge(offline, allowingGate(), { packageName: bad, corrNr: "" }),
      );
      expect(err.code).toBe("BAD_INPUT");
    }
  });

  it("still refuses a bare $ or $$-prefixed name — allowLocal strips only ONE leading $", async () => {
    for (const bad of ["$", "$$", "$$X"]) {
      const err = await catchErr(
        deletePackageViaBridge(offline, allowingGate(), { packageName: bad, corrNr: "" }),
      );
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

  it('corrNr: "" is legal (local delete, no transport) — it is not the thing rejected above', async () => {
    expect(() => packageDeleteFragment({ packageName: PKG, corrNr: "" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4 - safety gate: asserted as "delete" on the DOMAIN object, zero-network
// ---------------------------------------------------------------------------

describe("safety gate — asserted as a delete on the domain object, and runs FIRST (zero-network)", () => {
  it("gate.assert sees op 'delete' with type DEVC/K and the package's own name", async () => {
    const seen: Array<{ op: string; type?: string; name?: string }> = [];
    class RecordingGate extends SafetyGate {
      override assert(
        op: Parameters<SafetyGate["assert"]>[0],
        obj?: Parameters<SafetyGate["assert"]>[1],
        opts?: Parameters<SafetyGate["assert"]>[2],
      ): void {
        if (obj?.type === "DEVC/K") seen.push({ op, type: obj.type, name: obj.name });
        super.assert(op, obj, opts);
      }
    }
    const gate = new RecordingGate({
      readOnly: false,
      allowPackages: [DDIC_BRIDGE_PACKAGE, PKG],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"])),
    );
    const { conn } = await connected(route);
    await deletePackageViaBridge(conn, gate, TRANSPORT_PARAMS);
    expect(seen).toEqual([{ op: "delete", type: "DEVC/K", name: PKG }]);
  });

  it("a gate that refuses the package name refuses the whole call with ZERO HTTP requests — the refusal is the gate's own", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"])),
    );
    const { conn, inner } = await connected(route);
    const err = await catchErr(deletePackageViaBridge(conn, bridgeOnlyGate(), TRANSPORT_PARAMS));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(inner.calls.length).toBe(0);
  });

  it("a readOnly gate refuses too, zero requests made", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"])),
    );
    const { conn, inner } = await connected(route);
    const readOnly = new SafetyGate({
      readOnly: true,
      allowPackages: [DDIC_BRIDGE_PACKAGE, PKG],
      writesLockedOut: false,
    });
    const err = await catchErr(deletePackageViaBridge(conn, readOnly, TRANSPORT_PARAMS));
    expect(err).toBeTruthy();
    expect(inner.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5 - happy path, transportable and LOCAL
// ---------------------------------------------------------------------------

describe("deletePackageViaBridge happy path", () => {
  it("transportable: PKG-EMPTY, PKG-DELETED, PKG-GONE resolves, contents is empty", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"])),
    );
    const { conn, inner } = await connected(route);
    const { transcript, contents, truncated } = await deletePackageViaBridge(
      conn,
      allowingGate(),
      TRANSPORT_PARAMS,
    );
    expect(transcript.tags).toEqual(["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"]);
    expect(transcript.errorLine).toBeUndefined();
    expect(contents).toEqual([]);
    expect(truncated).toBe(false);
    expect(inner.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
  });

  it("LOCAL (corrNr: ''): also resolves, and the source PUT over the wire carries a bare save( ) with no transport", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"])),
    );
    const { conn, inner } = await connected(route);
    const { contents } = await deletePackageViaBridge(conn, allowingGate(), LOCAL_PARAMS);
    expect(contents).toEqual([]);

    const sourceUri = `${CLASS_COLLECTION}/${BRIDGE.toLowerCase()}/source/main`;
    const put = inner.calls.find((c) => (c.method ?? "").toUpperCase() === "PUT" && c.url === sourceUri);
    const body = String(put?.body);
    expect(body).toContain("CALL METHOD lo_package->save");
    expect(body).not.toContain("i_transport_request =");
  });

  it("PACKAGE_DELETE_DATA_LINES declares the locals the fragment relies on", () => {
    expect(PACKAGE_DELETE_DATA_LINES).toContain("ls_tdevc            TYPE tdevc.");
    expect(PACKAGE_DELETE_DATA_LINES).toContain("lo_package          TYPE REF TO if_package.");
  });
});

// ---------------------------------------------------------------------------
// 6 - non-empty refusal: the most important behavioural test
// ---------------------------------------------------------------------------

describe("a non-empty package is refused, naming what it still contains — not a generic missing-tag error", () => {
  it("a transcript reporting contents (never reaching PKG-EMPTY) throws CHECK_FAILED naming the objects found", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput([objRow("ZCL_KEPT"), subpkgRow("ZTM_CHILD")])),
    );
    const { conn } = await connected(route);
    const err = await catchErr(deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("ZCL_KEPT");
    expect(err.message).toContain("ZTM_CHILD");
  });

  it("the truncation case still refuses (not a false 'looks small enough' pass)", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(
        classrunOutput([objRow("ZCL_KEPT"), "ZMCP-PKG-CONTENT-TRUNCATED> SOURCE=TADIR"]),
      ),
    );
    const { conn } = await connected(route);
    const err = await catchErr(deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("ZCL_KEPT");
  });
});

// ---------------------------------------------------------------------------
// 7 - ZMCP-DDIC-ERR> propagation
// ---------------------------------------------------------------------------

describe("ZMCP-DDIC-ERR> lines propagate as errors carrying the ABAP-side message", () => {
  it("the package does not exist", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput([`${DDIC_ERR_PREFIX} package ${PKG} does not exist`])),
    );
    const { conn } = await connected(route);
    const err = await catchErr(deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain(`package ${PKG} does not exist`);
  });

  it("the post-COMMIT TDEVC row survives", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(
        classrunOutput([
          "PKG-EMPTY",
          "PKG-DELETED",
          `${DDIC_ERR_PREFIX} delete of ${PKG} reported no error but the TDEVC row still exists`,
        ]),
      ),
    );
    const { conn } = await connected(route);
    const err = await catchErr(deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("TDEVC row still exists");
  });
});

// ---------------------------------------------------------------------------
// 8 - classic-exception regression: a locked package's classic exception must NOT dump
// ---------------------------------------------------------------------------

describe("a classic exception on set_changeable no longer short-dumps and destroys the transcript", () => {
  it("subrcGuardFragment emits an IF sy-subrc <> 0 guard with NO trailing SUCCESS-tag write (it does write the error line itself)", () => {
    const lines = subrcGuardFragment("Making package changeable");
    expect(lines[0]).toBe("IF sy-subrc <> 0.");
    expect(lines.some((l) => l.includes("Making package changeable failed"))).toBe(true);
    expect(lines.some((l) => l.includes("sy-subrc"))).toBe(true);
    expect(lines[lines.length - 1]).toBe("ENDIF.");
    // The block DOES write the interpolated ZMCP-DDIC-ERR> failure line
    // (that's the whole point) — what it must NOT do is write a bare
    // single-quoted success tag the way subrcCheckFragment's extra line does.
    expect(lines.some((l) => /out->write\(\s*'/.test(l))).toBe(false);
  });

  it("subrcGuardFragment rejects a step name that is not plain text", () => {
    expect(() => subrcGuardFragment("bad; DROP TABLE")).toThrow();
    expect(() => subrcGuardFragment("also bad\nwith a newline")).toThrow();
    try {
      subrcGuardFragment("also bad\nwith a newline");
      throw new Error("expected a throw");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("CHECK_FAILED");
    }
  });

  it("subrcCheckFragment's existing output is unchanged by the refactor: same guard plus one trailing tag write", () => {
    const guard = subrcGuardFragment("Loading package");
    const checked = subrcCheckFragment("Loading package", "PKG-EMPTY");
    expect(checked.slice(0, guard.length)).toEqual(guard);
    expect(checked[checked.length - 1]).toBe("out->write( 'PKG-EMPTY' ).");
    expect(checked.length).toBe(guard.length + 1);
  });

  it("subrcCheckFragment still rejects an undeclared tag", () => {
    const notATag = "NOT-A-TAG" as unknown as Parameters<typeof subrcCheckFragment>[1];
    expect(() => subrcCheckFragment("Loading package", notATag)).toThrow();
  });

  it("a synthetic transcript with PKG-EMPTY then a set_changeable ZMCP-DDIC-ERR> line parses as a clean CHECK_FAILED that STILL carries the PKG-EMPTY evidence — the regression test for the dump that destroyed it live", () => {
    // This is exactly the shape this fix addresses: step 3 already wrote PKG-EMPTY
    // (the package was confirmed empty) before step 4's set_changeable hit a
    // classic exception. Before this fix that exception short-dumped and
    // the caller never saw ANY of this — not even the emptiness evidence.
    const raw = [
      "PKG-EMPTY",
      `${DDIC_ERR_PREFIX} ${SET_CHANGEABLE_STEP} failed, sy-subrc=1, `,
    ].join("\n");
    const transcript = parseDdicTranscript(raw);
    // The evidence survives being turned into an error: it's still sitting
    // right there in tags/raw, never wiped out by the failure.
    expect(transcript.tags).toContain("PKG-EMPTY");
    expect(transcript.errorLine).toContain(`${SET_CHANGEABLE_STEP} failed`);
    expect(transcript.raw).toContain("PKG-EMPTY");
  });

  it("deletePackageViaBridge's beforeAssert turns exactly that transcript into a CHECK_FAILED naming the lock as a LIKELY (not confirmed) cause, and echoes the raw ABAP-side detail", async () => {
    const raw = [
      "PKG-EMPTY",
      `${DDIC_ERR_PREFIX} ${SET_CHANGEABLE_STEP} failed, sy-subrc=1, `,
    ].join("\n");
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(raw.split("\n"))));
    const { conn } = await connected(route);
    const err = await catchErr(deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    // Never asserted as fact — only ever as a likely / possible cause.
    expect(err.message).toMatch(/likely|not confirmed/i);
    expect(err.message).toContain("SM12");
    expect(err.message).toContain(PKG);
    // The raw ABAP-side detail (including the PKG-EMPTY-adjacent failure) is
    // still surfaced, not swallowed by the friendlier wording layered on top.
    expect(err.message).toContain(`${SET_CHANGEABLE_STEP} failed`);
  });

  it("a classic exception on a DIFFERENT step (not set_changeable) still surfaces as a plain CHECK_FAILED, not the lock-specific message", async () => {
    const raw = ["PKG-EMPTY", `${DDIC_ERR_PREFIX} Deleting package failed, sy-subrc=1, `].join("\n");
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput(raw.split("\n"))));
    const { conn } = await connected(route);
    const err = await catchErr(deletePackageViaBridge(conn, allowingGate(), TRANSPORT_PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).not.toContain("SM12");
    expect(err.message).toContain("Deleting package failed");
  });
});
