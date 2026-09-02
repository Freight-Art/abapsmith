/**
 * Shared truncation helper (review finding 13) — single source of truth for
 * shortening text. ABAP short dumps can run to 165 KB, so an unmarked cut of
 * an HTTP 500 body can hide the one line that explains the failure. No
 * parameter in this API lets a caller suppress the marker.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BODY_DUMP_DIR_ENV } from "./error-capture.js";

/** Error/ADT bodies that may carry an ABAP short dump. */
export const DIAGNOSTIC_BODY_MAX = 20000;
/** Excerpt shown beside a parser error. */
export const PARSE_EXCERPT_MAX = 500;
/** Body text folded into a human-readable error message. */
export const MESSAGE_EXCERPT_MAX = 300;
/** One echoed source/message line. */
export const ECHO_LINE_MAX = 160;
/** Runtime-dump short text. */
export const DUMP_SHORT_TEXT_MAX = 200;

/** Matches any marker this module emits. Exported so tests and callers can detect truncation. */
export const TRUNCATION_MARKER_PATTERN = /… \[truncated, \d+ of \d+ chars shown/;

export function truncationMarker(shown: number, total: number, spillPath?: string): string {
  if (spillPath) {
    return "\n… [truncated, " + shown + " of " + total + " chars shown; full body written to " + spillPath + "]";
  }
  return "\n… [truncated, " + shown + " of " + total + " chars shown]";
}

function toSafeString(text: unknown): string {
  if (text === null || text === undefined) return "";
  if (typeof text === "string") return text;
  return String(text);
}

export function truncateText(text: string, maxChars: number): string {
  const safeText = toSafeString(text);
  const limit = maxChars < 0 ? 0 : maxChars;
  if (safeText.length <= limit) return safeText;
  return safeText.slice(0, limit) + truncationMarker(limit, safeText.length);
}

export function isTruncated(text: string): boolean {
  return TRUNCATION_MARKER_PATTERN.test(toSafeString(text));
}

/** Marker appended by truncateForDisplay. */
export const DISPLAY_ELLIPSIS = "…";

/**
 * For narrow display contexts only (table column, echoed line) where the
 * ~35-char counting marker from `truncateText` would not fit.
 *
 * NEVER use for a response/error/diagnostic body — use `truncateText` /
 * `truncateDiagnosticBody`, which state how much was dropped.
 */
export function truncateForDisplay(text: string, maxChars: number): string {
  const safeText = toSafeString(text);
  const limit = maxChars < 0 ? 0 : maxChars;
  if (safeText.length <= limit) return safeText;
  return safeText.slice(0, limit) + DISPLAY_ELLIPSIS;
}

/** True if `text` ends with the marker `truncateForDisplay` appends. */
export function isDisplayTruncated(text: string): boolean {
  return toSafeString(text).endsWith(DISPLAY_ELLIPSIS);
}

export function truncateDiagnosticBody(body: string, maxChars: number = DIAGNOSTIC_BODY_MAX): string {
  const safeBody = toSafeString(body);
  const limit = maxChars < 0 ? 0 : maxChars;
  if (safeBody.length <= limit) return safeBody;

  const dumpDir = process.env[BODY_DUMP_DIR_ENV];
  if (typeof dumpDir === "string" && dumpDir.length > 0) {
    try {
      mkdirSync(dumpDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const suffix = randomBytes(3).toString("hex");
      const filePath = join(dumpDir, "adt-body-" + timestamp + "-" + suffix + ".txt");
      writeFileSync(filePath, safeBody, "utf8");
      return safeBody.slice(0, limit) + truncationMarker(limit, safeBody.length, filePath);
    } catch {
      // Diagnostics must never throw or break the error path they decorate.
      return safeBody.slice(0, limit) + truncationMarker(limit, safeBody.length);
    }
  }

  return safeBody.slice(0, limit) + truncationMarker(limit, safeBody.length);
}
