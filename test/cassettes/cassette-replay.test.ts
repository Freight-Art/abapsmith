/**
 * Cassette replay.
 *
 * Proves the core claim of the whole cassette mechanism: a `FakeRoute`
 * GENERATED from a cassette (`generate-fake-routes.ts`) reproduces that
 * cassette's real, wire-captured response byte-for-byte when fed the exact
 * request the cassette recorded. Without this, "generate the fake from
 * cassettes" is just an assertion; this file is the evidence.
 *
 * The `it.each` loop below is driven directly by `loadAllCassettes()`, so
 * EVERY cassette committed under `test/cassettes/**\/*.cassette.json` is
 * automatically replayed here with no per-cassette wiring required. That is
 * also what makes "dead cassette" detection in `cassette-lint.test.ts`
 * meaningful: that file greps this file's own source for each cassette id
 * and fails loudly if one is missing — which can only happen if this loop
 * stops being wired to `loadAllCassettes()`, not if a cassette is merely
 * added to disk (this loop already covers it automatically).
 */
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FakeAdtServer } from "../helpers/fake-adt.js";
import { generateFakeRoutesFromCassettes } from "./generate-fake-routes.js";
import { loadAllCassettes } from "./registry.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const CASSETTE_FILE_SUFFIX = ".cassette.json";

/**
 * Deliberately its own directory walk rather than importing anything from
 * `registry.ts` — this test wants a path back to the file a given cassette
 * `id` came from (to check `id` really is that file's own slug), which is
 * orthogonal to what `registry.ts`'s public API needs to expose.
 */
function walkCassetteFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) found.push(...walkCassetteFiles(full));
    else if (stat.isFile() && entry.endsWith(CASSETTE_FILE_SUFFIX)) found.push(full);
  }
  return found;
}

function slugFromFile(file: string): string {
  const base = basename(file);
  return base.slice(0, base.length - CASSETTE_FILE_SUFFIX.length);
}

/**
 * HTTP headers are case-insensitive on the wire; a cassette that (by capture
 * bug or hand-edit) carries two headers whose names differ only by case would
 * have one silently shadow the other the moment anything lower-cases keys
 * (which `fake-adt.ts`'s own request builder does for incoming headers). This
 * returns every such collision found, keyed by the original casing so a
 * failure message can name the exact culprits.
 */
function caseInsensitiveHeaderCollisions(headers: Readonly<Record<string, string>>): string[] {
  const seenByLowerKey = new Map<string, string>();
  const collisions: string[] = [];
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    const prior = seenByLowerKey.get(lower);
    if (prior !== undefined) {
      collisions.push(`"${key}" collides case-insensitively with "${prior}"`);
    } else {
      seenByLowerKey.set(lower, key);
    }
  }
  return collisions;
}

const cassettes = loadAllCassettes();
const slugToFile = new Map(walkCassetteFiles(THIS_DIR).map((file) => [slugFromFile(file), file]));

/**
 * Explicit, literal manifest of every cassette id this file's `it.each` loop
 * is expected to cover.
 *
 * The loop above is already generic — it iterates `cassettes`, so a NEW
 * cassette file is picked up automatically without touching this file at
 * all. This manifest is not what makes replay work; it exists purely so
 * `cassette-lint.test.ts`'s dead-cassette check has literal id STRINGS to
 * find by scanning this file's own source text (`.includes(cassette.id)`) —
 * a check that, by design, cannot see through the generic loop above, since
 * `cassette.id` values only exist there at runtime, not as source text.
 *
 * The self-check immediately below keeps this list from silently drifting:
 * add a cassette file and forget to list its id here, and THIS suite fails
 * immediately, before cassette-lint's independent scan would have caught it
 * too. Two independent tripwires for the same failure mode is deliberate,
 * not redundant — cassette-lint's scan protects against this exact list
 * being wrong even when whoever edited it also (incorrectly) edited the
 * self-check to match.
 */
const COVERED_CASSETTE_IDS = [
  "attach-session-bootstrap",
  "bp-reject-inband",
  "bp-set-accepted",
  "class-lock-post",
  "csrf-required-403",
  "csrf-required-403-followup-verify",
  "csrf-token-fetch",
  "datapreview-select-success",
  "ddic-cds-with-parameters-inband-message",
  "ddic-injection-boolean-expression-400",
  "ddic-injection-where-executed-200",
  "ddic-namespaced-name-30-chars",
  "ddic-svers-single-column-single-row",
  "ddic-t000-rows3",
  "ddic-table-not-found-400",
  "listener-conflict-409",
  "listener-hit-debuggee",
  "stack-read",
  "trigger-classrun-500-html",
] as const;

// Generated ONCE for the whole suite, from every cassette on disk — mirrors
// how a real consumer would build the table once and reuse it across
// requests, and proves routes generated from OTHER cassettes never
// accidentally answer for this one (see generate-fake-routes.ts's doc
// comment on why method+path alone is not a safe match key).
const routes = generateFakeRoutesFromCassettes(cassettes);

describe("cassette replay", () => {
  it("loaded at least one cassette (a suite of zero would pass every it.each vacuously)", () => {
    expect(cassettes.length).toBeGreaterThan(0);
  });

  it("COVERED_CASSETTE_IDS manifest exactly matches the ids loadAllCassettes() actually returned", () => {
    const actualIds = cassettes.map((c) => c.id).sort();
    const manifestIds = [...COVERED_CASSETTE_IDS].sort();
    expect(manifestIds).toEqual(actualIds);
  });

  it.each(cassettes)(
    "cassette $id: id matches its file, shapes are internally consistent, and its generated route replays it faithfully",
    async (cassette) => {
      // --- id <-> file identity -------------------------------------------
      const file = slugToFile.get(cassette.id);
      expect(file, `no cassette file on disk has a slug equal to id "${cassette.id}"`).toBeDefined();

      // --- internal shape consistency -------------------------------------
      // Schema validation (inside loadAllCassettes) already guarantees these
      // bounds; re-asserted here as a functional check of the loaded value
      // itself, independent of trusting that validation silently ran.
      expect(cassette.response.status).toBeGreaterThanOrEqual(100);
      expect(cassette.response.status).toBeLessThanOrEqual(599);
      expect(Number.isInteger(cassette.response.status)).toBe(true);

      expect(caseInsensitiveHeaderCollisions(cassette.request.headers)).toEqual([]);
      expect(caseInsensitiveHeaderCollisions(cassette.response.headers)).toEqual([]);

      // --- faithful replay through the generated route --------------------
      // `longPollMatcher: () => false` is required here, not cosmetic: two
      // real cassettes (`listener-conflict-409`, `listener-hit-debuggee`) hit
      // `POST /sap/bc/adt/debugger/listeners`, which fake-adt.ts's DEFAULT
      // long-poll matcher intercepts BEFORE custom routes ever run (it parks
      // the request as a pending poll instead of calling `route()`). Cassette
      // routes are meant to answer immediately with the exact recorded bytes,
      // not participate in the fake's long-poll machinery, so long-poll
      // detection is disabled for this replay.
      const server = new FakeAdtServer({ routes, longPollMatcher: () => false });
      const client = server.client();

      const response = await client.request({
        method: cassette.request.method,
        url: cassette.request.path,
        headers: cassette.request.headers,
        body: cassette.request.body ?? undefined,
      });

      expect(response.status).toBe(cassette.response.status);
      // HttpClientResponse.body is non-nullable `string`; a cassette's `null`
      // body (genuinely empty) is generated as `""` by generate-fake-routes.ts
      // — same mapping applied here so this is still an exact-equality check.
      expect(response.body).toBe(cassette.response.body ?? "");
    },
  );
});

describe("cassette replay: an unrecorded request is refused explicitly when no builtin answers it", () => {
  it("a GET with no matching cassette route and no matching builtin route throws FakeAdtProtocolError", async () => {
    const server = new FakeAdtServer({ routes, longPollMatcher: () => false });
    const client = server.client();

    await expect(
      client.request({
        method: "GET",
        url: "/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=ZZZ_NO_SUCH_OBJECT*",
        headers: {},
      }),
    ).rejects.toThrow(/Unrouted request/);
  });
});

// `route()` (fake-adt.ts:1765) tries customRoutes, then routeBuiltin, then
// catchAllRoute, and only THEN records `unrouted-request` and throws.
// LOCK/UNLOCK/PUT are unconditional builtins (routeBuiltinBody,
// fake-adt.ts:1692), so an unrecorded request of these shapes never reaches
// that throw — migrating them onto cassette-derived routes is explicitly
// out of scope (cassette-lint.test.ts:186-247).
describe("cassette replay: the builtin tier answers unrecorded LOCK/UNLOCK/PUT rather than refusing them", () => {
  const NO_SUCH_CLASS_URI = "/sap/bc/adt/oo/classes/zzz_no_such_class";

  it("LOCK on an unrecorded object is answered with a synthesized handle, not refused", async () => {
    const server = new FakeAdtServer({ routes, longPollMatcher: () => false });
    const client = server.client();

    const response = await client.request({
      method: "POST",
      url: `${NO_SUCH_CLASS_URI}?_action=LOCK&accessMode=MODIFY`,
      headers: {},
    });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(
      "application/vnd.sap.as+xml; charset=utf-8; dataname=com.sap.adt.lock.Result",
    );
    expect(response.body).toMatch(/<LOCK_HANDLE>[^<]+<\/LOCK_HANDLE>/);
    expect(server.violations.some((v) => v.kind === "unrouted-request")).toBe(false);
  });

  it("UNLOCK with a handle the server never issued is answered 200 with an empty body, and flagged as a violation", async () => {
    const server = new FakeAdtServer({ routes, longPollMatcher: () => false });
    const client = server.client();

    const response = await client.request({
      method: "POST",
      url: `${NO_SUCH_CLASS_URI}?_action=UNLOCK&lockHandle=GARBAGE_HANDLE`,
      headers: {},
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("");
    expect(server.violations.some((v) => v.kind === "unlock-garbage-handle-accepted")).toBe(true);
    expect(server.violations.some((v) => v.kind === "unrouted-request")).toBe(false);
  });

  it("PUT .../source/main with a lock handle the server never issued comes back 423, not refused", async () => {
    const server = new FakeAdtServer({ routes, longPollMatcher: () => false });
    const client = server.client();

    const response = await client.request({
      method: "PUT",
      url: `${NO_SUCH_CLASS_URI}/source/main?lockHandle=GARBAGE_HANDLE`,
      headers: {},
      body: "class zzz_no_such_class definition.\nendclass.",
    });

    expect(response.status).toBe(423);
    expect(server.violations.some((v) => v.kind === "unknown-lock-handle")).toBe(true);
    expect(server.violations.some((v) => v.kind === "unrouted-request")).toBe(false);
  });
});
