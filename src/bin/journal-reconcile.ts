#!/usr/bin/env node
/**
 * abap-journal-reconcile — standalone CLI.
 *
 * journal.ts never decides on its own that a `pending` entry is finished
 * (see its header); a server killed mid-write leaves that entry stranded
 * until a human compares before/after by hand. This script automates that
 * comparison for entries `abap_journal` already flags STRANDED (pending
 * past `STALE_PENDING_MS`): one read-only GET per entry, classified via the
 * same `plannedAction()`/`detectDrift()` logic src/adt/undo.ts uses, into
 * "succeeded", "failed", or "ambiguous". Default is dry-run (print only);
 * `--apply` locally settles succeeded/failed entries via `journal.settle()`
 * — ambiguous entries are never auto-settled. It does not contradict
 * journal.ts's rule: it only resolves entries where a live read makes the
 * outcome unambiguous. Manual fallback: skills/recovery/SKILL.md.
 *
 * ABSOLUTE SAFETY CONSTRAINT: only `conn.get(...)` may be issued against the
 * server — no PUT/POST/DELETE, no stateful session. Not wired into server
 * boot; run manually via `bin/abap-journal-reconcile`. Enforced in depth:
 * `main()` forces `readOnly: true` regardless of env, and `AbapConnection`
 * itself refuses stateful sessions and mutating verbs whenever `readOnly`
 * is true (see `get readOnly()` in src/adt/connection.ts).
 * Full rationale: the git history.
 */
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { loadConfig, loadEnvFile } from "../config.js";
import { AbapConnection } from "../adt/connection.js";
import { AuthCircuitBreaker } from "../adt/circuit-breaker.js";
import { isNotFoundError } from "../adt/session.js";
import { detectDrift, plannedAction, type DriftReport, type UndoAction } from "../adt/undo.js";
import {
  Journal,
  journalConfigFromEnv,
  sourceFingerprint,
  STALE_PENDING_MS,
  type JournalEntry,
  type SettleResult,
} from "../journal.js";
import { textTable } from "../compact.js";
import { truncateForDisplay } from "../truncate.js";

export type Classification = "succeeded" | "failed" | "ambiguous";

/** What a read-only GET of the object's current source found. */
export interface ProbeResult {
  source?: string;
  serverEtag?: string;
  exists: boolean;
}

export interface ClassifiedEntry {
  entry: JournalEntry;
  action: UndoAction;
  now: ProbeResult;
  drift: DriftReport;
  classification: Classification;
  reason: string;
}

export interface SettleOutcome {
  entry: JournalEntry;
  outcome: "succeeded" | "failed";
  settled: boolean;
  detail: string;
}

export interface ReconcileReport {
  /** Stranded pending entries examined (older than the stale threshold). */
  checked: number;
  classified: ClassifiedEntry[];
  /** Whether `--apply` (or the `apply` option) was in effect for this run. */
  applied: boolean;
  /** Only populated when `applied` is true. */
  settled: SettleOutcome[];
}

/**
 * Read-only counterpart to undo.ts's private `probe()` — not reused because
 * that one needs a `ResolvedTarget` from a heavier, write-shaped resolution
 * path this script has no business calling. Just one GET, exists or not.
 */
async function probe(conn: AbapConnection, sourceUri: string): Promise<ProbeResult> {
  try {
    const resp = await conn.get(sourceUri, { headers: { Accept: "text/plain" } });
    const etag = resp.headers["etag"] ?? resp.headers["ETag"];
    return { source: resp.body, serverEtag: typeof etag === "string" ? etag : undefined, exists: true };
  } catch (e) {
    if (isNotFoundError(e)) return { exists: false };
    throw e;
  }
}

/**
 * Classify a stranded entry: `drift.drifted` always wins → "ambiguous" (a
 * human must referee via abap_journal/abap_read/undo). Otherwise compare
 * live source to the entry's own before/after fingerprints to decide
 * succeeded vs. failed. A crashed DELETE confirmed absent by detectDrift's
 * own non-drifted "recreate" outcome is classified "succeeded" here —
 * calling it merely "ambiguous" would contradict the drift check itself.
 */
export function classify(
  entry: JournalEntry,
  action: UndoAction,
  drift: DriftReport,
  now: ProbeResult,
): { classification: Classification; reason: string } {
  if (drift.drifted) {
    return { classification: "ambiguous", reason: `drift: ${drift.reason}` };
  }

  // Crashed delete, confirmed absent by detectDrift's "recreate" branch. See docstring.
  if (action === "recreate" && !now.exists) {
    return {
      classification: "succeeded",
      reason: `${entry.object.name} is confirmed absent from the server — the delete landed.`,
    };
  }

  const nowFingerprint = now.source !== undefined ? sourceFingerprint(now.source) : undefined;

  if (
    nowFingerprint !== undefined &&
    entry.after?.fingerprint !== undefined &&
    nowFingerprint === entry.after.fingerprint
  ) {
    return {
      classification: "succeeded",
      reason: `live source matches the recorded after-image (${nowFingerprint}) — the write landed.`,
    };
  }

  const isCreate = !entry.existedBefore;
  if (isCreate && !now.exists) {
    return {
      classification: "failed",
      reason: `${entry.object.name} still does not exist on the server — the create never landed.`,
    };
  }
  if (
    nowFingerprint !== undefined &&
    entry.before?.fingerprint !== undefined &&
    nowFingerprint === entry.before.fingerprint
  ) {
    return {
      classification: "failed",
      reason: `live source matches the recorded before-image (${nowFingerprint}) — the write never landed.`,
    };
  }

  return {
    classification: "ambiguous",
    reason:
      "live source matches neither the recorded before- nor after-image, and detectDrift did not " +
      "flag it as drifted either — an unclassifiable state. Left pending deliberately.",
  };
}

/**
 * Core logic: probe every stranded `pending` entry (read-only), classify it,
 * and — only with `opts.apply` — locally settle the unambiguous ones. Issues
 * nothing but `conn.get(...)` against the server.
 */
export async function reconcile(
  conn: AbapConnection,
  journal: Journal,
  opts: { apply?: boolean; staleAfterMs?: number } = {},
): Promise<ReconcileReport> {
  const staleAfterMs = opts.staleAfterMs ?? STALE_PENDING_MS;
  const apply = opts.apply === true;

  const pending = await journal.listPending({ staleAfterMs });
  const classified: ClassifiedEntry[] = [];

  for (const entry of pending) {
    const sourceUri = entry.object.sourceUri ?? `${entry.object.uri}/source/main`;
    const now = await probe(conn, sourceUri);
    const action = plannedAction(entry);
    const drift = detectDrift(entry, action, now);
    const { classification, reason } = classify(entry, action, drift, now);
    classified.push({ entry, action, now, drift, classification, reason });
  }

  const settled: SettleOutcome[] = [];
  if (apply) {
    for (const c of classified) {
      if (c.classification === "ambiguous") continue; // never auto-settled, --apply or not
      const outcome = c.classification;
      const result: SettleResult = await journal.settle(c.entry.id, { outcome });
      settled.push({
        entry: c.entry,
        outcome,
        settled: result.settled,
        detail: result.settled
          ? `settled as ${outcome}`
          : `NOT settled (${result.reason}${"error" in result && result.error ? `: ${result.error}` : ""})`,
      });
    }
  }

  return { checked: pending.length, classified, applied: apply, settled };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function formatTable(classified: ClassifiedEntry[]): string {
  if (classified.length === 0) return "(no stranded pending entries)";
  const rows = classified.map((c) => ({
    id: c.entry.id,
    object: `${c.entry.object.type} ${c.entry.object.name}`,
    op: c.entry.operation,
    ts: c.entry.ts.replace("T", " ").replace(/\.\d+Z$/, "Z"),
    classification: c.classification,
    // Narrow table column — truncateForDisplay's short marker fits; truncateText's would break the layout.
    reason: truncateForDisplay(c.reason, 100),
  }));
  return textTable(rows, ["id", "object", "op", "ts", "classification", "reason"]);
}

function parseArgs(argv: string[]): { apply: boolean; staleAfterMs?: number } {
  const apply = argv.includes("--apply");
  let staleAfterMs: number | undefined;
  const flagIdx = argv.indexOf("--stale-after-ms");
  if (flagIdx !== -1) {
    const raw = argv[flagIdx + 1];
    const n = raw !== undefined ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= 0) staleAfterMs = n;
  }
  return { apply, ...(staleAfterMs !== undefined ? { staleAfterMs } : {}) };
}

async function main(): Promise<void> {
  loadEnvFile();
  const { apply, staleAfterMs } = parseArgs(process.argv.slice(2));

  const baseCfg = loadConfig();
  // Forced regardless of env (ABAP_ALLOW_WRITE, ABAP_MODE, ...) — see the safety constraint above.
  const cfg = { ...baseCfg, readOnly: true };

  const journalCfg = journalConfigFromEnv(process.env, cfg.sid);
  if (!journalCfg.enabled) {
    process.stdout.write("Journal is disabled (ABAP_JOURNAL=off) — nothing to reconcile.\n");
    return;
  }
  const journal = new Journal(journalCfg, cfg.sid);

  const conn = new AbapConnection(cfg, { log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  try {
    const effectiveStaleMs = staleAfterMs ?? STALE_PENDING_MS;
    const report = await reconcile(conn, journal, { apply, staleAfterMs: effectiveStaleMs });

    process.stdout.write(`Journal: ${journal.dir}\n`);
    process.stdout.write(
      `Stranded pending entries (older than ${Math.round(effectiveStaleMs / 60_000)} min): ${report.checked}\n\n`,
    );
    process.stdout.write(`${formatTable(report.classified)}\n`);

    if (report.applied) {
      const ok = report.settled.filter((s) => s.settled).length;
      process.stdout.write(`\n--apply: settled ${ok} of ${report.settled.length} eligible entries.\n`);
      for (const s of report.settled) {
        process.stdout.write(`  ${s.entry.id} -> ${s.detail}\n`);
      }
      const ambiguous = report.classified.filter((c) => c.classification === "ambiguous").length;
      if (ambiguous > 0) {
        process.stdout.write(
          `\n${ambiguous} entr${ambiguous === 1 ? "y" : "ies"} classified ambiguous — left \`pending\`, ` +
            "never auto-settled. Use abap_journal mode=show / mode=undo to resolve manually.\n",
        );
      }
    } else if (report.checked > 0) {
      process.stdout.write(
        "\nDry run (default) — nothing was settled. Re-run with --apply to locally settle the " +
          "succeeded/failed entries above (never touches the ABAP server; ambiguous entries are " +
          "never auto-settled even with --apply).\n",
      );
    }
  } finally {
    await conn.shutdown("reconcile-done");
  }
}

/**
 * True only when this module IS the program node was asked to run — same
 * pattern as `invokedAsProgram()` in src/index.ts, so importing this file's
 * exports (e.g. from a test) never triggers `main()`.
 */
function invokedAsProgram(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsProgram()) {
  main().catch((e) => {
    process.stderr.write(`abap-journal-reconcile: fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exitCode = 1;
  });
}
