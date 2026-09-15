/**
 * Pure resolution logic for `core.docu` (`src/adt/fluid/builtin/core/abap-docu.ts`):
 * deciding which `(id, object)` pair to ask SAP's `DOKHL`/`DOKIL`/`DOKTL`
 * documentation store for, given an ADT object type and name, or a message
 * reference, or an IMG activity. No I/O, no ADT connection — everything
 * here is derivable from the caller's own input and the naming conventions
 * SAP's documentation tooling itself uses.
 */
import { AbapError } from "./errors.js";
import { abapCodeOf } from "./source.js";

/** One resolved `(id, object)` pair to hand `core.docu`, plus a human label for the response. */
export interface DocuTarget {
  readonly id: string;
  readonly object: string;
  /** Short human label used in the response, e.g. "data element", "class", "message", "IMG activity". */
  readonly kind: string;
}

/**
 * ADT/object type prefix -> documentation id. VERIFIED naming conventions
 * live on A4H: a data element's long text is filed under id `DE`, a
 * domain's under `DO`, and so on. Keys are the bare type (`DTEL`, not
 * `DTEL/DE`) — {@link resolveDocuTarget} normalises a slashed type before
 * looking it up here.
 */
export const DOCU_ID_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ["DTEL", "DE"],
  ["DOMA", "DO"],
  ["TABL", "TB"],
  ["CLAS", "CL"],
  ["INTF", "IF"],
  ["FUNC", "FU"],
  ["FUGR", "FU"],
  ["PROG", "RE"],
  ["MSAG", "NA"],
]);

/** Human label for each type {@link DOCU_ID_BY_TYPE} knows, used in {@link DocuTarget.kind}. */
const DOCU_KIND_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ["DTEL", "data element"],
  ["DOMA", "domain"],
  ["TABL", "table"],
  ["CLAS", "class"],
  ["INTF", "interface"],
  ["FUNC", "function module"],
  ["FUGR", "function group"],
  ["PROG", "program"],
  ["MSAG", "message class"],
]);

/**
 * Splits an already-merged message reference (`"ZSD042"`, `"/UI2/FIOCONT001"`)
 * into its id and number: the trailing three digits are the number, since
 * that is the only length a merged `DOKHL-OBJECT` message reference ever
 * has.
 */
const MERGED_MESSAGE_RE = /^(\S+?)(\d{3})$/;

/** Splits a spaced-out message reference (`"ZSD 042"`, `"ZSD 42"`) into id and number. */
const SPACED_MESSAGE_RE = /^(\S+)\s+(\d{1,3})$/;

/**
 * Turns a message reference into the stored `DOKHL-OBJECT` name for a
 * message long text. VERIFIED LIVE: message long texts are filed under
 * `id = 'NA'` with `object = <MSGID><MSGNO>`, concatenated with no
 * separator and the number zero-padded to 3 digits, unlike the message's
 * own message-id + number pair which callers usually keep separate (or
 * separated by whitespace) — `"ZSD 042"`, `"ZSD042"` and `"ZSD 42"` all
 * resolve to `"ZSD042"`; `"/UI2/FIOCONT 001"` resolves to
 * `"/UI2/FIOCONT001"`.
 */
export function parseMessageObject(object: string): string {
  const trimmed = object.trim();

  const spaced = SPACED_MESSAGE_RE.exec(trimmed);
  if (spaced) {
    const id = spaced[1] as string;
    const num = spaced[2] as string;
    return `${id.toUpperCase()}${num.padStart(3, "0")}`;
  }

  const merged = MERGED_MESSAGE_RE.exec(trimmed);
  if (merged) {
    return trimmed.toUpperCase();
  }

  throw new AbapError(
    "BAD_INPUT",
    `"${object}" is not a recognisable message reference; expected "<message id> <number>" ` +
      `(e.g. "ZSD 042") or the already-merged form (e.g. "ZSD042").`,
    { object },
  );
}

/**
 * IMG activity documentation target. VERIFIED LIVE against `TDCLD` (the
 * doc-class table) and `DOCU_GET_LANGU_FOR_DISPLAY`: when
 * `TDCLD-DOKPARCL <> SPACE`, the real lookup is `ID = TDCLD-DOKPARCL` and
 * `OBJECT = TDCLD-DOKCLASS` with `WRITE OBJECTNAME TO OBJECT+4`. Doc class
 * `SIMG`'s parent is `HY`, so an IMG activity's documentation lives at
 * `id: "HY"`, `object: "SIMG" + <activity>` — `"SIMG"` is exactly 4
 * characters, so concatenating it directly in front of the activity name
 * already puts the activity at offset 4, matching `OBJECT+4` with no
 * explicit padding needed.
 */
export function imgDocuTarget(activity: string): DocuTarget {
  return { id: "HY", object: `SIMG${activity}`, kind: "IMG activity" };
}

/**
 * Routes an ADT object type + name (or a message reference) to the
 * `(id, object)` pair `core.docu` should ask for. `MSAG` is special-cased
 * to {@link parseMessageObject} rather than a plain uppercase, since a
 * message's stored documentation object is never just the caller's object
 * name. An unknown or absent type throws, naming the types that are
 * actually supported — IMG activities aren't reachable through this
 * function at all; call {@link imgDocuTarget} directly for those, since an
 * IMG activity has no ADT object type of its own.
 */
export function resolveDocuTarget(input: { type?: string; object: string }): DocuTarget {
  const rawType = input.type?.split("/")[0]?.toUpperCase();

  if (rawType === "MSAG") {
    return { id: "NA", object: parseMessageObject(input.object), kind: "message" };
  }

  if (rawType !== undefined) {
    const id = DOCU_ID_BY_TYPE.get(rawType);
    if (id !== undefined) {
      const kind = DOCU_KIND_BY_TYPE.get(rawType) ?? rawType.toLowerCase();
      return { id, object: input.object.toUpperCase(), kind };
    }
  }

  const supported = [...DOCU_ID_BY_TYPE.keys()].join(", ");
  throw new AbapError(
    "BAD_INPUT",
    `no documentation mapping for type ${input.type ?? "(none)"}; supported types are ${supported}.`,
    { type: input.type },
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ABAP Doc for one method: the contiguous block of `"!`-prefixed comment
 * lines immediately above its `METHODS`/`CLASS-METHODS` declaration in a
 * class definition source, leading `"!` and one following space stripped,
 * in declaration order. `[]` when there is no such block, or no such
 * declaration. Case-insensitive on `member`, since ABAP identifiers are.
 * Uses {@link abapCodeOf} only to find the declaration line (so a
 * `METHODS` mentioned inside a string literal or comment is never mistaken
 * for the real one) — the doc block itself is read from the raw lines,
 * since `abapCodeOf` would blank a `"!` line to nothing.
 */
export function extractAbapDoc(source: string, member: string): string[] {
  const lines = source.split(/\r\n|\r|\n/);
  const declRe = new RegExp(`^\\s*(?:CLASS-)?METHODS\\s+${escapeRegExp(member)}\\b`, "i");

  let declIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (declRe.test(abapCodeOf(lines[i] ?? ""))) {
      declIndex = i;
      break;
    }
  }
  if (declIndex < 0) return [];

  const collected: string[] = [];
  for (let i = declIndex - 1; i >= 0; i--) {
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed.startsWith('"!')) break;
    const withoutMarker = trimmed.slice(2);
    collected.push(withoutMarker.startsWith(" ") ? withoutMarker.slice(1) : withoutMarker);
  }
  return collected.reverse();
}

/**
 * What `core.docu` actually returns: SAP's ITF documentation source
 * flattened to plain text by `CONVERT_ITF_TO_ASCII` (the same function
 * module `DOCU_GET_WITH_CONVERT` uses), not the verbatim ITF markup.
 */
export const DOCU_FLATTEN_NOTE =
  "Documentation is SAP ITF text flattened to plain lines by CONVERT_ITF_TO_ASCII " +
  "(symbols resolved, formatting tags removed, /: INCLUDE directives expanded). " +
  "It is not the verbatim ITF source.";

/**
 * Placeholder text for when documentation was looked for and not found, in
 * the two-language shape issue #109 asks for verbatim. Prefer
 * {@link docuEmptyText} when the actual list of languages tried is known —
 * this constant exists only to match that literal and as the default for
 * callers/tests that don't have a specific language list.
 */
export const DOCU_EMPTY_TEXT = "(no documentation in DE or EN)";

/** `docuEmptyText(["DE", "EN"])` reproduces {@link DOCU_EMPTY_TEXT} exactly. */
export function docuEmptyText(tried: readonly string[]): string {
  return `(no documentation in ${tried.join(" or ")})`;
}
