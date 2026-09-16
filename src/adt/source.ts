/**
 * Source reads — covers both source-based objects and method-level reads
 * ("read(CLAS ZCL_FOO, method=CALCULATE) → 30 lines, not 1,200").
 */
import type { ClassComponent } from "abap-adt-api";
import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { ResolvedObject } from "./resolve.js";
import { type ErrorContext, translateAdtError } from "./session.js";
import {
  buildUri,
  CLASS_INCLUDES,
  type ClassInclude,
  classIncludeUri,
  specForType,
  type TypeSpec,
} from "./types.js";
import { fullParse, xmlArray, xmlNode, xmlNodeAttr } from "abap-adt-api/build/utilities.js";
import {
  blankSourceIsAmbiguous,
  objectAcceptFor,
  probeObjectPresence,
  type ObjectPresence,
} from "./write-verify.js";

export interface SourceResult {
  source: string;
  /** Server-supplied ETag header, if any. Distinct from our content hash. */
  serverEtag?: string;
  sourceUri: string;
  /** Which class include was actually read, when one was asked for. */
  include?: ClassInclude;
}

/**
 * A resolved object plus, optionally, the class include the caller asked for
 * — a structural widening over `ResolvedObject` (resolve.ts), which has no
 * `include` field of its own.
 */
export type SourceTarget = ResolvedObject & { include?: ClassInclude };

/**
 * Failure classification. Previously everything collapsed to `NOT_FOUND`
 * with a "check the name" hint, sending 401s, dead sessions and open circuit
 * breakers on a wild goose chase for a typo — see
 * the git history. Delegates to `translateAdtError`
 * (same pattern as `write.ts:240-256`), then refines: 401/403 → `AUTH_FAILED`;
 * a response-less transport timeout → `details.timeout`.
 */
export function classifySourceFailure(e: unknown, ctx: ErrorContext): AbapError {
  const err = translateAdtError(e, ctx);
  if (err.code !== "ADT_ERROR") return err;

  const status = typeof err.details.status === "number" ? err.details.status : undefined;

  if (status === 401) {
    return new AbapError(
      "AUTH_FAILED",
      `Authentication failed (HTTP 401) while reading ${ctx.type ?? "object"} ${ctx.name ?? ctx.uri}. ` +
        `The server rejected the credentials — the object name was never checked.`,
      { ...err.details, status: 401 },
      "Fix ABAP_USER / ABAP_PASSWORD. Credentials are NOT retried automatically: " +
        "repeated logon attempts lock the SAP user. This is not a naming problem.",
    );
  }
  if (status === 403) {
    return new AbapError(
      "AUTH_FAILED",
      `Not authorised (HTTP 403) to read ${ctx.type ?? "object"} ${ctx.name ?? ctx.uri}. ` +
        `The logon succeeded; the user lacks the authorisation for this object.`,
      { ...err.details, status: 403 },
      "The user is authenticated but not authorised (typically S_DEVELOP). The name " +
        "is not in question — do not retry with a different name.",
    );
  }
  if (status === undefined && isTimeoutError(e)) {
    return new AbapError(
      "ADT_ERROR",
      `No response from the ABAP system while reading ${ctx.type ?? "object"} ` +
        `${ctx.name ?? ctx.uri}: the request timed out (${err.message}).`,
      { ...err.details, timeout: true },
      "The system did not answer at all, so nothing is known about the object. " +
        "Retry once; if it repeats the system is unreachable or overloaded.",
    );
  }
  return err;
}

/**
 * Transport-level timeout: axios/undici shapes, plus an explicit abort.
 * Exported for `adt/atc.ts`'s `classifyAtcFailure`, which needs the same
 * signal to give a package-scoped ATC run's HTTP timeout a dedicated,
 * `ABAP_TIMEOUT_MS`-naming message instead of the generic unclassified
 * `ADT_ERROR` fallback — see issue #78.
 */
export function isTimeoutError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const any = e as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof any.code === "string" ? any.code.toUpperCase() : "";
  if (["ECONNABORTED", "ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(code)) {
    return true;
  }
  if (any.name === "AbortError" || any.name === "TimeoutError") return true;
  return /\btime(d)?\s*-?\s*out\b|\btimeout\b/i.test(String(any.message ?? ""));
}

/**
 * Confirms an object's existence at its own URI when the source endpoint's
 * response can't be trusted on its own — either a 500 with a genuine ADT
 * exception type, or (for a `blankSourceOnAbsence` type) a 200 with an empty
 * body. A source-endpoint 500 with a genuine ADT exception type is FUGR/FF's
 * known answer for an absent function module (see capabilities.ts's FUGR/FF
 * entry: "/source/main of an already-deleted FM 500s instead of 404ing") —
 * but the identical envelope is also what a genuinely broken server sends for
 * an object that DOES exist (`test/fixtures/live-captured/040-terminate-debuggee.xml`
 * is a captured 500 from an unrelated debugger failure whose message is also
 * exactly "An exception was raised"). The envelope alone can't tell those
 * apart, so absence is confirmed the same way `resolveWriteTarget`
 * (write.ts) does: a second GET against the bare object URI — delegated to
 * `probeObjectPresence` (write-verify.ts) so a dead session there gets the
 * same one-reconnect-and-retry as every other read-back, and so the
 * caller sees `no-answer` as distinct from a confirmed presence rather than
 * both collapsing to "not absent". One extra GET, fired only on a 500 (or a
 * blank body for a `blankSourceOnAbsence` type) — the appliance's dialog
 * work processes are finite.
 */
async function objectUriPresence(conn: AbapConnection, obj: SourceTarget): Promise<ObjectPresence> {
  return (await probeObjectPresence(conn, obj.uri, objectAcceptFor(obj.type))).presence;
}

/** A string that is empty after trimming; a non-string body is never blank. */
function isBlankBody(body: unknown): boolean {
  return typeof body === "string" && body.trim() === "";
}

/**
 * Which URI actually gets fetched. An include other than `main` is never
 * answered from the main source — the call fails instead.
 */
export function sourceUriFor(obj: SourceTarget, include?: ClassInclude): string {
  const inc = include ?? obj.include;
  if (!inc || inc === "main") return obj.sourceUri ?? `${obj.uri}/source/main`;
  if (obj.type !== "CLAS/OC" && obj.kind !== "CLAS") {
    throw new AbapError(
      "UNSUPPORTED",
      `${obj.type} ${obj.name} has no "${inc}" include — class includes ` +
        `(${CLASS_INCLUDES.join(", ")}) exist only for classes.`,
      { type: obj.type, name: obj.name, requested: inc, uri: obj.uri },
      "Read this object without an include. It was NOT silently answered with the main source.",
    );
  }
  return classIncludeUri(obj.uri, inc);
}

/**
 * Read one object's source, optionally a specific class include
 * (`definitions`, `implementations`, `macros`, `testclasses`, `main`).
 * ABAP Unit reports failures inside `testclasses`, so it must be readable
 * on its own.
 */
export async function readSource(
  conn: AbapConnection,
  obj: SourceTarget,
  include?: ClassInclude,
  // G-08: explicit version selection; `undefined` = ADT's current default.
  // `abap_read`'s zod schema restricts callers to "active" | "inactive".
  version?: "active" | "inactive",
): Promise<SourceResult> {
  const inc = include ?? obj.include;
  const sourceUri = sourceUriFor(obj, inc);
  const ctx: ErrorContext = {
    operation: inc && inc !== "main" ? `read include ${inc}` : "read source",
    uri: sourceUri,
    name: obj.name,
    type: obj.type,
  };
  try {
    const resp = await conn.get(sourceUri, {
      headers: { Accept: "text/plain" },
      ...(version ? { qs: { version } } : {}),
    });
    if (isBlankBody(resp.body) && blankSourceIsAmbiguous(obj.type)) {
      const presence = await objectUriPresence(conn, obj);
      if (presence === "absent") {
        throw new AbapError(
          "NOT_FOUND",
          `${obj.type} ${obj.name} does not exist: its source endpoint answered HTTP 200 with ` +
            `an empty body (this type's known response for an absent object there), and a ` +
            `direct GET of ${obj.uri} confirmed the absence with a not-found response.`,
          { type: obj.type, name: obj.name, uri: sourceUri, absenceConfirmedVia: obj.uri },
          "Check the name with abap_search, or create it first with abap_write. This was " +
            "established by a second, independent request against the object URI, not " +
            "inferred from the empty body.",
        );
      }
      // "present" or "no-answer": a created-but-not-yet-filled skeleton is
      // not missing — return the empty source unchanged.
    }
    return {
      source: resp.body,
      serverEtag: typeof resp.headers.etag === "string" ? resp.headers.etag : undefined,
      sourceUri,
      ...(inc ? { include: inc } : {}),
    };
  } catch (e) {
    const err = classifySourceFailure(e, ctx);
    // Confirm before relabelling a 500. Requiring a server-sent `<type
    // id=...>` (not just status 500) keeps out AdtErrorException's other 500
    // shape — the one it fabricates for a non-HTTP failure, `err: 500` with
    // no `type` at all — which a real envelope always carries.
    const answered500WithType =
      err.code === "ADT_ERROR" &&
      err.details.status === 500 &&
      typeof err.details.adtExceptionType === "string" &&
      Boolean(err.details.adtExceptionType);
    if (answered500WithType) {
      const presence = await objectUriPresence(conn, obj);
      if (presence === "absent") {
        throw new AbapError(
          "NOT_FOUND",
          `${obj.type} ${obj.name} does not exist: its source endpoint answered HTTP 500 ` +
            `(the response some releases give for an absent object there), and a direct GET ` +
            `of ${obj.uri} confirmed the absence with a 404.`,
          { ...err.details, absenceConfirmedVia: obj.uri },
          "Check the name with abap_search, or create it first with abap_write. This was " +
            "established by a second, independent request against the object URI, not " +
            "inferred from the 500 alone.",
        );
      }
      // "the server said it is there" and "the server said nothing" are
      // different facts — record which, rather than letting the bare 500 imply either.
      throw new AbapError(err.code, err.message, { ...err.details, objectUriProbe: presence }, err.hint);
    }
    // A 404 on a sub-include means *the include* is absent (a class with no
    // test class has no testclasses include) — not that the class is misnamed.
    if (err.code === "NOT_FOUND" && inc && inc !== "main") {
      throw new AbapError(
        "NOT_FOUND",
        `${obj.type} ${obj.name} has no "${inc}" include at ${sourceUri}.`,
        { ...err.details, requested: inc },
        `A class with no test class has no testclasses include. Read ${obj.name} ` +
          "itself to confirm the class exists before doubting the name.",
      );
    }
    throw err;
  }
}

/**
 * A line range inside ONE source document, in ADT's coordinate space. Crosses
 * a module boundary (`/objectstructure` → `readMethod` → `abap_read`'s
 * renderer AND `abap_write`'s method splice); a wrong guess here produces
 * syntactically impossible ABAP and ships it to the server. Hence, stated not
 * assumed:
 *
 *  - `startLine`/`endLine` are 1-based, inclusive at both ends.
 *  - For `implementationBlock`, `startLine`/`endLine` are the `METHOD ...`
 *    and `ENDMETHOD.` lines THEMSELVES — not body-only.
 *  - `document` is the href path the numbers index into. ADT may report a
 *    range against a different object than the one you're holding — line 12
 *    of one document is unrelated to line 12 of another. `undefined` means
 *    the href was fragment-only (`#start=…`).
 *
 * Inclusive-of-keyword-lines confirmed against a real A4H response — see
 * the git history.
 */
export interface SourceRange {
  startLine: number;
  endLine: number;
  /** Href path before the `#`; undefined if fragment-only. Compare before reusing against a separately-fetched text. */
  document?: string;
}

export interface ClassMember {
  name: string;
  type: string;
  visibility?: string;
  level?: string;
  redefinition?: boolean;
  definition?: SourceRange;
  implementation?: SourceRange;
}

/**
 * `./source/main#start=20,2;end=67,11` →
 * `{startLine:20, endLine:67, document:"./source/main"}`.
 * The pre-`#` part matters — see `SourceRange.document`.
 */
export function parseFragmentRange(href: string | undefined): SourceRange | undefined {
  if (!href) return undefined;
  const m = /#start=(\d+)(?:,\d+)?(?:;end=(\d+)(?:,\d+)?)?/.exec(href);
  if (!m) return undefined;
  const startLine = Number(m[1]);
  const endLine = m[2] ? Number(m[2]) : startLine;
  const document = href.slice(0, href.indexOf("#"));
  return { startLine, endLine, ...(document ? { document } : {}) };
}

// ---------------------------------------------------------------------------
// ABAP lexical helpers: `abapCodeOf` is the one place that decides what's
// code vs. comment/string, so block scanning, keyword counting and the
// write-path splice all agree — none is fooled by `ENDMETHOD` inside a
// literal or comment.
// ---------------------------------------------------------------------------

/**
 * ABAP-visible code of one line: a full-line `*` comment becomes empty, a
 * trailing `"` comment is cut, and string-literal contents are blanked to
 * spaces (columns preserved) so keywords/periods inside them aren't mistaken
 * for code. Doubled quotes (`'it''s'`) are the ABAP escape, not a terminator.
 */
export function abapCodeOf(line: string): string {
  if (/^\*/.test(line)) return "";
  let out = "";
  let quote: "'" | "`" | undefined;
  let i = 0;
  while (i < line.length) {
    const ch = line[i] as string;
    if (quote !== undefined) {
      if (ch === quote) {
        if (line[i + 1] === quote) {
          out += "  ";
          i += 2;
          continue;
        }
        quote = undefined;
      }
      out += " ";
      i += 1;
      continue;
    }
    if (ch === "'" || ch === "`") {
      quote = ch;
      out += " ";
      i += 1;
      continue;
    }
    // Only outside a literal is `"` a comment; everything after it is prose.
    if (ch === '"') return out;
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Opening line of a method implementation. `METHOD\s` (not `\b`) excludes
 * `METHODS`, `CLASS-METHODS`, `METHOD-POOL`. No trailing period required —
 * an AMDP method opens with `METHOD get_data BY DATABASE PROCEDURE …` and
 * closes the statement several lines later.
 */
const METHOD_OPEN_RE = /^\s*method\s+([^\s.]+)/i;
const ENDMETHOD_RE = /^\s*endmethod\s*\./i;

/** One `METHOD … ENDMETHOD.` block located in a concrete source text. */
export interface MethodBlock {
  /** Name as WRITTEN in the source, e.g. `zif_foo~bar` or `bar`. */
  name: string;
  /** 1-based line of the `METHOD` statement. Inclusive — see `SourceRange`. */
  startLine: number;
  /** 1-based line of the `ENDMETHOD.` statement. Inclusive. */
  endLine: number;
}

export interface MethodBlockScan {
  blocks: MethodBlock[];
  /**
   * Set when the text does not tokenise into well-formed blocks (an
   * unterminated block, an `ENDMETHOD.` closing nothing, a nested `METHOD`).
   * A caller about to REWRITE this text must refuse rather than guess.
   */
  malformed?: string;
}

/**
 * Locate every `METHOD … ENDMETHOD.` block in `source`, comment/string-aware
 * — the local, checkable truth, as opposed to ADT's remote line numbers.
 */
export function scanMethodBlocks(source: string): MethodBlockScan {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: MethodBlock[] = [];
  let open: { name: string; startLine: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const code = abapCodeOf(lines[i] ?? "");
    const opened = METHOD_OPEN_RE.exec(code);
    if (opened) {
      if (open) {
        return {
          blocks,
          malformed:
            `line ${i + 1} opens METHOD ${opened[1]} while METHOD ${open.name} ` +
            `(line ${open.startLine}) is still open — methods cannot nest`,
        };
      }
      open = { name: opened[1] ?? "", startLine: i + 1 };
      continue;
    }
    if (ENDMETHOD_RE.test(code)) {
      if (!open) {
        return { blocks, malformed: `ENDMETHOD. at line ${i + 1} closes no METHOD` };
      }
      blocks.push({ name: open.name, startLine: open.startLine, endLine: i + 1 });
      open = undefined;
    }
  }
  if (open) {
    return {
      blocks,
      malformed: `METHOD ${open.name} (line ${open.startLine}) is never closed by ENDMETHOD.`,
    };
  }
  return { blocks };
}

/**
 * How many METHOD-opening and ENDMETHOD lines a text contains, counted with
 * the same comment/literal rules as `scanMethodBlocks` but tolerating
 * malformed input (it is used to COMPARE two texts, including a broken one).
 */
export function countMethodKeywordLines(source: string): { method: number; endmethod: number } {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let method = 0;
  let endmethod = 0;
  for (const line of lines) {
    const code = abapCodeOf(line);
    if (METHOD_OPEN_RE.test(code)) method += 1;
    else if (ENDMETHOD_RE.test(code)) endmethod += 1;
  }
  return { method, endmethod };
}

/**
 * The match rule `findMember` uses, applied to names written in source: equal
 * outright, or equal after dropping an interface prefix on either side
 * (`ZIF_FOO~BAR` ↔ `BAR`, which is what an ALIASES declaration produces).
 */
export function methodNamesMatch(a: string, b: string): boolean {
  const A = a.toUpperCase();
  const B = b.toUpperCase();
  return A === B || A.split("~").pop() === B.split("~").pop();
}

const REL_DEF_BLOCK = "definitionBlock";
const REL_IMPL_BLOCK = "implementationBlock";

function linkRange(c: ClassComponent, relSuffix: string): SourceRange | undefined {
  const link = (c.links ?? []).find((l) => l.rel?.endsWith(relSuffix));
  return parseFragmentRange(link?.href);
}

/**
 * Types that name a GLOBAL object. A global class or interface is never a
 * component of one, so a structure element carrying one of these types is
 * the object itself, not a member (issue #147: the ACTIVE structure of a
 * never-activated class listed the class's own name as its only "member",
 * and `available` echoed it back as a method candidate).
 */
const GLOBAL_OBJECT_TYPES = new Set(["CLAS/OC", "INTF/OI"]);

/** Flatten the component tree that `/objectstructure` returns. */
export function flattenComponents(root: ClassComponent): ClassMember[] {
  const out: ClassMember[] = [];
  const walk = (c: ClassComponent) => {
    for (const child of c.components ?? []) {
      if (!GLOBAL_OBJECT_TYPES.has(child["adtcore:type"])) {
        out.push({
          name: child["adtcore:name"],
          type: child["adtcore:type"],
          visibility: child.visibility,
          level: child.level,
          redefinition: (child as { redefinition?: boolean }).redefinition,
          definition: linkRange(child, REL_DEF_BLOCK),
          implementation: linkRange(child, REL_IMPL_BLOCK),
        });
      }
      walk(child);
    }
  };
  walk(root);
  return out;
}

export type SourceVersion = "active" | "inactive";

export interface MemberSet {
  members: ClassMember[];
  /** Which version of `/objectstructure` answered. */
  version: SourceVersion;
}

/** Mirror of abap-adt-api's private `parseElement` (api/syntax.js). */
function parseStructureElement(e: unknown): ClassComponent {
  const attrs = xmlNodeAttr(e) as Record<string, unknown>;
  const links = xmlArray(e, "atom:link").map((l: unknown) => xmlNodeAttr(l));
  const components = xmlArray(e, "abapsource:objectStructureElement").map(parseStructureElement);
  return { ...attrs, links, components } as unknown as ClassComponent;
}

/**
 * `/objectstructure` for one explicit version. abap-adt-api's
 * `classComponents` hardcodes `version=active`, so the inactive structure —
 * the only one that knows about methods added by a write that has not been
 * activated yet (issue #147) — is fetched here directly and parsed the same
 * way.
 */
async function fetchStructure(
  conn: AbapConnection,
  obj: ResolvedObject,
  version: SourceVersion,
): Promise<ClassComponent> {
  if (version === "active") return conn.adt.classComponents(obj.uri);
  const resp = await conn.get(`${obj.uri}/objectstructure`, {
    headers: { "Content-Type": "application/*" },
    qs: { version: "inactive", withShortDescriptions: "true" },
  });
  const root: unknown = xmlNode(fullParse(resp.body), "abapsource:objectStructureElement");
  if (root === undefined || root === null) {
    return {
      "adtcore:name": obj.name,
      "adtcore:type": obj.type,
      links: [],
      components: [],
    } as unknown as ClassComponent;
  }
  return parseStructureElement(root);
}

/**
 * Members of a class/interface, with the version they came from.
 *
 * No `version` ⇒ the INACTIVE structure is tried first and the active one is
 * the fallback: a method that exists only in a saved-but-not-activated
 * source is visible nowhere else, and the default source read (no
 * `?version=`) returns that same inactive text, so line ranges and members
 * describe one document. An explicit `version` is honoured as given.
 * Failures of the inactive attempt are not classified here — whatever it
 * was (no inactive version, transport, auth) the active read that follows
 * reports it, and a tripped circuit breaker refuses the second call before
 * it reaches the wire.
 */
export async function classMembersFor(
  conn: AbapConnection,
  obj: ResolvedObject,
  version?: SourceVersion,
): Promise<MemberSet> {
  const ctx: ErrorContext = {
    operation: "read components",
    uri: obj.uri,
    name: obj.name,
    type: obj.type,
  };
  const fetch = async (v: SourceVersion): Promise<MemberSet> => {
    try {
      return { members: flattenComponents(await fetchStructure(conn, obj, v)), version: v };
    } catch (e) {
      throw classifySourceFailure(e, ctx);
    }
  };
  if (version !== undefined) return fetch(version);
  // The object's own metadata already says when no inactive version exists
  // (`adtcore:version="active"` on the descriptor): skip the attempt then —
  // one request fewer, and no "inactive" claim the descriptor contradicts.
  if (obj.activation === "active-is-current") return fetch("active");
  let inactive: MemberSet | undefined;
  try {
    inactive = await fetch("inactive");
  } catch {
    inactive = undefined;
  }
  if (inactive && inactive.members.length > 0) return inactive;
  return fetch("active");
}

export async function classMembers(
  conn: AbapConnection,
  obj: ResolvedObject,
  version?: SourceVersion,
): Promise<ClassMember[]> {
  return (await classMembersFor(conn, obj, version)).members;
}

/** Case- and interface-prefix-insensitive member match. */
export function findMember(members: ClassMember[], wanted: string): ClassMember | undefined {
  const w = wanted.toUpperCase();
  return (
    members.find((m) => m.name.toUpperCase() === w) ??
    members.find((m) => m.name.toUpperCase().split("~").pop() === w)
  );
}

// ---------------------------------------------------------------------------
// Statements: the local, comment-aware view of a source text that the
// declaration scanner and the inheritance parser share.
// ---------------------------------------------------------------------------

export interface AbapStatement {
  /** Statement text as written (comments cut, literals intact), no trailing period. */
  text: string;
  /** Same text with literal contents blanked — safe to search for keywords. */
  code: string;
  startLine: number;
  endLine: number;
}

/**
 * Split a source into statements at periods outside comments and literals.
 * `text` and `code` are built in lockstep, so an offset found in `code`
 * slices `text` at the same character. Not a parser: string templates
 * (`|…|`) are not literals to `abapCodeOf`, so a period inside one ends a
 * statement early — harmless for the declaration statements this serves.
 */
export function abapStatements(source: string): AbapStatement[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: AbapStatement[] = [];
  let text = "";
  let code = "";
  let start = -1;
  const flush = (endLine: number) => {
    if (code.trim()) out.push({ text: text.trim(), code: code.trim(), startLine: start, endLine });
    text = "";
    code = "";
    start = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let c = abapCodeOf(line);
    let t = line.slice(0, c.length);
    let idx: number;
    while ((idx = c.indexOf(".")) >= 0) {
      if (start < 0 && c.slice(0, idx).trim()) start = i + 1;
      text += t.slice(0, idx);
      code += c.slice(0, idx);
      flush(i + 1);
      c = c.slice(idx + 1);
      t = t.slice(idx + 1);
    }
    if (c.trim() && start < 0) start = i + 1;
    if (start >= 0) {
      text += `${t}\n`;
      code += `${c}\n`;
    }
  }
  return out;
}

const DECLARATION_HEAD_RE = /^(CLASS-METHODS|METHODS)\b\s*(:)?\s*/i;

/**
 * The `METHODS`/`CLASS-METHODS` declaration of one method, cut from a source
 * text by scanning — the fallback when `/objectstructure` carries no
 * `definitionBlock` range for the member. A chained declaration
 * (`METHODS: a, b …`) is unchained: the answer is `METHODS b …` alone.
 */
export function findMethodDeclaration(source: string, name: string): string | undefined {
  for (const st of abapStatements(source)) {
    const head = DECLARATION_HEAD_RE.exec(st.code);
    if (!head) continue;
    const keyword = (head[1] ?? "METHODS").toUpperCase();
    const bodyAt = head[0].length;
    const segments: Array<[number, number]> = [];
    if (head[2]) {
      let from = bodyAt;
      for (;;) {
        const comma = st.code.indexOf(",", from);
        if (comma < 0) {
          segments.push([from, st.code.length]);
          break;
        }
        segments.push([from, comma]);
        from = comma + 1;
      }
    } else {
      segments.push([bodyAt, st.code.length]);
    }
    for (const [a, b] of segments) {
      const first = st.code.slice(a, b).trim().split(/\s+/)[0] ?? "";
      if (first && methodNamesMatch(first, name)) {
        return head[2] ? `${keyword} ${st.text.slice(a, b).trim()}.` : `${st.text.trim()}.`;
      }
    }
  }
  return undefined;
}

export interface ClassParents {
  /** `INHERITING FROM`, upper-cased, when the global definition names one. */
  superclass?: string;
  /** `INTERFACES` statements of the global definition, upper-cased, in order. */
  interfaces: string[];
}

/**
 * Superclass and implemented/component interfaces named by the global
 * definition in `source` (a class's main source or an interface's). Reads
 * only the first `CLASS … DEFINITION` / `INTERFACE …` block — local classes
 * live in other includes and never reach here.
 */
export function parseClassParents(source: string): ClassParents {
  const parents: ClassParents = { interfaces: [] };
  let inDefinition = false;
  for (const st of abapStatements(source)) {
    const flat = st.code.replace(/\s+/g, " ").trim();
    if (!inDefinition) {
      // `CLASS x DEFINITION …` — an interface has no DEFINITION keyword:
      // `INTERFACE x PUBLIC.` (and `INTERFACE x DEFERRED.` for a forward
      // reference, skipped like a class's).
      const def = /^(?:CLASS\s+\S+\s+DEFINITION|INTERFACE\s+\S+)\b(.*)$/i.exec(flat);
      if (!def) continue;
      if (/\b(DEFERRED|LOAD)\b/i.test(def[1] ?? "")) continue;
      inDefinition = true;
      const inh = /\bINHERITING\s+FROM\s+(\S+)/i.exec(def[1] ?? "");
      if (inh?.[1]) parents.superclass = inh[1].toUpperCase();
      continue;
    }
    if (/^(ENDCLASS|ENDINTERFACE)\b/i.test(flat)) break;
    const intf = /^INTERFACES\b\s*(:)?\s*(.*)$/i.exec(flat);
    if (!intf) continue;
    const body = intf[2] ?? "";
    const segments = intf[1] ? body.split(",") : [body];
    for (const seg of segments) {
      const first = seg.trim().split(/\s+/)[0];
      if (first) parents.interfaces.push(first.toUpperCase());
    }
  }
  return parents;
}

// ---------------------------------------------------------------------------
// The inheritance chain (issue #146).
// ---------------------------------------------------------------------------

export type ChainRelation = "superclass" | "interface";

export interface ChainNode {
  obj: ResolvedObject;
  relation: ChainRelation;
  /** The object whose definition named this one. */
  via: string;
  /** 1 for a direct superclass/interface, 2 for theirs, … */
  depth: number;
  source: string;
  members: MemberSet;
}

export interface ChainUnresolved {
  name: string;
  relation: ChainRelation;
  via: string;
  reason: string;
}

/** Enough levels for any real hierarchy; a cycle is stopped by the visited set anyway. */
const CHAIN_MAX_DEPTH = 16;

function relatedObject(base: ResolvedObject, name: string, type: "CLAS/OC" | "INTF/OI"): ResolvedObject {
  const spec = specForType(type) as TypeSpec;
  const uri = buildUri(spec, name);
  return {
    system: base.system,
    type,
    kind: spec.kind,
    label: spec.label,
    name: name.toUpperCase(),
    uri,
    sourceUri: `${uri}/source/main`,
    mode: "source",
    activation: "unknown",
    spec,
  };
}

/**
 * Breadth-first walk over superclasses and interfaces, nearest first: the
 * direct superclass, then the class's own interfaces, then the
 * superclass's parents, and so on. Each level costs one source read and one
 * `/objectstructure`. `visit` returning `true` stops the walk. A parent that
 * does not exist (or is not readable as a global class/interface) is
 * reported in `unresolved` rather than failing the whole walk; every other
 * failure propagates, already classified.
 */
export async function walkInheritanceChain(
  conn: AbapConnection,
  obj: ResolvedObject,
  source: string,
  version: SourceVersion | undefined,
  visit: (node: ChainNode) => boolean | void,
): Promise<{ visited: ChainNode[]; unresolved: ChainUnresolved[] }> {
  const visited: ChainNode[] = [];
  const unresolved: ChainUnresolved[] = [];
  const seen = new Set<string>([obj.name.toUpperCase()]);
  type Pending = {
    name: string;
    type: "CLAS/OC" | "INTF/OI";
    relation: ChainRelation;
    via: string;
    depth: number;
  };
  const queue: Pending[] = [];
  const enqueue = (from: string, parents: ClassParents, depth: number) => {
    if (depth > CHAIN_MAX_DEPTH) return;
    if (parents.superclass && !seen.has(parents.superclass)) {
      seen.add(parents.superclass);
      queue.push({ name: parents.superclass, type: "CLAS/OC", relation: "superclass", via: from, depth });
    }
    for (const i of parents.interfaces) {
      if (seen.has(i)) continue;
      seen.add(i);
      queue.push({ name: i, type: "INTF/OI", relation: "interface", via: from, depth });
    }
  };
  enqueue(obj.name, parseClassParents(source), 1);
  while (queue.length > 0) {
    const next = queue.shift() as Pending;
    const parent = relatedObject(obj, next.name, next.type);
    let parentSource: string;
    let members: MemberSet;
    try {
      parentSource = (await readSource(conn, parent, undefined, version)).source;
      members = await classMembersFor(conn, parent, version);
    } catch (e) {
      if (e instanceof AbapError && e.code === "NOT_FOUND") {
        unresolved.push({ name: next.name, relation: next.relation, via: next.via, reason: e.message });
        continue;
      }
      throw e;
    }
    const node: ChainNode = {
      obj: parent,
      relation: next.relation,
      via: next.via,
      depth: next.depth,
      source: parentSource,
      members,
    };
    visited.push(node);
    if (visit(node) === true) break;
    enqueue(parent.name, parseClassParents(parentSource), next.depth + 1);
  }
  return { visited, unresolved };
}

export interface MethodOrigin {
  name: string;
  type: string;
  relation: ChainRelation;
  /** The object whose definition named `name` — the class itself at depth 1. */
  via: string;
  depth: number;
}

export interface MethodSource {
  member: ClassMember;
  declaration?: string;
  implementation?: string;
  /**
   * ADT-reported range for the implementation block (see `SourceRange` for
   * coordinate semantics). Safe to render; NOT safe to slice a separately
   * fetched text with unverified — `spliceMethodBlock` in src/tools/write.ts
   * re-derives the block from the bytes it rewrites and uses this only as a
   * cross-check. When `foundOn` is set the range is in THAT object's source.
   */
  implementationRange?: SourceRange;
  /** Which `/objectstructure` version the member was resolved against. */
  version: SourceVersion;
  /** Set when the member was not on the object itself but up its chain. */
  foundOn?: MethodOrigin;
  /** Objects searched before the answer, nearest first; the object itself first. */
  searched: string[];
}

/**
 * How many component names a "no such method" error lists per origin.
 * `ABAP_AVAILABLE_MEMBERS_MAX` overrides the default; the cut is always
 * disclosed, and members sharing a prefix with the requested name survive it
 * first.
 */
export const AVAILABLE_MEMBERS_MAX_DEFAULT = 40;

export function availableMembersMax(): number {
  const raw = process.env.ABAP_AVAILABLE_MEMBERS_MAX;
  if (raw === undefined || raw.trim() === "") return AVAILABLE_MEMBERS_MAX_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : AVAILABLE_MEMBERS_MAX_DEFAULT;
}

/** Plain Levenshtein edit distance, no dependencies. */
function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] ?? 0;
      prev[j] = a[i - 1] === b[j - 1] ? diag : 1 + Math.min(diag, tmp, prev[j - 1] ?? 0);
      diag = tmp;
    }
  }
  return prev[b.length] ?? 0;
}

function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/**
 * Candidates for "did you mean": longest shared prefix first (a caller
 * asking for GET_COLUMNS wants GET_COLUMN and GET_COLUMNS_TABLE ahead of
 * SET_COLUMNS), edit distance second, name third for a stable answer.
 */
export function rankCandidates(names: string[], wanted: string): string[] {
  const w = wanted.toUpperCase();
  return [...names].sort((a, b) => {
    const A = a.toUpperCase();
    const B = b.toUpperCase();
    const byPrefix = commonPrefixLength(B, w) - commonPrefixLength(A, w);
    if (byPrefix !== 0) return byPrefix;
    const byDistance = levenshtein(A, w) - levenshtein(B, w);
    if (byDistance !== 0) return byDistance;
    return A < B ? -1 : A > B ? 1 : 0;
  });
}

export interface ReadMethodOptions {
  /** Explicit structure version; default is inactive-then-active (issue #147). */
  version?: SourceVersion;
  /** Walk superclasses and interfaces when the object itself lacks the member (issue #146). */
  inherited?: boolean;
  /** Cap on each candidate list in the NOT_FOUND details; default `availableMembersMax()`. */
  availableMax?: number;
}

const isMethod = (m: ClassMember): boolean => m.type === "CLAS/OM" || m.type === "INTF/OM";

function resolveIn(
  members: ClassMember[],
  source: string,
  method: string,
): Omit<MethodSource, "version" | "searched"> | undefined {
  const methods = members.filter(isMethod);
  const member = findMember(methods.length ? methods : members, method);
  if (!member) return undefined;
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const cut = (r?: SourceRange) =>
    r ? lines.slice(Math.max(0, r.startLine - 1), r.endLine).join("\n") : undefined;
  const declaration = cut(member.definition) ?? findMethodDeclaration(source, member.name);
  const implementation = cut(member.implementation);
  return {
    member,
    ...(declaration !== undefined ? { declaration } : {}),
    ...(implementation !== undefined ? { implementation } : {}),
    ...(member.implementation ? { implementationRange: member.implementation } : {}),
  };
}

/**
 * Return only the declaration and body of one method.
 * Costs one extra round trip (`/objectstructure`) — two when the inactive
 * structure is empty and the active one has to be read — and saves ~20x on
 * payload. With `inherited: true`, a member the object does not declare is
 * looked for up its superclass/interface chain (two more requests per
 * level) and answered with `foundOn`.
 */
export async function readMethod(
  conn: AbapConnection,
  obj: ResolvedObject,
  source: string,
  method: string,
  opts: ReadMethodOptions = {},
): Promise<MethodSource> {
  const own = await classMembersFor(conn, obj, opts.version);
  const searched = [obj.name];
  const here = resolveIn(own.members, source, method);
  if (here) return { ...here, version: own.version, searched };

  const inheritedPool: Array<{ name: string; on: string; relation: ChainRelation }> = [];
  let unresolved: ChainUnresolved[] = [];
  if (opts.inherited) {
    let found: MethodSource | undefined;
    const walk = await walkInheritanceChain(conn, obj, source, opts.version, (node) => {
      searched.push(`${node.obj.name} (${node.relation} of ${node.via})`);
      const r = resolveIn(node.members.members, node.source, method);
      if (r) {
        found = {
          ...r,
          version: node.members.version,
          foundOn: {
            name: node.obj.name,
            type: node.obj.type,
            relation: node.relation,
            via: node.via,
            depth: node.depth,
          },
          searched,
        };
        return true;
      }
      for (const m of node.members.members.filter(isMethod)) {
        // Private members of a superclass are not inherited; an interface has no private members.
        if (node.relation === "superclass" && m.visibility === "private") continue;
        inheritedPool.push({ name: m.name, on: node.obj.name, relation: node.relation });
      }
      return false;
    });
    if (found) return found;
    unresolved = walk.unresolved;
  }

  // The cap MUST be disclosed — a silently-cut list makes an agent conclude
  // a real method doesn't exist. Prefix-sharing names survive the cut first.
  const max = opts.availableMax ?? availableMembersMax();
  const methods = own.members.filter(isMethod);
  const pool = methods.length ? methods : own.members;
  const shown = rankCandidates(
    pool.map((m) => m.name),
    method,
  ).slice(0, max);
  const dropped = pool.length - shown.length;
  const byName = new Map(inheritedPool.map((c) => [c.name.toUpperCase(), c]));
  const inheritedShown = rankCandidates([...byName.keys()], method)
    .slice(0, max)
    .map((n) => {
      const c = byName.get(n) as { name: string; on: string; relation: ChainRelation };
      return `${c.name} (${c.on})`;
    });
  const inheritedDropped = byName.size - inheritedShown.length;

  const where = opts.inherited
    ? `${obj.type} ${obj.name} has no method ${method}, and neither does anything it inherits ` +
      `from or implements (searched ${searched.join(", ")}).`
    : `${obj.type} ${obj.name} has no method ${method}.`;
  const truncation =
    dropped > 0
      ? ` [TRUNCATED: listing ${shown.length} of ${pool.length} components — ${dropped} not shown, ` +
        `retrieve with: abap_read({outline:true})]`
      : "";
  const emptiness =
    pool.length === 0
      ? ` The ${own.version} version of ${obj.name} declares no methods at all` +
        (own.version === "active"
          ? " (no inactive version was found, so the active structure was used)."
          : ".")
      : "";
  throw new AbapError(
    "NOT_FOUND",
    `${where}${emptiness}${truncation}`,
    {
      method,
      version: own.version,
      searched,
      availableTotal: pool.length,
      available: shown,
      ...(dropped > 0 ? { availableTruncated: dropped } : {}),
      ...(opts.inherited
        ? {
            availableInheritedTotal: byName.size,
            availableInherited: inheritedShown,
            ...(inheritedDropped > 0 ? { availableInheritedTruncated: inheritedDropped } : {}),
          }
        : {}),
      ...(unresolved.length > 0 ? { unresolved } : {}),
    },
    (dropped > 0
      ? `The list above is INCOMPLETE (${shown.length} of ${pool.length}). Read the object ` +
        "with outline=true for every component before concluding the method is missing. "
      : pool.length === 0
        ? "`available` is empty because the structure has no methods, not because the list was cut. "
        : "") +
      (opts.inherited
        ? "Members are resolved against the inactive version when one exists, then the active one, " +
          "then up the superclass/interface chain; `availableInherited` names the origin of each " +
          "inherited candidate."
        : "Read the object with outline=true to see its full component list, including inherited members."),
  );
}

export interface InheritedMember extends ClassMember {
  /** Defining class or interface. */
  on: string;
  relation: ChainRelation;
  depth: number;
}

export interface InheritedOutline {
  inherited: InheritedMember[];
  /** Chain objects read, nearest first. */
  searched: string[];
  unresolved: ChainUnresolved[];
}

/**
 * Public and protected members the object gets from its superclasses and
 * interfaces, excluding anything it declares (or redefines/implements)
 * itself — the nearest definition wins. Costs two requests per chain
 * level; zero when the definition names no parent.
 */
export async function inheritedMembers(
  conn: AbapConnection,
  obj: ResolvedObject,
  source: string,
  own: ClassMember[],
  version?: SourceVersion,
): Promise<InheritedOutline> {
  const inherited: InheritedMember[] = [];
  const searched: string[] = [];
  const taken = new Set(own.map((m) => m.name.toUpperCase()));
  const walk = await walkInheritanceChain(conn, obj, source, version, (node) => {
    searched.push(node.obj.name);
    for (const m of node.members.members) {
      if (node.relation === "superclass" && m.visibility === "private") continue;
      const key = m.name.toUpperCase();
      // An interface method reaches the implementing class as `IF~METHOD`.
      const implemented = node.relation === "interface" ? `${node.obj.name}~${key}` : key;
      if (taken.has(key) || taken.has(implemented)) continue;
      taken.add(key);
      inherited.push({ ...m, on: node.obj.name, relation: node.relation, depth: node.depth });
    }
    return false;
  });
  return { inherited, searched, unresolved: walk.unresolved };
}

const OUTLINE_TYPES = new Set(["CLAS/OM", "INTF/OM", "CLAS/OA", "INTF/OA"]);

function outlineRow(m: ClassMember, indent: string): string {
  const loc = m.implementation
    ? `${m.implementation.startLine}-${m.implementation.endLine}`
    : m.definition
      ? `${m.definition.startLine}-${m.definition.endLine}`
      : "";
  const flags = [m.visibility, m.level, m.redefinition ? "redefinition" : undefined]
    .filter(Boolean)
    .join(" ");
  return `${indent}${m.name}  [${flags}]${loc ? `  lines ${loc}` : ""}`;
}

/** One-line-per-member outline. Cheap orientation before a targeted read. */
export function renderOutline(members: ClassMember[]): string {
  return members
    .filter((m) => OUTLINE_TYPES.has(m.type))
    .map((m) => outlineRow(m, "  "))
    .join("\n");
}

/**
 * The inherited section of an outline, grouped by defining object, nearest
 * first. Line numbers are those of the DEFINING object's source, which is
 * why each group names it: a `method=` read of the class resolves these
 * through the chain, a full read of the class never shows them.
 */
export function renderInheritedOutline(rows: InheritedMember[]): string {
  const groups = new Map<string, InheritedMember[]>();
  for (const r of rows) {
    if (!OUTLINE_TYPES.has(r.type)) continue;
    const list = groups.get(r.on) ?? [];
    list.push(r);
    groups.set(r.on, list);
  }
  const out: string[] = [];
  for (const [on, list] of groups) {
    const relation = list[0]?.relation ?? "superclass";
    out.push(`  from ${on} (${relation}, depth ${list[0]?.depth ?? 1}; line numbers are ${on}'s):`);
    for (const r of list) out.push(outlineRow(r, "    "));
  }
  return out.join("\n");
}
