/**
 * `abap_write dry_run`.
 *
 * A dry run resolves the target, reads current source, applies the
 * requested edit locally, runs the safety gate exactly as a real write
 * does, and returns a preview instead of mutating. These tests pin: zero
 * mutating verbs on every dry-run path, the exact diff/etag/header content,
 * the three routes with no meaningful preview (`dryRunNotSupported`), a
 * gate refusal surfacing instead of a diff, and that a real `Journal`
 * records nothing.
 *
 * Harness copied verbatim from test/write-toctou.test.ts (this file's own
 * template) — do not let the two drift on anything both need without
 * noticing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { canonicalSource, contentHash } from "../src/compact.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { Journal, type JournalConfig } from "../src/journal.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const ENH_FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement");
const DISCOVERY_ENHANCEMENTS_XML = readFileSync(join(ENH_FIXTURES_DIR, "discovery-enhancements.xml"), "utf8");

const REPORT = "ZMCP_TEST_REP";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_test_rep";
const REPORT_SRC = `${REPORT_URI}/source/main`;

const SOURCE_A = "REPORT zmcp_test_rep.\nWRITE: / 'a'.\n";
const SOURCE_B = "REPORT zmcp_test_rep.\nWRITE: / 'b'.\n";

const etagOf = (s: string): string => contentHash(canonicalSource(s));

const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">${REPORT} does not exist</message><properties/></exc:exception>`;

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

const OBJECT_XML = (name: string, type: string, packageName = "$TMP"): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${name}" adtcore:type="${type}">` +
  `<adtcore:packageRef adtcore:name="${packageName}"/>` +
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
    // Loud on purpose: a dry run that starts mutating must fail LOUDLY, not
    // silently succeed against a catch-all 200.
    if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
    return res;
  }
  get labels(): string[] {
    return this.calls.map((c) => c.label);
  }
  get verbs(): string[] {
    return this.calls.map((c) => (c.qs._action ? c.qs._action : c.method));
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
  if (r.url.endsWith("/discovery")) return resp(200, DISCOVERY_ENHANCEMENTS_XML, OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

/** The resolution GET, for tests not about resolution. Existing report, $TMP. */
function objectMetaRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.method !== "GET" || r.qs._action || r.url.endsWith("/source/main")) return undefined;
  if (r.url === REPORT_URI) return resp(200, OBJECT_XML(REPORT, "PROG/P"), OK_XML);
  return undefined;
}

async function connected(route: Route, config: Config = cfg()): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r) ?? objectMetaRoute(r));
  const conn = new AbapConnection(config, { httpClient: adt, log: () => {}, breaker: new AuthCircuitBreaker() });
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

/** Verbs a real write/delete would use; absent from every dry-run call list. */
const MUTATING_VERBS = ["PUT", "POST", "DELETE", "LOCK", "UNLOCK"];
const assertNoMutation = (adt: FakeAdt): void => {
  for (const v of MUTATING_VERBS) expect(adt.verbs).not.toContain(v);
};

const GATE = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
const MAX = 60_000;

// ---------------------------------------------------------------------------
// 1. edit form, existing object
// ---------------------------------------------------------------------------

describe("dry_run — edit form", () => {
  function server() {
    const route = (r: Recorded): HttpClientResponse | undefined => {
      if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_A, OK_TEXT);
      return undefined;
    };
    return route;
  }

  it("returns a diff and asserts current's etag as expect_etag, with zero mutating calls", async () => {
    const { conn, adt } = await connected(server());

    const result = await abapWrite(
      conn,
      {
        object: REPORT,
        type: "PROG/P",
        edit: { old_string: "WRITE: / 'a'.", new_string: "WRITE: / 'b'." },
        dry_run: true,
      } as never,
      MAX,
      GATE,
    );

    expect(result.text).toContain("dry_run: true");
    expect(result.text).toContain(`object: PROG/P ${REPORT}`);
    expect(result.text).toContain(`uri: ${REPORT_URI}`);
    expect(result.text).toContain("package: $TMP");
    expect(result.text).toContain(`expect_etag: ${etagOf(SOURCE_A)}`);
    expect(result.text).toContain("transport: unresolved (dry run makes no transport call)");
    expect(result.text).toContain("-WRITE: / 'a'.");
    expect(result.text).toContain("+WRITE: / 'b'.");

    assertNoMutation(adt);
    // Exactly the resolve GET + the edit form's own source read — nothing more.
    expect(adt.calls).toEqual([
      { label: `GET ${REPORT_URI}`, method: "GET", url: REPORT_URI, qs: {}, body: undefined },
      { label: `GET ${REPORT_SRC}`, method: "GET", url: REPORT_SRC, qs: {}, body: undefined },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. plain {object, source} form, existing object
// ---------------------------------------------------------------------------

describe("dry_run — plain source form", () => {
  function server() {
    const route = (r: Recorded): HttpClientResponse | undefined => {
      if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_A, OK_TEXT);
      return undefined;
    };
    return route;
  }

  it("with no expect_etag: renders the 'asserts no precondition' placeholder and still shows a real diff, at the cost of one extra GET", async () => {
    const { conn, adt } = await connected(server());

    const result = await abapWrite(conn, { object: REPORT, type: "PROG/P", source: SOURCE_B, dry_run: true } as never, MAX, GATE);

    expect(result.text).toContain("expect_etag: none (this form asserts no precondition)");
    expect(result.text).toContain("-WRITE: / 'a'.");
    expect(result.text).toContain("+WRITE: / 'b'.");
    assertNoMutation(adt);
    // Resolve GET, then the dry-run branch's own extra read of current source
    // (the real-write path for this form makes no such read at all).
    expect(adt.calls.map((c) => c.label)).toEqual([`GET ${REPORT_URI}`, `GET ${REPORT_SRC}`]);
  });

  it("with an explicit expect_etag: surfaces exactly that value, not current's", async () => {
    const { conn, adt } = await connected(server());
    const explicit = etagOf("something else entirely");

    const result = await abapWrite(
      conn,
      { object: REPORT, type: "PROG/P", source: SOURCE_B, expect_etag: explicit, dry_run: true } as never,
      MAX,
      GATE,
    );

    expect(result.text).toContain(`expect_etag: ${explicit}`);
    expect(result.text).not.toContain("asserts no precondition");
    assertNoMutation(adt);
  });
});

// ---------------------------------------------------------------------------
// 3. create (object does not exist)
// ---------------------------------------------------------------------------

describe("dry_run — create", () => {
  it("diffs against empty source and reports created: true, with zero mutating calls", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      return undefined;
    });

    const result = await abapWrite(conn, { object: REPORT, type: "PROG/P", source: SOURCE_A, dry_run: true } as never, MAX, GATE);

    expect(result.text).toContain("created: true");
    expect(result.text).toContain("+WRITE: / 'a'.");
    expect(result.text).not.toContain("current_etag:");
    assertNoMutation(adt);
    expect(adt.calls).toHaveLength(1);
    expect(adt.calls[0]).toMatchObject({ method: "GET", url: REPORT_URI });
  });
});

// ---------------------------------------------------------------------------
// 4. mode: "delete" dry run
// ---------------------------------------------------------------------------

describe("dry_run — delete", () => {
  it("reports would_delete: true and mode: delete, no DELETE verb, no diff body", async () => {
    const { conn, adt } = await connected(() => undefined);

    const result = await abapWrite(conn, { object: REPORT, type: "PROG/P", mode: "delete", dry_run: true } as never, MAX, GATE);

    expect(result.text).toContain("mode: delete");
    expect(result.text).toContain("would_delete: true");
    expect(result.text).toContain("dry_run: true");
    expect(result.text).toContain("transport: unresolved (dry run makes no transport call)");
    expect(result.text).not.toContain("--- DIFF ---");
    assertNoMutation(adt);
    // The only request a delete dry run makes is the resolution GET.
    expect(adt.calls).toEqual([{ label: `GET ${REPORT_URI}`, method: "GET", url: REPORT_URI, qs: {}, body: undefined }]);
  });
});

// ---------------------------------------------------------------------------
// 5. gate refusal instead of a diff
// ---------------------------------------------------------------------------

describe("dry_run — safety gate still refuses", () => {
  it("a package-allowlist mismatch throws the gate's refusal, not a diff, with zero mutating calls", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_A, OK_TEXT);
      return undefined;
    });
    const mismatchedGate = new SafetyGate({ readOnly: false, allowPackages: ["ZNOT_TMP"] });

    const err = await catchErr(
      abapWrite(conn, { object: REPORT, type: "PROG/P", source: SOURCE_B, dry_run: true } as never, MAX, mismatchedGate),
    );

    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toContain("$TMP");
    expect(err.message).toContain("not in the allowlist");
    expect(err.message).not.toContain("--- DIFF ---");
    assertNoMutation(adt);
    expect(adt.calls.some((c) => c.url === REPORT_SRC)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. journal untouched
// ---------------------------------------------------------------------------

describe("dry_run — journal untouched", () => {
  const journalCfg = (dir: string): JournalConfig => ({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 });

  it("a write dry run makes no journal entry", async () => {
    const tmp = await fs.mkdtemp(join(os.tmpdir(), "abapsmith-write-dry-run-"));
    try {
      const j = new Journal(journalCfg(tmp), "A4H");
      const { conn } = await connected((r) => {
        if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_A, OK_TEXT);
        return undefined;
      });

      await abapWrite(conn, { object: REPORT, type: "PROG/P", source: SOURCE_B, dry_run: true } as never, MAX, GATE, j);

      expect(await j.list({})).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("a delete dry run makes no journal entry", async () => {
    const tmp = await fs.mkdtemp(join(os.tmpdir(), "abapsmith-write-dry-run-"));
    try {
      const j = new Journal(journalCfg(tmp), "A4H");
      const { conn } = await connected(() => undefined);

      await abapWrite(conn, { object: REPORT, type: "PROG/P", mode: "delete", dry_run: true } as never, MAX, GATE, j);

      expect(await j.list({})).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 7. routes with no meaningful preview — all pre-network
// ---------------------------------------------------------------------------

describe("dry_run — routes with no meaningful preview", () => {
  it("`objects` batch-delete form: BAD_INPUT, zero network calls", async () => {
    const { conn, adt } = await connected(() => undefined);

    const err = await catchErr(
      abapWrite(conn, { objects: [{ object: REPORT }], mode: "delete", dry_run: true } as never, MAX, GATE),
    );

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("objects");
    expect(adt.calls).toHaveLength(0);
  });

  it("a bridge-only create type (VIEW/DV): BAD_INPUT naming the type, zero network calls", async () => {
    const { conn, adt } = await connected(() => undefined);

    const err = await catchErr(
      abapWrite(conn, { object: "ZMCP_V_CARRIER", type: "VIEW/DV", source: "@AbapCatalog...", dry_run: true } as never, MAX, GATE),
    );

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("VIEW/DV");
    expect(err.message).toContain("classrun bridge");
    expect(adt.calls).toHaveLength(0);
  });

  it("type naming a package (DEVC/K): BAD_INPUT, zero network calls", async () => {
    const { conn, adt } = await connected(() => undefined);

    const err = await catchErr(
      abapWrite(conn, { object: "ZMCP_TEST_PKG", type: "DEVC/K", package: "$TMP", dry_run: true } as never, MAX, GATE),
    );

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("package (DEVC/K)");
    expect(err.message).toContain("transport request");
    expect(adt.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. method form (best effort) — the dry-run hook sits after
// `resolveWriteSource`, so the decisive properties (diff, etag, zero
// mutation) are already covered form-agnostically above; this only pins
// that the method-splice path itself reaches the same hook.
// ---------------------------------------------------------------------------

describe("dry_run — method form", () => {
  const CLAS_NAME = "ZMCP_TEST_CLS";
  const CLAS_URI = "/sap/bc/adt/oo/classes/zmcp_test_cls";
  const CLAS_SRC = `${CLAS_URI}/source/main`;
  const CLAS_STRUCT = `${CLAS_URI}/objectstructure`;

  const CURRENT_SOURCE =
    "CLASS zmcp_test_cls DEFINITION PUBLIC FINAL CREATE PUBLIC.\n" +
    "  PUBLIC SECTION.\n" +
    "    METHODS get_value RETURNING VALUE(result) TYPE i.\n" +
    "ENDCLASS.\n" +
    "\n" +
    "CLASS zmcp_test_cls IMPLEMENTATION.\n" +
    "  METHOD get_value.\n" +
    "    result = 1.\n" +
    "  ENDMETHOD.\n" +
    "ENDCLASS.\n";

  const NEW_METHOD_SOURCE = "METHOD get_value.\n    result = 2.\nENDMETHOD.";

  const OBJECT_STRUCTURE_XML =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<abapsource:objectStructureElement xmlns:abapsource="http://www.sap.com/adt/abapsource" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" xmlns:atom="http://www.w3.org/2005/Atom" ` +
    `adtcore:name="${CLAS_NAME}" adtcore:type="CLAS/OC">` +
    `<abapsource:objectStructureElement adtcore:name="GET_VALUE" adtcore:type="CLAS/OM">` +
    `<atom:link href="./source/main#start=7,0;end=9,0" ` +
    `rel="http://www.sap.com/adt/relations/source/implementationBlock"/>` +
    `</abapsource:objectStructureElement>` +
    `</abapsource:objectStructureElement>`;

  it("diffs the spliced method body against current, with zero mutating calls", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === CLAS_URI && r.method === "GET") return resp(200, OBJECT_XML(CLAS_NAME, "CLAS/OC"), OK_XML);
      if (r.url === CLAS_SRC && r.method === "GET") return resp(200, CURRENT_SOURCE, OK_TEXT);
      if (r.url === CLAS_STRUCT && r.method === "GET") return resp(200, OBJECT_STRUCTURE_XML, OK_XML);
      return undefined;
    });

    const result = await abapWrite(
      conn,
      { object: CLAS_NAME, type: "CLAS/OC", method: "get_value", source: NEW_METHOD_SOURCE, dry_run: true } as never,
      MAX,
      GATE,
    );

    expect(result.text).toContain("dry_run: true");
    expect(result.text).toContain(`expect_etag: ${etagOf(CURRENT_SOURCE)}`);
    expect(result.text).toContain("-    result = 1.");
    expect(result.text).toContain("+    result = 2.");
    assertNoMutation(adt);
    expect(adt.calls.map((c) => c.label)).toEqual([`GET ${CLAS_URI}`, `GET ${CLAS_SRC}`, `GET ${CLAS_STRUCT}`]);
  });
});
