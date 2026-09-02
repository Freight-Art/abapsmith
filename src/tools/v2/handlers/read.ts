/**
 * `abap_read` handler. Routes by `view` (`schemas.ts`'s
 * `abapReadInputSchema.view` prose is authoritative, not the table this
 * once had): `source` (default) | `contract` | `method` | `diff` |
 * `metadata` | `outline` | `bopf` | `fpm`.
 *
 * - `contract` pipes the object's source through compiled
 *   `dist/bin/contract.js` as a CHILD PROCESS (never `import`ed — see
 *   `src/bin/contract.ts`'s header) to reduce it to public/protected
 *   signatures. CLAS/INTF only.
 * - `diff` is unimplemented (`UNSUPPORTED`, `next` -> `view: "outline"`).
 *
 * DECISION: `abapReadInputSchema` is frozen, so the v2 schema has no `type`,
 * no `enhancements`, and no selector for BOPF's `mode: "raw"`/`"check_refs"`
 * or FPM's `mode: "app"`/`"find"`/`config_type`/`config_var`/`resolve` —
 * those v1 capabilities are reachable only via this file's fixed defaults
 * (BOPF always `show`, FPM always `outline` config_type "00"). Full
 * rationale: the git history.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AbapConnection } from "../../../adt/connection.js";
import { AbapError } from "../../../adt/errors.js";
import { resolveObject } from "../../../adt/resolve.js";
import { readSource } from "../../../adt/source.js";
import { buildResponse, contentHash, sliceLines } from "../../../compact.js";
import { abapRead, OUTLINE_KINDS, type ReadInput } from "../../read.js";
import { runBopfRead, type BopfInput } from "../../bopf.js";
import { runFpmReadTool, type FpmReadInput } from "../../fpm.js";
import { bareOk, isBareCall, v2Result, type NextCall } from "../envelope.js";
import type { V2ToolDeps } from "../runtime.js";
import { v2Error } from "../runtime.js";
import { liftV1Result, unknownValue } from "../unknown.js";

const KNOWN_VIEWS = ["source", "contract", "method", "diff", "metadata", "outline", "bopf", "fpm"] as const;
const UNSUPPORTED_VIEWS = new Set(["diff"]);

/** Path to `dist/bin/contract.js`, relative to this file's own compiled
 *  location (`dist/tools/v2/handlers/read.js`). */
function compiledContractEntryPoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "bin", "contract.js");
}

interface SpawnedContract {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

/** Runs `dist/bin/contract.js` as a real child process (never `import`ed) so
 *  `@abaplint/core` stays out of this process's import graph. */
function runContractSubprocess(entryPoint: string, kind: string, name: string, source: string): Promise<SpawnedContract> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entryPoint, kind, name], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => stdout.push(d));
    child.stderr.on("data", (d: Buffer) => stderr.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code });
    });
    child.stdin.write(source, "utf8");
    child.stdin.end();
  });
}

/** `view: "contract"` — see the module header. */
async function readContractView(
  conn: AbapConnection,
  object: string,
  offset: number | undefined,
  limit: number | undefined,
  maxChars: number,
): Promise<{ text: string; etag: string }> {
  const obj = await resolveObject(conn, object, {});
  if (!OUTLINE_KINDS.has(obj.kind)) {
    throw new AbapError(
      "UNSUPPORTED",
      `view="contract" is only meaningful for a class or interface (public-section signatures) — ` +
        `${obj.type} ${obj.name} resolved to kind ${obj.kind}.`,
      { type: obj.type, name: obj.name, kind: obj.kind },
      'Use view="source" (default) to read this object.',
    );
  }

  const { source } = await readSource(conn, obj, undefined, undefined);
  const entryPoint = compiledContractEntryPoint();
  let spawned: SpawnedContract;
  try {
    spawned = await runContractSubprocess(entryPoint, obj.kind, obj.name, source);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AbapError(
      "UNSUPPORTED",
      `view="contract" could not run its extraction subprocess (${entryPoint}): ${msg}. ` +
        `Was "npm run build" run for this checkout?`,
      { object, entryPoint },
      'Use view="source" (default) to read this object while this is investigated.',
    );
  }

  const notes = spawned.stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (spawned.code !== 0) {
    throw new AbapError(
      "UNSUPPORTED",
      `view="contract" extraction failed for ${obj.type} ${obj.name} ` +
        `(subprocess exit code ${spawned.code ?? "null"}): ${notes.join(" ") || "(no stderr output)"}`,
      { object, code: spawned.code },
      'Use view="source" (default) to read this object.',
    );
  }

  const extracted = spawned.stdout;
  const etag = contentHash(extracted);
  const header: Record<string, string | number | undefined> = {
    system: obj.system,
    object: `${obj.type} ${obj.name}`,
    uri: obj.uri,
    package: obj.packageName,
    description: obj.description,
    mode: "contract",
    etag,
  };
  const window = sliceLines(extracted, offset ?? 1, limit);
  const built = buildResponse({
    header: { ...header, totalLines: window.total },
    body: window.text,
    bodyLabel: "CONTRACT",
    bodyOffset: window.offset,
    bodyTotalLines: window.total,
    notes:
      notes.length > 0
        ? notes
        : ['Definition-only view: PUBLIC/PROTECTED signatures kept, method bodies and PRIVATE SECTION stripped.'],
    hints: [
      'Use view="source" (default) to read the whole object, including method bodies.',
      'Use view="method" with method=<NAME> to read one method\'s full implementation.',
    ],
    pagingParam: "offset",
    maxChars,
  });
  return { text: built.text, etag };
}

interface ReadArgs {
  readonly object?: string;
  readonly view?: string;
  readonly method?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly version?: string;
}

function norm(v: string | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t.toLowerCase();
}

/** v2 carries `version` as a free-form string; reject anything that isn't
 *  `"active"`/`"inactive"` rather than silently normalising it (see
 *  `read.ts`'s G-08 comment). */
function resolveVersion(raw: string | undefined): "active" | "inactive" | undefined {
  const v = norm(raw);
  if (v === undefined) return undefined;
  if (v === "active" || v === "inactive") return v;
  throw new AbapError("BAD_INPUT", `version must be "active" or "inactive"; got "${raw}".`, { version: raw });
}

export async function handleAbapRead(args: unknown, deps: V2ToolDeps): Promise<CallToolResult> {
  try {
    if (isBareCall(args)) {
      return v2Result(
        bareOk(
          "abap_read",
          "abap_read reads an object's source, its definition-only contract, one method, an outline, a " +
            "BOPF model, or an FPM configuration.\n" +
            "view: source (default) | contract | method | outline | metadata | bopf | fpm " +
            "(diff: not implemented yet, see abap_find/abap_do)",
          [
            { tool: "abap_read", args: { object: "ZCL_FOO" }, why: "Read an object's source (default view)." },
            {
              tool: "abap_read",
              args: { object: "ZCL_FOO", view: "contract" },
              why: "Read only public/protected signatures (classes/interfaces only) — no method bodies.",
            },
            {
              tool: "abap_read",
              args: { object: "ZCL_FOO", view: "outline" },
              why: "Read the component list (classes/interfaces only).",
            },
            {
              tool: "abap_read",
              args: { object: "ZCL_FOO", view: "method", method: "GET_DATA" },
              why: "Read one method's declaration+implementation.",
            },
            {
              tool: "abap_read",
              args: { object: "ZBOPF_ORDER", view: "bopf" },
              why: "Read a BOPF business object's design-time model.",
            },
            {
              tool: "abap_read",
              args: { object: "Z_MY_CONFIG", view: "fpm" },
              why: "Read an FPM/FBI screen configuration's outline.",
            },
          ],
        ),
      );
    }

    const a = args as ReadArgs;
    const rawView = a.view;
    const view = norm(rawView) ?? "source";

    if (!KNOWN_VIEWS.includes(view as (typeof KNOWN_VIEWS)[number])) {
      return v2Result(unknownValue("abap_read", "view", rawView ?? view, KNOWN_VIEWS));
    }

    // ------------------------------------------------------------- diff ---
    if (UNSUPPORTED_VIEWS.has(view)) {
      return v2Result(
        v2Error(
          "abap_read",
          new AbapError(
            "UNSUPPORTED",
            `view="${view}" is not implemented yet.`,
            { view },
            'Use view="outline" for the component list, or view="source" (default) for the whole object.',
          ),
          [
            {
              tool: "abap_read",
              args: { object: a.object ?? "<OBJECT>", view: "outline" },
              why: "Read the component list instead.",
            },
          ],
        ),
      );
    }

    const object = a.object;
    if (!object || !object.trim()) {
      throw new AbapError("BAD_INPUT", "abap_read requires object.", { view });
    }

    // --------------------------------------------------------- contract ---
    if (view === "contract") {
      await deps.ensureConnected();
      deps.safety.assert("read");
      const built = await deps.pool.withRead("abap_read", (conn) =>
        readContractView(conn, object, a.offset, a.limit, deps.cfg.maxResponseChars),
      );
      return v2Result({
        ok: true,
        tool: "abap_read",
        data: built.text,
        next: [
          { tool: "abap_read", args: { object }, why: "Read the whole object's source (with method bodies)." },
          {
            tool: "abap_read",
            args: { object, view: "method", method: "<NAME>" },
            why: "Read one method's full implementation.",
          },
        ],
      });
    }

    // ------------------------------------------------------------- bopf ---
    if (view === "bopf") {
      const boArgs: BopfInput = { mode: "show", bo: object };
      const res = await runBopfRead(deps, boArgs);
      const lifted = liftV1Result("abap_read", res, [
        { tool: "abap_read", args: { object, view: "bopf" }, why: "Re-read this business object's model." },
        { tool: "abap_find", args: { kind: "bo", query: object }, why: "Search related business objects." },
      ]);
      if (lifted.ok) {
        return v2Result({
          ...lifted,
          notes: [
            'view="bopf" always reads mode="show" (compact digest) — abap_read has no field yet to ' +
              'select mode="raw" (verbatim XML) or mode="check_refs" (dangling-reference report).',
          ],
        });
      }
      return v2Result(lifted);
    }

    // -------------------------------------------------------------- fpm ---
    if (view === "fpm") {
      const fpmArgs: FpmReadInput = { mode: "outline", config_id: object, config_type: "00", config_var: "" };
      const res = await runFpmReadTool(deps, fpmArgs);
      const lifted = liftV1Result("abap_read", res, [
        { tool: "abap_read", args: { object, view: "fpm" }, why: "Re-read this configuration's outline." },
        { tool: "abap_find", args: { kind: "fpm", query: object }, why: "Search related FPM configurations." },
      ]);
      if (lifted.ok) {
        return v2Result({
          ...lifted,
          notes: [
            'view="fpm" always reads mode="outline" with config_type="00" (component-scope) — abap_read ' +
              'has no fields yet for config_type/config_var/resolve or mode="app" (full UIBB hierarchy). ' +
              'Use abap_find kind="fpm" to search for the right config_id first.',
          ],
        });
      }
      return v2Result(lifted);
    }

    // --------------------------------------------------- source / method / outline / metadata ---
    const version = resolveVersion(a.version);
    const outline = view === "outline";
    let method: string | undefined;
    if (view === "method") {
      if (!a.method || !a.method.trim()) {
        throw new AbapError("BAD_INPUT", 'view="method" requires method.', { view, object });
      }
      method = a.method;
    }
    // "metadata" has no distinct v1 rendering (see module DECISION note); it
    // falls through to the default source read, flagged via metadataNotes below
    // so callers don't mistake it for a smaller, metadata-only response.

    const readInput: ReadInput = {
      object,
      method,
      outline,
      offset: a.offset,
      limit: a.limit,
      version,
    };

    await deps.ensureConnected();
    deps.safety.assert("read");
    const res = await deps.pool.withRead("abap_read", (conn) => abapRead(conn, readInput, deps.cfg.maxResponseChars));
    // Surface buildResponse's truncated/hasMore/returnedLines/
    // totalLines instead of collapsing a partial read to a bare `ok: true`
    // (a caller could not tell a partial read from a complete one). The next
    // page is placed first in `next`, ahead of the generic suggestions.
    // Full incident writeup: the git history.
    const nextOffset =
      res.returnedLines !== undefined ? (a.offset ?? 1) + res.returnedLines : undefined;
    const truncationNotes = res.truncated
      ? [
          `INCOMPLETE READ: ${res.returnedLines ?? 0} of ${res.totalLines ?? "?"} line(s) returned` +
            ` (~${res.estimatedTokens} tokens, capped by the response budget).` +
            (res.sectionsTruncated ? " Prologue sections were cut as well." : "") +
            " The DATA above is NOT the whole object. Its etag is marked `partial:` and abap_write" +
            " will REFUSE a full-source rewrite that presents it — use abap_write" +
            " {edit:{old_string,new_string}} to change part of an object without holding all of it," +
            " or page the rest with offset/limit first.",
        ]
      : [];
    const metadataNotes =
      view === "metadata"
        ? [
            'view="metadata" has no distinct rendering yet — this is the same output as view="source". ' +
              'Use view="outline" for the component list, or view="contract" for signatures only.',
          ]
        : [];
    const notes = [...truncationNotes, ...metadataNotes];
    const pagingNext: NextCall[] =
      res.truncated && res.hasMore && nextOffset !== undefined
        ? [
            {
              tool: "abap_read",
              args: { object, ...(method ? { view: "method", method } : {}), offset: nextOffset },
              why: "Fetch the lines this response did not return.",
            },
          ]
        : [];
    return v2Result({
      ok: true,
      tool: "abap_read",
      data: res.text,
      ...(res.truncated ? { truncated: true } : {}),
      ...(notes.length > 0 ? { notes } : {}),
      next: [
        ...pagingNext,
        ...(view === "outline"
          ? [{ tool: "abap_read", args: { object, view: "method", method: "<NAME>" }, why: "Read one component." }]
          : view === "method"
            ? [{ tool: "abap_read", args: { object }, why: "Read the whole object's source." }]
            : [
                { tool: "abap_read", args: { object, view: "outline" }, why: "Read the component list first." },
                {
                  tool: "abap_read",
                  args: { object, view: "method", method: "<NAME>" },
                  why: "Read a single method.",
                },
              ]),
      ],
    });
  } catch (e) {
    return v2Result(
      v2Error("abap_read", e, [{ tool: "abap_read", args: {}, why: "Retry with the bare call for guidance." }]),
    );
  }
}
