/**
 * Static contract test: every place in `src/` that mutates the ABAP system must
 * be linked to the write journal — or be named, with a reason, in one of the two
 * explicit lists below.
 *
 * Three describes, three different ways journalling goes missing:
 *   1. `journal contract` — a mutation site with no journal write anywhere near it.
 *   2. `JournalOperation coverage` — a kind of entry the read side handles and the
 *      write side never produces (exactly what happened to `abap_activate`'s
 *      entries, below).
 *   3. `composition root wiring` — a tool that CAN journal, registered in
 *      `src/server.ts` without a journal, so the code is correct and inert.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * `test/safety-gate-contract.test.ts` is the tripwire for the safety gate: it
 * exists "specifically so a future write tool … that reaches for
 * `conn.post`/`conn.put` directly cannot silently skip the safety gate without
 * at least tripping this test and forcing a deliberate look" (its own header).
 *
 * The journal had no such tripwire, and the cost of that was:
 * `abap_activate` changed which version of code an ABAP system executes and
 * wrote nothing to the journal, for as long as the tool has existed, while
 * `JournalOperation`'s `"activate"` value, `undoBlocker()`'s refusal for it and
 * three `abap_journal` filters were all maintained for entries no code path in
 * `src/` could produce. Nothing failed. This file is the test that would have.
 *
 * ---------------------------------------------------------------------------
 * THE ALLOWLISTS ARE NOT APPROVAL
 * ---------------------------------------------------------------------------
 *
 * `KNOWN_GAPS` below names mutation sites that journal NOTHING today. They are
 * on that list because they are DEFECTS WITH OPEN ISSUES, not because the
 * behaviour is accepted. The list is meant to SHRINK and must never grow: the
 * whole point of the pattern is that a new unjournalled mutator cannot land
 * without an entry being added here, which is a diff a reviewer sees.
 *
 * If you are about to add a line to `KNOWN_GAPS`, you are about to ship a
 * mutation the operator of the system cannot see afterwards. Journal it instead.
 *
 * `NOT_REPOSITORY_MUTATIONS` is different: those entries are deliberate and
 * permanent. They reach the HTTP write surface but change no repository object,
 * so there is no `JournalOperation` that could describe them. Read each reason
 * before adding to it.
 *
 * ---------------------------------------------------------------------------
 * HOW THE HEURISTIC WORKS (read this before trusting or "fixing" a failure)
 * ---------------------------------------------------------------------------
 *
 * 1. Comments are stripped from every `src/**\/*.ts` file first. This is the
 *    first place this test is deliberately stricter than the audit draft it
 *    replaces (`doc/analysis/journal-completeness-audit.md`, gap G0): this
 *    codebase's doc comments discuss the journal constantly, so a text search
 *    that includes comments scores a pass for `src/adt/write.ts` on the
 *    sentence "the conservative derivation `journal.begin()` performs", and
 *    scores `src/adt/enhancement-write.ts` a pass on a doc comment naming
 *    `withJournalledMutation()` that the file never calls.
 * 2. A file is a MUTATION SITE if, after stripping, it contains either
 *    `<something conn-like>.(put|post|del|raw)(` — same shape as the safety-gate
 *    contract's `CONN_CALL_RE` — or a call to one of the vendor library's
 *    repository-mutating methods (`conn.adt.createObject(`, `conn.adt.activate(`,
 *    …). `src/adt/connection.ts` is excluded: it is the primitive being called.
 *    The vendor clause is future-proofing; as of writing it adds no file the
 *    HTTP clause did not already find, because every module using
 *    `conn.adt.createObject`/`conn.adt.activate` also issues raw verbs.
 * 3. A file is JOURNAL-LINKED if it calls `withJournalledMutation(` (with or
 *    without explicit type arguments) or `<x>journal.begin(` itself, or if a
 *    module PINNED to it in `JOURNALLED_BY` does. Those two calls are the only
 *    ways an entry comes into existence (`Journal.begin` is the sole writer of a
 *    new index line; `withJournalledMutation` wraps it) — mentioning the journal,
 *    importing its types, or plumbing a `journal:` field through a deps object
 *    does NOT count.
 * 4. Anything left over must be in `KNOWN_GAPS` or `NOT_REPOSITORY_MUTATIONS`.
 *
 * ---------------------------------------------------------------------------
 * WHY `JOURNALLED_BY` IS A PINNED MAP AND NOT "ANY DIRECT IMPORTER"
 * ---------------------------------------------------------------------------
 *
 * This codebase's layering puts the journal one level ABOVE the HTTP call:
 * `src/adt/write.ts` issues the PUT, `src/tools/write.ts` wraps it in
 * `withJournalledMutation`. So some cross-module rule is genuinely needed. The
 * safety-gate contract solves the same problem with "any file that directly
 * imports it", and the audit's draft copied that rule — but for the journal that
 * rule LAUNDERS, badly, in a way that is easy to demonstrate:
 *
 *   - `src/server.ts` imports every tool module and calls `journal.begin(`
 *     (the startup transport-create). Under an any-importer rule, EVERY
 *     `src/tools/*.ts` file passes automatically, forever, whatever it does.
 *     That is not a hypothetical: it is exactly why `src/tools/test.ts` scored a
 *     pass in the audit draft.
 *   - `src/tools/enh.ts` journals the enhancement DESCRIPTION write and nothing
 *     else, but imports the enhancement create modules — so under an
 *     any-importer rule the still-unjournalled enhancement-create operations
 *     come out clean.
 *
 * Pinning the pair (mutation site -> the module that journals ITS mutations)
 * costs one line per link, is checked below to still be a real import, and
 * cannot be satisfied by a hub file that happens to journal something else.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROVABLY DOES NOT CATCH
 * ---------------------------------------------------------------------------
 *
 * This is a linkage tripwire, not proof of correct journalling. It does not
 * check, and cannot be made to check by regex:
 *
 *   - THAT EVERY PATH IS JOURNALLED. A module passes if ONE journal write exists
 *     in it or in its pinned partner. `src/adt/write.ts` -> `src/tools/write.ts`
 *     passes as a pair. This blind spot lived here: `src/adt/enhancement-bridge.ts`'s
 *     `activateSpotAndImplementation` POST sat unjournalled under a green pin
 *     for months, hidden behind `tools/enh.ts` genuinely journalling that
 *     module's OTHER five mutations. Now fixed per-call (see the
 *     `JOURNALLED_BY` comment for that pin), and `PINNED_MUTATION_CENSUS`
 *     below narrows the blind spot for every pinned module by pinning a call
 *     COUNT — but a count is not per-call proof either, only a tripwire for a
 *     count that changes; see that map's own doc comment for exactly what it
 *     does and does not buy. Granularity is still the module (or, with the
 *     census, the module's call count), never the individual verb.
 *   - ORDERING. It does not check that the entry is written BEFORE the mutation,
 *     which is the property that makes a crash recoverable. `test/journal.test.ts`
 *     and the before-image contract cover that behaviourally.
 *   - OUTCOME. It does not check that `finish`/`settle` is ever called, so a
 *     mutation whose entry is left `pending` forever still passes.
 *   - CORRECT CONTENT. Wrong `operation`, missing `systemKey` (which would
 *     silently weaken undo's cross-system check to a SID-only fallback that
 *     cannot tell two systems sharing a SID apart), wrong `irreversible`
 *     flag: all invisible here.
 *   - NON-HTTP MUTATION. A mutation issued some way other than `conn.put/post/
 *     del/raw` or the listed vendor methods is not in the corpus at all. The
 *     "not a vacuous pass" test below is the guard for that: it pins the corpus
 *     exactly, so a change that makes a module fall OUT of it (including by
 *     comment-stripping going wrong) fails just as loudly as one that adds to it.
 *   - STALE ALLOWLIST ENTRIES FIXED FROM A CALLER. `KNOWN_GAPS` entries are
 *     re-checked below, but only against files that could plausibly hold the fix
 *     (`watch`). A gap closed from some other module leaves a stale line here; it
 *     is harmless, and removing it is part of closing the issue.
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

/**
 * Comment stripper. Comments must go, because a doc comment that says
 * `withJournalledMutation` or `conn.post()` otherwise makes its file self-pass —
 * `src/adt/write.ts` and `src/adt/enhancement-write.ts` both do exactly that, and
 * a comment mentioning `conn.adt.createObject()` in `src/adt/capabilities.ts`
 * otherwise drags a non-mutating file into the corpus.
 *
 * This is a single-pass scanner rather than two regexes because the regex version
 * is unsound in a way that bites here: the string literal `"application/*"` in
 * `src/tools/test.ts` reads as an unterminated block-comment opener and swallows
 * ~90 lines of real code, including the `TestToolDeps` declaration that the
 * composition-root test further down needs to inspect. Under-stripping hides
 * mutation sites, which is the failure direction a tripwire must not have.
 *
 * String and template bodies are KEPT (only comments are blanked): the
 * `JournalOperation` coverage test below matches string literals like
 * `operation: "activate"`. Comments are replaced by spaces, preserving newlines,
 * so offsets and line counts stay usable and no two tokens get spliced together.
 *
 * Known limitation: it does not track regex literals, so a regex containing an
 * unescaped `//` or `/*` would over-strip. None exists in `src/` today, and the
 * corpus pin in the first test below is the guard — a mutation site that vanishes
 * fails loudly rather than passing silently.
 */
function stripComments(text: string): string {
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (mode === "code") {
      if (c === "/" && d === "*") {
        mode = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "/" && d === "/") {
        mode = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === '"') mode = "double";
      else if (c === "'") mode = "single";
      else if (c === "`") mode = "template";
      out += c;
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") mode = "code";
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && d === "/") {
        mode = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    // Inside a string or template literal: copy through, honouring escapes.
    if (c === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (
      (mode === "double" && c === '"') ||
      (mode === "single" && c === "'") ||
      (mode === "template" && c === "`")
    ) {
      mode = "code";
    }
    out += c;
    i += 1;
  }
  return out;
}

const files = listTsFiles(SRC);
const contents = new Map(files.map((f) => [f, stripComments(readFileSync(f, "utf8"))]));
const rel = (f: string) => relative(SRC, f).split("\\").join("/");
const abs = (r: string) => join(SRC, ...r.split("/"));

// Same shape as test/safety-gate-contract.test.ts's `CONN_CALL_RE` — any dotted
// identifier chain ending in put/post/del/raw, filtered to chains that look like
// a connection.
const CONN_CALL_RE = /([\w$]+(?:\.[\w$]+)*)\.(put|post|del|raw)\(/g;
const isConnLike = (chain: string) => /conn(?:ection)?\b/i.test(chain);

// The vendor library's repository-mutating methods (abap-adt-api's AdtClient).
// `lock`/`unLock` are deliberately absent: an enqueue is not a change to an
// object's content, and every write that takes one is already caught by the
// PUT/POST it wraps.
const VENDOR_MUTATION_RE =
  /\.adt\.(?:createObject|createTestInclude|deleteObject|setObjectSource|activate|createTransport|transportAddUser|transportSetOwner|transportRelease|transportDelete)\(/;

function isMutationSite(text: string): boolean {
  CONN_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONN_CALL_RE.exec(text))) {
    if (isConnLike(m[1])) return true;
  }
  return VENDOR_MUTATION_RE.test(text);
}

/**
 * Same corpus definition as `isMutationSite`, but counts instead of
 * short-circuiting on the first hit: how many mutating wire calls (either
 * shape — `<conn-like>.(put|post|del|raw)(` or a vendor repository-mutating
 * method) does this module make. This is what `PINNED_MUTATION_CENSUS` below
 * pins per module, so a mutating call added to or removed from a
 * `JOURNALLED_BY`-pinned module changes a number instead of passing silently.
 */
function countMutatingCalls(text: string): number {
  let count = 0;
  CONN_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONN_CALL_RE.exec(text))) {
    if (isConnLike(m[1])) count += 1;
  }
  const vendorGlobal = new RegExp(VENDOR_MUTATION_RE.source, "g");
  while ((m = vendorGlobal.exec(text))) count += 1;
  return count;
}

/**
 * The only two ways a journal entry is created. `Journal.begin()` (src/journal.ts)
 * appends the index line; `withJournalledMutation()` is the blessed wrapper that
 * calls it and pairs it with `settle()`. Matched as CALL SHAPES, not mentions:
 * `withJournalledMutation` is allowed an explicit type-argument list because
 * `src/tools/ui.ts` writes `withJournalledMutation<UiPressQuery, UiBridgeResult>(`.
 *
 * Deliberately NOT matched, all of which the audit draft accepted:
 *   - `NO_JOURNAL` — the opt-out marker. Writing the string that says "this is
 *     not journalled" must never score as journalling. (`src/adt/write.ts` and
 *     `src/adt/enhancement-bridge.ts` both use it legitimately, for generated
 *     `$TMP` scaffolding; that is an argument for reading their reasons, not for
 *     letting the token launder a file.)
 *   - `deps.journal` / `journal:` / `journal?:` — plumbing. Passing a `Journal`
 *     into a function proves nothing about whether it is ever written to; every
 *     tool this test is meant to catch would still have had the field.
 *   - `journal.finish(` / `journal.settle(` — these patch an entry that
 *     `begin()` already created, so they cannot exist without it.
 */
const JOURNAL_WRITE_RE = /\bwithJournalledMutation\s*[<(]|[\w$.]*\bjournal\??\.begin\s*\(/;

/** One-hop import graph: file -> the local modules it imports. */
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

const imports = new Map(files.map((f) => [f, new Set(localImportTargets(f, contents.get(f)!))]));

const mutationSites = files.filter((f) => f !== CONNECTION_DEFINITION_FILE).filter((f) => isMutationSite(contents.get(f)!));

/**
 * mutation site -> the module that journals THAT site's mutations.
 *
 * Every pair here is asserted below to still be a real import whose importer
 * still writes to the journal, so a pin cannot rot into a rubber stamp.
 */
const JOURNALLED_BY: ReadonlyMap<string, string> = new Map([
  // `writeObject`/`createObject`/`deleteObject` take a REQUIRED `onBeforeImage`
  // hook (see `NO_JOURNAL` in that file); `abapWrite` supplies it from inside
  // `withJournalledMutation`, which is what writes the create/update/delete
  // entries.
  ["adt/write.ts", "tools/write.ts"],
  // The CTS verbs (create/addUser/setOwner/delete/release). `abapTransport`
  // wraps each in `journal.begin(...)`; `transport-release` is the codebase's
  // original `irreversible: true` producer.
  ["adt/transports.ts", "tools/transport.ts"],
  // The ENHO/ENHS description PUT choreography. `abapEnh` wraps it in
  // `withJournalledMutation`.
  ["adt/enhancement-write.ts", "tools/enh.ts"],
  // The five bridge-backed create/mutate operations (create_spot,
  // add_badi_def, add_filter_def, create_impl, set_filter_values) — each one
  // wrapped in its own `withJournalledMutation` call inside
  // `runEnhCreateOperation` (`tools/enh.ts`), one entry per call,
  // `irreversible: true` throughout.
  //
  // The H23 joint spot+implementation re-activation `setFilterValues`
  // performs internally (`activateSpotAndImplementation`'s own `conn.post` to
  // `/sap/bc/adt/activation`) USED to be the exception this pin's coarseness
  // hid — it mutates a second object (the `ENHS/XS` spot) that the
  // `set_filter_values` entry above does not name, and nothing wrote a record
  // for it. Fixed, not merely re-excused: `activateSpotAndImplementation`
  // now takes a REQUIRED `onBeforeActivation` hook (`adt/enhancement-bridge.ts`),
  // fired immediately before that `conn.post` and outside its try/catch, so a
  // hook that throws aborts the call before any wire request happens.
  // `tools/enh.ts`'s `set_filter_values` handler is the sole caller and wires
  // it to a SECOND, nested `withJournalledMutation` that begins its own
  // `operation: "activate"` entry naming the spot, so that entry lands on disk
  // before the joint POST fires — the same before-the-mutation ordering every
  // other entry in this codebase gets. This is a real per-call fix, not a
  // wider pin: `PINNED_MUTATION_CENSUS` below additionally pins this module's
  // total mutating-call count at 1 (just this POST), so a future SECOND
  // unjournalled call added beside it cannot hide behind this pin the way this
  // one used to. The joint activation is now a two-POST handshake: the
  // second POST is issued by `adt/activate.ts`'s `postActivation`, reached
  // through `activateWithPreauditSet`, on this module's behalf. This module's
  // textual call count stays 1, so the census below does not see that second
  // wire call — a call issued on a module's behalf from a different module is
  // a blind spot of a per-module textual census, not something the count
  // catches. Both journal entries above still land on disk before the FIRST
  // POST fires, hence before the second POST too, so the ordering guarantee
  // `enh-joint-activation-journal.test.ts` pins is unaffected.
  ["adt/enhancement-bridge.ts", "tools/enh.ts"],
  // `create_hook` (the only mutating operation in
  // `runEnhHookOperation`, `tools/enh.ts`) now wraps `createHookImplementation`
  // in `withJournalledMutation` — one `operation: "create"`, `irreversible:
  // true` entry per call, `beforeCapture: "confirmed-absent"` since a normal
  // return only happens after a 201 (createHookImplementation throws
  // otherwise). `discover_hook_anchors`, the module's other export, is
  // read-only and has nothing to journal.
  ["adt/enhancement-hook.ts", "tools/enh.ts"],
  // `activateObject`/`activateObjects`. Journalled by `abapActivate` /
  // `abapActivateBatch` — one `operation: "activate"` entry per
  // object, written before the POST, `irreversible: true`. Before that fix this
  // module was in `KNOWN_GAPS`; it is the reason this file exists.
  ["adt/activate.ts", "tools/activate.ts"],
  // `createBusinessObject`/`putModel`/`deleteBusinessObject`. Journalled by
  // `runBopfEdit`/`runBopfDelete` (`tools/bopf.ts`) — one
  // `operation: "create"|"update"|"delete"` entry per mutation, `irreversible:
  // true` (refused by `undoBlocker()`'s generic catch-all, `adt/undo.ts` —
  // the same one the `DEVC/K` package-create refusal uses — before `planUndo`
  // ever reaches `resolveWriteTarget`, which does not recognise BOPF's
  // `object.type: "BOBF"` either but is never asked; see doc/JOURNAL/undo-and-recovery.md's
  // "Undo semantics" table). Before this fix `adt/bopf.ts` was
  // in `KNOWN_GAPS`. NOTE this pin, like the enhancement-write.ts one above, is
  // coarser than the mutations it covers: the DDIC-cascade candidate deletes
  // `deleteBusinessObject` performs internally (`deleteDdicCandidate`) and the
  // `operation:"activate"` path (`conn.adt.activate` — no mutation of the BO's
  // own model) do NOT get their own entries. Both are deliberate, not gaps —
  // see doc/JOURNAL/journal-format.md's "What is journalled" table. The activate path is now
  // a two-POST handshake: `conn.adt.activate` is phase one, and phase
  // two — sent only when SAP's reply carries an `ioc:inactiveObjects` preaudit
  // set — is a separate `conn.post` from `adt/activate.ts`'s `postActivation`,
  // on this module's behalf. The `runBopfEdit`/`runBopfDelete` journal entry
  // above still lands before the first POST, hence before the second too, so
  // the ordering guarantee is unaffected.
  ["adt/bopf.ts", "tools/bopf.ts"],
]);

/**
 * ---------------------------------------------------------------------------
 * THE CENSUS — closing `JOURNALLED_BY`'s per-mutation blind spot
 * ---------------------------------------------------------------------------
 *
 * The report that reopened this gap, verbatim: "`JOURNALLED_BY` verification is
 * module-granular, not per-function — it greps the module for any
 * `withJournalledMutation(` occurrence... A green pin is module-level
 * evidence, never per-mutation proof." That is exactly how
 * `activateSpotAndImplementation`'s POST sat unjournalled under a green
 * `adt/enhancement-bridge.ts` pin: `tools/enh.ts` genuinely calls
 * `withJournalledMutation(` for that module's OTHER five operations, so the
 * pin was true and useless for this one.
 *
 * The module-level check below cannot become per-mutation without becoming a
 * different, much heavier kind of test (real call-graph analysis, which this
 * file's header already explains a regex corpus cannot do soundly). What it
 * CAN do is stop the exact failure mode that reopen described: a new, unjournalled mutating
 * wire call landing in a pinned module and hiding behind a sibling's
 * `withJournalledMutation(` call.
 *
 * `PINNED_MUTATION_CENSUS` pins the NUMBER of mutating wire calls
 * (`countMutatingCalls`, same corpus definition as `isMutationSite`) inside
 * each module that appears as a key in `JOURNALLED_BY`. When that count
 * changes — up OR down — a call was added or removed, and the test below
 * fails, forcing a reviewer to look rather than trust the pin. This is
 * belt-and-braces the same way "no registrar's deps declare journal as
 * OPTIONAL" is belt-and-braces below: the module-granular pin should not have
 * a blind spot, so this closes the blind spot without pretending to replace
 * the pin.
 *
 * BE HONEST ABOUT WHAT THIS DOES AND DOES NOT BUY:
 *   - It DOES stop a new mutating call from hiding, unnoticed, behind a
 *     sibling call's `withJournalledMutation(` in the same module — the count
 *     changes and the diff is forced into view.
 *   - It does NOT prove any individual call, old or new, is actually
 *     journalled. A count staying the same proves nothing changed; it does
 *     not prove what is there was ever wired correctly. That proof is, and
 *     remains, a human reading the diff and the module's own comments (this
 *     is why the failure message below says "prove it's journalled", not
 *     "bump the number").
 *   - It does NOT distinguish "added a journalled call" from "added an
 *     unjournalled one" — both change the count by the same amount. The
 *     count is a tripwire for review, not a classifier.
 *
 * When this test fails: do not just edit the number to match reality. Find
 * the call that was added or removed, confirm — by reading, the same way
 * every `JOURNALLED_BY` pin above was justified in prose — that it is
 * actually wrapped in `withJournalledMutation(`/`journal.begin(` (directly or
 * via the module's `JOURNALLED_BY` partner), or add it to `KNOWN_GAPS` with
 * an issue number if it genuinely is not journalled yet. Only then update the
 * count, and say why in a comment here, the same way every entry below does.
 */
const PINNED_MUTATION_CENSUS: ReadonlyMap<string, { calls: number; note: string }> = new Map([
  [
    "adt/write.ts",
    {
      calls: 7,
      note:
        "writeObject/createObject/deleteObject's create/update/delete/includes calls: two " +
        "conn.adt.createObject (class + include), conn.post x2 (create-by-post path, includes), " +
        "conn.put (content update), conn.del x2 (delete + include cleanup). All journalled via " +
        "abapWrite's withJournalledMutation (tools/write.ts).",
    },
  ],
  [
    "adt/transports.ts",
    {
      calls: 7,
      note:
        "The CTS verbs: create, add-user, set-owner, release, delete, plus a search/config " +
        "conn.post and a checks conn.post. All journalled via abapTransport's journal.begin " +
        "(tools/transport.ts).",
    },
  ],
  [
    "adt/enhancement-write.ts",
    {
      calls: 2,
      note:
        "The ENHO/ENHS description PUT and its DEL cleanup path. Both journalled via abapEnh's " +
        "withJournalledMutation (tools/enh.ts).",
    },
  ],
  [
    "adt/enhancement-bridge.ts",
    {
      calls: 1,
      note:
        "activateSpotAndImplementation's phase-one conn.post to /sap/bc/adt/activation (H23 joint " +
        "spot+implementation re-activation) — phase two of that handshake is a separate " +
        "conn.post issued by adt/activate.ts's postActivation and is counted there, not here. This " +
        "is the exact call the reopen described above named as hiding, unjournalled, behind tools/enh.ts's " +
        "pin for this module's other five bridge operations — now fixed per-call via a REQUIRED " +
        "onBeforeActivation hook, see the JOURNALLED_BY comment for this module above. If this " +
        "count ever goes up, the new call needs the same scrutiny this one got: read whether it is " +
        "reachable only with a journal entry already begun, the way withJournalledMutation " +
        "structures every other mutation in this codebase.",
    },
  ],
  [
    "adt/enhancement-hook.ts",
    {
      calls: 1,
      note:
        "createHookImplementation's single conn.post (create). Journalled via abapEnh's " +
        "withJournalledMutation (tools/enh.ts).",
    },
  ],
  [
    "adt/activate.ts",
    {
      calls: 2,
      note:
        "activateObject/activateObjects: one conn.post (the batch activation call) and one " +
        "conn.adt.activate (single-object convenience path). Both journalled via abapActivate / " +
        "abapActivateBatch (tools/activate.ts), one operation:\"activate\" entry per object.",
    },
  ],
  [
    "adt/bopf.ts",
    {
      calls: 5,
      note:
        "createBusinessObject/putModel/deleteBusinessObject/deleteDdicCandidate and the " +
        "operation:\"activate\" path: conn.post (create), conn.put (model update), conn.del x2 " +
        "(BO delete + DDIC candidate delete), conn.adt.activate (phase one of the activation " +
        "handshake). Phase two — the second POST SAP's ioc:inactiveObjects preaudit reply " +
        "triggers — is issued by adt/activate.ts's postActivation, reached via " +
        "activateWithPreauditSet, on this module's behalf; it is counted in that module's own " +
        "pin, not here, which is a blind spot of a per-module textual census. Journalled via " +
        "runBopfEdit / runBopfDelete (tools/bopf.ts) — see the JOURNALLED_BY entry above for " +
        "which of these are deliberately NOT given their own entry.",
    },
  ],
]);

interface KnownGap {
  /** Why it is unjournalled, and the issue that tracks it. */
  readonly reason: string;
  /**
   * Modules whose acquiring a journal write means this gap is CLOSED and the
   * entry must be deleted. Keep it to files that would plausibly hold the fix.
   * An empty list means "no automatic staleness signal is possible here":
   * useful when the gap's own module already has a journal write (via its
   * `JOURNALLED_BY` pin) for a DIFFERENT mutation than the one the gap names,
   * so a naive "does this file journal now?" check would false-positive on
   * day one. The now-removed `adt/enhancement-bridge.ts` entry (see the
   * `KNOWN_GAPS` comment above) was exactly this case: `watch: []`, because
   * `tools/enh.ts` already journalled that file's OTHER five mutations, and
   * closing THIS gap needed a human to notice the specific new nested
   * `withJournalledMutation` call, not a regex.
   */
  readonly watch: readonly string[];
}

/**
 * Mutation sites that journal NOTHING. Defects, not decisions. SHRINK ONLY.
 */
const KNOWN_GAPS: ReadonlyMap<string, KnownGap> = new Map([
  // The original "adt/enhancement-hook.ts" entry and "adt/bopf.ts" entry that
  // used to open this map are both gone: this branch fully closes the
  // enhancement-hook.ts gap via the JOURNALLED_BY pin above, and a separately
  // merged fix closes the bopf.ts gap the same way. Neither needs a
  // KNOWN_GAPS entry any more — both mutation sites are now journal-linked,
  // not merely excused.
  //
  // The "adt/enhancement-bridge.ts" entry that used to sit here next is gone
  // too, for the narrow reason it named: `activateSpotAndImplementation`'s
  // joint `POST /sap/bc/adt/activation` (H23 — reached only from
  // `setFilterValues`) now takes a REQUIRED `onBeforeActivation` hook, fired
  // immediately before that POST; `tools/enh.ts`'s `set_filter_values` handler
  // threads it to a SECOND, nested `withJournalledMutation` that begins an
  // `operation: "activate"` entry naming the spot (`ENHS/XS`) before the wire
  // call happens — the object this specific POST mutates and that the outer
  // `operation: "update"` entry (for the implementation) does not name. This
  // is exactly the gap the reopen described above named: a real per-call fix, not
  // a wider pin. See the `JOURNALLED_BY` comment above for this module and
  // `PINNED_MUTATION_CENSUS`'s entry for it below, which now pins this same
  // POST's call count so a future one added beside it cannot hide the same way
  // again.
  [
    "adt/atc.ts",
    {
      reason:
        "no dedicated tracking of its own; grouped under this file's general journal-completeness " +
        "effort. An ATC run POSTs twice — once to CREATE " +
        "an ATC worklist, which is a persistent server-side row, and once to start the run. " +
        "The worklist create is deliberately not routed around the read-only ceiling precisely " +
        "because it leaves state behind (see test/safety-gate-contract.test.ts), and that same " +
        "reasoning says it should be visible in history.",
      watch: ["adt/atc.ts", "tools/atc.ts"],
    },
  ],
]);

/**
 * Mutation sites that are NOT repository mutations. Deliberate and permanent.
 */
const NOT_REPOSITORY_MUTATIONS: ReadonlyMap<string, string> = new Map([
  [
    "tools/test.ts",
    "The ABAP Unit POST to /sap/bc/adt/abapunit/testruns runs existing tests. It creates, " +
      "changes and deletes no repository object, so no `JournalOperation` describes it — the " +
      "same reason `abap_run` does not journal, which the v2 handler states in as many words " +
      "(\"abap_run does not journal, but a preceding activate/write does\"). A test run whose " +
      "ABAP code writes to the database is the tested code's doing, not a repository change. " +
      "NOTE this file passed the audit's draft only by laundering (src/server.ts imports it " +
      "and journals); it is here on its merits instead.",
  ],
  [
    "debug/transport.ts",
    "The debugger transport wrapper. Its post/put/del carry attach, step, stack, variable and " +
      "breakpoint requests — session-scoped debuggee state that vanishes when the session ends. " +
      "No repository object changes, and `JournalOperation` has no value that could describe " +
      "one of these. If a future debugger feature ever writes to the repository (editing a " +
      "source line from the debugger, say), it must journal and this entry must be re-examined.",
  ],
]);

describe("journal contract (heuristic, see file header)", () => {
  it("finds a non-empty, expected set of mutation sites — not a vacuous pass", () => {
    // Ground truth as of writing, and identical to the set
    // test/safety-gate-contract.test.ts pins: everything that reaches the write
    // surface is subject to BOTH contracts. If you are updating this list,
    // update that one too, and say which of the two lists below the new module
    // belongs in — or journal it, which is the outcome this file is asking for.
    expect(mutationSites.map(rel).sort()).toEqual(
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

  it("every mutation site is journal-linked, or explicitly listed with a reason", () => {
    const unaccounted: string[] = [];
    for (const f of mutationSites) {
      const r = rel(f);
      if (JOURNAL_WRITE_RE.test(contents.get(f)!)) continue;
      const pinned = JOURNALLED_BY.get(r);
      if (pinned && JOURNAL_WRITE_RE.test(contents.get(abs(pinned)) ?? "")) continue;
      if (KNOWN_GAPS.has(r) || NOT_REPOSITORY_MUTATIONS.has(r)) continue;
      unaccounted.push(r);
    }
    expect(
      unaccounted,
      `module(s) mutate the ABAP system and nothing writes a journal entry for them: ` +
        `${unaccounted.join(", ")}.\n\n` +
        `If this is a NEW mutating tool: wrap the mutation in withJournalledMutation(...) — see ` +
        `src/tools/write.ts (create/update/delete) or src/tools/activate.ts (activate) — or, if ` +
        `the journal write lives in a caller, add the pair to JOURNALLED_BY in this file.\n\n` +
        `Adding a line to KNOWN_GAPS also silences this, and is the WRONG answer unless you are ` +
        `recording a defect you have opened an issue for. Read this file's header first: an ` +
        `entry there means the operator of the ABAP system cannot see the change afterwards.`,
    ).toEqual([]);
  });

  it("every JOURNALLED_BY pin is a real import whose target really journals", () => {
    const broken: string[] = [];
    for (const [site, journaller] of JOURNALLED_BY) {
      const siteAbs = abs(site);
      const jAbs = abs(journaller);
      if (!contents.has(siteAbs)) {
        broken.push(`${site}: no such file (delete the pin?)`);
        continue;
      }
      if (!contents.has(jAbs)) {
        broken.push(`${site} -> ${journaller}: journaller no longer exists`);
        continue;
      }
      if (!imports.get(jAbs)!.has(siteAbs)) {
        broken.push(`${site} -> ${journaller}: ${journaller} no longer imports it`);
      }
      if (!JOURNAL_WRITE_RE.test(contents.get(jAbs)!)) {
        broken.push(`${site} -> ${journaller}: ${journaller} no longer writes to the journal`);
      }
    }
    expect(
      broken,
      `JOURNALLED_BY pin(s) have rotted: ${broken.join("; ")}. A pin is this file's only ` +
        `cross-module escape hatch, so it is checked rather than trusted. Either restore the ` +
        `link or move the module into KNOWN_GAPS with an issue number.`,
    ).toEqual([]);
  });

  it("every JOURNALLED_BY-pinned module's mutating-call count matches its census — a changed count needs eyes, not a bump", () => {
    // See the doc comment on PINNED_MUTATION_CENSUS above for what this test
    // does and does not prove.
    const drifted: string[] = [];
    const pinnedSites = new Set(JOURNALLED_BY.keys());
    for (const site of pinnedSites) {
      const census = PINNED_MUTATION_CENSUS.get(site);
      if (!census) {
        drifted.push(`${site}: JOURNALLED_BY pins this module but PINNED_MUTATION_CENSUS has no entry for it`);
        continue;
      }
      const actual = countMutatingCalls(contents.get(abs(site)) ?? "");
      if (actual !== census.calls) {
        drifted.push(`${site}: census says ${census.calls}, actually ${actual}`);
      }
    }
    // The reverse direction: a census entry for a module JOURNALLED_BY no
    // longer pins is exactly the "stale allowlist entry" failure mode the
    // KNOWN_GAPS/NOT_REPOSITORY_MUTATIONS staleness check above guards
    // against, applied to this map too.
    const stale = [...PINNED_MUTATION_CENSUS.keys()].filter((site) => !pinnedSites.has(site));
    expect(
      drifted,
      `mutating-call count drift on module(s) pinned in JOURNALLED_BY: ${drifted.join("; ")}.\n\n` +
        `A JOURNALLED_BY pin is checked at the MODULE level: it passes if the pinned module ` +
        `writes to the journal ANYWHERE, not for every mutating call inside it — see this file's ` +
        `header, where activateSpotAndImplementation's POST sat unjournalled under ` +
        `exactly such a green pin. This count exists so that a mutating wire call added to (or ` +
        `removed from) a pinned module cannot land silently: it forces this diff.\n\n` +
        `Do NOT just edit the number in PINNED_MUTATION_CENSUS to make this pass. Find the call ` +
        `that changed, and PROVE it is journalled: read whether it is reachable only once ` +
        `withJournalledMutation(...)/journal.begin(...) has run for it (directly, or via this ` +
        `module's JOURNALLED_BY partner) — the same way every JOURNALLED_BY pin above is justified ` +
        `in prose, not asserted. If it genuinely is not journalled yet, add it to KNOWN_GAPS with ` +
        `an issue number instead of hiding it here. Only once you have done that, update the count ` +
        `and say why in this map's own note, the way every existing entry does.\n\n` +
        `Stale census entries (module no longer in JOURNALLED_BY): ${stale.join(", ") || "(none)"}.`,
    ).toEqual([]);
    expect(stale, `PINNED_MUTATION_CENSUS entry(s) for module(s) JOURNALLED_BY no longer pins: ${stale.join(", ")}. Delete the entry.`).toEqual([]);
  });

  it("every listed module is still a mutation site (no stale entries)", () => {
    const live = new Set(mutationSites.map(rel));
    const stale = [...KNOWN_GAPS.keys(), ...NOT_REPOSITORY_MUTATIONS.keys()].filter((r) => !live.has(r));
    expect(
      stale,
      `listed module(s) no longer mutate anything: ${stale.join(", ")}. Delete the entry — a ` +
        `list of exceptions that outlives the code it excuses is how an allowlist stops being read.`,
    ).toEqual([]);
  });

  it("KNOWN_GAPS shrinks: no gap whose watched modules now journal", () => {
    const closed: string[] = [];
    for (const [site, gap] of KNOWN_GAPS) {
      const fixed = gap.watch.filter((w) => JOURNAL_WRITE_RE.test(contents.get(abs(w)) ?? ""));
      if (fixed.length) closed.push(`${site} (now journalled in ${fixed.join(", ")})`);
    }
    expect(
      closed,
      `gap(s) look CLOSED: ${closed.join("; ")}. This is good news and a required chore: remove ` +
        `the KNOWN_GAPS entry, and if the journal write lives in a caller add the pair to ` +
        `JOURNALLED_BY so the link stays checked. KNOWN_GAPS is meant to shrink to empty.`,
    ).toEqual([]);
  });

  it("JOURNAL_WRITE_RE actually matches the real journal write sites", () => {
    // Guards against the regex silently ceasing to match anything (a rename of
    // `withJournalledMutation`, say), which would turn every check above into a
    // check of KNOWN_GAPS membership alone.
    const writers = files.filter((f) => JOURNAL_WRITE_RE.test(contents.get(f)!)).map(rel).sort();
    expect(writers).toContain("journal.ts");
    expect(writers).toContain("tools/write.ts");
    expect(writers).toContain("tools/transport.ts");
    expect(writers).toContain("tools/activate.ts");
    expect(writers.length).toBeGreaterThanOrEqual(6);
  });
});

/**
 * The read-side half of the abap_activate journalling gap, generalised.
 *
 * `JournalOperation` declared `"activate"` and no site in `src/` ever built one.
 * The value was not dead code in the usual sense — `undoBlocker()` refused it by
 * name and three `abap_journal` filters accepted it — it was worse: a vocabulary
 * the read side maintained for records the write side never produced, so the
 * absence read as "nothing was activated" rather than as a bug.
 *
 * This pins the inverse: every declared operation must be constructed somewhere
 * that actually writes to the journal.
 *
 * SCOPE, honestly: it matches `operation: "<value>"` inside a file that contains
 * a journal write, excluding src/journal.ts (the declaration itself) and
 * src/adt/undo.ts (which only READS operations back). That is not proof — the
 * same key appears on ADT error contexts and on `SafetyGate` calls — but the
 * exclusion to journal-writing files makes a coincidence unlikely, and for the
 * six values that matter most (`activate` and the five `transport-*`) the literal
 * is unambiguous in this codebase. It is also one-directional: it cannot see a
 * value built by a ternary, which `src/tools/write.ts` does
 * (`operation: img.existed ? "update" : "create"`), so a value it reports as
 * covered may be covered from somewhere else entirely.
 */
const JOURNAL_OPERATIONS = [
  "create",
  "update",
  "delete",
  "activate",
  "transport-create",
  "transport-add-user",
  "transport-set-owner",
  "transport-delete",
  "transport-release",
] as const;

describe("JournalOperation coverage", () => {
  it("matches the union declared in src/journal.ts", () => {
    const decl = readFileSync(join(SRC, "journal.ts"), "utf8");
    const block = /export type JournalOperation =([\s\S]*?);/.exec(decl);
    expect(block, "could not find the JournalOperation declaration in src/journal.ts").toBeTruthy();
    const declared = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(
      declared.sort(),
      `JournalOperation's values have changed. Add the new value to JOURNAL_OPERATIONS in this ` +
        `test, and make sure something actually WRITES it — an operation nothing constructs is ` +
        `the exact defect abap_activate's activate entries once had, happening again.`,
    ).toEqual([...JOURNAL_OPERATIONS].sort());
  });

  it("every declared operation is constructed by a module that writes to the journal", () => {
    const writers = files.filter(
      (f) => JOURNAL_WRITE_RE.test(contents.get(f)!) && !/[/\\](journal|undo)\.ts$/.test(f),
    );
    const missing: string[] = [];
    for (const op of JOURNAL_OPERATIONS) {
      const re = new RegExp(`operation:\\s*"${op}"`);
      if (!writers.some((f) => re.test(contents.get(f)!))) missing.push(op);
    }
    expect(
      missing,
      `JournalOperation value(s) that no journal-writing module constructs: ${missing.join(", ")}. ` +
        `That is the same shape as before: the undo path and the abap_journal filters keep ` +
        `handling a kind of entry nothing can produce, so its absence from history reads as ` +
        `"it never happened". Either write the entry or delete the value.`,
    ).toEqual([]);
  });
});

/**
 * ---------------------------------------------------------------------------
 * THE COMPOSITION ROOT: a tool that CAN journal, registered so that it DOESN'T
 * ---------------------------------------------------------------------------
 *
 * The two describes above ask "does this module journal?". This one asks the
 * question that half of a journalling fix can still fail: "is the journal
 * actually wired to it in the running server?".
 *
 * This is not hypothetical. BOPF's journalling fix was written,
 * tested and correct, and inert in production, because `src/server.ts`'s
 * `registerBopfTools(mcp, { … })` call did not pass `journal` and
 * `BopfToolDeps.journal` was declared OPTIONAL. Optionality is the whole problem:
 * `npx tsc --noEmit` is silent, every unit test passes (they construct their own
 * deps), the tool runs, and nothing is recorded. There is no compiler error to
 * find because there is no compile error.
 *
 * So: if a registrar's deps type declares a `journal` field, `src/server.ts` must
 * pass one. `extends` chains are followed, since `BopfToolDeps extends
 * BopfRunDeps`.
 *
 * THE BETTER FIX, where it is available, is to declare the field REQUIRED
 * (`readonly journal: Journal`) — then tsc catches the omission and this test is
 * belt-and-braces. `ActivateToolDeps` (required once the activate gap was
 * fixed) and `V2ToolDeps` are required for
 * exactly that reason. Optional stays legitimate for deps types shared with call
 * sites that genuinely have no journal, which is why this check exists at all.
 *
 * WHAT IT DOES NOT CATCH: a registrar that receives a journal and never uses it
 * (the describes above are the guard for that); a tool registered from somewhere
 * other than `src/server.ts`; and a deps type that reaches the journal under some
 * name other than `journal`.
 */
const SERVER_FILE = join(SRC, "server.ts");

/** Text between the parens of a call whose `(` is at `openIdx`. */
function callArguments(text: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return "";
}

/** Body text of an `interface`/`type` declaration, plus the names it extends. */
function declarationOf(typeName: string): { body: string; extends: string[] } | undefined {
  const re = new RegExp(`\\b(?:interface|type)\\s+${typeName}\\b([^{]*)\\{`);
  for (const f of files) {
    const text = contents.get(f)!;
    const m = re.exec(text);
    if (!m) continue;
    const heritage = [...m[1].matchAll(/\b([A-Z]\w*)\b/g)].map((h) => h[1]);
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) return { body: text.slice(open + 1, i), extends: heritage };
      }
    }
  }
  return undefined;
}

const JOURNAL_FIELD_RE = /(?:^|[{;,])\s*(?:readonly\s+)?journal(\??)\s*:/m;

type JournalDecl = "required" | "optional" | "none";

/** How `typeName` (or anything it extends) declares its `journal` field. */
function depsDeclareJournal(typeName: string, seen = new Set<string>()): JournalDecl | undefined {
  if (seen.has(typeName)) return "none";
  seen.add(typeName);
  const decl = declarationOf(typeName);
  if (!decl) return undefined;
  const own = JOURNAL_FIELD_RE.exec(decl.body);
  if (own) return own[1] === "?" ? "optional" : "required";
  for (const parent of decl.extends) {
    const inherited = depsDeclareJournal(parent, seen);
    if (inherited === "required" || inherited === "optional") return inherited;
  }
  return "none";
}

interface Registration {
  readonly registrar: string;
  readonly depsType: string | undefined;
  readonly declaresJournal: JournalDecl | undefined;
  readonly passesJournal: boolean;
}

function collectRegistrations(): Registration[] {
  const server = contents.get(SERVER_FILE)!;
  const re = /\bregister([A-Z]\w*)\s*\(/g;
  const out: Registration[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(server))) {
    const registrar = `register${m[1]}`;
    const args = callArguments(server, re.lastIndex - 1);
    // Only tool registrations: `registerX(mcp, { … })`. Skips local helpers and
    // `mcp.registerTool(...)`, whose first argument is a tool name string.
    if (!/^\s*mcp\b/.test(args)) continue;
    if (seen.has(registrar)) continue;
    seen.add(registrar);
    // The registrar's own signature tells us the deps type.
    const sigRe = new RegExp(`export function ${registrar}\\s*\\(`);
    let depsType: string | undefined;
    for (const f of files) {
      const text = contents.get(f)!;
      const sig = sigRe.exec(text);
      if (!sig) continue;
      const params = callArguments(text, sig.index + sig[0].length - 1);
      depsType = /deps\s*:\s*([\w.]+)/.exec(params)?.[1];
      break;
    }
    out.push({
      registrar,
      depsType,
      declaresJournal: depsType === undefined ? undefined : depsDeclareJournal(depsType),
      passesJournal: /\bjournal\b/.test(args),
    });
  }
  return out;
}

const registrations = collectRegistrations();

describe("composition root wiring (src/server.ts)", () => {
  it("resolves every registrar to a deps type — not a vacuous pass", () => {
    // If the parse breaks (a renamed registrar convention, a deps type that moves
    // behind a generic), every registrar silently becomes "nothing to check". Fail
    // instead. The count is a floor, not a pin, so adding a tool does not fail here
    // — it fails in the check below if the tool can journal and was not given one.
    expect(registrations.length, "no registerXTools(mcp, …) call sites found in src/server.ts").
      toBeGreaterThanOrEqual(15);
    const names = registrations.map((r) => r.registrar);
    expect(names).toContain("registerWriteTools");
    expect(names).toContain("registerActivateTools");
    expect(names).toContain("registerBopfTools");
    const unresolved = registrations
      .filter((r) => r.depsType === undefined || r.declaresJournal === undefined)
      .map((r) => `${r.registrar} (deps: ${r.depsType ?? "unknown"})`)
      .sort();
    expect(
      unresolved,
      `could not resolve the deps type of: ${unresolved.join(", ")}. These registrars are ` +
        `NOT being checked for journal wiring. Teach declarationOf()/collectRegistrations() ` +
        `about the new shape rather than leaving a hole.`,
    ).toEqual([]);
    // At least one registrar must both declare and receive a journal, or the
    // check below is trivially satisfiable.
    expect(
      registrations.filter((r) => r.declaresJournal === "required" && r.passesJournal).length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("every registrar whose deps declare a journal is registered with one", () => {
    const unwired = registrations
      .filter((r) => (r.declaresJournal === "required" || r.declaresJournal === "optional") && !r.passesJournal)
      .map((r) => `${r.registrar} (deps: ${r.depsType})`)
      .sort();
    expect(
      unwired,
      `registrar(s) whose deps type declares a \`journal\` field, registered in src/server.ts ` +
        `WITHOUT one: ${unwired.join(", ")}. The tool's journalling code is dead in the running ` +
        `server: it takes the optional dep, finds it undefined, and mutates the system with no ` +
        `record. tsc cannot see this while the field is optional — that is why this test exists ` +
        `(it is the exact failure mode BOPF's journalling fix shipped with). Pass \`journal\` at the call site, and ` +
        `consider making the field required so the compiler enforces it next time.`,
    ).toEqual([]);
  });

  it("no registrar's deps declare the journal as OPTIONAL", () => {
    // The check above is a safety net for a hole that should not exist in the
    // first place. A `journal?:` on a registrar's deps says "this tool may run
    // with no history", and nothing in this codebase means that: journalling
    // being switched off is modelled INSIDE `Journal` (`enabled: false`), not by
    // the absence of the object. Every time the field has been optional here it
    // has been omitted at the call site and silently lost entries —
    // `TransportToolDeps`, `EnhToolDeps` and `BopfRunDeps` all carry that history
    // in their own doc comments. Required makes it a build error.
    const optional = registrations
      .filter((r) => r.declaresJournal === "optional")
      .map((r) => `${r.registrar} (deps: ${r.depsType})`)
      .sort();
    expect(
      optional,
      `registrar deps type(s) declaring \`journal?:\` optional: ${optional.join(", ")}. Make the ` +
        `field required (\`readonly journal: Journal\`) so an unwired call site fails to COMPILE ` +
        `instead of failing silently at runtime. If a caller genuinely has no journal, hand it a ` +
        `disabled one (\`new Journal({ enabled: false, … })\`) — that is what \`enabled\` is for. ` +
        `This rule has no allowlist on purpose.`,
    ).toEqual([]);
  });
});
