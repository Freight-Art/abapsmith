/**
 * THE BEFORE-IMAGE PROVENANCE CONTRACT — a seam test, not a unit test.
 *
 * Three modules share one four-word vocabulary and each of them was built
 * defensively, in isolation, so that none of them would be load-bearing alone:
 *
 *   PRODUCER   `captureOf()` in src/tools/write.ts translates the ADT layer's
 *              `BeforeImage` into a `BeforeImageCapture` string.
 *   VOCABULARY `BeforeImageCapture` / `CAPTURE_VALUES` / `normaliseCapture()` in
 *              src/journal.ts is where that string is written to disk, read back,
 *              and made total (anything unrecognised degrades to "unknown").
 *   CONSUMER   `deleteEvidenceBlocker()` in src/adt/undo.ts reads the recorded
 *              string back and decides whether an undo may DELETE the object.
 *
 * Every one of those three has its own passing test suite, and every one of them
 * is individually correct. What nobody checked is that the vocabularies MEET IN
 * THE MIDDLE — and for the single most important word, they did not. `captureOf`
 * used to answer "unknown" for an object that genuinely did not exist before the
 * write (a real 404 from the pre-write metadata GET). `deleteEvidenceBlocker`
 * does not accept "unknown" as proof of prior absence — only "confirmed-absent"
 * — so the undo of every freshly created object was refused, while src/tools/
 * write.ts told the user, in plain English in the same response, "This object did
 * not exist before, so undo DELETES it." The tool promised an undo that the undo
 * path would always refuse.
 *
 * That is what makes this failure mode SILENT and why it needs a file of its own.
 * Neither side is wrong on its own terms: the producer emitted a legal value from
 * the shared union, the consumer refused a value that is genuinely not evidence,
 * and both sides' tests stayed green throughout. The defect lives entirely in the
 * gap between them, which is precisely the place no single module's suite looks.
 *
 * So this file does two things, and only these two things:
 *   1. it pins the vocabulary as ONE SET, enumerated from all three sides, so
 *      that adding a value on either side without the other fails here;
 *   2. it pipes the REAL producer's output into the REAL consumer for the
 *      load-bearing case (a genuine 404) and for its inverse (a read that
 *      failed). Nothing here hardcodes "confirmed-absent" on both ends — a test
 *      that asserted the same constant twice would have passed happily
 *      throughout the entire lifetime of the bug.
 *
 * IF THIS FILE IS EVER FAILING, THE FIX IS TO MAKE THE TWO SIDES AGREE — NOT TO
 * RELAX THE ASSERTION. A red assertion here means a value is being produced that
 * the consumer will not honour, or honoured by a consumer nobody produces, and
 * either way somebody's undo is a promise the server will not keep. Widening the
 * expected set, or deleting a case, converts a caught contract break back into
 * the silent one this file exists to prevent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { deleteEvidenceBlocker, planUndo } from "../src/adt/undo.js";
import { isEnhancementType } from "../src/safety.js";
import {
  Journal,
  type BeforeImageCapture,
  type JournalBeginInput,
  type JournalConfig,
  type JournalEntry,
} from "../src/journal.js";
import { SafetyGate } from "../src/safety.js";
import { abapWrite } from "../src/tools/write.js";
import { abapJournal } from "../src/tools/journal.js";
import { T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const readSrc = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
// The vocabulary, enumerated from each of the three sides
// ---------------------------------------------------------------------------

/**
 * The consumer's verdict for each word, stated here as the contract itself.
 *
 * "accepts" = `deleteEvidenceBlocker` treats this as sufficient evidence of
 * prior absence and lets the undo DELETE the object. "blocks" = it refuses.
 * Exactly ONE word may accept; three must block. This is asserted below against
 * the real function rather than assumed, and it is deliberately not derived from
 * the source — the whole point is to state the intended contract independently
 * and then check the code against it.
 */
const EXPECTED_CLASSIFICATION: Record<BeforeImageCapture, "accepts" | "blocks"> = {
  captured: "blocks", // self-contradictory with existedBefore:false
  "confirmed-absent": "accepts", // the ONLY positive evidence of absence
  failed: "blocks", // the read blew up; absence is a guess
  unknown: "blocks", // provenance never recorded; authorises nothing
};

/** What `captureOf()` in src/tools/write.ts is allowed to emit. */
const EXPECTED_PRODUCER_EMITS = ["confirmed-absent", "failed", "captured"] as const;

const setOf = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/** Line comments carry both `;` and quoted words, so they must go first. */
const stripLineComments = (s: string) => s.replace(/\/\/[^\n]*/g, "");

/**
 * The `BeforeImageCapture` union, read out of src/journal.ts.
 *
 * The union is a TYPE, so it cannot be enumerated at runtime and there is no
 * exported list of it; `CAPTURE_VALUES` is module-private by design. Parsing the
 * declaration is therefore the only way to notice that somebody ADDED a fifth
 * word — which is exactly the change this contract has to catch, because a new
 * word means a new answer to "may undo delete this?" that no one has decided.
 *
 * `CAPTURE_VALUES` cannot silently disagree with the union it is parsed from:
 * it is declared `ReadonlySet<string>` initialised from `new Set<BeforeImage
 * Capture>([...])`, so an extra member is a compile error, and a MISSING member
 * is caught at runtime by the round-trip probe further down.
 */
function journalVocabulary(): string[] {
  const src = readSrc("src/journal.ts");
  const at = src.indexOf("export type BeforeImageCapture");
  expect(
    at,
    "src/journal.ts no longer declares `export type BeforeImageCapture` — this contract " +
      "test can no longer find the vocabulary it exists to pin. Update the parser here; " +
      "do not delete the check.",
  ).toBeGreaterThanOrEqual(0);
  const decl = stripLineComments(src.slice(at, at + 1000));
  const end = decl.indexOf(";");
  expect(end, "unterminated `BeforeImageCapture` declaration in src/journal.ts").toBeGreaterThan(0);
  const words = [...decl.slice(0, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  expect(words.length, "parsed no string literals out of the BeforeImageCapture union").toBeGreaterThan(0);
  return setOf(words);
}

/**
 * The string literals `captureOf()` can return, read out of src/tools/write.ts.
 *
 * Same reason as above: `captureOf` is module-private (it is an implementation
 * detail of `abapWrite`, and exporting it purely to test it would be the tail
 * wagging the dog), so its *behaviour* is driven end-to-end below and its
 * *alphabet* is read here. Between the two, a new emitted value cannot slip past.
 */
function producerVocabulary(): string[] {
  const src = readSrc("src/tools/write.ts");
  const at = src.indexOf("function captureOf(");
  expect(
    at,
    "src/tools/write.ts no longer contains `function captureOf(` — the producer half of " +
      "the before-image contract has moved or been renamed. Point this parser at its new " +
      "home; do not delete the check.",
  ).toBeGreaterThanOrEqual(0);
  const close = src.indexOf("\n}", at);
  expect(close, "could not find the end of captureOf() in src/tools/write.ts").toBeGreaterThan(at);
  const body = stripLineComments(src.slice(at, close));
  const returns = [...body.matchAll(/\breturn\b([^;]*);/g)].flatMap((m) =>
    [...m[1]!.matchAll(/"([^"]+)"/g)].map((q) => q[1]!),
  );
  expect(returns.length, "captureOf() appears to return no string literals at all").toBeGreaterThan(0);
  return setOf(returns);
}

// ---------------------------------------------------------------------------
// Fake ADT server — nothing is answered that a test did not ask for
// ---------------------------------------------------------------------------

const REPORT = "ZMCP_CONTRACT_REP";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_contract_rep";
const REPORT_SRC = `${REPORT_URI}/source/main`;
const PROG_COLLECTION = "/sap/bc/adt/programs/programs";

const SRC_V1 = "REPORT zmcp_contract_rep.\nWRITE: / 'contract'.\n";
/**
 * What a GET of the source returns, given the bytes that were PUT: the measured
 * appliance hands back CRLF and swallows EXACTLY ONE trailing newline — not all
 * of them (`canonicalSource`, src/adt/write.ts:653, is the production statement
 * of the same rule). This models the SERVER, so it is only ever applied on the
 * way out of the fake; the fake's stored `state.source` stays the raw PUT body.
 */
const asServer = (s: string) => s.replace(/\n$/, "").replace(/\n/g, "\r\n");

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

/**
 * `resolveWriteTarget` refuses to write an object whose package the SERVER did
 * not state, so this descriptor is load-bearing, not decoration.
 */
const OBJ_XML =
  `<adtcore:objectData xmlns:adtcore="http://www.sap.com/adt/core">` +
  `<adtcore:packageRef adtcore:name="$TMP"/></adtcore:objectData>`;

/**
 * THE 404 THIS WHOLE FILE TURNS ON. `isNotFoundError` recognises this shape, and
 * it is the only input from which `resolveWriteTarget` produces `exists: false`
 * — every other failure throws PACKAGE_UNKNOWN and never reaches a before-image.
 * So a capture value derived from this response is derived from proof of absence.
 */
const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">${REPORT} does not exist</message><properties/></exc:exception>`;

const CLEAN_CHECKRUN = `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`;

/**
 * The REAL captured bytes of `POST /datapreview/freestyle` for T000 (client 000
 * → CCCATEGORY "S", client 001 → "C"). This route is not optional: a system
 * that cannot be PROVEN non-productive is pinned to READ_ONLY *before* the
 * safety gate even runs, so without it every write below fails with READ_ONLY
 * and this file would go green-then-red for a reason that has nothing to do
 * with before-images.
 * `cfg()` logs on as client 001, so the detection reaches "nonproductive" on the
 * real appliance's own data rather than on anything stubbed out.
 *
 * Imported from ./helpers/system-role-fake.js.
 */

/**
 * An HTTP client with NO catch-all. An unrouted request throws, loudly, naming
 * the request — because a fake that answers 200 to everything is a fake that
 * hides exactly this class of defect: the original bug survived precisely
 * because every layer's stand-in said "fine" to whatever it was handed.
 */
class StrictAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: (r: Recorded) => HttpClientResponse | undefined) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body };
    this.calls.push(rec);
    const answer = this.route(rec);
    if (!answer) {
      throw new Error(
        `UNROUTED REQUEST: ${label}. This fake deliberately has no catch-all: it will not ` +
          "invent a 200 for a request no test asked for. Either the code under test grew a " +
          "new request (route it explicitly) or it is calling something it should not.",
      );
    }
    return answer;
  }
  get verbs(): string[] {
    return this.calls.map((c) => c.qs._action ?? c.method);
  }
}

/**
 * A mutable one-object server. `state.source === undefined` means the object is
 * ABSENT, and both the metadata GET and the source GET answer 404 for it — which
 * is the whole input to the create path.
 */
function fakeServer(initial?: string) {
  const state: { source?: string } = { source: initial };
  const route = (r: Recorded): HttpClientResponse | undefined => {
    // -- logon and the productive-system probe --
    if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
    if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
    if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, OK_XML);
    if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);

    // -- the object --
    if (r.url === REPORT_URI && r.method === "GET") {
      return state.source === undefined
        ? resp(404, NOT_FOUND_XML, OK_XML)
        : resp(200, OBJ_XML, OK_XML);
    }
    if (r.url === REPORT_SRC && r.method === "GET") {
      return state.source === undefined
        ? resp(404, NOT_FOUND_XML, OK_XML)
        : resp(200, asServer(state.source), { ...OK_TEXT, etag: `srv-${state.source.length}` });
    }
    if (r.url === PROG_COLLECTION && r.method === "POST") return resp(200, "", OK_TEXT);
    if (r.url === REPORT_URI && r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
    if (r.url === REPORT_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === REPORT_SRC && r.method === "PUT") {
      state.source = r.body ?? "";
      return resp(200, "", OK_TEXT);
    }
    if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
    if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
    return undefined; // → StrictAdt throws with the label
  };
  return { state, route };
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    // Required: the T000 probe classifies the LOGON client, and an unclassifiable
    // system is pinned read-only (fail closed).
    client: "001",
    readOnly: false,
  });

async function connected(
  route: (r: Recorded) => HttpClientResponse | undefined,
): Promise<{ conn: AbapConnection; adt: StrictAdt }> {
  const adt = new StrictAdt(route);
  const conn = new AbapConnection(cfg(), {
    httpClient: adt,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

/**
 * The real `Journal`, with one addition: it remembers the EXACT
 * `JournalBeginInput` it was handed. That input's `beforeCapture` is the literal
 * output of `captureOf()` — the producer's word, caught at the seam, before the
 * journal has normalised, defaulted or written anything. It is that captured
 * value, and no constant, that is fed to the real consumer below.
 */
class RecordingJournal extends Journal {
  readonly begins: JournalBeginInput[] = [];
  override async begin(input: JournalBeginInput): Promise<JournalEntry | undefined> {
    this.begins.push(input);
    return super.begin(input);
  }
}

let dir: string;
let journal: RecordingJournal;

const jcfg = (): JournalConfig => ({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "abap-bic-"));
  journal = new RecordingJournal(jcfg(), "A4H");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Permissive on purpose: this file is about provenance, not about the gate. */
const openGate = (): SafetyGate => new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

const writeVia = (conn: AbapConnection, source: string) =>
  abapWrite(
    conn,
    { object: REPORT, type: "PROG/P", source } as never,
    60_000,
    openGate(),
    journal,
  );

/** A journal entry wearing one specific capture word, for the consumer probe. */
const withCapture = (entry: JournalEntry, capture: string): JournalEntry =>
  ({ ...entry, beforeCapture: capture }) as JournalEntry;

// ---------------------------------------------------------------------------
// 1. ONE vocabulary, three sides
// ---------------------------------------------------------------------------

describe("the three modules share ONE vocabulary", () => {
  it("the journal's union is exactly the set this contract classifies", () => {
    const vocabulary = journalVocabulary();
    expect(
      vocabulary,
      "src/journal.ts's `BeforeImageCapture` union changed. Every word in it is an answer " +
        "to 'may undo DELETE this object?', so a new one is a decision, not a detail: give " +
        "it a verdict in EXPECTED_CLASSIFICATION here, a branch in `captureExplanation()` " +
        "in src/adt/undo.ts, and check whether `captureOf()` should ever emit it.",
    ).toEqual(setOf(Object.keys(EXPECTED_CLASSIFICATION)));
    // Exactly one word may authorise a delete. If this ever reads 2, an undo can
    // destroy source on evidence somebody widened without saying so.
    expect(Object.values(EXPECTED_CLASSIFICATION).filter((v) => v === "accepts")).toEqual([
      "accepts",
    ]);
  });

  it("every word the journal knows survives a real write-and-read round trip", async () => {
    // The middle module, pinned from the outside: `CAPTURE_VALUES` and
    // `normaliseCapture()` are private, but their effect is observable — a legal
    // word comes back unchanged, and anything else degrades to "unknown", the
    // word that authorises nothing. A word dropped from `CAPTURE_VALUES` would
    // silently become "unknown" on the way back off disk, i.e. an undo the
    // producer intended to permit would be refused. That is the original bug
    // again, one module further along.
    for (const word of journalVocabulary()) {
      const begun = await journal.begin({
        operation: "create",
        object: { name: REPORT, type: "PROG/P", uri: REPORT_URI, package: "$TMP" },
        existedBefore: false,
        beforeCapture: word as BeforeImageCapture,
      });
      const readBack = await journal.get(begun!.id);
      expect(readBack?.beforeCapture, `the journal did not round-trip "${word}"`).toBe(word);
    }

    const junk = await journal.begin({
      operation: "create",
      object: { name: REPORT, type: "PROG/P", uri: REPORT_URI, package: "$TMP" },
      existedBefore: false,
      beforeCapture: "definitely-not-a-capture-value" as BeforeImageCapture,
    });
    expect((await journal.get(junk!.id))?.beforeCapture).toBe("unknown");
  });

  it("the producer emits only words from that set, and never `unknown`", () => {
    const vocabulary = journalVocabulary();
    const emitted = producerVocabulary();

    // Meet-in-the-middle, the direction that broke: nothing may be emitted that
    // the rest of the system has no meaning for.
    for (const word of emitted) {
      expect(vocabulary, `captureOf() emits "${word}", which is not a BeforeImageCapture`).toContain(
        word,
      );
    }
    expect(
      emitted,
      "the set of words `captureOf()` in src/tools/write.ts can emit changed. Check each " +
        "one against EXPECTED_CLASSIFICATION below: a word classified 'blocks' means every " +
        "undo of a write that produced it is refused, however loudly abap_write's own " +
        "response promises otherwise.",
    ).toEqual(setOf(EXPECTED_PRODUCER_EMITS));

    // The regression, stated as a set. "unknown" is the journal's degrade-to
    // value — the word that means "we did not record how we knew" — and no
    // producer may ever assert it deliberately. `captureOf` returning it for a
    // created object is precisely the defect this file exists for.
    expect(
      emitted,
      'captureOf() can emit "unknown", the one word that authorises nothing. This is the ' +
        "original defect: an object created off a genuine 404 would be recorded as having " +
        "unrecorded provenance, and its undo would be refused forever while abap_write kept " +
        'telling the user "This object did not exist before, so undo DELETES it."',
    ).not.toContain("unknown");
  });

  it("the consumer's verdict on every word is exactly the classification above", async () => {
    // The consumer half, driven through the REAL `deleteEvidenceBlocker`. The
    // entry is a create (`existedBefore: false`) throughout, because that is the
    // only shape for which the delete-evidence question even arises — for an
    // update or a delete the blocker returns early and the vocabulary never
    // comes into it.
    const base: JournalEntry = {
      id: "20260801T120000000Z-abcdef",
      ts: new Date().toISOString(),
      system: "A4H",
      operation: "create",
      object: { name: REPORT, type: "PROG/P", uri: REPORT_URI, package: "$TMP" },
      existedBefore: false,
      beforeCapture: "unknown",
      outcome: "succeeded",
    };

    const messages = new Map<string, string>();
    for (const word of journalVocabulary()) {
      const verdict = EXPECTED_CLASSIFICATION[word as BeforeImageCapture];
      expect(
        verdict,
        `"${word}" is in BeforeImageCapture but this contract test does not classify it`,
      ).toBeDefined();

      const blocker = deleteEvidenceBlocker(withCapture(base, word));
      if (verdict === "accepts") {
        expect(
          blocker,
          `deleteEvidenceBlocker REFUSED "${word}", which the contract says is sufficient ` +
            "evidence of prior absence. Either the consumer stopped honouring the one word " +
            "the producer can prove, or the contract changed and nobody told the producer.",
        ).toBeUndefined();
      } else {
        expect(
          blocker,
          `deleteEvidenceBlocker ACCEPTED "${word}" as evidence the object was absent. It is ` +
            "not evidence of anything, and an undo acting on it deletes source abapsmith never " +
            "read and cannot put back.",
        ).toBeDefined();
        // The refusal must name the word and explain it, not merely say no: a
        // generic message would mean the consumer does not actually recognise
        // the vocabulary, it only fails to match one string.
        expect(blocker).toContain(`beforeCapture="${word}"`);
        expect(blocker).toMatch(/cannot be overridden/);
        messages.set(word, blocker!);
      }
    }

    // One distinct explanation per blocked word — `captureExplanation()` in
    // src/adt/undo.ts is a switch over the union, so a word added there without
    // a branch fails to compile in src/, and a word that shares another's text
    // fails here.
    expect(setOf(messages.values()).length).toBe(messages.size);
  });
});

// ---------------------------------------------------------------------------
// 2. The load-bearing case: producer output → consumer input, end to end
// ---------------------------------------------------------------------------

describe("a genuine 404 produces a word the undo path accepts", () => {
  /**
   * THE TEST. Everything above is bookkeeping around this one.
   *
   * The write is real: the real `abapWrite`, the real `authorizeMutation` /
   * `resolveWriteTarget` / `writeObject`, the real `Journal`, over a connection
   * whose metadata GET answers a genuine ADT 404. The word `captureOf()` hands
   * to `journal.begin()` is caught at that seam and fed, unmodified, into the
   * real `deleteEvidenceBlocker`. Neither end is a literal in this test.
   */
  it("pipes captureOf()'s output straight into deleteEvidenceBlocker, which accepts it", async () => {
    const srv = fakeServer(undefined); // absent: the metadata GET 404s
    const { conn } = await connected(srv.route);

    const res = await writeVia(conn, SRC_V1);

    // The producer's word, as handed to the journal. Not read back off disk, not
    // re-derived — the actual argument.
    expect(journal.begins).toHaveLength(1);
    const produced = journal.begins[0]!.beforeCapture;
    expect(journal.begins[0]!.existedBefore).toBe(false);
    expect(
      produced,
      "captureOf() recorded no provenance at all for a create. `journal.begin()` then " +
        'derives "unknown" for a bare `existedBefore: false`, and the undo is refused.',
    ).toBeDefined();

    // The seam. If this refuses, abap_write has just promised the user an undo
    // that the undo path will never perform.
    const recorded = (await journal.list())[0]!;
    const blocker = deleteEvidenceBlocker(withCapture(recorded, produced!));
    expect(
      blocker,
      `captureOf() produced "${produced}" for an object proven absent by a 404, and ` +
        "deleteEvidenceBlocker refuses that word. The two halves of the write/undo system " +
        "disagree: abap_write's response promises the user 'undo DELETES it', and undo will " +
        "answer BAD_INPUT forever. Make the two sides agree — do not relax this assertion.",
    ).toBeUndefined();

    // …and the same word survived the journal, so the entry ON DISK is undoable
    // too. (Producer → journal → consumer is the whole chain; checking only the
    // in-memory hop would miss a word that `normaliseCapture` degrades.)
    expect(recorded.beforeCapture).toBe(produced);
    expect(deleteEvidenceBlocker(recorded)).toBeUndefined();

    // The promise this contract is measured against, from abap_write's own
    // output. It is only true if everything above holds.
    expect(res.text).toMatch(/did not exist before, so undo DELETES it/);

    // And the same verdict reached through the real planner rather than the
    // blocker alone, proving the gate is actually wired into the undo path.
    const plan = await planUndo(conn, journal, recorded);
    expect(plan.action).toBe("delete");
    expect(plan.blocker).toBeUndefined();
    expect(plan.undoable).toBe(true);
  });

  it("names the word, so a regression says WHICH value broke the seam", async () => {
    // Deliberately separate from the assertion above, and deliberately last of
    // the two: the test that matters is "the consumer accepts what the producer
    // emits", and this one only records what that value is today. If they ever
    // disagree, the failure above explains the breakage and this one names it.
    const srv = fakeServer(undefined);
    const { conn } = await connected(srv.route);
    await writeVia(conn, SRC_V1);
    expect(journal.begins[0]!.beforeCapture).toBe("confirmed-absent");
  });

  it("an object that DID exist is recorded as captured, and its undo restores rather than deletes", async () => {
    // The other side of the producer's branch, driven the same way. `captured`
    // is classified "blocks" above, and that is not a contradiction: with
    // `existedBefore: true` the blocker never asks the question, because undoing
    // an update restores text and removes nothing.
    const srv = fakeServer(SRC_V1);
    const { conn } = await connected(srv.route);

    await writeVia(conn, SRC_V1.replace("contract", "contract v2"));

    const produced = journal.begins[0]!.beforeCapture;
    expect(produced).toBe("captured");
    const recorded = (await journal.list())[0]!;
    expect(recorded.existedBefore).toBe(true);
    expect(recorded.beforeCapture).toBe(produced);
    expect(deleteEvidenceBlocker(recorded)).toBeUndefined();
    expect((await planUndo(conn, journal, recorded)).action).toBe("restore");
  });
});

// ---------------------------------------------------------------------------
// 3. The inverse: an unread before-image must never authorise a delete
// ---------------------------------------------------------------------------

describe('"failed" — an unread before-image authorises nothing', () => {
  /**
   * The asymmetry that justifies the whole gate: a wrong RESTORE overwrites
   * source abapsmith is holding a copy of; a wrong DELETE destroys source nobody
   * holds a copy of. `existedBefore: false` is produced just as readily by a
   * timeout or a 500 as by a real 404, and "failed" is the word that says so.
   */
  it("deleteEvidenceBlocker REJECTS a failed capture and blames the failed read", async () => {
    const srv = fakeServer(undefined);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, SRC_V1);

    // The bytes as they stand on the server after the create, whatever they are.
    // Recorded, not modelled: "nothing was touched" is byte-identity against the
    // state the undo attempt started from, and re-spelling the server's own
    // canonicalisation here would only give this test a second opinion about a
    // rule it is not the place to state.
    const untouched = srv.state.source;
    expect(untouched, "the create did not land, so there is nothing to prove untouched").toBeDefined();

    // The same entry the accepted case above produced, with the one field
    // changed: provenance the producer could not vouch for.
    const entry = withCapture((await journal.list())[0]!, "failed");

    adt.calls.length = 0;
    const blocker = deleteEvidenceBlocker(entry);
    expect(
      blocker,
      'deleteEvidenceBlocker accepted "failed" as evidence of prior absence. It is the ' +
        "opposite: it records that the before-image probe never established absence — it may " +
        "never have completed, or it may have answered inconclusively. Undo would DELETE an " +
        "object whose source was never read.",
    ).toBeDefined();
    expect(blocker).toContain('beforeCapture="failed"');
    // "failed" covers BOTH "the probe never completed" AND "the probe
    // answered and was inconclusive" — it must not be read as proof a
    // transport error occurred.
    expect(blocker).toMatch(/did not yield usable evidence/);
    expect(blocker).not.toMatch(/read FAILED at write time|never succeeded/);
    expect(blocker).toMatch(/cannot be overridden/);

    // Decided from the journal alone — a refusal must not cost a request.
    const plan = await planUndo(conn, journal, entry);
    expect(plan.undoable).toBe(false);
    expect(plan.blocker).toBe(blocker);
    expect(adt.calls).toHaveLength(0);
    expect(srv.state.source, "the refused undo modified the object anyway").toBe(untouched);
  });

  it('"unknown" — the pre-provenance word — is rejected just as hard', async () => {
    const srv = fakeServer(undefined);
    const { conn } = await connected(srv.route);
    await writeVia(conn, SRC_V1);

    const blocker = deleteEvidenceBlocker(withCapture((await journal.list())[0]!, "unknown"));
    expect(blocker).toBeDefined();
    expect(blocker).toContain('beforeCapture="unknown"');
    // This is the word the producer used to emit for a create. Its meaning on
    // the consumer side has not changed and must not: the fix for the original
    // bug was to stop producing it here, never to start accepting it there.
    expect(blocker).toMatch(/does not record how/);
  });

  it('mode=show\'s provenance note for "failed" admits the inconclusive case, not just a transport failure', async () => {
    const srv = fakeServer(undefined);
    const { conn } = await connected(srv.route);

    const begun = await journal.begin({
      operation: "create",
      object: { name: REPORT, type: "PROG/P", uri: REPORT_URI, package: "$TMP" },
      existedBefore: false,
      beforeCapture: "failed",
    });
    await journal.finish(begun!.id, { outcome: "succeeded" });

    const shown = await abapJournal(conn, { mode: "show", entry: begun!.id }, 60_000, journal);
    expect(shown.text).toContain('beforeCapture="failed"');
    expect(shown.text).toMatch(/never completed or came back inconclusive/);
    expect(shown.text).not.toMatch(/read FAILED|the read blew up|never succeeded/);
  });
});

// ---------------------------------------------------------------------------
// 4. enhancement-write.ts: structurally exempt, not just
//    coincidentally green
// ---------------------------------------------------------------------------

/**
 * `enhancement-write.ts` (LOCK->PUT->UNLOCK for EXISTING ENHO/XH,
 * ENHO/XHH, ENHS/XS objects) does not touch the journal at all — it exposes a
 * raw `onBeforeImage` hook but calls neither `journal.begin()` nor anything
 * that would produce a `BeforeImageCapture` string. That is the tool layer's
 * job, and it is now done: `src/tools/enh.ts` and
 * `src/tools/v2/handlers/do/enhancements.ts` both pass a hook built by
 * `withJournalledMutation()` (src/journal.ts), which begins the entry with a
 * hard-coded `beforeCapture: "captured"` and `existedBefore: true` — see the
 * "by CONSTRUCTION" paragraph below for why those two are the only values this
 * module can ever justify. So this file's producer-vs-consumer seam still has
 * NOTHING VARIABLE to pipe through here, and the two describe blocks above
 * are correctly silent about it.
 *
 * There IS one real, load-bearing invariant worth pinning now, though, and it
 * is worth stating exactly WHY it is exempt rather than merely asserting it:
 *
 * The entire reason `BeforeImageCapture` needs FOUR words instead of a boolean
 * is to let `deleteEvidenceBlocker` distinguish "we positively proved this was
 * absent" (confirmed-absent) from "our read of it failed, so we are only
 * GUESSING it was absent" (failed / unknown) — a distinction that only matters
 * for a CREATE, because only a create's undo can DELETE anything.
 * `enhancement-write.ts` has no create path anywhere: `writeEnhancementDescription`
 * calls `spec.read(conn, target.name)` unconditionally as its first step and
 * lets a NOT_FOUND propagate rather than ever constructing a new object (see
 * its own module header: "creating a NEW enhancement object is OUT of
 * scope"). So for every write this module could ever produce a journal
 * entry for, the object existed before by CONSTRUCTION — `existedBefore` would
 * be unconditionally `true` — and `deleteEvidenceBlocker`'s very first line
 * (`if (entry.operation === "delete" || entry.existedBefore) return
 * undefined;`) exits before it ever inspects `beforeCapture` at all. The
 * delete-evidence question — the one this whole file is about — is
 * structurally inapplicable to this module's writes: undo of an
 * enhancement-description change is always a RESTORE, never a DELETE.
 *
 * IMPORTANT, and asserted honestly below rather than glossed over:
 * `deleteEvidenceBlocker` returning `undefined` is NOT the same as `planUndo`
 * returning `undoable: true`. `src/adt/undo.ts`'s `undoBlocker()` refuses undo
 * of ANY enhancement-type journal entry UNCONDITIONALLY — regardless of
 * `existedBefore` — for independent, well-documented reasons (live-A4H-session
 * hazards: a server-refused create can leave a permanently
 * undeletable phantom object; a server-reported-successful delete can leave
 * TADIR/E071 residue with no 404 to prove removal; `tp` misconfiguration can
 * make a transportable create permanently undeletable through ADT). In
 * `planUndo`, the check order is `systemMismatchBlocker(...) ??
 * undoBlocker(entry) ?? deleteEvidenceBlocker(entry)` — since `undoBlocker`
 * ALWAYS returns truthy for an enhancement-type entry, `deleteEvidenceBlocker`
 * is NEVER REACHED by `planUndo` for one. So `plannedAction(entry)` correctly
 * says `"restore"` (that part of this file's reasoning holds), but the plan's
 * `undoable` is `false`, blocked by the SEPARATE, unrelated enhancement-undo
 * refusal — not by anything about delete-evidence. Both facts are asserted
 * below, honestly, rather than only the flattering half.
 *
 * NOT A PERMANENT LAW about enhancement objects in general — only about this
 * module's existing-object-only writes. If a future change ever adds a create
 * path for an enhancement object, a `BeforeImageCapture` word will need to flow through
 * it, `existedBefore` will no longer be unconditionally `true`, and this
 * exemption stops holding — this block must be revisited at that point, not
 * treated as settled.
 */
describe("enhancement writes are structurally exempt from the delete-evidence question", () => {
  it('enhancement-write.ts never emits "confirmed-absent" — it has no create path to prove absence for', () => {
    // Mechanical, not a claim about behaviour: the string simply does not
    // appear in the module's source at all. Same readSrc()-based style as
    // journalVocabulary()/producerVocabulary() above, deliberately NOT
    // reusing those two (they parse a specific union/function; this is a
    // plain substring check against a module that is not a producer yet).
    const src = readSrc("src/adt/enhancement-write.ts");
    expect(
      src,
      'src/adt/enhancement-write.ts now contains the string "confirmed-absent". If this is ' +
        "because a create path was added, this whole describe block's " +
        "reasoning no longer holds and must be revisited, not just this one assertion.",
    ).not.toContain("confirmed-absent");
  });

  it("deleteEvidenceBlocker exits on existedBefore:true before it even looks at beforeCapture, for every capture word", () => {
    // A hypothetical entry shaped like what a future enhancement write WILL
    // eventually produce: existedBefore:true (this module never creates),
    // object.type one of the three enhancement types. `withCapture`/`base` are this
    // file's own existing helpers (line 377 / 467) — reused, not
    // reimplemented, per this file's own convention.
    const enhancementBase: JournalEntry = {
      id: "20260806T090000000Z-badi01",
      ts: new Date().toISOString(),
      system: "A4H",
      operation: "update",
      object: {
        name: "ZMCP_ENH_B",
        type: "ENHO/XHH",
        uri: "/sap/bc/adt/enhancements/enhoxhh/ZMCP_ENH_B",
        package: "$TMP",
      },
      existedBefore: true,
      beforeCapture: "unknown",
      outcome: "succeeded",
    };
    expect(isEnhancementType(enhancementBase.object.type)).toBe(true);

    // Every word in the vocabulary, not just the default — proving the exit
    // is unconditional on `existedBefore`, not a coincidence of one value.
    for (const word of journalVocabulary()) {
      const blocker = deleteEvidenceBlocker(withCapture(enhancementBase, word));
      expect(
        blocker,
        `deleteEvidenceBlocker inspected beforeCapture="${word}" for an entry with ` +
          "existedBefore:true. It must exit on the existedBefore check before ever reaching " +
          "the capture comparison — undo of an existing-object write is a restore, never a " +
          "delete, so the delete-evidence question does not arise.",
      ).toBeUndefined();
    }
  });

  it("planUndo: action is correctly 'restore', but undoable is false — blocked by the SEPARATE unconditional enhancement-undo refusal, not by delete-evidence", async () => {
    // This test exists specifically to prevent the flattering half-truth: it
    // would be easy (and wrong) to read "deleteEvidenceBlocker says fine" as
    // "planUndo says fine". It does not. src/adt/undo.ts's `undoBlocker()`
    // (module-private, exercised here only through planUndo, which is the
    // real call site) refuses ALL enhancement-type entries before
    // `deleteEvidenceBlocker` is ever consulted — see this describe block's
    // header comment for the full reasoning.
    const srv = fakeServer(undefined);
    const { conn, adt } = await connected(srv.route);
    adt.calls.length = 0;

    const entry: JournalEntry = {
      id: "20260806T090000000Z-badi02",
      ts: new Date().toISOString(),
      system: "A4H",
      operation: "update",
      object: {
        name: "ZMCP_ENH_B",
        type: "ENHO/XHH",
        uri: "/sap/bc/adt/enhancements/enhoxhh/ZMCP_ENH_B",
        package: "$TMP",
      },
      existedBefore: true,
      beforeCapture: "captured",
      outcome: "succeeded",
    };

    // The delete-evidence question genuinely does not arise here — confirmed
    // directly, independent of planUndo, so a failure below cannot be
    // misread as "well, AT LEAST delete-evidence caught it".
    expect(deleteEvidenceBlocker(entry)).toBeUndefined();

    const plan = await planUndo(conn, journal, entry);

    // `plannedAction` reads `existedBefore` alone and is correct in isolation.
    expect(plan.action).toBe("restore");
    // But the plan is NOT undoable — refused by the independent, unconditional
    // enhancement-undo policy, decided before any request (adt.calls stays 0).
    expect(plan.undoable).toBe(false);
    expect(plan.blocker).toBeDefined();
    expect(adt.calls).toHaveLength(0);

    // The blocker text must be the enhancement-undo refusal, NOT the
    // delete-evidence message — the two are unrelated, and this is the one
    // assertion that would fail if a future refactor accidentally merged or
    // reordered the two checks.
    expect(plan.blocker).toMatch(/Undo of enhancement objects is refused outright/);
    expect(plan.blocker).not.toMatch(/positive evidence/);
    expect(plan.blocker).not.toContain("beforeCapture=");
  });
});
