/**
 * Portions derived from vibing-steampunk (pkg/adt/debugger.go),
 * Copyright (c) 2025-2026 Alice Vinogradova and contributors, MIT.
 * See THIRD-PARTY-NOTICES.md.
 */

/**
 * Debugger response parsers: pure `(text) => T` functions, tested offline against fixtures in
 * `test/fixtures/debugger/`.
 *
 * Two response families with OPPOSITE conventions, deliberately not sharing a generic parser:
 *   - `dbg:` family (attach/step/stack/breakpoints): camelCase attributes, `"true"`/`"false"` (`dbgBool`).
 *   - `asx:abap` family (getVariables/getChildVariables/debuggee): SCREAMING_SNAKE children, and NOT
 *     internally uniform — boolean convention is per field, per structure; see `abapFlag`.
 * `getVariables`/`getChildVariables` also nest rows at different depths despite sharing a row shape
 * — kept as separate functions on purpose (see the git history).
 *
 * Malformed/unexpected input always throws `DebugXmlParseError` — never a silent `[]` or partial object.
 */

import { XMLParser } from "fast-xml-parser";
import { isSessionDeath } from "../adt/session.js";
import { truncateText, truncateDiagnosticBody, PARSE_EXCERPT_MAX, MESSAGE_EXCERPT_MAX } from "../truncate.js";
import type {
  AdtError,
  BatchResult,
  BreakpointError,
  ChildVariablesResult,
  CreatedBreakpoint,
  DebugAction,
  DebugAttachResult,
  DebugMetaType,
  DebugReachedBreakpoint,
  DebugSessionState,
  DebugSettings,
  DebugStack,
  DebugStackFrame,
  DebugStepResult,
  DebugVariable,
  DebugVariableHierarchy,
  Debuggee,
  DebuggeeKind,
  IsConflict,
  IsNoSessionAttached,
  IsSessionExpired,
} from "./types.js";

// ---------------------------------------------------------------------------
// Shared error type — "malformed input never produces a silent empty result"
// ---------------------------------------------------------------------------

/** Thrown by every parser in this module on structurally unexpected input. Never swallowed. */
export class DebugXmlParseError extends Error {
  /** First ~500 chars of the offending input, with a truncation marker if cut. */
  readonly excerpt: string;

  constructor(message: string, input: string) {
    super(message);
    this.name = "DebugXmlParseError";
    this.excerpt = truncateText(input, PARSE_EXCERPT_MAX);
  }
}

// ---------------------------------------------------------------------------
// The parser instance and the boolean/array/scalar conventions of both families
// ---------------------------------------------------------------------------

// removeNSPrefix operates on the parsed element/attribute tree, not on character data — unlike
// a naive `strings.ReplaceAll(xml, "dbg:", "")`, it cannot corrupt a value that happens to contain
// that literal.
/**
 * `trimValues: false` is LOAD-BEARING, not a style choice: ABAP CHAR/NUMC padding IS the value,
 * and `P`/`I` values carry their sign in a trailing column that naive trimming corrupts
 * asymmetrically (positive space stripped, negative hyphen kept — see `parseAbapNumeric`). See
 * the git history for the fixture evidence before changing this.
 * Localised prose that does want trimming (`<message>`, `<entry key=…>`) is trimmed explicitly at
 * the read site instead (`textOf`, `parseAdtError`).
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
});

/** A row of attributes or SCREAMING_SNAKE children, before it is typed into a concrete shape. */
type Row = Record<string, string | undefined>;

/** fast-xml-parser gives an object for a single child, an array for 2+, nothing for 0. Normalise. */
function toArray<T>(value: unknown): T[] {
  if (value === undefined || value === null || value === "") return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}

/**
 * The classic ABAP flag convention: `"X"` = true, `""`/absent (self-closing) = false.
 * Scope is live-proven narrow (only `IS_LOCAL` and `READ_ONLY` in the corpus) — not the
 * `asx:abap` envelope's default convention; see `abapFlag`. See archive for the corpus evidence.
 */
export function xBool(value: string | undefined): boolean {
  return value === "X";
}

/** The `dbg:` family's boolean convention: the strings `"true"`/`"false"`, never `XBool`. */
function dbgBool(value: string | undefined): boolean {
  return value === "true";
}

/**
 * Tolerant flag reader accepting BOTH families: `"X"` or `"true"` is true; `""`, absent, and
 * `"false"` are false. Safe here specifically because the two vocabularies never collide on any
 * field in the corpus (see archive for the two fields that need it and why). Unobserved spellings
 * (`"1"`, `"TRUE"`, `"Y"`) are not accepted.
 */
function abapFlag(value: string | undefined): boolean {
  return value === "X" || value === "true";
}

function str(value: string | undefined, fallback = ""): string {
  return value ?? fallback;
}

// ---------------------------------------------------------------------------
// ABAP numeric values — the trailing sign column
// ---------------------------------------------------------------------------

/** A rendered ABAP magnitude after the sign column is removed: digits, optional decimal point.
 * No exponent, thousands separator, or leading `+` — none observed on the wire. */
const ABAP_NUMERIC_MAGNITUDE = /^\d+(?:\.\d+)?$/;

interface AbapNumericParts {
  negative: boolean;
  magnitude: string;
}

/**
 * Split a wire `VALUE` into sign and magnitude, or `undefined` if not a recognised number.
 *
 * The sign is a TRAILING column, not a leading character (live-proven — see archive):
 * `0x2D` hyphen when negative, `0x20` space when positive. A leading minus is also accepted
 * (used by hand-authored fixtures and JS-side round trips); a value carrying both is refused.
 */
function splitAbapNumeric(value: string | undefined): AbapNumericParts | undefined {
  if (value === undefined) return undefined;
  let s = value;
  // The sign column is the LAST character; strip it before any whitespace handling, because for a
  // positive number that column IS the trailing space and must not be mistaken for padding.
  let trailingNegative = false;
  const trimmedRight = s.replace(/\s+$/, "");
  if (trimmedRight.endsWith("-")) {
    trailingNegative = true;
    s = trimmedRight.slice(0, -1);
  } else {
    s = trimmedRight;
  }
  s = s.replace(/^\s+/, "");
  let leadingNegative = false;
  if (s.startsWith("-")) {
    leadingNegative = true;
    s = s.slice(1);
  }
  // Both spellings at once is not a number anyone sends; refusing beats picking one.
  if (trailingNegative && leadingNegative) return undefined;
  if (!ABAP_NUMERIC_MAGNITUDE.test(s)) return undefined;
  return { negative: trailingNegative || leadingNegative, magnitude: s };
}

/**
 * Parse a wire `VALUE` into a JS number with the sign the server actually sent, or `undefined`
 * when it isn't a number this parser can vouch for.
 *
 * Never use `parseFloat`/`Number`/unary `+` on a wire `VALUE` directly: `parseFloat("123.45-")`
 * silently returns the positive magnitude with the sign dropped. Returns `undefined`, never `NaN`
 * or `0`, for non-numeric input.
 *
 * Scale is not recoverable from anything but `VALUE` (there is no `DECIMALS` field) — use
 * `formatAbapNumeric` when the scale matters, which is any time the value is shown to a human.
 */
export function parseAbapNumeric(value: string | undefined): number | undefined {
  const parts = splitAbapNumeric(value);
  if (!parts) return undefined;
  const n = Number(parts.magnitude);
  if (!Number.isFinite(n)) return undefined;
  return parts.negative ? -n : n;
}

/**
 * Rewrite a wire `VALUE` into conventional leading-sign notation, preserving every digit sent:
 * `"123.45-"` → `"-123.45"`, `"12.50 "` → `"12.50"`. Unlike `parseAbapNumeric` this keeps the
 * decimal scale. `undefined` when the value is not numeric — callers then show the raw bytes.
 */
export function formatAbapNumeric(value: string | undefined): string | undefined {
  const parts = splitAbapNumeric(value);
  if (!parts) return undefined;
  return parts.negative ? `-${parts.magnitude}` : parts.magnitude;
}

// ---------------------------------------------------------------------------
// HEX_VALUE decoding — per-type, and ONLY for types a capture actually proves
// ---------------------------------------------------------------------------

/**
 * A decoded `HEX_VALUE`, discriminated by `TECHNICAL_TYPE`: an `I` is a number, a `C`/`D` is
 * text, and a `P` is an *unscaled* integer whose decimal point exists only in `VALUE`.
 */
export type DecodedHexValue =
  /** `TECHNICAL_TYPE = I` — 4-byte little-endian two's complement. */
  | { technicalType: "I"; number: number }
  /**
   * `TECHNICAL_TYPE = P` — big-endian packed BCD. `digits` is the UNSCALED integer (scale lives
   * only in `VALUE`), `negative` comes from the trailing sign nibble.
   */
  | { technicalType: "P"; digits: string; negative: boolean }
  /** `TECHNICAL_TYPE = C` or `D` — UTF-16 **little**-endian, 2 bytes per character. */
  | { technicalType: "C" | "D"; text: string };

/** The complete set of `TECHNICAL_TYPE`s whose `HEX_VALUE` encoding a live capture actually proves. */
export const DECODABLE_TECHNICAL_TYPES: ReadonlySet<string> = new Set(["C", "D", "I", "P"]);

function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length === 0 || hex.length % 2 !== 0) return undefined;
  if (!/^[0-9A-Fa-f]+$/.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Decode a `STPDA_ADT_VARIABLE.HEX_VALUE`, or return `undefined` — never a guess.
 *
 * The encoding is PER TYPE; unifying endianness across types produces plausible-looking wrong
 * numbers. Only `C`/`D`/`I`/`P` are decoded (the only types in the 96-capture corpus): `I` is
 * 4-byte little-endian two's complement, `P` is big-endian packed BCD with one sign nibble,
 * `C`/`D` is UTF-16 little-endian. See archive for the byte-level evidence, including a
 * `test/fixtures/live-captured/INDEX.md` claim about `C`'s endianness that is WRONG.
 *
 * Every other `TECHNICAL_TYPE` is unobserved and returns `undefined` rather than a guessed
 * decode. `length`, when given, is enforced as an invariant (byte count for `P`, 2× for `C`/`D`);
 * a mismatch yields `undefined` rather than a partial decode.
 */
export function decodeHexValue(
  hexValue: string | undefined,
  technicalType: string | undefined,
  length?: number,
): DecodedHexValue | undefined {
  if (!hexValue || !technicalType) return undefined;
  if (!DECODABLE_TECHNICAL_TYPES.has(technicalType)) return undefined;
  const hex = hexValue.trim();
  const bytes = hexToBytes(hex);
  if (!bytes) return undefined;

  switch (technicalType) {
    case "I": {
      // 4-byte LE two's complement. Any other width is a shape we have not seen — refuse.
      if (bytes.length !== 4) return undefined;
      if (length !== undefined && length !== 4) return undefined;
      const u =
        (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0;
      // `>> 0` reinterprets the unsigned 32-bit pattern as signed — the two's complement step.
      return { technicalType: "I", number: u | 0 };
    }
    case "P": {
      if (length !== undefined && length !== bytes.length) return undefined;
      const signNibble = hex[hex.length - 1]!.toUpperCase();
      // Only C/D observed; A/B/E/F are documented ABAP sign nibbles but unproven — refused rather
      // than assumed positive.
      if (signNibble !== "C" && signNibble !== "D") return undefined;
      const digits = hex.slice(0, -1);
      if (!/^[0-9]+$/.test(digits)) return undefined;
      // Strip leading zeros but keep at least one digit, so "000…0000C" is "0", not "".
      const normalised = digits.replace(/^0+(?=\d)/, "");
      return { technicalType: "P", digits: normalised, negative: signNibble === "D" };
    }
    case "C":
    case "D": {
      if (bytes.length % 2 !== 0) return undefined;
      if (length !== undefined && bytes.length !== length * 2) return undefined;
      let text = "";
      for (let i = 0; i < bytes.length; i += 2) {
        // LITTLE-endian: low byte first. `4100` → 0x0041 → 'A'.
        text += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8));
      }
      return { technicalType, text };
    }
    default:
      return undefined;
  }
}

function num(value: string | undefined, fallback = 0): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optNum(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Text of `<foo>bar</foo>` or `<foo attr="…">bar</foo>`. Trims explicitly — this reads localised
 * human prose (`<message>`, `<localizedMessage>`), not fixed-width ABAP data, and the parser no
 * longer trims globally (see the `trimValues: false` note above).
 */
function textOf(node: unknown): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === "string") return node.trim();
  if (typeof node === "object" && "#text" in (node as Record<string, unknown>)) {
    return String((node as Record<string, unknown>)["#text"]).trim();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The `dbg:` family — attach / step / stack / breakpoints
// ---------------------------------------------------------------------------

function parseDebugAction(row: Row): DebugAction {
  return {
    name: str(row.name),
    style: str(row.style),
    group: str(row.group),
    title: str(row.title),
    // Not present on either attach.xml or step.xml's <dbg:action> rows despite DebugAction
    // declaring these required — needs live confirmation of whether the server ever sends them.
    link: str(row.link),
    value: row.value ?? "",
    disabled: dbgBool(row.disabled),
  };
}

function parseReachedBreakpoint(row: Row): DebugReachedBreakpoint {
  return {
    id: str(row.id),
    kind: str(row.kind),
    unresolvableCondition: row.unresolvableCondition,
    unresolvableConditionErrorOffset: row.unresolvableConditionErrorOffset,
  };
}

/**
 * Shared by `parseAttachResponse` and `parseStepResponse` — an earlier `parseStep` drops
 * `reachedBreakpoints` entirely even though `parseAttach` parses the equivalent node; sharing this
 * helper keeps that gap from reappearing in one of the two.
 */
function parseReachedBreakpoints(root: Record<string, unknown>): DebugReachedBreakpoint[] {
  const node = root.reachedBreakpoints;
  if (typeof node !== "object" || node === null) return []; // covers both absent and `""` (self-closing)
  return toArray<Row>((node as Record<string, unknown>).breakpoint).map(parseReachedBreakpoint);
}

function parseActions(root: Record<string, unknown>): DebugAction[] {
  const node = root.actions as Record<string, unknown> | undefined;
  return toArray<Row>(node?.action).map(parseDebugAction);
}

/** Attributes shared by `<dbg:attach>` and `<dbg:step>` (`DebugSessionState`). */
function parseSessionStateAttrs(a: Row): Omit<DebugSessionState, "actions"> {
  return {
    isRfc: dbgBool(a.isRfc),
    isSameSystem: dbgBool(a.isSameSystem),
    serverName: str(a.serverName),
    debugSessionId: str(a.debugSessionId),
    processId: num(a.processId),
    isPostMortem: dbgBool(a.isPostMortem),
    isUserAuthorizedForChanges: dbgBool(a.isUserAuthorizedForChanges),
    debuggeeSessionId: str(a.debuggeeSessionId),
    abapTraceState: str(a.abapTraceState),
    canAdvancedTableFeatures: dbgBool(a.canAdvancedTableFeatures),
    isNonExclusive: dbgBool(a.isNonExclusive),
    isNonExclusiveToggled: dbgBool(a.isNonExclusiveToggled),
    guiEditorGuid: str(a.guiEditorGuid),
    sessionTitle: str(a.sessionTitle),
    isSteppingPossible: dbgBool(a.isSteppingPossible),
    isTerminationPossible: dbgBool(a.isTerminationPossible),
  };
}

export function parseAttachResponse(xmlText: string): DebugAttachResult {
  const parsed = parser.parse(xmlText) as Record<string, unknown>;
  const root = parsed.attach as Row & Record<string, unknown>;
  if (!root || typeof root !== "object") {
    throw new DebugXmlParseError("parseAttachResponse: expected root <dbg:attach> element", xmlText);
  }
  return {
    ...parseSessionStateAttrs(root),
    actions: parseActions(root),
    reachedBreakpoints: parseReachedBreakpoints(root),
  };
}

/**
 * Reads a `<dbg:settings>` attribute block into `DebugSettings`. Appears both nested inside a
 * `<dbg:step>` response (an informational snapshot) and as the entire body of the
 * `?method=setDebuggerSettings` response (the server's authoritative echo of what it actually
 * applied — see `parseSettingsResponse`). Missing/empty element yields all-false, matching
 * `dbgBool`'s absent-is-false convention.
 */
export function parseSettingsAttrs(node: Record<string, string | undefined> | undefined): DebugSettings {
  const a = (node ?? {}) as Row;
  return {
    systemDebugging: dbgBool(a.systemDebugging),
    createExceptionObject: dbgBool(a.createExceptionObject),
    backgroundRFC: dbgBool(a.backgroundRFC),
    sharedObjectDebugging: dbgBool(a.sharedObjectDebugging),
    showDataAging: dbgBool(a.showDataAging),
    updateDebugging: dbgBool(a.updateDebugging),
  };
}

/**
 * Parses a response body whose ROOT element is `<dbg:settings>` — what
 * `POST /sap/bc/adt/debugger?method=setDebuggerSettings` returns. Throws on a missing root,
 * including the degenerate self-closing `<dbg:settings/>`, which `DebugClient.setDebuggerSettings`
 * catches rather than failing an already-applied mutation.
 */
export function parseSettingsResponse(xmlText: string): DebugSettings {
  const parsed = parser.parse(xmlText) as Record<string, unknown>;
  const root = parsed.settings as Row | undefined;
  if (!root || typeof root !== "object") {
    throw new DebugXmlParseError("parseSettingsResponse: expected root <dbg:settings> element", xmlText);
  }
  return parseSettingsAttrs(root);
}

export function parseStepResponse(xmlText: string): DebugStepResult {
  const parsed = parser.parse(xmlText) as Record<string, unknown>;
  const root = parsed.step as Row & Record<string, unknown>;
  if (!root || typeof root !== "object") {
    throw new DebugXmlParseError("parseStepResponse: expected root <dbg:step> element", xmlText);
  }
  const settings: DebugSettings = parseSettingsAttrs(root.settings as Row | undefined);
  return {
    // step.xml (the real fixture) omits several DebugSessionState fields DebugStepResult declares
    // required; defaulted (false/"") rather than thrown — needs live confirmation of whether a
    // real step response omits them or the fixture was hand-trimmed.
    ...parseSessionStateAttrs(root),
    actions: parseActions(root),
    reachedBreakpoints: parseReachedBreakpoints(root),
    isDebuggeeChanged: dbgBool(root.isDebuggeeChanged),
    settings,
  };
}

export function parseStackResponse(xmlText: string): DebugStack {
  const parsed = parser.parse(xmlText) as Record<string, unknown>;
  const root = parsed.stack as Row & Record<string, unknown>;
  if (!root || typeof root !== "object") {
    throw new DebugXmlParseError("parseStackResponse: expected root <dbg:stack> element", xmlText);
  }
  const frames: DebugStackFrame[] = toArray<Row>(root.stackEntry).map((e) => ({
    // stackPosition is 1-based on the wire (confirmed by stack.xml) — do not renumber by index.
    stackPosition: num(e.stackPosition),
    stackType: str(e.stackType) as DebugStackFrame["stackType"],
    stackUri: str(e.stackUri),
    programName: str(e.programName),
    includeName: str(e.includeName),
    line: num(e.line),
    eventType: str(e.eventType),
    eventName: str(e.eventName),
    sourceType: str(e.sourceType) as DebugStackFrame["sourceType"],
    systemProgram: dbgBool(e.systemProgram),
    isVit: dbgBool(e.isVit),
    // Optional: not every frame has a resolvable source URI (stack.xml's system frame has none).
    uri: e.uri,
  }));
  return {
    isRfc: dbgBool(root.isRfc),
    isSameSystem: dbgBool(root.isSameSystem),
    serverName: str(root.serverName),
    debugCursorStackIndex: optNum(root.debugCursorStackIndex),
    frames,
  };
}

/**
 * True for a response body that is genuinely empty — zero bytes, or nothing but whitespace.
 *
 * An empty body is a NORMAL, documented answer on this appliance (HTTP 200, `content-length: 0`,
 * no `content-type` header at all), not a failure — see archive for the specific fixtures.
 * A non-empty body of the wrong shape is still a parse error.
 */
function isEmptyBody(xmlText: string): boolean {
  return xmlText.trim() === "";
}

/**
 * The breakpoint-set response (`POST /sap/bc/adt/debugger/breakpoints`).
 *
 * Live-confirmed shape: the prefixed root `<dbg:breakpoints>` holds bare `<breakpoint>` children
 * carrying `adtcore:uri`. In-band rejection is also confirmed: HTTP 200 with an `errorMessage`
 * attribute and no `id`, surfaced here as `BreakpointError` rather than dropped (unlike a naive
 * parser, which silently drops rejected rows).
 *
 * **Empty results are normal.** A successful clear-all answers with the self-closing root
 * `<dbg:breakpoints/>`, which fast-xml-parser collapses to `""` — treated as zero breakpoints, not
 * a parse error. A root that is present but not `<dbg:breakpoints>` still throws.
 */
export function parseBreakpointsResponse(xmlText: string): Array<CreatedBreakpoint | BreakpointError> {
  if (isEmptyBody(xmlText)) return [];
  const parsed = parser.parse(xmlText) as Record<string, unknown>;
  const rootNode = parsed.breakpoints;
  // `""` is the self-closing `<dbg:breakpoints/>` — present, valid, and carrying zero breakpoints.
  // `undefined` is a body that does not have this root at all, which is still an error.
  if (typeof rootNode === "string" && rootNode.trim() === "") return [];
  const root = rootNode as Record<string, unknown>;
  if (!root || typeof root !== "object") {
    throw new DebugXmlParseError(
      "parseBreakpointsResponse: expected root <dbg:breakpoints> element",
      xmlText,
    );
  }
  const rows = toArray<Row>(root.breakpoint);
  return rows.map((row): CreatedBreakpoint | BreakpointError => {
    if (row.errorMessage !== undefined) {
      return { kind: str(row.kind), clientId: row.clientId, errorMessage: row.errorMessage };
    }
    const common = {
      id: str(row.id),
      clientId: row.clientId,
      skipCount: optNum(row.skipCount),
      condition: row.condition,
      validationOnly: row.validationOnly === undefined ? undefined : row.validationOnly === "true",
    };
    switch (row.kind) {
      case "exception":
        return { ...common, kind: "exception", exceptionClass: str(row.exceptionClass) };
      case "statement":
        return { ...common, kind: "statement", statement: str(row.statement) };
      case "message":
        return {
          ...common,
          kind: "message",
          msgId: str(row.msgId),
          msgNo: str(row.msgNo),
          msgTy: str(row.msgTy),
        };
      case "line":
      default:
        return { ...common, kind: "line", uri: str(row.uri) };
    }
  });
}

// ---------------------------------------------------------------------------
// The `asx:abap` family — variables / child variables / debuggee
// ---------------------------------------------------------------------------

function parseVariableRow(row: Row): DebugVariable {
  return {
    id: str(row.ID),
    name: str(row.NAME),
    declaredTypeName: str(row.DECLARED_TYPE_NAME),
    actualTypeName: str(row.ACTUAL_TYPE_NAME),
    kind: str(row.KIND),
    instantiationKind: str(row.INSTANTIATION_KIND),
    accessKind: str(row.ACCESS_KIND),
    // DebugMetaType is deliberately open-ended — pass through whatever the server sends rather
    // than validating against the known union.
    metaType: str(row.META_TYPE) as DebugMetaType,
    parameterKind: str(row.PARAMETER_KIND),
    // BYTE-EXACT: VALUE carries CHAR padding (which IS the value) and P/I's trailing sign column;
    // HEX_VALUE is raw. Nothing here trims or converts — see parseAbapNumeric / decodeHexValue.
    value: str(row.VALUE),
    hexValue: str(row.HEX_VALUE),
    // `X` family, live-proven; false is the self-closing `<READ_ONLY/>`.
    readOnly: xBool(row.READ_ONLY),
    technicalType: str(row.TECHNICAL_TYPE),
    length: num(row.LENGTH),
    tableBody: str(row.TABLE_BODY),
    tableLines: optNum(row.TABLE_LINES),
    // Family UNDETERMINED — all 87 captured rows are self-closing-empty, zero truthy samples.
    // abapFlag accepts both X and true rather than asserting a family we cannot prove.
    isValueIncomplete: abapFlag(row.IS_VALUE_INCOMPLETE),
    isException: abapFlag(row.IS_EXCEPTION),
    inheritanceLevel: num(row.INHERITANCE_LEVEL),
    inheritanceClass: str(row.INHERITANCE_CLASS),
  };
}

/** `Object.keys` minus fast-xml-parser's synthetic `#text` (inter-element whitespace, see `trimValues`). */
function elementKeys(node: Record<string, unknown>): string[] {
  return Object.keys(node).filter((k) => k !== "#text");
}

/**
 * `getVariables` nests rows directly under `<DATA>` (`DATA.STPDA_ADT_VARIABLE`), no wrapper — a
 * different depth than `getChildVariables` (see `parseChildVariablesResponse`), which is why these
 * stay separate functions instead of one generic parser.
 *
 * **Empty results are normal**: some ids answer HTTP 200 with a zero-byte body and no
 * `content-type` — that parses to `[]`, not a thrown error.
 *
 * **The response is NOT positionally aligned with the request** — the server can silently drop
 * unresolvable ids, and `NAME` is not unique. Callers must key off `ID`, never index or `NAME` —
 * see `indexVariablesById` / `alignRequestedVariables` below.
 */
export function parseVariablesResponse(xmlText: string): DebugVariable[] {
  if (isEmptyBody(xmlText)) return [];
  const parsed = parser.parse(xmlText) as Record<string, unknown>;
  const root = parsed.abap as Record<string, unknown>;
  const values = root?.values as Record<string, unknown> | undefined;
  const data = values?.DATA as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") {
    throw new DebugXmlParseError(
      "parseVariablesResponse: expected <asx:abap><asx:values><DATA> envelope",
      xmlText,
    );
  }
  if (data.STPDA_ADT_VARIABLE === undefined) {
    throw new DebugXmlParseError(
      "parseVariablesResponse: expected <DATA><STPDA_ADT_VARIABLE> rows, but <DATA> contains only " +
        `[${elementKeys(data).join(", ")}] — this looks like a getChildVariables response fed to ` +
        "the getVariables parser",
      xmlText,
    );
  }
  return toArray<Row>(data.STPDA_ADT_VARIABLE).map(parseVariableRow);
}

/**
 * Key parsed rows by their wire `ID` — the only safe way to match a response to a request (`NAME`
 * is not unique, position is not stable; see `parseVariablesResponse`). A duplicate `ID` would be
 * a wire shape never seen; the first row wins rather than silently merging, so a caller comparing
 * `map.size` to `rows.length` can detect it.
 */
export function indexVariablesById(rows: readonly DebugVariable[]): Map<string, DebugVariable> {
  const map = new Map<string, DebugVariable>();
  for (const row of rows) {
    if (!map.has(row.id)) map.set(row.id, row);
  }
  return map;
}

/**
 * Line a `getVariables` response up against the ids that were actually requested, keeping "the
 * server did not resolve this id" (no element at all) distinguishable from "resolved to an empty
 * value" (an element whose `VALUE` is e.g. ten spaces).
 *
 * `resolved` is in request order and holds only ids the server answered. `missing` is every
 * requested id with no row. `unexpected` is any returned row whose id was not requested (never
 * observed; surfaced rather than dropped, since dropping it is how a positional bug hides).
 */
export function alignRequestedVariables(
  requestedIds: readonly string[],
  rows: readonly DebugVariable[],
): { resolved: DebugVariable[]; missing: string[]; unexpected: DebugVariable[] } {
  const byId = indexVariablesById(rows);
  const requested = new Set(requestedIds);
  const resolved: DebugVariable[] = [];
  const missing: string[] = [];
  for (const id of requestedIds) {
    const row = byId.get(id);
    if (row) resolved.push(row);
    else missing.push(id);
  }
  const unexpected = rows.filter((r) => !requested.has(r.id));
  return { resolved, missing, unexpected };
}

/**
 * `getChildVariables` nests one level deeper than `getVariables`: `DATA.VARIABLES.STPDA_ADT_VARIABLE`
 * plus a sibling `DATA.HIERARCHIES.STPDA_ADT_VARIABLE_HIERARCHY`. Same row shape as
 * `parseVariablesResponse`, different envelope depth — see that function for why they stay
 * separate. Both `VARIABLES` and `HIERARCHIES` are required on `<DATA>`; either missing throws
 * rather than returning a half-populated result.
 *
 * `VARIABLES` may legitimately self-close to `[]` (scope-discovery responses return hierarchy rows
 * only), and an entirely empty body is also a normal empty result — see `isEmptyBody`.
 *
 * `KIND` is not stable across call paths: the same variable is `unknown` via `getVariables` but
 * `variable`/`parameter` via `getChildVariables`.
 */
export function parseChildVariablesResponse(xmlText: string): ChildVariablesResult {
  if (isEmptyBody(xmlText)) return { hierarchies: [], variables: [] };
  const parsed = parser.parse(xmlText) as Record<string, unknown>;
  const root = parsed.abap as Record<string, unknown>;
  const values = root?.values as Record<string, unknown> | undefined;
  const data = values?.DATA as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") {
    throw new DebugXmlParseError(
      "parseChildVariablesResponse: expected <asx:abap><asx:values><DATA> envelope",
      xmlText,
    );
  }
  if (data.VARIABLES === undefined || data.HIERARCHIES === undefined) {
    throw new DebugXmlParseError(
      "parseChildVariablesResponse: expected <DATA><VARIABLES> and <DATA><HIERARCHIES>, but " +
        `<DATA> contains only [${elementKeys(data).join(", ")}] — this looks like a getVariables ` +
        "response fed to the getChildVariables parser",
      xmlText,
    );
  }
  const hierarchiesNode = data.HIERARCHIES as Record<string, unknown> | undefined;
  const hierarchies: DebugVariableHierarchy[] = toArray<Row>(
    hierarchiesNode?.STPDA_ADT_VARIABLE_HIERARCHY,
  ).map((r) => ({
    parentId: str(r.PARENT_ID),
    childId: str(r.CHILD_ID),
    childName: str(r.CHILD_NAME),
  }));
  const variablesNode = data.VARIABLES as Record<string, unknown> | undefined;
  const variables = toArray<Row>(variablesNode?.STPDA_ADT_VARIABLE).map(parseVariableRow);
  return { hierarchies, variables };
}

function parseDebuggeeKind(raw: string | undefined): DebuggeeKind {
  switch ((raw ?? "").toUpperCase()) {
    case "DEBUGGEE":
      return "debuggee";
    case "POSTMORTEM":
      return "postmortem";
    case "POSTMORTEM_DIALOG":
      return "postmortem_dialog";
    default:
      throw new DebugXmlParseError(
        `parseDebuggeeResponse: unrecognised DBGEE_KIND "${raw ?? ""}"`,
        raw ?? "",
      );
  }
}

/**
 * The listener/debuggee body (`asx:abap` family). Covers both a live, attachable debuggee and a
 * caught short-dump (postmortem).
 *
 * `isAttachable = NOT IS_ATTACH_IMPOSSIBLE` — get this backwards and every debuggee looks
 * attachable except the ones that actually are.
 *
 * `STPDA_DEBUGGEE` does NOT use the ABAP `X`/blank convention — it's the `"true"`/`"false"` string
 * family (live-proven), read via `abapFlag`. `xBool` would silently make `isSameServer` always
 * false; see archive. The `X` family is still real elsewhere in the same envelope (`READ_ONLY`,
 * `IS_LOCAL`), which is why `xBool` exists at all.
 */
export function parseDebuggeeResponse(xmlText: string): Debuggee {
  const parsed = parser.parse(xmlText) as Record<string, unknown>;
  const root = parsed.abap as Record<string, unknown>;
  const values = root?.values as Record<string, unknown> | undefined;
  const data = values?.DATA as Record<string, unknown> | undefined;
  const row = data?.STPDA_DEBUGGEE as Row | undefined;
  if (!row || typeof row !== "object") {
    throw new DebugXmlParseError(
      "parseDebuggeeResponse: expected <asx:abap><asx:values><DATA><STPDA_DEBUGGEE> envelope",
      xmlText,
    );
  }
  return {
    id: str(row.DEBUGGEE_ID),
    kind: parseDebuggeeKind(row.DBGEE_KIND),
    client: num(row.CLIENT),
    // TERMINAL_ID/IDE_ID/INCL_CURR are absent from the postmortem fixture despite Debuggee
    // declaring them required — a post-mortem debuggee was never attached via a terminal.
    // Defaulted rather than thrown; needs live confirmation this is intentional.
    terminalId: str(row.TERMINAL_ID),
    ideId: str(row.IDE_ID),
    user: str(row.DEBUGGEE_USER),
    program: str(row.PRG_CURR),
    include: str(row.INCL_CURR),
    line: num(row.LINE_CURR),
    rfcDest: row.RFCDEST,
    applServer: row.APPLSERVER,
    sysId: row.SYSID,
    sysNr: optNum(row.SYSNR),
    timestamp: optNum(row.TSTMP),
    // Negative-flag inversion — see the doc comment above and on Debuggee.isAttachable in types.ts.
    isAttachable: !abapFlag(row.IS_ATTACH_IMPOSSIBLE),
    isSameServer: abapFlag(row.IS_SAME_SERVER),
    instanceName: row.INSTANCE_NAME,
    dumpId: row.DUMP_ID,
    dumpDate: row.DUMP_DATE,
    dumpTime: row.DUMP_TIME,
    dumpHost: row.DUMP_HOST,
    dumpUser: row.DUMP_UNAME,
    dumpClient: row.DUMP_CLIENT,
    dumpUri: row.DUMP_URI,
  };
}

// ---------------------------------------------------------------------------
// IsComplexType / DebugMetaType
// ---------------------------------------------------------------------------

const SCALAR_LIKE_META_TYPES: ReadonlySet<string> = new Set([
  "simple",
  "string",
  "boxedcomp",
  "anonymcomp",
  "unknown",
]);

/**
 * "Can I expand this?" — a NEGATIVE test: everything not in the known scalar-like set counts as
 * complex, including a value the server introduces later that isn't in the declared union. Takes
 * `string`, not `DebugMetaType`, so an unrecognised value is treated as complex (the safe default)
 * rather than throwing.
 */
export function isComplexType(metaType: string): boolean {
  return !SCALAR_LIKE_META_TYPES.has(metaType);
}

// ---------------------------------------------------------------------------
// `<exc:exception>` envelope parsing
// ---------------------------------------------------------------------------

/**
 * Parse a raw ADT error body into the structured `AdtError` shape declared in `types.ts`.
 * `status`/`path` come from the caller, which owns the HTTP round trip. Still pure.
 *
 * Never `includes()`/substring-match `.message` — bodies run up to 165 KB and a literal like
 * "404" can appear in a line number. Discriminate on `status`/`subtype` only, via
 * `isConflict` / `isSessionExpired` / `isNoSessionAttached` below.
 */
/**
 * ABAP exception class raised when the debug session itself has ended (any call after
 * `terminateDebuggee`, or SAP's idle timeout). Match on this class name, not on response prose —
 * the appliance answers in the logon language, so an English substring is not a discriminator.
 */
export const DEBUG_SESSION_ENDED_CLASS = "CX_TPDA_SYS_COMM_DBGSESSIONEND";

/**
 * A second dead-session class name: `getStack` against a released session answers `500 AdiFailed`
 * with this as `previous2ExceptionClassName` (subType `getStack`) — "slave not connected" means
 * the debuggee work process is gone. Same condition as `DEBUG_SESSION_ENDED_CLASS`, different call
 * path (`terminateDebuggee` reports the other class name for the same session).
 */
export const DEBUG_SLAVE_NOT_CONNECTED_CLASS = "CX_TPDA_SYS_COMM_SLAVENOTCONN";

/**
 * A third dead-session class name, behind a zombie-`suspended`-session bug: reachable only via the
 * `previous1ExceptionClassName` key (no top-level `exceptionClassName`, no `subType` at all), so
 * before this constant existed such a response matched nothing and the session stayed `suspended`
 * forever. Raised by `CL_TPDAPI_SERVICE` rather than the `CX_TPDA_SYS_COMM_*` layer, but reports
 * the same condition. See archive for the full incident (`042-step-after-terminate.xml`).
 */
export const DEBUGGEE_ENDED_CLASS = "CX_TPDAPI_DEBUGGEE_ENDED";

/**
 * Every ABAP exception class meaning "this debug session no longer exists" — exact match only,
 * never a prefix test (see `classifyDebugSessionFailure` for what an unmatched `500 AdiFailed`
 * should do instead).
 *
 * `CX_TPDAPI_FAILURE` is deliberately excluded: it's the generic ADI wrapper and appears on both
 * successful and failed terminates, so it carries no liveness signal.
 *
 * `CX_TPDA_SYS_COMM_TIMEOUT` is also deliberately excluded — it occurs in zero live captures, only
 * in hand-written test literals; a prior note claiming it as canonical was speculative and wrong.
 * Adding an unobserved class name here would be guessing. See archive for the full capture list.
 */
export const DEBUG_SESSION_GONE_CLASSES: readonly string[] = [
  DEBUG_SESSION_ENDED_CLASS,
  DEBUG_SLAVE_NOT_CONNECTED_CLASS,
  DEBUGGEE_ENDED_CLASS,
];

/**
 * Three-valued answer to "is the debug session still there?":
 *   - `"gone"` — proven dead by exact class-name match or `isSessionDeath`; caller may go straight
 *     to `dead`/`SESSION_DEAD`.
 *   - `"unknown"` — a `500 AdiFailed` this module has never seen before; may be alive, may be dead.
 *   - `"intact"` — failure unrelated to session liveness (`409` conflict, pre-attach
 *     `noSessionAttached`, `404`, auth failure, …).
 *
 * A forced guess for the unknown case is what produced the zombie-session bug in the first place
 * (see `DEBUGGEE_ENDED_CLASS`) — `"unknown"` reports what's actually known and leaves recovery
 * policy to the caller.
 *
 * NOT YET WIRED IN — `src/debug/session.ts` and `src/tools/debug.ts` own the state machine and
 * don't consume this classifier yet.
 */
export type DebugSessionLiveness = "gone" | "unknown" | "intact";

export function classifyDebugSessionFailure(e: {
  status: number;
  abapType?: string;
  subtype?: string;
  bodyExcerpt?: string;
  exceptionClassNames?: readonly string[];
}): DebugSessionLiveness {
  if (isSessionExpired(e as Parameters<IsSessionExpired>[0])) return "gone";
  // A 500 AdiFailed means the ADI layer failed the call. Every capture so far meant the session
  // was gone, but the class-name list is demonstrably incomplete (grew twice), so an unrecognised
  // one is "unknown" rather than assumed either way. noSessionAttached is excluded — it's the
  // normal pre-attach answer.
  if (e.status === 500 && e.abapType === "AdiFailed" && e.subtype !== "noSessionAttached") {
    return "unknown";
  }
  return "intact";
}

/** `exceptionClassName`, `previousExceptionClassName`, `previous2ExceptionClassName`, … */
const EXCEPTION_CLASS_KEY = /exceptionclassname$/i;
/** An ABAP class name, and nothing else — this is what keeps the field bounded. */
const ABAP_CLASS_NAME = /^[A-Z0-9_/]{1,60}$/;
const MAX_EXCEPTION_CLASS_NAMES = 8;

/**
 * Lift the `…ExceptionClassName` entries out of an `<exc:exception>` property map. Shared by both
 * `AdtError` builders (this file's `parseAdtError`, and `transport.ts`'s
 * `adtErrorFromException`) so the two paths can't classify the same wire error differently.
 *
 * Bounded to `MAX_EXCEPTION_CLASS_NAMES` entries, each validated as ABAP-class-name-shaped —
 * bodies can be 165 KB and must never be held or logged wholesale.
 */
export function collectExceptionClassNames(
  properties: Record<string, string> | undefined,
): string[] {
  if (!properties) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (!EXCEPTION_CLASS_KEY.test(key)) continue;
    const name = String(value ?? "").trim().toUpperCase();
    if (!ABAP_CLASS_NAME.test(name)) continue;
    if (out.includes(name)) continue;
    out.push(name);
    if (out.length >= MAX_EXCEPTION_CLASS_NAMES) break;
  }
  return out;
}

export function parseAdtError(body: string, status: number, path: string): AdtError {
  const bodyExcerpt = truncateDiagnosticBody(body);
  const trimmed = body.trim();
  if (!trimmed) {
    return { status, message: `HTTP ${status}`, path, bodyExcerpt };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(body) as Record<string, unknown>;
  } catch {
    // Not XML (an HTML ICF page, a stack trace, …) — report what we can without throwing.
    return { status, message: truncateText(trimmed, MESSAGE_EXCERPT_MAX), path, bodyExcerpt };
  }

  const root = parsed.exception as Record<string, unknown> | undefined;
  if (!root || typeof root !== "object") {
    return { status, message: truncateText(trimmed, MESSAGE_EXCERPT_MAX), path, bodyExcerpt };
  }

  const properties: Record<string, string> = {};
  const propertiesNode = root.properties as Record<string, unknown> | undefined;
  for (const entry of toArray<Row & { key?: string }>(propertiesNode?.entry)) {
    // Trimmed explicitly: these are ADI identifiers/prose compared for exact equality
    // (isConflict/isNoSessionAttached), not fixed-width ABAP data — and the wire does pad some
    // values, which trimValues:false would otherwise leave in place.
    if (entry.key !== undefined) properties[entry.key] = str(entry["#text" as keyof Row]).trim();
  }

  const typeNode = root.type as Record<string, unknown> | undefined;
  const abapType = typeof typeNode?.id === "string" ? typeNode.id : undefined;
  const message = textOf(root.message) ?? `HTTP ${status}`;

  // From the full parsed body, never from bodyExcerpt (which is cut for display) — so a marker
  // past the truncation boundary still classifies correctly.
  const exceptionClassNames = collectExceptionClassNames(properties);

  return {
    status,
    subtype: properties["com.sap.adt.communicationFramework.subType"],
    abapType,
    message,
    path,
    bodyExcerpt,
    ...(exceptionClassNames.length ? { exceptionClassNames } : {}),
  };
}

/**
 * This file is the single home for `isConflict`/`isSessionExpired`/`isNoSessionAttached` —
 * `transport.ts` imports them from here rather than keeping its own copy (the two implementations
 * were not identical; see archive for what was kept vs. dropped, per predicate, and why).
 */
// Broader than transport.ts's original (`conflictDetected` only): a client DISPLACED by a
// takeover gets `conflictNotification` on its blocked long-poll — dropping it would hide that
// half of the conflict protocol.
export const isConflict: IsConflict = (e) =>
  e.subtype === "conflictDetected" || e.subtype === "conflictNotification";

/**
 * Matches on `isSessionDeath` (the ABAP session itself being destroyed — a short-dump or explicit
 * session-timeout) OR an `exceptionClassNames` entry in `DEBUG_SESSION_GONE_CLASSES` OR
 * `subtype === "debuggeeEnded"`.
 *
 * Deliberately not a bare `status === 401` check — that's `AUTH_FAILED` territory, handled by
 * `translateDebugError`'s own later branch; conflating the two would make that branch dead code
 * (see archive for why `isSessionDeath` and 401 answer genuinely different questions).
 *
 * The `exceptionClassNames` and `debuggeeEnded` clauses were each added after a live incident
 * where the existing checks missed a real dead-session response and left the state machine stuck
 * in `suspended` forever (a "zombie" session) — see archive for the three separate incidents
 * (`042-step-after-terminate.xml`, and a 2026-08-12 `ZDBGFIX_EXC` capture) and exactly what each
 * was missing. `autoAttachTimeout` is deliberately NOT included: it has never been live-captured,
 * so `classifyDebugSessionFailure`'s `"unknown"` is the honest answer for it instead.
 */
export const isSessionExpired: IsSessionExpired = (e) =>
  isSessionDeath({ status: e.status, body: e.bodyExcerpt }) ||
  (e.exceptionClassNames?.some((n) => DEBUG_SESSION_GONE_CLASSES.includes(n)) ?? false) ||
  e.subtype === "debuggeeEnded";

/**
 * Narrower than transport.ts's original, deliberately: `subtype === "noSessionAttached"` only.
 * transport.ts additionally treated any `(500, AdiFailed)` pair as `noSessionAttached`, which
 * would misclassify "your debuggee already ended" (`debuggeeEnded`) as the normal pre-attach
 * state — a worse failure mode than occasionally missing a malformed-body classification.
 */
export const isNoSessionAttached: IsNoSessionAttached = (e) => e.subtype === "noSessionAttached";

/**
 * ARCH-09 §5.5/P6 — "the debuggee ran to completion" specifically, as opposed to the other
 * session-gone shapes `isSessionExpired` also covers. Subtype-only, same reasoning as
 * `isNoSessionAttached`. Lets `translateDebugError` say "the program finished" instead of
 * forwarding the generic ADI wrapper text, which reads like a crash.
 */
export const isDebuggeeEnded = (e: { subtype?: string }): boolean => e.subtype === "debuggeeEnded";

// ---------------------------------------------------------------------------
// The batch endpoint
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split `"HEADERS\r\n\r\nBODY"` (or bare `"\n\n"`) at the boundary's actual matched length — an
 * earlier implementation hardcodes a 4-byte advance even for the 2-byte `"\n\n"` form, truncating
 * the first two body bytes.
 */
function splitHeadBody(msg: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(msg);
  if (!m) return { head: msg, body: "" };
  return { head: msg.slice(0, m.index), body: msg.slice(m.index + m[0].length) };
}

function parseHeaderBlock(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

/**
 * Parse the `multipart/mixed` reply from `POST /sap/bc/adt/debugger/batch` into one `BatchResult`
 * per sub-request, in wire order — walks both the MIME boundary and the embedded HTTP status line
 * in each part.
 *
 * Reads the embedded status line and reports it verbatim, unlike a naive parser, which hardcodes
 * `StatusCode: 200` for every part and so hides a sub-request that actually failed.
 */
export function parseBatchResponse(raw: string): BatchResult[] {
  const boundaryMatch = /^--(\S+)/m.exec(raw);
  if (!boundaryMatch) {
    throw new DebugXmlParseError("parseBatchResponse: no multipart boundary found", raw);
  }
  const boundary = boundaryMatch[1]!;
  const delimiter = new RegExp(`--${escapeRegExp(boundary)}(?:--)?`);

  const results: BatchResult[] = [];
  for (const rawPart of raw.split(delimiter)) {
    const part = rawPart.replace(/^\r?\n/, "");
    if (!part.trim()) continue; // preamble / epilogue / the empty tail after the closing "--"

    const { head: mimeHead, body: mimeBody } = splitHeadBody(part);
    const mimeHeaders = parseHeaderBlock(mimeHead);
    const mimeContentType = mimeHeaders["content-type"];
    if (mimeContentType && !mimeContentType.includes("application/http")) {
      // Not an embedded HTTP sub-response — skip rather than guess at a shape we don't recognise.
      continue;
    }

    const { head: httpHead, body: httpBody } = splitHeadBody(mimeBody);
    const httpLines = httpHead.split(/\r?\n/);
    const statusLine = httpLines[0] ?? "";
    const statusMatch = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
    if (!statusMatch) {
      throw new DebugXmlParseError(
        `parseBatchResponse: sub-response is missing an HTTP status line (got "${statusLine}")`,
        part,
      );
    }
    const httpHeaders = parseHeaderBlock(httpLines.slice(1).join("\n"));

    results.push({
      status: Number(statusMatch[1]),
      contentType: httpHeaders["content-type"],
      body: httpBody.replace(/\r?\n$/, ""),
    });
  }
  return results;
}
