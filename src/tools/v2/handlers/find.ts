/**
 * `abap_find` handler.
 *
 * `kind` routes to a dedicated tool (bo/fpm/transport) or falls back to the
 * generic repository/where-used search via `specForKeyword`; `badi` has no
 * v1 route (UNSUPPORTED). `where: "package"` was advertised by an earlier
 * stub but never implemented (searchInputSchema has no package field) —
 * answered with UNSUPPORTED rather than silently ignored or treated as
 * "repository". See the git history.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BOPF_TYPE } from "../../../adt/bopf.js";
import { AbapError } from "../../../adt/errors.js";
import { specForKeyword } from "../../../adt/types.js";
import { abapSearch, type SearchInput } from "../../search.js";
import { runBopfRead, type BopfInput } from "../../bopf.js";
import { runFpmReadTool, type FpmReadInput } from "../../fpm.js";
import { abapTransport, type TransportInput } from "../../transport.js";
import { bareOk, isBareCall, v2Result } from "../envelope.js";
import type { V2ToolDeps } from "../runtime.js";
import { v2Error } from "../runtime.js";
import { liftV1Result, unknownValue } from "../unknown.js";

/** Kinds with a dedicated route; others fall back to generic search. */
const ROUTED_KINDS = new Set(["bo", "fpm", "badi", "transport"]);

/** Kinds advertised in the bare call and UNKNOWN_KIND's nearest-match list. */
const ADVERTISED_KINDS = ["class", "program", "table", "bo", "fpm", "badi", "transport"] as const;

interface FindArgs {
  readonly query?: string;
  readonly kind?: string;
  readonly where?: string;
  readonly type?: string;
  readonly max?: number;
}

function norm(v: string | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t.toLowerCase();
}

export async function handleAbapFind(args: unknown, deps: V2ToolDeps): Promise<CallToolResult> {
  try {
    if (isBareCall(args)) {
      return v2Result(
        bareOk(
          "abap_find",
          "abap_find locates objects, usages, business objects, FPM configs and transports.\n" +
            "kind: class | program | table | bo | fpm | badi | transport (omit to search every kind)\n" +
            "where: repository (default) | usages",
          [
            { tool: "abap_find", args: { query: "ZCL_*" }, why: "Search the repository by name pattern." },
            {
              tool: "abap_find",
              args: { query: "ZCL_FOO", where: "usages" },
              why: "List what uses an object (where-used).",
            },
            { tool: "abap_find", args: { kind: "bo", query: "ZBOPF_*" }, why: "Search BOPF business objects." },
            { tool: "abap_find", args: { kind: "fpm", query: "*" }, why: "Search FPM/FBI screen configurations." },
            { tool: "abap_find", args: { kind: "transport" }, why: "List CTS transport requests." },
          ],
        ),
      );
    }

    const a = args as FindArgs;
    const kind = norm(a.kind);
    const where = norm(a.where);

    if (kind === "badi") {
      return v2Result(
        v2Error(
          "abap_find",
          new AbapError(
            "UNSUPPORTED",
            'kind="badi" has no v1 route — BAdI/enhancement objects are not searchable ' +
              "via abap_find yet.",
            { kind },
            'Use abap_do to inspect enhancement actions, or abap_read on an object name you already know.',
          ),
          [
            {
              tool: "abap_do",
              args: {},
              why: 'List abap_do\'s action catalogue — enhancement actions live in the "enhancements" group.',
            },
            { tool: "abap_find", args: {}, why: "Bare call for abap_find's other kinds." },
          ],
        ),
      );
    }

    if (kind === "bo") {
      const boArgs: BopfInput = {
        mode: "search",
        query: a.query,
        object_type: a.type ?? BOPF_TYPE,
        max_results: a.max,
      };
      const res = await runBopfRead(deps, boArgs);
      return v2Result(
        liftV1Result("abap_find", res, [
          {
            tool: "abap_read",
            args: { object: "<BO_NAME>", view: "bopf" },
            why: "Read one business object's design-time model.",
          },
          { tool: "abap_find", args: { kind: "bo", query: a.query ?? "*" }, why: "Repeat/refine this BOPF search." },
        ]),
      );
    }

    if (kind === "fpm") {
      const fpmArgs: FpmReadInput = {
        mode: "find",
        query: a.query,
        config_type: a.type,
      };
      const res = await runFpmReadTool(deps, fpmArgs);
      return v2Result(
        liftV1Result("abap_find", res, [
          {
            tool: "abap_read",
            args: { object: "<CONFIG_ID>", view: "fpm" },
            why: "Read one configuration's outline (raw XML plus metadata).",
          },
          { tool: "abap_find", args: { kind: "fpm", query: a.query ?? "*" }, why: "Repeat/refine this FPM search." },
        ]),
      );
    }

    if (kind === "transport") {
      await deps.ensureConnected();
      // Read gate applies here too, even though the branch ends in withWrite.
      deps.safety.assert("read");
      const input: TransportInput = { operation: "list", user: a.query };
      // WRITE slot deliberately (opList may POST-create a CTS search config on
      // first use, needing the CSRF-armed write session) — do not switch to
      // withRead without proving that POST cannot fire. See
      // the git history.
      const res = await deps.pool.withWrite("abap_find", undefined, (conn) =>
        abapTransport(conn, input, deps.cfg.maxResponseChars, deps.safety, undefined),
      );
      return v2Result({
        ok: true,
        tool: "abap_find",
        data: res.text,
        next: [
          {
            tool: "abap_do",
            args: { action: "transport_show", object: "<TRKORR>" },
            why: "Show one request's header/tasks/objects.",
          },
          { tool: "abap_find", args: { kind: "transport" }, why: "Repeat this transport list." },
        ],
      });
    }

    if (where === "package") {
      return v2Result(
        v2Error(
          "abap_find",
          new AbapError(
            "UNSUPPORTED",
            'where="package" is not implemented: no v1 route filters repository search by package ' +
              "(searchInputSchema has no package field). This was advertised by an earlier stub's " +
              "bare-call text but never wired up.",
            { where },
            'Omit where (defaults to "repository"), or use "usages".',
          ),
          [
            {
              tool: "abap_find",
              args: { query: a.query ?? "ZCL_*" },
              why: "Search the repository by name pattern instead (not package-scoped).",
            },
          ],
        ),
      );
    }
    if (where !== undefined && where !== "repository" && where !== "usages") {
      return v2Result(unknownValue("abap_find", "where", where, ["repository", "usages"]));
    }

    let typeOverride = a.type;
    if (kind !== undefined && !ROUTED_KINDS.has(kind)) {
      const spec = specForKeyword(kind);
      if (spec === undefined) {
        return v2Result(unknownValue("abap_find", "kind", kind, ADVERTISED_KINDS));
      }
      if (typeOverride === undefined) typeOverride = spec.type;
    }

    const query = a.query;
    if (!query || !query.trim()) {
      throw new AbapError(
        "BAD_INPUT",
        "abap_find requires query for a repository/usages search (kind was not bo/fpm/badi/transport).",
        { kind, where },
      );
    }

    const searchInput: SearchInput = {
      query,
      mode: where === "usages" ? "where_used" : "objects",
      type: typeOverride,
      max: a.max,
    };
    await deps.ensureConnected();
    deps.safety.assert("read");
    const res = await deps.pool.withRead("abap_find", (conn) =>
      abapSearch(conn, searchInput, deps.cfg.maxResponseChars),
    );
    return v2Result({
      ok: true,
      tool: "abap_find",
      data: res.text,
      next: [
        { tool: "abap_read", args: { object: "<NAME>" }, why: "Read one of the results." },
        { tool: "abap_find", args: { query, where: "usages" }, why: "See what uses a specific result." },
      ],
    });
  } catch (e) {
    return v2Result(
      v2Error("abap_find", e, [{ tool: "abap_find", args: {}, why: "Retry with the bare call for guidance." }]),
    );
  }
}
