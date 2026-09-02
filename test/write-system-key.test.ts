/**
 * `abap_write` never set `systemKey` on the entries it produces,
 * so `systemMismatchBlocker` (src/adt/undo.ts) could never reach its strong
 * `entry.systemKey === live.key` match and always fell back to the weak,
 * SID-only `system` comparison — even on a live connection with `systemKey`
 * available the whole time. `src/tools/transport.ts` and `src/tools/activate.ts`
 * already set it; `src/tools/write.ts`'s three `withJournalledMutation` call
 * sites (create/update, delete, package-create) did not.
 *
 * This is a single, narrow seam test, in the spirit of
 * `test/before-image-contract.test.ts`'s harness (reused here in trimmed
 * form): a REAL `abapWrite`, over a REAL `AbapConnection`, against a fake HTTP
 * client with no catch-all, writing to a REAL `Journal`. It proves the field
 * that reaches disk is not a literal asserted against itself — it is
 * `systemKey(conn.cfg)` for the exact `conn` the write went out on, matching
 * the helper `src/adt/undo.ts` uses to build `live.key`.
 *
 * Covers the create/update call site directly. The delete and package-create
 * call sites in src/tools/write.ts use the identical `systemKey: systemKey(
 * conn.cfg)` expression (see the git history) — not independently
 * re-tested here, since a second harness proving the same one-line expression
 * twice would not catch anything this one does not.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { Journal, systemKey, type JournalConfig } from "../src/journal.js";
import { SafetyGate } from "../src/safety.js";
import { abapWrite } from "../src/tools/write.js";
import { T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const REPORT = "ZMCP_SYSKEY_REP";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_syskey_rep";
const REPORT_SRC = `${REPORT_URI}/source/main`;
const PROG_COLLECTION = "/sap/bc/adt/programs/programs";
const SRC_V1 = "REPORT zmcp_syskey_rep.\nWRITE: / 'syskey'.\n";

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
  `<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL>` +
  `<IS_LINK_UP/><MODIFICATION_SUPPORT/></DATA></asx:values></asx:abap>`;

const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">${REPORT} does not exist</message><properties/></exc:exception>`;

const CLEAN_CHECKRUN = `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`;

/**
 * Same "no catch-all" fake as before-image-contract.test.ts, trimmed to one
 * object — but it must be STATEFUL like that one, not a fixed routing table.
 * `abapWrite`'s create path re-reads the object's content AFTER the PUT (to
 * capture the journal entry's "after" image), so a GET that always answers
 * 404 — appropriate only for the PRE-write existence check — makes that
 * later read look like the object vanished, which src/adt/write.ts correctly
 * (and confusingly, until you look here) reports as "has no readable
 * content". Model the object's existence and source the same way
 * before-image-contract.test.ts does: undefined until POST+PUT, then real.
 */
class StrictAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  private source: string | undefined;

  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const r: Recorded = { label, method, url: o.url, qs, body: o.body };
    this.calls.push(r);

    if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
    if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
    if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, OK_XML);
    if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
    if (r.url === REPORT_URI && method === "GET") {
      return this.source === undefined
        ? resp(404, NOT_FOUND_XML, OK_XML)
        : resp(200, "<program/>", OK_XML);
    }
    if (r.url === REPORT_SRC && method === "GET") {
      return this.source === undefined
        ? resp(404, NOT_FOUND_XML, OK_XML)
        : resp(200, this.source, { ...OK_TEXT, etag: `srv-${this.source.length}` });
    }
    if (r.url === PROG_COLLECTION && method === "POST") {
      this.source = "";
      return resp(200, "", OK_TEXT);
    }
    if (r.url === REPORT_URI && qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
    if (r.url === REPORT_URI && qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === REPORT_SRC && method === "PUT") {
      this.source = r.body ?? "";
      return resp(200, "", OK_TEXT);
    }
    if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
    if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);

    throw new Error(`UNROUTED REQUEST in write-system-key.test.ts: ${label}`);
  }
  get verbs(): string[] {
    return this.calls.map((c) => c.qs._action ?? c.method);
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

async function connected(): Promise<{ conn: AbapConnection; adt: StrictAdt }> {
  const adt = new StrictAdt();
  const conn = new AbapConnection(cfg(), {
    httpClient: adt,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const openGate = (): SafetyGate => new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

describe("abap_write sets systemKey on the journal entry it produces", () => {
  it("a freshly created object's journal entry carries systemKey(conn.cfg) — not empty, not the weak SID fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abap-syskey-"));
    try {
      const jcfg: JournalConfig = { dir, enabled: true, maxEntries: 200, maxAgeDays: 30 };
      const journal = new Journal(jcfg, "A4H");
      const { conn } = await connected();

      await abapWrite(
        conn,
        { object: REPORT, type: "PROG/P", source: SRC_V1 } as never,
        60_000,
        openGate(),
        journal,
      );

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;

      // Not just "truthy" — the EXACT value the strong-match side of
      // `systemMismatchBlocker` (src/adt/undo.ts) recomputes from a live
      // connection, so a real undo on the same system matches by identity
      // rather than falling through to the SID-only fallback.
      expect(entry.systemKey).toBeDefined();
      expect(entry.systemKey).not.toBe("");
      expect(entry.systemKey).toBe(systemKey(conn.cfg));

      // The weak fallback field is unaffected by this fix — both coexist,
      // exactly as doc/JOURNAL/journal-format.md's identity row describes.
      expect(entry.system).toBe("A4H");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
