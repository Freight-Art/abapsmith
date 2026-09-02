/**
 * ST22 runtime-dump parsing — `src/adt/dumps-xml.ts`.
 *
 * Every assertion in this file is driven by the bytes A4H actually sent on
 * 2026-08-11, read from `test/fixtures/dumps/` (and, for the two request paths
 * that were never a response body, from the `.meta.json` sidecars captured
 * alongside them). Nothing here is asserted against XML written in this file.
 *
 * That is the point, and this feature is a bad place to relax it. Six of the
 * behaviours pinned below are ones a hand-written fixture would have gotten
 * wrong in the same direction as the code: the `%20` padding runs inside an
 * opaque fixed-width key, `atom:category` distinguished by `@label` rather
 * than position, `chapterOrder` not being document order, `line` not being
 * monotonic in document order, the `contents` relation being the route to
 * `/formatted`, and a valid 200 that is a 91-byte self-closing `<atom:feed/>`
 * with no close tag at all.
 *
 * Two fixtures are a matched pair — `dump-detail-v1.xml` and
 * `dump-formatted.txt` are the same dump — and only that pair is valid for
 * offset assertions. `dump-formatted-alt.txt` is a *different* dump's body and
 * is used here solely to pin what mispairing looks like.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { XMLParser } from "fast-xml-parser";
import { beforeAll, describe, expect, it } from "vitest";

import {
  DUMPS_FEED_PATH,
  DUMP_DETAIL_PATH_PREFIX,
  DUMP_KEY_DECODED_LENGTH,
  TIER1_CHAPTER_NAMES,
  VARIABLES_CHAPTER_NAME,
  type DumpDetail,
  type DumpFeed,
  type FeedCatalog,
  decodeDumpKey,
  dumpChapterExtents,
  dumpKeyFromDetailPath,
  findDumpLink,
  findDumpsFeedEntry,
  parseAdtExceptionEnvelope,
  parseDumpDetail,
  parseDumpFeed,
  parseDumpKeyFields,
  parseFeedsCatalog,
  sliceDumpChapters,
  stripAdtScheme,
} from "../src/adt/dumps-xml.js";
import { AbapError } from "../src/adt/errors.js";

// ----------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "dumps");

/** The captured bytes of `name`, exactly as the appliance sent them. */
function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

/** The `.meta.json` sidecar recording how `name` was requested. */
function meta(name: string): { requestPath: string; responseStatus: number; lineCount?: number } {
  return JSON.parse(fixture(name)) as {
    requestPath: string;
    responseStatus: number;
    lineCount?: number;
  };
}

const FEED_TOP3 = "feed-top3-next.xml";
const FEED_EMPTY = "feed-empty.xml";
const QC_VALID = "querycheck-valid.xml";
const QC_INVALID = "querycheck-invalid.xml";
const DETAIL_V1 = "dump-detail-v1.xml";
const FORMATTED = "dump-formatted.txt";
const FORMATTED_ALT = "dump-formatted-alt.txt";
const CATALOG = "feeds-catalog.xml";
const DETAIL_406 = "dump-detail-406-textplain.xml";
const DETAIL_404 = "dump-detail-404-doubleenc.xml";

// ------------------------------------------------------------- dumps feed ---

describe("parseDumpFeed — /sap/bc/adt/runtime/dumps", () => {
  let feed: DumpFeed;
  beforeAll(() => {
    feed = parseDumpFeed(fixture(FEED_TOP3));
  });

  it("reads the feed-level identity and both cursors", () => {
    expect(feed.systemId).toBe("A4H");
    expect(feed.title).toBe("ABAP Short Dump Analysis: Selected ABAP Runtime Errors");
    expect(feed.updated).toBe("2026-08-11T12:35:08Z");
    expect(feed.entries).toHaveLength(3);

    // Relative hrefs with `$` as %24, exactly as received.
    expect(feed.selfHref).toBe("/sap/bc/adt/runtime/dumps?%24top=3&from=20260811123447");
    expect(feed.nextHref).toBe("/sap/bc/adt/runtime/dumps?%24top=3&to=20260811123445");
    // self carries `from` = newest on this page; next carries `to` = the cursor.
    expect(feed.newestTimestamp).toBe("20260811123447");
    expect(feed.oldestTimestamp).toBe("20260811123445");
    expect(feed.hasMore).toBe(true);
  });

  it("reads an entry's fields from the captured bytes", () => {
    expect(feed.entries[0]).toEqual({
      key: "20260811123447a4hsandbox_A4H_00%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20DEVELOPER%20%20%20001%20%20%20%20%20%20%20%204",
      detailPath:
        "/sap/bc/adt/runtime/dump/20260811123447a4hsandbox_A4H_00%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20DEVELOPER%20%20%20001%20%20%20%20%20%20%20%204",
      user: "DEVELOPER",
      runtimeError: "SAPSQL_PARSE_ERROR",
      terminatedProgram: "ZCL_ZMCP_DMP_SQL==============CP",
      title: "An error has occurred while parsing a dynamic entry.",
      published: "2026-08-11T12:34:47Z",
      updated: "2026-08-11T12:34:47Z",
      guiPath:
        "/sap/bc/adt/vit/runtime/dumps/20260811123447a4hsandbox_A4H_00%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20DEVELOPER%20%20%20001%20%20%20%20%20%20%20%204",
      sapGuiUri:
        "adt://A4H/sap/bc/adt/vit/runtime/dumps/20260811123447a4hsandbox_A4H_00%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20DEVELOPER%20%20%20001%20%20%20%20%20%20%20%204",
    });
  });

  it("PINS the key against the raw bytes — byte-identical, still encoded", () => {
    // Independently re-extract every rel="self" href straight out of the
    // fixture. If the parser normalised anything at all — a decode, a trim, a
    // collapsed %20 run — these lists diverge.
    const raw = fixture(FEED_TOP3);
    const hrefs = [
      ...raw.matchAll(/<atom:link href="(adt:\/\/[^"]*\/runtime\/dump\/[^"]*)" rel="self"/g),
    ].map((m) => m[1] as string);
    expect(hrefs).toHaveLength(3);

    const expectedKeys = hrefs.map((h) => h.slice(h.indexOf(DUMP_DETAIL_PATH_PREFIX) + DUMP_DETAIL_PATH_PREFIX.length));
    expect(feed.entries.map((e) => e.key)).toEqual(expectedKeys);

    for (const entry of feed.entries) {
      expect(entry.key).toContain("%20");
      expect(entry.key.trim()).toBe(entry.key);
      expect(entry.detailPath).toBe(DUMP_DETAIL_PATH_PREFIX + entry.key);
    }
  });

  it("PINS the decoded key as exactly 70 fixed-width characters", () => {
    for (const entry of feed.entries) {
      expect(decodeDumpKey(entry.key)).toHaveLength(DUMP_KEY_DECODED_LENGTH);
      expect(DUMP_KEY_DECODED_LENGTH).toBe(70);
    }
    // ts(14) + host(32) + user(12) + client(3) + modno(9). Offsets, not
    // delimiters: host and user are space-padded, so splitting on whitespace
    // would merge them.
    expect(parseDumpKeyFields(feed.entries[0]!.key)).toEqual({
      timestamp: "20260811123447",
      serverInstance: "a4hsandbox_A4H_00",
      user: "DEVELOPER",
      // "001", never the number 1 — the client field is zero-padded.
      client: "001",
      modeNumber: "4",
    });
    expect(parseDumpKeyFields(feed.entries[0]!.key)?.client).toBe("001");
  });

  it("returns undefined, never a fabricated timestamp, for a key with no recoverable fields", () => {
    // Empty, a path with nothing after the separator, and a decoded length
    // short of the fixed 70 all fail the same length gate — none of them
    // should synthesize a timestamp field instead of admitting nothing was
    // recovered.
    expect(parseDumpKeyFields("")).toBeUndefined();
    expect(dumpKeyFromDetailPath(DUMP_DETAIL_PATH_PREFIX)).toBeUndefined();
    expect(parseDumpKeyFields("20260811123447")).toBeUndefined();
  });

  it("PINS the re-encoding trap against the captured 404 request path", () => {
    // The appliance answered this exact path with 404. It is what
    // `encodeURIComponent` over the already-encoded key produces: every `%`
    // becomes `%25`, so each `%20` pad becomes `%2520`.
    const notFound = meta("dump-detail-404-doubleenc.meta.json");
    expect(notFound.responseStatus).toBe(404);

    const key = feed.entries[0]!.key;
    expect(DUMP_DETAIL_PATH_PREFIX + encodeURIComponent(key)).toBe(notFound.requestPath);
    // ...and the path built from the untouched key is the one that worked.
    const ok = meta("dump-detail-v1.meta.json");
    expect(ok.responseStatus).toBe(200);
    expect(DUMP_DETAIL_PATH_PREFIX + key).toBe(ok.requestPath);

    // The other two captured mutations, over the same bytes: both change the
    // key, and both were 404s on the wire.
    expect(key.replace(/(?:%20)+/g, "%20")).not.toBe(key);
    expect(key.replace(/(?:%20)/g, "")).not.toBe(key);
  });

  it("recovers a key from a request path that was never a response body", () => {
    // The 406 capture is a *different* dump, and no detail XML exists for it —
    // its key survives only in the sidecar. The fixed-width layout holds there
    // too, which is what makes the layout a property of the key rather than of
    // one capture.
    const other = meta("dump-detail-406-textplain.meta.json");
    const key = dumpKeyFromDetailPath(other.requestPath);
    expect(key).toBeDefined();
    expect(decodeDumpKey(key!)).toHaveLength(DUMP_KEY_DECODED_LENGTH);
    expect(parseDumpKeyFields(key!)).toEqual({
      timestamp: "20260811082715",
      serverInstance: "a4hsandbox_A4H_00",
      user: "DEVELOPER",
      client: "001",
      modeNumber: "6",
    });
  });

  it("PINS category discrimination on @label, not on position", () => {
    const raw = fixture(FEED_TOP3);
    const byLabel = (label: string): string[] =>
      [
        ...raw.matchAll(
          new RegExp(`<atom:category term="([^"]*)" label="${label.replace(/ /g, " ")}"/>`, "g"),
        ),
      ].map((m) => m[1] as string);

    expect(feed.entries.map((e) => e.runtimeError)).toEqual(byLabel("ABAP runtime error"));
    expect(feed.entries.map((e) => e.terminatedProgram)).toEqual(
      byLabel("Terminated ABAP program"),
    );
    // The two labels really do carry different values, so a positional reader
    // that swapped them would produce a wrong answer rather than the same one.
    expect(feed.entries[0]!.runtimeError).not.toBe(feed.entries[0]!.terminatedProgram);
  });

  it("keeps atom:id as a GUI path and never as the key", () => {
    for (const entry of feed.entries) {
      expect(entry.guiPath).toContain("/sap/bc/adt/vit/runtime/dumps/");
      expect(entry.detailPath).not.toContain("/vit/");
      expect(entry.detailPath.startsWith(DUMP_DETAIL_PATH_PREFIX)).toBe(true);
    }
  });

  it("PINS that atom:summary and the author URI are discarded", () => {
    const raw = fixture(FEED_TOP3);
    const summaries = [...raw.matchAll(/<atom:summary type="html">([\s\S]*?)<\/atom:summary>/g)].map(
      (m) => m[1] as string,
    );
    expect(summaries).toHaveLength(3);
    // ~13 KB each: 90% of the feed's bytes, and a duplicate of the detail.
    const summaryBytes = summaries.reduce((n, s) => n + s.length, 0);
    expect(summaryBytes / raw.length).toBeGreaterThan(0.9);

    const serialised = JSON.stringify(feed);
    expect(serialised).not.toContain("showInRuntimeViewerLink");
    expect(serialised).not.toContain("&lt;p&gt;");
    // The junk SAP-internal people URL on atom:author/atom:uri goes too.
    expect(raw).toContain("people.wdf.sap.corp");
    expect(serialised).not.toContain("people.wdf.sap.corp");
    // Net effect: the parsed page is an order of magnitude smaller than the wire.
    expect(serialised.length).toBeLessThan(raw.length / 10);
  });

  it("tolerates a well-formed feed with zero entries", () => {
    const empty = parseDumpFeed(fixture(FEED_EMPTY));
    expect(empty.entries).toEqual([]);
    expect(empty.systemId).toBe("A4H");
    // No rel="next" on a last page — absence is the "no more" signal.
    expect(empty.nextHref).toBeUndefined();
    expect(empty.oldestTimestamp).toBeUndefined();
    expect(empty.hasMore).toBe(false);
    // A single feed-level atom:link still has to be found (see the isArray pin).
    expect(empty.selfHref).toBe(
      "/sap/bc/adt/runtime/dumps?%24query=and%20%28%20equals%20%28%20user%20%2c%20NOSUCHUSER%20%29%20%29",
    );
  });

  it("PINS the self-closing <atom:feed/> of $queryCheck — 91 bytes, no close tag", () => {
    const raw = fixture(QC_VALID);
    expect(raw).toHaveLength(91);
    expect(raw.trimEnd().endsWith("/>")).toBe(true);
    expect(raw).not.toContain("</atom:feed>");

    // fast-xml-parser renders it as the STRING "", not an object — so any
    // parser that walks straight into `doc.feed.entry` throws on a 200.
    const naive = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true }).parse(raw) as {
      feed: unknown;
    };
    expect(naive.feed).toBe("");
    expect(typeof naive.feed).toBe("string");

    expect(() => parseDumpFeed(raw)).not.toThrow();
    const checked = parseDumpFeed(raw);
    expect(checked.entries).toEqual([]);
    expect(checked.hasMore).toBe(false);
  });
});

// ----------------------------------------------------------- dump detail ---

describe("parseDumpDetail — dump:dump", () => {
  let detail: DumpDetail;
  beforeAll(() => {
    detail = parseDumpDetail(fixture(DETAIL_V1));
  });

  it("reads all nine root attributes", () => {
    expect(detail.title).toBe("Runtime Error: SAPSQL_PARSE_ERROR 11.08.2026 12:34:47 DEVELOPER");
    expect(detail.error).toBe("SAPSQL_PARSE_ERROR");
    expect(detail.author).toBe("DEVELOPER");
    expect(detail.exception).toBe("CX_SY_DYNAMIC_OSQL_SEMANTICS");
    // For a class this is the generated pool, not the class name — which is
    // why the termination link, not this, is what resolves to source.
    expect(detail.terminatedProgram).toBe("ZCL_ZMCP_DMP_SQL==============CP");
    expect(detail.serverInstance).toBe("a4hsandbox_A4H_00");
    expect(detail.datetime).toBe("2026-08-11T12:34:47Z");
    expect(detail.systemDate).toBe("11.08.2026");
    expect(detail.systemTime).toBe("12:34:47");
  });

  it("PINS an empty attribute as \"\" rather than a missing value", () => {
    // contentType="" is literally in the bytes on the termination link. The
    // same code path carries dump:dump/@exception, which is "" for every
    // classic non-class-based runtime error — empty must be a value, not a
    // parse failure, or the commonest kind of dump becomes unreadable.
    expect(fixture(DETAIL_V1)).toContain('contentType=""');
    const termination = findDumpLink(detail.links, "termination");
    expect(termination?.contentType).toBe("");
    expect(typeof termination?.contentType).toBe("string");
  });

  it("matches relations in BOTH the bare-token and absolute-URI forms", () => {
    const raw = fixture(DETAIL_V1);
    // The server is inconsistent inside one document: three bare, four absolute.
    expect(raw).toContain('relation="contents"');
    expect(raw).toContain('relation="http://www.sap.com/adt/relations/runtime/dump/termination"');

    expect(detail.links.map((l) => l.relationToken)).toEqual([
      "contents",
      "unformatted",
      "self",
      "alternate",
      "summary",
      "termination",
      "http",
    ]);
    expect(findDumpLink(detail.links, "unformatted")?.relation).toBe(
      "http://www.sap.com/adt/relations/runtime/dump/unformatted",
    );
    expect(findDumpLink(detail.links, "contents")?.relation).toBe("contents");
  });

  it("PINS /formatted as relation=contents — there is no 'formatted' relation", () => {
    expect(fixture(DETAIL_V1)).not.toContain("relations/runtime/dump/formatted");
    expect(detail.links.some((l) => l.relationToken === "formatted")).toBe(false);

    expect(detail.formattedPath).toBe(
      "/sap/bc/adt/runtime/dump/20260811123447a4hsandbox_A4H_00%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20DEVELOPER%20%20%20001%20%20%20%20%20%20%20%204/formatted",
    );
    // And it is the same key as the detail resource, byte for byte.
    expect(detail.formattedPath).toBe(meta("dump-formatted.meta.json").requestPath);
  });

  it("resolves the termination link to an abap_read-consumable path", () => {
    // The server resolved the object type itself: /oo/classes/... for a class.
    expect(detail.termination).toEqual({
      path: "/sap/bc/adt/oo/classes/zcl_zmcp_dmp_sql/source/main",
      line: 17,
    });
    expect(findDumpLink(detail.links, "termination")?.kind).toBe("adt-uri");
    expect(stripAdtScheme("adt://A4H/sap/bc/adt/oo/classes/x/source/main")).toBe(
      "/sap/bc/adt/oo/classes/x/source/main",
    );
  });

  it("flags the .../dump/http link as an unroutable absolute URL", () => {
    const http = findDumpLink(detail.links, "http");
    expect(http?.kind).toBe("external-url");
    expect(http?.uri.startsWith("https://a4hsandbox:50001/")).toBe(true);
    // Every other link is a server-relative path or an adt:// reference.
    expect(detail.links.filter((l) => l.kind === "external-url")).toHaveLength(1);
  });

  it("reads all 20 chapters", () => {
    expect(detail.chapters).toHaveLength(20);
    const names = detail.chapters.map((c) => c.name);
    expect(new Set(names).size).toBe(20);
    expect(detail.chapters[0]).toEqual({
      name: "kap5",
      title: "System environment",
      category: "System Environment",
      line: 102,
      chapterOrder: 6,
      categoryOrder: 1,
    });
  });

  it("PINS chapterOrder as NOT document order, and line as non-monotonic", () => {
    // The XML is grouped by categoryOrder, so the chapter whose chapterOrder is
    // 1 is the SIXTH element. Reading the list as it arrives and pairing each
    // chapter with its successor produces negative-length extents.
    const kap0 = detail.chapters[5]!;
    expect(kap0.name).toBe("kap0");
    expect(kap0.chapterOrder).toBe(1);
    expect(detail.chapters[0]!.chapterOrder).toBe(6);

    const documentOrderLines = detail.chapters.map((c) => c.line);
    const ascending = [...documentOrderLines].sort((a, b) => a - b);
    expect(documentOrderLines).not.toEqual(ascending);
    // Concretely: 171 is followed by 16.
    expect(documentOrderLines.slice(2, 4)).toEqual([171, 16]);
  });

  it("PINS matching on @name, never on @title", () => {
    // The titles are release- and language-dependent: kap10 is "Selected
    // Variables" here and "Chosen Variables" on other releases.
    const kap10 = detail.chapters.find((c) => c.name === VARIABLES_CHAPTER_NAME);
    expect(kap10?.title).toBe("Selected Variables");
    expect(detail.chapters.some((c) => c.title === "Chosen Variables")).toBe(false);

    // A title-keyed caller gets silence, not an error — which is exactly why
    // the selector has to be the name.
    const formatted = fixture(FORMATTED);
    expect(
      sliceDumpChapters(detail.chapters, formatted, detail.chapters.map((c) => c.title)),
    ).toBe("");
    expect(
      sliceDumpChapters(detail.chapters, formatted, [VARIABLES_CHAPTER_NAME]).length,
    ).toBeGreaterThan(0);
  });

  it("refuses an ADT exception envelope instead of returning an empty dump", () => {
    // A 406/404 body parsed as a detail otherwise yields a dump with no title,
    // which reads downstream as data rather than as an error.
    for (const [name, type] of [
      [DETAIL_406, "ExceptionResourceNotAcceptable"],
      [DETAIL_404, "notFound"],
    ] as const) {
      let thrown: unknown;
      try {
        parseDumpDetail(fixture(name));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(AbapError);
      expect((thrown as AbapError).code).toBe("ADT_ERROR");
      expect((thrown as AbapError).message).toContain(type);
    }
  });

  it("reads the exception envelopes as structured values", () => {
    expect(parseAdtExceptionEnvelope(fixture(DETAIL_404))).toEqual({
      namespace: "com.sap.adt.runtime.dump",
      type: "notFound",
      message: "An exception was raised",
    });
    expect(parseAdtExceptionEnvelope(fixture(QC_INVALID))).toEqual({
      namespace: "com.sap.adt",
      type: "ExceptionInvalidData",
      message: "Data is invalid and could not be converted",
    });
    // A real payload is not an envelope.
    expect(parseAdtExceptionEnvelope(fixture(DETAIL_V1))).toBeUndefined();
  });

  it("refuses a $queryCheck error body as a feed", () => {
    expect(() => parseDumpFeed(fixture(QC_INVALID))).toThrow(AbapError);
    expect(() => parseDumpFeed(fixture(QC_INVALID))).toThrow(/ExceptionInvalidData/);
  });
});

// --------------------------------------------------------- chapter slices ---

describe("chapter slicing — dump-detail-v1.xml paired with dump-formatted.txt", () => {
  let detail: DumpDetail;
  let formatted: string;
  let lines: string[];
  beforeAll(() => {
    detail = parseDumpDetail(fixture(DETAIL_V1));
    formatted = fixture(FORMATTED);
    lines = formatted.split("\n");
  });

  it("has the captured body shape: 1811 lines, no trailing newline", () => {
    expect(lines).toHaveLength(1811);
    expect(lines.length).toBe(meta("dump-formatted.meta.json").lineCount);
    expect(formatted.endsWith("\n")).toBe(false);
  });

  it("PINS 20/20 — every chapter's line offset lands on its own banner line", () => {
    const misses: string[] = [];
    let hits = 0;
    for (const chapter of detail.chapters) {
      const banner = lines[chapter.line - 1];
      if (banner !== undefined && banner.includes(chapter.title)) hits++;
      else misses.push(`${chapter.name}@${chapter.line}: ${JSON.stringify(banner)}`);
    }
    expect(misses).toEqual([]);
    expect(hits).toBe(20);
    expect(hits).toBe(detail.chapters.length);

    // Spot-check the two ends against the literal bytes.
    expect(lines[10]).toContain("Short Text");
    expect(lines[1786]).toContain("ABAP Control Blocks (CONT)");
  });

  it("produces sorted, contiguous extents; the last runs to EOF", () => {
    const extents = dumpChapterExtents(detail.chapters, lines.length);
    expect(extents).toHaveLength(20);
    expect(extents.map((e) => e.chapter.name)[0]).toBe("kap0");
    for (let i = 0; i < extents.length; i++) {
      const e = extents[i]!;
      expect(e.end).toBeGreaterThan(e.start);
      expect(e.start).toBe(e.chapter.line - 1);
      const next = extents[i + 1];
      if (next !== undefined) expect(e.end).toBe(next.start);
    }
    expect(extents[0]!.start).toBe(10);
    expect(extents[19]!.chapter.name).toBe("kap19");
    expect(extents[19]!.end).toBe(1811);
  });

  it("reproduces the body byte-for-byte when every chapter is selected", () => {
    const all = sliceDumpChapters(
      detail.chapters,
      formatted,
      detail.chapters.map((c) => c.name),
    );
    // From the first banner to EOF, nothing added, nothing dropped.
    expect(all).toBe(lines.slice(10).join("\n"));
    expect(all.split("\n")).toHaveLength(1801);
    expect(all.endsWith("\n")).toBe(false);
  });

  it("keeps the tier-1 default to ~5% of the body and excludes kap10", () => {
    const tier1 = sliceDumpChapters(detail.chapters, formatted, TIER1_CHAPTER_NAMES);
    expect(TIER1_CHAPTER_NAMES).toEqual(["kap7", "kap8", "kap9", "kap11"]);
    expect(tier1.split("\n")).toHaveLength(97);
    expect(tier1.split("\n").length / lines.length).toBeLessThan(0.06);

    for (const title of [
      "Information on where terminated",
      "Source Code Extract",
      "Contents of system fields",
      "Active Calls/Events",
    ]) {
      expect(tier1).toContain(title);
    }
    expect(TIER1_CHAPTER_NAMES).not.toContain(VARIABLES_CHAPTER_NAME);
    expect(tier1).not.toContain("|Selected Variables");
  });

  it("PINS kap10 as the bulk of the body — the chapter worth gating", () => {
    const variables = sliceDumpChapters(detail.chapters, formatted, [VARIABLES_CHAPTER_NAME]);
    expect(variables.split("\n")).toHaveLength(1095);
    expect(variables.split("\n").length / lines.length).toBeGreaterThan(0.6);
    // Lines 317..1411 inclusive: it starts at its own banner and stops at kap22's.
    expect(variables.split("\n")[0]).toBe(lines[316]);
    expect(lines[1411]).toContain("Application Calls");
  });

  it("ignores names no chapter carries, and an empty selection", () => {
    expect(sliceDumpChapters(detail.chapters, formatted, ["kap999"])).toBe("");
    expect(sliceDumpChapters(detail.chapters, formatted, [])).toBe("");
    // A partially-known set still yields what exists.
    expect(sliceDumpChapters(detail.chapters, formatted, ["kap999", "kap8"])).toBe(
      sliceDumpChapters(detail.chapters, formatted, ["kap8"]),
    );
  });

  it("PINS what mispairing looks like — alt body scores 0/20 and never throws", () => {
    // dump-formatted-alt.txt is a DIFFERENT dump's body: 622 lines against a
    // chapter table whose offsets run to 1787.
    const alt = fixture(FORMATTED_ALT);
    const altLines = alt.split("\n");
    expect(altLines).toHaveLength(622);
    expect(altLines.length).toBe(meta("dump-formatted-alt.meta.json").lineCount);

    let hits = 0;
    for (const chapter of detail.chapters) {
      if ((altLines[chapter.line - 1] ?? "").includes(chapter.title)) hits++;
    }
    expect(hits).toBe(0);

    // Clamped rather than thrown or out-of-range: the six chapters whose
    // offsets fall past EOF collapse to empty extents.
    const extents = dumpChapterExtents(detail.chapters, altLines.length);
    expect(extents).toHaveLength(20);
    for (const e of extents) {
      expect(e.start).toBeGreaterThanOrEqual(0);
      expect(e.end).toBeLessThanOrEqual(altLines.length);
      expect(e.end).toBeGreaterThanOrEqual(e.start);
    }
    expect(extents.filter((e) => e.end === e.start).length).toBeGreaterThan(0);
    expect(() => sliceDumpChapters(detail.chapters, alt, TIER1_CHAPTER_NAMES)).not.toThrow();
  });
});

// -------------------------------------------------- feeds catalog + contract ---

describe("parseFeedsCatalog — /sap/bc/adt/feeds", () => {
  let catalog: FeedCatalog;
  beforeAll(() => {
    catalog = parseFeedsCatalog(fixture(CATALOG));
  });

  it("reads all five entries", () => {
    expect(catalog.systemId).toBe("A4H");
    expect(catalog.title).toBe("ABAP System Monitoring");
    expect(catalog.entries).toHaveLength(5);
    expect(catalog.entries.map((e) => e.id)).toEqual([
      "/sap/bc/adt/gw/errorlog",
      DUMPS_FEED_PATH,
      "/sap/bc/adt/error/urimapper?user=DEVELOPER",
      "/sap/bc/adt/atc/feeds/verdicts",
      "/sap/bc/adt/runtime/systemmessages",
    ]);
  });

  it("PINS capability detection on atom:id / content@src — a rel=self probe finds nothing", () => {
    const raw = fixture(CATALOG);
    // There is not one rel="self" anywhere in the catalog.
    expect(raw).not.toContain('rel="self"');

    const dumps = findDumpsFeedEntry(catalog);
    expect(dumps).toBeDefined();
    expect(catalog.entries.indexOf(dumps!)).toBe(1); // the SECOND entry
    expect(dumps!.title).toBe("ABAP Runtime Errors");
    expect(dumps!.id).toBe(DUMPS_FEED_PATH);
    expect(dumps!.contentSrc).toBe(DUMPS_FEED_PATH);
    expect(dumps!.alternateHref).toBe(DUMPS_FEED_PATH);
  });

  it("PINS the catalog dates as the feed DEFINITION date, not freshness", () => {
    const dumps = findDumpsFeedEntry(catalog)!;
    expect(dumps.published).toBe("2011-08-25T18:36:00Z");
    expect(dumps.updated).toBe("2011-08-25T18:36:00Z");
    // The dumps feed itself was updated fifteen years later, in the same capture.
    expect(parseDumpFeed(fixture(FEED_TOP3)).updated).toBe("2026-08-11T12:35:08Z");
  });

  it("parses the feed:extendedData query contract", () => {
    const ed = findDumpsFeedEntry(catalog)!.extendedData!;
    expect(ed.refresh).toEqual({ value: 5, unit: "minutes" });
    expect(ed.pageSize).toBe(50);
    expect(ed.notificationEnabled).toBe(true);
    expect(ed.operators).toHaveLength(10);
    expect(ed.dataTypes.map((d) => d.id)).toEqual(["string", "dateTime"]);
    expect(ed.attributes).toHaveLength(11);
    expect(ed.queryIsObligatory).toBe(false);
    expect(ed.queryDepth).toBe(2);
    expect(ed.queryVariants).toHaveLength(2);

    expect(ed.operators[0]).toEqual({
      id: "equals",
      numberOfOperands: 1,
      kind: "RELATIONAL",
      label: "equals",
    });
    expect(ed.operators.find((o) => o.id === "between")?.numberOfOperands).toBe(2);
    expect(ed.queryVariants[0]).toEqual({
      queryString: "and ( equals ( user , DEVELOPER ) )",
      title: "Runtime Errors caused by me (DEVELOPER)",
      isDefault: true,
    });
    expect(ed.queryVariants[1]!.isDefault).toBe(false);
  });

  it("PINS the per-attribute operator list as NOT derivable from the data type", () => {
    const ed = findDumpsFeedEntry(catalog)!.extendedData!;
    const user = ed.attributes.find((a) => a.id === "user")!;

    // `user` is a string attribute that permits exactly two operators.
    expect(user.dataTypeId).toBe("string");
    expect(user.operatorIds).toEqual(["equals", "notEquals"]);
    expect(user.operatorIds).toHaveLength(2);

    // Its data type permits four. A validator that derived an attribute's
    // operators from its type would happily build `contains ( user , X )`,
    // which this contract forbids.
    const stringType = ed.dataTypes.find((d) => d.id === "string")!;
    expect(stringType.operatorIds).toEqual(["equals", "notEquals", "contains", "notContains"]);
    expect(user.operatorIds).not.toEqual(stringType.operatorIds);

    // And `user` is the only string attribute that is narrowed — the asymmetry
    // is real, not a blanket restriction.
    const otherStrings = ed.attributes.filter((a) => a.dataTypeId === "string" && a.id !== "user");
    expect(otherStrings).toHaveLength(9);
    for (const a of otherStrings) expect(a.operatorIds).toEqual(stringType.operatorIds);

    expect(ed.attributes.find((a) => a.id === "datetime")?.dataTypeId).toBe("dateTime");
    expect(ed.attributes.find((a) => a.id === "datetime")?.operatorIds).toHaveLength(8);
  });
});

// ----------------------------------------------------------- parser config ---

describe("parser configuration — the load-bearing options", () => {
  it("PINS parseTagValue:false — the contract's text stays text", () => {
    const catalog = parseFeedsCatalog(fixture(CATALOG));
    const ed = findDumpsFeedEntry(catalog)!.extendedData!;
    expect(ed.queryIsObligatory).toBe(false);
    expect(ed.queryDepth).toBe(2);

    // The trap is real over these exact bytes. `parseTagValue` DEFAULTS to
    // true, so leaving it out — the easy mistake — turns
    // <feed:queryIsObligatory>false</...> into a boolean and
    // <feed:queryDepth>2</...> into a number before this module ever sees them.
    const coercing = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: true,
      parseAttributeValue: false,
      trimValues: true,
      // parseTagValue left at its default (true) — this is the wrong config.
    });
    const naive = coercing.parse(fixture(CATALOG)) as {
      feed: {
        entry: Array<{ extendedData?: { queryIsObligatory?: unknown; queryDepth?: unknown } }>;
      };
    };
    const dumpsEd = naive.feed.entry[1]!.extendedData!;
    expect(dumpsEd.queryIsObligatory).toBe(false);
    expect(typeof dumpsEd.queryIsObligatory).toBe("boolean");
    expect(dumpsEd.queryDepth).toBe(2);
    expect(typeof dumpsEd.queryDepth).toBe("number");

    // Correctly configured, the same bytes stay strings until this module
    // converts them deliberately.
    const strict = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: true,
      parseAttributeValue: false,
      parseTagValue: false,
      trimValues: true,
    });
    const exact = strict.parse(fixture(CATALOG)) as {
      feed: {
        entry: Array<{ extendedData?: { queryIsObligatory?: unknown; queryDepth?: unknown } }>;
      };
    };
    expect(exact.feed.entry[1]!.extendedData!.queryIsObligatory).toBe("false");
    expect(exact.feed.entry[1]!.extendedData!.queryDepth).toBe("2");
  });

  it("PINS parseAttributeValue:false — chapter offsets and operand counts stay strings", () => {
    const coercing = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: true,
      parseAttributeValue: true,
      parseTagValue: false,
      trimValues: true,
      // The wrong config: attribute coercion on.
    });
    const naive = coercing.parse(fixture(DETAIL_V1)) as {
      dump: { chapters: { chapter: Array<Record<string, unknown>> } };
    };
    const first = naive.dump.chapters.chapter[0]!;
    expect(first["@_line"]).toBe(102);
    expect(typeof first["@_line"]).toBe("number");
    expect(typeof first["@_categoryOrder"]).toBe("number");

    const naiveCatalog = coercing.parse(fixture(CATALOG)) as {
      feed: { entry: Array<{ extendedData?: Record<string, Record<string, unknown>> }> };
    };
    const ed = naiveCatalog.feed.entry[1]!.extendedData!;
    expect(typeof (ed.notification as Record<string, unknown>)["@_isEnabled"]).toBe("boolean");
    expect(typeof (ed.paging as Record<string, unknown>)["@_size"]).toBe("number");

    // With coercion off, the module hands back strings and converts only the
    // fields it declares numeric — the dump key's "001" client field stays "001".
    const detail = parseDumpDetail(fixture(DETAIL_V1));
    expect(typeof detail.chapters[0]!.line).toBe("number");
    expect(detail.serverInstance).toBe("a4hsandbox_A4H_00");
    const feed = parseDumpFeed(fixture(FEED_TOP3));
    expect(parseDumpKeyFields(feed.entries[0]!.key)?.client).toBe("001");
  });

  it("PINS isArray — a one-element collection must not collapse to an object", () => {
    // feed-empty.xml carries exactly ONE feed-level atom:link. Without an
    // isArray predicate the parser hands back an object, and every
    // rel-matching loop written against an array silently finds nothing.
    const naive = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: true,
      parseAttributeValue: false,
      parseTagValue: false,
      trimValues: true,
      // no isArray — the wrong config.
    }).parse(fixture(FEED_EMPTY)) as { feed: { link: unknown } };
    expect(Array.isArray(naive.feed.link)).toBe(false);
    expect(typeof naive.feed.link).toBe("object");

    // Configured correctly, the single link is still found.
    expect(parseDumpFeed(fixture(FEED_EMPTY)).selfHref).toBeDefined();

    // And the genuinely repeated collections come back as arrays of the right
    // length rather than as the last element.
    const detail = parseDumpDetail(fixture(DETAIL_V1));
    expect(Array.isArray(detail.links)).toBe(true);
    expect(detail.links).toHaveLength(7);
    expect(detail.chapters).toHaveLength(20);
    const catalog = parseFeedsCatalog(fixture(CATALOG));
    expect(catalog.entries).toHaveLength(5);
    expect(findDumpsFeedEntry(catalog)!.extendedData!.operators).toHaveLength(10);
  });
});
