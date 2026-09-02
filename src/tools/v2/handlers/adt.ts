/**
 * `abap_adt`: raw ADT REST escape hatch, GET-only.
 *
 * Validation order (all pre-network, zero-cost refusals) — see
 * the git history for the full reasoning:
 *
 *   1. Bare `{}` call → self-describing response, ahead of every other
 *      check including the method/mode gate. (A past version got this
 *      ordering wrong — see archive.)
 *   2. Method normalize + allowlist (`normalizeAdtMethod`). Non-GET is
 *      refused: READ_ONLY under non-admin mode, NOT_IMPLEMENTED under
 *      admin. No mode can dispatch a mutating raw call today — it's a
 *      structural gap (`SafetyGate.authorize`/`JournalOperation` have no
 *      raw-path support), not a mode ceiling.
 *   3. Path validation (`validateAdtPath`) — must live under
 *      `/sap/bc/adt/`.
 *   4. Header deny-list (`findDeniedAdtHeader`) — refuses the whole call,
 *      never silently strips, if a session-owned header is set.
 *
 * The GET itself goes through `AbapConnection.get()`, the same entry point
 * every other GET uses, inheriting circuit breaker/session mutex/CSRF
 * handling and the `assertHttpPathAllowed` guard. Response runs through
 * `buildResponse` for the same truncation behaviour every tool has.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildResponse } from "../../../compact.js";
import { findDeniedAdtHeader, normalizeAdtMethod, validateAdtPath } from "../adt-validation.js";
import { bareOk, isBareCall, notImplemented, v2Result } from "../envelope.js";
import type { NextCall, V2Err } from "../envelope.js";
import type { V2ToolDeps } from "../runtime.js";
import { v2Error } from "../runtime.js";

const EXAMPLE_PATH = "/sap/bc/adt/repository/nodestructure";

const bareNext: readonly NextCall[] = [
  { tool: "abap_adt", args: { path: EXAMPLE_PATH }, why: "Example GET against a real ADT endpoint." },
];

function retryBareNext(): readonly NextCall[] {
  return [{ tool: "abap_adt", args: {}, why: "Retry with the bare call for guidance." }];
}

function badInput(message: string): V2Err {
  return {
    ok: false,
    tool: "abap_adt",
    error: "BAD_INPUT",
    message,
    retryable: true, // a different argument would work
    next: bareNext,
  };
}

/** SDK gives an untyped bag; re-narrowed by hand (same convention as `RawDebugArgs` in `src/tools/debug-register.ts`). */
type RawAdtArgs = { method?: string; path?: string; body?: string; headers?: Record<string, string> };

export async function handleAbapAdt(args: unknown, deps: V2ToolDeps): Promise<CallToolResult> {
  const mode = deps.cfg.abapMode;
  try {
    // Bare-call check runs before the method/mode gate — see file header.
    if (isBareCall(args)) {
      return v2Result(
        bareOk(
          "abap_adt",
          "abap_adt is a raw ADT REST escape hatch. method: GET (default) | POST | PUT | DELETE. " +
            "path is a full path under /sap/bc/adt/. GET-only in every mode, including admin — " +
            "non-GET verbs are refused regardless of mode (see the tool description for why).",
          [...bareNext],
        ),
      );
    }

    const a = args as RawAdtArgs;

    const method = normalizeAdtMethod(a.method);
    if (method !== "GET") {
      if (mode !== "admin") {
        return v2Result({
          ok: false,
          tool: "abap_adt",
          error: "READ_ONLY",
          message: `abap_adt method="${a.method}" requires admin mode; this server is running in ${mode} mode.`,
          retryable: true, // GET works in this mode; a different method/mode would too
          next: [
            {
              tool: "abap_adt",
              args: { method: "GET", path: a.path ?? EXAMPLE_PATH },
              why: "GET is available in this mode.",
            },
          ],
        });
      }
      // Admin mode still can't dispatch a mutating raw call — see file header.
      return v2Result(
        notImplemented("abap_adt", `abap_adt method="${method}"`, [
          {
            tool: "abap_adt",
            args: { method: "GET", path: a.path ?? EXAMPLE_PATH },
            why: "GET is fully implemented; mutating verbs need further structural work first.",
          },
        ]),
      );
    }

    const pathCheck = validateAdtPath(a.path);
    if (!pathCheck.ok) return v2Result(badInput(pathCheck.message));

    const deniedHeader = findDeniedAdtHeader(a.headers);
    if (deniedHeader !== undefined) {
      return v2Result(
        badInput(
          `abap_adt refuses to override the "${deniedHeader}" header: it is session-owned ` +
            "(cookies/CSRF/connection framing are managed by the connection itself). Remove it " +
            "from headers and retry.",
        ),
      );
    }

    await deps.ensureConnected();
    deps.safety.assert("read");
    const path = pathCheck.path;
    const resp = await deps.pool.withRead("abap_adt", (conn) =>
      conn.get(path, a.headers !== undefined ? { headers: a.headers } : {}),
    );

    const contentType = typeof resp.headers["content-type"] === "string" ? resp.headers["content-type"] : undefined;
    const built = buildResponse({
      header: {
        method: "GET",
        path,
        status: resp.status,
        contentType,
      },
      body: resp.body,
      bodyLabel: "RESPONSE",
      maxChars: deps.cfg.maxResponseChars,
    });

    return v2Result({
      ok: true,
      tool: "abap_adt",
      data: built.text,
      next: [
        { tool: "abap_adt", args: { path }, why: "Repeat this GET." },
        {
          tool: "abap_adt",
          args: {},
          why: "Call abap_adt({}) for the bare self-description of this raw escape hatch.",
        },
      ],
    });
  } catch (e) {
    return v2Result(v2Error("abap_adt", e, retryBareNext()));
  }
}
