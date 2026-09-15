/**
 * `abap_atc` — run ABAP Test Cockpit static analysis on an object, headless.
 *
 * One tool instead of SAP's ~10-endpoint split (worklists, runs, exemption
 * proposals/requests, contact persons, docs, user lookup): create/reuse a
 * worklist, run the checks, collect findings, report them. Exemption
 * requests are deliberately not exposed — an agent that can silence a
 * finding is a governance decision, not something to automate.
 *
 * Not a differentiator: SAP ships ATC for free and every ABAP dev has it in
 * ADT. The only value added here is running it without an IDE (SAP's ATC
 * lives inside Eclipse) — same checks, same verdicts, no IDE. Say so
 * plainly in docs/description so callers don't expect more.
 *
 * Gated as an `execute` operation (registered only for ABAP_MODE=edit|admin)
 * because a run creates a persistent worklist row on the server — see the
 * header of `src/adt/atc.ts` for the full argument. Consequence: a
 * read-only deployment cannot run ATC at all; CI needs ABAP_MODE=edit and
 * an allowlisted package.
 *
 * ## `op` (issue #78)
 *
 * Three operations share this one tool, each with its own key set and its
 * own gating story — see each branch of {@link registerAtcTools}'s handler:
 *
 *   - `"run"` (default): everything the tool has always done, now over one
 *     object (`object`, unchanged), several (`objects`), or a whole package
 *     (`package`, optionally `include_subpackages`). Every target — one
 *     object, every element of `objects`, or every package
 *     {@link expandPackageTree} discovers — is resolved and
 *     `gate.authorize("execute", …)`d SEPARATELY; nothing is authorized by
 *     proxy for a sibling.
 *   - `"variants"`: lists check variants via {@link listCheckVariants}. No
 *     object-level `execute` assert — see the comment at that branch.
 *   - `"delete_worklist"`: attempts to delete a worklist by id via
 *     {@link deleteAtcWorklist}. A worklist id is not a repository object,
 *     so it goes through a target-less capability probe instead of
 *     `gate.authorize` — see {@link assertCanDeleteAtcWorklist}.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AbapConnection } from "../adt/connection.js";
import { AbapError } from "../adt/errors.js";
import type { SessionPool } from "../adt/pool.js";
import { resolveObject } from "../adt/resolve.js";
import {
  deleteAtcWorklist,
  expandPackageTree,
  fetchDefaultCheckVariant,
  listCheckVariants,
  runAtcCheck,
  type AtcRunResult,
  type AtcWorklistCleanup,
} from "../adt/atc.js";
import {
  ATC_MAX_RUN_TARGETS,
  ATC_MAX_VERDICTS,
  packageObjectUri,
  priorityLabel,
} from "../adt/atc-query.js";
import type { AtcCheckVariant, FlatAtcFinding } from "../adt/atc-xml.js";
import type { Config } from "../config.js";
import { buildResponse, textTable, type BuiltResponse } from "../compact.js";
import type { AuthorizedTarget, SafetyGate } from "../safety.js";
import { preflight } from "./preflight.js";

// ------------------------------------------------------------------ schema ---

/** `op` values `abap_atc` accepts. `"run"` is the default (and everything issue #78 found). */
export const ATC_OPS = ["run", "variants", "delete_worklist"] as const;
export type AtcOp = (typeof ATC_OPS)[number];

export const atcInputSchema = {
  op: z
    .enum(ATC_OPS)
    .optional()
    .describe(`Operation. Default "run". One of: ${ATC_OPS.join(", ")}.`),
  object: z
    .string()
    .optional()
    .describe(
      "Class/program/function group/interface/package. op=run only; exactly one of " +
        "object/objects/package.",
    ),
  objects: z
    .array(z.string())
    .optional()
    .describe(
      `Several objects to check in one run. op=run only; exactly one of object/objects/package. ` +
        `Max ${ATC_MAX_RUN_TARGETS}.`,
    ),
  package: z
    .string()
    .optional()
    .describe("Package to check. op=run only; exactly one of object/objects/package."),
  include_subpackages: z
    .boolean()
    .optional()
    .describe("With package: also check its subpackages. Default false. Only valid with package."),
  type: z.string().optional().describe("ADT type, e.g. CLAS/OC, when ambiguous. op=run only."),
  variant: z.string().optional().describe("Check variant. Default: system. op=run only."),
  max_findings: z
    .number()
    .int()
    .optional()
    .describe(`Cap on findings. Default 100, max ${ATC_MAX_VERDICTS}. op=run only.`),
  include_exempted: z
    .boolean()
    .optional()
    .describe("Include exempted findings. Default false. op=run only."),
  severity: z
    .enum(["error", "warning", "info"])
    .optional()
    .describe("Lowest severity, cumulative. Default info. op=run only."),
  auto_cleanup: z
    .boolean()
    .optional()
    .describe(
      "Attempt to delete the worklist after reading findings. Default false. op=run only. On " +
        "this server this is a documented refusal, not a guarantee — see the cleanup note.",
    ),
  worklist_id: z
    .string()
    .optional()
    .describe("Worklist id to delete. Required for, and only valid with, op=delete_worklist."),
};

/** Full schema, for type inference and for the unknown-argument check. */
export const AtcInput = z.object(atcInputSchema);
export type AtcInput = z.infer<typeof AtcInput>;

const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(AtcInput.shape));

/**
 * Refuse arguments this tool does not have.
 *
 * The SDK boundary doesn't strip unknown keys silently, so this turns "I
 * passed `severity_level` and nothing happened" into a named error. Same
 * pattern as `rejectUnknownArgs` in `./dumps.ts`.
 */
function rejectUnknownArgs(args: Record<string, unknown>): void {
  const unknown = Object.keys(args).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length === 0) return;
  throw new AbapError(
    "BAD_INPUT",
    `abap_atc does not take ${unknown.map((k) => `\`${k}\``).join(", ")}.`,
    { unknown, known: [...KNOWN_KEYS] },
    `Parameters are: ${[...KNOWN_KEYS].join(", ")}.`,
  );
}

/** Keys meaningful for `op="run"` — every key except `worklist_id`. */
const RUN_KEYS: ReadonlySet<string> = new Set([
  "object",
  "objects",
  "package",
  "include_subpackages",
  "type",
  "variant",
  "max_findings",
  "include_exempted",
  "severity",
  "auto_cleanup",
]);

/** Keys meaningful for `op="delete_worklist"` — just the id. */
const DELETE_WORKLIST_KEYS: ReadonlySet<string> = new Set(["worklist_id"]);

/**
 * `op="variants"` takes no keys at all beyond `op` itself: it is a bare
 * repository search, with no per-object or run-shaping parameter to accept.
 */
const OP_ALLOWED_KEYS: Readonly<Record<AtcOp, ReadonlySet<string>>> = {
  run: RUN_KEYS,
  variants: new Set(),
  delete_worklist: DELETE_WORKLIST_KEYS,
};

/** Reads and validates `op`, defaulting to `"run"`. Never touches the network. */
function resolveOp(args: Record<string, unknown>): AtcOp {
  const raw = args.op;
  if (raw === undefined) return "run";
  if (typeof raw === "string" && (ATC_OPS as readonly string[]).includes(raw)) {
    return raw as AtcOp;
  }
  throw new AbapError(
    "BAD_INPUT",
    `abap_atc op must be one of ${ATC_OPS.join(", ")}; got ${JSON.stringify(raw)}.`,
    { op: raw },
    `Pass op as one of: ${ATC_OPS.join(", ")}.`,
  );
}

/**
 * Op-specific validation: which keys an op accepts (refusing the rest
 * rather than silently ignoring them), plus the mutual-exclusion and
 * cardinality rules `op="run"`/`op="delete_worklist"` each need. Zero
 * network cost — pure function of the raw arguments, like `rejectUnknownArgs`.
 */
function validateOpArgs(args: Record<string, unknown>, op: AtcOp): void {
  const allowed = OP_ALLOWED_KEYS[op];
  const irrelevant = Object.keys(args).filter(
    (k) => k !== "op" && args[k] !== undefined && !allowed.has(k),
  );
  if (irrelevant.length > 0) {
    throw new AbapError(
      "BAD_INPUT",
      `abap_atc op="${op}" does not take ${irrelevant.map((k) => `\`${k}\``).join(", ")} — ` +
        (op === "variants"
          ? "listing check variants is a repository search with no per-object or run-shaping " +
            "parameter."
          : "deleting a worklist only needs worklist_id."),
      { op, irrelevant },
      `Drop ${irrelevant.length === 1 ? "that parameter" : "those parameters"}${
        op !== "run" ? ', or set op="run" if you meant to run a check' : ""
      }.`,
    );
  }

  if (op === "delete_worklist") {
    const id = args.worklist_id;
    if (typeof id !== "string" || id.trim() === "") {
      throw new AbapError(
        "BAD_INPUT",
        'abap_atc op="delete_worklist" needs worklist_id.',
        { op },
        "Pass the worklist id shown in a previous run's notes as worklist_id (the number after " +
          '"Worklist " — e.g. "Worklist 12345 (created)" — or after "Cleanup: worklist").',
      );
    }
    return;
  }

  if (op !== "run") return;

  const scopeKeys = (["object", "objects", "package"] as const).filter(
    (k) => args[k] !== undefined,
  );
  if (scopeKeys.length !== 1) {
    throw new AbapError(
      "BAD_INPUT",
      scopeKeys.length === 0
        ? "abap_atc needs exactly one of object, objects, package."
        : `abap_atc got more than one of ${scopeKeys.map((k) => `\`${k}\``).join(", ")} — exactly ` +
          "one names the run's scope.",
      { scopeKeys },
      "Pass exactly one of object, objects, package.",
    );
  }

  if (args.include_subpackages !== undefined && args.package === undefined) {
    throw new AbapError(
      "BAD_INPUT",
      "`include_subpackages` only makes sense together with `package`.",
      { include_subpackages: args.include_subpackages },
      "Either add `package`, or drop `include_subpackages`.",
    );
  }

  if (args.objects !== undefined) {
    const objs = args.objects;
    if (!Array.isArray(objs) || objs.length === 0) {
      throw new AbapError(
        "BAD_INPUT",
        "`objects` must be a non-empty array of object names.",
        { objects: args.objects },
        "Pass one or more names in `objects`, or use `object` for a single one.",
      );
    }
    if (objs.length > ATC_MAX_RUN_TARGETS) {
      throw new AbapError(
        "BAD_INPUT",
        `\`objects\` names ${objs.length} objects; abap_atc runs at most ${ATC_MAX_RUN_TARGETS} in one call.`,
        { count: objs.length, max: ATC_MAX_RUN_TARGETS },
        `Split into batches of at most ${ATC_MAX_RUN_TARGETS}.`,
      );
    }
  }
}

/**
 * The zero-network `preflight()` targets `op="run"` must gate BEFORE
 * connecting — one per `object`, every element of `objects`, or the named
 * `package` (its root only; subpackages `expandPackageTree` later discovers
 * are unknowable without a round trip, so they get their own authorize call
 * post-resolution — see {@link resolveAndAuthorizePackage}). Mirrors the
 * DEVC/K branch of `preflight()` itself for the package case.
 */
function preflightTargetsFor(args: Record<string, unknown>): ReturnType<typeof preflight>[] {
  const type = typeof args.type === "string" ? args.type : undefined;
  if (typeof args.object === "string") {
    return [preflight({ object: args.object, ...(type === undefined ? {} : { type }) })];
  }
  if (Array.isArray(args.objects)) {
    return args.objects
      .filter((o): o is string => typeof o === "string")
      .map((o) => preflight({ object: o, ...(type === undefined ? {} : { type }) }));
  }
  if (typeof args.package === "string") {
    return [preflight({ object: args.package, type: "DEVC/K" })];
  }
  return [];
}

/**
 * Cap on how many "TYPE NAME" labels {@link atcObjectsLabel} spells out on
 * an `objects`-scoped run's header line before truncating. `objects` accepts
 * up to {@link ATC_MAX_RUN_TARGETS} (50) names, and spelling out all of them
 * would put ~50 pairs on one line — this project marks truncation rather
 * than emitting an unbounded blob (mirrors `namesLabel` in `src/adt/atc.ts`,
 * private there, so re-implemented here for this header-line use; the count
 * stays exact even when the spelled-out list is cut).
 */
const ATC_OBJECTS_LABEL_MAX = 10;

/** `objectLabel` for an `objects`-scoped run — see {@link ATC_OBJECTS_LABEL_MAX}. */
export function atcObjectsLabel(labels: readonly string[]): string {
  if (labels.length <= ATC_OBJECTS_LABEL_MAX) {
    return `${labels.length} objects (${labels.join(", ")})`;
  }
  const shown = labels.slice(0, ATC_OBJECTS_LABEL_MAX);
  return (
    `${labels.length} objects (${shown.join(", ")} … [truncated, ${shown.length} of ` +
    `${labels.length} shown])`
  );
}

const SEVERITY_CEILING: Readonly<Record<string, number>> = {
  error: 1,
  warning: 2,
  info: 3,
};

// --------------------------------------------------------------- rendering ---

/** `ZCL_ORDER:42` / `ZCL_ORDER` when the finding carries no line. */
function where(f: FlatAtcFinding): string {
  return f.location.line === undefined ? f.objectName : `${f.objectName}:${f.location.line}`;
}

/**
 * Which quick-fix kinds a finding advertises, for the `FIX` column. `""`
 * when {@link AtcQuickFixFlags.any} is false — callers filter those findings
 * out of the FIX-column decision themselves (see {@link findingColumns}).
 */
function quickFixLabel(f: FlatAtcFinding): string {
  const q = f.quickFixes;
  if (!q) return "";
  const kinds: string[] = [];
  if (q.automatic) kinds.push("automatic");
  if (q.manual) kinds.push("manual");
  if (q.pseudo) kinds.push("pseudo");
  if (q.aiBased) kinds.push("ai");
  return kinds.join("+");
}

function findingRow(f: FlatAtcFinding, showFix: boolean): Record<string, string> {
  return {
    SEVERITY: priorityLabel(f.priority),
    WHERE: where(f),
    CHECK: f.checkTitle || f.checkId || "(unnamed check)",
    MESSAGE: f.messageTitle || `(message ${f.messageId})`,
    ...(showFix ? { FIX: quickFixLabel(f) } : {}),
    ...(f.exemptionKind === "" ? {} : { EXEMPT: f.exemptionKind }),
  };
}

/** Whole-run decision of which optional columns to show, shared by flat and grouped rendering. */
function findingColumns(findings: readonly FlatAtcFinding[]): {
  columns: string[];
  showFix: boolean;
} {
  const showFix = findings.some((f) => f.quickFixes?.any === true);
  const anyExempt = findings.some((f) => f.exemptionKind !== "");
  const columns = [
    "SEVERITY",
    "WHERE",
    "CHECK",
    "MESSAGE",
    ...(showFix ? ["FIX"] : []),
    ...(anyExempt ? ["EXEMPT"] : []),
  ];
  return { columns, showFix };
}

function renderFindings(findings: readonly FlatAtcFinding[]): string {
  if (findings.length === 0) return "";
  const { columns, showFix } = findingColumns(findings);
  const rows = findings.map((f) => findingRow(f, showFix));
  return textTable(rows, columns);
}

/**
 * Group findings by object, one block per object with its own count and
 * table — used only when a run covers more than one object (see
 * {@link renderAtcResult}'s `grouped` decision). A single-object run keeps
 * {@link renderFindings}'s flat table unchanged, minimising churn in today's
 * output.
 */
function renderGroupedFindings(findings: readonly FlatAtcFinding[]): string {
  if (findings.length === 0) return "";
  const { columns, showFix } = findingColumns(findings);
  const byObject = new Map<string, FlatAtcFinding[]>();
  for (const f of findings) {
    const key = `${f.objectType} ${f.objectName}`;
    let group = byObject.get(key);
    if (!group) {
      group = [];
      byObject.set(key, group);
    }
    group.push(f);
  }
  const blocks: string[] = [];
  for (const [label, group] of byObject) {
    const rows = group.map((f) => findingRow(f, showFix));
    blocks.push(`${label} — ${group.length} finding(s)\n${textTable(rows, columns)}`);
  }
  return blocks.join("\n\n");
}

/**
 * Turn a run into a response. Split out from {@link abapAtc} so the
 * rendering — where every "don't mistake this for a clean result" note
 * lives — is testable without a connection.
 */
export function renderAtcResult(
  result: AtcRunResult,
  input: {
    readonly objectLabel: string;
    readonly severity?: string;
    /** True when this run's scope came from `package` (directly, or via `expandPackageTree`). */
    readonly packageScoped?: boolean;
  },
  maxChars: number,
): BuiltResponse {
  const floor = SEVERITY_CEILING[input.severity ?? "info"] ?? 3;
  const shown = result.findings.filter(
    // Priority 0 is "the server did not say"; it is never filtered out, because
    // hiding a finding whose severity is unknown is exactly the kind of silent
    // omission this tool must not make.
    (f) => f.priority === 0 || f.priority <= floor,
  );
  const suppressed = result.findings.length - shown.length;

  // Group only when the run covered more than one object — by declared
  // target count (the common, cheap case) or, defensively, by the findings
  // actually naming more than one object (e.g. an unscoped worklist read
  // spanning earlier runs). A single-object run stays the flat table.
  const distinctObjects = new Set(result.findings.map((f) => `${f.objectType} ${f.objectName}`))
    .size;
  const grouped = result.targetCount > 1 || distinctObjects > 1;

  const notes: string[] = [];

  if (result.findings.length === 0) {
    notes.push(
      `No findings. ATC ran check variant ${result.checkVariant} over ${input.objectLabel} and ` +
        "reported nothing — this is a clean result for THAT variant, not a statement that the " +
        "object is correct. A different variant runs different checks.",
    );
  }

  if (!result.objectSetIsComplete) {
    notes.push(
      `INCOMPLETE: ATC stopped before finishing, most likely at the ${result.maxVerdicts}-finding ` +
        "cap (max_findings). There may be more findings than are listed here. Fix these and run " +
        "again, or raise max_findings.",
    );
  }

  if (!result.scopedToLastRun) {
    notes.push(
      "UNSCOPED: the server named no LAST_RUN object set for this worklist, so these findings " +
        "are the whole worklist and may include results from an earlier run against " +
        "already-changed source. Treat line numbers with suspicion.",
    );
  }

  if (suppressed > 0) {
    notes.push(
      `${suppressed} finding(s) below severity "${input.severity}" are not listed. Omit severity ` +
        "to see all of them.",
    );
  }

  // ADT's run acknowledgement has been observed sending byte-identical
  // <atcinfo:info> nodes for the same run (e.g. two FINDING_STATS entries
  // with the same description — captured in test/fixtures/live-captured/438-atc2-run.xml).
  // parseAtcRunAck faithfully keeps both — it must stay a
  // true record of what the server sent — so dedupe by (type, description)
  // here, at the render site, instead.
  const seenInfos = new Set<string>();
  for (const info of result.infos) {
    const key = `${info.type} ${info.description}`;
    if (seenInfos.has(key)) continue;
    seenInfos.add(key);
    notes.push(`ATC: ${info.description || info.type}`);
  }

  if (shown.length > 0) {
    const showFix = shown.some((f) => f.quickFixes?.any === true);
    notes.push(
      showFix
        ? "FIX column: manual/automatic/pseudo/ai marks which quick-fix kind ATC advertises for " +
          "that finding (only \"automatic\" applies without review). Pass the finding to " +
          "abap_quick_fix to inspect or apply it."
        : "ATC advertised no quick fix for any finding shown (every quickfixes flag was false) — " +
          "abap_quick_fix has nothing to apply here.",
    );
  }

  if (result.variantUnvalidated !== undefined) {
    notes.push(
      `Check variant "${result.checkVariant}" was used UNVALIDATED: ${result.variantUnvalidated} If ` +
        "it does not exist, ATC may have run a default variant instead or errored — check the " +
        "ATC: notes.",
    );
  }

  // A synchronous package-scoped run (directly, or expanded from subpackages)
  // can exceed ABAP_TIMEOUT_MS (default 60000ms) — a live run of ~77 classes
  // in one package took 134s. See the module header of src/adt/atc.ts.
  if (input.packageScoped === true || result.targetCount > 10) {
    notes.push(
      `TIMEOUT RISK: this run covered ${result.targetCount} object(s)` +
        `${input.packageScoped === true ? " (package-scoped)" : ""}. ATC runs synchronously over ` +
        "ADT and a large scope can exceed ABAP_TIMEOUT_MS (default 60000ms) — one observed run of " +
        "~77 classes in a single package took 134s. If this call times out, its worklist survives " +
        "on the server (see the next note) rather than vanishing, and a retry reuses it. Consider " +
        "raising ABAP_TIMEOUT_MS for package-scoped runs.",
    );
  }

  // Worklists persist because the server refuses deletion, not because this
  // client declines to try. See the module header of src/adt/atc.ts.
  notes.push(
    `Worklist ${result.worklistId} (${result.worklistReused ? "reused" : "created"}) — this server ` +
      "refuses to delete ATC worklists (DELETE returns 405) and its advertised deleteFindings " +
      "action is a no-op, so worklists persist; this client reuses one per check variant rather " +
      "than creating a new one per run.",
  );

  if (result.cleanup) {
    const cl = result.cleanup;
    notes.push(
      cl.deleted
        ? `Cleanup: worklist ${cl.worklistId} was deleted.`
        : `Cleanup: worklist ${cl.worklistId} was NOT deleted — the server refused` +
          `${cl.status !== undefined ? ` (HTTP ${cl.status})` : ""}` +
          `${cl.reason ? `: ${cl.reason}.` : "."} ` +
          (cl.cacheCleared
            ? "This client forgot its cached worklist id anyway, so the next run creates a new one."
            : "This client kept its cached worklist id, so the next run reuses this same, " +
              "still-undeleted worklist."),
    );
  }

  const c = result.counts;

  // DOCS: each distinct check's documentation link, when the server sent one.
  const docs = new Map<string, string>();
  for (const f of shown) {
    if (f.documentationUri && !docs.has(f.checkId)) docs.set(f.checkId, f.documentationUri);
  }
  const sections =
    docs.size > 0
      ? [
          {
            title: "DOCS",
            content: [...docs.entries()].map(([id, uri]) => `${id}: ${uri}`).join("\n"),
          },
        ]
      : undefined;

  return buildResponse({
    header: {
      object: input.objectLabel,
      variant: result.checkVariant,
      findings: c.total,
      errors: c.errors,
      warnings: c.warnings,
      info: c.infos,
      // Only when non-zero: a priority this client does not know about is worth
      // seeing, and a permanent `other: 0` is noise.
      other: c.other > 0 ? c.other : undefined,
      exempted: c.exempted > 0 ? c.exempted : undefined,
      complete: result.objectSetIsComplete ? undefined : "no",
      targets: result.targetCount > 1 ? result.targetCount : undefined,
    },
    ...(sections ? { sections } : {}),
    body: grouped ? renderGroupedFindings(shown) : renderFindings(shown),
    bodyLabel: "FINDINGS",
    notes,
    hints: [
      "Each row is one finding: severity, object:line, the check that fired, and its message. " +
        "Read the source at that line with abap_read.",
    ],
    maxChars,
  });
}

/**
 * `op="variants"`: a compact table of check variants, server order.
 *
 * `opts.defaultVariant`, when given, is this system's ATC customizing
 * default ({@link fetchDefaultCheckVariant} — grounded in capture
 * `893-i78-atc-customizing.xml`, cached per connection, and a single GET the
 * `op="run"` path already performs on every default run) — the matching row
 * gets a DEFAULT mark. `opts.defaultUnavailable`, when given instead, is why
 * that read could not be done — the listing itself still renders, fail-open
 * like {@link resolveCheckVariant}, just without anything marked DEFAULT.
 */
export function renderCheckVariants(
  variants: readonly AtcCheckVariant[],
  maxChars: number,
  opts: {
    readonly defaultVariant?: string;
    readonly defaultUnavailable?: string;
  } = {},
): BuiltResponse {
  const anyDescription = variants.some((v) => v.description);
  const anyPackage = variants.some((v) => v.packageName);
  const markDefault = opts.defaultVariant !== undefined;
  const isDefault = (name: string): boolean =>
    markDefault && name.toLowerCase() === opts.defaultVariant?.toLowerCase();
  const columns = [
    "NAME",
    ...(anyDescription ? ["DESCRIPTION"] : []),
    ...(anyPackage ? ["PACKAGE"] : []),
    ...(markDefault ? ["DEFAULT"] : []),
  ];
  const rows = variants.map((v) => ({
    NAME: v.name,
    ...(anyDescription ? { DESCRIPTION: v.description ?? "" } : {}),
    ...(anyPackage ? { PACKAGE: v.packageName ?? "" } : {}),
    ...(markDefault ? { DEFAULT: isDefault(v.name) ? "yes" : "" } : {}),
  }));
  return buildResponse({
    header: { variants: variants.length },
    body: textTable(rows, columns),
    bodyLabel: "CHECK VARIANTS",
    notes: [
      `${variants.length} check variant(s) found, in the server's own order. ` +
        (markDefault
          ? `DEFAULT marks "${opts.defaultVariant}" — this system's ATC customizing default.`
          : "The system default could not be determined, so no variant is marked DEFAULT" +
            (opts.defaultUnavailable ? `: ${opts.defaultUnavailable}` : "") +
            ".") +
        " Pass one of these NAMEs as `variant` to abap_atc, or omit it to use the default.",
    ],
    hints: ['Pass a NAME here as `variant` to abap_atc op="run".'],
    maxChars,
  });
}

/** `op="delete_worklist"`: the cleanup outcome, read as a refusal when it is one. */
export function renderWorklistCleanup(
  cleanup: AtcWorklistCleanup,
  maxChars: number,
): BuiltResponse {
  return buildResponse({
    header: {
      worklist: cleanup.worklistId,
      deleted: cleanup.deleted,
      status: cleanup.status,
      cache_cleared: cleanup.cacheCleared,
    },
    notes: [
      cleanup.deleted
        ? `Worklist ${cleanup.worklistId} was deleted.`
        : `Worklist ${cleanup.worklistId} was NOT deleted — the server refused` +
          `${cleanup.status !== undefined ? ` (HTTP ${cleanup.status})` : ""}` +
          `${cleanup.reason ? `: ${cleanup.reason}.` : "."} ` +
          (cleanup.cacheCleared
            ? "This client forgot its cached worklist id anyway, so the next run creates a new one."
            : "This client kept its cached worklist id, so the next run reuses this same, " +
              "still-undeleted worklist."),
    ],
    maxChars,
  });
}

// -------------------------------------------------------------------- core ---

async function resolveAndAuthorizeObjects(
  conn: AbapConnection,
  gate: SafetyGate,
  objectNames: readonly string[],
  type: string | undefined,
): Promise<{
  uris: string[];
  authorized: AuthorizedTarget<"execute">[];
  labels: string[];
}> {
  const uris: string[] = [];
  const authorized: AuthorizedTarget<"execute">[] = [];
  const labels: string[] = [];
  for (const name of objectNames) {
    const obj = await resolveObject(conn, name, type === undefined ? {} : { type });
    // Source-based objects check via source URI (only shape `abap-adt-api`
    // sends); DDIC objects have no source URI, so use their own.
    uris.push(obj.sourceUri ?? obj.uri);
    authorized.push(
      gate.authorize("execute", {
        name: obj.name,
        ...(obj.packageName === undefined ? {} : { packageName: obj.packageName }),
        type: obj.type,
      }),
    );
    labels.push(`${obj.type} ${obj.name}`);
  }
  return { uris, authorized, labels };
}

/**
 * `package` scope: resolve the named package, expand it (root only, unless
 * `includeSubpackages`) via {@link expandPackageTree}, then authorize EVERY
 * discovered package separately — never authorize the root and let that
 * stand in for its subpackages. A package's own `packageName` is itself
 * (mirrors the DEVC/K branch of `preflight()`).
 */
async function resolveAndAuthorizePackage(
  conn: AbapConnection,
  gate: SafetyGate,
  packageName: string,
  includeSubpackages: boolean,
): Promise<{
  uris: string[];
  authorized: AuthorizedTarget<"execute">[];
  label: string;
  targetCount: number;
}> {
  const pkg = await resolveObject(conn, packageName, { type: "DEVC/K" });
  const names = await expandPackageTree(conn, pkg.name, { includeSubpackages });
  const uris: string[] = [];
  const authorized: AuthorizedTarget<"execute">[] = [];
  for (const name of names) {
    uris.push(packageObjectUri(name));
    authorized.push(gate.authorize("execute", { name, packageName: name, type: "DEVC/K" }));
  }
  const label =
    names.length > 1
      ? `package ${pkg.name} (+${names.length - 1} subpackage(s), ${names.length} package(s) total)`
      : `package ${pkg.name}`;
  return { uris, authorized, label, targetCount: names.length };
}

/**
 * Resolve, gate, run, render — `op="run"`, over `object`/`objects`/`package`.
 *
 * The gate calls mint the `AuthorizedTarget<"execute">[]` that `runAtcCheck`
 * requires — that parameter is the reason this cannot be reached without a
 * gate decision per target, rather than a convention someone can forget.
 */
export async function abapAtc(
  conn: AbapConnection,
  input: AtcInput,
  maxChars: number,
  gate: SafetyGate,
): Promise<BuiltResponse> {
  let uris: readonly string[];
  let authorized: readonly AuthorizedTarget<"execute">[];
  let objectLabel: string;
  let packageScoped = false;

  if (input.object !== undefined) {
    // Unchanged from before issue #78: one resolve, one authorize.
    const obj = await resolveObject(conn, input.object, input.type === undefined ? {} : { type: input.type });
    uris = [obj.sourceUri ?? obj.uri];
    authorized = [
      gate.authorize("execute", {
        name: obj.name,
        ...(obj.packageName === undefined ? {} : { packageName: obj.packageName }),
        type: obj.type,
      }),
    ];
    objectLabel = `${obj.type} ${obj.name}`;
  } else if (input.objects !== undefined) {
    const r = await resolveAndAuthorizeObjects(conn, gate, input.objects, input.type);
    uris = r.uris;
    authorized = r.authorized;
    objectLabel = atcObjectsLabel(r.labels);
  } else if (input.package !== undefined) {
    const r = await resolveAndAuthorizePackage(
      conn,
      gate,
      input.package,
      input.include_subpackages === true,
    );
    uris = r.uris;
    authorized = r.authorized;
    objectLabel = r.label;
    packageScoped = true;
  } else {
    // Unreachable in practice: validateOpArgs already enforced exactly one
    // of object/objects/package for op="run" before this function is called.
    throw new AbapError(
      "BAD_INPUT",
      'abap_atc op="run" needs exactly one of object, objects, package.',
      {},
      "Pass exactly one of object, objects, package.",
    );
  }

  const result = await runAtcCheck(
    conn,
    {
      objectUris: uris,
      ...(input.variant === undefined ? {} : { checkVariant: input.variant }),
      ...(input.max_findings === undefined ? {} : { maxVerdicts: input.max_findings }),
      ...(input.include_exempted === undefined ? {} : { includeExempted: input.include_exempted }),
      ...(input.auto_cleanup === undefined ? {} : { autoCleanup: input.auto_cleanup }),
    },
    authorized,
  );

  return renderAtcResult(
    result,
    {
      objectLabel,
      ...(input.severity === undefined ? {} : { severity: input.severity }),
      packageScoped,
    },
    maxChars,
  );
}

/**
 * `op="variants"`. The listing itself (`listCheckVariants`) is load-bearing —
 * a failure there fails the whole op, unchanged. The default-variant read is
 * NOT: it fails open, same spirit as {@link resolveCheckVariant} — a caller
 * asking "what variants exist" should still get the list even when the
 * separate customizing read that names the default cannot be done.
 */
export async function abapAtcVariants(conn: AbapConnection, maxChars: number): Promise<BuiltResponse> {
  const variants = await listCheckVariants(conn);
  try {
    const defaultVariant = await fetchDefaultCheckVariant(conn);
    return renderCheckVariants(variants, maxChars, { defaultVariant });
  } catch (e) {
    const defaultUnavailable = e instanceof Error ? e.message : String(e);
    return renderCheckVariants(variants, maxChars, { defaultUnavailable });
  }
}

/** `op="delete_worklist"`. */
export async function abapAtcDeleteWorklist(
  conn: AbapConnection,
  worklistId: string,
  maxChars: number,
): Promise<BuiltResponse> {
  const cleanup = await deleteAtcWorklist(conn, worklistId);
  return renderWorklistCleanup(cleanup, maxChars);
}

/**
 * Target-less capability probe for `op="delete_worklist"`. A worklist id is
 * not a repository object, so `gate.authorize`/`gate.assert` cannot mint or
 * judge a `SafetyTarget` for it (`SafetyTarget` requires a `name`). Mirrors
 * `ceilingDecision`/`assertCeiling` in `src/tools/transport.ts:509-520` and
 * the target-less pattern sanctioned at `src/safety.ts:1355`: call
 * `gate.evaluate("execute", undefined, {})` directly instead of going
 * through `authorize`.
 *
 * Unlike `"transport"`'s `evaluate()` branch, `"execute"` has no early
 * ceiling carve-out for the no-target case — it falls through to the
 * generic `if (!obj) return {code: "SAFETY_DENIED", reason: "No object
 * supplied for a mutating operation."}` branch (src/safety.ts, just above
 * where the object-keyed rules start). That SAFETY_DENIED means "an
 * allowlist didn't match a target" — inapplicable here, since there never
 * is a target — so it is undecidable, not a real denial, and is treated as
 * allowed. READ_ONLY and ROLE_PROBE_FAILED fire earlier and
 * unconditionally (productive / writesLockedOut / readOnly checks all run
 * before the `!obj` branch), so they are still enforced.
 */
function assertCanDeleteAtcWorklist(gate: SafetyGate): void {
  const d = gate.evaluate("execute", undefined, {});
  if (d.allowed || d.code === "SAFETY_DENIED") return;
  throw new AbapError(
    d.code ?? "READ_ONLY",
    d.reason,
    { operation: "atc.deleteWorklist", rule: d.rule },
    d.hint ?? "Deleting an ATC worklist needs the same write capability as running ATC.",
  );
}

// ---------------------------------------------------------------- register ---

export interface AtcToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars">;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/**
 * Registers `abap_atc`. Preflight-gated as `execute` (zero-HTTP-cost
 * refusal) for `op="run"`/`op="delete_worklist"`, then run in a READ slot —
 * per `pool.ts` ROLE SEMANTICS, an ATC run/list/delete-attempt takes no ABAP
 * enqueue and must not hold the single write slot for its duration.
 */
export function registerAtcTools(mcp: McpServer, deps: AtcToolDeps): void {
  mcp.registerTool(
    "abap_atc",
    {
      description:
        "ATC static analysis; findings: severity, line, check, message. Without an IDE " +
        "— it computes nothing SAP does not already compute. Clean means clean FOR " +
        "THAT VARIANT. Execute-gated: needs ABAP_MODE=edit/admin, allowlisted package. " +
        'op="run" (default) checks object/objects/package; op="variants" lists check ' +
        'variants; op="delete_worklist" attempts to delete a worklist by id (a documented ' +
        "refusal on servers that return 405 for DELETE).",
      inputSchema: atcInputSchema,
      annotations: {
        // Not read-only: a run creates a worklist row on the server.
        readOnlyHint: false,
        // Not destructive: state is additive only; marking it destructive
        // would teach callers to ignore that flag.
        destructiveHint: false,
        // Not idempotent: each run adds a worklist run, even if findings match.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const a = (args ?? {}) as Record<string, unknown>;
        rejectUnknownArgs(a);
        const op = resolveOp(a);
        validateOpArgs(a, op);

        if (op === "run") {
          for (const pf of preflightTargetsFor(a)) {
            deps.safety.assert("execute", pf, { phase: "preflight" });
          }
          await deps.ensureConnected();
          // A READ slot: an ATC run takes no ABAP enqueue (pool.ts, ROLE
          // SEMANTICS). It is still gated as `execute` above and again inside.
          const res = await deps.pool.withRead("abap_atc", (conn) =>
            abapAtc(conn, a as AtcInput, deps.cfg.maxResponseChars, deps.safety),
          );
          return ok(res.text);
        }

        if (op === "delete_worklist") {
          // Zero-network capability probe — refuses under READ_ONLY (or an
          // unclassified system) before any HTTP, same guarantee as the
          // preflight-assert above.
          assertCanDeleteAtcWorklist(deps.safety);
          await deps.ensureConnected();
          const worklistId = a.worklist_id as string;
          const res = await deps.pool.withRead("abap_atc", (conn) =>
            abapAtcDeleteWorklist(conn, worklistId, deps.cfg.maxResponseChars),
          );
          return ok(res.text);
        }

        // op === "variants": no object-level `execute` assert. Listing check
        // variants is a repository search — it creates and touches nothing —
        // and this tool is registered ONLY for ABAP_MODE=edit|admin (a
        // read-only deployment gets the mode-locked refusal stub under this
        // same name instead, src/tools/locked.ts), so the capability is
        // already gated at registration time. Asserting `execute` again here
        // with no object would just hit the target-less SAFETY_DENIED branch
        // for no reason — this op has no target to authorize.
        await deps.ensureConnected();
        const res = await deps.pool.withRead("abap_atc", (conn) =>
          abapAtcVariants(conn, deps.cfg.maxResponseChars),
        );
        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
