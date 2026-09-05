/**
 * AUDIT ARTIFACT — doc/analysis/journal-completeness-audit.md, gap G0.
 *
 * NOT a normal suite member. This file exists to answer ONE question posed by
 * that audit, as it stood when the audit was written:
 *
 *     "Is there a test that would FAIL if someone added a new mutating tool
 *      that forgot to journal?"
 *
 * The answer was no at the time, and this file was the demonstration. It is
 * the journal analogue of `test/safety-gate-contract.test.ts` — same corpus,
 * same one-hop reverse-import heuristic, same `CONN_CALL_RE` shape — with
 * `GATE_RE` swapped for a journal-linkage regex.
 *
 * UPDATE, post-rebase onto master @ 61f9a06: that tripwire now exists —
 * `test/journal-contract.test.ts`, landed after this file was
 * first written. It is comment-stripped, pins mutation-site/journalling-module
 * PAIRS rather than a loose one-hop heuristic, and carries an explicit,
 * shrink-only `KNOWN_GAPS` allowlist. This file is kept anyway, as a second,
 * independent (looser, and honest about being looser) measurement: its
 * heuristic under- and over-reports in specific, informative ways — see the
 * comments below on `adt/activate.ts` and `adt/bopf.ts` — and that behaviour
 * is itself part of what the audit documents. Do not read this file's
 * continued existence as "no real tripwire exists"; read `test/journal-
 * contract.test.ts` for the current, load-bearing one.
 *
 * Two blocks below:
 *
 *   1. CHARACTERISATION (passes). Pins today's actual split of the 10
 *      connection-write modules into journal-linked and not. It is green, and
 *      it is green because the codebase is in the state the audit describes.
 *
 *   2. THE INVARIANT. States the property the audit says does not hold
 *      today, pinned to the CURRENT known-bad set rather than to `[]`. A
 *      permanently-red test on master gets ignored within a day, so this is
 *      not "expected RED" in the sense of shipping failing CI — it is a
 *      tripwire: it stays green only as long as the known-bad set does not
 *      GROW, and goes red the moment a new mutating module joins it
 *      unlinked, which is exactly the asymmetry-with-safety-gate finding
 *      this file exists to make (`test/safety-gate-contract.test.ts` has a
 *      real tripwire for SafetyGate; before this file, the journal had
 *      none). It goes green on an EMPTY list by closing the gap for real —
 *      shrink the pinned set, do not just relax the assertion.
 *
 * The heuristic's limits are the same as the gate contract's: one hop, literal
 * relative specifiers, regex over source text. It cannot prove journalling
 * happens; it can only show that nothing in the module or its direct importers
 * even MENTIONS the journal, which is a lower bar and still not met.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");
const CONNECTION_DEFINITION_FILE = join(SRC, "adt", "connection.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = walk(SRC).sort();
const contents = new Map(files.map((f) => [f, readFileSync(f, "utf8")] as const));

/** Verbatim from test/safety-gate-contract.test.ts — same corpus, same shape. */
const CONN_CALL_RE = /(\w[\w.]*)\.(?:put|post|del|raw)\(/g;
const isConnLike = (recv: string) => /conn|connection/i.test(recv);

function connCallSites(text: string): boolean {
  CONN_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONN_CALL_RE.exec(text))) {
    if (isConnLike(m[1]!)) return true;
  }
  return false;
}

/**
 * Journal linkage, deliberately GENEROUS: any mention of `withJournalledMutation`,
 * `journal.begin(`, `onBeforeImage`, `NO_JOURNAL`, or a `deps.journal`/`journal:`
 * field counts. A module scores a pass merely for having thought about the
 * journal at all — including by explicitly opting OUT via `NO_JOURNAL`. Nothing
 * here checks that an entry is actually written.
 */
const JOURNAL_RE =
  /\b(?:withJournalledMutation\(|journal\.begin\(|onBeforeImage|NO_JOURNAL|deps\.journal|journal\?:|journal:)/;

function localImportTargets(file: string, text: string): string[] {
  const out: string[] = [];
  const re = /from\s+["'](\.[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let spec = m[1]!;
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

function unlinked(): string[] {
  const out: string[] = [];
  for (const f of callers) {
    if (JOURNAL_RE.test(contents.get(f)!)) continue;
    const importers = importedBy.get(f) ?? [];
    if (importers.some((imp) => JOURNAL_RE.test(contents.get(imp)!))) continue;
    out.push(relative(SRC, f));
  }
  return out.sort();
}

describe("CHARACTERISATION: which connection-write modules are journal-linked today", () => {
  it("sees the same 11 connection-write modules the safety-gate contract pins", () => {
    expect(callers.map((f) => relative(SRC, f)).sort()).toEqual(
      [
        "adt/activate.ts",
        "adt/atc.ts",
        "adt/bopf.ts",
        "adt/enhancement-bridge.ts",
        "adt/enhancement-hook.ts",
        "adt/enhancement-write.ts",
        "adt/quickfix.ts",
        "adt/transports.ts",
        "adt/write.ts",
        "debug/transport.ts",
        "tools/test.ts",
      ].sort(),
    );
  });

  it("records the modules with NO journal linkage in themselves or any direct importer", () => {
    // Green today. This is the audit's evidence, frozen: if a later change
    // makes this list SHORTER the gap is closing (good, update the list); if it
    // makes it LONGER a new unjournalled mutation surface has appeared.
    //
    // THIS LIST UNDERSTATES THE GAP, and knowing by how much is part of the
    // finding. As of `master @ 61f9a06` (see `dfba310`), one module that journals
    // NOTHING is absent from it because the one-hop importer clause launders it:
    //   - `tools/test.ts` — the ABAP Unit POST. Passes only because
    //     `src/tools/v2/handlers/do/activation.ts` imports it alongside
    //     `src/tools/journal.ts`.
    // The heuristic cannot tell "this importer journals THIS call" from "this
    // importer journals something else". A real tripwire would have to be
    // stricter than this one, and this one is already red.
    //
    // `adt/activate.ts` used to be laundered the same way (`src/tools/write.ts`
    // imports it and journals its OWN entry, not activate's). `dfba310` closed
    // that gap for real — `src/tools/activate.ts` now constructs a genuine
    // `operation: "activate"` entry per object — so it is a true positive now,
    // not a false one. Do not re-add it here without re-reading
    // `src/tools/activate.ts` first.
    //
    // `adt/bopf.ts` dropped out of this list for the OPPOSITE reason, and it is
    // the one to watch: `dfba310` also added a required-but-unused `journal:
    // Journal` field to `BopfRunDeps` (`src/tools/bopf.ts:255`) as a tripwire
    // ahead of BOPF create/update/delete journalling landing on branch
    // `fix/journal-bopf` (not yet merged).
    // That field's mere TYPE DECLARATION contains the literal text `journal:`,
    // which satisfies `JOURNAL_RE` — so `src/tools/bopf.ts` (a one-hop importer
    // of `adt/bopf.ts`) now reads as "journal-linked" even though nothing on
    // that path has ever constructed a journal entry. `adt/bopf.ts` still
    // journals nothing; it is missing from `unlinked()` by heuristic accident,
    // not because BOPF journalling landed. See `doc/analysis/journal-completeness-audit.md`
    // (A2, A4) for the full trail.
    expect(unlinked()).toEqual(["adt/atc.ts", "debug/transport.ts"]);
  });
});

describe("THE INVARIANT — pinned to the current known-bad set, not to []", () => {
  it("every module that reaches the HTTP write surface is journal-linked in itself or a direct importer, OR is in this shrink-only allowlist", () => {
    // Grows → red (a new unjournalled mutation surface appeared, same alarm
    // `test/journal-contract.test.ts`'s KNOWN_GAPS gives for its own, tighter
    // heuristic). Shrinks → update this list, that is the gap closing.
    // Reaching [] here is the goal, not a reason to delete the test.
    const KNOWN_UNLINKED = ["adt/atc.ts", "debug/transport.ts"];
    expect(
      unlinked(),
      "These modules issue conn.put/post/del/raw and neither they nor any module that " +
        "directly imports them so much as MENTIONS the journal. `test/safety-gate-contract." +
        "test.ts` is the same heuristic applied to SafetyGate and it passes — the safety " +
        "gate has a tripwire, the journal does not. That asymmetry is the whole finding: " +
        "a new mutating tool that forgets safety.assert() trips a test; a new mutating " +
        "tool that forgets to journal trips nothing. If this failed because the list GREW, " +
        "that is a real regression, fix the code. If it failed because the list SHRANK, " +
        "update KNOWN_UNLINKED here to match — the gap closed, both.",
    ).toEqual(KNOWN_UNLINKED);
  });
});
