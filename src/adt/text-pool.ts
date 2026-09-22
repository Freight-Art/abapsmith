/**
 * PROG/P text pool (text symbols + selection texts) over the ADT
 * textelements resource (issue #182) — a sub-resource of the program, not
 * its source, with its own lock/activate lifecycle. Live-confirmed shapes:
 * see `test/fixtures/textelements/provenance.json` and its sibling fixtures.
 * Locking/activating the PROGRAM uri does not work for this resource — both
 * must target the textelements uri itself (adtcore:type PROG/PX on
 * activate).
 */
import { activateObject, type ActivationOutcome } from "./activate.js";
import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import { translateAdtError } from "./session.js";
import type { ResolvedTarget } from "./write.js";
import type { AuthorizedTarget, MutatingOperation } from "../safety.js";

export const TEXTELEMENTS_COLLECTION = "/sap/bc/adt/textelements/programs";
export const TEXTELEMENTS_ACCEPT = "application/vnd.sap.adt.textelements.v1+xml";

const SYMBOLS_MEDIA_TYPE = "application/vnd.sap.adt.textelements.symbols.v1";
const SELECTIONS_MEDIA_TYPE = "application/vnd.sap.adt.textelements.selections.v1";

const SYMBOL_KEY_RE = /^[A-Z0-9]{1,3}$/;
const SELECTION_NAME_RE = /^[A-Z0-9_]{1,8}$/;

export function textPoolUri(programName: string): string {
  return `${TEXTELEMENTS_COLLECTION}/${programName.toLowerCase()}`;
}

export interface TextPoolInput {
  symbols?: Record<string, string>;
  selectionTexts?: Record<string, string>;
}

export interface TextPool {
  symbols: Record<string, string>;
  selectionTexts: Record<string, string>;
}

/** `@MaxLength:N` + `KEY=text` per entry, blank-line separated, uppercased keys. */
export function buildSymbolsBody(symbols: Record<string, string>): string {
  const entries = Object.entries(symbols).map(([rawKey, text]) => {
    const key = rawKey.toUpperCase();
    if (!SYMBOL_KEY_RE.test(key)) {
      throw new AbapError(
        "BAD_INPUT",
        `Text symbol key "${rawKey}" must be 1-3 letters/digits.`,
        { key: rawKey },
      );
    }
    if (text.length === 0 || text.length > 132) {
      throw new AbapError(
        "BAD_INPUT",
        `Text symbol ${key}: text must be 1-132 characters, got ${text.length}.`,
        { key, length: text.length },
      );
    }
    const maxLength = Math.min(Math.max(text.length, 1), 132);
    return `@MaxLength:${maxLength}\n${key}=${text}`;
  });
  return entries.join("\n\n") + "\n";
}

/** `NAME=text` per line, uppercased names. Server pads NAME to 8 chars on read; not done here. */
export function buildSelectionsBody(selectionTexts: Record<string, string>): string {
  return Object.entries(selectionTexts)
    .map(([rawName, text]) => {
      const name = rawName.toUpperCase();
      if (!SELECTION_NAME_RE.test(name)) {
        throw new AbapError(
          "BAD_INPUT",
          `Selection text name "${rawName}" must be 1-8 letters/digits/underscore.`,
          { name: rawName },
        );
      }
      if (text.length === 0 || text.length > 30) {
        throw new AbapError(
          "BAD_INPUT",
          `Selection text ${name}: text must be 1-30 characters, got ${text.length}.`,
          { name, length: text.length },
        );
      }
      return `${name}=${text}\n`;
    })
    .join("");
}

/** Ignores `@MaxLength:` and blank lines; tolerates CRLF; splits at the first `=`. */
export function parseSymbols(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (line.trim() === "" || line.startsWith("@MaxLength:")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

/** Skips entries whose text is exactly `?...` (untexted parameter marker). */
export function parseSelections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (line.trim() === "") continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const name = line.slice(0, idx).trimEnd();
    const text = line.slice(idx + 1);
    if (text === "?...") continue;
    out[name] = text;
  }
  return out;
}

export interface TextPoolWriteResult {
  symbols: number;
  selectionTexts: number;
  language: string;
  activation?: ActivationOutcome;
}

/**
 * Reads the descriptor for `adtcore:masterLanguage`, then locks the
 * textelements uri (NOT the program uri — see module doc), PUTs whichever
 * of symbols/selections were given, unlocks, and — only once the session has
 * fully closed, since activating under your own lock is a 403 — optionally
 * activates the textelements uri itself.
 */
export async function writeTextPool(
  conn: AbapConnection,
  authorized: AuthorizedTarget<MutatingOperation, ResolvedTarget>,
  pool: TextPoolInput,
  opts: { activate: boolean; corrNr?: string },
): Promise<TextPoolWriteResult> {
  if (authorized.op !== "write") {
    throw new AbapError("BAD_INPUT", `Text pool write needs a write authorization, got "${authorized.op}".`);
  }
  const name = authorized.target.name;
  const uri = textPoolUri(name);

  let masterLanguage = "EN";
  try {
    const descriptor = await conn.get(uri, { headers: { Accept: TEXTELEMENTS_ACCEPT } });
    const m = /adtcore:masterLanguage="([^"]*)"/.exec(descriptor.body);
    if (m && m[1] !== undefined) masterLanguage = m[1];
  } catch (e) {
    throw translateAdtError(e, { operation: "write", uri, name, type: "PROG/P" });
  }
  const language = conn.cfg.language || masterLanguage || "EN";

  const symbolsBody = pool.symbols ? buildSymbolsBody(pool.symbols) : undefined;
  const selectionsBody = pool.selectionTexts ? buildSelectionsBody(pool.selectionTexts) : undefined;

  await conn.withStatefulSession(async (session) => {
    const lock = await session.lock(uri);
    const corrNr = opts.corrNr ?? lock.corrNr;
    try {
      if (symbolsBody !== undefined) {
        await conn.put(`${uri}/source/symbols`, {
          headers: { "Content-Type": SYMBOLS_MEDIA_TYPE, Accept: SYMBOLS_MEDIA_TYPE },
          qs: { lockHandle: lock.handle, ...(corrNr ? { corrNr } : {}) },
          body: symbolsBody,
        });
      }
      if (selectionsBody !== undefined) {
        await conn.put(`${uri}/source/selections`, {
          headers: { "Content-Type": SELECTIONS_MEDIA_TYPE, Accept: SELECTIONS_MEDIA_TYPE },
          qs: { lockHandle: lock.handle, ...(corrNr ? { corrNr } : {}) },
          body: selectionsBody,
        });
      }
    } catch (e) {
      throw translateAdtError(e, { operation: "write", uri, name, type: "PROG/P" });
    } finally {
      await session.unlock(uri);
    }
  });

  let activation: ActivationOutcome | undefined;
  if (opts.activate) {
    activation = await activateObject(conn, { name, uri, type: "PROG/PX" });
  }

  return {
    symbols: pool.symbols ? Object.keys(pool.symbols).length : 0,
    selectionTexts: pool.selectionTexts ? Object.keys(pool.selectionTexts).length : 0,
    language,
    activation,
  };
}

/** Two GETs (symbols, selections); `undefined` when both come back empty. Errors propagate. */
export async function readTextPool(conn: AbapConnection, programName: string): Promise<TextPool | undefined> {
  const uri = textPoolUri(programName);
  const symbolsRes = await conn.get(`${uri}/source/symbols`, { headers: { Accept: SYMBOLS_MEDIA_TYPE } });
  const selectionsRes = await conn.get(`${uri}/source/selections`, { headers: { Accept: SELECTIONS_MEDIA_TYPE } });
  const symbols = parseSymbols(symbolsRes.body);
  const selectionTexts = parseSelections(selectionsRes.body);
  if (Object.keys(symbols).length === 0 && Object.keys(selectionTexts).length === 0) return undefined;
  return { symbols, selectionTexts };
}
