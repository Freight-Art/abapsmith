/**
 * Durable negative control for review finding 13.
 *
 * Response and error bodies used to be truncated at four different sites
 * with four different limits, and two of them cut silently — no ellipsis,
 * no marker, no indication anything was lost. An ABAP short dump can run to
 * 165 KB, so every attempt to diagnose an outstanding HTTP 500 produced a
 * silently-cut body. All truncation now goes through the shared helper in
 * src/truncate.ts, whose marker is mandatory and cannot be suppressed by a
 * caller. This suite guards that invariant three ways: (1) it proves the
 * source sweep actually reads every file it claims to cover, (2) it scans
 * that source tree for any hand-rolled cap that is not visibly disclosed to
 * the caller, and (3) it asserts the helper itself never drops content
 * without marking it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SWEEP LOOKS THE WAY IT DOES (finding C4 — "the guard was blind")
 * ---------------------------------------------------------------------------
 *
 * The previous version of this sweep was blind in three ways, all fixed here:
 *
 *  1. Its pattern matched only INTEGER LITERALS, so `.slice(0, MAX_ROWS)`,
 *     `.slice(0, max)` and `.slice(0, budget - 1)` sailed straight through.
 *     The pattern below matches named constants, plain identifiers and
 *     computed expressions as well (see LIMIT_LOOKS_LIKE_A_CAP).
 *
 *  2. It carried WHOLE-FILE exemptions for `src/compact.ts` and
 *     `src/tools/debug.ts` — the two files where truncation actually happens.
 *     Whole-file exemptions are gone. Everything is now a line-level
 *     allowlist entry with a written justification (ALLOWED_LINES).
 *
 *  3. It had no coverage proof, so a broken walk / glob / filter could have
 *     scanned nothing and still reported green. `scannedFiles()` is now
 *     asserted non-empty AND asserted to contain specific known files.
 *
 * A fourth concern was raised: that a repo-wide sweep reading sources via
 * grep/rg would silently SKIP `src/debug/session.ts`, because grep classifies
 * a file containing raw NUL bytes as binary and prints nothing. That failure
 * mode cannot occur here and must never be reintroduced: this sweep reads
 * sources with `node:fs` and splits lines at the BYTE level before decoding,
 * so a NUL byte is just another byte in a line. `readSourceLines` and the
 * NUL-robustness tests below pin that. Never rewrite this sweep as a shell
 * pipeline.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_BODY_MAX,
  DUMP_SHORT_TEXT_MAX,
  ECHO_LINE_MAX,
  MESSAGE_EXCERPT_MAX,
  PARSE_EXCERPT_MAX,
  isTruncated,
  truncateDiagnosticBody,
  truncateText,
} from "../src/truncate.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const srcDir = join(repoRoot, "src");

// ---------------------------------------------------------------------------
// File discovery + reading. Node only — never a shell pipeline (see header).
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function toRel(absPath: string): string {
  return relative(repoRoot, absPath).split("\\").join("/");
}

/** Every source file the sweep covers, as repo-relative paths, sorted. */
function scannedFiles(): string[] {
  return walk(srcDir).map(toRel).sort();
}

/**
 * Read a source file into lines WITHOUT letting any byte value cause the file
 * (or a line) to be skipped or silently mis-read.
 *
 * The split happens on the raw buffer at byte 0x0A, then each line is decoded
 * individually. A NUL byte (0x00) therefore survives into the decoded line as
 * U+0000 and is scanned like any other character — it can neither truncate the
 * read nor mark the file "binary". This is the concrete reason the sweep must
 * stay in Node: `grep`/`rg` would classify such a file as binary and skip it
 * without saying so.
 */
function readSourceLines(absPath: string): { lines: string[]; nulBytes: number } {
  const buf = readFileSync(absPath);
  const lines: string[] = [];
  let start = 0;
  let nulBytes = 0;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte === 0x00) nulBytes++;
    if (byte === 0x0a) {
      lines.push(buf.subarray(start, i).toString("utf8"));
      start = i + 1;
    }
  }
  lines.push(buf.subarray(start).toString("utf8"));
  return { lines, nulBytes };
}

// ---------------------------------------------------------------------------
// What counts as a hand-rolled cap, and what counts as disclosing it.
// ---------------------------------------------------------------------------

/**
 * Two-argument prefix caps: `x.slice(0, L)`, `x.substring(0, L)`,
 * `x.substr(0, L)`. Capture group 2 is the limit expression, which may be an
 * integer literal, a named constant, an identifier or an expression.
 *
 * Deliberately NOT matched: single-argument `x.slice(n)`. In this repo that
 * form is always either prefix-skipping in a parser (`rest.slice(kw.length)`)
 * or extracting the DROPPED tail so it can be disclosed
 * (`parts.rows.slice(kept.length)` feeding an `elide()`), never a cap. Also
 * not matched: `x.slice(a, b)` with a non-zero start, which is a window, not
 * a truncation — windows report their own `total` (see `sliceLines`).
 */
const PREFIX_CAP = /\.(slice|substring|substr)\(\s*0\s*,\s*([^)]*(?:\([^)]*\)[^)]*)*)\)/g;

/** In-place truncations: `arr.splice(n)` (single arg) and `arr.length = n`. */
const IN_PLACE_CAP = /\.splice\(\s*([A-Za-z_$][\w$.]*|\d+)\s*\)|\.length\s*=\s*([^=;]+);/g;

/**
 * Markers that DISCLOSE a truncation to the caller. Two tiers, because a
 * marker sitting near a cap does not automatically describe that cap.
 *
 * SAME-LINE: any of this repo's truncation vocabulary on the flagged line
 * itself is proof the cap is the marked one — e.g. src/truncate.ts's
 * `safeText.slice(0, limit) + truncationMarker(...)`.
 */
const SAME_LINE_MARKER =
  /truncationMarker|truncateText|truncateDiagnosticBody|truncateForDisplay|isTruncated|isDisplayTruncated|DISPLAY_ELLIPSIS|TRUNCAT|elide\(|buildRetrievalCall/;

/**
 * NEARBY (within MARKER_WINDOW lines): only STRUCTURAL disclosure emitters
 * count — constructs whose whole job is to tell the caller something was
 * dropped and how to get it. Notably `truncateForDisplay` is NOT here: it
 * shortens one table cell, and its presence a few lines away says nothing
 * about a row-count cap. That distinction is what makes
 * src/tools/search.ts:100 visible instead of accidentally suppressed.
 */
const NEARBY_STRUCTURAL_MARKER = /elide\(|buildRetrievalCall|TRUNCATED|truncationMarker|totalLines|bodyTotalLines/;

const MARKER_WINDOW = 6;

/**
 * A limit expression that looks like a CAP rather than a parser offset:
 *   - an integer literal >= 50 (a small literal is an offset or a hash prefix),
 *   - a SCREAMING_SNAKE named constant (`MAX_ROWS`, `HASH_LEN`, …),
 *   - a lower-camel limit word (`max`, `limit`, `budget`, `cap`, `kept`, `n`, …),
 *     including through a property access such as `opts.limit`.
 *
 * `Math.max` / `Math.min` are stripped first: `lines.slice(Math.max(0, a), b)`
 * is a window, and the literal token "max" in it means nothing.
 *
 * Known residual gap, accepted deliberately: a cap whose limit is an
 * identifier with none of these shapes (say `.slice(0, howMany)`) is not
 * flagged. Widening further flags every parser offset in the tree, which
 * would push this suite back toward whole-file exemptions — the exact failure
 * mode C4 was about.
 */
function limitLooksLikeACap(rawLimit: string): boolean {
  const limit = rawLimit.replace(/Math\.(max|min)/g, "").trim();
  if (limit.length === 0) return false;

  const asInt = /^\d+$/.test(limit) ? Number(limit) : undefined;
  if (asInt !== undefined) return asInt >= 50;

  if (/\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b/.test(limit)) return true;
  if (/(^|[^A-Za-z])(max|limit|budget|cap|capped|kept|quota|top|count|size|n)([^A-Za-z]|$)/i.test(limit)) {
    return true;
  }
  return false;
}

interface Offense {
  relPath: string;
  lineNumber: number;
  line: string;
  limit: string;
}

/**
 * The per-line predicate the scan is built on. Factored out so the self-tests
 * below (the "guard for the guard") exercise the exact same logic the real
 * scan uses, rather than a hand-copied approximation of it.
 *
 * `context` is the surrounding +/- MARKER_WINDOW lines, joined.
 */
function findUndisclosedCaps(line: string, context: string): string[] {
  const hits: string[] = [];
  const disclosedHere = SAME_LINE_MARKER.test(line);
  const disclosedNearby = NEARBY_STRUCTURAL_MARKER.test(context);

  PREFIX_CAP.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PREFIX_CAP.exec(line)) !== null) {
    const limit = (match[2] ?? "").trim();
    if (!limitLooksLikeACap(limit)) continue;
    if (disclosedHere || disclosedNearby) continue;
    hits.push(limit);
  }

  IN_PLACE_CAP.lastIndex = 0;
  while ((match = IN_PLACE_CAP.exec(line)) !== null) {
    const limit = (match[1] ?? match[2] ?? "").trim();
    if (!limitLooksLikeACap(limit)) continue;
    if (disclosedHere || disclosedNearby) continue;
    hits.push(limit);
  }

  return hits;
}

function contextAround(lines: string[], i: number): string {
  const from = Math.max(0, i - MARKER_WINDOW);
  const to = Math.min(lines.length, i + MARKER_WINDOW + 1);
  return lines.slice(from, to).join("\n");
}

function scanForHandRolledTruncation(): Offense[] {
  const offenses: Offense[] = [];

  for (const relPath of scannedFiles()) {
    const { lines } = readSourceLines(join(repoRoot, relPath));
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const limit of findUndisclosedCaps(line, contextAround(lines, i))) {
        offenses.push({ relPath, lineNumber: i + 1, line: line.trim(), limit });
      }
    }
  }

  return offenses;
}

// ---------------------------------------------------------------------------
// Allowlist — LINE level only. No whole-file exemptions, ever: excluding a
// whole file is how this guard stopped guarding the only two files that
// truncate. Each entry is matched by a distinctive substring of the offending
// line (not a line number), so an unrelated edit above it does not silently
// re-open or stale the entry. Every entry carries a written justification.
// ---------------------------------------------------------------------------

const ALLOWED_LINES: { file: string; contains: string; reason: string }[] = [
  {
    file: "src/adt/icf-classify.ts",
    contains: "body.slice(0, AUTH_MARKER_SCAN_BYTES)",
    reason:
      "Scan window for ICF-logon marker regexes. The sliced value is tested and discarded — never stored, returned or displayed — so nothing is withheld from the caller.",
  },
  {
    file: "src/adt/session.ts",
    contains: "body.slice(0, SESSION_MARKER_SCAN_BYTES)",
    reason:
      "Scan window for short-dump marker regexes in classifySessionFailure. Tested and discarded; the body itself is still passed on in full to truncateDiagnosticBody downstream.",
  },
  {
    file: "src/adt/run.ts",
    contains: 'digest("hex").slice(0, HASH_LEN)',
    reason:
      "Hash prefix, not content. Shortening a sha256 hex digest to a fixed identifier width drops no caller-visible information.",
  },
  {
    file: "src/adt/run.ts",
    contains: "safe.slice(0, budget - HASH_LEN - 1)",
    reason:
      "ABAP's 30-char object-name limit. The dropped tail IS disclosed, structurally: the truncated stem is always suffixed with `_<6 hex of the full name>`, so the generated bridge class name visibly differs from the report name and cannot collide.",
  },
  {
    file: "src/adt/object-gate.ts",
    contains: 'digest("hex").slice(0, LOCK_HASH_HEX_LEN)',
    reason:
      "Hash prefix, not content — the object-lock FILENAME width, same rationale as run.ts's HASH_LEN. It reached this list by being named: as a bare `.slice(0, 20)` it fell under the <50 integer-literal exemption above and was never scanned, so the justification lived nowhere.",
  },
  {
    file: "src/debug/arm-lock.ts",
    contains: 'digest("hex").slice(0, LOCK_HASH_HEX_LEN)',
    reason:
      "Hash prefix, not content — the debug-arm-lock FILENAME width, identical rationale (and identical constant) to object-gate.ts's entry above. The hashed input is the (url, client, user) lock key, which is never shown to a caller; the key itself is reported in full in DEBUG_SESSION_LOCKED_CROSS_PROCESS's details.",
  },
  {
    file: "src/debug/client.ts",
    contains: 'digest("hex").slice(0, TERMINAL_ID_LENGTH)',
    reason:
      "Hash prefix used as a synthetic ADT terminal id. Derived identifier, not caller content.",
  },
  {
    file: "src/adt/bopf-runtime.ts",
    contains: 'digest("hex").slice(0, HASH_LEN)',
    reason:
      "Hash prefix, not content — same rationale as run.ts's identical line: shortening a sha256 hex digest to a fixed identifier width drops no caller-visible information.",
  },
  {
    file: "src/adt/bopf-runtime.ts",
    contains: "safe.slice(0, budget - HASH_LEN - 1)",
    reason:
      "ABAP's 30-char object-name limit, BOPF bridge-class variant of run.ts's identical guard. The dropped tail IS disclosed, structurally: the truncated stem is always suffixed with `_<6 hex of the full name>`, so the generated bridge class name visibly differs from the BO name and cannot collide.",
  },
  {
    file: "src/journal.ts",
    contains: "entries.slice(0, opts.limit)",
    reason:
      "Caller-supplied `limit` on Journal.list(): the caller asked for exactly N and receives exactly N, so there is nothing it does not already know. Not a budget the caller cannot see.",
  },
  {
    file: "src/debug/render.ts",
    contains: "reachableTexts.slice(0, kept).reduce",
    reason:
      "Pure arithmetic inside `blockLen` — it prices a candidate `kept` for the fit search and renders nothing. The output built from the same `kept` is `buildBlock`, whose omitted tail is disclosed by collapseLine()/elide() a few lines above.",
  },
];

function allowedReason(relPath: string, line: string): string | undefined {
  return ALLOWED_LINES.find((e) => e.file === relPath && line.includes(e.contains))?.reason;
}

describe("no silent truncation (review finding 13)", () => {
  // -------------------------------------------------------------------------
  // (0) COVERAGE PROOF. Without this a broken walk scans nothing and reports
  //     green — the sweep must never again be able to claim coverage it does
  //     not have.
  // -------------------------------------------------------------------------

  it("proves the sweep actually reads the files it claims to cover", () => {
    const files = scannedFiles();

    expect(files.length, "the source sweep scanned NO files — the walk is broken").toBeGreaterThan(0);
    expect(files.length, "the source sweep scanned suspiciously few files").toBeGreaterThanOrEqual(20);

    // Specific known files, including every file that actually truncates and
    // the file whose NUL-escape content once made grep-based sweeps blind.
    for (const required of [
      "src/debug/session.ts",
      "src/compact.ts",
      "src/tools/debug.ts",
      "src/truncate.ts",
      "src/debug/render.ts",
      "src/adt/source.ts",
      "src/tools/search.ts",
    ]) {
      expect(files, `${required} must be inside the swept set`).toContain(required);
    }

    // Every scanned file must actually yield content. A file that reads as
    // zero lines is a silent skip wearing a coverage badge.
    for (const relPath of files) {
      const { lines } = readSourceLines(join(repoRoot, relPath));
      expect(lines.length, `${relPath} produced no lines — it was not really read`).toBeGreaterThan(0);
      expect(
        lines.join("\n").trim().length,
        `${relPath} read as empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("reads NUL bytes as content instead of skipping the file (the grep blind spot)", () => {
    // 1. Nothing in src/ is skipped for byte reasons; report NUL counts.
    const withNul: string[] = [];
    for (const relPath of scannedFiles()) {
      const { lines, nulBytes } = readSourceLines(join(repoRoot, relPath));
      expect(lines.length).toBeGreaterThan(0);
      if (nulBytes > 0) withNul.push(`${relPath} (${nulBytes} NUL bytes)`);
    }
    // Informational, not an assertion about the current tree: whatever the
    // count is, the file was still scanned above.
    expect(Array.isArray(withNul)).toBe(true);

    // 2. The reader itself must survive real NUL bytes mid-line: a NUL must
    //    not end a line, hide the rest of it, or hide the rest of the file.
    const nul = "\u0000";
    const synthetic = `const a = 1;\nconst hidden = body.slice(0, MAX_BODY);${nul}${nul}\nconst z = 2;\n`;
    const bytes = Buffer.from(synthetic, "utf8");
    expect(bytes.includes(0x00), "fixture must contain real NUL bytes").toBe(true);

    const decoded: string[] = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0x0a) {
        decoded.push(bytes.subarray(start, i).toString("utf8"));
        start = i + 1;
      }
    }
    decoded.push(bytes.subarray(start).toString("utf8"));

    expect(decoded.length).toBe(4);
    expect(decoded[2]).toBe("const z = 2;"); // content AFTER the NULs survives
    expect(findUndisclosedCaps(decoded[1]!, decoded.join("\n"))).toEqual(["MAX_BODY"]);
  });

  // -------------------------------------------------------------------------
  // (1) THE SWEEP.
  // -------------------------------------------------------------------------

  it("flags no hand-rolled, undisclosed cap on bodies, diagnostic text or result lists in src/", () => {
    const offenses = scanForHandRolledTruncation();
    const unreviewed = offenses.filter((o) => allowedReason(o.relPath, o.line) === undefined);

    if (unreviewed.length > 0) {
      const details = unreviewed
        .map((o) => `${o.relPath}:${o.lineNumber}  [limit: ${o.limit}]\n    ${o.line}`)
        .join("\n");
      expect.fail(
        "Found hand-rolled truncation with no disclosure to the caller:\n" +
          details +
          "\n\nEither route it through src/truncate.ts / compact.ts's TRUNCATED block /\n" +
          "render.ts's elide(), or add a LINE-level ALLOWED_LINES entry with a written\n" +
          "justification. Do NOT exempt the whole file — that is how this guard went\n" +
          "blind in the first place (finding C4).",
      );
    }

    expect(unreviewed).toEqual([]);
  });

  it("keeps the allowlist honest: every entry still matches a real line", () => {
    const offenses = scanForHandRolledTruncation();
    for (const entry of ALLOWED_LINES) {
      const matched = offenses.some(
        (o) => o.relPath === entry.file && o.line.includes(entry.contains),
      );
      expect(
        matched,
        `Stale allowlist entry: ${entry.file} no longer contains "${entry.contains}". ` +
          "Delete the entry rather than leaving it to shelter a future cap.",
      ).toBe(true);
      expect(entry.reason.trim().length, `${entry.file} allowlist entry needs a reason`).toBeGreaterThan(20);
    }
  });

  // -------------------------------------------------------------------------
  // (2) GUARD FOR THE GUARD — the predicate must still bite.
  // -------------------------------------------------------------------------

  it("guard for the guard: catches integer, named-constant, variable and computed limits", () => {
    const cases: [string, string][] = [
      ["const shown = body.slice(0, 4000);", "4000"],
      ["const shown = body.slice(0, MAX_BODY_CHARS);", "MAX_BODY_CHARS"],
      ["const rows = all.slice(0, max);", "max"],
      ["const rows = all.slice(0, opts.limit);", "opts.limit"],
      ["const keep = text.slice(0, budget - 10);", "budget - 10"],
      ["const head = text.substring(0, LIMIT);", "LIMIT"],
      ["const head = text.substr(0, n);", "n"],
      ["frames.splice(MAX_FRAMES);", "MAX_FRAMES"],
      ["frames.length = MAX_FRAMES;", "MAX_FRAMES"],
    ];
    for (const [line, limit] of cases) {
      expect(findUndisclosedCaps(line, line), `should flag: ${line}`).toEqual([limit]);
    }
  });

  it("guard for the guard: a disclosed cap does not flag, but an unrelated marker does not excuse one", () => {
    const capped = "const capped = visible.slice(0, 50);";

    // Same-line disclosure.
    expect(findUndisclosedCaps("return t.slice(0, limit) + truncationMarker(limit, t.length);", "")).toEqual([]);

    // Structural disclosure a few lines below (the src/tools/debug.ts shape).
    const disclosed = [capped, "const rest = visible.length - capped.length;", "if (rest > 0) {", 'lines.push(elide("frames", rest, call));'].join("\n");
    expect(findUndisclosedCaps(capped, disclosed)).toEqual([]);

    // An UNRELATED truncation helper nearby must NOT suppress a list cap —
    // this is the src/tools/search.ts:100 shape, where truncateForDisplay
    // shortens a description column and says nothing about the row cap.
    const unrelated = [capped, "description: truncateForDisplay(d, 60),"].join("\n");
    expect(findUndisclosedCaps(capped, unrelated)).toEqual(["50"]);
  });

  it("guard for the guard: parser offsets and windows are not flagged", () => {
    const benign = [
      "const name = pair.slice(0, eq);",
      "headers[line.slice(0, idx).trim()] = v;",
      "return { head: msg.slice(0, m.index) };",
      'normalised = normalised.slice(0, -1);',
      'BY_TYPE.get(`${t}/${t.slice(0, 2)}`);',
      'createHash("sha256").update(x).digest("hex").slice(0, 32);',
      "lines.slice(Math.max(0, r.startLine - 1), r.endLine).join(String.fromCharCode(10));",
      "rest = rest.slice(keyword.length).trim();",
      "if (i >= 0) this.shutdownTasks.splice(i, 1);",
    ];
    for (const line of benign) {
      expect(findUndisclosedCaps(line, line), `should NOT flag: ${line}`).toEqual([]);
    }
  });

  it("guard for the guard: no whole-file exemptions exist", () => {
    // The allowlist type has no whole-file shape by construction; this pins
    // the intent so a future edit cannot quietly add one back.
    for (const entry of ALLOWED_LINES) {
      expect(typeof entry.contains).toBe("string");
      expect(entry.contains.length, "an allowlist entry must name a specific line, not a file").toBeGreaterThan(5);
    }
    const exempted = new Set(ALLOWED_LINES.map((e) => e.file));
    expect(exempted.has("src/compact.ts"), "src/compact.ts must not be exempt").toBe(false);
    expect(exempted.has("src/tools/debug.ts"), "src/tools/debug.ts must not be exempt").toBe(false);
  });

  // -------------------------------------------------------------------------
  // (3) THE HELPER'S OWN INVARIANTS.
  // -------------------------------------------------------------------------

  it("never silently drops content: if truncateText shortens the input, isTruncated(result) is true", () => {
    const lengths = [0, 1, 10, 49, 50, 51, 100, 299, 300, 301, 500, 501, 5000, 20000, 20001, 170000];
    const limits = [0, 1, 10, 50, 100, 160, 200, 300, 500, 1000, 20000];

    for (const len of lengths) {
      const input = "x".repeat(len);
      for (const limit of limits) {
        const result = truncateText(input, limit);
        if (input.length > limit) {
          expect(isTruncated(result), `truncateText(len=${len}, limit=${limit}) dropped content but was not marked`).toBe(true);
        } else {
          expect(isTruncated(result), `truncateText(len=${len}, limit=${limit}) kept everything but was marked anyway`).toBe(false);
        }
      }
    }
  });

  it("never silently drops content: truncateDiagnosticBody at the 165 KB short-dump scale is always marked when shortened", () => {
    const shortDump = "E".repeat(170000);
    const result = truncateDiagnosticBody(shortDump, DIAGNOSTIC_BODY_MAX);
    expect(shortDump.length).toBeGreaterThan(DIAGNOSTIC_BODY_MAX);
    expect(isTruncated(result)).toBe(true);

    const untouched = truncateDiagnosticBody("small body", DIAGNOSTIC_BODY_MAX);
    expect(isTruncated(untouched)).toBe(false);
  });

  it("pins the diagnostic-path limit inventory so a change is a deliberate, visible edit", () => {
    const limits = {
      DIAGNOSTIC_BODY_MAX,
      PARSE_EXCERPT_MAX,
      MESSAGE_EXCERPT_MAX,
      ECHO_LINE_MAX,
      DUMP_SHORT_TEXT_MAX,
    };

    for (const [name, value] of Object.entries(limits)) {
      expect(Number.isFinite(value), `${name} must be a finite number`).toBe(true);
      expect(value > 0, `${name} must be positive`).toBe(true);
    }

    expect(DIAGNOSTIC_BODY_MAX).toBe(20000);
    expect(PARSE_EXCERPT_MAX).toBe(500);
    expect(MESSAGE_EXCERPT_MAX).toBe(300);
    expect(ECHO_LINE_MAX).toBe(160);
    expect(DUMP_SHORT_TEXT_MAX).toBe(200);
  });
});
