/**
 * Mode-locked refusal stubs — the fix for issue #63.
 *
 * With `ABAP_MODE=read` (or a legacy read-only config), the v1 surface used
 * to skip registering every mutating tool outright. A caller asking for
 * `abap_write` then got `MCP error -32602: Tool abap_write not found` —
 * indistinguishable from a typo'd tool name, and with no hint that raising
 * `ABAP_MODE` (or the legacy allow-flag) is the actual fix. This module
 * registers a STUB under the real tool's name instead: it takes no
 * pool/connection/safety dependency at all, so it is structurally incapable
 * of reaching SAP, and its handler always returns the same kind of refusal
 * the real tool would have produced for a mode-governed capability, plus a
 * pointer at what unlocks it. The safety outcome does not change — nothing
 * here is a new way to write; it is a new way to explain why writing is off.
 *
 * `lockedToolsFor` returns `[]` whenever the server is not read-only end to
 * end (`cfg.readOnly !== true`) — a non-read-only server registers the real
 * tools instead, so no stub is ever offered alongside its real counterpart.
 *
 * `abap_data_preview` is deliberately NOT among {@link MODE_LOCKED_TOOLS}:
 * its gate is `allowDataPreview`, an out-of-band flag independent of
 * `ABAP_MODE` (a preview is a read, so no mode ceiling governs it — see
 * `resolveStaticCapabilities`'s doc comment in `src/config.ts`), not a
 * mode-governed capability this module's machinery understands.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AbapError } from "../adt/errors.js";
import type { Config } from "../config.js";
import {
  capabilityGranted,
  explainDeniedCapability,
  explainDeniedCapabilities,
  lowestModeSatisfying,
  type AbapCapabilities,
  type AbapMode,
  type ModeGovernedCapability,
} from "../mode.js";

export interface ModeLockedTool {
  /** The tool name, identical to the one the real registrar uses when unlocked. */
  readonly name: string;
  /** One short sentence: what the tool does when it IS unlocked. */
  readonly summary: string;
  /** Every mode-governed capability the real tool needs. */
  readonly needs: readonly ModeGovernedCapability[];
  /** Extra out-of-band precondition; when absent the stub is always offered on a read-only server. */
  readonly availableWhen?: (cfg: Config) => boolean;
}

/**
 * The v1 tools whose registration is skipped outright when a mode-governed
 * capability is off. Order matches the sequence they'd be registered in by
 * `src/server.ts`'s v1 branch. Names, `needs`, and summaries verified
 * against the real registrars — do not change them without re-verifying.
 */
export const MODE_LOCKED_TOOLS: readonly ModeLockedTool[] = [
  {
    name: "abap_write",
    needs: ["allowWrite"],
    summary: "Create, change or delete an ABAP object: save/check/activate.",
  },
  {
    name: "abap_run",
    needs: ["allowWrite"],
    summary: "Execute an IF_OO_ADT_CLASSRUN class or report and capture its output.",
  },
  {
    name: "abap_test",
    needs: ["allowWrite"],
    summary: "Run ABAP Unit tests and report each method's verdict.",
  },
  {
    name: "abap_atc",
    needs: ["allowWrite"],
    summary: "Run ABAP Test Cockpit static analysis on an object.",
  },
  {
    name: "abap_quick_fix",
    needs: ["allowWrite"],
    summary: "List and apply ADT quick fixes at one source position.",
  },
  {
    name: "abap_ui",
    needs: ["allowWrite"],
    summary: "Drive classic SAP dynpro screens via batch input: read one screen, or run a scripted transaction.",
  },
  {
    name: "abap_fpm_read",
    needs: ["allowWrite"],
    summary: "Read SAP FPM/FBI screen configurations; every call deploys a throwaway bridge class.",
  },
  {
    name: "abap_img_edit",
    needs: ["allowWrite"],
    summary: "Preview and write IMG/customizing table rows.",
  },
  {
    name: "abap_bopf_test",
    needs: ["allowWrite"],
    summary: "Run a BOPF business object end to end, writing real rows.",
  },
  {
    name: "abap_bopf_edit",
    needs: ["allowWrite"],
    summary: "Make one design-time edit to a BOPF business object, or create one.",
  },
  {
    name: "abap_bopf_delete",
    needs: ["allowWrite"],
    summary: "Delete a BOPF business object.",
  },
  {
    name: "abap_transport_release",
    needs: ["allowWrite", "allowTransportRelease"],
    summary: "Release one CTS transport request — irreversible.",
  },
  {
    name: "abap_rap",
    needs: ["allowWrite"],
    summary: "Generate a RAP stack (CDS, BDEF, class, SRVD, SRVB) from a table.",
  },
  {
    name: "abap_fluid",
    needs: ["allowWrite"],
    summary: "Deploy and run small generated ABAP tools inside $ABAPSMITH_FLUID_API.",
    // Mirrors `resolveStaticCapabilities`'s `canUseFluidApi` gate
    // (`cfg.fluidApi && !cfg.readOnly && cfg.abapMode !== "read"`) for the
    // `fluidApi` slice of it: `Config["fluidApi"]` (via `boolishRejectDefaultTrue`
    // in src/config.ts) is always a resolved `boolean`, defaulting to `true`,
    // never `undefined` — so the precondition is a plain truthiness check,
    // not an `undefined` check.
    availableWhen: (cfg) => cfg.fluidApi,
  },
];

/**
 * The stubs to register for this config. `[]` unless the server is
 * read-only end to end (`cfg.readOnly === true`) — a non-read-only server
 * registers the real tools instead, so no stub is ever offered alongside
 * its real counterpart.
 */
export function lockedToolsFor(cfg: Config): readonly ModeLockedTool[] {
  if (cfg.readOnly !== true) return [];
  return MODE_LOCKED_TOOLS.filter((tool) => tool.availableWhen === undefined || tool.availableWhen(cfg));
}

/** The lowest `ABAP_MODE` that would grant every capability `tool` needs, or `undefined` if none does. */
export function lockedToolRequiresMode(tool: ModeLockedTool): AbapMode | undefined {
  return lowestModeSatisfying((caps: AbapCapabilities) =>
    tool.needs.every((c) => capabilityGranted(caps, c)),
  );
}

/**
 * `{cause, remediation}` for why `tool` is locked. Single-capability tools
 * go through `explainDeniedCapability` directly (its fuller
 * `DeniedCapabilityExplanation` already contains exactly these two fields);
 * multi-capability tools (today only `abap_transport_release`) go through
 * `explainDeniedCapabilities`, which composes one combined sentence instead
 * of two concatenated ones.
 */
export function lockedToolExplanation(
  tool: ModeLockedTool,
  abapMode: AbapMode | undefined,
): { readonly cause: string; readonly remediation: string } {
  if (tool.needs.length === 1) {
    const need = tool.needs[0];
    if (need === undefined) {
      // Unreachable (length === 1 guarantees index 0 exists), but keeps this
      // function honest without an unsafe non-null assertion.
      throw new AbapError("INTERNAL_GATE_MISUSE", `${tool.name} declares no capability needs.`, {
        tool: tool.name,
      });
    }
    const { cause, remediation } = explainDeniedCapability(need, abapMode);
    return { cause, remediation };
  }
  return explainDeniedCapabilities(tool.needs, abapMode);
}

/**
 * The refusal `tool`'s stub returns. Composed ONLY from `cause`/`remediation`
 * (both already funnel any legacy-env-var mention through
 * `legacyOverriddenClause`/`legacyUnlockClause` in src/mode.ts) plus fixed
 * wording that names no env var — CRITICAL INVARIANT enforced by
 * test/refusal-attribution.test.ts: never hand-write a sentence naming a
 * mode-governed legacy env var here.
 */
export function lockedToolRefusal(tool: ModeLockedTool, abapMode: AbapMode | undefined): AbapError {
  const { cause, remediation } = lockedToolExplanation(tool, abapMode);
  const message =
    `${tool.name} is registered but locked at this permission level. ${cause} ` +
    "Nothing was sent to the SAP system.";
  return new AbapError(
    "READ_ONLY",
    message,
    {
      tool: tool.name,
      locked: true,
      abapMode: abapMode ?? null,
      requiresMode: lockedToolRequiresMode(tool) ?? null,
      capabilities: [...tool.needs],
    },
    remediation,
  );
}

/** The `description` the stub is registered with — tells the caller what unlocks it, without ever calling SAP. */
export function lockedToolDescription(tool: ModeLockedTool, abapMode: AbapMode | undefined): string {
  const { cause, remediation } = lockedToolExplanation(tool, abapMode);
  return `${tool.summary} LOCKED on this server: ${cause} ${remediation} Calling it returns a refusal and sends nothing to the SAP system.`;
}

export interface LockedToolDeps {
  readonly cfg: Pick<Config, "abapMode">;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly tools: readonly ModeLockedTool[];
}

/**
 * Registers one refusal-only stub per `deps.tools` entry, under the real
 * tool's name. Deliberately no `inputSchema`: verified against the installed
 * SDK, a tool registered without one lists as `EMPTY_OBJECT_JSON_SCHEMA`,
 * skips argument validation entirely, and its handler is invoked with
 * `(extra)` only — so no caller argument can break the stub (there is
 * nothing to validate against, and the handler ignores whatever arrives
 * anyway), and no schema bytes are spent describing parameters for an
 * operation that would be refused regardless of what they contain.
 */
export function registerLockedTools(mcp: McpServer, deps: LockedToolDeps): void {
  for (const tool of deps.tools) {
    mcp.registerTool(
      tool.name,
      {
        description: lockedToolDescription(tool, deps.cfg.abapMode),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => deps.errorResult(lockedToolRefusal(tool, deps.cfg.abapMode)),
    );
  }
}
