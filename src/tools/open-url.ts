/**
 * `abap_open_url` — MVP scope. Resolves an object ref / ABAP keyword / Web
 * Dynpro app name to a browser-openable URL. WebGUI+SSO route is explicitly
 * out of scope (no stub, no TODO). Full route breakdown: see
 * the git history
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AbapError } from "../adt/errors.js";
import { resolveObject } from "../adt/resolve.js";
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import type { SafetyGate } from "../safety.js";

// DDIC kinds whose /source/main never content-negotiates to HTML — stays
// vendor XML regardless of Accept (TypeSpec.supportsSource is false for
// these three; TABL/STRU differ). See the git history
const HTML_UNSUPPORTED_KINDS = new Set(["DTEL", "DOMA", "TTYP"]);

export const openUrlInputSchema = {
  object: z.string().optional().describe("Object to open, fuzzy like `abap_read`'s `object`."),
  type: z.string().optional().describe("ADT type. Only with `object`."),
  line: z.number().int().positive().optional().describe("Deep-link line. Only with `object`."),
  keyword: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,80}$/, "keyword must match ^[A-Za-z0-9_]{1,80}$ (reject, never escape)")
    .optional()
    .describe('ABAP keyword, e.g. "SELECT".'),
  webdynpro: z
    .string()
    .regex(/^[A-Za-z0-9_/]{1,80}$/, "webdynpro must match ^[A-Za-z0-9_/]{1,80}$ (reject, never escape)")
    .optional()
    .describe("Web Dynpro application name."),
};

// Cross-field checks (mutual exclusivity; type/line require object) applied
// via safeParse in the handler, not the raw schema — same split as read.ts.
export const OpenUrlInput = z
  .object(openUrlInputSchema)
  .refine(
    (v) => {
      const modes = [v.object, v.keyword, v.webdynpro].filter((s) => typeof s === "string" && s.length > 0);
      return modes.length === 1;
    },
    { message: "Exactly one of object, keyword, or webdynpro is required." },
  )
  .refine(
    (v) => (v.type === undefined && v.line === undefined) || (typeof v.object === "string" && v.object.length > 0),
    { message: "type/line are only valid alongside object." },
  );
export type OpenUrlInput = z.infer<typeof OpenUrlInput>;

export interface OpenUrlToolDeps {
  readonly pool: SessionPool;
  readonly cfg: Pick<Config, "url" | "sid">;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/** Resolves one of the three routes. Only `object` touches the wire, via `resolveObject`, gated by `safety.assert("read")` (same call `abap_read` makes). */
async function resolveOpenUrl(
  input: OpenUrlInput,
  deps: Pick<OpenUrlToolDeps, "pool" | "cfg" | "safety">,
): Promise<Record<string, unknown>> {
  if (input.keyword) {
    const keyword = input.keyword.toUpperCase();
    return {
      route: "abap-docu",
      // Live-verified: not every keyword has a single-page doc entry (e.g.
      // LOOP 200s with an "Invalid document" placeholder) — searchUrl is a
      // working fallback. Details: the git history
      url: `${deps.cfg.url}/sap/public/bc/abap/docu?object=ABAP${encodeURIComponent(keyword)}`,
      searchUrl: `${deps.cfg.url}/sap/public/bc/abap/docu?query=${encodeURIComponent(keyword)}`,
      keyword,
      note:
        "no authentication required to view either page; if url renders 'Invalid document' " +
        "(happens for compound keywords with no single-page entry, e.g. LOOP), use searchUrl instead",
    };
  }

  if (input.webdynpro) {
    return {
      route: "web-dynpro",
      url: `${deps.cfg.url}/sap/bc/webdynpro/sap/${input.webdynpro}`,
      app: input.webdynpro,
      note:
        "requires Basic auth and a browser User-Agent to render — a request without a browser " +
        "User-Agent has been observed to both 500 and 200-with-a-zero-length-body depending on " +
        "the app; neither status code alone is a success signal, only real body content is",
    };
  }

  const objectRef = input.object;
  if (!objectRef) {
    // Unreachable given OpenUrlInput's refine, but keeps this function's
    // control flow honest without an unsafe cast.
    throw new AbapError("BAD_INPUT", "Exactly one of object, keyword, or webdynpro is required.", {});
  }

  deps.safety.assert("read");
  const resolved = await deps.pool.withRead("abap_open_url", (conn) =>
    resolveObject(conn, objectRef, input.type ? { type: input.type } : {}),
  );

  const fragment = input.line ? `#start=${input.line},0` : "";
  const url = `${deps.cfg.url}${resolved.uri}/source/main${fragment}`;

  const notes: string[] = [];
  let adtUrl: string | undefined;
  if (deps.cfg.sid !== "UNKNOWN") {
    adtUrl = `adt://${deps.cfg.sid}${resolved.uri}${fragment}`;
  } else {
    notes.push("adt:// link unavailable: ABAP_SID is not configured");
  }
  if (HTML_UNSUPPORTED_KINDS.has(resolved.kind)) {
    notes.push(
      "metadata objects of this kind do not render as HTML — the ADT endpoint stays vendor XML " +
        "regardless of Accept header",
    );
  }

  return {
    route: "adt-source-html",
    url,
    ...(adtUrl ? { adtUrl } : {}),
    object: resolved.name,
    type: resolved.type,
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}

/** Registers `abap_open_url`. Read-only: never opens a browser, never writes. */
export function registerOpenUrlTools(mcp: McpServer, deps: OpenUrlToolDeps): void {
  mcp.registerTool(
    "abap_open_url",
    {
      title: "Get a browser-openable URL for an ABAP object, keyword, or Web Dynpro app",
      description:
        "Browser-openable URL: ADT source/HTML (object=, type=/line=), keyword doc " +
        "(keyword=), or Web Dynpro URL (webdynpro=). Exactly one required. Does not " +
        "open a browser.",
      inputSchema: openUrlInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const parsed = OpenUrlInput.safeParse(args);
        if (!parsed.success) {
          throw new AbapError(
            "BAD_INPUT",
            parsed.error.issues.map((i) => i.message).join("; "),
            { issues: parsed.error.issues },
          );
        }
        const input = parsed.data;
        if (input.object) {
          await deps.ensureConnected();
        }
        const result = await resolveOpenUrl(input, deps);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
