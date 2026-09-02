/**
 * v2 surface — behavioural, persisted-bytes proof that
 * `src/tools/v2/handlers/do/enhancements.ts`'s `enh_write_description` action
 * writes `systemKey` on the journal entry it produces, and that the field
 * survives on DISK, not merely through whatever `Journal.list()`/`abap_journal
 * mode=show` happens to render back.
 *
 * This is the v2 sibling of `test/write-system-key.test.ts` (which covers
 * `src/tools/write.ts`'s create/update site) and `test/bopf-journal.test.ts`'s
 * BOPF sites — same harness idiom (real `AbapConnection` against a fake HTTP
 * client with no catch-all, real `Journal` against a temp dir), applied to the
 * one journalling call site in `src/tools/v2/handlers/do/enhancements.ts`
 * (`writeDescription`'s `withJournalledMutation` call). Kept as its own file
 * per this repo's one-copy-per-test-file convention rather than folding into
 * `test/tools-v2-do-enhancements.test.ts` (which mocks the ADT layer
 * entirely and so never exercises a real journal write) or
 * `test/enhancement-tools.test.ts` (v1 `abap_enh`, a different call site).
 *
 * The final assertion reads `index.jsonl` directly rather than going through
 * `journal.list()` — the journal file is an append-only log, so `begin()` and
 * `settle()` each append their own line under the same `id`; the raw check
 * below locates the begin-record line specifically (see the comment at the
 * assertion) rather than assuming one line per entry.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { Journal, systemKey } from "../src/journal.js";
import { ENHANCEMENT_HANDLERS } from "../src/tools/v2/handlers/do/enhancements.js";
import { fakeDoDeps, fakeDoPool, openDoGate } from "./helpers/do-deps-fake.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement");
const fixture = (name: string): string => readFileSync(join(FIXTURES_DIR, name), "utf8");

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse => ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

interface Recorded {
  method: string;
  url: string;
  qs: Record<string, string>;
}

type Route = (r: Recorded) => HttpClientResponse | undefined;

const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const DISCOVERY_ENHANCEMENTS_XML = fixture("discovery-enhancements.xml");

class FakeAdt implements HttpClient {
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const rec: Recorded = { method, url: o.url, qs };
    const res = this.route(rec);
    if (!res) throw new Error(`FakeAdt: unrouted request ${qs._action ?? method} ${o.url}`);
    return res;
  }
}

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, DISCOVERY_ENHANCEMENTS_XML, OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  return undefined;
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

async function connected(route: Route): Promise<AbapConnection> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  // The write path goes through `withStatefulSession`, which is fail-closed on
  // the system-role probe (src/adt/connection.ts's `detectSystemRole`): any
  // unanswered `POST .../datapreview/freestyle` is treated as "could not prove
  // non-productive" and locks writes out, regardless of the safety gate. This
  // suite is about `systemKey`, not that lockout, so it declares its intent by
  // answering the probe explicitly rather than leaving it silent — see
  // test/helpers/system-role-fake.ts and test/system-role-probe-guard.test.ts.
  const routed = routeSystemRoleProbe(adt, { answer: "nonproductive" });
  const conn = new AbapConnection(cfg(), {
    httpClient: routed,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  return conn;
}

const ENHOXHH_URI = "/sap/bc/adt/enhancements/enhoxhh/ZMCP_ENH_B";
const ENHOXHH_XML = (
  JSON.parse(fixture("138-put-wholedoc-success.meta.json")) as { requestBody: string }
).requestBody;
const LOCK_LOCAL_XML =
  `<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">` +
  `<asx:values><DATA><LOCK_HANDLE>84895B18717205C738BE52DAB00DC12609C1821F</LOCK_HANDLE><CORRNR/>` +
  `<CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/>` +
  `<MODIFICATION_SUPPORT>NoModification</MODIFICATION_SUPPORT><SCOPE_MESSAGES/></DATA></asx:values></asx:abap>`;
const AFFECTS_HOOK = { name: "ZMCP_BADI_HOST", packageName: "$TMP", masterSystem: "A4H" };

const writingServer = (): Route => (r) => {
  if (r.url === ENHOXHH_URI && r.method === "GET") return resp(200, ENHOXHH_XML, OK_XML);
  if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
  if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
  if (r.url === ENHOXHH_URI && r.method === "PUT") return resp(200, "", { etag: "NEWETAG123=" });
  return undefined;
};

describe("v2: enh_write_description sets systemKey on the persisted journal entry", () => {
  it("the raw index.jsonl line — not journal.list()'s parsed view — carries systemKey(conn.cfg) verbatim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abapsmith-v2-enh-syskey-"));
    try {
      const journal = new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H");
      const conn = await connected(writingServer());

      const deps = fakeDoDeps({
        pool: fakeDoPool(conn),
        journal,
        safety: openDoGate({ allowPackages: ["$TMP"], enhanceTargets: "customer" }),
      });

      const handler = ENHANCEMENT_HANDLERS.get("enh_write_description")!;
      const res = await handler(
        {
          action: "enh_write_description",
          object: "ZMCP_ENH_B",
          args: { type: "ENHO/XHH", description: "a new description", affects: AFFECTS_HOOK },
        },
        deps,
      );
      expect(res.ok).toBe(true);

      // Sanity: exactly one entry landed, via the real Journal API, before
      // dropping to the raw file — a wrong-count failure here should not be
      // reported as a raw-bytes parsing bug.
      const viaList = await journal.list();
      expect(viaList).toHaveLength(1);

      // The actual assertion the coordinator asked for: read the bytes
      // `index.jsonl` holds on disk directly, bypassing Journal.list()'s (and
      // any future abap_journal mode=show render's) own parsing, so a site
      // that set `systemKey: ""` — truthy-checked away by src/journal.ts's
      // `...(input.systemKey ? { systemKey: input.systemKey } : {})` and so
      // silently absent from the persisted line — cannot hide behind a
      // higher-level accessor that might paper over it.
      //
      // The journal is an APPEND-ONLY log, not one-line-per-entry: `begin()`
      // appends the first line (the full object, including `systemKey`), and
      // `settle()` appends a SECOND line carrying only `id`/`outcome`/`after`
      // — `Journal.list()` merges lines that share an `id` into one logical
      // entry, which is exactly what `viaList` above already exercised. So
      // the raw-bytes check below reads the BEGIN line specifically (the one
      // with an `operation` field) rather than assuming the file has only one
      // line — a file with anything other than exactly these two lines, or
      // whose begin line lacks `operation`, is itself unexpected and fails.
      const raw = readFileSync(join(dir, "index.jsonl"), "utf8");
      const lines = raw.trim().split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(2);
      const parsedLines = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const beginLines = parsedLines.filter((l) => l.operation !== undefined);
      expect(beginLines).toHaveLength(1);
      const persisted = beginLines[0] as { systemKey?: string; object: { name: string } };

      expect(persisted.object.name).toBe("ZMCP_ENH_B");
      expect(persisted.systemKey).toBeDefined();
      expect(persisted.systemKey).not.toBe("");
      expect(persisted.systemKey).toBe(systemKey(conn.cfg));

      conn.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
