/**
 * `abap_dumps` — the ST22 short-dump reader. One tool, two modes.
 *
 * Two-tier capability split:
 *   - Tier 1 (always registered): mode="list"/"show" limited to header,
 *     source extract, system fields, call stack. Genuine ungated read — no
 *     ADT verb it issues is in `MUTATING_OPS`.
 *   - Tier 2 (the "Selected Variables" chapter, kap10): live values of
 *     locals and internal tables at termination — real business data,
 *     permanently, in whatever transcript the answer lands in. Behind
 *     `ABAP_ALLOW_DUMP_VARIABLES`, default off.
 *
 * The tier-2 gate is enforced twice: at registration (the `variables` field
 * and all mention of it are absent from the zod shape when the capability is
 * off — see {@link dumpsInputShape}) and at call time
 * (`safety.assertDumpVariables()`, before any DUMP resource is fetched — see
 * {@link dumpsInputSchema} for why the registered schema must be loose for
 * this second gate to be reachable at all).
 *
 * `src/adt/dumps.ts` does not gate — it just flags `includesVariables` on its
 * result — so the decision lives in exactly one place: here.
 *
 * Full design rationale (stripping-wrapper incident, P-07/BADI R7
 * reference): the git history
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AbapError } from "../adt/errors.js";
import {
  emptyDumpsReason,
  fetchDumpDetail,
  fetchDumpFormatted,
  listDumps,
  selectDumpChapters,
  type DumpChapterSelection,
  type DumpsPage,
} from "../adt/dumps.js";
import {
  TIER1_CHAPTER_NAMES,
  VARIABLES_CHAPTER_NAME,
  type DumpDetail,
  type DumpFeedEntry,
} from "../adt/dumps-xml.js";
import { DUMPS_RESIDENCE_WINDOW_DAYS } from "../adt/dumps-query.js";
import { buildResponse, sliceLines, textTable, type BuiltResponse } from "../compact.js";
import { truncateForDisplay } from "../truncate.js";
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import type { SafetyGate } from "../safety.js";

/** Rows requested when the caller does not say. Each row is ~12 KB on the wire. */
const DEFAULT_MAX_ROWS = 20;

/**
 * Display width for the short text in a list row. The `key` is never
 * shortened here — a trimmed key 404s exactly like an expired one.
 */
const TITLE_DISPLAY_WIDTH = 58;

// ------------------------------------------------------------------ schema ---

/**
 * Tier-1 fields (8). `variables` (tier 2) is added only by
 * {@link dumpsInputShape} when enabled. Returns a fresh shape each call so
 * one registration's tier-2 field can't leak into another's.
 */
function tier1Shape() {
  return {
    mode: z
      .enum(["list", "show"])
      .optional()
      .describe('"list" (default) filters the dump feed; "show" returns one dump by key.'),
    key: z
      .string()
      .optional()
      .describe(
        "show, required: key exactly as a list row printed it. Do not trim, re-encode or " +
          "rebuild it — internal spaces are significant.",
      ),
    query: z
      .string()
      .optional()
      .describe(
        "list: server-side FQL filter, e.g. and ( equals ( user , DEVELOPER ) , equals ( " +
          "runtimeError , MESSAGE_TYPE_X ) ). Operator FIRST, then attribute, then the value, " +
          "UNQUOTED. One and(...)/or(...) wrapper is mandatory even for a single predicate; max " +
          "2 levels deep. Validated locally before sending.",
      ),
    from: z
      .string()
      .optional()
      .describe("list: oldest dump to include, YYYYMMDDHHMMSS in the server's local time."),
    to: z
      .string()
      .optional()
      .describe(
        "list: newest dump to include, YYYYMMDDHHMMSS. No page cursor exists; to page " +
          "backwards, set to= the oldest timestamp already seen.",
      ),
    max: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(`list: rows to request (default ${DEFAULT_MAX_ROWS}).`),
    chapters: z
      .string()
      .optional()
      .describe(
        'show: comma-separated chapter NAMES, e.g. "kap7,kap8,kap11" — names, never the ' +
          "titles, which are translated. Default: where terminated, source extract, system " +
          "fields, call stack. Every chapter this dump has is listed in the response.",
      ),
    offset: z
      .number()
      .int()
      .min(1)
      .max(999_999)
      .optional()
      .describe("show: 1-based first line of the returned chapter text."),
  };
}

/** The tier-2 field. Present in `tools/list` only where the operator allowed it. */
function tier2Shape() {
  return {
    variables: z
      .boolean()
      .optional()
      .describe(
        "show: also return Selected Variables — the live values of locals and internal " +
          "tables at termination. Real business data, permanently, in this transcript. " +
          "Page it with offset.",
      ),
  };
}

/**
 * Raw zod shape for `abap_dumps`, built for one capability surface. When
 * `variables` is off, the field and every mention of it are absent — that
 * absence is the whole tier-2 gate at the advertising layer; the handler
 * enforces it again on the value.
 */
export function dumpsInputShape(options: { variables?: boolean } = {}) {
  return options.variables === true
    ? { ...tier1Shape(), ...tier2Shape() }
    : { ...tier1Shape() };
}

/**
 * The schema actually REGISTERED: {@link dumpsInputShape} as a **loose**
 * object (hands unknown keys to the handler instead of stripping them).
 *
 * Not a style choice — a raw shape is wrapped in the SDK's default
 * *stripping* `z.object`, under which a hand-crafted `{"variables":true}`
 * sent with the capability off was silently deleted before the handler ran,
 * producing `isError:false` output identical to a request never made. Full
 * incident writeup: the git history.
 *
 * `additionalProperties: {}` is the only change to the advertised schema
 * (verified live; pinned in test/tools-dumps.test.ts and test/tools.test.ts).
 * Unknown keys reaching the handler are still refused: `variables` by
 * `safety.assertDumpVariables()`, a cross-mode key by
 * {@link rejectCrossModeArgs}, anything else by {@link rejectUnknownArgs}.
 */
export function dumpsInputSchema(options: { variables?: boolean } = {}) {
  return z.looseObject(dumpsInputShape(options));
}

/** The widest shape — for type inference only. Never registered directly. */
export const DumpsInput = z.object({ ...tier1Shape(), ...tier2Shape() });
export type DumpsInput = z.infer<typeof DumpsInput>;

export interface DumpsToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars">;
  /**
   * `resolveStaticCapabilities(cfg).canReadDumpVariables` — decides whether
   * `variables` is ADVERTISED, not whether it is allowed;
   * `safety.assertDumpVariables()` decides that, on every call.
   */
  readonly registerVariables?: boolean;
  /** Audit sink. Defaults to stderr, matching the other tool modules. */
  readonly log?: (message: string) => void;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

// ------------------------------------------------------------------ inputs ---

/** Fields that belong to exactly one mode, applied to this tool's own surface. */
const LIST_ONLY = ["query", "from", "to", "max"] as const;
const SHOW_ONLY = ["key", "chapters", "offset", "variables"] as const;

/**
 * Every key this tool has, at either capability surface — `variables`
 * included unconditionally, so an unadvertised tier-2 request reaches the
 * tier-2 gate (`DUMP_VARIABLES_DISABLED`) instead of being dismissed as a
 * typo. Derived from the widest shape, not hand-listed.
 */
const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(DumpsInput.shape));

/**
 * Refuse a key this tool does not have. The registered schema is loose, so
 * this is the only thing standing between an unrecognised parameter and a
 * response that looks like it honoured it — the same defect as the ADT
 * feed's HTTP 200 to an unrecognised query parameter.
 */
function rejectUnknownArgs(a: Record<string, unknown>): void {
  const unknown = Object.keys(a).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length === 0) return;
  throw new AbapError(
    "BAD_INPUT",
    `abap_dumps has no parameter ${unknown.join(", ")}.`,
    { ignored: unknown },
    "Nothing was applied and nothing was fetched. Read the parameter list in this tool's schema " +
      "and call again — a parameter this tool does not have is never silently dropped here, " +
      "because a filtered-looking answer to an unfiltered request is worse than an error.",
  );
}

/**
 * Refuse a parameter that belongs to the other mode instead of ignoring it —
 * the endpoint's worst failure mode is HTTP 200 and the full unfiltered feed
 * to a parameter it did not recognise.
 */
function rejectCrossModeArgs(a: Record<string, unknown>, mode: "list" | "show"): void {
  const wrong = (mode === "list" ? SHOW_ONLY : LIST_ONLY).filter((k) => a[k] !== undefined);
  if (wrong.length === 0) return;
  throw new AbapError(
    "BAD_INPUT",
    `mode="${mode}" does not take ${wrong.join(", ")}.`,
    { mode, ignored: wrong },
    mode === "list"
      ? "Those parameters belong to mode=\"show\". They were NOT applied — drop them, or call " +
          'again with mode:"show" and a key from a list row.'
      : "Those parameters belong to mode=\"list\". They were NOT applied — a dump is fetched by " +
          "key, not filtered.",
  );
}

/** Split the `chapters` string. Empty entries are dropped, order is preserved. */
function parseChapterNames(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
}

/** True when this request asks, by either route, for the variable chapter. */
function wantsVariables(names: readonly string[], variables: boolean | undefined): boolean {
  return (
    variables === true || names.some((n) => n.toLowerCase() === VARIABLES_CHAPTER_NAME)
  );
}

/**
 * Map requested names onto the names this dump actually publishes,
 * case-insensitively. Never matches on `title` (translated) — a name that
 * resolves to nothing passes through unchanged so it is reported as missing.
 */
function resolveChapterNames(requested: readonly string[], detail: DumpDetail): string[] {
  const byLower = new Map(detail.chapters.map((c) => [c.name.toLowerCase(), c.name]));
  return requested.map((n) => byLower.get(n.toLowerCase()) ?? n);
}

// --------------------------------------------------------------- rendering ---

/** `20260811123447` / an ISO instant → a readable, still-unambiguous stamp. */
function shortInstant(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  return m ? `${m[1]}${m[2]}${m[3]} ${m[4]}:${m[5]}:${m[6]}` : value;
}

const LIST_COLUMNS = ["when", "user", "error", "program", "short_text", "key"];

/**
 * Render `mode:"list"`. Declares no `pagingParam`: `$skip` does not exist on
 * this feed and `offset` belongs to show mode. The real cursor is `to=`,
 * stated in `notes` (always shown) rather than `hints` (shown only when cut).
 */
export function renderDumpsList(page: DumpsPage, requestedMax: number, maxChars: number): BuiltResponse {
  const rows = page.entries.map((e: DumpFeedEntry) => ({
    when: shortInstant(e.published),
    user: e.user,
    error: e.runtimeError,
    program: e.terminatedProgram,
    short_text: truncateForDisplay(e.title, TITLE_DISPLAY_WIDTH),
    // Never truncated/re-encoded: this is the only field mode="show" consumes; a shortened key 404s.
    key: e.key,
  }));

  const notes: string[] = [...page.notes];

  if (page.entries.length === 0) {
    // `emptyDumpsReason` is the only approved wording — a bare "no dumps" would misstate the system.
    notes.push(page.emptyReason ?? emptyDumpsReason(page.residenceWindowStart, false));
  } else {
    if (page.entries.length >= requestedMax) {
      notes.push(
        `EXACTLY max=${requestedMax} row(s) came back and this feed reports no total ` +
          "($inlinecount is inert on it), so there are almost certainly more. Do not read this " +
          "as the complete set.",
      );
    }
    if (page.hasMore) {
      notes.push(
        "The server marked this page as having a successor. This tool returns one page per call.",
      );
    }
    const oldest = page.entries[page.entries.length - 1];
    notes.push(
      "No page cursor exists on this feed. To see older dumps, call again with " +
        `to=${oldest === undefined ? "<timestamp of the oldest row above>" : shortInstant(oldest.published).replace(/[- :]/g, "")}` +
        ` — and note the whole feed stops at ${page.residenceWindowStart} (${DUMPS_RESIDENCE_WINDOW_DAYS}-day ` +
        "residence window), which no bound can widen.",
    );
  }

  return buildResponse({
    header: {
      mode: "list",
      system: page.systemId,
      rows: page.entries.length,
      window_start: page.residenceWindowStart,
      contract: page.contractSource,
    },
    body: rows.length ? textTable(rows, LIST_COLUMNS) : "(no dumps)",
    bodyLabel: "DUMPS",
    notes,
    maxChars,
  });
}

/** The chapter index of one dump: what `chapters` may name, and where each starts. */
function chapterIndex(detail: DumpDetail, hide: readonly string[]): string {
  const hidden = new Set(hide);
  const rows = detail.chapters
    .filter((c) => !hidden.has(c.name))
    .map((c) => ({
      name: c.name,
      line: String(c.line),
      title: truncateForDisplay(c.title, TITLE_DISPLAY_WIDTH),
      category: truncateForDisplay(c.category, 30),
    }));
  return rows.length ? textTable(rows, ["name", "line", "title", "category"]) : "";
}

export interface DumpShowRender {
  selection: DumpChapterSelection;
  /** Bytes of `/formatted` actually fetched, for the bandwidth note. */
  formattedChars: number;
  offset: number;
  maxChars: number;
  /** False when this deployment has not enabled the variable chapter. */
  variablesAllowed: boolean;
}

/**
 * Render `mode:"show"`. The paging frame is the assembled slice, not
 * `/formatted`'s absolute line numbering — absolute numbering breaks the
 * moment `chapters` selects two non-adjacent chapters.
 */
export function renderDumpShow(input: DumpShowRender): BuiltResponse {
  const { selection, formattedChars, offset, maxChars, variablesAllowed } = input;
  const detail = selection.detail;
  const hasVariablesChapter = detail.chapters.some((c) => c.name === VARIABLES_CHAPTER_NAME);
  const hidden = variablesAllowed ? [] : [VARIABLES_CHAPTER_NAME];

  const notes: string[] = [];

  // Cheapest capability here: turns "a dump happened" into "here is the source" for zero schema bytes.
  if (detail.termination) {
    const at = detail.termination.line === undefined ? "" : `#start=${detail.termination.line}`;
    notes.push(
      `Terminated in ${detail.terminatedProgram || "(unknown program)"}` +
        (detail.termination.line === undefined ? "" : ` line ${detail.termination.line}`) +
        ` — read it with abap_read object:"${detail.termination.path}${at}".`,
    );
  }

  if (selection.missing.length > 0) {
    notes.push(
      `Requested chapter(s) not present in this dump: ${selection.missing.join(", ")}. Chapter ` +
        "sets vary by release, and the names are matched on `name`, never on the translated " +
        "`title`. The CHAPTERS index above lists what this dump actually has.",
    );
  }

  if (!variablesAllowed && hasVariablesChapter) {
    // Named, not "not found" — that would wrongly imply the dump has no variable data.
    notes.push(
      `Chapter ${VARIABLES_CHAPTER_NAME} (Selected Variables) exists in this dump and is NOT ` +
        "available on this server. It carries live field values and the operator has not enabled " +
        "it. This is a policy decision made outside this session; it is not a fault and not " +
        "something to work around.",
    );
  }

  notes.push(
    `Fetched ${Math.round(formattedChars / 1024)} KB of /formatted to return ` +
      `${selection.present.length} chapter(s) of ${selection.totalLines} line(s). Chapter ` +
      "slicing saves context, not bandwidth: every show call fetches the whole body, so ask for " +
      "the chapters you need in ONE call rather than one chapter at a time.",
  );

  const window = sliceLines(selection.text, offset);
  const index = chapterIndex(detail, hidden);

  return buildResponse({
    header: {
      mode: "show",
      error: detail.error,
      exception: detail.exception,
      program: detail.terminatedProgram,
      user: detail.author,
      when: detail.datetime,
      instance: detail.serverInstance,
      chapters_shown: selection.present.join(",") || "(none)",
    },
    sections: [
      ...(detail.title ? [{ title: "SHORT TEXT", content: detail.title }] : []),
      ...(index ? [{ title: "CHAPTERS (select by name, never by title)", content: index }] : []),
    ],
    body: selection.text ? window.text : "(no chapter text)",
    bodyLabel: "CHAPTER TEXT",
    bodyOffset: selection.text ? window.offset : undefined,
    bodyTotalLines: selection.text ? window.total : undefined,
    hints: [
      "Line numbers above are relative to the assembled chapter slice, NOT to the dump's " +
        "/formatted body. Re-request the same chapters when paging.",
    ],
    notes,
    pagingParam: "offset",
    maxChars,
  });
}

// -------------------------------------------------------------- registration ---

/**
 * Registers `abap_dumps`. Unlike `registerDataPreviewTools`, this registrar
 * is ALWAYS called — tier 1 is an ordinary read. `deps.registerVariables`
 * chooses the schema, not the permission.
 */
export function registerDumpTools(mcp: McpServer, deps: DumpsToolDeps): void {
  const audit = deps.log ?? ((m: string) => void process.stderr.write(m + "\n"));
  const variablesAllowed = deps.registerVariables === true;

  mcp.registerTool(
    "abap_dumps",
    {
      title: "Read ABAP runtime errors (ST22 short dumps)",
      description:
        "Read ABAP runtime errors (ST22 short dumps) from the system's dump repository — not " +
        "the exception text of a run this server just triggered. mode=list filters the dump " +
        "feed; mode=show returns one dump, chapter by chapter. The feed reaches back " +
        `${DUMPS_RESIDENCE_WINDOW_DAYS} DAYS ONLY: an empty list means "no dumps in the last ` +
        `${DUMPS_RESIDENCE_WINDOW_DAYS} days matching this filter", never "nothing failed". ` +
        "Copy key from a list row VERBATIM. show returns the header, source extract, system " +
        "fields and call stack, and nothing else unless the operator enabled more.",
      inputSchema: dumpsInputSchema({ variables: variablesAllowed }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    // `args` is annotated, not inferred: the schema is chosen at runtime, so its
    // type is the union of both variants; `Partial<DumpsInput>` is the widest
    // and valid for either. `variables` CAN arrive here even on a registration
    // that did not advertise it — the loose schema hands it through instead of
    // stripping it, and `assertDumpVariables()` below refuses it.
    async (args: Partial<DumpsInput>) => {
      try {
        const a = (args ?? {}) as Partial<DumpsInput> & Record<string, unknown>;
        const mode = a.mode ?? "list";

        // 1. Connect first, same order as every other tool. Guarantees no DUMP
        //    resource is ever requested on a refused call (verified via a
        //    request-logging stub — see archive); does NOT guarantee nothing
        //    was sent, since connect itself makes several network calls.
        await deps.ensureConnected();

        // No argument is ever ignored — not the other mode's, not an unknown one.
        rejectUnknownArgs(a);
        rejectCrossModeArgs(a, mode);

        if (mode === "list") {
          const max = a.max ?? DEFAULT_MAX_ROWS;
          const page = await deps.pool.withRead("abap_dumps", (conn) =>
            listDumps(conn, {
              ...(a.query === undefined ? {} : { $query: a.query }),
              ...(a.from === undefined ? {} : { from: a.from }),
              ...(a.to === undefined ? {} : { to: a.to }),
              $top: max,
            }),
          );
          audit(
            `[abapsmith] audit: abap_dumps mode=list rows=${page.entries.length} max=${max} ` +
              `filtered=${String(a.query !== undefined || a.from !== undefined || a.to !== undefined)}`,
          );
          return ok(renderDumpsList(page, max, deps.cfg.maxResponseChars).text);
        }

        // ---- mode = "show" -------------------------------------------------
        if (a.key === undefined || a.key === "") {
          throw new AbapError(
            "BAD_INPUT",
            'mode="show" needs a key.',
            { mode },
            'Call mode:"list" first and copy the key column of a row VERBATIM — do not trim, ' +
              "re-encode or rebuild it from the timestamp and user, each of which 404s.",
          );
        }

        const requested = parseChapterNames(a.chapters);
        const askedForVariables = wantsVariables(requested, a.variables as boolean | undefined);

        // 2. THE GATE, before any dump resource is fetched. Defence in depth:
        //    the schema already omits `variables` when off, but a schema only
        //    binds a client that read it. Both routes to kap10 —
        //    `variables:true` and `chapters:"kap10"` — converge here on the
        //    identical `DUMP_VARIABLES_DISABLED` (src/safety.ts), which
        //    carries no dump data.
        if (askedForVariables) deps.safety.assertDumpVariables();

        const base = requested.length > 0 ? requested : [...TIER1_CHAPTER_NAMES];
        const wanted = askedForVariables ? [...base, VARIABLES_CHAPTER_NAME] : base;

        // 3. Detail and body come from the SAME dump, fetched inside one
        //    `withRead` so the pair can't straddle a session swap; offsets
        //    apply to the body they came with.
        const fetched = await deps.pool.withRead("abap_dumps", async (conn) => {
          const detail = await fetchDumpDetail(conn, a.key as string);
          const formatted = await fetchDumpFormatted(conn, detail);
          return { detail, formatted };
        });

        const names = dedupe(resolveChapterNames(wanted, fetched.detail));
        const selection = selectDumpChapters(fetched.detail, fetched.formatted, names);

        // 4. Belt and braces: `includesVariables` reflects chapters actually
        //    SLICED, catching a name that resolved onto the variable chapter
        //    another way.
        if (selection.includesVariables) deps.safety.assertDumpVariables();

        // Variable VALUES are never logged; only the key is (the operator's only handle on what was read).
        audit(
          `[abapsmith] audit: abap_dumps mode=show error=${fetched.detail.error} ` +
            `program=${fetched.detail.terminatedProgram} chapters=${selection.present.join("+") || "none"} ` +
            `variables=${String(selection.includesVariables)}`,
        );

        return ok(
          renderDumpShow({
            selection,
            formattedChars: fetched.formatted.length,
            offset: a.offset ?? 1,
            maxChars: deps.cfg.maxResponseChars,
            variablesAllowed,
          }).text,
        );
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}

/** Preserve order, drop repeats — a chapter asked for twice is sliced once. */
function dedupe(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}
