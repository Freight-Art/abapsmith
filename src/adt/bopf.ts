/**
 * BOPF (Business Object Processing Framework) design-time authoring — the ADT
 * wire client.
 *
 * Owns the read/create/write/activate/delete/search/check-references
 * primitives over `/sap/bc/adt/bopf/businessobjects`. Does not decide MCP
 * tool shape, run the safety gate, or journal — that's the tool layer's job.
 *
 * Three hazards shape most functions here (full incident history archived in
 * the git history):
 *  - **Non-atomic create:** a `POST` can answer 4xx/5xx and still have
 *    created the object server-side. `createBusinessObject` always re-checks
 *    by GET before trusting a thrown error.
 *  - **Activation lies:** `POST …/activation` always answers `200`, even on
 *    failure — the body must be parsed, and corroborated with a re-read.
 *  - **Accept header traps:** the BOPF collection 406s without the v4 media
 *    type; DDIC existence probes need literal `*\/*` or an existing object
 *    404s and looks deleted. Each probe below is commented with which Accept
 *    it uses and why.
 *
 * **Local-package-only refusal:** the non-atomic-create hazard was only ever
 * observed on transportable packages; whether it applies there too is
 * unresolved. Until it is, this module refuses to create/edit/delete a BOPF
 * BO whose package isn't local — checked before create (`SessionTransport.resolve`,
 * no lock exists yet) and after every lock (`transportFromLock`, before the
 * PUT/DELETE).
 *
 * **Byte-splice model:** this module never serialises a `BoModel` back to
 * XML itself — that's `bopf-xml.ts`'s job (`splice`/`spliceOut`/
 * `spliceInsertChild`), working on raw wire bytes just read. This module
 * hands callers those bytes (`readModel`, `putModel`'s `reread`) and parses
 * results into a `BoModel` via `parseModel`.
 */
import type { AbapConnection } from "./connection.js";
import type { LockInfo, StatefulSession } from "./session.js";
import { translateAdtError, adtExceptionInfo } from "./session.js";
import type { SessionTransport } from "./session-transport.js";
import { toAbapError } from "./session-transport.js";
import { transportFromLock, readCurrentSource, type ResolvedTarget } from "./write.js";
import { buildUri, specForType } from "./types.js";
import { withRelockRetry } from "./relock.js";
import {
  mapActivationMessages,
  mapInactiveObjects,
  isFailureSeverity,
  activateWithPreauditSet,
  releaseActivationEnqueues,
} from "./activate.js";
import type { ActivationTarget, InactiveObjectRef } from "./activate.js";
import { AbapError, isAbapError, describeUnknownError } from "./errors.js";
import type { AuthorizedTarget, MutatingOperation, SafetyCorr, SafetyGate } from "../safety.js";
import { parseModel, mintGuid } from "./bopf-xml.js";
import type {
  BoModel,
  BoNode,
  AdtObjectRef,
  ClassRefSite,
  RefSiteElement,
  RefVerdict,
  IntegrityFinding,
} from "./bopf-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The BOPF business-object collection. Every BO URI is `${BOPF_COLLECTION}/${lowercased-name}`. */
export const BOPF_COLLECTION = "/sap/bc/adt/bopf/businessobjects";

/**
 * The ONLY Accept/Content-Type BOPF's read/create/write endpoints accept —
 * generic `application/xml` 406s here. The `ap.` segment is easy to typo
 * (`sap.adt` vs `sap.ap.adt`) and offline tests won't catch it — see archive
 * (measured: full offline-green while every BOPF call 406/415'd live).
 */
export const BOPF_ACCEPT_V4 = "application/vnd.sap.ap.adt.bopf.businessobjects.v4+xml";

/**
 * The Accept header `StatefulSession.lock` must send for a BOPF `?_action=LOCK`.
 * Capital-R `Result` — NOT the session default's lowercase `result` used by
 * every other object type. Wrong case doesn't 406; it silently fails to
 * parse the lock response. Pass as `session.lock(uri, { accept: BOPF_LOCK_ACCEPT })`.
 */
export const BOPF_LOCK_ACCEPT = "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.Result";

/**
 * BOPF's own object type code, used in `SessionTrTarget.type` and safety-gate
 * calls elsewhere. Exported because `tools/bopf.ts` gates every BO mutation
 * on the same code and used to declare its own `BOBF_TYPE` copy of the
 * literal.
 */
export const BOPF_TYPE = "BOBF";

/**
 * `{name}` is sent lowercase in every BOPF URI — wire-verified, not merely a
 * convention. `encodeURIComponent` handles namespace-prefixed names
 * (e.g. `/BOBF/DEMO_SALES_ORDER`) the same way `ddic.ts`/`types.ts` do
 * elsewhere — a raw `/` would land as an extra path segment and 404 a BO
 * that genuinely exists. Bug found live 2026-08-08; see archive.
 */
export function bopfUri(name: string): string {
  return `${BOPF_COLLECTION}/${encodeURIComponent(name.toLowerCase())}`;
}

// ---------------------------------------------------------------------------
// Authorization wiring
// ---------------------------------------------------------------------------

/**
 * Runtime backstop for a compile-time gap: every mutating function requires a
 * live {@link AuthorizedTarget} (minted by `SafetyGate.authorize`/
 * `authorizeIntent`, `../safety.js`), but a token minted for one object could
 * still be threaded into a call mutating a different one (e.g. a copy-paste
 * bug in a loop). Called first, before touching the wire; fails closed
 * (`SAFETY_DENIED`) on any name/package mismatch.
 */
function assertAuthorizedMatches(
  authorized: AuthorizedTarget<MutatingOperation>,
  target: { name: string; packageName?: string },
  context: string,
): void {
  const authName = authorized.target.name.trim().toUpperCase();
  const actualName = target.name.trim().toUpperCase();
  if (authName !== actualName) {
    throw new AbapError(
      "SAFETY_DENIED",
      `Internal wiring error in ${context}: the AuthorizedTarget names "${authorized.target.name}", but the ` +
        `object about to be mutated is "${target.name}". An AuthorizedTarget minted for one object must never ` +
        "be threaded into a call that mutates a different one.",
      { authorizedName: authorized.target.name, actualName: target.name, context },
      "This indicates a bug in the caller — the AuthorizedTarget passed to this function does not match the " +
        "object it is about to mutate. Mint a fresh AuthorizedTarget for the actual target.",
    );
  }
  if (
    target.packageName !== undefined &&
    authorized.target.packageName !== undefined &&
    authorized.target.packageName.trim().toUpperCase() !== target.packageName.trim().toUpperCase()
  ) {
    throw new AbapError(
      "SAFETY_DENIED",
      `Internal wiring error in ${context}: the AuthorizedTarget was minted for package ` +
        `"${authorized.target.packageName}", but the object is about to be written to package ` +
        `"${target.packageName}".`,
      { authorizedPackage: authorized.target.packageName, actualPackage: target.packageName, context },
      "This indicates a bug in the caller — re-authorize against the actual target package before mutating.",
    );
  }
}

// ---------------------------------------------------------------------------
// Shared read primitive
// ---------------------------------------------------------------------------

export interface BopfModelRead {
  readonly xml: string;
  readonly model: BoModel;
  readonly etag?: string;
}

/**
 * `GET /sap/bc/adt/bopf/businessobjects/{name}` with the v4 Accept header
 * (anything else 406s). Returns raw bytes AND the parsed read-only view;
 * callers that mutate must splice the raw `xml`, never reserialise `model`
 * (see module header). Throws the translated ADT error on any non-2xx,
 * including 404 — callers needing an existence check (e.g.
 * `createBusinessObject`'s recovery path) catch and inspect rather than
 * pre-checking, since there is no cheaper existence probe than the GET itself.
 */
export async function readModel(conn: AbapConnection, bo: string): Promise<BopfModelRead> {
  const uri = bopfUri(bo);
  try {
    const resp = await conn.get(uri, { headers: { Accept: BOPF_ACCEPT_V4 } });
    const etag = firstHeader(resp.headers, "etag");
    return { xml: resp.body, model: parseModel(resp.body), ...(etag ? { etag } : {}) };
  } catch (e) {
    if (isAbapError(e)) throw e;
    throw translateAdtError(e, { operation: "read", uri, name: bo, type: BOPF_TYPE });
  }
}

/** Case-insensitive single-header lookup — `RawResponse.headers` is `Record<string, unknown>`, shape not guaranteed by casing. */
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
// Create (non-atomic create, pre-lock transport refusal)
// ---------------------------------------------------------------------------

export interface CreateBusinessObjectInput {
  readonly name: string;
  readonly packageName: string;
  readonly description?: string;
  /**
   * Name of the root node minted at create time. Defaults to `"ROOT"`.
   * Must always be sent explicitly on create — an omitted `bo:nodes` makes
   * the server auto-generate a root node with `bo:name=""`, which
   * permanently corrupts the generated constants interface and the BO can
   * never activate (measured live, unfixable after the fact — see archive).
   */
  readonly rootNodeName?: string;
}

/**
 * `POST /sap/bc/adt/bopf/businessobjects`, v4 Content-Type/Accept.
 *
 * **Local-package-only refusal, pre-lock enforcement.** A create has no lock
 * yet to interrogate, so transport-ness is resolved via
 * `SessionTransport.resolve()` against the intended target instead. Refuses
 * before sending anything on `outcome: "transport"` — and also when no
 * `SessionTransport` was wired in at all (fail closed; "didn't check" must
 * never look like "checked and fine").
 *
 * **Non-atomic create.** The POST can itself throw while having created the
 * object server-side (network blip, CTS hiccup, a 409 from a prior attempt
 * that actually landed). On any throw, before rethrowing, this re-GETs the
 * model; if that succeeds the object DOES exist and this returns it with
 * `recovered: true` instead of propagating the error. If the re-GET also
 * fails, the ORIGINAL create error is rethrown, not the GET's. Every return
 * path carries `rootNodeCheck`, so `recovered: true` can never read as a
 * silent success over a lost root node name.
 *
 * Returns the `corr` this call resolved so the caller's later `activate` gate
 * check judges the same transport question, instead of asking again blind
 * (closes only the write half; callers' activate asserts must still relay it).
 */
export async function createBusinessObject(
  conn: AbapConnection,
  transport: SessionTransport | undefined,
  input: CreateBusinessObjectInput,
  authorized: AuthorizedTarget<"write">,
): Promise<BopfModelRead & { recovered?: boolean; rootNodeCheck: RootNodeNameCheck; corr: SafetyCorr }> {
  assertAuthorizedMatches(authorized, { name: input.name, packageName: input.packageName }, "createBusinessObject");

  const uri = bopfUri(input.name);

  if (transport === undefined) {
    throw new AbapError(
      "UNSUPPORTED",
      `Cannot create BOPF business object ${input.name}: no transport manager is wired into this call.`,
      { name: input.name, packageName: input.packageName },
      "BOPF create refuses fail-open on transport-ness. Whether the non-atomic-create " +
        "hazard applies identically on transportable packages is unresolved, so this " +
        "module never lets a transportable create through to find out. Wire a " +
        "SessionTransport through, or create the object in a local ($TMP-style) package.",
    );
  }

  const resolution = await transport.resolve(
    conn,
    { uri, devclass: input.packageName, name: input.name, type: BOPF_TYPE },
    "I",
  );
  const denial = toAbapError(resolution);
  if (denial) throw denial;
  if (resolution.outcome === "transport") {
    throw new AbapError(
      "UNSUPPORTED",
      `Cannot create BOPF business object ${input.name}: package ${input.packageName} is transportable.`,
      { name: input.name, packageName: input.packageName, corrNr: resolution.corrNr },
      "The non-atomic-create hazard (a failed POST can still create the object) was " +
        "only ever observed on transportable packages, and whether it applies " +
        "identically here is unresolved. BOPF create/edit/delete " +
        "refuse every transportable package until that's resolved. Use a local " +
        "package instead.",
    );
  }

  // Past the throws above, `resolution.outcome` is necessarily "not-needed" —
  // CTS itself said no transport is involved, the same authority
  // `transportFromLock` gives `corrForMutation` in write.ts.
  const corr: SafetyCorr = { kind: "local" };

  const body = buildCreateBody(input);
  try {
    // 201 answers with a 0-byte body; nothing in it is consumed, since the
    // created model is always fetched fresh below.
    await conn.post(BOPF_COLLECTION, {
      headers: { "Content-Type": BOPF_ACCEPT_V4, Accept: BOPF_ACCEPT_V4 },
      body,
    });
  } catch (e) {
    // Non-atomic create: re-GET before trusting the error (see doc comment above).
    try {
      const recovered = await readModel(conn, input.name);
      return { ...recovered, recovered: true, rootNodeCheck: checkRootNodeName(input, recovered.model), corr };
    } catch {
      if (isAbapError(e)) throw e;
      throw translateAdtError(e, { operation: "write", uri, name: input.name, type: BOPF_TYPE });
    }
  }

  // Fetched fresh, not assumed — the server may fill in fields (generated
  // constants interface ref, defaults) this function can't predict.
  const read = await readModel(conn, input.name);
  return { ...read, rootNodeCheck: checkRootNodeName(input, read.model), corr };
}

/**
 * Same "no literal undefined/null on the wire" guard as `bopf-xml.ts`'s
 * `escapeAttrValue` — duplicated intentionally since `buildCreateBody` below
 * is the one place that hand-renders XML outside the splice engine.
 */
function xmlEscape(s: string, context?: string): string {
  if (s === "undefined" || s === "null") {
    throw new AbapError(
      "BAD_INPUT",
      `BOPF create body: refusing to write the literal string "${s}" as ${context ?? "an attribute value"} — ` +
        "this is almost always a caller-side bug (a JavaScript undefined/null value stringified before being " +
        "sent) rather than an intentional value.",
      { value: s, context },
      "Omit the field instead of sending the string \"undefined\"/\"null\".",
    );
  }
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Single source of truth for "what root name did this create ask for",
 * shared by `buildCreateBody` and `tools/bopf.ts`'s post-create verifier
 * so the two can never drift apart.
 */
export function effectiveRootNodeName(input: CreateBusinessObjectInput): string {
  return input.rootNodeName?.trim() || "ROOT";
}

/** Requested vs. actual root node name on a create. `actual: undefined` means the model carries no root node at all. */
export interface RootNodeNameCheck {
  readonly requested: string;
  readonly actual: string | undefined;
  readonly matches: boolean;
}

// A create that died mid-flight has been observed live to land with an
// auto-generated root node named "" instead of the requested one. Computed on
// every create return path so a clean create's name is confirmed, not assumed.
export function checkRootNodeName(input: CreateBusinessObjectInput, model: BoModel): RootNodeNameCheck {
  const requested = effectiveRootNodeName(input);
  const actual = model.nodes.find((n) => n.rootNode)?.name.trim();
  return {
    requested,
    actual,
    matches: actual !== undefined && actual !== "" && actual.toUpperCase() === requested.toUpperCase(),
  };
}

/**
 * Minimal `bo:businessObject` creation payload — name, package, optional
 * description, and an explicitly named root `bo:nodes` element (the
 * empty-name root-node fix, see `rootNodeName` above). Deliberately hand-
 * rendered rather than built via `bopf-xml.ts`'s splice engine, which
 * mutates an EXISTING document's bytes — there's nothing to splice into on
 * create. Anything else desired on the new BO is a `putModel` away.
 *
 * The root `bo:nodes` attribute set/order is copied verbatim from a
 * proven-minimum accepted create body captured live, not from
 * `bopf-xml.ts`'s `ATTR_ORDER["node"]` (that table targets mutating an
 * existing, non-root node).
 */
function buildCreateBody(input: CreateBusinessObjectInput): string {
  const desc = input.description
    ? ` adtcore:description="${xmlEscape(input.description, "adtcore:description")}"`
    : "";
  const rootName = effectiveRootNodeName(input);
  const nodeId = mintGuid("node");
  // Namespace `http://www.sap.com/bopf/bo/BusinessObject` is live-verified
  // correct (an earlier "wbobj" variant 400'd — see archive). `bo:nodes` must
  // be sent explicitly (see `rootNodeName` above). `bo:nodeID` is required by
  // the server but not preserved (it re-mints its own key) — the client GUID
  // only needs to be well-formed.
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<bo:businessObject xmlns:bo="http://www.sap.com/bopf/bo/BusinessObject" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:name="${xmlEscape(input.name.toUpperCase(), "adtcore:name")}" adtcore:type="${BOPF_TYPE}"${desc}>` +
    `<adtcore:packageRef adtcore:name="${xmlEscape(input.packageName.toUpperCase(), "adtcore:packageRef/@adtcore:name")}"/>` +
    `<bo:nodes bo:name="${xmlEscape(rootName, "bo:nodes/@bo:name")}" bo:nodeID="${nodeId}" bo:xmlName="${xmlEscape(rootName, "bo:nodes/@bo:xmlName")}" ` +
    `bo:objectModelGenerated="false" bo:authorizationCheck="false" bo:isExtensible="false" ` +
    `bo:isDependentObjectNode="false" bo:textNode="false" bo:createEnabled="true" ` +
    `bo:updateEnabled="true" bo:deleteEnabled="true" bo:rootNode="true" ` +
    `bo:objectModelObsolete="false"/>` +
    `</bo:businessObject>`
  );
}

// ---------------------------------------------------------------------------
// Write (relock/retry, post-lock transport refusal)
// ---------------------------------------------------------------------------

/**
 * Only SESSION_DEAD or a response-less transport failure may have landed —
 * re-read and fold the finding into `hint`; a plain refusal is unaffected.
 */
async function discloseFailedPut(conn: AbapConnection, bo: string, base: AbapError): Promise<AbapError> {
  let note: string;
  try {
    await readModel(conn, bo);
    note = "a re-read after the failed PUT still succeeds — inspect the current model before assuming nothing changed.";
  } catch (probeErr) {
    note = `a re-read after the failed PUT also failed: ${describeUnknownError(probeErr)}`;
  }
  const disclosure = `A failed PUT is not proof the model is unchanged — ${note}`;
  const disclosed = new AbapError(
    base.code,
    base.message,
    { ...base.details, postFailureProbe: note },
    base.hint ? `${base.hint} ${disclosure}` : disclosure,
  );
  disclosed.stack = base.stack;
  disclosed.cause = base.cause;
  return disclosed;
}

/**
 * Whole-model PUT built on `withRelockRetry` (`./relock.js`, see its header
 * for the re-lock-after-failure rationale). Supplies four callbacks:
 *  - `reread`: re-GET raw bytes only (never the parsed `BoModel` — mutation
 *    splices bytes).
 *  - `rebuild`: hands the fresh bytes to the caller's `mutate` on every
 *    attempt including retries — never a cached pre-failure payload, since
 *    BOPF rewrites GUIDs/associations on every PUT.
 *  - `attempt`: the actual PUT. The post-lock transport check lives HERE
 *    (not before `withRelockRetry`) since it needs the fresh lock and must
 *    re-run on every retry's new lock.
 *
 * `mutate` returns the bytes to PUT, typically built with `bopf-xml.ts`'s
 * `splice`/`spliceOut`/`spliceInsertChild` helpers.
 */
export async function putModel(
  conn: AbapConnection,
  session: StatefulSession,
  bo: string,
  mutate: (xml: string) => string | Promise<string>,
  authorized: AuthorizedTarget<"write">,
): Promise<BopfModelRead & { corr: SafetyCorr }> {
  assertAuthorizedMatches(authorized, { name: bo }, "putModel");

  const uri = bopfUri(bo);

  const xml = await withRelockRetry<string>({
    session,
    uri,
    lockAccept: BOPF_LOCK_ACCEPT,
    reread: async (lock: LockInfo) => {
      void lock;
      const resp = await conn.get(uri, { headers: { Accept: BOPF_ACCEPT_V4 } });
      return resp.body;
    },
    rebuild: async (fresh: string) => await mutate(fresh),
    attempt: async (lock: LockInfo, payload: string) => {
      // Post-lock enforcement — checked fresh on every attempt since a retry
      // acquires a new lock (transportFromLock's contract in write.ts).
      const info = transportFromLock(lock);
      if (info.required) {
        try {
          await session.unlock(uri);
        } catch {
          // best-effort — mirrors relock.ts's own swallowed-unlock convention
        }
        throw new AbapError(
          "UNSUPPORTED",
          `Cannot write BOPF business object ${bo}: it is pinned to transport ${info.corrNr}.`,
          { name: bo, corrNr: info.corrNr, corrUser: info.corrUser },
          "BOPF write refuses every transportable target " +
            "until the non-atomic-create risk is resolved for transportable " +
            "packages. Use a local package instead.",
        );
      }
      try {
        await conn.put(uri, {
          headers: { "Content-Type": BOPF_ACCEPT_V4, Accept: BOPF_ACCEPT_V4 },
          qs: { lockHandle: lock.handle },
          body: payload,
        });
      } catch (e) {
        const base = isAbapError(e) ? e : translateAdtError(e, { operation: "write", uri, name: bo, type: BOPF_TYPE });
        // No response at all (bare network/socket failure) reads the same as SESSION_DEAD here: neither rules out the PUT landing.
        const mayHaveLanded = base.code === "SESSION_DEAD" || (!isAbapError(e) && adtExceptionInfo(e) === undefined);
        throw mayHaveLanded ? await discloseFailedPut(conn, bo, base) : base;
      }
      return payload;
    },
  });

  void xml;
  // `attempt` only ever returns when `transportFromLock(lock).required` was
  // false — the `info.required` branch throws — so the target is local.
  const corr: SafetyCorr = { kind: "local" };
  // A 0-byte PUT response carries nothing useful — fresh GET is authoritative.
  return { ...(await readModel(conn, bo)), corr };
}

// ---------------------------------------------------------------------------
// Activate (200-on-failure, independent re-verification)
// ---------------------------------------------------------------------------

export interface ActivationOutcomeBopf {
  readonly activated: boolean;
  readonly messages: readonly unknown[];
  readonly version?: string;
  /** The preaudit reply's object set, set only when a second POST naming it was actually sent. */
  readonly preaudit?: readonly InactiveObjectRef[];
}

/**
 * `POST /sap/bc/adt/activation?method=activate&preauditRequested=true` for a
 * BOPF business object.
 *
 * Activation lies: it ALWAYS answers `200`, whether or not anything actually
 * activated. The reliable signal is (a) parsing the body for `[EAX]`-severity
 * messages (`activateObject`'s classification, `./activate.js`) plus (b) an
 * independent fresh-GET corroboration — `model.version === "active"` is a
 * state the server can't lie about the way a malformed/empty body can. (b)
 * is treated as the more trustworthy of the two.
 *
 * Phase one still goes through `conn.adt.activate` (the vendor STRING
 * overload). A phase-one reply carrying an `ioc:inactiveObjects` document is
 * followed by `activateWithPreauditSet` from `./activate.js` — the same
 * second POST `activateObject` sends — so a BO with inactive dependents is
 * no longer a dead end.
 * `mapActivationMessages`/`mapInactiveObjects`/`isFailureSeverity` (all from
 * `./activate.js`) are reused as-is since `conn.adt.activate`'s result shape
 * is the same regardless of object kind.
 */
export async function activateBusinessObject(
  conn: AbapConnection,
  bo: string,
): Promise<ActivationOutcomeBopf> {
  const uri = bopfUri(bo);
  const seed: ActivationTarget = { name: bo, uri, type: BOPF_TYPE };

  let bodyVerdict: { activated: boolean; messages: readonly unknown[] };
  let preaudit: InactiveObjectRef[] | undefined;
  try {
    let result = await conn.adt.activate(bo, uri, undefined, true);
    const phase2 = await activateWithPreauditSet(conn, [seed], result);
    if (phase2) {
      result = phase2.result;
      preaudit = phase2.preaudit;
    }
    const messages = mapActivationMessages(result);
    const inactive = mapInactiveObjects(result);
    const hasFailure = messages.some((m) => isFailureSeverity(m.severity));
    bodyVerdict = {
      activated: result.success !== false && !hasFailure && inactive.length === 0,
      messages: [...messages, ...inactive.map((i) => ({ inactiveDependent: i }))],
    };
  } catch (e) {
    if (isAbapError(e)) throw e;
    throw translateAdtError(e, { operation: "write", uri, name: bo, type: BOPF_TYPE });
  }

  // Corroborate independently — model.version is the trustworthy signal.
  let version: string | undefined;
  let corroborated: boolean;
  try {
    const fresh = await readModel(conn, bo);
    version = fresh.model.version;
    corroborated = version === "active";
  } catch {
    // Re-read failed: fall back to the body verdict rather than silently
    // reading as "not activated" or masking a real inactive state. A
    // phase-two reply gets no such benefit of the doubt — its empty 200 is
    // byte-identical to the no-op an incomplete set answers with, so
    // with the re-read gone there is nothing behind it.
    corroborated = preaudit === undefined;
  }

  const activated = bodyVerdict.activated && corroborated;
  // A phase-two POST that still didn't end activated leaves its SAP-side
  // worklist enqueue stranded — same cleanup activateObject runs.
  if (preaudit && !activated) await releaseActivationEnqueues(conn);

  return {
    activated,
    messages: bodyVerdict.messages,
    ...(version ? { version } : {}),
    ...(preaudit ? { preaudit } : {}),
  };
}

// ---------------------------------------------------------------------------
// Delete (DDIC cascade sweep, own fresh lock, transport refusal, Accept header)
// ---------------------------------------------------------------------------

export interface DeleteBusinessObjectResult {
  readonly boDeleted: boolean;
  readonly ddic: readonly {
    name: string;
    kind: string;
    uri: string;
    existed: boolean;
    /**
     * `true` only after a post-DELETE read-back of `uri` (the same literal
     * `Accept: *\/*` the existence probe above uses) confirms the object is
     * actually gone (404/not-found-like). `"unverified"` means the `DELETE`
     * call itself resolved without throwing, but either the read-back still
     * finds the object, or the read-back itself failed with something other
     * than "not found" — in both cases this is NOT proof the delete failed:
     * a `200` on that read-back can be a stale read, so
     * `deleted` only ever goes `false` when `conn.del` itself threw. Same
     * tri-state idiom as `deleted: boolean | "unverified"` on `deleteObject`
     * in `src/adt/write.ts` — extended here to the DDIC
     * cascade so `deleted: true` is never asserted purely from the DELETE
     * HTTP call resolving.
     */
    deleted: boolean | "unverified";
    reason?: string;
  }[];
  /**
   * DDIC objects the model referenced via `persistentStructureRef`/
   * `persistentTableRef` that this cascade deliberately never attempted to
   * delete — see {@link collectDdicCascadeCandidates}. Reported individually
   * by name, same as `ddic`, so a caller who asked for a cascade and got a
   * partial one can see exactly what was spared and why, never summarised
   * as a count alone.
   */
  readonly ddicSpared: readonly {
    name: string;
    kind: string;
    uri: string;
    reason: string;
  }[];
  /**
   * `false` means the cascade model walk never happened — either
   * `opts.cascadeDdic` was falsy, or it was true but `readModel` threw and
   * there was nothing to walk. In both cases `ddic`/`ddicSpared` are `[]`
   * because nothing was looked at, not because a look found nothing. `true`
   * means the walk happened and produced a `BoModel`, whatever it found — an
   * empty `ddic`/`ddicSpared` alongside `ddicEnumerated: true` means the walk
   * ran and genuinely found no DDIC objects to report.
   */
  readonly ddicEnumerated: boolean;
}

/**
 * Which `bo:nodes`/`bo:businessObject` ref element a {@link DdicCandidate}
 * was found on. Drives the generated/referenced split in
 * {@link collectDdicCascadeCandidates} — see that function's doc comment.
 */
export type DdicRefSite =
  | "persistentTableRef"
  | "combinedTableRef"
  | "persistentStructureRef"
  | "combinedStructureRef"
  | "constantsInterfaceRef";

/** One DDIC deletion candidate found while walking the model, before existence is even probed. */
export interface DdicCandidate {
  readonly name: string;
  readonly kind: string;
  readonly uri: string;
  /** The DDIC object's own ADT type code (e.g. `TABL/DT`, `TTYP/DA`), read off `AdtObjectRef.type` — used to individually gate-check this specific candidate before it is deleted. */
  readonly type: string;
  /** The ref element this candidate was read off — see {@link DdicRefSite}. */
  readonly refSite: DdicRefSite;
}

/**
 * Caller-visible reason text for a candidate this module spares from a
 * cascade delete — shared by `deleteBusinessObject`'s `ddicSpared` and any
 * dry-run preview, so both surfaces say the same thing about the same
 * candidate.
 */
export function ddicSparedReason(refSite: DdicRefSite): string {
  return `referenced via ${refSite} — the model does not record whether this BO generated it, so it is not deleted`;
}

/** A raw `conn.get`, not `readModel` — `readModel` pre-translates the error and defeats `isNotFoundLike`. */
async function discloseDeleteFailureProbe(conn: AbapConnection, bo: string, base: AbapError): Promise<AbapError> {
  let note: string;
  try {
    await conn.get(bopfUri(bo), { headers: { Accept: BOPF_ACCEPT_V4 } });
    note = "a re-read right after the failed DELETE still finds the object — the delete did not land.";
  } catch (probeErr) {
    note = isNotFoundLike(probeErr)
      ? "a re-read right after the failed DELETE no longer finds the object — the delete may have landed despite the failure; re-read before retrying."
      : `a re-read right after the failed DELETE could not be settled: ${describeUnknownError(probeErr)}`;
  }
  const disclosed = new AbapError(
    base.code,
    base.message,
    { ...base.details, postFailureProbe: note },
    base.hint ? `${base.hint} ${note}` : note,
  );
  disclosed.stack = base.stack;
  disclosed.cause = base.cause;
  return disclosed;
}

/**
 * Deletes a BOPF business object, and — if `opts.cascadeDdic` — sweeps up
 * the DDIC objects the BO's own delete does NOT remove (tables, structures,
 * the one auto-generated constants interface).
 *
 * **Own fresh lock, never reused** — a lock handle is single-use-per-
 * mutation-intent on this server; never hand it one a PUT already used.
 *
 * **Post-lock enforcement**, same as `putModel`: `transportFromLock` on the
 * just-acquired lock, refuse before the DELETE if required.
 *
 * **Cascade enumeration happens BEFORE the lock**, via a plain `readModel` —
 * candidates are read-only info the BO's own GET already exposes, split by
 * {@link collectDdicCascadeCandidates} into two sets handled very
 * differently:
 *  - **generated** — `combinedTableRef`/`combinedStructureRef` (this BO's
 *    own generated table type and structure — `combinedTableRef` is a DDIC
 *    table type, `/ddic/tabletypes/`, distinct from `persistentTableRef`'s
 *    `/ddic/tables/`, see {@link ddicGuessUri}) and
 *    `model.constantsInterfaceRef` (read off the model, never derived from
 *    the BO's own name). These are the ONLY candidates this
 *    function ever deletes.
 *  - **referenced** — `persistentStructureRef`/`persistentTableRef`. The
 *    model carries no field saying who created the object these name — it
 *    can be a pre-existing object an author pointed at (via `add_node`/
 *    `set_node_flags`), and in `/BOBF/*` demo BOs routinely is one shared
 *    across multiple BOs/nodes in a different package (live-observed: a `$TMP`
 *    throwaway BO's cascade listed a course fixture living in
 *    `ZTMD_COURSES` as a deletion candidate). But it can just as well be a
 *    table `create_bo` itself auto-assigned: fixture
 *    `test/fixtures/bopf/02-created-zbopf_prb1-root-only.v4.xml`, captured
 *    immediately after `create_bo` with no DDIC refs sent (see
 *    `buildCreateBody`), already carries a `persistentTableRef` to
 *    `ZBOPF_D_ROOT`. This function never deletes either kind — when the
 *    cascade actually ran, they are reported in `ddicSpared` instead, never
 *    silently dropped; when `opts.cascadeDdic` was never set, `ddicSpared`
 *    is empty because nothing was looked at, and `ddicEnumerated: false` on
 *    the result says so. The asymmetry between generated and
 *    referenced is deliberate: an orphaned table this BO did generate is
 *    recoverable by hand, and a wrongly deleted foreign structure is not —
 *    `abap_journal` cannot undo a delete of an object this server never
 *    wrote. Since the model can't distinguish the two cases, sparing both
 *    is the only safe default. A caller who really wants a spared object
 *    gone deletes it explicitly (e.g. `abap_write`); this function does not
 *    take a flag for that.
 *
 * **Every DDIC existence probe uses literal `Accept: *\/*`** — with
 * `application/xml`, a genuinely-existing DDIC object can answer `404`
 * instead of `406`, indistinguishable from "does not exist".
 *
 * **Batching.** DDIC deletions run in batches of ≤5 (`.slice(i, i+5)`),
 * sequentially within a batch — a large single-invocation batch was observed
 * live to silently delete nothing at all (empirical, not a documented SAP
 * limit; 5 is comfortably under the observed ceiling). See archive.
 *
 * Every DDIC deletion attempt is reported individually — `existed`/`deleted`/
 * `reason` per candidate, never summarised as an aggregate. Spared
 * candidates are reported the same way, individually, in `ddicSpared`.
 */
export async function deleteBusinessObject(
  conn: AbapConnection,
  session: StatefulSession,
  bo: string,
  authorized: AuthorizedTarget<"delete">,
  gate: SafetyGate,
  opts: { cascadeDdic?: boolean } = {},
): Promise<DeleteBusinessObjectResult> {
  assertAuthorizedMatches(authorized, { name: bo }, "deleteBusinessObject");

  // Cascade ceiling: a whole-operation decision made up front (direct
  // `gate.config` read, not `evaluate()` — see `SafetyConfig.allowCascadeDelete`
  // in src/safety.ts). Refuses the WHOLE delete rather than silently
  // downgrading to non-cascading — a caller who asked for cascadeDdic and
  // doesn't get it must not believe it happened anyway. Fails closed:
  // `undefined`/below-admin is treated as `false`, never "allowed".
  if (opts.cascadeDdic && !gate.config.allowCascadeDelete) {
    throw new AbapError(
      "SAFETY_DENIED",
      `Cannot delete BOPF business object ${bo} with cascade_ddic: cascading DDIC ` +
        "deletes require the admin-mode cascade-delete ceiling (ABAP_MODE=admin), " +
        "which this server does not currently grant. The business object itself was " +
        "NOT deleted either — a caller who asked for a cascading delete and silently " +
        "got a non-cascading one instead would be misled about what actually happened.",
      { name: bo },
      "SafetyConfig.allowCascadeDelete",
    );
  }

  const uri = bopfUri(bo);

  let candidates: DdicCandidate[] = [];
  let spared: DdicCandidate[] = [];
  let ddicEnumerated = false;
  if (opts.cascadeDdic) {
    let model: BoModel | undefined;
    try {
      model = (await readModel(conn, bo)).model;
    } catch {
      // Can't enumerate what can't be read — degrades to empty `ddic`/
      // `ddicSpared` arrays, not a hard failure of the whole operation.
      // `ddicEnumerated` stays false: this is a second way to end up with
      // empty arrays without ever having looked, same as the flag being
      // off — the failed read must not be reported as a clean sweep.
    }
    if (model) {
      const split = collectDdicCascadeCandidates(model);
      candidates = split.generated;
      spared = split.referenced;
      ddicEnumerated = true;
    }
  }

  // Own fresh lock — never a PUT's.
  const lock = await session.lock(uri, { accept: BOPF_LOCK_ACCEPT });
  const info = transportFromLock(lock);
  if (info.required) {
    try {
      await session.unlock(uri);
    } catch {
      // best-effort
    }
    throw new AbapError(
      "UNSUPPORTED",
      `Cannot delete BOPF business object ${bo}: it is pinned to transport ${info.corrNr}.`,
      { name: bo, corrNr: info.corrNr, corrUser: info.corrUser },
      "BOPF delete refuses every transportable target " +
        "until the non-atomic-create risk is resolved for transportable " +
        "packages.",
    );
  }

  let boDeleted = false;
  try {
    await conn.del(uri, { qs: { lockHandle: lock.handle } });
    boDeleted = true;
  } catch (e) {
    try {
      await session.unlock(uri);
    } catch {
      // best-effort
    }
    const base = isAbapError(e) ? e : translateAdtError(e, { operation: "delete", uri, name: bo, type: BOPF_TYPE });
    throw await discloseDeleteFailureProbe(conn, bo, base);
  }
  try {
    await session.unlock(uri);
  } catch {
    // best-effort — the BO delete itself already succeeded above.
  }

  const ddic: DeleteBusinessObjectResult["ddic"][number][] = [];
  // Dependency order: tables (incl. table types, via combinedTableRef) →
  // structures → constants interface.
  const ordered = [
    ...candidates.filter((c) => c.kind === "table"),
    ...candidates.filter((c) => c.kind === "structure"),
    ...candidates.filter((c) => c.kind === "constants-interface"),
  ];

  for (let i = 0; i < ordered.length; i += 5) {
    const batch = ordered.slice(i, i + 5);
    for (const cand of batch) {
      // Each candidate is authorized individually, right before its own
      // DELETE, via the live `gate` — the parent `authorized` token only
      // proves the top-level BO delete was checked, and candidates are only
      // known once the model is walked at runtime. The candidate's package
      // isn't tracked by the refs this module walks, so the parent BO's
      // package is reused for that field; `name`/`type` are always the
      // candidate's own.
      let candAuthorized: AuthorizedTarget<"delete">;
      try {
        candAuthorized = gate.authorize(
          "delete",
          { name: cand.name, packageName: authorized.target.packageName, type: cand.type },
          { phase: "final" },
        );
      } catch (e) {
        // A denied candidate doesn't abort the cascade (the parent BO is
        // already gone) — reported like any other per-candidate failure.
        ddic.push({
          name: cand.name,
          kind: cand.kind,
          uri: cand.uri,
          existed: false,
          deleted: false,
          reason: `safety gate denied: ${describeUnknownError(e)}`,
        });
        continue;
      }
      ddic.push(await deleteDdicCandidate(conn, session, cand, candAuthorized));
    }
  }

  const ddicSpared = spared.map((cand) => ({
    name: cand.name,
    kind: cand.kind,
    uri: cand.uri,
    reason: ddicSparedReason(cand.refSite),
  }));

  return { boDeleted, ddic, ddicSpared, ddicEnumerated };
}

/**
 * Which ADT DDIC collection segment a candidate belongs under, when its
 * `uri` is absent and has to be guessed:
 *  - `persistentTableRef` (`TABL/DT`) → `/ddic/tables/`.
 *  - `combinedTableRef` (`TTYP/DA`, a table type — DIFFERENT collection,
 *    guessing `/ddic/tables/` 404s on a real object) → `/ddic/tabletypes/`.
 *  - `persistentStructureRef`/`combinedStructureRef` (`TABL/DS`) → `/ddic/structures/`.
 * `undefined` = "do not guess" — used for `constantsInterfaceRef`, which
 * carries a `uri` from create time onward in practice, so a guess
 * is never exercised.
 */
type DdicUriGuessKind = "tables" | "tabletypes" | "structures" | undefined;

/**
 * Walks a `BoModel` and splits every DDIC ref it carries into two sets, by
 * which ref slot it arrived in — the only signal available offline for
 * "did this BO generate this object, or merely reference one an author
 * supplied" (see `deleteBusinessObject`'s doc comment for the full
 * rationale — the live capture that prompted the split):
 *
 *  - `generated`: `combinedTableRef`, `combinedStructureRef`,
 *    `model.constantsInterfaceRef`. Named after the BO in every capture
 *    seen so far and safe to cascade-delete.
 *  - `referenced`: `persistentTableRef`, `persistentStructureRef`. Can be
 *    author-supplied, or auto-assigned by `create_bo` itself (fixture
 *    `test/fixtures/bopf/02-created-zbopf_prb1-root-only.v4.xml` carries a
 *    `persistentTableRef` right after `create_bo`, with no DDIC refs ever
 *    sent) — the model records no provenance either way. Sometimes shared
 *    across nodes or BOs, sometimes in a different package entirely — never
 *    cascade-deleted regardless.
 *
 * The single source of truth for the URI-guessing rule ({@link ddicGuessUri})
 * lives here — callers that only need a preview (no existence probe, no
 * delete) should call this directly rather than re-deriving the same rule.
 */
export function collectDdicCascadeCandidates(model: BoModel): {
  generated: DdicCandidate[];
  referenced: DdicCandidate[];
} {
  const generated: DdicCandidate[] = [];
  const referenced: DdicCandidate[] = [];
  for (const node of model.nodes) {
    pushCandidate(referenced, node.persistentTableRef, "table", "tables", "persistentTableRef");
    pushCandidate(generated, node.combinedTableRef, "table", "tabletypes", "combinedTableRef");
    pushCandidate(referenced, node.persistentStructureRef, "structure", "structures", "persistentStructureRef");
    pushCandidate(generated, node.combinedStructureRef, "structure", "structures", "combinedStructureRef");
  }
  pushCandidate(generated, model.constantsInterfaceRef, "constants-interface", undefined, "constantsInterfaceRef");
  return { generated, referenced };
}

function pushCandidate(
  out: DdicCandidate[],
  ref: AdtObjectRef | undefined,
  kind: string,
  guessKind: DdicUriGuessKind,
  refSite: DdicRefSite,
): void {
  if (!ref || !ref.name) return;
  const uri = ref.uri ?? ddicGuessUri(ref, guessKind);
  if (!uri) return;
  if (out.some((c) => c.uri === uri)) return; // de-dupe — several nodes can share a table/structure ref
  out.push({ name: ref.name, kind, uri, type: ref.type, refSite });
}

/**
 * Best-effort URI construction for a DDIC ref that arrived with only
 * `type`+`name` (no `uri` — normal for `combinedStructureRef`/
 * `combinedTableRef`/`persistentTableRef` pre-activation, per
 * `bopf-types.ts`'s own doc comment on `AdtObjectRef.uri`). See
 * {@link DdicUriGuessKind} for which collection each candidate maps to.
 */
function ddicGuessUri(ref: AdtObjectRef, guessKind: DdicUriGuessKind): string | undefined {
  if (!ref.name || !guessKind) return undefined;
  return `/sap/bc/adt/ddic/${guessKind}/${ref.name.toLowerCase()}`;
}

/**
 * Existence-probe (literal `Accept: *\/*`), and if confirmed present,
 * delete under its OWN fresh lock (plain DDIC lock path — no accept
 * override; only BOPF's lock endpoint needs the capital-R override).
 */
async function deleteDdicCandidate(
  conn: AbapConnection,
  session: StatefulSession,
  cand: DdicCandidate,
  authorized: AuthorizedTarget<"delete">,
): Promise<{ name: string; kind: string; uri: string; existed: boolean; deleted: boolean | "unverified"; reason?: string }> {
  assertAuthorizedMatches(authorized, { name: cand.name }, "deleteDdicCandidate");

  let existed: boolean;
  try {
    await conn.get(cand.uri, { headers: { Accept: "*/*" } });
    existed = true;
  } catch (e) {
    existed = false;
    if (!isNotFoundLike(e)) {
      return {
        name: cand.name,
        kind: cand.kind,
        uri: cand.uri,
        existed: false,
        deleted: false,
        reason: `existence probe failed: ${describeUnknownError(e)}`,
      };
    }
  }
  if (!existed) {
    return { name: cand.name, kind: cand.kind, uri: cand.uri, existed: false, deleted: false };
  }

  let lock: LockInfo;
  try {
    lock = await session.lock(cand.uri);
  } catch (e) {
    return {
      name: cand.name,
      kind: cand.kind,
      uri: cand.uri,
      existed: true,
      deleted: false,
      reason: `lock failed: ${describeUnknownError(e)}`,
    };
  }
  try {
    await conn.del(cand.uri, { qs: { lockHandle: lock.handle } });
  } catch (e) {
    const deleteFailure = `delete failed: ${describeUnknownError(e)}`;
    // DELETE throwing isn't proof it didn't land — re-probe like the success path below, same tri-state.
    try {
      await conn.get(cand.uri, { headers: { Accept: "*/*" } });
      return {
        name: cand.name,
        kind: cand.kind,
        uri: cand.uri,
        existed: true,
        deleted: false,
        reason: `${deleteFailure}; a read-back of the same URI still finds the object`,
      };
    } catch (probeErr) {
      if (isNotFoundLike(probeErr)) {
        return {
          name: cand.name,
          kind: cand.kind,
          uri: cand.uri,
          existed: true,
          deleted: true,
          reason: `${deleteFailure}, but a read-back of the same URI confirms the object is gone`,
        };
      }
      return {
        name: cand.name,
        kind: cand.kind,
        uri: cand.uri,
        existed: true,
        deleted: "unverified",
        reason: `${deleteFailure}; the read-back to confirm it also failed: ${describeUnknownError(probeErr)}`,
      };
    }
  } finally {
    try {
      await session.unlock(cand.uri);
    } catch {
      // best-effort
    }
  }

  // The DELETE call resolved without throwing, but that alone is not proof
  // the object is gone — read the same URI back, with the same
  // literal `Accept: */*` the existence probe above used, before calling
  // this `deleted: true`. Same tri-state discipline as `deleteObject` in
  // `src/adt/write.ts`.
  try {
    await conn.get(cand.uri, { headers: { Accept: "*/*" } });
    // Still readable. A 200 here is not by itself proof the delete failed —
    // it can be a stale read — so this is reported as
    // "unverified", never demoted to `false`.
    return {
      name: cand.name,
      kind: cand.kind,
      uri: cand.uri,
      existed: true,
      deleted: "unverified",
      reason:
        "DELETE returned success but a read-back of the same URI still finds the object; this is not proof " +
        "the delete failed (it can be a stale read)",
    };
  } catch (e) {
    if (isNotFoundLike(e)) {
      return { name: cand.name, kind: cand.kind, uri: cand.uri, existed: true, deleted: true };
    }
    return {
      name: cand.name,
      kind: cand.kind,
      uri: cand.uri,
      existed: true,
      deleted: "unverified",
      reason: `DELETE returned success but the read-back to confirm it failed: ${describeUnknownError(e)}`,
    };
  }
}

function isNotFoundLike(e: unknown): boolean {
  const err = e as { status?: number; err?: number; type?: string };
  const status = Number(err?.status ?? err?.err ?? 0);
  return status === 404 || /ResourceNotFound/i.test(String(err?.type ?? ""));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchBusinessObjectsInput {
  readonly objectType: string;
  readonly query?: string;
  readonly maxResults?: number;
}

/**
 * `GET /sap/bc/adt/bopf/businessobjects/$search?query=…&objectType=…&maxResults=…`.
 *
 * `objectType` is REQUIRED by the server (400 `ExceptionParameterNotFound`
 * without it) — refused locally here, no round trip needed.
 *
 * Result entries parse generically into `AdtObjectRef` (bopf-types.ts) rather
 * than a bespoke search-result type.
 *
 * Unlike the collection root/instance URIs, `$search` does NOT accept the v4
 * media type (406s) — its response is a generic `adtcore:objectReferences`
 * list, not a `bo:businessObject` document, so plain `application/xml` is
 * the correct Accept here, confirmed live on A4H.
 */
export async function searchBusinessObjects(
  conn: AbapConnection,
  input: SearchBusinessObjectsInput,
): Promise<readonly AdtObjectRef[]> {
  if (!input.objectType || !input.objectType.trim()) {
    throw new AbapError(
      "BAD_INPUT",
      "BOPF search requires object_type — the server answers 400 ExceptionParameterNotFound without it.",
      { query: input.query },
      'Pass an object_type, e.g. "BOBF".',
    );
  }

  const qs: Record<string, string> = { objectType: input.objectType };
  if (input.query !== undefined) qs.query = input.query;
  if (input.maxResults !== undefined) qs.maxResults = String(input.maxResults);

  let body: string;
  try {
    const resp = await conn.get(`${BOPF_COLLECTION}/$search`, { headers: { Accept: "application/xml" }, qs });
    body = resp.body;
  } catch (e) {
    if (isAbapError(e)) throw e;
    throw translateAdtError(e, { operation: "read", uri: `${BOPF_COLLECTION}/$search` });
  }

  return parseSearchResults(body);
}

/**
 * Minimal, dependency-free parse of the search result's `adtcore:*Reference`
 * entries into `AdtObjectRef[]`. Not routed through `bopf-xml.ts`'s
 * `parseModel` — that parses a `bo:businessObject` document, a different
 * top-level shape. Regex-based, matching this codebase's general avoidance
 * of a DOM dependency for small extraction jobs.
 */
function parseSearchResults(xml: string): AdtObjectRef[] {
  const out: AdtObjectRef[] = [];
  const re = /<[\w:]*[Oo]bjectReference\b[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const uri = attr(tag, "uri");
    const type = attr(tag, "type");
    const name = attr(tag, "name");
    if (name && type) {
      out.push({ ...(uri ? { uri } : {}), type, name });
    }
  }
  return out;
}

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`[\\w:]*:${name}="([^"]*)"`);
  const m = re.exec(tag);
  if (m && m[1] !== undefined) return xmlUnescape(m[1]);
  // Bare (unprefixed) attribute fallback.
  const re2 = new RegExp(`\\b${name}="([^"]*)"`);
  const m2 = re2.exec(tag);
  return m2 && m2[1] !== undefined ? xmlUnescape(m2[1]) : undefined;
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// checkReferences (dangling class/DDIC refs mitigation)
// ---------------------------------------------------------------------------

/**
 * BOPF's server accepts a determination/validation/action/query whose
 * implementation class does not exist, activates it cleanly, and it then
 * silently never fires at runtime. `checkReferences` is the client-side
 * mitigation — walks every ref site in a `BoModel` and reports what it
 * finds. Advisory only: never throws; caller decides what to do with a
 * `"missing"`/`"wrong-interface"` verdict.
 *
 * **Critical finding:** merely naming a class in BO XML mints a resolvable
 * ADT object URI even when the class was never created — a GET on the
 * class's *object* URI is NOT a valid existence test (can 200 for a class
 * with no source artifact). The correct test is `GET
 * /sap/bc/adt/oo/classes/{name}/source/main`, `Accept: text/plain`:
 * 404/empty ⇒ `"missing"`, 200 with `IMPLEMENTATION` ⇒ `"present"`, 200
 * without it ⇒ `"declaration-only"`.
 *
 * Reuses `readCurrentSource` (`./write.js`) via a synthetic `ResolvedTarget`
 * with `exists: true` forced (it short-circuits otherwise) rather than
 * hand-rolling the GET — see `evaluateClassRef` for the placeholder target.
 *
 * DDIC ref sites use the same shape but literal `Accept: *\/*` (same 404-vs-406
 * masking trap as `deleteBusinessObject`'s cascade). A DDIC ref site absent
 * from the model entirely is normal pre-activation state → `"pending"`, not
 * `"missing"`. `targetNodeRef` needs no HTTP call — it names a node in the
 * SAME model, checked by lookup in `model.nodes`.
 *
 * Any ref site that can't be checked (no `uri`/`name`, or unrecognised kind)
 * is reported as `"unchecked"`, never silently dropped.
 */
export interface CheckReferencesOptions {
  /** Cap on reference sites probed — see the loop below. Default {@link DEFAULT_CHECK_REFS_MAX_SITES}. */
  readonly maxSites?: number;
}

/** ARCH-09 P7: a large BO has no natural bound on reference-site count; this caps the serial round-trip cost. */
export const DEFAULT_CHECK_REFS_MAX_SITES = 25;

export async function checkReferences(
  conn: AbapConnection,
  model: BoModel,
  options?: CheckReferencesOptions,
): Promise<readonly IntegrityFinding[]> {
  const sites = collectRefSites(model);
  const maxSites = options?.maxSites ?? DEFAULT_CHECK_REFS_MAX_SITES;
  const capped = sites.length > maxSites ? sites.slice(0, maxSites) : sites;
  const findings: IntegrityFinding[] = [];

  // Deliberately serial, not bounded-concurrency: connection.ts's per-connection
  // session mutex already serialises every ADT request on this conn, so
  // concurrent calls here would just queue behind it.
  for (const site of capped) {
    findings.push(await evaluateSite(conn, model, site));
  }

  return findings;
}

/**
 * Required interface per owning-element role, substring-matched against
 * source (can't see inherited interfaces, so a mismatch is the WARNING-grade
 * `"wrong-interface"`, not a hard error). Keyed by owner kind since
 * `implementationClassRef`'s required interface depends on the owner
 * (association's has no framework-mandated interface).
 */
const IMPL_INTERFACE_BY_OWNER: Record<string, string> = {
  determination: "/BOBF/IF_FRW_DETERMINATION",
  validation: "/BOBF/IF_FRW_VALIDATION",
  action: "/BOBF/IF_FRW_ACTION",
  query: "/BOBF/IF_FRW_QUERY",
};

/** DDIC-kind ref elements — everything else with a `Ref` shape in `RefSiteElement` is `"class"`. */
const DDIC_ELEMENTS = new Set<RefSiteElement>([
  "persistentStructureRef",
  "combinedStructureRef",
  "combinedTableRef",
  "persistentTableRef",
  "parameterStructureRef",
  "dataTypeRef",
  "dataTableTypeRef",
]);

/** Exported so callers can report "checked N of M" against `checkReferences`'s `maxSites` cap — pure, no network. */
export function collectRefSites(model: BoModel): ClassRefSite[] {
  const sites: ClassRefSite[] = [];

  const push = (
    node: string,
    owner: ClassRefSite["owner"],
    member: string | undefined,
    element: RefSiteElement,
    ref: AdtObjectRef | undefined,
    requiredInterface?: string,
  ) => {
    if (!ref) return;
    sites.push({
      owner,
      node,
      ...(member !== undefined ? { member } : {}),
      element,
      kind: DDIC_ELEMENTS.has(element) ? "ddic" : "class",
      ref,
      ...(requiredInterface ? { requiredInterface } : {}),
    });
  };

  for (const node of model.nodes) {
    push(node.name, "node", undefined, "persistentStructureRef", node.persistentStructureRef);
    push(node.name, "node", undefined, "combinedStructureRef", node.combinedStructureRef);
    push(node.name, "node", undefined, "combinedTableRef", node.combinedTableRef);
    push(node.name, "node", undefined, "persistentTableRef", node.persistentTableRef);
    push(node.name, "node", undefined, "defaultingClassRef", node.defaultingClassRef);
    push(node.name, "node", undefined, "dataAccessClassRef", node.dataAccessClassRef);
    push(node.name, "node", undefined, "authorizationClassRef", node.authorizationClassRef);

    for (const a of node.associations) {
      push(node.name, "association", a.name, "targetNodeRef", a.targetNodeRef);
      push(node.name, "association", a.name, "parameterStructureRef", a.parameterStructureRef);
      // No framework-mandated interface on an association's implementationClassRef.
      push(node.name, "association", a.name, "implementationClassRef", a.implementationClassRef);
    }
    for (const act of node.actions) {
      push(node.name, "action", act.name, "parameterStructureRef", act.parameterStructureRef);
      push(node.name, "action", act.name, "implementationClassRef", act.implementationClassRef, IMP_ACTION);
    }
    for (const det of node.determinations) {
      push(node.name, "determination", det.name, "implementationClassRef", det.implementationClassRef, IMP_DETERMINATION);
    }
    for (const val of node.validations) {
      push(node.name, "validation", val.name, "implementationClassRef", val.implementationClassRef, IMP_VALIDATION);
    }
    for (const q of node.queries) {
      push(node.name, "query", q.name, "dataTypeRef", q.dataTypeRef);
      push(node.name, "query", q.name, "implementationClassRef", q.implementationClassRef, IMP_QUERY);
    }
    for (const ak of node.alternativeKeys) {
      push(node.name, "alternativeKey", ak.name, "dataTypeRef", ak.dataTypeRef);
      push(node.name, "alternativeKey", ak.name, "dataTableTypeRef", ak.dataTableTypeRef);
    }
  }

  return sites;
}

const IMP_DETERMINATION = IMPL_INTERFACE_BY_OWNER.determination;
const IMP_VALIDATION = IMPL_INTERFACE_BY_OWNER.validation;
const IMP_ACTION = IMPL_INTERFACE_BY_OWNER.action;
const IMP_QUERY = IMPL_INTERFACE_BY_OWNER.query;

async function evaluateSite(conn: AbapConnection, model: BoModel, site: ClassRefSite): Promise<IntegrityFinding> {
  try {
    if (site.element === "targetNodeRef") {
      return evaluateTargetNodeRef(model, site);
    }
    if (site.kind === "ddic") {
      return await evaluateDdicRef(conn, site);
    }
    return await evaluateClassRef(conn, site);
  } catch (e) {
    // checkReferences itself must NEVER throw — any unexpected failure
    // degrades to "unchecked" with the error recorded, not a propagated throw.
    return { site, verdict: "unchecked", detail: describeUnknownError(e) };
  }
}

function evaluateTargetNodeRef(model: BoModel, site: ClassRefSite): IntegrityFinding {
  const name = site.ref.name;
  if (!name) return { site, verdict: "unchecked", detail: "targetNodeRef has no name" };
  // Wire's targetNodeRef carries composite "<BO-NAME>~<NODE-NAME>" (confirmed
  // live, e.g. "ZBOPF_MC5~ITEM"), not the bare name model.nodes uses — strip
  // the prefix before comparing; also fall back to a bare-name match.
  const prefix = `${model.name}~`;
  const bareName = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  const found = model.nodes.some((n: BoNode) => n.name === bareName || n.name === name);
  return { site, verdict: found ? "present" : "missing" };
}

/** Literal `Accept: *\/*` — see `checkReferences`'s doc comment. */
async function evaluateDdicRef(conn: AbapConnection, site: ClassRefSite): Promise<IntegrityFinding> {
  const { ref, element } = site;
  const isPendingKind =
    element === "combinedStructureRef" || element === "combinedTableRef" || element === "persistentTableRef";

  const uri = ref.uri ?? (ref.name ? `/sap/bc/adt/ddic/tables/${ref.name.toLowerCase()}` : undefined);
  if (!uri) {
    // No uri and (checked below) presumably no name either — genuinely unchecked.
    if (!ref.name) return { site, verdict: "unchecked", detail: "ref has neither uri nor name" };
  }
  if (!uri) return { site, verdict: "unchecked", detail: "could not construct a probe uri" };

  try {
    await conn.get(uri, { headers: { Accept: "*/*" } });
    return { site, verdict: "present" };
  } catch (e) {
    if (isNotFoundLike(e)) {
      return { site, verdict: isPendingKind ? "pending" : "missing" };
    }
    return { site, verdict: "unchecked", detail: describeUnknownError(e) };
  }
}

/**
 * Class ref existence + implementation-presence via `readCurrentSource`
 * (`./write.js`), source based (not object-URI based — see `checkReferences`'s
 * doc comment on why an object-URI GET is not a valid existence test).
 */
async function evaluateClassRef(conn: AbapConnection, site: ClassRefSite): Promise<IntegrityFinding> {
  const className = site.ref.name;
  if (!className) return { site, verdict: "unchecked", detail: "ref has no name" };

  // Namespaced class names (`/BOBF/CL_LIB_A_LOCK`) must go through
  // `encodeURIComponent` (bug found live: a raw `/` 404s a real class,
  // producing a false "missing"). `buildUri`/`specForType` (types.ts, the
  // central type→URI registry) do this already, unlike this function's own
  // earlier hand-rolled version.
  const spec = specForType("CLAS/OC")!;
  const uri = buildUri(spec, className);
  // Synthetic ResolvedTarget, `exists: true` forced so `readCurrentSource`
  // attempts the GET (it short-circuits otherwise). Every other field is an
  // inert placeholder — only `exists`/`sourceUri` are read on this path.
  const target: ResolvedTarget = {
    spec,
    type: spec.type,
    name: className,
    uri,
    sourceUri: `${uri}/source/main`,
    packageName: "",
    description: "",
    exists: true,
    packageSource: "requested",
  };

  let source: string | undefined;
  try {
    source = await readCurrentSource(conn, target);
  } catch (e) {
    if (isAbapError(e) && e.code === "UNSUPPORTED") {
      // readCurrentSource's 404 mapping (write.ts:698-722) — the class does
      // not exist as a source artifact.
      return { site, verdict: "missing", detail: e.message };
    }
    return { site, verdict: "unchecked", detail: describeUnknownError(e) };
  }
  if (source === undefined) {
    return { site, verdict: "unchecked", detail: "readCurrentSource returned no source for a target marked exists" };
  }

  const verdict: RefVerdict = source.includes("IMPLEMENTATION") ? "present" : "declaration-only";
  if (verdict === "declaration-only") {
    return { site, verdict, detail: "class exists but has no IMPLEMENTATION section" };
  }
  if (site.requiredInterface && !source.includes(site.requiredInterface)) {
    return {
      site,
      verdict: "wrong-interface",
      detail: `source does not mention ${site.requiredInterface} (substring match only — cannot see inherited interfaces)`,
    };
  }
  return { site, verdict };
}
