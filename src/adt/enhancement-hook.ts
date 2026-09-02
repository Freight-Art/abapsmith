/**
 * Source-code plug-in (`ENHO/XHH`) CREATE: anchor discovery + create POST.
 *
 * Ground truth: fixtures 122/180 (discovery, PROG/P hosts), 215 (discovery,
 * CLAS/OC host — discovery generalises across host types), 128 (the only
 * live-captured `enhoxhh` create — 201, PROG/P host, form-based anchor), 140
 * (activation of fixture 128's object — a separate, later POST, not part of
 * the create response).
 *
 * `discoverHookAnchors` accepts any `HookHostRef` (proven for PROG/P and
 * CLAS/OC). `buildCreateHookBody` does NOT: fixture 128 is the only live
 * create sample, so it REFUSES any `host.type` other than `"PROG/P"` rather
 * than guess an unverified CLAS/OC body shape.
 *
 * `AnchorFullName` (mirrors `write.ts`'s `AuthorizedTarget` brand) is a SHAPE
 * guarantee only — it proves a string matches the anchor grammar, not that
 * the anchor exists on the server or was seen by this call chain.
 *
 * Activation reuses `./activate.ts` unchanged, as an OPTIONAL, separate step
 * (fixtures 128/140 are ~1 minute apart, not one atomic operation).
 *
 * Double gate: `createHookImplementation` requires explicit
 * `allowEnhancements`/`allowSourcePlugins` booleans (never read from
 * `process.env`) and refuses with `ENHANCEMENT_DISABLED` before any network
 * call — IN ADDITION to the unconditional `gate.assertIntent` call below,
 * which has no opinion on `allowSourcePlugins`. `src/tools/enh.ts` repeats
 * the same two-flag check as its own preflight — deliberate
 * belt-and-suspenders protecting any future caller of this module.
 *
 * Full original rationale for the above (incl. exactly what the
 * `AnchorFullName` brand does and does not prove):
 * the git history
 */
import { XMLParser } from "fast-xml-parser";
import type { AbapConnection } from "./connection.js";
import type { AuthorizedTarget, SafetyGate } from "../safety.js";
import { type AbapMode, explainDeniedCapabilities, type ModeGovernedCapability } from "../mode.js";
import { AbapError } from "./errors.js";
import { enhancementIntentFor, type EnhancedObjectRef } from "./write.js";
import { activateObject, type ActivationOutcome } from "./activate.js";
import { assertEnhIdentifier, assertAbapText } from "./enhancement-templates.js";
import { ENHOXHH_COLLECTION, ENHOXHH_ACCEPT, buildEnhancementUri } from "./enhancement.js";
import { ENH_CREATE_PACKAGE } from "./enhancement-bridge.js";
import { translateAdtError } from "./session.js";
import { isAbapError } from "./errors.js";

// ---------------------------------------------------------------------------
// AnchorFullName — branded type (see module header for what the brand does
// and does not prove)
// ---------------------------------------------------------------------------

declare const ANCHOR_VERIFIED: unique symbol;

/** An anchor `fullName` that passed {@link parseAnchorFullName}'s grammar check — a shape guarantee only, see module header. */
export type AnchorFullName = string & { readonly [ANCHOR_VERIFIED]: true };

/** Backslash-delimited `XX:VALUE` segments terminated by `\EI`; `=` is class-pool padding (e.g. `ZCL_MCP_BADI_RUN==============CP`). Derived from fixtures 122, 180, 215 — see archive. */
const ANCHOR_FULL_NAME_RE = /^(?:\\[A-Z]{2}:[A-Za-z0-9_=]+)+\\EI$/;

/** The only runtime validator that mints an {@link AnchorFullName} outside {@link discoverHookAnchors}'s own parsing. Throws `BAD_INPUT` on a grammar mismatch. */
export function parseAnchorFullName(raw: string): AnchorFullName {
  if (typeof raw !== "string" || !ANCHOR_FULL_NAME_RE.test(raw)) {
    throw new AbapError(
      "BAD_INPUT",
      `${JSON.stringify(raw)} is not a shape this codebase has evidence an enhancement anchor ` +
        "fullName ever takes (backslash-delimited TWO:VALUE segments, terminated by \\EI).",
      { raw },
      "Anchor names should come from discoverHookAnchors's own result, not be typed by hand.",
    );
  }
  return raw as AnchorFullName;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** The host object a hook implementation attaches to, caller-supplied — nothing here resolves it server-side. */
export interface HookHostRef {
  /** ADT type code, e.g. "PROG/P", "CLAS/OC". Only "PROG/P" is create-verified — see module header. */
  type: string;
  name: string;
  /** The host's own ADT object URI — discovery GETs `${uri}/enhancements/options`. */
  uri: string;
}

export interface HookAnchor {
  fullName: AnchorFullName;
  fullDescription: string;
  /** Observed values: "any", "static". Informational only, not substituted back into anything — not a closed enum. */
  mode: string;
}

// fast-xml-parser config matches enhancement-xml.ts / bopf-xml.ts (one private parser copy per module, this codebase's convention).
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

type XmlNode = Record<string, unknown>;

function xmany(value: unknown): XmlNode[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.filter((v): v is XmlNode => typeof v === "object" && v !== null);
  }
  if (typeof value === "object") return [value as XmlNode];
  return [];
}

function xattr(n: XmlNode | undefined, name: string): string | undefined {
  if (!n) return undefined;
  const v = n["@_" + name];
  if (v === undefined || v === null) return undefined;
  return String(v);
}

/** `enho:enhancementOption`'s own media type — distinct from `enhoxhh`'s (ENHOXHH_ACCEPT). */
const ENHANCEMENT_OPTIONS_ACCEPT = "application/vnd.sap.adt.enhancementoptions.v2+xml";

/**
 * `GET {host.uri}/enhancements/options` — the ONE function allowed to mint
 * an {@link AnchorFullName} from a raw server response. Verified against
 * fixtures 122, 180 (PROG/P), 215 (CLAS/OC).
 *
 * Attribute-name trap: the response uses `enhocore:full_name` (different NS
 * prefix from every other `enho:` attribute here) and `enho:fullDescription`
 * (camelCase); `removeNSPrefix: true` strips both to `full_name` /
 * `fullDescription`. Do not confuse these with the CREATE body's
 * `enho:full_name` / `enho:full_description` (underscore form, see
 * {@link buildCreateHookBody}) — same-looking names, different document.
 */
export async function discoverHookAnchors(conn: AbapConnection, host: HookHostRef): Promise<HookAnchor[]> {
  const uri = `${host.uri}/enhancements/options`;
  let body: string;
  let status: number;
  try {
    const resp = await conn.get(uri, { headers: { Accept: ENHANCEMENT_OPTIONS_ACCEPT } });
    body = resp.body;
    status = resp.status;
  } catch (e) {
    // Transport throws (not a response object) on non-2xx — same shape as enhancement.ts's readBadiImplementation.
    if (isAbapError(e)) throw e;
    throw translateAdtError(e, { operation: "read", uri, name: host.name, type: host.type });
  }
  if (status !== 200) {
    throw new AbapError(
      "ADT_ERROR",
      `Enhancement anchor discovery for ${host.name} answered ${status}, not 200.`,
      { host: host.name, status },
    );
  }
  let parsed: XmlNode;
  try {
    parsed = (xmlParser.parse(body) ?? {}) as XmlNode;
  } catch (e) {
    throw new AbapError(
      "BAD_INPUT",
      `Could not parse enhancement anchor options for ${host.name}: ${e instanceof Error ? e.message : String(e)}`,
      { host: host.name },
    );
  }
  const root = parsed["enhancementOption"] as XmlNode | undefined;
  const options = xmany(root?.["option"]);
  return options.map((o) => {
    const fullName = xattr(o, "full_name") ?? "";
    const fullDescription = xattr(o, "fullDescription") ?? "";
    const mode = xattr(o, "mode") ?? "";
    return { fullName: parseAnchorFullName(fullName), fullDescription, mode };
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** Private copy of the XML-attribute escape (`enhancement-xml.ts`'s is not exported; one-copy-per-module convention). */
function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Case-insensitive single-header lookup — copied rather than imported (see `enhancement-write.ts`'s own `firstHeader`). */
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

/** Only host type this codebase has a live create capture for — see module header. */
const HOOK_CREATE_SUPPORTED_HOST_TYPE = "PROG/P";

/** ABAP username field (SU01) is CHAR12. */
const ABAP_USERNAME_MAX = 12;

export interface CreateHookBodyParams {
  /** New ENHO/XHH object name. */
  name: string;
  /** New object's root adtcore:description (CHAR60). */
  description: string;
  /** The host object the hook attaches to. Only host.type === "PROG/P" is create-verified. */
  host: HookHostRef;
  /** The anchor to bind to — should come from discoverHookAnchors or parseAnchorFullName. */
  anchor: { fullName: AnchorFullName; fullDescription: string };
  /** adtcore:responsible. */
  responsible: string;
}

/**
 * Pure XML body builder — no network call, exported so tests can compare its
 * output against fixture 128's exact captured `requestBody` byte-for-byte.
 * Every substituted value is validated first (H50 discipline). Attributes
 * fixture 128 captured but this function does not parameterise (type,
 * masterLanguage, language, packageRef, toolType, adjustmentStatus,
 * program_id, element_usage, upgrade, automatic_transport, nextId, id,
 * spotname, overwrite, method, enhmode) are hardcoded exactly as captured —
 * there is exactly one create sample, nothing to parameterise them against.
 */
export function buildCreateHookBody(params: CreateHookBodyParams): string {
  if (params.host.type !== HOOK_CREATE_SUPPORTED_HOST_TYPE) {
    throw new AbapError(
      "UNSUPPORTED",
      `Hook implementation create against a "${params.host.type}" host is not verified on this codebase — ` +
        `only "${HOOK_CREATE_SUPPORTED_HOST_TYPE}" is (fixture 128, the only live enhoxhh create capture).`,
      { hostType: params.host.type },
      "Discovery (discoverHookAnchors) works against any host type, including CLAS/OC (fixture 215) — only " +
        "create is scoped this narrowly, because inventing an untested body shape for another host type would " +
        "be a guess, not a fact.",
    );
  }
  const name = assertEnhIdentifier(params.name, "name");
  const description = assertAbapText(params.description, "description", 60);
  const hostName = assertEnhIdentifier(params.host.name, "host.name");
  const hostUri = assertAbapText(params.host.uri, "host.uri", 200);
  const responsible = assertEnhIdentifier(params.responsible, "responsible", { maxLength: ABAP_USERNAME_MAX });
  // Re-validated here, not just trusted from the branded type — the brand proves shape at mint time, not at this call site.
  const anchorFullName = parseAnchorFullName(params.anchor.fullName);
  const anchorFullDescription = assertAbapText(params.anchor.fullDescription, "anchor.fullDescription", 200);

  const hostRef =
    `adtcore:uri="${escapeXmlAttr(hostUri)}" adtcore:type="${escapeXmlAttr(params.host.type)}" ` +
    `adtcore:name="${escapeXmlAttr(hostName)}"`;

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<enho:enhancement ` +
    `xmlns:enho="http://www.sap.com/adt/enhancements/enho" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `xmlns:abapsource="http://www.sap.com/adt/abapsource" ` +
    `xmlns:atom="http://www.w3.org/2005/Atom" ` +
    `adtcore:name="${escapeXmlAttr(name)}" ` +
    `adtcore:type="ENHO/XHH" ` +
    `adtcore:description="${escapeXmlAttr(description)}" ` +
    `adtcore:masterLanguage="EN" ` +
    `adtcore:language="EN" ` +
    `adtcore:responsible="${escapeXmlAttr(responsible)}">` +
    `<adtcore:packageRef adtcore:name="${ENH_CREATE_PACKAGE}"/>` +
    `<enho:contentCommon enho:toolType="HOOK_IMPL" enho:adjustmentStatus="manual-adjustment">` +
    `<enho:usages>` +
    `<enho:referencedObject enho:program_id="R3TR" enho:element_usage="REDO" enho:upgrade="false" enho:automatic_transport="false">` +
    `<enho:objectReference ${hostRef}/>` +
    `<enho:mainObjectReference ${hostRef}/>` +
    `</enho:referencedObject>` +
    `</enho:usages>` +
    `</enho:contentCommon>` +
    `<enho:contentSpecific>` +
    `<enho:hookTechnology enho:nextId="2">` +
    `<enho:enhancedObject ${hostRef}/>` +
    `<enho:hookImplementation enho:id="1" enho:spotname="" enho:programname="${escapeXmlAttr(hostName)}" ` +
    `enho:overwrite="" enho:method="" enho:enhmode="D" ` +
    `enho:full_name="${escapeXmlAttr(anchorFullName)}" enho:full_description="${escapeXmlAttr(anchorFullDescription)}"/>` +
    `</enho:hookTechnology>` +
    `</enho:contentSpecific>` +
    `</enho:enhancement>`
  );
}

export interface CreateHookParams extends CreateHookBodyParams {
  /** The object this hook affects/enhances, for SafetyGate's EnhancementIntent. */
  affects: EnhancedObjectRef;
  /** Also activate immediately after a successful create — a SEPARATE POST (fixture 140), never atomic with create. Defaults to false. */
  activate?: boolean;
  /** Double gate (module header): both REQUIRED, checked before any network call, in addition to `gate.assertIntent`. Never sourced from `process.env` — the caller (src/tools/enh.ts) passes these through from `Config`. */
  allowEnhancements: boolean;
  allowSourcePlugins: boolean;
  /** Which MECHANISM produced the two booleans above, so a refusal can name the actual deciding input. Not itself a capability. Unset ⇒ legacy per-flag config. */
  abapMode?: AbapMode;
}

export interface CreateHookResult {
  name: string;
  uri: string;
  etag?: string;
  location?: string;
  activation?: ActivationOutcome;
}

/**
 * The only way to reach the `conn.post` that creates the `ENHO/XHH` hook
 * implementation. Requiring `AuthorizedTarget<"write">` (mintable only by
 * `gate.authorizeIntent`) turns "forgot to gate this call" into a compile error.
 */
async function postHookImplementation(
  conn: AbapConnection,
  authorized: AuthorizedTarget<"write">,
  body: string,
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  try {
    return await conn.post(ENHOXHH_COLLECTION, {
      headers: { "Content-Type": ENHOXHH_ACCEPT, Accept: ENHOXHH_ACCEPT },
      body,
    });
  } catch (e) {
    // Transport throws (not a response object) on non-2xx — same shape as bopf.ts's createBusinessObject.
    if (isAbapError(e)) throw e;
    throw translateAdtError(e, {
      operation: "write",
      uri: ENHOXHH_COLLECTION,
      name: authorized.target.name,
      type: "ENHO/XHH",
    });
  }
}

/**
 * Creates a new `ENHO/XHH` source-code plug-in hook implementation and
 * optionally activates it. See the module header for the double gate, the
 * `AnchorFullName` brand's real limits, and why this is scoped to `PROG/P`
 * hosts only.
 */
export async function createHookImplementation(
  conn: AbapConnection,
  gate: SafetyGate,
  params: CreateHookParams,
): Promise<CreateHookResult> {
  if (params.allowEnhancements !== true || params.allowSourcePlugins !== true) {
    // Only the actually-missing capabilities are named — "needs BOTH X and Y" misled operators who had set one already.
    const missing: ModeGovernedCapability[] = [
      ...(params.allowEnhancements !== true ? (["allowEnhancements"] as const) : []),
      ...(params.allowSourcePlugins !== true ? (["allowSourcePlugins"] as const) : []),
    ];
    const why = explainDeniedCapabilities(missing, params.abapMode);
    throw new AbapError(
      "ENHANCEMENT_DISABLED",
      `Creating a source-code plug-in hook is disabled. ${why.cause}`,
      {
        allowEnhancements: params.allowEnhancements,
        allowSourcePlugins: params.allowSourcePlugins,
        ...(params.abapMode !== undefined ? { abapMode: params.abapMode } : {}),
      },
      why.remediation,
    );
  }

  const target = { name: params.name, type: "ENHO/XHH", packageName: ENH_CREATE_PACKAGE };
  const intent = enhancementIntentFor(target, params.affects);
  // Unconditional final check, mirrors enhancement-bridge.ts's create functions. `authorizeIntent` (not
  // `assertIntent`): the returned token is the only way to reach postHookImplementation's conn.post below.
  const authorized = gate.authorizeIntent("write", intent, target);
  if (params.activate) {
    gate.assertIntent(intent, { op: "activate" });
  }

  const body = buildCreateHookBody(params);

  const resp = await postHookImplementation(conn, authorized, body);

  if (resp.status !== 201) {
    throw new AbapError(
      "ADT_ERROR",
      `Enhancement hook create for ${params.name} answered ${resp.status}, not the 201 fixture 128 captured.`,
      { name: params.name, status: resp.status, body: resp.body },
    );
  }

  // Fixture 128's Location header came back lowercase even though the request's adtcore:name was uppercase, and
  // fixture 140's activation targeted that lowercase URI — building from a lowercased name matches proven server behavior.
  const lowerName = params.name.trim().toLowerCase();
  const uri = buildEnhancementUri(ENHOXHH_COLLECTION, lowerName);
  const upperName = params.name.trim().toUpperCase();
  const etag = firstHeader(resp.headers, "etag");
  const location = firstHeader(resp.headers, "location");

  let activation: ActivationOutcome | undefined;
  if (params.activate) {
    activation = await activateObject(conn, { name: upperName, uri });
  }

  return { name: upperName, uri, etag, location, activation };
}
