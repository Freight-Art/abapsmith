/**
 * `SHLP/DH` delete — journal contract, offline with a fake `HttpClient`
 * injected through `ConnectionOptions.httpClient`, same harness idiom as
 * `test/write-bridge-crud.test.ts` (VIEW/DV / TRAN/T bridge CRUD): real
 * production code (`abapWrite` -> `src/tools/write.ts`'s
 * `abapDeleteSearchHelpViaBridge`) drives a fake socket, plus the real
 * fluid `classic`-tool deploy/classrun fake from
 * `test/helpers/fluid-classic-fake.ts` and a real in-memory-backed
 * `Journal` (`src/journal.js`) writing to a temp directory. Nothing here
 * touches a real SAP system.
 *
 * `test/ddic-bridge-mutation.test.ts` and `test/journal-contract.test.ts`
 * were the two files this suite's task named as the existing harness to
 * reuse. Neither actually drives a bridge write against a fake connection
 * plus a real journal: the first exercises `assertBridgeMutation` in
 * isolation against a `RecordingGate`, with no `AbapConnection` or
 * `Journal` involved at all; the second is a static source-scan over every
 * mutation call site (`KNOWN_GAPS`/`NOT_REPOSITORY_MUTATIONS` allowlists),
 * not a runtime test with fakes. `test/write-bridge-crud.test.ts` is the
 * file that actually matches the description, so its idiom — real
 * `AbapConnection` + a hand-rolled `FakeAdt` + `classicFake()` +
 * `useFluidState()` + a real `Journal` against a temp dir — is reused here
 * instead.
 *
 * `SHLP/DH` has no VIT-bridge existence probe the way `VIEW/DV`/`TRAN/T`
 * do: it exists-checks through `readSearchHelp` (`src/adt/catalog-read.ts`),
 * which issues one or more `POST /sap/bc/adt/datapreview/freestyle` calls
 * (DD30L header, then DD30T/DD31S/DD32S/DD33S/DD04L detail queries) — the
 * same endpoint the one-time system-role probe uses at `conn.connect()`
 * time. `shlpRoute()` below tells the two apart by call ORDER, not by
 * inspecting the SQL: `conn.connect()` issues exactly one freestyle call
 * (measured via `test/helpers/system-role-fake.ts`, `src/adt/system-role.ts`),
 * so the very first freestyle call this fake ever answers is that probe, and
 * every one after it is `readSearchHelpImpl`'s.
 *
 * Row values fed to the fake (header/text/etc. columns) are structural
 * stand-ins, not plausible SAP data: their only job is to be counted and
 * carried through unchanged by `readSearchHelpImpl`'s renderer, so a test
 * can compare the journal's before-image against an independently-obtained
 * `readSearchHelp()` call over the same fixture instead of hand-typing the
 * expected pseudo-DDL text.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { abapWrite } from "../src/tools/write.js";
import { performUndo } from "../src/adt/undo.js";
import { SafetyGate } from "../src/safety.js";
import { Journal, type JournalEntry } from "../src/journal.js";
import { readSearchHelp } from "../src/adt/catalog-read.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { classicFake, useFluidState } from "./helpers/fluid-classic-fake.js";

const MAX = 20_000;
const NAME = "Z154C_SHLP_STANDIN";

// ------------------------------------------------------------ fake wire ---

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

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

/** One column's `<dataPreview:columns>` block — same shape `test/img-read.test.ts` uses for the same wire format. */
function columnXml(name: string, values: readonly string[]): string {
  const data = values.map((v) => `<dataPreview:data>${v}</dataPreview:data>`).join("");
  return (
    `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="C" dataPreview:keyAttribute="false"/>` +
    `<dataPreview:dataSet>${data}</dataPreview:dataSet></dataPreview:columns>`
  );
}

/** One structural stand-in row: a single unread column, just to make `records.length === 1` true. */
function oneStandInRow(): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
    `${columnXml("STANDIN_COL", ["x"])}</dataPreview:tableData>`
  );
}

/** No rows at all — `readSearchHelpImpl` treats this as "no header row" for the header query, and as "nothing to render" for every other query. */
function emptyResult(): string {
  return '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview"></dataPreview:tableData>';
}

/** The exact 7-call sequence `readSearchHelpImpl` issues when the header row exists: header, text, includes, params, assigns, usedBy, parents. */
const EXISTS_PROBE_BODIES: readonly string[] = [
  oneStandInRow(),
  emptyResult(),
  emptyResult(),
  emptyResult(),
  emptyResult(),
  emptyResult(),
  emptyResult(),
];

/**
 * Routes `/datapreview/freestyle` calls by ORDER: the first one ever made on
 * a connection is `conn.connect()`'s one-time system-role probe (answered
 * with the same fixture `test/helpers/system-role-fake.ts` uses); every
 * subsequent one is fed from `bodies`, in order. Throwing an entry (instead
 * of a body) lets a test simulate a failed read instead of an empty one.
 */
function freestyleQueueRoute(bodies: ReadonlyArray<string | (() => never)>): Route {
  let n = 0;
  return (r) => {
    if (!r.url.includes("/datapreview/freestyle")) return undefined;
    n++;
    if (n === 1) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
    const entry = bodies[n - 2];
    if (entry === undefined) {
      throw new Error(`freestyleQueueRoute: no fixture queued for SHLP-side call #${n - 1}`);
    }
    if (typeof entry === "function") entry();
    return resp(200, entry as string, DATAPREVIEW_XML);
  };
}

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  return undefined;
}

const fluidState = useFluidState();
afterAll(async () => {
  await rm(fluidState.dir(), { recursive: true, force: true });
});

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
    stateDir: fluidState.dir(),
  });

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

function gate(): SafetyGate {
  return new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowNamePrefixes: ["*"],
    allowTransports: ["*"],
    writesLockedOut: false,
  });
}

async function withJournal(fn: (journal: Journal) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abapsmith-shlp-journal-"));
  try {
    await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The fixture combination that lets a `SHLP/DH` delete succeed end to end: the pre-delete probe finds it, the classrun deletes it, the post-delete probe confirms it gone. */
function successRoute(): Route {
  const classic = classicFake({ action: "delete_search_help", lines: () => ["SHLP-DELETED", "SHLP-GONE"] });
  const shlp = freestyleQueueRoute([
    ...EXISTS_PROBE_BODIES,
    // Post-delete probeSearchHelpAnyState(): the ACTIVE ('A') header query
    // finds nothing (the delete worked)...
    emptyResult(),
    // ...so it falls back to the INACTIVE ('N') header query too (issue #83)
    // — also empty, so the delete stays confirmed "verified gone".
    emptyResult(),
  ]);
  return (r) => classic.route(r) ?? shlp(r);
}

async function deleteEntry(journal: Journal): Promise<{ conn: AbapConnection; entry: JournalEntry }> {
  const { conn } = await connected(successRoute());
  await abapWrite(conn, { object: NAME, type: "SHLP/DH", mode: "delete" }, MAX, gate(), journal);
  const entries = await journal.list();
  const entry = entries[0];
  if (!entry) throw new Error("test fixture bug: no journal entry was recorded for the delete");
  return { conn, entry };
}

// ------------------------------------------------------------------ tests --

describe("SHLP/DH delete journals a before-image", () => {
  it("opens a journal entry with beforeCapture 'captured' and beforeSource equal to the pre-delete probeSearchHelp read", async () => {
    await withJournal(async (journal) => {
      const { entry } = await deleteEntry(journal);
      expect(entry.beforeCapture).toBe("captured");

      // Pin beforeSource === existing.ddl without hand-typing the rendered
      // pseudo-DDL: feed readSearchHelp() the SAME fixture bodies
      // independently, and compare the two renders for equality. Both
      // calls are the real production renderer over the same structural
      // stand-in rows, so their output is identical iff the journal really
      // stored the pre-delete read's `ddl`, not something else.
      const { conn: probeConn } = await connected(freestyleQueueRoute(EXISTS_PROBE_BODIES));
      const expected = await readSearchHelp(probeConn, NAME);

      const stored = await journal.beforeImage(entry);
      expect(stored).toBe(expected.ddl);
      expect(stored).toContain(`SEARCH HELP ${NAME}`);
    });
  });

  it("is marked irreversible: true", async () => {
    await withJournal(async (journal) => {
      const { entry } = await deleteEntry(journal);
      expect(entry.irreversible).toBe(true);
    });
  });

  it("never records beforeCapture as 'confirmed-absent' on this path — that value means a positively-confirmed absence, which a delete's pre-image never is", async () => {
    await withJournal(async (journal) => {
      const { entry } = await deleteEntry(journal);
      expect(entry.beforeCapture).not.toBe("confirmed-absent");
    });
  });
});

describe("SHLP/DH delete of an absent search help", () => {
  it("throws NOT_FOUND and opens no journal entry at all", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(
        freestyleQueueRoute([
          // Pre-delete probeSearchHelpAnyState(): ACTIVE ('A') header query finds no row...
          emptyResult(),
          // ...so it falls back to the INACTIVE ('N') header query too (issue #83) — also
          // empty, so the object is genuinely absent and the delete must refuse NOT_FOUND.
          emptyResult(),
        ]),
      );
      let thrown: unknown;
      try {
        await abapWrite(conn, { object: NAME, type: "SHLP/DH", mode: "delete" }, MAX, gate(), journal);
      } catch (e) {
        thrown = e;
      }
      expect(isAbapError(thrown) && thrown.code).toBe("NOT_FOUND");
      expect(await journal.list()).toEqual([]);
    });
  });
});

describe("SHLP/DH delete's pre-delete read does not fabricate absence", () => {
  it("a non-NOT_FOUND failure (e.g. an authorisation failure) during the pre-delete probe propagates instead of being treated as 'search help does not exist'", async () => {
    await withJournal(async (journal) => {
      let freestyleCalls = 0;
      const route: Route = (r) => {
        if (!r.url.includes("/datapreview/freestyle")) return undefined;
        freestyleCalls++;
        if (freestyleCalls === 1) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
        // The DD30L header query itself fails — an authorisation error, not
        // an absence. catalogProbe()/probeSearchHelp() (src/tools/write.ts)
        // must let this propagate, never swallow it into `undefined`.
        throw new HttpClientException(
          "Request failed with status code 403",
          "403",
          403,
          undefined,
          { url: r.url, method: r.method } as HttpClientOptions,
          resp(403, "<forbidden/>", OK_XML),
        );
      };
      const { conn, adt } = await connected(route);
      let thrown: unknown;
      try {
        await abapWrite(conn, { object: NAME, type: "SHLP/DH", mode: "delete" }, MAX, gate(), journal);
      } catch (e) {
        thrown = e;
      }
      expect(isAbapError(thrown) && thrown.code).not.toBe("NOT_FOUND");
      expect(isAbapError(thrown)).toBe(true);
      // Nothing was journalled, and the classrun delete was never dispatched:
      // only the one failed freestyle call was made.
      expect(await journal.list()).toEqual([]);
      expect(adt.calls.some((c) => c.url.includes("/oo/classrun/"))).toBe(false);
    });
  });
});

describe("SHLP/DH delete is refused by abap_journal mode=undo, even with force", () => {
  it("performUndo refuses the irreversible entry with the real undoBlocker() message, and force=true does not override it", async () => {
    await withJournal(async (journal) => {
      const { conn, entry } = await deleteEntry(journal);
      expect(entry.irreversible).toBe(true);

      const g = gate();
      let thrown: unknown;
      try {
        await performUndo(conn, journal, entry, {
          force: true,
          gate: g,
          assertAllowed: (action, target) => g.authorize(action === "delete" ? "delete" : "write", target),
        });
      } catch (e) {
        thrown = e;
      }
      expect(isAbapError(thrown) && thrown.code).toBe("BAD_INPUT");
      // The exact undoBlocker() catch-all text (src/adt/undo.ts): two
      // independent reasons collapse to one message rather than two, but
      // both are true of this entry — (a) the stored before-image is
      // rendered pseudo-DDL (src/adt/ddic.ts's renderer via
      // src/adt/catalog-read.ts), not a DDIF_SHLP_PUT payload, so there is
      // nothing to mechanically replay; (b) vitTypeFor() (src/adt/undo.ts)
      // has no "SHLP/DH" case at all, so even a VIT-bridge-style undo path
      // could not resolve this type regardless of (a).
      expect(isAbapError(thrown) ? thrown.message : "").toBe(
        "This entry is marked irreversible — recorded for history only. No mechanism " +
          "can undo it, not even with force=true.",
      );
    });
  });
});
