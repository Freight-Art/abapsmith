/**
 * A shared fake ADT HTTP backend for the vitest suite.
 *
 * ## Why this file exists
 *
 * Several suites need MORE than "answer this one route with this one body"
 * (the `system-role-fake.ts` shape). They need a small model of an ADT
 * *server*: multiple concurrent sessions sharing one lock table, CSRF tokens
 * that differ per session, a long-poll debugger listener whose silent
 * zero-byte death is the single most SAP-specific and easiest-to-get-wrong
 * shape in this codebase, and a place to PARK a request mid-flight so a test
 * can assert what happened before it, then let it proceed. Hand-rolling that
 * per test file invites the exact kind of drift `system-role-fake.ts`'s
 * JSDoc warns about: three real defects traced back to fakes that were
 * "close enough" to the wire shape but not provably it.
 *
 * ## What is CONFIRMED LIVE vs still inferred
 *
 * Most of this file is now backed by real captured bytes from the A4H
 * appliance (captured 2026-08-02):
 *
 *  - LOCK success body ({@link lockSuccessXml}) and its
 *    `application/vnd.sap.as+xml; ...; dataname=com.sap.adt.lock.Result`
 *    content type.
 *  - UNLOCK: 200, zero-byte body, `content-length: "0"`, NO content-type
 *    ({@link EMPTY_200}) — **and the same 200 for a garbage handle**, which
 *    makes best-effort unlock safe and makes a 200 worthless as evidence of
 *    release.
 *  - Lock conflict 403 ({@link lockConflictXml}) — five object types,
 *    identical envelope. Session-affine, never user-affine. NOTE: the live
 *    body has no `<localizedMessage>` and no `LONGTEXT`; the older richer
 *    reconstruction is kept separately as
 *    {@link lockConflictXmlReconstructed}.
 *  - **Same-session re-LOCK is also a 403**, not idempotent, no re-issued
 *    handle — captured as status + type + message. That the
 *    `<properties>`/T100KEY block matches the cross-session envelope, and
 *    that the first handle survives, are UNCONFIRMED_ extrapolations; see
 *    {@link FakeAdtServer.routeLock} for exactly where the line falls.
 *  - 423 {@link invalidLockHandle423} and 400 {@link missingLockHandle400}
 *    for bad and absent lock handles. The 423 used to be carried as
 *    UNCONFIRMED on the guess it might not exist on this release; it does.
 *  - 409 {@link listenerConflict409} — `AdiFailed` / `conflictDetected` /
 *    `SY 530`. This was previously misfiled as a LOCK conflict. It is
 *    not one: it is the global-scope debug listener conflict, scoped to the
 *    USER.
 *  - 400 {@link sessionTimedOut400} — an ICM `text/html` page with
 *    `x-sap-icm-err-id: ICMENOSESSION`, not an `exc:exception`. Expiry
 *    releases the enqueue.
 *  - Long polls are **head-of-line blocking, never cancelled** — see
 *    {@link PendingPoll}.
 *  - CSRF failure ({@link CSRF_REQUIRED_403}): `403`,
 *    `content-type: text/plain; charset=utf-8`, response header
 *    `x-csrf-token: Required`, body exactly `CSRF token validation failed`.
 *
 * What remains inferred is now small and enumerated in
 * {@link UNCONFIRMED_SHAPES}: the `<properties>` lists of the 423 and 400
 * envelopes, the HTML body of the timeout page, and the assumption that
 * UNLOCK with a foreign session's handle behaves like UNLOCK with garbage.
 * Any response built from an inference carries the
 * {@link UNCONFIRMED_HEADER} response header so the fabrication is visible
 * at the assertion site.
 *
 * ## CSRF is minted, echoed, and NOT validated
 *
 * Each session gets its own token, and a request with `x-csrf-token: fetch`
 * gets it merged into that request's normal response. The fake never REJECTS
 * a token-less or wrong-token write. Do not write a test that expects it to.
 *
 * ## Non-goals (deliberately out of scope)
 *
 *  - Cross-PROCESS behaviour. This is an in-process simulation; two
 *    `FakeAdtServer.client()` handles sharing one `FakeAdtServer` instance
 *    is NOT the same claim as two real OS processes talking to one SAP
 *    instance, because module-level state that is genuinely per-process in
 *    reality (`lastMs`, `INSTALL_SALT`, `als`, ...) would be shared here in
 *    a way that could hide real bugs. A `child_process` harness would be
 *    needed for that and is out of scope for this file.
 *  - The debugger's `DebugRequestIssuer` / `DebugListenIssuer` interface.
 *    This fake models the raw HTTP shape of the listener long-poll only; the
 *    higher-level debugger session protocol belongs in its own helper.
 *  - CTS / transport-request semantics, ATC, or activation results beyond a
 *    bare 200. Not modelled at all.
 *  - Cookie parsing. Session attribution is by the `FakeAdtClient` handle
 *    returned from `server.client()`, never by reading `Cookie:` back out of
 *    request headers. Cookies ARE stamped onto every response (see
 *    {@link FakeAdtServer.client}) purely so a test can assert the absence
 *    of cross-session bleed in what a real client would see.
 *  - Wall-clock timing. No `setTimeout`, no `Date.now()`-dependent
 *    behaviour anywhere in this file — see {@link flushMicrotasks} and
 *    {@link settledOrPending}, modelled on the microtask-draining idiom in
 *    `test/session-lock.test.ts:350-358`. Head-of-line blocking is therefore
 *    an ORDERING guarantee that costs no wall-clock time: the real thing
 *    stalls for 55-115 seconds, the fake stalls until you release it.
 *  - Any claim about WHERE serialisation happens. The fake reproduces the
 *    observed ordering (a second request on a session does not complete
 *    until the outstanding one settles). It deliberately does not encode a
 *    server-side queue, because a client-side single-socket pin per
 *    `ADTClient` would produce identical timings with SAP never seeing the
 *    second request at all. The mechanism is unproven; the ordering is not.
 *
 * ## Hard constraints honoured throughout this file
 *
 * No `setTimeout`/`setInterval`, no `Date.now()`-dependent branching, no
 * `Math.random`, no `crypto.randomUUID`. {@link newLockHandle} is a
 * deterministic integer-only generator (a splitmix64-style mix over a
 * monotonic counter) precisely so two test runs never disagree.
 */
import { createHash } from "node:crypto";
import type {
  HeaderValue,
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
// A VALUE import: `transportErrors: "throw"` raises the real exception class the
// real transport raises. See {@link FakeAdtOptions.transportErrors}.
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";

// ---------------------------------------------------------------------------
// Async / ordering primitives
// ---------------------------------------------------------------------------

/** A promise plus its externally-callable resolve/reject, for hand-driven interleaving tests. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (v: T) => void;
  readonly reject: (e: unknown) => void;
}

/**
 * Build a {@link Deferred}. Same shape as the file-private helper duplicated
 * across `test/session-lock.test.ts` and friends, packaged here so this
 * fake's own gates/polls can use it and so tests driving this fake do not
 * need their own copy.
 */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Drain the microtask queue `ticks` times (default 200 — generous for
 * several chained `await`s). NO timers, NO wall clock: this only lets
 * already-scheduled `.then` callbacks run.
 */
export async function flushMicrotasks(ticks = 200): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

/** Sentinel returned by {@link settledOrPending} when the promise never settled within the poll budget. */
export const PENDING: unique symbol = Symbol("fake-adt:still-pending");

/**
 * Resolve `p` to its value, or to {@link PENDING} if it is still unsettled
 * after draining the microtask queue far beyond what a correct
 * implementation needs. Modelled on `test/session-lock.test.ts:350-358`.
 *
 * Handlers are attached to `p` SYNCHRONOUSLY, before any `await` runs, so a
 * promise that rejects is never briefly unhandled — this is the difference
 * between this helper and naively `await`-ing `p` with a timeout.
 */
export function settledOrPending<T>(p: Promise<T>): Promise<T | typeof PENDING> {
  type Outcome = { readonly kind: "value"; readonly value: T } | { readonly kind: "error"; readonly error: unknown };
  let outcome: Outcome | undefined;
  p.then(
    (value) => {
      outcome = { kind: "value", value };
    },
    (error: unknown) => {
      outcome = { kind: "error", error };
    },
  );
  return (async (): Promise<T | typeof PENDING> => {
    for (let i = 0; i < 200 && outcome === undefined; i++) {
      await Promise.resolve();
    }
    if (outcome === undefined) return PENDING;
    if (outcome.kind === "error") throw outcome.error;
    return outcome.value;
  })();
}

// ---------------------------------------------------------------------------
// Request record
// ---------------------------------------------------------------------------

/** One HTTP request as the fake saw it, recorded before routing decides what to do with it. */
export interface FakeRequest {
  /** Global monotonic counter across every {@link FakeAdtServer} in the process, starting at 1. */
  readonly seq: number;
  readonly sessionId: string;
  readonly user: string;
  /** Upper-cased; defaults to `"GET"` when `options.method` is absent. */
  readonly method: string;
  /** `options.url`, verbatim. */
  readonly url: string;
  /** `url` with any `scheme://host` and query string stripped. */
  readonly path: string;
  /** `options.qs`, merged with whatever query parameters were embedded in `url` itself. */
  readonly qs: Readonly<Record<string, unknown>>;
  /** Header names lower-cased; values as given. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  /** `"${method} ${path}"`, plus `?`-joined, alphabetically-sorted `qs` when non-empty. */
  readonly label: string;
  /** The owning session's `stateful` flag AT DISPATCH TIME (before this request's own header, if any, can flip it). */
  readonly stateful: boolean;
  /** The raw options this request was built from, as an escape hatch for custom routes. */
  readonly options: HttpClientOptions;
}

// ---------------------------------------------------------------------------
// Matchers / routes
// ---------------------------------------------------------------------------

/** A string matches by substring (against `label` OR `url`); a RegExp is `.test()`-ed against both; a function decides directly. */
export type RequestMatcher = string | RegExp | ((r: FakeRequest) => boolean);

/**
 * A pluggable route. Return `undefined` to say "not mine" and fall through
 * to the next custom route, then the builtins, then `catchAll`.
 */
export type FakeRoute = (
  r: FakeRequest,
  server: FakeAdtServer,
) => HttpClientResponse | undefined | Promise<HttpClientResponse | undefined>;

/** Test a {@link FakeRequest} against a {@link RequestMatcher}. */
export function matches(m: RequestMatcher, r: FakeRequest): boolean {
  if (typeof m === "string") return r.label.includes(m) || r.url.includes(m);
  if (m instanceof RegExp) return m.test(r.label) || m.test(r.url);
  return m(r);
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

const STATUS_TEXTS: Readonly<Record<number, string>> = {
  200: "OK",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  423: "Locked",
};

function statusTextFor(status: number): string {
  return STATUS_TEXTS[status] ?? "";
}

/** Build a bare {@link HttpClientResponse}. `headers` defaults to empty — no content-type is invented for you. */
export function fakeResponse(
  status: number,
  body = "",
  headers: Record<string, HeaderValue> = {},
): HttpClientResponse {
  return { status, statusText: statusTextFor(status), body, headers };
}

/**
 * The verified silent shape: `200`, zero-byte body, `content-length: "0"`,
 * and deliberately NO `content-type` header.
 *
 * Three unrelated causes produce it byte-identically, which is why it is one
 * function rather than three that could drift apart:
 *  - UNLOCK succeeded;
 *  - UNLOCK was handed a garbage handle and did nothing (live-confirmed:
 *    still `200`, still empty — the status tells you NOTHING about whether a
 *    lock was released);
 *  - a debugger long-poll ended, whether at its natural timeout or by DELETE.
 *
 * That third case is why head-of-line blocking was originally mistaken for
 * cancellation: a caller blocked behind a poll sees an empty 200 arrive and
 * infers something was killed. Nothing was.
 */
export const EMPTY_200 = (): HttpClientResponse => fakeResponse(200, "", { "content-length": "0" });

/** The exact single-line LOCK-success body shape, with `handle` substituted in. Verified capture shape. */
export function lockSuccessXml(handle: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">` +
    `<asx:values><DATA><LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL>` +
    `<IS_LINK_UP/><MODIFICATION_SUPPORT/><SCOPE_MESSAGES/></DATA></asx:values></asx:abap>`
  );
}

/** Content type SAP sends with a LOCK-success body (verified). */
const LOCK_RESULT_CONTENT_TYPE = "application/vnd.sap.as+xml; charset=utf-8; dataname=com.sap.adt.lock.Result";

/**
 * `GET {objectUri}` with `Accept: application/*` — the object-metadata document
 * that `resolveWriteTarget` (src/adt/write.ts) reads an object's REAL package
 * off.
 *
 * This is NOT a byte-for-byte capture; it is the minimal subset the production
 * parser reads, and it is the same subset the hand-rolled fakes in
 * `test/write.test.ts:132`, `test/undo.test.ts:100` and
 * `test/before-image-contract.test.ts:210` each reconstruct independently. It
 * lives here so those three (and the characterization suite that consumes it
 * first) stop drifting apart.
 *
 * The load-bearing part is `<adtcore:packageRef adtcore:name="…">`: an object
 * document without it makes EVERY write, delete and activation fail closed with
 * `SAFETY_DENIED` / `PACKAGE_UNKNOWN` rather than reach the behaviour under
 * test. That is a real failure mode — a fake that answers `200 <ok/>` here
 * produces a suite that only ever exercises the refusal path.
 */
export function objectMetadataXml(opts: {
  name: string;
  type: string;
  packageName?: string;
  description?: string;
  /** `adtcore:version` — `"active"` / `"inactive"`. Omitted entirely when absent, which reads as "unknown". */
  version?: string;
}): string {
  const { name, type, packageName = "$TMP", description, version } = opts;
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:name="${name}" adtcore:type="${type}"` +
    (description === undefined ? "" : ` adtcore:description="${description}"`) +
    (version === undefined ? "" : ` adtcore:version="${version}"`) +
    `>` +
    `<adtcore:packageRef adtcore:name="${packageName}"/>` +
    `</adtcore:objectMetadata>`
  );
}

/** One row of a `/repository/informationsystem/search` quickSearch result. */
export interface FakeObjectRef {
  readonly name: string;
  readonly type: string;
  readonly uri: string;
  readonly packageName?: string;
  readonly description?: string;
}

/**
 * `GET /sap/bc/adt/repository/informationsystem/search?operation=quickSearch` —
 * the `adtcore:objectReferences` envelope `resolveObject` and `abap_search`
 * both parse. Same reconstruction status as {@link objectMetadataXml}: the
 * subset the parser reads, not a capture.
 */
export function searchResultsXml(refs: readonly FakeObjectRef[]): string {
  const rows = refs
    .map(
      (r) =>
        `<adtcore:objectReference adtcore:uri="${r.uri}" adtcore:type="${r.type}" ` +
        `adtcore:name="${r.name}"` +
        (r.packageName === undefined ? "" : ` adtcore:packageName="${r.packageName}"`) +
        (r.description === undefined ? "" : ` adtcore:description="${r.description}"`) +
        `/>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">${rows}</adtcore:objectReferences>`
  );
}

/** The ~700-byte LONGTEXT blob embedded in the RECONSTRUCTED lock-conflict body, built exactly as `test/session.test.ts:65-67` builds it. */
const LOCK_CONFLICT_LONGTEXT_BLOB = `<HTML><HEAD></HEAD><BODY>${"An ENQUEUE lock is held; see transaction SM12. ".repeat(
  14,
)}</BODY></HTML>`;

/**
 * CONFIRMED LIVE. The 403 lock-conflict body exactly as the appliance emits
 * it, templated so the holding user and object name vary per call.
 *
 * Captured on FIVE object types — PROG, CLAS, TABL, DOMA, DTEL — with an
 * identical envelope; only `T100KEY-V2` (the object name) varies. The status,
 * `<type id>`, message text and all four `T100KEY` entries are byte-verified.
 *
 * NOTE the difference from {@link lockConflictXmlReconstructed}: the live body
 * has **no `<localizedMessage>` and no `LONGTEXT` property**. Earlier
 * reconstructions assumed both were present. If you are asserting on
 * LONGTEXT-stripping behaviour you want the reconstructed variant; if you are
 * asserting on what the wire actually carries, you want this one.
 *
 * `user` MUST be the user of the session that HOLDS the lock (it becomes both
 * the message text and `T100KEY-V1`); `objectName` is the last path segment of
 * the locked object, upper-cased (`T100KEY-V2`).
 */
export function lockConflictXml(opts: { user: string; objectName: string }): string {
  const { user, objectName } = opts;
  return `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceNoAccess"/>
  <message lang="EN">User ${user} is currently editing ${objectName}</message>
  <properties>
    <entry key="T100KEY-ID">EU</entry>
    <entry key="T100KEY-NO">510</entry>
    <entry key="T100KEY-V1">${user}</entry>
    <entry key="T100KEY-V2">${objectName}</entry>
  </properties>
</exc:exception>`;
}

/**
 * RECONSTRUCTED, **not** captured. The richer lock-conflict envelope that
 * predates the live run: it carries a `<localizedMessage>` and an escaped
 * ~700-byte `LONGTEXT` property. Byte-identical to `LOCK_CONFLICT_XML` in
 * `test/session.test.ts:64-82`.
 *
 * Retained deliberately so tests that exercise LONGTEXT stripping keep a
 * fixture to strip. It does NOT reflect what A4H sends — the live capture
 * (see {@link lockConflictXml}) has no LONGTEXT entry at all. Do not use this
 * to assert on-the-wire behaviour.
 */
export function lockConflictXmlReconstructed(opts: { user: string; objectName: string }): string {
  const { user, objectName } = opts;
  const longtext = LOCK_CONFLICT_LONGTEXT_BLOB.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceNoAccess"/>
  <message lang="EN">User ${user} is currently editing ${objectName}</message>
  <localizedMessage lang="EN">User ${user} is currently editing ${objectName}</localizedMessage>
  <properties>
    <entry key="LONGTEXT">${longtext}</entry>
    <entry key="T100KEY-ID">EU</entry>
    <entry key="T100KEY-NO">510</entry>
    <entry key="T100KEY-V1">${user}</entry>
    <entry key="T100KEY-V2">${objectName}</entry>
  </properties>
</exc:exception>`;
}

/** {@link lockConflictXml} wrapped as the full verified 403 response (`content-type: application/xml`). */
export function lockConflict403(opts: { user: string; objectName: string }): HttpClientResponse {
  return fakeResponse(403, lockConflictXml(opts), { "content-type": "application/xml" });
}

/** The verified CSRF-failure capture: `403`, `text/plain; charset=utf-8`, `x-csrf-token: Required`, exact 28-byte body. */
export const CSRF_REQUIRED_403 = (): HttpClientResponse =>
  fakeResponse(403, "CSRF token validation failed", {
    "content-type": "text/plain; charset=utf-8",
    "x-csrf-token": "Required",
  });

/**
 * Deterministic 40-uppercase-hex-char lock handle. NOT random: a
 * splitmix64-style integer mix over either `seed` or an internal monotonic
 * counter, so two test runs (or two calls with the same `seed`) always agree.
 */
let lockHandleCounter = 0;
const LOCK_HANDLE_GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;
const UINT64_MASK = 0xffffffffffffffffn;

export function newLockHandle(seed?: number): string {
  const n = seed ?? ++lockHandleCounter;
  if (!Number.isFinite(n)) {
    throw new TypeError(`newLockHandle: seed must be a finite number, got ${String(seed)}`);
  }
  let state = ((BigInt(Math.trunc(n)) + 1n) * LOCK_HANDLE_GOLDEN_GAMMA) & UINT64_MASK;
  let hex = "";
  while (hex.length < 40) {
    state = (state + LOCK_HANDLE_GOLDEN_GAMMA) & UINT64_MASK;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & UINT64_MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & UINT64_MASK;
    z = z ^ (z >> 31n);
    hex += z.toString(16).toUpperCase().padStart(16, "0");
  }
  return hex.slice(0, 40);
}

// ---------------------------------------------------------------------------
// Error shapes resolved by the live run
// ---------------------------------------------------------------------------

/** Header stamped on any response whose envelope detail is still inferred rather than captured. */
export const UNCONFIRMED_HEADER = "x-fake-adt-unconfirmed";

/** One entry in {@link UNCONFIRMED_SHAPES}: greppable metadata about a body whose envelope is still inferred. */
export interface UnconfirmedShape {
  readonly name: string;
  readonly status: number;
  readonly typeId: string;
  readonly why: string;
  response(opts?: { objectName?: string; user?: string; handle?: string }): HttpClientResponse;
}

/**
 * CONFIRMED LIVE. PUT with a lock handle the
 * server does not recognise — whether the object is unlocked or locked by
 * someone else — returns `423 ExceptionResourceInvalidLockHandle` with the
 * message `Resource INCLUDE <NAME> is not locked (invalid lock handle: <H>)`.
 * Captured twice, verbatim. This shape was previously carried under an
 * `UNCONFIRMED_` prefix on the guess that 423 might not exist on this release;
 * the live run REFUTED that guess — it exists.
 *
 * Still inferred: the `<properties>` list. The status, `<type id>` and message
 * text are byte-captured, but the surrounding envelope was not transcribed, so
 * the properties below are modelled on the confirmed `ExceptionResourceNoAccess`
 * envelope. Responses built here carry {@link UNCONFIRMED_HEADER} to keep that
 * fabrication visible at the assertion site.
 */
export function invalidLockHandle423(opts: { objectName: string; handle: string }): HttpClientResponse {
  const { objectName, handle } = opts;
  const message = `Resource INCLUDE ${objectName} is not locked (invalid lock handle: ${handle})`;
  return fakeResponse(
    423,
    `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceInvalidLockHandle"/>
  <message lang="EN">${message}</message>
  <properties>
    <entry key="T100KEY-V1">${objectName}</entry>
    <entry key="T100KEY-V2">${handle}</entry>
  </properties>
</exc:exception>`,
    {
      "content-type": "application/xml",
      [UNCONFIRMED_HEADER]: "423-envelope-properties",
    },
  );
}

/**
 * CONFIRMED LIVE. PUT carrying NO `lockHandle`
 * query parameter at all returns `400 ExceptionParameterNotFound` /
 * `Parameter lockHandle could not be found.` — a different status and type from
 * the bad-handle case above, so the two are distinguishable.
 *
 * Still inferred: the `<properties>` list, as for {@link invalidLockHandle423}.
 */
export function missingLockHandle400(): HttpClientResponse {
  return fakeResponse(
    400,
    `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionParameterNotFound"/>
  <message lang="EN">Parameter lockHandle could not be found.</message>
  <properties>
    <entry key="T100KEY-V1">lockHandle</entry>
  </properties>
</exc:exception>`,
    {
      "content-type": "application/xml",
      [UNCONFIRMED_HEADER]: "400-envelope-properties",
    },
  );
}

/**
 * CONFIRMED LIVE, 633 bytes, captured verbatim.
 *
 * This is the response the earlier design mistakenly filed as a *lock*
 * conflict 409. It is nothing of the kind: it is the **global-scope debug
 * listener** conflict, raised when a second listener is armed for a user that
 * already has one. `<type id="AdiFailed"/>`, subType `conflictDetected`,
 * `T100KEY SY 530`.
 *
 * Scope: a fresh `terminalId`/`ideId` pair does NOT evade it. The original
 * reading — "per user, full stop" — was refined by a later controlled 2×2 that
 * the first capture alone could not distinguish: exclusivity is keyed on the
 * `(user, terminalId, ideId)` triple. A second global-scope listener with a
 * DIFFERENT triple for the same user draws this 409 (what was originally
 * captured, and what our deterministic per-SID+user identity meets in
 * practice); the SAME triple is accepted and arms instead.
 * {@link FakeAdtOptions.listenerConflictScope} lets a test select either
 * shape. Terminal scope is not a third option worth reaching for — later
 * measurement showed terminal-scope listeners arm without conflict and still
 * never catch a debuggee.
 */
export function listenerConflict409(opts: { user: string }): HttpClientResponse {
  const { user } = opts;
  return fakeResponse(
    409,
    `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="AdiFailed"/>
  <message lang="EN">An exception was raised</message>
  <properties>
    <entry key="conflictText">Another session already exists with global debugging scope for user ${user}</entry>
    <entry key="ideUser">${user}</entry>
    <entry key="com.sap.adt.communicationFramework.subType">conflictDetected</entry>
    <entry key="T100KEY-ID">SY</entry>
    <entry key="T100KEY-NO">530</entry>
  </properties>
</exc:exception>`,
    { "content-type": "application/xml" },
  );
}

/**
 * CONFIRMED LIVE. Reusing a session the server has already timed out returns
 * `400 Session timed out` — and this is
 * **not** an ADT `exc:exception` at all. It is an ICM-level `text/html` error
 * page, so any classifier that only parses `<exc:exception>` XML will fail to
 * recognise it. The reliable signature is the header
 * `x-sap-icm-err-id: ICMENOSESSION`.
 *
 * The server also emits `sap-contextid=0` expiry cookies (the live capture
 * reported six; four path prefixes were transcribed and are reproduced here),
 * and `connection: close`.
 *
 * Evidence strength: the response SHAPE is strong (captured). The ~32-minute
 * threshold that produced it (`plugin_auto_logout` 1800 s + 120 s) rests on a
 * SINGLE trial and should be treated as weak. The exact HTML body text was not
 * transcribed, so the body below is shaped-but-fabricated and the response
 * carries {@link UNCONFIRMED_HEADER}.
 */
export function sessionTimedOut400(): HttpClientResponse {
  const res = fakeResponse(
    400,
    "<html><head><title>Application Server Error</title></head><body>" +
      "<h1>500 Session timed out</h1><p>Error: ICMENOSESSION</p></body></html>",
    {
      "content-type": "text/html",
      "x-sap-icm-err-id": "ICMENOSESSION",
      "sap-err-id": "ICMENOSESSION",
      connection: "close",
      [UNCONFIRMED_HEADER]: "400-timeout-html-body",
    },
  );
  (res.headers as Record<string, unknown>)["set-cookie"] = [
    "sap-contextid=0; expires=Thu, 01-Jan-1970 00:00:01 GMT",
    "sap-contextid=0; expires=Thu, 01-Jan-1970 00:00:01 GMT; path=/sap",
    "sap-contextid=0; expires=Thu, 01-Jan-1970 00:00:01 GMT; path=/sap/bc",
    "sap-contextid=0; expires=Thu, 01-Jan-1970 00:00:01 GMT; path=/sap/bc/adt",
  ];
  (res as { statusText?: string }).statusText = "Session timed out";
  return res;
}

/**
 * What this file still GUESSES, in one greppable place.
 *
 * It is deliberately short now. The live run
 * resolved the two entries that used to dominate it: the 409 turned out not to
 * be a lock conflict at all but a debug-listener conflict
 * ({@link listenerConflict409}), and the 423 that was assumed possibly-absent
 * turned out to exist ({@link invalidLockHandle423}). What remains are
 * envelope details and one behavioural inference.
 */
export const UNCONFIRMED_SHAPES: readonly UnconfirmedShape[] = [
  {
    name: "invalidLockHandle423 <properties>",
    status: 423,
    typeId: "ExceptionResourceInvalidLockHandle",
    why:
      "Status, <type id> and message text are byte-captured live. " +
      "The surrounding <properties> list was not transcribed, so it is modelled on the " +
      "confirmed ExceptionResourceNoAccess envelope. Assert on status/type/message, not on properties.",
    response: (o = {}) =>
      invalidLockHandle423({
        objectName: o.objectName ?? "UNKNOWN_OBJECT",
        handle: o.handle ?? "DEADBEEF".repeat(5),
      }),
  },
  {
    name: "missingLockHandle400 <properties>",
    status: 400,
    typeId: "ExceptionParameterNotFound",
    why:
      "Status, <type id> and message text are byte-captured live; " +
      "the <properties> list is inferred by analogy.",
    response: () => missingLockHandle400(),
  },
  {
    name: "sessionTimedOut400 HTML body",
    status: 400,
    typeId: "(none — ICM error page, not an exc:exception)",
    why:
      "Status line, x-sap-icm-err-id/sap-err-id, connection: close, content-type and the " +
      "sap-contextid=0 expiry cookies are captured. The HTML body text " +
      "was not transcribed; the body here is shaped but fabricated. Assert on headers, not body.",
    response: () => sessionTimedOut400(),
  },
  {
    name: "UNLOCK with another session's handle",
    status: 200,
    typeId: "(none — silent success)",
    why:
      "Live proved UNLOCK with a GARBAGE handle returns 200 with an empty body. " +
      "UNLOCK with a handle owned by a DIFFERENT live session was not probed separately; the fake " +
      "treats it identically to garbage. That equivalence is an inference, not a capture.",
    response: () => EMPTY_200(),
  },
];

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** One logical ADT session: its own contextid, CSRF token, stateful flag and lock set. */
export interface FakeSession {
  /** `"s1"`, `"s2"`, ... in creation order, per {@link FakeAdtServer}. */
  readonly id: string;
  readonly user: string;
  /** Distinct per session, e.g. `"SID:ANON:A4H:FAKE_CTX_0001"`. */
  readonly contextId: string;
  /** Distinct per session, deterministic. */
  readonly csrfToken: string;
  /** Sticky: set `true` the first time a request on this session carries `x-sap-adt-sessiontype: stateful`. */
  readonly stateful: boolean;
  readonly dropped: boolean;
  /** Object paths currently locked by this session. */
  readonly locks: readonly string[];
  readonly inFlight: number;
}

/** Mutable backing object for a {@link FakeSession}. Structurally satisfies the readonly interface; only this file mutates it. */
class SessionState implements FakeSession {
  readonly id: string;
  readonly user: string;
  readonly contextId: string;
  readonly csrfToken: string;
  stateful = false;
  dropped = false;
  /** Set by {@link FakeAdtServer.expire} — server-side timeout, distinct from a client-side `drop`. */
  expired = false;
  /**
   * Tail of this session's FIFO serialisation chain.
   *
   * Models the OBSERVED ordering guarantee — a second request on this session
   * does not complete until the outstanding one settles — without asserting
   * where that serialisation physically happens. Chained on promises, never
   * on timers, so the ordering is real but costs no wall-clock time.
   */
  queueTail: Promise<void> = Promise.resolve();

  private readonly locksInternal: string[] = [];
  private readonly inFlightSeqsInternal: number[] = [];

  constructor(id: string, user: string, contextId: string, csrfToken: string) {
    this.id = id;
    this.user = user;
    this.contextId = contextId;
    this.csrfToken = csrfToken;
  }

  get locks(): readonly string[] {
    return this.locksInternal;
  }

  get inFlight(): number {
    return this.inFlightSeqsInternal.length;
  }

  get lastInFlightSeq(): number | undefined {
    return this.inFlightSeqsInternal[this.inFlightSeqsInternal.length - 1];
  }

  addLock(path: string): void {
    if (!this.locksInternal.includes(path)) this.locksInternal.push(path);
  }

  removeLock(path: string): void {
    const i = this.locksInternal.indexOf(path);
    if (i >= 0) this.locksInternal.splice(i, 1);
  }

  clearLocks(): void {
    this.locksInternal.length = 0;
  }

  pushInFlight(seq: number): void {
    this.inFlightSeqsInternal.push(seq);
  }

  popInFlight(seq: number): void {
    const i = this.inFlightSeqsInternal.indexOf(seq);
    if (i >= 0) this.inFlightSeqsInternal.splice(i, 1);
  }
}

// ---------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------

/**
 * What kind of modelled-SAP-behaviour-or-worse invariant break was observed.
 *
 * `concurrent-stateful-request` — two requests overlapped on ONE stateful
 * session. Live evidence shows this is not rejected: the second request
 * simply does not complete until the first
 * settles. Measured in seconds or minutes, so it is a severe pool bug even
 * though nothing on the wire says "error". The fake reproduces the blocking
 * AND records this violation so the bug is visible. Strictly per-session: two
 * different sessions overlapping is normal and correct, and never records
 * anything.
 *
 * `unlock-garbage-handle-accepted` — the fake's own tripwire, not a wire
 * behaviour. Live proved UNLOCK with an unknown handle returns 200 with an
 * empty body, so code that infers "the lock was released" from a 200 is
 * unsound. The fake returns the faithful 200 and records this so a test can
 * catch the unsound inference.
 *
 * `long-poll-preempted` is deliberately ABSENT. It existed while the model
 * held that a same-session request cancels an in-flight listener. Live refuted
 * that 3/3 trials: the listener is never cancelled, it always runs to its
 * natural timeout.
 */
export type ViolationKind =
  | "concurrent-stateful-request"
  | "cross-session-lock-handle"
  | "unknown-lock-handle"
  | "unlock-garbage-handle-accepted"
  | "dropped-session-request"
  | "expired-session-request"
  | "unrouted-request";

/** One recorded invariant break. */
export interface FakeViolation {
  readonly kind: ViolationKind;
  readonly sessionId: string;
  readonly detail: string;
  readonly request: FakeRequest;
  readonly conflictingSeq?: number;
}

/**
 * Thrown for transport-level failures the fake itself raises: an unrouted
 * request, or a request on a session that is gone.
 *
 * A distinct class matters. `HttpClient.request` is contractually expected to
 * throw only ADT-shaped errors, so a bare `Error` escaping the fake can be
 * laundered by `translateAdtError` into a plausible-looking `ADT_ERROR` — and
 * then a test passes on a rejection nobody engineered. Assert on this type
 * (and use {@link FakeAdtServer.assertNoViolations} as the backstop) rather
 * than on "it rejected".
 */
export class FakeAdtProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FakeAdtProtocolError";
  }
}

/** Thrown by {@link FakeAdtServer.assertNoViolations} (naming the first violation) and, when configured, at the point a violation happens. */
export class FakeAdtViolation extends Error {
  readonly violation: FakeViolation;

  constructor(violation: FakeViolation) {
    super(`[${violation.kind}] session '${violation.sessionId}': ${violation.detail}`);
    this.name = "FakeAdtViolation";
    this.violation = violation;
  }
}

// ---------------------------------------------------------------------------
// Gates — the interleaving primitive
// ---------------------------------------------------------------------------

/**
 * A parked request, plus the three ways to let it go: continue to normal
 * routing, answer it directly, or make it reject.
 */
export interface Gate {
  readonly matcher: RequestMatcher;
  readonly held: FakeRequest | undefined;
  readonly arrived: Promise<FakeRequest>;
  release(): void;
  releaseWith(res: HttpClientResponse): void;
  releaseError(err: unknown): void;
  readonly released: boolean;
}

type GateOutcome =
  | { readonly kind: "continue" }
  | { readonly kind: "respond"; readonly response: HttpClientResponse }
  | { readonly kind: "error"; readonly error: unknown };

class GateImpl implements Gate {
  readonly matcher: RequestMatcher;
  private heldRequest: FakeRequest | undefined;
  private firedFlag = false;
  private releasedFlag = false;
  private readonly arrivedDeferred = deferred<FakeRequest>();
  private outcomeDeferred: Deferred<GateOutcome> | undefined;
  private pendingOutcome: GateOutcome | undefined;

  constructor(matcher: RequestMatcher) {
    this.matcher = matcher;
  }

  get held(): FakeRequest | undefined {
    return this.heldRequest;
  }

  get arrived(): Promise<FakeRequest> {
    return this.arrivedDeferred.promise;
  }

  get released(): boolean {
    return this.releasedFlag;
  }

  get fired(): boolean {
    return this.firedFlag;
  }

  /**
   * Called by the dispatch pipeline when a matching, not-yet-fired request
   * arrives. Parks it.
   *
   * If the gate was already released BEFORE the request arrived, the recorded
   * outcome is applied immediately rather than parking on a deferred nobody
   * will ever resolve. Getting this wrong hangs the test forever with no
   * diagnostic, so the early-release path is explicitly supported.
   */
  park(request: FakeRequest): Promise<GateOutcome> {
    this.firedFlag = true;
    this.heldRequest = request;
    this.arrivedDeferred.resolve(request);
    if (this.pendingOutcome !== undefined) return Promise.resolve(this.pendingOutcome);
    this.outcomeDeferred = deferred<GateOutcome>();
    return this.outcomeDeferred.promise;
  }

  /** Single release path: resolves the parked request, or records the outcome for a request that has not arrived yet. */
  private settle(outcome: GateOutcome): void {
    if (this.releasedFlag) {
      throw new Error(
        `Gate already released (matcher: ${String(this.matcher)}). ` +
          "Releasing twice is always a test bug — the second call has no request to act on.",
      );
    }
    this.releasedFlag = true;
    if (this.outcomeDeferred) this.outcomeDeferred.resolve(outcome);
    else this.pendingOutcome = outcome;
  }

  release(): void {
    this.settle({ kind: "continue" });
  }

  releaseWith(res: HttpClientResponse): void {
    this.settle({ kind: "respond", response: res });
  }

  releaseError(err: unknown): void {
    this.settle({ kind: "error", error: err });
  }
}

// ---------------------------------------------------------------------------
// Long polls
// ---------------------------------------------------------------------------

/**
 * A parked debugger long-poll: still on the wire until it is settled.
 *
 * The poll is NEVER cancelled by other traffic. Live evidence,
 * 3/3 trials: a same-session request issued
 * while this poll is outstanding does not disturb it — the poll runs to its
 * natural timeout and returns FIRST, and the other request completes a
 * fraction of a second later with its correct payload. A different session is
 * unaffected entirely (329 ms round trip while a poll was parked). The only
 * things that end a poll are a real listener hit ({@link resolve}), the
 * timeout ({@link timeout}), or a DELETE on the listener path ({@link stop}).
 *
 * This replaces an earlier model in which a same-session request KILLED the
 * outstanding poll. That model was wrong, and it survived a long time because
 * it reproduced the right observable — an empty 200 — via the wrong
 * mechanism, and so got the timing completely wrong.
 */
export interface PendingPoll {
  readonly request: FakeRequest;
  readonly sessionId: string;
  readonly user: string;
  readonly settled: boolean;
  /** Deliver a real listener hit. */
  resolve(res: HttpClientResponse): void;
  /**
   * End the poll at its natural timeout: HTTP 200, zero-byte body, no
   * content-type. This silent shape is exactly why head-of-line blocking was
   * once misread as cancellation — a blocked caller sees an empty 200 come
   * back and concludes something was killed. Nothing was: the payload of the
   * blocked request arrives intact right after.
   */
  timeout(): void;
  /** End the poll because DELETE was issued on the listener path. Same silent 200/0-byte shape. */
  stop(): void;
}

class PendingPollState implements PendingPoll {
  readonly request: FakeRequest;
  readonly sessionId: string;
  readonly user: string;
  private settledFlag = false;
  private readonly outcome = deferred<HttpClientResponse>();

  constructor(request: FakeRequest, sessionId: string, user: string) {
    this.request = request;
    this.sessionId = sessionId;
    this.user = user;
  }

  get settled(): boolean {
    return this.settledFlag;
  }

  get awaitable(): Promise<HttpClientResponse> {
    return this.outcome.promise;
  }

  /** Any settle path. Throws on a second call — silently dropping a real listener hit would hide the bug. */
  private settle(res: HttpClientResponse): void {
    if (this.settledFlag) {
      throw new Error(
        `Long poll already settled (session '${this.sessionId}', seq ${this.request.seq}). ` +
          "Settling twice is always a test bug; ignoring it would silently drop a listener hit.",
      );
    }
    this.settledFlag = true;
    this.outcome.resolve(res);
  }

  resolve(res: HttpClientResponse): void {
    this.settle(res);
  }

  timeout(): void {
    this.settle(EMPTY_200());
  }

  stop(): void {
    this.settle(EMPTY_200());
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers (no exported surface)
// ---------------------------------------------------------------------------

let globalSeqCounter = 0;
function nextSeq(): number {
  return ++globalSeqCounter;
}

/**
 * Reset the module-level `seq` and lock-handle counters.
 *
 * Both counters are module-global, so absolute `seq` values and handle strings
 * depend on how many servers ran before yours — within a file and, with
 * `fileParallelism: false`, across files. Assert on RELATIVE ordering, not on
 * absolute numbers. If you must pin absolute values, call this in `beforeEach`
 * and never rely on it holding across files.
 */
export function __resetFakeAdtCounters(): void {
  globalSeqCounter = 0;
  lockHandleCounter = 0;
}

/**
 * Canonical key for the lock table.
 *
 * SAP's enqueue is on the OBJECT, not on the URL you happened to type. Three
 * spellings of the same object must collide:
 *   `/sap/bc/adt/programs/programs/zx`
 *   `/sap/bc/adt/programs/programs/zx/`
 *   `/sap/bc/adt/programs/programs/ZX/source/main`
 * Keying on the raw pathname silently splits those into three independent
 * locks, so a genuine conflict would quietly NOT conflict — the single most
 * dangerous failure mode this file can have, because the test goes green.
 */
function lockKey(path: string): string {
  return path
    .replace(/\/source\/main$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Object name for an error body: last segment of the NORMALISED path, upper-cased (so a `/source/main` lock is not named `MAIN`). */
function objectNameFor(path: string): string {
  const segments = lockKey(path).split("/").filter(Boolean);
  return (segments[segments.length - 1] ?? "UNKNOWN_OBJECT").toUpperCase();
}

function splitUrl(url: string): { path: string; qs: Record<string, string> } {
  const parsed = new URL(url, "http://fake-adt-host.invalid/");
  const qs: Record<string, string> = {};
  for (const [k, v] of parsed.searchParams) qs[k] = v;
  return { path: parsed.pathname, qs };
}

function buildLabel(method: string, path: string, qs: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(qs).sort();
  const query = keys.map((k) => `${k}=${String(qs[k])}`).join("&");
  return query ? `${method} ${path}?${query}` : `${method} ${path}`;
}

function buildFakeRequest(seq: number, session: SessionState, options: HttpClientOptions): FakeRequest {
  const method = (options.method ?? "GET").toString().toUpperCase();
  const { path, qs: urlQs } = splitUrl(options.url);
  const qs: Record<string, unknown> = { ...urlQs, ...(options.qs ?? {}) };
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.headers ?? {})) {
    headers[k.toLowerCase()] = v;
  }
  return {
    seq,
    sessionId: session.id,
    user: session.user,
    method,
    url: options.url,
    path,
    qs,
    headers,
    body: options.body,
    label: buildLabel(method, path, qs),
    stateful: session.stateful,
    options,
  };
}

function hasStatefulHeader(headers: Readonly<Record<string, string>>): boolean {
  return headers["x-sap-adt-sessiontype"]?.toLowerCase() === "stateful";
}

function lastPathSegmentUpper(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  return (last ?? path).toUpperCase();
}

function looksLikeSourceMainPath(path: string): boolean {
  return /\/source\/main\b/.test(path);
}

function stableEtag(text: string): string {
  // Deterministic, not random: a stable hash of the content is all a fake
  // etag needs to be, and node:crypto's digest is not a randomness source.
  return createHash("sha1").update(text, "utf8").digest("hex");
}

const DEFAULT_LONG_POLL_MATCHER: RequestMatcher = (r) =>
  r.method === "POST" && r.path.includes("/sap/bc/adt/debugger/listeners");

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/** Construction options for {@link FakeAdtServer}. */
export interface FakeAdtOptions {
  /** Default user new sessions are minted with. Default `"DEVELOPER"`. */
  readonly user?: string;
  /** Consulted, in order, before the builtin routes. */
  readonly routes?: readonly FakeRoute[];
  /** Last-resort route. If absent, an unrouted request THROWS loudly (StrictAdt idiom). */
  readonly catchAll?: FakeRoute;
  /**
   * What to do on a stateful single-flight overlap. Default `"record"`.
   *
   * The default used to be `"throw"`, on the model that SAP rejects a second
   * concurrent request on a stateful session. Live evidence
   * refuted that: SAP does not reject, it
   * SERIALISES — the second request is head-of-line blocked until the first
   * finishes. Measured: 115 133 ms blocked behind a `timeout=120` listener,
   * 55 148 ms behind a `timeout=60` one, and the blocked request then returned
   * its correct payload. Throwing by default would model a fiction, so the
   * fake now blocks (faithful) and records a violation (so the pool bug is
   * still loud). Set `"throw"` if you want the overlap to fail immediately.
   */
  readonly onStatefulOverlap?: "throw" | "record";
  /**
   * Scope at which a second global-scope debug listener is rejected with
   * {@link listenerConflict409}. Default `"user"` — the live capture showed
   * a fresh `terminalId`/`ideId` did NOT evade the conflict, and the message
   * names the user.
   *
   * The open question this option was exposed for HAS LANDED, and the default
   * is deliberately unchanged. A later controlled 2×2 re-test found: a second
   * global-scope listener with the SAME `(user, terminalId, ideId)` triple is
   * ACCEPTED and arms, while a DIFFERENT triple for the same user still draws
   * the `409`. Our production identity is derived deterministically per
   * SID+user, so the shape a real second listener meets is the different-triple
   * one — `"user"` stays the faithful default. `"session"`/`"terminal"` remain
   * available to model the same-triple acceptance in a test that wants it.
   *
   * Do not read `"terminal"` here as "terminal scope is a way to get a second
   * working listener". Measurement showed that terminal-scope listeners never
   * catch a debuggee at all (0 catches in 7 cells, `200`/0 bytes at full
   * timeout).
   * Non-conflict is not attachment; this option only models the ARM response.
   */
  readonly listenerConflictScope?: "user" | "session" | "terminal" | "none";
  /** Default: path contains `/sap/bc/adt/debugger/listeners` and method is POST. */
  readonly longPollMatcher?: RequestMatcher;
  /** Seed source store: object path -> source text. */
  readonly objects?: Readonly<Record<string, string>>;
  /**
   * Seed the object-metadata store: object URI (NOT the `/source/main` path) ->
   * the document a `GET {objectUri}` answers with. Build the value with
   * {@link objectMetadataXml}.
   *
   * Without this, a `GET` of a bare object URI falls through to `catchAll`, and
   * every mutating tool fails closed with `SAFETY_DENIED` / `PACKAGE_UNKNOWN`
   * before it reaches the lock/PUT sequence — see {@link objectMetadataXml}.
   */
  readonly objectMetadata?: Readonly<Record<string, string>>;
  /**
   * How a NON-2xx response is delivered to the caller.
   *
   *  - `"resolve"` (default) — the response object is returned. Historical
   *    behaviour, kept as the default so existing suites are untouched;
   *    `fake-adt.test.ts` asserts it directly for the expired-session 400.
   *  - `"throw"` — a real `HttpClientException` is raised with the response on
   *    `.response`, which is what the shipped transport does.
   *
   * ### Why `"throw"` exists, and why you probably want it
   *
   * `AxiosHttpClient` (`abap-adt-api/build/AxiosHttpClient.js`) sets no
   * `validateStatus`, so axios' default — `status >= 200 && status < 300` —
   * applies and it REJECTS every non-2xx, rethrowing as
   * `new HttpClientException(message, code, status, config, options, response,
   * parent)`. Nothing above it ever sees a resolved non-2xx.
   *
   * That matters most for session death, which is only ever a `400`
   * (`x-sap-icm-err-id: ICMENOSESSION`) or a `500` dump page.
   * Because this fake RESOLVED
   * those, `AbapConnection.noteWireThrow` — the ONLY death detector production
   * can reach — went untested end to end: an auditor mutated it to drop 5xx
   * silently and the mutant survived the whole suite. `"throw"` is what closes
   * that gap; see `test/connection-death-wire.test.ts`.
   *
   * The exception is the real class, not a look-alike with a `.response` field,
   * because `abap-adt-api` narrows with `isHttpClientException` (`AdtHTTP.js`)
   * before reading it — an impostor is downgraded to a generic status-500
   * `AdtErrorException` and the status, headers and body are lost.
   *
   * Applies to responses leaving {@link FakeAdtServer.dispatchRequest}: routed
   * responses, the expired-session `400`, listener `409`s and gate/poll
   * completions alike. It does NOT touch the paths that already throw
   * (`FakeAdtProtocolError` for an unrouted or dropped-session request,
   * `FakeAdtViolation`), and it does not change what is recorded in `calls`,
   * `events` or `violations` — a request is recorded before its response is
   * built, so violation counts are identical under either setting.
   */
  readonly transportErrors?: "resolve" | "throw";
}

/**
 * The fake server: one shared lock table, one shared source store, N
 * sessions minted via {@link FakeAdtServer.client}. See the module JSDoc for
 * what is verified vs reconstructed, and for what this deliberately does
 * not model (cross-process behaviour, the debugger session protocol, CTS).
 */
export class FakeAdtServer {
  private readonly defaultUser: string;
  private readonly customRoutes: readonly FakeRoute[];
  private readonly catchAllRoute: FakeRoute | undefined;
  private readonly onStatefulOverlap: "throw" | "record";
  private readonly listenerConflictScope: "user" | "session" | "terminal" | "none";
  private readonly longPollMatcher: RequestMatcher;
  /** See {@link FakeAdtOptions.transportErrors}. */
  private readonly transportErrors: "resolve" | "throw";
  /** Armed global-scope debug listeners, keyed by the scope token (see {@link FakeAdtOptions.listenerConflictScope}). */
  private readonly armedListenersInternal = new Map<string, { user: string; sessionId: string; poll: PendingPollState }>();

  private readonly sessionList: SessionState[] = [];
  private readonly gatesInternal: GateImpl[] = [];
  private readonly pendingPollsInternal: PendingPollState[] = [];
  private readonly violationsInternal: FakeViolation[] = [];
  private readonly callsInternal: FakeRequest[] = [];
  private readonly eventsInternal: string[] = [];

  private readonly objectLocks = new Map<string, { sessionId: string; handle: string }>();
  private readonly handleOwners = new Map<string, string>();
  private readonly sourceStore = new Map<string, string>();
  /** Object URI -> object-metadata document. See {@link FakeAdtOptions.objectMetadata}. */
  private readonly metadataStore = new Map<string, string>();

  constructor(options: FakeAdtOptions = {}) {
    this.defaultUser = options.user ?? "DEVELOPER";
    this.customRoutes = options.routes ?? [];
    this.catchAllRoute = options.catchAll;
    this.onStatefulOverlap = options.onStatefulOverlap ?? "record";
    this.listenerConflictScope = options.listenerConflictScope ?? "user";
    this.longPollMatcher = options.longPollMatcher ?? DEFAULT_LONG_POLL_MATCHER;
    this.transportErrors = options.transportErrors ?? "resolve";
    if (options.objects) {
      for (const [path, source] of Object.entries(options.objects)) this.sourceStore.set(path, source);
    }
    if (options.objectMetadata) {
      for (const [uri, xml] of Object.entries(options.objectMetadata)) this.metadataStore.set(uri, xml);
    }
  }

  /** Mint a new session with its own contextid, CSRF token and stateful flag, and a client handle bound to it. `name`, if given, overrides the session's user (default {@link FakeAdtOptions.user}). */
  client(name?: string): FakeAdtClient {
    const index = this.sessionList.length + 1;
    const id = `s${index}`;
    const user = name ?? this.defaultUser;
    const contextId = `SID:ANON:A4H:FAKE_CTX_${String(index).padStart(4, "0")}`;
    const csrfToken = `FAKE_CSRF_${String(index).padStart(4, "0")}`;
    const session = new SessionState(id, user, contextId, csrfToken);
    this.sessionList.push(session);
    return new FakeAdtClient(this, session);
  }

  get sessions(): readonly FakeSession[] {
    return this.sessionList;
  }

  session(id: string): FakeSession {
    return this.findSession(id);
  }

  private findSession(id: string): SessionState {
    const found = this.sessionList.find((s) => s.id === id);
    if (!found) throw new Error(`Unknown fake ADT session: '${id}'`);
    return found;
  }

  /** Drop a session (client-side disposal): releases ALL its locks immediately (no flush needed) and ends its in-flight polls. */
  drop(sessionId: string): void {
    this.teardownSession(sessionId, "dropped");
  }

  /**
   * Expire a session server-side. Distinct from {@link drop}: the client still
   * believes the session is alive, and every subsequent request on it returns
   * {@link sessionTimedOut400} — a `400` ICM `text/html` page carrying
   * `x-sap-icm-err-id: ICMENOSESSION`, not an ADT `exc:exception`.
   *
   * Crucially, expiry RELEASES the session's enqueues (`ENQSUM> rows=0` after
   * the timeout, and a fresh session re-locked the same object in 138 ms). So
   * a pool that "leaks" a lock by losing its session
   * is not leaking it forever — but it also gets no notification, and its own
   * held-lock bookkeeping is now wrong.
   */
  expire(sessionId: string): void {
    this.teardownSession(sessionId, "expired");
  }

  private teardownSession(sessionId: string, mode: "dropped" | "expired"): void {
    const session = this.findSession(sessionId);
    if (mode === "dropped") session.dropped = true;
    else session.expired = true;

    for (const key of [...session.locks]) {
      const entry = this.objectLocks.get(key);
      if (entry) {
        this.handleOwners.delete(entry.handle);
        this.objectLocks.delete(key);
      }
    }
    session.clearLocks();

    for (const poll of this.pendingPollsInternal) {
      if (poll.sessionId === sessionId && !poll.settled) poll.stop();
    }
    for (const [key, armed] of [...this.armedListenersInternal]) {
      if (armed.sessionId === sessionId) this.armedListenersInternal.delete(key);
    }
    // A request already parked on a gate must not resume into a dead session
    // and re-acquire locks.
    for (const gate of this.gatesInternal) {
      if (!gate.released && gate.held?.sessionId === sessionId) {
        gate.releaseError(
          new FakeAdtProtocolError(
            `Session '${sessionId}' was ${mode} while seq ${gate.held.seq} was parked on a gate.`,
          ),
        );
      }
    }
  }

  /** Armed global-scope debug listeners. At most one per scope token — see {@link FakeAdtOptions.listenerConflictScope}. */
  get armedListeners(): readonly { readonly user: string; readonly sessionId: string }[] {
    return [...this.armedListenersInternal.values()].map((a) => ({ user: a.user, sessionId: a.sessionId }));
  }

  /** Who holds the lock on this object. The path is normalised, so a trailing slash, a case difference or a `/source/main` suffix all resolve to the same object. */
  lockHolder(objectPath: string): string | undefined {
    return this.objectLocks.get(lockKey(objectPath))?.sessionId;
  }

  lockHandleOwner(handle: string): string | undefined {
    return this.handleOwners.get(handle);
  }

  get lockedObjects(): readonly string[] {
    return [...this.objectLocks.keys()];
  }

  /**
   * Test-only escape hatch: drop whatever lock (if any) is held on
   * `objectPath` WITHOUT an UNLOCK round trip and without touching
   * `calls`/`events`.
   *
   * Exists for custom routes (like {@link bopfStore}'s `failNextPuts`) that
   * inject a write failure directly, bypassing the generic builtin PUT/lock
   * machinery entirely. `relock.ts`'s module header documents a captured real
   * behaviour this needs to model: "After ANY PUT that errors, the lock
   * handle is dead server-side" — i.e. a failed write already kills the
   * enqueue on the real system, so the client's own best-effort UNLOCK
   * afterwards is genuine belt-and-suspenders, not the thing that actually
   * frees it (and in fact `StatefulSession.unlock` is a no-op once
   * `forgetLock` has cleared its ledger entry — session.ts:1258-1273 — so no
   * UNLOCK request is ever sent on that path). A custom route that answers a
   * canned failure without calling this leaves the fake's OWN lock table
   * stale, and a same-session retry then collides with itself
   * (`routeLock`'s captured "User X is currently editing" 403) — a fake
   * artefact, not a real hazard. This method is how a custom route avoids
   * manufacturing that artefact.
   */
  releaseLockSilently(objectPath: string): void {
    const key = lockKey(objectPath);
    const entry = this.objectLocks.get(key);
    if (!entry) return;
    this.objectLocks.delete(key);
    this.handleOwners.delete(entry.handle);
    this.findSession(entry.sessionId).removeLock(key);
  }

  get calls(): readonly FakeRequest[] {
    return this.callsInternal;
  }

  callsFor(m: RequestMatcher): readonly FakeRequest[] {
    return this.callsInternal.filter((r) => matches(m, r));
  }

  /** Ordering log: `dispatch:seq`, `park:seq`, `release:seq`, `respond:seq:status`, plus whatever a test pushes via {@link note}. */
  get events(): readonly string[] {
    return this.eventsInternal;
  }

  /** Let a test interleave its own markers into the same ordering log. */
  note(event: string): void {
    this.eventsInternal.push(event);
  }

  /** Arm a gate for the first not-yet-fired matching request. Gates are consulted in arm order; each fires at most once. */
  hold(matcher: RequestMatcher): Gate {
    const gate = new GateImpl(matcher);
    this.gatesInternal.push(gate);
    return gate;
  }

  /** Long polls STILL on the wire. Settled polls are pruned — `pendingPolls.length === 0` means nothing is parked. */
  get pendingPolls(): readonly PendingPoll[] {
    return this.pendingPollsInternal.filter((p) => !p.settled);
  }

  /** Every long poll ever registered, settled or not, in arrival order. */
  get allPolls(): readonly PendingPoll[] {
    return this.pendingPollsInternal;
  }

  /** Unsettled long polls for one session. */
  pollsFor(sessionId: string): readonly PendingPoll[] {
    return this.pendingPollsInternal.filter((p) => p.sessionId === sessionId && !p.settled);
  }

  get violations(): readonly FakeViolation[] {
    return this.violationsInternal;
  }

  assertNoViolations(): void {
    const first = this.violationsInternal[0];
    if (first) throw new FakeAdtViolation(first);
  }

  setSource(objectPath: string, source: string): void {
    this.sourceStore.set(objectPath, source);
  }

  getSource(objectPath: string): string | undefined {
    return this.sourceStore.get(objectPath);
  }

  /** Seed/replace the object-metadata document a `GET {objectUri}` answers with. */
  setObjectMetadata(objectUri: string, xml: string): void {
    this.metadataStore.set(objectUri, xml);
  }

  getObjectMetadata(objectUri: string): string | undefined {
    return this.metadataStore.get(objectUri);
  }

  private setLock(objectPath: string, sessionId: string, handle: string): void {
    const key = lockKey(objectPath);
    // No re-lock branch: LOCK on an already-locked object never reaches here.
    // Live proved a same-session re-LOCK is a 403, not a re-issue (see routeLock).
    this.objectLocks.set(key, { sessionId, handle });
    this.handleOwners.set(handle, sessionId);
    this.findSession(sessionId).addLock(key);
  }

  private clearLockByHandle(handle: string): void {
    const sessionId = this.handleOwners.get(handle);
    if (sessionId === undefined) return;
    this.handleOwners.delete(handle);
    for (const [key, entry] of this.objectLocks) {
      if (entry.handle === handle) {
        this.objectLocks.delete(key);
        this.findSession(sessionId).removeLock(key);
        break;
      }
    }
  }

  /** The NORMALISED lock key this handle locks, if any. */
  private pathForHandle(handle: string): string | undefined {
    for (const [key, entry] of this.objectLocks) {
      if (entry.handle === handle) return key;
    }
    return undefined;
  }

  private stampSession(response: HttpClientResponse, session: SessionState): HttpClientResponse {
    // Merge, never overwrite: a route that set its own set-cookie (the expiry
    // cookies, say) must keep it (review minor).
    const existingCookies = (response.headers as Record<string, unknown> | undefined)?.["set-cookie"];
    const priorCookies = Array.isArray(existingCookies)
      ? (existingCookies as string[])
      : typeof existingCookies === "string"
        ? [existingCookies]
        : [];
    return {
      ...response,
      headers: {
        ...response.headers,
        "set-cookie": [
          ...priorCookies,
          `SAP_SESSIONID_A4H_001=${session.id}-FAKE; path=/`,
          `sap-contextid=${session.contextId}; path=/`,
        ],
        "sap-contextid": session.contextId,
      },
    };
  }

  /**
   * LOCK. Any lock on an already-locked object is a 403 — including a
   * re-LOCK by the session that already holds it.
   *
   * That last part is the surprise, and it is CAPTURED, not inferred: a live
   * probe table, and the third of its stated consequences. "LOCK the same
   * object twice in the **same** session" → `403` / `ExceptionResourceNoAccess`
   * / `User DEVELOPER is currently editing ZMCPX_P1`. It is not idempotent and
   * it does not re-issue the handle.
   *
   * Precisely what the capture pins, so nobody over-reads this later:
   *  - CAPTURED for the same-session case: status `403`, type
   *    `ExceptionResourceNoAccess`, and the message text — all three identical
   *    to the cross-session conflict.
   *  - `UNCONFIRMED_`: that the same-session 403 also carries the same
   *    `<properties>` block (`T100KEY-ID=EU`, `NO=510`, `V1`/`V2`). The probe
   *    records status/type/message only; the verbatim XML envelope with the
   *    T100KEY entries is quoted for the CROSS-session case alone. The
   *    fake emits one shared envelope for both, which is the parsimonious
   *    reading, but it is an extrapolation of the properties block.
   *  - `UNCONFIRMED_`: that the original lock handle survives a failed
   *    re-LOCK. The probe does not test handle validity after the 403. The
   *    fake keeps the first handle valid. Uncertainty runs the other way too —
   *    if SAP were to invalidate on a refused re-lock, a pool that retried
   *    would be left holding a dead handle and would see `423` on the next
   *    PUT.
   *
   * The consequence for a session pool: it cannot distinguish "I already hold
   * this lock" from "someone else holds it" by status code, type or message.
   * It must track its own held locks and never re-lock optimistically. That
   * consequence rests only on the CAPTURED part above.
   *
   * Scope is (object, SESSION), never user: two sessions of the SAME user
   * conflict with each other exactly as two different users would. Confirmed
   * live on PROG, CLAS, TABL, DOMA and DTEL with an identical envelope.
   * Not tested there: INTF, FUGR, includes, DDLS, transport-level objects.
   */
  private routeLock(request: FakeRequest): HttpClientResponse {
    const holderId = this.lockHolder(request.path);
    if (holderId !== undefined) {
      const holder = this.findSession(holderId);
      return lockConflict403({ user: holder.user, objectName: objectNameFor(request.path) });
    }
    const handle = newLockHandle();
    this.setLock(request.path, request.sessionId, handle);
    return fakeResponse(200, lockSuccessXml(handle), { "content-type": LOCK_RESULT_CONTENT_TYPE });
  }

  /**
   * UNLOCK. **A garbage handle returns `200` with an empty body** — it does
   * not 4xx (captured).
   *
   * Two consequences, in tension:
   *  - Best-effort unlock in a `finally` is SAFE. There is no error to handle,
   *    so a cleanup path cannot fail because the handle went stale.
   *  - A `200` from UNLOCK is NOT evidence the lock was released. Code that
   *    infers release from the status is unsound.
   *
   * The fake returns the faithful `200` either way, and records an
   * `unlock-garbage-handle-accepted` violation so the unsound inference is
   * still catchable. That violation is the fake's own tripwire, not something
   * the wire tells you.
   */
  private routeUnlock(request: FakeRequest): HttpClientResponse {
    const rawHandle = request.qs["lockHandle"];
    const handle = typeof rawHandle === "string" ? rawHandle : "";
    const ownerId = this.handleOwners.get(handle);

    if (ownerId === undefined || ownerId !== request.sessionId) {
      // Live probed the garbage-handle case only; a handle owned by ANOTHER
      // live session was not probed separately, so treating the two alike is
      // an inference (see UNCONFIRMED_SHAPES).
      this.violationsInternal.push({
        kind: "unlock-garbage-handle-accepted",
        sessionId: request.sessionId,
        detail:
          ownerId === undefined
            ? `UNLOCK with unknown handle ${handle || "(absent)"} returned 200 — nothing was released`
            : `UNLOCK with handle ${handle} owned by session '${ownerId}', not '${request.sessionId}' — returned 200, nothing released`,
        request,
      });
      return EMPTY_200();
    }

    this.clearLockByHandle(handle);
    return EMPTY_200();
  }

  /**
   * PUT source. Three distinct live-captured outcomes:
   *  - no `lockHandle` at all -> `400 ExceptionParameterNotFound`
   *  - handle unknown, or not this session's, or not this object's ->
   *    `423 ExceptionResourceInvalidLockHandle`
   *  - otherwise the write lands.
   */
  private routePut(request: FakeRequest, handle: string): HttpClientResponse {
    const objectName = objectNameFor(request.path);
    const ownerId = this.handleOwners.get(handle);

    if (ownerId === undefined) {
      this.violationsInternal.push({
        kind: "unknown-lock-handle",
        sessionId: request.sessionId,
        detail: `PUT with unknown lock handle ${handle}`,
        request,
      });
      return invalidLockHandle423({ objectName, handle });
    }
    if (ownerId !== request.sessionId) {
      this.violationsInternal.push({
        kind: "cross-session-lock-handle",
        sessionId: request.sessionId,
        detail: `PUT with lock handle ${handle} owned by session '${ownerId}', not '${request.sessionId}'`,
        request,
      });
      return invalidLockHandle423({ objectName, handle });
    }
    // A handle is bound to ONE object. Session A holding object X may not PUT
    // object Y with X's handle.
    const handlePath = this.pathForHandle(handle);
    if (handlePath !== undefined && handlePath !== lockKey(request.path)) {
      this.violationsInternal.push({
        kind: "unknown-lock-handle",
        sessionId: request.sessionId,
        detail: `PUT ${request.path} with lock handle ${handle}, which locks '${handlePath}'`,
        request,
      });
      return invalidLockHandle423({ objectName, handle });
    }

    this.sourceStore.set(request.path, request.body ?? "");
    return EMPTY_200();
  }

  private routeBuiltin(request: FakeRequest): HttpClientResponse | undefined {
    const base = this.routeBuiltinBody(request);
    if (base === undefined) return undefined;

    // CSRF: a `x-csrf-token: fetch` request gets the token merged into its
    // NORMAL response. It used to short-circuit and return an empty body,
    // which broke real logon — abap-adt-api fetches the token on
    // GET /sap/bc/adt/compatibility/graph and wants the graph document too.
    const csrfHeader = request.headers["x-csrf-token"];
    if (typeof csrfHeader === "string" && csrfHeader.toLowerCase() === "fetch") {
      const session = this.findSession(request.sessionId);
      return { ...base, headers: { ...base.headers, "x-csrf-token": session.csrfToken } };
    }
    return base;
  }

  private routeBuiltinBody(request: FakeRequest): HttpClientResponse | undefined {
    if (request.method === "GET") {
      if (request.path.endsWith("/discovery")) return fakeResponse(200, "<service/>", { "content-type": "application/xml" });
      if (request.path.endsWith("/compatibility/graph")) return fakeResponse(200, "<graph/>", { "content-type": "application/xml" });
      if (request.path.endsWith("/ato/settings")) return fakeResponse(200, "<settings/>", { "content-type": "application/xml" });
    }

    if (request.method === "POST" && request.qs["_action"] === "LOCK") return this.routeLock(request);
    if (request.method === "POST" && request.qs["_action"] === "UNLOCK") return this.routeUnlock(request);

    if (request.method === "PUT" && looksLikeSourceMainPath(request.path)) {
      const putLockHandle = request.qs["lockHandle"];
      if (typeof putLockHandle !== "string" || putLockHandle === "") {
        // Live: a PUT with no lockHandle is 400 ExceptionParameterNotFound —
        // a DIFFERENT status and type from the bad-handle 423, so the two are
        // distinguishable.
        return missingLockHandle400();
      }
      return this.routePut(request, putLockHandle);
    }
    const putLockHandle = request.qs["lockHandle"];
    if (request.method === "PUT" && typeof putLockHandle === "string") return this.routePut(request, putLockHandle);

    // DELETE on the listener path is the real way to end a parked long poll —
    // it returns the same silent 200/0-byte shape as a natural timeout.
    if (request.method === "DELETE" && request.path.includes("/sap/bc/adt/debugger/listeners")) {
      for (const poll of this.pendingPollsInternal) {
        if (poll.sessionId === request.sessionId && !poll.settled) poll.stop();
      }
      for (const [key, armed] of [...this.armedListenersInternal]) {
        if (armed.sessionId === request.sessionId) this.armedListenersInternal.delete(key);
      }
      return EMPTY_200();
    }

    if (request.method === "GET") {
      const source = this.sourceStore.get(request.path);
      if (source !== undefined) {
        return fakeResponse(200, source, {
          "content-type": "text/plain; charset=utf-8",
          etag: `"${stableEtag(source)}"`,
        });
      }
      // Seeded object-metadata documents (empty unless a test asks for them, so
      // this branch changes nothing for existing callers).
      const meta = this.metadataStore.get(request.path);
      if (meta !== undefined) {
        return fakeResponse(200, meta, { "content-type": "application/xml; charset=utf-8" });
      }
      if (looksLikeSourceMainPath(request.path)) return fakeResponse(404, "");
    }

    return undefined;
  }

  /**
   * Scope token at which a second global-scope debug listener conflicts.
   * Returns `undefined` when conflicts are disabled entirely.
   */
  private listenerScopeToken(request: FakeRequest): string | undefined {
    switch (this.listenerConflictScope) {
      case "none":
        return undefined;
      case "session":
        return `session:${request.sessionId}`;
      case "terminal":
        return `terminal:${String(request.qs["terminalId"] ?? "")}`;
      case "user":
      default:
        return `user:${request.user}`;
    }
  }

  private async route(request: FakeRequest): Promise<HttpClientResponse> {
    for (const r of this.customRoutes) {
      const res = await r(request, this);
      if (res !== undefined) return res;
    }
    const builtin = this.routeBuiltin(request);
    if (builtin !== undefined) return builtin;
    if (this.catchAllRoute) {
      const res = await this.catchAllRoute(request, this);
      if (res !== undefined) return res;
    }
    this.violationsInternal.push({
      kind: "unrouted-request",
      sessionId: request.sessionId,
      detail: `no route matched ${request.label}`,
      request,
    });
    throw new FakeAdtProtocolError(`Unrouted request: ${request.label}`);
  }

  /**
   * The last thing every response passes through: resolve it, or raise it the
   * way axios raises it. See {@link FakeAdtOptions.transportErrors}.
   *
   * Deliberately AFTER `note(respond:…)` and after `stampSession`, so the
   * recorded event stream and the session cookie bookkeeping are identical
   * under both settings and only the delivery mechanism differs. `HttpClient`
   * declares a `Promise<HttpClientResponse>` return, so the throw is expressed
   * as a return type the caller can `await` either way.
   */
  private deliver(response: HttpClientResponse, options: HttpClientOptions): HttpClientResponse {
    if (this.transportErrors === "resolve") return response;
    if (response.status >= 200 && response.status < 300) return response;
    throw new HttpClientException(
      `Request failed with status code ${response.status}`,
      "ERR_BAD_REQUEST",
      response.status,
      undefined,
      options,
      response,
      undefined,
    );
  }

  /**
   * Internal dispatch entry point invoked by {@link FakeAdtClient.request}.
   * Public only because TypeScript has no cross-class "friend" access within
   * a module; not part of the fake's intended external surface.
   */
  async dispatchRequest(session: SessionState, options: HttpClientOptions): Promise<HttpClientResponse> {
    const seq = nextSeq();
    const request = buildFakeRequest(seq, session, options);

    // Record BEFORE any rejection. A dropped- or expired-session request that
    // never appears in `calls` leaves an unexplained gap in `seq` and lets
    // "nothing was sent after drop" pass vacuously.
    this.callsInternal.push(request);
    this.note(`dispatch:${seq}`);

    if (session.dropped) {
      const violation: FakeViolation = {
        kind: "dropped-session-request",
        sessionId: session.id,
        detail: `request ${request.label} issued on dropped session '${session.id}'`,
        request,
      };
      this.violationsInternal.push(violation);
      throw new FakeAdtProtocolError(
        `Fake ADT session '${session.id}' has been dropped; request rejected: ${request.label}`,
      );
    }

    if (session.expired) {
      // Server-side expiry: the client does not know. It gets the ICM
      // text/html 400, not an exc:exception.
      this.violationsInternal.push({
        kind: "expired-session-request",
        sessionId: session.id,
        detail: `request ${request.label} issued on expired session '${session.id}' (ICMENOSESSION)`,
        request,
      });
      const timedOut = sessionTimedOut400();
      this.note(`respond:${seq}:${timedOut.status}`);
      return this.deliver(timedOut, options);
    }

    if (hasStatefulHeader(request.headers)) {
      session.stateful = true;
    }

    const isPoll = matches(this.longPollMatcher, request);

    // ---- Head-of-line blocking --------------------------------------------
    // OBSERVED BEHAVIOUR, not a proven mechanism. What was measured is only
    // this: while one request is outstanding on a session, a second request
    // on that SAME session does not complete until the first settles. It is
    // not cancelled, it does not fail, and when it does complete it carries
    // its correct payload. Measured: 115 133 ms behind a `timeout=120`
    // listener, 55 148 ms behind `timeout=60`, 55 402 ms with the repo's own
    // confirm-GET — and in every trial the listener returned FIRST, at its
    // own natural timeout. A DIFFERENT session was entirely unaffected
    // (329 ms round trip while another session's poll was parked).
    //
    // What is NOT established is WHERE the serialisation happens. A
    // client-side single-socket pin per ADTClient would produce identical
    // timings with SAP never seeing the second request at all. So this models
    // the observable ordering guarantee and deliberately encodes no claim
    // about a server-side queue.
    //
    // The overlap is recorded as a violation — a stall of seconds to minutes
    // is a severe pool bug — but modelled as a stall, never as an error.
    let releaseQueue: (() => void) | undefined;
    if (session.stateful) {
      if (session.inFlight > 0) {
        const conflictingSeq = session.lastInFlightSeq;
        const violation: FakeViolation = {
          kind: "concurrent-stateful-request",
          sessionId: session.id,
          detail:
            `stateful session '${session.id}' already has a request in flight when #${seq} ` +
            `(${request.label}) arrived — SAP head-of-line blocks it for the remainder of the first`,
          request,
          ...(conflictingSeq !== undefined ? { conflictingSeq } : {}),
        };
        this.violationsInternal.push(violation);
        if (this.onStatefulOverlap === "throw") {
          throw new FakeAdtViolation(violation);
        }
        this.note(`blocked:${seq}`);
      }
      const priorTail = session.queueTail;
      const gateDeferred = deferred<void>();
      session.queueTail = gateDeferred.promise;
      releaseQueue = () => gateDeferred.resolve();
      await priorTail;
      if (session.inFlight > 0) this.note(`unblocked:${seq}`);
    }

    let countedInFlight = false;
    try {
      // A session can be torn down while this request sat in the queue.
      if (session.dropped || session.expired) {
        throw new FakeAdtProtocolError(
          `Fake ADT session '${session.id}' was ${session.dropped ? "dropped" : "expired"} ` +
            `while request #${seq} (${request.label}) was queued.`,
        );
      }

      session.pushInFlight(seq);
      countedInFlight = true;

      // Gate check: first armed, unfired, matching gate parks the request.
      const gate = this.gatesInternal.find((g) => !g.fired && matches(g.matcher, request));
      let response: HttpClientResponse | undefined;
      if (gate) {
        this.note(`park:${seq}`);
        const outcome = await gate.park(request);
        this.note(`release:${seq}`);
        // A gate can be held across a drop/expire; resuming into a dead
        // session would let it re-acquire locks.
        if (session.dropped || session.expired) {
          throw new FakeAdtProtocolError(
            `Fake ADT session '${session.id}' was ${session.dropped ? "dropped" : "expired"} ` +
              `while request #${seq} (${request.label}) was parked on a gate.`,
          );
        }
        if (outcome.kind === "error") throw outcome.error;
        if (outcome.kind === "respond") response = outcome.response;
        // "continue": fall through to poll registration / routing below.
      }

      if (response === undefined) {
        if (isPoll) {
          const conflict = this.armListener(request, session);
          if (conflict !== undefined) {
            response = conflict;
          } else {
            const poll = new PendingPollState(request, session.id, session.user);
            this.pendingPollsInternal.push(poll);
            const token = this.listenerScopeToken(request);
            if (token !== undefined) {
              this.armedListenersInternal.set(token, { user: session.user, sessionId: session.id, poll });
            }
            response = await poll.awaitable;
            if (token !== undefined && this.armedListenersInternal.get(token)?.poll === poll) {
              this.armedListenersInternal.delete(token);
            }
          }
        } else {
          response = await this.route(request);
        }
      }

      const stamped = this.stampSession(response, session);
      this.note(`respond:${seq}:${stamped.status}`);
      return this.deliver(stamped, options);
    } finally {
      if (countedInFlight) session.popInFlight(seq);
      releaseQueue?.();
    }
  }

  /**
   * Global-scope debug listener registration. Returns the 409 body if this
   * registration conflicts with one already armed, `undefined` if it may arm.
   *
   * Live: a second global-scope listener for a user that already has one is
   * REJECTED with `409 AdiFailed` /
   * `conflictDetected` / `SY 530` — refuting the earlier note that a second
   * listener was silently accepted. A fresh `terminalId`/`ideId` did not
   * evade it. The scope at which this bites is configurable via
   * {@link FakeAdtOptions.listenerConflictScope} because it is still being
   * pinned down live.
   */
  private armListener(request: FakeRequest, session: SessionState): HttpClientResponse | undefined {
    const token = this.listenerScopeToken(request);
    if (token === undefined) return undefined;
    const existing = this.armedListenersInternal.get(token);
    if (existing === undefined || existing.poll.settled) return undefined;
    return listenerConflict409({ user: session.user });
  }
}

/** One client handle bound to one {@link FakeSession}. Implements the real `HttpClient` interface `abap-adt-api` expects. */
export class FakeAdtClient implements HttpClient {
  readonly server: FakeAdtServer;
  readonly session: FakeSession;
  private readonly sessionState: SessionState;

  constructor(server: FakeAdtServer, session: SessionState) {
    this.server = server;
    this.sessionState = session;
    this.session = session;
  }

  async request(options: HttpClientOptions): Promise<HttpClientResponse> {
    return this.server.dispatchRequest(this.sessionState, options);
  }

  /** Drop this handle's session: releases its locks immediately and kills its in-flight polls. */
  drop(): void {
    this.server.drop(this.sessionState.id);
  }
}

// ---------------------------------------------------------------------------
// BOPF (`src/adt/bopf.ts`) fakes
// ---------------------------------------------------------------------------
//
// This section is additive to the file above and follows the same
// "confirmed vs reconstructed" discipline. `src/adt/bopf.ts` is the module
// under test; nothing here imports it (this file stays feature-agnostic, the
// same choice `system-role-fake.ts` makes for its own `DATA_PREVIEW_PATH`) —
// the three constants below are hand-duplicated from it and must be kept in
// sync by eye if the source ones ever change.
//
// `BOPF_COLLECTION_PATH` is VERIFIED against real captures in
// `test/fixtures/bopf/*.xml` (see `test/bopf-xml.test.ts`). `BOPF_LOCK_ACCEPT`
// (capital-R `Result`) is asserted, not reconstructed here — bopf.ts's own doc
// comment on it cites a live wire verification. The bodies this section
// builds (`defaultBopfCreateBody`, activation success/failure shapes used by
// `test/bopf-client.test.ts`) are RECONSTRUCTED unless a test loads real bytes
// from `test/fixtures/bopf/` itself and calls `bopfStore().set(...)` with them.
//
// `BOPF_ACCEPT_V4` was NOT actually verified despite the comment
// that used to sit here: this hand-duplicated copy carried the exact same
// `sap.adt` (missing `ap.`) typo as the real constant in `src/adt/bopf.ts`,
// because someone copied the wrong value across, not the right one. Since
// this fake only ever used the string to stamp a response `content-type`
// (never to assert the incoming request's Accept header), the typo was
// invisible offline in both directions — the bug could only be caught by a
// server that actually validates the media type, i.e. the wire. Corrected
// live after a real 415 from A4H.

/** Duplicated from `src/adt/bopf.ts`'s `BOPF_COLLECTION`. */
export const BOPF_COLLECTION_PATH = "/sap/bc/adt/bopf/businessobjects";

/** Duplicated from `src/adt/bopf.ts`'s `BOPF_ACCEPT_V4`. */
export const BOPF_ACCEPT_V4 = "application/vnd.sap.ap.adt.bopf.businessobjects.v4+xml";

/** Duplicated from `src/adt/bopf.ts`'s `BOPF_LOCK_ACCEPT` (capital-R `Result` — case matters). */
export const BOPF_LOCK_ACCEPT = "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.Result";

/**
 * The exact LOCK-success envelope shape as {@link lockSuccessXml}, but with
 * `IS_LOCAL`/`CORRNR`/`CORRUSER` parameterised instead of hard-wired to the
 * always-local case. Needed because `transportFromLock` (`src/adt/write.ts`)
 * discriminates on exactly these three fields — `isLocal && !corrNr` reads
 * local, anything else reads transport-required — and the generic builtin
 * LOCK handler ({@link FakeAdtServer}'s private `routeLock`) only ever
 * answers the local case. A transport-pinned lock body can only be produced
 * by a custom route (see {@link bopfLockTransportRoute}), since custom routes
 * run before builtins.
 */
export function lockSuccessXmlTransport(opts: { handle: string; corrNr: string; corrUser?: string; corrText?: string }): string {
  const { handle, corrNr, corrUser = "", corrText = "" } = opts;
  return (
    `<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">` +
    `<asx:values><DATA><LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR><CORRUSER>${corrUser}</CORRUSER>` +
    `<CORRTEXT>${corrText}</CORRTEXT><IS_LOCAL/><IS_LINK_UP/><MODIFICATION_SUPPORT/><SCOPE_MESSAGES/></DATA></asx:values></asx:abap>`
  );
}

/**
 * A {@link FakeRoute} answering `?_action=LOCK` for exactly ONE BOPF object
 * path with a transport-pinned body (non-empty `CORRNR`, empty `IS_LOCAL`)
 * instead of the generic builtin's always-local one. Used by
 * `test/bopf-client.test.ts` to exercise the POST-lock transport
 * refusal in `putModel`/`deleteBusinessObject` (`transportFromLock`) — the
 * pre-lock refusal in `createBusinessObject` goes through
 * `SessionTransport.resolve()` instead and needs no server route at all (see
 * that test file's `pinnedTransport()` helper).
 *
 * Every LOCK for this path answers the same pinned body — there is no
 * "become local after N attempts" mode, because `putModel`'s retry loop is
 * expected to see the SAME transport pin on every attempt (a real transport
 * assignment does not evaporate between retries).
 */
export function bopfLockTransportRoute(opts: { name: string; corrNr: string; corrUser?: string; handle?: string }): FakeRoute {
  const path = `${BOPF_COLLECTION_PATH}/${opts.name.toLowerCase()}`;
  return (r) => {
    if (r.method !== "POST" || r.qs["_action"] !== "LOCK") return undefined;
    if (r.path !== path) return undefined;
    const handle = opts.handle ?? newLockHandle();
    return fakeResponse(200, lockSuccessXmlTransport({ handle, corrNr: opts.corrNr, corrUser: opts.corrUser }), {
      "content-type": LOCK_RESULT_CONTENT_TYPE,
    });
  };
}

/**
 * Minimal, real-shaped `bo:businessObject` v4 body for a just-created object
 * — the attribute subset `parseModel` (`src/adt/bopf-xml.ts`) needs, styled
 * after the REAL captured `test/fixtures/bopf/02-created-zbopf_prb1-root-only.v4.xml`
 * (root-node-only, `adtcore:version="inactive"`) but hand-assembled rather
 * than loaded from disk, since {@link bopfStore}'s default create response
 * has no fixed name to substitute into a fixture file at this layer. Tests
 * that want the REAL fixture bytes for a specific case should load the
 * fixture themselves and call `store.set(name, xml)` — this default only
 * covers the happy-path "create landed, now GET something plausible" case.
 *
 * Carries one root `bo:nodes` element named `ROOT` (`bo:rootNode="true"`),
 * matching the shape `bodyWithRootNode` (`test/bopf-create-recovery.test.ts`)
 * produces for an explicitly-named root. A real ADT read-back of a created
 * business object always carries a root node — a create response with no
 * `bo:nodes` element at all is not a shape the server produces, so this
 * default should not model one either; the no-root-node-at-all and
 * unnamed-root cases are exercised deliberately instead, via
 * `bodyWithNoRootNode(name)` and `bodyWithRootNode(name, "")` respectively
 * (both local to `test/bopf-create-recovery.test.ts`).
 */
export function defaultBopfCreateBody(name: string): string {
  const upper = name.toUpperCase();
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<bo:businessObject xmlns:bo="http://www.sap.com/wbobj/bopf/business_object" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${upper}" adtcore:type="BOBF" ` +
    `adtcore:version="inactive" adtcore:description="created by bopfStore">` +
    `<adtcore:packageRef adtcore:name="$TMP"/>` +
    `<bo:nodes bo:name="ROOT" bo:nodeID="Um9vdA==" bo:xmlName="Root" ` +
    `bo:objectModelGenerated="false" bo:authorizationCheck="false" bo:isExtensible="false" ` +
    `bo:isDependentObjectNode="false" bo:textNode="false" bo:createEnabled="true" ` +
    `bo:updateEnabled="true" bo:deleteEnabled="true" bo:rootNode="true" bo:objectModelObsolete="false"/>` +
    `</bo:businessObject>`
  );
}

/** One BOPF business object's state as tracked by {@link bopfStore}. */
export interface BopfStore {
  /** The route to add to `FakeAdtOptions.routes`. Handles GET/PUT/DELETE on `{BOPF_COLLECTION}/{name}` and POST to the bare collection (create). */
  readonly route: FakeRoute;
  /** Seed or overwrite an entry directly — e.g. with real fixture bytes. `name` is case-insensitive. */
  set(name: string, xml: string): void;
  get(name: string): string | undefined;
  has(name: string): boolean;
  /** The next `n` PUTs to ANY entry answer `invalidLockHandle423` instead of landing (models a stolen/expired handle for the relock-retry test). */
  failNextPuts(n: number): void;
  /**
   * The next `n` creates (POST to the bare collection) answer `opts.status`
   * (default 500, an `exc:exception` body) instead of a clean `201`.
   *
   * `opts.landed` (default `true`) controls whether the entry is still
   * written to the store despite the error response — this is the
   * create-landed-but-response-lost hazard itself: the create genuinely
   * happened server-side, but the response that would have told the caller
   * so was lost. Pass
   * `landed: false` for the (rarer, but real) double-failure case where the
   * create truly did not take, so `createBusinessObject`'s recovery `GET`
   * fails too and the ORIGINAL error must be what the caller sees.
   */
  failNextCreates(n: number, opts?: { status?: number; landed?: boolean }): void;
}

/**
 * A minimal, self-contained per-name backing store for
 * `GET/PUT/DELETE {BOPF_COLLECTION}/{name}` (v4 Accept) plus
 * `POST {BOPF_COLLECTION}` (create), as ONE {@link FakeRoute}.
 *
 * This does NOT reuse the generic builtin PUT/GET (`sourceStore`) even though
 * that builtin already accepts any lock-handle-bearing PUT and serves it back
 * on a matching-path GET: `bopfStore` needs `failNextPuts`/`failNextCreates`
 * injection points the generic builtin has no hook for, and keeping BOPF
 * entirely self-contained means a test composing `bopfStore()` with a
 * transport-pinned LOCK route (see {@link bopfLockTransportRoute}) does not
 * have to reason about which private field of `FakeAdtServer` "wins".
 *
 * Deliberately does NOT check the request's `Accept` header beyond requiring
 * it to mention the v4 media type on GET — if `bopf.ts` ever sent the wrong
 * Accept, this route would answer `undefined` (not "mine"), the request would
 * fall through to the builtin/catchAll, and — since nothing else claims this
 * path — end up as `FakeAdtProtocolError: Unrouted request`, which is exactly
 * the loud failure a silent-wrong-verdict hazard should produce in a
 * test, rather than a green test that never actually checked the header. The
 * more direct check in `test/bopf-client.test.ts` reads `server.calls`
 * directly for the exact Accept string sent, which this route's silence
 * alone cannot distinguish from "never called".
 */
export function bopfStore(seed: Record<string, string> = {}): BopfStore {
  const entries = new Map<string, string>(Object.entries(seed).map(([k, v]) => [k.toLowerCase(), v]));
  let putFailures = 0;
  let createFailures = 0;
  let createFailStatus = 500;
  let createFailLanded = true;

  const route: FakeRoute = (r, server) => {
    const isCollectionRoot = r.path === BOPF_COLLECTION_PATH;
    const isEntryPath = r.path.startsWith(`${BOPF_COLLECTION_PATH}/`) && !r.path.includes("$search");

    if (r.method === "POST" && isCollectionRoot) {
      const m = /adtcore:name="([^"]+)"/.exec(r.body ?? "");
      const name = m?.[1];
      if (!name) return fakeResponse(400, `<exc:exception><type id="ExceptionParameterNotFound"/></exc:exception>`, {});
      const lower = name.toLowerCase();
      if (createFailures > 0) {
        createFailures -= 1;
        // The create can genuinely land server-side even though the
        // response that would say so is lost — see `failNextCreates`'s doc.
        if (createFailLanded && !entries.has(lower)) entries.set(lower, defaultBopfCreateBody(name));
        return fakeResponse(createFailStatus, `<exc:exception><type id="ExceptionSystemError"/></exc:exception>`, {
          "content-type": "application/xml",
        });
      }
      if (!entries.has(lower)) entries.set(lower, defaultBopfCreateBody(name));
      return fakeResponse(201, "", { "content-length": "0", location: `${BOPF_COLLECTION_PATH}/${lower}` });
    }

    if (!isEntryPath) return undefined;
    const name = r.path.slice(BOPF_COLLECTION_PATH.length + 1).toLowerCase();

    if (r.method === "GET") {
      const accept = String(r.headers["accept"] ?? "");
      if (!accept.includes("bopf.businessobjects.v4")) return undefined;
      const xml = entries.get(name);
      if (xml === undefined) {
        return fakeResponse(404, `<exc:exception><type id="ExceptionResourceNotFound"/><message lang="EN">${name} does not exist</message></exc:exception>`, {
          "content-type": "application/xml",
        });
      }
      return fakeResponse(200, xml, { "content-type": `${BOPF_ACCEPT_V4}; charset=utf-8` });
    }

    if (r.method === "PUT") {
      const handle = r.qs["lockHandle"];
      if (typeof handle !== "string" || handle === "") return missingLockHandle400();
      if (putFailures > 0) {
        putFailures -= 1;
        // Model the captured real behaviour relock.ts relies on: a failed PUT
        // already kills the enqueue server-side (see `releaseLockSilently`'s
        // doc comment) — without this, the fake's OWN lock table would still
        // show this handle's session holding the object, and the retry's
        // fresh `session.lock()` would collide with itself instead of
        // cleanly re-acquiring, which is not the hazard this route exists to
        // reproduce.
        server.releaseLockSilently(r.path);
        return invalidLockHandle423({ objectName: name.toUpperCase(), handle });
      }
      entries.set(name, r.body ?? entries.get(name) ?? "");
      return EMPTY_200();
    }

    if (r.method === "DELETE") {
      const handle = r.qs["lockHandle"];
      if (typeof handle !== "string" || handle === "") return missingLockHandle400();
      entries.delete(name);
      return EMPTY_200();
    }

    return undefined;
  };

  return {
    route,
    set: (name, xml) => entries.set(name.toLowerCase(), xml),
    get: (name) => entries.get(name.toLowerCase()),
    has: (name) => entries.has(name.toLowerCase()),
    failNextPuts: (n) => {
      putFailures = n;
    },
    failNextCreates: (n, opts = {}) => {
      createFailures = n;
      createFailStatus = opts.status ?? 500;
      createFailLanded = opts.landed ?? true;
    },
  };
}

/**
 * A {@link FakeRoute} for a single DDIC existence-probe path: answers
 * `200` (empty-ish body — only existence is checked by the caller) when the
 * request's `Accept` header is the literal `*\/*` bopf.ts always sends for
 * these probes, and is deliberately silent (`undefined`, "not mine") for any
 * OTHER Accept — the same "wrong header ⇒ unrouted, not a wrong verdict"
 * discipline as {@link bopfStore}. `exists: false` answers `404` instead,
 * still only for a `*\/*` Accept, so a wrong-Accept request against a
 * genuinely-missing object is equally distinguishable from a real 404.
 *
 * Stateful, same discipline as {@link bopfStore}: `opts.exists` is only the
 * STARTING state. A successful `DELETE` flips it to absent, so a subsequent
 * `GET` (e.g. `deleteDdicCandidate`'s own post-delete read-back)
 * answers `404` from then on — a test that wants to reproduce the "DELETE
 * succeeded but the object still reads back" hazard must build its own
 * custom {@link FakeRoute} rather than weaken this one back to stateless.
 */
export function ddicProbeRoute(opts: { uri: string; exists: boolean }): FakeRoute {
  let exists = opts.exists;
  return (r) => {
    if (r.path !== opts.uri) return undefined;
    const accept = String(r.headers["accept"] ?? "");
    if (accept !== "*/*") return undefined;
    if (r.method === "GET") {
      return exists
        ? fakeResponse(200, `<tabl:table xmlns:tabl="http://www.sap.com/wbobj/tables"/>`, { "content-type": "application/xml" })
        : fakeResponse(404, `<exc:exception><type id="ExceptionResourceNotFound"/></exc:exception>`, { "content-type": "application/xml" });
    }
    if (r.method === "DELETE") {
      const handle = r.qs["lockHandle"];
      if (typeof handle !== "string" || handle === "") return missingLockHandle400();
      exists = false;
      return EMPTY_200();
    }
    return undefined;
  };
}

/**
 * A {@link FakeRoute} for one class's source endpoint
 * (`/sap/bc/adt/oo/classes/{name}/source/main`, `Accept: text/plain` — the
 * existence test `checkReferences`'s `evaluateClassRef` actually uses, via
 * `readCurrentSource`). `body: undefined` answers `404` (class does not
 * exist as a source artifact); a defined body is returned verbatim, letting
 * the caller construct "exists but declaration-only" (no `IMPLEMENTATION`
 * substring) or "exists and implements" fixtures directly.
 */
export function classSourceRoute(opts: { name: string; body: string | undefined }): FakeRoute {
  // CORRECTED live: namespaced class
  // names (`/BOBF/CL_LIB_A_LOCK`) need their leading/embedded slashes
  // percent-encoded — `encodeURIComponent`, matching what `evaluateClassRef`
  // (src/adt/bopf.ts) actually sends. This route used to match the raw,
  // unencoded path, which is what the module's OLD (buggy) URI-builder sent
  // — the fake and the bug matched each other, so this stayed green while
  // A4H 404'd the real request every time. A live probe against
  // `/sap/bc/adt/oo/classes/%2Fbobf%2Fcl_lib_a_lock/source/main` confirmed
  // 200 with real source; the unencoded `//bobf/cl_lib_a_lock` variant 404s.
  const uri = `/sap/bc/adt/oo/classes/${encodeURIComponent(opts.name.toLowerCase())}/source/main`;
  return (r) => {
    if (r.path !== uri || r.method !== "GET") return undefined;
    const accept = String(r.headers["accept"] ?? "");
    if (!accept.includes("text/plain")) return undefined;
    if (opts.body === undefined) {
      return fakeResponse(404, `<exc:exception><type id="ExceptionResourceNotFound"/></exc:exception>`, {
        "content-type": "application/xml",
      });
    }
    return fakeResponse(200, opts.body, { "content-type": "text/plain; charset=utf-8" });
  };
}

/**
 * A {@link FakeRoute} for `POST /sap/bc/adt/activation` — the exact wire
 * contract `abap-adt-api`'s `activate()` uses (verified by reading
 * `node_modules/abap-adt-api/build/api/activate.js`: `qs: {method:
 * "activate", preauditRequested}`, response body XML-parsed for
 * `chkl:messages/msg` and `ioc:inactiveObjects/ioc:entry`, `success=false` if
 * any inactive entry exists or any message's `type` matches `/[EAX]/`).
 *
 * `body: undefined` (the default) reproduces the CLEAN-success shape: `200`,
 * zero-byte body — this IS verified live (module header of `src/adt/activate.ts`
 * and `test/bopf-runtime.test.ts`'s `bridgeHappyPath`'s
 * `resp(200, "", {"content-length":"0"})` for the same endpoint). A non-empty
 * `body` is RECONSTRUCTED — no captured `chkl:messages`-with-`type="E"` body
 * was found anywhere in this repo's fixtures — built from the shape
 * `activate.js` itself parses (`xmlArray(raw, "chkl:messages", "msg")`,
 * `m.shortText.txt` or the literal fallback `"Syntax error"`).
 */
export function activationRoute(opts: { uri?: string; body?: string }): FakeRoute {
  return (r) => {
    if (r.path !== "/sap/bc/adt/activation" || r.method !== "POST") return undefined;
    if (opts.uri && !(r.body ?? "").includes(opts.uri)) return undefined;
    return fakeResponse(200, opts.body ?? "", opts.body ? { "content-type": "application/xml" } : { "content-length": "0" });
  };
}

/**
 * RECONSTRUCTED (no captured example found in this repo's fixtures) —
 * `chkl:messages` body shape for an activation that reports a hard syntax
 * error against `uri`, styled after what `activate.js` itself parses
 * (see {@link activationRoute}'s doc comment for the exact fields read).
 */
export function activationFailureXml(opts: { uri: string; text?: string }): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">` +
    `<msg objDescr="" type="E" line="1" href="${opts.uri}">` +
    `<shortText><txt>${opts.text ?? "Syntax error"}</txt></shortText>` +
    `</msg></chkl:messages>`
  );
}
