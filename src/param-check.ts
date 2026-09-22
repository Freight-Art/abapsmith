/**
 * Parameter-name and enum-value checking at the transport boundary.
 *
 * The SDK validates `tools/call` arguments against each tool's zod object
 * BEFORE the registered handler ever runs: an unknown key is silently
 * stripped (`z.object` is a stripping parse), and an invalid enum value
 * fails inside the SDK's own `safeParseAsync` with a bare validation
 * message. Neither case is reachable from a handler — by the time a
 * handler would see `args`, the SDK has already accepted or rejected the
 * call. So this check has to sit in front of `tools/call` dispatch itself,
 * on the transport's `onmessage`, before the message reaches the SDK.
 *
 * `installParamCheck` records each tool's raw shape as it is registered,
 * then inspects incoming `tools/call` requests against that shape and
 * answers a refusal directly — costing zero SAP requests — instead of
 * forwarding a call the SDK would otherwise mangle or reject uninformatively.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { AbapError } from "./adt/errors.js";
import { levenshtein } from "./adt/source.js";
import { errorResult } from "./tool-errors.js";

/**
 * Known confusions per tool: alias key (lower case) -> real parameter name.
 * Only aliases whose target is an actual parameter of that tool belong here
 * — `installParamCheck` never checks that at runtime.
 */
export const PARAM_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  abap_journal: { id: "entry", entry_id: "entry", name: "object" },
  abap_bopf: { object: "bo", name: "bo", business_object: "bo" },
  abap_bopf_edit: { object: "bo", business_object: "bo" },
  abap_bopf_delete: { object: "bo", business_object: "bo" },
  abap_transport: { action: "operation", mode: "operation", request: "transport", trkorr: "transport" },
  abap_transport_release: { request: "transport", trkorr: "transport" },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Best "did you mean" among `accepted`, in order: an alias hit whose target
 * is accepted; a case-insensitive exact match; a unique prefix match (either
 * direction, both strings at least 2 chars); otherwise the unique closest
 * name by Levenshtein distance, gated at `max(1, ceil(unknown.length / 3))`.
 * Undefined when nothing qualifies or the best candidate is ambiguous.
 */
export function suggestParam(
  unknown: string,
  accepted: readonly string[],
  aliases?: Readonly<Record<string, string>>,
): string | undefined {
  const lower = unknown.toLowerCase();

  if (aliases) {
    const target = aliases[lower];
    if (target !== undefined && accepted.includes(target)) return target;
  }

  const exact = accepted.find((a) => a.toLowerCase() === lower);
  if (exact !== undefined) return exact;

  if (unknown.length >= 2) {
    const prefixCandidates = accepted.filter((a) => {
      if (a.length < 2) return false;
      const al = a.toLowerCase();
      return al.startsWith(lower) || lower.startsWith(al);
    });
    if (prefixCandidates.length === 1) return prefixCandidates[0];
  }

  const maxDist = Math.max(1, Math.ceil(unknown.length / 3));
  let bestDist = Infinity;
  let bestNames: string[] = [];
  for (const a of accepted) {
    const d = levenshtein(a.toLowerCase(), lower);
    if (d < bestDist) {
      bestDist = d;
      bestNames = [a];
    } else if (d === bestDist) {
      bestNames.push(a);
    }
  }
  if (bestNames.length === 1 && bestDist <= maxDist) return bestNames[0];
  return undefined;
}

/** Same ranking as {@link suggestParam}, without aliases. */
export function suggestEnumValue(value: string, values: readonly string[]): string | undefined {
  return suggestParam(value, values);
}

/** A zod v4 internal `_zod.def` shape, as narrowly as this module needs it. */
interface ZodDef {
  type?: string;
  innerType?: unknown;
  entries?: Record<string, unknown>;
}

/** Wrapper types to unwrap on the way to a possible `enum` schema. */
const UNWRAP_TYPES = new Set(["optional", "nullable", "default", "readonly", "catch"]);

/** Cap on unwrap depth — defensive only; real schemas nest at most 2-3 deep. */
const MAX_UNWRAP_DEPTH = 10;

/**
 * The string enum values of `schema`, unwrapping optional/nullable/default/
 * readonly/catch on the way in. Undefined for anything else — including any
 * shape this module doesn't recognise — so an unexpected schema just means
 * "no enum check", never a throw.
 */
function enumValuesOf(schema: unknown): string[] | undefined {
  let current = schema;
  for (let i = 0; i < MAX_UNWRAP_DEPTH; i++) {
    if (typeof current !== "object" || current === null) return undefined;
    const def = (current as { _zod?: { def?: ZodDef } })._zod?.def;
    if (!def || typeof def.type !== "string") return undefined;
    if (def.type === "enum") {
      const entries = def.entries;
      if (!entries || typeof entries !== "object") return undefined;
      const values = Object.values(entries).filter((v): v is string => typeof v === "string");
      return values.length ? values : undefined;
    }
    if (UNWRAP_TYPES.has(def.type) && def.innerType !== undefined) {
      current = def.innerType;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Refuse `args` against a tool's raw zod shape: an unknown key, or a known
 * key whose string value doesn't belong to its enum. Returns undefined when
 * `args` isn't a plain object (left to the SDK) or nothing is wrong.
 */
export function checkToolArgs(
  tool: string,
  shape: Record<string, unknown>,
  args: unknown,
  aliases?: Readonly<Record<string, string>>,
): AbapError | undefined {
  if (!isPlainObject(args)) return undefined;

  const accepted = Object.keys(shape);
  const acceptedSet = new Set(accepted);
  const unknownKeys = Object.keys(args).filter((k) => !acceptedSet.has(k));

  if (unknownKeys.length > 0) {
    const key = unknownKeys[0] as string;
    const suggestion = suggestParam(key, accepted, aliases);
    const message =
      `${tool} does not accept parameter "${key}".` +
      (suggestion ? ` Did you mean "${suggestion}"?` : "") +
      ` Accepted parameters: ${accepted.join(", ")}.`;
    const details: Record<string, unknown> = {
      tool,
      parameter: key,
      unknown: unknownKeys,
      accepted: [...accepted],
      ...(suggestion ? { suggestion } : {}),
    };
    const hint = suggestion
      ? `Retry with ${suggestion}= instead of ${key}=.`
      : "Use only the listed parameters; see the tool description.";
    return new AbapError("BAD_INPUT", message, details, hint);
  }

  for (const key of accepted) {
    if (!(key in args)) continue;
    const value = args[key];
    if (typeof value !== "string") continue;
    const values = enumValuesOf(shape[key]);
    if (values === undefined || values.includes(value)) continue;
    const suggestion = suggestEnumValue(value, values);
    const message =
      `${tool}: ${key} "${value}" is not valid. Valid values: ${values.join(", ")}.` +
      (suggestion ? ` Did you mean "${suggestion}"?` : "");
    const details: Record<string, unknown> = {
      tool,
      parameter: key,
      value,
      accepted: values,
      ...(suggestion ? { suggestion } : {}),
    };
    const hint = suggestion ? `Retry with ${key}="${suggestion}".` : "Pick one of the listed values.";
    return new AbapError("BAD_INPUT", message, details, hint);
  }

  return undefined;
}

function hasZodMarker(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return "_zod" in r || "_def" in r;
}

/**
 * True when `v` is a plain object of zod schemas — a "raw shape" as every
 * `registerXTools` in this codebase passes for `inputSchema` — rather than a
 * pre-built zod object (`z.object(...)`/`z.looseObject(...)`) such as
 * `abap_dumps`/`abap_trace` register, which already handle unknown keys
 * themselves and must NOT be checked here.
 */
export function isRawShape(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  if (hasZodMarker(v)) return false;
  return Object.values(v as Record<string, unknown>).every(hasZodMarker);
}

/** A `tools/call` request with a plain-object `params`, before the SDK parses it further. */
function isCallToolRequest(
  message: JSONRPCMessage,
): message is JSONRPCMessage & { id: string | number; params: { name: string; arguments?: unknown } } {
  const m = message as { method?: unknown; id?: unknown; params?: unknown };
  return (
    m.method === "tools/call" &&
    (typeof m.id === "string" || typeof m.id === "number") &&
    isPlainObject(m.params) &&
    typeof (m.params as { name?: unknown }).name === "string"
  );
}

/**
 * Rebinds `mcp.registerTool` and `mcp.connect` in place (same shape as
 * `installSystemRouting`/`stripSchemaKeyOnConnect`) so every tool's raw
 * shape is recorded as it registers, and every `tools/call` request is
 * checked against it before the SDK — and the handler — ever see it. The
 * advertised `tools/list` schema is never touched: registration is
 * forwarded unchanged.
 */
export function installParamCheck(mcp: McpServer, options: { aliases?: typeof PARAM_ALIASES } = {}): void {
  const aliases = options.aliases ?? PARAM_ALIASES;
  const shapes = new Map<string, Record<string, unknown>>();

  const rawRegisterTool = mcp.registerTool.bind(mcp) as unknown as (
    name: string,
    config: { inputSchema?: unknown; [key: string]: unknown },
    cb: (...args: unknown[]) => unknown,
  ) => ReturnType<McpServer["registerTool"]>;

  mcp.registerTool = ((
    name: string,
    config: { inputSchema?: unknown; [key: string]: unknown },
    cb: (...args: unknown[]) => unknown,
  ) => {
    if (isRawShape(config.inputSchema)) {
      shapes.set(name, config.inputSchema);
    }
    return rawRegisterTool(name, config, cb);
  }) as typeof mcp.registerTool;

  const rawConnect = mcp.connect.bind(mcp);
  mcp.connect = (async (transport: Transport) => {
    await rawConnect(transport);
    const original = transport.onmessage;
    if (!original) return;

    transport.onmessage = ((message: JSONRPCMessage, extra?: unknown) => {
      if (isCallToolRequest(message)) {
        const shape = shapes.get(message.params.name);
        const args = message.params.arguments;
        if (shape) {
          const error = checkToolArgs(message.params.name, shape, args, aliases[message.params.name]);
          if (error) {
            const response = { jsonrpc: "2.0" as const, id: message.id, result: errorResult(error) };
            transport.send(response as JSONRPCMessage).catch(() => {
              // Best effort — the caller will simply see no response.
            });
            return;
          }
        }
      }
      (original as (message: JSONRPCMessage, extra?: unknown) => void)(message, extra);
    }) as Transport["onmessage"];
  }) as typeof mcp.connect;
}
