/**
 * Enhancement / BAdI ADT wire client — HTTP GET only.
 *
 * Read-only by scope: fetches raw XML for the three enhancement collections
 * and hands it to `enhancement-xml.ts` for decoding. No lock/write/create/
 * activate here — see that module's header before touching
 * `ENH_BADI_IMPL_DATA-FILTERS`.
 *
 * Follows `./bopf.ts`'s `readModel` shape (HTTP wrapper,
 * `translateAdtError`/`isAbapError` catch, private `firstHeader` copy
 * rather than a shared util).
 *
 * **Doubled-prefix hazard.** This system's `/sap/bc/adt/discovery` document
 * has a confirmed bug where `templateLink/@template` doubles the
 * `/sap/bc/adt/` prefix for some entries, including the whole Enhancements
 * workspace (`app:collection/@href` on the same entries is clean) — see
 * the git history. This module never reads
 * discovery; the collection paths below are hardcoded from verified-clean
 * `href` values. `buildEnhancementUri()` is a backstop that throws
 * `BAD_INPUT` on any doubled prefix — future code that resolves enhancement
 * URIs from `templateLink/@template` must not assume this file already
 * handles that case.
 */
import type { AbapConnection } from "./connection.js";
import { translateAdtError } from "./session.js";
import { AbapError, isAbapError } from "./errors.js";
import type { Discovery } from "./discovery.js";
import {
  parseBadiImplementation,
  parseSourceCodePlugin,
  parseEnhancementSpot,
  type BadiImplementationRead,
  type SourceCodePluginRead,
  type EnhancementSpotRead,
} from "./enhancement-xml.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** BAdI implementation collection. Verified against fixtures 354, 470. */
export const ENHOXH_COLLECTION = "/sap/bc/adt/enhancements/enhoxh";
/** Source-code plugin collection. Verified against fixtures 019, 021. */
export const ENHOXHH_COLLECTION = "/sap/bc/adt/enhancements/enhoxhh";
/** Enhancement spot collection. Verified against fixtures 343, 403. */
export const ENHSXS_COLLECTION = "/sap/bc/adt/enhancements/enhsxs";

/**
 * Accept headers, one per collection — not interchangeable (wrong media
 * type can 406, see `bopf.ts` H8). Taken from captured request headers,
 * not guessed.
 */
export const ENHOXH_ACCEPT = "application/vnd.sap.adt.enh.enho.v1+xml";
export const ENHOXHH_ACCEPT = "application/vnd.sap.adt.enh.enhoxhh.v2+xml";
export const ENHSXS_ACCEPT = "application/vnd.sap.adt.enh.enhs.v1+xml";

/** Matches any versioned enhoxhh media type, capturing the version number. */
export const ENHOXHH_MEDIA_TYPE_PATTERN = /^application\/vnd\.sap\.adt\.enh\.enhoxhh\.v(\d+)\+xml$/i;

/**
 * The enhoxhh media type to send/accept, negotiated from this connection's
 * `/sap/bc/adt/discovery` inventory instead of a hardcoded version — some
 * releases (e.g. A4H) only advertise v3, others only v2 or v1, and sending
 * the wrong version 415s (POST) or 406s (GET).
 *
 * Fail-open, matching `assertSupported`'s policy: when discovery hasn't
 * loaded a credible inventory, this returns the historical hardcoded
 * `ENHOXHH_ACCEPT` rather than blocking on an unknown state. Once discovery
 * HAS loaded, an enhoxhh collection with no matching media type is a real,
 * actionable refusal — thrown as `UNSUPPORTED` rather than guessed at.
 *
 * Pure — performs no I/O.
 */
export function enhoxhhMediaType(discovery: Discovery): string {
  if (discovery.loadState !== "loaded") return ENHOXHH_ACCEPT;
  const accept = discovery.acceptedMediaTypes("/enhancements/enhoxhh");
  if (accept === undefined) {
    throw new AbapError(
      "UNSUPPORTED",
      "This server's /sap/bc/adt/discovery offers no /sap/bc/adt/enhancements/enhoxhh " +
        "collection, so enhancement implementations (source code plug-ins) cannot be read " +
        `or created over ADT; media type ${ENHOXHH_ACCEPT} is not served.`,
      { feature: "enhancements", collection: "enhoxhh" },
      "create_hook is unavailable on this release.",
    );
  }
  const versioned = accept
    .map((mt) => ({ mt, m: ENHOXHH_MEDIA_TYPE_PATTERN.exec(mt) }))
    .filter((x): x is { mt: string; m: RegExpExecArray } => x.m !== null);
  if (versioned.length === 0) {
    throw new AbapError(
      "UNSUPPORTED",
      `This server's /sap/bc/adt/discovery enhoxhh collection does not advertise ` +
        `${ENHOXHH_ACCEPT} or any other versioned enhoxhh media type; it advertises ` +
        `${accept.length ? accept.join(", ") : "nothing"}.`,
      { feature: "enhancements", collection: "enhoxhh", accept },
      "create_hook is unavailable on this release.",
    );
  }
  versioned.sort((a, b) => Number(b.m[1]) - Number(a.m[1]));
  return versioned[0]!.mt;
}

/** Error-context type codes, mirrors `bopf.ts`'s `BOPF_TYPE`. Not exported. */
const ENHOXH_TYPE = "ENHO/XH";
const ENHOXHH_TYPE = "ENHO/XHH";
const ENHSXS_TYPE = "ENHS/XS";

// ---------------------------------------------------------------------------
// URI construction — doubled-prefix backstop
// ---------------------------------------------------------------------------

/**
 * Builds `${collection}/${name}`, refusing a doubled
 * `/sap/bc/adt/sap/bc/adt/` prefix in the result. Backstop for callers that
 * source `collection` from discovery instead of the hardcoded constants
 * above — see module header.
 */
export function buildEnhancementUri(collection: string, name: string): string {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new AbapError(
      "BAD_INPUT",
      "Enhancement object name must not be empty.",
      { collection },
      "Pass the object name, e.g. the BAdI implementation's technical name.",
    );
  }
  const uri = `${collection}/${encodeURIComponent(trimmedName)}`;
  if (/\/sap\/bc\/adt\/sap\/bc\/adt\//i.test(uri)) {
    throw new AbapError(
      "BAD_INPUT",
      `Refused to build a doubled-prefix enhancement URI: ${uri}`,
      { collection, name: trimmedName, uri },
      "This system's /sap/bc/adt/discovery document is known to carry a " +
        "doubled /sap/bc/adt/sap/bc/adt/ prefix on 29/239 templateLink/@template " +
        "values, including the entire Enhancements workspace. Resolve the " +
        "collection path from app:collection/@href, never from " +
        "templateLink/@template.",
    );
  }
  return uri;
}

// ---------------------------------------------------------------------------
// Shared header helper
// ---------------------------------------------------------------------------

/** Case-insensitive header lookup; copied from `bopf.ts` rather than
 *  shared — see module header. */
function firstHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) {
      const v = headers[k];
      if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
      return v === undefined || v === null ? undefined : String(v);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Result wrappers
// ---------------------------------------------------------------------------

export interface BadiImplementationDocument {
  readonly xml: string;
  readonly data: BadiImplementationRead;
  readonly etag?: string;
}

export interface SourceCodePluginDocument {
  readonly xml: string;
  readonly data: SourceCodePluginRead;
  readonly etag?: string;
}

export interface EnhancementSpotDocument {
  readonly xml: string;
  readonly data: EnhancementSpotRead;
  readonly etag?: string;
}

// ---------------------------------------------------------------------------
// GET primitives
// ---------------------------------------------------------------------------

/**
 * `GET /sap/bc/adt/enhancements/enhoxh/{name}`. Verified against fixtures
 * 354 (no filter tree) and 470 (filter tree present) — see
 * `enhancement-xml.ts`'s header for shape uncertainties.
 */
export async function readBadiImplementation(
  conn: AbapConnection,
  name: string,
): Promise<BadiImplementationDocument> {
  // Fail-open on "unknown": only a probe that confirmed /enhancements
  // absent turns into UNSUPPORTED here instead of an opaque 404 below.
  conn.discovery.assertSupported("enhancements", "BAdI implementations (ENHO/XH)");
  const uri = buildEnhancementUri(ENHOXH_COLLECTION, name);
  try {
    const resp = await conn.get(uri, { headers: { Accept: ENHOXH_ACCEPT } });
    const etag = firstHeader(resp.headers, "etag");
    return { xml: resp.body, data: parseBadiImplementation(resp.body), ...(etag ? { etag } : {}) };
  } catch (e) {
    if (isAbapError(e)) throw e;
    throw translateAdtError(e, { operation: "read", uri, name, type: ENHOXH_TYPE });
  }
}

/**
 * `GET /sap/bc/adt/enhancements/enhoxhh/{name}`. Verified against fixtures
 * 019 (class hook) and 021 (function-module hook with switch).
 */
export async function readSourceCodePlugin(
  conn: AbapConnection,
  name: string,
): Promise<SourceCodePluginDocument> {
  // Discovery gate — see readBadiImplementation.
  conn.discovery.assertSupported("enhancements", "source-code plug-ins (ENHO/XHH)");
  const uri = buildEnhancementUri(ENHOXHH_COLLECTION, name);
  const accept = enhoxhhMediaType(conn.discovery);
  try {
    const resp = await conn.get(uri, { headers: { Accept: accept } });
    const etag = firstHeader(resp.headers, "etag");
    return { xml: resp.body, data: parseSourceCodePlugin(resp.body), ...(etag ? { etag } : {}) };
  } catch (e) {
    if (isAbapError(e)) throw e;
    throw translateAdtError(e, { operation: "read", uri, name, type: ENHOXHH_TYPE });
  }
}

/**
 * `GET /sap/bc/adt/enhancements/enhsxs/{name}`. Verified against fixtures
 * 343 and 403 (both `BADI_DEF`-flavoured); a hook-flavoured spot's shape is
 * UNVERIFIED, see `enhancement-xml.ts`'s header.
 */
export async function readEnhancementSpot(
  conn: AbapConnection,
  name: string,
): Promise<EnhancementSpotDocument> {
  // Discovery gate — see readBadiImplementation.
  conn.discovery.assertSupported("enhancements", "enhancement spots (ENHS/XS)");
  const uri = buildEnhancementUri(ENHSXS_COLLECTION, name);
  try {
    const resp = await conn.get(uri, { headers: { Accept: ENHSXS_ACCEPT } });
    const etag = firstHeader(resp.headers, "etag");
    return { xml: resp.body, data: parseEnhancementSpot(resp.body), ...(etag ? { etag } : {}) };
  } catch (e) {
    if (isAbapError(e)) throw e;
    throw translateAdtError(e, { operation: "read", uri, name, type: ENHSXS_TYPE });
  }
}
