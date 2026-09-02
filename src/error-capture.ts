/**
 * Error-path body capture — forensic, opt-in, safe to leave in permanently.
 *
 * Deliberately separate from `truncateDiagnosticBody`'s dump in `src/truncate.ts`:
 * that dumper sits after the early return and only fires on already-formatted
 * text over 20,000 chars, so it never sees the raw body on the error path
 * (full rationale: the git history). This module runs
 * while the thrown object is still intact, captures unconditionally on size,
 * and returns nothing so it can never affect what a caller sees. It shares
 * `ABAPSMITH_BODY_DUMP_DIR` with that dumper but writes `adt-error-*.txt`
 * (never `adt-body-*.txt`) so the two are distinguishable in the same dir.
 *
 * Contract (see archive for full rationale) — all load-bearing:
 *  1. Gated entirely on `ABAPSMITH_BODY_DUMP_DIR`; no work when unset. Call
 *     sites must pass the RAW thrown object (see `src/adt/http-guard.ts`,
 *     `src/debug/transport.ts`).
 *  2. Never throws — try/catch with an intentionally empty catch.
 *  3. Never writes to stdout/stderr (stdout is the MCP transport). Files only.
 *  4. Retains nothing — no module-level state across calls.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** The single knob. Shared with `truncateDiagnosticBody`'s overflow spill. */
export const BODY_DUMP_DIR_ENV = "ABAPSMITH_BODY_DUMP_DIR";

/** Query-param names whose value gets redacted; headers are never written at all, so the URL is the only place a credential can appear. */
const CREDENTIAL_PARAM = /(pass|pwd|secret|token|auth|cred|key|session|cookie|ticket|saml|assertion)/i;

/** Written in place of a redacted value. Asserted on by the unit tests. */
export const REDACTED = "[redacted]";

/** Redacts one `name=value` pair if `name` looks like a credential; anything else passes through. */
function redactPair(pair: string): string {
  const eq = pair.indexOf("=");
  if (eq <= 0) return pair;
  const name = pair.slice(0, eq);
  return CREDENTIAL_PARAM.test(name) ? `${name}=${REDACTED}` : pair;
}

/** Splits on `separators` (capturing group), redacts each pair, rejoins with the original separators intact. */
function redactPairs(text: string, separators: RegExp): string {
  return text
    .split(separators)
    .map((token, i) => (i % 2 === 0 ? redactPair(token) : token))
    .join("");
}

/**
 * Unlike `cutQueryAndFragment` (src/adt/http-guard.ts:196), which just drops
 * everything past `?`/`#` for policy checks, this redacts credential-shaped
 * pairs in place so the rest of the query/fragment stays readable on disk.
 */
export function redactUrlForCapture(path: string): string {
  const text = typeof path === "string" ? path : String(path ?? "");
  const hashIdx = text.indexOf("#");
  const beforeHash = hashIdx < 0 ? text : text.slice(0, hashIdx);
  const fragment = hashIdx < 0 ? undefined : text.slice(hashIdx + 1);

  const q = beforeHash.indexOf("?");
  const base = q < 0 ? beforeHash : beforeHash.slice(0, q);
  const query = q < 0 ? undefined : beforeHash.slice(q + 1);

  let result = base;
  if (query !== undefined) result += `?${redactPairs(query, /(&)/)}`;
  // ADT class-member refs put `;` in the fragment (e.g. `#type=CLAS/OC;name=FOO`), so both are separators here.
  if (fragment !== undefined) result += `#${redactPairs(fragment, /([&;])/)}`;
  return result;
}

function asBodyText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function pick(o: unknown, key: string): unknown {
  if (!o || (typeof o !== "object" && typeof o !== "function")) return undefined;
  try {
    return (o as Record<string, unknown>)[key];
  } catch {
    // A getter that throws must not take the capture (or the request) down.
    return undefined;
  }
}

/**
 * Writes one forensic record when `ABAPSMITH_BODY_DUMP_DIR` is set; returns
 * the path written, or undefined (disabled or write failed — callers ignore it).
 * Called from two layers (`http-guard`, `adtErrorFromException`) for the same
 * failure on purpose: comparing the two records shows where the body was lost.
 */
export function captureErrorBody(source: string, requestPath: string, thrown: unknown): string | undefined {
  const dumpDir = process.env[BODY_DUMP_DIR_ENV];
  if (typeof dumpDir !== "string" || dumpDir.length === 0) return undefined;

  try {
    const ownResponse = pick(thrown, "response");
    const parent = pick(thrown, "parent");
    const parentResponse = pick(parent, "response");

    const ownBody = asBodyText(pick(ownResponse, "body"));
    const parentBody = asBodyText(pick(parentResponse, "body"));
    const body = ownBody ?? parentBody ?? "";
    const bodyOrigin =
      ownBody !== undefined ? "response.body" : parentBody !== undefined ? "parent.response.body" : "none";

    const statusCandidates = [
      pick(thrown, "status"),
      pick(thrown, "err"),
      pick(ownResponse, "status"),
      pick(parentResponse, "status"),
    ];
    const status = statusCandidates.find((v) => typeof v === "number" && Number.isFinite(v));

    // Discriminates AdtHttpException (bare catch, no `properties`) from
    // AdtErrorException (`fromResponse` path, has `properties`).
    const ctor = pick(pick(thrown, "constructor"), "name");

    const header = [
      "=== abapsmith error-path capture ===",
      `capturedAt: ${new Date().toISOString()}`,
      `source: ${source}`,
      `requestPath: ${redactUrlForCapture(requestPath)}`,
      `constructorName: ${typeof ctor === "string" && ctor ? ctor : "(unknown)"}`,
      `status: ${status === undefined ? "(none)" : String(status)}`,
      `code: ${formatScalar(pick(thrown, "code"))}`,
      `hasParent: ${parent !== undefined && parent !== null}`,
      `hasParentResponse: ${parentResponse !== undefined && parentResponse !== null}`,
      `bodyOrigin: ${bodyOrigin}`,
      `bodyLength: ${body.length}`,
      "--- body ---",
      "",
    ].join("\n");

    mkdirSync(dumpDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = join(dumpDir, `adt-error-${timestamp}-${randomBytes(4).toString("hex")}.txt`);
    writeFileSync(filePath, header + body, "utf8");
    return filePath;
  } catch {
    // Contract property 2: never throws, never logs — invisible on failure.
    return undefined;
  }
}

function formatScalar(v: unknown): string {
  if (v === undefined || v === null) return "(none)";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return `(${typeof v})`;
}
