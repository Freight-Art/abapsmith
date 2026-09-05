/**
 * `abap_write dry_run` — the preview branch.
 *
 * Entered by `if (input.dry_run)` hooks placed immediately before the
 * `withJournalledMutation` call each branch would otherwise make, so nothing
 * mutating is reachable from here.
 */
import type { AbapConnection } from "../adt/connection.js";
import { canonicalEtag, type ResolvedTarget } from "../adt/write.js";
import { isLocalPackageName } from "../adt/transports.js";
import { AbapError } from "../adt/errors.js";
import { buildResponse, type BuiltResponse } from "../compact.js";
import { DEFAULT_CONTEXT_LINES, diffSources, renderHunks } from "../diff.js";
import type { WriteInputV2 } from "./write.js";

/** Matches `DIFF_MAX_HUNKS` in src/tools/read.ts by convention; not enforced to stay equal. */
const WRITE_DRY_RUN_MAX_HUNKS = 200;

/** Refuses `dry_run` for a route that has no meaningful preview. */
export function dryRunNotSupported(route: "objects" | "bridge" | "package", detail?: string): AbapError {
  if (route === "objects") {
    return new AbapError(
      "BAD_INPUT",
      "`dry_run` does not apply to the `objects` batch-delete form.",
      { route },
      'Preview one object at a time with `object` + mode: "delete", or drop `dry_run` to run the batch.',
    );
  }
  if (route === "bridge") {
    return new AbapError(
      "BAD_INPUT",
      `\`dry_run\` cannot preview a \`${detail}\`: this type is created and deleted by generating and ` +
        "running an ABAP program through the classrun bridge, so there is nothing to preview short of " +
        "performing it.",
      { route, type: detail },
      "Drop `dry_run`. Read the object first with abap_read if you want to see its current state.",
    );
  }
  return new AbapError(
    "BAD_INPUT",
    "`dry_run` cannot preview a package (DEVC/K): a package create resolves — and can create — its " +
      "transport request before anything else is decided, which a dry run must not do.",
    { route },
    "Drop `dry_run` to create the package for real.",
  );
}

/** Explains what a real write would do about a transport request, without making the CTS call. */
function transportPreviewNote(target: ResolvedTarget, input: WriteInputV2): string {
  if (input.corr_nr) {
    return (
      `A real write would send corr_nr "${input.corr_nr}" and re-judge it against the safety gate's ` +
      "transport allowlist once resolved — a second gate check this dry run did not make."
    );
  }
  if (isLocalPackageName(target.packageName)) {
    return `${target.packageName} is a $-local package, so a real write resolves no transport request.`;
  }
  return (
    `${target.packageName} is transportable, so a real write would ask CTS for a request (possibly ` +
    "creating one) and judge the resolved number against the safety gate's transport allowlist; this " +
    "dry run made no CTS call, so that second gate check did not run — a preview that looks clean can " +
    "still be refused there."
  );
}

export function buildWriteDryRunResponse(args: {
  conn: AbapConnection;
  target: ResolvedTarget;
  input: WriteInputV2;
  /** Final bytes a real write would send: post splice, post pretty-print. */
  source: string;
  /** Server source the splice ran against; undefined when the object does not exist. */
  current: string | undefined;
  /** The etag a real write would assert, if any. */
  expectEtag: string | undefined;
  /** True when `format: true` ran the pretty-printer on the previewed bytes. */
  formatted: boolean;
  /** Whether a real write would have a journal to record into. */
  journalled: boolean;
  maxChars: number;
}): BuiltResponse {
  const { conn, target, input, source, current, expectEtag, formatted, journalled, maxChars } = args;
  const diff = diffSources(current ?? "", source, {
    context: DEFAULT_CONTEXT_LINES,
    maxHunks: WRITE_DRY_RUN_MAX_HUNKS,
  });
  const body = diff.identical
    ? "(no change: the composed source is line-for-line identical to what is on the system)"
    : renderHunks(diff.hunks);

  const notes: string[] = [];
  notes.push(
    "Dry run: nothing was written and nothing was journalled — no lock, PUT, DELETE, activation, " +
      "unlock or CTS call was made. Every request this preview made was a read." +
      (formatted
        ? " `format: true` also sent the source to ADT's pretty-printer, a POST that formats text " +
          "and writes nothing."
        : ""),
  );
  notes.push(
    "The safety gate ran on this preview at the same point and with the same inputs as a real write " +
      "(authorizeMutation, with the transport still unresolved) — a refusal would have been returned " +
      "instead of this diff.",
  );
  notes.push(transportPreviewNote(target, input));
  if (diff.identical) {
    notes.push(
      "A real write would detect this same byte-identical no-op and skip the lock/PUT entirely, rather " +
        "than writing unchanged bytes.",
    );
  }
  if (target.exists && expectEtag === undefined) {
    notes.push(
      "This form asserts no precondition. Repeat the call without `dry_run` and with " +
        `expect_etag: "${canonicalEtag(current ?? "")}" to make the applied write compare against ` +
        "exactly the bytes previewed.",
    );
  } else if (!target.exists) {
    notes.push(
      `${target.type} ${target.name} does not exist on ${conn.cfg.sid}, so a real write would create ` +
        `it in ${target.packageName}` +
        (input.activate === false ? "." : " and activate it."),
    );
  }
  if (diff.coarse) {
    notes.push(
      "COARSE DIFF: the current source and the composed write share almost no leading or trailing " +
        "lines, so the exact line-matching pass was skipped and the whole changed region is reported " +
        "as one delete-then-insert block. The diff is correct but not minimal.",
    );
  }
  if (diff.droppedHunks > 0) {
    notes.push(
      `TRUNCATED: showing ${diff.hunks.length} of ${diff.totalHunks} hunks; ${diff.droppedHunks} were ` +
        "withheld to stay inside the response budget. Narrow the change or apply it in smaller pieces.",
    );
  }
  if (input.activate === false) {
    notes.push("`activate: false` on this call means a real write would skip activation.");
  }
  if (!journalled) {
    notes.push("The write journal is off, so a real write would not be undoable through abap_journal.");
  }

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      object: `${target.type} ${target.name}`,
      uri: target.uri,
      package: target.packageName,
      package_source: target.packageSource,
      mode: "write",
      dry_run: true,
      created: !target.exists,
      expect_etag: expectEtag ?? "none (this form asserts no precondition)",
      current_etag: current !== undefined ? canonicalEtag(current) : undefined,
      transport: "unresolved (dry run makes no transport call)",
      journal: "nothing recorded (dry run)",
      added: diff.added,
      removed: diff.removed,
      hunks: diff.hunks.length,
    },
    body,
    bodyLabel: "DIFF",
    notes,
    maxChars,
  });
}

export function buildDeleteDryRunResponse(args: {
  conn: AbapConnection;
  target: ResolvedTarget;
  input: WriteInputV2;
  journalled: boolean;
  maxChars: number;
}): BuiltResponse {
  const { conn, target, input, journalled, maxChars } = args;
  const notes: string[] = [
    "Dry run: nothing was deleted and nothing was journalled — no lock, DELETE or CTS call was made. " +
      "Every request this preview made was a read.",
    "The safety gate ran on this preview at the same point and with the same inputs as a real delete " +
      "(authorizeMutation, with the transport still unresolved) — a refusal would have been returned " +
      "instead of this response.",
    transportPreviewNote(target, input),
    journalled
      ? "A real delete would attempt to capture a before-image first and, if that capture succeeds, " +
        "would be undoable through abap_journal mode=undo."
      : "The write journal is off, so a real delete would be irreversible.",
  ];

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      object: `${target.type} ${target.name}`,
      uri: target.uri,
      package: target.packageName,
      package_source: target.packageSource,
      mode: "delete",
      dry_run: true,
      would_delete: true,
      expect_etag: input.expect_etag,
      transport: "unresolved (dry run makes no transport call)",
      journal: "nothing recorded (dry run)",
    },
    notes,
    maxChars,
  });
}
