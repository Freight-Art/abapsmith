/**
 * Secondary-index (`TABL/DI`) create/delete bridge — pure unit tests, ZERO
 * network. `./view-create.test.ts`/`./view-delete.test.ts` already cover the
 * fake-transport happy path for this bridge family; this file only exercises
 * `src/adt/index-create.ts` itself:
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
 *  9. `indexGateName`'s embedding of the base table into the gated name.
 */
import { describe, expect, it } from "vitest";
import { AbapConnection } from "../src/adt/connection.js";
import { SafetyGate } from "../src/safety.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { DDIC_TAGS, assertDdicTranscript, parseDdicTranscript, type DdicTag, type DdicTranscript } from "../src/adt/ddic-bridge.js";
import {
  DD_INDEX_EXCEPTIONS,
  INDEX_FIELD_NAME_MAX,
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
    expect(tags).toEqual(["INDEX-DELETED", "INDEX-GONE"]);
  });

  it("indexDeleteFragment emits the same tag set for $TMP", () => {
    const tags = emittedTags(indexDeleteFragment(LOCAL_DELETE_INDEX));
    expect(tags).toEqual(["INDEX-DELETED", "INDEX-GONE"]);
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
