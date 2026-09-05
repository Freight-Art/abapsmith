/**
 * Secondary-index (`TABL/DI`) create/delete bridge — pure unit tests except
 * §14, which drives a fake `HttpClient` transport (the only network-touching
 * part of this file) to pin the bridge-refresh behaviour; everything else is
 * ZERO network. `./view-create.test.ts`/`./view-delete.test.ts` already cover
 * the fake-transport happy path for this bridge family; this file only
 * exercises `src/adt/index-create.ts` itself:
 *
 *  1. generator/parser drift — every tag either fragment writes is one
 *     `parseDdicTranscript` recognises;
 *  2. transport pairing — `$TMP` emits `no_transp_request`, never
 *     `transport_number`, and vice versa for a transportable package;
 *  3. the `unique` flag — emitted only when explicitly `true`;
 *  4. the field list — one `APPEND VALUE #( name = '<F>' )` per field, in
 *     order, component spelled `name`;
 *  5. `DD17V`/`DD17L` never appear anywhere in generated ABAP — neither table
 *     was ever probed live, so the generator sticks to `DD17S`, the field
 *     table the live probe actually read;
 *  6. `assertSecondaryIndexTarget` — zero-network, reached before any gate
 *     or request;
 *  7. validation refusals (index-name length, empty/too-long field list,
 *     over-long field name);
 *  8. `indexBridgeErrorHook` — every `DD_INDEX_EXCEPTIONS` entry maps its own
 *     `sy-subrc`, and the "does not exist" transcript maps to `NOT_FOUND`;
 *  9. `indexGateName`'s embedding of the base table into the gated name;
 * 10. `indexDeleteFragment`'s `TABLES index_fields = lt_fields` clause,
 *     positioned between IMPORTING and EXCEPTIONS — its 2026-09-05 live
 *     omission was rejected with "the mandatory parameter INDEX_FIELDS was
 *     not filled";
 * 11. the unique-index client-field guard — emitted only when `unique: true`,
 *     absent on the plain path already proven live (must not regress);
 * 12. `indexBridgeErrorHook` mapping the client-field guard's transcript line
 *     to `BAD_INPUT`;
 * 13. both fragments' ACTFAILED branches disclosing an unfiltered DD12V row
 *     count, since `DD_INDEX_INTERFACE` exports no activation log;
 * 14. `indexDeleteFragment`'s ACTFAILED-tolerant read-back (fix 3, live
 *     2026-09-05 round 2) — the post-commit DD12V/DD17S read-back decides,
 *     not ACTFAILED, so a delete that actually worked is reported success
 *     instead of CHECK_FAILED;
 * 15. the bridge-refresh pin — a stale (pre-fix) server-side bridge class
 *     body still gets PUT over with the current generated body, rather than
 *     skipped as unchanged.
 * 16. worst-case assembled-source line length — longest legal names, largest
 *     legal field list, through `ddicBridgeSource` — stays within
 *     `ABAP_SOURCE_LINE_MAX` (fix 4, the class-source PUT rejecting a >255-char
 *     line before `DD_INDEX_INTERFACE` was ever called, live 2026-09-05 round 3).
 */
import { describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import {
  ABAP_SOURCE_LINE_MAX,
  DDIC_BRIDGE_CLASS,
  DDIC_BRIDGE_PACKAGE,
  DDIC_ERR_PREFIX,
  DDIC_NOTE_PREFIX,
  DDIC_TAGS,
  assertDdicTranscript,
  ddicBridgeSource,
  parseDdicTranscript,
  type DdicTag,
  type DdicTranscript,
} from "../src/adt/ddic-bridge.js";
import {
  DD_INDEX_EXCEPTIONS,
  INDEX_DATA_LINES,
  INDEX_DELETE_DATA_LINES,
  INDEX_FIELD_NAME_MAX,
  INDEX_NAME_MAX,
  MAX_INDEX_FIELDS,
  assertSecondaryIndexTarget,
  createSecondaryIndex,
  deleteSecondaryIndexViaBridge,
  indexBridgeErrorHook,
  indexDeleteFragment,
  indexGateName,
  secondaryIndexFragment,
  type IndexDeleteParams,
  type SecondaryIndexParams,
} from "../src/adt/index-create.js";
import { serverPackage, type ServerPackage } from "../src/adt/resolved-package.js";
import type { VerifyOutcome } from "../src/adt/write-verify.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A syntactically valid TRKORR — the shape `isTrkorr` (src/adt/transports.ts) accepts. */
const CORR_NR = "A4HK900121";

/** Mints a `ServerPackage` the only legal way — see test/view-delete.test.ts's `confirmedOutcome`/`SERVER_PKG`. */
function pkg(name: string): ServerPackage {
  const outcome: VerifyOutcome = {
    status: "confirmed",
    uri: "/sap/bc/adt/ddic/tables/ZTMD_I28_T",
    via: "vit-bridge",
    packageName: name,
  };
  const p = serverPackage(outcome);
  if (!p) throw new Error("test fixture: serverPackage unexpectedly undefined");
  return p;
}

const INDEX: SecondaryIndexParams = {
  indexName: "Z01",
  baseTable: "ZTMD_I28_T",
  fields: ["CARRIER"],
  description: "probe idx",
  packageName: pkg("ZTM"),
  corrNr: CORR_NR,
};
const LOCAL_INDEX: SecondaryIndexParams = { ...INDEX, packageName: pkg("$TMP"), corrNr: undefined };

/** `DD12V-SQLTAB`/`TABNAME` is CHAR30 — mirrors src/adt/index-create.ts's own (un-exported) BASE_TABLE_MAX. */
const BASE_TABLE_MAX = 30;

/** Longest legal name at each limit — starts with a letter, as `isValidAbapIdentifier` requires. */
const MAX_INDEX_NAME = "A".repeat(INDEX_NAME_MAX);
const MAX_BASE_TABLE = "T".repeat(BASE_TABLE_MAX);
const MAX_FIELD_NAME = "F".repeat(INDEX_FIELD_NAME_MAX);
const MAX_FIELDS = Array.from({ length: MAX_INDEX_FIELDS }, () => MAX_FIELD_NAME);

const WORST_CASE_INDEX = {
  indexName: MAX_INDEX_NAME,
  baseTable: MAX_BASE_TABLE,
  fields: MAX_FIELDS,
  description: "worst-case description",
  packageName: { name: "$TMP" },
} as unknown as SecondaryIndexParams;

const WORST_CASE_DELETE = {
  indexName: MAX_INDEX_NAME,
  baseTable: MAX_BASE_TABLE,
  packageName: { name: "$TMP" },
} as unknown as IndexDeleteParams;

const DELETE_INDEX: IndexDeleteParams = {
  indexName: "Z01",
  baseTable: "ZTMD_I28_T",
  packageName: pkg("ZTM"),
  corrNr: CORR_NR,
};
const LOCAL_DELETE_INDEX: IndexDeleteParams = { ...DELETE_INDEX, packageName: pkg("$TMP"), corrNr: undefined };

/** A null connection IS the assertion: any code path reaching the wire before refusing throws a TypeError instead of the BAD_INPUT/TRANSPORT_ERROR these tests expect — same device as ./view-create.test.ts's `offline`. */
const offline = null as unknown as AbapConnection;

const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP", "ZTM"],
    allowTransports: ["auto", CORR_NR],
    writesLockedOut: false,
  });

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

/** Every `out->write( 'TAG' )` a fragment emits, in emission order. */
function emittedTags(lines: readonly string[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    const m = /^out->write\( '([^']*)' \)\.$/.exec(line.trim());
    if (m?.[1] !== undefined) found.push(m[1]);
  }
  return found;
}

/**
 * Extracts the code-controlled `*_FM_WHAT` text `subrcGuardFragment` embedded
 * in a fragment's own interpolated error line — derived from the fragment's
 * real output, never hand-typed, so it can't silently diverge from what
 * `indexBridgeErrorHook` actually matches against.
 */
function fmWhatFromFragment(lines: readonly string[]): string {
  const line = lines.find((l) => l.includes("failed, sy-subrc={ sy-subrc }"));
  if (!line) throw new Error("no subrc-guard error line found in fragment");
  const m = /\|ZMCP-DDIC-ERR> (.+) failed, sy-subrc=\{ sy-subrc \}/.exec(line);
  if (!m?.[1]) throw new Error(`could not extract FM_WHAT from: ${line}`);
  return m[1];
}

const CREATE_WHAT = fmWhatFromFragment(secondaryIndexFragment(INDEX));
const DELETE_WHAT = fmWhatFromFragment(indexDeleteFragment(DELETE_INDEX));

/**
 * A delete-fragment message is built into `lv_msg` across several short
 * `lv_msg = ...`/`lv_msg = lv_msg && ...` lines and written once (fix 4: one
 * long interpolated line pushed the assembled class source over 255 chars,
 * live 2026-09-05 round 3) — finds the block from its first line through the
 * `out->write( lv_msg )` that follows, so callers can assert on the joined text.
 */
function lvMsgBlock(
  lines: readonly string[],
  startsAt: (l: string) => boolean,
): { text: string; endIdx: number } {
  const start = lines.findIndex(startsAt);
  if (start < 0) throw new Error("no lv_msg block start found");
  const endIdx = lines.findIndex((l, i) => i > start && l.trim() === "out->write( lv_msg ).");
  if (endIdx < 0) throw new Error("no out->write( lv_msg ) found after block start");
  return { text: lines.slice(start, endIdx + 1).join(""), endIdx };
}

// ---------------------------------------------------------------------------
// 1 — generator/parser drift
// ---------------------------------------------------------------------------

describe("generator/parser drift", () => {
  it("secondaryIndexFragment emits exactly the tag set createSecondaryIndex expects", () => {
    const tags = emittedTags(secondaryIndexFragment(INDEX));
    expect(new Set(tags)).toEqual(new Set(["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"]));
    expect(tags).toEqual(["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"]);
  });

  it("secondaryIndexFragment emits the same tag set for $TMP", () => {
    const tags = emittedTags(secondaryIndexFragment(LOCAL_INDEX));
    expect(new Set(tags)).toEqual(new Set(["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"]));
  });

  it("indexDeleteFragment emits exactly the tag set deleteSecondaryIndexViaBridge expects", () => {
    const tags = emittedTags(indexDeleteFragment(DELETE_INDEX));
    // expectTags itself, from deleteSecondaryIndexViaBridge — every one must still fire, in
    // whatever sequence the fragment now emits it in.
    for (const tag of ["INDEX-DELETED", "INDEX-GONE"]) expect(tags).toContain(tag);
    expect(tags).toEqual(["INDEX-DELETED-ACTFAILED", "INDEX-DELETED", "INDEX-GONE"]);
  });

  it("indexDeleteFragment emits the same tag set for $TMP", () => {
    const tags = emittedTags(indexDeleteFragment(LOCAL_DELETE_INDEX));
    for (const tag of ["INDEX-DELETED", "INDEX-GONE"]) expect(tags).toContain(tag);
    expect(tags).toEqual(["INDEX-DELETED-ACTFAILED", "INDEX-DELETED", "INDEX-GONE"]);
  });

  it("every tag either fragment writes is one parseDdicTranscript recognises", () => {
    for (const lines of [
      secondaryIndexFragment(INDEX),
      secondaryIndexFragment(LOCAL_INDEX),
      indexDeleteFragment(DELETE_INDEX),
      indexDeleteFragment(LOCAL_DELETE_INDEX),
    ]) {
      const tags = emittedTags(lines);
      expect(tags.length).toBeGreaterThan(0);
      const parsed = parseDdicTranscript(tags.join("\n"));
      expect(parsed.tags).toEqual(tags);
      expect(parsed.errorLine).toBeUndefined();
      for (const tag of tags) expect(DDIC_TAGS).toContain(tag as DdicTag);
    }
  });

  it("assertDdicTranscript is satisfied by each fragment's own success output", () => {
    const created = emittedTags(secondaryIndexFragment(INDEX));
    expect(() =>
      assertDdicTranscript(parseDdicTranscript(created.join("\n")), created as DdicTag[], "Creating secondary index"),
    ).not.toThrow();

    const deleted = emittedTags(indexDeleteFragment(DELETE_INDEX));
    expect(() =>
      assertDdicTranscript(parseDdicTranscript(deleted.join("\n")), deleted as DdicTag[], "Deleting secondary index"),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2 — transport pairing
// ---------------------------------------------------------------------------

describe("transport pairing", () => {
  it("secondaryIndexFragment: $TMP emits no_transp_request='X' and never transport_number", () => {
    const lines = secondaryIndexFragment(LOCAL_INDEX);
    expect(lines.some((l) => l.includes("no_transp_request") && l.includes("'X'"))).toBe(true);
    expect(lines.some((l) => l.includes("transport_number"))).toBe(false);
  });

  it(`secondaryIndexFragment: a transportable package emits transport_number='${CORR_NR}' and never no_transp_request`, () => {
    const lines = secondaryIndexFragment(INDEX);
    expect(lines.some((l) => l.includes("transport_number") && l.includes(`'${CORR_NR}'`))).toBe(true);
    expect(lines.some((l) => l.includes("no_transp_request"))).toBe(false);
  });

  it("indexDeleteFragment: $TMP emits no_transp_request='X' and never transport_number", () => {
    const lines = indexDeleteFragment(LOCAL_DELETE_INDEX);
    expect(lines.some((l) => l.includes("no_transp_request") && l.includes("'X'"))).toBe(true);
    expect(lines.some((l) => l.includes("transport_number"))).toBe(false);
  });

  it(`indexDeleteFragment: a transportable package emits transport_number='${CORR_NR}' and never no_transp_request`, () => {
    const lines = indexDeleteFragment(DELETE_INDEX);
    expect(lines.some((l) => l.includes("transport_number") && l.includes(`'${CORR_NR}'`))).toBe(true);
    expect(lines.some((l) => l.includes("no_transp_request"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3 — unique flag
// ---------------------------------------------------------------------------

describe("unique flag", () => {
  it("unique: true emits unique = 'X'", () => {
    const lines = secondaryIndexFragment({ ...INDEX, unique: true });
    expect(lines.some((l) => /^\s*unique\s*=\s*'X'/.test(l))).toBe(true);
  });

  it("unique omitted emits no unique= line at all", () => {
    const lines = secondaryIndexFragment(INDEX);
    expect(lines.some((l) => /^\s*unique\s*=/.test(l))).toBe(false);
  });

  it("unique: false emits no unique= line at all", () => {
    const lines = secondaryIndexFragment({ ...INDEX, unique: false });
    expect(lines.some((l) => /^\s*unique\s*=/.test(l))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4 — field list
// ---------------------------------------------------------------------------

describe("field list", () => {
  it("one APPEND VALUE #( name = '<F>' ) per field, in caller order, component spelled name", () => {
    const lines = secondaryIndexFragment({ ...INDEX, fields: ["MANDT", "CARRIER", "CONNID"] });
    const appends = lines.filter((l) => l.startsWith("APPEND VALUE #("));
    expect(appends).toEqual([
      "APPEND VALUE #( name = 'MANDT' ) TO lt_fields.",
      "APPEND VALUE #( name = 'CARRIER' ) TO lt_fields.",
      "APPEND VALUE #( name = 'CONNID' ) TO lt_fields.",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5 — DD17V/DD17L must never appear
// ---------------------------------------------------------------------------

describe("DD17V/DD17L never appear in generated ABAP (never probed live — only DD17S was)", () => {
  it("secondaryIndexFragment never mentions dd17v or dd17l", () => {
    const text = secondaryIndexFragment(INDEX).join("\n").toLowerCase();
    expect(text).not.toContain("dd17v");
    expect(text).not.toContain("dd17l");
    expect(text).toContain("dd17s");
  });

  it("indexDeleteFragment never mentions dd17v or dd17l", () => {
    const text = indexDeleteFragment(DELETE_INDEX).join("\n").toLowerCase();
    expect(text).not.toContain("dd17v");
    expect(text).not.toContain("dd17l");
    expect(text).toContain("dd17s");
  });
});

// ---------------------------------------------------------------------------
// 6 — assertSecondaryIndexTarget: zero-network, ahead of everything else
// ---------------------------------------------------------------------------

describe("assertSecondaryIndexTarget", () => {
  it("refuses a local package given a corr_nr as BAD_INPUT", () => {
    expect(catchSync(() => assertSecondaryIndexTarget("$TMP", CORR_NR)).code).toBe("BAD_INPUT");
  });

  it("refuses a transportable package given no corr_nr as TRANSPORT_ERROR", () => {
    expect(catchSync(() => assertSecondaryIndexTarget("ZTM", undefined)).code).toBe("TRANSPORT_ERROR");
  });

  it("refuses a malformed corr_nr as BAD_INPUT", () => {
    expect(catchSync(() => assertSecondaryIndexTarget("ZTM", "not-a-trkorr")).code).toBe("BAD_INPUT");
  });

  it("a local package with no corr_nr returns the empty string", () => {
    expect(assertSecondaryIndexTarget("$TMP", undefined)).toBe("");
  });

  it("a transportable package with a valid corr_nr returns the normalised TRKORR", () => {
    expect(assertSecondaryIndexTarget("ZTM", CORR_NR.toLowerCase())).toBe(CORR_NR);
  });

  it("createSecondaryIndex refuses a local+corr_nr pair with ZERO connection use", async () => {
    const err = await catchErr(createSecondaryIndex(offline, allowingGate(), { ...LOCAL_INDEX, corrNr: CORR_NR }));
    expect(err.code).toBe("BAD_INPUT");
  });

  it("createSecondaryIndex refuses a transportable package with no corr_nr with ZERO connection use", async () => {
    const { corrNr: _drop, ...withoutCorr } = INDEX;
    const err = await catchErr(createSecondaryIndex(offline, allowingGate(), withoutCorr as SecondaryIndexParams));
    expect(err.code).toBe("TRANSPORT_ERROR");
  });

  it("deleteSecondaryIndexViaBridge refuses a local+corr_nr pair with ZERO connection use", async () => {
    const err = await catchErr(
      deleteSecondaryIndexViaBridge(offline, allowingGate(), { ...LOCAL_DELETE_INDEX, corrNr: CORR_NR }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });
});

// ---------------------------------------------------------------------------
// 7 — validation refusals
// ---------------------------------------------------------------------------

describe("validation refusals", () => {
  it("refuses a 4-character index name (DD12V-INDEXNAME is CHAR3)", () => {
    expect(catchSync(() => secondaryIndexFragment({ ...INDEX, indexName: "Z001" })).code).toBe("BAD_INPUT");
  });

  it("refuses an empty field list", () => {
    expect(catchSync(() => secondaryIndexFragment({ ...INDEX, fields: [] })).code).toBe("BAD_INPUT");
  });

  it(`refuses more than MAX_INDEX_FIELDS (${MAX_INDEX_FIELDS}) fields`, () => {
    const fields = Array.from({ length: MAX_INDEX_FIELDS + 1 }, (_, i) => `F${i}`);
    const err = catchSync(() => secondaryIndexFragment({ ...INDEX, fields }));
    expect(err.code).toBe("BAD_INPUT");
  });

  it(`refuses a field name longer than INDEX_FIELD_NAME_MAX (${INDEX_FIELD_NAME_MAX})`, () => {
    const tooLong = "A".repeat(INDEX_FIELD_NAME_MAX + 1);
    const err = catchSync(() => secondaryIndexFragment({ ...INDEX, fields: [tooLong] }));
    expect(err.code).toBe("BAD_INPUT");
  });

  it("refuses an over-long description", () => {
    const err = catchSync(() => secondaryIndexFragment({ ...INDEX, description: "x".repeat(61) }));
    expect(err.code).toBe("BAD_INPUT");
  });

  it("refuses an injected indexName, producing no fragment at all", () => {
    expect(catchSync(() => secondaryIndexFragment({ ...INDEX, indexName: "b'd" })).code).toBe("BAD_INPUT");
  });
});

// ---------------------------------------------------------------------------
// 8 — indexBridgeErrorHook / DD_INDEX_EXCEPTIONS
// ---------------------------------------------------------------------------

describe("indexBridgeErrorHook", () => {
  it("no DD_INDEX_EXCEPTIONS entry maps to AUTH_FAILED", () => {
    for (const entry of DD_INDEX_EXCEPTIONS) {
      expect(entry.code).not.toBe("AUTH_FAILED");
    }
  });

  for (const entry of DD_INDEX_EXCEPTIONS) {
    it(`maps sy-subrc=${entry.subrc} (${entry.name}) to ${entry.code}, on create`, () => {
      const line = `${CREATE_WHAT} failed, sy-subrc=${entry.subrc}, DDXXX051`;
      const transcript: DdicTranscript = { tags: [], errorLine: line, raw: line };
      const hook = indexBridgeErrorHook("insert", INDEX.indexName, INDEX.baseTable);
      expect(catchSync(() => hook(transcript)).code).toBe(entry.code);
    });

    it(`maps sy-subrc=${entry.subrc} (${entry.name}) to ${entry.code}, on delete`, () => {
      const line = `${DELETE_WHAT} failed, sy-subrc=${entry.subrc}, DDXXX051`;
      const transcript: DdicTranscript = { tags: [], errorLine: line, raw: line };
      const hook = indexBridgeErrorHook("delete", DELETE_INDEX.indexName, DELETE_INDEX.baseTable);
      expect(catchSync(() => hook(transcript)).code).toBe(entry.code);
    });
  }

  it('a "does not exist" transcript maps to NOT_FOUND, not CHECK_FAILED', () => {
    const line = `index ${DELETE_INDEX.indexName} on ${DELETE_INDEX.baseTable} does not exist`;
    const transcript: DdicTranscript = { tags: [], errorLine: line, raw: line };
    const hook = indexBridgeErrorHook("delete", DELETE_INDEX.indexName, DELETE_INDEX.baseTable);
    expect(catchSync(() => hook(transcript)).code).toBe("NOT_FOUND");
  });

  it('a "omits the client field" transcript maps to BAD_INPUT, naming the base table and a hint', () => {
    const line = `unique index ${INDEX.indexName} on ${INDEX.baseTable} omits the client field MANDT`;
    const transcript: DdicTranscript = { tags: [], errorLine: line, raw: line };
    const hook = indexBridgeErrorHook("insert", INDEX.indexName, INDEX.baseTable);
    const err = catchSync(() => hook(transcript));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain(INDEX.baseTable);
    expect(err.message).toContain("client field");
    expect(err.hint).toBeTruthy();
  });

  it("an unrelated error line does not throw — left for assertDdicTranscript to handle", () => {
    const transcript: DdicTranscript = { tags: [], errorLine: "some unrelated failure", raw: "some unrelated failure" };
    const hook = indexBridgeErrorHook("insert", INDEX.indexName, INDEX.baseTable);
    expect(() => hook(transcript)).not.toThrow();
  });

  it("an empty transcript (no errorLine) does not throw", () => {
    const transcript: DdicTranscript = { tags: [], raw: "" };
    const hook = indexBridgeErrorHook("insert", INDEX.indexName, INDEX.baseTable);
    expect(() => hook(transcript)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 9 — indexGateName
// ---------------------------------------------------------------------------

describe("indexGateName", () => {
  it("embeds the base table ahead of the index id, so the namespace allowlist sees a real owner", () => {
    expect(indexGateName("ZTMD_I28_T", "Z01")).toBe("ZTMD_I28_T-Z01");
  });
});

// ---------------------------------------------------------------------------
// 10 — indexDeleteFragment's TABLES clause (fix 1: DD_INDEX_INTERFACE
// requires INDEX_FIELDS for every ACTION, content or not — its omission was
// rejected live with "the mandatory parameter INDEX_FIELDS was not filled")
// ---------------------------------------------------------------------------

describe("indexDeleteFragment's TABLES index_fields clause", () => {
  it("INDEX_DELETE_DATA_LINES declares lt_fields", () => {
    expect(INDEX_DELETE_DATA_LINES).toContain("lt_fields TYPE STANDARD TABLE OF ddfldnam WITH DEFAULT KEY.");
  });

  it("emits a TABLES line and an index_fields = lt_fields line", () => {
    const lines = indexDeleteFragment(DELETE_INDEX);
    expect(lines.some((l) => l.trim() === "TABLES")).toBe(true);
    expect(lines.some((l) => l.trim() === "index_fields = lt_fields")).toBe(true);
  });

  it("TABLES sits between IMPORTING and EXCEPTIONS — DD_INDEX_INTERFACE's own parameter order, which the syntax check enforces", () => {
    const lines = indexDeleteFragment(DELETE_INDEX);
    const importing = lines.findIndex((l) => l.trim() === "IMPORTING");
    const tables = lines.findIndex((l) => l.trim() === "TABLES");
    const exceptions = lines.findIndex((l) => l.trim() === "EXCEPTIONS");
    expect(importing).toBeGreaterThanOrEqual(0);
    expect(tables).toBeGreaterThan(importing);
    expect(exceptions).toBeGreaterThan(tables);
  });
});

// ---------------------------------------------------------------------------
// 11 — unique-index client-field guard (fix 2: unconfirmed diagnosis of the
// live 2026-09-05 ACTFAILED on a unique index over a client-dependent table)
// ---------------------------------------------------------------------------

describe("unique-index client-field guard", () => {
  it("unique: true emits the DD03L lookup, the READ TABLE guard, and the omits-client-field write", () => {
    const text = secondaryIndexFragment({ ...INDEX, unique: true }).join("\n");
    expect(text).toContain("SELECT SINGLE fieldname FROM dd03l");
    expect(text).toContain("datatype = 'CLNT'");
    expect(text).toContain("READ TABLE lt_fields TRANSPORTING NO FIELDS WITH KEY name = lv_client_field.");
    expect(text).toContain("omits the client field { lv_client_field }");
  });

  it("unique omitted emits none of the guard — the non-unique path already proven live must not regress", () => {
    const text = secondaryIndexFragment(INDEX).join("\n").toLowerCase();
    expect(text).not.toContain("dd03l");
    expect(text).not.toContain("lv_client_field");
    expect(text).not.toContain("omits the client field");
  });

  it("unique: false emits none of the guard either", () => {
    const text = secondaryIndexFragment({ ...INDEX, unique: false }).join("\n").toLowerCase();
    expect(text).not.toContain("dd03l");
    expect(text).not.toContain("lv_client_field");
  });
});

// ---------------------------------------------------------------------------
// 13 — ACTFAILED branches disclose a DD12V row count (DD_INDEX_INTERFACE
// exports no activation log, so this is the cheapest evidence available)
// ---------------------------------------------------------------------------

describe("ACTFAILED branches disclose an unfiltered DD12V row count", () => {
  /** The `IF lv_actfailed = 'X'. ... ENDIF.` block, whichever fragment emitted it. */
  function actfailedBlock(lines: readonly string[]): string[] {
    const start = lines.findIndex((l) => l.trim() === "IF lv_actfailed = 'X'.");
    if (start < 0) throw new Error("no ACTFAILED branch found");
    const end = lines.findIndex((l, i) => i > start && l.trim() === "ENDIF.");
    return lines.slice(start, end + 1);
  }

  it("secondaryIndexFragment's ACTFAILED branch selects DD12V with no AS4LOCAL filter and interpolates the counter", () => {
    const block = actfailedBlock(secondaryIndexFragment(INDEX));
    expect(block.some((l) => l.includes("SELECT COUNT( * ) FROM dd12v"))).toBe(true);
    expect(block.some((l) => l.includes("SELECT COUNT( * ) FROM dd12v") && l.includes("AS4LOCAL"))).toBe(false);
    expect(block.some((l) => l.includes("{ lv_dd12v_any }"))).toBe(true);
  });

  it("indexDeleteFragment's post-commit read-back selects DD12V unfiltered, DD12V AS4LOCAL='A', and DD17S, then interpolates all three in the failure message", () => {
    const lines = indexDeleteFragment(DELETE_INDEX);
    const commitIdx = lines.findIndex((l) => l.trim() === "COMMIT WORK.");
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    const readback = lines.slice(commitIdx + 1);

    const dd12vAny = readback.find((l) => l.includes("SELECT COUNT( * ) FROM dd12v INTO @lv_dd12v_count"));
    const dd12vActive = readback.find((l) => l.includes("SELECT COUNT( * ) FROM dd12v INTO @lv_dd12v_active"));
    const dd17s = readback.find((l) => l.includes("SELECT COUNT( * ) FROM dd17s INTO @lv_dd17s_count"));
    expect(dd12vAny).toBeDefined();
    expect(dd12vActive).toBeDefined();
    expect(dd17s).toBeDefined();
    expect(dd12vAny!.toLowerCase()).not.toContain("as4local");
    expect(dd12vActive!.toLowerCase()).toContain("as4local");

    const { text: errBlock } = lvMsgBlock(readback, (l) => l.includes(DDIC_ERR_PREFIX) && l.includes("left rows behind"));
    expect(errBlock).toContain("{ lv_dd12v_count }");
    expect(errBlock).toContain("{ lv_dd12v_active }");
    expect(errBlock).toContain("{ lv_dd17s_count }");
  });
});

// ---------------------------------------------------------------------------
// 14 — indexDeleteFragment's ACTFAILED-tolerant read-back (fix 3: live
// 2026-09-05 round 2 — ACTFAILED = 'X' fired on delete after the index was
// already gone from DD12V/DD17S; the old fragment RETURNed before COMMIT
// WORK on that alone, reporting CHECK_FAILED for a delete that had worked)
// ---------------------------------------------------------------------------

describe("indexDeleteFragment's ACTFAILED-tolerant read-back", () => {
  /** Extracts a note/error line's interpolated content, not hand-typed — tracks the fragment's own wording. */
  function interpolatedText(line: string): string {
    const m = /\|(.+)\|/.exec(line);
    if (!m?.[1]) throw new Error(`no interpolated text in: ${line}`);
    return m[1];
  }

  const DELETE_LINES = indexDeleteFragment(DELETE_INDEX);

  it("an ACTFAILED-but-gone transcript parses as success: the note line never becomes errorLine", () => {
    const noteLine = interpolatedText(DELETE_LINES.find((l) => l.includes(DDIC_NOTE_PREFIX))!);
    expect(noteLine.startsWith(DDIC_NOTE_PREFIX)).toBe(true);
    expect(noteLine).not.toContain(DDIC_ERR_PREFIX);

    const raw = [noteLine, "INDEX-DELETED-ACTFAILED", "INDEX-DELETED", "INDEX-GONE"].join("\n");
    const parsed = parseDdicTranscript(raw);
    expect(parsed.errorLine).toBeUndefined();
    expect(parsed.tags).toEqual(["INDEX-DELETED-ACTFAILED", "INDEX-DELETED", "INDEX-GONE"]);
  });

  it("INDEX-DELETED-ACTFAILED precedes INDEX-DELETED in the emitted fragment", () => {
    const tags = emittedTags(DELETE_LINES);
    const actfailedIdx = tags.indexOf("INDEX-DELETED-ACTFAILED");
    const deletedIdx = tags.indexOf("INDEX-DELETED");
    expect(actfailedIdx).toBeGreaterThanOrEqual(0);
    expect(deletedIdx).toBeGreaterThan(actfailedIdx);
  });

  it("rows still in DD12V/DD17S after commit is still a real failure, distinguishable from the ACTFAILED-but-gone note", () => {
    const { text: errBlock, endIdx } = lvMsgBlock(
      DELETE_LINES,
      (l) => l.includes(DDIC_ERR_PREFIX) && l.includes("left rows behind"),
    );
    expect(errBlock).toContain("{ lv_dd12v_count }");
    expect(errBlock).toContain("{ lv_dd12v_active }");
    expect(errBlock).toContain("{ lv_dd17s_count }");
    expect(errBlock).toContain(`${DELETE_WHAT} ACTFAILED = '{ lv_actfailed }'`);
    expect(errBlock).not.toContain(DDIC_NOTE_PREFIX);

    expect(DELETE_LINES[endIdx + 1]!.trim()).toBe("RETURN.");
  });

  it("no RETURN sits between the FM call's sy-subrc guard and COMMIT WORK — ACTFAILED can no longer short-circuit the commit", () => {
    const guardErrIdx = DELETE_LINES.findIndex((l) => l.includes(`${DELETE_WHAT} failed, sy-subrc={ sy-subrc }`));
    expect(guardErrIdx).toBeGreaterThanOrEqual(0);
    const guardEndIdx = DELETE_LINES.findIndex((l, i) => i > guardErrIdx && l.trim() === "ENDIF.");
    const commitIdx = DELETE_LINES.findIndex((l) => l.trim() === "COMMIT WORK.");
    expect(guardEndIdx).toBeGreaterThan(guardErrIdx);
    expect(commitIdx).toBeGreaterThan(guardEndIdx);

    const between = DELETE_LINES.slice(guardEndIdx + 1, commitIdx);
    expect(between.some((l) => l.trim() === "RETURN.")).toBe(false);
  });

  it('"INDEX-DELETED-ACTFAILED" is a recognised tag, not dropped as prose', () => {
    expect(DDIC_TAGS).toContain("INDEX-DELETED-ACTFAILED");
    const parsed = parseDdicTranscript("INDEX-DELETED-ACTFAILED");
    expect(parsed.tags).toEqual(["INDEX-DELETED-ACTFAILED"]);
    expect(parsed.errorLine).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 15 — bridge-refresh pin: a stale (pre-fix) server-side bridge class body
// still gets PUT over, rather than skipped as "class exists, unchanged".
// Fake HttpClient transport, harness copied from test/view-delete.test.ts /
// test/bopf-runtime.test.ts's `bridgeRouteWarm` — the only network-touching
// section in this file.
// ---------------------------------------------------------------------------

describe("deleteSecondaryIndexViaBridge re-PUTs a stale bridge class body", () => {
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
  const LOCK_XML = (handle = "H1") =>
    `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
    `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
    `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
    `</DATA></asx:values></asx:abap>`;

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

  function classrunOutput(lines: readonly string[]): (o: HttpClientOptions) => HttpClientResponse {
    const body = lines.join("\n");
    return () => resp(200, body, { "content-type": "text/plain" });
  }

  const CLASS_NAME = DDIC_BRIDGE_CLASS.deleteIndex;
  const classUri = `/sap/bc/adt/oo/classes/${CLASS_NAME.toLowerCase()}`;
  const sourceUri = `${classUri}/source/main`;

  /** All-active `class:abapClass` doc — same shape as bopf-runtime.test.ts's `classDocXml(className)` default. */
  const CLASS_DOC =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<class:abapClass adtcore:name="${CLASS_NAME}" adtcore:type="CLAS/OC" adtcore:version="active" ` +
    `xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `xmlns:abapsource="http://www.sap.com/adt/abapsource">` +
    `<adtcore:packageRef adtcore:name="${DDIC_BRIDGE_PACKAGE}"/>` +
    `<class:include class:includeType="definitions" abapsource:sourceUri="includes/definitions" adtcore:name="" adtcore:type="CLAS/I" adtcore:version="active"/>` +
    `<class:include class:includeType="implementations" abapsource:sourceUri="includes/implementations" adtcore:name="" adtcore:type="CLAS/I" adtcore:version="active"/>` +
    `<class:include class:includeType="macros" abapsource:sourceUri="includes/macros" adtcore:name="" adtcore:type="CLAS/I" adtcore:version="active"/>` +
    `<class:include class:includeType="main" abapsource:sourceUri="source/main" adtcore:name="" adtcore:type="CLAS/I" adtcore:version="active"/>` +
    `</class:abapClass>`;

  /** What deployBridge computes locally, right now, from the fixed generator. */
  const FIXED_SOURCE = ddicBridgeSource(DDIC_BRIDGE_CLASS.deleteIndex, INDEX_DELETE_DATA_LINES, indexDeleteFragment(DELETE_INDEX));

  /** The buggy pre-fix body DD_INDEX_INTERFACE rejected live: same class, minus fix 1's TABLES clause. */
  const STALE_SOURCE = FIXED_SOURCE.split("\n")
    .filter((l) => l.trim() !== "TABLES" && l.trim() !== "index_fields = lt_fields")
    .join("\n");

  function staleRoute(classrun: (o: HttpClientOptions) => HttpClientResponse): (o: HttpClientOptions) => HttpClientResponse {
    return (o: HttpClientOptions) => {
      const qs = (o.qs ?? {}) as Record<string, string>;
      const method = (o.method ?? "GET").toUpperCase();

      if (o.url.startsWith("/sap/bc/adt/oo/classrun/")) return classrun(o);
      if (o.url.includes(SESSION_URL)) {
        return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
      }
      if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
      if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
      if (o.url === classUri && method === "GET" && !qs._action) {
        return resp(200, CLASS_DOC, { "content-type": "application/xml" });
      }
      if (o.url === sourceUri && method === "GET") {
        return resp(200, STALE_SOURCE, { "content-type": "text/plain" });
      }
      if (qs._action === "LOCK") return resp(200, LOCK_XML(), { "content-type": "application/xml" });
      if (qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
      if (o.url === sourceUri && method === "PUT") return resp(200, "", { "content-type": "text/plain" });
      if (o.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
      return resp(200, "<ok/>", { "content-type": "application/xml" });
    };
  }

  it("re-PUTs the class source when the server holds the stale pre-fix body, and the new body carries the TABLES fix", async () => {
    expect(STALE_SOURCE).not.toContain("index_fields = lt_fields"); // fixture really is the old buggy shape
    const { conn, inner } = await connected(staleRoute(classrunOutput(["INDEX-DELETED", "INDEX-GONE"])));

    await deleteSecondaryIndexViaBridge(conn, allowingGate(), DELETE_INDEX);

    const put = inner.calls.find((c) => (c.method ?? "").toUpperCase() === "PUT" && c.url === sourceUri);
    expect(put).toBeDefined();
    expect(String(put!.body)).toContain("index_fields = lt_fields");
  });

  it("a byte-identical server body is left alone — no PUT at all, proving the pin above isn't vacuous", async () => {
    const identicalRoute = (o: HttpClientOptions): HttpClientResponse => {
      const method = (o.method ?? "GET").toUpperCase();
      if (o.url === sourceUri && method === "GET") return resp(200, FIXED_SOURCE, { "content-type": "text/plain" });
      return staleRoute(classrunOutput(["INDEX-DELETED", "INDEX-GONE"]))(o);
    };
    const { conn, inner } = await connected(identicalRoute);

    await deleteSecondaryIndexViaBridge(conn, allowingGate(), DELETE_INDEX);

    expect(inner.calls.some((c) => (c.method ?? "").toUpperCase() === "PUT")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 16 — worst-case assembled-source line length (fix 4: a >255-char class-
// source line rejected the PUT itself, live 2026-09-05 round 3, before
// DD_INDEX_INTERFACE was ever called)
// ---------------------------------------------------------------------------

describe("worst-case assembled-source line length stays within ABAP_SOURCE_LINE_MAX", () => {
  // Deliberately a literal, not the imported constant: this test has to stay red against a
  // source tree where ABAP_SOURCE_LINE_MAX does not exist yet, where the import is undefined
  // and every `length > undefined` comparison silently passes.
  const LINE_MAX = 255;

  /** Every line over the limit, with its 1-based number and length — an empty array is the pass. */
  function offendingLines(source: string): Array<{ line: number; length: number }> {
    return source
      .split("\n")
      .map((text, i) => ({ line: i + 1, length: text.length }))
      .filter((l) => l.length > LINE_MAX);
  }

  it("ABAP_SOURCE_LINE_MAX matches the literal this suite measures against", () => {
    expect(ABAP_SOURCE_LINE_MAX).toBe(LINE_MAX);
  });

  it("secondaryIndexFragment (non-unique), longest names and a full field list, at MAX_INDEX_FIELDS", () => {
    const source = ddicBridgeSource(
      DDIC_BRIDGE_CLASS.createIndex,
      INDEX_DATA_LINES,
      secondaryIndexFragment({ ...WORST_CASE_INDEX, unique: false }),
    );
    expect(offendingLines(source)).toEqual([]);
  });

  it("secondaryIndexFragment (unique), longest names and a full field list, at MAX_INDEX_FIELDS", () => {
    const source = ddicBridgeSource(
      DDIC_BRIDGE_CLASS.createIndex,
      INDEX_DATA_LINES,
      secondaryIndexFragment({ ...WORST_CASE_INDEX, unique: true }),
    );
    expect(offendingLines(source)).toEqual([]);
  });

  it("indexDeleteFragment, longest index name and base table", () => {
    const source = ddicBridgeSource(
      DDIC_BRIDGE_CLASS.deleteIndex,
      INDEX_DELETE_DATA_LINES,
      indexDeleteFragment(WORST_CASE_DELETE),
    );
    expect(offendingLines(source)).toEqual([]);
  });
});
