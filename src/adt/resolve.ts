/**
 * Object resolution: accept fuzzy input (`class ZCL_FOO`, `ZCL_FOO`, a raw URI)
 * and resolve it server-side, since the model can't reliably produce type codes.
 *
 * Parsing (pure, unit-tested) is separate from resolution (one HTTP round trip
 * against the repository search endpoint, to disambiguate the type or — when
 * it's already certain — to recover `packageName`; see `lookupPackageName`).
 */
import type { SearchResult } from "abap-adt-api";
import { isAddressableAbapObjectName } from "../safety.js";
import { capabilitiesFor, isBridgeOnlyCreateType, TERMINAL_REFUSAL_NOTE } from "./capabilities.js";
import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import { repairSearchDescriptions } from "./search-descriptions.js";
import {
  KEYWORDS_BY_LENGTH,
  TYPES,
  buildUri,
  classIncludeUri,
  classifyUnmatchedAdtPath,
  specForType,
  specFromUri,
  type ClassInclude,
  type TypeSpec,
} from "./types.js";

/** Human noun for a recognised sub-object segment; falls back to the segment itself. */
const SUB_OBJECT_NOUNS: Record<string, string> = {
  indexes: "index",
  values: "fixed value",
  objectstructure: "object structure",
};

/**
 * Whether the *active* version of an object is the current one. A three-valued
 * union, not a boolean: "unknown" (nobody checked) must stay distinct from
 * both other states, or a renderer doing `activation ? "active" : …` reports
 * confidence it doesn't have. See the git history.
 */
export type ActivationState = "active-is-current" | "newer-inactive-exists" | "unknown";

/**
 * Map an ADT `adtcore:version` attribute onto {@link ActivationState}. ADT
 * serves the *current* version when no `?version=` is given, so `inactive`
 * here means a newer inactive version exists over the active one — verified
 * against live fixtures, see the git history. Anything
 * else is `"unknown"`, never guessed into `"active-is-current"`.
 */
export function activationFromVersion(version: unknown): ActivationState {
  if (typeof version !== "string") return "unknown";
  const v = version.trim().toLowerCase();
  if (v === "active") return "active-is-current";
  if (v === "inactive") return "newer-inactive-exists";
  return "unknown";
}

export interface ParsedRef {
  /** Uppercased object name. */
  name: string;
  /** Type spec if the input pinned one down. */
  spec?: TypeSpec;
  /** Explicit ADT URI, when the caller supplied one. */
  uri?: string;
  /** Parent object (function group for a function module). */
  parent?: string;
  /** Method/form/function suffix, e.g. `ZCL_FOO=>CALCULATE`. */
  member?: string;
  /** Class include the input asked for. `undefined` ≠ `"main"` (see `UriMatch.include` in types.ts). */
  include?: ClassInclude;
  /** How the type was determined. */
  via: "uri" | "keyword" | "typecode" | "convention" | "unknown";
}

export interface ResolvedObject {
  system: string;
  type: string;
  kind: string;
  label: string;
  name: string;
  uri: string;
  /** Source URI, when the object is source-based. Honours {@link include}. */
  sourceUri?: string;
  /** Class include asked for, only ever set for `CLAS/OC`. `undefined` ≠ "main" — see `sourceUri`. */
  include?: ClassInclude;
  parent?: string;
  member?: string;
  description?: string;
  packageName?: string;
  mode: "source" | "ddic";
  /** Always present, `"unknown"` unless observed. `resolveObject` doesn't spend a round trip on this — see {@link checkActivation}. */
  activation: ActivationState;
  spec: TypeSpec;
}

/** Naming conventions — a hint only. Always confirmed server-side. */
function conventionSpec(name: string): TypeSpec | undefined {
  const n = name.toUpperCase();
  if (/^(Z|Y|\/\w+\/)?CL_/.test(n) || /^CL_/.test(n)) return specForType("CLAS/OC");
  if (/^(Z|Y|\/\w+\/)?IF_/.test(n) || /^IF_/.test(n)) return specForType("INTF/OI");
  if (/^(Z|Y)?I_/.test(n)) return specForType("DDLS/DF");
  return undefined;
}

/**
 * Parse a fuzzy object reference. Pure — no network, no throwing on ambiguity.
 *
 * Accepted shapes:
 *   "ZCL_FOO"                       bare name
 *   "class ZCL_FOO"                 keyword prefix
 *   "CLAS/OC ZCL_FOO"               explicit ADT type code
 *   "CLAS ZCL_FOO"                  short kind
 *   "ZCL_FOO=>CALCULATE"            member selector
 *   "ZCL_FOO->calculate"            member selector
 *   "function module Z_FOO in ZFG"  parent
 *   "ZFG/Z_FOO"                     parent/name
 *   "/sap/bc/adt/oo/classes/zcl_foo"  raw ADT URI (with or without /source/main)
 *   "abap://A4H/CLAS/ZCL_FOO"       MCP resource URI
 *
 * `hint` is the type the caller already knows out of band (`abap_write`'s
 * `type` argument), used only to disambiguate `A/B` as `container/name` vs. a
 * single name with a slash — see the git history for
 * the bug this fixed. An explicit type code or keyword INSIDE `input` still wins.
 */
export function parseObjectRef(input: string, hint?: TypeSpec): ParsedRef {
  const raw = (input ?? "").trim();
  if (!raw) throw new AbapError("BAD_INPUT", "Empty object reference.");

  // --- MCP resource URI: abap://{SID}/{TYPE}/{NAME}
  const res = /^abap:\/\/([^/]+)\/([^/]+)\/(.+)$/i.exec(raw);
  if (res) {
    const spec = specForType(res[2]!);
    const { name, member } = splitMember(res[3]!);
    return { name: name.toUpperCase(), spec, member, via: spec ? "typecode" : "unknown" };
  }

  // --- raw ADT URI
  if (/^https?:\/\//i.test(raw) || raw.startsWith("/sap/bc/adt/")) {
    const hit = specFromUri(raw);
    if (!hit) {
      const issue = classifyUnmatchedAdtPath(raw);

      if (issue?.kind === "sub-object") {
        const noun = SUB_OBJECT_NOUNS[issue.segment] ?? issue.segment;
        const article = /^[aeiou]/i.test(noun) ? "an" : "a";
        const target = issue.subName ? `${noun} ${issue.subName}` : `${article} ${noun}`;
        const parentLabel = issue.spec.label.toLowerCase();
        throw new AbapError(
          "UNSUPPORTED",
          `${noun[0]!.toUpperCase()}${noun.slice(1)} sub-objects are not readable: ${raw} ` +
            `addresses ${target} inside ${parentLabel} ${issue.name}.`,
          {
            uri: raw,
            type: issue.spec.type,
            object: issue.name,
            subObject: issue.segment,
            ...(issue.subName ? { subName: issue.subName } : {}),
          },
          `abapsmith addresses whole objects. Pass the ${parentLabel} itself: "${issue.name}" or ` +
            `${buildUri(issue.spec, issue.name, issue.parent)}.`,
        );
      }

      if (issue?.kind === "not-an-object") {
        throw new AbapError(
          "BAD_INPUT",
          `${raw} addresses a ${issue.what}, not an ABAP repository object.`,
          { uri: raw },
          issue.what === "transport request"
            ? "Use abap_transport to work with transport requests."
            : undefined,
        );
      }

      throw new AbapError(
        "BAD_INPUT",
        `Unrecognised ADT URI: ${raw}`,
        { uri: raw },
        "Pass an object name instead, e.g. \"class ZCL_FOO\".",
      );
    }
    return {
      name: hit.name,
      spec: hit.spec,
      parent: hit.parent,
      // Must propagate: dropping it silently substitutes /source/main for whatever include was asked for.
      include: hit.include,
      uri: buildUri(hit.spec, hit.name, hit.parent),
      via: "uri",
    };
  }

  let rest = raw;
  let spec: TypeSpec | undefined;
  let via: ParsedRef["via"] = "unknown";

  // --- explicit type code prefix: "CLAS/OC ZCL_FOO" / "CLAS ZCL_FOO"
  const codeMatch = /^([A-Za-z]{4}(?:\/[A-Za-z]{1,3})?)\s+(.+)$/.exec(rest);
  if (codeMatch) {
    const candidate = specForType(codeMatch[1]!);
    // A registered keyword strictly longer than the matched code wins — else
    // "type group X" parses as code TYPE + name "group X" instead of the
    // multi-word keyword "type group".
    const lower = rest.toLowerCase();
    const stolenByLongerKeyword = KEYWORDS_BY_LENGTH.some(
      ({ keyword }) => keyword.length > codeMatch[1]!.length && lower.startsWith(keyword + " "),
    );
    if (candidate && !stolenByLongerKeyword) {
      spec = candidate;
      rest = codeMatch[2]!.trim();
      via = "typecode";
    }
  }

  // --- keyword prefix: "class ZCL_FOO", "function module Z_X"
  if (!spec) {
    const lower = rest.toLowerCase();
    for (const { keyword, spec: cand } of KEYWORDS_BY_LENGTH) {
      if (lower.startsWith(keyword + " ")) {
        spec = cand;
        rest = rest.slice(keyword.length).trim();
        via = "keyword";
        break;
      }
    }
  }

  // --- trailing " in <parent>" / " of <parent>"
  let parent: string | undefined;
  const inMatch = /^(.*?)\s+(?:in|of|from)\s+([A-Za-z0-9_/]+)$/i.exec(rest);
  if (inMatch) {
    rest = inMatch[1]!.trim();
    parent = inMatch[2]!.toUpperCase();
    if (!isAddressableAbapObjectName(parent)) {
      throw new AbapError(
        "BAD_INPUT",
        `${JSON.stringify(parent)} is not a valid container name in ${JSON.stringify(input)}.`,
        { input, parent },
        "The container name is embedded in the object's URI, so a malformed one would address a " +
          "different object than the one you meant. Fix the spelling, e.g. \"ZFM in ZFG\".",
      );
    }
  }

  // --- member selector
  const { name: namePart, member } = splitMember(rest);
  let name = namePart;

  // --- "PARENT/NAME" for function modules (only when a parent is meaningful)
  const parentAware = spec ?? hint;
  if (!parent && parentAware?.parentPath && name.includes("/")) {
    const split = splitParentName(name);
    if (split) {
      parent = split.parent.toUpperCase();
      name = split.name;
    }
  }

  name = name.trim().replace(/^["'`]|["'`]$/g, "");
  if (!isAddressableAbapObjectName(name)) {
    throw new AbapError(
      "BAD_INPUT",
      `Could not extract an ABAP object name from ${JSON.stringify(input)}.`,
      { input },
      name.includes("/")
        ? 'Pass the object\'s type (e.g. type: "FUGR/FF") to address it as "PARENT/NAME", ' +
          'or spell it as "NAME in GROUP".'
        : 'Try "class ZCL_FOO", "ZCL_FOO", or a full ADT URI.',
    );
  }
  name = name.toUpperCase();

  if (!spec) {
    const guess = conventionSpec(name);
    if (guess) {
      spec = guess;
      via = "convention";
    }
  }

  return { name, spec, parent, member, via };
}

function splitMember(s: string): { name: string; member?: string } {
  const m = /^(.*?)(?:=>|->|~|::|\.)([A-Za-z_][A-Za-z0-9_~/]*)$/.exec(s.trim());
  if (!m) return { name: s.trim() };
  // "/DMO/CL_X" must not be mistaken for a member selector.
  return { name: m[1]!.trim(), member: m[2]!.toUpperCase() };
}

/**
 * The one `/` where both `input.slice(0, i)` and `input.slice(i + 1)` are
 * addressable names on their own — whether the tail is a plain identifier or
 * itself starts with `/NS/`, which `isAddressableAbapObjectName` already
 * tells apart, so one check covers both. More than one such `/`, or none, is
 * ambiguous or unsplittable and is refused rather than guessed at.
 *
 * Replaces a bare `lastIndexOf("/")`, which could not tell a namespace
 * separator (`/DMO/FOO`) from a parent separator, and silently misparsed
 * `ZFG//DMO/FM` into parent `ZFG//DMO`, name `FM` — a different object than
 * the caller named.
 */
function splitParentName(input: string): { parent: string; name: string } | undefined {
  const candidates: Array<{ parent: string; name: string }> = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== "/") continue;
    const parent = input.slice(0, i);
    if (!isAddressableAbapObjectName(parent)) continue;
    const name = input.slice(i + 1);
    if (isAddressableAbapObjectName(name)) candidates.push({ parent, name });
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

export interface ResolveOptions {
  /** Restrict the server-side search to this type. */
  type?: string;
  /** Skip the type-disambiguation search when already certain. A `packageName` lookup still runs. */
  trustHint?: boolean;
  maxCandidates?: number;
}

/**
 * Resolve a fuzzy reference to a concrete `{system, type, name, uri}`.
 *
 * A hint from `via: "typecode" | "uri" | "keyword"` is trusted for TYPE, so no
 * disambiguation search runs; a naming-convention guess, or no hint, always
 * goes to the search endpoint — guessing the type is the server's job. Either
 * way one search happens: even a type-certain ref spends a round trip to
 * recover `packageName` (see `lookupPackageName`), since nothing else derives it.
 */
export async function resolveObject(
  conn: AbapConnection,
  input: string,
  opts: ResolveOptions = {},
): Promise<ResolvedObject> {
  // Explicit-type refusal, before any parsing or network I/O: NON_READABLE_TYPES
  // (the registry's `unsupported` types, plus bridge-only-create types with
  // no ADT collection) aren't in types.ts's TYPES array, so without this an
  // explicit type hint would fall straight through to a live search and
  // surface a generic NOT_FOUND/"not a readable source object" instead of
  // naming the real, already-known reason. Mirrors resolveWriteTarget's
  // identical check in write.ts.
  if (opts.type) {
    const cap = capabilitiesFor(opts.type);
    const code = opts.type.trim().toUpperCase();
    if (cap?.unsupported) {
      throw new AbapError(
        "UNSUPPORTED",
        `${cap.label} (${code}) cannot be read by abapsmith. ${cap.unsupported.reason} ${TERMINAL_REFUSAL_NOTE}`,
        { type: code },
        cap.unsupported.alternative,
        { retryable: false }, // matches UNSUPPORTED's own default; reaffirmed for readability at the throw site
      );
    }
    // DEVC/K also declares bridgeCreate but has a real ADT collection
    // and resolves fine, so it's excluded here; only VIEW/DV, TRAN/T, and
    // TABL/DI truly have none.
    if (cap?.bridgeCreate && isBridgeOnlyCreateType(opts.type)) {
      throw new AbapError(
        "UNSUPPORTED",
        `${cap.label} (${code}) has no ADT-readable collection to resolve a URI against. ` +
          `${cap.bridgeCreate.adtRest} ${TERMINAL_REFUSAL_NOTE}`,
        { type: code },
        // Registry-sourced when the create is refused, so this hint cannot
        // send a caller to `abap_write` for a create `abap_write` will refuse.
        cap.bridgeCreate.createRefused ??
          "abapsmith can create this type through a generated classrun bridge (see abap_write), " +
            "but cannot read one back.",
        { retryable: false }, // matches UNSUPPORTED's own default; reaffirmed for readability at the throw site
      );
    }
  }

  // Computed before the parse so it can be passed as the parser's `hint` — needed to
  // resolve "ZGRP/ZFM"-style container/name ambiguity. See the git history.
  const forced = opts.type ? specForType(opts.type) : undefined;
  const parsed = parseObjectRef(input, forced);
  const spec = forced ?? parsed.spec;

  const certain =
    forced !== undefined ||
    parsed.via === "uri" ||
    parsed.via === "typecode" ||
    parsed.via === "keyword" ||
    opts.trustHint === true;

  if (spec && certain && (!spec.parentPath || parsed.parent)) {
    // Type-certain still doesn't mean package-certain: no ref shape encodes packageName, so
    // it's looked up separately (else SafetyGate saw undefined and denied every such ref).
    const packageName = await lookupPackageName(conn, parsed.name, spec.type);
    return finish(conn, spec, parsed.name, parsed, { packageName });
  }

  // Ambiguous → ask the server.
  const results = await searchExact(conn, parsed.name, spec?.type);
  if (results.length === 0) {
    // A convention-guessed spec gets one direct read before being called missing —
    // searchExact is strong evidence but not authoritative. See the git history.
    const guessed = forced === undefined && parsed.via === "convention";
    if (spec && !guessed) return finish(conn, spec, parsed.name, parsed, {});
    if (spec && guessed && (await existsAt(conn, buildUri(spec, parsed.name, parsed.parent)))) {
      return finish(conn, spec, parsed.name, parsed, {});
    }
    throw new AbapError(
      "NOT_FOUND",
      `No ABAP object named ${parsed.name} was found.`,
      {
        name: parsed.name,
        ...(spec ? { assumedType: spec.type, assumedFrom: "naming-convention" } : {}),
      },
      spec
        ? `The name looks like a ${spec.label} by convention, but the repository search found ` +
          `no object called ${parsed.name} and a direct read of the ${spec.label} URI did not ` +
          "find one either. Check the spelling, or use abap_search with a pattern " +
          '(e.g. {"query": "ZCL_*"}).'
        : 'Use abap_search to look for a pattern, e.g. {"query": "ZCL_*"}.',
    );
  }

  const usable = results
    .map((r) => ({ r, spec: specForType(r["adtcore:type"]) }))
    .filter((x): x is { r: SearchResult; spec: TypeSpec } => x.spec !== undefined);

  if (usable.length === 0) {
    throw new AbapError(
      "UNSUPPORTED",
      `${parsed.name} exists but its type (${results[0]!["adtcore:type"]}) is not a readable source object.`,
      { name: parsed.name, types: results.map((r) => r["adtcore:type"]) },
    );
  }

  if (usable.length > 1) {
    const preferred = spec ? usable.find((u) => u.spec.type === spec.type) : undefined;
    if (!preferred) {
      throw new AbapError(
        "AMBIGUOUS",
        `${parsed.name} matches ${usable.length} object types.`,
        { candidates: usable.map((u) => ({ type: u.spec.type, name: u.r["adtcore:name"] })) },
        'Disambiguate with a type prefix, e.g. "class ZCL_FOO" or {"type": "TABL/DT"}.',
      );
    }
    return finishFromSearch(conn, preferred.spec, preferred.r, parsed);
  }

  return finishFromSearch(conn, usable[0]!.spec, usable[0]!.r, parsed);
}

/**
 * Exact-name lookup against `/repository/informationsystem/search`.
 *
 * Exported for `write-verify.ts`'s fallback probe — the same conclusive search
 * this module uses to settle existence. Do not duplicate this logic; import it.
 * See the git history.
 */
export async function searchExact(
  conn: AbapConnection,
  name: string,
  type?: string,
): Promise<SearchResult[]> {
  const kind = type?.split("/")[0];
  const results = await conn.adt.searchObject(name, kind, 25);
  // Repaired over the whole group before filtering by name — filtering first
  // would leave nothing to repair.
  const { refs: repaired } = repairSearchDescriptions(results);
  const exact = repaired.filter((r) => r["adtcore:name"]?.toUpperCase() === name.toUpperCase());
  return exact.length ? exact : [];
}

/**
 * Which types does the server say already exist under this exact name?
 *
 * Distinct from `resolveObject`: it answers only "what is it", never throws,
 * and reports ambiguity as a list rather than an error — so a caller that must
 * not guess (a write) can decide for itself whether the answer is good enough.
 */
export async function identifyByName(conn: AbapConnection, name: string): Promise<TypeSpec[]> {
  const results = await searchExact(conn, name).catch(() => []);
  const byType = new Map<string, TypeSpec>();
  for (const r of results) {
    const spec = specForType(r["adtcore:type"]);
    if (spec) byType.set(spec.type, spec);
  }
  return [...byType.values()];
}

/** Does the server actually have an object at this URI? Only a real answer counts. */
async function existsAt(conn: AbapConnection, uri: string): Promise<boolean> {
  try {
    return Boolean(await conn.adt.objectStructure(uri));
  } catch {
    // Could not look. The search already said no; do not invent a yes.
    return false;
  }
}

/**
 * Best-effort package lookup for the "certain" fast path (type already known,
 * package not). Reuses `searchExact` rather than `write.ts`'s heavier
 * authoritative scrape, for consistency with the bare-name path. A miss
 * degrades to `undefined` rather than throwing — this is a value-add for
 * `SafetyGate`, not a correctness gate. See the git history.
 */
async function lookupPackageName(
  conn: AbapConnection,
  name: string,
  type: string,
): Promise<string | undefined> {
  try {
    const results = await searchExact(conn, name, type);
    return results[0]?.["adtcore:packageName"];
  } catch {
    return undefined;
  }
}

function finishFromSearch(
  conn: AbapConnection,
  spec: TypeSpec,
  r: SearchResult,
  parsed: ParsedRef,
): ResolvedObject {
  const uri = cleanUri(r["adtcore:uri"]);

  // adtcore:uri is the only carrier of a function module's parent group (unreadable from
  // the name alone) — lift it out so finish()'s two-segment guard doesn't reject a valid hit.
  const enriched = parsed.parent ? parsed : withParentFromUri(parsed, uri);

  return finish(conn, spec, r["adtcore:name"].toUpperCase(), enriched, {
    description: r["adtcore:description"],
    packageName: r["adtcore:packageName"],
    uri,
    // Free if the server volunteers adtcore:version; SearchResult doesn't type it but
    // searchObject returns every objectReference attribute. Usually "unknown", not "active".
    activation: activationFromVersion(
      (r as unknown as Record<string, unknown>)["adtcore:version"],
    ),
  });
}

/**
 * Explicitly ask the server whether the active version is current. Costs one
 * round trip (`GET {uri}`), so it's deliberately not part of `resolveObject` —
 * most reads don't need it. Failure reports `"unknown"`, never `"active-is-current"`.
 */
export async function checkActivation(
  conn: AbapConnection,
  obj: Pick<ResolvedObject, "uri">,
): Promise<ActivationState> {
  try {
    // AbapMetaData declares adtcore:version for every object kind; no cast needed.
    const struc = await conn.adt.objectStructure(obj.uri);
    return activationFromVersion(struc?.metaData?.["adtcore:version"]);
  } catch {
    return "unknown";
  }
}

/** `resolveObject` + one extra round trip to fill in {@link ResolvedObject.activation}. */
export async function resolveObjectWithActivation(
  conn: AbapConnection,
  input: string,
  opts: ResolveOptions = {},
): Promise<ResolvedObject> {
  const obj = await resolveObject(conn, input, opts);
  if (obj.activation !== "unknown") return obj;
  return { ...obj, activation: await checkActivation(conn, obj) };
}

/** Recover `parent` from an ADT URI (function modules / group includes). */
function withParentFromUri(parsed: ParsedRef, uri: string | undefined): ParsedRef {
  if (!uri) return parsed;
  const hit = specFromUri(uri);
  return hit?.parent ? { ...parsed, parent: hit.parent } : parsed;
}

function finish(
  conn: AbapConnection,
  spec: TypeSpec,
  name: string,
  parsed: ParsedRef,
  extra: {
    description?: string;
    packageName?: string;
    uri?: string;
    activation?: ActivationState;
  },
): ResolvedObject {
  if (spec.parentPath && !parsed.parent) {
    throw new AbapError(
      "BAD_INPUT",
      `${spec.label} ${name} needs its function group.`,
      { name, type: spec.type },
      'Say e.g. "function module Z_FOO in ZFG" or "ZFG/Z_FOO".',
    );
  }
  const uri = cleanUri(extra.uri) ?? parsed.uri ?? buildUri(spec, name, parsed.parent);

  // Gate on the spec we finish with, not the parsed one — opts.type can force a disagreement.
  const include = spec.type === "CLAS/OC" ? parsed.include : undefined;

  // Classes must go through classIncludeUri, not a hand-built `${uri}/source/main` — see
  // the git history for the include-downgrade bug this replaced.
  const sourceUri = spec.supportsSource
    ? spec.type === "CLAS/OC"
      ? classIncludeUri(uri, include ?? "main")
      : `${uri}/source/main`
    : undefined;

  return {
    system: conn.cfg.sid,
    type: spec.type,
    kind: spec.kind,
    label: spec.label,
    name,
    uri,
    sourceUri,
    include,
    parent: parsed.parent,
    member: parsed.member,
    description: extra.description,
    packageName: extra.packageName,
    mode: spec.mode,
    // Never omitted: a consumer must name a state before claiming the active version is current.
    activation: extra.activation ?? "unknown",
    spec,
  };
}

/** Search results carry `#type=...` fragments and query strings; strip them. */
function cleanUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  return uri.replace(/[?#].*$/, "");
}
