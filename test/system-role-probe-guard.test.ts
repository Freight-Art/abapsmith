/**
 * STRUCTURAL GUARD — every suite that builds a connection config must DECLARE
 * what system its fake stands for.
 *
 * ## The defect this exists to catch
 *
 * `AbapConnection.connect()` runs `detectSystemRole()`, which POSTs once to
 * `/sap/bc/adt/datapreview/freestyle` and reads `T000-CCCATEGORY`. It is
 * fail-closed: a fake that does not answer that route makes the verdict
 * `inconclusive`, and `inconclusive` locks writes out in a way
 * `ABAP_ALLOW_WRITE` deliberately CANNOT override.
 *
 * The consequence is silent and severe. A safety test on such a connection
 * still goes green — but it went green because the LOCKOUT refused, not because
 * the GATE refused. "Something refused" is much weaker than what the test's
 * name promises, and the difference is invisible in the output. Three real
 * defects this wave came from exactly this, including a test that was green
 * while the product told users to set `ABAP_ALLOW_WRITE` — a flag that would
 * not have helped, because the real cause was the lockout. A green test was
 * certifying false advice.
 *
 * ## What is being enforced (and what is NOT)
 *
 * The rule is NOT "never hit the lockout". The lockout is legitimate behaviour and
 * deliberate fail-closed suites must keep exercising it. The rule is INTENT
 * DECLARATION: a suite either answers the probe (`routeSystemRoleProbe` from
 * `test/helpers/system-role-fake.ts`, or its own inline route), or it appears
 * below with a written justification.
 *
 * ## The allow-list is expected to SHRINK
 *
 * On the day this guard landed the allow-list held **8** entries, out of
 * **17** suites that build a connection config (**9** already routed the
 * probe). Of those 8, only ONE — `circuit-breaker.test.ts` — is a deliberate
 * fail-closed suite that should still be here in a year. Two more
 * (`integration.test.ts`, `integration-undo.test.ts`) are live suites with no
 * fake to route and will never leave either. The remaining five are suites
 * whose assertions happen not to depend on the verdict today; each is a repair
 * waiting to happen, and each repair should DELETE its entry. The target is
 * therefore THREE. If a later reader finds this list still holding 8, that is
 * the finding: it has not moved.
 *
 * ### Ceiling bump: the FPM/FBI config-lock protocol
 *
 * `integration-fpm-lock.test.ts` joined the allow-list as a NINTH entry — not
 * shrinkage-debt, a fourth PERMANENT member in the same category as
 * `integration.test.ts`/`integration-undo.test.ts`: a live suite gated on
 * `ABAP_URL`/`ABAP_ALLOW_WRITE` that talks to the real appliance and has no
 * fake to route the probe through. `ALLOWLIST_SIZE_AT_LANDING` stays **8** as
 * the honest historical fact; `ALLOWLIST_CEILING` below is the number the
 * live check actually enforces, and it is now **9**. The five repairable
 * entries and the shrink-to-THREE target are unchanged and unaffected — bump
 * `ALLOWLIST_CEILING` again, with the same one-permanent-suite justification,
 * if and when a genuine fifth permanent member shows up; shrink it back down
 * if this entry is ever repaired instead.
 *
 * ### Ceiling bump: the CCAU / ABAP Unit acceptance suite
 *
 * `integration-class-includes.test.ts` joined as a TENTH entry, under exactly
 * the clause above: a genuine FIFTH permanent member, same category as
 * `integration.test.ts` / `integration-undo.test.ts` / `integration-fpm-lock.test.ts`.
 * It is a live suite (self-gated on `VITEST_LIVE=1` **and** `ABAP_URL` **and**
 * `ABAP_ALLOW_WRITE`) that writes a local test class into a real class's CCAU
 * include on the real appliance and then runs ABAP Unit over it. There is no
 * fake in the file to route a probe through, and the real system answers the
 * T000 probe itself. `ALLOWLIST_SIZE_AT_LANDING` still stays **8** — the
 * historical fact does not move — and `ALLOWLIST_CEILING` was **10**. This
 * is NOT shrinkage-debt: the five repairable entries and the shrink-to-THREE
 * target are unchanged, and this entry must be deleted (and the ceiling
 * dropped) if the suite ever stops connecting for real.
 *
 * ### Ceiling bump: the object-lock config-plumbing suites
 *
 * `object-gate-config-equivalence.test.ts` and `pool-cross-process-object-gate.test.ts`
 * joined as an ELEVENTH and TWELFTH entry when work moved
 * `ABAP_CROSS_PROCESS_OBJECT_LOCK`/`ABAP_OBJECT_LOCK_WAIT_MS` into `ConfigSchema`
 * (the same plumbing already done for the debug-lock pair). Both are
 * a DIFFERENT permanent shape from the four entries above: not a live suite with
 * no fake, but a suite that is structurally incapable of ever reaching the probe —
 * neither file's tests call `.connect()` or `.withWrite()` anywhere, so there is
 * no path to `/datapreview/freestyle` to route in the first place. Each got
 * flagged only because it calls the real `loadConfig()` (needed to prove the new
 * schema fields reach the gate/pool with production's exact code path, not a
 * hand-typed `Config` double) and, in the equivalence file's case, also imports
 * `resolveCrossProcessObjectLock`/`resolveObjectLockWaitMs` from
 * `src/adt/object-gate.ts` for the equivalence proof itself — one import past
 * what the mechanical config-only exemption allows, even though `object-gate.ts`
 * imports nothing connection-shaped either (only `node:crypto`, `node:path`,
 * `state-dir.js`, `errors.js`, `session.js`). Per this file's own fix
 * instructions, widening the config-only predicate to fit them is explicitly not
 * the option to take; the allow-list is. `ALLOWLIST_SIZE_AT_LANDING` still stays
 * **8**; `ALLOWLIST_CEILING` is now **12**. Both entries must be deleted (and the
 * ceiling dropped by one each) if either file is ever restructured to open a real
 * connection.
 *
 * ### Ceiling bump: the lock-handle-validity live suite
 *
 * `integration-lock-handle.test.ts` joined as a THIRTEENTH entry, under the same
 * clause as the four entries above: a genuine SIXTH permanent member, same
 * category as `integration.test.ts` / `integration-undo.test.ts` /
 * `integration-fpm-lock.test.ts` / `integration-class-includes.test.ts`. It is a
 * live suite (self-gated on `VITEST_LIVE=1` **and** `ABAP_URL` **and**
 * `ABAP_ALLOW_WRITE`, independently of vitest.config.ts's
 * `LIVE_INTEGRATION_TESTS`, which does now name it) that LOCKs a real `$TMP`
 * program on the real A4H appliance and PUTs with the exact handle LOCK just
 * returned — pinning the invariant that a lock handle must still be valid when
 * used, the competitor server's dominant live
 * failure (`ExceptionResourceInvalidLockHandle`, 423) — including across an
 * unrelated read interleaved between LOCK and PUT. There is no fake in the file
 * to route a probe through, and the real system answers the T000 probe itself.
 * `ALLOWLIST_SIZE_AT_LANDING` still stays **8**; `ALLOWLIST_CEILING` is now
 * **13**. This entry must be deleted (and the ceiling dropped) if the suite ever
 * stops connecting for real.
 *
 * ## The config-only exemption (separate from the allow-list)
 *
 * A suite whose SUBJECT is config resolution — env string in, resolved value
 * out — builds a config but never opens a connection, so it has no probe to
 * answer. That is not allow-list debt and must not consume the ratchet above.
 * It is exempted by a machine-checked import-surface predicate instead; see
 * `cannotReachAConnection` below for the full argument and its limits. The
 * exemption covers ZERO suites that existed when it landed: it changed no
 * file's verdict, it only stopped the detector from mistaking a config unit
 * test for a connection fixture.
 *
 * Shape (source scan + allow-list carrying written justifications) copied from
 * the truncation guard at `test/debug-render.test.ts:299`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/** This file. Excluded from its own scan — it talks about the probe, it does not fake one. */
const SELF = "system-role-probe-guard.test.ts";

/** The literal count on the day this guard landed. See the header. */
const ALLOWLIST_SIZE_AT_LANDING = 8;
const CONFIG_BUILDERS_AT_LANDING = 17;

/**
 * What the ratchet actually enforces today. Equal to `ALLOWLIST_SIZE_AT_LANDING`
 * except when a genuinely new PERMANENT allow-list member (a live suite with no
 * fake to route — see "Ceiling bump" in the header) has been added since
 * landing; each such addition raises this by exactly one, with a matching
 * header note naming the suite and the reason. It must NEVER be bumped to
 * accommodate unrepaired debt — that is what `PROBE_ALLOWLIST.length <=
 * builders.length` and the shrink-to-THREE target below still guard against.
 */
const ALLOWLIST_CEILING = ALLOWLIST_SIZE_AT_LANDING + 5; // +1 integration-fpm-lock, +1 integration-class-includes, +1 object-gate-config-equivalence, +1 pool-cross-process-object-gate, +1 integration-lock-handle

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/**
 * Comments are stripped before either detection runs. A file that merely
 * *mentions* `/datapreview/freestyle` in prose (this one did) has not routed
 * anything, and a commented-out `ConfigSchema.parse` is not a config.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Does this suite build something `connect()` will run the probe from? Any of
 * the three doors into a real `AbapConnection`: a parsed config, a loaded one,
 * or the constructor itself (`createServer` builds one internally from a config
 * that always arrives via one of the first two).
 */
const BUILDS_CONNECTION_CONFIG = /\bConfigSchema\.parse\(|\bloadConfig\(|\bnew AbapConnection\(/;

/**
 * Does it answer the probe? Either by routing the real path in its own fake, or
 * by using the shared helper — which is the same thing, stated once.
 */
const ANSWERS_PROBE = /datapreview\/freestyle|\brouteSystemRoleProbe\b|\bsystemRoleProbeResponse\b/;

// ---------------------------------------------------------------------------
// The config-only exemption
// ---------------------------------------------------------------------------

/**
 * A suite can build a config for a second reason: because the CONFIG ITSELF is
 * the subject under test. `ABAP_ALLOW_TRANSPORTS` resolves unset ⇒ `["auto"]`
 * but explicitly-empty ⇒ `[]` (deny-all, fail-CLOSED), and that asymmetry is a
 * safety property that has to be pinned at the `loadConfig()` level — env string
 * in, resolved list out. Such a suite never opens a connection, so there is no
 * probe for it to answer and no lockout verdict for its assertions to misread.
 *
 * Two ways NOT to express that, and why:
 *
 *  - Do not put such a file on `PROBE_ALLOWLIST`. That list measures a specific
 *    debt — suites that DO connect without declaring what system their fake
 *    stands for — and it is ratcheted (`length <= ALLOWLIST_CEILING`,
 *    target THREE). A file with nothing to repair would consume ratchet budget
 *    that belongs to real debt and make the target unreachable. Category error.
 *
 *  - Do not loosen `BUILDS_CONNECTION_CONFIG` to "builds a config AND looks like
 *    it connects". Config construction is a narrow waist; connection
 *    construction is not. `debug-tools.test.ts` reaches a real `AbapConnection`
 *    through `createTriggerConnection()`, and any such factory added later would
 *    silently punch a hole in the guard for EVERY suite. The detector stays on
 *    the chokepoint.
 *
 * So the exemption is proved from the IMPORT SURFACE instead, which ESM makes
 * total: a suite that statically imports nothing but `vitest`, `node:*` and
 * `../src/config.js` has no module in scope that can construct a connection —
 * not `AbapConnection`, not `createServer`, not any present or future factory.
 * Dynamic `import()`/`require()` would defeat that argument, so their presence
 * revokes the exemption. This is re-checked on every run, not asserted once: a
 * file that later imports anything else loses the exemption automatically and
 * falls straight back under the original rule.
 *
 * What this must never be used to smuggle in: a suite that touches a
 * connection, a server, a tool handler or a SafetyGate outcome. The moment such
 * a file needs one more import, it is no longer exempt — and if someone widens
 * this predicate to keep it exempt, that is the defect, not the fix.
 */
const IMPORT_SPECIFIER = /\bfrom\s+"([^"]+)"/g;

/** Dynamic loading defeats the static-import argument above, so it revokes the exemption. */
const DYNAMIC_IMPORT = /\bimport\s*\(|\brequire\s*\(/;

/** The complete set of modules a config-only suite may pull in. */
const configOnlyImport = (m: string): boolean =>
  m === "vitest" || m.startsWith("node:") || m === "../src/config.js";

/** Belt-and-braces tripwire: an exempt suite must not even NAME the connection surface. */
const CONNECTION_SURFACE = /\bAbapConnection\b|\bcreateServer\b|\.connect\(/;

function cannotReachAConnection(code: string): boolean {
  if (DYNAMIC_IMPORT.test(code)) return false;
  const specs = [...code.matchAll(IMPORT_SPECIFIER)].map((m) => m[1]);
  // A config builder with no import of src/config.js at all is not the shape
  // this exemption describes; fail closed rather than guess.
  if (!specs.includes("../src/config.js")) return false;
  return specs.every(configOnlyImport);
}

interface Suite {
  file: string;
  buildsConfig: boolean;
  answersProbe: boolean;
  configOnly: boolean;
  namesConnectionSurface: boolean;
}

function scanSuites(): Suite[] {
  return readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".test.ts") && f !== SELF)
    .sort()
    .map((file) => {
      const code = stripComments(readFileSync(join(TEST_DIR, file), "utf8"));
      return {
        file,
        buildsConfig: BUILDS_CONNECTION_CONFIG.test(code),
        answersProbe: ANSWERS_PROBE.test(code),
        configOnly: cannotReachAConnection(code),
        namesConnectionSurface: CONNECTION_SURFACE.test(code),
      };
    });
}

// ---------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------

/**
 * Suites that build a connection config and deliberately do not answer the
 * probe. Every entry names what the suite is ACTUALLY testing and why the
 * lockout verdict cannot be what its assertions are reading. Adding an entry is a
 * reviewable act; the honest alternative is always to route the probe.
 */
const PROBE_ALLOWLIST: { file: string; why: string }[] = [
  {
    file: "circuit-breaker.test.ts",
    why:
      "DELIBERATE FAIL-CLOSED SUITE — the one entry that belongs here permanently. It tests that " +
      "ONE failed logon reaches the network and everything after it is refused locally, so almost " +
      "every connection here asserts that connect() REJECTS and never gets as far as the probe. " +
      "The single connected case, 'keeps writes off and refuses stateful sessions in read mode', " +
      "asserts writesLockedOut === true and says so in its own comment: the unclassifiable system " +
      "IS the subject, not an accident.",
  },
  {
    file: "circuit-breaker-wiring.test.ts",
    why:
      "Tests the SEAM between AuthCircuitBreaker and the two places that obey it: " +
      "GuardedHttpClient.request() and server.ts's cached connectPromise. Its config exists only " +
      "to feed createServer() in the connect-cache-poisoning tests, where every connect() is made " +
      "to FAIL (latched vs transient) — no connection ever reaches the probe, and no assertion " +
      "here mentions writes, readOnly or system role.",
  },
  {
    file: "connection-signals.test.ts",
    why:
      "Tests SIGINT/SIGTERM shutdown ORDERING (exit only after shutdown settles) and the " +
      "process-listener leak that dispose() fixes. Its FakeAdt answers compatibility/graph, " +
      "discovery and ato/settings and a generic 200 for everything else; every assertion counts " +
      "process listeners or checks exit() ordering, so the inconclusive verdict is invisible to " +
      "all of them. Repairable: routing the probe would cost one line and remove the ambiguity.",
  },
  {
    file: "connection-discovery.test.ts",
    why:
      "Tests DISCOVERY-probe degradation, a different probe entirely: that a failed /discovery " +
      "GET is non-fatal, that 'empty because it failed' and 'empty because the system listed no " +
      "collections' stay distinguishable (both report discoveryCollections: 0), and that a " +
      "capability question answers 'unknown' rather than 'unsupported'. Its assertions read " +
      "discoveryState / discoveryError / capability answers, never readOnly or systemRole. Its " +
      "cfg already carries client '001', so routing the T000 probe would be a one-line repair.",
  },
  {
    file: "debug-tools.test.ts",
    why:
      "Tests the abap_debug / abap_debug_vars / abap_debug_value MCP tool surface against " +
      "hand-rolled DebugToolDeps and a DUMMY_CONN literal; its gate assertions use SafetyGate " +
      "objects constructed inline, never a connection's role. The only real AbapConnection is in " +
      "the D8 signal-handler tests, where AbapConnection.prototype.connect is spied out entirely " +
      "and does nothing but install shutdown hooks — no HTTP happens, so there is no probe to " +
      "answer.",
  },
  {
    file: "run.test.ts",
    why:
      "Tests classrun and the report bridge plus the F7 gate on the " +
      "bridge class. src/adt/run.ts states at line 16 that it does not consult conn.readOnly: " +
      "mutations go through the SafetyGate passed in, and this suite constructs those gates " +
      "directly with writesLockedOut: false, so the lockout decides none of its outcomes. " +
      "Repairable: the connections it builds are otherwise ordinary.",
  },
  {
    file: "integration.test.ts",
    why:
      "LIVE suite (vitest.config.ts LIVE_INTEGRATION_TESTS, skipped unless ABAP_URL). It builds " +
      "its config with loadConfig() and talks to the REAL A4H appliance, which answers the probe " +
      "itself with real bytes. There is no fake to route, and faking one here would replace the " +
      "very thing the suite exists to observe.",
  },
  {
    file: "integration-undo.test.ts",
    why:
      "LIVE suite, same as integration.test.ts (skipped unless ABAP_URL and ABAP_ALLOW_WRITE). " +
      "It writes and undoes ZMCP_UNDO_LIVE in $TMP against the real appliance; the real system " +
      "answers the T000 probe, and its answer is precisely what must be allowed to gate the " +
      "writes. Nothing to fake.",
  },
  {
    file: "integration-fpm-lock.test.ts",
    why:
      "LIVE suite, same idiom as integration.test.ts and integration-undo.test.ts (skipped " +
      "unless ABAP_URL and ABAP_ALLOW_WRITE, copied verbatim per its own header). It builds its " +
      "config with loadConfig() and takes real ENQUEUE_E_WDY_CONFCOMP locks against the real A4H " +
      "appliance to prove the FPM/FBI lock protocol on the wire; the real system answers " +
      "the T000 probe itself. There is no fake to route, and faking one here would replace the " +
      "very enqueue/dequeue behaviour the suite exists to observe.",
  },
  {
    file: "integration-class-includes.test.ts",
    why:
      "LIVE suite, same idiom as integration.test.ts / integration-undo.test.ts / " +
      "integration-fpm-lock.test.ts, with one extra belt: it self-gates on VITEST_LIVE=1 as well " +
      "as ABAP_URL and ABAP_ALLOW_WRITE, INDEPENDENTLY of vitest.config.ts's " +
      "LIVE_INTEGRATION_TESTS (which does now name it), so that neither the config list nor the " +
      "in-file gate alone can put this suite on the wire. It builds its config with loadConfig() " +
      "and writes an ABAP Unit " +
      "test class into the CCAU include of ZMCP_CCAU_LIVE in $TMP on the real A4H appliance, " +
      "then activates and RUNS that test — the live acceptance question no offline suite can " +
      "answer. The real system answers the T000 probe itself, so the guard's failure mode (a " +
      "fake leaving the verdict `inconclusive` while the suite stays green) cannot arise: an " +
      "inconclusive verdict here would lock writes out and every write assertion in the file " +
      "would go RED, loudly. There is no fake to route, and faking one would replace the " +
      "server behaviour the suite exists to observe. NOTE: as of landing, this suite has been " +
      "WRITTEN AND NEVER RUN — the appliance was down. That does not change the justification, " +
      "which is about what it does when it runs, not whether it has yet.",
  },
  {
    file: "object-gate-config-equivalence.test.ts",
    why:
      "An offline suite proving loadConfig()/ConfigSchema and the pre-existing " +
      "resolveCrossProcessObjectLock()/resolveObjectLockWaitMs() resolvers agree over a full " +
      "input matrix (unset, empty, whitespace, valid, invalid, out-of-range, mixed case, Number() " +
      "traps like \"0x1F4\"). It calls loadConfig() only to parse env into a Config object and " +
      "read fields back off it and off redactConfigSecrets() — never AbapConnection, never createServer, " +
      "never .connect(). Its one import beyond ../src/config.js is ../src/adt/object-gate.js, for " +
      "the two resolver functions the equivalence proof is checking against; that file itself " +
      "imports only node:crypto, node:path, state-dir.js, errors.js, and session.js — no " +
      "connection surface at all, so there is no probe reachable through it either. Confirmed by " +
      "grep: no .connect(, .withWrite(, AbapConnection, or createServer anywhere in this file.",
  },
  {
    file: "pool-cross-process-object-gate.test.ts",
    why:
      "Unit suite for AdtSessionPool's gate selection (NoopObjectGate / InProcessObjectGate / " +
      "FileLockObjectGate) plus direct FileLockObjectGate contention tests using real temp-dir " +
      "file locks. Every AdtSessionPool-building test — both the pre-existing fakeConfig() ones " +
      "and the ones added to prove gate/waitMs selection from a REAL loadConfig() output — " +
      "only constructs the pool and inspects its private .gate (and the gate's private .waitMs) " +
      "immediately afterward; none ever calls .connect() or .withWrite(). fakeCreateConnection()'s " +
      "returned stub does not even implement .connect. That addition swapped a hand-typed " +
      "Config double for loadConfig() specifically so the gate-selection precedence is proved " +
      "against production's real parsing, which is what trips this guard's loadConfig() regex — " +
      "not any new connectivity. Confirmed by grep: no .connect(, .withWrite(, routeSystemRoleProbe, " +
      "or datapreview anywhere in this file.",
  },
  {
    file: "integration-lock-handle.test.ts",
    why:
      "LIVE suite, same idiom as integration.test.ts / integration-undo.test.ts / " +
      "integration-fpm-lock.test.ts / integration-class-includes.test.ts, with the same extra " +
      "belt as the latter: it self-gates on VITEST_LIVE=1 as well as ABAP_URL and " +
      "ABAP_ALLOW_WRITE, INDEPENDENTLY of vitest.config.ts's LIVE_INTEGRATION_TESTS (which does " +
      "now name it). It builds its config with loadConfig() and, against the real A4H appliance, " +
      "LOCKs a $TMP program via StatefulSession.lock and PUTs with the exact handle LOCK just " +
      "returned — pinning the invariant that a lock handle must still be valid when used, " +
      "including when an unrelated read runs between LOCK and PUT. The real system answers the " +
      "T000 probe itself, so the guard's failure mode (a fake leaving the verdict `inconclusive` " +
      "while the suite stays green) cannot arise: an inconclusive verdict here would lock writes " +
      "out and every PUT assertion in the file would go RED, loudly. There is no fake to route, " +
      "and faking one would replace the server behaviour — real lock/unlock semantics on the " +
      "wire — the suite exists to observe.",
  },
];

const isAllowed = (s: Suite): boolean => PROBE_ALLOWLIST.some((a) => a.file === s.file);

const FIX_INSTRUCTIONS =
  "\n\nWhat this means: AbapConnection.connect() POSTs once to " +
  "/sap/bc/adt/datapreview/freestyle to read T000-CCCATEGORY, and that probe is FAIL-CLOSED. " +
  "A fake that leaves it unanswered is not neutral — the verdict becomes `inconclusive`, which " +
  "locks writes out in a way ABAP_ALLOW_WRITE cannot override. Every safety " +
  "assertion in the file is then answered by the LOCKOUT rather than by the gate under test, and " +
  "the suite stays GREEN while proving something much weaker than its name claims.\n\n" +
  "Fix, pick one:\n" +
  "  (a) Answer the probe — wrap the fake with `routeSystemRoleProbe(fake, { answer: " +
  '"nonproductive" })` from test/helpers/system-role-fake.ts, and give the config a ' +
  '`client` of "000" or "001" so a T000 row can be attributed to it.\n' +
  "  (b) If the lockout is genuinely what the suite tests, say so: either pass " +
  '`{ answer: "inconclusive" }` at the call site, or add the file to PROBE_ALLOWLIST in ' +
  "test/system-role-probe-guard.test.ts with a justification naming what it actually tests.\n" +
  "  (c) If the config itself is the subject and the suite never opens a connection, import " +
  "nothing but vitest, node:* and ../src/config.js — the config-only exemption then applies " +
  "automatically. Widening that predicate to fit a suite that needs more is NOT this option.\n" +
  "Deleting this guard is not option (d).";

// ---------------------------------------------------------------------------

describe("system-role probe — every connection-building suite declares its intent", () => {
  it("every suite that builds a connection config either routes the probe or is justified", () => {
    const suites = scanSuites();
    const builders = suites.filter((s) => s.buildsConfig);
    // The scanner really is finding things — a regex that silently matches
    // nothing would make this whole guard vacuously green.
    expect(builders.length).toBeGreaterThan(0);

    const unlisted = builders.filter((s) => !s.answersProbe && !isAllowed(s) && !s.configOnly);
    expect(
      unlisted.map((s) => `test/${s.file}`),
      "Suite builds a connection config but never answers the system-role probe." +
        FIX_INSTRUCTIONS,
    ).toEqual([]);
  });

  it("the config-only exemption stays narrow and cannot cover a connecting suite", () => {
    const suites = scanSuites();
    const exempt = suites.filter((s) => s.buildsConfig && s.configOnly);

    // Disjoint populations. PROBE_ALLOWLIST is accrued debt in suites that DO
    // connect; the exemption is for suites that provably cannot. If one file
    // ever claimed both, the ratchet on the allow-list would be measuring the
    // wrong thing and the exemption would be laundering debt.
    expect(
      exempt.filter((s) => isAllowed(s)).map((s) => `test/${s.file}`),
      "Suite is on PROBE_ALLOWLIST and also claims the config-only exemption. Pick one: if it " +
        "truly cannot reach a connection, DELETE its allow-list entry.",
    ).toEqual([]);

    // Import purity is necessary but the cheap tripwire is worth keeping: an
    // exempt suite should not so much as name the connection surface. If this
    // fires, the import predicate has drifted from what it claims to prove.
    expect(
      exempt.filter((s) => s.namesConnectionSurface).map((s) => `test/${s.file}`),
      "Config-only suite names AbapConnection/createServer/.connect( despite importing only " +
        "src/config.js. The exemption's premise no longer holds — do not widen it.",
    ).toEqual([]);

    // The exemption may not become the general escape hatch. It is for config
    // resolution units; if this grows, the guard has been routed around.
    //
    // 3 → 4 when `test/config-name-prefixes.test.ts` landed with the
    // `ABAP_ALLOW_NAME_PREFIXES=*` wildcard. It is the same shape as its three
    // siblings — env string in, resolved list out, plus the startup banner that
    // reports it — and it earns the exemption the honest way, by importing
    // vitest and `../src/config.js` and nothing else. Note what that cost: the
    // "does this list read as unrestricted?" half of the wildcard lives in
    // `src/safety.js`, so its assertions had to go to `test/safety.test.ts`
    // rather than the import being added here. Raise this number only for
    // another suite that pays the same price.
    //
    // 4 → 5 when `test/config-url-redaction.test.ts` landed. It
    // covers `describeUrlWithoutHost` / `urlHasEmbeddedPassword` and the two
    // `loadConfig` startup warnings that use them, and it earns the exemption
    // the honest way: importing only vitest and `../src/config.js`.
    //
    // 5 → 6 when `test/config-redaction-honesty.test.ts` landed.
    // It covers the `redactConfig` → `redactConfigSecrets` rename and what the
    // projection actually guarantees — that it strips the password and any
    // userinfo embedded in the URL, and deliberately retains the host, `user`
    // and `sid` — and it earns the exemption the honest way: importing only
    // vitest and `../src/config.js`.
    //
    // 6 → 7 when `test/config-session-cookie.test.ts` landed. It
    // covers the `ABAP_SESSION_COOKIE` parse and the exactly-one-of-password-
    // or-cookie credential resolution, plus the `redactConfigSecrets`
    // projection of the cookie, and it earns the exemption the honest way:
    // importing only vitest and `../src/config.js`.
    //
    // 7 → 8 when `test/verify-writes-config.test.ts` landed. It covers the
    // `ABAP_VERIFY_WRITES` parse, its `speculative` default and the rejection
    // of an unrecognised value, and it earns the exemption the honest way:
    // importing only vitest and `../src/config.js`. Note the same price as its
    // siblings — the mode's effect on write behaviour is asserted in
    // `test/write-verify-mode.test.ts`, which connects and is not exempt.
    expect(exempt.length).toBeLessThanOrEqual(8);
  });

  it("the allow-list has not rotted: every entry still names a real, still-offending suite", () => {
    const suites = scanSuites();
    const byFile = new Map(suites.map((s) => [s.file, s]));

    // An entry for a file that no longer exists, or was renamed.
    const missing = PROBE_ALLOWLIST.filter((a) => !byFile.has(a.file)).map((a) => a.file);
    expect(missing, "Allow-list entry names a test file that does not exist").toEqual([]);

    // An entry for a suite that has since been repaired. This is the good case,
    // and it must be noticed: leaving it behind turns the list into a blanket
    // permit and hides the fact that the guarantee moved.
    const repaired = PROBE_ALLOWLIST.filter((a) => byFile.get(a.file)?.answersProbe).map((a) => a.file);
    expect(
      repaired.map((f) => `test/${f}`),
      "Allow-listed suite now routes /datapreview/freestyle — it has been repaired. " +
        "DELETE its entry from PROBE_ALLOWLIST so the list keeps shrinking.",
    ).toEqual([]);

    // An entry for a suite that no longer builds a config at all.
    const notBuilders = PROBE_ALLOWLIST.filter((a) => byFile.get(a.file)?.buildsConfig === false).map(
      (a) => a.file,
    );
    expect(notBuilders, "Allow-listed suite no longer builds a connection config").toEqual([]);
  });

  it("every allow-list entry carries a real written justification, not a placeholder", () => {
    for (const a of PROBE_ALLOWLIST) {
      expect(a.why.length, `allow-list entry ${a.file} needs a justification`).toBeGreaterThan(80);
      expect(a.why, `allow-list entry ${a.file} must not be a placeholder`).not.toMatch(
        /TODO|FIXME|\bTBD\b|^see filename$/i,
      );
      // The justification must say something the filename does not.
      expect(a.why.toLowerCase(), `allow-list entry ${a.file} just repeats its filename`).not.toBe(
        a.file.toLowerCase(),
      );
    }
  });

  it("records the counts at landing so a later reader can see whether the list moved", () => {
    const suites = scanSuites();
    const builders = suites.filter((s) => s.buildsConfig);
    // Not pinned to equality — new suites are welcome, and repairs must not
    // need this file edited. These are the two numbers whose direction matters:
    // the allow-list may only ever shrink toward ALLOWLIST_CEILING (which itself
    // only grows for a documented new PERMANENT member, see the header's
    // "Ceiling bump" note), and it may never exceed the number of
    // config-building suites.
    expect(PROBE_ALLOWLIST.length).toBeLessThanOrEqual(ALLOWLIST_CEILING);
    expect(PROBE_ALLOWLIST.length).toBeLessThanOrEqual(builders.length);
    expect(CONFIG_BUILDERS_AT_LANDING).toBeGreaterThan(ALLOWLIST_SIZE_AT_LANDING);
  });
});
