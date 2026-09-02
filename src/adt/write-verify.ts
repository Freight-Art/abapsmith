/**
 * Post-create verification for the classrun-bridge creates (`VIEW/DV`, `TRAN/T`).
 *
 * `ddic-bridge.ts`'s `runDdicBridge` only proves the generated classrun ran
 * and its calls returned `sy-subrc = 0` — not that the result persisted
 * (implicit rollback / missing commit inside the classrun's own execution
 * context can produce an identical transcript to a genuine success). That gap
 * — `created: true` reported for an object that was never actually there —
 * was reproduced live for `VIEW/DV`. `write.ts`'s general PUT path doesn't
 * have this problem (its `200` body IS the object, and `bopf.ts` already
 * reads back with a GET); the classrun bridge has no such response to lean
 * on, so this module supplies the read-back.
 *
 * Verification reads through the generic VIT bridge
 * (`/sap/bc/adt/vit/wb/object_type/{type}/object_name/{name}`) — the only
 * read path confirmed live and working for both types; the "dedicated" ADT
 * collections either 500 or 404 on real objects of these types (see
 * archive). The VIT bridge never 404s — a never-created name still
 * answers `200`, just with a thin name/type-only stub instead of the
 * enriched one a real object carries — so a bare `200` answers nothing by
 * itself. Two separate questions, two predicates: {@link
 * vitStubShowsExistence} (enriched attributes, or a `packageRef`) and
 * {@link vitStubShowsRegistration} (`packageRef` only — TADIR registration,
 * the delete gate's question, not this module's).
 *
 * The result is three-state (`confirmed` / `confirmed-absent` /
 * `indeterminate`), not boolean, so "definitely absent" stays distinguishable
 * from "could not tell" — collapsing that distinction previously let a
 * confirmed-non-existent object report the same confidence as a real one.
 *
 * When the VIT bridge can't decide, {@link verifyViaRepositorySearch} falls
 * back to the same live search `resolveObject`/`abap_search` already trust —
 * a search hit settles it, but a miss only downgrades to `indeterminate`
 * — see {@link verifyObjectCreated}. Full incident write-up and
 * recon captures: the git history.
 */
import { capabilitiesFor } from "./capabilities.js";
import type { AbapConnection } from "./connection.js";
import { isAbapError } from "./errors.js";
import { parsePackageRef } from "./package-ref.js";
import { searchExact } from "./resolve.js";
import {
  adtExceptionInfo,
  classifySessionFailure,
  isNotFoundError,
  objectUriOf,
  sessionDeathFromInfo,
} from "./session.js";

/** The stub media type every VIT-bridge navigation read answers with. Exported: callers that need to re-probe after a bridge mutation (delete confirmation) must send the same Accept, not a re-typed copy. */
export const VIT_STUB_ACCEPT = "application/vnd.sap.adt.basic.object.properties+xml";

/** What ONE direct GET actually established about an object. */
export type ObjectPresence = "absent" | "present" | "no-answer";

export interface PresenceProbe {
  readonly presence: ObjectPresence;
  /** The last error seen; absent when `presence === "present"`. */
  readonly error?: unknown;
  /** True when the first attempt died with a dead session and a fresh one was established. */
  readonly revived: boolean;
}

/**
 * Transport-level "the ADT session is gone": HTTP 400 carrying
 * `x-sap-icm-err-id: ICMENOSESSION`, plus the SESSION_DEAD classification
 * session.ts already mints. Both shapes have to be recognised because
 * `conn.get()` does not translate vendor errors.
 */
export function isSessionDeadFailure(e: unknown): boolean {
  if (isAbapError(e)) return e.code === "SESSION_DEAD";
  const info = adtExceptionInfo(e);
  return (classifySessionFailure(info?.response) ?? sessionDeathFromInfo(info)) !== undefined;
}

/**
 * One GET, classified three ways, with exactly one reconnect-and-re-issue on
 * a dead session. Reads are idempotent, which is what makes that single
 * retry safe — never looped.
 */
export async function probeObjectPresence(
  conn: AbapConnection,
  uri: string,
  accept: string,
): Promise<PresenceProbe> {
  const get = () => conn.get(uri, { headers: { Accept: accept } });
  try {
    await get();
    return { presence: "present", revived: false };
  } catch (e) {
    if (isNotFoundError(e)) return { presence: "absent", error: e, revived: false };
    if (!isSessionDeadFailure(e)) return { presence: "no-answer", error: e, revived: false };
  }

  try {
    await conn.connect();
  } catch (e) {
    return { presence: "no-answer", error: e, revived: false };
  }

  try {
    await get();
    return { presence: "present", revived: true };
  } catch (e) {
    return { presence: isNotFoundError(e) ? "absent" : "no-answer", error: e, revived: true };
  }
}

/**
 * Which probe settled the question (see {@link verifyObjectCreated}).
 * Present only on `confirmed`/`confirmed-absent`: `indeterminate` means
 * nothing settled it. `"read-back"` is a GET against the object's own
 * content URI — used by {@link verifyObjectDeleted}, never by the create path.
 */
export type VerifySource = "vit-bridge" | "repository-search" | "read-back";

export type VerifyOutcome =
  | {
      /** A read-back that positively identified the object — the object is there. */
      readonly status: "confirmed";
      readonly uri: string;
      readonly via: VerifySource;
      /**
       * The object's package (see {@link packageRefName}); only set by
       * {@link verifyViaVitBridge}. Absent means "not known" — a caller
       * judging a safety allowlist on this must refuse, not substitute a
       * caller-supplied value or `$TMP`.
       */
      readonly packageName?: string;
    }
  | {
      /** A read-back that positively identified the object's absence — it is definitely NOT there. */
      readonly status: "confirmed-absent";
      readonly uri: string;
      readonly via: VerifySource;
    }
  | {
      /** Neither of the above: a network/infra failure, or a signal too sparse to trust (see module doc). */
      readonly status: "indeterminate";
      readonly uri: string;
      readonly reason: string;
    };

/**
 * `{type}` is the VIT bridge's own lowercase, slash-stripped object-type
 * token — `viewdv` for `VIEW/DV`, `trant` for `TRAN/T` (both confirmed live).
 */
export function vitBridgeUri(vitType: string, objectName: string): string {
  return `/sap/bc/adt/vit/wb/object_type/${vitType}/object_name/${encodeURIComponent(objectName)}`;
}

/** Attributes a real object's VIT stub carries; a never-created name gets a thin name+type stub instead. */
const VIT_EXISTENCE_ATTRS = ["changedAt", "changedBy", "description"] as const;

/** Is the object registered in TADIR? `packageRef` only — the delete gate's question, never the existence question. */
export function vitStubShowsRegistration(body: string): boolean {
  return /<adtcore:packageRef[\s>]/i.test(body);
}

/** Does the stub describe an object that EXISTS? Enriched attributes, or a packageRef, say yes; a thin name+type stub says no. */
export function vitStubShowsExistence(body: string): boolean {
  if (vitStubShowsRegistration(body)) return true;
  return VIT_EXISTENCE_ATTRS.some((attr) => new RegExp(`adtcore:${attr}\\s*=`, "i").test(body));
}

/** Raw substring matching, not a full XML parse — this stub has no nesting or namespace tricks in any capture on record. */
function echoesTarget(body: string, expectType: string, expectName: string): boolean {
  const typeRe = new RegExp(`adtcore:type\\s*=\\s*"${escapeForRegex(expectType)}"`, "i");
  const nameRe = new RegExp(`adtcore:name\\s*=\\s*"${escapeForRegex(expectName)}"`, "i");
  return typeRe.test(body) && nameRe.test(body);
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The object's package from a VIT stub body — delegates entirely to
 * {@link parsePackageRef} in `./package-ref.js`; see that module's doc
 * for why.
 */
export function packageRefName(body: string): string | undefined {
  return parsePackageRef(body);
}

/**
 * Reads an object back through the generic VIT bridge and classifies the
 * result into the three {@link VerifyOutcome} states. The bridge itself
 * never 404s, so a `200` splits three ways: no echo of the requested
 * type/name is `indeterminate` (not an answer about this object); an echo
 * with {@link vitStubShowsExistence} is `confirmed`; an echo without it (the
 * thin stub) is `confirmed-absent`. A transport-level `404` is also
 * `confirmed-absent`; any other failure becomes `indeterminate` with the
 * underlying message preserved, never a false `confirmed`/`confirmed-absent`.
 */
export async function verifyViaVitBridge(
  conn: AbapConnection,
  vitType: string,
  objectName: string,
  expectType: string,
): Promise<VerifyOutcome> {
  const uri = vitBridgeUri(vitType, objectName);
  try {
    const resp = await conn.get(uri, { headers: { Accept: VIT_STUB_ACCEPT } });
    if (!echoesTarget(resp.body, expectType, objectName)) {
      return {
        status: "indeterminate",
        uri,
        reason:
          `The VIT bridge answered 200 but the stub did not echo back the ${expectType} ` +
          `${objectName} it was asked for — not an answer about this object. Treated as unproven.`,
      };
    }
    if (vitStubShowsExistence(resp.body)) {
      return { status: "confirmed", uri, via: "vit-bridge", packageName: packageRefName(resp.body) };
    }
    return { status: "confirmed-absent", uri, via: "vit-bridge" };
  } catch (e) {
    // GUARDRAIL: UNSUPPORTED (or anything short of a genuine "not found")
    // must land in `indeterminate`, never `confirmed-absent` — abap_read's
    // default mode throws UNSUPPORTED for some types (MSAG/N, ENQU/DL)
    // regardless of existence. See the git history.
    if (isAbapError(e) && e.code === "UNSUPPORTED") {
      return {
        status: "indeterminate",
        uri,
        reason: `The VIT bridge read was not supported for this request shape: ${e.message}`,
      };
    }
    if (isNotFoundError(e)) return { status: "confirmed-absent", uri, via: "vit-bridge" };
    return {
      status: "indeterminate",
      uri,
      reason: `Read-back failed before a status could be determined: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Object types the repository search index cannot see at all.
 * `searchExact` sends only the top-level kind (`type?.split("/")[0]` →
 * `FUGR`), so a function module's own name can never come back as a
 * FUGR-kind hit — confirmed live by a positive control: the same
 * module name searched while absent, then again while demonstrably present
 * (TFDIR/FUNCTION_EXISTS/200 at both URIs), returned 0 hits both times.
 * Extend only with a positive control per type, never by assumption.
 */
const SEARCH_BLIND_TYPES = new Set(["FUGR/FF"]);

/**
 * Shared grounding for every combinator below that must not read a
 * repository-search miss as absence: `test/fixtures/vit/003-viewdv-enriched-unregistered.xml`
 * is a live capture of a present, unregistered `VIEW/DV` (`ZTMD_V_442G2`),
 * and a repository search was recorded missing that same object — a miss
 * looks identical for that object and for one that genuinely does not
 * exist, so the probe cannot tell the two apart.
 */
const SEARCH_MISS_NOT_ABSENCE =
  "a miss is not proof of absence — it looks the same for an object that " +
  "genuinely does not exist and one that exists but is unregistered";

/**
 * Fallback probe: the same live repository search `resolveObject`'s
 * "ambiguous" branch and `abap_search` already trust — reused via
 * `searchExact` rather than a second, differently-filtered search call, to
 * stay consistent with what a caller would see from `abap_search` directly.
 *
 * - exact-name hit with matching `adtcore:type` → `confirmed`
 * - zero exact-name hits → `confirmed-absent`, UNLESS `expectType` is in
 *   {@link SEARCH_BLIND_TYPES}, where a zero-hit answer proves nothing
 * - exact-name hit with a different type → `indeterminate` (something with
 *   this name exists, but not provably this object)
 * - search call throws → `indeterminate`, message preserved
 *
 * {@link SEARCH_MISS_NOT_ABSENCE} — this primitive still reports a zero-hit
 * as `confirmed-absent` regardless; it's callers that decide how much to
 * trust it.
 */
export async function verifyViaRepositorySearch(
  conn: AbapConnection,
  objectName: string,
  expectType: string,
): Promise<VerifyOutcome> {
  const uri = `repository-search:${expectType}/${objectName}`;
  try {
    const hits = await searchExact(conn, objectName, expectType);
    if (hits.length === 0) {
      if (SEARCH_BLIND_TYPES.has(expectType.toUpperCase())) {
        return {
          status: "indeterminate",
          uri,
          reason:
            `The repository search returned 0 hits for ${objectName}, but it does not index ` +
            `${expectType} at all — a zero-hit is the only answer it can give for this type, ` +
            "present or absent, so it is not evidence. Treated as unproven rather than confirmed-absent.",
        };
      }
      return { status: "confirmed-absent", uri, via: "repository-search" };
    }
    const matching = hits.find((h) => h["adtcore:type"]?.toUpperCase() === expectType.toUpperCase());
    if (matching) {
      return { status: "confirmed", uri, via: "repository-search" };
    }
    return {
      status: "indeterminate",
      uri,
      reason:
        `The repository search found ${hits.length} exact-name match(es) for ${objectName}, but none ` +
        `typed ${expectType} (types seen: ${hits.map((h) => h["adtcore:type"] ?? "?").join(", ")}) — ` +
        "treated as unproven rather than either confirmed or confirmed-absent.",
    };
  } catch (e) {
    // Same UNSUPPORTED-is-not-absence guardrail as verifyViaVitBridge,
    // satisfied by construction: confirmed-absent above only comes from a
    // clean hits.length === 0, never from this catch block.
    return {
      status: "indeterminate",
      uri,
      reason: `Repository search failed before a status could be determined: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Combinator: try the VIT bridge first, only spend the extra round trip on
 * the repository-search fallback when the primary didn't `confirm`. When the
 * primary was `indeterminate`, the fallback's `confirmed` still wins
 * outright, but its `confirmed-absent` does not — {@link
 * SEARCH_MISS_NOT_ABSENCE}, so that case downgrades to `indeterminate`
 * instead of settling the question.
 *
 * A primary `confirmed-absent` gets one extra check instead of a free pass:
 * a thin stub is now positive evidence of absence, but this call
 * lands right after a create, so a false one would wrongly discard a
 * successful write. If the search says `confirmed`, the two probes
 * contradict each other — same shape as the stale-read contradiction documented in
 * {@link verifyObjectDeleted} — and this reports the contradiction rather
 * than resolving it either way.
 */
export async function verifyObjectCreated(
  conn: AbapConnection,
  opts: { vitType: string; objectName: string; expectType: string },
): Promise<VerifyOutcome> {
  const primary = await verifyViaVitBridge(conn, opts.vitType, opts.objectName, opts.expectType);
  if (primary.status === "confirmed") return primary;

  if (primary.status === "confirmed-absent") {
    const search = await verifyViaRepositorySearch(conn, opts.objectName, opts.expectType);
    if (search.status === "confirmed") {
      return {
        status: "indeterminate",
        uri: primary.uri,
        reason:
          `The VIT bridge concluded ${opts.expectType} ${opts.objectName} does not exist, ` +
          "but the repository search found an exact-name/type match — the two probes contradict " +
          "each other, treated as unproven rather than resolved either way.",
      };
    }
    return primary;
  }

  const fallback = await verifyViaRepositorySearch(conn, opts.objectName, opts.expectType);
  if (fallback.status === "confirmed") return fallback;
  if (fallback.status === "confirmed-absent") {
    return {
      status: "indeterminate",
      uri: fallback.uri,
      reason:
        `Neither probe proves absence. VIT bridge (${primary.uri}): ${primary.reason} Repository ` +
        `search found no exact-name hit — but ${SEARCH_MISS_NOT_ABSENCE}.`,
    };
  }

  return {
    status: "indeterminate",
    uri: fallback.uri,
    reason:
      `Neither probe could settle it. VIT bridge (${primary.uri}): ${primary.reason} ` +
      `Repository search: ${fallback.reason}`,
  };
}

/**
 * Post-create verification for the general write path, shaped as
 * {@link verifyObjectDeleted}'s mirror image so that function can reuse it directly:
 * a `200` read-back proves presence, but a `404` does NOT prove absence — a
 * just-created object's content URI can legitimately 404 for a beat before
 * it materialises, so a not-found read-back defers to
 * {@link verifyViaRepositorySearch} instead of settling the question itself.
 * The search fallback gets the same asymmetric trust: a HIT proves presence,
 * but a MISS only downgrades to indeterminate — deciding whether a retry is
 * safe is this helper's whole job, and a stale or type-blind index must
 * never stand in for absence. Never throws.
 */
export async function verifyObjectPresent(
  conn: AbapConnection,
  opts: { uri: string; accept: string; objectName: string; expectType: string },
): Promise<VerifyOutcome> {
  const { uri, accept, objectName, expectType } = opts;
  let readBackReason: string | undefined;
  try {
    await conn.get(uri, { headers: { Accept: accept } });
    return { status: "confirmed", uri, via: "read-back" };
  } catch (e) {
    if (isNotFoundError(e)) {
      readBackReason = "the read-back answered 404";
    } else {
      readBackReason = `the read-back failed before a status could be determined: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // The read-back was silent, not contradicted — a search hit here is the
  // normal shape of a created-but-empty object (a skeleton whose content URI
  // hasn't materialised yet), not a disagreement between two probes. Trust
  // it the same way verifyObjectCreated trusts this same search.
  const search = await verifyViaRepositorySearch(conn, objectName, expectType);
  if (search.status === "confirmed") return search;
  return {
    status: "indeterminate",
    uri,
    reason:
      search.status === "confirmed-absent"
        ? `Neither probe proves absence. Read-back (${uri}): ${readBackReason}. Repository ` +
          "search found no exact-name hit — but a miss is not proof either: the index can lag " +
          "a fresh create, and some object types are invisible to it entirely."
        : `Neither probe could settle it. Read-back (${uri}): ${readBackReason}. Repository search: ${search.reason}`,
  };
}

/** A source-endpoint 500 with a genuine ADT exception type — see source.ts's identical gate. */
function answeredFiveHundredWithType(e: unknown): boolean {
  const info = adtExceptionInfo(e);
  return info?.status === 500 && typeof info.type === "string" && info.type.length > 0;
}

/**
 * Post-DELETE verification. The inversion from every other probe in
 * this module: a `404` read-back is the SUCCESS signal (the object is
 * genuinely gone), and a `200` is NOT proof the delete failed.
 *
 * Live testing recorded why the `200` case can't be trusted alone: a `DELETE` on
 * `BDEF/BDO` answered `200`, the read-back still returned the object, and
 * a SECOND `DELETE` then answered `NOT_FOUND` while a THIRD read still
 * returned the object — the server had already treated the object as gone
 * while the read path kept handing back a stale copy. So a `200` here only
 * means "unproven", never "still there"; it falls through to
 * {@link verifyViaRepositorySearch}, whose `confirmed` settles the question
 * on its own — the read-back does not additionally have to agree. If the
 * read-back saw the object (`200`) and the search instead says
 * `confirmed-absent`, that contradiction is itself the stale-read shape described above
 * and is reported as `indeterminate` rather than resolved either way.
 *
 * Two fixes were considered: require two-probe agreement for absence, or (taken
 * here, the narrower option) refuse to accept a repository-search verdict as
 * `confirmed-absent` on its own. A `404` read-back settles absence outright,
 * above, before any search runs — a direct GET at the object's own URI
 * outweighs a search miss — but when the read-back is inconclusive
 * (`no-answer`, not a clean 404) and the search alone answers
 * `confirmed-absent`, that verdict downgrades to `indeterminate` instead.
 * The rejected option would tax every successful delete with an extra
 * search round trip for no evidential gain over the read-back `404` alone.
 *
 * The read-back goes through {@link probeObjectPresence} (one
 * reconnect-and-retry on a dead session, never a loop). FUGR/FF's
 * content endpoint 500s instead of 404ing for an absent module, so an
 * inconclusive 500 there gets one confirming GET at the bare object URI
 * before falling through to the search.
 */
export async function verifyObjectDeleted(
  conn: AbapConnection,
  opts: { uri: string; accept: string; objectName: string; expectType: string },
): Promise<VerifyOutcome> {
  const { uri, accept, objectName, expectType } = opts;
  const readBack = await probeObjectPresence(conn, uri, accept);
  if (readBack.presence === "absent") return { status: "confirmed-absent", uri, via: "read-back" };

  let sawObject = readBack.presence === "present";
  let readBackReason = sawObject
    ? "the read-back answered 200 — the object is still readable"
    : `the read-back failed before a status could be determined: ${readBack.error instanceof Error ? readBack.error.message : String(readBack.error)}`;
  let readBackUri = uri;

  // FUGR/FF's content endpoint answers 500 for an ABSENT module, so the
  // read-back can never 404 for it. Confirm at the bare object URI the narrow way
  // source.ts does — only on a 500 carrying a server-sent exception type.
  const objUri = objectUriOf(uri);
  if (!sawObject && objUri !== uri && answeredFiveHundredWithType(readBack.error)) {
    // The object URI serves metadata XML, not the content endpoint's media
    // type — reusing `accept` here risks a 406 that masks a real 404.
    const objAccept = capabilitiesFor(expectType)?.mediaType ?? "application/*";
    const direct = await probeObjectPresence(conn, objUri, objAccept);
    if (direct.presence === "absent") return { status: "confirmed-absent", uri: objUri, via: "read-back" };
    if (direct.presence === "present") {
      sawObject = true;
      readBackUri = objUri;
      readBackReason = `the read-back answered HTTP 500 with an ADT exception type, and a confirming GET of ${objUri} answered 200 — the object is still there`;
    } else {
      readBackUri = objUri;
      readBackReason = `the read-back answered HTTP 500 with an ADT exception type, and a confirming GET of ${objUri} did not answer at all, so it established nothing either way`;
    }
  }

  // A 200 or any other read-back failure is equally inconclusive (see the
  // doc comment above) — either way the repository search is the tie-breaker.
  const search = await verifyViaRepositorySearch(conn, objectName, expectType);
  if (search.status === "confirmed") return search;
  if (search.status === "confirmed-absent") {
    if (sawObject) {
      // The two probes contradict each other — exactly the stale-read
      // shape (a second DELETE answered NOT_FOUND while a read still
      // returned the object for BDEF/BDO). Report the contradiction rather
      // than resolving it either way.
      return {
        status: "indeterminate",
        uri,
        reason:
          `The post-delete read-back of ${expectType} ${objectName} answered 200 at ${readBackUri}, but the ` +
          "repository search found no trace of it — the same contradiction recorded live " +
          "for BDEF/BDO. A stale 200 read-back is not proof the delete failed; treated as unproven.",
      };
    }
    // The read-back never settled it, so a lone search miss cannot
    // stand in — see SEARCH_MISS_NOT_ABSENCE.
    return {
      status: "indeterminate",
      uri,
      reason:
        `The post-delete read-back of ${expectType} ${objectName} never settled it (${readBackReason}), and ` +
        `the repository search found no trace of it either — but ${SEARCH_MISS_NOT_ABSENCE}.`,
    };
  }
  return {
    status: "indeterminate",
    uri,
    reason: `Neither probe could settle it. Read-back (${readBackUri}): ${readBackReason}. Repository search: ${search.reason}`,
  };
}
