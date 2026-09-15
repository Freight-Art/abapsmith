/**
 * Built-in "core" fluid tool: table select, function-module interface
 * description, and function-module call, all dispatched through one static
 * `ZCL_ZMCP_FLUID_CORE` body class. `ZCL_ZMCP_FLUID_RT` is deployed
 * alongside it (first in `objects`, so it exists before
 * `ZCL_ZMCP_FLUID_CORE` is activated) — its source is the exact one the `rt`
 * tool deploys, not a copy. Same pattern as `classic.ts`.
 *
 * There is no `submit` action and there never will be one: `core` reads and
 * calls what already exists on the target system (a table, a function
 * module) — it does not accept and activate caller-supplied ABAP source the
 * way a generated invoker or a plugin body class does.
 */
import type { FluidManifest, LoadedFluidTool } from "../manifest.js";
import { FLUID_CONTRACT, manifestVersion } from "../manifest.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeManifest, fluidRuntimeSources } from "../abap/runtime.js";
import type { FluidDeps, FluidRunRequest } from "../dispatch.js";
import { AbapError } from "../../errors.js";
import { FLUID_ABAP_LINE_MAX, reviewFluidAbap, scanFluidCapabilities } from "../static-review.js";
import { coreBodySource } from "./core/abap-core.js";
import { selectPart } from "./core/abap-select.js";
import { fmPart } from "./core/abap-fm.js";

export const CORE_TOOL_ID = "core";
export const CORE_BODY_CLASS = "ZCL_ZMCP_FLUID_CORE";

/** `core.eval`'s own action name — a plain constant so `dispatch.ts`/`invoke.ts` can compare against it without a string literal. */
export const CORE_EVAL_ACTION = "eval";
/** The literal `confirm` value `core.eval` requires on every call (no once-per-session memory). */
export const CORE_EVAL_CONFIRM = "core.eval";
/** Shape a `core.eval` `out` name must match — a plain ABAP identifier, safe to splice into generated source without further escaping. */
export const EVAL_OUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,29}$/;

const RUNTIME_SOURCE = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS);
if (RUNTIME_SOURCE === undefined) {
  throw new Error(`fluidRuntimeSources has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const RUNTIME_OBJECT = fluidRuntimeManifest.objects.find((o) => o.name === FLUID_RUNTIME_CLASS);
if (RUNTIME_OBJECT === undefined) {
  throw new Error(`fluidRuntimeManifest has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const CORE_SOURCE = coreBodySource([selectPart, fmPart]);

export const coreManifest: FluidManifest = {
  contract: FLUID_CONTRACT,
  id: CORE_TOOL_ID,
  title: "Core read/execute bridge",
  description: "Table select, function-module interface description, and function-module call.",
  objects: [
    {
      name: FLUID_RUNTIME_CLASS,
      type: "CLAS/OC",
      // same live object as the rt tool's; derived so the two descriptions can't drift apart
      description: RUNTIME_OBJECT.description,
      source: { text: RUNTIME_SOURCE },
    },
    {
      name: CORE_BODY_CLASS,
      type: "CLAS/OC",
      description: "fluid: table select, FM describe and FM call",
      source: { text: CORE_SOURCE },
    },
  ],
  entry: CORE_BODY_CLASS,
  actions: [
    {
      name: "select",
      category: "read",
      description: "Reads rows from one table or view. Judged by the data-preview policy.",
      input: {
        type: "object",
        required: ["table"],
        properties: {
          table: { type: "string", maxLength: 30, description: "The table or view to read." },
          fields: {
            type: "array",
            items: { type: "string", maxLength: 30 },
            description: "Field names to project, in order. Omit for every field.",
          },
          where: {
            type: "string",
            description: "An Open SQL WHERE condition, evaluated dynamically against that one table.",
          },
          max_rows: {
            type: "integer",
            minimum: 0,
            description: "Row limit. Omitted or 0 means no limit — abapsmith imposes no default and no ceiling.",
          },
        },
      },
      output: {
        type: "array",
        items: { type: "object" },
        description: "One row per element; every column value is a JSON string.",
      },
      targets: { object: "/table" },
    },
    {
      name: "describe_fm",
      category: "read",
      description: "Describes a function module's importing/exporting/changing/tables/exception interface.",
      input: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", maxLength: 30, description: "The function module name." },
        },
      },
      output: {
        type: "object",
        required: ["name", "parameters", "exceptions", "params_schema"],
        properties: {
          name: { type: "string" },
          parameters: { type: "array", items: { type: "object" } },
          exceptions: { type: "array", items: { type: "string" } },
          params_schema: { type: "object" },
        },
      },
      targets: { object: "/name" },
    },
    {
      name: "call_fm",
      category: "execute",
      description: "Calls a function module in the caller's own system, under the caller's own authorizations.",
      input: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", maxLength: 30, description: "The function module to call." },
          params: {
            type: "object",
            description:
              "Parameter name -> value, every value a string. See core.describe_fm's params_schema.",
          },
          commit: {
            type: "boolean",
            description: "COMMIT WORK AND WAIT after the call. Requires confirm: \"core.call_fm\".",
          },
        },
      },
      output: {
        type: "array",
        items: { type: "object" },
        description: "One returned parameter per element: name, kind, value.",
      },
    },
    {
      name: CORE_EVAL_ACTION,
      // Not "mutate": `invokerSource` appends a COMMIT WORK footer for `category: "mutate"` (see
      // its doc comment) and a mutate action is journalled through `journalFluidMutate`, whose
      // `JOURNAL_ARGS_MAX`-truncated description is exactly the "cannot see what actually ran"
      // failure eval exists to avoid — eval gets its own untruncated journal path
      // (`journalFluidEval`, dispatch.ts) instead.
      category: "execute",
      description:
        "Run the supplied ABAP statements as the body of one method and return the named locals as " +
        "JSON. Off unless ABAP_ALLOW_FLUID_EVAL is set. This is a lint-not-sandbox control: the " +
        "static review and the capability scan reject a handful of named statements, they do not " +
        "confine the code. The real boundary is the SAP user's authorisations, and " +
        "ABAP_ALLOW_FLUID_EVAL is consent to run model-authored code inside that boundary, nothing " +
        "narrower.",
      input: {
        type: "object",
        required: ["lines"],
        properties: {
          lines: {
            type: "array",
            items: { type: "string", maxLength: FLUID_ABAP_LINE_MAX },
            description:
              "ABAP statements, one per array element, run verbatim inside one TRY block. Each " +
              `element is one source line: no CR/LF, at most ${FLUID_ABAP_LINE_MAX} characters.`,
          },
          out: {
            type: "array",
            items: { type: "string", maxLength: 30 },
            description:
              `Names of local data objects declared in "lines" to serialise back as JSON, in order. ` +
              `Each must match ${EVAL_OUT_NAME_RE}.`,
          },
        },
      },
      output: {
        type: "array",
        items: { type: "object" },
        description: 'One element per "out" name, in order: {name, value} when serialisation succeeded, {name, error} otherwise.',
      },
      // No `targets`: unlike `select`/`describe_fm`, there is no single object this action
      // touches — the caller's own `lines` decide that, not a declared object/package/transport.
    },
  ],
};

export const coreSources: ReadonlyMap<string, string> = new Map([
  [FLUID_RUNTIME_CLASS, RUNTIME_SOURCE],
  [CORE_BODY_CLASS, CORE_SOURCE],
]);

export const coreTool: LoadedFluidTool = {
  manifest: coreManifest,
  origin: "builtin",
  sources: coreSources,
  version: manifestVersion(coreManifest, coreSources),
};

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Policy `core`'s manifest cannot express, checked once here rather than
 * duplicated per action: `select` is judged by the same data-preview policy
 * `abap_data_preview` uses (ceiling, deny-list, then the
 * `ABAP_ALLOW_DATA_PREVIEW` capability flag — the flag is a
 * registration-level gate for `abap_data_preview` in `src/server.ts:676`,
 * not something `evaluateDataPreview`/`assertDataPreview` itself reads, so
 * `core.select` has to apply it itself here); `call_fm` by
 * `ABAP_ALLOW_FLUID_CALL_FM` plus a per-call confirm echo when it commits.
 * `SAFETY_DENIED` is the code for both capability refusals: no
 * `FLUID_CALL_FM_DISABLED` (or similarly named) code exists, and
 * `src/adt/errors.ts` is off-limits for this slice — both refusals are
 * terminal in the same way `SAFETY_DENIED` already is elsewhere.
 */
export async function guardCoreAction(deps: FluidDeps, req: FluidRunRequest): Promise<void> {
  if (req.tool !== CORE_TOOL_ID) return;

  if (req.action === "select") {
    const args = req.args;
    const table =
      typeof args === "object" && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)["table"]
        : undefined;
    if (!isNonEmptyString(table)) return; // schema validation, run right after this guard, reports BAD_INPUT
    deps.gate.assertDataPreview(table);
    if (!deps.cfg.allowDataPreview) {
      throw new AbapError(
        "SAFETY_DENIED",
        `core.select reads table data, which is off by default. Set ABAP_ALLOW_DATA_PREVIEW=true to allow it.`,
        { tool: req.tool, action: req.action, rule: "ABAP_ALLOW_DATA_PREVIEW" },
      );
    }
    return;
  }

  if (req.action === "call_fm") {
    if (!deps.cfg.allowFluidCallFm) {
      throw new AbapError(
        "SAFETY_DENIED",
        `core.call_fm calls an arbitrary function module and is off by default. Set ABAP_ALLOW_FLUID_CALL_FM=true to allow it.`,
        { tool: req.tool, action: req.action, rule: "ABAP_ALLOW_FLUID_CALL_FM" },
      );
    }
    const args = req.args;
    const commit =
      typeof args === "object" && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)["commit"]
        : undefined;
    if (commit === true) {
      const expectedConfirm = `${req.tool}.${req.action}`;
      if (req.confirm !== expectedConfirm) {
        throw new AbapError(
          "BAD_INPUT",
          `${req.tool}.${req.action} mutates state and requires confirm: ${JSON.stringify(expectedConfirm)} ` +
            `(got ${req.confirm === undefined ? "nothing" : JSON.stringify(req.confirm)}).`,
          { field: "confirm", expected: expectedConfirm, got: req.confirm },
        );
      }
    }
    return;
  }

  if (req.action === CORE_EVAL_ACTION) {
    // 1. The ceiling. Checked first, before anything about `req.args` is even looked at — an
    // eval call arriving with the flag off should never wait on input validation to find that out.
    if (!deps.cfg.allowFluidEval) {
      throw new AbapError(
        "FLUID_EVAL_DISABLED",
        "core.eval is off; set ABAP_ALLOW_FLUID_EVAL=1 to enable it",
        { tool: req.tool, action: req.action, rule: "ABAP_ALLOW_FLUID_EVAL" },
      );
    }

    // 2. Every call, not once per session — unlike `call_fm`'s confirm (only required when
    // `commit: true`), core.eval always mutates the shape of what runs, so it always asks.
    if (req.confirm !== CORE_EVAL_CONFIRM) {
      throw new AbapError(
        "BAD_INPUT",
        `core.eval requires confirm: ${JSON.stringify(CORE_EVAL_CONFIRM)} ` +
          `(got ${req.confirm === undefined ? "nothing" : JSON.stringify(req.confirm)}).`,
        { field: "confirm", expected: CORE_EVAL_CONFIRM, got: req.confirm },
      );
    }

    const rawArgs = evalArgsRecord(req.args);
    const rawLines = rawArgs["lines"];

    // 3. `lines`: non-empty, every element a string, one ABAP source line each.
    if (!Array.isArray(rawLines) || rawLines.length === 0 || !rawLines.every((l) => typeof l === "string")) {
      throw new AbapError(
        "BAD_INPUT",
        'core.eval requires "lines": a non-empty array of ABAP statement strings.',
        { field: "lines" },
      );
    }
    const lines = rawLines as string[];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNo = i + 1;
      if (/[\r\n]/.test(line)) {
        throw new AbapError(
          "BAD_INPUT",
          `core.eval "lines"[${i}] (line ${lineNo}) must not contain a CR or LF — one array element is one ABAP source line.`,
          { field: "lines", line: lineNo },
        );
      }
      if (line.length > FLUID_ABAP_LINE_MAX) {
        throw new AbapError(
          "BAD_INPUT",
          `core.eval "lines"[${i}] (line ${lineNo}) is ${line.length} characters long; ABAP source lines are capped at ${FLUID_ABAP_LINE_MAX}.`,
          { field: "lines", line: lineNo, length: line.length },
        );
      }
    }

    // 4. `out`, when given: every element a valid ABAP identifier. Deduped preserving order so a
    // caller-supplied repeat doesn't serialise the same name twice.
    const rawOut = rawArgs["out"];
    let out: string[] = [];
    if (rawOut !== undefined) {
      if (!Array.isArray(rawOut) || !rawOut.every((o) => typeof o === "string")) {
        throw new AbapError("BAD_INPUT", 'core.eval "out", when given, must be an array of strings.', {
          field: "out",
        });
      }
      for (const name of rawOut as string[]) {
        if (!EVAL_OUT_NAME_RE.test(name)) {
          throw new AbapError(
            "BAD_INPUT",
            `core.eval "out" name ${JSON.stringify(name)} must match ${EVAL_OUT_NAME_RE}.`,
            { field: "out", value: name },
          );
        }
      }
      const seen = new Set<string>();
      out = (rawOut as string[]).filter((name) => {
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
      });
    }

    // 5. Static review — a lint, not a sandbox (see static-review.ts's own doc comment): the same
    // shipped-rule pass a plugin's ABAP source goes through. `lines.join("\n")` keeps
    // `finding.line` a direct 1-based index into the caller's own `lines` array.
    const findings = reviewFluidAbap(CORE_EVAL_CONFIRM, lines.join("\n"));
    const firstFinding = findings[0];
    if (firstFinding !== undefined) {
      throw new AbapError(
        "FLUID_MANIFEST_INVALID",
        `static review refused core.eval at line ${firstFinding.line}, rule "${firstFinding.rule}": ${firstFinding.text}`,
        { tool: req.tool, action: req.action, line: firstFinding.line, rule: firstFinding.rule },
      );
    }

    // 6. Capability scan — separate from static review: these constructs are allowed, but only
    // behind their own ceiling flag. Same two flags and codes plugin-loader.ts uses for the exact
    // same scan over plugin ABAP source.
    const caps = scanFluidCapabilities(CORE_EVAL_CONFIRM, lines.join("\n"));
    const mutateHit = caps.find((c) => c.capability === "db-write" || c.capability === "commit-rollback");
    if (mutateHit !== undefined && !deps.cfg.allowFluidPluginMutate) {
      throw new AbapError(
        "FLUID_PLUGIN_MUTATE_DISABLED",
        `core.eval line ${mutateHit.line} (${JSON.stringify(mutateHit.text)}) contains a database write or ` +
          `COMMIT WORK/ROLLBACK WORK statement; ABAP_ALLOW_FLUID_PLUGIN_MUTATE is off`,
        { tool: req.tool, action: req.action, line: mutateHit.line, rule: "ABAP_ALLOW_FLUID_PLUGIN_MUTATE" },
      );
    }
    const callFmHit = caps.find((c) => c.capability === "call-function");
    if (callFmHit !== undefined && !deps.cfg.allowFluidCallFm) {
      throw new AbapError(
        "SAFETY_DENIED",
        `core.eval line ${callFmHit.line} (${JSON.stringify(callFmHit.text)}) contains CALL FUNCTION; ` +
          `ABAP_ALLOW_FLUID_CALL_FM is off`,
        { tool: req.tool, action: req.action, line: callFmHit.line, rule: "ABAP_ALLOW_FLUID_CALL_FM" },
      );
    }
    return;
  }
}

function evalArgsRecord(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

/**
 * Normalised eval args, after `guardCoreAction` has validated them: `lines` verbatim, `out`
 * deduped preserving order. Callers downstream of the guard (`dispatch.ts`'s invoker-source and
 * journal wiring) use this instead of re-deriving the same shape by hand.
 */
export function parseEvalArgs(args: Readonly<Record<string, unknown>>): { lines: string[]; out: string[] } {
  const lines = Array.isArray(args["lines"]) ? (args["lines"] as unknown[]).filter((l): l is string => typeof l === "string") : [];
  const rawOut = Array.isArray(args["out"]) ? (args["out"] as unknown[]).filter((o): o is string => typeof o === "string") : [];
  const seen = new Set<string>();
  const out = rawOut.filter((name) => {
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  return { lines, out };
}
