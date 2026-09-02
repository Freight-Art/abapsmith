/**
 * Cassette registry — loads and validates every `*.cassette.json` file under
 * `test/cassettes/`. See `test/cassettes/README.md` for the format and how
 * to add a new cassette.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CassetteSchema, type Cassette } from "./schema.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

const CASSETTE_FILE_SUFFIX = ".cassette.json";

/**
 * Recursively collect every `*.cassette.json` path under `dir`. Plain `.ts`
 * files (this module, `schema.ts`, future `*.test.ts` lint suites) and any
 * `.md` documentation are never touched — only the specific `.cassette.json`
 * suffix is matched, so nothing else in this tree is mistaken for a cassette.
 */
function collectCassetteFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      found.push(...collectCassetteFiles(full));
    } else if (stat.isFile() && entry.endsWith(CASSETTE_FILE_SUFFIX)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Load and validate every cassette under `baseDir` (default: this module's
 * own directory, `test/cassettes/`, resolved via `import.meta.url` so the
 * result does not depend on the process's current working directory).
 *
 * Validation failures throw zod's descriptive `ZodError` rather than being
 * swallowed — a malformed cassette should fail loudly, not be silently
 * skipped.
 */
export function loadAllCassettes(baseDir: string = THIS_DIR): Cassette[] {
  const files = collectCassetteFiles(baseDir).sort();
  return files.map((file) => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Cassette file is not valid JSON: ${file}\n${message}`);
    }
    try {
      return CassetteSchema.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Cassette failed schema validation: ${file}\n${message}`);
    }
  });
}

/**
 * How long a cassette is trusted before it is considered stale.
 *
 * A4H is an expendable, periodically-rebuilt experimental sandbox — its
 * kernel release/patch level, and potentially
 * finer wire-protocol details, can change across a rebuild with no signal
 * to this repo. The project has already shipped real defects from drift
 * between the hand-authored fake ADT server and the actual wire protocol
 * within weeks of active development (the reason this cassette format
 * exists at all), so trusting a capture indefinitely is not an option.
 *
 * 90 days forces roughly-quarterly re-verification — inside a typical SAP
 * support-package cadence — without demanding a fresh live capture on every
 * commit. That balance matters because live A4H access is exclusive (one
 * appliance, contended among concurrent agents) and re-recording a
 * cassette requires deliberately scheduling a live
 * session, not something that can happen incidentally as a side effect of
 * unrelated work.
 */
export const STALENESS_WINDOW_DAYS = 90;

const STALENESS_WINDOW_MS = STALENESS_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Pure function: is `cassette` older than `STALENESS_WINDOW_DAYS` relative
 * to `now`? Takes `now` as a parameter (default `new Date()`) so this is
 * testable without depending on the real system clock.
 */
export function isStale(cassette: Cassette, now: Date = new Date()): boolean {
  const recordedAtMs = Date.parse(cassette.recordedAt);
  if (Number.isNaN(recordedAtMs)) {
    // Schema validation should already have rejected this, but a pure
    // function should never throw on a malformed timestamp it is merely
    // asked to compare — treat "cannot parse" as "cannot prove freshness".
    return true;
  }
  return now.getTime() - recordedAtMs > STALENESS_WINDOW_MS;
}
