/**
 * ADT object type registry: keyword → type code → URI, and back.
 *
 * URI shapes verified against A4H on 2026-07-31; `supportsSource` reflects
 * that release (TABL/TABL-DS have source, TTYP/DTEL/DOMA don't — 404 live).
 * The discovery probe re-checks at runtime rather than trusting this table.
 */

import { AbapError } from "./errors.js";

export type ReadMode = "source" | "ddic";

/**
 * The five includes ADT exposes for a global class (verified against the
 * `abap-adt-api` build's `ADTClient.classIncludes`). `.../includes/main` is
 * an accepted input alias; we always emit the canonical `/source/main`.
 *
 * ABAP Unit reports failures by line *inside* `testclasses`, so this list
 * isn't cosmetic — a future test-runner needs it to map a failure to a line.
 */
export const CLASS_INCLUDES = [
  "main",
  "definitions",
  "implementations",
  "macros",
  "testclasses",
] as const;

export type ClassInclude = (typeof CLASS_INCLUDES)[number];

export function isClassInclude(s: string): s is ClassInclude {
  return (CLASS_INCLUDES as readonly string[]).includes(s);
}

/** Strip any `/source/main` or `/includes/<x>` suffix from a class URI. */
function classBaseUri(uri: string): string {
  const p = uri
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
  const m = /^(.*\/oo\/classes\/[^/]+)(?:\/source\/main|\/includes\/[^/]+)?$/i.exec(p);
  return m ? m[1]! : p.replace(/\/source\/main$/, "");
}

/**
 * URI of one class include's source.
 *
 * Never silently downgrades: asking for `testclasses` yields the testclasses
 * URI or nothing at all.
 */
export function classIncludeUri(classUri: string, include: ClassInclude): string {
  const base = classBaseUri(classUri);
  return include === "main" ? `${base}/source/main` : `${base}/includes/${include}`;
}

/** Loud rejection for an include name ADT does not have. */
export function assertClassInclude(requested: string, context?: string): ClassInclude {
  const want = requested.trim().toLowerCase();
  if (isClassInclude(want)) return want;
  throw new AbapError(
    "UNSUPPORTED",
    `Unknown class include "${requested}"${context ? ` in ${context}` : ""}. ` +
      `ADT exposes exactly: ${CLASS_INCLUDES.join(", ")}.`,
    { requested, supported: [...CLASS_INCLUDES], ...(context ? { uri: context } : {}) },
    "Ask for one of the supported includes — the request is NOT silently answered " +
      "with the main class source.",
  );
}

export interface TypeSpec {
  /** ADT type code, e.g. `CLAS/OC`. */
  type: string;
  /** Short kind, e.g. `CLAS`. */
  kind: string;
  /** Human label used in rendered output. */
  label: string;
  /** ADT collection path; `{name}` is substituted lowercase. */
  path: string;
  /** How `abap_read` should render it. */
  mode: ReadMode;
  /** Does `<uri>/source/main` exist on a modern release? */
  supportsSource: boolean;
  /** Words the model may plausibly use for this type. */
  keywords: string[];
  /** Needs a parent object name in the URI (function modules/includes). */
  parentPath?: string;
}

export const TYPES: TypeSpec[] = [
  {
    type: "CLAS/OC",
    kind: "CLAS",
    label: "Class",
    path: "/sap/bc/adt/oo/classes/{name}",
    mode: "source",
    supportsSource: true,
    keywords: ["class", "clas", "abap class", "oo"],
  },
  {
    type: "INTF/OI",
    kind: "INTF",
    label: "Interface",
    path: "/sap/bc/adt/oo/interfaces/{name}",
    mode: "source",
    supportsSource: true,
    keywords: ["interface", "intf"],
  },
  {
    type: "PROG/P",
    kind: "PROG",
    label: "Program",
    path: "/sap/bc/adt/programs/programs/{name}",
    mode: "source",
    supportsSource: true,
    keywords: ["program", "prog", "report", "executable"],
  },
  {
    type: "PROG/I",
    kind: "PROG/I",
    label: "Include",
    path: "/sap/bc/adt/programs/includes/{name}",
    mode: "source",
    supportsSource: true,
    keywords: ["include", "incl"],
  },
  {
    type: "FUGR/F",
    kind: "FUGR",
    label: "Function group",
    path: "/sap/bc/adt/functions/groups/{name}",
    mode: "source",
    supportsSource: true,
    keywords: ["function group", "fugr", "fgroup"],
  },
  {
    type: "FUGR/FF",
    kind: "FUGR/FF",
    label: "Function module",
    path: "/sap/bc/adt/functions/groups/{parent}/fmodules/{name}",
    parentPath: "/sap/bc/adt/functions/groups/{parent}",
    mode: "source",
    supportsSource: true,
    keywords: ["function module", "function", "fm", "fugr/ff"],
  },
  {
    type: "FUGR/I",
    kind: "FUGR/I",
    label: "Function group include",
    path: "/sap/bc/adt/functions/groups/{parent}/includes/{name}",
    parentPath: "/sap/bc/adt/functions/groups/{parent}",
    mode: "source",
    supportsSource: true,
    keywords: ["function group include", "fugr include"],
  },
  {
    // `keywords` is a lookup aid only — one URI/type covers both classic and
    // modern CDS syntax generations. Target release here (7.54) needs the
    // classic `define view` form; `define view entity` etc. don't exist on
    // it (confirmed live — see archive and doc/LIMITATIONS/not-implemented-and-unproven.md).
    type: "DDLS/DF",
    kind: "DDLS",
    label: "CDS view / DDL source",
    path: "/sap/bc/adt/ddic/ddl/sources/{name}",
    mode: "source",
    supportsSource: true,
    keywords: ["cds", "ddls", "ddl", "cds view", "view entity", "data definition"],
  },
  {
    type: "DDLX/EX",
    kind: "DDLX",
    label: "Metadata extension",
    path: "/sap/bc/adt/ddic/ddlx/sources/{name}",
    mode: "source",
    supportsSource: true,
    keywords: ["ddlx", "metadata extension"],
  },
  {
    type: "SRVD/SRV",
    kind: "SRVD",
    label: "Service definition",
    path: "/sap/bc/adt/ddic/srvd/sources/{name}",
    mode: "source",
    supportsSource: true,
    keywords: ["srvd", "service definition"],
  },
  {
    type: "BDEF/BDO",
    kind: "BDEF",
    label: "Behavior definition",
    path: "/sap/bc/adt/bo/behaviordefinitions/{name}",
    mode: "source",
    supportsSource: true,
    keywords: ["bdef", "behavior definition", "behaviour definition"],
  },
  {
    type: "XSLT/VT",
    kind: "XSLT",
    label: "Transformation",
    path: "/sap/bc/adt/xslt/sources/{name}",
    mode: "source",
    supportsSource: true,
    keywords: ["xslt", "transformation"],
  },
  // ---- Enhancement framework: BAdI impls, source plug-ins, enhancement
  // spots. URIs/behaviour verified live on A4H. ENHO/XH and ENHS/XS have no
  // /source/main (structured XML only), so mode stays "ddic" — routes reads
  // through readDdic's clean UNSUPPORTED instead of a 404. Only ENHO/XHH has
  // verified real source (PUT .../source/main → 200).
  {
    type: "ENHO/XH",
    kind: "ENHO/XH",
    label: "BAdI implementation",
    path: "/sap/bc/adt/enhancements/enhoxh/{name}",
    mode: "ddic",
    supportsSource: false, // verified on A4H: no /source/main, structured XML only
    keywords: ["badi implementation", "badi impl", "enhoxh", "enho"],
  },
  {
    type: "ENHO/XHH",
    kind: "ENHO/XHH",
    label: "Enhancement source plug-in",
    path: "/sap/bc/adt/enhancements/enhoxhh/{name}",
    mode: "source",
    supportsSource: true, // verified on A4H: PUT {uri}/source/main → 200
    keywords: ["source plugin", "source code plugin", "enhancement plugin", "enhoxhh"],
  },
  {
    type: "ENHS/XS",
    kind: "ENHS",
    label: "Enhancement spot",
    path: "/sap/bc/adt/enhancements/enhsxs/{name}",
    mode: "ddic",
    supportsSource: false, // verified on A4H: no /source/main, structured XML only
    keywords: ["enhancement spot", "badi spot", "enhsxs", "enhs"],
  },
  // ---- DDIC: rendered as pseudo-DDL, never as raw ADT XML ----
  {
    type: "TABL/DT",
    kind: "TABL",
    label: "Database table",
    path: "/sap/bc/adt/ddic/tables/{name}",
    mode: "ddic",
    supportsSource: true, // verified on A4H: source-based
    keywords: ["table", "tabl", "database table", "transparent table"],
  },
  {
    type: "TABL/DS",
    kind: "STRU",
    label: "Structure",
    path: "/sap/bc/adt/ddic/structures/{name}",
    mode: "ddic",
    supportsSource: true, // verified on A4H: source-based
    keywords: ["structure", "stru", "ddic structure"],
  },
  {
    type: "DTEL/DE",
    kind: "DTEL",
    label: "Data element",
    path: "/sap/bc/adt/ddic/dataelements/{name}",
    mode: "ddic",
    supportsSource: false, // verified on A4H: /source/main → 404
    keywords: ["data element", "dtel"],
  },
  {
    type: "DOMA/DD",
    kind: "DOMA",
    label: "Domain",
    path: "/sap/bc/adt/ddic/domains/{name}",
    mode: "ddic",
    supportsSource: false, // verified on A4H: /source/main → 404
    keywords: ["domain", "doma"],
  },
  {
    type: "TTYP/DA",
    kind: "TTYP",
    label: "Table type",
    path: "/sap/bc/adt/ddic/tabletypes/{name}",
    mode: "ddic",
    supportsSource: false, // verified on A4H: /source/main → 404
    keywords: ["table type", "ttyp"],
  },
  // MSAG/ENQU exist here for the WRITE path (capabilities.ts REGISTRY),
  // reached via specForType. mode "ddic" routes READ into readDdic's clean
  // UNSUPPORTED. Neither has /source/main (verified live, 404) — must not
  // claim supportsSource.
  {
    type: "MSAG/N",
    kind: "MSAG",
    label: "Message class",
    // Singular "messageclass", and no `ddic/` prefix — verified live; the
    // plural guess 404s.
    path: "/sap/bc/adt/messageclass/{name}",
    mode: "ddic",
    supportsSource: false,
    keywords: ["message class", "msag", "messages"],
  },
  {
    type: "ENQU/DL",
    kind: "ENQU",
    label: "Lock object",
    // `.../lockobjects/sources/{name}` — the `sources` segment is part of the
    // collection path, not a source sub-resource.
    path: "/sap/bc/adt/ddic/lockobjects/sources/{name}",
    mode: "ddic",
    supportsSource: false,
    keywords: ["lock object", "enqu", "enqueue object"],
  },
  {
    type: "DEVC/K",
    kind: "DEVC",
    label: "Package",
    path: "/sap/bc/adt/packages/{name}",
    mode: "ddic",
    supportsSource: false,
    keywords: ["package", "devc", "development class"],
  },
  // RAP service binding: one XML doc at the object's own URI (no
  // /source/main; GET .../content 404s) — unlike DDLS/DDLX/SRVD/BDEF above.
  // A provenance conflict over whether SRVB exists on A4H at all was
  // resolved by live verification on 2026-08-18 (create/activate/read-back/
  // delete all succeeded); see the git history and the
  // SRVB/SVB entry in src/adt/capabilities.ts for the full history and the
  // vendor media-type override this type needs.
  {
    type: "SRVB/SVB",
    kind: "SRVB",
    label: "Service binding",
    path: "/sap/bc/adt/businessservices/bindings/{name}",
    mode: "ddic",
    supportsSource: false,
    keywords: [
      "service binding",
      "srvb",
      "svb",
      "odata service",
      "rap service binding",
      "binding",
    ],
  },
];

const BY_TYPE = new Map<string, TypeSpec>(TYPES.map((t) => [t.type, t]));
const BY_KIND = new Map<string, TypeSpec>(TYPES.map((t) => [t.kind, t]));

/**
 * Do not add a `BY_TYPE.get(\`${t}/${t.slice(0, 2)}\`)` subtype-guessing
 * fallback — it can never hit (real subtype codes aren't a kind's first two
 * letters, e.g. CLAS/OC not CLAS/CL) and BY_KIND already covers the intent.
 * Asserted in test/types.test.ts.
 */
export function specForType(type: string | undefined): TypeSpec | undefined {
  if (!type) return undefined;
  const t = type.toUpperCase().trim();
  return BY_TYPE.get(t) ?? BY_KIND.get(t);
}

/** Resolve a bare object-type word ("class", "cds view") to a spec. */
export function specForKeyword(word: string): TypeSpec | undefined {
  const w = word.toLowerCase().trim().replace(/\s+/g, " ");
  if (!w) return undefined;
  const exact = TYPES.find((t) => t.keywords.includes(w));
  if (exact) return exact;
  return specForType(w.toUpperCase());
}

/** Longest keyword first, so "function module" beats "function". */
export const KEYWORDS_BY_LENGTH: Array<{ keyword: string; spec: TypeSpec }> = TYPES.flatMap((spec) =>
  spec.keywords.map((keyword) => ({ keyword, spec })),
).sort((a, b) => b.keyword.length - a.keyword.length);

export function buildUri(spec: TypeSpec, name: string, parent?: string): string {
  return spec.path
    .replace("{name}", encodeURIComponent(name.toLowerCase()))
    .replace("{parent}", encodeURIComponent((parent ?? "").toLowerCase()));
}

export interface UriMatch {
  spec: TypeSpec;
  name: string;
  parent?: string;
  /**
   * Which class include the URI actually asked for. Present only for
   * `/oo/classes/…` URIs. `undefined` means "the caller did not ask for a
   * particular include" — which is NOT the same as `"main"`, and callers must
   * not conflate the two.
   */
  include?: ClassInclude;
  /** Ready-to-GET source URI honouring {@link include}. */
  sourceUri?: string;
}

/**
 * Reverse-map an ADT URI to a type spec + object name.
 *
 * Used to *delete* the `/includes/<x>` suffix, silently handing back the
 * main class body for e.g. a testclasses request. The include is now
 * preserved; an unknown include name throws (see {@link assertClassInclude}).
 */
export function specFromUri(uri: string): UriMatch | undefined {
  let path = uri
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/[?#].*$/, "")
    .replace(/\/source\/main.*$/, "");

  // Scoped to /oo/classes/ on purpose: program/function-group includes are
  // *object* paths whose last segment is a name — an old unscoped strip
  // mangled includes literally called MAIN, MACROS, DEFINITIONS, ….
  let include: ClassInclude | undefined;
  const ci = /^(.*\/oo\/classes\/[^/]+)\/includes\/([^/]+)$/i.exec(path);
  if (ci) {
    include = assertClassInclude(decodeURIComponent(ci[2]!), uri);
    path = ci[1]!;
  }

  // Two-segment types first (function modules / group includes).
  let m = /^\/sap\/bc\/adt\/functions\/groups\/([^/]+)\/fmodules\/([^/]+)$/i.exec(path);
  if (m) return { spec: BY_TYPE.get("FUGR/FF")!, name: dec(m[2]!), parent: dec(m[1]!) };
  m = /^\/sap\/bc\/adt\/functions\/groups\/([^/]+)\/includes\/([^/]+)$/i.exec(path);
  if (m) return { spec: BY_TYPE.get("FUGR/I")!, name: dec(m[2]!), parent: dec(m[1]!) };

  for (const spec of TYPES) {
    if (spec.parentPath) continue;
    const prefix = spec.path.replace("/{name}", "");
    const re = new RegExp(`^${escapeRe(prefix)}/([^/]+)$`, "i");
    const hit = re.exec(path);
    if (!hit) continue;
    const name = dec(hit[1]!);
    if (include) {
      // An include was asked for but the path is not a class — cannot happen
      // via the regex above, which is anchored on /oo/classes/. Kept as a
      // tripwire so a future path edit fails loudly instead of substituting.
      if (spec.type !== "CLAS/OC") {
        throw new AbapError(
          "UNSUPPORTED",
          `${spec.label} ${name} has no "${include}" include — class includes exist only for classes.`,
          { uri, type: spec.type, requested: include },
        );
      }
      return {
        spec,
        name,
        include,
        sourceUri: classIncludeUri(buildUri(spec, name), include),
      };
    }
    return { spec, name };
  }
  return undefined;
}

const dec = (s: string) => decodeURIComponent(s).toUpperCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type AdtPathIssue =
  | { kind: "sub-object"; spec: TypeSpec; name: string; parent?: string; segment: string; subName?: string }
  | { kind: "not-an-object"; what: string }
  | undefined;

/** Paths under /sap/bc/adt/ that address something outside the object model. */
const NOT_AN_OBJECT: Array<{ re: RegExp; what: string }> = [
  { re: /^\/sap\/bc\/adt\/cts\/transportrequests\/[^/]+\/?$/i, what: "transport request" },
];

const TWO_SEGMENT_KINDS: Array<{ type: string; mid: string }> = [
  { type: "FUGR/FF", mid: "fmodules" },
  { type: "FUGR/I", mid: "includes" },
];

/**
 * Diagnoses an ADT path `specFromUri` did not match: a known object with a
 * trailing sub-object suffix (`/indexes/z01`, `/objectstructure`, …), or a
 * path that was never an object in the first place (a transport request).
 * Everything else stays `undefined` — the caller's generic refusal applies.
 */
export function classifyUnmatchedAdtPath(uri: string): AdtPathIssue {
  const path = uri
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/[?#].*$/, "")
    .replace(/\/source\/main.*$/, "");

  for (const { re, what } of NOT_AN_OBJECT) {
    if (re.test(path)) return { kind: "not-an-object", what };
  }

  for (const { type, mid } of TWO_SEGMENT_KINDS) {
    const re = new RegExp(
      `^\\/sap\\/bc\\/adt\\/functions\\/groups\\/([^/]+)\\/${mid}\\/([^/]+)\\/([^/]+)(?:\\/([^/]+))?$`,
      "i",
    );
    const m = re.exec(path);
    if (m) {
      return {
        kind: "sub-object",
        spec: BY_TYPE.get(type)!,
        name: dec(m[2]!),
        parent: dec(m[1]!),
        segment: decodeURIComponent(m[3]!).toLowerCase(),
        subName: m[4] ? dec(m[4]!) : undefined,
      };
    }
  }

  for (const spec of TYPES) {
    if (spec.parentPath) continue;
    const prefix = spec.path.replace("/{name}", "");
    const re = new RegExp(`^${escapeRe(prefix)}/([^/]+)/([^/]+)(?:/([^/]+))?$`, "i");
    const m = re.exec(path);
    if (!m) continue;
    return {
      kind: "sub-object",
      spec,
      name: dec(m[1]!),
      segment: decodeURIComponent(m[2]!).toLowerCase(),
      subName: m[3] ? dec(m[3]!) : undefined,
    };
  }

  return undefined;
}
