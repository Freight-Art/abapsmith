/**
 * OData service introspection: service binding → published service → EDMX
 * `$metadata` → compressed contract.
 *
 * BOUNDARY (parity item P-40): this module reads service contracts, never
 * business rows. It can only `GET` a path ending in `$metadata`, asserted
 * twice — {@link assertServiceRuntimePath} here and `SERVICE_METADATA_PATH`
 * in `connection.ts`, which doesn't trust this module to have checked. An
 * ADT session carries developer authority (`S_DEVELOP`/`S_ADT_RES`), not the
 * application's own OData authorization; reading rows through it would
 * silently borrow authority nobody granted for that. Full rationale:
 * the git history.
 *
 * The binding document (`/sap/bc/adt/businessservices/bindings/{name}`) has
 * no runtime URL — only an `atom:link` to an ADT catalogue endpoint, which
 * alone answers with the authoritative `serviceUrl` and `published` flag.
 * Hence binding → catalogue → `$metadata`, three requests; guessing the URL
 * from the binding name breaks for any renamed binding.
 *
 * The V2 path is LIVE-VERIFIED against this project's A4H appliance
 * (SAP_BASIS 754). The V4 path is INFERENCE only — this backend has no V4
 * binding type at all (see the `SRVB/SVB` entry in `capabilities.ts`) — and
 * is written from ADT URL conventions plus the OASIS CSDL spec, marked
 * wherever it appears. Not "V4 was tried and works".
 */

import { XMLParser } from "fast-xml-parser";
import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import { adtExceptionInfo } from "./session.js";
import { parseEdmx, type EdmxContract, type ODataVersion } from "./edmx.js";
import { MESSAGE_EXCERPT_MAX, PARSE_EXCERPT_MAX, truncateText } from "../truncate.js";

// -------------------------------------------------------------- constants ---

/** ADT service binding resource. LIVE-VERIFIED. */
const BINDING_BASE = "/sap/bc/adt/businessservices/bindings";

/** 406s on a generic `Accept: application/xml` — same trap as the `SRVB/SVB` media type pin in `capabilities.ts`. Sent verbatim. */
const BINDING_ACCEPT = "application/vnd.sap.adt.businessservices.servicebinding.v1+xml";

/** Catalogue-endpoint link relations. V2 is LIVE-VERIFIED; V4 is INFERRED and has never been observed on this backend (no V4 binding type). */
const LINK_REL_V2 = "http://www.sap.com/categories/odatav2";
const LINK_REL_V4 = "http://www.sap.com/categories/odatav4";

/** SRVB names are ≤30 chars; bound is 40 to allow a namespace prefix without becoming a free-text field. */
const BINDING_NAME_CHARS = /^[A-Z0-9_/$]{1,40}$/;

/** Mirrors `SERVICE_METADATA_PATH` in `connection.ts`. Kept in sync by hand, on purpose. */
const SERVICE_METADATA_PATH = /^\/sap\/opu\/odata4?\/[A-Za-z0-9_\-/]{1,240}\/\$metadata$/;

// ----------------------------------------------------------------- parsing ---

const REPEATABLE_NAMES: ReadonlySet<string> = new Set([
  "link",
  "content",
  "services",
  "collection",
  "navigation",
]);

const adtXml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name, _jpath, _isLeaf, isAttribute) => !isAttribute && REPEATABLE_NAMES.has(name),
});

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function list(node: unknown, name: string): Rec[] {
  if (!isRec(node)) return [];
  const v = node[name];
  if (Array.isArray(v)) return v.filter(isRec);
  return isRec(v) ? [v] : [];
}

function child(node: unknown, name: string): Rec | undefined {
  return list(node, name)[0];
}

function attr(node: unknown, name: string): string | undefined {
  if (!isRec(node)) return undefined;
  const v = node[`@_${name}`];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

/** Tri-state — unlike `abap-adt-api`'s `parseServiceBinding`, which coerces a MISSING attribute to `true`. Unstated must not be reported as published. */
function boolAttr(node: unknown, name: string): boolean | undefined {
  const raw = attr(node, name)?.toLowerCase();
  if (raw === "true" || raw === "x") return true;
  if (raw === "false" || raw === "") return false;
  return undefined;
}

// -------------------------------------------------------------- model ---

/** What the ADT binding document says. */
export interface ServiceBindingInfo {
  readonly name: string;
  /** `ODATA`. Other binding types exist on newer releases and are refused. */
  readonly bindingType?: string;
  /** `V2` / `V4` as the binding declares it. */
  readonly bindingVersion?: string;
  readonly category?: string;
  /** The binding's own published flag. Tri-state: `undefined` = unstated. */
  readonly published?: boolean;
  readonly serviceName?: string;
  readonly serviceVersion?: string;
  readonly srvdName?: string;
  readonly packageName?: string;
  /** Catalogue endpoint and the relation it was found under. */
  readonly catalogueUrl?: string;
  readonly catalogueRel?: string;
}

/** What the ADT catalogue lookup says. */
export interface ServiceRuntimeInfo {
  readonly serviceId?: string;
  readonly serviceVersion?: string;
  /** Runtime path only — the host is stripped and never surfaced. */
  readonly servicePath?: string;
  readonly published?: boolean;
  readonly collections: readonly string[];
}

/** Every fact that went into deciding the protocol version. */
export interface VersionResolution {
  readonly version: ODataVersion;
  /** `srvb:binding/@srvb:version`. */
  readonly fromBinding?: string;
  /** The catalogue link relation the binding exposed. */
  readonly fromLinkRel?: string;
  /** What the EDMX document itself said, and on what evidence. */
  readonly fromDocument: ODataVersion;
  readonly documentEvidence: string;
  /** Non-empty when the three signals did not agree. Reported, never silently resolved. */
  readonly disagreement?: string;
}

export interface ServiceContract {
  readonly binding: ServiceBindingInfo;
  readonly runtime: ServiceRuntimeInfo;
  readonly metadataPath: string;
  readonly version: VersionResolution;
  readonly contract: EdmxContract;
  /** The EDMX as fetched. Carried only when the caller asked for `raw`. */
  readonly raw?: string;
  /** True when the OData ICF node handed out a cookie that had to be discarded. */
  readonly cookieJarChanged: boolean;
}

// ------------------------------------------------------------- path guard ---

/**
 * One of two `$metadata`-only assertions (see module header). Refuses rather
 * than repairs — silently rewriting a wrong-shaped path would hide that
 * something upstream built the wrong request.
 */
export function assertServiceRuntimePath(path: string): void {
  if (SERVICE_METADATA_PATH.test(path)) return;
  throw new AbapError(
    "BAD_INPUT",
    `Refusing to build the service-runtime request '${path}': abapsmith fetches OData ` +
      `$metadata and nothing else.`,
    { path },
    "The path must be rooted at /sap/opu/odata or /sap/opu/odata4 and end in /$metadata. " +
      "Reading entity data through an ADT developer session is out of scope by design " +
      "(parity item P-40) and no setting enables it.",
  );
}

/** Strips the catalogue's absolute URL down to a path — the host must never reach a log, error, fixture or PR body, so it's discarded here rather than trusted to be filtered later. */
function pathOfServiceUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed === "") return undefined;
  if (trimmed.startsWith("/")) return trimmed.split(/[?#]/)[0];
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)$/i.exec(trimmed);
  const p = m?.[1];
  return p === undefined ? undefined : p.split(/[?#]/)[0];
}

/** `…/ZSRV` or `…/ZSRV/` → `…/ZSRV/$metadata`. */
function metadataPathOf(servicePath: string): string {
  return `${servicePath.replace(/\/+$/, "")}/$metadata`;
}

// ------------------------------------------------------ binding resolution ---

export function normaliseBindingName(raw: string): string {
  const name = raw.trim().toUpperCase();
  if (!BINDING_NAME_CHARS.test(name)) {
    throw new AbapError(
      "BAD_INPUT",
      `'${raw}' is not a service binding name.`,
      { name: raw },
      "Pass the SRVB object name (letters, digits, underscore, / and $; up to 40 " +
        "characters) — not a URL, not a service definition, not a CDS view.",
    );
  }
  return name;
}

/** Read and parse the ADT service binding document. */
export async function readServiceBinding(
  conn: AbapConnection,
  bindingName: string,
): Promise<ServiceBindingInfo> {
  const name = normaliseBindingName(bindingName);
  const url = `${BINDING_BASE}/${encodeURIComponent(name.toLowerCase())}`;

  let body: string;
  try {
    body = (await conn.get(url, { headers: { Accept: BINDING_ACCEPT } })).body;
  } catch (e) {
    const info = adtExceptionInfo(e);
    if (info?.status === 404) {
      throw new AbapError(
        "NOT_FOUND",
        `No service binding named ${name} exists in this system.`,
        { bindingName: name, status: 404 },
        "Check the spelling, then check the object type: a SERVICE DEFINITION (SRVD) is " +
          "not a service binding (SRVB) and has no OData URL of its own. `abap_search` " +
          "with the name will show which of the two exists.",
      );
    }
    throw e;
  }

  const doc = adtXml.parse(body);
  const sb = child(doc, "serviceBinding");
  if (!sb) {
    throw new AbapError(
      "SERVICE_METADATA_UNPARSEABLE",
      `The ADT response for service binding ${name} is not a service binding document.`,
      { bindingName: name, excerpt: truncateText(body, PARSE_EXCERPT_MAX) },
      "Do NOT retry. The excerpt above is what ADT returned; if it is an exception " +
        "envelope, its message names the real problem.",
    );
  }

  const services = child(sb, "services");
  const content = list(services, "content")[0];
  const binding = child(sb, "binding");

  let catalogueUrl: string | undefined;
  let catalogueRel: string | undefined;
  for (const l of list(sb, "link")) {
    const rel = attr(l, "rel");
    if (rel !== LINK_REL_V2 && rel !== LINK_REL_V4) continue;
    catalogueUrl = attr(l, "href");
    catalogueRel = rel;
    break;
  }

  return {
    name,
    ...opt("bindingType", attr(binding, "type")),
    ...opt("bindingVersion", attr(binding, "version")),
    ...opt("category", attr(binding, "category")),
    ...opt("published", boolAttr(sb, "published")),
    ...opt("serviceName", attr(services, "name")),
    ...opt("serviceVersion", attr(content, "version")),
    ...opt("srvdName", attr(child(content, "serviceDefinition"), "name")),
    ...opt("packageName", attr(child(sb, "packageRef"), "name")),
    ...opt("catalogueUrl", catalogueUrl),
    ...opt("catalogueRel", catalogueRel),
  };
}

function opt<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * The catalogue lookup — turns ingredients into a real URL. Still an ADT
 * request; only the `$metadata` fetch afterwards leaves the ADT namespace.
 */
export async function readServiceRuntimeInfo(
  conn: AbapConnection,
  binding: ServiceBindingInfo,
): Promise<ServiceRuntimeInfo> {
  const url = binding.catalogueUrl;
  if (url === undefined) {
    // Expected shape on an unpublished binding — let assertPublished's error win.
    assertPublished(binding, undefined);
    throw new AbapError(
      "UNSUPPORTED",
      `The service binding ${binding.name} exposes no OData catalogue link ` +
        `(rel ${LINK_REL_V2} or ${LINK_REL_V4}), so its runtime URL cannot be resolved.`,
      { bindingName: binding.name, bindingType: binding.bindingType },
      "This is the shape a NON-OData binding has — check the binding type (this one " +
        `reports '${binding.bindingType ?? "unstated"}'). Do not retry; the document will ` +
        "not grow a link.",
    );
  }

  const qs: Record<string, string> = {};
  if (binding.serviceName !== undefined) qs.servicename = binding.serviceName;
  if (binding.serviceVersion !== undefined) qs.serviceversion = binding.serviceVersion;
  if (binding.srvdName !== undefined) qs.srvdname = binding.srvdName;

  let body: string;
  try {
    // Requires the broad Accept below; 406s on a narrower one, same trap as the binding resource above.
    body = (await conn.get(pathOfServiceUrl(url) ?? url, { headers: { Accept: "application/*" }, qs }))
      .body;
  } catch (e) {
    const info = adtExceptionInfo(e);
    if (info?.status === 404) {
      throw new AbapError(
        "SERVICE_NOT_PUBLISHED",
        `The service binding ${binding.name} exists, but the OData catalogue has no ` +
          `registration for service ${binding.serviceName ?? binding.name} — it has not ` +
          `been published to the service runtime.`,
        { bindingName: binding.name, serviceName: binding.serviceName, status: 404 },
        PUBLISH_HINT,
      );
    }
    throw e;
  }

  const doc = adtXml.parse(body);
  const service = list(child(doc, "serviceList"), "services")[0];
  if (!service) {
    throw new AbapError(
      "SERVICE_NOT_PUBLISHED",
      `The OData catalogue returned no service for binding ${binding.name}, which is what ` +
        `an unpublished service binding looks like.`,
      { bindingName: binding.name, serviceName: binding.serviceName },
      PUBLISH_HINT,
    );
  }

  const information = child(service, "serviceInformation");
  const rawUrl = attr(service, "serviceUrl") ?? attr(information, "url");
  const collections: string[] = [];
  for (const c of list(information, "collection")) {
    const n = attr(c, "name");
    if (n) collections.push(n);
  }

  return {
    ...opt("serviceId", attr(service, "serviceId")),
    ...opt("serviceVersion", attr(service, "serviceVersion") ?? attr(information, "version")),
    ...opt("servicePath", rawUrl === undefined ? undefined : pathOfServiceUrl(rawUrl)),
    ...opt("published", boolAttr(service, "published")),
    collections,
  };
}

// An unpublished binding is the state an agent gets stuck in most
// often here, so this hint names the exact step and closes off the retry that
// won't help. Full history: the git history.
const PUBLISH_HINT =
  "Publish the service binding first: open it in ADT (or SAP GUI) and press 'Publish' — " +
  "or 'Activate' if the binding itself is inactive. abapsmith will NOT publish it: " +
  "publishing POSTs to /sap/bc/adt/businessservices/odatav2/publishjobs, which mutates the " +
  "system's runtime service surface, and this feature is read-only introspection by design. " +
  "Retrying this call before publishing will return the identical error.";

function assertPublished(binding: ServiceBindingInfo, runtime: ServiceRuntimeInfo | undefined): void {
  // Explicit `false` only — an unstated flag isn't evidence of anything.
  if (binding.published === false || runtime?.published === false) {
    throw new AbapError(
      "SERVICE_NOT_PUBLISHED",
      `Service binding ${binding.name} is not published, so its OData service does not ` +
        `exist in the service runtime yet and has no $metadata to read.`,
      {
        bindingName: binding.name,
        bindingPublished: binding.published,
        runtimePublished: runtime?.published,
      },
      PUBLISH_HINT,
    );
  }
}

// --------------------------------------------------------- version signals ---

/**
 * Reconciles three version signals: the binding's declared version, the
 * catalogue link relation, and the EDMX document's own self-description.
 * The document wins — it's the only signal describing the bytes actually
 * parsed; trusting a stale binding/link instead would silently drop V4-only
 * structure when read with the V2 parser. Disagreement is reported, not
 * resolved away — it usually means the ingredients resolved to the wrong service.
 */
function resolveVersion(binding: ServiceBindingInfo, contract: EdmxContract): VersionResolution {
  const fromBinding = binding.bindingVersion?.toUpperCase();
  const fromLinkRel = binding.catalogueRel;
  const linkSays: ODataVersion | undefined =
    fromLinkRel === LINK_REL_V2 ? "V2" : fromLinkRel === LINK_REL_V4 ? "V4" : undefined;
  const bindingSays: ODataVersion | undefined =
    fromBinding === "V2" ? "V2" : fromBinding === "V4" ? "V4" : undefined;

  const mismatches: string[] = [];
  if (bindingSays !== undefined && bindingSays !== contract.version) {
    mismatches.push(`the binding declares ${bindingSays}`);
  }
  if (linkSays !== undefined && linkSays !== contract.version) {
    mismatches.push(`the catalogue link relation says ${linkSays}`);
  }

  return {
    version: contract.version,
    ...opt("fromBinding", fromBinding),
    ...opt("fromLinkRel", fromLinkRel),
    fromDocument: contract.version,
    documentEvidence: contract.versionEvidence,
    ...opt(
      "disagreement",
      mismatches.length === 0
        ? undefined
        : `${mismatches.join(" and ")}, but the $metadata document itself is ` +
          `${contract.version} (evidence: ${contract.versionEvidence}). The document wins.`,
    ),
  };
}

// ------------------------------------------------------------ the fetch ---

/**
 * Fetch and parse `$metadata`, mapping every failure onto a code that says
 * something different from the others.
 */
async function fetchMetadata(
  conn: AbapConnection,
  metadataPath: string,
  binding: ServiceBindingInfo,
): Promise<{ body: string; cookieJarChanged: boolean }> {
  assertServiceRuntimePath(metadataPath);
  try {
    const resp = await conn.serviceRuntimeGet(metadataPath);
    return { body: resp.body, cookieJarChanged: resp.cookieJarChanged };
  } catch (e) {
    if (e instanceof AbapError) throw e;
    const info = adtExceptionInfo(e);
    const status = info?.status;
    const detail = {
      bindingName: binding.name,
      metadataPath,
      ...(status === undefined ? {} : { status }),
      ...(info?.message ? { serverMessage: truncateText(info.message, MESSAGE_EXCERPT_MAX) } : {}),
    };

    if (status === 401 || status === 403) {
      throw new AbapError(
        "SERVICE_METADATA_DENIED",
        `The OData service runtime refused $metadata for ${binding.name} with HTTP ` +
          `${status}. The ADT session is fine — this is the service's own gate.`,
        detail,
        "Two different causes look identical here, and re-running will not tell them " +
          "apart: (a) the user lacks S_SERVICE for this service — the ICF node checks it " +
          "independently of the developer authorizations that got the ADT session in; " +
          "(b) the SICF node under /sap/opu/odata is inactive, so ICF answers with a logon " +
          "challenge instead of the handler. Check SICF for the node and SU53 immediately " +
          "after this call for the authorization. Do NOT retry — neither cause is transient.",
      );
    }
    if (status === 404) {
      throw new AbapError(
        "SERVICE_METADATA_NOT_FOUND",
        `The OData service runtime has no service at ${metadataPath}, even though the ADT ` +
          `catalogue resolved binding ${binding.name} to it.`,
        detail,
        "This is NOT a spelling problem — the path came from the system's own catalogue. " +
          "It means the runtime registration is stale (published once, then the service " +
          "was removed or the binding renamed) or the ICF node was deleted. Re-publishing " +
          "the binding in ADT re-registers it. Retrying this call will not.",
      );
    }
    throw new AbapError(
      "ADT_ERROR",
      `Fetching $metadata for ${binding.name} failed${status === undefined ? "" : ` with HTTP ${status}`}` +
        `${info?.message ? `: ${truncateText(info.message, MESSAGE_EXCERPT_MAX)}` : ""}`,
      detail,
      "The request left the ADT namespace for the OData service runtime " +
        "(/sap/opu/odata*), which is a separate ICF hierarchy with its own activation " +
        "state and its own authorizations — so an ADT session that works everywhere else " +
        "proves nothing about it. Check the SICF node and the ICM trace for this path.",
    );
  }
}

/**
 * The whole chain: binding → catalogue → `$metadata` → compressed contract.
 * Three HTTP requests, all reads — deliberately not fanned out per entity
 * set (work-process budget on a constrained appliance).
 */
export async function readServiceContract(
  conn: AbapConnection,
  bindingName: string,
  opts: { includeRaw?: boolean } = {},
): Promise<ServiceContract> {
  // Fail-open gate (same pattern as atc.ts/atc/): only throws when discovery
  // loaded AND the collection is genuinely absent — a failed probe must never
  // be read as "too old".
  conn.discovery.assertSupported("rap.srvb", "OData service binding introspection");

  const binding = await readServiceBinding(conn, bindingName);

  if (binding.bindingType !== undefined && binding.bindingType.toUpperCase() !== "ODATA") {
    throw new AbapError(
      "UNSUPPORTED",
      `Service binding ${binding.name} is a ${binding.bindingType} binding, not an OData ` +
        `binding, so it has no $metadata document.`,
      { bindingName: binding.name, bindingType: binding.bindingType },
      "Only OData bindings expose EDMX. SQL and InA bindings describe themselves through " +
        "entirely different protocols that abapsmith does not read. Do not retry.",
    );
  }

  assertPublished(binding, undefined);
  const runtime = await readServiceRuntimeInfo(conn, binding);
  assertPublished(binding, runtime);

  const servicePath = runtime.servicePath;
  if (servicePath === undefined) {
    throw new AbapError(
      "SERVICE_NOT_PUBLISHED",
      `The OData catalogue returned an entry for binding ${binding.name} but no service ` +
        `URL, so there is nothing to fetch $metadata from.`,
      { bindingName: binding.name, serviceName: binding.serviceName },
      PUBLISH_HINT,
    );
  }

  const metadataPath = metadataPathOf(servicePath);
  const { body, cookieJarChanged } = await fetchMetadata(conn, metadataPath, binding);
  const contract = parseEdmx(body);

  return {
    binding,
    runtime,
    metadataPath,
    version: resolveVersion(binding, contract),
    contract,
    ...(opts.includeRaw === true ? { raw: body } : {}),
    cookieJarChanged,
  };
}
