/**
 * Feature probe over `/sap/bc/adt/discovery` — an Atom service document
 * listing every collection the installed release exposes. Parsed once on
 * connect and cached; gate behaviour on `supports(feature)`, not a hardcoded
 * release check, since the ADT API is uncontracted and varies by release.
 * The raw document (~165 KB on A4H) never reaches the model — only derived
 * flags do.
 */
import type { ADTClient, AdtDiscoveryResult } from "abap-adt-api";
import { fullParse, xmlArray, xmlNodeAttr } from "abap-adt-api/build/utilities.js";
import { AbapError } from "./errors.js";

/** Named capabilities the rest of the server gates on. */
export type Feature =
  | "ddic.tables.source" // TABL readable as source (DDL-ish) rather than XML only
  | "ddic.dataelements" // /ddic/dataelements/{name}
  | "ddic.domains" // /ddic/domains/{name}
  | "ddic.structures"
  | "ddic.tabletypes"
  | "cds.ddls"
  | "cds.ddlx"
  | "rap.bdef"
  | "rap.srvd"
  | "rap.srvb"
  | "repository.search"
  | "repository.nodestructure"
  | "usage.references" // where-used
  | "classcomponents"
  | "atc"
  | "unittest"
  | "traces.abaptraces" // SAT
  | "traces.sqltraces" // ST05
  | "debugger"
  // NO `revisions` row: object version history is not discoverable via this
  // probe (verified A4H SAP_BASIS 754 SP0007 — see the git history).
  // Versioning is a per-object link relation, decided in `src/adt/revisions.ts`.
  | "enhancements"
  | "textelements";

/**
 * A cloud tenant (an SAP BTP ABAP environment / steampunk system) publishes a
 * visibly smaller discovery document than an on-premise system: no classic
 * dynpro collections, no `$TMP`-style local-package semantics, and a
 * restricted ABAP language version. That reduced document is handled by
 * construction, not by a special case added for it — `capability()` already
 * reports `"unsupported"` for any feature whose href markers are absent from
 * a LOADED inventory (never `"unknown"`, and never a throw), and `ingest()`
 * already reports `"empty"` rather than `"loaded"` for a document with zero
 * collections. A smaller-but-nonempty inventory is exactly the `"loaded"` /
 * per-feature-`"unsupported"` case this module was already built for.
 *
 * UNVERIFIED: no BTP ABAP environment was available to capture a real
 * reduced discovery document from, so `test/discovery-cloud-tenant.test.ts`
 * exercises this against a hand-built one instead — it proves the reduced-set
 * path doesn't throw or misreport, not that it matches SAP's exact cloud
 * collection list.
 */

/**
 * Feature → substrings that must appear in a collection href.
 * Matching on the href (not the title) keeps this language-independent.
 */
const FEATURE_HREFS: Record<Feature, string[]> = {
  "ddic.tables.source": ["/ddic/tables"],
  "ddic.dataelements": ["/ddic/dataelements"],
  "ddic.domains": ["/ddic/domains"],
  "ddic.structures": ["/ddic/structures"],
  "ddic.tabletypes": ["/ddic/tabletypes"],
  "cds.ddls": ["/ddic/ddl/sources", "/ddic/ddlsources"],
  "cds.ddlx": ["/ddic/ddlx/sources", "/ddic/ddlxsources"],
  "rap.bdef": ["/bo/behaviordefinitions"],
  "rap.srvd": ["/ddic/srvd/sources", "/businessservices/servicedefinitions"],
  // Service binding — verified live on A4H: create/read/activate/delete all
  // round-trip cleanly against /sap/bc/adt/businessservices/bindings/{name}.
  "rap.srvb": ["/businessservices/bindings"],
  "repository.search": ["/repository/informationsystem/search"],
  "repository.nodestructure": ["/repository/nodestructure"],
  "usage.references": ["/repository/informationsystem/usageReferences"],
  classcomponents: ["/oo/classes"],
  atc: ["/atc/"],
  unittest: ["/abapunit/"],
  "traces.abaptraces": ["/runtime/traces/abaptraces"],
  "traces.sqltraces": ["/runtime/traces/sqltraces", "/runtime/traces/sqltrace"],
  debugger: ["/debugger/"],
  enhancements: ["/enhancements"],
  textelements: ["/textelements"],
};

export interface CollectionInfo {
  href: string;
  title?: string;
  workspace: string;
  templates: string[];
  /** Media types from this collection's `<app:accept>` entries; `[]` when none. */
  readonly accept: readonly string[];
}

/**
 * `/enhancements` in discovery only says the release exposes *some*
 * enhancement collection — not which of the three exist here or which verbs
 * they accept. That can't be probed live: OPTIONS is refused system-wide, a
 * wrong GET has dumped a work process, and a wrong POST has dumped the server
 * *and* killed the session (see archive). So this is a DECLARED table,
 * hand-seeded from wire captures — see `enhancementCapability()` below for
 * how live existence and static verb capability combine. Verified 2026-08-05
 * against A4H; a future release/SP is a signal to re-verify, not to assume.
 */
export const ENHANCEMENT_CAPABILITY_TABLE_VERIFIED = "2026-08-05";

/** The three enhancement collections this table has a verdict for. */
export type EnhancementCollection = "enhoxh" | "enhoxhh" | "enhsxs";

/**
 * ADT REST verbs relevant to enhancement objects. `activate` is not a raw
 * HTTP verb (it is a POST to a separate activation endpoint) but is tracked
 * here as its own row because its capability does not follow from PUT's.
 */
export type EnhancementVerb = "GET" | "PUT" | "activate" | "DELETE" | "POST";

/**
 * Outcome of a declared-table lookup:
 *  - `unsupported` — clean, well-understood refusal; retrying with a
 *    different payload will not help.
 *  - `dangerous` — MUST NEVER be attempted: a captured attempt corrupted
 *    server state and/or killed the ADT session.
 *  - `unknown` — no declared verdict for the pair (unmapped collection,
 *    unmapped verb, or discovery hasn't confirmed it exists). Refuse; never
 *    probe to find out.
 */
export type EnhancementVerbCapability =
  | { readonly status: "supported" }
  | { readonly status: "unsupported"; readonly reason: string }
  | { readonly status: "dangerous"; readonly reason: string }
  | { readonly status: "unknown"; readonly reason: string };

const ENH_SUPPORTED: EnhancementVerbCapability = { status: "supported" };

/** One collection's verdict across all tracked verbs. */
type EnhancementRow = Readonly<Record<EnhancementVerb, EnhancementVerbCapability>>;

/**
 * The declared table itself. One row per collection this recon covered;
 * every non-`supported` entry carries the wire evidence that earned it.
 */
const ENHANCEMENT_VERB_CAPABILITIES: Readonly<Record<EnhancementCollection, EnhancementRow>> = {
  // BAdI implementation. Read/write/activate/delete all work; create does not.
  enhoxh: {
    GET: ENH_SUPPORTED,
    PUT: ENH_SUPPORTED,
    activate: ENH_SUPPORTED,
    DELETE: ENH_SUPPORTED,
    POST: {
      status: "unsupported",
      reason:
        'Refused at the controller: 400 ExceptionResourceCreationFailure, "Resource ' +
        'controller does not support method POST" (SADT_RESOURCE 010, V1=POST). Not a ' +
        "payload problem -- schema-valid documents fail identically. Never retry with a " +
        "different document; verify-GET after the refusal returns 404.",
    },
  },
  // Source-code plug-in (ENHO hook implementation). The only creatable
  // enhancement collection on this release. Callers MUST also gate POST on
  // ABAP_ALLOW_SOURCE_PLUGINS (a separate opt-in) -- this
  // table only records what the controller accepts, not what policy allows.
  enhoxhh: {
    GET: ENH_SUPPORTED,
    PUT: ENH_SUPPORTED,
    activate: ENH_SUPPORTED,
    DELETE: ENH_SUPPORTED,
    POST: ENH_SUPPORTED,
  },
  // Enhancement spot. Read/write/activate/delete all work; create is
  // actively dangerous, not merely unsupported.
  enhsxs: {
    GET: ENH_SUPPORTED,
    PUT: ENH_SUPPORTED,
    activate: ENH_SUPPORTED,
    DELETE: ENH_SUPPORTED,
    POST: {
      status: "dangerous",
      reason:
        "Short-dumps the server (500, ASSERTION_FAILED in CL_ENH_ADT_ENHS_OBJ_PERSIST===CP) " +
        "and destroys the session -- the next request on that session returns 400 " +
        "'Session Timed Out'. MUST NEVER be attempted, regardless of payload shape. " +
        "Verify-GET after every captured attempt returns 404.",
    },
  },
};

/**
 * Why the inventory is (or is not) trustworthy. An EMPTY inventory is not the
 * same answer as a FAILED probe, and neither is the same as "this release does
 * not expose that collection" — collapsing the three into `false` makes every
 * feature look unsupported the moment the network hiccups.
 */
export type DiscoveryState =
  | "never" // load() was never called
  | "loaded" // probe succeeded and returned a credible inventory
  | "empty" // probe succeeded but returned zero collections — not credible
  | "failed"; // probe threw

/** Tri-state answer. `unknown` means "we cannot honestly say". */
export type Capability = "supported" | "unsupported" | "unknown";

export class Discovery {
  private collections: CollectionInfo[] = [];
  private hrefIndex = new Set<string>();
  private state: DiscoveryState = "never";
  private loadError: string | undefined;

  constructor(private readonly client: ADTClient) {}

  /**
   * True only when the probe produced a credible inventory. A failed or empty
   * probe reports false — callers must not read that as "feature absent".
   */
  get isLoaded(): boolean {
    return this.state === "loaded";
  }

  /** Why the inventory looks the way it does. */
  get loadState(): DiscoveryState {
    return this.state;
  }

  get collectionCount(): number {
    return this.collections.length;
  }

  get error(): string | undefined {
    return this.loadError;
  }

  /**
   * The parsed inventory this instance holds — plain data, no `ADTClient`,
   * no session. This is the ONLY thing `src/adt/discovery-cache.ts` is
   * allowed to share between connections: see that module's doc for why
   * sharing `Discovery` itself (this object) would be wrong instead.
   */
  get parsedCollections(): readonly CollectionInfo[] {
    return this.collections;
  }

  /**
   * Adopt an already-parsed inventory (e.g. handed back by the shared cache
   * in `discovery-cache.ts`) instead of fetching and parsing the wire
   * document again. Sets `loadState` exactly as `ingest()` would and clears
   * any previous error. Synchronous/infallible by construction — unlike
   * `ingest()`, this cannot throw, so `connectUnderLock()`'s try/catch never
   * reaches this path.
   */
  loadParsed(collections: readonly CollectionInfo[]): void {
    this.collections = [...collections];
    this.hrefIndex = new Set(this.collections.map((c) => c.href.toLowerCase()));
    this.state = this.collections.length > 0 ? "loaded" : "empty";
    this.loadError = undefined;
  }

  /**
   * Run the probe. Records the outcome before rethrowing, so a caller that
   * swallows the rejection still leaves the inventory honestly marked
   * `failed` rather than silently "everything unsupported".
   */
  async load(force = false): Promise<void> {
    if (this.state === "loaded" && !force) return;
    try {
      // Prefer the raw document: it carries `<app:accept>`, which the
      // vendor's own `adtDiscovery()` parsing drops. Real `ADTClient`
      // instances always expose `httpClient`; a test stub implementing only
      // `adtDiscovery()` does not, so it falls back to the legacy path below.
      const http = (this.client as { httpClient?: { request?: unknown } }).httpClient;
      if (typeof http?.request === "function") {
        const { body } = await (
          http as { request: (url: string, config?: unknown) => Promise<{ body: string }> }
        ).request("/sap/bc/adt/discovery", {
          method: "GET",
          headers: { Accept: "application/atomsvc+xml" },
        });
        this.ingestDocument(body);
      } else {
        const raw: AdtDiscoveryResult[] = await this.client.adtDiscovery();
        this.ingest(raw);
      }
      this.loadError = undefined;
    } catch (e) {
      this.collections = [];
      this.hrefIndex = new Set();
      this.state = "failed";
      this.loadError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  /**
   * Non-throwing variant for connect paths that treat the probe as
   * best-effort. Returns true on success; on failure the state is `failed`
   * and `error` carries the reason.
   */
  async tryLoad(force = false): Promise<boolean> {
    try {
      await this.load(force);
      return this.state === "loaded";
    } catch {
      return false;
    }
  }

  /** Exposed for tests — accepts an already-parsed discovery document. */
  ingest(raw: AdtDiscoveryResult[]): void {
    const collections: CollectionInfo[] = [];
    for (const workspace of raw ?? []) {
      for (const c of workspace.collection ?? []) {
        collections.push({
          href: c.href,
          title: c.title,
          workspace: workspace.title,
          templates: (c.templateLinks ?? []).map((t) => t.template).filter(Boolean),
          // The vendor's own `adtDiscovery()` parsing drops `<app:accept>`,
          // so this legacy path can never populate it.
          accept: [],
        });
      }
    }
    this.applyCollections(collections);
  }

  /**
   * Parses a raw discovery Atom service document directly, mirroring the
   * vendor's `adtDiscovery()` parsing exactly but additionally keeping each
   * collection's `<app:accept>` media types, which the vendor drops.
   */
  ingestDocument(xml: string): void {
    const tree = fullParse(xml);
    const workspaces = xmlArray<Record<string, unknown>>(tree, "app:service", "app:workspace");
    const collections: CollectionInfo[] = [];
    for (const ws of workspaces) {
      for (const c of xmlArray<Record<string, unknown>>(ws, "app:collection")) {
        collections.push({
          href: String(c["@_href"]),
          title: c["atom:title"] === undefined ? undefined : String(c["atom:title"]),
          workspace: String(ws["atom:title"]),
          templates: xmlArray<unknown>(c, "adtcomp:templateLinks", "adtcomp:templateLink")
            .map((t) => String(xmlNodeAttr(t).template))
            .filter(Boolean),
          accept: xmlArray<string>(c, "app:accept").map(String),
        });
      }
    }
    this.applyCollections(collections);
  }

  /** Shared state bookkeeping for both `ingest()` and `ingestDocument()`. */
  private applyCollections(collections: CollectionInfo[]): void {
    this.collections = collections;
    this.hrefIndex = new Set(collections.map((c) => c.href.toLowerCase()));
    // A discovery document with no collections at all is not a release that
    // supports nothing — it is a document we failed to understand.
    this.state = this.collections.length > 0 ? "loaded" : "empty";
  }

  /**
   * Honest tri-state answer. `unknown` whenever the inventory was never
   * loaded, failed, or came back empty — those are NOT "unsupported".
   */
  capability(feature: Feature): Capability {
    if (this.state !== "loaded") return "unknown";
    const markers = FEATURE_HREFS[feature];
    if (!markers) return "unsupported";
    for (const href of this.hrefIndex) {
      if (markers.some((m) => href.includes(m.toLowerCase()))) return "supported";
    }
    return "unsupported";
  }

  /**
   * Definitive yes/no. THROWS when discovery never loaded rather than
   * answering `false` — a missing inventory must never be mistaken for a
   * missing feature. Use `maySupport()` / `assertSupported()` to gate
   * behaviour without having to handle that throw.
   */
  supports(feature: Feature): boolean {
    const cap = this.capability(feature);
    if (cap === "unknown") {
      throw new AbapError(
        "NOT_CONNECTED",
        `Cannot say whether "${feature}" is available: the ADT discovery probe ${this.statePhrase()}.`,
        { feature, state: this.state, error: this.loadError },
        "Reconnect, or use maySupport()/capability() which model the unknown case explicitly.",
      );
    }
    return cap === "supported";
  }

  /**
   * Fail-open gate: true unless the feature is *known* to be absent. Use this
   * where a missing inventory should not block an attempt — the server call
   * itself will produce the authoritative 404.
   */
  maySupport(feature: Feature): boolean {
    return this.capability(feature) !== "unsupported";
  }

  /**
   * Fail-open guard for tool entry points. No-op when the feature is present
   * or unknown; throws UNSUPPORTED only when the probe succeeded and the
   * collection is genuinely absent on this release.
   */
  assertSupported(feature: Feature, what: string = feature): void {
    if (this.capability(feature) !== "unsupported") return;
    throw new AbapError(
      "UNSUPPORTED",
      `This system's ADT release does not expose ${what}.`,
      { feature, state: this.state },
      "The /discovery inventory lists no matching collection; see abap://system for what is available.",
    );
  }

  /**
   * Declared per-collection, per-verb answer for the enhancement feature
   * (`ENHANCEMENT_VERB_CAPABILITIES` above). Collection existence is read
   * from the live discovery inventory on every call, so a collection this
   * table knows about but the connected system doesn't expose still comes
   * back `unknown`, not `supported`. An unrecognised collection or unmapped
   * (collection, verb) pair is refused (`unknown`), never probed.
   */
  enhancementCapability(collection: string, verb: EnhancementVerb): EnhancementVerbCapability {
    if (this.state !== "loaded") {
      return {
        status: "unknown",
        reason: `Cannot say: the ADT discovery probe ${this.statePhrase()}.`,
      };
    }
    if (this.find(collection).length === 0) {
      return {
        status: "unknown",
        reason: `"${collection}" is not present in this system's discovery inventory.`,
      };
    }
    const table = (ENHANCEMENT_VERB_CAPABILITIES as Record<string, EnhancementRow | undefined>)[
      collection
    ];
    if (!table) {
      return {
        status: "unknown",
        reason: `"${collection}" exists on this system but has no declared capability entry in the table; refusing rather than probing.`,
      };
    }
    return table[verb];
  }

  /**
   * Throwing gate for tool entry points. No-op
   * only when the pair is declared `supported`; throws `UNSUPPORTED`
   * otherwise -- folding "does not exist here", "no declared verdict",
   * "known unsupported", and "known dangerous" into one refusal, so a
   * caller cannot mistake "we don't know" for "go ahead". `details.status`
   * on the thrown error carries which of those four it was, in case a
   * caller wants to react differently to `dangerous` specifically.
   */
  assertEnhancementCapable(collection: string, verb: EnhancementVerb): void {
    const cap = this.enhancementCapability(collection, verb);
    if (cap.status === "supported") return;
    throw new AbapError(
      "UNSUPPORTED",
      `${verb} on enhancement collection "${collection}" is not available: ${cap.reason}`,
      { collection, verb, status: cap.status },
      cap.status === "dangerous"
        ? "This combination is known to corrupt server state and/or destroy the session on this release; it must never be attempted."
        : "See the declared enhancement capability table (enhancementCapability()) in this module for what is supported.",
    );
  }

  private statePhrase(): string {
    switch (this.state) {
      case "never":
        return "never ran";
      case "failed":
        return `failed (${this.loadError ?? "unknown error"})`;
      case "empty":
        return "returned an empty inventory";
      default:
        return "succeeded";
    }
  }

  /**
   * Every feature currently available, for `abap_read mode=system`. Empty when
   * discovery never loaded — read alongside `loadState`, which says why.
   */
  supportedFeatures(): Feature[] {
    return (Object.keys(FEATURE_HREFS) as Feature[]).filter(
      (f) => this.capability(f) === "supported",
    );
  }

  /** Collections whose href contains `needle` — used to discover URL shapes. */
  find(needle: string): CollectionInfo[] {
    const n = needle.toLowerCase();
    return this.collections.filter(
      (c) => c.href.toLowerCase().includes(n) || (c.title ?? "").toLowerCase().includes(n),
    );
  }

  /**
   * Media types the collection whose href ends with `hrefSuffix` advertises
   * via `<app:accept>`. `undefined` when no such collection exists in the
   * loaded inventory (as opposed to `[]`, which means it exists but
   * advertises no accept media types at all).
   */
  acceptedMediaTypes(hrefSuffix: string): readonly string[] | undefined {
    const suffix = hrefSuffix.toLowerCase();
    const hit = this.collections.find((c) => c.href.toLowerCase().endsWith(suffix));
    return hit?.accept;
  }

  /**
   * Compact summary, safe to hand to the model. `state` (and `error`) are part
   * of the payload precisely so an empty `features` list can be told apart
   * from a probe that never ran.
   */
  summary(): {
    collections: number;
    workspaces: string[];
    features: Feature[];
    state: DiscoveryState;
    error?: string;
  } {
    return {
      collections: this.collections.length,
      workspaces: [...new Set(this.collections.map((c) => c.workspace))].sort(),
      features: this.supportedFeatures(),
      state: this.state,
      error: this.loadError,
    };
  }
}
