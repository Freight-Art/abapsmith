/**
 * `abap_read` view="history" / view="diff" — revision history and diffs.
 *
 * WHERE THE BYTES COME FROM. Nothing here mocks `Revision[]` into existence.
 * Every feed assertion drives abap-adt-api v8.4.x's OWN parser
 * (`build/api/revisions.js` — the exact function `ADTClient.revisions()`
 * delegates to) over a feed **captured live from A4H (SAP_BASIS 754 SP0007) on
 * 2026-08-18**, with a fake `AdtHTTP` in place of the socket. See
 * `test/fixtures/revisions/README.md` for provenance.
 *
 * That matters more than usual here. The first draft of this feature was built
 * on a synthetic feed and a prior-art document, and live capture contradicted
 * both on four separate points — the discovery gate, `$TMP`, which XML node
 * carries the version number, and what the feed's order and membership are.
 * Each of those is now pinned to bytes a server actually sent:
 *
 *   - **no discovery gate** — `conn.discovery.assertSupported` THROWS in every
 *     test below, and history/diff still work. Re-introducing the gate turns
 *     this whole file red.
 *   - **`$TMP` has no history** — the one-entry capture, and the refusal it
 *     must produce instead of "no differences".
 *   - **selection** — the 68-entry capture, ~60 rows of which are the same
 *     ACTIVE pseudo-version. A three-entry feed cannot catch what it catches.
 *   - **version numbers come from `content/@src`** — `atom:id` is parsed into a
 *     NUMBER by the library, which destroys the zero-padding; asserted below.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error deep import: the package does not re-export `revisions` at
// its root, and reaching the real parser is the whole point of this suite.
import { revisions as libRevisions } from "abap-adt-api/build/api/revisions.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error deep import, same reason: `fullParse` is the exact
// fast-xml-parser configuration the library reads feeds with, and the padding
// trap only exists under that configuration.
import { fullParse, xmlArray } from "abap-adt-api/build/utilities.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import { AbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import {
  ACTIVE_VERSION_ID,
  listRevisions,
  normaliseRevisions,
  releasedVersions,
  revisionSource,
  versionIdFromContentUri,
  type RevisionEntry,
} from "../src/adt/revisions.js";
import { buildUri, specForType } from "../src/adt/types.js";
import {
  DIFF_LINE_MAX,
  MAX_DIFF_CELLS,
  diffSources,
  renderHunks,
  splitSourceLines,
} from "../src/diff.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "revisions");
const capture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/** 68 entries, ~60 of them the same ACTIVE row. The selection regression fixture. */
const MAIN_FEED = capture("versions-feed-clas-main-a4h-754.xml");
/** 5 entries covering every entry shape in one compact document. */
const TC_FEED = capture("versions-feed-clas-testclasses-a4h-754.xml");
/** The same shapes on a second, independent object. */
const TC2_FEED = capture("versions-feed-clas-testclasses2-a4h-754.xml");
/** One entry, `00000`, after three successful local activations. */
const TMP_FEED = capture("versions-feed-ztmp-local-class-a4h-754.xml");

/** Content URLs exactly as the captured feeds carry them. */
const MAIN = (v: string): string =>
  `/sap/bc/adt/oo/classes/cl_ci_inspection/includes/main/versions/20180205111235/${v}/content`;
const TC = (v: string): string =>
  `/sap/bc/adt/oo/classes/cl_ci_inspection/includes/testclasses/versions/20180205081649/${v}/content`;
const TMP_ACTIVE =
  "/sap/bc/adt/oo/classes/zcl_verhist_probe01/includes/main/versions/19700101101123/00000/content";

/** Mutable stub the mocked `resolveObject` hands back. */
const stub = { object: {} as ResolvedObject };

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => stub.object,
}));

const { abapRead, registerReadTools } = await import("../src/tools/read.js");

function resolved(over: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "CLAS/OC",
    kind: "CLAS",
    label: "class",
    name: "CL_CI_INSPECTION",
    uri: "/sap/bc/adt/oo/classes/cl_ci_inspection",
    sourceUri: "/sap/bc/adt/oo/classes/cl_ci_inspection/source/main",
    mode: "source",
    activation: "unknown",
    spec: {},
    ...over,
  } as unknown as ResolvedObject;
}

/** Every include ADT names on a class, in the order the captured structure lists them. */
const ALL_INCLUDES = ["definitions", "implementations", "macros", "testclasses", "main"];

/**
 * A class structure document as `objectStructure()` would have converted it:
 * `class:visibility` in the metadata is what makes `isClassStructure()` true,
 * and the versions link relation hangs off each INCLUDE rather than off the
 * object — which is the whole of C-6.
 *
 * `versioned` says which includes carry the link. It defaults to all of them
 * because that is what the live-captured structure in this repo shows (see the
 * test below), but it is a parameter precisely because the code must not depend
 * on that: an include with no link is a refusal, not a crash.
 */
function classStructure(
  objectUrl = "/sap/bc/adt/oo/classes/cl_ci_inspection",
  versioned: string[] = ALL_INCLUDES,
): unknown {
  return {
    objectUrl,
    metaData: { "adtcore:name": "CL_CI_INSPECTION", "class:visibility": "public" },
    includes: ALL_INCLUDES.map((i) => ({
      "class:includeType": i,
      links: versioned.includes(i)
        ? [{ rel: "http://www.sap.com/adt/relations/versions", href: `includes/${i}/versions` }]
        : [{ rel: "http://www.sap.com/adt/relations/source", href: `includes/${i}` }],
    })),
  };
}

/** A non-class structure: one feed, link on the object itself. */
const PROGRAM_STRUCTURE = {
  objectUrl: "/sap/bc/adt/programs/programs/zdemo",
  metaData: { "adtcore:name": "ZDEMO" },
  links: [{ rel: "http://www.sap.com/adt/relations/versions", href: "source/main/versions" }],
};

/** A structure with no versions link at all — the real per-object availability check. */
const STRUCTURE_WITHOUT_VERSIONS = {
  objectUrl: "/sap/bc/adt/programs/programs/zdemo",
  metaData: { "adtcore:name": "ZDEMO" },
  links: [{ rel: "self", href: "." }],
};

interface ConnOptions {
  feed?: string;
  structure?: unknown;
  sources?: Record<string, string>;
}

/** Records every wire interaction so a test can assert what was NOT fetched. */
interface Recorder {
  feedRequests: string[];
  sourceRequests: string[];
  discoveryCalls: string[];
}

function fakeConn(opts: ConnOptions = {}): { conn: AbapConnection; rec: Recorder } {
  const rec: Recorder = { feedRequests: [], sourceRequests: [], discoveryCalls: [] };
  const feed = opts.feed ?? MAIN_FEED;
  const structure = opts.structure ?? classStructure();
  const http = {
    request: async (url: string) => {
      rec.feedRequests.push(url);
      return { body: feed };
    },
  };
  const conn = {
    cfg: { sid: "A4H" },
    discovery: {
      // BLOCKER 1. This ALWAYS throws. On the A4H appliance the discovery
      // inventory lists 368 collections and not one of their hrefs mentions
      // versions or revisions, so a gate here answers "unsupported" for every
      // object on a system where the endpoint returns HTTP 200. Any code path
      // that consults discovery before reading a version feed fails every test
      // in this file, which is the point.
      assertSupported: (feature: string, what: string) => {
        rec.discoveryCalls.push(feature);
        throw new AbapError(
          "UNSUPPORTED",
          `This system's ADT release does not expose ${what}.`,
          { feature, state: "probed" },
          "The /discovery inventory lists no matching collection.",
        );
      },
      capability: (feature: string) => {
        rec.discoveryCalls.push(feature);
        return "unsupported";
      },
      supports: (feature: string) => {
        rec.discoveryCalls.push(feature);
        return false;
      },
      maySupport: (feature: string) => {
        rec.discoveryCalls.push(feature);
        return false;
      },
    },
    adt: {
      // The REAL library parser, over the fake socket.
      revisions: (_url: string, include?: string) => libRevisions(http, structure, include),
      // Only ever consulted to make a refusal specific: which includes actually
      // carry a versions link is read back off the object, never assumed.
      objectStructure: async () => structure,
      getObjectSource: async (uri: string) => {
        rec.sourceRequests.push(uri);
        const body = opts.sources?.[uri];
        if (body === undefined) throw new Error(`no stub source for ${uri}`);
        return body;
      },
    },
  } as unknown as AbapConnection;
  return { conn, rec };
}

/** A body long enough that returning it whole would be obvious in an assertion. */
function classSource(marker: string): string {
  const filler = Array.from({ length: 40 }, (_, i) => `    WRITE / 'padding line ${i}'.`);
  return [
    "CLASS cl_ci_inspection DEFINITION PUBLIC FINAL CREATE PUBLIC.",
    "  PUBLIC SECTION.",
    "    METHODS run.",
    "ENDCLASS.",
    "CLASS cl_ci_inspection IMPLEMENTATION.",
    "  METHOD run.",
    `    WRITE / '${marker}'.`,
    ...filler,
    "  ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n");
}

/** Sources for every version the main-feed tests may legitimately reach for. */
const MAIN_SOURCES: Record<string, string> = {
  [MAIN(ACTIVE_VERSION_ID)]: classSource("CURRENT"),
  [MAIN("00067")]: classSource("SIXTY-SEVEN"),
  [MAIN("00066")]: classSource("SIXTY-SIX"),
  [MAIN("00065")]: classSource("SIXTY-FIVE"),
  [MAIN("00063")]: classSource("SIXTY-THREE"),
  [MAIN("00003")]: classSource("THREE"),
  [MAIN("00001")]: classSource("ONE"),
};

const TC_SOURCES: Record<string, string> = {
  [TC("00004")]: classSource("FOUR"),
  [TC("00003")]: classSource("THREE"),
  [TC("00002")]: classSource("TWO"),
  [TC("00001")]: classSource("ONE"),
};

/** The rows of the rendered history table, header and rule dropped. */
function tableRows(text: string): string[] {
  const lines = text.split("\n");
  // NOT `startsWith("version")` — the header block above the table carries a
  // "versions: N" counter line that would match first and yield no rows at all.
  const head = lines.findIndex((l) => /^version\s+kind\s+transport\s/.test(l));
  if (head === -1) return [];
  const rows: string[] = [];
  for (const line of lines.slice(head + 2)) {
    if (!/^[0-9?]/.test(line)) break;
    rows.push(line);
  }
  return rows;
}

beforeEach(() => {
  stub.object = resolved();
});

// ---------------------------------------------------------------------------
// (1) BLOCKER 1 — availability is a per-object link relation, not a discovery
//     collection. Every fakeConn's assertSupported throws; nothing may call it.
// ---------------------------------------------------------------------------

describe("no discovery gate", () => {
  it("lists history on a system whose discovery probe would refuse everything", async () => {
    const { conn, rec } = fakeConn({ feed: TC_FEED });
    const r = await abapRead(conn, { object: "CL_CI_INSPECTION", view: "history" } as never, 20_000);

    expect(rec.discoveryCalls).toEqual([]);
    expect(rec.feedRequests).toEqual([
      "/sap/bc/adt/oo/classes/cl_ci_inspection/includes/main/versions",
    ]);
    expect(r.text).toContain("view: history");
  });

  it("diffs on that same system", async () => {
    const { conn, rec } = fakeConn({ feed: TC_FEED, sources: TC_SOURCES });
    const r = await abapRead(conn, { object: "CL_CI_INSPECTION", view: "diff" } as never, 20_000);

    expect(rec.discoveryCalls).toEqual([]);
    expect(r.text).toContain("view: diff");
  });

  it("refuses an object whose structure carries no versions link, and says why", async () => {
    stub.object = resolved({
      kind: "PROG",
      type: "PROG/P",
      name: "ZDEMO",
      uri: "/sap/bc/adt/programs/programs/zdemo",
    } as Partial<ResolvedObject>);
    const { conn } = fakeConn({ structure: STRUCTURE_WITHOUT_VERSIONS });
    await expect(
      abapRead(conn, { object: "ZDEMO", view: "history" } as never, 20_000),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("no ADT version feed"),
      hint: expect.stringContaining("per-object property"),
    });
  });

  it("reads a non-class feed from the link on the object itself", async () => {
    stub.object = resolved({
      kind: "PROG",
      type: "PROG/P",
      name: "ZDEMO",
      uri: "/sap/bc/adt/programs/programs/zdemo",
    } as Partial<ResolvedObject>);
    const { conn, rec } = fakeConn({ structure: PROGRAM_STRUCTURE, feed: TMP_FEED });
    const r = await abapRead(conn, { object: "ZDEMO", view: "history" } as never, 20_000);

    expect(rec.feedRequests).toEqual(["/sap/bc/adt/programs/programs/zdemo/source/main/versions"]);
    // No include disclosure for an object that has no includes.
    expect(r.text).not.toContain("include:");
  });

  it("reads a function module's feed from an address that carries its owning group", async () => {
    stub.object = resolved({
      kind: "FUGR/FF",
      type: "FUGR/FF",
      name: "Z_MODULE",
      uri: "/sap/bc/adt/functions/groups/zgroup/fmodules/z_module",
    } as Partial<ResolvedObject>);
    const structure = {
      objectUrl: "/sap/bc/adt/functions/groups/zgroup/fmodules/z_module",
      metaData: { "adtcore:name": "Z_MODULE" },
      links: [{ rel: "http://www.sap.com/adt/relations/versions", href: "versions" }],
    };
    const { conn, rec } = fakeConn({ structure, feed: TMP_FEED });
    const r = await abapRead(conn, { object: "Z_MODULE", view: "history" } as never, 20_000);

    expect(rec.feedRequests).toEqual([
      "/sap/bc/adt/functions/groups/zgroup/fmodules/z_module/versions",
    ]);
    expect(r.text).not.toContain("include:");
  });
});

// ---------------------------------------------------------------------------
// (2) BLOCKER 2 — $TMP objects have no released history at all. The ordinary
//     case for anything this server may write, and the one answer that must
//     never be "no differences".
// ---------------------------------------------------------------------------

describe("$TMP / local objects have no released history", () => {
  const local = (): ResolvedObject =>
    resolved({
      name: "ZCL_VERHIST_PROBE01",
      uri: "/sap/bc/adt/oo/classes/zcl_verhist_probe01",
      packageName: "$TMP",
    } as Partial<ResolvedObject>);

  it("the capture really does hold one ACTIVE entry and nothing else", async () => {
    const raw = await libRevisions(
      { request: async () => ({ body: TMP_FEED }) },
      classStructure("/sap/bc/adt/oo/classes/zcl_verhist_probe01"),
    );
    expect(raw).toHaveLength(1);
    const entries = normaliseRevisions(raw as never);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.versionId).toBe("00000");
    expect(entries[0]!.kind).toBe("active");
    expect(releasedVersions(entries)).toEqual([]);
  });

  it('refuses view="diff" with a statement of WHY, never with "no differences"', async () => {
    stub.object = local();
    const { conn, rec } = fakeConn({
      feed: TMP_FEED,
      structure: classStructure("/sap/bc/adt/oo/classes/zcl_verhist_probe01"),
      sources: { [TMP_ACTIVE]: classSource("CURRENT") },
    });

    const err = await abapRead(
      conn,
      { object: "ZCL_VERHIST_PROBE01", view: "diff" } as never,
      20_000,
    ).then(
      (r) => {
        throw new Error(`expected a refusal, got:\n${r.text}`);
      },
      (e: AbapError) => e,
    );

    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain("no released version history");
    expect(err.message).toContain("$TMP");
    expect(err.message).toContain("never on local activation");
    // The failure mode this whole branch exists to prevent.
    expect(err.message).not.toContain("no differences");
    // And it costs no round trip: ACTIVE was never fetched to be diffed
    // against itself.
    expect(rec.sourceRequests).toEqual([]);
  });

  it('says on view="history" that the single row is the current source, not a change', async () => {
    stub.object = local();
    const { conn } = fakeConn({
      feed: TMP_FEED,
      structure: classStructure("/sap/bc/adt/oo/classes/zcl_verhist_probe01"),
    });
    const r = await abapRead(
      conn,
      { object: "ZCL_VERHIST_PROBE01", view: "history" } as never,
      20_000,
    );

    expect(r.text).toContain("versions: 1");
    expect(r.text).toContain("released: 0");
    expect(r.text).toContain("no released version history");
    expect(r.text).toContain("not a record of a change");
    expect(r.text).toContain("There is no predecessor to diff against.");
    expect(tableRows(r.text)).toHaveLength(1);
    expect(tableRows(r.text)[0]).toMatch(/^00000\s+ACTIVE\s/);
  });
});

// ---------------------------------------------------------------------------
// (3) C-1 — order, de-duplication and pseudo-version exclusion, against the
//     68-entry capture. A small feed does not exercise any of this.
// ---------------------------------------------------------------------------

describe("selection over the 68-entry capture", () => {
  it("the capture is as described: 68 entries, ~60 of them the same ACTIVE row", async () => {
    const raw = (await libRevisions(
      { request: async () => ({ body: MAIN_FEED }) },
      classStructure(),
    )) as Array<{ uri: string }>;
    expect(raw).toHaveLength(68);
    expect(raw.filter((r) => r.uri === MAIN(ACTIVE_VERSION_ID))).toHaveLength(60);
    // Document order is NOT newest-first, and the second entry is not the
    // predecessor of the first.
    expect(raw[0]!.uri).toBe(MAIN(ACTIVE_VERSION_ID));
    expect(raw[1]!.uri).toBe(MAIN("00067"));
  });

  it("de-duplicates to 9 rows, one ACTIVE and 8 released, newest released first", async () => {
    const { conn } = fakeConn();
    const r = await abapRead(conn, { object: "CL_CI_INSPECTION", view: "history" } as never, 20_000);

    expect(r.text).toContain("versions: 9");
    expect(r.text).toContain("released: 8");
    const rows = tableRows(r.text);
    expect(rows).toHaveLength(9);
    expect(rows.map((l) => l.split(/\s+/)[0])).toEqual([
      "00000",
      "00067",
      "00066",
      "00065",
      "00064",
      "00063",
      "00003",
      "00002",
      "00001",
    ]);
    // Exactly one ACTIVE row survives, not sixty.
    expect(rows.filter((l) => l.includes("ACTIVE"))).toHaveLength(1);
  });

  it("defaults the diff to the two newest RELEASED versions, never to ACTIVE", async () => {
    const { conn, rec } = fakeConn({ sources: MAIN_SOURCES });
    const r = await abapRead(conn, { object: "CL_CI_INSPECTION", view: "diff" } as never, 20_000);

    expect(rec.sourceRequests.sort()).toEqual([MAIN("00066"), MAIN("00067")].sort());
    // The regression itself: the old selection took document order, so the
    // "newest" was ACTIVE and its "predecessor" was 00067.
    expect(rec.sourceRequests).not.toContain(MAIN(ACTIVE_VERSION_ID));
    expect(r.text).toContain("from: 00066");
    expect(r.text).toContain("to: 00067");
    expect(r.text).toContain("(defaulted: the newest released version)");
    expect(r.text).toContain("-    WRITE / 'SIXTY-SIX'.");
    expect(r.text).toContain("+    WRITE / 'SIXTY-SEVEN'.");
  });

  it("orders released versions by version NUMBER, which undated entries still have", async () => {
    // 00001-00003 carry no atom:updated at all in this capture. Under a
    // date-only ordering they land below 00063-00067 in ASCENDING order under
    // a heading that says newest-first.
    const raw = await libRevisions(
      { request: async () => ({ body: MAIN_FEED }) },
      classStructure(),
    );
    const released = releasedVersions(normaliseRevisions(raw as never));
    expect(released.map((e) => e.versionId)).toEqual([
      "00067",
      "00066",
      "00065",
      "00064",
      "00063",
      "00003",
      "00002",
      "00001",
    ]);
    expect(released.filter((e) => e.date === "")).toHaveLength(3);
  });

  it("honours an explicit pair of undated versions using their numbers", async () => {
    const { conn, rec } = fakeConn({ sources: MAIN_SOURCES });
    const r = await abapRead(
      conn,
      { object: "CL_CI_INSPECTION", view: "diff", from: "00001", to: "00003" } as never,
      20_000,
    );
    expect(rec.sourceRequests.sort()).toEqual([MAIN("00001"), MAIN("00003")].sort());
    expect(r.text).toContain("-    WRITE / 'ONE'.");
    expect(r.text).toContain("+    WRITE / 'THREE'.");
  });

  it("diffs against ACTIVE only when asked, and discloses that it did", async () => {
    const { conn, rec } = fakeConn({ sources: MAIN_SOURCES });
    const r = await abapRead(
      conn,
      { object: "CL_CI_INSPECTION", view: "diff", to: "active" } as never,
      20_000,
    );
    expect(rec.sourceRequests.sort()).toEqual([MAIN("00000"), MAIN("00067")].sort());
    expect(r.text).toContain("to: 00000 (ACTIVE — current source)");
    expect(r.text).toContain("what has changed since the last release");
  });

  it("refuses a reversed pair rather than silently swapping the sides", async () => {
    const { conn } = fakeConn({ sources: MAIN_SOURCES });
    await expect(
      abapRead(
        conn,
        { object: "CL_CI_INSPECTION", view: "diff", from: "00067", to: "00063" } as never,
        20_000,
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT", message: expect.stringContaining("backwards") });
  });

  it("refuses a version diffed against itself", async () => {
    const { conn } = fakeConn({ sources: MAIN_SOURCES });
    await expect(
      abapRead(
        conn,
        { object: "CL_CI_INSPECTION", view: "diff", from: "00067", to: "00067" } as never,
        20_000,
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
  });

  it("refuses an unknown version and names what is available", async () => {
    const { conn } = fakeConn({ sources: MAIN_SOURCES });
    await expect(
      abapRead(conn, { object: "CL_CI_INSPECTION", view: "diff", to: "NOPE" } as never, 20_000),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("00067"),
    });
  });

  it("refuses a positional #N handle instead of resolving it against a shifting feed", async () => {
    const { conn } = fakeConn({ sources: MAIN_SOURCES });
    await expect(
      abapRead(conn, { object: "CL_CI_INSPECTION", view: "diff", to: "#1" } as never, 20_000),
    ).rejects.toMatchObject({
      code: "BAD_INPUT",
      message: expect.stringContaining("does not have positions"),
    });
  });

  it("says so when two released versions are identical, which is a different fact", async () => {
    const same = {
      [MAIN("00067")]: classSource("SAME"),
      [MAIN("00066")]: classSource("SAME"),
    };
    const { conn } = fakeConn({ sources: same });
    const r = await abapRead(conn, { object: "CL_CI_INSPECTION", view: "diff" } as never, 20_000);
    expect(r.text).toContain("no differences");
    expect(r.text).toContain("added: 0");
    // …and it names the two versions, so it cannot be mistaken for the $TMP case.
    expect(r.text).toContain("00066");
    expect(r.text).toContain("00067");
  });
});

// ---------------------------------------------------------------------------
// (4) C-2 — where the version number lives, and what atom:title is not.
// ---------------------------------------------------------------------------

describe("version numbers come from content/@src, not atom:id", () => {
  it("the library's own parser destroys the padding on atom:id", () => {
    // This is why atom:id is not read. `fullParse` is fast-xml-parser with
    // parseAttributeValue/parseTagValue on: 00067 becomes the NUMBER 67 and
    // 00000 becomes 0, before any consumer can see the string.
    const entries = xmlArray(fullParse(MAIN_FEED), "atom:feed", "atom:entry") as Array<
      Record<string, unknown>
    >;
    expect(entries[0]!["atom:id"]).toBe(0);
    expect(entries[1]!["atom:id"]).toBe(67);
    expect(typeof entries[1]!["atom:id"]).toBe("number");
  });

  it("recovers the padded number from the content URL", () => {
    expect(versionIdFromContentUri(MAIN("00067"))).toBe("00067");
    expect(versionIdFromContentUri(MAIN("00000"))).toBe("00000");
    expect(versionIdFromContentUri(TC("00004"))).toBe("00004");
    expect(
      versionIdFromContentUri(
        "/sap/bc/adt/programs/programs/zdemo/source/main/versions/20180205111235/00012/content",
      ),
    ).toBe("00012");
  });

  it("returns nothing rather than a guess when the URL is not a version URL", () => {
    expect(versionIdFromContentUri("")).toBe("");
    expect(versionIdFromContentUri("/sap/bc/adt/oo/classes/cl_x/source/main")).toBe("");
    // A numeric segment in the right position but the wrong shape around it.
    expect(versionIdFromContentUri("/sap/bc/adt/cts/transportrequests/00007/content")).toBe("");
  });

  it("renders the padded number, and accepts it padded or bare", async () => {
    const { conn, rec } = fakeConn({ feed: TC_FEED, sources: TC_SOURCES });
    const r = await abapRead(conn, { object: "CL_CI_INSPECTION", view: "history" } as never, 20_000);
    expect(tableRows(r.text).map((l) => l.split(/\s+/)[0])).toEqual([
      "00000",
      "00004",
      "00003",
      "00002",
      "00001",
    ]);

    for (const selector of ["00002", "2"]) {
      rec.sourceRequests.length = 0;
      await abapRead(
        conn,
        { object: "CL_CI_INSPECTION", view: "diff", from: selector, to: "00004" } as never,
        20_000,
      );
      expect(rec.sourceRequests.sort()).toEqual([TC("00002"), TC("00004")].sort());
    }
  });

  it("selects by transport request name, case-insensitively", async () => {
    const { conn, rec } = fakeConn({ feed: TC_FEED, sources: TC_SOURCES });
    await abapRead(
      conn,
      { object: "CL_CI_INSPECTION", view: "diff", from: "a4hk900017", to: "A4HK900021" } as never,
      20_000,
    );
    expect(rec.sourceRequests.sort()).toEqual([TC("00002"), TC("00004")].sort());
  });

  it("shows atom:title as the transport's prose, and refuses to select on it", async () => {
    const { conn } = fakeConn({ feed: TC_FEED, sources: TC_SOURCES });
    const r = await abapRead(conn, { object: "CL_CI_INSPECTION", view: "history" } as never, 20_000);
    // Free prose, on the entries whose transport had a description.
    expect(r.text).toContain("sum required notes");
    expect(r.text).toContain("Apply Notes for ATC and S/4HANA Readiness Checks");
    expect(r.text).toContain("TRANSPORT description in free prose");

    await expect(
      abapRead(
        conn,
        { object: "CL_CI_INSPECTION", view: "diff", to: "sum required notes" } as never,
        20_000,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("renders an entry with no author, no date and no transport link without inventing any", async () => {
    // Entry 00001 of this capture carries an empty <atom:author/>, no
    // atom:updated and no atom:link at all. The library leaves author as the
    // empty string there — the prior-art claim that an author is always present
    // does not hold on A4H.
    const raw = (await libRevisions(
      { request: async () => ({ body: TC_FEED }) },
      classStructure(),
    )) as Array<{ author?: string; date: string; version: string }>;
    const bare = raw[4]!;
    expect(bare.author).toBe("");
    expect(bare.date).toBe("");
    expect(bare.version).toBe("");

    const { conn } = fakeConn({ feed: TC_FEED });
    const r = await abapRead(conn, { object: "CL_CI_INSPECTION", view: "history" } as never, 20_000);
    expect(tableRows(r.text).at(-1)).toMatch(/^00001\s*$/);
    expect(r.text).toContain("the feed's own silence, not a lookup failure");
  });

  it("holds on a second, independent object", async () => {
    const raw = await libRevisions(
      { request: async () => ({ body: TC2_FEED }) },
      classStructure("/sap/bc/adt/oo/classes/cl_ci_test_s4h_dd_enhancements"),
    );
    const entries = normaliseRevisions(raw as never);
    expect(entries.map((e) => e.versionId)).toEqual([
      "00000",
      "00004",
      "00003",
      "00002",
      "00001",
    ]);
    expect(entries[0]!.kind).toBe("active");
    expect(releasedVersions(entries)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// (5) C-6 — a class is versioned per INCLUDE. Defaulting silently means a
//     change in testclasses reports "no differences".
// ---------------------------------------------------------------------------

describe("class includes", () => {
  it("defaults to main and says so", async () => {
    const { conn, rec } = fakeConn({ feed: TC_FEED });
    const r = await abapRead(conn, { object: "CL_CI_INSPECTION", view: "history" } as never, 20_000);
    expect(rec.feedRequests).toEqual([
      "/sap/bc/adt/oo/classes/cl_ci_inspection/includes/main/versions",
    ]);
    expect(r.text).toContain("include: main");
    expect(r.text).toContain('covers class include "main" ONLY');
    expect(r.text).toContain("definitions, implementations, macros, testclasses");
  });

  it("follows the versions link of the include the caller named", async () => {
    const { conn, rec } = fakeConn({ feed: TC_FEED, sources: TC_SOURCES });
    const r = await abapRead(
      conn,
      { object: "CL_CI_INSPECTION", view: "diff", include: "testclasses" } as never,
      20_000,
    );
    expect(rec.feedRequests).toEqual([
      "/sap/bc/adt/oo/classes/cl_ci_inspection/includes/testclasses/versions",
    ]);
    expect(r.text).toContain("include: testclasses");
    expect(r.text).toContain('covers class include "testclasses" ONLY');
    expect(rec.sourceRequests.sort()).toEqual([TC("00003"), TC("00004")].sort());
  });

  it("takes the include from the object reference when one was given there", async () => {
    stub.object = resolved({
      include: "implementations",
      uri: "/sap/bc/adt/oo/classes/cl_ci_inspection",
    } as Partial<ResolvedObject>);
    const { conn, rec } = fakeConn({ feed: TC_FEED });
    const r = await abapRead(
      conn,
      { object: "CL_CI_INSPECTION/includes/implementations", view: "history" } as never,
      20_000,
    );
    expect(rec.feedRequests).toEqual([
      "/sap/bc/adt/oo/classes/cl_ci_inspection/includes/implementations/versions",
    ]);
    expect(r.text).toContain("include: implementations");
  });

  it("refuses two different includes rather than picking one", async () => {
    stub.object = resolved({ include: "main" } as Partial<ResolvedObject>);
    const { conn } = fakeConn({ feed: TC_FEED });
    await expect(
      abapRead(
        conn,
        { object: "CL_CI_INSPECTION", view: "history", include: "testclasses" } as never,
        20_000,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("the versions relation really is per-include, and testclasses really does carry one", () => {
    // Settles a contradiction that reached master in doc/analysis/
    // version-diff-prior-art.md (commit 538182c), which states the relation
    // appears FOUR times and drops `testclasses`. This is a live-captured
    // objectStructure response (CL_ABAP_UNIT_ASSERT, HTTP 200, captured
    // 2026-08-01) already in this repo, and it carries the relation FIVE times
    // — testclasses included. So the two captured testclasses version feeds
    // were fetched from an href the server itself published; no URL was
    // templated, and the link-following design holds.
    const struct = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "fixtures",
        "live-captured",
        "455-ver-objectstructure-class-control.xml",
      ),
      "utf8",
    );
    const hrefs = [...struct.matchAll(/href="([^"]*)"[^>]*relations\/versions/g)].map((m) => m[1]);
    expect(hrefs).toEqual([
      "includes/definitions/versions",
      "includes/implementations/versions",
      "includes/macros/versions",
      "includes/testclasses/versions",
      "includes/main/versions",
    ]);
    // Not one link on the object itself: five, one per include.
    expect(struct.match(/relations\/versions/g)).toHaveLength(5);
  });

  it("names the includes that DO carry history when the requested one does not", async () => {
    // Enumerated from the object's own structure document, never from a fixed
    // list this code decided on.
    const { conn } = fakeConn({
      feed: TC_FEED,
      structure: classStructure("/sap/bc/adt/oo/classes/cl_ci_inspection", ["main", "testclasses"]),
    });
    await expect(
      abapRead(
        conn,
        { object: "CL_CI_INSPECTION", view: "history", include: "macros" } as never,
        20_000,
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
      // Listed in the order the object's own structure document lists them,
      // not in an order this code imposes.
      message: expect.stringContaining(
        "The includes that DO carry one on this object are: testclasses, main",
      ),
      hint: expect.stringContaining('include="testclasses"'),
    });
  });

  it("refuses include on an object that has no includes", async () => {
    stub.object = resolved({
      kind: "PROG",
      type: "PROG/P",
      name: "ZDEMO",
      uri: "/sap/bc/adt/programs/programs/zdemo",
    } as Partial<ResolvedObject>);
    const { conn } = fakeConn({ structure: PROGRAM_STRUCTURE, feed: TMP_FEED });
    await expect(
      abapRead(conn, { object: "ZDEMO", view: "history", include: "testclasses" } as never, 20_000),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});

// ---------------------------------------------------------------------------
// (6) Refusals: incompatible parameters, and parameters with no view.
// ---------------------------------------------------------------------------

describe("refusals", () => {
  it.each([
    ["method", { method: "RUN" }],
    ["outline", { outline: true }],
    ["version", { version: "active" }],
    ["format", { format: "raw" }],
    ["enhancements", { enhancements: true }],
  ])("refuses view=diff combined with %s instead of ignoring it", async (_label, extra) => {
    const { conn } = fakeConn();
    await expect(
      abapRead(conn, { object: "CL_CI_INSPECTION", view: "diff", ...extra } as never, 20_000),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it.each(["from", "to", "context"])(
    "refuses view=history combined with the diff-only parameter %s",
    async (param) => {
      const { conn } = fakeConn();
      await expect(
        abapRead(
          conn,
          {
            object: "CL_CI_INSPECTION",
            view: "history",
            [param]: param === "context" ? 2 : "00067",
          } as never,
          20_000,
        ),
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    },
  );

  /**
   * `include` USED TO BE IN THIS LIST and is deliberately no longer.
   *
   * The point the case was making is still exactly right — a parameter that is
   * accepted and then discarded is a defect, and silence about it is the worse
   * half. What changed is only the classification of `include`: it is no longer
   * a parameter this tool accepts and discards, because it now routes into the
   * source read (see the block below). `from`/`to`/`context` remain diff-only
   * and remain refused.
   */
  it.each(["from", "to", "context"])(
    "refuses %s with no view rather than doing a plain read and discarding it",
    async (param) => {
      const { conn } = fakeConn();
      const value = param === "context" ? 2 : "00067";
      await expect(
        abapRead(conn, { object: "CL_CI_INSPECTION", [param]: value } as never, 20_000),
      ).rejects.toMatchObject({ code: "BAD_INPUT" });
    },
  );

  it("reports an empty feed as empty rather than as an error", async () => {
    const empty = '<?xml version="1.0"?><atom:feed xmlns:atom="http://www.w3.org/2005/Atom"/>';
    const { conn } = fakeConn({ feed: empty });
    const r = await abapRead(conn, { object: "CL_CI_INSPECTION", view: "history" } as never, 20_000);
    expect(r.text).toContain("versions: 0");
    expect(r.text).toContain("ADT returned no entries");
  });

  it("carries no etag: neither a history listing nor a diff is a write token", async () => {
    const { conn } = fakeConn({ sources: MAIN_SOURCES });
    const h = await abapRead(conn, { object: "CL_CI_INSPECTION", view: "history" } as never, 20_000);
    expect(h.etag).toBe("");
    expect(h.text).not.toContain("etag:");
    const d = await abapRead(conn, { object: "CL_CI_INSPECTION", view: "diff" } as never, 20_000);
    expect(d.etag).toBe("");
    expect(d.text).not.toContain("etag:");
  });

  it("ships no invented derivation note about link fallbacks", async () => {
    // The first draft shipped a doc-constant describing how a transport name
    // would be derived "from the first link" when no transport-typed link was
    // present — a case that cannot occur, because untransported entries carry
    // no atom:link at all. It was deleted rather than left in every response.
    const { conn } = fakeConn({ feed: TC_FEED });
    const r = await abapRead(conn, { object: "CL_CI_INSPECTION", view: "history" } as never, 20_000);
    expect(r.text).not.toContain("UNVERIFIED");
    expect(r.text).not.toContain("first link");
    expect(r.text).not.toContain("transportrequests.v1+xml");
  });
});

// ---------------------------------------------------------------------------
// (7) Read mode is sufficient — the whole feature is GETs.
// ---------------------------------------------------------------------------

describe("read-mode sufficiency", () => {
  /** The gate a `ABAP_MODE=read` server builds: every mutating capability off. */
  const readOnlyGate = new SafetyGate({ readOnly: true, allowPackages: [] } as never);

  it("a read-mode gate permits the operation abap_read declares", () => {
    expect(readOnlyGate.evaluate("read").allowed).toBe(true);
    expect(() => readOnlyGate.assert("read")).not.toThrow();
  });

  it('registers view=history/diff behind assert("read") and pool.withRead only', async () => {
    const { conn } = fakeConn({ feed: TC_FEED });
    const registered = new Map<string, (a: unknown) => Promise<unknown>>();
    const ops: string[] = [];
    const leases: string[] = [];
    const mcp = {
      registerTool: (name: string, _cfg: unknown, handler: (a: unknown) => Promise<unknown>) => {
        registered.set(name, handler);
      },
    } as never;

    registerReadTools(mcp, {
      pool: {
        withRead: async <T>(label: string, fn: (c: AbapConnection) => Promise<T>) => {
          leases.push(label);
          return fn(conn);
        },
      },
      safety: {
        assert: (op: string) => {
          ops.push(op);
          readOnlyGate.assert(op as never);
        },
      },
      ensureConnected: async () => {},
      errorResult: (e: unknown) => {
        throw e;
      },
      cfg: { maxResponseChars: 20_000 },
    } as never);

    const handler = registered.get("abap_read")!;
    const res = (await handler({ object: "CL_CI_INSPECTION", view: "history" })) as {
      content: Array<{ text: string }>;
    };

    // The ONLY operation asserted is "read", and the ONLY lease is a read lease.
    expect(ops).toEqual(["read"]);
    expect(leases).toEqual(["abap_read"]);
    expect(res.content[0]!.text).toContain("view: history");
  });
});

// ---------------------------------------------------------------------------
// (8) Truncation is marked.
// ---------------------------------------------------------------------------

describe("truncation is always marked", () => {
  /**
   * `n` well-separated single-line changes, i.e. exactly `n` hunks.
   *
   * The filler between changes is DISTINCT per line on purpose. Repeating an
   * identical filler line (seven blank lines, say) gives the LCS several equally
   * optimal alignments, and the one it picks can collapse the whole file into a
   * single delete-then-insert block — which would make this test assert nothing
   * about the hunk cap.
   *
   * Three filler lines per block, not more, so that `n` blocks stay well under
   * MAX_DIFF_CELLS. At seven, 300 blocks is 2,400 lines a side and 5.7M cells,
   * which trips the COARSE fallback and again yields one hunk — a different
   * ceiling than the one under test.
   */
  function blocks(n: number): [string[], string[]] {
    const older: string[] = [];
    const newer: string[] = [];
    for (let i = 0; i < n; i++) {
      const filler = Array.from({ length: 3 }, (_, k) => `* filler ${i}.${k}`);
      older.push(`WRITE / 'old ${i}'.`, ...filler);
      newer.push(`WRITE / 'new ${i}'.`, ...filler);
    }
    return [older, newer];
  }

  it("marks a hunk-count cap in the response instead of quietly dropping hunks", async () => {
    // 300 isolated single-line changes → 300 hunks, above DIFF_MAX_HUNKS (200).
    const [older, newer] = blocks(300);
    const { conn } = fakeConn({
      sources: { [MAIN("00067")]: newer.join("\n"), [MAIN("00066")]: older.join("\n") },
    });
    const r = await abapRead(
      conn,
      { object: "CL_CI_INSPECTION", view: "diff", context: 0 } as never,
      2_000_000,
    );
    expect(r.text).toContain("TRUNCATED: showing 200 of 300 hunks");
    expect(r.text).toContain("100 were withheld");
    // The header still reports the TRUE hunk count, not the shown one.
    expect(r.text).toContain("hunks: 300");
  });

  it("marks a body clipped by the response budget", async () => {
    const [older, newer] = blocks(150);
    const { conn } = fakeConn({
      sources: { [MAIN("00067")]: newer.join("\n"), [MAIN("00066")]: older.join("\n") },
    });
    const r = await abapRead(
      conn,
      { object: "CL_CI_INSPECTION", view: "diff", context: 0 } as never,
      4_000,
    );
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("--- TRUNCATED ---");
    expect(r.text).toMatch(/Returned lines 1\.\.\d+ of \d+/);
    expect(r.text).toMatch(/Fetch the next chunk with offset=\d+/);
  });

  it("marks an over-long single line rather than cutting it silently", () => {
    const long = "X".repeat(DIFF_LINE_MAX + 200);
    const result = diffSources("short", long, {});
    const rendered = renderHunks(result.hunks);
    expect(rendered).toContain("…");
    expect(rendered).not.toContain(long);
    // Only the ellipsis was added; nothing beyond the ceiling survives.
    expect(rendered.split("\n").every((l) => l.length <= DIFF_LINE_MAX + 2)).toBe(true);
  });

  it("returns hunks, not the sources: unchanged bulk never reaches the response", async () => {
    const { conn } = fakeConn({ sources: MAIN_SOURCES });
    const r = await abapRead(conn, { object: "CL_CI_INSPECTION", view: "diff" } as never, 20_000);

    expect(r.text).toContain("@@ ");
    // Context lines around the change are present…
    expect(r.text).toContain("  METHOD run.");
    // …but padding line 20, far from the only change, is not.
    expect(r.text).not.toContain("padding line 20");
    // The whole response is a fraction of either source.
    expect(r.text.length).toBeLessThan(MAIN_SOURCES[MAIN("00067")]!.length);
  });
});

// ---------------------------------------------------------------------------
// (9) The diff engine itself.
// ---------------------------------------------------------------------------

describe("diffSources", () => {
  it("treats a single trailing newline as no extra line", () => {
    expect(splitSourceLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitSourceLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(splitSourceLines("")).toEqual([]);
    expect(diffSources("a\nb\n", "a\nb").identical).toBe(true);
  });

  it("emits correct 1-based unified-diff line numbers", () => {
    const old = ["one", "two", "three", "four", "five"].join("\n");
    const neu = ["one", "two", "CHANGED", "four", "five"].join("\n");
    const r = diffSources(old, neu, { context: 1 });
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0]).toMatchObject({ oldStart: 2, oldLines: 3, newStart: 2, newLines: 3 });
    expect(renderHunks(r.hunks)).toBe(
      ["@@ -2,3 +2,3 @@", " two", "-three", "+CHANGED", " four"].join("\n"),
    );
  });

  it("splits distant changes into separate hunks and merges near ones", () => {
    const old = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    const near = [...old];
    near[10] = "A";
    near[12] = "B";
    const merged = diffSources(old.join("\n"), near.join("\n"), { context: 3 });
    expect(merged.hunks).toHaveLength(1);

    const far = [...old];
    far[5] = "A";
    far[50] = "B";
    const split = diffSources(old.join("\n"), far.join("\n"), { context: 3 });
    expect(split.hunks).toHaveLength(2);
    expect(split.totalHunks).toBe(2);
    expect(split.droppedHunks).toBe(0);
  });

  it("uses line 0 for a pure insertion into an empty side", () => {
    const r = diffSources("", "new line", {});
    expect(r.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 });
    expect(r.added).toBe(1);
    expect(r.removed).toBe(0);
  });

  it("counts additions and removals independently of hunk grouping", () => {
    const r = diffSources("a\nb\nc", "a\nx\ny\nc", { context: 0 });
    expect(r.added).toBe(2);
    expect(r.removed).toBe(1);
    expect(r.identical).toBe(false);
  });

  it("finds the minimal edit across a large mostly-identical pair", () => {
    const base = Array.from({ length: 5000 }, (_, i) => `stmt_${i}.`);
    const changed = [...base];
    changed[2500] = "stmt_2500_CHANGED.";
    const r = diffSources(base.join("\n"), changed.join("\n"), { context: 2 });
    expect(r.coarse).toBe(false);
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.hunks).toHaveLength(1);
  });

  it("falls back to a coarse hunk, and SAYS coarse, on a pathological pair", () => {
    // No shared prefix or suffix, and the trimmed product exceeds MAX_DIFF_CELLS.
    const side = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 10;
    const old = Array.from({ length: side }, (_, i) => `old_${i}`).join("\n");
    const neu = Array.from({ length: side }, (_, i) => `new_${i}`).join("\n");
    const r = diffSources(old, neu, { context: 0 });
    expect(r.coarse).toBe(true);
    expect(r.added).toBe(side);
    expect(r.removed).toBe(side);
    expect(r.hunks).toHaveLength(1);
  });

  it("reports, never hides, hunks withheld by maxHunks", () => {
    const old = Array.from({ length: 100 }, (_, i) => `l${i}`);
    const neu = old.map((l, i) => (i % 10 === 0 ? `${l}!` : l));
    const r = diffSources(old.join("\n"), neu.join("\n"), { context: 0, maxHunks: 3 });
    expect(r.hunks).toHaveLength(3);
    expect(r.totalHunks).toBe(10);
    expect(r.droppedHunks).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// revisionSource — fetching one version's source needs its content URI.
// ---------------------------------------------------------------------------

describe("revisionSource", () => {
  it("refuses a feed entry with no content URI before ever touching the connection", async () => {
    const entry: RevisionEntry = {
      versionId: "00003",
      kind: "released",
      description: "",
      transport: "",
      author: "",
      date: "",
      uri: "",
    };
    const conn = { adt: {} } as unknown as AbapConnection;

    await expect(
      revisionSource(conn, entry, { name: "CL_CI_INSPECTION", type: "CLAS/OC" }),
    ).rejects.toMatchObject({
      code: "ADT_ERROR",
      message: expect.stringContaining("carries no content URI"),
    });
  });
});

// ---------------------------------------------------------------------------
// listRevisions — forwards the resolved object's own URI verbatim.
// ---------------------------------------------------------------------------

describe("listRevisions", () => {
  it("a namespaced object's URI reaches conn.adt.revisions percent-encoded, not as literal path separators", async () => {
    const obj = resolved({
      name: "/CUST/CL_FOO",
      uri: buildUri(specForType("CLAS/OC")!, "/CUST/CL_FOO"),
    });
    let seenUri: string | undefined;
    const conn = {
      adt: {
        revisions: async (url: string) => {
          seenUri = url;
          return [];
        },
      },
    } as unknown as AbapConnection;

    await listRevisions(conn, obj);

    expect(seenUri).toBe("/sap/bc/adt/oo/classes/%2Fcust%2Fcl_foo");
  });
});

// ===========================================================================
// `include` as an ordinary source read, not a `view=`-only parameter
// ===========================================================================

/**
 * ================== EXPECTED RED UNTIL THE READ COMMIT MERGES ==============
 * Everything in this block describes `abap_read` AFTER `include` stops being
 * refused outside `view=`. On a tree without that change the first four fail
 * with BAD_INPUT ("include requires view") — which is precisely the refusal
 * this change asks us to remove, and precisely why the case was deleted from the
 * "refuses %s with no view" table above rather than left to rot.
 *
 * Written against the specified contract, not weakened to today's behaviour,
 * and not skipped.
 *
 * Note this suite mocks `resolveObject`, so `stub.object` IS the resolution —
 * these tests say nothing about how a name becomes an object, only about what
 * `abap_read` does with `include` once it has one. The URI-construction rules
 * themselves (`/includes/<x>` vs `/source/main`, no double-suffixing) are
 * pinned at their own layer in test/class-includes.test.ts.
 * ==========================================================================
 */
describe("[PENDING READ MERGE] abap_read reads a class include directly", () => {
  const CLS_URI = "/sap/bc/adt/oo/classes/cl_ci_inspection";

  /** A connection that answers any source GET and records the URI. */
  function sourceConn(): { conn: AbapConnection; gets: string[] } {
    const gets: string[] = [];
    const conn = {
      cfg: { sid: "A4H" },
      discovery: { supports: () => false, maySupport: () => false, capability: () => "unsupported" },
      get: async (url: string) => {
        gets.push(url);
        return { body: "* source\n", headers: { etag: '"W/x"' } };
      },
    } as unknown as AbapConnection;
    return { conn, gets };
  }

  it('reads the include URI and nothing else for include="testclasses"', async () => {
    stub.object = resolved();
    const { conn, gets } = sourceConn();
    await abapRead(conn, { object: "CL_CI_INSPECTION", include: "testclasses" } as never, 20_000);
    expect(
      gets,
      "the read did not go to the testclasses include. Answering the MAIN source for a request " +
        "that named testclasses is the silent downgrade this change exists to remove.",
    ).toEqual([`${CLS_URI}/includes/testclasses`]);
  });

  it('reads /source/main for an explicit include="main"', async () => {
    stub.object = resolved();
    const { conn, gets } = sourceConn();
    await abapRead(conn, { object: "CL_CI_INSPECTION", include: "main" } as never, 20_000);
    expect(gets).toEqual([`${CLS_URI}/source/main`]);
  });

  it("still reads /source/main when no include is named — the default is unchanged", async () => {
    stub.object = resolved();
    const { conn, gets } = sourceConn();
    await abapRead(conn, { object: "CL_CI_INSPECTION" } as never, 20_000);
    expect(gets).toEqual([`${CLS_URI}/source/main`]);
  });

  it("refuses an include ADT does not have, by name, without reading anything", async () => {
    stub.object = resolved();
    const { conn, gets } = sourceConn();
    const e = await abapRead(
      conn,
      { object: "CL_CI_INSPECTION", include: "ccau" } as never,
      20_000,
    ).then(
      () => undefined,
      (err: unknown) => err as AbapError,
    );
    expect(e, 'include="ccau" (the SE24 name, not the ADT name) was accepted').toBeDefined();
    expect(e!.code).toBe("UNSUPPORTED");
    expect(e!.message).toContain("testclasses");
    expect(gets, "a refusal decidable from the argument alone cost a round trip").toEqual([]);
  });

  it.each(["method", "outline", "enhancements"])(
    "refuses include together with %s, rather than quietly ignoring one of them",
    async (param) => {
      stub.object = resolved();
      const { conn } = sourceConn();
      const value = param === "method" ? "RUN" : true;
      await expect(
        abapRead(
          conn,
          { object: "CL_CI_INSPECTION", include: "testclasses", [param]: value } as never,
          20_000,
        ),
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    },
  );

  it('refuses include together with format:"raw"', async () => {
    stub.object = resolved();
    const { conn } = sourceConn();
    await expect(
      abapRead(
        conn,
        { object: "CL_CI_INSPECTION", include: "testclasses", format: "raw" } as never,
        20_000,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("refuses an include on a program — only classes have includes", async () => {
    stub.object = resolved({
      type: "PROG/P",
      kind: "PROG",
      label: "program",
      name: "ZDEMO",
      uri: "/sap/bc/adt/programs/programs/zdemo",
      sourceUri: "/sap/bc/adt/programs/programs/zdemo/source/main",
    });
    const { conn, gets } = sourceConn();
    const e = await abapRead(
      conn,
      { object: "ZDEMO", include: "testclasses" } as never,
      20_000,
    ).then(
      () => undefined,
      (err: unknown) => err as AbapError,
    );
    expect(e, "a program was asked for its testclasses include and answered anyway").toBeDefined();
    expect(e!.code).toBe("UNSUPPORTED");
    expect(e!.message).toMatch(/ZDEMO|PROG/);
    expect(gets).toEqual([]);
  });
});
