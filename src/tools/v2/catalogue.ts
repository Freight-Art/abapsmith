/**
 * `abap_do`'s action catalogue — single source of truth for legal action
 * strings; `schemas.ts` points here instead of hard-coding them.
 *
 * Mode gating is structural: `actionsForMode` filters this array by each
 * entry's `minMode`, so `read` ⊆ `edit` ⊆ `admin` by construction.
 */
import type { AbapMode } from "../../mode.js";

export interface ActionEntry {
  readonly action: string;
  readonly group: string;
  readonly summary: string; // one line, <= 80 chars
  readonly minMode: AbapMode;
  readonly v1: string; // the v1 call this collapses (implemented against this)
  readonly args?: string; // comma-separated arg names carried in `args`
}

export const ABAP_DO_GROUPS = ["activation", "execution", "journal", "transports", "bopf", "enhancements"] as const;

const MODE_RANK: Record<AbapMode, number> = { read: 0, edit: 1, admin: 2 };

export const ABAP_DO_ACTIONS: readonly ActionEntry[] = [
  // activation
  {
    action: "activate",
    group: "activation",
    minMode: "edit",
    v1: 'abap_activate({mode:"activate"})',
    summary: "Activate an object; returns syntax errors on failure.",
    args: "type, source, corr_nr",
  },
  {
    action: "check",
    group: "activation",
    minMode: "read",
    v1: 'abap_activate({mode:"check"})',
    summary: "Syntax-check without activating.",
    // Optional: omitted, checks the version already saved on
    // the server instead of refusing — see src/tools/activate.ts.
    args: "type, source",
  },

  // execution
  {
    action: "run",
    group: "execution",
    minMode: "edit",
    v1: "abap_run()",
    summary:
      "Execute a class (if_oo_adt_classrun) or a report. Executed ABAP runs with the connected " +
      "user's full SAP authorisations and is not constrained by this server's package, name or " +
      "transport allowlists.",
    args: "mode (class|report|auto)",
  },
  {
    action: "test",
    group: "execution",
    minMode: "edit",
    v1: "abap_test()",
    summary: "Run ABAP Unit for an object.",
    args: "type, risk_level (harmless|dangerous|critical)",
  },

  // journal
  {
    action: "journal_list",
    group: "journal",
    minMode: "read",
    v1: 'abap_journal({mode:"list"})',
    summary: "List local write-journal entries.",
    args: "limit",
  },
  {
    action: "journal_show",
    group: "journal",
    minMode: "read",
    v1: 'abap_journal({mode:"show"})',
    summary: "Show one journal entry with its before-image.",
    args: "(none — object is the entry id)",
  },
  {
    action: "undo",
    group: "journal",
    minMode: "edit",
    v1: 'abap_journal({mode:"undo"})',
    summary: "Restore an object from its journal before-image.",
    args: "entry, force, activate",
  },

  // transports
  {
    action: "transport_list",
    group: "transports",
    minMode: "read",
    v1: 'abap_transport({operation:"list"})',
    summary: "List transport requests.",
    args: "(none — object is the user filter)",
  },
  {
    action: "transport_show",
    group: "transports",
    minMode: "read",
    v1: 'abap_transport({operation:"show"})',
    summary: "Show one request with its objects.",
    args: "(none — object is the transport number)",
  },
  {
    action: "transport_check",
    group: "transports",
    minMode: "read",
    v1: 'abap_transport({operation:"check"})',
    summary: "Pre-release consistency check.",
    args: "(none — object is the ABAP object name)",
  },
  {
    action: "transport_users",
    group: "transports",
    minMode: "read",
    v1: 'abap_transport({operation:"users"})',
    summary: "List users on a request.",
    args: "(none — takes no object either)",
  },
  {
    action: "transport_create",
    group: "transports",
    minMode: "edit",
    v1: 'abap_transport({operation:"create"})',
    summary: "Create a request.",
    args: "package, description (object = optional anchor object)",
  },
  {
    action: "transport_add_user",
    group: "transports",
    minMode: "edit",
    v1: 'abap_transport({operation:"addUser"})',
    summary: "Add a user to a request.",
    args: "user (object = transport number)",
  },
  {
    action: "transport_set_owner",
    group: "transports",
    minMode: "edit",
    v1: 'abap_transport({operation:"setOwner"})',
    summary: "Change request owner.",
    args: "user (object = transport number)",
  },
  {
    action: "transport_delete",
    group: "transports",
    minMode: "admin",
    v1: 'abap_transport({operation:"delete"})',
    summary: "Delete a request. Destructive.",
    args: "(none — object = transport number; top-level confirm required)",
  },
  {
    action: "transport_release",
    group: "transports",
    minMode: "admin",
    v1: "abap_transport_release()",
    summary: "Release a request. Irreversible.",
    args: "(none — object = transport number; top-level confirm required, else dry run; confirm_unowned overrides an unowned refusal)",
  },

  // bopf
  {
    action: "bopf_check_refs",
    group: "bopf",
    minMode: "read",
    v1: 'abap_bopf({mode:"check_refs"})',
    summary: "Report dangling references in a BO.",
    args: "(none — object = bo)",
  },
  {
    action: "bopf_create",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"create_bo"})',
    summary: "Create a business object. Non-atomic — see skill.",
    args: "package (required), description, rootNodeName, activate",
  },
  {
    action: "bopf_add_node",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"add_node"})',
    summary: "Add a node.",
    args: "name (new node name), spec, activate, allow_dangling_ref",
  },
  {
    action: "bopf_remove_node",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"remove_node"})',
    summary: "Remove a node.",
    args: "node, nodeId, activate",
  },
  {
    action: "bopf_add_association",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"add_association"})',
    summary: "Add an association.",
    args: "node, name (new association name), spec, activate, allow_dangling_ref",
  },
  {
    action: "bopf_remove_association",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"remove_association"})',
    summary: "Remove an association.",
    args: "node, name, activate",
  },
  {
    action: "bopf_add_action",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"add_action"})',
    summary: "Add an action.",
    args: "node, name, spec, activate, allow_dangling_ref",
  },
  {
    action: "bopf_remove_action",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"remove_action"})',
    summary: "Remove an action.",
    args: "node, name, activate",
  },
  {
    action: "bopf_add_determination",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"add_determination"})',
    summary: "Add a determination.",
    args: "node, name, spec, activate, allow_dangling_ref",
  },
  {
    action: "bopf_remove_determination",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"remove_determination"})',
    summary: "Remove a determination.",
    args: "node, name, activate",
  },
  {
    action: "bopf_add_validation",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"add_validation"})',
    summary: "Add a validation.",
    args: "node, name, spec, activate, allow_dangling_ref",
  },
  {
    action: "bopf_remove_validation",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"remove_validation"})',
    summary: "Remove a validation.",
    args: "node, name, activate",
  },
  {
    action: "bopf_add_query",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"add_query"})',
    summary: "Add a query.",
    args: "node, name, spec, activate",
  },
  {
    action: "bopf_remove_query",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"remove_query"})',
    summary: "Remove a query.",
    args: "node, name, activate",
  },
  {
    action: "bopf_add_alternative_key",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"add_alternative_key"})',
    summary: "Add an alternative key.",
    args: "node, name, spec, i_know_this_may_not_activate (required true), activate",
  },
  {
    action: "bopf_remove_alternative_key",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"remove_alternative_key"})',
    summary: "Remove an alternative key.",
    args: "node, name, activate",
  },
  {
    action: "bopf_set_node_flags",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"set_node_flags"})',
    summary: "Set node flags.",
    args: "node, nodeId, spec, activate",
  },
  {
    action: "bopf_add_representative_node",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"add_representative_node"})',
    summary: "Add a parentless representative node standing in for another BO.",
    args: "name (new node name), spec.representedBo (required), spec.xmlName, activate",
  },
  {
    action: "bopf_remove_representative_node",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"remove_representative_node"})',
    summary: "Remove a representative node.",
    args: "node, nodeId, activate",
  },
  {
    action: "bopf_embed_dependent_object",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"embed_dependent_object"})',
    summary: "Embed a dependent object under a node (a DoComposition association plus a \"<name>.ROOT\" node).",
    args:
      "node (parent), name (new embedding/association name), spec.dependentObject (required), spec.xmlName, " +
      "spec.multiplicity, spec.implementationClassRef, i_know_this_may_not_activate (required true), activate",
  },
  {
    action: "bopf_remove_dependent_object",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"remove_dependent_object"})',
    summary: "Remove an embedded dependent object (its association and \"<name>.ROOT\" node).",
    args: "node (parent), name, activate",
  },
  {
    action: "bopf_activate",
    group: "bopf",
    minMode: "edit",
    v1: 'abap_bopf_edit({operation:"activate"})',
    summary: "Activate a BO's design-time model.",
    args: "(none — object = bo)",
  },
  {
    action: "bopf_test",
    group: "bopf",
    minMode: "edit",
    v1: "abap_bopf_test()",
    summary: "Exercise a BO at runtime with a scenario.",
    args: "scenario (required: nodes[], cleanup)",
  },
  {
    action: "bopf_delete",
    group: "bopf",
    minMode: "admin",
    v1: "abap_bopf_delete()",
    summary: "Delete a BO; cascade DDIC is admin-only.",
    args: "cascade_ddic, confirm_cascade (top-level confirm/dry_run also apply; dry_run defaults true)",
  },

  // enhancements
  {
    action: "enh_write_description",
    group: "enhancements",
    minMode: "edit",
    v1: 'abap_enh({operation:"write_description"})',
    summary: "Write an enhancement object's description.",
    args: "type (required), description (required), affects (required), corr_nr, expect_etag, activate",
  },
  {
    action: "enh_create_spot",
    group: "enhancements",
    minMode: "edit",
    v1: 'abap_enh({operation:"create_spot"})',
    summary: "Create an enhancement spot.",
    args: "spec (package required)",
  },
  {
    action: "enh_add_badi_def",
    group: "enhancements",
    minMode: "edit",
    v1: 'abap_enh({operation:"add_badi_def"})',
    summary: "Add a BAdI definition to a spot.",
    args: "spec (badiName, interfaceName, singleUse, shortText — all required)",
  },
  {
    action: "enh_add_filter_def",
    group: "enhancements",
    minMode: "edit",
    v1: 'abap_enh({operation:"add_filter_def"})',
    summary: "Add a filter definition.",
    args: "spec (badiName, filterName, filterType required; filterText optional)",
  },
  {
    action: "enh_create_impl",
    group: "enhancements",
    minMode: "edit",
    v1: 'abap_enh({operation:"create_impl"})',
    summary: "Create a BAdI implementation.",
    args: "spec (spotName, badiName, implName, implClass, active — all required)",
  },
  {
    action: "enh_set_filter_values",
    group: "enhancements",
    minMode: "edit",
    v1: 'abap_enh({operation:"set_filter_values"})',
    summary: "Set filter values on an implementation.",
    args: "spec (spotName, implName, filterName, filterType, compare, value — all required)",
  },
  {
    action: "enh_exercise",
    group: "enhancements",
    minMode: "edit",
    v1: 'abap_enh({operation:"exercise"})',
    summary: "Exercise a BAdI at runtime.",
    args: "spec (methodName required; filterValue, params optional)",
  },
  {
    action: "enh_discover_hook_anchors",
    group: "enhancements",
    minMode: "read",
    v1: 'abap_enh({operation:"discover_hook_anchors"})',
    summary: "List hook anchors in a target object.",
    args: "spec (hostType, hostName, hostUri — all required)",
  },
  {
    action: "enh_create_hook",
    group: "enhancements",
    minMode: "edit",
    v1: 'abap_enh({operation:"create_hook"})',
    summary: "Create an enhancement hook implementation.",
    args: "spec (hostType/Name/Uri, anchorFullName, anchorFullDescription required; responsible, activate optional), affects (required), description (required)",
  },
];

/** Entries unlocked by `mode` (rank <= `mode`'s), in declaration order — see the subset invariant above. */
export function actionsForMode(mode: AbapMode): readonly ActionEntry[] {
  const rank = MODE_RANK[mode];
  return ABAP_DO_ACTIONS.filter((entry) => MODE_RANK[entry.minMode] <= rank);
}

/** Groups that have at least one action available in `mode`, in `ABAP_DO_GROUPS` order. */
export function groupsForMode(mode: AbapMode): readonly string[] {
  const present = new Set(actionsForMode(mode).map((entry) => entry.group));
  return ABAP_DO_GROUPS.filter((group) => present.has(group));
}

/** Exact, case-sensitive lookup by action name. */
export function findAction(name: string): ActionEntry | undefined {
  return ABAP_DO_ACTIONS.find((entry) => entry.action === name);
}

/** Grouped, one line per action, restricted to what `mode` unlocks. */
export function renderCatalogue(mode: AbapMode): string {
  const groups = groupsForMode(mode);
  const actions = actionsForMode(mode);
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(`${group}:`);
    for (const entry of actions) {
      if (entry.group !== group) continue;
      const args = entry.args ? ` [args: ${entry.args}]` : "";
      lines.push(`  ${entry.action} — ${entry.summary}${args}`);
    }
  }
  return lines.join("\n");
}

export const ABAP_DO_SKILL = "abap:actions";
