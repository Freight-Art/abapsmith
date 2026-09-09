/**
 * Parses a fluid tool's console output (BEGIN/OUT/OUTC/OUTE/ERR/END lines)
 * into structured frames. Grammar: `ZMCP-H>` + name + one space + payload.
 * OUTC/OUTE fragments concatenate with no separator, so payload whitespace is never trimmed — a break can fall inside a JSON string.
 */
import { AbapError } from "../errors.js";
import { truncateText } from "../../truncate.js";

export const FLUID_FRAME_PREFIX = "ZMCP-H>";

export interface FluidBeginFrame {
  readonly id: string;
  readonly ver: string;
  readonly action: string;
  readonly contract: string;
}

export interface FluidErrFrame {
  readonly kind: "subrc" | "exception" | "message";
  readonly step: string;
  readonly subrc?: number;
  readonly msgid?: string;
  readonly msgno?: number;
  readonly msgv?: readonly string[];
  readonly text: string;
}

export interface FluidEndFrame {
  readonly rc: number;
  readonly outBytes: number;
  readonly truncated: boolean;
  readonly ms: number;
}

export interface FluidDroppedValue {
  readonly raw: string;
  readonly lineNumber: number;
}

export interface FluidTranscript {
  readonly begin: FluidBeginFrame | undefined;
  readonly values: readonly unknown[];
  readonly errors: readonly FluidErrFrame[];
  readonly end: FluidEndFrame | undefined;
  readonly stray: readonly string[];
  readonly dropped: readonly FluidDroppedValue[];
}

const FRAME_NAMES: ReadonlySet<string> = new Set(["BEGIN", "OUT", "OUTC", "OUTE", "ERR", "END"]);
const ERR_KINDS: ReadonlySet<string> = new Set(["subrc", "exception", "message"]);
const LINE_EXCERPT_MAX = 200;

function protocolError(message: string, lineNumber: number, lineText: string): AbapError {
  const excerpt = truncateText(lineText, LINE_EXCERPT_MAX);
  return new AbapError(
    "FLUID_PROTOCOL_ERROR",
    `${message} (line ${lineNumber}: "${excerpt}")`,
    { line: lineNumber, text: excerpt },
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJsonPayload(payload: string, what: string, lineNumber: number, lineText: string): unknown {
  try {
    return JSON.parse(payload);
  } catch (e) {
    throw protocolError(
      `${what} payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      lineNumber,
      lineText,
    );
  }
}

function parseBegin(payload: string, lineNumber: number, lineText: string): FluidBeginFrame {
  const parsed = parseJsonPayload(payload, "BEGIN", lineNumber, lineText);
  if (!isPlainObject(parsed)) {
    throw protocolError("BEGIN payload is not a JSON object", lineNumber, lineText);
  }
  const bad: string[] = [];
  for (const field of ["id", "ver", "action", "contract"] as const) {
    if (typeof parsed[field] !== "string") bad.push(field);
  }
  if (bad.length > 0) {
    throw protocolError(
      `BEGIN payload is missing or has a non-string value for: ${bad.join(", ")}`,
      lineNumber,
      lineText,
    );
  }
  return {
    id: parsed["id"] as string,
    ver: parsed["ver"] as string,
    action: parsed["action"] as string,
    contract: parsed["contract"] as string,
  };
}

function parseEnd(payload: string, lineNumber: number, lineText: string): FluidEndFrame {
  const parsed = parseJsonPayload(payload, "END", lineNumber, lineText);
  if (!isPlainObject(parsed)) {
    throw protocolError("END payload is not a JSON object", lineNumber, lineText);
  }
  const bad: string[] = [];
  for (const field of ["rc", "outBytes", "ms"] as const) {
    const v = parsed[field];
    if (typeof v !== "number" || !Number.isFinite(v)) bad.push(field);
  }
  if (typeof parsed["truncated"] !== "boolean") bad.push("truncated");
  if (bad.length > 0) {
    throw protocolError(`END payload has an invalid value for: ${bad.join(", ")}`, lineNumber, lineText);
  }
  return {
    rc: parsed["rc"] as number,
    outBytes: parsed["outBytes"] as number,
    truncated: parsed["truncated"] as boolean,
    ms: parsed["ms"] as number,
  };
}

function parseErr(payload: string, lineNumber: number, lineText: string): FluidErrFrame {
  const parsed = parseJsonPayload(payload, "ERR", lineNumber, lineText);
  if (!isPlainObject(parsed)) {
    throw protocolError("ERR payload is not a JSON object", lineNumber, lineText);
  }
  const kind = parsed["kind"];
  if (typeof kind !== "string" || !ERR_KINDS.has(kind)) {
    throw protocolError(
      `ERR payload has an invalid "kind" (must be "subrc", "exception", or "message")`,
      lineNumber,
      lineText,
    );
  }
  if (typeof parsed["step"] !== "string") {
    throw protocolError(`ERR payload's "step" field must be a string`, lineNumber, lineText);
  }
  if (typeof parsed["text"] !== "string") {
    throw protocolError(`ERR payload's "text" field must be a string`, lineNumber, lineText);
  }
  if (parsed["subrc"] !== undefined && typeof parsed["subrc"] !== "number") {
    throw protocolError(`ERR payload's "subrc" field must be a number`, lineNumber, lineText);
  }
  if (parsed["msgid"] !== undefined && typeof parsed["msgid"] !== "string") {
    throw protocolError(`ERR payload's "msgid" field must be a string`, lineNumber, lineText);
  }
  if (parsed["msgno"] !== undefined && typeof parsed["msgno"] !== "number") {
    throw protocolError(`ERR payload's "msgno" field must be a number`, lineNumber, lineText);
  }
  const msgv = parsed["msgv"];
  if (msgv !== undefined && (!Array.isArray(msgv) || !msgv.every((x) => typeof x === "string"))) {
    throw protocolError(`ERR payload's "msgv" field must be an array of strings`, lineNumber, lineText);
  }
  return {
    kind: kind as "subrc" | "exception" | "message",
    step: parsed["step"] as string,
    text: parsed["text"] as string,
    ...(parsed["subrc"] !== undefined ? { subrc: parsed["subrc"] as number } : {}),
    ...(parsed["msgid"] !== undefined ? { msgid: parsed["msgid"] as string } : {}),
    ...(parsed["msgno"] !== undefined ? { msgno: parsed["msgno"] as number } : {}),
    ...(msgv !== undefined ? { msgv: msgv as readonly string[] } : {}),
  };
}

interface FrameLine {
  readonly name: string;
  readonly payload: string;
  readonly lineNumber: number;
  readonly lineText: string;
}

function splitFrame(line: string, lineNumber: number): FrameLine {
  const rest = line.slice(FLUID_FRAME_PREFIX.length);
  const spaceIdx = rest.indexOf(" ");
  if (spaceIdx === -1) {
    return { name: rest, payload: "", lineNumber, lineText: line };
  }
  return { name: rest.slice(0, spaceIdx), payload: rest.slice(spaceIdx + 1), lineNumber, lineText: line };
}

function hasErrFrame(rawLines: readonly string[]): boolean {
  for (const raw of rawLines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith(FLUID_FRAME_PREFIX)) continue;
    if (splitFrame(line, 0).name === "ERR") return true;
  }
  return false;
}

/**
 * `begin`/`end` come back `undefined` (never throw) when the frame is simply
 * absent from an otherwise-consistent transcript. Dispatch relies on this to
 * tell "the ABAP short-dumped before printing anything" (no BEGIN, no END)
 * apart from "the ABAP ran and reported failure" (an END with a nonzero rc,
 * or ERR frames present).
 */
export function parseFluidConsole(consoleText: string): FluidTranscript {
  const rawLines = consoleText.split("\n");

  const hasErr = hasErrFrame(rawLines);

  let begin: FluidBeginFrame | undefined;
  let end: FluidEndFrame | undefined;
  const values: unknown[] = [];
  const errors: FluidErrFrame[] = [];
  const stray: string[] = [];
  const dropped: FluidDroppedValue[] = [];

  let openFragments: string[] | undefined;
  let openAt: FrameLine | undefined;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] ?? "";
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const lineNumber = i + 1;

    if (!line.startsWith(FLUID_FRAME_PREFIX)) {
      if (line.trim() === "") continue;
      stray.push(line);
      continue;
    }

    const frame = splitFrame(line, lineNumber);

    if (!FRAME_NAMES.has(frame.name)) {
      throw protocolError(`Unknown fluid frame name "${frame.name}"`, lineNumber, line);
    }
    if (end !== undefined && frame.name !== "ERR") {
      throw protocolError(`A ${frame.name} frame arrived after END`, lineNumber, line);
    }
    if (frame.name !== "BEGIN" && begin === undefined) {
      throw protocolError(`A ${frame.name} frame arrived before BEGIN`, lineNumber, line);
    }
    if (frame.name === "BEGIN" && begin !== undefined) {
      throw protocolError("A second BEGIN frame arrived", lineNumber, line);
    }

    switch (frame.name) {
      case "BEGIN":
        begin = parseBegin(frame.payload, lineNumber, line);
        break;
      case "OUT":
        values.push(parseJsonPayload(frame.payload, "OUT", lineNumber, line));
        break;
      case "OUTC":
        if (openFragments === undefined) {
          openFragments = [frame.payload];
          openAt = frame;
        } else {
          openFragments.push(frame.payload);
        }
        break;
      case "OUTE": {
        if (openFragments === undefined) {
          throw protocolError("OUTE frame with no open OUTC to close", lineNumber, line);
        }
        openFragments.push(frame.payload);
        const reassembled = openFragments.join("");
        const startAt = openAt;
        try {
          values.push(parseJsonPayload(reassembled, "Reassembled OUTC/OUTE", lineNumber, line));
        } catch (e) {
          if (!hasErr) throw e;
          dropped.push({ raw: reassembled, lineNumber: startAt ? startAt.lineNumber : lineNumber });
        }
        openFragments = undefined;
        openAt = undefined;
        break;
      }
      case "ERR":
        errors.push(parseErr(frame.payload, lineNumber, line));
        break;
      case "END":
        end = parseEnd(frame.payload, lineNumber, line);
        break;
    }
  }

  if (openFragments !== undefined) {
    if (!hasErr) {
      throw protocolError(
        "Unterminated value: OUTC was opened but never closed by OUTE before the input ended",
        openAt ? openAt.lineNumber : rawLines.length,
        openAt ? openAt.lineText : "",
      );
    }
    // An ERR frame means the ABAP already told us what went wrong, so an
    // incomplete value here is a symptom, not the story.
    dropped.push({ raw: openFragments.join(""), lineNumber: openAt ? openAt.lineNumber : rawLines.length });
  }

  return { begin, values, errors, end, stray, dropped };
}
