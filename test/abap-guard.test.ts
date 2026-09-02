/**
 * `bin/abap-guard` — the PreToolUse hook script (plain, dependency-free
 * Node.js, NOT TypeScript; see the file's own header comment). This is a
 * genuine black-box test: the script is spawned as a real OS subprocess,
 * exactly like Claude Code's hook mechanism invokes it, with JSON piped in
 * on stdin and ABAP_MODE set via the child's env. Nothing from the script's
 * internals is imported.
 *
 * Two admin-only ceilings were added to the in-process
 * gate (src/mode.ts / src/safety.ts) that only ABAP_MODE=admin satisfies —
 * abap_bopf_delete with cascade_ddic:true, and abap_transport with
 * operation:"delete". This hook previously had no third tier and wrongly
 * allowed both under ABAP_MODE=edit. The regression cases below lock that
 * fix in; the rest of the file is a broader sanity sweep of the hook's
 * existing allow/deny table so nothing else regressed alongside the fix.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// The in-process gate, imported so the two independent implementations of the
// same ladder can be compared against each other rather than each against its
// own hand-written expectations. Type-only for AbapMode is not enough here.
import {
  capabilitiesForMode,
  type CoarseMutatingOperation,
  isMutatingOperationAllowed,
} from "../src/mode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARD_PATH = path.join(__dirname, "..", "bin", "abap-guard");

type AbapMode = "read" | "edit" | "admin";
type PermissionDecision = "allow" | "deny";

interface GuardVerdict {
  hookSpecificOutput: {
    hookEventName: string;
    permissionDecision: PermissionDecision;
    permissionDecisionReason: string;
  };
}

interface HookPayload {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/** Spawns the real bin/abap-guard script as an OS subprocess, feeds it `payload` on stdin under ABAP_MODE=`mode`, and parses its stdout JSON verdict. */
function runGuard(payload: HookPayload | string, mode: AbapMode | undefined): GuardVerdict {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (mode === undefined) {
    delete env.ABAP_MODE;
  } else {
    env.ABAP_MODE = mode;
  }
  const stdout = execFileSync("node", [GUARD_PATH], { input, encoding: "utf8", env });
  return JSON.parse(stdout) as GuardVerdict;
}

function decisionFor(payload: HookPayload, mode: AbapMode): PermissionDecision {
  return runGuard(payload, mode).hookSpecificOutput.permissionDecision;
}

describe("abap-guard: admin-only ceiling regressions", () => {
  const bopfCascadeDelete: HookPayload = {
    tool_name: "abap_bopf_delete",
    tool_input: {
      bo: "ZTEST_BO",
      cascade_ddic: true,
      confirm: "ZTEST_BO",
      confirm_cascade: "ZTEST_BO",
      dry_run: false,
    },
  };

  const transportDelete: HookPayload = {
    tool_name: "abap_transport",
    tool_input: { operation: "delete", transport: "A4HK900123", confirm: "A4HK900123" },
  };

  it("abap_bopf_delete with cascade_ddic:true is denied under read", () => {
    expect(decisionFor(bopfCascadeDelete, "read")).toBe("deny");
  });

  it("abap_bopf_delete with cascade_ddic:true is denied under edit — this is the regression the guard exists to prevent", () => {
    const verdict = runGuard(bopfCascadeDelete, "edit");
    expect(verdict.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(verdict.hookSpecificOutput.permissionDecisionReason.toLowerCase()).toContain("admin");
  });

  it("abap_bopf_delete with cascade_ddic:true is allowed under admin", () => {
    expect(decisionFor(bopfCascadeDelete, "admin")).toBe("allow");
  });

  it("abap_transport operation:'delete' is denied under read", () => {
    expect(decisionFor(transportDelete, "read")).toBe("deny");
  });

  it("abap_transport operation:'delete' is denied under edit — this is the regression the guard exists to prevent", () => {
    const verdict = runGuard(transportDelete, "edit");
    expect(verdict.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(verdict.hookSpecificOutput.permissionDecisionReason.toLowerCase()).toContain("admin");
  });

  it("abap_transport operation:'delete' is allowed under admin", () => {
    expect(decisionFor(transportDelete, "admin")).toBe("allow");
  });
});

describe("abap-guard: non-ceiling paths for the same two tools are unchanged", () => {
  it("abap_bopf_delete without cascade_ddic stays ordinary-mutating: allow under edit/admin, deny under read", () => {
    const payload: HookPayload = {
      tool_name: "abap_bopf_delete",
      tool_input: { bo: "ZTEST_BO", confirm: "ZTEST_BO" },
    };
    expect(decisionFor(payload, "read")).toBe("deny");
    expect(decisionFor(payload, "edit")).toBe("allow");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_bopf_delete with cascade_ddic:false stays ordinary-mutating: allow under edit/admin, deny under read", () => {
    const payload: HookPayload = {
      tool_name: "abap_bopf_delete",
      tool_input: { bo: "ZTEST_BO", confirm: "ZTEST_BO", cascade_ddic: false },
    };
    expect(decisionFor(payload, "read")).toBe("deny");
    expect(decisionFor(payload, "edit")).toBe("allow");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_transport operation:'list' is a read-only sub-operation: allow under every mode", () => {
    const payload: HookPayload = { tool_name: "abap_transport", tool_input: { operation: "list" } };
    expect(decisionFor(payload, "read")).toBe("allow");
    expect(decisionFor(payload, "edit")).toBe("allow");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_transport operation:'create' stays ordinary-mutating, NOT elevated to admin-only", () => {
    const payload: HookPayload = {
      tool_name: "abap_transport",
      tool_input: { operation: "create", description: "test transport" },
    };
    expect(decisionFor(payload, "read")).toBe("deny");
    expect(decisionFor(payload, "edit")).toBe("allow");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });
});

describe("abap-guard: sanity sweep of previously-passing cases (nothing else broke)", () => {
  it("abap_write is ordinary-mutating: allow under edit/admin, deny under read", () => {
    const payload: HookPayload = {
      tool_name: "abap_write",
      tool_input: { object_type: "PROG", name: "ZTEST_PROG", source: "REPORT ztest_prog." },
    };
    expect(decisionFor(payload, "read")).toBe("deny");
    expect(decisionFor(payload, "edit")).toBe("allow");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_read is always read-only: allow under every mode", () => {
    const payload: HookPayload = { tool_name: "abap_read", tool_input: { object_type: "PROG", name: "ZTEST_PROG" } };
    expect(decisionFor(payload, "read")).toBe("allow");
    expect(decisionFor(payload, "edit")).toBe("allow");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_transport_release stays the pre-existing 2-tier admin-only case: allow only under admin", () => {
    const payload: HookPayload = { tool_name: "abap_transport_release", tool_input: { transport: "A4HK900123" } };
    expect(decisionFor(payload, "read")).toBe("deny");
    expect(decisionFor(payload, "edit")).toBe("deny");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("also works with a fully plugin-scoped tool name", () => {
    const payload: HookPayload = {
      tool_name: "mcp__plugin_abapsmith_abap__abap_bopf_delete",
      tool_input: { bo: "ZTEST_BO", cascade_ddic: true, confirm: "ZTEST_BO" },
    };
    expect(decisionFor(payload, "edit")).toBe("deny");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });
});

describe("abap-guard: v2 6-tool surface", () => {
  it("abap_find is always read-only: allow under every mode", () => {
    const payload: HookPayload = { tool_name: "abap_find", tool_input: { query: "ZCL_FOO" } };
    expect(decisionFor(payload, "read")).toBe("allow");
    expect(decisionFor(payload, "edit")).toBe("allow");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_read (v2 tool, same name as v1's) is always read-only: allow under every mode", () => {
    const payload: HookPayload = { tool_name: "abap_read", tool_input: { object: "ZCL_FOO", view: "source" } };
    expect(decisionFor(payload, "read")).toBe("allow");
    expect(decisionFor(payload, "edit")).toBe("allow");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_write (v2 tool, same name as v1's) is ordinary-mutating: allow under edit/admin, deny under read", () => {
    const payload: HookPayload = { tool_name: "abap_write", tool_input: { object: "ZCL_FOO", source: "..." } };
    expect(decisionFor(payload, "read")).toBe("deny");
    expect(decisionFor(payload, "edit")).toBe("allow");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_write mode:'delete' is still ordinary-mutating (no admin ceiling for a plain object delete)", () => {
    const payload: HookPayload = { tool_name: "abap_write", tool_input: { object: "ZCL_FOO", mode: "delete" } };
    expect(decisionFor(payload, "read")).toBe("deny");
    expect(decisionFor(payload, "edit")).toBe("allow");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_do with no action is a bare self-describing call: allow under every mode (emptyIsRead)", () => {
    const payload: HookPayload = { tool_name: "abap_do", tool_input: {} };
    expect(decisionFor(payload, "read")).toBe("allow");
    expect(decisionFor(payload, "edit")).toBe("allow");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_do action:'check' (activation group, minMode read) is a read-only sub-operation: allow under every mode", () => {
    const payload: HookPayload = { tool_name: "abap_do", tool_input: { action: "check", object: "ZCL_FOO" } };
    expect(decisionFor(payload, "read")).toBe("allow");
    expect(decisionFor(payload, "edit")).toBe("allow");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_do action:'activate' (edit-tier) is denied under read, allowed under edit/admin", () => {
    const payload: HookPayload = { tool_name: "abap_do", tool_input: { action: "activate", object: "ZCL_FOO" } };
    expect(decisionFor(payload, "read")).toBe("deny");
    expect(decisionFor(payload, "edit")).toBe("allow");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_do action:'transport_delete' (admin-tier) is denied under read/edit, allowed under admin only", () => {
    const payload: HookPayload = {
      tool_name: "abap_do",
      tool_input: { action: "transport_delete", object: "A4HK900123", confirm: "A4HK900123" },
    };
    expect(decisionFor(payload, "read")).toBe("deny");
    expect(decisionFor(payload, "edit")).toBe("deny");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_do action:'bopf_delete' (admin-tier) is denied under read/edit, allowed under admin only", () => {
    const payload: HookPayload = { tool_name: "abap_do", tool_input: { action: "bopf_delete", object: "ZTEST_BO" } };
    expect(decisionFor(payload, "read")).toBe("deny");
    expect(decisionFor(payload, "edit")).toBe("deny");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_do with an unrecognized action is treated as mutating (fail closed): denied under read", () => {
    const payload: HookPayload = { tool_name: "abap_do", tool_input: { action: "some_future_action" } };
    expect(decisionFor(payload, "read")).toBe("deny");
    expect(decisionFor(payload, "edit")).toBe("allow");
  });

  it("abap_debug action:'vars' is a read-only sub-operation: allow under every mode (regression: previously missing from the table and wrongly denied under read)", () => {
    const payload: HookPayload = { tool_name: "abap_debug", tool_input: { action: "vars", stateId: "abc" } };
    expect(decisionFor(payload, "read")).toBe("allow");
    expect(decisionFor(payload, "edit")).toBe("allow");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_debug action:'value' is a read-only sub-operation: allow under every mode (same regression as 'vars')", () => {
    const payload: HookPayload = {
      tool_name: "abap_debug",
      tool_input: { action: "value", stateId: "abc", path: "LT_ITEMS[1]" },
    };
    expect(decisionFor(payload, "read")).toBe("allow");
    expect(decisionFor(payload, "edit")).toBe("allow");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_debug action:'start' is still mutating: denied under read, allowed under edit/admin", () => {
    const payload: HookPayload = {
      tool_name: "abap_debug",
      tool_input: { action: "start", run: "ZCL_FOO", breakpoints: ["ZCL_FOO:10"] },
    };
    expect(decisionFor(payload, "read")).toBe("deny");
    expect(decisionFor(payload, "edit")).toBe("allow");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_debug action:'stack'/'status'/'keepalive'/'stop' are still read-only sub-operations: allow under every mode", () => {
    for (const action of ["stack", "status", "keepalive", "stop"]) {
      const payload: HookPayload = { tool_name: "abap_debug", tool_input: { action, stateId: "abc" } };
      expect(decisionFor(payload, "read"), `action=${action} under read`).toBe("allow");
    }
  });

  it("abap_adt with no method defaults to GET (emptyIsRead): allow under every mode", () => {
    const payload: HookPayload = { tool_name: "abap_adt", tool_input: { path: "/sap/bc/adt/discovery" } };
    expect(decisionFor(payload, "read")).toBe("allow");
    expect(decisionFor(payload, "edit")).toBe("allow");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_adt method:'GET'/'get' (case-insensitive) is read-only: allow under every mode", () => {
    const payload: HookPayload = { tool_name: "abap_adt", tool_input: { method: "get", path: "/sap/bc/adt/discovery" } };
    expect(decisionFor(payload, "read")).toBe("allow");
    expect(decisionFor(payload, "edit")).toBe("allow");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_adt method:'POST' is admin-only, full stop — denied under read AND edit, allowed under admin (the real handler then structurally refuses it regardless)", () => {
    const payload: HookPayload = { tool_name: "abap_adt", tool_input: { method: "POST", path: "/sap/bc/adt/discovery" } };
    expect(decisionFor(payload, "read")).toBe("deny");
    expect(decisionFor(payload, "edit")).toBe("deny");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });

  it("abap_adt method:'DELETE' is admin-only, full stop — same as POST", () => {
    const payload: HookPayload = { tool_name: "abap_adt", tool_input: { method: "DELETE", path: "/sap/bc/adt/discovery" } };
    expect(decisionFor(payload, "read")).toBe("deny");
    expect(decisionFor(payload, "edit")).toBe("deny");
    expect(decisionFor(payload, "admin")).toBe("allow");
  });
});

describe("abap-guard: fail-safe and fallback behaviour (nice-to-have coverage)", () => {
  it("malformed (empty) stdin is denied", () => {
    const verdict = runGuard("", "edit");
    expect(verdict.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("non-JSON stdin is denied", () => {
    const verdict = runGuard("not json at all", "edit");
    expect(verdict.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("an unrecognized tool name is denied under read (allowlist policy)", () => {
    const payload: HookPayload = { tool_name: "abap_totally_unknown_tool", tool_input: {} };
    expect(decisionFor(payload, "read")).toBe("deny");
  });

  it("an unrecognized tool name is allowed under edit (defers to the in-process gate)", () => {
    const payload: HookPayload = { tool_name: "abap_totally_unknown_tool", tool_input: {} };
    expect(decisionFor(payload, "edit")).toBe("allow");
  });
});

/**
 * TWO GATES, ONE ANSWER — and the one input on which they deliberately differ.
 *
 * `bin/abap-guard` (this hook) and `src/mode.ts` (the in-process gate) are two
 * independent implementations of the same permission ladder, and they are
 * ALLOWED to differ in the tail direction described in the hook's header
 * (unknown tools pass through to the real gate under edit/admin). What they
 * must never differ about is a tool the hook classifies: if the hook allows a
 * mutating call under a mode the in-process capabilities deny, the operator
 * gets a refusal from the server after the hook told them it was fine — which
 * is precisely how a misattributed refusal becomes a lost run.
 *
 * They DO differ on one input, and it is deliberate on both sides:
 *
 *   - hook, ABAP_MODE unset -> falls closed to `read`, denying everything.
 *   - server, ABAP_MODE unset -> falls back to the legacy ABAP_ALLOW_* flags,
 *     which may well permit the call.
 *
 * Both defaults are right for their own layer (a hook that fails open is
 * worthless; a server that ignored the legacy flags would break every
 * pre-ABAP_MODE deployment). What was wrong was the hook REPORTING that
 * divergence as though `read` had been chosen by the operator: "ABAP_MODE=read
 * only permits read-only operations", naming a mode nobody set. The assertions
 * below pin the honest wording and the divergence note, so the two gates can
 * keep disagreeing without the message lying about why.
 */
describe("abap-guard: agreement with the in-process ABAP_MODE gate", () => {
  /** One mutating call per coarse category the hook classifies. */
  const MUTATING_CALLS: ReadonlyArray<{ payload: HookPayload; op: CoarseMutatingOperation }> = [
    {
      payload: {
        tool_name: "abap_write",
        tool_input: { object_type: "PROG", name: "ZTEST_PROG", source: "REPORT ztest_prog." },
      },
      op: "write",
    },
    { payload: { tool_name: "abap_run", tool_input: { name: "ZTEST_PROG" } }, op: "execute" },
    {
      payload: { tool_name: "abap_activate", tool_input: { mode: "activate", name: "ZTEST_PROG" } },
      op: "activate",
    },
    {
      payload: { tool_name: "abap_transport", tool_input: { operation: "create" } },
      op: "transport",
    },
  ];

  for (const mode of ["read", "edit", "admin"] as const) {
    it(`agrees with capabilitiesForMode("${mode}") on every mutating category`, () => {
      for (const { payload, op } of MUTATING_CALLS) {
        const server = isMutatingOperationAllowed(capabilitiesForMode(mode), op);
        expect(
          decisionFor(payload, mode),
          `${payload.tool_name} (${op}) under ABAP_MODE=${mode}`,
        ).toBe(server ? "allow" : "deny");
      }
    });
  }

  it("agrees on the admin-only ceilings, which edit must not reach through either gate", () => {
    // The capability side of these two is admin-only in src/mode.ts; the hook's
    // third tier has to match it exactly or one of them is wrong.
    expect(capabilitiesForMode("edit").allowTransportDelete).toBe(false);
    expect(capabilitiesForMode("admin").allowTransportDelete).toBe(true);
    const del: HookPayload = {
      tool_name: "abap_transport",
      tool_input: { operation: "delete", transport: "A4HK900123" },
    };
    expect(decisionFor(del, "edit")).toBe("deny");
    expect(decisionFor(del, "admin")).toBe("allow");

    expect(capabilitiesForMode("edit").allowCascadeDelete).toBe(false);
    expect(capabilitiesForMode("admin").allowCascadeDelete).toBe(true);
  });

  it("an explicitly set ABAP_MODE=read is reported as a SETTING, unqualified", () => {
    const payload: HookPayload = {
      tool_name: "abap_write",
      tool_input: { object_type: "PROG", name: "ZTEST_PROG", source: "REPORT ztest_prog." },
    };
    const reason = runGuard(payload, "read").hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("ABAP_MODE=read");
    expect(reason).not.toContain("DEFAULT");
    // No divergence note: with ABAP_MODE set explicitly, both gates honour the
    // same value and there is nothing to warn about.
    expect(reason).not.toContain("do NOT agree");
  });

  it("an UNSET ABAP_MODE is reported as a default, not as a mode the operator chose", () => {
    const payload: HookPayload = {
      tool_name: "abap_enh",
      tool_input: { operation: "delete", name: "ZENH_ORDER" },
    };
    const reason = runGuard(payload, undefined).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toBe(
      "abap-guard: 'abap_enh' is a mutating tool and ABAP_MODE=read (a DEFAULT — ABAP_MODE is " +
        "not set) only permits read-only operations. Set ABAP_MODE=edit or admin to allow this. " +
        "NOTE: this hook and the abapsmith server do NOT agree on what an unset/unrecognised " +
        "ABAP_MODE means. This hook fails closed to read; the server falls back to the legacy " +
        "ABAP_ALLOW_* flags. Setting ABAP_MODE explicitly is the only configuration both honour.",
    );
  });

  it("an UNRECOGNISED ABAP_MODE says so, and still falls closed to read", () => {
    const payload: HookPayload = {
      tool_name: "abap_write",
      tool_input: { object_type: "PROG", name: "ZTEST_PROG", source: "REPORT ztest_prog." },
    };
    const stdout = execFileSync("node", [GUARD_PATH], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, ABAP_MODE: "supervisor" },
    });
    const verdict = JSON.parse(stdout) as GuardVerdict;
    expect(verdict.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason = verdict.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("a DEFAULT");
    expect(reason).toContain("'supervisor' is not a recognised mode");
    expect(reason).toContain("do NOT agree");
  });
});
