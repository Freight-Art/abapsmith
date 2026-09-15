/**
 * Invariant: a body carrying an `error` key must never come
 * back with `isError` false/unset. Drives every taxonomy code (extracted
 * from source text, not hand-transcribed) through the real `errorResult`,
 * plus non-AbapError throws.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { errorResult } from "../src/server.js";
import { AbapError, type AbapErrorCode } from "../src/adt/errors.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

function extractAbapErrorCodes(): string[] {
  const raw = readFileSync(resolve(SRC, "adt", "errors.ts"), "utf8");
  // Doc comments on union members contain prose semicolons, so strip block
  // comments first — otherwise the terminating `;` search below stops early.
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const start = text.indexOf("export type AbapErrorCode =");
  if (start === -1) throw new Error("AbapErrorCode union not found");
  const end = text.indexOf(";", start);
  const block = text.slice(start, end);
  const codes = [...block.matchAll(/\|\s*"([A-Z0-9_]+)"/g)].map((m) => m[1]!);
  return codes;
}

const CODES = extractAbapErrorCodes();

function envelope(res: CallToolResult): Record<string, unknown> {
  const text = (res.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

/** v1's JSON `error` key. */
function bodyHasErrorKey(res: CallToolResult): boolean {
  const text = (res.content[0] as { type: "text"; text: string }).text;
  const body = JSON.parse(text);
  return Object.prototype.hasOwnProperty.call(body, "error");
}

describe("invariant — error key implies isError:true", () => {
  it("extracted a plausible full taxonomy, not a truncated/broken regex match", () => {
    expect(CODES.length).toBeGreaterThanOrEqual(40);
    expect(new Set(CODES).size).toBe(CODES.length);
  });

  it("contains the nine codes this invariant calls out by name", () => {
    const required = [
      "BAD_INPUT",
      "NOT_FOUND",
      "SAFETY_DENIED",
      "CHECK_FAILED",
      "TRANSPORT_ERROR",
      "UNSUPPORTED",
      "ADT_ERROR",
      "AMBIGUOUS",
      "RUNTIME_DUMP",
    ];
    for (const code of required) expect(CODES).toContain(code);
  });

  const corpus: CallToolResult[] = [];

  it("drives every extracted AbapErrorCode through errorResult with isError:true and body.error === code", () => {
    for (const code of CODES) {
      const e = new AbapError(code as AbapErrorCode, "test message");
      const res = errorResult(e);
      corpus.push(res);
      expect(res.isError, `code ${code}`).toBe(true);
      const body = envelope(res);
      expect(Object.prototype.hasOwnProperty.call(body, "error"), `code ${code}`).toBe(true);
      expect(body.error, `code ${code}`).toBe(code);
    }
    expect(corpus.length).toBe(CODES.length);
  });

  it("a raw Error, a string throw, and undefined all yield isError:true with an error key", () => {
    for (const thrown of [new Error("boom"), "just a string", undefined]) {
      const res = errorResult(thrown);
      corpus.push(res);
      expect(res.isError).toBe(true);
      const body = envelope(res);
      expect(typeof body.error).toBe("string");
      expect(body.error).toBeTruthy();
    }
  });

  it("across the whole corpus built above: bodyHasErrorKey(res) implies res.isError === true", () => {
    expect(corpus.length).toBeGreaterThan(0);
    for (const res of corpus) {
      if (bodyHasErrorKey(res)) {
        expect(res.isError).toBe(true);
      }
    }
  });
});
