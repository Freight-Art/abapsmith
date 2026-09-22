/**
 * `abap_run` — execute ABAP and capture what it printed.
 *
 *   class   POST /oo/classrun/{CLASS} — IF_OO_ADT_CLASSRUN classes;
 *           out->write() output comes back as text.
 *   report  classic PROG, run via a generated IF_OO_ADT_CLASSRUN bridge class
 *           (SUBMIT ... EXPORTING LIST TO MEMORY, or WITH SELECTION-TABLE when
 *           `parameters` is given). Bridge is a real object in the write allowlist.
 *   auto    resolve the object and pick.
 *
 * Both paths run in a fresh session: classrun caches the loaded class per
 * session, so re-running after an edit in the same session would otherwise
 * silently execute the previous version.
 *
 * `parameters` (report mode only) fills PARAMETERS/SELECT-OPTIONS — see
 * ../adt/run-parameters.ts for marshalling rules. Cannot render an
 * INTERACTIVE list (ALV grid DISPLAY(), dynpro, etc.) — not supported over
 * headless classrun; see the git history.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AbapConnection } from "../adt/connection.js";
import { AbapError, isAbapError } from "../adt/errors.js";
import { checkActivation, resolveObject, type ActivationState } from "../adt/resolve.js";
import { readSource } from "../adt/source.js";
import { BRIDGE_PACKAGE, bridgeClassName, runClass, runReport, type RunResult, type DroppedLine } from "../adt/run.js";
import {
  authTraceOf,
  renderFailedAuthChecks,
  switchOffErrorOf,
  withAuthTrace,
  type AuthTraceOutcome,
} from "../adt/authtrace.js";
import { parseSelectionScreen, selectionScreenNotes, type RunParameterInput } from "../adt/run-parameters.js";
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import { buildResponse, type BuiltResponse } from "../compact.js";
import type { SafetyGate } from "../safety.js";
import { preflight } from "./preflight.js";
import { LOG_TOOL_ID, LOG_ACTION } from "../adt/fluid/builtin/log.js";
import { previewDdicEntity } from "../adt/datapreview.js";
import { isEmptyFilter } from "../adt/datapreview-filter.js";
import { systemKey } from "../journal.js";
import { diffSnapshot, renderDataChangesSection, auditDiff, type SnapshotRunDeps } from "../snapshot-run.js";

const runRangeSchema = z.object({
  sign: z.enum(["I", "E"]).optional(),
  option: z.enum(["EQ", "NE", "GT", "LT", "GE", "LE", "CP", "NP", "BT", "NB"]).optional(),
  low: z.string(),
  high: z.string().optional(),
});

const runParameterSchema = z.object({
  name: z.string(),
  type: z.enum(["char", "int", "packed", "date"]).optional(),
  value: z.string().optional(),
  ranges: z.array(runRangeSchema).optional().describe("SELECT-OPTIONS rows; must be non-empty."),
});

export const runInputSchema = {
  object: z.string().describe("Class or report to execute."),
  mode: z.enum(["class", "report", "auto"]).optional().describe("Default auto."),
  // Report mode only: fills PARAMETERS/SELECT-OPTIONS — see ../adt/run-parameters.ts.
  parameters: z.array(runParameterSchema).optional(),
  keep_blank_lines: z
    .boolean()
    .optional()
    .describe(
      "Return the captured list unfiltered: keep the list page header and rule line, trailing " +
        "blank lines and blank padding exactly as captured (only trailing spaces per line are " +
        "still trimmed). Default false.",
    ),
  auth_trace: z
    .boolean()
    .optional()
    .describe(
      "Switch on the SAP authorization trace for the connected user, run, then read back and " +
        "switch it back off. Refused on a read-only server. Default false.",
    ),
  snapshot_ids: z.array(z.string()).optional().describe(
    "Snapshot ids from prior abap_data_preview mode=\"snapshot\" calls; each is re-read and " +
      "diffed after this call and appended as a DATA CHANGES section, under the same data-preview " +
      "policy (a refused diff does not fail this call).",
  ),
};

export const RunInput = z.object(runInputSchema);
export type RunInput = z.infer<typeof RunInput>;

/**
 * Header value for `auth_trace`, shared shape with `abap_test`/`abap_bopf_test`
 * (issue #112 wiring): "no failed checks" / "N failed check(s)" on a run the
 * trace could complete, or the outcome's own `unavailable: <reason>" string
 * (never re-prefixed) when it could not.
 */
function authTraceHeaderValue(outcome: AuthTraceOutcome): string {
  if (!outcome.ok) return outcome.reason;
  return outcome.checks.length > 0 ? `${outcome.checks.length} failed check(s)` : "no failed checks";
}

/**
 * `renderFailedAuthChecks` already puts its own "FAILED AUTH CHECKS" line at
 * the top of its output; `buildResponse`'s `sections` also renders the title
 * from `{ title }` (`--- FAILED AUTH CHECKS ---`), so that first line is
 * dropped here to avoid printing the title twice. Returns undefined when
 * there is nothing to show.
 */
function authTraceSection(outcome: AuthTraceOutcome): { title: string; content: string } | undefined {
  if (!outcome.ok || outcome.checks.length === 0) return undefined;
  const rendered = renderFailedAuthChecks(outcome.checks);
  const [, ...rest] = rendered.split("\n");
  return { title: "FAILED AUTH CHECKS", content: rest.join("\n") };
}

/**
 * Render 1-based positions the way a reader would say them: "9", "1 and 9",
 * "1, 4 and 9" — with runs of 3+ consecutive numbers collapsed to "3-7"
 * (so [1,3,4,5,9] -> "1, 3-5 and 9"). Assumes no duplicates.
 */
export function formatPositions(positions: number[]): string {
  const sorted = [...positions].sort((a, b) => a - b);
  const tokens: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    if (j - i + 1 >= 3) {
      tokens.push(`${sorted[i]}-${sorted[j]}`);
    } else {
      for (let k = i; k <= j; k++) tokens.push(String(sorted[k]));
    }
    i = j + 1;
  }
  if (tokens.length === 1) return tokens[0]!;
  if (tokens.length === 2) return `${tokens[0]} and ${tokens[1]}`;
  return `${tokens.slice(0, -1).join(", ")} and ${tokens[tokens.length - 1]}`;
}

/**
 * #180: turns `RunResult.dropped` into one sentence, replacing the old
 * "N line(s) ... dropped" note when present. Only the groups that actually
 * occurred are mentioned, in order blank/header/unprefixed.
 */
export function describeDroppedLines(dropped: DroppedLine[]): string {
  const blanks = dropped.filter((d) => d.reason === "blank").map((d) => d.position);
  const headers = dropped.filter((d) => d.reason === "header").map((d) => d.position);
  const unprefixed = dropped.filter((d) => d.reason === "unprefixed").map((d) => d.position);

  const clauses: string[] = [];
  if (blanks.length > 0) {
    clauses.push(
      `dropped ${blanks.length} blank line${blanks.length === 1 ? "" : "s"} at ` +
        `position${blanks.length === 1 ? "" : "s"} ${formatPositions(blanks)} (trailing list padding)`,
    );
  }
  if (headers.length > 0) {
    clauses.push("dropped the list header and rule line at positions 1 and 2");
  }
  if (unprefixed.length > 0) {
    clauses.push(
      `dropped ${unprefixed.length} non-list line${unprefixed.length === 1 ? "" : "s"} of bridge output at ` +
        `bridge line${unprefixed.length === 1 ? "" : "s"} ${formatPositions(unprefixed)}`,
    );
  }

  const sentence = clauses.join("; ");
  const capitalized = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return (
    `${capitalized}. Positions are 1-based line numbers of the captured list before dropping. ` +
    "Pass keep_blank_lines=true to receive the capture unfiltered."
  );
}

/** Attaches what `withAuthTrace` learned to a propagating error's `details`, without ever converting the throw into a normal response. Only mutates `e` when `authTraceOf(e)` actually found something to attach. */
function attachAuthTraceToError(e: unknown): void {
  const outcome = authTraceOf(e);
  if (outcome === undefined || !isAbapError(e)) return;
  e.details["failedAuthChecks"] = outcome.ok
    ? outcome.checks.length > 0
      ? renderFailedAuthChecks(outcome.checks)
      : "no failed checks"
    : outcome.reason;
  const switchOffError = switchOffErrorOf(e);
  if (switchOffError !== undefined) {
    e.details["authTraceSwitchOffError"] = switchOffError;
  }
}

export async function abapRun(
  conn: AbapConnection,
  input: RunInput,
  maxChars: number,
  gate: SafetyGate,
): Promise<BuiltResponse> {
  const authTraceRequested = input.auth_trace === true;
  // System-level action (switches on the SAP authorization trace for the
  // connected user) — refused on a read-only server before any request is
  // made, same convention as every other zero-network refusal in this file.
  if (authTraceRequested && gate.config.readOnly === true) {
    throw new AbapError(
      "SAFETY_DENIED",
      "auth_trace switches the SAP authorization trace on for the connected user, a system-level " +
        "action, so it is refused on a read-only server.",
      { auth_trace: true },
      "Ask the operator to enable writes (ABAP_ALLOW_WRITE), or omit auth_trace to run without it.",
    );
  }

  const requested = input.mode ?? "auto";

  // Always resolve: settles `auto` and gives the gate the object's real package.
  const obj = await resolveObject(conn, input.object);

  let mode: "class" | "report";
  if (requested === "auto") {
    if (obj.kind === "CLAS") mode = "class";
    else if (obj.kind === "PROG") mode = "report";
    else {
      throw new AbapError(
        "UNSUPPORTED",
        `${obj.type} ${obj.name} is not executable: only classes implementing IF_OO_ADT_CLASSRUN and reports (PROG) can be run.`,
        { object: obj.name, type: obj.type },
        "Wrap the logic in a small IF_OO_ADT_CLASSRUN class and run that.",
      );
    }
  } else {
    // Explicit mode must match what the object actually resolved to.
    if (requested === "class" && obj.kind !== "CLAS") {
      throw new AbapError(
        "BAD_INPUT",
        `mode "class" was requested for ${obj.name}, but it resolved to ${obj.type} (kind ${obj.kind}), not a class.`,
        { object: obj.name, requestedMode: requested, resolvedType: obj.type, resolvedKind: obj.kind },
        'Use mode "report" (or omit mode / use "auto") for PROG objects.',
      );
    }
    if (requested === "report" && obj.kind !== "PROG") {
      throw new AbapError(
        "BAD_INPUT",
        `mode "report" was requested for ${obj.name}, but it resolved to ${obj.type} (kind ${obj.kind}), not a report.`,
        { object: obj.name, requestedMode: requested, resolvedType: obj.type, resolvedKind: obj.kind },
        'Use mode "class" (or omit mode / use "auto") for CLAS objects.',
      );
    }
    mode = requested;
  }

  // Running a report creates the bridge class; the authoritative check is
  // `authorizeMutation` inside runReport (adt/run.ts), against the package the
  // server reports. This pre-check refuses cheaply, before any request, against
  // the package we INTEND ($ABAPSMITH_FLUID_API). `gate` is required here (was optional — see
  // the git history); debug.ts's `triggerRun` still
  // declares it optional against the old contract.
  const parameters: RunParameterInput[] = (input.parameters ?? []) as RunParameterInput[];
  if (parameters.length > 0 && mode !== "report") {
    throw new AbapError(
      "BAD_INPUT",
      `"parameters" was supplied but mode is "${mode}", not "report" — selection-screen values ` +
        "only apply to classic reports.",
      { object: obj.name, mode },
    );
  }

  // `gate` is required (was optional — same class of gap as abap_test; see
  // the git history). Placement matters: this must stay
  // AFTER the kind/mode checks above — by here `obj.kind` is proven CLAS or
  // PROG, so the gate never sees an enhancement-type object and can't throw
  // its generic "supply affects" refusal in place of the clearer error above.
  const executeAuthorization = gate.authorize("execute", {
    name: obj.name,
    packageName: obj.packageName,
    type: obj.type,
  });

  const executeRun = async (): Promise<RunResult> => {
    if (mode === "class") {
      return runClass(conn, executeAuthorization.target.name);
    }
    gate.assert("write", {
      name: bridgeClassName(obj.name),
      packageName: BRIDGE_PACKAGE,
      type: "CLAS/OC",
    });
    return runReport(conn, obj.name, gate, parameters, { keepBlankLines: input.keep_blank_lines === true });
  };

  let res: RunResult;
  let authTraceOutcome: AuthTraceOutcome | undefined;
  let authTraceSwitchOffError: string | undefined;
  if (authTraceRequested) {
    try {
      const wrapped = await withAuthTrace({ conn, gate }, conn.cfg.user, executeRun);
      res = wrapped.value;
      authTraceOutcome = wrapped.authTrace;
      authTraceSwitchOffError = wrapped.switchOffError;
    } catch (e) {
      attachAuthTraceToError(e);
      throw e;
    }
  } else {
    res = await executeRun();
  }

  const notes: string[] = [];
  if (res.mode === "report") {
    // Kept separate from the interactive-rendering note below: "values can be
    // passed in" and "interactive display cannot be rendered" must not imply one another.
    notes.push(
      `Output was captured through a generated IF_OO_ADT_CLASSRUN bridge class ` +
        `(${res.bridgeClass ?? "n/a"}) that SUBMITs the report EXPORTING LIST TO MEMORY` +
        (parameters.length > 0
          ? ` WITH SELECTION-TABLE (${parameters.length} field(s) supplied — see "parameters").`
          : ". PARAMETERS/SELECT-OPTIONS values can be supplied via the \"parameters\" input; " +
            "omitted fields run with the report's own defaults.") +
        " The bridge is a real object created in the write allowlist.",
    );
    notes.push(
      "Interactive rendering (an ALV grid/list DISPLAY(), classic interactive list events, or " +
        "any other dynpro) is NOT supported and cannot be made to work over this execution " +
        "surface: classrun is headless (no window system), and calling e.g. " +
        "CL_SALV_TABLE->DISPLAY() here raises CX_SY_SEND_DYNPRO_NO_RECEIVER (\"No window " +
        "system type specified\") — confirmed live, not a guess. To verify such logic, run " +
        "headless and inspect the underlying data (the internal table/data provider) instead " +
        "of calling DISPLAY(), or add a WRITE-based fallback path for use under this tool.",
    );

    if (parameters.length > 0) {
      try {
        const src = await readSource(conn, obj);
        const parsed = parseSelectionScreen(src.source);
        notes.push(...selectionScreenNotes(parsed, parameters));
      } catch (e) {
        // Best-effort: introspection failure must not fail a successful run or read as bad parameters.
        notes.push(
          "Selection-screen source could not be re-read for cross-checking parameter names " +
            `(${isAbapError(e) ? e.message : "unexpected error"}) — the run itself was not affected.`,
        );
      }
    }
  }

  // "Fresh session" only proves the code run is current if the target's
  // active version is confirmed newest — worth one extra GET to check rather
  // than assert unconditionally.
  let activation: ActivationState;
  try {
    activation = await checkActivation(conn, obj);
  } catch {
    // checkActivation fails closed internally; never let this informational check fail the run.
    activation = "unknown";
  }
  notes.push(
    activation === "active-is-current"
      ? "Executed in a fresh session, so the code that ran is the code currently active — not a cached copy."
      : activation === "newer-inactive-exists"
        ? "Executed in a fresh session, but a NEWER INACTIVE version exists on the server: what ran is the older ACTIVE code, not your latest edit."
        : "Executed in a fresh session (no cached copy). Whether the active version is the newest was NOT checked.",
  );

  if (authTraceRequested) {
    notes.push(
      "auth_trace reads the SAP authorization trace (falling back to the SU53 buffer) for this " +
        "run only; it changes no authorisation, role or profile.",
    );
    if (authTraceOutcome?.ok && authTraceOutcome.usedFallback) {
      notes.push(
        "The kernel authorization trace returned nothing, so this came from the SU53 buffer, " +
          "which shows only what that buffer retained — it is not a complete record of this run.",
      );
    }
    if (authTraceSwitchOffError !== undefined) {
      notes.push(
        `The authorization trace may have been left switched ON: switching it back off failed ` +
          `(${authTraceSwitchOffError}).`,
      );
    }
  }

  // Separate from the target-object check above: this is about the BRIDGE
  // class report mode just generated and activated.
  if (res.mode === "report" && res.bridgeActivationVerified !== true) {
    notes.push(
      "Additionally, activation of the generated bridge class itself was NOT positively " +
        "verified before it ran — a separate concern from the target object's activation " +
        "state noted above.",
    );
  }

  // ZMCP-ERR> driver diagnostics were previously collected and silently
  // dropped — a failed run must never look like a genuinely empty one.
  const hasDiagnostics = Boolean(res.diagnostics?.length);
  if (hasDiagnostics) {
    notes.push(
      `The ABAP bridge driver reported ${res.diagnostics!.length} diagnostic line(s) — see ` +
        "the DIAGNOSTICS section below. This usually means the capture step itself failed " +
        "(e.g. no list in ABAP memory), NOT merely that the report printed nothing.",
    );
  }

  const droppedLines = res.droppedLines ?? 0;
  if (res.dropped && res.dropped.length > 0) {
    notes.push(describeDroppedLines(res.dropped));
  } else if (droppedLines > 0) {
    notes.push(
      `${droppedLines} line(s) of captured output were dropped and are not shown below.`,
    );
  }
  if (res.outputComplete === false) {
    notes.push(
      "ABAP-side width truncation was detected: one or more output lines may have been cut " +
        "short by the classic list width before this tool ever saw them. The output below is " +
        "not guaranteed complete.",
    );
  }

  // "(no output)" must mean genuinely nothing produced — never claimed when
  // diagnostics, drops, or incomplete output leave real doubt.
  const genuinelyEmpty = res.lines === 0 && droppedLines === 0 && !hasDiagnostics;
  const body = res.output.trim()
    ? res.output
    : genuinelyEmpty
      ? "(no output)"
      : "(nothing shown here — but this run is NOT confirmed empty: see the NOTE(s) above " +
        "about diagnostics, dropped lines, and/or incomplete output. Do not read this as a " +
        "clean, silent, successful run.)";

  // last_seconds is measured on the SERVER clock (see log.ts's doc comment
  // on why `since`/`until` must never be computed from the client clock).
  // Round the run's own duration up to the next whole second, then add a
  // few seconds of slack for the round trip between this call finishing and
  // the log query running — a log write that lands after res.durationMs but
  // before the BAL query executes must still fall inside the window.
  const logLastSeconds = Math.ceil(res.durationMs / 1000) + 5;
  // `notes`, not `hints`: hints only render inside a TRUNCATED/WINDOW notice
  // (see compact.ts), so a hint here would be silently dropped on the normal
  // fast path — this line must reach the caller on every response.
  const logHint =
    `Application log (BAL) entries this execution may have written: abap_fluid ` +
    `{"tool":"${LOG_TOOL_ID}","action":"${LOG_ACTION}","args":{"last_seconds":${logLastSeconds},"detail":"messages"}} ` +
    `— last_seconds is measured on the server clock, so it covers this run.`;
  notes.push(logHint);

  const authTraceSectionValue = authTraceOutcome ? authTraceSection(authTraceOutcome) : undefined;
  const sections: Array<{ title: string; content: string }> = [];
  if (hasDiagnostics) sections.push({ title: "DIAGNOSTICS", content: res.diagnostics!.join("\n") });
  if (authTraceSectionValue) sections.push(authTraceSectionValue);

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      object: `${obj.type} ${obj.name}`,
      mode: res.mode,
      lines: res.lines,
      durationMs: res.durationMs,
      bridgeClass: res.bridgeClass,
      bridgeRefreshed: res.bridgeRefreshed,
      droppedLines: droppedLines > 0 ? droppedLines : undefined,
      outputComplete: res.outputComplete === false ? false : undefined,
      auth_trace: authTraceOutcome ? authTraceHeaderValue(authTraceOutcome) : undefined,
    },
    sections: sections.length > 0 ? sections : undefined,
    body,
    bodyLabel: "OUTPUT",
    notes,
    hints: ["Have the code print less, or filter inside ABAP, if the output is truncated."],
    maxChars,
    omissionMarker: (n) => `… (${n} lines omitted) …`,
  });
}

export interface RunToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars" | "dataPreviewMaxRows" | "dataSnapshotTtlHours" | "sid" | "url" | "client">;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

// ---------------------------------------------------------------------------
// snapshot_ids (issue #117, second half) — shared by abap_run/abap_test/
// abap_bopf_test/abap_ui (mode: "press"). Put here, the smallest of the four
// files, and imported by the other three rather than duplicated: all four
// need the exact same clamp/gate/re-read sequence `diffSnapshot`
// (`src/snapshot-run.ts`) already enforces for `abap_data_preview`'s own
// `mode: "diff"`, and a second hand-rolled copy of it would be one more place
// for the two to drift.
// ---------------------------------------------------------------------------

/** The slice of a tool's deps this helper needs to build its own `SnapshotRunDeps`. */
export interface SnapshotDiffCapableDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly cfg: Pick<Config, "dataPreviewMaxRows" | "dataSnapshotTtlHours" | "sid" | "url" | "client">;
}

/**
 * Diffs every id in `ids`, in order, against the live system, and renders the
 * `DATA CHANGES` section body — or `undefined` when `ids` is absent/empty,
 * so a call that never asked for a diff renders exactly as it did before
 * this option existed.
 *
 * Never throws. The tool's own result has already been produced by the time
 * this runs (see each tool's call site); a diff that cannot be produced —
 * expired snapshot, now-denied table, a dead connection — is reported as a
 * `refused` line in the section, not as an exception that would erase a
 * completed run.
 *
 * One id at a time, plain `for`/`await`, never `Promise.all`: each diff takes
 * its own read lease from `deps.pool`, and running them concurrently would
 * just mean N leases fighting over the same small pool instead of one lease
 * used N times in sequence.
 */
export async function runSnapshotDiffs(
  deps: SnapshotDiffCapableDeps,
  ids: readonly string[] | undefined,
  audit: (message: string) => void,
): Promise<string | undefined> {
  if (ids === undefined || ids.length === 0) return undefined;

  let runDeps: SnapshotRunDeps;
  try {
    runDeps = {
      read: (table, maxRows, filter) =>
        deps.pool.withRead("abap_data_preview", (conn) =>
          previewDdicEntity(conn, { table, maxRows, ...(filter && !isEmptyFilter(filter) ? { filter } : {}) }),
        ),
      assertDataPreview: (t) => deps.safety.assertDataPreview(t),
      systemKey: systemKey(deps.cfg),
      maxRows: deps.cfg.dataPreviewMaxRows,
      ttlCeilingHours: deps.cfg.dataSnapshotTtlHours,
    };
  } catch (e) {
    // Assembling deps (systemKey, etc.) failed before any id was even tried —
    // still no throw: report it as the whole section's content instead.
    return `snapshot diff setup failed: ${isAbapError(e) ? `${e.code}: ${e.message}` : String(e)}`;
  }

  const results: { id: string; outcome: Awaited<ReturnType<typeof diffSnapshot>> | { refused: string } }[] = [];
  for (const id of ids) {
    try {
      const out = await diffSnapshot(runDeps, id);
      auditDiff(out, audit);
      results.push({ id, outcome: out });
    } catch (e) {
      results.push({
        id,
        outcome: { refused: isAbapError(e) ? `${e.code}: ${e.message}` : String(e) },
      });
    }
  }
  return renderDataChangesSection(results);
}

/**
 * Registers `abap_run`. Preflight-gated as `execute`, then runs in a WRITE
 * slot so a dead-slot replay is gated — see the handler body for why.
 */
export function registerRunTools(mcp: McpServer, deps: RunToolDeps): void {
  const audit = (m: string): void => void process.stderr.write(m + "\n");
  mcp.registerTool(
    "abap_run",
    {
      description:
        "Execute an IF_OO_ADT_CLASSRUN class or report; returns output. `parameters` " +
        "(report mode) fills PARAMETERS/SELECT-OPTIONS. Headless — no interactive " +
        "list/ALV grid. Executed ABAP runs with the connected user's full SAP " +
        "authorisations and is not constrained by this server's package, name or " +
        "transport allowlists.",
      inputSchema: runInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      try {
        deps.safety.assert("execute", preflight(args as { object: string }), { phase: "preflight" });
        await deps.ensureConnected();
        // WRITE slot, no object gate: `adt/run.ts` can raise SESSION_DEAD after the
        // classrun already ran, and only the write lane consults the replay gates.
        // The lease is exclusive either way, so the CSRF reset still cannot land on
        // a slot holding an open edit.
        const res = await deps.pool.withWrite("abap_run", undefined, (conn) =>
          abapRun(conn, args as RunInput, deps.cfg.maxResponseChars, deps.safety),
        );
        // Diffed AFTER the run — success or failure of the run itself never
        // affects whether this section is attempted. On a THROW above (a
        // dump, refusal, or connection failure) control never reaches here:
        // the error propagates unchanged, with no DATA CHANGES section — it
        // is a structured, machine-readable refusal, and appending diff
        // prose to it would change its shape for every existing consumer.
        const a = args as RunInput;
        const changes = await runSnapshotDiffs(deps, a.snapshot_ids, audit);
        return ok(changes ? `${res.text}\n\nDATA CHANGES\n${changes}` : res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
