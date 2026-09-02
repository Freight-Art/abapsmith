/**
 * Static contract test: every place in `src/` that reaches for the raw HTTP
 * write surface (`conn.put`/`conn.post`/`conn.del`/`conn.raw`, or `.raw()`
 * itself) must be paired with a `SafetyGate` check somewhere findable by
 * simple static analysis.
 *
 * Why this exists (see src/adt/connection.ts's `assertUsable()`,
 * `get()`/`put()`/`post()`/`del()`/`raw()` around lines 1037-1374): that layer
 * enforces circuit-breaker/connection-death, and `raw()` — so
 * `put()`/`post()`/`del()` — now also carries its own `readOnly` check as
 * defense-in-depth, the same way `withStatefulSession()` always has. That
 * connection-level gate is a coarse, all-or-nothing "is this whole connection
 * allowed to mutate anything" check, and a real ADT server independently
 * rejects an unauthorized write too — but neither is a substitute for the
 * FINE-GRAINED policy (which package, which object name prefix, which
 * transport) that only `SafetyGate` knows how to apply. Enforcement of THAT
 * policy is still a *convention*: every mutating tool handler calls
 * `safety.assert(...)`/`gate.assert(...)`/`gate.evaluate(...)` (or the
 * optional-chained `gate?.evaluate(...)` form `src/tools/transport.ts` uses)
 * BEFORE the write reaches the connection. Nothing in the type system
 * enforces that convention — this test is the tripwire that stands in for it.
 *
 * It exists specifically so a future write tool (an FPM/FBI config editor is
 * the concrete case that prompted this) that reaches
 * for `conn.post`/`conn.put` directly cannot silently skip the safety gate
 * without at least tripping this test and forcing a deliberate look.
 *
 * HOW THE HEURISTIC WORKS (read this before trusting or "fixing" a failure):
 *
 * 1. Find every non-test `src/**\/*.ts` file with a call site that looks
 *    like `<something containing "conn"/"connection">.(put|post|del|raw)(`.
 *    `src/adt/connection.ts` itself is excluded — it's the primitive layer
 *    being called (its `put`/`post`/`del` are thin wrappers around `this.raw`,
 *    which has its own `readOnly` gate but deliberately knows nothing about
 *    packages, name prefixes or transports — that fine-grained policy is
 *    exactly what `SafetyGate` is for, and connection.ts is out of scope for
 *    it by design), not a caller reaching for a write.
 * 2. A file passes if it contains its own `safety.assert(`/`gate.assert(`/
 *    `gate.evaluate(`/`gate?.assert(`/`gate?.evaluate(` call.
 * 3. Otherwise it ALSO passes if some file that directly imports it (one
 *    hop, via a literal relative `from "..."` specifier — not a transitive
 *    search) contains one of those calls. This second clause exists because
 *    this codebase's actual layering puts the gate one level up from the
 *    HTTP call: `src/adt/transports.ts` and `src/adt/bopf.ts` have NO gate
 *    call in themselves at all — `src/tools/transport.ts` and
 *    `src/tools/bopf.ts` gate before ever calling into them. Restricting
 *    this to files that import it as those two specific modules do keeps
 *    the type of file where a caller happens to be "unrelated safety.assert
 *    calls in a big function you also happen to be imported by" (a hub file)
 *    from trivially satisfying the check.
 *
 * LIMITATIONS — this is a heuristic, not proof of correct gating order or
 * that every code PATH through a multi-handler file is gated:
 *   - It does not check that the gate call happens BEFORE the write, only
 *     that one exists somewhere in the same (or one-hop-importing) file.
 *   - A file with several handlers, only some of which are gated, still
 *     passes if ANY handler in it has a gate call (see `src/tools/bopf.ts`,
 *     which has multiple `deps.safety.assert(...)` call sites for different
 *     actions — this test doesn't verify each one is on the right path).
 *   - It is textual, not a real call graph: string matches inside comments
 *     or unrelated identifiers containing "conn" could in principle produce
 *     a false pass. Re-read the diff by hand for anything touching
 *     `src/adt/connection.ts`'s write surface; do not rely on this test alone.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const CONNECTION_DEFINITION_FILE = join(SRC, "adt", "connection.ts");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

const files = listTsFiles(SRC);
const contents = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

// Matches `conn.put(`, `this.connection.post(`, `deps.conn.del(`, `this.raw(`
// (the last only relevant inside connection.ts, which is excluded below) —
// any dotted identifier chain ending in put/post/del/raw, filtered afterward
// to chains that actually look like a connection ("conn"/"connection").
const CONN_CALL_RE = /([\w$]+(?:\.[\w$]+)*)\.(put|post|del|raw)\(/g;
const isConnLike = (chain: string) => /conn(?:ection)?\b/i.test(chain);

function connCallSites(text: string): boolean {
  CONN_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONN_CALL_RE.exec(text))) {
    if (isConnLike(m[1])) return true;
  }
  return false;
}

// `(?:Intent)?` covers `gate.assertIntent(`/`gate.evaluateIntent(` — see
// safety.ts's own `assertIntent`, which is provably equivalent (it derives a
// `SafetyTarget` from the `EnhancementIntent` and calls `this.evaluate(...)`
// under the hood) — not a different, unchecked code path this heuristic
// should miss. Every alternative is anchored on its own `\(` so a bare
// `.assert`/`.evaluate` with no call, or an unrelated `.evaluateSomethingElse(`,
// still does not count.
//
// `authorize`/`authorizeIntent`/`authorizeMutation` are matched too, and they
// are the STRONGER form: they mint an `AuthorizedTarget` token that the write
// signature demands, so the check cannot be forgotten without a compile error.
// They were missing here until this pattern was widened to include them. Both `src/adt/enhancement-write.ts`
// (`gate.authorizeIntent("write"|"delete", …)`) and `src/debug/transport.ts`
// (`authorizeMutation(...)`) are gated exclusively that way and were passing
// this tripwire only because unrelated PROSE in their comments happened to
// contain the string `gate.assertIntent(`. Compressing those comments away
// turned the file red without changing one byte of executable code, which is
// exactly the false-negative this pattern is supposed to preclude. Keep this
// matching the real authorisation API, not the way comments describe it.
const GATE_RE =
  /\b(?:safety\.assert\(|gate\??\.assert(?:Intent)?\(|gate\??\.evaluate(?:Intent)?\(|(?:gate\??\.)?authorize(?:Intent|Mutation)?\()/;

// One-hop reverse-import graph: target file -> files that import it via a
// literal relative specifier.
function localImportTargets(file: string, text: string): string[] {
  const out: string[] = [];
  const re = /from\s+["'](\.[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let spec = m[1];
    if (spec.endsWith(".js")) spec = `${spec.slice(0, -3)}.ts`;
    else if (!spec.endsWith(".ts")) spec = `${spec}.ts`;
    out.push(resolve(dirname(file), spec));
  }
  return out;
}

const importedBy = new Map<string, string[]>();
for (const f of files) {
  for (const target of localImportTargets(f, contents.get(f)!)) {
    if (!importedBy.has(target)) importedBy.set(target, []);
    importedBy.get(target)!.push(f);
  }
}

const callers = files
  .filter((f) => f !== CONNECTION_DEFINITION_FILE)
  .filter((f) => connCallSites(contents.get(f)!));

describe("safety-gate contract (heuristic, see file header)", () => {
  it("finds a non-empty, expected set of connection write call sites — not a vacuous pass", () => {
    const rel = callers.map((f) => relative(SRC, f)).sort();
    // Ground truth as of writing (re-grep `\.put(\|\.post(\|\.del(\|\.raw(`
    // over src/ if this ever needs updating — see the file header).
    // `adt/enhancement-write.ts` added 2026-08 — its `attempt` callback
    // calls `conn.put(...)` for the LOCK/PUT/UNLOCK choreography; it is gated
    // by its own unconditional `gate.assertIntent(...)` call, matched below.
    // `adt/enhancement-hook.ts` added 2026-08 — `createHookImplementation`
    // calls `conn.post(...)` for the ENHO/XHH create; gated by its own
    // unconditional `gate.assertIntent(...)` call, matched below.
    // `adt/enhancement-bridge.ts` added
    // 2026-08 — `activateSpotAndImplementation` now calls `conn.post(...)`
    // directly (hand-rolled joint-activation POST, replacing the vendor
    // array-form `conn.adt.activate()`, which unconditionally emitted
    // `adtcore:type`/`adtcore:parentUri` attributes SAP rejects with a 400 —
    // see that file's own header). Every exported function in the file,
    // including this one's callers, already calls `gate.assertIntent(...)`/
    // `gate.assert(...)` unconditionally (see the module header's "Gating"
    // section), matched below.
    // `adt/activate.ts` added 2026-08 — `activateObjects` (batch activation)
    // POSTs the hand-built multi-object `<adtcore:objectReferences>` body
    // directly via `conn.post(...)`, replacing the vendor's array-form
    // `activate()` for the same reason `enhancement-bridge.ts` above does:
    // that overload emits attributes SAP 400s on. `activateObjects` itself
    // takes no `SafetyGate` — by design, see its header comment — because
    // authorisation is per-object and belongs to the caller. Its only caller,
    // `src/tools/activate.ts`, resolves and authorises EVERY object in the
    // set (one `authorizeMutation`/`gate.assert(...)` per object) before this
    // function is ever reached, which is what the one-hop importer clause
    // below matches.
    // `adt/atc.ts` added 2026-08 — an ATC run POSTs twice: once to create the
    // ATC worklist (a persistent server-side row) and once to start the run.
    // Deliberately NOT routed around the connection's read-only ceiling the way
    // `dataPreviewDdic` is: leaving state behind is exactly what a read-only
    // deployment has said it will not do. `runAtcCheck` takes an
    // `AuthorizedTarget<"execute">` parameter, so it is gated by the type
    // system rather than by a convention — but it also calls
    // `conn.discovery.assertSupported(...)` and its registrar calls
    // `safety.assert("execute", ...)`, which is what the heuristic below
    // matches.
    expect(rel).toEqual(
      [
        "adt/activate.ts",
        "adt/atc.ts",
        "adt/bopf.ts",
        "adt/enhancement-bridge.ts",
        "adt/enhancement-hook.ts",
        "adt/enhancement-write.ts",
        "adt/transports.ts",
        "adt/write.ts",
        "debug/transport.ts",
        "tools/test.ts",
      ].sort(),
    );
  });

  it("every connection-write call site has a safety/gate check in itself or in a direct importer", () => {
    const violations: string[] = [];
    for (const f of callers) {
      const text = contents.get(f)!;
      if (GATE_RE.test(text)) continue;
      const importers = importedBy.get(f) ?? [];
      const gatedImporter = importers.find((imp) => GATE_RE.test(contents.get(imp)!));
      if (!gatedImporter) violations.push(relative(SRC, f));
    }
    expect(
      violations,
      `file(s) call conn.put/post/del/raw with no safety/gate check in the file itself or a ` +
        `direct importer: ${violations.join(", ")}. If this is a NEW write tool, add ` +
        `safety.assert(...)/gate.assert(...)/gate.evaluate(...) before the write — see ` +
        `src/tools/write.ts or src/tools/bopf.ts for the pattern. This is a heuristic ` +
        `tripwire, not proof; see this file's header before relaxing it.`,
    ).toEqual([]);
  });
});

/**
 * `src/adt/activate.ts`'s new `prettyPrintSource`
 * calls the vendor library's stateless `prettyPrinter(h, body)` — a POST that
 * neither locks nor writes, just runs the ADT formatter over one string and
 * hands the result back (see node_modules/abap-adt-api/build/api/syntax.js).
 * That is a completely different call from the vendor's neighbouring
 * `setPrettyPrinterSetting(h, indent, style)`, a PUT to
 * `/sap/bc/adt/abapsource/prettyprinter/settings` that changes the
 * pretty-printer's SYSTEM-WIDE default formatting style for every user on the
 * appliance — not scoped to one object, one session, or one write. Nothing
 * about abapsmith's purpose calls for that, and there is currently no code path
 * that reaches it.
 *
 * This is a structural tripwire, not a design decision embedded in test
 * assertions on `prettyPrintSource`'s behaviour (see test/activate.test.ts):
 * it stands guard against a FUTURE change casually wiring up
 * `setPrettyPrinterSetting` (e.g. "let format:true also accept a style
 * option") without whoever does it registering that this is a system-wide
 * mutation, not a per-write one, and deserves a real design conversation, not
 * a one-line addition next to `prettyPrinter`.
 *
 * Built via concatenation so this file itself is never a false hit if this
 * test is ever copied inline into a grep-style pattern elsewhere.
 *
 * NOTE this matches a CALL SITE (identifier immediately followed by `(`), not
 * a bare textual mention. `src/adt/activate.ts` itself carries a doc comment
 * right next to `prettyPrintSource` that names `setPrettyPrinterSetting` on
 * purpose, as a warning to future readers ("never `setPrettyPrinterSetting`,
 * which mutates a system-wide...") — a bare-substring version of this test
 * would trip on that legitimate, load-bearing comment forever. Anchoring on
 * the open-paren catches the only way this vendor method can actually be
 * invoked (it is a method on `abap-adt-api`'s client, e.g.
 * `conn.adt.setPrettyPrinterSetting(...)` — there is no bare importable
 * function form to catch separately), which mirrors this same file's own
 * `CONN_CALL_RE` above (call-shape, not free-text).
 */
const SET_PRETTY_PRINTER_SETTING_CALL_RE = new RegExp("setPrettyPrinterSetting\\(");

describe("prettyprinter settings tripwire", () => {
  it("never calls the system-wide setPrettyPrinterSetting API anywhere under src/", () => {
    const hits = files
      .filter((f) => SET_PRETTY_PRINTER_SETTING_CALL_RE.test(contents.get(f)!))
      .map((f) => relative(SRC, f));
    expect(
      hits,
      `found a setPrettyPrinterSetting(...) call site in: ${hits.join(", ")}. That vendor API ` +
        `(abap-adt-api's setPrettyPrinterSetting) changes the ADT pretty-printer's default style for the ` +
        `WHOLE appliance, for every user — it is not a per-write operation, unlike the stateless ` +
        `prettyPrinter(...) call \`prettyPrintSource\` (src/adt/activate.ts) actually uses. If this is ` +
        `intentional, it needs a deliberate design decision (and probably a dedicated, gated tool), not a ` +
        `quiet addition next to the per-object formatter — see this test's header before deleting it.`,
    ).toEqual([]);
  });
});
