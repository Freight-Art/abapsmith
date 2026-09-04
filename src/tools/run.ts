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
import { BRIDGE_PACKAGE, bridgeClassName, runClass, runReport, type RunResult } from "../adt/run.js";
import { parseSelectionScreen, selectionScreenNotes, type RunParameterInput } from "../adt/run-parameters.js";
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import { buildResponse, type BuiltResponse } from "../compact.js";
import type { SafetyGate } from "../safety.js";
import { preflight } from "./preflight.js";

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
};

export const RunInput = z.object(runInputSchema);
export type RunInput = z.infer<typeof RunInput>;

export async function abapRun(
  conn: AbapConnection,
  input: RunInput,
  maxChars: number,
  gate: SafetyGate,
): Promise<BuiltResponse> {
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
  // the package we INTEND ($TMP). `gate` is required here (was optional — see
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

  let res: RunResult;
  if (mode === "class") {
    res = await runClass(conn, executeAuthorization.target.name);
  } else {
    gate.assert("write", {
      name: bridgeClassName(obj.name),
      packageName: BRIDGE_PACKAGE,
      type: "CLAS/OC",
    });
    res = await runReport(conn, obj.name, gate, parameters);
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
  if (droppedLines > 0) {
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
    },
    sections: hasDiagnostics
      ? [{ title: "DIAGNOSTICS", content: res.diagnostics!.join("\n") }]
      : undefined,
    body,
    bodyLabel: "OUTPUT",
    notes,
    hints: ["Have the code print less, or filter inside ABAP, if the output is truncated."],
    maxChars,
  });
}

export interface RunToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars">;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/**
 * Registers `abap_run`. Preflight-gated as `execute`, then runs in a WRITE
 * slot so a dead-slot replay is gated — see the handler body for why.
 */
export function registerRunTools(mcp: McpServer, deps: RunToolDeps): void {
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
        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
