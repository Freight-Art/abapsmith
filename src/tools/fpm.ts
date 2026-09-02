/**
 * `abap_fpm_read` — reads SAP FPM/FBI screen configs. No ADT read endpoint
 * exists for this content (every write verb 405s — see `src/adt/fpm-runtime.ts`).
 * Like `abap_bopf_test`, it works by generating/activating a throwaway
 * `IF_OO_ADT_CLASSRUN` bridge class in $TMP, so despite being read-only in
 * effect it goes through `pool.withWrite` and is gated as a write on the
 * bridge class name.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { AbapError } from "../adt/errors.js";
import {
  fpmBridgeClassName,
  runFpmRead,
  type FpmAppQuery,
  type FpmBridgeQuery,
  type FpmFindQuery,
  type FpmOutlineQuery,
  type FpmReadResult,
} from "../adt/fpm-runtime.js";
import {
  assertLockConfigType,
  fpmLockBridgeClassName,
  runFpmLockInspect,
  type FpmLockInspectQuery,
  type FpmLockReadResult,
} from "../adt/fpm-lock.js";
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import { buildResponse, textTable, CHARS_PER_TOKEN } from "../compact.js";
import type { SafetyGate } from "../safety.js";

export const fpmReadInputSchema = {
  mode: z
    .enum(["find", "outline", "app", "locks"])
    .describe(
      "find: search configs. outline: one config's node tree. app: an application config's full " +
        "UIBB hierarchy. locks: who holds enqueue locks on a config.",
    ),
  config_id: z
    .string()
    .optional()
    .describe("Configuration ID (max 32). Required for outline/app/locks."),
  config_type: z.string().optional().describe("NUMC2. 00=component, 02=application. Default 00."),
  config_var: z.string().optional().describe("Variant (max 6). Default blank."),
  component: z.string().optional().describe("find: filter by Web Dynpro component."),
  query: z.string().optional().describe("find: config ID pattern, * wildcard."),
  package: z.string().optional().describe("find: filter by package."),
  resolve: z.boolean().optional().describe("app: expand each UIBB's feeder/BOPF binding. Default true."),
  detail: z
    .enum(["compact", "full"])
    .optional()
    .describe(
      'find/app only. Default "compact" (digest); "full" returns everything. Ignored by ' +
        "outline/locks (already compact).",
    ),
  xml_offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('outline: 0-based char offset into the XML to start from. Default 0.'),
  xml_limit: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('outline: max XML chars to return from xml_offset. xmlChars always reports the full length.'),
};

export const FpmReadInput = z.object(fpmReadInputSchema);
export type FpmReadInput = z.infer<typeof FpmReadInput>;

/** Never passed to {@link buildQuery}/{@link fpmBridgeClassName} — must not affect the ABAP round trip. */
type FpmDetail = "compact" | "full";

/**
 * Render-side character window over outline's XML body. Same invariant as
 * {@link FpmDetail}: never passed to {@link buildQuery}/{@link fpmBridgeClassName}
 * — mode "outline" only, applied AFTER the bridge returns the full XML.
 */
interface FpmXmlWindow {
  readonly offset?: number;
  readonly limit?: number;
}

export interface FpmToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars">;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/** Disclosed on every response: coverage limits — the persisted config can differ from runtime. */
const FIDELITY_NOTES: readonly string[] = [
  "Reads the base persisted configuration only (WDY_CONFIG_DATA/WDY_CONFIG_APPL via " +
    "CL_WDR_CFG_PERSISTENCE_UTILS or raw SQL) — cannot see AppCC (application-configuration-" +
    "controller) runtime overrides layered on top at execution time.",
  "Cannot see customizing/personalization overlays, CBA (Component-Based Architecture) " +
    "adaptations, or POWL layout personalization — any of these can change what a user actually " +
    "sees beyond what is reported here.",
  "XML decoding has only been verified in depth against FORM/LIST UIBBs and one FBI view shape; " +
    "other UIBB kinds may contain structure this tool does not specially recognise.",
];

/** outline's own XML crosses ~3,000 tokens (CHARS_PER_TOKEN, src/compact.ts) — the point a caller benefits from being told xml_offset/xml_limit exist, without a note firing on every small config. */
const XML_DISCOVERY_THRESHOLD_CHARS = Math.round(3000 * CHARS_PER_TOKEN);

/** Used instead of {@link FIDELITY_NOTES} when detail is "compact" — same blind spots, condensed. */
const COMPACT_COVERAGE_NOTE =
  "Coverage limits: base persisted configuration only — no AppCC runtime overrides, no " +
  "customizing/personalization/CBA/POWL overlays; XML decoding verified in depth only for " +
  'FORM/LIST UIBBs and one FBI view shape. detail:"full" prints these in full.';

function buildQuery(input: FpmReadInput): FpmBridgeQuery {
  if (input.mode === "find") {
    const q: FpmFindQuery = {
      mode: "find",
      configType: input.config_type ?? "00",
      component: input.component,
      queryPattern: input.query,
      package: input.package,
    };
    return q;
  }
  if (input.mode === "outline") {
    if (!input.config_id || !input.config_id.trim()) {
      throw new AbapError("BAD_INPUT", 'mode "outline" requires config_id.', { mode: input.mode });
    }
    const q: FpmOutlineQuery = {
      mode: "outline",
      configId: input.config_id,
      configType: input.config_type ?? "00",
      configVar: input.config_var ?? "",
    };
    return q;
  }
  // mode "app"
  if (!input.config_id || !input.config_id.trim()) {
    throw new AbapError("BAD_INPUT", 'mode "app" requires config_id.', { mode: input.mode });
  }
  const q: FpmAppQuery = { mode: "app", configId: input.config_id, resolve: input.resolve ?? true };
  return q;
}

/**
 * `mode: "locks"` uses a separate bridge module (`fpm-lock.ts`) with its own
 * query type, and STRICT {@link assertLockConfigType} — a defaulted/trimmed
 * `config_type` is a wildcard-lock landmine on a lock key, so a bad NUMC2 is
 * refused here rather than silently becoming `"00"`. Omitting it is legitimate
 * (inspect both lock objects), not an error.
 */
function buildLocksQuery(input: FpmReadInput): FpmLockInspectQuery {
  if (!input.config_id || !input.config_id.trim()) {
    throw new AbapError("BAD_INPUT", 'mode "locks" requires config_id.', { mode: input.mode });
  }
  return {
    mode: "locks",
    configId: input.config_id,
    ...(input.config_type === undefined ? {} : { configType: assertLockConfigType(input.config_type) }),
    ...(input.config_var === undefined ? {} : { configVar: input.config_var }),
  };
}

function buildFindResponse(
  result: FpmReadResult,
  detail: FpmDetail,
  xmlWindowPassed: boolean,
  maxChars: number,
): string {
  const t = result.transcript;
  const hasDevclass = t.configs.some((c) => c.devclass !== undefined);
  const rows = t.configs.map((c) => ({
    config_id: c.configId,
    config_type: c.configType,
    config_var: c.configVar,
    component: c.component,
    description: c.description,
    ...(hasDevclass ? { devclass: c.devclass ?? "" } : {}),
  }));
  let columns = ["config_id", "config_type", "config_var", "component", "description"];
  if (hasDevclass) columns.push("devclass");

  // Columns constant across every row are hoisted into the header instead of repeated per row.
  let hoisted: Record<string, string> | undefined;
  if (detail === "compact") {
    hoisted = {};
    if (rows.length >= 2) {
      for (const col of ["config_type", "config_var", "component", "devclass"]) {
        if (!columns.includes(col)) continue;
        const values = rows.map((r) => (r as Record<string, string>)[col]);
        const first = values[0];
        if (first !== undefined && values.every((v) => v === first)) hoisted[col] = first;
      }
    }
    columns = columns.filter((c) => hoisted![c] === undefined);
  }

  const notes = detail === "compact" ? [COMPACT_COVERAGE_NOTE] : [...FIDELITY_NOTES];
  if (t.count !== undefined && t.count >= 200) {
    notes.push(
      `The server-side SELECT is capped at 200 rows; it matched ${t.count} row(s) on config_type/` +
        "component/query BEFORE any package filter was applied here — there may be more configs " +
        "than are shown. Narrow component/query to be sure nothing is missing.",
    );
  }
  if (t.diagnostics.length) {
    notes.push(`The ABAP bridge reported ${t.diagnostics.length} diagnostic line(s) — see DIAGNOSTICS.`);
  }
  if (xmlWindowPassed) {
    notes.push('mode "find" ignores xml_offset/xml_limit — they apply to mode "outline" only.');
  }

  return buildResponse({
    header: {
      mode: "find",
      detail,
      matches: rows.length,
      serverRowCount: t.count,
      allRows:
        hoisted && Object.keys(hoisted).length
          ? Object.entries(hoisted)
              .map(([k, v]) => `${k}=${v === "" ? "(blank)" : v}`)
              .join(", ")
          : undefined,
      bridgeClass: result.bridgeClass,
      bridgeRefreshed: result.bridgeRefreshed,
    },
    sections: t.diagnostics.length ? [{ title: "DIAGNOSTICS", content: t.diagnostics.join("\n") }] : undefined,
    body: rows.length ? textTable(rows, columns) : "(no matches)",
    bodyLabel: "CONFIGURATIONS",
    notes,
    maxChars,
  }).text;
}

function buildOutlineResponse(
  query: FpmOutlineQuery,
  result: FpmReadResult,
  detailPassed: boolean,
  xmlWindow: FpmXmlWindow,
  maxChars: number,
): string {
  const t = result.transcript;
  const notes: string[] = [];

  const idpar = t.outlineMeta?.configIdPar ?? "";
  const isRealDelta = idpar !== "" && !idpar.startsWith("N/A");
  if (isRealDelta) {
    notes.push(
      `DELTA CONFIGURATION: this configuration has a non-blank CONFIG_IDPAR ("${idpar}") — it is a ` +
        "delta/enhancement layered on a parent configuration. The XML below is this config's OWN " +
        "delta content, not the fully resolved parent+delta merge. Read the parent (same tool, that " +
        "config_id) to see what it inherits from.",
    );
  }
  notes.push(...FIDELITY_NOTES);
  if (query.configType === "02") {
    notes.push(
      "Application-scope configs (config_type \"02\") are read via a direct SELECT against " +
        "WDY_CONFIG_APPL rather than a confirmed SAP API — its exact field names (xcontent/content) " +
        "are inferred, not independently verified against a field dump. If this activation succeeded, " +
        "the fields exist as assumed; delta tracking (CONFIG_IDPAR) is not implemented for this branch.",
    );
  }
  const xml = t.outlineXml ?? "";
  const hasXml = xml.trim() !== "";
  if (!hasXml) {
    notes.push("No XML content was returned — the configuration may not exist, or its XCONTENT is empty.");
  }

  // Character window over the XML — opt-in, outline only. The XML
  // is essentially one long line, so buildResponse's line-wise paging can't
  // help here; the window is cut BEFORE the body reaches buildResponse, and
  // disclosed by hand. xmlChars below always stays the FULL length.
  const fullLen = xml.length;
  const windowRequested = xmlWindow.offset !== undefined || xmlWindow.limit !== undefined;
  let bodyXml = xml;
  let xmlWindowChars: number | undefined;
  let xmlWindowRange: string | undefined;
  let xmlNextOffset: number | undefined;

  if (hasXml && windowRequested) {
    const rawOffset = xmlWindow.offset ?? 0;
    const offset = Math.min(Math.max(0, rawOffset), fullLen);
    const end = xmlWindow.limit === undefined ? fullLen : Math.min(fullLen, offset + Math.max(0, xmlWindow.limit));
    bodyXml = xml.slice(offset, end);
    const remaining = fullLen - end;
    xmlWindowChars = bodyXml.length;
    xmlWindowRange = `${offset}-${end}`;
    if (remaining > 0) xmlNextOffset = end;

    if (rawOffset > fullLen) {
      notes.push(`xml_offset ${rawOffset} is beyond the XML length (${fullLen}) — nothing returned.`);
    } else if (bodyXml.length === 0) {
      notes.push(
        `XML WINDOW: 0 chars returned (xml_limit 0) at offset ${offset} of ${fullLen}. Retry with a ` +
          `positive xml_limit at xml_offset=${offset} to see content.`,
      );
    } else {
      notes.push(
        `XML WINDOW: chars ${offset}-${end - 1} of ${fullLen} returned (${bodyXml.length} char(s)). ` +
          (remaining > 0
            ? `${remaining} char(s) not shown — pass xml_offset=${end} to continue.`
            : "This is the last window."),
      );
    }
    notes.push('mode "outline" returned a WINDOW of the XML (xml_offset/xml_limit passed) — not verbatim in full.');
  } else if (!hasXml && windowRequested) {
    notes.push("xml_offset/xml_limit ignored — no XML content to window.");
  } else {
    notes.push('mode "outline" always returns the raw XML verbatim.');
    if (hasXml && xml.length > XML_DISCOVERY_THRESHOLD_CHARS) {
      notes.push(
        `XML is ${xml.length} chars (~${Math.round(xml.length / CHARS_PER_TOKEN)} tokens) — xml_limit/xml_offset can fetch less.`,
      );
    }
  }

  if (t.diagnostics.length) {
    notes.push(`The ABAP bridge reported ${t.diagnostics.length} diagnostic line(s) — see DIAGNOSTICS.`);
  }
  if (detailPassed) {
    notes.push('mode "outline" ignores detail — it always returns the verbatim XML.');
  }

  const body = hasXml ? bodyXml : "(no content)";
  const bodyLabel = "XML";

  return buildResponse({
    header: {
      mode: "outline",
      config_id: query.configId,
      config_type: query.configType,
      config_var: query.configVar || undefined,
      component: t.outlineMeta?.component || undefined,
      devclass: t.outlineMeta?.devclass || undefined,
      config_idpar: isRealDelta ? idpar : undefined,
      xmlChars: xml.length,
      xmlWindowChars,
      xmlWindowRange,
      xmlNextOffset,
      bridgeClass: result.bridgeClass,
      bridgeRefreshed: result.bridgeRefreshed,
    },
    sections: t.diagnostics.length ? [{ title: "DIAGNOSTICS", content: t.diagnostics.join("\n") }] : undefined,
    body,
    bodyLabel,
    notes,
    maxChars,
  }).text;
}

function buildAppResponse(
  query: FpmAppQuery,
  result: FpmReadResult,
  detail: FpmDetail,
  xmlWindowPassed: boolean,
  maxChars: number,
): string {
  const t = result.transcript;
  const notes = detail === "compact" ? [COMPACT_COVERAGE_NOTE] : [...FIDELITY_NOTES];
  if (query.resolve) {
    notes.push(
      detail === "compact"
        ? "feeder/bopf are best-effort substring presence flags over each resolved node's decoded " +
            'XML, never verified against a fixture containing a real FEEDER reference — a blank means ' +
            '"not detected", not "confirmed absent". Full text and the per-node XML excerpts: ' +
            'detail:"full".'
        : "FEEDER/BOPF-binding hints (feeder/bopf columns below) are best-effort substring checks over " +
            "each resolved node's decoded XML (searching for the literal text 'FEEDER', '/BOBF/', 'BOPF', " +
            "'BO_KEY') — they are presence flags, not parsed field values, and have never been verified " +
            "against a fixture that actually contains a FEEDER reference. Treat a blank as 'not detected', " +
            "not as 'confirmed absent'. Excerpt sections below (first ~300 characters of each resolved " +
            "node's XML) are provided as a fallback regardless of whether either hint matched.",
    );
  }
  if (t.diagnostics.length) {
    notes.push(`The ABAP bridge reported ${t.diagnostics.length} diagnostic line(s) — see DIAGNOSTICS.`);
  }
  const unresolvedCount = t.appNodes.filter((n) => n.componentName && n.isConfigurable && !n.resolved).length;
  if (query.resolve && unresolvedCount > 0) {
    notes.push(
      `${unresolvedCount} configurable node(s) with a component were NOT successfully resolved — see ` +
        "DIAGNOSTICS for the per-node failure reason (each failure is wrapped in its own TRY/CATCH so " +
        "one bad node cannot abort the whole walk).",
    );
  }
  if (xmlWindowPassed) {
    notes.push('mode "app" ignores xml_offset/xml_limit — they apply to mode "outline" only.');
  }

  const rows = t.appNodes.map((n) => ({
    node_path: n.nodePath,
    parent_path: n.parentPath,
    top: n.isTopNode ? "X" : "",
    node_name: n.nodeName,
    component: n.componentName,
    config_id: n.configId,
    configurable: n.isConfigurable ? "X" : "",
    leaf: n.isLeaf ? "X" : "",
    feeder: n.resolved?.feederHint ? "X" : "",
    bopf: n.resolved?.bopfHint ? "X" : "",
  }));

  const nodesWithExcerpt = t.appNodes.filter((n) => n.resolved?.excerpt && n.resolved.excerpt.trim() !== "");
  const excerptSections =
    detail === "full"
      ? nodesWithExcerpt.map((n) => ({ title: `EXCERPT ${n.nodePath || n.nodeName}`, content: n.resolved!.excerpt! }))
      : [];
  if (detail === "compact" && nodesWithExcerpt.length > 0) {
    notes.push(
      `${nodesWithExcerpt.length} per-node XML excerpt section(s) omitted (~300 characters each) — ` +
        'detail:"full" includes them.',
    );
  }

  // top/leaf dropped in compact: both are recoverable from the path/parent set, and nodeCount/serverNodeCount below says the table is complete.
  const columns =
    detail === "full"
      ? ["node_path", "parent_path", "top", "node_name", "component", "config_id", "configurable", "leaf", "feeder", "bopf"]
      : ["node_path", "parent_path", "node_name", "component", "config_id", "configurable", "feeder", "bopf"];

  return buildResponse({
    header: {
      mode: "app",
      detail,
      config_id: query.configId,
      resolve: query.resolve,
      nodeCount: t.appNodes.length,
      serverNodeCount: t.count,
      bridgeClass: result.bridgeClass,
      bridgeRefreshed: result.bridgeRefreshed,
    },
    sections: [
      ...(t.diagnostics.length ? [{ title: "DIAGNOSTICS", content: t.diagnostics.join("\n") }] : []),
      ...excerptSections,
    ],
    body: rows.length ? textTable(rows, columns) : "(no nodes)",
    bodyLabel: "NODES",
    notes,
    maxChars,
  }).text;
}

/** Rendering for a wildcard-filled GARG segment (raw fill is U+FFFF; would print as mojibake). */
const WILDCARD_CELL = "*";

/** `mode: "locks"` — deliberately omits {@link FIDELITY_NOTES} (content blind spots, irrelevant to locks) for lock-specific caveats below. */
function buildLocksResponse(
  query: FpmLockInspectQuery,
  result: FpmLockReadResult,
  detailPassed: boolean,
  xmlWindowPassed: boolean,
  maxChars: number,
): string {
  const t = result.transcript;

  // All phases, not just `inspect` — avoids silently dropping rows if a second phase is ever added.
  const lockRows = t.phases.flatMap((p) => p.rows);

  const seg = (
    row: (typeof lockRows)[number],
    name: "configId" | "configType" | "configVar",
  ): string => (row.garg_view.wildcardSegments.includes(name) ? WILDCARD_CELL : row.garg_view[name]);

  const rows = lockRows.map((r) => ({
    gname: r.gname,
    config_id: seg(r, "configId"),
    config_type: seg(r, "configType"),
    config_var: seg(r, "configVar"),
    precision: r.garg_view.isWildcard ? "WILDCARD" : "precise",
    owner: r.ownership,
    guname: r.guname,
    gmode: r.gmode,
  }));

  const wildcardRows = rows.filter((r) => r.precision === "WILDCARD").length;

  const notes: string[] = [
    'A row whose precision is WILDCARD is a DEFECT, not a broad filter: it is a GENERIC lock ' +
      "covering EVERY config_type of that config_id, taken by a wrapper that skipped a key field " +
      'because the legitimate NUMC2 value "00" satisfies IS INITIAL. It blocks ' +
      "configurations its holder never named, and a precise-shaped DEQUEUE cannot release it. Key " +
      `segments shown as "${WILDCARD_CELL}" are that wildcard fill (U+FFFF), not a real value.`,
    "Point-in-time snapshot, and NO lock is taken on this configuration by this mode — it is " +
      "read-only inspection. (The bridge's only enqueue is a throwaway self-probe on a key that is " +
      "not, and never will be, a configuration; it is released two statements later, and without " +
      "it the owner column could only ever say UNKNOWN.) A lock may be taken or dropped by another " +
      "session the instant after this read returns.",
    "MINE vs FOREIGN is discriminated on GUSR, never on GUNAME: two sessions of the SAME SAP user " +
      "have an identical GUNAME (and both have an empty GTCODE), so GUNAME cannot tell your own " +
      "lock from another session's. The guname column is shown for the reader; it is not what the " +
      "owner column is computed from.",
  ];
  if (wildcardRows > 0) {
    notes.push(
      `${wildcardRows} of the row(s) below carry wildcard fill. Treat that as a defect to be ` +
        "reported and cleared, not as ordinary contention — whatever took that lock is holding " +
        "configurations it never asked for.",
    );
  }
  if (t.selfOwnerId === undefined) {
    notes.push(
      "Self-identification did not yield a GUSR, so every row is reported UNKNOWN: a lock listed " +
        "here may well be one of your own sessions'.",
    );
  }
  if (t.selfOwnerId !== undefined && rows.some((r) => r.owner === "UNKNOWN")) {
    notes.push(
      "Self-identification succeeded, but at least one row below is still UNKNOWN: that row carries " +
        "no owner id in either GUSR (scope 1) or GUSRVB (scope 2), so its owner cannot be determined. " +
        "It is deliberately NOT reported as FOREIGN.",
    );
  }
  if (t.aborts.length) {
    notes.push(`The ABAP bridge emitted ${t.aborts.length} GUARD line(s): ${t.aborts.join("; ")}`);
  }
  if (!result.outputComplete) {
    notes.push(
      "The bridge's output was cut off before the transcript ended — rows may be MISSING below. A " +
        "short or empty table is not evidence that no lock is held.",
    );
  }
  if (t.droppedLines) {
    notes.push(
      `${t.droppedLines} transcript line(s) were not recognised by the parser — the bridge's ` +
        "output shape may have drifted from what this build expects.",
    );
  }
  if (t.diagnostics.length) {
    notes.push(`The ABAP bridge reported ${t.diagnostics.length} diagnostic line(s) — see DIAGNOSTICS.`);
  }
  if (detailPassed) {
    notes.push(
      'mode "locks" ignores detail — its output is already compact and every note above is a ' +
        "lock-defect or ownership disclosure.",
    );
  }
  if (xmlWindowPassed) {
    notes.push('mode "locks" ignores xml_offset/xml_limit — they apply to mode "outline" only.');
  }

  return buildResponse({
    header: {
      mode: "locks",
      config_id: query.configId,
      config_type: query.configType,
      config_var: query.configVar || undefined,
      lockObjects: query.configType === undefined ? "component+application" : undefined,
      locks: rows.length,
      wildcard: wildcardRows > 0 ? "DEFECT" : undefined,
      bridgeClass: result.bridgeClass,
      bridgeRefreshed: result.bridgeRefreshed,
    },
    sections: t.diagnostics.length ? [{ title: "DIAGNOSTICS", content: t.diagnostics.join("\n") }] : undefined,
    body: rows.length
      ? textTable(rows, [
          "gname",
          "config_id",
          "config_type",
          "config_var",
          "precision",
          "owner",
          "guname",
          "gmode",
        ])
      : "(no locks held)",
    bodyLabel: "LOCKS",
    notes,
    maxChars,
  }).text;
}

const FPM_TOOL_DESCRIPTION =
  "Read SAP FPM/FBI screen configurations — no ADT read endpoint exists. find: search by " +
  "component/config_id pattern/package. outline: one configuration's XML plus delta/package " +
  "metadata. app: an application configuration's full UIBB hierarchy with feeder/BOPF hints " +
  "(resolve, default true). locks: enqueue lock holders. Read-only; every call deploys a " +
  "throwaway $TMP bridge class.";

export async function runFpmReadTool(deps: FpmToolDeps, args: unknown): Promise<CallToolResult> {
  const input = args as FpmReadInput;
  const detail: FpmDetail = input.detail ?? "compact";
  // outline-only render-side window; presence (not value) is what the other modes need to know about.
  const xmlWindowPassed = input.xml_offset !== undefined || input.xml_limit !== undefined;

  // `locks` uses a separate query type/bridge (fpm-lock.ts) and must never reach runFpmRead.
  if (input.mode === "locks") {
    const lockQuery = buildLocksQuery(input);
    const lockBridgeClass = fpmLockBridgeClassName(lockQuery);
    deps.safety.assert("read");
    deps.safety.assert(
      "write",
      { name: lockBridgeClass, packageName: "$TMP", type: "CLAS/OC" },
      { phase: "preflight" },
    );

    await deps.ensureConnected();

    const lockResult = await deps.pool.withWrite("abap_fpm_read", lockBridgeClass, (conn) =>
      runFpmLockInspect(conn, lockQuery, deps.safety),
    );
    return ok(
      buildLocksResponse(lockQuery, lockResult, input.detail !== undefined, xmlWindowPassed, deps.cfg.maxResponseChars),
    );
  }

  const query = buildQuery(input);

  // Bridge class name is a pure function of the query (mirrors abap_bopf_test), so a refused/malformed request costs no network round trip.
  const bridgeClass = fpmBridgeClassName(query);
  deps.safety.assert("read");
  deps.safety.assert(
    "write",
    { name: bridgeClass, packageName: "$TMP", type: "CLAS/OC" },
    { phase: "preflight" },
  );

  await deps.ensureConnected();

  const result = await deps.pool.withWrite("abap_fpm_read", bridgeClass, (conn) =>
    runFpmRead(conn, query, deps.safety),
  );

  const text =
    query.mode === "find"
      ? buildFindResponse(result, detail, xmlWindowPassed, deps.cfg.maxResponseChars)
      : query.mode === "outline"
        ? buildOutlineResponse(
            query,
            result,
            input.detail !== undefined,
            { offset: input.xml_offset, limit: input.xml_limit },
            deps.cfg.maxResponseChars,
          )
        : buildAppResponse(query, result, detail, xmlWindowPassed, deps.cfg.maxResponseChars);

  return ok(text);
}

export function registerFpmTools(mcp: McpServer, deps: FpmToolDeps): void {
  mcp.registerTool(
    "abap_fpm_read",
    {
      title: "Read FPM/FBI configuration",
      description: FPM_TOOL_DESCRIPTION,
      inputSchema: fpmReadInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return await runFpmReadTool(deps, args);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
