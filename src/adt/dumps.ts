/**
 * ST22 runtime-error dumps over ADT — the I/O layer.
 *
 * Composes `dumps-query.ts` (build/validate the feed request) and
 * `dumps-xml.ts` (parse the response); adds no second URL builder or parser.
 *
 * Everything here is pinned to bytes captured from A4H on 2026-08-11, kept in
 * `test/fixtures/dumps/`. Four captures are load-bearing constraints, each
 * guarded at its point of use below: the detail resource is singular, not
 * plural ({@link dumpDetailPath}); the key travels verbatim, never
 * re-encoded ({@link assertVerbatimDumpKey}); `Accept` is per representation,
 * `text/plain` on the base detail resource is a captured 406
 * (`DUMP_DETAIL_ACCEPT`/`DUMP_FORMATTED_ACCEPT`); and a bad query parameter is
 * answered with 200 and the whole unfiltered feed, so filtering is validated
 * client-side before any socket opens (`listDumps`). Full capture notes:
 * the git history.
 *
 * The ~8-day SNAP residence window (`C_SNAP_ADT_RESIDENCE_DAYS = 8`) is
 * server-side and `from` cannot widen it — an empty feed means "no dumps in
 * the window", not "no dumps" (see {@link emptyDumpsReason}).
 *
 * Scope: I/O only. No MCP tool registration, no schemas, no reading of
 * `Config` — the variables-tier (`kap10`) gate is a registration-time
 * decision; this layer only flags it ({@link DumpChapterSelection.includesVariables}).
 */
import type { AbapConnection } from "./connection.js";
import {
  DUMPS_CONTRACT_AS_CAPTURED,
  DUMPS_RESIDENCE_WINDOW_DAYS,
  type DumpsFeedRequest,
  type DumpsQueryContract,
  buildDumpsFeedUrl,
  buildQueryCheckUrl,
  residenceWindowStart,
  toDumpsQueryContract,
} from "./dumps-query.js";
import {
  DUMP_DETAIL_PATH_PREFIX,
  DUMPS_FEED_PATH,
  type DumpDetail,
  type DumpFeed,
  type DumpFeedEntry,
  type FeedCatalog,
  type FeedCatalogEntry,
  TIER1_CHAPTER_NAMES,
  VARIABLES_CHAPTER_NAME,
  findDumpsFeedEntry,
  parseDumpDetail,
  parseDumpFeed,
  parseFeedsCatalog,
  sliceDumpChapters,
} from "./dumps-xml.js";
import { AbapError } from "./errors.js";
import { type ErrorContext, translateAdtError } from "./session.js";

// -------------------------------------------------------------- constants ---

/**
 * The Feed Repository catalog — the capability source, not
 * `/sap/bc/adt/discovery`, which never lists this feed even where it works.
 */
export const FEEDS_CATALOG_PATH = "/sap/bc/adt/feeds";

/**
 * `Accept` for `/sap/bc/adt/feeds`, transcribed from the sidecar of the
 * capture that produced `feeds-catalog.xml`.
 */
export const FEEDS_CATALOG_ACCEPT =
  "application/xml, application/atom+xml, application/atomsvc+xml, */*";

/**
 * `Accept` for the dumps feed. Only literal `*\/*` is attested by captures —
 * do not switch to a bare `application/atom+xml`; see
 * the git history (uncontrolled 406 repro).
 */
export const DUMPS_FEED_ACCEPT = "*/*";

/**
 * `Accept` for the dump detail document. `text/plain` here is a captured 406
 * (`dump-detail-406-textplain.xml`) — plain text is the separate `/formatted`
 * sub-resource below, not a content-type of the base.
 */
export const DUMP_DETAIL_ACCEPT = "application/vnd.sap.adt.runtime.dump.v1+xml";

/** `Accept` for `/formatted`. Attested by both `/formatted` captures. */
export const DUMP_FORMATTED_ACCEPT = "text/plain";

/** The `/formatted` sub-resource suffix. */
const FORMATTED_SUFFIX = "/formatted";

/** Relation token of the `/formatted` link on the wire — `contents`, not "formatted". */
const FORMATTED_RELATION_TOKEN = "contents";

// ------------------------------------------------------------------ keys ---

/**
 * Chars that must never appear in a dump key on the wire. `%25` is a
 * re-encoded key (a captured 404, see {@link assertVerbatimDumpKey}); the
 * rest are path/query injection routes or whitespace from an upstream decode.
 */
const BAD_DUMP_KEY = /%25|[?#/\\]|\s/;

/**
 * Verify a dump key is unmodified, returning it unchanged — never repaired,
 * so `${PREFIX}${assertVerbatimDumpKey(key)}` is the only shape a call site
 * needs. To read a key's fields, use `parseDumpKeyFields()` in
 * `dumps-xml.ts`; nothing here reconstructs one.
 */
export function assertVerbatimDumpKey(key: string): string {
  if (typeof key !== "string" || key.trim() === "") {
    throw new AbapError(
      "BAD_INPUT",
      "A dump key is required.",
      { dumpKey: String(key) },
      "Take the key from a dump list entry — it is the `rel=\"self\"` link of the Atom " +
        "entry with the `adt://{SID}` prefix stripped, and nothing else.",
    );
  }
  if (BAD_DUMP_KEY.test(key)) {
    throw new AbapError(
      "BAD_INPUT",
      "This dump key has been altered and will not resolve; refusing to send it.",
      { dumpKey: key },
      "The key is an opaque fixed-width token that arrives ALREADY percent-encoded — its " +
        "`%20` runs are the space padding of a 70-character structure. Pass it through " +
        "byte for byte. Do not URL-encode it (that turns `%20` into `%2520`, a captured " +
        "404), do not decode it, do not trim it, and do not rebuild it from its fields: " +
        "all four mutations were captured as 404.",
    );
  }
  return key;
}

/**
 * `/sap/bc/adt/runtime/dump/{key}` — singular `dump` (the feed is plural
 * `…/dumps`; appending a key to that spelling is a captured 404). The single
 * place this path is formed.
 */
export function dumpDetailPath(key: string): string {
  return `${DUMP_DETAIL_PATH_PREFIX}${assertVerbatimDumpKey(key)}`;
}

/** `/sap/bc/adt/runtime/dump/{key}/formatted`. */
export function dumpFormattedPath(key: string): string {
  return `${dumpDetailPath(key)}${FORMATTED_SUFFIX}`;
}

// ----------------------------------------------------------------- errors ---

/** {@link ErrorContext} plus the one identifier dump failures turn on. */
export interface DumpErrorContext extends ErrorContext {
  /** The key that was sent, when the failing request carried one. */
  dumpKey?: string;
}

/**
 * Translate a dumps failure, following the `classifyPreviewFailure` pattern.
 * Also refines `NOT_FOUND`: the generic hint ("search with abap_search, or
 * create it") is wrong for a dump — the real causes are a mangled key or one
 * that aged out of the residence window.
 */
export function classifyDumpFailure(e: unknown, ctx: DumpErrorContext): AbapError {
  const err = translateAdtError(e, ctx);
  const status = typeof err.details.status === "number" ? err.details.status : undefined;
  const key = ctx.dumpKey;

  if (err.code === "NOT_FOUND" && key !== undefined) {
    return new AbapError(
      "NOT_FOUND",
      `No dump with this key exists on the system (HTTP 404 from ${ctx.uri ?? "the dump resource"}).`,
      { ...err.details, dumpKey: key },
      "Two causes, in order of likelihood. (1) The key was altered in transit: it must be the " +
        "feed entry's `rel=\"self\"` value with the `adt://{SID}` prefix stripped and NOTHING " +
        "else done to it — encoding, decoding and trimming were each captured as a 404. " +
        `(2) The dump has left the ${DUMPS_RESIDENCE_WINDOW_DAYS}-day ADT residence window. ` +
        "List the dumps again and use a key from that answer.",
    );
  }

  if (err.code !== "ADT_ERROR") return err;

  if (status === 406) {
    return new AbapError(
      "ADT_ERROR",
      `The dump resource does not offer the representation that was requested (HTTP 406).`,
      { ...err.details, ...(key === undefined ? {} : { dumpKey: key }) },
      "This is a client bug, not a server or authorisation problem: each dump representation " +
        "has its own resource and its own Accept. The detail document is " +
        `'${DUMP_DETAIL_ACCEPT}' on the base resource; plain text is the '/formatted' ` +
        "SUB-RESOURCE, not a content-type of the base — asking the base for text/plain is a " +
        "captured 406.",
    );
  }

  if (status === 400) {
    return new AbapError(
      "BAD_INPUT",
      `The server rejected this dumps request (HTTP 400) without saying why.`,
      { ...err.details, ...(key === undefined ? {} : { dumpKey: key }) },
      "This endpoint answers an unknown attribute, a syntax error, a missing and(…)/or(…) " +
        "wrapper and excess nesting with the SAME 372-byte ExceptionInvalidData body, so the " +
        "status carries no diagnosis. Re-check the filter against the served contract from " +
        `${FEEDS_CATALOG_PATH}. Note that most bad parameters are NOT reported at all — they ` +
        "come back as 200 with the complete unfiltered feed — so a 400 means the query string " +
        "itself, or a non-numeric $top.",
    );
  }

  if (status === 401 || status === 403) {
    return new AbapError(
      "AUTH_FAILED",
      `Not authorised (HTTP ${status}) to read runtime-error dumps.`,
      { ...err.details, ...(key === undefined ? {} : { dumpKey: key }) },
      "The logon succeeded; this user lacks the ST22 display authorisation (typically " +
        "S_ADMI_FCD / S_DEVELOP). Nothing about the key or the filter is in question — do not " +
        "retry with a different one.",
    );
  }

  return err;
}

// ------------------------------------------------------------ capability ---

/**
 * Tri-state support verdict. `unknown` means **proceed**: the catalog probe
 * failed for a reason unrelated to whether the feed exists (network, timeout,
 * an auth ceiling on the catalog itself), and refusing on that basis would
 * deny a working feature over a failed probe.
 */
export type DumpsSupportState = "supported" | "unsupported" | "unknown";

export interface DumpsCapability {
  state: DumpsSupportState;
  /** Plain-language basis for the verdict, safe to show a caller verbatim. */
  reason: string;
  /** The catalog entry, when one was found. */
  entry?: FeedCatalogEntry;
  /** The **served** filter contract. Absent unless the entry carried one. */
  contract?: DumpsQueryContract;
  /** `feed:pageSize` — 50 on the captured system. */
  pageSize?: number;
  /** Advertised poll interval, e.g. `{ value: 5, unit: "minutes" }`. */
  refresh?: { value: number; unit: string };
}

/**
 * Per-connection cache, matching `searchConfigCache` in `src/tools/transport.ts`
 * — the catalog is an 18 KB system-level document, not per-request.
 *
 * Only definitive verdicts are cached; `unknown` means the probe failed, not
 * that the system answered, so caching it would freeze a transient blip.
 */
const capabilityCache = new WeakMap<AbapConnection, DumpsCapability>();

/** Forget the cached verdict — for tests and for a reconnect. */
export function clearDumpsCapabilityCache(conn: AbapConnection): void {
  capabilityCache.delete(conn);
}

/** GET and parse `/sap/bc/adt/feeds`. */
export async function fetchFeedsCatalog(conn: AbapConnection): Promise<FeedCatalog> {
  const ctx: DumpErrorContext = { operation: "dumps.feedsCatalog", uri: FEEDS_CATALOG_PATH };
  let body: string;
  try {
    ({ body } = await conn.get(FEEDS_CATALOG_PATH, { headers: { Accept: FEEDS_CATALOG_ACCEPT } }));
  } catch (e) {
    throw classifyDumpFailure(e, ctx);
  }
  return parseFeedsCatalog(body);
}

/**
 * Decide whether this system serves the dumps feed, and on what contract.
 *
 * Matching is `findDumpsFeedEntry`'s business — `atom:id` or
 * `atom:content/@src`, never `rel="self"`, which catalog entries do not carry.
 */
export async function probeDumpsFeed(conn: AbapConnection): Promise<DumpsCapability> {
  const cached = capabilityCache.get(conn);
  if (cached !== undefined) return cached;

  let catalog: FeedCatalog;
  try {
    catalog = await fetchFeedsCatalog(conn);
  } catch (e) {
    // Not cached — see the note on `capabilityCache`.
    return {
      state: "unknown",
      reason:
        `Could not read the feed catalog at ${FEEDS_CATALOG_PATH}: ` +
        `${e instanceof Error ? e.message : String(e)}. ` +
        "This says nothing about whether the dumps feed exists, so the request proceeds.",
    };
  }

  const entry = findDumpsFeedEntry(catalog);
  if (entry === undefined) {
    const verdict: DumpsCapability = {
      state: "unsupported",
      reason:
        `${FEEDS_CATALOG_PATH} was read successfully on ${catalog.systemId || "this system"} ` +
        `and lists ${catalog.entries.length} feed(s), none of them ${DUMPS_FEED_PATH}. ` +
        "The runtime-error feed is not served here.",
    };
    capabilityCache.set(conn, verdict);
    return verdict;
  }

  const ed = entry.extendedData;
  const verdict: DumpsCapability = {
    state: "supported",
    reason: `${FEEDS_CATALOG_PATH} lists ${DUMPS_FEED_PATH}${entry.title ? ` ("${entry.title}")` : ""}.`,
    entry,
    ...(ed === undefined
      ? {}
      : {
          contract: toDumpsQueryContract(ed),
          ...(ed.pageSize === undefined ? {} : { pageSize: ed.pageSize }),
          ...(ed.refresh === undefined ? {} : { refresh: ed.refresh }),
        }),
  };
  capabilityCache.set(conn, verdict);
  return verdict;
}

/**
 * Refuse only on a definitive `unsupported`. Names the catalog consulted —
 * "not supported" with no provenance is indistinguishable from a probe bug.
 */
export function assertDumpsSupported(capability: DumpsCapability): void {
  if (capability.state !== "unsupported") return;
  throw new AbapError(
    "UNSUPPORTED",
    `This system does not serve ABAP runtime-error dumps over ADT. ${capability.reason}`,
    { state: capability.state, catalog: FEEDS_CATALOG_PATH, feed: DUMPS_FEED_PATH },
    `The verdict comes from ${FEEDS_CATALOG_PATH} (the Feed Repository catalog), which was ` +
      "read successfully and does not list the feed — it is not a guess from a 404 and not " +
      "from /sap/bc/adt/discovery, which never lists this feed even where it works. Read the " +
      "dump in SAP GUI transaction ST22 instead.",
  );
}

/** Where a validated filter contract came from. */
export type DumpsContractSource = "served" | "as-captured";

export interface ResolvedDumpsContract {
  contract: DumpsQueryContract;
  source: DumpsContractSource;
  capability: DumpsCapability;
}

/**
 * The contract to validate against: served when readable, else
 * `DUMPS_CONTRACT_AS_CAPTURED` — a remembered list from one system, i.e. a
 * guess. `source` tells the caller which happened.
 */
export async function resolveDumpsContract(conn: AbapConnection): Promise<ResolvedDumpsContract> {
  const capability = await probeDumpsFeed(conn);
  if (capability.contract !== undefined) {
    return { contract: capability.contract, source: "served", capability };
  }
  return { contract: DUMPS_CONTRACT_AS_CAPTURED, source: "as-captured", capability };
}

// ------------------------------------------------------------------ feed ---

export interface DumpsListOptions {
  /** Override the contract. Skips the catalog round trip when given. */
  contract?: DumpsQueryContract;
  /** Injected clock, for the residence-window arithmetic. */
  now?: Date;
  /**
   * Consult `/sap/bc/adt/feeds` first. Default `true`. Setting it `false`
   * skips both the capability verdict and the served contract — the request is
   * then validated against `DUMPS_CONTRACT_AS_CAPTURED`.
   */
  probe?: boolean;
}

export interface DumpsPage {
  entries: DumpFeedEntry[];
  /** `atom:contributor/atom:name`. Empty on a `$queryCheck` response. */
  systemId: string;
  /** True exactly when the feed carried a `rel="next"`. */
  hasMore: boolean;
  /**
   * The server's own `rel="next"` href, to be followed **verbatim** by
   * {@link fetchDumpsPage}. Absent on the last page.
   */
  nextHref?: string;
  /** The path actually requested, query string and all. */
  url: string;
  /** Non-fatal facts the caller is expected to surface (see `DumpsFeedUrl`). */
  notes: string[];
  /** The oldest instant this feed can reach, 14-digit. */
  residenceWindowStart: string;
  /**
   * Set **only** when `entries` is empty: the sentence that must be shown
   * instead of a bare "no dumps". See {@link emptyDumpsReason}.
   */
  emptyReason?: string;
  contractSource: DumpsContractSource;
  capability?: DumpsCapability;
}

/**
 * The sentence an empty dumps answer must carry. The server ANDs every query
 * with `datum ge sy-datum - 8 + 1`, so an empty feed means "nothing in the
 * last ~8 days", not "no dumps" — an older dump can still exist in ST22 and
 * be invisible here. The window start is quoted so the reader can tell the
 * two apart.
 */
export function emptyDumpsReason(windowStart: string, filtered: boolean): string {
  const base =
    `No dumps in the last ${DUMPS_RESIDENCE_WINDOW_DAYS} days matching this filter. ` +
    `ADT can only see runtime errors recorded since about ${windowStart} — the ` +
    `${DUMPS_RESIDENCE_WINDOW_DAYS}-day SNAP residence window ` +
    `(C_SNAP_ADT_RESIDENCE_DAYS = ${DUMPS_RESIDENCE_WINDOW_DAYS}) is applied server-side and a ` +
    "'from' bound cannot widen it, so an older dump can still exist in transaction ST22 and be " +
    "absent here.";
  return filtered
    ? `${base} Widening or dropping the filter may find dumps inside the window.`
    : `${base} No filter was applied, so this system recorded no runtime errors at all in that window.`;
}

/** True when the request narrows the feed by anything other than page size. */
function isFiltered(request: DumpsFeedRequest): boolean {
  return request.$query !== undefined || request.from !== undefined || request.to !== undefined;
}

/**
 * Issue one feed request and parse the page.
 *
 * The pre-encoded URL is passed as **url**, never as **qs** — axios's default
 * qs serializer spells a space `+` and drops the `$` from `$query` silently,
 * neither of which matches the captured wire format.
 */
async function getFeed(conn: AbapConnection, url: string, ctx: DumpErrorContext): Promise<DumpFeed> {
  let body: string;
  try {
    ({ body } = await conn.get(url, { headers: { Accept: DUMPS_FEED_ACCEPT } }));
  } catch (e) {
    throw classifyDumpFailure(e, ctx);
  }
  return parseDumpFeed(body);
}

function toPage(
  feed: DumpFeed,
  url: string,
  notes: string[],
  windowStart: string,
  filtered: boolean,
  contractSource: DumpsContractSource,
  capability?: DumpsCapability,
): DumpsPage {
  return {
    entries: feed.entries,
    systemId: feed.systemId,
    hasMore: feed.hasMore,
    ...(feed.nextHref === undefined ? {} : { nextHref: feed.nextHref }),
    url,
    notes,
    residenceWindowStart: windowStart,
    ...(feed.entries.length === 0
      ? { emptyReason: emptyDumpsReason(windowStart, filtered) }
      : {}),
    contractSource,
    ...(capability === undefined ? {} : { capability }),
  };
}

/**
 * List dumps: probe (cached) → build and validate the whole request
 * client-side → one GET. Validation happens before any socket opens because
 * the server answers a bad filter with 200 and the entire unfiltered feed.
 */
export async function listDumps(
  conn: AbapConnection,
  request: DumpsFeedRequest = {},
  options: DumpsListOptions = {},
): Promise<DumpsPage> {
  const now = options.now ?? new Date();
  const probe = options.probe !== false;

  let contract = options.contract;
  let contractSource: DumpsContractSource = contract === undefined ? "as-captured" : "served";
  let capability: DumpsCapability | undefined;
  const notes: string[] = [];

  if (contract === undefined && probe) {
    const resolved = await resolveDumpsContract(conn);
    assertDumpsSupported(resolved.capability);
    contract = resolved.contract;
    contractSource = resolved.source;
    capability = resolved.capability;
    if (resolved.capability.state === "unknown") {
      notes.push(
        `The dumps feed could not be confirmed from ${FEEDS_CATALOG_PATH}, so this request was ` +
          `sent anyway rather than refused. ${resolved.capability.reason}`,
      );
    }
    if (resolved.source === "as-captured") {
      notes.push(
        `${FEEDS_CATALOG_PATH} served no filter contract for this feed, so the filter was ` +
          "validated against the contract captured from another system. A filter this client " +
          "accepts may still be refused by the server with an opaque 400.",
      );
    }
  }

  const built = buildDumpsFeedUrl(request, { contract: contract ?? DUMPS_CONTRACT_AS_CAPTURED, now });
  notes.push(...built.notes);

  const feed = await getFeed(conn, built.url, {
    operation: "dumps.list",
    uri: built.url,
  });

  return toPage(
    feed,
    built.url,
    notes,
    built.residenceWindowStart,
    isFiltered(request),
    contractSource,
    capability,
  );
}

/**
 * Follow a `rel="next"` cursor verbatim — re-deriving it from parsed
 * timestamps is how a client silently skips a page. Rejected first if it
 * isn't a path on the dumps feed itself.
 */
export async function fetchDumpsPage(
  conn: AbapConnection,
  href: string,
  options: { now?: Date; filtered?: boolean } = {},
): Promise<DumpsPage> {
  if (!href.startsWith(`${DUMPS_FEED_PATH}?`) && href !== DUMPS_FEED_PATH) {
    throw new AbapError(
      "BAD_INPUT",
      `Refusing to follow a dumps cursor that does not point at ${DUMPS_FEED_PATH}.`,
      { href },
      "Pass the `nextHref` of a page returned by this module, unmodified. An absolute URL is " +
        "never followed: the feed also advertises an internal host-and-port link that is not " +
        "reachable or trustworthy from here.",
    );
  }
  const windowStart = residenceWindowStart(options.now ?? new Date());
  const feed = await getFeed(conn, href, { operation: "dumps.page", uri: href });
  return toPage(feed, href, [], windowStart, options.filtered ?? true, "as-captured");
}

/**
 * Drop entries seen on an earlier page, keyed on the full key. Consecutive
 * pages overlap on the cursor's own inclusive timestamp boundary, and two
 * dumps can share a timestamp to the second — the key's trailing counter
 * exists precisely because collisions happen — so only the whole key is a
 * safe identity.
 */
export function dedupeDumpEntries(entries: readonly DumpFeedEntry[]): DumpFeedEntry[] {
  const seen = new Set<string>();
  const out: DumpFeedEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    out.push(entry);
  }
  return out;
}

export interface DumpsListAllOptions extends DumpsListOptions {
  /** Hard ceiling on pages followed. Default 20 (1000 rows at 50/page). */
  maxPages?: number;
  /** Stop once this many distinct dumps are held. Default `DUMPS_MAX_ROWS`. */
  maxEntries?: number;
}

export interface DumpsListAllResult extends Omit<DumpsPage, "nextHref"> {
  pagesFetched: number;
  /** Set when paging stopped at a ceiling rather than at the last page. */
  truncatedBy?: "maxPages" | "maxEntries";
  /** The cursor paging stopped on, if it stopped early. */
  nextHref?: string;
  /** Entries dropped as duplicates of an earlier page's. */
  duplicatesDropped: number;
}

/**
 * Page the feed to the end (or a ceiling), de-duplicating as it goes. Bounded
 * on purpose: 20 pages x 50/page ~= 1000 dumps at ~3s warm, and an unbounded
 * loop trusts the server's `next` link never to cycle.
 */
export async function listAllDumps(
  conn: AbapConnection,
  request: DumpsFeedRequest = {},
  options: DumpsListAllOptions = {},
): Promise<DumpsListAllResult> {
  const maxPages = options.maxPages ?? 20;
  const maxEntries = options.maxEntries ?? 1000;

  const first = await listDumps(conn, request, options);
  const collected: DumpFeedEntry[] = [...first.entries];
  const seen = new Set(collected.map((e) => e.key));
  let duplicatesDropped = 0;
  let pagesFetched = 1;
  let cursor = first.nextHref;
  let truncatedBy: "maxPages" | "maxEntries" | undefined;
  const notes = [...first.notes];

  while (cursor !== undefined) {
    if (pagesFetched >= maxPages) {
      truncatedBy = "maxPages";
      break;
    }
    if (collected.length >= maxEntries) {
      truncatedBy = "maxEntries";
      break;
    }
    const page = await fetchDumpsPage(conn, cursor, {
      ...(options.now === undefined ? {} : { now: options.now }),
      filtered: isFiltered(request),
    });
    pagesFetched += 1;
    for (const entry of page.entries) {
      if (seen.has(entry.key)) {
        duplicatesDropped += 1;
        continue;
      }
      seen.add(entry.key);
      collected.push(entry);
    }
    cursor = page.nextHref;
  }

  if (truncatedBy !== undefined) {
    notes.push(
      `Stopped after ${pagesFetched} page(s) and ${collected.length} dump(s) because the ` +
        `${truncatedBy} ceiling was reached; the feed offered more. Narrow the filter or raise ` +
        "the ceiling to see the rest.",
    );
  }

  return {
    entries: collected,
    systemId: first.systemId,
    hasMore: cursor !== undefined,
    ...(cursor === undefined ? {} : { nextHref: cursor }),
    url: first.url,
    notes,
    residenceWindowStart: first.residenceWindowStart,
    ...(collected.length === 0
      ? { emptyReason: emptyDumpsReason(first.residenceWindowStart, isFiltered(request)) }
      : {}),
    contractSource: first.contractSource,
    ...(first.capability === undefined ? {} : { capability: first.capability }),
    pagesFetched,
    ...(truncatedBy === undefined ? {} : { truncatedBy }),
    duplicatesDropped,
  };
}

// ------------------------------------------------------------ query check ---

export interface DumpsQueryCheckResult {
  ok: boolean;
  /** The `$queryCheck=true` URL that was sent. */
  url: string;
  /** The canonical form of the query the client validated and sent. */
  query: string;
  /** Present when the server refused: the ADT exception type, if it named one. */
  serverExceptionType?: string;
  /** Present when the server refused: the message it managed to give. */
  serverMessage?: string;
}

/**
 * Ask the server to validate a filter without reading any rows — on top of
 * `validateFqlQuery`, never instead of it, since the client contract may be
 * the remembered fallback. A server refusal is **returned, not thrown**; auth,
 * transport, and other non-verdict failures still throw.
 */
export async function checkDumpsQuery(
  conn: AbapConnection,
  query: string,
  options: { contract?: DumpsQueryContract; now?: Date } = {},
): Promise<DumpsQueryCheckResult> {
  const built = buildQueryCheckUrl(query, {
    contract: options.contract ?? DUMPS_CONTRACT_AS_CAPTURED,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const canonical = built.params.find(([name]) => name === "$query")?.[1] ?? query;

  try {
    await conn.get(built.url, { headers: { Accept: DUMPS_FEED_ACCEPT } });
  } catch (e) {
    const err = classifyDumpFailure(e, { operation: "dumps.queryCheck", uri: built.url });
    const status = typeof err.details.status === "number" ? err.details.status : undefined;
    if (err.code === "BAD_INPUT" || status === 400) {
      const type = err.details.adtExceptionType;
      return {
        ok: false,
        url: built.url,
        query: canonical,
        ...(typeof type === "string" ? { serverExceptionType: type } : {}),
        serverMessage: err.message,
      };
    }
    throw err;
  }
  return { ok: true, url: built.url, query: canonical };
}

// ---------------------------------------------------------------- detail ---

/** GET and parse one dump's detail document. */
export async function fetchDumpDetail(conn: AbapConnection, key: string): Promise<DumpDetail> {
  const uri = dumpDetailPath(key);
  let body: string;
  try {
    ({ body } = await conn.get(uri, { headers: { Accept: DUMP_DETAIL_ACCEPT } }));
  } catch (e) {
    throw classifyDumpFailure(e, { operation: "dumps.detail", uri, dumpKey: key });
  }
  return parseDumpDetail(body);
}

/**
 * GET the `/formatted` plain-text body. Given a detail, follows its
 * `relation="contents"` link rather than appending a literal; given a key,
 * appends the literal via {@link dumpDetailPath}.
 */
export async function fetchDumpFormatted(
  conn: AbapConnection,
  target: string | DumpDetail,
): Promise<string> {
  const { uri, key } = formattedTarget(target);
  try {
    const { body } = await conn.get(uri, { headers: { Accept: DUMP_FORMATTED_ACCEPT } });
    return body;
  } catch (e) {
    throw classifyDumpFailure(e, {
      operation: "dumps.formatted",
      uri,
      ...(key === undefined ? {} : { dumpKey: key }),
    });
  }
}

function formattedTarget(target: string | DumpDetail): { uri: string; key?: string } {
  if (typeof target === "string") return { uri: dumpFormattedPath(target), key: target };

  const link = target.links.find((l) => l.relationToken === FORMATTED_RELATION_TOKEN);
  const path = target.formattedPath ?? link?.uri;
  if (path === undefined) {
    throw new AbapError(
      "NOT_FOUND",
      "This dump detail advertises no plain-text rendering.",
      { error: target.error, links: target.links.map((l) => l.relationToken) },
      `The '/formatted' body is reached through the '${FORMATTED_RELATION_TOKEN}' relation of ` +
        "the detail document. A detail without it is a shape this client has never been shown; " +
        "fetch the dump by key instead, which appends the sub-resource directly.",
    );
  }
  if (link !== undefined && link.kind !== "adt-path") {
    // Captured `termination`/`http` links show the server hands out absolute
    // URLs, including an internal host:port — never something to GET.
    throw new AbapError(
      "BAD_INPUT",
      "The dump's plain-text link is not a server-relative ADT path; refusing to follow it.",
      { uri: link.uri, kind: link.kind },
      "This resource advertises absolute links (an internal https://host:port URL among them) " +
        "that are not reachable or trustworthy from this client. Only server-relative paths " +
        "are followed.",
    );
  }
  return { uri: path };
}

// -------------------------------------------------------------- chapters ---

export interface DumpChapterSelection {
  detail: DumpDetail;
  /** The concatenated text of the chapters that exist, in line order. */
  text: string;
  /** Chapter names asked for. */
  requested: string[];
  /** Of those, the ones this dump actually has. */
  present: string[];
  /** Of those, the ones it does not — normal, chapter sets vary by release. */
  missing: string[];
  /** Lines in the whole `/formatted` body, for the caller's proportion sense. */
  totalLines: number;
  /**
   * True when the slice contains `kap10`, the variable-contents chapter. Not
   * gated here — that's the `ABAP_ALLOW_DUMP_VARIABLES` decision at tool
   * registration — but flagged so the caller doesn't have to re-derive it.
   */
  includesVariables: boolean;
}

/**
 * Fetch a dump and return only the requested chapters of its `/formatted`
 * body. Defaults to the tier-1 set (what/where/call stack), excluding
 * `kap10` — the variable-data chapter, ~60% of the captured body.
 *
 * Detail and body must come from the same dump: offsets from one silently
 * resolve against another's body and produce wrong or empty slices.
 */
export async function fetchDumpChapters(
  conn: AbapConnection,
  key: string,
  names: Iterable<string> = TIER1_CHAPTER_NAMES,
): Promise<DumpChapterSelection> {
  const detail = await fetchDumpDetail(conn, key);
  const formatted = await fetchDumpFormatted(conn, detail);
  return selectDumpChapters(detail, formatted, names);
}

/** The pure half of {@link fetchDumpChapters}, for a caller that already has both. */
export function selectDumpChapters(
  detail: DumpDetail,
  formatted: string,
  names: Iterable<string> = TIER1_CHAPTER_NAMES,
): DumpChapterSelection {
  const requested = [...names];
  const have = new Set(detail.chapters.map((c) => c.name));
  const present = requested.filter((n) => have.has(n));
  const missing = requested.filter((n) => !have.has(n));
  return {
    detail,
    text: sliceDumpChapters(detail.chapters, formatted, present),
    requested,
    present,
    missing,
    totalLines: formatted === "" ? 0 : formatted.split("\n").length,
    includesVariables: present.includes(VARIABLES_CHAPTER_NAME),
  };
}
