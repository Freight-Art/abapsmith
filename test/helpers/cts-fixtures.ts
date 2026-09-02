/**
 * Shared loader for the raw-wire CTS fixtures under `test/fixtures/cts/`.
 *
 * Each fixture is a pair: `<name>.meta.json` (request/response envelope) plus
 * a sibling body file (`.xml` or `.txt`) named by `meta.bodyFile`. These were
 * captured live against A4H — see `src/adt/transports.ts`'s module doc for why
 * that mattered (three findings the obvious reading of the wire got wrong).
 *
 * Byte fidelity is the whole point of this fixture set, so every body is read
 * with its own `readFileSync` call, as raw bytes, decoded explicitly — never
 * batch-slurped, never pre-parsed, never whitespace-normalised. A body that
 * has been silently reformatted by an editor is exactly the failure mode this
 * loader's length check exists to catch.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fromResponse } from "abap-adt-api/build/AdtException.js";

import type { AbapConnection, RawResponse } from "../../src/adt/connection.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cts");

// ---------------------------------------------------------------------------
// Fixture meta shape
// ---------------------------------------------------------------------------

/** The HTTP verbs `AbapConnection`'s raw helpers issue. */
export type CtsHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/**
 * `<name>.meta.json` as captured. Fields present on every fixture:
 * `method`..`bodyBytes`. `errorName`/`errorMessage` are only present when
 * `threw` is `true` (see `create-object-error-corrnr-not-found.meta.json` vs.
 * `transport-details-nonexistent-error.meta.json`, which throws but omits
 * both — do not assume they always accompany a throw).
 */
export interface CtsFixtureMeta {
  method: CtsHttpMethod;
  url: string;
  /** `null` when the request carried no query string, `{}` when it carried an empty one. */
  qs: Record<string, string> | null;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  status: number;
  statusText: string;
  responseHeaders: Record<string, string>;
  /** True when the ADT client threw for this call rather than resolving normally. */
  threw: boolean;
  errorName?: string;
  errorMessage?: string;
  /** Sibling body file, relative to this fixture's own directory. */
  bodyFile: string;
  /** Byte length of `bodyFile` at capture time — the loader's tripwire. */
  bodyBytes: number;
}

/** A fixture's parsed meta plus its raw body, decoded as UTF-8. */
export interface LoadedCtsFixture {
  meta: CtsFixtureMeta;
  body: string;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load one fixture by name (no extension, e.g. `"transport-release-success"`).
 *
 * The meta file and the body file are each read with their own `readFileSync`
 * call. The body is read with no encoding argument (raw `Buffer`) so its byte
 * length can be checked against `meta.bodyBytes` BEFORE decoding — comparing
 * decoded-string `.length` would silently pass through the exact class of
 * corruption (line-ending rewrite, BOM, re-encoding) this check exists to
 * catch. Only after that check passes is the buffer decoded to a string.
 */
export function loadCtsFixture(name: string): LoadedCtsFixture {
  const metaPath = join(FIXTURES_DIR, `${name}.meta.json`);
  let metaBuf: Buffer;
  try {
    metaBuf = readFileSync(metaPath);
  } catch (e) {
    throw new Error(
      `cts fixture "${name}": could not read ${metaPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  let meta: CtsFixtureMeta;
  try {
    meta = JSON.parse(metaBuf.toString("utf8")) as CtsFixtureMeta;
  } catch (e) {
    throw new Error(
      `cts fixture "${name}": ${metaPath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const bodyPath = join(FIXTURES_DIR, meta.bodyFile);
  let bodyBuf: Buffer;
  try {
    bodyBuf = readFileSync(bodyPath);
  } catch (e) {
    throw new Error(
      `cts fixture "${name}": could not read body file ${bodyPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (bodyBuf.length !== meta.bodyBytes) {
    throw new Error(
      `cts fixture "${name}": body file ${meta.bodyFile} is ${bodyBuf.length} bytes on disk, ` +
        `but ${metaPath} records bodyBytes=${meta.bodyBytes}. The body was likely reformatted ` +
        `(line endings, trailing newline, re-encoding) — re-capture the fixture rather than ` +
        `hand-editing it.`,
    );
  }

  return { meta, body: bodyBuf.toString("utf8") };
}

/**
 * Every fixture name available under `test/fixtures/cts/`, sorted. Lets a
 * test assert that every captured fixture is exercised by something, rather
 * than a new capture silently going unused.
 */
export function listCtsFixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".meta.json"))
    .map((f) => f.slice(0, -".meta.json".length))
    .sort();
}

// ---------------------------------------------------------------------------
// Fake AbapConnection that replays fixtures
// ---------------------------------------------------------------------------

/** One call recorded against the fake connection. */
export interface RecordedCall {
  method: CtsHttpMethod;
  url: string;
  qs?: Record<string, string>;
  body?: string;
  headers?: Record<string, string>;
}

/**
 * A scripted step: either a loaded fixture (replayed verbatim — `threw`
 * decides whether the call resolves or throws) or a hand-built raw response,
 * for the rare case a test needs a response with no captured fixture behind
 * it.
 */
export type CtsScriptStep =
  | LoadedCtsFixture
  | { status: number; body: string; headers?: Record<string, unknown> };

function isLoadedFixture(step: CtsScriptStep): step is LoadedCtsFixture {
  return (
    typeof step === "object" &&
    step !== null &&
    "meta" in step &&
    typeof (step as LoadedCtsFixture).meta === "object"
  );
}

export interface FakeCtsConnection {
  /** Duck-typed `AbapConnection` — pass to `trShow`, `trRelease`, `trDelete`, etc. */
  conn: AbapConnection;
  /** Every `get`/`post`/`put`/`del` call made against `conn`, in order. */
  calls: RecordedCall[];
  /** Throws (naming the leftover steps) if the script was not fully consumed. */
  assertExhausted(): void;
}

/** Optional `conn.adt.searchObject` stub, for tests exercising a locked-entry existence probe. */
export type FakeSearchObject = (
  name: string,
  kind: string | undefined,
  max: number,
) => Promise<Array<Record<string, unknown>>>;

/**
 * Build a fake `AbapConnection` that replays a fixed sequence of steps —
 * fixtures or raw responses — instead of doing HTTP, and records every call
 * made against it.
 *
 * Steps are consumed strictly in order across ALL verbs (not queued
 * per-method): `trDelete`'s read → delete → re-read and `trRelease`'s
 * release → re-read are each a single ordered sequence of calls, and this
 * mirrors that rather than pretending GET and DELETE have independent
 * queues.
 *
 * A call made after the script is exhausted throws immediately, naming the
 * call that had nothing left to answer it — that is the "no unexpected extra
 * calls" guarantee in its strict form. `assertExhausted()` is the converse
 * check: that nothing scripted was left unconsumed.
 */
export function fakeCtsConnection(
  steps: ReadonlyArray<CtsScriptStep>,
  searchObject?: FakeSearchObject,
): FakeCtsConnection {
  const queue = steps.slice();
  const calls: RecordedCall[] = [];

  async function handle(
    method: CtsHttpMethod,
    url: string,
    opts: { headers?: Record<string, string>; qs?: Record<string, string>; body?: string } = {},
  ): Promise<RawResponse> {
    calls.push({ method, url, qs: opts.qs, body: opts.body, headers: opts.headers });

    const step = queue.shift();
    if (!step) {
      throw new Error(
        `fakeCtsConnection: no scripted response left for ${method} ${url} ` +
          `(this was call #${calls.length}, and the script had ${calls.length - 1} step(s)).`,
      );
    }

    if (isLoadedFixture(step)) {
      const { meta, body } = step;
      if (meta.threw) {
        throw fromResponse(body, {
          status: meta.status,
          statusText: meta.statusText,
          headers: meta.responseHeaders,
          body,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
      }
      return { body, status: meta.status, headers: meta.responseHeaders };
    }

    return { body: step.body, status: step.status, headers: step.headers ?? {} };
  }

  const conn = {
    // `resolveObject`'s `finish()` (src/adt/resolve.ts) reads `conn.cfg.sid`
    // unconditionally to stamp a resolved object's `system` field — that is
    // the only field any code path reachable through this fake reads off
    // `.cfg` (checked: adt/undo.ts, adt/connection.ts etc. also read
    // `.url`/`.client`, but nothing on the fixture-replay paths this fake
    // serves reaches those). A minimal stub is enough.
    cfg: { sid: "A4H" },
    get: (url: string, opts?: { headers?: Record<string, string>; qs?: Record<string, string> }) =>
      handle("GET", url, opts),
    post: (
      url: string,
      opts?: { headers?: Record<string, string>; qs?: Record<string, string>; body?: string },
    ) => handle("POST", url, opts),
    put: (
      url: string,
      opts: { headers?: Record<string, string>; qs?: Record<string, string>; body: string },
    ) => handle("PUT", url, opts),
    del: (url: string, opts?: { headers?: Record<string, string>; qs?: Record<string, string> }) =>
      handle("DELETE", url, opts),
    // Left absent by default (exercises the "unknown" probe path); a test that
    // needs a locked-entry existence probe to actually resolve passes one in.
    ...(searchObject ? { adt: { searchObject } } : {}),
  } as unknown as AbapConnection;

  return {
    conn,
    calls,
    assertExhausted(): void {
      if (queue.length > 0) {
        throw new Error(
          `fakeCtsConnection: ${queue.length} scripted step(s) were never consumed ` +
            `(${calls.length} call(s) were made).`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// trList response builders
// ---------------------------------------------------------------------------

/**
 * A synthetic `trList` response with one `tm:workbench` category holding the given
 * `tm:request` entries directly (no `tm:modifiable`/`tm:released` status-group wrapper —
 * `collectRequests` in `src/adt/transports.ts` recurses through any nesting, so the flat
 * shape is equivalent and shorter). Mirrors the real captured shape's attribute names.
 */
export function trListWorkbenchBody(entries: string): CtsScriptStep {
  return {
    status: 200,
    body:
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm">` +
      `<tm:workbench>${entries}</tm:workbench>` +
      `</tm:root>`,
  };
}

/** One `tm:request` entry for {@link trListWorkbenchBody}. `type`: `K` = workbench, `W` = customizing. `status`: `D` = modifiable, `R` = released. */
export function trListRequest(opts: {
  trkorr: string;
  desc: string;
  type?: string;
  status?: string;
  owner?: string;
}): string {
  return (
    `<tm:request tm:number="${opts.trkorr}" tm:owner="${opts.owner ?? "DEVELOPER"}" ` +
    `tm:desc="${opts.desc}" tm:type="${opts.type ?? "K"}" tm:status="${opts.status ?? "D"}"/>`
  );
}
