/**
 * The truncated-read → full-source-write data loss.
 *
 * The defect, restated so the tests below are readable without the issue open:
 * `abap_read` caps its response against a context budget and hands back only
 * part of a long object's source. An agent edits the text it was given and
 * calls `abap_write` with `{object, source}`. That is a FULL-SOURCE REWRITE, so
 * every line past the point the read was cut at is silently deleted.
 *
 * Nothing in the suite covered that round trip before this file: the read tests
 * stop at the read and the write tests start with a source the test itself
 * spelled out. The headline test here is the one that joins them — a genuinely
 * truncated `abapRead` whose returned text is fed straight back into
 * `writeObject`, which must refuse.
 *
 * Everything is offline. The read goes through the REAL compactor at the real
 * budget arithmetic (no stubbed `truncated` flag — the source really is too
 * long for the `maxChars` passed in), and the write goes through the REAL
 * `writeObject` against a fake `HttpClient`. The only thing mocked is
 * `resolveObject`, the name→object lookup, which is not what any of this is
 * about; the write path does not use it (it resolves through `identifyByName`,
 * left real).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import {
  canonicalSource,
  contentHash,
  isPartialEtag,
  markEtagPartial,
  PARTIAL_ETAG_PREFIX,
  stripPartialEtag,
} from "../src/compact.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { authorizeMutation, writeObject, type WriteTarget } from "../src/adt/write.js";
import { abapWrite, assertNotToolResponseEcho, resolveWriteSource } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// --- the one mock: name → object -------------------------------------------
// `abapRead` starts with `resolveObject`, which is a search/lookup round trip
// that has nothing to do with truncation. `importActual` keeps `identifyByName`
// and `parseObjectRef` real, which matters: `resolveWriteTarget` uses those,
// so the WRITE half of every test below is the unmodified production path.
const stub = { object: {} as ResolvedObject };

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => stub.object,
}));

const { abapRead } = await import("../src/tools/read.js");

// ---------------------------------------------------------------------------
// The fake system.
// ---------------------------------------------------------------------------

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

const LOCK_XML =
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const OBJECT_XML = (name: string, type: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${name}" adtcore:type="${type}">` +
  `<adtcore:packageRef adtcore:name="$TMP"/>` +
  `</adtcore:objectMetadata>`;

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
  get labels(): string[] {
    return this.calls.map((c) => c.label);
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
  if (r.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
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

const GATE = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
const authWrite = (conn: AbapConnection, target: WriteTarget) =>
  authorizeMutation(conn, GATE, "write", target);

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

// ---------------------------------------------------------------------------
// The objects under test.
// ---------------------------------------------------------------------------

const PROG = "ZMCP_BIG_REP";
const PROG_URI = "/sap/bc/adt/programs/programs/zmcp_big_rep";
const PROG_SRC = `${PROG_URI}/source/main`;

/**
 * A program long enough that a 15k-token read genuinely cannot carry it.
 *
 * 3,000 body lines is not an arbitrary round number — it is the shape of the
 * object in the issue: a real 3,004-line, 124,975-character source that came
 * back from `abap_read` as 47,042 characters. Every line is individually
 * identifiable so a test can prove exactly WHERE the delivery stopped, and —
 * the point of the whole exercise — that the tail really is missing rather
 * than merely reordered.
 *
 * Note it is syntactically valid ABAP when cut at ANY line: that is what makes
 * the defect silent. `keepLines` cuts whole lines, so a truncated REPORT still
 * parses, still activates, and still runs — with 2,000 statements gone.
 */
const BIG_LINES = [
  `REPORT ${PROG.toLowerCase()}.`,
  ...Array.from({ length: 3000 }, (_, i) => `WRITE: / 'line ${String(i + 1).padStart(4, "0")}'.`),
];
const BIG_SOURCE = `${BIG_LINES.join("\n")}\n`;
/** The server hands source back CRLF-normalised. */
const BIG_SOURCE_CRLF = BIG_SOURCE.replace(/\n/g, "\r\n");

const LAST_LINE = BIG_LINES[BIG_LINES.length - 1]!;

function resolvedProg(): ResolvedObject {
  return {
    system: "A4H",
    type: "PROG/P",
    kind: "PROG",
    label: "program",
    name: PROG,
    uri: PROG_URI,
    mode: "source",
    activation: "active",
    packageName: "$TMP",
    spec: {},
  } as unknown as ResolvedObject;
}

/** An existing object whose source is `current`; lock/PUT/unlock all succeed. */
const existing =
  (uri: string, name: string, type: string, current: string): Route =>
  (r) => {
    const src = `${uri}/source/main`;
    if (r.url === src && r.method === "GET") return resp(200, current, OK_TEXT);
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === src && r.method === "PUT") return resp(200, "", OK_TEXT);
    if (r.url === uri && r.method === "GET" && !r.qs._action)
      return resp(200, OBJECT_XML(name, type), OK_XML);
    return undefined;
  };

/** The text an agent would extract from a read response: what is inside the fence. */
function sourceFence(text: string): string {
  const after = text.split("--- SOURCE ---\n")[1];
  expect(after, "response has no SOURCE fence").toBeTypeOf("string");
  return after!.split("\n\n---")[0]!;
}

// ---------------------------------------------------------------------------

describe("a truncated read cannot become a full-source rewrite", () => {
  beforeEach(() => {
    stub.object = resolvedProg();
  });

  /**
   * THE headline test. Everything else in this file supports it.
   *
   * Note what it does NOT do: it never sets a `truncated` flag by hand, never
   * constructs a `partial:` etag by hand and never trims the source itself.
   * The read is asked for a real object at a real budget and comes back short
   * on its own; the string handed to the write is literally the bytes the read
   * returned. If the compactor ever stopped truncating this input the test
   * would fail at the first assertion rather than passing vacuously.
   */
  it("refuses a write whose source is the text a truncated read returned", async () => {
    const { conn, adt } = await connected(existing(PROG_URI, PROG, "PROG/P", BIG_SOURCE_CRLF));

    // --- the read, at the real default budget (15k tokens ≈ 47,100 chars) ---
    const read = await abapRead(conn, { object: PROG }, 47_100);

    expect(read.truncated, "3,001 lines must not fit in a 47,100-char response").toBe(true);
    expect(read.returnedLines).toBeLessThan(read.totalLines!);
    // 3,001 written lines plus the empty one the trailing newline leaves.
    expect(read.totalLines).toBe(3002);

    // The etag is marked, and the marking is visible in the rendered text —
    // an agent that only ever reads the transcript still gets told.
    expect(isPartialEtag(read.etag)).toBe(true);
    expect(read.etag.startsWith(PARTIAL_ETAG_PREFIX)).toBe(true);
    expect(read.text).toContain("INCOMPLETE");
    expect(read.text).toContain("partial:");

    // The hash INSIDE the marker is still the hash of the WHOLE object. The
    // marker records an extra fact about the delivery; it does not change what
    // was hashed, so concurrency detection is untouched.
    expect(stripPartialEtag(read.etag)).toBe(contentHash(canonicalSource(BIG_SOURCE_CRLF)));

    // The delivered body really is missing the tail. This is the data loss.
    const delivered = sourceFence(read.text);
    expect(delivered).toContain("WRITE: / 'line 0001'.");
    expect(delivered).not.toContain(LAST_LINE);

    // --- the write: exactly what an agent would send back -------------------
    adt.calls.length = 0;
    const edited = delivered.replace("WRITE: / 'line 0001'.", "WRITE: / 'CHANGED'.");
    const err = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "PROG/P", name: PROG }), {
        source: edited,
        expectEtag: read.etag,
      }),
    );

    expect(err.code).toBe("PARTIAL_READ_SOURCE");
    expect(err.message).toMatch(/TRUNCATED read/i);
    expect(err.hint).toMatch(/edit/i);
    expect((err.details as Record<string, unknown>).expectedEtag).toBe(read.etag);

    // Refused before anything was locked or written: no lock, no PUT, no
    // unlock — the object is untouched, not restored.
    expect(adt.labels.some((l) => l.startsWith("LOCK"))).toBe(false);
    expect(adt.labels.some((l) => l.startsWith("PUT"))).toBe(false);
  });

  /**
   * The reason a plain shrink threshold cannot be the guard, stated as a test.
   *
   * The hash in a `partial:` etag matches the server byte for byte — it always
   * did, because it is a hash of the full source. `assertEtagMatches` therefore
   * says "no conflict" and waves the write through. Concurrency and
   * completeness are different questions and only one of them was ever being
   * asked.
   */
  it("the truncated write's etag MATCHES the server — the concurrency check cannot catch it", async () => {
    const { conn } = await connected(existing(PROG_URI, PROG, "PROG/P", BIG_SOURCE_CRLF));
    const read = await abapRead(conn, { object: PROG }, 47_100);

    // Same hash, no conflict. Had the guard not been added, this write would
    // have succeeded and deleted ~2,900 lines.
    expect(stripPartialEtag(read.etag)).toBe(contentHash(canonicalSource(BIG_SOURCE_CRLF)));

    const err = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "PROG/P", name: PROG }), {
        source: sourceFence(read.text),
        expectEtag: read.etag,
      }),
    );
    // Not ETAG_CONFLICT: nothing conflicted. A distinct code, because the
    // remedy is different — re-reading does not help unless the re-read is
    // complete.
    expect(err.code).toBe("PARTIAL_READ_SOURCE");
    expect(err.code).not.toBe("ETAG_CONFLICT");
  });

  it("an UNtruncated read of the same object hands back a plain etag and writes fine", async () => {
    const { conn } = await connected(existing(PROG_URI, PROG, "PROG/P", BIG_SOURCE_CRLF));
    // A budget that fits the whole thing: ~124k chars of source.
    const read = await abapRead(conn, { object: PROG }, 400_000);

    expect(read.truncated).toBe(false);
    expect(isPartialEtag(read.etag)).toBe(false);
    expect(sourceFence(read.text)).toContain(LAST_LINE);

    const res = await writeObject(conn, await authWrite(conn, { type: "PROG/P", name: PROG }), {
      source: `${sourceFence(read.text)}\nWRITE: / 'extra'.\n`,
      expectEtag: read.etag,
    });
    expect(res.changed).toBe(true);
  });

  it("says what to do instead, and does not suggest dropping expect_etag", async () => {
    const { conn } = await connected(existing(PROG_URI, PROG, "PROG/P", BIG_SOURCE_CRLF));
    const read = await abapRead(conn, { object: PROG }, 47_100);
    const err = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "PROG/P", name: PROG }), {
        source: sourceFence(read.text),
        expectEtag: read.etag,
      }),
    );
    // The two real remedies, both named.
    expect(err.hint).toMatch(/old_string/);
    expect(err.hint).toMatch(/offset\/limit|offset/);
    // And the one non-remedy, named as such — an agent that simply removes the
    // etag has removed the check, not the problem.
    expect(err.hint).toMatch(/Do NOT simply drop expect_etag/i);
  });
});

// ---------------------------------------------------------------------------
// The recently-admitted types, which the guard has to cover too.
// ---------------------------------------------------------------------------

describe("the guard covers every source-shape type, not just PROG", () => {
  /**
   * DDLX/EX, SRVD/SRV and BDEF/BDO became writable, all three with
   * `write: { shape: "source" }` — i.e. all three reachable by exactly the
   * destructive full-source rewrite this guard exists to stop. They are covered
   * without a line of per-type code because the refusal lives in `writeObject`,
   * above the type switch, rather than in any one type's write path.
   *
   * `SRVB/SVB`, added separately, is NOT in this list — it is properties shape,
   * so it is covered by the properties-shape block further down instead.
   */
  const CASES: { type: string; name: string; uri: string; head: string }[] = [
    {
      type: "DDLX/EX",
      name: "ZMCP_BIG_DDLX",
      uri: "/sap/bc/adt/ddic/ddlx/sources/zmcp_big_ddlx",
      head: "@Metadata.layer: #CORE",
    },
    {
      type: "SRVD/SRV",
      name: "ZMCP_BIG_SRVD",
      uri: "/sap/bc/adt/ddic/srvd/sources/zmcp_big_srvd",
      head: "@EndUserText.label: 'x'",
    },
    {
      type: "BDEF/BDO",
      name: "ZMCP_BIG_BDEF",
      uri: "/sap/bc/adt/bo/behaviordefinitions/zmcp_big_bdef",
      head: "implementation unmanaged;",
    },
  ];

  for (const c of CASES) {
    it(`refuses a truncated-read rewrite of ${c.type}`, async () => {
      // Deliberately >47,100 characters: the guard is only under test if the
      // read is REALLY truncated, and a comment line short enough to fit 3,000
      // of them inside the budget would make every assertion below vacuous.
      const lines = [
        c.head,
        ...Array.from(
          { length: 3000 },
          (_, i) => `// filler line ${String(i + 1).padStart(4, "0")} — padding to exceed the budget`,
        ),
      ];
      const source = `${lines.join("\n")}\n`;
      stub.object = {
        ...resolvedProg(),
        type: c.type,
        kind: c.type.split("/")[0],
        name: c.name,
        uri: c.uri,
      } as unknown as ResolvedObject;

      const { conn, adt } = await connected(
        existing(c.uri, c.name, c.type, source.replace(/\n/g, "\r\n")),
      );
      const read = await abapRead(conn, { object: c.name, type: c.type }, 47_100);
      expect(read.truncated).toBe(true);
      expect(isPartialEtag(read.etag)).toBe(true);

      adt.calls.length = 0;
      const err = await catchErr(
        writeObject(conn, await authWrite(conn, { type: c.type, name: c.name }), {
          source: sourceFence(read.text),
          expectEtag: read.etag,
        }),
      );
      expect(err.code).toBe("PARTIAL_READ_SOURCE");
      expect(err.details.type).toBe(c.type);
      expect(adt.labels.some((l) => l.startsWith("PUT"))).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Properties shape: the same defect with an XML body instead of ABAP source.
// ---------------------------------------------------------------------------

/**
 * Six of the seventeen writable types are `write: { shape: "properties" }`:
 * the object IS an XML descriptor, PUT to its own URI, and `format: "raw"` is
 * how a caller gets that document to edit. `SRVB/SVB` is the newest.
 *
 * The same round trip is available there and is just as destructive — a
 * windowed descriptor written back is a truncated document — with one extra
 * twist: the raw path windows by CHARACTERS before `buildResponse` sees the
 * body (an ADT descriptor is one enormous single line, so line-based
 * truncation would keep none of it), which means `buildResponse` correctly
 * believes it cut nothing. `buildSourceResponse`'s `forceIncomplete` argument
 * exists for exactly that, and this is the test that holds it.
 *
 * Note the guard is NOT per-shape: it sits in `writeObject` step 2, above the
 * shape switch, so all seventeen writable types are covered by one check.
 */
describe("a windowed raw descriptor cannot be PUT back either", () => {
  const SVB = "ZMCP_BIG_SVB";
  const SVB_URI = "/sap/bc/adt/businessservices/bindings/zmcp_big_svb";

  /**
   * SYNTHETIC — hand-written, not captured from any live system. Follows the
   * documented "SRVB inner body" template (see `srvbXml` in
   * test/write.test.ts and the `SRVB/SVB` REGISTRY entry), padded with a long
   * run of `<srvb:service>` elements so the document exceeds the raw path's
   * character window. Only its SIZE and its identity attributes matter here.
   */
  const bigDescriptor = (): string =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${SVB}" ` +
    `adtcore:type="SRVB/SVB"><adtcore:packageRef adtcore:name="$TMP"/>` +
    Array.from(
      { length: 900 },
      (_, i) =>
        `<srvb:services srvb:name="${SVB}_${String(i).padStart(4, "0")}">` +
        `<srvb:content srvb:version="0001">` +
        `<srvb:serviceDefinition adtcore:name="ZMCP_BIG_SRVD_${String(i).padStart(4, "0")}"/>` +
        `</srvb:content></srvb:services>`,
    ).join("") +
    `<srvb:binding srvb:category="0" srvb:type="ODATA" srvb:version="V2">` +
    `<srvb:implementation adtcore:name=""/></srvb:binding></srvb:serviceBinding>`;

  const route =
    (doc: string): Route =>
    (r) => {
      if (r.url === SVB_URI && r.method === "GET" && !r.qs._action) return resp(200, doc, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === SVB_URI && r.method === "PUT") return resp(200, "", OK_XML);
      return undefined;
    };

  beforeEach(() => {
    stub.object = {
      ...resolvedProg(),
      type: "SRVB/SVB",
      kind: "SRVB",
      label: "Service binding",
      name: SVB,
      uri: SVB_URI,
      mode: "properties",
    } as unknown as ResolvedObject;
  });

  it("marks a windowed descriptor partial even though buildResponse cut nothing", async () => {
    const doc = bigDescriptor();
    const { conn } = await connected(route(doc));
    const read = await abapRead(conn, { object: SVB, type: "SRVB/SVB", format: "raw" }, 47_100);

    // The document is one line, so line-based truncation genuinely did not
    // fire — the marker here comes from `forceIncomplete`, not from
    // `buildResponse.truncated`.
    expect(doc).not.toContain("\n");
    expect(doc.length).toBeGreaterThan(47_100);
    expect(read.truncated).toBe(true);
    expect(isPartialEtag(read.etag)).toBe(true);
    expect(read.text).toContain("INCOMPLETE");
  });

  it("refuses the PUT of a windowed descriptor, after the identity check has already passed", async () => {
    const doc = bigDescriptor();
    const { conn, adt } = await connected(route(doc));
    const read = await abapRead(conn, { object: SVB, type: "SRVB/SVB", format: "raw" }, 47_100);

    const window = read.text.split("--- XML DESCRIPTOR ---\n")[1]!.split("\n\n---")[0]!;
    // The dangerous property of this case: truncation removes the TAIL, and a
    // descriptor's `adtcore:name`/`adtcore:type` live in the ROOT ELEMENT at
    // the front. So `assertPayloadMatchesTarget` (writeObject step 0) still
    // sees a document that names the right object and waves it through — the
    // payload is not malformed in any way step 0 can detect, only incomplete.
    expect(window).toContain(`adtcore:name="${SVB}"`);
    expect(window).toContain('adtcore:type="SRVB/SVB"');
    expect(window).not.toContain("</srvb:serviceBinding>");

    adt.calls.length = 0;
    const err = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "SRVB/SVB", name: SVB }), {
        source: window,
        expectEtag: read.etag,
      }),
    );
    expect(err.code).toBe("PARTIAL_READ_SOURCE");
    expect(err.details.type).toBe("SRVB/SVB");
    expect(adt.labels.some((l) => l.startsWith("LOCK") || l.startsWith("PUT"))).toBe(false);
  });

  it("a descriptor that fits is not marked, and still writes", async () => {
    const small =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings" ` +
      `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${SVB}" ` +
      `adtcore:type="SRVB/SVB"><adtcore:packageRef adtcore:name="$TMP"/>` +
      `</srvb:serviceBinding>`;
    const { conn } = await connected(route(small));
    const read = await abapRead(conn, { object: SVB, type: "SRVB/SVB", format: "raw" }, 47_100);
    expect(read.truncated).toBe(false);
    expect(isPartialEtag(read.etag)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The escape hatch the refusal points AT has to actually work.
// ---------------------------------------------------------------------------

describe("`edit` is the form a truncated read can still safely use", () => {
  beforeEach(() => {
    stub.object = resolvedProg();
  });

  /**
   * The refusal above tells the caller to splice with `edit` instead. That
   * advice is worthless if `edit` then refuses the same `partial:` etag, so the
   * marker is stripped on that branch — deliberately, and this is the test that
   * says so.
   *
   * `edit` is safe for a structural reason, not a statistical one: the splice
   * runs against the object's CURRENT, COMPLETE source, freshly read inside
   * `resolveWriteSource`, and `applyEdit` demands an exact unique match inside
   * it. A caller holding only the first N lines can pick a poor `old_string`;
   * it cannot delete a tail it never mentioned.
   */
  it("an edit presenting a partial: etag is accepted, with the marker stripped", async () => {
    const { conn } = await connected(existing(PROG_URI, PROG, "PROG/P", BIG_SOURCE_CRLF));
    const read = await abapRead(conn, { object: PROG }, 47_100);
    expect(isPartialEtag(read.etag)).toBe(true);

    const resolved = await resolveWriteSource(
      conn,
      await authWrite(conn, { type: "PROG/P", name: PROG }),
      {
        object: PROG,
        edit: { old_string: "WRITE: / 'line 0001'.", new_string: "WRITE: / 'CHANGED'." },
        expect_etag: read.etag,
      } as never,
    );

    // The marker is gone, the hash is not.
    expect(isPartialEtag(resolved.expectEtag!)).toBe(false);
    expect(resolved.expectEtag).toBe(stripPartialEtag(read.etag));
    // And the spliced result is the WHOLE object with one line changed — the
    // tail the read never showed is still there.
    expect(resolved.source).toContain("WRITE: / 'CHANGED'.");
    expect(resolved.source).toContain(LAST_LINE);

    // Which means the write goes through.
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "PROG/P", name: PROG }),
      { source: resolved.source, expectEtag: resolved.expectEtag },
    );
    expect(res.changed).toBe(true);
  });

  it("a full-source write carries the marker through to writeObject unstripped", async () => {
    const { conn } = await connected(existing(PROG_URI, PROG, "PROG/P", BIG_SOURCE_CRLF));
    const resolved = await resolveWriteSource(
      conn,
      await authWrite(conn, { type: "PROG/P", name: PROG }),
      { object: PROG, source: "REPORT zmcp_big_rep.\n", expect_etag: "partial:sha256:abc" } as never,
    );
    expect(resolved.expectEtag).toBe("partial:sha256:abc");
  });
});

// ---------------------------------------------------------------------------
// The other half of the problem: the caller who sends no etag at all.
// ---------------------------------------------------------------------------

describe("pasting a read RESPONSE back as source", () => {
  /**
   * `{object, source}` with no `expect_etag` carries no marker, so the etag
   * guard cannot see it. One signal survives: response furniture in the
   * payload. `--- SOURCE ---` on a line of its own is not a heuristic — it is
   * not valid ABAP, not valid DDL and not valid ADT XML — so this needs no
   * threshold and no opt-out.
   *
   * It only catches the sloppy half. A caller who correctly extracts the text
   * inside the fence and then writes it back is still unprotected on the
   * no-etag path; see the PR body.
   */
  const ECHOES = [
    "--- SOURCE ---",
    "--- METHOD SOURCE ---",
    "--- TRUNCATED ---",
    "--- OUTPUT HARD-CLAMPED ---",
    "--- XML DESCRIPTOR ---",
  ];

  for (const marker of ECHOES) {
    it(`refuses a payload containing ${marker}`, () => {
      const src = `REPORT z.\n${marker}\nWRITE: / 'x'.\n`;
      let caught: unknown;
      try {
        assertNotToolResponseEcho(src, "ZFOO", "PROG/P");
      } catch (e) {
        caught = e;
      }
      expect(isAbapError(caught)).toBe(true);
      const err = caught as AbapError;
      expect(err.code).toBe("BAD_INPUT");
      expect(err.message).toContain(marker);
      expect(err.details.marker).toBe(marker);
    });
  }

  it("passes ordinary ABAP through untouched, including comment banners", () => {
    for (const src of [
      "REPORT z.\nWRITE: / 'x'.\n",
      "* --- SOURCE ---\n* a comment banner is not a fence\nREPORT z.\n",
      "DATA(x) = 1 - -- 2.\n",
      "define view zv as select from t { key a }\n",
      "implementation unmanaged;\ndefine behavior for ZROOT {\n}\n",
    ]) {
      expect(() => assertNotToolResponseEcho(src, "ZFOO", "PROG/P")).not.toThrow();
    }
  });

  it("fires through the real write path, before any lock is taken", async () => {
    const { conn, adt } = await connected(existing(PROG_URI, PROG, "PROG/P", BIG_SOURCE_CRLF));
    const err = await catchErr(
      resolveWriteSource(conn, await authWrite(conn, { type: "PROG/P", name: PROG }), {
        object: PROG,
        source: `system: A4H\n\n--- SOURCE ---\nREPORT zmcp_big_rep.\nWRITE: / 'x'.\n\n--- TRUNCATED ---\n`,
      } as never),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toMatch(/response markers/i);
    expect(adt.labels.some((l) => l.startsWith("LOCK"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The backstop: disclosure, never refusal.
// ---------------------------------------------------------------------------

/**
 * A write that removes most of an object is the SYMPTOM of the truncated-read
 * → full-source-write defect, but it is not
 * evidence of it — shrinking an object is a perfectly ordinary thing to do, and
 * `test/write.test.ts`'s DDIC test writes 17 characters over 31 (a 45% shrink)
 * on purpose. A percentage guard that refused that would be a nuisance, and a
 * nuisance guard gets turned off.
 *
 * So the size signal only ever SPEAKS. It never blocks, it never needs an
 * opt-out, and the `previousSource` it compares against is the same before-image
 * `abap_journal mode=undo` restores from — so the note names a remedy that is
 * genuinely one call away.
 */
describe("a large shrink is disclosed, not refused", () => {
  const HUNDRED = `REPORT ${PROG.toLowerCase()}.\n${Array.from(
    { length: 99 },
    (_, i) => `WRITE: / 'keep ${i}'.`,
  ).join("\n")}\n`;

  /** Source-shape write, no activation, checkrun answered clean. */
  const toolRoute =
    (current: string): Route =>
    (r) => {
      if (r.url === PROG_SRC && r.method === "GET") return resp(200, current, OK_TEXT);
      if (r.url === PROG_URI && r.method === "GET" && !r.qs._action)
        return resp(200, OBJECT_XML(PROG, "PROG/P"), OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === PROG_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url.includes("/checkruns"))
        return resp(
          200,
          `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`,
          OK_XML,
        );
      if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
      return undefined;
    };

  const write = async (current: string, next: string): Promise<string> => {
    const { conn } = await connected(toolRoute(current));
    const res = await abapWrite(
      conn,
      { object: PROG, type: "PROG/P", source: next, activate: false } as never,
      60_000,
      GATE,
    );
    return res.text;
  };

  it("says how much was removed, and names undo, when a write deletes most of an object", async () => {
    const text = await write(HUNDRED.replace(/\n/g, "\r\n"), "REPORT zmcp_big_rep.\nWRITE: / 'x'.\n");
    expect(text).toMatch(/SIZE: this write REMOVED/);
    // 101 lines before (100 written plus the empty one the trailing newline
    // leaves), 3 after.
    expect(text).toMatch(/98 of 101 line\(s\)/);
    expect(text).toMatch(/97%/);
    expect(text).toMatch(/TRUNCATED read/);
  });

  /**
   * The remedy the note names has to be true of the call it is attached to.
   * With no journal wired there is no before-image, so pointing at
   * `abap_journal mode=undo` would contradict the "journal is OFF" note that
   * lands two lines later — and a caller acts on whichever promise it reads
   * first.
   */
  it("names undo only when there is actually something to undo from", async () => {
    const text = await write(HUNDRED.replace(/\n/g, "\r\n"), "REPORT z.\n");
    expect(text).toMatch(/The write journal is OFF/);
    expect(text).not.toMatch(/SIZE: this write REMOVED.*abap_journal mode=undo/);
    expect(text).toMatch(/restore it NOW/);
  });

  it("does not fire on a small reduction — it is a signal, not a size police", async () => {
    // 10 lines gone out of 100: under both the 20-line floor and the one-third
    // fraction, so nothing is said.
    const next = HUNDRED.split("\n").slice(0, 90).join("\n") + "\n";
    const text = await write(HUNDRED.replace(/\n/g, "\r\n"), next);
    expect(text).not.toMatch(/SIZE: this write REMOVED/);
  });

  it("does not fire on a tiny object, however large the percentage", async () => {
    // The shape of `test/write.test.ts`'s legitimate-shrink case, which must
    // keep passing untouched: a big FRACTION of a small object is not a signal
    // of anything. The 20-line floor is what makes that true.
    const text = await write("REPORT z.\nWRITE: / 'a'.\nWRITE: / 'b'.\n", "REPORT z.\n");
    expect(text).not.toMatch(/SIZE: this write REMOVED/);
  });

  it("does not fire when the write changed nothing at all", async () => {
    const text = await write(HUNDRED.replace(/\n/g, "\r\n"), HUNDRED);
    expect(text).toMatch(/changed:\s*false/);
    expect(text).not.toMatch(/SIZE: this write REMOVED/);
  });

  it("is a note, not an error — the write still happens", async () => {
    const { conn, adt } = await connected(toolRoute(HUNDRED.replace(/\n/g, "\r\n")));
    const res = await abapWrite(
      conn,
      { object: PROG, type: "PROG/P", source: "REPORT z.\n", activate: false } as never,
      60_000,
      GATE,
    );
    expect(res.text).toMatch(/SIZE: this write REMOVED/);
    expect(res.text).toMatch(/changed:\s*true/);
    expect(adt.calls.some((c) => c.method === "PUT")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The marker's own arithmetic.
// ---------------------------------------------------------------------------

describe("partial: etag marker", () => {
  const H = "sha256:abc123";

  it("marks, recognises and strips", () => {
    expect(isPartialEtag(H)).toBe(false);
    expect(markEtagPartial(H)).toBe(`partial:${H}`);
    expect(isPartialEtag(markEtagPartial(H))).toBe(true);
    expect(stripPartialEtag(markEtagPartial(H))).toBe(H);
    expect(stripPartialEtag(H)).toBe(H);
  });

  it("never double-prefixes", () => {
    const once = markEtagPartial(H);
    expect(markEtagPartial(once)).toBe(once);
    expect(stripPartialEtag(once)).toBe(H);
  });

  it("recognises the marker whatever the case or surrounding space", () => {
    expect(isPartialEtag("  PARTIAL:sha256:abc  ")).toBe(true);
    expect(isPartialEtag("Partial:sha256:abc")).toBe(true);
  });

  it("does not treat an ordinary etag as marked", () => {
    expect(isPartialEtag("")).toBe(false);
    expect(isPartialEtag("W/\"20260101\"")).toBe(false);
    expect(isPartialEtag(contentHash("x"))).toBe(false);
  });
});
