/**
 * The default `abap_dumps mode=show` view (issue #149): a summary distilled
 * from the detail document and the `/formatted` body, and the `section`
 * presets that replace it with full chapter text.
 *
 * Everything here is pure text work over `DumpDetail` + `/formatted`; the
 * fetching, the kap10 gate and the response budget stay in `tools/dumps.ts`.
 * The parsers are tolerant by design: a chapter that is absent, or laid out
 * differently on another release, yields an empty field, never a throw — the
 * caller then points at `section=` for the raw chapter text.
 *
 * `/formatted` layout (A4H 7.5x, fixture test/fixtures/dumps/dump-formatted.txt):
 * each chapter is a `-----` banner, a `|Title   |` row, an optional column
 * header, and `|    text   |` rows — prose chapters indent the text by four
 * spaces and wrapped continuations by five; the source extract marks the
 * failing line `|>>>>>|`; the call stack lists frames as pairs of rows.
 */
import {
  dumpChapterExtents,
  TIER1_CHAPTER_NAMES,
  VARIABLES_CHAPTER_NAME,
  type DumpChapter,
  type DumpDetail,
} from "./dumps-xml.js";

// ---------------------------------------------------------------- sections ---

/** `section` values `abap_dumps mode=show` accepts. */
export const DUMP_SECTIONS = ["analysis", "source", "variables", "stack", "environment", "all"] as const;
export type DumpSection = (typeof DUMP_SECTIONS)[number];

/**
 * Chapter names each section stands for. Names, never titles — titles are
 * translated. A dump lacking one of these just reports it as missing.
 * `all` is not here: it means the tier-1 default set (or `chapters`), i.e.
 * today's full output.
 */
export const SECTION_CHAPTERS: Readonly<Record<Exclude<DumpSection, "all">, readonly string[]>> = {
  /** Short text, error analysis, how to correct, chain of exception objects. */
  analysis: ["kap0", "kap3", "kap4", "kap28"],
  /** Where terminated, source code extract. */
  source: ["kap7", "kap8"],
  /** Selected Variables — gated by ABAP_ALLOW_DUMP_VARIABLES like `chapters:"kap10"`. */
  variables: [VARIABLES_CHAPTER_NAME],
  /** Active calls/events, application calls. */
  stack: ["kap11", "kap22"],
  /** System environment, user and transaction, server-side connection, system fields, programs affected. */
  environment: ["kap5", "kap6", "kap6a", "kap9", "kap14"],
};

export function isDumpSection(value: unknown): value is DumpSection {
  return typeof value === "string" && (DUMP_SECTIONS as readonly string[]).includes(value);
}

/** The chapter names a section selects; `all` is the tier-1 default. */
export function sectionChapterNames(section: DumpSection): string[] {
  return section === "all" ? [...TIER1_CHAPTER_NAMES] : [...SECTION_CHAPTERS[section]];
}

// ----------------------------------------------------------------- summary ---

/** The chapters the summary reads. kap10 is never among them. */
export const SUMMARY_CHAPTER_NAMES: readonly string[] = ["kap3", "kap4", "kap7", "kap8", "kap11"];

/**
 * Characters of cleaned prose kept per chapter before the summary says
 * "more" — the budget is {@link DUMP_SUMMARY_MAX_CHARS}-shaped, so the caps
 * are in characters, not lines. The error analysis carries the actual reason
 * (e.g. the failing SQL parser message), the correction text mostly SAP
 * boilerplate; hence the split.
 */
export const SUMMARY_PROSE_CHARS = { errorAnalysis: 450, howToCorrect: 260 } as const;

/** Call-stack frames the summary shows. */
export const SUMMARY_STACK_FRAMES = 5;

export interface DumpSourceLine {
  /** Include (or program) named as the termination point, e.g. `ZCL_FOO=======================CM001`. */
  include?: string;
  /** 1-based line within that include. */
  line?: number;
  /** The `>>>>>` row of the source extract, trimmed. */
  statement?: string;
  /** e.g. `IF_OO_ADT_CLASSRUN~MAIN`. */
  procedure?: string;
  /** e.g. `METHOD`, `FORM`, `FUNCTION`. */
  procedureKind?: string;
}

export interface DumpStackFrame {
  /** The frame number as printed: the innermost frame carries the highest. */
  no: number;
  /** `METHOD`, `FUNCTION`, `FORM`, `EVENT`, `MODULE (PBO)`, … */
  kind: string;
  program: string;
  include: string;
  line: number;
  /** The second row of the pair: `ZCL_FOO=>IF_OO_ADT_CLASSRUN~MAIN`, `HTTP_DISPATCH_REQUEST`, … */
  name: string;
}

export interface DumpProse {
  /** Cleaned lines, within the chapter's {@link SUMMARY_PROSE_CHARS} cap. */
  lines: string[];
  /** Lines beyond the cap. */
  omitted: number;
  /** True when the tail was cut at SAP's support boilerplate rather than the cap. */
  boilerplateCut: boolean;
}

export interface DumpSummary {
  shortText: string;
  /** kap3. Empty when the chapter is absent. */
  errorAnalysis: DumpProse;
  /** kap4, cut before the SAP Notes / "send to SAP" boilerplate. */
  howToCorrect: DumpProse;
  source: DumpSourceLine;
  /** All frames parsed from kap11, innermost first. */
  stack: DumpStackFrame[];
  /** Every chapter this dump has, in chapter order. */
  chapters: DumpChapter[];
  /** Summary chapters this dump lacks (release differences), by name. */
  missing: string[];
}

// ------------------------------------------------------------ chapter text ---

const BANNER = /^-{3,}\s*$/;
const ROW = /^\|(.*)\|\s*$/;

/** Raw lines of one chapter (banner included), or `undefined` when the dump lacks it. */
export function chapterLines(detail: DumpDetail, formatted: string, name: string): string[] | undefined {
  const lines = formatted.split("\n");
  const extent = dumpChapterExtents(detail.chapters, lines.length).find((e) => e.chapter.name === name);
  if (extent === undefined) return undefined;
  return lines.slice(extent.start, extent.end);
}

/** The text inside a `|…|` row, right-trimmed; `undefined` for banners and non-rows. */
function rowText(line: string): string | undefined {
  if (BANNER.test(line)) return undefined;
  const m = ROW.exec(line);
  return m?.[1]?.replace(/\s+$/, "");
}

/**
 * A prose chapter as readable lines: title row dropped, the four-space
 * indent removed, five-space continuations re-joined onto their sentence,
 * blank runs collapsed.
 */
export function cleanProse(lines: readonly string[], title: string): string[] {
  const out: string[] = [];
  let titleSeen = false;
  for (const line of lines) {
    const text = rowText(line);
    if (text === undefined) continue;
    const trimmed = text.trim();
    if (!titleSeen) {
      titleSeen = true;
      if (trimmed === title.trim()) continue;
    }
    if (trimmed === "") {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    const continuation = /^\s{5,}\S/.test(text) && out.length > 0 && out[out.length - 1] !== "";
    if (continuation) {
      out[out.length - 1] = `${out[out.length - 1]} ${trimmed}`;
    } else {
      out.push(trimmed);
    }
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/** Where kap4 stops being about this dump and starts being about SAP support. */
const CORRECTION_BOILERPLATE =
  /^(If the error occurs in a non-mod|If you cannot solve the problem yourself|If the error occurr?ed in one of your own)/i;

/**
 * kap3 sentences every uncaught-exception dump repeats verbatim; they say
 * nothing about THIS dump beyond what the header and source line already
 * carry (exception class, procedure), and the summary points at
 * `section:"analysis"` for the chapter as printed. Matched per cleaned line.
 */
const ANALYSIS_NOISE =
  /^(An exception has occurred in class "[^"]*"\. This exception was not caught|in procedure "[^"]*" "\(\w+\)" or propagated by a RAISING clause\.|Since the caller of the procedure could not have anticipated.*|exception, the current program was terminated\.|The reason for the exception (occurring was|is):)$/;

interface ProseOptions {
  maxChars: number;
  /** Cut the text (and everything after) at the first line matching this. */
  cutAt?: RegExp;
  /** Drop individual lines matching this. */
  drop?: RegExp;
}

function prose(lines: readonly string[] | undefined, title: string, options: ProseOptions): DumpProse {
  if (lines === undefined) return { lines: [], omitted: 0, boilerplateCut: false };
  let cleaned = cleanProse(lines, title);
  let boilerplateCut = false;
  if (options.cutAt !== undefined) {
    const at = cleaned.findIndex((l) => options.cutAt?.test(l));
    if (at >= 0) {
      cleaned = cleaned.slice(0, at);
      boilerplateCut = true;
    }
  }
  if (options.drop !== undefined) cleaned = cleaned.filter((l) => !options.drop?.test(l));
  cleaned = collapseBlanks(cleaned);
  const kept: string[] = [];
  let used = 0;
  for (const line of cleaned) {
    if (kept.length > 0 && used + line.length + 1 > options.maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return { lines: kept, omitted: cleaned.length - kept.length, boilerplateCut };
}

function collapseBlanks(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

// ------------------------------------------------------------- source line ---

const TERMINATION_POINT = /termination point is in line (\d+) of (?:include|program)\s+"([^"]+)"/i;
const IN_PROCEDURE = /in procedure "([^"]+)"\s+"\((\w+)\)"/i;
const MARKED_ROW = /^\|>{2,}\|(.*)\|\s*$/;

export function parseSourceLine(
  detail: DumpDetail,
  whereTerminated: readonly string[] | undefined,
  sourceExtract: readonly string[] | undefined,
): DumpSourceLine {
  const out: DumpSourceLine = {};
  if (whereTerminated !== undefined) {
    const text = cleanProse(whereTerminated, "").join(" ");
    const at = TERMINATION_POINT.exec(text);
    if (at?.[1] !== undefined && at[2] !== undefined) {
      out.line = Number(at[1]);
      out.include = at[2];
    }
    const proc = IN_PROCEDURE.exec(text);
    if (proc?.[1] !== undefined) {
      out.procedure = proc[1];
      if (proc[2] !== undefined) out.procedureKind = proc[2];
    }
  }
  if (out.line === undefined && detail.termination?.line !== undefined) out.line = detail.termination.line;
  if (sourceExtract !== undefined) {
    for (const line of sourceExtract) {
      const m = MARKED_ROW.exec(line);
      if (m?.[1] !== undefined) {
        const statement = m[1].trim();
        if (statement !== "") out.statement = statement;
        break;
      }
    }
  }
  return out;
}

// -------------------------------------------------------------- call stack ---

const FRAME_ROW = /^\|\s*(\d+)\s+([A-Z]+(?:\s\([A-Z]+\))?)\s+(\S+)\s+(\S+)\s+(\d+)\s*\|\s*$/;
const NAME_ROW = /^\|\s{4,}(\S.*?)\s*\|\s*$/;

/** Frames of kap11, innermost first, as the chapter prints them. */
export function parseStackFrames(lines: readonly string[] | undefined): DumpStackFrame[] {
  if (lines === undefined) return [];
  const frames: DumpStackFrame[] = [];
  let pending: DumpStackFrame | undefined;
  for (const line of lines) {
    const frame = FRAME_ROW.exec(line);
    if (frame !== null) {
      pending = {
        no: Number(frame[1]),
        kind: frame[2] ?? "",
        program: frame[3] ?? "",
        include: frame[4] ?? "",
        line: Number(frame[5]),
        name: "",
      };
      frames.push(pending);
      continue;
    }
    if (pending !== undefined) {
      const name = NAME_ROW.exec(line);
      if (name?.[1] !== undefined) pending.name = name[1];
      pending = undefined;
    }
  }
  return frames;
}

// ----------------------------------------------------------------- assembly ---

export function summariseDump(detail: DumpDetail, formatted: string): DumpSummary {
  const have = new Set(detail.chapters.map((c) => c.name));
  const titleOf = (name: string): string => detail.chapters.find((c) => c.name === name)?.title ?? "";
  const get = (name: string): string[] | undefined => chapterLines(detail, formatted, name);

  const analysis = get("kap3");
  const correct = get("kap4");
  const where = get("kap7");
  const extract = get("kap8");
  const calls = get("kap11");

  return {
    shortText: detail.title,
    errorAnalysis: prose(analysis, titleOf("kap3"), {
      maxChars: SUMMARY_PROSE_CHARS.errorAnalysis,
      drop: ANALYSIS_NOISE,
    }),
    howToCorrect: prose(correct, titleOf("kap4"), {
      maxChars: SUMMARY_PROSE_CHARS.howToCorrect,
      cutAt: CORRECTION_BOILERPLATE,
    }),
    source: parseSourceLine(detail, where, extract),
    stack: parseStackFrames(calls),
    chapters: [...detail.chapters].sort((a, b) => a.chapterOrder - b.chapterOrder),
    missing: SUMMARY_CHAPTER_NAMES.filter((n) => !have.has(n)),
  };
}
